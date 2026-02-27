/**
 * Web Research Tools Schema
 *
 * Defines tool schemas for research agents that need web access.
 * These are passed to LLM calls to enable grounded research via
 * Gemini native grounding or direct URL fetching.
 */

export interface WebResearchTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters?: {
      type: string;
      properties: Record<string, { type: string; description?: string }>;
      required?: string[];
    };
  };
}

/**
 * Tool definitions for web research capabilities.
 * These are used in LLM call payloads to enable grounded search.
 */
export const webResearchTools: WebResearchTool[] = [
  {
    type: "function",
    function: {
      name: "googleSearch",
      description:
        "Use Google Search for quick, real-time factual lookups and discovery. Returns search results with snippets.",
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Extract the full markdown text of a specific URL. Use this to read full documentation pages, API references, and technical guides.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch and convert to markdown",
          },
        },
        required: ["url"],
      },
    },
  },
];

/**
 * Build a system prompt that includes web research tool usage instructions.
 */
export function buildResearchSystemPrompt(basePrompt: string): string {
  return `${basePrompt}

You have access to web research tools:
- googleSearch: For discovering relevant pages and getting quick factual answers
- web_fetch: For reading full documentation pages when you have a specific URL

Use these tools when you need information not available in your training data or the provided context.
Prefer official documentation over blog posts or Stack Overflow answers.
Always cite your sources with URLs.`;
}
