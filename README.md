# Doctor

> Evidence-first diagnostics for applications and infrastructure.

Doctor is a local-first CLI for collecting reproducible diagnostic evidence and running
evidence-oriented diagnostic conversations. It combines deterministic collectors for CPU, memory,
network, HTTP, traces and stores with a local Agent runtime and a Plugin SDK for business-specific
capabilities and Skills. Kubernetes is a supported target, but the diagnostic model is not tied to
a single deployment environment.

Doctor Core owns generic Host/Target access, authorization and evidence orchestration. A Plugin
owns target identity and business data semantics: it declares a Service Catalog and capabilities,
receives the selected profile and target context, and returns data that Doctor can turn into
evidence and reports.

## Repository layout

| Path | Purpose |
|---|---|
| `cli/` | Self-contained Doctor CLI, collectors, evidence model and offline reports |
| `server/` | Reserved for the optional Doctor server |
| `packages/agent/` | Agent runtime used by local chat and reserved for a future TypeScript server |
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

The resulting core CLI contains only generic access and diagnostic capabilities. Plugin commands
remain visible, but explain which capability is missing until a compatible Plugin is supplied by
the distributor or loaded by a future Plugin loader.

## Chat runtime

`doctor chat` uses a complete profile `llm` config to run `@compforge/doctor-agent` locally by
default. `doctor chat --server` explicitly selects the remote compatibility adapter and uses the
profile `server`; merely configuring an endpoint does not change the execution location. Both modes
project the same AgentUE/chat-tui interaction model. In local mode, Pi's `read` and `bash` tools let
the Agent load Plugin Skills and run their referenced diagnostic scripts in the CLI process. The
reserved `server/` directory has no implementation yet; a future TypeScript server will reuse the
same Agent package behind a different interface.

## Plugin boundary

`@compforge/doctor-plugin` defines what a Plugin may declare and what context Doctor provides.
Plugins run as trusted code in the same process; the SDK is a collaboration contract rather than
a security sandbox. Start with [`plugins/example`](plugins/example), then see
[`cli/docs/plugin.md`](cli/docs/plugin.md) for the full design.

Skills are versioned resources inside a Plugin. They inherit Plugin selection and trust rather
than introducing an independent global Skill lifecycle.
