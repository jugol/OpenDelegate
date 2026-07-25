#if os(macOS)
@preconcurrency import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import OpenDelegateMacComputerUseProtocol
@preconcurrency import ScreenCaptureKit
import UniformTypeIdentifiers

private let backendId = "macos-ax-screencapturekit-cgevent"
private let maximumAccessibilityNodes = 2_048
private let maximumAccessibilityDepth = 12
private let maximumFixtureResultBytes = 1_048_576
private let maximumCapturePngBytes = 11 * 1_024 * 1_024
private let maximumCaptureDimension = 16_384

@MainActor
final class MacSessionMonitor {
  private var sessionActive: Bool
  private var screensAwake: Bool
  private var desktopGeneration = 0
  private var observers: [NSObjectProtocol] = []

  init() {
    sessionActive = Self.hasActiveConsoleSession()
    screensAwake = CGDisplayIsAsleep(CGMainDisplayID()) == 0
    let center = NSWorkspace.shared.notificationCenter
    observers.append(
      center.addObserver(
        forName: NSWorkspace.sessionDidResignActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        Task { @MainActor [weak self] in
          self?.sessionActive = false
          self?.invalidateDesktop()
        }
      }
    )
    observers.append(
      center.addObserver(
        forName: NSWorkspace.sessionDidBecomeActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        Task { @MainActor [weak self] in
          self?.sessionActive = true
          self?.invalidateDesktop()
        }
      }
    )
    observers.append(
      center.addObserver(
        forName: NSWorkspace.screensDidSleepNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        Task { @MainActor [weak self] in
          self?.screensAwake = false
          self?.invalidateDesktop()
        }
      }
    )
    observers.append(
      center.addObserver(
        forName: NSWorkspace.screensDidWakeNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        Task { @MainActor [weak self] in
          self?.screensAwake = true
          self?.invalidateDesktop()
        }
      }
    )
    observers.append(
      center.addObserver(
        forName: NSWorkspace.activeSpaceDidChangeNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        Task { @MainActor [weak self] in
          self?.invalidateDesktop()
        }
      }
    )
  }

  var interactive: Bool {
    return sessionActive && Self.hasActiveConsoleSession()
  }

  var safelyUnlocked: Bool {
    guard interactive, screensAwake else {
      return false
    }
    guard let frontmost = NSWorkspace.shared.frontmostApplication else {
      return false
    }
    return frontmost.bundleIdentifier != "com.apple.loginwindow"
  }

  var generation: Int {
    return desktopGeneration
  }

  private func invalidateDesktop() {
    desktopGeneration = desktopGeneration == Int.max ? 0 : desktopGeneration + 1
  }

  private static func hasActiveConsoleSession() -> Bool {
    guard
      let dictionary = CGSessionCopyCurrentDictionary() as? [String: Any],
      dictionary[kCGSessionOnConsoleKey] as? Bool == true,
      dictionary[kCGSessionLoginDoneKey] as? Bool == true
    else {
      return false
    }
    return true
  }
}

private struct NativeFailure: Error {
  let code: WireErrorCode
}

private struct CapturedPng {
  let displayFingerprint: String
  let width: Int
  let height: Int
  let bytes: Data
}

private struct AccessibleElement {
  let element: AXUIElement
  let processId: pid_t
  let controlId: String
  let role: String
  let label: String
  let value: String?
  let selected: Bool?
}

@MainActor
final class MacNativeComputerUseDriver {
  private let binding: HelperBinding
  private let monitor: MacSessionMonitor
  private let stops: ExecutionStopRegistry
  private let fixtureResultDirectory: URL?
  private var actionSequence = 0

  init(
    binding: HelperBinding,
    monitor: MacSessionMonitor,
    stops: ExecutionStopRegistry,
    fixtureResultDirectory: URL?
  ) {
    self.binding = binding
    self.monitor = monitor
    self.stops = stops
    self.fixtureResultDirectory = fixtureResultDirectory
  }

  func handle(_ request: WireRequest) async -> WireResponse {
    do {
      let result: JSONValue
      switch request.operation {
      case .probe:
        result = try await probe()
      case .observe:
        guard let execution = request.execution else {
          throw NativeFailure(code: .unavailable)
        }
        result = try observe(execution)
      case .capture:
        guard let execution = request.execution else {
          throw NativeFailure(code: .unavailable)
        }
        try validate(execution, requireInput: false)
        let capture = try await captureScreen()
        try validate(execution, requireInput: false)
        result = captureValue(capture)
      case .act:
        guard let execution = request.execution, let action = request.action else {
          throw NativeFailure(code: .unavailable)
        }
        result = try await act(execution, action: action)
      case .cancel, .emergencyStop:
        throw NativeFailure(code: .unavailable)
      }
      return .success(for: request, result: result)
    } catch let failure as NativeFailure {
      return .failure(for: request, code: failure.code)
    } catch {
      return .failure(for: request, code: .unavailable)
    }
  }

  private func probe() async throws -> JSONValue {
    let interactive = monitor.interactive
    let unlocked = monitor.safelyUnlocked
    let accessibilityTrusted = AXIsProcessTrusted()
    let postEventAllowed = CGPreflightPostEventAccess()
    let secureInput = IsSecureEventInputEnabled()
    let displayFingerprint = currentDesktopFingerprint()

    var captureReady = false
    if interactive, unlocked, CGPreflightScreenCaptureAccess(), displayFingerprint != nil {
      captureReady = (try? await captureScreen()) != nil
    }
    var accessibilityReady = false
    if interactive, unlocked, accessibilityTrusted {
      let system = AXUIElementCreateSystemWide()
      var focused: CFTypeRef?
      accessibilityReady =
        AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &focused)
        == .success
    }

    let checks: [JSONValue] = [
      check(
        name: "interactive-session",
        passed: interactive,
        pass: "The signed helper is running in the active owner Aqua session.",
        fail: "No active owner Aqua session is available.",
        remediation: "Log in to the owner Aqua session and start its LaunchAgent."
      ),
      check(
        name: "unlocked-session",
        passed: unlocked,
        pass: "The active owner session and screens are available for safe targeting.",
        fail: "The owner session is inactive, switched out, asleep, or at loginwindow.",
        remediation: "Return to and unlock the owner session."
      ),
      check(
        name: "screen-capture",
        passed: captureReady,
        pass: "A bounded ScreenCaptureKit frame was captured in this helper process.",
        fail: "Screen Recording permission or a current ScreenCaptureKit frame is unavailable.",
        remediation: "Grant Screen Recording to the signed OpenDelegate helper, then retry."
      ),
      check(
        name: "accessibility",
        passed: accessibilityReady,
        pass: "AXUIElement trust and a live focused-application query succeeded.",
        fail: "Accessibility permission or the live AXUIElement query is unavailable.",
        remediation: "Grant Accessibility to the signed OpenDelegate helper, then retry."
      ),
      check(
        name: "input",
        passed: postEventAllowed && accessibilityTrusted && !secureInput,
        pass: "CGEvent posting is permitted and Secure Event Input is inactive.",
        fail: "CGEvent permission is missing or Secure Event Input is active.",
        remediation: "Grant Input control and leave password or other secure-input fields."
      ),
      check(
        name: "helper-authentication",
        passed: binding.authentication == "adr-0011-hmac-sha256",
        pass: "The private child is bound to its authenticated session-helper identity and epoch.",
        fail: "The parent helper session binding is invalid.",
        remediation: "Restart and re-authenticate the OpenDelegate session helper."
      ),
    ]
    return .object([
      "osFamily": .string("macos"),
      "backendId": .string(backendId),
      "helperInstanceId": .string(binding.helperInstanceId),
      "serviceEpoch": .int(binding.serviceEpoch),
      "displayFingerprint": displayFingerprint.map(JSONValue.string) ?? .null,
      "checks": .array(checks),
    ])
  }

  private func observe(_ execution: WireExecutionContext) throws -> JSONValue {
    try validate(execution, requireInput: false)
    let elements = try accessibilityElements()
    try validate(execution, requireInput: false)
    let tree = elements.compactMap(controlValue)
    var result: [String: JSONValue] = [
      "displayFingerprint": .string(execution.expectedDisplayFingerprint),
      "accessibilityTree": .array(tree),
    ]
    if let fixture = fixtureValue(elements) {
      result["fixture"] = fixture
    }
    return .object(result)
  }

  private func act(
    _ execution: WireExecutionContext,
    action: WireAction
  ) async throws -> JSONValue {
    try validate(execution, requireInput: true)
    let matches = try accessibilityElements().filter { $0.controlId == action.controlId }
    guard matches.count == 1, let target = matches.first else {
      throw NativeFailure(code: .unavailable)
    }
    try await focus(target)
    try validate(execution, requireInput: true)

    switch action.kind {
    case .click:
      try postClick(target, execution: execution)
    case .typeText:
      guard let text = action.text else {
        throw NativeFailure(code: .unavailable)
      }
      try await postText(text, target: target, execution: execution)
    }
    try validate(execution, requireInput: true)
    actionSequence += 1
    return .object([
      "displayFingerprint": .string(execution.expectedDisplayFingerprint),
      "sequence": .int(actionSequence),
    ])
  }

  private func validate(_ execution: WireExecutionContext, requireInput: Bool) throws {
    switch stops.status(for: execution.executionHandleId) {
    case .active:
      break
    case .cancelled:
      throw NativeFailure(code: .cancelled)
    case .emergencyStopped:
      throw NativeFailure(code: .emergencyStopped)
    }
    guard
      execution.helperInstanceId == binding.helperInstanceId,
      execution.serviceEpoch == binding.serviceEpoch
    else {
      throw NativeFailure(code: .helperCrashed)
    }
    guard monitor.interactive, monitor.safelyUnlocked else {
      throw NativeFailure(code: .sessionLocked)
    }
    guard currentDesktopFingerprint() == execution.expectedDisplayFingerprint else {
      throw NativeFailure(code: .displayChanged)
    }
    guard AXIsProcessTrusted() else {
      throw NativeFailure(code: .permissionDenied)
    }
    if requireInput {
      guard CGPreflightPostEventAccess(), !IsSecureEventInputEnabled() else {
        throw NativeFailure(code: .permissionDenied)
      }
    }
  }

  private func accessibilityElements() throws -> [AccessibleElement] {
    guard AXIsProcessTrusted() else {
      throw NativeFailure(code: .permissionDenied)
    }
    var found: [AccessibleElement] = []
    var visited = 0
    for application in NSWorkspace.shared.runningApplications
    where !application.isTerminated && application.processIdentifier > 0 {
      let root = AXUIElementCreateApplication(application.processIdentifier)
      var queue: [(AXUIElement, Int)] = [(root, 0)]
      while !queue.isEmpty && visited < maximumAccessibilityNodes {
        let (element, depth) = queue.removeFirst()
        visited += 1
        if let control = accessibleElement(element, processId: application.processIdentifier) {
          found.append(control)
        }
        if depth >= maximumAccessibilityDepth {
          continue
        }
        for child in children(of: element) {
          queue.append((child, depth + 1))
        }
      }
      if visited >= maximumAccessibilityNodes {
        break
      }
    }
    return found
  }

  private func focus(_ target: AccessibleElement) async throws {
    _ = NSRunningApplication(processIdentifier: target.processId)?.activate(
      options: [.activateIgnoringOtherApps]
    )
    var activated = false
    for _ in 0..<40 {
      if NSWorkspace.shared.frontmostApplication?.processIdentifier == target.processId {
        activated = true
        break
      }
      try await Task.sleep(nanoseconds: 25_000_000)
    }
    guard activated else {
      throw NativeFailure(code: .unavailable)
    }
    let result = AXUIElementSetAttributeValue(
      target.element,
      kAXFocusedAttribute as CFString,
      kCFBooleanTrue
    )
    guard result == .success || result == .attributeUnsupported else {
      throw NativeFailure(code: .unavailable)
    }
  }

  private func postClick(
    _ target: AccessibleElement,
    execution: WireExecutionContext
  ) throws {
    guard let point = center(of: target.element) else {
      let result = AXUIElementPerformAction(target.element, kAXPressAction as CFString)
      guard result == .success else {
        throw NativeFailure(code: .unavailable)
      }
      return
    }
    try validate(execution, requireInput: true)
    guard let source = CGEventSource(stateID: .hidSystemState),
      let moved = CGEvent(
        mouseEventSource: source,
        mouseType: .mouseMoved,
        mouseCursorPosition: point,
        mouseButton: .left
      ),
      let down = CGEvent(
        mouseEventSource: source,
        mouseType: .leftMouseDown,
        mouseCursorPosition: point,
        mouseButton: .left
      ),
      let up = CGEvent(
        mouseEventSource: source,
        mouseType: .leftMouseUp,
        mouseCursorPosition: point,
        mouseButton: .left
      )
    else {
      throw NativeFailure(code: .unavailable)
    }
    moved.post(tap: .cghidEventTap)
    try validate(execution, requireInput: true)
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
  }

  private func postText(
    _ text: String,
    target: AccessibleElement,
    execution: WireExecutionContext
  ) async throws {
    if let point = center(of: target.element) {
      try validate(execution, requireInput: true)
      guard let source = CGEventSource(stateID: .hidSystemState),
        let down = CGEvent(
          mouseEventSource: source,
          mouseType: .leftMouseDown,
          mouseCursorPosition: point,
          mouseButton: .left
        ),
        let up = CGEvent(
          mouseEventSource: source,
          mouseType: .leftMouseUp,
          mouseCursorPosition: point,
          mouseButton: .left
        )
      else {
        throw NativeFailure(code: .unavailable)
      }
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
    }
    let utf16 = Array(text.utf16)
    guard let source = CGEventSource(stateID: .hidSystemState) else {
      throw NativeFailure(code: .unavailable)
    }
    var offset = 0
    while offset < utf16.count {
      try validate(execution, requireInput: true)
      let end = min(offset + 32, utf16.count)
      let chunk = Array(utf16[offset..<end])
      guard
        let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
      else {
        throw NativeFailure(code: .unavailable)
      }
      chunk.withUnsafeBufferPointer {
        down.keyboardSetUnicodeString(
          stringLength: $0.count,
          unicodeString: $0.baseAddress
        )
        up.keyboardSetUnicodeString(
          stringLength: $0.count,
          unicodeString: $0.baseAddress
        )
      }
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
      offset = end
      await Task.yield()
    }
  }

  private func captureScreen() async throws -> CapturedPng {
    guard CGPreflightScreenCaptureAccess(), monitor.interactive, monitor.safelyUnlocked else {
      throw NativeFailure(code: .permissionDenied)
    }
    guard let fingerprint = currentDesktopFingerprint() else {
      throw NativeFailure(code: .unavailable)
    }
    let shareable = try await SCShareableContent.excludingDesktopWindows(
      false,
      onScreenWindowsOnly: true
    )
    let mainId = CGMainDisplayID()
    guard
      let display = shareable.displays.first(where: { $0.displayID == mainId })
        ?? shareable.displays.first
    else {
      throw NativeFailure(code: .unavailable)
    }
    let configuration = SCStreamConfiguration()
    guard
      display.width > 0,
      display.height > 0,
      display.width <= maximumCaptureDimension,
      display.height <= maximumCaptureDimension
    else {
      throw NativeFailure(code: .unavailable)
    }
    configuration.width = max(Int(display.width), 1)
    configuration.height = max(Int(display.height), 1)
    configuration.showsCursor = true
    configuration.scalesToFit = false
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: filter,
      configuration: configuration
    )
    let bytes = try pngData(image)
    guard currentDesktopFingerprint() == fingerprint else {
      throw NativeFailure(code: .displayChanged)
    }
    return CapturedPng(
      displayFingerprint: fingerprint,
      width: image.width,
      height: image.height,
      bytes: bytes
    )
  }

  private func currentDesktopFingerprint() -> String? {
    return currentDisplayFingerprint(generation: monitor.generation)
  }

  private func fixtureValue(_ elements: [AccessibleElement]) -> JSONValue? {
    guard
      let runId = elements.first(where: { $0.controlId == "fixture-run-id" })?.value,
      let text = elements.first(where: { $0.controlId == "task-text" })?.value,
      let status = elements.first(where: { $0.controlId == "fixture-status" })?.value
    else {
      return nil
    }
    let state = status.hasPrefix("Success") ? "success" : "editing"
    let alpha = elements.first(where: { $0.controlId == "option-alpha" })?.selected == true
    let beta = elements.first(where: { $0.controlId == "option-beta" })?.selected == true
    let selected: JSONValue =
      alpha ? .string("Alpha") : beta ? .string("Beta") : .null
    var object: [String: JSONValue] = [
      "runIdentifier": .string(runId),
      "state": .string(state),
      "textValue": .string(text),
      "selectedOption": selected,
      "resultFile": .null,
    ]
    if state == "success", let result = fixtureResult(runIdentifier: runId) {
      object["resultFile"] = result
    }
    return .object(object)
  }

  private func fixtureResult(runIdentifier: String) -> JSONValue? {
    guard let root = fixtureResultDirectory else {
      return nil
    }
    guard let filename = try? fixtureResultFilename(runIdentifier: runIdentifier) else {
      return nil
    }
    let url = root.appendingPathComponent(filename, isDirectory: false).standardizedFileURL
    guard url.deletingLastPathComponent() == root else {
      return nil
    }
    let resolved = url.resolvingSymlinksInPath()
    guard resolved == url,
      let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
      attributes[.type] as? FileAttributeType == .typeRegular,
      let size = attributes[.size] as? NSNumber,
      size.intValue > 0,
      size.intValue <= maximumFixtureResultBytes,
      let data = try? Data(contentsOf: url, options: [.mappedIfSafe]),
      data.count == size.intValue
    else {
      return nil
    }
    return .object([
      "filename": .string(filename),
      "mediaType": .string("application/json"),
      "bytesBase64": .string(data.base64EncodedString()),
    ])
  }
}

private func check(
  name: String,
  passed: Bool,
  pass: String,
  fail: String,
  remediation: String
) -> JSONValue {
  var value: [String: JSONValue] = [
    "name": .string(name),
    "status": .string(passed ? "pass" : "fail"),
    "evidence": .string(passed ? pass : fail),
  ]
  if !passed {
    value["remediation"] = .string(remediation)
  }
  return .object(value)
}

private func captureValue(_ capture: CapturedPng) -> JSONValue {
  return .object([
    "displayFingerprint": .string(capture.displayFingerprint),
    "mediaType": .string("image/png"),
    "width": .int(capture.width),
    "height": .int(capture.height),
    "bytesBase64": .string(capture.bytes.base64EncodedString()),
  ])
}

private func accessibleElement(
  _ element: AXUIElement,
  processId: pid_t
) -> AccessibleElement? {
  guard
    let rawIdentifier = copyString(element, kAXIdentifierAttribute as CFString),
    let identifier = safeIdentifier(rawIdentifier)
  else {
    return nil
  }
  let role = copyString(element, kAXRoleAttribute as CFString) ?? ""
  let rawLabel =
    copyString(element, kAXDescriptionAttribute as CFString)
    ?? copyString(element, kAXTitleAttribute as CFString)
    ?? copyString(element, kAXHelpAttribute as CFString)
    ?? identifier
  let value = copyValue(element, kAXValueAttribute as CFString)
  let selected: Bool?
  if let number = value as? NSNumber {
    selected = number.boolValue
  } else {
    selected = nil
  }
  return AccessibleElement(
    element: element,
    processId: processId,
    controlId: identifier,
    role: role,
    label: safeLabel(rawLabel, fallback: identifier),
    value: (value as? String).map {
      utf8Prefix(withoutControlCharacters($0), maximumBytes: 4_096)
    },
    selected: selected
  )
}

private func controlValue(_ item: AccessibleElement) -> JSONValue? {
  let role: String
  switch item.role {
  case kAXButtonRole as String:
    role = "button"
  case kAXRadioButtonRole as String:
    role = "radio"
  case kAXTextFieldRole as String, kAXTextAreaRole as String:
    role = "textbox"
  default:
    return nil
  }
  var object: [String: JSONValue] = [
    "controlId": .string(item.controlId),
    "role": .string(role),
    "label": .string(item.label),
  ]
  if let value = item.value {
    object["value"] = .string(value)
  }
  if let selected = item.selected {
    object["selected"] = .bool(selected)
  }
  return .object(object)
}

private func safeIdentifier(_ value: String) -> String? {
  guard
    !value.isEmpty,
    value == value.trimmingCharacters(in: .whitespacesAndNewlines),
    value.utf8.count <= 256,
    value.unicodeScalars.allSatisfy({
      !CharacterSet.controlCharacters.contains($0)
    })
  else {
    return nil
  }
  return value
}

private func safeLabel(_ value: String, fallback: String) -> String {
  let trimmed = withoutControlCharacters(value)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  let bounded = utf8Prefix(trimmed, maximumBytes: 256)
  return bounded.isEmpty ? fallback : bounded
}

private func withoutControlCharacters(_ value: String) -> String {
  return value.unicodeScalars.map { scalar in
    CharacterSet.controlCharacters.contains(scalar) ? " " : String(scalar)
  }.joined()
}

private func utf8Prefix(_ value: String, maximumBytes: Int) -> String {
  var result = ""
  var byteCount = 0
  for character in value {
    let bytes = String(character).utf8.count
    if byteCount + bytes > maximumBytes {
      break
    }
    result.append(character)
    byteCount += bytes
  }
  return result
}

private func children(of element: AXUIElement) -> [AXUIElement] {
  guard let value = copyValue(element, kAXChildrenAttribute as CFString) else {
    return []
  }
  return value as? [AXUIElement] ?? []
}

private func copyString(_ element: AXUIElement, _ attribute: CFString) -> String? {
  return copyValue(element, attribute) as? String
}

private func copyValue(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else {
    return nil
  }
  return value
}

private func center(of element: AXUIElement) -> CGPoint? {
  guard
    let positionValue = copyValue(element, kAXPositionAttribute as CFString),
    let sizeValue = copyValue(element, kAXSizeAttribute as CFString),
    CFGetTypeID(positionValue) == AXValueGetTypeID(),
    CFGetTypeID(sizeValue) == AXValueGetTypeID()
  else {
    return nil
  }
  let positionAx = unsafeBitCast(positionValue, to: AXValue.self)
  let sizeAx = unsafeBitCast(sizeValue, to: AXValue.self)
  guard AXValueGetType(positionAx) == .cgPoint, AXValueGetType(sizeAx) == .cgSize else {
    return nil
  }
  var position = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(positionAx, .cgPoint, &position),
    AXValueGetValue(sizeAx, .cgSize, &size),
    size.width > 0,
    size.height > 0
  else {
    return nil
  }
  return CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
}

private func currentDisplayFingerprint(generation: Int) -> String? {
  var count: UInt32 = 0
  guard CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0, count <= 32 else {
    return nil
  }
  var identifiers = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetOnlineDisplayList(count, &identifiers, &count) == .success else {
    return nil
  }
  let displays = identifiers.prefix(Int(count)).sorted().map { identifier -> String in
    let bounds = CGDisplayBounds(identifier)
    return [
      String(identifier),
      String(format: "%.3f", bounds.origin.x),
      String(format: "%.3f", bounds.origin.y),
      String(format: "%.3f", bounds.width),
      String(format: "%.3f", bounds.height),
      String(CGDisplayPixelsWide(identifier)),
      String(CGDisplayPixelsHigh(identifier)),
      CGDisplayIsMain(identifier) != 0 ? "main" : "secondary",
    ].joined(separator: ":")
  }.joined(separator: "|")
  let canonical = "desktop-generation:\(generation)|\(displays)"
  let digest = SHA256.hash(data: Data(canonical.utf8))
  return "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
}

private func pngData(_ image: CGImage) throws -> Data {
  let output = NSMutableData()
  guard
    let destination = CGImageDestinationCreateWithData(
      output,
      UTType.png.identifier as CFString,
      1,
      nil
    )
  else {
    throw NativeFailure(code: .unavailable)
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard
    CGImageDestinationFinalize(destination),
    output.length > 8,
    output.length <= maximumCapturePngBytes
  else {
    throw NativeFailure(code: .unavailable)
  }
  let data = output as Data
  guard data.prefix(8) == Data([137, 80, 78, 71, 13, 10, 26, 10]) else {
    throw NativeFailure(code: .unavailable)
  }
  return data
}
#endif
