/* ═══════════════════════════════════════════
   Board — Kanban-style task board.
   Replaces the linear pipeline editor with three columns:
     • Pending   (orchestrate: false, not done/failed)
     • Queue     (orchestrate: true,  not done/failed)
     • Completed (state: done | failed | stopped)
   Handles:
     • Rendering cards from the project's task list
     • Drag-and-drop between columns and reorder within Queue
     • Agent palette: + button and drag-to-column to add cards
     • Play / Pause via /orchestrate + /pause endpoints
     • SSE-driven live updates while running
     • Card detail drawer (prompt editor + agent + delete + history)
   ═══════════════════════════════════════════ */
(function() {
  'use strict';

  // ── Module state ─────────────────────────────────────────────────────
  let boardTasks = [];                // local copy of tasks (synced from server)
  // boardProjectId — the project id that boardTasks was loaded from.
  // We pin every save/fetch to THIS id rather than re-reading window.activeProjectId
  // at the moment the request fires. Otherwise an in-flight save started before
  // a project switch can land on the new project's tasks document (this caused
  // a newly-created project pointed at the same working directory as a previous
  // one to inherit the previous project's task cards).
  let boardProjectId = null;
  // loadToken — monotonically increasing token bumped on every activateProject().
  // Any async chain that wants to commit results to boardTasks must capture the
  // token at the start and bail if it no longer matches when the promise resolves.
  let loadToken = 0;
  let isRunning = false;              // orchestration in-progress
  let pauseRequested = false;         // true while we're waiting for current task to settle after pause
  let sseSource = null;               // EventSource for /tasks/stream
  let saveDebounceTimer = null;       // debounce for saveTasks()
  let currentDetailIndex = null;      // task index currently shown in detail drawer
  let allSessions = [];               // cached session list for detail drawer history

  const AGENT_LABELS = {
    'baton-code': 'Baton Code',
    'baton-code-thinking': 'Baton Code · Thinking',
    'cline': 'Cline',
    'aider': 'Aider',
    'telegram': 'Telegram'
  };
  const STATE_LABELS = {
    pending: 'Pending',
    in_progress: 'Running',
    planning: 'Planning',
    done: 'Done',
    failed: 'Failed',
    stopped: 'Stopped'
  };

  // ── Helpers ──────────────────────────────────────────────────────────
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getActiveProjectId() {
    return window.activeProjectId || null;
  }

  function classifyColumn(task) {
    const s = task.state || 'pending';
    if (s === 'done') return 'completed';
    if (s === 'failed' || s === 'stopped') return 'completed';
    if (task.orchestrate) return 'queue';
    return 'pending';
  }

  // ── Server I/O ────────────────────────────────────────────────────────
  // All server I/O is pinned to an explicit projectId argument. Callers MUST
  // pass the id that the in-memory boardTasks was loaded for (boardProjectId),
  // never read window.activeProjectId at the moment of the request — that's
  // exactly the race that let a stale write land on the wrong project.
  async function fetchTasks(pid) {
    if (!pid) return [];
    try {
      const r = await fetch(`/api/project/${pid}/tasks`);
      if (!r.ok) return [];
      const d = await r.json();
      return d.tasks || [];
    } catch (e) {
      console.error('[BOARD] fetchTasks failed', e);
      return [];
    }
  }

  async function saveTasks(tasks, pid) {
    if (!pid) return false;
    try {
      const r = await fetch(`/api/project/${pid}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks })
      });
      return r.ok;
    } catch (e) {
      console.error('[BOARD] saveTasks failed', e);
      return false;
    }
  }

  function debouncedSave() {
    const pid = boardProjectId;
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => { saveTasks(boardTasks, pid); }, 250);
  }

  // saveAndRefresh — common pattern: save current boardTasks to the project
  // they belong to, then refetch that project. Guarded so we won't clobber
  // a newer project's data if the user switched mid-flight.
  async function saveAndRefresh() {
    const pid = boardProjectId;
    const token = loadToken;
    await saveTasks(boardTasks, pid);
    if (token !== loadToken || pid !== boardProjectId) return; // user switched projects mid-save
    const fresh = await fetchTasks(pid);
    if (token !== loadToken || pid !== boardProjectId) return;
    boardTasks = fresh;
    renderBoard();
  }

  // ── Render ────────────────────────────────────────────────────────────
  function renderBoard() {
    const cols = {
      pending: document.querySelector('[data-drop-target="pending"]'),
      queue: document.querySelector('[data-drop-target="queue"]'),
      completed: document.querySelector('[data-drop-target="completed"]')
    };
    if (!cols.pending || !cols.queue || !cols.completed) return;

    // Reset
    cols.pending.innerHTML = '';
    cols.queue.innerHTML = '';
    cols.completed.innerHTML = '';

    const counts = { pending: 0, queue: 0, completed: 0 };

    if (!boardTasks || boardTasks.length === 0) {
      cols.pending.innerHTML = '<div class="column-empty">Drop agents here or use the ＋ buttons</div>';
      cols.queue.innerHTML = '<div class="column-empty">Drag tasks here to queue them</div>';
      cols.completed.innerHTML = '<div class="column-empty">Finished tasks land here</div>';
      updateCounts(counts);
      updatePlayButton();
      return;
    }

    boardTasks.forEach((task, index) => {
      const col = classifyColumn(task);
      counts[col]++;
      cols[col].appendChild(createCardEl(task, index));
    });

    // Empty placeholders if column has no cards
    Object.keys(cols).forEach(k => {
      if (counts[k] === 0) {
        const msg = {
          pending: 'Drop agents here or use the ＋ buttons',
          queue: 'Drag tasks here to queue them',
          completed: 'Finished tasks land here'
        }[k];
        cols[k].innerHTML = `<div class="column-empty">${msg}</div>`;
      }
    });

    updateCounts(counts);
    updatePlayButton();
  }

  function updateCounts(counts) {
    document.querySelectorAll('[data-count]').forEach(el => {
      const k = el.getAttribute('data-count');
      if (k in counts) el.textContent = counts[k];
    });
  }

  function createCardEl(task, index) {
    const state = task.state || 'pending';
    const agent = task.agent || 'aider';
    const promptText = (task.prompt || '').trim();

    const card = document.createElement('div');
    card.className = `board-card state-${state}`;
    card.draggable = !isRunning;
    card.dataset.index = String(index);
    card.dataset.agent = agent;

    const stateIcon = (state === 'done') ? '✓ '
                    : (state === 'in_progress' || state === 'planning') ? '• '
                    : (state === 'failed' || state === 'stopped') ? '! '
                    : '';

    card.innerHTML = `
      <div class="card-header">
        <span class="card-agent-label" data-agent="${esc(agent)}"><span class="card-agent-dot"></span>${esc(agent)}</span>
        <span class="card-state-badge state-${state}">${stateIcon}${esc((STATE_LABELS[state] || state).toLowerCase())}</span>
      </div>
      <div class="card-prompt ${promptText ? '' : 'empty'}">${promptText ? esc(promptText) : 'Click to edit prompt…'}</div>
      <div class="card-footer">
        <select class="card-agent-select" data-action="agent">
          ${Object.keys(AGENT_LABELS).map(k =>
            `<option value="${k}" ${k === agent ? 'selected' : ''}>${esc(AGENT_LABELS[k])}</option>`
          ).join('')}
        </select>
        <div class="card-actions">
          <button class="card-action-btn" data-action="edit" title="Open detail">✎</button>
          <button class="card-action-btn danger" data-action="delete" title="Delete task">🗑</button>
        </div>
      </div>
    `;

    return card;
  }

  // ── Play / Pause UI state ─────────────────────────────────────────────
  function updatePlayButton() {
    const btn = document.getElementById('btn-play-queue');
    if (!btn) return;

    const queueCount = boardTasks.filter(t => classifyColumn(t) === 'queue').length;

    if (isRunning) {
      btn.disabled = false;
      btn.classList.add('is-pause');
      btn.textContent = pauseRequested ? '⏳' : '⏸';
      btn.title = pauseRequested ? 'Pause requested — will halt after current task' : 'Pause sequence';
    } else {
      btn.classList.remove('is-pause');
      btn.textContent = '▶';
      btn.disabled = queueCount === 0 || !getActiveProjectId();
      btn.title = queueCount === 0
        ? 'Drag tasks into Queue to enable'
        : 'Run Queue top to bottom';
    }

    const cols = document.getElementById('board-columns');
    if (cols) cols.classList.toggle('locked', isRunning);
  }

  // ── Drag and Drop ─────────────────────────────────────────────────────
  let dragState = null; // { kind: 'card' | 'agent', index?, agent? }

  function setupDnD() {
    const board = document.getElementById('board-columns');
    if (!board) return;

    // Card-level drag handlers (delegated)
    board.addEventListener('dragstart', (e) => {
      if (isRunning) { e.preventDefault(); return; }
      const card = e.target.closest('.board-card');
      if (!card) return;
      const idx = parseInt(card.dataset.index, 10);
      dragState = { kind: 'card', index: idx };
      card.classList.add('dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `card:${idx}`);
      } catch (_) {}
    });

    board.addEventListener('dragend', (e) => {
      const card = e.target.closest('.board-card');
      if (card) card.classList.remove('dragging');
      document.querySelectorAll('.column-body.drag-over').forEach(el => el.classList.remove('drag-over'));
      document.querySelectorAll('.board-card.drag-over-top, .board-card.drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      dragState = null;
    });

    // Drop targets for each column
    document.querySelectorAll('[data-drop-target]').forEach(target => {
      target.addEventListener('dragover', (e) => {
        if (!dragState || isRunning) return;
        e.preventDefault();
        // dropEffect MUST match the dragstart's effectAllowed, otherwise the
        // browser silently rejects the drop and our 'drop' handler never fires.
        // Palette items are 'copy' (creating a new card); existing card moves are 'move'.
        e.dataTransfer.dropEffect = dragState.kind === 'agent' ? 'copy' : 'move';
        target.classList.add('drag-over');

        // For queue column, show reorder indicator
        const colName = target.getAttribute('data-drop-target');
        if (colName === 'queue' && dragState.kind === 'card') {
          const overCard = e.target.closest('.board-card');
          document.querySelectorAll('.board-card.drag-over-top, .board-card.drag-over-bottom').forEach(el => {
            el.classList.remove('drag-over-top', 'drag-over-bottom');
          });
          if (overCard && overCard.dataset.index !== String(dragState.index)) {
            const rect = overCard.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            overCard.classList.add(e.clientY < midY ? 'drag-over-top' : 'drag-over-bottom');
          }
        }
      });

      target.addEventListener('dragleave', (e) => {
        if (!target.contains(e.relatedTarget)) target.classList.remove('drag-over');
      });

      target.addEventListener('drop', (e) => {
        e.preventDefault();
        target.classList.remove('drag-over');
        if (!dragState || isRunning) return;

        const colName = target.getAttribute('data-drop-target');
        handleDrop(colName, target, e);
        dragState = null;
      });
    });

    // Agent palette drag sources + click handlers
    const palette = document.getElementById('agent-palette');
    if (palette) {
      palette.addEventListener('dragstart', (e) => {
        if (isRunning) { e.preventDefault(); return; }
        const agentEl = e.target.closest('.palette-agent');
        if (!agentEl) return;
        const agent = agentEl.dataset.agent;
        dragState = { kind: 'agent', agent };
        agentEl.classList.add('dragging');
        try {
          e.dataTransfer.effectAllowed = 'copy';
          e.dataTransfer.setData('text/plain', `agent:${agent}`);
        } catch (_) {}
      });
      palette.addEventListener('dragend', (e) => {
        const agentEl = e.target.closest('.palette-agent');
        if (agentEl) agentEl.classList.remove('dragging');
      });
    }
  }

  function handleDrop(colName, target, e) {
    if (dragState.kind === 'agent') {
      // Create new task pre-assigned to this agent in the dropped column
      const newTask = {
        prompt: '',
        state: 'pending',
        orchestrate: colName === 'queue',
        agent: dragState.agent
      };
      if (colName === 'completed') {
        // Don't allow adding directly to completed
        boardTasks.push({ ...newTask, orchestrate: false });
      } else {
        boardTasks.push(newTask);
      }
      saveAndRefresh();
      return;
    }

    if (dragState.kind === 'card') {
      const srcIdx = dragState.index;
      const card = boardTasks[srcIdx];
      if (!card) return;

      // Determine drop position within queue (for reordering)
      if (colName === 'queue') {
        const overCard = e.target.closest('.board-card');
        let insertIndex = -1;
        if (overCard) {
          const overIdx = parseInt(overCard.dataset.index, 10);
          const rect = overCard.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          insertIndex = e.clientY < midY ? overIdx : overIdx + 1;
        }

        // Mutate: move within array
        card.orchestrate = true;
        // Reset terminal states back to pending if dragging back from completed
        if (card.state === 'done' || card.state === 'failed' || card.state === 'stopped') {
          card.state = 'pending';
        }
        if (insertIndex >= 0 && insertIndex !== srcIdx) {
          // Remove from old position, insert at new
          boardTasks.splice(srcIdx, 1);
          if (insertIndex > srcIdx) insertIndex--;
          boardTasks.splice(insertIndex, 0, card);
        }
      } else if (colName === 'pending') {
        card.orchestrate = false;
        if (card.state === 'done' || card.state === 'failed' || card.state === 'stopped') {
          card.state = 'pending';
        }
      } else if (colName === 'completed') {
        // Dragging into Completed manually marks done
        card.orchestrate = false;
        card.state = 'done';
      }

      // Reassign ids
      boardTasks.forEach((t, i) => { t.id = i; });

      // Persist (pinned to the project this data came from) + re-render
      const pid = boardProjectId;
      saveTasks(boardTasks, pid).then(() => {
        if (pid === boardProjectId) renderBoard();
      });
    }
  }

  // ── Card click / inline interactions ──────────────────────────────────
  function setupCardInteractions() {
    const board = document.getElementById('board-columns');
    if (!board) return;

    board.addEventListener('click', (e) => {
      const card = e.target.closest('.board-card');
      if (!card) return;
      const idx = parseInt(card.dataset.index, 10);

      if (isRunning) return; // locked

      // Action buttons
      if (e.target.closest('[data-action="delete"]')) {
        e.stopPropagation();
        if (!confirm('Delete this task?')) return;
        boardTasks.splice(idx, 1);
        boardTasks.forEach((t, i) => { t.id = i; });
        const pid = boardProjectId;
        saveTasks(boardTasks, pid).then(() => { if (pid === boardProjectId) renderBoard(); });
        return;
      }
      if (e.target.closest('[data-action="edit"]')) {
        e.stopPropagation();
        openCardDetail(idx);
        return;
      }
      if (e.target.closest('[data-action="agent"]')) return; // handled by 'change'

      // Click prompt body → open detail
      if (e.target.closest('.card-prompt') || e.target.closest('.card-header')) {
        openCardDetail(idx);
      }
    });

    board.addEventListener('change', (e) => {
      const sel = e.target.closest('[data-action="agent"]');
      if (!sel) return;
      const card = sel.closest('.board-card');
      if (!card) return;
      const idx = parseInt(card.dataset.index, 10);
      if (isNaN(idx) || !boardTasks[idx]) return;
      boardTasks[idx].agent = sel.value;
      const pid = boardProjectId;
      saveTasks(boardTasks, pid).then(() => { if (pid === boardProjectId) renderBoard(); });
    });
  }

  // ── Palette interactions ──────────────────────────────────────────────
  function setupPalette() {
    const palette = document.getElementById('agent-palette');
    if (!palette) return;

    // Section accordion
    palette.addEventListener('click', (e) => {
      const header = e.target.closest('.palette-section-header');
      if (header) {
        const section = header.closest('.palette-section');
        if (section) {
          section.classList.toggle('open');
          const chev = section.querySelector('.palette-section-chevron');
          if (chev) chev.textContent = section.classList.contains('open') ? '▾' : '▸';
        }
        return;
      }
      const addBtn = e.target.closest('.palette-add-btn');
      if (addBtn) {
        const agentEl = addBtn.closest('.palette-agent');
        if (!agentEl) return;
        const agent = agentEl.dataset.agent;
        if (!boardProjectId) { alert('Please select or create a project first.'); return; }
        boardTasks.push({ prompt: '', state: 'pending', orchestrate: false, agent });
        saveAndRefresh();
      }
    });
  }

  // ── Card detail drawer ────────────────────────────────────────────────
  function openCardDetail(index) {
    const task = boardTasks[index];
    if (!task) return;
    currentDetailIndex = index;

    const stateEl = document.getElementById('card-detail-state');
    const agentEl = document.getElementById('card-detail-agent');
    const promptEl = document.getElementById('card-detail-prompt');
    const agentSelEl = document.getElementById('card-detail-agent-select');
    const sessionsEl = document.getElementById('card-detail-sessions');

    const state = task.state || 'pending';
    const agent = task.agent || 'aider';

    if (stateEl) {
      stateEl.className = 'card-detail-state state-' + state;
      stateEl.textContent = STATE_LABELS[state] || state;
    }
    if (agentEl) {
      agentEl.className = 'card-detail-agent';
      agentEl.setAttribute('data-agent', agent);
      agentEl.innerHTML = `<span class="card-agent-dot"></span>${esc(AGENT_LABELS[agent] || agent)}`;
    }
    if (promptEl) promptEl.value = task.prompt || '';
    if (agentSelEl) agentSelEl.value = agent;

    // Load matching sessions for this task index
    if (sessionsEl) {
      sessionsEl.innerHTML = '<p style="color:#888;font-size:0.85rem;">Loading sessions…</p>';
      loadSessionsForTask(index, sessionsEl);
    }

    // Open drawer
    document.getElementById('card-detail-backdrop')?.classList.add('open');
    document.getElementById('card-detail-drawer')?.classList.add('open');
  }

  function closeCardDetail() {
    document.getElementById('card-detail-backdrop')?.classList.remove('open');
    document.getElementById('card-detail-drawer')?.classList.remove('open');
    currentDetailIndex = null;
  }

  async function loadSessionsForTask(taskIndex, container) {
    try {
      if (allSessions.length === 0) {
        const r = await fetch('/api/logs');
        if (r.ok) allSessions = await r.json();
      }
      const pid = getActiveProjectId();
      const state = await fetch('/api/projects').then(r => r.json()).catch(() => ({}));
      const project = (state.projects || []).find(p => p.id === pid);
      const projectTitle = ((project && project.name) || pid || '').replace(/[^a-zA-Z0-9_-]/g, '_');

      const taskPattern = new RegExp(`^${projectTitle}_(aider|cline|baton-code-thinking|baton-code|telegram)_task_${taskIndex}_`);
      const matches = allSessions.filter(s => taskPattern.test(s.id));

      if (matches.length === 0) {
        container.innerHTML = '<p style="color:#888;font-size:0.85rem;">No sessions yet for this task.</p>';
        return;
      }
      container.innerHTML = matches
        .sort((a, b) => b.id.localeCompare(a.id))
        .map(s => `<a class="session-link" data-session-id="${esc(s.id)}">${esc(s.id)}</a>`)
        .join('');
    } catch (e) {
      console.error('[BOARD] loadSessionsForTask failed', e);
      container.innerHTML = '<p style="color:#888;font-size:0.85rem;">Could not load sessions.</p>';
    }
  }

  function setupCardDetailDrawer() {
    document.getElementById('btn-close-card-detail')?.addEventListener('click', closeCardDetail);
    document.getElementById('card-detail-backdrop')?.addEventListener('click', closeCardDetail);

    document.getElementById('btn-save-card-detail')?.addEventListener('click', async () => {
      if (currentDetailIndex == null) return;
      const promptEl = document.getElementById('card-detail-prompt');
      const agentSelEl = document.getElementById('card-detail-agent-select');
      if (!boardTasks[currentDetailIndex]) return;
      boardTasks[currentDetailIndex].prompt = (promptEl?.value || '').trim();
      boardTasks[currentDetailIndex].agent = agentSelEl?.value || 'aider';
      const pid = boardProjectId;
      await saveTasks(boardTasks, pid);
      if (pid === boardProjectId) renderBoard();
      closeCardDetail();
    });

    document.getElementById('btn-delete-card-detail')?.addEventListener('click', async () => {
      if (currentDetailIndex == null) return;
      if (!confirm('Delete this task?')) return;
      boardTasks.splice(currentDetailIndex, 1);
      boardTasks.forEach((t, i) => { t.id = i; });
      const pid = boardProjectId;
      await saveTasks(boardTasks, pid);
      if (pid === boardProjectId) renderBoard();
      closeCardDetail();
    });

    // Session link click → switch to Logs tab and load session
    document.getElementById('card-detail-sessions')?.addEventListener('click', (e) => {
      const link = e.target.closest('.session-link');
      if (!link) return;
      const sid = link.getAttribute('data-session-id');
      if (sid && typeof window.openTab === 'function') {
        window.openTab('log-viewer');
        if (typeof window.openSession === 'function') {
          setTimeout(() => window.openSession(sid), 100);
        }
      }
    });
  }

  // ── Play / Pause / Orchestrate ────────────────────────────────────────
  async function startOrchestration() {
    const pid = boardProjectId;
    if (!pid) return;

    // Always sync current order to server first (pinned to boardProjectId)
    await saveTasks(boardTasks, pid);
    if (pid !== boardProjectId) return; // user switched mid-flight

    // Collect indices for queue cards in their current order
    const indices = [];
    boardTasks.forEach((t, i) => {
      if (classifyColumn(t) === 'queue') indices.push(i);
    });
    if (indices.length === 0) return;

    try {
      const r = await fetch(`/api/project/${pid}/tasks/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIndices: indices })
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert('Failed to start sequence: ' + (err.error || r.status));
        return;
      }
      isRunning = true;
      pauseRequested = false;
      ensureSseConnected();
      updatePlayButton();
    } catch (e) {
      console.error('[BOARD] startOrchestration failed', e);
      alert('Failed to start sequence: ' + e.message);
    }
  }

  async function requestPause() {
    const pid = boardProjectId;
    if (!pid) return;
    try {
      const r = await fetch(`/api/project/${pid}/tasks/pause`, { method: 'POST' });
      if (r.ok) {
        pauseRequested = true;
        updatePlayButton();
      }
    } catch (e) {
      console.error('[BOARD] requestPause failed', e);
    }
  }

  function onPlayButtonClick() {
    if (isRunning) {
      requestPause();
    } else {
      startOrchestration();
    }
  }

  // ── SSE stream ────────────────────────────────────────────────────────
  function ensureSseConnected() {
    const pid = getActiveProjectId();
    if (!pid) return;
    if (sseSource && sseSource._projectId === pid && sseSource.readyState !== 2) return;
    if (sseSource) { try { sseSource.close(); } catch (_) {} sseSource = null; }

    const src = new EventSource(`/api/project/${pid}/tasks/stream`);
    src._projectId = pid;
    src.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        handleSseEvent(evt);
      } catch (_) {}
    };
    src.onerror = () => {
      // Browser will auto-reconnect; nothing else to do.
    };
    sseSource = src;
  }

  function handleSseEvent(evt) {
    if (!evt || !evt.type) return;
    switch (evt.type) {
      case 'orchestration_start':
        isRunning = true;
        pauseRequested = false;
        updatePlayButton();
        break;
      case 'task_start':
        if (typeof evt.taskIndex === 'number' && boardTasks[evt.taskIndex]) {
          boardTasks[evt.taskIndex].state = 'in_progress';
          renderBoard();
        }
        break;
      case 'task_done':
        if (typeof evt.taskIndex === 'number' && boardTasks[evt.taskIndex]) {
          boardTasks[evt.taskIndex].state = 'done';
          renderBoard();
        }
        break;
      case 'task_failed':
        if (typeof evt.taskIndex === 'number' && boardTasks[evt.taskIndex]) {
          boardTasks[evt.taskIndex].state = 'failed';
          renderBoard();
        }
        break;
      case 'pause_requested':
        pauseRequested = true;
        updatePlayButton();
        break;
      case 'orchestration_paused': {
        isRunning = false;
        pauseRequested = false;
        // Re-sync from server to catch any pending state reverts (project-pinned)
        const pid = boardProjectId;
        const token = loadToken;
        fetchTasks(pid).then(t => {
          if (token !== loadToken || pid !== boardProjectId) return;
          boardTasks = t;
          renderBoard();
        });
        break;
      }
      case 'orchestration_complete':
      case 'cancelled': {
        isRunning = false;
        pauseRequested = false;
        const pid = boardProjectId;
        const token = loadToken;
        fetchTasks(pid).then(t => {
          if (token !== loadToken || pid !== boardProjectId) return;
          boardTasks = t;
          renderBoard();
        });
        break;
      }
      case 'plan_start':
        if (typeof evt.taskIndex === 'number' && boardTasks[evt.taskIndex]) {
          boardTasks[evt.taskIndex].state = 'planning';
          renderBoard();
        }
        break;
    }
  }

  // ── Context bar wiring ────────────────────────────────────────────────
  // refreshProjectSelectOptions — repopulate the <select> options WITHOUT
  // activating any project as a side effect. Used by submitQuickProject so
  // we don't briefly re-activate the previously-selected project (which was
  // the trigger for the "new project inherits old project's cards" bug).
  async function refreshProjectSelectOptions(selectedId) {
    const sel = document.getElementById('context-project-select');
    if (!sel) return;
    try {
      const r = await fetch('/api/projects');
      const data = await r.json();
      const projects = data.projects || [];
      const activeId = selectedId || data.activeProjectId || null;
      sel.innerHTML = '<option value="">— Select a project —</option>' +
        projects.map(p => `<option value="${esc(p.id)}" ${p.id === activeId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    } catch (e) {
      console.error('[BOARD] refreshProjectSelectOptions failed', e);
    }
  }

  async function populateProjectSelect() {
    const sel = document.getElementById('context-project-select');
    if (!sel) return;
    try {
      const r = await fetch('/api/projects');
      const data = await r.json();
      const projects = data.projects || [];
      const activeId = data.activeProjectId || null;

      sel.innerHTML = '<option value="">— Select a project —</option>' +
        projects.map(p => `<option value="${esc(p.id)}" ${p.id === activeId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

      if (activeId) {
        await activateProject(activeId, /*silent*/ true);
      } else {
        setEmptyBoard();
      }
    } catch (e) {
      console.error('[BOARD] populateProjectSelect failed', e);
    }
  }

  async function activateProject(id, silent) {
    // Bump the load token FIRST so any in-flight callbacks from a previous
    // project know they've been superseded and bail out before mutating
    // boardTasks. Also cancel any pending debounced save targeted at the
    // outgoing project — its in-memory state belongs to the OLD pid and
    // must not be flushed to the server after we've swapped contexts.
    loadToken++;
    const token = loadToken;
    if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }

    if (!id) {
      boardProjectId = null;
      window.activeProjectId = null;
      setEmptyBoard();
      // COMING SOON: Live Output panel. No-op today (see modules/terminal.js).
      if (window.__terminalHooks && window.__terminalHooks.onProjectReset) {
        try { await window.__terminalHooks.onProjectReset(); } catch (_) {}
      }
      return;
    }

    // Clear the board immediately so the user never sees the previous
    // project's cards while the new project's data is loading.
    boardTasks = [];
    boardProjectId = id;
    window.activeProjectId = id;
    renderBoard();

    try {
      await fetch('/api/projects/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: id })
      });
    } catch (_) {}
    if (token !== loadToken) return; // superseded

    // Update context bar
    const data = await fetch('/api/projects').then(r => r.json()).catch(() => ({}));
    if (token !== loadToken) return;
    const project = (data.projects || []).find(p => p.id === id);
    if (project) {
      const wd = document.getElementById('context-workdir');
      if (wd) { wd.textContent = project.workingDirectory || '.'; wd.title = project.workingDirectory || '.'; }
      document.getElementById('btn-edit-project-context')?.removeAttribute('disabled');
    }

    // Load tasks for THIS project id (pinned), then commit only if still current
    const fresh = await fetchTasks(id);
    if (token !== loadToken) return;
    boardTasks = fresh;
    document.getElementById('board-empty-state')?.classList.add('hidden');
    document.querySelector('.board-layout').style.display = '';
    renderBoard();
    ensureSseConnected();

    // COMING SOON: Live Output panel. The hook below is currently a no-op
    // stub (see modules/terminal.js banner) but we keep the wire in place
    // so v2 of the panel can just drop in the real implementation. This
    // module's own SSE connection (ensureSseConnected) is what drives the
    // pending → running → done card transitions; the terminal hook is
    // independent and only relevant once the Live Output panel returns.
    if (window.__terminalHooks && window.__terminalHooks.onProjectActivated) {
      try { window.__terminalHooks.onProjectActivated(); } catch (_) {}
    }
  }

  function setEmptyBoard() {
    boardTasks = [];
    boardProjectId = null;
    const layout = document.querySelector('.board-layout');
    if (layout) layout.style.display = 'none';
    document.getElementById('board-empty-state')?.classList.remove('hidden');
    document.getElementById('btn-edit-project-context')?.setAttribute('disabled', 'true');
    const wd = document.getElementById('context-workdir');
    if (wd) { wd.textContent = '—'; wd.title = ''; }
    updatePlayButton();
  }

  async function updateModelChip() {
    try {
      const r = await fetch('/api/config');
      if (!r.ok) return;
      const d = await r.json();
      const cfg = d.aiderConfig || {};
      const txt = document.getElementById('context-model-text');
      if (!txt) return;
      if (cfg.model) {
        const provider = cfg.provider || 'custom';
        txt.textContent = `${provider} · ${cfg.model}`;
      } else {
        txt.textContent = '— not configured —';
      }
    } catch (_) {}
  }

  // ── Quick project creation modal ──────────────────────────────────────
  function openQuickProject() {
    document.getElementById('quick-project-backdrop')?.classList.add('open');
    document.getElementById('quick-project-modal')?.classList.add('open');
    setTimeout(() => document.getElementById('quick-project-name')?.focus(), 50);
  }
  function closeQuickProject() {
    document.getElementById('quick-project-backdrop')?.classList.remove('open');
    document.getElementById('quick-project-modal')?.classList.remove('open');
    const n = document.getElementById('quick-project-name');
    const w = document.getElementById('quick-project-workingDir');
    if (n) n.value = '';
    if (w) w.value = '';
  }
  async function submitQuickProject() {
    const name = document.getElementById('quick-project-name')?.value.trim();
    const wd = document.getElementById('quick-project-workingDir')?.value.trim();
    if (!name) { alert('Please enter a project name'); return; }
    try {
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, workingDirectory: wd || null })
      });
      const d = await r.json();
      if (r.ok && d.project) {
        closeQuickProject();
        // Refresh the <select> options WITHOUT activating any project as a
        // side effect (the previous flow called populateProjectSelect() which
        // would re-activate whatever the server reported as the active
        // project — the OLD project — racing against our pending activation
        // of the NEW one and letting in-flight saves leak across).
        await refreshProjectSelectOptions(d.project.id);
        await activateProject(d.project.id);
      } else {
        alert('Failed to create project: ' + (d.error || r.status));
      }
    } catch (e) {
      alert('Failed to create project: ' + e.message);
    }
  }

  // ── Public hooks for legacy modules (projects.js etc) ─────────────────
  window.loadPipeline = async function() {
    // Backward compat for any caller; refreshes board for current project.
    const pid = boardProjectId;
    if (!pid) return;
    const token = loadToken;
    const fresh = await fetchTasks(pid);
    if (token !== loadToken || pid !== boardProjectId) return;
    boardTasks = fresh;
    renderBoard();
  };
  window.refreshPipelineStates = async function() {
    const pid = boardProjectId;
    if (!pid) return;
    const token = loadToken;
    const fresh = await fetchTasks(pid);
    if (token !== loadToken || pid !== boardProjectId) return;
    boardTasks = fresh;
    renderBoard();
  };

  // ── Init ──────────────────────────────────────────────────────────────
  function init() {
    // Play / pause button
    document.getElementById('btn-play-queue')?.addEventListener('click', onPlayButtonClick);

    // Reset button — clears all task states (running/done/failed) back to pending.
    // Useful when the board got stuck (e.g. server restarted mid-run leaving cards in 'in_progress'),
    // or when the user wants to re-run a completed pipeline from scratch.
    document.getElementById('btn-reset-queue')?.addEventListener('click', async () => {
      const pid = boardProjectId;
      if (!pid) return;
      if (!confirm('Reset all task states to pending? This will clear RUNNING, DONE, and FAILED badges so you can start the queue from the top.')) return;
      const token = loadToken;
      try {
        // Best-effort cancel any in-flight orchestration first so the server lets go of children.
        try {
          await fetch(`/api/project/${pid}/tasks/cancel`, { method: 'POST' });
        } catch (_) { /* ignore — cancel might 4xx if nothing is running */ }

        const r = await fetch(`/api/project/${pid}/tasks/reset`, { method: 'POST' });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert('Failed to reset task states: ' + (err.error || r.status));
          return;
        }
        if (token !== loadToken || pid !== boardProjectId) return;
        isRunning = false;
        pauseRequested = false;
        const t = await fetchTasks(pid);
        if (token !== loadToken || pid !== boardProjectId) return;
        boardTasks = t;
        renderBoard();
      } catch (e) {
        console.error('[BOARD] reset failed', e);
        alert('Failed to reset task states: ' + e.message);
      }
    });

    // Context bar
    document.getElementById('context-project-select')?.addEventListener('change', (e) => {
      activateProject(e.target.value);
    });
    document.getElementById('btn-new-project-context')?.addEventListener('click', openQuickProject);
    document.getElementById('btn-create-first-project')?.addEventListener('click', openQuickProject);
    document.getElementById('btn-edit-project-context')?.addEventListener('click', () => {
      const pid = getActiveProjectId();
      if (pid && typeof window.editProject === 'function') window.editProject(pid);
    });
    document.getElementById('context-model-chip')?.addEventListener('click', () => {
      // Open the settings drawer via existing handler
      const settingsBtn = document.getElementById('btn-open-settings');
      if (settingsBtn) settingsBtn.click();
      else if (typeof window.openTab === 'function') window.openTab('log-viewer');
    });
    document.getElementById('btn-open-settings-header')?.addEventListener('click', () => {
      if (typeof window.openTab === 'function') window.openTab('log-viewer');
      setTimeout(() => document.getElementById('btn-open-settings')?.click(), 30);
    });

    // Quick project modal
    document.getElementById('btn-quick-project-create')?.addEventListener('click', submitQuickProject);
    document.getElementById('btn-quick-project-cancel')?.addEventListener('click', closeQuickProject);
    document.getElementById('quick-project-backdrop')?.addEventListener('click', closeQuickProject);

    setupDnD();
    setupCardInteractions();
    setupPalette();
    setupCardDetailDrawer();

    // Initial population
    populateProjectSelect();
    updateModelChip();

    // Refresh model chip when settings drawer closes
    document.getElementById('btn-close-settings-drawer')?.addEventListener('click', () => {
      setTimeout(updateModelChip, 100);
    });
    document.getElementById('btn-save-global-config')?.addEventListener('click', () => {
      setTimeout(updateModelChip, 200);
    });

    // When projects change elsewhere, refresh dropdown
    window.__boardHooks = {
      refreshProjectSelect: populateProjectSelect,
      activateProject,
      updateModelChip
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
