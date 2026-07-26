/* ═══════════════════════════════════════════════════════════
   The Baton — context relay between pipeline tasks
   ═══════════════════════════════════════════════════════════

   ── A note on the name ──────────────────────────────────────
   This project was called BatonBot before it was TaskReaper.
   The name had to change; the metaphor didn't. This module is
   where the original idea actually lives: a relay race, where
   each task finishes its leg and hands something forward to the
   runner behind it.

   The baton is the only thing in a relay that crosses the whole
   distance. Everything else — the runners, the legs, the agents
   — is replaceable. So it seemed right to let the old name keep
   the one part of the codebase it literally describes.
   ────────────────────────────────────────────────────────────

   THE RELAY

   A TaskReaper pipeline is a sequence of tasks, each run by an
   agent in a fresh context with no memory of what came before.
   Left alone, task #4 has no idea that task #2 already created
   `src/db/schema.sql` — so it creates it again, differently.

   The baton fixes that. Three moves:

     pack(result)      — a finishing task wraps up what it did:
                         summary, files created/modified, commands
                         run. This is the baton.

     pass(projectId,   — the baton is persisted onto the task in
          index,         project state, so it survives restarts
          baton)         and is visible to everything downstream.

     receive(project,  — the next task picks up every baton
             index)      dropped by completed tasks ahead of it and
                         gets them as markdown, prepended to its
                         prompt.

   Note that `receive` collects from ALL prior completed tasks,
   not just the immediately preceding one. In a real relay you
   only ever hold one baton; here the runner arrives carrying
   every baton handed off so far. The metaphor frays a little,
   but the behavior is what you want — task #4 should know about
   task #1, not just task #3.

   Related: agents also write durable notes to a per-project
   `.baton-memory.json` (see micro-agents.js). Same lineage,
   same reason for the name.
   ─────────────────────────────────────────────────────────── */

'use strict';

// Injected by init() so this module stays decoupled from
// taskreaper.js internals (same pattern as jira-adapter.js).
let deps = {
  getState: null,  // () => state object
  saveState: null  // (state) => void
};

function init(injected) {
  deps = { ...deps, ...injected };
}

/**
 * pack — Build the baton a finishing task hands forward.
 *
 * Captures what the task actually accomplished, in the shape
 * `receive()` knows how to render downstream.
 */
function pack(result, filesModified) {
  return {
    summary: result.summary || '',
    iterations: result.iterations || 0,
    filesCreated: result.filesCreated || [],
    filesModified: filesModified || [],
    commandsRun: result.commandsRun || [],
    success: result.success !== false,
    error: result.error || null,
    completedAt: new Date().toISOString()
  };
}

/**
 * pass — Hand the baton off.
 *
 * Persists the packed baton onto the task in project state so
 * it survives a restart and is there when the next runner
 * reaches for it.
 */
function pass(projectId, taskIndex, baton) {
  if (!deps.getState || !deps.saveState) {
    throw new Error('baton.pass() called before baton.init() — no state accessors injected.');
  }

  const state = deps.getState();
  const project = state.projects.find(p => p.id === projectId);

  if (project && project.tasks[taskIndex]) {
    Object.assign(project.tasks[taskIndex], baton);
    deps.saveState(state);
    console.log(
      `[BATON] Task ${taskIndex} passed the baton: ${baton.summary?.slice(0, 80) || '(empty)'}...`
    );
  }
}

/**
 * receive — Pick up every baton dropped ahead of you.
 *
 * Walks all tasks before `currentTaskIndex`, collects the ones
 * that completed, and renders their batons as a markdown brief.
 * Returns null when you're the lead runner and there's nothing
 * to pick up.
 */
function receive(project, currentTaskIndex) {
  if (!project || !project.tasks) return null;

  const carried = [];

  for (let i = 0; i < currentTaskIndex; i++) {
    const task = project.tasks[i];
    if (task && task.state === 'done') {
      carried.push({
        index: i,
        prompt: task.prompt,
        summary: task.summary || '(no summary)',
        filesCreated: task.filesCreated || [],
        filesModified: task.filesModified || [],
        commandsRun: task.commandsRun || []
      });
    }
  }

  if (carried.length === 0) return null;

  const parts = ['# Completed Previous Tasks', ''];
  for (const t of carried) {
    parts.push(`## Task ${t.index}: ${t.prompt}`);
    parts.push('');
    parts.push(`**Summary:** ${t.summary}`);
    if (t.filesCreated.length > 0) {
      parts.push(`**Files created:** ${t.filesCreated.join(', ')}`);
    }
    if (t.filesModified.length > 0) {
      parts.push(`**Files modified:** ${t.filesModified.join(', ')}`);
    }
    if (t.commandsRun.length > 0) {
      parts.push(`**Commands run:** ${t.commandsRun.join(', ')}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * carry — Prepend a received baton to the next task's prompt.
 *
 * Returns the prompt unchanged when there's no baton to carry,
 * so callers don't need to branch.
 */
function carry(batonContext, prompt, taskIndex) {
  if (!batonContext) {
    console.log(`[BATON] Task ${taskIndex} is the lead runner — no baton to pick up.`);
    return prompt;
  }

  console.log(`[BATON] Task ${taskIndex} picked up the baton (${batonContext.length} chars).`);

  return `The context below was automatically inherited from previous tasks in this pipeline. Review it during your planning phase to understand the current state of the codebase.

${batonContext}

---

${prompt}`;
}

module.exports = { init, pack, pass, receive, carry };
