# Feature 13 — Responsive Layout & Tablet Adaptive UI

> Ensures the app looks great on both the Pixel 10 Pro XL (phone) and large
> Android tablets. Implements adaptive navigation and layout scaffolding.

## Dependencies

- **Feature 01** — Project Setup (Navigation, Theme)

## Depended On By

- All screen features (04-09, 12) use the adaptive layout scaffold

---

## Objective

Implement a responsive navigation and layout system that automatically adapts
between phone and tablet form factors. Phones use bottom navigation; tablets
use a navigation rail. List/detail screens show side-by-side on tablets.

---

## Window Size Classes

| Class | Width | Example Device | Navigation | Layout |
|-------|-------|----------------|------------|--------|
| Compact | < 600dp | Pixel 10 Pro XL (portrait) | Bottom nav | Single column |
| Medium | 600-840dp | Pixel 10 Pro XL (landscape), Small tablet | Navigation rail | Two-column where applicable |
| Expanded | > 840dp | Large tablet landscape | Navigation rail | List+detail side-by-side |

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                   MeshSixNavGraph                           │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  AdaptiveScaffold                                     │  │
│  │                                                        │  │
│  │  Compact:                                              │  │
│  │  ┌──────────────────────────────────────────────┐    │  │
│  │  │           Content Area                        │    │  │
│  │  ├──────────────────────────────────────────────┤    │  │
│  │  │  [Home] [Agents] [Sessions] [Tasks] [More]   │    │  │
│  │  └──────────────────────────────────────────────┘    │  │
│  │                                                        │  │
│  │  Medium / Expanded:                                    │  │
│  │  ┌─────┬────────────────────────────────────────┐    │  │
│  │  │     │                                         │    │  │
│  │  │ NAV │           Content Area                  │    │  │
│  │  │RAIL │                                         │    │  │
│  │  │     │                                         │    │  │
│  │  └─────┴────────────────────────────────────────┘    │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

---

## Key Files

```
app/src/main/kotlin/bar/bto/meshsix/
├── ui/
│   ├── adaptive/
│   │   ├── AdaptiveScaffold.kt        # Main adaptive navigation scaffold
│   │   ├── WindowSizeClass.kt         # Window size class calculation
│   │   ├── NavigationItems.kt         # Shared navigation destinations
│   │   └── ListDetailLayout.kt        # Reusable list+detail pattern
│   └── theme/
│       └── Dimensions.kt             # Adaptive padding/spacing values
```

---

## Implementation Tasks

### 13.1 — WindowSizeClass

```kotlin
enum class WindowWidthClass { COMPACT, MEDIUM, EXPANDED }

@Composable
fun calculateWindowWidthClass(): WindowWidthClass {
    val configuration = LocalConfiguration.current
    val widthDp = configuration.screenWidthDp

    return when {
        widthDp < 600 -> WindowWidthClass.COMPACT
        widthDp < 840 -> WindowWidthClass.MEDIUM
        else -> WindowWidthClass.EXPANDED
    }
}
```

Or use the official Material 3 `material3-window-size-class` artifact:
```kotlin
val windowSizeClass = calculateWindowSizeClass(this)
```

### 13.2 — AdaptiveScaffold

```kotlin
@Composable
fun AdaptiveScaffold(
    navController: NavHostController,
    windowWidthClass: WindowWidthClass,
    content: @Composable () -> Unit,
) {
    val destinations = NavigationItems.all

    when (windowWidthClass) {
        WindowWidthClass.COMPACT -> {
            Scaffold(
                bottomBar = {
                    NavigationBar {
                        destinations.take(5).forEach { dest ->
                            NavigationBarItem(
                                icon = { Icon(dest.icon, contentDescription = dest.label) },
                                label = { Text(dest.label) },
                                selected = currentRoute == dest.route,
                                onClick = { navController.navigate(dest.route) },
                            )
                        }
                    }
                },
            ) { padding ->
                Box(modifier = Modifier.padding(padding)) {
                    content()
                }
            }
        }

        WindowWidthClass.MEDIUM,
        WindowWidthClass.EXPANDED -> {
            Row {
                NavigationRail(
                    header = {
                        Text(
                            text = "M6",
                            style = MaterialTheme.typography.titleMedium,
                            color = MeshColors.MeshGreen,
                            modifier = Modifier.padding(vertical = 16.dp),
                        )
                    },
                ) {
                    destinations.forEach { dest ->
                        NavigationRailItem(
                            icon = { Icon(dest.icon, contentDescription = dest.label) },
                            label = { Text(dest.label) },
                            selected = currentRoute == dest.route,
                            onClick = { navController.navigate(dest.route) },
                        )
                    }
                }
                Box(modifier = Modifier.weight(1f)) {
                    content()
                }
            }
        }
    }
}
```

### 13.3 — NavigationItems

```kotlin
object NavigationItems {
    data class Destination(
        val route: String,
        val label: String,
        val icon: ImageVector,
    )

    val all = listOf(
        Destination("dashboard", "Home", Icons.Default.Dashboard),
        Destination("agents", "Agents", Icons.Default.Group),
        Destination("sessions", "Sessions", Icons.Default.Terminal),
        Destination("tasks", "Tasks", Icons.Default.List),
        Destination("projects", "Projects", Icons.Default.Folder),
        Destination("llm-actors", "LLM", Icons.Default.Memory),
        Destination("settings", "Settings", Icons.Default.Settings),
    )

    // Compact mode shows 5 items: Home, Agents, Sessions, Tasks, More
    // "More" expands to Projects, LLM, Settings
}
```

### 13.4 — ListDetailLayout

Reusable pattern for screens that have a list and a detail view
(Sessions, Agents, Projects):

```kotlin
@Composable
fun <T> ListDetailLayout(
    windowWidthClass: WindowWidthClass,
    items: List<T>,
    selectedItem: T?,
    onSelectItem: (T) -> Unit,
    listContent: @Composable (T, Boolean) -> Unit,
    detailContent: @Composable (T) -> Unit,
    emptyDetailContent: @Composable () -> Unit = {
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            Text("Select an item", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    },
) {
    when (windowWidthClass) {
        WindowWidthClass.COMPACT -> {
            // Phone: List only, detail via navigation or bottom sheet
            LazyColumn {
                items(items) { item ->
                    listContent(item, item == selectedItem)
                }
            }
        }

        WindowWidthClass.MEDIUM -> {
            // Medium: 40/60 split
            Row(modifier = Modifier.fillMaxSize()) {
                LazyColumn(modifier = Modifier.weight(0.4f)) {
                    items(items) { item ->
                        listContent(item, item == selectedItem)
                    }
                }
                VerticalDivider()
                Box(modifier = Modifier.weight(0.6f)) {
                    if (selectedItem != null) {
                        detailContent(selectedItem)
                    } else {
                        emptyDetailContent()
                    }
                }
            }
        }

        WindowWidthClass.EXPANDED -> {
            // Expanded: 30/70 split
            Row(modifier = Modifier.fillMaxSize()) {
                LazyColumn(modifier = Modifier.weight(0.3f)) {
                    items(items) { item ->
                        listContent(item, item == selectedItem)
                    }
                }
                VerticalDivider()
                Box(modifier = Modifier.weight(0.7f)) {
                    if (selectedItem != null) {
                        detailContent(selectedItem)
                    } else {
                        emptyDetailContent()
                    }
                }
            }
        }
    }
}
```

### 13.5 — Adaptive Dimensions

```kotlin
object Dimensions {
    @Composable
    fun screenPadding(windowWidthClass: WindowWidthClass): PaddingValues {
        return when (windowWidthClass) {
            WindowWidthClass.COMPACT -> PaddingValues(16.dp)
            WindowWidthClass.MEDIUM -> PaddingValues(24.dp)
            WindowWidthClass.EXPANDED -> PaddingValues(32.dp)
        }
    }

    @Composable
    fun cardGrid(windowWidthClass: WindowWidthClass): Int {
        return when (windowWidthClass) {
            WindowWidthClass.COMPACT -> 2   // 2-column grid
            WindowWidthClass.MEDIUM -> 3    // 3-column grid
            WindowWidthClass.EXPANDED -> 4  // 4-column grid
        }
    }
}
```

### 13.6 — Bottom Nav Overflow ("More" Menu)

On compact screens, the bottom nav bar has 5 slots. With 7 destinations,
use a "More" item that shows a popup menu:

```kotlin
// In the bottom navigation bar, the 5th item:
NavigationBarItem(
    icon = { Icon(Icons.Default.MoreHoriz, contentDescription = "More") },
    label = { Text("More") },
    selected = currentRoute in listOf("projects", "llm-actors", "settings"),
    onClick = { showMoreMenu = true },
)

// DropdownMenu with remaining destinations
DropdownMenu(expanded = showMoreMenu, onDismissRequest = { showMoreMenu = false }) {
    DropdownMenuItem(
        text = { Text("Projects") },
        onClick = { navController.navigate("projects"); showMoreMenu = false },
    )
    DropdownMenuItem(
        text = { Text("LLM Actors") },
        onClick = { navController.navigate("llm-actors"); showMoreMenu = false },
    )
    DropdownMenuItem(
        text = { Text("Settings") },
        onClick = { navController.navigate("settings"); showMoreMenu = false },
    )
}
```

---

## Acceptance Criteria

- [ ] Phone (compact): Bottom navigation bar with 5 items + More menu
- [ ] Tablet (medium/expanded): Navigation rail with all 7 items
- [ ] Window size class updates on orientation change
- [ ] ListDetailLayout shows list-only on phone, split on tablet
- [ ] Content padding adapts to screen size
- [ ] Dashboard card grid: 2 columns on phone, 3-4 on tablet
- [ ] Navigation state is preserved across configuration changes
- [ ] Smooth animation on orientation change
- [ ] Edge-to-edge display works on all form factors

---

## Notes for Implementer

- This feature provides the **scaffolding** used by all other screens. It should be implemented early (Wave 2) so screens can use `ListDetailLayout` and `AdaptiveScaffold` from the start.
- Use the official `material3-window-size-class` library from the Compose BOM.
- The `ListDetailLayout` is used by: Sessions (Feature 06), Agents (Feature 05), Projects (Feature 08).
- Test with both the Pixel 10 Pro XL and a large tablet emulator (e.g., Pixel Tablet).
- Consider using `BackHandler` on phone to navigate from detail back to list.
- The navigation rail should show the mesh-six logo/wordmark in the header slot.
