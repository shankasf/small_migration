// Strictly read-only application diagnosis. Provider credentials are never selected.
const { PrismaClient } = require(process.cwd() + '/node_modules/@prisma/client');
const prisma = new PrismaClient();
const clean = text => String(text || '').replace(/```[\s\S]*?```/g, '[code block omitted]')
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[credential redacted]')
  .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').slice(0, 3000);
async function main() {
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const requestedEmail = 'sagar@callpshewre.ai';
    const exact = await tx.user.findUnique({ where: { email: requestedEmail }, select: { id: true, email: true, role: true, status: true } });
    const candidates = exact ? [] : await tx.user.findMany({ where: { email: { startsWith: 'sagar@', mode: 'insensitive' } }, select: { id: true, email: true, role: true, status: true }, take: 10 });
    const user = exact || candidates.find(candidate => candidate.email.toLowerCase() === 'sagar@callsphere.ai');
    if (!user) return { requestedEmail, exactMatch: false, candidateEmails: candidates.map(item => item.email), user: null };
    const connection = await tx.integration.findUnique({ where: { userId_provider: { userId: user.id, provider: 'github' } }, select: {
      status: true, displayName: true, connectedAt: true, lastVerifiedAt: true, updatedAt: true, metadata: true,
    } });
    const selected = connection?.metadata?.selectedRepository;
    const safeConnection = connection && { status: connection.status, displayName: connection.displayName,
      connectedAt: connection.connectedAt, lastVerifiedAt: connection.lastVerifiedAt, updatedAt: connection.updatedAt,
      mode: connection.metadata?.mode, login: connection.metadata?.login,
      selectedRepository: selected ? { id: selected.id, installationId: selected.installationId, fullName: selected.fullName, branch: selected.branch } : null };
    const matches = await tx.message.findMany({ where: { session: { ownerUserId: user.id }, content: { contains: 'github', mode: 'insensitive' } },
      select: { id: true, sessionId: true, role: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 12 });
    const sessionIds = [...new Set(matches.map(item => item.sessionId))].slice(0, 3);
    const sessions = [];
    for (const id of sessionIds) {
      const session = await tx.session.findUnique({ where: { id }, select: { id: true, name: true, createdAt: true, updatedAt: true } });
      const latestMatch = matches.find(item => item.sessionId === id);
      const before = await tx.message.findMany({ where: { sessionId: id, createdAt: { lte: latestMatch.createdAt } },
        orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, role: true, createdAt: true, content: true } });
      const after = await tx.message.findMany({ where: { sessionId: id, createdAt: { gt: latestMatch.createdAt } },
        orderBy: { createdAt: 'asc' }, take: 2, select: { id: true, role: true, createdAt: true, content: true } });
      const messages = [...before.reverse(), ...after];
      const logs = await tx.aiActivityLog.findMany({ where: { sessionId: id, createdAt: { gte: messages[0]?.createdAt } },
        orderBy: { createdAt: 'desc' }, take: 25, select: { createdAt: true, step: true, tool: true, model: true, turnId: true } });
      sessions.push({ ...session, messages: messages.map(item => ({ ...item, content: clean(item.content) })), activity: logs.reverse() });
    }
    return { requestedEmail, exactMatch: Boolean(exact), candidateEmails: candidates.map(item => item.email), user, connection: safeConnection, sessions };
  }, { timeout: 30000 });
  console.log(JSON.stringify({ githubChatDiagnostic: result }));
}
main().catch(error => { console.error(JSON.stringify({ githubChatDiagnosticError: error?.code || error?.name || 'unknown' })); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
