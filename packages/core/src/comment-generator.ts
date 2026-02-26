/**
 * LLM-powered comment generation for GitHub issue/PR comments.
 * Ported from GWA src/lib/comment-generator.ts, adapted for mesh-six.
 */

import { chatCompletion } from "./llm.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommentType =
  | "session-start"
  | "progress"
  | "question"
  | "completion"
  | "error";

export interface CommentOptions {
  type: CommentType;
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  sessionId?: string;
  context: Record<string, unknown>;
}

export interface SessionSummaryInput {
  toolCalls: Array<{ tool_name: string; success: boolean; duration_ms?: number }>;
  durationMs: number;
  filesChanged?: number;
  commitsCreated?: number;
  questionsAsked?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = process.env.COMMENT_GENERATOR_MODEL ?? "claude-haiku-3-5";

function formatDuration(ms: number): string {
  if (ms >= 3_600_000) {
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }
  if (ms >= 60_000) {
    return `${Math.round(ms / 60_000)}m`;
  }
  return `${Math.round(ms / 1_000)}s`;
}

function systemPromptFor(type: CommentType): string {
  switch (type) {
    case "session-start":
      return (
        "You write short, friendly GitHub issue comments announcing that an AI agent has started " +
        "working on an issue. Keep it to 1-2 sentences. Use plain text — no emoji, no markdown headers. " +
        "Mention the issue number and session ID if provided."
      );
    case "progress":
      return (
        "You write concise GitHub issue progress updates for an AI agent implementation session. " +
        "Describe the current phase and any notable details in 1-3 sentences. Plain text only."
      );
    case "question":
      return (
        "You write a clear, concise GitHub issue comment from an AI agent asking a specific question. " +
        "State the question directly. Add a single line explaining why it matters. No extra prose."
      );
    case "completion":
      return (
        "You write a brief GitHub issue comment summarising what an AI agent accomplished. " +
        "Use 2-3 sentences in past tense. Mention files changed or commits created if provided. " +
        "Plain text only."
      );
    case "error":
      return (
        "You write a GitHub issue comment describing an error an AI agent encountered. " +
        "Describe the problem clearly in 1-2 sentences and suggest a simple next step. Plain text only."
      );
  }
}

function userPromptFor(opts: CommentOptions): string {
  const { type, issueNumber, repoOwner, repoName, sessionId, context } = opts;
  const header = `Issue: ${repoOwner}/${repoName}#${issueNumber}` +
    (sessionId ? `\nSession ID: ${sessionId}` : "");
  const ctxStr = Object.entries(context)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `${header}\nContext:\n${ctxStr}\n\nWrite the ${type} comment now.`;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Generate a concise GitHub comment appropriate for the given comment type.
 * Uses the LiteLLM gateway via chatCompletion.
 *
 * @param opts    - Comment options including type, issue coordinates, and context.
 * @param model   - LiteLLM model name to use (defaults to COMMENT_GENERATOR_MODEL env var
 *                  or "claude-haiku-3-5").
 */
export async function generateComment(
  opts: CommentOptions,
  model: string = DEFAULT_MODEL,
): Promise<string> {
  const result = await chatCompletion({
    model,
    system: systemPromptFor(opts.type),
    prompt: userPromptFor(opts),
    temperature: 0.3,
    maxTokens: 256,
  });
  return result.text.trim();
}

/**
 * Generate a 2-3 sentence summary of an implementation session based on tool
 * call history and duration metrics.
 *
 * @param input   - Session metrics: tool calls, duration, files changed, etc.
 * @param model   - LiteLLM model name to use (defaults to COMMENT_GENERATOR_MODEL env var
 *                  or "claude-haiku-3-5").
 */
export async function generateSessionSummary(
  input: SessionSummaryInput,
  model: string = DEFAULT_MODEL,
): Promise<string> {
  const toolLines = input.toolCalls
    .map(
      (t) =>
        `- ${t.tool_name}: ${t.success ? "success" : "failed"}` +
        (t.duration_ms !== undefined ? ` (${t.duration_ms}ms)` : ""),
    )
    .join("\n");

  const stats: string[] = [`Duration: ${formatDuration(input.durationMs)}`];
  if (input.filesChanged !== undefined) stats.push(`Files changed: ${input.filesChanged}`);
  if (input.commitsCreated !== undefined) stats.push(`Commits created: ${input.commitsCreated}`);
  if (input.questionsAsked !== undefined) stats.push(`Questions asked: ${input.questionsAsked}`);

  const prompt =
    `Summarise what the AI coding agent did during this implementation session in 2-3 concise sentences. ` +
    `Focus on actions taken and the outcome. Use past tense.\n\n` +
    `Session stats:\n${stats.join("\n")}\n\n` +
    `Tool calls:\n${toolLines || "(none)"}`;

  const result = await chatCompletion({
    model,
    system:
      "You summarise AI agent implementation sessions for GitHub issue comments. " +
      "Be direct, factual, and concise. Plain text only — no markdown.",
    prompt,
    temperature: 0.2,
    maxTokens: 200,
  });
  return result.text.trim();
}

/**
 * Format a structured status comment with a hidden HTML marker so it can be
 * found and updated later. Pure function — no LLM call.
 *
 * The marker `<!-- mesh-six-status -->` is embedded as the first line so
 * callers can search for it via the GitHub API to locate the existing comment.
 *
 * @param phase   - Current workflow phase name (e.g. "PLANNING", "IN_PROGRESS").
 * @param details - Arbitrary key-value details to include in the comment body.
 */
export function formatStatusComment(
  phase: string,
  details: Record<string, unknown>,
): string {
  const timestamp = new Date().toISOString();

  const rows = Object.entries(details)
    .map(([key, value]) => {
      const label = key
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (c) => c.toUpperCase())
        .trim();
      const display =
        value === null || value === undefined
          ? "—"
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
      return `| ${label} | ${display} |`;
    })
    .join("\n");

  const table = rows
    ? `| Detail | Value |\n|--------|-------|\n${rows}`
    : "";

  return [
    "<!-- mesh-six-status -->",
    `**Phase: ${phase}**`,
    "",
    table,
    "",
    `_Last updated: ${timestamp}_`,
  ]
    .filter((line, i, arr) => {
      // Collapse consecutive blank lines that arise when table is empty.
      if (line === "" && i > 0 && arr[i - 1] === "") return false;
      return true;
    })
    .join("\n")
    .trimEnd();
}
