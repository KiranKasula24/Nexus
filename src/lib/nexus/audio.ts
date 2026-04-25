import type { MessageType, NexusMessage } from "./types";

type CaptureMode = "speech" | "manual";

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  0?: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  results: SpeechRecognitionResultLike[];
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

interface QueuedBroadcast {
  message: NexusMessage;
  resolve: () => void;
  reject: (error: Error) => void;
}

let activeBroadcast: Promise<void> | null = null;
const broadcastQueue: QueuedBroadcast[] = [];

function toSpokenText(message: Pick<NexusMessage, "payload" | "type">): string {
  return message.type === "alert"
    ? `URGENT ALERT. ${message.payload}`
    : message.payload;
}

function speakMessage(
  message: Pick<NexusMessage, "payload" | "type">,
): Promise<void> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return Promise.reject(new Error("Speech synthesis is unavailable."));
  }

  return new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(toSpokenText(message));
    utterance.rate = 0.9;
    utterance.volume = 1.0;
    utterance.lang = "en-IN";
    utterance.onend = () => resolve();
    utterance.onerror = () => reject(new Error("Speech synthesis failed."));
    window.speechSynthesis.speak(utterance);
  });
}

async function drainBroadcastQueue(): Promise<void> {
  if (activeBroadcast) return activeBroadcast;

  activeBroadcast = (async () => {
    while (broadcastQueue.length > 0) {
      const next = broadcastQueue.shift();
      if (!next) break;

      try {
        await speakMessage(next.message);
        next.resolve();
      } catch (error) {
        next.reject(
          error instanceof Error ? error : new Error("Broadcast failed."),
        );
      }
    }
  })();

  try {
    await activeBroadcast;
  } finally {
    activeBroadcast = null;
  }
}

export async function broadcastMessage(
  message: Pick<NexusMessage, "payload" | "type">,
): Promise<void> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    throw new Error("Speech synthesis is unavailable.");
  }

  window.speechSynthesis.cancel();
  broadcastQueue.length = 0;
  activeBroadcast = null;
  await speakMessage(message);
}

export function enqueueBroadcastMessage(message: NexusMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    const entry: QueuedBroadcast = { message, resolve, reject };

    if (message.type === "alert") {
      const firstNonAlert = broadcastQueue.findIndex(
        (queued) => queued.message.type !== "alert",
      );

      if (firstNonAlert === -1) {
        broadcastQueue.push(entry);
      } else {
        broadcastQueue.splice(firstNonAlert, 0, entry);
      }
    } else {
      broadcastQueue.push(entry);
    }

    void drainBroadcastQueue();
  });
}

function getRecognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;

  const speechWindow = window as Window & {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };

  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

export function supportsSpeechCapture(): boolean {
  return Boolean(getRecognitionCtor());
}

export async function startCapture(timeoutMs = 15_000): Promise<{
  transcript: string;
  mode: CaptureMode;
}> {
  const Recognition = getRecognitionCtor();
  if (!Recognition) {
    throw new Error("manual_fallback_required");
  }

  return new Promise((resolve, reject) => {
    const recognition = new Recognition();
    const timer = window.setTimeout(() => {
      recognition.stop();
      reject(new Error("capture_timeout"));
    }, timeoutMs);

    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.lang = "en-IN";

    recognition.onresult = (event) => {
      window.clearTimeout(timer);
      const transcript = event.results[0]?.[0]?.transcript?.trim();

      if (!transcript) {
        reject(new Error("empty_transcript"));
        return;
      }

      resolve({ transcript, mode: "speech" });
    };

    recognition.onerror = (event) => {
      window.clearTimeout(timer);

      if (event.error === "network" || event.error === "service-not-allowed") {
        reject(new Error("manual_fallback_required"));
        return;
      }

      reject(new Error(event.error));
    };

    recognition.onend = () => {
      window.clearTimeout(timer);
    };

    recognition.start();
  });
}

export function buildAudioDraftMessage(
  payload: string,
  priority: 1 | 2 | 3 | 4 | 5,
): Pick<NexusMessage, "payload" | "priority" | "type" | "confidence"> {
  return {
    payload,
    priority,
    type: "audio" as MessageType,
    confidence: "low",
  };
}
