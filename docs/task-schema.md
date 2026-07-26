# TaskReaper Task JSON Schema

This document defines the canonical task format for the TaskReaper ingress API. Any external system (webhook, script, agent, CI pipeline) can use this schema to create tasks in TaskReaper projects.

## Quick Reference

```json
{
  "prompt": "Fix the login button alignment on mobile devices",
  "agent": "cline",
  "state": "pending",
  "orchestrate": true,
  "metadata": {
    "source": "telegram",
    "priority": "high",
    "reported_by": "@username"
  }
}
```

## Schema Definition

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "TaskReaper Task",
  "type": "object",
  "required": ["prompt"],
  "properties": {
    "prompt": {
      "type": "string",
      "minLength": 1,
      "description": "The task description or instruction for the AI coding agent. This is the only required field."
    },
    "agent": {
      "type": "string",
      "enum": ["aider", "cline", "baton-code", "baton-code-thinking"],
      "description": "Which AI agent should execute this task. Defaults to the project's default agent if not specified."
    },
    "state": {
      "type": "string",
      "enum": ["pending", "in_progress", "done", "failed", "stopped"],
      "default": "pending",
      "description": "Initial task state. For ingress, this should always be 'pending' (the default)."
    },
    "orchestrate": {
      "type": "boolean",
      "default": false,
      "description": "Whether this task should be auto-chained when running orchestration. Set to true if this task should automatically trigger the next task in the queue."
    },
    "metadata": {
      "type": "object",
      "additionalProperties": true,
      "description": "Optional custom key-value pairs for tracking task origin, priority, labels, or any other context. Not consumed by TaskReaper core - available for external tooling."
    }
  },
  "additionalProperties": false
}
```

## Field Reference

### `prompt` (required)
The instruction or description for the AI agent. This is what the agent will receive as its task.

**Examples:**
- `"Fix the NPE in UserService.getProfile()"`
- `"Add unit tests for the authentication module"`
- `"Refactor the database connection pooling logic"`

### `agent` (optional)
Which AI coding agent should handle this task.

| Value | Description |
|-------|-------------|
| `aider` | Aider - AI pair programming in terminal |
| `cline` | Cline - AI coding agent |
| `baton-code` | Reaper Code - built-in lightweight agent |
| `baton-code-thinking` | Reaper Code Thinking - reasoning-focused variant |

If omitted, uses the project's default agent configuration.

### `state` (optional, default: `pending`)
The initial state of the task. For ingress endpoints, this should always be `pending`.

| Value | Meaning |
|-------|---------|
| `pending` | Task is queued and waiting |
| `in_progress` | Task is currently being executed |
| `done` | Task completed successfully |
| `failed` | Task execution failed |
| `stopped` | Task was manually cancelled |

### `orchestrate` (optional, default: `false`)
When `true`, this task will be auto-chained during orchestration runs. If you're creating a pipeline of dependent tasks, set this to `true` so each task triggers the next.

### `metadata` (optional)
Free-form key-value pairs for tracking context. Common patterns:

```json
{
  "metadata": {
    "source": "jira",
    "source_id": "PROJ-123",
    "priority": "critical",
    "labels": ["bug", "frontend"],
    "reported_by": "user@example.com",
    "original_url": "https://jira.example.com/browse/PROJ-123"
  }
}
```

## Routing Patterns

External sources (Telegram, Jira, email, GitHub, CI) generally want one of three "lanes" when they file a task. The lane is chosen by combining three fields:

| Field | Default | Effect |
|-------|---------|--------|
| `state` | `pending` | Which column the card lands in. Ingress should always send `pending` (or omit). |
| `orchestrate` | `false` | If `true`, the card lands in the **QUEUE** column instead of **PENDING**. |
| `autostart` (batch-level) | `false` | If `true`, orchestration is triggered immediately after ingest — same effect as a human pressing ▶. Only runs tasks that also have `orchestrate:true`. |

### Lane 1 — Triage (human reviews first)

Best for: crowd-sourced bug reports, low-confidence tickets, Telegram messages from end users.

```json
{
  "prompt": "…bug description…",
  "metadata": { "source": "telegram", "reported_by": "@alice" }
}
```

Card lands in **PENDING**. A person reviews it, optionally edits the prompt / picks an agent, then clicks the → button (or drags) to promote to QUEUE, and presses ▶ to run.

### Lane 2 — Pre-queued (human confirms, then runs)

Best for: trusted sources where a human still wants a chance to say "not now" before spending compute.

```json
{
  "prompt": "…bug description…",
  "agent": "cline",
  "orchestrate": true
}
```

Card lands directly in **QUEUE**. Pressing ▶ runs it.

### Lane 3 — Fire and forget (no human in the loop)

Best for: CI failures, critical Jira tickets, GitHub Actions webhooks. Requires `autostart: true` at the batch level AND `orchestrate: true` on each task that should run immediately.

```json
{
  "autostart": true,
  "tasks": [
    {
      "prompt": "PROJ-456: Fix null pointer in checkout flow",
      "agent": "cline",
      "orchestrate": true,
      "metadata": { "source": "jira", "issue_key": "PROJ-456", "priority": "critical" }
    }
  ]
}
```

Card lands in QUEUE and orchestration starts immediately — the agent begins working as soon as the HTTP response is returned.

**Response includes an `autostart` block** confirming what was triggered:

```json
{
  "success": true,
  "count": 1,
  "tasks_created": [...],
  "autostart": { "triggered": true, "taskIndices": [7] }
}
```

If `autostart:true` is set but no tasks in the batch have `orchestrate:true`, the response reports `{ triggered: false, reason: "No ingested tasks had orchestrate:true" }` — nothing runs. This is a safety fence: an autostart with no orchestrate marker is treated as a triage-lane submission.

## API Usage

### Single Task
```bash
curl -X POST http://localhost:3000/api/projects/my-project/ingest \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Fix the login bug",
    "agent": "cline"
  }'
```

### Multiple Tasks
```bash
curl -X POST http://localhost:3000/api/projects/my-project/ingest \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tasks": [
      {"prompt": "Fix bug A"},
      {"prompt": "Fix bug B", "agent": "aider"},
      {"prompt": "Write tests", "orchestrate": true}
    ]
  }'
```

### Response Format
```json
{
  "success": true,
  "tasks_created": [
    {
      "index": 5,
      "prompt": "Fix the login bug",
      "agent": "cline",
      "state": "pending",
      "orchestrate": false
    }
  ],
  "count": 1
}
```

## Examples by Source

### From a Telegram Bot
```json
{
  "prompt": "Users report the dashboard loads slowly on 3G. Investigate and optimize.",
  "metadata": {
    "source": "telegram",
    "chat_id": "-1001234567890",
    "message_id": 42,
    "reported_by": "@alice"
  }
}
```

### From Jira
```json
{
  "prompt": "PROJ-456: Implement password reset flow. Users should be able to request a reset link via email.",
  "agent": "cline",
  "orchestrate": true,
  "metadata": {
    "source": "jira",
    "issue_key": "PROJ-456",
    "priority": "High",
    "labels": ["feature", "auth"],
    "url": "https://jira.example.com/browse/PROJ-456"
  }
}
```

### From GitHub Issues
```json
{
  "prompt": "github.com/user/repo#142: Memory leak in WebSocket handler. Connection count grows unbounded.",
  "agent": "aider",
  "metadata": {
    "source": "github",
    "repo": "user/repo",
    "issue_number": 142,
    "labels": ["bug", "performance"],
    "url": "https://github.com/user/repo/issues/142"
  }
}
```

### From CI/CD Pipeline
```json
{
  "prompt": "Fix failing tests in build #1234. Tests/auth.test.ts is timing out after 30s.",
  "agent": "baton-code",
  "metadata": {
    "source": "ci",
    "build_number": 1234,
    "branch": "main",
    "commit": "abc123def",
    "url": "https://ci.example.com/builds/1234"
  }
}
```

## Validation Rules

1. `prompt` must be a non-empty string
2. `agent` must be one of the allowed values (if provided)
3. `state` must be one of the allowed values (if provided)
4. Unknown top-level fields will be rejected
5. `metadata` values can be any JSON-serializable type

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-07-03 | Initial schema for v3.3 Ingress |
| 1.1 | 2026-07-03 | Added batch-level `autostart` field and Routing Patterns section (v3.3.1) |
