import type { RedisFinding } from "../findings";
import type { RedisEvidence } from "../model";
import {
  detectConcentrations,
  detectLargeKeysExplainingMasterSkew,
  detectMasterSkew,
} from "./distribution";
import { detectNodeHealth, detectStreamsWithoutTtl } from "./health";
import type { RedisDetector } from "./types";

export { buildRedisCoverage } from "./coverage";
export type { RedisDetector } from "./types";

export const redisDetectors: readonly RedisDetector[] = [
  detectMasterSkew,
  detectLargeKeysExplainingMasterSkew,
  detectConcentrations,
  detectStreamsWithoutTtl,
  detectNodeHealth,
];

export function detectRedisFindings(evidence: RedisEvidence): RedisFinding[] {
  return redisDetectors.flatMap((detector) => detector(evidence));
}
