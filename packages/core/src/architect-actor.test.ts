import { describe, it, expect } from "bun:test";
import {
  ARCHITECT_ACTOR_TYPE,
  ArchitectActorStateSchema,
  ArchitectEventSchema,
  PlanningEventPayloadSchema,
  ImplEventPayloadSchema,
  QaEventPayloadSchema,
  HumanAnswerPayloadSchema,
  AnswerQuestionOutputSchema,
} from "./architect-actor.js";

describe("architect-actor types", () => {
  it("exports ARCHITECT_ACTOR_TYPE constant", () => {
    expect(ARCHITECT_ACTOR_TYPE).toBe("ArchitectActor");
  });

  it("validates ArchitectActorState", () => {
    const state = {
      issueNumber: 42,
      repoOwner: "jaybrto",
      repoName: "mesh-six",
      workflowId: "wf-abc-123",
      projectItemId: "PVTI_abc",
      issueTitle: "Add auth",
    };
    expect(ArchitectActorStateSchema.parse(state)).toEqual(state);
  });

  it("validates architect events", () => {
    const event = {
      actorId: "jaybrto/mesh-six/42",
      eventType: "consulted",
      payload: { question: "How?", recommendation: {} },
    };
    expect(ArchitectEventSchema.parse(event)).toBeTruthy();
  });

  it("validates planning-event payloads", () => {
    const questionEvent = { type: "question-detected", questionText: "What auth?", sessionId: "s1" };
    expect(PlanningEventPayloadSchema.parse(questionEvent)).toBeTruthy();

    const completeEvent = { type: "plan-complete", planContent: "## Plan" };
    expect(PlanningEventPayloadSchema.parse(completeEvent)).toBeTruthy();

    const failEvent = { type: "session-failed", error: "crash" };
    expect(PlanningEventPayloadSchema.parse(failEvent)).toBeTruthy();
  });

  it("validates impl-event payloads", () => {
    const prEvent = { type: "pr-created", prNumber: 7 };
    expect(ImplEventPayloadSchema.parse(prEvent)).toBeTruthy();
  });

  it("validates qa-event payloads", () => {
    const testEvent = { type: "test-results", testContent: "PASS" };
    expect(QaEventPayloadSchema.parse(testEvent)).toBeTruthy();
  });

  it("validates human-answer payload", () => {
    const answer = { answer: "Use OAuth", timestamp: new Date().toISOString() };
    expect(HumanAnswerPayloadSchema.parse(answer)).toBeTruthy();
  });

  it("validates answerQuestion output", () => {
    const confident = { confident: true, answer: "Use JWT" };
    expect(AnswerQuestionOutputSchema.parse(confident)).toBeTruthy();

    const notConfident = { confident: false, bestGuess: "Maybe JWT?" };
    expect(AnswerQuestionOutputSchema.parse(notConfident)).toBeTruthy();
  });
});
