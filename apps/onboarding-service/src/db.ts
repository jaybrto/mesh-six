import pg from "pg";

export interface OnboardingRun {
  id: string;
  repoOwner: string;
  repoName: string;
  status: "pending" | "running" | "waiting_auth" | "completed" | "failed";
  currentPhase: string | null;
  currentActivity: string | null;
  completedActivities: string[];
  errorMessage: string | null;
  oauthDeviceUrl: string | null;
  oauthUserCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface OnboardingRunRow {
  id: string;
  repo_owner: string;
  repo_name: string;
  status: string;
  current_phase: string | null;
  current_activity: string | null;
  completed_activities: string[];
  error_message: string | null;
  oauth_device_url: string | null;
  oauth_user_code: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToRun(row: OnboardingRunRow): OnboardingRun {
  return {
    id: row.id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    status: row.status as OnboardingRun["status"],
    currentPhase: row.current_phase,
    currentActivity: row.current_activity,
    completedActivities: row.completed_activities ?? [],
    errorMessage: row.error_message,
    oauthDeviceUrl: row.oauth_device_url,
    oauthUserCode: row.oauth_user_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertRun(
  pool: pg.Pool,
  run: { id: string; repoOwner: string; repoName: string }
): Promise<OnboardingRun> {
  const { rows } = await pool.query<OnboardingRunRow>(
    `INSERT INTO onboarding_runs (id, repo_owner, repo_name, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING *`,
    [run.id, run.repoOwner, run.repoName]
  );
  return rowToRun(rows[0]);
}

export async function getRun(pool: pg.Pool, id: string): Promise<OnboardingRun | null> {
  const { rows } = await pool.query<OnboardingRunRow>(
    "SELECT * FROM onboarding_runs WHERE id = $1",
    [id]
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}

export async function updateRunStatus(
  pool: pg.Pool,
  id: string,
  updates: {
    status?: OnboardingRun["status"];
    currentPhase?: string | null;
    currentActivity?: string | null;
    completedActivities?: string[];
    errorMessage?: string | null;
    oauthDeviceUrl?: string | null;
    oauthUserCode?: string | null;
  }
): Promise<OnboardingRun | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.status !== undefined) {
    sets.push(`status = $${idx++}`);
    params.push(updates.status);
  }
  if (updates.currentPhase !== undefined) {
    sets.push(`current_phase = $${idx++}`);
    params.push(updates.currentPhase);
  }
  if (updates.currentActivity !== undefined) {
    sets.push(`current_activity = $${idx++}`);
    params.push(updates.currentActivity);
  }
  if (updates.completedActivities !== undefined) {
    sets.push(`completed_activities = $${idx++}`);
    params.push(updates.completedActivities);
  }
  if (updates.errorMessage !== undefined) {
    sets.push(`error_message = $${idx++}`);
    params.push(updates.errorMessage);
  }
  if (updates.oauthDeviceUrl !== undefined) {
    sets.push(`oauth_device_url = $${idx++}`);
    params.push(updates.oauthDeviceUrl);
  }
  if (updates.oauthUserCode !== undefined) {
    sets.push(`oauth_user_code = $${idx++}`);
    params.push(updates.oauthUserCode);
  }

  params.push(id);
  const { rows } = await pool.query<OnboardingRunRow>(
    `UPDATE onboarding_runs SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}
