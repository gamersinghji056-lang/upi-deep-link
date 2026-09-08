package org.wtron.wpayagent

import android.app.Activity
import android.app.Application
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController

/**
 * Applies Android system-bar safe areas to every WPAY screen.
 *
 * Android 15 enforces edge-to-edge for apps targeting API 35, which otherwise lets
 * the status bar cover the WPAY header and the navigation bar cover the bottom tabs.
 * This keeps the dark app background edge-to-edge while moving all tappable content
 * inside the status/navigation/cutout safe area. It does not rely on the temporary
 * Android 15 edge-to-edge opt-out, so it remains compatible with Android 16+.
 */
class WpayApplication : Application(), Application.ActivityLifecycleCallbacks {
    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(this)
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        applyDarkSystemBars(activity)

        val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
        val root = content.getChildAt(0) ?: return
        val baseLeft = root.paddingLeft
        val baseTop = root.paddingTop
        val baseRight = root.paddingRight
        val baseBottom = root.paddingBottom

        root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = systemBarInsets(insets)
            view.setPadding(
                baseLeft + bars[0],
                baseTop + bars[1],
                baseRight + bars[2],
                baseBottom + bars[3]
            )
            insets
        }
        root.requestApplyInsets()
    }

    private fun applyDarkSystemBars(activity: Activity) {
        activity.window.decorView.setBackgroundColor(Color.rgb(9, 6, 23))
        if (Build.VERSION.SDK_INT >= 30) {
            activity.window.insetsController?.setSystemBarsAppearance(
                0,
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                    WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            )
        } else {
            @Suppress("DEPRECATION")
            activity.window.decorView.systemUiVisibility =
                activity.window.decorView.systemUiVisibility and
                    View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv() and
                    View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
        }
    }

    private fun systemBarInsets(insets: WindowInsets): IntArray {
        return if (Build.VERSION.SDK_INT >= 30) {
            val safe = insets.getInsets(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
            )
            intArrayOf(safe.left, safe.top, safe.right, safe.bottom)
        } else {
            @Suppress("DEPRECATION")
            intArrayOf(
                insets.systemWindowInsetLeft,
                insets.systemWindowInsetTop,
                insets.systemWindowInsetRight,
                insets.systemWindowInsetBottom
            )
        }
    }

    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
