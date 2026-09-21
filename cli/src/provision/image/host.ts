import { isInteractive } from "../../terminal/policy";
import { createInterface } from "node:readline/promises";
import { infra } from "../../infra";
import {
  prepareLocalImage,
  type LocalContainerEngineName,
} from "../../infra/host/container-engine";
import { prepareTerminalInput } from "../../terminal/input";

import { useLogger } from "../../terminal/log";
import type {
  ImagePublishSource,
  PrepareDoctorHostImageOptions,
} from "./model";
import {
  currentHostArchitecture,
  selectDoctorHostImage,
} from "./plan";

async function confirmDoctorHostImage(
  engine: LocalContainerEngineName,
  sourceImage: string,
): Promise<boolean> {
  useLogger("image").info(`Doctor Host 检测到 ${engine}，`
    + `是否同时将 ${sourceImage} load 到本机？`);
  prepareTerminalInput();
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return ["y", "yes"].includes(
      (await readline.question("本机 load？[y/N] ")).trim().toLowerCase(),
    );
  } finally {
    readline.close();
  }
}

/** Prepare one tar in the Doctor Host container engine. */
export async function prepareImageOnDoctorHost(
  archive: string,
  sourceImage: string,
  options: PrepareDoctorHostImageOptions = {},
): Promise<boolean> {
  const engine = await infra.host.containerEngine();
  if (!engine) {
    useLogger("image").warn("Doctor Host 未发现可用的 Docker、Podman 或 nerdctl；"
      + "跳过本机 load。");
    return false;
  }
  const interactive = isInteractive(options.interactive);
  const approved = options.assumeYes
    || (
      interactive
      && await (options.confirm ?? confirmDoctorHostImage)(
        engine.name,
        sourceImage,
      )
    );
  if (!approved) {
    useLogger().info(interactive
        ? "[image] 已跳过 Doctor Host 本机 load。\n"
        : "[image] 非交互终端未执行可选的 Doctor Host 本机 load；"
          + "可用 -y/--yes 确认。");
    return false;
  }
  const prepared = await prepareLocalImage(engine, archive, sourceImage);
  if (prepared.state === "failed") {
    useLogger("image").warn(`${prepared.engine} load 未完成：${prepared.reason}。`);
    return false;
  }
  const action = prepared.state === "loaded" ? "已 load" : "已存在";
  useLogger("image").success(`local ${prepared.engine}: ${prepared.image}（${action}）`);
  return true;
}

export async function prepareImagesOnDoctorHost(
  sources: readonly ImagePublishSource[],
  options: PrepareDoctorHostImageOptions = {},
): Promise<boolean> {
  const architecture = currentHostArchitecture();
  const source = selectDoctorHostImage(sources, architecture);
  if (!source) {
    useLogger("image").warn(`Doctor Host architecture=${architecture ?? process.arch}`
      + "，没有匹配的 image tar；跳过本机 load。");
    return false;
  }
  if (sources.length > 1) {
    useLogger("image").info(`Doctor Host architecture=${architecture}，本机仅准备`
      + ` ${source.sourceImage}。`);
  }
  return prepareImageOnDoctorHost(
    source.archive,
    source.sourceImage,
    options,
  );
}
