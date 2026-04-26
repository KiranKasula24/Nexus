import { Redis } from "@upstash/redis";

export const SIGNAL_TTL_SECONDS = 300;
export const ROOM_CODE_LENGTH = 6;
const ROOM_CREATE_ATTEMPTS = 24;
const SIGNAL_NAMESPACE = "nexus:signal";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

export type SignalRole = "offer" | "answer";
export type SignalRoomStatus = "waiting" | "answered";

export interface SignalRoomRecord {
  version: 1;
  room: string;
  status: SignalRoomStatus;
  createdAt: string;
  expiresAt: string;
}

export class SignalRouteError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SignalRouteError";
  }
}

export function optionsResponse(): Response {
  return new Response(null, { status: 200, headers: corsHeaders });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown server error";
}

export function errorResponse(error: unknown): Response {
  if (error instanceof SignalRouteError) {
    return Response.json(
      { ok: false, code: error.code, error: error.message },
      { status: error.status, headers: corsHeaders },
    );
  }

  return Response.json(
    { ok: false, code: "INTERNAL_ERROR", error: errorMessage(error) },
    { status: 500, headers: corsHeaders },
  );
}

function resolveRedisEnv(): { url: string; token: string } {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  const kvUrl = process.env.KV_REST_API_URL?.trim();
  const kvToken = process.env.KV_REST_API_TOKEN?.trim();

  if (upstashUrl && upstashToken) {
    return { url: upstashUrl, token: upstashToken };
  }

  if (kvUrl && kvToken) {
    return { url: kvUrl, token: kvToken };
  }

  const configured = [
    upstashUrl ? "UPSTASH_REDIS_REST_URL" : null,
    upstashToken ? "UPSTASH_REDIS_REST_TOKEN" : null,
    kvUrl ? "KV_REST_API_URL" : null,
    kvToken ? "KV_REST_API_TOKEN" : null,
  ].filter(Boolean);

  throw new SignalRouteError(
    500,
    "REDIS_ENV_INVALID",
    configured.length > 0
      ? `Incomplete Redis env configuration. Provide a full pair of either UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL/KV_REST_API_TOKEN. Currently set: ${configured.join(", ")}`
      : "Missing Redis env configuration. Provide UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL/KV_REST_API_TOKEN.",
  );
}

export function getRedis(): Redis {
  const { url, token } = resolveRedisEnv();
  return new Redis({ url, token });
}

export function assertValidRoomCode(room: string): void {
  const pattern = new RegExp(`^\\d{${ROOM_CODE_LENGTH}}$`);
  if (!pattern.test(room)) {
    throw new SignalRouteError(
      400,
      "ROOM_CODE_INVALID",
      `Room code must be ${ROOM_CODE_LENGTH} digits.`,
    );
  }
}

function signalRoomKey(room: string): string {
  return `${SIGNAL_NAMESPACE}:room:${room}`;
}

export function signalKey(room: string, role: SignalRole): string {
  return `${SIGNAL_NAMESPACE}:room:${room}:${role}`;
}

function nextExpiryIso(): string {
  return new Date(Date.now() + SIGNAL_TTL_SECONDS * 1000).toISOString();
}

function createRoomRecord(
  room: string,
  status: SignalRoomStatus,
  createdAt = new Date().toISOString(),
): SignalRoomRecord {
  return {
    version: 1,
    room,
    status,
    createdAt,
    expiresAt: nextExpiryIso(),
  };
}

function generateRoomCode(): string {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 900_000;
  return String(100_000 + value);
}

export async function getRoomRecord(
  redis: Redis,
  room: string,
): Promise<SignalRoomRecord | null> {
  assertValidRoomCode(room);
  return (await redis.get<SignalRoomRecord>(signalRoomKey(room))) ?? null;
}

export async function requireRoomRecord(
  redis: Redis,
  room: string,
): Promise<SignalRoomRecord> {
  const record = await getRoomRecord(redis, room);
  if (!record) {
    throw new SignalRouteError(
      404,
      "ROOM_NOT_FOUND",
      "Room not found or expired. Create a new code and try again.",
    );
  }

  return record;
}

export async function createSignalRoom(
  redis: Redis,
  offerSdp: string,
): Promise<SignalRoomRecord> {
  for (let attempt = 0; attempt < ROOM_CREATE_ATTEMPTS; attempt += 1) {
    const room = generateRoomCode();
    const record = createRoomRecord(room, "waiting");
    const reserved = await redis.set(signalRoomKey(room), record, {
      ex: SIGNAL_TTL_SECONDS,
      nx: true,
    });

    if (!reserved) {
      continue;
    }

    try {
      await redis.set(signalKey(room, "offer"), offerSdp, {
        ex: SIGNAL_TTL_SECONDS,
      });
      return record;
    } catch (error) {
      await redis.del(signalRoomKey(room));
      throw error;
    }
  }

  throw new SignalRouteError(
    503,
    "ROOM_CREATE_FAILED",
    "Could not allocate a room code right now. Please try again.",
  );
}

export async function publishSignal(
  redis: Redis,
  room: string,
  role: SignalRole,
  sdp: string,
): Promise<SignalRoomRecord> {
  if (role === "offer") {
    throw new SignalRouteError(
      400,
      "ROOM_CREATE_REQUIRED",
      "Create offer rooms via POST /api/signal/rooms.",
    );
  }

  const record = await requireRoomRecord(redis, room);
  const nextRecord = createRoomRecord(room, "answered", record.createdAt);

  await redis.set(signalRoomKey(room), nextRecord, {
    ex: SIGNAL_TTL_SECONDS,
  });
  await redis.set(signalKey(room, role), sdp, {
    ex: SIGNAL_TTL_SECONDS,
  });
  await redis.expire(signalKey(room, "offer"), SIGNAL_TTL_SECONDS);

  return nextRecord;
}
