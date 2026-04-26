import { createMessage, type CreateMessageInput } from "./phase1";
import {
  applyPrivacy,
  normalizeIngressMessage,
  QUARANTINE_KEY,
  validateSchema,
} from "./phase2";
import { createSessionId } from "./phase3";
import { BloomFilter } from "./phase4";
import { buildSnapshot, decodeTransportPayload } from "./qr";
import {
  linkConflictVariant,
  rankStoredMessages,
  selectRelayMessages,
} from "./relay-engine";
import type { NexusRepository } from "./repository";
import { computeFields } from "./scoring";
import { nowUnixSeconds } from "./time";
import type { NexusMessage, NexusMessageWithComputed } from "./types";

export type PipelineMode =
  | "compose"
  | "qr_ingest"
  | "peer_send"
  | "peer_receive"
  | "qr_share";

export type PipelineStageStatus =
  | "success"
  | "skipped"
  | "warning"
  | "error";

export interface PipelineEvent {
  timestamp: number;
  component: NexusComponentName;
  status: PipelineStageStatus;
  detail: string;
}

export interface PipelineStageResult {
  component: NexusComponentName;
  status: PipelineStageStatus;
  summary: string;
}

export interface PipelineRun {
  id: string;
  mode: PipelineMode;
  status: "completed" | "partial" | "failed";
  summary: string;
  startedAt: number;
  completedAt: number;
  stages: PipelineStageResult[];
  events: PipelineEvent[];
}

export type NexusComponentName =
  | "Ingestion"
  | "Privacy"
  | "Relay Engine"
  | "Storage"
  | "QR Share";

export interface PipelineContext {
  mode: PipelineMode;
  repository: NexusRepository;
  sourceMessages?: NexusMessage[];
  draftInput?: CreateMessageInput;
  incomingMessage?: Partial<NexusMessage>;
  incomingMessages?: Partial<NexusMessage>[];
  qrPayload?: string;
  peerBloom?: BloomFilter;
  peerBloomBase64?: string;
  validatedMessage?: NexusMessage;
  candidateMessage?: NexusMessage;
  persistedMessage?: NexusMessageWithComputed;
  rankedMessages?: NexusMessageWithComputed[];
  selectedMessages?: NexusMessage[];
  snapshot?: { qr: string; count: number };
  quarantineCount?: number;
  duplicate?: NexusMessageWithComputed;
  mergeTarget?: NexusMessageWithComputed;
  receiveResults?: Array<{
    status: "stored" | "duplicate" | "expired" | "invalid" | "quarantined";
    messageId?: string;
    reason?: string;
  }>;
  sessionId?: string;
  terminal?: {
    status: "duplicate" | "expired" | "invalid" | "quarantined";
    reason: string;
  };
}

export interface NexusStage {
  name: NexusComponentName;
  run(context: PipelineContext): Promise<{
    context: PipelineContext;
    stage: PipelineStageResult;
    events?: PipelineEvent[];
  }>;
}

function makeEvent(
  component: NexusComponentName,
  status: PipelineStageStatus,
  detail: string,
): PipelineEvent {
  return {
    timestamp: Date.now(),
    component,
    status,
    detail,
  };
}

function terminalStage(
  component: NexusComponentName,
  context: PipelineContext,
): { context: PipelineContext; stage: PipelineStageResult } {
  return {
    context,
    stage: {
      component,
      status: "skipped",
      summary: context.terminal
        ? `Skipped after ${context.terminal.status}`
        : "Skipped",
    },
  };
}

async function getQuarantineCount(repository: NexusRepository): Promise<number> {
  const quarantine =
    (await repository.getSystemState<Partial<NexusMessage>[]>(QUARANTINE_KEY)) ??
    [];
  return quarantine.length;
}

export const IngestionStage: NexusStage = {
  name: "Ingestion",
  async run(context) {
    if (context.terminal) {
      return terminalStage(this.name, context);
    }

    if (context.mode === "compose") {
      if (!context.draftInput) {
        const next: PipelineContext = {
          ...context,
          terminal: { status: "invalid", reason: "Compose input missing." },
        };
        return {
          context: next,
          stage: {
            component: this.name,
            status: "error",
            summary: "Compose input missing.",
          },
          events: [makeEvent(this.name, "error", "Compose input missing.")],
        };
      }

      const message = await createMessage(context.draftInput);
      const duplicate = await context.repository.getById(message.id);
      if (duplicate) {
        const next: PipelineContext = {
          ...context,
          duplicate,
          persistedMessage: duplicate,
          terminal: { status: "duplicate", reason: "Duplicate local message." },
        };
        return {
          context: next,
          stage: {
            component: this.name,
            status: "warning",
            summary: `Duplicate detected for ${message.id}.`,
          },
          events: [
            makeEvent(this.name, "warning", `Duplicate local message ${message.id}.`),
          ],
        };
      }

      return {
        context: { ...context, validatedMessage: message },
        stage: {
          component: this.name,
          status: "success",
          summary: `Created draft ${message.id}.`,
        },
        events: [makeEvent(this.name, "success", `Created draft ${message.id}.`)],
      };
    }

    if (context.mode === "qr_ingest" && context.qrPayload) {
      try {
        const decoded = decodeTransportPayload(context.qrPayload);
        if (decoded.kind !== "snapshot") {
          const next: PipelineContext = {
            ...context,
            terminal: {
              status: "invalid",
              reason: "QR payload was not a snapshot bundle.",
            },
          };
          return {
            context: next,
            stage: {
              component: this.name,
              status: "error",
              summary: "Unsupported QR payload kind.",
            },
            events: [
              makeEvent(this.name, "error", "QR payload was not a snapshot bundle."),
            ],
          };
        }

        return {
          context: { ...context, incomingMessages: decoded.messages },
          stage: {
            component: this.name,
            status: "success",
            summary: `Decoded ${decoded.messages.length} snapshot messages.`,
          },
          events: [
            makeEvent(
              this.name,
              "success",
              `Decoded ${decoded.messages.length} snapshot messages.`,
            ),
          ],
        };
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "QR decode failed.";
        const next: PipelineContext = {
          ...context,
          terminal: {
            status: "invalid",
            reason,
          },
        };
        return {
          context: next,
          stage: {
            component: this.name,
            status: "error",
            summary: reason,
          },
          events: [makeEvent(this.name, "error", reason)],
        };
      }
    }

    if (context.mode === "peer_receive") {
      const raw = context.incomingMessage;
      if (!raw) {
        const next: PipelineContext = {
          ...context,
          terminal: { status: "invalid", reason: "Incoming message missing." },
        };
        return {
          context: next,
          stage: {
            component: this.name,
            status: "error",
            summary: "Incoming message missing.",
          },
          events: [makeEvent(this.name, "error", "Incoming message missing.")],
        };
      }

      if (raw.schema_version !== 1) {
        const existing =
          (await context.repository.getSystemState<Partial<NexusMessage>[]>(
            QUARANTINE_KEY,
          )) ?? [];
        await context.repository.setSystemState(QUARANTINE_KEY, [...existing, raw]);
        const next: PipelineContext = {
          ...context,
          quarantineCount: existing.length + 1,
          terminal: {
            status: "quarantined",
            reason: "Unsupported schema_version.",
          },
        };
        return {
          context: next,
          stage: {
            component: this.name,
            status: "warning",
            summary: "Unsupported schema quarantined.",
          },
          events: [
            makeEvent(this.name, "warning", "Unsupported schema_version quarantined."),
          ],
        };
      }

      const validationError = validateSchema(raw);
      if (validationError) {
        const next: PipelineContext = {
          ...context,
          terminal: { status: "invalid", reason: validationError },
        };
        return {
          context: next,
          stage: {
            component: this.name,
            status: "error",
            summary: validationError,
          },
          events: [makeEvent(this.name, "error", validationError)],
        };
      }

      const validated = raw as NexusMessage;
      const duplicate = await context.repository.getById(validated.id);
      if (duplicate) {
        const next: PipelineContext = {
          ...context,
          duplicate,
          persistedMessage: duplicate,
          terminal: { status: "duplicate", reason: "Incoming duplicate." },
        };
        return {
          context: next,
          stage: {
            component: this.name,
            status: "warning",
            summary: `Duplicate ${validated.id} skipped.`,
          },
          events: [makeEvent(this.name, "warning", `Duplicate ${validated.id}.`)],
        };
      }

      if (validated.ttl <= nowUnixSeconds()) {
        const next: PipelineContext = {
          ...context,
          terminal: { status: "expired", reason: "Incoming message expired." },
        };
        return {
          context: next,
          stage: {
            component: this.name,
            status: "warning",
            summary: `Expired ${validated.id} skipped.`,
          },
          events: [makeEvent(this.name, "warning", `Expired ${validated.id}.`)],
        };
      }

      return {
        context: { ...context, validatedMessage: validated },
        stage: {
          component: this.name,
          status: "success",
          summary: `Validated ${validated.id}.`,
        },
        events: [makeEvent(this.name, "success", `Validated ${validated.id}.`)],
      };
    }

    return {
      context,
      stage: {
        component: this.name,
        status: "skipped",
        summary: `No ingestion work for ${context.mode}.`,
      },
    };
  },
};

export const PrivacyStage: NexusStage = {
  name: "Privacy",
  async run(context) {
    if (context.terminal) {
      return terminalStage(this.name, context);
    }

    if (!context.validatedMessage) {
      return {
        context,
        stage: {
          component: this.name,
          status: "skipped",
          summary: "No validated message to sanitize.",
        },
      };
    }

    const candidate =
      context.mode === "compose"
        ? applyPrivacy(context.validatedMessage)
        : normalizeIngressMessage(context.validatedMessage);

    return {
      context: { ...context, candidateMessage: candidate },
      stage: {
        component: this.name,
        status: "success",
        summary: `Sanitized ${candidate.id} to hour-level metadata.`,
      },
      events: [
        makeEvent(
          this.name,
          "success",
          `Sanitized ${candidate.id} and removed precise relay metadata.`,
        ),
      ],
    };
  },
};

export const RelayEngineStage: NexusStage = {
  name: "Relay Engine",
  async run(context) {
    if (context.terminal && context.mode !== "peer_send" && context.mode !== "qr_share") {
      return terminalStage(this.name, context);
    }

    if (context.mode === "peer_send" || context.mode === "qr_share") {
      const rankedMessages =
        context.mode === "qr_share" && context.sourceMessages
          ? [...context.sourceMessages].map((message) => ({
              ...message,
              ...computeFields(message),
            }))
          : undefined;
      const relaySelection =
        context.mode === "qr_share" && context.sourceMessages
          ? { selectedMessages: context.sourceMessages }
          : await selectRelayMessages(
              context.repository,
              context.mode === "peer_send" ? context.peerBloom : undefined,
            );
      const { selectedMessages } = relaySelection;

      return {
        context: {
          ...context,
          rankedMessages: rankedMessages ?? (await rankStoredMessages(context.repository)),
          selectedMessages,
        },
        stage: {
          component: this.name,
          status: "success",
          summary:
            context.mode === "peer_send"
              ? `Selected ${selectedMessages.length} novel messages for this encounter.`
              : `Ranked ${selectedMessages.length} messages for snapshot sharing.`,
        },
        events: [
          makeEvent(
            this.name,
            "success",
            context.mode === "peer_send"
              ? `Bloom comparison found ${selectedMessages.length} novel relay candidates.`
              : `Ranked ${selectedMessages.length} messages for snapshot QR selection.`,
          ),
        ],
      };
    }

    if (!context.candidateMessage) {
      const rankedMessages = await rankStoredMessages(context.repository);
      return {
        context: { ...context, rankedMessages },
        stage: {
          component: this.name,
          status: "success",
          summary: `Ranked ${rankedMessages.length} stored messages.`,
        },
        events: [
          makeEvent(
            this.name,
            "success",
            `Computed relay scores for ${rankedMessages.length} stored messages.`,
          ),
        ],
      };
    }

    const mergeTarget = await linkConflictVariant(
      context.repository,
      context.candidateMessage,
    );

    return {
      context: { ...context, mergeTarget },
      stage: {
        component: this.name,
        status: "success",
        summary: mergeTarget
          ? `Stored conflict metadata for ${context.candidateMessage.id}.`
          : `Prepared relay metadata for ${context.candidateMessage.id}.`,
      },
      events: [
        makeEvent(
          this.name,
          mergeTarget ? "warning" : "success",
          mergeTarget
            ? `Linked ${context.candidateMessage.id} to related local record ${mergeTarget.id}.`
            : `Prepared ${context.candidateMessage.id} for relay scoring and storage.`,
        ),
      ],
    };
  },
};

export const StorageStage: NexusStage = {
  name: "Storage",
  async run(context) {
    if (context.terminal) {
      return terminalStage(this.name, context);
    }

    if (context.mode === "peer_send" || context.mode === "qr_share") {
      return {
        context: {
          ...context,
          quarantineCount: await getQuarantineCount(context.repository),
        },
        stage: {
          component: this.name,
          status: "success",
          summary: (await context.repository.isUsingMemoryStorage())
            ? "Using in-memory fallback storage."
            : "Persistent storage available.",
        },
        events: [
          makeEvent(
            this.name,
            "success",
            (await context.repository.isUsingMemoryStorage())
              ? "IndexedDB unavailable; memory fallback active."
              : "IndexedDB storage active with weight-based retention.",
          ),
        ],
      };
    }

    if (!context.candidateMessage) {
      return {
        context,
        stage: {
          component: this.name,
          status: "skipped",
          summary: "No candidate message to store.",
        },
      };
    }

    await context.repository.put(context.candidateMessage);
    const stored = await context.repository.getById(context.candidateMessage.id);

    return {
      context: {
        ...context,
        persistedMessage: stored
          ? { ...stored, ...computeFields(stored) }
          : stored,
        rankedMessages: await rankStoredMessages(context.repository),
        quarantineCount: await getQuarantineCount(context.repository),
      },
      stage: {
        component: this.name,
        status: "success",
        summary: `Stored ${context.candidateMessage.id}.`,
      },
      events: [makeEvent(this.name, "success", `Stored ${context.candidateMessage.id}.`)],
    };
  },
};

export const QRShareStage: NexusStage = {
  name: "QR Share",
  async run(context) {
    if (context.terminal) {
      return terminalStage(this.name, context);
    }

    if (context.mode === "qr_share") {
      const source = context.selectedMessages ?? (await context.repository.getAllRaw());
      const snapshot = buildSnapshot(source);
      return {
        context: { ...context, snapshot },
        stage: {
          component: this.name,
          status: "success",
          summary: `Built snapshot QR with ${snapshot.count} messages.`,
        },
        events: [
          makeEvent(
            this.name,
            "success",
            `Encoded snapshot bundle with ${snapshot.count} top relay messages.`,
          ),
        ],
      };
    }

    if (context.mode === "qr_ingest" && context.incomingMessages) {
      return {
        context,
        stage: {
          component: this.name,
          status: "success",
          summary: `Snapshot bundle ready with ${context.incomingMessages.length} inbound messages.`,
        },
        events: [
          makeEvent(
            this.name,
            "success",
            `Decoded snapshot bundle with ${context.incomingMessages.length} messages.`,
          ),
        ],
      };
    }

    return {
      context,
      stage: {
        component: this.name,
        status: "skipped",
        summary: `QR sharing not used for ${context.mode}.`,
      },
    };
  },
};

const ALL_STAGES: NexusStage[] = [
  IngestionStage,
  PrivacyStage,
  RelayEngineStage,
  StorageStage,
  QRShareStage,
];

async function runPipeline(
  context: PipelineContext,
  stages = ALL_STAGES,
): Promise<{ run: PipelineRun; context: PipelineContext }> {
  const startedAt = Date.now();
  let current = context;
  const stageResults: PipelineStageResult[] = [];
  const events: PipelineEvent[] = [];

  for (const stage of stages) {
    const result = await stage.run(current);
    current = result.context;
    stageResults.push(result.stage);
    if (result.events?.length) {
      events.push(...result.events);
    }
  }

  const status = current.terminal
    ? current.terminal.status === "invalid"
      ? "failed"
      : "partial"
    : "completed";

  const summary =
    current.terminal?.reason ??
    (current.snapshot
      ? `Snapshot ready with ${current.snapshot.count} messages.`
      : current.persistedMessage
        ? `Stored ${current.persistedMessage.id}.`
        : current.selectedMessages
          ? `Selected ${current.selectedMessages.length} relay messages.`
          : current.receiveResults
            ? `Processed ${current.receiveResults.length} inbound messages.`
            : "Pipeline completed.");

  return {
    context: current,
    run: {
      id: createSessionId(),
      mode: context.mode,
      status,
      summary,
      startedAt,
      completedAt: Date.now(),
      stages: stageResults,
      events,
    },
  };
}

export async function runComposePipeline(
  repository: NexusRepository,
  draftInput: CreateMessageInput,
): Promise<{ run: PipelineRun; message?: NexusMessageWithComputed }> {
  const { run, context } = await runPipeline({
    mode: "compose",
    repository,
    draftInput,
  });

  return { run, message: context.persistedMessage ?? context.duplicate };
}

export async function runSnapshotSharePipeline(
  repository: NexusRepository,
  sourceMessages?: NexusMessage[],
): Promise<{ run: PipelineRun; snapshot?: { qr: string; count: number } }> {
  const { run, context } = await runPipeline({
    mode: "qr_share",
    repository,
    sourceMessages,
  });

  return { run, snapshot: context.snapshot };
}

export async function runPeerSendSelectionPipeline(
  repository: NexusRepository,
  peerBloomBase64: string,
): Promise<{ run: PipelineRun; messages: NexusMessage[] }> {
  const peerBloom = BloomFilter.fromBase64(peerBloomBase64);
  const { run, context } = await runPipeline({
    mode: "peer_send",
    repository,
    peerBloom,
    peerBloomBase64,
  });

  return { run, messages: context.selectedMessages ?? [] };
}

export async function runPeerReceivePipeline(
  repository: NexusRepository,
  incomingMessage: Partial<NexusMessage>,
): Promise<{
  run: PipelineRun;
  result: "stored" | "duplicate" | "expired" | "invalid" | "quarantined";
  message?: NexusMessageWithComputed;
}> {
  const { run, context } = await runPipeline({
    mode: "peer_receive",
    repository,
    incomingMessage,
  });

  const result = context.terminal?.status ?? "stored";
  return {
    run,
    result,
    message: context.persistedMessage ?? context.duplicate,
  };
}

export async function runSnapshotIngressPipeline(
  repository: NexusRepository,
  qrPayload: string,
): Promise<{
  run: PipelineRun;
  stored: number;
  results: Array<{
    status: "stored" | "duplicate" | "expired" | "invalid" | "quarantined";
    messageId?: string;
    reason?: string;
  }>;
}> {
  const decode = await runPipeline({
    mode: "qr_ingest",
    repository,
    qrPayload,
  });

  const results: Array<{
    status: "stored" | "duplicate" | "expired" | "invalid" | "quarantined";
    messageId?: string;
    reason?: string;
  }> = [];
  let stored = 0;
  const stages = [...decode.run.stages];
  const events = [...decode.run.events];

  if (!decode.context.incomingMessages || decode.context.terminal) {
    return {
      run: {
        ...decode.run,
        summary: decode.run.summary,
      },
      stored,
      results,
    };
  }

  for (const message of decode.context.incomingMessages) {
    const received = await runPeerReceivePipeline(repository, message);
    stages.push(...received.run.stages);
    events.push(...received.run.events);
    if (received.result === "stored") {
      stored += 1;
    }
    results.push({
      status: received.result,
      messageId: received.message?.id ?? ("id" in message ? message.id : undefined),
      reason: received.run.summary,
    });
  }

  return {
    run: {
      id: decode.run.id,
      mode: "qr_ingest",
      status:
        stored > 0 ? "completed" : decode.run.status === "failed" ? "failed" : "partial",
      summary: `Snapshot ingest processed ${results.length} messages and stored ${stored}.`,
      startedAt: decode.run.startedAt,
      completedAt: Date.now(),
      stages,
      events,
    },
    stored,
    results,
  };
}
