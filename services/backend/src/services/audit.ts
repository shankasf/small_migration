import { PrismaClient } from '@prisma/client';
import { trace } from '@opentelemetry/api';

export interface AuditInput {
  userId?: string | null;
  action: string;
  resource?: string | null;
  decision?: 'allow' | 'deny' | 'blocked';
  dataClass?: string | null;
  severity?: 'info' | 'warning' | 'critical';
  detail?: string | null; // must already be PII-scrubbed
  ip?: string | null;
}

/**
 * Append-only audit trail (who / what / when / decision / data class).
 * Persisted to the AuditEvent table and mirrored as an OTEL span event so it
 * reaches the SIEM through the collector. Fire-and-forget: audit failures are
 * logged but never break the request path.
 */
export function recordAudit(prisma: PrismaClient, evt: AuditInput): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent('audit.event', {
      'audit.action': evt.action,
      'audit.decision': evt.decision || 'allow',
      'audit.severity': evt.severity || 'info',
      ...(evt.userId ? { 'enduser.id': evt.userId } : {}),
      ...(evt.resource ? { 'audit.resource': evt.resource } : {}),
      ...(evt.dataClass ? { 'audit.data_class': evt.dataClass } : {}),
    });
  }

  prisma.auditEvent
    .create({
      data: {
        userId: evt.userId || null,
        action: evt.action,
        resource: evt.resource || null,
        decision: evt.decision || 'allow',
        dataClass: evt.dataClass || null,
        severity: evt.severity || 'info',
        detail: evt.detail || null,
        ip: evt.ip || null,
      },
    })
    .catch(err => console.error('[AUDIT] Failed to record event:', err?.message || err));
}
