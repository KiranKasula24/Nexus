import { floorToHour, nowUnixSeconds } from "./time";
import { computeFields } from "./scoring";
import type {
  IngestResult,
  NexusMessage,
  NexusMessageWithComputed,
} from "./types";
import type { NexusRepository } from "./repository";

const ALLOWED_TYPES = new Set(["text", "audio", "alert"]);
export const QUARANTINE_KEY = "quarantine";

function isPriority(value: number): value is 1 | 2 | 3 | 4 | 5 {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

function hasRequiredFields(raw: Partial<NexusMessage>): raw is NexusMessage {
  return Boolean(
    raw.id &&
    raw.type &&
    raw.payload !== undefined &&
    raw.created_at !== undefined &&
    raw.ttl !== undefined &&
    raw.hop_count !== undefined &&
    raw.weight !== undefined &&
    raw.priority !== undefined &&
    raw.confidence &&
    raw.schema_version === 1,
  );
}

export function applyPrivacy(raw: NexusMessage): NexusMessage {
  return {
    id: raw.id,
    type: raw.type,
    priority: raw.priority,
    ttl: floorToHour(raw.ttl),
    created_at: floorToHour(raw.created_at),
    hop_count: raw.hop_count,
    weight: raw.weight,
    payload: raw.payload,
    confidence: raw.confidence,
    supersedes: raw.supersedes,
    superseded_by: raw.superseded_by,
    schema_version: raw.schema_version,
  };
}

export function mergeSupersedes(
  oldMessage: NexusMessage,
  replacementId: string,
): NexusMessage {
  return {
    ...oldMessage,
    superseded_by: replacementId,
  };
}

export function normalizeIngressMessage(raw: NexusMessage): NexusMessage {
  const sanitized = applyPrivacy(raw);
  return {
    ...sanitized,
    hop_count: sanitized.hop_count + 1,
    weight: Math.min(10, Number((sanitized.weight + 0.15).toFixed(2))),
  };
}

export function validateSchema(raw: Partial<NexusMessage>): string | undefined {
  if (!hasRequiredFields(raw)) {
    return "Missing required fields for schema v1.";
  }

  if (!ALLOWED_TYPES.has(raw.type)) {
    return "Invalid type.";
  }

  if (!isPriority(raw.priority)) {
    return "Priority must be 1..5.";
  }

  if (raw.confidence !== "high" && raw.confidence !== "low") {
    return "Confidence must be high or low.";
  }

  return undefined;
}

export async function ingestMessage(
  raw: Partial<NexusMessage>,
  repository?: NexusRepository,
): Promise<IngestResult> {
  if (raw.schema_version !== 1) {
    if (repository) {
      const existing =
        (await repository.getSystemState<Partial<NexusMessage>[]>(QUARANTINE_KEY)) ??
        [];
      await repository.setSystemState(QUARANTINE_KEY, [...existing, raw]);
    }
    return { status: "quarantined", reason: "Unsupported schema_version." };
  }

  const validationError = validateSchema(raw);
  if (validationError) {
    return { status: "invalid", reason: validationError };
  }

  const validated = raw as NexusMessage;

  if (repository) {
    const duplicate = await repository.getById(validated.id);
    if (duplicate) {
      return { status: "duplicate", message: duplicate };
    }
  }

  const now = nowUnixSeconds();
  if (validated.ttl <= now) {
    return { status: "expired", reason: "TTL is already expired." };
  }

  const incoming = normalizeIngressMessage(validated);

  if (repository) {

    if (incoming.supersedes) {
      const oldMessage = await repository.getById(incoming.supersedes);
      if (oldMessage) {
        await repository.put(mergeSupersedes(oldMessage, incoming.id));
      }
    }

    await repository.put(incoming);
  }

  const computed = { ...incoming, ...computeFields(incoming) };
  return { status: "stored", message: computed };
}

export function runScoringLoop(
  repository: NexusRepository,
  intervalMs = 15_000,
): () => void {
  const timer = window.setInterval(async () => {
    const all = await repository.getAll();
    const normalized: NexusMessage[] = all.map((message) => ({
      id: message.id,
      type: message.type,
      priority: message.priority,
      ttl: message.ttl,
      created_at: message.created_at,
      hop_count: message.hop_count,
      weight: message.weight,
      payload: message.payload,
      confidence: message.confidence,
      supersedes: message.supersedes,
      superseded_by: message.superseded_by,
      schema_version: message.schema_version,
    }));

    await repository.putMany(normalized);
  }, intervalMs);

  return () => window.clearInterval(timer);
}

export function toComputed(message: NexusMessage): NexusMessageWithComputed {
  return { ...message, ...computeFields(message) };
}
