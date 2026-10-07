import type { ModelEntry } from '../../../shared/api'
import type { ProviderConfig } from '../../../shared/types'

export type PickerRow =
  | { type: 'head'; label: string }
  | { type: 'model'; label: string; model: ModelEntry; idx: number }
  | { type: 'empty'; label: string }

/**
 * Rows for the picker list: a group head whenever the provider changes, then
 * one row per model (`idx` = keyboard index into the filtered list).
 *
 * Connected providers whose GET /models returned nothing get an explicit
 * note — a silent gap reads as "these models don't exist", when really the
 * fetch failed (bad key, offline, timeout).
 */
export function buildPickerRows(
  list: ModelEntry[],
  providers: ProviderConfig[] | undefined,
  showMissing: boolean
): PickerRow[] {
  const rows: PickerRow[] = []
  let lastProvider = ''
  let idx = 0
  for (const m of list) {
    if (m.provider !== lastProvider) {
      rows.push({ type: 'head', label: m.providerName })
      lastProvider = m.provider
    }
    rows.push({ type: 'model', label: m.id, model: m, idx: idx++ })
  }
  if (showMissing && providers?.length) {
    const shown = new Set(list.map((m) => m.provider))
    for (const p of providers) {
      if (p.id === 'ollama' || shown.has(p.id)) continue
      rows.push({ type: 'head', label: p.name || p.id })
      rows.push({ type: 'empty', label: '(no models loaded — check the API key)' })
    }
  }
  return rows
}
