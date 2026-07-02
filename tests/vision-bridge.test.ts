import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  buildConfig,
  DEFAULT_SKIP_PROVIDERS,
  DescriptionCache,
  describeImage,
  extractActiveModelId,
  extractActiveProvider,
  formatDescription,
  isImageFilePart,
  parseEnableModels,
  parsePositiveInt,
  parseSkipProviders,
  shouldSkipProvider,
  transformMessages,
  withConcurrency,
  type VisionConfig,
} from "../lib.ts"

const baseConfig: VisionConfig = {
  baseUrl: "https://example.test/v1",
  apiKey: "key",
  model: "test-model",
  question: "Describe.",
  timeoutMs: 1000,
  retryDelayMs: 0,
  maxConcurrency: 2,
  maxTokens: 128,
  prefix: "[Image description]\n",
  skipProviders: [],
  enableModels: [],
  cacheSize: 100,
  debug: false,
}

describe("parsePositiveInt", () => {
  test("uses fallback when unset", () => {
    assert.strictEqual(parsePositiveInt(undefined, 60000, 1000), 60000)
  })
  test("uses fallback when empty", () => {
    assert.strictEqual(parsePositiveInt("", 60000, 1000), 60000)
  })
  test("uses fallback when NaN", () => {
    assert.strictEqual(parsePositiveInt("foo", 60000, 1000), 60000)
  })
  test("uses fallback when below min", () => {
    assert.strictEqual(parsePositiveInt("0", 3, 1), 3)
    assert.strictEqual(parsePositiveInt("500", 60000, 1000), 60000)
  })
  test("accepts valid values and floors them", () => {
    assert.strictEqual(parsePositiveInt("4", 3, 1), 4)
    assert.strictEqual(parsePositiveInt("4.9", 3, 1), 4)
  })
})

describe("parseSkipProviders", () => {
  test("defaults when unset", () => {
    assert.deepStrictEqual(parseSkipProviders(undefined), DEFAULT_SKIP_PROVIDERS)
  })
  test("returns its own copy of the defaults", () => {
    const a = parseSkipProviders(undefined)
    a.push("mutated")
    assert.deepStrictEqual(parseSkipProviders(undefined), DEFAULT_SKIP_PROVIDERS)
  })
  test("'none' disables skipping", () => {
    assert.deepStrictEqual(parseSkipProviders("none"), [])
    assert.deepStrictEqual(parseSkipProviders(" NONE "), [])
  })
  test("parses and normalizes a custom list", () => {
    assert.deepStrictEqual(parseSkipProviders("OpenAI, anthropic ,"), ["openai", "anthropic"])
  })
  test("empty string means skip nothing", () => {
    assert.deepStrictEqual(parseSkipProviders(""), [])
  })
})

describe("buildConfig", () => {
  test("applies defaults", () => {
    const cfg = buildConfig({})
    assert.strictEqual(cfg.baseUrl, "https://api.zeldoc.ai/v1")
    assert.strictEqual(cfg.model, "zeldoc/gemma-4-31b")
    assert.strictEqual(cfg.timeoutMs, 60000)
    assert.strictEqual(cfg.maxConcurrency, 3)
    assert.strictEqual(cfg.prefix, "[Image description]\n")
    assert.deepStrictEqual(cfg.skipProviders, DEFAULT_SKIP_PROVIDERS)
    assert.strictEqual(cfg.cacheSize, 100)
  })
  test("uses VISION_API_KEY as the bearer token, falling back to ZELDOC_API_KEY", () => {
    assert.strictEqual(buildConfig({ VISION_API_KEY: "key" }).apiKey, "key")
    assert.strictEqual(buildConfig({ ZELDOC_API_KEY: "zkey" }).apiKey, "zkey")
    assert.strictEqual(buildConfig({ VISION_API_KEY: "key", ZELDOC_API_KEY: "zkey" }).apiKey, "key")
    assert.strictEqual(buildConfig({}).apiKey, "")
  })
  test("trims trailing slashes from base url", () => {
    assert.strictEqual(buildConfig({ VISION_BASE_URL: "https://x/v1//" }).baseUrl, "https://x/v1")
  })
  test("clamps invalid numbers", () => {
    const cfg = buildConfig({ VISION_TIMEOUT: "nope", VISION_MAX_CONCURRENCY: "0" })
    assert.strictEqual(cfg.timeoutMs, 60000)
    assert.strictEqual(cfg.maxConcurrency, 3)
  })
  test("parses retry delay with min 0", () => {
    assert.strictEqual(buildConfig({ VISION_RETRY_DELAY_MS: "0" }).retryDelayMs, 0)
    assert.strictEqual(buildConfig({ VISION_RETRY_DELAY_MS: "-5" }).retryDelayMs, 1000)
    assert.strictEqual(buildConfig({}).retryDelayMs, 1000)
  })
  test("empty prefix is respected", () => {
    assert.strictEqual(buildConfig({ VISION_PREFIX: "" }).prefix, "")
  })
  test("parses enable models", () => {
    assert.deepStrictEqual(parseEnableModels(undefined), [])
    assert.deepStrictEqual(parseEnableModels(""), [])
    assert.deepStrictEqual(parseEnableModels("zeldoc/z-code"), ["zeldoc/z-code"])
    assert.deepStrictEqual(parseEnableModels("Zeldoc/Z-Code, anthropic/claude-opus-4-8"), ["zeldoc/z-code", "anthropic/claude-opus-4-8"])
  })
})

describe("isImageFilePart", () => {
  test("accepts data url image file parts", () => {
    assert.strictEqual(
      isImageFilePart({ type: "file", mime: "image/png", url: "data:image/png;base64,AA" }),
      true,
    )
  })
  test("accepts http url image file parts", () => {
    assert.strictEqual(
      isImageFilePart({ type: "file", mime: "image/jpeg", url: "https://x/y.jpg" }),
      true,
    )
  })
  test("rejects text parts", () => {
    assert.strictEqual(isImageFilePart({ type: "text", text: "hi" }), false)
  })
  test("rejects non-image files", () => {
    assert.strictEqual(
      isImageFilePart({ type: "file", mime: "application/pdf", url: "data:application/pdf;base64,AA" }),
      false,
    )
  })
  test("rejects junk", () => {
    assert.strictEqual(isImageFilePart(null), false)
    assert.strictEqual(isImageFilePart(42), false)
    assert.strictEqual(isImageFilePart({ type: "file" }), false)
  })
})

describe("extractActiveProvider", () => {
  test("returns lowercased provider from most recent message that has it", () => {
    const messages = [
      { info: { model: { providerID: "Anthropic" } } },
      { info: { role: "user" } },
      { info: { model: { providerID: "OpenAI" } } },
    ]
    assert.strictEqual(extractActiveProvider(messages), "openai")
  })
  test("returns undefined when no model info present", () => {
    assert.strictEqual(extractActiveProvider([{ info: { role: "user" } }, {}]), undefined)
  })
  test("returns undefined for an empty message array", () => {
    assert.strictEqual(extractActiveProvider([]), undefined)
  })
})

describe("extractActiveModelId", () => {
  test("returns lowercased provider/model from most recent message", () => {
    const messages = [
      { info: { model: { providerID: "Zeldoc", modelID: "Z-Code" } } },
      { info: { role: "user" } },
      { info: { model: { providerID: "Anthropic", modelID: "claude-opus-4-8" } } },
    ]
    assert.strictEqual(extractActiveModelId(messages), "anthropic/claude-opus-4-8")
  })
  test("returns undefined when modelID missing", () => {
    assert.strictEqual(
      extractActiveModelId([{ info: { model: { providerID: "openai" } } }]),
      undefined,
    )
  })
  test("returns undefined when no model info present", () => {
    assert.strictEqual(extractActiveModelId([{ info: { role: "user" } }]), undefined)
  })
  test("returns undefined for an empty message array", () => {
    assert.strictEqual(extractActiveModelId([]), undefined)
  })
})

describe("formatDescription", () => {
  test("prepends prefix to a normal description", () => {
    assert.strictEqual(
      formatDescription("a cat", "[Image description]\n"),
      "[Image description]\na cat",
    )
  })
  test("returns description unchanged when prefix is empty", () => {
    assert.strictEqual(formatDescription("a cat", ""), "a cat")
  })
  test("does not prefix error markers", () => {
    const marker = "[Image: description unavailable]"
    assert.strictEqual(formatDescription(marker, "[Image description]\n"), marker)
  })
})

describe("shouldSkipProvider", () => {
  test("skips configured providers", () => {
    assert.strictEqual(shouldSkipProvider("openai", ["openai", "anthropic"]), true)
  })
  test("does not skip others", () => {
    assert.strictEqual(shouldSkipProvider("novita", ["openai"]), false)
  })
  test("never skips when list empty or provider unknown", () => {
    assert.strictEqual(shouldSkipProvider("openai", []), false)
    assert.strictEqual(shouldSkipProvider(undefined, ["openai"]), false)
  })
})

describe("withConcurrency", () => {
  test("preserves order and runs all tasks", async () => {
    const tasks = [10, 20, 30].map((n) => async () => {
      await new Promise((r) => setTimeout(r, n))
      return n
    })
    assert.deepStrictEqual(await withConcurrency(tasks, 2), [10, 20, 30])
  })
  test("respects the concurrency limit", async () => {
    let active = 0
    let peak = 0
    const tasks = Array.from({ length: 6 }, () => async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return 1
    })
    await withConcurrency(tasks, 2)
    assert.ok(peak <= 2, `peak concurrency ${peak} exceeded limit 2`)
  })
  test("handles empty task list", async () => {
    assert.deepStrictEqual(await withConcurrency([], 3), [])
  })
  test("never spawns zero workers", async () => {
    assert.deepStrictEqual(await withConcurrency([async () => 1], 0), [1])
  })
})

describe("DescriptionCache", () => {
  test("stores and retrieves values", () => {
    const cache = new DescriptionCache(2)
    cache.set("a", "1")
    assert.strictEqual(cache.get("a"), "1")
    assert.strictEqual(cache.get("missing"), undefined)
  })
  test("evicts least-recently-used past max size", () => {
    const cache = new DescriptionCache(2)
    cache.set("a", "1")
    cache.set("b", "2")
    cache.get("a") // refresh a, so b is now LRU
    cache.set("c", "3") // should evict b
    assert.strictEqual(cache.get("a"), "1")
    assert.strictEqual(cache.get("b"), undefined)
    assert.strictEqual(cache.get("c"), "3")
  })
  test("size 0 disables caching", () => {
    const cache = new DescriptionCache(0)
    cache.set("a", "1")
    assert.strictEqual(cache.get("a"), undefined)
    assert.strictEqual(cache.size, 0)
  })
})

// --- fetch mocking --------------------------------------------------------
function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

async function withMockFetch<T>(
  mock: typeof fetch,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

describe("describeImage", () => {
  test("returns content on success", async () => {
    const mock = (async () =>
      jsonResponse({ choices: [{ message: { content: "a cat" } }] })) as typeof fetch
    await withMockFetch(mock, async () => {
      const out = await describeImage("data:image/png;base64,AA", baseConfig, null)
      assert.strictEqual(out, "a cat")
    })
  })

  test("guards missing config", async () => {
    const out = await describeImage("x", { ...baseConfig, baseUrl: "" }, null)
    assert.ok(out.startsWith("[Image:"), `expected error marker, got: ${out}`)
  })

  test("retries once on 5xx then fails gracefully", async () => {
    let calls = 0
    const mock = (async () => {
      calls++
      return new Response("boom", { status: 502 })
    }) as typeof fetch
    await withMockFetch(mock, async () => {
      const out = await describeImage("x", { ...baseConfig, retryDelayMs: 0 }, null)
      assert.strictEqual(calls, 2)
      assert.strictEqual(out, "[Image: description unavailable]")
    })
  })

  test("handles non-JSON 200 body", async () => {
    const mock = (async () => new Response("<html>", { status: 200 })) as typeof fetch
    await withMockFetch(mock, async () => {
      const out = await describeImage("x", baseConfig, null)
      assert.strictEqual(out, "[Image: description unavailable]")
    })
  })

  test("handles unexpected JSON shape", async () => {
    const mock = (async () => jsonResponse({ nope: true })) as typeof fetch
    await withMockFetch(mock, async () => {
      const out = await describeImage("x", baseConfig, null)
      assert.strictEqual(out, "[Image: description unavailable]")
    })
  })
})

// --- transformMessages -----------------------------------------------------

describe("transformMessages", () => {
  const successFetch = (async () =>
    jsonResponse({ choices: [{ message: { content: "described" } }] })) as typeof fetch

  test("replaces image parts in place with text parts", async () => {
    const parts: unknown[] = [
      { type: "file", mime: "image/png", url: "data:image/png;base64,AA" },
      { type: "text", text: "hi" },
    ]
    const messages = [{ info: { role: "user" }, parts }]
    await withMockFetch(successFetch, async () => {
      const count = await transformMessages(messages, baseConfig, null)
      assert.strictEqual(count, 1)
      // same array reference (in-place), first element now a text part
      assert.strictEqual(messages[0].parts, parts)
      assert.strictEqual((parts[0] as { type: string }).type, "text")
      assert.strictEqual((parts[0] as { text: string }).text, "[Image description]\ndescribed")
      assert.strictEqual((parts[1] as { type: string }).type, "text")
    })
  })

  test("skips vision-capable providers", async () => {
    const parts: unknown[] = [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA" }]
    const messages = [{ info: { model: { providerID: "anthropic" } }, parts }]
    const customConfig = { ...baseConfig, skipProviders: ["anthropic"] }
    await withMockFetch(successFetch, async () => {
      const count = await transformMessages(messages, customConfig, null)
      assert.strictEqual(count, 0)
      assert.strictEqual((parts[0] as { type: string }).type, "file")
    })
  })

  test("enable-list takes priority over skip-list", async () => {
    const parts: unknown[] = [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA" }]
    const messages = [{ info: { model: { providerID: "anthropic", modelID: "claude-opus-4-8" } }, parts }]
    const enableConfig = { ...baseConfig, enableModels: ["anthropic/claude-opus-4-8"], skipProviders: ["anthropic"] }
    await withMockFetch(successFetch, async () => {
      const count = await transformMessages(messages, enableConfig, null)
      assert.strictEqual(count, 1)
      assert.strictEqual((parts[0] as { type: string }).type, "text")
    })
  })

  test("enable-list skips non-matching models", async () => {
    const parts: unknown[] = [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA" }]
    const messages = [{ info: { model: { providerID: "anthropic", modelID: "claude-opus-4-8" } }, parts }]
    const enableConfig = { ...baseConfig, enableModels: ["zeldoc/z-code"] }
    await withMockFetch(successFetch, async () => {
      const count = await transformMessages(messages, enableConfig, null)
      assert.strictEqual(count, 0)
      assert.strictEqual((parts[0] as { type: string }).type, "file")
    })
  })

  test("no-op when there are no images", async () => {
    const messages = [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }]
    await withMockFetch(successFetch, async () => {
      assert.strictEqual(await transformMessages(messages, baseConfig, null), 0)
    })
  })

  test("omits prefix when configured empty", async () => {
    const parts: unknown[] = [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA" }]
    const messages = [{ info: { role: "user" }, parts }]
    await withMockFetch(successFetch, async () => {
      await transformMessages(messages, { ...baseConfig, prefix: "" }, null)
      assert.strictEqual((parts[0] as { text: string }).text, "described")
    })
  })

  test("does not prefix error markers in the final text", async () => {
    const failingFetch = (async () => new Response("boom", { status: 502 })) as typeof fetch
    const parts: unknown[] = [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA" }]
    const messages = [{ info: { role: "user" }, parts }]
    await withMockFetch(failingFetch, async () => {
      await transformMessages(messages, { ...baseConfig, retryDelayMs: 0 }, null)
      const text = (parts[0] as { text: string }).text
      assert.strictEqual(text, "[Image: description unavailable]")
      assert.strictEqual(text.startsWith("[Image description]"), false)
    })
  })

  test("caches descriptions so repeated turns don't re-fetch", async () => {
    let calls = 0
    const countingFetch = (async () => {
      calls++
      return jsonResponse({ choices: [{ message: { content: "described" } }] })
    }) as typeof fetch
    const cache = new DescriptionCache(10)
    const url = "data:image/png;base64,AA"

    await withMockFetch(countingFetch, async () => {
      // Turn 1: a fresh image is described (one fetch).
      const parts1: unknown[] = [{ type: "file", mime: "image/png", url }]
      await transformMessages([{ info: { role: "user" }, parts: parts1 }], baseConfig, null, cache)
      // Turn 2: same image in history — served from cache, no new fetch.
      const parts2: unknown[] = [{ type: "file", mime: "image/png", url }]
      await transformMessages([{ info: { role: "user" }, parts: parts2 }], baseConfig, null, cache)
    })

    assert.strictEqual(calls, 1)
  })

  test("does not cache error markers", async () => {
    let calls = 0
    const failingFetch = (async () => {
      calls++
      return new Response("boom", { status: 502 })
    }) as typeof fetch
    const cache = new DescriptionCache(10)
    const url = "data:image/png;base64,AA"

    await withMockFetch(failingFetch, async () => {
      const parts1: unknown[] = [{ type: "file", mime: "image/png", url }]
      await transformMessages(
        [{ info: { role: "user" }, parts: parts1 }],
        { ...baseConfig, retryDelayMs: 0 },
        null,
        cache,
      )
      const parts2: unknown[] = [{ type: "file", mime: "image/png", url }]
      await transformMessages(
        [{ info: { role: "user" }, parts: parts2 }],
        { ...baseConfig, retryDelayMs: 0 },
        null,
        cache,
      )
    })

    // Two failed turns each retry once = 4 calls; nothing cached.
    assert.strictEqual(calls, 4)
  })
})
