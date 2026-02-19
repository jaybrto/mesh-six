#!/usr/bin/env bun
/**
 * Hook Event Publisher
 *
 * Lightweight Bun script that receives Claude CLI hook events via stdin
 * and publishes them to Dapr pub/sub for real-time streaming.
 *
 * This runs as a subprocess of the Claude CLI (configured in settings.json hooks).
 * The Dapr sidecar on localhost handles the async RabbitMQ publish, making this
 * script fast (~1-5ms) so it doesn't block the CLI.
 *
 * Environment Variables:
 *   DAPR_HTTP_PORT - Dapr sidecar HTTP port (default: 3500)
 *   ACTOR_ID       - The actor that spawned this CLI instance
 *   SESSION_ID     - The current session ID
 */

const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const ACTOR_ID = process.env.ACTOR_ID || "unknown";
const SESSION_ID = process.env.SESSION_ID || "";
const PUBSUB_NAME = "agent-pubsub";
const TOPIC = "llm.events";

interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  error?: string;
  model?: string;
  reason?: string;
  message?: string;
  title?: string;
  notification_type?: string;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  try {
    // Read event from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf-8").trim();

    if (!raw) {
      process.exit(0);
    }

    let input: HookInput;
    try {
      input = JSON.parse(raw);
    } catch {
      process.exit(0);
    }

    // Build event payload
    const event = {
      actorId: ACTOR_ID,
      sessionId: input.session_id || SESSION_ID,
      timestamp: new Date().toISOString(),
      hookEvent: input.hook_event_name || "unknown",
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolResponse: input.tool_response,
      error: input.error,
      model: input.model,
      reason: input.reason,
      notification: input.message
        ? {
            message: input.message,
            title: input.title,
            type: input.notification_type,
          }
        : undefined,
    };

    // Publish to Dapr sidecar (fast local HTTP call)
    await fetch(
      `http://localhost:${DAPR_HTTP_PORT}/v1.0/publish/${PUBSUB_NAME}/${TOPIC}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      },
    );
  } catch {
    // Never block the CLI — swallow all errors
  }

  process.exit(0);
}

main();
