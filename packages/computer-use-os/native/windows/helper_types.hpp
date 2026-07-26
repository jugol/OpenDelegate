#pragma once

#include <windows.h>

#include <array>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>

namespace opendelegate::windows_computer_use {

constexpr std::uint32_t kProtocolVersion = 1;
constexpr std::size_t kSecretBytes = 32;
constexpr std::size_t kMaximumIdentifierLength = 512;

struct Configuration {
  std::wstring pipe_path;
  std::string device_id;
  std::string helper_instance_id;
  std::uint64_t service_epoch = 0;
  std::string session_identity;
  std::string release_version;
  std::wstring capture_mode;
  std::wstring fixture_window_title;
  std::filesystem::path fixture_result_file;
  int secret_descriptor = -1;
  DWORD parent_process_id = 0;
  bool allow_owner_client_for_lab = false;
  bool allow_fixture_capture_for_lab = false;
  bool require_known_lab_secret = false;
};

class HelperFailure final : public std::runtime_error {
 public:
  HelperFailure() : std::runtime_error("Windows helper failed closed.") {}
};

using SecretKey = std::array<std::uint8_t, kSecretBytes>;

void secure_zero(void* pointer, std::size_t length) noexcept;
std::string utf8(std::wstring_view value);
std::wstring wide(std::string_view value);
void require_hresult(HRESULT result);
void require_win32(BOOL result);
bool parent_process_is_authorized(bool allow_owner_client_for_lab,
                                  DWORD expected_parent_process_id,
                                  DWORD client_process_id);

}  // namespace opendelegate::windows_computer_use
