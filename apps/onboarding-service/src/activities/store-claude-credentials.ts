import { AUTH_SERVICE_APP_ID } from "@mesh-six/core";
import { DAPR_HOST, DAPR_HTTP_PORT } from "../config.js";

export interface StoreClaudeCredentialsInput {
  projectId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export async function storeClaudeCredentials(
  input: StoreClaudeCredentialsInput
): Promise<void> {
  const { projectId, accessToken, refreshToken, expiresAt } = input;

  const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/projects/${projectId}/credentials`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accessToken,
      refreshToken,
      expiresAt,
      source: "onboarding-oauth",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to store Claude credentials for project ${projectId}: ${response.status} ${body}`
    );
  }
}
