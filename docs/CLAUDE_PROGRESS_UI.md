# Claude Code Progress UI Guide

This document explains how to build a real-time UI for monitoring Claude Code sessions using MQTT events published by the `@mesh-six/claude-mqtt-bridge`.

## Overview

```
┌─────────────────┐    MQTT     ┌─────────────────┐    WebSocket    ┌─────────────────┐
│  Claude Code    │──────────▶│   RabbitMQ      │────────────────▶│   Progress UI   │
│  + Hooks        │            │   MQTT Plugin   │                  │   (Browser)     │
└─────────────────┘            └─────────────────┘                  └─────────────────┘
```

Claude Code hooks publish events to MQTT topics. A UI can subscribe to these topics via WebSocket (using RabbitMQ's MQTT-over-WebSocket) or through a backend service that bridges MQTT to WebSocket.

---

## MQTT Topic Structure

Events are published to topics following this pattern:

```
claude/progress/{session_id}/{event_type}
```

### Topic Examples

```
claude/progress/abc123/SessionStart
claude/progress/abc123/PreToolUse
claude/progress/abc123/PostToolUse
claude/progress/abc123/SubagentStart
claude/progress/abc123/SubagentStop
claude/progress/abc123/SessionEnd
```

### Wildcard Subscriptions

```
# All events for a specific session
claude/progress/abc123/#

# All events of a specific type across all sessions
claude/progress/+/SessionStart

# All events from all sessions
claude/progress/#
```

---

## Event Schema

All events share a common base structure:

```typescript
interface BaseEvent {
  timestamp: number;        // Unix timestamp (ms)
  session_id: string;       // Claude session ID
  event: string;            // Event type (SessionStart, PreToolUse, etc.)
  status: "started" | "pending" | "completed" | "failed" | "ended" | "unknown";

  // Enriched context
  git_branch?: string;      // Current git branch
  worktree_path?: string;   // Git worktree root path
  model?: string;           // LLM model (e.g., "claude-sonnet-4-5-20250929")
  job_id?: string;          // mesh-six job ID (if set)
}
```

### Event-Specific Fields

#### SessionStart
```typescript
interface SessionStartEvent extends BaseEvent {
  event: "SessionStart";
  status: "started";
  source: "startup" | "resume" | "clear" | "compact";
  model: string;
}
```

#### PreToolUse / PostToolUse
```typescript
interface ToolEvent extends BaseEvent {
  event: "PreToolUse" | "PostToolUse";
  status: "pending" | "completed";
  tool_name: string;        // "Bash", "Write", "Edit", "Read", "Glob", "Grep", etc.
  tool_input: {
    command?: string;       // For Bash
    file_path?: string;     // For Write/Edit/Read
    pattern?: string;       // For Glob/Grep
    // ... other tool-specific fields
  };
  tool_response?: unknown;  // Only in PostToolUse
}
```

#### PostToolUseFailure
```typescript
interface ToolFailureEvent extends BaseEvent {
  event: "PostToolUseFailure";
  status: "failed";
  tool_name: string;
  tool_input: unknown;
  error: string;
}
```

#### SubagentStart / SubagentStop
```typescript
interface SubagentEvent extends BaseEvent {
  event: "SubagentStart" | "SubagentStop";
  status: "started" | "completed";
  agent_id: string;
  agent_type: "Explore" | "Plan" | "Bash" | string;
}
```

#### SessionEnd
```typescript
interface SessionEndEvent extends BaseEvent {
  event: "SessionEnd";
  status: "ended";
  reason: "clear" | "logout" | "prompt_input_exit" | "bypass_permissions_disabled" | "other";
}
```

#### Notification
```typescript
interface NotificationEvent extends BaseEvent {
  event: "Notification";
  notification: {
    message: string;
    title?: string;
    type?: "permission_prompt" | "idle_prompt" | "auth_success" | "elicitation_dialog";
  };
}
```

---

## Subscribing to Events

### Option 1: Direct MQTT (Node.js/Bun Backend)

```typescript
import * as mqtt from "mqtt";

const client = mqtt.connect("mqtt://rabbitmq.rabbitmq:1883");

client.on("connect", () => {
  // Subscribe to all Claude progress events
  client.subscribe("claude/progress/#");
});

client.on("message", (topic, message) => {
  const event = JSON.parse(message.toString());
  console.log(`[${event.event}] Session: ${event.session_id}`);

  // Forward to WebSocket clients, store in DB, etc.
});
```

### Option 2: MQTT over WebSocket (Browser)

RabbitMQ supports MQTT over WebSocket on port 15675 (default).

```typescript
import mqtt from "mqtt";

const client = mqtt.connect("ws://rabbitmq.rabbitmq:15675/ws", {
  clientId: `ui-${Date.now()}`,
});

client.on("connect", () => {
  client.subscribe("claude/progress/#");
});

client.on("message", (topic, message) => {
  const event = JSON.parse(message.toString());
  // Update UI state
});
```

### Option 3: mosquitto_sub (CLI)

```bash
# Watch all events
mosquitto_sub -h rabbitmq.rabbitmq -t "claude/progress/#" -v

# Watch specific session
mosquitto_sub -h rabbitmq.rabbitmq -t "claude/progress/abc123/#" -v

# Watch only tool completions
mosquitto_sub -h rabbitmq.rabbitmq -t "claude/progress/+/PostToolUse" -v
```

---

## UI Architecture Recommendations

### React + Zustand Example

```typescript
// store/claudeStore.ts
import { create } from "zustand";
import mqtt from "mqtt";

interface Session {
  id: string;
  model?: string;
  branch?: string;
  worktreePath?: string;
  status: "active" | "ended";
  events: ClaudeEvent[];
  subagents: Map<string, Subagent>;
  startedAt: number;
  endedAt?: number;
}

interface ClaudeStore {
  sessions: Map<string, Session>;
  activeSessionIds: string[];
  addEvent: (event: ClaudeEvent) => void;
  subscribe: () => void;
  unsubscribe: () => void;
}

export const useClaudeStore = create<ClaudeStore>((set, get) => ({
  sessions: new Map(),
  activeSessionIds: [],

  addEvent: (event) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      let session = sessions.get(event.session_id);

      if (!session) {
        session = {
          id: event.session_id,
          status: "active",
          events: [],
          subagents: new Map(),
          startedAt: event.timestamp,
        };
      }

      // Update session with event data
      if (event.model) session.model = event.model;
      if (event.git_branch) session.branch = event.git_branch;
      if (event.worktree_path) session.worktreePath = event.worktree_path;

      // Track subagents
      if (event.event === "SubagentStart" && event.agent_id) {
        session.subagents.set(event.agent_id, {
          id: event.agent_id,
          type: event.agent_type || "unknown",
          status: "running",
          startedAt: event.timestamp,
        });
      }
      if (event.event === "SubagentStop" && event.agent_id) {
        const subagent = session.subagents.get(event.agent_id);
        if (subagent) {
          subagent.status = "completed";
          subagent.endedAt = event.timestamp;
        }
      }

      // Track session end
      if (event.event === "SessionEnd") {
        session.status = "ended";
        session.endedAt = event.timestamp;
      }

      session.events.push(event);
      sessions.set(event.session_id, session);

      // Update active sessions list
      const activeSessionIds = Array.from(sessions.values())
        .filter((s) => s.status === "active")
        .map((s) => s.id);

      return { sessions, activeSessionIds };
    });
  },

  subscribe: () => {
    const client = mqtt.connect("ws://rabbitmq.rabbitmq:15675/ws");

    client.on("connect", () => {
      client.subscribe("claude/progress/#");
    });

    client.on("message", (_, message) => {
      const event = JSON.parse(message.toString());
      get().addEvent(event);
    });
  },

  unsubscribe: () => {
    // Cleanup
  },
}));
```

### UI Component Example

```tsx
// components/SessionList.tsx
import { useClaudeStore } from "../store/claudeStore";

export function SessionList() {
  const { sessions, activeSessionIds } = useClaudeStore();

  return (
    <div className="session-list">
      <h2>Active Sessions ({activeSessionIds.length})</h2>
      {activeSessionIds.map((id) => {
        const session = sessions.get(id)!;
        return (
          <div key={id} className="session-card">
            <div className="session-header">
              <span className="session-id">{id.slice(0, 8)}...</span>
              <span className="session-model">{session.model}</span>
              <span className="session-branch">{session.branch}</span>
            </div>
            <div className="session-stats">
              <span>Events: {session.events.length}</span>
              <span>Subagents: {session.subagents.size}</span>
            </div>
            <EventTimeline events={session.events} />
          </div>
        );
      })}
    </div>
  );
}
```

### Timeline Component

```tsx
// components/EventTimeline.tsx
export function EventTimeline({ events }: { events: ClaudeEvent[] }) {
  return (
    <div className="timeline">
      {events.slice(-20).map((event, i) => (
        <div key={i} className={`event event-${event.status}`}>
          <span className="event-time">
            {new Date(event.timestamp).toLocaleTimeString()}
          </span>
          <span className="event-type">{event.event}</span>
          {event.tool_name && (
            <span className="event-tool">{event.tool_name}</span>
          )}
          {event.agent_type && (
            <span className="event-agent">{event.agent_type}</span>
          )}
          {event.error && (
            <span className="event-error">{event.error}</span>
          )}
        </div>
      ))}
    </div>
  );
}
```

---

## Integration with mesh-six

The Project Manager agent already subscribes to MQTT events. To link Claude Code sessions to mesh-six projects:

1. **Set JOB_ID environment variable** when starting Claude Code:
   ```bash
   JOB_ID=project-abc123 claude
   ```

2. **Project Manager receives events** with `job_id` field and can:
   - Update project metadata with progress
   - Add GitHub comments on significant events
   - Track subagent work
   - Monitor for failures

3. **Query events by job_id**:
   ```typescript
   // Filter events for a specific job
   const projectEvents = allEvents.filter(e => e.job_id === "project-abc123");
   ```

---

## Dashboard Ideas

### 1. Real-time Activity Feed
- Live stream of all events across all sessions
- Filter by session, event type, or status
- Highlight errors and notifications

### 2. Session Overview
- Cards for each active session
- Show model, branch, worktree path
- Event count, subagent count
- Duration since start

### 3. Tool Usage Analytics
- Histogram of tool usage by type
- Success/failure rates per tool
- Average execution time per tool

### 4. Subagent Tree View
- Hierarchical view of main agent + subagents
- Show agent type and status
- Expand to see agent-specific events

### 5. Error Dashboard
- All `PostToolUseFailure` events
- Group by error type
- Show context (tool, input, session)

### 6. Project Progress (mesh-six)
- Link sessions to projects via job_id
- Show project state machine progress
- Aggregate events per project

---

## Example: Simple CLI Monitor

```bash
#!/bin/bash
# monitor-claude.sh - Simple CLI dashboard

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

mosquitto_sub -h rabbitmq.rabbitmq -t "claude/progress/#" | while read -r line; do
  # Parse JSON
  EVENT=$(echo "$line" | jq -r '.event // "unknown"')
  SESSION=$(echo "$line" | jq -r '.session_id // "unknown"' | cut -c1-8)
  STATUS=$(echo "$line" | jq -r '.status // "unknown"')
  TOOL=$(echo "$line" | jq -r '.tool_name // ""')
  AGENT=$(echo "$line" | jq -r '.agent_type // ""')
  ERROR=$(echo "$line" | jq -r '.error // ""')

  # Format output
  TIMESTAMP=$(date +%H:%M:%S)

  case "$STATUS" in
    "started")   COLOR=$BLUE ;;
    "pending")   COLOR=$YELLOW ;;
    "completed") COLOR=$GREEN ;;
    "failed")    COLOR=$RED ;;
    "ended")     COLOR=$NC ;;
    *)           COLOR=$NC ;;
  esac

  echo -e "${COLOR}[$TIMESTAMP] [$SESSION] $EVENT${NC}"

  if [ -n "$TOOL" ]; then
    echo "         Tool: $TOOL"
  fi
  if [ -n "$AGENT" ]; then
    echo "         Agent: $AGENT"
  fi
  if [ -n "$ERROR" ]; then
    echo -e "         ${RED}Error: $ERROR${NC}"
  fi
done
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MQTT_URL` | `mqtt://localhost:1883` | MQTT broker URL |
| `MQTT_TOPIC_PREFIX` | `claude/progress` | Topic prefix for events |
| `MQTT_CLIENT_ID` | `claude-bridge` | MQTT client ID prefix |
| `JOB_ID` | (none) | mesh-six job ID for project linking |
| `GIT_BRANCH` | (auto-detect) | Override git branch |
| `WORKTREE_PATH` | (auto-detect) | Override worktree path |
| `MQTT_FALLBACK_LOG` | `/tmp/claude-mqtt-fallback.jsonl` | Fallback log when MQTT unavailable |
| `VERBOSE` | `false` | Enable verbose logging |

### RabbitMQ MQTT Configuration

Enable the MQTT plugin:
```bash
rabbitmq-plugins enable rabbitmq_mqtt
rabbitmq-plugins enable rabbitmq_web_mqtt  # For WebSocket support
```

Default ports:
- MQTT: 1883
- MQTT over WebSocket: 15675

---

## Testing

### Send Test Event

```bash
echo '{"session_id":"test-123","hook_event_name":"SessionStart","source":"startup","model":"claude-sonnet-4-5-20250929"}' | \
  bun run apps/claude-mqtt-bridge/src/index.ts
```

### Subscribe and Watch

```bash
mosquitto_sub -h localhost -t "claude/progress/#" -v
```

### Verify Event Format

```bash
mosquitto_sub -h localhost -t "claude/progress/#" | jq .
```

---

## Future Enhancements

1. **Context Window Tracking**: Hook scripts could parse the transcript file to estimate token usage
2. **Cost Estimation**: Track model usage and estimate API costs
3. **Performance Metrics**: Measure tool execution times
4. **Alerting**: Send alerts for failures or long-running operations
5. **Historical Storage**: Store events in PostgreSQL for analysis
6. **Grafana Dashboard**: Create dashboard using MQTT data source or via Prometheus metrics

---

## Related Files

- `apps/claude-mqtt-bridge/` - MQTT publisher script
- `.claude/settings.local.json` - Hook configuration
- `apps/project-manager/` - mesh-six Project Manager (subscribes to MQTT)
- `PLAN.md` Section 4.6 - MQTT progress events architecture
