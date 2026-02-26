/**
 * ArchitectActor — Dapr actor with per-issue instances.
 *
 * Maintains a sequential event log in PostgreSQL so it has full context
 * when answering questions during planning/implementation phases.
 * Uses Mem0 for cross-issue long-term memory.
 */
import { Pool } from "pg";
import {
  type ArchitectActorState,
  type ArchitectEventType,
  type AnswerQuestionOutput,
  ARCHITECT_ACTOR_TYPE,
} from "@mesh-six/core";
import {
  appendEvent,
  loadEvents,
  loadEventsByType,
  type ArchitectEventRow,
} from "./event-db.js";
import type { Actor } from "./actor-runtime.js";

const log = (actorId: string, msg: string) =>
  console.log(`[${ARCHITECT_ACTOR_TYPE}][${actorId}] ${msg}`);

// ---------------------------------------------------------------------------
// Dependencies injected at module level (set during service startup)
// ---------------------------------------------------------------------------

let pgPool: Pool | null = null;
let llmModel = "anthropic/claude-sonnet-4-20250514";

let handleConsultationFn: ((request: {
  question: string;
  context?: Record<string, unknown>;
  userId?: string;
  requireStructured: boolean;
}) => Promise<unknown>) | null = null;

let tracedChatCompletionFn: ((opts: {
  model: string;
  system: string;
  prompt: string;
}, trace?: unknown) => Promise<{ text: string }>) | null = null;

let memoryStoreFn: ((messages: Array<{ role: string; content: string }>, userId: string, metadata?: Record<string, unknown>) => Promise<void>) | null = null;

let memorySearchFn: ((query: string, userId: string, limit?: number) => Promise<Array<{ memory: string }>>) | null = null;

export function setActorDeps(deps: {
  pool: Pool | null;
  model: string;
  handleConsultation: typeof handleConsultationFn;
  tracedChatCompletion: typeof tracedChatCompletionFn;
  memoryStore: typeof memoryStoreFn;
  memorySearch: typeof memorySearchFn;
}) {
  pgPool = deps.pool;
  llmModel = deps.model;
  handleConsultationFn = deps.handleConsultation;
  tracedChatCompletionFn = deps.tracedChatCompletion;
  memoryStoreFn = deps.memoryStore;
  memorySearchFn = deps.memorySearch;
}

// ---------------------------------------------------------------------------
// ArchitectActor
// ---------------------------------------------------------------------------

export class ArchitectActor implements Actor {
  private actorType: string;
  private actorId: string;
  private state: ArchitectActorState | null = null;
  private eventCache: ArchitectEventRow[] = [];

  constructor(actorType: string, actorId: string) {
    this.actorType = actorType;
    this.actorId = actorId;
  }

  async onActivate(): Promise<void> {
    log(this.actorId, "Activating (loading event log from PG)");
    if (pgPool) {
      this.eventCache = await loadEvents(pgPool, this.actorId);
    }
    log(this.actorId, `Loaded ${this.eventCache.length} events from PG`);
  }

  async onDeactivate(): Promise<void> {
    log(this.actorId, "Deactivating");
    if (pgPool) {
      await appendEvent(pgPool, this.actorId, "deactivated", { reason: "idle-timeout" });
    }
    this.state = null;
    this.eventCache = [];
  }

  async onInvoke(method: string, payload: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(payload as ArchitectActorState);
      case "consult":
        return this.consult(payload as { question: string; context?: Record<string, unknown> });
      case "answerQuestion":
        return this.answerQuestion(payload as { questionText: string; source: string });
      case "receiveHumanAnswer":
        return this.receiveHumanAnswer(payload as { questionText: string; humanAnswer: string });
      case "getHistory":
        return this.getHistory();
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  async onTimer(_timerName: string): Promise<void> {}
  async onReminder(_reminderName: string, _payload: unknown): Promise<void> {}

  private async initialize(params: ArchitectActorState): Promise<{ ok: boolean }> {
    this.state = params;
    if (pgPool) {
      const event = await appendEvent(pgPool, this.actorId, "activated", {
        issueTitle: params.issueTitle,
        workflowId: params.workflowId,
      });
      this.eventCache.push(event);
    }
    log(this.actorId, `Initialized for issue #${params.issueNumber}: ${params.issueTitle}`);
    return { ok: true };
  }

  private async consult(params: { question: string; context?: Record<string, unknown> }): Promise<unknown> {
    if (!handleConsultationFn) throw new Error("handleConsultation not set");

    const result = await handleConsultationFn({
      question: params.question,
      context: params.context,
      userId: `architect:${this.actorId}`,
      requireStructured: true,
    });

    if (pgPool) {
      const event = await appendEvent(pgPool, this.actorId, "consulted", {
        question: params.question,
        recommendation: result,
      });
      this.eventCache.push(event);
    }

    return result;
  }

  private async answerQuestion(params: {
    questionText: string;
    source: string;
  }): Promise<AnswerQuestionOutput> {
    if (!tracedChatCompletionFn) throw new Error("tracedChatCompletion not set");

    if (pgPool) {
      const event = await appendEvent(pgPool, this.actorId, "question-received", {
        questionText: params.questionText,
        source: params.source,
      });
      this.eventCache.push(event);
    }

    const contextParts: string[] = [];

    const consulted = this.eventCache.filter((e) => e.event_type === "consulted");
    if (consulted.length > 0) {
      const latest = consulted[consulted.length - 1];
      contextParts.push(`## Prior Architecture Recommendation\n${JSON.stringify(latest.payload.recommendation, null, 2)}`);
    }

    const qaPairs = this.eventCache.filter(
      (e) => e.event_type === "question-answered" || e.event_type === "human-answered"
    );
    if (qaPairs.length > 0) {
      const qaContext = qaPairs
        .map((e) => `Q: ${e.payload.questionText}\nA: ${e.payload.answer || e.payload.humanAnswer}`)
        .join("\n\n");
      contextParts.push(`## Previous Q&A for This Issue\n${qaContext}`);
    }

    if (memorySearchFn) {
      try {
        const memories = await memorySearchFn(params.questionText, `planning-qa:${this.state?.issueNumber}`, 5);
        if (memories.length > 0) {
          contextParts.push(`## Relevant Past Learnings\n${memories.map((m) => `- ${m.memory}`).join("\n")}`);
        }
      } catch (err) {
        log(this.actorId, `Mem0 search failed: ${err}`);
      }
    }

    const systemPrompt = `You are an architect answering questions about an ongoing implementation.
You have full context of this issue from your prior analysis and event log.
${contextParts.join("\n\n")}

If you are confident in your answer, respond with JSON: { "confident": true, "answer": "your answer" }
If you are NOT confident, respond with JSON: { "confident": false, "bestGuess": "your best guess" }

Do NOT make up answers. If you truly don't know, say so.`;

    const { text } = await tracedChatCompletionFn({
      model: llmModel,
      system: systemPrompt,
      prompt: params.questionText,
    });

    let output: AnswerQuestionOutput;
    try {
      output = JSON.parse(text);
    } catch {
      output = { confident: false, bestGuess: text };
    }

    if (pgPool) {
      const eventType: ArchitectEventType = output.confident ? "question-answered" : "human-escalated";
      const event = await appendEvent(pgPool, this.actorId, eventType, {
        questionText: params.questionText,
        ...(output.confident
          ? { answer: output.answer, confidence: true }
          : { bestGuess: output.bestGuess }),
      });
      this.eventCache.push(event);
    }

    return output;
  }

  private async receiveHumanAnswer(params: {
    questionText: string;
    humanAnswer: string;
  }): Promise<{ ok: boolean }> {
    if (pgPool) {
      const event = await appendEvent(pgPool, this.actorId, "human-answered", {
        questionText: params.questionText,
        humanAnswer: params.humanAnswer,
      });
      this.eventCache.push(event);
    }

    if (tracedChatCompletionFn && memoryStoreFn) {
      try {
        const { text: generalized } = await tracedChatCompletionFn({
          model: llmModel,
          system: "Generalize this Q&A into a reusable learning that applies to future similar questions. Be concise. Return just the generalized learning, nothing else.",
          prompt: `Question: ${params.questionText}\nHuman Answer: ${params.humanAnswer}`,
        });

        const issueUserId = `planning-qa:${this.state?.issueNumber}`;
        await memoryStoreFn(
          [
            { role: "user", content: params.questionText },
            { role: "assistant", content: params.humanAnswer },
          ],
          issueUserId,
          { type: "human-answer", generalized },
        );

        await memoryStoreFn(
          [
            { role: "user", content: params.questionText },
            { role: "assistant", content: generalized },
          ],
          "architect",
          { type: "generalized-learning", issueNumber: this.state?.issueNumber },
        );

        if (pgPool) {
          const event = await appendEvent(pgPool, this.actorId, "memory-stored", {
            issueScope: issueUserId,
            globalScope: "architect",
            summary: generalized.substring(0, 200),
          });
          this.eventCache.push(event);
        }

        log(this.actorId, `Stored generalized learning: ${generalized.substring(0, 100)}`);
      } catch (err) {
        log(this.actorId, `Failed to generalize/store human answer: ${err}`);
      }
    }

    return { ok: true };
  }

  private getHistory(): { events: ArchitectEventRow[] } {
    return { events: this.eventCache };
  }
}
