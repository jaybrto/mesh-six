# Feature 04 — Dashboard Home Screen

> The landing screen showing a high-level overview of the entire mesh-six system.
> Aggregates data from all other screens into summary cards.

## Dependencies

- **Feature 02** — MQTT Connectivity (connection state)
- **Feature 03** — Data Models & State (all repositories)
- **Feature 05** — Agent Registry (agent count data)
- **Feature 06** — Claude Sessions (active session data)
- **Feature 07** — Task Feed (recent task data)

## Depended On By

- None (leaf feature)

---

## Objective

Build the main dashboard screen that serves as the app's home page. Shows a
summary grid of key metrics with quick-glance cards for connection status,
active sessions, agent health, recent tasks, and project progress. Tapping
a card navigates to the corresponding detail screen.

---

## Wireframe

### Phone Layout (Pixel 10 Pro XL — portrait)

```
┌──────────────────────────────────────┐
│  mesh-six                     [gear] │  ← Top app bar
├──────────────────────────────────────┤
│                                      │
│  ┌────────────────────────────────┐  │
│  │  Connection: LAN TCP           │  │  ← Connection status banner
│  │  ● Connected                   │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌───────────────┐ ┌──────────────┐  │
│  │ Active        │ │ Agents       │  │  ← Summary cards (2-column grid)
│  │ Sessions      │ │ Online       │  │
│  │    ┌──┐       │ │   ┌──┐      │  │
│  │    │ 3│       │ │   │12│      │  │
│  │    └──┘       │ │   └──┘      │  │
│  │ 2 tools/min   │ │ 1 degraded  │  │
│  └───────────────┘ └──────────────┘  │
│                                      │
│  ┌───────────────┐ ┌──────────────┐  │
│  │ Tasks (1h)    │ │ Projects     │  │
│  │    ┌──┐       │ │   ┌──┐      │  │
│  │    │47│       │ │   │ 2│      │  │
│  │    └──┘       │ │   └──┘      │  │
│  │ 94% success   │ │ 1 in QA     │  │
│  └───────────────┘ └──────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ Recent Activity                │  │  ← Last 5 events ticker
│  │ 12:03 PostToolUse Write abc..  │  │
│  │ 12:02 PreToolUse Bash npm..    │  │
│  │ 12:01 SessionStart claude-s..  │  │
│  │ 11:58 task.result deploy-s..   │  │
│  │ 11:55 agent/registry orchs..   │  │
│  └────────────────────────────────┘  │
│                                      │
├──────────────────────────────────────┤
│ [Home] [Agents] [Sessions] [Tasks]  │  ← Bottom nav
│   ●                                  │
└──────────────────────────────────────┘
```

### Tablet Layout (landscape, wide screen)

```
┌─────┬────────────────────────────────────────────────────────────┐
│     │  mesh-six                                          [gear] │
│ NAV │                                                            │
│RAIL │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│     │  │ Sessions │ │ Agents   │ │ Tasks    │ │ Projects │    │
│[Ho] │  │    3     │ │   12     │ │   47     │ │    2     │    │
│[Ag] │  │ active   │ │ online   │ │ in 1h    │ │ active   │    │
│[Se] │  └──────────┘ └──────────┘ └──────────┘ └──────────┘    │
│[Ta] │                                                            │
│[Pr] │  ┌─────────────────────────┐ ┌────────────────────────┐  │
│[LL] │  │ Active Sessions         │ │ Recent Activity        │  │
│[Se] │  │ ● sess-abc (opus) 12m   │ │ 12:03 Write file.ts   │  │
│     │  │ ● sess-def (sonnet) 3m  │ │ 12:02 Bash npm test   │  │
│     │  │ ● sess-ghi (haiku) 45m  │ │ 12:01 SessionStart    │  │
│     │  └─────────────────────────┘ └────────────────────────┘  │
│     │                                                            │
│     │  ┌─────────────────────────────────────────────────────┐  │
│     │  │ Connection: LAN TCP ● Connected                      │  │
│     │  └─────────────────────────────────────────────────────┘  │
└─────┴────────────────────────────────────────────────────────────┘
```

---

## Key Files

```
app/src/main/kotlin/bar/bto/meshsix/
├── ui/
│   └── screens/
│       └── dashboard/
│           ├── DashboardScreen.kt      # Main composable
│           ├── DashboardViewModel.kt   # Aggregates data from repositories
│           ├── SummaryCard.kt          # Reusable metric card component
│           ├── ActivityTicker.kt       # Recent events list
│           └── ConnectionBanner.kt     # Connection status banner
```

---

## Implementation Tasks

### 4.1 — DashboardViewModel

```kotlin
@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val sessionRepository: SessionRepository,
    private val agentRepository: AgentRepository,
    private val taskRepository: TaskRepository,
    private val projectRepository: ProjectRepository,
    private val mqttManager: MqttManager,
) : ViewModel() {

    data class DashboardUiState(
        val connectionState: ConnectionState = ConnectionState.Disconnected,
        val activeTransport: Transport? = null,
        val activeSessionCount: Int = 0,
        val onlineAgentCount: Int = 0,
        val degradedAgentCount: Int = 0,
        val recentTaskCount: Int = 0,
        val taskSuccessRate: Double = 0.0,
        val activeProjectCount: Int = 0,
        val projectsInQa: Int = 0,
        val recentActivity: List<ActivityItem> = emptyList(),
        val activeSessions: List<ClaudeSession> = emptyList(),
    )

    val uiState: StateFlow<DashboardUiState> = combine(
        mqttManager.connectionState,
        mqttManager.activeTransport,
        sessionRepository.activeSessions,
        agentRepository.agents,
        taskRepository.events,
        projectRepository.projects,
    ) { connectionState, transport, sessions, agents, tasks, projects ->
        DashboardUiState(
            connectionState = connectionState,
            activeTransport = transport,
            activeSessionCount = sessions.size,
            // ... compute all derived values
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), DashboardUiState())
}
```

### 4.2 — SummaryCard Composable

Reusable card showing a metric name, large number, and subtitle:

```kotlin
@Composable
fun SummaryCard(
    title: String,
    value: String,
    subtitle: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
)
```

Uses Material 3 `Card` with dark theme colors from the mesh-six palette.

### 4.3 — ActivityTicker

Shows the last N events across all MQTT topics as a scrollable list:

```kotlin
@Composable
fun ActivityTicker(
    items: List<ActivityItem>,
    modifier: Modifier = Modifier,
)

data class ActivityItem(
    val timestamp: Long,
    val source: String,      // "claude", "agent", "task", "project"
    val summary: String,     // Human-readable one-liner
    val type: String,        // Event type for icon/color
)
```

### 4.4 — ConnectionBanner

```kotlin
@Composable
fun ConnectionBanner(
    state: ConnectionState,
    transport: Transport?,
    modifier: Modifier = Modifier,
)
```

Shows colored bar: green (connected + transport name), yellow (reconnecting), red (disconnected).

---

## Acceptance Criteria

- [ ] Dashboard screen shows all summary cards with live data
- [ ] Tapping a summary card navigates to the corresponding detail screen
- [ ] Connection banner reflects current MQTT state and transport
- [ ] Activity ticker shows last 20 events from all sources
- [ ] Phone layout uses 2-column grid for cards
- [ ] Tablet layout uses 4-column grid + side panels
- [ ] All values update in real-time as MQTT events arrive
- [ ] Screen handles empty state gracefully (no data yet)

---

## Notes for Implementer

- The dashboard is an aggregation screen — it does NOT subscribe to MQTT directly. It reads from the repositories that are already subscribed.
- Use `combine()` to merge multiple `StateFlow` sources into a single `DashboardUiState`.
- The "Recent Activity" ticker merges events from ALL repositories into a unified timeline. Each repository should expose a `Flow<List<ActivityItem>>` or the ViewModel does the merge.
- Keep the dashboard lightweight — no heavy computation. The repositories do the work.
- The summary cards should be tappable and navigate to the corresponding screen via the NavController.
