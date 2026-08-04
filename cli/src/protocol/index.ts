// Barrel for the protocol layer.
// Re-exports wire types + HTTP client + SSE parser. Tui / app layers should
// import from here, not from the individual files, so we can rearrange the
// internal layout without rippling through the rest of the codebase.

export * from "./types";
export * from "./errors";
export { DoctorClient } from "./client";
export type { MessageRequest } from "./client";
export { parseSseStream } from "./sse";
