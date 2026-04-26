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

interface InMemoryState {
  messages: Map<string, NexusMessage>;
  systemState: Map<string, unknown>;
  encounterLog: Map<string, EncounterLogEntry>;
}

function createInMemoryState(): InMemoryState {
  return {
    messages: new Map<string, NexusMessage>(),
    systemState: new Map<string, unknown>(),
    encounterLog: new Map<string, EncounterLogEntry>(),
  };
}

function withConflictMetadata(
  messages: NexusMessage[],
): NexusMessageWithComputed[] {
  const supersededMap = new Map<string, NexusMessage[]>();

  for (const message of messages) {
    if (!message.supersedes) continue;
    const existing = supersededMap.get(message.supersedes) ?? [];
    existing.push(message);
    supersededMap.set(message.supersedes, existing);
  }

  return messages
    .map((message) => {
      const base = { ...message, ...computeFields(message) };
      const related = new Set<string>();

      if (message.supersedes) {
        related.add(message.supersedes);
        for (const sibling of supersededMap.get(message.supersedes) ?? []) {
          if (sibling.id !== message.id) {
            related.add(sibling.id);
          }
        }
      }

      for (const sibling of supersededMap.get(message.id) ?? []) {
        related.add(sibling.id);
      }

      return {
        ...base,
        is_conflicted: related.size > 0,
        conflict_ids: [...related],
      };
    })
    .sort((a, b) => {
      if (b.score === a.score) {
        return b.merge_confidence - a.merge_confidence;
      }
      return b.score - a.score;
    });
}

export class NexusRepository {
  private dbPromise: Promise<IDBDatabase | null>;
  private dbInstance: IDBDatabase | null = null;
  private readonly memory: InMemoryState;
  private usingMemory = false;

  constructor(dbName?: string) {
    this.memory = createInMemoryState();
    this.dbPromise = openBridgeDb(dbName ?? "bridge_db")
      .then((db) => {
        this.dbInstance = db;
        return db;
      })
      .catch(() => {
        this.usingMemory = true;
        return null;
      });
  }

  async isUsingMemoryStorage(): Promise<boolean> {
    await this.dbPromise;
    return this.usingMemory;
  }

  private async getDb(): Promise<IDBDatabase | null> {
    return this.dbPromise;
  }

  async getAll(): Promise<NexusMessageWithComputed[]> {
    const db = await this.getDb();
    if (!db) {
      return withConflictMetadata(
        [...this.memory.messages.values()].filter(
          (message) => message.ttl >= nowUnixSeconds(),
        ),
      );
    }

    const tx = db.transaction(STORE_MESSAGES, "readonly");
    const store = tx.objectStore(STORE_MESSAGES);
    const rows = (await requestResult(store.getAll())) as NexusMessage[];
    await txDone(tx);

    return withConflictMetadata(
      rows.filter((message) => message.ttl >= nowUnixSeconds()),
    );
  }

  async getById(id: string): Promise<NexusMessageWithComputed | undefined> {
    const db = await this.getDb();
    if (!db) {
      const row = this.memory.messages.get(id);
      if (!row || row.ttl < nowUnixSeconds()) return undefined;
      return (await this.getAll()).find((message) => message.id === id);
    }

    const tx = db.transaction(STORE_MESSAGES, "readonly");
    const store = tx.objectStore(STORE_MESSAGES);
    const row = (await requestResult(store.get(id))) as
      | NexusMessage
      | undefined;
    await txDone(tx);

    if (!row || row.ttl < nowUnixSeconds()) return undefined;
    return (await this.getAll()).find((message) => message.id === id);
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
    const db = await this.getDb();
    if (!db) {
      return [...this.memory.messages.values()].filter(
        (message) => message.ttl >= nowUnixSeconds(),
      );
    }

    const tx = db.transaction(STORE_MESSAGES, "readonly");
    const rows = (await requestResult(
      tx.objectStore(STORE_MESSAGES).getAll(),
    )) as NexusMessage[];
    await txDone(tx);
    return rows.filter((message) => message.ttl >= nowUnixSeconds());
  }

  async put(message: NexusMessage): Promise<void> {
    const db = await this.getDb();
    if (!db) {
      this.memory.messages.set(message.id, message);
      await this.sweepExpired();
      return;
    }

    const tx = db.transaction(STORE_MESSAGES, "readwrite");
    tx.objectStore(STORE_MESSAGES).put(message);
    await txDone(tx);
    await this.sweepExpired();
    await this.runEviction();
  }

  async putMany(messages: NexusMessage[]): Promise<void> {
    const db = await this.getDb();
    if (!db) {
      for (const message of messages) {
        this.memory.messages.set(message.id, message);
      }
      await this.sweepExpired();
      return;
    }

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
    const db = await this.getDb();
    if (!db) {
      let deleted = 0;
      for (const [id, message] of this.memory.messages.entries()) {
        if (message.ttl < now) {
          this.memory.messages.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    }

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
    if (this.usingMemory) return 0;

    const estimate = await navigator.storage?.estimate?.();
    if (!estimate?.usage) return 0;
    if (estimate.usage <= EVICTION_TRIGGER_BYTES) return 0;

    const db = await this.getDb();
    if (!db) return 0;
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

    const db = await this.getDb();
    if (!db) {
      for (const id of ids) {
        this.memory.messages.delete(id);
      }
      return;
    }

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
    const nextEntry = {
      session_id: entry.sessionId,
      approximate_time: floorToHour(nowUnixSeconds()),
      message_ids_exchanged: entry.messageIdsExchanged,
    } satisfies EncounterLogEntry;

    const db = await this.getDb();
    if (!db) {
      this.memory.encounterLog.set(entry.sessionId, nextEntry);
      return;
    }

    const tx = db.transaction(STORE_ENCOUNTER_LOG, "readwrite");
    tx.objectStore(STORE_ENCOUNTER_LOG).put(nextEntry);
    await txDone(tx);
  }

  async clearAllStores(): Promise<void> {
    const db = await this.getDb();
    if (!db) {
      this.memory.messages.clear();
      this.memory.systemState.clear();
      this.memory.encounterLog.clear();
      return;
    }

    await clearStores(db, ALL_STORES);
  }

  async shutdown(): Promise<void> {
    const db = await this.getDb();
    if (db) {
      db.close();
      this.dbInstance = null;
    }
    this.memory.messages.clear();
    this.memory.systemState.clear();
    this.memory.encounterLog.clear();
  }

  async getSystemState<T = unknown>(key: string): Promise<T | undefined> {
    const db = await this.getDb();
    if (!db) {
      return this.memory.systemState.get(key) as T | undefined;
    }

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
    const db = await this.getDb();
    if (!db) {
      this.memory.systemState.set(key, value);
      return;
    }

    const tx = db.transaction(STORE_SYSTEM_STATE, "readwrite");
    tx.objectStore(STORE_SYSTEM_STATE).put({ key, value });
    await txDone(tx);
  }
}
