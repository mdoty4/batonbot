/* ═══════════════════════════════════════════
           Pipeline — Pipeline editor, prompt rows, drag-and-drop, orchestration
           ═══════════════════════════════════════════ */

        async function loadPipeline() {
            if (!activeProjectId) {
                document.getElementById('pipeline-editor').innerHTML = '<p style="color: #666; text-align: center;">Please activate a project first in the Projects tab.</p>';
                document.getElementById('orchestration-bar').style.display = 'none';
                return;
            }
            try {
                const response = await fetch(`/api/project/${activeProjectId}/tasks`);
                const data = await response.json();
                const tasks = data.tasks || [];
                const editor = document.getElementById('pipeline-editor');
                editor.innerHTML = '';

                // Show orchestration bar whenever a project is active, regardless of task count
                document.getElementById('orchestration-bar').style.display = 'flex';

                if (tasks.length === 0) {
                    editor.innerHTML = '<p style="color: #666; text-align: center;">No tasks yet. Add one below.</p>';
                    updateOrchestrationButton();
                    return;
                }

                tasks.forEach((task, index) => {
                    editor.appendChild(createPromptRow(task, index));
                });

                // Setup drag-and-drop on the editor container
                setupDragAndDrop();


                updateOrchestrationButton();
            } catch (e) {
                console.error('Error loading pipeline:', e);
            }
        }

         function createPromptRow(task, index) {
             const row = document.createElement('div');
             const stateClass = task.state || 'pending';
             row.className = `prompt-row ${task.orchestrate ? 'selected' : ''} ${stateClass}`;
             row.dataset.index = index;
             row.draggable = false; // We manage this manually during drag

             // Use task.agent directly — baton-code-thinking is a first-class agent
             const dropdownValue = task.agent || 'aider';
             const agentLabels = { 'baton-code': 'REAPER-CODE', 'baton-code-thinking': 'REAPER-CODE-THINKING', aider: 'AIDER', cline: 'CLINE', telegram: 'TELEGRAM' };
             const agentLabel = agentLabels[dropdownValue] || 'AIDER';

            row.innerHTML = `
                <div class="drag-handle" title="Drag to reorder">⠿</div>
                <span class="prompt-index">#${index + 1}</span>
                <div class="prompt-content">
                    <div class="prompt-text-display" data-prompt-index="${index}">${escapeHtml(task.prompt || '<em style="color:#aaa">Click to edit prompt...</em>')}</div>
                    <div class="prompt-meta">
                        <span class="status-indicator ${stateClass}">${{ pending: 'Pending', in_progress: 'Running', done: 'Done', failed: 'Ended', stopped: 'Ended' }[stateClass] || stateClass}</span>
                        <span class="agent-badge ${dropdownValue}">${agentLabel}</span>
                    </div>
                </div>
                <div class="prompt-actions">
                    <label class="toggle-switch" title="Include in orchestration">
                        <input type="checkbox" data-prompt-index="${index}" ${task.orchestrate ? 'checked' : ''} class="orchestrate-checkbox">
                        <span class="toggle-slider"></span>
                    </label>
                      <select class="agent-select ${dropdownValue}" data-prompt-index="${index}" title="Select agent for this task">
                          <option value="baton-code" ${dropdownValue === 'baton-code' ? 'selected' : ''}>Reaper Code</option>
                          <option value="baton-code-thinking" ${dropdownValue === 'baton-code-thinking' ? 'selected' : ''}>Reaper Code - Thinking</option>
                          <option value="aider" ${dropdownValue === 'aider' ? 'selected' : ''}>Aider</option>
                          <option value="cline" ${dropdownValue === 'cline' ? 'selected' : ''}>Cline</option>
                          <option value="telegram" ${dropdownValue === 'telegram' ? 'selected' : ''}>Telegram</option>
                      </select>
                    <button class="btn btn-init" data-prompt-index="${index}" title="Initialize git repository in project directory">⌘ Init</button>
                    <button class="btn btn-aider" data-prompt-index="${index}" title="Send this prompt to the selected agent immediately">▶ Send</button>
                    <button class="btn btn-danger" data-prompt-index="${index}" title="Remove prompt">-</button>
                </div>
            `;

            return row;
        }

        /* ── Inline Editing: Click to edit, blur/Enter to save ── */
        function startInlineEdit(index, displayEl) {
            // Don't enter edit mode if it contains the placeholder hint
            const currentPrompt = getTaskPromptFromRow(index);
            if (displayEl.classList.contains('editing')) return;

            const currentValue = currentPrompt || '';
            displayEl.classList.add('editing');

            // Replace with contenteditable div
            const editDiv = document.createElement('div');
            editDiv.className = 'prompt-text-edit';
            editDiv.contentEditable = 'true';
            editDiv.textContent = currentValue;

            // If empty, show placeholder hint
            if (!currentValue) {
                editDiv.placeholder = 'Enter prompt...';
                editDiv.style.color = '#aaa';
            }

            displayEl.replaceWith(editDiv);
            editDiv.focus();

            // Remove placeholder styling on first keystroke
            if (!currentValue) {
                editDiv.addEventListener('keydown', function removePlaceholderStyle() {
                    editDiv.style.color = '';
                    editDiv.removeEventListener('keydown', removePlaceholderStyle);
                }, { once: true });
            }

            // FIX: Track whether finishEdit has been called to prevent double-saves.
            // Without this, blur fires after Enter/finishEdit and causes a second save
            // that reads from a detached DOM node.
            let editFinished = false;

            function finishEdit() {
                if (editFinished) return; // Prevent double-save
                editFinished = true;

                const newValue = editDiv.textContent.trim();
                editDiv.contentEditable = 'false';

                // Replace back with display div
                const newDisplay = document.createElement('div');
                newDisplay.className = 'prompt-text-display';

                if (newValue) {
                    newDisplay.innerHTML = escapeHtml(newValue);
                    // Update the row's task data
                    updateTaskPrompt(index, newValue);
                } else {
                    newDisplay.innerHTML = '<em style="color:#aaa">Click to edit prompt...</em>';
                }

                // Clear any pending blur timeout to prevent double-save
                if (editDiv._blurTimeout) {
                    clearTimeout(editDiv._blurTimeout);
                    editDiv._blurTimeout = null;
                }

                editDiv.replaceWith(newDisplay);
                newDisplay.classList.remove('editing');
            }

            // Save on Enter (without Shift), cancel on Escape
            editDiv.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    finishEdit();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    // Clear any pending blur timeout
                    if (editDiv._blurTimeout) {
                        clearTimeout(editDiv._blurTimeout);
                        editDiv._blurTimeout = null;
                    }
                    // Restore original value
                    const restoreDisplay = document.createElement('div');
                    restoreDisplay.className = 'prompt-text-display';
                    if (currentValue) {
                        restoreDisplay.innerHTML = escapeHtml(currentValue);
                    } else {
                        restoreDisplay.innerHTML = '<em style="color:#aaa">Click to edit prompt...</em>';
                    }
                    editDiv.replaceWith(restoreDisplay);
                }
            });

            // Auto-save on blur with debounce
            editDiv.addEventListener('blur', function() {
                // FIX: If finishEdit was already called (e.g., via Enter key), skip blur save
                if (editFinished) return;

                // Clear any existing timeout to prevent race conditions
                if (editDiv._blurTimeout) {
                    clearTimeout(editDiv._blurTimeout);
                }

                editDiv._blurTimeout = setTimeout(() => {
                    // FIX: Read from the DOM element that exists at blur time,
                    // but since updateTaskPrompt now reads from server, this is safe.
                    const newValue = editDiv.textContent.trim();
                    updateTaskPrompt(index, newValue);
                }, 500);
            });
        }

        /* ── Throttled auto-save for prompt text changes ── */
        // Uses throttle (min 1s between saves) instead of debounce so typing progress is captured
        const autoSaveLastSaved = {}; // tracks last save timestamp per index
        const autoSaveTimeouts = {}; // tracks pending save timeouts per index

        async function updateTaskPrompt(index, value) {
            if (!activeProjectId) return;

            const now = Date.now();
            const lastSave = autoSaveLastSaved[index] || 0;
            const minInterval = 1000; // minimum 1 second between saves

            // Only save if enough time has passed since last save (throttle)
            if (now - lastSave < minInterval) {
                // Schedule a save after the interval, but don't clear previous pending saves
                // This ensures we save as soon as possible after the interval expires
                if (autoSaveTimeouts[index]) {
                    clearTimeout(autoSaveTimeouts[index]);
                }
                autoSaveTimeouts[index] = setTimeout(async () => {
                    // Re-check if we should still save (another keystroke may have come in)
                    const currentNow = Date.now();
                    if (currentNow - autoSaveLastSaved[index] >= minInterval) {
                        await performAutoSave(index, value);
                    }
                }, minInterval - (now - lastSave));
                return;
            }

            await performAutoSave(index, value);
        }

        async function performAutoSave(index, value) {
            if (!activeProjectId) return;

            try {
                // FIX: Read current tasks from SERVER (not DOM) to prevent lost-update races.
                // This ensures we have the latest state including any changes from other tabs/tabs.
                const response = await fetch(`/api/project/${activeProjectId}/tasks`);
                if (!response.ok) throw new Error('Failed to fetch current tasks');
                const data = await response.json();
                const tasks = (data.tasks || []).slice();

                // Apply the prompt change to the specific index
                if (index >= 0 && index < tasks.length) {
                    // Normalize empty/placeholder values to empty string
                    const normalizedValue = (value || '').trim();
                    tasks[index].prompt = normalizedValue;
                }

                const saveResponse = await fetch(`/api/project/${activeProjectId}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tasks })
                });

                if (saveResponse.ok) {
                    autoSaveLastSaved[index] = Date.now();
                    // Clear timeout reference
                    if (autoSaveTimeouts[index]) {
                        clearTimeout(autoSaveTimeouts[index]);
                        delete autoSaveTimeouts[index];
                    }
                } else {
                    console.error('Auto-save failed with status:', saveResponse.status);
                }
            } catch (e) {
                console.error('Auto-save failed:', e);
            }
        }

        /* ── Get prompt text from a row by index ── */
        function getTaskPromptFromRow(index) {
            const row = document.querySelector(`.prompt-row[data-index="${index}"]`);
            if (!row) return '';
            const displayEl = row.querySelector('.prompt-text-display');
            if (!displayEl) return '';
            const text = displayEl.textContent;
            // Return empty string if it's the placeholder hint
            if (text === 'Click to edit prompt...') return '';
            return text;
        }

        /* ═══════════════════════════════════════════
            Drag-and-Drop Reordering (HTML5 API)
            ═══════════════════════════════════════════ */

        let dragSrcIndex = null;
        let isDragging = false;

        function setupDragAndDrop() {
            const editor = document.getElementById('pipeline-editor');
            if (!editor) return;

            // Editor-level: handle dragover for drop target highlighting
            editor.addEventListener('dragover', function(e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                editor.classList.add('drag-over');
            });

            editor.addEventListener('dragleave', function(e) {
                // Only remove if actually leaving the editor
                if (!editor.contains(e.relatedTarget)) {
                    editor.classList.remove('drag-over');
                }
            });

            editor.addEventListener('drop', function(e) {
                e.preventDefault();
                editor.classList.remove('drag-over');

                if (dragSrcIndex === null || !isDragging) return;

                const rows = Array.from(editor.querySelectorAll('.prompt-row'));
                const targetRow = e.target.closest('.prompt-row');

                if (!targetRow) return;

                const targetIndex = parseInt(targetRow.dataset.index, 10);
                if (isNaN(targetIndex) || targetIndex === dragSrcIndex) {
                    dragSrcIndex = null;
                    isDragging = false;
                    return;
                }

                // Get current tasks from server for a clean reorder
                fetch(`/api/project/${activeProjectId}/tasks`)
                    .then(r => r.json())
                    .then(data => {
                        const tasks = (data.tasks || []).slice();
                        // Remove from source position
                        const [movedTask] = tasks.splice(dragSrcIndex, 1);
                        // Insert at target position
                        tasks.splice(targetIndex, 0, movedTask);

                        // Reassign IDs after reorder
                        tasks.forEach((t, i) => { t.id = i; });

                        // Save reordered array
                        return fetch(`/api/project/${activeProjectId}/tasks`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ tasks })
                        });
                    })
                    .then(r => {
                        if (r.ok) loadPipeline(); // Re-render with new order
                    })
                    .catch(e => console.error('Drag-drop save failed:', e));

                dragSrcIndex = null;
                isDragging = false;
            });

            // Attach drag handlers to each row's drag handle
            editor.querySelectorAll('.drag-handle').forEach(handle => {
                attachDragHandlers(handle);
            });

            // Observe for new rows being added
            const observer = new MutationObserver((mutations) => {
                mutations.forEach(mutation => {
                    mutation.addedNodes.forEach(node => {
                        if (node.classList && node.classList.contains('prompt-row')) {
                            const handle = node.querySelector('.drag-handle');
                            if (handle) attachDragHandlers(handle);
                        }
                    });
                });
            });
            observer.observe(editor, { childList: true });
        }

        function attachDragHandlers(handle) {
            handle.addEventListener('mousedown', function(e) {
                // Only left click
                if (e.button !== 0) return;
                e.preventDefault();

                const row = handle.closest('.prompt-row');
                if (!row) return;

                dragSrcIndex = parseInt(row.dataset.index, 10);
                isDragging = true;

                // Start drag after a short delay (to distinguish from click)
                const dragStart = Date.now();
                const checkDrag = () => {
                    if (!isDragging) return;
                    if (Date.now() - dragStart > 150) {
                        // Actually start the native drag
                        row.classList.add('dragging');
                        const editor = document.getElementById('pipeline-editor');
                        if (editor) editor.classList.add('drag-over');

                        try {
                            const dragData = JSON.stringify({ rowIndex: dragSrcIndex });
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', dragData);
                            // Set a transparent drag image for cleaner visual
                            const img = new Image();
                            img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                            e.dataTransfer.setDragImage(img, 0, 0);
                            // Small delay to let the drag start properly
                            requestAnimationFrame(() => {
                                row.draggable = true;
                                // Force a reflow to ensure drag starts
                                row.offsetHeight;
                            });
                        } catch (err) {
                            console.warn('Drag image setup failed:', err);
                        }
                    }
                };
                requestAnimationFrame(checkDrag);
            });

            handle.addEventListener('mouseup', function() {
                isDragging = false;
            });

            // Handle dragover on rows for drop position feedback
            const editor = document.getElementById('pipeline-editor');
            if (editor) {
                editor.addEventListener('dragover', function(e) {
                    if (!isDragging || dragSrcIndex === null) return;
                    e.preventDefault();

                    const rows = Array.from(editor.querySelectorAll('.prompt-row'));
                    const targetRow = e.target.closest('.prompt-row');

                    // Clear all highlight classes
                    rows.forEach(r => {
                        r.classList.remove('drag-over-top', 'drag-over-bottom');
                    });

                    if (targetRow && targetRow !== rows[dragSrcIndex]) {
                        const rect = targetRow.getBoundingClientRect();
                        const midY = rect.top + (rect.height / 2);

                        if (e.clientY < midY) {
                            targetRow.classList.add('drag-over-top');
                        } else {
                            targetRow.classList.add('drag-over-bottom');
                        }
                    }
                });

                editor.addEventListener('dragend', function() {
                    rows.forEach(r => {
                        r.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
                        r.draggable = false;
                    });
                    editor.classList.remove('drag-over');
                });
            }
        }

        /* ── Event Listeners for Pipeline Editor (delegation on #pipeline-editor) ── */
        function bindPipelineEventListeners() {
            // Add prompt row button (outside editor)
            const addPromptBtn = document.getElementById('btn-add-prompt');
            if (addPromptBtn) {
                addPromptBtn.addEventListener('click', addPromptRow);
            }

            // Reset project button (outside editor)
            const resetProjectBtn = document.getElementById('btn-reset-project');
            if (resetProjectBtn) {
                resetProjectBtn.addEventListener('click', resetProject);
            }

            // Reset tasks button (orchestration bar)
            const resetTasksBtn = document.getElementById('btn-reset-tasks');
            if (resetTasksBtn) {
                resetTasksBtn.addEventListener('click', resetTasks);
            }

            // Start orchestration button (orchestration bar)
            const startOrchestrationBtn = document.getElementById('btn-start-orchestration');
            if (startOrchestrationBtn) {
                startOrchestrationBtn.addEventListener('click', startOrchestration);
            }

            // Stop sequence button (orchestration bar)
            const stopSequenceBtn = document.getElementById('btn-stop-sequence');
            if (stopSequenceBtn) {
                stopSequenceBtn.addEventListener('click', stopSequence);
            }

            // Save sequence button (global action bar)
            const saveBtn = document.getElementById('btn-save');
            if (saveBtn) {
                saveBtn.addEventListener('click', saveSequence);
            }

            // Assign All Agents dropdown (orchestration bar)
            const assignAllSelect = document.getElementById('assign-all-agents');
            if (assignAllSelect) {
                assignAllSelect.addEventListener('change', function() {
                    const value = this.value;
                    if (value) {
                        changeAgentAll(value);
                    }
                    // Reset dropdown to placeholder after selection
                    this.value = '';
                });
            }

            // Pipeline editor delegation: handle all row-level interactions
            const editor = document.getElementById('pipeline-editor');
            if (editor) {
                editor.addEventListener('click', function(e) {
                    // Find the closest prompt-row
                    const row = e.target.closest('.prompt-row');
                    if (!row) return;

                    const index = parseInt(row.dataset.index, 10);
                    if (isNaN(index)) return;

                    // Check for remove button click
                    if (e.target.closest('.btn-danger')) {
                        e.stopPropagation();
                        removePromptRow(e.target);
                        return;
                    }

                    // Check for init git button click
                    if (e.target.closest('.btn-init')) {
                        e.stopPropagation();
                        initGit(e.target);
                        return;
                    }

                    // Check for send to agent button click
                    if (e.target.closest('.btn-aider')) {
                        e.stopPropagation();
                        sendToAgent(e.target);
                        return;
                    }

                    // Check for prompt-text-display click (start inline edit)
                    const displayEl = e.target.closest('.prompt-text-display');
                    if (displayEl) {
                        startInlineEdit(index, displayEl);
                        return;
                    }
                });

                // Handle checkbox change (orchestrate toggle) via delegation
                editor.addEventListener('change', function(e) {
                    const checkbox = e.target.closest('.orchestrate-checkbox');
                    if (checkbox) {
                        const index = parseInt(checkbox.dataset.promptIndex, 10);
                        if (!isNaN(index)) {
                            toggleOrchestrate(index, checkbox.checked);
                        }
                        return;
                    }

                    // Handle agent select change via delegation
                    const agentSelect = e.target.closest('.agent-select');
                    if (agentSelect) {
                        const index = parseInt(agentSelect.dataset.promptIndex, 10);
                        if (!isNaN(index)) {
                            changeAgent(index, agentSelect.value, agentSelect);
                        }
                    }
                });
            }
        }

        // Bind listeners once DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', bindPipelineEventListeners);
        } else {
            bindPipelineEventListeners();
        }

	/* ── Flush all pending throttle timeouts so they execute immediately ── */
	async function flushPendingSaves() {
		const pendingIndices = Object.keys(autoSaveTimeouts);
		if (pendingIndices.length === 0) return;

		// Clear all pending timeouts to prevent them from firing later
		for (const index of pendingIndices) {
			if (autoSaveTimeouts[index]) {
				clearTimeout(autoSaveTimeouts[index]);
				delete autoSaveTimeouts[index];
			}
		}

		// Now we need to re-read the current values from the DOM and save them
		for (const indexStr of pendingIndices) {
			const index = parseInt(indexStr, 10);
			if (isNaN(index)) continue;

			// Read the prompt from the display element (since editing is done)
			const row = document.querySelector(`.prompt-row[data-index="${index}"]`);
			if (!row) continue;

			const displayEl = row.querySelector('.prompt-text-display');
			if (displayEl) {
				const text = displayEl.textContent.trim();
				if (text && text !== 'Click to edit prompt...') {
					await performAutoSave(index, text);
				}
			}
		}
	}

	/* ── Save all pending edits before page unload (tab close, navigation, refresh) ── */
	async function saveAllPendingEdits() {
		// Step 1: Flush any pending throttle timeouts so recently-blurred editors save
		await flushPendingSaves();

		// Step 2: Save any currently active inline editors
		const editDivs = document.querySelectorAll('.prompt-text-edit');
		let hasEdits = false;

		for (const editDiv of editDivs) {
			const row = editDiv.closest('.prompt-row');
			if (!row) continue;

			const index = parseInt(row.dataset.index, 10);
			if (isNaN(index)) continue;

			const currentValue = editDiv.textContent.trim();
			if (!currentValue || currentValue === 'Enter prompt...') continue;

			hasEdits = true;
			// Force immediate save without throttle delay
			await performAutoSave(index, currentValue);
		}

		// If there were edits, prevent the default close/navigation behavior
		// (Note: browsers don't guarantee showing the confirmation dialog anymore,
		// but setting returnValue is still required for best compatibility)
		if (hasEdits) {
			// The browser will show a confirmation dialog because we set returnValue below
		}
	}

        // Register beforeunload handler
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', function(e) {
                // Check if any edit div has content
                const editDivs = document.querySelectorAll('.prompt-text-edit');
                for (const editDiv of editDivs) {
                    const text = editDiv.textContent.trim();
                    if (text && text !== 'Enter prompt...') {
                        // Set returnValue for older browsers
                        e.preventDefault();
                        e.returnValue = '';
                        // Break after finding first unsaved edit (we just need to trigger the dialog once)
                        break;
                    }
                }
            });

            // Also save on tab visibility change (user switches to another tab)
            document.addEventListener('visibilitychange', function() {
                if (document.visibilityState === 'hidden') {
                    // Page is being hidden - save all pending edits
                    saveAllPendingEdits();
                } else if (document.visibilityState === 'visible') {
                    // Page became visible again - sync pipeline states from server
                    // This ensures prompt status indicators are current after the user
                    // switches browser tabs or returns from another application
                    refreshPipelineStates();
                }
            });
        }

        /* ── Auto-save on tab switch (Projects ↔ Pipeline ↔ Logs & Settings) ── */
        function setupTabSwitchAutoSave() {
            const tabButtons = document.querySelectorAll('.tab-btn');
            tabButtons.forEach(btn => {
                btn.addEventListener('click', async function() {
                    // Small delay to allow the tab content switch to complete, then save
                    await saveAllPendingEdits();
                });
            });
        }

        // Setup tab switch auto-save once DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setupTabSwitchAutoSave);
        } else {
            setupTabSwitchAutoSave();
        }

        async function addPromptRow() {
            if (!activeProjectId) {
                alert('Please activate a project first');
                return;
            }

            // Get current tasks from the server to get proper task IDs
            try {
                const response = await fetch(`/api/project/${activeProjectId}/tasks`);
                const data = await response.json();
                const tasks = data.tasks || [];

                // Create a new task with an empty prompt and default agent
                const newTask = {
                    id: tasks.length,
                    prompt: '',
                    state: 'pending',
                    orchestrate: false,
                    agent: 'aider'
                };

                // Save to server
                const saveResponse = await fetch(`/api/project/${activeProjectId}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tasks: [...tasks, newTask] })
                });

                if (saveResponse.ok) {
                    const editor = document.getElementById('pipeline-editor');
                    // Clear the "no tasks" message if present
                    const msg = editor.querySelector('p[style]');
                    if (msg) msg.remove();

                    const row = createPromptRow(newTask, tasks.length);
                    editor.appendChild(row);
                    updateOrchestrationButton();
                } else {
                    alert('Error adding new prompt');
                }
            } catch (e) {
                console.error('Error adding prompt:', e);
                alert('Error adding new prompt');
            }
        }

        async function removePromptRow(btn) {
            if (!activeProjectId) return;

            const row = btn.closest('.prompt-row');
            const index = parseInt(row.dataset.index, 10);

            // Get current tasks from server to get a clean delete
            try {
                const response = await fetch(`/api/project/${activeProjectId}/tasks`);
                if (!response.ok) throw new Error('Failed to fetch current tasks');
                const data = await response.json();
                const tasks = (data.tasks || []).slice();

                // Remove the task at the index
                tasks.splice(index, 1);

                // Reassign IDs after delete so the array is contiguous
                tasks.forEach((t, i) => { t.id = i; });

                // Save updated array to server
                const saveResponse = await fetch(`/api/project/${activeProjectId}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tasks })
                });

                if (saveResponse.ok) {
                    row.remove();
                    reindexRows();
                    updateOrchestrationButton();
                } else {
                    console.error('Failed to delete prompt');
                    alert('Error deleting prompt');
                }
            } catch (e) {
                console.error('Error deleting prompt:', e);
                alert('Error deleting prompt');
            }
        }

        function reindexRows() {
            const rows = document.querySelectorAll('#pipeline-editor .prompt-row');
            // Update index labels
            rows.forEach((row, i) => {
                row.querySelector('.prompt-index').textContent = `#${i + 1}`;
            });
        }

        async function toggleOrchestrate(index, checked) {
            if (!activeProjectId) return;

            // Update the DOM immediately for responsive UI
            const row = document.querySelector(`.prompt-row[data-index="${index}"]`);
            if (row) {
                row.classList.toggle('selected', checked);
            }
            updateOrchestrationButton();

            // Save the toggle state to server
            try {
                const response = await fetch(`/api/project/${activeProjectId}/tasks`);
                if (!response.ok) throw new Error('Failed to fetch current tasks');
                const data = await response.json();
                const tasks = (data.tasks || []).slice();

                // Update the orchestrate field for this specific task
                if (index >= 0 && index < tasks.length) {
                    tasks[index].orchestrate = checked;
                }

                const saveResponse = await fetch(`/api/project/${activeProjectId}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tasks })
                });

                if (!saveResponse.ok) {
                    console.error('Failed to save orchestration toggle');
                    // Revert the UI if save failed
                    if (row) {
                        row.classList.toggle('selected', !checked);
                    }
                    updateOrchestrationButton();
                }
            } catch (e) {
                console.error('Error saving orchestration toggle:', e);
            }
        }

        /* ── Assign agent to ALL tasks at once ── */
        async function changeAgentAll(value) {
            if (!activeProjectId) return;
            if (!value) return; // skip placeholder

            try {
                const response = await fetch(`/api/project/${activeProjectId}/tasks`);
                if (!response.ok) throw new Error('Failed to fetch current tasks');
                const data = await response.json();
                const tasks = (data.tasks || []).slice();

                // Update agent for every task
                tasks.forEach(t => { t.agent = value; });

                const saveResponse = await fetch(`/api/project/${activeProjectId}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tasks })
                });

                if (saveResponse.ok) {
                    await loadPipeline(); // re-render with updated agents
                } else {
                    console.error('Failed to save bulk agent change');
                    alert('Error updating agents');
                }
            } catch (e) {
                console.error('Error updating agents:', e);
                alert('Error updating agents');
            }
        }

        /* ── Update agent badge + select when changed ── */
        async function changeAgent(index, value, selectEl) {
            const row = document.querySelector(`.prompt-row[data-index="${index}"]`);
            if (!row) return;
            // Update the badge
            const badge = row.querySelector('.agent-badge');
            if (badge) {
                badge.className = 'agent-badge ' + value;
                const labels = { 'baton-code': 'REAPER-CODE', 'baton-code-thinking': 'REAPER-CODE-THINKING', aider: 'AIDER', cline: 'CLINE', telegram: 'TELEGRAM' };
                badge.textContent = labels[value] || 'AIDER';
            }
            // Update the select visual
            selectEl.className = 'agent-select ' + value;
            updateOrchestrationButton();

            // Save the agent change to server
            if (!activeProjectId) return;
            try {
                const response = await fetch(`/api/project/${activeProjectId}/tasks`);
                if (!response.ok) throw new Error('Failed to fetch current tasks');
                const data = await response.json();
                const tasks = (data.tasks || []).slice();

                // Update the agent field for this specific task
                if (index >= 0 && index < tasks.length) {
                    tasks[index].agent = value;
                }

                const saveResponse = await fetch(`/api/project/${activeProjectId}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tasks })
                });

                if (!saveResponse.ok) {
                    console.error('Failed to save agent change');
                    // Revert the UI if save failed
                    if (badge) {
                        const labels = { 'baton-code': 'REAPER-CODE', aider: 'AIDER', cline: 'CLINE', telegram: 'TELEGRAM' };
                        badge.className = 'agent-badge aider';
                        badge.textContent = 'AIDER';
                    }
                    selectEl.className = 'agent-select aider';
                }
            } catch (e) {
                console.error('Error saving agent change:', e);
            }
        }

        function updateOrchestrationButton() {
            const btn = document.getElementById('btn-start-orchestration');
            if (!btn) return;
            const checkedCount = document.querySelectorAll('#pipeline-editor .prompt-row.selected').length;
            btn.disabled = checkedCount === 0;
        }

        async function initGit(btn) {
            if (!activeProjectId) {
                alert('Please activate a project first');
                return;
            }

            const row = btn.closest('.prompt-row');
            const index = Array.from(row.parentElement.children).indexOf(row);

            // Set sending state
            btn.classList.add('sending');
            btn.textContent = '⏳';
            btn.disabled = true;

            try {
                const response = await fetch(`/api/project/${activeProjectId}/tasks/${index}/init`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });

                const result = await response.json();

                if (result.success) {
                    btn.classList.remove('sending');
                    btn.classList.add('done');
                    btn.textContent = '✓';
                    btn.title = `Git initialized: ${result.directory}`;
                } else {
                    throw new Error(result.error || 'Unknown error');
                }
            } catch (error) {
                btn.classList.remove('sending');
                btn.classList.add('failed');
                btn.textContent = '✗';
                btn.title = `Init failed: ${error.message}`;
                console.error('Git init error:', error);
            }

            // Reset button after 3 seconds
            setTimeout(() => {
                btn.classList.remove('sending', 'done', 'failed');
                btn.textContent = '⌘ Init';
                btn.disabled = false;
            }, 3000);
        }

        async function sendToAgent(btn) {
            if (!activeProjectId) {
                alert('Please activate a project first');
                return;
            }
            
            const row = btn.closest('.prompt-row');
            const displayEl = row.querySelector('.prompt-text-display');
            const agentSelect = row.querySelector('.agent-select');
            const index = Array.from(row.parentElement.children).indexOf(row);
            const promptText = displayEl ? displayEl.textContent.trim() : '';
            const rawAgent = agentSelect ? agentSelect.value : 'aider';
            const agent = rawAgent;
            
            if (!promptText) {
                alert('Please enter a prompt first');
                return;
            }
            
            // Set sending state
            btn.classList.add('sending');
            btn.textContent = '⏳';
            btn.disabled = true;
            
            try {
                const response = await fetch(`/api/project/${activeProjectId}/tasks/${index}/send`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: promptText, agent: agent })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    btn.classList.remove('sending');
                    btn.classList.add('done');
                    btn.textContent = '✓';
                    btn.title = `${agent.charAt(0).toUpperCase() + agent.slice(1)} completed successfully`;
                } else {
                    throw new Error(result.error || 'Unknown error');
                }
            } catch (error) {
                btn.classList.remove('sending');
                btn.classList.add('failed');
                btn.textContent = '✗';
                btn.title = `${agent.charAt(0).toUpperCase() + agent.slice(1)} failed: ${error.message}`;
                console.error(`${agent} error:`, error);
            }
        }

        async function saveSequence() {
            if (!activeProjectId) return alert('Please activate a project first');
            const rows = document.querySelectorAll('#pipeline-editor .prompt-row');
            const tasks = Array.from(rows).map((row, index) => {
                // Check for active edit div first (if user is mid-edit), then display div
                const editDiv = row.querySelector('.prompt-text-edit');
                const displayEl = row.querySelector('.prompt-text-display');
                const promptText = editDiv ? editDiv.textContent.trim() : (displayEl ? displayEl.textContent.trim() : '');
                // Treat placeholder text as empty prompt
                const finalPrompt = (promptText === 'Click to edit prompt...' || promptText === 'Enter prompt...') ? '' : promptText;
                const checkbox = row.querySelector('.toggle-switch input');
                const agentSelect = row.querySelector('.agent-select');
                return {
                    id: index,
                    prompt: finalPrompt,
                    state: row.dataset.state || 'pending',
                    orchestrate: checkbox ? checkbox.checked : false,
                    agent: agentSelect ? agentSelect.value : 'aider'
                };
            });

            try {
                const response = await fetch(`/api/project/${activeProjectId}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tasks })
                });
                if (response.ok) {
                    alert('Sequence saved successfully!');
                    await loadPipeline();
                } else {
                    alert('Error saving sequence');
                }
            } catch (e) {
                alert('Error saving sequence');
            }
        }

        async function startOrchestration() {
            if (!activeProjectId) return alert('Please activate a project first');

            const rows = document.querySelectorAll('#pipeline-editor .prompt-row.selected');
            if (rows.length === 0) return alert('No tasks selected for orchestration');

            // Collect indices of selected tasks (in order)
            const taskIndices = [];
            rows.forEach(row => {
                const idx = parseInt(row.dataset.index, 10);
                taskIndices.push(idx);
            });

            const btn = document.getElementById('btn-start-orchestration');
            const stopBtn = document.getElementById('btn-stop-sequence');
            const statusEl = document.getElementById('orchestration-status');

            // Set loading state
            btn.disabled = true;
            btn.textContent = '⟳ Running...';
            stopBtn.disabled = false;
            statusEl.innerHTML = '<div class="spinner"></div> Sequence in progress...';

            try {
                const response = await fetch(`/api/project/${activeProjectId}/tasks/orchestrate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ taskIndices })
                });

                const result = await response.json();

                if (result.success) {
                    // Pass the exact task indices to the polling function so it updates
                    // the correct rows regardless of checkbox (.selected) state.
                    pollOrchestrationStatus(taskIndices);
                } else {
                    throw new Error(result.error || 'Unknown error');
                }
            } catch (error) {
                btn.disabled = false;
                btn.textContent = '▶ Start Sequence';
                stopBtn.disabled = true;
                statusEl.innerHTML = `<span style="color: #ff6b6b;">Error: ${error.message}</span>`;
                console.error('Orchestration error:', error);
            }
        }

        async function stopSequence() {
            if (!activeProjectId) return;
            if (document.getElementById('btn-stop-sequence').disabled) return;

            const btn = document.getElementById('btn-start-orchestration');
            const stopBtn = document.getElementById('btn-stop-sequence');
            const statusEl = document.getElementById('orchestration-status');

            // Disable stop button immediately to prevent double-clicks
            stopBtn.disabled = true;
            statusEl.innerHTML = '<div class="spinner"></div> Stopping sequence...';

            try {
                const response = await fetch(`/api/project/${activeProjectId}/tasks/cancel`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });

                const result = await response.json();

                // Reset UI regardless of response
                btn.disabled = false;
                btn.textContent = '▶ Start Sequence';
                stopBtn.disabled = true;

                if (result.success) {
                    statusEl.innerHTML = '<span style="color: #f39c12;">⏹ Sequence stopped</span>';
                    // Reload pipeline to reflect updated task states
                    await loadPipeline();
                } else {
                    statusEl.innerHTML = `<span style="color: #ff6b6b;">Stop failed: ${result.error || 'Unknown error'}</span>`;
                }
            } catch (error) {
                btn.disabled = false;
                btn.textContent = '▶ Start Sequence';
                stopBtn.disabled = true;
                statusEl.innerHTML = `<span style="color: #ff6b6b;">Stop error: ${error.message}</span>`;
                console.error('Stop sequence error:', error);
            }
        }

        // Track whether orchestration polling is currently active
        let isPolling = false;

        /* ── Refresh pipeline states from server (lightweight sync, no full re-render) ── */
        async function refreshPipelineStates() {
            if (!activeProjectId) return;

            try {
                const response = await fetch(`/api/project/${activeProjectId}/tasks`);
                if (!response.ok) return;
                const data = await response.json();
                const tasks = data.tasks || [];

                const stateLabels = { pending: 'Pending', in_progress: 'Running', done: 'Done', failed: 'Ended', stopped: 'Ended' };

                tasks.forEach((task, index) => {
                    const row = document.querySelector(`#pipeline-editor .prompt-row[data-index="${index}"]`);
                    if (!row) return;

                    const stateClass = task.state === 'in_progress' ? 'in-progress' : (task.state || 'pending');

                    // Only update if state actually changed (compare current row class)
                    const expectedClass = `prompt-row ${task.orchestrate ? 'selected' : ''} ${stateClass}`;
                    if (row.className !== expectedClass) {
                        row.className = expectedClass;
                    }

                    // Update the status indicator
                    const indicator = row.querySelector('.status-indicator');
                    if (indicator) {
                        const currentLabel = indicator.textContent;
                        const newLabel = stateLabels[task.state] || task.state;
                        if (currentLabel !== newLabel) {
                            indicator.className = `status-indicator ${task.state || 'pending'}`;
                            indicator.textContent = newLabel;
                        }
                    }
                });

                // If polling is active, also update the orchestration status bar
                if (isPolling) {
                    const statusEl = document.getElementById('orchestration-status');
                    if (statusEl) {
                        const pendingCount = tasks.filter(t => t.state === 'pending').length;
                        const runningCount = tasks.filter(t => t.state === 'in_progress').length;
                        const doneCount = tasks.filter(t => t.state === 'done').length;
                        const failedCount = tasks.filter(t => t.state === 'failed').length;

                        let statusParts = [];
                        if (runningCount > 0) statusParts.push(`<span style="color: #3498db;">⚡ ${runningCount} running</span>`);
                        if (pendingCount > 0) statusParts.push(`<span style="color: #95a5a6;">⏳ ${pendingCount} pending</span>`);
                        if (doneCount > 0) statusParts.push(`<span style="color: #27ae60;">✓ ${doneCount} done</span>`);
                        if (failedCount > 0) statusParts.push(`<span style="color: #e74c3c;">✗ ${failedCount} ended</span>`);

                        statusEl.innerHTML = statusParts.length > 0 ? statusParts.join(' &nbsp;·&nbsp; ') : '<div class="spinner"></div> Starting...';
                    }
                }
            } catch (e) {
                console.error('Error refreshing pipeline states:', e);
            }
        }

        async function pollOrchestrationStatus(orchestrationIndices) {
            const statusEl = document.getElementById('orchestration-status');

            // Mark polling as active
            isPolling = true;

            // Use the exact indices passed from orchestrate() instead of relying on
            // the .selected CSS class which can drift if checkboxes are toggled mid-run.
            const indicesToTrack = orchestrationIndices || [];

            // Fallback: if no indices were passed (shouldn't happen), scan for .selected rows
            const getIndicesToTrack = () => {
                if (indicesToTrack.length > 0) return indicesToTrack;
                const selectedRows = document.querySelectorAll('#pipeline-editor .prompt-row.selected');
                return Array.from(selectedRows).map(r => parseInt(r.dataset.index, 10));
            };

            const poll = async () => {
                try {
                    const response = await fetch(`/api/project/${activeProjectId}/tasks`);
                    const data = await response.json();
                    const tasks = data.tasks || [];

                    // Update rows for the tasks that were part of this orchestration run
                    const indices = getIndicesToTrack();
                    let allDone = true;

                    indices.forEach(idx => {
                        const row = document.querySelector(`#pipeline-editor .prompt-row[data-index="${idx}"]`);
                        const task = tasks[idx];
                        if (row && task) {
                            // Update row class for ANY state change (including in_progress)
                            const stateClass = task.state === 'in_progress' ? 'in-progress' : (task.state || 'pending');
                            row.className = `prompt-row ${task.orchestrate ? 'selected' : ''} ${stateClass}`;

                            // Update the status indicator text and class in real-time
                            const indicator = row.querySelector('.status-indicator');
                            if (indicator) {
                                const stateLabels = { pending: 'Pending', in_progress: 'Running', done: 'Done', failed: 'Ended', stopped: 'Ended' };
                                indicator.className = `status-indicator ${task.state || 'pending'}`;
                                // Update the visible text label (CSS ::before handles the icon)
                                indicator.textContent = stateLabels[task.state] || task.state;
                            }
                        }

                        // A task is considered "done" only if it reached done or failed state
                        if (task && (task.state === 'done' || task.state === 'failed')) {
                            // already done/failed, continue
                        } else {
                            allDone = false;
                        }
                    });

                    // Calculate live counts for real-time status display
                    const pendingCount = tasks.filter(t => t.state === 'pending').length;
                    const runningCount = tasks.filter(t => t.state === 'in_progress').length;
                    const doneCount = tasks.filter(t => t.state === 'done').length;
                    const failedCount = tasks.filter(t => t.state === 'failed').length;

                    if (!allDone) {
                        // Show real-time progress: running, pending, done, failed counts
                        let statusParts = [];
                        if (runningCount > 0) statusParts.push(`<span style="color: #3498db;">⚡ ${runningCount} running</span>`);
                        if (pendingCount > 0) statusParts.push(`<span style="color: #95a5a6;">⏳ ${pendingCount} pending</span>`);
                        if (doneCount > 0) statusParts.push(`<span style="color: #27ae60;">✓ ${doneCount} done</span>`);
                        if (failedCount > 0) statusParts.push(`<span style="color: #e74c3c;">✗ ${failedCount} ended</span>`);

                        statusEl.innerHTML = statusParts.length > 0 ? statusParts.join(' &nbsp;·&nbsp; ') : '<div class="spinner"></div> Starting...';
                        setTimeout(poll, 500);
                    } else {
                        // All tasks complete — show final summary and mark polling as inactive
                        isPolling = false;
                        statusEl.innerHTML = `<span style="color: #a8e6cf;">✓ Complete: ${doneCount} succeeded, ${failedCount} ended</span>`;
                        document.getElementById('btn-start-orchestration').disabled = false;
                        document.getElementById('btn-start-orchestration').textContent = '▶ Start Sequence';
                        document.getElementById('btn-stop-sequence').disabled = true;
                    }
                } catch (e) {
                    setTimeout(poll, 500);
                }
            };

            poll();
        }

        async function resetTasks() {
            if (!activeProjectId) return;
            if (!confirm('Reset all task states to pending?')) return;

            try {
                const response = await fetch(`/api/project/${activeProjectId}/tasks/reset`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });

                if (response.ok) {
                    document.getElementById('orchestration-status').innerHTML = '';
                    await loadPipeline();
                } else {
                    alert('Error resetting tasks');
                }
            } catch (e) {
                alert('Error resetting tasks');
            }
        }