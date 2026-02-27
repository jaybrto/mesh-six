export interface TriggerSyncInput {
  repoOwner: string;
  repoName: string;
  manifestDir: string;
}

export interface TriggerSyncResult {
  committed: boolean;
  message: string;
}

export async function triggerSync(
  input: TriggerSyncInput
): Promise<TriggerSyncResult> {
  // Manifests are committed directly via GitHub Contents API in prior activities.
  // ArgoCD will detect the commit and sync automatically.
  return { committed: true, message: "Manifests committed via GitHub API" };
}
