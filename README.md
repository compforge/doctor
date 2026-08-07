# Doctor

> Extensible diagnostics for Kubernetes applications.

Doctor is a local-first CLI for collecting reproducible diagnostic evidence and running diagnostic
conversations. It complements `kubectl` with application-aware diagnostics: Core understands how to
reach and safely operate a selected target, while a Plugin teaches Doctor which services make up an
application and what their business data means.

Built-in collectors cover CPU, memory, network, HTTP, traces and stores. A local Agent can combine
the same target context with Plugin-provided Skills for open-ended investigation.

## Core and Plugin

Core and Plugin form Doctor's main extension boundary:

| Component | Owns |
|---|---|
| Core | Profile and target selection, generic Host/Kubernetes access, authorization and resource lifecycle, deterministic collection, Evidence, reports and interaction hosting |
| Plugin | A versioned bundle of application Services, their business capabilities, and Skills |

Core binds access to the target selected by the user. A Plugin consumes that scoped access to locate
application data and returns neutral results or temporary capability handles; it does not choose a
different environment or recreate Doctor's access and lifecycle layer. Business protocols, private
schemas and fixed queries remain inside the Plugin instead of leaking into the open-source Core.
One Plugin may describe all Services that make up an application and ship multiple Skills with the
same version; each Service declares its own capabilities and access needs.

```text
Profile ──► Target ──► Core access ──► Plugin capability ──► Evidence / report
                    └───────────────► Plugin Skills ──────► doctor chat
```

## Repository layout

| Path | Purpose |
|---|---|
| `cli/` | Self-contained Doctor CLI, collectors, evidence model and offline reports |
| `server/` | Host boundary for an optional Doctor server |
| `packages/agent/` | Host-neutral Agent runtime shared by local chat and server hosts |
| `packages/plugin/` | `@compforge/doctor-plugin` contracts and shared Plugin utilities |
| `plugins/example/` | Minimal business-neutral Plugin example |

## Development

Requirements: [Bun](https://bun.sh/) and Go.

```bash
bun install
bun run typecheck:plugin-sdk
bun run typecheck:agent
bun run typecheck:example-plugin
bun run typecheck:cli
bun run test:plugin-sdk
bun run test:agent
bun run test:cli
```

Build platform binaries into `dist/`:

```bash
make build
```

Build only the local macOS binary:

```bash
make build-local
```

The resulting Core CLI contains only generic access and diagnostic capabilities. Plugin commands
remain visible and explain which capability is missing when the active profile does not select a
compatible Plugin.

## Chat runtime

`doctor chat` uses a complete profile `llm` config to run `@compforge/doctor-agent` locally by
default. `doctor chat --server` explicitly selects `ServerAgent` and uses the profile `server`;
merely configuring an endpoint does not change the execution location. Both modes project the same
AgentUE/chat-tui interaction model. In local mode, Pi's `read` and `bash` tools let the Agent load
Plugin Skills and run their referenced diagnostic scripts in the CLI process. A server host uses
the same Agent package with its own interface, credentials, execution environment and persistence.

## Plugin boundary

`@compforge/doctor-plugin` defines what a Plugin may declare and the target-scoped capabilities
Doctor provides. Plugins are trusted extensions, but remain on the application-semantics side of
the boundary. Start with [`plugins/example`](plugins/example), then see
[`cli/docs/plugin.md`](cli/docs/plugin.md) for the full design.

Skills are versioned resources inside a Plugin. They inherit Plugin selection and trust rather
than introducing an independent global Skill lifecycle. `doctor version` reports the Doctor Core
version and the exact embedded Plugin identity used by the distribution.
