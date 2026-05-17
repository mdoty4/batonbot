/* ═══════════════════════════════════════════
       Project Editor — Drawer open/close, load, save
       ═══════════════════════════════════════════ */

    /* ── Project Editor Drawer: Open/Close ── */
    function openProjectEditor() {
        document.getElementById('project-editor-drawer').classList.add('open');
        document.getElementById('project-editor-backdrop').classList.add('active');
    }

    function closeProjectEditor() {
        document.getElementById('project-editor-drawer').classList.remove('open');
        document.getElementById('project-editor-backdrop').classList.remove('active');
    }

    /* ── Save Project Editor Changes ── */
    async function saveProjectEditor() {
        const projectId = document.getElementById('editor-project-id').value;
        if (!projectId) {
            alert('No project selected');
            return;
        }

        const name = document.getElementById('editor-project-name').value.trim();
        if (!name) {
            alert('Project name is required');
            return;
        }

        const workingDirectory = document.getElementById('editor-project-workingDir').value.trim() || null;
        const defaultAgent = document.getElementById('editor-project-defaultAgent').value;

        // API override fields — only include non-empty values
        const provider = document.getElementById('editor-provider').value.trim();
        const apiBase = document.getElementById('editor-apiBase').value.trim();
        const apiKey = document.getElementById('editor-apiKey').value.trim();
        const model = document.getElementById('editor-model').value.trim();

        // Build aiderConfig — only include fields that have values
        const aiderConfig = {};
        if (provider) aiderConfig.provider = provider;
        if (apiBase) aiderConfig.apiBase = apiBase;
        if (apiKey) aiderConfig.apiKey = apiKey;
        if (model) aiderConfig.model = model;

        try {
            const response = await fetch(`/api/projects/${projectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    workingDirectory,
                    defaultAgent,
                    aiderConfig
                })
            });

            if (response.ok) {
                closeProjectEditor();
                // Reload projects list
                await loadProjects();
                alert('Project updated successfully!');
            } else {
                const errorData = await response.json().catch(() => ({}));
                alert('Error updating project: ' + (errorData.error || 'Unknown error'));
            }
        } catch (e) {
            console.error('Error saving project:', e);
            alert('Error updating project');
        }
    }

    /* ── Event Listeners for Project Editor ── */
    function bindProjectEditorEventListeners() {
        // Close button (X in header)
        const closeBtn = document.getElementById('btn-close-project-editor');
        if (closeBtn) {
            closeBtn.addEventListener('click', closeProjectEditor);
        }

        // Cancel button
        const cancelBtn = document.getElementById('btn-cancel-project-editor');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', closeProjectEditor);
        }

        // Backdrop click closes drawer
        const backdrop = document.getElementById('project-editor-backdrop');
        if (backdrop) {
            backdrop.addEventListener('click', closeProjectEditor);
        }

        // Save button
        const saveBtn = document.getElementById('btn-save-project-editor');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveProjectEditor);
        }

        // Provider change handler — auto-populate API Base and Model
        const providerSelect = document.getElementById('editor-provider');
        if (providerSelect) {
            providerSelect.addEventListener('change', function() {
                onProviderChange(this.value, 'editor');
            });
        }
    }

    // Bind listeners once DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindProjectEditorEventListeners);
    } else {
        bindProjectEditorEventListeners();
    }