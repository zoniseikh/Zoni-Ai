package com.zoni.jarvis.assistant.service

import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import com.zoni.jarvis.assistant.R
import com.zoni.jarvis.assistant.ui.MainActivity
import kotlin.math.abs

/**
 * Genuine Android SYSTEM_ALERT_WINDOW Floating Arc Reactor Orb Overlay.
 * Floats cleanly above any Android app; tap to summon Zoni AI, drag to reposition, long-press to dismiss.
 */
class FloatingOrbService : Service() {

    private var windowManager: WindowManager? = null
    private var orbView: View? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP || !Settings.canDrawOverlays(this)) {
            removeOrb()
            stopSelf()
            return START_NOT_STICKY
        }
        if (orbView == null) {
            showOrb()
        }
        return START_STICKY
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun showOrb() {
        val wm = getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return
        windowManager = wm

        val density = resources.displayMetrics.density
        val orbSizePx = (60 * density).toInt()

        val container = FrameLayout(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#EE020617"))
                setStroke((2.5f * density).toInt(), Color.parseColor("#06B6D4"))
            }
            elevation = 12 * density
        }

        val icon = ImageView(this).apply {
            setImageResource(R.drawable.ic_launcher_foreground)
            val pad = (6 * density).toInt()
            setPadding(pad, pad, pad, pad)
        }
        container.addView(icon, FrameLayout.LayoutParams(orbSizePx, orbSizePx))

        val layoutType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        val params = WindowManager.LayoutParams(
            orbSizePx,
            orbSizePx,
            layoutType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = (24 * density).toInt()
            y = (220 * density).toInt()
        }

        var startX = 0
        var startY = 0
        var touchStartX = 0f
        var touchStartY = 0f
        var moved = false

        container.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = params.x
                    startY = params.y
                    touchStartX = event.rawX
                    touchStartY = event.rawY
                    moved = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - touchStartX).toInt()
                    val dy = (event.rawY - touchStartY).toInt()
                    if (abs(dx) > 8 || abs(dy) > 8) moved = true
                    params.x = startX + dx
                    params.y = startY + dy
                    wm.updateViewLayout(container, params)
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!moved) {
                        val launch = Intent(this, MainActivity::class.java).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                            putExtra(MainActivity.EXTRA_AUTO_VOICE, true)
                        }
                        startActivity(launch)
                    }
                    true
                }
                else -> false
            }
        }

        container.setOnLongClickListener {
            removeOrb()
            stopSelf()
            true
        }

        orbView = container
        isRunning = true
        wm.addView(container, params)
    }

    private fun removeOrb() {
        orbView?.let { view ->
            try {
                windowManager?.removeView(view)
            } catch (_: Exception) {
            }
        }
        orbView = null
        isRunning = false
    }

    override fun onDestroy() {
        removeOrb()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "com.zoni.jarvis.assistant.ORB_START"
        const val ACTION_STOP = "com.zoni.jarvis.assistant.ORB_STOP"

        @Volatile
        var isRunning: Boolean = false
            private set

        fun start(context: Context): Boolean {
            if (!Settings.canDrawOverlays(context)) return false
            val intent = Intent(context, FloatingOrbService::class.java).apply {
                action = ACTION_START
            }
            context.startService(intent)
            return true
        }

        fun stop(context: Context) {
            val intent = Intent(context, FloatingOrbService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }
}
