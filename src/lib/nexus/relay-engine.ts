import { mergeSupersedes } from "./phase2";
import { BloomFilter, selectMessagesNotInBloom } from "./phase4";
import { messageProfileMatches, type NexusUserProfile } from "./profile";
import type { NexusRepository } from "./repository";
import { computeFields, sortByScoreDesc } from "./scoring";
import type { NexusMessage, NexusMessageWithComputed } from "./types";

export interface RelaySelection {
  rankedMessages: NexusMessageWithComputed[];
  selectedMessages: NexusMessage[];
}

export interface RelayGateResult {
  selectedMessages: NexusMessage[];
  droppedForFloor: number;
  droppedForPreference: number;
  matchedTopics: string[];
  sentinelBlocked: boolean;
  reason?: string;
}

export async function rankStoredMessages(
  repository: NexusRepository,
): Promise<NexusMessageWithComputed[]> {
  return repository.getAll();
}

export function computeBloomCandidates(
  messages: NexusMessage[],
  remoteBloom: BloomFilter,
): NexusMessage[] {
  return selectMessagesNotInBloom(messages, remoteBloom);
}

export function rankRelayCandidates(
  messages: NexusMessage[],
): NexusMessageWithComputed[] {
  return sortByScoreDesc(messages).map((message) => ({
    ...message,
    ...computeFields(message),
  }));
}

export function applyRelayGate(
  rankedMessages: NexusMessageWithComputed[],
  profile?: NexusUserProfile,
  options?: {
    priorityFloor?: number;
    blocked?: boolean;
    blockedReason?: string;
  },
): RelayGateResult {
  if (options?.blocked) {
    return {
      selectedMessages: [],
      droppedForFloor: 0,
      droppedForPreference: 0,
      matchedTopics: [],
      sentinelBlocked: true,
      reason: options.blockedReason ?? "blocked by Sentinel - device locked",
    };
  }

  const priorityFloor = options?.priorityFloor ?? 3;
  const matchedTopics = new Set<string>();
  const selectedMessages: NexusMessage[] = [];
  let droppedForFloor = 0;
  let droppedForPreference = 0;

  for (const message of rankedMessages) {
    const meetsFloor = message.priority >= priorityFloor;
    const match = messageProfileMatches(message, profile);

    if (match.matched) {
      for (const topic of match.matchedTopics) {
        matchedTopics.add(topic);
      }
    }

    if (meetsFloor || match.matched) {
      selectedMessages.push({
        id: message.id,
        type: message.type,
        priority: message.priority,
        ttl: message.ttl,
        created_at: message.created_at,
        hop_count: message.hop_count,
        weight: message.weight,
        payload: message.payload,
        media_data_url: message.media_data_url,
        crucial_topics: message.crucial_topics,
        confidence: message.confidence,
        supersedes: message.supersedes,
        superseded_by: message.superseded_by,
        schema_version: message.schema_version,
      });
      continue;
    }

    droppedForFloor += 1;
    if (profile) {
      droppedForPreference += 1;
    }
  }

  return {
    selectedMessages,
    droppedForFloor,
    droppedForPreference,
    matchedTopics: [...matchedTopics],
    sentinelBlocked: false,
  };
}

export async function linkConflictVariant(
  repository: NexusRepository,
  message: NexusMessage,
): Promise<NexusMessageWithComputed | undefined> {
  if (!message.supersedes) {
    return undefined;
  }

  const previous = await repository.getById(message.supersedes);
  if (!previous) {
    return undefined;
  }

  await repository.put(mergeSupersedes(previous, message.id));
  return {
    ...previous,
    ...computeFields(previous),
  };
}
