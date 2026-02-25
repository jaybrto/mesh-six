/**
 * Bundle generation for auth-service.
 *
 * Builds an in-memory tar.gz containing the Claude CLI auth files:
 *   .claude/.credentials.json
 *   .config/claude/config.json
 *   .claude/settings.json
 *   .claude.json
 *
 * Uses only Node.js built-ins (zlib/buffer) — no tar-stream dependency.
 * No S3/MinIO — bundles are stored in auth_bundles.bundle_data (BYTEA).
 */
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import {
  buildCredentialsJson,
  buildConfigJson,
  buildSettingsJson,
  buildClaudeJson,
  type ProjectConfig,
  type ProjectCredential,
} from "@mesh-six/core";

export interface BundleInput {
  project: ProjectConfig;
  credential: ProjectCredential;
}

// -------------------------------------------------------------------------
// Minimal ustar tar builder (pure Buffer — no external deps)
// -------------------------------------------------------------------------

/** Build a ustar tar archive from an array of {name, data} entries. */
function buildTar(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];

  for (const { name, data } of entries) {
    parts.push(tarHeader(name, data.length));
    parts.push(data);
    // Pad to 512-byte block boundary
    const rem = 512 - (data.length % 512);
    if (rem < 512) parts.push(Buffer.alloc(rem));
  }

  // End-of-archive: two 512-byte zero blocks
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Build a 512-byte ustar header for a regular file. */
function tarHeader(name: string, size: number): Buffer {
  const hdr = Buffer.alloc(512);

  // Encode name — split into prefix/name for paths > 100 chars
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.length <= 100) {
    nameBytes.copy(hdr, 0, 0, Math.min(nameBytes.length, 100));
  } else {
    // Use prefix field (offset 345, 155 bytes) and name field (offset 0, 100 bytes)
    const slash = name.lastIndexOf("/");
    if (slash > 0 && slash <= 154) {
      Buffer.from(name.slice(0, slash)).copy(hdr, 345);
      Buffer.from(name.slice(slash + 1)).copy(hdr, 0);
    } else {
      nameBytes.slice(0, 100).copy(hdr, 0);
    }
  }

  // mode: 0644
  hdr.write("0000644\0", 100, "ascii");
  // uid, gid
  hdr.write("0000000\0", 108, "ascii");
  hdr.write("0000000\0", 116, "ascii");
  // size (octal, 11 digits + null)
  hdr.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  // mtime
  const mtime = Math.floor(Date.now() / 1000);
  hdr.write(mtime.toString(8).padStart(11, "0") + "\0", 136, "ascii");
  // checksum placeholder (spaces)
  hdr.fill(" ", 148, 156);
  // typeflag: '0' = regular file
  hdr.write("0", 156, "ascii");
  // magic: "ustar  \0"
  hdr.write("ustar  \0", 257, "ascii");

  // Compute checksum
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += hdr[i];
  hdr.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");

  return hdr;
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * Generate an in-memory tar.gz bundle for a project/credential pair.
 * Returns the raw Buffer that can be stored as BYTEA in PostgreSQL.
 */
export function generateBundle(input: BundleInput): Buffer {
  const { project, credential } = input;

  // .claude/.credentials.json
  const credJson = buildCredentialsJson({
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    // expiresAt is an ISO datetime string — convert to Unix ms for credentials file
    expiresAt: new Date(credential.expiresAt).getTime(),
    accountUuid: credential.accountUuid,
    emailAddress: credential.emailAddress,
    organizationUuid: credential.organizationUuid,
    billingType: credential.billingType ?? "stripe_subscription",
    displayName: credential.displayName ?? "mesh-six",
  });

  // .config/claude/config.json
  const configJson = buildConfigJson(credential.accessToken);

  // .claude/settings.json
  const settingsJson = buildSettingsJson(project.settingsJson);

  // .claude.json
  const claudeJson = buildClaudeJson(project.claudeJson, {
    accountUuid: credential.accountUuid ?? project.claudeAccountUuid,
    emailAddress: credential.emailAddress ?? project.claudeEmail,
    organizationUuid: credential.organizationUuid ?? project.claudeOrgUuid,
    billingType: credential.billingType,
    displayName: credential.displayName,
  });

  const tarBuffer = buildTar([
    { name: ".claude/.credentials.json", data: Buffer.from(credJson, "utf8") },
    { name: ".config/claude/config.json", data: Buffer.from(configJson, "utf8") },
    { name: ".claude/settings.json", data: Buffer.from(settingsJson, "utf8") },
    { name: ".claude.json", data: Buffer.from(claudeJson, "utf8") },
  ]);

  return gzipSync(tarBuffer);
}

/**
 * Compute a SHA-256 hash of the config fields that affect bundle content.
 * Used to detect whether a new bundle is needed.
 */
export function computeConfigHash(project: ProjectConfig, credentialId: string): string {
  const inputs = [
    credentialId,
    project.settingsJson ?? "",
    project.claudeJson ?? "",
    project.mcpJson ?? "",
    project.claudeMd ?? "",
  ].join("\x00");

  return createHash("sha256").update(inputs).digest("hex");
}
