/**
 * The compliance reminder email, sent through the plant's own Zoho Mail over
 * SMTP — the one sender that has to reach Zoho-hosted inboxes, because it IS
 * the same mail system (the repo's own history: external automated senders —
 * WorkOS reset mail — get spam-foldered; see workosAdmin.ts).
 *
 * nodemailer is the whole SMTP story here: created per send, because the cron
 * runs once a day for a handful of messages — a pooled connection would only
 * be a way to hold a socket open between cold starts that never reuse it.
 *
 * The password is an app-specific password from the Zoho Mail console, never
 * the mailbox's own; the account must be on a plan with SMTP access (the free
 * plan has none). For this org's India-DC Zoho, the host is smtp.zoho.in.
 */
import nodemailer from 'nodemailer'

export class MailError extends Error {}

export interface OutboundMail {
  to: string[]
  subject: string
  html: string
  replyTo?: string
}

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}

export async function sendMail(mail: OutboundMail): Promise<void> {
  const host = process.env.SMTP_HOST
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  if (!host || !user || !pass) {
    throw new MailError('SMTP_HOST / SMTP_USER / SMTP_PASS are not configured — the reminder email cannot be sent.')
  }
  const port = Number(process.env.SMTP_PORT || 587)
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 587 upgrades with STARTTLS after greeting; 465 is TLS from the first byte
    auth: { user, pass },
  })
  try {
    await transport.sendMail({
      from: process.env.MAIL_FROM || user,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    })
  } finally {
    transport.close()
  }
}
