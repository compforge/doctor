.DEFAULT_GOAL := build

.PHONY: build clean

PLUGIN_ROOT := $(abspath .)
DOCTOR_ROOT := $(abspath ../..)

build:
	bun $(DOCTOR_ROOT)/packages/plugin/scripts/pack.ts $(PLUGIN_ROOT)

clean:
	rm -rf $(PLUGIN_ROOT)/dist
