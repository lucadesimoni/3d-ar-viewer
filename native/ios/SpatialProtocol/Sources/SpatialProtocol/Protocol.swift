import Foundation

/// The native side of the bridge to the web app, version 1.
///
/// The contract is `src/native/bridge.ts` in the web app; the Android shell's
/// `Protocol.kt` is the same contract in Kotlin. Native → web messages are
/// JSON handed to `window.spatialNative.receive`; web → native messages arrive
/// through the `spatialNative` script message handler.
public enum SpatialProtocol {
    public static let version = 1

    public enum WebMessage: Equatable {
        case start
        case stop
        case requestImage(maxWidth: Int)
    }

    /// A camera pose: right-handed, y up, the camera looking down -z (ARKit's own convention).
    public struct Pose: Equatable {
        public var position: [Double]
        public var rotation: [Double]
        public init(position: [Double], rotation: [Double]) {
            precondition(position.count == 3 && rotation.count == 4, "position xyz, rotation xyzw")
            self.position = position
            self.rotation = rotation
        }
    }

    public struct Plane: Equatable {
        public var y: Double
        public var areaM2: Double
        public init(y: Double, areaM2: Double) { self.y = y; self.areaM2 = areaM2 }
    }

    public static let floorBelowCameraM = 0.5

    public static func hello(appVersion: String, cameraImages: Bool) -> String {
        "{\"type\":\"hello\",\"version\":\(version),\"platform\":\"ios\",\"appVersion\":\(string(appVersion)),\"cameraImages\":\(cameraImages)}"
    }

    public static func session(_ state: String, reason: String? = nil) -> String {
        precondition(["running", "paused", "failed"].contains(state))
        let r = reason.map { ",\"reason\":\(string($0))" } ?? ""
        return "{\"type\":\"session\",\"state\":\"\(state)\"\(r)}"
    }

    /// Nil when a number in it is not finite: such a pose is not sent at all.
    public static func pose(tMs: Int64, _ pose: Pose, fovDeg: Double, tracking: String, floorY: Double?) -> String? {
        precondition(["normal", "limited", "not-available"].contains(tracking))
        guard let p = poseJSON(pose), let f = number(fovDeg) else { return nil }
        var floor = ""
        if let y = floorY {
            guard let fy = number(y) else { return nil }
            floor = ",\"floorY\":\(fy)"
        }
        return "{\"type\":\"pose\",\"t\":\(tMs),\"pose\":\(p),\"fovDeg\":\(f),\"tracking\":\"\(tracking)\"\(floor)}"
    }

    /// `jpegBase64` without a data-URL prefix.
    public static func cameraImage(tMs: Int64, jpegBase64: String, width: Int, height: Int, pose: Pose, fovDeg: Double) -> String? {
        guard let p = poseJSON(pose), let f = number(fovDeg) else { return nil }
        return "{\"type\":\"camera-image\",\"t\":\(tMs),\"image\":\"data:image/jpeg;base64,\(jpegBase64)\",\"width\":\(width),\"height\":\(height),\"pose\":\(p),\"fovDeg\":\(f)}"
    }

    /// The script that delivers `json` to the page, as a string argument: never evaluated as code.
    public static func deliverScript(_ json: String) -> String {
        "window.spatialNative&&window.spatialNative.receive(\(string(json)))"
    }

    /// A message from the web app (the handler's body: a dictionary, or a JSON string), or nil.
    public static func parseWebMessage(_ body: Any) -> WebMessage? {
        var object: Any = body
        if let text = body as? String {
            guard let data = text.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data) else { return nil }
            object = parsed
        }
        guard let dict = object as? [String: Any], let type = dict["type"] as? String else { return nil }
        switch type {
        case "start": return .start
        case "stop": return .stop
        case "request-image":
            guard let w = (dict["maxWidth"] as? NSNumber)?.doubleValue, w.isFinite else { return nil }
            return .requestImage(maxWidth: min(1280, max(64, Int(w))))
        default: return nil
        }
    }

    /// Vertical field of view, degrees, from the projection matrix's [1][1] element, cot(fovY / 2).
    public static func fovYDeg(projection11: Double) -> Double {
        2 * atan(1 / projection11) * 180 / .pi
    }

    /// The largest plane well below the camera, or nil: a table at waist height is not the floor.
    public static func floorY(cameraY: Double, planes: [Plane]) -> Double? {
        planes.filter { $0.y < cameraY - floorBelowCameraM && $0.areaM2 > 0 }
            .max { $0.areaM2 < $1.areaM2 }?.y
    }

    /// Whether the web view may load `url` and so be given the bridge: https on an allowed origin.
    public static func isAllowed(_ url: String, allowedOrigins: [String]) -> Bool {
        guard let c = URLComponents(string: url), c.scheme == "https",
              let host = c.host?.lowercased(), !host.isEmpty, c.user == nil, c.password == nil else { return false }
        let port = (c.port == nil || c.port == 443) ? "" : ":\(c.port!)"
        let origin = "https://\(host)\(port)"
        return allowedOrigins.contains { $0.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/")) == origin }
    }

    /// `spatialar://open?url=<page>` opens that page if allowed; anything else opens `home`.
    public static func launchTarget(_ link: String?, home: String, allowedOrigins: [String]) -> String {
        guard let link = link, let c = URLComponents(string: link), c.scheme == "spatialar", c.host == "open",
              let target = c.queryItems?.first(where: { $0.name == "url" })?.value,
              isAllowed(target, allowedOrigins: allowedOrigins) else { return home }
        return target
    }

    public static func normalized(_ q: [Double]) -> [Double] {
        let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).squareRoot()
        return n == 0 ? [0, 0, 0, 1] : q.map { $0 / n }
    }

    // MARK: - JSON

    static func poseJSON(_ p: Pose) -> String? {
        let q = normalized(p.rotation)
        let pos = p.position.compactMap(number)
        let rot = q.compactMap(number)
        guard pos.count == 3, rot.count == 4 else { return nil }
        return "{\"position\":[\(pos.joined(separator: ","))],\"rotation\":[\(rot.joined(separator: ","))]}"
    }

    /// A finite number as JSON, six decimals at most, without trailing zeros: as the Android shell writes it.
    static func number(_ v: Double) -> String? {
        guard v.isFinite else { return nil }
        var s = String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), v)
        while s.contains(".") && (s.hasSuffix("0") || s.hasSuffix(".")) { s.removeLast() }
        if s == "-0" || s.isEmpty { s = "0" }
        return s
    }

    /// A string as a JSON string literal; U+2028 and U+2029 escaped, as JavaScript source needs.
    public static func string(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 || u.value == 0x2028 || u.value == 0x2029 {
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        return out + "\""
    }
}
