"use client";

import Image from "next/image";
import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildBloomFromMessages,
  buildLiveRoomPayload,
  createInitiator,
  createJoiner,
  decodeTransportPayload,
  enqueueBroadcastMessage,
  finalizeInitiator,
  getSignalOffer,
  isValidRoomCode,
  loadPinHash,
  NexusRepository,
  normalizeRoomCode,
  QUARANTINE_KEY,
  publishSignalAnswer,
  parseCommaSeparatedList,
  normalizeStringList,
  createSignalRoom,
  clearPinAttempts,
  runComposePipeline,
  runLevel3Wipe,
  runPeerSendDrainPipeline,
  runPeerReceivePipeline,
  runScoringLoop,
  runSnapshotIngressPipeline,
  runSnapshotSharePipeline,
  savePinHash,
  SCORING_INTERVAL_MS,
  setRelayBlockedState,
  startCameraScanner,
  submitPinAttempt,
  buildSyncShowcase,
  USER_PROFILE_KEY,
  verifyPin,
  waitForSignalAnswer,
  type NexusUserProfile,
  type MessageType,
  type NexusMessage,
  type NexusMessageWithComputed,
  type PeerArtifacts,
  type PipelineRun,
  type SyncShowcase,
} from "@/lib/nexus";

type Section = "relay" | "compose" | "connect";
type ScannerMode = "snapshot";
type StatusTone = "ready" | "active" | "warning" | "danger";
type PeerState = "idle" | "connecting" | "connected" | "disconnected";
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};
type ConnectStep =
  | "pick_role"
  | "initiator_wait_connect"
  | "joiner_enter_code"
  | "connected"
  | "snapshot_scan";
type SyncWire =
  | {
      type: "BLOOM_OFFER";
      bloom: string;
      messageCount: number;
      profile?: NexusUserProfile;
    }
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

interface SyncSessionState {
  peerProfile?: NexusUserProfile;
  peerAdvertisedCount: number;
  senderRun?: PipelineRun;
  receivedMessages: NexusMessageWithComputed[];
  sentMessageIds: Set<string>;
}

interface DevState {
  logs: DevLogEntry[];
  runs: PipelineRun[];
  lastSnapshotPayload: string;
  lastOfferToken: string;
  lastRoomCode: string;
  quarantineCount: number;
  syncStats: SyncStats;
}

const INSTALL_BANNER_DISMISSED_KEY = "nexus_install_banner_dismissed";
const HANDSHAKE_TIMEOUT_MS = 90_000;
const PREFERENCE_OPTIONS = [
  "water",
  "food",
  "shelter",
  "medicine",
  "evacuation",
  "safety",
  "power",
  "transport",
  "family",
  "weather",
] as const;

function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}

function pressableCardClasses(base: string): string {
  return `${base} border border-transparent transition duration-150 hover:border-[#c77745] hover:shadow-[0_12px_30px_rgba(16,32,51,0.08)] active:scale-[0.98] active:shadow-sm`;
}

function fieldClasses(base: string): string {
  return `${base} transition duration-150 hover:border-[#c77745]`;
}

function toneClasses(tone: StatusTone): string {
  if (tone === "active") return "bg-emerald-100 text-emerald-900";
  if (tone === "warning") return "bg-amber-100 text-amber-900";
  if (tone === "danger") return "bg-rose-100 text-rose-900";
  return "bg-slate-100 text-slate-800";
}

function temperatureDot(
  temperature: NexusMessageWithComputed["temperature"],
): string {
  if (temperature === "hot") return "bg-rose-500";
  if (temperature === "warm") return "bg-amber-400";
  return "bg-slate-400";
}

function messageLabel(type: MessageType): string {
  if (type === "image") return "Image";
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

function formatConsoleTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function describePipelineEvent(run: PipelineRun, event: PipelineRun["events"][number]): string {
  const counters = [
    typeof event.inputCount === "number" ? `in=${event.inputCount}` : null,
    typeof event.outputCount === "number" ? `out=${event.outputCount}` : null,
    typeof event.droppedForFloor === "number"
      ? `floor_drop=${event.droppedForFloor}`
      : null,
    typeof event.droppedForPreference === "number"
      ? `pref_drop=${event.droppedForPreference}`
      : null,
  ].filter(Boolean);

  const annotations = [
    event.matchedTopics?.length
      ? `topics=${event.matchedTopics.join(",")}`
      : null,
    event.inferredTopics?.length
      ? `inferred=${event.inferredTopics.join(",")}`
      : null,
    event.sentinelBlocked ? "sentinel=blocked" : null,
    event.messageId ? `msg=${event.messageId}` : null,
  ].filter(Boolean);

  return [
    `${formatConsoleTime(event.timestamp)} [${run.mode}] ${event.component} ${event.status.toUpperCase()}`,
    event.detail,
    counters.length ? `(${counters.join(" ")})` : null,
    annotations.length ? `[${annotations.join(" | ")}]` : null,
  ]
    .filter(Boolean)
    .join(" ");
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
    lastRoomCode: "",
    quarantineCount: 0,
    syncStats: {
      lastNovelCount: 0,
      lastSentCount: 0,
      lastReceivedCount: 0,
    },
  };
}

function toRawMessage(message: NexusMessageWithComputed): NexusMessage {
  return {
    id: message.id,
    type: message.type,
    priority: message.priority,
    ttl: message.ttl,
    created_at: message.created_at,
    hop_count: message.hop_count,
    weight: message.weight,
    payload: message.payload,
    media_data_url: message.media_data_url,
    crucial_topics: message.crucial_topics,
    confidence: message.confidence,
    supersedes: message.supersedes,
    superseded_by: message.superseded_by,
    schema_version: message.schema_version,
  };
}

function splitPreferences(values: string[]): {
  selected: string[];
  custom: string[];
} {
  const presetSet = new Set<string>(PREFERENCE_OPTIONS);
  const selected: string[] = [];
  const custom: string[] = [];

  for (const value of normalizeStringList(values)) {
    if (presetSet.has(value as (typeof PREFERENCE_OPTIONS)[number])) {
      selected.push(value);
    } else {
      custom.push(value);
    }
  }

  return { selected, custom };
}

function normalizePinInput(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

function messageSummary(message: Pick<NexusMessage, "type" | "payload">): string {
  if (message.type === "image") {
    return message.payload.trim() || "Shared image";
  }
  return message.payload;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read the selected image."));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

export function NexusApp() {
  const repositoryRef = useRef<NexusRepository | null>(null);
  const syncChannelRef = useRef<RTCDataChannel | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const intentionalCloseRef = useRef(false);
  const scannerStopRef = useRef<(() => void) | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const offerPeerRef = useRef<PeerArtifacts | null>(null);
  const joinerPeerRef = useRef<PeerArtifacts | null>(null);
  const handshakeTimeoutRef = useRef<number | null>(null);
  const syncSessionRef = useRef<SyncSessionState>({
    peerAdvertisedCount: 0,
    receivedMessages: [],
    sentMessageIds: new Set<string>(),
  });
  const handleSyncWireRef = useRef<((raw: string) => Promise<void>) | null>(
    null,
  );
  const handleScannedPayloadRef = useRef<
    ((decoded: string) => Promise<void>) | null
  >(null);

  const [messages, setMessages] = useState<NexusMessageWithComputed[]>([]);
  const [mounted, setMounted] = useState(false);
  const [section, setSection] = useState<Section>("relay");
  const [selectedMessage, setSelectedMessage] =
    useState<NexusMessageWithComputed | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftImageDataUrl, setDraftImageDataUrl] = useState("");
  const [draftPriority, setDraftPriority] = useState<1 | 2 | 3 | 4 | 5>(4);
  const [draftType, setDraftType] = useState<MessageType | null>(null);
  const [draftSupersedes, setDraftSupersedes] = useState<string | undefined>();
  const [draftTopicsInput, setDraftTopicsInput] = useState("");

  const [userProfile, setUserProfile] = useState<NexusUserProfile | null>(null);
  const [profileSetupOpen, setProfileSetupOpen] = useState(false);
  const [selectedPreferences, setSelectedPreferences] = useState<string[]>([]);
  const [profilePrefsInput, setProfilePrefsInput] = useState("");
  const [profileRequirementsInput, setProfileRequirementsInput] = useState("");
  const [profileTopicsInput, setProfileTopicsInput] = useState("");

  const [statusTone, setStatusTone] = useState<StatusTone>("ready");
  const [statusText, setStatusText] = useState("Ready");
  const [syncText, setSyncText] = useState(
    "Live sync works best when both phones stay on the same hotspot or Wi-Fi.",
  );
  const [scannerStatus, setScannerStatus] = useState("Scanner idle");
  const [storageWarning, setStorageWarning] = useState("");
  const [peerState, setPeerState] = useState<PeerState>("idle");
  const [sharePanelOpen, setSharePanelOpen] = useState(false);
  const [selectedShareIds, setSelectedShareIds] = useState<string[]>([]);
  const [installPromptEvent, setInstallPromptEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installBannerVisible, setInstallBannerVisible] = useState(false);
  const [installing, setInstalling] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [securitySection, setSecuritySection] = useState<
    "security" | "emergency" | "developer" | "profile"
  >("security");
  const [pinSetup, setPinSetup] = useState("");
  const [pinAttempt, setPinAttempt] = useState("");
  const [wipePinInput, setWipePinInput] = useState("");
  const [pinHash, setPinHash] = useState("");
  const [pinLocked, setPinLocked] = useState(false);
  const [sentinelStatus, setSentinelStatus] = useState("Sentinel idle");

  const developerUnlocked = true;
  const [developerMode, setDeveloperMode] = useState(false);
  const [devPanelOpen, setDevPanelOpen] = useState(false);
  const [devState, setDevState] = useState<DevState>(initialDevState);
  const [syncShowcase, setSyncShowcase] = useState<SyncShowcase | null>(null);
  const [syncShowcaseOpen, setSyncShowcaseOpen] = useState(false);

  const [scannerMode, setScannerMode] = useState<ScannerMode | null>(null);
  const [connectStep, setConnectStep] = useState<ConnectStep>("pick_role");
  const [connectStatusMessage, setConnectStatusMessage] = useState("");
  const [connectHint, setConnectHint] = useState(
    "Both phones should stay on the same hotspot or Wi-Fi.",
  );
  const [connectCodeInput, setConnectCodeInput] = useState("");
  const [snapshotQrUrl, setSnapshotQrUrl] = useState("");
  const [snapshotQrTitle, setSnapshotQrTitle] = useState("");
  const [snapshotQrDetail, setSnapshotQrDetail] = useState("");
  const [snapshotQrStatus, setSnapshotQrStatus] = useState<{
    tone: StatusTone;
    label: string;
  } | null>(null);

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
  const selectedShareMessages = useMemo(
    () => messages.filter((message) => selectedShareIds.includes(message.id)),
    [messages, selectedShareIds],
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (messages.length === 0) {
      setSelectedShareIds([]);
      return;
    }

    setSelectedShareIds((current) => {
      const existing = current.filter((id) =>
        messages.some((message) => message.id === id),
      );
      if (existing.length > 0) {
        return existing;
      }
      return [messages[0].id];
    });
  }, [messages]);

  useEffect(() => {
    if (section !== "connect") {
      setConnectStep("pick_role");
      setConnectStatusMessage("");
      setConnectHint("Both phones should stay on the same hotspot or Wi-Fi.");
    }
  }, [section]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      ("standalone" in window.navigator &&
        Boolean(
          (
            window.navigator as Navigator & {
              standalone?: boolean;
            }
          ).standalone,
        ));

    if (isStandalone) {
      setInstallBannerVisible(false);
      return;
    }

    const dismissed =
      window.localStorage.getItem(INSTALL_BANNER_DISMISSED_KEY) === "true";

    const handleBeforeInstallPrompt = (event: Event) => {
      if (dismissed) return;
      setInstallPromptEvent(event as BeforeInstallPromptEvent);
      setInstallBannerVisible(true);
    };

    const handleAppInstalled = () => {
      window.localStorage.setItem(INSTALL_BANNER_DISMISSED_KEY, "true");
      setInstallPromptEvent(null);
      setInstallBannerVisible(false);
      noteStatus("active", "App installed", "Nexus Relay is ready offline.");
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt,
      );
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

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

  function resetSyncShowcaseState(): void {
    syncSessionRef.current = {
      peerAdvertisedCount: 0,
      receivedMessages: [],
      sentMessageIds: new Set<string>(),
    };
    setSyncShowcase(null);
    setSyncShowcaseOpen(false);
  }

  function resetUiAfterWipe(): void {
    intentionalCloseRef.current = true;
    scannerStopRef.current?.();
    scannerStopRef.current = null;
    if (syncTimerRef.current) {
      window.clearInterval(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    syncChannelRef.current?.close();
    resetNearbyFlow({ preserveStatus: true });
    setMessages([]);
    setSelectedMessage(null);
    setSelectedShareIds([]);
    setSharePanelOpen(false);
    setUserProfile(null);
    setProfileSetupOpen(true);
    setSelectedPreferences([]);
    setProfilePrefsInput("");
    setProfileRequirementsInput("");
    setProfileTopicsInput("");
    setDraftText("");
    setDraftImageDataUrl("");
    setDraftTopicsInput("");
    setPinHash("");
    setPinLocked(false);
    setPinSetup("");
    setPinAttempt("");
    setWipePinInput("");
    setSettingsOpen(false);
    setSentinelStatus("Device wiped");
    setStatusTone("danger");
    setStatusText("Device wiped");
    setDevState(initialDevState());
    resetSyncShowcaseState();
    clearPinAttempts();
  }

  function noteStatus(tone: StatusTone, label: string, detail?: string): void {
    setStatusTone(tone);
    setStatusText(label);
    if (detail) {
      pushDevLog(tone, label, detail);
    }
  }

  async function applyRelayBlockedState(blocked: boolean): Promise<void> {
    if (!repositoryRef.current) return;
    await setRelayBlockedState(repositoryRef.current, blocked);
  }

  function closePeerArtifacts(peer: PeerArtifacts | null): void {
    peer?.channel.close();
    peer?.connection.close();
  }

  function clearHandshakeTimeout(): void {
    if (handshakeTimeoutRef.current) {
      window.clearTimeout(handshakeTimeoutRef.current);
      handshakeTimeoutRef.current = null;
    }
  }

  function resetNearbyFlow(options?: { preserveStatus?: boolean }): void {
    clearHandshakeTimeout();
    intentionalCloseRef.current = true;
    syncChannelRef.current = null;
    hideSnapshotQr();
    closePeerArtifacts(offerPeerRef.current);
    closePeerArtifacts(joinerPeerRef.current);
    offerPeerRef.current = null;
    joinerPeerRef.current = null;
    resetSyncShowcaseState();
    setConnectStep("pick_role");
    setConnectCodeInput("");
    setPeerState("idle");
    setConnectHint("Both phones should stay on the same hotspot or Wi-Fi.");
    if (!options?.preserveStatus) {
      setConnectStatusMessage("");
    }
  }

  function beginHandshakeTimeout(message: string): void {
    clearHandshakeTimeout();
    handshakeTimeoutRef.current = window.setTimeout(() => {
      resetNearbyFlow({ preserveStatus: true });
      setConnectStatusMessage(message);
      setSyncText("Live sync timed out. Snapshot sharing still works offline.");
      noteStatus("warning", "Nearby sync timed out");
    }, HANDSHAKE_TIMEOUT_MS);
  }

  async function showTransportQr(
    title: string,
    detail: string,
    payload: string,
    status: { tone: StatusTone; label: string } | null,
  ): Promise<void> {
    setSnapshotQrTitle(title);
    setSnapshotQrDetail(detail);
    setSnapshotQrStatus(status);
    setSnapshotQrUrl(await buildQrDataUrl(payload));
  }

  function hideSnapshotQr(): void {
    setSnapshotQrTitle("");
    setSnapshotQrDetail("");
    setSnapshotQrStatus(null);
    setSnapshotQrUrl("");
  }

  async function revealCurrentOfferQr(): Promise<void> {
    if (!devState.lastRoomCode) return;
    await showTransportQr(
      "Live Sync Code",
      `Phone 2 can scan this QR or enter code ${devState.lastRoomCode}. The link will finish automatically.`,
      buildLiveRoomPayload(devState.lastRoomCode),
      formatRelativeTone("warning", `Code ${devState.lastRoomCode}`),
    );
  }

  function dismissInstallBanner(): void {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(INSTALL_BANNER_DISMISSED_KEY, "true");
    }
    setInstallBannerVisible(false);
  }

  async function handleInstallApp(): Promise<void> {
    if (!installPromptEvent) return;

    setInstalling(true);
    try {
      await installPromptEvent.prompt();
      const choice = await installPromptEvent.userChoice;
      if (choice.outcome === "accepted") {
        setInstallBannerVisible(false);
      } else {
        dismissInstallBanner();
      }
    } finally {
      setInstallPromptEvent(null);
      setInstalling(false);
    }
  }

  useEffect(() => {
    const repository = new NexusRepository();
    repositoryRef.current = repository;

    const hydrate = async (): Promise<void> => {
      setMessages(await repository.getAll());

      const storedProfile =
        await repository.getSystemState<NexusUserProfile>(USER_PROFILE_KEY);
      if (storedProfile) {
        const { selected, custom } = splitPreferences(storedProfile.preferences);
        setUserProfile(storedProfile);
        setSelectedPreferences(selected);
        setProfilePrefsInput(custom.join(", "));
        setProfileRequirementsInput(storedProfile.requirements);
        setProfileTopicsInput(storedProfile.crucialTopics.join(", "));
        setDraftTopicsInput(storedProfile.crucialTopics.join(", "));
      } else {
        setStatusTone("warning");
        setStatusText("Complete setup to start smart sync");
      }

      const storedPinHash = await loadPinHash(repository);
      if (storedPinHash) {
        setPinHash(storedPinHash);
        setPinLocked(true);
        setPinSetup("");
        setPinAttempt("");
        await setRelayBlockedState(repository, true);
      } else {
        setPinHash("");
        await setRelayBlockedState(repository, false);
      }

      setProfileSetupOpen(!storedProfile || !storedPinHash);

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
      intentionalCloseRef.current = true;
      clearHandshakeTimeout();
      stopScoring();
      stopSweep();
      scannerStopRef.current?.();
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
    setScannerStatus("Opening camera");

    void startCameraScanner(videoRef.current, (decoded) => {
      if (!active) return;
      setScannerMode(null);
      setScannerStatus("QR captured");
      void handleScannedPayloadRef.current?.(decoded);
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

  function queueDeveloperUnlock(): void {
    setSettingsOpen(true);
    setSecuritySection("developer");
  }

  function beginCompose(message?: NexusMessageWithComputed): void {
    if (message) {
      setDraftText(message.payload);
      setDraftImageDataUrl(message.media_data_url ?? "");
      setDraftPriority(message.priority);
      setDraftType(message.type);
      setDraftSupersedes(message.id);
      setDraftTopicsInput((message.crucial_topics ?? []).join(", "));
      setSelectedMessage(null);
      noteStatus(
        "warning",
        "Composing update",
        `Preparing a new message that supersedes ${message.id}.`,
      );
    } else {
      setDraftText("");
      setDraftImageDataUrl("");
      setDraftPriority(4);
      setDraftType(null);
      setDraftSupersedes(undefined);
      setDraftTopicsInput((userProfile?.crucialTopics ?? []).join(", "));
    }
    setSection("compose");
  }

  function addDraftTopic(topic: string): void {
    const current = parseCommaSeparatedList(draftTopicsInput);
    const next = normalizeStringList([...current, topic]);
    setDraftTopicsInput(next.join(", "));
  }

  function togglePreferenceOption(option: string): void {
    setSelectedPreferences((current) =>
      current.includes(option)
        ? current.filter((value) => value !== option)
        : [...current, option],
    );
  }

  async function handleSaveProfile(closeSetup = true): Promise<boolean> {
    if (!repositoryRef.current) return false;

    const preferences = normalizeStringList([
      ...selectedPreferences,
      ...parseCommaSeparatedList(profilePrefsInput),
    ]);
    const crucialTopics = parseCommaSeparatedList(profileTopicsInput);
    const requirements = profileRequirementsInput.trim();

    if (
      preferences.length === 0 &&
      crucialTopics.length === 0 &&
      requirements.length === 0
    ) {
      noteStatus(
        "warning",
        "Set at least one preference",
        "Add preferences, requirements, or crucial topics before continuing.",
      );
      return false;
    }

    const now = Date.now();
    const nextProfile: NexusUserProfile = {
      preferences,
      requirements,
      crucialTopics,
      createdAt: userProfile?.createdAt ?? now,
      updatedAt: now,
    };

    await repositoryRef.current.setSystemState(USER_PROFILE_KEY, nextProfile);
    setUserProfile(nextProfile);
    if (closeSetup) {
      setProfileSetupOpen(false);
    }
    noteStatus(
      "active",
      "Profile saved",
      "Preferences and requirements are now used for hotspot and QR sharing.",
    );
    return true;
  }

  async function handleCompleteInitialSetup(): Promise<void> {
    if (!repositoryRef.current) return;

    const savedProfile = await handleSaveProfile(false);
    if (!savedProfile) {
      return;
    }

    if (!pinHash) {
      try {
        const hash = await savePinHash(repositoryRef.current, pinSetup);
        setPinHash(hash);
        setPinSetup("");
      } catch (error) {
        setSentinelStatus(
          error instanceof Error ? error.message : "Failed to save PIN",
        );
        return;
      }
    }

    setProfileSetupOpen(false);
    setSentinelStatus("Setup complete");
    noteStatus("active", "Setup complete", "Profile and PIN are ready.");
  }

  async function handleSaveDraft(): Promise<void> {
    if (!repositoryRef.current) return;

    if (!draftType) {
      noteStatus("warning", "Choose a message type");
      return;
    }

    if (draftType === "image" && !draftImageDataUrl) {
      noteStatus("warning", "Choose an image to transfer");
      return;
    }

    if (draftType !== "image" && !draftText.trim()) {
      noteStatus("warning", "Message is empty");
      return;
    }

    const result = await runComposePipeline(repositoryRef.current, {
      type: draftType,
      priority: draftPriority,
      payload:
        draftType === "image"
          ? draftText.trim() || "Shared image"
          : draftText.trim(),
      mediaDataUrl: draftType === "image" ? draftImageDataUrl : undefined,
      crucial_topics: parseCommaSeparatedList(draftTopicsInput),
      supersedes: draftSupersedes,
    });

    recordPipelineRun(result.run);
    await refreshMessages();
    if (syncChannelRef.current?.readyState === "open") {
      await sendBloomOffer(syncChannelRef.current);
    }

    noteStatus(
      result.message ? "active" : "warning",
      result.message
        ? "Message stored on this device"
        : "Duplicate message skipped",
      result.run.summary,
    );

    setDraftText("");
    setDraftImageDataUrl("");
    setDraftType(null);
    setDraftSupersedes(undefined);
    setDraftTopicsInput((userProfile?.crucialTopics ?? []).join(", "));
    setSection("relay");
  }

  function toggleShareSelection(messageId: string): void {
    setSelectedShareIds((current) =>
      current.includes(messageId)
        ? current.filter((id) => id !== messageId)
        : [...current, messageId],
    );
  }

  async function handleGenerateSelectedQr(): Promise<void> {
    if (selectedShareMessages.length === 0) {
      noteStatus("warning", "Select at least one message");
      return;
    }

    const qrEligibleMessages = selectedShareMessages.filter(
      (message) => message.type !== "image",
    );
    if (qrEligibleMessages.length === 0) {
      noteStatus(
        "warning",
        "Images transfer in nearby sync only",
        "Use Nearby sync to transfer image messages between devices.",
      );
      return;
    }

    try {
      if (!repositoryRef.current) return;
      const result = await runSnapshotSharePipeline(
        repositoryRef.current,
        qrEligibleMessages.map(toRawMessage),
        userProfile ?? undefined,
      );
      recordPipelineRun(result.run);
      const snapshot = result.snapshot;
      if (!snapshot) {
        noteStatus("warning", "Snapshot not generated", result.run.summary);
        return;
      }
      setDevState((current) => ({
        ...current,
        lastSnapshotPayload: snapshot.qr,
      }));
      await showTransportQr(
        "Share QR",
        "Share the messages you picked with another phone.",
        snapshot.qr,
        formatRelativeTone(
          "ready",
          `Packed ${snapshot.count} message${snapshot.count === 1 ? "" : "s"}`,
        ),
      );
      noteStatus("active", "QR ready", result.run.summary);
    } catch (error) {
      noteStatus(
        "danger",
        error instanceof Error ? error.message : "Snapshot build failed",
      );
    }
  }

  async function sendBloomOffer(channel: RTCDataChannel): Promise<void> {
    if (channel.readyState === "closing" || channel.readyState === "closed") {
      if (syncTimerRef.current) {
        window.clearInterval(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      return;
    }

    if (!repositoryRef.current || channel.readyState !== "open") return;

    const local = await repositoryRef.current.getAllRaw();
    const bloom = buildBloomFromMessages(local);

    channel.send(
      JSON.stringify({
        type: "BLOOM_OFFER",
        bloom: bloom.toBase64(),
        messageCount: local.length,
        profile: userProfile ?? undefined,
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

  function openSyncShowcase(): void {
    const showcase = buildSyncShowcase({
      localProfile: userProfile ?? undefined,
      peerProfile: syncSessionRef.current.peerProfile,
      peerAdvertisedCount: syncSessionRef.current.peerAdvertisedCount,
      senderRun: syncSessionRef.current.senderRun,
      receivedMessages: syncSessionRef.current.receivedMessages,
    });
    setSyncShowcase(showcase);
    setSyncShowcaseOpen(true);
  }

  async function announceIncomingAlert(
    message?: NexusMessageWithComputed,
  ): Promise<void> {
    if (!message || message.type !== "alert") return;

    try {
      await enqueueBroadcastMessage(toRawMessage(message));
    } catch (error) {
      pushDevLog(
        "warning",
        "Alert audio unavailable",
        error instanceof Error
          ? error.message
          : "Could not speak the received alert aloud.",
      );
    }
  }

  async function attachPeer(
    peer: PeerArtifacts,
    role: "initiator" | "joiner",
  ): Promise<void> {
    syncChannelRef.current = peer.channel;
    intentionalCloseRef.current = false;
    setPeerState("connecting");

    peer.connection.onconnectionstatechange = () => {
      const state = peer.connection.connectionState;
      if (state === "connecting") {
        setPeerState("connecting");
        setConnectStatusMessage("Negotiating local peer link...");
        setSyncText("Trying to connect both phones directly over the local network.");
        noteStatus("warning", "Connecting");
      } else if (state === "connected") {
        setPeerState("connected");
        setConnectStep("connected");
        setConnectStatusMessage("");
        setConnectHint("Stay nearby while the phones finish syncing.");
        setSyncText("Phones connected.");
        noteStatus("active", "Connected");
      } else if (state === "disconnected" || state === "failed") {
        setPeerState("disconnected");
        setConnectStatusMessage(
          "Local-only live sync failed. Try again on the same hotspot or use snapshot QR instead.",
        );
        setSyncText("Connection failed. Snapshot sharing still works offline.");
        noteStatus(
          "danger",
          "Connection failed",
          `WebRTC state changed to ${state}.`,
        );
      } else if (state === "closed") {
        setPeerState("disconnected");
        setConnectStatusMessage("Connection closed.");
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
        "A local network candidate failed. Keep both phones on the same hotspot or Wi-Fi and try again.",
      );
    };

    peer.channel.onopen = () => {
      clearHandshakeTimeout();
      setPeerState("connected");
      setConnectStep("connected");
      setConnectStatusMessage("");
      setConnectHint("Live sync stays direct and fully offline while the link is open.");
      setSyncText("Connected. Sharing can continue in the background.");
      noteStatus(
        "active",
        "Connected",
        "The phones are linked directly on the same local network.",
      );

      void sendBloomOffer(peer.channel);

      if (syncTimerRef.current) {
        window.clearInterval(syncTimerRef.current);
      }

      syncTimerRef.current = window.setInterval(() => {
        const ch = syncChannelRef.current;
        if (!ch || ch.readyState === "closing" || ch.readyState === "closed") {
          if (syncTimerRef.current) {
            window.clearInterval(syncTimerRef.current);
            syncTimerRef.current = null;
          }
          return;
        }
        void sendBloomOffer(ch);
      }, SCORING_INTERVAL_MS);
    };

    peer.channel.onclose = () => {
      if (syncTimerRef.current) {
        window.clearInterval(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      setPeerState("disconnected");
      setConnectStep("pick_role");
      setConnectHint("Both phones should stay on the same hotspot or Wi-Fi.");
      setSyncText("Peer disconnected. Ready for the next encounter.");
      noteStatus(
        "warning",
        "Disconnected",
        "The link closed. Messages stay on this phone.",
      );
      clearHandshakeTimeout();
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
      const result = await runPeerSendDrainPipeline(
        repositoryRef.current,
        wire.bloom,
        wire.profile,
        {
          excludeIds: [...syncSessionRef.current.sentMessageIds],
        },
      );
      const queue = result.messages;
      recordPipelineRun(result.run);
      for (const message of queue) {
        syncSessionRef.current.sentMessageIds.add(message.id);
      }
      syncSessionRef.current = {
        ...syncSessionRef.current,
        peerProfile: wire.profile,
        peerAdvertisedCount: wire.messageCount,
        senderRun: result.run,
        sentMessageIds: syncSessionRef.current.sentMessageIds,
      };

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
        await announceIncomingAlert(result.message);
        await refreshMessages();
        if (result.message) {
          syncSessionRef.current = {
            ...syncSessionRef.current,
            sentMessageIds: syncSessionRef.current.sentMessageIds,
            receivedMessages: [
              result.message,
              ...syncSessionRef.current.receivedMessages.filter(
                (message) => message.id !== result.message?.id,
              ),
            ].slice(0, 3),
          };
        }
        setDevState((current) => ({
          ...current,
          syncStats: {
            ...current.syncStats,
            lastReceivedCount: current.syncStats.lastReceivedCount + 1,
          },
        }));
        if (syncChannelRef.current?.readyState === "open") {
          await sendBloomOffer(syncChannelRef.current);
        }
      } else if (result.result === "quarantined") {
        await refreshQuarantineCount();
      }
      return;
    }

    if (wire.type === "SYNC_DONE") {
      setSyncText(
        wire.sentCount > 0
          ? `Connected. Exchanged ${wire.sentCount} priority-sorted message${wire.sentCount === 1 ? "" : "s"} from the current sync pass.`
          : "Connected. The other phone already has the latest messages.",
      );
      if (syncChannelRef.current?.readyState === "open") {
        await sendBloomOffer(syncChannelRef.current);
      }
      openSyncShowcase();
    }
  }

  async function finalizeInitiatorFromRoom(room: string): Promise<void> {
    if (!offerPeerRef.current) {
      throw new Error("Live sync is no longer waiting on this phone.");
    }

    setConnectStatusMessage("Receiver joined. Finalizing nearby link...");
    const answerToken = await waitForSignalAnswer(room, HANDSHAKE_TIMEOUT_MS);
    await finalizeInitiator(offerPeerRef.current.connection, answerToken);
    setConnectHint("Connection is being finalized directly between both phones.");
    hideSnapshotQr();
  }

  async function joinRoomCode(room: string): Promise<void> {
    if (!isValidRoomCode(room)) {
      throw new Error("Connection code must be 6 digits.");
    }

    setConnectStatusMessage("Code received. Fetching the sender offer...");
    setConnectHint("Keep both phones on the same hotspot or Wi-Fi during setup.");
    const offerToken = await getSignalOffer(room);
    const joiner = await createJoiner(offerToken);
    await attachPeer(joiner.peer, "joiner");
    await publishSignalAnswer(room, joiner.answerToken);
    setConnectCodeInput(room);
    setConnectStatusMessage("Connection request sent. Waiting for the sender to finish.");
    setConnectHint("The nearby link should connect in a moment.");
    noteStatus(
      "active",
      "Connection code accepted",
      `Joined live sync room ${room}.`,
    );
  }

  async function handleScannedPayload(decoded: string): Promise<void> {
    if (!repositoryRef.current) return;

    try {
      const payload = decodeTransportPayload(decoded);

      if (payload.kind === "snapshot") {
        const result = await runSnapshotIngressPipeline(
          repositoryRef.current,
          decoded,
        );
        recordPipelineRun(result.run);
        for (const entry of result.results) {
          if (entry.status !== "stored" || !entry.messageId) continue;
          const storedMessage = await repositoryRef.current.getById(entry.messageId);
          await announceIncomingAlert(storedMessage);
        }
        await refreshMessages();
        noteStatus(
          result.stored > 0 ? "active" : "warning",
          `Imported ${result.stored} message${result.stored === 1 ? "" : "s"}`,
          result.run.summary,
        );
        setConnectStep("pick_role");
        setSection("relay");
        return;
      }

      if (payload.kind === "live_room") {
        if (connectStep !== "joiner_enter_code") {
          noteStatus(
            "warning",
            "This QR contains a live sync code",
            "Use it from Receive Live Sync on the second phone.",
          );
          return;
        }

        setConnectCodeInput(payload.room);
        await joinRoomCode(payload.room);
        return;
      }

      if (payload.kind === "live_offer" || payload.kind === "live_answer") {
        if (connectStep !== "joiner_enter_code") {
          noteStatus(
            "warning",
            "Use the new live sync code flow",
            "Ask the sender for the current code or room QR and try again.",
          );
          return;
        }
      }

      noteStatus("warning", "Unsupported QR payload kind");
    } catch (error) {
      noteStatus(
        "danger",
        error instanceof Error ? error.message : "Could not decode QR",
      );
      if (
        connectStep === "joiner_enter_code" ||
        connectStep === "initiator_wait_connect"
      ) {
        setConnectStatusMessage(
          error instanceof Error ? error.message : "Could not decode QR",
        );
      }
    }
  }

  async function handleStartInitiator(): Promise<void> {
    try {
      resetNearbyFlow({ preserveStatus: true });
      hideSnapshotQr();
      setConnectStatusMessage("Creating nearby connection code...");
      setConnectHint("Phone 2 can scan your QR or type your 6-digit code.");
      setConnectStep("initiator_wait_connect");
      setSection("connect");

      const result = await createInitiator();
      await attachPeer(result.peer, "initiator");
      const room = await createSignalRoom(result.offerToken);

      setDevState((current) => ({
        ...current,
        lastOfferToken: result.offerToken,
        lastRoomCode: room.room,
      }));

      await showTransportQr(
        "Live Sync Code",
        `Phone 2 can scan this QR or enter code ${room.room}. The connection will finish automatically.`,
        buildLiveRoomPayload(room.room),
        formatRelativeTone("warning", `Code ${room.room}`),
      );
      setConnectStatusMessage(`Waiting for the receiver to use code ${room.room}.`);
      setSyncText("Live sync code is ready.");
      void finalizeInitiatorFromRoom(room.room).catch((error: unknown) => {
        if (intentionalCloseRef.current) {
          return;
        }
        resetNearbyFlow({ preserveStatus: true });
        setConnectStatusMessage(
          error instanceof Error
            ? error.message
            : "Unable to finish the nearby connection.",
        );
        noteStatus(
          "danger",
          "Connection setup failed",
          error instanceof Error
            ? error.message
            : "Unable to finish the nearby connection.",
        );
      });
      pushDevLog(
        "active",
        "Connection code ready",
        `Prepared live sync room ${room.room} for the second phone.`,
      );
    } catch (error) {
      resetNearbyFlow({ preserveStatus: true });
      setConnectStatusMessage(
        error instanceof Error
          ? error.message
          : "Unable to start local-only live sync.",
      );
      noteStatus(
        "danger",
        "Connection setup failed",
        error instanceof Error ? error.message : "Unable to start local-only live sync.",
      );
    }
  }

  function handleStartJoiner(): void {
    resetNearbyFlow({ preserveStatus: true });
    hideSnapshotQr();
    setConnectStep("joiner_enter_code");
    setConnectStatusMessage("Scan the sender QR or type the 6-digit code.");
    setConnectHint("Keep both phones on the same hotspot or Wi-Fi during setup.");
    setSection("connect");
  }

  async function handleSavePin(): Promise<void> {
    if (!repositoryRef.current) return;

    try {
      const hash = await savePinHash(repositoryRef.current, pinSetup);
      setPinHash(hash);
      setPinSetup("");
      await applyRelayBlockedState(false);
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
      await applyRelayBlockedState(false);
      setSentinelStatus("Unlocked");
      noteStatus("ready", "Device unlocked");
      return;
    }

    if (result.wiped) {
      setPinLocked(false);
      await applyRelayBlockedState(false);
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

  async function handleEmergencyWipe(options?: {
    bypassPin?: boolean;
    pin?: string;
  }): Promise<void> {
    if (!repositoryRef.current) return;
    try {
      if (pinHash && !options?.bypassPin) {
        const enteredPin = options?.pin?.trim() ?? "";
        const valid = await verifyPin(enteredPin, pinHash);

        if (!valid) {
          setSentinelStatus("Enter the correct PIN to confirm wipe.");
          return;
        }
      }

      const elapsed = await runLevel3Wipe(repositoryRef.current);
      repositoryRef.current = null;
      resetUiAfterWipe();
      setSentinelStatus(`Device wiped in ${elapsed.toFixed(1)} ms`);
      noteStatus("danger", "Device wiped", "Emergency wipe completed.");
      window.setTimeout(() => window.location.reload(), 120);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Emergency wipe failed.";
      setSentinelStatus(message);
      noteStatus("danger", "Emergency wipe failed", message);
    }
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

  if (!mounted) return null;

  if (profileSetupOpen) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-8">
        <section className="w-full max-w-xl rounded-[2rem] border border-[#ddd1be] bg-[#f8f4eb] p-6 shadow-[0_20px_80px_rgba(16,32,51,0.12)]">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#945f3d]">
            Setup
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-[#102033]">
            Tell Nexus your priorities
          </h2>
          <p className="mt-2 text-sm text-[#5a6472]">
            These preferences and requirements are exchanged during hotspot
            pairing and used to prioritize what data is sent first. Set a PIN
            now so wipe and unlock controls are ready on this device.
          </p>

          <div className="mt-4 space-y-3">
            <div>
              <p className="text-sm text-[#5a6472]">
                Pick what this device should prioritize
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {PREFERENCE_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => togglePreferenceOption(option)}
                    className={pressableCardClasses(
                      classNames(
                        "rounded-full px-3 py-2 text-sm font-semibold capitalize",
                        selectedPreferences.includes(option)
                          ? "bg-[#102033] text-white"
                          : "bg-white text-[#102033]",
                      ),
                    )}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
            <input
              value={profilePrefsInput}
              onChange={(event) => setProfilePrefsInput(event.target.value)}
              className="w-full rounded-[1.2rem] border border-[#d8d0bf] bg-white px-4 py-3 text-[#102033] outline-none"
              placeholder="More preferences (optional): insulin, baby formula"
            />
            <textarea
              value={profileRequirementsInput}
              onChange={(event) =>
                setProfileRequirementsInput(event.target.value)
              }
              className="h-24 w-full rounded-[1.2rem] border border-[#d8d0bf] bg-white px-4 py-3 text-[#102033] outline-none"
              placeholder="Requirements: prioritize verified updates and nearest-safe-route alerts."
            />
            <input
              value={profileTopicsInput}
              onChange={(event) => setProfileTopicsInput(event.target.value)}
              className="w-full rounded-[1.2rem] border border-[#d8d0bf] bg-white px-4 py-3 text-[#102033] outline-none"
              placeholder="Default crucial topics for your messages"
            />
            <input
              value={pinSetup}
              onChange={(event) => setPinSetup(normalizePinInput(event.target.value))}
              className="w-full rounded-[1.2rem] border border-[#d8d0bf] bg-white px-4 py-3 text-[#102033] outline-none"
              inputMode="numeric"
              placeholder="Create 6-digit PIN"
            />
          </div>

          <button
            type="button"
            onClick={() => void handleCompleteInitialSetup()}
            className="mt-4 w-full rounded-[1.2rem] bg-[#102033] px-4 py-3 text-sm font-semibold text-white"
          >
            Continue
          </button>
        </section>
      </main>
    );
  }

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
            onChange={(event) =>
              setPinAttempt(normalizePinInput(event.target.value))
            }
            className="mt-6 w-full rounded-2xl border border-[#d8d0bf] bg-white px-4 py-3 text-lg tracking-[0.3em] text-[#102033] outline-none"
            inputMode="numeric"
            placeholder="Enter 6-digit PIN"
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
            onClick={() => void handleEmergencyWipe({ pin: pinAttempt })}
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
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-5 sm:px-6 sm:py-8">
      <section className="relative mx-auto w-full max-w-3xl overflow-hidden rounded-[2rem] border border-white/50 bg-[#f6f2e8]/90 p-5 shadow-[0_24px_80px_rgba(16,32,51,0.14)] backdrop-blur sm:p-6">
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

          {installBannerVisible && installPromptEvent && (
            <section className="mt-5 rounded-[1.4rem] border border-[#dfc9b2] bg-white/90 p-5 shadow-[0_12px_30px_rgba(16,32,51,0.08)]">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#945f3d]">
                Install App
              </p>
              <h2 className="mt-2 text-xl font-semibold text-[#102033]">
                Save Nexus Relay on this device
              </h2>
              <p className="mt-2 text-sm leading-6 text-[#5a6472]">
                Install the PWA for a full-screen app experience and easier
                offline access.
              </p>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={() => void handleInstallApp()}
                  disabled={installing}
                  className={pressableCardClasses(
                    classNames(
                      "rounded-[1.2rem] bg-[#102033] px-5 py-3.5 text-sm font-semibold text-white",
                      installing && "cursor-wait opacity-80",
                    ),
                  )}
                >
                  {installing ? "Opening install prompt..." : "Install app"}
                </button>
                <button
                  type="button"
                  onClick={dismissInstallBanner}
                  className={pressableCardClasses(
                    "rounded-[1.2rem] bg-white px-5 py-3.5 text-sm font-medium text-[#102033]",
                  )}
                >
                  Maybe later
                </button>
              </div>
            </section>
          )}

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
                  onClick={() => setSharePanelOpen((current) => !current)}
                  className={pressableCardClasses(
                    "rounded-[1.5rem] bg-[#102033] px-5 py-5 text-left text-white",
                  )}
                >
                  <span className="block text-xs uppercase tracking-[0.22em] text-white/60">
                    QR
                  </span>
                  <span className="mt-2 block text-xl font-semibold">
                    Generate QR
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => openScanner("snapshot")}
                  className={pressableCardClasses(
                    "rounded-[1.5rem] border border-[#d7cfbe] bg-white/80 px-5 py-5 text-left text-[#102033]",
                  )}
                >
                  <span className="block text-xs uppercase tracking-[0.22em] text-[#945f3d]">
                    QR
                  </span>
                  <span className="mt-2 block text-xl font-semibold">
                    Scan QR
                  </span>
                </button>
              </div>

              {sharePanelOpen && (
                <section className="rounded-[1.5rem] border border-[#d7cfbe] bg-white/85 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#945f3d]">
                        Pick Messages
                      </p>
                      <p className="mt-2 text-sm text-[#5a6472]">
                        Choose the messages to include in this QR.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSharePanelOpen(false)}
                      className={pressableCardClasses(
                        "rounded-full border border-[#d7cfbe] bg-white px-4 py-2 text-sm font-semibold text-[#102033]",
                      )}
                    >
                      Hide
                    </button>
                  </div>

                  <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-1">
                    {messages.map((message) => {
                      const checked = selectedShareIds.includes(message.id);
                      return (
                        <label
                          key={message.id}
                          className={classNames(
                            "flex cursor-pointer items-center gap-3 rounded-[1.2rem] border px-4 py-3.5 transition hover:border-[#c77745] hover:shadow-[0_10px_24px_rgba(16,32,51,0.06)]",
                            checked
                              ? "border-[#102033] bg-[#f3eee4]"
                              : "border-[#e4d9c7] bg-white",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleShareSelection(message.id)}
                            className="h-4 w-4 accent-[#102033]"
                          />
                          <span
                            className={classNames(
                              "h-3 w-3 shrink-0 rounded-full",
                              temperatureDot(message.temperature),
                            )}
                          />
                      <span className="min-w-0 flex-1 truncate text-sm text-[#102033]">
                            {messageSummary(message)}
                      </span>
                        </label>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleGenerateSelectedQr()}
                    disabled={selectedShareMessages.length === 0}
                    className={pressableCardClasses(
                      classNames(
                        "mt-4 w-full rounded-[1.3rem] px-4 py-4 text-sm font-semibold",
                        selectedShareMessages.length === 0
                          ? "cursor-not-allowed bg-[#d9d1c4] text-[#786f60]"
                          : "bg-[#102033] text-white",
                      ),
                    )}
                  >
                    {selectedShareMessages.length === 0
                      ? "Select at least one message"
                      : "Generate"}
                  </button>
                </section>
              )}

              <div className="rounded-[1.4rem] border border-[#d7cfbe] bg-white/80 p-5 text-[#102033]">
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
                    onClick={() => beginCompose()}
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
                      "w-full rounded-[1.5rem] border border-[#d7cfbe] bg-white/85 px-5 py-5 text-left shadow-[0_10px_24px_rgba(16,32,51,0.06)]",
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
                    {message.type === "image" && message.media_data_url ? (
                      <Image
                        src={message.media_data_url}
                        alt={message.payload || "Shared image"}
                        width={1200}
                        height={800}
                        unoptimized
                        className="mt-3 h-44 w-full rounded-[1.2rem] object-cover"
                      />
                    ) : null}
                    <p className="mt-3 text-lg leading-7 font-normal text-[#102033]">
                      {messageSummary(message)}
                    </p>
                    {!!message.crucial_topics?.length && (
                      <p className="mt-2 text-xs text-[#5a6472]">
                        topics: {message.crucial_topics.join(", ")}
                      </p>
                    )}
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
                  <p className="mt-2 text-3xl font-semibold">
                    {messages.length}
                  </p>
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
                          <p className="mt-2">
                            {devState.quarantineCount} saved
                          </p>
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
                          offer: {devState.lastOfferToken || "none"}
                        </p>
                        <p className="mt-2 break-all font-mono text-xs">
                          room: {devState.lastRoomCode || "none"}
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
                            <p className="mt-2 text-sm font-normal text-[#102033]">
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
                                  {typeof stage.outputCount === "number" &&
                                    `:${stage.outputCount}`}
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}

                        <div className="rounded-[1.2rem] border border-black bg-[#111111] px-3 py-3 font-mono text-xs text-[#d8f7dd]">
                          <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-2">
                            <span className="uppercase tracking-[0.18em] text-[#7ef0a2]">
                              Pipeline Console
                            </span>
                            <span className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                              oldest - newest
                            </span>
                          </div>
                          <div className="mt-3 max-h-72 space-y-1 overflow-y-auto pr-1">
                            {[...devState.runs]
                              .reverse()
                              .flatMap((run) => [
                                `--- ${run.mode} ${run.status.toUpperCase()} ${run.summary}`,
                                ...run.events.map((event) =>
                                  describePipelineEvent(run, event),
                                ),
                              ])
                              .map((line, index) => (
                                <p
                                  key={`${index}-${line.slice(0, 24)}`}
                                  className="break-words leading-5"
                                >
                                  {line}
                                </p>
                              ))}
                          </div>
                        </div>

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
              <div className="rounded-[1.5rem] border border-[#d7cfbe] bg-white/85 p-5">
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

              <div>
                <p className="text-sm text-[#5a6472]">
                  Message type is required
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(["text", "alert", "audio", "image"] as MessageType[]).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setDraftType(type)}
                      className={classNames(
                        "rounded-[1.1rem] px-3 py-3.5 text-sm font-semibold transition duration-150 active:scale-[0.98]",
                        draftType === type
                          ? "bg-[#102033] text-white"
                          : "bg-white text-[#102033]",
                      )}
                    >
                      {messageLabel(type)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3 rounded-[1.4rem] border border-[#d7cfbe] bg-white/80 p-4">
                <label className="block text-sm text-[#5a6472]">
                  {draftType === "image" ? "Select image" : "Optional image"}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) {
                        setDraftImageDataUrl("");
                        return;
                      }
                      void fileToDataUrl(file)
                        .then((dataUrl) => {
                          setDraftImageDataUrl(dataUrl);
                          if (!draftText.trim()) {
                            setDraftText(file.name.replace(/\.[^.]+$/, ""));
                          }
                        })
                        .catch((error: unknown) => {
                          noteStatus(
                            "danger",
                            error instanceof Error
                              ? error.message
                              : "Could not read image",
                          );
                        });
                    }}
                    className="mt-2 block w-full text-sm text-[#102033]"
                  />
                </label>
                {draftImageDataUrl && (
                  <Image
                    src={draftImageDataUrl}
                    alt={draftText || "Selected image"}
                    width={1200}
                    height={800}
                    unoptimized
                    className="h-52 w-full rounded-[1.2rem] object-cover"
                  />
                )}
              </div>

              <textarea
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                className={fieldClasses(
                  "h-44 w-full rounded-[1.5rem] border border-[#d8d0bf] bg-white px-4 py-4 text-base text-[#102033] outline-none",
                )}
                placeholder={
                  draftType === "image"
                    ? "Optional caption for this image."
                    : "Road blocked at main gate."
                }
              />

              <label className="block text-sm text-[#5a6472]">
                Crucial topics (comma separated)
                <input
                  value={draftTopicsInput}
                  onChange={(event) => setDraftTopicsInput(event.target.value)}
                  className="mt-2 w-full rounded-[1.2rem] border border-[#d8d0bf] bg-white px-4 py-3 text-[#102033] outline-none"
                  placeholder="water, shelter, medicine"
                />
              </label>

              {!!userProfile?.crucialTopics?.length && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#945f3d]">
                    Quick topics
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {userProfile.crucialTopics.map((topic) => (
                      <button
                        key={topic}
                        type="button"
                        onClick={() => addDraftTopic(topic)}
                        className={pressableCardClasses(
                          "rounded-full border border-[#d7cfbe] bg-white px-3 py-1 text-xs font-semibold text-[#102033]",
                        )}
                      >
                        {topic}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <label className="block text-sm text-[#5a6472]">
                Priority
                <select
                  value={draftPriority}
                  onChange={(event) =>
                    setDraftPriority(
                      Number(event.target.value) as 1 | 2 | 3 | 4 | 5,
                    )
                  }
                  className={fieldClasses(
                    "mt-2 w-full rounded-[1.2rem] border border-[#d8d0bf] bg-white px-4 py-3.5 text-[#102033] outline-none",
                  )}
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
                      setDraftImageDataUrl("");
                      setDraftType(null);
                      setDraftSupersedes(undefined);
                      setSection("relay");
                  }}
                  className={pressableCardClasses(
                    "rounded-[1.3rem] border border-[#d7cfbe] bg-white px-4 py-4 text-sm font-semibold text-[#102033]",
                  )}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveDraft()}
                  className={pressableCardClasses(
                    classNames(
                      "rounded-[1.3rem] px-4 py-4 text-sm font-semibold",
                      draftType
                        ? "bg-[#102033] text-white"
                        : "bg-[#d9d1c4] text-[#786f60]",
                    ),
                  )}
                >
                  Save Message
                </button>
              </div>
            </section>
          )}

          {section === "connect" && (
            <section className="mt-6 space-y-4">
              {connectStep === "pick_role" && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleStartInitiator()}
                    className={pressableCardClasses(
                      "w-full rounded-[1.5rem] bg-[#102033] px-6 py-6 text-left text-white",
                    )}
                  >
                    <span className="block text-2xl font-semibold">
                      Live Sync Nearby
                    </span>
                    <span className="mt-2 block text-sm text-white/70">
                      Show one QR or one 6-digit code for the receiver
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={handleStartJoiner}
                    className={pressableCardClasses(
                      "w-full rounded-[1.5rem] border border-[#d7cfbe] bg-white/85 px-6 py-6 text-left text-[#102033]",
                    )}
                  >
                    <span className="block text-2xl font-semibold">
                      Receive Live Sync
                    </span>
                    <span className="mt-2 block text-sm text-[#5a6472]">
                      Scan the sender QR or enter the 6-digit code
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setConnectStep("snapshot_scan");
                      openScanner("snapshot");
                    }}
                    className="text-left text-sm font-semibold text-[#945f3d]"
                  >
                    Share or scan a snapshot QR {"->"}
                  </button>
                </>
              )}

              {connectStep === "initiator_wait_connect" && (
                <section className="rounded-[1.5rem] border border-[#d7cfbe] bg-white/85 p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#945f3d]">
                    Live Sync
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold text-[#102033]">
                    Share this code
                  </h2>
                  <p className="mt-4 text-sm text-[#5a6472]">
                    {connectHint}
                  </p>
                  <p className="mt-2 text-sm font-semibold text-[#102033]">
                    {connectStatusMessage || "Waiting for the receiver to join."}
                  </p>
                  <div className="mt-5 rounded-[1.4rem] bg-[#102033] px-4 py-5 text-center text-white">
                    <p className="text-xs uppercase tracking-[0.18em] text-white/60">
                      Connection code
                    </p>
                    <p className="mt-2 text-4xl font-semibold tracking-[0.28em]">
                      {devState.lastRoomCode || "......"}
                    </p>
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => void revealCurrentOfferQr()}
                      className={pressableCardClasses(
                        "rounded-[1.3rem] border border-[#d7cfbe] bg-white px-4 py-4 text-sm font-semibold text-[#102033]",
                      )}
                    >
                      Show QR
                    </button>
                    <div className="rounded-[1.3rem] border border-dashed border-[#d7cfbe] px-4 py-4 text-sm text-[#5a6472]">
                      The receiver only needs this one code.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      hideSnapshotQr();
                      resetNearbyFlow();
                    }}
                    className={pressableCardClasses(
                      "mt-4 w-full rounded-[1.3rem] border border-[#d7cfbe] bg-white px-4 py-4 text-sm font-semibold text-[#102033]",
                    )}
                  >
                    Cancel
                  </button>
                </section>
              )}

              {connectStep === "joiner_enter_code" && (
                <section className="rounded-[1.5rem] border border-[#d7cfbe] bg-white/85 p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#945f3d]">
                    Live Sync
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold text-[#102033]">
                    Join with code or QR
                  </h2>
                  <p className="mt-3 text-sm text-[#5a6472]">{connectHint}</p>
                  <p className="mt-4 text-sm font-semibold text-[#102033]">
                    {connectStatusMessage}
                  </p>
                  <input
                    value={connectCodeInput}
                    onChange={(event) =>
                      setConnectCodeInput(normalizeRoomCode(event.target.value))
                    }
                    inputMode="numeric"
                    placeholder="Enter 6-digit code"
                    className={fieldClasses(
                      "mt-4 w-full rounded-[1.2rem] border border-[#d8d0bf] bg-white px-4 py-3 text-center text-2xl tracking-[0.32em] text-[#102033] outline-none",
                    )}
                  />
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => void joinRoomCode(connectCodeInput)}
                      disabled={!isValidRoomCode(connectCodeInput)}
                      className={pressableCardClasses(
                        classNames(
                          "rounded-[1.3rem] px-4 py-4 text-sm font-semibold",
                          isValidRoomCode(connectCodeInput)
                            ? "bg-[#102033] text-white"
                            : "cursor-not-allowed bg-[#d9d1c4] text-[#786f60]",
                        ),
                      )}
                    >
                      Join with Code
                    </button>
                    <button
                      type="button"
                      onClick={() => openScanner("snapshot")}
                      className={pressableCardClasses(
                        "rounded-[1.3rem] border border-[#d7cfbe] bg-white px-4 py-4 text-sm font-semibold text-[#102033]",
                      )}
                    >
                      Scan QR Instead
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      resetNearbyFlow();
                      setScannerMode(null);
                    }}
                    className={pressableCardClasses(
                      "mt-4 rounded-full border border-[#d7cfbe] bg-white px-4 py-2 text-sm font-semibold text-[#102033]",
                    )}
                  >
                    {"< Back"}
                  </button>
                </section>
              )}

              {connectStep === "connected" && (
                <section className="rounded-[1.5rem] border border-emerald-200 bg-emerald-50 p-5">
                  <p className="text-2xl font-semibold text-emerald-900">
                    Connected
                  </p>
                  <p className="mt-2 text-sm text-emerald-900">{connectHint}</p>
                  <p className="mt-2 text-sm text-emerald-900">{syncText}</p>
                  <button
                    type="button"
                    onClick={() => setSyncShowcaseOpen(true)}
                    disabled={!syncShowcase}
                    className={pressableCardClasses(
                      classNames(
                        "mt-4 w-full rounded-[1.3rem] border border-emerald-300 px-4 py-4 text-sm font-semibold",
                        syncShowcase
                          ? "bg-white text-emerald-900"
                          : "cursor-not-allowed bg-emerald-100 text-emerald-700/70",
                      ),
                    )}
                  >
                    View Sync Showcase
                  </button>
                  <button
                    type="button"
                    onClick={() => setSection("relay")}
                    className={pressableCardClasses(
                      "mt-3 w-full rounded-[1.3rem] bg-[#102033] px-4 py-4 text-sm font-semibold text-white",
                    )}
                  >
                    Done
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      intentionalCloseRef.current = true;
                      syncChannelRef.current?.close();
                      resetNearbyFlow();
                    }}
                    className={pressableCardClasses(
                      "mt-3 w-full rounded-[1.3rem] border border-[#d7cfbe] bg-white px-4 py-4 text-sm font-semibold text-[#102033]",
                    )}
                  >
                    Disconnect
                  </button>
                </section>
              )}

              {connectStep === "snapshot_scan" && (
                <section className="rounded-[1.5rem] border border-[#d7cfbe] bg-white/85 p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#945f3d]">
                    Snapshot
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold text-[#102033]">
                    Scan a snapshot QR
                  </h2>
                  <p className="mt-3 text-sm text-[#5a6472]">
                    Use this when live sync is inconvenient or a local-only link fails.
                  </p>
                  <p className="mt-4 text-sm text-[#5a6472]">{scannerStatus}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setConnectStep("pick_role");
                      setScannerMode(null);
                    }}
                    className={pressableCardClasses(
                      "mt-4 rounded-full border border-[#d7cfbe] bg-white px-4 py-2 text-sm font-semibold text-[#102033]",
                    )}
                  >
                    {"< Back"}
                  </button>
                </section>
              )}
            </section>
          )}

          <nav className="mt-6 grid grid-cols-3 gap-2 rounded-[1.6rem] bg-[#eadfce] p-2">
            {(["relay", "compose", "connect"] as Section[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => {
                  if (item === "connect") {
                    setConnectStep("pick_role");
                  }
                  if (item === "compose") {
                    beginCompose();
                    return;
                  }
                  setSection(item);
                }}
                className={classNames(
                  "rounded-[1.1rem] px-3 py-3.5 text-sm font-semibold capitalize transition duration-150 active:scale-[0.98]",
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
              <h2 className="text-2xl font-semibold text-[#102033]">
                Settings
              </h2>
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

            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-4">
              <button
                type="button"
                onClick={() => setSecuritySection("profile")}
                className={classNames(
                  "rounded-[1rem] px-3 py-3 text-sm font-semibold transition duration-150 active:scale-[0.98]",
                  securitySection === "profile"
                    ? "bg-[#102033] text-white"
                    : "bg-white text-[#102033]",
                )}
              >
                Profile
              </button>
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

            {securitySection === "profile" && (
              <div className="mt-4 space-y-3">
                <div>
                  <p className="text-sm text-[#5a6472]">
                    Pick what this device should prioritize
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {PREFERENCE_OPTIONS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => togglePreferenceOption(option)}
                        className={pressableCardClasses(
                          classNames(
                            "rounded-full px-3 py-2 text-sm font-semibold capitalize",
                            selectedPreferences.includes(option)
                              ? "bg-[#102033] text-white"
                              : "bg-white text-[#102033]",
                          ),
                        )}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  value={profilePrefsInput}
                  onChange={(event) => setProfilePrefsInput(event.target.value)}
                  className="w-full rounded-[1.2rem] border border-[#d8d0bf] bg-white px-4 py-3 text-[#102033] outline-none"
                  placeholder="More preferences (optional): medicine, insulin"
                />
                <textarea
                  value={profileRequirementsInput}
                  onChange={(event) =>
                    setProfileRequirementsInput(event.target.value)
                  }
                  className="h-24 w-full rounded-[1.2rem] border border-[#d8d0bf] bg-white px-4 py-3 text-[#102033] outline-none"
                  placeholder="Requirements: Include confirmed evacuation updates first."
                />
                <input
                  value={profileTopicsInput}
                  onChange={(event) =>
                    setProfileTopicsInput(event.target.value)
                  }
                  className="w-full rounded-[1.2rem] border border-[#d8d0bf] bg-white px-4 py-3 text-[#102033] outline-none"
                  placeholder="Crucial topics for your outgoing messages"
                />
                <button
                  type="button"
                  onClick={() => void handleSaveProfile()}
                  className="w-full rounded-[1.2rem] bg-[#102033] px-4 py-3 text-sm font-semibold text-white"
                >
                  Save Profile
                </button>
              </div>
            )}

            {securitySection === "security" && (
              <div className="mt-4 space-y-3">
                <input
                  value={pinSetup}
                  onChange={(event) =>
                    setPinSetup(normalizePinInput(event.target.value))
                  }
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
                  onClick={() => {
                    const shouldLock = Boolean(pinHash);
                    setPinLocked(shouldLock);
                    void applyRelayBlockedState(shouldLock);
                  }}
                  className="w-full rounded-[1.2rem] bg-white px-4 py-3 text-sm font-semibold text-[#102033]"
                >
                  Lock App Now
                </button>
              </div>
            )}

            {securitySection === "emergency" && (
              <div className="mt-4 space-y-3">
                <input
                  value={wipePinInput}
                  onChange={(event) =>
                    setWipePinInput(normalizePinInput(event.target.value))
                  }
                  className="w-full rounded-[1.2rem] border border-[#d8d0bf] bg-white px-4 py-3 text-center text-[#102033] outline-none"
                  inputMode="numeric"
                  placeholder="Enter PIN to confirm wipe"
                />
                <button
                  type="button"
                  onClick={() => void handleEmergencyWipe({ pin: wipePinInput })}
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
                  {scannerMode === "snapshot" &&
                    connectStep === "joiner_enter_code" &&
                    "Scan Live Sync QR"}
                  {scannerMode === "snapshot" &&
                    connectStep !== "joiner_enter_code" &&
                    connectStep !== "snapshot_scan" &&
                    "Scan Share QR"}
                  {scannerMode === "snapshot" &&
                    connectStep === "snapshot_scan" &&
                    "Scan Share QR"}
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

      {snapshotQrUrl && (
        <div className="fixed inset-0 z-50 bg-[#f6f2e8] px-4 py-6">
          <div className="mx-auto flex h-full w-full max-w-2xl flex-col items-center justify-center">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#945f3d]">
              Nexus Relay
            </p>
            <h2 className="mt-3 text-center text-3xl font-semibold text-[#102033]">
              {snapshotQrTitle}
            </h2>

            {snapshotQrStatus && (
              <span
                className={classNames(
                  "mt-4 rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em]",
                  toneClasses(snapshotQrStatus.tone),
                )}
              >
                {snapshotQrStatus.label}
              </span>
            )}

            <div className="mt-6 flex w-full flex-col items-center gap-4 sm:flex-row sm:items-start sm:justify-center">
              <button
                type="button"
                onClick={hideSnapshotQr}
                className={pressableCardClasses(
                  "inline-flex items-center gap-2 rounded-[1.3rem] bg-[#102033] px-5 py-3 text-sm font-semibold text-white sm:self-center",
                )}
              >
                <span aria-hidden="true">{"<-"}</span>
                Back
              </button>

              <div className="w-full rounded-[2rem] bg-white p-4 shadow-[0_18px_60px_rgba(16,32,51,0.14)]">
                <Image
                  src={snapshotQrUrl}
                  alt={snapshotQrTitle}
                  width={1200}
                  height={1200}
                  unoptimized
                  className="h-auto w-full"
                />
              </div>
            </div>
            <p className="mt-5 text-center text-sm text-[#5a6472]">
              {snapshotQrDetail}
            </p>
          </div>
        </div>
      )}

      {syncShowcaseOpen && syncShowcase && (
        <div className="fixed inset-0 z-50 flex items-end bg-[#102033]/50 p-4 sm:items-center sm:justify-center">
          <section className="w-full max-w-3xl rounded-[2rem] border border-[#d7cfbe] bg-[#f8f4eb] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#945f3d]">
                  Sync Showcase
                </p>
                <h2 className="mt-2 text-2xl font-semibold text-[#102033]">
                  Limited-time sync, filtered by the pipeline
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setSyncShowcaseOpen(false)}
                className={pressableCardClasses(
                  "rounded-full bg-white px-3 py-2 text-sm text-[#102033]",
                )}
              >
                Close
              </button>
            </div>

            <div className="mt-5 rounded-[1.5rem] bg-[#102033] px-5 py-5 text-white">
              <p className="text-sm leading-6 text-white/90">{syncShowcase.summary}</p>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-[1.3rem] border border-[#d7cfbe] bg-white px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#945f3d]">
                  Local priorities
                </p>
                <p className="mt-2 text-sm text-[#102033]">
                  {syncShowcase.localPreferences.length > 0
                    ? syncShowcase.localPreferences.join(", ")
                    : "No explicit priorities set"}
                </p>
              </div>
              <div className="rounded-[1.3rem] border border-[#d7cfbe] bg-white px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#945f3d]">
                  Peer priorities
                </p>
                <p className="mt-2 text-sm text-[#102033]">
                  {syncShowcase.peerPreferences.length > 0
                    ? syncShowcase.peerPreferences.join(", ")
                    : "Peer shared no explicit priorities"}
                </p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <article className="rounded-[1.3rem] bg-white px-4 py-4">
                <p className="text-xs uppercase tracking-[0.18em] text-[#945f3d]">
                  Bloom Filter
                </p>
                <p className="mt-2 text-2xl font-semibold text-[#102033]">
                  {Math.max(
                    0,
                    syncShowcase.localMessageCount - syncShowcase.novelCandidateCount,
                  )}
                </p>
                <p className="mt-1 text-xs text-[#5a6472]">redundant sends avoided</p>
              </article>
              <article className="rounded-[1.3rem] bg-white px-4 py-4">
                <p className="text-xs uppercase tracking-[0.18em] text-[#945f3d]">
                  Prioritization Agent
                </p>
                <p className="mt-2 text-2xl font-semibold text-[#102033]">
                  {syncShowcase.prioritizedCount}
                </p>
                <p className="mt-1 text-xs text-[#5a6472]">ranked for limited time</p>
              </article>
              <article className="rounded-[1.3rem] bg-white px-4 py-4">
                <p className="text-xs uppercase tracking-[0.18em] text-[#945f3d]">
                  Relay Gate
                </p>
                <p className="mt-2 text-2xl font-semibold text-[#102033]">
                  {syncShowcase.selectedCount}
                </p>
                <p className="mt-1 text-xs text-[#5a6472]">messages allowed through</p>
              </article>
              <article className="rounded-[1.3rem] bg-white px-4 py-4">
                <p className="text-xs uppercase tracking-[0.18em] text-[#945f3d]">
                  Storage
                </p>
                <p className="mt-2 text-2xl font-semibold text-[#102033]">
                  {syncShowcase.receivedCount}
                </p>
                <p className="mt-1 text-xs text-[#5a6472]">new messages stored</p>
              </article>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-[1.3rem] border border-[#d7cfbe] bg-white px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#945f3d]">
                  Pipeline decisions
                </p>
                <div className="mt-3 space-y-2 text-sm text-[#102033]">
                  <p>Peer advertised {syncShowcase.peerAdvertisedCount} known IDs.</p>
                  <p>Bloom diff kept {syncShowcase.novelCandidateCount} novel candidates from {syncShowcase.localMessageCount} local messages.</p>
                  <p>Relay Gate dropped {syncShowcase.droppedForFloor} below priority floor and {syncShowcase.droppedForPreference} outside preference matches.</p>
                </div>
              </div>
              <div className="rounded-[1.3rem] border border-[#d7cfbe] bg-white px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#945f3d]">
                  Shared interests
                </p>
                <p className="mt-2 text-sm text-[#102033]">
                  {syncShowcase.matchedTopics.length > 0
                    ? syncShowcase.matchedTopics.join(", ")
                    : "No direct overlap, so the pipeline fell back to message priority."}
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-[1.3rem] border border-[#d7cfbe] bg-white px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#945f3d]">
                Received preview
              </p>
              {syncShowcase.topReceivedMessages.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {syncShowcase.topReceivedMessages.map((message) => (
                    <div
                      key={message.id}
                      className="rounded-[1rem] bg-[#f3eee4] px-3 py-3 text-sm text-[#102033]"
                    >
                      <span className="font-semibold">{messageLabel(message.type)}:</span>{" "}
                      {message.mediaDataUrl ? (
                        <div className="mt-2">
                          <Image
                            src={message.mediaDataUrl}
                            alt={message.payload || "Received image"}
                            width={1200}
                            height={800}
                            unoptimized
                            className="h-40 w-full rounded-[1rem] object-cover"
                          />
                          <p className="mt-2">{message.payload}</p>
                        </div>
                      ) : (
                        message.payload
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-[#5a6472]">
                  No new inbound messages were stored during this sync cycle.
                </p>
              )}
            </div>
          </section>
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
              {messageSummary(selectedMessage)}
            </p>

            {selectedMessage.type === "image" && selectedMessage.media_data_url ? (
              <Image
                src={selectedMessage.media_data_url}
                alt={selectedMessage.payload || "Shared image"}
                width={1200}
                height={900}
                unoptimized
                className="mt-5 h-auto w-full rounded-[1.5rem] object-cover"
              />
            ) : null}

            {!!selectedMessage.crucial_topics?.length && (
              <p className="mt-2 text-sm text-[#5a6472]">
                topics: {selectedMessage.crucial_topics.join(", ")}
              </p>
            )}

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

            {(selectedMessage.is_conflicted ||
              selectedMessage.is_superseded) && (
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
                  const message = selectedMessage;
                  setSelectedMessage(null);
                  if (!message || !repositoryRef.current) return;
                  if (message.type === "image") {
                    noteStatus(
                      "warning",
                      "Images transfer in nearby sync only",
                      "Open Nearby sync to send this image to another device.",
                    );
                    return;
                  }
                  setSelectedShareIds([message.id]);
                  setSharePanelOpen(true);
                  void runSnapshotSharePipeline(
                    repositoryRef.current,
                    [toRawMessage(message)],
                    userProfile ?? undefined,
                  )
                    .then(async (result) => {
                      recordPipelineRun(result.run);
                      const snapshot = result.snapshot;
                      if (!snapshot) {
                        noteStatus(
                          "warning",
                          "Snapshot not generated",
                          result.run.summary,
                        );
                        return;
                      }
                      setDevState((current) => ({
                        ...current,
                        lastSnapshotPayload: snapshot.qr,
                      }));
                      await showTransportQr(
                        "Share QR",
                        "Share this message with another phone.",
                        snapshot.qr,
                        formatRelativeTone("ready", "1 message packed"),
                      );
                    })
                    .catch((error: unknown) => {
                      noteStatus(
                        "danger",
                        error instanceof Error
                          ? error.message
                          : "Snapshot build failed",
                      );
                    });
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
