#!/usr/bin/env bash
set -euo pipefail

architecture="${1:?architecture is required}"
debian_version="${2:?Debian version is required}"
bundle_version="${3:?package bundle version is required}"
shift 3
packages=("$@")
kernel_min="${DOCTOR_KERNEL_MIN_INCLUSIVE:-}"
kernel_max="${DOCTOR_KERNEL_MAX_EXCLUSIVE:-}"

if [[ ! "$architecture" =~ ^(amd64|arm64)$ ]]; then
  echo "unsupported Debian bundle architecture: $architecture" >&2
  exit 1
fi
if [[ ! "$debian_version" =~ ^[0-9]+$ ]]; then
  echo "invalid Debian version: $debian_version" >&2
  exit 1
fi
if [[ ! "$bundle_version" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]]; then
  echo "invalid package bundle version: $bundle_version" >&2
  exit 1
fi
if [[ ${#packages[@]} -eq 0 ]]; then
  echo "at least one package is required" >&2
  exit 1
fi
for package in "${packages[@]}"; do
  if [[ ! "$package" =~ ^[a-z0-9][a-z0-9+.-]*$ ]]; then
    echo "invalid Debian package name: $package" >&2
    exit 1
  fi
done
for kernel_version in "$kernel_min" "$kernel_max"; do
  if [[ -n "$kernel_version" && ! "$kernel_version" =~ ^[0-9][0-9A-Za-z._+-]*$ ]]; then
    echo "invalid kernel compatibility version: $kernel_version" >&2
    exit 1
  fi
done

export LC_ALL=C
apt-get update

mapfile -t dependencies < <(
  apt-cache depends --recurse --important "${packages[@]}" \
    | sed -n 's/^\([a-z0-9][a-z0-9+.-]*\)$/\1/p' \
    | sort -u
)
if [[ ${#dependencies[@]} -eq 0 ]]; then
  echo "unable to resolve package closure: ${packages[*]}" >&2
  exit 1
fi

rm -rf /work/doctor-packages
mkdir -p /work/doctor-packages/repo /out
(
  cd /work/doctor-packages/repo
  apt-get download "${dependencies[@]}"
  dpkg-scanpackages --multiversion . /dev/null > Packages
  gzip -9n -c Packages > Packages.gz
)

{
  printf '{"schema":"doctor-packages/v1","bundleVersion":"%s","packageManager":"apt-get"' \
    "$bundle_version"
  printf ',"osId":"debian","osVersionId":"%s","architecture":"%s","packages":[' \
    "$debian_version" "$architecture"
  separator=""
  for package in "${packages[@]}"; do
    printf '%s"%s"' "$separator" "$package"
    separator=","
  done
  printf '],"packageVersions":{'
  separator=""
  for package in "${packages[@]}"; do
    package_version="$(
      apt-cache policy "$package" \
        | sed -n 's/^  Candidate: //p' \
        | head -n 1
    )"
    if [[ -z "$package_version" || "$package_version" == "(none)" ]]; then
      echo "unable to resolve version for package: $package" >&2
      exit 1
    fi
    printf '%s"%s":"%s"' "$separator" "$package" "$package_version"
    separator=","
  done
  printf '}'
  if [[ -n "$kernel_min" || -n "$kernel_max" ]]; then
    printf ',"compatibility":{"kernel":{'
    separator=""
    if [[ -n "$kernel_min" ]]; then
      printf '"minInclusive":"%s"' "$kernel_min"
      separator=","
    fi
    if [[ -n "$kernel_max" ]]; then
      printf '%s"maxExclusive":"%s"' "$separator" "$kernel_max"
    fi
    printf '}}'
  fi
  printf '}\n'
} > /work/doctor-packages/manifest.json

package_suffix="$(IFS=-; printf '%s' "${packages[*]}")"
artifact="doctor-packages-debian${debian_version}-${architecture}-${package_suffix}.tar"
tar \
  --sort=name \
  --mtime="UTC 1970-01-01" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -C /work \
  -cf "/out/$artifact" \
  doctor-packages
echo "built: /out/$artifact"
