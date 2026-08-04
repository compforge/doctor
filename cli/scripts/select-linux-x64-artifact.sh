#!/bin/sh
set -eu

version="${1:-${DOCTOR_CLI_VERSION:-}}"
kernel="${DOCTOR_KERNEL_VERSION:-$(uname -r)}"
arch="${DOCTOR_MACHINE_ARCH:-$(uname -m)}"
glibc_line="${DOCTOR_GLIBC_VERSION:-$(getconf GNU_LIBC_VERSION 2>/dev/null || true)}"

if [ -z "$version" ]; then
  echo "usage: $0 <doctor-version>" >&2
  exit 2
fi

version_ge() {
  current_major=${1%%.*}
  current_rest=${1#*.}
  current_minor=${current_rest%%[!0-9]*}
  required_major=${2%%.*}
  required_minor=${2#*.}
  [ "$current_major" -gt "$required_major" ] || {
    [ "$current_major" -eq "$required_major" ] && [ "$current_minor" -ge "$required_minor" ]
  }
}

case "$arch" in
  x86_64|amd64) ;;
  *)
    echo "unsupported Linux architecture: $arch" >&2
    exit 2
    ;;
esac

case "$glibc_line" in
  "glibc "*) glibc=${glibc_line#glibc } ;;
  [0-9]*.[0-9]*) glibc=$glibc_line ;;
  *)
    echo "unable to identify glibc: ${glibc_line:-<missing>}" >&2
    exit 2
    ;;
esac

if ! version_ge "$glibc" "2.17"; then
  echo "unsupported glibc $glibc; doctor legacy requires glibc 2.17+" >&2
  exit 2
fi

# 只有明确满足 Bun 的推荐内核和当前构建的 glibc 基线才发 modern；无法证明时回退到兼容版。
if version_ge "$kernel" "5.6" && version_ge "$glibc" "2.25"; then
  echo "doctor-$version-linux-x64-kernel-5.6-glibc-2.25"
else
  echo "doctor-$version-linux-x64-kernel-3.10-glibc-2.17"
fi
