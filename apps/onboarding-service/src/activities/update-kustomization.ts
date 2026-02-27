import { Octokit } from "@octokit/rest";
import { GITHUB_TOKEN, MESH_SIX_REPO_OWNER, MESH_SIX_REPO_NAME } from "../config.js";

export interface UpdateKustomizationInput {
  repoOwner: string;
  repoName: string;
}

export interface UpdateKustomizationResult {
  alreadyPresent: boolean;
}

const KUSTOMIZATION_PATH = "k8s/base/kustomization.yaml";

export async function updateKustomization(
  input: UpdateKustomizationInput
): Promise<UpdateKustomizationResult> {
  const { repoOwner, repoName } = input;
  const entry = `envs/${repoOwner}-${repoName}/`;

  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  // Read current kustomization.yaml from the mesh-six repo
  const response = await octokit.repos.getContent({
    owner: MESH_SIX_REPO_OWNER,
    repo: MESH_SIX_REPO_NAME,
    path: KUSTOMIZATION_PATH,
  });

  const file = response.data;
  if (Array.isArray(file)) {
    throw new Error(`${KUSTOMIZATION_PATH} is a directory, not a file`);
  }

  if (!("content" in file) || !file.content) {
    throw new Error(`Could not read content of ${KUSTOMIZATION_PATH}`);
  }

  const content = Buffer.from(file.content, "base64").toString("utf-8");

  if (content.includes(entry)) {
    return { alreadyPresent: true };
  }

  // Insert the new entry before the `commonLabels:` line
  const updated = content.replace(
    /^commonLabels:/m,
    `  - ${entry}\n\ncommonLabels:`
  );

  const encodedContent = Buffer.from(updated).toString("base64");

  await octokit.repos.createOrUpdateFileContents({
    owner: MESH_SIX_REPO_OWNER,
    repo: MESH_SIX_REPO_NAME,
    path: KUSTOMIZATION_PATH,
    message: `chore: register env-${repoOwner}-${repoName} in base kustomization`,
    content: encodedContent,
    sha: file.sha,
  });

  return { alreadyPresent: false };
}
