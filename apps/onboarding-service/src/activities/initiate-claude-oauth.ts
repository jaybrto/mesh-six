export interface ClaudeOAuthResult {
  deviceUrl: string;
  userCode: string;
}

export async function initiateClaudeOAuth(): Promise<ClaudeOAuthResult> {
  // Use claude CLI's oauth login in a way that captures the device code output.
  // claude auth login outputs the verification URL and code to stderr interactively.
  // We capture both stdout and stderr to find the URL and code.
  const proc = Bun.spawn(["claude", "auth", "login"], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Force non-interactive mode if available
      CI: "1",
    },
  });

  // Give it a few seconds to output the device code, then kill it
  // (we don't want it to wait for the user to complete the flow)
  const timeout = setTimeout(() => proc.kill(), 10_000);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timeout);

  const combined = `${stdout}\n${stderr}`;

  // Look for the verification URL pattern
  const urlMatch = combined.match(/https:\/\/\S+/);
  if (!urlMatch) {
    throw new Error(
      `Failed to parse device URL from claude auth output. stdout: ${stdout}, stderr: ${stderr}`
    );
  }

  // Look for the user code pattern (typically "code: XXXX-XXXX" or similar)
  const codeMatch = combined.match(/code[:\s]+([A-Z0-9-]+)/i);
  if (!codeMatch) {
    throw new Error(
      `Failed to parse user code from claude auth output. stdout: ${stdout}, stderr: ${stderr}`
    );
  }

  return {
    deviceUrl: urlMatch[0],
    userCode: codeMatch[1],
  };
}
