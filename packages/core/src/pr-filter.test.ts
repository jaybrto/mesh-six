import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  shouldProcessIssue,
  shouldProcessPR,
  loadFilterConfigFromEnv,
  type FilterConfig,
  type IssueInfo,
  type PRInfo,
} from "./pr-filter.js";

// ---------------------------------------------------------------------------
// shouldProcessIssue
// ---------------------------------------------------------------------------

describe("shouldProcessIssue", () => {
  it("returns true when config has no filter rules", () => {
    const issue: IssueInfo = { labels: [], author: "someone" };
    expect(shouldProcessIssue(issue, {})).toBe(true);
  });

  it("returns true when config has empty arrays", () => {
    const issue: IssueInfo = { labels: [], author: "someone" };
    const config: FilterConfig = {
      allowedAuthors: [],
      requiredLabels: [],
      excludeLabels: [],
    };
    expect(shouldProcessIssue(issue, config)).toBe(true);
  });

  it("excludes issue that has an excludeLabel — highest priority", () => {
    const issue: IssueInfo = { labels: ["wontfix", "bug"], author: "trusted-author" };
    const config: FilterConfig = {
      excludeLabels: ["wontfix"],
      allowedAuthors: ["trusted-author"],
    };
    // Even though the author is allowed, the exclude label wins
    expect(shouldProcessIssue(issue, config)).toBe(false);
  });

  it("excludes issue that has any of multiple excludeLabels", () => {
    const issue: IssueInfo = { labels: ["invalid"], author: "bob" };
    const config: FilterConfig = { excludeLabels: ["wontfix", "invalid", "duplicate"] };
    expect(shouldProcessIssue(issue, config)).toBe(false);
  });

  it("does not exclude issue whose labels do not match excludeLabels", () => {
    const issue: IssueInfo = { labels: ["bug"], author: "bob" };
    const config: FilterConfig = { excludeLabels: ["wontfix"] };
    // With only excludeLabels set and no match, falls through to return true
    expect(shouldProcessIssue(issue, config)).toBe(true);
  });

  it("returns true for allowed author regardless of other rules", () => {
    const issue: IssueInfo = { labels: [], author: "alice" };
    const config: FilterConfig = {
      allowedAuthors: ["alice", "bob"],
      requiredLabels: ["needs-triage"],
    };
    // alice is in allowedAuthors so short-circuit to true
    expect(shouldProcessIssue(issue, config)).toBe(true);
  });

  it("requires at least one requiredLabel when set", () => {
    const issue: IssueInfo = { labels: ["bug", "enhancement"], author: "unknown" };
    const config: FilterConfig = { requiredLabels: ["approved", "ready"] };
    expect(shouldProcessIssue(issue, config)).toBe(false);
  });

  it("returns true when issue has at least one requiredLabel", () => {
    const issue: IssueInfo = { labels: ["bug", "approved"], author: "unknown" };
    const config: FilterConfig = { requiredLabels: ["approved"] };
    expect(shouldProcessIssue(issue, config)).toBe(true);
  });

  it("rejects unknown author when only allowedAuthors is set", () => {
    const issue: IssueInfo = { labels: [], author: "stranger" };
    const config: FilterConfig = { allowedAuthors: ["alice", "bob"] };
    expect(shouldProcessIssue(issue, config)).toBe(false);
  });

  it("handles issue with no labels against requiredLabels", () => {
    const issue: IssueInfo = { labels: [], author: "alice" };
    const config: FilterConfig = { requiredLabels: ["approved"] };
    expect(shouldProcessIssue(issue, config)).toBe(false);
  });

  it("returns true when issue has required label even with unknown author", () => {
    const issue: IssueInfo = { labels: ["approved"], author: "anyone" };
    const config: FilterConfig = {
      allowedAuthors: ["alice"],
      requiredLabels: ["approved"],
    };
    // Author doesn't match, but requiredLabels check passes
    expect(shouldProcessIssue(issue, config)).toBe(true);
  });

  it("passes title through without affecting logic", () => {
    const issue: IssueInfo = { labels: [], author: "alice", title: "Fix bug" };
    const config: FilterConfig = { allowedAuthors: ["alice"] };
    expect(shouldProcessIssue(issue, config)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldProcessPR
// ---------------------------------------------------------------------------

describe("shouldProcessPR", () => {
  const basePR: PRInfo = {
    labels: [],
    author: "alice",
    draft: false,
    branch: "feat/my-feature",
  };

  it("returns true when no filters configured", () => {
    expect(shouldProcessPR(basePR, {})).toBe(true);
  });

  it("filters out draft PRs when excludeDrafts is true", () => {
    const pr: PRInfo = { ...basePR, draft: true };
    expect(shouldProcessPR(pr, { excludeDrafts: true })).toBe(false);
  });

  it("allows draft PRs when excludeDrafts is false", () => {
    const pr: PRInfo = { ...basePR, draft: true };
    expect(shouldProcessPR(pr, { excludeDrafts: false })).toBe(true);
  });

  it("allows draft PRs when excludeDrafts is not set", () => {
    const pr: PRInfo = { ...basePR, draft: true };
    expect(shouldProcessPR(pr, {})).toBe(true);
  });

  it("filters PR whose branch does not match branchPatterns", () => {
    const pr: PRInfo = { ...basePR, branch: "main" };
    expect(shouldProcessPR(pr, { branchPatterns: ["claude/*"] })).toBe(false);
  });

  it("allows PR whose branch matches a glob pattern", () => {
    const pr: PRInfo = { ...basePR, branch: "claude/issue-42-fix-auth" };
    expect(shouldProcessPR(pr, { branchPatterns: ["claude/*"] })).toBe(true);
  });

  it("allows PR matching any of multiple branchPatterns", () => {
    const pr: PRInfo = { ...basePR, branch: "fix/my-fix" };
    expect(shouldProcessPR(pr, { branchPatterns: ["claude/*", "fix/*", "feat/*"] })).toBe(true);
  });

  it("applies issue-level label filters to PRs", () => {
    const pr: PRInfo = { ...basePR, labels: ["wontfix"] };
    expect(shouldProcessPR(pr, { excludeLabels: ["wontfix"] })).toBe(false);
  });

  it("applies allowedAuthors to PRs", () => {
    const pr: PRInfo = { ...basePR, author: "stranger" };
    expect(shouldProcessPR(pr, { allowedAuthors: ["alice", "bob"] })).toBe(false);
  });

  it("applies requiredLabels to PRs", () => {
    const pr: PRInfo = { ...basePR, labels: [] };
    expect(shouldProcessPR(pr, { requiredLabels: ["needs-review"] })).toBe(false);
  });

  it("handles combined filters — draft + exclude label", () => {
    const pr: PRInfo = { ...basePR, draft: true, labels: ["wontfix"] };
    // draft is checked first
    expect(shouldProcessPR(pr, { excludeDrafts: true, excludeLabels: ["wontfix"] })).toBe(false);
  });

  it("handles combined filters — branch pattern + allowed author", () => {
    // Branch doesn't match — should fail regardless of author
    const pr: PRInfo = { ...basePR, branch: "random/branch", author: "alice" };
    expect(shouldProcessPR(pr, { branchPatterns: ["claude/*"], allowedAuthors: ["alice"] })).toBe(false);
  });

  it("allows PR that passes all combined filters", () => {
    const pr: PRInfo = {
      labels: ["approved"],
      author: "alice",
      draft: false,
      branch: "claude/issue-99-auth",
    };
    const config: FilterConfig = {
      excludeDrafts: true,
      branchPatterns: ["claude/*"],
      excludeLabels: ["wontfix"],
      allowedAuthors: ["alice"],
    };
    expect(shouldProcessPR(pr, config)).toBe(true);
  });

  it("matches branch with ? wildcard in pattern", () => {
    const pr: PRInfo = { ...basePR, branch: "fix-1" };
    expect(shouldProcessPR(pr, { branchPatterns: ["fix-?"] })).toBe(true);
  });

  it("does not match partial branch with ^ anchor", () => {
    const pr: PRInfo = { ...basePR, branch: "not-claude/issue-1" };
    expect(shouldProcessPR(pr, { branchPatterns: ["claude/*"] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadFilterConfigFromEnv
// ---------------------------------------------------------------------------

describe("loadFilterConfigFromEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore environment after each test
    for (const key of [
      "FILTER_ALLOWED_AUTHORS",
      "FILTER_REQUIRED_LABELS",
      "FILTER_EXCLUDE_LABELS",
      "FILTER_BRANCH_PATTERNS",
      "FILTER_EXCLUDE_DRAFTS",
    ]) {
      delete process.env[key];
    }
  });

  it("returns empty config when no env vars set", () => {
    const config = loadFilterConfigFromEnv();
    expect(config.allowedAuthors).toBeUndefined();
    expect(config.requiredLabels).toBeUndefined();
    expect(config.excludeLabels).toBeUndefined();
    expect(config.branchPatterns).toBeUndefined();
    expect(config.excludeDrafts).toBe(false);
  });

  it("parses FILTER_ALLOWED_AUTHORS comma-separated", () => {
    process.env.FILTER_ALLOWED_AUTHORS = "alice,bob,charlie";
    const config = loadFilterConfigFromEnv();
    expect(config.allowedAuthors).toEqual(["alice", "bob", "charlie"]);
  });

  it("trims whitespace from FILTER_ALLOWED_AUTHORS", () => {
    process.env.FILTER_ALLOWED_AUTHORS = " alice , bob , charlie ";
    const config = loadFilterConfigFromEnv();
    expect(config.allowedAuthors).toEqual(["alice", "bob", "charlie"]);
  });

  it("parses FILTER_REQUIRED_LABELS comma-separated", () => {
    process.env.FILTER_REQUIRED_LABELS = "approved,ready-to-merge";
    const config = loadFilterConfigFromEnv();
    expect(config.requiredLabels).toEqual(["approved", "ready-to-merge"]);
  });

  it("parses FILTER_EXCLUDE_LABELS comma-separated", () => {
    process.env.FILTER_EXCLUDE_LABELS = "wontfix,duplicate,invalid";
    const config = loadFilterConfigFromEnv();
    expect(config.excludeLabels).toEqual(["wontfix", "duplicate", "invalid"]);
  });

  it("parses FILTER_BRANCH_PATTERNS comma-separated", () => {
    process.env.FILTER_BRANCH_PATTERNS = "claude/*,fix/*";
    const config = loadFilterConfigFromEnv();
    expect(config.branchPatterns).toEqual(["claude/*", "fix/*"]);
  });

  it("parses FILTER_EXCLUDE_DRAFTS=true as boolean true", () => {
    process.env.FILTER_EXCLUDE_DRAFTS = "true";
    const config = loadFilterConfigFromEnv();
    expect(config.excludeDrafts).toBe(true);
  });

  it("parses FILTER_EXCLUDE_DRAFTS=false as boolean false", () => {
    process.env.FILTER_EXCLUDE_DRAFTS = "false";
    const config = loadFilterConfigFromEnv();
    expect(config.excludeDrafts).toBe(false);
  });

  it("filters out empty strings from comma-separated values", () => {
    process.env.FILTER_ALLOWED_AUTHORS = "alice,,bob,";
    const config = loadFilterConfigFromEnv();
    expect(config.allowedAuthors).toEqual(["alice", "bob"]);
  });

  it("returns undefined array for single empty env var", () => {
    process.env.FILTER_ALLOWED_AUTHORS = "";
    const config = loadFilterConfigFromEnv();
    // split("") on empty string gives [""] which after filter(Boolean) is []
    // The array will exist but be empty — empty arrays don't trigger filters
    expect(config.allowedAuthors).toBeDefined();
    expect(config.allowedAuthors).toHaveLength(0);
  });
});
