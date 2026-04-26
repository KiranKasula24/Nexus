import { classifyMessage } from "./classifier";
import { createMessage, type CreateMessageInput } from "./phase1";
import {
  applyPrivacy,
  normalizeIngressMessage,
  QUARANTINE_KEY,
  validateSchema,
} from "./phase2";
import { createSessionId } from "./phase3";
import { BloomFilter } from "./phase4";
import { type NexusUserProfile } from "./profile";
import { buildSnapshot, decodeTransportPayload } from "./qr";
import {
  applyRelayGate,
  computeBloomCandidates,
  rankRelayCandidates,
  rankStoredMessages,
} from "./relay-engine";
import type { NexusRepository } from "./repository";
import { computeFields } from "./scoring";
import { shouldRelayBlocked } from "./sentinel";
import { nowUnixSeconds } from "./time";
import type { NexusMessage, NexusMessageWithComputed } from "./types";

export type PipelineMode =
  | "compose"
  | "qr_ingest"
  | "peer_send"
  | "peer_receive"
  | "qr_share";

export type PipelineStageStatus = "success" | "skipped" | "warning" | "error";

export interface PipelineEvent {
  timestamp: number;
  runId?: string;
  mode?: PipelineMode;
  component: NexusComponentName;
  status: PipelineStageStatus;
  detail: string;
  inputCount?: number;
  outputCount?: number;
  matchedTopics?: string[];
  droppedForFloor?: number;
  droppedForPreference?: number;
  sentinelBlocked?: boolean;
  messageId?: string;
  inferredTopics?: string[];
  matchedKeywords?: string[];
}

export interface PipelineStageResult {
  component: NexusComponentName;
  status: PipelineStageStatus;
  summary: string;
  inputCount?: number;
  outputCount?: number;
  matchedTopics?: string[];
  droppedForFloor?: number;
  droppedForPreference?: number;
  sentinelBlocked?: boolean;
  messageId?: string;
  inferredTopics?: string[];
  matchedKeywords?: string[];
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
  | "Classifier"
  | "Bloom Filter"
  | "Prioritization Agent"
  | "Relay Gate"
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
  localProfile?: NexusUserProfile;
  peerProfile?: NexusUserProfile;
  validatedMessage?: NexusMessage;
  candidateMessage?: NexusMessage;
  persistedMessage?: NexusMessageWithComputed;
  rankedMessages?: NexusMessageWithComputed[];
  relayCandidates?: NexusMessage[];
  rankedRelayMessages?: NexusMessageWithComputed[];
  selectedMessages?: NexusMessage[];
  classifierTopics?: string[];
  classifierInferredTopics?: string[];
  classifierMatchedKeywords?: string[];
  relayGateMatchedTopics?: string[];
  relayGateDroppedForFloor?: number;
  relayGateDroppedForPreference?: number;
  relayBlocked?: boolean;
  relayBlockedReason?: string;
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
  peerSendOptions?: {
    priorityFloor?: 1 | 2 | 3 | 4 | 5;
    excludeIds?: string[];
    limit?: number;
  };
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
  extras: Partial<PipelineEvent> = {},
): PipelineEvent {
  return {
    timestamp: Date.now(),
    component,
    status,
    detail,
    ...extras,
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

async function getQuarantineCount(
  repository: NexusRepository,
): Promise<number> {
  const quarantine =
    (await repository.getSystemState<Partial<NexusMessage>[]>(
      QUARANTINE_KEY,
    )) ?? [];
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
            makeEvent(
              this.name,
              "warning",
              `Duplicate local message ${message.id}.`,
            ),
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
        events: [
          makeEvent(this.name, "success", `Created draft ${message.id}.`),
        ],
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
              makeEvent(
                this.name,
                "error",
                "QR payload was not a snapshot bundle.",
              ),
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
        await context.repository.setSystemState(QUARANTINE_KEY, [
          ...existing,
          raw,
        ]);
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
            makeEvent(
              this.name,
              "warning",
              "Unsupported schema_version quarantined.",
            ),
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
          events: [
            makeEvent(this.name, "warning", `Duplicate ${validated.id}.`),
          ],
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

export const ClassifierStage: NexusStage = {
  name: "Classifier",
  async run(context) {
    if (context.terminal) {
      return terminalStage(this.name, context);
    }

    if (!context.candidateMessage) {
      return {
        context,
        stage: {
          component: this.name,
          status: "skipped",
          summary: "No candidate message to classify.",
        },
      };
    }

    const classified = classifyMessage(context.candidateMessage);
    const candidateMessage: NexusMessage = {
      ...context.candidateMessage,
      crucial_topics: classified.topics,
    };

    return {
      context: {
        ...context,
        candidateMessage,
        classifierTopics: classified.topics,
        classifierInferredTopics: classified.inferredTopics,
        classifierMatchedKeywords: classified.matchedKeywords,
      },
      stage: {
        component: this.name,
        status: "success",
        summary:
          classified.inferredTopics.length > 0
            ? `Tagged ${candidateMessage.id} as ${classified.topics.join(", ")}.`
            : `Normalized topics for ${candidateMessage.id}.`,
        messageId: candidateMessage.id,
        outputCount: classified.topics.length,
        inferredTopics: classified.inferredTopics,
        matchedKeywords: classified.matchedKeywords,
      },
      events: [
        makeEvent(
          this.name,
          "success",
          classified.inferredTopics.length > 0
            ? `Tagged ${candidateMessage.id} with ${classified.topics.join(", ")}.`
            : `No new classifier tags for ${candidateMessage.id}; normalized existing topics.`,
          {
            messageId: candidateMessage.id,
            outputCount: classified.topics.length,
            inferredTopics: classified.inferredTopics,
            matchedKeywords: classified.matchedKeywords,
          },
        ),
      ],
    };
  },
};

export const BloomFilterStage: NexusStage = {
  name: "Bloom Filter",
  async run(context) {
    if (context.terminal) {
      return terminalStage(this.name, context);
    }

    if (context.mode !== "peer_send") {
      return {
        context,
        stage: {
          component: this.name,
          status: "skipped",
          summary: `Bloom filter not used for ${context.mode}.`,
        },
      };
    }

    const rawMessages = await context.repository.getAllRaw();
    const candidates = context.peerBloom
      ? computeBloomCandidates(rawMessages, context.peerBloom)
      : rawMessages;

    return {
      context: { ...context, relayCandidates: candidates },
      stage: {
        component: this.name,
        status: "success",
        summary: `Diffed ${rawMessages.length} local IDs to ${candidates.length} novel relay candidates.`,
        inputCount: rawMessages.length,
        outputCount: candidates.length,
      },
      events: [
        makeEvent(
          this.name,
          "success",
          `Diffed ${rawMessages.length} local IDs against peer bloom; ${candidates.length} candidates remain.`,
          {
            inputCount: rawMessages.length,
            outputCount: candidates.length,
          },
        ),
      ],
    };
  },
};

export const PrioritizationAgentStage: NexusStage = {
  name: "Prioritization Agent",
  async run(context) {
    if (context.terminal) {
      return terminalStage(this.name, context);
    }

    if (context.mode === "peer_send") {
      const relayCandidates = context.relayCandidates ?? [];
      const rankedRelayMessages = rankRelayCandidates(relayCandidates);
      return {
        context: {
          ...context,
          rankedRelayMessages,
        },
        stage: {
          component: this.name,
          status: "success",
          summary: `Ranked ${rankedRelayMessages.length} relay candidates for this encounter.`,
          inputCount: relayCandidates.length,
          outputCount: rankedRelayMessages.length,
        },
        events: [
          makeEvent(
            this.name,
            "success",
            `Ranked ${rankedRelayMessages.length} relay candidates by score.`,
            {
              inputCount: relayCandidates.length,
              outputCount: rankedRelayMessages.length,
            },
          ),
        ],
      };
    }

    if (context.mode === "qr_share") {
      const sourceMessages = context.sourceMessages ?? (await context.repository.getAllRaw());
      const rankedRelayMessages = rankRelayCandidates(sourceMessages);
      return {
        context: {
          ...context,
          relayCandidates: sourceMessages,
          rankedRelayMessages,
        },
        stage: {
          component: this.name,
          status: "success",
          summary: `Ranked ${rankedRelayMessages.length} messages for snapshot relay.`,
          inputCount: sourceMessages.length,
          outputCount: rankedRelayMessages.length,
        },
        events: [
          makeEvent(
            this.name,
            "success",
            `Ranked ${rankedRelayMessages.length} snapshot candidates by score.`,
            {
              inputCount: sourceMessages.length,
              outputCount: rankedRelayMessages.length,
            },
          ),
        ],
      };
    }

    const rankedMessages = await rankStoredMessages(context.repository);
    return {
      context: { ...context, rankedMessages },
      stage: {
        component: this.name,
        status: "success",
        summary: `Ranked ${rankedMessages.length} stored messages.`,
        outputCount: rankedMessages.length,
      },
      events: [
        makeEvent(
          this.name,
          "success",
          `Ranked ${rankedMessages.length} stored messages for relay readiness.`,
          {
            outputCount: rankedMessages.length,
          },
        ),
      ],
    };
  },
};

export const RelayGateStage: NexusStage = {
  name: "Relay Gate",
  async run(context) {
    if (context.terminal) {
      return terminalStage(this.name, context);
    }

    if (context.mode !== "peer_send" && context.mode !== "qr_share") {
      return {
        context,
        stage: {
          component: this.name,
          status: "skipped",
          summary: `Relay gate not used for ${context.mode}.`,
        },
      };
    }

    const rankedRelayMessages = context.rankedRelayMessages ?? [];
    const relayBlocked = await shouldRelayBlocked(context.repository);
    const peerSendOptions =
      context.mode === "peer_send" ? context.peerSendOptions : undefined;
    const gateResult = applyRelayGate(
      rankedRelayMessages,
      context.mode === "peer_send" ? context.peerProfile : context.localProfile,
      {
        priorityFloor: peerSendOptions?.priorityFloor ?? 3,
        blocked: relayBlocked,
        blockedReason: "blocked by Sentinel - device locked",
      },
    );

    const excluded = new Set(peerSendOptions?.excludeIds ?? []);
    const filteredMessages =
      excluded.size === 0
        ? gateResult.selectedMessages
        : gateResult.selectedMessages.filter((message) => !excluded.has(message.id));
    const selectedMessages =
      peerSendOptions?.limit !== undefined
        ? filteredMessages.slice(0, peerSendOptions.limit)
        : filteredMessages;

    const nextContext: PipelineContext = {
      ...context,
      selectedMessages,
      relayGateMatchedTopics: gateResult.matchedTopics,
      relayGateDroppedForFloor: gateResult.droppedForFloor,
      relayGateDroppedForPreference: gateResult.droppedForPreference,
      relayBlocked: gateResult.sentinelBlocked,
      relayBlockedReason: gateResult.reason,
    };

    if (gateResult.sentinelBlocked) {
      return {
        context: nextContext,
        stage: {
          component: this.name,
          status: "warning",
          summary: "Blocked by Sentinel - device locked.",
          inputCount: rankedRelayMessages.length,
          outputCount: 0,
          sentinelBlocked: true,
        },
        events: [
          makeEvent(
            this.name,
            "warning",
            "blocked by Sentinel - device locked",
            {
              inputCount: rankedRelayMessages.length,
              outputCount: 0,
              sentinelBlocked: true,
            },
          ),
        ],
      };
    }

    return {
      context: nextContext,
      stage: {
        component: this.name,
        status: "success",
        summary: `Passed ${selectedMessages.length} of ${rankedRelayMessages.length} messages through Relay Gate.`,
        inputCount: rankedRelayMessages.length,
        outputCount: selectedMessages.length,
        matchedTopics: gateResult.matchedTopics,
        droppedForFloor: gateResult.droppedForFloor,
        droppedForPreference: gateResult.droppedForPreference,
      },
      events: [
        makeEvent(
          this.name,
          selectedMessages.length > 0 ? "success" : "warning",
          `Relay Gate passed ${selectedMessages.length}/${rankedRelayMessages.length} messages.`,
          {
            inputCount: rankedRelayMessages.length,
            outputCount: selectedMessages.length,
            matchedTopics: gateResult.matchedTopics,
            droppedForFloor: gateResult.droppedForFloor,
            droppedForPreference: gateResult.droppedForPreference,
          },
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

    if (context.candidateMessage.supersedes) {
      const oldMessage = await context.repository.getById(
        context.candidateMessage.supersedes,
      );
      if (oldMessage) {
        await context.repository.put({
          id: oldMessage.id,
          type: oldMessage.type,
          priority: oldMessage.priority,
          ttl: oldMessage.ttl,
          created_at: oldMessage.created_at,
          hop_count: oldMessage.hop_count,
          weight: oldMessage.weight,
          payload: oldMessage.payload,
          media_data_url: oldMessage.media_data_url,
          crucial_topics: oldMessage.crucial_topics,
          confidence: oldMessage.confidence,
          supersedes: oldMessage.supersedes,
          superseded_by: context.candidateMessage.id,
          schema_version: oldMessage.schema_version,
        });
      }
    }

    await context.repository.put(context.candidateMessage);
    const stored = await context.repository.getById(
      context.candidateMessage.id,
    );

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
      events: [
        makeEvent(
          this.name,
          "success",
          `Stored ${context.candidateMessage.id}.`,
        ),
      ],
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
      const source = context.selectedMessages ?? [];
      if (source.length === 0) {
        return {
          context,
          stage: {
            component: this.name,
            status: context.relayBlocked ? "warning" : "skipped",
            summary: context.relayBlocked
              ? "Snapshot share blocked by Sentinel."
              : "No messages passed Relay Gate for snapshot sharing.",
            inputCount: 0,
            outputCount: 0,
            sentinelBlocked: context.relayBlocked,
          },
          events: [
            makeEvent(
              this.name,
              context.relayBlocked ? "warning" : "skipped",
              context.relayBlocked
                ? "Snapshot share blocked by Sentinel."
                : "No messages passed Relay Gate for snapshot sharing.",
              {
                inputCount: 0,
                outputCount: 0,
                sentinelBlocked: context.relayBlocked,
              },
            ),
          ],
        };
      }

      const snapshot = buildSnapshot(source);
      return {
        context: { ...context, snapshot },
        stage: {
          component: this.name,
          status: "success",
          summary: `Built snapshot QR with ${snapshot.count} messages.`,
          inputCount: source.length,
          outputCount: snapshot.count,
        },
        events: [
          makeEvent(
            this.name,
            "success",
            `Encoded snapshot bundle with ${snapshot.count} top relay messages.`,
            {
              inputCount: source.length,
              outputCount: snapshot.count,
            },
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

const PIPELINE_STAGES: Record<PipelineMode, NexusStage[]> = {
  compose: [
    IngestionStage,
    PrivacyStage,
    ClassifierStage,
    StorageStage,
    PrioritizationAgentStage,
  ],
  peer_receive: [
    IngestionStage,
    PrivacyStage,
    ClassifierStage,
    StorageStage,
    PrioritizationAgentStage,
  ],
  peer_send: [
    BloomFilterStage,
    PrioritizationAgentStage,
    RelayGateStage,
    StorageStage,
  ],
  qr_share: [
    PrioritizationAgentStage,
    RelayGateStage,
    QRShareStage,
    StorageStage,
  ],
  qr_ingest: [IngestionStage, QRShareStage],
};

async function runPipeline(
  context: PipelineContext,
  stages = PIPELINE_STAGES[context.mode],
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
    : current.relayBlocked
      ? "partial"
    : "completed";

  const summary =
    current.terminal?.reason ??
    current.relayBlockedReason ??
    (context.mode === "qr_share" &&
    !current.snapshot &&
    current.selectedMessages &&
    current.selectedMessages.length === 0
      ? "No messages passed Relay Gate for snapshot sharing."
      : undefined) ??
    (current.snapshot
      ? `Snapshot ready with ${current.snapshot.count} messages.`
      : current.persistedMessage
        ? `Stored ${current.persistedMessage.id}.`
        : current.selectedMessages
          ? `Selected ${current.selectedMessages.length} relay messages.`
      : current.receiveResults
            ? `Processed ${current.receiveResults.length} inbound messages.`
            : "Pipeline completed.");

  const runId = createSessionId();

  return {
    context: current,
    run: {
      id: runId,
      mode: context.mode,
      status,
      summary,
      startedAt,
      completedAt: Date.now(),
      stages: stageResults,
      events: events.map((event) => ({
        ...event,
        runId,
        mode: context.mode,
      })),
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
  localProfile?: NexusUserProfile,
): Promise<{ run: PipelineRun; snapshot?: { qr: string; count: number } }> {
  const { run, context } = await runPipeline({
    mode: "qr_share",
    repository,
    sourceMessages,
    localProfile,
  });

  return { run, snapshot: context.snapshot };
}

export async function runPeerSendSelectionPipeline(
  repository: NexusRepository,
  peerBloomBase64: string,
  peerProfile?: NexusUserProfile,
  options?: {
    priorityFloor?: 1 | 2 | 3 | 4 | 5;
    excludeIds?: string[];
    limit?: number;
  },
): Promise<{ run: PipelineRun; messages: NexusMessage[] }> {
  const peerBloom = BloomFilter.fromBase64(peerBloomBase64);
  const { run, context } = await runPipeline({
    mode: "peer_send",
    repository,
    peerBloom,
    peerBloomBase64,
    peerProfile,
    peerSendOptions: options,
  });

  return { run, messages: context.selectedMessages ?? [] };
}

function aggregateStageStatus(
  statuses: PipelineStageStatus[],
): PipelineStageStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("warning")) return "warning";
  if (statuses.includes("success")) return "success";
  return "skipped";
}

function aggregatePeerSendRuns(
  runs: PipelineRun[],
  totalMessages: number,
): PipelineRun {
  const stageOrder = PIPELINE_STAGES.peer_send.map((stage) => stage.name);
  const firstRun = runs[0];
  const lastRun = runs[runs.length - 1];

  return {
    id: createSessionId(),
    mode: "peer_send",
    status: runs.some((run) => run.status === "failed")
      ? "failed"
      : runs.some((run) => run.status === "partial")
        ? "partial"
        : "completed",
    summary:
      totalMessages > 0
        ? `Selected ${totalMessages} relay messages across ${runs.length} priority passes.`
        : lastRun?.summary ?? "No relay messages selected.",
    startedAt: firstRun?.startedAt ?? Date.now(),
    completedAt: lastRun?.completedAt ?? Date.now(),
    stages: stageOrder.map((component) => {
      const matching = runs
        .flatMap((run) => run.stages)
        .filter((stage) => stage.component === component);
      const lastMatching = matching[matching.length - 1];
      const matchedTopics = [
        ...new Set(matching.flatMap((stage) => stage.matchedTopics ?? [])),
      ];
      const aggregateInputCount =
        component === "Relay Gate"
          ? lastMatching?.inputCount ?? 0
          : Math.max(...matching.map((stage) => stage.inputCount ?? 0), 0);
      const aggregateOutputCount =
        component === "Relay Gate"
          ? totalMessages
          : Math.max(...matching.map((stage) => stage.outputCount ?? 0), 0);

      return {
        component,
        status: aggregateStageStatus(matching.map((stage) => stage.status)),
        summary:
          component === "Relay Gate"
            ? `Passed ${matching.reduce(
                (sum, stage) => sum + (stage.outputCount ?? 0),
                0,
              )} messages across ${runs.length} priority passes.`
            : lastMatching?.summary ?? `${component} aggregated.`,
        inputCount: aggregateInputCount,
        outputCount: aggregateOutputCount,
        matchedTopics,
        droppedForFloor: lastMatching?.droppedForFloor ?? 0,
        droppedForPreference: lastMatching?.droppedForPreference ?? 0,
        sentinelBlocked: matching.some((stage) => stage.sentinelBlocked),
      } satisfies PipelineStageResult;
    }),
    events: runs.flatMap((run) => run.events),
  };
}

export async function runPeerSendDrainPipeline(
  repository: NexusRepository,
  peerBloomBase64: string,
  peerProfile?: NexusUserProfile,
  options?: {
    excludeIds?: string[];
    limitPerPass?: number;
  },
): Promise<{ run: PipelineRun; messages: NexusMessage[] }> {
  const priorityPasses: Array<1 | 2 | 3 | 4 | 5> = [5, 4, 3, 2, 1];
  const sentIds = new Set(options?.excludeIds ?? []);
  const queued: NexusMessage[] = [];
  const runs: PipelineRun[] = [];

  for (const priorityFloor of priorityPasses) {
    const result = await runPeerSendSelectionPipeline(
      repository,
      peerBloomBase64,
      peerProfile,
      {
        priorityFloor,
        excludeIds: [...sentIds],
        limit: options?.limitPerPass,
      },
    );
    runs.push(result.run);

    for (const message of result.messages) {
      if (sentIds.has(message.id)) continue;
      sentIds.add(message.id);
      queued.push(message);
    }

    if (result.run.stages.some((stage) => stage.sentinelBlocked)) {
      break;
    }
  }

  return {
    run: aggregatePeerSendRuns(runs, queued.length),
    messages: queued,
  };
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
      messageId:
        received.message?.id ?? ("id" in message ? message.id : undefined),
      reason: received.run.summary,
    });
  }

  return {
    run: {
      id: decode.run.id,
      mode: "qr_ingest",
      status:
        stored > 0
          ? "completed"
          : decode.run.status === "failed"
            ? "failed"
            : "partial",
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
