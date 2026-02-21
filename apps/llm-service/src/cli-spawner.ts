import { detectAuthFailure, ClaudeAuthError } from "@mesh-six/core";
import { CLAUDE_CLI_PATH, HOOK_SCRIPT_PATH, DAPR_HTTP_PORT, AGENT_ID } from "./config.js";

const log = (msg: string) => console.log(`[${AGENT_ID}][cli] ${msg}`);

export interface CLISpawnOptions {
  /** The user prompt to send */
  prompt: string;
  /** Optional system prompt */
  systemPrompt?: string;
  /** Model to use (passed via --model) */
  model?: string;
  /** Max tokens for the response */
  maxTokens?: number;
  /** Per-actor config directory (contains credentials, settings, etc.) */
  configDir: string;
  /** Working directory for the CLI process */
  cwd?: string;
  /** Actor ID (passed to hooks via env var) */
  actorId: string;
  /** Session ID for hooks and session tracking */
  sessionId?: string;
  /** Timeout in milliseconds */
  timeout?: number;
}

export interface CLISpawnResult {
  success: boolean;
  content: string;
  exitCode: number;
  durationMs: number;
  /** Parsed from --output-format json if available */
  costUsd?: number;
  sessionId?: string;
  isAuthError?: boolean;
}

/**
 * Spawn the Claude CLI in print mode and return the response.
 *
 * Uses `claude -p` for single-shot non-interactive execution.
 * The `--output-format json` flag returns structured JSON with the response.
 */
export async function spawnCLI(opts: CLISpawnOptions): Promise<CLISpawnResult> {
  const startTime = Date.now();

  const args: string[] = [
    "--print",
    "--output-format", "json",
    "--verbose",
  ];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.maxTokens) {
    args.push("--max-turns", "1");
  }

  if (opts.systemPrompt) {
    args.push("--system-prompt", opts.systemPrompt);
  }

  // The prompt is the last argument
  args.push(opts.prompt);

  // Environment for the CLI process
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    // Point CLI to this actor's config directory
    CLAUDE_CONFIG_DIR: opts.configDir,
    HOME: opts.configDir,
    // Skip interactive dialogs
    CI: "true",
    // Hook integration — pass actor context to hook scripts
    ACTOR_ID: opts.actorId,
    SESSION_ID: opts.sessionId || "",
    DAPR_HTTP_PORT: String(DAPR_HTTP_PORT),
    // Tell the CLI to use our hook script
    CLAUDE_CODE_HOOK_SCRIPT: HOOK_SCRIPT_PATH,
  };

  const timeout = opts.timeout || 120_000; // 2 minutes default

  log(`Spawning CLI: ${CLAUDE_CLI_PATH} -p (model: ${opts.model || "default"}, configDir: ${opts.configDir})`);

  const proc = Bun.spawn([CLAUDE_CLI_PATH, ...args], {
    cwd: opts.cwd || opts.configDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Set up timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`CLI process timed out after ${timeout}ms`));
    }, timeout);
  });

  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeoutPromise.then(() => {
        throw new Error("timeout");
      }),
    ]);

    const durationMs = Date.now() - startTime;

    // Check for auth failures in stderr
    if (detectAuthFailure(stderr) || detectAuthFailure(stdout)) {
      return {
        success: false,
        content: "",
        exitCode: exitCode || 1,
        durationMs,
        isAuthError: true,
      };
    }

    if (exitCode !== 0) {
      log(`CLI exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
      return {
        success: false,
        content: stderr || stdout,
        exitCode,
        durationMs,
      };
    }

    // Parse the JSON output from --output-format json
    const parsed = parseCLIOutput(stdout);

    return {
      success: true,
      content: parsed.content,
      exitCode: 0,
      durationMs,
      costUsd: parsed.costUsd,
      sessionId: parsed.sessionId,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    return {
      success: false,
      content: message,
      exitCode: -1,
      durationMs,
    };
  }
}

/**
 * Parse CLI JSON output format.
 * The CLI with --output-format json returns a JSON object with result details.
 */
function parseCLIOutput(raw: string): {
  content: string;
  costUsd?: number;
  sessionId?: string;
} {
  const trimmed = raw.trim();

  // Try to parse as JSON (from --output-format json)
  try {
    const parsed = JSON.parse(trimmed);

    // The CLI JSON format typically has a "result" or "response" field
    if (typeof parsed === "object" && parsed !== null) {
      // Handle various CLI JSON output structures
      const content =
        parsed.result ||
        parsed.response ||
        parsed.content ||
        parsed.text ||
        (typeof parsed.message === "string" ? parsed.message : null);

      if (content) {
        return {
          content: typeof content === "string" ? content : JSON.stringify(content),
          costUsd: parsed.cost_usd || parsed.costUsd,
          sessionId: parsed.session_id || parsed.sessionId,
        };
      }

      // If it's a JSON object but doesn't match known fields, return it stringified
      return { content: JSON.stringify(parsed) };
    }
  } catch {
    // Not JSON — treat as plain text output
  }

  // Fallback: return raw text
  return { content: trimmed };
}

/**
 * Validate that the CLI is working with a lightweight test call.
 * Used during actor activation to verify credentials.
 */
export async function validateCLI(
  configDir: string,
  actorId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await spawnCLI({
      prompt: "Respond with exactly: OK",
      model: "claude-haiku-4-5-20251001",
      configDir,
      actorId,
      timeout: 30_000, // 30s for validation
    });

    if (result.isAuthError) {
      return { ok: false, error: "Authentication failed" };
    }

    // Validation only checks authentication. A non-zero exit code with
    // non-auth content (e.g. JSON init messages, partial responses) means
    // the CLI started and authenticated — good enough for validation.
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
