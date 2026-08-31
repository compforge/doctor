.DEFAULT_GOAL := build

.PHONY: build clean fix lint lint-ci test

PLUGIN_ROOT := $(abspath .)
DOCTOR_ROOT := $(abspath ../..)

build:
	bun $(DOCTOR_ROOT)/packages/plugin/scripts/pack.ts $(PLUGIN_ROOT)

clean:
	rm -rf $(PLUGIN_ROOT)/dist

fix:
	@true

lint:
	bun run typecheck

lint-ci: lint

test:
	bun ../../packages/plugin/scripts/version.ts check .
