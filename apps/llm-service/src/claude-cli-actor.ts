import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import type { ActorInfo, ActorStatus, ChatCompletionRequest } from "@mesh-six/core";
import { DAPR_PUBSUB_NAME, LLM_EVENTS_TOPIC } from "@mesh-six/core";
import type { Actor } from "./actor-runtime.js";
import {
  registerActorTimer,
  unregisterActorTimer,
  saveActorState,
  publishEvent,
} from "./actor-runtime.js";
import { spawnCLI, validateCLI } from "./cli-spawner.js";
import {
  downloadAndExtract,
  archiveAndUpload,
  downloadActorConfig,
  downloadSession,
  uploadSession,
  cleanupDir,
  listCredentials,
} from "./minio-client.js";
import {
  buildCLIPrompt,
  injectSchemaInstructions,
  buildCompletionResponse,
  buildErrorResponse,
} from "./openai-compat.js";
import {
  ACTOR_CONFIG_BASE,
  CREDENTIAL_SYNC_INTERVAL,
  AGENT_ID,
  DEFAULT_MODEL,
  ALLOWED_MODELS,
} from "./config.js";
import {
  isAuthServiceConfigured,
  provisionFromAuthService,
  downloadBundle,
  checkAuthServiceHealth,
} from "./auth-client.js";

const log = (msg: string) => console.log(`[${AGENT_ID}][actor] ${msg}`);

// ============================================================================
// CLAUDE CLI ACTOR
// ============================================================================

export class ClaudeCLIActor implements Actor {
  private actorType: string;
  private actorId: string;
  private configDir: string;
  private credentialKey: string | null = null;
  private status: ActorStatus = "initializing";
  private capabilities: string[] = [];
  private requestCount = 0;
  private errorCount = 0;
  private lastUsed: string | undefined;

  // Auth service credential provisioning state
  private authBundleId: string | null = null;
  private credentialExpiresAt: number | null = null;

  // Mutable runtime config (updated via Dapr config subscription)
  private allowedModels: string[] = [...ALLOWED_MODELS];

  constructor(actorType: string, actorId: string) {
    this.actorType = actorType;
    this.actorId = actorId;
    this.configDir = join(ACTOR_CONFIG_BASE, actorId);
  }

  // -------------------------------------------------------------------------
  // LIFECYCLE
  // -------------------------------------------------------------------------

  async onActivate(): Promise<void> {
    this.status = "initializing";

    // Create config directory
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }

    // Also create .claude subdirectory for CLI config
    const claudeDir = join(this.configDir, ".claude");
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    // Try auth-service provisioning first (if configured), then fall back to MinIO
    let credentialsLoaded = false;

    if (isAuthServiceConfigured()) {
      credentialsLoaded = await this.provisionFromAuth();
    }

    if (!credentialsLoaded) {
      // Fallback: load credentials from MinIO (existing behavior)
      try {
        const credentialKeys = await listCredentials();
        if (credentialKeys.length === 0) {
          log(`No credentials found in MinIO for ${this.actorId}`);
          this.status = "unhealthy";
          return;
        }

        const actorIndex = parseInt(this.actorId.replace(/\D/g, ""), 10) || 0;
        this.credentialKey = credentialKeys[actorIndex % credentialKeys.length];

        log(`Loading credentials from ${this.credentialKey}`);
        await downloadAndExtract(this.credentialKey, this.configDir);
        credentialsLoaded = true;
      } catch (err) {
        log(`Failed to load credentials: ${err}`);
        this.status = "unhealthy";
        return;
      }
    }

    // Load actor-specific config (skills, settings, MCP servers)
    try {
      await downloadActorConfig(this.actorId, this.configDir);
    } catch {
      // Not fatal — actor can run without custom config
    }

    // Validate credentials with a lightweight CLI test
    const validation = await validateCLI(this.configDir, this.actorId);
    if (!validation.ok) {
      log(`Credential validation failed: ${validation.error}`);
      this.status = "unhealthy";

      // Only try next credential if using legacy MinIO mode
      if (!this.authBundleId) {
        await this.tryNextCredential();
      }
      return;
    }

    this.status = "idle";

    // Register credential sync timer with Dapr sidecar
    try {
      await registerActorTimer(this.actorType, this.actorId, "syncCredentials", {
        dueTime: CREDENTIAL_SYNC_INTERVAL,
        period: CREDENTIAL_SYNC_INTERVAL,
      });
    } catch (err) {
      log(`Failed to register sync timer: ${err}`);
    }

    // Save actor state
    await this.persistState();

    const source = this.authBundleId ? `auth bundle ${this.authBundleId}` : `credential ${this.credentialKey}`;
    log(`Actor ${this.actorId} ready (${source})`);
  }

  async onDeactivate(): Promise<void> {
    // Final credential sync back to MinIO
    if (this.credentialKey) {
      try {
        await archiveAndUpload(this.configDir, this.credentialKey);
        log(`Final credential sync for ${this.actorId}`);
      } catch (err) {
        log(`Failed final credential sync: ${err}`);
      }
    }

    // Unregister timers
    try {
      await unregisterActorTimer(this.actorType, this.actorId, "syncCredentials");
    } catch {
      // Timer may already be gone
    }

    // Clean up local config directory
    cleanupDir(this.configDir);

    this.status = "idle";
  }

  // -------------------------------------------------------------------------
  // METHOD DISPATCH
  // -------------------------------------------------------------------------

  async onInvoke(method: string, payload: unknown): Promise<unknown> {
    switch (method) {
      case "complete":
        return this.complete(payload as ChatCompletionRequest);
      case "getInfo":
        return this.getInfo();
      case "updateConfig":
        return this.updateConfig(payload as { allowedModels?: string[]; capabilities?: string[] });
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  async onTimer(timerName: string): Promise<void> {
    switch (timerName) {
      case "syncCredentials":
        await this.syncCredentials();
        break;
      default:
        log(`Unknown timer: ${timerName}`);
    }
  }

  async onReminder(reminderName: string, _payload: unknown): Promise<void> {
    log(`Reminder received: ${reminderName}`);
  }

  // -------------------------------------------------------------------------
  // CORE METHODS
  // -------------------------------------------------------------------------

  /**
   * Handle a chat completion request — the primary actor method.
   * Called via Dapr actor invocation from the router.
   */
  private async complete(
    request: ChatCompletionRequest,
  ): Promise<ReturnType<typeof buildCompletionResponse>> {
    if (this.status === "unhealthy") {
      return buildErrorResponse("Actor is unhealthy — credential failure", request.model);
    }

    // Validate model
    const model = request.model || DEFAULT_MODEL;
    if (!this.allowedModels.includes(model)) {
      return buildErrorResponse(
        `Model "${model}" is not allowed. Allowed: ${this.allowedModels.join(", ")}`,
        model,
      );
    }

    this.status = "busy";
    this.lastUsed = new Date().toISOString();

    try {
      // Build prompt from OpenAI messages
      const { systemPrompt, userPrompt } = buildCLIPrompt(request.messages);

      // Inject JSON schema instructions if structured output is requested
      const finalPrompt = injectSchemaInstructions(userPrompt, request);

      // Handle session resumption
      let sessionRestored = false;
      if (request.session_id) {
        sessionRestored = await downloadSession(request.session_id, this.configDir);
      }

      // Spawn the CLI
      const cliOpts = {
        prompt: finalPrompt,
        systemPrompt,
        model,
        maxTokens: request.max_tokens,
        configDir: this.configDir,
        actorId: this.actorId,
        sessionId: request.session_id,
      };
      let result = await spawnCLI(cliOpts);

      this.requestCount++;

      // Handle auth errors — attempt auth-service re-provision before giving up
      if (result.isAuthError) {
        if (isAuthServiceConfigured()) {
          log(`Auth error for ${this.actorId}, attempting auth-service re-provision`);
          const reprovisioned = await this.provisionFromAuth();
          if (reprovisioned) {
            result = await spawnCLI(cliOpts);
            this.requestCount++;
          }
        }

        if (result.isAuthError) {
          this.errorCount++;
          this.status = "unhealthy";
          await this.persistState();
          await this.publishStatusEvent("auth_error");
          return buildErrorResponse("Authentication failed", model);
        }
      }

      if (!result.success) {
        this.errorCount++;
        this.status = "idle";
        await this.persistState();

        return buildErrorResponse(result.content, model);
      }

      // Persist session if requested
      const sessionId = request.persist_session
        ? result.sessionId || request.session_id || crypto.randomUUID()
        : undefined;

      if (request.persist_session && sessionId) {
        try {
          await uploadSession(sessionId, this.configDir);
        } catch (err) {
          log(`Failed to persist session ${sessionId}: ${err}`);
        }
      }

      this.status = "idle";
      await this.persistState();

      // Publish completion event
      await this.publishStatusEvent("complete", {
        model,
        durationMs: result.durationMs,
      });

      return buildCompletionResponse(result.content, model, sessionId);
    } catch (err) {
      this.errorCount++;
      this.status = "idle";
      await this.persistState();

      const message = err instanceof Error ? err.message : String(err);
      return buildErrorResponse(message, model);
    }
  }

  /** Get actor status info */
  private getInfo(): ActorInfo {
    return {
      actorId: this.actorId,
      credentialId: this.credentialKey || "none",
      status: this.status,
      capabilities: this.capabilities,
      lastUsed: this.lastUsed,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
    };
  }

  /** Update runtime config (called when Dapr config changes) */
  private updateConfig(config: {
    allowedModels?: string[];
    capabilities?: string[];
  }): { ok: true } {
    if (config.allowedModels) {
      this.allowedModels = config.allowedModels;
    }
    if (config.capabilities) {
      this.capabilities = config.capabilities;
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // INTERNAL HELPERS
  // -------------------------------------------------------------------------

  /** Sync credentials — refresh via auth-service if expiring, always archive back to MinIO */
  private async syncCredentials(): Promise<void> {
    // Auth service mode: check expiry and re-provision if needed
    if (this.authBundleId && this.credentialExpiresAt) {
      const msUntilExpiry = this.credentialExpiresAt - Date.now();
      const REFRESH_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

      if (msUntilExpiry < REFRESH_THRESHOLD_MS) {
        log(`Credentials expiring in ${Math.round(msUntilExpiry / 60_000)}m, re-provisioning from auth-service`);
        await this.provisionFromAuth();
      }
    }

    // Always archive current config dir back to MinIO as backup
    if (this.credentialKey) {
      try {
        await archiveAndUpload(this.configDir, this.credentialKey);
        log(`Synced credentials for ${this.actorId}`);
      } catch (err) {
        log(`Credential sync failed for ${this.actorId}: ${err}`);
      }
    }
  }

  /** Attempt to provision credentials from the auth-service */
  private async provisionFromAuth(): Promise<boolean> {
    try {
      const provision = await provisionFromAuthService(this.actorId, this.authBundleId || undefined);
      if (!provision) return false;

      if (provision.status === "provisioned" && provision.bundleId) {
        const bundle = await downloadBundle(provision.bundleId);
        if (!bundle) {
          log(`Failed to download bundle ${provision.bundleId} for ${this.actorId}`);
          return false;
        }
        const proc = Bun.spawn(["tar", "xzf", "-", "-C", this.configDir], {
          stdin: new Blob([bundle]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          log(`Bundle extraction failed for ${this.actorId}: ${stderr}`);
          return false;
        }
        this.authBundleId = provision.bundleId;
        this.credentialExpiresAt = provision.credentialExpiresAt
          ? new Date(provision.credentialExpiresAt).getTime()
          : null;
        log(`Auth-service provisioned bundle ${this.authBundleId} for ${this.actorId}`);
        return true;
      }

      if (provision.status === "current") {
        log(`Auth-service credentials still current for ${this.actorId}`);
        return true;
      }

      // status === "no_credentials"
      log(`Auth-service has no credentials for ${this.actorId}`);
      return false;
    } catch (err) {
      log(`Auth-service provision failed for ${this.actorId}: ${err}`);
      return false;
    }
  }

  /** Try the next available credential set when current one fails */
  private async tryNextCredential(): Promise<void> {
    try {
      const credentialKeys = await listCredentials();
      const currentIndex = this.credentialKey
        ? credentialKeys.indexOf(this.credentialKey)
        : -1;

      for (let i = 1; i < credentialKeys.length; i++) {
        const nextKey = credentialKeys[(currentIndex + i) % credentialKeys.length];
        log(`Trying credential: ${nextKey}`);

        try {
          await downloadAndExtract(nextKey, this.configDir);
          const validation = await validateCLI(this.configDir, this.actorId);

          if (validation.ok) {
            this.credentialKey = nextKey;
            this.status = "idle";
            log(`Switched to credential: ${nextKey}`);
            return;
          }
        } catch {
          continue;
        }
      }

      log(`All credentials exhausted for ${this.actorId}`);
      this.status = "unhealthy";
    } catch (err) {
      log(`Failed to try next credential: ${err}`);
    }
  }

  /** Persist actor state to Dapr state store */
  private async persistState(): Promise<void> {
    try {
      await saveActorState(this.actorType, this.actorId, "info", this.getInfo());
    } catch (err) {
      log(`Failed to persist state: ${err}`);
    }
  }

  /** Publish a status event to Dapr pub/sub */
  private async publishStatusEvent(
    event: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await publishEvent(DAPR_PUBSUB_NAME, LLM_EVENTS_TOPIC, {
        actorId: this.actorId,
        event,
        timestamp: new Date().toISOString(),
        ...data,
      });
    } catch {
      // Non-fatal — event publishing is best-effort
    }
  }
}

/**
 * Factory function for creating ClaudeCLIActor instances.
 * Used by the ActorRuntime.
 */
export function createClaudeCLIActor(actorType: string, actorId: string): Actor {
  return new ClaudeCLIActor(actorType, actorId);
}
