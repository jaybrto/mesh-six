export interface ClaudeOAuthResult {
  deviceUrl: string;
  userCode: string;
}

const CLAUDE_AUTH_TIMEOUT_MS = parseInt(process.env.CLAUDE_AUTH_TIMEOUT_MS || "15000");
const MAX_RETRIES = 3;

export async function initiateClaudeOAuth(): Promise<ClaudeOAuthResult> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
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

      // Give it time to output the device code, then kill it
      // (we don't want it to wait for the user to complete the flow)
      const timeout = setTimeout(() => proc.kill(), CLAUDE_AUTH_TIMEOUT_MS);

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      clearTimeout(timeout);

      const combined = `${stdout}\n${stderr}`;

      // Look for the verification URL pattern (only allow known Anthropic domains)
      const urlMatch = combined.match(/https:\/\/(console\.anthropic\.com|claude\.ai)\S*/);
      if (!urlMatch) {
        throw new Error(
          `Failed to parse device URL from Claude CLI output.\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`
        );
      }

      // Look for the user code pattern (strictly XXXX-XXXX format)
      const codeMatch = combined.match(/code[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i);
      if (!codeMatch) {
        throw new Error(
          `Failed to parse user code from Claude CLI output.\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`
        );
      }

      return {
        deviceUrl: urlMatch[0],
        userCode: codeMatch[1],
      };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastError || new Error("Failed to initiate Claude OAuth after retries");
}
