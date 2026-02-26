import { readFile } from "fs/promises";
import { join } from "path";

const TEMPLATE_DIR = join(import.meta.dir, "../../../../templates/plans");

export type TemplateName = "plan" | "prompt" | "checklist" | "decisions";

export interface TemplateVars {
  ISSUE_TITLE?: string;
  ISSUE_NUMBER?: number;
  REPO_OWNER?: string;
  REPO_NAME?: string;
  TIMESTAMP?: string;
  AGENT_ID?: string;
  ISSUE_BODY?: string;
  REPO_STRUCTURE?: string;
  [key: string]: string | number | undefined;
}

export async function loadTemplate(name: TemplateName): Promise<string> {
  const path = join(TEMPLATE_DIR, `${name}.md`);
  return readFile(path, "utf-8");
}

export function instantiatePlan(template: string, vars: TemplateVars): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) {
      result = result.replaceAll(`{{${key}}}`, String(value));
    }
  }
  // Remove unfilled placeholders
  result = result.replace(/\{\{[A-Z_]+\}\}/g, "");
  return result;
}

export function formatPlanForIssue(plan: string): string {
  // Wrap plan in collapsible details section for GitHub
  return `<details>\n<summary>Implementation Plan</summary>\n\n${plan}\n\n</details>`;
}

export function parsePlanFromComment(commentBody: string): string | null {
  // Extract plan from details/summary block
  const match = commentBody.match(
    /<details>\s*<summary>.*?Implementation Plan.*?<\/summary>\s*([\s\S]*?)\s*<\/details>/
  );
  return match ? match[1].trim() : null;
}

/**
 * Load and instantiate a template in one step.
 * Falls back to an empty string with a console warning if the template file
 * cannot be read (e.g. during local dev before templates are populated).
 */
export async function buildTemplate(
  name: TemplateName,
  vars: TemplateVars
): Promise<string> {
  try {
    const raw = await loadTemplate(name);
    return instantiatePlan(raw, vars);
  } catch (err) {
    console.warn(
      `[plan-templates] Could not load template "${name}": ${(err as Error).message}`
    );
    return "";
  }
}
