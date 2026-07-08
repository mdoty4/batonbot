/* ═══════════════════════════════════════════
   Micro Agents — Micro-agent logic
   ═══════════════════════════════════════════ */

/* Cross-platform process tree killer. On Windows, child processes spawned
   through cmd.exe (shell: true) live as grandchildren — a plain
   child.kill('SIGTERM') leaves them orphaned. tree-kill walks the OS
   process tree and reliably terminates every descendant on all platforms. */
const _treeKill = require('tree-kill');
function killTree(child, signal = 'SIGTERM') {
  if (!child || child.killed || !child.pid) return;
  try { _treeKill(child.pid, signal); }
  catch (_) { try { child.kill(signal); } catch (__) {} }
}

/* ── LM Studio default fallback ──
   Empty/undefined apiBase values fall back to LM Studio's default endpoint.
   This mirrors how the Cline agent already treats an empty apiBase as
   "use LM Studio" so that Baton Code / Baton Code Thinking / chat behave
   consistently with the same global config. */
const LM_STUDIO_DEFAULT_URL = 'http://localhost:1234/v1';
function resolveApiBase(apiBase) {
  const trimmed = (apiBase || '').trim();
  return trimmed || LM_STUDIO_DEFAULT_URL;
}


/**
 * callLLM — Helper that sends a messages array to the BatonBot /api/chat
 * endpoint and returns the full LLM response as a string.
 *
 * Reuses the same OpenAI-compatible API format BatonBot already proxies.
 * The /api/chat endpoint handles: reading LLM config (apiBase, apiKey, model),
 * forwarding to the upstream chat/completions endpoint, and streaming back SSE.
 *
 * @param {Array<{role: string, content: string}>} messages — Chat messages array
 * @param {Object} [config] — Optional override config
 * @param {string} [config.projectId] — Project ID to use for LLM config lookup
 * @param {number} [config.timeout] — Request timeout in ms (default: 300000)
 * @returns {Promise<string>} The full LLM response text
 */
async function callLLM(messages, config = {}) {
  const { projectId, timeout = 300000 } = config;

  const lastMessage = messages[messages.length - 1];
  const body = {
    message: lastMessage?.content || '',
    messages: messages,
    projectId: projectId || null
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${errorBody}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === 'data: [DONE]' || trimmed === '[DONE]') {
          return fullText;
        }

        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.substring(6).trim();
          if (jsonStr === '[DONE]') {
            return fullText;
          }

          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.type === 'chunk' && parsed.content) {
              fullText += parsed.content;
            } else if (parsed.type === 'error') {
              throw new Error(`LLM stream error: ${parsed.error}`);
            }
          } catch (e) {
            if (e.message?.includes('LLM stream error')) {
              throw e;
            }
          }
        }
      }
    }

    return fullText;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * callLLMStream — Same as callLLM but yields chunks via a callback
 * for real-time UI updates.
 *
 * @param {Array<{role: string, content: string}>} messages — Chat messages array
 * @param {Object} [config] — Configuration options
 * @param {string} [config.projectId] — Project ID for LLM config lookup
 * @param {number} [config.timeout] — Request timeout in ms
 * @param {Function} [config.onChunk] — Callback called with each content chunk
 * @param {Function} [config.onDone] — Callback called when stream ends (receives full text)
 * @param {Function} [config.onError] — Callback called on error
 * @returns {Promise<string>} The full LLM response text
 */
async function callLLMStream(messages, config = {}) {
  const { projectId, timeout = 300000, onChunk, onDone, onError } = config;

  const lastMessage = messages[messages.length - 1];
  const body = {
    message: lastMessage?.content || '',
    messages: messages,
    projectId: projectId || null
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const err = new Error(`LLM request failed (${response.status}): ${errorBody}`);
      onError?.(err);
      throw err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === 'data: [DONE]' || trimmed === '[DONE]') {
          onDone?.(fullText);
          return fullText;
        }

        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.substring(6).trim();
          if (jsonStr === '[DONE]') {
            onDone?.(fullText);
            return fullText;
          }

          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.type === 'chunk' && parsed.content) {
              fullText += parsed.content;
              onChunk?.(parsed.content, fullText);
            } else if (parsed.type === 'error') {
              const err = new Error(`LLM stream error: ${parsed.error}`);
              onError?.(err);
              throw err;
            }
          } catch (e) {
            if (e.message?.includes('LLM stream error')) {
              throw e;
            }
          }
        }
      }
    }

    onDone?.(fullText);
    return fullText;
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════
   MCP (Model Context Protocol) Server Support
   ═══════════════════════════════════════════ */

/**
 * MCP Tools Registry — Holds dynamically discovered tools from connected MCP servers.
 *
 * McpTool interface:
 *   {
 *     name: string,            // Tool name (e.g., "git_commit")
 *     description: string,     // Human-readable description
 *     parameters: object,      // JSON Schema object for tool parameters
 *     serverName: string,      // Name of the MCP server that provides this tool
 *     execute: function        // Async function(args) -> Promise<string>
 *   }
 *
 * mcpServers — Map of serverName -> server metadata
 *   {
 *     name: string,
 *     transport: 'stdio' | 'sse',
 *     command?: string,        // For stdio: command to spawn
 *     args?: string[],         // For stdio: command arguments
 *     url?: string,            // For SSE: server URL
 *     status: 'connected' | 'disconnected' | 'connecting',
 *     tools: McpTool[],        // Tools discovered from this server
 *     process?: ChildProcess,  // For stdio: the spawned process
 *     connectedAt?: string     // ISO timestamp when connected
 *   }
 */

// Array holding all MCP tools from connected servers
let mcpTools = [];

// Map of serverName -> server metadata
const mcpServers = new Map();

/**
 * registerMcpTool — Add an MCP tool to the registry.
 * Called when an MCP server connects and advertises its tools.
 *
 * @param {Object} mcpTool - The MCP tool definition
 * @param {string} mcpTool.name - Tool name
 * @param {string} mcpTool.description - Tool description
 * @param {Object} mcpTool.parameters - JSON Schema parameters
 * @param {string} mcpTool.serverName - Name of the MCP server
 * @param {Function} mcpTool.execute - Async function that executes the tool
 */
function registerMcpTool(mcpTool) {
  if (!mcpTool || !mcpTool.name || !mcpTool.serverName || !mcpTool.execute) {
    throw new Error('registerMcpTool requires name, serverName, and execute function');
  }
  // Remove any existing tool with the same name from the same server
  mcpTools = mcpTools.filter(t => !(t.name === mcpTool.name && t.serverName === mcpTool.serverName));
  mcpTools.push(mcpTool);
  console.log(`[MCP] Registered tool "${mcpTool.name}" from server "${mcpTool.serverName}"`);
}

/**
 * unregisterMcpServerTools — Remove all tools from a specific MCP server.
 * Called when an MCP server disconnects.
 *
 * @param {string} serverName - Name of the MCP server
 */
function unregisterMcpServerTools(serverName) {
  const before = mcpTools.length;
  mcpTools = mcpTools.filter(t => t.serverName !== serverName);
  const removed = before - mcpTools.length;
  if (removed > 0) {
    console.log(`[MCP] Unregistered ${removed} tool(s) from server "${serverName}"`);
  }
}

/**
 * buildMcpToolDefinitions — Convert MCP tools to OpenAI-format tool definitions.
 *
 * @returns {Array} OpenAI-format tool definitions for all registered MCP tools
 */
function buildMcpToolDefinitions() {
  return mcpTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || `MCP tool from ${tool.serverName}`,
      parameters: tool.parameters || {
        type: 'object',
        properties: {}
      }
    }
  }));
}

/**
 * getAvailableMcpServers — Return the list of configured MCP servers and their status.
 *
 * @returns {Array} Array of server info objects
 */
function getAvailableMcpServers() {
  const result = [];
  for (const [name, server] of mcpServers) {
    result.push({
      name: server.name,
      transport: server.transport,
      status: server.status,
      toolCount: (server.tools || []).length,
      toolNames: (server.tools || []).map(t => t.name),
      connectedAt: server.connectedAt,
      command: server.command,
      args: server.args,
      url: server.url
    });
  }
  return result;
}

/**
 * getMcpServer — Get metadata for a specific MCP server.
 *
 * @param {string} serverName - Name of the MCP server
 * @returns {Object|undefined} Server metadata or undefined
 */
function getMcpServer(serverName) {
  return mcpServers.get(serverName);
}

/**
 * setMcpServer — Set/update metadata for an MCP server.
 *
 * @param {string} serverName - Name of the MCP server
 * @param {Object} metadata - Server metadata
 */
function setMcpServer(serverName, metadata) {
  mcpServers.set(serverName, metadata);
}

/**
 * findMcpTool — Look up an MCP tool by name.
 *
 * @param {string} toolName - Name of the tool
 * @returns {Object|undefined} The MCP tool or undefined
 */
function findMcpTool(toolName) {
  return mcpTools.find(t => t.name === toolName);
}

/* ═══════════════════════════════════════════
   Tools Registry
   ═══════════════════════════════════════════ */

/**
 * TOOLS — Registry of available tools that micro-agents can invoke.
 * Each tool has a name, description, parameters schema, and an execute function.
 *
 * execute(toolName, args, cwd) -> Promise<string> | string
 */
const TOOLS = {
  callLLM: {
    description: 'Send a messages array to the LLM and return the response.',
    execute: async (args, cwd) => {
      const { messages, config } = args || {};
      if (!messages || !Array.isArray(messages)) {
        throw new Error('callLLM requires a "messages" array in args');
      }
      return await callLLM(messages, config);
    }
  },
  callLLMStream: {
    description: 'Send a messages array to the LLM and stream chunks via callbacks.',
    execute: async (args, cwd) => {
      const { messages, config } = args || {};
      if (!messages || !Array.isArray(messages)) {
        throw new Error('callLLMStream requires a "messages" array in args');
      }
      return await callLLMStream(messages, config);
    }
  },
  write_to_file: {
    description: 'Write content to a file. Creates the file if it does not exist, or overwrites it if it does. Parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file path to write to (relative to the working directory)'
        },
        content: {
          type: 'string',
          description: 'The full content to write to the file'
        }
      },
      required: ['path', 'content']
    },
    execute: async (args, cwd) => {
      const fs = require('fs');
      const path = require('path');
      const { path: filePath, content } = args || {};
      if (!filePath) throw new Error('write_to_file requires a "path" argument');
      if (content === undefined || content === null) throw new Error('write_to_file requires a "content" argument');

      const fullPath = path.resolve(cwd, filePath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, content, 'utf8');
      return `File written successfully: ${filePath} (${Buffer.byteLength(content, 'utf8')} bytes)`;
    }
  },
  read_file: {
    description: 'Read the contents of a file at the specified path. Returns the text content of the file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file path to read (relative to the working directory)'
        },
        start_line: {
          type: 'number',
          description: 'Optional: 1-based line number to start reading from (inclusive)'
        },
        end_line: {
          type: 'number',
          description: 'Optional: 1-based line number to stop reading at (inclusive)'
        }
      },
      required: ['path']
    },
    execute: async (args, cwd) => {
      const fs = require('fs');
      const path = require('path');
      const { path: filePath, start_line, end_line } = args || {};
      if (!filePath) throw new Error('read_file requires a "path" argument');

      const fullPath = path.resolve(cwd, filePath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      let content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');

      if (start_line !== undefined || end_line !== undefined) {
        const start = Math.max(0, (start_line || 1) - 1);
        const end = end_line !== undefined ? end_line : lines.length;
        return lines.slice(start, end).join('\n');
      }

      return content;
    }
  },
  replace_in_file: {
    description: 'Replace specific sections of content in an existing file using SEARCH/REPLACE blocks. Each block defines exact text to find and its replacement.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file path to modify (relative to the working directory)'
        },
        diff: {
          type: 'string',
          description: 'One or more SEARCH/REPLACE blocks in the format:\n------- SEARCH\n[exact content to find]\n=======\n[new content to replace with]\n+++++++ REPLACE'
        }
      },
      required: ['path', 'diff']
    },
    execute: async (args, cwd) => {
      const fs = require('fs');
      const path = require('path');
      const { path: filePath, diff } = args || {};
      if (!filePath) throw new Error('replace_in_file requires a "path" argument');
      if (!diff) throw new Error('replace_in_file requires a "diff" argument');

      const fullPath = path.resolve(cwd, filePath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${filePath}. Use write_to_file to create it first.`);
      }

      let content = fs.readFileSync(fullPath, 'utf8');

      // Helper to strip line labels (e.g., "42 | ") from text
      // Handles cases where agents accidentally include line numbers from read_file output
      const stripLineLabels = (text) => text.replace(/^\d+\|\s*/gm, '');

      // Parse SEARCH/REPLACE blocks
      const blockRegex = /------- SEARCH\n([\s\S]*?)=======\n([\s\S]*?)\+\+\+\+\+\+\+ REPLACE/g;
      const changes = [];
      let match;
      let replacementsMade = 0;

      while ((match = blockRegex.exec(diff)) !== null) {
        const searchStr = match[1];
        const replaceStr = match[2];

        let idx = -1;
        let textToReplace = searchStr;

        // Try direct search first (fastest path)
        idx = content.indexOf(searchStr);

        if (idx === -1) {
          // Try normalized search — strips line labels from both search and content
          // to handle cases where the agent copied text that includes line numbers
          const normalizedContent = stripLineLabels(content);
          const normalizedSearch = stripLineLabels(searchStr);
          const normIdx = normalizedContent.indexOf(normalizedSearch);

          if (normIdx !== -1) {
            // Match found in normalized content; map back to original content
            const normLines = normalizedContent.split('\n');
            const origLines = content.split('\n');
            const searchLinesArr = normalizedSearch.split('\n');

            // Find starting line index in normalized content
            let startLine = 0;
            let charPos = 0;
            for (let i = 0; i < normLines.length; i++) {
              if (charPos + normLines[i].length >= normIdx) {
                startLine = i;
                break;
              }
              charPos += normLines[i].length + 1; // +1 for newline
            }

            const numLines = searchLinesArr.length;
            textToReplace = origLines.slice(startLine, startLine + numLines).join('\n');
            idx = content.indexOf(textToReplace);
          }
        }

        if (idx !== -1) {
          content = content.substring(0, idx) + replaceStr + content.substring(idx + textToReplace.length);
          replacementsMade++;
          changes.push(`Replaced block ${replacementsMade} successfully`);
        } else {
          // Enhanced error handling with closest match detection
          const searchLines = searchStr.split('\n');
          const firstFewLines = searchLines.slice(0, Math.min(3, searchLines.length));
          const contentLines = content.split('\n');

          let closestMatch = null;
          let closestDistance = Infinity;
          for (let i = 0; i < contentLines.length; i++) {
            for (const searchLine of firstFewLines) {
              const trimmedSearch = searchLine.trim();
              const trimmedContent = contentLines[i].trim();
              if (trimmedContent.includes(trimmedSearch) || trimmedSearch.includes(trimmedContent)) {
                // Simple similarity: count common words
                const searchWords = new Set(trimmedSearch.split(/\s+/));
                const contentWords = new Set(trimmedContent.split(/\s+/));
                let common = 0;
                for (const w of searchWords) {
                  if (contentWords.has(w)) common++;
                }
                const distance = searchWords.size + contentWords.size - 2 * common;
                if (distance < closestDistance) {
                  closestDistance = distance;
                  closestMatch = { line: i + 1, content: contentLines[i] };
                }
              }
            }
          }

          let errorMsg = `SEARCH block ${replacementsMade + 1} not found in file ${filePath}.\n`;
          errorMsg += `The search text must match the file content EXACTLY, including whitespace and indentation.\n`;
          errorMsg += `\nSearch text preview (first 3 lines):\n`;
          for (const line of firstFewLines) {
            errorMsg += `  | ${line}\n`;
          }
          if (closestMatch) {
            errorMsg += `\nClosest match found at line ${closestMatch.line}:\n`;
            errorMsg += `  | ${closestMatch.content}\n`;
            errorMsg += `\nUse read_file to get the exact current content, then retry with the correct SEARCH text.`;
          }
          throw new Error(errorMsg);
        }
      }

      if (replacementsMade === 0) {
        throw new Error(`No valid SEARCH/REPLACE blocks found in the diff input.`);
      }

      fs.writeFileSync(fullPath, content, 'utf8');
      return `File modified successfully: ${filePath} (${replacementsMade} replacement(s) made)`;
    }
  },
  list_files: {
    description: 'List files and directories within the specified directory. Supports recursive listing. Automatically excludes common noise directories (.git, node_modules, dist, build, etc.).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The directory path to list (relative to the working directory). Use "." for the working directory.'
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to list files recursively. Default: false'
        }
      },
      required: ['path']
    },
    execute: async (args, cwd) => {
      const fs = require('fs');
      const path = require('path');
      const { path: dirPath, recursive = false } = args || {};
      if (!dirPath) throw new Error('list_files requires a "path" argument');

      const fullPath = path.resolve(cwd, dirPath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Directory not found: ${dirPath}`);
      }

       // Directories and files to skip (reduces noise and prevents context overflow)
       const LIST_FILES_IGNORE_DIRS = new Set([
         'node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.nuxt',
         '.cache', 'coverage', '.vscode', '.idea', 'vendor', 'target', '.turbo'
       ]);
       const LIST_FILES_IGNORE_FILES = new Set([
         '.DS_Store', 'Thumbs.db'
       ]);
       // Cap output to prevent context overflow from massive directories
       const MAX_LIST_ITEMS = 2000;

       const listDir = (dir, prefix = '', depth = 0, maxDepth = 5) => {
         // Enforce depth limit to prevent exploring extremely deep trees
         if (depth > maxDepth) return [];

         const entries = fs.readdirSync(dir, { withFileTypes: true });
         const items = [];
         for (const entry of entries) {
           const name = entry.name;
           // Skip ignored directories (e.g. .git, node_modules) at ALL depths
           if (entry.isDirectory() && LIST_FILES_IGNORE_DIRS.has(name)) continue;
           // Skip ignored files
           if (entry.isFile() && LIST_FILES_IGNORE_FILES.has(name)) continue;
           // Skip dotfiles/dotdirs (hidden files) at top level only
           if (prefix === '' && name.startsWith('.')) continue;

           const itemPath = prefix + name;
           items.push(itemPath + (entry.isDirectory() ? '/' : ''));
           // Stop early if we've hit the item cap
           if (items.length >= MAX_LIST_ITEMS) return items;
           if (entry.isDirectory() && recursive) {
             items.push(...listDir(path.join(dir, entry.name), itemPath + '/', depth + 1, maxDepth));
             if (items.length >= MAX_LIST_ITEMS) return items;
           }
         }
         return items;
       };

       const items = listDir(fullPath);
      return items.length > 0 ? items.join('\n') : '(empty directory)';
    }
  },
  search_files: {
    description: 'Perform a regex search across files in a directory. Returns matching lines with context.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The directory path to search in (relative to the working directory)'
        },
        regex: {
          type: 'string',
          description: 'The regular expression pattern to search for'
        },
        file_pattern: {
          type: 'string',
          description: 'Optional glob pattern to filter files (e.g., "*.js", "*.ts")'
        }
      },
      required: ['path', 'regex']
    },
    execute: async (args, cwd) => {
      const fs = require('fs');
      const path = require('path');
      const { path: dirPath, regex, file_pattern } = args || {};
      if (!dirPath) throw new Error('search_files requires a "path" argument');
      if (!regex) throw new Error('search_files requires a "regex" argument');

      const fullPath = path.resolve(cwd, dirPath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Directory not found: ${dirPath}`);
      }

      const pattern = new RegExp(regex);
      const results = [];
      const MAX_SEARCH_RESULTS = 100;
      let searchStopped = false;

      const searchDir = (dir) => {
        if (searchStopped) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            searchDir(entryPath);
            if (searchStopped) return;
          } else if (entry.isFile()) {
            if (file_pattern) {
              const minimatch = (str, pat) => {
                // Simple glob matching
                const regex_pat = '^' + pat.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
                return new RegExp(regex_pat).test(str);
              };
              if (!minimatch(entry.name, file_pattern)) continue;
            }
            try {
              const content = fs.readFileSync(entryPath, 'utf8');
              const lines = content.split('\n');
              const relPath = path.relative(fullPath, entryPath);
              lines.forEach((line, idx) => {
                if (searchStopped) return;
                if (pattern.test(line)) {
                  if (results.length >= MAX_SEARCH_RESULTS) {
                    searchStopped = true;
                    return;
                  }
                  const contextBefore = lines.slice(Math.max(0, idx - 2), idx)
                    .map((l, i) => `${Math.max(0, idx - 2) + i + 1}|${l}`)
                    .join('\n');
                  const matchLine = `${idx + 1}|${line}`;
                  const contextAfter = lines.slice(idx + 1, Math.min(lines.length, idx + 3))
                    .map((l, i) => `${idx + 2 + i}|${l}`)
                    .join('\n');
                  let result = `## ${relPath}\n`;
                  if (contextBefore) result += `${contextBefore}\n`;
                  result += `> ${matchLine}\n`;
                  if (contextAfter) result += `${contextAfter}\n`;
                  result += '\n';
                  results.push(result);
                }
              });
            } catch (e) {
              // Skip binary or unreadable files
            }
          }
        }
      };

      searchDir(fullPath);
      if (results.length === 0) return '(no matches found)';
      const summary = `Found ${results.length} match(es) for "${regex}" in ${dirPath}:\n\n`;
      return summary + results.join('---\n');
    }
  },
  list_code_definition_names: {
    description: 'List top-level source code definitions (classes, functions, methods, interfaces, types, const/let/var exports, module exports) found in files at the top level of a specified directory. Supports JS/JSX, TS/TSX, Python, Go, and Rust. Skips node_modules, .git, dist, build, __pycache__, and binary files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The directory path to scan (relative to the working directory). Use "." for the working directory.'
        },
        file_pattern: {
          type: 'string',
          description: 'Optional glob pattern to filter files (e.g., "*.ts", "*.py"). If omitted, all supported languages are scanned.'
        }
      },
      required: ['path']
    },
    execute: async (args, cwd) => {
      const fs = require('fs');
      const pathMod = require('path');
      const { path: dirPath, file_pattern } = args || {};
      if (!dirPath) throw new Error('list_code_definition_names requires a "path" argument');

      const fullPath = pathMod.resolve(cwd, dirPath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Directory not found: ${dirPath}`);
      }
      if (!fs.statSync(fullPath).isDirectory()) {
        throw new Error(`Not a directory: ${dirPath}`);
      }

      // Directories to skip
      const IGNORE_DIRS = new Set([
        'node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.nuxt',
        '.cache', 'coverage', '.vscode', '.idea', 'vendor', 'target', '.turbo'
      ]);

      // Supported file extensions
      const SUPPORTED_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs']);

      // Simple glob matching for file_pattern
      const matchesGlob = (filename, pat) => {
        if (!pat) return true;
        const regexPat = '^' + pat.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
        return new RegExp(regexPat).test(filename);
      };

      // Regex patterns per language for extracting top-level definitions
      const PATTERNS = {
        // JavaScript / JSX
        js: [
          { re: /^export\s+default\s+class\s+(\w+)/, type: 'class' },
          { re: /^export\s+default\s+function\s+(\w+)/, type: 'function' },
          { re: /^export\s+default\s+function\s+\*\s+(\w+)/, type: 'async_function' },
          { re: /^export\s+(?:async\s+)?function\s+(\w+)/, type: 'function' },
          { re: /^export\s+class\s+(\w+)/, type: 'class' },
          { re: /^export\s+interface\s+(\w+)/, type: 'interface' },
          { re: /^export\s+type\s+(\w+)\s*=/, type: 'type' },
          { re: /^export\s+const\s+(\w+)/, type: 'const' },
          { re: /^export\s+let\s+(\w+)/, type: 'let' },
          { re: /^export\s+var\s+(\w+)/, type: 'var' },
          { re: /^export\s+{(.*?)}/, type: 'export' },
          { re: /^(?:async\s+)?function\s+(\w+)/, type: 'function' },
          { re: /^class\s+(\w+)/, type: 'class' },
          { re: /^const\s+(\w+)\s*=\s*(?:async\s+)?\(/, type: 'const' },
          { re: /^const\s+(\w+)\s*=\s*(?:async\s+)?function/, type: 'const' },
          { re: /^const\s+(\w+)\s*=\s*(?:async\s+)?\(/, type: 'const' },
          { re: /^let\s+(\w+)\s*=/, type: 'let' },
          { re: /^var\s+(\w+)\s*=/, type: 'var' },
          { re: /^(?:const|let|var)\s+(\w+)\s*=\s*\{/, type: 'const' },
        ],
        // TypeScript / TSX
        ts: [
          { re: /^export\s+default\s+class\s+(\w+)/, type: 'class' },
          { re: /^export\s+default\s+function\s+(\w+)/, type: 'function' },
          { re: /^export\s+(?:async\s+)?function\s+(\w+)/, type: 'function' },
          { re: /^export\s+class\s+(\w+)/, type: 'class' },
          { re: /^export\s+abstract\s+class\s+(\w+)/, type: 'abstract_class' },
          { re: /^export\s+interface\s+(\w+)/, type: 'interface' },
          { re: /^export\s+type\s+(\w+)\s*=/, type: 'type' },
          { re: /^export\s+enum\s+(\w+)/, type: 'enum' },
          { re: /^export\s+namespace\s+(\w+)/, type: 'namespace' },
          { re: /^export\s+const\s+(\w+)/, type: 'const' },
          { re: /^export\s+let\s+(\w+)/, type: 'let' },
          { re: /^export\s+var\s+(\w+)/, type: 'var' },
          { re: /^export\s+{(.*?)}/, type: 'export' },
          { re: /^declare\s+(?:const|let|var)\s+(\w+)/, type: 'declare' },
          { re: /^(?:async\s+)?function\s+(\w+)/, type: 'function' },
          { re: /^class\s+(\w+)/, type: 'class' },
          { re: /^interface\s+(\w+)/, type: 'interface' },
          { re: /^type\s+(\w+)\s*=/, type: 'type' },
          { re: /^enum\s+(\w+)/, type: 'enum' },
          { re: /^namespace\s+(\w+)/, type: 'namespace' },
          { re: /^const\s+(\w+)\s*=\s*(?:async\s+)?function/, type: 'const' },
          { re: /^const\s+(\w+)\s*=\s*(?:async\s+)?\(/, type: 'const' },
          { re: /^const\s+(\w+)\s*=\s*\{/, type: 'const' },
          { re: /^let\s+(\w+)\s*=/, type: 'let' },
          { re: /^var\s+(\w+)\s*=/, type: 'var' },
        ],
        // Python
        py: [
          { re: /^\s*class\s+(\w+)/, type: 'class' },
          { re: /^\s*async\s+def\s+(\w+)/, type: 'async_function' },
          { re: /^\s*def\s+(\w+)/, type: 'function' },
          { re: /^(\w+)\s*=\s*lambda/, type: 'lambda' },
          { re: /^(\w+)\s*=\s*(?:Super|super)\(/, type: 'instance' },
        ],
        // Go
        go: [
          { re: /^func\s+\(\w+\s+\*?\w+\)\s+(\w+)/, type: 'method' },
          { re: /^func\s+(\w+)/, type: 'function' },
          { re: /^type\s+(\w+)\s+struct/, type: 'struct' },
          { re: /^type\s+(\w+)\s+interface/, type: 'interface' },
          { re: /^type\s+(\w+)\s+/, type: 'type' },
          { re: /^var\s+(\w+)/, type: 'var' },
          { re: /^const\s+(\w+)/, type: 'const' },
          { re: /^package\s+(\w+)/, type: 'package' },
        ],
        // Rust
        rs: [
          { re: /^pub\s+fn\s+(\w+)/, type: 'pub_function' },
          { re: /^fn\s+(\w+)/, type: 'function' },
          { re: /^pub\s+struct\s+(\w+)/, type: 'pub_struct' },
          { re: /^struct\s+(\w+)/, type: 'struct' },
          { re: /^pub\s+enum\s+(\w+)/, type: 'pub_enum' },
          { re: /^enum\s+(\w+)/, type: 'enum' },
          { re: /^pub\s+trait\s+(\w+)/, type: 'pub_trait' },
          { re: /^trait\s+(\w+)/, type: 'trait' },
          { re: /^impl\s+.*for\s+(\w+)/, type: 'impl' },
          { re: /^impl\s+(\w+)/, type: 'impl' },
          { re: /^pub\s+const\s+(\w+)/, type: 'pub_const' },
          { re: /^pub\s+static\s+(\w+)/, type: 'pub_static' },
          { re: /^const\s+(\w+)/, type: 'const' },
          { re: /^static\s+(\w+)/, type: 'static' },
          { re: /^pub\s+mod\s+(\w+)/, type: 'pub_module' },
          { re: /^mod\s+(\w+)/, type: 'module' },
          { re: /^pub\s+type\s+(\w+)/, type: 'pub_type' },
          { re: /^type\s+(\w+)\s*=/, type: 'type' },
        ],
      };

      // Map file extensions to pattern sets
      const EXT_TO_PATTERNS = {
        '.js': 'js', '.jsx': 'js',
        '.ts': 'ts', '.tsx': 'ts',
        '.py': 'py',
        '.go': 'go',
        '.rs': 'rs',
      };

      const outputLines = [];
      const MAX_OUTPUT_LINES = 1500;

      // Read only top-level entries (not recursive)
      let entries;
      try {
        entries = fs.readdirSync(fullPath, { withFileTypes: true });
      } catch (e) {
        throw new Error(`Failed to read directory: ${dirPath} — ${e.message}`);
      }

      // Sort entries for deterministic output
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        // Skip directories
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          continue;
        }

        // Skip ignored files
        if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;

        // Check file extension
        const ext = pathMod.extname(entry.name).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

        // Check optional file_pattern filter
        if (!matchesGlob(entry.name, file_pattern)) continue;

        const filePath = pathMod.join(fullPath, entry.name);

        // Try to read file, skip binary/unreadable
        let content;
        try {
          content = fs.readFileSync(filePath, 'utf8');
        } catch (e) {
          continue;
        }

        const lines = content.split('\n');
        const patternKey = EXT_TO_PATTERNS[ext];
        const patterns = PATTERNS[patternKey] || [];
        const definitions = [];

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (const { re, type } of patterns) {
            const match = line.match(re);
            if (match) {
              let name = match[1];
              // Handle export { ... } blocks
              if (type === 'export') {
                const exported = name.split(',').map(s => s.trim().replace(/\s+as\s+.*/, '')).filter(Boolean);
                for (const n of exported) {
                  definitions.push({ name: n, type: 'export', line: i + 1 });
                }
              } else {
                definitions.push({ name, type, line: i + 1 });
              }
              break; // One match per line
            }
          }
        }

        if (definitions.length > 0) {
          outputLines.push(entry.name);
          for (const def of definitions) {
            outputLines.push(`- ${def.type} ${def.name} (line ${def.line})`);
          }
          outputLines.push('');
        }

        if (outputLines.length >= MAX_OUTPUT_LINES) break;
      }

      if (outputLines.length === 0) {
        return '(no code definitions found)';
      }

      // Remove trailing empty line
      if (outputLines[outputLines.length - 1] === '') {
        outputLines.pop();
      }

      return outputLines.join('\n');
    }
  },
  get_file_summaries: {
    description: 'Get high-level summaries of files in a directory. Returns file paths, sizes, line counts, and first/last few lines. Useful for understanding a codebase structure without reading full file contents.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The directory path to scan (relative to the working directory). Use "." for the working directory.'
        },
        file_pattern: {
          type: 'string',
          description: 'Optional glob pattern to filter files (e.g., "*.js", "*.ts")'
        },
        max_files: {
          type: 'number',
          description: 'Maximum number of file summaries to return (default: 30)'
        }
      },
      required: ['path']
    },
    execute: async (args, cwd) => {
      const fs = require('fs');
      const pathMod = require('path');
      const { path: dirPath, file_pattern, max_files = 30 } = args || {};
      if (!dirPath) throw new Error('get_file_summaries requires a "path" argument');
      const fullPath = pathMod.resolve(cwd, dirPath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Directory not found: ${dirPath}`);
      }
      const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.nuxt', '.cache', 'coverage', '.vscode', '.idea', 'vendor', 'target', '.turbo']);
      const matchesGlob = (filename, pat) => {
        if (!pat) return true;
        const regexPat = '^' + pat.replace(/\./g, '\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
        return new RegExp(regexPat).test(filename);
      };
      const files = [];
      const walkDir = (dir, depth = 0) => {
        if (depth > 3 || files.length >= max_files) return;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (files.length >= max_files) return;
            if (entry.isDirectory()) {
              if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
              walkDir(pathMod.join(dir, entry.name), depth + 1);
            } else if (entry.isFile()) {
              if (!matchesGlob(entry.name, file_pattern)) continue;
              const filePath = pathMod.join(dir, entry.name);
              const relPath = pathMod.relative(fullPath, filePath);
              try {
                const stat = fs.statSync(filePath);
                const content = fs.readFileSync(filePath, 'utf8');
                const lines = content.split('\n');
                const ext = pathMod.extname(entry.name).toLowerCase();
                files.push({
                  path: relPath,
                  size: stat.size,
                  lines: lines.length,
                  ext: ext,
                  firstLine: lines[0]?.trim() || '',
                  lastLine: lines[lines.length - 1]?.trim() || ''
                });
              } catch (e) {
                // Skip binary/unreadable files
              }
            }
          }
        } catch (e) {
          // Skip directories we can't read
        }
      };
      walkDir(fullPath);
      if (files.length === 0) return '(no files found)';
      let output = `File summaries for "${dirPath}" (${files.length} files):\n\n`;
      for (const f of files) {
        const sizeStr = f.size > 1024 ? `${Math.round(f.size / 1024)}KB` : `${f.size}B`;
        output += `### ${f.path} (${sizeStr}, ${f.lines} lines)\n`;
        if (f.firstLine) output += `  First: ${f.firstLine.substring(0, 120)}\n`;
        if (f.lastLine) output += `  Last:  ${f.lastLine.substring(0, 120)}\n`;
        output += '\n';
      }
      return output.trim();
    }
  },
  execute_command: {
    description: 'Execute a CLI command on the system. Returns stdout and stderr output. For simple interactive commands, use the "input" parameter to pipe predefined answers to stdin.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The CLI command to execute'
        },
        input: {
          type: 'string',
          description: 'Optional: Text to pipe to the command\'s stdin. Use \\n for line breaks. Example: "y\\ny\\n" to answer two yes prompts.'
        },
        timeout: {
          type: 'number',
          description: 'Optional: Timeout in milliseconds (default: 60000)'
        }
      },
      required: ['command']
    },
    execute: async (args, cwd) => {
      const { spawn } = require('child_process');
      const { command, input, timeout = 60000 } = args || {};
      if (!command) throw new Error('execute_command requires a "command" argument');

      return new Promise((resolve, reject) => {
        const child = spawn(command, [], { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          killTree(child, 'SIGTERM');
          reject(new Error(`Command timed out after ${timeout}ms: ${command}`));
        }, timeout);

        // Pipe input to stdin if provided
        if (input) {
          child.stdin.write(input.replace(/\\n/g, '\n'));
          child.stdin.end();
        }

        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.on('close', (code) => {
          clearTimeout(timer);
          let output = stdout;
          if (stderr) output += stderr;
          resolve(`Exit code: ${code}\n${output}`);
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(new Error(`Failed to execute command: ${err.message}`));
        });
      });
    }
  },
  run_tests: {
    description: 'Run the project\'s test suite and return structured results. Auto-detects the test framework by inspecting project files (package.json scripts, jest/vitest/pytest configs, go.mod, Cargo.toml). If a custom command is provided it is used directly. Returns parsed results including total tests, passed, failed (with file:line and failure description), errors, and coverage summary when available.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Optional: Custom test command to run. If omitted, the test framework is auto-detected from project files.'
        },
        timeout: {
          type: 'number',
          description: 'Optional: Timeout in milliseconds (default: 120000)'
        }
      },
      required: []
    },
    execute: async (args, cwd) => {
      const fs = require('fs');
      const pathMod = require('path');
      const { spawn } = require('child_process');
      const { command: customCommand, timeout = 120000 } = args || {};

      // ── Step 1: Auto-detect test framework if no custom command ──
      let testCommand;
      let framework = 'unknown';

      if (customCommand) {
        testCommand = customCommand;
        framework = 'custom';
      } else {
        const detection = detectTestFramework(cwd);
        testCommand = detection.command;
        framework = detection.framework;
      }

      // ── Step 2: Execute the test command ──
      const rawOutput = await spawnTestCommand(testCommand, cwd, timeout);
      const { stdout, stderr, exitCode } = rawOutput;
      const fullOutput = stdout + (stderr ? stderr : '');

      // ── Step 3: Parse structured results ──
      const results = parseTestResults(fullOutput, stdout, stderr, exitCode, framework);

      // ── Step 4: Format summary ──
      return formatTestSummary(results, framework, testCommand);
    }
  },

  /* ── memory tools ── */

  memory_save: {
    description: 'Save a key-value pair to persistent project memory. Use this to preserve important project discoveries (framework choices, file patterns, API endpoints, database schemas) that will be useful for future tasks. Memory is stored in a per-project .baton-memory.json file.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The memory key to save under (e.g., "framework_choice", "api_base_url", "db_schema")'
        },
        value: {
          type: 'string',
          description: 'The value to store for this key'
        }
      },
      required: ['key', 'value']
    },
    execute: async (args, cwd) => {
      const fs = require('fs');
      const pathMod = require('path');
      const { key, value } = args || {};
      if (!key || typeof key !== 'string') throw new Error('memory_save requires a "key" string argument');
      if (value === undefined || value === null || typeof value !== 'string') throw new Error('memory_save requires a "value" string argument');

      const memoryPath = pathMod.join(cwd, '.baton-memory.json');
      let memory = { created: new Date().toISOString(), entries: {} };

      try {
        if (fs.existsSync(memoryPath)) {
          const raw = fs.readFileSync(memoryPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && parsed.entries) {
            memory = parsed;
          }
        }
      } catch (err) {
        if (err.code === 'EACCES') {
          throw new Error(`memory_save: Permission denied reading memory file at ${memoryPath}`);
        }
        if (err instanceof SyntaxError) {
          throw new Error(`memory_save: Invalid JSON in memory file at ${memoryPath}. File may be corrupted.`);
        }
        throw new Error(`memory_save: Failed to read memory file: ${err.message}`);
      }

      // Check entry count limit
      if (!memory.entries[key] && Object.keys(memory.entries).length >= 50) {
        throw new Error('memory_save: Maximum of 50 entries reached. Please load memory and remove unused entries before saving new ones.');
      }

      const now = new Date().toISOString();

      if (memory.entries[key]) {
        memory.entries[key].value = value;
        memory.entries[key].lastUpdated = now;
      } else {
        memory.entries[key] = { value, created: now };
      }

      // Check file size limit (5KB)
      const serialized = JSON.stringify(memory, null, 2);
      if (Buffer.byteLength(serialized, 'utf8') > 5 * 1024) {
        throw new Error('memory_save: Memory file would exceed 5KB limit. Please load memory and remove some entries before saving.');
      }

      try {
        fs.writeFileSync(memoryPath, serialized, 'utf8');
      } catch (err) {
        if (err.code === 'EACCES') {
          throw new Error(`memory_save: Permission denied writing to ${memoryPath}`);
        }
        throw new Error(`memory_save: Failed to write memory file: ${err.message}`);
      }

      return `Memory saved: key="${key}" (${Buffer.byteLength(value, 'utf8')} bytes)`;
    }
  },

  memory_load: {
    description: 'Load previously saved project memory. If a specific key is provided, return only that entry. If no key is provided, return all memory entries. Use this at the start of a task to review previously saved project knowledge.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Optional: The specific key to load. If omitted, all entries are returned.'
        }
      },
      required: []
    },
    execute: async (args, cwd) => {
      const fs = require('fs');
      const pathMod = require('path');
      const { key } = args || {};

      const memoryPath = pathMod.join(cwd, '.baton-memory.json');

      if (!fs.existsSync(memoryPath)) {
        return 'No memory file found yet. Use memory_save to store project knowledge that will persist across tasks.';
      }

      let memory;
      try {
        const raw = fs.readFileSync(memoryPath, 'utf8');
        memory = JSON.parse(raw);
      } catch (err) {
        if (err.code === 'EACCES') {
          throw new Error(`memory_load: Permission denied reading memory file at ${memoryPath}`);
        }
        if (err instanceof SyntaxError) {
          throw new Error(`memory_load: Invalid JSON in memory file at ${memoryPath}. File may be corrupted.`);
        }
        throw new Error(`memory_load: Failed to read memory file: ${err.message}`);
      }

      if (!memory || typeof memory !== 'object' || !memory.entries) {
        return 'Memory file exists but contains no valid entries.';
      }

      const entries = memory.entries;

      // If a specific key was requested
      if (key !== undefined) {
        if (!entries[key]) {
          const available = Object.keys(entries).join(', ');
          return `Memory key "${key}" not found. Available keys: ${available || '(none)'} `;
        }
        const entry = entries[key];
        let result = `Memory entry for key="${key}":\n${entry.value}`;
        if (entry.created) result += `\n[Created: ${entry.created}]`;
        if (entry.lastUpdated) result += `\n[Last updated: ${entry.lastUpdated}]`;
        return result;
      }

      // Return all entries
      const entryKeys = Object.keys(entries);
      if (entryKeys.length === 0) {
        return 'Memory file exists but contains no entries yet.';
      }

      let result = `Project memory (${entryKeys.length} entries):\n`;
      for (const k of entryKeys) {
        const entry = entries[k];
        const preview = entry.value.length > 100 ? entry.value.substring(0, 100) + '...' : entry.value;
        result += `\n## ${k}\n${preview}`;
        if (entry.created) result += `\n[Created: ${entry.created}]`;
        if (entry.lastUpdated) result += `\n[Last updated: ${entry.lastUpdated}]`;
      }
      return result;
    }
  },

  /* ── run_tests helpers ── */

  /**
   * detectTestFramework — Inspect project files to determine the test command.
   * Returns { command: string, framework: string }
   */
  _detectTestFramework: function(cwd) {
    return detectTestFramework(cwd);
  },

  execute_interactive_command: {
    description: 'Execute a CLI command that requires interactive input (prompts, confirmations). The "responses" object maps prompt patterns to responses. When the command outputs text matching a pattern, the corresponding response is sent. Use a "default" key as fallback for unmatched prompts. Essential for tools like Prisma migrations, npm peer dependency resolutions, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The CLI command to execute'
        },
        responses: {
          type: 'object',
          description: 'Map of prompt patterns (regex or substring) to responses. Example: {"Confirm update": "y", "Reset database": "n", "default": "y"}. When the command output matches a key, the corresponding value is sent to stdin.'
        },
        timeout: {
          type: 'number',
          description: 'Optional: Timeout in milliseconds (default: 120000)'
        },
        promptRegex: {
          type: 'string',
          description: 'Optional: Regex pattern that identifies a prompt line (default: "[\\?\\>]\\s*" matches lines starting with ? or >). Used to detect when the command is waiting for input.'
        }
      },
      required: ['command', 'responses']
    },
    execute: async (args, cwd) => {
      const { spawn } = require('child_process');
      const { command, responses, timeout = 120000, promptRegex } = args || {};
      if (!command) throw new Error('execute_interactive_command requires a "command" argument');
      if (!responses || typeof responses !== 'object') throw new Error('execute_interactive_command requires a "responses" object');

      return new Promise((resolve, reject) => {
        const child = spawn(command, [], {
          cwd,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
        });

        let stdout = '';
        let stderr = '';
        let promptDetected = false;
        let pendingPromptText = '';
        const respondedPatterns = new Set();

        const timer = setTimeout(() => {
          killTree(child, 'SIGTERM');
          reject(new Error(`Interactive command timed out after ${timeout}ms: ${command}`));
        }, timeout);

        // Build matcher function for responses
        const matchResponse = (text) => {
          for (const [pattern, response] of Object.entries(responses)) {
            if (pattern === 'default') continue; // Handle default last
            if (!respondedPatterns.has(pattern)) {
              let matched = false;
              try {
                // Try as regex first
                const regex = new RegExp(pattern, 'i');
                if (regex.test(text)) matched = true;
              } catch {
                // Treat as substring match
                if (text.toLowerCase().includes(pattern.toLowerCase())) matched = true;
              }
              if (matched) {
                respondedPatterns.add(pattern);
                return response;
              }
            }
          }
          // Check default
          if (responses.default !== undefined) {
            return responses.default;
          }
          return null;
        };

        // Check if a line looks like a prompt waiting for input
        const isPromptLine = (line) => {
          if (promptRegex) {
            try {
              return new RegExp(promptRegex).test(line);
            } catch {
              return false;
            }
          }
          // Default: lines ending with ? or > or containing (y/n), [default, etc.]
          return /\?\s*$/.test(line.trim()) ||
                 />s?\s*$/.test(line.trim()) ||
                 /\(y\/n\)/i.test(line) ||
                 /\[default/i.test(line) ||
                 /confirm/i.test(line);
        };

        // Process accumulated output for prompts
        const processOutput = (text) => {
          const lines = text.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // First check if this line matches any response pattern
            const response = matchResponse(trimmed);
            if (response && !promptDetected) {
              promptDetected = true;
              pendingPromptText = trimmed;
              const input = (typeof response === 'string') ? response.replace(/\\n/g, '\n') : String(response);
              child.stdin.write(input + '\n');
              stdout += `[AUTO-RESPONSE] Sent: "${input.trim()}" to prompt: "${trimmed}"\n`;
              return;
            }

            // Also detect prompt-style lines and use default response
            if (isPromptLine(trimmed) && !promptDetected) {
              promptDetected = true;
              pendingPromptText = trimmed;
              if (responses.default !== undefined) {
                const input = String(responses.default).replace(/\\n/g, '\n');
                child.stdin.write(input + '\n');
                stdout += `[AUTO-RESPONSE] Sent: "${input.trim()}" to prompt: "${trimmed}"\n`;
              }
              return;
            }
          }
        };

        // Handle stdout — detect prompts in real-time
        child.stdout.on('data', (data) => {
          const text = data.toString();
          stdout += text;
          if (child.stdin.writable) {
            processOutput(text);
          }
        });

        // Handle stderr — some tools write prompts to stderr
        child.stderr.on('data', (data) => {
          const text = data.toString();
          stderr += text;
          if (child.stdin.writable) {
            processOutput(text);
          }
        });

        // If the process tries to read from stdin and we haven't detected a prompt yet,
        // send the default response as a safety net
        child.stdin.on('error', (err) => {
          // stdin closed, ignore
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          let output = stdout;
          if (stderr) output += '\n' + stderr;

          if (code === 0 || code === null) {
            resolve(`Exit code: ${code}\n${output}`);
          } else {
            // Non-zero exit but we still return the output so the agent can see what happened
            resolve(`Exit code: ${code}\n${output}`);
          }
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          reject(new Error(`Failed to execute interactive command: ${err.message}`));
        });
      });
    }
  },
  complete: {
    description: 'Call this tool when the task is fully accomplished. Provide a summary of what was done.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'A concise summary of all changes made and any verification commands.'
        }
      },
      required: ['summary']
    },
    execute: async (args, cwd) => {
      return `Task completed: ${args?.summary || 'No summary provided.'}`;
    }
  },
  set_checklist: {
    description: 'Create or replace the task checklist. Call this early in the task to break the work into trackable subtasks. The checklist is automatically tracked and displayed to you each iteration.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of subtask descriptions. Be specific and actionable. Example: ["Create database schema", "Build user API endpoints", "Write unit tests"]'
        }
      },
      required: ['items']
    },
    execute: async (args, cwd) => {
      const { items } = args || {};
      if (!items || !Array.isArray(items) || items.length === 0) {
        throw new Error('set_checklist requires a non-empty "items" array');
      }
      // Store in cwd context so executeCodingAgent can access it
      // Returns the formatted checklist for the agent to see
      const formatted = items.map((item, i) => ` [ ] ${i + 1}. ${item}`).join('\n');
      return `Checklist set with ${items.length} items:\n${formatted}`;
    }
  },
  update_checklist: {
    description: 'Update the status of a checklist item. Call this after completing a subtask.',
    parameters: {
      type: 'object',
      properties: {
        itemId: {
          type: 'number',
          description: 'The 0-based index of the checklist item to update'
        },
        status: {
          type: 'string',
          enum: ['started', 'done', 'skipped'],
          description: 'New status: "started" (working on it), "done" (completed), "skipped" (not needed)'
        },
        note: {
          type: 'string',
          description: 'Optional note about what was accomplished. Important for context if the task is split later.'
        }
      },
      required: ['itemId', 'status']
    },
    execute: async (args, cwd) => {
      const { itemId, status, note } = args || {};
      if (typeof itemId !== 'number') throw new Error('itemId must be a number');
      if (!['started', 'done', 'skipped'].includes(status)) throw new Error('status must be started, done, or skipped');
      // Actual state mutation happens in executeCodingAgent loop (Step 4)
      return `Checklist item ${itemId} updated to "${status}"${note ? ': ' + note : ''}`;
    }
  }
};

/**
 * buildToolDefinitions — Convert the TOOLS registry into OpenAI-format
 * tool definitions for use in LLM API calls.
 * Includes both built-in tools and dynamically registered MCP tools.
 *
 * @returns {Array} OpenAI-format tool definitions
 */
function buildToolDefinitions() {
  const builtinTools = Object.entries(TOOLS).map(([name, tool]) => ({
    type: 'function',
    function: {
      name,
      description: tool.description,
      parameters: tool.parameters || {
        type: 'object',
        properties: {}
      }
    }
  }));

  // Concat built-in tools with MCP tools
  const mcpToolDefs = buildMcpToolDefinitions();
  return [...builtinTools, ...mcpToolDefs];
}

/**
 * executeTool — Look up a tool by name from the TOOLS registry or MCP tools,
 * invoke its execute function with the provided arguments and
 * working directory, and return the result as a string.
 *
 * Resolution order:
 * 1. Check built-in TOOLS registry
 * 2. Check dynamically registered MCP tools
 *
 * @param {string} toolName - Name of the tool to execute
 * @param {Object} [args={}] - Arguments to pass to the tool's execute function
 * @param {string} [cwd=''] - Working directory context for the tool
 * @returns {Promise<string>} The tool result as a string
 */
async function executeTool(toolName, args = {}, cwd = '') {
  // First check built-in TOOLS registry
  const tool = TOOLS[toolName];
  if (tool) {
    if (!tool.execute || typeof tool.execute !== 'function') {
      throw new Error(`Tool "${toolName}" does not have a valid execute function`);
    }
    const result = await tool.execute(args, cwd);
    return String(result ?? '');
  }

  // Then check MCP tools
  const mcpTool = findMcpTool(toolName);
  if (mcpTool) {
    if (!mcpTool.execute || typeof mcpTool.execute !== 'function') {
      throw new Error(`MCP tool "${toolName}" from server "${mcpTool.serverName}" does not have a valid execute function`);
    }
    const result = await mcpTool.execute(args, cwd);
    return String(result ?? '');
  }

  // Tool not found in either registry
  const builtinNames = Object.keys(TOOLS).join(', ');
  const mcpNames = mcpTools.map(t => t.name).join(', ');
  const allNames = mcpNames ? `${builtinNames}, ${mcpNames}` : builtinNames;
  throw new Error(`Tool not found: "${toolName}". Available tools: ${allNames}`);
}

/* ═══════════════════════════════════════════
   LLM Call with Tool Support (for Agent Loop)
   ═══════════════════════════════════════════ */

/**
 * callLLMForAgent — Calls the LLM API directly (bypassing /api/chat) with
 * tool definitions, returning both content and tool_calls from the response.
 * This is required for the agent tool-calling loop where the LLM must be able
 * to return structured tool calls that we execute and feed back.
 *
 * @param {Array<{role: string, content: string, tool_calls?: array, tool_call_id?: string}>} messages
 * @param {Object} [config]
 * @param {string} [config.apiBase] - LLM API base URL
 * @param {string} [config.apiKey] - LLM API key
 * @param {string} [config.model] - Model name
 * @param {Array} [config.tools] - OpenAI-format tool definitions
 * @param {number} [config.timeout] - Request timeout in ms
 * @param {number} [config.maxTokens] - Max tokens for response
 * @returns {Promise<{content: string, tool_calls: Array}>} Parsed response
 */
/**
 * Convert OpenAI-format tool definitions to Anthropic format.
 * OpenAI: { type: "function", function: { name, description, parameters: { type, properties, required } } }
 * Anthropic: { name, description, input_schema: { type, properties, required } }
 */
function openaiToolsToAnthropic(tools) {
  return (tools || []).map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters || { type: 'object', properties: {} }
  }));
}

/**
 * Convert Anthropic-format tool definitions back to OpenAI format (for internal consistency).
 */
function anthropicToolToOpenai(toolUse, toolCallId) {
  return {
    id: toolUse.id || toolCallId,
    type: 'function',
    function: {
      name: toolUse.name,
      arguments: JSON.stringify(toolUse.input || {})
    }
  };
}

async function callLLMForAgent(messages, config = {}) {
  const {
    apiKey,
    model,
    tools,
    timeout = 300000,
    maxTokens,
    temperature
  } = config;

  // Empty apiBase → fall back to LM Studio's default. Mirrors Cline's implicit
  // "use lmstudio" behavior so Baton Code / Baton Code Thinking / chat all work
  // against the same global config without requiring the user to type a URL.
  const apiBase = resolveApiBase(config.apiBase);

  // Local LLM servers (LM Studio, Ollama, llama.cpp, etc.) typically bind to
  // localhost/127.0.0.1/0.0.0.0 and don't require an API key. Only enforce the
  // apiKey guard for non-local endpoints so blank-key configs against LM Studio
  // stop failing immediately. Remote endpoints still get a clear error.
  const isLocalEndpoint = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)(?::|\/|$)/i.test(apiBase);
  if (!apiKey && !isLocalEndpoint) {
    throw new Error('callLLMForAgent requires apiKey for non-local endpoints. Configure it in Settings → LLM Configuration.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    // ── Detect Anthropic native API ──
    const isAnthropic = apiBase.toLowerCase().includes('anthropic.com');

    if (isAnthropic) {
      // ── ANTHROPIC NATIVE API PATH ──
      const systemMsg = messages.find(m => m.role === 'system');
      const nonSystemMessages = messages.filter(m => m.role !== 'system');

      // Convert messages to Anthropic format
      const anthropicMessages = nonSystemMessages.map(m => {
        if (m.role === 'tool') {
          // Anthropic tool results: { role: "user", content: [{ type: "tool_result", ... }] }
          return {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: m.tool_call_id,
              content: m.content
            }]
          };
        }
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
          // Convert assistant messages with tool_calls to Anthropic content blocks
          const content = [];
          if (m.content) {
            content.push({ type: 'text', text: m.content });
          }
          for (const tc of m.tool_calls) {
            let input = {};
            try { input = JSON.parse(tc.function.arguments || '{}'); } catch (e) { /* keep empty */ }
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: input
            });
          }
          return { role: 'assistant', content };
        }
        // Plain user/assistant messages: { role, content: "string" }
        return { role: m.role, content: m.content || '' };
      });

      // Convert tools to Anthropic format
      const anthropicTools = openaiToolsToAnthropic(tools);

      const anthropicBody = {
        model: model || 'claude-sonnet-4-20250514',
        messages: anthropicMessages,
        max_tokens: maxTokens || 16384,
      };
      // Only include temperature if explicitly set. Newer Anthropic models
      // (e.g. claude-opus-4-7) deprecated this parameter and return HTTP 400
      // if it's present in the body.
      if (temperature !== undefined && temperature !== null) {
        anthropicBody.temperature = temperature;
      }


      if (systemMsg) {
        anthropicBody.system = systemMsg.content;
      }

      if (anthropicTools.length > 0) {
        anthropicBody.tools = anthropicTools;
      }

      const response = await fetch(`${apiBase.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(anthropicBody),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`LLM request failed (${response.status}): ${errorBody}`);
      }

      const json = await response.json();

      // Parse Anthropic response — content is an array of blocks
      const contentBlocks = json.content || [];
      let textContent = null;
      const toolCalls = [];

      for (const block of contentBlocks) {
        if (block.type === 'text') {
          textContent = (textContent || '') + block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push(anthropicToolToOpenai(block));
        }
      }

      return {
        content: textContent,
        tool_calls: toolCalls
      };
    }

    // ── OPENAI-COMPATIBLE API PATH (default) ──
    const body = {
      model: model || 'gpt-4o',
      messages,
      stream: false,
    };
    // Only include temperature if explicitly set. Some newer models reject it.
    if (temperature !== undefined && temperature !== null) {
      body.temperature = temperature;
    }


    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    if (maxTokens) {
      body.max_tokens = maxTokens;
    }

    // Only send Authorization when we actually have a key. LM Studio ignores
    // a spurious `Bearer ` header, but stricter OpenAI-compatible proxies
    // (e.g. LiteLLM in "require auth" mode) will 400 on an empty bearer.
    const openaiHeaders = { 'Content-Type': 'application/json' };
    if (apiKey) {
      openaiHeaders['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${apiBase.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: openaiHeaders,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${errorBody}`);
    }

    const json = await response.json();
    const choice = json.choices?.[0];
    const message = choice?.message || {};

    return {
      content: message.content || null,
      tool_calls: message.tool_calls || []
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════
   System Prompt
   ═══════════════════════════════════════════ */

/**
 * buildCodingAgentSystemPrompt — Build the system prompt for the coding agent,
 * dynamically injecting the available tool definitions.
 *
 * @param {Array} tools - OpenAI-format tool definitions
 * @param {boolean} [enableThinking=false] - If true, prepend thinking instructions
 * @returns {string} The complete system prompt
 */
function buildCodingAgentSystemPrompt(tools, enableThinking = false) {
  const toolDescriptions = tools
    .map(t => `- **${t.function.name}**: ${t.function.description}${t.function.parameters ? ' (see schema for arguments)' : ''}`)
    .join('\n');

  const thinkingBlock = enableThinking
    ? `## Thinking

Before calling any tools, you MUST reason through your approach inside <thinking>...</thinking> tags. Consider:
- What the user is really asking for (intent vs literal request)
- Edge cases and potential failures
- Alternative approaches and why you chose this one
- What tools to use and in what order
- How to verify the result is correct
Your thinking will be visible to the user as a "thinking" indicator. Be thorough but concise.

`
    : '';

  return `${thinkingBlock}You are an autonomous coding agent. Your job is to complete the user's coding task by using the tools available to you.

## How to work

1. **Understand the task** — Read the user's request carefully. If anything is ambiguous, make reasonable assumptions and proceed.
2. **Plan** — Break the task into small, verifiable steps. Think through the order of operations before acting.
3. **Execute** — Use the available tools to explore the codebase, read files, search for patterns, write or modify code, and run commands as needed.
4. **Verify** — After each change, verify the result. Run linters, type checkers, or test suites when available.
5. **Iterate** — If verification fails, diagnose the issue and fix it. Repeat until the task is complete.
6. **Finish** — When the task is fully accomplished and verified, call the "complete" tool to signal done.

## Available tools

${toolDescriptions}

- **complete**: Call this tool when the task is fully accomplished. Provide a summary of what was done.

## Handling CLI Commands and Interactive Prompts

Many CLI tools display interactive prompts (confirmations, yes/no questions, etc.) that must be handled automatically:

### Strategy 1: Prefer non-interactive flags when available
- npm/yarn: use \`--yes\` or \`-y\` flag (e.g., \`npm init -y\`, \`corepack enable\`)
- Prisma: use \`npx prisma db push\` instead of \`npx prisma migrate dev\` for non-interactive schema pushes
- Prisma migrations: use \`ACCEPT_AUTOMATED_DATA_LOSS=1 npx prisma migrate reset\` for destructive operations
- git: use \`--no-edit\` for commits (e.g., \`git commit --amend --no-edit\`)
- Any tool: check for \`--force\`, \`--yes\`, \`--auto-approve\`, \`--non-interactive\` flags

### Strategy 2: Use execute_command with input parameter
For simple cases where you know the exact sequence of answers:
\`\`\`
execute_command({ command: "some-command", input: "y\\ny\\n" })
\`\`\`

### Strategy 3: Use execute_interactive_command (recommended for complex interactions)
For commands with unpredictable or multiple prompts, use execute_interactive_command:
\`\`\`
execute_interactive_command({
  command: "npx prisma migrate dev --name init",
  responses: {
    "Confirm": "y",
    "Reset": "n",
    "default": "y"
  }
})
\`\`\`
The "responses" object maps prompt text patterns to responses. When the command output matches a pattern, the corresponding response is automatically sent. Always include a "default" key as fallback.

### Common Prisma Patterns
- Create/apply migration: \`npx prisma migrate dev\` (interactive, use execute_interactive_command)
- Push schema without migrations: \`npx prisma db push\` (non-interactive, safe for dev)
- Generate client: \`npx prisma generate\` (non-interactive)
- Seed database: \`npx prisma db seed\` (non-interactive if defined in package.json)
- Format schema: \`npx prisma format\` (non-interactive)

## Project Memory

Use memory_save to preserve important project discoveries (framework choices, file patterns, API endpoints, database schemas) that will be useful for future tasks.
Use memory_load at the start of a task to review previously saved project knowledge.

Memory provides intentional, persistent storage separate from the automatic cross-task context. Use it for facts that will be valuable across multiple tasks, not for transient working notes.

## Git Version Control (if Git MCP tools are available)

If Git MCP tools are available to you (git_commit, git_push, git_diff, git_log, git_branch, git_status), use them to maintain proper version control:

- **After completing significant changes**, use \`git_commit\` to save your work with a descriptive message
- **Before committing**, use \`git_diff\` to review your changes and ensure they are correct
- **Use \`git_status\`** to check the current state of the repository before making changes
- **Use \`git_log\`** to understand the project's commit history when needed
- **Use \`git_branch\`** to create feature branches when the task warrants isolation
- Commit messages should be clear and descriptive, explaining WHAT changed and WHY

## Task Checklist (IMPORTANT)

At the START of every task, you MUST call set_checklist to break the work into subtasks. This is not optional.
Then, as you work through the task, call update_checklist after completing each subtask. The checklist is automatically tracked and shown to you each iteration.

When setting the checklist:
- Be specific and actionable (not vague)
- Include 3-8 items for most tasks
- Each item should be completable in a few tool calls

When updating:
- Mark items "started" when you begin working on them
- Mark items "done" when finished, with a note describing what was accomplished
- Mark items "skipped" only if they are truly not needed, with an explanation

The checklist is critical: if the task runs out of context, the unchecked items will become new tasks to continue the work.

## Rules

- Do NOT ask the user for clarification unless the task is impossible to proceed without it.
- Do NOT make assumptions about file contents — read the file first.
- Do NOT assume command success without verifying output or exit codes.
- Always produce clean, production-quality code that follows the project's existing conventions.
- When modifying existing code, ensure changes are compatible with the rest of the codebase.
- Be direct and technical in your responses. No conversational filler.
- Use tools one at a time. Wait for each result before deciding the next step.
- When a command requires interactive input, NEVER use plain execute_command without handling the prompts — use execute_interactive_command instead.
- When asked to create directories, only create the directories themselves. Do NOT create placeholder files (index.js, __init__.py, mod.rs, etc.) unless the user explicitly requests them.
- When building your checklist, stick strictly to what the user asked for. Do not add extra files, configurations, or scaffolding that wasn't requested.


## Output

When you call "complete", provide a concise summary of all changes made and any commands the user can run to verify the result.`;
}

/* ═══════════════════════════════════════════
   Plan Mode — Restricted Tool Set & System Prompt
   ═══════════════════════════════════════════ */

/**
 * PLAN_MODE_ALLOWED_TOOLS — Array of tool names the planner is permitted to invoke.
 * The planner may ONLY explore the codebase; it must NOT write, modify, or execute commands.
 */
const PLAN_MODE_ALLOWED_TOOLS = [
  'list_files',
  'list_code_definition_names',
  'get_file_summaries',
  'read_file',
  'search_files',
  'set_checklist',
  'memory_save',
  'memory_load'
];

/**
 * buildPlanToolDefinitions — Return OpenAI-format tool definitions
 * only for the tools allowed during the planning phase.
 *
 * @returns {Array} Filtered OpenAI-format tool definitions
 */
function buildPlanToolDefinitions() {
  const allDefinitions = buildToolDefinitions();
  return allDefinitions.filter(t => PLAN_MODE_ALLOWED_TOOLS.includes(t.function.name));
}

/**
 * buildPlannerSystemPrompt — Build a system prompt specifically for the
 * planning phase. The planner's job is to explore and understand the
 * codebase, then produce a detailed action plan via set_checklist.
 *
 * @param {Array} tools - OpenAI-format tool definitions (should be from buildPlanToolDefinitions)
 * @param {boolean} [enableThinking=false] - If true, prepend thinking instructions
 * @returns {string} The complete planner system prompt
 */
function buildPlannerSystemPrompt(tools, enableThinking = false) {
  const toolDescriptions = tools
    .map(t => `- **${t.function.name}**: ${t.function.description}${t.function.parameters ? ' (see schema for arguments)' : ''}`)
    .join('\n');

  const thinkingBlock = enableThinking
    ? `## Thinking

Before calling any tools, you MUST reason through your approach inside <thinking>...</thinking> tags. Consider:
- What the user is really asking for (intent vs literal request)
- Edge cases and potential failures
- Alternative approaches and why you chose this one
- What tools to use and in what order
- How to verify the result is correct
Your thinking will be visible to the user as a "thinking" indicator. Be thorough but concise.

`
    : '';

  return `${thinkingBlock}You are in PLAN MODE. Your sole job is to explore and understand the codebase, then produce a detailed action plan. You are NOT allowed to write, modify, or delete any files, and you must NOT execute any CLI commands.

## What you MAY do

- Use the allowed exploration tools to examine the codebase structure, read files, search for patterns, and understand architecture
- Ask yourself questions about what files need to be read, modified, or created
- Identify dependencies, risks, and the order of operations
- Surface architectural discoveries as "key findings"

## Allowed tools

${toolDescriptions}

## What you must NOT do

- Do NOT call write_to_file, replace_in_file, execute_command, or any tool not listed above
- Do NOT write, modify, or delete any code
- Do NOT execute any CLI commands
- Do NOT start implementing the task

## Planning process (2-3 iterations maximum)

1. **Explore** — Use list_files, list_code_definition_names, and get_file_summaries to understand the project structure and key modules
2. **Analyze** — Read the specific files that will need to be changed. Search for related patterns. Understand the existing conventions and architecture.
3. **Plan** — Call set_checklist as your FINAL action with a detailed, specific action plan.

## Your final output (set_checklist)

Your set_checklist call must include items that are:
- **Specific** — Name the exact files to read, modify, or create
- **Ordered** — List operations in the correct dependency order
- **Actionable** — Each item should be a clear subtask completable in a few tool calls
- **Complete** — Include: files to read, files to modify, files to create, commands to run, and verification steps

Include a final item for verification (e.g., "Run tests", "Lint check", "Manual verification").

## Key findings

As you explore, surface any architectural discoveries:
- Shared utilities or patterns that should be reused
- Existing conventions (naming, formatting, structure) that must be followed
- Potential risks (breaking changes, tight coupling, missing tests)
- Dependencies between modules that affect order of operations

Surface these in your thinking before calling set_checklist.`;
}

/**
 * CODING_AGENT_SYSTEM_PROMPT — Legacy system prompt (kept for backward compatibility).
 * Prefer buildCodingAgentSystemPrompt(tools) for dynamic tool injection.
 */
const CODING_AGENT_SYSTEM_PROMPT = `You are an autonomous coding agent. Your job is to complete the user's coding task by using the tools available to you.

## How to work

1. **Understand the task** — Read the user's request carefully. If anything is ambiguous, make reasonable assumptions and proceed.
2. **Plan** — Break the task into small, verifiable steps. Think through the order of operations before acting.
3. **Execute** — Use the available tools to explore the codebase, read files, search for patterns, write or modify code, and run commands as needed.
4. **Verify** — After each change, verify the result. Run linters, type checkers, or test suites when available.
5. **Iterate** — If verification fails, diagnose the issue and fix it. Repeat until the task is complete.
6. **Finish** — When the task is fully accomplished and verified, call the "complete" tool to signal done.

## Available tools

You have access to the following tools. Use them one at a time, waiting for each result before proceeding to the next step.

${Object.entries(TOOLS).map(([name, tool]) => `- **${name}**: ${tool.description}`).join('\n')}

- **complete**: Call this tool when the task is fully accomplished. Provide a summary of what was done.

## Rules

- Do NOT ask the user for clarification unless the task is impossible to proceed without it.
- Do NOT make assumptions about file contents — read the file first.
- Do NOT assume command success without verifying output or exit codes.
- Always produce clean, production-quality code that follows the project's existing conventions.
- When modifying existing code, ensure changes are compatible with the rest of the codebase.
- Be direct and technical in your responses. No conversational filler.

## Output

When you call "complete", provide a concise summary of all changes made and any commands the user can run to verify the result.`;

/**
 * Format the checklist as a markdown string for injection into LLM messages.
 * Example output:
 * [x] 1. Create database schema (done: Schema created with users and posts tables)
 * [>] 2. Build API endpoints (started)
 * [ ] 3. Write tests
 * [-] 4. Code review (skipped: Not required for this task)
 */
function formatChecklist(checklist) {
    if (!checklist || !checklist.length) return '(no checklist)';
    const statusIcons = {
        pending: ' [ ]',
        started: ' [>]',
        done: ' [x]',
        skipped: ' [-]'
    };
    return checklist.map((item, i) => {
        const icon = statusIcons[item.status] || ' [ ]';
        const note = item.note ? ` (${item.status}: ${item.note})` : (item.status !== 'pending' ? ` (${item.status})` : '');
        return `${icon} ${i + 1}. ${item.text}${note}`;
    }).join('\n');
}

/**
 * Build a summary of accomplishments from the checklist for context overflow.
 * Returns a string summarizing what was done and what remains.
 */
function buildOverflowSummary(checklist, originalPrompt) {
    if (!checklist) return `Original task: "${originalPrompt}". No checklist was created.`;

    const done = checklist.filter(i => i.status === 'done');
    const started = checklist.filter(i => i.status === 'started');
    const remaining = checklist.filter(i => i.status === 'pending' || i.status === 'started');
    const skipped = checklist.filter(i => i.status === 'skipped');

    let summary = `## Task Progress Summary\n\n`;
    summary += `Original task: "${originalPrompt}"\n\n`;
    summary += `### Completed (${done.length}/${checklist.length}):\n`;
    done.forEach(item => {
        summary += `- [x] ${item.text}`;
        if (item.note) summary += ` — ${item.note}`;
        summary += '\n';
    });

    if (started.length > 0) {
        summary += `\n### In Progress (${started.length}):\n`;
        started.forEach(item => {
            summary += `- [>] ${item.text}`;
            if (item.note) summary += ` — ${item.note}`;
            summary += '\n';
        });
    }

    if (remaining.length > 0) {
        summary += `\n### Remaining (${remaining.length}):\n`;
        remaining.forEach(item => {
            summary += `- [ ] ${item.text}`;
            summary += '\n';
        });
    }

    return summary;
}

/**
 * Build new task objects from the unchecked items in the checklist.
 * Each unchecked item becomes a new task with full context.
 *
 * If no checklist was created before overflow, produces a single fallback
 * continuation task with the original prompt so the work does not die silently.
 *
 * @param {Array} checklist - Array of checklist items with status/text/note (may be null)
 * @param {string} originalPrompt - The original task prompt
 * @param {string} agentName - Name/identifier of the agent to assign
 * @param {number} currentTaskIndex - Index of the task being split
 * @returns {Array<Object>} Array of task objects ready for queuing
 */
function buildSpawnedTasks(checklist, originalPrompt, agentName, currentTaskIndex) {
    // Fallback: if the agent never called set_checklist before overflow,
    // create a single continuation task with the original prompt so the work
    // does not die silently. This ensures tasks always have a chance to complete.
    if (!checklist || !checklist.length) {
        console.log(`[CONTEXT SPAWN] No checklist found — creating fallback continuation task`);
        return [{
            prompt: `## Context (task was split due to context limits)\n\nOriginal task: "${originalPrompt}"\n\n### Previous Progress:\nNo checklist was created before the context limit was reached. Please start by calling set_checklist to plan the remaining work, then continue completing the original task.\n\n### Your Task:\nContinue and complete the original task: "${originalPrompt}"`,
            agent: agentName,
            orchestrate: true,
            state: 'pending',
            spawnedFrom: currentTaskIndex,
            spawnedFromItem: '(no checklist — fallback continuation)',
            spawnOrder: 1,
            spawnTotal: 1
        }];
    }

    const doneItems = checklist.filter(i => i.status === 'done');
    const doneSummary = doneItems.map(i => `- [x] ${i.text}${i.note ? ': ' + i.note : ''}`).join('\n');

    const remaining = checklist.filter(i => i.status === 'pending' || i.status === 'started');

    // If all items are done/skipped, still provide a fallback
    if (remaining.length === 0) {
        return [{
            prompt: `## Context (task was split due to context limits)\n\nOriginal task: "${originalPrompt}"\n\n### Already Completed:\n${doneSummary}\n\n### Your Task:\nAll checklist items were marked complete before the context limit was reached. Please verify the work is fully done and call "complete" if so.`,
            agent: agentName,
            orchestrate: true,
            state: 'pending',
            spawnedFrom: currentTaskIndex,
            spawnedFromItem: '(all items done — verification)',
            spawnOrder: 1,
            spawnTotal: 1
        }];
    }

    return remaining.map((item, idx) => ({
        prompt: `## Context (task was split due to context limits)\n\nOriginal task: "${originalPrompt}"\n\n### Already Completed:\n${doneSummary}\n\n### Your Task:\nContinue by completing: **${item.text}**\n${item.status === 'started' && item.note ? 'Previous progress: ' + item.note : ''}\n\nAfter completing this, if there is more work, call set_checklist with the remaining items and continue.`,
        agent: agentName,
        orchestrate: true,
        state: 'pending',
        spawnedFrom: currentTaskIndex,
        spawnedFromItem: item.text,
        spawnOrder: idx + 1,
        spawnTotal: remaining.length
    }));
}

/**
 * Lazily initialize the tiktoken encoder for accurate token counting.
 * Uses cl100k_base which is the encoding for GPT-4, GPT-3.5, and most OpenAI-compatible models.
 */
let tiktokenEncoder = null;
function getTiktokenEncoder() {
    if (!tiktokenEncoder) {
        const { get_encoding } = require('tiktoken');
        // cl100k_base is used by GPT-4, GPT-3.5, and most OpenAI-compatible models
        tiktokenEncoder = get_encoding("cl100k_base");
    }
    return tiktokenEncoder;
}

/**
 * Estimate the number of tokens in a messages array using tiktoken.
 * Falls back to chars/4 if tiktoken fails (e.g., unsupported characters or not installed).
 */
function estimateMessageTokens(messages) {
    if (!messages || !messages.length) return 0;
    let totalTokens = 0;
    try {
        const encoder = getTiktokenEncoder();
        for (const msg of messages) {
            // Each message has overhead: role + content framing (~4 tokens per message)
            totalTokens += 4;
            if (msg.role) totalTokens += encoder.encode(msg.role).length;
            if (msg.content) totalTokens += encoder.encode(String(msg.content)).length;
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    if (tc.function) {
                        totalTokens += encoder.encode(String(tc.function.name || '')).length;
                        totalTokens += encoder.encode(String(tc.function.arguments || '')).length;
                    }
                }
            }
            if (msg.tool_call_id) totalTokens += encoder.encode(String(msg.tool_call_id)).length;
        }
    } catch (e) {
        // Fallback to chars/4 if tiktoken fails (e.g., unsupported characters)
        console.warn('[TOKEN EST] tiktoken failed, falling back to chars/4:', e.message);
        let totalChars = 0;
        for (const msg of messages) {
            if (msg.content) totalChars += String(msg.content).length;
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    if (tc.function) totalChars += String(tc.function.name || '').length + String(tc.function.arguments || '').length;
                }
            }
            if (msg.tool_call_id) totalChars += String(msg.tool_call_id).length;
        }
        totalTokens = Math.ceil(totalChars / 4);
    }
    return totalTokens;
}

/**
 * Return the context window limit for a given model name.
 * Defaults to 128K for unknown models. */
const MODEL_CONTEXT_LIMITS = {
  // OpenAI
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4o-2024-11-20': 128000,
  'gpt-4o-2024-08-06': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16385,
  // Anthropic (via OpenAI compat)
  'claude-3-5-sonnet': 200000,
  'claude-3-opus': 200000,
  // Common local models
  'llama-3.1-405b': 128000,
  'llama-3.1-70b': 128000,
  'llama-3.1-8b': 128000,
  'mistral-large': 128000,
  'mixtral-8x7b': 65536,
};

function getModelContextLimit(model) {
  if (!model) return 128000; // Default
  const key = model.toLowerCase(); // Try exact match first, then partial match
  if (MODEL_CONTEXT_LIMITS[key]) return MODEL_CONTEXT_LIMITS[key];
  for (const [modelName, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (key.includes(modelName) || modelName.includes(key)) return limit;
  }
  return 128000; // Default fallback
}

/* ═══════════════════════════════════════════
   Automatic Context Injection
   ═══════════════════════════════════════════ */

/**
 * Directories to skip when building project context.
 */
const CONTEXT_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.nuxt',
  '.cache', 'coverage', '.vscode', '.idea', 'vendor', 'target', '.turbo'
]);

/**
 * Files to skip when building project context.
 */
const CONTEXT_IGNORE_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '*.lock', '*.log', '*.map'
]);

/**
 * buildProjectContext — Automatically gather project context from the working directory.
 *
 * Collects:
 * - Directory tree (2 levels deep, excluding common ignore dirs)
 * - README.md content if present
 * - package.json summary if present
 *
 * @param {string} workingDir - The project's working directory
 * @returns {string} Formatted context string (empty string if nothing found)
 */
function buildProjectContext(workingDir) {
  const fs = require('fs');
  const path = require('path');

  if (!workingDir) return '';

  try {
    const resolved = path.resolve(workingDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return '';
    }

    let context = '';

    // --- Directory tree (2 levels deep) ---
    const tree = buildDirectoryTree(resolved, resolved, 1);
    if (tree) {
      context += '## Project Context\n\n**Directory Structure:**\n\n```\n' + tree + '\n```\n';
    }

    // --- README.md ---
    const readmePath = path.join(resolved, 'README.md');
    if (fs.existsSync(readmePath)) {
      const readmeContent = fs.readFileSync(readmePath, 'utf8');
      const truncated = truncateForContext(readmeContent, 100);
      context += '\n**README.md:**\n\n```markdown\n' + truncated + '\n```\n';
    }

    // --- package.json ---
    const pkgPath = path.join(resolved, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        let pkgSummary = '';
        if (pkg.name) pkgSummary += `  "name": "${pkg.name}"`;
        if (pkg.version) pkgSummary += `,\n  "version": "${pkg.version}"`;
        if (pkg.description) pkgSummary += `,\n  "description": "${pkg.description}"`;
        if (pkg.scripts) {
          const scriptsLines = Object.entries(pkg.scripts)
            .map(([k, v]) => `    "${k}": "${v}"`)
            .join(',\n');
          pkgSummary += `,\n  "scripts": {\n${scriptsLines}\n  }`;
        }
        if (pkg.dependencies) {
          const deps = Object.entries(pkg.dependencies)
            .map(([k, v]) => `    "${k}": "${v}"`)
            .join(',\n');
          pkgSummary += `,\n  "dependencies": {\n${deps}\n  }`;
        }
        if (pkg.devDependencies && Object.keys(pkg.devDependencies).length < 10) {
          const devDeps = Object.entries(pkg.devDependencies)
            .map(([k, v]) => `    "${k}": "${v}"`)
            .join(',\n');
          pkgSummary += `,\n  "devDependencies": {\n${devDeps}\n  }`;
        }
        context += '\n**package.json (summary):**\n\n```\n{\n' + pkgSummary + '\n}\n```\n';
      } catch (e) {
        // Invalid JSON, skip
      }
    }

    return context.trim();
  } catch (e) {
    console.warn(`[CONTEXT] Failed to build project context for ${workingDir}:`, e.message);
    return '';
  }
}

/**
 * Recursively build a text directory tree, limited to maxDepth.
 * @param {string} rootDir - The root directory (for relative path calculation)
 * @param {string} currentDir - Current directory being walked
 * @param {number} depth - Current depth (1-based)
 * @param {number} maxDepth - Maximum depth to traverse
 * @returns {string} Formatted tree string
 */
function buildDirectoryTree(rootDir, currentDir, depth, maxDepth = 2) {
  const fs = require('fs');
  const path = require('path');

  if (depth > maxDepth) return '';

  try {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    const dirs = [];
    const files = [];

    for (const entry of entries) {
      const name = entry.name;
      // Skip ignored directories
      if (entry.isDirectory() && CONTEXT_IGNORE_DIRS.has(name)) continue;
      // Skip dotfiles/dotdirs at all levels
      if (name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        dirs.push(name);
      } else {
        files.push(name);
      }
    }

    dirs.sort();
    files.sort();

    let result = '';
    const prefix = depth > 1 ? '  ' : '';

    for (const dir of dirs) {
      result += `${prefix}${dir}/\n`;
      const subTree = buildDirectoryTree(rootDir, path.join(currentDir, dir), depth + 1, maxDepth);
      if (subTree) {
        result += `${prefix}  ${subTree.replace(/\n/g, '\n' + prefix)}`;
      }
    }

    for (const file of files) {
      result += `${prefix}${file}\n`;
    }

    return result.trimEnd();
  } catch (e) {
    return '';
  }
}

/**
 * truncateForContext — Truncate large file content for context injection.
 * Keeps the first and last N lines, replacing the middle with an ellipsis.
 *
 * @param {string} content - File content
 * @param {number} maxLines - Maximum total lines (default 80)
 * @returns {string} Truncated content
 */
function truncateForContext(content, maxLines = 80) {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;

  const half = Math.floor(maxLines / 2);
  const skipped = lines.length - half - half;
  return [
    lines.slice(0, half).join('\n'),
    `... (${skipped} lines omitted) ...`,
    lines.slice(-half).join('\n')
  ].join('\n');
}

/**
 * expandFileReferences — Scan a prompt for @filepath references and replace
 * them with the actual file contents, similar to Cline's approach.
 *
 * @param {string} prompt - The original user prompt
 * @param {string} workingDir - The project's working directory
 * @returns {string} The prompt with file references expanded
 */
function expandFileReferences(prompt, workingDir) {
  const fs = require('fs');
  const path = require('path');

  if (!workingDir || !prompt.includes('@')) return prompt;

  // Match @filepath patterns: @ followed by non-whitespace, non-punctuation chars
  // Handles: @src/auth.ts, @README.md, @lib/utils/helpers.js
  const fileRefRegex = /@([^\s,;)\]'\n]+)/g;
  const matches = [...prompt.matchAll(fileRefRegex)];

  if (matches.length === 0) return prompt;

  // Deduplicate file paths
  const filePaths = [...new Set(matches.map(m => m[1]))];
  const expansions = new Map();

  for (const filePath of filePaths) {
    const fullPath = path.resolve(workingDir, filePath);

    // Safety: ensure the resolved path is within workingDir
    const resolvedWorkingDir = path.resolve(workingDir);
    if (!fullPath.startsWith(resolvedWorkingDir + path.sep) && fullPath !== resolvedWorkingDir) {
      expansions.set(filePath, `### File: ${filePath} (ACCESS DENIED — path outside project)\n\`\`\`\n(Unable to read: path escapes project directory)\n\`\`\``);
      continue;
    }

    try {
      if (!fs.existsSync(fullPath)) {
        expansions.set(filePath, `### File: ${filePath} (FILE NOT FOUND)\n\`\`\`\n(File does not exist at this path)\n\`\`\``);
        continue;
      }

      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        // If a directory is referenced, build a mini tree
        const tree = buildDirectoryTree(fullPath, fullPath, 1, 3);
        expansions.set(filePath, `### Directory: ${filePath}\n\`\`\`\n${tree || '(empty)'}\n\`\`\``);
        continue;
      }

      // Check file size — skip binary/large files (>500KB)
      if (stat.size > 500 * 1024) {
        expansions.set(filePath, `### File: ${filePath} (SKIPPED — ${Math.round(stat.size / 1024)}KB, exceeds 500KB limit)\n\`\`\`\n(File too large to auto-include)\n\`\`\``);
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf8');
      const truncated = truncateForContext(content, 150);

      // Detect likely file language for syntax highlighting
      const ext = path.extname(filePath).toLowerCase();
      const langMap = {
        '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
        '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
        '.css': 'css', '.scss': 'scss', '.html': 'html', '.json': 'json',
        '.md': 'markdown', '.yaml': 'yaml', '.yml': 'yaml', '.sql': 'sql',
        '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
        '.vue': 'vue', '.svelte': 'svelte'
      };
      const lang = langMap[ext] || '';

      expansions.set(filePath, `### File: ${filePath}\n\`\`\`${lang}\n${truncated}\n\`\`\``);
    } catch (e) {
      expansions.set(filePath, `### File: ${filePath} (ERROR: ${e.message})\n\`\`\`\n(Unable to read file)\n\`\`\``);
    }
  }

  // Replace references in the prompt, handling duplicates by only expanding the first occurrence
  let result = prompt;
  const seen = new Set();

  for (const match of matches) {
    const filePath = match[1];
    const fullMatch = match[0]; // includes the @ prefix

    if (seen.has(filePath)) {
      // Already expanded — replace with a cross-reference
      result = result.replace(fullMatch, `[${filePath} (see above)]`);
      continue;
    }
    seen.add(filePath);

    const expansion = expansions.get(filePath);
    result = result.replace(fullMatch, expansion);
  }

  return result;
}

/* ═══════════════════════════════════════════
   executeCodingAgent — Main Tool-Calling Loop
   ═══════════════════════════════════════════ */

/**
 * executeCodingAgent — The main micro-agent orchestration loop.
 *
 * This function implements the standard tool-calling agent pattern:
 * 1. Build a conversation with the system prompt (describing tools + rules)
 *    and the user's task prompt.
 * 2. Send the conversation to the LLM with tool definitions.
 * 3. If the LLM returns tool_calls, execute each one via executeTool(),
 *    append the tool results as assistant/tool messages, and repeat.
 * 4. When the LLM returns no tool_calls (plain text response), the task
 *    is considered complete. Return the final result.
 *
 * @param {string} prompt - The user's task description
 * @param {string} [workingDir=''] - Working directory for tool execution
 * @param {Object} [config] - Configuration options
 * @param {string} [config.apiBase] - LLM API base URL
 * @param {string} [config.apiKey] - LLM API key
 * @param {string} [config.model] - Model name
 * @param {number} [config.maxIterations] - Max loop iterations (default: 50)
 * @param {number} [config.timeout] - Per-request timeout in ms
 * @param {number} [config.maxTokens] - Max tokens per LLM response
 * @param {Function} [config.onStep] - Callback after each LLM turn: {iteration, content, tool_calls, results}
 * @param {Function} [config.onToolResult] - Callback after each tool execution: {toolName, args, result}
 * @param {Function} [config.onAbort] - Callback if agent is aborted
 * @param {Function} [config.onLog] - Callback for real-time log events (emitted each loop iteration):
 *   { type, timestamp, iteration, ...details }
 *   Event types: 'agent_start', 'llm_response', 'tool_call', 'tool_result', 'agent_end'
 *   Compatible with BatonBot's appendToClineLog event format for UI streaming.
 * @returns {Promise<{success: boolean, filesCreated: string[], commandsRun: string[], error: string|null, summary: string, iterations: number, messages: Array}>}
 */
async function executeCodingAgent(prompt, workingDir = '', config = {}) {
  const {
    apiKey,
    model,

    maxIterations = 50,
    timeout,
    maxTokens,
    onStep,
    onToolCall,
    onToolResult,
    onAbort,
    onLog,
    projectId,
    contextSpawnThreshold,
    enableContextSpawning = true,
    planMode = true,
    enableThinking = false,
    // ── Temperature defaults ──
    // Historically these defaulted to 0.1 / 0 and were always sent to the
    // model. Newer Anthropic models (e.g. claude-opus-4-7 and beyond)
    // deprecated `temperature` and return HTTP 400 if it appears in the
    // request body at all. We now default to `undefined` so the caller has
    // to opt in explicitly; callLLMForAgent omits the field from the
    // payload when it's null/undefined.
    planTemperature,
    executionTemperature
  } = config;


  // Safety: track files created and commands run throughout the agent lifecycle
  const filesCreated = [];
  const commandsRun = [];

  // Checklist state — tracks subtask progress within this session
  let checklist = null; // Array of { text: string, status: 'pending' | 'started' | 'done' | 'skipped', note?: string }

  // Empty apiBase → fall back to LM Studio's default. Mirrors Cline's implicit
  // "use lmstudio" behavior so Baton Code / Baton Code Thinking / chat all work
  // against the same global config without requiring the user to type a URL.
  const apiBase = resolveApiBase(config.apiBase);

  // Local LLM servers (LM Studio, Ollama, llama.cpp) don't require an API key,
  // so we only enforce apiKey when apiBase points at a remote endpoint. This
  // matches the relaxed guard in callLLMForAgent() above.
  const isLocalExec = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)(?::|\/|$)/i.test(apiBase);

  if (!apiKey && !isLocalExec) {
    const errorMsg = `executeCodingAgent requires apiKey for non-local endpoints (apiBase="${apiBase}"). Configure it in Settings → LLM Configuration.`;
    return {
      success: false,
      filesCreated: [],
      commandsRun: [],
      error: errorMsg,
      summary: errorMsg,
      iterations: 0,
      messages: []
    };
  }

  // ── Automatic Context Injection (shared across phases) ──

  // Step 1: Expand @filepath references in the prompt (Cline-style file inclusion)
  const expandedPrompt = expandFileReferences(prompt, workingDir);

  // Step 2: Build project context (directory tree, README, package.json)
  const projectContext = buildProjectContext(workingDir);

  // Build the user context block (project context + task prompt) reused by both phases
  const buildUserContextBlock = () => {
    const parts = [];
    if (projectContext) {
      parts.push(projectContext + '\n\n---\n\n**IMPORTANT:** The project context above was auto-injected. Use it to understand the codebase structure. You still have full access to all tools (read_file, list_files, etc.) to explore further.');
    }
    parts.push(expandedPrompt);
    return parts.join('\n\n---\n\n');
  };

  let iterations = 0;
  let finalSummary = '';
  const stepLog = [];
  let planSummary = '';
  let keyFindings = '';

  // ── Loop detection: track recent tool calls to detect stuck patterns ──
  const recentToolCalls = []; // Array of {toolName, argsHash} for loop detection
  const LOOP_DETECTION_WINDOW = 6; // Look back this many tool calls
  const LOOP_DETECTION_THRESHOLD = 3; // Flag as loop if this many match

  // Emit agent_start log event
  onLog?.({
    type: 'agent_start',
    timestamp: new Date().toISOString(),
    prompt,
    workingDir,
    model: model || 'default',
    maxIterations,
    planMode: planMode !== false
  });

  // ═══════════════════════════════════════════
  // PHASE 1 — PLAN (exploration-only, max 3 iterations)
  // ═══════════════════════════════════════════

  if (planMode !== false) {
    onLog?.({
      type: 'plan_start',
      timestamp: new Date().toISOString(),
      message: 'Starting planning phase...'
    });

    // Build plan-mode tool definitions (exploration-only)
    const planToolDefinitions = buildPlanToolDefinitions();

    // Build plan messages array (separate from execution messages)
    const planSystemPrompt = buildPlannerSystemPrompt(planToolDefinitions, enableThinking);
    const planMessages = [
      { role: 'system', content: planSystemPrompt },
      { role: 'user', content: buildUserContextBlock() }
    ];

    const planMaxIterations = 3;
    let planCompleted = false;

    for (let pi = 0; pi < planMaxIterations; pi++) {
      const llmPlanConfig = {
        apiBase,
        apiKey,
        model,
        tools: planToolDefinitions,
        timeout,
        maxTokens,
        temperature: planTemperature
      };

      let planResponse;
      try {
        planResponse = await callLLMForAgent(planMessages, llmPlanConfig);
      } catch (err) {
        console.error(`[PLANNER] LLM call failed at iteration ${pi + 1}:`, err.message);
        onLog?.({
          type: 'error',
          timestamp: new Date().toISOString(),
          message: `Planning phase LLM error: ${err.message}`
        });
        // Fall through to execution phase without a plan
        planSummary = '';
        keyFindings = '';
        break;
      }

      // Append assistant message to plan conversation
      const planAssistantMsg = {
        role: 'assistant',
        content: planResponse.content || null
      };
      if (planResponse.tool_calls && planResponse.tool_calls.length > 0) {
        planAssistantMsg.tool_calls = planResponse.tool_calls;
      }
      planMessages.push(planAssistantMsg);

      // If no tool calls, planning is done
      if (!planResponse.tool_calls || planResponse.tool_calls.length === 0) {
        planCompleted = true;
        break;
      }

      // Execute each tool call
      for (const toolCall of planResponse.tool_calls) {
        const toolName = toolCall.function?.name;
        let args = {};

        try {
          args = JSON.parse(toolCall.function?.arguments || '{}');
        } catch (parseErr) {
          console.warn(`[PLANNER] Failed to parse tool arguments for "${toolName}":`, parseErr.message);
          args = {};
        }

        // Check if tool is allowed in plan mode
        if (!PLAN_MODE_ALLOWED_TOOLS.includes(toolName)) {
          const errorMsg = `Error: Tool "${toolName}" is not allowed in planning mode. Only exploration tools are permitted: ${PLAN_MODE_ALLOWED_TOOLS.join(', ')}`;
          planMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: errorMsg
          });
          continue;
        }

        let result;

        // Handle set_checklist during planning — capture the checklist
        if (toolName === 'set_checklist' && args?.items && Array.isArray(args.items)) {
          checklist = args.items.map(item => ({ text: item, status: 'pending', note: '' }));
          result = `Checklist set with ${checklist.length} items:\n${formatChecklist(checklist)}`;
        } else {
          // Execute allowed exploration tools
          try {
            result = await executeTool(toolName, args, workingDir);
          } catch (execErr) {
            result = `Error executing "${toolName}": ${execErr.message}`;
          }
        }

        // Append tool result to plan conversation
        planMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result
        });
      }
    }

    // Build planSummary from planning phase
    if (checklist) {
      // Extract key findings from the planner's final assistant message content
      const plannerContents = planMessages
        .filter(m => m.role === 'assistant' && m.content)
        .map(m => m.content);
      const lastPlannerContent = plannerContents[plannerContents.length - 1] || '';

      // Key findings: extract observations the agent made during exploration
      keyFindings = lastPlannerContent
        ? lastPlannerContent.split('\n').slice(0, 20).join('\n')
        : 'No explicit findings recorded during planning.';

      planSummary = `## Plan (from planning phase)\n\n`;
      planSummary += `### Checklist\n\n${formatChecklist(checklist)}\n\n`;
      if (keyFindings) {
        planSummary += `### Key Observations\n\n${keyFindings}`;
      }

      onLog?.({
        type: 'plan_summary',
        timestamp: new Date().toISOString(),
        checklist,
        planSummary,
        keyFindings,
        message: `Planning phase complete with ${checklist.length} checklist items`
      });
    } else {
      // Planning ran but no checklist was set — clear plan data
      planSummary = '';
      keyFindings = '';
      onLog?.({
        type: 'plan_summary',
        timestamp: new Date().toISOString(),
        checklist: null,
        planSummary: '',
        keyFindings: '',
        message: 'Planning phase complete (no checklist was set by planner)'
      });
    }

    // Emit plan_end event to signal transition from planning to execution
    onLog?.({
      type: 'plan_end',
      timestamp: new Date().toISOString(),
      message: 'Planning phase complete, starting execution phase'
    });
  }

  // ═══════════════════════════════════════════
  // PHASE 2 — EXECUTE (full tool-calling loop)
  // ═══════════════════════════════════════════

  // Build OpenAI-format tool definitions from the TOOLS registry (ALL tools)
  const toolDefinitions = buildToolDefinitions();

  // Build system prompt with dynamically injected tool descriptions
  const systemPrompt = buildCodingAgentSystemPrompt(toolDefinitions, enableThinking);

  // Build execution messages array (fresh, separate from plan messages)
  let messages = [{ role: 'system', content: systemPrompt }];

  // Inject plan as context (if planning phase ran and produced a plan)
  if (planSummary && checklist) {
    messages.push({
      role: 'user',
      content: planSummary + '\n\n---\n\n**Follow the plan above.** The checklist has been pre-loaded. Continue from where planning left off, executing the checklist items in order. Use ALL available tools (including write_to_file, replace_in_file, execute_command, etc.) to complete the work.'
    });
  }

  // Inject project context as a separate user message (before the task prompt)
  if (projectContext) {
    messages.push({
      role: 'user',
      content: projectContext + '\n\n---\n\n**IMPORTANT:** The project context above was auto-injected. Use it to understand the codebase structure. You still have full access to all tools (read_file, list_files, etc.) to explore further.'
    });
  }

  // Add the (possibly expanded) user prompt as the final user message
  messages.push({ role: 'user', content: expandedPrompt });

  // Counter for tracking consecutive empty LLM responses to enable escalating nudges
  let emptyResponseCount = 0;

  try {
    for (let i = 0; i < maxIterations; i++) {
      iterations++;

      // ── Context overflow detection ──
      const estimatedTokens = estimateMessageTokens(messages);
      const contextLimit = getModelContextLimit(model);
      const spawnThreshold = contextSpawnThreshold ?? 0.70; // 70% default
      const thresholdTokens = Math.floor(contextLimit * spawnThreshold);
      if (estimatedTokens >= thresholdTokens && i > 1) { // i > 1 prevents triggering on the very first message
        console.log(`[CONTEXT OVERFLOW] Token estimate ${estimatedTokens} / ${contextLimit} (${(estimatedTokens/contextLimit*100).toFixed(1)}%) exceeds threshold ${spawnThreshold*100}%. Spawning subtasks.`);

        // Emit overflow log event
        onLog?.({
          type: 'context_overflow',
          timestamp: new Date().toISOString(),
          iteration: iterations,
          estimatedTokens,
          contextLimit,
          spawnThreshold,
          message: `Context overflow: ${estimatedTokens}/${contextLimit} tokens (${(estimatedTokens/contextLimit*100).toFixed(1)}%)`
        });

        // Break out of the loop — will be handled by the overflow logic after the loop
        // Return a special result indicating overflow
        return {
          success: true,
          overflow: true,
          checklist,
          originalPrompt: prompt,
          summary: buildOverflowSummary(checklist, prompt),
          iterations,
          messages: [...messages],
          filesCreated: [...filesCreated],
          commandsRun: [...commandsRun]
        };
      }

      // Emit iteration start log event
      onLog?.({
        type: 'iteration_start',
        timestamp: new Date().toISOString(),
        iteration: iterations,
        message: `Starting iteration ${iterations} of ${maxIterations}`
      });

      // ── Inject checklist state so the agent always knows its progress ──
      if (checklist) {
        const checklistMessage = {
          role: 'user',
          content: `## Your Current Checklist (auto-tracked — use update_checklist to update)\n\n${formatChecklist(checklist)}\n\nContinue working through the checklist. Call update_checklist when you complete a subtask.`
        };
        // Don't duplicate — remove previous checklist injection if it exists
        messages = messages.filter(m => !(m.role === 'user' && m.content?.startsWith('## Your Current Checklist')));
        messages.push(checklistMessage);
      }

      // ── Step 1: Send messages to the LLM with tool definitions ──
      const llmConfig = {
        apiBase,
        apiKey,
        model,
        tools: toolDefinitions,
        timeout,
        maxTokens,
        temperature: executionTemperature
      };

      let response;
      try {
        // Emit log event: waiting for LLM response
        onLog?.({
          type: 'llm_request',
          timestamp: new Date().toISOString(),
          iteration: iterations,
          message: 'Sending request to LLM...'
        });

        response = await callLLMForAgent(messages, llmConfig);
      } catch (err) {
        console.error(`[AGENT] LLM call failed at iteration ${iterations}:`, err.message);

        // Emit log event: LLM error
        onLog?.({
          type: 'error',
          timestamp: new Date().toISOString(),
          iteration: iterations,
          message: `LLM error: ${err.message}`
        });

        // Emit agent_end log event
        onLog?.({
          type: 'agent_end',
          timestamp: new Date().toISOString(),
          success: false,
          summary: `LLM error at iteration ${iterations}: ${err.message}`,
          iterations
        });

        return {
          success: false,
          filesCreated: [...filesCreated],
          commandsRun: [...commandsRun],
          error: `LLM error at iteration ${iterations}: ${err.message}`,
          summary: `LLM error at iteration ${iterations}: ${err.message}`,
          iterations,
          messages: [...messages]
        };
      }

      // Emit log event: LLM response received
      // ── Debug: Log raw LLM response for troubleshooting ──
      const rawContent = response.content;
      const rawToolCalls = response.tool_calls;
      console.log(`[AGENT] Iteration ${iterations}: content=${JSON.stringify(rawContent?.substring(0, 200) || null)}, toolCalls=${rawToolCalls?.length || 0}`);

      // ── Extract thinking tags ──
      const thinkingOpen = '<thinking>';
      const thinkingClose = '</thinking>';
      const llmContent = response.content || '';
      const thinkingStartIdx = llmContent.indexOf(thinkingOpen);
      const thinkingEndIdx = llmContent.indexOf(thinkingClose);

      if (thinkingStartIdx !== -1 && thinkingEndIdx !== -1 && thinkingEndIdx > thinkingStartIdx) {
        // Full thinking block: extract thinking text and non-thinking content
        const thinkingText = llmContent.substring(thinkingStartIdx + thinkingOpen.length, thinkingEndIdx).trim();
        const afterThinking = llmContent.substring(thinkingEndIdx + thinkingClose.length).trim();

        // Emit thinking_start
        onLog?.({
          type: 'thinking_start',
          timestamp: new Date().toISOString(),
          iteration: iterations,
          message: 'Agent is thinking...'
        });

        // Emit thinking_end with full content
        onLog?.({
          type: 'thinking_end',
          timestamp: new Date().toISOString(),
          iteration: iterations,
          content: thinkingText,
          message: 'Agent finished thinking'
        });

        // Emit llm_response with non-thinking content only
        onLog?.({
          type: 'llm_response',
          timestamp: new Date().toISOString(),
          iteration: iterations,
          content: afterThinking,
          toolCallCount: response.tool_calls?.length || 0,
          message: afterThinking
            ? `LLM responded (${response.tool_calls?.length || 0} tool call(s))`
            : 'LLM responded with thinking only'
        });
      } else if (thinkingStartIdx !== -1) {
        // Partial thinking (no closing tag) — emit thinking_start + chunk
        const thinkingText = llmContent.substring(thinkingStartIdx + thinkingOpen.length).trim();
        onLog?.({
          type: 'thinking_start',
          timestamp: new Date().toISOString(),
          iteration: iterations,
          message: 'Agent is thinking...'
        });
        onLog?.({
          type: 'thinking_chunk',
          timestamp: new Date().toISOString(),
          iteration: iterations,
          content: thinkingText,
          message: thinkingText
        });
      } else {
        // No thinking tags — emit normal llm_response
        onLog?.({
          type: 'llm_response',
          timestamp: new Date().toISOString(),
          iteration: iterations,
          content: llmContent,
          toolCallCount: response.tool_calls?.length || 0,
          message: llmContent
            ? `LLM responded (${response.tool_calls?.length || 0} tool call(s))`
            : 'LLM responded with no content'
        });
      }

      // Append the assistant message (content + any tool_calls reference)
      const assistantMsg = {
        role: 'assistant',
        content: response.content || null
      };
      if (response.tool_calls && response.tool_calls.length > 0) {
        assistantMsg.tool_calls = response.tool_calls;
      }
      messages.push(assistantMsg);

      // ── Step 2: Check if the LLM returned tool calls ──
      if (!response.tool_calls || response.tool_calls.length === 0) {
        const content = response.content || '';

        // Guard: if content is empty AND there are pending checklist items,
        // the LLM likely got confused or gave up. Nudge it to continue instead
        // of treating this as successful completion (prevents silent failures).
        if (!content.trim() && checklist && checklist.some(item => item.status === 'pending' || item.status === 'started')) {
          emptyResponseCount++;
          const pendingCount = checklist.filter(item => item.status === 'pending' || item.status === 'started').length;
          console.warn(`[AGENT] LLM returned empty response (consecutive: ${emptyResponseCount}) with ${pendingCount} pending checklist item(s). Sending nudge to continue.`);

          onLog?.({
            type: 'warning',
            timestamp: new Date().toISOString(),
            iteration: iterations,
            message: `LLM returned empty response (consecutive: ${emptyResponseCount}) with ${pendingCount} pending items. Nudging to continue.`
          });

          // Remove the empty assistant message so the LLM doesn't see its own blank response
          messages.pop();

          // Hard cap: after 5 consecutive empty responses, give up to prevent infinite loops
          if (emptyResponseCount >= 5) {
            const errorMsg = `Agent stuck: LLM returned ${emptyResponseCount} consecutive empty responses. Giving up to prevent infinite loop.`;
            console.error(`[AGENT] ${errorMsg}`);

            onLog?.({
              type: 'error',
              timestamp: new Date().toISOString(),
              iteration: iterations,
              message: errorMsg
            });

            onLog?.({
              type: 'agent_end',
              timestamp: new Date().toISOString(),
              success: false,
              summary: errorMsg,
              iterations
            });

            return {
              success: false,
              filesCreated: [...filesCreated],
              commandsRun: [...commandsRun],
              error: errorMsg,
              summary: errorMsg,
              iterations,
              messages: [...messages]
            };
          }

          // Build escalating nudge messages — each more directive than the last
          const pendingItems = checklist
            .filter(item => item.status === 'pending' || item.status === 'started')
            .map((item, i) => `  ${i + 1}. [${item.status}] ${item.text}`)
            .join('\n');

          let nudgeContent;
          if (emptyResponseCount === 1) {
            nudgeContent = `⚠️ You returned an empty response with ${pendingCount} checklist item(s) still pending. Please continue working on the remaining tasks.\n\nPending items:\n${pendingItems}\n\nUse the available tools (write_to_file, replace_in_file, execute_command, etc.) to complete the work.`;
          } else if (emptyResponseCount === 2) {
            nudgeContent = `⚠️⚠️ This is your 2nd consecutive empty response. You MUST use a tool to make progress. Pick the first pending item and execute it now.\n\nPending items:\n${pendingItems}`;
          } else if (emptyResponseCount === 3) {
            // On 3rd empty response, aggressively strip context to break the loop.
            // Remove ALL user/assistant/tool message pairs from the end (nudge exchanges),
            // keeping only the system prompt + original user message + checklist injection.
            // This gives the LLM a clean slate with just the core context.
            const systemMsg = messages[0]; // system prompt
            // Find the original user message (first user message that's not a checklist injection or nudge)
            let originalUserIdx = -1;
            for (let mi = 1; mi < messages.length; mi++) {
              if (messages[mi].role === 'user' && !messages[mi].content?.startsWith('## Your Current Checklist') && !messages[mi].content?.startsWith('⚠️') && !messages[mi].content?.startsWith('🚨')) {
                originalUserIdx = mi;
                break;
              }
            }
            const keptCount = originalUserIdx !== -1 ? originalUserIdx + 1 : 2;
            const strippedCount = messages.length - keptCount;
            messages = messages.slice(0, keptCount);
            console.warn(`[AGENT] Aggressively stripped ${strippedCount} messages from context on 3rd empty response, keeping ${keptCount} core messages.`);

            nudgeContent = `⚠️⚠️⚠️ CRITICAL: You have returned 3 consecutive empty responses. I have cleared your recent context. You are REQUIRED to call a tool right now.\n\nYour pending items:\n${pendingItems}\n\nDO NOT just think or explain. DO NOT return an empty response. Call write_to_file, replace_in_file, update_checklist, or another tool to make concrete progress. Your response MUST include a tool call.`;
          } else if (emptyResponseCount === 4) {
            // Nuclear option: strip everything except system + original prompt,
            // and send the most direct possible instruction
            const systemMsg = messages[0];
            let originalUserIdx = -1;
            for (let mi = 1; mi < messages.length; mi++) {
              if (messages[mi].role === 'user' && !messages[mi].content?.startsWith('## Your Current Checklist') && !messages[mi].content?.startsWith('⚠️') && !messages[mi].content?.startsWith('🚨')) {
                originalUserIdx = mi;
                break;
              }
            }
            const keptCount = originalUserIdx !== -1 ? originalUserIdx + 1 : 2;
            messages = messages.slice(0, keptCount);
            console.warn(`[AGENT] Nuclear option on 4th empty response: stripped all context, keeping ${keptCount} messages.`);

            nudgeContent = `🚨 FINAL WARNING (4/5): This is your LAST chance before the task fails. You MUST call exactly one tool right now.\n\nYour pending items:\n${pendingItems}\n\nSTOP thinking. CALL A TOOL NOW.`;
          }

          // Push the nudge message (shared by all nudge levels 1-4)
          messages.push({
            role: 'user',
            content: nudgeContent
          });

          continue; // Skip the return below and loop again
        } else if (response.tool_calls && response.tool_calls.length > 0) {
          // Tool calls were made — reset the empty response counter
          if (emptyResponseCount > 0) {
            console.log(`[AGENT] Empty response streak broken (${emptyResponseCount} consecutive empty responses before tool call). Resetting counter.`);
            emptyResponseCount = 0;
          }
        } else {
          // Non-empty content with no tool calls — also reset counter
          if (content.trim() && emptyResponseCount > 0) {
            emptyResponseCount = 0;
          }
        }

        // No tool calls — the LLM is done. Final content is the result.
        finalSummary = content || 'Task completed with no output.';

        // Emit log event: agent completed (no more tool calls)
        onLog?.({
          type: 'agent_end',
          timestamp: new Date().toISOString(),
          success: true,
          summary: finalSummary,
          iterations,
          message: 'Agent completed — no more tool calls'
        });

        onStep?.({
          iteration: iterations,
          content: response.content,
          tool_calls: [],
          results: [],
          done: true
        });

        return {
          success: true,
          filesCreated: [...filesCreated],
          commandsRun: [...commandsRun],
          error: null,
          summary: finalSummary,
          iterations,
          messages: [...messages],
          planSummary: planSummary || undefined,
          keyFindings: keyFindings || undefined
        };
      }

      // Execute each tool call from the LLM response
      const toolResults = [];
      for (const toolCall of response.tool_calls) {
        const toolName = toolCall.function?.name || toolCall.type;
        const args = toolCall.function?.arguments
          ? typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments
          : {};

        // Emit log event: tool call
        onLog?.({
          type: 'tool_call',
          timestamp: new Date().toISOString(),
          iteration: iterations,
          toolName,
          toolCallId: toolCall.id,
          args
        });

        // Notify caller of tool call
        onToolCall?.({ toolName, toolCallId: toolCall.id, args });

        // Handle set_checklist — initialize checklist from LLM plan
        if (toolName === 'set_checklist') {
          if (args?.items && Array.isArray(args.items)) {
            checklist = args.items.map(item => ({ text: item, status: 'pending', note: '' }));
            result = `Checklist set with ${checklist.length} items:\n${formatChecklist(checklist)}`;
          }
        }
        // Handle update_checklist — mutate checklist state
        else if (toolName === 'update_checklist' && checklist) {
          // Support bulk replacement: if "items" array is provided, replace the entire checklist
          if (args?.items && Array.isArray(args.items)) {
            checklist = args.items.map(item => ({ text: String(item), status: 'pending', note: '' }));
            result = `Checklist replaced with ${checklist.length} items:\n${formatChecklist(checklist)}`;
          } else {
            // Single-item update
            const { itemId, status, note } = args || {};
            if (typeof itemId === 'number' && itemId >= 0 && itemId < checklist.length) {
              checklist[itemId].status = status;
              if (note) checklist[itemId].note = note;
              result = `Checklist item ${itemId} updated to "${status}"${note ? ': ' + note : ''}.\n\nCurrent checklist:\n${formatChecklist(checklist)}`;
            } else {
              result = `Error: itemId ${itemId} is out of range (checklist has ${checklist.length} items, indices 0-${checklist.length - 1}). To replace the entire checklist, pass an "items" array instead.`;
            }
          }
        }
        // Normal tool execution
        else {
          try {
            result = await executeTool(toolName, args, workingDir);

            // Track file creation
            if (toolName === 'write_to_file' && args?.path) {
              if (!filesCreated.includes(args.path)) {
                filesCreated.push(args.path);
              }
            }

            // Track replace_in_file as file modification
            if (toolName === 'replace_in_file' && args?.path) {
              if (!filesCreated.includes(args.path)) {
                filesCreated.push(args.path);
              }
            }

            // Track command execution
            if (toolName === 'execute_command' && args?.command) {
              commandsRun.push(args.command);
            }

            // Track interactive command execution
            if (toolName === 'execute_interactive_command' && args?.command) {
              commandsRun.push(args.command);
            }

            // If the tool is "complete", capture the summary and stop
            if (toolName === 'complete') {
              finalSummary = result;
            }
          } catch (execErr) {
            result = `Error executing "${toolName}": ${execErr.message}`;
            console.error(`[AGENT] Tool execution error:`, execErr);
          }
        }

        // Emit log event: tool result received
        onLog?.({
          type: 'tool_result',
          timestamp: new Date().toISOString(),
          iteration: iterations,
          toolName,
          toolCallId: toolCall.id,
          success: !result.startsWith('Error executing'),
          resultPreview: result.substring(0, 500) + (result.length > 500 ? '...' : ''),
          resultLength: result.length,
          message: `Tool "${toolName}" returned (${result.length} chars)`
        });

        // Notify caller of tool result
        onToolResult?.({
          toolName,
          toolCallId: toolCall.id,
          args,
          result
        });

        toolResults.push({
          tool_call_id: toolCall.id,
          tool_name: toolName,
          result
        });

        // Append tool result message to conversation
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result
        });

        // If "complete" was called, break out of tool loop
        if (toolName === 'complete') {
          // Append a final assistant message acknowledging completion
          messages.push({
            role: 'assistant',
            content: `Task completed successfully. ${finalSummary}`
          });

          // Emit log event: complete tool called
          onLog?.({
            type: 'agent_end',
            timestamp: new Date().toISOString(),
            success: true,
            summary: finalSummary,
            iterations,
            message: 'Agent called "complete" tool — task finished'
          });

          onStep?.({
            iteration: iterations,
            content: response.content,
            tool_calls: response.tool_calls,
            results: toolResults,
            done: true
          });

          return {
            success: true,
            filesCreated: [...filesCreated],
            commandsRun: [...commandsRun],
            error: null,
            summary: finalSummary,
            iterations,
            messages: [...messages],
            planSummary: planSummary || undefined,
            keyFindings: keyFindings || undefined
          };
        }
      }

      // Notify caller of this iteration step
      onStep?.({
        iteration: iterations,
        content: response.content,
        tool_calls: response.tool_calls,
        results: toolResults,
        done: false
      });

      stepLog.push({
        iteration: iterations,
        content: response.content,
        tool_calls: response.tool_calls.map(tc => tc.function?.name),
        results_count: toolResults.length
      });
    }
  } catch (unexpectedError) {
    // Catch-all: ensure the loop never hangs due to an unhandled exception
    console.error('[AGENT] Unexpected error:', unexpectedError.message);
    onLog?.({
      type: 'error',
      timestamp: new Date().toISOString(),
      iteration: iterations,
      message: `Unexpected error: ${unexpectedError.message}`
    });
  }

  // ── Max iterations reached (or unexpected error) ──
  const exhaustedMessage = `Agent stopped after ${maxIterations} iterations without completing.`;

  onLog?.({
    type: 'agent_end',
    timestamp: new Date().toISOString(),
    success: false,
    summary: exhaustedMessage,
    iterations,
    message: `Max iterations (${maxIterations}) reached — agent stopped`
  });

  onAbort?.({
    reason: `Max iterations (${maxIterations}) reached`,
    iterations,
    stepLog
  });

  return {
    success: false,
    filesCreated: [...filesCreated],
    commandsRun: [...commandsRun],
    error: exhaustedMessage,
    summary: exhaustedMessage,
    iterations,
    messages: [...messages],
    planSummary: planSummary || undefined,
    keyFindings: keyFindings || undefined
  };
}

/* ═══════════════════════════════════════════
   run_tests Helper Functions
   ═══════════════════════════════════════════ */

/**
 * detectTestFramework — Inspect project files to determine the test command.
 * Checks package.json scripts, config files, and language-specific manifests.
 *
 * @param {string} cwd - Working directory
 * @returns {{command: string, framework: string}}
 */
function detectTestFramework(cwd) {
  const fs = require('fs');
  const path = require('path');

  // ── 1. Check package.json for test scripts ──
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scripts = pkg.scripts || {};

      // Priority order for npm scripts
      const preferredScripts = ['test', 'test:unit', 'test:e2e', 'test:ci', 'test:run'];
      for (const scriptName of preferredScripts) {
        if (scripts[scriptName]) {
          return { command: `npm run ${scriptName}`, framework: `npm:${scriptName}` };
        }
      }
    } catch (e) {
      // Invalid JSON, fall through
    }
  }

  // ── 2. Check for framework config files ──
  const configChecks = [
    { files: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts'], framework: 'vitest', command: 'npx vitest run' },
    { files: ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', '.jestrc.json'], framework: 'jest', command: 'npx jest' },
    { files: ['mocha.opts', '.mocharc.yml', '.mocharc.json', '.mocharc.js'], framework: 'mocha', command: 'npx mocha' },
    { files: ['playwright.config.ts', 'playwright.config.js'], framework: 'playwright', command: 'npx playwright test' },
    { files: ['cypress.config.ts', 'cypress.config.js'], framework: 'cypress', command: 'npx cypress run' },
  ];

  for (const check of configChecks) {
    for (const configFile of check.files) {
      if (fs.existsSync(path.join(cwd, configFile))) {
        return { command: check.command, framework: check.framework };
      }
    }
  }

  // ── 3. Check for Python test framework ──
  const pythonConfigs = [
    { file: 'pytest.ini', framework: 'pytest', command: 'python -m pytest' },
    { file: 'pyproject.toml', framework: 'pytest', command: 'python -m pytest' },
    { file: 'setup.py', framework: 'pytest', command: 'python -m pytest' },
  ];

  for (const check of pythonConfigs) {
    if (fs.existsSync(path.join(cwd, check.file))) {
      return { command: check.command, framework: check.framework };
    }
  }

  // ── 4. Check for Go modules ──
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return { command: 'go test ./...', framework: 'go' };
  }

  // ── 5. Check for Rust/Cargo ──
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return { command: 'cargo test', framework: 'cargo' };
  }

  // ── 6. Check for Ruby ──
  if (fs.existsSync(path.join(cwd, 'Gemfile'))) {
    return { command: 'bundle exec rspec', framework: 'rspec' };
  }

  // ── 7. Fallback: try npm test ──
  return { command: 'npm test', framework: 'npm:fallback' };
}

/**
 * spawnTestCommand — Execute a test command and capture output.
 *
 * @param {string} command - The test command to run
 * @param {string} cwd - Working directory
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null}>}
 */
function spawnTestCommand(command, cwd, timeout) {
  const { spawn } = require('child_process');

  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      killTree(child, 'SIGTERM');
      reject(new Error(`Test command timed out after ${timeout}ms: ${command}`));
    }, timeout);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to execute test command: ${err.message}`));
    });
  });
}

/**
 * parseTestResults — Parse raw test output into structured results.
 * Attempts to detect common test framework output formats.
 *
 * @param {string} fullOutput - Combined stdout + stderr
 * @param {string} stdout - Stdout only
 * @param {string} stderr - Stderr only
 * @param {number|null} exitCode - Process exit code
 * @param {string} framework - Detected framework name
 * @returns {Object} Structured test results
 */
function parseTestResults(fullOutput, stdout, stderr, exitCode, framework) {
  const results = {
    totalTests: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
    failures: [],     // { file, line, description }
    errorMessages: [],
    coverage: null,
    duration: null,
    exitCode,
    rawOutput: fullOutput,
    framework,
    parseStatus: 'partial' // 'full', 'partial', 'raw'
  };

  const lines = fullOutput.split('\n');

  // ── Detect total/passed/failed/skipped counts ──
  // Patterns match output from Jest, Vitest, Mocha, pytest, cargo test, go test
  const countPatterns = [
    // Jest / Vitest: "Test Suites: 5 passed, 1 failed, 6 total"
    { re: /(\d+)\s+passed/i, field: 'passed' },
    { re: /(\d+)\s+failed/i, field: 'failed' },
    { re: /(\d+)\s+skipped/i, field: 'skipped' },
    // Jest: "Tests:       42 passed, 3 failed, 45 total"
    { re: /Tests?:\s*(\d+)\s*(?:passed|total)/i, field: null }, // captured below
    // pytest: "5 passed, 1 failed" or "45 passed in 2.34s"
    { re: /(\d+)\s+passed\s+in/i, field: 'passed' },
    { re: /(\d+)\s+failed\s+(?:in|,)/i, field: 'failed' },
    { re: /(\d+)\s+skipped\s+(?:in|,)/i, field: 'skipped' },
    { re: /(\d+)\s+error/i, field: 'errors' },
    // Generic: "X/Y tests passed"
    { re: /(\d+)\s*\/\s*(\d+)\s*tests?/i, field: 'fraction' },
    // Go: "ok  \texample.com/pkg\t1.234s"
    { re: /^\s*ok\s+/i, field: 'go_ok' },
    { re: /^\s*FAIL\s+/i, field: 'go_fail' },
    // Cargo: "test result: ok. 42 passed; 0 failed"
    { re: /test result:\s*(ok|FAILED)\.\s*(\d+)\s+passed/i, field: 'cargo' },
  ];

  // Extract counts from output
  let totalFromSummary = 0;

  for (const line of lines) {
    // "Tests: X passed, Y failed, Z total"
    const totalMatch = line.match(/Tests?:\s*\d+\s+passed.*?(\d+)\s+total/i);
    if (totalMatch) totalFromSummary = parseInt(totalMatch[1], 10);

    // "X passed" patterns
    const passedMatch = line.match(/(\d+)\s+passed/i);
    if (passedMatch && !line.match(/total/i)) {
      results.passed = Math.max(results.passed, parseInt(passedMatch[1], 10));
    }

    // "X failed" patterns
    const failedMatch = line.match(/(\d+)\s+failed/i);
    if (failedMatch) {
      results.failed = Math.max(results.failed, parseInt(failedMatch[1], 10));
    }

    // "X skipped" patterns
    const skippedMatch = line.match(/(\d+)\s+skipped/i);
    if (skippedMatch) {
      results.skipped = Math.max(results.skipped, parseInt(skippedMatch[1], 10));
    }

    // "X errors" patterns
    const errorsMatch = line.match(/(\d+)\s+(?:error|errors)/i);
    if (errorsMatch) {
      results.errors = Math.max(results.errors, parseInt(errorsMatch[1], 10));
    }

    // Fraction: "X/Y tests"
    const fractionMatch = line.match(/(\d+)\s*\/\s*(\d+)\s*tests?/i);
    if (fractionMatch) {
      results.passed = Math.max(results.passed, parseInt(fractionMatch[1], 10));
      totalFromSummary = Math.max(totalFromSummary, parseInt(fractionMatch[2], 10));
    }

    // Cargo test result
    const cargoMatch = line.match(/test result:\s*(ok|FAILED)\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/i);
    if (cargoMatch) {
      results.passed = parseInt(cargoMatch[2], 10);
      results.failed = parseInt(cargoMatch[3], 10);
    }
  }

  // Calculate total
  if (totalFromSummary > 0) {
    results.totalTests = totalFromSummary;
  } else {
    results.totalTests = results.passed + results.failed + results.skipped + results.errors;
  }

  // ── Parse individual failure details ──
  parseFailures(lines, results);

  // ── Parse setup/runtime errors ──
  parseErrors(lines, stderr, results);

  // ── Parse coverage summary ──
  parseCoverage(lines, results);

  // ── Parse test duration ──
  parseDuration(lines, results);

  // Determine parse quality
  if (results.totalTests > 0 && (results.passed > 0 || results.failed >= 0)) {
    results.parseStatus = 'full';
  } else if (results.rawOutput.length > 0) {
    results.parseStatus = 'partial';
  } else {
    results.parseStatus = 'raw';
  }

  return results;
}

/**
 * parseFailures — Extract individual test failure details from output lines.
 */
function parseFailures(lines, results) {
  const failures = [];
  let inFailureBlock = false;
  let currentFailure = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect failure headers from various frameworks
    // Jest: "  ● tests > should do something"
    // Vitest: "× tests > should do something"
    // pytest: "FAILED test_file.py::test_function - ..."
    // Mocha: "  1) suite\n     test description"
    const jestFailure = trimmed.match(/^[●â€¢]\s+(.+)/);
    const vitestFailure = trimmed.match(/^×\s+(.+)/);
    const pytestFailure = trimmed.match(/^FAILED\s+(.+?)\s*-\s*(.+)/);
    const goFailure = trimmed.match(/^---\s+FAIL:\s+(.+?)\s*\(/);
    const cargoFailure = trimmed.match(/^failures:/i);

    if (jestFailure) {
      inFailureBlock = true;
      currentFailure = { description: jestFailure[1].trim(), file: null, line: null };
    } else if (vitestFailure) {
      inFailureBlock = true;
      currentFailure = { description: vitestFailure[1].trim(), file: null, line: null };
    } else if (pytestFailure) {
      inFailureBlock = true;
      const desc = pytestFailure[2] ? pytestFailure[1] + ': ' + pytestFailure[2] : pytestFailure[1];
      currentFailure = { description: desc.trim(), file: null, line: null };
      // Try to extract file:line from the test path
      const pathMatch = pytestFailure[1].match(/(.+?)\.py::/);
      if (pathMatch) currentFailure.file = pathMatch[1] + '.py';
    } else if (goFailure) {
      inFailureBlock = true;
      currentFailure = { description: goFailure[1].trim(), file: null, line: null };
    } else if (cargoFailure) {
      inFailureBlock = true;
      currentFailure = null; // Next indented lines will be failures
    }

    // Detect file:line references in failure context
    if (inFailureBlock && currentFailure) {
      const fileLineMatch = trimmed.match(/^(.+?)(?:\.\w+):(\d+)\s*[-:]?\s*(.*)/);
      if (fileLineMatch && !currentFailure.file) {
        currentFailure.file = fileLineMatch[1].trim();
        currentFailure.line = parseInt(fileLineMatch[2], 10);
        if (fileLineMatch[3]) currentFailure.description = fileLineMatch[3].trim();
      }

      // Detect "at filename:line:col" patterns
      const atMatch = trimmed.match(/^at\s+(.+?)(?:\.\w+):(\d+)/);
      if (atMatch && !currentFailure.file) {
        currentFailure.file = atMatch[1].trim();
        currentFailure.line = parseInt(atMatch[2], 10);
      }
    }

    // End of failure block (empty line or new test)
    if (inFailureBlock && currentFailure && (trimmed === '' || /^✓/.test(trimmed) || /^\d+\)\s/.test(trimmed))) {
      if (trimmed === '' && failures.length < 50) {
        // Only finalize on non-empty line after context, or if we have enough failures
        if (currentFailure.description) {
          failures.push(currentFailure);
        }
      }
      if (trimmed !== '') {
        if (currentFailure.description && failures.length < 50) {
          failures.push(currentFailure);
        }
        currentFailure = null;
      }
    }
  }

  // Push any remaining failure
  if (currentFailure && currentFailure.description && failures.length < 50) {
    failures.push(currentFailure);
  }

  // Deduplicate failures
  const seen = new Set();
  results.failures = failures.filter(f => {
    const key = f.description + (f.file || '') + (f.line || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * parseErrors — Extract setup/runtime errors from output.
 */
function parseErrors(lines, stderr, results) {
  const errorPatterns = [
    // Syntax errors
    /SyntaxError:\s*(.+)/i,
    /TypeError:\s*(.+)/i,
    /ReferenceError:\s*(.+)/i,
    // Module resolution
    /Cannot find module\s+(.+)/i,
    /Module not found:\s*(.+)/i,
    // Setup errors
    /\[ERROR\]\s*(.+)/i,
    /ENOENT.*\s*(.+)/i,
    // Python errors
    /Traceback \(most recent call last\)/i,
    /AssertionError:\s*(.+)/i,
    /ImportError:\s*(.+)/i,
    /ModuleNotFoundError:\s*(.+)/i,
  ];

  const allText = stderr || '';
  const allLines = allText.split('\n');

  for (const line of allLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const pattern of errorPatterns) {
      const match = trimmed.match(pattern);
      if (match) {
        const msg = match[1] ? match[1].trim() : trimmed.substring(0, 200);
        if (!results.errorMessages.includes(msg)) {
          results.errorMessages.push(msg);
        }
        break;
      }
    }
  }

  // Cap error messages
  if (results.errorMessages.length > 20) {
    results.errorMessages = results.errorMessages.slice(0, 20);
  }
}

/**
 * parseCoverage — Extract coverage summary from test output.
 */
function parseCoverage(lines, results) {
  let inCoverage = false;
  let coverageText = '';

  for (const line of lines) {
    if (/\|\s*File\s*\|\s*%?Lines?\s*/i.test(line) || /^\s*File\s*|\s*%?/.test(line)) {
      inCoverage = true;
    }

    if (inCoverage) {
      coverageText += line + '\n';

      // End of coverage table
      if (line.trim().startsWith('All files') || /all files/i.test(line)) {
        // Try to extract overall coverage
        const allFilesMatch = line.match(/All files\s+\|\s*(\d+\.?\d*)/i);
        if (allFilesMatch) {
          results.coverage = {
            raw: coverageText.trim(),
            overallLines: parseFloat(allFilesMatch[1])
          };
        } else {
          results.coverage = { raw: coverageText.trim() };
        }
        break;
      }
    }
  }
}

/**
 * parseDuration — Extract test run duration from output.
 */
function parseDuration(lines, results) {
  for (const line of lines) {
    // "Ran X tests in Y.YYs"
    const match1 = line.match(/(?:Ran|completed).*?([\d.]+)\s*s/i);
    // "Finished in 2.34s"
    const match2 = line.match(/(?:finished|completed|done)\s+in\s+([\d.]+)\s*s/i);
    // "X passed in Y.YYs"
    const match3 = line.match(/\d+\s+passed\s+in\s+([\d.]+)\s*s/i);

    const match = match1 || match2 || match3;
    if (match) {
      results.duration = parseFloat(match[1]) + 's';
      break;
    }
  }
}

/**
 * formatTestSummary — Format structured test results into a readable summary.
 *
 * @param {Object} results - Parsed test results from parseTestResults
 * @param {string} framework - Detected framework name
 * @param {string} command - Command that was executed
 * @returns {string} Formatted summary string
 */
function formatTestSummary(results, framework, command) {
  const { totalTests, passed, failed, skipped, errors, failures, errorMessages, coverage, duration, exitCode, parseStatus, rawOutput } = results;

  let summary = '';

  summary += `## Test Results\n\n`;
  summary += `- **Framework**: ${framework}\n`;
  summary += `- **Command**: \`${command}\`\n`;
  summary += `- **Exit Code**: ${exitCode}\n`;
  if (duration) summary += `- **Duration**: ${duration}\n`;
  summary += `\n`;

  // ── Summary counts ──
  if (parseStatus === 'full' || totalTests > 0) {
    summary += `### Counts\n\n`;
    summary += `- **Total**: ${totalTests}\n`;
    summary += `- **Passed**: ${passed} ✅\n`;
    if (failed > 0) summary += `- **Failed**: ${failed} ❌\n`;
    if (skipped > 0) summary += `- **Skipped**: ${skipped}\n`;
    if (errors > 0) summary += `- **Errors**: ${errors}\n`;
    summary += `\n`;
  }

  // ── Failures (prominent) ──
  if (failures.length > 0) {
    summary += `### ❌ Failures (${failures.length})\n\n`;
    for (let i = 0; i < Math.min(failures.length, 10); i++) {
      const f = failures[i];
      const loc = f.file && f.line ? `${f.file}:${f.line}` : (f.file || 'unknown location');
      summary += `${i + 1}. **${loc}**: ${f.description}\n`;
    }
    if (failures.length > 10) {
      summary += `\n... and ${failures.length - 10} more failures (see raw output)\n`;
    }
    summary += `\n`;
  }

  // ── Errors ──
  if (errorMessages.length > 0) {
    summary += `### ⚠️ Errors\n\n`;
    for (const msg of errorMessages.slice(0, 5)) {
      summary += `- ${msg}\n`;
    }
    summary += `\n`;
  }

  // ── Coverage ──
  if (coverage) {
    summary += `### Coverage\n\n`;
    if (coverage.overallLines !== undefined) {
      summary += `- **Lines**: ${coverage.overallLines}%\n`;
    }
    if (coverage.raw) {
      summary += `\n\`\`\`\n${coverage.raw}\n\`\`\`\n`;
    }
    summary += `\n`;
  }

  // ── Pass indicator ──
  if (exitCode === 0 && failed === 0 && errors === 0) {
    summary += `✅ All tests passed!\n`;
  } else if (exitCode !== 0) {
    summary += `❌ Tests failed (exit code ${exitCode})\n`;
  }

  // ── Raw output fallback for unparseable results ──
  if (parseStatus === 'raw' || (parseStatus === 'partial' && totalTests === 0)) {
    summary += `\n### Raw Output (framework output could not be fully parsed)\n\n`;
    // Truncate raw output to avoid overwhelming context
    const maxRaw = 3000;
    const truncated = rawOutput.length > maxRaw
      ? rawOutput.substring(0, maxRaw) + `\n... (${rawOutput.length - maxRaw} more chars)`
      : rawOutput;
    summary += `\n\`\`\`\n${truncated}\n\`\`\`\n`;
  }

  return summary.trim();
}

// Exports for other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    callLLM,
    callLLMStream,
    callLLMForAgent,
    TOOLS,
    executeTool,
    buildToolDefinitions,
    buildCodingAgentSystemPrompt,
    buildPlanToolDefinitions,
    buildPlannerSystemPrompt,
    PLAN_MODE_ALLOWED_TOOLS,
    CODING_AGENT_SYSTEM_PROMPT,
    estimateMessageTokens,
    getModelContextLimit,
    buildSpawnedTasks,
    executeCodingAgent,
    // MCP support
    registerMcpTool,
    unregisterMcpServerTools,
    buildMcpToolDefinitions,
    getAvailableMcpServers,
    getMcpServer,
    setMcpServer,
    findMcpTool
  };
}