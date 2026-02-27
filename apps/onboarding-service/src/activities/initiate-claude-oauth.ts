export interface ClaudeOAuthResult {
  deviceUrl: string;
  userCode: string;
}

export async function initiateClaudeOAuth(): Promise<ClaudeOAuthResult> {
  const proc = Bun.spawn(["claude", "auth", "login", "--print-device-code"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `claude auth login failed with exit code ${exitCode}: ${stderr}`
    );
  }

  const urlMatch = stdout.match(/https:\/\/\S+/);
  if (!urlMatch) {
    throw new Error(
      `Failed to parse device URL from claude auth output: ${stdout}`
    );
  }

  const codeMatch = stdout.match(/code:\s*(\S+)/i);
  if (!codeMatch) {
    throw new Error(
      `Failed to parse user code from claude auth output: ${stdout}`
    );
  }

  return {
    deviceUrl: urlMatch[0],
    userCode: codeMatch[1],
  };
}
