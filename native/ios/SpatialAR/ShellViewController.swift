import ARKit
import CoreImage
import SpatialProtocol
import UIKit
import WebKit

/// The web app in a transparent web view, over ARKit's camera.
///
/// The web app is the product; this adds ARKit, which iPhone Safari does not
/// expose to web pages. The page says `start`; the shell runs an ARKit
/// session and sends the camera's pose each frame, the floor once a plane is
/// found, and camera images when asked (`SpatialProtocol`, mirroring the web
/// app's `src/native/bridge.ts`). The bridge answers only the app's own site.
final class ShellViewController: UIViewController, ARSessionDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private let arView = ARSCNView(frame: .zero)
    private var web: WKWebView!
    private let ciContext = CIContext()
    private var running = false
    private var imageWanted = 0
    private var lastPoseSent: TimeInterval = 0
    private var pendingLink: String?

    private lazy var home: String = Bundle.main.object(forInfoDictionaryKey: "SpatialHomeURL") as? String
        ?? "https://3d-ar-viewer-ten.vercel.app/"
    private lazy var allowed: [String] = ((Bundle.main.object(forInfoDictionaryKey: "SpatialAllowedOrigins") as? String)
        ?? "https://3d-ar-viewer-ten.vercel.app").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.043, green: 0.059, blue: 0.078, alpha: 1)

        arView.frame = view.bounds
        arView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        arView.session.delegate = self
        arView.automaticallyUpdatesLighting = false
        arView.isHidden = true
        view.addSubview(arView)

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // Weakly held: the content controller otherwise keeps this controller alive.
        config.userContentController.add(WeakHandler(self), name: "spatialNative")
        web = WKWebView(frame: view.bounds, configuration: config)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = self
        web.uiDelegate = self
        view.addSubview(web)

        open(link: pendingLink)
    }

    override var prefersStatusBarHidden: Bool { running }
    override var prefersHomeIndicatorAutoHidden: Bool { running }

    /// Load the page a launch link names, if allowed; else the home page.
    func open(link: String?) {
        guard isViewLoaded, web != nil else { pendingLink = link; return }
        let target = SpatialProtocol.launchTarget(link, home: home, allowedOrigins: allowed)
        if let url = URL(string: target) { web.load(URLRequest(url: url)) }
    }

    // MARK: - From the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the app's own site, and only its top frame.
        let origin = message.frameInfo.securityOrigin
        let url = "\(origin.protocol)://\(origin.host)\(origin.port == 0 ? "" : ":\(origin.port)")/"
        guard message.frameInfo.isMainFrame, SpatialProtocol.isAllowed(url, allowedOrigins: allowed) else { return }
        switch SpatialProtocol.parseWebMessage(message.body) {
        case .start?: start()
        case .stop?: stop()
        case .requestImage(let maxWidth)?: imageWanted = maxWidth
        case nil: break
        }
    }

    private func start() {
        send(SpatialProtocol.hello(appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
                                   cameraImages: true))
        guard ARWorldTrackingConfiguration.isSupported else {
            send(SpatialProtocol.session("failed", reason: "ARKit world tracking is not supported on this device"))
            return
        }
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal]
        arView.isHidden = false
        arView.session.run(config, options: running ? [] : [.resetTracking, .removeExistingAnchors])
        running = true
        UIApplication.shared.isIdleTimerDisabled = true
        setNeedsStatusBarAppearanceUpdate()
        send(SpatialProtocol.session("running"))
    }

    private func stop() {
        guard running else { return }
        running = false
        arView.session.pause()
        arView.isHidden = true
        UIApplication.shared.isIdleTimerDisabled = false
        setNeedsStatusBarAppearanceUpdate()
    }

    // MARK: - ARKit

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard running else { return }
        // Thirty poses a second is what the page can use; ARKit runs at sixty.
        guard frame.timestamp - lastPoseSent >= 1.0 / 30 else { return }
        lastPoseSent = frame.timestamp
        let orientation = view.window?.windowScene?.interfaceOrientation ?? .portrait
        let size = arView.bounds.size
        guard size.width > 0, size.height > 0 else { return }

        // The camera as the screen shows it: the view matrix for this orientation, inverted.
        let cam = frame.camera.viewMatrix(for: orientation).inverse
        let q = simd_quatf(cam)
        let pose = SpatialProtocol.Pose(
            position: [Double(cam.columns.3.x), Double(cam.columns.3.y), Double(cam.columns.3.z)],
            rotation: [Double(q.imag.x), Double(q.imag.y), Double(q.imag.z), Double(q.real)])
        let projection = frame.camera.projectionMatrix(for: orientation, viewportSize: size, zNear: 0.05, zFar: 50)
        let fov = SpatialProtocol.fovYDeg(projection11: Double(projection.columns.1.y))
        let tracking: String
        switch frame.camera.trackingState {
        case .normal: tracking = "normal"
        case .limited: tracking = "limited"
        case .notAvailable: tracking = "not-available"
        }
        let planes = frame.anchors.compactMap { $0 as? ARPlaneAnchor }
            .filter { $0.alignment == .horizontal }
            .map { SpatialProtocol.Plane(y: Double($0.transform.columns.3.y), areaM2: area(of: $0)) }
        let tMs = Int64(frame.timestamp * 1000)
        if let json = SpatialProtocol.pose(tMs: tMs, pose, fovDeg: fov, tracking: tracking,
                                           floorY: SpatialProtocol.floorY(cameraY: Double(cam.columns.3.y), planes: planes)) {
            send(json)
        }

        if imageWanted > 0 {
            let maxWidth = imageWanted
            imageWanted = 0
            if let (jpeg, w, h) = visibleJpeg(frame, orientation: orientation, viewport: size, maxWidth: maxWidth),
               let json = SpatialProtocol.cameraImage(tMs: tMs, jpegBase64: jpeg, width: w, height: h, pose: pose, fovDeg: fov) {
                send(json)
            }
        }
    }

    private func area(of plane: ARPlaneAnchor) -> Double {
        if #available(iOS 16.0, *) { return Double(plane.planeExtent.width * plane.planeExtent.height) }
        return Double(plane.extent.x * plane.extent.z)
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        send(SpatialProtocol.session("failed", reason: error.localizedDescription))
    }

    func sessionWasInterrupted(_ session: ARSession) {
        if running { send(SpatialProtocol.session("paused")) }
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        if running { send(SpatialProtocol.session("running")) }
    }

    /// The camera frame cut to exactly what the screen shows, upright, as a JPEG:
    /// so the page's projection, intrinsics and this picture describe one view.
    private func visibleJpeg(_ frame: ARFrame, orientation: UIInterfaceOrientation, viewport: CGSize, maxWidth: Int) -> (String, Int, Int)? {
        let buffer = frame.capturedImage
        let imageSize = CGSize(width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer))
        let normalize = CGAffineTransform(scaleX: 1 / imageSize.width, y: 1 / imageSize.height)
        // Core Image's origin is bottom-left; the display transform's is top-left.
        let flip = CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -1)
        let display = frame.displayTransform(for: orientation, viewportSize: viewport)
        let toView = CGAffineTransform(scaleX: viewport.width, y: viewport.height)
        let visible = CIImage(cvPixelBuffer: buffer)
            .transformed(by: normalize.concatenating(flip).concatenating(display).concatenating(flip).concatenating(toView))
            .cropped(to: CGRect(origin: .zero, size: viewport))
        let scale = min(1, CGFloat(maxWidth) / viewport.width)
        let scaled = visible.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let w = Int((viewport.width * scale).rounded(.down))
        let h = Int((viewport.height * scale).rounded(.down))
        guard w > 0, h > 0,
              let jpeg = ciContext.jpegRepresentation(of: scaled.cropped(to: CGRect(x: 0, y: 0, width: w, height: h)),
                                                      colorSpace: CGColorSpaceCreateDeviceRGB(),
                                                      options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.8])
        else { return nil }
        return (jpeg.base64EncodedString(), w, h)
    }

    // MARK: - To the page

    private func send(_ json: String) {
        let script = SpatialProtocol.deliverScript(json)
        DispatchQueue.main.async { [weak self] in self?.web.evaluateJavaScript(script, completionHandler: nil) }
    }

    // MARK: - Navigation and permissions

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if SpatialProtocol.isAllowed(url.absoluteString, allowedOrigins: allowed) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
            return decisionHandler(.allow)
        }
        // Any other site opens in Safari, outside the shell and its bridge.
        if action.navigationType == .linkActivated { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }

    /// Without ARKit the page uses its own camera path, through the web view: the app's site only.
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let url = "\(origin.protocol)://\(origin.host)\(origin.port == 0 ? "" : ":\(origin.port)")/"
        decisionHandler(type == .camera && SpatialProtocol.isAllowed(url, allowedOrigins: allowed) ? .grant : .deny)
    }
}

/// Breaks the retain cycle between the web view's content controller and its handler.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(c, didReceive: message)
    }
}
