import { z } from "zod";

// ---------------------------------------------------------------------------
// Mac Mini Scraper Service types
// ---------------------------------------------------------------------------

/** Target UI provider for the scraper to drive */
export const ScrapeProviderSchema = z.enum(["windsurf", "claude"]);
export type ScrapeProvider = z.infer<typeof ScrapeProviderSchema>;

/** Status of a scrape job tracked via MinIO status.json claim check */
export const ScrapeStatusSchema = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
]);
export type ScrapeStatus = z.infer<typeof ScrapeStatusSchema>;

/** Payload dispatched from k3s ResearcherActor → Mac mini scraper-service */
export const ScrapeDispatchPayloadSchema = z.object({
  taskId: z.string().uuid(),
  actorId: z.string(),
  targetProvider: ScrapeProviderSchema,
  prompt: z.string().min(1),
  minioFolderPath: z.string().min(1),
});
export type ScrapeDispatchPayload = z.infer<typeof ScrapeDispatchPayloadSchema>;

/** The status.json file stored in MinIO for claim-check tracking */
export const ScrapeStatusFileSchema = z.object({
  taskId: z.string().uuid(),
  status: ScrapeStatusSchema,
  provider: ScrapeProviderSchema.optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});
export type ScrapeStatusFile = z.infer<typeof ScrapeStatusFileSchema>;

/** Response from the /scrape endpoint (fast-ACK) */
export const ScrapeAckResponseSchema = z.object({
  status: z.enum(["STARTED", "REJECTED"]),
  taskId: z.string().uuid(),
  message: z.string().optional(),
});
export type ScrapeAckResponse = z.infer<typeof ScrapeAckResponseSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dapr app-id of the scraper service */
export const SCRAPER_SERVICE_APP_ID = "scraper-service";

/** MinIO bucket for research artifacts */
export const SCRAPER_MINIO_BUCKET = "mesh-six-research";

/** Default base path pattern in MinIO */
export const SCRAPER_MINIO_PREFIX = "research";
