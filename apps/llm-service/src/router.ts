import type { ActorInfo, ActorStatus, ChatCompletionRequest } from "@mesh-six/core";
import { LLM_ACTOR_TYPE } from "@mesh-six/core";
import type { ActorRuntime } from "./actor-runtime.js";
import { DAPR_HOST, DAPR_HTTP_PORT, MAX_ACTORS, AGENT_ID } from "./config.js";

const log = (msg: string) => console.log(`[${AGENT_ID}][router] ${msg}`);

// ============================================================================
// ACTOR ROUTER
// ============================================================================

/**
 * Routes incoming chat completion requests to the best available actor.
 *
 * Selection strategy:
 * 1. If a session_id is provided, route to the actor that owns that session
 * 2. If a capability is requested, route to an actor with that capability
 * 3. Otherwise, pick the least-recently-used idle actor
 * 4. If all actors are busy, return 429
 */
export class ActorRouter {
  private runtime: ActorRuntime;

  // Local status cache — updated via actor state changes
  private actorStatus = new Map<string, ActorInfo>();

  // Session → actor mapping for session affinity
  private sessionAffinity = new Map<string, string>();

  constructor(runtime: ActorRuntime) {
    this.runtime = runtime;
  }

  /**
   * Select the best actor for a request and invoke it.
   * Returns the actor's response or a 429/503 error.
   */
  async route(
    request: ChatCompletionRequest,
  ): Promise<{ status: number; body: unknown }> {
    // Session affinity: route to the same actor if resuming a session
    if (request.session_id) {
      const affinityActorId = this.sessionAffinity.get(request.session_id);
      if (affinityActorId) {
        const info = this.actorStatus.get(affinityActorId);
        if (info && info.status !== "unhealthy") {
          return this.invokeActor(affinityActorId, request);
        }
      }
    }

    // Capability-aware routing
    const candidates = this.getCandidates(request.capability);

    if (candidates.length === 0) {
      return {
        status: 503,
        body: {
          error: {
            message: "No healthy actors available",
            type: "service_unavailable",
          },
        },
      };
    }

    // Find idle actors first
    const idleActors = candidates.filter((a) => a.status === "idle");

    if (idleActors.length === 0) {
      // All actors busy — return 429 with Retry-After
      return {
        status: 429,
        body: {
          error: {
            message: "All actors are busy. Please retry.",
            type: "rate_limit_exceeded",
          },
        },
      };
    }

    // Pick least-recently-used idle actor
    idleActors.sort((a, b) => {
      const aTime = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
      const bTime = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
      return aTime - bTime;
    });

    const selected = idleActors[0];
    log(`Routing to ${selected.actorId} (${candidates.length} candidates, ${idleActors.length} idle)`);

    const result = await this.invokeActor(selected.actorId, request);

    // Track session affinity if a session was created
    if (request.persist_session || request.session_id) {
      const body = result.body as Record<string, unknown>;
      const sessionId = (body?.session_id as string) || request.session_id;
      if (sessionId) {
        this.sessionAffinity.set(sessionId, selected.actorId);
      }
    }

    return result;
  }

  /**
   * Invoke an actor via the Dapr sidecar's actor invocation API.
   */
  private async invokeActor(
    actorId: string,
    request: ChatCompletionRequest,
  ): Promise<{ status: number; body: unknown }> {
    // Mark actor as busy locally before the call
    const info = this.actorStatus.get(actorId);
    if (info) {
      info.status = "busy";
    }

    try {
      const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/actors/${LLM_ACTOR_TYPE}/${actorId}/method/complete`;

      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      const body = await response.json();

      // Update local status cache
      await this.refreshActorStatus(actorId);

      return { status: response.ok ? 200 : 502, body };
    } catch (err) {
      // Update local status cache
      if (info) {
        info.status = "idle";
      }

      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 502,
        body: {
          error: {
            message: `Actor invocation failed: ${message}`,
            type: "upstream_error",
          },
        },
      };
    }
  }

  /**
   * Get candidate actors filtered by capability (if specified).
   */
  private getCandidates(capability?: string): ActorInfo[] {
    const all = Array.from(this.actorStatus.values()).filter(
      (a) => a.status !== "unhealthy" && a.status !== "initializing",
    );

    if (!capability) {
      return all;
    }

    // Filter by capability
    const withCapability = all.filter((a) =>
      a.capabilities.includes(capability),
    );

    // Fall back to all healthy actors if no capability match
    return withCapability.length > 0 ? withCapability : all;
  }

  /**
   * Refresh a single actor's status from the Dapr sidecar.
   */
  async refreshActorStatus(actorId: string): Promise<void> {
    try {
      const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/actors/${LLM_ACTOR_TYPE}/${actorId}/method/getInfo`;
      const response = await fetch(url, { method: "PUT" });

      if (response.ok) {
        const info = (await response.json()) as ActorInfo;
        this.actorStatus.set(actorId, info);
      }
    } catch {
      // Actor may not be active yet
    }
  }

  /**
   * Refresh all actor statuses. Called periodically and on startup.
   */
  async refreshAllStatuses(): Promise<void> {
    for (let i = 0; i < MAX_ACTORS; i++) {
      const actorId = `cli-${i}`;
      await this.refreshActorStatus(actorId);
    }
  }

  /**
   * Update an actor's status directly (used by config change handlers).
   */
  updateActorStatus(actorId: string, info: ActorInfo): void {
    this.actorStatus.set(actorId, info);
  }

  /**
   * Get the current status of all actors.
   */
  getAllStatuses(): ActorInfo[] {
    return Array.from(this.actorStatus.values());
  }

  /**
   * Get a summary of the router state.
   */
  getSummary(): {
    total: number;
    idle: number;
    busy: number;
    unhealthy: number;
  } {
    const all = Array.from(this.actorStatus.values());
    return {
      total: all.length,
      idle: all.filter((a) => a.status === "idle").length,
      busy: all.filter((a) => a.status === "busy").length,
      unhealthy: all.filter((a) => a.status === "unhealthy").length,
    };
  }
}
