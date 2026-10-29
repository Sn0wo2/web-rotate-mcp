import type { ProviderEntry } from "web-rotate-core"

export type PluginProviderEntry = ProviderEntry & {
  enabled?: boolean | undefined
}

export function mergeProviders(
  base: Readonly<Record<string, ProviderEntry | undefined>>,
  entries: Record<string, PluginProviderEntry> | undefined,
): Record<string, ProviderEntry> {
  const merged: Record<string, ProviderEntry> = {}
  for (const [id, entry] of Object.entries(base)) if (entry) merged[id] = entry
  for (const [id, raw] of Object.entries(entries ?? {})) {
    const { enabled, ...entry } = raw
    if (enabled === false) {
      delete merged[id]
      continue
    }
    merged[id] = { ...merged[id], ...entry }
  }
  return merged
}
