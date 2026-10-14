// swift-tools-version:5.7
// The native side of the bridge to the web app: plain Swift, unit-tested on
// macOS without a device (`swift test`). Mirrors the Android shell's
// `protocol` module and the web app's `src/native/bridge.ts`.
import PackageDescription

let package = Package(
    name: "SpatialProtocol",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "SpatialProtocol", targets: ["SpatialProtocol"])],
    targets: [
        .target(name: "SpatialProtocol"),
        .testTarget(name: "SpatialProtocolTests", dependencies: ["SpatialProtocol"]),
    ]
)
