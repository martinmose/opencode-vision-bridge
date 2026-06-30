/**
 * opencode-vision-bridge
 *
 * Transparently lets text-only models handle image uploads. Before messages
 * reach the LLM, any image FilePart is sent to a vision model (an
 * OpenAI-compatible endpoint) and replaced in place with a TextPart containing
 * the description. Text-only models then "see" prose instead of an unsupported
 * image block.
 *
 * Config is read from process.env. See README for the full table.
 *
 * This file is the npm package entry point. OpenCode's plugin loader treats
 * every export of the entry module as a candidate plugin, so this file exports
 * ONLY the plugin function. All helpers live in ./lib.ts.
 *
 * Gotchas honored (opencode issue #25754):
 *   - the hook `input` is `{}`; everything is read from `output.messages`
 *   - `message.parts` is mutated IN PLACE; the array is never reassigned
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { DescriptionCache, buildConfig, makeLogger, transformMessages } from "./lib.ts"

/** Shape of the hook payload we mutate. See opencode issue #25754. */
interface MessagesTransformOutput {
  messages: unknown[]
}

const VisionBridgePlugin: Plugin = async (pluginContext: PluginInput) => {
  const config = buildConfig(process.env)
  const log = makeLogger(pluginContext.client, config.debug)
  // One cache for the plugin's lifetime so the same image isn't re-described
  // on every conversation turn (the transform hook reprocesses full history).
  const cache = new DescriptionCache(config.cacheSize)

  await log?.("info", "vision-bridge initialized", {
    baseUrl: config.baseUrl || "(unset)",
    model: config.model,
    hasKey: Boolean(config.apiKey),
    skipProviders: config.skipProviders,
    maxConcurrency: config.maxConcurrency,
    timeoutMs: config.timeoutMs,
    cacheSize: config.cacheSize,
  })

  if (!config.baseUrl || !config.apiKey) {
    await log?.(
      "warn",
      "vision-bridge missing VISION_BASE_URL or VISION_API_KEY; images will not be described",
      {},
    )
  }

  return {
    "experimental.chat.messages.transform": async (
      _input: unknown,
      output: MessagesTransformOutput,
    ) => {
      const messages = output?.messages
      if (!Array.isArray(messages)) return
      try {
        await transformMessages(messages, config, log, cache)
      } catch (error) {
        await log?.("error", "transform failed", { error: String(error) })
      }
    },
  }
}

export default VisionBridgePlugin
