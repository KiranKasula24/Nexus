import pako from "pako";
import { SCORING_INTERVAL_MS, WEBRTC_CHANNEL_NAME } from "./constants";
import { ingestMessage } from "./phase2";
import {
  buildBloomFromMessages,
  BloomFilter,
  selectMessagesNotInBloom,
} from "./phase4";
import type { NexusRepository } from "./repository";
import type { IngestResult, NexusMessage } from "./types";

export type SyncStatus = "accepted" | "duplicate" | "invalid" | "expired";

export type SyncWireMessage =
  | { type: "STATUS_REQ"; schema_version: 1 }
  | {
      type: "STATUS_RES";
      schema_version: 1;
      accepted: boolean;
      message_count: number;
      storage_used_bytes: number;
    }
  | { type: "BLOOM_OFFER"; bloom: string; message_count: number }
  | { type: "BLOOM_ACK" }
  | { type: "MSG_PUSH"; message: NexusMessage }
  | { type: "MSG_ACK"; id: string; status: SyncStatus }
  | { type: "SYNC_DONE"; sent_count: number };

export interface SyncSessionSummary {
  sent: number;
  accepted: number;
  duplicate: number;
  invalid: number;
  expired: number;
  sessionId: string;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(encoded, "base64"));
  }

  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function createSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}

export function encodeWebRtcToken(payload: RTCSessionDescriptionInit): string {
  const compressed = pako.deflate(JSON.stringify(payload));
  return `W${toBase64(compressed)}`;
}

export function decodeWebRtcToken(token: string): RTCSessionDescriptionInit {
  if (!token.startsWith("W")) {
    throw new Error("WebRTC token must start with W prefix.");
  }

  const compressed = fromBase64(token.slice(1));
  const json = pako.inflate(compressed, { to: "string" }) as string;
  return JSON.parse(json) as RTCSessionDescriptionInit;
}

export interface PeerArtifacts {
  connection: RTCPeerConnection;
  channel: RTCDataChannel;
}

async function waitForIceGatheringComplete(
  connection: RTCPeerConnection,
): Promise<void> {
  if (connection.iceGatheringState === "complete") {
    return;
  }

  await new Promise<void>((resolve) => {
    const listener = (): void => {
      if (connection.iceGatheringState === "complete") {
        connection.removeEventListener("icegatheringstatechange", listener);
        resolve();
      }
    };

    connection.addEventListener("icegatheringstatechange", listener);
  });
}

export async function createInitiator(): Promise<{
  peer: PeerArtifacts;
  offerToken: string;
}> {
  const connection = new RTCPeerConnection({ iceServers: [] });
  const channel = connection.createDataChannel(WEBRTC_CHANNEL_NAME);

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  await waitForIceGatheringComplete(connection);

  return {
    peer: { connection, channel },
    offerToken: encodeWebRtcToken(connection.localDescription ?? offer),
  };
}

export async function createJoiner(
  offerToken: string,
): Promise<{ peer: PeerArtifacts; answerToken: string }> {
  const connection = new RTCPeerConnection({ iceServers: [] });
  const offer = decodeWebRtcToken(offerToken);
  await connection.setRemoteDescription(offer);

  const channel = await new Promise<RTCDataChannel>((resolve) => {
    connection.ondatachannel = (event) => resolve(event.channel);
  });

  const answer = await connection.createAnswer();
  await connection.setLocalDescription(answer);
  await waitForIceGatheringComplete(connection);

  return {
    peer: { connection, channel },
    answerToken: encodeWebRtcToken(connection.localDescription ?? answer),
  };
}

export async function finalizeInitiator(
  connection: RTCPeerConnection,
  answerToken: string,
): Promise<void> {
  const answer = decodeWebRtcToken(answerToken);
  await connection.setRemoteDescription(answer);
}

function toStatus(result: IngestResult): SyncStatus {
  if (result.status === "stored") return "accepted";
  if (result.status === "duplicate") return "duplicate";
  if (result.status === "expired") return "expired";
  return "invalid";
}

export async function runLocalSyncSession(
  senderRepo: NexusRepository,
  receiverRepo: NexusRepository,
  options?: { remoteKnownIds?: string[] },
): Promise<SyncSessionSummary> {
  const allSenderMessages = await senderRepo.getAllRaw();
  const receiverMessages = await receiverRepo.getAllRaw();
  const remoteBloom = (() => {
    if (options?.remoteKnownIds) {
      const bloom = new BloomFilter();
      for (const id of options.remoteKnownIds) {
        bloom.add(id);
      }
      return bloom;
    }

    return buildBloomFromMessages(receiverMessages);
  })();

  const queue = selectMessagesNotInBloom(allSenderMessages, remoteBloom);

  let accepted = 0;
  let duplicate = 0;
  let invalid = 0;
  let expired = 0;

  for (const message of queue) {
    const result = await ingestMessage(message, receiverRepo);
    const status = toStatus(result);

    if (status === "accepted") accepted += 1;
    else if (status === "duplicate") duplicate += 1;
    else if (status === "invalid") invalid += 1;
    else expired += 1;
  }

  const sessionId = createSessionId();
  await senderRepo.writeEncounterLog({
    sessionId,
    messageIdsExchanged: queue.map((m) => m.id),
  });

  return {
    sent: queue.length,
    accepted,
    duplicate,
    invalid,
    expired,
    sessionId,
  };
}

export function createStatusReq(): SyncWireMessage {
  return { type: "STATUS_REQ", schema_version: 1 };
}

export function createStatusRes(schemaVersion: 1): SyncWireMessage {
  return {
    type: "STATUS_RES",
    schema_version: schemaVersion,
    accepted: schemaVersion === 1,
    message_count: 0,
    storage_used_bytes: 0,
  };
}

export function createBloomOffer(messages: NexusMessage[]): SyncWireMessage {
  return {
    type: "BLOOM_OFFER",
    bloom: buildBloomFromMessages(messages).toBase64(),
    message_count: messages.length,
  };
}

export function parseBloomOffer(message: SyncWireMessage): BloomFilter {
  if (message.type !== "BLOOM_OFFER") {
    throw new Error("Expected BLOOM_OFFER message.");
  }
  return BloomFilter.fromBase64(message.bloom);
}

export const SYNC_RECOMMENDED_TICK_MS = SCORING_INTERVAL_MS;
