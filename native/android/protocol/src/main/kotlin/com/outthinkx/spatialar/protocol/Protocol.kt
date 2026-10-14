package com.outthinkx.spatialar.protocol

import java.net.URI
import java.util.Locale
import kotlin.math.atan
import kotlin.math.sqrt

/**
 * The native side of the bridge to the web app, version 1.
 *
 * The contract is `src/native/bridge.ts` in the web app; this is its mirror.
 * Native → web messages are JSON handed to `window.spatialNative.receive`;
 * web → native messages arrive as JSON through the `SpatialNativeHost`
 * JavaScript interface. Plain Kotlin, no Android types, so every rule here is
 * unit-tested on any JVM (`./gradlew -PprotocolOnly :protocol:test`).
 */
object Protocol {
    const val VERSION = 1

    /** Messages the web app sends. */
    sealed interface WebMessage {
        data object Start : WebMessage
        data object Stop : WebMessage
        data class RequestImage(val maxWidth: Int) : WebMessage
    }

    /** A camera pose: right-handed, y up, the camera looking down -z (ARCore's own convention). */
    data class Pose(val position: FloatArray, val rotation: FloatArray) {
        init {
            require(position.size == 3 && rotation.size == 4) { "position xyz, rotation xyzw" }
        }
    }

    fun hello(appVersion: String, cameraImages: Boolean): String =
        """{"type":"hello","version":$VERSION,"platform":"android","appVersion":${str(appVersion)},"cameraImages":$cameraImages}"""

    fun session(state: String, reason: String? = null): String {
        require(state in setOf("running", "paused", "failed"))
        return """{"type":"session","state":"$state"${if (reason != null) ""","reason":${str(reason)}""" else ""}}"""
    }

    fun pose(tMs: Long, pose: Pose, fovDeg: Double, tracking: String, floorY: Double?): String {
        require(tracking in setOf("normal", "limited", "not-available"))
        return """{"type":"pose","t":$tMs,"pose":${poseJson(pose)},"fovDeg":${num(fovDeg)},"tracking":"$tracking"${
            if (floorY != null) ""","floorY":${num(floorY)}""" else ""}}"""
    }

    /** `jpegBase64` is the JPEG's bytes in base64, without a data-URL prefix. */
    fun cameraImage(tMs: Long, jpegBase64: String, width: Int, height: Int, pose: Pose, fovDeg: Double): String =
        """{"type":"camera-image","t":$tMs,"image":"data:image/jpeg;base64,$jpegBase64","width":$width,"height":$height,"pose":${
            poseJson(pose)},"fovDeg":${num(fovDeg)}}"""

    /**
     * The script that delivers [json] to the page. It does nothing on a page
     * without the bridge, and the message is a JSON *string* argument, so its
     * content is never evaluated as code.
     */
    fun deliverScript(json: String): String =
        "window.spatialNative&&window.spatialNative.receive(${str(json)})"

    /** A message from the web app, or null for anything else. */
    fun parseWebMessage(json: String): WebMessage? {
        val fields = FlatJson.parse(json) ?: return null
        return when (fields["type"]) {
            "start" -> WebMessage.Start
            "stop" -> WebMessage.Stop
            "request-image" -> {
                val w = (fields["maxWidth"] as? Double) ?: return null
                if (!w.isFinite()) return null
                WebMessage.RequestImage(w.toInt().coerceIn(64, 1280))
            }
            else -> null
        }
    }

    /**
     * Vertical field of view, in degrees, from an OpenGL projection matrix
     * (column-major, as ARCore's `Camera.getProjectionMatrix` writes it):
     * element 5 is cot(fovY / 2).
     */
    fun fovYDeg(projection: FloatArray): Double {
        require(projection.size == 16)
        return Math.toDegrees(2.0 * atan(1.0 / projection[5].toDouble()))
    }

    /** Vertical field of view, degrees, of an image `heightPx` tall with focal length `fyPx`. */
    fun fovYDeg(fyPx: Double, heightPx: Double): Double = Math.toDegrees(2.0 * atan(heightPx / 2.0 / fyPx))

    /** A horizontal, upward-facing plane: its world height and area, square metres. */
    data class Plane(val y: Double, val areaM2: Double)

    /**
     * The floor, from the planes found so far: the largest one well below the
     * camera (a table at waist height is not the floor), or null.
     */
    fun floorY(cameraY: Double, planes: List<Plane>): Double? =
        planes.filter { it.y < cameraY - FLOOR_BELOW_CAMERA_M && it.areaM2 > 0.0 }
            .maxByOrNull { it.areaM2 }?.y

    const val FLOOR_BELOW_CAMERA_M = 0.5

    /**
     * Whether the web view may load [url], and so be given the bridge: https on
     * one of [allowedOrigins] (`https://host` or `https://host:port`), nothing else.
     * The bridge hands over the camera, so it is never offered to an arbitrary page.
     */
    fun isAllowed(url: String, allowedOrigins: List<String>): Boolean {
        val uri = try { URI(url) } catch (_: Exception) { return false }
        if (uri.scheme != "https" || uri.host.isNullOrEmpty() || uri.userInfo != null) return false
        val origin = "https://${uri.host.lowercase(Locale.ROOT)}${if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"}"
        return allowedOrigins.any { it.trimEnd('/').lowercase(Locale.ROOT) == origin }
    }

    /**
     * What to open for a launch link: `spatialar://open?url=<page>` opens that
     * page if it is allowed; anything else opens [home].
     */
    fun launchTarget(link: String?, home: String, allowedOrigins: List<String>): String {
        if (link == null) return home
        val uri = try { URI(link) } catch (_: Exception) { return home }
        if (uri.scheme != "spatialar" || uri.host != "open") return home
        val target = uri.rawQuery?.split('&')
            ?.firstOrNull { it.startsWith("url=") }
            ?.removePrefix("url=")
            ?.let { java.net.URLDecoder.decode(it, "UTF-8") }
            ?: return home
        return if (isAllowed(target, allowedOrigins)) target else home
    }

    /** A rotation's quaternion normalised; ARCore's are, a defensive copy is cheap. */
    fun normalized(q: FloatArray): FloatArray {
        val n = sqrt((q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).toDouble()).toFloat()
        return if (n == 0f) floatArrayOf(0f, 0f, 0f, 1f) else FloatArray(4) { q[it] / n }
    }

    private fun poseJson(p: Pose): String {
        val q = normalized(p.rotation)
        return """{"position":[${p.position.joinToString(",") { num(it.toDouble()) }}],"rotation":[${q.joinToString(",") { num(it.toDouble()) }}]}"""
    }

    /** A number as JSON: finite, and without the exponent a JS parser would still take but a reader would not. */
    private fun num(v: Double): String {
        require(v.isFinite()) { "not a finite number: $v" }
        return String.format(Locale.ROOT, "%.6f", v).trimEnd('0').trimEnd('.').ifEmpty { "0" }.let { if (it == "-0") "0" else it }
    }

    /** A string as a JSON string literal. */
    fun str(s: String): String {
        val b = StringBuilder("\"")
        for (c in s) {
            when {
                c == '"' -> b.append("\\\"")
                c == '\\' -> b.append("\\\\")
                c == '\n' -> b.append("\\n")
                c == '\r' -> b.append("\\r")
                c == '\t' -> b.append("\\t")
                // U+2028/9 are line terminators in JavaScript source: escaped, so the script stays one statement.
                c < ' ' || c == ' ' || c == ' ' -> b.append(String.format(Locale.ROOT, "\\u%04x", c.code))
                else -> b.append(c)
            }
        }
        return b.append('"').toString()
    }
}

/**
 * Just enough JSON for the web's messages: one flat object of strings, numbers
 * and booleans. Anything else, nested or malformed, is refused rather than
 * half-read.
 */
internal object FlatJson {
    fun parse(text: String): Map<String, Any>? {
        val p = Parser(text.trim())
        return try {
            val m = p.obj()
            if (!p.atEnd()) null else m
        } catch (_: IllegalStateException) {
            null
        }
    }

    private class Parser(val s: String) {
        var i = 0
        fun atEnd(): Boolean { ws(); return i == s.length }
        private fun ws() { while (i < s.length && s[i].isWhitespace()) i++ }
        private fun expect(c: Char) { ws(); check(i < s.length && s[i] == c); i++ }
        fun obj(): Map<String, Any> {
            expect('{')
            val out = LinkedHashMap<String, Any>()
            ws()
            if (i < s.length && s[i] == '}') { i++; return out }
            while (true) {
                ws(); val key = string()
                expect(':')
                out[key] = value()
                ws(); check(i < s.length)
                if (s[i] == ',') { i++; continue }
                check(s[i] == '}'); i++
                return out
            }
        }
        private fun value(): Any {
            ws(); check(i < s.length)
            return when (val c = s[i]) {
                '"' -> string()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                else -> { check(c == '-' || c.isDigit()); number() }
            }
        }
        private fun literal(word: String, v: Boolean): Boolean {
            check(s.startsWith(word, i)); i += word.length; return v
        }
        private fun number(): Double {
            val start = i
            while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
            return s.substring(start, i).toDoubleOrNull() ?: throw IllegalStateException("number")
        }
        private fun string(): String {
            check(i < s.length && s[i] == '"'); i++
            val b = StringBuilder()
            while (true) {
                check(i < s.length)
                val c = s[i++]
                when (c) {
                    '"' -> return b.toString()
                    '\\' -> {
                        check(i < s.length)
                        when (val e = s[i++]) {
                            'n' -> b.append('\n'); 't' -> b.append('\t'); 'r' -> b.append('\r')
                            'b' -> b.append('\b'); 'f' -> b.append('\u000c')
                            'u' -> { check(i + 4 <= s.length); b.append(s.substring(i, i + 4).toInt(16).toChar()); i += 4 }
                            else -> b.append(e)
                        }
                    }
                    else -> b.append(c)
                }
            }
        }
    }
}
