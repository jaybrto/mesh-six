import { Octokit } from "@octokit/rest";
import type { ResourceLimits } from "../schemas.js";
import { GITHUB_TOKEN, MESH_SIX_REPO_OWNER, MESH_SIX_REPO_NAME } from "../config.js";

export interface GenerateKubeManifestsInput {
  repoOwner: string;
  repoName: string;
  resourceLimits?: ResourceLimits;
}

export interface GenerateKubeManifestsResult {
  dir: string;
}

const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  memoryRequest: "2Gi",
  memoryLimit: "8Gi",
  cpuRequest: "1",
  cpuLimit: "4",
  storageWorktrees: "20Gi",
  storageClaude: "1Gi",
};

function buildStatefulSetYaml(
  owner: string,
  repo: string,
  limits: ResourceLimits
): string {
  const appId = `env-${owner}-${repo}`;
  return `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${appId}
  namespace: mesh-six
  labels:
    app: ${appId}
    app.kubernetes.io/part-of: mesh-six
spec:
  serviceName: ${appId}
  replicas: 1
  selector:
    matchLabels:
      app: ${appId}
  template:
    metadata:
      labels:
        app: ${appId}
      annotations:
        dapr.io/enabled: "true"
        dapr.io/app-id: "${appId}"
        dapr.io/app-port: "3000"
        dapr.io/log-level: "info"
        dapr.io/enable-metrics: "true"
        dapr.io/metrics-port: "9090"
    spec:
      imagePullSecrets:
        - name: gitea-registry-secret
      initContainers:
        - name: fix-permissions
          image: busybox:1.36
          command: ["sh", "-c", "chown -R 1000:1000 /workspaces /home/runner/.claude"]
          volumeMounts:
            - name: worktrees
              mountPath: /workspaces
            - name: claude-session
              mountPath: /home/runner/.claude
      containers:
        - name: envbuilder
          image: ghcr.io/coder/envbuilder:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 3000
              name: http
          env:
            - name: GIT_URL
              value: "https://github.com/${owner}/${repo}.git"
            - name: INIT_SCRIPT
              value: "bun install && bun run dev"
            - name: CACHE_REPO
              value: "registry.bto.bar/jaybrto/envbuilder-cache"
            - name: FALLBACK_IMAGE
              value: "mcr.microsoft.com/devcontainers/base:ubuntu"
            - name: SKIP_REBUILD
              value: "true"
            - name: WORKSPACE_BASE_DIR
              value: "/workspaces"
            - name: GIT_USERNAME
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: GIT_USERNAME
            - name: GIT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: GIT_PASSWORD
            - name: PG_HOST
              value: "pgsql.k3s.bto.bar"
            - name: PG_PORT
              value: "5432"
            - name: PG_DATABASE
              value: "mesh_six"
            - name: PG_USER
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: PG_USER
            - name: PG_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: PG_PASSWORD
          resources:
            requests:
              memory: "${limits.memoryRequest}"
              cpu: "${limits.cpuRequest}"
            limits:
              memory: "${limits.memoryLimit}"
              cpu: "${limits.cpuLimit}"
          volumeMounts:
            - name: worktrees
              mountPath: /workspaces
            - name: claude-session
              mountPath: /home/runner/.claude
  volumeClaimTemplates:
    - metadata:
        name: worktrees
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: ${limits.storageWorktrees}
    - metadata:
        name: claude-session
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: ${limits.storageClaude}
`;
}

function buildServiceYaml(owner: string, repo: string): string {
  const appId = `env-${owner}-${repo}`;
  return `apiVersion: v1
kind: Service
metadata:
  name: ${appId}
  namespace: mesh-six
  labels:
    app: ${appId}
    app.kubernetes.io/part-of: mesh-six
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: 3000
      protocol: TCP
      name: http
  selector:
    app: ${appId}
`;
}

function buildKustomizationYaml(): string {
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - statefulset.yaml
  - service.yaml
`;
}

export async function generateKubeManifests(
  input: GenerateKubeManifestsInput
): Promise<GenerateKubeManifestsResult> {
  const { repoOwner, repoName, resourceLimits } = input;
  const limits = { ...DEFAULT_RESOURCE_LIMITS, ...resourceLimits };

  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  const dir = `k8s/base/envs/${repoOwner}-${repoName}`;

  const files = [
    {
      path: `${dir}/statefulset.yaml`,
      content: buildStatefulSetYaml(repoOwner, repoName, limits),
      message: `chore: add statefulset manifest for env-${repoOwner}-${repoName}`,
    },
    {
      path: `${dir}/service.yaml`,
      content: buildServiceYaml(repoOwner, repoName),
      message: `chore: add service manifest for env-${repoOwner}-${repoName}`,
    },
    {
      path: `${dir}/kustomization.yaml`,
      content: buildKustomizationYaml(),
      message: `chore: add kustomization for env-${repoOwner}-${repoName}`,
    },
  ];

  for (const file of files) {
    const encodedContent = Buffer.from(file.content).toString("base64");

    // Check if file already exists to get its sha (required for updates)
    let existingSha: string | undefined;
    try {
      const existing = await octokit.repos.getContent({
        owner: MESH_SIX_REPO_OWNER,
        repo: MESH_SIX_REPO_NAME,
        path: file.path,
      });
      const data = existing.data;
      if (!Array.isArray(data) && "sha" in data) {
        existingSha = data.sha;
      }
    } catch (err: unknown) {
      if (
        typeof err !== "object" ||
        err === null ||
        !("status" in err) ||
        (err as { status: number }).status !== 404
      ) {
        throw err;
      }
      // File does not exist — create it (no sha needed)
    }

    await octokit.repos.createOrUpdateFileContents({
      owner: MESH_SIX_REPO_OWNER,
      repo: MESH_SIX_REPO_NAME,
      path: file.path,
      message: file.message,
      content: encodedContent,
      ...(existingSha ? { sha: existingSha } : {}),
    });
  }

  return { dir };
}
