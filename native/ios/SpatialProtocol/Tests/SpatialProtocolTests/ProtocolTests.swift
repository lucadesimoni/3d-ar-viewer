import Foundation
import XCTest
@testable import SpatialProtocol

/// The same cases as the Android shell's `ProtocolTest.kt`: one contract, two platforms.
final class ProtocolTests: XCTestCase {
    let origins = ["https://3d-ar-viewer-ten.vercel.app"]
    let level = SpatialProtocol.Pose(position: [0, 1.4, -0.5], rotation: [0, 0, 0, 1])

    func testHelloSaysIosTheVersionAndWhetherFramesAreOffered() {
        XCTAssertEqual(SpatialProtocol.hello(appVersion: "1.0", cameraImages: true),
                       #"{"type":"hello","version":1,"platform":"ios","appVersion":"1.0","cameraImages":true}"#)
    }

    func testAPoseIsTheShapeTheWebAppParses() {
        XCTAssertEqual(SpatialProtocol.pose(tMs: 12, level, fovDeg: 63.5, tracking: "normal", floorY: 0),
                       #"{"type":"pose","t":12,"pose":{"position":[0,1.4,-0.5],"rotation":[0,0,0,1]},"fovDeg":63.5,"tracking":"normal","floorY":0}"#)
        XCTAssertFalse(SpatialProtocol.pose(tMs: 12, level, fovDeg: 63.5, tracking: "limited", floorY: nil)!.contains("floorY"))
    }

    func testARotationIsSentNormalisedAndNonFiniteNumbersAreNotSent() {
        let doubled = SpatialProtocol.Pose(position: [0, 0, 0], rotation: [0, 0, 0, 2])
        XCTAssertTrue(SpatialProtocol.pose(tMs: 0, doubled, fovDeg: 60, tracking: "normal", floorY: nil)!.contains(#""rotation":[0,0,0,1]"#))
        XCTAssertNil(SpatialProtocol.pose(tMs: 0, level, fovDeg: .nan, tracking: "normal", floorY: nil))
    }

    func testTheDeliveryScriptPassesTheMessageAsOneString() throws {
        let sneaky = #"{"type":"session","state":"failed","reason":"x\"); alert(1); (\""}"#
        let script = SpatialProtocol.deliverScript(sneaky)
        let prefix = "window.spatialNative&&window.spatialNative.receive("
        XCTAssertTrue(script.hasPrefix(prefix) && script.hasSuffix(")"))
        let argument = String(script.dropFirst(prefix.count).dropLast())
        // One string literal that decodes to exactly the message: nothing escaped into code.
        let decoded = try JSONSerialization.jsonObject(with: Data("[\(argument)]".utf8)) as? [String]
        XCTAssertEqual(decoded, [sneaky])
        XCTAssertFalse(SpatialProtocol.deliverScript("a\u{2028}b").unicodeScalars.contains("\u{2028}"))
    }

    func testTheWebsMessagesAreUnderstoodAndNothingElse() {
        XCTAssertEqual(SpatialProtocol.parseWebMessage(["type": "start"]), .start)
        XCTAssertEqual(SpatialProtocol.parseWebMessage(#"{"type":"stop"}"#), .stop)
        XCTAssertEqual(SpatialProtocol.parseWebMessage(["type": "request-image", "maxWidth": 480]), .requestImage(maxWidth: 480))
        XCTAssertEqual(SpatialProtocol.parseWebMessage(["type": "request-image", "maxWidth": 99999]), .requestImage(maxWidth: 1280))
        for bad: Any in ["", "null", [Int](), ["type": "launch"], ["type": "request-image"], 42] {
            XCTAssertNil(SpatialProtocol.parseWebMessage(bad), "\(bad)")
        }
    }

    func testFieldOfViewFromTheProjection() {
        XCTAssertEqual(SpatialProtocol.fovYDeg(projection11: 1 / tan(30 * Double.pi / 180)), 60, accuracy: 1e-6)
    }

    func testTheFloorIsTheLargestPlaneWellBelowTheCamera() {
        let planes = [SpatialProtocol.Plane(y: 0.75, areaM2: 1.2), .init(y: 0, areaM2: 4), .init(y: -0.02, areaM2: 0.3)]
        XCTAssertEqual(SpatialProtocol.floorY(cameraY: 1.4, planes: planes), 0)
        XCTAssertNil(SpatialProtocol.floorY(cameraY: 1.0, planes: [.init(y: 0.75, areaM2: 1.2)]))
    }

    func testOnlyTheAppsOwnSiteGetsTheBridge() {
        XCTAssertTrue(SpatialProtocol.isAllowed("https://3d-ar-viewer-ten.vercel.app/?assembly=kallax-4x2", allowedOrigins: origins))
        XCTAssertTrue(SpatialProtocol.isAllowed("https://3D-AR-VIEWER-TEN.vercel.app:443/x", allowedOrigins: origins))
        for bad in ["http://3d-ar-viewer-ten.vercel.app/", "https://evil.example/", "https://3d-ar-viewer-ten.vercel.app.evil.example/",
                    "https://user@3d-ar-viewer-ten.vercel.app/", "javascript:alert(1)", "file:///x.html", "not a url"] {
            XCTAssertFalse(SpatialProtocol.isAllowed(bad, allowedOrigins: origins), bad)
        }
    }

    func testALaunchLinkOpensItsPageIfAllowedAndHomeOtherwise() {
        let home = "https://3d-ar-viewer-ten.vercel.app/"
        let page = "https://3d-ar-viewer-ten.vercel.app/?assembly=kallax-4x2&step=s3"
        let link = "spatialar://open?url=" + page.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        XCTAssertEqual(SpatialProtocol.launchTarget(link, home: home, allowedOrigins: origins), page)
        XCTAssertEqual(SpatialProtocol.launchTarget("spatialar://open?url=https%3A%2F%2Fevil.example%2F", home: home, allowedOrigins: origins), home)
        XCTAssertEqual(SpatialProtocol.launchTarget(nil, home: home, allowedOrigins: origins), home)
    }
}
