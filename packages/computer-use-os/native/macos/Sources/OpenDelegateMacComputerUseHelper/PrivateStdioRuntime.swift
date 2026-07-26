#if os(macOS)
import AppKit
import Darwin
import Dispatch
import Foundation
import OpenDelegateMacComputerUseProtocol

final class PrivateStdioRuntime: @unchecked Sendable {
  private let parentProcessId: pid_t
  private let driver: MacNativeComputerUseDriver
  private let stops: ExecutionStopRegistry
  private let decoder: WireRequestDecoder
  private let writer = LockedResponseWriter()
  private let executor = SerialRequestExecutor()
  private var parentExitSource: DispatchSourceProcess?

  init(
    binding: HelperBinding,
    parentProcessId: pid_t,
    driver: MacNativeComputerUseDriver,
    stops: ExecutionStopRegistry
  ) {
    self.parentProcessId = parentProcessId
    self.driver = driver
    self.stops = stops
    self.decoder = WireRequestDecoder(expectedBinding: binding)
  }

  func start() {
    let parent = DispatchSource.makeProcessSource(
      identifier: parentProcessId,
      eventMask: .exit,
      queue: .global(qos: .userInitiated)
    )
    parent.setEventHandler {
      _exit(0)
    }
    parentExitSource = parent
    parent.resume()

    DispatchQueue.global(qos: .userInitiated).async { [self] in
      readRequests()
    }
  }

  private func readRequests() {
    var buffered = Data()
    while true {
      let chunk = FileHandle.standardInput.readData(ofLength: 8_192)
      if chunk.isEmpty {
        _exit(0)
      }
      guard parentIsCurrent() else {
        _exit(77)
      }
      buffered.append(chunk)
      guard buffered.count <= 16 * 1024 * 1024 else {
        _exit(65)
      }
      while let newline = buffered.firstIndex(of: 0x0A) {
        let line = Data(buffered[..<newline])
        buffered.removeSubrange(...newline)
        let request: WireRequest
        do {
          request = try decoder.decode(line: line)
        } catch {
          _exit(65)
        }
        dispatch(request)
      }
    }
  }

  private func dispatch(_ request: WireRequest) {
    guard parentIsCurrent() else {
      _exit(77)
    }
    switch request.operation {
    case .cancel:
      guard let control = request.control else {
        _exit(65)
      }
      stops.cancel(control.executionHandleId)
      writer.write(.success(for: request, result: .object(["stopped": .bool(true)])))
    case .emergencyStop:
      guard let control = request.control else {
        _exit(65)
      }
      stops.emergencyStop(control.executionHandleId)
      writer.write(.success(for: request, result: .object(["stopped": .bool(true)])))
    case .probe, .observe, .capture, .act:
      executor.submit { [driver, writer] in
        let response = await driver.handle(request)
        writer.write(response)
      }
    }
  }

  private func parentIsCurrent() -> Bool {
    return getppid() == parentProcessId && kill(parentProcessId, 0) == 0
  }
}

private final class LockedResponseWriter: @unchecked Sendable {
  private let lock = NSLock()

  func write(_ response: WireResponse) {
    guard let data = try? response.encodedLine(), data.count <= 16 * 1024 * 1024 else {
      _exit(65)
    }
    lock.lock()
    defer { lock.unlock() }
    FileHandle.standardOutput.write(data)
  }
}

private final class SerialRequestExecutor: @unchecked Sendable {
  private let lock = NSLock()
  private var tail: Task<Void, Never>?

  func submit(_ operation: @escaping @Sendable () async -> Void) {
    lock.lock()
    let previous = tail
    let next = Task {
      await previous?.value
      await operation()
    }
    tail = next
    lock.unlock()
  }
}
#endif
