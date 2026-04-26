import type { MessageType } from "./types";

export const NEXUS_DB_NAME = "bridge_db";
export const NEXUS_DB_VERSION = 1;

export const DEFAULT_TTL_HOURS: Record<MessageType, number> = {
  alert: 6,
  text: 72,
  audio: 48,
  image: 48,
};

export const HOT_TEMPERATURE_MULTIPLIER = 3.0;
export const WARM_TEMPERATURE_MULTIPLIER = 1.5;
export const COLD_TEMPERATURE_MULTIPLIER = 0.5;

export const SCORING_INTERVAL_MS = 15_000;
export const EXPIRY_SWEEP_INTERVAL_MS = 60_000;

export const EVICTION_TRIGGER_BYTES = 45 * 1024 * 1024;
export const EVICTION_TARGET_BYTES = 35 * 1024 * 1024;

export const SNAPSHOT_MAX_COMPRESSED_BYTES = 2300;
export const SCANNER_INTERVAL_MS = 200;

export const BLOOM_BITS = 16_384;
export const BLOOM_BYTES = BLOOM_BITS / 8;
export const BLOOM_HASHES = 4;

export const PIN_HASH_COST = 10;
export const LEVEL2_MAX_PIN_ATTEMPTS = 3;
export const SHAKE_THRESHOLD_MS2 = 25;
export const SHAKE_WINDOW_MS = 2000;
export const SHAKE_EVENTS_FOR_LEVEL3 = 3;

export const WEBRTC_CHANNEL_NAME = "bridge_sync";
