/**
 * GitHub Projects GraphQL Operations
 *
 * Shared utility module for interacting with GitHub Projects v2 board.
 * Used by both webhook-receiver (polling) and project-manager (card moves).
 */

import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";

export interface GitHubClientConfig {
  token: string;
  projectId: string;
  statusFieldId: string;
}

export interface ColumnMapping {
  [columnName: string]: string; // column name → option ID
}

export interface ProjectItem {
  id: string;
  contentNodeId: string;
  issueNumber: number;
  issueTitle: string;
  repoOwner: string;
  repoName: string;
  currentColumn: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface LinkedPR {
  number: number;
  title: string;
  state: string;
  url: string;
  createdAt: string;
}

export interface TokenBucketConfig {
  maxTokens: number;
  refillRate: number; // tokens per minute
}

export class TokenBucket {
  private tokens: number;
  private maxTokens: number;
  private refillRatePerMs: number;
  private lastRefill: number;

  constructor(config: TokenBucketConfig) {
    this.maxTokens = config.maxTokens;
    this.tokens = config.maxTokens;
    this.refillRatePerMs = config.refillRate / 60_000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;
  }

  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async waitForToken(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const deficit = 1 - this.tokens;
    const waitMs = Math.ceil(deficit / this.refillRatePerMs);
    await new Promise((r) => setTimeout(r, waitMs));
    this.refill();
    this.tokens -= 1;
  }
}

export class GitHubProjectClient {
  private gql: typeof graphql;
  private rest: Octokit;
  private projectId: string;
  private statusFieldId: string;
  private columnMap: ColumnMapping = {};
  private rateLimiter: TokenBucket;

  constructor(config: GitHubClientConfig) {
    this.gql = graphql.defaults({
      headers: { authorization: `token ${config.token}` },
    });
    this.rest = new Octokit({ auth: config.token });
    this.projectId = config.projectId;
    this.statusFieldId = config.statusFieldId;
    this.rateLimiter = new TokenBucket({ maxTokens: 50, refillRate: 80 });
  }

  private async rateLimit(): Promise<void> {
    await this.rateLimiter.waitForToken();
  }

  /**
   * Load column name → option ID mapping from the project's Status field.
   * Must be called once at startup before moveCard can work.
   */
  async loadColumnMapping(): Promise<ColumnMapping> {
    await this.rateLimit();
    const result: any = await this.gql(
      `query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            field(name: "Status") {
              ... on ProjectV2SingleSelectField {
                id
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }`,
      { projectId: this.projectId }
    );

    const options = result.node?.field?.options ?? [];
    this.columnMap = {};
    for (const opt of options) {
      this.columnMap[opt.name] = opt.id;
    }

    // Also capture the field ID from the query in case it differs
    const fieldId = result.node?.field?.id;
    if (fieldId) {
      this.statusFieldId = fieldId;
    }

    return this.columnMap;
  }

  /**
   * Get the current column mapping (call loadColumnMapping first).
   */
  getColumnMap(): ColumnMapping {
    return { ...this.columnMap };
  }

  /**
   * Move a project card to a target column.
   */
  async moveCard(projectItemId: string, toColumn: string): Promise<void> {
    await this.rateLimit();
    const optionId = this.columnMap[toColumn];
    if (!optionId) {
      throw new Error(
        `Unknown column "${toColumn}". Known columns: ${Object.keys(this.columnMap).join(", ")}`
      );
    }

    await this.gql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { singleSelectOptionId: $optionId }
        }) {
          projectV2Item {
            id
          }
        }
      }`,
      {
        projectId: this.projectId,
        itemId: projectItemId,
        fieldId: this.statusFieldId,
        optionId,
      }
    );
  }

  /**
   * Get the current column of a project item.
   */
  async getItemColumn(projectItemId: string): Promise<string | null> {
    await this.rateLimit();
    const result: any = await this.gql(
      `query($itemId: ID!) {
        node(id: $itemId) {
          ... on ProjectV2Item {
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
              }
            }
          }
        }
      }`,
      { itemId: projectItemId }
    );

    return result.node?.fieldValueByName?.name ?? null;
  }

  /**
   * Get all project items currently in a given column (e.g., "Todo").
   */
  async getProjectItemsByColumn(columnName: string): Promise<ProjectItem[]> {
    await this.rateLimit();
    const items: ProjectItem[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const result: any = await this.gql(
        `query($projectId: ID!, $cursor: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: 50, after: $cursor) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                  fieldValueByName(name: "Status") {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                    }
                  }
                  content {
                    ... on Issue {
                      number
                      title
                      repository {
                        owner { login }
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
        { projectId: this.projectId, cursor }
      );

      const connection = result.node?.items;
      if (!connection) break;

      for (const node of connection.nodes ?? []) {
        const status = node.fieldValueByName?.name;
        if (status !== columnName) continue;

        const content = node.content;
        if (!content?.number) continue;

        items.push({
          id: node.id,
          contentNodeId: content.id || node.id,
          issueNumber: content.number,
          issueTitle: content.title,
          repoOwner: content.repository?.owner?.login ?? "",
          repoName: content.repository?.name ?? "",
          currentColumn: status,
        });
      }

      hasMore = connection.pageInfo.hasNextPage;
      cursor = connection.pageInfo.endCursor;
    }

    return items;
  }

  /**
   * Convenience alias for getProjectItemsByColumn("Todo").
   */
  async getProjectTodoItems(): Promise<ProjectItem[]> {
    return this.getProjectItemsByColumn("Todo");
  }

  /**
   * Fetch comments on a GitHub issue via REST API.
   */
  async getIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    since?: string
  ): Promise<IssueComment[]> {
    await this.rateLimit();
    const { data } = await this.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
      since,
    });

    return data.map((c) => ({
      id: c.id,
      body: c.body ?? "",
      user: c.user?.login ?? "unknown",
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));
  }

  /**
   * Search for PRs linked to a given issue number.
   */
  async getIssuePRs(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<LinkedPR[]> {
    await this.rateLimit();
    const { data } = await this.rest.pulls.list({
      owner,
      repo,
      state: "all",
      per_page: 30,
      sort: "created",
      direction: "desc",
    });

    // Filter to PRs that reference this issue
    const issueRef = `#${issueNumber}`;
    const closesPatterns = [
      `closes ${issueRef}`,
      `fixes ${issueRef}`,
      `resolves ${issueRef}`,
      `close ${issueRef}`,
      `fix ${issueRef}`,
      `resolve ${issueRef}`,
    ];

    return data
      .filter((pr) => {
        const body = (pr.body ?? "").toLowerCase();
        const title = pr.title.toLowerCase();
        return (
          title.includes(issueRef) ||
          body.includes(issueRef) ||
          closesPatterns.some((p) => body.includes(p))
        );
      })
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        url: pr.html_url,
        createdAt: pr.created_at,
      }));
  }

  /**
   * Add a comment to a GitHub issue.
   */
  async addIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<number> {
    await this.rateLimit();
    const { data } = await this.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return data.id;
  }

  /**
   * Create a new GitHub issue.
   */
  async createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string,
    labels?: string[]
  ): Promise<{ number: number; url: string }> {
    await this.rateLimit();
    const { data } = await this.rest.issues.create({
      owner,
      repo,
      title,
      body,
      labels: labels ?? [],
    });
    return { number: data.number, url: data.html_url };
  }
}
