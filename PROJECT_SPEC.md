# CodexUI project specification

## Purpose

CodexUI is a self-hosted browser interface for the OpenAI Codex `app-server`.
One Node.js process serves the Vue application, owns one Codex child process,
and bridges browser requests to Codex JSON-RPC. The browser is a client of the
machine and user account running CodexUI; it does not contain Codex credentials.

The application is intended for one trusted user or a small trusted group. A
remotely reachable deployment requires an identity-aware gateway such as
Cloudflare Access. See [`SECURITY.md`](SECURITY.md).

## Runtime architecture

```text
Browser (Vue 3 SPA)
  ├─ HTTP RPC and application endpoints
  └─ WebSocket notifications, with SSE fallback
       ↓
Node.js / Express bridge
  ├─ authentication and static assets
  ├─ CodexUI state and scheduled-task services
  ├─ notification delivery
  └─ one Codex app-server child process
       ↓
newline-delimited JSON-RPC over stdin/stdout
```

The bridge multiplexes browser RPC calls through the child process. It also
forwards Codex notifications and server-initiated approval requests to connected
browsers. A singleton bridge is reused during Vite hot reloads in development.

## Technology

| Area | Implementation |
|---|---|
| Frontend | Vue 3, Vue Router, TypeScript |
| Styling | Tailwind CSS 4, Reka UI, Lucide icons |
| Development/build | Vite, vue-tsc, tsup |
| Server | Node.js 18+, Express 5, `ws` |
| Codex protocol | Codex `app-server` JSON-RPC |
| Scheduling | Local state store plus `rrule` |
| Notifications | Web Push and optional Telegram |

## Source layout

```text
src/
├── api/          Browser-side Codex and CodexUI API clients and normalizers
├── cli/          Production CLI entry point
├── components/   Conversations, composer, sidebar, hubs, and scheduled tasks
├── composables/  Shared reactive state and browser preferences
├── router/       Hash-based application routes
├── server/       Express bridge, Codex process, state stores, and notifications
├── types/        UI and protocol-facing TypeScript types
└── utils/        Shared presentation helpers
tests/            Node test suites for server and state behavior
documentation/    Codex app-server protocol reference and generated schemas
deployment/       Secret-free deployment templates
```

The main application state lives in `src/composables/useDesktopState.ts`.
Transport and normalization live in `src/api/`; host-authority operations live
in `src/server/`.

## User-facing routes

The SPA uses hash routing so it works behind a simple static/reverse-proxy setup.

| Route | View |
|---|---|
| `#/` | New chat / project picker |
| `#/thread/:threadId` | Conversation |
| `#/skills` | Skills Hub |
| `#/scheduled` | Scheduled tasks |
| `#/mcps` | MCP Hub |
| `#/plugins` | Plugins Hub |

## Bridge interfaces

The browser uses `/codex-api/*`. Important interfaces include:

- `POST /codex-api/rpc` for Codex JSON-RPC calls.
- `GET /codex-api/ws` (WebSocket upgrade) for the primary realtime channel.
- `GET /codex-api/events` for the SSE fallback.
- `/codex-api/server-requests/*` for approval requests.
- `/codex-api/automations/*` for scheduled-task state and execution.
- `/codex-api/push/*` and `/codex-api/telegram/config` for notifications.
- Project, title, thread-pagination, upload, and file-search helper endpoints.

The bridge exposes only operations required by the UI, but those operations are
high authority: Codex can read and modify files and run commands according to
its configured sandbox and approval policy.

## State and persistence

Codex owns conversations and account state under the configured `CODEX_HOME`.
CodexUI keeps its server-side state in per-user files selected by the runtime
configuration. Browser-only preferences such as theme, sidebar state, project
ordering, read markers, scroll position, and model choices use `localStorage`.

Runtime credentials and machine-specific settings do not belong in this
repository. A deployment should load a mode-`600` file outside the checkout,
normally `~/.config/codexui/.env`. Codex authentication, plugin sessions, and
OAuth tokens remain in their native per-user stores.

## Security invariants

- Never commit populated environment files, Codex authentication, OAuth tokens,
  API keys, browser profiles, notification keys, or runtime databases.
- Treat every authenticated CodexUI browser as having the authority of the
  operating-system user running the server.
- Do not expose the listener directly to the public internet.
- Use Cloudflare Access or an equivalent authenticated gateway for public
  hostnames; the built-in password is not a sufficient reverse-proxy boundary.
- Restrict filesystem mutations, including skill removal, to validated roots
  discovered by the server rather than browser-supplied arbitrary paths.

## Build and verification

```bash
npm ci
npm test
npm run build
```

`npm run build` type-checks and builds the frontend, then builds the production
CLI. The resulting service runs from `dist/` and `dist-cli/`.

When changing the Codex protocol bridge, consult
[`documentation/APP_SERVER_DOCUMENTATION.md`](documentation/APP_SERVER_DOCUMENTATION.md)
and the materialized schemas under `documentation/app-server-schemas/`.

## Attribution

This independent distribution began from the MIT-licensed `friuns/codexui`
codebase. The original copyright and license notice are preserved in
[`LICENSE`](LICENSE).
