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
ARG PYDUMP_VERSION=0.1.0
LABEL org.opencontainers.image.title="doctor debug image" \
      org.opencontainers.image.version="${DOCTOR_TOOLKIT_VERSION}" \
      org.opencontainers.image.description="Reusable ephemeral diagnostics toolkit"
RUN apk add --no-cache \
      bind-tools \
      curl \
      gdb \
      iproute2 \
      iptables \
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
    && mkdir -p /opt/doctor/bin /opt/doctor/lib/pydump
COPY --from=austin-builder /out/austin /opt/doctor/bin/austin
COPY image/net-capture.py /opt/doctor/bin/net-capture
COPY assets/py-spy/*.gz /tmp/py-spy/
COPY assets/pydump/ /tmp/pydump/
RUN case "$TARGETARCH" in \
      amd64) machine=x86_64 ;; \
      arm64) machine=aarch64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && gzip -dc "/tmp/py-spy/py-spy-0.4.2-$machine.gz" > /opt/doctor/bin/py-spy \
    && gzip -dc /tmp/pydump/pydump-0.1.0.pyz.gz > /opt/doctor/bin/pydump \
    && gzip -dc "/tmp/pydump/pydump_analyzer-0.1.0-linux-$TARGETARCH.gz" > /opt/doctor/bin/pydump_analyzer \
    && for minor in 3.10 3.11 3.12 3.13 3.14; do \
      gzip -dc "/tmp/pydump/pydump-agent-$minor-min-glibc-2.17-$machine.so.gz" > "/opt/doctor/lib/pydump/pydump-agent-$minor-min-glibc-2.17-$machine.so"; \
    done \
    && chmod 755 /opt/doctor/bin/py-spy \
    && chmod 755 /opt/doctor/bin/pydump \
    && chmod 755 /opt/doctor/bin/pydump_analyzer \
    && chmod 755 /opt/doctor/lib/pydump/*.so \
    && chmod 755 /opt/doctor/bin/net-capture \
    && rm -rf /tmp/py-spy /tmp/pydump \
    && printf '{"schema":"doctor.debug.image","version":1,"toolkit_version":"%s","platform":"linux/%s","tools":{"austin":"%s","curl":true,"dns":true,"gdb":true,"iproute2":true,"iptables":true,"iputils":true,"jq":true,"mtr":true,"net_capture":true,"netcat":true,"openssl":true,"python3":true,"py_spy":"%s","pydump":"%s","pydump_analyzer":"%s","pydump_agents":"3.10-3.14/min-glibc-2.17","socat":true,"strace":true,"tcpdump":true,"tcptraceroute":true}}\n' \
      "$DOCTOR_TOOLKIT_VERSION" "$TARGETARCH" "$AUSTIN_VERSION" "$PY_SPY_VERSION" "$PYDUMP_VERSION" "$PYDUMP_VERSION" > /opt/doctor/manifest.json \
    && for command in curl dig host ip iptables jq mtr nc nslookup openssl ping socat ss strace tcpdump tcptraceroute; do command -v "$command" >/dev/null; done \
    && python3 --version \
    && gdb --version \
    && /opt/doctor/bin/austin --version \
    && /opt/doctor/bin/py-spy --version \
    && /opt/doctor/bin/pydump --help >/dev/null \
    && /opt/doctor/bin/pydump_analyzer retained-heap --help >/dev/null \
    && /opt/doctor/bin/net-capture --help >/dev/null \
    && tcpdump --version
CMD ["sh", "-c", "sleep 3600"]
