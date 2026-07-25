import Foundation

public struct HelperBinding: Codable, Equatable, Sendable {
  public var authentication: String
  public var helperInstanceId: String
  public var osSessionIdentity: String
  public var releaseVersion: String
  public var serviceEpoch: Int

  public init(
    authentication: String,
    helperInstanceId: String,
    osSessionIdentity: String,
    releaseVersion: String,
    serviceEpoch: Int
  ) {
    self.authentication = authentication
    self.helperInstanceId = helperInstanceId
    self.osSessionIdentity = osSessionIdentity
    self.releaseVersion = releaseVersion
    self.serviceEpoch = serviceEpoch
  }
}

public enum WireOperation: String, Codable, Sendable {
  case act
  case cancel
  case capture
  case emergencyStop = "emergency-stop"
  case observe
  case probe
}

public struct WireExecutionContext: Codable, Equatable, Sendable {
  public let executionHandleId: String
  public let taskId: String
  public let deviceId: String
  public let runId: String
  public let helperInstanceId: String
  public let serviceEpoch: Int
  public let persistenceGeneration: Int
  public let leaseId: String
  public let fencingToken: Int
  public let expectedDisplayFingerprint: String
}

public struct WireControlContext: Codable, Equatable, Sendable {
  public let executionHandleId: String
  public let taskId: String
  public let deviceId: String
  public let runId: String
}

public enum WireActionKind: String, Codable, Sendable {
  case click
  case typeText = "type-text"
}

public struct WireAction: Codable, Equatable, Sendable {
  public let kind: WireActionKind
  public let controlId: String
  public let text: String?
}

public struct WireRequest: Codable, Equatable, Sendable {
  public let protocolVersion: Int
  public let requestId: String
  public let sequence: Int
  public let binding: HelperBinding
  public let operation: WireOperation
  public let execution: WireExecutionContext?
  public let control: WireControlContext?
  public let action: WireAction?
}

public enum WireProtocolError: Error, Equatable, Sendable {
  case bindingMismatch
  case frameInvalid
  case frameTooLarge
  case requestInvalid
  case sequenceMismatch
}

public final class WireRequestDecoder: @unchecked Sendable {
  private let expectedBinding: HelperBinding
  private let maximumFrameBytes: Int
  private let lock = NSLock()
  private var expectedSequence = 1

  public init(expectedBinding: HelperBinding, maximumFrameBytes: Int = 16 * 1024 * 1024) {
    self.expectedBinding = expectedBinding
    self.maximumFrameBytes = maximumFrameBytes
  }

  public func decode(line: Data) throws -> WireRequest {
    guard !line.isEmpty else {
      throw WireProtocolError.frameInvalid
    }
    guard line.count <= maximumFrameBytes else {
      throw WireProtocolError.frameTooLarge
    }
    let object: Any
    do {
      object = try JSONSerialization.jsonObject(with: line)
    } catch {
      throw WireProtocolError.frameInvalid
    }
    guard let dictionary = object as? [String: Any] else {
      throw WireProtocolError.frameInvalid
    }
    let request: WireRequest
    do {
      request = try JSONDecoder().decode(WireRequest.self, from: line)
    } catch {
      throw WireProtocolError.requestInvalid
    }
    try validateShape(dictionary, request: request)
    try validateRequest(request)

    lock.lock()
    defer { lock.unlock() }
    guard request.sequence == expectedSequence else {
      throw WireProtocolError.sequenceMismatch
    }
    expectedSequence += 1
    return request
  }

  private func validateShape(_ dictionary: [String: Any], request: WireRequest) throws {
    var expected = Set([
      "protocolVersion",
      "requestId",
      "sequence",
      "binding",
      "operation",
    ])
    switch request.operation {
    case .probe:
      break
    case .observe, .capture:
      expected.insert("execution")
    case .act:
      expected.insert("execution")
      expected.insert("action")
    case .cancel, .emergencyStop:
      expected.insert("control")
    }
    guard Set(dictionary.keys) == expected else {
      throw WireProtocolError.requestInvalid
    }
    guard
      let binding = dictionary["binding"] as? [String: Any],
      exactKeys(
        binding,
        [
          "authentication",
          "helperInstanceId",
          "osSessionIdentity",
          "releaseVersion",
          "serviceEpoch",
        ]
      )
    else {
      throw WireProtocolError.requestInvalid
    }
    if request.execution != nil {
      guard
        let execution = dictionary["execution"] as? [String: Any],
        exactKeys(
          execution,
          [
            "executionHandleId",
            "taskId",
            "deviceId",
            "runId",
            "helperInstanceId",
            "serviceEpoch",
            "persistenceGeneration",
            "leaseId",
            "fencingToken",
            "expectedDisplayFingerprint",
          ]
        )
      else {
        throw WireProtocolError.requestInvalid
      }
    }
    if request.control != nil {
      guard
        let control = dictionary["control"] as? [String: Any],
        exactKeys(control, ["executionHandleId", "taskId", "deviceId", "runId"])
      else {
        throw WireProtocolError.requestInvalid
      }
    }
    if let action = request.action {
      guard let actionObject = dictionary["action"] as? [String: Any] else {
        throw WireProtocolError.requestInvalid
      }
      let actionKeys =
        action.kind == .typeText
        ? ["kind", "controlId", "text"]
        : ["kind", "controlId"]
      guard exactKeys(actionObject, actionKeys) else {
        throw WireProtocolError.requestInvalid
      }
    }
  }

  private func validateRequest(_ request: WireRequest) throws {
    guard
      request.protocolVersion == 1,
      request.binding == expectedBinding,
      request.binding.authentication == "adr-0011-hmac-sha256",
      request.binding.serviceEpoch > 0,
      validIdentifier(request.requestId),
      validIdentifier(request.binding.helperInstanceId),
      validIdentifier(request.binding.osSessionIdentity),
      validIdentifier(request.binding.releaseVersion)
    else {
      if request.binding != expectedBinding {
        throw WireProtocolError.bindingMismatch
      }
      throw WireProtocolError.requestInvalid
    }
    switch request.operation {
    case .probe:
      guard request.execution == nil, request.control == nil, request.action == nil else {
        throw WireProtocolError.requestInvalid
      }
    case .observe, .capture:
      guard
        let execution = request.execution,
        request.control == nil,
        request.action == nil,
        validExecution(execution)
      else {
        throw WireProtocolError.requestInvalid
      }
    case .act:
      guard
        let execution = request.execution,
        let action = request.action,
        request.control == nil,
        validExecution(execution),
        validAction(action)
      else {
        throw WireProtocolError.requestInvalid
      }
    case .cancel, .emergencyStop:
      guard
        let control = request.control,
        request.execution == nil,
        request.action == nil,
        validControl(control)
      else {
        throw WireProtocolError.requestInvalid
      }
    }
  }

  private func validExecution(_ context: WireExecutionContext) -> Bool {
    return
      validControl(
        WireControlContext(
          executionHandleId: context.executionHandleId,
          taskId: context.taskId,
          deviceId: context.deviceId,
          runId: context.runId
        )
      )
      && context.helperInstanceId == expectedBinding.helperInstanceId
      && context.serviceEpoch == expectedBinding.serviceEpoch
      && context.persistenceGeneration > 0
      && validIdentifier(context.leaseId)
      && context.fencingToken > 0
      && validIdentifier(context.expectedDisplayFingerprint)
  }

  private func validControl(_ context: WireControlContext) -> Bool {
    return
      validIdentifier(context.executionHandleId)
      && validIdentifier(context.taskId)
      && validIdentifier(context.deviceId)
      && validIdentifier(context.runId)
  }

  private func validAction(_ action: WireAction) -> Bool {
    guard validIdentifier(action.controlId) else {
      return false
    }
    switch action.kind {
    case .click:
      return action.text == nil
    case .typeText:
      guard let text = action.text else {
        return false
      }
      return !text.isEmpty && text.utf8.count <= 1_000_000
    }
  }
}

private func exactKeys(
  _ dictionary: [String: Any],
  _ expected: [String]
) -> Bool {
  return Set(dictionary.keys) == Set(expected)
}

public enum WireErrorCode: String, Codable, Sendable {
  case cancelled = "CANCELLED"
  case displayChanged = "DISPLAY_CHANGED"
  case emergencyStopped = "EMERGENCY_STOPPED"
  case helperCrashed = "HELPER_CRASHED"
  case permissionDenied = "PERMISSION_DENIED"
  case sessionLocked = "SESSION_LOCKED"
  case timeout = "TIMEOUT"
  case unavailable = "UNAVAILABLE"
}

public indirect enum JSONValue: Codable, Equatable, Sendable {
  case array([JSONValue])
  case bool(Bool)
  case int(Int)
  case null
  case object([String: JSONValue])
  case string(String)

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Int.self) {
      self = .int(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .array(let value):
      try container.encode(value)
    case .bool(let value):
      try container.encode(value)
    case .int(let value):
      try container.encode(value)
    case .null:
      try container.encodeNil()
    case .object(let value):
      try container.encode(value)
    case .string(let value):
      try container.encode(value)
    }
  }
}

public struct WireResponse: Codable, Equatable, Sendable {
  public struct Failure: Codable, Equatable, Sendable {
    public let code: WireErrorCode
  }

  public let protocolVersion: Int
  public let requestId: String
  public let sequence: Int
  public let binding: HelperBinding
  public let ok: Bool
  public let result: JSONValue?
  public let error: Failure?

  public static func success(for request: WireRequest, result: JSONValue) -> WireResponse {
    return WireResponse(
      protocolVersion: 1,
      requestId: request.requestId,
      sequence: request.sequence,
      binding: request.binding,
      ok: true,
      result: result,
      error: nil
    )
  }

  public static func failure(for request: WireRequest, code: WireErrorCode) -> WireResponse {
    return WireResponse(
      protocolVersion: 1,
      requestId: request.requestId,
      sequence: request.sequence,
      binding: request.binding,
      ok: false,
      result: nil,
      error: Failure(code: code)
    )
  }

  public func encodedLine() throws -> Data {
    var data = try JSONEncoder().encode(self)
    data.append(0x0A)
    return data
  }
}

public enum ExecutionStopStatus: Equatable, Sendable {
  case active
  case cancelled
  case emergencyStopped
}

public final class ExecutionStopRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private var statuses: [String: ExecutionStopStatus] = [:]

  public init() {}

  public func status(for executionHandleId: String) -> ExecutionStopStatus {
    lock.lock()
    defer { lock.unlock() }
    return statuses[executionHandleId] ?? .active
  }

  public func cancel(_ executionHandleId: String) {
    lock.lock()
    defer { lock.unlock() }
    guard statuses[executionHandleId] != .emergencyStopped else {
      return
    }
    statuses[executionHandleId] = .cancelled
  }

  public func emergencyStop(_ executionHandleId: String) {
    lock.lock()
    defer { lock.unlock() }
    statuses[executionHandleId] = .emergencyStopped
  }
}

private func validIdentifier(_ value: String) -> Bool {
  guard
    !value.isEmpty,
    value == value.trimmingCharacters(in: .whitespacesAndNewlines),
    value.utf8.count <= 256
  else {
    return false
  }
  return value.unicodeScalars.allSatisfy {
    !CharacterSet.controlCharacters.contains($0)
  }
}
