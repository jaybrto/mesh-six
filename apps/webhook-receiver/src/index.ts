import { Hono } from "hono";
import { DaprClient } from "@dapr/dapr";
import {
  GitHubProjectClient,
  DAPR_PUBSUB_NAME,
  DAPR_STATE_STORE,
  BoardEvent,
  type BoardEventType,
  type DaprSubscription,
  type ProjectItem,
} from "@mesh-six/core";

// --- Configuration ---
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const GITHUB_PROJECT_ID = process.env.GITHUB_PROJECT_ID || "";
const GITHUB_STATUS_FIELD_ID = process.env.GITHUB_STATUS_FIELD_ID || "";
const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const BOARD_EVENTS_TOPIC = "board-events";
const SEEN_ITEMS_KEY = "webhook-receiver:seen-items";
const DEDUP_TTL_MS = 60 * 60 * 1000; // 1 hour

// --- Dapr Client ---
const daprClient = new DaprClient({ daprHost: DAPR_HOST, daprPort: DAPR_HTTP_PORT });

// --- GitHub Client ---
const ghClient = new GitHubProjectClient({
  token: GITHUB_TOKEN,
  projectId: GITHUB_PROJECT_ID,
  statusFieldId: GITHUB_STATUS_FIELD_ID,
});

// --- Webhook dedup (in-memory, keyed by X-GitHub-Delivery) ---
const deliveryDedup = new Map<string, number>();

// Cleanup stale dedup entries every 10 minutes
const dedupCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of deliveryDedup) {
    if (now - ts > DEDUP_TTL_MS) {
      deliveryDedup.delete(id);
    }
  }
}, 10 * 60 * 1000);

// --- HMAC-SHA256 Signature Verification ---
async function verifySignature(payload: string, signature: string): Promise<boolean> {
  if (!GITHUB_WEBHOOK_SECRET) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(GITHUB_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const computed = "sha256=" + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");

  // Constant-time comparison
  if (computed.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

// --- Classify column transitions ---
function classifyTransition(
  action: string,
  fromColumn: string | undefined,
  toColumn: string | undefined,
  item: { id: string; issueNumber: number; issueTitle: string; repoOwner: string; repoName: string; contentNodeId: string },
): BoardEventType | null {
  const base = {
    issueNumber: item.issueNumber,
    repoOwner: item.repoOwner,
    repoName: item.repoName,
    projectItemId: item.id,
    timestamp: new Date().toISOString(),
  };

  // New item added to project (or edited into Todo)
  if (toColumn === "Todo" && (!fromColumn || fromColumn === "")) {
    return {
      ...base,
      type: "new-todo" as const,
      issueTitle: item.issueTitle,
      contentNodeId: item.contentNodeId,
      detectedVia: "webhook" as const,
    };
  }

  // Card moved to Blocked
  if (toColumn === "Blocked" && fromColumn && fromColumn !== "Blocked") {
    return {
      ...base,
      type: "card-blocked" as const,
      fromColumn,
    };
  }

  // Card moved from Blocked
  if (fromColumn === "Blocked" && toColumn && toColumn !== "Blocked") {
    return {
      ...base,
      type: "card-unblocked" as const,
      toColumn,
    };
  }

  // General card move between columns
  if (fromColumn && toColumn && fromColumn !== toColumn) {
    return {
      ...base,
      type: "card-moved" as const,
      fromColumn,
      toColumn,
    };
  }

  return null;
}

// --- Publish a BoardEvent via Dapr ---
async function publishBoardEvent(event: BoardEventType): Promise<void> {
  // Validate against the Zod schema before publishing
  const parsed = BoardEvent.parse(event);
  await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, BOARD_EVENTS_TOPIC, parsed);
  console.log(`[webhook-receiver] Published ${parsed.type} event for issue #${parsed.issueNumber} (item ${parsed.projectItemId})`);
}

// --- Self-move filter: check Dapr state for pending moves ---
async function isSelfMove(projectItemId: string): Promise<boolean> {
  try {
    const result = await daprClient.state.get(DAPR_STATE_STORE, `pending-moves:${projectItemId}`);
    return result !== null && result !== undefined && result !== "";
  } catch {
    return false;
  }
}

// --- HTTP Server (Hono) ---
const app = new Hono();

// Health endpoint
app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    service: "webhook-receiver",
    dedupEntries: deliveryDedup.size,
  }),
);

// Readiness endpoint
app.get("/readyz", (c) => c.json({ status: "ok" }));

// Dapr subscription endpoint - this service only publishes, no subscriptions
app.get("/dapr/subscribe", (c) => {
  const subscriptions: DaprSubscription[] = [];
  return c.json(subscriptions);
});

// --- GitHub Webhook Endpoint ---
app.post("/webhooks/github", async (c) => {
  const rawBody = await c.req.text();

  // 1. HMAC-SHA256 signature validation
  const signature = c.req.header("X-Hub-Signature-256") || "";
  if (!signature) {
    console.warn("[webhook-receiver] Missing X-Hub-Signature-256 header");
    return c.json({ error: "missing signature" }, 401);
  }

  const valid = await verifySignature(rawBody, signature);
  if (!valid) {
    console.warn("[webhook-receiver] Invalid webhook signature");
    return c.json({ error: "invalid signature" }, 401);
  }

  // 2. Dedup by X-GitHub-Delivery
  const deliveryId = c.req.header("X-GitHub-Delivery") || "";
  if (deliveryId) {
    if (deliveryDedup.has(deliveryId)) {
      console.log(`[webhook-receiver] Duplicate delivery ${deliveryId}, skipping`);
      return c.json({ status: "duplicate" }, 200);
    }
    deliveryDedup.set(deliveryId, Date.now());
  }

  // 3. Parse event
  const eventType = c.req.header("X-GitHub-Event") || "";
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  // We only care about projects_v2_item events
  if (eventType !== "projects_v2_item") {
    return c.json({ status: "ignored", reason: `event type: ${eventType}` }, 200);
  }

  const action = payload.action; // created, edited, deleted, etc.
  const projectItemId = payload.projects_v2_item?.node_id || "";
  const contentNodeId = payload.projects_v2_item?.content_node_id || "";

  if (!projectItemId) {
    return c.json({ status: "ignored", reason: "no project item id" }, 200);
  }

  // 4. Self-move filtering
  if (await isSelfMove(projectItemId)) {
    console.log(`[webhook-receiver] Self-move detected for item ${projectItemId}, skipping`);
    return c.json({ status: "self-move" }, 200);
  }

  // 5. Determine column transition from the changes payload
  const changes = payload.changes || {};
  const fromColumn = changes.field_value?.from?.name as string | undefined;
  const toColumn = changes.field_value?.to?.name as string | undefined;

  // For "created" actions on the board, there's no fromColumn
  const effectiveFrom = action === "created" ? undefined : fromColumn;
  const effectiveTo = action === "created" ? "Todo" : toColumn;

  // We need issue info - fetch from GitHub if not in payload
  let issueNumber = payload.projects_v2_item?.content_type === "Issue"
    ? 0 // Will need to look up
    : 0;

  // The projects_v2_item webhook doesn't include full issue data inline,
  // so we'll query the item's current state from the project
  let itemInfo = {
    id: projectItemId,
    issueNumber: 0,
    issueTitle: "",
    repoOwner: "",
    repoName: "",
    contentNodeId: contentNodeId,
  };

  // Try to extract info from the payload content if available
  if (payload.projects_v2_item?.content_type === "Issue") {
    // The webhook payload for projects_v2_item includes limited info.
    // We query GitHub for the full item details.
    try {
      const items = await ghClient.getProjectItemsByColumn(effectiveTo || "");
      const match = items.find((i) => i.id === projectItemId);
      if (match) {
        itemInfo = {
          id: match.id,
          issueNumber: match.issueNumber,
          issueTitle: match.issueTitle,
          repoOwner: match.repoOwner,
          repoName: match.repoName,
          contentNodeId: match.contentNodeId,
        };
      }
    } catch (err) {
      console.warn(`[webhook-receiver] Failed to fetch item details for ${projectItemId}:`, err);
      return c.json({ status: "error", reason: "failed to fetch item details" }, 200);
    }
  }

  if (!itemInfo.issueNumber) {
    console.log(`[webhook-receiver] Could not resolve issue info for item ${projectItemId}`);
    return c.json({ status: "ignored", reason: "no issue info" }, 200);
  }

  // 6. Classify and publish
  const event = classifyTransition(action, effectiveFrom, effectiveTo, itemInfo);
  if (event) {
    try {
      await publishBoardEvent(event);
    } catch (err) {
      console.error(`[webhook-receiver] Failed to publish board event:`, err);
    }
  }

  return c.json({ status: "ok" }, 200);
});

// --- Polling: Query GitHub Projects for Todo items ---
async function pollTodoItems(): Promise<void> {
  try {
    const todoItems = await ghClient.getProjectTodoItems();
    console.log(`[webhook-receiver] Poll found ${todoItems.length} Todo items`);

    // Load seen items from Dapr state
    let seenItems: string[] = [];
    try {
      const stored = await daprClient.state.get(DAPR_STATE_STORE, SEEN_ITEMS_KEY);
      if (Array.isArray(stored)) {
        seenItems = stored as string[];
      }
    } catch {
      // First run or state not available
    }

    const seenSet = new Set(seenItems);
    const newItems: ProjectItem[] = [];

    for (const item of todoItems) {
      if (!seenSet.has(item.id)) {
        newItems.push(item);
        seenSet.add(item.id);
      }
    }

    if (newItems.length > 0) {
      console.log(`[webhook-receiver] Found ${newItems.length} new Todo items via poll`);

      for (const item of newItems) {
        // Check for self-move before publishing
        if (await isSelfMove(item.id)) {
          console.log(`[webhook-receiver] Self-move detected for polled item ${item.id}, skipping`);
          continue;
        }

        const event: BoardEventType = {
          type: "new-todo",
          issueNumber: item.issueNumber,
          issueTitle: item.issueTitle,
          repoOwner: item.repoOwner,
          repoName: item.repoName,
          projectItemId: item.id,
          contentNodeId: item.contentNodeId,
          timestamp: new Date().toISOString(),
          detectedVia: "poll",
        };

        try {
          await publishBoardEvent(event);
        } catch (err) {
          console.error(`[webhook-receiver] Failed to publish poll event for item ${item.id}:`, err);
        }
      }

      // Update seen items in Dapr state
      try {
        // Keep only items that are still in the Todo column to prevent unbounded growth
        const currentIds = new Set(todoItems.map((i) => i.id));
        const prunedSeen = [...seenSet].filter((id) => currentIds.has(id));
        await daprClient.state.save(DAPR_STATE_STORE, [
          { key: SEEN_ITEMS_KEY, value: prunedSeen },
        ]);
      } catch (err) {
        console.error(`[webhook-receiver] Failed to save seen items:`, err);
      }
    }
  } catch (err) {
    console.error(`[webhook-receiver] Poll failed:`, err);
  }
}

// --- Lifecycle ---
let pollInterval: Timer | null = null;

async function start(): Promise<void> {
  // Load column mapping for the GitHub client
  try {
    const mapping = await ghClient.loadColumnMapping();
    console.log(`[webhook-receiver] Loaded column mapping: ${Object.keys(mapping).join(", ")}`);
  } catch (err) {
    console.warn(`[webhook-receiver] Failed to load column mapping (will retry on first use):`, err);
  }

  // Start polling interval
  pollInterval = setInterval(pollTodoItems, POLL_INTERVAL_MS);
  // Run initial poll after a short delay to let Dapr sidecar initialize
  setTimeout(pollTodoItems, 5_000);

  // Start HTTP server
  Bun.serve({ port: APP_PORT, fetch: app.fetch });
  console.log(`[webhook-receiver] Listening on port ${APP_PORT}`);
}

async function shutdown(): Promise<void> {
  console.log(`[webhook-receiver] Shutting down...`);

  if (pollInterval) {
    clearInterval(pollInterval);
  }
  clearInterval(dedupCleanupInterval);

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch((err) => {
  console.error(`[webhook-receiver] Failed to start:`, err);
  process.exit(1);
});
