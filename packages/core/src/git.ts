/**
 * Typed git operations library.
 * All commands run via Bun.spawn for proper error handling.
 * Ported from GWA src/lib/git.ts, adapted for mesh-six.
 */

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
}

export interface GitStatus {
  staged: string[];
  modified: string[];
  untracked: string[];
  deleted: string[];
  clean: boolean;
}

export interface CloneOptions {
  branch?: string;
  depth?: number;
  singleBranch?: boolean;
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly exitCode: number,
    public readonly stderr: string
  ) {
    super(message);
    this.name = "GitError";
  }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

async function exec(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new GitError(
      `git ${args[0]} failed: ${stderr.trim()}`,
      `git ${args.join(" ")}`,
      exitCode,
      stderr
    );
  }
  return stdout;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clone a repository into targetDir.
 */
export async function cloneRepo(
  url: string,
  targetDir: string,
  opts?: CloneOptions
): Promise<void> {
  const args = ["clone"];
  if (opts?.branch) {
    args.push("--branch", opts.branch);
  }
  if (opts?.depth !== undefined) {
    args.push("--depth", String(opts.depth));
  }
  if (opts?.singleBranch) {
    args.push("--single-branch");
  }
  args.push(url, targetDir);
  await exec(args);
}

/**
 * Add a new worktree at worktreePath checked out to branch.
 */
export async function createWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  await exec(["worktree", "add", worktreePath, branch], repoDir);
}

/**
 * Remove a worktree, force-removing it even if there are untracked/modified files.
 */
export async function removeWorktree(
  repoDir: string,
  worktreePath: string
): Promise<void> {
  await exec(["worktree", "remove", "--force", worktreePath], repoDir);
}

/**
 * List all worktrees for a repository, parsed from --porcelain output.
 *
 * Porcelain format:
 *   worktree /path/to/worktree
 *   HEAD <sha>
 *   branch refs/heads/<branch>   (absent for detached HEAD)
 *   bare                         (present only for bare worktrees)
 *   <blank line>
 */
export async function listWorktrees(repoDir: string): Promise<WorktreeInfo[]> {
  const output = await exec(["worktree", "list", "--porcelain"], repoDir);

  const worktrees: WorktreeInfo[] = [];
  // Each worktree block is separated by a blank line
  const blocks = output.trim().split(/\n\n+/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    const lines = block.trim().split("\n");
    let path = "";
    let head = "";
    let branch = "";
    let bare = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        // refs/heads/<branch> → <branch>
        const ref = line.slice("branch ".length).trim();
        branch = ref.replace(/^refs\/heads\//, "");
      } else if (line.trim() === "bare") {
        bare = true;
      }
    }

    if (path) {
      worktrees.push({ path, head, branch, bare });
    }
  }

  return worktrees;
}

/**
 * Get the diff for the repository.
 * opts.staged — include only staged changes (--cached)
 * opts.stat   — show stat summary instead of full diff (--stat)
 */
export async function getDiff(
  repoDir: string,
  opts?: { staged?: boolean; stat?: boolean }
): Promise<string> {
  const args = ["diff"];
  if (opts?.staged) {
    args.push("--cached");
  }
  if (opts?.stat) {
    args.push("--stat");
  }
  return exec(args, repoDir);
}

/**
 * Get the working-tree status parsed from `git status --porcelain`.
 *
 * Porcelain format: two status chars followed by a space and the filename.
 * XY PATH
 *   X = index status, Y = worktree status
 *   ' M' or 'M ' → modified
 *   'A ' → staged new file
 *   '??' → untracked
 *   ' D' or 'D ' → deleted
 */
export async function getStatus(repoDir: string): Promise<GitStatus> {
  const output = await exec(["status", "--porcelain"], repoDir);

  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  const deleted: string[] = [];

  for (const line of output.split("\n")) {
    if (!line) continue;

    const xy = line.slice(0, 2);
    const file = line.slice(3);

    if (xy === "??") {
      untracked.push(file);
    } else if (xy === "A ") {
      staged.push(file);
    } else if (xy === " M" || xy === "MM") {
      modified.push(file);
    } else if (xy === "M " || xy === "AM") {
      // Index modified — treat as staged
      staged.push(file);
    } else if (xy === " D") {
      deleted.push(file);
    } else if (xy === "D ") {
      deleted.push(file);
    }
  }

  return {
    staged,
    modified,
    untracked,
    deleted,
    clean:
      staged.length === 0 &&
      modified.length === 0 &&
      untracked.length === 0 &&
      deleted.length === 0,
  };
}

/**
 * Create a new branch, optionally starting from a given commit/branch.
 */
export async function createBranch(
  repoDir: string,
  branch: string,
  startPoint?: string
): Promise<void> {
  const args = ["branch", branch];
  if (startPoint) {
    args.push(startPoint);
  }
  await exec(args, repoDir);
}

/**
 * Checkout an existing branch.
 */
export async function checkoutBranch(
  repoDir: string,
  branch: string
): Promise<void> {
  await exec(["checkout", branch], repoDir);
}

/**
 * Stash working tree changes, with an optional message.
 */
export async function stash(repoDir: string, message?: string): Promise<void> {
  const args = ["stash"];
  if (message) {
    args.push("push", "-m", message);
  }
  await exec(args, repoDir);
}

/**
 * Pop the most recent stash entry.
 */
export async function stashPop(repoDir: string): Promise<void> {
  await exec(["stash", "pop"], repoDir);
}

/**
 * Return the name of the currently checked-out branch.
 */
export async function getCurrentBranch(repoDir: string): Promise<string> {
  const output = await exec(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    repoDir
  );
  return output.trim();
}

/**
 * Return the hash and subject line of the most recent commit.
 */
export async function getLatestCommit(
  repoDir: string
): Promise<{ hash: string; message: string }> {
  const output = await exec(
    ["log", "-1", "--format=%H%n%s"],
    repoDir
  );
  const lines = output.trim().split("\n");
  return {
    hash: lines[0]?.trim() ?? "",
    message: lines[1]?.trim() ?? "",
  };
}
