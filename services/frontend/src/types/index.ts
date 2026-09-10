export interface Session {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messages?: Message[];
  files?: UploadedFile[];
  outputs?: GeneratedOutput[];
  _count?: {
    messages: number;
    files: number;
    outputs: number;
  };
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface UploadedFile {
  id: string;
  sessionId: string;
  filename: string;
  category: 'template' | 'mapping' | 'dbt_add_info' | 'dbt_stg_add_info' | 'other';
  createdAt: string;
}

export interface GeneratedOutput {
  id: string;
  sessionId: string;
  messageId?: string | null; // assistant message that produced this version
  filename: string;
  filepath: string;
  fileType: 'sql' | 'txt';
  content?: string;
  createdAt: string;
}

export interface MigrationStatus {
  template_analyzed: boolean;
  mapping_reviewed: boolean;
  add_info_generated: boolean;
  stg_generated: boolean;
  report_generated: boolean;
}

export interface ChatResponse {
  userMessage: Message;
  assistantMessage: Message;
  generated_files?: GeneratedOutput[];
  savedOutputs?: GeneratedOutput[];
  updatedSession?: { id: string; name: string; updatedAt: string };
  status?: MigrationStatus;
  guardrail?: GuardrailInfo;
}

export interface GuardrailInfo {
  decision: 'allow' | 'redacted' | 'blocked';
  reasons?: string[];
  findings?: Array<{ type: string; count: number }>;
  data_class?: string;
}

export type Role = 'admin' | 'analyst' | 'auditor';
export type UserStatus = 'active' | 'restricted' | 'disabled';

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: UserStatus;
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export type IntegrationProvider = 'github' | 'gitlab' | 'snowflake' | 'dbt';

export interface Integration {
  provider: IntegrationProvider;
  status: 'connected' | 'disconnected';
  configured: boolean;
  displayName: string | null;
  metadata: Record<string, unknown>;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
}

export type ApiKeyStatus = 'active' | 'expired' | 'revoked' | 'inactive';

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  status: ApiKeyStatus;
  owner: { id: string; email: string; name: string | null };
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AdminUser extends User {
  usage: {
    totalTokens: number;
    totalCostUsd: number;
    requests: number;
    monthTokens: number;
    monthCostUsd: number;
    sessions: number;
  };
}

export interface UsageSummary {
  windowDays: number;
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    requests: number;
  };
  byModel: Array<{
    model: string;
    provider: string;
    totalTokens: number;
    costUsd: number;
    requests: number;
  }>;
  daily: Array<{ date: string; tokens: number; costUsd: number; requests: number }>;
}

export interface AuditEvent {
  id: string;
  userId: string | null;
  user?: { email: string; name?: string | null } | null;
  action: string;
  resource: string | null;
  decision: 'allow' | 'deny' | 'blocked';
  dataClass: string | null;
  severity: 'info' | 'warning' | 'critical';
  detail: string | null;
  ip: string | null;
  createdAt: string;
}

export interface SecuritySummary {
  windowDays: number;
  counts: Array<{ action: string; decision: string; count: number }>;
  recent: AuditEvent[];
}
