# Feature 14 — REST API Integration Layer

> HTTP client for fetching initial state and performing actions against mesh-six
> agent APIs. Supplements real-time MQTT streams with on-demand REST queries.

## Dependencies

- **Feature 01** — Project Setup (OkHttp, Hilt, Kotlinx Serialization)

## Depended On By

- Feature 09 (LLM Actors — `/status` endpoint)
- Feature 04 (Dashboard Home — optional initial state fetch)

---

## Objective

Implement an OkHttp-based REST client that communicates with mesh-six agent APIs.
Since MQTT only provides real-time events (no history), the REST client fetches
initial state snapshots on screen open and provides action endpoints for future
features (task submission, agent commands).

---

## Architecture

```
┌──────────────────────────────────────────────┐
│              MeshSixApiClient                  │
│                                                │
│  ┌───────────────────────────────────┐       │
│  │  OkHttpClient                      │       │
│  │  - Base URL from SettingsRepository│       │
│  │  - JSON interceptor               │       │
│  │  - Auth interceptor (optional)    │       │
│  │  - Timeout: 10s connect, 30s read │       │
│  └───────────────────────────────────┘       │
│                                                │
│  Endpoints:                                    │
│  GET  /healthz              → HealthCheck     │
│  GET  /status               → LlmServiceStatus│
│  GET  /tasks                → List<TaskStatus> │
│  GET  /tasks/:id            → TaskStatus      │
│  POST /tasks                → TaskRequest     │
│  GET  /projects/:id         → Project         │
│  GET  /agents               → AgentRegistry   │
└──────────────────────────────────────────────┘
          │
          │  HTTP (via Caddy ingress or direct)
          ▼
┌──────────────────┐
│  mesh-six agents │
│  (Hono HTTP)     │
└──────────────────┘
```

---

## Network Path

The REST client uses the same connectivity model as MQTT:
1. **LAN**: Direct HTTP to `http://10.43.x.x:3000` (internal k3s ClusterIP)
2. **WARP**: Same internal IP via WARP VPN tunnel
3. **External**: `https://mesh-six.bto.bar` via Caddy reverse proxy

The base URL is configurable in Settings (Feature 12).

---

## Key Files

```
app/src/main/kotlin/bar/bto/meshsix/
├── data/
│   └── api/
│       ├── MeshSixApiClient.kt       # Main API client
│       ├── ApiModule.kt              # Hilt module for OkHttp + client
│       ├── ApiResponse.kt            # Result wrapper
│       └── interceptors/
│           ├── JsonInterceptor.kt    # Content-Type: application/json
│           └── AuthInterceptor.kt    # Optional bearer token
```

---

## Implementation Tasks

### 14.1 — ApiResponse Wrapper

```kotlin
sealed class ApiResponse<out T> {
    data class Success<T>(val data: T) : ApiResponse<T>()
    data class Error(val code: Int, val message: String) : ApiResponse<Nothing>()
    data class NetworkError(val exception: Throwable) : ApiResponse<Nothing>()
}
```

### 14.2 — MeshSixApiClient

```kotlin
@Singleton
class MeshSixApiClient @Inject constructor(
    private val okHttpClient: OkHttpClient,
    private val json: Json,
    private val settingsRepository: SettingsRepository,
) {
    private suspend fun baseUrl(): String {
        return settingsRepository.apiBaseUrl.first()
    }

    /**
     * Health check for any agent.
     */
    suspend fun healthCheck(agentAppId: String): ApiResponse<Boolean> {
        return get<Map<String, String>>("/$agentAppId/healthz").let { response ->
            when (response) {
                is ApiResponse.Success -> ApiResponse.Success(true)
                is ApiResponse.Error -> ApiResponse.Success(response.code < 500)
                is ApiResponse.NetworkError -> response
            }
        }
    }

    /**
     * Get LLM Service status (actors, models, metrics).
     */
    suspend fun getLlmServiceStatus(): ApiResponse<LlmServiceStatus> {
        return get("/llm-service/status")
    }

    /**
     * Get recent tasks from the orchestrator.
     */
    suspend fun getTasks(limit: Int = 50): ApiResponse<List<TaskStatus>> {
        return get("/orchestrator/tasks?limit=$limit")
    }

    /**
     * Get a specific task by ID.
     */
    suspend fun getTask(taskId: String): ApiResponse<TaskStatus> {
        return get("/orchestrator/tasks/$taskId")
    }

    /**
     * Submit a new task to the orchestrator.
     */
    suspend fun submitTask(
        capability: String,
        payload: Map<String, Any>,
        priority: Int = 5,
    ): ApiResponse<TaskStatus> {
        val body = mapOf(
            "capability" to capability,
            "payload" to payload,
            "priority" to priority,
        )
        return post("/orchestrator/tasks", body)
    }

    // --- Generic HTTP methods ---

    private suspend inline fun <reified T> get(path: String): ApiResponse<T> {
        return executeRequest(
            Request.Builder()
                .url("${baseUrl()}$path")
                .get()
                .build()
        )
    }

    private suspend inline fun <reified T> post(path: String, body: Any): ApiResponse<T> {
        val jsonBody = json.encodeToString(body)
        return executeRequest(
            Request.Builder()
                .url("${baseUrl()}$path")
                .post(jsonBody.toRequestBody("application/json".toMediaType()))
                .build()
        )
    }

    private suspend inline fun <reified T> executeRequest(request: Request): ApiResponse<T> {
        return withContext(Dispatchers.IO) {
            try {
                val response = okHttpClient.newCall(request).execute()
                if (response.isSuccessful) {
                    val body = response.body?.string() ?: ""
                    val data = json.decodeFromString<T>(body)
                    ApiResponse.Success(data)
                } else {
                    ApiResponse.Error(response.code, response.message)
                }
            } catch (e: Exception) {
                ApiResponse.NetworkError(e)
            }
        }
    }
}
```

### 14.3 — Hilt Module

```kotlin
@Module
@InstallIn(SingletonComponent::class)
object ApiModule {

    @Provides
    @Singleton
    fun provideOkHttpClient(): OkHttpClient {
        return OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .addInterceptor { chain ->
                val request = chain.request().newBuilder()
                    .addHeader("Accept", "application/json")
                    .addHeader("User-Agent", "mesh-six-android/${BuildConfig.VERSION_NAME}")
                    .build()
                chain.proceed(request)
            }
            .build()
    }
}
```

### 14.4 — Dapr Service Invocation (Alternative)

When the app is on the LAN/WARP, it could call agents via Dapr service invocation
instead of direct HTTP. This is optional and may be added later:

```kotlin
/**
 * Call an agent via Dapr sidecar service invocation.
 * URL pattern: http://localhost:3500/v1.0/invoke/{appId}/method/{method}
 *
 * NOTE: This only works if the Android device has a Dapr sidecar,
 * which it doesn't. So we use direct HTTP to agent endpoints instead.
 * This method is kept for reference in case we add a proxy.
 */
```

---

## API Routing

Since the Android app does NOT have a Dapr sidecar, it calls agent APIs directly.
The API base URL can point to:

1. **k3s Ingress**: `https://mesh-six.bto.bar` — Caddy routes `/orchestrator/*` → orchestrator pod, `/llm-service/*` → LLM service pod, etc.
2. **Direct ClusterIP**: `http://10.43.x.x:3000` — only works from LAN/WARP
3. **NodePort**: `http://10.0.1.x:30xxx` — direct node access

The recommended setup is option 1 (Caddy ingress) for all paths.

---

## Acceptance Criteria

- [ ] OkHttpClient is configured with proper timeouts and headers
- [ ] `getLlmServiceStatus()` fetches and deserializes LLM Service status
- [ ] `getTasks()` fetches task list from orchestrator
- [ ] `healthCheck()` tests connectivity to any agent
- [ ] Error responses are properly handled (ApiResponse.Error)
- [ ] Network failures return ApiResponse.NetworkError
- [ ] Base URL is read from SettingsRepository (configurable)
- [ ] JSON deserialization uses kotlinx-serialization with `ignoreUnknownKeys`
- [ ] OkHttp client is singleton (shared across all API calls)
- [ ] Unit tests for JSON deserialization of API responses

---

## Notes for Implementer

- The Android app talks to agents via HTTP, NOT through Dapr. Agents are Hono HTTP servers exposing standard REST endpoints.
- The base URL routes through a Caddy/Traefik ingress that fans out to different agents based on path prefix.
- If the ingress isn't set up yet, the implementer of Feature 12 (Settings) should allow per-service URL overrides.
- OkHttp is already a dependency (needed for Paho MQTT WebSocket and ntfy SSE). Reuse the same instance.
- All JSON should use the same `Json` instance configured in Feature 03's RepositoryModule.
- For future features, `submitTask()` allows submitting tasks directly from the Android app. This isn't wired to any UI in v1 but the API method should be ready.
