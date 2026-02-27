import { Octokit } from "@octokit/rest";
import { GITHUB_TOKEN } from "../config.js";

export interface ValidateRepoInput {
  repoOwner: string;
  repoName: string;
}

export interface ValidateRepoOutput {
  repoNodeId: string;
  ownerNodeId: string;
  defaultBranch: string;
  fullName: string;
}

export async function validateRepo(input: ValidateRepoInput): Promise<ValidateRepoOutput> {
  const { repoOwner, repoName } = input;

  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  const { data: repo } = await octokit.repos.get({
    owner: repoOwner,
    repo: repoName,
  });

  const { data: owner } = await octokit.users.getByUsername({
    username: repoOwner,
  });

  return {
    repoNodeId: repo.node_id,
    ownerNodeId: owner.node_id,
    defaultBranch: repo.default_branch,
    fullName: repo.full_name,
  };
}
