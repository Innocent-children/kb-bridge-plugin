import type {
  IngestAttachment,
  ManualIngestCommand,
  MessageEnvelope,
} from "./types.js";

export function extractMessageEnvelope(event: unknown, ctx?: unknown): MessageEnvelope {
  const eventRecord = asRecord(event);
  const ctxRecord = asRecord(ctx);
  const metadata = asRecord(eventRecord.metadata);
  const sender = asRecord(eventRecord.sender);
  const message = asRecord(eventRecord.message);
  const replyTo = asRecord(eventRecord.replyTo);
  const metadataReplyTo = asRecord(metadata.replyTo);
  const explicitSessionKey =
    readString(ctxRecord.sessionKey) ?? readString(eventRecord.sessionKey);
  const sessionInfo = parseOpenClawSessionKey(explicitSessionKey);

  const text =
    readText(eventRecord.cleanedBody) ??
    readText(eventRecord.bodyForAgent) ??
    readText(eventRecord.content) ??
    readText(eventRecord.text) ??
    readText(eventRecord.body) ??
    readText(eventRecord.transcript) ??
    readPromptUserText(eventRecord.prompt) ??
    readText(message.content) ??
    readText(message.text) ??
    readText(message.body) ??
    "";

  const channelType =
    readString(eventRecord.channelType) ??
    readString(metadata.channelType) ??
    readString(ctxRecord.channelType) ??
    readString(eventRecord.messageChannel) ??
    readString(metadata.messageChannel) ??
    readString(ctxRecord.messageChannel) ??
    readString(ctxRecord.messageProvider) ??
    readString(eventRecord.channel) ??
    readString(metadata.channel) ??
    readString(ctxRecord.channel) ??
    readString(eventRecord.platform) ??
    readString(metadata.platform) ??
    readString(eventRecord.adapter) ??
    readString(metadata.adapter) ??
    sessionInfo.channel ??
    readString(eventRecord.channelId) ??
    readString(ctxRecord.channelId);

  const messageId =
    readString(eventRecord.messageId) ??
    readString(eventRecord.msgId) ??
    readString(ctxRecord.messageId) ??
    readString(message.id) ??
    readString(message.messageId);

  const senderId =
    readString(eventRecord.userId) ??
    readString(eventRecord.senderId) ??
    readString(eventRecord.from) ??
    readString(ctxRecord.senderId) ??
    readString(sender.id) ??
    readString(sender.userId) ??
    readString(sender.openId) ??
    readString(sender.open_id) ??
    "unknown";

  const threadId =
    readString(eventRecord.threadId) ??
    readString(eventRecord.chatId) ??
    readString(eventRecord.conversationId) ??
    readString(eventRecord.parentConversationId) ??
    readString(ctxRecord.conversationId) ??
    readString(ctxRecord.parentConversationId) ??
    readString(ctxRecord.chatId) ??
    readString(ctxRecord.threadId) ??
    readString(metadata.chatId) ??
    sessionInfo.target;
  const accountId =
    readString(eventRecord.accountId) ??
    readString(metadata.accountId) ??
    readString(ctxRecord.accountId);
  const deliveryThreadId =
    readThreadId(eventRecord.threadId) ??
    readThreadId(metadata.threadId) ??
    readThreadId(eventRecord.messageThreadId) ??
    readThreadId(metadata.messageThreadId);
  const deliveryChannel =
    readString(eventRecord.channelType) ??
    readString(metadata.channelType) ??
    readString(ctxRecord.channelType) ??
    readString(eventRecord.messageChannel) ??
    readString(metadata.messageChannel) ??
    readString(ctxRecord.messageChannel) ??
    readString(ctxRecord.messageProvider) ??
    readString(eventRecord.platform) ??
    readString(metadata.platform) ??
    readString(eventRecord.adapter) ??
    readString(metadata.adapter) ??
    sessionInfo.channel ??
    readString(eventRecord.channel) ??
    readString(metadata.channel) ??
    readString(ctxRecord.channel);
  const deliveryTo =
    readString(eventRecord.conversationId) ??
    readString(ctxRecord.conversationId) ??
    readString(eventRecord.chatId) ??
    readString(metadata.chatId) ??
    readString(ctxRecord.channelId) ??
    readString(eventRecord.channelId) ??
    threadId ??
    sessionInfo.target;

  return {
    text,
    channelType,
    userId: senderId,
    chatId: threadId,
    sessionKey: explicitSessionKey ?? threadId,
    messageId,
    delivery:
      deliveryChannel && deliveryTo
        ? {
            channel: deliveryChannel,
            to: deliveryTo,
            accountId,
            threadId: deliveryThreadId,
          }
        : undefined,
    isGroup: readBoolean(eventRecord.isGroup) ?? readBoolean(metadata.isGroup),
    attachments: extractMediaAttachments(event, ctx),
    isSelfMessage:
      readBoolean(eventRecord.isFromSelf) ??
      readBoolean(eventRecord.self) ??
      readBoolean(eventRecord.isSelfMessage) ??
      readBoolean(sender.isBot) ??
      false,
    replyText:
      readText(eventRecord.replyToContent) ??
      readText(eventRecord.quotedContent) ??
      readText(replyTo.content) ??
      readText(replyTo.text) ??
      readText(metadataReplyTo.content) ??
      readText(metadataReplyTo.text),
  };
}

export function latestUserText(event: unknown): string {
  const eventRecord = asRecord(event);

  const messages = Array.isArray(eventRecord.messages)
    ? eventRecord.messages
    : eventRecord.sessionMessages;
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = asRecord(messages[index]);
      const role = readString(message.role);
      if (role && role !== "user") {
        continue;
      }
      const content = readText(message.content) ?? readText(message.text);
      if (content) {
        return content;
      }
    }
  }

  const prompt = readPromptUserText(eventRecord.prompt);
  if (prompt) {
    return prompt;
  }

  return "";
}

export function parseManualIngestCommand(
  text: string,
  prefixes: string[],
  replyText?: string,
): ManualIngestCommand | null {
  const trimmed = text.trim();
  for (const prefix of prefixes) {
    if (!trimmed.startsWith(prefix)) {
      continue;
    }

    const rest = trimmed.slice(prefix.length).replace(/^[:：\s]+/, "");
    const force = /(^|\s)--force(?=\s|$)/.test(rest);
    const content =
      rest.replace(/(^|\s)--force(?=\s|$)/g, " ").trim() || replyText?.trim() || "";

    return {
      content,
      force,
    };
  }

  return null;
}

export function isManualIngestText(text: string, prefixes: string[]): boolean {
  const trimmed = text.trim();
  return prefixes.some((prefix) => trimmed.startsWith(prefix));
}

function extractAttachments(value: unknown): IngestAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const record = asRecord(item);
      return {
        name: readString(record.name) ?? readString(record.filename),
        url: readString(record.url) ?? readString(record.downloadUrl),
        mimeType: readString(record.mimeType) ?? readString(record.contentType),
        localPath: readString(record.localPath) ?? readString(record.path)
          ?? readString(record.MediaPath) ?? readString(record.mediaPath),
      };
    })
    .filter((item) => item.name || item.url || item.mimeType || item.localPath);
}

export function extractMediaAttachments(event: unknown, ctx?: unknown): IngestAttachment[] {
  const eventRecord = asRecord(event);
  const ctxRecord = asRecord(ctx);
  const metadata = asRecord(eventRecord.metadata);
  const existing = extractAttachments(eventRecord.attachments ?? metadata.attachments);
  const paths = [eventRecord.MediaPath, eventRecord.mediaPath, metadata.MediaPath,
    metadata.mediaPath, ctxRecord.MediaPath, ctxRecord.mediaPath,
    eventRecord.MediaPaths, eventRecord.mediaPaths, metadata.MediaPaths,
    metadata.mediaPaths, ctxRecord.MediaPaths, ctxRecord.mediaPaths]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const localPath of paths) {
    if (!existing.some((item) => item.localPath === localPath)) {
      existing.push({ localPath });
    }
  }
  return existing;
}

export function isMediaPlaceholder(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return /^\[(file|document|media|attachment)(:[^\]]+)?\]$/.test(normalized)
    || /^<(file|document|media|attachment)>$/.test(normalized);
}

function readText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const record = asRecord(item);
        return readText(record.text) ?? readText(record.content);
      })
      .filter((item): item is string => Boolean(item));

    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  const record = asRecord(value);
  if (Object.keys(record).length > 0) {
    return (
      readText(record.text) ??
      readText(record.content) ??
      readText(record.body) ??
      readText(record.plainText)
    );
  }

  return undefined;
}

function readPromptUserText(value: unknown): string | undefined {
  const prompt = readText(value);
  if (!prompt) {
    return undefined;
  }

  if (!looksLikeOpenClawChannelPrompt(prompt)) {
    return prompt;
  }

  const messageBlock = extractPromptMessageBlock(prompt);
  if (messageBlock) {
    return messageBlock;
  }

  return stripPromptMetadata(prompt);
}

function looksLikeOpenClawChannelPrompt(prompt: string): boolean {
  return (
    prompt.includes("Conversation info (untrusted metadata):") ||
    prompt.includes("Sender (untrusted metadata):") ||
    /^\[message_id:\s*[^\]]+\]/im.test(prompt)
  );
}

function extractPromptMessageBlock(prompt: string): string | undefined {
  const match = prompt.match(/\[message_id:\s*[^\]]+\]\s*\r?\n([\s\S]*)$/i);
  if (!match) {
    return undefined;
  }

  const text = stripLeadingSenderLabel(match[1].trim());
  return text.length > 0 ? text : undefined;
}

function stripPromptMetadata(prompt: string): string | undefined {
  const withoutCodeBlocks = prompt.replace(/```[\s\S]*?```/g, "\n");
  const lines = withoutCodeBlocks
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      return (
        line.length > 0 &&
        !line.startsWith("Conversation info ") &&
        !line.startsWith("Sender ") &&
        !line.startsWith("[message_id:")
      );
    });

  const text = stripLeadingSenderLabel(lines.at(-1) ?? "");
  return text.length > 0 ? text : undefined;
}

function stripLeadingSenderLabel(text: string): string {
  const lines = text.split(/\r?\n/);
  const firstLine = lines[0] ?? "";
  const match = firstLine.match(/^[^:\n]{1,200}:\s*([\s\S]*)$/);
  if (!match) {
    return text.trim();
  }

  return [match[1], ...lines.slice(1)].join("\n").trim();
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function readThreadId(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return readString(value);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseOpenClawSessionKey(
  sessionKey: string | undefined,
): { channel?: string; target?: string } {
  if (!sessionKey) {
    return {};
  }

  const parts = sessionKey.split(":").map((part) => part.trim()).filter(Boolean);
  if (parts[0] === "agent" && parts.length >= 4) {
    return {
      channel: parts[2],
      target: parts.length >= 5 ? parts.slice(4).join(":") : undefined,
    };
  }
  return {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
