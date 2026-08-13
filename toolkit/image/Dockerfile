ARG DOCTOR_DEBUG_BASE_IMAGE=alpine:3.22.5
FROM ${DOCTOR_DEBUG_BASE_IMAGE} AS austin-builder
ARG AUSTIN_VERSION=4.0.0
RUN apk add --no-cache argp-standalone autoconf automake build-base curl linux-headers tar \
    && curl -fsSL "https://github.com/P403n1x87/austin/archive/refs/tags/v${AUSTIN_VERSION}.tar.gz" | tar -xz -C /tmp \
    && cd "/tmp/austin-${AUSTIN_VERSION}" \
    && autoreconf -i && LIBS=-largp ./configure --disable-debug && make -j2 \
    && install -Dm755 src/austin /out/austin

FROM ${DOCTOR_DEBUG_BASE_IMAGE}
ARG DOCTOR_TOOLKIT_VERSION=dev
ARG TARGETARCH
ARG AUSTIN_VERSION=4.0.0
ARG PY_SPY_VERSION=0.4.2
ARG PYHEAP_VERSION=0.7.0+doctor.2
LABEL org.opencontainers.image.title="doctor debug image" \
      org.opencontainers.image.version="${DOCTOR_TOOLKIT_VERSION}" \
      org.opencontainers.image.description="Reusable ephemeral diagnostics toolkit"
RUN apk add --no-cache \
      bind-tools \
      curl \
      gdb \
      iproute2 \
      iputils \
      jq \
      mtr \
      netcat-openbsd \
      openssl \
      python3 \
      socat \
      strace \
      tcpdump \
      tcptraceroute \
    && mkdir -p /opt/doctor/bin
COPY --from=austin-builder /out/austin /opt/doctor/bin/austin
COPY image/net-capture.py /opt/doctor/bin/net-capture
COPY assets/py-spy/*.gz /tmp/py-spy/
COPY assets/pyheap/pyheap_dump-0.7.0+doctor.2.gz /tmp/pyheap_dump.gz
COPY assets/pyheap/pyheap_analyzer-0.7.0+doctor.2.gz /tmp/pyheap_analyzer.gz
RUN case "$TARGETARCH" in \
      amd64) py_spy_asset=/tmp/py-spy/py-spy-0.4.2-x86_64.gz ;; \
      arm64) py_spy_asset=/tmp/py-spy/py-spy-0.4.2-aarch64.gz ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && gzip -dc "$py_spy_asset" > /opt/doctor/bin/py-spy \
    && gzip -dc /tmp/pyheap_dump.gz > /opt/doctor/bin/pyheap_dump \
    && gzip -dc /tmp/pyheap_analyzer.gz > /opt/doctor/bin/pyheap_analyzer \
    && chmod 755 /opt/doctor/bin/py-spy \
    && chmod 755 /opt/doctor/bin/pyheap_dump \
    && chmod 755 /opt/doctor/bin/pyheap_analyzer \
    && chmod 755 /opt/doctor/bin/net-capture \
    && rm -rf /tmp/py-spy /tmp/pyheap_dump.gz /tmp/pyheap_analyzer.gz \
    && printf '{"schema":"doctor.debug.image","version":1,"toolkit_version":"%s","platform":"linux/%s","tools":{"austin":"%s","curl":true,"dns":true,"gdb":true,"iproute2":true,"iputils":true,"jq":true,"mtr":true,"net_capture":true,"netcat":true,"openssl":true,"python3":true,"py_spy":"%s","pyheap":"%s","pyheap_analyzer":"%s","socat":true,"strace":true,"tcpdump":true,"tcptraceroute":true}}\n' \
      "$DOCTOR_TOOLKIT_VERSION" "$TARGETARCH" "$AUSTIN_VERSION" "$PY_SPY_VERSION" "$PYHEAP_VERSION" "$PYHEAP_VERSION" > /opt/doctor/manifest.json \
    && for command in curl dig host ip jq mtr nc nslookup openssl ping socat ss strace tcpdump tcptraceroute; do command -v "$command" >/dev/null; done \
    && python3 --version \
    && gdb --batch --quiet -ex "python import sys; print(sys.version)" -ex quit \
    && /opt/doctor/bin/austin --version \
    && /opt/doctor/bin/py-spy --version \
    && /opt/doctor/bin/pyheap_dump --help >/dev/null \
    && /opt/doctor/bin/pyheap_analyzer retained-heap --help >/dev/null \
    && /opt/doctor/bin/net-capture --help >/dev/null \
    && tcpdump --version
CMD ["sh", "-c", "sleep 3600"]
