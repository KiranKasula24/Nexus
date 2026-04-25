import {
  EVICTION_TARGET_BYTES,
  EVICTION_TRIGGER_BYTES,
  EXPIRY_SWEEP_INTERVAL_MS,
} from "./constants";
import {
  ALL_STORES,
  clearStores,
  openBridgeDb,
  requestResult,
  STORE_ENCOUNTER_LOG,
  STORE_MESSAGES,
  STORE_SYSTEM_STATE,
  txDone,
} from "./db";
import { computeFields } from "./scoring";
import { floorToHour, nowUnixSeconds } from "./time";
import type {
  NexusMessage,
  NexusMessageWithComputed,
  Temperature,
} from "./types";

export interface EncounterLogEntry {
  session_id: string;
  approximate_time: number;
  message_ids_exchanged: string[];
}

export class NexusRepository {
  private dbPromise: Promise<IDBDatabase>;

  constructor(dbName?: string) {
    this.dbPromise = openBridgeDb(dbName ?? "bridge_db");
  }

  async getAll(): Promise<NexusMessageWithComputed[]> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_MESSAGES, "readonly");
    const store = tx.objectStore(STORE_MESSAGES);
    const rows = (await requestResult(store.getAll())) as NexusMessage[];
    await txDone(tx);

    return rows
      .filter((message) => message.ttl >= nowUnixSeconds())
      .map((m) => ({ ...m, ...computeFields(m) }))
      .sort((a, b) => b.score - a.score);
  }

  async getById(id: string): Promise<NexusMessageWithComputed | undefined> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_MESSAGES, "readonly");
    const store = tx.objectStore(STORE_MESSAGES);
    const row = (await requestResult(store.get(id))) as
      | NexusMessage
      | undefined;
    await txDone(tx);

    if (!row || row.ttl < nowUnixSeconds()) return undefined;
    return { ...row, ...computeFields(row) };
  }

  async getByType(
    type: NexusMessage["type"],
  ): Promise<NexusMessageWithComputed[]> {
    const all = await this.getAll();
    return all.filter((m) => m.type === type);
  }

  async getByTemperature(
    temperature: Temperature,
  ): Promise<NexusMessageWithComputed[]> {
    const all = await this.getAll();
    return all.filter((m) => m.temperature === temperature);
  }

  async getAllRaw(): Promise<NexusMessage[]> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_MESSAGES, "readonly");
    const rows = (await requestResult(
      tx.objectStore(STORE_MESSAGES).getAll(),
    )) as NexusMessage[];
    await txDone(tx);
    return rows.filter((message) => message.ttl >= nowUnixSeconds());
  }

  async put(message: NexusMessage): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_MESSAGES, "readwrite");
    tx.objectStore(STORE_MESSAGES).put(message);
    await txDone(tx);
    await this.sweepExpired();
    await this.runEviction();
  }

  async putMany(messages: NexusMessage[]): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_MESSAGES, "readwrite");
    const store = tx.objectStore(STORE_MESSAGES);
    for (const message of messages) {
      store.put(message);
    }
    await txDone(tx);
    await this.sweepExpired();
    await this.runEviction();
  }

  async sweepExpired(now = nowUnixSeconds()): Promise<number> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_MESSAGES, "readwrite");
    const store = tx.objectStore(STORE_MESSAGES);
    const all = (await requestResult(store.getAll())) as NexusMessage[];

    let deleted = 0;
    for (const message of all) {
      if (message.ttl < now) {
        store.delete(message.id);
        deleted += 1;
      }
    }

    await txDone(tx);
    return deleted;
  }

  startExpirySweep(intervalMs = EXPIRY_SWEEP_INTERVAL_MS): () => void {
    const timer = window.setInterval(() => {
      void this.sweepExpired();
    }, intervalMs);

    return () => window.clearInterval(timer);
  }

  async runEviction(): Promise<number> {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate?.usage) return 0;
    if (estimate.usage <= EVICTION_TRIGGER_BYTES) return 0;

    const db = await this.dbPromise;
    const tx = db.transaction(STORE_MESSAGES, "readwrite");
    const store = tx.objectStore(STORE_MESSAGES);
    const all = (await requestResult(store.getAll())) as NexusMessage[];

    const candidates = all
      .map((m) => ({ message: m, computed: computeFields(m) }))
      .filter(
        (entry) =>
          entry.message.type !== "alert" &&
          entry.computed.temperature !== "hot",
      )
      .sort((a, b) => {
        if (a.message.weight === b.message.weight) {
          return a.message.created_at - b.message.created_at;
        }
        return a.message.weight - b.message.weight;
      });

    let usage = estimate.usage;
    let deleted = 0;

    for (const candidate of candidates) {
      if (usage < EVICTION_TARGET_BYTES) break;
      store.delete(candidate.message.id);
      usage -= 1024;
      deleted += 1;
    }

    await txDone(tx);
    return deleted;
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const db = await this.dbPromise;
    const tx = db.transaction(STORE_MESSAGES, "readwrite");
    const store = tx.objectStore(STORE_MESSAGES);
    for (const id of ids) {
      store.delete(id);
    }
    await txDone(tx);
  }

  async writeEncounterLog(entry: {
    sessionId: string;
    messageIdsExchanged: string[];
  }): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_ENCOUNTER_LOG, "readwrite");
    tx.objectStore(STORE_ENCOUNTER_LOG).put({
      session_id: entry.sessionId,
      approximate_time: floorToHour(nowUnixSeconds()),
      message_ids_exchanged: entry.messageIdsExchanged,
    } satisfies EncounterLogEntry);
    await txDone(tx);
  }

  async clearAllStores(): Promise<void> {
    const db = await this.dbPromise;
    await clearStores(db, ALL_STORES);
  }

  async getSystemState<T = unknown>(key: string): Promise<T | undefined> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_SYSTEM_STATE, "readonly");
    const row = (await requestResult(
      tx.objectStore(STORE_SYSTEM_STATE).get(key),
    )) as
      | {
          key: string;
          value: T;
        }
      | undefined;
    await txDone(tx);
    return row?.value;
  }

  async setSystemState<T>(key: string, value: T): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_SYSTEM_STATE, "readwrite");
    tx.objectStore(STORE_SYSTEM_STATE).put({ key, value });
    await txDone(tx);
  }
}
