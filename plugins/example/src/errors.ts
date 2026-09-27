import type { ErrorCatalogExtension } from "@compforge/doctor-plugin";

/** Example definitions only; this catalog performs no Service or network access. */
export const exampleErrors = {
  id: "errors", kind: "error.catalog",
  description: "Example API error definitions",
  load: () => ({
    source: { name: "example-api", version: "1.0.0" },
    errors: [{
      code: "QUEUE_BUSY", name: "QueueBusy", aliases: ["QueueFull"],
      description: "The example worker queue has reached its capacity.",
      exception: "QueueBusyError", defaultMessage: "The queue is busy. Try again later.",
      defaultHttpStatus: 503, defaultDisposition: "retryable",
    }],
  }),
} satisfies ErrorCatalogExtension;
