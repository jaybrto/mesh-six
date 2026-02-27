export interface TriggerSyncInput {
  repoOwner: string;
  repoName: string;
  manifestDir: string;
}

export interface TriggerSyncResult {
  committed: boolean;
  output: string;
}

function spawnGit(args: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

export async function triggerSync(input: TriggerSyncInput): Promise<TriggerSyncResult> {
  const { manifestDir } = input;

  // Determine repo root (two levels up from k8s/base/envs/<owner>-<repo>)
  // manifestDir is .../k8s/base/envs/{owner}-{repo}
  // repoRoot is  .../  (four levels up)
  const parts = manifestDir.split("/");
  const repoRoot = parts.slice(0, parts.length - 4).join("/") || "/";

  // git add
  const addResult = spawnGit(["add", manifestDir], repoRoot);
  if (addResult.exitCode !== 0) {
    throw new Error(`git add failed: ${addResult.stderr}`);
  }

  // git commit
  const commitMessage = `chore: add k8s manifests for env-${input.repoOwner}-${input.repoName}`;
  const commitResult = spawnGit(
    ["commit", "-m", commitMessage],
    repoRoot
  );

  if (commitResult.exitCode !== 0) {
    const combinedOutput = commitResult.stdout + commitResult.stderr;
    // "nothing to commit" is idempotent — treat as success
    if (combinedOutput.includes("nothing to commit")) {
      return { committed: false, output: combinedOutput.trim() };
    }
    throw new Error(`git commit failed: ${combinedOutput.trim()}`);
  }

  // git push
  const pushResult = spawnGit(["push"], repoRoot);
  if (pushResult.exitCode !== 0) {
    throw new Error(`git push failed: ${pushResult.stderr}`);
  }

  return { committed: true, output: commitResult.stdout.trim() };
}
