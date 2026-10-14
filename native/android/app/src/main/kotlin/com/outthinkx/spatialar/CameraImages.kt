package com.outthinkx.spatialar

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.util.Base64
import com.google.ar.core.Coordinates2d
import com.google.ar.core.Frame
import java.io.ByteArrayOutputStream

/**
 * The camera frame as the screen shows it, as a JPEG: for recognition in the
 * web app.
 *
 * ARCore's CPU image is the whole sensor frame, in the sensor's orientation.
 * The screen shows a rotated, cropped part of it, and the field of view the
 * web app is told about is the screen's. So the image is cut to exactly what
 * the screen shows, the right way up: then the web app's projection, its
 * intrinsics and this picture all describe the same view, as they do in the
 * browser.
 */
object CameraImages {
    /** Base64 JPEG and its size, or null when ARCore has no CPU image yet. */
    fun visibleJpeg(frame: Frame, maxWidth: Int, quality: Int = 80): Triple<String, Int, Int>? {
        val image = try {
            frame.acquireCameraImage()
        } catch (_: Exception) {
            return null
        }
        val sensor = image.use { toBitmap(it) } ?: return null

        // Where the view's top-left, top-right and bottom-left corners are in the sensor image.
        val view = floatArrayOf(0f, 0f, 1f, 0f, 0f, 1f)
        val pixels = FloatArray(6)
        frame.transformCoordinates2d(Coordinates2d.VIEW_NORMALIZED, view, Coordinates2d.IMAGE_PIXELS, pixels)
        val across = Math.hypot((pixels[2] - pixels[0]).toDouble(), (pixels[3] - pixels[1]).toDouble())
        val down = Math.hypot((pixels[4] - pixels[0]).toDouble(), (pixels[5] - pixels[1]).toDouble())
        if (across < 1 || down < 1) return null
        val scale = minOf(1.0, maxWidth / across)
        val w = maxOf(1, (across * scale).toInt())
        val h = maxOf(1, (down * scale).toInt())

        // Map those three sensor points onto the output's corners: crop, turn and scale in one.
        val matrix = Matrix()
        matrix.setPolyToPoly(pixels, 0, floatArrayOf(0f, 0f, w.toFloat(), 0f, 0f, h.toFloat()), 0, 3)
        val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        Canvas(out).drawBitmap(sensor, matrix, Paint(Paint.FILTER_BITMAP_FLAG))
        sensor.recycle()

        val bytes = ByteArrayOutputStream()
        out.compress(Bitmap.CompressFormat.JPEG, quality, bytes)
        out.recycle()
        return Triple(Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP), w, h)
    }

    /** YUV_420_888 to a bitmap, through NV21 and the platform's JPEG codec. */
    private fun toBitmap(image: Image): Bitmap? {
        if (image.format != ImageFormat.YUV_420_888) return null
        val w = image.width
        val h = image.height
        val nv21 = ByteArray(w * h * 3 / 2)
        val (y, u, v) = image.planes
        // Luma, row by row: the row stride may be wider than the image.
        var o = 0
        for (row in 0 until h) {
            y.buffer.position(row * y.rowStride)
            y.buffer.get(nv21, o, w)
            o += w
        }
        // Chroma, interleaved V then U, at half resolution.
        for (row in 0 until h / 2) {
            for (col in 0 until w / 2) {
                nv21[o++] = v.buffer.get(row * v.rowStride + col * v.pixelStride)
                nv21[o++] = u.buffer.get(row * u.rowStride + col * u.pixelStride)
            }
        }
        val jpeg = ByteArrayOutputStream()
        if (!YuvImage(nv21, ImageFormat.NV21, w, h, null).compressToJpeg(Rect(0, 0, w, h), 90, jpeg)) return null
        val bytes = jpeg.toByteArray()
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }
}
