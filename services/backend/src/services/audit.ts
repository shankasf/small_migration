import { PrismaClient } from '@prisma/client';
import { trace } from '@opentelemetry/api';
import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export interface AuditInput {
  userId?: string | null;
  action: string;
  resource?: string | null;
  decision?: 'allow' | 'deny' | 'blocked';
  dataClass?: string | null;
  severity?: 'info' | 'warning' | 'critical';
  detail?: string | null;
  ip?: string | null;
}

// Audit metadata is deliberately not a content archive. Unknown detail keys
// are discarded so a new caller cannot accidentally log a prompt or secret.
const DETAIL_KEYS = new Set(['reason', 'reasons', 'decision', 'findings', 'type', 'count', 'changed',
  'role', 'status', 'required', 'actual', 'passwordReset', 'dryRun', 'candidates', 'provider', 'policyVersion']);
export function scrubAuditDetail(detail?: string | null): string | null {
  if (!detail) return null;
  try {
    const input = JSON.parse(detail);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const output = JSON.stringify(Object.fromEntries(Object.entries(input).filter(([key]) => DETAIL_KEYS.has(key))));
    return output.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]')
      .replace(/\b[A-HJ-NP-Z]{3}(?:\d{4}|\d{2}[A-HJ-NP-Z]{2})\b/g, '[NHI]')
      .replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{20,}\b/g, '[SECRET]').slice(0, 4000);
  } catch { return null; }
}

let archive: S3Client | undefined;
export async function recordAudit(prisma: PrismaClient, evt: AuditInput): Promise<void> {
  const data = {
    id: randomUUID(), createdAt: new Date(), userId: evt.userId || null,
    action: evt.action, resource: evt.resource || null, decision: evt.decision || 'allow',
    dataClass: evt.dataClass || null, severity: evt.severity || 'info',
    detail: scrubAuditDetail(evt.detail), ip: evt.ip || null,
  };
  try {
    const bucket = process.env.AUDIT_ARCHIVE_BUCKET;
    if (process.env.AUDIT_ARCHIVE_REQUIRED === 'true' && !bucket) throw new Error('Audit archive is required');
    if (bucket) {
      archive ||= new S3Client({});
      // Every version receives an indefinite legal hold. Runtime credentials
      // can place holds, but a bucket policy prevents releasing them.
      await archive.send(new PutObjectCommand({Bucket: bucket,
        Key: `audit/${data.createdAt.toISOString().slice(0, 10)}/${data.id}.json`,
        Body: JSON.stringify(data), ContentType: 'application/json', ServerSideEncryption: 'AES256', ObjectLockLegalHoldStatus: 'ON'}));
    }
    await prisma.auditEvent.create({data});
    trace.getActiveSpan()?.addEvent('audit.event', {'audit.action': data.action,
      'audit.decision': data.decision, 'audit.severity': data.severity});
    console.log(JSON.stringify({event: 'security.audit', action: data.action, severity: data.severity, decision: data.decision}));
  } catch {
    console.error('[AUDIT_FAILED] Durable audit write failed');
    throw new Error('Durable audit unavailable');
  }
}

/** Denials stay denied even when their audit sink is unavailable. */
export async function recordDeniedAudit(prisma: PrismaClient, evt: AuditInput): Promise<void> {
  try { await recordAudit(prisma, evt); } catch { /* recordAudit already emits the failure alarm */ }
}
