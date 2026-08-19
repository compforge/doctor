.DEFAULT_GOAL := build

.PHONY: deps build-deps check-plugin-version bump-plugin-version lint lint-ci lint-cli lint-agent lint-plugin-sdk lint-example-plugin lint-spec test test-cli test-agent test-plugin-sdk build build-local toolkit toolkit-all toolkit-matrix install clean

ROOT_DIR := $(abspath .)
DIST_DIR := $(ROOT_DIR)/dist
BIN_DIR ?= $(HOME)/.local/bin
PLUGIN ?= example
PLUGIN_ROOT := $(ROOT_DIR)/plugins/$(PLUGIN)
PLUGIN_VERSION_TOOL := $(ROOT_DIR)/packages/plugin/scripts/version.ts
PLUGIN_VERSION_ARGS := $(if $(VERSION),--version $(VERSION),)
CHECK_JOBS ?= 4
TEST_FILES ?=

deps:
	bun install --frozen-lockfile

# build-all cross-compiles Darwin/Linux x64/arm64 and needs every OpenTUI native package.
# Bun does not materialize newly requested optional platforms into a reused install without --force.
build-deps: deps
	bun install --force --frozen-lockfile --os='*' --cpu='*'
	@test -x "$(ROOT_DIR)/cli/node_modules/node/bin/node" || \
		bun install --force --frozen-lockfile --os='*' --cpu='*'

check-plugin-version:
	bun $(PLUGIN_VERSION_TOOL) check $(PLUGIN_ROOT)

bump-plugin-version:
	bun $(PLUGIN_VERSION_TOOL) bump $(PLUGIN_ROOT) $(PLUGIN_VERSION_ARGS)

lint:
	$(MAKE) --no-print-directory -j$(CHECK_JOBS) lint-cli lint-agent lint-plugin-sdk lint-example-plugin check-plugin-version

lint-ci: lint

lint-cli:
	bun run typecheck:cli

lint-agent:
	bun run typecheck:agent

lint-plugin-sdk:
	bun run typecheck:plugin-sdk

lint-example-plugin:
	bun run typecheck:example-plugin

lint-spec:
	bun run specgen:check

ifneq ($(strip $(TEST_FILES)),)
test:
	bun test $(TEST_FILES)
else
test:
	$(MAKE) --no-print-directory -j$(CHECK_JOBS) test-cli test-agent test-plugin-sdk
endif

test-cli:
	bun run test:cli

test-agent:
	bun run test:agent

test-plugin-sdk:
	bun run test:plugin-sdk

build: build-deps check-plugin-version
	rm -rf $(DIST_DIR)
	@mkdir -p $(DIST_DIR)
	$(MAKE) -C cli build-all DIST_DIR=$(DIST_DIR)

build-local: deps check-plugin-version
	rm -rf $(DIST_DIR)
	@mkdir -p $(DIST_DIR)
	$(MAKE) -C cli build-mac DIST_DIR=$(DIST_DIR)

toolkit:
	$(MAKE) -C toolkit build $(if $(OS),OS=$(OS)) $(if $(ARCH),ARCH=$(ARCH)) DIST_DIR=$(DIST_DIR)

toolkit-all:
	$(MAKE) -C toolkit build-all DIST_DIR=$(DIST_DIR)

toolkit-matrix:
	$(MAKE) -C toolkit build-matrix DIST_DIR=$(DIST_DIR)

install: build-local
	@mkdir -p $(BIN_DIR)
	install -m 755 $(DIST_DIR)/doctor $(BIN_DIR)/doctor
	@echo "installed: $(BIN_DIR)/doctor"

clean:
	rm -rf $(DIST_DIR)
