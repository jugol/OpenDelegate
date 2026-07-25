#pragma once

#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Graphics.Capture.h>

#include <atomic>
#include <mutex>
#include <string>
#include <unordered_set>

#include "helper_types.hpp"

namespace opendelegate::windows_computer_use {

class WindowsAutomation final {
 public:
  explicit WindowsAutomation(const Configuration& configuration);

  void initialize_capture_target();
  winrt::Windows::Data::Json::JsonObject probe();
  winrt::Windows::Data::Json::JsonObject observe(
      const winrt::Windows::Data::Json::JsonObject& scope);
  winrt::Windows::Data::Json::JsonObject capture(
      const winrt::Windows::Data::Json::JsonObject& scope);
  winrt::Windows::Data::Json::JsonObject act(
      const winrt::Windows::Data::Json::JsonObject& scope,
      const winrt::Windows::Data::Json::JsonObject& action, HANDLE client_pipe);
  void cancel(const winrt::Windows::Data::Json::JsonObject& scope);
  void emergency_stop(const winrt::Windows::Data::Json::JsonObject& scope);
  void emergency_stop_all();
  void set_local_emergency_stop_ready(bool ready) noexcept;

  std::string display_fingerprint();

 private:
  const Configuration& configuration_;
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem capture_item_{nullptr};
  std::mutex input_mutex_;
  std::mutex state_mutex_;
  std::unordered_set<std::string> cancelled_handles_;
  std::unordered_set<std::string> emergency_stopped_handles_;
  std::atomic<std::uint64_t> action_sequence_{0};
  std::atomic<bool> global_emergency_stop_{false};
  std::atomic<bool> local_emergency_stop_ready_{false};

  HWND target_window() const;
  void require_current_scope(const winrt::Windows::Data::Json::JsonObject& scope,
                             bool for_input);
  bool is_cancelled(std::string_view execution_handle);
  bool is_emergency_stopped(std::string_view execution_handle);
};

}  // namespace opendelegate::windows_computer_use
