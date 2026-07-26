#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>

#include <algorithm>
#include <array>
#include <cwctype>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

namespace {

constexpr wchar_t kWindowClass[] = L"OpenDelegateComputerUseFixture";
constexpr int kTaskTextId = 1001;
constexpr int kOptionAlphaId = 1002;
constexpr int kOptionBetaId = 1003;
constexpr int kSubmitId = 1004;
constexpr int kStatusId = 1005;
constexpr int kResultPathId = 1006;

struct FixtureState {
  std::wstring run_id;
  std::filesystem::path result_file;
};

FixtureState* fixture_state(HWND window) {
  return reinterpret_cast<FixtureState*>(GetWindowLongPtrW(window, GWLP_USERDATA));
}

std::wstring read_control_text(HWND control) {
  const int length = GetWindowTextLengthW(control);
  if (length < 0 || length > 1'000'000) {
    return {};
  }
  std::wstring value(static_cast<std::size_t>(length) + 1, L'\0');
  if (length > 0) {
    const int copied = GetWindowTextW(control, value.data(), length + 1);
    if (copied != length) {
      return {};
    }
  }
  value.resize(static_cast<std::size_t>(length));
  return value;
}

std::string utf8(std::wstring_view value) {
  if (value.empty()) {
    return {};
  }
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                       static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) {
    return {};
  }
  std::string result(static_cast<std::size_t>(size), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(), size, nullptr,
                          nullptr) != size) {
    return {};
  }
  return result;
}

std::string json_escape(std::string_view value) {
  static constexpr char hex[] = "0123456789abcdef";
  std::string result;
  result.reserve(value.size() + 16);
  for (const unsigned char character : value) {
    switch (character) {
      case '"':
        result += "\\\"";
        break;
      case '\\':
        result += "\\\\";
        break;
      case '\b':
        result += "\\b";
        break;
      case '\f':
        result += "\\f";
        break;
      case '\n':
        result += "\\n";
        break;
      case '\r':
        result += "\\r";
        break;
      case '\t':
        result += "\\t";
        break;
      default:
        if (character < 0x20) {
          result += "\\u00";
          result.push_back(hex[(character >> 4) & 0x0f]);
          result.push_back(hex[character & 0x0f]);
        } else {
          result.push_back(static_cast<char>(character));
        }
    }
  }
  return result;
}

bool write_result_file(const FixtureState& state, std::wstring_view text,
                       std::wstring_view option) {
  const std::string body =
      "{\"schemaVersion\":1,\"runIdentifier\":\"" + json_escape(utf8(state.run_id)) +
      "\",\"textValue\":\"" + json_escape(utf8(text)) + "\",\"selectedOption\":\"" +
      json_escape(utf8(option)) + "\",\"state\":\"success\"}\n";
  std::filesystem::path temporary = state.result_file;
  temporary += L".tmp-" + std::to_wstring(GetCurrentProcessId());
  HANDLE file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    return false;
  }
  DWORD written = 0;
  const bool success =
      WriteFile(file, body.data(), static_cast<DWORD>(body.size()), &written, nullptr) != FALSE &&
      written == body.size() && FlushFileBuffers(file) != FALSE;
  CloseHandle(file);
  if (!success ||
      MoveFileExW(temporary.c_str(), state.result_file.c_str(),
                  MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) == FALSE) {
    DeleteFileW(temporary.c_str());
    return false;
  }
  return true;
}

void complete_fixture(HWND window) {
  FixtureState* state = fixture_state(window);
  if (state == nullptr) {
    return;
  }
  const HWND task_text = GetDlgItem(window, kTaskTextId);
  const HWND alpha = GetDlgItem(window, kOptionAlphaId);
  const HWND beta = GetDlgItem(window, kOptionBetaId);
  const HWND status = GetDlgItem(window, kStatusId);
  const std::wstring text = read_control_text(task_text);
  const bool alpha_selected = SendMessageW(alpha, BM_GETCHECK, 0, 0) == BST_CHECKED;
  const bool beta_selected = SendMessageW(beta, BM_GETCHECK, 0, 0) == BST_CHECKED;
  if (text.empty() || (!alpha_selected && !beta_selected)) {
    SetWindowTextW(status, L"Editing — enter text and select Alpha or Beta");
    return;
  }
  const std::wstring_view selected = beta_selected ? L"Beta" : L"Alpha";
  SetWindowTextW(status,
                 write_result_file(*state, text, selected) ? L"Success" : L"Result write failed");
}

HWND create_control(HWND parent, const wchar_t* class_name, const wchar_t* text, DWORD style,
                    int x, int y, int width, int height, int id) {
  return CreateWindowExW(0, class_name, text, WS_CHILD | WS_VISIBLE | style, x, y, width, height,
                         parent, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
                         GetModuleHandleW(nullptr), nullptr);
}

LRESULT CALLBACK fixture_window_proc(HWND window, UINT message, WPARAM w_param, LPARAM l_param) {
  switch (message) {
    case WM_NCCREATE: {
      const auto* create = reinterpret_cast<const CREATESTRUCTW*>(l_param);
      SetWindowLongPtrW(window, GWLP_USERDATA,
                        reinterpret_cast<LONG_PTR>(create->lpCreateParams));
      return TRUE;
    }
    case WM_CREATE: {
      HFONT font = static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
      const std::array<HWND, 7> controls = {
          create_control(window, L"STATIC", L"Task text", SS_LEFT, 24, 24, 120, 24, -1),
          create_control(window, L"EDIT", L"", WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL, 24, 52,
                         520, 30, kTaskTextId),
          create_control(window, L"BUTTON", L"Alpha", WS_TABSTOP | BS_AUTORADIOBUTTON | WS_GROUP,
                         24, 100, 120, 28, kOptionAlphaId),
          create_control(window, L"BUTTON", L"Beta", WS_TABSTOP | BS_AUTORADIOBUTTON, 164, 100,
                         120, 28, kOptionBetaId),
          create_control(window, L"BUTTON", L"Complete", WS_TABSTOP | BS_DEFPUSHBUTTON, 24, 148,
                         140, 34, kSubmitId),
          create_control(window, L"STATIC", L"Editing", SS_LEFT, 24, 206, 520, 28, kStatusId),
          create_control(window, L"EDIT", L"", ES_READONLY, -10'000, -10'000, 1, 1,
                         kResultPathId),
      };
      for (HWND control : controls) {
        if (control == nullptr) {
          return -1;
        }
        SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
      }
      if (FixtureState* state = fixture_state(window); state != nullptr) {
        SetWindowTextW(GetDlgItem(window, kResultPathId), state->result_file.c_str());
      }
      return 0;
    }
    case WM_COMMAND:
      if (LOWORD(w_param) == kSubmitId && HIWORD(w_param) == BN_CLICKED) {
        complete_fixture(window);
        return 0;
      }
      break;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
    default:
      break;
  }
  return DefWindowProcW(window, message, w_param, l_param);
}

bool parse_arguments(FixtureState& state) {
  int count = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &count);
  if (arguments == nullptr) {
    return false;
  }
  for (int index = 1; index + 1 < count; index += 2) {
    const std::wstring_view name(arguments[index]);
    const std::wstring value(arguments[index + 1]);
    if (name == L"--run-id") {
      state.run_id = value;
    } else if (name == L"--result-file") {
      state.result_file = value;
    } else {
      LocalFree(arguments);
      return false;
    }
  }
  LocalFree(arguments);
  const bool valid_run_id =
      !state.run_id.empty() && state.run_id.size() <= 256 &&
      std::all_of(state.run_id.begin(), state.run_id.end(), [](wchar_t character) {
        return iswalnum(character) || character == L'.' || character == L'_' ||
               character == L'-';
      });
  return count == 5 && valid_run_id &&
         !state.result_file.empty() && state.result_file.is_absolute();
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  InitCommonControls();
  FixtureState state;
  if (!parse_arguments(state)) {
    return 64;
  }

  const WNDCLASSEXW window_class{
      sizeof(WNDCLASSEXW),
      CS_HREDRAW | CS_VREDRAW,
      fixture_window_proc,
      0,
      0,
      instance,
      LoadIconW(nullptr, IDI_APPLICATION),
      LoadCursorW(nullptr, IDC_ARROW),
      reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1),
      nullptr,
      kWindowClass,
      nullptr,
  };
  if (RegisterClassExW(&window_class) == 0) {
    return 70;
  }
  const std::wstring title = L"OpenDelegate Computer Use Fixture - " + state.run_id;
  HWND window = CreateWindowExW(0, kWindowClass, title.c_str(),
                                WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                                CW_USEDEFAULT, CW_USEDEFAULT, 600, 310, nullptr, nullptr, instance,
                                &state);
  if (window == nullptr) {
    return 70;
  }
  if (SetWindowTextW(window, title.c_str()) == FALSE ||
      GetWindowTextLengthW(window) != static_cast<int>(title.size())) {
    DestroyWindow(window);
    return 70;
  }
  ShowWindow(window, SW_SHOWNORMAL);
  UpdateWindow(window);
  SetForegroundWindow(window);

  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  return static_cast<int>(message.wParam);
}
