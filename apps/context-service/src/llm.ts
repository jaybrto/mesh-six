import { chatCompletion } from "@mesh-six/core";
import type { CompressionRequest } from "@mesh-six/core";

const COMPRESSION_MODEL = process.env.LITELLM_COMPRESSION_MODEL || "ollama-phi3.5";
const COMPRESSION_TEMPERATURE = 0.1;
const COMPRESSION_MAX_TOKENS = 500;

/**
 * System prompt for Phi3.5 context compression.
 * Validated during prototyping session -- v3.2 format with anti-hallucination rules.
 */
const COMPRESSION_SYSTEM_PROMPT = `You are a context compression service for a multi-agent system. Compress sender context for the receiving agent.

OUTPUT FORMAT (use exactly this structure):

METADATA:
  sender: ...
  receiver: ...
  project: ...
  task: <one line>
  priority: ...

DOMAIN_CONTEXT:
- <key technical facts the receiver needs to do their job - max 12 words each>

CONSTRAINTS:
- <hard constraint - max 8 words>

KNOWN_FAILURES:
- <what failed and why - max 12 words>

OPEN_QUESTIONS:
1. <question from sender - preserve original wording>

RULES:
- CONCISE. Hard word limits per bullet. No prose paragraphs.
- ONLY extract from input. NEVER invent names, tools, libraries, or facts not explicitly stated.
- STRIP: internal IDs, timestamps, relevance scores, conversation history, sender reasoning, system prompts, workflow tracking fields.
- PRESERVE exactly: library names, version numbers, state names, error descriptions.
- Target: under 300 tokens total.`;

/**
 * Compress context using Phi3.5 via LiteLLM.
 * Takes the full CompressionRequest and produces compressed text.
 */
export async function compressWithLLM(
  request: CompressionRequest,
  /** Pre-formatted rule engine output to compress further, or raw request if rules didn't run */
  preformatted?: string
): Promise<{ text: string; durationMs: number }> {
  const startTime = Date.now();

  const userMessage = preformatted ?? formatRequestForLLM(request);

  const { text } = await chatCompletion({
    model: COMPRESSION_MODEL,
    system: COMPRESSION_SYSTEM_PROMPT,
    prompt: userMessage,
    temperature: COMPRESSION_TEMPERATURE,
    maxTokens: COMPRESSION_MAX_TOKENS,
  });

  return {
    text: text.trim(),
    durationMs: Date.now() - startTime,
  };
}

/**
 * Format a CompressionRequest as a user message for the LLM.
 * Includes all fields the LLM needs to compress.
 */
function formatRequestForLLM(request: CompressionRequest): string {
  const parts: string[] = [];

  parts.push(`Sender: ${request.sender}`);
  parts.push(`Receiver: ${request.receiver}`);
  parts.push(`Project: ${request.projectId}`);
  parts.push(`Task: ${request.taskSummary}`);
  parts.push(`Priority: ${request.priority}`);
  parts.push(``);
  parts.push(`--- SENDER CONTEXT ---`);
  parts.push(``);
  parts.push(`WORKFLOW STATE:`);
  parts.push(JSON.stringify(request.workflowState, null, 2));

  if (request.senderMemories.length > 0) {
    parts.push(``);
    parts.push(`SENDER'S LONG-TERM MEMORIES:`);
    for (const m of request.senderMemories) {
      parts.push(`- ${m}`);
    }
  }

  if (request.senderQuestions.length > 0) {
    parts.push(``);
    parts.push(`SENDER'S QUESTIONS:`);
    request.senderQuestions.forEach((q, i) => {
      parts.push(`${i + 1}. ${q}`);
    });
  }

  if (request.constraints.length > 0) {
    parts.push(``);
    parts.push(`HARD CONSTRAINTS:`);
    for (const c of request.constraints) {
      parts.push(`- ${c}`);
    }
  }

  if (request.knownFailures.length > 0) {
    parts.push(``);
    parts.push(`KNOWN FAILURES:`);
    for (const f of request.knownFailures) {
      parts.push(`- ${f}`);
    }
  }

  if (request.conversationSnippet.length > 0) {
    parts.push(``);
    parts.push(`CONVERSATION HISTORY:`);
    for (const msg of request.conversationSnippet) {
      parts.push(`[${msg.role}]: ${msg.content}`);
    }
  }

  return parts.join("\n");
}

export { COMPRESSION_SYSTEM_PROMPT, formatRequestForLLM };
