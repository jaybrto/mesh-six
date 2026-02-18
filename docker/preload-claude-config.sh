#!/bin/bash
# preload-claude-config.sh — run before `claude` CLI to prevent interactive dialogs
# Pre-seeds ~/.claude/.credentials.json and ~/.claude/settings.json
set -e

CLAUDE_DIR="${HOME}/.claude"
mkdir -p "${CLAUDE_DIR}"

# Write credentials if OAuth token is set
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN}" ]; then
  cat > "${CLAUDE_DIR}/.credentials.json" <<CREDS
{
  "oauthToken": "${CLAUDE_CODE_OAUTH_TOKEN}",
  "oauthAccount": {
    "accountUuid": "${CLAUDE_OAUTH_ACCOUNT_UUID:-}",
    "emailAddress": "${CLAUDE_OAUTH_EMAIL:-}",
    "organizationUuid": "${CLAUDE_OAUTH_ORG_UUID:-}",
    "hasExtraUsageEnabled": true,
    "billingType": "stripe_subscription",
    "displayName": "${CLAUDE_OAUTH_DISPLAY_NAME:-mesh-six}"
  }
}
CREDS
  chmod 600 "${CLAUDE_DIR}/.credentials.json"
  echo "[claude] Wrote credentials file"
fi

# Write headless settings (merge with existing)
SETTINGS="${CLAUDE_DIR}/settings.json"
if [ -f "${SETTINGS}" ]; then
  # Merge — only add keys that don't exist
  TMP=$(mktemp)
  jq '. + {
    skipDangerousModePermissionPrompt: (.skipDangerousModePermissionPrompt // true),
    theme: (.theme // "dark"),
    hasCompletedOnboarding: (.hasCompletedOnboarding // true)
  }' "${SETTINGS}" > "${TMP}" && mv "${TMP}" "${SETTINGS}"
else
  cat > "${SETTINGS}" <<SETTINGS
{
  "skipDangerousModePermissionPrompt": true,
  "theme": "dark",
  "hasCompletedOnboarding": true
}
SETTINGS
fi
chmod 600 "${SETTINGS}"
echo "[claude] Settings pre-seeded"
