import { describe, it, expect } from "bun:test";
import { ArchitectActor } from "./actor.js";

describe("ArchitectActor", () => {
  it("constructs with actorType and actorId", () => {
    const actor = new ArchitectActor("ArchitectActor", "jaybrto/mesh-six/42");
    expect(actor).toBeDefined();
  });

  it("onInvoke routes to correct methods", async () => {
    const actor = new ArchitectActor("ArchitectActor", "jaybrto/mesh-six/42");
    const history = await actor.onInvoke("getHistory", {});
    expect(history).toEqual({ events: [] });
  });

  it("rejects unknown methods", async () => {
    const actor = new ArchitectActor("ArchitectActor", "jaybrto/mesh-six/42");
    await expect(actor.onInvoke("unknownMethod", {})).rejects.toThrow("Unknown method");
  });
});
