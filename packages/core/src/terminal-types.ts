import { z } from "zod";

// Topic constants
export const TERMINAL_STREAM_TOPIC_PREFIX = "terminal/stream";
export const TERMINAL_SNAPSHOT_TOPIC_PREFIX = "terminal/snapshot";

// Snapshot event types
export const SNAPSHOT_EVENT_TYPES = [
  "session_start",
  "session_blocked",
  "answer_injected",
  "session_completed",
  "session_failed",
  "checkpoint",
] as const;

export type SnapshotEventType = (typeof SNAPSHOT_EVENT_TYPES)[number];

// Terminal snapshot stored in PostgreSQL
export const TerminalSnapshotSchema = z.object({
  id: z.number().optional(),
  sessionId: z.string(),
  ansiContent: z.string(),
  eventType: z.string(),
  capturedAt: z.coerce.date(),
});
export type TerminalSnapshot = z.infer<typeof TerminalSnapshotSchema>;

// Recording metadata stored in PostgreSQL
export const RecordingMetadataSchema = z.object({
  id: z.number().optional(),
  sessionId: z.string(),
  s3Key: z.string(),
  durationMs: z.number(),
  sizeBytes: z.number(),
  format: z.string().default("asciicast-v2"),
  uploadedAt: z.coerce.date(),
});
export type RecordingMetadata = z.infer<typeof RecordingMetadataSchema>;

// MQTT stream chunk published to terminal/stream/{sessionId}
export const TerminalStreamChunkSchema = z.object({
  sessionId: z.string(),
  data: z.string(),
  timestamp: z.number(),
});
export type TerminalStreamChunk = z.infer<typeof TerminalStreamChunkSchema>;
