# web-rotate-mcp

> MCP Server for [`web-rotate-core`](https://github.com/Sn0wo2/web-rotate-core)

---

具体说明请参考 [`web-rotate-core`](https://github.com/Sn0wo2/web-rotate-core) (以下简称 `core`)

## 配置

沿用 `core` 的配置, 各提供商的完整配置见 `core` [DeepWiki](https://deepwiki.com/Sn0wo2/web-rotate-core)

```jsonc
{
  "mcpServers": {
    "web-rotate": {
      "command": "bun",
      "args": ["x", "github:Sn0wo2/web-rotate-mcp"],
      "env": {
        "TAVILY_API_KEY": "tvly-xxx",
        "WEB_ROTATE_CONFIG": "{\"timeoutMs\":60000,\"search\":{\"prefer\":\"keyless\",\"providers\":{\"tavily\":{\"keys\":\"{env:TAVILY_API_KEY}\"}}}}",
      },
    },
  },
}
```

```

```
