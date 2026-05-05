---
name: localchainai
description: >-
  Interact with LocalChain AI, the visual AI agent workflow orchestrator.
  Use when Michael asks about: starting or stopping the LocalChain AI server,
  managing projects or tasks, creating pipelines, assigning agents (Cline/Aider),
  checking API endpoints, configuring LocalChain AI via .env or web UI,
  troubleshooting pipeline execution, or anything related to multi-agent
  orchestration and hybrid LLM routing.
---

# LocalChain AI Skill

## Quick Reference

| Detail | Value |
|--------|-------|
| **Project Root** | `` |
| **Local Port** | `4321` |
| **Web UI** | `http://localhost:4321` |
| **API Base** | `http://localhost:4321/api` |
| **State File** | `prompts.json` |
| **Logs Dir** | `logs/` (JSONL format) |

> **Important**: Always `cd` to the project root before running npm commands.
> Docker is not used — run the server directly via npm.

---

## Server Management

### Start / Stop / Restart

| Action | Command |
|--------|---------|
| Start (production) | `cd /project/location && npm start` |
| Start (dev + hot-reload) | `cd /project/location && npm run dev` |
| Check if running | `lsof -i :4321` |
| Kill server | `lsof -ti :4321 \| xargs kill` |

### Health Check

```bash
curl http://localhost:4321/health
```

Expected response:
```json
{
  "status": "ok",
  "uptime": 1234.56,
  "timestamp": "2026-04-27T20:00:00.000Z",
  "version": "1.0.0"
}
```

---

## Configuration

### Environment Variables (`.env`)

The `.env` file controls server configuration:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4321` | Port the server listens on |
| `LM_STUDIO_URL` | `http://localhost:1234/v1` | Base URL for LM Studio API |

> **Gotcha**: If the server won't start, check for port conflicts with `lsof -i :4321`.

### LLM / Agent Settings

Configured via the Web UI at `http://localhost:4321` → **Settings** tab, or via the `/api/config` endpoint:

- **LLM Settings**: API base URL, API key, model selection
- **Telegram**: Bot token and chat ID
- **Per-project overrides**: Each project can have its own LLM configuration

---

## API Reference

All endpoints are relative to `http://localhost:4321`.

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health, uptime, version |

### Projects

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects` | List all projects + active project |
| `POST` | `/api/projects` | Create a new project |
| `PUT` | `/api/projects/:id` | Update an existing project |
| `DELETE` | `/api/projects/:id` | Delete a project |
| `POST` | `/api/projects/active` | Set the active project |

**Create project example:**
```bash
curl -X POST http://localhost:4321/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"My Project","workingDirectory":"../my-project"}'
```

### Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/project/:id/tasks` | Get tasks for a project |
| `POST` | `/api/project/:id/tasks` | Update tasks for a project |
| `POST` | `/api/project/:id/tasks/orchestrate` | Start orchestration with selected tasks |
| `POST` | `/api/project/:id/tasks/reset` | Reset all task states to pending |
| `POST` | `/api/project/:id/tasks/cancel` | Cancel running orchestration |
| `GET` | `/api/project/:id/tasks/stream` | SSE stream for real-time events |

**Start orchestration example:**
```bash
curl -X POST http://localhost:4321/api/project/:id/tasks/orchestrate \
  -H "Content-Type: application/json" \
  -d '{"taskIndices":[0,1,2]}'
```

### Agent Triggers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/project/:id/tasks/:taskIndex/send` | Send task to configured agent |
| `POST` | `/api/project/:id/tasks/:taskIndex/aider` | Send task specifically to Aider |
| `POST` | `/api/project/:id/tasks/:taskIndex/init` | Initialize git in working directory |

### Chat & LLM

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/chat` | Stream response from configured LLM (SSE) |
| `POST` | `/api/cline/headless` | Run Cline CLI headless with streaming (SSE) |

### Configuration

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/config` | Get current Aider and Telegram config |
| `POST` | `/api/config` | Save Aider and Telegram config |
| `POST` | `/api/telegram/test` | Send a test message via Telegram |

### Logs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/logs` | List all log sessions |
| `GET` | `/api/logs/:id` | Get events for a specific log session |
| `DELETE` | `/api/logs/:id` | Delete a specific log |
| `POST` | `/api/logs/bulk-delete` | Delete multiple logs at once |

### Proxy Status

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/proxy/status` | Check if LM Studio is reachable |
| `GET` | `/api/status` | Check proxy/LM Studio status |

### LLM Proxy

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/chat/completions` | Proxy for OpenAI-compatible chat completions |

---

## Workflows

### Workflow 1: Create a New Project & Pipeline

1. **Verify server is running:**
   ```bash
   curl http://localhost:4321/health
   ```

2. **Create a project** (set `workingDirectory` to the target project, never the LocalChain AI dir itself):
   ```bash
   curl -X POST http://localhost:4321/api/projects \
     -H "Content-Type: application/json" \
     -d '{"name":"My Project","workingDirectory":"../target-project"}'
   ```

3. **Set it as active:**
   ```bash
   curl -X POST http://localhost:4321/api/projects/active \
     -H "Content-Type: application/json" \
     -d '{"projectId":"<the-id-from-step-2>"}'
   ```

4. **Add pipeline tasks** via the Web UI (`http://localhost:4321` → Pipeline tab) or API:
   - Add prompt rows
   - Assign agents (`cline` or `aider`) to each row
   - Toggle "Orchestrate" for tasks to include in the sequence

5. **Execute** via the Web UI (▶ Start Sequence) or API:
   ```bash
   curl -X POST http://localhost:4321/api/project/:id/tasks/orchestrate \
     -H "Content-Type: application/json" \
     -d '{"taskIndices":[0,1,2]}'
   ```

### Workflow 2: Troubleshoot a Failed Pipeline

1. **Check server status:**
   ```bash
   curl http://localhost:4321/health
   ```

2. **Check current task states:**
   ```bash
   curl http://localhost:4321/api/project/:id/tasks
   ```

3. **Review session logs** — logs live in `logs/` directory, named:
   ```
   {projectTitle}_{agent}_task_{index}_{timestamp}.json
   ```
   Example: `myproject_cline_task_0_2026-04-27T02-22-13.json`

4. **Check for common issues:**
   - Port conflict: `lsof -i :4321`
   - Invalid LLM API keys in Settings
   - Working directory points to LocalChain AI itself (blocked by safety check)
   - Cline/Aider CLI not installed or not in PATH

5. **Reset tasks and retry:**
   ```bash
   curl -X POST http://localhost:4321/api/project/:id/tasks/reset
   ```

### Workflow 3: Configure an Agent

1. **Open Settings** at `http://localhost:4321` → Settings tab
2. **LLM tab**: Set API base URL, API key, model
3. **Telegram tab** (optional): Set bot token and chat ID
4. **Per-project**: Each project can override global LLM settings

---

## Supported Agents

| Agent | Type | How it runs |
|-------|------|-------------|
| **Cline** | CLI | Spawns `cline --json -y "<prompt>"` as a child process |
| **Aider** | CLI | Spawns `aider --yes-always --message "<prompt>"` as a child process |
| **Telegram** | HTTP | Sends prompt via Telegram Bot API |

### Agent Requirements

- **Cline**: `cline` CLI must be installed and in PATH
- **Aider**: `aider` CLI must be installed and in PATH, LLM config via Settings
- **Telegram**: Bot token and chat ID configured in Settings

---

## File Structure

```
localchainaiv2/
├── .env                    # Environment variables (PORT, LM_STUDIO_URL)
├── localchainai.js                # Main server: Express routes, orchestration engine
├── prompts.json            # Project state, tasks, agent config, execution state
├── app.js                  # Additional app logic
├── index.html              # Frontend entry point
├── styles.css              # Application styles
├── modules/                # Frontend JavaScript modules
│   ├── chat.js             # Chat interface
│   ├── core.js             # Core system operations
│   ├── pipeline.js         # Visual pipeline editor
│   ├── projects.js         # Project management
│   ├── settings.js         # Settings panel
│   ├── terminal.js         # Terminal output display
│   └── ...
└── logs/                   # Agent session logs (JSONL format)
```

### Key Files

- **`prompts.json`** — Primary state file. Stores all projects, tasks, agent assignments, and execution state. Back this up before major changes.
- **`logs/*.json`** — Session logs in JSONL format (one JSON object per line). Safe to delete individually.
- **`.env`** — Server configuration. Changes require a server restart.

---

## Common Pitfalls

| Problem | Fix |
|---------|-----|
| **Port 4321 already in use** | `lsof -ti :4321 \| xargs kill` then restart |
| **Agent fails silently** | Check LLM API keys in Settings; verify CLI is in PATH |
| **Working directory blocked** | LocalChain AI prevents agents from editing its own code. Set `workingDirectory` to a sibling/child directory, never `localchainaiv2` itself |
| **Tasks don't auto-chain** | Only tasks with `orchestrate: true` auto-trigger the next task. Manual "Send" clicks do not chain |
| **Cline edits files after completion** | LocalChain AI uses a quiet-period detector (5s) to wait for file activity to settle before triggering the next task |
| **Server not responding** | Check `npm start` output for errors; verify `.env` has correct `PORT` |

---

## Quick Commands Cheat Sheet

```bash
# Navigate to project
cd /Users/michaeldoty/dev/preprod/localchainaiv2

# Start server
npm start

# Start with hot-reload
npm run dev

# Check if server is running
curl http://localhost:4321/health

# Check port conflict
lsof -i :4321

# Kill server on port 4321
lsof -ti :4321 | xargs kill

# List all projects
curl http://localhost:4321/api/projects

# List all log sessions
curl http://localhost:4321/api/logs

# View latest log (from project root)
cat logs/$(ls -t logs/ | head -1)