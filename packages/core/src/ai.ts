import { generateText } from "ai";
import type { EventLog } from "./events.js";

export interface TraceContext {
  eventLog: EventLog;
  traceId: string;
  agentId: string;
  taskId?: string;
  logFullPayload?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GenerateTextOpts = Record<string, any> & {
  model: unknown;
  system?: unknown;
  prompt?: unknown;
  tools?: Record<string, unknown>;
};

export async function tracedGenerateText(
  opts: GenerateTextOpts,
  ctx?: TraceContext | null
): Promise<Awaited<ReturnType<typeof generateText>>> {
  if (!ctx?.eventLog) {
    return generateText(opts as Parameters<typeof generateText>[0]);
  }

  const startTime = Date.now();

  await ctx.eventLog.emit({
    traceId: ctx.traceId,
    taskId: ctx.taskId,
    agentId: ctx.agentId,
    eventType: "llm.call",
    aggregateId: ctx.taskId ? `task:${ctx.taskId}` : undefined,
    payload: {
      model: String(opts.model),
      systemPromptLength: typeof opts.system === "string" ? opts.system.length : 0,
      promptLength: typeof opts.prompt === "string" ? opts.prompt.length : 0,
      toolCount: opts.tools ? Object.keys(opts.tools).length : 0,
      ...(ctx.logFullPayload ? { system: opts.system, prompt: opts.prompt } : {}),
    },
  });

  const result = await generateText(opts as Parameters<typeof generateText>[0]);

  await ctx.eventLog.emit({
    traceId: ctx.traceId,
    taskId: ctx.taskId,
    agentId: ctx.agentId,
    eventType: "llm.response",
    aggregateId: ctx.taskId ? `task:${ctx.taskId}` : undefined,
    payload: {
      durationMs: Date.now() - startTime,
      responseLength: result.text.length,
      toolCallCount: result.toolCalls?.length ?? 0,
      finishReason: result.finishReason,
      ...(ctx.logFullPayload ? { response: result.text } : {}),
    },
  });

  return result;
}
