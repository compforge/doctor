.PHONY: build build-all build-matrix bump-version stage-platform stage-tools stage-debug-image stage-packages clean

TOOLKIT_VERSION := $(shell tr -d '[:space:]' < VERSION)
OS ?= $(shell go env GOOS)
ARCH ?= $(shell go env GOARCH)
DIST_DIR ?= dist
STAGE_ROOT ?=
DOCTOR_DEBUG_IMAGE ?= doctor-debug
DOCTOR_DEBUG_BASE_IMAGE ?= alpine:3.22.5
INCLUDE_DEBUG_IMAGE ?= false
DOCTOR_GDB_BUILD_JOBS ?= 8
REUSE_RELEASE_ASSETS ?= true
DOCTOR_TOOLKIT_RELEASE_REPOSITORY ?= compforge/doctor
DOCTOR_TOOLKIT_CACHE_DIR ?=

SUPPORTED_PLATFORMS := darwin/amd64 darwin/arm64 linux/amd64 linux/arm64
empty :=
space := $(empty) $(empty)

build:
	bash scripts/build-toolkit.sh "$(abspath $(DIST_DIR))/doctor-toolkit-$(TOOLKIT_VERSION)-$(OS)-$(ARCH).tar" "$(OS)/$(ARCH)"

build-all:
	bash scripts/build-toolkit.sh "$(abspath $(DIST_DIR))/doctor-toolkit-$(TOOLKIT_VERSION)-all.tar" $(SUPPORTED_PLATFORMS)

build-matrix:
	@for platform in $(SUPPORTED_PLATFORMS); do \
		os="$${platform%/*}"; arch="$${platform#*/}"; \
		$(MAKE) --no-print-directory build OS="$$os" ARCH="$$arch" DIST_DIR="$(abspath $(DIST_DIR))" || exit $$?; \
	done

bump-version:
	bun scripts/bump-version.ts $(VERSION)

stage-platform: stage-tools
	@if [ "$(OS)" = linux ]; then \
		if [ "$(INCLUDE_DEBUG_IMAGE)" = true ]; then \
			$(MAKE) --no-print-directory stage-debug-image OS="$(OS)" ARCH="$(ARCH)" STAGE_ROOT="$(STAGE_ROOT)"; \
		fi; \
		$(MAKE) --no-print-directory stage-packages OS="$(OS)" ARCH="$(ARCH)" STAGE_ROOT="$(STAGE_ROOT)"; \
	fi

stage-tools:
	@test -n "$(STAGE_ROOT)" || { echo "STAGE_ROOT is required" >&2; exit 1; }
	@case "$(OS)/$(ARCH)" in $(subst $(space),|,$(SUPPORTED_PLATFORMS))) ;; *) echo "unsupported platform: $(OS)/$(ARCH)" >&2; exit 1 ;; esac
	@mkdir -p "$(STAGE_ROOT)/doctor-toolkit/platforms/$(OS)-$(ARCH)/bin"
	cp "assets/regctl/regctl-$(OS)-$(ARCH)" "$(STAGE_ROOT)/doctor-toolkit/platforms/$(OS)-$(ARCH)/bin/regctl"
	env CGO_ENABLED=0 GOOS="$(OS)" GOARCH="$(ARCH)" go -C doctor-pcap build -trimpath -ldflags='-s -w' -o "$(STAGE_ROOT)/doctor-toolkit/platforms/$(OS)-$(ARCH)/bin/doctor-pcap" ./cmd/doctor-pcap
	gzip -dc "assets/pydump/pydump_analyzer-0.1.0-$(OS)-$(ARCH).gz" > "$(STAGE_ROOT)/doctor-toolkit/platforms/$(OS)-$(ARCH)/bin/pydump_analyzer"
	chmod 755 "$(STAGE_ROOT)/doctor-toolkit/platforms/$(OS)-$(ARCH)/bin/"*
	@if [ "$(OS)" = linux ]; then \
		case "$(ARCH)" in amd64) py_spy=x86_64 ;; arm64) py_spy=aarch64 ;; esac; \
		gzip -dc assets/fork-pyheap/pyheap_dump-0.7.0+doctor.2.gz > "$(STAGE_ROOT)/doctor-toolkit/platforms/$(OS)-$(ARCH)/bin/pyheap_dump"; \
		gzip -dc "assets/py-spy/py-spy-0.4.2-$$py_spy.gz" > "$(STAGE_ROOT)/doctor-toolkit/platforms/$(OS)-$(ARCH)/bin/py-spy"; \
		chmod 755 "$(STAGE_ROOT)/doctor-toolkit/platforms/$(OS)-$(ARCH)/bin/"*; \
	fi

stage-debug-image:
	@test "$(OS)" = linux || { echo "debug image only supports linux" >&2; exit 1; }
	@mkdir -p "$(STAGE_ROOT)/doctor-toolkit/platforms/$(OS)-$(ARCH)/images"
	docker buildx build --platform "linux/$(ARCH)" \
		--build-arg DOCTOR_DEBUG_BASE_IMAGE="$(DOCTOR_DEBUG_BASE_IMAGE)" \
		--build-arg DOCTOR_TOOLKIT_VERSION="$(TOOLKIT_VERSION)" \
		--tag "$(DOCTOR_DEBUG_IMAGE):$(TOOLKIT_VERSION)-linux-$(ARCH)" \
		--output "type=docker,dest=$(STAGE_ROOT)/doctor-toolkit/platforms/$(OS)-$(ARCH)/images/doctor-debug.tar" \
		-f image/Dockerfile .

stage-packages:
	@test "$(OS)" = linux || { echo "offline packages only support linux" >&2; exit 1; }
	@mkdir -p "$(STAGE_ROOT)/doctor-toolkit/platforms/$(OS)-$(ARCH)/packages"
	REUSE_RELEASE_ASSETS="$(REUSE_RELEASE_ASSETS)" \
		DOCTOR_TOOLKIT_RELEASE_REPOSITORY="$(DOCTOR_TOOLKIT_RELEASE_REPOSITORY)" \
		DOCTOR_TOOLKIT_CACHE_DIR="$(DOCTOR_TOOLKIT_CACHE_DIR)" \
		DOCTOR_TOOLKIT_BUILD_INPUTS_DIR="$(STAGE_ROOT)/.build-inputs" \
		DOCTOR_TOOLKIT_VERSION="$(TOOLKIT_VERSION)" \
		DOCTOR_GDB_BUILD_JOBS="$(DOCTOR_GDB_BUILD_JOBS)" \
		bash scripts/build-package-set.sh "$(ARCH)" "$(STAGE_ROOT)/doctor-toolkit/platforms/$(OS)-$(ARCH)/packages"

clean:
	rm -rf "$(DIST_DIR)"
