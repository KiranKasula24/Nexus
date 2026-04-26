import type { NexusMessage } from "./types";

export const USER_PROFILE_KEY = "user_profile";

export interface NexusUserProfile {
  preferences: string[];
  requirements: string;
  crucialTopics: string[];
  createdAt: number;
  updatedAt: number;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeStringList(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = normalizeToken(value);
    if (!normalized) continue;
    unique.add(normalized);
  }
  return [...unique];
}

export function parseCommaSeparatedList(input: string): string[] {
  return normalizeStringList(input.split(","));
}

function tokenizeText(input: string): string[] {
  const matches = input.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  return normalizeStringList(matches);
}

function profileKeywords(profile: NexusUserProfile): string[] {
  return normalizeStringList([
    ...profile.preferences,
    ...profile.crucialTopics,
    ...tokenizeText(profile.requirements),
  ]);
}

function payloadContainsKeyword(payload: string, keyword: string): boolean {
  return payload.toLowerCase().includes(keyword);
}

export function scoreMessageForProfile(
  message: NexusMessage,
  profile?: NexusUserProfile,
): number {
  if (!profile) return 0;

  const keywords = profileKeywords(profile);
  if (keywords.length === 0) return 0;

  const topicSet = new Set(normalizeStringList(message.crucial_topics ?? []));
  let score = 0;

  for (const keyword of keywords) {
    if (topicSet.has(keyword)) {
      score += 3;
      continue;
    }

    if (payloadContainsKeyword(message.payload, keyword)) {
      score += 1;
    }
  }

  return score;
}

export function prioritizeMessagesForProfile(
  messages: NexusMessage[],
  profile?: NexusUserProfile,
): NexusMessage[] {
  if (!profile || messages.length <= 1) return messages;

  return [...messages]
    .map((message, index) => ({
      message,
      index,
      profileScore: scoreMessageForProfile(message, profile),
    }))
    .sort((a, b) => {
      if (b.profileScore === a.profileScore) {
        return a.index - b.index;
      }
      return b.profileScore - a.profileScore;
    })
    .map((entry) => entry.message);
}
