import Darwin
import Foundation
import Security

private let maximumSecretBytes = 1_048_576
private let maximumBindingBytes = 16_384
private let conflictExit: Int32 = 10
private let unavailableExit: Int32 = 11
private let invalidExit: Int32 = 12
private let failureExit: Int32 = 13
private let systemKeychainPath = "/Library/Keychains/System.keychain"
private let bindingRoot = "/Library/Application Support/OpenDelegate/"
private let privilegedHelperRoot = "/Library/PrivilegedHelperTools/"
private let readinessAccount = "opendelegate/system-keychain-readiness/v1"

private struct SystemBinding: Codable, Equatable {
  let schemaVersion: Int
  let keychainPath: String
  let keychainService: String
  let serviceUser: String
  let trustedHelperPath: String
}

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

private func validServiceUser(_ value: String) -> Bool {
  return value.range(of: "^_?[A-Za-z][A-Za-z0-9_-]{0,30}$", options: .regularExpression) != nil
}

private func validKeychainService(_ value: String) -> Bool {
  return value.range(
    of: "^io\\.opendelegate\\.secret\\.[0-9a-f]{32}$",
    options: .regularExpression
  ) != nil
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

private func canonicalPath(_ value: String) -> String? {
  guard value.hasPrefix("/"), !value.contains("\0"), !value.contains("\n") else {
    return nil
  }
  return URL(fileURLWithPath: value).resolvingSymlinksInPath().standardizedFileURL.path
}

private func currentExecutablePath() -> String {
  var size: UInt32 = 0
  _NSGetExecutablePath(nil, &size)
  var bytes = [CChar](repeating: 0, count: Int(size))
  guard _NSGetExecutablePath(&bytes, &size) == 0 else {
    terminate(failureExit)
  }
  let value = String(cString: bytes)
  guard let canonical = canonicalPath(value) else {
    terminate(failureExit)
  }
  return canonical
}

private func currentUserName() -> String? {
  guard let record = getpwuid(geteuid()), let name = record.pointee.pw_name else {
    return nil
  }
  return String(cString: name)
}

private func ownerLoginKeychain() -> SecKeychain {
  var keychain: SecKeychain?
  let status = SecKeychainCopyDefault(&keychain)
  guard status == errSecSuccess, let keychain else {
    terminate(failureExit)
  }
  return keychain
}

private func openSystemKeychain() -> SecKeychain {
  var keychain: SecKeychain?
  let status = SecKeychainOpen(systemKeychainPath, &keychain)
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

private func trustedAccess(path: String, descriptor: String) -> SecAccess {
  var application: SecTrustedApplication?
  let applicationStatus = SecTrustedApplicationCreateFromPath(path, &application)
  guard applicationStatus == errSecSuccess, let application else {
    terminate(failureExit)
  }
  var access: SecAccess?
  let accessStatus = SecAccessCreate(
    descriptor as CFString,
    [application] as CFArray,
    &access
  )
  guard accessStatus == errSecSuccess, let access else {
    terminate(failureExit)
  }
  return access
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

private func requireRegularRootOwnedBinding(_ path: String) -> Data {
  guard path.hasPrefix(bindingRoot), let canonical = canonicalPath(path), canonical == path else {
    terminate(invalidExit)
  }
  var metadata = stat()
  guard lstat(path, &metadata) == 0,
    (metadata.st_mode & S_IFMT) == S_IFREG,
    metadata.st_nlink == 1,
    metadata.st_uid == 0,
    (metadata.st_mode & (S_IWGRP | S_IWOTH)) == 0,
    metadata.st_size > 0,
    metadata.st_size <= maximumBindingBytes
  else {
    terminate(failureExit)
  }
  guard let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: .mappedIfSafe),
    data.count == metadata.st_size
  else {
    terminate(failureExit)
  }
  return data
}

private func loadSystemBinding(_ path: String) -> SystemBinding {
  let data = requireRegularRootOwnedBinding(path)
  guard let binding = try? JSONDecoder().decode(SystemBinding.self, from: data),
    binding.schemaVersion == 1,
    binding.keychainPath == systemKeychainPath,
    validKeychainService(binding.keychainService),
    validServiceUser(binding.serviceUser),
    binding.trustedHelperPath.hasPrefix(privilegedHelperRoot),
    canonicalPath(binding.trustedHelperPath) == binding.trustedHelperPath,
    currentExecutablePath() == binding.trustedHelperPath,
    geteuid() == 0 || currentUserName() == binding.serviceUser
  else {
    terminate(failureExit)
  }
  return binding
}

private func createParentDirectories(_ path: String) {
  let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
  do {
    try FileManager.default.createDirectory(
      atPath: parent,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o755]
    )
  } catch {
    terminate(failureExit)
  }
}

private func installStableHelper(_ target: String) {
  guard geteuid() == 0,
    target.hasPrefix(privilegedHelperRoot),
    canonicalPath(target) == target,
    URL(fileURLWithPath: target).lastPathComponent.hasPrefix("opendelegate-keychain-helper-")
  else {
    terminate(invalidExit)
  }
  let source = currentExecutablePath()
  guard let sourceData = try? Data(contentsOf: URL(fileURLWithPath: source)), !sourceData.isEmpty else {
    terminate(failureExit)
  }
  createParentDirectories(target)
  if FileManager.default.fileExists(atPath: target) {
    guard canonicalPath(target) == target,
      let targetData = try? Data(contentsOf: URL(fileURLWithPath: target)),
      targetData == sourceData
    else {
      terminate(conflictExit)
    }
    guard chmod(target, 0o755) == 0, chown(target, 0, 0) == 0 else {
      terminate(failureExit)
    }
    return
  }
  let temporary = "\(target).tmp.\(UUID().uuidString)"
  do {
    try sourceData.write(to: URL(fileURLWithPath: temporary), options: .withoutOverwriting)
  } catch {
    terminate(failureExit)
  }
  guard chmod(temporary, 0o755) == 0,
    chown(temporary, 0, 0) == 0,
    rename(temporary, target) == 0
  else {
    _ = unlink(temporary)
    terminate(failureExit)
  }
}

private func writeSystemBinding(_ binding: SystemBinding, path: String) {
  guard geteuid() == 0, path.hasPrefix(bindingRoot), canonicalPath(path) == path else {
    terminate(invalidExit)
  }
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  guard var data = try? encoder.encode(binding) else {
    terminate(failureExit)
  }
  data.append(0x0a)
  createParentDirectories(path)
  if FileManager.default.fileExists(atPath: path) {
    let existing = requireRegularRootOwnedBinding(path)
    guard existing == data else {
      terminate(conflictExit)
    }
    return
  }
  let temporary = "\(path).tmp.\(UUID().uuidString)"
  do {
    try data.write(to: URL(fileURLWithPath: temporary), options: .withoutOverwriting)
  } catch {
    terminate(failureExit)
  }
  guard chmod(temporary, 0o644) == 0,
    chown(temporary, 0, 0) == 0,
    rename(temporary, path) == 0
  else {
    _ = unlink(temporary)
    terminate(failureExit)
  }
}

private func prepareSystemBinding(arguments: [String]) {
  guard geteuid() == 0,
    arguments.count == 12,
    arguments[2] == "--binding",
    arguments[4] == "--service-user",
    arguments[6] == "--trusted-helper",
    arguments[8] == "--service",
    arguments[10] == "--keychain"
  else {
    terminate(invalidExit)
  }
  let bindingPath = arguments[3]
  let serviceUser = arguments[5]
  let trustedHelperPath = arguments[7]
  let service = arguments[9]
  let keychainPath = arguments[11]
  guard bindingPath.hasPrefix(bindingRoot),
    trustedHelperPath.hasPrefix(privilegedHelperRoot),
    validServiceUser(serviceUser),
    validKeychainService(service),
    keychainPath == systemKeychainPath
  else {
    terminate(invalidExit)
  }

  installStableHelper(trustedHelperPath)
  let binding = SystemBinding(
    schemaVersion: 1,
    keychainPath: keychainPath,
    keychainService: service,
    serviceUser: serviceUser,
    trustedHelperPath: trustedHelperPath
  )
  let keychain = openSystemKeychain()
  let access = trustedAccess(
    path: trustedHelperPath,
    descriptor: "OpenDelegate persistent Device Secret readiness"
  )
  let query = baseQuery(keychain: keychain, service: service, account: readinessAccount)
  let attributes: [CFString: Any] = [
    kSecValueData: Data("ready".utf8),
    kSecAttrAccess: access,
  ]
  var create = query
  for (key, value) in attributes {
    create[key] = value
  }
  let createStatus = SecItemAdd(create as CFDictionary, nil)
  if createStatus == errSecDuplicateItem {
    let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    guard updateStatus == errSecSuccess else {
      terminate(failureExit)
    }
  } else if createStatus != errSecSuccess {
    terminate(failureExit)
  }
  writeSystemBinding(binding, path: bindingPath)
  writeReady()
  terminate(0)
}

private let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
  terminate(invalidExit)
}

private let operation = arguments[1]
if operation == "prepare-system-binding" {
  prepareSystemBinding(arguments: arguments)
}

private let systemMode = arguments.count >= 4 && arguments[2] == "--system-binding"
private let binding: SystemBinding? = systemMode ? loadSystemBinding(arguments[3]) : nil
if systemMode {
  _ = SecKeychainSetUserInteractionAllowed(false)
}
private let keychain = systemMode ? openSystemKeychain() : ownerLoginKeychain()

if operation == "status" {
  if systemMode {
    guard arguments.count == 6, arguments[4] == "--service",
      arguments[5] == binding?.keychainService
    else {
      terminate(invalidExit)
    }
    var query = baseQuery(
      keychain: keychain,
      service: arguments[5],
      account: readinessAccount
    )
    query[kSecReturnData] = kCFBooleanTrue
    query[kSecMatchLimit] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data,
      data == Data("ready".utf8)
    else {
      terminate(failureExit)
    }
  } else {
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
  }
  writeReady()
  terminate(0)
}

private let serviceIndex = systemMode ? 4 : 2
guard arguments.count == serviceIndex + 4,
  arguments[serviceIndex] == "--service",
  arguments[serviceIndex + 2] == "--account"
else {
  terminate(invalidExit)
}

private let service = arguments[serviceIndex + 1]
private let account = arguments[serviceIndex + 3]
guard validIdentifier(service), validIdentifier(account),
  binding == nil || binding?.keychainService == service
else {
  terminate(invalidExit)
}

private var query = baseQuery(keychain: keychain, service: service, account: account)

switch operation {
case "create":
  var secret = readBoundedSecret()
  defer { secret.resetBytes(in: 0..<secret.count) }
  query[kSecValueData] = secret
  if let binding {
    query[kSecAttrAccess] = trustedAccess(
      path: binding.trustedHelperPath,
      descriptor: "OpenDelegate persistent Device Secret"
    )
  }
  let status = SecItemAdd(query as CFDictionary, nil)
  guard status == errSecSuccess else {
    mapStatus(status, conflictIsDistinct: true)
  }
case "rotate":
  var secret = readBoundedSecret()
  defer { secret.resetBytes(in: 0..<secret.count) }
  var attributes: [CFString: Any] = [kSecValueData: secret]
  if let binding {
    attributes[kSecAttrAccess] = trustedAccess(
      path: binding.trustedHelperPath,
      descriptor: "OpenDelegate persistent Device Secret"
    )
  }
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
