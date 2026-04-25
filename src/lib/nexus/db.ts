import { NEXUS_DB_NAME, NEXUS_DB_VERSION } from "./constants";
import type { NexusMessage } from "./types";

export const STORE_MESSAGES = "messages";
export const STORE_ENCOUNTER_LOG = "encounter_log";
export const STORE_SYSTEM_STATE = "system_state";
export const ALL_STORES = [
  STORE_MESSAGES,
  STORE_ENCOUNTER_LOG,
  STORE_SYSTEM_STATE,
] as const;

function assertIndexedDbSupport(): void {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is unavailable in this environment.");
  }
}

export function openBridgeDb(dbName = NEXUS_DB_NAME): Promise<IDBDatabase> {
  assertIndexedDbSupport();

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, NEXUS_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const messages = db.createObjectStore(STORE_MESSAGES, {
          keyPath: "id",
        });
        messages.createIndex("by_ttl", "ttl", { unique: false });
        messages.createIndex("by_weight", "weight", { unique: false });
        messages.createIndex("by_created_at", "created_at", { unique: false });
        messages.createIndex("by_type", "type", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_ENCOUNTER_LOG)) {
        db.createObjectStore(STORE_ENCOUNTER_LOG, { keyPath: "session_id" });
      }

      if (!db.objectStoreNames.contains(STORE_SYSTEM_STATE)) {
        db.createObjectStore(STORE_SYSTEM_STATE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open database."));
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed."));
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted."));
  });
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export async function getAllMessagesRaw(
  db: IDBDatabase,
): Promise<NexusMessage[]> {
  const tx = db.transaction(STORE_MESSAGES, "readonly");
  const store = tx.objectStore(STORE_MESSAGES);
  const all = (await requestResult(store.getAll())) as NexusMessage[];
  await txDone(tx);
  return all;
}

export async function clearStores(
  db: IDBDatabase,
  stores: readonly string[],
): Promise<void> {
  const tx = db.transaction([...stores], "readwrite");
  for (const storeName of stores) {
    tx.objectStore(storeName).clear();
  }
  await txDone(tx);
}

export function deleteBridgeDb(dbName = NEXUS_DB_NAME): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to delete bridge_db."));
    request.onblocked = () =>
      reject(new Error("Delete blocked by open connections."));
  });
}
