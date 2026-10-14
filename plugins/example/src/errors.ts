import { dictionaryToMarkdown, entryToMarkdown } from "@compforge/doctor-plugin";
import type { Dictionary } from "@compforge/doctor-plugin";

/** Domain details are readable text; the Host only needs generic Entry identity and aliases. */
export const exampleErrors = {
  markdown() { return dictionaryToMarkdown(this); },
  id: "errors", title: "Example API errors", summary: "Published queue error definitions",
  source: { name: "example-api", version: "1.0.0" },
  entries: [{
    markdown() { return entryToMarkdown(this); },
    id: "QUEUE_BUSY", name: "QueueBusy", aliases: ["QueueFull"],
    description: "The example worker queue has reached its capacity.\n\nException: QueueBusyError\n\nDefault message: The queue is busy. Try again later.\n\nDefault HTTP status: 503\n\nDefault disposition: retryable",
  }],
} satisfies Dictionary;
