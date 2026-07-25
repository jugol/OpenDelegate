#include "helper_automation.hpp"

#include <d3d11.h>
#include <dxgi1_2.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <uiautomation.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <wincodec.h>
#include <wtsapi32.h>

#include <shobjidl_core.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <span>
#include <string_view>
#include <vector>

#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/base.h>

namespace opendelegate::windows_computer_use {

namespace {

using winrt::Windows::Data::Json::JsonArray;
using winrt::Windows::Data::Json::JsonObject;
using winrt::Windows::Data::Json::JsonValue;
using winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame;
using winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool;
using winrt::Windows::Graphics::Capture::GraphicsCaptureItem;
using winrt::Windows::Graphics::Capture::GraphicsCapturePicker;
using winrt::Windows::Graphics::Capture::GraphicsCaptureSession;
using winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
using winrt::Windows::Graphics::DirectX::DirectXPixelFormat;

constexpr std::size_t kMaximumCaptureBytes = 64 * 1024 * 1024;
constexpr std::size_t kMaximumResultBytes = 1024 * 1024;
constexpr std::size_t kMaximumTextUnits = 1'000'000;
constexpr DWORD kUiAutomationTimeoutMilliseconds = 2'000;
constexpr wchar_t kFixtureTaskAutomationId[] = L"1001";
constexpr wchar_t kFixtureAlphaAutomationId[] = L"1002";
constexpr wchar_t kFixtureBetaAutomationId[] = L"1003";
constexpr wchar_t kFixtureSubmitAutomationId[] = L"1004";
constexpr int kFixtureTaskControlId = 1001;
constexpr int kFixtureAlphaControlId = 1002;
constexpr int kFixtureBetaControlId = 1003;
constexpr int kFixtureStatusControlId = 1005;
constexpr int kFixtureResultPathControlId = 1006;

struct CaptureBytes {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> bytes;
};

struct D3dDevices {
  winrt::com_ptr<ID3D11Device> d3d;
  IDirect3DDevice projected{nullptr};
};

struct DesktopEvidence {
  bool interactive = false;
  bool unlocked = false;
  DWORD session_id = 0;
  std::wstring desktop_name;
};

struct IntegrityEvidence {
  bool available = false;
  bool same_or_lower = false;
};

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

BOOL CALLBACK find_window_callback(HWND window, LPARAM context) {
  auto* pair =
      reinterpret_cast<std::pair<std::wstring_view, HWND*>*>(static_cast<INT_PTR>(context));
  if (!IsWindowVisible(window)) {
    return TRUE;
  }
  const int length = GetWindowTextLengthW(window);
  if (length <= 0 || length > 4096) {
    return TRUE;
  }
  std::wstring title(static_cast<std::size_t>(length) + 1, L'\0');
  if (GetWindowTextW(window, title.data(), length + 1) != length) {
    return TRUE;
  }
  title.resize(static_cast<std::size_t>(length));
  if (title == pair->first) {
    *pair->second = window;
    return FALSE;
  }
  return TRUE;
}

HWND find_window(std::wstring_view title) {
  HWND result = nullptr;
  std::pair<std::wstring_view, HWND*> context{title, &result};
  EnumWindows(find_window_callback, reinterpret_cast<LPARAM>(&context));
  return result;
}

DWORD process_session_id(DWORD process_id) {
  DWORD session_id = 0;
  if (!ProcessIdToSessionId(process_id, &session_id)) {
    throw HelperFailure();
  }
  return session_id;
}

DesktopEvidence desktop_evidence(HWND target) {
  DesktopEvidence result;
  result.session_id = process_session_id(GetCurrentProcessId());
  WTS_CONNECTSTATE_CLASS* state = nullptr;
  DWORD bytes = 0;
  if (WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, result.session_id, WTSConnectState,
                                  reinterpret_cast<LPWSTR*>(&state), &bytes) != FALSE &&
      state != nullptr && bytes >= sizeof(WTS_CONNECTSTATE_CLASS)) {
    result.interactive = *state == WTSActive;
  }
  if (state != nullptr) {
    WTSFreeMemory(state);
  }

  HDESK desktop =
      OpenInputDesktop(0x0001L, FALSE, DESKTOP_READOBJECTS | READ_CONTROL);
  if (desktop != nullptr) {
    DWORD required = 0;
    GetUserObjectInformationW(desktop, UOI_NAME, nullptr, 0, &required);
    if (required > sizeof(wchar_t) && required <= 4096) {
      std::wstring name(required / sizeof(wchar_t), L'\0');
      if (GetUserObjectInformationW(desktop, UOI_NAME, name.data(), required, &required) != FALSE) {
        name.resize(wcsnlen_s(name.data(), name.size()));
        result.desktop_name = name;
      }
    }
    CloseDesktop(desktop);
  }

  DWORD target_process = 0;
  GetWindowThreadProcessId(target, &target_process);
  const bool same_session =
      target_process != 0 && process_session_id(target_process) == result.session_id;
  result.unlocked = result.interactive && same_session && IsWindowVisible(target) != FALSE &&
                    _wcsicmp(result.desktop_name.c_str(), L"Default") == 0;
  return result;
}

DWORD integrity_level_for_process(DWORD process_id) {
  winrt::handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id));
  if (!process) {
    throw HelperFailure();
  }
  HANDLE token_raw = nullptr;
  require_win32(OpenProcessToken(process.get(), TOKEN_QUERY, &token_raw));
  winrt::handle token(token_raw);
  DWORD required = 0;
  GetTokenInformation(token.get(), TokenIntegrityLevel, nullptr, 0, &required);
  if (required == 0 || required > 64 * 1024) {
    throw HelperFailure();
  }
  std::vector<std::uint8_t> bytes(required);
  require_win32(GetTokenInformation(token.get(), TokenIntegrityLevel, bytes.data(), required,
                                    &required));
  const auto* label = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(bytes.data());
  const DWORD count = *GetSidSubAuthorityCount(label->Label.Sid);
  if (count == 0) {
    throw HelperFailure();
  }
  return *GetSidSubAuthority(label->Label.Sid, count - 1);
}

IntegrityEvidence target_integrity(HWND target) {
  IntegrityEvidence result;
  try {
    DWORD target_process = 0;
    GetWindowThreadProcessId(target, &target_process);
    result.same_or_lower =
        integrity_level_for_process(target_process) <=
        integrity_level_for_process(GetCurrentProcessId());
    result.available = true;
  } catch (...) {
    result.available = false;
  }
  return result;
}

D3dDevices create_d3d_devices() {
  D3dDevices result;
  D3D_FEATURE_LEVEL level{};
  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  HRESULT status =
      D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, nullptr, 0,
                        D3D11_SDK_VERSION, result.d3d.put(), &level, nullptr);
  if (FAILED(status)) {
    status = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags, nullptr, 0,
                               D3D11_SDK_VERSION, result.d3d.put(), &level, nullptr);
  }
  require_hresult(status);
  auto dxgi = result.d3d.as<IDXGIDevice>();
  winrt::com_ptr<IInspectable> inspectable;
  require_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), inspectable.put()));
  result.projected = inspectable.as<IDirect3DDevice>();
  return result;
}

std::vector<std::uint8_t> encode_png(ID3D11Device* device, ID3D11Texture2D* source,
                                     std::uint32_t width, std::uint32_t height) {
  D3D11_TEXTURE2D_DESC description{};
  source->GetDesc(&description);
  description.Width = width;
  description.Height = height;
  description.MipLevels = 1;
  description.ArraySize = 1;
  description.SampleDesc.Count = 1;
  description.Usage = D3D11_USAGE_STAGING;
  description.BindFlags = 0;
  description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  description.MiscFlags = 0;
  winrt::com_ptr<ID3D11Texture2D> staging;
  require_hresult(device->CreateTexture2D(&description, nullptr, staging.put()));
  winrt::com_ptr<ID3D11DeviceContext> context;
  device->GetImmediateContext(context.put());
  context->CopyResource(staging.get(), source);

  D3D11_MAPPED_SUBRESOURCE mapped{};
  require_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped));
  struct UnmapGuard {
    ID3D11DeviceContext* context;
    ID3D11Resource* resource;
    ~UnmapGuard() { context->Unmap(resource, 0); }
  } guard{context.get(), staging.get()};

  winrt::com_ptr<IWICImagingFactory> factory;
  require_hresult(CoCreateInstance(CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER,
                                   IID_PPV_ARGS(factory.put())));
  winrt::com_ptr<IStream> memory_stream;
  require_hresult(CreateStreamOnHGlobal(nullptr, TRUE, memory_stream.put()));
  winrt::com_ptr<IWICBitmapEncoder> encoder;
  require_hresult(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.put()));
  require_hresult(encoder->Initialize(memory_stream.get(), WICBitmapEncoderNoCache));
  winrt::com_ptr<IWICBitmapFrameEncode> frame;
  winrt::com_ptr<IPropertyBag2> properties;
  require_hresult(encoder->CreateNewFrame(frame.put(), properties.put()));
  require_hresult(frame->Initialize(properties.get()));
  require_hresult(frame->SetSize(width, height));
  WICPixelFormatGUID pixel_format = GUID_WICPixelFormat32bppBGRA;
  require_hresult(frame->SetPixelFormat(&pixel_format));
  if (pixel_format != GUID_WICPixelFormat32bppBGRA) {
    throw HelperFailure();
  }
  const std::uint64_t byte_count =
      static_cast<std::uint64_t>(mapped.RowPitch) * static_cast<std::uint64_t>(height);
  if (byte_count == 0 || byte_count > (std::numeric_limits<UINT>::max)()) {
    throw HelperFailure();
  }
  require_hresult(frame->WritePixels(height, mapped.RowPitch, static_cast<UINT>(byte_count),
                                     static_cast<BYTE*>(mapped.pData)));
  require_hresult(frame->Commit());
  require_hresult(encoder->Commit());

  HGLOBAL global = nullptr;
  require_hresult(GetHGlobalFromStream(memory_stream.get(), &global));
  STATSTG stream_status{};
  require_hresult(memory_stream->Stat(&stream_status, STATFLAG_NONAME));
  const ULONGLONG size = stream_status.cbSize.QuadPart;
  if (size == 0 || size > kMaximumCaptureBytes || size > GlobalSize(global)) {
    throw HelperFailure();
  }
  const void* data = GlobalLock(global);
  if (data == nullptr) {
    throw HelperFailure();
  }
  std::vector<std::uint8_t> bytes(
      static_cast<const std::uint8_t*>(data),
      static_cast<const std::uint8_t*>(data) + static_cast<std::size_t>(size));
  GlobalUnlock(global);
  return bytes;
}

CaptureBytes capture_item_png(const GraphicsCaptureItem& item) {
  if (!item || !GraphicsCaptureSession::IsSupported()) {
    throw HelperFailure();
  }
  const auto item_size = item.Size();
  if (item_size.Width <= 0 || item_size.Height <= 0) {
    throw HelperFailure();
  }
  D3dDevices devices = create_d3d_devices();
  Direct3D11CaptureFramePool frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
      devices.projected, DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, item_size);
  auto session = frame_pool.CreateCaptureSession(item);
  std::mutex mutex;
  std::condition_variable condition;
  Direct3D11CaptureFrame captured{nullptr};
  const auto token = frame_pool.FrameArrived(
      [&](const Direct3D11CaptureFramePool& sender, const winrt::Windows::Foundation::IInspectable&) {
        Direct3D11CaptureFrame frame = sender.TryGetNextFrame();
        if (frame) {
          {
            std::lock_guard lock(mutex);
            if (!captured) {
              captured = frame;
            }
          }
          condition.notify_one();
        }
      });
  session.StartCapture();
  {
    std::unique_lock lock(mutex);
    if (!condition.wait_for(lock, std::chrono::seconds(5), [&] { return captured != nullptr; })) {
      session.Close();
      frame_pool.FrameArrived(token);
      frame_pool.Close();
      throw HelperFailure();
    }
  }
  session.Close();
  frame_pool.FrameArrived(token);

  const auto content_size = captured.ContentSize();
  if (content_size.Width <= 0 || content_size.Height <= 0) {
    frame_pool.Close();
    throw HelperFailure();
  }
  const auto surface = captured.Surface();
  auto access =
      surface.as<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
  winrt::com_ptr<ID3D11Texture2D> texture;
  require_hresult(access->GetInterface(IID_PPV_ARGS(texture.put())));
  CaptureBytes result;
  result.width = static_cast<std::uint32_t>(content_size.Width);
  result.height = static_cast<std::uint32_t>(content_size.Height);
  result.bytes = encode_png(devices.d3d.get(), texture.get(), result.width, result.height);
  captured.Close();
  frame_pool.Close();
  return result;
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

std::string sha256_hex(std::string_view value) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_size = 0;
  DWORD returned = 0;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                        reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &returned,
                        0) != 0 ||
      object_size == 0) {
    if (algorithm != nullptr) {
      BCryptCloseAlgorithmProvider(algorithm, 0);
    }
    throw HelperFailure();
  }
  std::vector<std::uint8_t> object(object_size);
  std::array<std::uint8_t, 32> digest{};
  if (BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) != 0 ||
      BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(value.data())),
                     static_cast<ULONG>(value.size()), 0) != 0 ||
      BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) != 0) {
    if (hash != nullptr) {
      BCryptDestroyHash(hash);
    }
    BCryptCloseAlgorithmProvider(algorithm, 0);
    secure_zero(object.data(), object.size());
    throw HelperFailure();
  }
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  secure_zero(object.data(), object.size());
  std::ostringstream output;
  output << std::hex << std::setfill('0');
  for (const std::uint8_t byte : digest) {
    output << std::setw(2) << static_cast<unsigned int>(byte);
  }
  secure_zero(digest.data(), digest.size());
  return output.str();
}

winrt::com_ptr<IUIAutomation> create_automation() {
  winrt::com_ptr<IUIAutomation> automation;
  require_hresult(CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER,
                                   IID_PPV_ARGS(automation.put())));
  winrt::com_ptr<IUIAutomation2> bounded;
  require_hresult(automation->QueryInterface(IID_PPV_ARGS(bounded.put())));
  require_hresult(
      bounded->put_ConnectionTimeout(kUiAutomationTimeoutMilliseconds));
  require_hresult(
      bounded->put_TransactionTimeout(kUiAutomationTimeoutMilliseconds));
  return automation;
}

std::wstring automation_id_for_alias(std::string_view alias) {
  if (alias == "task-text") {
    return kFixtureTaskAutomationId;
  }
  if (alias == "option-alpha") {
    return kFixtureAlphaAutomationId;
  }
  if (alias == "option-beta") {
    return kFixtureBetaAutomationId;
  }
  if (alias == "submit") {
    return kFixtureSubmitAutomationId;
  }
  if (alias.starts_with("uia:")) {
    return wide(alias.substr(4));
  }
  throw HelperFailure();
}

std::string alias_for_automation_id(std::wstring_view automation_id) {
  if (automation_id == kFixtureTaskAutomationId) {
    return "task-text";
  }
  if (automation_id == kFixtureAlphaAutomationId) {
    return "option-alpha";
  }
  if (automation_id == kFixtureBetaAutomationId) {
    return "option-beta";
  }
  if (automation_id == kFixtureSubmitAutomationId) {
    return "submit";
  }
  const std::string encoded = utf8(automation_id);
  if (encoded.empty() || encoded.size() > 256) {
    return {};
  }
  return "uia:" + encoded;
}

winrt::com_ptr<IUIAutomationElement> find_element(IUIAutomation* automation, HWND root_window,
                                                  std::wstring_view automation_id) {
  winrt::com_ptr<IUIAutomationElement> root;
  require_hresult(automation->ElementFromHandle(root_window, root.put()));
  VARIANT value;
  VariantInit(&value);
  value.vt = VT_BSTR;
  value.bstrVal = SysAllocStringLen(automation_id.data(),
                                   static_cast<UINT>(automation_id.size()));
  if (value.bstrVal == nullptr) {
    throw HelperFailure();
  }
  winrt::com_ptr<IUIAutomationCondition> condition;
  const HRESULT condition_status =
      automation->CreatePropertyCondition(UIA_AutomationIdPropertyId, value, condition.put());
  VariantClear(&value);
  require_hresult(condition_status);
  winrt::com_ptr<IUIAutomationElement> element;
  require_hresult(root->FindFirst(TreeScope_Subtree, condition.get(), element.put()));
  if (!element) {
    throw HelperFailure();
  }
  return element;
}

bool try_click_pattern(IUIAutomationElement* element) {
  winrt::com_ptr<IUIAutomationSelectionItemPattern> selection;
  if (SUCCEEDED(element->GetCurrentPatternAs(UIA_SelectionItemPatternId,
                                             IID_PPV_ARGS(selection.put()))) &&
      selection) {
    return SUCCEEDED(selection->Select());
  }
  winrt::com_ptr<IUIAutomationInvokePattern> invoke;
  if (SUCCEEDED(element->GetCurrentPatternAs(UIA_InvokePatternId,
                                             IID_PPV_ARGS(invoke.put()))) &&
      invoke) {
    return SUCCEEDED(invoke->Invoke());
  }
  return false;
}

bool try_value_pattern(IUIAutomationElement* element, std::wstring_view text) {
  winrt::com_ptr<IUIAutomationValuePattern> value;
  if (FAILED(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(value.put()))) ||
      !value) {
    return false;
  }
  BOOL read_only = TRUE;
  if (FAILED(value->get_CurrentIsReadOnly(&read_only)) || read_only != FALSE) {
    return false;
  }
  std::wstring copy(text);
  SecureContainerWipe copy_wipe(copy);
  BSTR value_text = SysAllocStringLen(copy.data(), static_cast<UINT>(copy.size()));
  if (value_text == nullptr) {
    throw HelperFailure();
  }
  const HRESULT status = value->SetValue(value_text);
  secure_zero(value_text, SysStringByteLen(value_text));
  SysFreeString(value_text);
  return SUCCEEDED(status);
}

void require_client_connected(HANDLE pipe) {
  DWORD available = 0;
  if (PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) == FALSE) {
    throw HelperFailure();
  }
}

void require_foreground_target(HWND target) {
  if (GetForegroundWindow() != target) {
    if (SetForegroundWindow(target) == FALSE || GetForegroundWindow() != target) {
      throw HelperFailure();
    }
  }
}

template <typename AcquireInputGate>
void pointer_click(IUIAutomationElement* element, HWND target,
                   AcquireInputGate&& acquire_input_gate) {
  RECT rectangle{};
  require_hresult(element->get_CurrentBoundingRectangle(&rectangle));
  if (rectangle.right <= rectangle.left || rectangle.bottom <= rectangle.top) {
    throw HelperFailure();
  }
  POINT point{rectangle.left + (rectangle.right - rectangle.left) / 2,
              rectangle.top + (rectangle.bottom - rectangle.top) / 2};
  auto input_gate = acquire_input_gate();
  require_foreground_target(target);
  if (SetCursorPos(point.x, point.y) == FALSE) {
    throw HelperFailure();
  }
  const HWND hit = WindowFromPoint(point);
  if (hit == nullptr || GetAncestor(hit, GA_ROOT) != target) {
    throw HelperFailure();
  }
  INPUT input[2]{};
  input[0].type = INPUT_MOUSE;
  input[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
  input[1].type = INPUT_MOUSE;
  input[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
  if (SendInput(2, input, sizeof(INPUT)) != 2) {
    INPUT release = input[1];
    SendInput(1, &release, sizeof(INPUT));
    throw HelperFailure();
  }
}

template <typename AcquireInputGate>
void send_unicode_text(IUIAutomationElement* element, HWND target,
                       std::wstring_view text,
                       AcquireInputGate&& acquire_input_gate) {
  require_foreground_target(target);
  require_hresult(element->SetFocus());
  if (GetForegroundWindow() != target) {
    throw HelperFailure();
  }
  for (const wchar_t unit : text) {
    INPUT input[2]{};
    input[0].type = INPUT_KEYBOARD;
    input[0].ki.wScan = unit;
    input[0].ki.dwFlags = KEYEVENTF_UNICODE;
    input[1] = input[0];
    input[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    auto input_gate = acquire_input_gate();
    if (SendInput(2, input, sizeof(INPUT)) != 2) {
      INPUT release = input[1];
      SendInput(1, &release, sizeof(INPUT));
      throw HelperFailure();
    }
  }
}

std::wstring read_window_text(HWND window) {
  const int length = GetWindowTextLengthW(window);
  if (length < 0 || length > static_cast<int>(kMaximumTextUnits)) {
    throw HelperFailure();
  }
  std::wstring value(static_cast<std::size_t>(length) + 1, L'\0');
  if (length > 0 && GetWindowTextW(window, value.data(), length + 1) != length) {
    throw HelperFailure();
  }
  value.resize(static_cast<std::size_t>(length));
  return value;
}

std::vector<std::uint8_t> read_result_file(const std::filesystem::path& path) {
  std::error_code error;
  const std::uintmax_t size = std::filesystem::file_size(path, error);
  if (error || size == 0 || size > kMaximumResultBytes) {
    return {};
  }
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    return {};
  }
  std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
  input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  if (!input) {
    secure_zero(bytes.data(), bytes.size());
    return {};
  }
  return bytes;
}

void insert_string(JsonObject& object, std::wstring_view name, std::string_view value) {
  object.Insert(name, JsonValue::CreateStringValue(winrt::to_hstring(value)));
}

void insert_bool(JsonObject& object, std::wstring_view name, bool value) {
  object.Insert(name, JsonValue::CreateBooleanValue(value));
}

std::string require_json_string(const JsonObject& object, std::wstring_view name,
                                std::size_t maximum = kMaximumIdentifierLength) {
  if (!object.HasKey(name)) {
    throw HelperFailure();
  }
  const std::string value = winrt::to_string(object.GetNamedString(name));
  if (value.empty() || value.size() > maximum) {
    throw HelperFailure();
  }
  return value;
}

}  // namespace

WindowsAutomation::WindowsAutomation(const Configuration& configuration)
    : configuration_(configuration) {}

void WindowsAutomation::initialize_capture_target() {
  HWND target = target_window();
  if (configuration_.capture_mode == L"fixture-window") {
    auto interop =
        winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    require_hresult(interop->CreateForWindow(
        target, winrt::guid_of<GraphicsCaptureItem>(),
        winrt::put_abi(capture_item_)));
    return;
  }

  HWND owner = target;
  bool destroy_owner = false;
  if (owner == nullptr) {
    owner = CreateWindowExW(0, L"STATIC", L"OpenDelegate screen capture selection",
                            WS_OVERLAPPED, CW_USEDEFAULT, CW_USEDEFAULT, 320, 120, nullptr,
                            nullptr, GetModuleHandleW(nullptr), nullptr);
    destroy_owner = owner != nullptr;
  }
  if (owner == nullptr) {
    throw HelperFailure();
  }
  GraphicsCapturePicker picker;
  auto initialize = picker.as<IInitializeWithWindow>();
  require_hresult(initialize->Initialize(owner));
  capture_item_ = picker.PickSingleItemAsync().get();
  if (destroy_owner) {
    DestroyWindow(owner);
  }
  if (!capture_item_) {
    throw HelperFailure();
  }
  if (!configuration_.fixture_window_title.empty() &&
      capture_item_.DisplayName() != configuration_.fixture_window_title) {
    capture_item_ = nullptr;
    throw HelperFailure();
  }
}

HWND WindowsAutomation::target_window() const {
  HWND target = nullptr;
  if (!configuration_.fixture_window_title.empty()) {
    target = find_window(configuration_.fixture_window_title);
  } else {
    target = GetForegroundWindow();
  }
  if (target == nullptr) {
    throw HelperFailure();
  }
  return target;
}

std::string WindowsAutomation::display_fingerprint() {
  HWND target = target_window();
  const DesktopEvidence desktop = desktop_evidence(target);
  RECT bounds{};
  require_win32(GetWindowRect(target, &bounds));
  const UINT dpi = GetDpiForWindow(target);
  MONITORINFOEXW monitor{};
  monitor.cbSize = sizeof(monitor);
  require_win32(GetMonitorInfoW(MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST), &monitor));
  const auto size = capture_item_.Size();
  std::ostringstream canonical;
  canonical << "windows-wgc-v1\n" << desktop.session_id << '\n' << utf8(monitor.szDevice)
            << '\n' << bounds.left << ',' << bounds.top << ',' << bounds.right << ','
            << bounds.bottom << '\n' << dpi << '\n' << size.Width << 'x' << size.Height << '\n'
            << winrt::to_string(capture_item_.DisplayName());
  return "windows-display:sha256:" + sha256_hex(canonical.str());
}

JsonObject WindowsAutomation::probe() {
  HWND target = target_window();
  const DesktopEvidence desktop = desktop_evidence(target);
  const IntegrityEvidence integrity = target_integrity(target);
  bool frame_ready = false;
  try {
    const CaptureBytes frame = capture_item_png(capture_item_);
    frame_ready = !frame.bytes.empty();
  } catch (...) {
    frame_ready = false;
  }
  bool accessibility = false;
  bool fixture_controls = false;
  try {
    auto automation = create_automation();
    find_element(automation.get(), target, kFixtureTaskAutomationId);
    find_element(automation.get(), target, kFixtureAlphaAutomationId);
    find_element(automation.get(), target, kFixtureBetaAutomationId);
    find_element(automation.get(), target, kFixtureSubmitAutomationId);
    accessibility = true;
    fixture_controls = true;
  } catch (...) {
    accessibility = false;
    fixture_controls = false;
  }

  JsonObject readiness;
  insert_bool(readiness, L"interactiveSession", desktop.interactive);
  insert_bool(readiness, L"unlockedSession", desktop.unlocked);
  insert_bool(readiness, L"captureSupported", GraphicsCaptureSession::IsSupported());
  insert_bool(readiness, L"captureTargetSelected", capture_item_ != nullptr);
  insert_bool(readiness, L"frameReady", frame_ready);
  insert_bool(readiness, L"accessibilityAvailable", accessibility);
  insert_bool(readiness, L"fixtureControlsVisible", fixture_controls);
  insert_bool(readiness, L"inputAvailable",
              desktop.unlocked && integrity.available && integrity.same_or_lower);
  insert_bool(readiness, L"emergencyStopAvailable",
              local_emergency_stop_ready_.load());
  insert_string(readiness, L"targetIntegrity",
                !integrity.available ? "unknown"
                : integrity.same_or_lower ? "same-or-lower"
                                          : "higher");
  JsonObject response;
  response.Insert(L"readiness", readiness);
  return response;
}

JsonObject WindowsAutomation::observe(const JsonObject& scope) {
  require_current_scope(scope, false);
  HWND target = target_window();
  auto automation = create_automation();
  winrt::com_ptr<IUIAutomationElement> root;
  require_hresult(automation->ElementFromHandle(target, root.put()));
  winrt::com_ptr<IUIAutomationCondition> condition;
  require_hresult(automation->CreateTrueCondition(condition.put()));
  winrt::com_ptr<IUIAutomationElementArray> elements;
  require_hresult(root->FindAll(TreeScope_Subtree, condition.get(), elements.put()));
  int count = 0;
  require_hresult(elements->get_Length(&count));
  if (count < 0 || count > 10'000) {
    throw HelperFailure();
  }

  JsonArray tree;
  for (int index = 0; index < count; ++index) {
    winrt::com_ptr<IUIAutomationElement> element;
    require_hresult(elements->GetElement(index, element.put()));
    BSTR automation_id_raw = nullptr;
    BSTR name_raw = nullptr;
    CONTROLTYPEID control_type = 0;
    if (FAILED(element->get_CurrentAutomationId(&automation_id_raw)) ||
        FAILED(element->get_CurrentName(&name_raw)) ||
        FAILED(element->get_CurrentControlType(&control_type))) {
      SysFreeString(automation_id_raw);
      SysFreeString(name_raw);
      continue;
    }
    const std::wstring automation_id =
        automation_id_raw == nullptr ? L"" : std::wstring(automation_id_raw);
    const std::wstring name = name_raw == nullptr ? L"" : std::wstring(name_raw);
    SysFreeString(automation_id_raw);
    SysFreeString(name_raw);
    const std::string control_id = alias_for_automation_id(automation_id);
    std::string role;
    if (control_type == UIA_ButtonControlTypeId) {
      role = "button";
    } else if (control_type == UIA_RadioButtonControlTypeId) {
      role = "radio";
    } else if (control_type == UIA_EditControlTypeId) {
      role = "textbox";
    } else {
      continue;
    }
    if (control_id.empty()) {
      continue;
    }
    JsonObject control;
    insert_string(control, L"controlId", control_id);
    insert_string(control, L"role", role);
    insert_string(control, L"label", name.empty() ? control_id : utf8(name));
    if (role == "textbox") {
      winrt::com_ptr<IUIAutomationValuePattern> value;
      if (SUCCEEDED(element->GetCurrentPatternAs(UIA_ValuePatternId,
                                                 IID_PPV_ARGS(value.put()))) &&
          value) {
        BSTR current = nullptr;
        if (SUCCEEDED(value->get_CurrentValue(&current)) && current != nullptr) {
          insert_string(control, L"value", utf8(current));
        }
        SysFreeString(current);
      }
    } else if (role == "radio") {
      winrt::com_ptr<IUIAutomationSelectionItemPattern> selection;
      BOOL selected = FALSE;
      if (SUCCEEDED(element->GetCurrentPatternAs(UIA_SelectionItemPatternId,
                                                 IID_PPV_ARGS(selection.put()))) &&
          selection && SUCCEEDED(selection->get_CurrentIsSelected(&selected))) {
        insert_bool(control, L"selected", selected != FALSE);
      }
    }
    tree.Append(control);
  }

  JsonObject observation;
  observation.Insert(L"accessibilityTree", tree);
  if (!configuration_.fixture_window_title.empty()) {
    JsonObject fixture;
    const std::wstring prefix = L"OpenDelegate Computer Use Fixture - ";
    const std::wstring run_id =
        configuration_.fixture_window_title.starts_with(prefix)
            ? configuration_.fixture_window_title.substr(prefix.size())
            : configuration_.fixture_window_title;
    insert_string(fixture, L"runIdentifier", utf8(run_id));
    const std::wstring status =
        read_window_text(GetDlgItem(target, kFixtureStatusControlId));
    insert_string(fixture, L"state", status == L"Success" ? "success" : "editing");
    insert_string(fixture, L"textValue",
                  utf8(read_window_text(GetDlgItem(target, kFixtureTaskControlId))));
    const bool alpha =
        SendMessageW(GetDlgItem(target, kFixtureAlphaControlId), BM_GETCHECK, 0, 0) ==
        BST_CHECKED;
    const bool beta =
        SendMessageW(GetDlgItem(target, kFixtureBetaControlId), BM_GETCHECK, 0, 0) ==
        BST_CHECKED;
    if (beta) {
      insert_string(fixture, L"selectedOption", "Beta");
    } else if (alpha) {
      insert_string(fixture, L"selectedOption", "Alpha");
    } else {
      fixture.Insert(L"selectedOption", JsonValue::CreateNullValue());
    }
    std::vector<std::uint8_t> result =
        read_result_file(configuration_.fixture_result_file);
    SecureContainerWipe result_wipe(result);
    if (status == L"Success" && !result.empty()) {
      JsonObject result_file;
      insert_string(result_file, L"filename",
                    utf8(configuration_.fixture_result_file.filename().wstring()));
      insert_string(result_file, L"mediaType", "application/json");
      insert_string(result_file, L"bytesBase64Url", base64_url(result));
      fixture.Insert(L"resultFile", result_file);
    } else {
      fixture.Insert(L"resultFile", JsonValue::CreateNullValue());
    }
    observation.Insert(L"fixture", fixture);
  }
  return observation;
}

JsonObject WindowsAutomation::capture(const JsonObject& scope) {
  require_current_scope(scope, false);
  CaptureBytes evidence = capture_item_png(capture_item_);
  SecureContainerWipe evidence_wipe(evidence.bytes);
  JsonObject capture;
  insert_string(capture, L"mediaType", "image/png");
  capture.Insert(L"width", JsonValue::CreateNumberValue(evidence.width));
  capture.Insert(L"height", JsonValue::CreateNumberValue(evidence.height));
  insert_string(capture, L"bytesBase64Url", base64_url(evidence.bytes));
  return capture;
}

JsonObject WindowsAutomation::act(const JsonObject& scope, const JsonObject& action,
                                  HANDLE client_pipe) {
  std::unique_lock input_lock(input_mutex_);
  require_current_scope(scope, true);
  const std::string execution_handle =
      require_json_string(scope, L"executionHandleId");
  const auto acquire_input_gate = [&]() {
    std::unique_lock gate(state_mutex_);
    if (cancelled_handles_.contains(execution_handle) ||
        emergency_stopped_handles_.contains(execution_handle) ||
        global_emergency_stop_.load()) {
      throw HelperFailure();
    }
    require_client_connected(client_pipe);
    return gate;
  };
  HWND target = target_window();
  const IntegrityEvidence integrity = target_integrity(target);
  if (!integrity.available || !integrity.same_or_lower) {
    throw HelperFailure();
  }
  auto automation = create_automation();
  const std::string control_id = require_json_string(action, L"controlId", 512);
  const std::wstring automation_id = automation_id_for_alias(control_id);
  auto element = find_element(automation.get(), target, automation_id);
  const std::string kind = require_json_string(action, L"kind", 32);
  if (kind == "click") {
    bool used_semantic_pattern = false;
    {
      auto input_gate = acquire_input_gate();
      used_semantic_pattern = try_click_pattern(element.get());
    }
    if (!used_semantic_pattern) {
      pointer_click(element.get(), target, acquire_input_gate);
    }
  } else if (kind == "type-text") {
    std::string sensitive_utf8 = require_json_string(action, L"text", 4 * kMaximumTextUnits);
    SecureContainerWipe sensitive_utf8_wipe(sensitive_utf8);
    std::wstring sensitive_text = wide(sensitive_utf8);
    SecureContainerWipe sensitive_text_wipe(sensitive_text);
    if (sensitive_text.empty() || sensitive_text.size() > kMaximumTextUnits) {
      throw HelperFailure();
    }
    bool used_semantic_pattern = false;
    {
      auto input_gate = acquire_input_gate();
      used_semantic_pattern =
          try_value_pattern(element.get(), sensitive_text);
    }
    if (!used_semantic_pattern) {
      send_unicode_text(element.get(), target, sensitive_text,
                        acquire_input_gate);
    }
  } else {
    throw HelperFailure();
  }
  require_current_scope(scope, true);
  JsonObject response;
  response.Insert(
      L"sequence",
      JsonValue::CreateNumberValue(static_cast<double>(action_sequence_.fetch_add(1) + 1)));
  return response;
}

void WindowsAutomation::cancel(const JsonObject& scope) {
  const std::string execution_handle = require_json_string(scope, L"executionHandleId");
  std::lock_guard lock(state_mutex_);
  cancelled_handles_.insert(execution_handle);
}

void WindowsAutomation::emergency_stop(const JsonObject& scope) {
  const std::string execution_handle = require_json_string(scope, L"executionHandleId");
  {
    std::lock_guard lock(state_mutex_);
    emergency_stopped_handles_.insert(execution_handle);
  }
  INPUT inputs[6]{};
  const WORD keys[] = {VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN};
  UINT count = 0;
  for (const WORD key : keys) {
    inputs[count].type = INPUT_KEYBOARD;
    inputs[count].ki.wVk = key;
    inputs[count].ki.dwFlags = KEYEVENTF_KEYUP;
    ++count;
  }
  inputs[count].type = INPUT_MOUSE;
  inputs[count].mi.dwFlags =
      MOUSEEVENTF_LEFTUP | MOUSEEVENTF_RIGHTUP | MOUSEEVENTF_MIDDLEUP;
  ++count;
  SendInput(count, inputs, sizeof(INPUT));
}

void WindowsAutomation::emergency_stop_all() {
  std::lock_guard lock(state_mutex_);
  global_emergency_stop_.store(true);
}

void WindowsAutomation::set_local_emergency_stop_ready(bool ready) noexcept {
  local_emergency_stop_ready_.store(ready);
}

void WindowsAutomation::require_current_scope(const JsonObject& scope, bool for_input) {
  const std::string execution_handle = require_json_string(scope, L"executionHandleId");
  const std::string expected_display =
      require_json_string(scope, L"expectedDisplayFingerprint", 256);
  if (expected_display != display_fingerprint()) {
    throw HelperFailure();
  }
  if (is_cancelled(execution_handle) ||
      (for_input && (is_emergency_stopped(execution_handle) ||
                     global_emergency_stop_.load()))) {
    throw HelperFailure();
  }
  const DesktopEvidence desktop = desktop_evidence(target_window());
  if (!desktop.interactive || !desktop.unlocked) {
    throw HelperFailure();
  }
}

bool WindowsAutomation::is_cancelled(std::string_view execution_handle) {
  std::lock_guard lock(state_mutex_);
  return cancelled_handles_.contains(std::string(execution_handle));
}

bool WindowsAutomation::is_emergency_stopped(std::string_view execution_handle) {
  std::lock_guard lock(state_mutex_);
  return emergency_stopped_handles_.contains(std::string(execution_handle));
}

}  // namespace opendelegate::windows_computer_use
