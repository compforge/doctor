# Doctor

> Evidence-first diagnostics for applications and infrastructure.

Doctor is a local-first CLI for collecting reproducible diagnostic evidence. It combines
deterministic collectors for CPU, memory, network, HTTP, traces and stores with a Plugin SDK for
product-specific capabilities. Kubernetes is a supported target, but the diagnostic model is not
tied to a single deployment environment.

Doctor keeps product knowledge outside the core CLI. A Plugin declares its Service Catalog and
capabilities, receives the selected profile and target context, and returns data that Doctor can
turn into evidence and reports.

## Repository layout

| Path | Purpose |
|---|---|
| `cli/` | Self-contained Doctor CLI, collectors, evidence model and offline reports |
| `server/` | Reserved for the optional Doctor server |
| `packages/plugin/` | `@compforge/doctor-plugin` contracts and shared Plugin utilities |
| `plugins/example/` | Minimal product-neutral Plugin example |

## Development

Requirements: [Bun](https://bun.sh/) and Go.

```bash
bun install
bun run typecheck:plugin-sdk
bun run typecheck:example-plugin
bun run typecheck:cli
bun run test:plugin-sdk
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

The resulting core CLI contains only product-neutral capabilities. Product-specific commands
become available when a compatible Plugin is supplied by the distributor or loaded by a future
Plugin loader.

## Plugin boundary

`@compforge/doctor-plugin` defines what a Plugin may declare and what context Doctor provides.
Plugins run as trusted code in the same process; the SDK is a collaboration contract rather than
a security sandbox. Start with [`plugins/example`](plugins/example), then see
[`cli/docs/plugin.md`](cli/docs/plugin.md) for the full design.
