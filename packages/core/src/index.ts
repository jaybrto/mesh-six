// Types and schemas
export {
  AgentCapabilitySchema,
  AgentRegistrationSchema,
  TaskRequestSchema,
  TaskResultSchema,
  AgentScoreCardSchema,
  TaskStatusSchema,
  type AgentCapability,
  type AgentRegistration,
  type TaskRequest,
  type TaskResult,
  type AgentScoreCard,
  type TaskStatus,
  type DaprPubSubMessage,
  type DaprSubscription,
  BoardEventBase,
  NewTodoEvent,
  CardBlockedEvent,
  CardUnblockedEvent,
  CardMovedEvent,
  BoardEvent,
  type BoardEventType,
  // Auth service types
  ProjectConfigSchema,
  CredentialPushRequestSchema,
  ProjectCredentialSchema,
  ProvisionRequestSchema,
  ProvisionResponseSchema,
  CredentialHealthSchema,
  type ProjectConfig,
  type CredentialPushRequest,
  type ProjectCredential,
  type ProvisionRequest,
  type ProvisionResponse,
  type CredentialHealth,
  // Implementation session types
  ImplementationSessionSchema,
  SessionQuestionSchema,
  type ImplementationSession,
  type SessionQuestion,
  // Auth service constants
  AUTH_SERVICE_APP_ID,
  CREDENTIAL_REFRESHED_TOPIC,
  CONFIG_UPDATED_TOPIC,
} from "./types.js";

// Registry
export { AgentRegistry } from "./registry.js";

// Scoring
export { AgentScorer } from "./scoring.js";

// Memory
export {
  AgentMemory,
  createAgentMemoryFromEnv,
  type MemoryConfig,
  type MemoryMessage,
  type MemorySearchResult,
} from "./memory.js";

// Context management
export {
  buildAgentContext,
  transitionClose,
  REFLECTION_PROMPT,
  type ContextConfig,
  type AgentContext,
  type MemoryScope,
  type TransitionCloseConfig,
} from "./context.js";

// GitHub Projects
export {
  GitHubProjectClient,
  TokenBucket,
  type TokenBucketConfig,
  type GitHubClientConfig,
  type ColumnMapping,
  type ProjectItem,
  type IssueComment,
  type LinkedPR,
} from "./github.js";

// Constants
export const DAPR_PUBSUB_NAME = "agent-pubsub";
export const DAPR_STATE_STORE = "agent-statestore";
export const TASK_RESULTS_TOPIC = "task-results";

// Event Log
export {
  EventLog,
  type MeshEvent,
  type EventQueryOpts,
} from "./events.js";

// LLM utility (replaces Vercel AI SDK)
export {
  chatCompletion,
  chatCompletionWithSchema,
  tracedChatCompletion,
  tool,
  LITELLM_BASE_URL,
  LITELLM_API_KEY,
  type ChatCompletionOpts,
  type ChatCompletionResult,
  type ChatCompletionWithSchemaOpts,
  type ChatCompletionWithSchemaResult,
  type TraceContext,
} from "./llm.js";

// Claude Code CLI auth & config
export {
  preloadClaudeConfig,
  detectAuthFailure,
  checkAuthEnvironment,
  ClaudeAuthError,
} from "./claude.js";

// Dialog detection for Claude Code CLI
export {
  matchKnownDialog,
  parseDialogResponse,
  looksNormal,
  KNOWN_DIALOGS,
  DIALOG_ANALYSIS_PROMPT,
  ClaudeDialogError,
  type DialogResponse,
} from "./dialog-handler.js";

// Credential utilities (Claude CLI auth file helpers)
export {
  isCredentialExpired,
  syncEphemeralConfig,
  buildCredentialsJson,
  buildConfigJson,
  buildSettingsJson,
  buildClaudeJson,
} from "./credentials.js";

// Context compression
export {
  CompressionRequestSchema,
  CompressionResponseSchema,
  CompressionRuleSchema,
  type CompressionRequest,
  type CompressionResponse,
  type CompressionRule,
} from "./compression.js";

// LLM Service
export {
  DAPR_LLM_SERVICE_APP_ID,
  LLM_EVENTS_TOPIC,
  LLM_ACTOR_TYPE,
  LLM_CONFIG_KEYS,
  ChatMessageSchema,
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  ActorStatusSchema,
  ActorInfoSchema,
  LLMServiceStatusSchema,
  CLIHookEventSchema,
  type ChatMessage,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ActorStatus,
  type ActorInfo,
  type LLMServiceStatus,
  type CLIHookEvent,
} from "./llm-service.js";

// PR and issue filtering
export {
  shouldProcessIssue,
  shouldProcessPR,
  loadFilterConfigFromEnv,
  type FilterConfig,
  type IssueInfo,
  type PRInfo,
} from "./pr-filter.js";

// Git utilities
export {
  cloneRepo,
  createWorktree,
  removeWorktree,
  listWorktrees,
  getDiff,
  getStatus,
  createBranch,
  checkoutBranch,
  stash,
  stashPop,
  getCurrentBranch,
  getLatestCommit,
  GitError,
  type WorktreeInfo,
  type GitStatus,
  type CloneOptions,
} from "./git.js";

// Comment generation
export {
  generateComment,
  generateSessionSummary,
  formatStatusComment,
  type CommentType,
  type CommentOptions,
  type SessionSummaryInput,
} from "./comment-generator.js";

// Architect Actor
export {
  ARCHITECT_ACTOR_TYPE,
  ArchitectActorStateSchema,
  ArchitectEventSchema,
  ARCHITECT_EVENT_TYPES,
  PlanningEventPayloadSchema,
  ImplEventPayloadSchema,
  QaEventPayloadSchema,
  HumanAnswerPayloadSchema,
  AnswerQuestionOutputSchema,
  type ArchitectActorState,
  type ArchitectEvent,
  type ArchitectEventType,
  type PlanningEventPayload,
  type ImplEventPayload,
  type QaEventPayload,
  type HumanAnswerPayload,
  type AnswerQuestionOutput,
} from "./architect-actor.js";

// Terminal streaming types
export {
  TERMINAL_STREAM_TOPIC_PREFIX,
  TERMINAL_SNAPSHOT_TOPIC_PREFIX,
  SNAPSHOT_EVENT_TYPES,
  TerminalSnapshotSchema,
  RecordingMetadataSchema,
  TerminalStreamChunkSchema,
  type SnapshotEventType,
  type TerminalSnapshot,
  type RecordingMetadata,
  type TerminalStreamChunk,
} from "./terminal-types.js";

// MinIO S3 client
export {
  createMinioClient,
  uploadToMinio,
  downloadFromMinio,
  getPresignedUrl as getMinioPresignedUrl,
  type MinioConfig,
} from "./minio.js";
export type { S3Client } from "@aws-sdk/client-s3";

// Mac Mini Scraper Service
export {
  ScrapeProviderSchema,
  ScrapeStatusSchema,
  ScrapeDispatchPayloadSchema,
  ScrapeStatusFileSchema,
  ScrapeAckResponseSchema,
  ScrapeValidationErrorSchema,
  SCRAPER_SERVICE_APP_ID,
  SCRAPER_MINIO_BUCKET,
  SCRAPER_MINIO_PREFIX,
  type ScrapeProvider,
  type ScrapeStatus,
  type ScrapeDispatchPayload,
  type ScrapeStatusFile,
  type ScrapeAckResponse,
  type ScrapeValidationError,
} from "./scraper-types.js";

// OpenTelemetry initialization
export { initTelemetry, type TelemetryConfig } from "./telemetry.js";

// Research Sub-Workflow types
export {
  ResearchSessionStatusSchema,
  ReviewVerdictSchema,
  ResearchAndPlanInputSchema,
  ResearchAndPlanOutputSchema,
  ArchitectTriageInputSchema,
  ArchitectTriageOutputSchema,
  StartDeepResearchInputSchema,
  StartDeepResearchOutputSchema,
  ReviewResearchInputSchema,
  ReviewResearchOutputSchema,
  ArchitectDraftPlanInputSchema,
  SendPushNotificationInputSchema,
  UpdateResearchSessionInputSchema,
  TriageLLMResponseSchema,
  ReviewLLMResponseSchema,
  ScrapeCompletedPayloadSchema,
  SCRAPE_COMPLETED_EVENT,
  MAX_RESEARCH_CYCLES,
  RESEARCH_TIMEOUT_MS,
  RESEARCH_MINIO_BUCKET,
  LLM_MODEL_PRO,
  LLM_MODEL_FLASH,
  SCRAPER_SERVICE_APP_ID_RESEARCH,
  MAX_RESEARCH_CONTEXT_CHARS,
  TIMEOUT_SENTINEL,
  type ResearchSessionStatus,
  type ReviewVerdict,
  type ResearchAndPlanInput,
  type ResearchAndPlanOutput,
  type ArchitectTriageInput,
  type ArchitectTriageOutput,
  type StartDeepResearchInput,
  type StartDeepResearchOutput,
  type ReviewResearchInput,
  type ReviewResearchOutput,
  type ArchitectDraftPlanInput,
  type SendPushNotificationInput,
  type UpdateResearchSessionInput,
  type TriageLLMResponse,
  type ReviewLLMResponse,
  type ScrapeCompletedPayload,
} from "./research-types.js";

// Research MinIO helpers
export {
  ensureResearchBucket,
  statusDocKey,
  writeResearchStatus,
  readResearchStatus,
  rawResearchKey,
  uploadRawResearch,
  downloadRawResearch,
  cleanResearchKey,
  uploadCleanResearch,
  downloadCleanResearch,
  type ResearchStatusDoc,
} from "./research-minio.js";

// Architect reflection prompt
export {
  ARCHITECT_REFLECTION_PROMPT,
  buildArchitectReflectionSystem,
} from "./prompts/architect-reflection.js";

// Web research tools (scaffolded — see TODO in file)
export {
  webResearchTools,
  buildResearchSystemPrompt,
} from "./tools/web-research.js";
