import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type pg from "pg";
import { insertRun, getRun } from "./db.js";
import { OnboardProjectRequestSchema } from "./schemas.js";
import {
  createWorkflowClient,
  startOnboardingWorkflow,
  raiseOnboardingEvent,
  type OnboardingWorkflowInput,
} from "./workflow.js";

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

export function createMcpServer(pool: pg.Pool): McpServer {
  const server = new McpServer({
    name: "onboarding-service",
    version: "0.1.0",
  });

  const workflowClient = createWorkflowClient();

  // -------------------------------------------------------------------------
  // Tool: onboard-project
  // -------------------------------------------------------------------------

  server.tool(
    "onboard-project",
    "Onboard a new GitHub repository into the mesh-six system. Creates a GitHub Projects board, provisions backend storage, generates Kubernetes manifests, and optionally configures Claude OAuth and LiteLLM.",
    {
      repoOwner: z.string().describe("GitHub repository owner (user or org)"),
      repoName: z.string().describe("GitHub repository name"),
      displayName: z.string().optional().describe("Human-friendly display name for the project board"),
      defaultBranch: z.string().optional().describe("Default branch name (defaults to 'main')"),
      skipAuth: z.boolean().optional().describe("Skip Claude OAuth setup"),
      skipLiteLLM: z.boolean().optional().describe("Skip LiteLLM team provisioning"),
    },
    async ({ repoOwner, repoName, displayName, defaultBranch, skipAuth, skipLiteLLM }) => {
      const requestData = OnboardProjectRequestSchema.parse({
        repoOwner,
        repoName,
        displayName,
        defaultBranch,
        skipAuth: skipAuth ?? false,
        skipLiteLLM: skipLiteLLM ?? false,
      });

      const runId = crypto.randomUUID();
      await insertRun(pool, { id: runId, repoOwner, repoName });

      const workflowInput: OnboardingWorkflowInput = {
        ...requestData,
        runId,
      };

      await startOnboardingWorkflow(workflowClient, workflowInput, runId);

      return {
        content: [
          {
            type: "text",
            text: `Onboarding started for ${repoOwner}/${repoName}.\nWorkflow ID: ${runId}\nStatus: pending\n\nUse get-onboarding-status with workflowId="${runId}" to check progress.`,
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: get-onboarding-status
  // -------------------------------------------------------------------------

  server.tool(
    "get-onboarding-status",
    "Get the current status and progress of an onboarding workflow.",
    {
      workflowId: z.string().describe("The workflow/run ID returned by onboard-project"),
    },
    async ({ workflowId }) => {
      const run = await getRun(pool, workflowId);
      if (!run) {
        return {
          content: [
            {
              type: "text",
              text: `No onboarding run found with ID: ${workflowId}`,
            },
          ],
        };
      }

      const lines: string[] = [
        `Onboarding run: ${run.id}`,
        `Repository: ${run.repoOwner}/${run.repoName}`,
        `Status: ${run.status}`,
        `Phase: ${run.currentPhase ?? "—"}`,
        `Current activity: ${run.currentActivity ?? "—"}`,
        `Completed activities: ${run.completedActivities.length > 0 ? run.completedActivities.join(", ") : "none"}`,
        `Created: ${run.createdAt.toISOString()}`,
        `Updated: ${run.updatedAt.toISOString()}`,
      ];

      if (run.status === "waiting_auth" && run.oauthDeviceUrl) {
        lines.push("");
        lines.push(`--- OAuth Authorization Required ---`);
        lines.push(`Visit: ${run.oauthDeviceUrl}`);
        if (run.oauthUserCode) {
          lines.push(`User code: ${run.oauthUserCode}`);
        }
        lines.push(`Then call submit-oauth-code with the resulting tokens.`);
      }

      if (run.status === "failed" && run.errorMessage) {
        lines.push("");
        lines.push(`Error: ${run.errorMessage}`);
      }

      return {
        content: [
          {
            type: "text",
            text: lines.join("\n"),
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: submit-oauth-code
  // -------------------------------------------------------------------------

  server.tool(
    "submit-oauth-code",
    "Submit Claude OAuth tokens after completing the device authorization flow. Call this after the user has authorized access at the device URL.",
    {
      workflowId: z.string().describe("The workflow/run ID that is waiting for OAuth"),
      accessToken: z.string().describe("Claude OAuth access token"),
      refreshToken: z.string().describe("Claude OAuth refresh token"),
      expiresAt: z.string().describe("ISO 8601 datetime when the access token expires"),
    },
    async ({ workflowId, accessToken, refreshToken, expiresAt }) => {
      await raiseOnboardingEvent(workflowClient, workflowId, "oauth-code-received", {
        accessToken,
        refreshToken,
        expiresAt,
      });

      return {
        content: [
          {
            type: "text",
            text: `OAuth tokens submitted for workflow ${workflowId}. The onboarding workflow has been resumed and will now store the credentials and complete configuration.`,
          },
        ],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Stdio transport entry point
// ---------------------------------------------------------------------------

export async function startMcpStdio(pool: pg.Pool): Promise<void> {
  const server = createMcpServer(pool);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[onboarding-service] MCP stdio server running");
}
