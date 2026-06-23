# Raycast Relay

OpenAI-compatible HTTP relay for Raycast AI.

The working runtime is the Node server in this repo. Cloudflare Workers are intentionally not included because Raycast currently rejects Worker outbound subrequests with `403 Forbidden` when Cloudflare injects the `CF-Worker` header.

## Status

- `GET /v1/models` works from the Node relay.
- `POST /v1/chat/completions` works from the Node relay.
- Streaming and non-streaming OpenAI-compatible responses are supported.
- Cloudflare Workers cannot call Raycast directly at the moment.
- Cloudflare DNS, CDN, and Tunnel can still sit in front of a Node origin.

## Requirements

- Node.js 22 or newer.
- A Raycast account with Raycast AI access.
- Proxyman, Charles, or another HTTPS debugging proxy on macOS.

## Get Raycast Credentials

Enable SSL proxying for `backend.raycast.com`, then send a normal Raycast AI chat request. In Proxyman or Charles, find a successful request to:

```text
POST https://backend.raycast.com/api/v1/ai/chat_completions
```

Copy these request values:

- `Authorization: Bearer ...` -> `RAYCAST_BEARER_TOKEN`
- `X-Raycast-DeviceId` -> `RAYCAST_DEVICE_ID`
- `X-Raycast-Signature` -> decode this JWT and copy its `aid` -> `RAYCAST_AID`

Decode `RAYCAST_AID`:

```bash
node -e 'const jwt = process.argv[1]; console.log(JSON.parse(Buffer.from(jwt.split(".")[1], "base64url")).aid)' 'PASTE_X_RAYCAST_SIGNATURE_HERE'
```

The relay generates fresh `X-Raycast-Timestamp`, `X-Raycast-Signature-v2`, and `X-Raycast-Signature` values for every Raycast request. Do not reuse captured signatures.

`SIG_SECRET` is also required. It is the Raycast app signing key used to calculate request signatures. It is not user-specific, but this repo does not bundle it in source code.

## Local Setup

Create `.dev.vars` in the repo root. This file is gitignored.

```bash
RAYCAST_BEARER_TOKEN=your_captured_bearer_token
RAYCAST_DEVICE_ID=your_captured_device_id
RAYCAST_AID=your_decoded_aid
SIG_SECRET=your_current_signature_secret
API_KEY=local-test-key
RAYCAST_USER_AGENT=Raycast/1.104.20 (macOS Version 26.5.1 (Build 25F80))
RAYCAST_EXPERIMENTAL=chatBranching, mcpHTTPServer

# Optional model-list filters:
# INCLUDE_PREMIUM=false
# INCLUDE_DEPRECATED=false

```

Install and run:

```bash
npm run dev -- --host 127.0.0.1 --port 8788
```

OpenAI-compatible base URL:

```text
http://127.0.0.1:8788/v1
```

Use `API_KEY` as the API key if it is set. With the example above, use `local-test-key`.

## Test

Health:

```bash
curl -sS http://127.0.0.1:8788/health \
  -H 'Authorization: Bearer local-test-key'
```

Models:

```bash
curl -sS http://127.0.0.1:8788/v1/models \
  -H 'Authorization: Bearer local-test-key'
```

Non-streaming chat:

```bash
curl -sS http://127.0.0.1:8788/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local-test-key' \
  -d '{
    "model": "openai-gpt-5-mini",
    "messages": [{"role": "user", "content": "Reply with exactly: pong"}],
    "stream": false
  }'
```

Streaming chat:

```bash
curl -sS -N http://127.0.0.1:8788/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local-test-key' \
  -d '{
    "model": "baseten-zai-org/GLM-5.2",
    "messages": [{"role": "user", "content": "Reply with exactly: pong"}],
    "stream": true
  }'
```

## Deployment

### Plain Node

Set the same environment variables from `.dev.vars`, then run:

```bash
npm start
```

For public hosting, bind to all interfaces:

```bash
HOST=0.0.0.0 PORT=8788 npm start
```

This works on a VPS, Fly.io, Railway, Render, Northflank, systemd, Docker, or similar Node-capable hosts.

### Docker

Build and run directly:

```bash
docker build -t raycast-relay .
docker run --env-file .dev.vars -p 8788:8788 raycast-relay
```

Or use Docker Compose:

```bash
docker compose up --build
```

### Cloudflare

Do not deploy the Raycast-calling relay as a Cloudflare Worker. Raycast rejects Worker subrequests because Cloudflare injects `CF-Worker`, and Workers cannot remove it.

These Cloudflare setups are fine:

- Cloudflare DNS or CDN in front of a Node origin.
- Cloudflare Tunnel to a local or remote Node relay.
- A Worker that forwards to your Node relay, as long as the Worker does not call `backend.raycast.com` itself.

This repo is intentionally Node-only. It does not include a Worker entrypoint.

## API

### `GET /health`

Returns:

```json
{"status":"ok"}
```

### `GET /v1/models`

Fetches Raycast's current model list and returns OpenAI-compatible model objects.

Optional filters:

- `INCLUDE_PREMIUM=false` hides models where Raycast marks `requires_better_ai: true`.
- `INCLUDE_DEPRECATED=false` hides models where Raycast marks `availability: "deprecated"`.
- `ADVANCED=false` is still accepted as a backward-compatible alias for `INCLUDE_PREMIUM=false`.

### `POST /v1/chat/completions`

Accepts OpenAI-style chat requests:

```json
{
  "model": "openai-gpt-5-mini",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": false
}
```

Model IDs are mapped to Raycast provider/model pairs by prefix. Examples:

- `openai-gpt-5-mini` -> provider `openai`, model `gpt-5-mini`
- `baseten-zai-org/GLM-5.2` -> provider `baseten`, model `zai-org/GLM-5.2`
- `anthropic-claude-sonnet-4-6` -> provider `anthropic`, model `claude-sonnet-4-6`

## Troubleshooting

`403 Forbidden` from Raycast:

- If this happens from Cloudflare Workers, use the Node relay instead.
- If this happens from Node, refresh your Raycast login and recapture `RAYCAST_BEARER_TOKEN`, `RAYCAST_DEVICE_ID`, and `RAYCAST_AID`.
- If the request shape is correct but signatures fail, refresh `SIG_SECRET`.

SSE `unknown_api_error` from Raycast:

- Usually means `X-Raycast-Signature-v2` does not match the exact JSON payload sent to Raycast.
- Make sure `SIG_SECRET` is current if Raycast changed the signing secret.

Empty or failing `/v1/models`:

- `GET /api/v1/ai/models` is signed as if the request body were the literal string `{}` even though the HTTP request has no body. The Node relay already does this.

Client says invalid API key:

- Use the value of `API_KEY` as the OpenAI API key.
- Unset `API_KEY` if you want to disable relay-side authentication.

## Security

Raycast request credentials give access to your Raycast AI account. Keep `.dev.vars` private, use server-side environment variables in production, and rotate/re-login if a token was pasted into logs or chat.
