import axios from 'axios';
import { Session, Message, ChatResponse, UploadedFile, GeneratedOutput } from '../types';

const API_BASE = '/api';

const api = axios.create({
  baseURL: API_BASE,
  timeout: 600000, // 10 minutes for AI processing (reasoning models with large files)
});

// Sessions
export async function getSessions(cursor?: string, limit = 50): Promise<{ sessions: Session[]; nextCursor: string | null }> {
  const params: Record<string, string> = { limit: String(limit) };
  if (cursor) params.cursor = cursor;
  const response = await api.get('/sessions', { params });
  return response.data;
}

export async function getSession(id: string): Promise<Session> {
  const response = await api.get(`/sessions/${id}`);
  return response.data;
}

export async function createSession(name?: string): Promise<Session> {
  const response = await api.post('/sessions', { name });
  return response.data;
}

export async function updateSession(id: string, name: string): Promise<Session> {
  const response = await api.patch(`/sessions/${id}`, { name });
  return response.data;
}

export async function deleteSession(id: string): Promise<void> {
  await api.delete(`/sessions/${id}`);
}

// Messages
export async function getMessages(sessionId: string): Promise<Message[]> {
  const response = await api.get(`/chat/${sessionId}/messages`);
  return response.data;
}

export async function sendMessage(sessionId: string, message: string): Promise<ChatResponse> {
  const response = await api.post(`/chat/${sessionId}/messages`, { message });
  return response.data;
}

// Files
export async function uploadFiles(sessionId: string, files: File[]): Promise<{ files: UploadedFile[] }> {
  console.log(`[UPLOAD] Starting upload of ${files.length} files to session ${sessionId}`);
  files.forEach((f, i) => console.log(`[UPLOAD]   file[${i}]: ${f.name} (${f.size} bytes, type=${f.type})`));
  const formData = new FormData();
  files.forEach(file => {
    formData.append('files', file);
  });
  try {
    console.log(`[UPLOAD] Sending POST /files/${sessionId}/upload`);
    const response = await api.post(`/files/${sessionId}/upload`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    console.log('[UPLOAD] Upload response:', response.status, response.data);
    return response.data;
  } catch (error: any) {
    console.error('[UPLOAD] Upload failed:', error?.response?.status, error?.response?.data, error?.message);
    throw error;
  }
}

export async function getSessionFiles(sessionId: string): Promise<UploadedFile[]> {
  const response = await api.get(`/files/${sessionId}`);
  return response.data;
}

export async function deleteFile(fileId: string): Promise<void> {
  await api.delete(`/files/${fileId}`);
}

// Uploaded file content/download
export async function getUploadedFileContent(fileId: string): Promise<{ content: string; filename: string }> {
  const response = await api.get(`/files/uploaded/${fileId}/content`);
  return response.data;
}

export async function downloadUploadedFile(fileId: string): Promise<Blob> {
  const response = await api.get(`/files/uploaded/${fileId}/download`, {
    responseType: 'blob',
  });
  return response.data;
}

// Outputs
export async function getSessionOutputs(sessionId: string): Promise<GeneratedOutput[]> {
  const response = await api.get(`/sessions/${sessionId}/outputs`);
  return response.data;
}

export async function downloadOutput(outputId: string): Promise<Blob> {
  const response = await api.get(`/files/output/${outputId}/download`, {
    responseType: 'blob',
  });
  return response.data;
}

// Speech-to-text
export async function transcribeAudio(audioBlob: Blob): Promise<{ text: string }> {
  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  const response = await api.post('/stt', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 30000,
  });
  return response.data;
}

// Health check
export async function healthCheck(): Promise<{ status: string }> {
  const response = await api.get('/health');
  return response.data;
}
