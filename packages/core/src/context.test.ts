import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { AgentMemory, MemorySearchResult } from "./memory.js";

// --- Mock chatCompletionWithSchema at module level before importing context ---
let chatCompletionWithSchemaImpl: (...args: any[]) => any = () =>
  Promise.resolve({ object: { memories: [] }, text: "", finishReason: "stop" });

mock.module("./llm.js", () => ({
  chatCompletionWithSchema: (...args: any[]) =>
    chatCompletionWithSchemaImpl(...args),
}));

// Import after mocking
const { buildAgentContext, transitionClose, REFLECTION_PROMPT } = await import(
  "./context.js"
);
type ContextConfig = import("./context.js").ContextConfig;
type TransitionCloseConfig = import("./context.js").TransitionCloseConfig;

// --- Mock factories ---

function createMockMemory(
  searchResults: MemorySearchResult[] = [],
  storeFn?: (...args: any[]) => Promise<void>
): AgentMemory {
  return {
    search: mock(() => Promise.resolve(searchResults)),
    store: storeFn ?? mock(() => Promise.resolve()),
  } as any;
}

function makeTaskRequest(
  payload: Record<string, unknown> = { action: "review" }
) {
  return {
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    capability: "code-review",
    payload,
    priority: 5,
    timeout: 120,
    requestedBy: "orchestrator",
    createdAt: new Date().toISOString(),
  };
}

describe("buildAgentContext", () => {
  it("assembles system prompt, task payload, memory block, and state block", async () => {
    const memories: MemorySearchResult[] = [
      { id: "m1", memory: "User prefers TypeScript", score: 0.9 },
      { id: "m2", memory: "Project uses Bun runtime", score: 0.8 },
    ];
    const mem = createMockMemory(memories);

    const config: ContextConfig = {
      agentId: "agent-1",
      systemPrompt: "You are a code reviewer.",
      task: makeTaskRequest({ file: "index.ts" }),
      memoryQuery: "code review context",
      additionalContext: "PR #42 is open",
    };

    const ctx = await buildAgentContext(config, mem);

    expect(ctx.system).toBe("You are a code reviewer.");
    expect(ctx.prompt).toContain('"file":"index.ts"');
    expect(ctx.prompt).toContain("- User prefers TypeScript");
    expect(ctx.prompt).toContain("- Project uses Bun runtime");
    expect(ctx.prompt).toContain("Relevant context from past interactions:");
    expect(ctx.prompt).toContain("Current state:");
    expect(ctx.prompt).toContain("PR #42 is open");
  });

  it("does not include memory block when memoryQuery is undefined", async () => {
    const searchMock = mock(() => Promise.resolve([]));
    const mem = {
      search: searchMock,
      store: mock(() => Promise.resolve()),
    } as any;

    const config: ContextConfig = {
      agentId: "agent-1",
      systemPrompt: "system",
      task: makeTaskRequest(),
    };

    const ctx = await buildAgentContext(config, mem);

    expect(searchMock).not.toHaveBeenCalled();
    expect(ctx.prompt).not.toContain("Relevant context");
  });

  it("truncates memories to respect maxMemoryTokens budget", async () => {
    const longMemory = "x".repeat(3000);
    const memories: MemorySearchResult[] = [
      { id: "m1", memory: longMemory, score: 0.9 },
      { id: "m2", memory: longMemory, score: 0.8 },
      { id: "m3", memory: longMemory, score: 0.7 },
    ];
    const mem = createMockMemory(memories);

    const config: ContextConfig = {
      agentId: "agent-1",
      systemPrompt: "sys",
      task: makeTaskRequest(),
      memoryQuery: "test",
      maxMemoryTokens: 1500,
    };

    const ctx = await buildAgentContext(config, mem);

    // 3 memories at 3000 chars each = 9000+ chars, budget is 6000 chars
    const memoryLines = ctx.prompt
      .split("\n")
      .filter((l: string) => l.startsWith("- "));
    expect(memoryLines.length).toBeLessThanOrEqual(2);
  });

  it("does not truncate if a single memory exceeds budget", async () => {
    const bigMemory = "y".repeat(8000);
    const memories: MemorySearchResult[] = [
      { id: "m1", memory: bigMemory, score: 0.9 },
    ];
    const mem = createMockMemory(memories);

    const config: ContextConfig = {
      agentId: "agent-1",
      systemPrompt: "sys",
      task: makeTaskRequest(),
      memoryQuery: "test",
      maxMemoryTokens: 1500,
    };

    const ctx = await buildAgentContext(config, mem);

    // With only 1 memory, the while loop condition (memories.length > 1) stops
    expect(ctx.prompt).toContain(bigMemory);
  });

  it("estimates tokens as total chars / 4", async () => {
    const mem = createMockMemory();
    const systemPrompt = "a".repeat(100);
    const payload = { key: "b".repeat(50) };

    const config: ContextConfig = {
      agentId: "agent-1",
      systemPrompt,
      task: makeTaskRequest(payload),
    };

    const ctx = await buildAgentContext(config, mem);

    const payloadJson = JSON.stringify(payload);
    const expectedTokens = Math.ceil(
      (systemPrompt.length + payloadJson.length) / 4
    );
    expect(ctx.estimatedTokens).toBe(expectedTokens);
  });

  it("does not include state block when additionalContext is undefined", async () => {
    const mem = createMockMemory();

    const config: ContextConfig = {
      agentId: "agent-1",
      systemPrompt: "sys",
      task: makeTaskRequest(),
    };

    const ctx = await buildAgentContext(config, mem);
    expect(ctx.prompt).not.toContain("Current state:");
  });
});

describe("transitionClose", () => {
  beforeEach(() => {
    chatCompletionWithSchemaImpl = () =>
      Promise.resolve({ object: { memories: [] }, text: "", finishReason: "stop" });
  });

  it("generates reflection via LLM and stores memories with correct scope", async () => {
    const storeMock = mock((_messages: any[], _userId: string) => Promise.resolve());
    const mem = createMockMemory([], storeMock);

    chatCompletionWithSchemaImpl = mock(() =>
      Promise.resolve({
        object: {
          memories: [
            { content: "Agent handled edge case well", scope: "agent" },
            { content: "Task required special permissions", scope: "task" },
          ],
        },
        text: "{}",
        finishReason: "stop",
      })
    );

    const config: TransitionCloseConfig = {
      agentId: "agent-1",
      taskId: "task-123",
      projectId: "proj-1",
      transitionFrom: "reviewing",
      transitionTo: "completed",
      conversationHistory: [
        { role: "user", content: "Please review the code" },
        { role: "assistant", content: "I'll review it now" },
        { role: "user", content: "Any issues?" },
        { role: "assistant", content: "Found 2 issues" },
      ],
      taskState: { issuesFound: 2 },
    };

    await transitionClose(config, mem, "claude-sonnet");

    expect(chatCompletionWithSchemaImpl).toHaveBeenCalledTimes(1);
    expect(storeMock).toHaveBeenCalledTimes(2);

    // First memory: scope "agent" -> userId = "agent-1"
    const firstCall = storeMock.mock.calls[0]!;
    expect(firstCall[0][0].content).toContain("Agent handled edge case well");
    expect(firstCall[1]).toBe("agent-1");

    // Second memory: scope "task" -> userId = "task-task-123"
    const secondCall = storeMock.mock.calls[1]!;
    expect(secondCall[0][0].content).toContain(
      "Task required special permissions"
    );
    expect(secondCall[1]).toBe("task-task-123");
  });

  it("stores nothing when output has empty memories array", async () => {
    const storeMock = mock((_messages: any[], _userId: string) => Promise.resolve());
    const mem = createMockMemory([], storeMock);

    chatCompletionWithSchemaImpl = () =>
      Promise.resolve({ object: { memories: [] }, text: "", finishReason: "stop" });

    const config: TransitionCloseConfig = {
      agentId: "agent-1",
      taskId: "task-123",
      transitionFrom: "reviewing",
      transitionTo: "completed",
      conversationHistory: [{ role: "user", content: "test" }],
      taskState: {},
    };

    await transitionClose(config, mem, "claude-sonnet");
    expect(storeMock).not.toHaveBeenCalled();
  });

  it("stores nothing when output is null/undefined", async () => {
    const storeMock = mock((_messages: any[], _userId: string) => Promise.resolve());
    const mem = createMockMemory([], storeMock);

    chatCompletionWithSchemaImpl = () =>
      Promise.resolve({ object: null, text: "", finishReason: "stop" });

    const config: TransitionCloseConfig = {
      agentId: "agent-1",
      taskId: "task-123",
      transitionFrom: "reviewing",
      transitionTo: "completed",
      conversationHistory: [{ role: "user", content: "test" }],
      taskState: {},
    };

    await transitionClose(config, mem, "claude-sonnet");
    expect(storeMock).not.toHaveBeenCalled();
  });

  it("only passes last 6 conversation history messages to LLM", async () => {
    const storeMock = mock((_messages: any[], _userId: string) => Promise.resolve());
    const mem = createMockMemory([], storeMock);

    let capturedOpts: any = {};
    chatCompletionWithSchemaImpl = mock((opts: any) => {
      capturedOpts = opts;
      return Promise.resolve({ object: { memories: [] }, text: "", finishReason: "stop" });
    });

    const history = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    }));

    const config: TransitionCloseConfig = {
      agentId: "agent-1",
      taskId: "task-123",
      transitionFrom: "reviewing",
      transitionTo: "completed",
      conversationHistory: history,
      taskState: {},
    };

    await transitionClose(config, mem, "claude-sonnet");

    // Messages: last 6 from history + 1 reflection prompt = 7
    expect(capturedOpts.messages).toHaveLength(7);
    // First should be message 4 (10 - 6 = index 4)
    expect(capturedOpts.messages[0].content).toBe("message 4");
    // Last should be the reflection prompt
    expect(capturedOpts.messages[6].content).toBe(REFLECTION_PROMPT);
  });

  it("resolveMemoryUserId: project scope uses project-{id}", async () => {
    const storeMock = mock((_messages: any[], _userId: string) => Promise.resolve());
    const mem = createMockMemory([], storeMock);

    chatCompletionWithSchemaImpl = () =>
      Promise.resolve({
        object: {
          memories: [{ content: "project insight", scope: "project" }],
        },
        text: "{}",
        finishReason: "stop",
      });

    const config: TransitionCloseConfig = {
      agentId: "agent-1",
      taskId: "task-123",
      projectId: "proj-42",
      transitionFrom: "a",
      transitionTo: "b",
      conversationHistory: [{ role: "user", content: "test" }],
      taskState: {},
    };

    await transitionClose(config, mem, "claude-sonnet");

    expect(storeMock).toHaveBeenCalledTimes(1);
    expect(storeMock.mock.calls[0]![1]).toBe("project-proj-42");
  });

  it("resolveMemoryUserId: project scope falls back to agentId when no projectId", async () => {
    const storeMock = mock((_messages: any[], _userId: string) => Promise.resolve());
    const mem = createMockMemory([], storeMock);

    chatCompletionWithSchemaImpl = () =>
      Promise.resolve({
        object: {
          memories: [{ content: "project insight", scope: "project" }],
        },
        text: "{}",
        finishReason: "stop",
      });

    const config: TransitionCloseConfig = {
      agentId: "agent-1",
      taskId: "task-123",
      transitionFrom: "a",
      transitionTo: "b",
      conversationHistory: [{ role: "user", content: "test" }],
      taskState: {},
    };

    await transitionClose(config, mem, "claude-sonnet");

    expect(storeMock).toHaveBeenCalledTimes(1);
    expect(storeMock.mock.calls[0]![1]).toBe("agent-1");
  });

  it("resolveMemoryUserId: global scope uses mesh-six-learning", async () => {
    const storeMock = mock((_messages: any[], _userId: string) => Promise.resolve());
    const mem = createMockMemory([], storeMock);

    chatCompletionWithSchemaImpl = () =>
      Promise.resolve({
        object: {
          memories: [{ content: "global learning", scope: "global" }],
        },
        text: "{}",
        finishReason: "stop",
      });

    const config: TransitionCloseConfig = {
      agentId: "agent-1",
      taskId: "task-123",
      transitionFrom: "a",
      transitionTo: "b",
      conversationHistory: [{ role: "user", content: "test" }],
      taskState: {},
    };

    await transitionClose(config, mem, "claude-sonnet");

    expect(storeMock.mock.calls[0]![1]).toBe("mesh-six-learning");
  });

  it("formats stored memory content with transition arrow prefix", async () => {
    const storeMock = mock((_messages: any[], _userId: string) => Promise.resolve());
    const mem = createMockMemory([], storeMock);

    chatCompletionWithSchemaImpl = () =>
      Promise.resolve({
        object: {
          memories: [{ content: "some insight", scope: "agent" }],
        },
        text: "{}",
        finishReason: "stop",
      });

    const config: TransitionCloseConfig = {
      agentId: "agent-1",
      taskId: "task-123",
      transitionFrom: "reviewing",
      transitionTo: "completed",
      conversationHistory: [{ role: "user", content: "test" }],
      taskState: {},
    };

    await transitionClose(config, mem, "claude-sonnet");

    const storedMessages = storeMock.mock.calls[0]![0];
    expect(storedMessages[0].role).toBe("system");
    expect(storedMessages[0].content).toContain("[reviewing\u2192completed]");
    expect(storedMessages[0].content).toContain("some insight");
  });
});
