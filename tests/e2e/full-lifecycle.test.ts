import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  waitFor,
  createTestIssue,
  addIssueToProjectBoard,
  getItemColumn,
  getIssueComments,
  queryMeshEvent,
  closeTestIssue,
  TEST_APP_URL,
  TEST_PROJECT_ID,
} from "./helpers";
import { readFileSync } from "fs";

// ---- Preflight checks ----
const REQUIRED_ENV = ["GITHUB_TOKEN", "TEST_PROJECT_ID", "DATABASE_URL", "TEST_APP_URL"];
for (const env of REQUIRED_ENV) {
  if (!process.env[env]) throw new Error(`Missing required env var: ${env}`);
}
if (!TEST_PROJECT_ID) throw new Error("TEST_PROJECT_ID env var required");

// ---- Test setup ----
const ISSUE_TITLE = `[E2E Test] Add tagging support — ${Date.now()}`;
const issueBody = readFileSync(`${import.meta.dir}/fixtures/tagging-feature.md`, "utf-8");

let issueNumber: number;
let projectItemId: string;

describe("Full lifecycle E2E: Todo → Done", () => {
  beforeAll(async () => {
    console.log("Creating test issue...");
    const issue = await createTestIssue(ISSUE_TITLE, issueBody);
    issueNumber = issue.issueNumber;
    console.log(`Created issue #${issueNumber}`);

    projectItemId = await addIssueToProjectBoard(issue.nodeId);
    console.log(`Added to project board: ${projectItemId}`);
  });

  afterAll(async () => {
    if (issueNumber) {
      console.log(`Cleaning up issue #${issueNumber}...`);
      await closeTestIssue(issueNumber).catch((e) =>
        console.error("Cleanup error:", e.message)
      );
    }
  });

  it("INTAKE: PM detects new Todo item (within 5 min)", async () => {
    const found = await waitFor(
      "PM state.transition event in mesh_six_events",
      () => queryMeshEvent("state.transition", "project-manager", 5 * 60 * 1000),
      5 * 60 * 1000
    );
    expect(found).toBe(true);
  }, 6 * 60 * 1000);

  it("INTAKE: PM consulted architect", async () => {
    const found = await waitFor(
      "llm.call from project-manager",
      () => queryMeshEvent("llm.call", "project-manager", 10 * 60 * 1000),
      10 * 60 * 1000
    );
    expect(found).toBe(true);
  }, 11 * 60 * 1000);

  it("INTAKE: Issue enriched with architect guidance comment", async () => {
    const comment = await waitFor(
      "Architect guidance comment on issue",
      async () => {
        const comments = await getIssueComments(issueNumber);
        return (
          comments.find(
            (c) =>
              c.body.includes("Architect Guidance") ||
              c.body.includes("Technical Recommendation") ||
              c.body.includes("mesh-six")
          ) ?? null
        );
      },
      5 * 60 * 1000
    );
    expect(comment).toBeTruthy();
  }, 6 * 60 * 1000);

  it("PLANNING: Card moved to Planning column (within 3 min)", async () => {
    const col = await waitFor(
      "Card column = Planning",
      async () => {
        const c = await getItemColumn(projectItemId);
        return c === "Planning" ? c : null;
      },
      3 * 60 * 1000
    );
    expect(col).toBe("Planning");
  }, 4 * 60 * 1000);

  it("PLANNING: Claude Code posts a plan as issue comment (within 20 min)", async () => {
    const comment = await waitFor(
      "Plan comment on issue",
      async () => {
        const comments = await getIssueComments(issueNumber);
        return (
          comments.find(
            (c) =>
              c.body.includes("##") &&
              (c.body.includes("- [ ]") || c.body.includes("1.")) &&
              c.body.length > 500
          ) ?? null
        );
      },
      20 * 60 * 1000,
      15_000
    );
    expect(comment).toBeTruthy();
  }, 21 * 60 * 1000);

  it("IMPLEMENTATION: Card moved to In Progress (within 5 min)", async () => {
    const col = await waitFor(
      "Card column = In Progress",
      async () => {
        const c = await getItemColumn(projectItemId);
        return c === "In Progress" ? c : null;
      },
      5 * 60 * 1000
    );
    expect(col).toBe("In Progress");
  }, 6 * 60 * 1000);

  it("IMPLEMENTATION: Claude Code creates a PR (within 40 min)", async () => {
    const pr = await waitFor(
      "PR linked to issue",
      async () => {
        const res = await fetch(
          `https://api.github.com/repos/bto-labs/gwa-test-app/pulls?state=open&per_page=30&sort=created`,
          {
            headers: {
              Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
              Accept: "application/vnd.github+json",
            },
          }
        );
        const prs = (await res.json()) as Array<{ number: number; body?: string; title: string }>;
        return (
          prs.find(
            (pr) =>
              pr.body?.includes(`#${issueNumber}`) || pr.title.includes(`#${issueNumber}`)
          ) ?? null
        );
      },
      40 * 60 * 1000,
      15_000
    );
    expect(pr).toBeTruthy();
  }, 41 * 60 * 1000);

  it("QA: Card moved to QA column (within 5 min)", async () => {
    const col = await waitFor(
      "Card column = QA",
      async () => {
        const c = await getItemColumn(projectItemId);
        return c === "QA" ? c : null;
      },
      5 * 60 * 1000
    );
    expect(col).toBe("QA");
  }, 6 * 60 * 1000);

  it("QA: Test results posted as comment (within 15 min)", async () => {
    const comment = await waitFor(
      "Test results comment on issue",
      async () => {
        const comments = await getIssueComments(issueNumber);
        return (
          comments.find(
            (c) =>
              (c.body.toLowerCase().includes("passed") || c.body.toLowerCase().includes("failed")) &&
              c.body.toLowerCase().includes("test")
          ) ?? null
        );
      },
      15 * 60 * 1000,
      15_000
    );
    expect(comment).toBeTruthy();
  }, 16 * 60 * 1000);

  it("REVIEW: Card moved to Review column (within 5 min)", async () => {
    const col = await waitFor(
      "Card column = Review",
      async () => {
        const c = await getItemColumn(projectItemId);
        return c === "Review" ? c : null;
      },
      5 * 60 * 1000
    );
    expect(col).toBe("Review");
  }, 6 * 60 * 1000);

  it("REVIEW: Deployed service health endpoint responds (within 10 min)", async () => {
    const ok = await waitFor(
      `Health endpoint responding at ${TEST_APP_URL}/healthz`,
      async () => {
        try {
          const res = await fetch(`${TEST_APP_URL}/healthz`, {
            signal: AbortSignal.timeout(5000),
          });
          return res.ok ? true : null;
        } catch {
          return null;
        }
      },
      10 * 60 * 1000,
      10_000
    );
    expect(ok).toBe(true);
  }, 11 * 60 * 1000);

  it("ACCEPTED: Card moved to Done (within 10 min)", async () => {
    const col = await waitFor(
      "Card column = Done",
      async () => {
        const c = await getItemColumn(projectItemId);
        return c === "Done" ? c : null;
      },
      10 * 60 * 1000
    );
    expect(col).toBe("Done");
  }, 11 * 60 * 1000);
});
