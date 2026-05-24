# Project Structure

```text
.
├── README.md                     # User-facing docs (Chinese): install, config, runtime behavior
├── openclaw.plugin.json          # OpenClaw plugin manifest, activation, configSchema, UI hints
├── package.json                  # npm metadata, scripts, openclaw extension entry, compat ranges
├── pnpm-lock.yaml                # pnpm lockfile (do not replace with npm/yarn lockfiles)
├── tsconfig.json                 # editor type-check config (noEmit)
├── tsconfig.build.json           # build config -> dist/ with declarations and source maps
├── docs/
│   ├── README.md
│   ├── api_openclaw.txt          # HTTP contract between this plugin and KB-Bridge service
│   ├── plugin-development.md     # Maintainer guide: hook chains, config, extension points, checklist
│   ├── KnowledgeBridge设计文档.md
│   └── 基于OpenClaw和RAGFlow的知识库助手.md
├── src/
│   ├── index.ts                  # Plugin entry; registers hooks; orchestrates query/ingest/polling/notify
│   ├── config.ts                 # Defaults, runtime config normalization, channel-type canonicalization
│   ├── kbBridgeClient.ts         # KB-Bridge HTTP client; HMAC signing; response normalization
│   ├── messages.ts               # MessageEnvelope extraction; manual-ingest command parsing
│   ├── prompt.ts                 # QueryResponse -> OpenClaw prompt injection (system + knowledge context)
│   └── types.ts                  # Plugin config types and KB-Bridge request/response types
└── dist/                         # Build output (gitignored); produced by `pnpm run build`
```

## Module responsibilities

- **`src/index.ts`** — Single source of truth for hook registration and orchestration. Holds the cross-hook manual-ingest dedup map and the per-task ingest status polling map. Wires runtime lifecycle and session scheduler cleanup. Also redeclares the JSON schema via `buildJsonPluginConfigSchema` for the SDK.
- **`src/config.ts`** — `resolveConfig(input)` reads an unknown `pluginConfig` and returns a fully-defaulted `KbBridgePluginConfig`. Also exposes `canonicalChannelType` (Feishu/Lark normalization). All defaults live here.
- **`src/kbBridgeClient.ts`** — `KbBridgeClient` class wrapping all four KB-Bridge endpoints. Handles HMAC signing, request timeout via `AbortController`, response JSON parsing, and `normalizeQueryResponse` to tolerate partial server payloads. Also exports `createKbRequestId`.
- **`src/messages.ts`** — `extractMessageEnvelope(event, ctx)` is the canonical entry point for reading OpenClaw hook payloads; new hooks should reuse it instead of parsing raw events. Also exposes `latestUserText`, `parseManualIngestCommand`, `isManualIngestText`, and the prompt-stripping logic that removes OpenClaw's `Conversation info` / `Sender` / `[message_id: ...]` wrapping.
- **`src/prompt.ts`** — Pure transform from `QueryResponse` to `{ appendSystemContext, prependContext }`. Knowledge sources are emitted inside a `<knowledge_bridge_context>` block, indexed from `[0]`.
- **`src/types.ts`** — All shared types: `KbBridgePluginConfig`, `KnowledgeSourceType`, `QueryRoute`, request/response shapes, `MessageEnvelope`, `ManualIngestCommand`. Adding a KB-Bridge endpoint or config field starts here.

## Hook chain priorities

| Hook                 | Priority | Purpose                                       |
| -------------------- | -------- | --------------------------------------------- |
| `before_prompt_build`| 25       | Query injection                               |
| `inbound_claim`      | 50       | Manual ingest early claim where available     |
| `before_dispatch`    | 50       | Manual ingest direct reply before LLM dispatch |
| `before_agent_reply` | 50       | Manual ingest short-circuit reply             |
| `message_received`   | -25      | Optional candidate ingest                     |

## Conventions when extending

- **Adding a config field**: update `src/types.ts`, `src/config.ts` (default + reader), the schema in `src/index.ts`, the schema in `openclaw.plugin.json`, and `README.md` + `docs/plugin-development.md`. The two schemas must stay in sync.
- **Adding a KB-Bridge endpoint**: add types to `src/types.ts`, add a method on `KbBridgeClient` (declare signed vs unsigned), wire it from `src/index.ts`, and update `docs/api_openclaw.txt` and `README.md`.
- **Adding a manual-ingest alias**: prefer adding to the default `manualCommandPrefixes` in `src/config.ts` and updating `README.md` examples. New semantics require extending `ManualIngestCommand` and the parser in `src/messages.ts`, plus a new branch in `src/index.ts` (verify cross-hook dedup keys still hold).
- **Build artifacts**: `dist/` must be regenerated via `pnpm run build` before `openclaw plugins install ./`. Do not hand-edit `dist/`.
- **File naming**: `camelCase.ts` for source files; new modules go under `src/` and import siblings with explicit `.js` extensions.
