#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { FetchProviderConfig, SearchProviderConfig, URLList } from "web-rotate-core"
import {
  createWebFetcher,
  createWebSearcher,
  DEFAULT_FETCH_PROVIDER_CONFIG,
  DEFAULT_SEARCH_PROVIDER_CONFIG,
  RotateConfigError,
} from "web-rotate-core"
import pkg from "../package.json"
import type { PluginProviderEntry } from "./utils"
import { mergeProviders } from "./utils"

const ENV_REFERENCE_PATTERN = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/
const URL_PROTOCOL_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//
const ATTEMPT_ERROR_PREFIX_PATTERN = /^all \d+ attempt\(s\) failed\. Last error: /

type Config = {
  timeoutMs?: unknown
  search?:
    | (SearchProviderConfig & {
        providers?: Record<string, PluginProviderEntry> | undefined
      })
    | undefined
  fetch?:
    | (FetchProviderConfig & {
        providers?: Record<string, PluginProviderEntry> | undefined
      })
    | undefined
}

try {
  let config: Config
  try {
    config = JSON.parse(process.env.WEB_ROTATE_CONFIG?.trim() || "{}", (_key, value) => {
      if (typeof value !== "string") return value
      const name = ENV_REFERENCE_PATTERN.exec(value)?.[1]
      return name === undefined ? value : process.env[name]
    }) as Config
  } catch (cause) {
    throw Object.assign(
      new RotateConfigError(`WEB_ROTATE_CONFIG is not valid JSON: ${cause instanceof Error ? cause.message : cause}`),
      { cause },
    )
  }
  if (config === null || typeof config !== "object" || Array.isArray(config))
    throw new RotateConfigError("WEB_ROTATE_CONFIG must be a JSON object")

  const fetcher = createWebFetcher({
    ...config.fetch,
    providers: mergeProviders(DEFAULT_FETCH_PROVIDER_CONFIG, config.fetch?.providers),
  } as FetchProviderConfig)
  const searcher = createWebSearcher({
    ...config.search,
    providers: mergeProviders(DEFAULT_SEARCH_PROVIDER_CONFIG, config.search?.providers),
  } as SearchProviderConfig)

  const server = new Server({ name: "web-rotate-mcp", version: pkg.version }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [
        {
          name: "websearch",
          description:
            "Search the web using multi-provider rotation with automatic fallback. " +
            "Returns ranked results. " +
            "Results are numbered [1], [2], ...; when a statement relies on a result, " +
            "cite it as [n] together with its URL.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
            },
            required: ["query"],
          },
        },
        {
          name: "webfetch",
          description:
            "Fetch one or more URLs and return their content as markdown (default), text, or html; " +
            "image URLs may be returned as a media attachment. Read-only; " +
            "prefer a more targeted tool when one is available. " +
            "Cite the source URL when a statement relies on fetched content.",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                description: "http(s) URL, or an array of URLs",
                type: ["string", "array"],
                items: { type: "string" },
                maxItems: 20,
              },
              format: { type: "string", enum: ["text", "markdown", "html"] },
              timeout: {
                type: "number",
                minimum: 1,
                maximum: 120,
                description: "seconds",
              },
            },
            required: ["url"],
          },
        },
      ],
    }),
  )

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    switch (name) {
      case "websearch": {
        const query = String((args as { query?: unknown } | undefined)?.query ?? "").trim()
        if (!query)
          return {
            isError: true,
            content: [{ type: "text", text: "websearch: query is required" }],
          }
        const timeoutMs = Number(config.timeoutMs)
        const signal = AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000)
        try {
          const { results, errors } = await searcher.search({
            queries: [query] as URLList,
            signal,
          })
          if (!results.length) {
            const reason = errors?.at(0)?.error
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: reason ? `websearch: ${reason}` : `websearch: no results for ${query}`,
                },
              ],
            }
          }
          return {
            content: [
              {
                type: "text",
                text: results
                  .map((item, index) => {
                    const lines = [`[${index + 1}] ${item.title ?? item.url}`, item.url]
                    if (item.content) lines.push(item.content)
                    return lines.join("\n")
                  })
                  .join("\n\n"),
              },
            ],
          }
        } catch (cause) {
          if (signal.aborted)
            return {
              isError: true,
              content: [{ type: "text", text: "websearch: request timed out" }],
            }
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `websearch: ${cause instanceof Error ? cause.message : String(cause)}`,
              },
            ],
          }
        }
      }
      case "webfetch": {
        const input = (args ?? {}) as {
          url?: unknown
          format?: unknown
          timeout?: unknown
        }
        const urlList = (Array.isArray(input.url) ? input.url : [input.url ?? ""])
          .map((value) => String(value).replace(/^[\s"'<]+|[\s"'>]+$/g, ""))
          .filter(Boolean)
        if (!urlList.length)
          return {
            isError: true,
            content: [{ type: "text", text: "webfetch: url is required" }],
          }
        if (urlList.length > 20)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `webfetch: no more than 20 URLs are allowed`,
              },
            ],
          }
        let urls: URLList
        try {
          urls = urlList.map((value) => {
            const parsed = new URL(
              value.startsWith("//") ? `https:${value}` : URL_PROTOCOL_PATTERN.test(value) ? value : `https://${value}`,
            )
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
              throw new Error("only HTTP(S) URLs are supported")
            return parsed.toString()
          }) as URLList
        } catch (cause) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `webfetch: ${cause instanceof Error ? cause.message : String(cause)}`,
              },
            ],
          }
        }
        const signal = AbortSignal.timeout((Math.min(Number(input.timeout), 120) || 30) * 1000)
        try {
          const outcome = await fetcher.fetch({
            urls,
            format:
              (
                {
                  text: "text",
                  txt: "text",
                  plain: "text",
                  html: "html",
                  htm: "html",
                } as Record<string, "text" | "html" | undefined>
              )[
                String(input.format ?? "")
                  .trim()
                  .toLowerCase()
              ] ?? "markdown",
            signal,
          })
          if (outcome.type === "image")
            return {
              content: [
                {
                  type: "text",
                  text: `Image fetched successfully: ${outcome.url}`,
                },
                { type: "image", data: outcome.base64, mimeType: outcome.mime },
              ],
            }
          return {
            content: outcome.pages.map((page, index) => {
              return {
                type: "text" as const,
                text: page.error
                  ? `FAILED ${page.url}: ${page.error}`
                  : `SUCCESS ${urls.length > 1 ? `[${index + 1}] ` : ""}${page.url}\n\n${page.content ?? ""}`,
              }
            }),
          }
        } catch (cause) {
          if (signal.aborted)
            return {
              isError: true,
              content: [{ type: "text", text: "webfetch: request timed out" }],
            }
          if (cause instanceof RotateConfigError)
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `webfetch: ${cause instanceof Error ? cause.message : String(cause)}`,
                },
              ],
            }
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `webfetch: failed to fetch ${urls.join(", ")}: ${(cause instanceof Error ? cause.message : String(cause)).replace(ATTEMPT_ERROR_PREFIX_PATTERN, "")}`,
              },
            ],
          }
        }
      }
      default:
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        }
    }
  })

  await server.connect(new StdioServerTransport())
  console.error(`[web-rotate-mcp] ready (config: ${process.env.WEB_ROTATE_CONFIG ? "WEB_ROTATE_CONFIG" : "defaults"})`)
} catch (error) {
  console.error(
    `[web-rotate-mcp] fatal:`,
    error instanceof RotateConfigError ? error.message : error instanceof Error ? error.stack : error,
  )
  process.exit(1)
}
