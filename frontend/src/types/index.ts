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
}
