/* ═══════════════════════════════════════════════════════════════════════
   Terminal / Live Output panel — DISABLED (COMING SOON)
   ───────────────────────────────────────────────────────────────────────
   The v1 "Live Output" docked panel has been removed from the front-end
   pending a rewrite. The backend infrastructure that powered it is still
   fully intact and in active use by other modules:

     • SSE endpoint  : GET /api/project/:id/tasks/stream  (batonbot.js)
                       — broadcasts orchestration_start, task_start,
                         task_done, stdout, tool_use, file_created, etc.
                       — still consumed by modules/board.js to drive the
                         pending → running → done card transitions.

     • JSONL session logs : ./logs/*.json
                       — still written for every agent session and
                         surfaced via the Logs tab.

   Known issues with v1 that should be addressed by v2:

     1. Duplicate `task_start` events. SSE fires task_start as soon as the
        orchestrator picks up the task; the JSONL log-tail poller fires
        another synthesized task_start ~1.5s later when it discovers the
        new session file on disk. v1 created TWO collapsible task groups
        for the same task, so the visible "active" panel was usually the
        wrong one and the real output landed in a hidden duplicate.
        → v2 must dedupe by (projectId, taskIndex, sessionId).

     2. Toggle binding loss. v1 attached a click listener directly to
        #terminal-header-toggle, but ensureHeaderEnhanced() rewrites the
        header's innerHTML on activation; the listener was getting lost
        in some flows, leaving the panel un-collapsable.
        → v2 should use event delegation on document.

     3. Docked-drawer layering bugs. The collapsed `.terminal-panel` strip
        and the open `.terminal-panel.open` drawer use two completely
        different layout modes (fixed bottom strip vs. fixed right-side
        drawer with top: 110px). Transitioning between them produced
        stray slivers at the top of the viewport in some states.
        → v2 should pick one layout idiom and stick with it (probably
          a right-side drawer with a single visibility transition).

   What this stub preserves:

     • window.__terminalHooks.onProjectActivated() / .onProjectReset()
       — modules/board.js#activateProject and modules/projects.js call
         these on every project change. They are no-ops here so neither
         caller blows up. When v2 ships, swap this stub for the real
         implementation and the existing wires will Just Work.

     • window.appendToTerminal / clearTerminal / connectToLogStream /
       disconnectLogStream — historical exports referenced by older
       modules. Kept as no-ops for safety.

   To re-enable Live Output in the front-end:
     1. Restore the <div id="terminal-panel"> block in index.html
        (search for "COMING SOON — removed from the front-end" comment).
     2. Un-hide the .terminal-* / .task-group-* rules in board.css
        (search for "Live Output v2" guard at the top of that section).
     3. Replace this stub with the actual panel implementation, making
        sure to address the three issues called out above.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    function noop() { /* Live Output panel disabled — see banner above */ }

    if (typeof window !== 'undefined') {
        window.__terminalHooks = {
            onProjectActivated: noop,
            onProjectReset: noop
        };
        // Historical exports — kept as no-ops so any stray callers don't crash.
        window.appendToTerminal = noop;
        window.clearTerminal = noop;
        window.connectToLogStream = noop;
        window.disconnectLogStream = noop;
    }
})();
