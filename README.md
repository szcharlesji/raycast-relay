# Raycast Relay for Cloudflare Workers

- [Setup](#setup)
- [Usage](#usage)
- [Use with Cursor](#use-with-cursor)
- [Available Models](#available_models)

This project provides a relay server that allows you to use Raycast AI models through an OpenAI-compatible API interface, deployed as a Cloudflare Worker.

## Deployment

### Prerequisites

- [Node.js](https://nodejs.org/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare account
- Raycast API credential (Bearer token)

### Setup

1. Clone this repository

```bash
git clone https://github.com/szcharlesji/raycast-relay
cd raycast-relay
```

3. Install dependencies:

```bash
npm install
```

3. Configure your environment variables:

```bash
# Install wrangler
npm install -g wrangler

# Set your Raycast credentials as secrets
wrangler secret put RAYCAST_BEARER_TOKEN

# Optionally set an API key for authentication
wrangler secret put API_KEY
```

4. Deploy to Cloudflare Workers:

```bash
npm run deploy
```

## Usage

Once deployed, you can use the worker as an OpenAI-compatible API endpoint:

```
https://your-worker-name.your-account.workers.dev/v1
```

### API Endpoints

- `GET /v1/models` - List available models
- `POST /v1/chat/completions` - Create a chat completion
- `GET /health` - Health check endpoint

### Authentication

If you've set an API_KEY, include it in your requests:

```
Authorization: Bearer your-api-key
```

## Use with Cursor

Raycast-relay supports Cursor, but a workaround is needed since Cursor has a [known issue](https://github.com/getcursor/cursor/issues/2871) with custom AI endpoints other than OpenAI. Thanks to [Vincent](https://github.com/missuo)'s suggestions

In order to use your relayed API endpoint in cursor:

1. Generate an API key in [OpenAI Platform](https://platform.openai.com/settings/organization/api-keys), you just need to use it to verify it
2. Verify this key in Cursor by putting it in `Cursor Settings > Models > OpenAI API Key` with the default OpenAI endpoint
3. Upload your wrangler secret `API_KEY` by `wrangler secret put API_KEY`, this needs to be the same key as the OpenAI key
4. Override your OpenAI Base URL with your wrangler endpoint
5. Save it
6. Add a custom model that you can find in the `/v1/models` endpoint or check out [Available Models](#available-models)
7. Done!

![cursor_edit](img/cursor_edit.png)

## Available Models

Here's a list of all the model IDs:

- ray1
- ray1-mini
- gpt-4
- gpt-4-turbo
- gpt-4o
- gpt-4o-mini
- o1-preview
- o1-mini
- o1-2024-12-17
- o3-mini
- claude-3-5-haiku-latest
- claude-3-5-sonnet-latest
- claude-3-7-sonnet-latest
- claude-3-opus-20240229
- sonar
- sonar-pro
- sonar-reasoning
- sonar-reasoning-pro
- llama-3.3-70b-versatile
- llama-3.1-8b-instant
- llama3-70b-8192
- meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo
- open-mistral-nemo
- mistral-large-latest
- mistral-small-latest
- codestral-latest
- deepseek-r1-distill-llama-70b
- gemini-1.5-flash
- gemini-1.5-pro
- gemini-2.0-flash
- gemini-2.0-flash-thinking-exp-01-21
- deepseek-ai/DeepSeek-R1
- grok-2-latest

## License

MIT
