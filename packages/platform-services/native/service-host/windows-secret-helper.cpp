#define WIN32_LEAN_AND_MEAN
#define SECURITY_WIN32
#include <windows.h>
#include <aclapi.h>
#include <ncrypt.h>
#include <sspi.h>
#include <ncryptprotect.h>
#include <sddl.h>

#include <algorithm>
#include <climits>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "windows-secret-helper.hpp"

namespace {

constexpr std::size_t kMaximumInputBytes = 2 * 1024 * 1024;
constexpr std::size_t kBindingBytes = 32;
constexpr int kIdentityError = 41;
constexpr int kProtectError = 42;
constexpr int kUnprotectError = 43;
constexpr int kAclError = 44;

class local_allocation {
 public:
  explicit local_allocation(void* value = nullptr) : value_(value) {}
  ~local_allocation() {
    if (value_ != nullptr) {
      LocalFree(value_);
    }
  }
  local_allocation(const local_allocation&) = delete;
  local_allocation& operator=(const local_allocation&) = delete;
  void* get() const { return value_; }
  void reset(void* value = nullptr) {
    if (value_ != nullptr) {
      LocalFree(value_);
    }
    value_ = value;
  }

 private:
  void* value_;
};

class token_handle {
 public:
  token_handle() = default;
  ~token_handle() {
    if (value_ != nullptr) {
      CloseHandle(value_);
    }
  }
  token_handle(const token_handle&) = delete;
  token_handle& operator=(const token_handle&) = delete;
  HANDLE get() const { return value_; }
  HANDLE* receive() { return &value_; }

 private:
  HANDLE value_ = nullptr;
};

bool read_stdin(std::vector<unsigned char>& output) {
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (input == nullptr || input == INVALID_HANDLE_VALUE) {
    return false;
  }
  std::vector<unsigned char> chunk(16 * 1024);
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(input, chunk.data(), static_cast<DWORD>(chunk.size()), &read,
                  nullptr)) {
      return GetLastError() == ERROR_BROKEN_PIPE;
    }
    if (read == 0) {
      return true;
    }
    if (output.size() + read > kMaximumInputBytes) {
      return false;
    }
    output.insert(output.end(), chunk.begin(), chunk.begin() + read);
  }
}

bool write_stdout(const unsigned char* bytes, std::size_t length) {
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (output == nullptr || output == INVALID_HANDLE_VALUE) {
    return false;
  }
  std::size_t offset = 0;
  while (offset < length) {
    const DWORD request = static_cast<DWORD>(
        std::min<std::size_t>(length - offset, MAXDWORD));
    DWORD written = 0;
    if (!WriteFile(output, bytes + offset, request, &written, nullptr) ||
        written == 0) {
      return false;
    }
    offset += written;
  }
  return true;
}

bool utf8_to_wide(const unsigned char* bytes, std::size_t length,
                  std::wstring& output) {
  if (length == 0 || length > static_cast<std::size_t>(INT_MAX)) {
    return false;
  }
  const int required = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<const char*>(bytes),
      static_cast<int>(length), nullptr, 0);
  if (required <= 0) {
    return false;
  }
  output.resize(static_cast<std::size_t>(required));
  return MultiByteToWideChar(
             CP_UTF8, MB_ERR_INVALID_CHARS,
             reinterpret_cast<const char*>(bytes), static_cast<int>(length),
             output.data(), required) == required &&
         output.find(L'\0') == std::wstring::npos;
}

bool current_user_sid(std::vector<unsigned char>& token_information,
                      PSID& sid) {
  token_handle token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, token.receive())) {
    return false;
  }
  DWORD required = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &required);
  if (required == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    return false;
  }
  token_information.resize(required);
  if (!GetTokenInformation(token.get(), TokenUser,
                           token_information.data(), required, &required)) {
    return false;
  }
  sid = reinterpret_cast<TOKEN_USER*>(token_information.data())->User.Sid;
  return IsValidSid(sid) != FALSE;
}

bool parse_sid(const std::wstring& text, local_allocation& allocation,
               PSID& sid) {
  PSID parsed = nullptr;
  if (!ConvertStringSidToSidW(text.c_str(), &parsed) ||
      IsValidSid(parsed) == FALSE) {
    if (parsed != nullptr) {
      LocalFree(parsed);
    }
    return false;
  }
  allocation.reset(parsed);
  sid = parsed;
  return true;
}

int run_identity_probe(const std::vector<unsigned char>& input) {
  std::wstring expected_text;
  local_allocation expected_allocation;
  PSID expected = nullptr;
  std::vector<unsigned char> current_information;
  PSID current = nullptr;
  if (!utf8_to_wide(input.data(), input.size(), expected_text) ||
      !parse_sid(expected_text, expected_allocation, expected) ||
      !current_user_sid(current_information, current) ||
      !EqualSid(expected, current)) {
    return kIdentityError;
  }
  constexpr unsigned char ready[] = {'r', 'e', 'a', 'd', 'y'};
  return write_stdout(ready, sizeof(ready)) ? 0 : kIdentityError;
}

bool parse_sid_prefixed_input(const std::vector<unsigned char>& input,
                              std::wstring& sid_text,
                              std::size_t& payload_offset) {
  if (input.size() <= 2) {
    return false;
  }
  const std::size_t sid_length =
      static_cast<std::size_t>(input[0]) |
      (static_cast<std::size_t>(input[1]) << 8U);
  payload_offset = 2 + sid_length;
  return sid_length > 0 && payload_offset < input.size() &&
         utf8_to_wide(input.data() + 2, sid_length, sid_text);
}

bool allowed_sid(PSID candidate, PSID first, PSID second) {
  return EqualSid(candidate, first) || EqualSid(candidate, second);
}

bool verify_directory_acl(const std::wstring& path, PSID current,
                          PSID service) {
  PSID owner = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD status = GetNamedSecurityInfoW(
      const_cast<wchar_t*>(path.c_str()), SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr,
      &dacl, nullptr, &descriptor);
  local_allocation descriptor_allocation(descriptor);
  if (status != ERROR_SUCCESS || owner == nullptr || dacl == nullptr ||
      !EqualSid(owner, current)) {
    return false;
  }
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision) ||
      (control & SE_DACL_PROTECTED) == 0) {
    return false;
  }
  ACL_SIZE_INFORMATION information{};
  if (!GetAclInformation(dacl, &information, sizeof(information),
                         AclSizeInformation)) {
    return false;
  }
  bool current_seen = false;
  bool service_seen = false;
  for (DWORD index = 0; index < information.AceCount; ++index) {
    void* raw_ace = nullptr;
    if (!GetAce(dacl, index, &raw_ace)) {
      return false;
    }
    const auto* header = static_cast<ACE_HEADER*>(raw_ace);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) {
      return false;
    }
    const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw_ace);
    PSID sid = const_cast<DWORD*>(&ace->SidStart);
    if (!allowed_sid(sid, current, service)) {
      return false;
    }
    if (EqualSid(sid, current)) {
      current_seen = true;
    }
    if (EqualSid(sid, service)) {
      service_seen = true;
    }
  }
  return current_seen && service_seen;
}

int run_acl(const std::vector<unsigned char>& input) {
  std::wstring service_text;
  std::size_t path_offset = 0;
  if (!parse_sid_prefixed_input(input, service_text, path_offset)) {
    return kAclError;
  }
  std::wstring path;
  local_allocation service_allocation;
  PSID service = nullptr;
  std::vector<unsigned char> current_information;
  PSID current = nullptr;
  if (!utf8_to_wide(input.data() + path_offset, input.size() - path_offset,
                    path) ||
      !parse_sid(service_text, service_allocation, service) ||
      !current_user_sid(current_information, current)) {
    return kAclError;
  }
  EXPLICIT_ACCESSW entries[2]{};
  const ULONG entry_count = EqualSid(current, service) ? 1UL : 2UL;
  for (ULONG index = 0; index < entry_count; ++index) {
    entries[index].grfAccessPermissions = GENERIC_ALL;
    entries[index].grfAccessMode = SET_ACCESS;
    entries[index].grfInheritance =
        SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    entries[index].Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entries[index].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    entries[index].Trustee.ptstrName = static_cast<LPWSTR>(
        index == 0 ? current : service);
  }
  PACL dacl = nullptr;
  if (SetEntriesInAclW(entry_count, entries, nullptr, &dacl) !=
      ERROR_SUCCESS) {
    return kAclError;
  }
  local_allocation dacl_allocation(dacl);
  const DWORD status = SetNamedSecurityInfoW(
      path.data(), SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION |
          PROTECTED_DACL_SECURITY_INFORMATION,
      current, nullptr, dacl, nullptr);
  return status == ERROR_SUCCESS &&
                 verify_directory_acl(path, current, service)
             ? 0
             : kAclError;
}

SECURITY_STATUS protect_with_descriptor(const std::wstring& policy,
                                        const unsigned char* bytes,
                                        DWORD length,
                                        unsigned char** output,
                                        ULONG* output_length) {
  NCRYPT_DESCRIPTOR_HANDLE descriptor = nullptr;
  SECURITY_STATUS status = NCryptCreateProtectionDescriptor(
      policy.c_str(), 0, &descriptor);
  if (status != ERROR_SUCCESS) {
    return status;
  }
  status = NCryptProtectSecret(
      descriptor, NCRYPT_SILENT_FLAG, const_cast<PBYTE>(bytes), length,
      nullptr, nullptr, output, output_length);
  NCryptCloseProtectionDescriptor(descriptor);
  return status;
}

int run_protect(const std::vector<unsigned char>& input) {
  std::wstring sid_text;
  std::size_t payload_offset = 0;
  if (!parse_sid_prefixed_input(input, sid_text, payload_offset) ||
      input.size() - payload_offset <= kBindingBytes ||
      input.size() - payload_offset > MAXDWORD) {
    return kProtectError;
  }
  local_allocation sid_allocation;
  PSID sid = nullptr;
  if (!parse_sid(sid_text, sid_allocation, sid)) {
    return kProtectError;
  }
  PBYTE sealed = nullptr;
  ULONG sealed_length = 0;
  unsigned char mode = 1;
  SECURITY_STATUS status = protect_with_descriptor(
      L"SID=" + sid_text, input.data() + payload_offset,
      static_cast<DWORD>(input.size() - payload_offset), &sealed,
      &sealed_length);
  if (status != ERROR_SUCCESS) {
    if (sealed != nullptr) {
      if (sealed_length > 0) {
        SecureZeroMemory(sealed, sealed_length);
      }
      LocalFree(sealed);
      sealed = nullptr;
      sealed_length = 0;
    }
    mode = 2;
    status = protect_with_descriptor(
        L"LOCAL=machine", input.data() + payload_offset,
        static_cast<DWORD>(input.size() - payload_offset), &sealed,
        &sealed_length);
  }
  if (status != ERROR_SUCCESS || sealed == nullptr || sealed_length == 0) {
    if (sealed != nullptr) {
      if (sealed_length > 0) {
        SecureZeroMemory(sealed, sealed_length);
      }
      LocalFree(sealed);
    }
    return kProtectError;
  }
  const bool written =
      write_stdout(&mode, 1) &&
      write_stdout(sealed, static_cast<std::size_t>(sealed_length));
  SecureZeroMemory(sealed, sealed_length);
  LocalFree(sealed);
  return written ? 0 : kProtectError;
}

int run_unprotect(const std::vector<unsigned char>& input) {
  if (input.size() <= kBindingBytes ||
      input.size() - kBindingBytes > MAXDWORD) {
    return kUnprotectError;
  }
  NCRYPT_DESCRIPTOR_HANDLE descriptor = nullptr;
  PBYTE opened = nullptr;
  ULONG opened_length = 0;
  const SECURITY_STATUS status = NCryptUnprotectSecret(
      &descriptor, NCRYPT_SILENT_FLAG,
      const_cast<PBYTE>(input.data() + kBindingBytes),
      static_cast<DWORD>(input.size() - kBindingBytes), nullptr, nullptr,
      &opened, &opened_length);
  if (descriptor != nullptr) {
    NCryptCloseProtectionDescriptor(descriptor);
  }
  if (status != ERROR_SUCCESS || opened == nullptr ||
      opened_length <= kBindingBytes ||
      std::memcmp(opened, input.data(), kBindingBytes) != 0) {
    if (opened != nullptr) {
      if (opened_length > 0) {
        SecureZeroMemory(opened, opened_length);
      }
      LocalFree(opened);
    }
    return kUnprotectError;
  }
  const bool written = write_stdout(
      opened + kBindingBytes,
      static_cast<std::size_t>(opened_length) - kBindingBytes);
  SecureZeroMemory(opened, opened_length);
  LocalFree(opened);
  return written ? 0 : kUnprotectError;
}

}  // namespace

int run_windows_secret_helper(const std::wstring& operation) {
  std::vector<unsigned char> input;
  if (!read_stdin(input)) {
    return ERROR_READ_FAULT;
  }
  int result = ERROR_INVALID_PARAMETER;
  if (operation == L"identity-probe") {
    result = run_identity_probe(input);
  } else if (operation == L"acl") {
    result = run_acl(input);
  } else if (operation == L"protect") {
    result = run_protect(input);
  } else if (operation == L"unprotect") {
    result = run_unprotect(input);
  }
  if (!input.empty()) {
    SecureZeroMemory(input.data(), input.size());
  }
  return result;
}
