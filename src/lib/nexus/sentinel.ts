import bcrypt from "bcryptjs";
import {
  LEVEL2_MAX_PIN_ATTEMPTS,
  PIN_HASH_COST,
  SHAKE_EVENTS_FOR_LEVEL3,
  SHAKE_THRESHOLD_MS2,
  SHAKE_WINDOW_MS,
} from "./constants";
import { deleteBridgeDb } from "./db";
import type { NexusRepository } from "./repository";

const LEVEL2_ATTEMPTS_KEY = "nexus.level2.pin_attempts";
const PIN_HASH_KEY = "pin_hash";
export const SENTINEL_LOCKED_KEY = "sentinel.locked";

export function clearPinAttempts(): void {
  try {
    localStorage.removeItem(LEVEL2_ATTEMPTS_KEY);
  } catch {
    // Ignore unavailable storage contexts.
  }
}

function accelerationMagnitude(event: DeviceMotionEvent): number {
  const x = event.accelerationIncludingGravity?.x ?? 0;
  const y = event.accelerationIncludingGravity?.y ?? 0;
  const z = event.accelerationIncludingGravity?.z ?? 0;
  return Math.sqrt(x * x + y * y + z * z);
}

function getAttempts(): number {
  const value = localStorage.getItem(LEVEL2_ATTEMPTS_KEY);
  return value ? Number(value) || 0 : 0;
}

function setAttempts(value: number): void {
  localStorage.setItem(LEVEL2_ATTEMPTS_KEY, String(value));
}

export async function hashPin(pin: string): Promise<string> {
  if (!/^\d{6}$/.test(pin)) {
    throw new Error("PIN must be exactly 6 digits.");
  }
  return bcrypt.hash(pin, PIN_HASH_COST);
}

export async function savePinHash(
  repository: NexusRepository,
  pin: string,
): Promise<string> {
  const hash = await hashPin(pin);
  await repository.setSystemState(PIN_HASH_KEY, hash);
  clearPinAttempts();
  return hash;
}

export async function loadPinHash(
  repository: NexusRepository,
): Promise<string | undefined> {
  return repository.getSystemState<string>(PIN_HASH_KEY);
}

export async function setRelayBlockedState(
  repository: NexusRepository,
  blocked: boolean,
): Promise<void> {
  await repository.setSystemState(SENTINEL_LOCKED_KEY, blocked);
}

export async function shouldRelayBlocked(
  repository: NexusRepository,
): Promise<boolean> {
  return (await repository.getSystemState<boolean>(SENTINEL_LOCKED_KEY)) ?? false;
}

export async function verifyPin(
  pin: string,
  pinHash: string,
): Promise<boolean> {
  return bcrypt.compare(pin, pinHash);
}

export async function runLevel2Wipe(
  repository: NexusRepository,
): Promise<{ deleted: number }> {
  const all = await repository.getAll();
  const ids = all
    .filter(
      (message) => message.type === "alert" || message.temperature === "hot",
    )
    .map((message) => message.id);

  await repository.deleteByIds(ids);
  clearPinAttempts();
  return { deleted: ids.length };
}

export async function submitPinAttempt(
  repository: NexusRepository,
  pin: string,
  pinHash: string,
): Promise<{
  ok: boolean;
  attemptsLeft: number;
  wiped: boolean;
  deleted: number;
}> {
  const ok = await verifyPin(pin, pinHash);
  if (ok) {
    clearPinAttempts();
    return {
      ok: true,
      attemptsLeft: LEVEL2_MAX_PIN_ATTEMPTS,
      wiped: false,
      deleted: 0,
    };
  }

  const attempts = getAttempts() + 1;
  setAttempts(attempts);

  if (attempts >= LEVEL2_MAX_PIN_ATTEMPTS) {
    const result = await runLevel2Wipe(repository);
    return { ok: false, attemptsLeft: 0, wiped: true, deleted: result.deleted };
  }

  return {
    ok: false,
    attemptsLeft: Math.max(0, LEVEL2_MAX_PIN_ATTEMPTS - attempts),
    wiped: false,
    deleted: 0,
  };
}

export async function runLevel3Wipe(
  repository: NexusRepository,
): Promise<number> {
  const start = performance.now();
  await repository.clearAllStores();
  await repository.shutdown();

  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // Ignore unavailable storage contexts.
  }

  if (typeof caches !== "undefined") {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }

  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }

  await deleteBridgeDb();

  const elapsed = performance.now() - start;
  return elapsed;
}

export async function requestMotionPermissionIfNeeded(): Promise<boolean> {
  const motionEvent = DeviceMotionEvent as typeof DeviceMotionEvent & {
    requestPermission?: () => Promise<"granted" | "denied">;
  };

  if (typeof motionEvent?.requestPermission !== "function") {
    return true;
  }

  const result = await motionEvent.requestPermission();
  return result === "granted";
}

export function monitorTripleShake(onTriggerLevel3: () => void): () => void {
  const spikes: number[] = [];

  const handler = (event: DeviceMotionEvent): void => {
    const magnitude = accelerationMagnitude(event);
    if (magnitude <= SHAKE_THRESHOLD_MS2) return;

    const now = Date.now();
    spikes.push(now);

    while (spikes.length > 0 && now - spikes[0] > SHAKE_WINDOW_MS) {
      spikes.shift();
    }

    if (spikes.length >= SHAKE_EVENTS_FOR_LEVEL3) {
      spikes.length = 0;
      onTriggerLevel3();
    }
  };

  window.addEventListener("devicemotion", handler);
  return () => window.removeEventListener("devicemotion", handler);
}
