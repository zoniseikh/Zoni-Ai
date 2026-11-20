package com.zoni.jarvis.assistant.screen

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import com.zoni.jarvis.assistant.service.ScreenCaptureService
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

data class ScreenCaptureFrameResult(
    val success: Boolean,
    val base64Jpeg: String = "",
    val width: Int = 0,
    val height: Int = 0,
    val error: String = ""
)

/**
 * Transparent, user-authorized Android MediaProjection screen capture manager.
 *
 * Privacy & Policy Guarantees:
 * - Never captures without an active Android MediaProjection consent token granted by the user.
 * - Requires [ScreenCaptureService] foreground service with persistent notification while active.
 * - Immediately releases VirtualDisplay, ImageReader, and MediaProjection when stopped or revoked.
 * - Handles FLAG_SECURE / protected screens gracefully without crashing.
 */
object ScreenCaptureManager {

    @Volatile
    private var mediaProjection: MediaProjection? = null

    @Volatile
    private var isAuthorized: Boolean = false

    private var captureThread: HandlerThread? = null
    private var captureHandler: Handler? = null

    fun isActive(): Boolean = isAuthorized && mediaProjection != null

    @Synchronized
    fun onConsentGranted(context: Context, resultCode: Int, data: Intent): Boolean {
        stopCapture(context)
        return try {
            val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
                ?: return false
            val projection = manager.getMediaProjection(resultCode, data) ?: return false

            val thread = HandlerThread("ZoniScreenCaptureThread").apply { start() }
            val handler = Handler(thread.looper)
            captureThread = thread
            captureHandler = handler

            projection.registerCallback(
                object : MediaProjection.Callback() {
                    override fun onStop() {
                        stopCapture(context.applicationContext)
                    }
                },
                handler
            )

            mediaProjection = projection
            isAuthorized = true
            true
        } catch (_: Exception) {
            stopCapture(context)
            false
        }
    }

    /**
     * Captures a single on-demand JPEG frame (max dimension 1080px) when the user explicitly
     * asks Zoni AI to read or explain what is on the screen.
     */
    fun captureSingleFrameBase64(context: Context, maxDimension: Int = 1080): ScreenCaptureFrameResult {
        val projection = mediaProjection
        if (!isAuthorized || projection == null) {
            return ScreenCaptureFrameResult(
                success = false,
                error = "Screen capture permission is not active. Please grant MediaProjection consent first."
            )
        }

        val handler = captureHandler ?: return ScreenCaptureFrameResult(
            success = false,
            error = "Screen capture worker thread is not initialized."
        )

        val metrics = getDisplayMetrics(context)
        val rawWidth = metrics.widthPixels.coerceAtLeast(360)
        val rawHeight = metrics.heightPixels.coerceAtLeast(640)
        val scale = if (maxOf(rawWidth, rawHeight) > maxDimension) {
            maxDimension.toFloat() / maxOf(rawWidth, rawHeight).toFloat()
        } else {
            1.0f
        }
        val width = (rawWidth * scale).toInt().coerceAtLeast(320)
        val height = (rawHeight * scale).toInt().coerceAtLeast(320)
        val densityDpi = metrics.densityDpi.coerceAtLeast(160)

        var imageReader: ImageReader? = null
        var virtualDisplay: VirtualDisplay? = null

        return try {
            imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
            val latch = CountDownLatch(1)
            var capturedBitmap: Bitmap? = null

            imageReader.setOnImageAvailableListener({ reader ->
                if (capturedBitmap != null) return@setOnImageAvailableListener
                val image = try {
                    reader.acquireLatestImage()
                } catch (_: Exception) {
                    null
                } ?: return@setOnImageAvailableListener

                try {
                    val planes = image.planes
                    val buffer = planes[0].buffer
                    val pixelStride = planes[0].pixelStride
                    val rowStride = planes[0].rowStride
                    val rowPadding = rowStride - pixelStride * width
                    val paddedWidth = width + rowPadding / pixelStride

                    val rawBmp = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888)
                    rawBmp.copyPixelsFromBuffer(buffer)
                    capturedBitmap = if (paddedWidth != width) {
                        val cropped = Bitmap.createBitmap(rawBmp, 0, 0, width, height)
                        rawBmp.recycle()
                        cropped
                    } else {
                        rawBmp
                    }
                    latch.countDown()
                } catch (_: Exception) {
                    latch.countDown()
                } finally {
                    image.close()
                }
            }, handler)

            virtualDisplay = projection.createVirtualDisplay(
                "ZoniScreenAwareness",
                width,
                height,
                densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader.surface,
                null,
                handler
            )

            val received = latch.await(2500, TimeUnit.MILLISECONDS)
            val bmp = capturedBitmap
            if (!received || bmp == null) {
                ScreenCaptureFrameResult(
                    success = false,
                    error = "Could not capture the current screen frame. Protected/FLAG_SECURE screens cannot be captured."
                )
            } else {
                val out = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.JPEG, 78, out)
                val w = bmp.width
                val h = bmp.height
                bmp.recycle()
                val encoded = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                ScreenCaptureFrameResult(
                    success = true,
                    base64Jpeg = encoded,
                    width = w,
                    height = h
                )
            }
        } catch (sec: SecurityException) {
            ScreenCaptureFrameResult(
                success = false,
                error = "Screen capture permission was revoked or restricted by Android OS."
            )
        } catch (e: Exception) {
            ScreenCaptureFrameResult(
                success = false,
                error = e.message ?: "Screen capture failed."
            )
        } finally {
            try {
                virtualDisplay?.release()
            } catch (_: Exception) {}
            try {
                imageReader?.close()
            } catch (_: Exception) {}
        }
    }

    @Synchronized
    fun stopCapture(context: Context? = null) {
        isAuthorized = false
        try {
            mediaProjection?.stop()
        } catch (_: Exception) {}
        mediaProjection = null

        try {
            captureThread?.quitSafely()
        } catch (_: Exception) {}
        captureThread = null
        captureHandler = null

        if (context != null) {
            ScreenCaptureService.stop(context)
        }
    }

    private fun getDisplayMetrics(context: Context): DisplayMetrics {
        val metrics = DisplayMetrics()
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
        @Suppress("DEPRECATION")
        wm?.defaultDisplay?.getRealMetrics(metrics)
        if (metrics.widthPixels <= 0 || metrics.heightPixels <= 0) {
            return context.resources.displayMetrics
        }
        return metrics
    }
}
