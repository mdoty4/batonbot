/**
 * Chat Module
 * Handles chat interaction for the Requirements tab
 */

// ── State ──
let selectedProjectId = null;
const chatMessages = [];
const pendingRequirements = [];
let chatLoaded = false;

// ── loadChat() — called when Requirements tab is activated ──
async function loadChat() {
    if (chatLoaded) return;
    console.log('[chat.js] loadChat() — populating project selector');
    await populateProjectSelector();
    chatLoaded = true;
}

// ── Populate Project Selector ──
async function populateProjectSelector() {
    const select = document.getElementById('chat-project-select');
    if (!select) return;

    try {
        const response = await fetch('/api/projects');
        const data = await response.json();
        const projects = data.projects || [];

        // Clear existing options except the placeholder
        select.innerHTML = '<option value="">— Select Project —</option>';

        // Add project options
        projects.forEach(p => {
            const option = document.createElement('option');
            option.value = p.id;
            option.textContent = p.name;
            select.appendChild(option);
        });

        // Auto-select the active project if available
        if (window.activeProjectId) {
            const exists = projects.some(p => p.id === window.activeProjectId);
            if (exists) {
                select.value = window.activeProjectId;
                selectChatProject(window.activeProjectId);
            }
        }
    } catch (e) {
        console.error('[chat.js] Error loading projects for selector:', e);
    }
}

// ── Select Chat Project ──
function selectChatProject(projectId) {
    selectedProjectId = projectId;
    const chatInput = document.getElementById('chat-input');
    const btnSend = document.getElementById('btn-send-chat');

    if (projectId) {
        chatInput.disabled = false;
        chatInput.placeholder = 'Describe your project...';
        if (btnSend) btnSend.disabled = false;
        console.log(`[chat.js] Project selected: ${projectId}`);
    } else {
        chatInput.disabled = true;
        chatInput.placeholder = 'Select a project first...';
        if (btnSend) btnSend.disabled = true;
    }
}

// ── Create New Chat Project ──
async function createNewChatProject() {
    const nameInput = document.getElementById('new-chat-project-name');
    const createBtn = document.getElementById('btn-create-chat-project');

    // Toggle input visibility
    if (nameInput.style.display === 'none') {
        nameInput.style.display = 'block';
        createBtn.textContent = '✓ Create';
        nameInput.focus();
        return;
    }

    const name = nameInput.value.trim();
    if (!name) {
        alert('Please enter a project name');
        return;
    }

    try {
        const response = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, workingDirectory: null })
        });

        if (response.ok) {
            const data = await response.json();
            nameInput.value = '';
            nameInput.style.display = 'none';
            createBtn.textContent = '+ New Project';

            // Reload the selector with the new project
            await populateProjectSelector();

            // Select the newly created project
            const newProjectId = data.project?.id || data.id;
            if (newProjectId) {
                selectChatProject(newProjectId);
                document.getElementById('chat-project-select').value = newProjectId;
            }
        } else {
            alert('Error creating project');
        }
    } catch (e) {
        console.error('[chat.js] Error creating project:', e);
        alert('Error creating project');
    }
}

// ── Bind Chat Event Listeners ──
function bindChatEventListeners() {
    // Project selector change
    const projectSelect = document.getElementById('chat-project-select');
    if (projectSelect) {
        projectSelect.addEventListener('change', (e) => {
            selectChatProject(e.target.value || null);
        });
    }

    // Create new project button
    const createBtn = document.getElementById('btn-create-chat-project');
    if (createBtn) {
        createBtn.addEventListener('click', createNewChatProject);
    }

    // New chat project name input — submit on Enter
    const nameInput = document.getElementById('new-chat-project-name');
    if (nameInput) {
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                createNewChatProject();
            }
            // Hide input and cancel on Escape
            if (e.key === 'Escape') {
                e.preventDefault();
                nameInput.value = '';
                nameInput.style.display = 'none';
                createBtn.textContent = '+ New Project';
            }
        });
    }

    // Send chat message button
    const btnSend = document.getElementById('btn-send-chat');
    if (btnSend) {
        btnSend.addEventListener('click', handleChatSend);
    }

    // Chat input — send on Ctrl+Enter
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleChatSend();
            }
        });
    }

    // Add to Pipeline button
    const btnAddToPipeline = document.getElementById('btn-add-to-pipeline');
    if (btnAddToPipeline) {
        btnAddToPipeline.addEventListener('click', () => {
            const selected = pendingRequirements.filter(r => r.selected);
            if (selected.length === 0) {
                alert('Select at least one requirement to add to the pipeline');
                return;
            }
            addToPipeline(selectedProjectId, selected);
        });
    }

    // Discard All button
    const btnDiscardAll = document.getElementById('btn-discard-all');
    if (btnDiscardAll) {
        btnDiscardAll.addEventListener('click', () => {
            pendingRequirements.length = 0;
            renderPendingRequirements();
        });
    }
}

// ── Scroll to Bottom Utility ──
// NOTE: Renamed from `scrollToBottom` to `scrollChatToBottom` to avoid a
// global-scope name collision with `scrollToBottom(el)` in modules/terminal.js,
// which loads after this file. The terminal version expected an `el` argument
// and threw "Cannot read properties of undefined (reading 'scrollTop')" when
// chat.js called the unqualified name, aborting handleChatSubmit before the
// /api/chat request could fire.
function scrollChatToBottom() {
    const container = document.getElementById('chat-messages');
    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

// ── Render Messages ──
function renderMessages() {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    container.innerHTML = chatMessages.map(msg => {
        const roleClass = msg.role === 'user' ? 'user-message' : 'assistant-message';
        const roleLabel = msg.role === 'user' ? 'You' : 'Assistant';

        // If message is still streaming, show loading skeleton
        if (msg.streaming) {
            return `
                <div class="chat-message ${roleClass}">
                    <div class="chat-message-role">${roleLabel}</div>
                    <div class="chat-message-content">
                        ${msg.content ? formatAssistantContent(msg.content) : ''}
                        <span class="loading-skeleton">
                            <span class="skeleton-dot"></span>
                            <span class="skeleton-dot"></span>
                            <span class="skeleton-dot"></span>
                        </span>
                    </div>
                </div>
            `;
        }

        // Format assistant messages with markdown-like rendering.
        // For assistant streamed output we first sanitize the <<TASK_N>> tags so the
        // browser doesn't interpret them as HTML (which produces stray "<>" artifacts
        // and resets list numbering inside each block).
        const contentHtml = msg.role === 'assistant'
            ? formatAssistantContent(sanitizeTaskTagsForDisplay(msg.content))
            : escapeHtml(msg.content);


        return `
            <div class="chat-message ${roleClass}">
                <div class="chat-message-role">${roleLabel}</div>
                <div class="chat-message-content">${contentHtml}</div>
            </div>
        `;
    }).join('');

    scrollChatToBottom();
}

// ── Sanitize <<TASK_N>> tags for display ──
/**
 * The LLM wraps each step in <<TASK_N>> ... <</TASK_N>> tags. These look like
 * unknown HTML tags to the browser when we set innerHTML, which causes:
 *   - Stray "<>" artifacts because the parser eats the unrecognized tag
 *   - Numbered lists inside each block to restart at "1" because each block
 *     becomes a separate <ol>
 *
 * This helper rewrites the markers into visible labels BEFORE markdown
 * formatting / innerHTML assignment, so the streamed preview matches the
 * structured sidebar.
 */
function sanitizeTaskTagsForDisplay(text) {
    if (!text) return '';
    return text
        // Replace opening <<TASK_N>> with a styled inline header
        .replace(/<<\s*TASK_(\d+)\s*>>/g, '\n\n**▸ Task $1**\n\n')
        // Strip closing <</TASK_N>> entirely (tolerant of whitespace / mismatched N)
        .replace(/<<\s*\/\s*TASK_\d+\s*>>/g, '');
}

// ── Format Assistant Content (basic markdown) ──
function formatAssistantContent(text) {

    if (!text) return '';

    // Extract code blocks first to protect them from formatting
    const codeBlocks = [];
    let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        const placeholder = `%%CODEBLOCK_${codeBlocks.length}%%`;
        codeBlocks.push(`<pre><code class="language-${lang || 'text'}">${escapeHtml(code.trim())}</code></pre>`);
        return placeholder;
    });

    // Convert bold (**text**)
    processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Convert italic (*text*)
    processed = processed.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Convert inline code (`code`)
    processed = processed.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Convert numbered lists
    processed = processed.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="numbered">$2</li>');
    processed = processed.replace(/((?:<li class="numbered">.*<\/li>\n?)+)/g, '<ol class="assistant-list">$1</ol>');

    // Convert bullet lists
    processed = processed.replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>');
    processed = processed.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul class="assistant-list">$1</ul>');

    // Convert paragraphs (double newlines)
    processed = processed.replace(/\n\n/g, '</p><p>');
    processed = `<p>${processed}</p>`;

    // Clean up empty paragraphs
    processed = processed.replace(/<p>\s*<\/p>/g, '');
    processed = processed.replace(/<p>\s*(<ol|<ul|<pre)/g, '$1');
    processed = processed.replace(/(<\/ol>|<\/ul>|<\/pre>)\s*<\/p>/g, '$1');

    // Restore code blocks
    processed = processed.replace(/%%CODEBLOCK_(\d+)%%/g, (_, i) => codeBlocks[parseInt(i)]);

    return processed;
}

// ── Append Message ──
function appendMessage(role, content) {
    chatMessages.push({ role, content });
    renderMessages();
}

// ── Handle Chat Submit ──
async function handleChatSubmit() {
    const chatInput = document.getElementById('chat-input');
    if (!chatInput || !selectedProjectId) return;

    const content = chatInput.value.trim();
    if (!content) return;

    // Append user message
    appendMessage('user', content);
    chatInput.value = '';

    // Call LLM streaming response
    await streamLLMResponse(content);
}

// ── Stream LLM Response ──
async function streamLLMResponse(userMessage) {
    console.log('[chat.js] streamLLMResponse called with:', userMessage);

    // Create a placeholder assistant message that we'll update as tokens stream in
    const assistantMsgIndex = chatMessages.length;
    chatMessages.push({ role: 'assistant', content: '', streaming: true });

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: userMessage,
                projectId: selectedProjectId,
                addTelegram: document.getElementById('add-telegram-toggle')?.checked || false
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        // Read SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line in buffer

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) continue;

                const jsonStr = trimmed.substring(6).trim();
                if (jsonStr === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(jsonStr);
                    if (parsed.type === 'chunk' && parsed.content) {
                        fullContent += parsed.content;
                        // Update the assistant message content in place
                        chatMessages[assistantMsgIndex].content = fullContent;
                        renderMessages();
                    } else if (parsed.type === 'error') {
                        throw new Error(parsed.error);
                    }
                } catch (e) {
                    // Skip unparseable SSE lines
                }
            }
        }

        // Mark streaming as complete
        chatMessages[assistantMsgIndex].streaming = false;
        renderMessages();
        console.log(`[chat.js] Response complete | length=${fullContent.length}`);

        // Parse structured requirements from the LLM response
        parseRequirementsFromResponse(fullContent);

    } catch (error) {
        console.error('[chat.js] Stream error:', error);
        // Update the assistant message with the error
        chatMessages[assistantMsgIndex].content = `Error: ${error.message}`;
        chatMessages[assistantMsgIndex].streaming = false;
        renderMessages();
    }
}

// ── Legacy alias for event listener binding ──
const handleChatSend = handleChatSubmit;

// ═══════════════════════════════════════════════════════════
// Regex-Based Requirement Extraction System
// ═══════════════════════════════════════════════════════════
//
// Multi-pass regex system that extracts structured metadata from LLM task blocks.
//
// Pass 1 — Block Extraction: isolate each <<TASK_N>> ... << /TASK_N>> block
// Pass 2 — Metadata Extraction: within each block, extract:
//   - stepLabel:    "Step N: Title" or "TASK N — Title"
//   - objective:    "Objective: ..." or "Objective - ..."
//   - verification: "Verification: ..." or "✅ Verification: ..."
//   - cliCommands:  code blocks marked as bash/sh
//   - files:        file path mentions
//   - agent:        auto-assigned based on complexity heuristics
//
// Grep-friendly regex patterns:
//   Task Block:     <<TASK_(\d+)>>([\s\S]*?)<<\s*/TASK_\1>>
//   Step Label:     ^(Step \d+: |TASK \d+ — )(.+)$
//   Objective:      ^Objective[:\-] (.+)$
//   Verification:   ^✅? Verification[:\-] (.+)$
//   CLI Commands:   ```bash\n(...)\```
//   File Paths:     (src|app|lib|components|pages|api|config)/\w+.\w+

// Pass 1: Main task block extraction (strict — requires matching N in open/close tags)
const TASK_BLOCK_REGEX = /<<TASK_(\d+)>>([\s\S]*?)<<\s*\/TASK_\1>>/g;

// Fallback Pass 1: tolerant block extraction — used when strict pass finds nothing.
// Handles malformed cases where:
//   - Closing tag has stray whitespace inside (e.g. <</TASK_1 >>)
//   - Closing tag number doesn't match opening (e.g. <<TASK_1>>...<</TASK_2>>)
//   - Closing tag is missing entirely (block ends at next <<TASK_ or EOF)
const TASK_BLOCK_FALLBACK_REGEX = /<<\s*TASK_(\d+)\s*>>([\s\S]*?)(?=<<\s*\/?\s*TASK_\d+\s*>>|$)/g;


// Pass 2: Metadata patterns applied to each block's content
const METADATA_PATTERNS = {
    // Match "Step 3: Database Schema" or "TASK 1 — Tech Stack" patterns
    stepLabel: /^(?:Step\s*\d+[:\.]\s*|TASK\s*\d+\s*[—:]\s*)(.+)$/im,

    // Match "Objective: build the API" or "Objective - build the API"
    objective: /^Objective[:\-]\s*(.+)$/im,

    // Match "✅ Verification: ..." or "Verification: ..."
    verification: /^✅?\s*Verification[:\-]\s*(.+)$/im,

    // Match bash/sh code blocks for CLI commands
    cliCommands: /```(?:bash|sh|zsh)?\s*\n([\s\S]*?)```/g,

    // Match file paths like `src/components/App.tsx` or "config/database.js"
    filePaths: /[`"'"]?((?:src|app|lib|components|pages|api|config|routes|models|utils|test|public|assets)[\w\/.-]+\.\w+)[`"'"]?/g
};

/**
 * Extract structured metadata from a single task block's raw text.
 * @param {string} rawText - The full text content inside a <<TASK_N>> block
 * @param {number} taskNumber - The sequential task number
 * @returns {object} Structured requirement object
 */
function extractTaskMetadata(rawText, taskNumber) {
    const metadata = {
        number: taskNumber,
        prompt: rawText,           // Full text as the pipeline prompt
        stepLabel: '',
        objective: '',
        verification: '',
        cliCommands: [],
        files: [],
        selected: true,
        agent: 'cline'             // Default agent
    };

    // Extract step label
    const stepMatch = rawText.match(METADATA_PATTERNS.stepLabel);
    if (stepMatch) {
        metadata.stepLabel = stepMatch[1].trim();
    }

    // Extract objective
    const objMatch = rawText.match(METADATA_PATTERNS.objective);
    if (objMatch) {
        metadata.objective = objMatch[1].trim();
    }

    // Extract verification
    const verifyMatch = rawText.match(METADATA_PATTERNS.verification);
    if (verifyMatch) {
        metadata.verification = verifyMatch[1].trim();
    }

    // Extract CLI commands
    let cliMatch;
    const cliCmdRegex = new RegExp(METADATA_PATTERNS.cliCommands.source, METADATA_PATTERNS.cliCommands.flags);
    while ((cliMatch = cliCmdRegex.exec(rawText)) !== null) {
        const cmds = cliMatch[1].trim().split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));
        metadata.cliCommands.push(...cmds.map(c => c.trim()));
    }

    // Extract file paths
    let fileMatch;
    const fileRegex = new RegExp(METADATA_PATTERNS.filePaths.source, METADATA_PATTERNS.filePaths.flags);
    const fileSet = new Set();
    while ((fileMatch = fileRegex.exec(rawText)) !== null) {
        fileSet.add(fileMatch[1]);
    }
    metadata.files = Array.from(fileSet);

    // Auto-assign agent based on complexity heuristics:
    // - Telegram message tasks -> telegram agent
    // - Tasks with many file paths or CLI commands -> cline (more capable)
    // - Simple single-file tasks -> aider (faster)
    if (rawText.match(/^Telegram Message:/im)) {
        metadata.agent = 'telegram';
    } else if (metadata.files.length <= 1 && metadata.cliCommands.length === 0 && rawText.length < 500) {
        metadata.agent = 'aider';
    } else {
        metadata.agent = 'cline';
    }

    // Build a display label for the sidebar
    metadata.displayText = metadata.stepLabel
        ? `${metadata.stepLabel}`
        : `Task ${taskNumber}`;

    return metadata;
}

// ── Parse Requirements from LLM Response ──
/**
 * Extracts structured tasks from the LLM response using a multi-pass regex system.
 *
 * The backend system prompt instructs the LLM to wrap each task in <<TASK_N>> / << /TASK_N>> tags.
 * This function:
 *   1. Extracts each tagged block (Pass 1)
 *   2. Runs metadata regex patterns on each block (Pass 2)
 *   3. Populates the requirements sidebar with structured data
 *
 * Regex patterns used:
 *   - Block:         <<TASK_(\d+)>>([\s\S]*?)<< /TASK_\1>>
 *   - Step Label:    ^(Step \d+: |TASK \d+ — )(.+)$
 *   - Objective:     ^Objective[:\-] (.+)$
 *   - Verification:  ^✅? Verification[:\-] (.+)$
 *   - CLI Commands:  ```bash\n(...)\```
 *   - File Paths:    (src|app|lib|...)/\w+.\w+
 */
function parseRequirementsFromResponse(fullContent) {
    // Pass 1 (strict): Extract all <<TASK_N>>...<</TASK_N>> blocks with matching N
    const tasks = [];
    let match;
    // Reset lastIndex in case the regex was used previously
    TASK_BLOCK_REGEX.lastIndex = 0;

    while ((match = TASK_BLOCK_REGEX.exec(fullContent)) !== null) {
        const taskNumber = parseInt(match[1], 10);
        const rawContent = match[2].trim();
        if (rawContent) {
            // Pass 2: Extract structured metadata from each block
            const metadata = extractTaskMetadata(rawContent, taskNumber);
            tasks.push(metadata);
        }
    }

    // ── Fallback Pass 1: tolerant parser for malformed tag pairs ──
    // If the strict regex found nothing (or found suspiciously few blocks compared to
    // the number of opening tags), retry with the tolerant parser that handles
    // mismatched N values, stray whitespace in closers, and missing close tags.
    const openTagCount = (fullContent.match(/<<\s*TASK_\d+\s*>>/g) || []).length;
    if (tasks.length === 0 || tasks.length < openTagCount) {
        const seen = new Set(tasks.map(t => t.number));
        TASK_BLOCK_FALLBACK_REGEX.lastIndex = 0;
        let fbMatch;
        while ((fbMatch = TASK_BLOCK_FALLBACK_REGEX.exec(fullContent)) !== null) {
            const taskNumber = parseInt(fbMatch[1], 10);
            if (seen.has(taskNumber)) continue;
            // Strip any trailing close-tag fragments that the tolerant lookahead might leave behind
            const rawContent = fbMatch[2]
                .replace(/<<\s*\/?\s*TASK_\d+\s*>>\s*$/g, '')
                .trim();
            if (rawContent) {
                const metadata = extractTaskMetadata(rawContent, taskNumber);
                tasks.push(metadata);
                seen.add(taskNumber);
            }
        }
        if (tasks.length > 0 && openTagCount > 0) {
            console.warn(`[chat.js] Strict parser missed blocks; fallback parser recovered ${tasks.length} of ${openTagCount} task block(s).`);
        }
    }

    if (tasks.length > 0) {

        // Sort by task number to ensure correct order
        tasks.sort((a, b) => a.number - b.number);

        console.log(`[chat.js] Parsed ${tasks.length} tasks from response`);
        console.log(`[chat.js] Task metadata:`, tasks.map(t => ({
            num: t.number,
            label: t.stepLabel,
            agent: t.agent,
            files: t.files.length,
            cmds: t.cliCommands.length
        })));

        // ── Apply global default-agent override ──
        // If the user picked something other than "auto" in the Agent dropdown, force
        // every non-telegram task to use the selected agent (telegram tasks always
        // stay as the telegram agent since they require a Telegram Message body).
        const defaultAgent = document.getElementById('default-agent-select')?.value || 'auto';
        if (defaultAgent && defaultAgent !== 'auto') {
            tasks.forEach(task => {
                if (task.agent !== 'telegram') {
                    task.agent = defaultAgent;
                }
            });
            console.log(`[chat.js] Applied default-agent override "${defaultAgent}" to ${tasks.length} task(s).`);
        }

        // Clear any previous pending requirements and add new ones
        pendingRequirements.length = 0;
        tasks.forEach(task => {
            pendingRequirements.push(task);
        });
        renderPendingRequirements();
        return;

    }

    console.log('[chat.js] No tagged tasks found in response');
}

// ── Add Requirements to Pipeline ──
/**
 * Takes selected requirements from the chat sidebar and appends them
 * as new tasks in the selected project's pipeline.
 *
 * @param {string} projectId - The target project ID
 * @param {Array}  requirements - Array of structured requirement objects
 */
async function addToPipeline(projectId, requirements) {
    if (!projectId) {
        alert('No project selected');
        return;
    }

    const btnAdd = document.getElementById('btn-add-to-pipeline');
    if (btnAdd) {
        btnAdd.disabled = true;
        btnAdd.textContent = '⏳ Adding...';
    }

    try {
        // Fetch current pipeline tasks
        const res = await fetch(`/api/project/${projectId}/tasks`);
        if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);

        const data = await res.json();
        const existingTasks = data.tasks || [];

        // Map requirements to pipeline task format
        const newTasks = requirements.map((req, i) => ({
            id: existingTasks.length + i,
            prompt: req.prompt,
            state: 'pending',
            orchestrate: true,    // Auto-chain enabled for seamless execution
            agent: req.agent || 'cline'
        }));

        // Append to existing tasks
        const merged = [...existingTasks, ...newTasks];

        // Save updated task list
        const saveRes = await fetch(`/api/project/${projectId}/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tasks: merged })
        });

        if (!saveRes.ok) throw new Error(`Failed to save tasks: ${saveRes.status}`);

        console.log(`[chat.js] Successfully added ${newTasks.length} tasks to pipeline for project ${projectId}`);

        // Visual feedback
        if (btnAdd) {
            btnAdd.textContent = '✓ Added!';
            btnAdd.style.color = '#4caf50';
        }

        // Clear pending requirements after successful add
        pendingRequirements.length = 0;
        renderPendingRequirements();

        // Trigger pipeline reload if Pipeline tab exists
        if (window.loadPipeline) {
            // Set the active project ID so loadPipeline picks it up
            window.activeProjectId = projectId;
            await window.loadPipeline();
        }

        // Reset button after delay
        setTimeout(() => {
            if (btnAdd) {
                btnAdd.textContent = '+ Add to Pipeline';
                btnAdd.style.color = '';
                btnAdd.disabled = false;
            }
        }, 2000);

    } catch (error) {
        console.error('[chat.js] Error adding to pipeline:', error);
        alert(`Error adding to pipeline: ${error.message}`);

        if (btnAdd) {
            btnAdd.disabled = false;
            btnAdd.textContent = '+ Add to Pipeline';
            btnAdd.style.color = '';
        }
    }
}

// ── Render Pending Requirements ──
function renderPendingRequirements() {
    const list = document.getElementById('requirements-list');
    const btnAdd = document.getElementById('btn-add-to-pipeline');
    if (!list) return;

    if (pendingRequirements.length === 0) {
        list.innerHTML = '<p style="color: #999; font-size: 0.85rem; text-align: center;">No requirements extracted yet.</p>';
        if (btnAdd) btnAdd.disabled = true;
        return;
    }

    // Available agents for the per-task dropdown
    const AGENT_OPTIONS = [
        { value: 'aider', label: 'Aider' },
        { value: 'cline', label: 'Cline' },
        { value: 'baton-code', label: 'Baton Code' },
        { value: 'baton-code-thinking', label: 'Baton Code (Thinking)' },
        { value: 'telegram', label: 'Telegram' }
    ];

    list.innerHTML = pendingRequirements.map((req, i) => {
        // Build supplementary metadata badges (file / cli counts)
        const badges = [];
        if (req.files && req.files.length > 0) {
            badges.push(`<span class="req-badge file-badge" title="Files: ${req.files.join(', ')}">📁 ${req.files.length}</span>`);
        }
        if (req.cliCommands && req.cliCommands.length > 0) {
            badges.push(`<span class="req-badge cmd-badge" title="CLI Commands">⌨ ${req.cliCommands.length}</span>`);
        }

        // Per-task agent dropdown — lets the user override the auto-assigned agent
        const agentOptionsHtml = AGENT_OPTIONS.map(opt =>
            `<option value="${opt.value}" ${opt.value === req.agent ? 'selected' : ''}>${opt.label}</option>`
        ).join('');
        const agentSelectHtml = `
            <select class="req-agent-select" data-index="${i}" title="Change agent for this task">
                ${agentOptionsHtml}
            </select>
        `;

        // Display text: use stepLabel if available, fallback to numbered task
        const displayText = req.displayText || `Task ${req.number}`;
        const objectivePreview = req.objective
            ? `<div class="req-objective" title="${escapeHtml(req.objective)}">${escapeHtml(req.objective.substring(0, 80))}${req.objective.length > 80 ? '...' : ''}</div>`
            : '';

        return `
            <div class="requirement-item ${req.selected ? 'selected' : ''}" data-index="${i}">
                <input type="checkbox" ${req.selected ? 'checked' : ''} data-index="${i}">
                <div class="req-content">
                    <div class="req-header">
                        <span class="req-title">${escapeHtml(displayText)}</span>
                        <div class="req-badges">${agentSelectHtml}${badges.join('')}</div>
                    </div>
                    ${objectivePreview}
                </div>
            </div>
        `;
    }).join('');

    // Bind checkbox change events
    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.index);
            pendingRequirements[idx].selected = e.target.checked;
            // Update parent class
            e.target.closest('.requirement-item')?.classList.toggle('selected', e.target.checked);
            // Enable/disable add button
            const hasSelected = pendingRequirements.some(r => r.selected);
            if (btnAdd) btnAdd.disabled = !hasSelected;
        });
    });

    // Bind per-task agent dropdown change events
    list.querySelectorAll('.req-agent-select').forEach(sel => {
        sel.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.index);
            pendingRequirements[idx].agent = e.target.value;
            console.log(`[chat.js] Task ${idx} agent changed to "${e.target.value}"`);
        });
        // Stop the click from bubbling up to the row's checkbox toggle
        sel.addEventListener('click', (e) => e.stopPropagation());
    });


    // Enable/disable add button
    if (btnAdd) {
        const hasSelected = pendingRequirements.some(r => r.selected);
        btnAdd.disabled = !hasSelected;
        btnAdd.textContent = '+ Add to Pipeline';
        btnAdd.style.color = '';
    }
}

// ── DOMContentLoaded Initialization ──
document.addEventListener('DOMContentLoaded', () => {
    console.log('[chat.js] Chat module loaded');
    bindChatEventListeners();
    // Don't populate on load — wait for tab activation via loadChat()
});

// ── Expose on window so core.js openTab() can call it ──
window.loadChat = loadChat;
