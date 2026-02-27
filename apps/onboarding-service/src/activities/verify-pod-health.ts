export interface VerifyPodHealthInput {
  repoOwner: string;
  repoName: string;
  timeoutSeconds?: number;
}

export interface VerifyPodHealthResult {
  healthy: boolean;
  podName: string;
  elapsedMs: number;
  error?: string;
}

const POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_SECONDS = 300;

interface PodStatus {
  status?: {
    conditions?: Array<{
      type: string;
      status: string;
    }>;
  };
}

export async function verifyPodHealth(
  input: VerifyPodHealthInput
): Promise<VerifyPodHealthResult> {
  const { repoOwner, repoName, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS } = input;
  const podName = `env-${repoOwner}-${repoName}-0`;
  const namespace = "mesh-six";

  // In-cluster Kubernetes API access
  const token = await Bun.file("/var/run/secrets/kubernetes.io/serviceaccount/token").text();
  const caPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
  const apiBase = "https://kubernetes.default.svc";

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutSeconds * 1000) {
    try {
      const response = await fetch(
        `${apiBase}/api/v1/namespaces/${namespace}/pods/${podName}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          // @ts-ignore — Bun-specific TLS option for custom CA
          tls: { ca: Bun.file(caPath) },
        }
      );

      if (response.ok) {
        const pod = (await response.json()) as PodStatus;
        const ready = pod.status?.conditions?.find(
          (c) => c.type === "Ready" && c.status === "True"
        );
        if (ready) {
          return { healthy: true, podName, elapsedMs: Date.now() - startTime };
        }
      }
    } catch {
      // Pod may not exist yet — continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return {
    healthy: false,
    podName,
    elapsedMs: Date.now() - startTime,
    error: `Pod ${podName} not ready after ${timeoutSeconds}s`,
  };
}
