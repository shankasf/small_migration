import { PrismaClient, User } from '@prisma/client';

export interface UsageInput {
  userId: string;
  sessionId?: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface ModelPrice {
  input: number; // USD per 1M input tokens
  output: number; // USD per 1M output tokens
}

/**
 * USD per 1M tokens. Override/extend via MODEL_PRICING env (JSON of the same
 * shape) when the provider price list changes — config, not code.
 */
const DEFAULT_PRICING: Record<string, ModelPrice> = {
  // Bedrock Sydney standard tier, USD/1M tokens. aws.amazon.com/bedrock/pricing/
  'openai.gpt-oss-120b-1:0': { input: 0.1545, output: 0.6180 },
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-5.2': { input: 1.25, output: 10 },
  'gpt-5.1': { input: 1.25, output: 10 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  default: { input: 2.5, output: 10 },
};

function pricingTable(): Record<string, ModelPrice> {
  const raw = process.env.MODEL_PRICING;
  if (!raw) return DEFAULT_PRICING;
  try {
    return { ...DEFAULT_PRICING, ...JSON.parse(raw) };
  } catch {
    console.error('[USAGE] MODEL_PRICING env is not valid JSON; using defaults');
    return DEFAULT_PRICING;
  }
}

export function computeCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const table = pricingTable();
  const price = table[model] || table.default;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export async function recordUsage(prisma: PrismaClient, usage: UsageInput) {
  const totalTokens = usage.inputTokens + usage.outputTokens;
  return prisma.usageRecord.create({
    data: {
      userId: usage.userId,
      sessionId: usage.sessionId || null,
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens,
      costUsd: computeCostUsd(usage.model, usage.inputTokens, usage.outputTokens),
    },
  });
}

export interface CapCheck {
  allowed: boolean;
  reason?: string;
  usedToday: number;
  usedThisMonth: number;
}

/** Enforce per-user daily/monthly token caps set by an admin. */
export async function checkTokenCaps(prisma: PrismaClient, user: User): Promise<CapCheck> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [day, month] = await Promise.all([
    prisma.usageRecord.aggregate({
      where: { userId: user.id, createdAt: { gte: startOfDay } },
      _sum: { totalTokens: true },
    }),
    prisma.usageRecord.aggregate({
      where: { userId: user.id, createdAt: { gte: startOfMonth } },
      _sum: { totalTokens: true },
    }),
  ]);

  const usedToday = day._sum.totalTokens || 0;
  const usedThisMonth = month._sum.totalTokens || 0;

  if (user.dailyTokenLimit != null && usedToday >= user.dailyTokenLimit) {
    return {
      allowed: false,
      reason: `Daily token limit reached (${usedToday.toLocaleString()} / ${user.dailyTokenLimit.toLocaleString()})`,
      usedToday,
      usedThisMonth,
    };
  }
  if (user.monthlyTokenLimit != null && usedThisMonth >= user.monthlyTokenLimit) {
    return {
      allowed: false,
      reason: `Monthly token limit reached (${usedThisMonth.toLocaleString()} / ${user.monthlyTokenLimit.toLocaleString()})`,
      usedToday,
      usedThisMonth,
    };
  }
  return { allowed: true, usedToday, usedThisMonth };
}
