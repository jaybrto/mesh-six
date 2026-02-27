import { graphql as graphqlLib } from "@octokit/graphql";
import { GITHUB_TOKEN } from "../config.js";

export interface CreateProjectBoardInput {
  repoOwner: string;
  repoName: string;
  ownerNodeId: string;
  repoNodeId: string;
  displayName?: string;
}

export interface CreateProjectBoardOutput {
  projectId: string;
  projectUrl: string;
  projectNumber: number;
  statusFieldId: string;
  sessionIdFieldId: string;
  podNameFieldId: string;
  workflowIdFieldId: string;
  priorityFieldId: string;
}

interface ProjectV2 {
  id: string;
  url: string;
  number: number;
}

interface FieldNode {
  id: string;
  name: string;
  __typename: string;
}

interface ProjectV2Field {
  id: string;
}

export async function createProjectBoard(
  input: CreateProjectBoardInput
): Promise<CreateProjectBoardOutput> {
  const { repoOwner, repoName, ownerNodeId, repoNodeId, displayName } = input;
  const title = displayName ?? `mesh-six: ${repoOwner}/${repoName}`;

  const graphql = graphqlLib.defaults({
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-Github-Next-Global-ID": "1",
    },
  });

  // Create the ProjectV2
  const createData = await graphql<{
    createProjectV2: { projectV2: ProjectV2 };
  }>(
    `mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id url number }
      }
    }`,
    { ownerId: ownerNodeId, title }
  );
  const project = createData.createProjectV2.projectV2;

  // Link project to repository
  await graphql(
    `mutation($projectId: ID!, $repositoryId: ID!) {
      linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
        repository { nameWithOwner }
      }
    }`,
    { projectId: project.id, repositoryId: repoNodeId }
  );

  // Query existing fields to get the Status field ID
  const fieldsData = await graphql<{
    node: {
      fields: {
        nodes: FieldNode[];
      };
    };
  }>(
    `query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes { id name __typename }
          }
        }
      }
    }`,
    { projectId: project.id }
  );

  const existingFields = fieldsData.node.fields.nodes;
  const statusField = existingFields.find((f) => f.name === "Status");
  if (!statusField) {
    throw new Error("Status field not found on newly created project");
  }

  // Create TEXT fields: Session ID, Pod Name, Workflow ID
  const textFields: { name: string; key: string }[] = [
    { name: "Session ID", key: "sessionIdFieldId" },
    { name: "Pod Name", key: "podNameFieldId" },
    { name: "Workflow ID", key: "workflowIdFieldId" },
  ];

  const createdFieldIds: Record<string, string> = {};

  for (const field of textFields) {
    const fieldData = await graphql<{
      createProjectV2Field: { projectV2Field: ProjectV2Field };
    }>(
      `mutation($projectId: ID!, $dataType: ProjectV2CustomFieldType!, $name: String!) {
        createProjectV2Field(input: { projectId: $projectId, dataType: $dataType, name: $name }) {
          projectV2Field {
            ... on ProjectV2Field { id }
          }
        }
      }`,
      { projectId: project.id, dataType: "TEXT", name: field.name }
    );
    createdFieldIds[field.key] = fieldData.createProjectV2Field.projectV2Field.id;
  }

  // Create SINGLE_SELECT Priority field
  const priorityData = await graphql<{
    createProjectV2Field: { projectV2Field: ProjectV2Field };
  }>(
    `mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
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
    }`,
    {
      projectId: project.id,
      name: "Priority",
      options: [
        { name: "Critical", color: "RED", description: "Must fix immediately" },
        { name: "High", color: "ORANGE", description: "Important feature or fix" },
        { name: "Medium", color: "YELLOW", description: "Normal priority" },
        { name: "Low", color: "GREEN", description: "Nice to have" },
      ],
    }
  );

  return {
    projectId: project.id,
    projectUrl: project.url,
    projectNumber: project.number,
    statusFieldId: statusField.id,
    sessionIdFieldId: createdFieldIds["sessionIdFieldId"]!,
    podNameFieldId: createdFieldIds["podNameFieldId"]!,
    workflowIdFieldId: createdFieldIds["workflowIdFieldId"]!,
    priorityFieldId: priorityData.createProjectV2Field.projectV2Field.id,
  };
}
