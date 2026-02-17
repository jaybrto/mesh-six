#!/usr/bin/env bun
/**
 * Claude MQTT Bridge
 *
 * A lightweight Bun script that receives Claude Code hook events via stdin
 * and publishes them to MQTT for real-time progress monitoring.
 *
 * Locally, events are always stored to a SQLite database for querying.
 * MQTT publishing is attempted but optional (designed for k8s pods).
 *
 * Usage:
 *   echo '{"session_id":"abc","hook_event_name":"SessionStart"}' | bun run src/index.ts
 *
 * Environment Variables:
 *   MQTT_URL          - MQTT broker URL (default: mqtt://localhost:1883)
 *   MQTT_TOPIC_PREFIX - Topic prefix (default: claude/progress)
 *   MQTT_CLIENT_ID    - Client ID prefix (default: claude-bridge)
 *   SQLITE_DB_PATH    - SQLite database path (default: $CLAUDE_PROJECT_DIR/.claude/claude-events.db)
 *   SQLITE_DISABLED   - Set "true" to skip SQLite storage
 *   GIT_BRANCH        - Override git branch detection
 *   WORKTREE_PATH     - Override worktree path detection
 *   JOB_ID            - Optional job ID for mesh-six integration
 */

import * as mqtt from "mqtt";
import { Database } from "bun:sqlite";
import { spawn } from "child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
// --- Configuration ---
const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const MQTT_TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX || "claude/progress";
const MQTT_CLIENT_ID = `${process.env.MQTT_CLIENT_ID || "claude-bridge"}-${Date.now()}`;
const CONNECT_TIMEOUT_MS = 3000;
const PUBLISH_TIMEOUT_MS = 2000;

function resolveDbPath(): string {
  if (process.env.SQLITE_DB_PATH) return process.env.SQLITE_DB_PATH;
  if (process.env.CLAUDE_PROJECT_DIR) return join(process.env.CLAUDE_PROJECT_DIR, ".claude", "claude-events.db");
  return join(process.cwd(), ".claude", "claude-events.db");
}
const SQLITE_DB_PATH = resolveDbPath();
const SQLITE_DISABLED = process.env.SQLITE_DISABLED === "true";

// --- Types ---

interface ClaudeHookInput {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name: string;
  // SessionStart specific
  source?: string;
  model?: string;
  // Tool specific
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  tool_use_id?: string;
  // Error specific
  error?: string;
  is_interrupt?: boolean;
  // Subagent specific
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  // Stop specific
  stop_hook_active?: boolean;
  // SessionEnd specific
  reason?: string;
  // Notification specific
  message?: string;
  title?: string;
  notification_type?: string;
}

interface EnrichedEvent {
  timestamp: number;
  session_id: string;
  event: string;
  status: "started" | "pending" | "completed" | "failed" | "ended" | "unknown";
  // Enriched context
  git_branch?: string;
  worktree_path?: string;
  model?: string;
  job_id?: string;
  // Event-specific data
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  error?: string;
  agent_id?: string;
  agent_type?: string;
  source?: string;
  reason?: string;
  notification?: {
    message?: string;
    title?: string;
    type?: string;
  };
}

// --- Session State (for tracking model across events) ---
const sessionState = new Map<string, { model?: string }>();

// --- Helper Functions ---

/**
 * Run a git command and return the output
 */
async function runGitCommand(args: string[], cwd?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd: cwd || process.cwd(),
      timeout: 1000,
    });

    let output = "";
    proc.stdout.on("data", (data) => {
      output += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        resolve(null);
      }
    });

    proc.on("error", () => {
      resolve(null);
    });
  });
}

/**
 * Get current git branch
 */
async function getGitBranch(cwd?: string): Promise<string | null> {
  if (process.env.GIT_BRANCH) {
    return process.env.GIT_BRANCH;
  }
  return runGitCommand(["branch", "--show-current"], cwd);
}

/**
 * Get git worktree path (root of the repo)
 */
async function getWorktreePath(cwd?: string): Promise<string | null> {
  if (process.env.WORKTREE_PATH) {
    return process.env.WORKTREE_PATH;
  }
  return runGitCommand(["rev-parse", "--show-toplevel"], cwd);
}

/**
 * Read all input from stdin
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Parse and enrich the hook input
 */
async function enrichEvent(input: ClaudeHookInput): Promise<EnrichedEvent> {
  const cwd = input.cwd || process.cwd();

  // Get git info in parallel
  const [gitBranch, worktreePath] = await Promise.all([
    getGitBranch(cwd),
    getWorktreePath(cwd),
  ]);

  // Track model from SessionStart
  if (input.hook_event_name === "SessionStart" && input.model) {
    sessionState.set(input.session_id, { model: input.model });
  }

  // Get model from session state if not in current event
  const sessionData = sessionState.get(input.session_id);
  const model = input.model || sessionData?.model;

  // Determine status based on event type
  let status: EnrichedEvent["status"] = "unknown";
  switch (input.hook_event_name) {
    case "SessionStart":
      status = "started";
      break;
    case "PreToolUse":
      status = "pending";
      break;
    case "PostToolUse":
      status = "completed";
      break;
    case "PostToolUseFailure":
      status = "failed";
      break;
    case "SubagentStart":
      status = "started";
      break;
    case "SubagentStop":
      status = "completed";
      break;
    case "SessionEnd":
      status = "ended";
      break;
    default:
      status = "unknown";
  }

  // Build enriched event
  const enriched: EnrichedEvent = {
    timestamp: Date.now(),
    session_id: input.session_id,
    event: input.hook_event_name,
    status,
    git_branch: gitBranch || undefined,
    worktree_path: worktreePath || undefined,
    model: model || undefined,
    job_id: process.env.JOB_ID || undefined,
  };

  // Add event-specific fields
  switch (input.hook_event_name) {
    case "SessionStart":
      enriched.source = input.source;
      break;

    case "PreToolUse":
    case "PostToolUse":
      enriched.tool_name = input.tool_name;
      enriched.tool_input = input.tool_input;
      if (input.tool_response) {
        enriched.tool_response = input.tool_response;
      }
      break;

    case "PostToolUseFailure":
      enriched.tool_name = input.tool_name;
      enriched.tool_input = input.tool_input;
      enriched.error = input.error;
      break;

    case "SubagentStart":
    case "SubagentStop":
      enriched.agent_id = input.agent_id;
      enriched.agent_type = input.agent_type;
      break;

    case "SessionEnd":
      enriched.reason = input.reason;
      // Clean up session state
      sessionState.delete(input.session_id);
      break;

    case "Notification":
      enriched.notification = {
        message: input.message,
        title: input.title,
        type: input.notification_type,
      };
      break;
  }

  return enriched;
}

/**
 * Publish event to MQTT
 */
async function publishToMqtt(event: EnrichedEvent): Promise<void> {
  return new Promise((resolve, reject) => {
    const connectTimeout = setTimeout(() => {
      reject(new Error("MQTT connection timeout"));
    }, CONNECT_TIMEOUT_MS);

    const client = mqtt.connect(MQTT_URL, {
      clientId: MQTT_CLIENT_ID,
      clean: true,
      connectTimeout: CONNECT_TIMEOUT_MS,
    });

    client.on("connect", () => {
      clearTimeout(connectTimeout);

      // Build topic: claude/progress/{session_id}/{event_type}
      const topic = `${MQTT_TOPIC_PREFIX}/${event.session_id}/${event.event}`;
      const payload = JSON.stringify(event);

      const publishTimeout = setTimeout(() => {
        client.end(true);
        reject(new Error("MQTT publish timeout"));
      }, PUBLISH_TIMEOUT_MS);

      client.publish(topic, payload, { qos: 1 }, (err: Error | undefined) => {
        clearTimeout(publishTimeout);
        client.end(true);

        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    client.on("error", (err: Error) => {
      clearTimeout(connectTimeout);
      client.end(true);
      reject(err);
    });
  });
}

// --- SQLite Local Storage ---

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;

  const dir = dirname(SQLITE_DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(SQLITE_DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");

  db.run(`
    CREATE TABLE IF NOT EXISTS claude_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      event TEXT NOT NULL,
      status TEXT NOT NULL,
      git_branch TEXT,
      worktree_path TEXT,
      model TEXT,
      job_id TEXT,
      tool_name TEXT,
      error TEXT,
      agent_id TEXT,
      agent_type TEXT,
      payload TEXT NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_events_session ON claude_events (session_id, timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_type ON claude_events (event, timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_tool ON claude_events (tool_name) WHERE tool_name IS NOT NULL`);

  return db;
}

const insertStmt = () => getDb().prepare(`
  INSERT INTO claude_events
    (timestamp, session_id, event, status, git_branch, worktree_path, model, job_id, tool_name, error, agent_id, agent_type, payload)
  VALUES
    ($timestamp, $session_id, $event, $status, $git_branch, $worktree_path, $model, $job_id, $tool_name, $error, $agent_id, $agent_type, $payload)
`);

function writeToSqlite(event: EnrichedEvent): void {
  insertStmt().run({
    $timestamp: event.timestamp,
    $session_id: event.session_id,
    $event: event.event,
    $status: event.status,
    $git_branch: event.git_branch ?? null,
    $worktree_path: event.worktree_path ?? null,
    $model: event.model ?? null,
    $job_id: event.job_id ?? null,
    $tool_name: event.tool_name ?? null,
    $error: event.error ?? null,
    $agent_id: event.agent_id ?? null,
    $agent_type: event.agent_type ?? null,
    $payload: JSON.stringify(event),
  });
}

// --- Main ---

async function main(): Promise<void> {
  try {
    // Read stdin
    const stdin = await readStdin();
    if (!stdin.trim()) {
      console.error("[claude-mqtt-bridge] No input received");
      process.exit(0);
    }

    // Parse input
    let input: ClaudeHookInput;
    try {
      input = JSON.parse(stdin);
    } catch {
      console.error("[claude-mqtt-bridge] Failed to parse JSON input");
      process.exit(0);
    }

    // Validate required fields
    if (!input.session_id || !input.hook_event_name) {
      console.error("[claude-mqtt-bridge] Missing required fields: session_id, hook_event_name");
      process.exit(0);
    }

    // Enrich event
    const enriched = await enrichEvent(input);

    // Always write to local SQLite (fast, no network)
    if (!SQLITE_DISABLED) {
      try {
        writeToSqlite(enriched);
      } catch (err) {
        console.error(`[claude-mqtt-bridge] SQLite write failed: ${err}`);
      }
    }

    // Try to publish to MQTT (optional, for k8s environments)
    try {
      await publishToMqtt(enriched);

      if (process.env.VERBOSE === "true") {
        console.log(`[claude-mqtt-bridge] Published ${enriched.event} to MQTT`);
      }
    } catch {
      // MQTT unavailable — expected when running locally
    }

    // Exit successfully (don't block Claude)
    process.exit(0);
  } catch (err) {
    console.error(`[claude-mqtt-bridge] Error: ${err}`);
    process.exit(0); // Exit 0 to not block Claude
  }
}

main();
