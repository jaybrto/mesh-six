# Mesh Six Android App — Master Implementation Plan

> A native Android admin dashboard for monitoring and interacting with the mesh-six
> multi-agent orchestration system running on Jay's homelab k3s cluster.
>
> **Target devices**: Pixel 10 Pro XL, large Android tablets
> **Build environment**: Claude Code CLI on MacBook Pro M3 2023
> **Architecture**: Kotlin + Jetpack Compose, MVVM with Kotlin Flow
> **Responsive framework**: Compose Material 3 Adaptive Library
> **Secondary target**: 12.2" Android 16 Tablet (Octa-core, 48GB RAM, 2.5K Display)

---

## Table of Contents

### Foundation
1. [Feature 01 — Project Setup & Build Infrastructure](./01-project-setup.md)
2. [Feature 02 — MQTT Connectivity Layer](./02-mqtt-connectivity.md)
3. [Feature 03 — Core Data Models & State Management](./03-data-models-state.md)

### Screens
4. [Feature 04 — Dashboard Home Screen](./04-dashboard-home.md)
5. [Feature 05 — Agent Registry Screen](./05-agent-registry.md)
6. [Feature 06 — Claude Session Monitor Screen](./06-claude-sessions.md)
7. [Feature 07 — Task Feed Screen](./07-task-feed.md)
8. [Feature 08 — Project Lifecycle Screen](./08-project-lifecycle.md)
9. [Feature 09 — LLM Service & Actor Monitor Screen](./09-llm-actors.md)

### Platform Integration
10. [Feature 10 — Push Notifications via ntfy.sh](./10-push-notifications.md)
11. [Feature 11 — Background Service & Doze Handling](./11-background-service.md)
12. [Feature 12 — Settings & Configuration Screen](./12-settings.md)

### Cross-Cutting
13. [Feature 13 — Responsive Layout & Tablet Adaptive UI](./13-responsive-layout.md)
14. [Feature 14 — REST API Integration Layer](./14-rest-api.md)

---

## Dependency Graph

```
Feature 01 (Project Setup)
    │
    ├──▶ Feature 02 (MQTT Connectivity)
    │       │
    │       ├──▶ Feature 06 (Claude Sessions)  ←── Feature 03
    │       ├──▶ Feature 07 (Task Feed)        ←── Feature 03
    │       ├──▶ Feature 08 (Project Lifecycle) ←── Feature 03
    │       └──▶ Feature 05 (Agent Registry)   ←── Feature 03
    │
    ├──▶ Feature 03 (Data Models & State)
    │       │
    │       ├──▶ Feature 04 (Dashboard Home)   ←── Feature 02
    │       └──▶ Feature 09 (LLM Actors)       ←── Feature 14
    │
    ├──▶ Feature 13 (Responsive Layout)  ← parallel with Features 02-03
    │
    ├──▶ Feature 14 (REST API)
    │       │
    │       └──▶ Feature 09 (LLM Actors)
    │
    ├──▶ Feature 10 (Push Notifications) ← parallel, depends only on 01
    │
    ├──▶ Feature 11 (Background Service) ← depends on 02, 10
    │
    └──▶ Feature 12 (Settings)           ← depends on 02, 10, 11
```

### Critical Path (serial)

```
01 → 02 → 03 → 06 (Claude Sessions) → 04 (Dashboard Home)
```

The Claude Session Monitor is the highest-value screen since it consumes the
`event-publisher.ts` hook events that are the primary use case for this app.

### Parallelizable Work

After Feature 01 completes, these can run in parallel:
- **Stream A**: Feature 02 (MQTT) → Feature 06 (Sessions) → Feature 07 (Tasks) → Feature 08 (Projects)
- **Stream B**: Feature 03 (State) — can overlap with Stream A since types are known upfront
- **Stream C**: Feature 13 (Responsive Layout) — independent UI scaffolding
- **Stream D**: Feature 10 (Notifications) + Feature 14 (REST API) — independent platform integrations

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                     Android App (Kotlin/Compose)                  │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    UI Layer (Compose)                        │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │  │
│  │  │Dashboard │ │ Agents   │ │Sessions  │ │ Tasks    │     │  │
│  │  │  Home    │ │ Registry │ │ Monitor  │ │  Feed    │     │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘     │  │
│  │       └─────────────┴─────────────┴─────────────┘           │  │
│  └──────────────────────────┬─────────────────────────────────┘  │
│                              │                                     │
│  ┌──────────────────────────┼─────────────────────────────────┐  │
│  │                  ViewModel Layer                              │  │
│  │  ┌──────────────────────────────────────────────────┐      │  │
│  │  │  ViewModels expose StateFlow<UiState> to Compose │      │  │
│  │  │  Each screen has its own ViewModel                │      │  │
│  │  └──────────────────────────┬───────────────────────┘      │  │
│  └─────────────────────────────┤──────────────────────────────┘  │
│                                │                                   │
│  ┌─────────────────────────────┼──────────────────────────────┐  │
│  │                   Data Layer                                 │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │  │
│  │  │ MqttManager  │  │ RestClient   │  │ NtfyReceiver │     │  │
│  │  │ (Paho MQTT)  │  │ (OkHttp)     │  │ (SSE/Polling)│     │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │  │
│  │         │                 │                  │              │  │
│  │  ┌──────┴─────────────────┴──────────────────┴──────────┐  │  │
│  │  │              Repository Layer                          │  │  │
│  │  │  Merges MQTT streams + REST snapshots + notifications │  │  │
│  │  │  Exposes Kotlin Flows to ViewModels                   │  │  │
│  │  └───────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┼─────────┐
                    │         │         │
              ┌─────▼───┐ ┌──▼────┐ ┌──▼─────────┐
              │RabbitMQ │ │ Hono  │ │ ntfy.sh    │
              │MQTT     │ │ APIs  │ │ (self-host)│
              │1883/WSS │ │       │ │            │
              └─────────┘ └───────┘ └────────────┘
```

---

## Connectivity Model

The app connects to the homelab via three possible network paths, tried in order:

| Path | Transport | Target | Timeout | When Used |
|------|-----------|--------|---------|-----------|
| LAN  | TCP MQTT  | `10.43.x.x:1883` | Unlimited | On homelab WiFi |
| WARP | TCP MQTT  | `10.43.x.x:1883` via Cloudflare WARP | 8 hours | WARP VPN active |
| WSS  | WebSocket MQTT | `wss://mqtt.bto.bar/ws` | 100 seconds | Fallback |

The `ConnectionStrategy` class in Feature 02 handles automatic failover and
reconnection between these paths.

---

## MQTT Topics Consumed

| Topic Pattern | Source | Screen |
|---------------|--------|--------|
| `claude/progress/#` | `claude-mqtt-bridge` (hook events) | Claude Sessions |
| `claude/progress/+/SessionStart` | Hook: session start | Claude Sessions |
| `claude/progress/+/PostToolUse` | Hook: tool completion | Claude Sessions |
| `claude/progress/+/SessionEnd` | Hook: session end | Claude Sessions |
| `agent/registry/#` | Agent heartbeats | Agent Registry |
| `agent/task/#` | Task dispatches/results | Task Feed |
| `agent/project/#` | PM state transitions | Project Lifecycle |
| `llm.events` | LLM service hook events (Dapr) | LLM Actors |

---

## REST API Endpoints Consumed

| Endpoint | Source Service | Screen |
|----------|---------------|--------|
| `GET /healthz` | All agents | Agent Registry (health check) |
| `GET /status` | LLM Service | LLM Actors |
| `GET /tasks` | Orchestrator | Task Feed (initial state) |
| `GET /projects/:id` | Project Manager | Project Lifecycle (detail) |
| `POST /tasks` | Orchestrator | Task submission (future) |

---

## Message Types (Kotlin Data Classes)

These mirror the TypeScript types from `@mesh-six/core` and `claude-mqtt-bridge`:

```kotlin
// From @mesh-six/core types.ts
data class AgentRegistration(
    val name: String,
    val appId: String,
    val capabilities: List<AgentCapability>,
    val status: String, // "online" | "degraded" | "offline"
    val healthChecks: Map<String, String>,
    val lastHeartbeat: String,
    val metadata: Map<String, Any>? = null
)

// From claude-mqtt-bridge EnrichedEvent
data class ClaudeEvent(
    val timestamp: Long,
    val sessionId: String,
    val event: String, // SessionStart, PreToolUse, PostToolUse, etc.
    val status: String, // started, pending, completed, failed, ended
    val gitBranch: String? = null,
    val worktreePath: String? = null,
    val model: String? = null,
    val jobId: String? = null,
    val toolName: String? = null,
    val toolInput: Map<String, Any>? = null,
    val toolResponse: Map<String, Any>? = null,
    val error: String? = null,
    val agentId: String? = null,
    val agentType: String? = null,
    val source: String? = null,
    val reason: String? = null,
    val notification: NotificationPayload? = null
)

// From llm-service.ts CLIHookEvent
data class LlmHookEvent(
    val actorId: String,
    val sessionId: String? = null,
    val timestamp: String,
    val hookEvent: String,
    val toolName: String? = null,
    val toolInput: Map<String, Any>? = null,
    val toolResponse: Map<String, Any>? = null,
    val error: String? = null,
    val model: String? = null,
    val durationMs: Long? = null
)
```

---

## Tech Stack Summary

| Component | Library | Version | Notes |
|-----------|---------|---------|-------|
| Language | Kotlin | 2.1.0 | |
| UI | Jetpack Compose | BOM 2025.01.01 | Material 3 |
| **Responsive** | **M3 Adaptive** | **1.1.0** | **NavigationSuiteScaffold + NavigableListDetailPaneScaffold** |
| Adaptive Nav Suite | `material3-adaptive-navigation-suite` | BOM | Auto bottom-bar / rail / drawer |
| Adaptive Layout | `adaptive-layout` | 1.1.0 | ListDetailPaneScaffold |
| Adaptive Navigation | `adaptive-navigation` | 1.1.0 | NavigableListDetailPaneScaffold + predictive back |
| MQTT | hannesa2/paho.mqtt.android | v3.6.4 | JitPack |
| HTTP | OkHttp | 4.12.0 | REST + WSS |
| JSON | Kotlinx Serialization | 1.7.3 | |
| DI | Hilt | 2.53.1 | |
| Navigation | Compose Navigation | 2.8.6 | |
| State | Kotlin Flow + StateFlow | | |
| Push | ntfy.sh | | Self-hosted, no Firebase |
| Architecture | MVVM | | ViewModel + Repository |
| Build | Gradle KTS | | AGP 8.7.3 |
| Min SDK | 28 (Android 9) | | Pixel 10 Pro XL ships with Android 16 |
| Target SDK | 35 (Android 15) | | Latest stable |

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| No Firebase | ntfy.sh | Self-hosted, Jay's homelab philosophy. No Google dependency. |
| No Room DB | In-memory only | Events are ephemeral streams. REST API provides initial state. SQLite on-device is only for cached settings. |
| QoS 1 only | Not QoS 2 | RabbitMQ doesn't support QoS 2 MQTT. |
| No terminal view | Removed | User specified terminal doesn't apply. |
| Paho MQTT over HiveMQ | Paho | More mature, better Android lifecycle support. |
| Kotlinx Serialization over Gson | Kotlinx | Kotlin-native, compile-time safe, smaller. |
| **M3 Adaptive over manual breakpoints** | **NavigationSuiteScaffold + NavigableListDetailPaneScaffold** | **Zero manual breakpoint math. Library handles bottom nav ↔ rail ↔ drawer and list/detail pane splitting automatically based on Window Size Classes.** |
| **GridCells.Adaptive** | **LazyVerticalGrid** | **Dashboard cards auto-fill 2 cols on phone, 3-4+ on 2.5K tablet display without hardcoded column counts.** |

---

## Gotchas & Constraints

1. **Android Doze mode**: Restricts network access during deep sleep. MQTT keepalive may not fire. Feature 11 addresses this with `WorkManager` and foreground service.
2. **OEM battery killers**: Samsung/OnePlus/Xiaomi may kill foreground services. ntfy.sh push is the essential backup channel (Feature 10).
3. **WARP VPN on Android**: May be killed in background. Recommend Always-on VPN + battery optimization whitelist. Documented in Feature 12.
4. **MQTT QoS 2**: NOT supported by RabbitMQ. Use QoS 1 everywhere.
5. **Retained messages**: Node-local in RabbitMQ. Always fetch initial state via REST API, don't rely on MQTT retained.
6. **No Dapr sidecar**: The Android app connects directly to RabbitMQ MQTT. It does NOT go through Dapr. Agent HTTP APIs are called directly (or through Caddy/Traefik ingress).
7. **GPLv3 terminal-view**: Not used in this app (terminal view removed from scope).
8. **Clock drift**: Android timestamps vs server timestamps. All display logic should handle UTC consistently.

---

## Build & Development

The app is built using Claude Code CLI on a MacBook Pro M3 2023. Development workflow:

```bash
# From the mesh-six repo root
cd android

# Build debug APK
./gradlew assembleDebug

# Install to connected device
./gradlew installDebug

# Run lint checks
./gradlew lint

# Run unit tests
./gradlew testDebugUnitTest
```

The `android/` directory lives at the root of the mesh-six monorepo but is NOT
part of the Bun workspace. It has its own Gradle build system.

---

## Implementation Order (Recommended for Claude Teams Swarm)

### Wave 1 — Foundation (must be serial)
1. **Feature 01** — Project Setup

### Wave 2 — Core Infrastructure (can parallelize)
2. **Feature 02** — MQTT Connectivity (depends on 01)
3. **Feature 03** — Data Models & State (depends on 01)
4. **Feature 13** — Responsive Layout scaffolding (depends on 01)
5. **Feature 14** — REST API client (depends on 01)

### Wave 3 — Screens (can parallelize after Wave 2)
6. **Feature 06** — Claude Sessions (depends on 02, 03) ← **highest priority**
7. **Feature 05** — Agent Registry (depends on 02, 03)
8. **Feature 07** — Task Feed (depends on 02, 03)
9. **Feature 08** — Project Lifecycle (depends on 02, 03)
10. **Feature 09** — LLM Actors (depends on 03, 14)

### Wave 4 — Dashboard & Platform (can parallelize after Wave 3)
11. **Feature 04** — Dashboard Home (depends on 02, 03, 05, 06, 07)
12. **Feature 10** — Push Notifications (depends on 01)
13. **Feature 11** — Background Service (depends on 02, 10)
14. **Feature 12** — Settings (depends on 02, 10, 11)

---

*Document created: 2026-02-20*
*Architecture designed for Jay's homelab mesh-six system*
