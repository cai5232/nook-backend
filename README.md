# nook-backend

Small HTTP bridge between the nook frontend and Claude Code print mode. It can call an existing Claude Code installation on a VPS by setting `CLAUDE_BIN` to the path printed by `command -v claude`.

## Required environment

- `NOOK_BRIDGE_TOKEN`: a long random secret shared only with the frontend server through its `BRIDGE_TOKEN` environment variable.
- Claude authentication: either log in to Claude Code as the Linux user that runs this service, set `CLAUDE_CODE_OAUTH_TOKEN`, or set `ANTHROPIC_API_KEY`.
- `FRONTEND_ORIGIN`: optional comma-separated direct browser origins. The frontend proxy does not require it.
- `PORT`: supplied automatically by Zeabur.

Optional settings:

- `CLAUDE_MODEL`: Claude Code model override.
- `CLAUDE_SYSTEM_PROMPT`: replacement chat persona.
- `CLAUDE_BIN`: existing Claude executable path on the VPS, for example the output of `command -v claude`.
- `CLAUDE_WORKDIR`: writable session directory; defaults to `/tmp/nook-claude`.
- `NOCTURNE_API_URL`: Nocturne service root URL. Nook calls its direct server API every turn; it does not use MCP.
- `NOCTURNE_API_TOKEN`: dedicated Bearer token shared only between the nook backend and Nocturne.
- `NOCTURNE_TIMEOUT_MS`: direct API request timeout; defaults to `8000`.
- `NOCTURNE_RECALL_LIMIT`: maximum related memories requested each turn; defaults to `8`.
- `NOCTURNE_CONTEXT_CHARS`: maximum memory context injected into Claude; defaults to `12000`.

## Endpoints

- `GET /health`
- `POST /api/chat` with `message`, up to 30 prior dialogue messages in `history`, and optional `compressContext` plus `compressionMessages` for a 20-message timeline boundary.

The service runs Claude Code with no built-in tools and limits each request to one turn. Every request receives Beijing time, up to 15 prior dialogue rounds, and Nocturne's core plus related memories. Claude decides whether a durable fact is worth recording, while the backend performs all direct HTTP reads and writes and exposes successful recall/store events to the frontend. Unfinished threads are stored as `unresolved`; every requested 20-message boundary is stored as a `window` timeline summary. Nocturne's `/mcp` endpoint remains independent and available to other clients.

The frontend service needs two environment variables:

- `BACKEND_URL`: the HTTPS URL of this VPS bridge.
- `BRIDGE_TOKEN`: the same value as the backend's `NOOK_BRIDGE_TOKEN`.
