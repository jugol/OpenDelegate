#include "helper_protocol.hpp"

#include <bcrypt.h>
#include <sddl.h>
#include <wincrypt.h>

#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <iostream>
#include <memory>
#include <span>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/base.h>

namespace opendelegate::windows_computer_use {

namespace {

using winrt::Windows::Data::Json::JsonObject;
using winrt::Windows::Data::Json::JsonValue;

constexpr std::size_t kNonceBytes = 32;
constexpr std::size_t kMacBytes = 32;
constexpr std::size_t kAuthenticatedHeaderBytes = 14;
constexpr std::size_t kMaximumHandshakeBytes = 16 * 1024;
constexpr std::size_t kMaximumCommandBytes = 2 * 1024 * 1024;
constexpr std::size_t kMaximumResponseBytes = 64 * 1024 * 1024;
constexpr std::size_t kMaximumPipeFrameBytes =
    kMaximumResponseBytes + kAuthenticatedHeaderBytes + kMacBytes;
constexpr char kHelperLabelBytes[] = "OpenDelegate Windows helper IPC v1\0helper\0";
constexpr char kCoreLabelBytes[] = "OpenDelegate Windows helper IPC v1\0core\0";
constexpr char kSessionInfoBytes[] = "OpenDelegate Windows helper IPC v1\0session";
constexpr char kCoreToHelperInfoBytes[] =
    "OpenDelegate Windows helper IPC v1\0core-to-helper";
constexpr char kHelperToCoreInfoBytes[] =
    "OpenDelegate Windows helper IPC v1\0helper-to-core";
constexpr std::string_view kHelperLabel{kHelperLabelBytes, sizeof(kHelperLabelBytes) - 1};
constexpr std::string_view kCoreLabel{kCoreLabelBytes, sizeof(kCoreLabelBytes) - 1};
constexpr std::string_view kSessionInfo{kSessionInfoBytes, sizeof(kSessionInfoBytes) - 1};
constexpr std::string_view kCoreToHelperInfo{kCoreToHelperInfoBytes,
                                             sizeof(kCoreToHelperInfoBytes) - 1};
constexpr std::string_view kHelperToCoreInfo{kHelperToCoreInfoBytes,
                                             sizeof(kHelperToCoreInfoBytes) - 1};

using ByteVector = std::vector<std::uint8_t>;
using Digest = std::array<std::uint8_t, kMacBytes>;

template <typename Container>
class SecureContainerWipe final {
 public:
  explicit SecureContainerWipe(Container& value) : value_(value) {}
  SecureContainerWipe(const SecureContainerWipe&) = delete;
  SecureContainerWipe& operator=(const SecureContainerWipe&) = delete;
  ~SecureContainerWipe() {
    secure_zero(value_.data(), value_.size() * sizeof(typename Container::value_type));
  }

 private:
  Container& value_;
};

std::span<const std::uint8_t> byte_span(std::string_view value) {
  return {reinterpret_cast<const std::uint8_t*>(value.data()), value.size()};
}

struct LocalFreeDeleter {
  void operator()(void* pointer) const noexcept {
    if (pointer != nullptr) {
      LocalFree(pointer);
    }
  }
};

struct SidBytes {
  ByteVector value;
};

struct SecurityContext {
  std::unique_ptr<void, LocalFreeDeleter> descriptor;
  SECURITY_ATTRIBUTES attributes{};
  SidBytes owner_sid;
};

struct ServerContext {
  Configuration configuration;
  SecretKey secret;
  SecurityContext security;
  std::shared_ptr<WindowsAutomation> automation;

  ServerContext(const Configuration& configuration_value,
                const SecretKey& secret_value,
                SecurityContext&& security_value,
                std::shared_ptr<WindowsAutomation> automation_value)
      : configuration(configuration_value),
        secret(secret_value),
        security(std::move(security_value)),
        automation(std::move(automation_value)) {}

  ~ServerContext() { secure_zero(secret.data(), secret.size()); }
};

std::uint32_t read_uint32_be(std::span<const std::uint8_t, 4> bytes) {
  return (static_cast<std::uint32_t>(bytes[0]) << 24) |
         (static_cast<std::uint32_t>(bytes[1]) << 16) |
         (static_cast<std::uint32_t>(bytes[2]) << 8) |
         static_cast<std::uint32_t>(bytes[3]);
}

std::uint64_t read_uint64_be(std::span<const std::uint8_t, 8> bytes) {
  std::uint64_t value = 0;
  for (const std::uint8_t byte : bytes) {
    value = (value << 8) | byte;
  }
  return value;
}

void write_uint32_be(std::uint32_t value, std::span<std::uint8_t, 4> output) {
  output[0] = static_cast<std::uint8_t>((value >> 24) & 0xff);
  output[1] = static_cast<std::uint8_t>((value >> 16) & 0xff);
  output[2] = static_cast<std::uint8_t>((value >> 8) & 0xff);
  output[3] = static_cast<std::uint8_t>(value & 0xff);
}

void write_uint64_be(std::uint64_t value, std::span<std::uint8_t, 8> output) {
  for (int index = 7; index >= 0; --index) {
    output[static_cast<std::size_t>(index)] = static_cast<std::uint8_t>(value & 0xff);
    value >>= 8;
  }
}

void read_exact(HANDLE handle, std::span<std::uint8_t> output) {
  std::size_t offset = 0;
  while (offset < output.size()) {
    DWORD read = 0;
    const DWORD requested = static_cast<DWORD>(
        (std::min)(output.size() - offset,
                   static_cast<std::size_t>((std::numeric_limits<DWORD>::max)())));
    if (ReadFile(handle, output.data() + offset, requested, &read, nullptr) == FALSE ||
        read == 0) {
      throw HelperFailure();
    }
    offset += read;
  }
}

void write_exact(HANDLE handle, std::span<const std::uint8_t> input) {
  std::size_t offset = 0;
  while (offset < input.size()) {
    DWORD written = 0;
    const DWORD requested = static_cast<DWORD>(
        (std::min)(input.size() - offset,
                   static_cast<std::size_t>((std::numeric_limits<DWORD>::max)())));
    if (WriteFile(handle, input.data() + offset, requested, &written, nullptr) == FALSE ||
        written == 0) {
      throw HelperFailure();
    }
    offset += written;
  }
}

ByteVector read_frame(HANDLE pipe, std::size_t maximum) {
  std::array<std::uint8_t, 4> header{};
  read_exact(pipe, header);
  const std::uint32_t length = read_uint32_be(header);
  if (length == 0 || length > maximum) {
    throw HelperFailure();
  }
  ByteVector frame(length);
  read_exact(pipe, frame);
  return frame;
}

void write_frame(HANDLE pipe, std::span<const std::uint8_t> frame) {
  if (frame.empty() || frame.size() > kMaximumPipeFrameBytes ||
      frame.size() > (std::numeric_limits<std::uint32_t>::max)()) {
    throw HelperFailure();
  }
  std::array<std::uint8_t, 4> header{};
  write_uint32_be(static_cast<std::uint32_t>(frame.size()), header);
  write_exact(pipe, header);
  write_exact(pipe, frame);
}

Digest hmac_sha256(std::span<const std::uint8_t> key,
                   std::initializer_list<std::span<const std::uint8_t>> chunks) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_size = 0;
  DWORD returned = 0;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr,
                                  BCRYPT_ALG_HANDLE_HMAC_FLAG) != 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                        reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &returned,
                        0) != 0 ||
      object_size == 0) {
    if (algorithm != nullptr) {
      BCryptCloseAlgorithmProvider(algorithm, 0);
    }
    throw HelperFailure();
  }
  ByteVector object(object_size);
  Digest digest{};
  if (BCryptCreateHash(algorithm, &hash, object.data(), object_size,
                       const_cast<PUCHAR>(key.data()), static_cast<ULONG>(key.size()), 0) != 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
    secure_zero(object.data(), object.size());
    throw HelperFailure();
  }
  bool success = true;
  for (const auto chunk : chunks) {
    if (chunk.size() > (std::numeric_limits<ULONG>::max)() ||
        BCryptHashData(hash, const_cast<PUCHAR>(chunk.data()),
                       static_cast<ULONG>(chunk.size()), 0) != 0) {
      success = false;
      break;
    }
  }
  if (!success ||
      BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) != 0) {
    BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    secure_zero(object.data(), object.size());
    secure_zero(digest.data(), digest.size());
    throw HelperFailure();
  }
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  secure_zero(object.data(), object.size());
  return digest;
}

Digest hkdf_extract(std::span<const std::uint8_t> input,
                    std::span<const std::uint8_t> salt) {
  std::array<std::uint8_t, kMacBytes> zero_salt{};
  const auto effective_salt =
      salt.empty() ? std::span<const std::uint8_t>(zero_salt) : salt;
  Digest output = hmac_sha256(effective_salt, {input});
  secure_zero(zero_salt.data(), zero_salt.size());
  return output;
}

Digest hkdf_expand_one(std::span<const std::uint8_t> key, std::string_view info) {
  const std::uint8_t counter = 1;
  return hmac_sha256(
      key, {byte_span(info), std::span<const std::uint8_t>(&counter, 1)});
}

Digest derive_session_key(const SecretKey& secret,
                          std::span<const std::uint8_t, kNonceBytes> client_nonce,
                          std::span<const std::uint8_t, kNonceBytes> server_nonce) {
  std::array<std::uint8_t, kNonceBytes * 2> salt{};
  std::copy(client_nonce.begin(), client_nonce.end(), salt.begin());
  std::copy(server_nonce.begin(), server_nonce.end(), salt.begin() + kNonceBytes);
  Digest extracted = hkdf_extract(secret, salt);
  Digest session = hkdf_expand_one(extracted, kSessionInfo);
  secure_zero(extracted.data(), extracted.size());
  secure_zero(salt.data(), salt.size());
  return session;
}

Digest derive_direction_key(const Digest& session, std::string_view info) {
  Digest extracted = hkdf_extract(session, {});
  Digest direction = hkdf_expand_one(extracted, info);
  secure_zero(extracted.data(), extracted.size());
  return direction;
}

bool constant_time_equal(std::span<const std::uint8_t> left,
                         std::span<const std::uint8_t> right) {
  if (left.size() != right.size()) {
    return false;
  }
  std::uint8_t difference = 0;
  for (std::size_t index = 0; index < left.size(); ++index) {
    difference |= left[index] ^ right[index];
  }
  return difference == 0;
}

std::string base64_url(std::span<const std::uint8_t> bytes) {
  DWORD length = 0;
  if (!CryptBinaryToStringA(bytes.data(), static_cast<DWORD>(bytes.size()),
                            CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &length) ||
      length == 0) {
    throw HelperFailure();
  }
  std::string value(length, '\0');
  if (!CryptBinaryToStringA(bytes.data(), static_cast<DWORD>(bytes.size()),
                            CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, value.data(), &length)) {
    throw HelperFailure();
  }
  value.resize(strnlen_s(value.data(), value.size()));
  std::replace(value.begin(), value.end(), '+', '-');
  std::replace(value.begin(), value.end(), '/', '_');
  while (!value.empty() && value.back() == '=') {
    value.pop_back();
  }
  return value;
}

ByteVector decode_base64_url(std::string value, std::size_t expected_size) {
  std::replace(value.begin(), value.end(), '-', '+');
  std::replace(value.begin(), value.end(), '_', '/');
  while (value.size() % 4 != 0) {
    value.push_back('=');
  }
  DWORD length = 0;
  if (!CryptStringToBinaryA(value.data(), static_cast<DWORD>(value.size()),
                            CRYPT_STRING_BASE64, nullptr, &length, nullptr, nullptr) ||
      length != expected_size) {
    secure_zero(value.data(), value.size());
    throw HelperFailure();
  }
  ByteVector result(length);
  if (!CryptStringToBinaryA(value.data(), static_cast<DWORD>(value.size()),
                            CRYPT_STRING_BASE64, result.data(), &length, nullptr, nullptr) ||
      length != expected_size) {
    secure_zero(value.data(), value.size());
    secure_zero(result.data(), result.size());
    throw HelperFailure();
  }
  secure_zero(value.data(), value.size());
  return result;
}

JsonObject parse_json(std::span<const std::uint8_t> bytes) {
  if (bytes.empty()) {
    throw HelperFailure();
  }
  return JsonObject::Parse(winrt::to_hstring(
      std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size())));
}

ByteVector serialize_json(const JsonObject& object) {
  const std::string text = winrt::to_string(object.Stringify());
  return ByteVector(text.begin(), text.end());
}

std::string require_string(const JsonObject& object, std::wstring_view name,
                           std::size_t maximum = kMaximumIdentifierLength) {
  if (!object.HasKey(name)) {
    throw HelperFailure();
  }
  const std::string value = winrt::to_string(object.GetNamedString(name));
  if (value.empty() || value.size() > maximum || value.front() == ' ' ||
      value.back() == ' ') {
    throw HelperFailure();
  }
  return value;
}

std::uint64_t require_positive_integer(const JsonObject& object, std::wstring_view name) {
  if (!object.HasKey(name)) {
    throw HelperFailure();
  }
  const double value = object.GetNamedNumber(name);
  if (value <= 0 || value > 9'007'199'254'740'991.0 || value != std::floor(value)) {
    throw HelperFailure();
  }
  return static_cast<std::uint64_t>(value);
}

void require_binding(const JsonObject& command, const Configuration& configuration) {
  if (require_positive_integer(command, L"protocolVersion") != kProtocolVersion ||
      require_string(command, L"expectedHelperInstanceId") !=
          configuration.helper_instance_id ||
      require_positive_integer(command, L"expectedServiceEpoch") !=
          configuration.service_epoch ||
      require_string(command, L"expectedSessionIdentity") !=
          configuration.session_identity ||
      require_string(command, L"expectedReleaseVersion") != configuration.release_version) {
    throw HelperFailure();
  }
}

void require_control_scope(const JsonObject& scope, const Configuration& configuration) {
  require_string(scope, L"executionHandleId");
  require_string(scope, L"taskId");
  if (require_string(scope, L"deviceId") != configuration.device_id) {
    throw HelperFailure();
  }
  require_string(scope, L"runId");
}

void require_execution_scope(const JsonObject& scope,
                             const Configuration& configuration) {
  require_control_scope(scope, configuration);
  if (require_string(scope, L"helperInstanceId") != configuration.helper_instance_id ||
      require_positive_integer(scope, L"serviceEpoch") != configuration.service_epoch) {
    throw HelperFailure();
  }
  require_positive_integer(scope, L"persistenceGeneration");
  require_string(scope, L"leaseId");
  require_positive_integer(scope, L"fencingToken");
  require_string(scope, L"expectedDisplayFingerprint", 256);
}

ByteVector encode_authenticated_frame(std::uint8_t direction, std::uint64_t sequence,
                                      std::span<const std::uint8_t> payload,
                                      const Digest& key) {
  if (payload.size() > kMaximumResponseBytes ||
      payload.size() > (std::numeric_limits<std::uint32_t>::max)()) {
    throw HelperFailure();
  }
  ByteVector frame(kAuthenticatedHeaderBytes + payload.size() + kMacBytes);
  frame[0] = static_cast<std::uint8_t>(kProtocolVersion);
  frame[1] = direction;
  write_uint64_be(sequence,
                  std::span<std::uint8_t, 8>(frame.data() + 2, 8));
  write_uint32_be(static_cast<std::uint32_t>(payload.size()),
                  std::span<std::uint8_t, 4>(frame.data() + 10, 4));
  std::copy(payload.begin(), payload.end(), frame.begin() + kAuthenticatedHeaderBytes);
  const Digest mac = hmac_sha256(
      key, {std::span<const std::uint8_t>(frame.data(),
                                         kAuthenticatedHeaderBytes + payload.size())});
  std::copy(mac.begin(), mac.end(),
            frame.begin() + kAuthenticatedHeaderBytes + payload.size());
  return frame;
}

ByteVector decode_authenticated_frame(std::span<const std::uint8_t> frame,
                                      std::uint8_t expected_direction,
                                      std::uint64_t expected_sequence,
                                      const Digest& key) {
  if (frame.size() < kAuthenticatedHeaderBytes + kMacBytes ||
      frame[0] != kProtocolVersion || frame[1] != expected_direction ||
      read_uint64_be(std::span<const std::uint8_t, 8>(frame.data() + 2, 8)) !=
          expected_sequence) {
    throw HelperFailure();
  }
  const std::uint32_t payload_length =
      read_uint32_be(std::span<const std::uint8_t, 4>(frame.data() + 10, 4));
  if (payload_length > kMaximumCommandBytes ||
      frame.size() != kAuthenticatedHeaderBytes + payload_length + kMacBytes) {
    throw HelperFailure();
  }
  const std::span<const std::uint8_t> unsigned_frame(
      frame.data(), kAuthenticatedHeaderBytes + payload_length);
  Digest expected_mac = hmac_sha256(key, {unsigned_frame});
  const std::span<const std::uint8_t> actual_mac(
      frame.data() + kAuthenticatedHeaderBytes + payload_length, kMacBytes);
  const bool valid = constant_time_equal(expected_mac, actual_mac);
  secure_zero(expected_mac.data(), expected_mac.size());
  if (!valid) {
    throw HelperFailure();
  }
  return ByteVector(frame.begin() + kAuthenticatedHeaderBytes,
                    frame.begin() + kAuthenticatedHeaderBytes + payload_length);
}

SidBytes token_user_sid(HANDLE token) {
  DWORD required = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &required);
  if (required == 0 || required > 64 * 1024) {
    throw HelperFailure();
  }
  ByteVector token_information(required);
  require_win32(
      GetTokenInformation(token, TokenUser, token_information.data(), required, &required));
  const auto* user = reinterpret_cast<const TOKEN_USER*>(token_information.data());
  const DWORD sid_length = GetLengthSid(user->User.Sid);
  SidBytes result{ByteVector(sid_length)};
  require_win32(CopySid(sid_length, result.value.data(), user->User.Sid));
  secure_zero(token_information.data(), token_information.size());
  return result;
}

SidBytes current_user_sid() {
  HANDLE token_raw = nullptr;
  require_win32(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token_raw));
  winrt::handle token(token_raw);
  return token_user_sid(token.get());
}

std::wstring sid_string(const SidBytes& sid) {
  LPWSTR value = nullptr;
  require_win32(ConvertSidToStringSidW(
      const_cast<PSID>(reinterpret_cast<const void*>(sid.value.data())), &value));
  std::unique_ptr<void, LocalFreeDeleter> guard(value);
  return value;
}

SecurityContext create_security_context() {
  SecurityContext context;
  context.owner_sid = current_user_sid();
  const std::wstring sddl =
      L"D:P(A;;GA;;;" + sid_string(context.owner_sid) + L")";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  require_win32(ConvertStringSecurityDescriptorToSecurityDescriptorW(
      sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr));
  context.descriptor.reset(descriptor);
  context.attributes.nLength = sizeof(SECURITY_ATTRIBUTES);
  context.attributes.lpSecurityDescriptor = context.descriptor.get();
  context.attributes.bInheritHandle = FALSE;
  return context;
}

void verify_client_identity(HANDLE pipe, const SecurityContext& security,
                            const Configuration& configuration) {
  ULONG client_process_id = 0;
  require_win32(GetNamedPipeClientProcessId(pipe, &client_process_id));
  if (!parent_process_is_authorized(configuration.allow_owner_client_for_lab,
                                    configuration.parent_process_id,
                                    client_process_id)) {
    throw HelperFailure();
  }
  winrt::handle process(
      OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, client_process_id));
  if (!process) {
    throw HelperFailure();
  }
  HANDLE token_raw = nullptr;
  require_win32(OpenProcessToken(process.get(), TOKEN_QUERY, &token_raw));
  winrt::handle token(token_raw);
  const SidBytes client = token_user_sid(token.get());
  const bool allowed =
      EqualSid(const_cast<PSID>(reinterpret_cast<const void*>(client.value.data())),
               const_cast<PSID>(
                   reinterpret_cast<const void*>(security.owner_sid.value.data()))) != FALSE;
  if (!allowed) {
    throw HelperFailure();
  }
}

void insert_string(JsonObject& object, std::wstring_view name, std::string_view value) {
  object.Insert(name, JsonValue::CreateStringValue(winrt::to_hstring(value)));
}

void merge_object(JsonObject& target, const JsonObject& source) {
  for (const auto& entry : source) {
    target.Insert(entry.Key(), entry.Value());
  }
}

JsonObject dispatch_command(const JsonObject& command, const Configuration& configuration,
                            WindowsAutomation& automation, HANDLE pipe) {
  require_binding(command, configuration);
  const std::string kind = require_string(command, L"kind", 32);
  JsonObject response;
  insert_string(response, L"kind", kind);
  insert_string(response, L"helperInstanceId", configuration.helper_instance_id);
  response.Insert(L"serviceEpoch",
                  JsonValue::CreateNumberValue(static_cast<double>(configuration.service_epoch)));
  insert_string(response, L"sessionIdentity", configuration.session_identity);
  insert_string(response, L"releaseVersion", configuration.release_version);

  if (kind == "probe") {
    insert_string(response, L"displayFingerprint", automation.display_fingerprint());
    merge_object(response, automation.probe());
    return response;
  }
  const JsonObject scope = command.GetNamedObject(L"scope");
  if (kind == "cancel" || kind == "emergency-stop") {
    require_control_scope(scope, configuration);
    if (kind == "cancel") {
      automation.cancel(scope);
    } else {
      automation.emergency_stop(scope);
    }
    response.Insert(L"displayFingerprint", JsonValue::CreateNullValue());
    return response;
  }

  require_execution_scope(scope, configuration);
  insert_string(response, L"displayFingerprint", automation.display_fingerprint());
  if (kind == "observe") {
    response.Insert(L"observation", automation.observe(scope));
  } else if (kind == "capture") {
    response.Insert(L"capture", automation.capture(scope));
  } else if (kind == "act") {
    const JsonObject action = command.GetNamedObject(L"action");
    merge_object(response, automation.act(scope, action, pipe));
  } else {
    throw HelperFailure();
  }
  return response;
}

void handle_client(HANDLE pipe_raw,
                   std::shared_ptr<const ServerContext> context) noexcept {
  winrt::handle pipe(pipe_raw);
  const Configuration& configuration = context->configuration;
  const SecretKey& secret = context->secret;
  const SecurityContext& security = context->security;
  WindowsAutomation& automation = *context->automation;
  Digest session{};
  Digest core_to_helper{};
  Digest helper_to_core{};
  int diagnostic_stage = 0;
  try {
    diagnostic_stage = 1;
    verify_client_identity(pipe.get(), security, configuration);
    diagnostic_stage = 2;
    ByteVector hello_bytes = read_frame(pipe.get(), kMaximumHandshakeBytes);
    SecureContainerWipe hello_bytes_wipe(hello_bytes);
    const JsonObject hello = parse_json(hello_bytes);
    if (require_string(hello, L"type", 32) != "client-hello" ||
        require_positive_integer(hello, L"protocolVersion") != kProtocolVersion ||
        require_string(hello, L"deviceId") != configuration.device_id ||
        require_string(hello, L"helperInstanceId") != configuration.helper_instance_id ||
        require_positive_integer(hello, L"serviceEpoch") != configuration.service_epoch ||
        require_string(hello, L"sessionIdentity") != configuration.session_identity ||
        require_string(hello, L"releaseVersion") != configuration.release_version) {
      throw HelperFailure();
    }
    ByteVector client_nonce_vector =
        decode_base64_url(require_string(hello, L"clientNonce", 64), kNonceBytes);
    SecureContainerWipe client_nonce_vector_wipe(client_nonce_vector);
    std::array<std::uint8_t, kNonceBytes> client_nonce{};
    SecureContainerWipe client_nonce_wipe(client_nonce);
    std::copy(client_nonce_vector.begin(), client_nonce_vector.end(), client_nonce.begin());
    secure_zero(client_nonce_vector.data(), client_nonce_vector.size());
    std::array<std::uint8_t, kNonceBytes> server_nonce{};
    SecureContainerWipe server_nonce_wipe(server_nonce);
    if (configuration.require_known_lab_secret) {
      for (std::size_t index = 0; index < server_nonce.size(); ++index) {
        server_nonce[index] = static_cast<std::uint8_t>(index + 64);
      }
    } else {
      if (BCryptGenRandom(nullptr, server_nonce.data(), static_cast<ULONG>(server_nonce.size()),
                          BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
        throw HelperFailure();
      }
    }
    const std::uint8_t zero = 0;
    Digest helper_proof = hmac_sha256(
        secret,
        {byte_span(kHelperLabel),
         std::span<const std::uint8_t>(hello_bytes.data(), hello_bytes.size()),
         std::span<const std::uint8_t>(&zero, 1), server_nonce});
    SecureContainerWipe helper_proof_wipe(helper_proof);
    JsonObject proof_response;
    insert_string(proof_response, L"type", "helper-proof");
    proof_response.Insert(L"protocolVersion", JsonValue::CreateNumberValue(kProtocolVersion));
    insert_string(proof_response, L"serverNonce", base64_url(server_nonce));
    insert_string(proof_response, L"proof", base64_url(helper_proof));
    ByteVector proof_bytes = serialize_json(proof_response);
    SecureContainerWipe proof_bytes_wipe(proof_bytes);
    std::array<std::uint8_t, 4> proof_header{};
    write_uint32_be(static_cast<std::uint32_t>(proof_bytes.size()), proof_header);
    diagnostic_stage = 31;
    write_exact(pipe.get(), proof_header);
    diagnostic_stage = 32;
    write_exact(pipe.get(), proof_bytes);
    diagnostic_stage = 33;
    secure_zero(proof_bytes.data(), proof_bytes.size());
    secure_zero(helper_proof.data(), helper_proof.size());

    ByteVector core_proof_bytes = read_frame(pipe.get(), kMaximumHandshakeBytes);
    SecureContainerWipe core_proof_bytes_wipe(core_proof_bytes);
    diagnostic_stage = 4;
    const JsonObject core_proof_object = parse_json(core_proof_bytes);
    if (require_string(core_proof_object, L"type", 32) != "core-proof" ||
        require_positive_integer(core_proof_object, L"protocolVersion") !=
            kProtocolVersion) {
      throw HelperFailure();
    }
    ByteVector supplied_core_proof =
        decode_base64_url(require_string(core_proof_object, L"proof", 64), kMacBytes);
    SecureContainerWipe supplied_core_proof_wipe(supplied_core_proof);
    Digest expected_core_proof = hmac_sha256(
        secret,
        {byte_span(kCoreLabel),
         std::span<const std::uint8_t>(hello_bytes.data(), hello_bytes.size()),
         std::span<const std::uint8_t>(&zero, 1), server_nonce});
    SecureContainerWipe expected_core_proof_wipe(expected_core_proof);
    const bool core_authenticated =
        constant_time_equal(supplied_core_proof, expected_core_proof);
    secure_zero(supplied_core_proof.data(), supplied_core_proof.size());
    secure_zero(expected_core_proof.data(), expected_core_proof.size());
    secure_zero(core_proof_bytes.data(), core_proof_bytes.size());
    if (!core_authenticated) {
      throw HelperFailure();
    }

    session = derive_session_key(secret, client_nonce, server_nonce);
    core_to_helper = derive_direction_key(session, kCoreToHelperInfo);
    helper_to_core = derive_direction_key(session, kHelperToCoreInfo);
    secure_zero(client_nonce.data(), client_nonce.size());
    secure_zero(server_nonce.data(), server_nonce.size());
    secure_zero(hello_bytes.data(), hello_bytes.size());

    ByteVector authenticated_command =
        read_frame(pipe.get(), kMaximumCommandBytes + kAuthenticatedHeaderBytes + kMacBytes);
    SecureContainerWipe authenticated_command_wipe(authenticated_command);
    diagnostic_stage = 5;
    ByteVector command_payload =
        decode_authenticated_frame(authenticated_command, 0, 1, core_to_helper);
    SecureContainerWipe command_payload_wipe(command_payload);
    secure_zero(authenticated_command.data(), authenticated_command.size());
    const JsonObject command = parse_json(command_payload);
    diagnostic_stage = 6;
    const JsonObject response =
        dispatch_command(command, configuration, automation, pipe.get());
    secure_zero(command_payload.data(), command_payload.size());
    ByteVector response_payload = serialize_json(response);
    SecureContainerWipe response_payload_wipe(response_payload);
    ByteVector response_frame =
        encode_authenticated_frame(1, 1, response_payload, helper_to_core);
    SecureContainerWipe response_frame_wipe(response_frame);
    diagnostic_stage = 7;
    write_frame(pipe.get(), response_frame);
    // A synchronous WriteFile only transfers bytes into the pipe buffer.
    // Flush before DisconnectNamedPipe so a fast handler teardown cannot
    // discard an unread authenticated response on the client side.
    diagnostic_stage = 8;
    require_win32(FlushFileBuffers(pipe.get()));
    secure_zero(response_payload.data(), response_payload.size());
    secure_zero(response_frame.data(), response_frame.size());
  } catch (...) {
    // Fail closed without sending native, protocol, identifier, or input details.
    if (configuration.allow_owner_client_for_lab) {
      std::cerr << "OpenDelegate Windows helper redacted IPC stage " << diagnostic_stage
                << " failed with Win32 code " << GetLastError() << ".\n";
    }
  }
  secure_zero(session.data(), session.size());
  secure_zero(core_to_helper.data(), core_to_helper.size());
  secure_zero(helper_to_core.data(), helper_to_core.size());
  DisconnectNamedPipe(pipe.get());
}

}  // namespace

SecretKey read_bootstrap_secret(int descriptor) {
  const intptr_t operating_system_handle = _get_osfhandle(descriptor);
  if (operating_system_handle == -1) {
    throw HelperFailure();
  }
  SecretKey secret{};
  try {
    read_exact(reinterpret_cast<HANDLE>(operating_system_handle), secret);
    _close(descriptor);
    return secret;
  } catch (...) {
    secure_zero(secret.data(), secret.size());
    _close(descriptor);
    throw;
  }
}

bool run_protocol_crypto_self_test() {
  SecretKey key{};
  std::array<std::uint8_t, kNonceBytes> nonce{};
  for (std::size_t index = 0; index < key.size(); ++index) {
    key[index] = static_cast<std::uint8_t>(index + 1);
    nonce[index] = static_cast<std::uint8_t>(index + 64);
  }
  constexpr char hello_text[] = "hello";
  const std::uint8_t zero = 0;
  Digest actual = hmac_sha256(
      key,
      {byte_span(kHelperLabel),
       std::span<const std::uint8_t>(
           reinterpret_cast<const std::uint8_t*>(hello_text), sizeof(hello_text) - 1),
       std::span<const std::uint8_t>(&zero, 1), nonce});
  constexpr Digest expected = {
      0x2f, 0xab, 0xa6, 0x4d, 0x7c, 0x43, 0x1d, 0x74, 0xfa, 0x92, 0x54,
      0xb3, 0xad, 0x3a, 0xde, 0x6c, 0x0a, 0x04, 0x90, 0x83, 0x03, 0x78,
      0xb8, 0x24, 0x7b, 0xca, 0x07, 0xe2, 0xf8, 0xe2, 0xc1, 0xc8,
  };
  const bool matches = constant_time_equal(actual, expected);
  secure_zero(actual.data(), actual.size());
  secure_zero(key.data(), key.size());
  secure_zero(nonce.data(), nonce.size());
  return matches;
}

bool parent_process_is_authorized(bool allow_owner_client_for_lab,
                                  DWORD expected_parent_process_id,
                                  DWORD client_process_id) {
  return allow_owner_client_for_lab ||
         (expected_parent_process_id != 0 &&
          client_process_id == expected_parent_process_id);
}

bool run_parent_process_auth_self_test() {
  return parent_process_is_authorized(false, 41, 41) &&
         !parent_process_is_authorized(false, 41, 42) &&
         !parent_process_is_authorized(false, 0, 41) &&
         parent_process_is_authorized(true, 0, 42);
}

int run_authenticated_named_pipe_server(const Configuration& configuration,
                                        SecretKey& secret,
                                        std::shared_ptr<WindowsAutomation> automation) {
  SecurityContext security = create_security_context();
  auto context = std::make_shared<ServerContext>(
      configuration, secret, std::move(security), std::move(automation));
  secure_zero(secret.data(), secret.size());
  bool first_instance = true;
  for (;;) {
    const DWORD open_mode =
        PIPE_ACCESS_DUPLEX | (first_instance ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0);
    HANDLE pipe = CreateNamedPipeW(
        context->configuration.pipe_path.c_str(), open_mode,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_UNLIMITED_INSTANCES, 64 * 1024, 64 * 1024, 0,
        &context->security.attributes);
    first_instance = false;
    if (pipe == INVALID_HANDLE_VALUE) {
      throw HelperFailure();
    }
    const BOOL connected =
        ConnectNamedPipe(pipe, nullptr) != FALSE || GetLastError() == ERROR_PIPE_CONNECTED;
    if (!connected) {
      CloseHandle(pipe);
      throw HelperFailure();
    }
    std::thread(handle_client, pipe, context).detach();
  }
}

}  // namespace opendelegate::windows_computer_use
