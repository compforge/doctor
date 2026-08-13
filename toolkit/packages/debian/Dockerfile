ARG DEBIAN_VERSION=12
ARG GDB_VERSION=17.2
ARG GDB_SHA256=1c036c0d72e4b3d1fb5c94c88632add6f9d76f4d7c4d2ea793c12a9f19a3228c
ARG GDB_BUILD_JOBS=8

# A newer Debian binary would also require a newer glibc/Python. Building in the
# target distro fixes the kernel-side GDB bug without changing the business image ABI.
FROM debian:${DEBIAN_VERSION}-slim AS gdb-builder
ARG GDB_VERSION
ARG GDB_SHA256
ARG GDB_BUILD_JOBS
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      libexpat1-dev \
      libgmp-dev \
      libmpfr-dev \
      libncurses-dev \
      libreadline-dev \
      python3-dev \
      texinfo \
      xz-utils \
      zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN (curl --retry 3 --retry-all-errors -fsSLo gdb.tar.xz \
      "https://mirrors.tuna.tsinghua.edu.cn/gnu/gdb/gdb-${GDB_VERSION}.tar.xz" \
      || curl --retry 3 --retry-all-errors -fsSLo gdb.tar.xz \
        "https://ftp.gnu.org/gnu/gdb/gdb-${GDB_VERSION}.tar.xz") \
    && printf '%s  %s\n' "$GDB_SHA256" gdb.tar.xz | sha256sum -c - \
    && tar -xf gdb.tar.xz
RUN mkdir build \
    && cd build \
    && "../gdb-${GDB_VERSION}/configure" \
      --prefix=/usr \
      --disable-binutils \
      --disable-gas \
      --disable-gold \
      --disable-gprofng \
      --disable-ld \
      --disable-sim \
      --disable-werror \
      --with-python=/usr/bin/python3 \
      --with-system-readline \
      --with-system-zlib \
      --without-babeltrace \
      --without-debuginfod \
      --without-guile \
      --without-intel-pt \
    && make -j"$GDB_BUILD_JOBS" all-gdb \
    && make DESTDIR=/package install-gdb \
    && strip --strip-unneeded /package/usr/bin/gdb
RUN architecture="$(dpkg --print-architecture)" \
    && mkdir -p /package/DEBIAN /out \
    && printf '%s\n' \
      'Package: gdb' \
      "Version: 1:${GDB_VERSION}-doctor1" \
      "Architecture: ${architecture}" \
      'Maintainer: Doctor <doctor@localhost>' \
      'Depends: libc6, libexpat1, libgmp10, libmpfr6, libncursesw6, libpython3.11, libreadline8, libstdc++6, zlib1g' \
      'Section: devel' \
      'Priority: optional' \
      'Description: GNU Debugger built by Doctor for Debian 12 Pydump capture' \
      > /package/DEBIAN/control \
    && dpkg-deb --root-owner-group --build /package \
      "/out/gdb_${GDB_VERSION}-doctor1_${architecture}.deb"

FROM debian:${DEBIAN_VERSION}-slim AS bundle
ARG DEBIAN_VERSION
ARG TARGETARCH
ARG PACKAGE_NAMES=gdb
ARG DOCTOR_TOOLKIT_VERSION=dev
ARG DOCTOR_KERNEL_MIN_INCLUSIVE
ARG DOCTOR_KERNEL_MAX_EXCLUSIVE
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends dpkg-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=gdb-builder /out/ /opt/doctor-gdb-repo/
RUN cd /opt/doctor-gdb-repo \
    && dpkg-scanpackages . /dev/null > Packages \
    && gzip -9n -c Packages > Packages.gz \
    && printf 'deb [trusted=yes] file:/opt/doctor-gdb-repo ./\n' \
      > /etc/apt/sources.list.d/doctor-gdb.list
COPY packages/debian/build-bundle.sh /usr/local/bin/build-debian-bundle
RUN DOCTOR_KERNEL_MIN_INCLUSIVE="$DOCTOR_KERNEL_MIN_INCLUSIVE" \
    DOCTOR_KERNEL_MAX_EXCLUSIVE="$DOCTOR_KERNEL_MAX_EXCLUSIVE" \
    bash /usr/local/bin/build-debian-bundle \
      "$TARGETARCH" \
      "$DEBIAN_VERSION" \
      "$DOCTOR_TOOLKIT_VERSION" \
      $PACKAGE_NAMES

# A fresh slim root proves the bundle can resolve and install without consulting a network source.
FROM debian:${DEBIAN_VERSION}-slim AS verify
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=bundle /work/doctor-packages /doctor-packages
COPY --from=bundle /out /out
RUN mkdir -p /tmp/apt-empty /tmp/apt-lists/partial \
    && printf 'deb [trusted=yes] file:/doctor-packages/repo ./\n' > /tmp/doctor-packages.list \
    && apt-get \
      -o Dir::Etc::SourceList=/tmp/doctor-packages.list \
      -o Dir::Etc::SourceParts=/tmp/apt-empty \
      -o Dir::State::Lists=/tmp/apt-lists \
      update \
    && apt-get \
      -o Dir::Etc::SourceList=/tmp/doctor-packages.list \
      -o Dir::Etc::SourceParts=/tmp/apt-empty \
      -o Dir::State::Lists=/tmp/apt-lists \
      install -y --no-install-recommends gdb \
    && gdb --version

FROM scratch
COPY --from=verify /out /out
