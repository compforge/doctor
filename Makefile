.DEFAULT_GOAL := build

.PHONY: deps check-plugin-version bump-plugin-version build build-local install clean

ROOT_DIR := $(abspath .)
DIST_DIR := $(ROOT_DIR)/dist
BIN_DIR ?= $(HOME)/.local/bin
PLUGIN ?= example
PLUGIN_ROOT := $(ROOT_DIR)/plugins/$(PLUGIN)
PLUGIN_VERSION_TOOL := $(ROOT_DIR)/packages/plugin/scripts/version.ts
PLUGIN_VERSION_ARGS := $(if $(VERSION),--version $(VERSION),)

deps:
	bun install --frozen-lockfile

check-plugin-version:
	bun $(PLUGIN_VERSION_TOOL) check $(PLUGIN_ROOT)

bump-plugin-version:
	bun $(PLUGIN_VERSION_TOOL) bump $(PLUGIN_ROOT) $(PLUGIN_VERSION_ARGS)

build: deps check-plugin-version
	rm -rf $(DIST_DIR)
	@mkdir -p $(DIST_DIR)
	$(MAKE) -C cli build-all DIST_DIR=$(DIST_DIR)

build-local: deps check-plugin-version
	rm -rf $(DIST_DIR)
	@mkdir -p $(DIST_DIR)
	$(MAKE) -C cli build-mac DIST_DIR=$(DIST_DIR)

install: build-local
	@mkdir -p $(BIN_DIR)
	install -m 755 $(DIST_DIR)/doctor $(BIN_DIR)/doctor
	@echo "installed: $(BIN_DIR)/doctor"

clean:
	rm -rf $(DIST_DIR)
