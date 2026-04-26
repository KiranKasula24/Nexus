const ROOM_CODE_LENGTH = 6;
const SIGNAL_POLL_INTERVAL_MS = 1_500;

interface SignalRoomCreateResponse {
  ok: boolean;
  room?: string;
  expiresAt?: string;
  error?: string;
}

interface SignalRoomReadResponse {
  ok: boolean;
  room?: string;
  role?: "offer" | "answer";
  status?: "waiting" | "answered";
  expiresAt?: string;
  sdp?: string | null;
  error?: string;
}

interface SignalRoomPublishResponse {
  ok: boolean;
  room?: string;
  status?: "waiting" | "answered";
  expiresAt?: string;
  error?: string;
}

function readError(response: {
  ok: boolean;
  error?: string;
}): string {
  return response.error || "Signal server request failed.";
}

export function normalizeRoomCode(input: string): string {
  return input.replace(/\D/g, "").slice(0, ROOM_CODE_LENGTH);
}

export function isValidRoomCode(input: string): boolean {
  return new RegExp(`^\\d{${ROOM_CODE_LENGTH}}$`).test(input);
}

export async function createSignalRoom(
  offerSdp: string,
): Promise<{ room: string; expiresAt: string }> {
  const response = await fetch("/api/signal/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offerSdp }),
  });
  const data = (await response.json()) as SignalRoomCreateResponse;

  if (!response.ok || !data.ok || !data.room || !data.expiresAt) {
    throw new Error(readError(data));
  }

  return { room: data.room, expiresAt: data.expiresAt };
}

export async function getSignalOffer(room: string): Promise<string> {
  const response = await fetch(`/api/signal/${room}?role=offer`, {
    cache: "no-store",
  });
  const data = (await response.json()) as SignalRoomReadResponse;

  if (!response.ok || !data.ok || !data.sdp) {
    throw new Error(readError(data));
  }

  return data.sdp;
}

export async function publishSignalAnswer(
  room: string,
  answerSdp: string,
): Promise<void> {
  const response = await fetch(`/api/signal/${room}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "answer", sdp: answerSdp }),
  });
  const data = (await response.json()) as SignalRoomPublishResponse;

  if (!response.ok || !data.ok) {
    throw new Error(readError(data));
  }
}

export async function waitForSignalAnswer(
  room: string,
  timeoutMs: number,
): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`/api/signal/${room}?role=answer`, {
      cache: "no-store",
    });
    const data = (await response.json()) as SignalRoomReadResponse;

    if (!response.ok || !data.ok) {
      throw new Error(readError(data));
    }

    if (data.sdp) {
      return data.sdp;
    }

    await new Promise((resolve) =>
      window.setTimeout(resolve, SIGNAL_POLL_INTERVAL_MS),
    );
  }

  throw new Error("Timed out waiting for the receiver to join this code.");
}
