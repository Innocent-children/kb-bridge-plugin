# Tech Stack & Build

## Language & runtime

- **TypeScript 5.9** compiled to ES2022, `module: NodeNext`, `moduleResolution: NodeNext`, `strict: true`.
- **Node.js 18+** runtime (requires global `fetch` and `AbortController`).
- ESM only (`"type": "module"` in `package.json`). Internal imports use explicit `.js` extensions (e.g., `import { resolveConfig } from "./config.js"`) because of NodeNext resolution.

## Host platform

- **OpenClaw** plugin host. Compatibility is pinned to `pluginApi >=2026.3.24-beta.2` and `minGatewayVersion 2026.3.24-beta.2` in `package.json` under the `openclaw` key.
- The plugin is registered via `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`. Hook events used: `before_prompt_build`, `inbound_claim`, `before_dispatch`, `before_agent_reply`, `message_received`.
- The OpenClaw runtime is the **only** peer dependency (`openclaw >=2026.3.24-beta.2`).

## Libraries

- No runtime dependencies beyond the OpenClaw SDK and Node built-ins.
- Crypto primitives come from `node:crypto` (`createHash`, `createHmac`, `randomUUID`).
- HTTP via the global `fetch`.

## Package manager

- **pnpm** (a `pnpm-lock.yaml` is committed). Do not introduce `npm` or `yarn` lockfiles.

## Project metadata files

- `package.json` — npm metadata, scripts, OpenClaw extension entry (`./dist/index.js`), compatibility ranges.
- `openclaw.plugin.json` — plugin manifest, activation, UI hints, and the user-facing `configSchema`.
- The `configSchema` is **duplicated** between `src/index.ts` (`buildJsonPluginConfigSchema`) and `openclaw.plugin.json`. Both must be updated in lockstep when adding, removing, or renaming config fields.
- `tsconfig.json` is `noEmit: true` for editor checks; `tsconfig.build.json` extends it and enables emit, declarations, and source maps to `dist/`.

## Common commands

```bash
# Install dependencies
pnpm install

# Type-check only (no emit)
pnpm run check

# Build to dist/ (used by OpenClaw via package.json -> openclaw.extensions)
pnpm run build
```

## Plugin install workflow on an OpenClaw host

```bash
cd kb-bridge-plugin
pnpm install
pnpm run build
openclaw plugins install ./
openclaw gateway restart
```

Always rebuild before `openclaw plugins install ./` — OpenClaw loads `dist/index.js`, not the TypeScript sources.

## Style conventions

- Strict TypeScript: prefer narrow types and `as const` over `any`. External payloads are validated through small `read*` / `as*Record` helpers (see `config.ts`, `messages.ts`, `kbBridgeClient.ts`) rather than type assertions.
- Logging: every log line is prefixed with `[kb-bridge]` via the `info` / `warn` helpers in `src/index.ts`. Use `debug(logger, config, msg)` for verbose lines that should only appear when `config.debug` is true.
- Errors from `fetch` are surfaced as `Error("KB-Bridge request failed: ...")` and never thrown into the OpenClaw turn — hooks catch and log warnings instead.
- HTTP signing: `/api/v1/query` and `/api/v1/ingest/candidate` are signed with `Base64(HMAC-SHA256(requestId + timestamp + SHA256Hex(body), sharedSecret))` and require `X-KB-RequestId`, `X-KB-Timestamp`, `X-KB-Signature`. `/api/v1/ingest/manual` and `/api/v1/ingest/status/{taskId}` are unsigned.
- Config schemas use `additionalProperties: false`. Removing or renaming a field is a breaking change for users' `openclaw.json`.
