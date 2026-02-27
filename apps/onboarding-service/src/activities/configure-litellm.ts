import { LITELLM_URL, LITELLM_ADMIN_KEY } from "../config.js";

export interface ConfigureLitellmInput {
  repoOwner: string;
  repoName: string;
  teamAlias?: string;
  defaultModel?: string;
  maxBudget?: number;
}

export interface ConfigureLitellmResult {
  teamId: string;
  teamAlias: string;
  virtualKey: string;
  alreadyExisted: boolean;
}

export async function configureLitellm(
  input: ConfigureLitellmInput
): Promise<ConfigureLitellmResult> {
  const { repoOwner, repoName, defaultModel, maxBudget } = input;
  const teamAlias = input.teamAlias ?? `${repoOwner}/${repoName}`;

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${LITELLM_ADMIN_KEY}`,
  };

  // Check for an existing team with the matching alias
  const listResponse = await fetch(`${LITELLM_URL}/team/list`, {
    method: "GET",
    headers: authHeaders,
  });

  if (!listResponse.ok) {
    const body = await listResponse.text();
    throw new Error(
      `Failed to list LiteLLM teams: ${listResponse.status} ${body}`
    );
  }

  const listData = (await listResponse.json()) as { teams?: { team_alias?: string; team_id?: string }[] };
  const teams: { team_alias?: string; team_id?: string }[] = listData.teams ?? (Array.isArray(listData) ? (listData as { team_alias?: string; team_id?: string }[]) : []);

  const existing = teams.find((t) => t.team_alias === teamAlias);
  if (existing && existing.team_id) {
    // Team already exists — generate a virtual key for the existing team and return early
    const keyResponse = await fetch(`${LITELLM_URL}/key/generate`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ team_id: existing.team_id }),
    });

    if (!keyResponse.ok) {
      const body = await keyResponse.text();
      throw new Error(
        `Failed to generate LiteLLM virtual key for existing team ${existing.team_id}: ${keyResponse.status} ${body}`
      );
    }

    const keyData = (await keyResponse.json()) as { key: string };
    return {
      teamId: existing.team_id,
      teamAlias,
      virtualKey: keyData.key,
      alreadyExisted: true,
    };
  }

  // Create a new team
  const createBody: Record<string, unknown> = { team_alias: teamAlias };
  if (defaultModel) createBody.model = defaultModel;
  if (maxBudget !== undefined) createBody.max_budget = maxBudget;

  const createResponse = await fetch(`${LITELLM_URL}/team/new`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(createBody),
  });

  if (!createResponse.ok) {
    const body = await createResponse.text();
    throw new Error(
      `Failed to create LiteLLM team for ${teamAlias}: ${createResponse.status} ${body}`
    );
  }

  const createData = (await createResponse.json()) as { team_id: string };
  const teamId = createData.team_id;

  // Generate a virtual key for the new team
  const keyResponse = await fetch(`${LITELLM_URL}/key/generate`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ team_id: teamId }),
  });

  if (!keyResponse.ok) {
    const body = await keyResponse.text();
    throw new Error(
      `Failed to generate LiteLLM virtual key for team ${teamId}: ${keyResponse.status} ${body}`
    );
  }

  const keyData = (await keyResponse.json()) as { key: string };

  return {
    teamId,
    teamAlias,
    virtualKey: keyData.key,
    alreadyExisted: false,
  };
}
