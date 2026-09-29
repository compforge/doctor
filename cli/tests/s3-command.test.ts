import { expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServiceCatalog } from "@compforge/doctor-plugin";
import { createDoctorProgram } from "../src/app/main";
import { CommandContext, CommandStatus } from "../src/command";
import { s3Command } from "../src/collect/s3/command";
import { resolveS3Request } from "../src/collect/s3/input";
import { executeS3 } from "../src/collect/s3/operations";
import * as providers from "../src/collect/s3/provider";
import { s3Summary } from "../src/collect/s3/summary";
import { startS3Fixture } from "./s3-fixture";

const xml = (body: string) => new Response(body, { headers: { "content-type": "application/xml" } });
const listing = (body: string, truncated = false, token = "") => xml(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${truncated}</IsTruncated>${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ""}${body}</ListBucketResult>`);

test("mc paths and S3 URIs preserve literal keys and enforce operation bounds", () => {
  const key = "a//../%20 +?#/文件 ";
  const first = resolveS3Request({ action: "cat", path: `chat/bucket/${key}` });
  expect(first).toEqual(resolveS3Request({ action: "cat", service: "chat", path: `s3://bucket/${key}` }));
  expect(first.key).toBe(key);
  expect(resolveS3Request({ action: "ls", path: "chat" })).toMatchObject({ service: "chat", bucket: undefined });
  for (const input of [
    { action: "cat", path: "chat/bucket" }, { action: "stat", path: "chat" },
    { action: "ls", maxItems: "0" }, { action: "ls", timeout: "Infinity" },
    { action: "ls", path: "https://host/bucket" }, { action: "ls", versionId: "v1" },
    { action: "stat", path: "chat/bucket/key", recursive: true },
  ] as const) expect(() => resolveS3Request(input)).toThrow();
});

test("CLI registers mc operations and Distribution defaults", () => {
  const program = createDoctorProgram({ name: "ascli", commands: "s3", commandDefaults: { s3: { format: "manifest" } } });
  const command = program.commands.find(command => command.name() === "s3")!;
  expect(command.helpInformation()).toContain("<operation> [target]");
  expect(command.helpInformation()).toContain("--recursive");
  expect(command.opts().format).toBe("manifest");
});

test("directory listing counts prefixes, stops with resumable cursor and recursively resumes", async () => {
  const urls: URL[] = [];
  const fixture = await startS3Fixture(url => {
    const parsed = new URL(url); urls.push(parsed);
    return parsed.searchParams.has("continuation-token")
      ? listing("<Contents><Key>p/dir/file</Key><Size>3</Size></Contents>")
      : listing("<CommonPrefixes><Prefix>p/dir/</Prefix></CommonPrefixes><Contents><Key>p/file</Key><Size>2</Size></Contents>", true, "next");
  });
  try {
    const request = resolveS3Request({ action: "ls", path: "svc/bucket/p/", maxItems: "2" });
    const first = await executeS3(fixture.client, request);
    expect(first).toMatchObject({ complete: false, continuationToken: "next", stoppedReason: "item-limit", pages: 1 });
    expect(first.entries.map(entry => entry.type)).toEqual(["prefix", "object"]);
    expect(urls[0]!.searchParams.get("delimiter")).toBe("/");
    expect(urls[0]!.searchParams.get("max-keys")).toBe("2");
    const second = await executeS3(fixture.client, { ...request, continuationToken: "next", recursive: true });
    expect(second).toMatchObject({ complete: true, entries: [{ name: "p/dir/file" }] });
    expect(urls[1]!.searchParams.has("delimiter")).toBe(false);
    expect(urls[1]!.searchParams.get("prefix")).toBe("p/");
  } finally { await fixture.close(); }
});

test("ls distinguishes successful empty listings from access denied and broken pagination", async () => {
  let mode = "empty";
  const fixture = await startS3Fixture(() => mode === "empty" ? listing("") : mode === "broken" ? listing("", true)
    : new Response("<Error><Code>AccessDenied</Code><Message>secret-url</Message></Error>", { status: 403 }));
  try {
    const request = resolveS3Request({ action: "ls", path: "svc/bucket" });
    const empty = await executeS3(fixture.client, request);
    expect(empty.complete).toBe(true);
    expect(s3Summary(request, empty, undefined)).toContain("没有匹配项");
    mode = "denied";
    const denied = await executeS3(fixture.client, request);
    expect(denied).toMatchObject({ complete: false, failure: { httpStatus: 403, code: "AccessDenied" } });
    expect(s3Summary(request, denied, undefined)).not.toContain("没有匹配项");
    expect(JSON.stringify(denied)).not.toContain("secret-url");
    mode = "broken";
    expect((await executeS3(fixture.client, request)).failure?.code).toBe("MissingContinuationToken");
  } finally { await fixture.close(); }
});

test("bucket discovery paginates; repeated cursor retains evidence without claiming completeness", async () => {
  let calls = 0;
  const fixture = await startS3Fixture(() => xml(`<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets><Bucket><Name>bucket-${++calls}</Name></Bucket></Buckets><ContinuationToken>same</ContinuationToken></ListAllMyBucketsResult>`));
  try {
    const result = await executeS3(fixture.client, resolveS3Request({ action: "ls", path: "svc" }));
    expect(result).toMatchObject({ complete: false, pages: 2, failure: { code: "RepeatedContinuationToken" } });
    expect(result.entries).toHaveLength(2);
  } finally { await fixture.close(); }
});

test("stat uses HEAD without LIST and passes object version", async () => {
  const requests: Request[] = [];
  const fixture = await startS3Fixture((_url, request) => { requests.push(request); return new Response(null, { headers: { "content-length": "17", etag: '"etag"' } }); });
  try {
    const result = await executeS3(fixture.client, resolveS3Request({ action: "stat", path: "svc/bucket/key", versionId: "v1" }));
    expect(result.complete).toBe(true);
    expect(requests.map(request => request.method)).toEqual(["HEAD"]);
    expect(new URL(requests[0]!.url).searchParams.get("versionId")).toBe("v1");
  } finally { await fixture.close(); }
});

test("cat saves bounded binary evidence and propagates partial status through command", async () => {
  const fixture = await startS3Fixture((_url, request) => {
    expect(request.method).toBe("GET");
    return new Response(new Uint8Array([0, 255, 2, 3, 4, 5, 6, 7, 8, 9]), { headers: { "content-length": "10" } });
  });
  const resolve = spyOn(providers, "resolveS3Provider").mockResolvedValue({ client: fixture.client, identity: {
    service: "svc", dataSource: "files", description: undefined, endpoint: fixture.target.endpoint, region: "us-east-1",
    configuredBucket: "bucket", configuredPrefix: undefined, source: "plugin", namespace: "test", pod: undefined, container: undefined,
    channel: "plugin", executionLocation: "doctor-host",
  } });
  const context = new CommandContext({}, undefined, { format: "summary", plugin: { id: "test", version: "0.0.1", services: createServiceCatalog([{
    name: "svc", component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, workloads: [],
    dataSources: [{ id: "files", kind: "s3", backend: "s3-compatible", environment: { region: "REGION", endpoint: "ENDPOINT", bucket: "BUCKET", accessKey: "AK", secretKey: "SK" } }],
  }]) } });
  const environment = spyOn(context, "ensureEnvironment").mockResolvedValue();
  let directory: string | undefined;
  try {
    const outcome = await s3Command.run(context, { action: "cat", path: "svc/bucket/key", maxBytes: "4", interactive: false });
    expect(outcome.status).toBe(CommandStatus.Partial);
    directory = outcome.artifacts[0]!.path;
    expect([...readFileSync(join(directory, "content.bin"))]).toEqual([0, 255, 2, 3]);
    const diagnosis = JSON.parse(readFileSync(join(directory, "diagnosis.json"), "utf8"));
    const result = JSON.parse(readFileSync(join(directory, diagnosis.resultFile), "utf8"));
    expect(result).toMatchObject({ complete: false, bytesRead: 4, contentFile: "content.bin", stoppedReason: "byte-limit" });
    expect(result.bytes).toBeUndefined();
    expect(readFileSync(join(directory, "collection.json"), "utf8")).toContain('"status": "partial"');
    expect(readFileSync(join(directory, "summary.md"), "utf8")).toContain("二进制");
  } finally {
    resolve.mockRestore(); environment.mockRestore(); await context.disposeClients(); await fixture.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

test("deadline retains earlier pages; parent cancellation propagates", async () => {
  const fixture = await startS3Fixture(() => listing(""));
  let calls = 0;
  const list = spyOn(fixture.client, "listObjects").mockImplementation(async (_bucket, options) => {
    if (++calls === 1) return { objects: [{ key: "first" }], prefixes: [], truncated: true, continuationToken: "next" };
    return new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    });
  });
  try {
    const request = { ...resolveS3Request({ action: "ls", path: "svc/bucket" }), timeoutMs: 20 };
    const result = await executeS3(fixture.client, request);
    expect(result).toMatchObject({ complete: false, stoppedReason: "time-limit", pages: 1, continuationToken: "next", entries: [{ name: "first" }] });
    await fixture.client.dispose();
    await expect(executeS3(fixture.client, request)).rejects.toThrow();
  } finally { list.mockRestore(); await fixture.close(); }
});
