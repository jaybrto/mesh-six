import { describe, it, expect, mock, beforeEach } from "bun:test";
import { AgentRegistry } from "./registry.js";
import type { AgentRegistration } from "./types.js";

const STATE_STORE = "agent-statestore";
const REGISTRY_PREFIX = "agent:";
const INDEX_KEY = "agent:_index";

function createMockDapr(stateStore: Record<string, any> = {}) {
  const store = { ...stateStore };

  const saveMock = mock((_storeName: string, items: Array<{ key: string; value: any }>) => {
    for (const item of items) {
      store[item.key] = item.value;
    }
    return Promise.resolve();
  });

  const getMock = mock((_storeName: string, key: string) => {
    return Promise.resolve(store[key] ?? "");
  });

  const deleteMock = mock((_storeName: string, key: string) => {
    delete store[key];
    return Promise.resolve();
  });

  return {
    dapr: {
      state: { save: saveMock, get: getMock, delete: deleteMock },
    } as any,
    store,
    saveMock,
    getMock,
    deleteMock,
  };
}

function makeRegistration(
  appId: string,
  status: "online" | "degraded" | "offline" = "online",
  capabilities: AgentRegistration["capabilities"] = [],
  lastHeartbeat?: string
): AgentRegistration {
  return {
    name: appId,
    appId,
    capabilities,
    status,
    healthChecks: {},
    lastHeartbeat: lastHeartbeat ?? new Date().toISOString(),
  };
}

describe("AgentRegistry", () => {
  describe("register", () => {
    it("saves to Dapr state store and updates index", async () => {
      const { dapr, saveMock, getMock } = createMockDapr();
      const registry = new AgentRegistry(dapr);
      const reg = makeRegistration("agent-1");

      await registry.register(reg);

      // First call saves the agent, second call saves the index
      expect(saveMock).toHaveBeenCalled();
      // Verify the agent key was used
      const firstCallArgs = saveMock.mock.calls[0];
      expect(firstCallArgs[0]).toBe(STATE_STORE);
      expect(firstCallArgs[1][0].key).toBe(`${REGISTRY_PREFIX}agent-1`);
      expect(firstCallArgs[1][0].value).toEqual(reg);
    });

    it("does not duplicate index entries on re-register", async () => {
      const { dapr, store } = createMockDapr();
      const registry = new AgentRegistry(dapr);
      const reg = makeRegistration("agent-1");

      await registry.register(reg);
      await registry.register(reg);

      const index = store[INDEX_KEY] as string[];
      const count = index.filter((id: string) => id === "agent-1").length;
      expect(count).toBe(1);
    });
  });

  describe("get", () => {
    it("returns agent when found", async () => {
      const reg = makeRegistration("agent-1");
      const { dapr } = createMockDapr({
        [`${REGISTRY_PREFIX}agent-1`]: reg,
      });
      const registry = new AgentRegistry(dapr);

      const result = await registry.get("agent-1");
      expect(result).toEqual(reg);
    });

    it("returns null for unknown agent", async () => {
      const { dapr } = createMockDapr();
      const registry = new AgentRegistry(dapr);

      const result = await registry.get("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("heartbeat", () => {
    it("updates lastHeartbeat and status to online", async () => {
      const reg = makeRegistration("agent-1", "degraded");
      const { dapr, saveMock } = createMockDapr({
        [`${REGISTRY_PREFIX}agent-1`]: reg,
      });
      const registry = new AgentRegistry(dapr);

      const before = Date.now();
      await registry.heartbeat("agent-1");

      // Should have saved the updated agent
      const saveCall = saveMock.mock.calls[0];
      const savedAgent = saveCall[1][0].value as AgentRegistration;
      expect(savedAgent.status).toBe("online");
      const hbTime = new Date(savedAgent.lastHeartbeat).getTime();
      expect(hbTime).toBeGreaterThanOrEqual(before);
    });

    it("does nothing for unknown agent", async () => {
      const { dapr, saveMock } = createMockDapr();
      const registry = new AgentRegistry(dapr);

      await registry.heartbeat("nonexistent");
      expect(saveMock).not.toHaveBeenCalled();
    });
  });

  describe("deregister", () => {
    it("removes from state and index", async () => {
      const reg = makeRegistration("agent-1");
      const { dapr, deleteMock, store } = createMockDapr({
        [`${REGISTRY_PREFIX}agent-1`]: reg,
        [INDEX_KEY]: ["agent-1", "agent-2"],
      });
      const registry = new AgentRegistry(dapr);

      await registry.deregister("agent-1");

      expect(deleteMock).toHaveBeenCalledWith(STATE_STORE, `${REGISTRY_PREFIX}agent-1`);
      // Index should no longer contain agent-1
      const updatedIndex = store[INDEX_KEY] as string[];
      expect(updatedIndex).not.toContain("agent-1");
      expect(updatedIndex).toContain("agent-2");
    });
  });

  describe("findByCapability", () => {
    it("filters out offline agents and matches capability", async () => {
      const agent1 = makeRegistration("a1", "online", [
        { name: "code-review", weight: 0.8, preferred: false, requirements: [] },
      ]);
      const agent2 = makeRegistration("a2", "offline", [
        { name: "code-review", weight: 0.5, preferred: false, requirements: [] },
      ]);
      const agent3 = makeRegistration("a3", "online", [
        { name: "deploy", weight: 0.9, preferred: false, requirements: [] },
      ]);
      const { dapr } = createMockDapr({
        [INDEX_KEY]: ["a1", "a2", "a3"],
        [`${REGISTRY_PREFIX}a1`]: agent1,
        [`${REGISTRY_PREFIX}a2`]: agent2,
        [`${REGISTRY_PREFIX}a3`]: agent3,
      });
      const registry = new AgentRegistry(dapr);

      const result = await registry.findByCapability("code-review");
      expect(result).toHaveLength(1);
      expect(result[0].appId).toBe("a1");
    });

    it("returns empty for unmatched capability", async () => {
      const agent = makeRegistration("a1", "online", [
        { name: "deploy", weight: 0.9, preferred: false, requirements: [] },
      ]);
      const { dapr } = createMockDapr({
        [INDEX_KEY]: ["a1"],
        [`${REGISTRY_PREFIX}a1`]: agent,
      });
      const registry = new AgentRegistry(dapr);

      const result = await registry.findByCapability("code-review");
      expect(result).toHaveLength(0);
    });
  });

  describe("listAll", () => {
    it("transitions stale heartbeat >60s to degraded", async () => {
      const staleTime = new Date(Date.now() - 80_000).toISOString();
      const agent = makeRegistration("a1", "online", [], staleTime);
      const { dapr } = createMockDapr({
        [INDEX_KEY]: ["a1"],
        [`${REGISTRY_PREFIX}a1`]: agent,
      });
      const registry = new AgentRegistry(dapr);

      const result = await registry.listAll();
      expect(result[0].status).toBe("degraded");
    });

    it("transitions stale heartbeat >120s to offline", async () => {
      const veryStaleTime = new Date(Date.now() - 150_000).toISOString();
      const agent = makeRegistration("a1", "online", [], veryStaleTime);
      const { dapr } = createMockDapr({
        [INDEX_KEY]: ["a1"],
        [`${REGISTRY_PREFIX}a1`]: agent,
      });
      const registry = new AgentRegistry(dapr);

      const result = await registry.listAll();
      expect(result[0].status).toBe("offline");
    });

    it("keeps fresh heartbeat as-is", async () => {
      const freshTime = new Date().toISOString();
      const agent = makeRegistration("a1", "online", [], freshTime);
      const { dapr } = createMockDapr({
        [INDEX_KEY]: ["a1"],
        [`${REGISTRY_PREFIX}a1`]: agent,
      });
      const registry = new AgentRegistry(dapr);

      const result = await registry.listAll();
      expect(result[0].status).toBe("online");
    });

    it("skips agents that no longer exist in state", async () => {
      const { dapr } = createMockDapr({
        [INDEX_KEY]: ["a1", "a2"],
        [`${REGISTRY_PREFIX}a1`]: makeRegistration("a1"),
        // a2 is in the index but not in state
      });
      const registry = new AgentRegistry(dapr);

      const result = await registry.listAll();
      expect(result).toHaveLength(1);
      expect(result[0].appId).toBe("a1");
    });
  });

  describe("markOffline", () => {
    it("sets status to offline", async () => {
      const agent = makeRegistration("a1", "online");
      const { dapr, saveMock } = createMockDapr({
        [`${REGISTRY_PREFIX}a1`]: agent,
      });
      const registry = new AgentRegistry(dapr);

      await registry.markOffline("a1");

      const saveCall = saveMock.mock.calls[0];
      const saved = saveCall[1][0].value as AgentRegistration;
      expect(saved.status).toBe("offline");
    });

    it("does nothing for unknown agent", async () => {
      const { dapr, saveMock } = createMockDapr();
      const registry = new AgentRegistry(dapr);

      await registry.markOffline("nonexistent");
      expect(saveMock).not.toHaveBeenCalled();
    });
  });
});
