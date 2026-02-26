/**
 * PR and issue filter logic for mesh-six.
 * Determines which GitHub events should trigger agent processing.
 * Ported from GWA src/lib/pr-filter.ts.
 */

export interface FilterConfig {
  /** Authors whose PRs/issues are always processed */
  allowedAuthors?: string[];
  /** Issues/PRs must have at least one of these labels to be processed */
  requiredLabels?: string[];
  /** Issues/PRs with any of these labels are excluded */
  excludeLabels?: string[];
  /** PR branch must match at least one pattern (glob-style, e.g. 'claude/*') */
  branchPatterns?: string[];
  /** Skip draft PRs */
  excludeDrafts?: boolean;
}

export interface IssueInfo {
  labels: string[];
  author: string;
  title?: string;
}

export interface PRInfo {
  labels: string[];
  author: string;
  draft: boolean;
  branch: string;
  title?: string;
}

/**
 * Check if an issue should be processed by mesh-six agents.
 */
export function shouldProcessIssue(issue: IssueInfo, config: FilterConfig): boolean {
  // If no config rules, process everything
  if (!config.allowedAuthors?.length && !config.requiredLabels?.length && !config.excludeLabels?.length) {
    return true;
  }

  // Check exclude labels first (highest priority)
  if (config.excludeLabels?.length) {
    if (issue.labels.some(l => config.excludeLabels!.includes(l))) {
      return false;
    }
  }

  // Check allowed authors
  if (config.allowedAuthors?.length) {
    if (config.allowedAuthors.includes(issue.author)) {
      return true;
    }
  }

  // Check required labels
  if (config.requiredLabels?.length) {
    return issue.labels.some(l => config.requiredLabels!.includes(l));
  }

  // If only allowedAuthors was set and author didn't match, reject
  if (config.allowedAuthors?.length) {
    return false;
  }

  return true;
}

/**
 * Check if a PR should be processed by mesh-six agents.
 */
export function shouldProcessPR(pr: PRInfo, config: FilterConfig): boolean {
  // Check draft exclusion
  if (config.excludeDrafts && pr.draft) {
    return false;
  }

  // Check branch pattern
  if (config.branchPatterns?.length) {
    const matchesBranch = config.branchPatterns.some(pattern => matchBranchPattern(pr.branch, pattern));
    if (!matchesBranch) {
      return false;
    }
  }

  // Delegate to issue filter for labels/authors
  return shouldProcessIssue(
    { labels: pr.labels, author: pr.author, title: pr.title },
    config
  );
}

/**
 * Simple glob-style branch pattern matching.
 * Supports '*' as wildcard for any characters.
 * Example: 'claude/*' matches 'claude/issue-42-fix-auth'
 */
function matchBranchPattern(branch: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return regex.test(branch);
}

/**
 * Load filter config from environment variables.
 */
export function loadFilterConfigFromEnv(): FilterConfig {
  return {
    allowedAuthors: process.env.FILTER_ALLOWED_AUTHORS?.split(",").map(s => s.trim()).filter(Boolean),
    requiredLabels: process.env.FILTER_REQUIRED_LABELS?.split(",").map(s => s.trim()).filter(Boolean),
    excludeLabels: process.env.FILTER_EXCLUDE_LABELS?.split(",").map(s => s.trim()).filter(Boolean),
    branchPatterns: process.env.FILTER_BRANCH_PATTERNS?.split(",").map(s => s.trim()).filter(Boolean),
    excludeDrafts: process.env.FILTER_EXCLUDE_DRAFTS === "true",
  };
}
