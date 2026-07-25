// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "OpenDelegateMacComputerUse",
  platforms: [.macOS(.v14)],
  products: [
    .executable(
      name: "opendelegate-macos-computer-use",
      targets: ["OpenDelegateMacComputerUseHelper"]
    ),
    .executable(
      name: "opendelegate-computer-use-fixture",
      targets: ["OpenDelegateMacComputerUseFixture"]
    ),
  ],
  targets: [
    .target(
      name: "OpenDelegateMacComputerUseProtocol"
    ),
    .executableTarget(
      name: "OpenDelegateMacComputerUseHelper",
      dependencies: ["OpenDelegateMacComputerUseProtocol"],
      linkerSettings: [
        .linkedFramework("AppKit", .when(platforms: [.macOS])),
        .linkedFramework("ApplicationServices", .when(platforms: [.macOS])),
        .linkedFramework("Carbon", .when(platforms: [.macOS])),
        .linkedFramework("CoreGraphics", .when(platforms: [.macOS])),
        .linkedFramework("ImageIO", .when(platforms: [.macOS])),
        .linkedFramework("ScreenCaptureKit", .when(platforms: [.macOS])),
        .linkedFramework("UniformTypeIdentifiers", .when(platforms: [.macOS])),
      ]
    ),
    .executableTarget(
      name: "OpenDelegateMacComputerUseFixture",
      dependencies: ["OpenDelegateMacComputerUseProtocol"],
      linkerSettings: [
        .linkedFramework("AppKit", .when(platforms: [.macOS])),
      ]
    ),
    .testTarget(
      name: "OpenDelegateMacComputerUseProtocolTests",
      dependencies: ["OpenDelegateMacComputerUseProtocol"]
    ),
  ]
)
