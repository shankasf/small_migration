import axios from 'axios';

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8084';

interface ChatRequest {
  session_id: string;
  message: string;
  files?: Record<string, string>;
  history?: Array<{ role: string; content: string }>;
  /** Identity of the turn, so AI-service activity logs are attributable. */
  user_id?: string;
  turn_id?: string;
  github_context?: { status: string; selectedRepository: { id: number; installationId: number; fullName: string; branch: string } | null };
}

interface GeneratedFile {
  name: string;
  path: string;
  content?: string;
  validation?: Record<string, unknown>;
}

interface ChatResponse {
  response: string;
  generated_files?: GeneratedFile[];
  status?: {
    template_analyzed: boolean;
    mapping_reviewed: boolean;
    add_info_generated: boolean;
    stg_generated: boolean;
    report_generated: boolean;
  };
  usage?: {
    provider?: string;
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  guardrail?: {
    decision: 'allow' | 'redacted' | 'blocked';
    reasons?: string[];
    findings?: Array<{ type: string; count: number }>;
    data_class?: string;
  };
}

export async function sendToAIService(request: ChatRequest): Promise<ChatResponse> {
  try {
    const response = await axios.post<ChatResponse>(
      `${AI_SERVICE_URL}/ai/chat`,
      request,
      {
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.INTERNAL_API_KEY ? { 'x-internal-key': process.env.INTERNAL_API_KEY } : {})
        },
        timeout: 600000 // 10 minute timeout for AI processing (reasoning models with large files)
      }
    );

    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('AI Service error:', error.response?.status || 'unavailable');
      throw new Error(error.response?.data?.detail || 'AI service unavailable');
    }
    throw error;
  }
}

export async function checkAIServiceHealth(): Promise<boolean> {
  try {
    const response = await axios.get(`${AI_SERVICE_URL}/ai/health`, {
      timeout: 5000
    });
    return response.status === 200;
  } catch {
    return false;
  }
}


export interface ScreenedPayload {
  message: string;
  files: Record<string, string>;
  history: Array<{role: string; content: string}>;
  guardrail: NonNullable<ChatResponse['guardrail']>;
  error?: string;
}

export class PolicyError extends Error {
  constructor(public readonly result: ScreenedPayload) { super('Content blocked by policy'); }
}

export async function screenPayload(message = '', files?: Record<string, string>, history?: Array<{role: string; content: string}>): Promise<ScreenedPayload> {
  if (!process.env.INTERNAL_API_KEY) throw new Error('Content screening unavailable');
  const { data } = await axios.post<ScreenedPayload>(`${AI_SERVICE_URL}/ai/policy/check`, { message, files, history }, {
    headers: { 'x-internal-key': process.env.INTERNAL_API_KEY }, timeout: 30000,
  });
  if (!data.guardrail || !['allow', 'redacted', 'blocked'].includes(data.guardrail.decision)) throw new Error('Invalid screening response');
  if (data.guardrail.decision === 'blocked') throw new PolicyError(data);
  return data;
}

export async function securityStatus() {
  const { data } = await axios.get(`${AI_SERVICE_URL}/ai/security/status`, {
    headers: { 'x-internal-key': process.env.INTERNAL_API_KEY }, timeout: 5000,
  });
  return data;
}

export async function resetAISession(id: string) {
  await axios.post(`${AI_SERVICE_URL}/ai/reset/${encodeURIComponent(id)}`, {}, {
    headers: { 'x-internal-key': process.env.INTERNAL_API_KEY }, timeout: 10000,
  });
}

export async function testOutput(content: string, fixture: unknown) {
  const { data } = await axios.post(`${AI_SERVICE_URL}/ai/validation/test`, {content, fixture}, {
    headers: {'x-internal-key': process.env.INTERNAL_API_KEY}, timeout: 15000,
  });
  return data;
}


export async function cancelUserRuns(userId: string): Promise<void> {
  await axios.post(`${AI_SERVICE_URL}/ai/cancel/user/${encodeURIComponent(userId)}`, {}, {
    headers: {'x-internal-key': process.env.INTERNAL_API_KEY}, timeout: 10000,
  });
}

export async function embedSearchTexts(texts: string[]): Promise<number[][]> {
  const { data } = await axios.post(`${AI_SERVICE_URL}/ai/files/embed`, { texts }, {
    headers: { 'x-internal-key': process.env.INTERNAL_API_KEY }, timeout: 60000,
  });
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length ||
      data.embeddings.some((v: unknown) => !Array.isArray(v) || v.length !== 1536 || v.some(n => !Number.isFinite(n)))) {
    throw new Error('Invalid search embedding response');
  }
  return data.embeddings;
}
