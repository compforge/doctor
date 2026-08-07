# Example Doctor Plugin

This package is the smallest business-neutral example of a Doctor Plugin. It declares two example
services and a few capabilities without connecting to a real system.

Use it as a starting point for a separately distributed Plugin. Business service names, topology,
queries and access implementations belong in that Plugin rather than in the Doctor CLI.

The workspace version identifies both Plugin code and bundled Skills. Run
`make bump-plugin-version PLUGIN=example` whenever either content set changes.
