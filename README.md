# Raycast Relay for Cloudflare Workers

This project provides a relay server that allows you to use Raycast AI models through an OpenAI-compatible API interface, deployed as a Cloudflare Worker.

## Features

- Exposes Raycast AI models through an OpenAI-compatible API
- Supports streaming responses
- Handles model information caching
- Optional API key authentication

## Deployment

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare account
- Raycast API credential (Bearer token)

### Setup

1. Clone this repository
2. Install dependencies:

```bash
npm install
```

3. Configure your environment variables:

```bash
# Set your Raycast credentials as secrets
wrangler secret put RAYCAST_BEARER_TOKEN

# Optionally set an API key for authentication
# Edit wrangler.jsonc and update the API_KEY value or set it as a secret
wrangler secret put API_KEY
```

4. Deploy to Cloudflare Workers:

```bash
npm run deploy
```

### Local Development

To run the worker locally:

```bash
npm run dev
```

## Usage

Once deployed, you can use the worker as an OpenAI-compatible API endpoint:

```
https://your-worker-name.your-account.workers.dev/v1/chat/completions
```

Use this URL as your base URL when configuring OpenAI API clients.

### API Endpoints

- `GET /v1/models` - List available models
- `POST /v1/chat/completions` - Create a chat completion
- `GET /health` - Health check endpoint

### Authentication

If you've set an API_KEY, include it in your requests:

```
Authorization: Bearer your-api-key
```

## License

MIT
