# Doctor Toolkit

Shared infrastructure and data access for Doctor Core and business plugins. This package is independent
of the Plugin protocol and command lifecycle. It is separate from the repository's root `toolkit/`,
which distributes diagnostic binaries, images and offline packages.

A `DataSource<Target>` resolves protocol-specific connection information and declares applicable
transports. A client executes protocol operations through those transports. MySQL supports TCP and
Python-capable Pod paths; Redis and OpenSearch currently support TCP paths. Protocols are exposed as
separate package entry points so importing common contracts does not load every client.

Hosts provide policy-controlled Pod access and register client cleanup in their own lifecycle. Pod
Python requests carry credentials and parameters on stdin, require PyMySQL in the target container,
and have a process deadline. Only connection-establishment network errors select another MySQL
transport; authentication failures and errors after SQL execution are returned without replay.

The package also provides Kubernetes exec/port-forward, process execution and network identity
primitives. Command selection, capability access decisions, evidence and report delivery belong to
the host. Business configuration conventions, SQL, Redis keys and index semantics belong to callers.
