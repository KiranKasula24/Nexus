import {
  COLD_TEMPERATURE_MULTIPLIER,
  HOT_TEMPERATURE_MULTIPLIER,
  WARM_TEMPERATURE_MULTIPLIER,
} from "./constants";
import { hoursSince, nowUnixSeconds } from "./time";
import type { NexusComputedFields, NexusMessage, Temperature } from "./types";

function temperatureMultiplier(temp: Temperature): number {
  if (temp === "hot") return HOT_TEMPERATURE_MULTIPLIER;
  if (temp === "warm") return WARM_TEMPERATURE_MULTIPLIER;
  return COLD_TEMPERATURE_MULTIPLIER;
}

export function computeTemperature(
  message: NexusMessage,
  now = nowUnixSeconds(),
): Temperature {
  if (message.type === "alert") return "hot";

  const ageHours = hoursSince(message.created_at, now);

  if (message.weight >= 6.0 && ageHours <= 12) {
    return "hot";
  }

  if (message.weight < 3.0 && ageHours > 48) {
    return "cold";
  }

  return "warm";
}

export function computeScore(
  message: NexusMessage,
  now = nowUnixSeconds(),
): number {
  const ageHours = hoursSince(message.created_at, now);
  const temp = computeTemperature(message, now);
  const tempMult = temperatureMultiplier(temp);

  const freshnessTerm = 1 / (1 + ageHours * 0.1);
  const numerator =
    message.priority * 2 * (message.weight / 10 + freshnessTerm * tempMult);
  const denominator = 1 + message.hop_count * 0.2;

  return Number((numerator / denominator).toFixed(6));
}

export function computeMergeConfidence(
  message: NexusMessage,
  now = nowUnixSeconds(),
): number {
  const ageHours = hoursSince(message.created_at, now);
  return Number((message.hop_count / (1 + ageHours)).toFixed(6));
}

export function computeFields(
  message: NexusMessage,
  now = nowUnixSeconds(),
): NexusComputedFields {
  const temperature = computeTemperature(message, now);
  return {
    temperature,
    score: computeScore(message, now),
    merge_confidence: computeMergeConfidence(message, now),
    is_expired: message.ttl < now,
    is_superseded: Boolean(message.superseded_by),
    is_conflicted: false,
    conflict_ids: [],
  };
}

export function sortByScoreDesc<T extends NexusMessage>(messages: T[]): T[] {
  return [...messages].sort((a, b) => computeScore(b) - computeScore(a));
}
