# OpenClaw KB-Bridge Plugin

该插件会将 OpenClaw 渠道对话连接到 `docs/api_openclaw.txt` 中描述的 Knowledge Bridge 服务。

当前版本关闭知识查询：共享服务密钥与消息 envelope 的 userId 不能验证最终登录用户。`resolveConfig` 始终关闭 query，`KbBridgeClient.query` 也拒绝直接调用；显式设置 `query.enabled=true` 不会重新启用。上传和入库行为保留。

本次依赖安装遇到 pnpm 构建脚本审批，没有批准或执行这些脚本。已有本地依赖时直接使用 `node node_modules/typescript/bin/tsc -p tsconfig.build.json` 与 `node --test test/fileIntentStore.test.mjs test/fileMedia.test.mjs test/queryIsolation.test.mjs` 验证，不通过 `pnpm run` 自动安装。原 lockfile 的 OpenClaw importer 与 package.json specifier 不一致仍保留原字节，未以本次任务扩展依赖变更。

它是一个非 LLM capability 的桥接插件，不把工具暴露给 LLM。原查询链路保留在代码中，但当前不执行：

```text
飞书 -> OpenClaw -> KB-Bridge -> LLM -> OpenClaw -> 飞书
```

它提供三条 hook 链路：

- 查询注入：当前关闭，`before_prompt_build` 不调用查询接口。
- 手动入库：`before_dispatch` 处理 `#入库`、`#kb add`、`/kb add` 和 `/kb-add`，然后调用 `POST /api/v1/ingest/manual` 并直接返回入库结果，不进入 LLM；`inbound_claim` 和 `before_agent_reply` 保留为更早或特殊入口的短路处理。提交成功后插件会轮询 `GET /api/v1/ingest/status/{taskId}`，入库完成或异常时提醒原会话。
- 可选候选入库：`message_received` 可以观察传入消息，并异步调用 `POST /api/v1/ingest/candidate`。

## 使用的 KB-Bridge API

插件运行时会调用以下 KB-Bridge 接口：

| 接口 | 触发位置 | 默认是否启用 | HMAC 签名 | 用途 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/query` | `before_prompt_build` | 否，缺少可验证最终用户身份，配置不能启用 | 是 | 当前不调用 |
| `POST /api/v1/ingest/manual` | `before_dispatch` / `inbound_claim` / `before_agent_reply` | 是，仅命中 `ingest.manualCommandPrefixes` 时触发 | 否 | 手动提交内容入库并直接返回结果，不进入 LLM |
| `GET /api/v1/ingest/status/{taskId}` | manual ingest status polling | 是，手动入库成功且 `ingest.statusPolling.enabled=true` 时触发 | 否 | 轮询入库后续状态，并在 `COMPLETED`、`FAILED`、`DISABLED` 或轮询异常时提醒原会话 |
| `POST /api/v1/ingest/candidate` | `message_received` | 否，需设置 `ingest.autoCandidateEnabled=true` | 是 | 异步评估普通消息是否值得沉淀为知识 |

手动入库成功后会先把 `taskId` 和初始 `status` 返回给用户，然后按配置轮询 `GET /api/v1/ingest/status/{taskId}` 并在终态或异常时提醒。

插件不会调用 `POST /api/v1/chat`。普通查询轮次的最终回答由 OpenClaw 当前会话绑定的 LLM 生成，KB-Bridge 只在 `/api/v1/query` 中返回证据包；手动入库轮次由插件直接返回入库结果，不进入 LLM。

## 安装

前置要求：

- OpenClaw Gateway / Plugin API `>=2026.3.24-beta.2`
- Node.js 运行时需提供全局 `fetch` 和 `AbortController`，建议使用 Node.js 18 或更新版本
- `pnpm`

在 OpenClaw 主机上执行：

```bash
cd kb-bridge-plugin
pnpm install
pnpm run build
openclaw plugins install ./
openclaw gateway restart
```

在 `openclaw.json` 中配置该插件：

```json
{
  "plugins": {
    "entries": {
      "kb-bridge": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:8111",
          "sharedSecret": "3tMVomxg6rXNz5w3xNBM",
          "requestTimeoutMs": 8000,
          "debug": true,
          "query": {
            "enabled": false,
            "injectEmptyKbResponses": false
          },
          "ingest": {
            "autoCandidateEnabled": false,
            "manualCommandPrefixes": ["#入库", "#kb add", "/kb add", "/kb-add"],
            "manualSourceType": "FEISHU_CHAT",
            "candidateSourceType": "FEISHU_CHAT",
            "skipSelfMessages": true,
            "statusPolling": {
              "enabled": true,
              "intervalMs": 5000,
              "maxDurationMs": 900000,
              "maxConsecutiveErrors": 3
            }
          }
        }
      }
    }
  }
}
```

启用 `ingest.autoCandidateEnabled=true` 后，`sharedSecret` 必须与 Knowledge Bridge 服务端的 `KB_SHARED_SECRET`（或 `kb.security.shared-secret`）保持一致。该密钥只证明服务身份，不能启用当前关闭的个人知识查询。

插件不会校验或过滤 OpenClaw 渠道，所有进入 hook 的消息都会按同一逻辑处理。在确认 KB-Bridge 中的去重与审核行为之前，请保持 `autoCandidateEnabled` 关闭。

旧配置中的 `query.channelAllowlist` 已移除；由于插件配置启用了严格 schema，请从 `openclaw.json` 中删除该字段。

手动入库命令会在 `before_dispatch` 被直接处理并跳过模型派发。当前不查询知识库。

`query.injectEmptyKbResponses` 在查询关闭时没有运行效果。

如果你在 `openclaw.json` 里显式配置了 `ingest.manualCommandPrefixes`，请把 `#kb add` 也加入该数组；否则 `#kb add ...` 会绕过手动入库逻辑，被当成普通 `#kb` 查询消息。

手动入库命令支持以下写法：

```text
#入库 要沉淀的内容
#入库 --force 要强制重新入库的内容
#kb add 要沉淀的内容
/kb add 要沉淀的内容
/kb-add 要沉淀的内容
```

如果用户回复一条消息后只发送 `#入库`、`#kb add` 等命令，插件会优先把被回复消息的文本作为入库内容。`--force` 会透传为 `force=true`，用于要求 Knowledge Bridge 跳过去重检查。

`manualSourceType` 和 `candidateSourceType` 用来告诉 Knowledge Bridge 如何处理入库内容：

| 值 | 适用场景 |
| --- | --- |
| `FEISHU_CHAT` | 飞书聊天问答或短消息，默认值 |
| `MARKDOWN` | 已整理好的 Markdown 文档 |
| `TUTORIAL` | 教程、流程类长内容 |
| `NOTE` | 笔记、零散知识整理 |
| `ATTACHMENT` | 附件内容，由 Knowledge Bridge 下游处理器继续判断 |

手动入库成功后，插件默认每 5 秒查询一次状态，最多轮询 15 分钟。终态为 `COMPLETED`、`FAILED` 或 `DISABLED` 时，插件优先通过 OpenClaw 渠道 outbound adapter 直接向原飞书会话发送提醒；如果渠道直发不可用，会退回到 OpenClaw system event + heartbeat。若连续 3 次查询状态接口失败，也会发送轮询异常提醒。若超过 `maxDurationMs` 后任务仍未完成，插件会发送超时提醒并停止本次轮询。

轮询启动、首次查询结果、状态变化和跳过轮询原因会写入 OpenClaw gateway 日志，前缀为 `[kb-bridge]`。如果 `debug=true`，插件还会打印每一次轮询响应以及完整 HTTP 请求/响应体。

当 `debug=true` 时，插件会在 OpenClaw gateway 日志中完整打印发往 KB-Bridge 的请求体和 KB-Bridge 返回的响应体。日志前缀为 `[kb-bridge]`，内容包含用户问题与知识库证据，请只在排查时开启。

## 运行方式

该插件不注册 LLM tools，也不依赖模型主动调用工具。

查询时，OpenClaw 在构建 prompt 前触发 `before_prompt_build`。插件会按 `docs/api_openclaw.txt` 构造请求体：

- `requestId`
- `userId`
- `chatId`
- `sessionKey`
- `messageId`
- `question`
- `channelType`
- `isGroup`
- `flags.strictKbOnly`（固定为 `false`）
- `flags.needCitation`（固定为 `true`）

KB-Bridge 返回 `route`、`allowModelSupplement`、`sources`、`instructions` 和 `retrievalQuality` 后，插件将 `instructions` 注入 system/developer 上下文，将 `sources` 注入 knowledge context，普通查询回答仍由 OpenClaw 当前会话绑定的 LLM 生成并回发飞书。

如果 OpenClaw 传入的 `before_prompt_build.prompt` 已包含 `Conversation info`、`Sender`、`message_id` 等包装元数据，插件会先提取真实用户消息，只把用户问题作为 `question` 发送给 KB-Bridge。

插件不再使用查询前缀判断是否检索；发送给 KB-Bridge 的 `question` 始终是 OpenClaw 传入的真实用户问题原文。

## 安全

`/api/v1/query` 和 `/api/v1/ingest/candidate` 使用以下方式签名：

```text
Base64(HMAC-SHA256(requestId + timestamp + SHA256(requestBody), sharedSecret))
```

该插件会发送 `X-KB-RequestId`、`X-KB-Timestamp` 和 `X-KB-Signature`，与 KB-Bridge API 契约保持一致。

## 排障

- 查询没有触发：这是当前缺少可验证最终用户身份时的预期行为，修改开关或共享密钥不会重新启用。
- 手动入库没有触发：确认消息以 `ingest.manualCommandPrefixes` 中的某个前缀开头；如果覆盖了默认数组，需要把 `#kb add`、`/kb add` 等仍需使用的前缀显式写回去。
- 入库状态没有提醒到原会话：查看 gateway 日志中 `[kb-bridge] status notification`、`direct status notification` 相关记录，确认 OpenClaw outbound adapter、`sessionKey` 和 delivery context 可用。
- 需要看完整 HTTP 请求/响应：临时开启 `debug=true`，排查后关闭，避免长期记录用户问题和知识库证据。

## 开发

面向新需求开发和维护的细节见 `docs/plugin-development.md`。该文档说明了源码结构、hook 链路、配置默认值、消息提取规则、扩展点和验证清单。

OpenClaw 原生插件需要同时提供：

- 包含 `openclaw.extensions` 的 `package.json`
- 包含插件身份、启动激活信息和配置 schema 的 `openclaw.plugin.json`
- 用于本地包安装的已编译运行时 JavaScript

本仓库将 TypeScript 源码保存在 `src/` 中，而 `package.json` 会将 OpenClaw 指向 `dist/index.js`。如果修改了 `src/`，请在运行 `openclaw plugins install ./` 之前重新构建或更新 `dist/`。

安装依赖后，运行：

```bash
pnpm run build
pnpm run check
```
