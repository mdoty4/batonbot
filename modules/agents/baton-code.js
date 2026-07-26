// modules/agents/baton-code.js
// Configuration for the standard (non-thinking) baton-code agent.
//
// This module exports identity and execution settings for the agent.
// App-level concerns (session ID generation, log writing, context injection,
// summary persistence) remain in taskreaper.js where they depend on
// app-level state (appendToClineLog, getState, saveState, etc.).

module.exports = {
  name: 'Reaper Code',
  agentKey: 'baton-code',
  isHttpAgent: true,
  enableThinking: false,
};
