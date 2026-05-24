# Product Overview

`kb-bridge-plugin` (`@knowledge-bridge/openclaw-kb-bridge`) is a native OpenClaw plugin that bridges OpenClaw channel conversations (e.g., Feishu/Lark) to an external Knowledge Bridge HTTP service.

## What it does

For normal query turns, the plugin sits between an OpenClaw channel and the LLM:

```
Feishu -> OpenClaw -> KB-Bridge plugin -> LLM -> OpenClaw -> Feishu
```

It registers three hook chains, but does **not** register LLM tools and does **not** call `/api/v1/chat`. Normal query answers are produced by the LLM bound to the OpenClaw session; manual ingest acknowledgements are returned directly by the plugin.

1. **Query injection** (`before_prompt_build`): calls `POST /api/v1/query` and injects `sources` + `instructions` into the current LLM turn as system context and a `<knowledge_bridge_context>` block.
2. **Manual ingest** (`before_dispatch` / `inbound_claim` / `before_agent_reply`): detects commands like `#入库`, `#kb add`, `/kb add`, `/kb-add` (with optional `--force`), submits to `POST /api/v1/ingest/manual`, directly returns the ingest result without dispatching to the LLM, then polls `GET /api/v1/ingest/status/{taskId}` when enabled and notifies the original session on terminal status, timeout, or repeated polling errors.
3. **Optional candidate ingest** (`message_received`, off by default): observes inbound messages and asynchronously calls `POST /api/v1/ingest/candidate` to evaluate whether content is worth saving.

## Key behaviors

- HMAC-SHA256 signing on `/api/v1/query` and `/api/v1/ingest/candidate`; `sharedSecret` must match the Knowledge Bridge service.
- Channel names containing `feishu` or `lark` are normalized to `feishu`.
- Manual ingest commands are deduplicated across hooks via a per-message cache.
- Status notifications prefer direct outbound adapter delivery, falling back to OpenClaw system event + heartbeat.
- The plugin does not filter by channel — every message reaching a hook is processed by the same logic.

## Audience

Maintainers integrating OpenClaw with a Knowledge Bridge backend. End users configure the plugin via `openclaw.json`; user-facing documentation lives in `README.md` (Chinese), and developer documentation lives in `docs/plugin-development.md`.
