# Claude Code Progress UI Guide

This document explains how to build a real-time UI for monitoring Claude Code sessions using MQTT events published by the `@mesh-six/claude-mqtt-bridge`.

## Overview

```
┌─────────────────┐             ┌─────────────────┐    WebSocket    ┌─────────────────┐
│  Claude Code    │──── MQTT ──▶│   RabbitMQ      │────────────────▶│   Progress UI   │
│  + Hooks        │             │   MQTT Plugin   │                  │   (Browser)     │
│                 │             └─────────────────┘                  └─────────────────┘
│                 │──── Local ──▶ $CLAUDE_PROJECT_DIR/.claude/claude-events.db (SQLite)
└─────────────────┘
```

Claude Code hooks publish events via two paths:
1. **SQLite (local, always-on)**: Every event is stored to `$CLAUDE_PROJECT_DIR/.claude/claude-events.db` for local querying. Zero network dependency, concurrent-safe via WAL mode.
2. **MQTT (cluster, optional)**: Events are published to RabbitMQ MQTT topics for real-time dashboards. Fails silently when the broker is unreachable (expected during local development).

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

## Local Development (SQLite)

When running Claude Code locally (outside k8s), all hook events are automatically stored to a SQLite database at `$CLAUDE_PROJECT_DIR/.claude/claude-events.db`. No configuration needed — it works out of the box.

### Querying Events

```bash
# Count all events
sqlite3 $CLAUDE_PROJECT_DIR/.claude/claude-events.db "SELECT COUNT(*) FROM claude_events"

# List sessions with event counts
sqlite3 -header -column $CLAUDE_PROJECT_DIR/.claude/claude-events.db "
  SELECT session_id, MIN(datetime(timestamp/1000, 'unixepoch', 'localtime')) as started,
         COUNT(*) as events, COUNT(DISTINCT tool_name) as tools_used
  FROM claude_events GROUP BY session_id ORDER BY started DESC LIMIT 10
"

# Tool usage breakdown for current session
sqlite3 -header -column $CLAUDE_PROJECT_DIR/.claude/claude-events.db "
  SELECT tool_name, COUNT(*) as uses, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failures
  FROM claude_events WHERE tool_name IS NOT NULL
  GROUP BY tool_name ORDER BY uses DESC
"

# View errors
sqlite3 -header -column $CLAUDE_PROJECT_DIR/.claude/claude-events.db "
  SELECT datetime(timestamp/1000, 'unixepoch', 'localtime') as ts, tool_name, error
  FROM claude_events WHERE event = 'PostToolUseFailure' ORDER BY timestamp DESC LIMIT 20
"

# Subagent activity
sqlite3 -header -column $CLAUDE_PROJECT_DIR/.claude/claude-events.db "
  SELECT datetime(timestamp/1000, 'unixepoch', 'localtime') as ts, event, agent_type, agent_id
  FROM claude_events WHERE agent_type IS NOT NULL ORDER BY timestamp DESC LIMIT 20
"

# Purge events older than 7 days
sqlite3 $CLAUDE_PROJECT_DIR/.claude/claude-events.db "
  DELETE FROM claude_events WHERE timestamp < (strftime('%s','now','-7 days') * 1000)
"
```

### SQLite Schema

```sql
CREATE TABLE claude_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,       -- Unix ms
  session_id TEXT NOT NULL,
  event TEXT NOT NULL,              -- SessionStart, PreToolUse, PostToolUse, etc.
  status TEXT NOT NULL,             -- started, pending, completed, failed, ended
  git_branch TEXT,
  worktree_path TEXT,
  model TEXT,
  job_id TEXT,
  tool_name TEXT,                   -- Bash, Write, Edit, Read, etc.
  error TEXT,
  agent_id TEXT,
  agent_type TEXT,
  payload TEXT NOT NULL             -- Full JSON event
);
-- Indexes on (session_id, timestamp), (event, timestamp), (tool_name)
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
| `SQLITE_DB_PATH` | `$CLAUDE_PROJECT_DIR/.claude/claude-events.db` | SQLite database path for local storage |
| `SQLITE_DISABLED` | `false` | Set `true` to skip SQLite storage |
| `JOB_ID` | (none) | mesh-six job ID for project linking |
| `GIT_BRANCH` | (auto-detect) | Override git branch |
| `WORKTREE_PATH` | (auto-detect) | Override worktree path |
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
3. **Performance Metrics**: Measure tool execution times from SQLite data
4. **Alerting**: Send alerts for failures or long-running operations
5. **Grafana Dashboard**: Create dashboard using MQTT data source or via Prometheus metrics
6. **SQLite → PostgreSQL sync**: Batch-upload local SQLite events to cluster PostgreSQL for cross-machine analysis

---

## Related Files

- `apps/claude-mqtt-bridge/` - MQTT publisher script
- `.claude/settings.local.json` - Hook configuration
- `apps/project-manager/` - mesh-six Project Manager (subscribes to MQTT)
- `PLAN.md` Section 4.6 - MQTT progress events architecture
