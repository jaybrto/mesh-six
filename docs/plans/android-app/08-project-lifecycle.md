# Feature 08 — Project Lifecycle Screen

> Visualizes the Dapr Workflow state machine for mesh-six projects.
> Mirrors the web dashboard's Project Lifecycle view.

## Dependencies

- **Feature 02** — MQTT Connectivity (subscription to `agent/project/#`)
- **Feature 03** — Data Models (Project, ProjectRepository)

## Depended On By

- Feature 04 (Dashboard Home — project count summary)

---

## Objective

Build a screen that visualizes the project state machine
(CREATE → PLANNING → REVIEW → IN_PROGRESS → QA → DEPLOY → VALIDATE → ACCEPTED)
with project cards, state transition history, and real-time updates.

---

## Wireframe

### Phone Layout

```
┌──────────────────────────────────────┐
│  ← Projects                          │
├──────────────────────────────────────┤
│                                      │
│  ─── State Machine ──────────────── │
│                                      │
│  [CREATE] → [PLANNING] → [REVIEW]   │
│      ↓                               │
│  [IN_PROGRESS] → [QA] → [DEPLOY]    │
│      ↓                               │
│  [VALIDATE] → [ACCEPTED]             │
│                                      │
│  ─── Projects (2) ──────────────── │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  API Authentication            │  │
│  │  State: ● IN_PROGRESS          │  │
│  │  4 transitions                 │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  Dashboard Refactor            │  │
│  │  State: ● QA                   │  │
│  │  6 transitions                 │  │
│  └────────────────────────────────┘  │
│                                      │
├──────────────────────────────────────┤
│ [Home] [Agents] [Sessions] [Tasks]  │
│                                      │
└──────────────────────────────────────┘
```

### Project Detail (Navigate or Bottom Sheet)

```
┌──────────────────────────────────────┐
│  ← API Authentication                │
├──────────────────────────────────────┤
│                                      │
│  State Machine (highlighted)         │
│  [CREATE✓] → [PLANNING✓] → [REVIEW✓]│
│      ↓                               │
│  [●IN_PROGRESS] → [ QA ] → [DEPLOY] │
│      ↓                               │
│  [VALIDATE] → [ACCEPTED]             │
│                                      │
│  ─── Transition History ──────────── │
│                                      │
│  12:00:00  CREATE                    │
│  12:05:30  PLANNING                  │
│  12:15:45  REVIEW                    │
│  12:30:00  IN_PROGRESS  ← current   │
│                                      │
└──────────────────────────────────────┘
```

---

## Key Files

```
app/src/main/kotlin/bar/bto/meshsix/
├── ui/
│   └── screens/
│       └── projects/
│           ├── ProjectLifecycleScreen.kt  # Main screen
│           ├── ProjectViewModel.kt        # UI state
│           ├── StateMachineViz.kt         # State machine diagram
│           ├── ProjectCard.kt             # Project summary card
│           └── TransitionHistory.kt       # Transition timeline
```

---

## Implementation Tasks

### 8.1 — StateMachineViz

A horizontal state diagram rendered with Compose Canvas or Row of state chips.
Highlights current state, marks completed states, dims future states.

```kotlin
@Composable
fun StateMachineViz(
    currentState: ProjectPhase?,
    history: List<ProjectTransition>,
    modifier: Modifier = Modifier,
) {
    val states = ProjectPhase.entries
    val visitedStates = history.map { it.state }.toSet()

    // Wrap into 2-3 rows for phone display
    FlowRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.Center,
    ) {
        states.forEachIndexed { index, state ->
            val isCurrent = state == currentState
            val isPast = state in visitedStates && !isCurrent
            val isFuture = !isCurrent && !isPast

            StateChip(
                label = state.name,
                isCurrent = isCurrent,
                isPast = isPast,
                isFuture = isFuture,
            )

            if (index < states.size - 1) {
                ArrowIcon()
            }
        }
    }
}
```

### 8.2 — ProjectCard

```kotlin
@Composable
fun ProjectCard(
    project: Project,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    Card(
        onClick = onClick,
        colors = CardDefaults.cardColors(
            containerColor = if (isSelected)
                MeshColors.MeshGreen.copy(alpha = 0.1f)
            else MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(text = project.name, fontWeight = FontWeight.Medium)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(text = "State: ", style = MaterialTheme.typography.bodySmall)
                Text(
                    text = project.currentState.name,
                    fontWeight = FontWeight.SemiBold,
                    color = MeshColors.MeshGreen,
                )
            }
            Text(
                text = "${project.history.size} transitions",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
```

### 8.3 — TransitionHistory

```kotlin
@Composable
fun TransitionHistory(
    history: List<ProjectTransition>,
    currentState: ProjectPhase,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier) {
        history.forEachIndexed { index, transition ->
            val isCurrent = transition.state == currentState && index == history.lastIndex
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(vertical = 4.dp),
            ) {
                // Timestamp
                Text(
                    text = formatTime(transition.timestamp),
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.width(12.dp))
                // State chip
                Surface(
                    shape = RoundedCornerShape(4.dp),
                    color = if (isCurrent)
                        MeshColors.MeshGreen.copy(alpha = 0.2f)
                    else MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Text(
                        text = transition.state.name,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        fontWeight = if (isCurrent) FontWeight.SemiBold else FontWeight.Normal,
                        color = if (isCurrent) MeshColors.MeshGreen
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (isCurrent) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "← current",
                        style = MaterialTheme.typography.labelSmall,
                        color = MeshColors.MeshGreen,
                    )
                }
            }
        }
    }
}
```

---

## Acceptance Criteria

- [ ] State machine visualization renders all 8 phases
- [ ] Current state is highlighted with mesh-six accent color
- [ ] Visited states are marked as completed (different shade)
- [ ] Future states are dimmed
- [ ] Project cards populate from MQTT `agent/project/#` events
- [ ] Tapping a project shows its state in the visualization
- [ ] Transition history shows chronological state changes
- [ ] New project events update in real-time
- [ ] Phone layout wraps state machine into multiple rows
- [ ] Tablet layout can show state machine in a single row
- [ ] Empty state message when no projects exist

---

## Tablet Layout — NavigableListDetailPaneScaffold

On tablets, the project screen uses `NavigableListDetailPaneScaffold` from M3
Adaptive (Feature 13) to show the project list and detail (with state machine
visualization and transition history) side-by-side. On phones, tapping a project
navigates to a full-screen detail view with predictive back gesture support.

---

## Notes for Implementer

- Reference `ProjectLifecycle.tsx` from the web dashboard. Match the state list and behavior.
- The 8 states are: CREATE, PLANNING, REVIEW, IN_PROGRESS, QA, DEPLOY, VALIDATE, ACCEPTED.
- MQTT payloads may include `projectId`, `id`, `state`, `status`, `name`, `projectName`, `timestamp` — normalize these like the web dashboard does.
- For the state machine visualization on phone, use `FlowRow` (from Compose Foundation) to wrap states into 2-3 rows. On tablets, a single `Row` should fit.
- Use `NavigableListDetailPaneScaffold` for the list-detail layout. Project data classes must implement `@Parcelize` for state preservation.
- See `AgentsScreen.kt` in the bootstrapped `android/` directory for the reference implementation of the list-detail pattern.
