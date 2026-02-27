import { VAULT_ADDR, VAULT_TOKEN } from "../config.js";

export interface RegisterWebhookSecretInput {
  repoOwner: string;
  repoName: string;
}

export interface RegisterWebhookSecretOutput {
  secretPath: string;
  alreadyExisted: boolean;
}

function buildSecretPath(repoOwner: string, repoName: string): string {
  return `secret/data/mesh-six/webhooks/${repoOwner}-${repoName}`;
}

async function vaultRequest<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown
): Promise<{ data: T; statusCode: number }> {
  const resp = await fetch(`${VAULT_ADDR}/v1/${path}`, {
    method,
    headers: {
      "X-Vault-Token": VAULT_TOKEN,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  return { data: (resp.ok ? await resp.json() : null) as T, statusCode: resp.status };
}

export async function registerWebhookSecret(
  input: RegisterWebhookSecretInput
): Promise<RegisterWebhookSecretOutput> {
  const { repoOwner, repoName } = input;
  const secretPath = buildSecretPath(repoOwner, repoName);

  // Check if the secret already exists
  const { statusCode } = await vaultRequest("GET", secretPath);

  if (statusCode === 200) {
    return { secretPath, alreadyExisted: true };
  }

  // Generate HMAC secret: two UUID4s concatenated without dashes
  const secret =
    crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

  // Write secret to Vault
  const writeResp = await fetch(`${VAULT_ADDR}/v1/${secretPath}`, {
    method: "POST",
    headers: {
      "X-Vault-Token": VAULT_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        secret,
        repoOwner,
        repoName,
        createdAt: new Date().toISOString(),
      },
    }),
  });

  if (!writeResp.ok) {
    const text = await writeResp.text();
    throw new Error(`Failed to write webhook secret to Vault (${writeResp.status}): ${text}`);
  }

  return { secretPath, alreadyExisted: false };
}
