export type MessageType = "text" | "audio" | "alert";
export type Confidence = "high" | "low";
export type Temperature = "hot" | "warm" | "cold";

export interface NexusMessage {
  id: string;
  type: MessageType;
  priority: 1 | 2 | 3 | 4 | 5;
  ttl: number;
  created_at: number;
  hop_count: number;
  weight: number;
  payload: string;
  confidence: Confidence;
  supersedes?: string;
  superseded_by?: string;
  schema_version: 1;
}

export interface NexusComputedFields {
  temperature: Temperature;
  score: number;
  is_expired: boolean;
  is_superseded: boolean;
}

export type NexusMessageWithComputed = NexusMessage & NexusComputedFields;

export interface IngestResult {
  status: "stored" | "duplicate" | "expired" | "invalid" | "quarantined";
  message?: NexusMessageWithComputed;
  reason?: string;
}
