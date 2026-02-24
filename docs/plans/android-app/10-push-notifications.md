# Feature 10 — Push Notifications via ntfy.sh

> Enables push notifications when the app is in the background or the process is
> killed. Uses self-hosted ntfy.sh — no Firebase/Google Play Services dependency.

## Dependencies

- **Feature 01** — Project Setup (permissions, Hilt)

## Depended On By

- Feature 11 (Background Service — ntfy as backup when MQTT dies)
- Feature 12 (Settings — notification preferences)

---

## Objective

Integrate with a self-hosted ntfy.sh instance to receive push notifications for
critical mesh-six events (session errors, task failures, agent going offline,
project blocked). ntfy.sh is the only reliable notification path when Android
kills the background MQTT service (OEM battery killers, Doze mode).

---

## Architecture

```
┌────────────────┐          ┌──────────────────┐          ┌──────────────┐
│  mesh-six      │──POST──▶ │  ntfy.sh         │──SSE/──▶ │  Android App │
│  (any agent)   │          │  (self-hosted)    │  Poll    │  NtfyReceiver│
│                │          │  ntfy.bto.bar     │          │              │
└────────────────┘          └──────────────────┘          └──────────────┘
```

**Server side**: Any mesh-six agent or the orchestrator publishes to ntfy when
critical events occur:
```bash
curl -d "Task deploy-service failed: timeout after 120s" \
  -H "Title: Task Failed" \
  -H "Priority: high" \
  -H "Tags: warning" \
  https://ntfy.bto.bar/mesh-six-alerts
```

**Client side**: The Android app subscribes to the ntfy topic via:
1. **SSE (Server-Sent Events)** when the app has a foreground service
2. **Periodic polling** via WorkManager when the app is fully backgrounded
3. **UnifiedPush** (optional future enhancement) for instant delivery

---

## Notification Categories

| Category | Priority | Trigger | Examples |
|----------|----------|---------|----------|
| Error | High (urgent) | Task failure, agent crash | "Task deploy-service failed: timeout" |
| Alert | Default | Agent degraded, project blocked | "argocd-deployer is degraded" |
| Info | Low | Session ended, project state change | "Session abc123 ended (312 events)" |
| Blocked | Max (urgent) | Claude Code needs input | "Claude Code needs permission approval" |

---

## Key Files

```
app/src/main/kotlin/bar/bto/meshsix/
├── push/
│   ├── NtfyReceiver.kt            # SSE listener + message parser
│   ├── NtfyConfig.kt              # Server URL, topic, auth configuration
│   ├── NtfyModule.kt              # Hilt module
│   └── NotificationChannels.kt    # Android notification channel setup
```

---

## Implementation Tasks

### 10.1 — NtfyConfig

```kotlin
data class NtfyConfig(
    val serverUrl: String,        // "https://ntfy.bto.bar"
    val topic: String,            // "mesh-six-alerts"
    val authToken: String? = null, // Optional bearer token for private topics
    val pollIntervalMinutes: Int = 15,
)
```

### 10.2 — NotificationChannels

Create Android notification channels on app startup:

```kotlin
object NotificationChannels {
    const val ERRORS = "mesh_six_errors"
    const val ALERTS = "mesh_six_alerts"
    const val INFO = "mesh_six_info"
    const val BLOCKED = "mesh_six_blocked"
    const val MQTT_SERVICE = "mesh_six_mqtt_service"

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)

        manager.createNotificationChannels(listOf(
            NotificationChannel(ERRORS, "Errors", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Task failures and agent crashes"
                enableVibration(true)
            },
            NotificationChannel(ALERTS, "Alerts", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Agent degraded, project blocked"
            },
            NotificationChannel(INFO, "Info", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Session ended, project state changes"
            },
            NotificationChannel(BLOCKED, "Blocked", NotificationManager.IMPORTANCE_MAX).apply {
                description = "Claude Code needs user input"
                enableVibration(true)
                setBypassDnd(true)
            },
            NotificationChannel(MQTT_SERVICE, "MQTT Service", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Background MQTT connection"
                setShowBadge(false)
            },
        ))
    }
}
```

### 10.3 — NtfyReceiver

```kotlin
@Singleton
class NtfyReceiver @Inject constructor(
    @ApplicationContext private val context: Context,
    private val config: NtfyConfig,
    private val okHttpClient: OkHttpClient,
) {
    private var eventSource: EventSource? = null

    /**
     * Start listening for ntfy messages via SSE.
     * Called when the foreground service starts.
     */
    fun startSse() {
        val url = "${config.serverUrl}/${config.topic}/sse"
        val request = Request.Builder()
            .url(url)
            .apply {
                config.authToken?.let {
                    addHeader("Authorization", "Bearer $it")
                }
            }
            .build()

        val factory = EventSources.createFactory(okHttpClient)
        eventSource = factory.newEventSource(request, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                handleNtfyMessage(data)
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                // Reconnect after delay
            }
        })
    }

    /**
     * Stop SSE listener.
     */
    fun stopSse() {
        eventSource?.cancel()
        eventSource = null
    }

    /**
     * Poll for new messages (used by WorkManager when SSE isn't running).
     */
    suspend fun poll(since: String = "30m"): List<NtfyMessage> {
        val url = "${config.serverUrl}/${config.topic}/json?since=$since&poll=1"
        val request = Request.Builder().url(url).build()

        return withContext(Dispatchers.IO) {
            val response = okHttpClient.newCall(request).execute()
            val body = response.body?.string() ?: return@withContext emptyList()
            body.lines()
                .filter { it.isNotBlank() }
                .mapNotNull { line ->
                    try { Json.decodeFromString<NtfyMessage>(line) } catch (_: Exception) { null }
                }
        }
    }

    private fun handleNtfyMessage(data: String) {
        val message = try {
            Json.decodeFromString<NtfyMessage>(data)
        } catch (_: Exception) { return }

        val (channelId, importance) = when {
            message.priority >= 5 -> NotificationChannels.BLOCKED to NotificationCompat.PRIORITY_MAX
            message.priority >= 4 -> NotificationChannels.ERRORS to NotificationCompat.PRIORITY_HIGH
            message.priority >= 3 -> NotificationChannels.ALERTS to NotificationCompat.PRIORITY_DEFAULT
            else -> NotificationChannels.INFO to NotificationCompat.PRIORITY_LOW
        }

        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(message.title ?: "mesh-six")
            .setContentText(message.message)
            .setPriority(importance)
            .setAutoCancel(true)
            .setContentIntent(createPendingIntent(message))
            .build()

        NotificationManagerCompat.from(context).notify(message.id.hashCode(), notification)
    }
}

@Serializable
data class NtfyMessage(
    val id: String,
    val time: Long,
    val event: String = "message",
    val topic: String,
    val message: String,
    val title: String? = null,
    val priority: Int = 3,
    val tags: List<String> = emptyList(),
    val click: String? = null,
)
```

### 10.4 — Polling Worker (WorkManager)

```kotlin
class NtfyPollWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    @Inject lateinit var ntfyReceiver: NtfyReceiver

    override suspend fun doWork(): Result {
        val messages = ntfyReceiver.poll(since = "15m")
        messages.forEach { ntfyReceiver.handleNtfyMessage(Json.encodeToString(it)) }
        return Result.success()
    }
}

// Schedule in Application.onCreate():
val pollRequest = PeriodicWorkRequestBuilder<NtfyPollWorker>(15, TimeUnit.MINUTES)
    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
    .build()
WorkManager.getInstance(context).enqueueUniquePeriodicWork(
    "ntfy-poll",
    ExistingPeriodicWorkPolicy.KEEP,
    pollRequest,
)
```

---

## Server-Side Integration (Reference)

For completeness, mesh-six agents should publish to ntfy. This is NOT part of the
Android app feature but is needed for notifications to arrive:

```typescript
// In orchestrator or any agent, on critical events:
async function notifyNtfy(title: string, message: string, priority: number = 3) {
  await fetch("https://ntfy.bto.bar/mesh-six-alerts", {
    method: "POST",
    headers: {
      "Title": title,
      "Priority": String(priority),
      "Tags": priority >= 4 ? "warning" : "info",
    },
    body: message,
  });
}
```

---

## Acceptance Criteria

- [ ] App creates notification channels on startup (errors, alerts, info, blocked)
- [ ] NtfyReceiver connects to ntfy.sh via SSE when foreground service is running
- [ ] Notifications appear with correct channel/priority based on ntfy priority
- [ ] Tapping a notification opens the app to the relevant screen
- [ ] WorkManager polls ntfy every 15 minutes when SSE is not active
- [ ] Polling worker correctly parses ntfy JSON-lines response
- [ ] Auth token is sent when configured
- [ ] SSE reconnects automatically on connection loss
- [ ] Notification permission requested on Android 13+ (POST_NOTIFICATIONS)
- [ ] Settings screen can enable/disable notification categories

---

## Notes for Implementer

- ntfy.sh is self-hosted at `ntfy.bto.bar`. No Firebase dependency.
- The ntfy JSON-lines format returns one JSON object per line, not a JSON array.
- For SSE, use OkHttp's `EventSource` from the `okhttp-sse` artifact.
- Android 13+ requires runtime permission for `POST_NOTIFICATIONS`.
- The polling interval (15 minutes) is the minimum for `PeriodicWorkRequest`.
- Consider using the `since=` parameter with a stored timestamp to avoid duplicate notifications.
- ntfy topic should be configurable in Settings (Feature 12).
