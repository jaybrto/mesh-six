import { z } from "zod";
import type { ChatMessage } from "./llm-service.js";
import type { EventLog } from "./events.js";

// Re-export ChatMessage for convenience
export type { ChatMessage };

// --- Configuration ---

export const LITELLM_BASE_URL =
  process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
export const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "sk-local";

// --- Types ---

export interface ChatCompletionOpts {
  model: string;
  messages?: ChatMessage[];
  /** Shorthand: sets a system message at the start */
  system?: string;
  /** Shorthand: sets a user message at the end */
  prompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** LiteLLM metadata for tag routing */
  metadata?: Record<string, string>;
}

export interface ChatCompletionResult {
  text: string;
  finishReason: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ChatCompletionWithSchemaOpts<S extends z.ZodTypeAny = z.ZodTypeAny> extends ChatCompletionOpts {
  schema: S;
}

export interface ChatCompletionWithSchemaResult<T> extends ChatCompletionResult {
  object: T;
}

export interface TraceContext {
  eventLog: EventLog;
  traceId: string;
  agentId: string;
  taskId?: string;
  logFullPayload?: boolean;
}

// --- Internal helpers ---

/** Build the messages array from shorthand opts or explicit messages */
function buildMessages(opts: ChatCompletionOpts): ChatMessage[] {
  if (opts.messages && opts.messages.length > 0) {
    const msgs: ChatMessage[] = [];
    if (opts.system) {
      msgs.push({ role: "system", content: opts.system });
    }
    msgs.push(...opts.messages);
    return msgs;
  }

  const msgs: ChatMessage[] = [];
  if (opts.system) {
    msgs.push({ role: "system", content: opts.system });
  }
  if (opts.prompt) {
    msgs.push({ role: "user", content: opts.prompt });
  }
  return msgs;
}

/** Convert a Zod schema to a JSON schema description string for prompt injection */
function zodSchemaToString(schema: z.ZodType<unknown>): string {
  // Use Zod's internal _def to extract shape for objects
  try {
    const def = (schema as z.ZodObject<z.ZodRawShape>)._def;
    if (def && "shape" in def && typeof def.shape === "function") {
      const shape = def.shape();
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(shape)) {
        result[key] = describeZodType(value as z.ZodType<unknown>);
      }
      return JSON.stringify(result, null, 2);
    }
  } catch {
    // fallback
  }
  return "{ /* structured JSON response */ }";
}

function describeZodType(schema: z.ZodType<unknown>): unknown {
  const def = (schema as any)._def;
  if (!def) return "unknown";

  switch (def.typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodArray": {
      const inner = describeZodType(def.type);
      return [inner];
    }
    case "ZodObject": {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(shape)) {
        result[key] = describeZodType(value as z.ZodType<unknown>);
      }
      return result;
    }
    case "ZodEnum":
      return def.values.join(" | ");
    case "ZodOptional":
      return `${describeZodType(def.innerType)} (optional)`;
    case "ZodDefault":
      return describeZodType(def.innerType);
    default:
      return "unknown";
  }
}

// --- Tool helper ---

/**
 * Define a tool with description, Zod parameters, and an execute function.
 * Replaces `tool()` from Vercel AI SDK.
 *
 * Note: Tool calling via the LLM is not supported in this implementation.
 * Tools are used for direct invocation via their `.execute()` method.
 */
export function tool<TParams extends z.ZodType, TResult>(config: {
  description: string;
  parameters: TParams;
  execute: (params: z.infer<TParams>, opts: { toolCallId: string; messages: ChatMessage[] }) => Promise<TResult>;
}): {
  description: string;
  parameters: TParams;
  execute: (params: z.infer<TParams>, opts: { toolCallId: string; messages: ChatMessage[] }) => Promise<TResult>;
} {
  return config;
}

// --- Core functions ---

/**
 * Send a chat completion request to LiteLLM.
 * Replaces `generateText()` from Vercel AI SDK.
 */
export async function chatCompletion(
  opts: ChatCompletionOpts,
): Promise<ChatCompletionResult> {
  const messages = buildMessages(opts);

  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.metadata) body.metadata = opts.metadata;

  const response = await fetch(`${LITELLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LITELLM_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `LiteLLM request failed (${response.status}): ${errorBody}`,
    );
  }

  const json = (await response.json()) as {
    choices: Array<{
      message: { content: string };
      finish_reason: string;
    }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };

  const choice = json.choices?.[0];
  if (!choice) {
    throw new Error("LiteLLM returned no choices");
  }

  return {
    text: choice.message.content,
    finishReason: choice.finish_reason,
    usage: json.usage
      ? {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        }
      : undefined,
  };
}

/**
 * Send a chat completion request with a Zod schema for structured output.
 * Replaces `generateObject()` from Vercel AI SDK.
 *
 * Injects the schema as JSON instructions into the prompt, requests JSON output,
 * then validates the response with Zod.
 */
export async function chatCompletionWithSchema<S extends z.ZodTypeAny>(
  opts: ChatCompletionWithSchemaOpts<S>,
): Promise<ChatCompletionWithSchemaResult<z.infer<S>>> {
  const messages = buildMessages(opts);

  // Inject schema instructions into the last user message
  const schemaStr = zodSchemaToString(opts.schema);
  const schemaInstruction = `\n\nYou MUST respond with valid JSON matching this schema:\n\`\`\`json\n${schemaStr}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`;

  // Find last user message and append schema instructions
  let injected = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "user") {
      messages[i] = { ...msg, content: msg.content + schemaInstruction };
      injected = true;
      break;
    }
  }

  // If no user message, add one with just the schema instructions
  if (!injected) {
    messages.push({
      role: "user",
      content: `Provide a response as JSON.${schemaInstruction}`,
    });
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    response_format: { type: "json_object" },
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.metadata) body.metadata = opts.metadata;

  const response = await fetch(`${LITELLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LITELLM_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `LiteLLM request failed (${response.status}): ${errorBody}`,
    );
  }

  const json = (await response.json()) as {
    choices: Array<{
      message: { content: string };
      finish_reason: string;
    }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };

  const choice = json.choices?.[0];
  if (!choice) {
    throw new Error("LiteLLM returned no choices");
  }

  const text = choice.message.content;

  // Extract JSON from the response (handle markdown code blocks)
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    jsonStr = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(
      `Failed to parse LLM response as JSON: ${err instanceof Error ? err.message : err}\nRaw: ${text.slice(0, 500)}`,
    );
  }

  const object = opts.schema.parse(parsed);

  return {
    object,
    text,
    finishReason: choice.finish_reason,
    usage: json.usage
      ? {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        }
      : undefined,
  };
}

/**
 * Traced version of chatCompletion that emits events to the EventLog.
 * Replaces `tracedGenerateText()` from ai.ts.
 */
export async function tracedChatCompletion(
  opts: ChatCompletionOpts,
  ctx?: TraceContext | null,
): Promise<ChatCompletionResult> {
  if (!ctx?.eventLog) {
    return chatCompletion(opts);
  }

  const startTime = Date.now();

  await ctx.eventLog.emit({
    traceId: ctx.traceId,
    taskId: ctx.taskId,
    agentId: ctx.agentId,
    eventType: "llm.call",
    aggregateId: ctx.taskId ? `task:${ctx.taskId}` : undefined,
    payload: {
      model: opts.model,
      systemPromptLength: opts.system?.length ?? 0,
      promptLength: opts.prompt?.length ?? 0,
      ...(ctx.logFullPayload
        ? { system: opts.system, prompt: opts.prompt }
        : {}),
    },
  });

  const result = await chatCompletion(opts);

  await ctx.eventLog.emit({
    traceId: ctx.traceId,
    taskId: ctx.taskId,
    agentId: ctx.agentId,
    eventType: "llm.response",
    aggregateId: ctx.taskId ? `task:${ctx.taskId}` : undefined,
    payload: {
      durationMs: Date.now() - startTime,
      responseLength: result.text.length,
      finishReason: result.finishReason,
      ...(ctx.logFullPayload ? { response: result.text } : {}),
    },
  });

  return result;
}
