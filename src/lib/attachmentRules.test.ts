import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_FILE_MAX_BYTES,
  attachmentAreaOf,
  attachmentPermissionFor,
  isAttachmentKey,
  mintAttachmentKey,
  safeAttachmentName,
} from './attachmentRules.ts'

describe('attachment keys', () => {
  it('mints attachments/<area>/<context>-<stamp>-<rand>-<name>', () => {
    const key = mintAttachmentKey('qc', 'QC-12.micro', 'lab report (final).pdf', 1_700_000_000_000, 'ab12cd')
    expect(key).toBe(`attachments/qc/QC-12.micro-${(1_700_000_000_000).toString(36)}-ab12cd-lab_report_final_.pdf`)
    expect(attachmentAreaOf(key)).toBe('qc')
  })

  it('caps the context at 60 and the name at 80 characters and never leaves either empty', () => {
    const key = mintAttachmentKey('pod', 'D'.repeat(200), `${'x'.repeat(200)}.jpg`, 1, 'zzzzzz')
    const tail = key.slice('attachments/pod/'.length)
    expect(tail.startsWith(`${'D'.repeat(60)}-1-zzzzzz-`)).toBe(true)
    expect(tail.split('-').pop()).toHaveLength(80)
    expect(isAttachmentKey(key)).toBe(true)
    expect(mintAttachmentKey('pod', '', '', 1, 'aaaaaa')).toBe('attachments/pod/record-1-aaaaaa-file')
  })

  it('draws a fresh six-character random segment per key', () => {
    const a = mintAttachmentKey('qc', 'r', 'f.pdf', 5)
    const b = mintAttachmentKey('qc', 'r', 'f.pdf', 5)
    expect(a).toMatch(/^attachments\/qc\/r-5-[a-z0-9]{6}-f\.pdf$/)
    expect(a).not.toBe(b)
  })

  it('sanitises exactly as the interim store did', () => {
    expect(safeAttachmentName('a b/c\\d?.pdf')).toBe('a_b_c_d_.pdf')
  })
})

describe('attachment key grammar', () => {
  it('accepts only the two areas under attachments/', () => {
    expect(attachmentAreaOf('attachments/qc/x.pdf')).toBe('qc')
    expect(attachmentAreaOf('attachments/pod/x.jpg')).toBe('pod')
    for (const bad of [
      'attachments/other/x.pdf',
      'compliance/x.pdf',
      'qc/x.pdf',
      'attachments/qc/',
      'attachments/qc/a/b.pdf',
      'attachments/qc/a b.pdf',
      `attachments/qc/${'x'.repeat(201)}`,
      'attachments/qc/..pdf',
      '',
    ]) {
      expect(attachmentAreaOf(bad), bad).toBeNull()
    }
  })

  it('maps each area to the page that owns it', () => {
    expect(attachmentPermissionFor('attachments/qc/x.pdf')).toBe('page.quality')
    expect(attachmentPermissionFor('attachments/pod/x.jpg')).toBe('page.dispatch')
    expect(attachmentPermissionFor('compliance/x.pdf')).toBeNull()
  })

  it('shares the compliance cap', () => {
    expect(ATTACHMENT_FILE_MAX_BYTES).toBe(12 * 1024 * 1024)
  })
})
