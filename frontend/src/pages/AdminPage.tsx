import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Users, BarChart3, ShieldAlert, RefreshCw, UserPlus, Ban, ShieldCheck, AlertTriangle,
} from 'lucide-react';
import {
  adminGetUsers, adminGetUsageSummary, adminGetAudit, adminGetSecuritySummary,
  adminCreateUser, adminUpdateUser, apiErrorMessage,
} from '../services/api';
import { AdminUser, AuditEvent, SecuritySummary, UsageSummary, User } from '../types';
import { Button, CenterSpinner, Field, Modal, Stat, StatusChip, Spinner, cx } from '../components/ui';

const num = new Intl.NumberFormat('en-NZ');
const money = (v: number) => `$${v.toFixed(v >= 100 ? 0 : v >= 1 ? 2 : 4)}`;
const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-NZ', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});

type Tab = 'overview' | 'users' | 'security';

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

const thCls = 'px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider text-faint font-medium text-left';
const tdCls = 'px-4 py-2.5';

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
        <div className="panel overflow-hidden">
          <div className="eyebrow px-5 pt-4 pb-2">Top users (this month)</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline">
                <th className={cx(thCls, 'pl-5')}>User</th>
                <th className={cx(thCls, 'text-right')}>Tokens</th>
                <th className={cx(thCls, 'text-right')}>Cost</th>
                <th className={cx(thCls, 'text-right', 'pr-5')}>Sessions</th>
              </tr>
            </thead>
            <tbody>
              {topUsers.map(u => (
                <tr key={u.id} className="border-b border-hairline/50 last:border-0">
                  <td className={cx(tdCls, 'pl-5 text-ink')}>{u.email}</td>
                  <td className={cx(tdCls, 'text-right font-mono tabular-nums text-muted')}>{num.format(u.usage.monthTokens)}</td>
                  <td className={cx(tdCls, 'text-right font-mono tabular-nums text-muted')}>{money(u.usage.monthCostUsd)}</td>
                  <td className={cx(tdCls, 'text-right font-mono tabular-nums text-muted pr-5')}>{u.usage.sessions}</td>
                </tr>
              ))}
              {topUsers.length === 0 && (
                <tr><td colSpan={4} className="px-5 py-6 text-center text-faint">No users yet</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="panel overflow-hidden">
          <div className="eyebrow px-5 pt-4 pb-2">By model</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline">
                <th className={cx(thCls, 'pl-5')}>Model</th>
                <th className={thCls}>Provider</th>
                <th className={cx(thCls, 'text-right')}>Tokens</th>
                <th className={cx(thCls, 'text-right', 'pr-5')}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map(m => (
                <tr key={`${m.provider}/${m.model}`} className="border-b border-hairline/50 last:border-0">
                  <td className={cx(tdCls, 'pl-5 font-mono text-xs text-brass-bright')}>{m.model}</td>
                  <td className={cx(tdCls, 'text-muted')}>{m.provider}</td>
                  <td className={cx(tdCls, 'text-right font-mono tabular-nums text-muted')}>{num.format(m.totalTokens)}</td>
                  <td className={cx(tdCls, 'text-right font-mono tabular-nums text-muted pr-5')}>{money(m.costUsd)}</td>
                </tr>
              ))}
              {summary.byModel.length === 0 && (
                <tr><td colSpan={4} className="px-5 py-6 text-center text-faint">No usage in this window</td></tr>
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

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm min-w-[820px]">
          <thead>
            <tr className="border-b border-hairline">
              <th className={cx(thCls, 'pl-5')}>User</th>
              <th className={thCls}>Role</th>
              <th className={thCls}>Status</th>
              <th className={cx(thCls, 'text-right')}>Month tokens</th>
              <th className={cx(thCls, 'text-right')}>Month cost</th>
              <th className={cx(thCls, 'text-right')}>Caps (d/m)</th>
              <th className={thCls}>Last login</th>
              <th className={cx(thCls, 'text-right', 'pr-5')}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className="border-b border-hairline/50 last:border-0 hover:bg-elevated/40 transition-colors">
                <td className={cx(tdCls, 'pl-5')}>
                  <div className="text-ink">{u.email}</div>
                  {u.name && <div className="text-xs text-faint">{u.name}</div>}
                </td>
                <td className={tdCls}><StatusChip value={u.role} /></td>
                <td className={tdCls}><StatusChip value={u.status} /></td>
                <td className={cx(tdCls, 'text-right font-mono tabular-nums text-muted')}>{num.format(u.usage.monthTokens)}</td>
                <td className={cx(tdCls, 'text-right font-mono tabular-nums text-muted')}>{money(u.usage.monthCostUsd)}</td>
                <td className={cx(tdCls, 'text-right font-mono tabular-nums text-xs text-faint')}>
                  {u.dailyTokenLimit ? num.format(u.dailyTokenLimit) : '∞'} / {u.monthlyTokenLimit ? num.format(u.monthlyTokenLimit) : '∞'}
                </td>
                <td className={cx(tdCls, 'text-xs text-faint')}>{u.lastLoginAt ? fmtDate(u.lastLoginAt) : 'never'}</td>
                <td className={cx(tdCls, 'pr-5')}>
                  <div className="flex justify-end items-center gap-1.5">
                    <Button variant="ghost" sm onClick={() => setEditing(u)}>Edit</Button>
                    {u.id !== currentUser.id && (u.status === 'active' ? (
                      <button onClick={() => quickSetStatus(u, 'disabled')} title="Disable user" className="p-1.5 rounded-lg text-danger hover:bg-danger/10 transition-colors"><Ban className="w-4 h-4" /></button>
                    ) : (
                      <button onClick={() => quickSetStatus(u, 'active')} title="Re-enable user" className="p-1.5 rounded-lg text-success hover:bg-success/10 transition-colors"><ShieldCheck className="w-4 h-4" /></button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
            {!loading && users.length === 0 && (
              <tr><td colSpan={8} className="px-5 py-8 text-center text-faint">No users</td></tr>
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

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="border-b border-hairline">
              <th className={cx(thCls, 'pl-5')}>Time</th>
              <th className={thCls}>User</th>
              <th className={thCls}>Action</th>
              <th className={thCls}>Decision</th>
              <th className={thCls}>Severity</th>
              <th className={cx(thCls, 'pr-5')}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(e => (
              <tr key={e.id} className="border-b border-hairline/50 last:border-0 hover:bg-elevated/40 align-top transition-colors">
                <td className={cx(tdCls, 'pl-5 font-mono text-xs text-faint whitespace-nowrap')}>{fmtDate(e.createdAt)}</td>
                <td className={cx(tdCls, 'text-xs text-muted')}>{e.user?.email || '—'}</td>
                <td className={cx(tdCls, 'font-mono text-xs text-ink')}>{e.action}</td>
                <td className={tdCls}><StatusChip value={e.decision} /></td>
                <td className={tdCls}><StatusChip value={e.severity} /></td>
                <td className={cx(tdCls, 'pr-5 text-xs text-muted max-w-xs truncate')} title={e.detail || ''}>{e.detail || '—'}</td>
              </tr>
            ))}
            {!loading && shown.length === 0 && (
              <tr><td colSpan={6} className="px-5 py-8 text-center text-faint">No events</td></tr>
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
  const isAdmin = currentUser.role === 'admin';
  const [tab, setTab] = useState<Tab>(isAdmin ? 'overview' : 'security');
  const [days, setDays] = useState(30);

  const tabs: Array<{ id: Tab; label: string; icon: typeof Users; adminOnly: boolean }> = [
    { id: 'overview', label: 'Overview', icon: BarChart3, adminOnly: true },
    { id: 'users', label: 'Users', icon: Users, adminOnly: true },
    { id: 'security', label: 'Security', icon: ShieldAlert, adminOnly: false },
  ];

  return (
    <div className="flex-1 overflow-y-auto bg-obsidian">
      <div className="max-w-6xl mx-auto px-4 py-5 sm:px-6 sm:py-6">
        <div className="flex items-center gap-1 mb-6 rounded-xl border border-hairline bg-panel p-1 w-fit max-w-full overflow-x-auto no-scrollbar">
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
        {tab === 'security' && <SecurityTab days={days} />}
      </div>
    </div>
  );
}
