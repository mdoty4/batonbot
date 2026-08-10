// modules/agents/baton-code-thinking.js
// Configuration for the thinking variant of the baton-code agent.
//
// This module exports identity and execution settings for the agent.
// App-level concerns (session ID generation, log writing, context injection,
// summary persistence) remain in batonbot.js where they depend on
// app-level state (appendToClineLog, getState, saveState, etc.).

module.exports = {
  name: 'Baton Code Thinking',
  agentKey: 'baton-code-thinking',
  isHttpAgent: true,
  enableThinking: true,
};
