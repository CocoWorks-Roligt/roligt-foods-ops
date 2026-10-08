import { describe, expect, it } from 'vitest'
import {
  COMPLIANCE_PATH_PREFIX,
  DEFAULT_COMPLIANCE_LEAD_DAYS,
  daysBetween,
  isDateKey,
  isDue,
  parseEmails,
  reminderHtml,
  reminderSubject,
  todayKeyIST,
  validateComplianceDoc,
  type ComplianceDoc,
} from './complianceRules.ts'

const TODAY = '2026-10-07'

function doc(over: Partial<ComplianceDoc> = {}): ComplianceDoc {
  return {
    id: 'CMP-TEST-001',
    title: 'FSSAI licence',
    docType: 'license',
    authority: 'FSSAI',
    identifier: '12345678901234',
    expiresOn: '2027-03-31',
    remindEmails: ['owner@example.com'],
    ...over,
  }
}

describe('date keys', () => {
  it('accepts real calendar dates and rejects shapes and impossible dates', () => {
    expect(isDateKey('2026-10-07')).toBe(true)
    expect(isDateKey('2026-02-29')).toBe(false) // not a leap year
    expect(isDateKey('2028-02-29')).toBe(true)
    expect(isDateKey('2026-13-01')).toBe(false)
    expect(isDateKey('2026-10-7')).toBe(false)
    expect(isDateKey('07-10-2026')).toBe(false)
    expect(isDateKey(20261007)).toBe(false)
    expect(isDateKey(undefined)).toBe(false)
  })

  it('counts whole calendar days with no timezone in the way', () => {
    expect(daysBetween('2026-10-07', '2026-10-07')).toBe(0)
    expect(daysBetween('2026-10-07', '2026-11-06')).toBe(30)
    expect(daysBetween('2026-10-07', '2026-10-01')).toBe(-6)
    // a DST-style offset would make this 179.96 or 180.04 — calendar math says 181
    expect(daysBetween('2026-10-07', '2027-04-06')).toBe(181)
    expect(Number.isNaN(daysBetween('2026-10-07', 'next tuesday'))).toBe(true)
  })

  it('derives today from IST, not the host clock', () => {
    // 2026-10-07 20:00 UTC is already 2026-10-08 01:30 in IST
    expect(todayKeyIST(Date.UTC(2026, 9, 7, 20, 0))).toBe('2026-10-08')
    expect(todayKeyIST(Date.UTC(2026, 9, 7, 17, 59))).toBe('2026-10-07')
  })
})

describe('parseEmails', () => {
  it('splits on commas, semicolons and newlines; trims, lowercases, dedupes', () => {
    expect(parseEmails('Owner@Example.com, ops@example.com; qa@example.com\nowner@example.com')).toEqual([
      'owner@example.com',
      'ops@example.com',
      'qa@example.com',
    ])
    expect(parseEmails('  ')).toEqual([])
  })

  it('drops everything that is not an address rather than failing the whole list', () => {
    expect(parseEmails('owner@example.com, not an email, @nope, x@y.z')).toEqual(['owner@example.com', 'x@y.z'])
  })
})

describe('validateComplianceDoc', () => {
  it('accepts a complete document', () => {
    expect(validateComplianceDoc(doc())).toBeNull()
  })

  it('accepts a document with no expiry and no emails', () => {
    expect(validateComplianceDoc(doc({ expiresOn: undefined, remindEmails: [] }))).toBeNull()
  })

  it('refuses an expiry date without a recipient', () => {
    expect(validateComplianceDoc(doc({ remindEmails: [] }))).toMatch(/needs at least one reminder email/)
  })

  it('refuses expiry before issue, bad dates, and over-long fields', () => {
    expect(validateComplianceDoc(doc({ issuedOn: '2027-12-01' }))).toMatch(/cannot be before the issue date/)
    expect(validateComplianceDoc(doc({ expiresOn: '31-03-2027' }))).toMatch(/Expiry date must be a date/)
    expect(validateComplianceDoc(doc({ title: 'x'.repeat(121) }))).toMatch(/120 characters/)
    expect(validateComplianceDoc(doc({ notes: 'x'.repeat(2001) }))).toMatch(/2000 characters/)
  })

  it('refuses file references outside the compliance prefix', () => {
    expect(validateComplianceDoc(doc({ file: { fileName: 'fssai.pdf', path: 'qc/other.pdf', uploadedAt: '2026-10-07T00:00:00Z' } }))).toMatch(/not a compliance attachment/)
    expect(validateComplianceDoc(doc({ file: { fileName: 'fssai.pdf', path: 'compliance/../etc', uploadedAt: '2026-10-07T00:00:00Z' } }))).toMatch(/not a compliance attachment/)
    expect(
      validateComplianceDoc(doc({ file: { fileName: 'fssai.pdf', path: `${COMPLIANCE_PATH_PREFIX}fssai-abc.pdf`, uploadedAt: '2026-10-07T00:00:00Z' } })),
    ).toBeNull()
  })
})

describe('isDue', () => {
  const lead = DEFAULT_COMPLIANCE_LEAD_DAYS

  it('is due inside the window, on the boundary day, and past expiry', () => {
    expect(isDue(doc({ expiresOn: '2026-11-06' }), TODAY, lead)).toBe(true) // exactly 30 days out
    expect(isDue(doc({ expiresOn: '2026-10-10' }), TODAY, lead)).toBe(true)
    expect(isDue(doc({ expiresOn: '2026-09-30' }), TODAY, lead)).toBe(true) // expired, never reminded
  })

  it('is not due outside the window, without emails, or without a valid expiry', () => {
    expect(isDue(doc({ expiresOn: '2026-11-07' }), TODAY, lead)).toBe(false) // 31 days out
    expect(isDue(doc({ remindEmails: [] }), TODAY, lead)).toBe(false)
    expect(isDue(doc({ expiresOn: undefined }), TODAY, lead)).toBe(false)
  })

  it('fires once per expiry and re-arms when the document is renewed', () => {
    const reminded = doc({ reminderSentFor: '2026-10-10' })
    expect(isDue({ ...reminded, expiresOn: '2026-10-10' }, TODAY, lead)).toBe(false)
    // renewed the next day to a fresh 30-day window — the marker no longer matches
    expect(isDue({ ...reminded, expiresOn: '2026-11-05' }, TODAY, lead)).toBe(true)
  })
})

describe('reminder email copy', () => {
  it('words the subject by which side of expiry the document sits on', () => {
    expect(reminderSubject(doc({ expiresOn: todayKeyIST() }))).toMatch(/^Expiring soon: /)
    expect(reminderSubject(doc({ expiresOn: '2020-01-01' }))).toMatch(/^Expired: /)
  })

  it('escapes free text into the html', () => {
    const html = reminderHtml(doc({ title: '<script>alert(1)</script>', authority: 'A & B "Authority"' }))
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('A &amp; B')
  })
})
