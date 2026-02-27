import { AUTH_SERVICE_APP_ID } from "@mesh-six/core";
import { DAPR_HOST, DAPR_HTTP_PORT } from "../config.js";

export interface AppSettings {
  cloudflareDomain?: string;
  terminalStreamingRate?: number;
}

export interface ConfigureAppSettingsInput {
  projectId: string;
  settings: AppSettings;
}

export async function configureAppSettings(
  input: ConfigureAppSettingsInput
): Promise<void> {
  const { projectId, settings } = input;

  const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/projects/${projectId}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settingsJson: JSON.stringify(settings) }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to configure app settings for project ${projectId}: ${response.status} ${body}`
    );
  }
}
