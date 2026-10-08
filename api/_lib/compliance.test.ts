import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MailError, sendMail, smtpConfigured } from './mailer.js'
import { canonicalDoc, carryReminderState, docFromRow, markSentPatch, normalizeDocPayload, rowValues, rowVersion, rowsToDocs } from './compliance.js'
import type { TableRef } from './baseSchema.js'
import type { ZohoRecord } from './zoho.js'
import type { ComplianceDoc } from '../../src/lib/complianceRules.js'

/** A minimal Compliance Documents TableRef — the real one comes from the generated schema. */
function table(): TableRef {
  return {
    name: 'Compliance Documents',
    id: 'tbl',
    appId: 'F_APP',
    dataJson: 'F_JSON',
    fields: { Title: 'F_TITLE', 'Expires On': 'F_EXP', Version: 'F_VER', 'App ID': 'F_APP', 'Data JSON': 'F_JSON' },
  }
}

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

describe('compliance row mapping', () => {
  it('round-trips a doc through a row and back', () => {
    const t = table()
    const values = rowValues(t, doc(), 'CMP-TEST-1:4')
    expect(values[t.appId]).toBe('CMP-TEST-1')
    expect(JSON.parse(String(values[t.dataJson!]))).toEqual(doc())
    expect(values[t.fields['Title']]).toBe('FSSAI licence')
    expect(values[t.fields['Expires On']]).toBe('2027-03-31')
    expect(values[t.fields['Version']]).toBe('CMP-TEST-1:4')
    const row = { recordID: 'rec-1', data: values } as unknown as ZohoRecord
    expect(docFromRow(t, row)).toEqual(doc())
    expect(rowVersion(t, row)).toBe('CMP-TEST-1:4')
  })

  it('skips rows with no parsable doc and sorts by soonest expiry', () => {
    const t = table()
    const rows = [
      { recordID: 'a', data: { [t.appId]: 'CMP-B', [t.dataJson!]: JSON.stringify(doc({ id: 'CMP-B', title: 'B', expiresOn: '2027-06-01' })), [t.fields['Version']]: 'CMP-B:1' } },
      { recordID: 'b', data: { [t.appId]: 'hand', [t.dataJson!]: 'not json', [t.fields['Version']]: '' } },
      { recordID: 'c', data: { [t.appId]: 'CMP-A', [t.dataJson!]: JSON.stringify(doc({ id: 'CMP-A', title: 'A', expiresOn: '2027-01-01' })), [t.fields['Version']]: 'CMP-A:1' } },
      { recordID: 'd', data: { [t.appId]: 'CMP-Z', [t.dataJson!]: JSON.stringify(doc({ id: 'CMP-Z', title: 'Z', expiresOn: undefined })), [t.fields['Version']]: 'CMP-Z:1' } },
    ] as unknown as ZohoRecord[]
    expect(rowsToDocs(t, rows).map((r) => r.doc.id)).toEqual(['CMP-A', 'CMP-B', 'CMP-Z'])
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

  it('refuses ids the Zoho key path cannot carry and payloads the rules reject', () => {
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
