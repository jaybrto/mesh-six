export interface VerifyPodHealthInput {
  repoOwner: string;
  repoName: string;
  timeoutMs?: number;
}

export interface VerifyPodHealthResult {
  podName: string;
  readyAfterMs: number;
}

const POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 300_000;

interface KubectlPodStatus {
  status?: {
    phase?: string;
    conditions?: Array<{
      type: string;
      status: string;
    }>;
  };
}

function isPodReady(podJson: KubectlPodStatus): boolean {
  if (podJson.status?.phase !== "Running") {
    return false;
  }
  const conditions = podJson.status?.conditions ?? [];
  return conditions.some(
    (c) => c.type === "Ready" && c.status === "True"
  );
}

export async function verifyPodHealth(
  input: VerifyPodHealthInput
): Promise<VerifyPodHealthResult> {
  const { repoOwner, repoName, timeoutMs = DEFAULT_TIMEOUT_MS } = input;
  const podName = `env-${repoOwner}-${repoName}-0`;
  const namespace = "mesh-six";

  const startMs = Date.now();

  while (true) {
    const elapsed = Date.now() - startMs;
    if (elapsed >= timeoutMs) {
      throw new Error(
        `Pod ${podName} did not become ready within ${timeoutMs}ms`
      );
    }

    const result = Bun.spawnSync([
      "kubectl",
      "get",
      "pod",
      podName,
      "-n",
      namespace,
      "-o",
      "json",
    ]);

    if (result.exitCode === 0) {
      const raw = new TextDecoder().decode(result.stdout);
      try {
        const podJson = JSON.parse(raw) as KubectlPodStatus;
        if (isPodReady(podJson)) {
          return { podName, readyAfterMs: Date.now() - startMs };
        }
      } catch {
        // JSON parse failed — pod may still be starting
      }
    }

    // Wait before next poll (but respect remaining timeout)
    const remaining = timeoutMs - (Date.now() - startMs);
    if (remaining <= 0) {
      throw new Error(
        `Pod ${podName} did not become ready within ${timeoutMs}ms`
      );
    }
    await Bun.sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}
