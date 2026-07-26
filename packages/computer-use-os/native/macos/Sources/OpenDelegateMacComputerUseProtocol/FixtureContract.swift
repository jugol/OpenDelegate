import Foundation

public enum FixtureContractError: Error, Equatable, Sendable {
  case invalidRunIdentifier
}

public enum FixtureSelectedOption: String, Codable, Equatable, Sendable {
  case alpha = "Alpha"
  case beta = "Beta"
}

public enum FixtureResultState: String, Codable, Equatable, Sendable {
  case success
}

public struct FixtureResultRecord: Codable, Equatable, Sendable {
  public let runIdentifier: String
  public let textValue: String
  public let selectedOption: FixtureSelectedOption
  public let state: FixtureResultState

  public init(
    runIdentifier: String,
    textValue: String,
    selectedOption: FixtureSelectedOption
  ) {
    self.runIdentifier = runIdentifier
    self.textValue = textValue
    self.selectedOption = selectedOption
    self.state = .success
  }
}

public func fixtureResultFilename(runIdentifier: String) throws -> String {
  guard
    !runIdentifier.isEmpty,
    runIdentifier.utf8.count <= 80,
    runIdentifier.unicodeScalars.allSatisfy({
      switch $0.value {
      case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2D, 0x5F:
        return true
      default:
        return false
      }
    })
  else {
    throw FixtureContractError.invalidRunIdentifier
  }
  return "fixture-result-\(runIdentifier).json"
}
