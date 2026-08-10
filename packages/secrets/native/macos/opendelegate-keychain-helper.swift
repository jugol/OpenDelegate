import Darwin
import Foundation
import Security

private let maximumSecretBytes = 1_048_576
private let conflictExit: Int32 = 10
private let unavailableExit: Int32 = 11
private let invalidExit: Int32 = 12
private let failureExit: Int32 = 13

@inline(__always)
private func terminate(_ code: Int32) -> Never {
  fflush(stdout)
  fflush(stderr)
  exit(code)
}

private func writeReady() {
  FileHandle.standardOutput.write(Data("ready".utf8))
}

private func validIdentifier(_ value: String) -> Bool {
  guard !value.isEmpty, value.utf8.count <= 256,
    value == value.trimmingCharacters(in: .whitespacesAndNewlines)
  else {
    return false
  }
  return value.unicodeScalars.allSatisfy {
    !CharacterSet.controlCharacters.contains($0)
  }
}

private func readBoundedSecret() -> Data {
  var result = Data()
  while true {
    let chunk = FileHandle.standardInput.readData(ofLength: 8_192)
    if chunk.isEmpty {
      break
    }
    if result.count > maximumSecretBytes - chunk.count {
      result.resetBytes(in: 0..<result.count)
      terminate(invalidExit)
    }
    result.append(chunk)
  }
  if result.isEmpty {
    terminate(invalidExit)
  }
  return result
}

private func ownerLoginKeychain() -> SecKeychain {
  var keychain: SecKeychain?
  let status = SecKeychainCopyDefault(&keychain)
  guard status == errSecSuccess, let keychain else {
    terminate(failureExit)
  }
  return keychain
}

private func baseQuery(
  keychain: SecKeychain,
  service: String,
  account: String
) -> [CFString: Any] {
  return [
    kSecClass: kSecClassGenericPassword,
    kSecAttrService: service,
    kSecAttrAccount: account,
    kSecAttrSynchronizable: kCFBooleanFalse as Any,
    kSecUseKeychain: keychain,
  ]
}

private func mapStatus(_ status: OSStatus, conflictIsDistinct: Bool = false) -> Never {
  if status == errSecItemNotFound {
    terminate(unavailableExit)
  }
  if conflictIsDistinct && status == errSecDuplicateItem {
    terminate(conflictExit)
  }
  terminate(failureExit)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
  terminate(invalidExit)
}

let operation = arguments[1]
let keychain = ownerLoginKeychain()
if operation == "status" {
  guard arguments.count == 2 else {
    terminate(invalidExit)
  }
  let probeAccount = "backend-availability-\(UUID().uuidString)"
  var probe = baseQuery(
    keychain: keychain,
    service: "io.opendelegate.secret.health-probe",
    account: probeAccount
  )
  probe[kSecValueData] = Data("write-readiness-probe".utf8)
  let createStatus = SecItemAdd(probe as CFDictionary, nil)
  guard createStatus == errSecSuccess else {
    terminate(failureExit)
  }
  let deleteStatus = SecItemDelete(
    baseQuery(
      keychain: keychain,
      service: "io.opendelegate.secret.health-probe",
      account: probeAccount
    ) as CFDictionary
  )
  guard deleteStatus == errSecSuccess else {
    terminate(failureExit)
  }
  writeReady()
  terminate(0)
}

guard
  arguments.count == 6,
  arguments[2] == "--service",
  arguments[4] == "--account"
else {
  terminate(invalidExit)
}

let service = arguments[3]
let account = arguments[5]
guard validIdentifier(service), validIdentifier(account) else {
  terminate(invalidExit)
}

var query = baseQuery(keychain: keychain, service: service, account: account)

switch operation {
case "create":
  var secret = readBoundedSecret()
  defer { secret.resetBytes(in: 0..<secret.count) }
  query[kSecValueData] = secret
  let status = SecItemAdd(query as CFDictionary, nil)
  guard status == errSecSuccess else {
    mapStatus(status, conflictIsDistinct: true)
  }
case "rotate":
  var secret = readBoundedSecret()
  defer { secret.resetBytes(in: 0..<secret.count) }
  let attributes: [CFString: Any] = [kSecValueData: secret]
  let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
  guard status == errSecSuccess else {
    mapStatus(status)
  }
case "read":
  query[kSecReturnData] = kCFBooleanTrue
  query[kSecMatchLimit] = kSecMatchLimitOne
  var item: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &item)
  guard status == errSecSuccess else {
    mapStatus(status)
  }
  guard var secret = item as? Data, !secret.isEmpty, secret.count <= maximumSecretBytes else {
    terminate(failureExit)
  }
  FileHandle.standardOutput.write(secret)
  secret.resetBytes(in: 0..<secret.count)
case "has":
  query[kSecReturnAttributes] = kCFBooleanTrue
  query[kSecMatchLimit] = kSecMatchLimitOne
  var item: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &item)
  guard status == errSecSuccess else {
    mapStatus(status)
  }
  writeReady()
case "delete":
  let status = SecItemDelete(query as CFDictionary)
  guard status == errSecSuccess else {
    mapStatus(status)
  }
default:
  terminate(invalidExit)
}

terminate(0)
