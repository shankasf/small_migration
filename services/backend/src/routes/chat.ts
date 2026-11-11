import { historyWithFileEvidence } from '../services/chatSearch.js';
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { githubChatContext } from '../services/githubAgent.js';
import { screenPayload, sendToAIService } from '../services/aiService.js';
import { AuthedRequest, canAccessSession, requireWriteAccess } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { checkTokenCaps, computeCostUsd, recordUsage } from '../services/usage.js';
import { beginTurn } from '../services/aiLog.js';
import { attachLibraryRefs, referenceData, resolveFileRefs, snapshotFile } from '../services/fileLibrary.js';
import { impactBrief, impactState, parseImpactSources, requestImpactSources } from '../services/impactState.js';
import { ownFeedback } from '../services/feedback.js';
import { buildContextFiles, carriedAssetIds, supersedeCarried } from '../services/fileContext.js';


const router = Router();

const getPrisma = (req: Request): PrismaClient => req.app.locals.prisma;

// Send message to session
router.post('/:sessionId/messages', requireWriteAccess, async (req: AuthedRequest, res: Response, next) => {
  try {
    const prisma = getPrisma(req);
    const recordAiEvent = req.app.locals.recordAiEvent;
    const { sessionId } = req.params;
    let { message } = req.body;
    const user = req.user!;

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Verify session exists and determine if this is the first message
    const isFirstMessage = await prisma.message.count({ where: { sessionId } }) === 0;

    // Load the full saved conversation and files for every turn.
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        files: true,
        messages: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!canAccessSession(user, session)) {
      await recordAudit(prisma, {
        userId: user.id, action: 'chat.message', resource: sessionId,
        decision: 'deny', severity: 'warning', ip: req.ip
      });
      return res.status(403).json({ error: 'You do not have access to this session' });
    }

    // Enforce per-user token caps set by an admin
    const caps = await checkTokenCaps(prisma, user);
    if (!caps.allowed) {
      await recordAudit(prisma, {
        userId: user.id, action: 'chat.message', resource: sessionId,
        decision: 'deny', severity: 'warning',
        detail: JSON.stringify({ reason: caps.reason }), ip: req.ip
      });
      return res.status(429).json({ error: caps.reason });
    }

    const selected = await resolveFileRefs(prisma, user.id, req.body.fileRefs || []);
    // Restore explicit references on later turns; recheck source ownership on every use.
    // Refs live on the last assistant reply plus any later user message (a turn
    // whose AI call failed saved the user's selection but no reply).
    const previousTurn = await prisma.message.findFirst({
      where: {sessionId, role: 'assistant'}, orderBy: {createdAt: 'desc'},
      include: {libraryRefs: {where: {assetId: {not: null}}, orderBy: {createdAt: 'asc'}}},
    });
    const laterUserTurns = await prisma.message.findMany({
      where: {sessionId, role: 'user', ...(previousTurn ? {createdAt: {gt: previousTurn.createdAt}} : {})},
      orderBy: {createdAt: 'asc'},
      include: {libraryRefs: {where: {assetId: {not: null}}, orderBy: {createdAt: 'asc'}}},
    });
    const carriedIds = carriedAssetIds([previousTurn?.libraryRefs || [], ...laterUserTurns.map(m => m.libraryRefs)]);
    const carriedFound = await prisma.fileAsset.findMany({where: {
      id: {in: carriedIds}, session: {ownerUserId: user.id},
    }});
    const previousAssets = carriedIds.map(id => carriedFound.find(a => a.id === id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
    // A newer pick of the same file (this turn, or a later failed turn) replaces the older one.
    const carried = supersedeCarried(selected, previousAssets);
    const assets = [...selected, ...carried];
    const sessionFiles = [...session.files].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const contextFiles = buildContextFiles(sessionFiles, selected, carried);
    const screened = await screenPayload(message,
      contextFiles,
      await historyWithFileEvidence(prisma, user.id, session.messages));
    message = screened.message;

    // Save only screened content. A rejected request never becomes history.
    // Save user message
    const userMessage = await prisma.message.create({
      data: {
        sessionId,
        role: 'user',
        content: message,
        libraryRefs: {create: referenceData(selected)},
      }
    });

    // Confirmation is parsed from the authenticated user's actual message, never
    // from an LLM tool argument. Persist it before any evidence gateway can read.
    let impact = impactState(session.impactState, user.id);
    const selection = impact?.phase === 'awaiting_sources' ? parseImpactSources(message) : null;
    const justConfirmed = Boolean(selection);
    if (impact && selection) {
      impact = {...impact, phase: 'confirmed', sources: selection, confirmedAt: userMessage.createdAt.toISOString()};
      await prisma.session.update({where: {id: sessionId}, data: {impactState: {...impact}}});
      await recordAudit(prisma, {userId: user.id, action: 'impact.sources.confirmed', resource: sessionId,
        detail: JSON.stringify({changed: selection}), ip: req.ip});
    }

    // Explicit file labels carry immutable IDs and versions; never resolve a name alone.
    const files = Object.keys(screened.files).length ? screened.files : undefined;

    // Prepare conversation history
    const history = screened.history;

    // Open an observability turn: every event the AI service emits from here
    // on (guardrails, model calls, tool calls, output) is attributed to this
    // user id and grouped under this turn id.
    const turnId = randomUUID();
    beginTurn({ turnId, sessionId, userId: user.id, userEmail: user.email });
    const turnStartedAt = Date.now();
    recordAiEvent({
      sessionId,
      turnId,
      step: 'turn.start',
      type: 'info',
      message: `Turn started — ${message.length} chars${files ? `, ${Object.keys(files).length} file(s)` : ''}`,
      detail: {
        messageChars: message.length,
        files: files ? Object.keys(files) : [],
        historyMessages: history.length,
      },
    });

    // Call AI service
    let aiResponse;
    const impactStartedAt = impact ? new Date(impact.startedAt) : null;
    try {
      aiResponse = await sendToAIService({
        session_id: sessionId,
        message,
        files,
        history,
        user_id: user.id,
        turn_id: turnId,
        github_context: await githubChatContext(prisma, user.id),
        impact_context: {
          state: impact, just_confirmed: justConfirmed,
          connections: (await prisma.integration.findMany({where: {userId: user.id, status: 'connected'}, select: {provider: true}})).map(i => i.provider),
          history: impactStartedAt ? screened.history.filter((_, index) => session.messages[index]?.createdAt >= impactStartedAt) : [],
        },
      });
    } catch (aiError) {
      recordAiEvent({
        sessionId,
        turnId,
        step: 'error',
        type: 'error',
        message: `AI service call failed: ${(aiError as Error)?.message || 'unknown error'}`,
        durationMs: Date.now() - turnStartedAt,
      });
      throw aiError;
    }

    // Record token usage + cost for this user (metering for admin analytics/caps)
    const inputTokens = aiResponse.usage?.input_tokens || 0;
    const outputTokens = aiResponse.usage?.output_tokens || 0;
    const model = aiResponse.usage?.model || 'unknown';
    const provider = aiResponse.usage?.provider || 'openai';
    if (aiResponse.impact_action === 'request_sources') {
      // A source switch keeps the original brief; a new analysis uses the new
      // user request. Earlier consent is never carried into this grant.
      impact = requestImpactSources(user.id, impactBrief(impact, message), userMessage.createdAt);
      await prisma.session.update({where: {id: sessionId}, data: {impactState: {...impact}}});
    } else if (aiResponse.impact_action === 'clear' && impact) {
      await prisma.session.update({where: {id: sessionId}, data: {impactState: {}}});
    }
    if (inputTokens || outputTokens) {
      recordUsage(prisma, {
        userId: user.id,
        sessionId,
        provider,
        model,
        inputTokens,
        outputTokens,
      }).catch(err => console.error('[USAGE] Failed to record usage:', err?.message || err));
    }

    // Turn summary — the authoritative token/cost line for this turn, priced
    // by the backend's own pricing table rather than by the AI service.
    recordAiEvent({
      sessionId,
      turnId,
      step: 'turn.complete',
      type: 'usage',
      message: `Turn complete — ${(inputTokens + outputTokens).toLocaleString()} tokens, `
        + `$${computeCostUsd(model, inputTokens, outputTokens).toFixed(4)}, `
        + `${aiResponse.generated_files?.length || 0} file(s)`,
      provider,
      model,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - turnStartedAt,
      detail: {
        guardrail: aiResponse.guardrail?.decision || 'allow',
        generatedFiles: (aiResponse.generated_files || []).map(f => f.name),
        responseChars: aiResponse.response?.length || 0,
      },
    });

    // Audit the interaction, carrying the guardrail decision from the AI service
    const guardrail = aiResponse.guardrail;
    await recordAudit(prisma, {
      userId: user.id,
      action: guardrail?.decision === 'blocked' ? 'guardrail.block' : 'chat.message',
      resource: sessionId,
      decision: guardrail?.decision === 'blocked' ? 'blocked' : 'allow',
      dataClass: guardrail?.data_class || 'metadata',
      severity: guardrail?.decision === 'blocked' ? 'critical'
        : guardrail?.decision === 'redacted' ? 'warning' : 'info',
      detail: guardrail ? JSON.stringify({
        decision: guardrail.decision,
        reasons: guardrail.reasons,
        findings: guardrail.findings
      }) : null,
      ip: req.ip
    });

    // Save assistant message
    const assistantMessage = await prisma.message.create({
      data: {
        sessionId,
        role: 'assistant',
        content: aiResponse.response,
        libraryRefs: {create: referenceData(assets)},
      }
    });

    // Save generated files if any. Each generation is a new immutable version
    // linked to the assistant message that produced it — revisions of the same
    // filename get their own row, so earlier messages keep their own files.
    let savedOutputs: any[] = [];
    if (aiResponse.generated_files && aiResponse.generated_files.length > 0) {
      savedOutputs = await Promise.all(
        aiResponse.generated_files.map((file: any) =>
          prisma.generatedOutput.create({
            data: {
              sessionId,
              messageId: assistantMessage.id,
              filename: file.name,
              filepath: file.path,
              fileType: file.name.endsWith('.sql') ? 'sql' : 'txt',
              content: file.content || '',
              validation: file.validation || {},
            },
            select: {
              id: true, sessionId: true, messageId: true, filename: true,
              filepath: true, fileType: true, createdAt: true,
            },
          })
        )
      );
    }

    for (const output of savedOutputs) {
      const versions = await prisma.generatedOutput.findMany({where: {sessionId, filename: output.filename}, orderBy: [{createdAt: 'asc'}, {id: 'asc'}]});
      for (const record of versions) await snapshotFile(prisma, 'output', record);
    }

    // Update session name if it's the first message
    const sessionName = isFirstMessage
      ? message.slice(0, 50) + (message.length > 50 ? '...' : '')
      : undefined;
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        ...(sessionName ? { name: sessionName } : {}),
        updatedAt: new Date(),
      }
    });

    // Return saved DB records (with id, createdAt) so frontend can use directly
    const [userWithRefs, assistantWithRefs] = await attachLibraryRefs(prisma, [userMessage, assistantMessage]);
    res.json({
      userMessage: userWithRefs,
      assistantMessage: assistantWithRefs,
      generated_files: aiResponse.generated_files || [],
      savedOutputs,
      updatedSession: {
        id: sessionId,
        name: sessionName || session.name,
        updatedAt: new Date().toISOString(),
      },
      status: aiResponse.status,
      guardrail: aiResponse.guardrail
    });
  } catch (error) {
    next(error);
  }
});

// Get messages for a session
router.get('/:sessionId/messages', async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { sessionId } = req.params;

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!canAccessSession(req.user!, session)) {
      return res.status(403).json({ error: 'You do not have access to this session' });
    }

    const messages = await prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' }
    });

    // The reader's own thumb rides along with the transcript, so a reload
    // restores what they rated instead of showing an empty control.
    const ratings = await ownFeedback(prisma, req.user!.id, sessionId);
    const withRefs = await attachLibraryRefs(prisma, messages);
    res.json(withRefs.map(message => ({ ...message, feedback: ratings.get(message.id) ?? null })));
  } catch (error) {
    console.error('Error getting messages:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

export default router;
