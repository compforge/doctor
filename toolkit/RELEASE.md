# Doctor Toolkit release

Toolkit has an independent version and release cadence from Doctor Core. Any change to a shipped
tool, image, system package, manifest, or compatibility rule must bump `VERSION`.

Build one execution-platform slice:

```bash
make build OS=linux ARCH=arm64
```

Build every slice as separate archives, or as one combined archive:

```bash
make build-matrix
make build-all
```

Linux builds compare the input-addressed package build key in the latest compatible `toolkit-v*`
GitHub Release. A matching GDB package set is re-wrapped with the current Toolkit version instead of
compiling GDB again. Missing manifests or releases, network failures, changed inputs, and failed
integrity checks fall back to a normal build.

Force a clean package build when refreshing Debian dependencies or validating reproducibility:

```bash
make build OS=linux ARCH=arm64 REUSE_RELEASE_ASSETS=false
```
