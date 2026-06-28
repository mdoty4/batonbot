# BatonBot Roadmap

BatonBot is a local-first kanban orchestrator for AI coding agents. This roadmap captures the direction — items may shift as we learn. Open an issue if something looks wrong-ordered for you.

**Vision:** A tool that is useful both to a developer interactively (kanban board, drag-and-drop pipelines) and to other programs and agents that call into it via API. Local-first, OpenAI-compatible-endpoint agnostic, runs against any local or cloud model.

---

## Now — v3.2 "Portable" *(in progress)*

**Headline:** Download, unzip, double-click. No git, no npm, no Python required.

- Portable Windows ZIP build with bundled Node.js runtime
- Config folder lives next to the executable (`prompts.json`, `.env`, `logs/`)
- macOS + Linux portable variants
- README install-first rewrite + 30-second install GIF
- Launch announcement post (HN, r/LocalLLaMA, X)

---

## Next — v3.3 "Ingress"

**Headline:** Anything can drop a task into BatonBot — webhooks, files, scripts, other agents.

- Generic ingress webhook: `POST /api/projects/:id/ingest`
- File-based ingress: drop a `*.task.md` or `*.task.json` in `.batonbot/inbox/`
- Documented JSON Schema for the task format (`docs/task-schema.md`)
- Per-project bearer-token auth for the ingress endpoint
- Manual import UI for one-off bulk imports

---

## Later

Headlines only. Items inside each will be detailed as we get closer.

- **v3.4 — Local-First + Outputs.** Strict local-only mode. Per-card results written as Markdown + JSON in the project's repo.
- **v3.5 — Trust & Isolation.** Per-card git worktrees with diff / merge / discard. `ask_user` tool. Approval gates. Restart recovery.
- **v3.6 — GitHub Loop.** Issue → triage → fix → PR, end to end, via a GitHub App.
- **v3.6.1+ — Native Specialists.** `baton-summarizer`, `baton-docs-writer`, `baton-test-writer`, `baton-search`, plus a `baton-moltbook-poster` agent for the agent social network.
- **v3.7 — Mission Control.** Multi-project dashboard. Cost telemetry. Pipeline templates.
- **v3.8 — Open Substrate.** MCP server. Auto-routing rules. Additional ingress adapters (Linear, Email, Slack, Jira, Moltbook).
- **v3.9 — Machine Substrate.** API tokens. Outbound webhooks. OpenAPI spec. Headless mode.
- **v3.10 — Maturity.** Per-repo `BATONBOT.md` policy file. Architecture docs. Public comparison docs.

---

## Eventually — v4.0 "Beyond Code"

When BatonBot has clear traction in the coding niche, we'll broaden into general AI workflow agents (research, writing, monitoring). Not before — the dev story comes first.

---

## How this document changes

This roadmap is a living document. Items get reordered, deferred, or cut as we learn what users actually need. Each release ships with its own announcement when it lands.

Questions, suggestions, or feature requests? Open an issue or start a discussion on GitHub.
