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
  SESSION_BLOCKED_TOPIC,
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
