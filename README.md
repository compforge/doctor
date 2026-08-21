# Doctor

[English](README.md) | [简体中文](README_CN.md)

> Application-aware diagnostics for Kubernetes applications.

Doctor is an enhanced `kubectl` for diagnosing applications. `kubectl` understands Kubernetes objects;
Doctor understands a Kubernetes application as a set of Services. A Service is Doctor's basic diagnostic
unit, while Pods, containers and processes are its runtime targets and evidence sources.

Doctor runs as a local CLI on a Doctor Host with scoped access to the target Kubernetes environment and
application. It returns raw evidence and offline reports to the same machine.

![Doctor running from a customer-site Linux machine](docs/doctor-usage.svg)

## How Doctor diagnoses an application

Doctor starts from the Services that make up an application, then moves from broad service facts to the
evidence needed for a specific problem:

![Doctor Command diagnostic flow](docs/doctor-diagnostic-flow.svg)

| Diagnostic surface | Commands | What Doctor investigates |
|---|---|---|
| Service state | `doctor inspect` | Matching Pods and containers, images, readiness, restarts, termination state, CPU/memory requests and limits, and selected configuration |
| Business data | `doctor tenant`, `doctor data` | Tenant-scoped contributions plus business-ID-linked data contributed by Services |
| Observability | `doctor trace`, `doctor log`, `doctor metric` | A request's path, related service logs and metrics over the diagnostic window |
| Runtime forensics | `doctor cpu`, `doctor mem`, `doctor net` | Thread stacks, heap captures and packet captures for a specific Service runtime |
| Agent applications | `doctor model`, `doctor mcp` | Model and MCP configuration, connectivity, calls and service-side evidence |

`doctor inspect` reports observed workload facts rather than reducing them to a single healthy/unhealthy
flag. Resource values shown there are Kubernetes requests and limits; actual usage belongs to metric and
runtime diagnostics.

Business data is organized by lookup scope:

- **Tenant**: `doctor tenant` gathers safe tenant-scoped contributions declared by the active Plugin.
- **User**: user-linked data; a general user-scoped collector is not yet available.
- **Business ID**: `doctor data` gathers records contributed by Services and correlates them from a
  conversation, request or other business identifier.

## Workflows across evidence

- `doctor collect` runs selected Inspect, Tenant, Data, Trace, Log and Metric collectors and combines their
  reports into one offline delivery. Tenant and business identifiers remain inputs to their corresponding
  collectors; Collect does not infer relationships between scopes, create load or change individual
  command semantics.
- `doctor http` executes a controlled request when reproducing the problem requires an active probe.
- `doctor eval` executes each selected canonical Case once and captures its protocol observation plus
  correlated Trace, Log and business Data. It preserves the CaseSet for downstream evaluators but does
  not score answer quality or interpret `judge.eval`.
- `doctor perf` generates bounded application load, records request outcomes and correlates the load
  window with Metric plus representative Trace and Log evidence. Because it creates real traffic and may
  have business or model cost, it is always an explicit, confirmed workflow.
- `doctor chat` handles open-ended questions with a model, scoped tools and the selected Plugin's Skills,
  using the same application knowledge as deterministic commands.

Some investigations need tools or permissions that are not already present in the application container.
`doctor image`, `doctor debug` and `doctor install` explicitly prepare a diagnostic image, temporary debug
environment or tool. Doctor shows and confirms operations that can change the target; preparation is not
hidden inside a read-only collection.

## Core and Plugins

Doctor Core is business-neutral. It owns Kubernetes access, common collectors and runtime tools, evidence
orchestration, analysis and delivery. It contains no application-specific Service names, private protocols
or schemas.

A versioned Plugin describes the application's Service catalog. Each Service can expose Capabilities as
business extensions to the same Core flow: an Inspect Capability maps a Query to Facts (including Relation),
while a Probe Capability maps one scheduled Input to an Observation. A Capability contributes business
semantics and declares the target data and access Doctor must prepare before it runs; Command and Harness
code still own scheduling, authorization, Evidence and delivery.

For a typical investigation, start with `doctor inspect`, use `doctor collect` to gather the relevant
tenant, business and observability evidence, then run a targeted runtime or Agent command if the combined
evidence points to a specific Service or protocol.

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
