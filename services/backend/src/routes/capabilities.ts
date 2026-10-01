import { Router, Response } from 'express';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { AuthedRequest, requireWriteAccess } from '../middleware/auth.js';
import { recordAudit, recordDeniedAudit } from '../services/audit.js';
import { resolveFileRefs } from '../services/fileLibrary.js';
import { impactState } from '../services/impactState.js';

const router = Router();
const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8084';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

async function ai(path: string, body?: unknown) {
  const response = await axios.request({url: `${AI_URL}/ai${path}`, method: body === undefined ? 'GET' : 'POST',
    data: body, headers: {'x-internal-key': process.env.INTERNAL_API_KEY || ''},
    timeout: body === undefined ? 10000 : 130000, maxRedirects: 0});
  return response.data;
}

function unavailable(error: unknown, res: Response) {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  const messages: Record<number, string> = {
    400: 'Invalid arguments or missing confirmation. Check the tool inputSchema.',
    403: 'Confirm the requested evidence source through chat before executing this tool.',
    404: 'Unknown agent or tool.', 422: 'Tool input was blocked by data policy.',
  };
  const code = status && messages[status] ? status : 503;
  return res.status(code).json({error: messages[code] || 'Agent tools are temporarily unavailable. Check the outcome before retrying a memory change.'});
}

router.get('/agents', async (_req, res) => {
  try { res.json(await ai('/agents')); } catch (error) { unavailable(error, res); }
});
router.get('/tools', async (_req, res) => {
  try { res.json(await ai('/tools')); } catch (error) { unavailable(error, res); }
});
router.get('/agents/:agentId/tools', async (req, res) => {
  try {
    const {agents} = await ai('/agents');
    const agent = agents.find((item: {id: string}) => item.id === req.params.agentId);
    if (!agent) return res.status(404).json({error: 'Unknown agent.'});
    const {tools} = await ai('/tools');
    res.json({agentId: agent.id, tools: tools.filter((tool: {name: string}) => agent.tools.includes(tool.name))});
  } catch (error) { unavailable(error, res); }
});

router.post('/tools/:toolName/execute', requireWriteAccess, async (req: AuthedRequest, res) => {
  const body = req.body;
  if (!object(body) || Object.keys(body).some(key => !['sessionId', 'arguments', 'fileRefs', 'confirm'].includes(key)) ||
      typeof body.sessionId !== 'string' || !UUID.test(body.sessionId) ||
      (body.arguments !== undefined && !object(body.arguments)) ||
      (body.confirm !== undefined && typeof body.confirm !== 'boolean') ||
      (body.fileRefs !== undefined && (!Array.isArray(body.fileRefs) || body.fileRefs.length > 10 ||
        !body.fileRefs.every(id => typeof id === 'string' && UUID.test(id)))) ||
      JSON.stringify(body.arguments || {}).length > 16000 || !/^[a-z_]{1,64}$/.test(req.params.toolName)) {
    return res.status(400).json({error: 'Invalid tool request. Supply sessionId, arguments, optional fileRefs and confirm only.'});
  }
  const prisma = req.app.locals.prisma;
  const userId = req.user!.id;
  const toolName = req.params.toolName;
  const args = (body.arguments || {}) as Record<string, unknown>;
  const executionId = randomUUID();
  try {
    const session = await prisma.session.findUnique({where: {id: body.sessionId}});
    // Personal tools never inherit an admin's ability to inspect another owner's session.
    if (!session || session.ownerUserId !== userId) {
      await recordDeniedAudit(prisma, {userId, action: 'tool.execute', resource: toolName,
        decision: 'deny', detail: JSON.stringify({reason: 'Session is not owned by caller'}), ip: req.ip});
      return res.status(403).json({error: 'Tool execution requires a session owned by you.'});
    }
    const {tools} = await ai('/tools');
    const tool = tools.find((item: {name: string}) => item.name === toolName);
    if (!tool) return res.status(404).json({error: 'Unknown tool.'});
    if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties || {}, key))) {
      return res.status(400).json({error: 'Unknown tool arguments. Identity and runtime are supplied by the server.'});
    }
    if (!tool.readOnly && body.confirm !== true) {
      return res.status(400).json({error: 'Memory changes require confirm=true.'});
    }
    const grant = impactState(session.impactState, userId);
    if (toolName === 'read_impact_evidence' && (grant?.phase !== 'confirmed' || !grant.sources.includes(args.source as any))) {
      return res.status(403).json({error: 'Confirm this evidence source through chat before reading it.'});
    }
    const files: Record<string, string> = {};
    if (['list_files', 'get_file_content'].includes(toolName)) {
      const uploads = await prisma.uploadedFile.findMany({where: {sessionId: session.id}, orderBy: {createdAt: 'asc'}});
      for (const file of uploads) files[file.filename] = file.content;
      const assets = await resolveFileRefs(prisma, userId, body.fileRefs || []);
      for (const file of assets) files[`${file.filename} [v${file.version}; ${file.id}]`] = file.content;
    } else if (Array.isArray(body.fileRefs) && body.fileRefs.length) {
      return res.status(400).json({error: 'fileRefs are supported by list_files and get_file_content only.'});
    }
    // Resolve delivery BEFORE executing, including for admins. Never return a queued-only promise.
    const delivery = toolName === 'request_file_delivery'
      ? (await resolveFileRefs(prisma, userId, [args.file_id]))[0] : null;
    await recordAudit(prisma, {userId, action: 'tool.execute', resource: `${session.id}/${toolName}/${executionId}`,
      detail: JSON.stringify({type: req.apiKeyId ? 'api_key' : 'session'}), ip: req.ip});
    const result = await ai(`/tools/${toolName}/execute`, {session_id: session.id, user_id: userId,
      turn_id: executionId, arguments: args, files, impact_state: grant, confirm: body.confirm === true});
    if (delivery && result.ok) result.result = {assetId: delivery.id, filename: delivery.filename,
      version: delivery.version, sourceSessionId: delivery.sessionId,
      downloadUrl: `/api/files/library/${delivery.id}/download`};
    await recordAudit(prisma, {userId, action: 'tool.result', resource: `${session.id}/${toolName}/${executionId}`,
      detail: JSON.stringify({status: result.ok ? 'success' : 'error'}), ip: req.ip});
    res.json({executionId, tool: toolName, sessionId: session.id, ...result});
  } catch (error) {
    const status = (error as {statusCode?: number}).statusCode;
    if (status === 400 || status === 403) return res.status(status).json({error: 'File references must identify files owned by you.'});
    unavailable(error, res);
  }
});

export default router;
