ARG PYTHON_VERSION=3.12
ARG PYTHON_BASE_IMAGE=python:${PYTHON_VERSION}-slim-bookworm
ARG BUILD_BASE_IMAGE=python:3.12-bookworm
FROM ${PYTHON_BASE_IMAGE} AS python

FROM ${BUILD_BASE_IMAGE} AS build
RUN if ! command -v cc >/dev/null || ! command -v readelf >/dev/null; then \
      apt-get update \
      && apt-get install -y --no-install-recommends binutils build-essential \
      && rm -rf /var/lib/apt/lists/*; \
    fi
ARG PYTHON_VERSION
COPY --from=python /usr/local /opt/pydump-python
ENV PATH="/opt/pydump-python/bin:${PATH}" \
    LD_LIBRARY_PATH="/opt/pydump-python/lib"
COPY capture/agent /src
WORKDIR /src
RUN ln -s /bin/true /tmp/pydump-python \
    && ln -s /bin/true /tmp/pydump-python-config \
    && make clean \
      PYTHON=/tmp/pydump-python \
      PYTHON_MINOR="${PYTHON_VERSION}" \
      CPPFLAGS="-DPy_BUILD_CORE -I/opt/pydump-python/include/python${PYTHON_VERSION}" \
    && make \
      PYTHON=/tmp/pydump-python \
      PYTHON_MINOR="${PYTHON_VERSION}" \
      CPPFLAGS="-DPy_BUILD_CORE -I/opt/pydump-python/include/python${PYTHON_VERSION}" \
    && cp build/pydump-agent-*.so /pydump-agent.so \
    && if readelf --version-info /pydump-agent.so \
      | grep -Eq 'Name: GLIBC_(2\.(1[89]|[2-9][0-9])|[3-9])'; then \
      echo "pydump Agent no longer meets the minimum glibc 2.17 compatibility target" >&2; \
      exit 1; \
    fi

FROM scratch
COPY --from=build /pydump-agent.so /pydump-agent.so
