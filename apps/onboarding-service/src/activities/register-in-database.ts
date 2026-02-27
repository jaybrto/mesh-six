import pg from "pg";

export interface RegisterInDatabaseInput {
  repoOwner: string;
  repoName: string;
  fullName: string;
  defaultBranch: string;
  repoNodeId: string;
  projectId: string;
  projectUrl: string;
  projectNumber: number;
  statusFieldId: string;
  sessionIdFieldId: string;
  podNameFieldId: string;
  workflowIdFieldId: string;
  priorityFieldId: string;
  webhookSecretPath: string;
}

export async function registerInDatabase(
  pool: pg.Pool,
  input: RegisterInDatabaseInput
): Promise<void> {
  const {
    repoOwner,
    repoName,
    fullName,
    defaultBranch,
    repoNodeId,
    projectId,
    projectUrl,
    projectNumber,
    statusFieldId,
    sessionIdFieldId,
    podNameFieldId,
    workflowIdFieldId,
    priorityFieldId,
    webhookSecretPath,
  } = input;

  const metadata = {
    repoNodeId,
    projectFieldIds: {
      status: statusFieldId,
      sessionId: sessionIdFieldId,
      podName: podNameFieldId,
      workflowId: workflowIdFieldId,
      priority: priorityFieldId,
    },
    webhookSecretPath,
  };

  await pool.query(
    `INSERT INTO repo_registry (
      owner,
      name,
      full_name,
      default_branch,
      github_project_id,
      github_project_url,
      github_project_number,
      execution_mode,
      metadata,
      created_at,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
    ON CONFLICT (owner, name) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      default_branch = EXCLUDED.default_branch,
      github_project_id = EXCLUDED.github_project_id,
      github_project_url = EXCLUDED.github_project_url,
      github_project_number = EXCLUDED.github_project_number,
      execution_mode = EXCLUDED.execution_mode,
      metadata = EXCLUDED.metadata,
      updated_at = now()`,
    [
      repoOwner,
      repoName,
      fullName,
      defaultBranch,
      projectId,
      projectUrl,
      projectNumber,
      "envbuilder",
      JSON.stringify(metadata),
    ]
  );
}
