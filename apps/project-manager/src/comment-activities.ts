/**
 * Workflow activities for posting and updating GitHub issue/PR comments.
 *
 * Each activity creates its own GitHubProjectClient from env vars so they
 * are safe to call from Dapr Workflow activity context (no shared state).
 */

import type { WorkflowActivityContext } from "@dapr/dapr";
import {
  GitHubProjectClient,
  formatStatusComment,
  generateComment,
  type CommentOptions,
} from "@mesh-six/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildClient(): GitHubProjectClient {
  const token = process.env.GITHUB_TOKEN ?? "";
  const projectId = process.env.GITHUB_PROJECT_ID ?? "";
  const statusFieldId = process.env.GITHUB_STATUS_FIELD_ID ?? "";

  if (!token) {
    throw new Error("GITHUB_TOKEN env var is required for comment activities");
  }

  return new GitHubProjectClient({ token, projectId, statusFieldId });
}

// ---------------------------------------------------------------------------
// Activity: postStatusComment
// ---------------------------------------------------------------------------

export interface PostStatusCommentInput {
  owner: string;
  repo: string;
  issueNumber: number;
  status: string;
  details: Record<string, unknown>;
}

/**
 * Create or update the persistent status comment on an issue.
 * Uses the hidden marker `<!-- mesh-six-status -->` to locate existing comment.
 */
export async function postStatusComment(
  _ctx: WorkflowActivityContext,
  input: PostStatusCommentInput
): Promise<void> {
  const client = buildClient();
  const { owner, repo, issueNumber, status, details } = input;

  const body = formatStatusComment(status, details);

  const existingId = await client.findBotComment(owner, repo, issueNumber, "mesh-six-status");
  await client.createOrUpdateComment(owner, repo, issueNumber, body, existingId ?? undefined);

  console.log(
    `[comment-activities] Status comment ${existingId ? "updated" : "created"} on ${owner}/${repo}#${issueNumber} phase=${status}`
  );
}

// ---------------------------------------------------------------------------
// Activity: postProgressComment
// ---------------------------------------------------------------------------

export interface PostProgressCommentInput {
  owner: string;
  repo: string;
  issueNumber: number;
  phase: string;
  progress: string;
}

/**
 * Create or update a progress comment on an issue.
 * Uses the hidden marker `<!-- mesh-six-progress -->`.
 */
export async function postProgressComment(
  _ctx: WorkflowActivityContext,
  input: PostProgressCommentInput
): Promise<void> {
  const client = buildClient();
  const { owner, repo, issueNumber, phase, progress } = input;

  const opts: CommentOptions = {
    type: "progress",
    issueNumber,
    repoOwner: owner,
    repoName: repo,
    context: { phase, progress },
  };

  const commentText = await generateComment(opts);
  const body = `<!-- mesh-six-progress -->\n${commentText}`;

  const existingId = await client.findBotComment(owner, repo, issueNumber, "mesh-six-progress");
  await client.createOrUpdateComment(owner, repo, issueNumber, body, existingId ?? undefined);

  console.log(
    `[comment-activities] Progress comment ${existingId ? "updated" : "created"} on ${owner}/${repo}#${issueNumber} phase=${phase}`
  );
}

// ---------------------------------------------------------------------------
// Activity: syncPlanToIssue
// ---------------------------------------------------------------------------

export interface SyncPlanToIssueInput {
  owner: string;
  repo: string;
  issueNumber: number;
  planSummary: string;
}

/**
 * Post the implementation plan as a comment on the issue.
 * Uses the hidden marker `<!-- mesh-six-plan -->` so it can be updated if the plan changes.
 */
export async function syncPlanToIssue(
  _ctx: WorkflowActivityContext,
  input: SyncPlanToIssueInput
): Promise<void> {
  const client = buildClient();
  const { owner, repo, issueNumber, planSummary } = input;

  const body = `<!-- mesh-six-plan -->\n**Implementation Plan**\n\n${planSummary}\n\n_Posted by mesh-six Project Manager_`;

  const existingId = await client.findBotComment(owner, repo, issueNumber, "mesh-six-plan");
  await client.createOrUpdateComment(owner, repo, issueNumber, body, existingId ?? undefined);

  console.log(
    `[comment-activities] Plan comment ${existingId ? "updated" : "created"} on ${owner}/${repo}#${issueNumber}`
  );
}

// ---------------------------------------------------------------------------
// Activity: updateProjectCustomFields
// ---------------------------------------------------------------------------

export interface UpdateProjectCustomFieldsInput {
  projectId: string;
  itemId: string;
  fields: Record<string, string>;
}

/**
 * Update one or more custom fields on a GitHub Projects v2 item.
 * `fields` maps field ID → string value.
 */
export async function updateProjectCustomFields(
  _ctx: WorkflowActivityContext,
  input: UpdateProjectCustomFieldsInput
): Promise<void> {
  const client = buildClient();
  const { itemId, fields } = input;

  for (const [fieldId, value] of Object.entries(fields)) {
    await client.updateProjectItemField(itemId, fieldId, value);
    console.log(
      `[comment-activities] Updated project field ${fieldId}=${value} on item ${itemId}`
    );
  }
}
