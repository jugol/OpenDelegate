#include "helper_protocol.hpp"

#include <fcntl.h>
#include <io.h>
#include <shellapi.h>

#include <charconv>
#include <future>
#include <iostream>
#include <limits>
#include <memory>
#include <string_view>
#include <thread>

#include <winrt/base.h>

namespace opendelegate::windows_computer_use {

namespace {

bool valid_identifier(std::string_view value) {
  if (value.empty() || value.size() > kMaximumIdentifierLength ||
      value.front() == ' ' || value.back() == ' ') {
    return false;
  }
  for (const unsigned char character : value) {
    if (character < 0x20 || character == 0x7f) {
      return false;
    }
  }
  return true;
}

bool valid_pipe_path(std::wstring_view value) {
  constexpr std::wstring_view prefix = LR"(\\.\pipe\OpenDelegate\)";
  if (!value.starts_with(prefix) || value.size() > 512 || value.size() == prefix.size()) {
    return false;
  }
  const auto ascii_alphanumeric = [](wchar_t character) {
    return (character >= L'0' && character <= L'9') ||
           (character >= L'A' && character <= L'Z') ||
           (character >= L'a' && character <= L'z');
  };
  std::size_t segments = 0;
  std::size_t start = prefix.size();
  while (start < value.size()) {
    const std::size_t end = value.find(L'\\', start);
    const std::wstring_view segment =
        value.substr(start, end == std::wstring_view::npos ? value.size() - start
                                                           : end - start);
    if (segment.empty() || segment.size() > 128 ||
        !ascii_alphanumeric(segment.front()) ||
        !ascii_alphanumeric(segment.back())) {
      return false;
    }
    for (const wchar_t character : segment) {
      if (!(ascii_alphanumeric(character) || character == L'.' ||
            character == L'_' || character == L'-')) {
        return false;
      }
    }
    ++segments;
    if (segments > 4 || end == std::wstring_view::npos) {
      break;
    }
    start = end + 1;
  }
  return segments >= 1 && segments <= 4 && value.back() != L'\\';
}

std::uint64_t parse_positive_integer(std::wstring_view value) {
  const std::string narrow_value = utf8(value);
  std::uint64_t parsed = 0;
  const auto [end, error] =
      std::from_chars(narrow_value.data(), narrow_value.data() + narrow_value.size(), parsed);
  if (error != std::errc{} || end != narrow_value.data() + narrow_value.size() || parsed == 0) {
    throw HelperFailure();
  }
  return parsed;
}

int parse_descriptor(std::wstring_view value) {
  const std::uint64_t parsed = parse_positive_integer(value);
  if (parsed > static_cast<std::uint64_t>((std::numeric_limits<int>::max)())) {
    throw HelperFailure();
  }
  return static_cast<int>(parsed);
}

Configuration parse_configuration() {
  int count = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &count);
  if (arguments == nullptr || count < 2 || std::wstring_view(arguments[1]) != L"serve") {
    if (arguments != nullptr) {
      LocalFree(arguments);
    }
    throw HelperFailure();
  }
  Configuration configuration;
  for (int index = 2; index < count; ++index) {
    const std::wstring_view name(arguments[index]);
    if (name == L"--lab-allow-owner-client") {
      configuration.allow_owner_client_for_lab = true;
      continue;
    }
    if (name == L"--lab-fixture-capture") {
      configuration.allow_fixture_capture_for_lab = true;
      continue;
    }
    if (name == L"--lab-known-secret-vector") {
      configuration.require_known_lab_secret = true;
      continue;
    }
    if (index + 1 >= count) {
      LocalFree(arguments);
      throw HelperFailure();
    }
    const std::wstring value(arguments[++index]);
    if (name == L"--pipe") {
      configuration.pipe_path = value;
    } else if (name == L"--parent-process-id") {
      const std::uint64_t parent_process_id = parse_positive_integer(value);
      if (parent_process_id >
          static_cast<std::uint64_t>((std::numeric_limits<DWORD>::max)())) {
        LocalFree(arguments);
        throw HelperFailure();
      }
      configuration.parent_process_id = static_cast<DWORD>(parent_process_id);
    } else if (name == L"--device-id") {
      configuration.device_id = utf8(value);
    } else if (name == L"--helper-instance-id") {
      configuration.helper_instance_id = utf8(value);
    } else if (name == L"--service-epoch") {
      configuration.service_epoch = parse_positive_integer(value);
    } else if (name == L"--session-identity") {
      configuration.session_identity = utf8(value);
    } else if (name == L"--release-version") {
      configuration.release_version = utf8(value);
    } else if (name == L"--capture-mode") {
      configuration.capture_mode = value;
    } else if (name == L"--fixture-window-title") {
      configuration.fixture_window_title = value;
    } else if (name == L"--fixture-result-file") {
      configuration.fixture_result_file = value;
    } else if (name == L"--secret-descriptor") {
      configuration.secret_descriptor = parse_descriptor(value);
    } else {
      LocalFree(arguments);
      throw HelperFailure();
    }
  }
  LocalFree(arguments);

  const bool production_parent_auth =
      !configuration.allow_owner_client_for_lab &&
      configuration.parent_process_id != 0;
  const bool lab_owner_auth =
      configuration.allow_owner_client_for_lab &&
      configuration.parent_process_id == 0;
  if (!valid_pipe_path(configuration.pipe_path) ||
      (!production_parent_auth && !lab_owner_auth) ||
      !valid_identifier(configuration.device_id) ||
      !valid_identifier(configuration.helper_instance_id) ||
      configuration.service_epoch == 0 ||
      !valid_identifier(configuration.session_identity) ||
      !valid_identifier(configuration.release_version) ||
      (configuration.capture_mode != L"picker" &&
       configuration.capture_mode != L"fixture-window") ||
      configuration.secret_descriptor < 3) {
    throw HelperFailure();
  }
  if (configuration.capture_mode == L"fixture-window" &&
      (!configuration.allow_fixture_capture_for_lab ||
       configuration.fixture_window_title.empty() ||
       configuration.fixture_result_file.empty() ||
       !configuration.fixture_result_file.is_absolute())) {
    throw HelperFailure();
  }
  if (configuration.require_known_lab_secret &&
      !configuration.allow_fixture_capture_for_lab) {
    throw HelperFailure();
  }
  return configuration;
}

void release_modifier_keys() noexcept {
  INPUT inputs[8]{};
  const WORD virtual_keys[] = {VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN};
  UINT count = 0;
  for (const WORD virtual_key : virtual_keys) {
    inputs[count].type = INPUT_KEYBOARD;
    inputs[count].ki.wVk = virtual_key;
    inputs[count].ki.dwFlags = KEYEVENTF_KEYUP;
    ++count;
  }
  inputs[count].type = INPUT_MOUSE;
  inputs[count].mi.dwFlags =
      MOUSEEVENTF_LEFTUP | MOUSEEVENTF_RIGHTUP | MOUSEEVENTF_MIDDLEUP;
  ++count;
  SendInput(count, inputs, sizeof(INPUT));
}

void emergency_hotkey_loop(
    std::shared_ptr<WindowsAutomation> automation,
    std::shared_ptr<std::promise<void>> registration_finished) noexcept {
  const bool registered =
      RegisterHotKey(nullptr, 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_PAUSE) != FALSE;
  automation->set_local_emergency_stop_ready(registered);
  try {
    registration_finished->set_value();
  } catch (...) {
  }
  if (!registered) {
    return;
  }
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    if (message.message == WM_HOTKEY && message.wParam == 1) {
      automation->emergency_stop_all();
      release_modifier_keys();
    }
  }
  UnregisterHotKey(nullptr, 1);
  automation->set_local_emergency_stop_ready(false);
}

bool start_parent_process_monitor(DWORD parent_process_id) {
  if (parent_process_id == 0) {
    return false;
  }
  HANDLE parent_process =
      OpenProcess(SYNCHRONIZE, FALSE, parent_process_id);
  if (parent_process == nullptr) {
    return false;
  }
  try {
    std::thread([parent_process]() noexcept {
      const DWORD result = WaitForSingleObject(parent_process, INFINITE);
      CloseHandle(parent_process);
      if (result == WAIT_OBJECT_0) {
        ExitProcess(ERROR_PROCESS_ABORTED);
      }
    }).detach();
    return true;
  } catch (...) {
    CloseHandle(parent_process);
    return false;
  }
}

}  // namespace

void secure_zero(void* pointer, std::size_t length) noexcept {
  if (pointer != nullptr && length > 0) {
    SecureZeroMemory(pointer, length);
  }
}

std::string utf8(std::wstring_view value) {
  if (value.empty()) {
    return {};
  }
  const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                         static_cast<int>(value.size()), nullptr, 0, nullptr,
                                         nullptr);
  if (length <= 0) {
    throw HelperFailure();
  }
  std::string result(static_cast<std::size_t>(length), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(), length, nullptr,
                          nullptr) != length) {
    secure_zero(result.data(), result.size());
    throw HelperFailure();
  }
  return result;
}

std::wstring wide(std::string_view value) {
  if (value.empty()) {
    return {};
  }
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                         static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) {
    throw HelperFailure();
  }
  std::wstring result(static_cast<std::size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(), length) != length) {
    secure_zero(result.data(), result.size() * sizeof(wchar_t));
    throw HelperFailure();
  }
  return result;
}

void require_hresult(HRESULT result) {
  if (FAILED(result)) {
    throw HelperFailure();
  }
}

void require_win32(BOOL result) {
  if (result == FALSE) {
    throw HelperFailure();
  }
}

}  // namespace opendelegate::windows_computer_use

int wmain() {
  using namespace opendelegate::windows_computer_use;
  SecretKey secret{};
  try {
    int command_count = 0;
    LPWSTR* command_arguments = CommandLineToArgvW(GetCommandLineW(), &command_count);
    const bool crypto_self_test =
        command_arguments != nullptr && command_count == 2 &&
        std::wstring_view(command_arguments[1]) == L"crypto-self-test";
    const bool parent_auth_self_test =
        command_arguments != nullptr && command_count == 2 &&
        std::wstring_view(command_arguments[1]) == L"parent-auth-self-test";
    if (command_arguments != nullptr) {
      LocalFree(command_arguments);
    }
    if (crypto_self_test) {
      return run_protocol_crypto_self_test() ? 0 : 70;
    }
    if (parent_auth_self_test) {
      return run_parent_process_auth_self_test() ? 0 : 70;
    }
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    Configuration configuration;
    try {
      configuration = parse_configuration();
    } catch (...) {
      std::cerr << "OpenDelegate Windows Computer Use helper configuration is invalid.\n";
      return 64;
    }
    if (!configuration.allow_owner_client_for_lab &&
        !start_parent_process_monitor(configuration.parent_process_id)) {
      std::cerr << "OpenDelegate Windows Computer Use helper parent binding failed.\n";
      return 64;
    }
    try {
      secret = read_bootstrap_secret(configuration.secret_descriptor);
      if (configuration.require_known_lab_secret) {
        for (std::size_t index = 0; index < secret.size(); ++index) {
          if (secret[index] != static_cast<std::uint8_t>(index + 1)) {
            throw HelperFailure();
          }
        }
      }
    } catch (...) {
      std::cerr << "OpenDelegate Windows Computer Use helper Secret bootstrap failed.\n";
      return 65;
    }
    try {
      auto automation = std::make_shared<WindowsAutomation>(configuration);
      try {
        automation->initialize_capture_target();
      } catch (...) {
        secure_zero(secret.data(), secret.size());
        std::cerr << "OpenDelegate Windows Computer Use capture initialization failed.\n";
        return 66;
      }
      auto registration_finished = std::make_shared<std::promise<void>>();
      std::future<void> registration = registration_finished->get_future();
      std::thread(emergency_hotkey_loop, automation, registration_finished).detach();
      registration.wait();
      int outcome = 0;
      try {
        outcome =
            run_authenticated_named_pipe_server(configuration, secret, automation);
      } catch (...) {
        secure_zero(secret.data(), secret.size());
        std::cerr << "OpenDelegate Windows Computer Use IPC initialization failed.\n";
        return 67;
      }
      secure_zero(secret.data(), secret.size());
      return outcome;
    } catch (...) {
      secure_zero(secret.data(), secret.size());
      std::cerr << "OpenDelegate Windows Computer Use native session initialization failed.\n";
      return 68;
    }
  } catch (...) {
    secure_zero(secret.data(), secret.size());
    std::cerr << "OpenDelegate Windows Computer Use helper failed closed.\n";
    return 70;
  }
}
