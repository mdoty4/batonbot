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

        // ── Jira channel config (v3.4) ──
        const jiraConfig = collectJiraConfigFromForm();

        try {
            const response = await fetch(`/api/projects/${projectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    workingDirectory,
                    defaultAgent,
                    aiderConfig,
                    jiraConfig
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

    /* ── Jira channel helpers (v3.4) ── */
    function collectJiraConfigFromForm() {
        const enabled = document.getElementById('editor-jira-enabled')?.checked || false;
        const baseUrl = document.getElementById('editor-jira-baseUrl')?.value.trim() || '';
        const email = document.getElementById('editor-jira-email')?.value.trim() || '';
        const apiToken = document.getElementById('editor-jira-apiToken')?.value.trim() || '';
        const jql = document.getElementById('editor-jira-jql')?.value.trim() || '';
        const pollIntervalSec = parseInt(document.getElementById('editor-jira-pollInterval')?.value, 10) || 60;
        const defaultAgent = document.getElementById('editor-jira-defaultAgent')?.value || 'cline';

        // ── v3.4 "Trust Hardening" fields ──
        // onlyUnassigned defaults to CHECKED (safe): only unassigned tickets
        // (or ones assigned to the bot account) are imported.
        const onlyUnassigned = document.getElementById('editor-jira-onlyUnassigned')?.checked ?? true;
        const botAccountEmail = document.getElementById('editor-jira-botEmail')?.value.trim() || '';
        const maxAutostartPerPoll = parseInt(document.getElementById('editor-jira-maxAutostart')?.value, 10);
        // v3.4.1: auto-transition the Jira ticket to Done on task success (default ON)
        const transitionOnDone = document.getElementById('editor-jira-transitionOnDone')?.checked ?? true;

        // If nothing is configured at all, keep the config empty (don't persist noise)
        if (!enabled && !baseUrl && !email && !apiToken && !jql) return {};

        return {
            enabled, baseUrl, email, apiToken, jql, pollIntervalSec, defaultAgent,
            onlyUnassigned,
            botAccountEmail,
            maxAutostartPerPoll: Number.isFinite(maxAutostartPerPoll) ? maxAutostartPerPoll : 3,
            transitionOnDone
        };
    }

    function populateJiraFields(jiraConfig) {
        const cfg = jiraConfig || {};
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        const enabledEl = document.getElementById('editor-jira-enabled');
        if (enabledEl) enabledEl.checked = cfg.enabled === true;
        set('editor-jira-baseUrl', cfg.baseUrl || '');
        set('editor-jira-email', cfg.email || '');
        set('editor-jira-apiToken', cfg.apiToken || '');
        set('editor-jira-jql', cfg.jql || '');
        set('editor-jira-pollInterval', cfg.pollIntervalSec || 60);
        set('editor-jira-defaultAgent', cfg.defaultAgent || 'cline');
        // v3.4 Trust Hardening fields (guard defaults ON when key is absent)
        const onlyUnassignedEl = document.getElementById('editor-jira-onlyUnassigned');
        if (onlyUnassignedEl) onlyUnassignedEl.checked = cfg.onlyUnassigned !== false;
        set('editor-jira-botEmail', cfg.botAccountEmail || '');
        set('editor-jira-maxAutostart', (cfg.maxAutostartPerPoll ?? 3));
        // v3.4.1: transition-on-done defaults ON when the key is absent
        const transitionEl = document.getElementById('editor-jira-transitionOnDone');
        if (transitionEl) transitionEl.checked = cfg.transitionOnDone !== false;
        const resultEl = document.getElementById('jira-test-result');
        if (resultEl) { resultEl.textContent = ''; resultEl.style.color = ''; }
    }
    // Exposed so projects.js editProject() can populate the section on open.
    window.populateJiraFields = populateJiraFields;

    async function testJiraConnection() {
        const projectId = document.getElementById('editor-project-id').value;
        const resultEl = document.getElementById('jira-test-result');
        if (!projectId || !resultEl) return;
        resultEl.style.color = '#888';
        resultEl.textContent = 'Testing…';
        try {
            const candidate = collectJiraConfigFromForm();
            const r = await fetch(`/api/projects/${projectId}/jira/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(candidate)
            });
            const d = await r.json();
            resultEl.style.color = d.ok ? '#27ae60' : '#e74c3c';
            resultEl.textContent = (d.ok ? '✓ ' : '✗ ') + d.message;
        } catch (e) {
            resultEl.style.color = '#e74c3c';
            resultEl.textContent = '✗ ' + e.message;
        }
    }

    async function jiraPollNow() {
        const projectId = document.getElementById('editor-project-id').value;
        const resultEl = document.getElementById('jira-test-result');
        if (!projectId || !resultEl) return;
        resultEl.style.color = '#888';
        resultEl.textContent = 'Syncing…';
        try {
            const r = await fetch(`/api/projects/${projectId}/jira/poll-now`, { method: 'POST' });
            const d = await r.json();
            const s = d.status || {};
            if (s.lastError) {
                resultEl.style.color = '#e74c3c';
                resultEl.textContent = '✗ ' + s.lastError;
            } else {
                resultEl.style.color = '#27ae60';
                resultEl.textContent = '✓ Synced: ' + (s.lastResult || 'done');
                // Refresh the board so new cards appear
                if (typeof window.loadPipeline === 'function') window.loadPipeline();
            }
        } catch (e) {
            resultEl.style.color = '#e74c3c';
            resultEl.textContent = '✗ ' + e.message;
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

        // Jira channel buttons
        document.getElementById('btn-test-jira')?.addEventListener('click', testJiraConnection);
        document.getElementById('btn-jira-poll-now')?.addEventListener('click', jiraPollNow);

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