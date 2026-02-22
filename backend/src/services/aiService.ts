import axios from 'axios';

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8084';

interface ChatRequest {
  session_id: string;
  message: string;
  files?: Record<string, string>;
  history?: Array<{ role: string; content: string }>;
}

interface GeneratedFile {
  name: string;
  path: string;
  content?: string;
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
}

export async function sendToAIService(request: ChatRequest): Promise<ChatResponse> {
  try {
    const response = await axios.post<ChatResponse>(
      `${AI_SERVICE_URL}/ai/chat`,
      request,
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 600000 // 10 minute timeout for AI processing (reasoning models with large files)
      }
    );

    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('AI Service error:', error.response?.data || error.message);
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
