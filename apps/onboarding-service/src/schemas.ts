import { z } from "zod";

export const ResourceLimitsSchema = z.object({
  memoryRequest: z.string().default("256Mi"),
  memoryLimit: z.string().default("512Mi"),
  cpuRequest: z.string().default("100m"),
  cpuLimit: z.string().default("500m"),
  storageWorktrees: z.string().default("5Gi"),
  storageClaude: z.string().default("1Gi"),
});

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

export const LiteLLMConfigSchema = z.object({
  teamAlias: z.string().optional(),
  defaultModel: z.string().optional(),
  maxBudget: z.number().optional(),
});

export type LiteLLMConfig = z.infer<typeof LiteLLMConfigSchema>;

export const AppSettingsSchema = z.object({
  cloudflareDomain: z.string().optional(),
  terminalStreamingRate: z.number().optional(),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const OnboardProjectRequestSchema = z.object({
  repoOwner: z.string(),
  repoName: z.string(),
  displayName: z.string().optional(),
  defaultBranch: z.string().default("main"),
  skipAuth: z.boolean().default(false),
  skipLiteLLM: z.boolean().default(false),
  resourceLimits: ResourceLimitsSchema.optional(),
  litellm: LiteLLMConfigSchema.optional(),
  settings: AppSettingsSchema.optional(),
});

export type OnboardProjectRequest = z.infer<typeof OnboardProjectRequestSchema>;

export const AuthCallbackSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string().datetime(),
});

export type AuthCallback = z.infer<typeof AuthCallbackSchema>;
