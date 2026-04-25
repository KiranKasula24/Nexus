import { BLOOM_BITS, BLOOM_BYTES, BLOOM_HASHES } from "./constants";
import { sortByScoreDesc } from "./scoring";
import type { NexusMessage } from "./types";

function base64FromBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function bytesFromBase64(encoded: string): Uint8Array {
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

function fnv1a(str: string, seed: number): number {
  let hash = 0x811c9dc5 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function bitPosition(id: string, hashIndex: number): number {
  const h1 = fnv1a(id, 0x9e3779b1 + hashIndex);
  const h2 = fnv1a(id, 0x85ebca6b + hashIndex * 17);
  return (h1 + hashIndex * h2) % BLOOM_BITS;
}

export class BloomFilter {
  private readonly bits: Uint8Array;

  constructor(initial?: Uint8Array) {
    this.bits = initial ? new Uint8Array(initial) : new Uint8Array(BLOOM_BYTES);
  }

  add(id: string): void {
    for (let i = 0; i < BLOOM_HASHES; i += 1) {
      const position = bitPosition(id, i);
      const byteIndex = Math.floor(position / 8);
      const bitIndex = position % 8;
      this.bits[byteIndex] |= 1 << bitIndex;
    }
  }

  test(id: string): boolean {
    for (let i = 0; i < BLOOM_HASHES; i += 1) {
      const position = bitPosition(id, i);
      const byteIndex = Math.floor(position / 8);
      const bitIndex = position % 8;
      if ((this.bits[byteIndex] & (1 << bitIndex)) === 0) {
        return false;
      }
    }
    return true;
  }

  toBase64(): string {
    return base64FromBytes(this.bits);
  }

  static fromBase64(encoded: string): BloomFilter {
    const bytes = bytesFromBase64(encoded);
    if (bytes.byteLength !== BLOOM_BYTES) {
      throw new Error("Invalid bloom filter payload length.");
    }
    return new BloomFilter(bytes);
  }
}

export function buildBloomFromMessages(messages: NexusMessage[]): BloomFilter {
  const bloom = new BloomFilter();
  for (const message of messages) {
    bloom.add(message.id);
  }
  return bloom;
}

export function selectMessagesNotInBloom(
  messages: NexusMessage[],
  remoteBloom: BloomFilter,
): NexusMessage[] {
  return sortByScoreDesc(messages).filter(
    (message) => !remoteBloom.test(message.id),
  );
}

export function estimateFalsePositiveRate(
  bloom: BloomFilter,
  unknownIds: string[],
): number {
  if (unknownIds.length === 0) return 0;

  let positives = 0;
  for (const id of unknownIds) {
    if (bloom.test(id)) positives += 1;
  }
  return positives / unknownIds.length;
}
