.PHONY: dev build build-all build-mac build-darwin-arm64 build-darwin-x64 prepare-dist bump-version build-linux build-linux-x64 build-linux-x64-modern build-linux-x64-legacy build-linux-arm64 build-kylin build-kylin-arm64 build-kylin-x86-64 lint lint-ci test typecheck deps install clean

# 安装目录默认 ~/.local/bin（用户可写、常在 PATH）；可用 BIN_DIR 覆盖，如 make install BIN_DIR=/opt/homebrew/bin
BIN_DIR ?= $(HOME)/.local/bin
DIST_DIR ?= dist
DOCTOR_ENTRY ?= $(abspath src/app/entry.ts)
DOCTOR_CLI_VERSION ?= $(shell sed -n 's/^export const DOCTOR_CLI_VERSION = "\([^"]*\)";/\1/p' src/app/version.ts)
DOCTOR_ARTIFACT_PREFIX := doctor-$(DOCTOR_CLI_VERSION)
TEST_FILES ?=

deps:
	bun install

# 默认递增 patch；也可通过 `make bump-version VERSION=1.2.3` 指定版本。
bump-version:
	bun scripts/bump-version.ts $(VERSION)

# 编译并安装到本机 PATH：make install && doctor version
install: build-mac
	@mkdir -p $(BIN_DIR)
	install -m 755 $(DIST_DIR)/doctor $(BIN_DIR)/doctor
	@echo "installed: $(BIN_DIR)/doctor"

dev:
	bun run --watch $(DOCTOR_ENTRY)

# Core 只构建 CLI；诊断工具、image 与系统包由根目录 toolkit/ 独立发布。
build:
	rm -rf $(DIST_DIR)
	$(MAKE) build-all

prepare-dist:
	@mkdir -p $(DIST_DIR)

build-mac: prepare-dist
	bun scripts/build-bun-doctor.ts --entry $(DOCTOR_ENTRY) --target bun-darwin-arm64 --outfile $(DIST_DIR)/doctor

# 一键产出全部受支持平台的独立 binary，文件名可直接区分 OS / arch 后分发。
build-all: build-darwin-arm64 build-darwin-x64 build-linux build-kylin

build-darwin-arm64: prepare-dist
	bun scripts/build-bun-doctor.ts --entry $(DOCTOR_ENTRY) --target bun-darwin-arm64 --outfile $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-darwin-arm64

build-darwin-x64: prepare-dist
	bun scripts/build-bun-doctor.ts --entry $(DOCTOR_ENTRY) --target bun-darwin-x64 --outfile $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-darwin-x64

# doctor collect 面向客户现场运维机（多为 Linux），交叉编译产出独立 binary。
build-linux: build-linux-x64 build-linux-arm64

build-linux-x64: build-linux-x64-modern build-linux-x64-legacy

build-linux-x64-modern: prepare-dist
	bun scripts/build-bun-doctor.ts --entry $(DOCTOR_ENTRY) --target bun-linux-x64-baseline --outfile $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-debian-x64-kernel-5.6-glibc-2.25

build-linux-x64-legacy: prepare-dist
	DOCTOR_ENTRY=$(DOCTOR_ENTRY) bash scripts/build-linux-x64-legacy.sh $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-debian-x64-kernel-3.10-glibc-2.17

build-linux-arm64: prepare-dist
	bun scripts/build-bun-doctor.ts --entry $(DOCTOR_ENTRY) --target bun-linux-arm64 --outfile $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-debian-arm64-kernel-5.6-glibc-2.25

# 银河麒麟 V10（kernel 4.19 / glibc 2.28）直接交付产物。
build-kylin: build-kylin-arm64 build-kylin-x86-64

build-kylin-arm64: prepare-dist
	DOCTOR_ENTRY=$(DOCTOR_ENTRY) bash scripts/build-linux-arm64-kylin.sh $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-kylin-arm64-kernel-4.19-glibc-2.28

build-kylin-x86-64: prepare-dist
	DOCTOR_ENTRY=$(DOCTOR_ENTRY) bash scripts/build-linux-x64-legacy.sh $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-kylin-x86-64-kernel-4.19-glibc-2.28

test:
	bun test $(TEST_FILES)

typecheck:
	bunx tsc --noEmit

lint: typecheck

lint-ci: lint

clean:
	rm -rf $(DIST_DIR) node_modules
