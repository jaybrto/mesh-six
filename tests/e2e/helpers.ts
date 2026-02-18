import pg from "pg";

// ---- Configuration ----
export const TEST_REPO_OWNER = process.env.TEST_REPO_OWNER || "bto-labs";
export const TEST_REPO_NAME = process.env.TEST_REPO_NAME || "gwa-test-app";
export const TEST_PROJECT_ID = process.env.TEST_PROJECT_ID || "";
export const TEST_APP_URL = process.env.TEST_APP_URL || "https://test-app.bto.bar";
export const DATABASE_URL = process.env.DATABASE_URL || "";

// ---- Generic polling utility ----
export async function waitFor<T>(
  description: string,
  fn: () => Promise<T | null>,
  timeoutMs: number,
  pollIntervalMs = 5000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result !== null && result !== undefined) {
        console.log(`✓ ${description}`);
        return result;
      }
    } catch (err) {
      // Transient error — log and retry
      console.warn(`⚠ ${description}: transient error, retrying... (${(err as Error).message})`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Timeout (${timeoutMs}ms) waiting for: ${description}`);
}

// ---- GitHub REST helpers ----
async function githubRequest(path: string, options: RequestInit = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN env var required");
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function githubGraphQL(query: string, variables: Record<string, unknown>) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN env var required");
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = (await res.json()) as { data?: unknown; errors?: unknown[] };
  if (json.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// ---- Issue helpers ----
export async function createTestIssue(
  title: string,
  body: string
): Promise<{ issueNumber: number; nodeId: string }> {
  const data = await githubRequest(
    `/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues`,
    {
      method: "POST",
      body: JSON.stringify({ title, body, labels: ["feature-request"] }),
    }
  ) as { number: number; node_id: string };
  return { issueNumber: data.number, nodeId: data.node_id };
}

export async function closeTestIssue(issueNumber: number): Promise<void> {
  await githubRequest(
    `/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/${issueNumber}`,
    {
      method: "PATCH",
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    }
  );
}

export async function getIssueComments(
  issueNumber: number
): Promise<Array<{ body: string; createdAt: string }>> {
  const data = await githubRequest(
    `/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/${issueNumber}/comments?per_page=100`
  ) as Array<{ body: string; created_at: string }>;
  // Reverse to newest-first (GitHub returns oldest-first, and .find() picks the first match)
  return data
    .map((c) => ({ body: c.body, createdAt: c.created_at }))
    .reverse();
}

export async function getOpenPRs(): Promise<Array<{ number: number; body?: string; title: string }>> {
  return githubRequest(
    `/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/pulls?state=open&per_page=30&sort=created`
  ) as Promise<Array<{ number: number; body?: string; title: string }>>;
}

// ---- GitHub Projects helpers ----
export async function addIssueToProjectBoard(
  issueNodeId: string
): Promise<string> {
  const data = await githubGraphQL(
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }`,
    { projectId: TEST_PROJECT_ID, contentId: issueNodeId }
  ) as { addProjectV2ItemById: { item: { id: string } } };
  return data.addProjectV2ItemById.item.id;
}

export async function getItemColumn(projectItemId: string): Promise<string | null> {
  const data = await githubGraphQL(
    `query($itemId: ID!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
        }
      }
    }`,
    { itemId: projectItemId }
  ) as { node: { fieldValues: { nodes: Array<{ name?: string; field?: { name: string } }> } } };
  const statusField = data.node.fieldValues.nodes.find((n) => n.field?.name === "Status");
  return statusField?.name ?? null;
}

// ---- Database helpers ----
let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!DATABASE_URL) throw new Error("DATABASE_URL env var not set");
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

export async function queryMeshEvent(
  eventType: string,
  agentId: string,
  sinceMs: number
): Promise<boolean> {
  if (!DATABASE_URL) return false;
  const pool = getPool();
  const result = await pool.query(
    `SELECT COUNT(*) FROM mesh_six_events
     WHERE event_type = $1 AND agent_id = $2
       AND timestamp > NOW() - make_interval(secs => $3::numeric / 1000)`,
    [eventType, agentId, sinceMs]
  );
  return parseInt(result.rows[0].count) > 0;
}
