import type {
  KbBridgePluginConfig,
  KnowledgeSourceType,
} from "./types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8111";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MANUAL_PREFIXES = ["#入库", "#kb add", "/kb add", "/kb-add"];
const DEFAULT_STATUS_POLL_INTERVAL_MS = 5000;
const DEFAULT_STATUS_POLL_MAX_DURATION_MS = 15 * 60 * 1000;
const DEFAULT_STATUS_POLL_MAX_ERRORS = 3;
const DEFAULT_FILE_COMMANDS = ["入库文件", "#入库文件", "/kb-file"];
const DEFAULT_FILE_CANCEL_COMMANDS = ["取消入库文件", "取消文件入库", "/kb-file-cancel"];

export function resolveConfig(input: unknown): KbBridgePluginConfig {
  const raw = isRecord(input) ? input : {};
  const query = isRecord(raw.query) ? raw.query : {};
  const ingest = isRecord(raw.ingest) ? raw.ingest : {};
  const statusPolling = isRecord(ingest.statusPolling)
    ? ingest.statusPolling
    : {};

  return {
    baseUrl: readString(raw.baseUrl, DEFAULT_BASE_URL).replace(/\/+$/, ""),
    sharedSecret: readString(raw.sharedSecret, ""),
    requestTimeoutMs: readNumber(raw.requestTimeoutMs, DEFAULT_TIMEOUT_MS),
    query: {
      enabled: readBoolean(query.enabled, true),
      injectEmptyKbResponses: readBoolean(query.injectEmptyKbResponses, false),
    },
    ingest: {
      autoCandidateEnabled: readBoolean(ingest.autoCandidateEnabled, false),
      manualCommandPrefixes: readStringArray(
        ingest.manualCommandPrefixes,
        DEFAULT_MANUAL_PREFIXES,
      ),
      manualSourceType: readSourceType(ingest.manualSourceType, "FEISHU_CHAT"),
      candidateSourceType: readSourceType(
        ingest.candidateSourceType,
        "FEISHU_CHAT",
      ),
      skipSelfMessages: readBoolean(ingest.skipSelfMessages, true),
      fileCommandPrefixes: readStringArray(ingest.fileCommandPrefixes, DEFAULT_FILE_COMMANDS),
      fileCancelCommands: readStringArray(ingest.fileCancelCommands, DEFAULT_FILE_CANCEL_COMMANDS),
      fileIntentTtlMs: readNumber(ingest.fileIntentTtlMs, 120_000),
      mediaRoot: typeof ingest.mediaRoot === "string" ? ingest.mediaRoot : undefined,
      statusPolling: {
        enabled: readBoolean(statusPolling.enabled, true),
        intervalMs: readNumber(
          statusPolling.intervalMs,
          DEFAULT_STATUS_POLL_INTERVAL_MS,
        ),
        maxDurationMs: readNumber(
          statusPolling.maxDurationMs,
          DEFAULT_STATUS_POLL_MAX_DURATION_MS,
        ),
        maxConsecutiveErrors: readNumber(
          statusPolling.maxConsecutiveErrors,
          DEFAULT_STATUS_POLL_MAX_ERRORS,
        ),
      },
    },
    debug: readBoolean(raw.debug, false),
  };
}

export function canonicalChannelType(channelType: string | undefined): string | undefined {
  if (!channelType) {
    return undefined;
  }

  const normalized = normalizeChannelType(channelType);
  if (normalized === "feishu") {
    return "feishu";
  }

  return channelType.trim();
}

function normalizeChannelType(channelType: string): string {
  const value = channelType.trim().toLowerCase();
  if (value.includes("feishu") || value.includes("lark")) {
    return "feishu";
  }

  return value.replace(/[\s_-]+/g, "");
}

function readSourceType(
  value: unknown,
  fallback: KnowledgeSourceType,
): KnowledgeSourceType {
  if (
    value === "FEISHU_CHAT" ||
    value === "MARKDOWN" ||
    value === "TUTORIAL" ||
    value === "NOTE" ||
    value === "ATTACHMENT"
  ) {
    return value;
  }
  return fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value
    .filter((item): item is string => {
      return typeof item === "string" && item.trim().length > 0;
    })
    .map((item) => item.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
