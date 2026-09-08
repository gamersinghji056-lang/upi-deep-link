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
 * Keeps every WPAY screen inside the real Android status/navigation/cutout safe area.
 * Android 15+ enforces edge-to-edge for targetSdk 35, so the listener is installed
 * after the Activity has finished creating its content view rather than assuming the
 * root child already exists during the lifecycle callback.
 */
class WpayApplication : Application(), Application.ActivityLifecycleCallbacks {
    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(this)
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        applyDarkSystemBars(activity)
        activity.window.decorView.post { installSafeArea(activity) }
    }

    private fun installSafeArea(activity: Activity) {
        if (activity.isFinishing || (Build.VERSION.SDK_INT >= 17 && activity.isDestroyed)) return
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
        activity.window.statusBarColor = Color.rgb(9, 6, 23)
        activity.window.navigationBarColor = Color.rgb(9, 6, 23)
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
