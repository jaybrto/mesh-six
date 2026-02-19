import { Hono } from "hono";
import { CompressionRequestSchema, type CompressionResponse } from "@mesh-six/core";
import { findRule, applyRules } from "./rules.js";
import { compressWithLLM, formatRequestForLLM } from "./llm.js";
import { validateCompression } from "./validation.js";

export function createApp(agentId = "context-service") {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok", agent: agentId }));
  app.get("/readyz", (c) => c.json({ status: "ready", agent: agentId }));

  app.post("/compress", async (c) => {
    const startTime = Date.now();

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

    const rule = findRule(request.sender, request.receiver);
    const ruleResult = applyRules(request, rule);

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

    try {
      const llmInput = formatRequestForLLM(request);
      const llmResult = await compressWithLLM(request, llmInput);
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

  return app;
}
