# TaskReaper ↔ Jira Setup Guide

**Time required: ~15 minutes.** This connects a Jira project to a TaskReaper project so new tickets automatically become cards — and urgent ones auto-run.

## How it works

TaskReaper **polls** Jira Cloud's REST API on an interval (default 60s). No webhooks, no public URL, no tunnel — outbound HTTPS only, so it works from any laptop behind any firewall. The machine running TaskReaper must be on for polling to happen.

### Routing rules (per ticket)

| Ticket has | Card lands in | Runs |
|---|---|---|
| Label `fix-now` OR priority **Highest** | QUEUE | **Immediately** (fire-and-forget, capped — see below) |
| Label `queue` | QUEUE | When someone presses ▶ |
| anything else | PENDING | After human triage |

### Trust-hardening guards (v3.4)

These guards are ON by default so the channel is safe to point at a real team's Jira project:

- **Assignee guard** — tickets **assigned to a human are skipped** (never hijack someone's work). Only unassigned tickets — or tickets assigned to the configured *Bot Account Email* — are imported. If the ticket is later unassigned, the next sync picks it up. Turn the guard off with the "Only import unassigned tickets" checkbox if you really want everything.
- **Autostart cap** — at most **3** `fix-now` tickets auto-run per poll cycle (configurable via *Max auto-runs per sync*). Extras still import to QUEUE but wait for a human ▶. Prevents a bulk-filed batch of urgent tickets from spinning up unbounded agent runs.
- **First-run watermark** — only tickets **created at/after the moment you enable** the channel are imported. Flipping the toggle on a mature Jira project will NOT flood the board with years of backlog. Disabling and re-enabling starts a fresh watermark.

### Comments posted back to Jira (full lifecycle visibility)

TaskReaper keeps the ticket reporter in the loop without them ever opening TaskReaper:

| Event | Comment |
|---|---|
| Ticket imported | 🤖 TaskReaper picked up this ticket… |
| Card moved PENDING → QUEUE (or back) | 📋 TaskReaper moved this ticket… |
| Task completed | ✅ TaskReaper completed this. \<summary\> — and the ticket **auto-transitions to Done** (v3.4.1, can be disabled) |
| Task failed | ❌ TaskReaper couldn't complete this: \<reason\> — ticket stays put |

Comments are best-effort (a failed comment never blocks the task) and idempotent (exactly one ✅/❌ per run; resetting the board and re-running comments again).

## Step 1 — Create a Jira API token

1. Go to <https://id.atlassian.com/manage-profile/security/api-tokens>
2. Click **Create API token**, name it `taskreaper`, copy the token.

> The token authenticates as *your* Jira account. TaskReaper needs read access to the project's issues and (optionally) permission to add comments.

## Step 2 — Configure TaskReaper

1. Open TaskReaper → select your project → click the **✎** (edit) button in the context bar.
2. Scroll to the **🎫 Jira Channel** section:

| Field | Value |
|---|---|
| Enable Jira polling | ✅ checked |
| Jira Base URL | `https://yourco.atlassian.net` |
| Jira Account Email | the email of the Atlassian account that made the token |
| Jira API Token | paste from Step 1 |
| JQL Filter | e.g. `project = HW AND statusCategory != Done ORDER BY created DESC` |
| Poll Interval | `60` (seconds; min 30) |
| Agent for Jira tickets | `Cline` (or your preference) |
| Only import unassigned tickets | ✅ (recommended — see assignee guard above) |
| Bot Account Email | optional; a dedicated Jira account for the "assign-to-bot" workflow |
| Max auto-runs per sync | `3` (autostart cap) |
| Move ticket to Done on completion | ✅ (auto-transition; uncheck if a human should close tickets) |

3. Click **🔌 Test Connection**. You should see `✓ Connected…`.
4. Click **💾 Save Changes**. The poller starts immediately and the first-run watermark is stamped — only tickets created from this moment on are imported.

## Step 3 — File a test ticket

1. In Jira, create a ticket in the filtered project (leave it **unassigned**):
   - Summary: `Test: add a hello comment to the README`
   - Description: plain English is fine
2. Wait up to one poll interval (or click **🔄 Sync Now** in the editor drawer).
3. The ticket appears as a card in **PENDING** on the TaskReaper board, and TaskReaper posts a comment on the Jira issue.

## Step 4 — Test the fire-and-forget lane

1. Create another ticket, and add the label **`fix-now`** (or set priority to **Highest**). Leave it unassigned.
2. Within one poll cycle: the card lands in **QUEUE** and starts running immediately — no clicks required.
3. Watch the card go `pending → running → done` on the board. Results (summary, files changed) are on the card detail (✎), and a ✅ completion comment lands on the Jira ticket.

## Recommended workflows

### JQL patterns

- Only new/open work: `project = HW AND statusCategory != Done`
- **Only unassigned tickets** (belt-and-suspenders with the assignee guard): `project = HW AND assignee IS EMPTY AND statusCategory != Done`
- Only bugs: `project = HW AND issuetype = Bug AND statusCategory != Done`
- Keep the query cheap: append `AND created >= -7d`

### The assign-to-bot workflow

For teams that triage in Jira: create a dedicated Jira account (e.g. `taskreaper@yourco.com`), set it as the **Bot Account Email**, and have engineers explicitly assign tickets to that account when they want TaskReaper to take them. Unassigned tickets still import; human-assigned tickets are always skipped.

### Delete → reimport

Deleting a Jira-sourced card from the board also removes its issue key from the dedup list (`jiraIngestedKeys`), so the still-open ticket will **re-import on the next sync**. This is the escape hatch when you deleted a card by mistake or want a clean re-run from the ticket.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `✗ Authentication failed` | Wrong email/token combo. The email must match the token's Atlassian account. |
| `✗ Bad JQL query` | Test your JQL in Jira's issue search first. |
| `✗ Host not found` | Base URL typo — should be `https://<yoursite>.atlassian.net` with no trailing path. |
| Ticket never appears | Check it matches your JQL; check it's **unassigned** (assignee guard); check it was **created after Jira was enabled** (watermark); check server logs for `[JIRA]` lines; click Sync Now. |
| Card appears but doesn't auto-run | The ticket needs label `fix-now` (exact) or priority Highest — or the autostart cap was hit this cycle (card is in QUEUE waiting for ▶). |
| Card shows `❌ Failed: Couldn't reach the LLM…` | Your local model server (LM Studio) isn't running or is on a different port. Start it and press ↺ Reset, then ▶. |
| No comment posted back to Jira | Your token's account may lack comment permission — cards still work, comments are best-effort. |

## Known Limitations (deferred to a future release)

These are deliberate scope cuts in v3.4 — know them before rolling out to a team:

1. **No re-sync after import.** Editing a ticket in Jira (summary, description, labels) after it becomes a card does NOT update the card. The card is a snapshot at import time.
2. **Token stored in plaintext.** The API token lives in `prompts.json` on the machine running TaskReaper. Don't commit that file; rotate the token at id.atlassian.com if compromised.
3. **Only the Done transition is automated.** Completed tasks transition their ticket to Done (v3.4.1), but there's no In-Progress transition on pickup, and failed tickets never move — the ❌ comment is the only signal.
4. **No poller backoff / auto-disable.** Repeated auth failures (e.g. revoked token) are logged every cycle but the poller keeps trying; it won't disable itself or slow down.
5. **Single-instance assumption.** Two TaskReaper instances polling the same Jira project would each import every ticket (dedup state is per-instance, in each machine's prompts.json).
6. **Label matching is exact and case-sensitive.** `Fix-Now` or `fixnow` will NOT trigger autostart — only the exact configured label (`fix-now` by default).
7. **One-way channel.** Tasks created directly on the TaskReaper board are NOT mirrored to Jira as new issues. Only Jira-originated cards get lifecycle comments. (Two-way sync is a candidate for the Open Substrate release.)

## Security notes

- The API token is stored in `prompts.json` on the machine running TaskReaper. Don't commit that file.
- Rotate the token at id.atlassian.com if compromised; paste the new one into the editor.
- The poller reads issues matching your JQL, writes comments, and (if enabled) transitions completed tickets to Done — it never edits ticket content.
