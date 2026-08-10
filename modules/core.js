        /* ═══════════════════════════════════════════
           Core — App initialization, tab switching, proxy polling, settings
           ═══════════════════════════════════════════ */

        /* ── Provider Definitions ── */
        const PROVIDERS = {
            custom: {
                name: 'Custom (Manual)',
                apiBase: '',
                apiKey: '',
                models: [],
                defaultModel: ''
            },
            lmstudio: {
                name: 'LM Studio (Local)',
                apiBase: 'http://localhost:1234/v1',
                // LM Studio ignores the API key value but the transport layer wants
                // *some* string so we ship a sentinel that also flags "local" in logs.
                apiKey: 'lm-studio',
                models: [],
                defaultModel: ''
            },
            openai: {
                name: 'OpenAI',
                apiBase: 'https://api.openai.com/v1',
                apiKey: '',
                models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'],
                defaultModel: 'gpt-4o'
            },
            anthropic: {
                name: 'Anthropic',
                apiBase: 'https://api.anthropic.com',
                apiKey: '',
                models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-haiku-20240307'],
                defaultModel: 'claude-sonnet-4-20250514'
            },
            gemini: {
                name: 'Google Gemini',
                apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
                apiKey: '',
                models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
                defaultModel: 'gemini-2.5-pro'
            },
            'x-ai': {
                name: 'X AI (Grok)',
                apiBase: 'https://api.x.ai/v1',
                apiKey: '',
                models: ['grok-2', 'grok-2-mini', 'grok-3'],
                defaultModel: 'grok-2'
            }
        };

        /* Given a scope prefix, is the current field value either empty
           or exactly the default for the *previous* provider? If so, we
           can safely overwrite it without clobbering user-typed data. */
        function _safeToOverwrite(inputEl, prevProviderDefault) {
            if (!inputEl) return false;
            const cur = (inputEl.value || '').trim();
            if (!cur) return true;
            if (prevProviderDefault && cur === prevProviderDefault) return true;
            return false;
        }

        /* ── Handle Provider Change ──
           Populates actual .value on the visible inputs (not just placeholders)
           so that submits carry real data. Preserves user-typed values by only
           overwriting fields that are empty OR still match the *previous*
           provider's default (tracked via dataset.prevProvider on the select). */
        function onProviderChange(provider, scope) {
            const providerData = PROVIDERS[provider];
            if (!providerData) return;

            // Determine which elements to update based on scope
            let prefix;
            let selectId;
            if (scope === 'project') {
                prefix = 'project-config-';
                selectId = 'project-config-provider';
            } else if (scope === 'editor') {
                prefix = 'editor-';
                selectId = 'editor-provider';
            } else {
                prefix = 'config-';
                selectId = 'config-provider';
            }

            const selectEl = document.getElementById(selectId);
            const prevProvider = selectEl ? (selectEl.dataset.prevProvider || '') : '';
            const prevData = PROVIDERS[prevProvider] || null;

            const apiBaseInput = document.getElementById(`${prefix}apiBase`);
            const apiKeyInput  = document.getElementById(`${prefix}apiKey`);
            const modelInput   = document.getElementById(`${prefix}model`);

            // Custom = leave everything alone; user types their own values.
            if (provider !== 'custom') {
                if (_safeToOverwrite(apiBaseInput, prevData ? prevData.apiBase : '')) {
                    apiBaseInput.value = providerData.apiBase || '';
                }
                if (_safeToOverwrite(apiKeyInput, prevData ? prevData.apiKey : '')) {
                    // Only assign if we have a preset apiKey to apply (LM Studio).
                    // Otherwise leave whatever's there (empty or user-typed).
                    if (providerData.apiKey) {
                        apiKeyInput.value = providerData.apiKey;
                    }
                }
                if (_safeToOverwrite(modelInput, prevData ? prevData.defaultModel : '')) {
                    modelInput.value = providerData.defaultModel || '';
                }
            }

            if (selectEl) selectEl.dataset.prevProvider = provider;
        }

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
            document.querySelectorAll('.tab-btn, .nav-btn').forEach(b => b.classList.remove('active'));
            const target = document.getElementById(tabId);
            if (target) target.classList.add('active');
            // Tag the body with the active tab so global CSS can show/hide chrome (e.g. context bar)
            document.body.className = document.body.className
                .split(' ')
                .filter(c => !c.startsWith('tab-'))
                .concat(['tab-' + tabId])
                .join(' ')
                .trim();
            // Find the button that references this tab (new nav-btn or legacy tab-btn)
            const btn = document.querySelector(`.nav-btn[data-tab="${tabId}"], .tab-btn[data-tab="${tabId}"]`);
            if (btn) btn.classList.add('active');

            // Show/hide terminal panel based on tab — only on the board.
            const terminalPanel = document.getElementById('terminal-panel');
            if (tabId === 'board') {
                if (terminalPanel) terminalPanel.style.display = '';
            } else {
                if (terminalPanel) terminalPanel.style.display = 'none';
            }

            // Load chat module when switching to Requirements tab
            if (tabId === 'requirements' && typeof window.loadChat === 'function') {
                window.loadChat();
            }

            // Reload config every time the user navigates to the log-viewer tab
            if (tabId === 'log-viewer') loadConfig();

            // When returning to the board, refresh task states from server
            if (tabId === 'board' && typeof window.refreshPipelineStates === 'function') {
                window.refreshPipelineStates();
            }
        }
        window.openTab = openTab;

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
        async function loadConfig() {
            try {
                const response = await fetch('/api/config');
                const data = await response.json();
                const config = data.aiderConfig || {};

                // Load provider FIRST so onProviderChange can auto-populate defaults
                const providerSelect = document.getElementById('config-provider');
                if (providerSelect && config.provider) {
                    providerSelect.value = config.provider;
                    // Trigger the provider change handler to auto-populate defaults
                    onProviderChange(config.provider, 'global');
                }

                // THEN overwrite with saved values so user's custom settings take precedence
                // over provider defaults. Order matters: saved values must come LAST.
                document.getElementById('config-apiBase').value = config.apiBase || '';
                document.getElementById('config-apiKey').value = config.apiKey || '';
                document.getElementById('config-model').value = config.model || '';

                // Track the currently-loaded provider so the next dropdown change
                // can safely overwrite fields that still match this provider's defaults.
                if (providerSelect) {
                    providerSelect.dataset.prevProvider = config.provider || '';
                }
                // Load maxTokens preset (default to 16384 = Extended)
                const maxTokensSelect = document.getElementById('config-maxTokens');
                if (maxTokensSelect && config.maxTokens) {
                    maxTokensSelect.value = config.maxTokens;
                }

                // Load Telegram config as well
                if (typeof loadTelegramConfig === 'function') {
                    loadTelegramConfig();
                }
            } catch (e) {
                console.error('Error loading config:', e);
            }
        }

        function _showGlobalConfigMsg(kind, text) {
            const errEl = document.getElementById('global-config-error');
            const okEl  = document.getElementById('global-config-success');
            if (errEl) errEl.style.display = 'none';
            if (okEl)  okEl.style.display  = 'none';
            const target = kind === 'error' ? errEl : okEl;
            if (target) {
                target.textContent = text;
                target.style.display = 'block';
                if (kind === 'success') {
                    setTimeout(() => { target.style.display = 'none'; }, 4000);
                }
            }
        }

        async function saveConfig() {
            const provider = document.getElementById('config-provider').value;
            const apiBase = document.getElementById('config-apiBase').value.trim();
            const apiKey = document.getElementById('config-apiKey').value.trim();
            const model = document.getElementById('config-model').value.trim();
            const maxTokens = document.getElementById('config-maxTokens').value;

            // Guardrail: non-custom providers must have an API Base URL populated.
            // (Custom mode is explicitly "type everything yourself" — no validation.)
            if (provider && provider !== 'custom' && !apiBase) {
                _showGlobalConfigMsg('error', 'API Base URL is required. Pick a provider preset (e.g. LM Studio) or switch to "Custom (Manual)" and type your own.');
                return;
            }

            // Write back trimmed values so users see what actually got POSTed.
            document.getElementById('config-apiBase').value = apiBase;
            document.getElementById('config-apiKey').value = apiKey;
            document.getElementById('config-model').value = model;

            try {
                const response = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ aiderConfig: { provider, apiBase, apiKey, model, maxTokens } })
                });
                if (response.ok) {
                    _showGlobalConfigMsg('success', '✓ Configuration saved.');
                    const sel = document.getElementById('config-provider');
                    if (sel) sel.dataset.prevProvider = provider;
                } else {
                    _showGlobalConfigMsg('error', 'Error saving configuration.');
                }
            } catch (e) {
                console.error(e);
                _showGlobalConfigMsg('error', 'Network error saving configuration.');
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
            // Tab switching buttons (legacy .tab-btn + new .nav-btn)
            document.querySelectorAll('.tab-btn, .nav-btn').forEach(btn => {
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

            // Provider change handler
            const providerSelect = document.getElementById('config-provider');
            if (providerSelect) {
                providerSelect.addEventListener('change', function() {
                    onProviderChange(this.value, 'global');
                });
            }
        }

        // Bind listeners and load config once DOM is ready
        function initCore() {
            bindCoreEventListeners();
            // Default body tab class so CSS shows the right chrome on first paint.
            if (!document.body.className.split(' ').some(c => c.startsWith('tab-'))) {
                document.body.classList.add('tab-board');
            }
            // Auto-load global LLM configuration on page load so settings fields
            // are populated immediately after a refresh/restart, without requiring
            // the user to navigate to the Logs & Settings tab first.
            loadConfig();
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initCore);
        } else {
            initCore();
        }
