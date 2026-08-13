FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
COPY analyzer/go /src
WORKDIR /src
RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go build -trimpath -ldflags='-s -w' -o /pydump_analyzer ./cmd/pydump-analyzer

FROM scratch
COPY --from=build /pydump_analyzer /pydump_analyzer
