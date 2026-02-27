import { Octokit } from "@octokit/rest";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { GITHUB_TOKEN } from "../config.js";

export interface ScaffoldDevcontainerInput {
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
}

export interface ScaffoldDevcontainerResult {
  alreadyExisted: boolean;
  hasMeshSixTools: boolean;
}

export async function scaffoldDevcontainer(
  input: ScaffoldDevcontainerInput
): Promise<ScaffoldDevcontainerResult> {
  const { repoOwner, repoName, defaultBranch } = input;
  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  try {
    const response = await octokit.repos.getContent({
      owner: repoOwner,
      repo: repoName,
      path: ".devcontainer/devcontainer.json",
      ref: defaultBranch,
    });

    const file = response.data;
    if (Array.isArray(file)) {
      throw new Error(".devcontainer/devcontainer.json is a directory, not a file");
    }

    let content = "";
    if ("content" in file && file.content) {
      content = Buffer.from(file.content, "base64").toString("utf-8");
    }

    const hasMeshSixTools = content.includes("mesh-six-tools");
    return { alreadyExisted: true, hasMeshSixTools };
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "status" in err &&
      (err as { status: number }).status !== 404
    ) {
      throw err;
    }

    // File does not exist — read template and push it
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const templatePath = join(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "templates",
      "devcontainer",
      "devcontainer.json"
    );

    const templateContent = await Bun.file(templatePath).text();
    const encodedContent = Buffer.from(templateContent).toString("base64");

    await octokit.repos.createOrUpdateFileContents({
      owner: repoOwner,
      repo: repoName,
      path: ".devcontainer/devcontainer.json",
      message: "chore: add mesh-six devcontainer configuration",
      content: encodedContent,
      branch: defaultBranch,
    });

    return { alreadyExisted: false, hasMeshSixTools: true };
  }
}
