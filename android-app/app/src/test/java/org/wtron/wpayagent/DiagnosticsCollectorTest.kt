package org.wtron.wpayagent

import android.os.BatteryManager
import org.junit.Assert.assertEquals
import org.junit.Test

class DiagnosticsCollectorTest {
    @Test
    fun mapsBatteryHealthStates() {
        assertEquals("Good", DiagnosticsCollector.batteryHealthLabel(BatteryManager.BATTERY_HEALTH_GOOD))
        assertEquals("Overheating", DiagnosticsCollector.batteryHealthLabel(BatteryManager.BATTERY_HEALTH_OVERHEAT))
        assertEquals("Replace battery", DiagnosticsCollector.batteryHealthLabel(BatteryManager.BATTERY_HEALTH_DEAD))
        assertEquals("Over voltage", DiagnosticsCollector.batteryHealthLabel(BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE))
        assertEquals("Cold", DiagnosticsCollector.batteryHealthLabel(BatteryManager.BATTERY_HEALTH_COLD))
        assertEquals("Unknown", DiagnosticsCollector.batteryHealthLabel(BatteryManager.BATTERY_HEALTH_UNKNOWN))
    }
}
