# Feature 11 — Background Service & Doze Handling

> Keeps the MQTT connection alive when the app is in the background using a
> foreground service. Handles Android Doze mode, OEM battery killers, and WARP
> VPN lifecycle.

## Dependencies

- **Feature 02** — MQTT Connectivity (MqttManager)
- **Feature 10** — Push Notifications (notification channels, ntfy as backup)

## Depended On By

- Feature 12 (Settings — toggle for background service)

---

## Objective

Implement an Android foreground service that maintains the MQTT connection when
the app goes to the background. This ensures real-time events continue flowing
(for notification triggers) even when the user isn't looking at the app. When
the foreground service is killed by Android or OEM battery management, fall back
to ntfy.sh polling (Feature 10).

---

## Architecture

```
App State         MQTT             Notifications       Data
─────────────    ──────────       ───────────────     ──────
Foreground  ───▶ Connected  ───▶ Inline (UI)     ──▶ Real-time

Background  ───▶ FG Service ───▶ System notif    ──▶ Real-time
                 MQTT alive       from MQTT events    (30s delay)

Killed      ───▶ Disconnected ─▶ ntfy.sh poll    ──▶ Catchup on
                                  (15m interval)      next open
```

---

## Key Files

```
app/src/main/kotlin/bar/bto/meshsix/
├── service/
│   ├── MqttForegroundService.kt     # The foreground service
│   ├── ServiceController.kt         # Start/stop logic
│   └── DozeHelper.kt               # Battery optimization helper
```

---

## Implementation Tasks

### 11.1 — MqttForegroundService

```kotlin
class MqttForegroundService : Service() {

    @Inject lateinit var mqttManager: MqttManager
    @Inject lateinit var ntfyReceiver: NtfyReceiver
    @Inject lateinit var sessionRepository: SessionRepository
    @Inject lateinit var taskRepository: TaskRepository

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onCreate() {
        super.onCreate()

        // Start as foreground service immediately
        val notification = createServiceNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        // Ensure MQTT is connected
        serviceScope.launch {
            mqttManager.connect()
        }

        // Start ntfy SSE as supplementary channel
        ntfyReceiver.startSse()

        // Monitor MQTT events for notification-worthy items
        serviceScope.launch {
            monitorForNotifications()
        }
    }

    override fun onDestroy() {
        serviceScope.cancel()
        ntfyReceiver.stopSse()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createServiceNotification(): Notification {
        return NotificationCompat.Builder(this, NotificationChannels.MQTT_SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("mesh-six")
            .setContentText("Monitoring agent events")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    /**
     * Watch for events that should trigger notifications while backgrounded.
     */
    private suspend fun monitorForNotifications() {
        // Watch for session errors
        sessionRepository.sessions.collect { sessions ->
            sessions.values.forEach { session ->
                val recentErrors = session.events
                    .filter { it.status == "failed" }
                    .filter { it.timestamp > System.currentTimeMillis() - 30_000 }

                recentErrors.forEach { error ->
                    showNotification(
                        title = "Session Error",
                        message = "${error.toolName ?: "Tool"} failed: ${error.error ?: "unknown"}",
                        channel = NotificationChannels.ERRORS,
                    )
                }
            }
        }
    }

    private fun showNotification(title: String, message: String, channel: String) {
        val notification = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(message)
            .setAutoCancel(true)
            .setContentIntent(createOpenAppIntent())
            .build()

        NotificationManagerCompat.from(this).notify(
            System.currentTimeMillis().toInt(),
            notification,
        )
    }

    companion object {
        const val NOTIFICATION_ID = 1001
    }
}
```

### 11.2 — AndroidManifest Declarations

```xml
<service
    android:name=".service.MqttForegroundService"
    android:exported="false"
    android:foregroundServiceType="dataSync" />
```

### 11.3 — ServiceController

```kotlin
@Singleton
class ServiceController @Inject constructor(
    @ApplicationContext private val context: Context,
    private val settingsRepository: SettingsRepository,
) {
    fun startService() {
        val intent = Intent(context, MqttForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
    }

    fun stopService() {
        val intent = Intent(context, MqttForegroundService::class.java)
        context.stopService(intent)
    }

    /**
     * Start or stop based on settings.
     */
    suspend fun syncWithSettings() {
        settingsRepository.backgroundServiceEnabled.collect { enabled ->
            if (enabled) startService() else stopService()
        }
    }
}
```

### 11.4 — DozeHelper

```kotlin
object DozeHelper {
    /**
     * Check if the app is exempt from battery optimization.
     */
    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        val pm = context.getSystemService(PowerManager::class.java)
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * Prompt the user to disable battery optimization for this app.
     * This is important for MQTT keepalive reliability.
     */
    fun requestBatteryOptimizationExemption(context: Context) {
        if (!isIgnoringBatteryOptimizations(context)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
            context.startActivity(intent)
        }
    }
}
```

### 11.5 — Notification Grouping

When the app is backgrounded and receiving many events, group notifications:

```kotlin
/**
 * Group multiple events into a summary notification.
 * Instead of showing 10 individual "PostToolUse" notifications,
 * show one summary: "5 new events in session abc123"
 */
class NotificationGrouper {
    private val pendingNotifications = mutableMapOf<String, MutableList<String>>()

    fun addEvent(sessionId: String, summary: String) {
        pendingNotifications.getOrPut(sessionId) { mutableListOf() }.add(summary)
    }

    fun flush(): List<GroupedNotification> {
        val groups = pendingNotifications.map { (sessionId, events) ->
            GroupedNotification(
                sessionId = sessionId,
                count = events.size,
                summary = if (events.size == 1) events.first()
                    else "${events.size} events in session ${sessionId.take(8)}",
            )
        }
        pendingNotifications.clear()
        return groups
    }
}
```

---

## Android Doze Mode Handling

| Doze State | MQTT Behavior | Notification Path |
|-----------|---------------|-------------------|
| Active | Full connectivity | Inline UI |
| Idle (light doze) | Maintenance windows every ~15m | MQTT events during windows + ntfy |
| Deep doze | No network access | ntfy polling only (WorkManager) |
| App standby | Reduced execution | ntfy polling only |

**Strategy**: Don't fight Doze. Accept that MQTT will be disrupted. Use ntfy as
the reliable backup. When the app returns to foreground, MQTT reconnects and the
repositories catch up via the REST API.

---

## Acceptance Criteria

- [ ] Foreground service starts when the user enables it in Settings
- [ ] Foreground service shows a persistent, low-priority notification
- [ ] MQTT connection stays alive while the foreground service is running
- [ ] Notifications appear for errors and critical events while backgrounded
- [ ] Notifications are grouped when multiple events occur
- [ ] Service stops cleanly when the user disables it
- [ ] Battery optimization exemption request dialog is shown on first enable
- [ ] Service survives screen lock and brief Doze periods
- [ ] ntfy SSE runs alongside MQTT in the foreground service
- [ ] Service type is `DATA_SYNC` for Android 14+ compliance

---

## Notes for Implementer

- Use `FOREGROUND_SERVICE_TYPE_DATA_SYNC` for Android 14+ (API 34).
- Don't generate excessive notifications. Only notify for: errors, agent offline, project blocked, Claude Code needing input. Tool completions should NOT generate notifications.
- The foreground service notification should be minimal and non-intrusive (IMPORTANCE_MIN channel).
- Hilt injection in Services requires `@AndroidEntryPoint` on the Service class and the `hilt-android` service dependency.
- Test on a real Pixel device — emulator Doze behavior differs from physical hardware.
- On OEM devices (Samsung, Xiaomi, OnePlus), the user may need to manually whitelist the app from battery restrictions. Feature 12 (Settings) should provide guidance.
