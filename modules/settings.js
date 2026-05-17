/* ═══════════════════════════════════════════
           Settings — Drawer tab switching, per-project config
           ═══════════════════════════════════════════ */

         /* ── Settings Drawer Tab Switching ── */
         function switchSettingsTab(tabName) {
             // Update tab button states
             document.querySelectorAll('.drawer-tab-btn').forEach(btn => btn.classList.remove('active'));
             const activeBtn = document.querySelector(`.drawer-tab-btn[data-drawer-tab="${tabName}"]`);
             if (activeBtn) activeBtn.classList.add('active');

             // Update tab content visibility
             document.querySelectorAll('.drawer-tab-content').forEach(content => content.classList.remove('active'));
             const targetContent = document.getElementById(`settings-tab-${tabName}`);
             if (targetContent) targetContent.classList.add('active');

             // Load project list when switching to project tab
             if (tabName === 'project') {
                 populateProjectConfigSelect();
             }

             // Load MCP config when switching to MCP tab
             if (tabName === 'mcp') {
                 loadMcpConfig();
             }

         }

        /* ── Populate Project Select Dropdown ── */
        async function populateProjectConfigSelect() {
            const select = document.getElementById('project-config-select');
            if (!select) return;

            // Only populate once
            if (select.dataset.populated) return;
            select.dataset.populated = 'true';

            try {
                const response = await fetch('/api/projects');
                const data = await response.json();
                const projects = data.projects || [];

                projects.forEach(p => {
                    const option = document.createElement('option');
                    option.value = p.id;
                    option.textContent = p.name;
                    select.appendChild(option);
                });
            } catch (e) {
                console.error('Error loading projects for config select:', e);
            }
        }

        /* ── Load Project-Specific Config ── */
        async function loadProjectConfig() {
            const select = document.getElementById('project-config-select');
            if (!select || !select.value) {
                document.getElementById('project-config-fields').style.display = 'none';
                return;
            }

            try {
                const response = await fetch('/api/projects');
                if (!response.ok) {
                    document.getElementById('project-config-fields').style.display = 'none';
                    return;
                }

                const data = await response.json();
                const projects = data.projects || [];
                const project = projects.find(p => p.id === select.value);

                if (!project) {
                    document.getElementById('project-config-fields').style.display = 'none';
                    return;
                }

                // Show fields
                document.getElementById('project-config-fields').style.display = 'block';

                const config = project.aiderConfig || {};

                // Populate fields
                document.getElementById('project-config-provider').value = config.provider || '';
                document.getElementById('project-config-apiBase').value = config.apiBase || '';
                document.getElementById('project-config-apiKey').value = config.apiKey || '';
                document.getElementById('project-config-model').value = config.model || '';

                // Show override badges if values are set
                updateOverrideBadge('project-provider-badge', config.provider);
                updateOverrideBadge('project-apiBase-badge', config.apiBase);
                updateOverrideBadge('project-apiKey-badge', config.apiKey);
                updateOverrideBadge('project-model-badge', config.model);

                // Trigger provider change handler to auto-populate fields
                if (config.provider) {
                    onProviderChange(config.provider, 'project');
                }

            } catch (e) {
                console.error('Error loading project config:', e);
                document.getElementById('project-config-fields').style.display = 'none';
            }
        }

        /* ── Update Override Badge Visibility ── */
        function updateOverrideBadge(badgeId, value) {
            const badge = document.getElementById(badgeId);
            if (!badge) return;

            if (value && value.trim()) {
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        }

        /* ── Save Project-Specific Config Override ── */
        async function saveProjectConfig() {
            const select = document.getElementById('project-config-select');
            if (!select || !select.value) {
                return alert('Please select a project first');
            }

            const provider = document.getElementById('project-config-provider').value.trim();
            const apiBase = document.getElementById('project-config-apiBase').value.trim();
            const apiKey = document.getElementById('project-config-apiKey').value.trim();
            const model = document.getElementById('project-config-model').value.trim();

            // Only save if at least one field is set
            if (!provider && !apiBase && !apiKey && !model) {
                return alert('Please fill in at least one field to override, or use "Clear Override" to reset.');
            }

            try {
                const response = await fetch(`/api/projects/${select.value}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        aiderConfig: { provider, apiBase, apiKey, model }
                    })
                });

                if (response.ok) {
                    // Update badges
                    updateOverrideBadge('project-provider-badge', provider);
                    updateOverrideBadge('project-apiBase-badge', apiBase);
                    updateOverrideBadge('project-apiKey-badge', apiKey);
                    updateOverrideBadge('project-model-badge', model);
                    
                    // Re-select the same project after reload
                    const projectId = select.value;
                    populateProjectConfigSelect().then(() => {
                        document.getElementById('project-config-select').value = projectId;
                    });
                } else {
                    alert('Error saving project configuration');
                }
            } catch (e) {
                console.error(e);
                alert('Error saving project configuration');
            }
        }

        /* ── Clear Project-Specific Config Override ── */
        async function clearProjectConfig() {
            const select = document.getElementById('project-config-select');
            if (!select || !select.value) {
                return alert('Please select a project first');
            }

            if (!confirm('Clear the configuration override for this project? It will inherit global settings.')) {
                return;
            }

            try {
                const response = await fetch(`/api/projects/${select.value}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        aiderConfig: {}
                    })
                });

                if (response.ok) {
                    // Clear fields
                    document.getElementById('project-config-provider').value = '';
                    document.getElementById('project-config-apiBase').value = '';
                    document.getElementById('project-config-apiKey').value = '';
                    document.getElementById('project-config-model').value = '';

                    // Hide badges
                    updateOverrideBadge('project-provider-badge', '');
                    updateOverrideBadge('project-apiBase-badge', '');
                    updateOverrideBadge('project-apiKey-badge', '');
                    updateOverrideBadge('project-model-badge', '');

                    // Re-select the same project after reload
                    const projectId = select.value;
                    populateProjectConfigSelect().then(() => {
                        document.getElementById('project-config-select').value = projectId;
                    });

                    alert('Project configuration cleared.');
                } else {
                    alert('Error clearing project configuration');
                }
            } catch (e) {
                console.error(e);
                alert('Error clearing project configuration');
            }
        }

        /* ── Settings Drawer: Open/Close ── */
        function openSettingsDrawer() {
            document.getElementById('settings-drawer').classList.add('open');
            document.getElementById('drawer-backdrop').classList.add('active');
        }

        function closeSettingsDrawer() {
            document.getElementById('settings-drawer').classList.remove('open');
            document.getElementById('drawer-backdrop').classList.remove('active');
        }

          /* ── Load Telegram Config ── */
          async function loadTelegramConfig() {
              try {
                  const response = await fetch('/api/config');
                  if (!response.ok) return;
                  const data = await response.json();
                  const cfg = data.telegramConfig || {};
                  const tokenInput = document.getElementById('telegram-bot-token');
                  const chatIdInput = document.getElementById('telegram-chat-id');
                  if (tokenInput) tokenInput.value = cfg.botToken || '';
                  if (chatIdInput) chatIdInput.value = cfg.chatId || '';
              } catch (e) {
                  console.error('Error loading Telegram config:', e);
              }
          }

          /* ── Save Telegram Config ── */
          async function saveTelegramConfig() {
              const botToken = document.getElementById('telegram-bot-token').value.trim();
              const chatId = document.getElementById('telegram-chat-id').value.trim();

              if (!botToken || !chatId) {
                  showTelegramResult('Please fill in both Bot Token and Chat ID.', 'error');
                  return;
              }

              try {
                  const response = await fetch('/api/config', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ telegramConfig: { botToken, chatId } })
                  });

                  if (response.ok) {
                      showTelegramResult('✓ Telegram configuration saved!', 'success');
                  } else {
                      showTelegramResult('Error saving configuration.', 'error');
                  }
              } catch (e) {
                  console.error(e);
                  showTelegramResult('Error saving configuration.', 'error');
              }
          }

          /* ── Test Telegram Connection ── */
          async function testTelegramConnection() {
              const botToken = document.getElementById('telegram-bot-token').value.trim();
              const chatId = document.getElementById('telegram-chat-id').value.trim();

              if (!botToken || !chatId) {
                  showTelegramResult('Please fill in both Bot Token and Chat ID first.', 'error');
                  return;
              }

              showTelegramResult('⏳ Sending test message...', 'info');

              try {
                  const response = await fetch('/api/telegram/test', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ botToken, chatId })
                  });

                  const result = await response.json();

                  if (result.success) {
                      showTelegramResult('✓ Test message sent! Check your Telegram.', 'success');
                  } else {
                      showTelegramResult('✗ ' + (result.error || 'Test failed.'), 'error');
                  }
              } catch (e) {
                  console.error(e);
                  showTelegramResult('✗ Network error. Check your connection.', 'error');
              }
          }

           /* ── Show Telegram Result Message ── */
           function showTelegramResult(message, type) {
               const el = document.getElementById('telegram-test-result');
               if (!el) return;
               el.style.display = 'block';
               el.textContent = message;

               if (type === 'success') {
                   el.style.background = '#d4edda';
                   el.style.color = '#155724';
                   el.style.border = '1px solid #c3e6cb';
               } else if (type === 'error') {
                   el.style.background = '#f8d7da';
                   el.style.color = '#721c24';
                   el.style.border = '1px solid #f5c6cb';
               } else {
                   el.style.background = '#d1ecf1';
                   el.style.color = '#0c5460';
                   el.style.border = '1px solid #bee5eb';
               }
           }

          /* ═══════════════════════════════════════════
             MCP Servers Configuration
             ═══════════════════════════════════════════ */

          /* ── Load MCP Config ── */
          async function loadMcpConfig() {
              try {
                  const response = await fetch('/api/mcp/config');
                  if (!response.ok) return;
                  const data = await response.json();
                  const mcpConfig = data.mcpServers || {};
                  const gitConfig = mcpConfig.git || {};

                  // Populate Git MCP server fields
                  const enabledCheckbox = document.getElementById('mcp-git-enabled');
                  const commandInput = document.getElementById('mcp-git-command');
                  const argsInput = document.getElementById('mcp-git-args');
                  const statusBadge = document.getElementById('mcp-git-status');

                  if (enabledCheckbox) enabledCheckbox.checked = gitConfig.enabled || false;
                  if (commandInput) commandInput.value = gitConfig.command || 'npx';
                  if (argsInput) argsInput.value = JSON.stringify(gitConfig.args || ["-y", "@anthropic-ai/mcp-server-git"]);

                  // Update status badge
                  if (statusBadge) {
                      if (gitConfig.enabled) {
                          statusBadge.textContent = 'enabled';
                          statusBadge.style.color = '#27ae60';
                      } else {
                          statusBadge.textContent = 'disabled';
                          statusBadge.style.color = '#95a5a6';
                      }
                  }

                  // Update card visibility based on enabled state
                  updateMcpGitCardVisibility();
              } catch (e) {
                  console.error('Error loading MCP config:', e);
              }
          }

          /* ── Update Git MCP Card Visibility ── */
          function updateMcpGitCardVisibility() {
              const enabledCheckbox = document.getElementById('mcp-git-enabled');
              const configSection = document.querySelector('.mcp-server-config');
              if (enabledCheckbox && configSection) {
                  if (enabledCheckbox.checked) {
                      configSection.style.display = 'block';
                  } else {
                      configSection.style.display = 'none';
                  }
              }
          }

          /* ── Save MCP Config ── */
          async function saveMcpConfig() {
              const enabled = document.getElementById('mcp-git-enabled')?.checked || false;
              const command = document.getElementById('mcp-git-command')?.value.trim() || 'npx';
              let args = ["-y", "@anthropic-ai/mcp-server-git"];

              try {
                  const argsRaw = document.getElementById('mcp-git-args')?.value.trim() || '[]';
                  args = JSON.parse(argsRaw);
              } catch (e) {
                  showMcpResult('✗ Invalid JSON in Arguments field. Must be a JSON array.', 'error');
                  return;
              }

              try {
                  const response = await fetch('/api/mcp/config', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          mcpServers: {
                              git: { enabled, command, args, transport: 'stdio' }
                          }
                      })
                  });

                  if (response.ok) {
                      const statusBadge = document.getElementById('mcp-git-status');
                      if (statusBadge) {
                          statusBadge.textContent = enabled ? 'enabled' : 'disabled';
                          statusBadge.style.color = enabled ? '#27ae60' : '#95a5a6';
                      }
                      showMcpResult('✓ MCP configuration saved!', 'success');
                  } else {
                      showMcpResult('✗ Error saving MCP configuration.', 'error');
                  }
              } catch (e) {
                  console.error(e);
                  showMcpResult('✗ Error saving MCP configuration.', 'error');
              }
          }

          /* ── Test Git MCP Server Connection ── */
          async function testMcpGitServer() {
              const command = document.getElementById('mcp-git-command')?.value.trim() || 'npx';
              let args = ["-y", "@anthropic-ai/mcp-server-git"];

              try {
                  const argsRaw = document.getElementById('mcp-git-args')?.value.trim() || '[]';
                  args = JSON.parse(argsRaw);
              } catch (e) {
                  showMcpResult('✗ Invalid JSON in Arguments field.', 'error');
                  return;
              }

              showMcpResult('⏳ Testing Git MCP server connection...', 'info');

              try {
                  const response = await fetch('/api/mcp/connect', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          name: 'git',
                          command,
                          args,
                          transport: 'stdio'
                      })
                  });

                  const result = await response.json();

                  if (result.success) {
                      showMcpResult('✓ Git MCP server connected successfully! Tools are available.', 'success');
                      // Auto-disconnect after test
                      setTimeout(async () => {
                          await fetch('/api/mcp/disconnect', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ name: 'git' })
                          });
                      }, 3000);
                  } else {
                      showMcpResult('✗ ' + (result.message || 'Failed to connect to Git MCP server. Check installation.'), 'error');
                  }
              } catch (e) {
                  console.error(e);
                  showMcpResult('✗ Network error. Check your connection.', 'error');
              }
          }

          /* ── Show MCP Result Message ── */
          function showMcpResult(message, type) {
              const el = document.getElementById('mcp-save-result');
              if (!el) return;
              el.style.display = 'block';
              el.textContent = message;

              if (type === 'success') {
                  el.style.background = '#d4edda';
                  el.style.color = '#155724';
                  el.style.border = '1px solid #c3e6cb';
              } else if (type === 'error') {
                  el.style.background = '#f8d7da';
                  el.style.color = '#721c24';
                  el.style.border = '1px solid #f5c6cb';
              } else {
                  el.style.background = '#d1ecf1';
                  el.style.color = '#0c5460';
                  el.style.border = '1px solid #bee5eb';
              }

              // Auto-hide after 5 seconds
              setTimeout(() => { el.style.display = 'none'; }, 5000);
          }

         /* ── Event Listeners for Settings ── */
         function bindSettingsEventListeners() {
             // Open settings drawer button
             const openBtn = document.getElementById('btn-open-settings');
             if (openBtn) {
                 openBtn.addEventListener('click', openSettingsDrawer);
             }

             // Close settings drawer button (X in header)
             const closeBtn = document.getElementById('btn-close-settings-drawer');
             if (closeBtn) {
                 closeBtn.addEventListener('click', closeSettingsDrawer);
             }

             // Drawer backdrop click closes drawer
             const backdrop = document.getElementById('drawer-backdrop');
             if (backdrop) {
                 backdrop.addEventListener('click', closeSettingsDrawer);
             }

             // Drawer tab switching (event delegation on the tabs container)
             const drawerTabs = document.querySelector('.drawer-tabs');
             if (drawerTabs) {
                 drawerTabs.addEventListener('click', function(e) {
                     const tabBtn = e.target.closest('.drawer-tab-btn');
                     if (tabBtn) {
                         const tabName = tabBtn.getAttribute('data-drawer-tab');
                         if (tabName) switchSettingsTab(tabName);
                     }
                 });
             }

             // Save global config button (also handled in core.js, but this is the primary binding)
             const saveGlobalBtn = document.getElementById('btn-save-global-config');
             if (saveGlobalBtn) {
                 // Only bind if not already bound — core.js handles this, skip duplicate
             }

             // Save project config button
             const saveProjectBtn = document.getElementById('btn-save-project-config');
             if (saveProjectBtn) {
                 saveProjectBtn.addEventListener('click', saveProjectConfig);
             }

             // Clear project config button
             const clearProjectBtn = document.getElementById('btn-clear-project-config');
             if (clearProjectBtn) {
                 clearProjectBtn.addEventListener('click', clearProjectConfig);
             }

             // Project config select change → load project config
             const projectSelect = document.getElementById('project-config-select');
             if (projectSelect) {
                 projectSelect.addEventListener('change', loadProjectConfig);
             }

             // Project config provider change → trigger provider change handler
             const projectProviderSelect = document.getElementById('project-config-provider');
             if (projectProviderSelect) {
                 projectProviderSelect.addEventListener('change', function() {
                     onProviderChange(this.value, 'project');
                 });
             }

              // Save Telegram config button
              const saveTelegramBtn = document.getElementById('btn-save-telegram-config');
              if (saveTelegramBtn) {
                  saveTelegramBtn.addEventListener('click', saveTelegramConfig);
              }

              // Test Telegram button
              const testTelegramBtn = document.getElementById('btn-test-telegram');
              if (testTelegramBtn) {
                  testTelegramBtn.addEventListener('click', testTelegramConnection);
              }

              // Save MCP config button
              const saveMcpBtn = document.getElementById('btn-save-mcp-config');
              if (saveMcpBtn) {
                  saveMcpBtn.addEventListener('click', saveMcpConfig);
              }

              // Test MCP Git server button
              const testMcpBtn = document.getElementById('btn-test-mcp-git');
              if (testMcpBtn) {
                  testMcpBtn.addEventListener('click', testMcpGitServer);
              }

              // Git MCP enabled checkbox toggle
              const gitEnabledCheckbox = document.getElementById('mcp-git-enabled');
              if (gitEnabledCheckbox) {
                  gitEnabledCheckbox.addEventListener('change', updateMcpGitCardVisibility);
              }
          }

        // Bind listeners once DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', bindSettingsEventListeners);
        } else {
            bindSettingsEventListeners();
        }
