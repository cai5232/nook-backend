# nook-backend

Small HTTP bridge between the nook frontend and Claude Code print mode.

## Required environment

- `ANTHROPIC_API_KEY`: Anthropic Console API key used only by the backend.
- `FRONTEND_ORIGIN`: optional comma-separated direct browser origins. The frontend proxy does not require it.
- `PORT`: supplied automatically by Zeabur.

Optional settings:

- `CLAUDE_MODEL`: Claude Code model override.
- `CLAUDE_SYSTEM_PROMPT`: replacement chat persona.
- `CLAUDE_BIN`: custom Claude executable path.
- `CLAUDE_WORKDIR`: writable session directory; defaults to `/tmp/nook-claude`.

## Endpoints

- `GET /health`
- `POST /api/chat` with `{ "message": "...", "sessionId": "..." }`

The service runs Claude Code with no built-in tools, denies MCP tools, disables permission prompts, and limits each request to one turn.
