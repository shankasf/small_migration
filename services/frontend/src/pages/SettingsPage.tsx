import { FormEvent, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Check,
  ChevronRight,
  Database,
  ExternalLink,
  KeyRound,
  Loader2,
  PlugZap,
  Settings2,
  ShieldCheck,
  Unplug,
  UserRound,
  X,
} from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle';
import GitHubRepositories from '../components/GitHubRepositories';
import { Integration, IntegrationProvider, User } from '../types';
import * as api from '../services/api';
import { INTEGRATION_PROVIDERS } from '../integrationCatalog';

type Tab = 'account' | 'integrations';

interface SettingsPageProps {
  currentUser: User;
  integrations: Integration[];
  isLoading: boolean;
  onRefresh: () => Promise<void>;
}

const emptySnowflake = {
  account: '',
  username: '',
  privateKey: '',
  privateKeyPass: '',
  warehouse: '',
  database: '',
  role: '',
};

const emptyDbt = { accountId: '', token: '', host: 'cloud.getdbt.com' };

function relativeDate(value: string | null) {
  if (!value) return 'Not verified';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function ConnectionBadge({ connected }: { connected: boolean }) {
  return connected ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2.5 py-1 text-[11px] font-600 text-success">
      <span className="h-1.5 w-1.5 rounded-full bg-success" /> Connected
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-elevated px-2.5 py-1 text-[11px] font-500 text-muted">
      <span className="h-1.5 w-1.5 rounded-full bg-faint" /> Not connected
    </span>
  );
}

function FieldLabel({ children, optional = false }: { children: React.ReactNode; optional?: boolean }) {
  return (
    <label className="mb-1.5 block text-xs font-600 text-ink">
      {children}{optional && <span className="ml-1 font-400 text-faint">Optional</span>}
    </label>
  );
}

export default function SettingsPage({ currentUser, integrations, isLoading, onRefresh }: SettingsPageProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const tab: Tab = requestedTab === 'integrations' ? 'integrations' : 'account';
  const requestedProvider = searchParams.get('connect') as IntegrationProvider | null;
  const selectedProvider = INTEGRATION_PROVIDERS.some(item => item.id === requestedProvider) ? requestedProvider : null;
  const [busy, setBusy] = useState<IntegrationProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [snowflakeForm, setSnowflakeForm] = useState(emptySnowflake);
  const [dbtForm, setDbtForm] = useState(emptyDbt);

  const byProvider = useMemo(
    () => new Map(integrations.map(integration => [integration.provider, integration])),
    [integrations]
  );

  const callbackResult = searchParams.get('result');
  const callbackProvider = searchParams.get('provider');
  const callbackNotice = callbackResult === 'connected'
    ? `${callbackProvider === 'gitlab' ? 'GitLab' : 'GitHub'} connected successfully.`
    : null;
  const callbackError = callbackResult === 'expired'
    ? 'The authorization request expired. Please try connecting again.'
    : callbackResult === 'error'
      ? 'The provider could not be connected. Please try again.'
      : null;
  const displayError = error || callbackError;

  const chooseTab = (next: Tab) => {
    setError(null);
    setSearchParams(next === 'integrations' ? { tab: 'integrations' } : {});
  };

  const closePanel = () => {
    setError(null);
    setSnowflakeForm(emptySnowflake);
    setDbtForm(emptyDbt);
    setSearchParams({ tab: 'integrations' }, { replace: true });
  };

  const connectOAuth = async (provider: 'github' | 'gitlab') => {
    setBusy(provider);
    setError(null);
    try {
      const { authorizeUrl } = await api.connectOAuthIntegration(provider);
      window.location.assign(authorizeUrl);
    } catch (err) {
      setError(api.apiErrorMessage(err));
      setBusy(null);
    }
  };

  const connectSnowflake = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('snowflake');
    setError(null);
    try {
      await api.connectSnowflake(snowflakeForm);
      await onRefresh();
      setNotice('Snowflake connection verified and saved.');
      closePanel();
    } catch (err) {
      setError(api.apiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const connectDbt = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('dbt');
    setError(null);
    try {
      await api.connectDbt(dbtForm);
      await onRefresh();
      setNotice('dbt connection verified and saved.');
      closePanel();
    } catch (err) {
      setError(api.apiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (provider: IntegrationProvider) => {
    const info = INTEGRATION_PROVIDERS.find(item => item.id === provider)!;
    if (!window.confirm(`Disconnect ${info.name}? Circini will no longer be able to access it.`)) return;
    setBusy(provider);
    setError(null);
    try {
      await api.disconnectIntegration(provider);
      await onRefresh();
      setNotice(`${info.name} disconnected.`);
      closePanel();
    } catch (err) {
      setError(api.apiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const selectedInfo = INTEGRATION_PROVIDERS.find(item => item.id === selectedProvider);
  const selectedConnection = selectedProvider ? byProvider.get(selectedProvider) : undefined;

  return (
    <div className="flex min-h-0 flex-1 bg-obsidian">
      <aside className="hidden w-60 shrink-0 border-r border-hairline bg-panel/55 p-4 md:block">
        <div className="px-2 pb-5 pt-2">
          <p className="eyebrow mb-2">Workspace</p>
          <h1 className="font-display text-xl font-700 tracking-tight text-ink">Settings</h1>
        </div>
        <nav className="space-y-1" aria-label="Settings sections">
          <button onClick={() => chooseTab('account')} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${tab === 'account' ? 'border border-hairline bg-elevated text-ink' : 'border border-transparent text-muted hover:bg-elevated/60 hover:text-ink'}`}>
            <UserRound className="h-4 w-4" /> Account
          </button>
          <button onClick={() => chooseTab('integrations')} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${tab === 'integrations' ? 'border border-hairline bg-elevated text-ink' : 'border border-transparent text-muted hover:bg-elevated/60 hover:text-ink'}`}>
            <PlugZap className="h-4 w-4" /> Integrations
            <span className="ml-auto font-mono text-[10px] text-faint">{integrations.filter(item => item.status === 'connected').length}</span>
          </button>
        </nav>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-7 sm:px-7 lg:px-10 lg:py-10">
          <div className="mb-6 flex gap-2 md:hidden">
            <button onClick={() => chooseTab('account')} className={tab === 'account' ? 'btn-subtle btn-sm' : 'btn-ghost btn-sm'}>Account</button>
            <button onClick={() => chooseTab('integrations')} className={tab === 'integrations' ? 'btn-subtle btn-sm' : 'btn-ghost btn-sm'}>Integrations</button>
          </div>

          {(notice || callbackNotice) && (
            <div className="mb-6 flex items-center justify-between rounded-xl border border-success/25 bg-success/10 px-4 py-3 text-sm text-success">
              <span className="flex items-center gap-2"><Check className="h-4 w-4" />{notice || callbackNotice}</span>
              <button onClick={() => { setNotice(null); setSearchParams({ tab }, { replace: true }); }} className="rounded p-1 hover:bg-success/10" aria-label="Dismiss"><X className="h-4 w-4" /></button>
            </div>
          )}

          {tab === 'account' ? (
            <section className="animate-fade-up">
              <div className="mb-8">
                <p className="eyebrow mb-2">Personal settings</p>
                <h2 className="font-display text-2xl font-700 tracking-tight text-ink">Account</h2>
                <p className="mt-2 max-w-2xl text-sm text-muted">Manage your profile, workspace access, and display preferences.</p>
              </div>
              <div className="grid gap-5 lg:grid-cols-2">
                <div className="panel p-5 sm:p-6">
                  <div className="mb-5 flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brass/10 text-brass"><UserRound className="h-5 w-5" /></div>
                    <div><h3 className="font-600 text-ink">Profile</h3><p className="text-xs text-faint">Managed by your identity provider</p></div>
                  </div>
                  <dl className="space-y-4 text-sm">
                    <div><dt className="mb-1 text-xs text-faint">Name</dt><dd className="text-ink">{currentUser.name || 'Not provided'}</dd></div>
                    <div><dt className="mb-1 text-xs text-faint">Email</dt><dd className="break-all text-ink">{currentUser.email}</dd></div>
                    <div><dt className="mb-1 text-xs text-faint">Workspace role</dt><dd><span className="chip uppercase tracking-wide">{currentUser.role}</span></dd></div>
                  </dl>
                </div>
                <div className="panel p-5 sm:p-6">
                  <div className="mb-5 flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-elevated text-muted"><Settings2 className="h-5 w-5" /></div>
                    <div><h3 className="font-600 text-ink">Appearance</h3><p className="text-xs text-faint">Choose how Circini looks</p></div>
                  </div>
                  <ThemeToggle variant="pill" />
                </div>
              </div>
            </section>
          ) : (
            <section className="animate-fade-up">
              <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
                <div>
                  <p className="eyebrow mb-2">Connected systems</p>
                  <h2 className="font-display text-2xl font-700 tracking-tight text-ink">Integrations</h2>
                  <p className="mt-2 max-w-2xl text-sm text-muted">Connect the tools that hold your transformation code, metadata, and warehouse schemas.</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted"><ShieldCheck className="h-4 w-4 text-success" /> Credentials encrypted at rest</div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                {INTEGRATION_PROVIDERS.map(info => {
                  const connection = byProvider.get(info.id);
                  const connected = connection?.status === 'connected';
                  const Icon = info.icon;
                  return (
                    <article key={info.id} className="panel card-hover flex min-h-[210px] flex-col p-5 sm:p-6">
                      <div className="mb-5 flex items-start justify-between gap-4">
                        <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${info.surface} ${info.accent}`}><Icon className="h-5 w-5" /></div>
                        <ConnectionBadge connected={connected} />
                      </div>
                      <p className="eyebrow mb-1.5">{info.category}</p>
                      <h3 className="font-display text-lg font-700 text-ink">{info.name}</h3>
                      <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{info.description}</p>
                      {connected && connection?.displayName && <p className="mt-3 truncate font-mono text-[11px] text-success">{connection.displayName}</p>}
                      <div className="mt-5 flex items-center justify-between gap-3 border-t border-hairline pt-4">
                        <span className="text-[11px] text-faint">{info.permission}</span>
                        <button
                          onClick={() => { setError(null); setSearchParams({ tab: 'integrations', connect: info.id }); }}
                          className={connected ? 'btn-ghost btn-sm' : 'btn-brass btn-sm'}
                        >
                          {connected ? 'Manage' : 'Connect'} <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>

              {isLoading && <div className="mt-5 flex items-center justify-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Checking connections…</div>}
            </section>
          )}
        </div>
      </main>

      {selectedProvider && selectedInfo && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="integration-title">
          <button className="absolute inset-0 bg-obsidian/75 backdrop-blur-sm" onClick={closePanel} aria-label="Close integration dialog" />
          <div className="relative max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-hairline bg-panel p-5 shadow-console animate-fade-up sm:max-w-xl sm:rounded-2xl sm:p-7">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${selectedInfo.surface} ${selectedInfo.accent}`}><selectedInfo.icon className="h-5 w-5" /></div>
                <div><p className="eyebrow mb-1">{selectedConnection?.status === 'connected' ? 'Manage connection' : 'Connect service'}</p><h3 id="integration-title" className="font-display text-xl font-700 text-ink">{selectedInfo.name}</h3></div>
              </div>
              <button onClick={closePanel} className="rounded-lg p-2 text-faint hover:bg-elevated hover:text-ink" aria-label="Close"><X className="h-5 w-5" /></button>
            </div>

            {displayError && <div className="mb-5 rounded-lg border border-danger/25 bg-danger/10 px-3.5 py-3 text-sm text-danger">{displayError}</div>}
            {!selectedConnection?.configured && selectedConnection?.status !== 'connected' && (
              <div className="mb-5 rounded-lg border border-warn/25 bg-warn/10 px-3.5 py-3 text-sm text-warn">
                {selectedProvider === 'github' ? 'GitHub connection setup is not complete yet. This affects all accounts; your administrator role does not need changing.' : `An administrator must finish the secure ${selectedInfo.name} application setup before users can connect.`}
              </div>
            )}

            {selectedConnection?.status === 'connected' ? (
              <div>
                <div className="rounded-xl border border-success/20 bg-success/[0.06] p-4">
                  <div className="flex items-center gap-2 font-600 text-success"><Check className="h-4 w-4" /> Connection verified</div>
                  <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                    <div><dt className="text-xs text-faint">Connected account</dt><dd className="mt-1 break-all text-ink">{selectedConnection.displayName || selectedInfo.name}</dd></div>
                    <div><dt className="text-xs text-faint">Last verified</dt><dd className="mt-1 text-ink">{relativeDate(selectedConnection.lastVerifiedAt)}</dd></div>
                  </dl>
                </div>
                {selectedProvider === 'github' && <GitHubRepositories onSaved={onRefresh} onReconnect={() => connectOAuth('github')} />}
                <div className="mt-6 flex justify-end">
                  <button onClick={() => disconnect(selectedProvider)} disabled={busy === selectedProvider} className="btn-danger">
                    {busy === selectedProvider ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />} Disconnect
                  </button>
                </div>
              </div>
            ) : selectedProvider === 'github' || selectedProvider === 'gitlab' ? (
              <div>
                <p className="text-sm leading-relaxed text-muted">You’ll continue to {selectedInfo.name} to approve repository access, then return here automatically. Circini never asks for your password.</p>
                <div className="mt-5 rounded-xl border border-hairline bg-elevated/55 p-4 text-sm">
                  <div className="flex items-center gap-2 font-600 text-ink"><ShieldCheck className="h-4 w-4 text-success" /> Secure OAuth authorization</div>
                  <p className="mt-2 text-xs leading-relaxed text-muted">Access is tied to your account and can be disconnected at any time. Organization approval may be required.</p>
                </div>
                <div className="mt-6 flex justify-end gap-3">
                  <button onClick={closePanel} className="btn-ghost">Cancel</button>
                  <button onClick={() => connectOAuth(selectedProvider)} disabled={busy === selectedProvider || !byProvider.get(selectedProvider)?.configured} className="btn-brass">
                    {busy === selectedProvider ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />} Continue to {selectedInfo.name}
                  </button>
                </div>
              </div>
            ) : selectedProvider === 'snowflake' ? (
              <form onSubmit={connectSnowflake}>
                <p className="mb-5 text-sm leading-relaxed text-muted">Use a dedicated read-only service user and encrypted PKCS#8 private key. Circini verifies the connection before marking it connected.</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div><FieldLabel>Account identifier</FieldLabel><input className="field" required placeholder="org-account" value={snowflakeForm.account} onChange={e => setSnowflakeForm({ ...snowflakeForm, account: e.target.value })} /></div>
                  <div><FieldLabel>Username</FieldLabel><input className="field" required autoComplete="username" placeholder="CIRCINI_SERVICE" value={snowflakeForm.username} onChange={e => setSnowflakeForm({ ...snowflakeForm, username: e.target.value })} /></div>
                  <div><FieldLabel optional>Warehouse</FieldLabel><input className="field" placeholder="TRANSFORMING_WH" value={snowflakeForm.warehouse} onChange={e => setSnowflakeForm({ ...snowflakeForm, warehouse: e.target.value })} /></div>
                  <div><FieldLabel optional>Role</FieldLabel><input className="field" placeholder="CIRCINI_READONLY" value={snowflakeForm.role} onChange={e => setSnowflakeForm({ ...snowflakeForm, role: e.target.value })} /></div>
                  <div className="sm:col-span-2"><FieldLabel optional>Database</FieldLabel><input className="field" placeholder="ANALYTICS" value={snowflakeForm.database} onChange={e => setSnowflakeForm({ ...snowflakeForm, database: e.target.value })} /></div>
                  <div className="sm:col-span-2"><FieldLabel>Private key</FieldLabel><textarea className="field min-h-32 font-mono text-xs" required spellCheck={false} placeholder="-----BEGIN PRIVATE KEY-----" value={snowflakeForm.privateKey} onChange={e => setSnowflakeForm({ ...snowflakeForm, privateKey: e.target.value })} /></div>
                  <div className="sm:col-span-2"><FieldLabel optional>Private-key passphrase</FieldLabel><div className="relative"><KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" /><input type="password" autoComplete="new-password" className="field pl-10" value={snowflakeForm.privateKeyPass} onChange={e => setSnowflakeForm({ ...snowflakeForm, privateKeyPass: e.target.value })} /></div></div>
                </div>
                <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={closePanel} className="btn-ghost">Cancel</button><button type="submit" disabled={busy === 'snowflake' || !selectedConnection?.configured} className="btn-brass">{busy === 'snowflake' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />} Verify & connect</button></div>
              </form>
            ) : (
              <form onSubmit={connectDbt}>
                <p className="mb-5 text-sm leading-relaxed text-muted">Use a service token with the smallest permission set required for metadata and job access.</p>
                <div className="space-y-4">
                  <div><FieldLabel>Account ID</FieldLabel><input className="field" required inputMode="numeric" placeholder="12345" value={dbtForm.accountId} onChange={e => setDbtForm({ ...dbtForm, accountId: e.target.value })} /></div>
                  <div><FieldLabel>dbt Cloud host</FieldLabel><input className="field" required readOnly value={dbtForm.host} /></div>
                  <div><FieldLabel>Service token</FieldLabel><div className="relative"><KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" /><input type="password" autoComplete="new-password" className="field pl-10" required placeholder="dbtc_••••••••" value={dbtForm.token} onChange={e => setDbtForm({ ...dbtForm, token: e.target.value })} /></div></div>
                </div>
                <div className="mt-5 flex items-start gap-2 rounded-lg border border-hairline bg-elevated/50 p-3 text-xs leading-relaxed text-muted"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />The token is sent over TLS, encrypted before storage, and never returned to the browser.</div>
                <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={closePanel} className="btn-ghost">Cancel</button><button type="submit" disabled={busy === 'dbt' || !selectedConnection?.configured} className="btn-brass">{busy === 'dbt' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} Verify & connect</button></div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
