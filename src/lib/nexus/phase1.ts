import { DEFAULT_TTL_HOURS } from "./constants";
import { sha256Hex16 } from "./hash";
import { floorToHour, nowUnixSeconds } from "./time";
import type { Confidence, MessageType, NexusMessage } from "./types";

export interface CreateMessageInput {
  type: MessageType;
  priority: 1 | 2 | 3 | 4 | 5;
  payload: string;
  ttlHours?: number;
  confidence?: Confidence;
  supersedes?: string;
}

function defaultConfidence(type: MessageType): Confidence {
  if (type === "audio") return "low";
  return "high";
}

export async function createMessage(
  input: CreateMessageInput,
): Promise<NexusMessage> {
  const createdAt = floorToHour(nowUnixSeconds());
  const ttlHours = input.ttlHours ?? DEFAULT_TTL_HOURS[input.type];
  const ttl = floorToHour(createdAt + ttlHours * 3600);

  const idSource = `${input.type}${createdAt}${input.payload}`;
  const id = await sha256Hex16(idSource);

  return {
    id,
    type: input.type,
    priority: input.priority,
    ttl,
    created_at: createdAt,
    hop_count: 0,
    weight: 1,
    payload: input.payload,
    confidence: input.confidence ?? defaultConfidence(input.type),
    supersedes: input.supersedes,
    schema_version: 1,
  };
}
