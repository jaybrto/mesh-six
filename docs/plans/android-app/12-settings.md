# Feature 12 — Settings & Configuration Screen

> User-configurable settings for MQTT endpoints, notification preferences,
> background service toggles, and homelab connectivity diagnostics.

## Dependencies

- **Feature 02** — MQTT Connectivity (MqttConfig)
- **Feature 10** — Push Notifications (NtfyConfig)
- **Feature 11** — Background Service (ServiceController)

## Depended On By

- None (leaf feature)

---

## Objective

Build a settings screen that allows the user to configure all connection
parameters, notification preferences, and background service behavior. Includes
a connectivity diagnostics panel for troubleshooting homelab network issues.

---

## Wireframe

```
┌──────────────────────────────────────┐
│  ← Settings                          │
├──────────────────────────────────────┤
│                                      │
│  ─── Connection ──────────────────── │
│                                      │
│  MQTT LAN URL                        │
│  ┌────────────────────────────────┐  │
│  │ tcp://10.43.0.100:1883         │  │
│  └────────────────────────────────┘  │
│                                      │
│  MQTT WARP URL                       │
│  ┌────────────────────────────────┐  │
│  │ tcp://10.43.0.100:1883         │  │
│  └────────────────────────────────┘  │
│                                      │
│  MQTT WSS URL                        │
│  ┌────────────────────────────────┐  │
│  │ wss://mqtt.bto.bar/ws          │  │
│  └────────────────────────────────┘  │
│                                      │
│  API Base URL                        │
│  ┌────────────────────────────────┐  │
│  │ https://mesh-six.bto.bar       │  │
│  └────────────────────────────────┘  │
│                                      │
│  [Test Connection]                   │
│                                      │
│  ─── Notifications ───────────────── │
│                                      │
│  ntfy Server URL                     │
│  ┌────────────────────────────────┐  │
│  │ https://ntfy.bto.bar           │  │
│  └────────────────────────────────┘  │
│                                      │
│  ntfy Topic                          │
│  ┌────────────────────────────────┐  │
│  │ mesh-six-alerts                │  │
│  └────────────────────────────────┘  │
│                                      │
│  ntfy Auth Token (optional)          │
│  ┌────────────────────────────────┐  │
│  │ ••••••••••••                   │  │
│  └────────────────────────────────┘  │
│                                      │
│  Errors             [toggle ON ]     │
│  Alerts             [toggle ON ]     │
│  Info               [toggle OFF]     │
│  Blocked prompts    [toggle ON ]     │
│                                      │
│  ─── Background ──────────────────── │
│                                      │
│  Background service [toggle ON ]     │
│                                      │
│  Battery optimization                │
│  ┌────────────────────────────────┐  │
│  │ ⚠ Not exempt from battery     │  │
│  │    optimization. MQTT may be   │  │
│  │    interrupted in deep sleep.  │  │
│  │    [Disable optimization]      │  │
│  └────────────────────────────────┘  │
│                                      │
│  WARP VPN status                     │
│  ┌────────────────────────────────┐  │
│  │ ● VPN active                   │  │
│  │   Recommend: Enable Always-on  │  │
│  │   VPN in Android settings      │  │
│  └────────────────────────────────┘  │
│                                      │
│  ─── Diagnostics ─────────────────── │
│                                      │
│  Network: WiFi (homelab)             │
│  Transport: LAN TCP ● Connected      │
│  MQTT broker: 10.43.0.100:1883      │
│  Latency: 2ms                        │
│  Subscriptions: 5 active             │
│  Events received: 1,247              │
│                                      │
│  [Run Connectivity Test]             │
│                                      │
│  ─── About ───────────────────────── │
│                                      │
│  Version: 0.1.0                      │
│  Build: debug (2026-02-20)           │
│  Package: bar.bto.meshsix            │
│                                      │
├──────────────────────────────────────┤
│ [Home] [Agents] [Sessions] [Tasks]  │
└──────────────────────────────────────┘
```

---

## Key Files

```
app/src/main/kotlin/bar/bto/meshsix/
├── ui/
│   └── screens/
│       └── settings/
│           ├── SettingsScreen.kt         # Main settings composable
│           ├── SettingsViewModel.kt      # Settings logic
│           ├── ConnectionSection.kt      # MQTT/API URL fields
│           ├── NotificationSection.kt    # ntfy configuration
│           ├── BackgroundSection.kt      # Service + battery toggles
│           └── DiagnosticsSection.kt     # Connectivity diagnostics
```

---

## Implementation Tasks

### 12.1 — SettingsViewModel

```kotlin
@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val settingsRepository: SettingsRepository,
    private val mqttManager: MqttManager,
    private val serviceController: ServiceController,
) : ViewModel() {

    data class SettingsUiState(
        val mqttLanUrl: String = "",
        val mqttWarpUrl: String = "",
        val mqttWssUrl: String = "",
        val apiBaseUrl: String = "",
        val ntfyUrl: String = "",
        val ntfyTopic: String = "",
        val ntfyAuthToken: String = "",
        val notifyErrors: Boolean = true,
        val notifyAlerts: Boolean = true,
        val notifyInfo: Boolean = false,
        val notifyBlocked: Boolean = true,
        val backgroundServiceEnabled: Boolean = false,
        val isBatteryOptimized: Boolean = false,
        val isVpnActive: Boolean = false,
        val connectionState: ConnectionState = ConnectionState.Disconnected,
        val activeTransport: Transport? = null,
        val eventCount: Int = 0,
    )

    val uiState: StateFlow<SettingsUiState> // Combine settings + live state

    fun updateMqttLanUrl(url: String) { ... }
    fun updateMqttWssUrl(url: String) { ... }
    fun updateApiBaseUrl(url: String) { ... }
    fun updateNtfyUrl(url: String) { ... }
    fun updateNtfyTopic(topic: String) { ... }
    fun toggleBackgroundService(enabled: Boolean) { ... }
    fun toggleNotifyErrors(enabled: Boolean) { ... }
    fun testConnection() { ... }
    fun runDiagnostics() { ... }
}
```

### 12.2 — Connection Test

```kotlin
suspend fun testConnection(): ConnectionTestResult {
    val results = mutableListOf<TransportTestResult>()

    // Test each transport
    for ((transport, url) in connectionStrategy.getOrderedBrokers()) {
        val result = try {
            // Try to connect with a short timeout
            withTimeout(5000) {
                mqttManager.testTransport(url)
            }
            TransportTestResult(transport, url, true, null)
        } catch (e: Exception) {
            TransportTestResult(transport, url, false, e.message)
        }
        results.add(result)
    }

    return ConnectionTestResult(results)
}
```

### 12.3 — Diagnostics Panel

Real-time diagnostics showing:
- Current network type (WiFi SSID, cellular, VPN)
- Active MQTT transport and connection state
- Broker URL and ping latency
- Number of active subscriptions
- Total events received since app start
- Memory usage (in-memory event buffers)

### 12.4 — Battery Optimization Guidance

Show a card when the app is subject to battery optimization:

```kotlin
@Composable
fun BatteryOptimizationCard(
    isOptimized: Boolean,
    onDisableOptimization: () -> Unit,
) {
    if (isOptimized) {
        Card(
            colors = CardDefaults.cardColors(
                containerColor = MeshColors.Yellow.copy(alpha = 0.1f),
            ),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "Battery optimization is enabled",
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = "MQTT connection may be interrupted during deep sleep. " +
                        "Disable battery optimization for reliable background notifications.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(8.dp))
                Button(onClick = onDisableOptimization) {
                    Text("Disable optimization")
                }
            }
        }
    }
}
```

---

## Acceptance Criteria

- [ ] All URL fields are editable and persist to DataStore
- [ ] "Test Connection" attempts all transports and shows results
- [ ] Notification category toggles control which notifications appear
- [ ] Background service toggle starts/stops the foreground service
- [ ] Battery optimization status is shown with action button
- [ ] VPN status is detected and shown
- [ ] Diagnostics panel shows live connection metrics
- [ ] Changes to MQTT URLs trigger reconnection
- [ ] ntfy settings are saved and used by NtfyReceiver
- [ ] About section shows app version and build info

---

## Notes for Implementer

- Use Jetpack DataStore (Preferences) for all settings persistence.
- URL validation: check for valid URI format before saving.
- The "Test Connection" should be non-blocking and show a progress indicator.
- Diagnostics are read from `MqttManager` state and in-memory counters.
- The auth token field should use `visualTransformation = PasswordVisualTransformation()`.
- Build version/code should be read from `BuildConfig`.
