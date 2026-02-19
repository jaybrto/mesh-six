import type { CompressionRequest, CompressionRule } from "@mesh-six/core";

/** Default rules for known sender->receiver pairs */
const DEFAULT_RULES: CompressionRule[] = [
  {
    id: "pm-to-architect",
    sender: "project-manager",
    receiver: "architect-agent",
    stripFields: [
      "createdAt",
      "projectItemId",
      "workflowId",
      "planCycles",
      "qaCycles",
      "blockers",
      "contentNodeId",
      "detectedVia",
    ],
    preserveFields: [
      "issueNumber",
      "issueTitle",
      "repoOwner",
      "repoName",
      "phase",
    ],
    maxMemories: 4,
    maxConversationMessages: 2,
    tokenCeiling: 800,
  },
  {
    id: "pm-to-researcher",
    sender: "project-manager",
    receiver: "researcher-agent",
    stripFields: [
      "createdAt",
      "projectItemId",
      "workflowId",
      "planCycles",
      "qaCycles",
      "blockers",
      "contentNodeId",
      "detectedVia",
      "phase",
    ],
    preserveFields: [
      "issueNumber",
      "issueTitle",
      "repoOwner",
      "repoName",
    ],
    maxMemories: 3,
    maxConversationMessages: 0,
    tokenCeiling: 600,
  },
  // Catch-all: generic rule for unknown pairs
  {
    id: "generic",
    sender: "*",
    receiver: "*",
    stripFields: [
      "createdAt",
      "projectItemId",
      "workflowId",
      "contentNodeId",
      "detectedVia",
    ],
    preserveFields: [],
    maxMemories: 5,
    maxConversationMessages: 4,
    tokenCeiling: 1000,
  },
];

/**
 * Find the best matching rule for a sender/receiver pair.
 * Exact match > sender wildcard > receiver wildcard > generic.
 */
export function findRule(
  sender: string,
  receiver: string,
  customRules?: CompressionRule[]
): CompressionRule {
  const allRules = [...(customRules ?? []), ...DEFAULT_RULES];

  return (
    allRules.find((r) => r.sender === sender && r.receiver === receiver) ??
    allRules.find((r) => r.sender === sender && r.receiver === "*") ??
    allRules.find((r) => r.sender === "*" && r.receiver === receiver) ??
    allRules.find((r) => r.sender === "*" && r.receiver === "*")!
  );
}

/**
 * Apply deterministic compression rules to a request.
 * Returns the compressed text and whether it's under the token ceiling.
 */
export function applyRules(
  request: CompressionRequest,
  rule: CompressionRule
): { text: string; estimatedTokens: number; sufficient: boolean } {
  // 1. Strip fields from workflow state
  const filteredState = { ...request.workflowState };
  for (const field of rule.stripFields) {
    deleteNestedField(filteredState, field);
  }

  // 2. Truncate memories
  const memories = request.senderMemories.slice(0, rule.maxMemories);

  // 3. Truncate conversation
  const conversation = request.conversationSnippet.slice(
    -rule.maxConversationMessages
  );

  // 4. Build structured text output
  const sections: string[] = [];

  sections.push(`METADATA:`);
  sections.push(`  sender: ${request.sender}`);
  sections.push(`  receiver: ${request.receiver}`);
  sections.push(`  project: ${request.projectId}`);
  sections.push(`  task: ${request.taskSummary}`);
  sections.push(`  priority: ${request.priority}`);

  // Include non-empty filtered state
  const stateEntries = Object.entries(filteredState).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  );
  if (stateEntries.length > 0) {
    sections.push(`\nDOMAIN_CONTEXT:`);
    for (const [key, value] of stateEntries) {
      const valueStr = typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
      sections.push(`- ${key}: ${valueStr}`);
    }
  }

  if (request.constraints.length > 0) {
    sections.push(`\nCONSTRAINTS:`);
    for (const c of request.constraints) {
      sections.push(`- ${c}`);
    }
  }

  if (request.knownFailures.length > 0) {
    sections.push(`\nKNOWN_FAILURES:`);
    for (const f of request.knownFailures) {
      sections.push(`- ${f}`);
    }
  }

  if (memories.length > 0) {
    sections.push(`\nRELEVANT_MEMORIES:`);
    for (const m of memories) {
      sections.push(`- ${m}`);
    }
  }

  if (conversation.length > 0) {
    sections.push(`\nCONVERSATION_CONTEXT:`);
    for (const msg of conversation) {
      sections.push(`- [${msg.role}]: ${msg.content}`);
    }
  }

  if (request.senderQuestions.length > 0) {
    sections.push(`\nOPEN_QUESTIONS:`);
    request.senderQuestions.forEach((q, i) => {
      sections.push(`${i + 1}. ${q}`);
    });
  }

  const text = sections.join("\n");
  const estimatedTokens = Math.ceil(text.length / 4);

  return {
    text,
    estimatedTokens,
    sufficient: estimatedTokens <= rule.tokenCeiling,
  };
}

/** Delete a potentially nested field from an object using dot notation */
function deleteNestedField(obj: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  let current: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    current = current?.[parts[i]];
    if (!current || typeof current !== "object") return;
  }
  delete current?.[parts[parts.length - 1]];
}

export { DEFAULT_RULES, deleteNestedField };
