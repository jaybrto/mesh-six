/**
 * ImplementerActor — Dapr actor for managing a single implementation session.
 *
 * Each active issue maps to one actor instance. The actor provisions credentials
 * from auth-service, clones the repo, creates a worktree, and starts a Claude
 * CLI session inside tmux.
 */
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import {
  type ImplementationSession,
  type ProvisionResponse,
  AUTH_SERVICE_APP_ID,
} from "@mesh-six/core";
import {
  DAPR_HOST,
  DAPR_HTTP_PORT,
  AUTH_PROJECT_ID,
  WORKTREE_BASE_DIR,
  CLAUDE_SESSION_DIR,
  AGENT_ID,
} from "./config.js";
import {
  createSession,
  sendCommand,
  capturePane,
  killSession,
  sessionExists,
} from "./tmux.js";
import {
  insertSession,
  updateSessionStatus,
  insertActivityLog,
} from "./session-db.js";
import { matchKnownDialog, looksNormal } from "@mesh-six/core";

const log = (msg: string) => console.log(`[${AGENT_ID}][actor] ${msg}`);

const DIALOG_DISMISS_DELAY_MS = 500;
const DIALOG_POST_WAIT_MS = 1000;

// ---------------------------------------------------------------------------
// Actor state (in-memory per actor instance)
// ---------------------------------------------------------------------------

export interface ActorState {
  sessionId: string;
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  tmuxSessionName: string;
  worktreeDir: string;
  credentialBundleId?: string;
  status: ImplementationSession["status"];
  startedAt?: string;
  workflowId?: string;
  answerInjected?: boolean;
}

// ---------------------------------------------------------------------------
// ImplementerActor
// ---------------------------------------------------------------------------

export class ImplementerActor {
  private actorId: string;
  private state: ActorState | null = null;

  constructor(actorId: string) {
    this.actorId = actorId;
  }

  // -------------------------------------------------------------------------
  // LIFECYCLE
  // -------------------------------------------------------------------------

  /**
   * Called when the actor is first activated for an issue.
   * Provisions credentials from auth-service, clones repo, creates worktree.
   */
  async onActivate(params: {
    sessionId: string;
    issueNumber: number;
    repoOwner: string;
    repoName: string;
    branch: string;
    workflowId?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    log(`Activating actor ${this.actorId} for issue #${params.issueNumber}`);

    const tmuxSessionName = `impl-${params.repoOwner}-${params.repoName}-${params.issueNumber}`;
    const worktreeDir = join(WORKTREE_BASE_DIR, `${params.repoOwner}-${params.repoName}`, `issue-${params.issueNumber}`);

    // Provision credentials from auth-service via Dapr service invocation
    let bundleId: string | undefined;
    try {
      bundleId = await this.provisionCredentials();
    } catch (err) {
      log(`Credential provisioning failed: ${err}`);
      return { ok: false, error: `Credential provisioning failed: ${err}` };
    }

    // Clone/fetch repo and create worktree
    try {
      await this.setupWorktree(params.repoOwner, params.repoName, params.branch, worktreeDir);
    } catch (err) {
      log(`Worktree setup failed: ${err}`);
      return { ok: false, error: `Worktree setup failed: ${err}` };
    }

    this.state = {
      sessionId: params.sessionId,
      issueNumber: params.issueNumber,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      tmuxSessionName,
      worktreeDir,
      credentialBundleId: bundleId,
      status: "idle",
      workflowId: params.workflowId,
    };

    await insertActivityLog({
      sessionId: params.sessionId,
      eventType: "actor_activated",
      detailsJson: { actorId: this.actorId, bundleId, worktreeDir },
    });

    log(`Actor ${this.actorId} activated — worktree: ${worktreeDir}`);
    return { ok: true };
  }

  /**
   * Start a Claude CLI session inside tmux for the given prompt.
   */
  async startSession(params: {
    implementationPrompt: string;
  }): Promise<{ ok: boolean; error?: string }> {
    if (!this.state) {
      return { ok: false, error: "Actor not activated" };
    }

    const { tmuxSessionName, worktreeDir, sessionId } = this.state;

    // Kill any existing tmux session for this issue
    if (await sessionExists(tmuxSessionName)) {
      await killSession(tmuxSessionName);
    }

    // Create a fresh tmux session
    await createSession(tmuxSessionName);

    // Navigate to worktree
    await sendCommand(tmuxSessionName, `cd ${worktreeDir}`);
    await Bun.sleep(200);

    // Set CLAUDE_SESSION_DIR so the Claude CLI uses the persistent volume
    await sendCommand(tmuxSessionName, `export CLAUDE_CONFIG_DIR=${CLAUDE_SESSION_DIR}`);
    await Bun.sleep(100);

    // Start Claude CLI in non-interactive mode with the implementation prompt
    const escapedPrompt = params.implementationPrompt.replace(/'/g, "'\\''");
    await sendCommand(tmuxSessionName, `claude -p '${escapedPrompt}'`);

    // Brief wait for CLI to start, then handle any startup dialogs
    await Bun.sleep(2000);
    await this.handleStartupDialogs(tmuxSessionName);

    this.state.status = "running";
    this.state.startedAt = new Date().toISOString();

    await updateSessionStatus(sessionId, "running", {
      tmuxWindow: 0,
      credentialBundleId: this.state.credentialBundleId,
      startedAt: this.state.startedAt,
    });

    await insertActivityLog({
      sessionId,
      eventType: "session_started",
      detailsJson: { tmuxSessionName, worktreeDir },
    });

    log(`Session started in tmux session: ${tmuxSessionName}`);
    return { ok: true };
  }

  /**
   * Get the current actor status.
   */
  getStatus(): { actorId: string; state: ActorState | null } {
    return { actorId: this.actorId, state: this.state };
  }

  /**
   * Inject an answer text into the running Claude CLI session via tmux send-keys.
   * Called by PM workflow when architect or human provides an answer.
   */
  async injectAnswer(params: {
    answerText: string;
  }): Promise<{ ok: boolean; error?: string }> {
    if (!this.state) return { ok: false, error: "Actor not activated" };

    const { tmuxSessionName, sessionId } = this.state;
    const escapedAnswer = params.answerText.replace(/'/g, "'\\''");

    try {
      await sendCommand(tmuxSessionName, escapedAnswer);
      this.state.answerInjected = true;

      await insertActivityLog({
        sessionId,
        eventType: "answer_injected",
        detailsJson: { answer: params.answerText.substring(0, 200) },
      });

      log(`Answer injected into session ${tmuxSessionName}`);
      return { ok: true };
    } catch (err) {
      log(`Failed to inject answer: ${err}`);
      return { ok: false, error: String(err) };
    }
  }

  /**
   * Called when the actor is deactivated (idle timeout or explicit shutdown).
   * Cleans up the tmux session.
   */
  async onDeactivate(): Promise<void> {
    if (!this.state) return;

    const { tmuxSessionName, sessionId } = this.state;

    if (await sessionExists(tmuxSessionName)) {
      await killSession(tmuxSessionName);
    }

    await insertActivityLog({
      sessionId,
      eventType: "actor_deactivated",
      detailsJson: { actorId: this.actorId },
    });

    log(`Actor ${this.actorId} deactivated`);
    this.state = null;
  }

  // -------------------------------------------------------------------------
  // INTERNAL HELPERS
  // -------------------------------------------------------------------------

  /**
   * Provision credentials from auth-service via Dapr service invocation.
   * Returns the bundle ID on success.
   */
  private async provisionCredentials(): Promise<string | undefined> {
    const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/projects/${AUTH_PROJECT_ID}/provision`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ podName: this.actorId }),
    });

    if (!response.ok) {
      throw new Error(`auth-service provision failed: ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as ProvisionResponse;

    if (result.status === "no_credentials") {
      throw new Error(`auth-service has no credentials: ${result.message ?? "no credentials available"}`);
    }

    // Extract bundle to CLAUDE_SESSION_DIR if provisioned
    if (result.status === "provisioned" && result.bundleId) {
      await this.extractBundle(result.bundleId);
    }

    log(`Credentials provisioned — status: ${result.status}, bundle: ${result.bundleId ?? "current"}`);
    return result.bundleId;
  }

  /**
   * Download and extract a credential bundle from auth-service.
   */
  private async extractBundle(bundleId: string): Promise<void> {
    const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/bundles/${bundleId}/extract`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetDir: CLAUDE_SESSION_DIR }),
    });

    if (!response.ok) {
      throw new Error(`Bundle extraction failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Clone or fetch the repo and create a worktree for the given branch.
   */
  private async setupWorktree(
    repoOwner: string,
    repoName: string,
    branch: string,
    worktreeDir: string
  ): Promise<void> {
    const repoBaseDir = join(WORKTREE_BASE_DIR, `${repoOwner}-${repoName}`);
    const bareRepoDir = join(repoBaseDir, "bare.git");

    mkdirSync(repoBaseDir, { recursive: true });

    const repoUrl = `https://github.com/${repoOwner}/${repoName}.git`;

    if (!existsSync(bareRepoDir)) {
      // Clone as bare repo for efficient worktree creation
      log(`Cloning ${repoUrl} as bare repo`);
      const cloneProc = Bun.spawn(
        ["git", "clone", "--bare", repoUrl, bareRepoDir],
        { stdout: "pipe", stderr: "pipe" }
      );
      const exitCode = await cloneProc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(cloneProc.stderr).text();
        throw new Error(`git clone failed: ${stderr.trim()}`);
      }
    } else {
      // Fetch latest from origin
      log(`Fetching latest for ${repoOwner}/${repoName}`);
      const fetchProc = Bun.spawn(
        ["git", "--git-dir", bareRepoDir, "fetch", "--all", "--prune"],
        { stdout: "pipe", stderr: "pipe" }
      );
      await fetchProc.exited;
    }

    // Remove existing worktree if stale
    if (existsSync(worktreeDir)) {
      const rmProc = Bun.spawn(
        ["git", "--git-dir", bareRepoDir, "worktree", "remove", "--force", worktreeDir],
        { stdout: "pipe", stderr: "pipe" }
      );
      await rmProc.exited;
    }

    // Create worktree for the issue branch
    log(`Creating worktree at ${worktreeDir} for branch ${branch}`);
    const wtProc = Bun.spawn(
      ["git", "--git-dir", bareRepoDir, "worktree", "add", worktreeDir, branch],
      { stdout: "pipe", stderr: "pipe" }
    );
    const wtExit = await wtProc.exited;
    if (wtExit !== 0) {
      const stderr = await new Response(wtProc.stderr).text();
      // Branch may not exist yet — create it from main
      if (stderr.includes("invalid reference") || stderr.includes("not a commit")) {
        log(`Branch ${branch} not found, creating from main`);
        const createProc = Bun.spawn(
          ["git", "--git-dir", bareRepoDir, "worktree", "add", "-b", branch, worktreeDir, "origin/main"],
          { stdout: "pipe", stderr: "pipe" }
        );
        const createExit = await createProc.exited;
        if (createExit !== 0) {
          const createStderr = await new Response(createProc.stderr).text();
          throw new Error(`git worktree add (new branch) failed: ${createStderr.trim()}`);
        }
      } else {
        throw new Error(`git worktree add failed: ${stderr.trim()}`);
      }
    }
  }

  /**
   * Handle startup dialogs that may appear when Claude CLI first runs.
   * Uses known-dialog fast path before falling back to tmux pane analysis.
   */
  private async handleStartupDialogs(tmuxSessionName: string): Promise<void> {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let paneText: string;
      try {
        paneText = await capturePane(tmuxSessionName, 30);
      } catch {
        // tmux session may not be fully ready
        await Bun.sleep(500);
        continue;
      }

      if (looksNormal(paneText)) {
        return;
      }

      const knownMatch = matchKnownDialog(paneText);
      if (knownMatch) {
        log(`Dismissing known dialog: ${knownMatch.reason}`);
        for (const key of knownMatch.keys) {
          const proc = Bun.spawn(
            ["tmux", "send-keys", "-t", tmuxSessionName, key],
            { stdout: "pipe", stderr: "pipe" }
          );
          await proc.exited;
          await Bun.sleep(DIALOG_DISMISS_DELAY_MS);
        }
        await Bun.sleep(DIALOG_POST_WAIT_MS);
      } else {
        await Bun.sleep(DIALOG_POST_WAIT_MS);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory actor registry (actor ID → actor instance)
// ---------------------------------------------------------------------------

const actors = new Map<string, ImplementerActor>();

export function getOrCreateActor(actorId: string): ImplementerActor {
  let actor = actors.get(actorId);
  if (!actor) {
    actor = new ImplementerActor(actorId);
    actors.set(actorId, actor);
  }
  return actor;
}

export function getActor(actorId: string): ImplementerActor | undefined {
  return actors.get(actorId);
}

export function removeActor(actorId: string): void {
  actors.delete(actorId);
}
