package com.outthinkx.spatialar.protocol

import com.outthinkx.spatialar.protocol.Protocol.WebMessage
import kotlin.math.PI
import kotlin.math.tan
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ProtocolTest {
    private val origins = listOf("https://3d-ar-viewer-ten.vercel.app")
    private val level = Protocol.Pose(floatArrayOf(0f, 1.4f, -0.5f), floatArrayOf(0f, 0f, 0f, 1f))

    @Test fun `hello says android, the protocol version and whether frames are offered`() {
        assertEquals(
            """{"type":"hello","version":1,"platform":"android","appVersion":"1.0","cameraImages":true}""",
            Protocol.hello("1.0", cameraImages = true),
        )
    }

    @Test fun `a pose is the shape the web app parses`() {
        assertEquals(
            """{"type":"pose","t":12,"pose":{"position":[0,1.4,-0.5],"rotation":[0,0,0,1]},"fovDeg":63.5,"tracking":"normal","floorY":0}""",
            Protocol.pose(12, level, 63.5, "normal", 0.0),
        )
        // No floor yet: no field, rather than a null the web app would have to reject.
        assertFalse(Protocol.pose(12, level, 63.5, "limited", null).contains("floorY"))
    }

    @Test fun `a rotation is sent normalised`() {
        val doubled = Protocol.Pose(floatArrayOf(0f, 0f, 0f), floatArrayOf(0f, 0f, 0f, 2f))
        assertTrue(Protocol.pose(0, doubled, 60.0, "normal", null).contains(""""rotation":[0,0,0,1]"""))
    }

    @Test fun `numbers that JSON cannot hold are refused, not sent`() {
        val bad = runCatching { Protocol.pose(0, level, Double.NaN, "normal", null) }
        assertTrue(bad.isFailure)
    }

    @Test fun `a camera image is a JPEG data URL with the pose it was taken from`() {
        val json = Protocol.cameraImage(5, "AAAA", 480, 640, level, 58.0)
        assertTrue(json.startsWith("""{"type":"camera-image","t":5,"image":"data:image/jpeg;base64,AAAA","width":480,"height":640,"""))
        assertTrue(json.endsWith(""""fovDeg":58}"""))
    }

    @Test fun `the delivery script passes the message as a string, never as code`() {
        val sneaky = """{"type":"session","state":"failed","reason":"x\"); alert(1); (\""}"""
        val script = Protocol.deliverScript(sneaky)
        val prefix = "window.spatialNative&&window.spatialNative.receive("
        assertTrue(script.startsWith(prefix) && script.endsWith(")"))
        // The argument is one string literal, and it reads back as exactly the
        // message: nothing in it ended the string early to become code.
        val arg = script.removePrefix(prefix).removeSuffix(")")
        assertEquals(sneaky, FlatJson.parse("{\"a\":$arg}")?.get("a"))
        // And a line separator cannot split the script into two statements.
        assertFalse(Protocol.deliverScript("a b").contains(' '))
    }

    @Test fun `the web's messages are understood, and nothing else is`() {
        assertEquals(WebMessage.Start, Protocol.parseWebMessage("""{"type":"start"}"""))
        assertEquals(WebMessage.Stop, Protocol.parseWebMessage(""" { "type" : "stop" } """))
        assertEquals(WebMessage.RequestImage(480), Protocol.parseWebMessage("""{"type":"request-image","maxWidth":480}"""))
        // Clamped, so the page cannot ask for a frame the phone cannot afford.
        assertEquals(WebMessage.RequestImage(1280), Protocol.parseWebMessage("""{"type":"request-image","maxWidth":99999}"""))
        for (bad in listOf("", "null", "[]", """{"type":"launch"}""", """{"type":"request-image"}""",
            """{"type":"start"} trailing""", """{"type":"start","x":{"nested":1}}""", """{"type":"start""")) {
            assertNull(Protocol.parseWebMessage(bad), bad)
        }
    }

    @Test fun `field of view from a projection matrix`() {
        val fov = 60.0
        val p = FloatArray(16)
        p[5] = (1.0 / tan(fov * PI / 360.0)).toFloat()
        assertEquals(fov, Protocol.fovYDeg(p), 1e-3)
        // And from an image's focal length: 960 px tall at f = 1317 px is the 72.2 degrees a device reported.
        assertEquals(72.2, Protocol.fovYDeg(1317.0, 1920.0), 0.1)
    }

    @Test fun `the floor is the largest plane well below the camera, not the table`() {
        val planes = listOf(Protocol.Plane(0.75, 1.2), Protocol.Plane(0.0, 4.0), Protocol.Plane(-0.02, 0.3))
        assertEquals(0.0, Protocol.floorY(1.4, planes))
        // A table under the phone held over it is not well below it: no floor yet.
        assertNull(Protocol.floorY(1.0, listOf(Protocol.Plane(0.75, 1.2))))
        assertNull(Protocol.floorY(1.4, emptyList()))
    }

    @Test fun `only the app's own site gets the bridge`() {
        assertTrue(Protocol.isAllowed("https://3d-ar-viewer-ten.vercel.app/?assembly=kallax-4x2", origins))
        assertTrue(Protocol.isAllowed("https://3D-AR-VIEWER-TEN.vercel.app:443/x", origins))
        for (bad in listOf(
            "http://3d-ar-viewer-ten.vercel.app/", "https://evil.example/", "https://3d-ar-viewer-ten.vercel.app.evil.example/",
            "https://user@3d-ar-viewer-ten.vercel.app/", "javascript:alert(1)", "file:///sdcard/x.html", "not a url",
        )) {
            assertFalse(Protocol.isAllowed(bad, origins), bad)
        }
    }

    @Test fun `a launch link opens its page, if allowed, and home otherwise`() {
        val home = "https://3d-ar-viewer-ten.vercel.app/"
        val page = "https://3d-ar-viewer-ten.vercel.app/?assembly=kallax-4x2&step=s3"
        val link = "spatialar://open?url=" + java.net.URLEncoder.encode(page, "UTF-8")
        assertEquals(page, Protocol.launchTarget(link, home, origins))
        assertEquals(home, Protocol.launchTarget("spatialar://open?url=https%3A%2F%2Fevil.example%2F", home, origins))
        assertEquals(home, Protocol.launchTarget("spatialar://other?url=x", home, origins))
        assertEquals(home, Protocol.launchTarget(null, home, origins))
    }
}
