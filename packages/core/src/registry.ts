import { DaprClient } from "@dapr/dapr";
import type { AgentRegistration } from "./types.js";

const STATE_STORE = "agent-statestore";
const REGISTRY_PREFIX = "agent:";
const INDEX_KEY = "agent:_index";

export class AgentRegistry {
  constructor(private dapr: DaprClient) {}

  /**
   * Register an agent in the registry
   */
  async register(registration: AgentRegistration): Promise<void> {
    const key = `${REGISTRY_PREFIX}${registration.appId}`;

    // Save agent registration
    await this.dapr.state.save(STATE_STORE, [
      { key, value: registration },
    ]);

    // Update index
    await this.addToIndex(registration.appId);

    console.log(`[Registry] Registered agent: ${registration.appId}`);
  }

  /**
   * Update agent heartbeat and status
   */
  async heartbeat(appId: string): Promise<void> {
    const agent = await this.get(appId);
    if (agent) {
      agent.lastHeartbeat = new Date().toISOString();
      agent.status = "online";
      await this.dapr.state.save(STATE_STORE, [
        { key: `${REGISTRY_PREFIX}${appId}`, value: agent },
      ]);
    }
  }

  /**
   * Get a single agent by app ID
   */
  async get(appId: string): Promise<AgentRegistration | null> {
    const result = await this.dapr.state.get(
      STATE_STORE,
      `${REGISTRY_PREFIX}${appId}`
    );
    return (result as AgentRegistration) || null;
  }

  /**
   * Find agents by capability (filters out offline agents)
   */
  async findByCapability(capability: string): Promise<AgentRegistration[]> {
    const agents = await this.listAll();
    return agents.filter(
      (a) =>
        a.status !== "offline" &&
        a.capabilities.some((c) => c.name === capability)
    );
  }

  /**
   * List all registered agents
   */
  async listAll(): Promise<AgentRegistration[]> {
    const index = await this.getIndex();
    const agents: AgentRegistration[] = [];

    for (const appId of index) {
      const agent = await this.get(appId);
      if (agent) {
        // Check for stale heartbeats (>60s = degraded, >120s = offline)
        const heartbeatAge =
          Date.now() - new Date(agent.lastHeartbeat).getTime();
        if (heartbeatAge > 120_000) {
          agent.status = "offline";
        } else if (heartbeatAge > 60_000) {
          agent.status = "degraded";
        }
        agents.push(agent);
      }
    }

    return agents;
  }

  /**
   * Deregister an agent
   */
  async deregister(appId: string): Promise<void> {
    await this.dapr.state.delete(STATE_STORE, `${REGISTRY_PREFIX}${appId}`);
    await this.removeFromIndex(appId);
    console.log(`[Registry] Deregistered agent: ${appId}`);
  }

  /**
   * Mark an agent as offline (for graceful shutdown)
   */
  async markOffline(appId: string): Promise<void> {
    const agent = await this.get(appId);
    if (agent) {
      agent.status = "offline";
      await this.dapr.state.save(STATE_STORE, [
        { key: `${REGISTRY_PREFIX}${appId}`, value: agent },
      ]);
      console.log(`[Registry] Marked agent offline: ${appId}`);
    }
  }

  // --- Index Management ---

  private async getIndex(): Promise<string[]> {
    const result = await this.dapr.state.get(STATE_STORE, INDEX_KEY);
    return (result as string[]) || [];
  }

  private async addToIndex(appId: string): Promise<void> {
    const index = await this.getIndex();
    if (!index.includes(appId)) {
      index.push(appId);
      await this.dapr.state.save(STATE_STORE, [{ key: INDEX_KEY, value: index }]);
    }
  }

  private async removeFromIndex(appId: string): Promise<void> {
    const index = await this.getIndex();
    const filtered = index.filter((id) => id !== appId);
    await this.dapr.state.save(STATE_STORE, [{ key: INDEX_KEY, value: filtered }]);
  }
}
