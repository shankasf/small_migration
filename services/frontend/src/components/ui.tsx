import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

// ── Eyebrow / section label ────────────────────────────────────────────────
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('eyebrow', className)}>{children}</div>;
}

// ── Status chips (roles, account status, decisions, severity) ──────────────
const STATUS_STYLES: Record<string, string> = {
  active: '!border-success/40 !text-success',
  restricted: '!border-warn/40 !text-warn',
  disabled: '!border-danger/40 !text-danger',
  admin: '!border-brass/40 !text-brass-bright',
  analyst: '!border-signal/40 !text-signal',
  auditor: '!border-warn/40 !text-warn',
  allow: '!border-success/40 !text-success',
  deny: '!border-warn/40 !text-warn',
  block: '!border-danger/40 !text-danger',
  info: '!border-hairline !text-muted',
  warning: '!border-warn/40 !text-warn',
  critical: '!border-danger/40 !text-danger',
};

export function StatusChip({ value }: { value?: string }) {
  if (!value) return null;
  return (
    <span className={cx('chip !py-0.5 capitalize', STATUS_STYLES[value])}>
      <span
        className={cx(
          'h-1.5 w-1.5 rounded-full',
          STATUS_STYLES[value]?.includes('success')
            ? 'bg-success'
            : STATUS_STYLES[value]?.includes('danger')
              ? 'bg-danger'
              : STATUS_STYLES[value]?.includes('warn')
                ? 'bg-warn'
                : STATUS_STYLES[value]?.includes('signal')
                  ? 'bg-signal'
                  : STATUS_STYLES[value]?.includes('brass')
                    ? 'bg-brass'
                    : 'bg-faint',
        )}
      />
      {value.replace(/_/g, ' ')}
    </span>
  );
}

// ── Button ─────────────────────────────────────────────────────────────────
type BtnVariant = 'brass' | 'ghost' | 'subtle' | 'danger';
export function Button({
  children,
  variant = 'subtle',
  loading,
  className,
  type = 'button',
  sm,
  ...rest
}: {
  children: ReactNode;
  variant?: BtnVariant;
  loading?: boolean;
  sm?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    variant === 'brass'
      ? 'btn-brass'
      : variant === 'ghost'
        ? 'btn-ghost'
        : variant === 'danger'
          ? 'btn-danger'
          : 'btn-subtle';
  return (
    <button
      type={type}
      className={cx(base, sm && 'btn-sm', className)}
      disabled={rest.disabled || loading}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

// ── Spinner ────────────────────────────────────────────────────────────────
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('h-5 w-5 animate-spin text-brass', className)} />;
}

export function CenterSpinner({ label }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[40vh] w-full flex-col items-center justify-center gap-3 text-muted">
      <Spinner />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-hairline bg-panel/50 px-6 py-16 text-center">
      {icon && (
        <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-xl border border-hairline bg-elevated text-brass">
          {icon}
        </div>
      )}
      <h3 className="font-display text-lg font-600 text-ink">{title}</h3>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────
export function Modal({
  open,
  onClose,
  title,
  children,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  if (!open) return null;
  // Portal to <body> so the overlay is viewport-fixed even when an ancestor has
  // a CSS transform (e.g. animate-fade-up), which would otherwise trap `fixed`.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-obsidian/80 p-4 pt-[8vh] backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className={cx('panel-elevated w-full animate-fade-up p-6', width)}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h2 className="mb-4 font-display text-lg font-600 text-ink">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ── Field wrapper ──────────────────────────────────────────────────────────
export function Field({
  label,
  help,
  required,
  children,
}: {
  label: string;
  help?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-[13px] font-500 text-ink/90">
        {label}
        {required && <span className="text-brass">*</span>}
      </span>
      {children}
      {help && <span className="mt-1 block text-xs text-faint">{help}</span>}
    </label>
  );
}

// ── Stat readout ───────────────────────────────────────────────────────────
export function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="panel p-4">
      <div className="eyebrow mb-2">{label}</div>
      <div
        className={cx(
          'font-mono text-2xl font-500 tabular-nums',
          accent ? 'text-brass-bright' : 'text-ink',
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}
