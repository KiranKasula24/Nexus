import type { PipelineRun } from "./agent-runtime";
import {
  normalizeStringList,
  type NexusUserProfile,
  profileKeywordList,
} from "./profile";
import type { NexusMessageWithComputed } from "./types";

export interface SyncShowcasePreview {
  id: string;
  type: NexusMessageWithComputed["type"];
  payload: string;
  temperature: NexusMessageWithComputed["temperature"];
}

export interface SyncShowcase {
  summary: string;
  localPreferences: string[];
  peerPreferences: string[];
  matchedTopics: string[];
  peerAdvertisedCount: number;
  localMessageCount: number;
  novelCandidateCount: number;
  prioritizedCount: number;
  selectedCount: number;
  droppedForFloor: number;
  droppedForPreference: number;
  receivedCount: number;
  topReceivedMessages: SyncShowcasePreview[];
}

function previewMessages(
  messages: NexusMessageWithComputed[],
): SyncShowcasePreview[] {
  return messages.slice(0, 3).map((message) => ({
    id: message.id,
    type: message.type,
    payload: message.payload,
    temperature: message.temperature,
  }));
}

function uniqueMatchedTopics(
  localProfile?: NexusUserProfile,
  peerProfile?: NexusUserProfile,
  pipelineTopics: string[] = [],
): string[] {
  const localKeywords = new Set(profileKeywordList(localProfile));
  const peerKeywords = new Set(profileKeywordList(peerProfile));
  const overlap = new Set<string>();

  for (const keyword of localKeywords) {
    if (peerKeywords.has(keyword)) {
      overlap.add(keyword);
    }
  }

  for (const topic of pipelineTopics) {
    overlap.add(topic);
  }

  return normalizeStringList([...overlap]);
}

function readStageMetrics(run?: PipelineRun): {
  localMessageCount: number;
  novelCandidateCount: number;
  prioritizedCount: number;
  selectedCount: number;
  droppedForFloor: number;
  droppedForPreference: number;
  matchedTopics: string[];
} {
  const bloomStage = run?.stages.find((stage) => stage.component === "Bloom Filter");
  const prioritizationStage = run?.stages.find(
    (stage) => stage.component === "Prioritization Agent",
  );
  const relayStage = run?.stages.find((stage) => stage.component === "Relay Gate");

  return {
    localMessageCount: bloomStage?.inputCount ?? 0,
    novelCandidateCount: bloomStage?.outputCount ?? 0,
    prioritizedCount:
      prioritizationStage?.outputCount ?? bloomStage?.outputCount ?? 0,
    selectedCount: relayStage?.outputCount ?? 0,
    droppedForFloor: relayStage?.droppedForFloor ?? 0,
    droppedForPreference: relayStage?.droppedForPreference ?? 0,
    matchedTopics: relayStage?.matchedTopics ?? [],
  };
}

function buildSummary(input: {
  selectedCount: number;
  receivedCount: number;
  matchedTopics: string[];
  bloomSavedCount: number;
}): string {
  const { selectedCount, receivedCount, matchedTopics, bloomSavedCount } = input;

  if (selectedCount === 0 && receivedCount === 0) {
    return bloomSavedCount > 0
      ? `Bloom filtering avoided ${bloomSavedCount} redundant transfer${bloomSavedCount === 1 ? "" : "s"}, so sync skipped data the peer already had.`
      : "The peer already had the most relevant data, so limited-time sync avoided unnecessary transfer.";
  }

  if (matchedTopics.length > 0) {
    return `Nexus used both profiles to prioritize ${selectedCount} message${selectedCount === 1 ? "" : "s"} around ${matchedTopics.slice(0, 3).join(", ")} and delivered ${receivedCount} useful update${receivedCount === 1 ? "" : "s"}.`;
  }

  return `Nexus used bloom diffing and priority ranking to send ${selectedCount} high-value message${selectedCount === 1 ? "" : "s"} and receive ${receivedCount} update${receivedCount === 1 ? "" : "s"} during limited-time sync.`;
}

export function buildSyncShowcase(input: {
  localProfile?: NexusUserProfile;
  peerProfile?: NexusUserProfile;
  peerAdvertisedCount: number;
  senderRun?: PipelineRun;
  receivedMessages: NexusMessageWithComputed[];
}): SyncShowcase {
  const metrics = readStageMetrics(input.senderRun);
  const matchedTopics = uniqueMatchedTopics(
    input.localProfile,
    input.peerProfile,
    metrics.matchedTopics,
  );
  const bloomSavedCount = Math.max(
    0,
    metrics.localMessageCount - metrics.novelCandidateCount,
  );

  return {
    summary: buildSummary({
      selectedCount: metrics.selectedCount,
      receivedCount: input.receivedMessages.length,
      matchedTopics,
      bloomSavedCount,
    }),
    localPreferences: normalizeStringList([
      ...(input.localProfile?.preferences ?? []),
      ...(input.localProfile?.crucialTopics ?? []),
    ]),
    peerPreferences: normalizeStringList([
      ...(input.peerProfile?.preferences ?? []),
      ...(input.peerProfile?.crucialTopics ?? []),
    ]),
    matchedTopics,
    peerAdvertisedCount: input.peerAdvertisedCount,
    localMessageCount: metrics.localMessageCount,
    novelCandidateCount: metrics.novelCandidateCount,
    prioritizedCount: metrics.prioritizedCount,
    selectedCount: metrics.selectedCount,
    droppedForFloor: metrics.droppedForFloor,
    droppedForPreference: metrics.droppedForPreference,
    receivedCount: input.receivedMessages.length,
    topReceivedMessages: previewMessages(input.receivedMessages),
  };
}
