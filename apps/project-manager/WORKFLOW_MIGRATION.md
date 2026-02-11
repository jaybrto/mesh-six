# Project Manager Workflow Migration

This document describes the migration from in-memory state management to Dapr Workflow for durable project lifecycle management.

## Overview

The Project Manager agent now uses **Dapr Workflow** to manage project state machines. This provides:

- **Durability**: Projects survive pod restarts and failures
- **State Persistence**: All state transitions are automatically persisted by Dapr
- **Event-Driven**: State transitions are driven by external events (signals)
- **Replay Safety**: Workflow determinism ensures correct replay after failures

## Architecture

### Workflow Definition

Located in `apps/project-manager/src/workflow.ts`, the main workflow is `projectWorkflow`.

**Flow:**
1. Consult Architect for guidance
2. Create project (CREATE state)
3. Transition to PLANNING
4. **Main loop**: Wait for `advance` events to transition through states
5. At review gates (REVIEW, DEPLOY, ACCEPTED), evaluate quality
6. Continue until reaching ACCEPTED or FAILED

### State Machine

```
CREATE → PLANNING → REVIEW → IN_PROGRESS → QA → DEPLOY → VALIDATE → ACCEPTED
           ↑          ↓           ↑                   ↓        ↓
           └──────────┘           └───────────────────┴────────┘
```

Valid transitions are encoded in `VALID_TRANSITIONS` map.

### Activities

Workflow activities wrap existing business logic:

- **createProject**: Create GitHub/Gitea issue and project record
- **evaluateGate**: Run review gate evaluation (plan/qa/deployment)
- **transitionState**: Perform state transition and add comment
- **addComment**: Add comment to GitHub/Gitea issue
- **consultArchitect**: Call architect agent for guidance
- **requestResearch**: Call researcher agent for information

## API Changes

### Create Project

**Before:**
```bash
POST /projects
{
  "title": "My Project",
  "description": "...",
  "platform": "github",
  "repoOwner": "owner",
  "repoName": "repo"
}
```

**After:**
Returns workflow instance information:
```json
{
  "success": true,
  "projectId": "uuid",
  "workflowInstanceId": "uuid",
  "workflowStatus": {
    "instanceID": "uuid",
    "runtimeStatus": "RUNNING",
    ...
  }
}
```

### Get Project Status

**Before:**
```bash
GET /projects/{id}
```

**After:**
Returns both workflow status and legacy project data:
```json
{
  "projectId": "uuid",
  "workflowInstanceId": "uuid",
  "workflowStatus": {
    "runtimeStatus": "RUNNING",
    ...
  },
  "legacyProject": { ... }
}
```

### Advance Project

**Before:**
```bash
POST /projects/{id}/advance
{
  "targetState": "REVIEW",
  "context": { ... },
  "reason": "Plan ready for review"
}
```

**After:**
Sends signal to workflow instead of direct transition:
```json
{
  "success": true,
  "projectId": "uuid",
  "workflowInstanceId": "uuid",
  "targetState": "REVIEW",
  "workflowStatus": { ... },
  "message": "Advance signal sent to workflow. Target state: REVIEW"
}
```

## Workflow Events

### Advance Event

Name: `advance`

Payload:
```typescript
{
  targetState: ProjectState;
  context?: Record<string, unknown>;
  reason?: string;
}
```

**Usage:**
```typescript
await advanceProject(
  workflowClient,
  workflowInstanceId,
  "REVIEW",
  { testResultsPath: "/path/to/results.json" },
  "Tests completed successfully"
);
```

## Review Gates

Review gates are evaluated before transitioning to certain states:

### Plan Review Gate
- **Triggered at**: PLANNING → REVIEW
- **Evaluates**: Implementation plan completeness and soundness

### QA Review Gate
- **Triggered at**: QA → DEPLOY
- **Evaluates**: Test results (Playwright JSON parsing)
- **Auto-creates bug issues** if tests fail

### Deployment Review Gate
- **Triggered at**: DEPLOY → ACCEPTED
- **Evaluates**: Deployment health (smoke tests)
- **Checks**: Health endpoints, service availability

## Configuration

Required environment variables remain the same:

```bash
DAPR_HOST=localhost
DAPR_HTTP_PORT=3500
GITHUB_TOKEN=...
GITEA_URL=...
GITEA_TOKEN=...
```

## Backwards Compatibility

The migration maintains backwards compatibility:

1. **In-memory projects map** still exists for legacy queries
2. **Legacy endpoints** continue to work
3. **Activity implementations** update the in-memory map
4. **Gradual migration**: New projects use workflows, old projects still accessible

## Dapr State Store Configuration

Dapr Workflow requires a compatible state store. Supported options:

- Azure Cosmos DB
- AWS DynamoDB
- PostgreSQL (with pgvector)
- Redis
- MongoDB

Configure via Dapr component YAML:

```yaml
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.postgresql
  version: v1
  metadata:
  - name: connectionString
    value: "host=postgres port=5432 user=... password=... dbname=dapr"
```

## Monitoring

### Health Check

```bash
GET /healthz
```

Returns:
```json
{
  "workflowEnabled": true,
  "trackedWorkflows": 5,
  ...
}
```

### Workflow Status Query

```typescript
const status = await getProjectWorkflowStatus(client, instanceId);
// Returns: { runtimeStatus: "RUNNING" | "COMPLETED" | ... }
```

## Troubleshooting

### Workflow Not Starting

1. Check Dapr sidecar is running: `dapr list`
2. Verify state store is configured
3. Check logs for workflow runtime initialization errors

### State Not Persisting

1. Verify Dapr state store component is healthy
2. Check Dapr logs: `kubectl logs <pod> -c daprd`
3. Ensure state store has workflow support

### Workflow Stuck

1. Get workflow status: `GET /projects/{id}`
2. Check `runtimeStatus` - should be "RUNNING"
3. If suspended, check for missing external events
4. View Dapr workflow logs

## Future Enhancements

1. **Child Workflows**: Break down complex projects into sub-workflows
2. **Timeouts**: Add timeout handling for long-running states
3. **Manual Intervention**: Add pause/resume capabilities
4. **Workflow Visualization**: Dashboard showing state machine progress
5. **Metrics**: Expose workflow metrics (state duration, success rate)

## References

- [Dapr Workflow Documentation](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-overview/)
- [Dapr JavaScript SDK Workflow Guide](https://docs.dapr.io/developing-applications/sdks/js/js-workflow/)
- [Workflow API Reference](https://docs.dapr.io/reference/api/workflow_api/)
- [Workflow Features & Concepts](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-features-concepts/)
