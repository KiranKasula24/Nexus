"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  buildSnapshot,
  createInitiator,
  createMessage,
  ingestMessage,
  NexusRepository,
  type MessageType,
  type NexusMessageWithComputed,
} from "@/lib/nexus";

export default function LabPage() {
  const repositoryRef = useRef<NexusRepository | null>(null);
  const [messages, setMessages] = useState<NexusMessageWithComputed[]>([]);
  const [payload, setPayload] = useState("Road blocked at main gate.");
  const [priority, setPriority] = useState<1 | 2 | 3 | 4 | 5>(4);
  const [type, setType] = useState<MessageType>("text");
  const [snapshot, setSnapshot] = useState("");
  const [offerToken, setOfferToken] = useState("");
  const [status, setStatus] = useState("Harness ready");

  useEffect(() => {
    const repository = new NexusRepository();
    repositoryRef.current = repository;
    void repository.getAll().then(setMessages);
  }, []);

  async function refresh(): Promise<void> {
    const repository = repositoryRef.current;
    if (!repository) return;
    setMessages(await repository.getAll());
  }

  async function handleCreate(): Promise<void> {
    const repository = repositoryRef.current;
    if (!repository) return;
    const message = await createMessage({ type, priority, payload });
    await repository.put(message);
    await refresh();
    setStatus(`Created ${message.id}`);
  }

  async function handleIngressDemo(): Promise<void> {
    const repository = repositoryRef.current;
    if (!repository) return;
    const incoming = await createMessage({
      type: "alert",
      priority: 5,
      payload: `Relay copy: ${payload}`,
    });
    const result = await ingestMessage(incoming, repository);
    await refresh();
    setStatus(result.status);
  }

  async function handleSnapshot(): Promise<void> {
    try {
      const result = buildSnapshot(messages);
      setSnapshot(result.qr);
      setStatus(`Built snapshot for ${result.count} message(s)`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Snapshot failed");
    }
  }

  async function handleOffer(): Promise<void> {
    const result = await createInitiator();
    setOfferToken(result.offerToken);
    result.peer.channel.close();
    result.peer.connection.close();
    setStatus("Created offer token");
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-10 sm:px-8">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
            Nexus Lab
          </p>
          <h1 className="mt-2 text-4xl font-semibold text-slate-900">
            Debug Harness
          </h1>
        </div>
        <Link
          href="/"
          className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Open Production UI
        </Link>
      </div>

      <section className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Message Builder</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <select
              value={type}
              onChange={(event) => setType(event.target.value as MessageType)}
              className="rounded-xl border border-slate-300 px-3 py-3"
            >
              <option value="text">text</option>
              <option value="alert">alert</option>
              <option value="audio">audio</option>
            </select>
            <select
              value={priority}
              onChange={(event) =>
                setPriority(Number(event.target.value) as 1 | 2 | 3 | 4 | 5)
              }
              className="rounded-xl border border-slate-300 px-3 py-3"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5</option>
            </select>
          </div>

          <textarea
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            className="mt-4 h-32 w-full rounded-2xl border border-slate-300 px-4 py-4"
          />

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void handleCreate()}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white"
            >
              Create Message
            </button>
            <button
              type="button"
              onClick={() => void handleIngressDemo()}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white"
            >
              Ingest Relay Copy
            </button>
            <button
              type="button"
              onClick={() => void handleSnapshot()}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white"
            >
              Build Snapshot Payload
            </button>
            <button
              type="button"
              onClick={() => void handleOffer()}
              className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white"
            >
              Create Offer Token
            </button>
          </div>

          <p className="mt-4 rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-700">
            {status}
          </p>
        </article>

        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Raw Artifacts</h2>
          <label className="mt-4 block text-sm text-slate-600">
            Snapshot payload
            <textarea
              readOnly
              value={snapshot}
              className="mt-2 h-28 w-full rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-xs"
            />
          </label>
          <label className="mt-4 block text-sm text-slate-600">
            Offer token
            <textarea
              readOnly
              value={offerToken}
              className="mt-2 h-28 w-full rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-xs"
            />
          </label>
        </article>
      </section>

      <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Stored Messages</h2>
        <div className="mt-4 space-y-3">
          {messages.map((message) => (
            <div key={message.id} className="rounded-2xl border border-slate-200 px-4 py-4">
              <div className="flex items-center justify-between gap-4 text-sm text-slate-500">
                <span>{message.type}</span>
                <span>priority {message.priority}</span>
                <span>{message.temperature}</span>
              </div>
              <p className="mt-2 text-lg text-slate-900">{message.payload}</p>
            </div>
          ))}
          {messages.length === 0 && (
            <p className="rounded-2xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
              No messages stored yet.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
