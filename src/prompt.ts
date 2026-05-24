import type { EvidenceSource, QueryResponse } from "./types.js";

export function buildPromptInjection(response: QueryResponse): {
  prependContext?: string;
  appendSystemContext?: string;
} {
  return {
    appendSystemContext: buildSystemInstructions(response),
    prependContext: buildKnowledgeContext(response),
  };
}

function buildSystemInstructions(response: QueryResponse): string {
  const instructions =
    response.instructions.length > 0
      ? response.instructions.map((item) => `- ${item}`).join("\n")
      : "- 优先依据 Knowledge Bridge 返回的 sources 回答。";

  return [
    "Knowledge Bridge 本轮回答约束：",
    `- route: ${response.route}`,
    `- allowModelSupplement: ${response.allowModelSupplement ? "true" : "false"}`,
    routePolicy(response),
    instructions,
    "- 引用知识库内容时，使用 knowledge_bridge_context 中的来源编号和标题。",
  ].join("\n");
}

function buildKnowledgeContext(response: QueryResponse): string {
  const quality = response.retrievalQuality
    ? `confidence=${response.retrievalQuality.confidence}; hits=${response.retrievalQuality.hitCount}; truncated=${response.retrievalQuality.truncated}`
    : "confidence=unknown";

  const sources =
    response.sources.length > 0
      ? response.sources.map(formatSource).join("\n\n")
      : "No sources were returned by Knowledge Bridge.";

  return [
    "<knowledge_bridge_context>",
    `requestId: ${response.requestId}`,
    `route: ${response.route}`,
    `allowModelSupplement: ${response.allowModelSupplement}`,
    `quality: ${quality}`,
    "",
    sources,
    "</knowledge_bridge_context>",
  ].join("\n");
}

function formatSource(source: EvidenceSource, index: number): string {
  const title = source.title ?? "Untitled";
  const dataset = source.dataset ? ` dataset=${source.dataset}` : "";
  const score =
    typeof source.score === "number" ? ` score=${source.score.toFixed(4)}` : "";
  const metadata = source.metadata
    ? `\nmetadata: ${JSON.stringify(source.metadata)}`
    : "";
  const content = source.content.replace(/\r\n/g, "\n").trim();

  return [
    `[${index}] ${title}${dataset}${score}`,
    `${metadata}`,
    content,
  ]
    .filter(Boolean)
    .join("\n");
}

function routePolicy(response: QueryResponse): string {
  if (!response.allowModelSupplement) {
    return "- 不允许补充模型自身知识；sources 不足时必须明确说明知识库无足够信息。";
  }

  switch (response.route) {
    case "KB_ONLY":
      return "- 只能依据 sources 回答；sources 不足时说明知识库无相关信息。";
    case "KB_PLUS_LLM":
      return "- 优先依据 sources 回答；如补充模型自身知识，必须显式标注为补充说明。";
    case "LLM_ONLY":
      return "- Knowledge Bridge 未返回可用 sources，可按普通对话回答。";
  }
}
