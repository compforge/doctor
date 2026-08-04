.PHONY: dev build build-all build-mac build-darwin-arm64 build-darwin-x64 prepare-dist bump-version build-linux build-linux-x64 build-linux-x64-modern build-linux-x64-legacy build-linux-arm64 build-kylin build-kylin-arm64 build-kylin-x86-64 build-gopacket-assets build-gopacket-darwin-arm64 build-gopacket-darwin-amd64 build-gopacket-linux-amd64 build-gopacket-linux-arm64 build-debug-images build-debug-linux-amd64 build-debug-linux-arm64 build-gdb-package-bundles build-gdb-package-linux-amd64 build-gdb-package-linux-arm64 test typecheck deps install clean

# 安装目录默认 ~/.local/bin（用户可写、常在 PATH）；可用 BIN_DIR 覆盖，如 make install BIN_DIR=/opt/homebrew/bin
BIN_DIR ?= $(HOME)/.local/bin
DIST_DIR ?= dist
DOCTOR_ENTRY ?= $(abspath src/app/entry.ts)
DOCTOR_DEBUG_IMAGE ?= $(shell sed -n 's/^export const DOCTOR_DEBUG_IMAGE = "\([^"]*\)";/\1/p' src/app/resolve-debug-image.ts)
DOCTOR_DEBUG_TAG ?= $(shell tr -d '[:space:]' < docker/debug/VERSION)
DOCTOR_PACKAGE_BUNDLE_VERSION ?= $(shell tr -d '[:space:]' < package-bundles/VERSION)
DOCTOR_CLI_VERSION ?= $(shell sed -n 's/^export const DOCTOR_CLI_VERSION = "\([^"]*\)";/\1/p' src/app/version.ts)
DOCTOR_ARTIFACT_PREFIX := doctor-$(DOCTOR_CLI_VERSION)
DOCTOR_DEBUG_BASE_IMAGE ?= alpine:3.22.5
GOPACKET_DIR := src/infra/host/network-analysis/gopacket
GOPACKET_ASSET_DIR := $(abspath assets/gopacket)

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

# 发布构建默认产出完整 OS / arch / runtime baseline 矩阵；每个 Doctor 只内嵌匹配平台的 regctl。
build:
	rm -rf $(DIST_DIR)
	$(MAKE) build-all

prepare-dist:
	@mkdir -p $(DIST_DIR)
	rm -f $(DIST_DIR)/doctor-regctl-* $(DIST_DIR)/regclient-LICENSE.txt
	cp assets/regctl/regclient-LICENSE.txt $(DIST_DIR)/THIRD_PARTY_LICENSES.txt
	printf '\n\n===== gopacket (BSD-3-Clause) =====\n\n' >> $(DIST_DIR)/THIRD_PARTY_LICENSES.txt
	cat assets/gopacket/gopacket-LICENSE.txt >> $(DIST_DIR)/THIRD_PARTY_LICENSES.txt

build-mac: prepare-dist build-gopacket-darwin-arm64
	bun scripts/build-bun-doctor.ts --entry $(DOCTOR_ENTRY) --target bun-darwin-arm64 --outfile $(DIST_DIR)/doctor --regctl assets/regctl/regctl-darwin-arm64 --gopacket assets/gopacket/doctor-pcap-darwin-arm64 --pyheap-dumper assets/pyheap/pyheap_dump-0.7.0+doctor.2.gz --pyheap-analyzer assets/pyheap/pyheap_analyzer-0.7.0+doctor.2.gz

# 一键产出全部受支持平台的独立 binary，文件名可直接区分 OS / arch 后分发
build-all: build-darwin-arm64 build-darwin-x64 build-linux build-kylin

build-darwin-arm64: prepare-dist build-gopacket-darwin-arm64
	bun scripts/build-bun-doctor.ts --entry $(DOCTOR_ENTRY) --target bun-darwin-arm64 --outfile $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-darwin-arm64 --regctl assets/regctl/regctl-darwin-arm64 --gopacket assets/gopacket/doctor-pcap-darwin-arm64 --pyheap-dumper assets/pyheap/pyheap_dump-0.7.0+doctor.2.gz --pyheap-analyzer assets/pyheap/pyheap_analyzer-0.7.0+doctor.2.gz

build-darwin-x64: prepare-dist build-gopacket-darwin-amd64
	bun scripts/build-bun-doctor.ts --entry $(DOCTOR_ENTRY) --target bun-darwin-x64 --outfile $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-darwin-x64 --regctl assets/regctl/regctl-darwin-amd64 --gopacket assets/gopacket/doctor-pcap-darwin-amd64 --pyheap-dumper assets/pyheap/pyheap_dump-0.7.0+doctor.2.gz --pyheap-analyzer assets/pyheap/pyheap_analyzer-0.7.0+doctor.2.gz

# doctor collect 面向客户现场运维机（多为 Linux），交叉编译产出独立 binary
build-linux: build-linux-x64 build-linux-arm64

build-linux-x64: build-linux-x64-modern build-linux-x64-legacy

build-linux-x64-modern: prepare-dist build-gopacket-linux-amd64
	bun scripts/build-bun-doctor.ts --entry $(DOCTOR_ENTRY) --target bun-linux-x64-baseline --outfile $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-linux-x64-kernel-5.6-glibc-2.25 --regctl assets/regctl/regctl-linux-amd64 --gopacket assets/gopacket/doctor-pcap-linux-amd64 --pyheap-dumper assets/pyheap/pyheap_dump-0.7.0+doctor.2.gz --pyheap-analyzer assets/pyheap/pyheap_analyzer-0.7.0+doctor.2.gz

build-linux-x64-legacy: prepare-dist build-gopacket-linux-amd64
	DOCTOR_ENTRY=$(DOCTOR_ENTRY) bash scripts/build-linux-x64-legacy.sh $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-linux-x64-kernel-3.10-glibc-2.17

build-linux-arm64: prepare-dist build-gopacket-linux-arm64
	bun scripts/build-bun-doctor.ts --entry $(DOCTOR_ENTRY) --target bun-linux-arm64 --outfile $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-linux-arm64-kernel-5.6-glibc-2.25 --regctl assets/regctl/regctl-linux-arm64 --gopacket assets/gopacket/doctor-pcap-linux-arm64 --pyheap-dumper assets/pyheap/pyheap_dump-0.7.0+doctor.2.gz --pyheap-analyzer assets/pyheap/pyheap_analyzer-0.7.0+doctor.2.gz

build-gopacket-assets: build-gopacket-darwin-arm64 build-gopacket-darwin-amd64 build-gopacket-linux-amd64 build-gopacket-linux-arm64

build-gopacket-darwin-arm64:
	@mkdir -p $(GOPACKET_ASSET_DIR)
	env CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go -C $(GOPACKET_DIR) build -trimpath -ldflags='-s -w' -o $(GOPACKET_ASSET_DIR)/doctor-pcap-darwin-arm64 ./cmd/doctor-pcap

build-gopacket-darwin-amd64:
	@mkdir -p $(GOPACKET_ASSET_DIR)
	env CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go -C $(GOPACKET_DIR) build -trimpath -ldflags='-s -w' -o $(GOPACKET_ASSET_DIR)/doctor-pcap-darwin-amd64 ./cmd/doctor-pcap

build-gopacket-linux-amd64:
	@mkdir -p $(GOPACKET_ASSET_DIR)
	env CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C $(GOPACKET_DIR) build -trimpath -ldflags='-s -w' -o $(GOPACKET_ASSET_DIR)/doctor-pcap-linux-amd64 ./cmd/doctor-pcap

build-gopacket-linux-arm64:
	@mkdir -p $(GOPACKET_ASSET_DIR)
	env CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go -C $(GOPACKET_DIR) build -trimpath -ldflags='-s -w' -o $(GOPACKET_ASSET_DIR)/doctor-pcap-linux-arm64 ./cmd/doctor-pcap

# 银河麒麟 V10（kernel 4.19 / glibc 2.28）直接交付产物。
build-kylin: build-kylin-arm64 build-kylin-x86-64

build-kylin-arm64: prepare-dist build-gopacket-linux-arm64
	DOCTOR_ENTRY=$(DOCTOR_ENTRY) bash scripts/build-linux-arm64-kylin.sh $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-kylin-arm64

build-kylin-x86-64: prepare-dist build-gopacket-linux-amd64
	DOCTOR_ENTRY=$(DOCTOR_ENTRY) bash scripts/build-linux-x64-legacy.sh $(DIST_DIR)/$(DOCTOR_ARTIFACT_PREFIX)-kylin-x86-64

# 同时构建 amd64/arm64；一个架构对应一个可由 docker/podman load 的 image tar。
build-debug-images: build-debug-linux-amd64 build-debug-linux-arm64

build-debug-linux-amd64:
	@mkdir -p $(DIST_DIR)
	docker buildx build --platform linux/amd64 \
		--build-arg DOCTOR_DEBUG_BASE_IMAGE=$(DOCTOR_DEBUG_BASE_IMAGE) \
		--build-arg DOCTOR_DEBUG_VERSION=$(DOCTOR_DEBUG_TAG) \
		--build-arg DOCTOR_CLI_VERSION=$(DOCTOR_CLI_VERSION) \
		--tag $(DOCTOR_DEBUG_IMAGE):$(DOCTOR_DEBUG_TAG)-linux-amd64 \
		--output type=docker,dest=$(DIST_DIR)/doctor-debug-linux-amd64.tar \
		-f docker/debug/Dockerfile .

build-debug-linux-arm64:
	@mkdir -p $(DIST_DIR)
	docker buildx build --platform linux/arm64 \
		--build-arg DOCTOR_DEBUG_BASE_IMAGE=$(DOCTOR_DEBUG_BASE_IMAGE) \
		--build-arg DOCTOR_DEBUG_VERSION=$(DOCTOR_DEBUG_TAG) \
		--build-arg DOCTOR_CLI_VERSION=$(DOCTOR_CLI_VERSION) \
		--tag $(DOCTOR_DEBUG_IMAGE):$(DOCTOR_DEBUG_TAG)-linux-arm64 \
		--output type=docker,dest=$(DIST_DIR)/doctor-debug-linux-arm64.tar \
		-f docker/debug/Dockerfile .

# Debian 12 GDB 离线仓；对外只交付一个 package set，运行时按 Target 选择并提取内部 variant。
build-gdb-package-bundles:
	DOCTOR_PACKAGE_BUNDLE_VERSION=$(DOCTOR_PACKAGE_BUNDLE_VERSION) bash scripts/build-gdb-package-set.sh

# 以下单架构 target 只用于构建、验证独立的 v1 variant。
build-gdb-package-linux-amd64:
	DOCTOR_PACKAGE_BUNDLE_VERSION=$(DOCTOR_PACKAGE_BUNDLE_VERSION) bash scripts/build-package-bundle.sh amd64

build-gdb-package-linux-arm64:
	DOCTOR_PACKAGE_BUNDLE_VERSION=$(DOCTOR_PACKAGE_BUNDLE_VERSION) bash scripts/build-package-bundle.sh arm64

test:
	bun test

typecheck:
	bunx tsc --noEmit

clean:
	rm -rf $(DIST_DIR) node_modules
