import { execFileSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
async function sync() {
try {
  await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { stdio: 'inherit' });
} finally {
  await prisma.$disconnect();
}

}
void sync().catch(() => { console.error("Schema sync failed"); process.exitCode = 1; });
