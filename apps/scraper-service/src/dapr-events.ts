/**
 * Dapr external event callbacks.
 *
 * After a scrape completes (or fails), the service raises an external event
 * on the sleeping k3s Dapr Workflow so the ResearchAndPlanSubWorkflow
 * can resume.
 */

import { config } from "./config.js";

export interface ScrapeCompletedEvent {
  minioResultPath: string;
  success: boolean;
  error?: string;
}

/**
 * Raise the "ScrapeCompleted" external event on the k3s Dapr Workflow.
 *
 * POST http://{dapr}/v1.0-alpha1/workflows/dapr/{workflowName}/{taskId}/raiseEvent/{eventName}
 */
export async function raiseScrapeCompleted(
  taskId: string,
  event: ScrapeCompletedEvent,
  workflowName = "FeatureWorkflow",
  eventName = "ScrapeCompleted",
): Promise<void> {
  const url = `${config.K3S_DAPR_URL}/v1.0-alpha1/workflows/dapr/${workflowName}/${taskId}/raiseEvent/${eventName}`;

  console.log(`[dapr] Raising ${eventName} on workflow ${taskId}`);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(
      `[dapr] Failed to raise event: ${response.status} ${response.statusText} — ${body}`,
    );
    throw new Error(
      `Dapr raiseEvent failed: ${response.status} ${response.statusText}`,
    );
  }

  console.log(`[dapr] Successfully raised ${eventName} for ${taskId}`);
}
