/**
 * GitHub integration helpers for the implementer actor.
 *
 * Provides PR creation via the `gh` CLI and structured comment posting
 * using the shared GitHubProjectClient and comment-generator utilities.
 */

import { GitHubProjectClient, generateComment, type CommentOptions } from "@mesh-six/core";

const log = (msg: string) => console.log(`[implementer][github-integration] ${msg}`);

// ---------------------------------------------------------------------------
// PR Creation
// ---------------------------------------------------------------------------

export interface CreatePROpts {
  repoDir: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
}

/**
 * Create a pull request using the `gh` CLI in the given repo directory.
 * Returns the PR number on success.
 */
export async function createPR(opts: CreatePROpts): Promise<{ prNumber: number; url: string }> {
  const { repoDir, baseBranch, headBranch, title, body } = opts;

  log(`Creating PR: ${headBranch} -> ${baseBranch} in ${repoDir}`);

  const proc = Bun.spawn(
    [
      "gh", "pr", "create",
      "--base", baseBranch,
      "--head", headBranch,
      "--title", title,
      "--body", body,
      "--json", "number,url",
    ],
    {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`gh pr create failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  const stdout = await new Response(proc.stdout).text();

  try {
    const result = JSON.parse(stdout.trim()) as { number: number; url: string };
    log(`PR created: #${result.number} — ${result.url}`);
    return { prNumber: result.number, url: result.url };
  } catch {
    throw new Error(`Failed to parse gh pr create output: ${stdout.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Completion comment
// ---------------------------------------------------------------------------

/**
 * Post (or update) a completion comment on the issue after a session finishes.
 * Uses the hidden marker `<!-- mesh-six-completion -->` so the comment can be
 * found and updated on retries.
 */
export async function postCompletionComment(
  client: GitHubProjectClient,
  owner: string,
  repo: string,
  issueNumber: number,
  sessionId: string,
  summary: string
): Promise<void> {
  const opts: CommentOptions = {
    type: "completion",
    issueNumber,
    repoOwner: owner,
    repoName: repo,
    sessionId,
    context: { summary },
  };

  const commentBody = await generateComment(opts);
  const markedBody = `<!-- mesh-six-completion -->\n${commentBody}`;

  const existingId = await client.findBotComment(owner, repo, issueNumber, "mesh-six-completion");

  const commentId = await client.createOrUpdateComment(
    owner,
    repo,
    issueNumber,
    markedBody,
    existingId ?? undefined
  );

  log(`Completion comment ${existingId ? "updated" : "created"}: id=${commentId} on ${owner}/${repo}#${issueNumber}`);
}

// ---------------------------------------------------------------------------
// Progress update comment
// ---------------------------------------------------------------------------

/**
 * Create or update a progress comment on the issue.
 * Uses the hidden marker `<!-- mesh-six-progress -->`.
 */
export async function postProgressUpdate(
  client: GitHubProjectClient,
  owner: string,
  repo: string,
  issueNumber: number,
  phase: string,
  details: string
): Promise<void> {
  const opts: CommentOptions = {
    type: "progress",
    issueNumber,
    repoOwner: owner,
    repoName: repo,
    context: { phase, details },
  };

  const commentBody = await generateComment(opts);
  const markedBody = `<!-- mesh-six-progress -->\n${commentBody}`;

  const existingId = await client.findBotComment(owner, repo, issueNumber, "mesh-six-progress");

  const commentId = await client.createOrUpdateComment(
    owner,
    repo,
    issueNumber,
    markedBody,
    existingId ?? undefined
  );

  log(`Progress comment ${existingId ? "updated" : "created"}: id=${commentId} on ${owner}/${repo}#${issueNumber} phase=${phase}`);
}
