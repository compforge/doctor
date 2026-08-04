# CompForge Doctor

> Evidence-first diagnostics for private Kubernetes environments.

CompForge Doctor is a local-first CLI for collecting reproducible diagnostic evidence from
Kubernetes workloads and nearby infrastructure. It combines deterministic collectors for CPU,
memory, network, HTTP, traces and stores with a Plugin SDK for product-specific capabilities.

The public repository intentionally contains no product implementation or private deployment
knowledge. Organizations can package their own Service Catalog, data resolvers and diagnostic
skills separately.

## Repository layout

| Path | Purpose |
|---|---|
| `cli/` | Self-contained Doctor CLI, collectors, evidence model and offline reports |
| `packages/plugin/` | `@compforge/doctor-plugin` contracts and shared Plugin utilities |

## Development

Requirements: [Bun](https://bun.sh/) and Go.

```bash
bun install
bun run typecheck:plugin-sdk
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

The resulting core CLI contains only public capabilities. Product-specific commands become
available when a compatible Plugin is supplied by the distributor or loaded by a future Plugin
loader.

## Plugin boundary

`@compforge/doctor-plugin` defines what a Plugin may declare and what context Doctor provides.
Plugins run as trusted code in the same process; the SDK is a collaboration contract rather than
a security sandbox. See [`cli/docs/plugin.md`](cli/docs/plugin.md) for the design.

