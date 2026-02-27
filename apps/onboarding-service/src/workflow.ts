import {
  WorkflowRuntime,
  WorkflowActivityContext,
  WorkflowContext,
  type TWorkflow,
  DaprWorkflowClient,
} from "@dapr/dapr";

import type pg from "pg";

import type { OnboardProjectRequest, AuthCallback } from "./schemas.js";

import { validateRepo, type ValidateRepoInput, type ValidateRepoOutput } from "./activities/validate-repo.js";
import { createProjectBoard, type CreateProjectBoardInput, type CreateProjectBoardOutput } from "./activities/create-project-board.js";
import { registerWebhookSecret, type RegisterWebhookSecretInput, type RegisterWebhookSecretOutput } from "./activities/register-webhook-secret.js";
import { registerInDatabase, type RegisterInDatabaseInput } from "./activities/register-in-database.js";
import { provisionBackend, type ProvisionBackendInput } from "./activities/provision-backend.js";
import { scaffoldDevcontainer, type ScaffoldDevcontainerInput, type ScaffoldDevcontainerResult } from "./activities/scaffold-devcontainer.js";
import { generateKubeManifests, type GenerateKubeManifestsInput, type GenerateKubeManifestsResult } from "./activities/generate-kube-manifests.js";
import { updateKustomization, type UpdateKustomizationInput, type UpdateKustomizationResult } from "./activities/update-kustomization.js";
import { triggerSync, type TriggerSyncInput, type TriggerSyncResult } from "./activities/trigger-sync.js";
import { verifyPodHealth, type VerifyPodHealthInput, type VerifyPodHealthResult } from "./activities/verify-pod-health.js";
import { initiateClaudeOAuth, type ClaudeOAuthResult } from "./activities/initiate-claude-oauth.js";
import { storeClaudeCredentials, type StoreClaudeCredentialsInput } from "./activities/store-claude-credentials.js";
import { configureLitellm, type ConfigureLitellmInput, type ConfigureLitellmResult } from "./activities/configure-litellm.js";
import { configureAppSettings, type ConfigureAppSettingsInput } from "./activities/configure-app-settings.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

// ---------------------------------------------------------------------------
// Workflow input/output types
// ---------------------------------------------------------------------------

export interface OnboardingWorkflowInput extends OnboardProjectRequest {
  runId: string;
}

export interface OnboardingWorkflowResult {
  status: "completed";
}

// ---------------------------------------------------------------------------
// Activity type alias
// ---------------------------------------------------------------------------

type ActivityFn<TInput = unknown, TOutput = unknown> = (
  ctx: WorkflowActivityContext,
  input: TInput
) => Promise<TOutput>;

// ---------------------------------------------------------------------------
// Activity stub variables (replaced at runtime via createWorkflowRuntime)
// ---------------------------------------------------------------------------

export let validateRepoActivity: ActivityFn<ValidateRepoInput, ValidateRepoOutput> = async () => {
  throw new Error("validateRepoActivity not initialized");
};

export let createProjectBoardActivity: ActivityFn<CreateProjectBoardInput, CreateProjectBoardOutput> = async () => {
  throw new Error("createProjectBoardActivity not initialized");
};

export let registerWebhookSecretActivity: ActivityFn<RegisterWebhookSecretInput, RegisterWebhookSecretOutput> = async () => {
  throw new Error("registerWebhookSecretActivity not initialized");
};

export let registerInDatabaseActivity: ActivityFn<RegisterInDatabaseInput, void> = async () => {
  throw new Error("registerInDatabaseActivity not initialized");
};

export let provisionBackendActivity: ActivityFn<ProvisionBackendInput, void> = async () => {
  throw new Error("provisionBackendActivity not initialized");
};

export let scaffoldDevcontainerActivity: ActivityFn<ScaffoldDevcontainerInput, ScaffoldDevcontainerResult> = async () => {
  throw new Error("scaffoldDevcontainerActivity not initialized");
};

export let generateKubeManifestsActivity: ActivityFn<GenerateKubeManifestsInput, GenerateKubeManifestsResult> = async () => {
  throw new Error("generateKubeManifestsActivity not initialized");
};

export let updateKustomizationActivity: ActivityFn<UpdateKustomizationInput, UpdateKustomizationResult> = async () => {
  throw new Error("updateKustomizationActivity not initialized");
};

export let triggerSyncActivity: ActivityFn<TriggerSyncInput, TriggerSyncResult> = async () => {
  throw new Error("triggerSyncActivity not initialized");
};

export let verifyPodHealthActivity: ActivityFn<VerifyPodHealthInput, VerifyPodHealthResult> = async () => {
  throw new Error("verifyPodHealthActivity not initialized");
};

export let initiateClaudeOAuthActivity: ActivityFn<void, ClaudeOAuthResult> = async () => {
  throw new Error("initiateClaudeOAuthActivity not initialized");
};

export let storeClaudeCredentialsActivity: ActivityFn<StoreClaudeCredentialsInput, void> = async () => {
  throw new Error("storeClaudeCredentialsActivity not initialized");
};

export let configureLitellmActivity: ActivityFn<ConfigureLitellmInput, ConfigureLitellmResult> = async () => {
  throw new Error("configureLitellmActivity not initialized");
};

export let configureAppSettingsActivity: ActivityFn<ConfigureAppSettingsInput, void> = async () => {
  throw new Error("configureAppSettingsActivity not initialized");
};

// ---------------------------------------------------------------------------
// Main Workflow
// ---------------------------------------------------------------------------

export const onboardingWorkflow: TWorkflow = async function* (
  ctx: WorkflowContext,
  input: OnboardingWorkflowInput
): any {
  const {
    runId,
    repoOwner,
    repoName,
    displayName,
    defaultBranch,
    skipAuth,
    skipLiteLLM,
    resourceLimits,
    litellm,
    settings,
  } = input;

  console.log(`[onboarding-workflow] Starting onboarding for ${repoOwner}/${repoName} (run=${runId})`);

  // =========================================================================
  // Phase 1: Repository validation and registration
  // =========================================================================

  // Step 1: Validate repo exists on GitHub
  const repoInfo: ValidateRepoOutput = yield ctx.callActivity(validateRepoActivity, {
    repoOwner,
    repoName,
  });

  // Step 2: Create GitHub Projects board
  const boardInfo: CreateProjectBoardOutput = yield ctx.callActivity(createProjectBoardActivity, {
    repoOwner,
    repoName,
    ownerNodeId: repoInfo.ownerNodeId,
    repoNodeId: repoInfo.repoNodeId,
    displayName,
  });

  // Step 3: Register webhook secret in Vault
  const webhookInfo: RegisterWebhookSecretOutput = yield ctx.callActivity(registerWebhookSecretActivity, {
    repoOwner,
    repoName,
  });

  // Step 4: Register repo + project in PostgreSQL
  yield ctx.callActivity(registerInDatabaseActivity, {
    repoOwner,
    repoName,
    fullName: repoInfo.fullName,
    defaultBranch: defaultBranch ?? repoInfo.defaultBranch,
    repoNodeId: repoInfo.repoNodeId,
    projectId: boardInfo.projectId,
    projectUrl: boardInfo.projectUrl,
    projectNumber: boardInfo.projectNumber,
    statusFieldId: boardInfo.statusFieldId,
    sessionIdFieldId: boardInfo.sessionIdFieldId,
    podNameFieldId: boardInfo.podNameFieldId,
    workflowIdFieldId: boardInfo.workflowIdFieldId,
    priorityFieldId: boardInfo.priorityFieldId,
    webhookSecretPath: webhookInfo.secretPath,
  });

  // Step 5: Provision backend storage (PostgreSQL + MinIO prefix)
  yield ctx.callActivity(provisionBackendActivity, {
    repoOwner,
    repoName,
  });

  // =========================================================================
  // Phase 2: Kubernetes setup
  // =========================================================================

  // Step 6: Scaffold devcontainer in the target repo
  yield ctx.callActivity(scaffoldDevcontainerActivity, {
    repoOwner,
    repoName,
    defaultBranch: defaultBranch ?? repoInfo.defaultBranch,
  });

  // Step 7: Generate Kubernetes manifests for the env pod
  const manifestsResult: GenerateKubeManifestsResult = yield ctx.callActivity(generateKubeManifestsActivity, {
    repoOwner,
    repoName,
    resourceLimits,
  });

  // Step 8: Update root kustomization.yaml to include the new env
  yield ctx.callActivity(updateKustomizationActivity, {
    repoOwner,
    repoName,
  });

  // Step 9: Commit and push k8s manifests (triggers ArgoCD sync)
  yield ctx.callActivity(triggerSyncActivity, {
    repoOwner,
    repoName,
    manifestDir: manifestsResult.dir,
  });

  // Step 10: Poll until the env pod is healthy
  yield ctx.callActivity(verifyPodHealthActivity, {
    repoOwner,
    repoName,
  });

  // =========================================================================
  // Phase 3: Auth and configuration
  // =========================================================================

  if (!skipAuth) {
    // Step 11: Initiate Claude OAuth device flow
    const oauthResult: ClaudeOAuthResult = yield ctx.callActivity(initiateClaudeOAuthActivity, undefined);

    // Wait for the OAuth callback (user completes the device authorization flow)
    const authCallback: AuthCallback = yield ctx.waitForExternalEvent("oauth-code-received");

    // Step 12: Push Claude credentials to auth-service
    yield ctx.callActivity(storeClaudeCredentialsActivity, {
      projectId: boardInfo.projectId,
      accessToken: authCallback.accessToken,
      refreshToken: authCallback.refreshToken,
      expiresAt: authCallback.expiresAt,
    });

    void oauthResult; // suppress unused warning — deviceUrl/userCode surfaced via DB
  }

  if (!skipLiteLLM) {
    // Step 13: Create LiteLLM team + virtual key for this repo
    yield ctx.callActivity(configureLitellmActivity, {
      repoOwner,
      repoName,
      teamAlias: litellm?.teamAlias,
      defaultModel: litellm?.defaultModel,
      maxBudget: litellm?.maxBudget,
    });
  }

  if (settings) {
    // Step 14: Push app settings to auth-service
    yield ctx.callActivity(configureAppSettingsActivity, {
      projectId: boardInfo.projectId,
      settings,
    });
  }

  console.log(`[onboarding-workflow] Completed onboarding for ${repoOwner}/${repoName} (run=${runId})`);

  return { status: "completed" } satisfies OnboardingWorkflowResult;
};

// ---------------------------------------------------------------------------
// Runtime builder
// ---------------------------------------------------------------------------

export function createWorkflowRuntime(pool: pg.Pool): WorkflowRuntime {
  // Wire implementations to module-level stubs

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

  configureLitellmActivity = async (_ctx, input) => configureLitellm(input);

  configureAppSettingsActivity = async (_ctx, input) => configureAppSettings(input);

  const runtime = new WorkflowRuntime({
    daprHost: DAPR_HOST,
    daprPort: DAPR_HTTP_PORT,
  });

  // Register the workflow
  runtime.registerWorkflow(onboardingWorkflow);

  // Register all activities
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
  runtime.registerActivity(configureLitellmActivity);
  runtime.registerActivity(configureAppSettingsActivity);

  return runtime;
}

// ---------------------------------------------------------------------------
// Workflow client helpers
// ---------------------------------------------------------------------------

export function createWorkflowClient(): DaprWorkflowClient {
  return new DaprWorkflowClient({
    daprHost: DAPR_HOST,
    daprPort: DAPR_HTTP_PORT,
  });
}

export async function startOnboardingWorkflow(
  client: DaprWorkflowClient,
  input: OnboardingWorkflowInput,
  instanceId?: string
): Promise<string> {
  const workflowInstanceId = instanceId ?? crypto.randomUUID();
  await client.scheduleNewWorkflow(onboardingWorkflow, input, workflowInstanceId);
  console.log(`[onboarding-workflow] Started workflow instance ${workflowInstanceId} for ${input.repoOwner}/${input.repoName}`);
  return workflowInstanceId;
}

export async function raiseOnboardingEvent(
  client: DaprWorkflowClient,
  instanceId: string,
  eventName: string,
  eventData?: unknown
): Promise<void> {
  await client.raiseEvent(instanceId, eventName, eventData ?? {});
  console.log(`[onboarding-workflow] Raised event "${eventName}" on instance ${instanceId}`);
}
