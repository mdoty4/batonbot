# BatonBot: Visual AI Agent Workflow Orchestrator

BatonBot is a local-first workflow orchestrator for chaining prompts, agents, and OpenAI-compatible LLM calls into repeatable pipelines.

## 🚀 Core Concept: From Chatting to Sequencing

Most developers use AI agents (like Cline or Aider) in a linear chat. BatonBot moves you to an **assembly line** model:
1.  **Design**: Create a sequence of tasks (prompts).
2.  **Assign**: Choose the best agent for each specific task.
3.  **Start Sequence**: Execute the entire pipeline in one click, with real-time status tracking for every step.

## ✨ Key Features

- **Kanban Task Board**: Drag-and-drop board with `Pending`, `Queue`, and `Completed` columns — drop cards from the agent palette and reorder the queue to shape your sequence. (A linear Pipeline editor view is also available.)
- **Native + External Agents**: First-class native agents (`baton-code`, `baton-code-thinking`) plus support for **Aider**, **Cline**, and **Telegram** as routable agents within a single project sequence.
- **Hybrid LLM Support**: Route requests through local servers (LM Studio) for privacy and cost, or connect to enterprise APIs for maximum intelligence.
- **Real-time Orchestration**: Monitor live task state (`pending`, `in_progress`, `planning`, `done`, `failed`, `stopped`) via SSE, with **Play / Pause / Cancel** controls on the board.
- **Project-Based Management**: Organize different sequences into dedicated projects, each with its own working directory and optional LLM overrides.
- **Built-in Chat**: A chat panel for ad-hoc interaction with the configured LLM, independent of the pipeline.
- **Transparent Logging**: Every exchange is captured in JSON format for audit and optimization.

<img width="1458" height="879" alt="Screenshot 2026-06-21 at 3 43 36 PM" src="https://github.com/user-attachments/assets/51459b66-8be3-4406-affa-caa34d85ce2f" />



## 🧭 Platform Support Matrix (v3.2.2)

BatonBot runs on macOS, Linux, and Windows from a single codebase. As of
v3.2.2, all bundled agents work across all three platforms:

| Agent                  | macOS  | Windows | Linux*  |
|------------------------|--------|---------|---------|
| Baton Code             | ✅      | ✅       | ✅       |
| Baton Code (Thinking)  | ✅      | ✅       | ✅       |
| Cline                  | ✅      | ✅       | ✅       |
| Aider                  | ✅      | ✅       | ✅       |
| Telegram               | ✅      | ✅       | ✅       |

*Linux is expected to work but is less actively tested than macOS/Windows.

**Cline on Windows — fixed in v3.2.2.** Earlier releases (v3.1.x) had a
silent-hang issue where `cline.cmd` produced no stdout/stderr inside the
BatonBot child process on Windows. Root cause: Node's default open stdin
pipe blocked Cline's first-call init forever. `spawnCompat()` now uses
`stdio: ['ignore', 'pipe', 'pipe']` (the Node equivalent of `< nul`), and
Cline runs cleanly on Windows 10/11. See the
[v3.2.2 release notes](https://github.com/mdoty4/batonbot/releases/tag/v3.2.2)
for the technical write-up.

Regardless of platform, the **Baton Code** and **Baton Code (Thinking)**
agents remain the fastest way to get started — they're HTTP-based and
require no external CLI installation.


## Why I Built This

I found myself manually coordinating workflows between LM Studio, coding agents, local models, and scripts. Repeating the same multi-step AI tasks became tedious.

BatonBot is my attempt to turn those workflows into autonomous pipelines that work across both local and cloud-based models.

---

## 📋 Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Docker Deployment](#docker-deployment)
- [Configuration](#configuration)
- [Using BatonBot](#using-batonbot)
- [OpenClaw Integration](#openclaw-integration)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Development](#development)
- [Roadmap](#roadmap)

---

## 🛠️ Installation

Two options: **portable** (no install, download & double-click) or **from source**.

### Option A — Portable (no install required)

Download the pre-packaged bundle from the [Releases page](https://github.com/mdoty4/batonbot/releases), unzip, double-click. No Node, no npm, no git required.

| Platform          | Bundle                                        | Status         |
|-------------------|-----------------------------------------------|----------------|
| Windows x64       | `batonbot-portable-win-x64.zip` → `start.cmd` | ✅ v3.2.2       |
| macOS Apple Silicon (arm64) | `batonbot-portable-mac-arm64.zip` → `start.command` | ✅ v3.2.3 |
| macOS Intel (x64) | —                                             | Planned         |
| Linux             | —                                             | Planned         |

All settings, projects, and logs live in a `config/` folder next to the launcher — delete the folder to uninstall cleanly.

> **macOS first-launch note:** Because the bundle isn't Apple-notarized yet, Gatekeeper will block `start.command` the first time. Right-click → **Open** → **Open** in the dialog. macOS remembers your choice; from then on double-click works normally. Or run `xattr -dr com.apple.quarantine .` inside the unzipped folder once.

> **Windows first-launch note:** SmartScreen may warn ("Windows protected your PC"). Click **More info** → **Run anyway**. Bundles are not code-signed yet.

### Option B — From source (all platforms)

**Prerequisites**

- **Node.js** 18+ and npm
- **Git** (must be on `PATH`)
- **(Optional) Cline CLI** for Cline agent tasks
- **(Optional) Aider CLI** for Aider agent tasks

> **Cross-platform**: BatonBot runs on **macOS, Linux, and Windows** from a single codebase. Platform-specific differences (process spawning, child-tree termination) are handled internally via `process.platform` detection — no separate Windows build required.


### Windows-specific notes

BatonBot works natively on Windows 10 / 11 with PowerShell or cmd. A few things to know:

- **Agent CLIs must be on `PATH`.** `cline`, `aider`, and `git` are installed as `.cmd` shims on Windows; BatonBot detects Windows and spawns through `cmd.exe` automatically so the shims resolve correctly.
- **Creating `.env`**: PowerShell users can run `New-Item .env` or just create the file in VS Code.
- **`test_api.sh` / `verify_isolation.sh`** are bash scripts — run them from **Git Bash** or **WSL** if you need them. The app itself does not depend on these scripts.
- **WSL2** is fully supported and recommended if you want the macOS/Linux experience. Inside WSL, BatonBot behaves exactly like it does on Linux.
- **Working directories**: Use forward slashes or escaped backslashes in project working directories (e.g. `C:/Users/you/projects/foo` or `C:\\Users\\you\\projects\\foo`). Node's `path` module handles either form correctly.
- **Long paths**: If your project is deeply nested, enable Windows long-path support (`git config --system core.longpaths true`) to avoid `ENAMETOOLONG` errors.
- **Antivirus**: Real-time AV can slow down `npm install` and child-process spawning significantly. Consider whitelisting your project folder if you see sluggish behavior.


### Setup

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/mdoty4/batonbot.git
    cd batonbot
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    ```

3.  **Configure environment variables**:
    Create a `.env` file in the root directory:
    ```env
    PORT=4321
    LM_STUDIO_URL=http://localhost:1234/v1
    ```

4.  **Initialize project state**:
    ```bash
    cp prompts.json.example prompts.json
    ```

5.  **Start the server**:
    ```bash
    npm start
    ```
    The server will start on `http://localhost:4321`.

---

## 🐳 Docker Deployment

Run BatonBot in a container with a single command:

```bash
docker compose up --build -d
```

The server will be available at `http://localhost:4321`.

### Docker Notes

- Logs are persisted in the `./logs` directory on the host
- The `.env` file is mounted read-only into the container
- A health check is configured at `/health`
- **Agent CLI tools** (cline, aider) must be available inside the container for agent tasks to execute. For UI-only usage the container works as-is.

### Docker Commands

```bash
# Start in background
docker compose up -d

# Stop
docker compose down

# Rebuild and start
docker compose up --build -d

# View logs
docker compose logs -f

# Remove container and volumes
docker compose down -v
```

---

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4321` | Port the BatonBot server listens on |
| `LM_STUDIO_URL` | `http://localhost:1234/v1` | Base URL for LM Studio API |

### Agent Configuration

Configure your agents through the web UI at **Settings**:

- **LLM Settings**: API base URL, API key, model selection
- **Telegram**: Bot token and chat ID for Telegram agent
- **Per-project overrides**: Each project can have its own LLM configuration

---

## 🎮 Using BatonBot

### 1. Setting up your Agent (e.g., Cline)

To route an agent's requests through BatonBot:
- Set the **API Provider** to `OpenAI Compatible`
- Set the **Base URL** to `http://localhost:4321/v1`

### 2. Building a Sequence (Board or Pipeline view)

- Navigate to the **Projects** tab and activate a project
- Open the **Board** (Kanban) view — add cards from the agent palette and drag them between `Pending`, `Queue`, and `Completed` columns; reorder cards within the Queue to set execution order
- Or use the **Pipeline** editor view to add prompt rows linearly
- Assign an agent to each card/row. Available agents:
  - `baton-code` — native BatonBot agent
  - `baton-code-thinking` — native BatonBot agent with chain-of-thought planning
  - `aider` — external Aider CLI
  - `cline` — external Cline CLI
  - `telegram` — sends the prompt as a Telegram message
- Click a card to open the detail drawer for prompt editing and per-task history

### 3. Executing the Sequence

Click **▶ Start Sequence** (or the Play button on the board). BatonBot will execute queued tasks in order, managing the hand-off between agents and emitting live SSE state updates (`pending` → `planning` → `in_progress` → `done` / `failed` / `stopped`). Use **Pause** to stop after the current task settles, or **Cancel** to terminate immediately.

---

## 🤖 OpenClaw Integration

BatonBot includes a `skill.md` file that allows **OpenClaw** (and other AI agents) to discover and interact with BatonBot automatically. By providing the skill file, OpenClaw can:

- **Start, stop, and restart** the BatonBot server
- **Create and manage** projects and pipelines
- **Assign agents** and execute orchestration workflows
- **Troubleshoot** failed pipelines and review session logs

To use with OpenClaw, simply point it to the `skill.md` file in the project root. OpenClaw will use the defined workflows and API endpoints to control BatonBot programmatically.

---

## 🔌 API Reference

Base URL: `http://localhost:4321`

### Health Check

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health status with uptime and version |

**Response:**
```json
{
  "status": "ok",
  "uptime": 1234.56,
  "timestamp": "2026-05-16T18:00:00.000Z",
  "version": "2.1.0"
}
```

### Project Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects` | List all projects and active project |
| `POST` | `/api/projects` | Create a new project |
| `PUT` | `/api/projects/:id` | Update an existing project |
| `DELETE` | `/api/projects/:id` | Delete a project |
| `POST` | `/api/projects/active` | Set the active project |

**Create Project Request:**
```json
{
  "name": "My Project",
  "workingDirectory": "../my-project",
  "aiderConfig": { }
}
```

### Task Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/project/:id/tasks` | Get tasks for a project |
| `POST` | `/api/project/:id/tasks` | Update tasks for a project |
| `POST` | `/api/project/:id/tasks/orchestrate` | Start orchestration with selected tasks |
| `POST` | `/api/project/:id/tasks/reset` | Reset all task states to pending |
| `POST` | `/api/project/:id/tasks/cancel` | Cancel running orchestration |
| `POST` | `/api/project/:id/tasks/pause` | Pause after the current task settles |
| `GET` | `/api/project/:id/tasks/stream` | SSE stream for real-time orchestration events |

**Orchestrate Request:**
```json
{
  "taskIndices": [0, 1, 2]
}
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
| `POST` | `/api/chat` | Stream a response from the configured LLM (SSE) |
| `POST` | `/api/cline/headless` | Run Cline CLI in headless mode with streaming (SSE) |

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

## 🗺️ Project Structure

```
batonbot/
├── batonbot.js              # Main server: Express routes, agent orchestration, execution engine
├── app.js                   # Shared global state + frontend module load order
├── skill.md                 # OpenClaw skill file for agent integration
├── index.html               # Frontend entry point
├── styles.css               # Application styles
├── board.css                # Kanban board styles
├── prompts.json.example     # Template for initial project state (copy to prompts.json)
├── prompts.json             # Project state, tasks, and configuration storage (gitignored)
├── .env                     # Environment variables (PORT, LM_STUDIO_URL)
├── Dockerfile               # Docker image definition
├── docker-compose.yml       # Docker Compose configuration
├── docker/                  # Docker support files
├── modules/                 # Frontend JavaScript modules + backend agent runtime
│   ├── board.js             # Kanban task board (Pending / Queue / Completed)
│   ├── chat.js              # Chat interface logic
│   ├── core.js              # App init, tabs, proxy polling
│   ├── dom-helpers.js       # DOM manipulation utilities
│   ├── json-viewer.js       # JSON log viewer
│   ├── micro-agents.js      # Backend agent runtime (callLLM, tree-kill, agent loops)
│   ├── pipeline.js          # Linear pipeline editor view
│   ├── project-editor.js    # Project editing UI
│   ├── projects.js          # Project management
│   ├── search.js            # Search/filter across views
│   ├── sessions.js          # Session loading and viewing
│   ├── settings.js          # Settings panel
│   ├── terminal.js          # Terminal panel + SSE log stream
│   ├── theme.js             # Theme switching
│   └── agents/              # Native agent definitions
│       ├── baton-code.js
│       └── baton-code-thinking.js
└── logs/                    # Agent exchange logs (JSONL format)
```

---

## 👩‍💻 Development

### Development Mode

Auto-restart on code changes with nodemon:

```bash
npm run dev
```

### File Format

- **`prompts.json`**: Stores all projects, tasks, agent config, and execution state
- **`logs/*.json`**: Agent session logs in JSONL format (one JSON object per line)

### Session ID Format

Session logs follow the pattern:
```
{projectTitle}_{agentName}_task_{taskIndex}_{timestamp}.json
```

Example: `testbench_cline_task_0_2026-04-27T02-22-13.json`

---

## 📦 Building the Portable Bundle

BatonBot can be packaged as a "no-install" portable bundle: a folder containing
a pinned Node binary, the app, prod-only `node_modules`, and a
double-clickable launcher. End users unzip and double-click — no Node, no
npm, no git required. See [Installation → Portable](#option-a--portable-no-install-required)
for the end-user quick start.

**Build a bundle from source (from any OS with Node + npm):**

```bash
# Windows x64 (bundled node.exe + start.cmd)
npm run build:portable:win

# macOS Apple Silicon (bundled node arm64 + start.command)
npm run build:portable:mac
```

Output:

- `dist/batonbot-portable-win-x64/` + `.zip`
- `dist/batonbot-portable-mac-arm64/` + `.zip`

The bundled app reads/writes all mutable state (`prompts.json`, `logs/`, `.env`)
from the `config/` folder next to the launcher, controlled by the
`BATONBOT_CONFIG_DIR` env var. Existing dev workflows (`npm start` from the
repo) continue to use `./prompts.json` and `./logs/` as before — the var
defaults to `__dirname` when unset.

Shared build helpers live in `scripts/build-portable/common.js`; per-platform
scripts (`build-win.js`, `build-mac.js`) handle the Node download and
platform-specific launcher/README generation.


---

## 🗺️ Roadmap


See [ROADMAP.md](./ROADMAP.md) for what's coming — v3.2.2 (Windows portable) and v3.2.3 (macOS arm64 portable) have shipped; v3.3 (generic ingress) is next.

---

## 📄 License

MIT - See [LICENSE](LICENSE) for details.

## 👤 Author

**Michael Doty**
- Email: michaeldoty.pro@gmail.com
- GitHub: [mdoty4](https://github.com/mdoty4)
