#!/usr/bin/env bun
/**
 * Repository Onboarding Script
 *
 * Registers a GitHub repo with mesh-six:
 *   1. Verifies the repo exists via GitHub API
 *   2. Creates a GitHub Projects v2 with standard mesh-six columns/fields
 *   3. Inserts a row into repo_registry
 *   4. Prints a checklist of remaining manual steps
 *
 * Usage:
 *   bun run scripts/onboard-repo.ts <owner/repo> [project-name]
 *
 * Environment:
 *   GITHUB_TOKEN             GitHub PAT with project + repo scope
 *   DATABASE_URL or PG_PRIMARY_URL
 */

import pg from "pg";

const ownerRepo = Bun.argv[2];
const projectName = Bun.argv[3];

if (!ownerRepo || !ownerRepo.includes("/")) {
  console.error("Usage: bun run scripts/onboard-repo.ts <owner/repo> [project-name]");
  console.error("Example: bun run scripts/onboard-repo.ts acme/backend");
  process.exit(1);
}

const [repoOwner, repoName] = ownerRepo.split("/") as [string, string];
const displayName = projectName ?? `mesh-six: ${ownerRepo}`;

const githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) {
  console.error("Error: GITHUB_TOKEN environment variable is required");
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL;
if (!databaseUrl) {
  console.error("Error: DATABASE_URL or PG_PRIMARY_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

const graphqlHeaders = {
  Authorization: `Bearer ${githubToken}`,
  "Content-Type": "application/json",
  "X-Github-Next-Global-ID": "1",
};

async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const resp = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: graphqlHeaders,
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    throw new Error(`GitHub GraphQL request failed: ${resp.status} ${await resp.text()}`);
  }
  const json = (await resp.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  if (!json.data) {
    throw new Error("GraphQL response missing data");
  }
  return json.data;
}

async function restGet<T>(path: string): Promise<T> {
  const resp = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!resp.ok) {
    throw new Error(`GitHub REST ${path} failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json() as Promise<T>;
}

async function run() {
  // --- 1. Verify repo exists ---
  console.log(`Verifying repo ${ownerRepo}...`);
  const repo = await restGet<{ id: number; full_name: string; html_url: string; node_id: string }>(
    `/repos/${ownerRepo}`
  );
  console.log(`  Found: ${repo.html_url}`);
  const repoNodeId = repo.node_id;

  // --- 2. Fetch owner's node ID ---
  const ownerData = await graphql<{ repositoryOwner: { id: string } }>(`
    query($login: String!) {
      repositoryOwner(login: $login) { id }
    }
  `, { login: repoOwner });
  const ownerId = ownerData.repositoryOwner.id;

  // --- 3. Create GitHub Project v2 ---
  console.log(`\nCreating GitHub Project: "${displayName}"...`);
  const createProjectData = await graphql<{
    createProjectV2: { projectV2: { id: string; url: string; number: number } };
  }>(`
    mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id url number }
      }
    }
  `, { ownerId, title: displayName });

  const project = createProjectData.createProjectV2.projectV2;
  console.log(`  Created: ${project.url}`);
  console.log(`  Project ID: ${project.id}`);

  // --- 4. Link project to repository ---
  console.log(`\nLinking project to ${ownerRepo}...`);
  await graphql(`
    mutation($projectId: ID!, $repositoryId: ID!) {
      linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
        repository { nameWithOwner }
      }
    }
  `, { projectId: project.id, repositoryId: repoNodeId });
  console.log(`  Linked.`);

  // --- 5. Create custom Status field options ---
  // GitHub Projects v2 has a built-in Status field; we update its options to match mesh-six workflow.
  // We need to get the existing Status field ID first.
  const fieldsData = await graphql<{
    node: {
      fields: {
        nodes: { id: string; name: string; __typename: string }[];
      };
    };
  }>(`
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2Field { id name __typename }
              ... on ProjectV2IterationField { id name __typename }
              ... on ProjectV2SingleSelectField { id name __typename }
            }
          }
        }
      }
    }
  `, { projectId: project.id });

  const existingFields = fieldsData.node.fields.nodes;
  console.log(`\nExisting project fields: ${existingFields.map((f) => f.name).join(", ")}`);

  // --- 6. Create custom text fields ---
  const customFields: { name: string; dataType: string }[] = [
    { name: "Session ID", dataType: "TEXT" },
    { name: "Pod Name", dataType: "TEXT" },
  ];

  const createdFieldIds: Record<string, string> = {};

  for (const field of customFields) {
    console.log(`\nCreating custom field: ${field.name}...`);
    const fieldData = await graphql<{
      createProjectV2Field: { projectV2Field: { id: string } };
    }>(`
      mutation($projectId: ID!, $dataType: ProjectV2CustomFieldType!, $name: String!) {
        createProjectV2Field(input: { projectId: $projectId, dataType: $dataType, name: $name }) {
          projectV2Field {
            ... on ProjectV2Field { id }
          }
        }
      }
    `, { projectId: project.id, dataType: field.dataType, name: field.name });
    const fieldId = fieldData.createProjectV2Field.projectV2Field.id;
    createdFieldIds[field.name] = fieldId;
    console.log(`  Created: ${field.name} (${fieldId})`);
  }

  // --- 7. Create Priority single-select field ---
  console.log(`\nCreating Priority field...`);
  const priorityData = await graphql<{
    createProjectV2Field: { projectV2Field: { id: string } };
  }>(`
    mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
      createProjectV2Field(input: {
        projectId: $projectId,
        dataType: SINGLE_SELECT,
        name: $name,
        singleSelectOptions: $options
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField { id }
        }
      }
    }
  `, {
    projectId: project.id,
    name: "Priority",
    options: [
      { name: "Critical", color: "RED", description: "Must fix immediately" },
      { name: "High", color: "ORANGE", description: "Important feature or fix" },
      { name: "Medium", color: "YELLOW", description: "Normal priority" },
      { name: "Low", color: "GREEN", description: "Nice to have" },
    ],
  });
  createdFieldIds["Priority"] = priorityData.createProjectV2Field.projectV2Field.id;
  console.log(`  Created: Priority (${createdFieldIds["Priority"]})`);

  // --- 8. Insert into repo_registry ---
  console.log(`\nRegistering ${ownerRepo} in repo_registry...`);
  const metadata = {
    github_project_id: project.id,
    github_project_url: project.url,
    github_project_number: project.number,
    field_ids: createdFieldIds,
  };
  await pool.query(`
    INSERT INTO repo_registry (
      service_name, repo_url, platform, default_branch, cicd_type, trigger_method, board_id, metadata, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
    ON CONFLICT (service_name) DO UPDATE SET
      board_id = EXCLUDED.board_id,
      metadata = EXCLUDED.metadata,
      updated_at = now()
  `, [ownerRepo, `https://github.com/${ownerRepo}`, "github", "main", "github-actions", "webhook", project.id, JSON.stringify(metadata)]);
  console.log(`  Registered.`);

  await pool.end();

  // --- Summary ---
  console.log(`
====================================================
Onboarding complete for ${ownerRepo}
====================================================
Project URL:    ${project.url}
Project ID:     ${project.id}

Custom Fields:
${Object.entries(createdFieldIds).map(([k, v]) => `  ${k.padEnd(14)} ${v}`).join("\n")}

Manual Steps Checklist:
  [ ] Configure GitHub webhook on ${ownerRepo}:
        URL:      https://<your-webhook-receiver>/webhook/github
        Events:   Issues, Projects v2 item events
        Secret:   set GITHUB_WEBHOOK_SECRET in mesh-six-env
  [ ] Add GITHUB_TOKEN to Vault at secret/data/mesh-six
  [ ] Label issues "simple" to bypass Opus planning for small tasks
  [ ] Verify ArgoCD sync picks up any new k8s config
====================================================
`);
}

run().catch((err) => {
  console.error("Onboarding failed:", err);
  process.exit(1);
});
