# nook-backend

Small HTTP bridge between the nook frontend and Claude Code print mode. It can call an existing Claude Code installation on a VPS by setting `CLAUDE_BIN` to the path printed by `command -v claude`.

## Required environment

- `NOOK_BRIDGE_TOKEN`: a long random secret shared only with the frontend server through its `BRIDGE_TOKEN` environment variable.
- Claude authentication: either log in to Claude Code as the Linux user that runs this service, set `CLAUDE_CODE_OAUTH_TOKEN`, or set `ANTHROPIC_API_KEY`.
- `FRONTEND_ORIGIN`: optional comma-separated direct browser origins. The frontend proxy does not require it.
- `PORT`: supplied automatically by Zeabur.
- `GATEWAY_DATA_DIR`: a persistent mounted directory for conversations, Claude
  session ids, uploaded images, recognition results, and surfaced-memory cards.
  Defaults to `$CLAUDE_WORKDIR/gateway`; mount this directory in production so
  redeploying or restarting the service does not discard a conversation.

Optional settings:

- `CLAUDE_MODEL`: Claude Code model override.
- `CLAUDE_SYSTEM_PROMPT`: replacement chat persona.
- `CLAUDE_BIN`: existing Claude executable path on the VPS, for example the output of `command -v claude`.
- `CLAUDE_WORKDIR`: writable session directory; defaults to `/tmp/nook-claude`.
- `NOOK_MAX_IMAGE_BYTES`: maximum accepted image size; defaults to 10MB.
- `NOCTURNE_API_URL`: Nocturne service root URL. Nook calls its direct server API every turn; it does not use MCP.
- `NOCTURNE_API_TOKEN`: dedicated Bearer token shared only between the nook backend and Nocturne.
- `NOCTURNE_TIMEOUT_MS`: direct API request timeout; defaults to `8000`.
- `NOCTURNE_RECALL_LIMIT`: maximum related memories requested each turn; defaults to `8`.
- `NOCTURNE_CONTEXT_CHARS`: maximum memory context injected into Claude; defaults to `12000`.

## Endpoints

- `GET /health`
- `GET /api/conversations/:conversationId`
- `POST /api/uploads` with a base64 image data URL; returns a durable attachment
  URL.
- `GET /api/uploads/:attachmentId`
- `POST /api/chat` with `conversationId`, `message`, and optional attachment
  ids.

The gateway is the source of truth for conversation context. It writes the user
message before generation, reads its own recent context on every request, then
writes the assistant reply, token/cache metrics, image recognition descriptions,
and the reusable Claude session id. Images are stored beneath the persistent
gateway directory and Claude Code receives their local paths with
`--add-dir`; no separate visual API is used. The backend never asks the model
to autonomously add or update long-term memory. Existing Nocturne recall remains
read-only and is saved as a separate surfaced-memory card for the cloud UI.

The HTTP gateway itself stays alive between requests. Claude Code print mode is
still a one-request CLI invocation, but each persisted conversation resumes its
last Claude session when available, retaining the model-side cache/session rather
than starting a blank conversation.

The frontend service needs two environment variables:

- `BACKEND_URL`: the HTTPS URL of this VPS bridge.
- `BRIDGE_TOKEN`: the same value as the backend's `NOOK_BRIDGE_TOKEN`.
