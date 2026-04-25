"use client";

import Image from "next/image";
import Link from "next/link";
import QRCode from "qrcode";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  BloomFilter,
  broadcastMessage,
  buildSnapshot,
  createInitiator,
  createJoiner,
  createMessage,
  decodeTransportPayload,
  finalizeInitiator,
  ingestMessage,
  loadPinHash,
  monitorTripleShake,
  NexusRepository,
  requestMotionPermissionIfNeeded,
  runLevel3Wipe,
  runScoringLoop,
  savePinHash,
  SCORING_INTERVAL_MS,
  selectMessagesNotInBloom,
  startCameraScanner,
  submitPinAttempt,
  type NexusMessage,
  type NexusMessageWithComputed,
  type PeerArtifacts,
} from "@/lib/nexus";

type Screen = "home" | "send" | "receive" | "messages";
type ScannerMode = "snapshot" | "offer" | "answer";
type ComposeType = "text" | "alert" | "audio";

type SyncWire =
  | { type: "BLOOM_OFFER"; bloom: string }
  | { type: "MSG_PUSH"; message: NexusMessage }
  | { type: "SYNC_DONE"; sentCount: number };

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function temperatureDot(temperature: NexusMessageWithComputed["temperature"]): string {
  if (temperature === "hot") return "bg-red-500";
  if (temperature === "warm") return "bg-amber-400";
  return "bg-slate-400";
}

function messageLabel(type: ComposeType): string {
  if (type === "alert") return "Alert";
  if (type === "audio") return "Audio";
  return "Text";
}

function summarizeHot(messages: NexusMessageWithComputed[]): string {
  const hot = messages.filter((message) => message.temperature === "hot").length;
  const warm = messages.filter((message) => message.temperature === "warm").length;

  if (hot > 0) return `${hot} hot`;
  if (warm > 0) return `${warm} warm`;
  return "all cold";
}

async function buildQrDataUrl(value: string): Promise<string> {
  return QRCode.toDataURL(value, {
    errorCorrectionLevel: "M",
    margin: 1,
    color: {
      dark: "#102033",
      light: "#f6f2e8",
    },
    width: 1200,
  });
}

export function NexusApp() {
  const repositoryRef = useRef<NexusRepository | null>(null);
  const syncChannelRef = useRef<RTCDataChannel | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const scannerStopRef = useRef<(() => void) | null>(null);
  const shakeStopRef = useRef<(() => void) | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const answerPeerRef = useRef<PeerArtifacts | null>(null);
  const offerPeerRef = useRef<PeerArtifacts | null>(null);

  const [messages, setMessages] = useState<NexusMessageWithComputed[]>([]);
  const [screen, setScreen] = useState<Screen>("home");
  const [status, setStatus] = useState("Ready");
  const [syncStatus, setSyncStatus] = useState("No active device link");
  const [scannerStatus, setScannerStatus] = useState("Scanner idle");

  const [composeOpen, setComposeOpen] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [draftPriority, setDraftPriority] = useState<1 | 2 | 3 | 4 | 5>(4);
  const [draftType, setDraftType] = useState<ComposeType>("text");

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pinSetup, setPinSetup] = useState("123456");
  const [pinAttempt, setPinAttempt] = useState("123456");
  const [pinHash, setPinHash] = useState("");
  const [pinLocked, setPinLocked] = useState(false);
  const [sentinelStatus, setSentinelStatus] = useState("Sentinel idle");
  const [shakeArmed, setShakeArmed] = useState(false);

  const [offerToken, setOfferToken] = useState("");
  const [activeQrLabel, setActiveQrLabel] = useState("");
  const [activeQrUrl, setActiveQrUrl] = useState("");

  const [scannerMode, setScannerMode] = useState<ScannerMode | null>(null);
  const [selectedMessage, setSelectedMessage] =
    useState<NexusMessageWithComputed | null>(null);

  const totalHot = useMemo(
    () => messages.filter((message) => message.temperature === "hot").length,
    [messages],
  );
  const temperatureSummary = useMemo(() => summarizeHot(messages), [messages]);
  const topMessage = messages[0];

  const handleScannedPayload = useEffectEvent(
    async (decoded: string, mode: ScannerMode): Promise<void> => {
      if (!repositoryRef.current) return;

      try {
        const result = decodeTransportPayload(decoded);

        if (result.kind === "snapshot") {
          let stored = 0;
          for (const message of result.messages) {
            const ingestResult = await ingestMessage(message, repositoryRef.current);
            if (ingestResult.status === "stored") {
              stored += 1;
            }
          }
          await refreshMessages();
          setStatus(`Imported ${stored} new message${stored === 1 ? "" : "s"} from QR`);
          return;
        }

        if (result.kind === "webrtc") {
          if (mode === "answer" && offerPeerRef.current) {
            await finalizeInitiator(offerPeerRef.current.connection, decoded);
            setSyncStatus("Answer received. Waiting for link to open");
            setStatus("Connection finalized");
            return;
          }

          const joiner = await createJoiner(decoded);
          await attachPeer(joiner.peer, "joiner");
          setActiveQrLabel("Connection answer");
          setActiveQrUrl(await buildQrDataUrl(joiner.answerToken));
          setSyncStatus("Answer ready. Show this QR back to the sender");
          return;
        }

        setStatus(`Legacy payload received: ${result.url}`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Could not decode QR");
      }
    },
  );

  useEffect(() => {
    const repository = new NexusRepository();
    repositoryRef.current = repository;

    const refresh = async (): Promise<void> => {
      setMessages(await repository.getAll());
      const storedPinHash = await loadPinHash(repository);
      if (storedPinHash) {
        setPinHash(storedPinHash);
        setPinLocked(true);
      }
    };

    void refresh();
    const stopScoring = runScoringLoop(repository, SCORING_INTERVAL_MS);
    const stopSweep = repository.startExpirySweep();

    return () => {
      stopScoring();
      stopSweep();
      scannerStopRef.current?.();
      shakeStopRef.current?.();
      if (syncTimerRef.current) {
        window.clearInterval(syncTimerRef.current);
      }
      syncChannelRef.current?.close();
      offerPeerRef.current?.channel.close();
      offerPeerRef.current?.connection.close();
      answerPeerRef.current?.channel.close();
      answerPeerRef.current?.connection.close();
    };
  }, []);

  useEffect(() => {
    if (!scannerMode || !videoRef.current) return undefined;

    let active = true;
    setScannerStatus("Opening camera");

      const mode = scannerMode;
      void startCameraScanner(videoRef.current, (decoded) => {
        if (!active) return;
        setScannerMode(null);
        setScannerStatus("QR captured");
        void handleScannedPayload(decoded, mode);
      })
      .then((stop) => {
        if (!active) {
          stop();
          return;
        }
        scannerStopRef.current = stop;
        setScannerStatus("Camera ready");
      })
      .catch((error: unknown) => {
        setScannerMode(null);
        setScannerStatus(
          error instanceof Error ? error.message : "Failed to open camera",
        );
      });

    return () => {
      active = false;
      scannerStopRef.current?.();
      scannerStopRef.current = null;
    };
  }, [scannerMode]);

  async function refreshMessages(): Promise<void> {
    if (!repositoryRef.current) return;
    setMessages(await repositoryRef.current.getAll());
  }

  function closeQr(): void {
    setActiveQrLabel("");
    setActiveQrUrl("");
  }

  async function handleSaveDraft(): Promise<void> {
    if (!repositoryRef.current || !draftText.trim()) {
      setStatus("Write a message before saving");
      return;
    }

    const message = await createMessage({
      type: draftType,
      priority: draftPriority,
      payload: draftText.trim(),
    });

    await repositoryRef.current.put(message);
    await refreshMessages();
    setComposeOpen(false);
    setDraftText("");
    setStatus("Message stored on this device");
    setScreen("send");
  }

  async function handleSnapshotShare(): Promise<void> {
    if (messages.length === 0) {
      setStatus("Create a message first");
      return;
    }

    try {
      const result = buildSnapshot(messages);
      setActiveQrLabel(`Snapshot QR - ${result.count} message${result.count === 1 ? "" : "s"}`);
      setActiveQrUrl(await buildQrDataUrl(result.qr));
      setStatus(`Sharing top ${result.count} message${result.count === 1 ? "" : "s"} by QR`);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Failed to build snapshot",
      );
    }
  }

  async function handleBroadcastTopMessage(): Promise<void> {
    if (!topMessage) {
      setStatus("No stored messages to broadcast");
      return;
    }

    try {
      await broadcastMessage(topMessage);
      setStatus("Broadcast finished");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Broadcast failed");
    }
  }

  async function attachPeer(
    peer: PeerArtifacts,
    role: "initiator" | "joiner",
  ): Promise<void> {
    syncChannelRef.current = peer.channel;

    peer.channel.onopen = () => {
      setSyncStatus("Peer link active. Background sync running");
      void sendBloomOffer(peer.channel);

      if (syncTimerRef.current) {
        window.clearInterval(syncTimerRef.current);
      }

      syncTimerRef.current = window.setInterval(() => {
        void sendBloomOffer(peer.channel);
      }, SCORING_INTERVAL_MS);
    };

    peer.channel.onclose = () => {
      if (syncTimerRef.current) {
        window.clearInterval(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      setSyncStatus("Peer link closed");
    };

    peer.channel.onmessage = (event) => {
      void handleSyncWire(event.data);
    };

    if (role === "initiator") {
      offerPeerRef.current?.channel.close();
      offerPeerRef.current?.connection.close();
      offerPeerRef.current = peer;
    } else {
      answerPeerRef.current?.channel.close();
      answerPeerRef.current?.connection.close();
      answerPeerRef.current = peer;
    }
  }

  async function sendBloomOffer(channel: RTCDataChannel): Promise<void> {
    if (!repositoryRef.current || channel.readyState !== "open") return;

    const local = await repositoryRef.current.getAllRaw();
    const bloom = new BloomFilter();
    for (const message of local) {
      bloom.add(message.id);
    }

    channel.send(
      JSON.stringify({
        type: "BLOOM_OFFER",
        bloom: bloom.toBase64(),
      } satisfies SyncWire),
    );
  }

  async function handleSyncWire(raw: string): Promise<void> {
    if (!repositoryRef.current) return;

    let wire: SyncWire;
    try {
      wire = JSON.parse(raw) as SyncWire;
    } catch {
      return;
    }

    if (wire.type === "BLOOM_OFFER") {
      const local = await repositoryRef.current.getAllRaw();
      const queue = selectMessagesNotInBloom(
        local,
        BloomFilter.fromBase64(wire.bloom),
      );

      for (const message of queue) {
        syncChannelRef.current?.send(
          JSON.stringify({ type: "MSG_PUSH", message } satisfies SyncWire),
        );
      }

      syncChannelRef.current?.send(
        JSON.stringify({
          type: "SYNC_DONE",
          sentCount: queue.length,
        } satisfies SyncWire),
      );
      return;
    }

    if (wire.type === "MSG_PUSH") {
      const result = await ingestMessage(wire.message, repositoryRef.current);
      if (result.status === "stored") {
        await refreshMessages();
        setSyncStatus("Peer link active. New messages received");
      }
      return;
    }

    if (wire.type === "SYNC_DONE") {
      setSyncStatus(
        wire.sentCount > 0
          ? `Peer link active. Synced ${wire.sentCount} prioritized message${wire.sentCount === 1 ? "" : "s"}`
          : "Peer link active. Inventories already aligned",
      );
    }
  }

  async function handleCreateOffer(): Promise<void> {
    const result = await createInitiator();
    await attachPeer(result.peer, "initiator");
    setOfferToken(result.offerToken);
    setActiveQrLabel("Connection offer");
    setActiveQrUrl(await buildQrDataUrl(result.offerToken));
    setSyncStatus("Offer ready. Scan it from the receiving device");
  }

  async function handleSavePin(): Promise<void> {
    if (!repositoryRef.current) return;

    try {
      const hash = await savePinHash(repositoryRef.current, pinSetup);
      setPinHash(hash);
      setSentinelStatus("PIN saved");
    } catch (error) {
      setSentinelStatus(error instanceof Error ? error.message : "Failed to save PIN");
    }
  }

  async function handleSubmitPin(): Promise<void> {
    if (!repositoryRef.current || !pinHash) return;

    const result = await submitPinAttempt(repositoryRef.current, pinAttempt, pinHash);

    if (result.ok) {
      setPinLocked(false);
      setSentinelStatus("Unlocked");
      return;
    }

    if (result.wiped) {
      await refreshMessages();
      setPinLocked(false);
      setSentinelStatus(`Level 2 wipe deleted ${result.deleted} message(s)`);
      return;
    }

    setSentinelStatus(`Wrong PIN. ${result.attemptsLeft} attempt(s) left`);
  }

  async function handleEmergencyWipe(): Promise<void> {
    if (!repositoryRef.current) return;
    const elapsed = await runLevel3Wipe(repositoryRef.current);
    setSentinelStatus(`Device wiped in ${elapsed.toFixed(1)} ms`);
    setStatus("Local device cleared");
    window.setTimeout(() => window.location.reload(), 120);
  }

  async function handleToggleShake(): Promise<void> {
    if (shakeStopRef.current) {
      shakeStopRef.current();
      shakeStopRef.current = null;
      setShakeArmed(false);
      setSentinelStatus("Triple-shake wipe disarmed");
      return;
    }

    const granted = await requestMotionPermissionIfNeeded();
    if (!granted) {
      setSentinelStatus("Motion permission denied");
      return;
    }

    shakeStopRef.current = monitorTripleShake(() => {
      void handleEmergencyWipe();
    });
    setShakeArmed(true);
    setSentinelStatus("Triple-shake wipe armed");
  }

  function openScanner(mode: ScannerMode): void {
    setScannerMode(mode);
    setScreen("receive");
  }

  if (pinLocked) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-8">
        <section className="w-full max-w-sm rounded-[2rem] border border-sand-200 bg-[#f8f4eb] p-6 shadow-[0_20px_80px_rgba(16,32,51,0.12)]">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#945f3d]">
            Sentinel Lock
          </p>
          <h1 className="mt-3 text-3xl font-semibold text-[#102033]">Enter PIN</h1>
          <p className="mt-2 text-sm text-[#5a6472]">
            Three wrong attempts trigger the selective wipe.
          </p>
          <input
            value={pinAttempt}
            onChange={(event) => setPinAttempt(event.target.value)}
            className="mt-6 w-full rounded-2xl border border-[#d8d0bf] bg-white px-4 py-3 text-lg tracking-[0.3em] text-[#102033] outline-none"
            inputMode="numeric"
            placeholder="123456"
          />
          <button
            type="button"
            onClick={() => void handleSubmitPin()}
            className="mt-4 w-full rounded-2xl bg-[#102033] px-4 py-3 text-sm font-semibold text-white"
          >
            Unlock Device
          </button>
          <button
            type="button"
            onClick={() => void handleEmergencyWipe()}
            className="mt-3 w-full rounded-2xl bg-[#9f2f24] px-4 py-3 text-sm font-semibold text-white"
          >
            Emergency Wipe
          </button>
          <p className="mt-4 text-sm text-[#5a6472]">{sentinelStatus}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col px-4 py-5 sm:px-6">
      <section className="relative overflow-hidden rounded-[2rem] border border-white/50 bg-[#f6f2e8]/90 p-5 shadow-[0_24px_80px_rgba(16,32,51,0.14)] backdrop-blur">
        <div className="absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_top,rgba(227,86,49,0.18),transparent_65%)]" />
        <div className="relative">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#945f3d]">
                Nexus Relay
              </p>
              <h1 className="mt-2 text-3xl font-semibold text-[#102033]">
                {screen === "home" && "Home"}
                {screen === "send" && "Send"}
                {screen === "receive" && "Receive"}
                {screen === "messages" && "Messages"}
              </h1>
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="rounded-2xl border border-[#d7cfbe] bg-white/70 px-3 py-2 text-lg text-[#102033]"
              aria-label="Open settings"
            >
              ⚙
            </button>
          </div>

          {screen === "home" && (
            <section className="mt-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <article className="rounded-[1.6rem] bg-[#102033] p-4 text-white">
                  <p className="text-xs uppercase tracking-[0.24em] text-white/65">
                    Stored
                  </p>
                  <p className="mt-3 text-4xl font-semibold">{messages.length}</p>
                </article>
                <article className="rounded-[1.6rem] bg-[#e35631] p-4 text-white">
                  <p className="text-xs uppercase tracking-[0.24em] text-white/70">
                    Temperature
                  </p>
                  <p className="mt-3 text-2xl font-semibold">
                    {totalHot > 0 ? `${totalHot} hot` : temperatureSummary}
                  </p>
                </article>
              </div>

              <button
                type="button"
                onClick={() => setScreen("send")}
                className="flex w-full items-center justify-between rounded-[1.8rem] bg-[#102033] px-5 py-5 text-left text-white"
              >
                <span>
                  <span className="block text-xs uppercase tracking-[0.24em] text-white/60">
                    Create
                  </span>
                  <span className="mt-1 block text-2xl font-semibold">Send</span>
                </span>
                <span className="rounded-full bg-white/12 px-4 py-2 text-sm">
                  Open
                </span>
              </button>

              <button
                type="button"
                onClick={() => setScreen("receive")}
                className="flex w-full items-center justify-between rounded-[1.8rem] border border-[#d7cfbe] bg-white/80 px-5 py-5 text-left text-[#102033]"
              >
                <span>
                  <span className="block text-xs uppercase tracking-[0.24em] text-[#945f3d]">
                    Import
                  </span>
                  <span className="mt-1 block text-2xl font-semibold">Receive</span>
                </span>
                <span className="rounded-full bg-[#f2ebe0] px-4 py-2 text-sm">
                  Open
                </span>
              </button>
            </section>
          )}

          {screen === "send" && (
            <section className="mt-6 space-y-4">
              <button
                type="button"
                onClick={() => setComposeOpen(true)}
                className="w-full rounded-[1.8rem] border border-[#d7cfbe] bg-white/85 p-5 text-left text-[#102033]"
              >
                <span className="block text-xs uppercase tracking-[0.24em] text-[#945f3d]">
                  Compose
                </span>
                <span className="mt-2 block text-2xl font-semibold">New Message</span>
                <span className="mt-3 block text-sm text-[#5a6472]">
                  Create and store a message on this device before sharing.
                </span>
              </button>

              <button
                type="button"
                onClick={() => void handleSnapshotShare()}
                className="w-full rounded-[1.8rem] bg-[#102033] p-5 text-left text-white"
              >
                <span className="block text-xs uppercase tracking-[0.24em] text-white/60">
                  Snapshot
                </span>
                <span className="mt-2 block text-2xl font-semibold">QR Code</span>
                <span className="mt-3 block text-sm text-white/72">
                  Show the top-priority bundle fullscreen.
                </span>
              </button>

              <button
                type="button"
                onClick={() => void handleCreateOffer()}
                className="w-full rounded-[1.8rem] bg-[#d8ead9] p-5 text-left text-[#183f27]"
              >
                <span className="block text-xs uppercase tracking-[0.24em] text-[#55745d]">
                  Peer Link
                </span>
                <span className="mt-2 block text-2xl font-semibold">
                  Connect to Device
                </span>
                <span className="mt-3 block text-sm text-[#44604c]">
                  Create an offer QR, then scan the answer.
                </span>
              </button>

              <button
                type="button"
                onClick={() => void handleBroadcastTopMessage()}
                className="w-full rounded-[1.8rem] bg-[#f3dcbf] p-5 text-left text-[#6f3f17]"
              >
                <span className="block text-xs uppercase tracking-[0.24em] text-[#9a6130]">
                  Loudspeaker
                </span>
                <span className="mt-2 block text-2xl font-semibold">
                  Broadcast Audio
                </span>
                <span className="mt-3 block text-sm text-[#885226]">
                  Speak the highest-priority stored message.
                </span>
              </button>

              {offerToken && (
                <button
                  type="button"
                  onClick={() => openScanner("answer")}
                  className="w-full rounded-[1.3rem] border border-dashed border-[#d7cfbe] bg-white px-4 py-3 text-sm font-medium text-[#102033]"
                >
                  Scan answer QR to finish the connection
                </button>
              )}
            </section>
          )}

          {screen === "receive" && (
            <section className="mt-6 space-y-4">
              <button
                type="button"
                onClick={() => openScanner("snapshot")}
                className="w-full rounded-[1.8rem] bg-[#102033] p-5 text-left text-white"
              >
                <span className="block text-xs uppercase tracking-[0.24em] text-white/60">
                  Camera
                </span>
                <span className="mt-2 block text-2xl font-semibold">Scan QR</span>
                <span className="mt-3 block text-sm text-white/72">
                  Import a snapshot bundle from another device.
                </span>
              </button>

              <button
                type="button"
                onClick={() => openScanner("offer")}
                className="w-full rounded-[1.8rem] bg-[#d8ead9] p-5 text-left text-[#183f27]"
              >
                <span className="block text-xs uppercase tracking-[0.24em] text-[#55745d]">
                  Peer Link
                </span>
                <span className="mt-2 block text-2xl font-semibold">
                  Accept Connection
                </span>
                <span className="mt-3 block text-sm text-[#44604c]">
                  Scan the offer, then return the answer QR.
                </span>
              </button>

              <div className="rounded-[1.5rem] border border-[#d7cfbe] bg-white/80 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.24em] text-[#945f3d]">
                  Live Sync
                </p>
                <p className="mt-2 text-lg font-semibold text-[#102033]">
                  {syncStatus}
                </p>
                <p className="mt-2 text-sm text-[#5a6472]">{scannerStatus}</p>
              </div>
            </section>
          )}

          {screen === "messages" && (
            <section className="mt-6 space-y-3">
              {messages.map((message) => (
                <button
                  key={message.id}
                  type="button"
                  onClick={() => setSelectedMessage(message)}
                  className="w-full rounded-[1.5rem] border border-[#d7cfbe] bg-white/80 px-4 py-4 text-left"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span
                        className={classNames(
                          "h-3 w-3 rounded-full",
                          temperatureDot(message.temperature),
                        )}
                      />
                      <span className="text-xs font-semibold uppercase tracking-[0.22em] text-[#945f3d]">
                        {message.type === "audio" ? "Mic" : messageLabel(message.type)}
                      </span>
                    </div>
                    {message.type === "audio" && (
                      <span className="text-lg text-[#102033]">🎙</span>
                    )}
                  </div>
                  <p className="mt-3 text-lg leading-6 font-medium text-[#102033]">
                    {message.payload}
                  </p>
                </button>
              ))}

              {messages.length === 0 && (
                <div className="rounded-[1.5rem] border border-dashed border-[#d7cfbe] px-4 py-8 text-center text-sm text-[#5a6472]">
                  No messages stored yet.
                </div>
              )}
            </section>
          )}

          <p className="mt-5 rounded-[1.2rem] bg-white/70 px-4 py-3 text-sm text-[#425061]">
            {status}
          </p>

          <nav className="mt-5 grid grid-cols-4 gap-2 rounded-[1.6rem] bg-[#eadfce] p-2">
            {(["home", "send", "receive", "messages"] as Screen[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setScreen(item)}
                className={classNames(
                  "rounded-[1.1rem] px-3 py-3 text-sm font-medium capitalize",
                  screen === item
                    ? "bg-[#102033] text-white"
                    : "text-[#5a6472]",
                )}
              >
                {item}
              </button>
            ))}
          </nav>

          <div className="mt-4 flex items-center justify-between text-xs text-[#6f7884]">
            <span>{messages.length} stored</span>
            <Link href="/lab" className="font-semibold text-[#945f3d]">
              Open debug harness
            </Link>
          </div>
        </div>
      </section>

      {composeOpen && (
        <div className="fixed inset-0 z-40 flex items-end bg-[#102033]/40 p-4">
          <section className="w-full rounded-[2rem] bg-[#f8f4eb] p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-semibold text-[#102033]">New Message</h2>
              <button
                type="button"
                onClick={() => setComposeOpen(false)}
                className="rounded-full bg-white px-3 py-2 text-sm text-[#102033]"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2">
              {(["text", "alert", "audio"] as ComposeType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setDraftType(type)}
                  className={classNames(
                    "rounded-[1.1rem] px-3 py-3 text-sm font-medium",
                    draftType === type
                      ? "bg-[#102033] text-white"
                      : "bg-white text-[#102033]",
                  )}
                >
                  {messageLabel(type)}
                </button>
              ))}
            </div>

            <textarea
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              className="mt-4 h-36 w-full rounded-[1.5rem] border border-[#d8d0bf] bg-white px-4 py-4 text-base text-[#102033] outline-none"
              placeholder="Road blocked at main gate."
            />

            <label className="mt-4 block text-sm text-[#5a6472]">
              Priority
              <select
                value={draftPriority}
                onChange={(event) =>
                  setDraftPriority(Number(event.target.value) as 1 | 2 | 3 | 4 | 5)
                }
                className="mt-2 w-full rounded-[1.2rem] border border-[#d8d0bf] bg-white px-4 py-3 text-[#102033] outline-none"
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
                <option value={5}>5</option>
              </select>
            </label>

            <button
              type="button"
              onClick={() => void handleSaveDraft()}
              className="mt-4 w-full rounded-[1.4rem] bg-[#102033] px-4 py-4 text-sm font-semibold text-white"
            >
              Save To Device
            </button>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="fixed inset-0 z-40 flex items-end bg-[#102033]/40 p-4">
          <section className="w-full rounded-[2rem] bg-[#f8f4eb] p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-semibold text-[#102033]">Settings</h2>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="rounded-full bg-white px-3 py-2 text-sm text-[#102033]"
              >
                Close
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <input
                value={pinSetup}
                onChange={(event) => setPinSetup(event.target.value)}
                className="w-full rounded-[1.2rem] border border-[#d8d0bf] bg-white px-4 py-3 text-[#102033] outline-none"
                inputMode="numeric"
                placeholder="Set 6-digit PIN"
              />
              <button
                type="button"
                onClick={() => void handleSavePin()}
                className="w-full rounded-[1.2rem] bg-[#102033] px-4 py-3 text-sm font-semibold text-white"
              >
                Save PIN
              </button>
              <button
                type="button"
                onClick={() => setPinLocked(Boolean(pinHash))}
                className="w-full rounded-[1.2rem] bg-white px-4 py-3 text-sm font-semibold text-[#102033]"
              >
                Lock App Now
              </button>
              <button
                type="button"
                onClick={() => void handleToggleShake()}
                className="w-full rounded-[1.2rem] bg-[#f3dcbf] px-4 py-3 text-sm font-semibold text-[#6f3f17]"
              >
                {shakeArmed ? "Disarm Triple Shake" : "Arm Triple Shake"}
              </button>
              <button
                type="button"
                onClick={() => void handleEmergencyWipe()}
                className="w-full rounded-[1.2rem] bg-[#9f2f24] px-4 py-3 text-sm font-semibold text-white"
              >
                Emergency Wipe
              </button>
            </div>

            <p className="mt-4 text-sm text-[#5a6472]">{sentinelStatus}</p>
          </section>
        </div>
      )}

      {scannerMode && (
        <div className="fixed inset-0 z-50 bg-[#08111c] px-4 py-6 text-white">
          <div className="mx-auto flex h-full max-w-md flex-col">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/60">
                  Camera
                </p>
                <h2 className="mt-2 text-2xl font-semibold">
                  {scannerMode === "answer" && "Scan answer QR"}
                  {scannerMode === "offer" && "Scan offer QR"}
                  {scannerMode === "snapshot" && "Scan snapshot QR"}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setScannerMode(null)}
                className="rounded-full bg-white/10 px-3 py-2 text-sm"
              >
                Close
              </button>
            </div>
            <div className="mt-6 flex-1 overflow-hidden rounded-[2rem] border border-white/10 bg-black">
              <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
            </div>
            <p className="mt-4 text-sm text-white/70">{scannerStatus}</p>
          </div>
        </div>
      )}

      {activeQrUrl && (
        <div className="fixed inset-0 z-50 bg-[#f6f2e8] px-4 py-6">
          <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#945f3d]">
              Nexus Relay
            </p>
            <h2 className="mt-3 text-center text-3xl font-semibold text-[#102033]">
              {activeQrLabel}
            </h2>
            <div className="mt-6 w-full rounded-[2rem] bg-white p-4 shadow-[0_18px_60px_rgba(16,32,51,0.14)]">
              <Image
                src={activeQrUrl}
                alt={activeQrLabel}
                width={1200}
                height={1200}
                unoptimized
                className="h-auto w-full"
              />
            </div>
            <p className="mt-5 text-center text-sm text-[#5a6472]">
              {activeQrLabel === "Connection answer"
                ? "Show this back to the sender, then sync will continue in the background."
                : activeQrLabel === "Connection offer"
                  ? "The receiver scans this, then you scan the answer QR."
                  : "The receiver can scan this directly to import the snapshot."}
            </p>
            <button
              type="button"
              onClick={closeQr}
              className="mt-6 rounded-[1.3rem] bg-[#102033] px-6 py-3 text-sm font-semibold text-white"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {selectedMessage && (
        <div className="fixed inset-0 z-40 flex items-end bg-[#102033]/40 p-4">
          <section className="w-full rounded-[2rem] bg-[#f8f4eb] p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span
                  className={classNames(
                    "h-3 w-3 rounded-full",
                    temperatureDot(selectedMessage.temperature),
                  )}
                />
                <span className="text-xs font-semibold uppercase tracking-[0.22em] text-[#945f3d]">
                  {selectedMessage.type === "audio"
                    ? "Mic"
                    : messageLabel(selectedMessage.type)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedMessage(null)}
                className="rounded-full bg-white px-3 py-2 text-sm text-[#102033]"
              >
                Close
              </button>
            </div>
            <p className="mt-5 text-2xl leading-8 font-semibold text-[#102033]">
              {selectedMessage.payload}
            </p>
            <button
              type="button"
              onClick={() => void broadcastMessage(selectedMessage)}
              className="mt-6 w-full rounded-[1.4rem] bg-[#102033] px-4 py-4 text-sm font-semibold text-white"
            >
              Broadcast
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
