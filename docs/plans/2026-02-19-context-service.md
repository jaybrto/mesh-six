# Context Service — Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Context Service — a hybrid deterministic + LLM-powered context compression proxy that sits between agents as a Dapr Workflow activity. When the PM workflow delegates to a specialist agent (Architect, Researcher, etc.), the Context Service strips the accumulated workflow state down to only what the receiving agent needs.

**Architecture:** Two-stage compression pipeline. Stage 1: deterministic rule engine strips known-irrelevant fields per sender/receiver pair (instant, zero cost). Stage 2: if rules can't safely compress below a configurable token ceiling, Phi3.5 via LiteLLM produces a structured compression (5-7s, ~64 tok/s on RX 6800 XT). Output validation catches format violations and hallucinations before the compressed context reaches the receiver.

**Tech Stack:** Bun, Hono, Zod, Dapr (service invocation), LiteLLM/Ollama Phi3.5, pg (node-postgres), bun:test, Kustomize

**Key Benchmark Data (from prototyping session):**
- Phi3.5 serial latency: ~5.7s for 1000 prompt tokens -> ~330 completion tokens (~64 tok/s)
- 2 concurrent: ~7.7s each, 8.1s wall clock
- 3 concurrent: ~9.9s each, 10.7s wall
- OLLAMA_NUM_PARALLEL=4 configured on bto-mini (RX 6800 XT, 10.3GB of 16.4GB VRAM)
- Best prompt: v3.2 system prompt with METADATA/DOMAIN_CONTEXT/CONSTRAINTS/KNOWN_FAILURES/OPEN_QUESTIONS format
- Temperature 0.1, anti-hallucination rules, 300 token target output
- Deterministic rules expected to handle 60-80% of cases (instant), LLM fallback for remainder

---

## Execution Model: Claude Teams

This plan is designed for parallel execution using Claude Teams with 4 agents:

| Agent Name | Type | Responsibilities |
|------------|------|-----------------|
| `core-dev` | `core-lib` | Zod types, compression request/response schemas in core |
| `svc-dev` | `bun-service` | Context Service Hono microservice (rule engine + LLM compression + validation) |
| `wf-dev` | `workflow` | PM workflow `compressContextActivity` + integration |
| `test-dev` | `bun-test` | All tests: rule engine, LLM compression, validation, workflow integration |

### Dependency Graph

```
Phase 1 (parallel):  Task 1 (core types + schemas)
                     Task 2 (database migration)
                     Task 3 (k8s manifests)

Phase 2 (after T1):  Task 4 (rule engine)
                     Task 5 (LLM compression module)
                     Task 6 (output validation module)

Phase 3 (after T4-6): Task 7 (context-service Hono app)

Phase 4 (after T1):  Task 8 (compressContextActivity in PM workflow)

Phase 5 (after T7):  Task 9 (rule engine tests)      <- parallel
                     Task 10 (LLM compression tests)  <- parallel
                     Task 11 (validation tests)        <- parallel
                     Task 12 (service integration tests) <- parallel

Phase 6 (after T8):  Task 13 (workflow integration tests)

Phase 7 (after all): Task 14 (core index.ts exports)
                     Task 15 (update PLAN.md)
                     Task 16 (update CHANGELOG.md)
                     Task 17 (run all tests, commit)
```

### File Ownership Matrix

| File Path | Owner | Phase |
|-----------|-------|-------|
| `packages/core/src/compression.ts` | core-dev | 1 |
| `packages/core/src/index.ts` | core-dev | 7 |
| `migrations/004_context_compression_log.sql` | svc-dev | 1 |
| `apps/context-service/src/rules.ts` | svc-dev | 2 |
| `apps/context-service/src/llm.ts` | svc-dev | 2 |
| `apps/context-service/src/validation.ts` | svc-dev | 2 |
| `apps/context-service/src/index.ts` | svc-dev | 3 |
| `apps/context-service/package.json` | svc-dev | 3 |
| `apps/context-service/tsconfig.json` | svc-dev | 3 |
| `apps/project-manager/src/workflow.ts` | wf-dev | 4 |
| `k8s/base/context-service/` | svc-dev | 1 |
| `packages/core/src/__tests__/compression.test.ts` | test-dev | 5 |
| `apps/context-service/src/__tests__/rules.test.ts` | test-dev | 5 |
| `apps/context-service/src/__tests__/llm.test.ts` | test-dev | 5 |
| `apps/context-service/src/__tests__/validation.test.ts` | test-dev | 5 |

---

## Task 1: Core Types and Schemas

**Owner:** `core-dev`
**Blocked by:** nothing

**Files:**
- Create: `packages/core/src/compression.ts`

**Step 1: Define the compression request/response Zod schemas**

These types are the contract between the PM workflow and the Context Service.

```typescript
// packages/core/src/compression.ts

import { z } from "zod";

// --- Compression Request ---

/**
 * Sender context payload sent to the Context Service for compression.
 * The PM workflow assembles this from its accumulated Dapr workflow state
 * before delegating to a specialist agent.
 */
export const CompressionRequestSchema = z.object({
  /** Dapr app-id of the sending agent */
  sender: z.string(),
  /** Dapr app-id of the receiving agent */
  receiver: z.string(),
  /** Project identifier (repo or workflow ID) */
  projectId: z.string(),
  /** One-line task description for the receiver */
  taskSummary: z.string(),
  /** Priority 0-10 */
  priority: z.number().min(0).max(10).default(5),
  /** Full workflow state accumulated by the sender (the "large context") */
  workflowState: z.record(z.string(), z.unknown()),
  /** Sender's long-term memories relevant to this delegation */
  senderMemories: z.array(z.string()).default([]),
  /** Specific questions the sender wants the receiver to answer */
  senderQuestions: z.array(z.string()).default([]),
  /** Optional: conversation history snippet for additional context */
  conversationSnippet: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).default([]),
  /** Optional: hard constraints the receiver must respect */
  constraints: z.array(z.string()).default([]),
  /** Optional: known failures relevant to the task */
  knownFailures: z.array(z.string()).default([]),
});

export type CompressionRequest = z.infer<typeof CompressionRequestSchema>;

// --- Compression Response ---

export const CompressionResponseSchema = z.object({
  /** Whether compression succeeded */
  success: z.boolean(),
  /** The compressed context string for the receiver */
  compressedContext: z.string(),
  /** Which compression method was used */
  method: z.enum(["deterministic", "llm", "passthrough"]),
  /** Compression stats */
  stats: z.object({
    inputTokensEstimate: z.number(),
    outputTokensEstimate: z.number(),
    compressionRatio: z.number(),
    durationMs: z.number(),
  }),
  /** If LLM was used, whether validation passed */
  validationPassed: z.boolean().optional(),
  /** If compression failed, the error */
  error: z.string().optional(),
});

export type CompressionResponse = z.infer<typeof CompressionResponseSchema>;

// --- Compression Rule ---

/**
 * A deterministic compression rule that strips/transforms fields
 * based on the sender/receiver pair.
 */
export const CompressionRuleSchema = z.object({
  /** Unique rule ID */
  id: z.string(),
  /** Which sender(s) this rule applies to ("*" for all) */
  sender: z.string(),
  /** Which receiver(s) this rule applies to ("*" for all) */
  receiver: z.string(),
  /** Fields to strip from workflowState (dot-notation paths) */
  stripFields: z.array(z.string()).default([]),
  /** Fields to always preserve (overrides stripFields) */
  preserveFields: z.array(z.string()).default([]),
  /** Max number of sender memories to include */
  maxMemories: z.number().default(5),
  /** Max conversation snippet length */
  maxConversationMessages: z.number().default(4),
  /** Token ceiling below which deterministic output is considered sufficient */
  tokenCeiling: z.number().default(800),
});

export type CompressionRule = z.infer<typeof CompressionRuleSchema>;
```

**Acceptance criteria:**
- [ ] Schemas parse valid payloads without error
- [ ] Invalid payloads (missing required fields, bad enums) are rejected
- [ ] Types exported from the module

---

## Task 2: Database Migration

**Owner:** `svc-dev`
**Blocked by:** nothing

**Files:**
- Create: `migrations/004_context_compression_log.sql`

**Step 1: Write the migration**

This table logs compression operations for observability and future adaptive behavior (Phase 2+). It is not in the critical path for Phase 1 — the Context Service works without it. But having the schema in place now means we can add logging as a non-blocking background write.

```sql
-- migrations/004_context_compression_log.sql
-- Context compression operation log for observability and future adaptive behavior

CREATE TABLE IF NOT EXISTS context_compression_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Routing
  sender          TEXT NOT NULL,
  receiver        TEXT NOT NULL,
  project_id      TEXT,

  -- Compression method and stats
  method          TEXT NOT NULL,  -- 'deterministic', 'llm', 'passthrough'
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  compression_ratio REAL NOT NULL,
  duration_ms     INTEGER NOT NULL,

  -- Validation
  validation_passed BOOLEAN,
  validation_errors JSONB DEFAULT '[]',

  -- LLM details (null for deterministic)
  llm_model       TEXT,
  llm_prompt_version TEXT,

  -- Full payloads (optional, for debugging — normally null)
  input_payload   JSONB,
  output_payload  JSONB
);

CREATE INDEX idx_compression_log_sender_receiver
  ON context_compression_log (sender, receiver, timestamp DESC);

CREATE INDEX idx_compression_log_method
  ON context_compression_log (method, timestamp DESC);

CREATE INDEX idx_compression_log_failed
  ON context_compression_log (validation_passed, timestamp DESC)
  WHERE validation_passed = false;
```

**Acceptance criteria:**
- [ ] Migration applies cleanly on a fresh database
- [ ] Migration applies cleanly on the existing mesh_six database (no conflicts with 001-003)
- [ ] Indexes exist for the expected query patterns

---

## Task 3: Kubernetes Manifests

**Owner:** `svc-dev`
**Blocked by:** nothing

**Files:**
- Create: `k8s/base/context-service/deployment.yaml`
- Create: `k8s/base/context-service/service.yaml`
- Edit: `k8s/base/kustomization.yaml` (add context-service to resources)

**Step 1: Deployment manifest**

```yaml
# k8s/base/context-service/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: context-service
  namespace: mesh-six
spec:
  replicas: 1
  selector:
    matchLabels:
      app: context-service
  template:
    metadata:
      labels:
        app: context-service
      annotations:
        dapr.io/enabled: "true"
        dapr.io/app-id: "context-service"
        dapr.io/app-port: "3000"
        dapr.io/log-level: "info"
        dapr.io/enable-metrics: "true"
        dapr.io/metrics-port: "9090"
    spec:
      containers:
        - name: context-service
          image: registry.bto.bar/jaybrto/mesh-six-context-service:latest
          ports:
            - containerPort: 3000
          env:
            - name: AGENT_ID
              value: "context-service"
            - name: LITELLM_BASE_URL
              value: "http://litellm.litellm:4000/v1"
            - name: LITELLM_API_KEY
              valueFrom:
                secretKeyRef:
                  name: litellm-secret
                  key: api-key
            - name: LITELLM_COMPRESSION_MODEL
              value: "ollama-phi3.5"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: mesh-six-db-secret
                  key: url
          readinessProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 3
            periodSeconds: 10
          resources:
            requests:
              memory: "64Mi"
              cpu: "50m"
            limits:
              memory: "128Mi"
              cpu: "200m"
```

**Step 2: Service manifest**

```yaml
# k8s/base/context-service/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: context-service
  namespace: mesh-six
spec:
  selector:
    app: context-service
  ports:
    - port: 3000
      targetPort: 3000
  type: ClusterIP
```

**Step 3: Add to kustomization.yaml**

Add `context-service` to the resources list in `k8s/base/kustomization.yaml`.

**Acceptance criteria:**
- [ ] `kubectl apply --dry-run=client -f k8s/base/context-service/` passes
- [ ] Dapr annotations are correct (app-id, app-port, metrics)
- [ ] Resource limits are conservative (this service is lightweight)
- [ ] kustomization.yaml includes context-service

---

## Task 4: Deterministic Rule Engine

**Owner:** `svc-dev`
**Blocked by:** Task 1 (needs types)

**Files:**
- Create: `apps/context-service/src/rules.ts`

**Step 1: Implement the rule engine**

The rule engine applies per-sender/per-receiver rules to strip known-irrelevant fields from the workflow state and format the remainder into a structured text block. If the result is under the token ceiling, no LLM call is needed.

```typescript
// apps/context-service/src/rules.ts

import type { CompressionRequest, CompressionRule } from "@mesh-six/core";

/** Default rules for known sender→receiver pairs */
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

  // Priority: exact > sender-specific > receiver-specific > generic
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
```

**Acceptance criteria:**
- [ ] `findRule("project-manager", "architect-agent")` returns the pm-to-architect rule
- [ ] `findRule("unknown", "unknown")` returns the generic catch-all rule
- [ ] Custom rules take priority over defaults
- [ ] `applyRules` strips the specified fields and preserves the rest
- [ ] Output follows the METADATA/DOMAIN_CONTEXT/CONSTRAINTS/KNOWN_FAILURES/OPEN_QUESTIONS format
- [ ] `sufficient` is true when output is under `tokenCeiling`, false otherwise

---

## Task 5: LLM Compression Module

**Owner:** `svc-dev`
**Blocked by:** Task 1 (needs types)

**Files:**
- Create: `apps/context-service/src/llm.ts`

**Step 1: Implement LLM compression via Phi3.5**

This module is the fallback when deterministic rules can't compress below the token ceiling. It sends the (already rule-stripped) context to Phi3.5 with the validated v3.2 prompt format.

```typescript
// apps/context-service/src/llm.ts

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { CompressionRequest } from "@mesh-six/core";

const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "sk-local";
const COMPRESSION_MODEL = process.env.LITELLM_COMPRESSION_MODEL || "ollama-phi3.5";
const COMPRESSION_TEMPERATURE = 0.1;
const COMPRESSION_MAX_TOKENS = 500;

const llm = createOpenAI({
  baseURL: LITELLM_BASE_URL,
  apiKey: LITELLM_API_KEY,
});

/**
 * System prompt for Phi3.5 context compression.
 * Validated during prototyping session — v3.2 format with anti-hallucination rules.
 */
const COMPRESSION_SYSTEM_PROMPT = `You are a context compression service for a multi-agent system. Compress sender context for the receiving agent.

OUTPUT FORMAT (use exactly this structure):

METADATA:
  sender: ...
  receiver: ...
  project: ...
  task: <one line>
  priority: ...

DOMAIN_CONTEXT:
- <key technical facts the receiver needs to do their job - max 12 words each>

CONSTRAINTS:
- <hard constraint - max 8 words>

KNOWN_FAILURES:
- <what failed and why - max 12 words>

OPEN_QUESTIONS:
1. <question from sender - preserve original wording>

RULES:
- CONCISE. Hard word limits per bullet. No prose paragraphs.
- ONLY extract from input. NEVER invent names, tools, libraries, or facts not explicitly stated.
- STRIP: internal IDs, timestamps, relevance scores, conversation history, sender reasoning, system prompts, workflow tracking fields.
- PRESERVE exactly: library names, version numbers, state names, error descriptions.
- Target: under 300 tokens total.`;

/**
 * Compress context using Phi3.5 via LiteLLM.
 * Takes the full CompressionRequest and produces compressed text.
 */
export async function compressWithLLM(
  request: CompressionRequest,
  /** Pre-formatted rule engine output to compress further, or raw request if rules didn't run */
  preformatted?: string
): Promise<{ text: string; durationMs: number }> {
  const startTime = Date.now();

  // Build the user message from the request
  const userMessage = preformatted ?? formatRequestForLLM(request);

  const { text } = await generateText({
    model: llm(COMPRESSION_MODEL),
    system: COMPRESSION_SYSTEM_PROMPT,
    prompt: userMessage,
    temperature: COMPRESSION_TEMPERATURE,
    maxTokens: COMPRESSION_MAX_TOKENS,
  });

  return {
    text: text.trim(),
    durationMs: Date.now() - startTime,
  };
}

/**
 * Format a CompressionRequest as a user message for the LLM.
 * Includes all fields the LLM needs to compress.
 */
function formatRequestForLLM(request: CompressionRequest): string {
  const parts: string[] = [];

  parts.push(`Sender: ${request.sender}`);
  parts.push(`Receiver: ${request.receiver}`);
  parts.push(`Project: ${request.projectId}`);
  parts.push(`Task: ${request.taskSummary}`);
  parts.push(`Priority: ${request.priority}`);
  parts.push(``);
  parts.push(`--- SENDER CONTEXT ---`);
  parts.push(``);
  parts.push(`WORKFLOW STATE:`);
  parts.push(JSON.stringify(request.workflowState, null, 2));

  if (request.senderMemories.length > 0) {
    parts.push(``);
    parts.push(`SENDER'S LONG-TERM MEMORIES:`);
    for (const m of request.senderMemories) {
      parts.push(`- ${m}`);
    }
  }

  if (request.senderQuestions.length > 0) {
    parts.push(``);
    parts.push(`SENDER'S QUESTIONS:`);
    request.senderQuestions.forEach((q, i) => {
      parts.push(`${i + 1}. ${q}`);
    });
  }

  if (request.constraints.length > 0) {
    parts.push(``);
    parts.push(`HARD CONSTRAINTS:`);
    for (const c of request.constraints) {
      parts.push(`- ${c}`);
    }
  }

  if (request.knownFailures.length > 0) {
    parts.push(``);
    parts.push(`KNOWN FAILURES:`);
    for (const f of request.knownFailures) {
      parts.push(`- ${f}`);
    }
  }

  if (request.conversationSnippet.length > 0) {
    parts.push(``);
    parts.push(`CONVERSATION HISTORY:`);
    for (const msg of request.conversationSnippet) {
      parts.push(`[${msg.role}]: ${msg.content}`);
    }
  }

  return parts.join("\n");
}

export { COMPRESSION_SYSTEM_PROMPT, formatRequestForLLM };
```

**Acceptance criteria:**
- [ ] `compressWithLLM` returns a non-empty text and valid durationMs
- [ ] System prompt matches v3.2 format validated during prototyping
- [ ] Temperature is 0.1
- [ ] `formatRequestForLLM` includes all relevant fields from the request
- [ ] Sender memories do not include relevance scores

---

## Task 6: Output Validation Module

**Owner:** `svc-dev`
**Blocked by:** Task 1 (needs types)

**Files:**
- Create: `apps/context-service/src/validation.ts`

**Step 1: Implement output validation**

Validates LLM compression output for:
1. **Format compliance** — required sections present (METADATA, DOMAIN_CONTEXT, OPEN_QUESTIONS)
2. **Hallucination detection** — output vocabulary should be a subset of input vocabulary (no invented names)
3. **Length check** — output should be shorter than input

```typescript
// apps/context-service/src/validation.ts

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

  // 1. Format compliance — required sections
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

  // 3. Hallucination detection — extract proper nouns and technical terms
  //    from output and check they exist in input
  const outputTerms = extractTechnicalTerms(output);
  const inputLower = inputText.toLowerCase();

  for (const term of outputTerms) {
    if (!inputLower.includes(term.toLowerCase())) {
      errors.push(`Possible hallucination: "${term}" not found in input`);
    }
  }

  // 4. Length check — output should be shorter than input
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
 * - Capitalized multi-word terms (e.g., "Dapr Workflow")
 * - Library names (e.g., "@mesh-six/core", "XState")
 * - Version numbers (e.g., "v1.16.9", "3.8b")
 * - Hyphenated technical terms (e.g., "api-coder", "pub-sub")
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
  // (filter out section headers and common words)
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
    // Section header words
    "metadata", "domain", "context", "constraints", "known", "failures",
    "open", "questions", "sender", "receiver", "project", "task",
    "priority", "relevant", "memories", "hard", "constraint",
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

export { extractTechnicalTerms };
```

**Acceptance criteria:**
- [ ] Missing METADATA section is flagged as error
- [ ] Missing DOMAIN_CONTEXT section is flagged as error
- [ ] Invented library names not in input are flagged as hallucinations
- [ ] Leaked relevance scores (0.87) are flagged as warnings
- [ ] Leaked ISO timestamps are flagged as warnings
- [ ] Output longer than input is flagged as warning (not error)
- [ ] Known valid terms from input are not false-flagged

---

## Task 7: Context Service Hono Application

**Owner:** `svc-dev`
**Blocked by:** Tasks 4, 5, 6

**Files:**
- Create: `apps/context-service/src/index.ts`
- Create: `apps/context-service/package.json`
- Create: `apps/context-service/tsconfig.json`

**Step 1: Package configuration**

```json
{
  "name": "@mesh-six/context-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "build": "bun build src/index.ts --target=bun --outdir=dist",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@mesh-six/core": "workspace:*",
    "hono": "^4.0.0",
    "ai": "^4.0.0",
    "@ai-sdk/openai": "^1.0.0",
    "pg": "^8.13.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/pg": "^8.11.0",
    "typescript": "^5.7.0"
  }
}
```

**Step 2: Main application**

```typescript
// apps/context-service/src/index.ts

import { Hono } from "hono";
import { CompressionRequestSchema, type CompressionResponse } from "@mesh-six/core";
import { findRule, applyRules } from "./rules.js";
import { compressWithLLM, formatRequestForLLM } from "./llm.js";
import { validateCompression } from "./validation.js";

const AGENT_ID = process.env.AGENT_ID || "context-service";
const APP_PORT = process.env.APP_PORT || "3000";

const app = new Hono();

// Health endpoints
app.get("/healthz", (c) => c.json({ status: "ok", agent: AGENT_ID }));
app.get("/readyz", (c) => c.json({ status: "ready", agent: AGENT_ID }));

/**
 * POST /compress
 *
 * Main compression endpoint. Called by the PM workflow via Dapr service invocation.
 *
 * Pipeline:
 * 1. Validate request
 * 2. Apply deterministic rules
 * 3. If rules produced output under token ceiling -> return
 * 4. Otherwise, send to Phi3.5 for LLM compression
 * 5. Validate LLM output
 * 6. If validation fails, return rule engine output as fallback
 */
app.post("/compress", async (c) => {
  const startTime = Date.now();

  // 1. Parse and validate request
  const body = await c.req.json();
  const parseResult = CompressionRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      {
        success: false,
        compressedContext: "",
        method: "passthrough",
        stats: { inputTokensEstimate: 0, outputTokensEstimate: 0, compressionRatio: 1, durationMs: 0 },
        error: `Invalid request: ${parseResult.error.message}`,
      } satisfies CompressionResponse,
      400
    );
  }

  const request = parseResult.data;
  const inputText = JSON.stringify(request);
  const inputTokens = Math.ceil(inputText.length / 4);

  // 2. Find matching rule and apply deterministic compression
  const rule = findRule(request.sender, request.receiver);
  const ruleResult = applyRules(request, rule);

  // 3. If deterministic compression is sufficient, return it
  if (ruleResult.sufficient) {
    const durationMs = Date.now() - startTime;
    const response: CompressionResponse = {
      success: true,
      compressedContext: ruleResult.text,
      method: "deterministic",
      stats: {
        inputTokensEstimate: inputTokens,
        outputTokensEstimate: ruleResult.estimatedTokens,
        compressionRatio: ruleResult.estimatedTokens / inputTokens,
        durationMs,
      },
    };
    return c.json(response);
  }

  // 4. Deterministic output too large — fall through to LLM
  try {
    const llmInput = formatRequestForLLM(request);
    const llmResult = await compressWithLLM(request, llmInput);

    // 5. Validate LLM output
    const validation = validateCompression(llmResult.text, llmInput);
    const outputTokens = Math.ceil(llmResult.text.length / 4);

    if (validation.passed) {
      const response: CompressionResponse = {
        success: true,
        compressedContext: llmResult.text,
        method: "llm",
        stats: {
          inputTokensEstimate: inputTokens,
          outputTokensEstimate: outputTokens,
          compressionRatio: outputTokens / inputTokens,
          durationMs: Date.now() - startTime,
        },
        validationPassed: true,
      };
      return c.json(response);
    }

    // 6. LLM output failed validation — fall back to rule engine output
    console.warn(
      `[${AGENT_ID}] LLM compression failed validation: ${validation.errors.join(", ")}. ` +
      `Falling back to deterministic output.`
    );

    const response: CompressionResponse = {
      success: true,
      compressedContext: ruleResult.text,
      method: "deterministic",
      stats: {
        inputTokensEstimate: inputTokens,
        outputTokensEstimate: ruleResult.estimatedTokens,
        compressionRatio: ruleResult.estimatedTokens / inputTokens,
        durationMs: Date.now() - startTime,
      },
      validationPassed: false,
    };
    return c.json(response);
  } catch (error) {
    // LLM call failed entirely — fall back to rule engine output
    console.error(`[${AGENT_ID}] LLM compression error: ${error}. Falling back to deterministic output.`);

    const response: CompressionResponse = {
      success: true,
      compressedContext: ruleResult.text,
      method: "deterministic",
      stats: {
        inputTokensEstimate: inputTokens,
        outputTokensEstimate: ruleResult.estimatedTokens,
        compressionRatio: ruleResult.estimatedTokens / inputTokens,
        durationMs: Date.now() - startTime,
      },
      error: `LLM fallback failed: ${String(error)}`,
    };
    return c.json(response);
  }
});

// Start server
Bun.serve({ port: Number(APP_PORT), fetch: app.fetch });
console.log(`[${AGENT_ID}] Listening on port ${APP_PORT}`);
```

**Acceptance criteria:**
- [ ] `POST /compress` with valid payload returns compressed context
- [ ] Deterministic-only compression returns `method: "deterministic"` and completes in <10ms
- [ ] LLM fallback fires when deterministic output exceeds token ceiling
- [ ] LLM validation failure falls back to deterministic output (not a 500 error)
- [ ] LLM call failure falls back to deterministic output (not a 500 error)
- [ ] Invalid request body returns 400 with error details
- [ ] `/healthz` and `/readyz` return 200
- [ ] No agent registry self-registration (this is an infrastructure service, not a task-processing agent)

---

## Task 8: PM Workflow — `compressContextActivity`

**Owner:** `wf-dev`
**Blocked by:** Task 1 (needs types)

**Files:**
- Edit: `apps/project-manager/src/workflow.ts`

**Step 1: Add the `compressContextActivity`**

Add a new workflow activity that calls the Context Service via Dapr service invocation before delegating to a specialist agent.

```typescript
// Add to apps/project-manager/src/workflow.ts

// --- New types for compression activity ---

interface CompressContextInput {
  sender: string;
  receiver: string;
  projectId: string;
  taskSummary: string;
  priority: number;
  workflowState: Record<string, unknown>;
  senderMemories: string[];
  senderQuestions: string[];
  constraints?: string[];
  knownFailures?: string[];
  conversationSnippet?: Array<{ role: string; content: string }>;
}

interface CompressContextOutput {
  compressedContext: string;
  method: string;
  compressionRatio: number;
  durationMs: number;
  fallback: boolean;
}

// --- New activity ---

const compressContextActivity = async (
  ctx: WorkflowActivityContext,
  input: CompressContextInput
): Promise<CompressContextOutput> => {
  try {
    const daprClient = new DaprClient({
      daprHost: DAPR_HOST,
      daprPort: DAPR_HTTP_PORT,
    });

    const response = await daprClient.invoker.invoke(
      "context-service",
      "compress",
      "post",
      input
    );

    const result = typeof response === "string" ? JSON.parse(response) : response;

    return {
      compressedContext: result.compressedContext ?? "",
      method: result.method ?? "passthrough",
      compressionRatio: result.stats?.compressionRatio ?? 1,
      durationMs: result.stats?.durationMs ?? 0,
      fallback: false,
    };
  } catch (error) {
    console.warn(
      `[Workflow] Context compression failed, passing raw context: ${error}`
    );
    // Graceful degradation: if Context Service is down, build a minimal
    // context string from the input directly
    const fallbackContext = [
      `Task: ${input.taskSummary}`,
      `Priority: ${input.priority}`,
      `Project: ${input.projectId}`,
      ...(input.senderQuestions.length > 0
        ? ["", "Questions:", ...input.senderQuestions.map((q, i) => `${i + 1}. ${q}`)]
        : []),
    ].join("\n");

    return {
      compressedContext: fallbackContext,
      method: "passthrough",
      compressionRatio: 1,
      durationMs: 0,
      fallback: true,
    };
  }
};
```

**Step 2: Wire compression before architect consultation in the INTAKE phase**

Replace the current direct architect call with a compress-then-consult pattern:

```typescript
// In the INTAKE section of projectBoardWorkflow, replace:
//
//   const architectResult: ConsultArchitectOutput = yield ctx.callActivity(
//     consultArchitectActivity,
//     {
//       question: `New project request: issue #${issueNumber} ...`,
//     }
//   );
//
// With:

  // 1a. Compress context for architect
  const architectContext: CompressContextOutput = yield ctx.callActivity(
    compressContextActivity,
    {
      sender: "project-manager",
      receiver: "architect-agent",
      projectId: `${repoOwner}/${repoName}`,
      taskSummary: `Decide technical approach for issue #${issueNumber}: ${issueTitle}`,
      priority: 5,
      workflowState: {
        phase: "INTAKE",
        issueNumber,
        issueTitle,
        repoOwner,
        repoName,
        projectItemId,
      },
      senderMemories: [],  // TODO: retrieve PM's Mem0 memories here
      senderQuestions: [
        "What technical approach do you recommend?",
        "What are the acceptance criteria?",
        "Any integration concerns with existing services?",
      ],
      constraints: [],
      knownFailures: [],
    }
  );

  // 1b. Consult architect with compressed context
  const architectResult: ConsultArchitectOutput = yield ctx.callActivity(
    consultArchitectActivity,
    {
      question: architectContext.compressedContext,
    }
  );
```

**Step 3: Register the activity with the workflow runtime**

Add `compressContextActivity` to the workflow runtime registration alongside the existing activities.

**Acceptance criteria:**
- [ ] `compressContextActivity` is registered in the workflow runtime
- [ ] INTAKE phase calls compress before consult
- [ ] If Context Service is unreachable, the workflow still proceeds (fallback context)
- [ ] `compressedContext` from the activity is passed as the question to `consultArchitectActivity`
- [ ] The existing workflow behavior is preserved for all other phases
- [ ] No breaking changes to the workflow's external interface

---

## Task 9: Rule Engine Tests

**Owner:** `test-dev`
**Blocked by:** Task 4

**Files:**
- Create: `apps/context-service/src/__tests__/rules.test.ts`

**Tests to write:**
1. `findRule` exact match for pm-to-architect
2. `findRule` exact match for pm-to-researcher
3. `findRule` generic fallback for unknown pair
4. `findRule` custom rules take priority
5. `applyRules` strips specified fields from workflow state
6. `applyRules` preserves specified fields
7. `applyRules` truncates memories to maxMemories
8. `applyRules` truncates conversation to maxConversationMessages
9. `applyRules` sufficient=true when under token ceiling
10. `applyRules` sufficient=false when over token ceiling
11. `applyRules` output contains all required sections
12. `applyRules` handles empty optional arrays (no CONSTRAINTS section if empty)
13. `deleteNestedField` handles dot-notation paths

---

## Task 10: LLM Compression Tests

**Owner:** `test-dev`
**Blocked by:** Task 5

**Files:**
- Create: `apps/context-service/src/__tests__/llm.test.ts`

**Tests to write:**
1. `formatRequestForLLM` includes all request fields
2. `formatRequestForLLM` omits empty optional sections
3. `formatRequestForLLM` does not include relevance scores
4. `COMPRESSION_SYSTEM_PROMPT` contains anti-hallucination rules
5. `COMPRESSION_SYSTEM_PROMPT` targets under 300 tokens

Note: Actual LLM call tests require a running LiteLLM/Ollama instance and should be marked as integration tests (skipped in CI, run manually).

---

## Task 11: Validation Tests

**Owner:** `test-dev`
**Blocked by:** Task 6

**Files:**
- Create: `apps/context-service/src/__tests__/validation.test.ts`

**Tests to write:**
1. Valid output passes validation
2. Missing METADATA section fails validation
3. Missing DOMAIN_CONTEXT section fails validation
4. Invented library name flagged as hallucination
5. Known library name from input NOT flagged
6. Relevance scores (0.87) flagged as leaked metadata
7. ISO timestamps flagged as leaked metadata
8. GitHub project item IDs (PVTI_) flagged as leaked metadata
9. Output longer than input generates warning (not error)
10. `extractTechnicalTerms` finds @scope/package names
11. `extractTechnicalTerms` finds version numbers
12. `extractTechnicalTerms` ignores common English words

---

## Task 12: Service Integration Tests

**Owner:** `test-dev`
**Blocked by:** Task 7

**Files:**
- Create: `apps/context-service/src/__tests__/service.test.ts`

**Tests to write (mock LLM calls):**
1. `POST /compress` with valid request returns 200
2. `POST /compress` with invalid request returns 400
3. Deterministic-sufficient request returns `method: "deterministic"`
4. Over-ceiling request triggers LLM fallback
5. LLM validation failure falls back to deterministic
6. LLM call exception falls back to deterministic
7. `/healthz` returns 200
8. `/readyz` returns 200
9. Compression ratio is calculated correctly

---

## Task 13: Workflow Integration Tests

**Owner:** `test-dev`
**Blocked by:** Task 8

**Files:**
- Create: `apps/project-manager/src/__tests__/compress-activity.test.ts`

**Tests to write (mock Dapr invocation):**
1. `compressContextActivity` calls context-service via Dapr invocation
2. `compressContextActivity` returns compressed context on success
3. `compressContextActivity` returns fallback context when service is unreachable
4. Fallback context includes task summary and questions
5. INTAKE phase passes compressed context to architect consultation

---

## Task 14: Core Library Exports

**Owner:** `core-dev`
**Blocked by:** Task 1

**Files:**
- Edit: `packages/core/src/index.ts`

Add the compression types to the core library exports:

```typescript
// Add to packages/core/src/index.ts

// Context compression
export {
  CompressionRequestSchema,
  CompressionResponseSchema,
  CompressionRuleSchema,
  type CompressionRequest,
  type CompressionResponse,
  type CompressionRule,
} from "./compression.js";
```

**Acceptance criteria:**
- [ ] `import { CompressionRequestSchema } from "@mesh-six/core"` works
- [ ] All three schemas and their types are exported

---

## Task 15: Update PLAN.md

**Owner:** `core-dev`
**Blocked by:** All other tasks

**Changes to `docs/PLAN.md`:**

1. **Add Context Service to Agent Roster table** (after Event Logger row):
   ```
   | Context Service | `context-service` | Infrastructure | Service invocation (called by PM workflow) | 6 |
   ```

2. **Add Milestone 6 section** after Milestone 5, before Event Log. Contents:
   - Goal, deliverables, value statement
   - Phase 1 scope: deterministic rules + LLM fallback + output validation + PM workflow integration
   - Phase 2 preview: compression logging, reflection on what worked, adaptive behavior
   - Acceptance criteria checklist

3. **Update Table of Contents** to include Milestone 6

4. **Update Context Window Management section** in Cross-Cutting Concerns:
   - Add paragraph explaining the Context Service's role in horizontal context transfer
   - Clarify that `buildAgentContext()` handles vertical assembly (system prompt + task + memories) while Context Service handles horizontal transfer (sender → receiver compression)

5. **Update Repository Structure** to include `apps/context-service/`

6. **Update "How to Use This Document"** session recommendations to include M6

---

## Task 16: Update CHANGELOG.md

**Owner:** `core-dev`
**Blocked by:** All other tasks

Add entries for:
- `@mesh-six/core` — new compression types
- `@mesh-six/context-service@0.1.0` — new service
- `@mesh-six/project-manager` — workflow compression integration

---

## Task 17: Final Verification

**Owner:** `test-dev`
**Blocked by:** All other tasks

1. Run `bun run typecheck` across workspace
2. Run `bun run test` across workspace
3. Verify `bun run build` succeeds for context-service
4. Verify no circular dependencies between packages

---

## Design Decisions Reference

These decisions were made during the prototyping session and should not be revisited without strong justification:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Compression model | Phi3.5 (3.8B, q5_K_M) via LiteLLM | Already deployed on bto-mini, ~64 tok/s, good compression quality at temp 0.1 |
| Temperature | 0.1 | Higher temps (0.3) caused hallucinations ("simplex library") |
| Output format | METADATA/DOMAIN_CONTEXT/CONSTRAINTS/KNOWN_FAILURES/OPEN_QUESTIONS | v3.2 prompt validated through 6 iterations of prototyping |
| Deterministic first | Rule engine before LLM | Instant for 60-80% of cases, saves GPU for genuinely complex payloads |
| Workflow activity | Dapr Workflow activity, not inline PM call | PM stays responsive, independent failure domain, free retry/audit via workflow state |
| Graceful degradation | Fall through deterministic -> LLM -> rule fallback -> raw passthrough | Service never blocks the workflow, even if everything is down |
| No agent registry | Context Service is infrastructure, not a task agent | Doesn't need discovery/scoring/heartbeat — always called directly via Dapr invocation |
| XState rejected | Dapr Workflow for state management | XState added 50KB bundle, Dapr already provides state machines. Decided in earlier milestone. |

---

## Phase 2 Preview (Not in Scope)

These capabilities will be added after Phase 1 is deployed and validated:

- **Compression logging** — write to `context_compression_log` table (schema deployed in Phase 1)
- **Reflection storage** — Context Service stores Mem0 reflections about what compression worked/failed
- **Adaptive rule engine** — rules that self-tune based on compression success patterns
- **Prompt rotation** — if one prompt produces garbled text, try a different prompt structure
- **Per-agent compression profiles** — learn which receivers need more/less context over time
