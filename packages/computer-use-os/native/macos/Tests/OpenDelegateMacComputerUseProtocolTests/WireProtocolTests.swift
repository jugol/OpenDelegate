import Foundation
import Testing

@testable import OpenDelegateMacComputerUseProtocol

private let binding = HelperBinding(
  authentication: "adr-0011-hmac-sha256",
  helperInstanceId: "helper-aqua-501",
  osSessionIdentity: "aqua:501",
  releaseVersion: "0.1.0-alpha.1",
  serviceEpoch: 17
)

@Test
func acceptsOnlyStrictlySequencedRequestsForTheAuthenticatedParentBinding() throws {
  let decoder = WireRequestDecoder(expectedBinding: binding)
  let first = try decoder.decode(line: requestLine(sequence: 1, requestId: "request-1"))
  let second = try decoder.decode(line: requestLine(sequence: 2, requestId: "request-2"))

  #expect(first.operation == .probe)
  #expect(second.sequence == 2)
  #expect(
    throws: WireProtocolError.self,
    performing: {
      _ = try decoder.decode(line: requestLine(sequence: 2, requestId: "replay"))
    }
  )
}

@Test
func rejectsChangedHelperIdentityAndOversizedFrames() throws {
  let decoder = WireRequestDecoder(expectedBinding: binding, maximumFrameBytes: 1_024)
  var changed = binding
  changed.helperInstanceId = "replacement-helper"

  #expect(
    throws: WireProtocolError.self,
    performing: {
      _ = try decoder.decode(
        line: requestLine(sequence: 1, requestId: "replacement", binding: changed)
      )
    }
  )
  #expect(
    throws: WireProtocolError.self,
    performing: {
      _ = try decoder.decode(line: Data(repeating: 0x61, count: 1_025))
    }
  )
}

@Test
func keepsTypedTextAtTheActionBoundaryAndOmitsItFromFailureFrames() throws {
  let secret = "owner-private-password"
  let decoder = WireRequestDecoder(expectedBinding: binding)
  let request = try decoder.decode(
    line: requestLine(
      sequence: 1,
      requestId: "typed-input",
      operation: "act",
      execution: execution(),
      action: [
        "kind": "type-text",
        "controlId": "task-text",
        "text": secret,
      ]
    )
  )
  #expect(request.action?.text == secret)

  let encoded = try WireResponse.failure(
    for: request,
    code: .permissionDenied
  ).encodedLine()
  #expect(!String(decoding: encoded, as: UTF8.self).contains(secret))
  #expect(!String(decoding: encoded, as: UTF8.self).contains("stderr"))
}

@Test
func cancellationAndEmergencyStopAreStickyForOneExecutionHandle() {
  let stops = ExecutionStopRegistry()
  #expect(stops.status(for: "handle-1") == .active)
  stops.cancel("handle-1")
  stops.cancel("handle-1")
  #expect(stops.status(for: "handle-1") == .cancelled)

  stops.emergencyStop("handle-2")
  stops.emergencyStop("handle-2")
  #expect(stops.status(for: "handle-2") == .emergencyStopped)
  stops.cancel("handle-2")
  #expect(stops.status(for: "handle-2") == .emergencyStopped)
}

@Test
func fixtureResultContractUsesOneTraversalSafeRunScopedFilename() throws {
  #expect(
    try fixtureResultFilename(runIdentifier: "run-2026_07_25")
      == "fixture-result-run-2026_07_25.json"
  )
  #expect(
    throws: FixtureContractError.invalidRunIdentifier,
    performing: {
      _ = try fixtureResultFilename(runIdentifier: "../outside")
    }
  )
  #expect(
    throws: FixtureContractError.invalidRunIdentifier,
    performing: {
      _ = try fixtureResultFilename(runIdentifier: String(repeating: "a", count: 81))
    }
  )

  let record = FixtureResultRecord(
    runIdentifier: "run-2026_07_25",
    textValue: "release proof",
    selectedOption: .beta
  )
  let encoded = try JSONEncoder().encode(record)
  let decoded = try JSONDecoder().decode(FixtureResultRecord.self, from: encoded)
  #expect(decoded == record)
  #expect(decoded.state == .success)
}

@Test
func rejectsUnknownFieldsInsideSecurityRelevantNestedObjects() throws {
  let decoder = WireRequestDecoder(expectedBinding: binding)
  #expect(
    throws: WireProtocolError.requestInvalid,
    performing: {
      _ = try decoder.decode(
        line: requestLine(
          sequence: 1,
          requestId: "extra-binding",
          bindingExtras: ["unexpected": true]
        )
      )
    }
  )

  var changedExecution = execution()
  changedExecution["unexpected"] = true
  #expect(
    throws: WireProtocolError.requestInvalid,
    performing: {
      _ = try decoder.decode(
        line: requestLine(
          sequence: 1,
          requestId: "extra-execution",
          operation: "observe",
          execution: changedExecution
        )
      )
    }
  )
}

private func requestLine(
  sequence: Int,
  requestId: String,
  binding requestBinding: HelperBinding = binding,
  bindingExtras: [String: Any] = [:],
  operation: String = "probe",
  execution: [String: Any]? = nil,
  action: [String: Any]? = nil
) throws -> Data {
  var bindingObject = try jsonObject(requestBinding) as! [String: Any]
  for (key, value) in bindingExtras {
    bindingObject[key] = value
  }
  var object: [String: Any] = [
    "protocolVersion": 1,
    "requestId": requestId,
    "sequence": sequence,
    "binding": bindingObject,
    "operation": operation,
  ]
  if let execution {
    object["execution"] = execution
  }
  if let action {
    object["action"] = action
  }
  return try JSONSerialization.data(withJSONObject: object)
}

private func jsonObject<T: Encodable>(_ value: T) throws -> Any {
  let encoded = try JSONEncoder().encode(value)
  return try JSONSerialization.jsonObject(with: encoded)
}

private func execution() -> [String: Any] {
  return [
    "executionHandleId": "handle-1",
    "taskId": "task-1",
    "deviceId": "device-1",
    "runId": "run-1",
    "helperInstanceId": binding.helperInstanceId,
    "serviceEpoch": binding.serviceEpoch,
    "persistenceGeneration": 23,
    "leaseId": "lease-1",
    "fencingToken": 5,
    "expectedDisplayFingerprint": "display:fixture",
  ]
}
