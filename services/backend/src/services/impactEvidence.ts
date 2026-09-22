import axios from 'axios';
import type { PrismaClient } from '@prisma/client';
import { readGitHub } from './githubAgent.js';
import { decryptIntegrationSecrets } from './integrationSecrets.js';
import { searchFiles } from './fileLibrary.js';
import { searchChatHistory } from './chatSearch.js';
import { snowflakeKeyPairJwt } from './snowflakeAuth.js';
import type { ImpactSource } from './impactState.js';

export class ImpactReadError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown, name: string, optional = false): string => {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\x00-\x1f\x7f]/.test(value)) throw new ImpactReadError(400, `Invalid ${name}.`);
  return value.trim();
};
const number = (value: unknown, fallback = 0, max = 1000000): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new ImpactReadError(400, 'Invalid ID or pagination.');
  return Number(value);
};
function id(value: unknown) {
  const n = number(value, 0, Number.MAX_SAFE_INTEGER);
  if (!n) throw new ImpactReadError(400, 'Choose an explicit project or run ID.');
  return n;
}
function pathValue(value: unknown) {
  const path = text(value, 'artifact path');
  if (path.startsWith('/') || path.split('/').some(p => !p || p === '..' || p === '.') || path.includes('\\') ||
      !/\.(sql|ya?ml|json|md|txt|csv)$/i.test(path)) throw new ImpactReadError(400, 'Choose a dbt reference file path.');
  return path;
}

/** Bound model context without pretending a page is the complete artifact. */
export function artifactPage(content: string, args: Record<string, unknown>) {
  const offset = number(args.offset, 0, 16000000);
  const target = text(args.target, 'target', true);
  if (target) {
    try {
      const artifact = JSON.parse(content);
      const entries = ['nodes', 'sources', 'exposures', 'metrics', 'semantic_models', 'unit_tests', 'saved_queries']
        .flatMap(section => Object.entries(object(artifact[section])).map(([key, node]) => ({section, key, node: object(node)})));
      const exact = entries.filter(e => e.key === target || e.node.name === target);
      const matches = exact.length ? exact : entries.filter(e => e.key.toLowerCase().includes(target.toLowerCase()) ||
        Object.hasOwn(object(e.node.columns), target));
      const page = matches.slice(offset, offset + 5);
      return {target, matches: page.map(({section, key, node}) => {
        const evidence = JSON.stringify(node);
        const parents = object(artifact.parent_map)[key] || object(node.depends_on).nodes || [];
        const children = object(artifact.child_map)[key] || entries.filter(e =>
          Array.isArray(object(e.node.depends_on).nodes) && object(e.node.depends_on).nodes.includes(key)).map(e => e.key);
        return {section, uniqueId: key, evidence: evidence.slice(0, 30000), truncated: evidence.length > 30000,
          parents, children};
      }), totalMatches: matches.length, nextOffset: offset + page.length < matches.length ? offset + page.length : null,
      scope: 'Matching nodes and immediate lineage only. Traverse parent/child IDs for transitive impact; read raw pages for truncated node details.'};
    } catch { /* A SQL/YAML file remains an exact, paginated text reference. */ }
  }
  const page = content.slice(offset, offset + 24000);
  // 1-based line number of the page's first character, for exact file:line citations.
  const startLine = content.slice(0, offset).split('\n').length;
  return {content: page, offset, startLine, totalCharacters: content.length, nextOffset: offset + page.length < content.length ? offset + page.length : null,
    partial: offset > 0 || page.length < content.length};
}

async function connection(prisma: PrismaClient, userId: string, provider: string) {
  const row = await prisma.integration.findUnique({where: {userId_provider: {userId, provider}}});
  if (!row || row.status !== 'connected') throw new ImpactReadError(409, `${provider} is not connected. Connect it in Settings → Integrations or confirm another source.`);
  return {metadata: object(row.metadata), secrets: decryptIntegrationSecrets(row.encryptedSecrets)};
}

async function providerGet(url: string, authorization: string, params: Record<string, unknown> = {}) {
  return axios.get(url, {headers: {Authorization: authorization, Accept: 'application/json'}, params,
    timeout: 30000, maxRedirects: 0, maxContentLength: 16 * 1024 * 1024});
}

export async function readImpactEvidence(prisma: PrismaClient, userId: string, sessionId: string,
                                         source: ImpactSource, operation: string, args: Record<string, unknown>) {
  if (source === 'uploads') {
    const where = {session: {ownerUserId: userId}, OR: [{sessionId}, {references: {some: {message: {sessionId}}}}]};
    if (operation === 'list') {
      const assets = await prisma.fileAsset.findMany({where, select: {id: true, filename: true, version: true, contentHash: true, sessionId: true, kind: true, uploadedFileId: true},
        orderBy: [{createdAt: 'desc'}, {id: 'asc'}], skip: number(args.offset), take: 101});
      // Legacy uploads may not yet have a snapshot from the background indexer.
      const legacy = await prisma.uploadedFile.findMany({where: {sessionId, session: {ownerUserId: userId}}, select: {id: true, filename: true}});
      return {source, files: assets.slice(0, 100), legacyUploads: legacy.filter(f => !assets.some(a => a.uploadedFileId === f.id)).map(f => ({...f, id: `upload:${f.id}`})),
        nextOffset: assets.length > 100 ? number(args.offset) + 100 : null};
    }
    if (operation === 'read') {
      const assetId = text(args.id, 'file ID');
      if (assetId.startsWith('upload:')) {
        const file = await prisma.uploadedFile.findFirst({where: {id: assetId.slice(7), sessionId, session: {ownerUserId: userId}}});
        if (!file) throw new ImpactReadError(404, 'Upload not found in the confirmed chat.');
        return {source, id: assetId, filename: file.filename, ...artifactPage(file.content, args)};
      }
      const asset = await prisma.fileAsset.findFirst({where: {...where, id: assetId}});
      if (!asset) throw new ImpactReadError(404, 'File version is not attached to this chat.');
      return {source, id: asset.id, filename: asset.filename, version: asset.version, contentHash: asset.contentHash,
        sourceSessionId: asset.sessionId, ...artifactPage(asset.content, args)};
    }
  }
  if (source === 'history') {
    if (operation === 'search') {
      const query = text(args.query, 'query');
      return {source, files: await searchFiles(prisma, userId, {q: query, offset: number(args.offset)}),
        messages: await searchChatHistory(prisma, userId, sessionId, {q: query, scope: 'all', offset: number(args.offset)}),
        caveat: 'Assistant mentions are not hard evidence. Read exact file IDs/versions before analysis.'};
    }
    if (operation === 'read') {
      const asset = await prisma.fileAsset.findFirst({where: {id: text(args.id, 'file ID'), session: {ownerUserId: userId}}});
      if (!asset) throw new ImpactReadError(404, 'File version unavailable to this user.');
      return {source, id: asset.id, filename: asset.filename, version: asset.version, contentHash: asset.contentHash,
        sourceSessionId: asset.sessionId, ...artifactPage(asset.content, args)};
    }
  }
  if (source === 'github') {
    if (!['status', 'repositories', 'tree', 'file'].includes(operation)) throw new ImpactReadError(400, 'Read-only GitHub operation required.');
    if (operation === 'file') pathValue(args.path);
    const result = await readGitHub(prisma, userId, operation, args, 8 * 1024 * 1024);
    if ('content' in result && typeof result.content === 'string') {
      const {content, ...provenance} = result;
      return {source, ...provenance, ...artifactPage(content, args)};
    }
    return {source, ...result};
  }
  if (source === 'gitlab') {
    if (!['projects', 'tree', 'file'].includes(operation)) throw new ImpactReadError(400, 'Read-only GitLab operation required.');
    const {secrets} = await connection(prisma, userId, source);
    const token = String(secrets.accessToken || '');
    if (!token) throw new ImpactReadError(409, 'Reconnect GitLab.');
    const get = (path: string, params: Record<string, unknown> = {}) => providerGet(`https://gitlab.com/api/v4${path}`, `Bearer ${token}`, params);
    if (operation === 'projects') {
      const result = await get('/projects', {membership: true, per_page: 50, page: number(args.page, 1, 10000)});
      return {source, projects: result.data.map((p: any) => ({id: p.id, name: p.path_with_namespace, defaultBranch: p.default_branch})), nextPage: result.headers['x-next-page'] || null};
    }
    const projectId = id(args.project_id);
    const ref = text(args.ref, 'branch or commit');
    const commit = await get(`/projects/${projectId}/repository/commits/${encodeURIComponent(ref)}`);
    const sha = text(commit.data.id, 'resolved commit');
    if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new ImpactReadError(409, 'Invalid repository commit.');
    if (operation === 'tree') {
      const result = await get(`/projects/${projectId}/repository/tree`, {ref: sha, recursive: true, per_page: 100,
        page: number(args.page, 1, 10000), path: text(args.path, 'folder', true)});
      return {source, projectId, commitSha: sha, entries: result.data.map((f: any) => ({path: f.path, type: f.type})), nextPage: result.headers['x-next-page'] || null};
    }
    const path = pathValue(args.path);
    const result = await get(`/projects/${projectId}/repository/files/${encodeURIComponent(path)}`, {ref: sha});
    if (result.data.encoding !== 'base64') throw new ImpactReadError(409, 'Unsupported repository file encoding.');
    const content = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(result.data.content, 'base64'));
    return {source, projectId, path, commitSha: sha, ...artifactPage(content, args)};
  }
  if (source === 'dbt') {
    if (!['runs', 'artifacts', 'artifact'].includes(operation)) throw new ImpactReadError(400, 'Only existing dbt runs and artifacts can be read.');
    const {metadata, secrets} = await connection(prisma, userId, source);
    if (metadata.host !== 'cloud.getdbt.com' || !/^\d+$/.test(String(metadata.accountId)) || !secrets.token) throw new ImpactReadError(409, 'Reconnect a supported dbt Cloud account.');
    const get = (path: string, params: Record<string, unknown> = {}) => providerGet(
      `https://cloud.getdbt.com/api/v2/accounts/${metadata.accountId}${path}`, `Token ${secrets.token}`, params);
    if (operation === 'runs') {
      const result = await get('/runs/', {limit: 20, offset: number(args.offset), order_by: '-id', ...(args.job_id ? {job_definition_id: id(args.job_id)} : {})});
      return {source, accountId: metadata.accountId, runs: result.data.data.map((r: any) => ({id: r.id, jobId: r.job_definition_id,
        environmentId: r.environment_id, status: r.status, finishedAt: r.finished_at, gitSha: r.git_sha})),
      nextOffset: result.data.data.length === 20 ? number(args.offset) + 20 : null};
    }
    const runId = id(args.run_id);
    if (operation === 'artifacts') return {source, accountId: metadata.accountId, runId, paths: (await get(`/runs/${runId}/artifacts/`)).data.data};
    const path = pathValue(args.path);
    const result = await get(`/runs/${runId}/artifacts/${path.split('/').map(encodeURIComponent).join('/')}`);
    return {source, accountId: metadata.accountId, runId, path,
      ...artifactPage(typeof result.data === 'string' ? result.data : JSON.stringify(result.data), args)};
  }
  if (source === 'snowflake') {
    if (!['columns', 'dependencies'].includes(operation) || 'sql' in args || 'statement' in args) throw new ImpactReadError(400, 'Only fixed Snowflake metadata reads are allowed.');
    const {metadata, secrets} = await connection(prisma, userId, source);
    const database = text(args.database || metadata.database, 'database');
    const schema = text(args.schema, 'schema');
    const table = text(args.table, 'table');
    if (!/^[a-z0-9._-]+$/i.test(metadata.account) || !metadata.username || !secrets.privateKey) throw new ImpactReadError(409, 'Reconnect Snowflake.');
    const quotedDatabase = '"' + database.replace(/"/g, '""') + '"';
    const offset = number(args.offset);
    // Identifiers are quoted; all predicate values are bound. No data tables,
    // user SQL, dbt build/job execution or arbitrary API endpoints are exposed.
    const statement = operation === 'columns'
      ? `SELECT TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, ORDINAL_POSITION FROM ${quotedDatabase}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT 100 OFFSET ${offset}`
      : `SELECT REFERENCING_DATABASE, REFERENCING_SCHEMA, REFERENCING_OBJECT_NAME, REFERENCED_DATABASE, REFERENCED_SCHEMA, REFERENCED_OBJECT_NAME, DEPENDENCY_TYPE FROM SNOWFLAKE.ACCOUNT_USAGE.OBJECT_DEPENDENCIES WHERE (REFERENCED_DATABASE = ? AND REFERENCED_SCHEMA = ? AND REFERENCED_OBJECT_NAME = ?) OR (REFERENCING_DATABASE = ? AND REFERENCING_SCHEMA = ? AND REFERENCING_OBJECT_NAME = ?) ORDER BY REFERENCING_DATABASE, REFERENCING_SCHEMA, REFERENCING_OBJECT_NAME, REFERENCED_DATABASE, REFERENCED_SCHEMA, REFERENCED_OBJECT_NAME LIMIT 100 OFFSET ${offset}`;
    const values = operation === 'columns' ? [schema, table] : [database, schema, table, database, schema, table];
    const token = snowflakeKeyPairJwt(metadata.account, metadata.username, String(secrets.privateKey), secrets.privateKeyPass ? String(secrets.privateKeyPass) : undefined);
    const result = await axios.post(`https://${metadata.account.toLowerCase()}.snowflakecomputing.com/api/v2/statements`, {
      statement, timeout: 20, database, bindings: Object.fromEntries(values.map((v, i) => [String(i + 1), {type: 'TEXT', value: v}])),
      ...(metadata.warehouse ? {warehouse: metadata.warehouse} : {}), ...(metadata.role ? {role: metadata.role} : {}),
    }, {headers: {Authorization: `Bearer ${token}`, 'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT'},
      timeout: 30000, maxRedirects: 0, maxContentLength: 2000000});
    if (result.status === 202) return {source, pending: true, caveat: 'Metadata query is still running. No dependency conclusion is available; retry this read.'};
    return {source, database, schema, table, columns: result.data.resultSetMetaData?.rowType?.map((c: any) => c.name), rows: result.data.data,
      nextOffset: result.data.data?.length === 100 ? offset + 100 : null,
      caveat: 'Warehouse metadata only; account-usage latency and access limits apply. This is not proof of dbt column lineage or complete dashboard consumption.'};
  }
  throw new ImpactReadError(400, 'Unsupported read-only evidence operation.');
}
