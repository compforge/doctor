# Doctor

[English](README.md) | [简体中文](README_CN.md)

> Extensible diagnostics for Kubernetes applications.

Doctor is a local-first CLI for collecting reproducible diagnostic evidence and running diagnostic
conversations. It complements `kubectl` with application-aware diagnostics: Core understands how to
reach and safely operate a selected target, while a Plugin teaches Doctor which services make up an
application and what their business data means.

Doctor has three peer workflows: Provision prepares diagnostic capabilities, Collect produces
auditable Evidence and reports, and Chat runs an Agent with application Skills and host-provided tools. All
three share the same profile, target, access and authorization context.

![Doctor architecture](docs/doctor-architecture.svg)

## How Doctor works

| Workflow | Purpose | Result |
|---|---|---|
| Provision | Explicitly prepare a Host or Target capability such as an image, debug environment or diagnostic tool | A ready capability or visible state change |
| Collect | Inspect a target, run bounded probes and apply deterministic detectors | Evidence, coverage, findings and an offline report |
| Chat | Combine a model, Plugin Skills and scoped tools for open-ended investigation | An interactive diagnostic conversation |

Provision, Collect and Chat are independent command workflows rather than modes of one engine.
They reuse Core access and infrastructure primitives, while each owns its result and lifecycle.
Built-in collectors cover CPU, memory, network, HTTP, traces, metrics, models and stores.

Doctor runs from a deployment host with scoped Kubernetes access. It can use explicitly authorized
debug containers for in-cluster diagnostics, then return raw artifacts and offline reports to the
Host.

![How Doctor runs onsite](docs/doctor-usage.svg)

## Core and Plugin

Core and Plugin form Doctor's main extension boundary:

| Component | Owns |
|---|---|
| Core | Profile and target selection, generic Host/Kubernetes access, authorization and resource lifecycle, deterministic collection, Evidence, reports and interaction hosting |
| Plugin | A versioned bundle of application Services, their business capabilities, and Skills |

Core binds access to the target selected by the user and owns shared Kubernetes operations such as
permission checks and port-forward lifecycle. A Plugin consumes that scoped context to locate
application data. It performs its own business-specific HTTP and database access, then returns
neutral results or temporary capability handles. Private protocols, schemas and fixed queries stay
inside the Plugin instead of leaking into the open-source Core.

One Plugin may describe all Services that make up an application and ship multiple capabilities,
model access declarations and Skills under one version. Service capabilities extend deterministic
commands; Model and Skills also extend Chat.

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

`doctor chat` runs `@compforge/doctor-agent` with host-provided tools. A profile `llm`
takes precedence; when it is absent, Doctor can select an LLM from the active Plugin's Model
Capability and use the Plugin-owned inference connection. The active Plugin also contributes the
versioned Skills available to the Agent.

`doctor chat --server` explicitly selects `ServerAgent` and uses the profile `server`; merely
configuring an endpoint does not change the execution location. Local and server hosts project the
same AgentUE/chat-tui interaction model and reuse the same Agent package behind different host
interfaces.

## Plugin boundary

`@compforge/doctor-plugin` defines what a Plugin may declare and the target-scoped capabilities
Doctor provides. Plugins are trusted extensions, but remain on the application-semantics side of
the boundary. Start with [`plugins/example`](plugins/example), then see
[`cli/docs/plugin.md`](cli/docs/plugin.md) for the full design.

To teach Doctor about a specific application, develop a Plugin: describe its services with the
Service Catalog, connect business data and models through Capabilities, and inject operational
knowledge and diagnostic workflows through Skills—without modifying Doctor Core.

Skills are versioned resources inside a Plugin. They inherit Plugin selection and trust rather
than introducing an independent global Skill lifecycle. `doctor version` reports the Doctor Core
version and the exact embedded Plugin identity used by the distribution.

For the deeper boundaries, see [`cli/docs/kernel.md`](cli/docs/kernel.md),
[`cli/docs/plugin.md`](cli/docs/plugin.md) and [`docs/chat.md`](docs/chat.md).
Planned execution-safety work is tracked in [`docs/backlog.md`](docs/backlog.md).
