# Feature 07 — Task Feed Screen

> Real-time feed of orchestrator task dispatches and results.
> Mirrors the web dashboard's Task Feed view.

## Dependencies

- **Feature 02** — MQTT Connectivity (subscription to `agent/task/#`)
- **Feature 03** — Data Models (TaskEvent, TaskRepository)

## Depended On By

- Feature 04 (Dashboard Home — task count summary)

---

## Objective

Build a reverse-chronological event feed showing task dispatches, completions,
and failures from the orchestrator. Each event shows task ID, capability,
assigned agent, status, and timing. Supports filtering by status and capability.

---

## Wireframe

### Phone Layout

```
┌──────────────────────────────────────┐
│  ← Tasks                     [filter]│
├──────────────────────────────────────┤
│                                      │
│  47 events • 94% success • 1h range  │
│                                      │
│  [All] [Completed] [Failed] [Pending]│
│                                      │
│  ┌────────────────────────────────┐  │
│  │  ● completed    a1b2c3d4       │  │
│  │  general-query → researcher    │  │
│  │  12:03:45  •  1.2s             │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  ✗ failed       e5f6g7h8       │  │
│  │  deploy-service → argocd-dep   │  │
│  │  12:02:30  •  timeout 120s     │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  ◐ dispatched   i9j0k1l2       │  │
│  │  code-review → architect       │  │
│  │  12:01:15                      │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  ● completed    m3n4o5p6       │  │
│  │  tech-consultation → architect │  │
│  │  12:00:45  •  3.4s             │  │
│  └────────────────────────────────┘  │
│                                      │
│  ... more events (LazyColumn) ...    │
│                                      │
├──────────────────────────────────────┤
│ [Home] [Agents] [Sessions] [Tasks]  │
│                             ●        │
└──────────────────────────────────────┘
```

### Task Detail (Bottom Sheet on Tap)

```
┌──────────────────────────────────────┐
│  ━━━━━━━━━                           │
│                                      │
│  Task: a1b2c3d4-e5f6-...            │
│  Status: ● completed                 │
│                                      │
│  Capability: general-query           │
│  Dispatched To: researcher-agent     │
│  Priority: 5                         │
│  Timeout: 120s                       │
│                                      │
│  Created:   12:03:44.123             │
│  Completed: 12:03:45.323             │
│  Duration:  1.2s                     │
│                                      │
│  Result:                             │
│  ┌────────────────────────────────┐  │
│  │ {                              │  │
│  │   "summary": "Found 3 API...", │  │
│  │   "files": ["src/api.ts"]      │  │
│  │ }                              │  │
│  └────────────────────────────────┘  │
│                                      │
└──────────────────────────────────────┘
```

---

## Key Files

```
app/src/main/kotlin/bar/bto/meshsix/
├── ui/
│   └── screens/
│       └── tasks/
│           ├── TaskFeedScreen.kt        # Main feed composable
│           ├── TaskFeedViewModel.kt     # Filters, stats, UI state
│           ├── TaskEventCard.kt         # Individual event card
│           └── TaskDetailSheet.kt       # Bottom sheet with full details
```

---

## Implementation Tasks

### 7.1 — TaskFeedViewModel

```kotlin
@HiltViewModel
class TaskFeedViewModel @Inject constructor(
    private val taskRepository: TaskRepository,
) : ViewModel() {

    private val _statusFilter = MutableStateFlow<String?>(null)
    private val _capabilityFilter = MutableStateFlow<String?>(null)

    data class TaskFeedUiState(
        val events: List<DisplayTaskEvent> = emptyList(),
        val totalCount: Int = 0,
        val successRate: Double = 0.0,
        val availableCapabilities: List<String> = emptyList(),
        val selectedEvent: DisplayTaskEvent? = null,
    )

    val uiState: StateFlow<TaskFeedUiState> = combine(
        taskRepository.events,
        _statusFilter,
        _capabilityFilter,
    ) { events, statusFilter, capabilityFilter ->
        val filtered = events
            .filter { statusFilter == null || it.resolvedStatus == statusFilter }
            .filter { capabilityFilter == null || it.capability == capabilityFilter }

        val completed = events.count { it.resolvedStatus == "completed" }
        val total = events.count { it.resolvedStatus in listOf("completed", "failed", "timeout") }

        TaskFeedUiState(
            events = filtered.map { it.toDisplay() },
            totalCount = events.size,
            successRate = if (total > 0) completed.toDouble() / total else 0.0,
            availableCapabilities = events.mapNotNull { it.capability }.distinct().sorted(),
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), TaskFeedUiState())

    fun setStatusFilter(status: String?) { _statusFilter.value = status }
    fun setCapabilityFilter(capability: String?) { _capabilityFilter.value = capability }
}
```

### 7.2 — TaskEventCard

```kotlin
@Composable
fun TaskEventCard(
    event: DisplayTaskEvent,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(onClick = onClick, modifier = modifier) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusBadge(status = event.status)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = event.taskIdShort,
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(4.dp))
                Row {
                    CapabilityChip(name = event.capability)
                    event.agent?.let { agent ->
                        Spacer(Modifier.width(4.dp))
                        Text(
                            text = "→ $agent",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                RelativeTime(timestamp = event.timestamp)
                event.durationMs?.let { ms ->
                    Text(
                        text = formatDuration(ms),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}
```

### 7.3 — Filter Chips

Row of filter chips for status:

```kotlin
@Composable
fun StatusFilterRow(
    selected: String?,
    onSelect: (String?) -> Unit,
) {
    val filters = listOf(null to "All", "completed" to "Completed", "failed" to "Failed", "dispatched" to "Pending")

    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(filters) { (value, label) ->
            FilterChip(
                selected = selected == value,
                onClick = { onSelect(value) },
                label = { Text(label) },
            )
        }
    }
}
```

---

## Acceptance Criteria

- [ ] Task feed populates from MQTT `agent/task/#` events
- [ ] Events show task ID (truncated), capability, agent, status, timestamp
- [ ] Status filter chips work (All / Completed / Failed / Pending)
- [ ] Summary bar shows total count and success rate
- [ ] Tapping an event opens detail bottom sheet with full JSON
- [ ] New events prepend to the top in real-time
- [ ] Feed caps at 500 events (oldest discarded)
- [ ] Duration displays for completed/failed tasks
- [ ] Error details show in the detail sheet for failed tasks
- [ ] `LazyColumn` scroll performance is smooth with 500 events

---

## Notes for Implementer

- The web dashboard (`TaskFeed.tsx`) is the reference. Match its event parsing logic.
- The MQTT payload varies — sometimes it's a `TaskRequest` (dispatch), sometimes a `TaskResult` (completion). The ViewModel should normalize both into `DisplayTaskEvent`.
- `taskId` is a UUID — show only the first 8 characters in the list, full UUID in the detail sheet.
- Parse the `topic` path to determine if the event is a dispatch or result. The web dashboard uses `data.success !== undefined` to detect results.
