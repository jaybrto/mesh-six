import { join } from "path";

export interface UpdateKustomizationInput {
  repoOwner: string;
  repoName: string;
}

export interface UpdateKustomizationResult {
  alreadyPresent: boolean;
}

export async function updateKustomization(
  input: UpdateKustomizationInput
): Promise<UpdateKustomizationResult> {
  const { repoOwner, repoName } = input;
  const entry = `envs/${repoOwner}-${repoName}/`;

  const repoRoot = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    ".."
  );
  const kustomizationPath = join(repoRoot, "k8s", "base", "kustomization.yaml");

  const content = await Bun.file(kustomizationPath).text();

  if (content.includes(entry)) {
    return { alreadyPresent: true };
  }

  // Insert the new entry before the `commonLabels:` line
  const updated = content.replace(
    /^commonLabels:/m,
    `  - ${entry}\n\ncommonLabels:`
  );

  await Bun.write(kustomizationPath, updated);
  return { alreadyPresent: false };
}
