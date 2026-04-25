import { mergeSupersedes } from "./phase2";
import { BloomFilter, selectMessagesNotInBloom } from "./phase4";
import type { NexusRepository } from "./repository";
import { computeFields, sortByScoreDesc } from "./scoring";
import type { NexusMessage, NexusMessageWithComputed } from "./types";

export interface RelaySelection {
  rankedMessages: NexusMessageWithComputed[];
  selectedMessages: NexusMessage[];
}

export async function rankStoredMessages(
  repository: NexusRepository,
): Promise<NexusMessageWithComputed[]> {
  return repository.getAll();
}

export async function selectRelayMessages(
  repository: NexusRepository,
  peerBloom?: BloomFilter,
): Promise<RelaySelection> {
  const rankedMessages = await repository.getAll();
  const rawMessages = await repository.getAllRaw();
  const selectedMessages = peerBloom
    ? selectMessagesNotInBloom(rawMessages, peerBloom)
    : sortByScoreDesc(rawMessages);

  return {
    rankedMessages,
    selectedMessages,
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
