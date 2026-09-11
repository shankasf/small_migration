import axios from 'axios';
import type { PrismaClient } from '@prisma/client';
import { accessibleRepository, githubHeaders, githubInstallations, githubUserToken } from './githubApp.js';

export class GitHubReadError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const integer = (value: unknown, fallback: number, maximum: number) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) throw new GitHubReadError(400, 'Invalid pagination value.');
  return Number(value);
};
function safeSelection(metadata: unknown) {
  const selected = object(object(metadata).selectedRepository);
  if (!positive(selected.id) || !positive(selected.installationId) || typeof selected.fullName !== 'string' || typeof selected.branch !== 'string') return null;
  return { id: selected.id as number, installationId: selected.installationId as number, fullName: selected.fullName as string, branch: selected.branch as string };
}
export async function githubChatContext(prisma: PrismaClient, userId: string) {
  const row = await prisma.integration.findUnique({ where: { userId_provider: { userId, provider: 'github' } }, select: { status: true, metadata: true } });
  return { status: row?.status === 'connected' ? 'connected' : 'not_connected', selectedRepository: row?.status === 'connected' ? safeSelection(row.metadata) : null };
}
async function readJson(path: string, token: string) {
  return (await axios.get(`https://api.github.com${path}`, { headers: githubHeaders(token), timeout: 15000,
    maxRedirects: 0, maxContentLength: 8 * 1024 * 1024 })).data;
}
function refValue(value: unknown, fallback: string) {
  const ref = value === undefined || value === '' ? fallback : value;
  if (typeof ref !== 'string' || !ref || ref.length > 255 || /[\x00-\x1f\x7f]/.test(ref)) throw new GitHubReadError(400, 'Invalid GitHub branch or commit.');
  return ref;
}
function pathValue(value: unknown) {
  const path = value ?? '';
  if (typeof path !== 'string' || path.length > 1024 || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)
    || path.split('/').some(part => part === '.' || part === '..')) throw new GitHubReadError(400, 'Use a relative repository path without parent traversal.');
  return path;
}

/** Read-only repository operations. Credentials never appear in return values. */
export async function readGitHub(prisma: PrismaClient, userId: string, operation: string, args: Record<string, unknown>) {
  if (!['status', 'repositories', 'tree', 'file'].includes(operation)) throw new GitHubReadError(400, 'Unsupported GitHub read operation.');
  const context = await githubChatContext(prisma, userId);
  if (context.status !== 'connected') {
    if (operation === 'status') return { ...context, message: 'Connect GitHub in Settings → Integrations to read repositories.' };
    throw new GitHubReadError(409, 'GitHub is not connected. Connect it in Settings → Integrations.');
  }
  const token = await githubUserToken(prisma, userId);
  if (operation === 'status') {
    const installations = await githubInstallations(token);
    let selectedCommitSha: string | null = null;
    if (context.selectedRepository) {
      await accessibleRepository(token, context.selectedRepository.installationId, context.selectedRepository.id);
      const commit = await readJson(`/repositories/${context.selectedRepository.id}/commits/${encodeURIComponent(context.selectedRepository.branch)}`, token);
      if (!/^[a-f0-9]{40,64}$/.test(commit.sha)) throw new GitHubReadError(502, 'GitHub returned an invalid commit.');
      selectedCommitSha = commit.sha;
    }
    return { ...context, selectedCommitSha, verified: true, installationCount: installations.length, capabilities: ['list_repositories', 'list_files', 'read_file'],
      message: installations.length ? 'GitHub authorization verified. Repository reads are available; commits and pushes are not supported.' : 'GitHub is connected. Install the app on a repository in Settings → Integrations to grant access.' };
  }
  if (operation === 'repositories') {
    const page = integer(args.page, 1, 100);
    if (!page) throw new GitHubReadError(400, 'Pages start at 1.');
    const installationId = integer(args.installation_id, 0, Number.MAX_SAFE_INTEGER);
    const installations = await githubInstallations(token);
    if (installationId && !installations.some(item => item.id === installationId)) throw new GitHubReadError(403, 'This GitHub installation is not available to your account.');
    const chosen = installationId ? installations.filter(item => item.id === installationId) : installations.slice(0, 10);
    const repositories: any[] = [], pages = [];
    for (const installation of chosen) {
      const data = await readJson(`/user/installations/${installation.id}/repositories?per_page=50&page=${page}`, token);
      repositories.push(...data.repositories.map((repo: any) => ({ id: repo.id, installationId: installation.id, fullName: repo.full_name, private: repo.private, defaultBranch: repo.default_branch })));
      pages.push({ installationId: installation.id, page, hasMore: page * 50 < data.total_count });
    }
    return { repositories, pages, selectedRepository: context.selectedRepository,
      installations: installations.map(item => ({ id: item.id, account: item.account.login })), installationsTruncated: !installationId && installations.length > 10 };
  }
  const repositoryId = integer(args.repository_id, 0, Number.MAX_SAFE_INTEGER) || context.selectedRepository?.id;
  const installationId = integer(args.installation_id, 0, Number.MAX_SAFE_INTEGER) || context.selectedRepository?.installationId;
  if (!repositoryId || !installationId) throw new GitHubReadError(400, 'Select a repository in Settings → Integrations or use IDs returned by list_github_repositories.');
  const repo = await accessibleRepository(token, installationId, repositoryId);
  const ref = refValue(args.ref, context.selectedRepository?.id === repositoryId ? context.selectedRepository.branch : repo.default_branch);
  const filePath = pathValue(args.path);
  // Resolve the branch once and pin all content to that commit, so evidence is reproducible.
  const commit = await readJson(`/repositories/${repositoryId}/commits/${encodeURIComponent(ref)}`, token);
  if (!/^[a-f0-9]{40,64}$/.test(commit.sha) || !/^[a-f0-9]{40,64}$/.test(commit.commit?.tree?.sha)) throw new GitHubReadError(502, 'GitHub returned an invalid commit.');
  const provenance = { repository: repo.full_name, repositoryId, installationId, ref, commitSha: commit.sha };
  if (operation === 'tree') {
    const offset = integer(args.offset, 0, 100000);
    const data = await readJson(`/repositories/${repositoryId}/git/trees/${commit.commit.tree.sha}?recursive=1`, token);
    const entries = data.tree.filter((entry: any) => !filePath || entry.path === filePath || entry.path.startsWith(filePath.replace(/\/$/, '') + '/'));
    return { ...provenance, entries: entries.slice(offset, offset + 500).map((entry: any) => ({ path: entry.path, type: entry.type, size: entry.size, sha: entry.sha })),
      offset, hasMore: offset + 500 < entries.length, nextOffset: offset + 500 < entries.length ? offset + 500 : null,
      truncated: Boolean(data.truncated), message: data.truncated ? 'GitHub truncated this tree. The returned file listing is incomplete.' : undefined };
  }
  if (!filePath) throw new GitHubReadError(400, 'Choose a file path from list_github_files.');
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const data = await readJson(`/repositories/${repositoryId}/contents/${encodedPath}?ref=${commit.sha}`, token);
  if (Array.isArray(data) || data.type !== 'file') throw new GitHubReadError(400, 'This path is not a readable regular file. List files and choose a file path.');
  if (data.size > 200000 || data.encoding !== 'base64' || typeof data.content !== 'string') throw new GitHubReadError(413, 'File is too large or binary. Choose a text file up to 200 KB.');
  const bytes = Buffer.from(data.content, 'base64');
  if (bytes.length > 200000 || bytes.includes(0)) throw new GitHubReadError(413, 'File is too large or binary. Choose a text file up to 200 KB.');
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new GitHubReadError(415, 'Only UTF-8 text files can be read in chat.'); }
  return { ...provenance, path: data.path, blobSha: data.sha, content, size: bytes.length,
    url: `https://github.com/${repo.full_name}/blob/${commit.sha}/${encodedPath}` };
}
