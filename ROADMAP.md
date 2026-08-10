# BatonBot Roadmap

BatonBot is a local-first kanban orchestrator for AI coding agents. This roadmap captures the direction — items may shift as we learn. Open an issue if something looks wrong-ordered for you.

**Vision:** A tool that is useful both to a developer interactively (kanban board, drag-and-drop pipelines) and to other programs and agents that call into it via API. Local-first, OpenAI-compatible-endpoint agnostic, runs against any local or cloud model.

---

## v3.2 "Portable" *(shipped)*

**Headline:** Download, unzip, double-click. No git, no npm, no Python required.

- [x] Portable Windows ZIP build with bundled Node.js runtime (**v3.2.2**)
- [x] Config folder lives next to the executable (`prompts.json`, `.env`, `logs/`)
- [x] Windows Cline `stdin`-hang bug fixed — Cline now works cleanly on Windows 10/11 (**v3.2.2**)
- [x] macOS Apple Silicon (arm64) portable variant with `start.command` launcher (**v3.2.3**)
- [x] README install-first rewrite (portable listed as Option A)

---

## v3.3 "Ingress" *(shipped)*

**Headline:** Anything can drop a task into BatonBot — webhooks, files, scripts, other agents.

- [x] Generic ingress webhook: `POST /api/projects/:id/ingest`
- [x] Documented JSON Schema for the task format (`docs/task-schema.md`)
- [x] Per-project bearer-token auth for the ingress endpoint

---

## v3.4 "Design Partner / Trust Hardening" *(shipped)*

**Headline:** The Jira channel — pulled forward from v3.8 because a real team wanted it — plus the safety guards that make it trustworthy against a live project.

- [x] Jira polling channel: tickets → cards, label routing (`fix-now` auto-runs, `queue` queues), no webhook/tunnel needed (`docs/jira-setup.md`)
- [x] **Assignee guard** — human-assigned tickets are never imported; optional bot-account (assign-to-bot workflow)
- [x] **Autostart cap** — max N fire-and-forget runs per poll (default 3); extras queue for a human ▶
- [x] **First-run watermark** — enabling Jira never floods the board with pre-existing backlog
- [x] **Full lifecycle comments back to Jira** — pickup, queue moves, ✅ completion, ❌ failure (idempotent)
- [x] **Clear failure reasons on cards** — including the friendly "Couldn't reach the LLM… Is LM Studio running?" translation
- [x] **Delete → reimport escape hatch** — deleting a Jira card lets the next sync re-import the ticket
- [x] **Auto-transition to Done** — completed tasks move their Jira ticket to Done (category-matched, works with any workflow; toggleable)
- Known limitations documented in `docs/jira-setup.md` (no re-sync of edited tickets, one-way channel, etc.)

---

## Now — v3.5 "Local-First + Outputs"

**Headline:** Run the whole loop on a local model with zero cloud calls, and get durable, machine-readable results out of every card.

- [ ] **Strict Local-Only Mode** (`BATONBOT_LOCAL_ONLY=1`) — hard-fail any request that would leave the machine
- [ ] **Results-Out** — each completed card writes `results/<cardId>.result.json` + `.result.md` into the project's repo
- [ ] **Previous-task context for Cline/Aider** — chained cards can see what the prior card did

---

## Carried Forward

Items announced in earlier releases that haven't shipped yet. They're still planned — just not committed to a specific release.

- [ ] macOS Intel (x64) portable variant *(from v3.2)*
- [ ] Linux portable variant *(from v3.2)*
- [ ] 30-second install GIF *(from v3.2)*
- [ ] Launch announcement post — HN, r/LocalLLaMA, X *(from v3.2)*
- [ ] File-based ingress: drop a `*.task.md` or `*.task.json` in `.batonbot/inbox/` *(from v3.3)*
- [ ] Manual import UI for one-off bulk imports *(from v3.3)*

---

## Later

Headlines only. Items inside each will be detailed as we get closer.

- **v3.5.1 — Trust & Isolation.** Per-card git worktrees with diff / merge / discard. `ask_user` tool. Approval gates. Restart recovery.
- **v3.6 — GitHub Loop.** Issue → triage → fix → PR, end to end, via a GitHub App.
- **v3.6.1+ — Native Specialists.** `baton-summarizer`, `baton-docs-writer`, `baton-test-writer`, `baton-search`, plus a `baton-moltbook-poster` agent for the agent social network.
- **v3.7 — Mission Control.** Multi-project dashboard. Cost telemetry. Pipeline templates.
- **v3.8 — Open Substrate.** MCP server. Auto-routing rules. Additional ingress adapters (Linear, Email, Slack, Moltbook). Jira two-way sync (board-created tasks mirrored to Jira, status transitions, re-sync of edited tickets).
- **v3.9 — Machine Substrate.** API tokens. Outbound webhooks. OpenAPI spec. Headless mode.
- **v3.10 — Maturity.** Per-repo `BATONBOT.md` policy file. Architecture docs. Public comparison docs.

---

## Eventually — v4.0 "Beyond Code"

When BatonBot has clear traction in the coding niche, we'll broaden into general AI workflow agents (research, writing, monitoring). Not before — the dev story comes first.

---

## How this document changes

This roadmap is a living document. Items get reordered, deferred, or cut as we learn what users actually need. Each release ships with its own announcement when it lands.

Questions, suggestions, or feature requests? Open an issue or start a discussion on GitHub.
