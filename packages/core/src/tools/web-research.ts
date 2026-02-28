// ---------------------------------------------------------------------------
// Web Research Tool Schemas
//
// TODO: These tool schemas are scaffolded for future use with Gemini native
// tool calling / grounding. Currently the triage and review activities use
// prompt injection via chatCompletionWithSchema. Wire these into the LLM
// calls when switching to native tool-use mode.
// ---------------------------------------------------------------------------

export const webResearchTools = [
  {
    type: "function" as const,
    function: {
      name: "googleSearch",
      description: "Use Google Search for quick, real-time factual lookups and discovery.",
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_fetch",
      description: "Extract the full markdown text of a specific URL. Use this to read full documentation pages.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
];

/**
 * Build a system prompt segment that instructs the LLM about available
 * research capabilities.
 */
export function buildResearchSystemPrompt(): string {
  return `You have access to the following research tools:
- googleSearch: For real-time factual lookups via Google Search grounding.
- web_fetch(url): To read the full content of a documentation page.

Use these tools when you need current information that may not be in your training data.
Prefer official documentation over blog posts or Stack Overflow answers.`;
}
