// ============================================================================
// ENVIRONMENT CONFIGURATION
// ============================================================================

export const APP_PORT = Number(process.env.APP_PORT) || 3000;
export const DAPR_HOST = process.env.DAPR_HOST || "127.0.0.1";
export const DAPR_HTTP_PORT = Number(process.env.DAPR_HTTP_PORT) || 3500;
export const DATABASE_URL = process.env.DATABASE_URL || "";

// Base directory for git worktrees (30Gi PVC mounted here in k8s)
export const WORKTREE_BASE_DIR = process.env.WORKTREE_BASE_DIR || "/worktrees";

// Claude CLI session directory (10Gi PVC mounted here in k8s — persistent ~/.claude)
export const CLAUDE_SESSION_DIR = process.env.CLAUDE_SESSION_DIR || "/home/bun/.claude";

// Agent identity
export const AGENT_ID = "implementer";
export const AGENT_NAME = "Implementer";
