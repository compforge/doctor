# Doctor

[English](README.md) | [简体中文](README_CN.md)

> Application-aware diagnostics for Kubernetes applications.

Doctor is an enhanced `kubectl` for diagnosing applications. It understands an application as a set of
Services, connects to their runtime instances, and delivers evidence and offline reports to your machine.
A Plugin supplies the application's Service catalog and business knowledge; Core provides the diagnostic tools.

## From deployment to investigation

| When | Command | What you get |
|---|---|---|
| After deployment, before serving traffic | `doctor health` | Active checks of startup, dependency connectivity and business functionality |
| After the system has been running | `doctor overview` | Errors, diagnostic patterns and duration distributions over a time window, with optional representative samples |
| When a problem needs investigation | `doctor collect` | Related configuration, business data, traces, logs and metrics in one evidence bundle |

Start at the stage that matches your situation. You can also run a focused command such as `inspect`,
`trace`, `log` or `data` directly; CPU, memory and network investigations have their own tools.
Read the [diagnostic workflow](cli/docs/kernel.md#排查主线) for how these paths fit together.

```bash
doctor health --scope self,deps
doctor overview --since 1h
doctor collect <biz-id> --include data,trace,log
```

Available checks and data depend on the active Plugin and target access. Use `doctor plugin` to inspect
the Service catalog and `doctor <command> --help` for options. Operations that change the target require confirmation.

## Build and start

Requirements: [Bun](https://bun.sh/) and Go. From the repository root:

```bash
make deps
make build-local
./dist/doctor --help
```

`make build-local` builds the local macOS artifact; `make build` builds platform artifacts into `dist/`.
Use a distribution with your application's Plugin, or follow the [Plugin guide](cli/docs/plugin.md) to add one.
For development checks, run `make lint-all` and `make test-all`.

## Learn more

- [CLI usage and build options](cli/README.md) · [Custom distributions](cli/docs/distribution.md)
- [Health](cli/docs/commands/health.md) · [Overview](cli/docs/commands/overview.md) · [Collect](cli/docs/commands/collect.md)
- [Plugin contracts](cli/docs/plugin.md) · [Example Plugin](plugins/example) · [Toolkit](toolkit/README.md)
- [Kernel and evidence flow](cli/docs/kernel.md) · [Chat](docs/chat.md) · [Repository map](AGENTS.md)
