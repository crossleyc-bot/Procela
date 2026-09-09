import nodemailer, { Transporter } from 'nodemailer';
import logger from '../lib/logger';
import { resolveEnvSecretSync } from './crypto.service';

// ──────────────────────────────────────────────────────────────────────────
// mail.service — SMTP delivery of transactional email.
//
// Currently used for password-reset tokens; designed to grow into the
// home for any outbound email (admin notifications, weekly digests,
// audit alerts).
//
// Configuration is env-driven and entirely optional. When SMTP isn't
// configured, isConfigured() returns false and callers fall back to
// their dev path (e.g. /auth/password/forgot writes the token to the
// audit log instead of sending it). This is the default in CLAUDE.md's
// prototype scope — production deployments set the SMTP_* vars to
// activate real delivery.
//
// Env vars (all required for delivery to be active):
//   SMTP_HOST       e.g. smtp.sendgrid.net, smtp.office365.com
//   SMTP_PORT       e.g. 587 (STARTTLS) or 465 (TLS)
//   SMTP_USER       SMTP username
//   SMTP_PASS       SMTP password / API key
//   MAIL_FROM       "Procela <noreply@procela.io>" — From header
//   APP_URL         e.g. https://app.procela.io — base for reset links
//
// Optional:
//   SMTP_SECURE     'true' for port 465 implicit TLS, omit otherwise
//
// The transporter is verified at module init so a bad config surfaces
// in the boot log rather than the first forgot-password request.
// ──────────────────────────────────────────────────────────────────────────

interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  appUrl: string;
}

function readConfig(): MailConfig | null {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  // SMTP_PASS may be plaintext or an enc:v1:… envelope (encrypted at
  // rest with the same master key as the MFA secret). resolveEnvSecretSync
  // decrypts transparently when the envelope is present.
  const pass = resolveEnvSecretSync(process.env.SMTP_PASS);
  const from = process.env.MAIL_FROM;
  const appUrl = process.env.APP_URL;
  if (!host || !port || !user || !pass || !from || !appUrl) return null;
  return {
    host,
    port: parseInt(port, 10),
    secure: process.env.SMTP_SECURE === 'true',
    user, pass, from, appUrl,
  };
}

/** Names of the required SMTP env vars that are currently unset. Used to make
 *  the "not configured" boot log actionable — a common failure is one empty
 *  var (e.g. SMTP_USER/SMTP_PASS blanked by a later line, or a missing
 *  APP_URL) silently disabling all outbound mail. */
function missingMailVars(): string[] {
  const required: Record<string, unknown> = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: resolveEnvSecretSync(process.env.SMTP_PASS),
    MAIL_FROM: process.env.MAIL_FROM,
    APP_URL: process.env.APP_URL,
  };
  return Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
}

const config = readConfig();
let transporter: Transporter | null = null;
let ready = false;

if (config) {
  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });
  // Verify in the background so we don't block module init. A bad
  // config logs but doesn't crash — isConfigured() flips to false on
  // verification failure and callers fall back to the dev path.
  transporter.verify()
    .then(() => {
      ready = true;
      logger.info({ host: config.host, port: config.port }, 'SMTP transporter verified');
    })
    .catch((err) => {
      ready = false;
      transporter = null;
      logger.warn({ err, host: config.host }, 'SMTP verification failed — falling back to dev audit-log delivery');
    });
} else {
  logger.info(
    { missing: missingMailVars() },
    'SMTP not configured — outbound mail will fall back to the audit log',
  );
}

export function isConfigured(): boolean {
  return ready && transporter !== null && config !== null;
}

/** App-wide base URL for clickable links in emails. Falls back to a
 *  relative path when APP_URL isn't set; callers that need an
 *  absolute link should check isConfigured() first. */
export function getAppUrl(): string {
  return config?.appUrl || '';
}

/** Send the password-reset email. Returns true on successful send,
 *  false otherwise. The /forgot route logs the audit entry either
 *  way — this function is only responsible for delivery. */
export async function sendPasswordResetEmail(args: {
  to: string;
  name: string;
  token: string;
  ttlMinutes: number;
}): Promise<boolean> {
  if (!isConfigured() || !transporter || !config) return false;

  const resetLink = `${config.appUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(args.token)}`;
  const subject = 'Reset your Procela password';

  // Both HTML and plain-text bodies. Plain-text is what most security
  // tooling renders and prevents phishing-by-link-text mismatch — the
  // URL appears verbatim either way.
  const text = [
    `Hi ${args.name || 'there'},`,
    '',
    `We received a request to reset the password on your Procela account.`,
    '',
    `Open this link to choose a new password:`,
    resetLink,
    '',
    `The link expires in ${args.ttlMinutes} minutes and can only be used once.`,
    '',
    `If you didn't request this, you can safely ignore this email — your`,
    `password won't change unless you click the link.`,
    '',
    '— Procela',
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, system-ui, sans-serif; color: #1e293b; max-width: 480px;">
      <p>Hi ${escapeHtml(args.name || 'there')},</p>
      <p>We received a request to reset the password on your Procela account.</p>
      <p>
        <a href="${resetLink}" style="display: inline-block; padding: 10px 18px; background: #0f4f46; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
          Choose a new password
        </a>
      </p>
      <p style="font-size: 13px; color: #64748b;">
        Or paste this link in a browser:<br/>
        <a href="${resetLink}" style="color: #0f4f46;">${escapeHtml(resetLink)}</a>
      </p>
      <p style="font-size: 13px; color: #64748b;">
        The link expires in ${args.ttlMinutes} minutes and can only be used once.
      </p>
      <p style="font-size: 13px; color: #64748b;">
        If you didn't request this, you can safely ignore this email — your password
        won't change unless you click the link.
      </p>
      <p style="font-size: 12px; color: #94a3b8; margin-top: 24px;">— Procela</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: config.from,
      to: args.to,
      subject,
      text,
      html,
    });
    return true;
  } catch (err) {
    logger.warn({ err, to: args.to }, 'Failed to deliver password reset email');
    return false;
  }
}

/** Send an in-app "Report a problem" submission to the support inbox.
 *  Returns true on successful send, false otherwise (not configured, no
 *  recipient, or a delivery error). The /support route records the audit
 *  entry regardless — this only handles delivery. */
export async function sendSupportEmail(args: {
  to: string;
  reporterName: string;
  reporterEmail: string;
  orgId: string;
  category: string;
  message: string;
  context: Record<string, string>;
}): Promise<boolean> {
  if (!isConfigured() || !transporter || !config || !args.to) return false;

  const subject = `[Procela support] ${args.category}: ${args.message.slice(0, 60).replace(/\s+/g, ' ')}`;
  const ctxLines = Object.entries(args.context).map(([k, v]) => `${k}: ${v}`);
  const text = [
    `A Procela user submitted a support request.`,
    '',
    `From:     ${args.reporterName} <${args.reporterEmail}>`,
    `Org:      ${args.orgId}`,
    `Category: ${args.category}`,
    '',
    'Message:',
    args.message,
    '',
    '— context —',
    ...ctxLines,
    '',
    '— Procela',
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, system-ui, sans-serif; color: #1e293b; max-width: 560px;">
      <p>A Procela user submitted a support request.</p>
      <table style="font-size: 13px; color: #334155; border-collapse: collapse;">
        <tr><td style="padding: 2px 12px 2px 0; color: #64748b;">From</td><td>${escapeHtml(args.reporterName)} &lt;${escapeHtml(args.reporterEmail)}&gt;</td></tr>
        <tr><td style="padding: 2px 12px 2px 0; color: #64748b;">Org</td><td>${escapeHtml(args.orgId)}</td></tr>
        <tr><td style="padding: 2px 12px 2px 0; color: #64748b;">Category</td><td>${escapeHtml(args.category)}</td></tr>
      </table>
      <p style="white-space: pre-wrap; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px;">${escapeHtml(args.message)}</p>
      <p style="font-size: 12px; color: #94a3b8;">${ctxLines.map(escapeHtml).join('<br/>')}</p>
      <p style="font-size: 12px; color: #94a3b8; margin-top: 20px;">— Procela</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: config.from,
      to: args.to,
      replyTo: args.reporterEmail || undefined,
      subject,
      text,
      html,
    });
    return true;
  } catch (err) {
    logger.warn({ err, to: args.to }, 'Failed to deliver support email');
    return false;
  }
}

/** Send a weekly-digest email — the same gap-signal deltas the in-app
 *  notifications carry, delivered to a user who opted in. Each item links
 *  back into the app. Returns true on successful send, false otherwise
 *  (not configured, no recipient, no items, or a delivery error). */
export async function sendDigestEmail(args: {
  to: string;
  name: string;
  orgName: string;
  items: Array<{ title: string; message: string; link: string }>;
}): Promise<boolean> {
  if (!isConfigured() || !transporter || !config || !args.to || args.items.length === 0) return false;

  const base = config.appUrl.replace(/\/$/, '');
  const abs = (link: string) => (link.startsWith('http') ? link : `${base}${link.startsWith('/') ? '' : '/'}${link}`);
  const subject = `Procela weekly digest — ${args.items.length} update${args.items.length === 1 ? '' : 's'} for ${args.orgName}`;

  const text = [
    `Hi ${args.name || 'there'},`,
    '',
    `Here's what changed in ${args.orgName}'s data-governance picture this week:`,
    '',
    ...args.items.flatMap((it) => [`• ${it.title}`, `  ${it.message}`, `  ${abs(it.link)}`, '']),
    `You're receiving this because you turned on email delivery for the weekly`,
    `digest. Change your preferences in Procela under Settings.`,
    '',
    '— Procela',
  ].join('\n');

  const rows = args.items.map((it) => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0;">
        <a href="${abs(it.link)}" style="color: #0f4f46; font-weight: 600; text-decoration: none;">${escapeHtml(it.title)}</a>
        <div style="font-size: 13px; color: #64748b; margin-top: 2px;">${escapeHtml(it.message)}</div>
      </td>
    </tr>`).join('');

  const html = `
    <div style="font-family: -apple-system, system-ui, sans-serif; color: #1e293b; max-width: 560px;">
      <p>Hi ${escapeHtml(args.name || 'there')},</p>
      <p>Here's what changed in <strong>${escapeHtml(args.orgName)}</strong>'s data-governance picture this week:</p>
      <table style="width: 100%; border-collapse: collapse;">${rows}</table>
      <p style="font-size: 12px; color: #94a3b8; margin-top: 20px;">
        You're receiving this because you turned on email delivery for the weekly digest.
        Change your preferences in Procela under Settings.
      </p>
      <p style="font-size: 12px; color: #94a3b8;">— Procela</p>
    </div>
  `;

  try {
    await transporter.sendMail({ from: config.from, to: args.to, subject, text, html });
    return true;
  } catch (err) {
    logger.warn({ err, to: args.to }, 'Failed to deliver digest email');
    return false;
  }
}

/** Deliver a rendered report by email with a CSV attachment. Used by the
 *  scheduled-report sweep. Returns true on successful send, false otherwise
 *  (not configured, no recipients, or a delivery error). */
export async function sendReportEmail(args: {
  to: string[];
  reportName: string;
  orgName: string;
  headers: string[];
  rows: Array<Array<string | number | boolean | null | undefined>>;
  totalMatched: number;
}): Promise<boolean> {
  if (!isConfigured() || !transporter || !config || args.to.length === 0) return false;

  const cell = (c: unknown): string => (c === null || c === undefined) ? '' : String(c);
  const csvEscape = (c: unknown): string => `"${cell(c).replace(/"/g, '""')}"`;
  const csv = [
    args.headers.map(csvEscape).join(','),
    ...args.rows.map((r) => r.map(csvEscape).join(',')),
  ].join('\r\n');

  const base = (args.reportName || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
  const capped = args.totalMatched > args.rows.length;
  const subject = `Procela report — ${args.reportName} (${args.rows.length} row${args.rows.length === 1 ? '' : 's'})`;

  const text = [
    `Your scheduled Procela report "${args.reportName}" for ${args.orgName} is attached.`,
    '',
    `Rows: ${args.rows.length}${capped ? ` (of ${args.totalMatched} matched — capped)` : ''}`,
    `Generated: ${new Date().toLocaleString()}`,
    '',
    `The full result set is attached as ${base}.csv.`,
    '',
    '— Procela',
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, system-ui, sans-serif; color: #1e293b; max-width: 520px;">
      <p>Your scheduled Procela report <strong>${escapeHtml(args.reportName)}</strong> for
         <strong>${escapeHtml(args.orgName)}</strong> is attached.</p>
      <table style="font-size: 13px; color: #334155; border-collapse: collapse;">
        <tr><td style="padding: 2px 12px 2px 0; color: #64748b;">Rows</td><td>${args.rows.length}${capped ? ` <span style="color:#94a3b8;">(of ${args.totalMatched} matched — capped)</span>` : ''}</td></tr>
        <tr><td style="padding: 2px 12px 2px 0; color: #64748b;">Generated</td><td>${escapeHtml(new Date().toLocaleString())}</td></tr>
      </table>
      <p style="font-size: 13px; color: #64748b;">The full result set is attached as ${escapeHtml(base)}.csv.</p>
      <p style="font-size: 12px; color: #94a3b8; margin-top: 20px;">— Procela</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: config.from,
      to: args.to,
      subject,
      text,
      html,
      attachments: [{ filename: `${base}.csv`, content: csv, contentType: 'text/csv; charset=utf-8' }],
    });
    return true;
  } catch (err) {
    logger.warn({ err, count: args.to.length }, 'Failed to deliver scheduled report email');
    return false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
