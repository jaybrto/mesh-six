#!/bin/bash
set -e

CLAUDE_VERSION="${CLAUDEVERSION:-latest}"

echo "Installing mesh-six tools with Claude Code v${CLAUDE_VERSION}..."

# System dependencies
apt-get update && apt-get install -y --no-install-recommends \
    tmux \
    curl \
    jq \
    watch \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg
chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) \
    signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
    https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (Node.js must be available — installsAfter guarantees this)
if command -v npm &> /dev/null; then
    if [ "$CLAUDE_VERSION" = "latest" ]; then
        npm install -g @anthropic-ai/claude-code
    else
        npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}"
    fi
    npm cache clean --force
else
    echo "WARNING: npm not found. Claude Code CLI not installed."
    echo "Add ghcr.io/devcontainers/features/node to your devcontainer.json features."
fi

echo "mesh-six tools installation complete."
