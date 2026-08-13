import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  hostContainerToolkitChannel,
  inspectToolkitArchive,
  kubernetesToolkitChannel,
  materializeToolkitResource,
  normalizeToolkitArchitecture,
} from "../src/infra/toolkit";

function tar(path: string, files: Record<string, Buffer | string>): void {
  const blocks: Buffer[] = [];
  for (const [name, value] of Object.entries(files)) {
    const data = typeof value === "string" ? Buffer.from(value) : value;
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header[156] = "0".charCodeAt(0);
    blocks.push(header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  blocks.push(Buffer.alloc(1024));
  writeFileSync(path, Buffer.concat(blocks));
}

test("Toolkit archive selects and verifies a resource by execution platform", () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-toolkit-test-"));
  const archivePath = join(directory, "doctor-toolkit-1.0.0-darwin-arm64.tar");
  const tool = Buffer.from("#!/bin/sh\necho toolkit\n");
  const resourcePath = "doctor-toolkit/platforms/darwin-arm64/bin/doctor-pcap";
  const manifest = {
    schema: "doctor.toolkit/v1",
    version: "1.0.0",
    platforms: [{
      os: "darwin",
      architecture: "arm64",
      tools: [{
        id: "doctor-pcap",
        path: resourcePath,
        sha256: createHash("sha256").update(tool).digest("hex"),
        size: tool.length,
      }],
      images: [],
      packages: [],
    }],
  };
  tar(archivePath, {
    "doctor-toolkit/manifest.json": `${JSON.stringify(manifest)}\n`,
    [resourcePath]: tool,
  });

  const archive = inspectToolkitArchive(archivePath);
  const resource = archive.manifest.platforms[0]!.tools[0]!;
  const materialized = materializeToolkitResource(archive, resource, true);
  expect(existsSync(materialized)).toBe(true);
  expect(readFileSync(materialized)).toEqual(tool);
});

test("Toolkit channels normalize Host container and Kubernetes execution architectures", () => {
  expect(normalizeToolkitArchitecture("x86_64")).toBe("amd64");
  expect(normalizeToolkitArchitecture("aarch64")).toBe("arm64");
  expect(hostContainerToolkitChannel("amd64")).toEqual({
    kind: "host-container",
    platform: { os: "linux", architecture: "amd64" },
  });
  expect(kubernetesToolkitChannel({
    pod: "app-0",
    container: "app",
    architecture: "aarch64",
  })).toEqual({
    kind: "kubernetes-container",
    platform: { os: "linux", architecture: "arm64" },
    pod: "app-0",
    container: "app",
  });
});

test("Toolkit rejects an unsafe resource path before extraction", () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-toolkit-unsafe-"));
  const archivePath = join(directory, "doctor-toolkit-unsafe.tar");
  tar(archivePath, {
    "doctor-toolkit/manifest.json": JSON.stringify({
      schema: "doctor.toolkit/v1",
      version: "1.0.0",
      platforms: [{
        os: "linux",
        architecture: "amd64",
        tools: [{
          id: "bad",
          path: "doctor-toolkit/platforms/linux-amd64/../../bad",
          sha256: "0".repeat(64),
          size: 0,
        }],
        images: [],
        packages: [],
      }],
    }),
  });
  expect(() => inspectToolkitArchive(archivePath)).toThrow("resource path 无效");
});

test("Toolkit rejects a resource id that could escape the materialization directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-toolkit-unsafe-id-"));
  const archivePath = join(directory, "doctor-toolkit-unsafe-id.tar");
  tar(archivePath, {
    "doctor-toolkit/manifest.json": JSON.stringify({
      schema: "doctor.toolkit/v1",
      version: "1.0.0",
      platforms: [{
        os: "linux",
        architecture: "amd64",
        tools: [{
          id: "../../bad",
          path: "doctor-toolkit/platforms/linux-amd64/bin/bad",
          sha256: "0".repeat(64),
          size: 0,
        }],
        images: [],
        packages: [],
      }],
    }),
  });
  expect(() => inspectToolkitArchive(archivePath)).toThrow("resource id 无效");
});
