/**
 * Windsurf Provider — drives the Windsurf IDE (Electron) via Playwright.
 *
 * Workflow:
 * 1. Create a local workspace directory for the task
 * 2. Launch/connect to Windsurf via Playwright's _electron driver
 * 3. Trigger the Windsurf workflow via keyboard shortcut (Meta+Shift+W)
 * 4. Pass the prompt and workspace directory path
 * 5. Poll for output.md (or .done flag) in the workspace directory
 * 6. Return the Markdown content
 */

import { _electron as electron } from "playwright";
import { existsSync, mkdirSync, watch } from "fs";
import { join } from "path";
import { config } from "../config.js";

const POLL_INTERVAL_MS = 3_000;
const MAX_WAIT_MS = 10 * 60 * 1_000; // 10 minutes

export async function executeWindsurf(
  taskId: string,
  prompt: string,
): Promise<string> {
  // 1. Create workspace directory
  const workspaceDir = join(config.WINDSURF_WORKSPACE_BASE, taskId);
  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
  }
  console.log(`[windsurf] Workspace: ${workspaceDir}`);

  // Write the prompt to a file so Windsurf can read it
  const promptPath = join(workspaceDir, "prompt.md");
  await Bun.write(promptPath, prompt);

  // 2. Launch Windsurf via Electron driver
  const electronApp = await electron.launch({
    executablePath: config.WINDSURF_APP_PATH,
    args: [workspaceDir],
    timeout: 30_000,
  });

  try {
    // 3. Wait for the main window to load
    const window = await electronApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    console.log("[windsurf] Window loaded");

    // Give the IDE a moment to fully initialize
    await window.waitForTimeout(5_000);

    // 4. Trigger Windsurf workflow via keyboard shortcut
    // Meta+Shift+W opens the workflow panel
    await window.keyboard.press("Meta+Shift+W");
    await window.waitForTimeout(1_000);

    // Type the prompt into the workflow input
    await window.keyboard.type(
      `Process this task in workspace ${workspaceDir}:\n\n${prompt}\n\nSave your output to ${workspaceDir}/output.md when complete.`,
      { delay: 10 },
    );

    // Submit with Enter
    await window.keyboard.press("Enter");
    console.log("[windsurf] Prompt submitted");

    // 5. Wait for output.md to appear
    const outputPath = join(workspaceDir, "output.md");
    const donePath = join(workspaceDir, ".done");
    const result = await waitForOutput(outputPath, donePath);

    console.log(`[windsurf] Output received (${result.length} chars)`);
    return result;
  } finally {
    await electronApp.close().catch(() => {});
  }
}

/**
 * Wait for either output.md or .done to appear in the workspace,
 * then read and return the output.md content.
 */
async function waitForOutput(
  outputPath: string,
  donePath: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const startTime = Date.now();

    const interval = setInterval(async () => {
      // Check timeout
      if (Date.now() - startTime > MAX_WAIT_MS) {
        clearInterval(interval);
        reject(
          new Error(
            `[windsurf] Timed out waiting for output after ${MAX_WAIT_MS / 1_000}s`,
          ),
        );
        return;
      }

      // Check for output file
      if (existsSync(outputPath)) {
        clearInterval(interval);
        try {
          const content = await Bun.file(outputPath).text();
          resolve(content);
        } catch (err) {
          reject(new Error(`[windsurf] Failed to read output: ${err}`));
        }
        return;
      }

      // Check for .done flag (output.md may have been created first)
      if (existsSync(donePath)) {
        clearInterval(interval);
        // Small delay in case output.md is still being written
        await Bun.sleep(500);
        if (existsSync(outputPath)) {
          try {
            const content = await Bun.file(outputPath).text();
            resolve(content);
          } catch (err) {
            reject(new Error(`[windsurf] Failed to read output: ${err}`));
          }
        } else {
          reject(
            new Error("[windsurf] .done flag found but output.md missing"),
          );
        }
      }
    }, POLL_INTERVAL_MS);
  });
}
