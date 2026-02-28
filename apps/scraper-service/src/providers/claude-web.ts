/**
 * Claude Web Provider — drives the Gemini web UI via Playwright (Chrome).
 *
 * Uses a persistent Chrome profile to maintain authentication cookies.
 * Navigates to the Gemini "AI Context Architect & Research Engineer" Gem,
 * sends the prompt, waits for generation, and extracts the Markdown output.
 *
 * The accessibility tree is parsed by Gemini 1.5 Flash via LiteLLM to
 * dynamically locate UI elements (chat input, submit button).
 */

import { chromium, type Page } from "playwright";
import { config } from "../config.js";

const GEMINI_URL = "https://gemini.google.com/app";
const GEM_NAME = "AI Context Architect & Research Engineer";
const GENERATION_TIMEOUT_MS = 5 * 60 * 1_000; // 5 min for generation
const GENERATION_POLL_MS = 2_000;

interface AccessibilityElement {
  role: string;
  name: string;
}

interface AccessibilityNode {
  role?: string;
  name?: string;
  children?: AccessibilityNode[];
  [key: string]: unknown;
}

export async function executeClaudeWeb(
  _taskId: string,
  prompt: string,
): Promise<string> {
  // 1. Launch persistent Chrome context (maintains cookies/auth)
  const context = await chromium.launchPersistentContext(
    config.CHROME_PROFILE_DIR,
    {
      headless: false, // Must be visible on Mac mini for UI interaction
      viewport: { width: 1440, height: 900 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    },
  );

  try {
    const page = context.pages()[0] || (await context.newPage());

    // 2. Navigate to Gemini
    await page.goto(GEMINI_URL, { waitUntil: "networkidle", timeout: 30_000 });
    console.log("[claude-web] Navigated to Gemini");

    // 3. Select the Gem via hamburger menu
    await selectGem(page);

    // 4. Find the chat input using accessibility tree + LLM
    const inputSelector = await findChatInput(page);
    console.log(`[claude-web] Chat input found: ${inputSelector}`);

    // 5. Type the prompt
    await page.click(inputSelector);
    await page.fill(inputSelector, prompt);
    console.log("[claude-web] Prompt entered");

    // 6. Find and click the submit button
    const submitSelector = await findSubmitButton(page);
    await page.click(submitSelector);
    console.log("[claude-web] Prompt submitted");

    // 7. Wait for generation to complete
    const result = await waitForGeneration(page);
    console.log(`[claude-web] Response received (${result.length} chars)`);

    return result;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Open the hamburger menu and select the specified Gem.
 */
async function selectGem(page: Page): Promise<void> {
  const menuButton = page.locator(
    'button[aria-label="Main menu"], button[aria-label="Open navigation"]',
  );

  if (await menuButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await menuButton.click();
    await page.waitForTimeout(1_000);

    const gemLink = page.locator(`text="${GEM_NAME}"`).first();
    if (await gemLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await gemLink.click();
      await page.waitForTimeout(2_000);
      console.log(`[claude-web] Selected Gem: ${GEM_NAME}`);
      return;
    }
  }

  console.log("[claude-web] Could not find Gem via menu, attempting direct chat");
}

/**
 * Capture the accessibility tree snapshot using Playwright's ARIA snapshot.
 * Falls back to page.evaluate if the native API is unavailable.
 */
async function getAccessibilitySnapshot(
  page: Page,
): Promise<AccessibilityNode | null> {
  try {
    // Use Playwright's locator-based ARIA snapshot (available since v1.40+)
    const ariaYaml = await page.locator("body").ariaSnapshot();
    // Convert YAML-ish aria snapshot to a simple structure
    return { role: "RootWebArea", name: "page", children: [{ role: "text", name: ariaYaml }] };
  } catch {
    // Fallback: build a simple tree from page evaluation
    const tree = await page.evaluate(() => {
      function walk(el: Element): Record<string, unknown> {
        const role = el.getAttribute("role") || el.tagName.toLowerCase();
        const name =
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("title") ||
          "";
        const kids = Array.from(el.children).map(walk);
        return { role, name, ...(kids.length ? { children: kids } : {}) };
      }
      return walk(document.body);
    });
    return tree as AccessibilityNode;
  }
}

/**
 * Find the chat input using common selectors, then accessibility tree + LLM.
 */
async function findChatInput(page: Page): Promise<string> {
  const commonSelectors = [
    'div[contenteditable="true"]',
    'textarea[aria-label*="prompt" i]',
    'textarea[placeholder*="Enter" i]',
    'div[role="textbox"]',
    ".ql-editor",
    'textarea[aria-label*="chat" i]',
  ];

  for (const selector of commonSelectors) {
    if (
      await page
        .locator(selector)
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false)
    ) {
      return selector;
    }
  }

  // Fallback: use accessibility tree + LLM to identify the input
  const snapshot = await getAccessibilitySnapshot(page);
  if (snapshot) {
    const inputElement = findAccessibleElement(snapshot, [
      "textbox",
      "searchbox",
    ]);
    if (inputElement) {
      return `[role="${inputElement.role}"][name="${inputElement.name}"]`;
    }
  }

  // Last resort: ask LLM to interpret the accessibility tree
  return queryLLMForSelector(
    page,
    "Find the chat input field where I can type a message to the AI. Return only the CSS selector.",
  );
}

/**
 * Find the submit button using common selectors, then accessibility tree + LLM.
 */
async function findSubmitButton(page: Page): Promise<string> {
  const commonSelectors = [
    'button[aria-label*="Send" i]',
    'button[aria-label*="Submit" i]',
    'button[aria-label*="Run" i]',
    'button[data-testid*="send" i]',
    "button.send-button",
  ];

  for (const selector of commonSelectors) {
    if (
      await page
        .locator(selector)
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false)
    ) {
      return selector;
    }
  }

  // Fallback via accessibility tree
  const snapshot = await getAccessibilitySnapshot(page);
  if (snapshot) {
    const btn = findAccessibleElement(snapshot, ["button"], [
      "send",
      "submit",
      "run",
    ]);
    if (btn) {
      return `button[aria-label="${btn.name}"]`;
    }
  }

  return queryLLMForSelector(
    page,
    "Find the send/submit button for the chat input. Return only the CSS selector.",
  );
}

/**
 * Search the accessibility tree for an element matching the given roles
 * and optional name keywords.
 */
function findAccessibleElement(
  node: AccessibilityNode,
  roles: string[],
  nameKeywords?: string[],
): AccessibilityElement | null {
  const nodeRole = node.role || "";
  const nodeName = node.name || "";

  if (roles.includes(nodeRole)) {
    if (
      !nameKeywords ||
      nameKeywords.some((kw) => nodeName.toLowerCase().includes(kw))
    ) {
      return { role: nodeRole, name: nodeName };
    }
  }

  if (node.children) {
    for (const child of node.children) {
      const found = findAccessibleElement(child, roles, nameKeywords);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Ask LiteLLM (Gemini 1.5 Flash) to parse the page accessibility tree
 * and return a CSS selector for the requested element.
 */
async function queryLLMForSelector(
  page: Page,
  instruction: string,
): Promise<string> {
  const snapshot = await getAccessibilitySnapshot(page);
  const treeJson = JSON.stringify(snapshot, null, 2);

  const response = await fetch(`${config.LITELLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.LITELLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.LITELLM_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a UI automation expert. Given a Playwright accessibility tree snapshot, return ONLY the CSS selector (no explanation, no quotes) for the requested element.",
        },
        {
          role: "user",
          content: `Accessibility tree:\n${treeJson}\n\n${instruction}`,
        },
      ],
      temperature: 0,
      max_tokens: 100,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `[claude-web] LLM selector query failed: ${response.status}`,
    );
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  const selector = data.choices[0]?.message?.content?.trim();

  if (!selector) {
    throw new Error("[claude-web] LLM returned empty selector");
  }

  console.log(`[claude-web] LLM suggested selector: ${selector}`);
  return selector;
}

/**
 * Wait for the AI to finish generating and extract the response text.
 */
async function waitForGeneration(page: Page): Promise<string> {
  const startTime = Date.now();

  // Wait for a response container to appear
  await page.waitForTimeout(3_000);

  while (Date.now() - startTime < GENERATION_TIMEOUT_MS) {
    const isGenerating = await page
      .locator(
        '[aria-label*="loading" i], [aria-label*="generating" i], .loading-indicator, .thinking-indicator',
      )
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);

    if (!isGenerating) {
      await page.waitForTimeout(2_000);

      const stillGenerating = await page
        .locator(
          '[aria-label*="loading" i], [aria-label*="generating" i], .loading-indicator',
        )
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false);

      if (!stillGenerating) {
        break;
      }
    }

    await page.waitForTimeout(GENERATION_POLL_MS);
  }

  // Extract the last response message
  const responseSelectors = [
    ".response-content",
    ".model-response-text",
    'div[data-message-author-role="model"]',
    ".message-content",
    ".markdown-content",
  ];

  for (const selector of responseSelectors) {
    const elements = page.locator(selector);
    const count = await elements.count();
    if (count > 0) {
      const lastElement = elements.nth(count - 1);
      const text = await lastElement.innerText();
      if (text.trim().length > 0) {
        return text.trim();
      }
    }
  }

  // Fallback: get the last large text block on the page
  const allText = await page.evaluate(() => {
    const containers = document.querySelectorAll(
      'div[class*="response"], div[class*="message"], div[class*="content"]',
    );
    let longest = "";
    containers.forEach((el) => {
      const text = (el as unknown as { innerText: string }).innerText;
      if (text.length > longest.length) longest = text;
    });
    return longest;
  });

  if (allText.trim().length > 0) {
    return allText.trim();
  }

  throw new Error(
    "[claude-web] Could not extract response from page after generation",
  );
}
