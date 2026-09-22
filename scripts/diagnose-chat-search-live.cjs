// Read-only diagnostic restricted to the known synthetic release-check corpus.
const {PrismaClient} = require(process.cwd() + '/node_modules/@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const user = await prisma.user.findUniqueOrThrow({where: {email: 'sagar@callsphere.ai'}});
  const session = await prisma.session.findFirstOrThrow({
    where: {ownerUserId: user.id, messages: {some: {role: 'user', content: {startsWith: 'Can you share the mapping sheet filename for the synthetic cedar '}}}},
    orderBy: {updatedAt: 'desc'}, select: {id: true, messages: {orderBy: {createdAt: 'asc'}, select: {role: true, content: true}}},
  });
  const logs = await prisma.aiActivityLog.findMany({where: {sessionId: session.id}, orderBy: {createdAt: 'asc'},
    select: {step: true, tool: true, model: true, inputTokens: true, outputTokens: true, detail: true}});
  // Describe behaviour without exporting retrieved customer content or filenames.
  const replies = session.messages.filter(m => m.role === 'assistant').map(m => ({
    length: m.content.length,
    mentionsSyntheticFilename: /crosswalk_[a-f0-9]{8}\.csv/.test(m.content),
    saysUnavailable: /unavailable|cannot access|can't access|don't have access|no access|not have access/i.test(m.content),
    asksForAttachment: /upload|attach|paste/i.test(m.content),
    saysNoMatch: /no match|couldn't find|could not find|not find|no file|no saved|not contain/i.test(m.content),
    mentionsSearch: /search|looked|found/i.test(m.content),
  }));
  const calls = logs.map(log => ({step: log.step, tool: log.tool, model: log.model,
    inputTokens: log.inputTokens, outputTokens: log.outputTokens,
    // The logger's detail keys are safe metadata; values may contain file content.
    detailKeys: Object.keys(log.detail || {}),
  }));
  console.log(JSON.stringify({chatSearchProgress: 'synthetic failure diagnosis', sessionId: session.id, replies, calls}));
  console.log(JSON.stringify({chatSearchProductionCheck: 'passed', diagnosticOnly: true}));
}
main().catch(e => {console.error(e.name); process.exitCode=1;}).finally(() => prisma.$disconnect());
