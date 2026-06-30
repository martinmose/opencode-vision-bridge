# opencode-vision-bridge

An [OpenCode](https://opencode.ai) plugin that lets **text-only models handle image uploads**.

When you attach an image to a conversation with a model that doesn't support
vision (e.g. a text-only LLM), OpenCode normally errors with "this model does
not support image input." This plugin intercepts the image **before** it
reaches the model, sends it to a vision model (any OpenAI-compatible endpoint),
and replaces it in place with a text description. The text model then just
"sees" prose — no tool call required, fully transparent.

## How it works

```
you upload an image
        │
        ▼
OpenCode builds messages with an image FilePart
        │
        ▼
opencode-vision-bridge (experimental.chat.messages.transform hook)
        │  • detects image FileParts
        │  • skips vision-capable providers (anthropic, openai, …)
        │  • calls a vision model with bounded concurrency + retry
        │  • mutates the part IN PLACE → TextPart with the description
        ▼
text-only model receives prose like:
        "[Image description]\nA statue in front of a city skyline..."
```

The hook contract has two sharp edges, both handled:
- `input` is `{}` — everything is read from `output.messages`
- `message.parts` must be mutated **in place**; reassigning the array is a
  silent no-op (see [opencode#25754](https://github.com/anomalyco/opencode/issues/25754))

## Install

### From npm (recommended)

Add to your `opencode.json` (global or per-project):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-vision-bridge"]
}
```

OpenCode installs the plugin automatically on next launch via Bun.

### From source (for development)

Clone this repo. The included `opencode.jsonc` loads the plugin from local
source:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./index.ts"]
}
```

## Configure

The plugin reads config from `process.env`. Set these however your shell
normally provides env vars (export them, use direnv, etc.). For this repo's
dev setup, the Flox `on-activate` hook sources a gitignored `.env` — copy
`.env.example` to `.env` and fill in your values:

```bash
VISION_BASE_URL=https://router.huggingface.co/v1
VISION_MODEL=google/gemma-4-31B-it:novita
VISION_API_KEY=replace-me
```

### All options

| Variable                 | Required | Default                          | Notes                                            |
| ------------------------ | -------- | -------------------------------- | ------------------------------------------------ |
| `VISION_BASE_URL`        | yes      | —                                | OpenAI-compatible base URL                       |
| `VISION_MODEL`           | yes      | `google/gemma-4-31B-it`          | Any model id your endpoint serves                |
| `VISION_API_KEY`         | yes      | —                                | Bearer token for the endpoint                    |
| `VISION_QUESTION`        | no       | `Describe this image in detail.` | Question sent to the vision model                |
| `VISION_TIMEOUT`         | no       | `60000`                          | Per-request timeout in ms (min 1000)             |
| `VISION_RETRY_DELAY_MS`  | no       | `1000`                           | Backoff before a 5xx/timeout retry, in ms (min 0)|
| `VISION_MAX_CONCURRENCY` | no       | `3`                              | Max parallel vision calls (min 1)                |
| `VISION_MAX_TOKENS`      | no       | `1024`                           | Max tokens for the description (min 1)           |
| `VISION_PREFIX`          | no       | `[Image description]\n`          | Prefix prepended to descriptions; `""` for none  |
| `VISION_SKIP_PROVIDERS`  | no       | `anthropic,openai,google,vertex,bedrock,xai,azure` | Comma-separated provider IDs to leave untouched; `none` to process every model |
| `VISION_DEBUG`           | no       | —                                | Set to `1` to enable debug-level logs            |

### Choosing a vision model

The plugin is model-agnostic — any OpenAI-compatible vision endpoint works.
Tested with `google/gemma-4-31B-it`. Set `VISION_BASE_URL` and `VISION_MODEL`
to match your endpoint.

### Skipping vision-capable providers

When you're using a model that already handles images natively (Claude Opus 4.8,
GPT-5.5, Gemini 3, …), the plugin leaves the image alone — replacing a real image
with a description would degrade quality. The default skip list covers the
common vision-capable providers. Override with `VISION_SKIP_PROVIDERS=openai,custom`
or disable entirely with `VISION_SKIP_PROVIDERS=none`.

## Develop

This repo uses [Flox](https://flox.dev) for a reproducible dev environment
(Node.js + pnpm). Tests use Node's built-in test runner — no extra test
framework dependency.

```bash
flox activate                              # enter the dev env
pnpm install                               # install type deps (first time)
node --test tests/vision-bridge.test.ts    # run the unit tests (44 tests)
node_modules/.bin/tsc --noEmit             # typecheck
```

### Project layout

```
index.ts                            # plugin entry point (exports only the plugin)
lib.ts                              # config, helpers, core logic (exported, tested)
tests/
  vision-bridge.test.ts             # unit tests with node:test
.env.example                        # copy to .env (sourced by the flox hook)
.gitignore                          # ignores .env and node_modules/
.flox/                              # Flox env manifest (Node.js + pnpm + .env hook)
package.json                        # npm package metadata + dev type deps
tsconfig.json                       # TypeScript config for typechecking
opencode.jsonc                      # local dev: loads plugin from ./index.ts
```

### Design notes

- **Side-effect-free `lib.ts`** — config is read from `process.env` inside the
  plugin initializer (in `index.ts`), so importing `lib.ts` for tests triggers
  no I/O.
- **Clean entry point** — `index.ts` exports only the plugin function;
  OpenCode's loader rejects entry modules with non-function exports.
- **Pure helpers exported** — `buildConfig`, `parsePositiveInt`,
  `parseSkipProviders`, `isImageFilePart`, `extractActiveProvider`,
  `shouldSkipProvider`, `formatDescription`, `withConcurrency`,
  `describeImage`, `transformMessages` — all unit-testable in isolation.
- **Graceful degradation** — on failure the model receives a short
  `[Image: description unavailable]` marker. Error details go to the log only,
  never to the model's context (no error-string leakage).
- **Bounded concurrency** — many images in one message are described in
  parallel up to `VISION_MAX_CONCURRENCY`; order is preserved.
- **Single retry** — one retry on 5xx or timeout, with configurable backoff.

## License

MIT
