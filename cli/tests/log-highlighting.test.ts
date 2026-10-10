import { expect, test } from "bun:test";
import { LOG_REPORT_SCRIPT } from "../src/collect/log/html-assets/script";

type TextNode = { textContent: string };

// Execute the shipped helper without adding a browser dependency to the CLI suite.
const helper = LOG_REPORT_SCRIPT.slice(
  LOG_REPORT_SCRIPT.indexOf("  function appendHighlighted("),
  LOG_REPORT_SCRIPT.indexOf("  function sourceColor("),
);
const appendHighlighted = new Function("document", helper + "\nreturn appendHighlighted;")({
  createTextNode: (text: string): TextNode => ({ textContent: text }),
  createElement: (): TextNode => ({ textContent: "" }),
}) as (container: { textContent: string; append(...nodes: TextNode[]): void }, text: string, query: string) => void;

for (const kind of ["trace:trace_id", "related-object:carrier_id"]) {
  test(`${kind} label survives first paint, search and clearing the search`, () => {
    const prefix = `[${kind}=identity-1] `;
    const message = "observer failed <not-markup>";
    for (const query of ["", "OBSERVER", ""]) {
      const badge = { textContent: prefix };
      let children: TextNode[] = [badge];
      const container = {
        get textContent() { return children.map(node => node.textContent).join(""); },
        // Like DOM textContent, assignment replaces all existing child nodes.
        set textContent(value: string) { children = [{ textContent: value }]; },
        append(...nodes: TextNode[]) { children.push(...nodes); },
      };
      appendHighlighted(container, message, query);
      expect(children[0]).toBe(badge);
      expect(container.textContent).toBe(prefix + message);
      if (query) expect(children.some(node => node.textContent === "observer")).toBeTrue();
    }
  });
}
