# AGENTS.md

Guidance for AI agents (and humans) working on this repo.

## What this is

`opencode-vision-bridge` is an [OpenCode](https://opencode.ai) plugin that
lets text-only models handle image uploads. It uses the
`experimental.chat.messages.transform` hook to intercept image FileParts,
describe them via a vision model, and replace them with TextParts before the
message reaches the LLM.

## Dev environment

Uses [Flox](https://flox.dev) for reproducibility. Node.js + pnpm inside flox.

```bash
flox activate                    # enter dev env
pnpm install                     # install type deps (first time only)
node --test tests/vision-bridge.test.ts   # run tests (44 tests)
node_modules/.bin/tsc --noEmit   # typecheck
```

Always run both `node --test` and `tsc --noEmit` before considering work done.

## Code layout

- `index.ts` — the npm package entry point. Exports **only** the plugin
  function as `default`. OpenCode's loader treats every export of the entry
  module as a candidate plugin and rejects non-function exports, so keep this
  file export-clean.
- `lib.ts` — all config, helpers, and core logic. Zero import-time side
  effects. Everything here is exported and unit-tested.
- `tests/vision-bridge.test.ts` — unit tests with `node:test`, importing from
  `lib.ts`.
- `opencode.jsonc` — local dev config that loads the plugin from `./index.ts`.
  End users install from npm instead: `"plugin": ["opencode-vision-bridge"]`.
- `.env` / `.env.example` — per-developer config + secret, gitignored, sourced
  by the flox `on-activate` hook so OpenCode inherits the `VISION_*` vars.

## Conventions

- **No short variable names.** Use `config` not `cfg`, `error` not `e`,
  `response` not `resp`. Loop indices like `index` are fine.
- **No comments unless asked.** Code should be self-documenting.
- **Side-effect-free `lib.ts`.** Config is read from `process.env` in the
  plugin initializer (`index.ts`), not at module top level. This keeps `lib.ts`
  pure and its tests I/O-free.
- **Pure helpers exported.** Anything testable should be a pure function.
- **In-place mutation only** for `message.parts`. Never reassign the array
  (opencode#25754). The hook's `input` is `{}`; read from `output.messages`.

## Config

All config is model-agnostic. Env vars are prefixed `VISION_*`. See the README
for the full table.

## Before committing

1. `node --test tests/vision-bridge.test.ts` — all tests pass
2. `node_modules/.bin/tsc --noEmit` — no type errors
3. Never commit `.env` (it contains secrets)
4. `node_modules/` is gitignored — don't commit it
