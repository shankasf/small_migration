import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Users, BarChart3, ShieldAlert, RefreshCw, UserPlus, Ban, ShieldCheck, AlertTriangle,
  ScrollText, Activity, Pause, Play, ThumbsUp, ThumbsDown, MessageSquareQuote, ExternalLink,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import { getToken } from '../services/auth';
import {
  adminGetUsers, adminGetUsageSummary, adminGetAudit, adminGetSecuritySummary,
  adminGetAiLogs, adminGetAiLogFacets, adminCreateUser, adminUpdateUser, adminGetFeedback,
  apiErrorMessage,
} from '../services/api';
import type { AdminAiLog, AdminAiLogFacets, AdminAiLogPage } from '../services/api';
import { AdminFeedbackPage, AdminUser, AuditEvent, FeedbackRating, SecuritySummary, UsageSummary, User } from '../types';
import { Button, CenterSpinner, Field, Modal, Stat, StatusChip, Spinner, cx } from '../components/ui';

const num = new Intl.NumberFormat('en-NZ');
const money = (v: number) => `$${v.toFixed(v >= 100 ? 0 : v >= 1 ? 2 : 4)}`;
const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-NZ', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});
const fmtClock = (iso: string) => new Date(iso).toLocaleTimeString('en-NZ', {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

type Tab = 'overview' | 'users' | 'feedback' | 'security' | 'audit' | 'ailogs';

interface AdminPageProps {
  currentUser: User;
}

// ---------------------------------------------------------------- Overview

function DailyTokensChart({ daily }: { daily: UsageSummary['daily'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...daily.map(d => d.tokens));
  if (daily.length === 0) {
    return <div className="h-40 flex items-center justify-center text-sm text-faint">No usage in this window</div>;
  }
  const gridLevels = [0.25, 0.5, 0.75, 1];
  const fmtShort = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v));
  const labelEvery = Math.max(1, Math.ceil(daily.length / 8));

  return (
    <div className="relative">
      <div className="relative h-40 flex items-end gap-[2px] pl-10">
        {gridLevels.map(level => (
          <div
            key={level}
            className="absolute left-10 right-0 border-t border-hairline pointer-events-none"
            style={{ bottom: `${level * 100}%` }}
          >
            <span className="absolute -left-10 -translate-y-1/2 font-mono text-[10px] text-faint tabular-nums">
              {fmtShort(Math.round(max * level))}
            </span>
          </div>
        ))}
        {daily.map((d, i) => (
          <div
            key={d.date}
            className="relative flex-1 h-full flex items-end cursor-pointer"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <div
              className={`w-full rounded-t-[4px] transition-colors ${hover === i ? 'bg-brass-bright' : 'bg-brass'}`}
              style={{ height: `${Math.max(2, (d.tokens / max) * 100)}%` }}
            />
            {hover === i && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-10 panel-elevated text-xs rounded-lg px-3 py-2 whitespace-nowrap">
                <div className="font-600 text-ink">{d.date}</div>
                <div className="font-mono tabular-nums text-muted">{num.format(d.tokens)} tokens · {money(d.costUsd)} · {d.requests} req</div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-[2px] pl-10 mt-1">
        {daily.map((d, i) => (
          <div key={d.date} className="flex-1 text-center font-mono text-[10px] text-faint">
            {i % labelEvery === 0 ? d.date.slice(5) : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

// Admin tables keep every column and every value available. Below desktop
// width a row becomes a labelled record; from `xl` up the table switches to a
// fixed layout whose column widths are declared per table, so columns keep
// steady, readable proportions instead of stretching apart on wide screens.
// Values always wrap — never truncate — so long emails, resource names and
// JSON detail payloads stay complete.
const thCls =
  'sticky top-0 z-10 border-b border-hairline bg-panel px-4 py-3 first:pl-6 last:pr-6 ' +
  'text-left align-bottom font-mono text-[11px] font-medium uppercase tracking-wider text-faint';
const tdCls = 'px-5 py-1.5 align-top break-words xl:px-4 xl:py-3.5 xl:first:pl-6 xl:last:pr-6';
const tableCls = 'block w-full text-sm xl:table xl:table-fixed';
const rowCls =
  'block py-2.5 border-b border-hairline/60 last:border-0 transition-colors ' +
  'hover:bg-elevated/40 xl:table-row xl:py-0';
const tablePanelCls = 'panel overflow-auto overscroll-contain';
const viewportTablePanelCls = 'panel max-h-[calc(100dvh-15rem)] overflow-auto overscroll-contain';
const emptyCellCls = 'block px-6 py-10 text-center text-faint xl:table-cell';

function ResponsiveCell({ label, children, className, valueClassName }: {
  label: string;
  children: ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <td className={cx(tdCls, 'grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-3 xl:table-cell', className)}>
      <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-faint xl:hidden">{label}</span>
      <div className={cx('min-w-0', valueClassName)}>{children}</div>
    </td>
  );
}

function formatAuditDetail(detail: string | null): string {
  if (!detail) return '—';
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons : null;
    const findings = Array.isArray(parsed.findings) ? parsed.findings : null;
    if (parsed.decision === 'allow' && reasons?.length === 0 && findings?.length === 0) {
      return 'Guardrails passed — no reasons or findings.';
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return detail;
  }
}

// Structured (pretty-printed JSON) payloads read as a code block; one-liners
// stay inline prose. Either way the full text is rendered and wrapped.
function AuditDetail({ detail }: { detail: string | null }) {
  const text = formatAuditDetail(detail);
  if (!text.includes('\n')) {
    return <div className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">{text}</div>;
  }
  return (
    <pre className="max-w-full whitespace-pre-wrap break-words rounded-lg border border-hairline/70 bg-obsidian/40 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted">
      {text}
    </pre>
  );
}

function OverviewTab({ days, setDays }: { days: number; setDays: (d: number) => void }) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, u] = await Promise.all([adminGetUsageSummary(days), adminGetUsers()]);
      setSummary(s);
      setUsers(u);
    } catch (err) {
      console.error('Failed to load overview:', err);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const activeUsers = useMemo(() => users.filter(u => u.usage.monthTokens > 0).length, [users]);
  const topUsers = useMemo(
    () => [...users].sort((a, b) => b.usage.monthTokens - a.usage.monthTokens).slice(0, 10),
    [users]
  );

  if (loading && !summary) {
    return <CenterSpinner label="Loading usage…" />;
  }
  if (!summary) return null;

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-700 text-ink">Usage &amp; cost</h2>
        <div className="flex items-center gap-2">
          {[7, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cx('btn-sm rounded-md font-mono text-xs transition', days === d ? 'btn-brass' : 'btn-ghost')}
            >
              {d}d
            </button>
          ))}
          <button onClick={load} className="flex h-8 w-8 items-center justify-center rounded-md border border-hairline text-muted hover:bg-elevated hover:text-ink transition-colors" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Total tokens" value={num.format(summary.totals.totalTokens)} sub={`${num.format(summary.totals.inputTokens)} in / ${num.format(summary.totals.outputTokens)} out`} />
        <Stat label="Cost" value={money(summary.totals.costUsd)} sub={`last ${summary.windowDays} days`} accent />
        <Stat label="Requests" value={num.format(summary.totals.requests)} sub="LLM calls" />
        <Stat label="Active users" value={String(activeUsers)} sub="with usage this month" />
      </div>

      <div className="panel p-5">
        <div className="eyebrow mb-4">Tokens per day</div>
        <DailyTokensChart daily={summary.daily} />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className={tablePanelCls}>
          <div className="eyebrow px-6 pt-5 pb-3">Top users (this month)</div>
          <table className="w-full min-w-[34rem] table-fixed text-sm">
            <colgroup>
              <col className="w-[42%]" />
              <col className="w-[21%]" />
              <col className="w-[19%]" />
              <col className="w-[18%]" />
            </colgroup>
            <thead>
              <tr>
                <th className={thCls}>User</th>
                <th className={cx(thCls, 'text-right')}>Tokens</th>
                <th className={cx(thCls, 'text-right')}>Cost</th>
                <th className={cx(thCls, 'text-right')}>Sessions</th>
              </tr>
            </thead>
            <tbody>
              {topUsers.map(u => (
                <tr key={u.id} className="border-b border-hairline/60 transition-colors last:border-0 hover:bg-elevated/40">
                  <td className={cx(tdCls, 'text-ink')}>{u.email}</td>
                  <td className={cx(tdCls, 'text-right font-mono tabular-nums text-muted')}>{num.format(u.usage.monthTokens)}</td>
                  <td className={cx(tdCls, 'text-right font-mono tabular-nums text-muted')}>{money(u.usage.monthCostUsd)}</td>
                  <td className={cx(tdCls, 'text-right font-mono tabular-nums text-muted')}>{u.usage.sessions}</td>
                </tr>
              ))}
              {topUsers.length === 0 && (
                <tr><td colSpan={4} className="px-6 py-10 text-center text-faint">No users yet</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className={tablePanelCls}>
          <div className="eyebrow px-6 pt-5 pb-3">By model</div>
          <table className="w-full min-w-[34rem] table-fixed text-sm">
            <colgroup>
              <col className="w-[40%]" />
              <col className="w-[20%]" />
              <col className="w-[21%]" />
              <col className="w-[19%]" />
            </colgroup>
            <thead>
              <tr>
                <th className={thCls}>Model</th>
                <th className={thCls}>Provider</th>
                <th className={cx(thCls, 'text-right')}>Tokens</th>
                <th className={cx(thCls, 'text-right')}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map(m => (
                <tr key={`${m.provider}/${m.model}`} className="border-b border-hairline/60 transition-colors last:border-0 hover:bg-elevated/40">
                  <td className={cx(tdCls, 'font-mono text-xs text-brass-bright')}>{m.model}</td>
                  <td className={cx(tdCls, 'text-muted')}>{m.provider}</td>
                  <td className={cx(tdCls, 'text-right font-mono tabular-nums text-muted')}>{num.format(m.totalTokens)}</td>
                  <td className={cx(tdCls, 'text-right font-mono tabular-nums text-muted')}>{money(m.costUsd)}</td>
                </tr>
              ))}
              {summary.byModel.length === 0 && (
                <tr><td colSpan={4} className="px-6 py-10 text-center text-faint">No usage in this window</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Users

function UserEditModal({ user, currentUser, onClose, onSaved }: {
  user: AdminUser; currentUser: User; onClose: () => void; onSaved: () => void;
}) {
  const [role, setRole] = useState(user.role);
  const [status, setStatus] = useState(user.status);
  const [daily, setDaily] = useState(user.dailyTokenLimit?.toString() ?? '');
  const [monthly, setMonthly] = useState(user.monthlyTokenLimit?.toString() ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isSelf = user.id === currentUser.id;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminUpdateUser(user.id, {
        role,
        status,
        dailyTokenLimit: daily === '' ? null : parseInt(daily, 10),
        monthlyTokenLimit: monthly === '' ? null : parseInt(monthly, 10),
        ...(password ? { password } : {}),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Edit ${user.email}`}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role">
            <select value={role} onChange={e => setRole(e.target.value as AdminUser['role'])} className="field" disabled={isSelf}>
              <option value="admin">admin</option>
              <option value="analyst">analyst</option>
              <option value="auditor">auditor</option>
            </select>
          </Field>
          <Field label="Status">
            <select value={status} onChange={e => setStatus(e.target.value as AdminUser['status'])} className="field" disabled={isSelf}>
              <option value="active">active</option>
              <option value="restricted">restricted (read-only)</option>
              <option value="disabled">disabled</option>
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Daily token cap">
            <input type="number" min="0" value={daily} onChange={e => setDaily(e.target.value)} placeholder="unlimited" className="field" />
          </Field>
          <Field label="Monthly token cap">
            <input type="number" min="0" value={monthly} onChange={e => setMonthly(e.target.value)} placeholder="unlimited" className="field" />
          </Field>
        </div>
        <Field label="Reset password (optional)">
          <input type="text" value={password} onChange={e => setPassword(e.target.value)} placeholder="leave blank to keep current" className="field" />
        </Field>
        {isSelf && <p className="text-xs text-warn">You cannot change your own role or disable your own account.</p>}
        {error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
        <Button variant="brass" loading={busy} onClick={save} className="w-full">
          Save changes
        </Button>
      </div>
    </Modal>
  );
}

function CreateUserModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('analyst');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminCreateUser({ email, name: name || undefined, role, password });
      onSaved();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Create user">
      <div className="space-y-4">
        <Field label="Email" required>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="field" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input value={name} onChange={e => setName(e.target.value)} className="field" />
          </Field>
          <Field label="Role">
            <select value={role} onChange={e => setRole(e.target.value)} className="field">
              <option value="analyst">analyst</option>
              <option value="admin">admin</option>
              <option value="auditor">auditor</option>
            </select>
          </Field>
        </div>
        <Field label="Initial password" help="Minimum 10 characters" required>
          <input type="text" value={password} onChange={e => setPassword(e.target.value)} className="field" />
        </Field>
        {error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
        <Button variant="brass" loading={busy} disabled={!email || password.length < 10} onClick={save} className="w-full">
          Create user
        </Button>
      </div>
    </Modal>
  );
}

function UsersTab({ currentUser }: { currentUser: User }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await adminGetUsers());
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const quickSetStatus = async (u: AdminUser, status: string) => {
    try {
      await adminUpdateUser(u.id, { status });
      load();
    } catch (err) {
      alert(apiErrorMessage(err));
    }
  };

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-700 text-ink">Users</h2>
        <Button variant="brass" sm onClick={() => setCreating(true)}>
          <UserPlus className="w-4 h-4" /> New user
        </Button>
      </div>

      <div className={viewportTablePanelCls}>
        <table className={cx(tableCls, 'xl:min-w-[68rem]')}>
          <colgroup className="hidden xl:table-column-group">
            <col className="w-[24%]" />
            <col className="w-[9%]" />
            <col className="w-[10%]" />
            <col className="w-[11%]" />
            <col className="w-[10%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead className="hidden xl:table-header-group">
            <tr>
              <th className={thCls}>User</th>
              <th className={thCls}>Role</th>
              <th className={thCls}>Status</th>
              <th className={cx(thCls, 'text-right')}>Month tokens</th>
              <th className={cx(thCls, 'text-right')}>Month cost</th>
              <th className={cx(thCls, 'text-right')}>Caps (d/m)</th>
              <th className={thCls}>Last login</th>
              <th className={cx(thCls, 'text-right')}>Actions</th>
            </tr>
          </thead>
          <tbody className="block xl:table-row-group">
            {users.map(u => (
              <tr key={u.id} className={rowCls}>
                <ResponsiveCell label="User">
                  <div className="break-words text-ink">{u.email}</div>
                  {u.name && <div className="mt-0.5 text-xs text-faint">{u.name}</div>}
                </ResponsiveCell>
                <ResponsiveCell label="Role"><StatusChip value={u.role} /></ResponsiveCell>
                <ResponsiveCell label="Status"><StatusChip value={u.status} /></ResponsiveCell>
                <ResponsiveCell label="Month tokens" valueClassName="font-mono tabular-nums text-muted xl:text-right">{num.format(u.usage.monthTokens)}</ResponsiveCell>
                <ResponsiveCell label="Month cost" valueClassName="font-mono tabular-nums text-muted xl:text-right">{money(u.usage.monthCostUsd)}</ResponsiveCell>
                <ResponsiveCell label="Caps (d/m)" valueClassName="font-mono tabular-nums text-xs text-faint xl:text-right">
                  {u.dailyTokenLimit ? num.format(u.dailyTokenLimit) : '∞'} / {u.monthlyTokenLimit ? num.format(u.monthlyTokenLimit) : '∞'}
                </ResponsiveCell>
                <ResponsiveCell label="Last login" valueClassName="text-xs text-faint">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : 'never'}</ResponsiveCell>
                <ResponsiveCell label="Actions">
                  <div className="flex flex-wrap items-center gap-1.5 xl:justify-end">
                    <Button variant="ghost" sm onClick={() => setEditing(u)}>Edit</Button>
                    {u.id !== currentUser.id && (u.status === 'active' ? (
                      <button onClick={() => quickSetStatus(u, 'disabled')} title="Disable user" className="p-1.5 rounded-lg text-danger hover:bg-danger/10 transition-colors"><Ban className="w-4 h-4" /></button>
                    ) : (
                      <button onClick={() => quickSetStatus(u, 'active')} title="Re-enable user" className="p-1.5 rounded-lg text-success hover:bg-success/10 transition-colors"><ShieldCheck className="w-4 h-4" /></button>
                    ))}
                  </div>
                </ResponsiveCell>
              </tr>
            ))}
            {!loading && users.length === 0 && (
              <tr className="block xl:table-row"><td colSpan={8} className={emptyCellCls}>No users</td></tr>
            )}
          </tbody>
        </table>
        {loading && <div className="flex justify-center py-6"><Spinner /></div>}
      </div>

      {editing && <UserEditModal user={editing} currentUser={currentUser} onClose={() => setEditing(null)} onSaved={load} />}
      {creating && <CreateUserModal onClose={() => setCreating(false)} onSaved={load} />}
    </div>
  );
}

// ---------------------------------------------------------------- Security

function SecurityTab({ days }: { days: number }) {
  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [filter, setFilter] = useState<'issues' | 'all'>('issues');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, e] = await Promise.all([
        adminGetSecuritySummary(days),
        adminGetAudit({ limit: 200 }),
      ]);
      setSummary(s);
      setEvents(e);
    } catch (err) {
      console.error('Failed to load security data:', err);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const shown = filter === 'all' ? events : events.filter(e => e.decision !== 'allow' || e.severity !== 'info');

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-700 text-ink">Security &amp; audit</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setFilter('issues')} className={cx('btn-sm rounded-md text-xs transition', filter === 'issues' ? 'btn-brass' : 'btn-ghost')}>Issues only</button>
          <button onClick={() => setFilter('all')} className={cx('btn-sm rounded-md text-xs transition', filter === 'all' ? 'btn-brass' : 'btn-ghost')}>All activity</button>
          <button onClick={load} className="flex h-8 w-8 items-center justify-center rounded-md border border-hairline text-muted hover:bg-elevated hover:text-ink transition-colors" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {summary && summary.counts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {summary.counts.map(c => (
            <div key={`${c.action}-${c.decision}`} className="chip !py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-warn" />
              <span className="font-medium text-ink">{c.action}</span>
              <span className="text-faint">({c.decision})</span>
              <span className="font-mono font-600 text-ink tabular-nums">{c.count}</span>
            </div>
          ))}
        </div>
      )}

      <div className={viewportTablePanelCls}>
        <table className={cx(tableCls, 'xl:min-w-[62rem]')}>
          <colgroup className="hidden xl:table-column-group">
            <col className="w-[11%]" />
            <col className="w-[16%]" />
            <col className="w-[14%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[41%]" />
          </colgroup>
          <thead className="hidden xl:table-header-group">
            <tr>
              <th className={thCls}>Time</th>
              <th className={thCls}>User</th>
              <th className={thCls}>Action</th>
              <th className={thCls}>Decision</th>
              <th className={thCls}>Severity</th>
              <th className={thCls}>Detail</th>
            </tr>
          </thead>
          <tbody className="block xl:table-row-group">
            {shown.map(e => (
              <tr key={e.id} className={rowCls}>
                <ResponsiveCell label="Time" valueClassName="font-mono text-xs text-faint">{fmtDate(e.createdAt)}</ResponsiveCell>
                <ResponsiveCell label="User" valueClassName="break-words text-xs text-muted">{e.user?.email || '—'}</ResponsiveCell>
                <ResponsiveCell label="Action" valueClassName="break-words font-mono text-xs text-ink">{e.action}</ResponsiveCell>
                <ResponsiveCell label="Decision"><StatusChip value={e.decision} /></ResponsiveCell>
                <ResponsiveCell label="Severity"><StatusChip value={e.severity} /></ResponsiveCell>
                <ResponsiveCell label="Detail"><AuditDetail detail={e.detail} /></ResponsiveCell>
              </tr>
            ))}
            {!loading && shown.length === 0 && (
              <tr className="block xl:table-row"><td colSpan={6} className={emptyCellCls}>No events</td></tr>
            )}
          </tbody>
        </table>
        {loading && <div className="flex justify-center py-6"><Spinner /></div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Audit logs

function AuditTab() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionInput, setActionInput] = useState('');
  const [action, setAction] = useState('');
  const [decision, setDecision] = useState('');
  const [severity, setSeverity] = useState('');
  const [limit, setLimit] = useState(200);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await adminGetAudit({
        ...(action ? { action } : {}),
        ...(decision ? { decision } : {}),
        ...(severity ? { severity } : {}),
        limit,
      }));
    } catch (err) {
      console.error('Failed to load audit events:', err);
    } finally {
      setLoading(false);
    }
  }, [action, decision, severity, limit]);

  useEffect(() => { load(); }, [load]);

  const selectCls = 'field !h-8 !py-0 !px-2 !text-xs !w-auto';

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-700 text-ink">Audit logs</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="field !h-8 !py-0 !px-2 !text-xs w-44"
            placeholder="Filter action (Enter)…"
            value={actionInput}
            onChange={e => setActionInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') setAction(actionInput.trim()); }}
          />
          <select className={selectCls} value={decision} onChange={e => setDecision(e.target.value)}>
            <option value="">All decisions</option>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
            <option value="blocked">blocked</option>
          </select>
          <select className={selectCls} value={severity} onChange={e => setSeverity(e.target.value)}>
            <option value="">All severities</option>
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="critical">critical</option>
          </select>
          <select className={selectCls} value={limit} onChange={e => setLimit(Number(e.target.value))}>
            <option value={100}>100 rows</option>
            <option value={200}>200 rows</option>
            <option value={500}>500 rows</option>
          </select>
          <button onClick={load} className="flex h-8 w-8 items-center justify-center rounded-md border border-hairline text-muted hover:bg-elevated hover:text-ink transition-colors" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className={viewportTablePanelCls}>
        <table className={cx(tableCls, 'xl:min-w-[70rem]')}>
          <colgroup className="hidden xl:table-column-group">
            <col className="w-[10%]" />
            <col className="w-[15%]" />
            <col className="w-[15%]" />
            <col className="w-[8%]" />
            <col className="w-[8%]" />
            <col className="w-[9%]" />
            <col className="w-[35%]" />
          </colgroup>
          <thead className="hidden xl:table-header-group">
            <tr>
              <th className={thCls}>Time</th>
              <th className={thCls}>User</th>
              <th className={thCls}>Action</th>
              <th className={thCls}>Decision</th>
              <th className={thCls}>Severity</th>
              <th className={thCls}>IP</th>
              <th className={thCls}>Detail</th>
            </tr>
          </thead>
          <tbody className="block xl:table-row-group">
            {events.map(e => (
              <tr key={e.id} className={rowCls}>
                <ResponsiveCell label="Time" valueClassName="font-mono text-xs text-faint">{fmtDate(e.createdAt)}</ResponsiveCell>
                <ResponsiveCell label="User" valueClassName="break-words text-xs text-muted">{e.user?.email || '—'}</ResponsiveCell>
                <ResponsiveCell label="Action" valueClassName="break-words font-mono text-xs text-ink">
                  {e.action}
                  {e.resource && <span className="mt-0.5 block whitespace-pre-wrap break-words text-faint">{e.resource}</span>}
                </ResponsiveCell>
                <ResponsiveCell label="Decision"><StatusChip value={e.decision} /></ResponsiveCell>
                <ResponsiveCell label="Severity"><StatusChip value={e.severity} /></ResponsiveCell>
                <ResponsiveCell label="IP" valueClassName="break-words font-mono text-xs text-faint">{e.ip || '—'}</ResponsiveCell>
                <ResponsiveCell label="Detail"><AuditDetail detail={e.detail} /></ResponsiveCell>
              </tr>
            ))}
            {!loading && events.length === 0 && (
              <tr className="block xl:table-row"><td colSpan={7} className={emptyCellCls}>No events match these filters</td></tr>
            )}
          </tbody>
        </table>
        {loading && <div className="flex justify-center py-6"><Spinner /></div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- AI logs (live)

// Event vocabulary emitted by the agent pipeline. Each row of the log is one
// of these; the colour carries severity, the chip carries the kind of step.
const STEP_LABELS: Record<string, string> = {
  'turn.start': 'Turn start',
  'guardrail': 'Guardrail',
  'llm.call': 'Model call',
  'tool.call': 'Tool call',
  'tool.result': 'Tool result',
  'agent.output': 'Output',
  'turn.complete': 'Turn summary',
  'error': 'Error',
};

const stepStyle = (step: string, type: string) =>
  type === 'error' ? '!border-danger/40 !text-danger'
  : step === 'llm.call' || step === 'turn.complete' ? '!border-brass/40 !text-brass-bright'
  : step.startsWith('tool.') ? '!border-signal/40 !text-signal'
  : step === 'guardrail' ? '!border-warn/40 !text-warn'
  : step === 'agent.output' ? '!border-success/40 !text-success'
  : '!border-hairline !text-muted';

const logTextColor = (type: string) =>
  type === 'error' ? 'text-danger'
  : type === 'success' ? 'text-ink'
  : type === 'thinking' || type === 'progress' ? 'text-faint'
  : 'text-muted';

const shortId = (id?: string | null) => (id ? id.slice(0, 8) : '—');

function prettyDetail(detail: string | null): string | null {
  if (!detail) return null;
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

/** One activity row; the detail payload (tool args, result, output) expands. */
function AiLogRow({ log }: { log: AdminAiLog }) {
  const [open, setOpen] = useState(false);
  const detail = prettyDetail(log.detail);
  const hasTokens = log.totalTokens > 0;

  return (
    <div className="border-b border-hairline/50 last:border-0">
      <button
        type="button"
        onClick={() => detail && setOpen(o => !o)}
        className={cx(
          'grid w-full grid-cols-1 items-start gap-x-4 gap-y-1.5 px-6 py-3 text-left transition-colors',
          'lg:grid-cols-[5.5rem_13rem_8.5rem_7rem_minmax(0,1fr)_7.5rem]',
          detail ? 'cursor-pointer hover:bg-elevated/40' : 'cursor-default',
        )}
      >
        <span className="font-mono text-[11px] tabular-nums text-faint">{fmtClock(log.timestamp)}</span>

        <span className="min-w-0">
          <span className="block break-words text-xs text-ink">{log.userEmail || 'unattributed'}</span>
          <span className="block font-mono text-[10px] text-faint">
            user {shortId(log.userId)} · turn {shortId(log.turnId)}
          </span>
        </span>

        <span className="min-w-0">
          <span className={cx('chip !py-0.5 !text-[10px] uppercase tracking-wide', stepStyle(log.step, log.type))}>
            {STEP_LABELS[log.step] || log.step}
          </span>
        </span>

        <span className="min-w-0 font-mono text-[11px] text-signal">
          {log.tool || (log.model ? <span className="text-brass">{log.model}</span> : <span className="text-faint">—</span>)}
        </span>

        <span className={cx('min-w-0 whitespace-pre-wrap break-words text-xs leading-relaxed', logTextColor(log.type))}>
          {log.message}
          {detail && (
            <span className="ml-2 font-mono text-[10px] text-faint">{open ? '▾ hide detail' : '▸ detail'}</span>
          )}
        </span>

        <span className="min-w-0 font-mono text-[11px] tabular-nums lg:text-right">
          {hasTokens ? (
            <>
              <span className="block text-ink">{num.format(log.totalTokens)} tok</span>
              <span className="block text-[10px] text-faint">
                {num.format(log.inputTokens)} in / {num.format(log.outputTokens)} out
              </span>
              <span className="block text-[10px] text-brass">{money(log.costUsd)}</span>
            </>
          ) : log.durationMs != null ? (
            <span className="block text-faint">{log.durationMs} ms</span>
          ) : (
            <span className="block text-faint">—</span>
          )}
        </span>
      </button>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 pb-3 font-mono text-[11px] text-faint">
        <span className="break-all select-text">Chat / session ID: {log.sessionId}</span>
        {log.turnId && <span className="break-all select-text">Turn ID: {log.turnId}</span>}
      </div>

      {open && detail && (
        <pre className="mx-6 mb-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline/70 bg-obsidian/40 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted">
          {detail}
        </pre>
      )}
    </div>
  );
}

function AiLogsTab({ initialSessionId }: { initialSessionId: string }) {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [sessionInput, setSessionInput] = useState(initialSessionId);
  const [logs, setLogs] = useState<AdminAiLog[]>([]);
  const [facets, setFacets] = useState<AdminAiLogFacets | null>(null);
  const [totals, setTotals] = useState<AdminAiLogPage['totals'] | null>(null);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);

  // Filters. `userId` is the important one: the log is read per user id, so an
  // admin can follow exactly what one person's turns asked the agent to do.
  const [userId, setUserId] = useState('');
  const [step, setStep] = useState('');
  const [tool, setTool] = useState('');
  const [days, setDays] = useState(7);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const filtersRef = useRef({ userId, sessionId, step, tool, search });
  filtersRef.current = { userId, sessionId, step, tool, search };
  const pausedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [page, facetData] = await Promise.all([
        adminGetAiLogs({ userId, sessionId, step, tool, q: search, days, limit: 500 }),
        adminGetAiLogFacets(days),
      ]);
      setLogs(page.entries);
      setTotals(page.totals);
      setFacets(facetData);
    } catch (err) {
      console.error('Failed to load AI activity:', err);
    } finally {
      setLoading(false);
    }
  }, [userId, sessionId, step, tool, search, days]);

  useEffect(() => { load(); }, [load]);

  // Live tail. Events arriving for a filtered-out user are dropped client-side
  // so the view keeps meaning what its filters say it means.
  useEffect(() => {
    const socket = io(window.location.origin, {
      path: '/api/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      auth: { token: getToken() },
    });
    socket.on('connect', () => {
      setConnected(true);
      socket.emit('join-admin-logs');
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('admin-log', (log: AdminAiLog) => {
      if (pausedRef.current) return;
      const f = filtersRef.current;
      if (f.userId && log.userId !== f.userId) return;
      if (f.sessionId && log.sessionId !== f.sessionId) return;
      if (f.step && log.step !== f.step) return;
      if (f.tool && log.tool !== f.tool) return;
      if (f.search && !`${log.sessionId} ${log.turnId || ''} ${log.message} ${log.detail || ''}`.toLowerCase().includes(f.search.toLowerCase())) return;
      setLogs(prev => [...prev.slice(-999), log]);
    });
    return () => {
      socket.emit('leave-admin-logs');
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, paused]);

  const selectCls = 'field !h-8 !py-0 !px-2 !text-xs !w-auto';
  const selectedUser = facets?.users.find(u => u.userId === userId);

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-lg font-700 text-ink">AI service logs</h2>
          <span className={cx('chip !py-0.5 text-xs', connected ? '!border-success/40 !text-success' : '!border-danger/40 !text-danger')}>
            {connected ? 'live' : 'disconnected'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className={selectCls} value={userId} onChange={e => setUserId(e.target.value)}>
            <option value="">All users</option>
            {facets?.users.map(u => (
              <option key={u.userId ?? 'none'} value={u.userId ?? ''}>
                {u.email} · {num.format(u.totalTokens)} tok
              </option>
            ))}
          </select>
          <select className={selectCls} value={step} onChange={e => setStep(e.target.value)}>
            <option value="">All events</option>
            {facets?.steps.map(s => (
              <option key={s.step} value={s.step}>{STEP_LABELS[s.step] || s.step} ({s.events})</option>
            ))}
          </select>
          <select className={selectCls} value={tool} onChange={e => setTool(e.target.value)}>
            <option value="">All tools</option>
            {facets?.tools.map(t => (
              <option key={t.tool} value={t.tool}>{t.tool} ({t.calls})</option>
            ))}
          </select>
          <select className={selectCls} value={days} onChange={e => setDays(Number(e.target.value))}>
            <option value={1}>24 hours</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
          <input
            aria-label="Filter logs by chat or session ID"
            className="field !h-8 !py-0 !px-2 !text-xs w-64"
            placeholder="Chat / session ID (Enter)…"
            value={sessionInput}
            onChange={e => setSessionInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') setSessionId(sessionInput.trim()); }}
          />
          {sessionId && <button className="text-xs text-brass-bright" onClick={() => {
            setSessionId(''); setSessionInput('');
          }}>Clear chat filter</button>}
          <input
            className="field !h-8 !py-0 !px-2 !text-xs w-44"
            placeholder="Search logs (Enter)…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') setSearch(searchInput.trim()); }}
          />
          <button
            onClick={() => setPaused(p => !p)}
            className="flex h-8 items-center gap-1.5 rounded-md border border-hairline px-3 text-xs text-muted transition-colors hover:bg-elevated hover:text-ink"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={load} className="flex h-8 w-8 items-center justify-center rounded-md border border-hairline text-muted transition-colors hover:bg-elevated hover:text-ink" title="Refresh">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* What the current filter covers — the per-user readout when one is picked */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label={selectedUser ? 'Events (user)' : 'Events'} value={num.format(totals?.events ?? 0)} sub={`last ${days}d`} />
        <Stat label="Tokens" value={num.format(totals?.totalTokens ?? 0)} sub={`${num.format(totals?.inputTokens ?? 0)} in / ${num.format(totals?.outputTokens ?? 0)} out`} />
        <Stat label="Cost" value={money(totals?.costUsd ?? 0)} sub={selectedUser ? selectedUser.email : 'all users'} accent />
        <Stat
          label="Users active"
          value={String(facets?.users.filter(u => u.userId).length ?? 0)}
          sub="with agent activity"
        />
      </div>

      <div className={viewportTablePanelCls}>
        <div className="sticky top-0 z-10 hidden border-b border-hairline bg-panel px-6 py-3 font-mono text-[11px] font-medium uppercase tracking-wider text-faint lg:grid lg:grid-cols-[5.5rem_13rem_8.5rem_7rem_minmax(0,1fr)_7.5rem] lg:gap-4">
          <span>Time</span>
          <span>User</span>
          <span>Event</span>
          <span>Tool / model</span>
          <span>Message</span>
          <span className="text-right">Tokens / cost</span>
        </div>

        {!loading && logs.length === 0 && (
          <p className="px-6 py-12 text-center text-sm text-faint">
            No agent activity for these filters — log lines appear here as users run turns.
          </p>
        )}
        {logs.map(log => <AiLogRow key={log.id} log={log} />)}
        {loading && <div className="flex justify-center py-6"><Spinner /></div>}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Feedback

// A rating is two bits of signal — the thumb, and whether the user chose to
// explain it. Both are rendered plainly: notes are user prose, never markdown,
// so they are shown as text and never re-interpreted.
function RatingChip({ rating }: { rating: FeedbackRating }) {
  const up = rating === 'up';
  return (
    <span
      className={cx(
        'chip !py-0.5',
        up ? '!border-success/40 !text-success' : '!border-warn/40 !text-warn',
      )}
    >
      {up ? <ThumbsUp className="h-3 w-3" /> : <ThumbsDown className="h-3 w-3" />}
      {up ? 'Helpful' : 'Not helpful'}
    </span>
  );
}

function FeedbackTab({ onViewLogs }: { onViewLogs: (sessionId: string) => void }) {
  const navigate = useNavigate();
  const [data, setData] = useState<AdminFeedbackPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState<FeedbackRating | ''>('');
  const [userId, setUserId] = useState('');
  const [withNote, setWithNote] = useState(false);
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [days, setDays] = useState(30);
  const [limit, setLimit] = useState(100);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await adminGetFeedback({ rating, userId, q: query, withNote, days, limit }));
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load feedback'));
    } finally {
      setLoading(false);
    }
  }, [rating, userId, query, withNote, days, limit]);

  useEffect(() => { load(); }, [load]);

  const selectCls = 'field !h-8 !py-0 !px-2 !text-xs !w-auto';
  const summary = data?.summary;
  const satisfaction = summary?.satisfaction == null ? '—' : `${Math.round(summary.satisfaction * 100)}%`;

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-700 text-ink">Response feedback</h2>
          <p className="mt-0.5 text-xs text-muted">
            Every thumb left on an assistant response, across all users. Notes are optional, so most rows carry only a rating.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="field !h-8 !py-0 !px-2 !text-xs w-48"
            placeholder="Search notes, responses or IDs…"
            value={queryInput}
            onChange={e => setQueryInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') setQuery(queryInput.trim()); }}
          />
          <select className={selectCls} value={rating} onChange={e => setRating(e.target.value as FeedbackRating | '')}>
            <option value="">All ratings</option>
            <option value="up">Helpful</option>
            <option value="down">Not helpful</option>
          </select>
          <select className={selectCls} value={userId} onChange={e => setUserId(e.target.value)}>
            <option value="">All users</option>
            {(data?.users || []).map(u => (
              <option key={u.userId || 'none'} value={u.userId || ''}>
                {u.email} ({u.total})
              </option>
            ))}
          </select>
          <label className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-hairline px-2 text-xs text-muted transition-colors hover:text-ink">
            <input type="checkbox" className="accent-brass" checked={withNote} onChange={e => setWithNote(e.target.checked)} />
            With notes
          </label>
          <select className={selectCls} value={days} onChange={e => setDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>365 days</option>
          </select>
          <select className={selectCls} value={limit} onChange={e => setLimit(Number(e.target.value))}>
            <option value={100}>100 rows</option>
            <option value={200}>200 rows</option>
            <option value={500}>500 rows</option>
          </select>
          <button onClick={load} className="flex h-8 w-8 items-center justify-center rounded-md border border-hairline text-muted hover:bg-elevated hover:text-ink transition-colors" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && <div className="panel border-danger/40 p-3 text-sm text-danger">{error}</div>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Ratings" value={num.format(summary?.total || 0)} sub={`Last ${data?.windowDays ?? days} days`} />
        <Stat label="Helpful" value={num.format(summary?.up || 0)} />
        <Stat label="Not helpful" value={num.format(summary?.down || 0)} />
        <Stat label="Satisfaction" value={satisfaction} accent sub={`${num.format(summary?.withNotes || 0)} with a note`} />
      </div>

      <div className={viewportTablePanelCls}>
        <table className={cx(tableCls, 'xl:min-w-[76rem]')}>
          <colgroup className="hidden xl:table-column-group">
            <col className="w-[10%]" />
            <col className="w-[14%]" />
            <col className="w-[10%]" />
            <col className="w-[23%]" />
            <col className="w-[20%]" />
            <col className="w-[23%]" />
          </colgroup>
          <thead className="hidden xl:table-header-group">
            <tr>
              <th className={thCls}>Time</th>
              <th className={thCls}>User</th>
              <th className={thCls}>Rating</th>
              <th className={thCls}>Note</th>
              <th className={thCls}>Prompt</th>
              <th className={thCls}>Response</th>
            </tr>
          </thead>
          <tbody className="block xl:table-row-group">
            {(data?.entries || []).map(entry => (
              <tr key={entry.id} className={rowCls}>
                <ResponsiveCell label="Time" valueClassName="font-mono text-xs text-faint">{fmtDate(entry.createdAt)}</ResponsiveCell>
                <ResponsiveCell label="User" valueClassName="break-words text-xs text-muted">
                  {entry.userEmail}
                  {entry.userName && <span className="mt-0.5 block text-faint">{entry.userName}</span>}
                </ResponsiveCell>
                <ResponsiveCell label="Rating"><RatingChip rating={entry.rating} /></ResponsiveCell>
                <ResponsiveCell label="Note" valueClassName="text-xs">
                  {entry.note
                    ? <span className="whitespace-pre-wrap break-words text-ink">{entry.note}</span>
                    : <span className="text-faint">No note left</span>}
                </ResponsiveCell>
                <ResponsiveCell label="Prompt" valueClassName="break-words text-xs text-muted">
                  {entry.prompt || <span className="text-faint">—</span>}
                </ResponsiveCell>
                <ResponsiveCell label="Response" valueClassName="break-words text-xs text-muted">
                  {entry.response}
                  <div className="mt-2 break-all font-mono text-[11px] text-faint">Chat / session ID: {entry.sessionId}</div>
                  <div className="mt-1 break-all font-mono text-[11px] text-faint">Message ID: {entry.messageId}</div>
                  <button
                    onClick={() => navigate(`/chats/${entry.sessionId}`)}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-brass-bright transition-colors hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {entry.sessionName || 'Open thread'}
                  </button>
                  <button className="mt-1 block text-[11px] text-brass-bright hover:underline"
                    onClick={() => onViewLogs(entry.sessionId)}>View chat logs</button>
                </ResponsiveCell>
              </tr>
            ))}
            {!loading && (data?.entries.length || 0) === 0 && (
              <tr className="block xl:table-row">
                <td colSpan={6} className={emptyCellCls}>No feedback matches these filters</td>
              </tr>
            )}
          </tbody>
        </table>
        {loading && <div className="flex justify-center py-6"><Spinner /></div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Shell

export default function AdminPage({ currentUser }: AdminPageProps) {
  const [logSessionId, setLogSessionId] = useState('');
  const isAdmin = currentUser.role === 'admin';
  const [tab, setTab] = useState<Tab>(isAdmin ? 'overview' : 'security');
  const [days, setDays] = useState(30);

  const tabs: Array<{ id: Tab; label: string; icon: typeof Users; adminOnly: boolean }> = [
    { id: 'overview', label: 'Overview', icon: BarChart3, adminOnly: true },
    { id: 'users', label: 'Users', icon: Users, adminOnly: true },
    { id: 'feedback', label: 'Feedback', icon: MessageSquareQuote, adminOnly: true },
    { id: 'security', label: 'Security', icon: ShieldAlert, adminOnly: false },
    { id: 'audit', label: 'Audit logs', icon: ScrollText, adminOnly: false },
    { id: 'ailogs', label: 'AI logs', icon: Activity, adminOnly: false },
  ];

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-obsidian">
      <div className="mx-auto w-full max-w-[1600px] px-4 py-5 sm:px-6 sm:py-6 xl:px-8">
        <div className="mb-6 flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-hairline bg-panel p-1 no-scrollbar">
          {tabs.filter(t => isAdmin || !t.adminOnly).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${tab === t.id ? 'bg-elevated text-brass-bright border border-hairline shadow-console' : 'text-muted hover:text-ink'}`}
            >
              <t.icon className="w-4 h-4" /> {t.label}
            </button>
          ))}
        </div>

        {tab === 'overview' && isAdmin && <OverviewTab days={days} setDays={setDays} />}
        {tab === 'users' && isAdmin && <UsersTab currentUser={currentUser} />}
        {tab === 'feedback' && isAdmin && <FeedbackTab onViewLogs={sessionId => {
          setLogSessionId(sessionId); setTab('ailogs');
        }} />}
        {tab === 'security' && <SecurityTab days={days} />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'ailogs' && <AiLogsTab initialSessionId={logSessionId} />}
      </div>
    </div>
  );
}
