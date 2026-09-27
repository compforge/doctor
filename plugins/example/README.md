# Example Doctor Plugin

This package is the smallest business-neutral example of a Doctor Plugin. It declares two example
services and a few capabilities without connecting to a real system.
The Service declarations also show how a Plugin contributes Toolchain metadata while Doctor Core
retains ownership of runtime collection.

Use it as a starting point for a separately distributed Plugin. Business service names, topology,
queries and access implementations belong in that Plugin rather than in the Doctor CLI.

The workspace version identifies both Plugin code and bundled Skills. Run
`make bump-plugin-version PLUGIN=example` whenever either content set changes.

Run `make build` in this directory to create the self-contained
`dist/example-<version>.doctor-plugin.tar.gz` archive. The target Doctor host does not need the
Plugin source tree or an additional package installation step.

The Plugin also registers an offline `error.catalog`. After installing its archive, query the
example definition without configuring a target:

```sh
doctor knowledge errors QUEUE_BUSY
doctor knowledge errors --extension-namespace plugin/example --format json
```

The catalog source version describes the error definitions; it is independent of the Plugin version.
