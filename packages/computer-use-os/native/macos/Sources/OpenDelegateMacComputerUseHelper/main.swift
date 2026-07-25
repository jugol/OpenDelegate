import Foundation
import OpenDelegateMacComputerUseProtocol

#if os(macOS)
import AppKit
import ApplicationServices
import CoreGraphics
import Darwin

private enum CommandMode {
  case permissionStatus(request: Bool)
  case stdio(HelperProcessArguments)
}

private struct HelperProcessArguments {
  let binding: HelperBinding
  let parentProcessId: pid_t
  let fixtureResultDirectory: URL?
}

private func parseCommandLine() -> CommandMode? {
  let arguments = Array(CommandLine.arguments.dropFirst())
  if arguments == ["--permission-status"] {
    return .permissionStatus(request: false)
  }
  if arguments == ["--request-permissions"] {
    return .permissionStatus(request: true)
  }
  guard arguments.first == "--stdio-child" else {
    return nil
  }
  var values: [String: String] = [:]
  var index = 1
  while index < arguments.count {
    guard index + 1 < arguments.count else {
      return nil
    }
    let key = arguments[index]
    let value = arguments[index + 1]
    guard key.hasPrefix("--"), values[key] == nil else {
      return nil
    }
    values[key] = value
    index += 2
  }
  let required = Set([
    "--helper-instance-id",
    "--service-epoch",
    "--os-session-identity",
    "--release-version",
    "--parent-pid",
  ])
  guard Set(values.keys).subtracting(["--fixture-result-directory"]) == required,
    let helperInstanceId = values["--helper-instance-id"],
    let epochText = values["--service-epoch"],
    let serviceEpoch = Int(epochText),
    serviceEpoch > 0,
    let osSessionIdentity = values["--os-session-identity"],
    let releaseVersion = values["--release-version"],
    let parentText = values["--parent-pid"],
    let parent = Int32(parentText),
    parent > 0
  else {
    return nil
  }
  let fixtureRoot: URL?
  if let fixturePath = values["--fixture-result-directory"] {
    guard fixturePath.hasPrefix("/") else {
      return nil
    }
    let requested = URL(
      fileURLWithPath: fixturePath,
      isDirectory: true
    ).standardizedFileURL
    let resolved = requested.resolvingSymlinksInPath()
    guard
      requested.path == fixturePath,
      (try? resolved.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
    else {
      return nil
    }
    fixtureRoot = resolved
  } else {
    fixtureRoot = nil
  }
  return .stdio(
    HelperProcessArguments(
      binding: HelperBinding(
        authentication: "adr-0011-hmac-sha256",
        helperInstanceId: helperInstanceId,
        osSessionIdentity: osSessionIdentity,
        releaseVersion: releaseVersion,
        serviceEpoch: serviceEpoch
      ),
      parentProcessId: parent,
      fixtureResultDirectory: fixtureRoot
    )
  )
}

private func writePermissionStatus(request: Bool) -> Never {
  let accessibility: Bool
  let screenCapture: Bool
  let input: Bool
  if request {
    let prompt = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
    accessibility = AXIsProcessTrustedWithOptions(prompt)
    screenCapture = CGRequestScreenCaptureAccess()
    input = CGRequestPostEventAccess()
  } else {
    accessibility = AXIsProcessTrusted()
    screenCapture = CGPreflightScreenCaptureAccess()
    input = CGPreflightPostEventAccess()
  }
  let response: [String: Any] = [
    "accessibility": accessibility,
    "screenCapture": screenCapture,
    "input": input,
    "requested": request,
  ]
  if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
  }
  exit((accessibility && screenCapture && input) ? 0 : 2)
}

guard let mode = parseCommandLine() else {
  exit(64)
}

switch mode {
case .permissionStatus(let request):
  writePermissionStatus(request: request)
case .stdio(let arguments):
  guard getppid() == arguments.parentProcessId else {
    exit(77)
  }
  let application = NSApplication.shared
  application.setActivationPolicy(.accessory)
  let monitor = MacSessionMonitor()
  let stops = ExecutionStopRegistry()
  let driver = MacNativeComputerUseDriver(
    binding: arguments.binding,
    monitor: monitor,
    stops: stops,
    fixtureResultDirectory: arguments.fixtureResultDirectory
  )
  let runtime = PrivateStdioRuntime(
    binding: arguments.binding,
    parentProcessId: arguments.parentProcessId,
    driver: driver,
    stops: stops
  )
  runtime.start()
  application.run()
  exit(0)
}
#else
FileHandle.standardError.write(Data("macOS-only executable\n".utf8))
exit(78)
#endif
