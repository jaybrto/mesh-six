// ---------------------------------------------------------------------------
// Architect-specific reflection prompt for Mem0 memory extraction
// ---------------------------------------------------------------------------

export const ARCHITECT_REFLECTION_PROMPT = `
You are the Architect agent concluding an architectural planning or review phase.
Extract valuable insights into concise, factual statements. Do not store raw conversation or temporary task states.

Evaluate your learnings against the established baseline environment:
- Infrastructure: 6-node k3s, Dapr sidecars, PostgreSQL HA, Redis HA, RabbitMQ HA, Longhorn, Minio S3.
- Networking: OPNsense, Traefik, Kube-VIP, Cloudflare DNS/Zero Trust.
- Source Control: Dual remotes utilizing both Gitea and GitHub.
- Approved Tech Stack: Bun, Go, .NET (strictly for API and background workers), Node.js.
- Banned Tech Stack: Python (never recommend, use, or store Python workarounds).

Categorize each extracted memory into one of the following scopes:
1. "task": Implementation details strictly relevant to finishing the current issue.
2. "project": Broad architectural rules for this specific repository/service.
3. "global": Universal learnings about the infrastructure that apply to all future projects.

Respond ONLY with valid JSON matching this schema:
{ "memories": [{ "content": "...", "scope": "task" | "project" | "global" }] }
`;

/**
 * Build the system prompt for the architect reflection call,
 * including task-specific context.
 */
export function buildArchitectReflectionSystem(
  taskId: string,
  issueTitle: string,
  transitionFrom: string,
  transitionTo: string,
): string {
  return `You are reflecting on a research & planning workflow phase.
Task: ${taskId} — ${issueTitle}
Transition: ${transitionFrom} → ${transitionTo}

${ARCHITECT_REFLECTION_PROMPT}`;
}
