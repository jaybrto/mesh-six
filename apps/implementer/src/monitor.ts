/**
 * Session monitor — periodically captures tmux pane output and detects:
 * - Auth failures → re-provision from auth-service
 * - Questions → insert into session_questions, publish session-blocked event
 * - Completion → update session status, publish task result
 * - MQTT events → real-time dashboard updates
 */
import { DaprClient } from "@dapr/dapr";
import pg from "pg";
import {
  DAPR_PUBSUB_NAME,
  TASK_RESULTS_TOPIC,
  AUTH_SERVICE_APP_ID,
  detectAuthFailure,
  type TaskResult,
} from "@mesh-six/core";
import { DAPR_HOST, DAPR_HTTP_PORT, AUTH_PROJECT_ID, AGENT_ID } from "./config.js";
import { capturePane } from "./tmux.js";
import {
  updateSessionStatus,
  insertActivityLog,
  insertQuestion,
  updateClaudeSessionId,
} from "./session-db.js";
import type { ActorState } from "./actor.js";
import { takeSnapshot } from "./terminal-relay.js";

const log = (msg: string) => console.log(`[${AGENT_ID}][monitor] ${msg}`);

const MONITOR_INTERVAL_MS = 5_000;

// Question detection pattern — matches lines ending with "?" that look like
// Claude asking for clarification.
const QUESTION_PATTERN = /(?:^|\n)(?:Claude|Assistant)?:?\s*([^.!]+\?\s*)$/im;

// Claude CLI session ID patterns emitted at startup or resume.
// Examples: "Session: abc-def-123", "Resuming session abc-def-123",
//           "claude --resume abc-def-123"
const CLAUDE_SESSION_ID_PATTERNS = [
  /(?:^|\n)Session:\s*([a-zA-Z0-9_-]{8,})/m,
  /Resuming session\s+([a-zA-Z0-9_-]{8,})/im,
  /--resume\s+([a-zA-Z0-9_-]{8,})/im,
];

// Completion detection — Claude CLI exits and prints a summary line.
const COMPLETION_PATTERNS = [
  /Task completed successfully/i,
  /I've completed the implementation/i,
  /The implementation is complete/i,
  /All changes have been made/i,
  /\$ $/, // Shell prompt returned — process exited
];

// ---------------------------------------------------------------------------
// SessionMonitor
// ---------------------------------------------------------------------------

export interface MonitorContext {
  sessionId: string;
  taskId: string;
  actorState: ActorState;
  daprClient: DaprClient;
  pool: pg.Pool;
  onComplete: (result: TaskResult) => void;
}

export class SessionMonitor {
  private timer: Timer | null = null;
  private ctx: MonitorContext;
  private lastCaptureHash = "";
  private questionDetected = false;
  private claudeSessionIdCaptured = false;

  constructor(ctx: MonitorContext) {
    this.ctx = ctx;
  }

  start(): void {
    if (this.timer) return;
    log(`Starting monitor for session ${this.ctx.sessionId}`);
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        log(`Monitor tick error: ${err}`);
      });
    }, MONITOR_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log(`Stopped monitor for session ${this.ctx.sessionId}`);
    }
  }

  private async tick(): Promise<void> {
    const { actorState, sessionId, taskId, daprClient } = this.ctx;
    const { tmuxSessionName } = actorState;

    let paneText: string;
    try {
      paneText = await capturePane(tmuxSessionName, 100);
    } catch (err) {
      // Session may have ended
      log(`capturePane failed for ${tmuxSessionName}: ${err}`);
      await this.handleCompletion(false, `tmux session unavailable: ${err}`);
      return;
    }

    // Skip if output unchanged
    const hash = simpleHash(paneText);
    if (hash === this.lastCaptureHash) return;
    this.lastCaptureHash = hash;

    // --- Claude session ID capture ---
    if (!this.claudeSessionIdCaptured) {
      for (const pattern of CLAUDE_SESSION_ID_PATTERNS) {
        const match = pattern.exec(paneText);
        if (match) {
          const claudeSessionId = match[1];
          this.claudeSessionIdCaptured = true;
          log(`Captured claude_session_id for session ${sessionId}: ${claudeSessionId}`);
          await updateClaudeSessionId(sessionId, claudeSessionId).catch((err) =>
            log(`Failed to persist claude_session_id: ${err}`)
          );
          await insertActivityLog({
            sessionId,
            eventType: "claude_session_id_captured",
            detailsJson: { claudeSessionId },
          }).catch(() => {});
          break;
        }
      }
    }

    // --- Auth failure detection ---
    if (detectAuthFailure(paneText)) {
      log(`Auth failure detected in session ${sessionId}, re-provisioning`);
      await insertActivityLog({
        sessionId,
        eventType: "auth_failure_detected",
        detailsJson: { paneSnippet: paneText.slice(-500) },
      });

      const ok = await this.reprovisionsCredentials();
      if (!ok) {
        await this.handleCompletion(false, "Authentication failed and re-provision failed");
      }
      return;
    }

    // --- Completion detection ---
    for (const pattern of COMPLETION_PATTERNS) {
      if (pattern.test(paneText)) {
        log(`Completion detected in session ${sessionId}`);
        await this.handleCompletion(true);
        return;
      }
    }

    // --- Question detection ---
    if (!this.questionDetected) {
      // Check if a previous answer was injected — reset if so
      if (actorState.answerInjected) {
        actorState.answerInjected = false;
      }

      const questionMatch = QUESTION_PATTERN.exec(paneText);
      if (questionMatch) {
        const questionText = questionMatch[1].trim();
        log(`Question detected in session ${sessionId}: ${questionText}`);
        this.questionDetected = true;

        await updateSessionStatus(sessionId, "blocked");
        const question = await insertQuestion({ sessionId, questionText });

        await insertActivityLog({
          sessionId,
          eventType: "question_detected",
          detailsJson: { questionId: question.id, questionText },
        });

        // Fire-and-forget terminal snapshot
        await takeSnapshot(sessionId, tmuxSessionName, "session_blocked", this.ctx.pool, daprClient).catch(() => {});

        // Raise event on workflow instance via Dapr HTTP API
        const { workflowId } = actorState;
        if (workflowId) {
          const eventChannel = this.getEventChannel();
          const eventUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0-alpha1/workflows/dapr/${workflowId}/raiseEvent/${eventChannel}`;
          await fetch(eventUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "question-detected",
              questionText,
              sessionId,
            }),
          }).catch((err) => log(`Failed to raise event on workflow ${workflowId}: ${err}`));

          log(`Raised ${eventChannel} event on workflow ${workflowId}`);
        } else {
          log(`No workflowId — falling back to pub/sub for session ${sessionId}`);
          await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, "session-blocked", {
            sessionId,
            taskId,
            questionId: question.id,
            questionText,
            issueNumber: actorState.issueNumber,
            repoOwner: actorState.repoOwner,
            repoName: actorState.repoName,
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }
    } else if (actorState.answerInjected) {
      // Answer was injected, reset question detection for next question
      this.questionDetected = false;
      actorState.answerInjected = false;
      await updateSessionStatus(sessionId, "running");
      log(`Question detection reset after answer injection for session ${sessionId}`);
    }

    // Publish MQTT event for dashboard progress
    await this.publishMqttEvent("session_progress", {
      sessionId,
      paneSnippet: paneText.slice(-200),
    }).catch(() => {});
  }

  /**
   * Determine the event channel name based on what kind of session this is.
   * The PM workflow listens on different channels per phase.
   */
  private getEventChannel(): string {
    // Default to planning-event. Can be extended to support impl-event/qa-event
    // based on additional context if a "phase" field is added to MonitorContext.
    return "planning-event";
  }

  private async handleCompletion(success: boolean, errorMessage?: string): Promise<void> {
    this.stop();

    const { sessionId, taskId, daprClient } = this.ctx;
    const completedAt = new Date().toISOString();

    await updateSessionStatus(sessionId, success ? "completed" : "failed", {
      completedAt,
    });

    await insertActivityLog({
      sessionId,
      eventType: success ? "session_completed" : "session_failed",
      detailsJson: errorMessage ? { error: errorMessage } : undefined,
    });

    // Fire-and-forget terminal snapshot
    const snapshotEvent = success ? "session_completed" : "session_failed";
    await takeSnapshot(
      sessionId,
      this.ctx.actorState.tmuxSessionName,
      snapshotEvent,
      this.ctx.pool,
      daprClient
    ).catch(() => {});

    // Raise completion/failure event on workflow
    const { workflowId } = this.ctx.actorState;
    if (workflowId) {
      const eventChannel = this.getEventChannel();
      const eventUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0-alpha1/workflows/dapr/${workflowId}/raiseEvent/${eventChannel}`;
      await fetch(eventUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          success
            ? { type: "plan-complete", planContent: "" }
            : { type: "session-failed", error: errorMessage || "Session failed" }
        ),
      }).catch((err) => log(`Failed to raise completion event: ${err}`));
    }

    const result: TaskResult = {
      taskId,
      agentId: AGENT_ID,
      success,
      result: success ? { sessionId } : undefined,
      error: success ? undefined : { type: "session_failed", message: errorMessage ?? "Session failed" },
      durationMs: this.ctx.actorState.startedAt
        ? Date.now() - new Date(this.ctx.actorState.startedAt).getTime()
        : 0,
      completedAt,
    };

    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, result);
    log(`Published task result for ${taskId}: success=${success}`);

    await this.publishMqttEvent(success ? "session_completed" : "session_failed", {
      sessionId,
      taskId,
    }).catch(() => {});

    this.ctx.onComplete(result);
  }

  private async reprovisionsCredentials(): Promise<boolean> {
    try {
      const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/projects/${AUTH_PROJECT_ID}/provision`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ podName: AGENT_ID }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async publishMqttEvent(event: string, data: Record<string, unknown>): Promise<void> {
    await this.ctx.daprClient.pubsub.publish(DAPR_PUBSUB_NAME, "mqtt-events", {
      source: AGENT_ID,
      event,
      data,
      timestamp: new Date().toISOString(),
    });
  }
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}
