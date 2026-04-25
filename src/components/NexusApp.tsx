"use client";

import Image from "next/image";
import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildBloomFromMessages,
  createInitiator,
  createJoiner,
  finalizeInitiator,
  loadPinHash,
  monitorTripleShake,
  NexusRepository,
  QUARANTINE_KEY,
  requestMotionPermissionIfNeeded,
  runComposePipeline,
  runLevel3Wipe,
  runPeerReceivePipeline,
  runPeerSendSelectionPipeline,
  runScoringLoop,
  runSnapshotIngressPipeline,
  runSnapshotSharePipeline,
  savePinHash,
  SCORING_INTERVAL_MS,
  startCameraScanner,
  submitPinAttempt,
  type MessageType,
  type NexusMessage,
  type NexusMessageWithComputed,
  type PeerArtifacts,
  type PipelineRun,
} from "@/lib/nexus";

type Section = "relay" | "compose" | "connect";
type ScannerMode = "snapshot" | "offer" | "answer";
type StatusTone = "ready" | "active" | "warning" | "danger";
type SyncWire =
  | { type: "BLOOM_OFFER"; bloom: string; messageCount: number }
  | { type: "MSG_PUSH"; message: NexusMessage }
  | { type: "SYNC_DONE"; sentCount: number };

interface DevLogEntry {
  id: string;
  tone: StatusTone;
  title: string;
  detail: string;
}

interface SyncStats {
  lastNovelCount: number;
  lastSentCount: number;
  lastReceivedCount: number;
}

interface DevState {
  logs: DevLogEntry[];
  runs: PipelineRun[];
  lastSnapshotPayload: string;
  lastOfferToken: string;
  lastAnswerToken: string;
  quarantineCount: number;
  syncStats: SyncStats;
}

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function pressableCardClasses(base: string): string {
  return `${base} transition duration-150 active:scale-[0.98] active:shadow-sm`;
}

function toneClasses(tone: StatusTone): string {
  if (tone === "active") return "bg-emerald-100 text-emerald-900";
  if (tone === "warning") return "bg-amber-100 text-amber-900";
  if (tone === "danger") return "bg-rose-100 text-rose-900";
  return "bg-slate-100 text-slate-800";
}

function temperatureDot(temperature: NexusMessageWithComputed["temperature"]): string {
  if (temperature === "hot") return "bg-rose-500";
  if (temperature === "warm") return "bg-amber-400";
  return "bg-slate-400";
}

function messageLabel(type: MessageType): string {
  if (type === "alert") return "Alert";
  if (type === "audio") return "Audio";
  return "Text";
}

function formatRelativeTone(
  tone: StatusTone,
  label: string,
): { tone: StatusTone; label: string } {
  return { tone, label };
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

function initialDevState(): DevState {
  return {
    logs: [],
    runs: [],
    lastSnapshotPayload: "",
    lastOfferToken: "",
    lastAnswerToken: "",
    quarantineCount: 0,
    syncStats: {
      lastNovelCount: 0,
      lastSentCount: 0,
      lastReceivedCount: 0,
    },
  };
}

export function NexusApp() {
  const repositoryRef = useRef<NexusRepository | null>(null);
  const syncChannelRef = useRef<RTCDataChannel | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const scannerStopRef = useRef<(() => void) | null>(null);
  const shakeStopRef = useRef<(() => void) | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const offerPeerRef = useRef<PeerArtifacts | null>(null);
  const joinerPeerRef = useRef<PeerArtifacts | null>(null);
  const handleSyncWireRef = useRef<
    ((raw: string) => Promise<void>) | null
  >(null);
  const handleScannedPayloadRef = useRef<
    ((decoded: string, mode: ScannerMode) => Promise<void>) | null
  >(null);

  const [messages, setMessages] = useState<NexusMessageWithComputed[]>([]);
  const [section, setSection] = useState<Section>("relay");
  const [selectedMessage, setSelectedMessage] =
    useState<NexusMessageWithComputed | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftPriority, setDraftPriority] = useState<1 | 2 | 3 | 4 | 5>(4);
  const [draftType, setDraftType] = useState<MessageType>("text");
  const [draftSupersedes, setDraftSupersedes] = useState<string | undefined>();

  const [statusTone, setStatusTone] = useState<StatusTone>("ready");
  const [statusText, setStatusText] = useState("Ready");
  const [syncText, setSyncText] = useState("Join the same hotspot, then connect");
  const [scannerStatus, setScannerStatus] = useState("Scanner idle");
  const [storageWarning, setStorageWarning] = useState("");

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [securitySection, setSecuritySection] = useState<
    "security" | "emergency" | "developer"
  >("security");
  const [pinSetup, setPinSetup] = useState("123456");
  const [pinAttempt, setPinAttempt] = useState("123456");
  const [pinHash, setPinHash] = useState("");
  const [pinLocked, setPinLocked] = useState(false);
  const [sentinelStatus, setSentinelStatus] = useState("Sentinel idle");
  const [shakeArmed, setShakeArmed] = useState(false);

  const developerUnlocked = true;
  const [developerMode, setDeveloperMode] = useState(false);
  const [devPanelOpen, setDevPanelOpen] = useState(false);
  const [devState, setDevState] = useState<DevState>(initialDevState);

  const [scannerMode, setScannerMode] = useState<ScannerMode | null>(null);
  const [activeQrUrl, setActiveQrUrl] = useState("");
  const [activeQrTitle, setActiveQrTitle] = useState("");
  const [activeQrDetail, setActiveQrDetail] = useState("");
  const [activeQrStatus, setActiveQrStatus] =
    useState<{ tone: StatusTone; label: string } | null>(null);

  const topHotCount = useMemo(
    () => messages.filter((message) => message.temperature === "hot").length,
    [messages],
  );
  const topWarmCount = useMemo(
    () => messages.filter((message) => message.temperature === "warm").length,
    [messages],
  );
  const topColdCount = useMemo(
    () => messages.filter((message) => message.temperature === "cold").length,
    [messages],
  );

  function pushDevLog(tone: StatusTone, title: string, detail: string): void {
    setDevState((current) => ({
      ...current,
      logs: [
        {
          id: `${Date.now()}-${current.logs.length}`,
          tone,
          title,
          detail,
        },
        ...current.logs,
      ].slice(0, 18),
    }));
  }

  function recordPipelineRun(run: PipelineRun): void {
    setDevState((current) => ({
      ...current,
      runs: [run, ...current.runs].slice(0, 8),
    }));

    for (const event of run.events) {
      pushDevLog(
        event.status === "error"
          ? "danger"
          : event.status === "warning"
            ? "warning"
            : "active",
        `${event.component} ${event.status}`,
        event.detail,
      );
    }
  }

  async function refreshQuarantineCount(): Promise<void> {
    if (!repositoryRef.current) return;
    const quarantine =
      (await repositoryRef.current.getSystemState<Partial<NexusMessage>[]>(
        QUARANTINE_KEY,
      )) ?? [];
    setDevState((current) => ({
      ...current,
      quarantineCount: quarantine.length,
    }));
  }

  async function refreshMessages(): Promise<void> {
    if (!repositoryRef.current) return;
    setMessages(await repositoryRef.current.getAll());
    await refreshQuarantineCount();
  }

  function noteStatus(
    tone: StatusTone,
    label: string,
    detail?: string,
  ): void {
    setStatusTone(tone);
    setStatusText(label);
    if (detail) {
      pushDevLog(tone, label, detail);
    }
  }

  useEffect(() => {
    const repository = new NexusRepository();
    repositoryRef.current = repository;

    const hydrate = async (): Promise<void> => {
      setMessages(await repository.getAll());

      const storedPinHash = await loadPinHash(repository);
      if (storedPinHash) {
        setPinHash(storedPinHash);
        setPinLocked(true);
      }

      if (await repository.isUsingMemoryStorage()) {
        setStorageWarning(
          "IndexedDB is unavailable. Running in temporary in-memory mode.",
        );
        setStatusTone("warning");
        setStatusText("Temporary storage only");
        pushDevLog(
          "warning",
          "Temporary storage only",
          "IndexedDB unavailable, message storage falls back to memory for this session.",
        );
      }

      await refreshQuarantineCount();
    };

    void hydrate();
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
      joinerPeerRef.current?.channel.close();
      joinerPeerRef.current?.connection.close();
    };
  }, []);

  useEffect(() => {
    if (!scannerMode || !videoRef.current) return undefined;

    let active = true;
    const mode = scannerMode;
    setScannerStatus("Opening camera");

    void startCameraScanner(videoRef.current, (decoded) => {
      if (!active) return;
      setScannerMode(null);
      setScannerStatus("QR captured");
      void handleScannedPayloadRef.current?.(decoded, mode);
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

  async function openQr(
    title: string,
    detail: string,
    payload: string,
    status: { tone: StatusTone; label: string } | null,
  ): Promise<void> {
    setActiveQrTitle(title);
    setActiveQrDetail(detail);
    setActiveQrStatus(status);
    setActiveQrUrl(await buildQrDataUrl(payload));
  }

  function closeQr(): void {
    setActiveQrTitle("");
    setActiveQrDetail("");
    setActiveQrStatus(null);
    setActiveQrUrl("");
  }

  function queueDeveloperUnlock(): void {
    setSettingsOpen(true);
    setSecuritySection("developer");
  }

  function beginCompose(message?: NexusMessageWithComputed): void {
    if (message) {
      setDraftText(message.payload);
      setDraftPriority(message.priority);
      setDraftType(message.type);
      setDraftSupersedes(message.id);
      setSelectedMessage(null);
      noteStatus(
        "warning",
        "Composing update",
        `Preparing a new message that supersedes ${message.id}.`,
      );
    } else {
      setDraftText("");
      setDraftPriority(4);
      setDraftType("text");
      setDraftSupersedes(undefined);
    }
    setSection("compose");
  }

  async function handleSaveDraft(): Promise<void> {
    if (!repositoryRef.current || !draftText.trim()) {
      noteStatus("warning", "Message is empty");
      return;
    }

    const result = await runComposePipeline(repositoryRef.current, {
      type: draftType,
      priority: draftPriority,
      payload: draftText.trim(),
      supersedes: draftSupersedes,
    });

    recordPipelineRun(result.run);
    await refreshMessages();

    noteStatus(
      result.message ? "active" : "warning",
      result.message ? "Message stored on this device" : "Duplicate message skipped",
      result.run.summary,
    );

    setDraftText("");
    setDraftSupersedes(undefined);
    setSection("relay");
  }

  async function handleShowSnapshotQr(): Promise<void> {
    if (messages.length === 0) {
      noteStatus("warning", "No stored messages to share");
      return;
    }

    try {
      if (!repositoryRef.current) return;
      const result = await runSnapshotSharePipeline(repositoryRef.current);
      recordPipelineRun(result.run);
      const snapshot = result.snapshot;
      if (!snapshot) {
        noteStatus("danger", "Snapshot build failed", result.run.summary);
        return;
      }
      setDevState((current) => ({
        ...current,
        lastSnapshotPayload: snapshot.qr,
      }));
      await openQr(
        "Share QR",
        "Share your top messages with another phone.",
        snapshot.qr,
        formatRelativeTone(
          "ready",
          `Packed ${snapshot.count} message${snapshot.count === 1 ? "" : "s"}`,
        ),
      );
      noteStatus(
        "active",
        "Snapshot ready",
        result.run.summary,
      );
    } catch (error) {
      noteStatus(
        "danger",
        error instanceof Error ? error.message : "Snapshot build failed",
      );
    }
  }

  async function sendBloomOffer(channel: RTCDataChannel): Promise<void> {
    if (!repositoryRef.current || channel.readyState !== "open") return;

    const local = await repositoryRef.current.getAllRaw();
    const bloom = buildBloomFromMessages(local);

    channel.send(
      JSON.stringify({
        type: "BLOOM_OFFER",
        bloom: bloom.toBase64(),
        messageCount: local.length,
      } satisfies SyncWire),
    );

    setDevState((current) => ({
      ...current,
      syncStats: {
        ...current.syncStats,
        lastNovelCount: 0,
      },
    }));
    pushDevLog(
      "active",
      "Bloom filter exchanged",
      `Advertised ${local.length} known message IDs to the connected peer.`,
    );
  }

  async function attachPeer(
    peer: PeerArtifacts,
    role: "initiator" | "joiner",
  ): Promise<void> {
    syncChannelRef.current = peer.channel;

    peer.connection.onconnectionstatechange = () => {
      const state = peer.connection.connectionState;
      if (state === "connecting") {
        setSyncText("Connecting phones...");
        noteStatus("warning", "Connecting");
      } else if (state === "connected") {
        setSyncText("Phones connected.");
        noteStatus("active", "Connected");
      } else if (state === "disconnected" || state === "failed") {
        setSyncText("Connection failed. Try making a new code.");
        noteStatus(
          "danger",
          "Connection failed",
          `WebRTC state changed to ${state}.`,
        );
      } else if (state === "closed") {
        setSyncText("Connection closed.");
      }
    };

    peer.connection.oniceconnectionstatechange = () => {
      pushDevLog(
        "ready",
        "ICE state",
        `ICE connection state: ${peer.connection.iceConnectionState}.`,
      );
    };

    peer.connection.onicecandidateerror = () => {
      pushDevLog(
        "warning",
        "ICE error",
        "A network candidate failed. If this keeps happening, create a fresh code on both phones.",
      );
    };

    peer.channel.onopen = () => {
      setSyncText("Connected. Sharing can continue in the background.");
      noteStatus(
        "active",
        "Connected",
        "The phones are linked on the same hotspot.",
      );

      if (activeQrTitle.startsWith("Step")) {
        setActiveQrStatus(formatRelativeTone("active", "Peer connected"));
        setActiveQrDetail(
          "The phones are linked. You can close this screen and keep sharing in the background.",
        );
      }

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
      setSyncText("Peer disconnected. Ready for the next encounter.");
      noteStatus(
        "warning",
        "Disconnected",
        "The link closed. Messages stay on this phone.",
      );
      if (activeQrTitle.startsWith("Step")) {
        setActiveQrStatus(formatRelativeTone("warning", "Peer disconnected"));
      }
    };

    peer.channel.onmessage = (event) => {
      void handleSyncWireRef.current?.(event.data);
    };

    if (role === "initiator") {
      offerPeerRef.current?.channel.close();
      offerPeerRef.current?.connection.close();
      offerPeerRef.current = peer;
    } else {
      joinerPeerRef.current?.channel.close();
      joinerPeerRef.current?.connection.close();
      joinerPeerRef.current = peer;
    }
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
      const result = await runPeerSendSelectionPipeline(
        repositoryRef.current,
        wire.bloom,
      );
      const queue = result.messages;
      recordPipelineRun(result.run);

      setDevState((current) => ({
        ...current,
        syncStats: {
          ...current.syncStats,
          lastNovelCount: queue.length,
          lastSentCount: queue.length,
        },
      }));

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
      const result = await runPeerReceivePipeline(
        repositoryRef.current,
        wire.message,
      );
      recordPipelineRun(result.run);

      if (result.result === "stored") {
        await refreshMessages();
        setDevState((current) => ({
          ...current,
          syncStats: {
            ...current.syncStats,
            lastReceivedCount: current.syncStats.lastReceivedCount + 1,
          },
        }));
      } else if (result.result === "quarantined") {
        await refreshQuarantineCount();
      }
      return;
    }

    if (wire.type === "SYNC_DONE") {
      setSyncText(
        wire.sentCount > 0
          ? `Connected. Sent ${wire.sentCount} top message${wire.sentCount === 1 ? "" : "s"}.`
          : "Connected. The other phone already has the latest messages.",
      );
      if (activeQrTitle.startsWith("Step")) {
        setActiveQrStatus(
          formatRelativeTone(
            "active",
            wire.sentCount > 0 ? "Sync complete" : "Already aligned",
          ),
        );
      }
    }
  }

  async function handleScannedPayload(
    decoded: string,
    mode: ScannerMode,
  ): Promise<void> {
    if (!repositoryRef.current) return;

    try {
      if (decoded.startsWith("S")) {
        const result = await runSnapshotIngressPipeline(
          repositoryRef.current,
          decoded,
        );
        recordPipelineRun(result.run);
        await refreshMessages();
        noteStatus(
          result.stored > 0 ? "active" : "warning",
          `Imported ${result.stored} message${result.stored === 1 ? "" : "s"}`,
          result.run.summary,
        );
        setSection("relay");
        return;
      }

      if (decoded.startsWith("W")) {
        if (mode === "answer" && offerPeerRef.current) {
          await finalizeInitiator(offerPeerRef.current.connection, decoded);
          setSyncText("Answer scanned. Waiting to connect.");
          if (activeQrTitle === "Step 1 QR") {
            setActiveQrStatus(
              formatRelativeTone("warning", "Answer received"),
            );
            setActiveQrDetail(
              "The answer was scanned. Keep this screen open while the phones connect.",
            );
          }
          pushDevLog(
            "active",
            "Answer scanned",
            "Phone 1 accepted the answer code.",
          );
          return;
        }

        const joiner = await createJoiner(decoded);
        await attachPeer(joiner.peer, "joiner");
        setDevState((current) => ({
          ...current,
          lastAnswerToken: joiner.answerToken,
        }));
        await openQr(
          "Step 2 QR",
          "Show this code to Phone 1 to finish connecting.",
          joiner.answerToken,
          formatRelativeTone("warning", "Waiting for Phone 1"),
        );
        setSyncText("Step 2 ready. Show this code to Phone 1.");
        pushDevLog(
          "active",
          "Step 2 ready",
          "Phone 2 scanned the first code and made the second code.",
        );
        return;
      }

      noteStatus("warning", "Unsupported QR payload kind");
    } catch (error) {
      noteStatus(
        "danger",
        error instanceof Error ? error.message : "Could not decode QR",
      );
    }
  }

  async function handleCreateOffer(): Promise<void> {
    const result = await createInitiator();
    await attachPeer(result.peer, "initiator");

    setDevState((current) => ({
      ...current,
      lastOfferToken: result.offerToken,
    }));

    await openQr(
      "Step 1 QR",
      "Ask Phone 2 to scan this while both phones are on the same hotspot.",
      result.offerToken,
      formatRelativeTone("warning", "Waiting for Phone 2"),
    );

    setSyncText("Step 1 ready. Phone 2 should scan this first.");
    pushDevLog(
      "active",
      "Step 1 ready",
      "Phone 1 made the first connection code.",
    );
  }

  async function handleSavePin(): Promise<void> {
    if (!repositoryRef.current) return;

    try {
      const hash = await savePinHash(repositoryRef.current, pinSetup);
      setPinHash(hash);
      setSentinelStatus("PIN saved");
      noteStatus("ready", "PIN updated");
    } catch (error) {
      setSentinelStatus(
        error instanceof Error ? error.message : "Failed to save PIN",
      );
    }
  }

  async function handleSubmitPin(): Promise<void> {
    if (!repositoryRef.current || !pinHash) return;

    const result = await submitPinAttempt(
      repositoryRef.current,
      pinAttempt,
      pinHash,
    );

    if (result.ok) {
      setPinLocked(false);
      setSentinelStatus("Unlocked");
      noteStatus("ready", "Device unlocked");
      return;
    }

    if (result.wiped) {
      setPinLocked(false);
      setSentinelStatus(`Selective wipe deleted ${result.deleted} message(s)`);
      await refreshMessages();
      noteStatus(
        "danger",
        "Selective wipe completed",
        `Deleted ${result.deleted} high-risk message records after PIN failures.`,
      );
      return;
    }

    setSentinelStatus(`Wrong PIN. ${result.attemptsLeft} attempt(s) left.`);
  }

  async function handleEmergencyWipe(): Promise<void> {
    if (!repositoryRef.current) return;
    const elapsed = await runLevel3Wipe(repositoryRef.current);
    setSentinelStatus(`Device wiped in ${elapsed.toFixed(1)} ms`);
    noteStatus("danger", "Device wiped", "Emergency wipe completed.");
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

  async function handleManualQuarantineDemo(): Promise<void> {
    if (!repositoryRef.current) return;

    const invalid = {
      id: "legacy-v2",
      type: "text",
      priority: 3,
      ttl: Date.now(),
      created_at: Date.now(),
      hop_count: 0,
      weight: 1,
      payload: "Unsupported schema payload",
      confidence: "high",
      schema_version: 2,
    } as unknown as Partial<NexusMessage>;

    const result = await runPeerReceivePipeline(repositoryRef.current, invalid);
    recordPipelineRun(result.run);
    await refreshQuarantineCount();
  }

  function openScanner(mode: ScannerMode): void {
    setScannerMode(mode);
  }

  useEffect(() => {
    handleSyncWireRef.current = handleSyncWire;
    handleScannedPayloadRef.current = handleScannedPayload;
  });

  if (pinLocked) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-8">
        <section className="w-full max-w-sm rounded-[2rem] border border-[#ddd1be] bg-[#f8f4eb] p-6 shadow-[0_20px_80px_rgba(16,32,51,0.12)]">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#945f3d]">
            Security Lock
          </p>
          <h1 className="mt-3 text-3xl font-semibold text-[#102033]">
            Enter PIN
          </h1>
          <p className="mt-2 text-sm text-[#5a6472]">
            Three failed attempts trigger a selective wipe.
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
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-4 sm:px-6 sm:py-6">
      <section className="relative mx-auto w-full max-w-3xl overflow-hidden rounded-[2rem] border border-white/50 bg-[#f6f2e8]/90 p-4 shadow-[0_24px_80px_rgba(16,32,51,0.14)] backdrop-blur sm:p-5">
        <div className="absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_top,rgba(227,86,49,0.18),transparent_65%)]" />

        <div className="relative">
          <div className="flex items-start justify-between gap-3">
            <button
              type="button"
              onClick={queueDeveloperUnlock}
              className="text-left"
            >
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#945f3d]">
                Nexus Relay
              </p>
              <h1 className="mt-2 text-3xl font-semibold text-[#102033]">
                {section === "relay" && "Relay"}
                {section === "compose" && "Compose"}
                {section === "connect" && "Nearby"}
              </h1>
            </button>

            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className={pressableCardClasses(
                "rounded-2xl border border-[#d7cfbe] bg-white/70 px-3 py-2 text-sm font-semibold text-[#102033]",
              )}
            >
              Settings
            </button>
          </div>

          <div className="mt-5 flex items-center gap-2 rounded-[1.3rem] border border-white/60 bg-white/75 px-4 py-3">
            <span
              className={classNames(
                "h-2.5 w-2.5 rounded-full",
                statusTone === "active" && "bg-emerald-500",
                statusTone === "warning" && "bg-amber-500",
                statusTone === "danger" && "bg-rose-500",
                statusTone === "ready" && "bg-slate-400",
              )}
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[#102033]">
                {statusText}
              </p>
              <p className="truncate text-xs text-[#5a6472]">{syncText}</p>
            </div>
          </div>

          {storageWarning && (
            <div className="mt-3 rounded-[1.2rem] bg-amber-100 px-4 py-3 text-sm text-amber-900">
              {storageWarning}
            </div>
          )}

          {section === "relay" && (
            <section className="mt-6 space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => void handleShowSnapshotQr()}
                  className={pressableCardClasses(
                    "rounded-[1.5rem] bg-[#102033] px-4 py-4 text-left text-white",
                  )}
                >
                  <span className="block text-xs uppercase tracking-[0.22em] text-white/60">
                    Share
                  </span>
                  <span className="mt-2 block text-xl font-semibold">
                    Share QR
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setSection("connect")}
                  className={pressableCardClasses(
                    "rounded-[1.5rem] border border-[#d7cfbe] bg-white/80 px-4 py-4 text-left text-[#102033]",
                  )}
                >
                  <span className="block text-xs uppercase tracking-[0.22em] text-[#945f3d]">
                    Nearby
                  </span>
                  <span className="mt-2 block text-xl font-semibold">
                    Connect
                  </span>
                </button>
              </div>

              <div className="rounded-[1.4rem] border border-[#d7cfbe] bg-white/80 p-4 text-[#102033]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-[#945f3d]">
                      Messages
                    </p>
                    <p className="mt-2 text-lg font-semibold">
                      {messages.length === 0
                        ? "No saved messages yet"
                        : `${messages.length} saved`}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSection("compose")}
                    className={pressableCardClasses(
                      "rounded-full bg-[#102033] px-4 py-2 text-sm font-semibold text-white",
                    )}
                  >
                    New
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                {messages.map((message) => (
                  <button
                    key={message.id}
                    type="button"
                    onClick={() => setSelectedMessage(message)}
                    className={pressableCardClasses(
                      "w-full rounded-[1.5rem] border border-[#d7cfbe] bg-white/85 px-4 py-4 text-left shadow-[0_10px_24px_rgba(16,32,51,0.06)]",
                    )}
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
                          {messageLabel(message.type)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {message.is_conflicted && (
                          <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-900">
                            Conflict
                          </span>
                        )}
                        {message.is_superseded && (
                          <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-700">
                            Updated
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="mt-3 text-lg leading-6 font-medium text-[#102033]">
                      {message.payload}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[#5a6472]">
                      <span>level {message.priority}</span>
                      <span>{message.temperature}</span>
                      <span>rank {message.score.toFixed(2)}</span>
                    </div>
                  </button>
                ))}

                {messages.length === 0 && (
                  <div className="rounded-[1.5rem] border border-dashed border-[#d7cfbe] px-4 py-8 text-center text-sm text-[#5a6472]">
                    No messages stored yet. Compose one to start the relay.
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <article className="rounded-[1.4rem] bg-[#102033] p-4 text-white">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/60">
                    Saved
                  </p>
                  <p className="mt-2 text-3xl font-semibold">{messages.length}</p>
                </article>
                <article className="rounded-[1.4rem] bg-[#e35631] p-4 text-white">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/60">
                    Hot
                  </p>
                  <p className="mt-2 text-3xl font-semibold">{topHotCount}</p>
                </article>
                <article className="rounded-[1.4rem] border border-[#d7cfbe] bg-white/80 p-4 text-[#102033]">
                  <p className="text-xs uppercase tracking-[0.22em] text-[#945f3d]">
                    More
                  </p>
                  <p className="mt-2 text-lg font-semibold">
                    {topWarmCount} medium / {topColdCount} low
                  </p>
                </article>
              </div>

              {developerMode && (
                <section className="rounded-[1.5rem] border border-[#d7cfbe] bg-white/80 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#945f3d]">
                        Debug
                      </p>
                      <h2 className="mt-1 text-lg font-semibold text-[#102033]">
                        Connection details
                      </h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDevPanelOpen((current) => !current)}
                      className="rounded-full bg-[#102033] px-3 py-2 text-xs font-semibold text-white"
                    >
                      {devPanelOpen ? "Hide" : "Show"}
                    </button>
                  </div>

                  {devPanelOpen && (
                    <div className="mt-4 space-y-4 text-sm text-[#102033]">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="rounded-[1.2rem] bg-slate-100 px-3 py-3">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                            Sync
                          </p>
                          <p className="mt-2">
                            new {devState.syncStats.lastNovelCount} / sent{" "}
                            {devState.syncStats.lastSentCount} / received{" "}
                            {devState.syncStats.lastReceivedCount}
                          </p>
                        </div>
                        <div className="rounded-[1.2rem] bg-slate-100 px-3 py-3">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                            Held
                          </p>
                          <p className="mt-2">{devState.quarantineCount} saved</p>
                        </div>
                      </div>

                      <div className="rounded-[1.2rem] bg-slate-100 px-3 py-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                          Codes
                        </p>
                        <p className="mt-2 break-all font-mono text-xs">
                          snapshot: {devState.lastSnapshotPayload || "none"}
                        </p>
                        <p className="mt-2 break-all font-mono text-xs">
                          first: {devState.lastOfferToken || "none"}
                        </p>
                        <p className="mt-2 break-all font-mono text-xs">
                          second: {devState.lastAnswerToken || "none"}
                        </p>
                      </div>

                      <div className="space-y-2">
                        {devState.runs.map((run) => (
                          <div
                            key={run.id}
                            className="rounded-[1.2rem] border border-slate-200 px-3 py-3"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <span
                                className={classNames(
                                  "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]",
                                  run.status === "failed"
                                    ? toneClasses("danger")
                                    : run.status === "partial"
                                      ? toneClasses("warning")
                                      : toneClasses("active"),
                                )}
                              >
                                {run.mode}
                              </span>
                              <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
                                {run.stages.length} steps
                              </span>
                            </div>
                            <p className="mt-2 text-sm font-medium text-[#102033]">
                              {run.summary}
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {run.stages.map((stage) => (
                                <span
                                  key={`${run.id}-${stage.component}`}
                                  className={classNames(
                                    "rounded-full px-2 py-1 text-[10px] font-semibold",
                                    stage.status === "error"
                                      ? toneClasses("danger")
                                      : stage.status === "warning"
                                        ? toneClasses("warning")
                                        : stage.status === "success"
                                          ? toneClasses("active")
                                          : toneClasses("ready"),
                                  )}
                                >
                                  {stage.component}
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}

                        {devState.logs.map((entry) => (
                          <div
                            key={entry.id}
                            className="rounded-[1.2rem] border border-slate-200 px-3 py-3"
                          >
                            <span
                              className={classNames(
                                "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]",
                                toneClasses(entry.tone),
                              )}
                            >
                              {entry.title}
                            </span>
                            <p className="mt-2 text-sm text-[#425061]">
                              {entry.detail}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              )}
            </section>
          )}

          {section === "compose" && (
            <section className="mt-6 space-y-4">
              <div className="rounded-[1.5rem] border border-[#d7cfbe] bg-white/85 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#945f3d]">
                      Compose
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold text-[#102033]">
                      Write a message
                    </h2>
                    <p className="mt-2 text-sm text-[#5a6472]">
                      Save keeps this message on your phone.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSection("relay")}
                    className={pressableCardClasses(
                      "rounded-full border border-[#d7cfbe] bg-white px-4 py-2 text-sm font-semibold text-[#102033]",
                    )}
                  >
                    Back
                  </button>
                </div>
              </div>

              {draftSupersedes && (
                <div className="rounded-[1.3rem] bg-amber-100 px-4 py-3 text-sm text-amber-900">
                  This message will be stored as an update to{" "}
                  <span className="font-mono">{draftSupersedes}</span>.
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {(["text", "alert"] as MessageType[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setDraftType(type)}
                    className={classNames(
                      "rounded-[1.1rem] px-3 py-3 text-sm font-medium transition duration-150 active:scale-[0.98]",
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
                className="h-44 w-full rounded-[1.5rem] border border-[#d8d0bf] bg-white px-4 py-4 text-base text-[#102033] outline-none"
                placeholder="Road blocked at main gate."
              />

              <label className="block text-sm text-[#5a6472]">
                Priority
                <select
                  value={draftPriority}
                  onChange={(event) =>
                    setDraftPriority(
                      Number(event.target.value) as 1 | 2 | 3 | 4 | 5,
                    )
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

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => {
                    setDraftText("");
                    setDraftSupersedes(undefined);
                    setSection("relay");
                  }}
                  className="rounded-[1.3rem] border border-[#d7cfbe] bg-white px-4 py-4 text-sm font-semibold text-[#102033]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveDraft()}
                  className="rounded-[1.3rem] bg-[#102033] px-4 py-4 text-sm font-semibold text-white"
                >
                  Save Message
                </button>
              </div>
            </section>
          )}

          {section === "connect" && (
            <section className="mt-6 space-y-4">
              <div className="rounded-[1.5rem] border border-[#d7cfbe] bg-white/85 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#945f3d]">
                      Nearby
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold text-[#102033]">
                      Connect phones nearby
                    </h2>
                    <ol className="mt-3 space-y-2 text-sm text-[#5a6472]">
                      <li>1. Put both phones on the same hotspot.</li>
                      <li>2. On Phone 1, tap Make First QR.</li>
                      <li>3. On Phone 2, tap Scan First QR.</li>
                      <li>4. Show the second QR back to Phone 1.</li>
                    </ol>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSection("relay")}
                    className={pressableCardClasses(
                      "rounded-full border border-[#d7cfbe] bg-white px-4 py-2 text-sm font-semibold text-[#102033]",
                    )}
                  >
                    Back
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() => void handleCreateOffer()}
                className={pressableCardClasses(
                  "w-full rounded-[1.5rem] bg-[#102033] px-4 py-5 text-left text-white",
                )}
              >
                <span className="block text-xs uppercase tracking-[0.22em] text-white/60">
                  Phone 1
                </span>
                <span className="mt-2 block text-2xl font-semibold">
                  Make First QR
                </span>
              </button>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => openScanner("offer")}
                  className={pressableCardClasses(
                    "rounded-[1.4rem] border border-[#d7cfbe] bg-white/85 px-4 py-4 text-left text-[#102033]",
                  )}
                >
                  <span className="block text-xs uppercase tracking-[0.22em] text-[#945f3d]">
                    Phone 2
                  </span>
                  <span className="mt-2 block text-xl font-semibold">
                    Scan First QR
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => openScanner("answer")}
                  className={pressableCardClasses(
                    "rounded-[1.4rem] border border-[#d7cfbe] bg-white/85 px-4 py-4 text-left text-[#102033]",
                  )}
                >
                  <span className="block text-xs uppercase tracking-[0.22em] text-[#945f3d]">
                    Phone 1
                  </span>
                  <span className="mt-2 block text-xl font-semibold">
                    Scan Second QR
                  </span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => openScanner("snapshot")}
                className={pressableCardClasses(
                  "w-full rounded-[1.4rem] border border-dashed border-[#d7cfbe] bg-white px-4 py-4 text-left text-[#102033]",
                )}
              >
                  <span className="block text-xs uppercase tracking-[0.22em] text-[#945f3d]">
                    Fallback
                  </span>
                  <span className="mt-2 block text-xl font-semibold">
                    Scan Share QR
                  </span>
                </button>

              <div className="rounded-[1.5rem] border border-[#d7cfbe] bg-white/85 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.22em] text-[#945f3d]">
                  Peer Status
                </p>
                <p className="mt-2 text-lg font-semibold text-[#102033]">
                  {syncText}
                </p>
                <p className="mt-2 text-sm text-[#5a6472]">{scannerStatus}</p>
              </div>
            </section>
          )}

          <nav className="mt-6 grid grid-cols-3 gap-2 rounded-[1.6rem] bg-[#eadfce] p-2">
            {(["relay", "compose", "connect"] as Section[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setSection(item)}
                className={classNames(
                  "rounded-[1.1rem] px-3 py-3 text-sm font-medium capitalize transition duration-150 active:scale-[0.98]",
                  section === item
                    ? "bg-[#102033] text-white"
                    : "text-[#5a6472]",
                )}
              >
                {item === "connect" ? "nearby" : item}
              </button>
            ))}
          </nav>
        </div>
      </section>

      {settingsOpen && (
        <div className="fixed inset-0 z-40 flex items-end bg-[#102033]/40 p-4">
          <section className="w-full rounded-[2rem] bg-[#f8f4eb] p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-semibold text-[#102033]">Settings</h2>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className={pressableCardClasses(
                  "rounded-full bg-white px-3 py-2 text-sm text-[#102033]",
                )}
              >
                Back
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => setSecuritySection("security")}
                  className={classNames(
                  "rounded-[1rem] px-3 py-3 text-sm font-semibold transition duration-150 active:scale-[0.98]",
                  securitySection === "security"
                    ? "bg-[#102033] text-white"
                    : "bg-white text-[#102033]",
                )}
              >
                Lock
              </button>
                <button
                  type="button"
                  onClick={() => setSecuritySection("emergency")}
                  className={classNames(
                  "rounded-[1rem] px-3 py-3 text-sm font-semibold transition duration-150 active:scale-[0.98]",
                  securitySection === "emergency"
                    ? "bg-[#102033] text-white"
                    : "bg-white text-[#102033]",
                )}
              >
                Wipe
              </button>
                <button
                  type="button"
                  onClick={() => setSecuritySection("developer")}
                  className={classNames(
                  "rounded-[1rem] px-3 py-3 text-sm font-semibold transition duration-150 active:scale-[0.98]",
                  securitySection === "developer"
                    ? "bg-[#102033] text-white"
                    : "bg-white text-[#102033]",
                )}
              >
                Debug
              </button>
            </div>

            {securitySection === "security" && (
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
              </div>
            )}

            {securitySection === "emergency" && (
              <div className="mt-4 space-y-3">
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
            )}

            {securitySection === "developer" && developerUnlocked && (
              <div className="mt-4 space-y-3">
                <button
                  type="button"
                  onClick={() => {
                    setDeveloperMode((current) => !current);
                    setDevPanelOpen(true);
                    setSection("relay");
                    setSettingsOpen(false);
                  }}
                  className="w-full rounded-[1.2rem] bg-[#102033] px-4 py-3 text-sm font-semibold text-white"
                >
                  {developerMode ? "Hide Debug Panel" : "Show Debug Panel"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDeveloperMode(false);
                    setDevPanelOpen(false);
                    setSettingsOpen(false);
                  }}
                  className={pressableCardClasses(
                    "w-full rounded-[1.2rem] border border-[#d7cfbe] bg-white px-4 py-3 text-sm font-semibold text-[#102033]",
                  )}
                >
                  Turn Debug Off
                </button>
                <button
                  type="button"
                  onClick={() => void handleManualQuarantineDemo()}
                  className={pressableCardClasses(
                    "w-full rounded-[1.2rem] bg-white px-4 py-3 text-sm font-semibold text-[#102033]",
                  )}
                >
                  Test Held Message
                </button>
              </div>
            )}

            <p className="mt-4 text-sm text-[#5a6472]">{sentinelStatus}</p>
          </section>
        </div>
      )}

      {scannerMode && (
        <div className="fixed inset-0 z-50 bg-[#08111c] px-4 py-6 text-white">
          <div className="mx-auto flex h-full w-full max-w-2xl flex-col">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/60">
                  Camera
                </p>
                <h2 className="mt-2 text-2xl font-semibold">
                  {scannerMode === "snapshot" && "Scan Share QR"}
                  {scannerMode === "offer" && "Scan First QR"}
                  {scannerMode === "answer" && "Scan Second QR"}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setScannerMode(null)}
                className={pressableCardClasses(
                  "rounded-full bg-white/10 px-3 py-2 text-sm",
                )}
              >
                Back
              </button>
            </div>

            <div className="mt-6 flex-1 overflow-hidden rounded-[2rem] border border-white/10 bg-black">
              <video
                ref={videoRef}
                className="h-full w-full object-cover"
                muted
                playsInline
              />
            </div>
            <p className="mt-4 text-sm text-white/70">{scannerStatus}</p>
          </div>
        </div>
      )}

      {activeQrUrl && (
        <div className="fixed inset-0 z-50 bg-[#f6f2e8] px-4 py-6">
          <div className="mx-auto flex h-full w-full max-w-2xl flex-col items-center justify-center">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#945f3d]">
              Nexus Relay
            </p>
            <h2 className="mt-3 text-center text-3xl font-semibold text-[#102033]">
              {activeQrTitle}
            </h2>

            {activeQrStatus && (
              <span
                className={classNames(
                  "mt-4 rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em]",
                  toneClasses(activeQrStatus.tone),
                )}
              >
                {activeQrStatus.label}
              </span>
            )}

            <div className="mt-6 w-full rounded-[2rem] bg-white p-4 shadow-[0_18px_60px_rgba(16,32,51,0.14)]">
              <Image
                src={activeQrUrl}
                alt={activeQrTitle}
                width={1200}
                height={1200}
                unoptimized
                className="h-auto w-full"
              />
            </div>
            <p className="mt-5 text-center text-sm text-[#5a6472]">
              {activeQrDetail}
            </p>
            <button
              type="button"
              onClick={closeQr}
              className={pressableCardClasses(
                "mt-6 rounded-[1.3rem] bg-[#102033] px-6 py-3 text-sm font-semibold text-white",
              )}
            >
              Back
            </button>
          </div>
        </div>
      )}

      {selectedMessage && (
        <div className="fixed inset-0 z-40 flex items-end bg-[#102033]/40 p-4">
          <section className="w-full rounded-[2rem] bg-[#f8f4eb] p-5 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span
                  className={classNames(
                    "h-3 w-3 rounded-full",
                    temperatureDot(selectedMessage.temperature),
                  )}
                />
                <span className="text-xs font-semibold uppercase tracking-[0.22em] text-[#945f3d]">
                  {messageLabel(selectedMessage.type)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedMessage(null)}
                className={pressableCardClasses(
                  "rounded-full bg-white px-3 py-2 text-sm text-[#102033]",
                )}
              >
                Back
              </button>
            </div>

            <p className="mt-5 text-2xl leading-8 font-semibold text-[#102033]">
              {selectedMessage.payload}
            </p>

            <div className="mt-5 grid grid-cols-2 gap-3 text-sm text-[#425061]">
              <div className="rounded-[1.2rem] bg-white px-4 py-3">
                <p>level {selectedMessage.priority}</p>
                <p className="mt-1">rank {selectedMessage.score.toFixed(2)}</p>
              </div>
              <div className="rounded-[1.2rem] bg-white px-4 py-3">
                <p>{selectedMessage.temperature}</p>
                <p className="mt-1">
                  compare {selectedMessage.merge_confidence.toFixed(2)}
                </p>
              </div>
            </div>

            {(selectedMessage.is_conflicted || selectedMessage.is_superseded) && (
              <div className="mt-4 rounded-[1.2rem] bg-amber-100 px-4 py-3 text-sm text-amber-900">
                {selectedMessage.is_conflicted &&
                  `This message has other versions: ${selectedMessage.conflict_ids.join(", ")}.`}
                {selectedMessage.is_superseded &&
                  " This message was replaced by a newer version."}
              </div>
            )}

            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => {
                  setSelectedMessage(null);
                  void handleShowSnapshotQr();
                }}
                className="rounded-[1.3rem] border border-[#d7cfbe] bg-white px-4 py-4 text-sm font-semibold text-[#102033]"
              >
                Share QR
              </button>
              <button
                type="button"
                onClick={() => beginCompose(selectedMessage)}
                className="rounded-[1.3rem] bg-[#102033] px-4 py-4 text-sm font-semibold text-white"
              >
                Edit as New
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
