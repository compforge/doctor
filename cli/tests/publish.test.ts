import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findPlatformCompanion,
  imageTarMissingMessage,
  listImageArchives,
  prepareImageOnDoctorHost,
  publishImage,
  publishMultiArchitectureImage,
  resolveImageArchive,
  runDoctorImage,
  resolveSourceImage,
  selectDoctorHostImage,
  type ImagePublishSource,
} from "../src/provision/image";
import {
  appendImageTagSuffix,
  DOCTOR_DEBUG_IMAGE,
  DOCTOR_DEBUG_IMAGE_VERSION,
  inferDebugImage,
  inferDebugImageRepository,
  resolveDebugImage,
} from "../src/app/resolve-debug-image";
import { buildRegistryCatalog, discoverRegistryCatalog, resolveImageTarget } from "../src/app/image-target";
import { resolveProfileRegistryCredentials } from "../src/app/registry-auth";
import {
  classifyRegistryImageResult,
  parseImagePlatform,
  parseRegistryTagListResult,
} from "../src/infra/image/regctl";
import { infra } from "../src/infra";
import { inspectImageArchive } from "../src/infra/image";
import {
  normalizeImageArchitecture,
  parseNodeImagePlatform,
  pullableImageReference,
} from "../src/infra/k8s/platform";
import type { Executor } from "../src/infra/k8s/executor";
import { RecentSelections } from "../src/infra/recent";
import { CommandContext } from "../src/command";

function writeMetadataTar(path: string, files: Record<string, string>): void {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header[156] = "0".charCodeAt(0);
    blocks.push(header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  blocks.push(Buffer.alloc(1024));
  writeFileSync(path, Buffer.concat(blocks));
}

test("debug image 为双架构镜像追加 tag 后缀", () => {
  expect(appendImageTagSuffix("registry:5000/ops/doctor-debug:0.0.8", "linux-amd64"))
    .toBe("registry:5000/ops/doctor-debug:0.0.8-linux-amd64");
  expect(() => appendImageTagSuffix("registry/ops/doctor-debug", "linux-amd64"))
    .toThrow("必须显式包含 tag");
});

test("doctor image 从当前目录发现任意 tar 并交互消歧", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-image-archives-"));
  const old = join(dir, "service-a.tar");
  const latest = join(dir, "doctor-debug-linux-amd64.tar");
  writeFileSync(old, "old");
  writeFileSync(latest, "latest");
  writeFileSync(join(dir, "README.md"), "ignored");
  utimesSync(old, new Date(1_000), new Date(1_000));
  utimesSync(latest, new Date(2_000), new Date(2_000));

  expect(listImageArchives(dir).map((candidate) => candidate.name)).toEqual([
    "doctor-debug-linux-amd64.tar",
    "service-a.tar",
  ]);
  expect(await resolveImageArchive(old, { interactive: false })).toBe(old);
  expect(resolveImageArchive(undefined, { directory: dir, interactive: false }))
    .rejects.toThrow("非交互环境请用 --tar");

  let offered: readonly string[] = [];
  const selected = await resolveImageArchive(undefined, {
    directory: dir,
    interactive: true,
    select: async (choices) => {
      offered = choices.map((candidate) => candidate.path);
      return choices[0];
    },
  });
  expect(offered).toEqual([latest, old]);
  expect(selected).toBe(latest);
});

test("doctor image 缺少 tar 时说明文件来源与 Doctor Host 落点", () => {
  const message = imageTarMissingMessage();
  expect(message).toContain("容器镜像离线归档");
  expect(message).toContain("不负责现场构建镜像");
  expect(message).toContain("make -C toolkit build");
  expect(message).toContain("Doctor Host 当前目录");
  expect(imageTarMissingMessage("/delivery/debug.tar")).toContain(
    "指定的 image tar 不存在：/delivery/debug.tar",
  );
});

test("doctor image 从 Docker tar 元数据读取并选择源 image", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-image-metadata-"));
  const archive = join(dir, "images.tar");
  writeMetadataTar(archive, {
    "manifest.json": JSON.stringify([
      { RepoTags: ["service-a:1.2.3", "service-a:stable"] },
    ]),
  });
  const info = inspectImageArchive(archive);
  expect(info.images).toEqual(["service-a:1.2.3", "service-a:stable"]);
  expect(await resolveSourceImage(info, "service-a:stable", { interactive: false }))
    .toBe("service-a:stable");
  expect(resolveSourceImage(info, undefined, { interactive: false }))
    .rejects.toThrow("--source-image");
  expect(await resolveSourceImage(info, undefined, {
    interactive: true,
    select: async (images) => images[0],
  })).toBe("service-a:1.2.3");
});

test("doctor image 从 Docker tar config 读取真实平台", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-image-platform-"));
  const archive = join(dir, "doctor-debug-linux-arm64.tar");
  writeMetadataTar(archive, {
    "manifest.json": JSON.stringify([{
      Config: "blobs/sha256/config",
      RepoTags: ["doctor-debug:1-linux-arm64"],
    }]),
    "blobs/sha256/config": JSON.stringify({ os: "linux", architecture: "aarch64" }),
  });

  expect(inspectImageArchive(archive)).toEqual({
    images: ["doctor-debug:1-linux-arm64"],
    entries: [{
      image: "doctor-debug:1-linux-arm64",
      platform: { os: "linux", architecture: "arm64" },
    }],
  });
});

test("doctor image 可独立或同时准备 Registry 与 Doctor Host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-image-destinations-"));
  const archive = join(dir, "service-a.tar");
  writeMetadataTar(archive, {
    "manifest.json": JSON.stringify([{ RepoTags: ["service-a:1"] }]),
  });
  const originalImage = infra.image;
  const originalContainerEngine = infra.host.containerEngine;
  let registryImports = 0;
  let hostPreparations = 0;
  let registrySucceeds = true;
  infra.image = {
    inspect: () => "ready",
    inspectPlatform: () => ({ state: "ready" }),
    listTags: () => ({ state: "ready", tags: [] }),
    import: () => {
      registryImports += 1;
      return registrySucceeds;
    },
    createIndex: () => true,
    verifyIndex: () => true,
  };
  infra.host.containerEngine = async () => {
    hostPreparations += 1;
    let ready = false;
    return {
      name: "docker",
      run: async (argv) => {
        if (argv[0] === "load") ready = true;
        return {
          ok: ready,
          exitCode: ready ? 0 : 1,
          stdout: "",
          stderr: "",
          timedOut: false,
        };
      },
    };
  };
  const common = {
    tar: archive,
    sourceImage: "service-a:1",
    config: "/does/not/exist",
  };
  const target = "registry.example.com/dev/service-a:1";
  const commandContext = new CommandContext({});
  try {
    expect(await runDoctorImage(
      undefined,
      { ...common, host: true },
      commandContext,
    )).toBe(0);
    expect({ registryImports, hostPreparations }).toEqual({
      registryImports: 0,
      hostPreparations: 1,
    });

    expect(await runDoctorImage(
      target,
      { ...common, registry: true },
      commandContext,
    )).toBe(0);
    expect({ registryImports, hostPreparations }).toEqual({
      registryImports: 1,
      hostPreparations: 1,
    });

    expect(await runDoctorImage(
      target,
      { ...common, registry: true, host: true },
      commandContext,
    )).toBe(0);
    expect({ registryImports, hostPreparations }).toEqual({
      registryImports: 2,
      hostPreparations: 2,
    });

    registrySucceeds = false;
    expect(await runDoctorImage(
      target,
      { ...common, registry: true, host: true },
      commandContext,
    )).toBe(1);
    expect({ registryImports, hostPreparations }).toEqual({
      registryImports: 3,
      hostPreparations: 3,
    });
  } finally {
    infra.image = originalImage;
    infra.host.containerEngine = originalContainerEngine;
  }
});

test("doctor image 在同目录自动配对另一架构 tar", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-image-companion-"));
  const amd64 = join(dir, "doctor-debug-linux-amd64.tar");
  const arm64 = join(dir, "doctor-debug-linux-arm64.tar");
  writeMetadataTar(amd64, {
    "manifest.json": JSON.stringify([{
      Config: "amd64-config",
      RepoTags: ["doctor-debug:1-linux-amd64"],
    }]),
    "amd64-config": JSON.stringify({ os: "linux", architecture: "amd64" }),
  });
  writeMetadataTar(arm64, {
    "manifest.json": JSON.stringify([{
      Config: "arm64-config",
      RepoTags: ["doctor-debug:1-linux-arm64"],
    }]),
    "arm64-config": JSON.stringify({ os: "linux", architecture: "arm64" }),
  });

  expect(findPlatformCompanion({
    archive: amd64,
    sourceImage: "doctor-debug:1-linux-amd64",
    platform: { os: "linux", architecture: "amd64" },
  })).toEqual({
    archive: arm64,
    sourceImage: "doctor-debug:1-linux-arm64",
    platform: { os: "linux", architecture: "arm64" },
  });
});

test("registry image check 不把认证或网络失败当成 missing", () => {
  expect(classifyRegistryImageResult({ ok: true, stdout: "{}", stderr: "" })).toBe("ready");
  expect(classifyRegistryImageResult({ ok: false, stdout: "", stderr: "manifest unknown" })).toBe("missing");
  expect(classifyRegistryImageResult({
    ok: false,
    stdout: "",
    stderr: "denied: client ip 203.0.113.10 is forbidden",
  })).toBe("ip-forbidden");
  expect(classifyRegistryImageResult({ ok: false, stdout: "", stderr: "unauthorized" })).toBe("unauthorized");
  expect(classifyRegistryImageResult({ ok: false, stdout: "", stderr: "dial tcp: timeout" })).toBe("unreachable");
  expect(classifyRegistryImageResult({ ok: false, stdout: "", stderr: "", errorCode: "ENOENT" }))
    .toBe("tool-unavailable");
  expect(classifyRegistryImageResult({ ok: false, stdout: "", stderr: "unexpected response" }))
    .toBe("registry-error");
});

test("registry tag list 解析候选并保留 registry 错误语义", () => {
  expect(parseRegistryTagListResult({
    ok: true,
    stdout: '["0.0.8-linux-amd64","pyheap-doctor1","pyheap-doctor1"]',
    stderr: "",
  })).toEqual({ state: "ready", tags: ["0.0.8-linux-amd64", "pyheap-doctor1"] });
  expect(parseRegistryTagListResult({
    ok: false,
    stdout: "",
    stderr: "unauthorized",
  })).toEqual({ state: "unauthorized", tags: [] });
});

test("从业务镜像推断同 registry/namespace 的 doctor-debug", () => {
  expect(DOCTOR_DEBUG_IMAGE).toBe("doctor-debug");
  expect(DOCTOR_DEBUG_IMAGE_VERSION).toBe("0.2.3");
  expect(inferDebugImageRepository("registry:5000/team/app:1"))
    .toBe("registry:5000/team/doctor-debug");
  expect(inferDebugImage("registry:5000/team/app:1", "0.0.8"))
    .toBe("registry:5000/team/doctor-debug:0.0.8");
  expect(() => inferDebugImage("python:3.12", "0.0.8")).toThrow("无法从目标容器镜像推断");
});

test("bare debug 的镜像优先使用 flag，其次 profile，最后从目标镜像推断", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-debug-runtime-image-"));
  const config = join(dir, "config.yaml");
  writeFileSync(config, `profiles:
  prod:
    readonly: true
    kube:
      debug_image: registry.example.com/infcprelease/doctor-debug:0.0.8
default_profile: prod
`);
  const target = "registry.example.com/dev/worker:1";

  expect(await resolveDebugImage(target, { image: "registry.example.com/flag/doctor-debug:1", config }))
    .toEqual({ image: "registry.example.com/flag/doctor-debug:1", source: "flag" });
  expect(await resolveDebugImage(target, { config })).toEqual({
    image: "registry.example.com/infcprelease/doctor-debug:0.0.8",
    source: "profile:prod",
  });
  expect(await resolveDebugImage(target, { config: "/does/not/exist" }, { interactive: false })).toEqual({
    image: "registry.example.com/dev/doctor-debug:0.2.3",
    source: "inferred",
  });
});

test("bare debug 组合当前 K8s namespace 的镜像位置并让用户确认完整 image", async () => {
  let offered: readonly string[] = [];
  const resolved = await resolveDebugImage(
    "registry.example.com/dev/worker:1",
    { config: "/does/not/exist" },
    {
      interactive: true,
      platform: { os: "linux", architecture: "amd64" },
      listTags: async (repository) => {
        if (repository === "registry.example.com/dev/doctor-debug") {
          return { state: "ready", tags: ["0.0.8-linux-amd64"] };
        }
        expect(repository).toBe("registry.example.com/infcprelease/doctor-debug");
        return { state: "ready", tags: ["pyheap-doctor1"] };
      },
      discoverRepositories: async () => [
        "registry.example.com/dev/doctor-debug",
        "registry.example.com/infcprelease/doctor-debug",
      ],
      selectImage: async (images) => {
        offered = images;
        return images.find((image) => image.endsWith(":pyheap-doctor1"));
      },
    },
  );
  expect(offered).toEqual([
    "registry.example.com/dev/doctor-debug:0.0.8-linux-amd64",
    "registry.example.com/infcprelease/doctor-debug:pyheap-doctor1",
    "复用目标业务镜像：registry.example.com/dev/worker:1",
  ]);
  expect(resolved).toEqual({
    image: "registry.example.com/infcprelease/doctor-debug:pyheap-doctor1",
    source: "discovered",
    credentials: undefined,
  });
});

test("bare debug 允许用户显式复用目标业务镜像", async () => {
  const target = "registry.example.com/dev/worker:1";
  const resolved = await resolveDebugImage(
    target,
    { config: "/does/not/exist" },
    {
      interactive: true,
      listTags: async () => ({
        state: "ready",
        tags: ["0.0.12-linux-amd64"],
      }),
      selectImage: async (choices) =>
        choices.find((choice) => choice.startsWith("复用目标业务镜像：")),
    },
  );

  expect(resolved).toEqual({
    image: target,
    source: "target-image",
  });
});

test("bare debug 有可读候选时静默跳过未授权 Registry", async () => {
  const attempts: Array<{ repository: string; promptIfUnauthorized?: boolean }> = [];
  const resolved = await resolveDebugImage(
    "ccr.example.com/kubevpn/worker:1",
    { config: "/does/not/exist" },
    {
      interactive: true,
      listTags: async (repository, options) => {
        attempts.push({ repository, promptIfUnauthorized: options?.promptIfUnauthorized });
        if (repository.startsWith("ccr.example.com/")) {
          return { state: "unauthorized", tags: [] };
        }
        return { state: "ready", tags: ["0.0.12-linux-amd64"] };
      },
      discoverRepositories: async () => [
        "registry.example.com/infcprelease/doctor-debug",
      ],
      selectImage: async (images) => images[0],
    },
  );

  expect(resolved?.image).toBe(
    "registry.example.com/infcprelease/doctor-debug:0.0.12-linux-amd64",
  );
  expect(attempts).toEqual([
    {
      repository: "ccr.example.com/kubevpn/doctor-debug",
      promptIfUnauthorized: false,
    },
    {
      repository: "registry.example.com/infcprelease/doctor-debug",
      promptIfUnauthorized: false,
    },
  ]);
});

test("bare debug 没有可读候选时才为未授权 Registry 请求认证", async () => {
  const promptModes: Array<boolean | undefined> = [];
  const resolved = await resolveDebugImage(
    "registry.example.com/dev/worker:1",
    { config: "/does/not/exist" },
    {
      interactive: true,
      listTags: async (_repository, options) => {
        promptModes.push(options?.promptIfUnauthorized);
        return options?.promptIfUnauthorized
          ? { state: "ready", tags: ["0.0.12-linux-amd64"] }
          : { state: "unauthorized", tags: [] };
      },
      selectImage: async (images) => images[0],
    },
  );

  expect(resolved?.image).toBe(
    "registry.example.com/dev/doctor-debug:0.0.12-linux-amd64",
  );
  expect(promptModes).toEqual([false, true]);
});

test("doctor image 从 K8s 镜像生成 registry/namespace 候选并允许手动输入", async () => {
  expect(buildRegistryCatalog([
    "registry.example.com/dev/agent:1",
    "registry.example.com/platform/sub/api:2",
    "nginx:1.27",
  ])).toEqual({
    registries: ["docker.io", "registry.example.com"],
    namespacesByRegistry: {
      "docker.io": ["library"],
      "registry.example.com": ["dev", "platform/sub"],
    },
  });

  expect(await resolveImageTarget(
    "registry.example.com/flag/service-a:1",
    "service-a:1",
    {},
  )).toBe("registry.example.com/flag/service-a:1");
  expect(resolveImageTarget(undefined, "service-a:1", {}, { interactive: false }))
    .rejects.toThrow("请传 doctor image <image>");

  const answers = ["custom.registry.local", "custom-ns"];
  expect(await resolveImageTarget(undefined, "source.example.com/team/service-a:1.2.3", {}, {
    interactive: true,
    discover: async () => ({
      registries: ["registry.example.com"],
      namespacesByRegistry: { "registry.example.com": ["dev"] },
    }),
    prompt: async () => answers.shift(),
  })).toBe("custom.registry.local/custom-ns/service-a:1.2.3");
});

test("doctor image recent 只调整展示顺序，不改变回车默认目标", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-image-recent-"));
  const kubeconfig = join(dir, "kubeconfig");
  let now = new Date("2026-07-28T01:00:00.000Z");
  const recent = new RecentSelections(join(dir, "recent.json"), () => now);
  const scope = { kubeconfig, context: "dev" };
  recent.recordImageTarget(scope, {
    registry: "registry-a.example.com",
    namespace: "team-b",
  });
  now = new Date("2026-07-28T02:00:00.000Z");
  recent.recordImageTarget(scope, {
    registry: "registry-b.example.com",
    namespace: "team-x",
  });
  const questions: string[] = [];

  const target = await resolveImageTarget(undefined, "doctor-debug:1", {
    kubeconfig,
    context: "dev",
  }, {
    interactive: true,
    recent,
    discover: async () => ({
      registries: ["registry-a.example.com", "registry-b.example.com"],
      namespacesByRegistry: {
        "registry-a.example.com": ["team-a", "team-b"],
        "registry-b.example.com": ["team-x"],
      },
    }),
    prompt: async (question) => {
      questions.push(question);
      return "";
    },
  });

  expect(target).toBe("registry-a.example.com/team-a/doctor-debug:1");
  expect(questions[0]).toContain("回车使用 registry-a.example.com");
  expect(questions[1]).toContain("回车使用 team-a");
});

test("doctor image 跨 namespace 读取当前 K8s 的容器镜像", async () => {
  let command: string[] = [];
  const executor: Executor = {
    run: async (sub) => {
      command = sub;
      return {
        ok: true,
        exitCode: 0,
        stdout: "registry.example.com/dev/app:1\nregistry.example.com/ops/job:2\n",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        command: ["kubectl", ...sub],
      };
    },
    exec: async () => { throw new Error("unexpected exec"); },
  };
  const catalog = await discoverRegistryCatalog({}, executor);
  expect(command).toContain("-A");
  expect(command.some((part) => part.includes("ephemeralContainers"))).toBe(true);
  expect(catalog).toEqual({
    registries: ["registry.example.com"],
    namespacesByRegistry: { "registry.example.com": ["dev", "ops"] },
  });

  command = [];
  await discoverRegistryCatalog({}, executor, { allNamespaces: false });
  expect(command).not.toContain("-A");
});

test("doctor image 无集群级 list pods 权限时提示手动输入", async () => {
  const commands: string[][] = [];
  const executor: Executor = {
    run: async (sub) => {
      commands.push(sub);
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: 'Error from server (Forbidden): pods is forbidden: cannot list resource "pods" at the cluster scope',
        durationMs: 1,
        timedOut: false,
        command: ["kubectl", ...sub],
      };
    },
    exec: async () => { throw new Error("unexpected exec"); },
  };

  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const answers = ["registry.example.com", "dev"];
    expect(await resolveImageTarget(undefined, "doctor-debug:1", {}, {
      interactive: true,
      discover: () => discoverRegistryCatalog({}, executor),
      prompt: async () => answers.shift(),
    })).toBe("registry.example.com/dev/doctor-debug:1");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("-A");
    expect(write).toHaveBeenCalledWith(
      "[image] 当前 Kubernetes 凭据没有集群级 list pods 权限，无法从 Pod 镜像自动发现 registry 和镜像 namespace；改为手动输入。\n",
    );
  } finally {
    write.mockRestore();
  }
});

test("doctor image 即使 registry tag 已存在也会重新发布", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-debug-explicit-source-"));
  const archive = join(dir, "doctor-debug-linux-amd64.tar");
  writeFileSync(archive, "image");
  const original = infra.image;
  const imported: Array<{ image: string; archive: string; sourceImage?: string }> = [];
  infra.image = {
    inspect: () => "ready",
    inspectPlatform: () => ({ state: "ready" }),
    listTags: () => ({ state: "ready", tags: [] }),
    import: (image, path, _credentials, options) => {
      imported.push({ image, archive: path, sourceImage: options?.sourceImage });
      return true;
    },
    createIndex: () => true,
    verifyIndex: () => true,
  };
  try {
    const image = "registry.example.com/dev/doctor-debug:dev";
    expect(await publishImage(image, archive, "doctor-debug:dev-linux-amd64", {
      config: "/does/not/exist",
    })).toBe(0);
    expect(imported).toEqual([{
      image: "registry.example.com/dev/doctor-debug:dev",
      archive,
      sourceImage: "doctor-debug:dev-linux-amd64",
    }]);
  } finally {
    infra.image = original;
  }
});

test("doctor image 发布双架构子镜像并创建原生 OCI index", async () => {
  const original = infra.image;
  const imported: Array<{ image: string; archive: string; sourceImage?: string }> = [];
  let created: { image: string; refs: readonly string[] } | undefined;
  const inspectedPlatforms: string[] = [];
  infra.image = {
    inspect: (_image, _credentials, platform) => {
      if (platform) inspectedPlatforms.push(`${platform.os}/${platform.architecture}`);
      return platform ? "ready" : "missing";
    },
    inspectPlatform: () => ({ state: "ready" }),
    listTags: () => ({ state: "ready", tags: [] }),
    import: (image, archive, _credentials, options) => {
      imported.push({ image, archive, sourceImage: options?.sourceImage });
      return true;
    },
    createIndex: (image, refs) => {
      created = { image, refs };
      return true;
    },
    verifyIndex: () => true,
  };
  try {
    const target = "registry.example.com/dev/doctor-debug:1";
    expect(await publishMultiArchitectureImage(target, [
      {
        archive: "/tmp/arm64.tar",
        sourceImage: "doctor-debug:1-linux-arm64",
        platform: { os: "linux", architecture: "arm64" },
      },
      {
        archive: "/tmp/amd64.tar",
        sourceImage: "doctor-debug:1-linux-amd64",
        platform: { os: "linux", architecture: "amd64" },
      },
    ], { config: "/does/not/exist" })).toBe(0);
    expect(imported).toEqual([
      {
        image: `${target}-linux-amd64`,
        archive: "/tmp/amd64.tar",
        sourceImage: "doctor-debug:1-linux-amd64",
      },
      {
        image: `${target}-linux-arm64`,
        archive: "/tmp/arm64.tar",
        sourceImage: "doctor-debug:1-linux-arm64",
      },
    ]);
    expect(created).toEqual({
      image: target,
      refs: [`${target}-linux-amd64`, `${target}-linux-arm64`],
    });
    expect(inspectedPlatforms).toEqual(["linux/amd64", "linux/arm64"]);
  } finally {
    infra.image = original;
  }
});

test("doctor image 为 Doctor Host 独立选择匹配架构的 tar", () => {
  const sources: ImagePublishSource[] = [
    {
      archive: "/tmp/amd64.tar",
      sourceImage: "doctor-debug:1-linux-amd64",
      platform: { os: "linux", architecture: "amd64" },
    },
    {
      archive: "/tmp/arm64.tar",
      sourceImage: "doctor-debug:1-linux-arm64",
      platform: { os: "linux", architecture: "arm64" },
    },
  ];
  expect(selectDoctorHostImage(sources, "arm64")).toEqual(sources[1]);
  expect(selectDoctorHostImage(sources, "amd64")).toEqual(sources[0]);
});

test("doctor image 在本地 container engine 中幂等准备 tar", async () => {
  const original = infra.host.containerEngine;
  const commands: string[][] = [];
  infra.host.containerEngine = async () => ({
    name: "podman",
    run: async (argv) => {
      commands.push([...argv]);
      return {
        ok: commands.length > 1,
        exitCode: commands.length > 1 ? 0 : 1,
        stdout: "",
        stderr: "",
        timedOut: false,
      };
    },
  });
  try {
    expect(await prepareImageOnDoctorHost("/tmp/doctor-debug.tar", "doctor-debug:1", {
      interactive: true,
      confirm: async () => true,
    })).toBe(true);
    expect(commands).toEqual([
      ["image", "inspect", "doctor-debug:1"],
      ["load", "-i", "/tmp/doctor-debug.tar"],
      ["image", "inspect", "doctor-debug:1"],
    ]);
  } finally {
    infra.host.containerEngine = original;
  }
});

test("doctor image 用户拒绝时不在 Doctor Host load", async () => {
  const original = infra.host.containerEngine;
  const commands: string[][] = [];
  infra.host.containerEngine = async () => ({
    name: "docker",
    run: async (argv) => {
      commands.push([...argv]);
      return { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  try {
    expect(await prepareImageOnDoctorHost("/tmp/doctor-debug.tar", "doctor-debug:1", {
      interactive: true,
      confirm: async () => false,
    })).toBe(false);
    expect(commands).toEqual([]);
  } finally {
    infra.host.containerEngine = original;
  }
});

test("从 profile 读取目标 registry 凭据", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-registry-auth-"));
  const config = join(dir, "config.yaml");
  writeFileSync(config, `profiles:
  prod:
    readonly: true
    registry:
      username: doctor
      password: secret
default_profile: prod
`);
  expect(resolveProfileRegistryCredentials("registry.example.com/ops/doctor-debug:1", { config }))
    .toEqual({ registry: "registry.example.com", username: "doctor", password: "secret" });
});

test("目标平台同时支持 Node arch 和实际 imageID manifest 回退", () => {
  expect(normalizeImageArchitecture("aarch64")).toBe("arm64");
  expect(parseNodeImagePlatform(JSON.stringify({
    metadata: { labels: { "kubernetes.io/arch": "amd64" } },
  }))).toEqual({ os: "linux", architecture: "amd64" });
  const digest = "a".repeat(64);
  expect(pullableImageReference(`docker-pullable://registry.example.com/team/app@sha256:${digest}`))
    .toBe(`registry.example.com/team/app@sha256:${digest}`);
  expect(pullableImageReference(`containerd://sha256:${digest}`)).toBeUndefined();
  expect(parseImagePlatform("linux/arm64\n")).toEqual({ os: "linux", architecture: "arm64" });
  expect(parseImagePlatform("darwin/arm64")).toBeUndefined();
});
