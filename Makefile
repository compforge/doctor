.DEFAULT_GOAL := build

.PHONY: deps build build-local install clean

ROOT_DIR := $(abspath .)
DIST_DIR := $(ROOT_DIR)/dist
BIN_DIR ?= $(HOME)/.local/bin

deps:
	bun install --frozen-lockfile

build: deps
	rm -rf $(DIST_DIR)
	@mkdir -p $(DIST_DIR)
	$(MAKE) -C cli build-all DIST_DIR=$(DIST_DIR)

build-local: deps
	rm -rf $(DIST_DIR)
	@mkdir -p $(DIST_DIR)
	$(MAKE) -C cli build-mac DIST_DIR=$(DIST_DIR)

install: build-local
	@mkdir -p $(BIN_DIR)
	install -m 755 $(DIST_DIR)/doctor $(BIN_DIR)/doctor
	@echo "installed: $(BIN_DIR)/doctor"

clean:
	rm -rf $(DIST_DIR)

