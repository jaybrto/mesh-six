# Claude MQTT Bridge

A lightweight Bun script that receives Claude Code hook events via stdin and publishes them to MQTT for real-time progress monitoring.

## Overview

This bridge enables real-time visibility into Claude Code sessions by:

1. Receiving hook events from Claude Code (via stdin)
2. Enriching events with context (git branch, worktree path, model)
3. Publishing to MQTT topics for consumption by UIs and other services

## Installation

```bash
# From monorepo root
bun install

# Build the bridge
bun run --filter '@mesh-six/claude-mqtt-bridge' build
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MQTT_URL` | `mqtt://localhost:1883` | MQTT broker URL |
| `MQTT_TOPIC_PREFIX` | `claude/progress` | Topic prefix for events |
| `MQTT_CLIENT_ID` | `claude-bridge` | MQTT client ID prefix |
| `JOB_ID` | (none) | Optional job ID for mesh-six integration |
| `GIT_BRANCH` | (auto-detect) | Override git branch detection |
| `WORKTREE_PATH` | (auto-detect) | Override worktree path detection |
| `MQTT_FALLBACK_LOG` | `/tmp/claude-mqtt-fallback.jsonl` | Fallback log path |
| `VERBOSE` | `false` | Enable verbose output |

### Claude Code Hook Setup

Add to `.claude/settings.local.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run \"$CLAUDE_PROJECT_DIR/apps/claude-mqtt-bridge/src/index.ts\"",
            "timeout": 5
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "bun run \"$CLAUDE_PROJECT_DIR/apps/claude-mqtt-bridge/src/index.ts\"",
            "timeout": 3,
            "async": true
          }
        ]
      }
    ]
    // ... additional hooks (PostToolUse, SubagentStart, etc.)
  }
}
```

## MQTT Topic Structure

Events are published to:

```
claude/progress/{session_id}/{event_type}
```

Examples:
- `claude/progress/abc123/SessionStart`
- `claude/progress/abc123/PreToolUse`
- `claude/progress/abc123/PostToolUse`
- `claude/progress/abc123/SubagentStart`

## Event Schema

```typescript
interface ClaudeProgressEvent {
  timestamp: number;        // Unix timestamp (ms)
  session_id: string;       // Claude session ID
  event: string;            // Event type
  status: "started" | "pending" | "completed" | "failed" | "ended";

  // Enriched context
  git_branch?: string;
  worktree_path?: string;
  model?: string;
  job_id?: string;

  // Event-specific fields
  tool_name?: string;
  tool_input?: object;
  tool_response?: object;
  error?: string;
  agent_id?: string;
  agent_type?: string;
}
```

## Testing

```bash
# Send a test event
echo '{"session_id":"test-123","hook_event_name":"SessionStart","model":"claude-sonnet-4-5-20250929"}' | \
  bun run src/index.ts

# Subscribe to events
mosquitto_sub -h localhost -t "claude/progress/#" -v
```

## Integration with mesh-six

The Project Manager agent subscribes to Claude progress events. To link a Claude session to a mesh-six project, set the `JOB_ID` environment variable before starting Claude:

```bash
JOB_ID=project-abc123 claude
```

## Fallback Behavior

If MQTT is unavailable, events are written to the fallback log file (`/tmp/claude-mqtt-fallback.jsonl` by default).

## Building for Production

```bash
# Build minified bundle
bun run build

# Output: dist/index.js (0.34 MB)
```

## See Also

- [Claude Progress UI Guide](../../docs/CLAUDE_PROGRESS_UI.md) - How to build a UI
- [Claude Code Hooks](https://code.claude.com/docs/hooks) - Official hooks documentation
