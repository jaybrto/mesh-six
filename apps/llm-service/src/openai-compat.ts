import { randomUUID } from "crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
} from "@mesh-six/core";

/**
 * Build the prompt string for the Claude CLI from OpenAI-compatible messages.
 * Extracts system prompt and user/assistant messages into a format suitable
 * for `claude -p`.
 */
export function buildCLIPrompt(messages: ChatMessage[]): {
  systemPrompt: string | undefined;
  userPrompt: string;
} {
  let systemPrompt: string | undefined;
  const conversationParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // Collect all system messages into one system prompt
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${msg.content}`
        : msg.content;
    } else if (msg.role === "user") {
      conversationParts.push(msg.content);
    } else if (msg.role === "assistant") {
      // Include assistant messages as context prefixed with role
      conversationParts.push(`[Previous assistant response]\n${msg.content}`);
    }
  }

  return {
    systemPrompt,
    userPrompt: conversationParts.join("\n\n"),
  };
}

/**
 * If the request includes a response_format with a JSON schema,
 * inject schema instructions into the prompt so the CLI returns structured JSON.
 */
export function injectSchemaInstructions(
  prompt: string,
  request: ChatCompletionRequest,
): string {
  if (
    request.response_format?.type !== "json_object" ||
    !request.response_format.schema
  ) {
    return prompt;
  }

  const schemaJson = JSON.stringify(request.response_format.schema, null, 2);
  return `${prompt}\n\nIMPORTANT: You MUST respond with valid JSON matching this schema:\n\`\`\`json\n${schemaJson}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`;
}

/**
 * Parse CLI output into an OpenAI-compatible chat completion response.
 */
export function buildCompletionResponse(
  content: string,
  model: string,
  sessionId?: string,
): ChatCompletionResponse {
  const now = Math.floor(Date.now() / 1000);

  // Rough token estimation: 1 token ≈ 4 characters
  const completionTokens = Math.ceil(content.length / 4);

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: now,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0, // We don't have this info from CLI
      completion_tokens: completionTokens,
      total_tokens: completionTokens,
    },
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

/**
 * Build an error response in OpenAI-compatible format.
 */
export function buildErrorResponse(
  error: string,
  model: string,
): ChatCompletionResponse {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
        },
        finish_reason: "error",
      },
    ],
  };
}
