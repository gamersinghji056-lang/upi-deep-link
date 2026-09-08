package org.wtron.wpayagent

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper

class SplashActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_splash)
        Handler(Looper.getMainLooper()).postDelayed({
            val next = if (AgentStore(this).isPaired) MonitorActivity::class.java else MainActivity::class.java
            startActivity(Intent(this, next))
            finish()
        }, 850)
    }
}
