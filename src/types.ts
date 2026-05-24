export type QueryRoute = "KB_ONLY" | "KB_PLUS_LLM" | "LLM_ONLY";

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export type KnowledgeSourceType =
  | "FEISHU_CHAT"
  | "MARKDOWN"
  | "TUTORIAL"
  | "NOTE"
  | "ATTACHMENT";

export type KbBridgePluginConfig = {
  baseUrl: string;
  sharedSecret: string;
  requestTimeoutMs: number;
  query: {
    enabled: boolean;
    injectEmptyKbResponses: boolean;
  };
  ingest: {
    autoCandidateEnabled: boolean;
    manualCommandPrefixes: string[];
    manualSourceType: KnowledgeSourceType;
    candidateSourceType: KnowledgeSourceType;
    skipSelfMessages: boolean;
    statusPolling: {
      enabled: boolean;
      intervalMs: number;
      maxDurationMs: number;
      maxConsecutiveErrors: number;
    };
  };
  debug: boolean;
};

export type QueryRequest = {
  requestId: string;
  userId: string;
  chatId?: string;
  sessionKey?: string;
  messageId?: string;
  question: string;
  channelType?: string;
  isGroup: boolean;
  flags?: {
    strictKbOnly?: boolean;
    needCitation?: boolean;
  };
};

export type EvidenceSource = {
  dataset?: string;
  title?: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

export type QueryResponse = {
  requestId: string;
  route: QueryRoute;
  allowModelSupplement: boolean;
  sources: EvidenceSource[];
  instructions: string[];
  retrievalQuality?: {
    hitCount: number;
    confidence: Confidence;
    truncated: boolean;
    originalHitCount?: number;
  };
};

export type IngestAttachment = {
  name?: string;
  url?: string;
  mimeType?: string;
};

export type IngestRequest = {
  requestId: string;
  userId: string;
  chatId?: string;
  messageIds?: string[];
  content: string;
  sourceType: KnowledgeSourceType;
  attachments?: IngestAttachment[];
  force?: boolean;
};

export type IngestResponse = {
  requestId: string;
  taskId: number;
  status: string;
  duplicate: boolean;
};

export type CandidateRequest = Omit<IngestRequest, "force">;

export type CandidateResponse = {
  requestId: string;
  worthy: boolean;
  reason: string;
  taskId?: number;
  duplicate?: boolean;
};

export type IngestStatusResponse = {
  taskId: number;
  requestId?: string;
  status: string;
  reviewStatus?: string;
  rawObjectKey?: string | null;
  processedGuideKey?: string | null;
  processedQaKey?: string | null;
  errorMessage?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type MessageEnvelope = {
  text: string;
  channelType?: string;
  userId: string;
  chatId?: string;
  sessionKey?: string;
  messageId?: string;
  delivery?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  isGroup?: boolean;
  attachments: IngestAttachment[];
  isSelfMessage: boolean;
  replyText?: string;
};

export type ManualIngestCommand = {
  content: string;
  force: boolean;
};
