export interface ValidationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

/** Required sections in the compressed output */
const REQUIRED_SECTIONS = ["METADATA:", "DOMAIN_CONTEXT:"];
const OPTIONAL_SECTIONS = ["CONSTRAINTS:", "KNOWN_FAILURES:", "OPEN_QUESTIONS:"];

/** Required metadata fields */
const REQUIRED_METADATA = ["sender:", "receiver:", "project:", "task:"];

/**
 * Validate LLM compression output for format compliance and hallucinations.
 */
export function validateCompression(
  output: string,
  inputText: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Format compliance -- required sections
  for (const section of REQUIRED_SECTIONS) {
    if (!output.includes(section)) {
      errors.push(`Missing required section: ${section}`);
    }
  }

  // 2. Metadata fields
  for (const field of REQUIRED_METADATA) {
    if (!output.includes(field)) {
      errors.push(`Missing required metadata field: ${field}`);
    }
  }

  // 3. Hallucination detection -- extract proper nouns and technical terms
  //    from output and check they exist in input
  const outputTerms = extractTechnicalTerms(output);
  const inputLower = inputText.toLowerCase();

  for (const term of outputTerms) {
    if (!inputLower.includes(term.toLowerCase())) {
      errors.push(`Possible hallucination: "${term}" not found in input`);
    }
  }

  // 4. Length check -- output should be shorter than input
  if (output.length >= inputText.length) {
    warnings.push(
      `Output (${output.length} chars) is not shorter than input (${inputText.length} chars)`
    );
  }

  // 5. Check for leaked internal metadata (relevance scores, timestamps, IDs)
  const leakedPatterns = [
    /\(\d+\.\d{2}\)/,        // Relevance scores like (0.87)
    /\d{4}-\d{2}-\d{2}T/,   // ISO timestamps
    /PVTI_\w+/,              // GitHub project item IDs
    /tri-\d+-\d+/,           // Trace/request IDs
  ];

  for (const pattern of leakedPatterns) {
    if (pattern.test(output)) {
      warnings.push(`Leaked internal metadata matching pattern: ${pattern.source}`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Extract technical terms from text for hallucination checking.
 * Looks for:
 * - Library names (e.g., "@mesh-six/core", "XState")
 * - Version numbers (e.g., "v1.16.9", "3.8b")
 * - Capitalized technical words not in common English
 */
function extractTechnicalTerms(text: string): string[] {
  const terms = new Set<string>();

  // Library/package names: @scope/name patterns
  const packageMatches = text.match(/@[\w-]+\/[\w-]+/g);
  if (packageMatches) packageMatches.forEach((m) => terms.add(m));

  // Version numbers: v1.2.3, 1.16.9, etc.
  const versionMatches = text.match(/v?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?/g);
  if (versionMatches) versionMatches.forEach((m) => terms.add(m));

  // Capitalized technical words that aren't common English
  const COMMON_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must", "for", "and",
    "but", "or", "nor", "not", "no", "so", "yet", "both", "either",
    "neither", "each", "every", "all", "any", "few", "more", "most",
    "other", "some", "such", "than", "too", "very", "just", "about",
    "above", "after", "before", "below", "between", "during", "from",
    "into", "of", "on", "to", "with", "what", "which", "who", "whom",
    "this", "that", "these", "those", "how", "why", "when", "where",
    "new", "old", "key", "max", "min", "use", "set", "get",
    // Section header words (individual words and underscore-joined forms)
    "metadata", "domain", "context", "constraints", "known", "failures",
    "open", "questions", "sender", "receiver", "project", "task",
    "priority", "relevant", "memories", "hard", "constraint",
    // Composite section headers picked up by \b[A-Z][\w-]*\b
    "domain_context", "open_questions", "known_failures",
    "relevant_memories", "conversation_context", "conversation_history",
    "workflow", "state", "long-term",
    // Common technical action words
    "uses", "provides", "design", "add", "create", "update", "delete",
    "build", "deploy", "test", "run", "start", "stop", "check",
    "what", "should", "implement",
  ]);

  const wordMatches = text.match(/\b[A-Z][\w-]*\b/g);
  if (wordMatches) {
    for (const word of wordMatches) {
      if (word.length >= 3 && !COMMON_WORDS.has(word.toLowerCase())) {
        terms.add(word);
      }
    }
  }

  return [...terms];
}

export { extractTechnicalTerms, REQUIRED_SECTIONS, REQUIRED_METADATA, OPTIONAL_SECTIONS };
