/**
 * Dialog detection and analysis for Claude Code CLI.
 *
 * Detects interactive TUI dialogs blocking Claude from starting.
 * Returns key sequences to dismiss them. Does NOT send keys itself —
 * the caller (llm-service, implementer) handles tmux/terminal interaction.
 *
 * Ported from GWA src/lib/dialog-handler.ts
 */

const MAX_KEYS = 10;

/** Allowed tmux key names */
const ALLOWED_KEYS = new Set([
  "Down", "Up", "Enter", "Tab", "Space", "Escape",
  "y", "n", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);

/** Known dialog patterns dismissable without an API call */
export const KNOWN_DIALOGS: Array<{
  pattern: RegExp;
  keys: string[];
  reason: string;
}> = [
  {
    pattern: /bypass permissions/i,
    keys: ["Enter"],
    reason: "Accepting bypass permissions dialog",
  },
  {
    pattern: /trust this project/i,
    keys: ["Enter"],
    reason: "Trusting project directory",
  },
  {
    pattern: /Choose the text style|text style that looks best|Dark mode.*Light mode/i,
    keys: ["Enter"],
    reason: "Selecting default theme (dark mode)",
  },
  {
    pattern: /Select login method.*Claude account with subscription/is,
    keys: ["Enter"],
    reason: "Selecting Claude account with subscription login",
  },
  {
    pattern: /Browser didn't open.*Paste code here/is,
    keys: ["Escape"],
    reason: "Dismissing OAuth browser flow (token already cached)",
  },
  {
    pattern: /token revoked|please run \/login/i,
    keys: ["Escape"],
    reason: "Token revoked — cannot dismiss, need credential refresh",
  },
];

/** System prompt for LLM-based dialog analysis */
export const DIALOG_ANALYSIS_PROMPT = `You are monitoring a terminal where Claude Code CLI is starting up.
Check if there is an interactive dialog, prompt, or permission request
blocking Claude from running.

If blocked, respond with the tmux key sequence to accept/proceed.
Always accept permissions, agree to terms, and choose options that
let Claude Code start. Use tmux key names: Down, Up, Enter, Tab,
Space, Escape, y, n, or digits 0-9.

Respond ONLY with JSON (no markdown):
{"blocked": true, "keys": ["Down", "Enter"], "reason": "Accepting bypass permissions"}
or
{"blocked": false}`;

export interface DialogResponse {
  blocked: boolean;
  keys: string[];
  reason: string;
}

export class ClaudeDialogError extends Error {
  public readonly capturedOutput: string;
  constructor(message: string, capturedOutput: string) {
    super(message);
    this.name = "ClaudeDialogError";
    this.capturedOutput = capturedOutput;
  }
}

/**
 * Check if pane text matches a known dialog pattern.
 * Returns the matching entry or null.
 */
export function matchKnownDialog(
  paneText: string
): { keys: string[]; reason: string } | null {
  for (const dialog of KNOWN_DIALOGS) {
    if (dialog.pattern.test(paneText)) {
      return { keys: dialog.keys, reason: dialog.reason };
    }
  }
  return null;
}

/**
 * Quick heuristic: does the pane text look like normal Claude operation?
 */
export function looksNormal(paneText: string): boolean {
  const trimmed = paneText.trim();
  if (trimmed.length === 0) return true;

  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return true;

  const lastLine = (lines[lines.length - 1] ?? "").trim();

  // Claude REPL prompt
  if (lastLine.startsWith(">") && lastLine.length <= 2) return true;

  // Claude is processing (spinner characters)
  const spinnerChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  if (
    lastLine.includes("Thinking") ||
    spinnerChars.some((c) => lastLine.includes(c))
  ) {
    return true;
  }

  return false;
}

/**
 * Parse and validate an LLM JSON response for dialog detection.
 * Filters keys to allowed whitelist, enforces max key count.
 */
export function parseDialogResponse(raw: string): DialogResponse {
  const parsed = JSON.parse(raw.trim());
  const blocked = Boolean(parsed.blocked);

  if (!blocked) {
    return { blocked: false, keys: [], reason: "" };
  }

  const rawKeys: unknown[] = Array.isArray(parsed.keys) ? parsed.keys : [];
  const keys = rawKeys
    .filter((k): k is string => typeof k === "string" && ALLOWED_KEYS.has(k))
    .slice(0, MAX_KEYS);

  const reason = typeof parsed.reason === "string" ? parsed.reason : "";
  return { blocked, keys, reason };
}
