# Feature 06 — Claude Session Monitor Screen

> **Highest-value screen.** Displays real-time Claude Code sessions streamed via
> the `claude-mqtt-bridge` hook event publisher. This is the primary use case
> for the Android app.

## Dependencies

- **Feature 02** — MQTT Connectivity (subscription to `claude/progress/#`)
- **Feature 03** — Data Models (ClaudeEvent, ClaudeSession, SessionRepository)

## Depended On By

- Feature 04 (Dashboard Home — active session summary)

---

## Objective

Build a two-level screen: (1) a session list showing all active and recent
Claude Code sessions, and (2) a session detail view with a live event timeline,
subagent tree, tool usage breakdown, and error log. Events flow in real-time
from the `claude-mqtt-bridge` via MQTT topic `claude/progress/#`.

---

## Event Source

The `claude-mqtt-bridge` (at `apps/claude-mqtt-bridge/src/index.ts`) publishes
enriched events to MQTT topics:

```
claude/progress/{session_id}/{event_type}
```

Event types: `SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`SubagentStart`, `SubagentStop`, `SessionEnd`, `Notification`

Each event carries:
```json
{
  "timestamp": 1708444800000,
  "session_id": "abc123",
  "event": "PostToolUse",
  "status": "completed",
  "git_branch": "feature/my-branch",
  "worktree_path": "/home/user/project",
  "model": "claude-opus-4-6",
  "tool_name": "Write",
  "tool_input": { "file_path": "/src/main.ts" }
}
```

---

## Wireframe

### Session List (Phone)

```
┌──────────────────────────────────────┐
│  ← Sessions                  [filter]│
├──────────────────────────────────────┤
│                                      │
│  ACTIVE (3)                          │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  ● abc123...  opus-4-6         │  │
│  │    feature/add-auth             │  │
│  │    42 events • 3 subagents     │  │
│  │    12m ago • Write (3m ago)     │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  ● def456...  sonnet-4-6       │  │
│  │    main                        │  │
│  │    18 events • 1 subagent      │  │
│  │    3m ago • Bash (1m ago)       │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  ● ghi789...  haiku-4-5        │  │
│  │    fix/memory-leak              │  │
│  │    156 events • 8 subagents    │  │
│  │    45m ago • Grep (just now)    │  │
│  └────────────────────────────────┘  │
│                                      │
│  RECENT (ended)                      │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  ○ xyz000...  opus-4-6         │  │
│  │    main  •  ended 2h ago       │  │
│  │    312 events • 15 subagents   │  │
│  └────────────────────────────────┘  │
│                                      │
├──────────────────────────────────────┤
│ [Home] [Agents] [Sessions] [Tasks]  │
│                    ●                 │
└──────────────────────────────────────┘
```

### Session Detail (Phone — scrollable)

```
┌──────────────────────────────────────┐
│  ← abc123...                         │
├──────────────────────────────────────┤
│                                      │
│  ┌────────────────────────────────┐  │
│  │  Model: claude-opus-4-6        │  │
│  │  Branch: feature/add-auth      │  │
│  │  Path: /home/user/project      │  │
│  │  Status: ● Active (12m)        │  │
│  │  Events: 42 • Errors: 1        │  │
│  └────────────────────────────────┘  │
│                                      │
│  ─── Tool Usage ──────────────────── │
│  Write     ████████████  12          │
│  Bash      ████████      8           │
│  Read      ██████        6           │
│  Edit      ████          4           │
│  Grep      ███           3           │
│  Glob      ██            2           │
│  Task      █             1           │
│                                      │
│  ─── Subagents ───────────────────── │
│  ┌────────────────────────────────┐  │
│  │  Explore  sub-001  ● running   │  │
│  │  started 2m ago                │  │
│  ├────────────────────────────────┤  │
│  │  Bash     sub-002  ✓ done      │  │
│  │  ran for 45s                   │  │
│  ├────────────────────────────────┤  │
│  │  Plan     sub-003  ✓ done      │  │
│  │  ran for 1m 12s                │  │
│  └────────────────────────────────┘  │
│                                      │
│  ─── Live Event Timeline ─────────── │
│  12:03:45  PostToolUse  Write        │
│            /src/auth/login.ts        │
│  12:03:42  PreToolUse   Write        │
│            /src/auth/login.ts        │
│  12:03:30  PostToolUse  Bash         │
│            npm test                  │
│  12:03:15  SubagentStart Explore     │
│            sub-001                   │
│  12:02:58  PostToolUse  Read         │
│            /src/index.ts             │
│  12:02:45  SessionStart              │
│            model: opus-4-6           │
│  ... scroll for more ...             │
│                                      │
│  ─── Errors ──────────────────────── │
│  ┌────────────────────────────────┐  │
│  │  12:03:28  Bash                │  │
│  │  Command failed: npm test      │  │
│  │  Exit code 1                   │  │
│  └────────────────────────────────┘  │
│                                      │
└──────────────────────────────────────┘
```

### Tablet Layout (Session List + Detail Side-by-Side)

```
┌─────┬──────────────────┬─────────────────────────────────────┐
│     │ Sessions (3)     │  abc123... • claude-opus-4-6        │
│ NAV │                  │                                      │
│RAIL │ ● abc123 opus    │  Branch: feature/add-auth            │
│     │   feature/add-.. │  Active 12m • 42 events              │
│[Ho] │   42 events      │                                      │
│[Ag] │                  │  Tool Usage                           │
│[Se] │ ● def456 sonnet  │  Write ████████████ 12               │
│[Ta] │   main           │  Bash  ████████     8                │
│[Pr] │   18 events      │                                      │
│[LL] │                  │  Live Timeline                       │
│[Se] │ ● ghi789 haiku   │  12:03:45  PostToolUse  Write       │
│     │   fix/memory-..  │  12:03:42  PreToolUse   Write       │
│     │   156 events     │  12:03:30  PostToolUse  Bash        │
│     │                  │  12:03:15  SubagentStart Explore    │
│     │ ─ RECENT ─       │  ...                                │
│     │ ○ xyz000 opus    │                                      │
│     │   ended 2h ago   │  Errors (1)                         │
│     │                  │  12:03:28 Bash: npm test failed      │
└─────┴──────────────────┴─────────────────────────────────────┘
```

---

## Key Files

```
app/src/main/kotlin/bar/bto/meshsix/
├── ui/
│   └── screens/
│       └── sessions/
│           ├── SessionListScreen.kt         # Session list view
│           ├── SessionDetailScreen.kt       # Full session detail
│           ├── SessionViewModel.kt          # Shared ViewModel
│           ├── SessionCard.kt               # Individual session card
│           ├── EventTimeline.kt             # Scrollable event list
│           ├── ToolUsageChart.kt            # Horizontal bar chart
│           ├── SubagentList.kt              # Subagent tree/list
│           └── EventRow.kt                  # Single event in timeline
```

---

## Implementation Tasks

### 6.1 — SessionViewModel

```kotlin
@HiltViewModel
class SessionViewModel @Inject constructor(
    private val sessionRepository: SessionRepository,
) : ViewModel() {

    data class SessionListUiState(
        val activeSessions: List<ClaudeSession> = emptyList(),
        val recentSessions: List<ClaudeSession> = emptyList(),
        val totalEventCount: Int = 0,
    )

    data class SessionDetailUiState(
        val session: ClaudeSession? = null,
        val toolUsage: List<ToolUsageItem> = emptyList(),
        val subagents: List<Subagent> = emptyList(),
        val recentEvents: List<ClaudeEvent> = emptyList(),
        val errors: List<ClaudeEvent> = emptyList(),
    )

    private val _selectedSessionId = MutableStateFlow<String?>(null)

    val listState: StateFlow<SessionListUiState> = sessionRepository.sessions
        .map { sessions ->
            val all = sessions.values.toList()
            SessionListUiState(
                activeSessions = all.filter { it.status == SessionStatus.ACTIVE }
                    .sortedByDescending { it.startedAt },
                recentSessions = all.filter { it.status == SessionStatus.ENDED }
                    .sortedByDescending { it.endedAt ?: it.startedAt }
                    .take(20),
                totalEventCount = all.sumOf { it.events.size },
            )
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), SessionListUiState())

    val detailState: StateFlow<SessionDetailUiState> = combine(
        sessionRepository.sessions,
        _selectedSessionId,
    ) { sessions, selectedId ->
        val session = selectedId?.let { sessions[it] } ?: return@combine SessionDetailUiState()
        SessionDetailUiState(
            session = session,
            toolUsage = session.toolCounts.entries
                .sortedByDescending { it.value }
                .map { (tool, count) -> ToolUsageItem(tool, count) },
            subagents = session.subagents.values.toList(),
            recentEvents = session.events.takeLast(100).reversed(),
            errors = session.events.filter { it.status == "failed" },
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), SessionDetailUiState())

    fun selectSession(sessionId: String) {
        _selectedSessionId.value = sessionId
    }
}
```

### 6.2 — EventTimeline

The centerpiece of the session detail. A `LazyColumn` showing events in reverse
chronological order with color-coded rows:

```kotlin
@Composable
fun EventTimeline(
    events: List<ClaudeEvent>,
    modifier: Modifier = Modifier,
) {
    LazyColumn(modifier = modifier) {
        items(events, key = { "${it.sessionId}-${it.timestamp}-${it.event}" }) { event ->
            EventRow(event)
        }
    }
}

@Composable
fun EventRow(event: ClaudeEvent) {
    val color = when (event.status) {
        "started" -> MeshColors.Blue
        "pending" -> MeshColors.Yellow
        "completed" -> MeshColors.Green
        "failed" -> MeshColors.Red
        "ended" -> MeshColors.Gray
        else -> MeshColors.Gray
    }

    Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
        // Timestamp
        Text(
            text = formatTime(event.timestamp),
            style = MaterialTheme.typography.labelSmall,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(8.dp))
        // Status dot
        Canvas(modifier = Modifier.size(8.dp).align(CenterVertically)) {
            drawCircle(color = color)
        }
        Spacer(Modifier.width(8.dp))
        // Event type
        Text(
            text = event.event,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
        )
        // Tool name or agent type
        event.toolName?.let { tool ->
            Spacer(Modifier.width(8.dp))
            Text(
                text = tool,
                style = MaterialTheme.typography.bodySmall,
                color = MeshColors.MeshGreen,
            )
        }
    }
    // Expandable detail: tool_input, tool_response, error
}
```

### 6.3 — ToolUsageChart

Horizontal bar chart showing tool usage counts:

```kotlin
@Composable
fun ToolUsageChart(items: List<ToolUsageItem>, modifier: Modifier = Modifier) {
    val maxCount = items.maxOfOrNull { it.count } ?: 1

    Column(modifier = modifier) {
        items.forEach { item ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(vertical = 2.dp),
            ) {
                Text(
                    text = item.toolName,
                    modifier = Modifier.width(80.dp),
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                )
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(16.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(MeshColors.Zinc800),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxHeight()
                            .fillMaxWidth(item.count.toFloat() / maxCount)
                            .clip(RoundedCornerShape(4.dp))
                            .background(MeshColors.MeshGreen),
                    )
                }
                Text(
                    text = item.count.toString(),
                    modifier = Modifier.width(40.dp),
                    textAlign = TextAlign.End,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
    }
}
```

### 6.4 — SubagentList

```kotlin
@Composable
fun SubagentList(subagents: List<Subagent>, modifier: Modifier = Modifier) {
    Column(modifier = modifier) {
        subagents.forEach { agent ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp),
            ) {
                // Type chip
                Surface(
                    shape = RoundedCornerShape(4.dp),
                    color = MeshColors.MeshGreen.copy(alpha = 0.2f),
                ) {
                    Text(
                        text = agent.type,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                Spacer(Modifier.width(8.dp))
                // Agent ID (truncated)
                Text(
                    text = agent.id.take(8),
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.weight(1f))
                // Status
                StatusBadge(status = agent.status)
            }
        }
    }
}
```

### 6.5 — Session Card

Card for the session list view showing session summary:

```kotlin
@Composable
fun SessionCard(
    session: ClaudeSession,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    Card(
        onClick = onClick,
        colors = CardDefaults.cardColors(
            containerColor = if (isSelected)
                MeshColors.MeshGreen.copy(alpha = 0.1f)
            else
                MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // Status indicator
                Canvas(modifier = Modifier.size(10.dp)) {
                    drawCircle(
                        color = if (session.status == SessionStatus.ACTIVE)
                            MeshColors.MeshGreen else MeshColors.Zinc500,
                    )
                }
                Spacer(Modifier.width(8.dp))
                // Session ID
                Text(
                    text = session.id.take(8) + "...",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(Modifier.weight(1f))
                // Model badge
                session.model?.let { model ->
                    Surface(
                        shape = RoundedCornerShape(4.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                    ) {
                        Text(
                            text = model.removePrefix("claude-"),
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
            }
            // Branch name
            session.branch?.let { branch ->
                Text(
                    text = branch,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            // Stats line
            Text(
                text = "${session.events.size} events • ${session.subagents.size} subagents",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
```

### 6.6 — Auto-Scroll & Live Indicator

The event timeline should:
- Show a "LIVE" indicator badge when the session is active
- Auto-scroll to the latest event if the user is at the bottom
- Pause auto-scroll if the user scrolls up (to read history)
- Show a "Jump to latest" FAB when auto-scroll is paused

```kotlin
@Composable
fun LiveIndicator(isActive: Boolean) {
    if (isActive) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // Pulsing dot animation
            val infiniteTransition = rememberInfiniteTransition()
            val alpha by infiniteTransition.animateFloat(
                initialValue = 1f,
                targetValue = 0.3f,
                animationSpec = infiniteRepeatable(
                    animation = tween(1000),
                    repeatMode = RepeatMode.Reverse,
                ),
            )
            Canvas(modifier = Modifier.size(8.dp)) {
                drawCircle(color = Color.Red, alpha = alpha)
            }
            Spacer(Modifier.width(4.dp))
            Text("LIVE", style = MaterialTheme.typography.labelSmall, color = Color.Red)
        }
    }
}
```

---

## Acceptance Criteria

- [ ] Session list shows all active sessions with green indicator
- [ ] Session list shows recent (ended) sessions with gray indicator
- [ ] Tapping a session navigates to/shows detail view
- [ ] Session detail shows metadata (model, branch, path, duration)
- [ ] Tool usage chart renders correctly with proportional bars
- [ ] Subagent list shows status and type for each subagent
- [ ] Event timeline renders in reverse chronological order
- [ ] Events are color-coded by status (started/pending/completed/failed/ended)
- [ ] New events appear in real-time without manual refresh
- [ ] Auto-scroll works when user is at the bottom of the timeline
- [ ] "Jump to latest" FAB appears when user scrolls up
- [ ] LIVE indicator pulses for active sessions
- [ ] Error section highlights failed events with full error message
- [ ] Tablet layout shows list + detail side-by-side
- [ ] Events can be tapped to expand and show `tool_input`/`tool_response` details
- [ ] Performance is smooth with 500+ events in a single session

---

## Notes for Implementer

- This is the **most important screen** in the app. The primary value proposition is watching Claude Code sessions in real-time from your phone/tablet.
- Reference the `claude-mqtt-bridge` (`apps/claude-mqtt-bridge/src/index.ts`) for the exact event payload structure.
- Reference `docs/CLAUDE_PROGRESS_UI.md` for the full event schema documentation.
- The `SessionRepository` in Feature 03 does the heavy lifting of aggregating events into sessions. This screen just renders the state.
- For the event timeline `LazyColumn`, use `key = { compositeKey }` to ensure efficient recomposition.
- The `tool_input` expansion should show formatted JSON — use a monospace font and basic pretty-printing.
- Consider a "clear ended sessions" action to manage memory.
- The MQTT topic pattern `claude/progress/#` captures ALL sessions. The repository separates them by `session_id`.
