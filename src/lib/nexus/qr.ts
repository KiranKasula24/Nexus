import pako from "pako";
import {
  SNAPSHOT_MAX_COMPRESSED_BYTES,
  SCANNER_INTERVAL_MS,
} from "./constants";
import { sortByScoreDesc } from "./scoring";
import type { NexusMessage } from "./types";

const SNAPSHOT_PREFIX = "S";
const WEBRTC_PREFIX = "W";
const LEGACY_LIVE_PREFIX = "L";

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

function encodeSnapshotPayload(messages: NexusMessage[]): string {
  const json = JSON.stringify(messages);
  const compressed = pako.deflate(json);
  if (compressed.byteLength > SNAPSHOT_MAX_COMPRESSED_BYTES) {
    throw new Error("Snapshot exceeds 2.3KB compressed payload limit.");
  }

  return `${SNAPSHOT_PREFIX}${toBase64(compressed)}`;
}

export function buildSnapshot(
  messages: NexusMessage[],
  startN = 5,
): { qr: string; count: number } {
  const ranked = sortByScoreDesc(messages);

  for (let n = Math.min(startN, ranked.length); n >= 1; n -= 1) {
    try {
      return { qr: encodeSnapshotPayload(ranked.slice(0, n)), count: n };
    } catch {
      // Keep trying with fewer messages until payload size is valid.
    }
  }

  throw new Error("Unable to create a valid snapshot payload.");
}

export function decodeTransportPayload(
  payload: string,
):
  | { kind: "snapshot"; messages: NexusMessage[] }
  | { kind: "webrtc"; offer: string }
  | { kind: "legacy"; url: string } {
  const prefix = payload[0];
  const body = payload.slice(1);

  if (prefix === SNAPSHOT_PREFIX) {
    const compressed = fromBase64(body);
    const inflated = pako.inflate(compressed, { to: "string" }) as string;
    return {
      kind: "snapshot",
      messages: JSON.parse(inflated) as NexusMessage[],
    };
  }

  if (prefix === WEBRTC_PREFIX) {
    try {
      const compressed = fromBase64(body);
      const inflated = pako.inflate(compressed, { to: "string" }) as string;
      return { kind: "webrtc", offer: inflated };
    } catch {
      return { kind: "webrtc", offer: body };
    }
  }

  if (prefix === LEGACY_LIVE_PREFIX) {
    return { kind: "legacy", url: body };
  }

  throw new Error("Unknown QR payload prefix.");
}

export async function startCameraScanner(
  video: HTMLVideoElement,
  onDecoded: (text: string) => void,
): Promise<() => void> {
  const media = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
  });
  video.srcObject = media;
  await video.play();

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not create canvas context for QR scanning.");
  }

  const jsQR = (await import("jsqr")).default;

  const timer = window.setInterval(() => {
    if (!video.videoWidth || !video.videoHeight) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(image.data, image.width, image.height);
    if (result?.data) {
      window.clearInterval(timer);
      media.getTracks().forEach((track) => track.stop());
      onDecoded(result.data);
    }
  }, SCANNER_INTERVAL_MS);

  return () => {
    window.clearInterval(timer);
    media.getTracks().forEach((track) => track.stop());
  };
}
