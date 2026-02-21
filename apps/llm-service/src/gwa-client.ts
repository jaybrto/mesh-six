import {
  GWA_ORCHESTRATOR_URL,
  GWA_API_KEY,
  GWA_PROJECT_ID,
  AGENT_ID,
} from "./config.js";

const log = (msg: string) => console.log(`[${AGENT_ID}][gwa] ${msg}`);

// ============================================================================
// TYPES
// ============================================================================

export interface GWAProvisionResult {
  status: "current" | "provisioned" | "no_credentials";
  bundleId?: string;
  s3Key?: string;
  s3Bucket?: string;
  credentialExpiresAt?: number;
  message?: string;
}

export interface GWACredentialHealth {
  projectId: string;
  hasValidCredential: boolean;
  expiresAt?: number;
  expiresInMs?: number;
  hasRefreshToken: boolean;
  lastRefreshAt?: number;
  activeBundleId?: string;
}

// ============================================================================
// CLIENT
// ============================================================================

/** Returns true if GWA orchestrator env vars are configured */
export function isGWAConfigured(): boolean {
  return GWA_ORCHESTRATOR_URL !== "" && GWA_API_KEY !== "";
}

/**
 * Request a credential bundle from the GWA orchestrator.
 * Returns null on any failure (timeout, network error, bad response).
 */
export async function provisionFromGWA(
  podName: string,
  currentBundleId?: string,
): Promise<GWAProvisionResult | null> {
  if (!isGWAConfigured()) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(
      `${GWA_ORCHESTRATOR_URL}/projects/${GWA_PROJECT_ID}/provision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GWA_API_KEY}`,
        },
        body: JSON.stringify({
          podName,
          ...(currentBundleId && { currentBundleId }),
        }),
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    if (!response.ok) {
      log(`GWA provision failed: ${response.status} ${response.statusText}`);
      return null;
    }

    const result = (await response.json()) as GWAProvisionResult;
    log(`GWA provision for ${podName}: ${result.status} (bundle: ${result.bundleId || "none"})`);
    return result;
  } catch (err) {
    log(`GWA provision error: ${err}`);
    return null;
  }
}

/**
 * Check credential health from the GWA orchestrator.
 * Returns null on any failure.
 */
export async function checkGWAHealth(): Promise<GWACredentialHealth | null> {
  if (!isGWAConfigured()) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(
      `${GWA_ORCHESTRATOR_URL}/projects/${GWA_PROJECT_ID}/health`,
      {
        headers: {
          Authorization: `Bearer ${GWA_API_KEY}`,
        },
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    if (!response.ok) return null;

    return (await response.json()) as GWACredentialHealth;
  } catch (err) {
    log(`GWA health check error: ${err}`);
    return null;
  }
}
