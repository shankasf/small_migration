import { useEffect, useState } from 'react';
import { ExternalLink, GitBranch, Loader2, RefreshCw } from 'lucide-react';
import * as api from '../services/api';

export default function GitHubRepositories({ onSaved, onReconnect }: { onSaved: () => Promise<void>; onReconnect: () => void }) {
  const [repositories, setRepositories] = useState<api.GitHubRepository[]>([]);
  const [installUrl, setInstallUrl] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [branch, setBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [saved, setSaved] = useState<api.GitHubSelection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let active = true;
    api.getGitHubRepositories().then(data => {
      if (!active) return;
      setRepositories(data.repositories);
      setInstallUrl(data.installUrl);
      setSaved(data.selectedRepository);
      setTruncated(data.truncated);
      const selected = data.repositories.find(repo => repo.id === data.selectedRepository?.id);
      setRepositoryId(selected ? String(selected.id) : '');
    }).catch(err => { if (active) setError(api.apiErrorMessage(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  const repository = repositories.find(item => String(item.id) === repositoryId);
  useEffect(() => {
    if (!repository) return;
    let active = true;
    api.getGitHubBranches(repository.installationId, repository.id).then(data => {
      if (!active) return;
      setBranches(data.branches);
      setBranch(saved?.id === repository.id && data.branches.includes(saved.branch) ? saved.branch : data.defaultBranch);
    }).catch(err => { if (active) setError(api.apiErrorMessage(err)); })
      .finally(() => { if (active) setLoadingBranches(false); });
    return () => { active = false; };
  }, [repository, saved]);

  const save = async () => {
    if (!repository || !branch) return;
    setSaving(true); setError('');
    try {
      await api.selectGitHubRepository(repository.installationId, repository.id, branch);
      setSaved({ ...repository, branch });
      await onSaved();
    } catch (err) { setError(api.apiErrorMessage(err)); }
    finally { setSaving(false); }
  };

  return <section className="mt-5 space-y-4" aria-label="GitHub repository access">
    <div className="flex items-center justify-between gap-3">
      <h4 className="flex items-center gap-2 text-sm font-600"><GitBranch className="h-4 w-4" /> Repository access</h4>
      <button className="btn-ghost btn-sm" disabled={loading} onClick={() => { setLoading(true); setError(''); setRevision(value => value + 1); }}>
        <RefreshCw className="h-3.5 w-3.5" /> Refresh
      </button>
    </div>
    {error && <div role="alert" className="rounded-lg border border-danger/25 p-3 text-sm text-danger">{error}
      <button className="mt-2 block underline" onClick={onReconnect}>Reconnect GitHub</button>
    </div>}
    {loading ? <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Checking your repository access…</p>
      : repositories.length ? <>
        <label className="block text-xs font-600">Repository
          <select className="field mt-1.5" value={repositoryId} onChange={event => {
            setRepositoryId(event.target.value); setBranch(''); setBranches([]); setLoadingBranches(Boolean(event.target.value)); setError('');
          }}>
            <option value="">Choose a repository</option>
            {repositories.map(repo => <option key={`${repo.installationId}-${repo.id}`} value={repo.id}>{repo.fullName}{repo.private ? ' (private)' : ''}</option>)}
          </select>
        </label>
        {repository && <label className="block text-xs font-600">Branch
          <select className="field mt-1.5" value={branch} disabled={loadingBranches} onChange={event => setBranch(event.target.value)}>
            <option value="">{loadingBranches ? 'Loading branches…' : 'Choose a branch'}</option>
            {branches.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>}
        <button className="btn-brass w-full" onClick={save} disabled={!repository || !branch || saving || loadingBranches}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save repository
        </button>
        {saved && repositories.some(repo => repo.id === saved.id) && <p role="status" className="break-words text-xs text-success">Saved: {saved.fullName} · {saved.branch}</p>}
        {truncated && <p className="text-xs text-muted">Showing the first 1,000 repositories per installation.</p>}
      </> : !error && <p className="text-sm leading-relaxed text-muted">Your GitHub account is authorized. Choose which repositories Circini can read to finish setup. Your organization may require an owner’s approval.</p>}
    {installUrl && <a className="btn-ghost w-full" href={installUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" /> Choose repositories on GitHub</a>}
    <p className="text-xs leading-relaxed text-faint">Only repositories you can access and have granted to Circini appear here. Access is read-only. After changing access on GitHub, return here and refresh.</p>
  </section>;
}
