/**
 * Plant-wide settings, document numbering, stickers and export.
 *
 * Split out of AppContext, which had grown to nearly three thousand lines and every
 * write the application can make. Nothing here changed in the move: the rules, the
 * checks and the ledger lines are the ones that were there before.
 */

import { useCallback, useMemo } from 'react'
import { checkNumbering, formatDocNo, seriesDef } from '../../lib/numbering'
import { printStickerSheet } from '../../lib/stickerPrint'
import { DEFAULT_STICKER_HEIGHT_MM, DEFAULT_STICKER_WIDTH_MM, stageLabel, stickerOwner, stickerReferenceLabel } from '../../lib/stickers'
import type { StickerJob } from '../../lib/stickers'
import { deepClone, nowISO } from '../../lib/utils'
import type { AppState, Config, NumberingRule, StickerTemplate } from '../../types'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'

export function useAdmin({ state, setState, nextId, log, showToast, forbidden }: CoreDeps) {
  const saveConfig = useCallback(
    (config: Config) => {
      if (forbidden('Changing plant configuration')) return
      setState((prev) => {
        const draft = deepClone(prev)
        draft.config = config
        log(
          draft,
          'Updated configuration',
          'APP-SETTINGS',
          'Changed operational tolerance and alert settings.',
        )
        return draft
      })
      showToast('Configuration saved.')
    },
    [forbidden, log, setState, showToast],
  )

  /**
   * Records what each sticker said and then prints it. The lines are stored as they
   * printed rather than re-derived on demand: a sticker is on a box in a cold room,
   * and renaming the product six weeks later must not change what the reprint says.
   */
  const printStickers = useCallback(
    (jobs: StickerJob[]): string | null => {
      const live = jobs.filter((j) => j.lines.length && j.copies > 0)
      if (!live.length) {
        showToast('Nothing to print — pick a record and switch on at least one field.')
        return null
      }
      const widthMm = state.config.stickerWidthMm || DEFAULT_STICKER_WIDTH_MM
      const heightMm = state.config.stickerHeightMm || DEFAULT_STICKER_HEIGHT_MM
      const copies = live.reduce((a, b) => a + b.copies, 0)

      setState((prev) => {
        const draft = deepClone(prev)
        for (const job of live) {
          draft.stickerPrints.unshift({
            id: nextId(draft, 'sticker'),
            stage: job.stage,
            reference: job.reference,
            title: job.title,
            lines: job.lines.map((l) => ({ ...l })),
            copies: job.copies,
            widthMm,
            heightMm,
            printedAt: nowISO(),
          })
        }
        // One entry per sticker, filed under the record it is for. It used to be one entry
        // naming every reference joined by commas, and a supplier lot or a store name can
        // hold a comma of its own.
        for (const job of live) {
          log(
            draft,
            'Printed stickers',
            stickerOwner(draft, job),
            `${job.copies} sticker(s) of ${stickerReferenceLabel(draft, job.stage, job.reference)} · ${stageLabel(job.stage)} · ${widthMm}×${heightMm} mm`,
          )
        }
        return draft
      })

      printStickerSheet({
        widthMm,
        heightMm,
        stickers: live.map((j) => ({ title: j.title, lines: j.lines, copies: j.copies })),
      })
      showToast(`Sent ${copies} sticker(s) to the printer.`)
      return POSTED
    },
    [log, nextId, setState, showToast, state.config.stickerHeightMm, state.config.stickerWidthMm],
  )

  const saveStickerTemplate = useCallback(
    (template: StickerTemplate) => {
      setState((prev) => {
        const draft = deepClone(prev)
        const idx = draft.stickerTemplates.findIndex((t) => t.stage === template.stage)
        if (idx >= 0) draft.stickerTemplates[idx] = template
        else draft.stickerTemplates.push(template)
        log(draft, 'Edited sticker layout', stageLabel(template.stage), template.title)
        return draft
      })
      showToast('Sticker layout saved.')
    },
    [log, setState, showToast],
  )

  const saveStickerSize = useCallback(
    (widthMm: number, heightMm: number) => {
      setState((prev) => {
        const draft = deepClone(prev)
        draft.config.stickerWidthMm = widthMm
        draft.config.stickerHeightMm = heightMm
        log(draft, 'Changed sticker size', 'Stickers', `${widthMm}×${heightMm} mm`)
        return draft
      })
      showToast(`Sticker size set to ${widthMm}×${heightMm} mm.`)
    },
    [log, setState, showToast],
  )

  /**
   * Renames a numbering series and says where it carries on from. The counter holds
   * the last number *used*, so a start of 7 is stored as 6 and the next document
   * takes 7. Refused outright if it would reissue a code a live document already
   * carries — see `checkNumbering`; nothing else about the format is the app's call.
   */
  const saveNumbering = useCallback(
    (key: string, rule: NumberingRule, next: number): string | null => {
      if (forbidden('Changing document numbering')) return 'Not allowed'
      const error = checkNumbering(state, key, rule, next)
      if (error) {
        showToast(error)
        return error
      }
      const clean: NumberingRule = {
        key,
        prefix: rule.prefix.trim(),
        pattern: rule.pattern.trim(),
        pad: Math.min(9, Math.max(1, Math.round(rule.pad))),
      }
      const start = Math.max(1, Math.round(next))
      setState((prev) => {
        const draft = deepClone(prev)
        const rest = (draft.config.numbering || []).filter((r) => r.key !== key)
        draft.config.numbering = [...rest, clean]
        draft.counters[key as keyof AppState['counters']] = start - 1
        log(
          draft,
          'Changed numbering',
          seriesDef(key)?.label || key,
          `Next ${seriesDef(key)?.label || key} will be ${formatDocNo(clean, start)}.`,
        )
        return draft
      })
      showToast(`Next ${seriesDef(key)?.label || key} will be ${formatDocNo(clean, start)}.`)
      return null
    },
    [forbidden, log, setState, showToast, state],
  )

  const exportData = useCallback(() => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'roligt_foods_operations_export.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }, [state])

  return useMemo(
    () => ({
      saveConfig,
      printStickers,
      saveStickerTemplate,
      saveStickerSize,
      saveNumbering,
      exportData,
    }),
    [
      saveConfig,
      printStickers,
      saveStickerTemplate,
      saveStickerSize,
      saveNumbering,
      exportData,
    ],
  )
}
