# Doctor

[English](README.md) | [简体中文](README_CN.md)

> Application-aware diagnostics for Kubernetes services.

Doctor is an enhanced `kubectl` for diagnosing applications. `kubectl` understands Kubernetes objects;
Doctor also understands the services that make up an application, the diagnostic data each service can
provide, and the access required to obtain it.

Doctor runs as a local CLI in the target environment. It uses scoped Kubernetes and application access,
then returns raw evidence and offline reports to the same machine.

![Doctor running from a customer-site Linux machine](docs/doctor-usage.svg)

## What Doctor can diagnose

Doctor follows a problem from standard infrastructure signals into application-specific behavior:

| Area | What Doctor investigates |
|---|---|
| Observability | Traces, metrics and logs across the selected service |
| Runtime | CPU, memory and network behavior of Pods, containers and processes |
| Business data | Application data, configuration and stores exposed by a Service capability |
| Active probes | Controlled HTTP requests and other actions needed to reproduce a problem |
| Performance | Problems that appear only under load, with requests correlated to traces, metrics and logs |
| Agent applications | Model and MCP configuration, connectivity, calls and service-side evidence |

Some investigations need tools or permissions that are not already present in the application container.
`doctor image`, `doctor debug` and `doctor install` explicitly prepare a diagnostic image, temporary debug
environment or tool before collection. Doctor shows and confirms operations that can change the target.

## How Doctor understands an application

An application is described as a set of Services. Each Service can expose Capabilities: typed contracts
for data, metrics, logs, HTTP cases, models, MCP servers or other application-specific diagnostics. A
Capability also declares the target data and access Doctor needs before it can run.

Generic Kubernetes access, collectors, evidence and reports live in Doctor Core. A versioned Plugin adds
the Service catalog and business-specific Capabilities without putting private protocols or schemas into
the open-source CLI.

This supports two kinds of investigation:

- Deterministic commands collect evidence, run repeatable checks and produce offline reports. Reusable
  diagnostics stay in Core; application-specific knowledge stays in the Plugin.
- `doctor chat` handles open-ended questions with a model, scoped tools and the selected Plugin's Skills,
  so the conversation can use the same application knowledge as deterministic commands.

## Repository layout

| Path | Purpose |
|---|---|
| `cli/` | Doctor Core CLI, collectors, evidence model and offline reports |
| `toolkit/` | Independently versioned diagnostic tools, debug images and offline system packages |
| `server/` | Host boundary for an optional Doctor server |
| `packages/agent/` | Agent runtime shared by local chat and server hosts |
| `packages/plugin/` | Public Plugin, Service and Capability contracts |
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

Build a Toolkit slice for one execution platform, all slices separately, or one combined archive:

```bash
make -C toolkit build OS=linux ARCH=arm64
make -C toolkit build-matrix
make -C toolkit build-all
```

Core does not embed Toolkit executables. Copy a matching `doctor-toolkit-*.tar` beside Doctor or
into the working directory; a combined archive may serve a Host and Kubernetes Targets with
different platforms.

To teach Doctor about a specific application, start with [`plugins/example`](plugins/example) and implement
a Plugin that describes its Services, Capabilities and Skills.

For design details, see [`cli/docs/kernel.md`](cli/docs/kernel.md),
[`cli/docs/plugin.md`](cli/docs/plugin.md) and [`docs/chat.md`](docs/chat.md).
