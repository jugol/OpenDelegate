#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <cstring>
#include <cwchar>
#include <cwctype>
#include <iostream>
#include <string>
#include <vector>

#include "windows-secret-helper.hpp"

namespace {

SERVICE_STATUS_HANDLE service_status_handle = nullptr;
SERVICE_STATUS service_status{};
PROCESS_INFORMATION child_process{};
HANDLE child_job = nullptr;
HANDLE child_stdin_write = INVALID_HANDLE_VALUE;
HANDLE child_stop_event = nullptr;
SRWLOCK child_control_lock = SRWLOCK_INIT;
volatile LONG stop_requested = 0;
std::vector<std::wstring> original_arguments;

void report_status(DWORD state, DWORD exit_code = NO_ERROR, DWORD wait_hint = 0,
                   DWORD service_exit_code = 0) {
  if (service_status_handle == nullptr) {
    return;
  }
  service_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  service_status.dwCurrentState = state;
  service_status.dwWin32ExitCode = exit_code;
  service_status.dwServiceSpecificExitCode = service_exit_code;
  service_status.dwWaitHint = wait_hint;
  service_status.dwControlsAccepted =
      state == SERVICE_RUNNING ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN : 0;
  SetServiceStatus(service_status_handle, &service_status);
}

std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\"";
  unsigned backslashes = 0;
  for (const wchar_t character : value) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'"') {
      result.append(backslashes * 2 + 1, L'\\');
      result.push_back(L'"');
      backslashes = 0;
      continue;
    }
    result.append(backslashes, L'\\');
    backslashes = 0;
    result.push_back(character);
  }
  result.append(backslashes * 2, L'\\');
  result.push_back(L'"');
  return result;
}

bool safe_value(const std::wstring& value,
                std::initializer_list<const wchar_t*> allowed) {
  return std::any_of(allowed.begin(), allowed.end(),
                     [&](const wchar_t* candidate) { return value == candidate; });
}

bool current_login_session_identity(std::wstring& output) {
  DWORD session_id = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &session_id)) {
    return false;
  }
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    return false;
  }
  TOKEN_STATISTICS statistics{};
  DWORD returned = 0;
  const BOOL read = GetTokenInformation(token, TokenStatistics, &statistics,
                                        sizeof(statistics), &returned);
  CloseHandle(token);
  if (!read || returned < sizeof(statistics)) {
    return false;
  }
  output = L"windows:" + std::to_wstring(session_id) + L":logon:" +
           std::to_wstring(static_cast<unsigned long>(statistics.AuthenticationId.HighPart)) +
           L"-" + std::to_wstring(static_cast<unsigned long>(statistics.AuthenticationId.LowPart));
  return true;
}

bool argument_value(const wchar_t* name, std::wstring& output) {
  for (std::size_t index = 1; index + 1 < original_arguments.size(); ++index) {
    if (original_arguments[index] == name) {
      output = original_arguments[index + 1];
      return true;
    }
  }
  return false;
}

bool valid_launcher_arguments() {
  if ((original_arguments.size() - 1) % 2 != 0) {
    return false;
  }
  std::vector<std::wstring> names;
  for (std::size_t index = 1; index + 1 < original_arguments.size(); index += 2) {
    const std::wstring& name = original_arguments[index];
    const std::wstring& value = original_arguments[index + 1];
    if (!safe_value(name, {L"--plane", L"--role", L"--config",
                           L"--stdout-log", L"--stderr-log"}) ||
        value.empty() || std::find(names.begin(), names.end(), name) != names.end()) {
      return false;
    }
    names.push_back(name);
  }
  const auto has = [&](const wchar_t* name) {
    return std::find(names.begin(), names.end(), name) != names.end();
  };
  return has(L"--plane") && has(L"--role") && has(L"--config") &&
         has(L"--stdout-log") == has(L"--stderr-log");
}

bool safe_windows_log_path(const std::wstring& value) {
  return value.size() >= 3 && std::iswalpha(value[0]) && value[1] == L':' &&
         (value[2] == L'\\' || value[2] == L'/');
}

DWORD open_inheritable_log(const std::wstring& path, HANDLE& output) {
  if (!safe_windows_log_path(path)) {
    return ERROR_INVALID_PARAMETER;
  }
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  output = CreateFileW(path.c_str(), FILE_APPEND_DATA | SYNCHRONIZE,
                       FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       &attributes, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  return output == INVALID_HANDLE_VALUE ? GetLastError() : NO_ERROR;
}

DWORD duplicate_inheritable_or_nul(DWORD standard_handle, HANDLE& output) {
  const HANDLE source = GetStdHandle(standard_handle);
  if (source != nullptr && source != INVALID_HANDLE_VALUE &&
      DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &output,
                      0, TRUE, DUPLICATE_SAME_ACCESS)) {
    return NO_ERROR;
  }
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  output = CreateFileW(L"NUL", GENERIC_WRITE,
                       FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes,
                       OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  return output == INVALID_HANDLE_VALUE ? GetLastError() : NO_ERROR;
}

void close_owned_handle(HANDLE& handle) {
  if (handle != nullptr && handle != INVALID_HANDLE_VALUE) {
    CloseHandle(handle);
    handle = INVALID_HANDLE_VALUE;
  }
}

DWORD write_marker(HANDLE handle, const char* marker) {
  const DWORD length = static_cast<DWORD>(std::strlen(marker));
  DWORD written = 0;
  if (!WriteFile(handle, marker, length, &written, nullptr)) {
    return GetLastError();
  }
  return written == length ? NO_ERROR : ERROR_WRITE_FAULT;
}

std::wstring installation_root() {
  std::vector<wchar_t> buffer(32768);
  const DWORD length =
      GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (length == 0 || length >= buffer.size()) {
    return {};
  }
  std::wstring path(buffer.data(), length);
  for (int level = 0; level < 2; ++level) {
    const std::size_t separator = path.find_last_of(L"\\/");
    if (separator == std::wstring::npos || separator == 0) {
      return {};
    }
    path.resize(separator);
  }
  return path;
}

HANDLE take_child_stdin_write() {
  AcquireSRWLockExclusive(&child_control_lock);
  const HANDLE handle = child_stdin_write;
  child_stdin_write = INVALID_HANDLE_VALUE;
  ReleaseSRWLockExclusive(&child_control_lock);
  return handle;
}

void close_child_stdin_write() {
  const HANDLE handle = take_child_stdin_write();
  if (handle != INVALID_HANDLE_VALUE) {
    CloseHandle(handle);
  }
}

void write_stop_signal() {
  const HANDLE handle = take_child_stdin_write();
  if (handle != INVALID_HANDLE_VALUE) {
    const char message[] = "stop\n";
    DWORD written = 0;
    WriteFile(handle, message, sizeof(message) - 1, &written, nullptr);
    CloseHandle(handle);
  }
}

void request_stop() {
  InterlockedExchange(&stop_requested, 1);
  write_stop_signal();
  AcquireSRWLockShared(&child_control_lock);
  if (child_stop_event != nullptr) {
    SetEvent(child_stop_event);
  }
  ReleaseSRWLockShared(&child_control_lock);
}

void close_child_stop_event() {
  AcquireSRWLockExclusive(&child_control_lock);
  const HANDLE handle = child_stop_event;
  child_stop_event = nullptr;
  ReleaseSRWLockExclusive(&child_control_lock);
  if (handle != nullptr) {
    CloseHandle(handle);
  }
}

DWORD create_containment_job() {
  child_job = CreateJobObjectW(nullptr, nullptr);
  if (child_job == nullptr) {
    return GetLastError();
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(child_job, JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) {
    const DWORD error = GetLastError();
    CloseHandle(child_job);
    child_job = nullptr;
    return error;
  }
  return NO_ERROR;
}

void close_containment_job() {
  if (child_job != nullptr) {
    CloseHandle(child_job);
    child_job = nullptr;
  }
}

DWORD self_test_containment() {
  const DWORD job_error = create_containment_job();
  if (job_error != NO_ERROR) {
    return job_error;
  }
  std::vector<wchar_t> executable(32768);
  const DWORD length = GetModuleFileNameW(
      nullptr, executable.data(), static_cast<DWORD>(executable.size()));
  if (length == 0 || length >= executable.size()) {
    const DWORD error = GetLastError();
    close_containment_job();
    return error == NO_ERROR ? ERROR_INSUFFICIENT_BUFFER : error;
  }
  const std::wstring executable_path(executable.data(), length);
  std::wstring command =
      quote(executable_path) + L" --self-test-contained-child";
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION probe{};
  if (!CreateProcessW(executable_path.c_str(), mutable_command.data(), nullptr,
                      nullptr, FALSE, CREATE_NO_WINDOW | CREATE_SUSPENDED,
                      nullptr, nullptr, &startup, &probe)) {
    const DWORD error = GetLastError();
    close_containment_job();
    return error;
  }
  if (!AssignProcessToJobObject(child_job, probe.hProcess)) {
    const DWORD error = GetLastError();
    TerminateProcess(probe.hProcess, error);
    WaitForSingleObject(probe.hProcess, 5000);
    CloseHandle(probe.hThread);
    CloseHandle(probe.hProcess);
    close_containment_job();
    return error;
  }
  if (ResumeThread(probe.hThread) == static_cast<DWORD>(-1)) {
    const DWORD error = GetLastError();
    TerminateJobObject(child_job, error);
    WaitForSingleObject(probe.hProcess, 5000);
    CloseHandle(probe.hThread);
    CloseHandle(probe.hProcess);
    close_containment_job();
    return error;
  }
  CloseHandle(probe.hThread);
  close_containment_job();
  const DWORD wait = WaitForSingleObject(probe.hProcess, 5000);
  DWORD exit_code = STILL_ACTIVE;
  const BOOL inspected = GetExitCodeProcess(probe.hProcess, &exit_code);
  if (wait != WAIT_OBJECT_0) {
    TerminateProcess(probe.hProcess, ERROR_PROCESS_ABORTED);
    WaitForSingleObject(probe.hProcess, 5000);
  }
  CloseHandle(probe.hProcess);
  return wait == WAIT_OBJECT_0 && inspected && exit_code != STILL_ACTIVE
             ? NO_ERROR
             : ERROR_PROCESS_ABORTED;
}

DWORD WINAPI service_control(DWORD control, DWORD, void*, void*) {
  if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
    report_status(SERVICE_STOP_PENDING, NO_ERROR, 40000);
    request_stop();
  }
  return NO_ERROR;
}

int run_child(bool as_service) {
  std::wstring plane;
  std::wstring role;
  std::wstring config;
  if (!valid_launcher_arguments() || !argument_value(L"--plane", plane) ||
      !argument_value(L"--role", role) || !argument_value(L"--config", config) ||
      !safe_value(plane, {L"core", L"session-helper"}) ||
      !safe_value(role, {L"main", L"worker"})) {
    std::wcerr << L"OpenDelegate service launcher requires a valid plane and role.\n";
    return ERROR_INVALID_PARAMETER;
  }

  const DWORD job_error = create_containment_job();
  if (job_error != NO_ERROR) {
    return static_cast<int>(job_error);
  }
  AcquireSRWLockExclusive(&child_control_lock);
  child_stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  const DWORD stop_event_error =
      child_stop_event == nullptr ? GetLastError() : NO_ERROR;
  ReleaseSRWLockExclusive(&child_control_lock);
  if (stop_event_error != NO_ERROR) {
    close_containment_job();
    return static_cast<int>(stop_event_error);
  }

  const std::wstring root = installation_root();
  if (root.empty()) {
    close_child_stop_event();
    close_containment_job();
    return ERROR_PATH_NOT_FOUND;
  }
  const std::wstring node = root + L"\\runtime\\node.exe";
  const std::wstring script =
      root + L"\\apps\\" + role + L"\\" +
      (plane == L"core" ? L"opendelegate-service-host.mjs"
                         : L"opendelegate-session-helper.mjs");
  std::wstring command = quote(node) + L" " + quote(script) +
                         L" --plane " + quote(plane) + L" --role " + quote(role) +
                         L" --config " + quote(config);

  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE child_stdin_read = INVALID_HANDLE_VALUE;
  HANDLE child_stdin_write_local = INVALID_HANDLE_VALUE;
  if (!CreatePipe(&child_stdin_read, &child_stdin_write_local, &attributes, 0) ||
      !SetHandleInformation(child_stdin_write_local, HANDLE_FLAG_INHERIT, 0)) {
    const DWORD error = GetLastError();
    if (child_stdin_read != INVALID_HANDLE_VALUE) {
      CloseHandle(child_stdin_read);
    }
    if (child_stdin_write_local != INVALID_HANDLE_VALUE) {
      CloseHandle(child_stdin_write_local);
    }
    close_child_stop_event();
    close_containment_job();
    return static_cast<int>(error);
  }
  AcquireSRWLockExclusive(&child_control_lock);
  child_stdin_write = child_stdin_write_local;
  ReleaseSRWLockExclusive(&child_control_lock);

  std::wstring session;
  if (current_login_session_identity(session)) {
    SetEnvironmentVariableW(L"OPENDELEGATE_NATIVE_SESSION_ID", session.c_str());
  }
  SetEnvironmentVariableW(L"OPENDELEGATE_NATIVE_SERVICE", L"1");

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = child_stdin_read;
  HANDLE child_stdout = INVALID_HANDLE_VALUE;
  HANDLE child_stderr = INVALID_HANDLE_VALUE;
  std::wstring stdout_path;
  std::wstring stderr_path;
  const bool redirect_logs = argument_value(L"--stdout-log", stdout_path);
  DWORD output_error =
      redirect_logs ? open_inheritable_log(stdout_path, child_stdout)
                    : duplicate_inheritable_or_nul(STD_OUTPUT_HANDLE, child_stdout);
  if (output_error == NO_ERROR) {
    output_error =
        redirect_logs && argument_value(L"--stderr-log", stderr_path)
            ? open_inheritable_log(stderr_path, child_stderr)
            : duplicate_inheritable_or_nul(STD_ERROR_HANDLE, child_stderr);
  }
  if (output_error != NO_ERROR) {
    close_owned_handle(child_stdout);
    close_owned_handle(child_stderr);
    CloseHandle(child_stdin_read);
    close_child_stdin_write();
    close_child_stop_event();
    close_containment_job();
    return static_cast<int>(output_error);
  }
  startup.hStdOutput = child_stdout;
  startup.hStdError = child_stderr;
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  const BOOL created = CreateProcessW(
      node.c_str(), mutable_command.data(), nullptr, nullptr, TRUE,
      CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, nullptr,
      root.c_str(), &startup,
      &child_process);
  CloseHandle(child_stdin_read);
  close_owned_handle(child_stdout);
  close_owned_handle(child_stderr);
  if (!created) {
    const DWORD error = GetLastError();
    close_child_stdin_write();
    close_child_stop_event();
    close_containment_job();
    return static_cast<int>(error);
  }
  if (!AssignProcessToJobObject(child_job, child_process.hProcess)) {
    const DWORD error = GetLastError();
    TerminateProcess(child_process.hProcess, error);
    WaitForSingleObject(child_process.hProcess, 5000);
    CloseHandle(child_process.hThread);
    CloseHandle(child_process.hProcess);
    child_process = {};
    close_child_stdin_write();
    close_child_stop_event();
    close_containment_job();
    return static_cast<int>(error);
  }
  if (ResumeThread(child_process.hThread) == static_cast<DWORD>(-1)) {
    const DWORD error = GetLastError();
    TerminateJobObject(child_job, error);
    WaitForSingleObject(child_process.hProcess, 5000);
    CloseHandle(child_process.hThread);
    CloseHandle(child_process.hProcess);
    child_process = {};
    close_child_stdin_write();
    close_child_stop_event();
    close_containment_job();
    return static_cast<int>(error);
  }
  CloseHandle(child_process.hThread);
  child_process.hThread = nullptr;
  if (as_service) {
    report_status(SERVICE_RUNNING);
  }
  if (InterlockedCompareExchange(&stop_requested, 0, 0) != 0) {
    request_stop();
  }
  const HANDLE wait_handles[] = {child_process.hProcess, child_stop_event};
  const DWORD initial_wait = WaitForMultipleObjects(2, wait_handles, FALSE, INFINITE);
  bool stopped_on_request =
      initial_wait == WAIT_OBJECT_0 + 1 ||
      InterlockedCompareExchange(&stop_requested, 0, 0) != 0;
  DWORD terminal_wait = initial_wait == WAIT_OBJECT_0 ? WAIT_OBJECT_0 : WAIT_TIMEOUT;
  if (stopped_on_request && initial_wait != WAIT_OBJECT_0) {
    write_stop_signal();
    terminal_wait = WaitForSingleObject(child_process.hProcess, 30000);
    if (terminal_wait == WAIT_TIMEOUT) {
      if (child_job != nullptr) {
        TerminateJobObject(child_job, ERROR_PROCESS_ABORTED);
      } else {
        TerminateProcess(child_process.hProcess, ERROR_PROCESS_ABORTED);
      }
      terminal_wait = WaitForSingleObject(child_process.hProcess, 5000);
    }
  }
  DWORD exit_code = ERROR_PROCESS_ABORTED;
  GetExitCodeProcess(child_process.hProcess, &exit_code);
  CloseHandle(child_process.hProcess);
  child_process.hProcess = nullptr;
  close_child_stop_event();
  close_containment_job();
  close_child_stdin_write();
  return stopped_on_request && terminal_wait == WAIT_OBJECT_0
             ? 0
             : static_cast<int>(exit_code);
}

void WINAPI service_main(DWORD argument_count, wchar_t** arguments) {
  InterlockedExchange(&stop_requested, 0);
  const wchar_t* service_name =
      argument_count > 0 && arguments != nullptr && arguments[0] != nullptr
          ? arguments[0]
          : L"";
  service_status_handle =
      RegisterServiceCtrlHandlerExW(service_name, service_control, nullptr);
  if (service_status_handle == nullptr) {
    return;
  }
  report_status(SERVICE_START_PENDING, NO_ERROR, 30000);
  const int result = run_child(true);
  if (result == 0) {
    report_status(SERVICE_STOPPED);
  } else {
    report_status(SERVICE_STOPPED, ERROR_SERVICE_SPECIFIC_ERROR, 0,
                  static_cast<DWORD>(result));
  }
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  original_arguments.assign(argv, argv + argc);
  if (argc == 3 && std::wcscmp(argv[1], L"--secret-helper") == 0) {
    return run_windows_secret_helper(argv[2]);
  }
  if (argc == 2 &&
      std::wcscmp(argv[1], L"--self-test-contained-child") == 0) {
    Sleep(INFINITE);
    return ERROR_PROCESS_ABORTED;
  }
  if (argc == 2 && std::wcscmp(argv[1], L"--self-test") == 0) {
    const DWORD job_error = self_test_containment();
    if (job_error != NO_ERROR) {
      return static_cast<int>(job_error);
    }
    std::wcout << L"OpenDelegate native service launcher 1\n";
    return 0;
  }
  if (argc == 4 &&
      std::wcscmp(argv[1], L"--self-test-log-redirection") == 0) {
    HANDLE stdout_log = INVALID_HANDLE_VALUE;
    HANDLE stderr_log = INVALID_HANDLE_VALUE;
    DWORD error = open_inheritable_log(argv[2], stdout_log);
    if (error == NO_ERROR) {
      error = open_inheritable_log(argv[3], stderr_log);
    }
    if (error == NO_ERROR) {
      error = write_marker(stdout_log, "OpenDelegate native stdout redirection 1\n");
    }
    if (error == NO_ERROR) {
      error = write_marker(stderr_log, "OpenDelegate native stderr redirection 1\n");
    }
    close_owned_handle(stdout_log);
    close_owned_handle(stderr_log);
    return static_cast<int>(error);
  }

  SERVICE_TABLE_ENTRYW table[] = {
      {const_cast<wchar_t*>(L""), service_main},
      {nullptr, nullptr},
  };
  if (StartServiceCtrlDispatcherW(table)) {
    return 0;
  }
  const DWORD error = GetLastError();
  if (error != ERROR_FAILED_SERVICE_CONTROLLER_CONNECT) {
    return static_cast<int>(error);
  }
  InterlockedExchange(&stop_requested, 0);
  SetConsoleCtrlHandler(
      [](DWORD control) -> BOOL {
        if (control == CTRL_C_EVENT || control == CTRL_BREAK_EVENT ||
            control == CTRL_CLOSE_EVENT || control == CTRL_SHUTDOWN_EVENT) {
          request_stop();
          return TRUE;
        }
        return FALSE;
      },
      TRUE);
  return run_child(false);
}
