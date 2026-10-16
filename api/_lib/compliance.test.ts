import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MailError, sendMail, smtpConfigured } from './mailer.js'
import { canonicalDoc, carryReminderState, markSentPatch, normalizeDocPayload, parseDocJson, sortComplianceRows } from './compliance.js'
import type { ComplianceDoc } from '../../src/lib/complianceRules.js'

function doc(over: Partial<ComplianceDoc> = {}): ComplianceDoc {
  return {
    id: 'CMP-TEST-1',
    title: 'FSSAI licence',
    docType: 'license',
    expiresOn: '2027-03-31',
    remindEmails: ['owner@example.com'],
    ...over,
  }
}

describe('compliance doc parsing', () => {
  it('parses a stored doc string and skips what is not one', () => {
    expect(parseDocJson(JSON.stringify(doc()))).toEqual(doc())
    expect(parseDocJson('not json')).toBeNull()
    expect(parseDocJson(JSON.stringify({ title: 'no id' }))).toBeNull()
  })

  it('sorts by soonest expiry, undated after those, title as the tiebreak', () => {
    const rows = [
      { doc: doc({ id: 'CMP-B', title: 'B', expiresOn: '2027-06-01' }), version: 'CMP-B:1' },
      { doc: doc({ id: 'CMP-Z', title: 'Z', expiresOn: undefined }), version: 'CMP-Z:1' },
      { doc: doc({ id: 'CMP-A', title: 'A', expiresOn: '2027-01-01' }), version: 'CMP-A:1' },
      { doc: doc({ id: 'CMP-Y', title: 'Y', expiresOn: undefined }), version: 'CMP-Y:1' },
    ]
    expect(sortComplianceRows(rows).map((r) => r.doc.id)).toEqual(['CMP-A', 'CMP-B', 'CMP-Y', 'CMP-Z'])
  })
})

describe('normalizeDocPayload', () => {
  it('canonicalizes what the wire sends and drops everything it does not', () => {
    const result = normalizeDocPayload({
      id: ' CMP-1 ',
      title: '  FSSAI licence  ',
      docType: 'license',
      authority: 'FSSAI',
      remindEmails: ['Owner@Example.com', 'owner@example.com'],
      reminderSentFor: '2000-01-01', // never taken from the wire
      evil: 'drop me',
    })
    expect('doc' in result && result.doc).toEqual({
      id: 'CMP-1',
      title: 'FSSAI licence',
      docType: 'license',
      authority: 'FSSAI',
      remindEmails: ['owner@example.com'],
    })
  })

  it('refuses ids the key path cannot carry and payloads the rules reject', () => {
    const err = (payload: unknown) => {
      const r = normalizeDocPayload(payload)
      return 'error' in r ? r.error : '(no error)'
    }
    expect(err({ id: 'q"uote', title: 'x', docType: 'other', remindEmails: [] })).toMatch(/id/)
    expect(err({ id: 'CMP-1', title: '', docType: 'other', remindEmails: [] })).toMatch(/title/i)
    expect(err({ id: 'CMP-1', title: 'x', docType: 'other', expiresOn: '2027-01-01', remindEmails: [] })).toMatch(/reminder email/)
  })

  it('compares docs through the canonicalizer, blind to marker and stamps', () => {
    const a = doc()
    const b = { ...doc(), reminderSentFor: '2027-03-31', reminderSentAt: '2026-10-07T00:00:00Z', updatedAt: 'x', updatedBy: 'y' }
    expect(canonicalDoc(a)).toBe(canonicalDoc(b))
    expect(canonicalDoc(a)).not.toBe(canonicalDoc({ ...doc(), title: 'Renamed' }))
  })

  it('carries the stored marker forward so renewal re-arms', () => {
    const stored = doc({ reminderSentFor: '2027-03-31', reminderSentAt: '2026-10-01T00:00:00Z' })
    const kept = carryReminderState({ ...doc(), expiresOn: '2028-03-31' }, stored)
    expect(kept.reminderSentFor).toBe('2027-03-31') // no longer equals the new expiry — due again
    expect(carryReminderState(doc(), null).reminderSentFor).toBeUndefined()
  })

  it('marks sent for the expiry it fired at', () => {
    const marked = markSentPatch(doc())
    expect(marked.reminderSentFor).toBe('2027-03-31')
    expect(marked.reminderSentAt).toBeTruthy()
  })
})

describe('mailer (Zoho SMTP via nodemailer)', () => {
  // vi.hoisted: the mock factory below runs before this file's consts exist
  const mail = vi.hoisted(() => ({ sent: [] as unknown[], transports: [] as unknown[] }))
  vi.mock('nodemailer', () => ({
    default: {
      createTransport: (options: unknown) => {
        mail.transports.push(options)
        return {
          sendMail: async (message: unknown) => {
            mail.sent.push(message)
            return { accepted: (message as { to: string[] }).to }
          },
          close: () => {},
        }
      },
    },
  }))

  beforeEach(() => {
    mail.sent.length = 0
    mail.transports.length = 0
    process.env.SMTP_HOST = 'smtp.zoho.in'
    process.env.SMTP_USER = 'ops@roligt.local'
    process.env.SMTP_PASS = 'app-password'
    delete process.env.SMTP_PORT
    delete process.env.MAIL_FROM
  })
  afterEach(() => {
    delete process.env.SMTP_HOST
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS
  })

  it('sends through the plant mailbox with STARTTLS on the default port', async () => {
    expect(smtpConfigured()).toBe(true)
    await sendMail({ to: ['a@roligt.local'], subject: 's', html: '<p>x</p>', replyTo: 'qa@roligt.local' })
    expect(mail.transports[0]).toEqual({
      host: 'smtp.zoho.in',
      port: 587,
      secure: false,
      auth: { user: 'ops@roligt.local', pass: 'app-password' },
    })
    expect(mail.sent[0]).toEqual({
      from: 'ops@roligt.local',
      to: ['a@roligt.local'],
      subject: 's',
      html: '<p>x</p>',
      replyTo: 'qa@roligt.local',
    })
  })

  it('switches to implicit TLS on port 465 and honors a display from', async () => {
    process.env.SMTP_PORT = '465'
    process.env.MAIL_FROM = 'Roligt Ops <ops@roligt.local>'
    await sendMail({ to: ['a@roligt.local'], subject: 's', html: 'x' })
    expect(mail.transports[0]).toMatchObject({ port: 465, secure: true })
    expect((mail.sent[0] as { from: string }).from).toBe('Roligt Ops <ops@roligt.local>')
  })

  it('refuses outright when SMTP is not configured', async () => {
    delete process.env.SMTP_HOST
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS
    expect(smtpConfigured()).toBe(false)
    await expect(sendMail({ to: ['a@roligt.local'], subject: 's', html: 'x' })).rejects.toBeInstanceOf(MailError)
    expect(mail.transports.length).toBe(0)
  })
})
