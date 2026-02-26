/**
 * Lightweight Dapr Actor HTTP Protocol Implementation for Hono.
 *
 * Instead of using the @dapr/dapr DaprServer (which brings its own Express server),
 * we implement the Dapr actor HTTP protocol directly in Hono routes.
 *
 * The Dapr sidecar calls these routes to manage actor lifecycle:
 * - GET  /dapr/config                                    → actor type registration
 * - PUT  /actors/{actorType}/{actorId}                   → activate actor
 * - DELETE /actors/{actorType}/{actorId}                 → deactivate actor
 * - PUT  /actors/{actorType}/{actorId}/method/{method}   → invoke actor method
 * - PUT  /actors/{actorType}/{actorId}/method/timer/{n}  → timer callback
 * - PUT  /actors/{actorType}/{actorId}/method/remind/{n} → reminder callback
 */

import { DAPR_HOST, DAPR_HTTP_PORT, AGENT_ID } from "./config.js";

const log = (msg: string) => console.log(`[${AGENT_ID}][actor-rt] ${msg}`);

// ============================================================================
// ACTOR INTERFACE
// ============================================================================

export interface Actor {
  /** Called when the actor is activated (first time it's accessed after idle) */
  onActivate(): Promise<void>;
  /** Called when the actor is deactivated (idle timeout or pod shutdown) */
  onDeactivate(): Promise<void>;
  /** Handle a method invocation. Returns the result as a JSON-serializable value. */
  onInvoke(method: string, payload: unknown): Promise<unknown>;
  /** Handle a timer callback */
  onTimer(timerName: string): Promise<void>;
  /** Handle a reminder callback */
  onReminder(reminderName: string, payload: unknown): Promise<void>;
}

export type ActorFactory = (actorType: string, actorId: string) => Actor;

// ============================================================================
// ACTOR RUNTIME
// ============================================================================

export class ActorRuntime {
  private actors = new Map<string, Actor>();
  private factory: ActorFactory;
  private actorType: string;

  constructor(actorType: string, factory: ActorFactory) {
    this.actorType = actorType;
    this.factory = factory;
  }

  private key(actorType: string, actorId: string): string {
    return `${actorType}:${actorId}`;
  }

  /** Get or create an actor instance */
  private getActor(actorType: string, actorId: string): Actor {
    const k = this.key(actorType, actorId);
    let actor = this.actors.get(k);
    if (!actor) {
      actor = this.factory(actorType, actorId);
      this.actors.set(k, actor);
    }
    return actor;
  }

  /** Activate an actor (called by Dapr sidecar) */
  async activate(actorType: string, actorId: string): Promise<void> {
    log(`Activating ${actorType}/${actorId}`);
    const actor = this.getActor(actorType, actorId);
    await actor.onActivate();
    log(`Activated ${actorType}/${actorId}`);
  }

  /** Deactivate an actor (called by Dapr sidecar) */
  async deactivate(actorType: string, actorId: string): Promise<void> {
    log(`Deactivating ${actorType}/${actorId}`);
    const k = this.key(actorType, actorId);
    const actor = this.actors.get(k);
    if (actor) {
      await actor.onDeactivate();
      this.actors.delete(k);
    }
    log(`Deactivated ${actorType}/${actorId}`);
  }

  /** Invoke a method on an actor (called by Dapr sidecar) */
  async invoke(
    actorType: string,
    actorId: string,
    method: string,
    payload: unknown,
  ): Promise<unknown> {
    const actor = this.getActor(actorType, actorId);
    return actor.onInvoke(method, payload);
  }

  /** Handle a timer callback (called by Dapr sidecar) */
  async timer(
    actorType: string,
    actorId: string,
    timerName: string,
  ): Promise<void> {
    const actor = this.getActor(actorType, actorId);
    await actor.onTimer(timerName);
  }

  /** Handle a reminder callback (called by Dapr sidecar) */
  async reminder(
    actorType: string,
    actorId: string,
    reminderName: string,
    payload: unknown,
  ): Promise<void> {
    const actor = this.getActor(actorType, actorId);
    await actor.onReminder(reminderName, payload);
  }

  /** Get all active actor IDs */
  getActiveActors(): string[] {
    return Array.from(this.actors.keys());
  }

  /** Check if an actor is active */
  isActive(actorType: string, actorId: string): boolean {
    return this.actors.has(this.key(actorType, actorId));
  }
}

// ============================================================================
// DAPR SIDECAR HELPERS
// ============================================================================

const daprUrl = () => `http://${DAPR_HOST}:${DAPR_HTTP_PORT}`;

/**
 * Register a timer with the Dapr sidecar for an actor.
 * The sidecar will call back to PUT /actors/{type}/{id}/method/timer/{name}
 */
export async function registerActorTimer(
  actorType: string,
  actorId: string,
  timerName: string,
  opts: {
    dueTime?: string;
    period: string;
    callback?: string;
    data?: unknown;
  },
): Promise<void> {
  const url = `${daprUrl()}/v1.0/actors/${actorType}/${actorId}/timers/${timerName}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dueTime: opts.dueTime || "0s",
      period: opts.period,
      callback: opts.callback || timerName,
      data: opts.data,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to register timer ${timerName}: ${response.status} ${text}`);
  }

  log(`Registered timer ${timerName} for ${actorType}/${actorId} (period: ${opts.period})`);
}

/**
 * Unregister a timer from the Dapr sidecar.
 */
export async function unregisterActorTimer(
  actorType: string,
  actorId: string,
  timerName: string,
): Promise<void> {
  const url = `${daprUrl()}/v1.0/actors/${actorType}/${actorId}/timers/${timerName}`;
  const response = await fetch(url, { method: "DELETE" });

  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw new Error(`Failed to unregister timer ${timerName}: ${response.status} ${text}`);
  }
}

/**
 * Save actor state to the Dapr state store via the sidecar.
 */
export async function saveActorState(
  actorType: string,
  actorId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const url = `${daprUrl()}/v1.0/actors/${actorType}/${actorId}/state`;
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([
      { operation: "upsert", request: { key, value } },
    ]),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to save actor state: ${response.status} ${text}`);
  }
}

/**
 * Get actor state from the Dapr state store via the sidecar.
 */
export async function getActorState<T = unknown>(
  actorType: string,
  actorId: string,
  key: string,
): Promise<T | null> {
  const url = `${daprUrl()}/v1.0/actors/${actorType}/${actorId}/state/${key}`;
  const response = await fetch(url);

  if (response.status === 204 || response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get actor state: ${response.status} ${text}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Publish an event to Dapr pub/sub via the sidecar.
 */
export async function publishEvent(
  pubsubName: string,
  topic: string,
  data: unknown,
): Promise<void> {
  const url = `${daprUrl()}/v1.0/publish/${pubsubName}/${topic}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to publish event: ${response.status} ${text}`);
  }
}
