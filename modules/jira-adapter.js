/* ═══════════════════════════════════════════════════════════
   Jira Adapter — polling-based Jira → TaskReaper ingress channel
   ═══════════════════════════════════════════════════════════
   v3.4 "Design Partner" — lets a team file bugs in Jira and have
   them appear (and optionally auto-run) on the TaskReaper board,
   with NO public URL required. TaskReaper polls Jira Cloud's REST
   API on an interval (outbound HTTPS only), so it works from any
   laptop behind any NAT/firewall.

   Per-project config lives in project.jiraConfig:
     {
       enabled: true,
       baseUrl: "https://yourco.atlassian.net",
       email: "you@yourco.com",           // Jira account email
       apiToken: "…",                     // id.atlassian.com API token
       jql: "project = HW AND statusCategory != Done",
       pollIntervalSec: 60,               // min 30
       defaultAgent: "cline",             // agent for ingested tickets
        autostartLabels: ["fix-now"],      // labels that trigger fire-and-forget
        autostartPriorities: ["Highest"],  // priorities that trigger fire-and-forget
        // ── v3.4 "Trust Hardening" additions ──
        onlyUnassigned: true,              // skip tickets assigned to a human (default true)
        botAccountEmail: "",               // tickets assigned to THIS account are still imported
        maxAutostartPerPoll: 3,            // cap on fire-and-forget starts per poll cycle
        enabledAt: "2026-01-01T00:00:00Z"  // watermark: only tickets created at/after this import
      }

   Dedup: project.jiraIngestedKeys is an array of issue keys already
   turned into cards; we never re-ingest the same key.

   Routing (bucket) rules per ticket:
     • label in autostartLabels OR priority in autostartPriorities
         → orchestrate:true + immediate autostart (QUEUE column, runs now)
     • label "queue"
         → orchestrate:true, no autostart (QUEUE column, waits for ▶)
     • otherwise
         → triage (PENDING column)
   ─────────────────────────────────────────────────────────── */

'use strict';

const axios = require('axios');

// Injected by init() so this module stays decoupled from taskreaper.js internals.
let deps = {
  getState: null,          // () => state object
  saveState: null,         // (state) => void
  broadcastEvent: null,    // (projectId, event) => void
  triggerOrchestrate: null // (projectId, taskIndices) => void  (fire-and-forget)
};

// Map of projectId -> NodeJS.Timeout for active pollers
const pollers = new Map();

// Map of projectId -> { lastPollAt, lastResult, lastError } for status reporting
const pollerStatus = new Map();

/* ── ADF → plain text ────────────────────────────────────────
   Jira Cloud API v3 returns issue descriptions in Atlassian
   Document Format (a JSON tree). Recursively walk it and pull
   out the text nodes. Good enough for prompts — we don't need
   to preserve formatting, just the words. */
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');

  let out = '';
  if (node.type === 'text' && node.text) out += node.text;
  if (node.type === 'hardBreak') out += '\n';
  if (node.content) out += adfToText(node.content);
  // Block-level nodes get a trailing newline for readability
  if (['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'blockquote'].includes(node.type)) {
    out += '\n';
  }
  return out;
}

/* ── Build the TaskReaper task from a Jira issue ─────────────── */
function issueToTask(issue, jiraConfig, existingCount) {
  const fields = issue.fields || {};
  const key = issue.key;
  const summary = fields.summary || '(no summary)';
  const description = adfToText(fields.description).trim();
  const labels = fields.labels || [];
  const priority = (fields.priority && fields.priority.name) || '';
  const reporter = (fields.reporter && (fields.reporter.displayName || fields.reporter.emailAddress)) || 'unknown';

  // Bucket decision
  const autostartLabels = jiraConfig.autostartLabels || ['fix-now'];
  const autostartPriorities = jiraConfig.autostartPriorities || ['Highest'];
  const isAutostart =
    labels.some(l => autostartLabels.includes(l)) ||
    (priority && autostartPriorities.includes(priority));
  const isQueue = labels.includes('queue');

  const promptParts = [`${key}: ${summary}`];
  if (description) promptParts.push('', description);
  promptParts.push('', `(Reported by ${reporter} via Jira. Priority: ${priority || 'unset'}.)`);

  return {
    task: {
      id: existingCount,
      prompt: promptParts.join('\n'),
      agent: jiraConfig.defaultAgent || 'cline',
      state: 'pending',
      orchestrate: isAutostart || isQueue,
      metadata: {
        source: 'jira',
        issueKey: key,
        priority: priority || null,
        labels,
        reporter,
        url: `${(jiraConfig.baseUrl || '').replace(/\/$/, '')}/browse/${key}`
      }
    },
    autostart: isAutostart
  };
}

/* ── Jira REST helpers ─────────────────────────────────────── */
function jiraAxios(jiraConfig) {
  const base = (jiraConfig.baseUrl || '').replace(/\/$/, '');
  return axios.create({
    baseURL: base,
    timeout: 15000,
    auth: { username: jiraConfig.email, password: jiraConfig.apiToken },
    headers: { Accept: 'application/json' }
  });
}

/**
 * Test the connection: run the configured JQL with maxResults=1.
 * Returns { ok, message, sampleIssue? }.
 */
async function testConnection(jiraConfig) {
  if (!jiraConfig.baseUrl || !jiraConfig.email || !jiraConfig.apiToken) {
    return { ok: false, message: 'baseUrl, email, and apiToken are all required' };
  }
  try {
    const client = jiraAxios(jiraConfig);
    const jql = jiraConfig.jql || 'ORDER BY created DESC';
    const r = await client.get('/rest/api/3/search/jql', {
      params: { jql, maxResults: 1, fields: 'summary' }
    }).catch(async (err) => {
      // Older Jira deployments use /rest/api/3/search (deprecated on Cloud
      // mid-2025 but still live on some instances). Fall back once.
      if (err.response && (err.response.status === 404 || err.response.status === 410)) {
        return client.get('/rest/api/3/search', { params: { jql, maxResults: 1, fields: 'summary' } });
      }
      throw err;
    });
    const total = r.data.total ?? (r.data.issues ? r.data.issues.length : 0);
    const sample = (r.data.issues && r.data.issues[0]) || null;
    return {
      ok: true,
      message: `Connected. JQL matches ${total >= 1 ? 'at least ' : ''}${total} issue(s).`,
      sampleIssue: sample ? { key: sample.key, summary: sample.fields?.summary } : null
    };
  } catch (err) {
    const status = err.response?.status;
    let message = err.message;
    if (status === 401) message = 'Authentication failed — check email + API token';
    else if (status === 400) message = 'Bad JQL query: ' + (err.response?.data?.errorMessages?.join('; ') || err.message);
    else if (err.code === 'ENOTFOUND') message = 'Host not found — check the Jira base URL';
    return { ok: false, message };
  }
}

/**
 * Fetch issues matching JQL that we haven't ingested yet.
 */
async function fetchNewIssues(jiraConfig, ingestedKeys) {
  const client = jiraAxios(jiraConfig);
  const jql = jiraConfig.jql || 'ORDER BY created DESC';
  const params = {
    jql,
    maxResults: 25,
    // assignee is fetched so the v3.4 assignee-guard can skip human-owned
    // tickets; created is used by the enabledAt watermark filter.
    fields: 'summary,description,labels,priority,reporter,created,assignee'
  };
  const r = await client.get('/rest/api/3/search/jql', { params }).catch(async (err) => {
    if (err.response && (err.response.status === 404 || err.response.status === 410)) {
      return client.get('/rest/api/3/search', { params });
    }
    throw err;
  });

  const issues = r.data.issues || [];
  const ingested = new Set(ingestedKeys || []);
  return issues.filter(i => !ingested.has(i.key));
}

/**
 * Post a comment back to a Jira issue. Best-effort; failures are logged, not thrown.
 */
async function postComment(jiraConfig, issueKey, text) {
  try {
    const client = jiraAxios(jiraConfig);
    await client.post(`/rest/api/3/issue/${issueKey}/comment`, {
      body: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
      }
    });
  } catch (err) {
    console.warn(`[JIRA] Failed to post comment on ${issueKey}:`, err.response?.status || err.message);
  }
}

/**
 * v3.4.1 — Transition a Jira issue to a target STATUS CATEGORY.
 * Workflow status names/IDs vary per project ("Done", "Closed", "Complete"…),
 * but Jira guarantees every status maps to one of three categories:
 * new (To Do) / indeterminate (In Progress) / done. So we fetch the
 * transitions available FROM the ticket's current status and pick the one
 * whose destination lands in the requested category — preferring an exact
 * name match ("Done") when several qualify. Best-effort: failures are
 * logged, never thrown, and never block task completion.
 *
 * @param {object} jiraConfig
 * @param {string} issueKey
 * @param {'done'|'indeterminate'|'new'} targetCategory
 * @param {string} [preferredName] e.g. 'Done' — tie-breaker when multiple transitions match
 */
async function transitionIssue(jiraConfig, issueKey, targetCategory, preferredName) {
  try {
    const client = jiraAxios(jiraConfig);
    const r = await client.get(`/rest/api/3/issue/${issueKey}/transitions`);
    const transitions = r.data.transitions || [];

    const candidates = transitions.filter(t => t.to?.statusCategory?.key === targetCategory);
    if (candidates.length === 0) {
      console.warn(`[JIRA] No transition to category '${targetCategory}' available for ${issueKey} (current workflow may not allow it)`);
      return false;
    }
    // Prefer an exact name match (case-insensitive), else take the first candidate.
    const preferred = preferredName
      ? candidates.find(t => (t.to?.name || t.name || '').toLowerCase() === preferredName.toLowerCase())
      : null;
    const chosen = preferred || candidates[0];

    await client.post(`/rest/api/3/issue/${issueKey}/transitions`, {
      transition: { id: chosen.id }
    });
    console.log(`[JIRA] Transitioned ${issueKey} → "${chosen.to?.name || chosen.name}" (category: ${targetCategory})`);
    return true;
  } catch (err) {
    console.warn(`[JIRA] Failed to transition ${issueKey} to '${targetCategory}':`, err.response?.status || err.message);
    return false;
  }
}

/* ── v3.4 Trust-hardening filters ──────────────────────────────
   Applied client-side to the fetched issues (safer than mutating
   the user's JQL server-side). Each returns { keep, reason }. */

/**
 * Assignee guard: never hijack a human's ticket. Import only if the
 * issue is unassigned OR assigned to the configured bot account.
 * Controlled by jiraConfig.onlyUnassigned (default true — omitting the
 * key means the guard is ON; it must be explicitly set to false).
 */
function passesAssigneeGuard(issue, jiraConfig) {
  if (jiraConfig.onlyUnassigned === false) return { keep: true };
  const assignee = issue.fields?.assignee;
  if (!assignee) return { keep: true }; // unassigned → fair game

  const botEmail = (jiraConfig.botAccountEmail || '').trim().toLowerCase();
  const assigneeEmail = (assignee.emailAddress || '').trim().toLowerCase();
  if (botEmail && assigneeEmail && botEmail === assigneeEmail) {
    return { keep: true }; // assigned to the bot account → still ours
  }
  const name = assignee.displayName || assignee.emailAddress || 'unknown';
  return { keep: false, reason: `assigned to a human (${name})` };
}

/**
 * First-run watermark: only import tickets created at/after the moment
 * Jira was enabled for this project (jiraConfig.enabledAt). Prevents a
 * years-old backlog from flooding the board the first time someone
 * flips the toggle. Tickets without a created field are kept (defensive).
 */
function passesWatermark(issue, jiraConfig) {
  if (!jiraConfig.enabledAt) return { keep: true }; // legacy configs: no watermark
  const createdRaw = issue.fields?.created;
  if (!createdRaw) return { keep: true };
  const created = new Date(createdRaw).getTime();
  const watermark = new Date(jiraConfig.enabledAt).getTime();
  if (Number.isNaN(created) || Number.isNaN(watermark)) return { keep: true };
  if (created >= watermark) return { keep: true };
  return { keep: false, reason: `created before Jira was enabled (${createdRaw} < ${jiraConfig.enabledAt})` };
}

/* ── One poll cycle for one project ────────────────────────── */
async function pollOnce(projectId) {
  const state = deps.getState();
  const project = state.projects.find(p => p.id === projectId);
  if (!project || !project.jiraConfig || !project.jiraConfig.enabled) {
    stopPoller(projectId);
    return;
  }
  const jiraConfig = project.jiraConfig;

  try {
    const fetched = await fetchNewIssues(jiraConfig, project.jiraIngestedKeys);

    // ── v3.4 Trust-hardening filters (assignee guard + watermark) ──
    // Skipped issues are NOT added to jiraIngestedKeys: if a human later
    // unassigns a ticket (or it otherwise becomes eligible), a future
    // poll will import it.
    const newIssues = [];
    for (const issue of fetched) {
      const assigneeCheck = passesAssigneeGuard(issue, jiraConfig);
      if (!assigneeCheck.keep) {
        console.log(`[JIRA] Skipping ${issue.key} — ${assigneeCheck.reason}`);
        continue;
      }
      const watermarkCheck = passesWatermark(issue, jiraConfig);
      if (!watermarkCheck.keep) {
        console.log(`[JIRA] Skipping ${issue.key} — ${watermarkCheck.reason}`);
        continue;
      }
      newIssues.push(issue);
    }

    pollerStatus.set(projectId, {
      lastPollAt: new Date().toISOString(),
      lastResult: `${newIssues.length} new issue(s)` + (fetched.length > newIssues.length ? ` (${fetched.length - newIssues.length} skipped by filters)` : ''),
      lastError: null
    });

    if (newIssues.length === 0) return;

    console.log(`[JIRA] ${newIssues.length} new issue(s) for project ${projectId}: ${newIssues.map(i => i.key).join(', ')}`);

    // Re-read state fresh right before mutation (poll was async; avoid stale writes)
    const commitState = deps.getState();
    const commitProject = commitState.projects.find(p => p.id === projectId);
    if (!commitProject) return;
    if (!Array.isArray(commitProject.jiraIngestedKeys)) commitProject.jiraIngestedKeys = [];

    const startIndex = commitProject.tasks.length;
    const autostartIndices = [];
    const created = [];

    // ── v3.4 Autostart cap: at most N fire-and-forget starts per poll ──
    // A burst of `fix-now` tickets shouldn't spin up unbounded agent runs
    // (cost + chaos). Tickets past the cap still land in QUEUE
    // (orchestrate:true) — they just wait for a human ▶ press.
    const maxAutostart = Math.max(0, parseInt(jiraConfig.maxAutostartPerPoll, 10) >= 0
      ? parseInt(jiraConfig.maxAutostartPerPoll, 10)
      : 3);
    let throttledCount = 0;

    for (const issue of newIssues) {
      // Double-check dedup against fresh state
      if (commitProject.jiraIngestedKeys.includes(issue.key)) continue;

      const { task, autostart } = issueToTask(issue, jiraConfig, commitProject.tasks.length);
      let effectiveAutostart = autostart;
      if (autostart && autostartIndices.length >= maxAutostart) {
        // Over the cap: keep the card in QUEUE but don't auto-run it.
        effectiveAutostart = false;
        throttledCount++;
      }
      commitProject.tasks.push(task);
      commitProject.jiraIngestedKeys.push(issue.key);
      created.push({ index: task.id, issueKey: issue.key, autostart: effectiveAutostart, throttled: autostart && !effectiveAutostart });
      if (effectiveAutostart) autostartIndices.push(task.id);
    }

    if (throttledCount > 0) {
      console.log(`[JIRA] Autostart cap (${maxAutostart}/poll) reached for project ${projectId} — ${throttledCount} ticket(s) imported to QUEUE without auto-running`);
    }

    if (created.length === 0) return;
    deps.saveState(commitState);

    // Live-update any open boards
    deps.broadcastEvent(projectId, {
      type: 'task_ingested',
      projectId,
      count: created.length,
      startIndex,
      source: 'jira',
      timestamp: new Date().toISOString()
    });

    // Comment back on each Jira issue so the reporter knows Baton has it
    for (const c of created) {
      const bucket = c.throttled
        ? 'and queued it (autostart cap reached this cycle — it will run when the queue is played)'
        : c.autostart
          ? 'and started working on it immediately'
          : 'and added it to the triage board';
      postComment(jiraConfig, c.issueKey, `🤖 TaskReaper picked up this ticket ${bucket}. (Task #${c.index})`);
    }

    // Fire-and-forget lane
    if (autostartIndices.length > 0 && deps.triggerOrchestrate) {
      console.log(`[JIRA] Autostarting ${autostartIndices.length} task(s) for project ${projectId}`);
      deps.triggerOrchestrate(projectId, autostartIndices);
    }
  } catch (err) {
    const msg = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data?.errorMessages || err.response.statusText)}` : err.message;
    console.error(`[JIRA] Poll failed for project ${projectId}: ${msg}`);
    pollerStatus.set(projectId, { lastPollAt: new Date().toISOString(), lastResult: null, lastError: msg });
  }
}

/* ── Poller lifecycle ──────────────────────────────────────── */
function startPoller(projectId) {
  stopPoller(projectId);
  const state = deps.getState();
  const project = state.projects.find(p => p.id === projectId);
  if (!project || !project.jiraConfig || !project.jiraConfig.enabled) return false;

  const intervalSec = Math.max(30, parseInt(project.jiraConfig.pollIntervalSec, 10) || 60);
  console.log(`[JIRA] Starting poller for project ${projectId} (every ${intervalSec}s)`);

  // Poll immediately, then on interval
  pollOnce(projectId);
  const timer = setInterval(() => pollOnce(projectId), intervalSec * 1000);
  timer.unref?.(); // don't keep the process alive just for polling
  pollers.set(projectId, timer);
  return true;
}

function stopPoller(projectId) {
  const timer = pollers.get(projectId);
  if (timer) {
    clearInterval(timer);
    pollers.delete(projectId);
    console.log(`[JIRA] Stopped poller for project ${projectId}`);
  }
}

/** (Re)start pollers for every project with an enabled jiraConfig. Called on boot and after config saves. */
function syncPollers() {
  const state = deps.getState();
  const enabledIds = new Set();
  for (const project of state.projects) {
    if (project.jiraConfig && project.jiraConfig.enabled) {
      enabledIds.add(project.id);
      if (!pollers.has(project.id)) startPoller(project.id);
    }
  }
  // Stop pollers for projects that were disabled or deleted
  for (const pid of [...pollers.keys()]) {
    if (!enabledIds.has(pid)) stopPoller(pid);
  }
}

/* ── v3.4 Result comments: close the loop back to Jira ─────────
   Called by taskreaper.js when a task reaches a terminal state
   (done/failed) — and on queue moves — so the person who filed the
   ticket sees the outcome without opening TaskReaper.

   Idempotency: terminal-result comments stamp
   task.metadata.jiraResultCommentedAt. Both the orchestrate loop and
   executeAgentTask call this on completion; the stamp guarantees the
   ticket gets exactly one ✅/❌ per run. Resetting a task clears the
   stamp so a re-run comments again. */

/**
 * Post a ✅/❌ result comment for a Jira-sourced task.
 * @param {string} projectId
 * @param {number} taskIndex
 * @param {{success:boolean, summary?:string, error?:string}} result
 */
async function commentTaskResult(projectId, taskIndex, result) {
  try {
    const state = deps.getState();
    const project = state.projects.find(p => p.id === projectId);
    if (!project || !project.jiraConfig) return;
    const task = project.tasks[taskIndex];
    if (!task || !task.metadata || task.metadata.source !== 'jira' || !task.metadata.issueKey) return;

    // Idempotency guard: only one result comment per run.
    if (task.metadata.jiraResultCommentedAt) return;

    // Stamp BEFORE posting (re-read fresh state right before mutation, same
    // pattern as pollOnce) so a racing second caller bails immediately.
    const commitState = deps.getState();
    const commitProject = commitState.projects.find(p => p.id === projectId);
    const commitTask = commitProject && commitProject.tasks[taskIndex];
    if (!commitTask || !commitTask.metadata) return;
    if (commitTask.metadata.jiraResultCommentedAt) return;
    commitTask.metadata.jiraResultCommentedAt = new Date().toISOString();
    deps.saveState(commitState);

    const issueKey = task.metadata.issueKey;
    let text;
    if (result.success) {
      text = `✅ TaskReaper completed this.` + (result.summary ? ` ${result.summary}` : '');
    } else {
      text = `❌ TaskReaper couldn't complete this: ${result.error || 'unknown error'}`;
    }
    await postComment(project.jiraConfig, issueKey, text);
    console.log(`[JIRA] Posted ${result.success ? 'completion' : 'failure'} comment on ${issueKey} (task #${taskIndex})`);

    // ── v3.4.1: auto-transition the ticket to Done on success ──
    // Default ON (transitionOnDone must be explicitly false to disable) —
    // it's the behavior reporters expect: TaskReaper finished, ticket moves.
    // Failed tasks stay put; the ❌ comment explains why. Piggybacks on the
    // same idempotency stamp as the comment, so this fires once per run.
    if (result.success && project.jiraConfig.transitionOnDone !== false) {
      await transitionIssue(project.jiraConfig, issueKey, 'done', 'Done');
    }
  } catch (err) {
    console.warn(`[JIRA] commentTaskResult failed for project ${projectId} task ${taskIndex}:`, err.message);
  }
}

/**
 * Post a lifecycle comment (e.g. queue moves) for a Jira-sourced task.
 * No idempotency stamp — each move is a distinct event.
 */
async function commentTaskEvent(projectId, taskIndex, text) {
  try {
    const state = deps.getState();
    const project = state.projects.find(p => p.id === projectId);
    if (!project || !project.jiraConfig) return;
    const task = project.tasks[taskIndex];
    if (!task || !task.metadata || task.metadata.source !== 'jira' || !task.metadata.issueKey) return;
    await postComment(project.jiraConfig, task.metadata.issueKey, text);
  } catch (err) {
    console.warn(`[JIRA] commentTaskEvent failed for project ${projectId} task ${taskIndex}:`, err.message);
  }
}

/**
 * v3.4 Delete → reimport escape hatch. When a Jira-sourced card is deleted
 * from the board, forget its issue key so a future poll can re-import it.
 * Returns true if a key was removed.
 */
function forgetIngestedKey(projectId, issueKey) {
  const state = deps.getState();
  const project = state.projects.find(p => p.id === projectId);
  if (!project || !Array.isArray(project.jiraIngestedKeys)) return false;
  const idx = project.jiraIngestedKeys.indexOf(issueKey);
  if (idx === -1) return false;
  project.jiraIngestedKeys.splice(idx, 1);
  deps.saveState(state);
  console.log(`[JIRA] Forgot ingested key ${issueKey} for project ${projectId} — it can re-import on the next sync`);
  return true;
}

function getStatus(projectId) {
  return {
    polling: pollers.has(projectId),
    ...(pollerStatus.get(projectId) || {})
  };
}

function init(dependencies) {
  deps = { ...deps, ...dependencies };
  syncPollers();
}

module.exports = {
  init,
  syncPollers,
  startPoller,
  stopPoller,
  testConnection,
  getStatus,
  pollOnce,
  commentTaskResult,
  commentTaskEvent,
  forgetIngestedKey,
  transitionIssue,
  // exported for tests
  adfToText,
  issueToTask
};
