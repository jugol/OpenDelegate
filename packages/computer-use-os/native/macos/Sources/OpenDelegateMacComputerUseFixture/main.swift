import Foundation
import OpenDelegateMacComputerUseProtocol

#if os(macOS)
import AppKit

private struct FixtureArguments {
  let runIdentifier: String
  let resultDirectory: URL
  let resultFilename: String
}

private func parseArguments() -> FixtureArguments? {
  let arguments = Array(CommandLine.arguments.dropFirst())
  guard arguments.count == 4 else {
    return nil
  }
  var values: [String: String] = [:]
  var index = 0
  while index < arguments.count {
    let key = arguments[index]
    let value = arguments[index + 1]
    guard
      (key == "--run-id" || key == "--result-directory"),
      values[key] == nil
    else {
      return nil
    }
    values[key] = value
    index += 2
  }
  guard
    let runIdentifier = values["--run-id"],
    let resultFilename = try? fixtureResultFilename(runIdentifier: runIdentifier),
    let resultPath = values["--result-directory"],
    resultPath.hasPrefix("/")
  else {
    return nil
  }
  let requestedDirectory = URL(
    fileURLWithPath: resultPath,
    isDirectory: true
  ).standardizedFileURL
  let resultDirectory = requestedDirectory.resolvingSymlinksInPath()
  guard
    requestedDirectory.path == resultPath,
    (try? resultDirectory.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
  else {
    return nil
  }
  return FixtureArguments(
    runIdentifier: runIdentifier,
    resultDirectory: resultDirectory,
    resultFilename: resultFilename
  )
}

@MainActor
private final class FixtureApplicationDelegate: NSObject, NSApplicationDelegate {
  private let arguments: FixtureArguments
  private let taskText = NSTextField(string: "")
  private let alpha = NSButton(
    radioButtonWithTitle: "Alpha",
    target: nil,
    action: nil
  )
  private let beta = NSButton(
    radioButtonWithTitle: "Beta",
    target: nil,
    action: nil
  )
  private let submit = NSButton(title: "Submit", target: nil, action: nil)
  private let status = NSTextField(labelWithString: "Editing")
  private var window: NSWindow?

  init(arguments: FixtureArguments) {
    self.arguments = arguments
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let runValue = NSTextField(labelWithString: arguments.runIdentifier)
    runValue.setAccessibilityIdentifier("fixture-run-id")
    runValue.setAccessibilityLabel("Fixture run identifier")

    taskText.placeholderString = "Type the task evidence text"
    taskText.setAccessibilityIdentifier("task-text")
    taskText.setAccessibilityLabel("Task text")

    alpha.target = self
    alpha.action = #selector(selectAlpha)
    alpha.state = .on
    alpha.setAccessibilityIdentifier("option-alpha")
    alpha.setAccessibilityLabel("Alpha")

    beta.target = self
    beta.action = #selector(selectBeta)
    beta.state = .off
    beta.setAccessibilityIdentifier("option-beta")
    beta.setAccessibilityLabel("Beta")

    submit.target = self
    submit.action = #selector(submitResult)
    submit.keyEquivalent = "\r"
    submit.setAccessibilityIdentifier("submit")
    submit.setAccessibilityLabel("Submit fixture result")

    status.setAccessibilityIdentifier("fixture-status")
    status.setAccessibilityLabel("Fixture status")

    let heading = NSTextField(labelWithString: "OpenDelegate Computer Use Fixture")
    heading.font = .systemFont(ofSize: 20, weight: .semibold)
    let explanation = NSTextField(
      wrappingLabelWithString:
        "Enter text, select one option, and submit. The native driver must use visible "
        + "Accessibility and input paths; this fixture has no automation shortcut."
    )
    explanation.textColor = .secondaryLabelColor

    let runRow = labelledRow(label: "Run", control: runValue)
    let textRow = labelledRow(label: "Task text", control: taskText)
    let optionLabel = NSTextField(labelWithString: "Option")
    optionLabel.alignment = .right
    optionLabel.setContentHuggingPriority(.required, for: .horizontal)
    let optionControls = NSStackView(views: [alpha, beta])
    optionControls.orientation = .horizontal
    optionControls.spacing = 16
    let optionRow = NSStackView(views: [optionLabel, optionControls])
    optionRow.orientation = .horizontal
    optionRow.alignment = .centerY
    optionRow.spacing = 12
    optionLabel.widthAnchor.constraint(equalToConstant: 88).isActive = true

    let actionRow = NSStackView(views: [status, submit])
    actionRow.orientation = .horizontal
    actionRow.alignment = .centerY
    actionRow.distribution = .fill
    actionRow.spacing = 12

    let stack = NSStackView(
      views: [heading, explanation, runRow, textRow, optionRow, actionRow]
    )
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 16
    runRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    textRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    optionRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    actionRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    let content = NSView()
    content.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
      stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
      stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 26),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -26),
    ])

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 620, height: 380),
      styleMask: [.titled, .closable, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    window.title = "OpenDelegate Computer Use Fixture"
    window.contentView = content
    window.center()
    window.makeKeyAndOrderFront(nil)
    self.window = window
    NSApplication.shared.activate(ignoringOtherApps: true)
    window.makeFirstResponder(taskText)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  @objc private func selectAlpha() {
    alpha.state = .on
    beta.state = .off
  }

  @objc private func selectBeta() {
    alpha.state = .off
    beta.state = .on
  }

  @objc private func submitResult() {
    let textValue = taskText.stringValue
    guard !textValue.isEmpty, textValue.utf8.count <= 4_096 else {
      status.stringValue = "Editing — enter 1–4096 UTF-8 bytes"
      NSSound.beep()
      return
    }
    let selected: FixtureSelectedOption = beta.state == .on ? .beta : .alpha
    let result = FixtureResultRecord(
      runIdentifier: arguments.runIdentifier,
      textValue: textValue,
      selectedOption: selected
    )
    let destination = arguments.resultDirectory.appendingPathComponent(
      arguments.resultFilename,
      isDirectory: false
    ).standardizedFileURL
    guard
      destination.deletingLastPathComponent() == arguments.resultDirectory,
      !FileManager.default.fileExists(atPath: destination.path)
    else {
      status.stringValue = "Editing — result path already exists"
      NSSound.beep()
      return
    }
    do {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys]
      let data = try encoder.encode(result)
      try data.write(to: destination, options: [.atomic])
      let attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
      guard
        attributes[.type] as? FileAttributeType == .typeRegular,
        (attributes[.size] as? NSNumber)?.intValue == data.count
      else {
        throw CocoaError(.fileWriteUnknown)
      }
      status.stringValue = "Success — result recorded"
      taskText.isEditable = false
      alpha.isEnabled = false
      beta.isEnabled = false
      submit.isEnabled = false
    } catch {
      status.stringValue = "Editing — result write failed"
      NSSound.beep()
    }
  }

  private func labelledRow(label: String, control: NSView) -> NSStackView {
    let labelView = NSTextField(labelWithString: label)
    labelView.alignment = .right
    labelView.setContentHuggingPriority(.required, for: .horizontal)
    labelView.widthAnchor.constraint(equalToConstant: 88).isActive = true
    let row = NSStackView(views: [labelView, control])
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 12
    control.widthAnchor.constraint(greaterThanOrEqualToConstant: 360).isActive = true
    return row
  }
}

guard let arguments = parseArguments() else {
  exit(64)
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
private let delegate = FixtureApplicationDelegate(arguments: arguments)
application.delegate = delegate
withExtendedLifetime(delegate) {
  application.run()
}
#else
FileHandle.standardError.write(Data("macOS-only executable\n".utf8))
exit(78)
#endif
