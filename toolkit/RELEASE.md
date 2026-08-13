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
