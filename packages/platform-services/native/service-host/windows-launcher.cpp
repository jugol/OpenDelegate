#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <cwchar>
#include <iostream>
#include <string>
#include <vector>

namespace {

SERVICE_STATUS_HANDLE service_status_handle = nullptr;
SERVICE_STATUS service_status{};
PROCESS_INFORMATION child_process{};
HANDLE child_job = nullptr;
HANDLE child_stdin_write = INVALID_HANDLE_VALUE;
std::vector<std::wstring> original_arguments;

void report_status(DWORD state, DWORD exit_code = NO_ERROR, DWORD wait_hint = 0) {
  if (service_status_handle == nullptr) {
    return;
  }
  service_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  service_status.dwCurrentState = state;
  service_status.dwWin32ExitCode = exit_code;
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

void write_stop_signal() {
  if (child_stdin_write != INVALID_HANDLE_VALUE) {
    const char message[] = "stop\n";
    DWORD written = 0;
    WriteFile(child_stdin_write, message, sizeof(message) - 1, &written, nullptr);
    CloseHandle(child_stdin_write);
    child_stdin_write = INVALID_HANDLE_VALUE;
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

void stop_child() {
  write_stop_signal();
  if (child_process.hProcess == nullptr) {
    return;
  }
  if (WaitForSingleObject(child_process.hProcess, 30000) == WAIT_TIMEOUT) {
    TerminateProcess(child_process.hProcess, ERROR_PROCESS_ABORTED);
    WaitForSingleObject(child_process.hProcess, 5000);
  }
}

DWORD WINAPI service_control(DWORD control, DWORD, void*, void*) {
  if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
    report_status(SERVICE_STOP_PENDING, NO_ERROR, 30000);
    write_stop_signal();
  }
  return NO_ERROR;
}

int run_child(bool as_service) {
  std::wstring plane;
  std::wstring role;
  if (!argument_value(L"--plane", plane) || !argument_value(L"--role", role) ||
      !safe_value(plane, {L"core", L"session-helper"}) ||
      !safe_value(role, {L"main", L"worker"})) {
    std::wcerr << L"OpenDelegate service launcher requires a valid plane and role.\n";
    return ERROR_INVALID_PARAMETER;
  }

  const DWORD job_error = create_containment_job();
  if (job_error != NO_ERROR) {
    return static_cast<int>(job_error);
  }

  const std::wstring root = installation_root();
  if (root.empty()) {
    close_containment_job();
    return ERROR_PATH_NOT_FOUND;
  }
  const std::wstring node = root + L"\\runtime\\node.exe";
  const std::wstring script =
      root + L"\\apps\\" + role + L"\\" +
      (plane == L"core" ? L"opendelegate-service-host.mjs"
                         : L"opendelegate-session-helper.mjs");
  std::wstring command = quote(node) + L" " + quote(script);
  for (std::size_t index = 1; index < original_arguments.size(); ++index) {
    command += L" " + quote(original_arguments[index]);
  }

  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE child_stdin_read = INVALID_HANDLE_VALUE;
  if (!CreatePipe(&child_stdin_read, &child_stdin_write, &attributes, 0) ||
      !SetHandleInformation(child_stdin_write, HANDLE_FLAG_INHERIT, 0)) {
    const DWORD error = GetLastError();
    if (child_stdin_read != INVALID_HANDLE_VALUE) {
      CloseHandle(child_stdin_read);
    }
    if (child_stdin_write != INVALID_HANDLE_VALUE) {
      CloseHandle(child_stdin_write);
      child_stdin_write = INVALID_HANDLE_VALUE;
    }
    close_containment_job();
    return static_cast<int>(error);
  }

  std::wstring session;
  if (current_login_session_identity(session)) {
    SetEnvironmentVariableW(L"OPENDELEGATE_NATIVE_SESSION_ID", session.c_str());
  }
  SetEnvironmentVariableW(L"OPENDELEGATE_NATIVE_SERVICE", L"1");

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = child_stdin_read;
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  const BOOL created = CreateProcessW(
      node.c_str(), mutable_command.data(), nullptr, nullptr, TRUE,
      CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, nullptr,
      root.c_str(), &startup,
      &child_process);
  CloseHandle(child_stdin_read);
  if (!created) {
    const DWORD error = GetLastError();
    CloseHandle(child_stdin_write);
    child_stdin_write = INVALID_HANDLE_VALUE;
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
    CloseHandle(child_stdin_write);
    child_stdin_write = INVALID_HANDLE_VALUE;
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
    CloseHandle(child_stdin_write);
    child_stdin_write = INVALID_HANDLE_VALUE;
    close_containment_job();
    return static_cast<int>(error);
  }
  CloseHandle(child_process.hThread);
  child_process.hThread = nullptr;
  if (as_service) {
    report_status(SERVICE_RUNNING);
  }
  WaitForSingleObject(child_process.hProcess, INFINITE);
  DWORD exit_code = ERROR_PROCESS_ABORTED;
  GetExitCodeProcess(child_process.hProcess, &exit_code);
  CloseHandle(child_process.hProcess);
  child_process.hProcess = nullptr;
  close_containment_job();
  if (child_stdin_write != INVALID_HANDLE_VALUE) {
    CloseHandle(child_stdin_write);
    child_stdin_write = INVALID_HANDLE_VALUE;
  }
  return static_cast<int>(exit_code);
}

void WINAPI service_main(DWORD, wchar_t**) {
  service_status_handle =
      RegisterServiceCtrlHandlerExW(L"", service_control, nullptr);
  if (service_status_handle == nullptr) {
    return;
  }
  report_status(SERVICE_START_PENDING, NO_ERROR, 30000);
  const int result = run_child(true);
  report_status(SERVICE_STOPPED, static_cast<DWORD>(result));
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  original_arguments.assign(argv, argv + argc);
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
  SetConsoleCtrlHandler(
      [](DWORD control) -> BOOL {
        if (control == CTRL_C_EVENT || control == CTRL_BREAK_EVENT ||
            control == CTRL_CLOSE_EVENT || control == CTRL_SHUTDOWN_EVENT) {
          stop_child();
          return TRUE;
        }
        return FALSE;
      },
      TRUE);
  return run_child(false);
}
