require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const treeKill = require('tree-kill');

/* ═══════════════════════════════════════════════════════════
   Cross-platform helpers
   ═══════════════════════════════════════════════════════════
   BatonBot is a single codebase that runs on macOS, Linux, and
   Windows. Platform-specific differences are isolated here so
   the rest of the code stays OS-agnostic.
   ─────────────────────────────────────────────────────────── */
const IS_WINDOWS = process.platform === 'win32';

/**
 * spawnCompat — child_process.spawn wrapper that works on Windows.
 *
 * On Windows, agent CLIs (`cline`, `aider`, `npx`, sometimes `git`) are
 * installed as `.cmd` / `.bat` shims. There are two booby-traps here:
 *
 *   1. Bare `cline` won't resolve — we need `cline.cmd`.
 *   2. Since Node 18.20.2 / 20.12.2 / 21.7.2, Node refuses to spawn
 *      `.cmd` / `.bat` files directly with `shell: false` and throws
 *      `spawn EINVAL` (CVE-2024-27980 mitigation).
 *   3. Using `shell: true` re-routes through `cmd.exe`, which then
 *      re-tokenizes the joined command line and splits multi-word
 *      prompt arguments on whitespace → Cline errors with
 *      "Unknown command or extra arguments".
 *
 * The robust path is to invoke `cmd.exe /d /s /c <shim> <args>` ourselves
 * with `windowsVerbatimArguments: true` so Node doesn't re-quote, and we
 * manually wrap each arg in double quotes if it contains whitespace or
 * shell metacharacters. That way the prompt reaches Cline as ONE token.
 *
 * On macOS/Linux we pass through unchanged.
 */
function quoteArgForWindowsCmd(arg) {
  const s = String(arg);
  if (s === '' || /[\s"&<>^|()%!]/.test(s)) {
    // Escape any embedded double-quotes (Microsoft's standard rules), then
    // wrap the whole thing in double quotes so cmd.exe sees one token.
    const escaped = s
      .replace(/(\\*)"/g, '$1$1\\"')
      .replace(/(\\+)$/, '$1$1');
    return `"${escaped}"`;
  }
  return s;
}

function spawnCompat(command, args, opts = {}) {
  if (IS_WINDOWS) {
    const isPath = command.includes('/') || command.includes('\\');
    const shimName = path.extname(command) || isPath ? command : `${command}.cmd`;
    const quotedArgs = args.map(quoteArgForWindowsCmd);
    return spawn(
      'cmd.exe',
      ['/d', '/s', '/c', shimName, ...quotedArgs],
      {
        ...opts,
        shell: false,
        windowsVerbatimArguments: true,
        windowsHide: true,
      }
    );
  }
  return spawn(command, args, {
    ...opts,
    shell: opts.shell ?? false,
    windowsHide: true,
  });
}

/**
 * killProcessTree — Reliably terminate a child process and all of its
 * descendants on any platform.
 *
 * On POSIX, `child.kill('SIGTERM')` only signals the immediate child.
 * When we spawn through a shell (cmd.exe / sh), the agent CLI is a
 * grandchild and survives. On Windows there are no real POSIX signals
 * at all, so SIGTERM is essentially "kill -9 the parent only".
 *
 * tree-kill walks the OS process tree and terminates every descendant
 * (using taskkill /T /F on Windows, kill on POSIX).
 */
function killProcessTree(child, signal = 'SIGTERM') {
  if (!child || child.killed || !child.pid) return;
  try {
    treeKill(child.pid, signal);
  } catch (err) {
    // Last-ditch fallback so we never leave a child running.
    try { child.kill(signal); } catch (_) { /* swallow */ }
  }
}

const {
  executeCodingAgent,
  buildSpawnedTasks,
  registerMcpTool,
  unregisterMcpServerTools,
  getAvailableMcpServers,
  getMcpServer,
  setMcpServer
} = require('./modules/micro-agents');

const batonCodeAgent = require('./modules/agents/baton-code');
const batonCodeThinkingAgent = require('./modules/agents/baton-code-thinking');

const app = express();
const PORT = process.env.PORT || 3000;
const PROMPTS_FILE = path.join(__dirname, 'prompts.json');
const logsDir = path.join(__dirname, 'logs');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// ═══════════════════════════════════════════
// Phase 3: Execution Controls & Real-Time Feedback — Backend State
// ═══════════════════════════════════════════

/**
 * Global execution tracker — holds running child processes and abort signals.
 */
const executionState = {
  running: false,
  pauseRequested: false, // When true, orchestrator finishes current task then halts without failing remaining pending tasks
  childProcesses: [],    // Array of { projectId, taskIndex, process }
  abortController: null  // AbortController for cancellation signaling
};

/**
 * Deduplication guard — Set of "projectId:taskIndex" strings for tasks currently being triggered.
 * Prevents duplicate task execution when multiple log writes arrive concurrently during session startup/completion.
 */
const pendingTriggerSet = new Set();

/**
 * Active sessions tracker — Map of taskIndex -> { sessionId, projectId, spawnTime, child }
 * Prevents duplicate session creation for the same task.
 */
const activeSessions = new Map();

/**
 * Queue-based task processing state machine.
 * Ensures only one task runs at a time.
 */
const taskQueue = {
  isProcessing: false,       // True when a task is actively running
  currentTaskIndex: null    // Currently processing task index
};

/**
 * Cooldown delay in milliseconds before triggering the next task after completion detection.
 * Prevents race conditions from concurrent log writes during session startup/completion.
 */
const TASK_COMPLETION_COOLDOWN = 1500;

/**
 * Quiet period in milliseconds after the last file activity before triggering next task.
 * Cline may emit completion_result but continue editing files afterward — we wait for
 * a period of inactivity to ensure all file operations are done.
 */
const FILE_ACTIVITY_QUIET_PERIOD = 5000;

/**
 * Map of sessionId -> last file activity timestamp.
 * Tracks when the last file edit/new-file event occurred for each session.
 */
const fileActivityTimestamps = new Map();

/**
 * Map of sessionId -> completion signal received timestamp.
 * Tracks when a completion signal was first seen, so we can detect if file edits follow.
 */
const completionSignalTimestamps = new Map();

/**
 * Set of sessionIds that have already triggered the next task.
 * Prevents duplicate triggering from multiple completion signals.
 */
const alreadyTriggeredSessions = new Set();

/**
 * Map of "projectId:taskIndex" -> last trigger timestamp.
 * Enforces cooldown delay between task triggers to prevent race conditions.
 */
const completionCooldowns = new Map();

/**
 * SSE stream subscribers — Map of projectId -> Response object.
 * Used to broadcast orchestration events in real-time.
 */
const streamSubscribers = new Map();

/**
 * Cline session event cache — Map of sessionId -> Array<events>.
 * Used to buffer events in memory for session log saving, avoiding
 * race conditions from async read-modify-write cycles.
 */
const clineSessionCache = new Map();

/**
 * Broadcast an event to all SSE subscribers for a given project.
 *
 * streamSubscribers is a Map<projectId, Set<Response>> so multiple browser
 * tabs / panels (e.g. the board's task-state listener AND the terminal's
 * Live Output panel) can subscribe to the same project's event stream
 * without overwriting each other.
 */
function broadcastEvent(projectId, event) {
  const subs = streamSubscribers.get(projectId);
  if (!subs || subs.size === 0) return;
  const payload = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const res of subs) {
    if (!res.writableEnded) {
      try { res.write(payload); } catch (_) { /* swallow — subscriber will be cleaned up on close */ }
    }
  }
}

/**
 * Register a child process for tracking and cancellation.
 */
function registerChildProcess(projectId, taskIndex, process) {
  executionState.childProcesses.push({ projectId, taskIndex, process });
}

/**
 * Unregister a child process after it exits.
 */
function unregisterChildProcess(projectId, taskIndex) {
  executionState.childProcesses = executionState.childProcesses.filter(
    cp => !(cp.projectId === projectId && cp.taskIndex === taskIndex)
  );
}

// --- State Management Helpers ---

function getState() {
  try {
    if (!fs.existsSync(PROMPTS_FILE)) {
      return { projects: [], activeProjectId: null, aiderConfig: {} };
    }
    const data = fs.readFileSync(PROMPTS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading state file:', err);
    return { projects: [], activeProjectId: null, aiderConfig: {} };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(PROMPTS_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving state file:', err);
  }
}

function resetState() {
  const state = getState();
  const activeProject = state.projects.find(p => p.id === state.activeProjectId);
  if (activeProject && Array.isArray(activeProject.tasks)) {
    activeProject.tasks = activeProject.tasks.map(task => ({ ...task, state: 'pending' }));
  }
  saveState(state);
}

// --- Log Helpers ---

/**
 * Append an entry to a Cline session log file in real-time using synchronous writes.
 * Uses JSONL format (one JSON object per line) for atomic, race-condition-free writes.
 * Also buffers events in memory via clineSessionCache for session log saving.
 * Checks for completion triggers and auto-triggers the next pending task.
 * @param {string} sessionId - The session ID (filename without .json)
 * @param {object} entry - The log entry to append
 */
function appendToClineLog(sessionId, entry) {
  const filePath = path.join(logsDir, `${sessionId}.json`);
  
  // Ensure logs directory exists (synchronous)
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Write as a JSONL line for atomic, race-condition-free appends
  const line = JSON.stringify(entry) + '\n';
  try {
    fs.appendFileSync(filePath, line);
  } catch (err) {
    console.error(`[CLINE LOG] Error writing log ${sessionId}:`, err.message);
  }

  // Buffer event in memory for session log saving (avoids re-reading from disk)
  if (!clineSessionCache.has(sessionId)) {
    clineSessionCache.set(sessionId, []);
  }
  clineSessionCache.get(sessionId).push(entry);

  // Check for completion trigger to auto-start next task
  checkClineCompletionAndTriggerNext(sessionId, entry);
}

/**
 * Track file activity for a session — updates the last activity timestamp.
 * Called whenever a file is created or edited. Used to detect when Cline has stopped
 * making changes (quiet period = all file operations are done).
 */
function trackFileActivity(sessionId) {
  const now = Date.now();
  fileActivityTimestamps.set(sessionId, now);

  // If a completion signal was already seen, reset it — Cline is still working
  if (completionSignalTimestamps.has(sessionId)) {
    console.log(`[FILE ACTIVITY] File edit detected after completion signal in ${sessionId} — resetting, Cline is still working.`);
    completionSignalTimestamps.delete(sessionId);
  }
}

/**
 * Check if a Cline log entry signals completion, and trigger the next pending task.
 * 
 * NEW BEHAVIOR (quiet-period based):
 * 1. Track all file edit/new-file events to know when Cline is still working
 * 2. When a completion signal arrives, note it but DON'T trigger yet
 * 3. Wait for FILE_ACTIVITY_QUIET_PERIOD ms of no file activity
 * 4. If session_end arrives before quiet period expires, trigger immediately after a short delay
 * 
 * This prevents premature triggering when Cline emits completion_result but then
 * continues editing files (e.g., creating a JS file, then going back to edit HTML).
 */
function checkClineCompletionAndTriggerNext(sessionId, entry) {
  // ── GUARD: Defer to the Kanban Play-queue orchestrator while a run is active ──
  // The /api/project/:id/tasks/orchestrate endpoint owns task sequencing via
  // runNextTask() — it waits for each child process to exit, then schedules the
  // next task itself. If we ALSO chain from the log watcher here, both schedulers
  // race to launch the next task. The dedup guards (pendingTriggerSet,
  // activeSessions) absorb the duplicate, but the loser is returned as
  // { success:false, error:'Session already active' }, which the orchestrator
  // then counts as a failed task. So while orchestration is running, this
  // legacy log-driven chainer must stay out of the way.
  if (executionState.running) {
    return;
  }

  // Extract taskIndex from session ID to ensure affine mapping
  const sessionKey = extractSessionKey(sessionId);

  if (!sessionKey) {
    return;
  }

  const state = getState();
  const activeProject = state.projects.find(p => p.id === state.activeProjectId);

  if (!activeProject) {
    return;
  }

  const nextTaskIndex = sessionKey.taskIndex + 1;

  // Prevent duplicate triggering for the same session
  if (alreadyTriggeredSessions.has(sessionId)) {
    return;
  }

  // ── GUARD: Only auto-trigger if the next task is marked for orchestration (orchestrate: true) ──
  // This prevents manual "Send" clicks from auto-triggering subsequent tasks.
  // Auto-triggering only happens when the user explicitly selected tasks via orchestration toggles.
  if (nextTaskIndex < activeProject.tasks.length) {
    const nextTask = activeProject.tasks[nextTaskIndex];
    if (!nextTask || !nextTask.orchestrate) {
      console.log(`[COMPLETION] Task ${nextTaskIndex} is not marked for orchestration (orchestrate: ${nextTask?.orchestrate ?? 'N/A'}), skipping auto-trigger. This prevents manual sends from queuing prompts.`);
      return;
    }
  }

  // ── STEP 1: Track file activity ──
  // Detect file-creating/editing events and update the activity timestamp
  const isFileActivity = (
    entry.type === 'file_created' ||
    entry.type === 'editedExistingFile' ||
    (entry.type === 'cline_output' && entry.data && (
      entry.data.tool_name === 'write_to_file' ||
      entry.data.tool?.name === 'write_to_file' ||
      entry.data.tool_name === 'editedExistingFile' ||
      entry.data.tool?.name === 'editedExistingFile'
    ))
  );

  if (isFileActivity) {
    trackFileActivity(sessionId);
    return; // Don't trigger on file activity alone
  }

  // ── STEP 2: Detect completion signals ──
  let isCompletionSignal = false;

  if (entry.type === 'completion_tag') {
    isCompletionSignal = true;
  } else if (entry.type === 'cline_output' && entry.data) {
    if (entry.data.type === 'say' && entry.data.say === 'completion_result') {
      isCompletionSignal = true;
    }
    if (entry.data.tool_name === 'attempt_completion' || entry.data.tool?.name === 'attempt_completion') {
      isCompletionSignal = true;
    }
    // Newer Cline builds emit success via submit_and_exit tool call or a
    // run_result/done event with reason "completed".
    const ev = entry.data.event;
    if (ev) {
      if (ev.type === 'content_start' && ev.contentType === 'tool' && ev.toolName === 'submit_and_exit') {
        isCompletionSignal = true;
      }
      if (ev.type === 'done' && ev.reason === 'completed') {
        isCompletionSignal = true;
      }
    }
    if (entry.data.type === 'run_result' && entry.data.finishReason === 'completed') {
      isCompletionSignal = true;
    }
  } else if (entry.type === 'say' && entry.say === 'completion_result') {
    isCompletionSignal = true;
  } else if (entry.tool_name === 'attempt_completion' || entry.tool?.name === 'attempt_completion') {
    isCompletionSignal = true;
  }

  if (isCompletionSignal) {
    // Record when the completion signal was received
    const sigTime = Date.now();
    completionSignalTimestamps.set(sessionId, sigTime);

    // Check if we've had FILE_ACTIVITY_QUIET_PERIOD ms of no file activity
    const lastFileActivity = fileActivityTimestamps.get(sessionId) || 0;
    const timeSinceLastFileEdit = sigTime - lastFileActivity;

    if (timeSinceLastFileEdit >= FILE_ACTIVITY_QUIET_PERIOD) {
      // No file edits since completion signal — safe to trigger after a short delay
      console.log(`[COMPLETION] File activity quiet period met in ${sessionId}. Triggering next task: ${nextTaskIndex}`);
      scheduleNextTaskTrigger(activeProject.id, nextTaskIndex, sessionId);
    } else {
      console.log(`[COMPLETION] Completion signal in ${sessionId} but file edits happened ${timeSinceLastFileEdit}ms ago. Starting quiet period timer (${FILE_ACTIVITY_QUIET_PERIOD}ms).`);
      // Start a timer — if no more file edits during the quiet period, trigger
      startQuietPeriodTimer(sessionId, activeProject.id, nextTaskIndex);
    }
    return;
  }

  // ── STEP 3: Detect session_end (process exit) — definitive completion signal ──
  if (entry.type === 'session_end') {
    // Clean up tracking state for this session
    alreadyTriggeredSessions.add(sessionId);

    // Use ?? so a clean exit (code 0) isn't misread as -1 (|| treats 0 as falsy).
    const exitCode = entry.exitCode ?? -1;
    const lastFileActivity = fileActivityTimestamps.get(sessionId) || 0;

    if (exitCode === 0 && nextTaskIndex < activeProject.tasks.length) {
      // Process exited cleanly — trigger next task after a brief delay to ensure log is fully written
      console.log(`[SESSION_END] Session ${sessionId} exited cleanly (code ${exitCode}). Scheduling next task: ${nextTaskIndex}`);

      // If there was recent file activity, wait for quiet period
      const timeSinceLastActivity = Date.now() - lastFileActivity;
      if (timeSinceLastActivity < FILE_ACTIVITY_QUIET_PERIOD) {
        console.log(`[SESSION_END] Recent file activity detected (${timeSinceLastActivity}ms ago), waiting for quiet period.`);
        startQuietPeriodTimer(sessionId, activeProject.id, nextTaskIndex, true);
      } else {
        scheduleNextTaskTrigger(activeProject.id, nextTaskIndex, sessionId);
      }
    } else if (exitCode !== 0) {
      console.log(`[SESSION_END] Session ${sessionId} exited with code ${exitCode}. Task may have failed.`);
    }

    // Clean up tracking state
    fileActivityTimestamps.delete(sessionId);
    completionSignalTimestamps.delete(sessionId);

    return;
  }
}

/**
 * Start a quiet period timer. If no file activity occurs during this period, trigger the next task.
 * @param {string} sessionId - The session ID
 * @param {string} projectId - The project ID
 * @param {number} nextTaskIndex - The index of the task to trigger
 * @param {boolean} forceTrigger - If true, trigger even if file activity occurs during the timer (used for session_end)
 */
function startQuietPeriodTimer(sessionId, projectId, nextTaskIndex, forceTrigger = false) {
  // Clear any existing timer for this session
  const existingTimerKey = `quiet_${sessionId}`;
  if (global._completionTimers && global._completionTimers.has(existingTimerKey)) {
    clearTimeout(global._completionTimers.get(existingTimerKey));
  }
  if (!global._completionTimers) {
    global._completionTimers = new Map();
  }

  const timer = setTimeout(() => {
    global._completionTimers.delete(existingTimerKey);

    // Check if new file activity arrived during the quiet period
    const lastActivity = fileActivityTimestamps.get(sessionId) || 0;
    const timerStart = timer._startTimestamp;
    const timeSinceLastActivity = Date.now() - lastActivity;

    if (timeSinceLastActivity >= FILE_ACTIVITY_QUIET_PERIOD || forceTrigger) {
      // Quiet period met — trigger next task
      console.log(`[QUIET PERIOD] No file activity for ${FILE_ACTIVITY_QUIET_PERIOD}ms in ${sessionId}. Triggering next task: ${nextTaskIndex}`);
      scheduleNextTaskTrigger(projectId, nextTaskIndex, sessionId);
    } else {
      // New file activity — restart the timer
      console.log(`[QUIET PERIOD] File activity detected during quiet period in ${sessionId}, restarting timer.`);
      startQuietPeriodTimer(sessionId, projectId, nextTaskIndex, forceTrigger);
    }
  }, FILE_ACTIVITY_QUIET_PERIOD);

  // Store the start timestamp for accurate calculation in the callback
  timer._startTimestamp = Date.now();
  global._completionTimers.set(existingTimerKey, timer);
}

/**
 * Schedule the next task trigger with a small delay to ensure all log writes are complete.
 * Uses setImmediate to defer execution to the next event loop tick.
 */
function scheduleNextTaskTrigger(projectId, nextTaskIndex, sessionId) {
  // Double-check we haven't already triggered
  if (alreadyTriggeredSessions.has(sessionId)) {
    return;
  }

  // Cooldown check: prevent triggering next task too soon after a completion
  const cooldownKey = `${projectId}:${nextTaskIndex}`;
  const lastTriggerTime = completionCooldowns.get(cooldownKey);
  if (lastTriggerTime && (Date.now() - lastTriggerTime) < TASK_COMPLETION_COOLDOWN) {
    console.log(`[COMPLETION] Cooldown active for task ${nextTaskIndex}, skipping duplicate trigger.`);
    return;
  }

  // Record the trigger time for cooldown enforcement
  completionCooldowns.set(cooldownKey, Date.now());

  // Mark as triggered to prevent duplicates
  alreadyTriggeredSessions.add(sessionId);

  console.log(`[COMPLETION] Scheduling next task trigger: ${nextTaskIndex} for project ${projectId}`);

  // Use setImmediate to defer execution, allowing any pending log writes to complete
  setImmediate(() => {
    // Re-check state before triggering (in case something changed)
    const currentState = getState();
    const currentProject = currentState.projects.find(p => p.id === projectId);

    if (currentProject && nextTaskIndex < currentProject.tasks.length &&
        currentProject.tasks[nextTaskIndex].state === 'pending') {
      console.log(`[COMPLETION] Executing deferred next task trigger: ${nextTaskIndex}`);
      executeTaskWithAutoChain(projectId, nextTaskIndex);
    } else {
      const taskState = currentProject ? currentProject.tasks[nextTaskIndex]?.state : 'N/A';
      console.log(`[COMPLETION] Next task ${nextTaskIndex} is no longer pending (state: ${taskState}), skipping.`);
    }
  });
}

function getMostRecentSessionId() {
  try {
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.json') && !f.startsWith('headless_'));
    if (files.length === 0) return null;
    let newestFile = null;
    let newestTime = 0;
    files.forEach(file => {
      const stats = fs.statSync(path.join(logsDir, file));
      if (stats.mtimeMs > newestTime) {
        newestTime = stats.mtimeMs;
        newestFile = file;
      }
    });
    if (newestFile) {
      const now = Date.now();
      const thirtyMinutesAgo = now - 30 * 60 * 1000;
      if (newestTime > thirtyMinutesAgo) {
        return path.basename(newestFile, '.json');
      }
    }
  } catch (err) {
    console.error('Error finding most recent session:', err);
  }
  return null;
}

/**
 * Extract projectTitle and taskIndex from a session ID.
 * Session ID format: {projectTitle}_{agentName}_task_{taskIndex}_{timestamp}
 * Example: testbench_cline_task_0_2026-04-21T16-20-44
 */
function extractSessionKey(sessionId) {
  const match = sessionId.match(/^(.+)_(aider|cline|baton-code-thinking|baton-code)_task_(\d+)_/);
  if (match) {
    return {
      projectTitle: match[1],
      agentName: match[2],
      taskIndex: parseInt(match[3], 10)
    };
  }
  return null;
}

/**
 * Find a project by its sanitized title (projectTitle used in session IDs).
 */
function findProjectByTitle(state, projectTitle) {
  return state.projects.find(p => 
    (p.name || p.id).replace(/[^a-zA-Z0-9_-]/g, '_') === projectTitle
  );
}

function isCompletionEntry(entry) {
  if (!entry) return false;

  // Handle the structure seen in headless logs: entry might be an event or a wrapper
  const events = Array.isArray(entry) ? entry : (entry.events || [entry]);

  return events.some(event => {
    if (event.type === 'cline_output' && event.data) {
      return event.data.type === 'say' && event.data.say === 'completion_result';
    }
    // Also check if the entry itself is the data object
    if (event.type === 'say' && event.say === 'completion_result') {
      return true;
    }
    // Check for TASK NUMBER N COMPLETE marker format (unified completion signal)
    const textToCheck = event.text || JSON.stringify(event.data || '');
    if (/TASK NUMBER \d+ COMPLETE/i.test(textToCheck)) {
      return true;
    }
    return false;
  });
}

function appendToLog(requestId, entry) {
  const filePath = path.join(logsDir, `${requestId}.json`);

  // Ensure logs directory exists (synchronous)
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Check if this is a new session by reading the first line of the file
  let isNewSession = true;
  try {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing.length > 0) {
      isNewSession = false;
    }
  } catch (e) {
    // File doesn't exist yet - new session
    isNewSession = true;
  }

  // NOTE: Task execution is NOT triggered by appendToLog.
  // All completion detection for Cline tasks happens exclusively in checkClineCompletionAndTriggerNext()
  // which is called from appendToClineLog(). This prevents duplicate task triggering.
  // For non-Cline tasks, the child.on('close') handler in executeAgentTask() handles completion.

  // Write as a JSONL line for atomic, race-condition-free appends
  const line = JSON.stringify(entry) + '\n';
  try {
    fs.appendFileSync(filePath, line);
  } catch (err) {
    console.error('Error writing exchange log:', err.message);
  }
}

// --- Middleware ---

app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));

// Serve static files from the project root (styles.css, index.html) and modules/ directory
app.use(express.static(path.join(__dirname)));

// Remove CSP header that Express 5's finalhandler may set on error pages.
// This single middleware runs after static serving and strips CSP from all responses.
app.use((req, res, next) => {
  // Store original methods
  const originalSetHeader = res.setHeader.bind(res);
  
  // Override setHeader to drop CSP headers
  res.setHeader = function(name, value) {
    if (name && typeof name === 'string' && name.toLowerCase() === 'content-security-policy') {
      return res;
    }
    return originalSetHeader(name, value);
  };
  
  next();
});

app.use((req, res, next) => {
  let requestId = req.headers['x-session-id'] || req.cookies.sessionId;
  if (!requestId) {
    requestId = getMostRecentSessionId();
    if (!requestId) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      requestId = `${timestamp}_${Math.random().toString(36).substr(2, 9)}`;
    }
    res.setHeader('x-session-id', requestId);
    res.cookie('sessionId', requestId, { httpOnly: true });
  }
  const logEntry = {
    id: requestId,
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
    body: req.body,
  };
  console.log(`Incoming Request [${requestId}]:`, JSON.stringify(logEntry, null, 2));
  req.requestId = requestId;
  next();
});

// ── Health Check Endpoint ───────────────────────────────────────────
// Provides a simple endpoint to verify the server is running.
// Useful for Docker health checks, monitoring, and CI/CD pipelines.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: require('./package.json').version
  });
});

// ── Working Directory Safety ─────────────────────────────────────────

/**
 * Resolve a working directory path and validate it is NOT the BatonBot directory
 * or any parent of it. This prevents an agent from accidentally modifying
 * BatonBot's own codebase (index.js, prompts.json, modules/, etc.).
 *
 * @param {string} cwd - The working directory (may be relative)
 * @param {string} projectId - Project ID for logging context
 * @returns {{ cwd: string, safe: boolean, reason?: string }}
 */
function validateWorkingDirectory(cwd, projectId) {
  const resolved = path.resolve(cwd);
  const batonbotDir = path.resolve(__dirname);

  // Fall back to '.' resolves to BatonBot's own directory - log a warning
  if (cwd === '.' || cwd === '') {
    console.warn(`[ISOLATION] Project ${projectId} has no explicit workingDirectory - defaulting to '.' which resolves to the BatonBot directory (${batonbotDir}). Agent will run here, which may corrupt BatonBot files.`);
  }

  // Block if the resolved path IS the BatonBot directory
  if (resolved === batonbotDir) {
    return {
      cwd: resolved,
      safe: false,
      reason: `Working directory (${resolved}) is the BatonBot directory itself. Refusing to run agent to prevent self-corruption.`
    };
  }

  // Block if the resolved path is a PARENT of the BatonBot directory
  // (e.g., /Users/michaeldoty/dev/preprod contains batonbot)
  if (batonbotDir.startsWith(resolved + path.sep) || batonbotDir.startsWith(resolved + '/')) {
    return {
      cwd: resolved,
      safe: false,
      reason: `Working directory (${resolved}) is a parent of the BatonBot directory. Refusing to run agent to prevent accidental edits to BatonBot files.`
    };
  }

  return { cwd: resolved, safe: true };
}

// --- Git Initialization Helper ---

function ensureGitInitialized(workingDir) {
  return new Promise((resolve) => {
    const gitDir = path.join(workingDir, '.git');
    if (fs.existsSync(gitDir)) {
      console.log(`[GIT] Git repository already initialized in ${workingDir}`);
      resolve(true);
      return;
    }

    console.log(`[GIT] Initializing git repository in ${workingDir}...`);
    const initProcess = spawnCompat('git', ['init'], { cwd: workingDir });
    
    initProcess.on('exit', (code) => {
      if (code === 0 || code === null) {
        console.log(`[GIT] Successfully initialized git repository in ${workingDir}`);
        resolve(true);
      } else {
        console.error(`[GIT] Failed to initialize git in ${workingDir} (exit code: ${code})`);
        resolve(false);
      }
    });

    initProcess.stderr.on('data', (data) => {
      console.error(`[GIT][stderr]: ${data.toString().trim()}`);
    });
  });
}

// --- Agent Strategy Registry ---

/**
 * Sanitize a prompt by removing "(see below for file content)" annotations inside code blocks.
 * The Cline CLI has a feature that scans for "path" (see below for file content) patterns
 * and attempts to read those files. However, it misfires on quoted strings inside code
 * blocks (e.g., TypeScript imports like `from "lib/db" (see below...)`), extracting
 * malformed paths with trailing quotes. This function strips those annotations from
 * inside fenced code blocks to prevent the issue.
 * @param {string} prompt - The raw prompt text
 * @returns {string} The sanitized prompt
 */
function sanitizePromptForCline(prompt) {
  // Match fenced code blocks (``` ... ```) and remove "(see below for file content)" patterns inside them
  return prompt.replace(/(```[\s\S]*?```)/g, (codeBlock) => {
    return codeBlock.replace(/\s*\(see below for file content\)/g, '');
  });
}

/**
 * Build environment for agent processes.
 * Merges system env with agent-specific overrides (filtered to non-empty values).
 */
function buildEnv(agentName, config) {
  const base = agentName === 'aider' ? getAiderConfig({}) : {};
  return Object.assign(
    {},
    process.env,
    ...Object.entries(base).filter(([, v]) => v),
    ...(agentName === 'aider' ? getAiderConfig(config) : {}),
    ...Object.entries(agentName === 'cline' ? {} : (agentName === 'aider' ? getAiderConfig(config) : {})).filter(([, v]) => v)
  );
}

/**
 * Build structured context from all previously completed tasks in the pipeline.
 * Returns a markdown string with summaries of completed tasks, or null if none.
 */
function buildPreviousTasksContext(project, currentTaskIndex) {
  if (!project || !project.tasks) return null;

  const completedTasks = [];

  for (let i = 0; i < currentTaskIndex; i++) {
    const task = project.tasks[i];
    if (task && task.state === 'done') {
      completedTasks.push({
        index: i,
        prompt: task.prompt,
        summary: task.summary || '(no summary)',
        filesCreated: task.filesCreated || [],
        filesModified: task.filesModified || [],
        commandsRun: task.commandsRun || []
      });
    }
  }

  if (completedTasks.length === 0) return null;

  const parts = ['# Completed Previous Tasks', ''];
  for (const t of completedTasks) {
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
 * Build a structured task summary from the executeCodingAgent result.
 */
function buildTaskSummary(result, taskIndex, projectId, filesModified) {
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
 * Persist a structured task summary into the project state.
 */
function persistTaskSummary(projectId, taskIndex, taskSummary) {
  const state = getState();
  const project = state.projects.find(p => p.id === projectId);
  if (project && project.tasks[taskIndex]) {
    Object.assign(project.tasks[taskIndex], taskSummary);
    saveState(state);
    console.log(`[BATON-CODE] Persisted task summary for task ${taskIndex}: ${taskSummary.summary?.slice(0, 80) || '(empty)'}...`);
  }
}

// Helper to build a baton-code agent registry entry from a config module
function buildBatonCodeAgentEntry(agentConfig) {
  return {
    name: agentConfig.name,
    isHttpAgent: agentConfig.isHttpAgent,
    send_message: async (prompt, config, cwd, projectId, taskContext) => {
      const state = getState();
      const llmConfig = getAiderConfig(projectId);

      if (!llmConfig.apiBase || !llmConfig.apiKey) {
        throw new Error('LLM API base URL and key are required. Configure in Settings.');
      }

      // Generate session ID for persistent log files (same format as Cline/Aider)
      const projectTitle = (state.projects.find(p => p.id === projectId)?.name || projectId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const taskIndex = (taskContext && taskContext.taskIndex !== undefined) ? taskContext.taskIndex : 0;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const sessionId = `${projectTitle}_${agentConfig.agentKey}_task_${taskIndex}_${timestamp}`;

      // Track files modified via replace_in_file calls during this session
      const filesModified = [];

      // ── Inject Previous Task Context ──
      // Build structured context from all previously completed tasks in the pipeline
      // so the new task inherits knowledge about what was done.
      const project = state.projects.find(p => p.id === projectId);
      const previousContext = buildPreviousTasksContext(project, taskIndex);

      let enrichedPrompt = prompt;
      if (previousContext) {
        enrichedPrompt = `The context below was automatically inherited from previous tasks in this pipeline. Review it during your planning phase to understand the current state of the codebase.

${previousContext}

---

${prompt}`;
        console.log(`[BATON-CODE] Injected previous tasks context (${previousContext.length} chars) into task ${taskIndex}`);
      } else {
        console.log(`[BATON-CODE] No previous task context to inject for task ${taskIndex}`);
      }

      // Write session_start event
      appendToClineLog(sessionId, {
        type: 'session_start',
        timestamp: new Date().toISOString(),
        projectId,
        taskIndex,
        prompt,
        workingDirectory: cwd || process.cwd()
      });

      const result = await executeCodingAgent(
        enrichedPrompt,
        cwd || process.cwd(),
        {
          apiBase: llmConfig.apiBase,
          apiKey: llmConfig.apiKey,
          model: llmConfig.model,
          projectId: projectId,
          enableThinking: agentConfig.enableThinking,
          onLog: (event) => {
            // Log to console for real-time terminal output
            console.log(`[BATON-CODE] [${event.type}] ${event.message || event.toolName || JSON.stringify(event)}`);

            // Write to persistent log file (same format as Cline sessions)
            const logEntry = {
              type: event.type || 'stdout',
              timestamp: event.timestamp || new Date().toISOString(),
              iteration: event.iteration,
            };

            // Map Baton Code agent events to log-friendly formats
            if (event.type === 'agent_start') {
              logEntry.prompt = event.prompt;
              logEntry.workingDir = event.workingDir;
              logEntry.model = event.model;
            } else if (event.type === 'llm_response') {
              logEntry.content = event.content;
              logEntry.toolCallCount = event.toolCallCount;
            } else if (event.type === 'tool_call') {
              logEntry.toolName = event.toolName;
              logEntry.toolCallId = event.toolCallId;
              logEntry.args = event.args;
            } else if (event.type === 'tool_result') {
              logEntry.toolName = event.toolName;
              logEntry.toolCallId = event.toolCallId;
              logEntry.success = event.success;
              logEntry.resultPreview = event.resultPreview;
            } else if (event.type === 'agent_end') {
              logEntry.success = event.success;
              logEntry.summary = event.summary;
            } else if (event.type === 'error') {
              logEntry.message = event.message;
            } else if (event.type === 'file_created' || event.type === 'file_edited') {
              logEntry.filePath = event.filePath;
            } else if (event.type === 'plan_start') {
              logEntry.message = event.message;
            } else if (event.type === 'plan_summary') {
              logEntry.message = event.message;
              logEntry.checklist = event.checklist || null;
              logEntry.planSummary = event.planSummary || '';
              logEntry.keyFindings = event.keyFindings || '';
            } else if (event.type === 'plan_end') {
              logEntry.message = event.message;
            } else if (event.type === 'thinking_start') {
              logEntry.message = event.message;
            } else if (event.type === 'thinking_chunk') {
              logEntry.content = event.content;
              logEntry.message = event.message;
            } else if (event.type === 'thinking_end') {
              logEntry.content = event.content;
              logEntry.message = event.message;
            }

            // ── Plan phase state management ──
            // Handle plan_start: transition task to 'planning' state
            if (event.type === 'plan_start') {
              const planState = getState();
              const planProject = planState.projects.find(p => p.id === projectId);
              if (planProject && planProject.tasks[taskIndex]) {
                planProject.tasks[taskIndex].state = 'planning';
                saveState(planState);
                console.log(`[BATON-CODE] Task ${taskIndex} state -> planning`);
              }
              // Broadcast plan_start via SSE
              broadcastEvent(projectId, {
                type: 'plan_start',
                taskIndex,
                timestamp: event.timestamp || new Date().toISOString(),
                message: event.message || 'Starting planning phase...'
              });
            }

            // Handle plan_summary: store plan data on task object and broadcast
            if (event.type === 'plan_summary') {
              const planState = getState();
              const planProject = planState.projects.find(p => p.id === projectId);
              if (planProject && planProject.tasks[taskIndex]) {
                planProject.tasks[taskIndex].planSummary = event.planSummary || '';
                planProject.tasks[taskIndex].keyFindings = event.keyFindings || '';
                if (event.checklist) {
                  planProject.tasks[taskIndex].planChecklist = event.checklist;
                }
                saveState(planState);
              }
              // Broadcast plan_summary via SSE
              broadcastEvent(projectId, {
                type: 'plan_summary',
                taskIndex,
                timestamp: event.timestamp || new Date().toISOString(),
                checklist: event.checklist || null,
                planSummary: event.planSummary || '',
                keyFindings: event.keyFindings || '',
                message: event.message || 'Planning summary available'
              });
            }

            // Handle plan_end: transition from 'planning' to 'in_progress'
            if (event.type === 'plan_end') {
              const planState = getState();
              const planProject = planState.projects.find(p => p.id === projectId);
              if (planProject && planProject.tasks[taskIndex]) {
                planProject.tasks[taskIndex].state = 'in_progress';
                saveState(planState);
                console.log(`[BATON-CODE] Task ${taskIndex} state -> in_progress (execution phase)`);
              }
              // Broadcast plan_end via SSE
              broadcastEvent(projectId, {
                type: 'plan_end',
                taskIndex,
                timestamp: event.timestamp || new Date().toISOString(),
                message: event.message || 'Planning phase complete, starting execution'
              });
            }

            // ── Thinking event SSE broadcasting ──
            if (event.type === 'thinking_start') {
              broadcastEvent(projectId, {
                type: 'thinking_start',
                taskIndex,
                timestamp: event.timestamp || new Date().toISOString(),
                message: event.message || 'Agent is thinking...'
              });
            }

            if (event.type === 'thinking_chunk') {
              broadcastEvent(projectId, {
                type: 'thinking_chunk',
                taskIndex,
                timestamp: event.timestamp || new Date().toISOString(),
                content: event.content || '',
                message: event.message || ''
              });
            }

            if (event.type === 'thinking_end') {
              broadcastEvent(projectId, {
                type: 'thinking_end',
                taskIndex,
                timestamp: event.timestamp || new Date().toISOString(),
                content: event.content || '',
                message: event.message || 'Agent finished thinking'
              });
            }

            // Track file activity for completion detection
            if (event.type === 'tool_result' && event.toolName === 'write_to_file') {
              trackFileActivity(sessionId);
            }

            // Track file modifications from replace_in_file calls
            if (event.type === 'tool_call' && event.toolName === 'replace_in_file' && event.args?.path) {
              if (!filesModified.includes(event.args.path)) {
                filesModified.push(event.args.path);
              }
            }

            appendToClineLog(sessionId, logEntry);
          }
        }
      );

      // Write session_end event with final result
      appendToClineLog(sessionId, {
        type: 'session_end',
        timestamp: new Date().toISOString(),
        exitCode: result.success ? 0 : 1,
        success: result.success,
        summary: result.summary || '',
        iterations: result.iterations,
        filesCreated: result.filesCreated || [],
        commandsRun: result.commandsRun || [],
        error: result.error || null
      });

      // Build structured task summary from the agent result
      const taskSummary = buildTaskSummary(result, taskIndex, projectId, filesModified);

      // Handle context overflow: inject spawned tasks before returning
      if (result.overflow && taskContext) {
        const { taskIndex, agentName } = taskContext;
        const spawned = buildSpawnedTasks(result.checklist, result.originalPrompt, agentName, taskIndex);

        if (spawned.length > 0) {
          const currentState = getState();
          const project = currentState.projects.find(p => p.id === projectId);
          if (project) {
            // Persist structured summary on the original task before marking done
            Object.assign(project.tasks[taskIndex], taskSummary);
            project.tasks[taskIndex].state = 'done';
            project.tasks[taskIndex].splitSummary = result.summary || 'Task split due to context limits';

            // Insert spawned tasks after the current task index
            project.tasks.splice(taskIndex + 1, 0, ...spawned);

            // Reassign IDs
            project.tasks.forEach((t, i) => { t.id = i; });

            saveState(currentState);
            console.log(`[BATON-CODE] Overflow: injected ${spawned.length} spawned task(s) at index ${taskIndex + 1} for project ${projectId}. Pipeline now has ${project.tasks.length} tasks.`);
          }
        }
      } else {
        // Normal (non-overflow) success path: persist structured summary
        persistTaskSummary(projectId, taskIndex, taskSummary);
      }

      return { success: true, result };
    }
  };
}

const AGENT_REGISTRY = {
  'baton-code': buildBatonCodeAgentEntry(batonCodeAgent),
  'baton-code-thinking': buildBatonCodeAgentEntry(batonCodeThinkingAgent),
  aider: {
    name: 'Aider',
    getCommand: (prompt, config) => ({
      command: 'aider',
      args: ['--yes-always', '--message', prompt, '--no-gitignore']
    }),
    getEnv: (config) => ({
      OPENAI_API_BASE: config.apiBase || '',
      OPENAI_API_KEY: config.apiKey || '',
      MODEL: config.model ? `openai/${config.model}` : ''
    }),
    handleOutput: (data, context) => {
      console.log(`[AIDER][task-${context.taskIndex}]: ${data.toString().trim()}`);
    },
    checkCompletion: (code, output) => code === 0
  },
  telegram: {
    name: 'Telegram',
    isHttpAgent: true, // Signals executeAgentTask to use HTTP path instead of spawn
    send_message: async (prompt, config) => {
      if (!config.botToken || !config.chatId) {
        throw new Error('Telegram bot token and chat ID are required. Configure in Settings → Telegram tab.');
      }
      const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
      const resp = await axios.post(url, {
        chat_id: config.chatId,
        text: prompt,
        parse_mode: 'HTML'
      });
      if (!resp.data.ok) {
        throw new Error(`Telegram API error: ${resp.data.description || 'unknown error'}`);
      }
      return resp.data;
    }
  },
  cline: {
    name: 'Cline',
    getCommand: (prompt, config, taskIndex) => {
      // ── v3.0.2 strategy: env-vars + flags, no providers.json injection ──
      //
      // Earlier versions (v3.0.1 and before) wrote a per-spawn providers.json
      // into a temp --data-dir and passed it to Cline. Testing on Windows
      // showed Cline's Bun-bundled CLI ignores providers.json from a custom
      // --data-dir and *only* reads auth from:
      //   1) Environment variables (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENAI_API_BASE)
      //   2) The user's persisted ~/.cline auth (set via `cline auth …`)
      // So the providers.json injection was dead code that just added
      // surface area for Windows-specific spawn issues.
      //
      // New strategy: tell Cline which provider via `-P <provider>`, which
      // model via `-m <model>`, and pass the API key through the spawn env
      // (handled in getEnv below). For LM Studio we don't pass `-P` so Cline
      // uses its default provider lookup.
      //
      // Escape hatch (`BATONBOT_NO_AUTO_AUTH=1`) still skips both `-P` and
      // any env-var injection so power-users with custom `cline auth` setups
      // can opt out of BatonBot's involvement entirely.
      const args = ['--json', '-y'];
      const SKIP_INJECTION = process.env.BATONBOT_NO_AUTO_AUTH === '1';

      if (!SKIP_INJECTION && (config.apiBase || config.model)) {
        if (!config.model) {
          throw new Error('Cline model is not configured. Set it in Settings → LLM Configuration (e.g. "claude-sonnet-4-6").');
        }

        const apiBaseLower = (config.apiBase || '').toLowerCase();
        let providerType = 'openai';
        if (apiBaseLower.includes('anthropic.com')) {
          providerType = 'anthropic';
        } else if (!config.apiBase || apiBaseLower.includes('localhost') || apiBaseLower.includes('127.0.0.1')) {
          providerType = 'lmstudio';
        } else {
          providerType = 'openai';
        }

        // Tell Cline which provider to use. Auth keys travel via env (see getEnv).
        args.push('-P', providerType);
        console.log(`[CLINE] Using ${providerType} provider (auth via env vars; no providers.json injection)`);
      }

      if (config.model) {
        args.push('-m', config.model);
      }
      args.push(sanitizePromptForCline(prompt));
      return { command: 'cline', args };
    },
    getEnv: (config) => {
      // Cline's SDKs require API keys as environment variables regardless of
      // whether the key is also written to providers.json:
      // - Anthropic SDK (@anthropic-ai/sdk) requires ANTHROPIC_API_KEY
      // - OpenAI SDK requires OPENAI_API_KEY
      // The providers.json provides the baseUrl/model config, but the SDKs
      // still read the auth key from the environment.
      if (config.apiBase || config.model) {
        const env = {
          MODEL: config.model || ''
        };
        const apiBaseLower = (config.apiBase || '').toLowerCase();
        if (apiBaseLower.includes('anthropic.com')) {
          env.ANTHROPIC_API_KEY = config.apiKey || '';
        } else if (!apiBaseLower.includes('localhost') && !apiBaseLower.includes('127.0.0.1')) {
          // OpenAI-compatible providers (Grok, OpenAI, etc.) need OPENAI_API_KEY
          env.OPENAI_API_KEY = config.apiKey || '';
        }
        // LM Studio (localhost / 127.0.0.1) doesn't need an API key
        return env;
      }
      return {
        OPENAI_API_BASE: config.apiBase || '',
        OPENAI_API_KEY: config.apiKey || '',
        MODEL: config.model || ''
      };
    },
    handleOutput: (data, context) => {
      const text = data.toString();
      console.log(`[CLINE][task-${context.taskIndex}]: ${text.trim()}`);

      // Parse JSON lines and log each event to the session log
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const event = {
            type: 'cline_output',
            timestamp: new Date().toISOString(),
            data: parsed
          };

          if (parsed.tool_name === 'write_to_file' || parsed.tool?.name === 'write_to_file') {
            const filePath = parsed.input?.path || parsed.arguments?.path;
            if (filePath) {
              event.type = 'file_created';
              event.filePath = filePath;
            }
          }

          if (parsed.tool_name === 'attempt_completion' || parsed.tool?.name === 'attempt_completion') {
            event.type = 'completion_tag';
            event.result = parsed.input?.result || parsed.arguments?.result;
          }

          if (parsed.tool_name || parsed.tool?.name) {
            const toolName = parsed.tool_name || parsed.tool.name;
            event.type = 'tool_use';
            event.toolName = toolName;
          }

          appendToClineLog(context.sessionId, event);
        } catch (e) {
          appendToClineLog(context.sessionId, {
            type: 'stdout',
            timestamp: new Date().toISOString(),
            text: line.trim()
          });
        }
      }
    },
    checkCompletion: (code, output) => (code === 0) || output.toLowerCase().includes('completion')
  }
};

/**
 * Unified agent execution engine.
 */
async function executeAgentTask(projectId, taskIndex, cwd, task) {
  const state = getState();
  const project = state.projects.find(p => p.id === projectId);
  if (!project || !project.tasks[taskIndex]) {
    console.error(`[EXECUTE] Project or task disappeared`);
    return { success: false, error: 'Project or task not found' };
  }

  const agentName = task.agent || (project && project.defaultAgent) || 'aider';
  const agent = AGENT_REGISTRY[agentName];

  if (!agent) {
    console.error(`[EXECUTE] Unsupported agent: ${agentName}`);
    return { success: false, error: `Unsupported agent: ${agentName}` };
  }

  const config = getAiderConfig(project);
  
  // Session ID for logging (primarily used by Cline)
  const projectTitle = (project.name || projectId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sessionId = `${projectTitle}_${agentName}_task_${taskIndex}_${timestamp}`;

  console.log(`[EXECUTE] Starting ${agent.name} for project ${projectId}, task ${taskIndex}: "${task.prompt}"`);

  // ── HTTP-based agents: no child process (Telegram, Baton Code, etc.) ──
  if (agent.isHttpAgent) {
    activeSessions.set(taskIndex, { sessionId, projectId, spawnTime: Date.now(), child: null });

    try {
      let result;
      if (agentName === 'telegram') {
        // Telegram: send_message(prompt, config)
        const state = getState();
        const telegramConfig = state.telegramConfig || {};
        result = await agent.send_message(task.prompt, telegramConfig);
      } else {
        // Baton Code: send_message(prompt, config, cwd, projectId, taskContext)
        result = await agent.send_message(task.prompt, {}, cwd, projectId, { taskIndex, agentName });
      }

      console.log(`[EXECUTE] ${agent.name} task ${taskIndex} sent successfully`);
      activeSessions.delete(taskIndex);

      const currentState = getState();
      const currentProject = currentState.projects.find(p => p.id === projectId);
      if (currentProject && currentProject.tasks[taskIndex]) {
        currentProject.tasks[taskIndex].state = 'done';
        currentProject.tasks[taskIndex].completedAt = new Date().toISOString();
        saveState(currentState);
      }
      return Promise.resolve({ success: true });
    } catch (err) {
      console.error(`[EXECUTE] ${agent.name} task ${taskIndex} failed:`, err.message);
      activeSessions.delete(taskIndex);

      const currentState = getState();
      const currentProject = currentState.projects.find(p => p.id === projectId);
      if (currentProject && currentProject.tasks[taskIndex]) {
        currentProject.tasks[taskIndex].state = 'failed';
        currentProject.tasks[taskIndex].completedAt = new Date().toISOString();
        saveState(currentState);
      }
      return Promise.resolve({ success: false, error: err.message });
    }
  }

  const cmdObj = agent.getCommand(task.prompt, config, taskIndex);
  
  // Strip BatonBot-specific env vars to prevent child apps from inheriting our configuration.
  // - PORT: When Cline runs `npm run dev`, the child app inherits PORT=4321 (the batonbot's port),
  //   causing it to try binding to the same port, resulting in EADDRINUSE crashes.
  // - LM_STUDIO_URL: Prevents child projects from accidentally using BatonBot's AI backend config.
  const { PORT: _batonbotPort, LM_STUDIO_URL: _lmStudioUrl, ...inheritedEnv } = process.env;
  const env = { ...inheritedEnv, ...agent.getEnv(config) };

  // Log session start if it's Cline (maintaining existing behavior)
  if (agentName === 'cline') {
    appendToClineLog(sessionId, {
      type: 'session_start',
      timestamp: new Date().toISOString(),
      projectId,
      taskIndex,
      prompt: task.prompt,
      workingDirectory: cwd
    });
  }

  // ── Parallels shared-folder advisory (Windows) ──
  // Working directories under C:\Mac\ are typically Parallels Mac shared
  // folders. Cline's filesystem operations can hang or be very slow on
  // those mounts. Warn loudly so the user can correlate symptoms; we don't
  // block since some setups work fine.
  if (IS_WINDOWS && /^[A-Z]:\\Mac\\/i.test(cwd)) {
    const warnMsg = `Working directory '${cwd}' looks like a Parallels Mac shared folder. Cline may hang or be slow against this mount. If the task stalls, copy the project to a native Windows path (e.g. C:\\Users\\<you>\\Desktop\\<project>) and try again.`;
    console.warn(`[WARN] ${warnMsg}`);
    broadcastEvent(projectId, {
      type: 'warning',
      taskIndex,
      message: warnMsg,
      timestamp: new Date().toISOString()
    });
  }

  // Use spawnCompat so .cmd/.bat shims (cline, aider, git) work on Windows.
  // On macOS/Linux this behaves identically to plain spawn (no shell).
  const child = spawnCompat(cmdObj.command, cmdObj.args, { cwd, env });
  registerChildProcess(projectId, taskIndex, child);

  // Register active session for single-session enforcement
  activeSessions.set(taskIndex, { 
    sessionId, 
    projectId, 
    spawnTime: Date.now(),
    child 
  });

  let stdout = '';
  let stderr = '';
  let receivedAnyOutput = false;

  // ── Stall watchdog ──
  // If the child emits zero stdout AND zero stderr within STALL_TIMEOUT_MS,
  // surface a clear advisory. Common causes: hung initialization, slow
  // shared-folder cwd, or interactive prompt we can't see. Without this,
  // BatonBot would sit silent and the user has no idea what went wrong.
  const STALL_TIMEOUT_MS = 60_000;
  const stallTimer = setTimeout(() => {
    if (receivedAnyOutput) return;
    const stallMsg = `${agent.name} task ${taskIndex}: no output for ${Math.round(STALL_TIMEOUT_MS / 1000)}s after spawn. The agent may be hung. Common causes:\n  • Interactive prompt — run \`cline auth …\` once and start BatonBot with BATONBOT_NO_AUTO_AUTH=1\n  • Slow/networked filesystem (Parallels share / WSL mount) — use a native path\n  • Cline build mismatch — verify with \`cline --version\` in cmd.exe`;
    console.warn(`[STALL] ${stallMsg}`);
    broadcastEvent(projectId, {
      type: 'stall',
      taskIndex,
      message: stallMsg,
      timestamp: new Date().toISOString()
    });
  }, STALL_TIMEOUT_MS);

  // Session Lifecycle Validation: Track whether a completion_result event was received
  let hasCompletionResult = false;

  child.stdout.on('data', (data) => {
    receivedAnyOutput = true;
    const text = data.toString();
    stdout += text;

    // Track whether Cline emitted any of its success signals. Different Cline
    // releases use different markers — accept any of them:
    //   - "completion_result" / "completion_tag" (older builds)
    //   - "attempt_completion" tool call (mid builds)
    //   - "submit_and_exit" tool call (current builds)
    //   - run_result/done with "completed" finishReason/reason (current builds)
    if (
      text.includes('completion_result') ||
      text.includes('completion_tag') ||
      text.includes('attempt_completion') ||
      text.includes('submit_and_exit') ||
      text.includes('"finishReason":"completed"') ||
      text.includes('"reason":"completed"')
    ) {
      hasCompletionResult = true;
    }

    // Broadcast stdout chunk to live-output SSE subscribers
    try {
      broadcastEvent(projectId, {
        type: 'stdout',
        taskIndex,
        sessionId,
        text,
        timestamp: new Date().toISOString()
      });
    } catch (_) { /* never block child output on SSE failures */ }

    agent.handleOutput(data, { taskIndex, sessionId });
  });

  child.stderr.on('data', (data) => {
    receivedAnyOutput = true;
    const text = data.toString();
    stderr += text;
    console.error(`[${agent.name.toUpperCase()}][task-${taskIndex}][stderr]: ${text.trim()}`);

    // Broadcast stderr chunk to live-output SSE subscribers
    try {
      broadcastEvent(projectId, {
        type: 'stderr',
        taskIndex,
        sessionId,
        text,
        timestamp: new Date().toISOString()
      });
    } catch (_) { /* never block child output on SSE failures */ }

    if (agentName === 'cline') {
      appendToClineLog(sessionId, { type: 'stderr', timestamp: new Date().toISOString(), text: text.trim() });
    }
  });

  return new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(stallTimer);
      unregisterChildProcess(projectId, taskIndex);

      // Clean up active session tracking for this taskIndex
      activeSessions.delete(taskIndex);

      if (agentName === 'cline') {
        // Determine completion status for lifecycle validation
        let completionStatus;
        if (code === 0 && hasCompletionResult) {
          completionStatus = 'complete';
        } else if (code === 0 && !hasCompletionResult) {
          completionStatus = 'incomplete_clean_exit';
          console.warn(`[SESSION LIFECYCLE] Session ${sessionId} exited with code 0 but no completion_result detected. Task may be incomplete.`);
        } else {
          completionStatus = 'failed';
        }

        const sessionEndEntry = {
          type: 'session_end',
          timestamp: new Date().toISOString(),
          exitCode: code,
          outputLength: stdout.length,
          hasCompletionResult,
          completionStatus
        };

        appendToClineLog(sessionId, sessionEndEntry);
      }

      const currentState = getState();
      const currentProject = currentState.projects.find(p => p.id === projectId);
      if (!currentProject || !currentProject.tasks[taskIndex]) {
        return resolve({ success: false, error: 'Project/task disappeared' });
      }

      const completedTask = currentProject.tasks[taskIndex];
      
      // Session Lifecycle Validation: For Cline, require completion_result for success
      let isSuccess;
      if (agentName === 'cline') {
        // A clean exit without completion_result is suspicious — mark as failed
        if (code === 0 && hasCompletionResult) {
          isSuccess = true;
        } else if (code === 0 && !hasCompletionResult) {
          // Clean exit but no completion — treat as failure to prevent false completions
          isSuccess = false;
          console.warn(`[SESSION LIFECYCLE] Task ${taskIndex} exited cleanly but never completed. Marking as failed.`);
        } else {
          isSuccess = false;
        }
      } else {
        // For non-Cline agents, use the original checkCompletion logic
        isSuccess = agent.checkCompletion(code, stdout);
      }

      completedTask.state = isSuccess ? 'done' : 'failed';
      completedTask.completedAt = new Date().toISOString();
      saveState(currentState);

      if (isSuccess) {
        console.log(`[EXECUTE] ${agent.name} task ${taskIndex} completed successfully`);
        // NOTE: For Cline tasks, next-task triggering is handled exclusively by
        // checkClineCompletionAndTriggerNext() via log event streaming (quiet-period based).
        // Auto-chaining here would race with the log detector and cause premature triggers.
        if (agentName !== 'cline') {
          const nextIndex = taskIndex + 1;
          if (nextIndex < currentProject.tasks.length) {
            executeTaskWithAutoChain(projectId, nextIndex);
          }
        }
      } else {
        console.error(`[EXECUTE] ${agent.name} task ${taskIndex} failed with code ${code}`);
      }
      resolve({ success: isSuccess });
    });

    child.on('error', (err) => {
      clearTimeout(stallTimer);
      unregisterChildProcess(projectId, taskIndex);
      activeSessions.delete(taskIndex);
      console.error(`[EXECUTE] ${agent.name} error:`, err.message);
      resolve({ success: false, error: err.message });
    });
  });
}

// --- Agent Orchestration Helpers ---

function getAiderConfig(project) {
  const state = getState();
  if (project && project.aiderConfig && Object.keys(project.aiderConfig).length > 0) {
    return project.aiderConfig;
  }
  return state.aiderConfig || {};
}

/**
 * Unified entry point for task execution.
 */
function executeTaskWithAutoChain(projectId, taskIndex) {
  const state = getState();
  const project = state.projects.find(p => p.id === projectId);

  if (!project || !project.tasks[taskIndex]) {
    console.error(`[EXECUTE] Invalid project (${projectId}) or task index (${taskIndex})`);
    return { success: false, error: 'Project or task not found' };
  }

  const task = project.tasks[taskIndex];
  if (task.state === 'done') {
    console.log(`[EXECUTE] Task ${taskIndex} already completed for project ${projectId}`);
    return { success: true, message: 'Already completed' };
  }

  // Deduplication guard: skip if this (project, taskIndex) is already being triggered
  const triggerKey = `${projectId}:${taskIndex}`;
  if (pendingTriggerSet.has(triggerKey)) {
    console.log(`[DEDUP] Task ${triggerKey} already being triggered, skipping duplicate`);
    return { success: true, message: 'Already triggered' };
  }

  task.state = 'in_progress';
  saveState(state);

  const cwd = project.workingDirectory || '.';

  // Safety check: prevent agent from running in BatonBot's directory
  const validation = validateWorkingDirectory(cwd, projectId);
  if (!validation.safe) {
    console.error(`[ISOLATION] Blocked: ${validation.reason}`);
    task.state = 'failed';
    saveState(state);
    return { success: false, error: validation.reason };
  }

  ensureGitInitialized(validation.cwd).catch((err) => {
    console.warn(`[EXECUTE] Git initialization error for ${validation.cwd}:`, err.message);
  });

  return executeAgentTask(projectId, taskIndex, validation.cwd, task);
}

/**
 * Trigger an agent for a single task (no auto-chaining).
 * This is used by the orchestrate endpoint to run individual selected tasks.
 */
async function triggerAgentSingle(projectId, taskIndex) {
  const state = getState();
  const project = state.projects.find(p => p.id === projectId);

  if (!project || !project.tasks[taskIndex]) {
    return { success: false, error: 'Project or task not found' };
  }

  const task = project.tasks[taskIndex];
  if (task.state === 'done') {
    return { success: true, message: 'Already completed' };
  }

  // Single Session Enforcement: Check if a session is already active for this taskIndex
  const existingSession = activeSessions.get(taskIndex);
  if (existingSession) {
    const elapsed = Date.now() - existingSession.spawnTime;
    console.warn(`[SESSION GUARD] Session already active for task ${taskIndex} (elapsed: ${elapsed}ms, sessionId: ${existingSession.sessionId}). Skipping duplicate trigger.`);
    return { success: false, error: 'Session already active for this task' };
  }

  // Deduplication guard: skip if this (project, taskIndex) is already being triggered
  const triggerKey = `${projectId}:${taskIndex}`;
  if (pendingTriggerSet.has(triggerKey)) {
    console.log(`[DEDUP] Task ${triggerKey} already being triggered, skipping duplicate`);
    return { success: true, message: 'Already triggered' };
  }

  task.state = 'in_progress';
  saveState(state);

  const cwd = project.workingDirectory || '.';

  // Safety check: prevent agent from running in BatonBot's directory
  const validation = validateWorkingDirectory(cwd, projectId);
  if (!validation.safe) {
    console.error(`[ISOLATION] Blocked: ${validation.reason}`);
    task.state = 'failed';
    saveState(state);
    return { success: false, error: validation.reason };
  }

  ensureGitInitialized(validation.cwd).catch((err) => {
    console.warn(`[EXECUTE] Git initialization error for ${validation.cwd}:`, err.message);
  });

  // Add to pending trigger set and remove when complete
  pendingTriggerSet.add(triggerKey);

  try {
    const result = await executeAgentTask(projectId, taskIndex, validation.cwd, task);
    return result;
  } finally {
    pendingTriggerSet.delete(triggerKey);
  }
}

// ═══════════════════════════════════════════
// Phase 3: Cancel Endpoint + SSE Stream Endpoint
// ═══════════════════════════════════════════

/**
 * POST /api/project/:id/tasks/cancel
 * Cancels the currently running orchestration by sending SIGTERM to all child processes.
 */
app.post('/api/project/:id/tasks/cancel', (req, res) => {
  const { id: projectId } = req.params;

  console.log(`[CANCEL] POST /api/project/${projectId}/tasks/cancel`);

  if (!executionState.running) {
    return res.json({ success: true, message: 'No active execution to cancel' });
  }

  // Mark as not running (stops queue processing)
  executionState.running = false;

  // Send SIGTERM to all tracked child processes for this project
  const terminated = [];
  executionState.childProcesses.forEach(({ process: child, taskIndex }) => {
    if (!child.killed && child.pid) {
      try {
        killProcessTree(child, 'SIGTERM');
        terminated.push(taskIndex);
        console.log(`[CANCEL] Killed process tree for task ${taskIndex} (PID: ${child.pid})`);
      } catch (err) {
        console.warn(`[CANCEL] Failed to kill task ${taskIndex}:`, err.message);
      }
    }
  });

  // Also clean up active sessions for this project's tasks (single-session enforcement)
  for (const [taskIdx, session] of activeSessions) {
    if (session.projectId === projectId && session.child) {
      try {
        killProcessTree(session.child, 'SIGTERM');
        console.log(`[CANCEL] Killed process tree for active session task ${taskIdx} (sessionId: ${session.sessionId})`);
      } catch (err) {
        console.warn(`[CANCEL] Failed to kill active session for task ${taskIdx}:`, err.message);
      }
    }
  }

  // Mark all in_progress tasks for this project as cancelled (stopped)
  const state = getState();
  const project = state.projects.find(p => p.id === projectId);
  if (project) {
    project.tasks.forEach((task, idx) => {
      if (task.state === 'in_progress') {
        task.state = 'stopped';
        task.completedAt = new Date().toISOString();
      }
    });
    saveState(state);
  }

  // Clean up child process tracking for this project
  executionState.childProcesses = executionState.childProcesses.filter(
    cp => cp.projectId !== projectId
  );

  // Notify all SSE subscribers and close their streams for this project
  const cancelSubs = streamSubscribers.get(projectId);
  if (cancelSubs && cancelSubs.size > 0) {
    const cancelPayload = 'data: ' + JSON.stringify({ type: 'cancelled', timestamp: new Date().toISOString() }) + '\n\n';
    for (const subscriberRes of cancelSubs) {
      try {
        if (!subscriberRes.writableEnded) {
          subscriberRes.write(cancelPayload);
          subscriberRes.end();
        }
      } catch (_) { /* swallow */ }
    }
    streamSubscribers.delete(projectId);
  }

  res.json({ success: true, message: 'Execution cancelled', terminatedTasks: terminated });
});

/**
 * POST /api/project/:id/tasks/pause
 * Gracefully halt orchestration AFTER the currently running task finishes.
 * Unlike /cancel, this does NOT SIGTERM the running child — it lets the agent
 * finish naturally and prevents any subsequent tasks in the queue from starting.
 * Remaining selected tasks stay in 'pending' state so the user can resume by
 * pressing Play again (which re-issues /orchestrate with the remaining indices).
 */
app.post('/api/project/:id/tasks/pause', (req, res) => {
  const { id: projectId } = req.params;

  console.log(`[PAUSE] POST /api/project/${projectId}/tasks/pause`);

  if (!executionState.running) {
    return res.json({ success: false, message: 'No active execution to pause' });
  }

  executionState.pauseRequested = true;

  // Broadcast acknowledgement so the UI can flip Pause -> Play immediately,
  // even though actual halt happens after the current task settles.
  broadcastEvent(projectId, {
    type: 'pause_requested',
    timestamp: new Date().toISOString()
  });

  res.json({ success: true, message: 'Pause requested. Orchestrator will stop after the current task completes.' });
});

/**
 * GET /api/project/:id/tasks/stream
 * SSE endpoint that broadcasts orchestration events in real-time.
 */
app.get('/api/project/:id/tasks/stream', (req, res) => {
  const { id: projectId } = req.params;

  console.log(`[STREAM] GET /api/project/${projectId}/tasks/stream | New subscriber`);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Store subscriber (multiple subscribers per project supported via Set)
  if (!streamSubscribers.has(projectId)) {
    streamSubscribers.set(projectId, new Set());
  }
  streamSubscribers.get(projectId).add(res);

  res.on('close', () => {
    console.log(`[STREAM] GET /api/project/${projectId}/tasks/stream | Subscriber disconnected`);
    const subs = streamSubscribers.get(projectId);
    if (subs) {
      subs.delete(res);
      if (subs.size === 0) streamSubscribers.delete(projectId);
    }
  });

  // Send initial connection event
  res.write('data: ' + JSON.stringify({ type: 'connected', projectId, timestamp: new Date().toISOString() }) + '\n\n');
});

// --- Headless Cline Orchestration with Tag Streaming ---

/**
 * POST /api/cline/headless
 * Spawns Cline CLI in headless mode, streams JSON output with tool call events.
 * Records all interactions including completion tags for event triggering.
 */
app.post('/api/cline/headless', async (req, res) => {
  const { prompt, workingDirectory, projectId } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  const cwd = workingDirectory || '.';

  // Safety check: prevent headless agent from running in BatonBot's directory
  const headlessValidation = validateWorkingDirectory(cwd, projectId || 'headless');
  if (!headlessValidation.safe) {
    console.error(`[ISOLATION] Headless blocked: ${headlessValidation.reason}`);
    return res.status(400).json({ error: headlessValidation.reason });
  }

  // Use project name if projectId is provided, otherwise use 'headless'
  const headlessProjectTitle = (projectId ? (() => {
    const proj = getState().projects.find(p => p.id === projectId);
    return (proj && proj.name) || projectId;
  })() : 'headless').replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp2 = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sessionId = `${headlessProjectTitle}_cline_task_0_${timestamp2}`;
  const logFile = path.join(__dirname, 'logs', `${sessionId}.json`);

  console.log(`[HEADLESS CLINE] Session: ${sessionId}`);
  console.log(`[HEADLESS CLINE] Prompt: ${prompt}`);
  console.log(`[HEADLESS CLINE] Working directory: ${cwd}`);

  // Ensure logs directory exists
  if (!fs.existsSync(path.join(__dirname, 'logs'))) {
    fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
  }

  // Ensure git is initialized in working directory
  ensureGitInitialized(cwd).catch((err) => {
    console.warn(`[HEADLESS CLINE] Git initialization warning:`, err.message);
  });

  // Set SSE headers for streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Pass LLM config to headless Cline via --data-dir with lmstudio provider.
  // Cline's built-in 'lmstudio' provider connects to localhost:1234 automatically.
  const headlessConfig = projectId ? (() => {
    const proj = getState().projects.find(p => p.id === projectId);
    return proj && proj.aiderConfig && Object.keys(proj.aiderConfig).length > 0 ? proj.aiderConfig : (getState().aiderConfig || {});
  })() : (getState().aiderConfig || {});

  // Build Cline command. By default we inject a per-spawn providers.json
  // built from the UI's Global Config so the user's Settings selection
  // (Anthropic / OpenAI / LM Studio) is the source of truth. Users who
  // prefer to manage Cline auth themselves via `cline auth …` can opt out
  // with BATONBOT_NO_AUTO_AUTH=1. See the regular Cline agent above.
  const headlessArgs = ['--json', '-y'];
  const SKIP_INJECTION_HEADLESS = process.env.BATONBOT_NO_AUTO_AUTH === '1';
  if (!SKIP_INJECTION_HEADLESS && (headlessConfig.apiBase || headlessConfig.model)) {


    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batonbot-headless-cline-'));
    const settingsDir = path.join(tmpDir, 'data', 'settings');
    fs.mkdirSync(settingsDir, { recursive: true });

    const apiBaseLower = (headlessConfig.apiBase || '').toLowerCase();
    let providerType = 'openai';
    let providerSettings = {};

    // Model must come from the global/project config — no silent fallback.
    if (!headlessConfig.model) {
      return res.status(400).json({ error: 'Cline model is not configured. Set it in Settings → LLM Configuration (e.g. "claude-opus-4-7").' });
    }

    if (apiBaseLower.includes('anthropic.com')) {
      providerType = 'anthropic';
      providerSettings = {
        provider: 'anthropic',
        model: headlessConfig.model,
        apiKey: headlessConfig.apiKey || ''
      };
    } else if (!headlessConfig.apiBase || apiBaseLower.includes('localhost')) {
      providerType = 'lmstudio';
      providerSettings = {
        provider: 'lmstudio',
        model: headlessConfig.model
      };
    } else {
      providerType = 'openai';
      providerSettings = {
        provider: 'openai',
        model: headlessConfig.model,
        baseUrl: headlessConfig.apiBase || '',
        apiKey: headlessConfig.apiKey || ''
      };
    }

    const providersJson = {
      version: 1,
      lastUsedProvider: providerType,
      providers: {
        [providerType]: {
          settings: providerSettings,
          updatedAt: new Date().toISOString(),
          tokenSource: 'batonbot'
        }
      }
    };
    fs.writeFileSync(path.join(settingsDir, 'providers.json'), JSON.stringify(providersJson, null, 2));

    headlessArgs.push('--data-dir', tmpDir);
    headlessArgs.push('-P', providerType);
    console.log(`[HEADLESS CLINE] Using ${providerType} provider with temp data-dir: ${tmpDir}`);
  }
  if (headlessConfig.model) {
    headlessArgs.push('-m', headlessConfig.model);
  }
  headlessArgs.push(prompt);
  const cmdObj = { command: 'cline', args: headlessArgs };

  console.log(`[HEADLESS CLINE] Command: ${cmdObj.command} ${cmdObj.args.join(' ')}`);

  // Strip BatonBot-specific env vars to prevent child apps from inheriting our configuration.
  const { PORT: _batonbotPort2, LM_STUDIO_URL: _lmStudioUrl2, ...inheritedEnvHeadless } = process.env;

  // Cline's SDKs require API keys as environment variables regardless of
  // whether the key is also written to providers.json:
  // - Anthropic SDK (@anthropic-ai/sdk) requires ANTHROPIC_API_KEY
  // - OpenAI SDK requires OPENAI_API_KEY + OPENAI_API_BASE for custom endpoints
  // The providers.json provides the baseUrl/model config, but the SDKs
  // still read the auth key from the environment.
  const headlessEnv = { ...inheritedEnvHeadless };
  
  // Debug logging to verify config
  console.log(`[HEADLESS CLINE] Config debug: apiBase=${headlessConfig.apiBase || '(none)'}, apiKey=${headlessConfig.apiKey ? '(present)' : '(MISSING)'}, model=${headlessConfig.model || '(none)'}`);
  
  if (headlessConfig.apiBase || headlessConfig.model) {
    if (headlessConfig.model) {
      headlessEnv.MODEL = headlessConfig.model;
    }
    const headlessApiBaseLower = (headlessConfig.apiBase || '').toLowerCase();
    
    if (headlessApiBaseLower.includes('anthropic.com')) {
      // Anthropic SDK requires ANTHROPIC_API_KEY
      headlessEnv.ANTHROPIC_API_KEY = headlessConfig.apiKey || '';
      console.log(`[HEADLESS CLINE] Setting ANTHROPIC_API_KEY`);
    } else if (!headlessApiBaseLower.includes('localhost')) {
      // OpenAI-compatible providers (Grok, OpenAI, xAI, etc.) need both
      // OPENAI_API_KEY (auth) and OPENAI_API_BASE (endpoint URL)
      headlessEnv.OPENAI_API_KEY = headlessConfig.apiKey || '';
      headlessEnv.OPENAI_API_BASE = headlessConfig.apiBase || '';
      console.log(`[HEADLESS CLINE] Setting OPENAI_API_KEY + OPENAI_API_BASE=${headlessConfig.apiBase}`);
    }
    // LM Studio (localhost) doesn't need an API key
  } else {
    // No providers.json — pass env vars as fallback
    headlessEnv.OPENAI_API_BASE = headlessConfig.apiBase || '';
    headlessEnv.OPENAI_API_KEY = headlessConfig.apiKey || '';
    headlessEnv.MODEL = headlessConfig.model || '';
  }

  const child = spawnCompat(cmdObj.command, cmdObj.args, {
    cwd,
    env: headlessEnv,
  });

  let stdout = '';
  const events = [];
  const filesCreated = new Set();

  const sessionStartEvent = {
    type: 'session_start',
    sessionId,
    prompt,
    workingDirectory: cwd,
    timestamp: new Date().toISOString()
  };

  // Log session start to file
  appendToClineLog(sessionId, sessionStartEvent);

  // Send session start event via SSE
  res.write(`data: ${JSON.stringify(sessionStartEvent)}\n\n`);

  child.stdout.on('data', (data) => {
    const text = data.toString();
    stdout += text;

    // Try to parse JSON lines from Cline output
    const lines = text.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);

        // Extract tool use events
        const event = {
          type: 'cline_output',
          timestamp: new Date().toISOString(),
          data: parsed
        };

        // Detect file creation via write_to_file or similar tool calls
        if (parsed.tool_name === 'write_to_file' || parsed.tool?.name === 'write_to_file') {
          const filePath = parsed.input?.path || parsed.arguments?.path;
          if (filePath) {
            filesCreated.add(filePath);
            event.type = 'file_created';
            event.filePath = filePath;
          }
        }

        // Detect attempt_completion (completion tag)
        if (parsed.tool_name === 'attempt_completion' || parsed.tool?.name === 'attempt_completion') {
          event.type = 'completion_tag';
          event.result = parsed.input?.result || parsed.arguments?.result;
        }

        // Detect other tool uses
        if (parsed.tool_name || parsed.tool?.name) {
          const toolName = parsed.tool_name || parsed.tool.name;
          event.type = 'tool_use';
          event.toolName = toolName;
        }

        events.push(event);
        
        // REAL-TIME LOG APPENDING: Write each event to the log file immediately
        appendToClineLog(sessionId, event);
        
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (e) {
        // Not JSON, might be regular output - include as text event
        const event = {
          type: 'stdout',
          timestamp: new Date().toISOString(),
          text: line.trim()
        };
        events.push(event);
        
        // REAL-TIME LOG APPENDING: Write stdout events to log file too
        appendToClineLog(sessionId, event);
        
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    console.error(`[HEADLESS CLINE][stderr]: ${text.trim()}`);

    const event = {
      type: 'stderr',
      timestamp: new Date().toISOString(),
      text: text.trim()
    };

    // Log stderr to file
    appendToClineLog(sessionId, event);

    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  child.on('close', (code) => {
    const sessionEvent = {
      type: 'session_end',
      sessionId,
      timestamp: new Date().toISOString(),
      exitCode: code,
      totalEvents: events.length,
      filesCreated: Array.from(filesCreated),
      events: events
    };

    res.write(`data: ${JSON.stringify(sessionEvent)}\n\n`);
    res.write('data: [DONE]\n\n');

    // Log session end event using the append helper to avoid overwriting the file
    appendToClineLog(sessionId, {
      type: 'session_end',
      sessionId,
      timestamp: new Date().toISOString(),
      exitCode: code,
      totalEvents: events.length,
      filesCreated: Array.from(filesCreated)
    });

    console.log(`[HEADLESS CLINE] Session ${sessionId} ended with code ${code}. Final event appended to log.`);

    console.log(`[HEADLESS CLINE] Session ${sessionId} ended with code ${code}`);
    console.log(`[HEADLESS CLINE] Files created: ${Array.from(filesCreated).join(', ') || 'none'}`);
  });

  child.on('error', (err) => {
    const errorEvent = {
      type: 'session_error',
      sessionId,
      timestamp: new Date().toISOString(),
      error: err.message
    };

    res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
    res.write('data: [DONE]\n\n');

    console.error(`[HEADLESS CLINE] Process error:`, err.message);
  });
});

// --- Routes ---

app.get('/', (req, res) => {
  // Remove CSP before sending the file to prevent browser blocking of static assets
  res.removeHeader('Content-Security-Policy');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Project Management API
app.get('/api/projects', (req, res) => {
  const state = getState();
  console.log(`[PROJECT SCOPE] GET /api/projects | Active Project ID: ${state.activeProjectId}`);
  res.json({ projects: state.projects, activeProjectId: state.activeProjectId });
});

app.post('/api/projects', (req, res) => {
  const { name, workingDirectory, aiderConfig } = req.body;
  console.log(`[PROJECT SCOPE] POST /api/projects | Creating project: ${name} | Working Directory: ${workingDirectory || '.'}`);
  if (!name) return res.status(400).json({ error: 'Project name is required' });

  const state = getState();
  const newProject = {
    id: `proj_${Date.now()}`,
    name,
    workingDirectory: workingDirectory || '.',
    tasks: [],
    aiderConfig: aiderConfig || {}
  };
  state.projects.push(newProject);
  if (!state.activeProjectId) state.activeProjectId = newProject.id;
  saveState(state);
  res.json({ message: 'Project created', project: newProject, state });
});

app.put('/api/projects/:id', (req, res) => {
  const { id: projectId } = req.params;
  const { name, workingDirectory, aiderConfig, defaultAgent } = req.body;
  console.log(`[PROJECT SCOPE] PUT /api/projects/${projectId} | Updating project: ${name || 'unnamed'}`);

  const state = getState();
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (name !== undefined) project.name = name;
  if (workingDirectory !== undefined) project.workingDirectory = workingDirectory;
  if (aiderConfig !== undefined) {
    // Merge with existing config or replace entirely
    project.aiderConfig = Object.keys(aiderConfig).length > 0 ? aiderConfig : {};
  }
  if (defaultAgent !== undefined) {
    project.defaultAgent = defaultAgent;
  }

  saveState(state);
  res.json({ message: 'Project updated', project, state });
});

app.post('/api/projects/active', (req, res) => {
  const { projectId } = req.body;
  console.log(`[PROJECT SCOPE] POST /api/projects/active | Setting active project to: ${projectId}`);
  const state = getState();
  if (!state.projects.find(p => p.id === projectId)) {
    return res.status(404).json({ error: 'Project not found' });
  }
  state.activeProjectId = projectId;
  saveState(state);
  res.json({ message: 'Active project updated', activeProjectId: state.activeProjectId });
});

app.get('/api/project/:id/tasks', (req, res) => {
  const state = getState();
  console.log(`[PROJECT SCOPE] GET /api/project/${req.params.id}/tasks | Accessing tasks for project: ${req.params.id}`);
  const project = state.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ tasks: project.tasks });
});

app.post('/api/project/:id/tasks', (req, res) => {
  const { tasks } = req.body;
  console.log(`[PROJECT SCOPE] POST /api/project/${req.params.id}/tasks | Updating tasks for project: ${req.params.id}`);
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'Tasks must be an array' });

  const state = getState();
  const project = state.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // FIX: Preserve existing task state/orchestrate/agent for tasks that don't explicitly provide them.
  // This prevents the bug where running/done/failed states get reset to 'pending' when
  // the frontend sends a partial task object (e.g., during auto-save of prompt text changes).
  const existingTasks = project.tasks || [];

  project.tasks = tasks.map((t, index) => {
    if (typeof t === 'string') {
      // Backward compat: string tasks get defaults, but preserve state if index matches existing task
      const existing = existingTasks[index];
      return { 
        id: index, 
        prompt: t, 
        state: existing ? existing.state : 'pending',
        orchestrate: existing ? existing.orchestrate : false,
        agent: existing ? existing.agent : 'aider' 
      };
    }

    // Get the existing task at this index (if any) to preserve state
    const existing = existingTasks[index];

    // FIX: Only update fields explicitly provided by the client.
    // If 'state' is not in the incoming task data, preserve the existing state.
    // This prevents race conditions where auto-save of prompt text doesn't overwrite execution states.
    const result = { 
      ...t, 
      orchestrate: t.orchestrate !== undefined ? t.orchestrate : (existing ? existing.orchestrate : false),
      agent: t.agent || 'aider' 
    };

    // Preserve existing state if not explicitly provided in the request.
    // This is the key fix: when auto-saving prompt changes, we don't want to reset
    // in_progress/done/failed states back to pending.
    if (t.state !== undefined) {
      result.state = t.state;
    } else if (existing) {
      result.state = existing.state;
    } else {
      result.state = 'pending';
    }

    return result;
  });

  saveState(state);
  res.json({ message: 'Tasks updated', tasks: project.tasks });
});

// Orchestration API - Start orchestration with selected tasks
app.post('/api/project/:id/tasks/orchestrate', async (req, res) => {
  const { id: projectId } = req.params;
  const { taskIndices } = req.body;

  console.log(`[ORCHESTRATION] POST /api/project/${projectId}/tasks/orchestrate | Task indices: ${JSON.stringify(taskIndices)}`);

  if (!Array.isArray(taskIndices) || taskIndices.length === 0) {
    return res.status(400).json({ success: false, error: 'taskIndices must be a non-empty array' });
  }

  const state = getState();
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found' });

  // Validate indices and collect tasks to run
  const tasksToRun = [];
  for (const idx of taskIndices) {
    if (idx < 0 || idx >= project.tasks.length) {
      return res.status(400).json({ success: false, error: `Invalid task index: ${idx}` });
    }
    tasksToRun.push({ index: idx, prompt: project.tasks[idx].prompt });
  }

  // NOTE: Do NOT bulk-mark all selected tasks as 'in_progress' here.
  // The orchestrator runs tasks sequentially via runNextTask(), which flips
  // the current task to 'in_progress' just before invoking the agent and to
  // 'done'/'failed' on completion. Marking everything up front would cause
  // every queued card on the board to display the amber RUNNING badge even
  // though only one task is actually executing at a time.

  // Set execution state for Phase 3 controls
  executionState.running = true;

  // Broadcast orchestration start event via SSE
  broadcastEvent(projectId, { type: 'orchestration_start', taskCount: tasksToRun.length, timestamp: new Date().toISOString() });

  // Run tasks sequentially with queue-based state machine and timeout protection
  let completedCount = 0;
  let failedCount = 0;

  const runNextTask = async (taskIndex, prompt) => {
    // Queue guard: only one task at a time
    if (taskQueue.isProcessing && taskQueue.currentTaskIndex !== taskIndex) {
      console.warn(`[QUEUE] Task ${taskIndex} skipped — task ${taskQueue.currentTaskIndex} is still processing`);
      return;
    }

    // Check if execution was cancelled
    if (!executionState.running) {
      console.log(`[ORCHESTRATION] Execution cancelled, stopping at task ${taskIndex}`);
      return;
    }

    // Set queue state: this task is now processing
    taskQueue.isProcessing = true;
    taskQueue.currentTaskIndex = taskIndex;

    try {
      // Broadcast task start event via SSE
      const task = project.tasks[taskIndex];
      broadcastEvent(projectId, {
        type: 'task_start',
        taskIndex,
        prompt: task.prompt,
        agent: task.agent || 'aider',
        timestamp: new Date().toISOString()
      });

      // Use the unified agent trigger (this spawns a child process).
      // triggerAgentSingle RESOLVES (does not throw) with { success: false, error }
      // on child-process failure. So we must inspect the return value here —
      // otherwise failed Cline tasks would still increment completedCount and
      // the UI would falsely report "X succeeded, 0 failed".
      const taskResult = await triggerAgentSingle(projectId, taskIndex);

      // Check if cancelled during execution
      if (!executionState.running) {
        return;
      }

      if (taskResult && taskResult.success === false) {
        // Child process exited non-zero, or Cline never emitted completion_result,
        // or executeAgentTask reported an error. Count as a failed task.
        failedCount++;
        const errMsg = taskResult.error || 'Task reported failure';
        console.error(`[ORCHESTRATION] Task ${taskIndex} failed: ${errMsg}`);

        const failState = getState();
        const failProject = failState.projects.find(p => p.id === projectId);
        if (failProject && failProject.tasks[taskIndex]) {
          failProject.tasks[taskIndex].state = 'failed';
          failProject.tasks[taskIndex].completedAt = new Date().toISOString();
          saveState(failState);
        }

        broadcastEvent(projectId, { type: 'task_failed', taskIndex, error: errMsg, timestamp: new Date().toISOString() });
      } else {
        // Task completed successfully (triggerAgentSingle resolves after child.on('close') fires)
        completedCount++;

        // Immediately update task state to 'done' so polling reflects the correct state
        const doneState = getState();
        const doneProject = doneState.projects.find(p => p.id === projectId);
        if (doneProject && doneProject.tasks[taskIndex]) {
          doneProject.tasks[taskIndex].state = 'done';
          doneProject.tasks[taskIndex].completedAt = new Date().toISOString();
          saveState(doneState);
        }

        // Broadcast task done event via SSE
        broadcastEvent(projectId, { type: 'task_done', taskIndex, timestamp: new Date().toISOString() });
      }
    } catch (err) {
      // Check if cancelled during execution
      if (!executionState.running) {
        return;
      }

      failedCount++;
      console.error(`[ORCHESTRATION] Task ${taskIndex} failed:`, err.message);

      // Immediately update task state to 'failed' so polling reflects the correct state
      const failState = getState();
      const failProject = failState.projects.find(p => p.id === projectId);
      if (failProject && failProject.tasks[taskIndex]) {
        failProject.tasks[taskIndex].state = 'failed';
        failProject.tasks[taskIndex].completedAt = new Date().toISOString();
        saveState(failState);
      }

      // Broadcast task failed event via SSE
      broadcastEvent(projectId, { type: 'task_failed', taskIndex, error: err.message, timestamp: new Date().toISOString() });
    } finally {
      // Reset queue state
      taskQueue.isProcessing = false;
      taskQueue.currentTaskIndex = null;
    }

    // ── Pause check: gracefully halt between tasks without failing remaining pending tasks ──
    if (executionState.pauseRequested) {
      console.log(`[ORCHESTRATION] Pause requested — stopping after task ${taskIndex}. Remaining tasks left pending.`);
      executionState.running = false;
      executionState.pauseRequested = false;

      // Revert any remaining in_progress tasks (defensive) and ensure remaining selected tasks stay pending
      const pauseState = getState();
      const pauseProject = pauseState.projects.find(p => p.id === projectId);
      if (pauseProject) {
        const currentIdx = taskIndices.indexOf(taskIndex);
        const remainingIndices = taskIndices.slice(currentIdx + 1);
        for (const remIdx of remainingIndices) {
          if (pauseProject.tasks[remIdx] && pauseProject.tasks[remIdx].state === 'in_progress') {
            pauseProject.tasks[remIdx].state = 'pending';
          }
        }
        saveState(pauseState);
      }

      broadcastEvent(projectId, {
        type: 'orchestration_paused',
        completed: completedCount,
        failed: failedCount,
        lastTaskIndex: taskIndex,
        timestamp: new Date().toISOString()
      });

      taskQueue.isProcessing = false;
      taskQueue.currentTaskIndex = null;
      return;
    }

    // Check if there are more tasks to run (only proceed if current task succeeded)
    const currentIndex = taskIndices.indexOf(taskIndex);
    const nextIdx = taskIndices[currentIndex + 1];

    if (nextIdx !== undefined && executionState.running) {
      // Small delay between tasks for stability
      setTimeout(() => runNextTask(nextIdx, project.tasks[nextIdx].prompt), 1000);
    } else {
      finalizeOrchestration();
    }
  };

  // Helper function to finalize orchestration
  const finalizeOrchestration = () => {
    console.log(`[ORCHESTRATION] Complete: ${completedCount} succeeded, ${failedCount} failed`);

    // Broadcast orchestration complete event via SSE
    broadcastEvent(projectId, {
      type: 'orchestration_complete',
      completed: completedCount,
      failed: failedCount,
      timestamp: new Date().toISOString()
    });

    // Update final state — mark any remaining in_progress tasks as failed (cancelled mid-execution)
    // Note: successful tasks are already marked 'done' and failed tasks are already marked 'failed'
    // in runNextTask(), so this only catches the edge case of cancellation during execution.
    const finalState = getState();
    const finalProject = finalState.projects.find(p => p.id === projectId);
    if (finalProject) {
      for (const { index } of tasksToRun) {
        if (finalProject.tasks[index].state === 'in_progress') {
          finalProject.tasks[index].state = 'failed';
          finalProject.tasks[index].completedAt = new Date().toISOString();
        }
      }
    }
    saveState(finalState);

    // Reset execution state and queue
    executionState.running = false;
    taskQueue.isProcessing = false;
    taskQueue.currentTaskIndex = null;
  };

  // Start first task immediately
  runNextTask(tasksToRun[0].index, tasksToRun[0].prompt);

  res.json({ success: true, message: 'Orchestration started', tasksToRun });
});

// Reset all task states to pending
app.post('/api/project/:id/tasks/reset', (req, res) => {
  const { id: projectId } = req.params;
  console.log(`[ORCHESTRATION] POST /api/project/${projectId}/tasks/reset | Resetting task states`);

  const state = getState();
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  project.tasks = project.tasks.map(task => ({ ...task, state: 'pending', completedAt: undefined }));
  saveState(state);

  res.json({ message: 'Tasks reset', tasks: project.tasks });
});

app.delete('/api/projects/:id', (req, res) => {
  const state = getState();
  console.log(`[PROJECT SCOPE] DELETE /api/projects/${req.params.id} | Deleting project: ${req.params.id}`);
  state.projects = state.projects.filter(p => p.id !== req.params.id);
  if (state.activeProjectId === req.params.id) {
    state.activeProjectId = state.projects.length > 0 ? state.projects[0].id : null;
  }
  saveState(state);
  res.json({ message: 'Project deleted', state });
});

// Manual Git Init Trigger - Initialize git in the project working directory
app.post('/api/project/:id/tasks/:taskIndex/init', (req, res) => {
  const { id: projectId } = req.params;
  
  console.log(`[INIT] POST /api/project/${projectId}/tasks/:init | Manual git init trigger`);
  
  const state = getState();
  const project = state.projects.find(p => p.id === projectId);
  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }
  
  const cwd = project.workingDirectory || '.';
  
  // Check if directory exists
  if (!fs.existsSync(cwd)) {
    console.error(`[INIT] Working directory does not exist: ${cwd}`);
    return res.status(400).json({ success: false, error: `Working directory does not exist: ${cwd}` });
  }
  
  ensureGitInitialized(cwd).then((gitOk) => {
    if (gitOk) {
      res.json({ success: true, message: 'Git repository initialized', directory: cwd });
    } else {
      res.status(500).json({ success: false, error: 'Failed to initialize git repository' });
    }
  }).catch((err) => {
    console.error(`[INIT] Error:`, err);
    res.status(500).json({ success: false, error: err.message });
  });
});

// Manual Aider Trigger - Send a specific prompt to Aider immediately
app.post('/api/project/:id/tasks/:taskIndex/aider', async (req, res) => {
  const { id: projectId, taskIndex } = req.params;
  const { prompt } = req.body;
  
  console.log(`[AIDER MANUAL] POST /api/project/${projectId}/tasks/${taskIndex}/aider | Manual trigger`);
  
  const index = parseInt(taskIndex, 10);
  if (isNaN(index)) {
    return res.status(400).json({ success: false, error: 'Invalid task index' });
  }
  
  if (prompt) {
    const state = getState();
    const project = state.projects.find(p => p.id === projectId);
    if (project && project.tasks[index]) {
      project.tasks[index].prompt = prompt;
      saveState(state);
    }
  }
  
  try {
    // Force aider agent for this specific endpoint
    const state = getState();
    const project = state.projects.find(p => p.id === projectId);
    if (project && project.tasks[index]) {
      project.tasks[index].agent = 'aider';
      saveState(state);
    }

    const singleResult = await triggerAgentSingle(projectId, index);
    res.json(singleResult);
  } catch (error) {
    console.error(`[AIDER MANUAL] Error triggering aider:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Universal Agent Trigger - Send a prompt to either Aider or Cline based on task.agent
app.post('/api/project/:id/tasks/:taskIndex/send', async (req, res) => {
  const { id: projectId, taskIndex } = req.params;
  const { prompt, agent } = req.body;
  
  console.log(`[AGENT MANUAL] POST /api/project/${projectId}/tasks/${taskIndex}/send | Manual trigger`);
  
  const index = parseInt(taskIndex, 10);
  if (isNaN(index)) {
    return res.status(400).json({ success: false, error: 'Invalid task index' });
  }
  
  const state = getState();
  const project = state.projects.find(p => p.id === projectId);
  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }
  
  const selectedAgent = agent || (project.tasks[index] && project.tasks[index].agent) || 'aider';
  
  if (prompt) {
    if (project && project.tasks[index]) {
      project.tasks[index].prompt = prompt;
      saveState(state);
    }
  }
  
  try {
    // Ensure the task is configured to use the selected agent
    if (project.tasks[index]) {
      project.tasks[index].agent = selectedAgent;
      saveState(state);
    }

    console.log(`[AGENT MANUAL] Using ${selectedAgent} for task ${index}`);
    const result = await triggerAgentSingle(projectId, index);
    res.json(result);
  } catch (error) {
    console.error(`[AGENT MANUAL] Error triggering agent:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── LLM Chat Endpoint ───────────────────────────────────────────────

/**
 * POST /api/chat
 * Streams a response from the configured LLM (OpenAI-compatible API).
 * Reads global LLM config via getAiderConfig() pattern, falling back to global aiderConfig.
 * Accepts { message, projectId } and streams SSE response.
 */
app.post('/api/chat', async (req, res) => {
  const { message, projectId, addTelegram } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  // Get LLM config — project-specific if projectId provided, otherwise global fallback
  let llmConfig = {};
  if (projectId) {
    const state = getState();
    const project = state.projects.find(p => p.id === projectId);
    if (project && project.aiderConfig && Object.keys(project.aiderConfig).length > 0) {
      llmConfig = project.aiderConfig;
    } else {
      llmConfig = state.aiderConfig || {};
    }
  } else {
    const state = getState();
    llmConfig = state.aiderConfig || {};
  }

  const apiBase = (llmConfig.apiBase || '').replace(/\/$/, '');
  const apiKey = llmConfig.apiKey || '';
  const model = llmConfig.model || 'gpt-4o';

  if (!apiBase || !apiKey) {
    return res.status(400).json({ error: 'LLM API base URL and key are required. Configure in Settings.' });
  }

  // System prompts instruct the LLM to wrap existing steps (already written by the user)
  // into <<TASK_N>> blocks, preserving original content rather than rewriting or generating new tasks.
  //
  // IMPORTANT: Each task block is self-contained with its own rules embedded inside.
  // The regex that parses the output uses a backreference:
  //   /<<TASK_(\d+)>>([\s\S]*?)<<\s*\/TASK_\1>>/g
  // This means <<TASK_1>> must close with <</TASK_1>>, <<TASK_2>> with <</TASK_2>>, etc.
  // Each block is extracted independently, so rules must be inside each block.
  //
  // When addTelegram is true, the LLM inserts Telegram signal-chain tasks between
  // each implementation step, creating a "start" message at the beginning and a
  // "Step N of X complete" message after each step.

  const systemPromptStandard = `You are a task formatter that wraps existing implementation steps into a structured format. The user will provide steps that are already written — your job is to wrap each step into a <<TASK_N>> block, NOT to rewrite, expand, or generate new steps.

## What to do
1. Read the user's input and identify each distinct step (numbered lists, bullet points, headings, paragraphs, or separate code blocks).
2. Wrap each existing step into a <<TASK_N>> block using incrementing numbers (1, 2, 3...).
3. Preserve the original text of each step EXACTLY as written — do not rewrite, summarize, reformat, or invent any new content. The block contents must be ONLY the user's literal step text.

## What NOT to do
- Do NOT generate new steps or requirements that the user did not provide.
- Do NOT rewrite, rephrase, reformat, or add structure to the user's steps — preserve them verbatim.
- Do NOT merge separate steps into one block.
- Do NOT add commentary, headings, "Objective:" lines, "CODE BLOCK RULES" sections, or any other text the user did not write.
- Do NOT add introductions or conclusions outside the task blocks.

## Output format

Your entire response must consist ONLY of <<TASK_N>> blocks, nothing else. Each block contains ONLY the user's literal step text — nothing added.

<<TASK_1>>
[The user's first step, preserved exactly as written — nothing more, nothing less]
<</TASK_1>>

<<TASK_2>>
[The user's second step, preserved exactly as written — nothing more, nothing less]
<</TASK_2>>

## Critical rules
1. Each <<TASK_N>> block MUST be closed with the matching <</TASK_N>> tag (e.g., TASK_1 closes with <</TASK_1>>, TASK_2 closes with <</TASK_2>>).
2. Block contents MUST be ONLY the user's original step text — do not add any other lines, headers, or annotations.
3. Preserve the user's original content verbatim — your only job is to wrap, not to rewrite.`;


  const systemPromptTelegram = `You are a task formatter that wraps existing implementation steps into a structured format AND inserts Telegram signal-chain messages between each step. The user will provide steps that are already written — your job is to wrap each step into a <<TASK_N>> block (preserving the user's text verbatim) and add Telegram message tasks, NOT to rewrite, expand, or generate new implementation steps.

## What to do
1. Read the user's input and identify each distinct step (numbered lists, bullet points, headings, paragraphs, or separate code blocks).
2. Count the total number of user steps (call this N).
3. Produce exactly (2N + 2) task blocks in this order:
   - TASK_1: A Telegram "Start" message announcing the pipeline has begun
   - Then for each user step S (1 through N):
     a. A <<TASK>> block containing ONLY the user's original step S text, preserved verbatim
     b. A Telegram "✅ Step S of N complete" block with a brief one-sentence summary of what that step accomplished
   - Final block: A Telegram "🎉 Pipeline complete" message marking the end of the pipeline
4. Number the blocks sequentially: TASK_1, TASK_2, TASK_3, … TASK_{2N+2}.

## Telegram task format

Each Telegram task must contain ONLY a single "Telegram Message:" line with the message text. Example:

<<TASK_1>>
Telegram Message: 🚀 Starting pipeline with N implementation steps.
<</TASK_1>>

<<TASK_3>>
Telegram Message: ✅ Step 1 of N complete — [brief one-sentence summary of what step 1 accomplished]
<</TASK_3>>

User-step blocks contain ONLY the user's literal step text — nothing added:

<<TASK_2>>
[The user's first step, preserved exactly as written — nothing more, nothing less]
<</TASK_2>>

## What NOT to do
- Do NOT generate new implementation steps that the user did not provide.
- Do NOT rewrite, rephrase, reformat, or add structure to the user's implementation steps — preserve them verbatim.
- Do NOT merge separate steps into one block.
- Do NOT add commentary, headings, "Objective:" lines, "CODE BLOCK RULES" sections, or any text the user did not write inside the user-step blocks.
- Do NOT add introductions or conclusions outside the task blocks.
- Telegram messages should be brief (one line) with a short summary.

## Output format

Your entire response must consist ONLY of <<TASK_N>> blocks, nothing else.
Total blocks = 2 × (number of user steps) + 2 (the start message and the final completion message).

## Critical rules
1. Each <<TASK_N>> block MUST be closed with the matching <</TASK_N>> tag (e.g., TASK_1 closes with <</TASK_1>>, TASK_2 closes with <</TASK_2>>).
2. User-step blocks contain ONLY the user's literal step text — no added headers, rules, or annotations.
3. Every Telegram task must include a "Telegram Message:" line and nothing else.
4. Preserve the user's original implementation step content verbatim — only the Telegram messages are new content.`;


  const systemPrompt = addTelegram ? systemPromptTelegram : systemPromptStandard;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const response = await axios({
      method: 'post',
      url: `${apiBase}/chat/completions`,
      data: {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        stream: true,
        temperature: 0.3,
        max_tokens: parseInt(llmConfig.maxTokens) || 16384
      },
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      responseType: 'stream'
    });

    let buffer = '';
    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.substring(6).trim();
        if (jsonStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(jsonStr);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            res.write(`data: ${JSON.stringify({ type: 'chunk', content })}\n\n`);
          }
        } catch (e) {
          // Skip unparseable lines
        }
      }
    });

    response.data.on('end', () => {
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: '' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    response.data.on('error', (err) => {
      console.error('[CHAT] Stream error:', err);
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    });

  } catch (error) {
    console.error('[CHAT] Error:', error.message);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

// ──────────────────────────────────────────────────────────────────────

// Aider Configuration API
app.get('/api/config', (req, res) => {
  const state = getState();
  console.log(`[CONFIG] GET /api/config`);
  res.json({
    aiderConfig: state.aiderConfig || {},
    telegramConfig: state.telegramConfig || {}
  });
});

app.post('/api/config', (req, res) => {
  const { aiderConfig, telegramConfig } = req.body;
  console.log(`[CONFIG] POST /api/config | Saving config`);
  const state = getState();
  if (aiderConfig !== undefined) state.aiderConfig = aiderConfig || {};
  if (telegramConfig !== undefined) state.telegramConfig = telegramConfig || {};
  saveState(state);
  res.json({
    message: 'Configuration saved',
    aiderConfig: state.aiderConfig,
    telegramConfig: state.telegramConfig
  });
});

// Telegram Test Endpoint — sends a test message via Telegram Bot API
app.post('/api/telegram/test', async (req, res) => {
  const { botToken, chatId } = req.body;

  if (!botToken || !chatId) {
    return res.status(400).json({ success: false, error: 'botToken and chatId are required' });
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const resp = await axios.post(url, {
      chat_id: chatId,
      text: '<b>✓ BatonBot Telegram Connected!</b>\n\nYou can now send prompts to yourself via Telegram Messenger.',
      parse_mode: 'HTML'
    });

    if (!resp.data.ok) {
      return res.json({ success: false, error: resp.data.description || 'Telegram API returned error' });
    }

    console.log(`[TELEGRAM] Test message sent successfully to chat ${chatId}`);
    res.json({ success: true, message: 'Test message sent!' });
  } catch (err) {
    console.error(`[TELEGRAM] Test failed:`, err.message);
    res.json({ success: false, error: err.message || 'Failed to connect to Telegram API' });
  }
});

// Log Viewer
app.get('/api/logs', (req, res) => {
  fs.readdir(logsDir, (err, files) => {
    if (err) return res.status(500).json({ error: 'Unable to scan logs directory' });
    const sessions = files.filter(f => f.endsWith('.json')).map(f => ({ id: path.basename(f, '.json'), filename: f }));
    res.json(sessions);
  });
});

app.get('/api/logs/:id', (req, res) => {
  const filePath = path.join(logsDir, `${req.params.id}.json`);
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(404).json({ error: 'Log not found' });
    
    // Parse JSONL format (one JSON object per line) into an array
    const lines = data.trim().split('\n').filter(line => line.trim());
    const events = lines.map(line => JSON.parse(line));
    
    res.setHeader('Content-Type', 'application/json');
    res.json(events);
  });
});

// ── Bulk delete logs endpoint (MUST be BEFORE /api/logs/:id to avoid Express 5 routing conflicts) ──
app.post('/api/logs/bulk-delete', (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }

  let deletedCount = 0;
  let errors = [];

  ids.forEach(id => {
    const filePath = path.join(logsDir, `${id}.json`);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deletedCount++;
        console.log(`[LOGS] Bulk deleted log: ${id}`);
      } else {
        errors.push({ id, error: 'not found' });
      }
    } catch (err) {
      console.error(`[LOGS] Error deleting log ${id}:`, err);
      errors.push({ id, error: err.message });
    }
  });

  res.json({
    success: true,
    deletedCount,
    errors: errors.length > 0 ? errors : undefined
  });
});

// Log deletion handler (works with Express 5 which may not support app.delete)
function handleDeleteLog(req, res) {
  const filePath = path.join(logsDir, `${req.params.id}.json`);
  
  // Verify the file exists
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Log not found' });
  }
  
  try {
    fs.unlinkSync(filePath);
    console.log(`[LOGS] Deleted log: ${req.params.id}`);
    res.json({ success: true, message: 'Log deleted successfully' });
  } catch (err) {
    console.error(`[LOGS] Error deleting log:`, err);
    res.status(500).json({ error: 'Failed to delete log file' });
  }
}

// Express 5 compatible DELETE handler for logs
app.all('/api/logs/:id', (req, res, next) => {
  if (req.method === 'DELETE') return handleDeleteLog(req, res);
  next();
});

app.get('/logs', (req, res) => {
  res.redirect('/');
});

// Proxy to LM Studio
const LM_STUDIO_URL = process.env.LM_STUDIO_URL || 'http://localhost:1234/v1';

// Proxy Status Endpoint — checks if LM Studio is reachable
app.get('/api/proxy/status', async (req, res) => {
  try {
    await axios.get(`${LM_STUDIO_URL}/models`, { timeout: 3000 });
    res.json({ active: true });
  } catch {
    res.json({ active: false });
  }
});

// Alias: /api/status → same as /api/proxy/status (used by frontend settings.js)
app.get('/api/status', async (req, res) => {
  try {
    // Check if the Cline proxy (port 4322) is reachable
    const proxyUrl = process.env.CLINE_PROXY_URL || 'http://localhost:4322';
    await axios.get(`${proxyUrl}/health`, { timeout: 3000 });
    res.json({ active: true });
  } catch {
    // Fallback: check LM Studio status as well
    try {
      await axios.get(`${LM_STUDIO_URL}/models`, { timeout: 3000 });
      res.json({ active: true, proxy: false });
    } catch {
      res.json({ active: false });
    }
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const response = await axios({
      method: 'post',
      url: `${LM_STUDIO_URL}/chat/completions`,
      data: req.body,
      headers: { 'Content-Type': 'application/json' },
      responseType: 'stream',
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let responseBuffer = '';
    response.data.on('data', (chunk) => {
      responseBuffer += chunk.toString();
      res.write(chunk);
    });

    response.data.on('end', () => {
      let aggregatedText = '';
      const lines = responseBuffer.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.substring(6).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(jsonStr);
            aggregatedText += parsed.choices?.[0]?.delta?.content || '';
          } catch (e) {}
        }
      }
      appendToLog(req.requestId, {
        id: req.requestId,
        timestamp: new Date().toISOString(),
        request: req.body,
        response: responseBuffer,
        responseText: aggregatedText || '(No content captured)',
      });
      res.end();
    });

    response.data.on('error', (err) => {
      console.error('Stream error:', err);
      res.end();
    });
  } catch (error) {
    appendToLog(req.requestId, {
      id: req.requestId,
      timestamp: new Date().toISOString(),
      request: req.body,
      error: error.message,
      status: error.response?.status || 500
    });
    if (error.code === 'ECONNREFUSED') {
      res.status(503).json({ error: 'LM Studio Connection Failed' });
    } else {
      res.status(error.response?.status || 500).json(error.response?.data || { error: error.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});