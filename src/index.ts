import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";

import {
  canonicalChannelType,
  resolveConfig,
} from "./config.js";
import { createKbRequestId, KbBridgeClient } from "./kbBridgeClient.js";
import {
  extractMessageEnvelope,
  extractMediaAttachments,
  isMediaPlaceholder,
  isManualIngestText,
  latestUserText,
  parseManualIngestCommand,
} from "./messages.js";
import { FileIntentStore } from "./fileIntentStore.js";
import { buildPromptInjection } from "./prompt.js";
import type {
  CandidateRequest,
  IngestRequest,
  IngestResponse,
  IngestStatusResponse,
  KbBridgePluginConfig,
  KnowledgeSourceType,
  MessageEnvelope,
  QueryRequest,
  QueryResponse,
} from "./types.js";

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type ManualIngestResult = {
  handled: true;
  reason: string;
  reply: {
    text: string;
    isError?: boolean;
  };
  ingest?: IngestResponse;
};

type IngestStatusMonitor = {
  taskId: number;
  startedAt: number;
  consecutiveErrors: number;
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
  lastStatus?: IngestStatusResponse;
};

export default definePluginEntry({
  id: "kb-bridge",
  name: "KB Bridge",
  description:
    "Intercepts OpenClaw turns, fetches Knowledge Bridge evidence, and injects it into the LLM context.",
  configSchema: buildJsonPluginConfigSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      baseUrl: { type: "string" },
      sharedSecret: { type: "string" },
      requestTimeoutMs: { type: "number", minimum: 1000 },
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean", default: false, description: "Query is disabled until final-user identity is verifiable." },
          injectEmptyKbResponses: { type: "boolean" },
        },
      },
      ingest: {
        type: "object",
        additionalProperties: false,
        properties: {
          autoCandidateEnabled: { type: "boolean" },
          manualCommandPrefixes: {
            type: "array",
            items: { type: "string" },
          },
          manualSourceType: {
            type: "string",
            enum: ["FEISHU_CHAT", "MARKDOWN", "TUTORIAL", "NOTE", "ATTACHMENT"],
          },
          candidateSourceType: {
            type: "string",
            enum: ["FEISHU_CHAT", "MARKDOWN", "TUTORIAL", "NOTE", "ATTACHMENT"],
          },
          skipSelfMessages: { type: "boolean" },
          fileCommandPrefixes: { type: "array", items: { type: "string" } },
          fileCancelCommands: { type: "array", items: { type: "string" } },
          fileIntentTtlMs: { type: "number", minimum: 1000 },
          mediaRoot: { type: "string" },
          statusPolling: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              intervalMs: { type: "number", minimum: 1000 },
              maxDurationMs: { type: "number", minimum: 1000 },
              maxConsecutiveErrors: { type: "number", minimum: 1 },
            },
          },
        },
      },
      debug: { type: "boolean" },
    },
  }),
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    const logger: Logger = api.logger ?? console;
    const client = new KbBridgeClient(config, logger);
    info(
      logger,
      `registered: baseUrl=${config.baseUrl} queryEnabled=${config.query.enabled} queryMode=every-turn channelValidation=false autoCandidateEnabled=${config.ingest.autoCandidateEnabled} debug=${config.debug}`,
    );

    const manualIngestPromises = new Map<string, Promise<ManualIngestResult>>();
    const fileIntents = new FileIntentStore();
    const ingestStatusMonitors = new Map<number, IngestStatusMonitor>();
    const handleManualIngestCommandOnce = (
      envelope: MessageEnvelope,
      command: { content: string; force: boolean },
    ) => {
      const cacheKey = buildManualIngestCacheKey(envelope, command);
      const cached = manualIngestPromises.get(cacheKey);
      if (cached) {
        debug(logger, config, "manual ingest deduped across hooks");
        return cached;
      }

      const promise = handleManualIngestCommand(
        client,
        logger,
        envelope,
        command,
        config.ingest.manualSourceType,
        config.ingest.statusPolling.enabled,
      );
      manualIngestPromises.set(cacheKey, promise);
      void promise.then((result) => {
        if (result.ingest) {
          startIngestStatusPolling({
            api,
            client,
            logger,
            config,
            envelope,
            response: result.ingest,
            monitors: ingestStatusMonitors,
          });
        }
      });
      void promise.finally(() => {
        const timeout = setTimeout(() => {
          manualIngestPromises.delete(cacheKey);
        }, 60_000);
        timeout.unref?.();
      });
      return promise;
    };

    api.registerRuntimeLifecycle({
      id: "kb-bridge-ingest-status-polling",
      description: "Stops KB-Bridge ingest status polling timers.",
      cleanup: () => {
        for (const taskId of ingestStatusMonitors.keys()) {
          stopIngestStatusMonitor(ingestStatusMonitors, taskId);
        }
      },
    });

    api.on(
      "before_prompt_build",
      async (event: unknown, ctx: unknown) => {
        if (!config.query.enabled) {
          debug(logger, config, "query skipped: query.enabled=false");
          return;
        }

        const envelope = extractMessageEnvelope(event, ctx);
        const question = envelope.text || latestUserText(event);
        if (!question) {
          debug(logger, config, "query skipped: empty question");
          return;
        }
        debug(
          logger,
          config,
          `query considered: questionChars=${question.length} channelType=${envelope.channelType ?? "unknown"} sessionKey=${envelope.sessionKey ?? "unknown"}`,
        );
        if (isManualIngestText(question, config.ingest.manualCommandPrefixes)) {
          debug(logger, config, "query skipped: manual ingest command should be handled before dispatch");
          return;
        }

        try {
          const response = await client.query(
            buildQueryRequest(envelope, question),
          );
          debug(
            logger,
            config,
            `query response: requestId=${response.requestId} route=${response.route} sources=${response.sources.length} confidence=${response.retrievalQuality?.confidence ?? "unknown"}`,
          );

          if (shouldSkipEmptyQueryResponse(response, config)) {
            debug(logger, config, "query response skipped: empty LLM_ONLY response");
            return;
          }

          return buildPromptInjection(response);
        } catch (error) {
          warn(logger, `KB-Bridge query skipped: ${formatError(error)}`);
          return;
        }
      },
      { priority: 25 },
    );

    api.on(
      "inbound_claim",
      async (event: unknown, ctx: unknown) => {
        const envelope = extractMessageEnvelope(event, ctx);
        const result = await handleFileIngestMessage(client, config, fileIntents, envelope,
          extractMediaAttachments(event, ctx));
        if (!result) return;
        if (result.ingest) {
          startIngestStatusPolling({ api, client, logger, config, envelope,
            response: result.ingest, monitors: ingestStatusMonitors });
        }
        return { handled: true, reason: result.reason, reply: result.reply };
      },
      { priority: 75 },
    );

    api.on(
      "reply_dispatch",
      async (event, ctx) => {
        const envelope = extractMessageEnvelope(event.ctx, event.ctx);
        const result = await handleFileIngestMessage(client, config, fileIntents, envelope,
          extractMediaAttachments(event.ctx, event.ctx));
        if (!result) return;
        if (result.ingest) {
          startIngestStatusPolling({ api, client, logger, config, envelope,
            response: result.ingest, monitors: ingestStatusMonitors });
        }
        ctx.dispatcher.sendFinalReply({ text: result.reply.text });
        ctx.dispatcher.markComplete();
        ctx.recordProcessed("completed", { reason: result.reason });
        ctx.markIdle(result.reason);
        return { handled: true, queuedFinal: true, counts: ctx.dispatcher.getQueuedCounts() };
      },
      { priority: 75 },
    );

    api.on(
      "inbound_claim",
      async (event: unknown, ctx: unknown) => {
        const envelope = extractMessageEnvelope(event, ctx);

        const command = parseManualIngestCommand(
          envelope.text,
          config.ingest.manualCommandPrefixes,
          envelope.replyText,
        );
        if (!command) {
          return;
        }
        return handleManualIngestCommandOnce(envelope, command);
      },
      { priority: 50 },
    );

    api.on(
      "before_dispatch",
      async (event: unknown, ctx: unknown) => {
        const envelope = extractMessageEnvelope(event, ctx);
        const command = parseManualIngestCommand(
          envelope.text,
          config.ingest.manualCommandPrefixes,
          envelope.replyText,
        );
        if (!command) {
          return;
        }

        const result = await handleManualIngestCommandOnce(envelope, command);
        return {
          handled: true,
          text: result.reply.text,
        };
      },
      { priority: 50 },
    );

    api.on(
      "before_agent_reply",
      async (event: unknown, ctx: unknown) => {
        const envelope = extractMessageEnvelope(event, ctx);
        const command = parseManualIngestCommand(
          envelope.text,
          config.ingest.manualCommandPrefixes,
          envelope.replyText,
        );
        if (!command) {
          return;
        }

        const result = await handleManualIngestCommandOnce(envelope, command);
        return {
          handled: true,
          reason: result.reason,
          reply: result.reply,
        };
      },
      { priority: 50 },
    );

    api.on(
      "message_received",
      (event: unknown, ctx: unknown) => {
        if (!config.ingest.autoCandidateEnabled) {
          return;
        }

        const envelope = extractMessageEnvelope(event, ctx);
        if (!envelope.text) {
          return;
        }
        if (isMediaPlaceholder(envelope.text)) {
          return;
        }
        if (config.ingest.skipSelfMessages && envelope.isSelfMessage) {
          return;
        }
        if (isManualIngestText(envelope.text, config.ingest.manualCommandPrefixes)) {
          return;
        }

        void client
          .createCandidate(buildCandidateRequest(envelope, config.ingest.candidateSourceType))
          .then((response) => {
            debug(
              logger,
              config,
              `candidate response: requestId=${response.requestId} worthy=${response.worthy} taskId=${response.taskId ?? "none"}`,
            );
          })
          .catch((error) => {
            warn(logger, `KB-Bridge candidate ingest skipped: ${formatError(error)}`);
          });
      },
      { priority: -25 },
    );
  },
});

function buildQueryRequest(
  envelope: MessageEnvelope,
  question: string,
): QueryRequest {
  return {
    requestId: createKbRequestId(),
    userId: envelope.userId,
    chatId: envelope.chatId,
    sessionKey: envelope.sessionKey,
    messageId: envelope.messageId,
    question,
    channelType: canonicalChannelType(envelope.channelType),
    isGroup: envelope.isGroup ?? false,
    flags: {
      strictKbOnly: false,
      needCitation: true,
    },
  };
}

function buildCandidateRequest(
  envelope: MessageEnvelope,
  sourceType: KnowledgeSourceType,
): CandidateRequest {
  return {
    requestId: createKbRequestId(),
    userId: envelope.userId,
    chatId: envelope.chatId,
    messageIds: envelope.messageId ? [envelope.messageId] : undefined,
    content: envelope.text,
    sourceType,
    attachments: envelope.attachments.length > 0 ? envelope.attachments : undefined,
  };
}

function buildManualIngestRequest(
  envelope: MessageEnvelope,
  command: { content: string; force: boolean },
  sourceType: KnowledgeSourceType,
): IngestRequest {
  return {
    requestId: createKbRequestId(),
    userId: envelope.userId,
    chatId: envelope.chatId,
    messageIds: envelope.messageId ? [envelope.messageId] : undefined,
    content: command.content,
    sourceType,
    attachments: envelope.attachments.length > 0 ? envelope.attachments : undefined,
    force: command.force,
  };
}

async function handleManualIngestCommand(
  client: KbBridgeClient,
  logger: Logger,
  envelope: MessageEnvelope,
  command: { content: string; force: boolean },
  sourceType: KnowledgeSourceType,
  statusPollingEnabled: boolean,
): Promise<ManualIngestResult> {
  if (!command.content) {
    return {
      handled: true,
      reason: "kb-bridge-manual-ingest-empty",
      reply: {
        text: "请把要入库的内容放在命令后面，或回复一条消息后发送入库命令。",
      },
    };
  }

  try {
    const response = await client.ingestManual(
      buildManualIngestRequest(envelope, command, sourceType),
    );
    const duplicateText = response.duplicate ? "内容已存在，" : "";
    const pollingText =
      statusPollingEnabled && shouldPollIngestStatus(response.status)
        ? "，我会继续轮询状态并在完成或异常时提醒你"
        : "";
    return {
      handled: true,
      reason: "kb-bridge-manual-ingest",
      reply: {
        text: `${duplicateText}已提交入库任务：taskId=${response.taskId}，status=${response.status}${pollingText}`,
      },
      ingest: response,
    };
  } catch (error) {
    warn(logger, `KB-Bridge manual ingest failed: ${formatError(error)}`);
    return {
      handled: true,
      reason: "kb-bridge-manual-ingest-error",
      reply: {
        text: `入库提交失败：${formatError(error)}`,
        isError: true,
      },
    };
  }
}

async function handleFileIngestMessage(
  client: KbBridgeClient,
  config: KbBridgePluginConfig,
  intents: FileIntentStore,
  envelope: MessageEnvelope,
  attachments: MessageEnvelope["attachments"],
): Promise<ManualIngestResult | undefined> {
  const text = envelope.text.trim();
  const key = {
    accountId: envelope.delivery?.accountId,
    sessionKey: envelope.sessionKey ?? envelope.chatId,
    senderId: envelope.userId,
  };
  if (config.ingest.fileCancelCommands.includes(text)) {
    intents.cancel(key);
    return { handled: true, reason: "kb-bridge-file-intent-cancelled",
      reply: { text: "已取消本次文件入库。" } };
  }
  if (config.ingest.fileCommandPrefixes.includes(text)) {
    intents.arm(key, config.ingest.fileIntentTtlMs);
    return { handled: true, reason: "kb-bridge-file-intent-armed",
      reply: { text: "请在两分钟内发送一个要入库的文件。" } };
  }

  const files = attachments.filter((item) => item.localPath);
  if (files.length === 0) {
    if (intents.has(key) && isMediaPlaceholder(text)) {
      intents.consume(key);
      return { handled: true, reason: "kb-bridge-file-media-missing",
        reply: { text: "文件下载不可用，请重新发送“入库文件”后再试。", isError: true } };
    }
    return undefined;
  }
  if (!intents.has(key)) return undefined;
  if (files.length !== 1) {
    return { handled: true, reason: "kb-bridge-file-count-invalid",
      reply: { text: "每次只能入库一个文件，请重新发送。", isError: true } };
  }
  if (!intents.consume(key)) return undefined;

  try {
    const filePath = await validateMediaPath(files[0]!.localPath!, config.ingest.mediaRoot);
    const messageId = envelope.messageId ?? createKbRequestId();
    const requestId = createHash("sha256").update([
      envelope.delivery?.accountId ?? "", envelope.sessionKey ?? envelope.chatId ?? "",
      envelope.userId, messageId, "0",
    ].join("\u001f")).digest("hex");
    const response = await client.ingestFile({
      requestId,
      userId: envelope.userId,
      chatId: envelope.chatId,
      messageId,
      filePath,
      fileName: files[0]!.name ?? basename(filePath),
      mimeType: files[0]!.mimeType,
    });
    return { handled: true, reason: "kb-bridge-file-ingest",
      reply: { text: `文件已接收：taskId=${response.taskId}，status=${response.status}` },
      ingest: response };
  } catch (error) {
    return { handled: true, reason: "kb-bridge-file-ingest-error",
      reply: { text: `文件入库失败：${formatError(error)}`, isError: true } };
  }
}

async function validateMediaPath(input: string, configuredRoot?: string): Promise<string> {
  if (!isAbsolute(input)) throw new Error("媒体路径必须是绝对路径");
  const actual = await realpath(input);
  const info = await stat(actual);
  if (!info.isFile()) throw new Error("媒体路径不是普通文件");
  if (configuredRoot) {
    const root = await realpath(resolve(configuredRoot));
    const child = relative(root, actual);
    if (child.startsWith("..") || isAbsolute(child)) {
      throw new Error("媒体路径不在允许目录内");
    }
  }
  return actual;
}

function startIngestStatusPolling(params: {
  api: OpenClawPluginApi;
  client: KbBridgeClient;
  logger: Logger;
  config: KbBridgePluginConfig;
  envelope: MessageEnvelope;
  response: IngestResponse;
  monitors: Map<number, IngestStatusMonitor>;
}): void {
  const { config, envelope, monitors, response } = params;
  if (!config.ingest.statusPolling.enabled) {
    info(
      params.logger,
      `status polling skipped: taskId=${response.taskId} reason=disabled initialStatus=${response.status}`,
    );
    return;
  }
  if (!shouldPollIngestStatus(response.status)) {
    info(
      params.logger,
      `status polling skipped: taskId=${response.taskId} reason=terminal initialStatus=${response.status}`,
    );
    return;
  }
  if (monitors.has(response.taskId)) {
    debug(params.logger, config, `status polling already active: taskId=${response.taskId}`);
    return;
  }

  const monitor: IngestStatusMonitor = {
    taskId: response.taskId,
    startedAt: Date.now(),
    consecutiveErrors: 0,
    stopped: false,
  };
  monitors.set(response.taskId, monitor);
  if (envelope.sessionKey) {
    params.api.registerSessionSchedulerJob({
      id: `kb-bridge-ingest-status-${response.taskId}`,
      sessionKey: envelope.sessionKey,
      kind: "kb-bridge-ingest-status",
      description: `Poll KB-Bridge ingest task ${response.taskId}.`,
      cleanup: () => {
        stopIngestStatusMonitor(monitors, response.taskId);
      },
    });
  }
  info(
    params.logger,
    `status polling started: taskId=${response.taskId} initialStatus=${response.status}`,
  );
  scheduleIngestStatusPoll(params, monitor);
}

function scheduleIngestStatusPoll(
  params: {
    api: OpenClawPluginApi;
    client: KbBridgeClient;
    logger: Logger;
    config: KbBridgePluginConfig;
    envelope: MessageEnvelope;
    response: IngestResponse;
    monitors: Map<number, IngestStatusMonitor>;
  },
  monitor: IngestStatusMonitor,
): void {
  const intervalMs = Math.max(
    1000,
    Math.floor(params.config.ingest.statusPolling.intervalMs),
  );
  monitor.timer = setTimeout(() => {
    void pollIngestStatus(params, monitor);
  }, intervalMs);
  monitor.timer.unref?.();
}

async function pollIngestStatus(
  params: {
    api: OpenClawPluginApi;
    client: KbBridgeClient;
    logger: Logger;
    config: KbBridgePluginConfig;
    envelope: MessageEnvelope;
    response: IngestResponse;
    monitors: Map<number, IngestStatusMonitor>;
  },
  monitor: IngestStatusMonitor,
): Promise<void> {
  if (monitor.stopped) {
    return;
  }

  try {
    const status = await params.client.ingestStatus(monitor.taskId);
    const previousStatus = monitor.lastStatus?.status;
    const previousReviewStatus = monitor.lastStatus?.reviewStatus;
    monitor.lastStatus = status;
    monitor.consecutiveErrors = 0;
    logIngestStatusPollResult(
      params.logger,
      params.config,
      status,
      previousStatus,
      previousReviewStatus,
    );

    if (!shouldPollIngestStatus(status.status)) {
      stopIngestStatusMonitor(params.monitors, monitor.taskId);
      await sendIngestStatusNotification(
        params.api,
        params.logger,
        params.envelope,
        formatTerminalIngestStatus(status),
        `kb-bridge:ingest:${monitor.taskId}:terminal`,
      );
      return;
    }

    const elapsedMs = Date.now() - monitor.startedAt;
    if (elapsedMs >= params.config.ingest.statusPolling.maxDurationMs) {
      stopIngestStatusMonitor(params.monitors, monitor.taskId);
      await sendIngestStatusNotification(
        params.api,
        params.logger,
        params.envelope,
        formatIngestStatusTimeout(status, elapsedMs),
        `kb-bridge:ingest:${monitor.taskId}:timeout`,
      );
      return;
    }

    scheduleIngestStatusPoll(params, monitor);
  } catch (error) {
    monitor.consecutiveErrors += 1;
    warn(
      params.logger,
      `KB-Bridge ingest status polling failed: taskId=${monitor.taskId} error=${formatError(error)}`,
    );
    const maxErrors = Math.max(
      1,
      Math.floor(params.config.ingest.statusPolling.maxConsecutiveErrors),
    );
    if (monitor.consecutiveErrors >= maxErrors) {
      stopIngestStatusMonitor(params.monitors, monitor.taskId);
      await sendIngestStatusNotification(
        params.api,
        params.logger,
        params.envelope,
        `入库任务状态轮询异常：taskId=${monitor.taskId}，error=${formatError(error)}`,
        `kb-bridge:ingest:${monitor.taskId}:poll-error`,
      );
      return;
    }
    scheduleIngestStatusPoll(params, monitor);
  }
}

function logIngestStatusPollResult(
  logger: Logger,
  config: KbBridgePluginConfig,
  status: IngestStatusResponse,
  previousStatus: string | undefined,
  previousReviewStatus: string | undefined,
): void {
  if (
    config.debug ||
    status.status !== previousStatus ||
    status.reviewStatus !== previousReviewStatus
  ) {
    info(
      logger,
      `status polling response: taskId=${status.taskId} status=${status.status} reviewStatus=${status.reviewStatus ?? "unknown"}`,
    );
  }
}

function stopIngestStatusMonitor(
  monitors: Map<number, IngestStatusMonitor>,
  taskId: number,
): void {
  const monitor = monitors.get(taskId);
  if (!monitor) {
    return;
  }
  monitor.stopped = true;
  if (monitor.timer) {
    clearTimeout(monitor.timer);
  }
  monitors.delete(taskId);
}

async function sendIngestStatusNotification(
  api: OpenClawPluginApi,
  logger: Logger,
  envelope: MessageEnvelope,
  text: string,
  contextKey: string,
): Promise<void> {
  info(
    logger,
    `status notification ready: contextKey=${contextKey} sessionKey=${envelope.sessionKey ?? "unknown"} deliveryChannel=${envelope.delivery?.channel ?? "missing"} deliveryTo=${envelope.delivery?.to ?? "missing"}`,
  );

  if (await sendDirectChannelNotification(api, logger, envelope, text)) {
    return;
  }

  if (!envelope.sessionKey) {
    warn(logger, `KB-Bridge status notification dropped: no sessionKey text=${text}`);
    return;
  }

  try {
    const enqueued = api.runtime.system.enqueueSystemEvent(text, {
      sessionKey: envelope.sessionKey,
      contextKey,
      deliveryContext: envelope.delivery,
      trusted: true,
    });
    if (!enqueued) {
      warn(logger, `KB-Bridge status notification fallback not enqueued: contextKey=${contextKey}`);
      return;
    }

    info(logger, `status notification fallback enqueued: contextKey=${contextKey}`);
    api.runtime.system.requestHeartbeat({
      source: "hook",
      intent: "event",
      reason: contextKey,
      coalesceMs: 0,
      sessionKey: envelope.sessionKey,
      heartbeat: { target: "last" },
    });
    info(logger, `status notification heartbeat requested: contextKey=${contextKey}`);
  } catch (error) {
    warn(logger, `KB-Bridge status notification failed: ${formatError(error)}`);
  }
}

async function sendDirectChannelNotification(
  api: OpenClawPluginApi,
  logger: Logger,
  envelope: MessageEnvelope,
  text: string,
): Promise<boolean> {
  const delivery = envelope.delivery;
  if (!delivery?.channel || !delivery.to) {
    info(
      logger,
      `direct status notification skipped: deliveryChannel=${delivery?.channel ?? "missing"} deliveryTo=${delivery?.to ?? "missing"}`,
    );
    return false;
  }

  try {
    const channelId =
      delivery.channel as Parameters<typeof api.runtime.channel.outbound.loadAdapter>[0];
    const adapter = await api.runtime.channel.outbound.loadAdapter(channelId);
    if (!adapter?.sendText) {
      warn(logger, `KB-Bridge direct status notification skipped: no sendText adapter for channel=${delivery.channel}`);
      return false;
    }
    await adapter.sendText({
      cfg: api.config,
      to: delivery.to,
      text,
      accountId: delivery.accountId,
      threadId: delivery.threadId,
    });
    info(
      logger,
      `direct status notification sent: channel=${delivery.channel} to=${delivery.to}`,
    );
    return true;
  } catch (error) {
    warn(logger, `KB-Bridge direct status notification failed: ${formatError(error)}`);
    return false;
  }
}

function shouldPollIngestStatus(status: string): boolean {
  return !isTerminalIngestStatus(status);
}

function isTerminalIngestStatus(status: string): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "DISABLED";
}

function formatTerminalIngestStatus(status: IngestStatusResponse): string {
  const details = formatIngestStatusDetails(status);
  if (status.status === "COMPLETED") {
    const outputs = [
      status.processedGuideKey ? "Guide" : "",
      status.processedQaKey ? "QA" : "",
    ].filter(Boolean);
    const outputText = outputs.length > 0 ? `，已生成${outputs.join("、")}文档` : "";
    return `入库任务已完成：${details}${outputText}`;
  }
  if (status.status === "FAILED") {
    return `入库任务失败：${details}${formatErrorMessageSuffix(status.errorMessage)}`;
  }
  if (status.status === "DISABLED") {
    return `入库任务已停用：${details}${formatErrorMessageSuffix(status.errorMessage)}`;
  }
  return `入库任务状态已更新：${details}`;
}

function formatIngestStatusTimeout(
  status: IngestStatusResponse,
  elapsedMs: number,
): string {
  const elapsedMinutes = Math.max(1, Math.round(elapsedMs / 60_000));
  return `入库任务仍未完成：${formatIngestStatusDetails(status)}，已轮询约${elapsedMinutes}分钟，插件已停止本次轮询`;
}

function formatIngestStatusDetails(status: IngestStatusResponse): string {
  const parts = [`taskId=${status.taskId}`, `status=${status.status}`];
  if (status.reviewStatus) {
    parts.push(`reviewStatus=${status.reviewStatus}`);
  }
  return parts.join("，");
}

function formatErrorMessageSuffix(errorMessage: string | null | undefined): string {
  return errorMessage ? `，error=${errorMessage}` : "";
}

function buildManualIngestCacheKey(
  envelope: MessageEnvelope,
  command: { content: string; force: boolean },
): string {
  const commandKey = `${command.force ? "force" : "normal"}\u001f${command.content}`;
  if (envelope.messageId) {
    return `message\u001f${envelope.messageId}\u001f${commandKey}`;
  }

  return [
    "session",
    envelope.sessionKey ?? "",
    envelope.chatId ?? "",
    commandKey,
  ].join("\u001f");
}

function shouldSkipEmptyQueryResponse(
  response: QueryResponse,
  config: KbBridgePluginConfig,
): boolean {
  return (
    response.sources.length === 0 &&
    response.route === "LLM_ONLY" &&
    !config.query.injectEmptyKbResponses
  );
}

function debug(
  logger: Logger,
  config: KbBridgePluginConfig,
  message: string,
): void {
  if (config.debug) {
    info(logger, message);
  }
}

function info(logger: Logger, message: string): void {
  logger.info?.(`[kb-bridge] ${message}`);
}

function warn(logger: Logger, message: string): void {
  logger.warn?.(`[kb-bridge] ${message}`);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
