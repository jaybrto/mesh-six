# Feature 13 — Responsive Layout & Tablet Adaptive UI

> Uses **Compose Material 3 Adaptive Library** to handle all responsive layout
> automatically. Zero manual breakpoint math — the library detects Window Size
> Classes and switches between bottom nav, rail, drawer, and list/detail splits.

## Dependencies

- **Feature 01** — Project Setup (Navigation, Theme, M3 Adaptive dependencies)

## Depended On By

- All screen features (04-09, 12) use the adaptive layout scaffolding

---

## Objective

Leverage the Material 3 Adaptive library to provide automatic responsive
navigation and layout across phone (Pixel 10 Pro XL) and tablet (12.2" Android 16
Tablet with 2.5K display). The library handles all Window Size Class detection
and navigation mode switching — no manual breakpoint calculations needed.

---

## Target Devices

| Device | Display | Window Size Class | Navigation Mode |
|--------|---------|-------------------|-----------------|
| Pixel 10 Pro XL (portrait) | ~6.9" | Compact | Bottom nav bar |
| Pixel 10 Pro XL (landscape) | ~6.9" | Medium | Navigation rail |
| 12.2" Tablet (portrait) | 2.5K | Medium/Expanded | Navigation rail |
| 12.2" Tablet (landscape) | 2.5K | Expanded | Navigation rail/drawer |

---

## Architecture — M3 Adaptive Components

### 1. NavigationSuiteScaffold (Top-Level Navigation)

Replaces all manual `NavigationBar` / `NavigationRail` switching. The library
automatically selects the correct navigation chrome based on Window Size Class:

- **Compact** → Bottom navigation bar
- **Medium** → Navigation rail
- **Expanded** → Navigation rail or permanent drawer

**Reference implementation**: `android/app/src/main/kotlin/bar/bto/meshsix/ui/navigation/MainScaffold.kt`

```kotlin
enum class AdminDestination(
    val label: String,
    val icon: ImageVector,
    val contentDescription: String,
) {
    DASHBOARD("Dashboard", Icons.Default.Dashboard, "Dashboard home"),
    AGENTS("Agents", Icons.Default.Group, "Agent registry"),
    SETTINGS("Settings", Icons.Default.Settings, "App settings"),
}

@Composable
fun MainScaffold() {
    var currentDestination by rememberSaveable { mutableStateOf(AdminDestination.DASHBOARD) }

    NavigationSuiteScaffold(
        navigationSuiteItems = {
            AdminDestination.entries.forEach { destination ->
                item(
                    icon = { Icon(destination.icon, destination.contentDescription) },
                    label = { Text(destination.label) },
                    selected = destination == currentDestination,
                    onClick = { currentDestination = destination },
                )
            }
        },
    ) {
        when (currentDestination) {
            AdminDestination.DASHBOARD -> DashboardScreen()
            AdminDestination.AGENTS -> AgentsScreen()
            AdminDestination.SETTINGS -> SettingsScreen()
        }
    }
}
```

### 2. NavigableListDetailPaneScaffold (List-Detail Screens)

Replaces all manual list/detail split logic. The library automatically:
- **Compact**: Shows list full-screen, navigates to detail on tap, supports predictive back
- **Medium/Expanded**: Shows list + detail side-by-side with automatic pane proportions

Used by: **Agents (Feature 05)**, **Claude Sessions (Feature 06)**, **Projects (Feature 08)**

**Reference implementation**: `android/app/src/main/kotlin/bar/bto/meshsix/ui/screens/AgentsScreen.kt`

```kotlin
@Composable
fun AgentsScreen() {
    val navigator = rememberListDetailPaneScaffoldNavigator<AgentData>()

    NavigableListDetailPaneScaffold(
        navigator = navigator,
        listPane = {
            AgentListPane(
                agents = agents,
                onAgentClick = { agent ->
                    navigator.navigateTo(
                        ListDetailPaneScaffoldRole.Detail,
                        agent,
                    )
                },
            )
        },
        detailPane = {
            val agent = navigator.currentDestination?.contentKey
            if (agent != null) {
                AgentDetailPane(agent = agent)
            } else {
                EmptyDetailPlaceholder()
            }
        },
    )
}
```

The `@Parcelize` annotation on data classes enables the scaffold to preserve
selection state across configuration changes (rotation, window resize).

### 3. GridCells.Adaptive (Dashboard Grid)

Replaces manual column-count calculations. The grid automatically fills the
available width:

- **Pixel 10 Pro XL** (portrait, ~393dp): 2 columns
- **Pixel 10 Pro XL** (landscape, ~851dp): 4-5 columns
- **12.2" Tablet** (portrait, ~800dp): 4 columns
- **12.2" Tablet** (landscape, ~1280dp): 7+ columns

**Reference implementation**: `android/app/src/main/kotlin/bar/bto/meshsix/ui/screens/DashboardScreen.kt`

```kotlin
LazyVerticalGrid(
    columns = GridCells.Adaptive(minSize = 160.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
) {
    items(summaryCards) { card ->
        SummaryCard(title = card.title, value = card.value, subtitle = card.subtitle)
    }
}
```

---

## Key Dependencies (in `app/build.gradle.kts`)

```kotlin
// Material 3 Adaptive — the backbone of responsive layout
implementation(libs.adaptive)                      // androidx.compose.material3.adaptive:adaptive
implementation(libs.adaptive.layout)               // adaptive-layout
implementation(libs.adaptive.navigation)           // adaptive-navigation
implementation(libs.adaptive.navigation.suite)     // adaptive-navigation-suite
```

Version: **1.1.0** (via `libs.versions.toml`)

---

## Key Files

```
app/src/main/kotlin/bar/bto/meshsix/
├── ui/
│   ├── navigation/
│   │   └── MainScaffold.kt               # NavigationSuiteScaffold (top-level)
│   └── screens/
│       ├── AgentsScreen.kt               # NavigableListDetailPaneScaffold
│       ├── DashboardScreen.kt            # GridCells.Adaptive grid
│       └── SettingsScreen.kt             # Simple scrollable column
```

No custom `AdaptiveScaffold.kt`, `WindowSizeClass.kt`, `ListDetailLayout.kt`,
or `Dimensions.kt` files needed — the M3 Adaptive library replaces all of these.

---

## What Changed From the Original Plan

| Before (Custom) | After (M3 Adaptive Library) |
|------------------|-----------------------------|
| `WindowSizeClass` enum + `calculateWindowWidthClass()` | Library auto-detects via `WindowSizeClass` |
| `AdaptiveScaffold` with manual `NavigationBar` / `NavigationRail` switching | `NavigationSuiteScaffold` handles everything |
| `ListDetailLayout` with manual `Row` + `weight()` splits | `NavigableListDetailPaneScaffold` handles everything |
| `Dimensions.cardGrid()` with manual column counts | `GridCells.Adaptive(minSize = 160.dp)` auto-fills |
| Bottom nav overflow "More" menu for 7+ destinations | `NavigationSuiteScaffold` handles overflow natively |
| Manual `BackHandler` for phone detail→list navigation | `NavigableListDetailPaneScaffold` supports predictive back |

**Lines of custom responsive code eliminated**: ~250+ lines replaced by 4 library imports.

---

## Predictive Back Gesture

`NavigableListDetailPaneScaffold` provides built-in support for Android's
predictive back gesture. Combined with `android:enableOnBackInvokedCallback="true"`
in the AndroidManifest, users see a smooth peek animation when swiping back from
detail to list on phone form factors.

---

## Acceptance Criteria

- [ ] Phone (compact): `NavigationSuiteScaffold` renders bottom navigation bar
- [ ] Tablet (medium/expanded): `NavigationSuiteScaffold` renders navigation rail
- [ ] Navigation mode updates on orientation change without manual breakpoint code
- [ ] `NavigableListDetailPaneScaffold` shows list-only on phone, split on tablet
- [ ] `NavigableListDetailPaneScaffold` supports predictive back gesture on phone
- [ ] `GridCells.Adaptive(160.dp)` auto-fills 2 cols on phone, 4+ on tablet
- [ ] Navigation state is preserved across configuration changes
- [ ] Edge-to-edge display works on all form factors
- [ ] No custom `WindowSizeClass`, `AdaptiveScaffold`, or `ListDetailLayout` code exists
- [ ] All four M3 Adaptive dependencies are in the build configuration

---

## Notes for Implementer

- This feature is **already bootstrapped** in the `android/` directory. The reference
  implementations in `MainScaffold.kt`, `AgentsScreen.kt`, and `DashboardScreen.kt`
  demonstrate all three M3 Adaptive patterns.
- **Do NOT write custom breakpoint logic.** The library handles everything.
- The `NavigableListDetailPaneScaffold` requires data classes passed as `contentKey`
  to implement `@Parcelize` for state preservation.
- Test with both the Pixel 10 Pro XL emulator and a large tablet emulator
  (e.g., Pixel Tablet or custom 12.2" AVD).
- Official docs: [Adaptive Navigation Suite](https://developer.android.com/develop/ui/compose/layouts/adaptive/build-adaptive-navigation)
  and [List-Detail Layout](https://developer.android.com/develop/ui/compose/layouts/adaptive/list-detail)
