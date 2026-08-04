import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { DoctorClient } from "../src/protocol/client";
import { ServerError } from "../src/protocol/errors";

const origFetch = globalThis.fetch;

function mockFetch(handler: (req: Request) => Response | Promise<Response>) {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input.toString(), init);
    return await handler(req);
  }) as unknown as typeof fetch;
}

beforeEach(() => {});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("DoctorClient", () => {
  it("healthz returns true on 200 ok", async () => {
    mockFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const c = new DoctorClient("h:1");
    expect(await c.healthz()).toBe(true);
  });

  it("createConnection returns connection_id on 201", async () => {
    mockFetch(async () => new Response(JSON.stringify({ connection_id: "abc" }), { status: 201 }));
    const c = new DoctorClient("h:1");
    const cid = await c.createConnection({ readonly: true });
    expect(cid).toBe("abc");
  });

  it("createConnection throws ServerError on 4xx with error body", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: { code: "invalid_profile", message: "bad" } }), {
        status: 400,
      }),
    );
    const c = new DoctorClient("h:1");
    await expect(c.createConnection({ readonly: true })).rejects.toBeInstanceOf(ServerError);
  });

  it("deleteConnection swallows 404 quietly", async () => {
    mockFetch(async () => new Response("", { status: 404 }));
    const c = new DoctorClient("h:1");
    await c.deleteConnection("abc"); // must not throw
  });

  it("streamMessage yields parsed events from SSE body", async () => {
    const body =
      'event: text.chunk\ndata: {"event_id":"1","event_type":"text.chunk","session_id":"s","run_id":"r","occurred_at":1,"content":"hi"}\n\n' +
      'event: run.completed\ndata: {"event_id":"2","event_type":"run.completed","session_id":"s","run_id":"r","occurred_at":2,"status":"completed"}\n\n';

    mockFetch(async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const c = new DoctorClient("h:1");
    const events: any[] = [];
    for await (const ev of c.streamMessage("cid1", { text: "hi" })) events.push(ev);
    expect(events.map((e) => e.event_type)).toEqual(["text.chunk", "run.completed"]);
  });
});
