import { AUTH_SERVICE_APP_ID } from "@mesh-six/core";

const AUTH_PROJECT_ID = process.env.AUTH_PROJECT_ID || process.env.GWA_PROJECT_ID || "mesh-six";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

export function isAuthServiceConfigured(): boolean {
  return Boolean(AUTH_PROJECT_ID);
}

export interface AuthProvisionResult {
  status: "current" | "provisioned" | "no_credentials";
  bundleId?: string;
  credentialExpiresAt?: string;
}

export async function provisionFromAuthService(
  podName: string,
  currentBundleId?: string,
): Promise<AuthProvisionResult | null> {
  try {
    const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/projects/${AUTH_PROJECT_ID}/provision`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ podName, currentBundleId }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return (await res.json()) as AuthProvisionResult;
  } catch {
    return null;
  }
}

export async function downloadBundle(bundleId: string): Promise<Buffer | null> {
  try {
    const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/projects/${AUTH_PROJECT_ID}/provision/${bundleId}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export async function checkAuthServiceHealth(): Promise<{ hasValidCredential: boolean; expiresInMs?: number } | null> {
  try {
    const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/projects/${AUTH_PROJECT_ID}/health`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as { hasValidCredential: boolean; expiresInMs?: number };
  } catch {
    return null;
  }
}
