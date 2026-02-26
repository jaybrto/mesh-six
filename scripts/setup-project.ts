#!/usr/bin/env bun
/**
 * GitHub Project Setup Script
 *
 * Creates a GitHub Projects v2 with standard mesh-six workflow columns and
 * custom fields, then links it to a repository.
 *
 * Usage:
 *   bun run scripts/setup-project.ts <owner/repo> <project-name>
 *
 * Example:
 *   bun run scripts/setup-project.ts acme/backend "mesh-six: acme/backend"
 *
 * Environment:
 *   GITHUB_TOKEN   GitHub PAT with project + repo scope
 */

const ownerRepo = Bun.argv[2];
const projectTitle = Bun.argv[3];

if (!ownerRepo || !ownerRepo.includes("/") || !projectTitle) {
  console.error("Usage: bun run scripts/setup-project.ts <owner/repo> <project-name>");
  console.error('Example: bun run scripts/setup-project.ts acme/backend "mesh-six: acme/backend"');
  process.exit(1);
}

const [repoOwner] = ownerRepo.split("/") as [string, string];

const githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) {
  console.error("Error: GITHUB_TOKEN environment variable is required");
  process.exit(1);
}

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
  // --- 1. Resolve owner ID and repo node ID ---
  console.log(`Resolving ${ownerRepo}...`);
  const repo = await restGet<{ node_id: string; html_url: string }>(
    `/repos/${ownerRepo}`
  );
  const repoNodeId = repo.node_id;

  const ownerData = await graphql<{ repositoryOwner: { id: string } }>(`
    query($login: String!) {
      repositoryOwner(login: $login) { id }
    }
  `, { login: repoOwner });
  const ownerId = ownerData.repositoryOwner.id;
  console.log(`  Repo node ID: ${repoNodeId}`);
  console.log(`  Owner node ID: ${ownerId}`);

  // --- 2. Create project ---
  console.log(`\nCreating project "${projectTitle}"...`);
  const createData = await graphql<{
    createProjectV2: { projectV2: { id: string; url: string; number: number } };
  }>(`
    mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id url number }
      }
    }
  `, { ownerId, title: projectTitle });
  const project = createData.createProjectV2.projectV2;
  console.log(`  URL:    ${project.url}`);
  console.log(`  ID:     ${project.id}`);
  console.log(`  Number: ${project.number}`);

  // --- 3. Link to repository ---
  console.log(`\nLinking to ${ownerRepo}...`);
  await graphql(`
    mutation($projectId: ID!, $repositoryId: ID!) {
      linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
        repository { nameWithOwner }
      }
    }
  `, { projectId: project.id, repositoryId: repoNodeId });
  console.log(`  Linked.`);

  // --- 4. Create custom text fields ---
  const textFields = [
    { name: "Session ID", description: "mesh-six session UUID" },
    { name: "Pod Name", description: "Kubernetes pod running the session" },
    { name: "Workflow ID", description: "Dapr Workflow instance ID" },
  ];

  console.log(`\nCreating custom text fields...`);
  const fieldIds: Record<string, string> = {};

  for (const field of textFields) {
    const fieldData = await graphql<{
      createProjectV2Field: { projectV2Field: { id: string } };
    }>(`
      mutation($projectId: ID!, $name: String!) {
        createProjectV2Field(input: { projectId: $projectId, dataType: TEXT, name: $name }) {
          projectV2Field {
            ... on ProjectV2Field { id }
          }
        }
      }
    `, { projectId: project.id, name: field.name });
    fieldIds[field.name] = fieldData.createProjectV2Field.projectV2Field.id;
    console.log(`  ${field.name.padEnd(16)} ${fieldIds[field.name]}`);
  }

  // --- 5. Create Priority field ---
  console.log(`\nCreating Priority field...`);
  const priorityData = await graphql<{
    createProjectV2Field: { projectV2Field: { id: string } };
  }>(`
    mutation($projectId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
      createProjectV2Field(input: {
        projectId: $projectId,
        dataType: SINGLE_SELECT,
        name: "Priority",
        singleSelectOptions: $options
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField { id }
        }
      }
    }
  `, {
    projectId: project.id,
    options: [
      { name: "Critical", color: "RED", description: "Must fix immediately" },
      { name: "High", color: "ORANGE", description: "Important feature or fix" },
      { name: "Medium", color: "YELLOW", description: "Normal priority" },
      { name: "Low", color: "GREEN", description: "Nice to have" },
    ],
  });
  fieldIds["Priority"] = priorityData.createProjectV2Field.projectV2Field.id;
  console.log(`  Priority         ${fieldIds["Priority"]}`);

  // --- Summary ---
  console.log(`
====================================================
Project setup complete
====================================================
Repository:    ${ownerRepo}
Project URL:   ${project.url}
Project ID:    ${project.id}
Project #:     ${project.number}

Field IDs (for environment config):
  GITHUB_PROJECT_ID=${project.id}
${Object.entries(fieldIds).map(([k, v]) => `  # ${k}: ${v}`).join("\n")}

Notes:
  - The built-in Status field has columns: Todo, In Progress, Done
    Rename/add columns in the GitHub UI to match mesh-six phases:
    Todo, Planning, In Progress, QA, Blocked, Review, Done
  - Use onboard-repo.ts to also register in repo_registry DB table
====================================================
`);
}

run().catch((err) => {
  console.error("Project setup failed:", err);
  process.exit(1);
});
