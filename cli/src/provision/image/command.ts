import { resolveImageTarget } from "../../app/image-target";
import type { CommandContext } from "../../command";
import {
  findPlatformCompanion,
  resolveImageArchives,
  resolvePublishSources,
} from "./archive";
import {
  publishImage,
  publishMultiArchitectureImage,
} from "./apply";
import { prepareImagesOnDoctorHost } from "./host";
import { discoverImageRegistryCatalog } from "./inspect";
import type { ImageCliOpts } from "./model";
import {
  imageWithoutPlatformSuffix,
  requireMultiArchitectureSources,
} from "./plan";

interface ImageDestinations {
  registry: boolean;
  host: boolean;
  offerHost: boolean;
}

function resolveImageDestinations(
  targetImage: string | undefined,
  opts: Pick<ImageCliOpts, "registry" | "host">,
): ImageDestinations {
  return {
    // The positional image has always denoted a Registry target, so keep it authoritative.
    registry: Boolean(opts.registry || targetImage || !opts.host),
    host: Boolean(opts.host),
    // Preserve the original interactive/--yes Host offer when no destination flags are used.
    offerHost: !opts.registry && !opts.host,
  };
}

export async function runDoctorImage(
  targetImage: string | undefined,
  opts: ImageCliOpts,
  commandContext: CommandContext,
): Promise<number> {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const destinations = resolveImageDestinations(targetImage, opts);
  if (destinations.registry && !targetImage && !interactive) {
    await resolveImageTarget(
      targetImage,
      "unused:latest",
      opts,
      { interactive },
    );
  }

  // 两个落点共享同一组 tar/source；先统一解析材料，再分别执行。
  const archivePaths = await resolveImageArchives(opts.tar, { interactive });
  if (!archivePaths) return 130;
  const resolvedSources = await resolvePublishSources(
    archivePaths,
    opts.sourceImage,
    interactive,
  );
  if (!resolvedSources) return 130;
  const sources = [...resolvedSources];
  const hasExplicitTar = Array.isArray(opts.tar)
    ? opts.tar.length > 0
    : Boolean(opts.tar);
  if (!hasExplicitTar && sources.length === 1) {
    const companion = findPlatformCompanion(sources[0]!);
    if (companion) sources.push(companion);
  }
  let result = 0;
  if (destinations.registry) {
    const sourceForTarget = sources.length > 1
      ? imageWithoutPlatformSuffix(
          requireMultiArchitectureSources(sources)[0]!.sourceImage,
        )
      : sources[0]!.sourceImage;
    const resolvedTarget = await resolveImageTarget(
      targetImage,
      sourceForTarget,
      opts,
      {
        interactive,
        discover: () => discoverImageRegistryCatalog(opts, commandContext),
      },
    );
    if (!resolvedTarget) {
      result = 130;
    } else {
      result = sources.length > 1
        ? await publishMultiArchitectureImage(resolvedTarget, sources, opts)
        : await publishImage(
            resolvedTarget,
            sources[0]!.archive,
            sources[0]!.sourceImage,
            opts,
          );
    }
  }

  if (destinations.host) {
    const prepared = await prepareImagesOnDoctorHost(sources, {
      assumeYes: true,
      interactive,
    });
    if (!prepared && result === 0) result = 1;
  } else if (destinations.offerHost && result === 0) {
    await prepareImagesOnDoctorHost(sources, {
      assumeYes: opts.yes,
      interactive,
    });
  }
  return result;
}
