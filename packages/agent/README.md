# @compforge/doctor-agent

This package is currently the local agent runtime for Doctor Chat and is the shared implementation reserved for a
future TypeScript Doctor Server. It owns the model loop, Doctor semantic blocks, Pi's environment-aware `read`/`bash`
tools, Skill discovery prompts, and AgentUE patch output. Each host provides model configuration, a Pi `ExecutionEnv`,
resolved Plugin Skills, additional tools, and persistence.

Skills do not have an independent installation lifecycle. A Plugin loader selects an exact Plugin version and exposes
its resolved `PluginSkill` views to the agent. The agent never scans a global Skill directory or interprets Plugin
storage layout. Pi lists Skill metadata and its absolute `SKILL.md` location in the system prompt; the model reads the
full instructions and referenced files on demand through the same `ExecutionEnv` used to run Skill scripts.
