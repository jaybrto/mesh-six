/**
 * Terminal Relay — Live Streaming, Snapshots & Recordings
 *
 * Provides real-time terminal output streaming via Dapr pub/sub (MQTT),
 * asciicast v2 recording, snapshot capture, and MinIO upload.
 *
 * Adapted from GWA terminal-relay: replaces WebSocket with Dapr pubsub,
 * SQLite with PostgreSQL, and stores raw ANSI text instead of SVG.
 */

import { mkdirSync, existsSync, unlinkSync, writeFileSync, appendFileSync, readFileSync } from "fs";
import { DaprClient } from "@dapr/dapr";
import pg from "pg";
import {
  DAPR_PUBSUB_NAME,
  TERMINAL_STREAM_TOPIC_PREFIX,
  TERMINAL_SNAPSHOT_TOPIC_PREFIX,
  createMinioClient,
  uploadToMinio,
  type TerminalSnapshot,
  type RecordingMetadata,
} from "@mesh-six/core";
import { capturePane } from "./tmux.js";
import {
  insertSnapshot,
  insertRecording,
  updateStreamingActive,
} from "./session-db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STREAMS_DIR = "/tmp/mesh-six-streams";
const RECORDINGS_DIR = "/tmp/mesh-six-recordings";

// Batch settings: flush after 100ms or 4KB, whichever comes first
const BATCH_INTERVAL_MS = 100;
const BATCH_SIZE_BYTES = 4 * 1024;

const log = (msg: string) => console.log(`[implementer][terminal-relay] ${msg}`);

// ---------------------------------------------------------------------------
// State tracking
// ---------------------------------------------------------------------------

interface StreamState {
  sessionId: string;
  tmuxTarget: string;
  fifoPath: string;
  recordingPath: string;
  readerProc: ReturnType<typeof Bun.spawn> | null;
  startedAt: number;
  batchBuffer: string;
  batchTimer: Timer | null;
}

const activeStreams = new Map<string, StreamState>();

// ---------------------------------------------------------------------------
// Asciicast v2 helpers
// ---------------------------------------------------------------------------

function writeAsciicastHeader(path: string, width = 200, height = 50): void {
  const header = JSON.stringify({
    version: 2,
    width,
    height,
    timestamp: Math.floor(Date.now() / 1000),
    env: { TERM: "xterm-256color", SHELL: "/bin/bash" },
  });
  writeFileSync(path, header + "\n");
}

function appendAsciicastEvent(path: string, startedAt: number, data: string): void {
  const elapsed = (Date.now() - startedAt) / 1000;
  const event = JSON.stringify([elapsed, "o", data]);
  appendFileSync(path, event + "\n");
}

// ---------------------------------------------------------------------------
// Batching helpers
// ---------------------------------------------------------------------------

async function flushBatch(
  state: StreamState,
  daprClient: DaprClient
): Promise<void> {
  if (!state.batchBuffer) return;

  const text = state.batchBuffer;
  state.batchBuffer = "";

  if (state.batchTimer) {
    clearTimeout(state.batchTimer);
    state.batchTimer = null;
  }

  // Append to asciicast recording
  appendAsciicastEvent(state.recordingPath, state.startedAt, text);

  // Publish to Dapr pub/sub
  await daprClient.pubsub
    .publish(DAPR_PUBSUB_NAME, `${TERMINAL_STREAM_TOPIC_PREFIX}/${state.sessionId}`, {
      sessionId: state.sessionId,
      data: text,
      timestamp: Date.now(),
    })
    .catch((err) => log(`Failed to publish stream chunk for ${state.sessionId}: ${err}`));
}

// ---------------------------------------------------------------------------
// Core streaming functions
// ---------------------------------------------------------------------------

/**
 * Start streaming pane output for a session.
 *
 * Creates a named pipe, attaches tmux pipe-pane to it, and spawns a reader
 * that batches chunks and publishes to Dapr pub/sub and an asciicast recording.
 */
export async function startPaneStream(
  sessionId: string,
  tmuxTarget: string,
  daprClient: DaprClient,
  pool: pg.Pool
): Promise<void> {
  if (activeStreams.has(sessionId)) {
    log(`Stream already active for session ${sessionId}, skipping`);
    return;
  }

  mkdirSync(STREAMS_DIR, { recursive: true });
  mkdirSync(RECORDINGS_DIR, { recursive: true });

  const fifoPath = `${STREAMS_DIR}/${sessionId}.fifo`;
  const recordingPath = `${RECORDINGS_DIR}/${sessionId}.cast`;

  // Create FIFO (remove stale one first)
  if (existsSync(fifoPath)) {
    unlinkSync(fifoPath);
  }
  const mkfifoProc = Bun.spawn(["mkfifo", fifoPath], { stdout: "pipe", stderr: "pipe" });
  const mkfifoExit = await mkfifoProc.exited;
  if (mkfifoExit !== 0) {
    const stderr = await new Response(mkfifoProc.stderr).text();
    throw new Error(`mkfifo failed: ${stderr}`);
  }

  // Initialize asciicast recording
  writeAsciicastHeader(recordingPath);

  const startedAt = Date.now();

  // Attach tmux pipe-pane to push output to the FIFO
  const pipePaneProc = Bun.spawn(
    ["tmux", "pipe-pane", "-t", tmuxTarget, `cat > ${fifoPath}`],
    { stdout: "pipe", stderr: "pipe" }
  );
  const pipePaneExit = await pipePaneProc.exited;
  if (pipePaneExit !== 0) {
    const stderr = await new Response(pipePaneProc.stderr).text();
    throw new Error(`tmux pipe-pane failed: ${stderr}`);
  }

  // Spawn reader process that reads from the FIFO
  const readerProc = Bun.spawn(["cat", fifoPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const state: StreamState = {
    sessionId,
    tmuxTarget,
    fifoPath,
    recordingPath,
    readerProc,
    startedAt,
    batchBuffer: "",
    batchTimer: null,
  };

  activeStreams.set(sessionId, state);

  // Update DB: streaming_active = true
  await updateStreamingActive(sessionId, true).catch((err) =>
    log(`Failed to mark streaming_active=true for ${sessionId}: ${err}`)
  );

  // Read chunks in background, batch and publish
  (async () => {
    const reader = readerProc.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const current = activeStreams.get(sessionId);
        if (!current) break;

        const text = decoder.decode(value, { stream: true });
        current.batchBuffer += text;

        // Flush immediately if batch is large enough
        if (current.batchBuffer.length >= BATCH_SIZE_BYTES) {
          await flushBatch(current, daprClient);
        } else if (!current.batchTimer) {
          // Schedule a flush
          current.batchTimer = setTimeout(async () => {
            const s = activeStreams.get(sessionId);
            if (s) {
              await flushBatch(s, daprClient).catch((err) =>
                log(`Batch flush error for ${sessionId}: ${err}`)
              );
            }
          }, BATCH_INTERVAL_MS);
        }
      }
    } catch {
      // Stream closed — expected on stopPaneStream
    }

    // Flush any remaining data when stream ends
    const s = activeStreams.get(sessionId);
    if (s && s.batchBuffer) {
      await flushBatch(s, daprClient).catch(() => {});
    }
  })();

  log(`Pane stream started for session ${sessionId} (target: ${tmuxTarget})`);
}

/**
 * Stop streaming pane output for a session.
 *
 * Detaches pipe-pane, flushes remaining buffer, uploads recording to MinIO,
 * and cleans up local files.
 */
export async function stopPaneStream(
  sessionId: string,
  pool: pg.Pool
): Promise<RecordingMetadata | null> {
  const state = activeStreams.get(sessionId);
  if (!state) {
    return null;
  }

  // Detach tmux pipe-pane (no argument = detach)
  try {
    const detachProc = Bun.spawn(
      ["tmux", "pipe-pane", "-t", state.tmuxTarget],
      { stdout: "pipe", stderr: "pipe" }
    );
    await detachProc.exited;
  } catch {
    // Pane may already be gone
  }

  // Kill reader process
  if (state.readerProc) {
    try {
      state.readerProc.kill();
    } catch {
      // Already exited
    }
  }

  // Flush remaining batch buffer
  if (state.batchTimer) {
    clearTimeout(state.batchTimer);
    state.batchTimer = null;
  }
  if (state.batchBuffer) {
    appendAsciicastEvent(state.recordingPath, state.startedAt, state.batchBuffer);
    state.batchBuffer = "";
  }

  // Remove FIFO
  if (existsSync(state.fifoPath)) {
    try {
      unlinkSync(state.fifoPath);
    } catch {
      // Ignore
    }
  }

  activeStreams.delete(sessionId);

  // Update DB: streaming_active = false
  await updateStreamingActive(sessionId, false).catch((err) =>
    log(`Failed to mark streaming_active=false for ${sessionId}: ${err}`)
  );

  // Upload recording to MinIO and insert metadata
  let metadata: RecordingMetadata | null = null;
  if (existsSync(state.recordingPath)) {
    try {
      metadata = await uploadRecording(sessionId, state.recordingPath, state.startedAt, pool);
    } catch (err) {
      log(`Failed to upload recording for ${sessionId}: ${err}`);
    }

    // Clean up local recording file
    try {
      unlinkSync(state.recordingPath);
    } catch {
      // Ignore
    }
  }

  log(`Pane stream stopped for session ${sessionId}`);
  return metadata;
}

/**
 * Capture a terminal snapshot and store in PostgreSQL.
 * Uses capturePane (ANSI-preserved) from tmux.ts.
 */
export async function takeSnapshot(
  sessionId: string,
  tmuxTarget: string,
  eventType: string,
  pool: pg.Pool,
  daprClient: DaprClient
): Promise<TerminalSnapshot> {
  const ansiContent = await capturePane(tmuxTarget, 200);
  const capturedAt = new Date();

  // Insert into terminal_snapshots table
  const row = await insertSnapshot({ sessionId, ansiContent, eventType });

  // Publish snapshot to MQTT via Dapr pub/sub
  await daprClient.pubsub
    .publish(DAPR_PUBSUB_NAME, `${TERMINAL_SNAPSHOT_TOPIC_PREFIX}/${sessionId}`, {
      sessionId,
      ansiContent,
      eventType,
      capturedAt: capturedAt.getTime(),
    })
    .catch((err) => log(`Failed to publish snapshot for ${sessionId}: ${err}`));

  log(`Snapshot captured for session ${sessionId} (event: ${eventType})`);

  return {
    id: row.id,
    sessionId,
    ansiContent,
    eventType,
    capturedAt,
  };
}

/**
 * Check whether a stream is active for a session.
 */
export function isStreamActive(sessionId: string): boolean {
  return activeStreams.has(sessionId);
}

/**
 * Stop all active streams gracefully. Called on SIGTERM.
 */
export async function shutdownAllStreams(pool: pg.Pool): Promise<void> {
  const sessions = Array.from(activeStreams.keys());
  for (const sessionId of sessions) {
    await stopPaneStream(sessionId, pool).catch((err) =>
      log(`Failed to stop stream for ${sessionId} during shutdown: ${err}`)
    );
  }
  log(`Shutdown complete — stopped ${sessions.length} stream(s)`);
}

// ---------------------------------------------------------------------------
// MinIO upload
// ---------------------------------------------------------------------------

async function uploadRecording(
  sessionId: string,
  localPath: string,
  startedAt: number,
  pool: pg.Pool
): Promise<RecordingMetadata> {
  const fileData = readFileSync(localPath);
  const timestamp = Math.floor(Date.now() / 1000);
  const s3Key = `recordings/${sessionId}/${timestamp}.cast`;
  const durationMs = Date.now() - startedAt;
  const sizeBytes = fileData.length;

  const minioEndpoint = process.env.MINIO_ENDPOINT || "http://minio.default.svc.cluster.local:9000";
  const minioAccessKey = process.env.MINIO_ACCESS_KEY || "";
  const minioSecretKey = process.env.MINIO_SECRET_KEY || "";
  const minioBucket = process.env.MINIO_BUCKET || "mesh-six-recordings";

  const client = createMinioClient({
    endpoint: minioEndpoint,
    accessKeyId: minioAccessKey,
    secretAccessKey: minioSecretKey,
    bucket: minioBucket,
  });

  await uploadToMinio(client, minioBucket, s3Key, fileData, "application/x-asciicast");

  // Insert recording metadata into DB
  const row = await insertRecording({
    sessionId,
    s3Key,
    durationMs,
    sizeBytes,
    format: "asciicast-v2",
  });

  const metadata: RecordingMetadata = {
    id: row.id,
    sessionId,
    s3Key,
    durationMs,
    sizeBytes,
    format: "asciicast-v2",
    uploadedAt: new Date(),
  };

  log(`Recording uploaded for ${sessionId}: ${s3Key} (${sizeBytes} bytes)`);
  return metadata;
}
