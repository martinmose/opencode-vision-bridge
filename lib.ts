/**
 * vision-bridge — core logic and pure helpers.
 *
 * Everything testable lives here and is exported. The plugin entry point
 * (`index.ts`) imports from this module and exposes only the plugin function,
 * because OpenCode's plugin loader treats every export of the entry module as
 * a candidate plugin and rejects non-function exports.
 */

import type { PluginInput } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface VisionConfig {
  baseUrl: string
  apiKey: string
  model: string
  question: string
  timeoutMs: number
  retryDelayMs: number
  maxConcurrency: number
  maxTokens: number
  prefix: string
  skipProviders: string[]
  cacheSize: number
  debug: boolean
}

export const DEFAULT_SKIP_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "vertex",
  "bedrock",
  "xai",
  "azure",
]

/** Parse a positive integer env value, falling back when missing or invalid. */
export function parsePositiveInt(
  rawValue: string | undefined,
  fallback: number,
  min: number,
): number {
  if (rawValue === undefined || rawValue.trim() === "") return fallback
  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return Math.floor(parsed)
}

/** Resolve the provider skip-list from its raw env value. */
export function parseSkipProviders(rawValue: string | undefined): string[] {
  if (rawValue === undefined) return [...DEFAULT_SKIP_PROVIDERS]
  if (rawValue.trim().toLowerCase() === "none") return []
  return rawValue
    .split(",")
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean)
}

/** Build a validated config from an environment-like object. Pure. */
export function buildConfig(env: Record<string, string | undefined>): VisionConfig {
  return {
    baseUrl: (env.VISION_BASE_URL || "").replace(/\/+$/, ""),
    apiKey: env.VISION_API_KEY || "",
    model: env.VISION_MODEL || "google/gemma-4-31B-it",
    question: env.VISION_QUESTION || "Describe this image in detail.",
    timeoutMs: parsePositiveInt(env.VISION_TIMEOUT, 60000, 1000),
    retryDelayMs: parsePositiveInt(env.VISION_RETRY_DELAY_MS, 1000, 0),
    maxConcurrency: parsePositiveInt(env.VISION_MAX_CONCURRENCY, 3, 1),
    maxTokens: parsePositiveInt(env.VISION_MAX_TOKENS, 1024, 1),
    prefix: env.VISION_PREFIX ?? "[Image description]\n",
    skipProviders: parseSkipProviders(env.VISION_SKIP_PROVIDERS),
    cacheSize: parsePositiveInt(env.VISION_CACHE_SIZE, 100, 0),
    debug: env.VISION_DEBUG === "1",
  }
}

// ---------------------------------------------------------------------------
// Message / part inspection (pure)
// ---------------------------------------------------------------------------

export interface ImageFilePart {
  type: "file"
  mime: string
  url: string
}

interface MessageLike {
  info?: { role?: string; model?: { providerID?: string } }
  parts?: unknown[]
}

export function isImageFilePart(part: unknown): part is ImageFilePart {
  if (!part || typeof part !== "object") return false
  const candidate = part as Record<string, unknown>
  return (
    candidate.type === "file" &&
    typeof candidate.mime === "string" &&
    (candidate.mime as string).startsWith("image/") &&
    typeof candidate.url === "string" &&
    ((candidate.url as string).startsWith("data:") ||
      (candidate.url as string).startsWith("http"))
  )
}

/**
 * Determine the provider the request will be sent to. All messages in a single
 * transform call go to one model; we take the most recent message that carries
 * model info (assistant messages are most reliable, but any will do).
 */
export function extractActiveProvider(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const provider = (messages[index] as MessageLike)?.info?.model?.providerID
    if (typeof provider === "string" && provider) return provider.toLowerCase()
  }
  return undefined
}

export function shouldSkipProvider(
  provider: string | undefined,
  skipProviders: string[],
): boolean {
  if (skipProviders.length === 0) return false
  if (!provider) return false
  return skipProviders.includes(provider)
}

/**
 * Format a description for insertion into the message. Error markers (strings
 * starting with `[Image:`) are returned as-is so we don't double-wrap them
 * with the prefix or leak error details. The prefix is only applied to real
 * (success) descriptions.
 */
export function formatDescription(description: string, prefix: string): string {
  if (!prefix) return description
  if (description.startsWith("[Image:")) return description
  return `${prefix}${description}`
}

// ---------------------------------------------------------------------------
// Bounded concurrency (pure)
// ---------------------------------------------------------------------------

export async function withConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  if (tasks.length === 0) return results
  const workerCount = Math.max(1, Math.min(limit, tasks.length))
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++
      if (index >= tasks.length) return
      results[index] = await tasks[index]()
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

// ---------------------------------------------------------------------------
// LRU cache (description keyed on image URL)
// ---------------------------------------------------------------------------

/**
 * Minimal LRU cache. Image data URLs are large but identical images produce
 * identical URLs, so the URL itself is the key. Without this, the transform
 * hook re-describes every image on every conversation turn (the hook
 * reprocesses the full history each call), which is slow and costly.
 */
export class DescriptionCache {
  private store = new Map<string, string>()
  private readonly maxSize: number

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  get(key: string): string | undefined {
    const value = this.store.get(key)
    if (value === undefined) return undefined
    // refresh recency
    this.store.delete(key)
    this.store.set(key, value)
    return value
  }

  set(key: string, value: string): void {
    if (this.maxSize <= 0) return
    if (this.store.has(key)) this.store.delete(key)
    this.store.set(key, value)
    while (this.store.size > this.maxSize) {
      const oldest = this.store.keys().next().value
      if (oldest === undefined) break
      this.store.delete(oldest)
    }
  }

  get size(): number {
    return this.store.size
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error"

export type Logger = (
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>

export function makeLogger(
  client: PluginInput["client"] | undefined,
  debug: boolean,
): Logger | null {
  const logFn = client?.app?.log
  if (typeof logFn !== "function") return null
  return async (level, message, extra) => {
    if (level === "debug" && !debug) return
    try {
      await logFn({ body: { service: "vision-bridge", level, message, extra } })
    } catch {
      // logging is best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Vision call (timeout + single retry on 5xx / timeout)
// ---------------------------------------------------------------------------

export async function describeImage(
  imageUrl: string,
  config: VisionConfig,
  log: Logger | null,
): Promise<string> {
  if (!config.baseUrl) return "[Image: vision endpoint not configured]"
  if (!config.apiKey) return "[Image: vision API key not configured]"

  const requestBody = {
    model: config.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: config.question },
        ],
      },
    ],
    temperature: 0.7,
    top_p: 0.95,
    max_tokens: config.maxTokens,
  }

  let lastError = "unknown error"
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (response.status >= 500 && attempt === 0) {
        lastError = `HTTP ${response.status}`
        await log?.("warn", "retrying after server error", { status: response.status })
        if (config.retryDelayMs > 0) await delay(config.retryDelayMs)
        continue
      }
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "")
        lastError = `HTTP ${response.status}`
        await log?.("error", "request failed", {
          status: response.status,
          body: errorBody.slice(0, 300),
        })
        break
      }

      const rawBody = await response.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        lastError = "non-JSON response"
        await log?.("error", "vision endpoint returned non-JSON body", {
          body: rawBody.slice(0, 300),
        })
        break
      }

      const content = (parsed as { choices?: { message?: { content?: unknown } }[] })
        ?.choices?.[0]?.message?.content
      if (typeof content === "string" && content.length > 0) return content

      lastError = "unexpected response shape"
      await log?.("error", "unexpected response shape", {})
      break
    } catch (error) {
      clearTimeout(timer)
      const isAbort = error instanceof Error && error.name === "AbortError"
      if (isAbort && attempt === 0) {
        lastError = `timeout after ${config.timeoutMs}ms`
        await log?.("warn", "timeout, retrying", { timeout: config.timeoutMs })
        continue
      }
      lastError = isAbort ? `timeout after ${config.timeoutMs}ms` : String(error)
      break
    }
  }

  await log?.("error", "failed to describe image", { error: lastError })
  // Deliberately short and error-detail-free: this text reaches the model's
  // context. Full error details are in the log above.
  return "[Image: description unavailable]"
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// ---------------------------------------------------------------------------
// Core transform (pure aside from the documented in-place mutation)
// ---------------------------------------------------------------------------

interface ImageTarget {
  parts: unknown[]
  index: number
  url: string
}

export async function transformMessages(
  messages: unknown[],
  config: VisionConfig,
  log: Logger | null,
  cache: DescriptionCache | null = null,
): Promise<number> {
  const provider = extractActiveProvider(messages)
  if (shouldSkipProvider(provider, config.skipProviders)) {
    await log?.("debug", "skipping vision-capable provider", { provider })
    return 0
  }

  const targets: ImageTarget[] = []
  for (const message of messages) {
    const parts = (message as MessageLike)?.parts
    if (!Array.isArray(parts)) continue
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      if (isImageFilePart(part)) {
        targets.push({ parts, index, url: part.url })
      }
    }
  }

  if (targets.length === 0) return 0

  // Resolve a description for each target, using the cache when available so we
  // don't re-describe the same image on every conversation turn.
  const uncachedCount = cache
    ? targets.filter((target) => cache.get(target.url) === undefined).length
    : targets.length

  if (uncachedCount > 0) {
    await log?.("info", "describing images for text-only model", {
      total: targets.length,
      uncached: uncachedCount,
      provider: provider ?? "(unknown)",
    })
  } else {
    await log?.("debug", "all images served from cache", { count: targets.length })
  }

  const descriptions = await withConcurrency(
    targets.map((target) => async () => {
      const cached = cache?.get(target.url)
      if (cached !== undefined) return cached
      const description = await describeImage(target.url, config, log)
      // Only cache real descriptions, never error markers.
      if (cache && !description.startsWith("[Image:")) {
        cache.set(target.url, description)
      }
      return description
    }),
    config.maxConcurrency,
  )

  for (let index = 0; index < targets.length; index++) {
    const { parts, index: partIndex } = targets[index]
    // IN-PLACE mutation: replace the image FilePart with a TextPart.
    // Do NOT reassign the parts array (opencode #25754). The prefix is only
    // applied to successful descriptions; error markers pass through unchanged.
    parts[partIndex] = {
      type: "text",
      text: formatDescription(descriptions[index], config.prefix),
    }
  }

  await log?.("info", "replaced images with descriptions", { count: targets.length })
  return targets.length
}
