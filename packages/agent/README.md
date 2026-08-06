# @compforge/doctor-agent

This package is currently the local agent runtime for Doctor Chat and is the shared implementation reserved for a
future TypeScript Doctor Server. It owns the model loop, Doctor semantic blocks, Skill invocation, and AgentUE patch
output; each host provides model configuration, resolved Plugin Skills, tools, and persistence.

Skills do not have an independent installation lifecycle. A Plugin loader selects an exact Plugin version and exposes
its resolved `PluginSkill` views to the agent. The agent never scans a global Skill directory or interprets Plugin
storage layout.
