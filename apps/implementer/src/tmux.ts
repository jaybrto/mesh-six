/**
 * Tmux session management utilities for the implementer agent.
 * Each implementation session runs in a dedicated tmux session.
 */

const log = (msg: string) => console.log(`[implementer][tmux] ${msg}`);

/**
 * Create a new detached tmux session with the given name.
 */
export async function createSession(name: string): Promise<void> {
  const proc = Bun.spawn(["tmux", "new-session", "-d", "-s", name], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tmux new-session failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  log(`Created session: ${name}`);
}

/**
 * Send a command string to a tmux session (appends Enter).
 */
export async function sendCommand(name: string, cmd: string): Promise<void> {
  const proc = Bun.spawn(["tmux", "send-keys", "-t", name, cmd, "Enter"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tmux send-keys failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}

/**
 * Capture the current pane output from a tmux session.
 * @param name - tmux session name
 * @param lines - number of lines to capture (default: 50)
 */
export async function capturePane(name: string, lines = 50): Promise<string> {
  const proc = Bun.spawn(
    ["tmux", "capture-pane", "-t", name, "-p", "-S", `-${lines}`],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tmux capture-pane failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return new Response(proc.stdout).text();
}

/**
 * Kill a tmux session by name. Ignores errors if the session does not exist.
 */
export async function killSession(name: string): Promise<void> {
  const proc = Bun.spawn(["tmux", "kill-session", "-t", name], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  log(`Killed session: ${name}`);
}

/**
 * Send individual key names to a tmux session (without Enter).
 * Useful for dialog dismissal (e.g., "Down", "Enter", "y").
 */
export async function sendKeys(name: string, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    const proc = Bun.spawn(["tmux", "send-keys", "-t", name, key], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tmux send-keys (key=${key}) failed (exit ${exitCode}): ${stderr.trim()}`);
    }
  }
}

/**
 * Check whether a tmux session with the given name currently exists.
 */
export async function sessionExists(name: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["tmux", "has-session", "-t", name],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  return exitCode === 0;
}
