import { FormEvent, useEffect, useState } from 'react';
import { Check, ChevronDown, Copy, KeyRound, Loader2, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { ApiKey, ApiKeyStatus } from '../types';
import * as api from '../services/api';

const STATUS_STYLES: Record<ApiKeyStatus, { label: string; className: string; dot: string; hint?: string }> = {
  active: { label: 'Active', className: 'border-success/25 bg-success/10 text-success', dot: 'bg-success' },
  inactive: {
    label: 'Inactive',
    className: 'border-warn/25 bg-warn/10 text-warn',
    dot: 'bg-warn',
    hint: "The owner's access changed after this key was created, so it no longer works.",
  },
  expired: { label: 'Expired', className: 'border-hairline bg-elevated text-muted', dot: 'bg-faint' },
  revoked: { label: 'Revoked', className: 'border-danger/25 bg-danger/10 text-danger', dot: 'bg-danger' },
};

function formatDate(value: string | null, fallback = '—') {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : fallback;
}

function KeyStatusBadge({ status }: { status: ApiKeyStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span title={style.hint} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-600 ${style.className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} /> {style.label}
    </span>
  );
}

const thCls = 'px-4 py-3 text-left text-[11px] font-600 uppercase tracking-wide text-faint first:pl-6 last:pr-6';
const tdCls = 'px-4 py-3.5 align-top first:pl-6 last:pr-6';

export default function ApiKeysSettings() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [expiryOptions, setExpiryOptions] = useState<number[]>([30, 90, 180, 365]);
  const [isLoading, setIsLoading] = useState(true);
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getApiKeys()
      .then(data => {
        setKeys(data.keys);
        setExpiryOptions(data.expiryDays);
      })
      .catch(err => setError(api.apiErrorMessage(err, 'Could not load API keys')))
      .finally(() => setIsLoading(false));
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    setCopied(false);
    try {
      const result = await api.createApiKey({ name: name.trim(), expiresInDays });
      setNewSecret(result.secret);
      setName('');
      setKeys(current => [result.key, ...current]);
    } catch (err) {
      setError(api.apiErrorMessage(err, 'Could not create the API key'));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (key: ApiKey) => {
    if (!window.confirm(`Revoke "${key.name}"? Anything using this key loses access immediately.`)) return;
    setRevoking(key.id);
    setError(null);
    try {
      await api.revokeApiKey(key.id);
      setKeys(current => current.map((item): ApiKey => (
        item.id === key.id ? { ...item, status: 'revoked', revokedAt: new Date().toISOString() } : item
      )));
    } catch (err) {
      setError(api.apiErrorMessage(err, 'Could not revoke the API key'));
    } finally {
      setRevoking(null);
    }
  };

  const copySecret = async () => {
    if (!newSecret) return;
    try {
      await navigator.clipboard.writeText(newSecret);
      setCopied(true);
    } catch {
      setError('Copy failed. Select the key and copy it manually.');
    }
  };

  const activeCount = keys.filter(key => key.status === 'active').length;

  return (
    <section className="animate-fade-up">
      <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="eyebrow mb-2">Programmatic access</p>
          <h2 className="font-display text-2xl font-700 tracking-tight text-ink">API keys</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted">Call the Circini REST API from scripts and other systems. A key acts as the admin who created it and can reach everything that admin can.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted"><ShieldCheck className="h-4 w-4 text-success" /> Stored as one-way hashes</div>
      </div>

      {error && <div className="mb-5 rounded-lg border border-danger/25 bg-danger/10 px-3.5 py-3 text-sm text-danger">{error}</div>}

      {newSecret && (
        <div className="mb-5 rounded-xl border border-success/25 bg-success/[0.06] p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 font-600 text-success"><Check className="h-4 w-4" /> API key created</div>
              <p className="mt-1 text-sm text-muted">Copy it now. You won’t be able to see it again.</p>
            </div>
            <button onClick={() => setNewSecret(null)} className="rounded-lg p-1.5 text-faint hover:bg-elevated hover:text-ink" aria-label="Dismiss"><X className="h-4 w-4" /></button>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input readOnly value={newSecret} onFocus={event => event.currentTarget.select()} className="field font-mono text-xs" aria-label="New API key" />
            <button type="button" onClick={copySecret} className="btn-brass shrink-0">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy key'}
            </button>
          </div>
          <p className="mb-1.5 mt-4 text-xs font-600 text-ink">Send it as a bearer token</p>
          <pre className="overflow-x-auto rounded-lg border border-hairline bg-obsidian/60 p-3 font-mono text-[11px] text-muted">curl -H "Authorization: Bearer $CIRCINI_API_KEY" {window.location.origin}/api/sessions</pre>
        </div>
      )}

      <form onSubmit={create} className="panel mb-5 p-5 sm:p-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brass/10 text-brass"><KeyRound className="h-5 w-5" /></div>
          <div><h3 className="font-600 text-ink">Create a key</h3><p className="text-xs text-faint">Name it after the script or system that will use it</p></div>
        </div>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:items-end">
          <div>
            <label htmlFor="api-key-name" className="mb-1.5 block text-xs font-600 text-ink">Name</label>
            <input id="api-key-name" className="field" required maxLength={80} placeholder="Nightly migration job" value={name} onChange={event => setName(event.target.value)} />
          </div>
          <div>
            <label htmlFor="api-key-expiry" className="mb-1.5 block text-xs font-600 text-ink">Expires after</label>
            <div className="relative">
              <select id="api-key-expiry" className="field" value={expiresInDays} onChange={event => setExpiresInDays(Number(event.target.value))}>
                {expiryOptions.map(days => <option key={days} value={days}>{days} days</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            </div>
          </div>
          <button type="submit" disabled={creating || !name.trim()} className="btn-brass">
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create key
          </button>
        </div>
      </form>

      <div className="panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-4 sm:px-6">
          <h3 className="font-600 text-ink">Keys</h3>
          <span className="font-mono text-[11px] text-faint">{activeCount} active</span>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 px-6 py-10 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading keys…</div>
        ) : keys.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-faint">No API keys yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-hairline">
                  <th className={thCls}>Name</th>
                  <th className={thCls}>Created by</th>
                  <th className={thCls}>Created</th>
                  <th className={thCls}>Last used</th>
                  <th className={thCls}>Expires</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {keys.map(key => (
                  <tr key={key.id} className="border-b border-hairline/60 last:border-0">
                    <td className={tdCls}>
                      <div className="font-500 text-ink">{key.name}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-faint">{key.prefix}…</div>
                    </td>
                    <td className={`${tdCls} text-muted`}><div className="max-w-[13rem] truncate" title={key.owner.email}>{key.owner.email}</div></td>
                    <td className={`${tdCls} whitespace-nowrap text-muted`}>{formatDate(key.createdAt)}</td>
                    <td className={`${tdCls} whitespace-nowrap text-muted`}>{formatDate(key.lastUsedAt, 'Never')}</td>
                    <td className={`${tdCls} whitespace-nowrap text-muted`}>{formatDate(key.expiresAt)}</td>
                    <td className={tdCls}><KeyStatusBadge status={key.status} /></td>
                    <td className={`${tdCls} text-right`}>
                      {key.status !== 'revoked' && (
                        <button onClick={() => revoke(key)} disabled={revoking === key.id} className="btn-ghost btn-sm">
                          {revoking === key.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
