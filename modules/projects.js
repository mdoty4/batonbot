/* ═══════════════════════════════════════════
           Projects — Project CRUD operations and activation
           ═══════════════════════════════════════════ */

        let activeProjectId = null;

        async function loadProjects() {
            try {
                const response = await fetch('/api/projects');
                const data = await response.json();
                const projects = data.projects || [];
                const body = document.getElementById('projects-body');
                if (!body) return; // Legacy projects tab is gone; board.js owns the project list now.

                if (projects.length === 0) {
                    body.innerHTML = `
                        <tr>
                            <td colspan="4" style="text-align:center; padding: 3rem 1rem;">
                                <div class="empty-state">
                                    <svg class="empty-state-icon" viewBox="0 0 120 100" xmlns="http://www.w3.org/2000/svg">
                                        <!-- Open box illustration -->
                                        <path d="M30 45 L60 25 L90 45 L60 35 Z" fill="#c5cae9" stroke="#7986cb" stroke-width="1.5"/>
                                        <path d="M20 50 L60 75 L100 50 L60 55 Z" fill="#e8eaf6" stroke="#7986cb" stroke-width="1.5"/>
                                        <path d="M20 50 L60 75 L60 35 L20 45 Z" fill="#c5cae9" stroke="#7986cb" stroke-width="1.5"/>
                                        <path d="M100 50 L60 75 L60 35 L100 45 Z" fill="#9fa8da" stroke="#7986cb" stroke-width="1.5"/>
                                        <!-- Small star/sparkle -->
                                        <circle cx="72" cy="30" r="2.5" fill="#ffca28"/>
                                        <circle cx="48" cy="38" r="1.5" fill="#ffca28"/>
                                        <circle cx="80" cy="42" r="1.5" fill="#ffca28"/>
                                    </svg>
                                    <p class="empty-state-title">No projects yet</p>
                                    <p class="empty-state-desc">Create your first project to get started. Your projects will appear here once created.</p>
                                </div>
                            </td>
                        </tr>`;
                    return;
                }

                body.innerHTML = projects.map(p => {
                    const isActive = p.id === activeProjectId;
                    return `
                    <tr data-project-id="${p.id}" ${isActive ? 'class="active-row"' : ''}>
                        <td>${escapeHtml(p.name)}</td>
                        <td style="font-size: 0.8rem; color: #666;" title="${p.workingDirectory || '.'}">
                            ${truncatePath(p.workingDirectory || '.')}
                        </td>
                        <td>${p.id}</td>
                        <td>
                            <span class="btn edit-project-btn" data-project-id="${p.id}" style="margin-right: 5px; background: #f39c12; font-size: 0.75rem; padding: 4px 8px;">Edit</span>
                            <span class="btn" style="margin-right: 5px; font-size: 0.75rem; padding: 4px 8px;">Activate</span>
                            <button class="btn btn-danger" data-project-id="${p.id}" style="font-size: 0.75rem; padding: 4px 8px;">Delete</button>
                        </td>
                    </tr>
                `;
                }).join('');
            } catch (e) {
                console.error('Error loading projects:', e);
                document.getElementById('projects-body').innerHTML = '<tr><td colspan="4" style="text-align:center; color:red">Error loading projects.</td></tr>';
            }
        }

        async function createProject() {
            const nameInput = document.getElementById('new-project-name');
            const workingDirInput = document.getElementById('new-project-workingDir');
            const name = nameInput.value.trim();
            if (!name) return alert('Please enter a project name');

            const workingDirectory = workingDirInput.value.trim() || null;

            try {
                const response = await fetch('/api/projects', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, workingDirectory })
                });
                if (response.ok) {
                    nameInput.value = '';
                    await loadProjects();
                    alert('Project created successfully!');
                } else {
                    alert('Error creating project');
                }
            } catch (e) {
                console.error(e);
                alert('Error creating project');
            }
        }

        async function activateProject(id) {
            activeProjectId = id;
            window.activeProjectId = id;
            // Delegate to board.js if available (new UI), else fall back to legacy banner.
            if (window.__boardHooks && window.__boardHooks.activateProject) {
                await window.__boardHooks.activateProject(id);
                return;
            }
            const banner = document.getElementById('active-project-display');
            if (banner) {
                const data = await fetch('/api/projects').then(r => r.json());
                const project = (data.projects || []).find(p => p.id === id);
                banner.textContent = `Active Project: ${project?.name || 'Unknown'}`;
            }
            if (typeof loadPipeline === 'function') await loadPipeline();
            // COMING SOON: Live Output panel. The terminal hook is a no-op stub
            // today (see modules/terminal.js banner). Wire kept in place so v2
            // of the panel can drop right in.
            if (window.__terminalHooks && window.__terminalHooks.onProjectActivated) {
                window.__terminalHooks.onProjectActivated();
            }
        }

        async function resetProject() {
            activeProjectId = null;
            window.activeProjectId = null;
            const banner = document.getElementById('active-project-display');
            if (banner) banner.textContent = 'Active Project: None';
            // COMING SOON: Live Output panel. No-op today (see modules/terminal.js).
            if (window.__terminalHooks && window.__terminalHooks.onProjectReset) {
                await window.__terminalHooks.onProjectReset();
            }
        }

        async function deleteProject(id) {
            const project = (await fetch('/api/projects').then(r => r.json())).projects.find(p => p.id === id);
            if (!project) return alert('Project not found');
            
            if (!confirm(`Are you sure you want to delete "${project.name}" and all its associated prompts?`)) {
                return;
            }

            try {
                const response = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
                if (response.ok) {
                    if (activeProjectId === id) {
                        activeProjectId = null;
                        document.getElementById('active-project-display').textContent = 'Active Project: None';
                        document.getElementById('pipeline-editor').innerHTML = '<p style="color: #666; text-align: center;">Please activate a project first in the Projects tab.</p>';
                    }
                    await loadProjects();
                } else {
                    alert('Error deleting project');
                }
            } catch (e) {
                console.error(e);
                alert('Error deleting project');
            }
        }

        /* ── Edit Project ── */
        async function editProject(id) {
            try {
                const response = await fetch('/api/projects');
                const data = await response.json();
                const project = data.projects.find(p => p.id === id);
                if (!project) {
                    alert('Project not found');
                    return;
                }

                // Populate editor fields
                document.getElementById('editor-project-id').value = project.id;
                document.getElementById('editor-project-name').value = project.name || '';
                document.getElementById('editor-project-workingDir').value = project.workingDirectory || '';
                document.getElementById('editor-project-defaultAgent').value = project.defaultAgent || 'aider';

                // Populate API override fields
                const aiderConfig = project.aiderConfig || {};
                document.getElementById('editor-provider').value = aiderConfig.provider || '';
                document.getElementById('editor-apiBase').value = aiderConfig.apiBase || '';
                document.getElementById('editor-apiKey').value = aiderConfig.apiKey || '';
                document.getElementById('editor-model').value = aiderConfig.model || '';

                // Trigger provider change handler to auto-populate fields
                if (aiderConfig.provider) {
                    onProviderChange(aiderConfig.provider, 'editor');
                }

                // Open drawer
                openProjectEditor();
            } catch (e) {
                console.error('Error loading project for editing:', e);
                alert('Error loading project details');
            }
        }

        /* ── Event Listeners for Projects ── */
        function bindProjectsEventListeners() {
            // Create project button
            const createBtn = document.getElementById('btn-create-project');
            if (createBtn) {
                createBtn.addEventListener('click', createProject);
            }

            // Table row delegation: edit, activate, delete on button clicks; row click for activate
            const projectsBody = document.getElementById('projects-body');
            if (projectsBody) {
                projectsBody.addEventListener('click', function(e) {
                    // Check for delete button click (must check before row click)
                    const deleteBtn = e.target.closest('.btn-danger');
                    if (deleteBtn) {
                        e.stopPropagation();
                        const id = deleteBtn.getAttribute('data-project-id');
                        if (id) deleteProject(id);
                        return;
                    }

                    // Check for edit button click
                    const editBtn = e.target.closest('.edit-project-btn');
                    if (editBtn) {
                        e.stopPropagation();
                        const id = editBtn.getAttribute('data-project-id');
                        if (id) editProject(id);
                        return;
                    }

                    // Check for row click (activate project)
                    const row = e.target.closest('tr');
                    if (row) {
                        const id = row.getAttribute('data-project-id');
                        if (id) activateProject(id);
                    }
                });
            }
        }

        // Bind listeners once DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', bindProjectsEventListeners);
        } else {
            bindProjectsEventListeners();
        }

        // Expose helpers globally so board.js and other modules can call them.
        window.editProject = editProject;
        window.deleteProject = deleteProject;
        window.createProject = createProject;

        // Initial load
        loadProjects();
