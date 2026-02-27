# Feature 01 — Project Setup & Build Infrastructure

> Foundation feature. All other features depend on this.

## Dependencies

- **None** — this is the first feature to implement.

## Depended On By

- Every other feature (02-14)

---

## Objective

Set up the Android project skeleton inside the `mesh-six` monorepo with Gradle KTS build scripts, Hilt DI, Compose navigation, and the app theme. After this feature, the app compiles, launches, and shows a placeholder screen.

---

## Directory Structure

```
android/
├── app/
│   ├── src/
│   │   ├── main/
│   │   │   ├── kotlin/bar/bto/meshsix/
│   │   │   │   ├── MeshSixApp.kt              # @HiltAndroidApp Application class
│   │   │   │   ├── MainActivity.kt             # @AndroidEntryPoint single-activity host
│   │   │   │   ├── ui/
│   │   │   │   │   ├── navigation/
│   │   │   │   │   │   └── MainScaffold.kt     # NavigationSuiteScaffold (M3 Adaptive)
│   │   │   │   │   ├── screens/
│   │   │   │   │   │   ├── DashboardScreen.kt  # GridCells.Adaptive summary grid
│   │   │   │   │   │   ├── AgentsScreen.kt     # NavigableListDetailPaneScaffold
│   │   │   │   │   │   └── SettingsScreen.kt   # Scrollable config display
│   │   │   │   │   └── theme/
│   │   │   │   │       ├── Theme.kt            # Material 3 dark theme
│   │   │   │   │       ├── Color.kt            # mesh-six brand colors
│   │   │   │   │       └── Type.kt             # Typography (monospace for data)
│   │   │   ├── res/
│   │   │   │   ├── values/
│   │   │   │   │   ├── strings.xml
│   │   │   │   │   └── themes.xml              # Splash/compat theme
│   │   │   │   ├── mipmap-*/                   # App icon
│   │   │   │   └── drawable/                   # Vector assets
│   │   │   └── AndroidManifest.xml
│   │   └── test/
│   │       └── kotlin/bar/bto/meshsix/         # Unit test directory
│   ├── build.gradle.kts                        # App-level build config
│   └── proguard-rules.pro
├── build.gradle.kts                            # Root build config
├── settings.gradle.kts                         # Project settings + JitPack repo
├── gradle.properties                           # JVM args, Android X, Kotlin options
├── gradle/
│   └── libs.versions.toml                      # Version catalog
└── .gitignore                                  # Android-specific ignores
```

---

## Implementation Tasks

### 1.1 — Root Gradle Configuration

**`android/settings.gradle.kts`**:
```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven("https://jitpack.io")  // For Paho MQTT
    }
}
rootProject.name = "mesh-six-android"
include(":app")
```

**`android/build.gradle.kts`** (root):
```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.hilt) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
```

### 1.2 — Version Catalog

**`android/gradle/libs.versions.toml`**:

Key dependencies:
| Group | Artifact | Version | Purpose |
|-------|----------|---------|---------|
| `androidx.compose` | BOM | 2025.01.01 | Compose UI framework |
| `androidx.compose.material3.adaptive` | adaptive | 1.1.0 | M3 Adaptive core |
| `androidx.compose.material3.adaptive` | adaptive-layout | 1.1.0 | ListDetailPaneScaffold |
| `androidx.compose.material3.adaptive` | adaptive-navigation | 1.1.0 | NavigableListDetailPaneScaffold |
| `androidx.compose.material3` | material3-adaptive-navigation-suite | BOM | NavigationSuiteScaffold |
| `androidx.navigation` | compose | 2.8.6 | Navigation |
| `androidx.hilt` | navigation-compose | 1.2+ | DI-aware navigation |
| `com.google.dagger` | hilt-android | 2.53.1 | Dependency injection |
| `org.jetbrains.kotlinx` | serialization-json | 1.7.3 | JSON parsing |
| `com.squareup.okhttp3` | okhttp | 4.12.0 | HTTP client |
| `com.github.hannesa2` | paho.mqtt.android | v3.6.4 | MQTT client |
| `androidx.lifecycle` | viewmodel-compose | 2.8+ | ViewModel integration |
| `androidx.work` | work-runtime-ktx | 2.10+ | Background work |

### 1.3 — App-Level Build Config

**`android/app/build.gradle.kts`**:

```kotlin
android {
    namespace = "bar.bto.meshsix"
    compileSdk = 35

    defaultConfig {
        applicationId = "bar.bto.meshsix"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    buildTypes {
        debug {
            // Default MQTT and API endpoints for development
            buildConfigField("String", "DEFAULT_MQTT_LAN", "\"tcp://10.43.0.100:1883\"")
            buildConfigField("String", "DEFAULT_MQTT_WSS", "\"wss://mqtt.bto.bar/ws\"")
            buildConfigField("String", "DEFAULT_API_BASE", "\"https://mesh-six.bto.bar\"")
            buildConfigField("String", "DEFAULT_NTFY_URL", "\"https://ntfy.bto.bar\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Same defaults — user configures in settings
            buildConfigField("String", "DEFAULT_MQTT_LAN", "\"tcp://10.43.0.100:1883\"")
            buildConfigField("String", "DEFAULT_MQTT_WSS", "\"wss://mqtt.bto.bar/ws\"")
            buildConfigField("String", "DEFAULT_API_BASE", "\"https://mesh-six.bto.bar\"")
            buildConfigField("String", "DEFAULT_NTFY_URL", "\"https://ntfy.bto.bar\"")
        }
    }
}
```

### 1.4 — Application Class & Hilt

**`MeshSixApp.kt`**:
```kotlin
@HiltAndroidApp
class MeshSixApp : Application()
```

**`MainActivity.kt`**:
```kotlin
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MeshSixTheme {
                MeshSixNavGraph()
            }
        }
    }
}
```

### 1.5 — Theme

Dark theme matching the web dashboard's zinc/mesh color palette:

| Token | Hex | Usage |
|-------|-----|-------|
| `mesh-300` | `#6EE7B7` | Active text, highlights |
| `mesh-400` | `#34D399` | Brand accent |
| `mesh-500` | `#10B981` | Primary |
| `mesh-600` | `#059669` | Containers, chips |
| `zinc-800` | `#27272A` | Borders |
| `zinc-900` | `#18181B` | Surface/background |
| `zinc-950` | `#09090B` | Deep background |

Typography: `JetBrains Mono` for data/code text, system default for UI text.

### 1.6 — Navigation Shell (M3 Adaptive)

**`MainScaffold.kt`** — Uses `NavigationSuiteScaffold` from M3 Adaptive to
automatically switch between bottom nav (phone), rail (tablet portrait), and
drawer (tablet landscape). No manual breakpoint logic needed.

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

**`MainActivity.kt`** calls `MainScaffold()` inside `MeshSixTheme`.

### 1.7 — AndroidManifest Permissions

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
```

### 1.8 — .gitignore

Standard Android `.gitignore`: `.gradle/`, `build/`, `local.properties`, `*.apk`, `*.aab`, `.idea/`, `captures/`.

---

## Acceptance Criteria

- [ ] `./gradlew assembleDebug` succeeds from `android/` directory
- [ ] App launches on Pixel 10 Pro XL emulator (API 35)
- [ ] App shows `NavigationSuiteScaffold` with bottom nav (phone) or rail (tablet)
- [ ] Dark theme with mesh-six brand colors applied
- [ ] Hilt DI is configured and injectable
- [ ] Navigation between all placeholder screens works
- [ ] JitPack repository configured for Paho MQTT dependency resolution
- [ ] `proguard-rules.pro` has entries for kotlinx-serialization and OkHttp
- [ ] All gradle dependencies resolve without errors

---

## Estimated Scope

- ~15 files to create
- Primarily boilerplate/configuration
- No business logic

---

## Notes for Implementer

- The `android/` directory is NOT part of the Bun monorepo workspace. It lives alongside the Bun workspace root but has its own Gradle build system.
- Use Gradle KTS (`.kts`) throughout, not Groovy.
- Use the version catalog (`libs.versions.toml`) for all dependency versions.
- The package name is `bar.bto.meshsix` (no hyphen — Java/Kotlin package naming rules).
- Start with `minSdk = 28` (Android 9 Pie). The Pixel 10 Pro XL will run Android 16, but 28 is a safe floor for library compatibility.
- Use `enableEdgeToEdge()` in MainActivity for modern Android 15+ edge-to-edge display.
