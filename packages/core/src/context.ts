import { z } from "zod";
import type { TaskRequest } from "./types.js";
import type { AgentMemory, MemorySearchResult } from "./memory.js";
import { chatCompletionWithSchema } from "./llm.js";

// --- Interfaces ---

export interface ContextConfig {
  agentId: string;
  systemPrompt: string;
  task: TaskRequest;
  memoryQuery?: string;
  maxMemoryTokens?: number;
  maxToolResultTokens?: number;
  additionalContext?: string;
}

export interface AgentContext {
  system: string;
  prompt: string;
  estimatedTokens: number;
}

export type MemoryScope = "task" | "agent" | "project" | "global";

export interface TransitionCloseConfig {
  agentId: string;
  taskId: string;
  projectId?: string;
  transitionFrom: string;
  transitionTo: string;
  conversationHistory: Array<{ role: string; content: string }>;
  taskState: Record<string, unknown>;
}

// --- Constants ---

export const REFLECTION_PROMPT = `
Before this transition completes, reflect on what happened:

1. OUTCOME: What happened and why?
2. PATTERN: Is this similar to something that's happened before?
3. GUIDANCE: What should the next state know that isn't in the structured task data?
4. REUSABLE: Is there anything here that applies beyond this specific task?

Only store memories that have future value. Not everything is worth remembering.
Respond with JSON: { "memories": [{ "content": "...", "scope": "task" | "agent" | "project" | "global" }] }
If nothing is worth remembering, respond with: { "memories": [] }
`;

// --- Functions ---

/**
 * Build the full agent context by combining system prompt, task payload,
 * relevant memories, and additional state into a single prompt structure.
 */
export async function buildAgentContext(
  config: ContextConfig,
  memory: AgentMemory
): Promise<AgentContext> {
  const maxMemTokens = config.maxMemoryTokens ?? 1500;

  // Retrieve scoped memories via memory.search()
  let memories: MemorySearchResult[] = [];
  if (config.memoryQuery) {
    memories = await memory.search(config.memoryQuery, config.agentId);
    // Rough token estimation: 1 token ~ 4 chars
    let totalChars = memories.map((m) => m.memory).join("\n").length;
    while (totalChars > maxMemTokens * 4 && memories.length > 1) {
      memories.pop(); // Drop lowest-relevance (last) result
      totalChars = memories.map((m) => m.memory).join("\n").length;
    }
  }

  const memoryBlock =
    memories.length > 0
      ? `\n\nRelevant context from past interactions:\n${memories.map((m) => `- ${m.memory}`).join("\n")}`
      : "";

  const stateBlock = config.additionalContext
    ? `\n\nCurrent state:\n${config.additionalContext}`
    : "";

  const payloadJson = JSON.stringify(config.task.payload);

  return {
    system: config.systemPrompt,
    prompt: `${payloadJson}${memoryBlock}${stateBlock}`,
    estimatedTokens: Math.ceil(
      (config.systemPrompt.length +
        memoryBlock.length +
        stateBlock.length +
        payloadJson.length) /
        4
    ),
  };
}

/**
 * Run a reflection LLM call at the end of a state transition,
 * then store any worthwhile memories with appropriate scoping.
 */
export async function transitionClose(
  config: TransitionCloseConfig,
  memory: AgentMemory,
  model: string
): Promise<void> {
  const recentHistory = config.conversationHistory.slice(-6).map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));

  const reflectionSchema = z.object({
    memories: z.array(
      z.object({
        content: z.string(),
        scope: z.enum(["task", "agent", "project", "global"]),
      })
    ),
  });

  const result = await chatCompletionWithSchema({
    model,
    schema: reflectionSchema,
    system: `You are reflecting on a state transition in a project management workflow.
             Transition: ${config.transitionFrom} \u2192 ${config.transitionTo}
             Task ID: ${config.taskId}`,
    messages: [
      ...recentHistory,
      { role: "user" as const, content: REFLECTION_PROMPT },
    ],
  });

  const output = result.object;
  if (!output || output.memories.length === 0) return;

  // Store each reflection with appropriate scoping
  for (const mem of output.memories) {
    const userId = resolveMemoryUserId(mem.scope, config);
    await memory.store(
      [
        {
          role: "system",
          content: `[${config.transitionFrom}\u2192${config.transitionTo}] ${mem.content}`,
        },
      ],
      userId
    );
  }
}

// --- Helpers ---

/**
 * Map a memory scope to the userId used for storage/retrieval.
 *
 * | Scope     | Stored As (userId)    | Retrieved By                        |
 * |-----------|-----------------------|-------------------------------------|
 * | task      | task-{taskId}         | Same task's future transitions      |
 * | agent     | {agentId}             | Same agent type across all tasks    |
 * | project   | project-{projectId}   | All agents working on this project  |
 * | global    | mesh-six-learning     | Any agent (cross-pollination)       |
 */
function resolveMemoryUserId(
  scope: MemoryScope,
  config: TransitionCloseConfig
): string {
  switch (scope) {
    case "task":
      return `task-${config.taskId}`;
    case "agent":
      return config.agentId;
    case "project":
      return config.projectId
        ? `project-${config.projectId}`
        : config.agentId;
    case "global":
      return "mesh-six-learning";
  }
}
