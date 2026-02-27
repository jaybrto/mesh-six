# Feature 05 — Agent Registry Screen

> Displays all registered mesh-six agents with their status, capabilities,
> health, and heartbeat information. Mirrors the web dashboard's Agent Registry view.

## Dependencies

- **Feature 02** — MQTT Connectivity (subscription to `agent/registry/#`)
- **Feature 03** — Data Models (AgentRegistration, AgentRepository)

## Depended On By

- Feature 04 (Dashboard Home — agent count summary)

---

## Objective

Build a screen that shows all registered agents in a scrollable list/table
with real-time status updates via MQTT. Each agent card shows name, app ID,
status badge, capability chips, and last heartbeat. Supports filtering and
sorting.

---

## Wireframe

### Phone Layout

```
┌──────────────────────────────────────┐
│  ← Agents                    [filter]│
├──────────────────────────────────────┤
│  ┌────────────────────────────────┐  │
│  │ Search agents...               │  │
│  └────────────────────────────────┘  │
│                                      │
│  12 agents • 10 online • 1 degraded  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  Orchestrator                  │  │
│  │  orchestrator    ● online      │  │
│  │  [general-query] [deploy]      │  │
│  │  Last heartbeat: 12s ago       │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  Architect Agent               │  │
│  │  architect-agent  ● online     │  │
│  │  [tech-consultation]           │  │
│  │  [architecture-review]         │  │
│  │  Last heartbeat: 8s ago        │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  ArgoCD Deployer              │  │
│  │  argocd-deployer  ◐ degraded   │  │
│  │  [deploy-service] [sync-gitops]│  │
│  │  Last heartbeat: 2m ago        │  │
│  └────────────────────────────────┘  │
│                                      │
│  ... more agents ...                 │
├──────────────────────────────────────┤
│ [Home] [Agents] [Sessions] [Tasks]  │
│          ●                           │
└──────────────────────────────────────┘
```

### Agent Detail (Bottom Sheet on Tap)

```
┌──────────────────────────────────────┐
│  ━━━━━━━━━                           │  ← drag handle
│                                      │
│  Architect Agent                     │
│  architect-agent                     │
│  Status: ● online                    │
│  Last Heartbeat: 2026-02-20 12:03:45 │
│                                      │
│  Capabilities                        │
│  ┌────────────────────────────────┐  │
│  │ tech-consultation    w: 0.85   │  │
│  │   preferred: true              │  │
│  │   requirements: [ollama]       │  │
│  ├────────────────────────────────┤  │
│  │ architecture-review  w: 0.90   │  │
│  │   preferred: true              │  │
│  │   requirements: [ollama, pg]   │  │
│  └────────────────────────────────┘  │
│                                      │
│  Health Checks                       │
│  ollama: http://ollama:11434/api/... │
│  pg: http://pgsql:5432/...           │
│                                      │
│  Metadata                            │
│  version: 0.3.0                      │
│  runtime: bun                        │
│                                      │
└──────────────────────────────────────┘
```

---

## Key Files

```
app/src/main/kotlin/bar/bto/meshsix/
├── ui/
│   └── screens/
│       └── agents/
│           ├── AgentRegistryScreen.kt    # Main list composable
│           ├── AgentRegistryViewModel.kt # Filters, sorting, UI state
│           ├── AgentCard.kt              # Individual agent card
│           └── AgentDetailSheet.kt       # Bottom sheet detail view
├── ui/
│   └── components/
│       ├── StatusBadge.kt               # Reusable status indicator
│       ├── CapabilityChip.kt            # Reusable capability tag
│       └── RelativeTime.kt             # "12s ago" display
```

---

## Implementation Tasks

### 5.1 — AgentRegistryViewModel

```kotlin
@HiltViewModel
class AgentRegistryViewModel @Inject constructor(
    private val agentRepository: AgentRepository,
) : ViewModel() {

    private val _searchQuery = MutableStateFlow("")
    val searchQuery: StateFlow<String> = _searchQuery

    private val _statusFilter = MutableStateFlow<String?>(null) // null = all
    val statusFilter: StateFlow<String?> = _statusFilter

    private val _sortBy = MutableStateFlow(AgentSortField.NAME)

    data class AgentRegistryUiState(
        val agents: List<AgentRegistration> = emptyList(),
        val totalCount: Int = 0,
        val onlineCount: Int = 0,
        val degradedCount: Int = 0,
        val offlineCount: Int = 0,
        val selectedAgent: AgentRegistration? = null,
    )

    val uiState: StateFlow<AgentRegistryUiState> = combine(
        agentRepository.agents,
        _searchQuery,
        _statusFilter,
        _sortBy,
    ) { agents, query, filter, sort ->
        val list = agents.values
            .filter { matchesSearch(it, query) }
            .filter { filter == null || it.status == filter }
            .sortedWith(sortComparator(sort))

        AgentRegistryUiState(
            agents = list,
            totalCount = agents.size,
            onlineCount = agents.values.count { it.status == "online" },
            degradedCount = agents.values.count { it.status == "degraded" },
            offlineCount = agents.values.count { it.status == "offline" },
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), AgentRegistryUiState())

    fun setSearchQuery(query: String) { _searchQuery.value = query }
    fun setStatusFilter(status: String?) { _statusFilter.value = status }
    fun selectAgent(agent: AgentRegistration?) { ... }
}
```

### 5.2 — StatusBadge Component

```kotlin
@Composable
fun StatusBadge(status: String, modifier: Modifier = Modifier) {
    val (color, label) = when (status) {
        "online" -> MeshColors.Green to "online"
        "degraded" -> MeshColors.Yellow to "degraded"
        "offline" -> MeshColors.Red to "offline"
        else -> MeshColors.Gray to status
    }
    // Filled circle + text
}
```

### 5.3 — CapabilityChip

```kotlin
@Composable
fun CapabilityChip(capability: AgentCapability, modifier: Modifier = Modifier) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MeshTheme.colorScheme.meshGreen.copy(alpha = 0.2f),
    ) {
        Text(
            text = capability.name,
            style = MaterialTheme.typography.labelSmall,
            color = MeshTheme.colorScheme.meshGreenLight,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}
```

### 5.4 — RelativeTime Component

```kotlin
@Composable
fun RelativeTime(timestamp: String, modifier: Modifier = Modifier) {
    // Parse ISO 8601 timestamp
    // Display "12s ago", "3m ago", "1h ago", etc.
    // Auto-update every 10 seconds via LaunchedEffect
}
```

### 5.5 — AgentDetailSheet

Bottom sheet showing full agent details when a card is tapped. Includes:
- Full name and app ID
- Status with timestamp
- All capabilities with weights, preferred flag, requirements
- Health check URLs
- Raw metadata JSON (collapsible)

---

## Acceptance Criteria

- [ ] Agent list populates from MQTT `agent/registry/#` events
- [ ] Status badges show correct colors (green/yellow/red)
- [ ] Capability chips display for each agent
- [ ] Relative time updates every 10 seconds
- [ ] Search filters agents by name, appId, or capability name
- [ ] Status filter chips (All / Online / Degraded / Offline) work
- [ ] Tapping an agent opens detail bottom sheet
- [ ] Agent count summary bar shows correct totals
- [ ] New agent registrations appear in real-time
- [ ] Agent status changes update in real-time
- [ ] Scrolling is smooth with 20+ agents

---

## Tablet Layout — NavigableListDetailPaneScaffold

On tablets, the agent registry uses `NavigableListDetailPaneScaffold` from M3
Adaptive (Feature 13) to show the agent list and detail side-by-side. On phones,
tapping an agent navigates to a full-screen detail view with predictive back
gesture support.

See `AgentsScreen.kt` in the bootstrapped `android/` directory for the reference
implementation of this pattern.

---

## Notes for Implementer

- The web dashboard (`AgentRegistry.tsx`) is the reference implementation. Match its data handling but adapt the UI for mobile.
- Agents arrive as individual MQTT messages. The repository should maintain a `Map<String, AgentRegistration>` keyed by `appId` and update on each message.
- The heartbeat timestamp comes as ISO 8601 string — parse with `java.time.Instant` or `kotlinx-datetime`.
- Use `NavigableListDetailPaneScaffold` for the list-detail layout (replaces the bottom sheet pattern on tablets). On phones, the scaffold shows list full-screen and navigates to detail.
- Agent data classes must implement `@Parcelize` for the scaffold's state preservation.
- `LazyColumn` inside the list pane for efficient scrolling with 20+ agents.
