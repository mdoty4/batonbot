# LocalChain AI: Visual AI Agent Workflow Orchestrator

LocalChain AI is a local-first workflow orchestrator for chaining prompts, agents, and OpenAI-compatible LLM calls into repeatable pipelines.

## 🚀 Core Concept: From Chatting to Sequencing

Most developers use AI agents (like Cline or Aider) in a linear chat. LocalChain AI moves you to an **assembly line** model:
1.  **Design**: Create a sequence of tasks (prompts).
2.  **Assign**: Choose the best agent for each specific task.
3.  **Start Sequence**: Execute the entire pipeline in one click, with real-time status tracking for every step.

## ✨ Key Features

- **Visual Pipeline Editor**: Drag-and-drop interface to reorder tasks and refine your workflow.
- **Multi-Agent Coordination**: Assign different agents to different steps within a single project sequence.
- **Hybrid LLM Support**: Route requests through local servers (LM Studio) for privacy and cost, or connect to enterprise APIs for maximum intelligence.
- **Real-time Orchestration**: Monitor the state of your pipeline (`Pending`, `Running`, `Done/Failed`) as it executes.
- **Project-Based Management**: Organize different sequences into dedicated projects.
- **Transparent Logging**: Every exchange is captured in JSON format for audit and optimization.

## Why I Built This

I found myself manually coordinating workflows between LM Studio, coding agents, local models, and scripts. Repeating the same multi-step AI tasks became tedious.

LocalChain AI is my attempt to turn those workflows into autonomous pipelines that work across both local and cloud-based models.

---

## 📋 Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Docker Deployment](#docker-deployment)
- [Configuration](#configuration)
- [Using the LocalChain AI](#using-the-localchainai)
- [OpenClaw Integration](#openclaw-integration)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Development](#development)
- [Future Roadmap](#future-roadmap)

---

## 🛠️ Installation

### Prerequisites

- **Node.js** 18+ and npm
- **(Optional) Cline CLI** for Cline agent tasks
- **(Optional) Aider CLI** for Aider agent tasks

### Setup

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/mdoty4/localchainai.git
    cd localchainai
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

4.  **Start the server**:
    ```bash
    npm start
    ```
    The server will start on `http://localhost:4321`.

---

## 🐳 Docker Deployment

Run LocalChain AI in a container with a single command:

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
| `PORT` | `4321` | Port the LocalChain AI server listens on |
| `LM_STUDIO_URL` | `http://localhost:1234/v1` | Base URL for LM Studio API |

### Agent Configuration

Configure your agents through the web UI at **Settings**:

- **LLM Settings**: API base URL, API key, model selection
- **Telegram**: Bot token and chat ID for Telegram agent
- **Per-project overrides**: Each project can have its own LLM configuration

---

## 🎮 Using the LocalChain AI

### 1. Setting up your Agent (e.g., Cline)

To route an agent's requests through the LocalChain AI:
- Set the **API Provider** to `OpenAI Compatible`
- Set the **Base URL** to `http://localhost:4321/`

### 2. Building a Pipeline

- Navigate to the **Projects** tab and activate a project
- In the **Pipeline** editor, add prompt rows
- Assign an agent (Aider or Cline) to each row
- Toggle the "Orchestrate" switch for the tasks you want to include in the sequence

### 3. Executing the Sequence

Click **▶ Start Sequence**. LocalChain AI will execute the selected prompts in order, managing the hand-off between agents and tracking progress in real-time.

---

## 🤖 OpenClaw Integration

LocalChain AI includes a `skill.md` file that allows **OpenClaw** (and other AI agents) to discover and interact with LocalChain AI automatically. By providing the skill file, OpenClaw can:

- **Start, stop, and restart** the LocalChain AI server
- **Create and manage** projects and pipelines
- **Assign agents** and execute orchestration workflows
- **Troubleshoot** failed pipelines and review session logs

To use with OpenClaw, simply point it to the `skill.md` file in the project root. OpenClaw will use the defined workflows and API endpoints to control LocalChain AI programmatically.

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
  "timestamp": "2025-04-27T20:00:00.000Z",
  "version": "1.0.0"
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
localchainai/
├── localchainai.js          # Main server: Express routes, agent orchestration, execution engine
├── app.js                # Additional app logic
├── skill.md              # OpenClaw skill file for agent integration
├── index.html            # Frontend entry point
├── styles.css            # Application styles
├── prompts.json          # Project state, tasks, and configuration storage
├── .env                  # Environment variables (PORT, LM_STUDIO_URL)
├── Dockerfile            # Docker image definition
├── docker-compose.yml    # Docker Compose configuration
├── modules/              # Frontend JavaScript modules
│   ├── chat.js           # Chat interface logic
│   ├── core.js           # Core system operations
│   ├── dom-helpers.js    # DOM manipulation utilities
│   ├── json-viewer.js    # JSON log viewer
│   ├── pipeline.js       # Visual pipeline editor
│   ├── project-editor.js # Project editing UI
│   ├── projects.js       # Project management
│   ├── search.js         # Search functionality
│   ├── sessions.js       # Session management
│   ├── settings.js       # Settings panel
│   └── terminal.js       # Terminal output display
└── logs/                 # Agent exchange logs (JSONL format)
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

## 🎯 Future Roadmap

- [ ] **Enterprise Gateway**: Native support for OpenAI, Anthropic, and Azure API keys.
- [ ] **Template Library**: Shareable "Golden Pipelines" for common development tasks.
- [ ] **Conditional Logic**: Branching pipelines based on the output of a previous step.
- [ ] **MCP Server**: Expose LocalChain AI capabilities as MCP tools for AI agents.

---

## 📄 License

MIT - See [LICENSE](LICENSE) for details.

## 👤 Author

**Michael Doty**
- Email: michaeldoty.pro@gmail.com
- GitHub: [mdoty4](https://github.com/mdoty4)
