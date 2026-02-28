/**
 * Dapr external event callbacks.
 *
 * After a scrape completes (or fails), the service raises an external event
 * on the sleeping k3s Dapr Workflow so the ResearchAndPlanSubWorkflow
 * can resume.
 */

import { config } from "./config.js";

/** Current version of the ScrapeCompleted contract */
export const SCRAPE_COMPLETED_CONTRACT_VERSION = 1;

export interface ScrapeCompletedEvent {
  contractVersion: number;
  taskId: string;
  minioResultPath: string;
  success: boolean;
  error?: string;
  completedAt: string;
}

/**
 * Raise the "ScrapeCompleted" external event on the k3s Dapr Workflow.
 *
 * POST http://{dapr}/v1.0-alpha1/workflows/dapr/{workflowName}/{taskId}/raiseEvent/{eventName}
 */
export async function raiseScrapeCompleted(
  taskId: string,
  event: Omit<ScrapeCompletedEvent, "contractVersion" | "taskId" | "completedAt">,
  workflowName = config.DAPR_WORKFLOW_NAME,
  eventName = config.DAPR_SCRAPE_EVENT_NAME,
): Promise<void> {
  const envelope: ScrapeCompletedEvent = {
    ...event,
    contractVersion: SCRAPE_COMPLETED_CONTRACT_VERSION,
    taskId,
    completedAt: new Date().toISOString(),
  };

  const url = `${config.K3S_DAPR_URL}/v1.0-alpha1/workflows/dapr/${workflowName}/${taskId}/raiseEvent/${eventName}`;

  console.log(`[dapr] Raising ${eventName} on workflow ${taskId}`);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
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
