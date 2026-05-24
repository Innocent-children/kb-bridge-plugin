import { createHash, createHmac, randomUUID } from "node:crypto";

import type {
  CandidateRequest,
  CandidateResponse,
  EvidenceSource,
  IngestRequest,
  IngestResponse,
  IngestStatusResponse,
  KbBridgePluginConfig,
  QueryRequest,
  QueryResponse,
} from "./types.js";

type Logger = {
  info?: (message: string) => void;
};

export class KbBridgeClient {
  private readonly config: KbBridgePluginConfig;
  private readonly logger?: Logger;

  constructor(config: KbBridgePluginConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    this.requireSharedSecret("query");
    const response = await this.postJson<unknown>("/api/v1/query", request, {
      signed: true,
    });
    return normalizeQueryResponse(response, request.requestId);
  }

  async createCandidate(
    request: CandidateRequest,
  ): Promise<CandidateResponse> {
    this.requireSharedSecret("candidate ingest");
    return this.postJson<CandidateResponse>("/api/v1/ingest/candidate", request, {
      signed: true,
    });
  }

  async ingestManual(request: IngestRequest): Promise<IngestResponse> {
    return this.postJson<IngestResponse>("/api/v1/ingest/manual", request, {
      signed: false,
    });
  }

  async ingestStatus(taskId: number): Promise<IngestStatusResponse> {
    return this.getJson<IngestStatusResponse>(
      `/api/v1/ingest/status/${encodeURIComponent(String(taskId))}`,
    );
  }

  private async postJson<T>(
    path: string,
    body: Record<string, unknown>,
    options: { signed: boolean },
  ): Promise<T> {
    const requestBody = JSON.stringify(body);
    const requestId = String(body.requestId ?? randomUUID());
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=UTF-8",
      accept: "application/json",
    };

    if (options.signed) {
      Object.assign(headers, this.sign(requestId, requestBody));
    }

    this.debugHttpBody(`request ${path} body: ${requestBody}`);

    return this.fetchJson<T>(path, {
      method: "POST",
      headers,
      body: requestBody,
    });
  }

  private async getJson<T>(path: string): Promise<T> {
    return this.fetchJson<T>(path, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });
  }

  private async fetchJson<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs,
    );

    try {
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });

      const text = await response.text();
      this.debugHttpBody(`response ${path} status=${response.status} body: ${text}`);
      if (!response.ok) {
        throw new Error(
          `KB-Bridge request failed: HTTP ${response.status} ${text.slice(0, 500)}`,
        );
      }

      return text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
    } finally {
      clearTimeout(timeout);
    }
  }

  private sign(requestId: string, requestBody: string): Record<string, string> {
    const timestamp = String(Date.now());
    const bodyHash = createHash("sha256").update(requestBody).digest("hex");
    const signatureContent = `${requestId}${timestamp}${bodyHash}`;
    const signature = createHmac("sha256", this.config.sharedSecret)
      .update(signatureContent)
      .digest("base64");

    return {
      "X-KB-RequestId": requestId,
      "X-KB-Timestamp": timestamp,
      "X-KB-Signature": signature,
    };
  }

  private requireSharedSecret(operation: string): void {
    if (!this.config.sharedSecret) {
      throw new Error(
        `KB-Bridge ${operation} requires plugins.entries.kb-bridge.config.sharedSecret`,
      );
    }
  }

  private debugHttpBody(message: string): void {
    if (this.config.debug) {
      this.logger?.info?.(`[kb-bridge] ${message}`);
    }
  }
}

export function createKbRequestId(): string {
  return randomUUID();
}

function normalizeQueryResponse(value: unknown, fallbackRequestId: string): QueryResponse {
  const record = asRecord(value);
  return {
    requestId: readString(record.requestId) ?? fallbackRequestId,
    route: readQueryRoute(record.route),
    allowModelSupplement: readBoolean(record.allowModelSupplement, false),
    sources: readSources(record.sources),
    instructions: readStringArray(record.instructions),
    retrievalQuality: readRetrievalQuality(record.retrievalQuality),
  };
}

function readSources(value: unknown): EvidenceSource[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const record = asRecord(item);
      const content = readString(record.content);
      if (!content) {
        return null;
      }

      const source: EvidenceSource = {
        content,
      };
      const dataset = readString(record.dataset);
      const title = readString(record.title);
      const score = readNumber(record.score);
      const metadata = asOptionalRecord(record.metadata);
      if (dataset) {
        source.dataset = dataset;
      }
      if (title) {
        source.title = title;
      }
      if (typeof score === "number") {
        source.score = score;
      }
      if (metadata) {
        source.metadata = metadata;
      }

      return source;
    })
    .filter((item): item is EvidenceSource => item !== null);
}

function readRetrievalQuality(value: unknown): QueryResponse["retrievalQuality"] {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return undefined;
  }

  return {
    hitCount: readNumber(record.hitCount) ?? 0,
    confidence: readConfidence(record.confidence),
    truncated: readBoolean(record.truncated, false),
    originalHitCount: readNumber(record.originalHitCount),
  };
}

function readQueryRoute(value: unknown): QueryResponse["route"] {
  if (value === "KB_ONLY" || value === "KB_PLUS_LLM" || value === "LLM_ONLY") {
    return value;
  }
  return "LLM_ONLY";
}

function readConfidence(value: unknown): NonNullable<QueryResponse["retrievalQuality"]>["confidence"] {
  if (value === "HIGH" || value === "MEDIUM" || value === "LOW") {
    return value;
  }
  return "LOW";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => {
    return typeof item === "string" && item.trim().length > 0;
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean;
function readBoolean(value: unknown, fallback?: undefined): boolean | undefined;
function readBoolean(value: unknown, fallback?: boolean): boolean | undefined {
  return typeof value === "boolean" ? value : fallback;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
