        /* ═══════════════════════════════════════════
           Core — App initialization, tab switching, proxy polling, settings
           ═══════════════════════════════════════════ */

         /* ── Update sequence status text in header ── */
         async function updateSequenceStatus() {
             const statusEl = document.getElementById('sequence-status-text');
             if (!statusEl) return;

             try {
                 const response = await fetch('/api/projects');
                 if (!response.ok) return;
                 const data = await response.json();
                 const projects = data.projects || [];

                 // Find any project with a task in 'in_progress' state
                 let runningProjectName = null;
                 for (const project of projects) {
                     const tasks = project.tasks || [];
                     const hasRunningTask = tasks.some(t => t.state === 'in_progress');
                     if (hasRunningTask) {
                         runningProjectName = project.name;
                         break;
                     }
                 }

                  if (runningProjectName) {
                     statusEl.textContent = `Running for ${runningProjectName}`;
                      document.title = `BatonBot: Running for ${runningProjectName}`;
                  } else {
                      statusEl.textContent = 'Task Orchestrator';
                      document.title = 'BatonBot: Task Orchestrator';
                  }
             } catch (e) {
                 console.error('Error updating sequence status:', e);
             }
         }

         /* ── Truncate path to 40 chars with ellipsis prefix ── */
        function truncatePath(path) {
            if (!path || path.length <= 40) return path;
            // Show last ~37 chars with "..." prefix
            return '...' + path.slice(-37);
        }

        /* ── Tab switching (uses data-tab attributes) ── */
        function openTab(tabId) {
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            const target = document.getElementById(tabId);
            if (target) target.classList.add('active');
            // Find the button that references this tab
            const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
            if (btn) btn.classList.add('active');

            // Show/hide global action bar and terminal panel based on tab
            // Only show on Projects tab, hide on Pipeline and Logs & Settings tabs
            const actionBar = document.getElementById('global-action-bar');
            const terminalPanel = document.getElementById('terminal-panel');
            if (tabId === 'projects') {
                // Show on Projects tab (respect existing visible/hidden state)
                if (actionBar) actionBar.classList.remove('hidden');
                if (terminalPanel) terminalPanel.style.display = '';
            } else {
                // Hide on Pipeline and Logs & Settings tabs
                if (actionBar) actionBar.classList.add('hidden');
                if (terminalPanel) terminalPanel.style.display = 'none';
            }

            // Load chat module when switching to Requirements tab
            if (tabId === 'requirements' && typeof window.loadChat === 'function') {
                window.loadChat();
            }

            // Load config when switching to log-viewer tab (to show settings drawer)
            if (tabId === 'log-viewer' && !configLoaded) loadConfig();

            // When switching to Projects tab, refresh pipeline state indicators
            // so prompt statuses are in sync with the server (important when a
            // sequence is running and the user navigated away and back)
            if (tabId === 'projects' && typeof window.refreshPipelineStates === 'function') {
                window.refreshPipelineStates();
            }
        }

        // ── Status Polling ──
        let proxyStatusInterval = null;

        function startProxyPolling() {
            // Check sequence status immediately on load
            updateSequenceStatus();
            // Then poll every 10 seconds
            proxyStatusInterval = setInterval(() => {
                updateSequenceStatus();
            }, 10000);
        }

        function stopProxyPolling() {
            if (proxyStatusInterval) {
                clearInterval(proxyStatusInterval);
                proxyStatusInterval = null;
            }
        }

        // Settings / Configuration
        let configLoaded = false;

        async function loadConfig() {
            if (configLoaded) return;
            try {
                const response = await fetch('/api/config');
                const data = await response.json();
                const config = data.aiderConfig || {};
                document.getElementById('config-apiBase').value = config.apiBase || '';
                document.getElementById('config-apiKey').value = config.apiKey || '';
                document.getElementById('config-model').value = config.model || '';
                // Load maxTokens preset (default to 16384 = Extended)
                const maxTokensSelect = document.getElementById('config-maxTokens');
                if (maxTokensSelect && config.maxTokens) {
                    maxTokensSelect.value = config.maxTokens;
                }
                // Load Telegram config as well
                if (typeof loadTelegramConfig === 'function') {
                    loadTelegramConfig();
                }
                configLoaded = true;
            } catch (e) {
                console.error('Error loading config:', e);
            }
        }

        async function saveConfig() {
            const apiBase = document.getElementById('config-apiBase').value.trim();
            const apiKey = document.getElementById('config-apiKey').value.trim();
            const model = document.getElementById('config-model').value.trim();
            const maxTokens = document.getElementById('config-maxTokens').value;

            try {
                const response = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ aiderConfig: { apiBase, apiKey, model, maxTokens } })
                });
                if (response.ok) {
                    alert('Configuration saved successfully!');
                } else {
                    alert('Error saving configuration');
                }
            } catch (e) {
                console.error(e);
                alert('Error saving configuration');
            }
        }

        /* ── Escape HTML to prevent XSS in inline display ── */
        function escapeHtml(text) {
            if (text == null) return '';
            const str = String(text);
            var map = {
                '&': String.fromCharCode(38) + 'amp;',
                '<': String.fromCharCode(38) + 'lt;',
                '>': String.fromCharCode(38) + 'gt;',
                '"': String.fromCharCode(38) + 'quot;',
                "'": String.fromCharCode(38) + '#x27;'
            };
            return str.replace(/[&<>"']/g, function(m) { return map[m]; });
        }

        // Start proxy polling on load
        startProxyPolling();

        /* ── Event Listeners (bound after DOM ready) ── */
        function bindCoreEventListeners() {
            // Tab switching buttons
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const tabId = this.getAttribute('data-tab');
                    if (tabId) openTab(tabId);
                });
            });

            // Save global config button
            const saveConfigBtn = document.getElementById('btn-save-global-config');
            if (saveConfigBtn) {
                saveConfigBtn.addEventListener('click', saveConfig);
            }
        }

        // Bind listeners once DOM is ready (defer scripts guarantee this runs after DOM)
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', bindCoreEventListeners);
        } else {
            bindCoreEventListeners();
        }