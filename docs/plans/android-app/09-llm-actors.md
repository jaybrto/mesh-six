# Feature 09 — LLM Service & Actor Monitor Screen

> Monitors the LLM Service's Claude CLI actor pool — actor statuses, request
> counts, errors, and allowed models.

## Dependencies

- **Feature 03** — Data Models (LlmActorInfo, LlmServiceStatus, LlmRepository)
- **Feature 14** — REST API Integration (fetching `/status` from LLM Service)

## Depended On By

- None (leaf feature)

---

## Objective

Build a screen that shows the status of the LLM Service actor pool. Each actor
(a managed Claude CLI process) has a status (idle/busy/unhealthy/initializing),
request count, error count, and credential info. The screen also shows service-level
metrics: total requests, total errors, uptime, and allowed models.

---

## Data Source

Unlike other screens that use MQTT, this screen primarily uses REST API polling
to the LLM Service's `/status` endpoint (via Dapr service invocation or direct
HTTP). The `llm.events` MQTT topic provides supplementary real-time hook events
from actor CLI processes.

**REST endpoint**: `GET /status` on `llm-service`
```json
{
  "status": "healthy",
  "actors": [
    {
      "actorId": "cli-0",
      "credentialId": "cred-1",
      "status": "idle",
      "capabilities": ["general"],
      "lastUsed": "2026-02-20T12:00:00Z",
      "requestCount": 42,
      "errorCount": 1
    },
    {
      "actorId": "cli-1",
      "credentialId": "cred-2",
      "status": "busy",
      "capabilities": ["general", "code-review"],
      "lastUsed": "2026-02-20T12:03:00Z",
      "requestCount": 38,
      "errorCount": 0
    }
  ],
  "allowedModels": ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  "totalRequests": 245,
  "totalErrors": 3,
  "uptime": 86400
}
```

**MQTT topic**: `llm.events` — hook events from actor CLI processes
```json
{
  "actorId": "cli-0",
  "sessionId": "abc123",
  "timestamp": "2026-02-20T12:03:45Z",
  "hookEvent": "PostToolUse",
  "toolName": "Write",
  "toolInput": { "file_path": "/src/main.ts" }
}
```

---

## Wireframe

### Phone Layout

```
┌──────────────────────────────────────┐
│  ← LLM Actors                       │
├──────────────────────────────────────┤
│                                      │
│  ┌────────────────────────────────┐  │
│  │  Service: ● healthy            │  │
│  │  Uptime: 1d 0h 0m             │  │
│  │  Requests: 245  Errors: 3     │  │
│  │  Models: opus, sonnet, haiku   │  │
│  └────────────────────────────────┘  │
│                                      │
│  ─── Actors (4) ──────────────────── │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  cli-0  ● idle                 │  │
│  │  cred: cred-1                  │  │
│  │  42 requests • 1 error         │  │
│  │  last used: 3m ago             │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  cli-1  ◐ busy                 │  │
│  │  cred: cred-2                  │  │
│  │  38 requests • 0 errors        │  │
│  │  last used: just now           │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  cli-2  ● idle                 │  │
│  │  cred: cred-1                  │  │
│  │  85 requests • 2 errors        │  │
│  │  last used: 15m ago            │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  cli-3  ✗ unhealthy            │  │
│  │  cred: cred-3                  │  │
│  │  80 requests • 12 errors       │  │
│  │  last used: 1h ago             │  │
│  └────────────────────────────────┘  │
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
│       └── llm/
│           ├── LlmActorsScreen.kt       # Main screen composable
│           ├── LlmActorsViewModel.kt    # Combines REST + MQTT data
│           ├── ServiceStatusCard.kt     # Service-level summary
│           └── ActorCard.kt            # Individual actor card
```

---

## Implementation Tasks

### 9.1 — LlmRepository

```kotlin
@Singleton
class LlmRepository @Inject constructor(
    private val restClient: MeshSixApiClient,
    private val mqttManager: MqttManager,
    private val json: Json,
) {
    private val _serviceStatus = MutableStateFlow<LlmServiceStatus?>(null)
    val serviceStatus: StateFlow<LlmServiceStatus?> = _serviceStatus

    private val _hookEvents = MutableStateFlow<List<LlmHookEvent>>(emptyList())
    val hookEvents: StateFlow<List<LlmHookEvent>> = _hookEvents

    /**
     * Poll the LLM service status endpoint.
     * Called on screen open and every 30 seconds.
     */
    suspend fun refreshStatus() {
        try {
            val status = restClient.getLlmServiceStatus()
            _serviceStatus.value = status
        } catch (e: Exception) {
            // Leave previous status, log error
        }
    }

    init {
        // Subscribe to llm.events MQTT topic for real-time hook events
        CoroutineScope(Dispatchers.IO).launch {
            mqttManager.subscribe("llm.events")
                .collect { (_, payload) ->
                    try {
                        val event = json.decodeFromString<LlmHookEvent>(payload)
                        _hookEvents.update { (listOf(event) + it).take(200) }
                    } catch (_: Exception) {}
                }
        }
    }
}
```

### 9.2 — LlmActorsViewModel

```kotlin
@HiltViewModel
class LlmActorsViewModel @Inject constructor(
    private val llmRepository: LlmRepository,
) : ViewModel() {

    data class LlmActorsUiState(
        val serviceStatus: LlmServiceStatus? = null,
        val actors: List<LlmActorInfo> = emptyList(),
        val isLoading: Boolean = true,
        val error: String? = null,
    )

    val uiState: StateFlow<LlmActorsUiState> = llmRepository.serviceStatus
        .map { status ->
            LlmActorsUiState(
                serviceStatus = status,
                actors = status?.actors ?: emptyList(),
                isLoading = status == null,
            )
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), LlmActorsUiState())

    init {
        // Initial fetch + periodic refresh
        viewModelScope.launch {
            llmRepository.refreshStatus()
            while (true) {
                delay(30_000)
                llmRepository.refreshStatus()
            }
        }
    }

    fun refresh() {
        viewModelScope.launch { llmRepository.refreshStatus() }
    }
}
```

### 9.3 — ActorCard

```kotlin
@Composable
fun ActorCard(actor: LlmActorInfo) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = actor.actorId,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Medium,
                    )
                    Spacer(Modifier.width(8.dp))
                    ActorStatusBadge(status = actor.status)
                }
                Text(
                    text = "cred: ${actor.credentialId}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = "${actor.requestCount} requests • ${actor.errorCount} errors",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            actor.lastUsed?.let { lastUsed ->
                RelativeTime(timestamp = lastUsed)
            }
        }
    }
}
```

### 9.4 — ActorStatusBadge

```kotlin
@Composable
fun ActorStatusBadge(status: String) {
    val (color, icon) = when (status) {
        "idle" -> MeshColors.Green to "●"
        "busy" -> MeshColors.Yellow to "◐"
        "unhealthy" -> MeshColors.Red to "✗"
        "initializing" -> MeshColors.Blue to "◌"
        else -> MeshColors.Gray to "?"
    }
    // Render colored badge with icon + status text
}
```

---

## Acceptance Criteria

- [ ] Service status card shows health, uptime, total requests/errors, allowed models
- [ ] Actor list shows all actors with status badges
- [ ] Actor statuses update on refresh (pull-to-refresh or auto-refresh every 30s)
- [ ] Actor cards show credential ID, request count, error count, last used
- [ ] Status colors: idle=green, busy=yellow, unhealthy=red, initializing=blue
- [ ] Pull-to-refresh triggers immediate status fetch
- [ ] Error state handled when REST API is unreachable
- [ ] MQTT hook events from `llm.events` topic supplement the display (optional enhancement)

---

## Notes for Implementer

- This screen is the only one that primarily uses REST instead of MQTT.
- The LLM Service exposes its status at `GET /status`. Access it through the REST API client (Feature 14).
- The `llm.events` MQTT topic carries events from the `event-publisher.ts` hook script running inside each actor's CLI process. These are published via Dapr pub/sub, but RabbitMQ's MQTT plugin bridges them.
- Refresh interval: 30 seconds is reasonable. Don't poll too aggressively.
- Reference `apps/llm-service/src/router.ts` and `packages/core/src/llm-service.ts` for the exact type shapes.
