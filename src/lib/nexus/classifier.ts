import { normalizeStringList } from "./profile";
import type { NexusMessage } from "./types";

const TOPIC_KEYWORDS: Record<string, string[]> = {
  safety: [
    "danger",
    "hazard",
    "unsafe",
    "attack",
    "fire",
    "flood",
    "collapse",
    "violence",
    "evacuate",
    "secure",
  ],
  medical: [
    "medical",
    "medicine",
    "doctor",
    "injury",
    "bleeding",
    "burn",
    "ambulance",
    "hospital",
    "first aid",
    "patient",
  ],
  shelter: [
    "shelter",
    "camp",
    "tent",
    "housing",
    "bed",
    "sleep",
    "refuge",
    "evacuation center",
  ],
  route: [
    "route",
    "road",
    "bridge",
    "path",
    "traffic",
    "blocked",
    "detour",
    "gate",
    "checkpoint",
  ],
  water: [
    "water",
    "thirst",
    "drink",
    "hydration",
    "well",
    "tank",
    "bottle",
  ],
  power: [
    "power",
    "electric",
    "electricity",
    "battery",
    "charge",
    "generator",
    "outage",
    "grid",
  ],
};

export interface ClassificationResult {
  topics: string[];
  inferredTopics: string[];
  matchedKeywords: string[];
}

function includesKeyword(payload: string, keyword: string): boolean {
  return payload.includes(keyword);
}

export function classifyPayload(
  payload: string,
  existingTopics: string[] = [],
): ClassificationResult {
  const normalizedPayload = payload.toLowerCase();
  const inferredTopics: string[] = [];
  const matchedKeywords: string[] = [];

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const hit = keywords.find((keyword) =>
      includesKeyword(normalizedPayload, keyword),
    );
    if (!hit) continue;
    inferredTopics.push(topic);
    matchedKeywords.push(`${topic}:${hit}`);
  }

  const topics = normalizeStringList([...existingTopics, ...inferredTopics]);
  return {
    topics,
    inferredTopics: normalizeStringList(inferredTopics),
    matchedKeywords,
  };
}

export function classifyMessage(message: NexusMessage): ClassificationResult {
  return classifyPayload(message.payload, message.crucial_topics ?? []);
}
