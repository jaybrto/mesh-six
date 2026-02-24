# Feature 03 — Core Data Models & State Management

> Defines all Kotlin data classes, repositories, and ViewModels that form the
> data backbone of the app.

## Dependencies

- **Feature 01** — Project Setup (Hilt, Kotlin Serialization)

## Depended On By

- Feature 04 (Dashboard Home)
- Feature 05 (Agent Registry)
- Feature 06 (Claude Sessions)
- Feature 07 (Task Feed)
- Feature 08 (Project Lifecycle)
- Feature 09 (LLM Actors)

---

## Objective

Define all Kotlin data models mirroring the TypeScript types from `@mesh-six/core`
and `claude-mqtt-bridge`. Implement repository classes that merge real-time MQTT
streams with REST API snapshots. Expose data to the UI layer via `StateFlow`.

---

## Key Files

```
app/src/main/kotlin/bar/bto/meshsix/
├── data/
│   ├── models/
│   │   ├── AgentRegistration.kt    # Mirrors @mesh-six/core AgentRegistration
│   │   ├── AgentCapability.kt      # Mirrors @mesh-six/core AgentCapability
│   │   ├── TaskEvent.kt            # Task dispatch/result events
│   │   ├── TaskStatus.kt           # Mirrors @mesh-six/core TaskStatus
│   │   ├── ClaudeEvent.kt          # Mirrors claude-mqtt-bridge EnrichedEvent
│   │   ├── ClaudeSession.kt        # Aggregated session state
│   │   ├── ProjectState.kt         # Project lifecycle state
│   │   ├── LlmActorInfo.kt         # Mirrors @mesh-six/core ActorInfo
│   │   ├── LlmServiceStatus.kt     # Mirrors @mesh-six/core LLMServiceStatus
│   │   ├── ConnectionState.kt      # (from Feature 02)
│   │   └── AppSettings.kt          # User-configurable settings
│   ├── repository/
│   │   ├── AgentRepository.kt      # Agent registry data
│   │   ├── SessionRepository.kt    # Claude session tracking
│   │   ├── TaskRepository.kt       # Task feed data
│   │   ├── ProjectRepository.kt    # Project lifecycle data
│   │   ├── LlmRepository.kt        # LLM actor data
│   │   └── SettingsRepository.kt   # Persistent settings (DataStore)
│   └── di/
│       └── RepositoryModule.kt     # Hilt bindings
```

---

## Implementation Tasks

### 3.1 — Data Models

All models use `@Serializable` from `kotlinx-serialization` and match the JSON
shape of MQTT messages. Field names use `@SerialName` where the JSON uses
`snake_case` but Kotlin uses `camelCase`.

#### AgentRegistration (mirrors `types.ts`)

```kotlin
@Serializable
data class AgentCapability(
    val name: String,
    val weight: Double,
    val preferred: Boolean = false,
    val requirements: List<String> = emptyList(),
    val async: Boolean? = null,
    @SerialName("estimatedDuration") val estimatedDuration: String? = null,
    val platforms: List<String>? = null,
)

@Serializable
data class AgentRegistration(
    val name: String,
    val appId: String,
    val capabilities: List<AgentCapability>,
    val status: String,  // "online", "degraded", "offline"
    val healthChecks: Map<String, String> = emptyMap(),
    val lastHeartbeat: String,
    val metadata: Map<String, JsonElement>? = null,
)
```

#### ClaudeEvent (mirrors `claude-mqtt-bridge` EnrichedEvent)

```kotlin
@Serializable
data class ClaudeEvent(
    val timestamp: Long,
    @SerialName("session_id") val sessionId: String,
    val event: String,   // SessionStart, PreToolUse, PostToolUse, etc.
    val status: String,  // started, pending, completed, failed, ended
    @SerialName("git_branch") val gitBranch: String? = null,
    @SerialName("worktree_path") val worktreePath: String? = null,
    val model: String? = null,
    @SerialName("job_id") val jobId: String? = null,
    @SerialName("tool_name") val toolName: String? = null,
    @SerialName("tool_input") val toolInput: Map<String, JsonElement>? = null,
    @SerialName("tool_response") val toolResponse: Map<String, JsonElement>? = null,
    val error: String? = null,
    @SerialName("agent_id") val agentId: String? = null,
    @SerialName("agent_type") val agentType: String? = null,
    val source: String? = null,
    val reason: String? = null,
    val notification: NotificationPayload? = null,
)

@Serializable
data class NotificationPayload(
    val message: String? = null,
    val title: String? = null,
    val type: String? = null,
)
```

#### ClaudeSession (aggregated from events)

```kotlin
data class ClaudeSession(
    val id: String,
    val model: String? = null,
    val branch: String? = null,
    val worktreePath: String? = null,
    val status: SessionStatus = SessionStatus.ACTIVE,
    val events: List<ClaudeEvent> = emptyList(),
    val subagents: Map<String, Subagent> = emptyMap(),
    val startedAt: Long,
    val endedAt: Long? = null,
    val toolCounts: Map<String, Int> = emptyMap(),
    val errorCount: Int = 0,
)

enum class SessionStatus { ACTIVE, ENDED }

data class Subagent(
    val id: String,
    val type: String,
    val status: String,  // "running", "completed"
    val startedAt: Long,
    val endedAt: Long? = null,
)
```

#### TaskEvent

```kotlin
@Serializable
data class TaskEvent(
    val id: String? = null,
    val taskId: String? = null,
    val capability: String? = null,
    val agentId: String? = null,
    val dispatchedTo: String? = null,
    val status: String? = null,
    val success: Boolean? = null,
    val createdAt: String? = null,
    val completedAt: String? = null,
    val durationMs: Long? = null,
    val error: TaskError? = null,
)

@Serializable
data class TaskError(
    val type: String,
    val message: String,
)
```

#### ProjectState

```kotlin
data class Project(
    val id: String,
    val name: String,
    val currentState: ProjectPhase,
    val history: List<ProjectTransition> = emptyList(),
)

enum class ProjectPhase {
    CREATE, PLANNING, REVIEW, IN_PROGRESS, QA, DEPLOY, VALIDATE, ACCEPTED
}

data class ProjectTransition(
    val state: ProjectPhase,
    val timestamp: String,
)
```

#### LLM Actor Models

```kotlin
@Serializable
data class LlmActorInfo(
    val actorId: String,
    val credentialId: String,
    val status: String,  // idle, busy, unhealthy, initializing
    val capabilities: List<String> = emptyList(),
    val lastUsed: String? = null,
    val requestCount: Int = 0,
    val errorCount: Int = 0,
)

@Serializable
data class LlmServiceStatus(
    val status: String,  // healthy, degraded, unavailable
    val actors: List<LlmActorInfo>,
    val allowedModels: List<String>,
    val totalRequests: Int,
    val totalErrors: Int,
    val uptime: Long,
)
```

### 3.2 — Repository Layer

Repositories are `@Singleton` Hilt-managed classes that:
1. Subscribe to MQTT topics via `MqttManager`
2. Parse incoming JSON into data models
3. Maintain in-memory state as `MutableStateFlow`
4. Expose `StateFlow` to ViewModels

#### SessionRepository

```kotlin
@Singleton
class SessionRepository @Inject constructor(
    private val mqttManager: MqttManager,
    private val json: Json,
) {
    private val _sessions = MutableStateFlow<Map<String, ClaudeSession>>(emptyMap())
    val sessions: StateFlow<Map<String, ClaudeSession>> = _sessions.asStateFlow()

    val activeSessions: Flow<List<ClaudeSession>> = sessions.map { map ->
        map.values.filter { it.status == SessionStatus.ACTIVE }
            .sortedByDescending { it.startedAt }
    }

    val recentSessions: Flow<List<ClaudeSession>> = sessions.map { map ->
        map.values.sortedByDescending { it.startedAt }.take(50)
    }

    init {
        // Subscribe to MQTT and process events
        CoroutineScope(Dispatchers.IO).launch {
            mqttManager.subscribe("claude/progress/#")
                .collect { (topic, payload) ->
                    processEvent(topic, payload)
                }
        }
    }

    private fun processEvent(topic: String, payload: String) {
        val event = try {
            json.decodeFromString<ClaudeEvent>(payload)
        } catch (e: Exception) {
            return // ignore malformed messages
        }

        _sessions.update { current ->
            val sessions = current.toMutableMap()
            val existing = sessions[event.sessionId]

            val session = if (existing != null) {
                updateSession(existing, event)
            } else {
                createSession(event)
            }

            sessions[event.sessionId] = session
            sessions
        }
    }

    private fun createSession(event: ClaudeEvent): ClaudeSession { ... }
    private fun updateSession(session: ClaudeSession, event: ClaudeEvent): ClaudeSession { ... }
}
```

#### AgentRepository

```kotlin
@Singleton
class AgentRepository @Inject constructor(
    private val mqttManager: MqttManager,
    private val json: Json,
) {
    private val _agents = MutableStateFlow<Map<String, AgentRegistration>>(emptyMap())
    val agents: StateFlow<Map<String, AgentRegistration>> = _agents.asStateFlow()

    val onlineAgents: Flow<List<AgentRegistration>> = agents.map { map ->
        map.values.filter { it.status != "offline" }
            .sortedBy { it.name }
    }

    // Subscribes to "agent/registry/#"
}
```

#### TaskRepository

```kotlin
@Singleton
class TaskRepository @Inject constructor(
    private val mqttManager: MqttManager,
    private val json: Json,
) {
    private val _events = MutableStateFlow<List<TaskEvent>>(emptyList())
    val events: StateFlow<List<TaskEvent>> = _events.asStateFlow()

    private val maxEvents = 500

    // Subscribes to "agent/task/#"
    // Prepends new events, trims to maxEvents
}
```

#### ProjectRepository

```kotlin
@Singleton
class ProjectRepository @Inject constructor(
    private val mqttManager: MqttManager,
    private val json: Json,
) {
    private val _projects = MutableStateFlow<Map<String, Project>>(emptyMap())
    val projects: StateFlow<Map<String, Project>> = _projects.asStateFlow()

    // Subscribes to "agent/project/#"
}
```

### 3.3 — SettingsRepository (DataStore)

```kotlin
@Singleton
class SettingsRepository @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val dataStore = context.dataStore

    // MQTT settings
    val mqttLanUrl: Flow<String>
    val mqttWssUrl: Flow<String>

    // API settings
    val apiBaseUrl: Flow<String>

    // Notification settings
    val ntfyUrl: Flow<String>
    val ntfyTopic: Flow<String>
    val notificationsEnabled: Flow<Boolean>

    // Background service
    val backgroundServiceEnabled: Flow<Boolean>

    suspend fun updateMqttLanUrl(url: String) { ... }
    suspend fun updateMqttWssUrl(url: String) { ... }
    // ... etc
}
```

### 3.4 — Hilt Module

```kotlin
@Module
@InstallIn(SingletonComponent::class)
object RepositoryModule {
    @Provides
    @Singleton
    fun provideJson(): Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
    }
}
```

Repositories are `@Singleton @Inject constructor` classes, so Hilt auto-binds them.

---

## Data Flow Diagram

```
MQTT Broker                Repository              ViewModel         Compose UI
─────────────             ──────────              ─────────         ──────────
claude/progress/# ──────▶ SessionRepository ──▶ SessionViewModel ──▶ SessionListScreen
                           .sessions (StateFlow)  .uiState (StateFlow)

agent/registry/# ────────▶ AgentRepository ────▶ AgentViewModel ───▶ AgentRegistryScreen
                           .agents (StateFlow)    .uiState (StateFlow)

agent/task/# ────────────▶ TaskRepository ─────▶ TaskViewModel ────▶ TaskFeedScreen
                           .events (StateFlow)    .uiState (StateFlow)

agent/project/# ─────────▶ ProjectRepository ──▶ ProjectViewModel ─▶ ProjectScreen
                           .projects (StateFlow)  .uiState (StateFlow)
```

---

## Acceptance Criteria

- [ ] All data models compile and are `@Serializable`
- [ ] JSON payloads matching real MQTT messages deserialize correctly
- [ ] SessionRepository correctly aggregates ClaudeEvents into ClaudeSessions
- [ ] SessionRepository tracks subagents and tool counts
- [ ] AgentRepository maintains latest agent state per appId
- [ ] TaskRepository maintains a capped list of recent events
- [ ] ProjectRepository tracks project state machine transitions
- [ ] SettingsRepository persists settings to DataStore
- [ ] All repositories expose `StateFlow` that ViewModels can collect
- [ ] Unit tests for JSON deserialization of all model types
- [ ] Unit tests for SessionRepository event aggregation logic

---

## Notes for Implementer

- Use `kotlinx.serialization.json.Json` with `ignoreUnknownKeys = true` — the MQTT payloads may have fields we don't model.
- Use `coerceInputValues = true` so `null` values for non-nullable fields with defaults don't crash.
- The `ClaudeEvent` model is the most complex — test it thoroughly against the real payloads from `claude-mqtt-bridge`.
- Keep `maxEvents` in `TaskRepository` reasonable (500). On a busy cluster, events can accumulate fast.
- `ClaudeSession` is derived state — it's computed from `ClaudeEvent` objects, not directly from MQTT. The repository does the aggregation.
- For the `toolCounts` map in `ClaudeSession`, count occurrences of each `toolName` from `PostToolUse` events.
