# Feature 02 — MQTT Connectivity Layer

> The backbone of real-time data flow. Handles connection to RabbitMQ MQTT broker
> with automatic failover between LAN, WARP, and WSS paths.

## Dependencies

- **Feature 01** — Project Setup (Gradle config, Hilt DI)

## Depended On By

- Feature 04 (Dashboard Home)
- Feature 05 (Agent Registry)
- Feature 06 (Claude Sessions)
- Feature 07 (Task Feed)
- Feature 08 (Project Lifecycle)
- Feature 11 (Background Service)
- Feature 12 (Settings)

---

## Objective

Implement a persistent MQTT connection manager that automatically selects the best
connection path (LAN TCP → WARP TCP → WSS fallback), exposes a Kotlin Flow-based
subscription API, handles Android lifecycle (foreground/background transitions),
and survives configuration changes.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    MqttManager (Singleton)                │
│                                                           │
│  ┌─────────────────┐   ┌─────────────────────────────┐  │
│  │ConnectionStrategy│   │      Topic Subscriptions    │  │
│  │                  │   │                              │  │
│  │ 1. Try LAN TCP  │   │  "claude/progress/#"  ────▶ Flow │
│  │ 2. Try WARP TCP │   │  "agent/registry/#"   ────▶ Flow │
│  │ 3. Fall to WSS  │   │  "agent/task/#"       ────▶ Flow │
│  │                  │   │  "agent/project/#"    ────▶ Flow │
│  └─────────────────┘   │  "llm.events"         ────▶ Flow │
│                         └─────────────────────────────┘  │
│                                                           │
│  connectionState: StateFlow<ConnectionState>              │
│  activeTransport: StateFlow<Transport>                    │
└───────────────────────────────────────────────────────────┘
```

---

## Key Files

```
app/src/main/kotlin/bar/bto/meshsix/
├── mqtt/
│   ├── MqttManager.kt           # Singleton MQTT client manager
│   ├── ConnectionStrategy.kt    # Multi-path failover logic
│   ├── MqttConfig.kt            # Connection configuration data class
│   └── MqttModule.kt            # Hilt module providing MqttManager
├── data/
│   └── models/
│       └── ConnectionState.kt   # Sealed class for connection states
```

---

## Implementation Tasks

### 2.1 — ConnectionState Model

```kotlin
sealed class ConnectionState {
    data object Disconnected : ConnectionState()
    data class Connecting(val transport: Transport) : ConnectionState()
    data class Connected(val transport: Transport) : ConnectionState()
    data class Error(val transport: Transport, val error: Throwable) : ConnectionState()
    data object Reconnecting : ConnectionState()
}

enum class Transport {
    LAN_TCP,   // Direct TCP to 10.43.x.x:1883
    WARP_TCP,  // TCP via Cloudflare WARP tunnel
    WSS        // WebSocket Secure to wss://mqtt.bto.bar/ws
}
```

### 2.2 — MqttConfig

```kotlin
data class MqttConfig(
    val lanBrokerUrl: String,     // "tcp://10.43.x.x:1883"
    val warpBrokerUrl: String,    // "tcp://10.43.x.x:1883" (same IP, different network path)
    val wssBrokerUrl: String,     // "wss://mqtt.bto.bar/ws"
    val clientIdPrefix: String = "mesh-six-android",
    val keepAliveSeconds: Int = 60,
    val connectionTimeoutSeconds: Int = 10,
    val cleanSession: Boolean = true,
    val autoReconnect: Boolean = true,
    val maxReconnectDelay: Int = 128, // seconds, exponential backoff cap
    val username: String? = null,
    val password: String? = null,
)
```

### 2.3 — ConnectionStrategy

The strategy tries each transport in order. On connection loss, it restarts the
strategy from the beginning.

```kotlin
class ConnectionStrategy(
    private val config: MqttConfig,
    private val networkMonitor: NetworkMonitor,
) {
    /**
     * Returns the ordered list of broker URIs to try.
     * Filters based on current network state:
     * - WiFi on homelab subnet → include LAN
     * - VPN active (WARP) → include WARP
     * - Always include WSS as fallback
     */
    fun getOrderedBrokers(): List<Pair<Transport, String>> {
        val brokers = mutableListOf<Pair<Transport, String>>()

        if (networkMonitor.isOnHomelabWifi()) {
            brokers.add(Transport.LAN_TCP to config.lanBrokerUrl)
        }

        if (networkMonitor.isWarpActive()) {
            brokers.add(Transport.WARP_TCP to config.warpBrokerUrl)
        }

        // WSS always available as fallback
        brokers.add(Transport.WSS to config.wssBrokerUrl)

        return brokers
    }
}
```

**Network detection**:
- Homelab WiFi: Check SSID or subnet (e.g., `10.43.x.x` range)
- WARP active: Check for active VPN via `ConnectivityManager.getNetworkCapabilities()` → `NET_CAPABILITY_NOT_VPN`
- WSS: Always available (requires internet)

### 2.4 — MqttManager (Core)

```kotlin
@Singleton
class MqttManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val config: MqttConfig,
    private val connectionStrategy: ConnectionStrategy,
) {
    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _activeTransport = MutableStateFlow<Transport?>(null)
    val activeTransport: StateFlow<Transport?> = _activeTransport.asStateFlow()

    private var client: MqttAndroidClient? = null
    private val subscriptions = ConcurrentHashMap<String, MutableSharedFlow<MqttMessage>>()
    private val activeTopics = mutableSetOf<String>()

    /**
     * Connect to the MQTT broker. Tries each transport in order.
     */
    suspend fun connect() { ... }

    /**
     * Disconnect cleanly.
     */
    suspend fun disconnect() { ... }

    /**
     * Subscribe to a topic pattern and receive messages as a Flow.
     * Supports MQTT wildcards (# and +).
     */
    fun subscribe(topicPattern: String): Flow<Pair<String, String>> { ... }

    /**
     * Publish a message to a topic.
     */
    suspend fun publish(topic: String, payload: String, qos: Int = 1) { ... }

    /**
     * Re-subscribe to all active topics after reconnection.
     */
    private suspend fun resubscribeAll() { ... }
}
```

**Key behaviors**:

1. **Automatic failover**: On connection failure to one transport, immediately try the next.
2. **Reconnection**: On unexpected disconnect, restart the `ConnectionStrategy` from the top.
3. **Topic resubscription**: After any reconnect, re-subscribe to all previously subscribed topics.
4. **Client ID uniqueness**: `mesh-six-android-{timestamp}` to avoid session conflicts.
5. **QoS 1**: All subscriptions and publishes use QoS 1 (at-least-once). Never QoS 2 (RabbitMQ limitation).
6. **Clean session**: `true` by default. Since RabbitMQ retained messages are node-local, we don't rely on persistent sessions.

### 2.5 — Hilt Module

```kotlin
@Module
@InstallIn(SingletonComponent::class)
object MqttModule {
    @Provides
    @Singleton
    fun provideMqttConfig(settingsRepository: SettingsRepository): MqttConfig {
        return settingsRepository.getMqttConfig()
    }

    @Provides
    @Singleton
    fun provideMqttManager(
        @ApplicationContext context: Context,
        config: MqttConfig,
        connectionStrategy: ConnectionStrategy,
    ): MqttManager {
        return MqttManager(context, config, connectionStrategy)
    }
}
```

### 2.6 — Topic Pattern Matching

Mirror the same matching logic as the web dashboard's `useMqtt.tsx`:

```kotlin
fun topicMatches(pattern: String, topic: String): Boolean {
    if (pattern == "#") return true
    val patParts = pattern.split("/")
    val topParts = topic.split("/")

    for (i in patParts.indices) {
        if (patParts[i] == "#") return true
        if (patParts[i] == "+") continue
        if (i >= topParts.size || patParts[i] != topParts[i]) return false
    }

    return patParts.size == topParts.size
}
```

### 2.7 — Android Lifecycle Integration

```kotlin
class MqttLifecycleObserver @Inject constructor(
    private val mqttManager: MqttManager,
) : DefaultLifecycleObserver {

    override fun onStart(owner: LifecycleOwner) {
        // App came to foreground — ensure MQTT is connected
        CoroutineScope(Dispatchers.IO).launch {
            mqttManager.connect()
        }
    }

    override fun onStop(owner: LifecycleOwner) {
        // App went to background — keep connection alive via foreground service
        // (handled by Feature 11). If no foreground service, disconnect cleanly.
    }
}
```

Register this observer in `MainActivity.onCreate()`:
```kotlin
lifecycle.addObserver(mqttLifecycleObserver)
```

---

## MQTT Topics to Subscribe

These topics are subscribed by the MqttManager on connect. Individual screens
filter by specific sub-patterns.

| Topic Pattern | Events | Used By |
|---------------|--------|---------|
| `claude/progress/#` | All Claude Code hook events | Sessions screen |
| `agent/registry/#` | Agent registration/heartbeats | Agents screen |
| `agent/task/#` | Task dispatch/results | Task Feed screen |
| `agent/project/#` | Project state transitions | Projects screen |
| `llm.events` | LLM service hook events | LLM Actors screen |

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| All transports fail | Show "No connection" banner, retry with exponential backoff (2s, 4s, 8s, 16s, 32s, 64s, 128s cap) |
| Connection drops | Reconnect automatically via Paho's built-in reconnect + ConnectionStrategy |
| Network change (WiFi ↔ mobile) | Re-evaluate `ConnectionStrategy`, switch transport if better option available |
| Broker rejects credentials | Show error in Settings screen, stop retry |
| WSS timeout (>100s) | Disconnect, retry from LAN |

---

## Acceptance Criteria

- [ ] MqttManager connects to RabbitMQ MQTT broker via at least one transport
- [ ] ConnectionStrategy correctly orders transports based on network state
- [ ] `connectionState` Flow emits correct state changes (Disconnected → Connecting → Connected)
- [ ] `subscribe()` returns a Flow that emits messages matching the topic pattern
- [ ] Wildcard patterns (`#` and `+`) work correctly
- [ ] Reconnection restores all active subscriptions
- [ ] App survives rotation/config change without dropping MQTT connection
- [ ] Connection indicator composable shows current state + transport type
- [ ] Unit tests for `topicMatches()` function
- [ ] Unit tests for `ConnectionStrategy` ordering logic

---

## Notes for Implementer

- Use `hannesa2/paho.mqtt.android` v3.6.4 from JitPack, not the Eclipse Paho directly.
- The Paho Android library requires an Android `Service` for background operation. This is set up in Feature 11. For Feature 02, the connection only lives while the app is in the foreground.
- RabbitMQ's MQTT plugin exposes WebSocket on port 15675, not 1883. The WSS URL should be `wss://mqtt.bto.bar/ws` (proxied through Caddy).
- For LAN detection, you may need to check the device's WiFi SSID or IP subnet. The `ACCESS_WIFI_STATE` and `ACCESS_FINE_LOCATION` permissions may be needed for SSID access on Android 10+. Consider using subnet detection instead to avoid location permission.
- All JSON deserialization uses `kotlinx-serialization`. Define `@Serializable` data classes that match the MQTT payloads.
