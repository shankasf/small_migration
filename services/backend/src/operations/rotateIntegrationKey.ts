/** Run as a controlled ECS one-off task after configuring both current and previous keys. */
import { PrismaClient } from '@prisma/client';
import { decryptIntegrationSecrets, encryptIntegrationSecrets } from '../services/integrationSecrets.js';
import { recordAudit } from '../services/audit.js';
const prisma = new PrismaClient();
async function main() {
  if (!process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS) throw new Error('Previous key is required for rotation');
  const rows = await prisma.integration.findMany({select:{id:true, encryptedSecrets:true}});
  let rotated = 0;
  for (const row of rows) {
    const plain = decryptIntegrationSecrets(row.encryptedSecrets);
    const replacement = encryptIntegrationSecrets(plain);
    if (JSON.stringify(decryptIntegrationSecrets(replacement)) !== JSON.stringify(plain)) throw new Error('Rotation verification failed');
    await prisma.integration.updateMany({where:{id:row.id, encryptedSecrets:row.encryptedSecrets}, data:{encryptedSecrets:replacement}});
    rotated++;
  }
  await recordAudit(prisma, {action:'security.integration_key_rotated', detail:JSON.stringify({count:rotated})});
  console.log(JSON.stringify({rotated}));
}
main().catch(() => {console.error('Key rotation failed; keep the previous key configured'); process.exitCode=1;}).finally(() => prisma.$disconnect());
