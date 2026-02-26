import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  cloneRepo,
  createWorktree,
  removeWorktree,
  listWorktrees,
  getDiff,
  getStatus,
  createBranch,
  checkoutBranch,
  getCurrentBranch,
  getLatestCommit,
  stash,
  stashPop,
  GitError,
} from "./git.js";

// ---------------------------------------------------------------------------
// Helpers for creating real git repos in temp directories
// ---------------------------------------------------------------------------

async function runGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await runGit(["init", "-b", "main"], dir);
  await runGit(["config", "user.email", "test@test.com"], dir);
  await runGit(["config", "user.name", "Test"], dir);
  // Create initial commit so the repo is non-empty
  writeFileSync(join(dir, "README.md"), "# test\n");
  await runGit(["add", "."], dir);
  await runGit(["commit", "-m", "initial commit"], dir);
}

function mkTmp(prefix: string): string {
  // Use realpathSync on tmpdir() to resolve macOS /private/var symlinks
  const base = (() => {
    try { return realpathSync(tmpdir()); } catch { return tmpdir(); }
  })();
  return join(base, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// ---------------------------------------------------------------------------
// GitError
// ---------------------------------------------------------------------------

describe("GitError", () => {
  it("has correct class properties", () => {
    const err = new GitError("git clone failed: some error", "git clone url dir", 128, "some error\n");
    expect(err).toBeInstanceOf(GitError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GitError");
    expect(err.message).toBe("git clone failed: some error");
    expect(err.command).toBe("git clone url dir");
    expect(err.exitCode).toBe(128);
    expect(err.stderr).toBe("some error\n");
  });

  it("is catchable as an Error", () => {
    const err = new GitError("msg", "git status", 1, "err");
    let caught: unknown;
    try {
      throw err;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(GitError);
  });
});

// ---------------------------------------------------------------------------
// cloneRepo — mock Bun.spawn to verify args
// ---------------------------------------------------------------------------

describe("cloneRepo", () => {
  it("calls git clone with url and targetDir", async () => {
    const spawnCalls: string[][] = [];
    const originalSpawn = Bun.spawn;

    (Bun as any).spawn = (args: string[], opts: any) => {
      spawnCalls.push(args);
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    };

    try {
      await cloneRepo("https://github.com/test/repo.git", "/tmp/repo");
      expect(spawnCalls[0]).toEqual(["git", "clone", "https://github.com/test/repo.git", "/tmp/repo"]);
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });

  it("passes --branch option when specified", async () => {
    const spawnCalls: string[][] = [];
    const originalSpawn = Bun.spawn;

    (Bun as any).spawn = (args: string[], opts: any) => {
      spawnCalls.push(args);
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    };

    try {
      await cloneRepo("https://github.com/test/repo.git", "/tmp/repo", { branch: "feat/test" });
      expect(spawnCalls[0]).toContain("--branch");
      expect(spawnCalls[0]).toContain("feat/test");
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });

  it("passes --depth option when specified", async () => {
    const spawnCalls: string[][] = [];
    const originalSpawn = Bun.spawn;

    (Bun as any).spawn = (args: string[], opts: any) => {
      spawnCalls.push(args);
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    };

    try {
      await cloneRepo("https://github.com/test/repo.git", "/tmp/repo", { depth: 1 });
      expect(spawnCalls[0]).toContain("--depth");
      expect(spawnCalls[0]).toContain("1");
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });

  it("passes --single-branch option when specified", async () => {
    const spawnCalls: string[][] = [];
    const originalSpawn = Bun.spawn;

    (Bun as any).spawn = (args: string[], opts: any) => {
      spawnCalls.push(args);
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    };

    try {
      await cloneRepo("https://github.com/test/repo.git", "/tmp/repo", { singleBranch: true });
      expect(spawnCalls[0]).toContain("--single-branch");
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });

  it("throws GitError on non-zero exit", async () => {
    const originalSpawn = Bun.spawn;
    (Bun as any).spawn = (_args: string[], _opts: any) => {
      const enc = new TextEncoder();
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({
          start(c) {
            c.enqueue(enc.encode("repository not found\n"));
            c.close();
          },
        }),
        exited: Promise.resolve(128),
      };
    };

    try {
      await expect(cloneRepo("https://github.com/nope/nope.git", "/tmp/nope")).rejects.toBeInstanceOf(GitError);
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });
});

// ---------------------------------------------------------------------------
// Worktree integration tests — use real git repos in /tmp
// ---------------------------------------------------------------------------

describe("worktree operations", () => {
  let repoDir: string;
  let worktreeDir: string;

  beforeAll(async () => {
    repoDir = mkTmp("git-test-repo");
    worktreeDir = mkTmp("git-test-worktree");
    await initRepo(repoDir);
  });

  afterAll(() => {
    if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
    if (existsSync(worktreeDir)) rmSync(worktreeDir, { recursive: true, force: true });
  });

  it("createWorktree creates a new worktree directory", async () => {
    // Create a branch to check out as a worktree
    await createBranch(repoDir, "feature-branch");
    await createWorktree(repoDir, worktreeDir, "feature-branch");
    expect(existsSync(worktreeDir)).toBe(true);
  });

  it("listWorktrees returns the main worktree and newly created worktree", async () => {
    const trees = await listWorktrees(repoDir);
    expect(trees.length).toBeGreaterThanOrEqual(2);
    const paths = trees.map((t) => t.path);
    expect(paths).toContain(repoDir);
    expect(paths).toContain(worktreeDir);
  });

  it("listWorktrees returns correct WorktreeInfo shape", async () => {
    const trees = await listWorktrees(repoDir);
    const wt = trees.find((t) => t.path === worktreeDir);
    expect(wt).toBeDefined();
    expect(wt!.branch).toBe("feature-branch");
    expect(wt!.head).toMatch(/^[0-9a-f]{40}$/);
    expect(wt!.bare).toBe(false);
  });

  it("removeWorktree removes the worktree directory", async () => {
    await removeWorktree(repoDir, worktreeDir);
    // After removal the directory should not exist (or not be registered)
    const trees = await listWorktrees(repoDir);
    const paths = trees.map((t) => t.path);
    expect(paths).not.toContain(worktreeDir);
  });
});

// ---------------------------------------------------------------------------
// getDiff — test with real repo
// ---------------------------------------------------------------------------

describe("getDiff", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = mkTmp("git-diff-repo");
    await initRepo(repoDir);
  });

  afterAll(() => {
    if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns empty string for clean repo", async () => {
    const diff = await getDiff(repoDir);
    expect(diff.trim()).toBe("");
  });

  it("returns diff for unstaged changes", async () => {
    writeFileSync(join(repoDir, "README.md"), "# test\nmodified\n");
    const diff = await getDiff(repoDir);
    expect(diff).toContain("modified");
  });

  it("returns diff for staged changes with staged option", async () => {
    await runGit(["add", "README.md"], repoDir);
    const diff = await getDiff(repoDir, { staged: true });
    expect(diff).toContain("modified");
  });

  it("returns stat summary with stat option", async () => {
    const diff = await getDiff(repoDir, { staged: true, stat: true });
    expect(diff).toContain("README.md");
    expect(diff).toContain("|");
  });
});

// ---------------------------------------------------------------------------
// getStatus — test with real repo
// ---------------------------------------------------------------------------

describe("getStatus", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = mkTmp("git-status-repo");
    await initRepo(repoDir);
  });

  afterAll(() => {
    if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns clean status for fresh repo", async () => {
    const status = await getStatus(repoDir);
    expect(status.clean).toBe(true);
    expect(status.staged).toHaveLength(0);
    expect(status.modified).toHaveLength(0);
    expect(status.untracked).toHaveLength(0);
    expect(status.deleted).toHaveLength(0);
  });

  it("detects untracked files", async () => {
    writeFileSync(join(repoDir, "new-file.ts"), "export const x = 1;\n");
    const status = await getStatus(repoDir);
    expect(status.untracked).toContain("new-file.ts");
    expect(status.clean).toBe(false);
  });

  it("detects staged new files", async () => {
    await runGit(["add", "new-file.ts"], repoDir);
    const status = await getStatus(repoDir);
    expect(status.staged).toContain("new-file.ts");
    expect(status.untracked).not.toContain("new-file.ts");
  });

  it("detects modified unstaged files", async () => {
    // Commit the staged file first
    await runGit(["commit", "-m", "add new-file.ts"], repoDir);
    // Now modify it without staging
    writeFileSync(join(repoDir, "new-file.ts"), "export const x = 2;\n");
    const status = await getStatus(repoDir);
    expect(status.modified).toContain("new-file.ts");
  });

  it("detects deleted files", async () => {
    // Start fresh: commit a file then delete it
    writeFileSync(join(repoDir, "to-delete.ts"), "// delete me\n");
    await runGit(["add", "to-delete.ts"], repoDir);
    await runGit(["commit", "-m", "add to-delete.ts"], repoDir);
    // Reset modified state from previous test
    await runGit(["checkout", "new-file.ts"], repoDir);
    // Delete the file from index
    await runGit(["rm", "to-delete.ts"], repoDir);
    const status = await getStatus(repoDir);
    expect(status.deleted).toContain("to-delete.ts");
  });
});

// ---------------------------------------------------------------------------
// createBranch / checkoutBranch
// ---------------------------------------------------------------------------

describe("createBranch and checkoutBranch", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = mkTmp("git-branch-repo");
    await initRepo(repoDir);
  });

  afterAll(() => {
    if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
  });

  it("createBranch creates a new branch", async () => {
    await createBranch(repoDir, "my-feature");
    const proc = Bun.spawn(["git", "branch", "--list", "my-feature"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    expect(output).toContain("my-feature");
  });

  it("checkoutBranch switches to the branch", async () => {
    await checkoutBranch(repoDir, "my-feature");
    const branch = await getCurrentBranch(repoDir);
    expect(branch).toBe("my-feature");
  });

  it("createBranch with startPoint creates branch from that ref", async () => {
    await checkoutBranch(repoDir, "main");
    await createBranch(repoDir, "from-main", "main");
    const proc = Bun.spawn(["git", "branch", "--list", "from-main"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    expect(output).toContain("from-main");
  });

  it("throws GitError when checking out non-existent branch", async () => {
    await expect(checkoutBranch(repoDir, "does-not-exist")).rejects.toBeInstanceOf(GitError);
  });
});

// ---------------------------------------------------------------------------
// getCurrentBranch / getLatestCommit
// ---------------------------------------------------------------------------

describe("getCurrentBranch", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = mkTmp("git-current-repo");
    await initRepo(repoDir);
  });

  afterAll(() => {
    if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns the current branch name", async () => {
    const branch = await getCurrentBranch(repoDir);
    expect(branch).toBe("main");
  });

  it("returns the new branch name after checkout", async () => {
    await createBranch(repoDir, "other-branch");
    await checkoutBranch(repoDir, "other-branch");
    const branch = await getCurrentBranch(repoDir);
    expect(branch).toBe("other-branch");
  });

  it("throws an error for non-existent repo", async () => {
    // git exits non-zero in a non-git directory — may throw GitError or system error
    await expect(getCurrentBranch("/tmp/does-not-exist-12345")).rejects.toThrow();
  });
});

describe("getLatestCommit", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = mkTmp("git-commit-repo");
    await initRepo(repoDir);
  });

  afterAll(() => {
    if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns hash and message of the latest commit", async () => {
    const commit = await getLatestCommit(repoDir);
    expect(commit.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(commit.message).toBe("initial commit");
  });

  it("reflects a new commit after committing", async () => {
    writeFileSync(join(repoDir, "second.txt"), "second\n");
    await runGit(["add", "."], repoDir);
    await runGit(["commit", "-m", "second commit"], repoDir);
    const commit = await getLatestCommit(repoDir);
    expect(commit.message).toBe("second commit");
  });
});

// ---------------------------------------------------------------------------
// stash / stashPop
// ---------------------------------------------------------------------------

describe("stash and stashPop", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = mkTmp("git-stash-repo");
    await initRepo(repoDir);
  });

  afterAll(() => {
    if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
  });

  it("stash clears working tree changes", async () => {
    writeFileSync(join(repoDir, "README.md"), "# stash test\n");
    // git stash requires at least one tracked file to have changes
    await runGit(["add", "README.md"], repoDir);
    await stash(repoDir, "my stash");
    const status = await getStatus(repoDir);
    expect(status.clean).toBe(true);
  });

  it("stashPop restores stashed changes", async () => {
    await stashPop(repoDir);
    const status = await getStatus(repoDir);
    // The stashed changes are restored — repo should not be clean
    // Whether it appears as staged or modified depends on git version/config
    expect(status.clean).toBe(false);
  });
});
