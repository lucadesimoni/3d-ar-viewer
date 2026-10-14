package com.outthinkx.spatialar

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.Bundle
import android.os.SystemClock
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Config
import com.google.ar.core.Plane
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.outthinkx.spatialar.protocol.Protocol
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

/**
 * The Spatial AR Android shell.
 *
 * The web app is the product; this app adds ARCore. It shows the hosted web
 * app in a full-screen web view, transparent where the page is, over ARCore's
 * camera image, and drives the page's AR through the bridge
 * (`com.outthinkx.spatialar.protocol.Protocol`, mirroring `src/native/bridge.ts`):
 * the page says `start`, the app runs an ARCore session and sends the camera's
 * pose every frame, the floor once a plane is found, and camera images when
 * asked. The bridge is offered only to the app's own site (`ALLOWED_ORIGINS`).
 */
class MainActivity : AppCompatActivity(), GLSurfaceView.Renderer {
    private lateinit var web: WebView
    private lateinit var surface: GLSurfaceView
    private val background = BackgroundRenderer()
    private val allowed = BuildConfig.ALLOWED_ORIGINS.split(',').map { it.trim() }.filter { it.isNotEmpty() }

    /** Touched on the GL thread only, once created. */
    private var session: Session? = null
    /** Whether the page wants AR running: set from the bridge, read on the GL thread. */
    private val wanted = AtomicBoolean(false)
    /** A camera image the page asked for, at most this wide; 0 for none. */
    private val imageWanted = AtomicInteger(0)
    private var installRequested = false
    private var displayRotation = 0
    private var viewW = 0
    private var viewH = 0

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        surface = GLSurfaceView(this).apply {
            preserveEGLContextOnPause = true
            setEGLContextClientVersion(2)
            setEGLConfigChooser(8, 8, 8, 8, 16, 0)
            setRenderer(this@MainActivity)
            renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
        }
        web = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = object : WebViewClient() {
                // The app's own site stays in the app; any other link opens in the browser.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    if (Protocol.isAllowed(url, allowed)) return false
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                // Without ARCore the page falls back to its own camera path, which
                // needs the camera through the web view: granted to the app's site only.
                override fun onPermissionRequest(request: PermissionRequest) {
                    val origin = request.origin.toString()
                    if (Protocol.isAllowed(origin, allowed) &&
                        request.resources.all { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE } &&
                        hasCamera()
                    ) request.grant(request.resources) else request.deny()
                }
            }
        }
        installBridge()
        setContentView(FrameLayout(this).apply {
            addView(surface, FrameLayout.LayoutParams(-1, -1))
            addView(web, FrameLayout.LayoutParams(-1, -1))
        })
        web.loadUrl(Protocol.launchTarget(intent?.dataString, BuildConfig.HOME_URL, allowed))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // "Open in the app" while it is already open: the new page, not a second copy.
        intent.dataString?.let { web.loadUrl(Protocol.launchTarget(it, BuildConfig.HOME_URL, allowed)) }
    }

    /**
     * `window.SpatialNativeHost.postMessage(json)` in the page, for the
     * allowed origins only. WebViewCompat's listener checks the origin of
     * every frame itself, which `addJavascriptInterface` would not.
     */
    private fun installBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // An old WebView: the page runs as in a browser, without ARCore.
            return
        }
        WebViewCompat.addWebMessageListener(web, "SpatialNativeHost", allowed.toSet()) { _, message, origin, isMainFrame, _ ->
            if (!isMainFrame || !Protocol.isAllowed(origin.toString(), allowed)) return@addWebMessageListener
            when (val m = Protocol.parseWebMessage(message.data ?: return@addWebMessageListener)) {
                Protocol.WebMessage.Start -> startAr()
                Protocol.WebMessage.Stop -> wanted.set(false)
                is Protocol.WebMessage.RequestImage -> imageWanted.set(m.maxWidth)
                null -> Unit
            }
        }
    }

    private fun startAr() {
        send(Protocol.hello(BuildConfig.VERSION_NAME, cameraImages = true))
        if (!hasCamera()) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), CAMERA_REQUEST)
            return
        }
        // Otherwise the page has been told why, and falls back to its own AR.
        if (ensureSession() == null) wanted.set(true)
    }

    /** Null when a session is ready; otherwise why there is none (already reported to the page). */
    private fun ensureSession(): String? {
        if (session != null) return null
        try {
            when (ArCoreApk.getInstance().requestInstall(this, !installRequested)) {
                ArCoreApk.InstallStatus.INSTALL_REQUESTED -> {
                    installRequested = true
                    return "installing ARCore"   // onResume tries again
                }
                else -> Unit
            }
            val s = Session(this)
            s.configure(Config(s).apply {
                planeFindingMode = Config.PlaneFindingMode.HORIZONTAL
                focusMode = Config.FocusMode.AUTO
                updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
            })
            session = s
            surface.queueEvent { if (background.textureId != -1) s.setCameraTextureName(background.textureId) }
            s.resume()
            send(Protocol.session("running"))
            return null
        } catch (e: Exception) {
            val reason = "ARCore is not available on this phone (${e.javaClass.simpleName})"
            send(Protocol.session("failed", reason))
            return reason
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != CAMERA_REQUEST) return
        if (hasCamera()) startAr() else {
            Toast.makeText(this, R.string.camera_needed, Toast.LENGTH_LONG).show()
            send(Protocol.session("failed", "camera permission refused"))
        }
    }

    override fun onResume() {
        super.onResume()
        surface.onResume()
        web.onResume()
        if (wanted.get() || installRequested) {
            if (ensureSession() == null) {
                try { session?.resume() } catch (e: Exception) { send(Protocol.session("failed", e.javaClass.simpleName)) }
                wanted.set(true)
            }
        }
    }

    override fun onPause() {
        super.onPause()
        web.onPause()
        surface.onPause()
        session?.pause()
        if (wanted.get()) send(Protocol.session("paused"))
    }

    override fun onDestroy() {
        session?.close()
        session = null
        web.destroy()
        super.onDestroy()
    }

    // --- GL thread. ----------------------------------------------------------------

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES20.glClearColor(0.043f, 0.059f, 0.078f, 1f)
        background.create()
        session?.setCameraTextureName(background.textureId)
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        GLES20.glViewport(0, 0, width, height)
        viewW = width
        viewH = height
        @Suppress("DEPRECATION")
        displayRotation = windowManager.defaultDisplay.rotation
        session?.setDisplayGeometry(displayRotation, width, height)
    }

    override fun onDrawFrame(gl: GL10?) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
        val s = session ?: return
        if (!wanted.get()) return
        s.setCameraTextureName(background.textureId)
        s.setDisplayGeometry(displayRotation, viewW, viewH)
        val frame = try { s.update() } catch (_: Exception) { return }
        background.draw(frame)

        val camera = frame.camera
        val tracking = when (camera.trackingState) {
            TrackingState.TRACKING -> "normal"
            TrackingState.PAUSED -> "limited"
            else -> "not-available"
        }
        if (camera.trackingState == TrackingState.STOPPED) return

        val p = camera.displayOrientedPose
        val pose = Protocol.Pose(floatArrayOf(p.tx(), p.ty(), p.tz()), floatArrayOf(p.qx(), p.qy(), p.qz(), p.qw()))
        val projection = FloatArray(16)
        camera.getProjectionMatrix(projection, 0, 0.05f, 50f)
        val fov = Protocol.fovYDeg(projection)
        val planes = s.getAllTrackables(Plane::class.java)
            .filter { it.type == Plane.Type.HORIZONTAL_UPWARD_FACING && it.trackingState == TrackingState.TRACKING && it.subsumedBy == null }
            .map { Protocol.Plane(it.centerPose.ty().toDouble(), (it.extentX * it.extentZ).toDouble()) }
        val now = SystemClock.uptimeMillis()
        send(Protocol.pose(now, pose, fov, tracking, Protocol.floorY(p.ty().toDouble(), planes)))

        val maxWidth = imageWanted.getAndSet(0)
        if (maxWidth > 0) {
            CameraImages.visibleJpeg(frame, maxWidth)?.let { (jpeg, w, h) ->
                send(Protocol.cameraImage(now, jpeg, w, h, pose, fov))
            }
        }
    }

    // --- To the page. -----------------------------------------------------------------

    private fun send(json: String) {
        val script = Protocol.deliverScript(json)
        web.post { web.evaluateJavascript(script, null) }
    }

    private fun hasCamera(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private companion object {
        const val CAMERA_REQUEST = 1
    }
}
