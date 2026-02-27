# Onboarding Service Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `apps/onboarding-service` — a Dapr Workflow microservice that automates project onboarding for mesh-six: GitHub project board setup, per-repo Envbuilder pod provisioning, Claude OAuth, LiteLLM routing, and app settings. Exposed via HTTP API and MCP server.

**Architecture:** A Bun+Hono+Dapr service with 12 workflow activities across 3 phases. Phase 1 creates the GitHub project and registers the repo. Phase 2 scaffolds a devcontainer.json, generates Kustomize manifests for an Envbuilder StatefulSet, and triggers ArgoCD sync. Phase 3 handles Claude CLI OAuth (device flow with external event wait), LiteLLM team/routing setup, and app settings. All activities are idempotent.

**Tech Stack:** Bun, Hono, Dapr Workflow, @octokit/rest + @octokit/graphql, @modelcontextprotocol/sdk, PostgreSQL (pg), Zod, @mesh-six/core

**Design doc:** `docs/plans/2026-02-26-onboarding-service-design.md`

---

## Task 1: Scaffold the Service Package

Create the `apps/onboarding-service/` directory with package.json, tsconfig.json, and config module.

**Files:**
- Create: `apps/onboarding-service/package.json`
- Create: `apps/onboarding-service/tsconfig.json`
- Create: `apps/onboarding-service/src/config.ts`

**Step 1: Create package.json**

```json
{
  "name": "@mesh-six/onboarding-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "build": "bun build ./src/index.ts --outdir ./dist --target bun",
    "start": "bun run dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@mesh-six/core": "workspace:*",
    "@dapr/dapr": "^3.6.1",
    "@modelcontextprotocol/sdk": "^1.12.1",
    "@octokit/graphql": "^8.2.1",
    "@octokit/rest": "^21.0.0",
    "hono": "^4.7.4",
    "pg": "^8.13.3",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/pg": "^8.11.11",
    "typescript": "^5.7.3"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "paths": {
      "@mesh-six/core": ["../../packages/core/src/index.ts"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create src/config.ts**

```typescript
export const APP_PORT = Number(process.env.APP_PORT || "3000");
export const DAPR_HOST = process.env.DAPR_HOST || "127.0.0.1";
export const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

export const AGENT_ID = process.env.AGENT_ID || "onboarding-service";
export const AGENT_NAME = process.env.AGENT_NAME || "Onboarding Service";

export const DATABASE_URL =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.PG_USER || "mesh_six"}:${process.env.PG_PASSWORD || ""}@${process.env.PG_HOST || "pgsql.k3s.bto.bar"}:${process.env.PG_PORT || "5432"}/${process.env.PG_DATABASE || "mesh_six"}`;

export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
export const LITELLM_URL = process.env.LITELLM_URL || "http://litellm.k3s.bto.bar";
export const LITELLM_ADMIN_KEY = process.env.LITELLM_ADMIN_KEY || "";
export const VAULT_ADDR = process.env.VAULT_ADDR || "http://vault.vault.svc.cluster.local:8200";
export const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

export const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "http://minio.default.svc.cluster.local:9000";
export const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "";
export const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "";
export const MINIO_BUCKET = process.env.MINIO_BUCKET || "mesh-six-recordings";
```

**Step 4: Install dependencies**

Run: `bun install`

**Step 5: Verify typecheck**

Run: `bun run --filter @mesh-six/onboarding-service typecheck`
Expected: PASS (no source files to check yet beyond config.ts)

**Step 6: Commit**

```bash
git add apps/onboarding-service/
git commit -m "scaffold onboarding-service package with config"
```

---

## Task 2: Database Migration — Onboarding Runs Table

Add the `onboarding_runs` table and `execution_mode` column on `repo_registry`.

**Files:**
- Create: `migrations/012_onboarding_runs.sql`

**Step 1: Create the migration**

```sql
-- Onboarding workflow state tracking
CREATE TABLE IF NOT EXISTS onboarding_runs (
  id                   TEXT PRIMARY KEY,
  repo_owner           TEXT NOT NULL,
  repo_name            TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  current_phase        TEXT,
  current_activity     TEXT,
  completed_activities TEXT[] DEFAULT '{}',
  error_message        TEXT,
  oauth_device_url     TEXT,
  oauth_user_code      TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_runs_repo
  ON onboarding_runs(repo_owner, repo_name);
CREATE INDEX IF NOT EXISTS idx_onboarding_runs_status
  ON onboarding_runs(status);

COMMENT ON TABLE onboarding_runs IS 'Tracks onboarding workflow state for each project';

-- Add execution_mode to repo_registry for hybrid pod model
ALTER TABLE repo_registry ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'envbuilder';
COMMENT ON COLUMN repo_registry.execution_mode IS 'Pod provisioning mode: envbuilder (per-repo pod) or shared (shared implementer)';
```

**Step 2: Run the migration**

Run: `bun run db:migrate`
Expected: `Applied migration: 012_onboarding_runs.sql`

**Step 3: Commit**

```bash
git add migrations/012_onboarding_runs.sql
git commit -m "add onboarding_runs table and repo_registry execution_mode column"
```

---

## Task 3: Database Access Layer

Create the DB module for onboarding_runs CRUD operations.

**Files:**
- Create: `apps/onboarding-service/src/db.ts`

**Step 1: Write the failing test**

Create `apps/onboarding-service/src/db.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import type { OnboardingRun } from "./db.js";

describe("OnboardingRun type", () => {
  it("should have required fields", () => {
    const run: OnboardingRun = {
      id: "test-id",
      repoOwner: "jaybrto",
      repoName: "test-repo",
      status: "pending",
      currentPhase: null,
      currentActivity: null,
      completedActivities: [],
      errorMessage: null,
      oauthDeviceUrl: null,
      oauthUserCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(run.status).toBe("pending");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/onboarding-service/src/db.test.ts`
Expected: FAIL (module not found)

**Step 3: Write the DB module**

Create `apps/onboarding-service/src/db.ts`:

```typescript
import pg from "pg";

export interface OnboardingRun {
  id: string;
  repoOwner: string;
  repoName: string;
  status: "pending" | "running" | "waiting_auth" | "completed" | "failed";
  currentPhase: string | null;
  currentActivity: string | null;
  completedActivities: string[];
  errorMessage: string | null;
  oauthDeviceUrl: string | null;
  oauthUserCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface OnboardingRunRow {
  id: string;
  repo_owner: string;
  repo_name: string;
  status: string;
  current_phase: string | null;
  current_activity: string | null;
  completed_activities: string[];
  error_message: string | null;
  oauth_device_url: string | null;
  oauth_user_code: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToRun(row: OnboardingRunRow): OnboardingRun {
  return {
    id: row.id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    status: row.status as OnboardingRun["status"],
    currentPhase: row.current_phase,
    currentActivity: row.current_activity,
    completedActivities: row.completed_activities ?? [],
    errorMessage: row.error_message,
    oauthDeviceUrl: row.oauth_device_url,
    oauthUserCode: row.oauth_user_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertRun(
  pool: pg.Pool,
  run: { id: string; repoOwner: string; repoName: string }
): Promise<OnboardingRun> {
  const { rows } = await pool.query<OnboardingRunRow>(
    `INSERT INTO onboarding_runs (id, repo_owner, repo_name, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING *`,
    [run.id, run.repoOwner, run.repoName]
  );
  return rowToRun(rows[0]);
}

export async function getRun(pool: pg.Pool, id: string): Promise<OnboardingRun | null> {
  const { rows } = await pool.query<OnboardingRunRow>(
    "SELECT * FROM onboarding_runs WHERE id = $1",
    [id]
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}

export async function updateRunStatus(
  pool: pg.Pool,
  id: string,
  updates: {
    status?: OnboardingRun["status"];
    currentPhase?: string | null;
    currentActivity?: string | null;
    completedActivities?: string[];
    errorMessage?: string | null;
    oauthDeviceUrl?: string | null;
    oauthUserCode?: string | null;
  }
): Promise<OnboardingRun | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.status !== undefined) {
    sets.push(`status = $${idx++}`);
    params.push(updates.status);
  }
  if (updates.currentPhase !== undefined) {
    sets.push(`current_phase = $${idx++}`);
    params.push(updates.currentPhase);
  }
  if (updates.currentActivity !== undefined) {
    sets.push(`current_activity = $${idx++}`);
    params.push(updates.currentActivity);
  }
  if (updates.completedActivities !== undefined) {
    sets.push(`completed_activities = $${idx++}`);
    params.push(updates.completedActivities);
  }
  if (updates.errorMessage !== undefined) {
    sets.push(`error_message = $${idx++}`);
    params.push(updates.errorMessage);
  }
  if (updates.oauthDeviceUrl !== undefined) {
    sets.push(`oauth_device_url = $${idx++}`);
    params.push(updates.oauthDeviceUrl);
  }
  if (updates.oauthUserCode !== undefined) {
    sets.push(`oauth_user_code = $${idx++}`);
    params.push(updates.oauthUserCode);
  }

  params.push(id);
  const { rows } = await pool.query<OnboardingRunRow>(
    `UPDATE onboarding_runs SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/onboarding-service/src/db.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/onboarding-service/src/db.ts apps/onboarding-service/src/db.test.ts
git commit -m "add onboarding-service DB access layer with type tests"
```

---

## Task 4: Zod Schemas for Onboarding Request

Define the request/response types with Zod validation.

**Files:**
- Create: `apps/onboarding-service/src/schemas.ts`

**Step 1: Write the failing test**

Create `apps/onboarding-service/src/schemas.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { OnboardProjectRequestSchema } from "./schemas.js";

describe("OnboardProjectRequestSchema", () => {
  it("should accept minimal valid request", () => {
    const result = OnboardProjectRequestSchema.safeParse({
      repoOwner: "jaybrto",
      repoName: "my-app",
    });
    expect(result.success).toBe(true);
  });

  it("should reject missing repoOwner", () => {
    const result = OnboardProjectRequestSchema.safeParse({ repoName: "my-app" });
    expect(result.success).toBe(false);
  });

  it("should accept full request with all optional fields", () => {
    const result = OnboardProjectRequestSchema.safeParse({
      repoOwner: "jaybrto",
      repoName: "my-app",
      displayName: "My App",
      defaultBranch: "develop",
      skipAuth: true,
      skipLiteLLM: false,
      resourceLimits: {
        memoryRequest: "4Gi",
        memoryLimit: "16Gi",
        cpuRequest: "2",
        cpuLimit: "8",
        storageWorktrees: "50Gi",
        storageClaude: "2Gi",
      },
      litellm: {
        teamAlias: "my-team",
        defaultModel: "claude-sonnet-4-20250514",
        maxBudget: 100,
      },
      settings: {
        cloudflareDomain: "mesh-six.bto.bar",
        terminalStreamingRate: 500,
      },
    });
    expect(result.success).toBe(true);
  });

  it("should apply defaults for optional fields", () => {
    const result = OnboardProjectRequestSchema.parse({
      repoOwner: "jaybrto",
      repoName: "my-app",
    });
    expect(result.defaultBranch).toBe("main");
    expect(result.skipAuth).toBe(false);
    expect(result.skipLiteLLM).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/onboarding-service/src/schemas.test.ts`
Expected: FAIL

**Step 3: Write the schemas**

Create `apps/onboarding-service/src/schemas.ts`:

```typescript
import { z } from "zod";

export const ResourceLimitsSchema = z.object({
  memoryRequest: z.string().default("2Gi"),
  memoryLimit: z.string().default("8Gi"),
  cpuRequest: z.string().default("1"),
  cpuLimit: z.string().default("4"),
  storageWorktrees: z.string().default("20Gi"),
  storageClaude: z.string().default("1Gi"),
});

export const LiteLLMConfigSchema = z.object({
  teamAlias: z.string().optional(),
  defaultModel: z.string().optional(),
  maxBudget: z.number().positive().optional(),
});

export const AppSettingsSchema = z.object({
  cloudflareDomain: z.string().optional(),
  terminalStreamingRate: z.number().int().positive().optional(),
});

export const OnboardProjectRequestSchema = z.object({
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  displayName: z.string().optional(),
  defaultBranch: z.string().default("main"),
  skipAuth: z.boolean().default(false),
  skipLiteLLM: z.boolean().default(false),
  resourceLimits: ResourceLimitsSchema.optional(),
  litellm: LiteLLMConfigSchema.optional(),
  settings: AppSettingsSchema.optional(),
});

export type OnboardProjectRequest = z.infer<typeof OnboardProjectRequestSchema>;
export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

export const AuthCallbackSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.string().datetime(),
});

export type AuthCallback = z.infer<typeof AuthCallbackSchema>;
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/onboarding-service/src/schemas.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/onboarding-service/src/schemas.ts apps/onboarding-service/src/schemas.test.ts
git commit -m "add Zod schemas for onboarding request/response types"
```

---

## Task 5: Phase 1 Activities — Initialization

Implement the 5 activities for Phase 1: validateRepo, createProjectBoard, registerWebhookSecret, registerInDatabase, provisionBackend.

**Files:**
- Create: `apps/onboarding-service/src/activities/validate-repo.ts`
- Create: `apps/onboarding-service/src/activities/create-project-board.ts`
- Create: `apps/onboarding-service/src/activities/register-webhook-secret.ts`
- Create: `apps/onboarding-service/src/activities/register-in-database.ts`
- Create: `apps/onboarding-service/src/activities/provision-backend.ts`

**Step 1: Write validate-repo.ts**

Port the repo verification logic from `scripts/onboard-repo.ts:45-65`. Uses Octokit REST.

```typescript
import { Octokit } from "@octokit/rest";
import { GITHUB_TOKEN } from "../config.js";

export interface ValidateRepoInput {
  repoOwner: string;
  repoName: string;
}

export interface ValidateRepoOutput {
  repoNodeId: string;
  ownerNodeId: string;
  defaultBranch: string;
  fullName: string;
}

export async function validateRepo(input: ValidateRepoInput): Promise<ValidateRepoOutput> {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  const { data: repo } = await octokit.repos.get({
    owner: input.repoOwner,
    repo: input.repoName,
  });

  // Get owner's GraphQL node ID for project creation
  const { data: owner } = await octokit.users.getByUsername({
    username: input.repoOwner,
  });

  return {
    repoNodeId: repo.node_id,
    ownerNodeId: owner.node_id,
    defaultBranch: repo.default_branch,
    fullName: repo.full_name,
  };
}
```

**Step 2: Write create-project-board.ts**

Port the project creation from `scripts/onboard-repo.ts:70-180`. Uses @octokit/graphql.

```typescript
import { graphql } from "@octokit/graphql";
import { GITHUB_TOKEN } from "../config.js";

export interface CreateProjectBoardInput {
  repoOwner: string;
  repoName: string;
  ownerNodeId: string;
  repoNodeId: string;
  displayName?: string;
}

export interface CreateProjectBoardOutput {
  projectId: string;
  projectUrl: string;
  projectNumber: number;
  statusFieldId: string;
  sessionIdFieldId: string;
  podNameFieldId: string;
  workflowIdFieldId: string;
  priorityFieldId: string;
}

const gql = graphql.defaults({
  headers: {
    authorization: `Bearer ${GITHUB_TOKEN}`,
    "X-Github-Next-Global-ID": "1",
  },
});

export async function createProjectBoard(
  input: CreateProjectBoardInput
): Promise<CreateProjectBoardOutput> {
  const title = input.displayName || `mesh-six: ${input.repoOwner}/${input.repoName}`;

  // Create project
  const createResult = await gql<{
    createProjectV2: { projectV2: { id: string; url: string; number: number } };
  }>(
    `mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id url number }
      }
    }`,
    { ownerId: input.ownerNodeId, title }
  );

  const project = createResult.createProjectV2.projectV2;

  // Link project to repository
  await gql(
    `mutation($projectId: ID!, $repositoryId: ID!) {
      linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
        repository { id }
      }
    }`,
    { projectId: project.id, repositoryId: input.repoNodeId }
  );

  // Get existing fields (Status is built-in)
  const fieldsResult = await gql<{
    node: { fields: { nodes: Array<{ id: string; name: string; __typename: string }> } };
  }>(
    `query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes { id name __typename }
          }
        }
      }
    }`,
    { projectId: project.id }
  );

  const statusField = fieldsResult.node.fields.nodes.find(
    (f) => f.name === "Status" && f.__typename === "ProjectV2SingleSelectField"
  );

  // Create custom fields
  const sessionIdField = await createTextField(project.id, "Session ID");
  const podNameField = await createTextField(project.id, "Pod Name");
  const workflowIdField = await createTextField(project.id, "Workflow ID");
  const priorityField = await createSingleSelectField(project.id, "Priority", [
    { name: "Critical", color: "RED" },
    { name: "High", color: "ORANGE" },
    { name: "Medium", color: "YELLOW" },
    { name: "Low", color: "GREEN" },
  ]);

  return {
    projectId: project.id,
    projectUrl: project.url,
    projectNumber: project.number,
    statusFieldId: statusField?.id ?? "",
    sessionIdFieldId: sessionIdField,
    podNameFieldId: podNameField,
    workflowIdFieldId: workflowIdField,
    priorityFieldId: priorityField,
  };
}

async function createTextField(projectId: string, name: string): Promise<string> {
  const result = await gql<{
    createProjectV2Field: { projectV2Field: { id: string } };
  }>(
    `mutation($projectId: ID!, $name: String!) {
      createProjectV2Field(input: {
        projectId: $projectId, dataType: TEXT, name: $name
      }) {
        projectV2Field { id }
      }
    }`,
    { projectId, name }
  );
  return result.createProjectV2Field.projectV2Field.id;
}

async function createSingleSelectField(
  projectId: string,
  name: string,
  options: Array<{ name: string; color: string }>
): Promise<string> {
  const result = await gql<{
    createProjectV2Field: { projectV2Field: { id: string } };
  }>(
    `mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
      createProjectV2Field(input: {
        projectId: $projectId, dataType: SINGLE_SELECT, name: $name,
        singleSelectOptions: $options
      }) {
        projectV2Field { id }
      }
    }`,
    { projectId, name, options }
  );
  return result.createProjectV2Field.projectV2Field.id;
}
```

**Step 3: Write register-webhook-secret.ts**

```typescript
import { VAULT_ADDR, VAULT_TOKEN } from "../config.js";

export interface RegisterWebhookSecretInput {
  repoOwner: string;
  repoName: string;
}

export interface RegisterWebhookSecretOutput {
  secretPath: string;
  alreadyExisted: boolean;
}

export async function registerWebhookSecret(
  input: RegisterWebhookSecretInput
): Promise<RegisterWebhookSecretOutput> {
  const secretPath = `secret/data/mesh-six/webhooks/${input.repoOwner}-${input.repoName}`;

  // Check if secret already exists
  const checkResp = await fetch(`${VAULT_ADDR}/v1/${secretPath}`, {
    headers: { "X-Vault-Token": VAULT_TOKEN },
  });

  if (checkResp.ok) {
    return { secretPath, alreadyExisted: true };
  }

  // Generate HMAC secret
  const hmacSecret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

  // Write to Vault
  const writeResp = await fetch(`${VAULT_ADDR}/v1/${secretPath}`, {
    method: "POST",
    headers: {
      "X-Vault-Token": VAULT_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        hmac_secret: hmacSecret,
        repo_owner: input.repoOwner,
        repo_name: input.repoName,
        created_at: new Date().toISOString(),
      },
    }),
  });

  if (!writeResp.ok) {
    throw new Error(`Failed to write webhook secret to Vault: ${writeResp.status} ${await writeResp.text()}`);
  }

  return { secretPath, alreadyExisted: false };
}
```

**Step 4: Write register-in-database.ts**

```typescript
import pg from "pg";

export interface RegisterInDatabaseInput {
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  projectId: string;
  projectUrl: string;
  projectNumber: number;
  statusFieldId: string;
  sessionIdFieldId: string;
  podNameFieldId: string;
  workflowIdFieldId: string;
  priorityFieldId: string;
}

export async function registerInDatabase(
  pool: pg.Pool,
  input: RegisterInDatabaseInput
): Promise<void> {
  const serviceName = `${input.repoOwner}-${input.repoName}`;
  const repoUrl = `https://github.com/${input.repoOwner}/${input.repoName}`;

  await pool.query(
    `INSERT INTO repo_registry (
      service_name, repo_url, platform, default_branch,
      cicd_type, trigger_method, board_id, execution_mode, metadata,
      created_at, updated_at
    ) VALUES ($1, $2, 'github', $3, 'github-actions', 'project-board', $4, 'envbuilder', $5, now(), now())
    ON CONFLICT (service_name) DO UPDATE SET
      board_id = EXCLUDED.board_id,
      execution_mode = EXCLUDED.execution_mode,
      metadata = EXCLUDED.metadata,
      updated_at = now()`,
    [
      serviceName,
      repoUrl,
      input.defaultBranch,
      input.projectId,
      JSON.stringify({
        projectUrl: input.projectUrl,
        projectNumber: input.projectNumber,
        fields: {
          statusFieldId: input.statusFieldId,
          sessionIdFieldId: input.sessionIdFieldId,
          podNameFieldId: input.podNameFieldId,
          workflowIdFieldId: input.workflowIdFieldId,
          priorityFieldId: input.priorityFieldId,
        },
      }),
    ]
  );
}
```

**Step 5: Write provision-backend.ts**

```typescript
import {
  createMinioClient,
  uploadToMinio,
  type MinioConfig,
} from "@mesh-six/core";
import {
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_BUCKET,
} from "../config.js";
import pg from "pg";

export interface ProvisionBackendInput {
  repoOwner: string;
  repoName: string;
}

export async function provisionBackend(
  pool: pg.Pool,
  input: ProvisionBackendInput
): Promise<void> {
  // Verify PG connectivity
  await pool.query("SELECT 1");

  // Create MinIO prefix marker
  const minioConfig: MinioConfig = {
    endpoint: MINIO_ENDPOINT,
    accessKeyId: MINIO_ACCESS_KEY,
    secretAccessKey: MINIO_SECRET_KEY,
    bucket: MINIO_BUCKET,
  };

  const client = createMinioClient(minioConfig);
  const markerKey = `${input.repoOwner}/${input.repoName}/.marker`;

  await uploadToMinio(
    client,
    MINIO_BUCKET,
    markerKey,
    new TextEncoder().encode(""),
    "text/plain"
  );
}
```

**Step 6: Verify typecheck**

Run: `bun run --filter @mesh-six/onboarding-service typecheck`
Expected: PASS

**Step 7: Commit**

```bash
git add apps/onboarding-service/src/activities/
git commit -m "implement Phase 1 initialization activities"
```

---

## Task 6: Phase 2 Activities — Dev Environment Provisioning

Implement the 5 activities for dev environment setup: scaffoldDevcontainer, generateKubeManifests, updateKustomization, triggerSync, verifyPodHealth.

**Files:**
- Create: `apps/onboarding-service/src/activities/scaffold-devcontainer.ts`
- Create: `apps/onboarding-service/src/activities/generate-kube-manifests.ts`
- Create: `apps/onboarding-service/src/activities/update-kustomization.ts`
- Create: `apps/onboarding-service/src/activities/trigger-sync.ts`
- Create: `apps/onboarding-service/src/activities/verify-pod-health.ts`
- Create: `templates/devcontainer/devcontainer.json`

**Step 1: Create the devcontainer template**

Create `templates/devcontainer/devcontainer.json`:

```json
{
  "name": "mesh-six agent environment",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "22" },
    "registry.bto.bar/jaybrto/devcontainer-features/mesh-six-tools:1": {}
  },
  "remoteUser": "runner",
  "containerUser": "runner"
}
```

**Step 2: Write scaffold-devcontainer.ts**

```typescript
import { Octokit } from "@octokit/rest";
import { GITHUB_TOKEN } from "../config.js";

export interface ScaffoldDevcontainerInput {
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
}

export interface ScaffoldDevcontainerOutput {
  alreadyExisted: boolean;
  hasMeshSixTools: boolean;
}

export async function scaffoldDevcontainer(
  input: ScaffoldDevcontainerInput
): Promise<ScaffoldDevcontainerOutput> {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  const path = ".devcontainer/devcontainer.json";

  // Check if devcontainer.json already exists
  try {
    const { data } = await octokit.repos.getContent({
      owner: input.repoOwner,
      repo: input.repoName,
      path,
      ref: input.defaultBranch,
    });

    if (!Array.isArray(data) && data.type === "file") {
      const content = Buffer.from(data.content, "base64").toString("utf-8");
      const hasMeshSixTools = content.includes("mesh-six-tools");
      return { alreadyExisted: true, hasMeshSixTools };
    }
  } catch (err: unknown) {
    if ((err as { status?: number }).status !== 404) throw err;
    // 404 = file doesn't exist, proceed to create
  }

  // Read default template
  const templatePath = new URL(
    "../../../templates/devcontainer/devcontainer.json",
    import.meta.url
  );
  const template = await Bun.file(templatePath).text();

  // Push to repo via GitHub API
  await octokit.repos.createOrUpdateFileContents({
    owner: input.repoOwner,
    repo: input.repoName,
    path,
    message: "feat: add dev container configuration for mesh-six",
    content: Buffer.from(template).toString("base64"),
    branch: input.defaultBranch,
  });

  return { alreadyExisted: false, hasMeshSixTools: true };
}
```

**Step 3: Write generate-kube-manifests.ts**

```typescript
import type { ResourceLimits } from "../schemas.js";

export interface GenerateKubeManifestsInput {
  repoOwner: string;
  repoName: string;
  resourceLimits?: ResourceLimits;
}

const DEFAULT_LIMITS: Required<ResourceLimits> = {
  memoryRequest: "2Gi",
  memoryLimit: "8Gi",
  cpuRequest: "1",
  cpuLimit: "4",
  storageWorktrees: "20Gi",
  storageClaude: "1Gi",
};

export async function generateKubeManifests(
  input: GenerateKubeManifestsInput
): Promise<{ dir: string }> {
  const limits = { ...DEFAULT_LIMITS, ...input.resourceLimits };
  const name = `env-${input.repoOwner}-${input.repoName}`;
  const dir = `k8s/base/envs/${input.repoOwner}-${input.repoName}`;

  const statefulset = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${name}
  namespace: mesh-six
  labels:
    app: ${name}
    app.kubernetes.io/name: ${name}
    app.kubernetes.io/part-of: mesh-six
    mesh-six.bto.bar/project: "${input.repoOwner}/${input.repoName}"
spec:
  replicas: 1
  serviceName: ${name}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
        app.kubernetes.io/name: ${name}
      annotations:
        dapr.io/enabled: "true"
        dapr.io/app-id: "${name}"
        dapr.io/app-port: "3000"
        dapr.io/log-level: "info"
        dapr.io/enable-metrics: "true"
        dapr.io/metrics-port: "9090"
    spec:
      initContainers:
        - name: fix-permissions
          image: busybox:1.36
          command: ["sh", "-c", "chown -R 1000:1000 /data/worktrees /data/claude"]
          volumeMounts:
            - name: worktrees
              mountPath: /data/worktrees
            - name: claude-session
              mountPath: /data/claude
      containers:
        - name: implementer
          image: ghcr.io/coder/envbuilder:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 3000
              name: http
          env:
            - name: ENVBUILDER_GIT_URL
              value: "https://github.com/${input.repoOwner}/${input.repoName}"
            - name: ENVBUILDER_INIT_SCRIPT
              value: "/home/runner/entrypoint.sh"
            - name: ENVBUILDER_CACHE_REPO
              value: "registry.bto.bar/jaybrto/envbuilder-cache/${input.repoName}"
            - name: ENVBUILDER_FALLBACK_IMAGE
              value: "mcr.microsoft.com/devcontainers/base:ubuntu"
            - name: ENVBUILDER_SKIP_REBUILD
              value: "true"
            - name: ENVBUILDER_WORKSPACE_BASE_DIR
              value: "/home/runner/repo"
            - name: ENVBUILDER_GIT_USERNAME
              value: "x-access-token"
            - name: ENVBUILDER_GIT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: GITHUB_TOKEN
            - name: ENVBUILDER_DOCKER_CONFIG_BASE64
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: docker-config-base64
                  optional: true
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
            - name: DAPR_HTTP_PORT
              value: "3500"
          readinessProbe:
            httpGet:
              path: /readyz
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 60
            periodSeconds: 20
          resources:
            requests:
              memory: "${limits.memoryRequest}"
              cpu: "${limits.cpuRequest}"
            limits:
              memory: "${limits.memoryLimit}"
              cpu: "${limits.cpuLimit}"
          volumeMounts:
            - name: worktrees
              mountPath: /home/runner/worktrees
            - name: claude-session
              mountPath: /home/runner/.claude
  volumeClaimTemplates:
    - metadata:
        name: worktrees
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: "${limits.storageWorktrees}"
    - metadata:
        name: claude-session
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: "${limits.storageClaude}"
`;

  const service = `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: mesh-six
  labels:
    app: ${name}
    app.kubernetes.io/part-of: mesh-six
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: 3000
      protocol: TCP
      name: http
  selector:
    app: ${name}
`;

  const kustomization = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - statefulset.yaml
  - service.yaml
`;

  // Write files
  const basePath = `${process.cwd()}/${dir}`;
  await Bun.write(`${basePath}/statefulset.yaml`, statefulset);
  await Bun.write(`${basePath}/service.yaml`, service);
  await Bun.write(`${basePath}/kustomization.yaml`, kustomization);

  return { dir };
}
```

**Step 4: Write update-kustomization.ts**

```typescript
export interface UpdateKustomizationInput {
  repoOwner: string;
  repoName: string;
}

export async function updateKustomization(input: UpdateKustomizationInput): Promise<void> {
  const kustomizationPath = `${process.cwd()}/k8s/base/kustomization.yaml`;
  const content = await Bun.file(kustomizationPath).text();

  const envEntry = `envs/${input.repoOwner}-${input.repoName}/`;

  if (content.includes(envEntry)) {
    return; // Already present
  }

  // Insert before commonLabels section
  const updated = content.replace(
    "\ncommonLabels:",
    `  - ${envEntry}\n\ncommonLabels:`
  );

  await Bun.write(kustomizationPath, updated);
}
```

**Step 5: Write trigger-sync.ts**

```typescript
export interface TriggerSyncInput {
  repoOwner: string;
  repoName: string;
  manifestDir: string;
}

export async function triggerSync(input: TriggerSyncInput): Promise<void> {
  // Commit and push generated manifests
  const gitAdd = Bun.spawnSync(["git", "add", input.manifestDir, "k8s/base/kustomization.yaml"]);
  if (gitAdd.exitCode !== 0) {
    throw new Error(`git add failed: ${gitAdd.stderr.toString()}`);
  }

  const gitCommit = Bun.spawnSync([
    "git", "commit", "-m",
    `infra: add Envbuilder pod for ${input.repoOwner}/${input.repoName}`,
  ]);
  if (gitCommit.exitCode !== 0) {
    const stderr = gitCommit.stderr.toString();
    // "nothing to commit" is OK (idempotent)
    if (!stderr.includes("nothing to commit")) {
      throw new Error(`git commit failed: ${stderr}`);
    }
  }

  const gitPush = Bun.spawnSync(["git", "push"]);
  if (gitPush.exitCode !== 0) {
    throw new Error(`git push failed: ${gitPush.stderr.toString()}`);
  }

  // ArgoCD will auto-sync. Optionally poll for health.
  // The verifyPodHealth activity handles the wait.
}
```

**Step 6: Write verify-pod-health.ts**

```typescript
export interface VerifyPodHealthInput {
  repoOwner: string;
  repoName: string;
  timeoutMs?: number;
}

export async function verifyPodHealth(input: VerifyPodHealthInput): Promise<void> {
  const podName = `env-${input.repoOwner}-${input.repoName}-0`;
  const namespace = "mesh-six";
  const timeout = input.timeoutMs ?? 300_000; // 5 minutes default
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const result = Bun.spawnSync([
      "kubectl", "get", "pod", podName,
      "-n", namespace,
      "-o", "jsonpath={.status.phase}",
    ]);

    const phase = result.stdout.toString().trim();
    if (phase === "Running") {
      // Check readiness
      const ready = Bun.spawnSync([
        "kubectl", "get", "pod", podName,
        "-n", namespace,
        "-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}",
      ]);

      if (ready.stdout.toString().trim() === "True") {
        return;
      }
    }

    await Bun.sleep(10_000);
  }

  throw new Error(
    `Pod ${podName} did not become ready within ${timeout / 1000}s`
  );
}
```

**Step 7: Verify typecheck**

Run: `bun run --filter @mesh-six/onboarding-service typecheck`
Expected: PASS

**Step 8: Commit**

```bash
git add apps/onboarding-service/src/activities/ templates/devcontainer/
git commit -m "implement Phase 2 dev environment provisioning activities"
```

---

## Task 7: Phase 3 Activities — Authentication & Settings

Implement the 4 activities: initiateClaudeOAuth, storeClaudeCredentials, configureLiteLLM, configureAppSettings.

**Files:**
- Create: `apps/onboarding-service/src/activities/initiate-claude-oauth.ts`
- Create: `apps/onboarding-service/src/activities/store-claude-credentials.ts`
- Create: `apps/onboarding-service/src/activities/configure-litellm.ts`
- Create: `apps/onboarding-service/src/activities/configure-app-settings.ts`

**Step 1: Write initiate-claude-oauth.ts**

```typescript
export interface InitiateClaudeOAuthOutput {
  deviceUrl: string;
  userCode: string;
}

export async function initiateClaudeOAuth(): Promise<InitiateClaudeOAuthOutput> {
  // Claude CLI uses device authorization grant flow
  // The CLI exposes this via `claude auth login --device-flow`
  // which outputs a URL and code for the user to visit

  const proc = Bun.spawn(["claude", "auth", "login", "--print-device-code"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Claude auth device flow failed: ${stderr}`);
  }

  // Parse the device URL and user code from CLI output
  // Expected format: "Visit URL: https://... \n Enter code: XXXX-XXXX"
  const urlMatch = stdout.match(/https:\/\/[^\s]+/);
  const codeMatch = stdout.match(/code:\s*(\S+)/i);

  if (!urlMatch || !codeMatch) {
    throw new Error(`Failed to parse device flow output: ${stdout}`);
  }

  return {
    deviceUrl: urlMatch[0],
    userCode: codeMatch[1],
  };
}
```

**Step 2: Write store-claude-credentials.ts**

```typescript
import { DAPR_HOST, DAPR_HTTP_PORT } from "../config.js";
import { AUTH_SERVICE_APP_ID } from "@mesh-six/core";

export interface StoreClaudeCredentialsInput {
  projectId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export async function storeClaudeCredentials(
  input: StoreClaudeCredentialsInput
): Promise<void> {
  const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/projects/${input.projectId}/credentials`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      source: "onboarding-oauth",
    }),
  });

  if (!resp.ok) {
    throw new Error(
      `Failed to store credentials: ${resp.status} ${await resp.text()}`
    );
  }
}
```

**Step 3: Write configure-litellm.ts**

```typescript
import { LITELLM_URL, LITELLM_ADMIN_KEY } from "../config.js";

export interface ConfigureLiteLLMInput {
  repoOwner: string;
  repoName: string;
  teamAlias?: string;
  defaultModel?: string;
  maxBudget?: number;
}

export async function configureLiteLLM(input: ConfigureLiteLLMInput): Promise<void> {
  const teamAlias = input.teamAlias || `${input.repoOwner}/${input.repoName}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${LITELLM_ADMIN_KEY}`,
  };

  // Check if team already exists
  const listResp = await fetch(`${LITELLM_URL}/team/list`, { headers });
  if (listResp.ok) {
    const teams = (await listResp.json()) as Array<{ team_alias?: string }>;
    if (teams.some((t) => t.team_alias === teamAlias)) {
      return; // Already configured
    }
  }

  // Create team
  const createResp = await fetch(`${LITELLM_URL}/team/new`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      team_alias: teamAlias,
      models: input.defaultModel ? [input.defaultModel] : [],
      max_budget: input.maxBudget ?? null,
      metadata: {
        repo_owner: input.repoOwner,
        repo_name: input.repoName,
        created_by: "onboarding-service",
      },
    }),
  });

  if (!createResp.ok) {
    throw new Error(
      `Failed to create LiteLLM team: ${createResp.status} ${await createResp.text()}`
    );
  }

  // Generate virtual key for the team
  const team = (await createResp.json()) as { team_id: string };

  const keyResp = await fetch(`${LITELLM_URL}/key/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      team_id: team.team_id,
      key_alias: `${teamAlias}-key`,
      models: input.defaultModel ? [input.defaultModel] : [],
      max_budget: input.maxBudget ?? null,
    }),
  });

  if (!keyResp.ok) {
    throw new Error(
      `Failed to generate LiteLLM key: ${keyResp.status} ${await keyResp.text()}`
    );
  }
}
```

**Step 4: Write configure-app-settings.ts**

```typescript
import { DAPR_HOST, DAPR_HTTP_PORT } from "../config.js";
import { AUTH_SERVICE_APP_ID } from "@mesh-six/core";

export interface ConfigureAppSettingsInput {
  projectId: string;
  settings: {
    cloudflareDomain?: string;
    terminalStreamingRate?: number;
  };
}

export async function configureAppSettings(
  input: ConfigureAppSettingsInput
): Promise<void> {
  const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/projects/${input.projectId}`;

  const resp = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      settingsJson: JSON.stringify(input.settings),
    }),
  });

  if (!resp.ok) {
    throw new Error(
      `Failed to configure app settings: ${resp.status} ${await resp.text()}`
    );
  }
}
```

**Step 5: Verify typecheck**

Run: `bun run --filter @mesh-six/onboarding-service typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/onboarding-service/src/activities/
git commit -m "implement Phase 3 auth and settings activities"
```

---

## Task 8: Dapr Workflow Definition

Wire all 12 activities into a Dapr Workflow with 3 phases.

**Files:**
- Create: `apps/onboarding-service/src/workflow.ts`

**Step 1: Create the workflow**

Follow the pattern from `apps/project-manager/src/workflow.ts` — generator function with activity stubs, `createWorkflowRuntime()` wiring function, and client helpers.

```typescript
import {
  WorkflowRuntime,
  WorkflowContext,
  DaprWorkflowClient,
  type TWorkflow,
} from "@dapr/dapr";
import pg from "pg";
import { DAPR_HOST, DAPR_HTTP_PORT } from "./config.js";
import { updateRunStatus } from "./db.js";
import type { OnboardProjectRequest, AuthCallback } from "./schemas.js";

// Activity imports
import { validateRepo, type ValidateRepoOutput } from "./activities/validate-repo.js";
import { createProjectBoard, type CreateProjectBoardOutput } from "./activities/create-project-board.js";
import { registerWebhookSecret, type RegisterWebhookSecretOutput } from "./activities/register-webhook-secret.js";
import { registerInDatabase } from "./activities/register-in-database.js";
import { provisionBackend } from "./activities/provision-backend.js";
import { scaffoldDevcontainer, type ScaffoldDevcontainerOutput } from "./activities/scaffold-devcontainer.js";
import { generateKubeManifests } from "./activities/generate-kube-manifests.js";
import { updateKustomization } from "./activities/update-kustomization.js";
import { triggerSync } from "./activities/trigger-sync.js";
import { verifyPodHealth } from "./activities/verify-pod-health.js";
import { initiateClaudeOAuth, type InitiateClaudeOAuthOutput } from "./activities/initiate-claude-oauth.js";
import { storeClaudeCredentials } from "./activities/store-claude-credentials.js";
import { configureLiteLLM } from "./activities/configure-litellm.js";
import { configureAppSettings } from "./activities/configure-app-settings.js";

// --- Workflow activity stubs (wired at runtime) ---
let validateRepoActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };
let createProjectBoardActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };
let registerWebhookSecretActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };
let registerInDatabaseActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };
let provisionBackendActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };
let scaffoldDevcontainerActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };
let generateKubeManifestsActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };
let updateKustomizationActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };
let triggerSyncActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };
let verifyPodHealthActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };
let initiateClaudeOAuthActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };
let storeClaudeCredentialsActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };
let configureLiteLLMActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };
let configureAppSettingsActivity = async (_ctx: any, _input: any) => { throw new Error("not initialized"); };

// --- The Workflow ---
export const onboardingWorkflow: TWorkflow = async function* (
  ctx: WorkflowContext,
  input: OnboardProjectRequest
): any {
  // Phase 1: Initialization
  const repoInfo: ValidateRepoOutput = yield ctx.callActivity(
    validateRepoActivity, { repoOwner: input.repoOwner, repoName: input.repoName }
  );

  const board: CreateProjectBoardOutput = yield ctx.callActivity(
    createProjectBoardActivity, {
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      ownerNodeId: repoInfo.ownerNodeId,
      repoNodeId: repoInfo.repoNodeId,
      displayName: input.displayName,
    }
  );

  yield ctx.callActivity(registerWebhookSecretActivity, {
    repoOwner: input.repoOwner,
    repoName: input.repoName,
  });

  yield ctx.callActivity(registerInDatabaseActivity, {
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    defaultBranch: repoInfo.defaultBranch,
    ...board,
  });

  yield ctx.callActivity(provisionBackendActivity, {
    repoOwner: input.repoOwner,
    repoName: input.repoName,
  });

  // Phase 2: Dev Environment Provisioning
  yield ctx.callActivity(scaffoldDevcontainerActivity, {
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    defaultBranch: repoInfo.defaultBranch,
  });

  const manifests: { dir: string } = yield ctx.callActivity(
    generateKubeManifestsActivity, {
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      resourceLimits: input.resourceLimits,
    }
  );

  yield ctx.callActivity(updateKustomizationActivity, {
    repoOwner: input.repoOwner,
    repoName: input.repoName,
  });

  yield ctx.callActivity(triggerSyncActivity, {
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    manifestDir: manifests.dir,
  });

  yield ctx.callActivity(verifyPodHealthActivity, {
    repoOwner: input.repoOwner,
    repoName: input.repoName,
  });

  // Phase 3: Authentication & Settings
  if (!input.skipAuth) {
    const oauth: InitiateClaudeOAuthOutput = yield ctx.callActivity(
      initiateClaudeOAuthActivity, {}
    );

    // Pause workflow until user completes OAuth and submits tokens
    const authCallback: AuthCallback = yield ctx.waitForExternalEvent(
      "oauth-code-received"
    );

    const projectId = `${input.repoOwner}-${input.repoName}`;
    yield ctx.callActivity(storeClaudeCredentialsActivity, {
      projectId,
      accessToken: authCallback.accessToken,
      refreshToken: authCallback.refreshToken,
      expiresAt: authCallback.expiresAt,
    });
  }

  if (!input.skipLiteLLM) {
    yield ctx.callActivity(configureLiteLLMActivity, {
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      ...input.litellm,
    });
  }

  if (input.settings) {
    const projectId = `${input.repoOwner}-${input.repoName}`;
    yield ctx.callActivity(configureAppSettingsActivity, {
      projectId,
      settings: input.settings,
    });
  }

  return { status: "completed" };
};

// --- Runtime wiring ---
export function createWorkflowRuntime(pool: pg.Pool): WorkflowRuntime {
  // Wire activity stubs to real implementations
  validateRepoActivity = async (_ctx, input) => validateRepo(input);
  createProjectBoardActivity = async (_ctx, input) => createProjectBoard(input);
  registerWebhookSecretActivity = async (_ctx, input) => registerWebhookSecret(input);
  registerInDatabaseActivity = async (_ctx, input) => registerInDatabase(pool, input);
  provisionBackendActivity = async (_ctx, input) => provisionBackend(pool, input);
  scaffoldDevcontainerActivity = async (_ctx, input) => scaffoldDevcontainer(input);
  generateKubeManifestsActivity = async (_ctx, input) => generateKubeManifests(input);
  updateKustomizationActivity = async (_ctx, input) => updateKustomization(input);
  triggerSyncActivity = async (_ctx, input) => triggerSync(input);
  verifyPodHealthActivity = async (_ctx, input) => verifyPodHealth(input);
  initiateClaudeOAuthActivity = async (_ctx, _input) => initiateClaudeOAuth();
  storeClaudeCredentialsActivity = async (_ctx, input) => storeClaudeCredentials(input);
  configureLiteLLMActivity = async (_ctx, input) => configureLiteLLM(input);
  configureAppSettingsActivity = async (_ctx, input) => configureAppSettings(input);

  const runtime = new WorkflowRuntime({
    daprHost: DAPR_HOST,
    daprPort: DAPR_HTTP_PORT,
  });

  runtime.registerWorkflow(onboardingWorkflow);
  runtime.registerActivity(validateRepoActivity);
  runtime.registerActivity(createProjectBoardActivity);
  runtime.registerActivity(registerWebhookSecretActivity);
  runtime.registerActivity(registerInDatabaseActivity);
  runtime.registerActivity(provisionBackendActivity);
  runtime.registerActivity(scaffoldDevcontainerActivity);
  runtime.registerActivity(generateKubeManifestsActivity);
  runtime.registerActivity(updateKustomizationActivity);
  runtime.registerActivity(triggerSyncActivity);
  runtime.registerActivity(verifyPodHealthActivity);
  runtime.registerActivity(initiateClaudeOAuthActivity);
  runtime.registerActivity(storeClaudeCredentialsActivity);
  runtime.registerActivity(configureLiteLLMActivity);
  runtime.registerActivity(configureAppSettingsActivity);

  return runtime;
}

// --- Client helpers ---
export function createWorkflowClient(): DaprWorkflowClient {
  return new DaprWorkflowClient({
    daprHost: DAPR_HOST,
    daprPort: DAPR_HTTP_PORT,
  });
}

export async function startOnboardingWorkflow(
  client: DaprWorkflowClient,
  input: OnboardProjectRequest,
  instanceId?: string
): Promise<string> {
  const id = instanceId ?? crypto.randomUUID();
  await client.scheduleNewWorkflow(onboardingWorkflow, input, id);
  return id;
}

export async function raiseOnboardingEvent(
  client: DaprWorkflowClient,
  instanceId: string,
  eventName: string,
  eventData?: unknown
): Promise<void> {
  await client.raiseEvent(instanceId, eventName, eventData);
}
```

**Step 2: Verify typecheck**

Run: `bun run --filter @mesh-six/onboarding-service typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/onboarding-service/src/workflow.ts
git commit -m "implement Dapr Workflow with 3 phases and 12 activities"
```

---

## Task 9: HTTP Server + Routes

Create the Hono server with health checks, onboarding endpoints, and Dapr integration.

**Files:**
- Create: `apps/onboarding-service/src/index.ts`

**Step 1: Write the server**

Follow the pattern from `apps/project-manager/src/index.ts`:

```typescript
import { Hono } from "hono";
import pg from "pg";
import {
  APP_PORT,
  AGENT_ID,
  AGENT_NAME,
  DATABASE_URL,
} from "./config.js";
import { insertRun, getRun, updateRunStatus } from "./db.js";
import { OnboardProjectRequestSchema, AuthCallbackSchema } from "./schemas.js";
import {
  createWorkflowRuntime,
  createWorkflowClient,
  startOnboardingWorkflow,
  raiseOnboardingEvent,
} from "./workflow.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL });

const app = new Hono();

// --- Health ---
app.get("/healthz", (c) =>
  c.json({ status: "ok", agent: AGENT_ID, name: AGENT_NAME })
);

app.get("/readyz", (c) => c.json({ status: "ok" }));

// --- Dapr subscribe (no pub/sub topics needed) ---
app.get("/dapr/subscribe", (c): Response => c.json([]));

// --- Onboarding endpoints ---

app.post("/onboard", async (c) => {
  const body = await c.req.json();
  const parsed = OnboardProjectRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const input = parsed.data;

  // Create run record
  const runId = crypto.randomUUID();
  await insertRun(pool, {
    id: runId,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
  });

  // Start workflow
  try {
    const client = createWorkflowClient();
    await startOnboardingWorkflow(client, input, runId);
    await updateRunStatus(pool, runId, { status: "running" });
  } catch (err) {
    await updateRunStatus(pool, runId, {
      status: "failed",
      errorMessage: String(err),
    });
    return c.json({ id: runId, status: "failed", error: String(err) }, 500);
  }

  return c.json({ id: runId, status: "running" }, 202);
});

app.get("/onboard/:id", async (c) => {
  const id = c.req.param("id");
  const run = await getRun(pool, id);
  if (!run) return c.json({ error: "Not found" }, 404);
  return c.json(run);
});

app.post("/onboard/:id/auth-callback", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = AuthCallbackSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid callback", details: parsed.error.issues }, 400);
  }

  const run = await getRun(pool, id);
  if (!run) return c.json({ error: "Not found" }, 404);
  if (run.status !== "waiting_auth") {
    return c.json({ error: `Run is in '${run.status}' state, not waiting_auth` }, 409);
  }

  // Raise external event to resume workflow
  const client = createWorkflowClient();
  await raiseOnboardingEvent(client, id, "oauth-code-received", parsed.data);
  await updateRunStatus(pool, id, { status: "running" });

  return c.json({ status: "resumed" });
});

// --- Lifecycle ---
let workflowRuntime: ReturnType<typeof createWorkflowRuntime> | null = null;

async function start(): Promise<void> {
  workflowRuntime = createWorkflowRuntime(pool);
  await workflowRuntime.start();
  console.log(`[${AGENT_ID}] Workflow runtime started`);

  Bun.serve({ port: APP_PORT, fetch: app.fetch });
  console.log(`[${AGENT_ID}] Listening on port ${APP_PORT}`);
}

async function shutdown(): Promise<void> {
  console.log(`[${AGENT_ID}] Shutting down...`);
  if (workflowRuntime) {
    await workflowRuntime.stop();
  }
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

process.on("unhandledRejection", (reason) => {
  const msg = String(reason);
  if (msg.includes("UNIMPLEMENTED") || msg.includes("grpc") || msg.includes("durabletask")) {
    console.warn(`[${AGENT_ID}] gRPC stream error (non-fatal):`, msg);
    workflowRuntime = null;
  } else {
    console.error(`[${AGENT_ID}] Unhandled rejection:`, reason);
    process.exit(1);
  }
});

start().catch((err) => {
  console.error(`[${AGENT_ID}] Failed to start:`, err);
  process.exit(1);
});
```

**Step 2: Verify typecheck**

Run: `bun run --filter @mesh-six/onboarding-service typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/onboarding-service/src/index.ts
git commit -m "add Hono server with onboarding HTTP endpoints and lifecycle"
```

---

## Task 10: MCP Server

Add MCP tool definitions for programmatic onboarding from Claude Code or other agents.

**Files:**
- Create: `apps/onboarding-service/src/mcp.ts`
- Modify: `apps/onboarding-service/src/index.ts` (mount MCP SSE endpoint and stdio mode)

**Step 1: Write MCP tool definitions**

Create `apps/onboarding-service/src/mcp.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";
import { insertRun, getRun, updateRunStatus } from "./db.js";
import { OnboardProjectRequestSchema, AuthCallbackSchema } from "./schemas.js";
import {
  createWorkflowClient,
  startOnboardingWorkflow,
  raiseOnboardingEvent,
} from "./workflow.js";

export function createMcpServer(pool: pg.Pool): McpServer {
  const server = new McpServer({
    name: "mesh-six-onboarding",
    version: "0.1.0",
  });

  server.tool(
    "onboard-project",
    "Start onboarding a new project into mesh-six. Creates GitHub project board, provisions Envbuilder pod, and optionally runs Claude OAuth + LiteLLM setup.",
    {
      repoOwner: z.string().describe("GitHub org or user"),
      repoName: z.string().describe("Repository name"),
      displayName: z.string().optional().describe("Human-friendly project name"),
      defaultBranch: z.string().optional().describe("Default branch (defaults to main)"),
      skipAuth: z.boolean().optional().describe("Skip Claude OAuth flow"),
      skipLiteLLM: z.boolean().optional().describe("Skip LiteLLM routing setup"),
    },
    async (params) => {
      const parsed = OnboardProjectRequestSchema.safeParse(params);
      if (!parsed.success) {
        return { content: [{ type: "text" as const, text: `Invalid input: ${parsed.error.message}` }] };
      }

      const runId = crypto.randomUUID();
      await insertRun(pool, {
        id: runId,
        repoOwner: parsed.data.repoOwner,
        repoName: parsed.data.repoName,
      });

      const client = createWorkflowClient();
      await startOnboardingWorkflow(client, parsed.data, runId);
      await updateRunStatus(pool, runId, { status: "running" });

      return {
        content: [{
          type: "text" as const,
          text: `Onboarding started for ${parsed.data.repoOwner}/${parsed.data.repoName}.\nWorkflow ID: ${runId}\nUse get-onboarding-status to check progress.`,
        }],
      };
    }
  );

  server.tool(
    "get-onboarding-status",
    "Check the status of an onboarding workflow.",
    { workflowId: z.string().describe("The workflow ID returned by onboard-project") },
    async (params) => {
      const run = await getRun(pool, params.workflowId);
      if (!run) {
        return { content: [{ type: "text" as const, text: "Workflow not found." }] };
      }

      let text = `Status: ${run.status}\nPhase: ${run.currentPhase ?? "not started"}\nActivity: ${run.currentActivity ?? "none"}\nCompleted: ${run.completedActivities.join(", ") || "none"}`;

      if (run.oauthDeviceUrl) {
        text += `\n\nClaude OAuth required:\n  Visit: ${run.oauthDeviceUrl}\n  Code: ${run.oauthUserCode}\n  Then use submit-oauth-code to resume.`;
      }

      if (run.errorMessage) {
        text += `\n\nError: ${run.errorMessage}`;
      }

      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "submit-oauth-code",
    "Submit Claude OAuth tokens after completing the device flow to resume the onboarding workflow.",
    {
      workflowId: z.string().describe("The workflow ID"),
      accessToken: z.string().describe("Claude access token"),
      refreshToken: z.string().describe("Claude refresh token"),
      expiresAt: z.string().describe("Token expiry ISO datetime"),
    },
    async (params) => {
      const parsed = AuthCallbackSchema.safeParse(params);
      if (!parsed.success) {
        return { content: [{ type: "text" as const, text: `Invalid input: ${parsed.error.message}` }] };
      }

      const run = await getRun(pool, params.workflowId);
      if (!run) {
        return { content: [{ type: "text" as const, text: "Workflow not found." }] };
      }

      const client = createWorkflowClient();
      await raiseOnboardingEvent(client, params.workflowId, "oauth-code-received", parsed.data);
      await updateRunStatus(pool, params.workflowId, { status: "running" });

      return { content: [{ type: "text" as const, text: "OAuth tokens submitted. Workflow resumed." }] };
    }
  );

  return server;
}

export async function startMcpStdio(pool: pg.Pool): Promise<void> {
  const server = createMcpServer(pool);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

**Step 2: Add MCP SSE mount and stdio mode to index.ts**

Add to `apps/onboarding-service/src/index.ts` before the `start()` function:

After the existing imports, add:
```typescript
import { createMcpServer, startMcpStdio } from "./mcp.js";
```

Before `start()`, add stdio mode check:
```typescript
// If invoked with --mcp flag, run as MCP stdio server instead of HTTP
if (process.argv.includes("--mcp")) {
  startMcpStdio(pool).catch((err) => {
    console.error("MCP stdio server failed:", err);
    process.exit(1);
  });
} else {
  start().catch((err) => {
    console.error(`[${AGENT_ID}] Failed to start:`, err);
    process.exit(1);
  });
}
```

Remove the existing `start().catch(...)` at the bottom since it's now inside the else branch.

**Step 3: Verify typecheck**

Run: `bun run --filter @mesh-six/onboarding-service typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/onboarding-service/src/mcp.ts apps/onboarding-service/src/index.ts
git commit -m "add MCP server with onboard-project, get-status, and submit-oauth tools"
```

---

## Task 11: K8s Deployment Manifests

Create the Kustomize manifests for the onboarding service and register it in the top-level kustomization.

**Files:**
- Create: `k8s/base/onboarding-service/deployment.yaml`
- Create: `k8s/base/onboarding-service/service.yaml`
- Create: `k8s/base/onboarding-service/kustomization.yaml`
- Modify: `k8s/base/kustomization.yaml` (add `onboarding-service/` to resources)

**Step 1: Create deployment.yaml**

Follow `k8s/base/auth-service/deployment.yaml` pattern exactly:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: onboarding-service
  namespace: mesh-six
  labels:
    app: onboarding-service
    app.kubernetes.io/part-of: mesh-six
spec:
  replicas: 1
  selector:
    matchLabels:
      app: onboarding-service
  template:
    metadata:
      labels:
        app: onboarding-service
      annotations:
        dapr.io/enabled: "true"
        dapr.io/app-id: "onboarding-service"
        dapr.io/app-port: "3000"
        dapr.io/log-level: "info"
        dapr.io/enable-metrics: "true"
        dapr.io/metrics-port: "9090"
    spec:
      containers:
        - name: onboarding-service
          image: registry.bto.bar/jaybrto/mesh-six-onboarding-service:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 3000
              name: http
          env:
            - name: APP_PORT
              value: "3000"
            - name: AGENT_ID
              value: "onboarding-service"
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
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: GITHUB_TOKEN
            - name: VAULT_ADDR
              value: "http://vault.vault.svc.cluster.local:8200"
            - name: VAULT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: VAULT_TOKEN
            - name: LITELLM_URL
              value: "http://litellm.k3s.bto.bar"
            - name: LITELLM_ADMIN_KEY
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: LITELLM_ADMIN_KEY
            - name: MINIO_ENDPOINT
              value: "http://minio.default.svc.cluster.local:9000"
            - name: MINIO_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: MINIO_ACCESS_KEY
            - name: MINIO_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: MINIO_SECRET_KEY
          readinessProbe:
            httpGet:
              path: /readyz
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 15
            periodSeconds: 20
          resources:
            requests:
              memory: "128Mi"
              cpu: "50m"
            limits:
              memory: "256Mi"
              cpu: "200m"
```

**Step 2: Create service.yaml**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: onboarding-service
  namespace: mesh-six
  labels:
    app: onboarding-service
    app.kubernetes.io/part-of: mesh-six
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: 3000
      protocol: TCP
      name: http
  selector:
    app: onboarding-service
```

**Step 3: Create kustomization.yaml**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
```

**Step 4: Add to top-level kustomization**

In `k8s/base/kustomization.yaml`, add `- onboarding-service/` to the resources list (after `- implementer/`).

**Step 5: Verify manifests**

Run: `kubectl apply --dry-run=client -k k8s/base/onboarding-service/ 2>&1`
Expected: deployment and service validated

**Step 6: Commit**

```bash
git add k8s/base/onboarding-service/ k8s/base/kustomization.yaml
git commit -m "add onboarding-service K8s deployment manifests"
```

---

## Task 12: Dev Container Feature — mesh-six-tools

Create the custom dev container feature that replaces `docker/Dockerfile.implementer` for Envbuilder-based pods.

**Files:**
- Create: `devcontainer-features/mesh-six-tools/devcontainer-feature.json`
- Create: `devcontainer-features/mesh-six-tools/install.sh`

**Step 1: Create feature metadata**

Create `devcontainer-features/mesh-six-tools/devcontainer-feature.json`:

```json
{
  "id": "mesh-six-tools",
  "version": "1.0.0",
  "name": "mesh-six Agent Tools",
  "description": "System tools, Claude CLI, and entrypoint for mesh-six agent pods",
  "options": {
    "claudeVersion": {
      "type": "string",
      "default": "latest",
      "description": "Claude Code CLI version (npm semver)"
    }
  },
  "installsAfter": [
    "ghcr.io/devcontainers/features/node"
  ],
  "containerEnv": {
    "MESH_SIX_TOOLS_VERSION": "${templateOption:claudeVersion}"
  }
}
```

**Step 2: Create install.sh**

Create `devcontainer-features/mesh-six-tools/install.sh`:

```bash
#!/bin/bash
set -e

CLAUDE_VERSION="${CLAUDEVERSION:-latest}"

echo "Installing mesh-six tools with Claude Code v${CLAUDE_VERSION}..."

# System dependencies
apt-get update && apt-get install -y --no-install-recommends \
    tmux \
    curl \
    jq \
    watch \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg
chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) \
    signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
    https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (Node.js must be available — installsAfter guarantees this)
if command -v npm &> /dev/null; then
    if [ "$CLAUDE_VERSION" = "latest" ]; then
        npm install -g @anthropic-ai/claude-code
    else
        npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}"
    fi
    npm cache clean --force
else
    echo "WARNING: npm not found. Claude Code CLI not installed."
    echo "Add ghcr.io/devcontainers/features/node to your devcontainer.json features."
fi

echo "mesh-six tools installation complete."
```

**Step 3: Commit**

```bash
git add devcontainer-features/ templates/devcontainer/
git commit -m "add mesh-six-tools dev container feature and devcontainer template"
```

---

## Task 13: Integration — Full Typecheck + Verify

Run the full workspace typecheck to confirm everything compiles together.

**Step 1: Install dependencies**

Run: `bun install`

**Step 2: Typecheck all packages**

Run: `bun run typecheck`
Expected: All packages pass typecheck

**Step 3: Run core tests**

Run: `bun run --filter @mesh-six/core test`
Expected: All tests pass

**Step 4: Run onboarding-service tests**

Run: `bun run --filter @mesh-six/onboarding-service test`
Expected: Schema and type tests pass

**Step 5: Fix any issues and commit**

```bash
git add -A
git commit -m "fix: integration issues from onboarding-service"
```

---

## Task 14: Update Documentation

Run the `update-docs` skill to update CHANGELOG.md, CLAUDE.md, and agent definitions.

**Step 1: Invoke the update-docs skill**

This skill updates:
- `CHANGELOG.md` — add onboarding-service entries
- `CLAUDE.md` — add onboarding-service to Key Packages section, document MCP tools,
  document the `k8s/base/envs/` pattern for generated manifests
- Agent definitions if applicable

**Step 2: Bump version in package.json**

Update `apps/onboarding-service/package.json` version to `0.1.0` (already set).

**Step 3: Commit docs**

```bash
git add CHANGELOG.md CLAUDE.md apps/onboarding-service/package.json
git commit -m "docs: add onboarding-service to CHANGELOG and CLAUDE.md"
```
