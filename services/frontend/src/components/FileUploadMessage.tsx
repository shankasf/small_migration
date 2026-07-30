import { UploadedFile } from '../types';
import { FileText, FileSpreadsheet, FileCode, File, CheckCircle2 } from 'lucide-react';

interface FileUploadMessageProps {
  files: UploadedFile[];
}

const categoryLabels: Record<string, { label: string; color: string }> = {
  template: { label: 'Template', color: '!border-signal/40 !text-signal' },
  mapping: { label: 'Mapping Doc', color: '!border-success/40 !text-success' },
  dbt_add_info: { label: 'ADD_INFO Model', color: '!border-brass/40 !text-brass-bright' },
  dbt_stg_add_info: { label: 'STG Model', color: '!border-warn/40 !text-warn' },
  sql_file: { label: 'SQL File', color: '!border-warn/40 !text-warn' },
  other: { label: 'Document', color: '' },
};

function getFileIcon(filename: string) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    return <FileSpreadsheet className="w-5 h-5" />;
  }
  if (ext === 'sql') {
    return <FileCode className="w-5 h-5" />;
  }
  if (ext === 'txt' || ext === 'md') {
    return <FileText className="w-5 h-5" />;
  }
  return <File className="w-5 h-5" />;
}

export default function FileUploadMessage({ files }: FileUploadMessageProps) {
  if (!files || files.length === 0) return null;

  return (
    <div className="flex items-start gap-3">
      {/* User avatar */}
      <div className="w-8 h-8 rounded-xl border border-hairline bg-elevated flex items-center justify-center flex-shrink-0 text-brass">
        <FileText className="w-4 h-4" />
      </div>

      <div className="flex-1 max-w-[85%]">
        <div className="eyebrow mb-1.5">Files Uploaded</div>

        <div className="panel p-4">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 className="w-4 h-4 text-success" />
            <span className="text-sm font-medium text-ink">
              {files.length} file{files.length > 1 ? 's' : ''} uploaded successfully
            </span>
          </div>

          <div className="space-y-2">
            {files.map((file) => {
              const catInfo = categoryLabels[file.category] || categoryLabels.other;
              return (
                <div
                  key={file.id}
                  className="flex items-center gap-3 p-2.5 bg-elevated rounded-lg border border-hairline hover:border-hairline-strong transition-colors"
                >
                  <div className="text-brass">
                    {getFileIcon(file.filename)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink truncate">
                      {file.filename}
                    </div>
                  </div>
                  <span className={`chip !py-0.5 ${catInfo.color}`}>
                    {catInfo.label}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="mt-3 pt-3 border-t border-hairline">
            <p className="text-xs text-muted">
              Files are ready for analysis. Ask me to analyze them or generate migration scripts.
            </p>
          </div>
        </div>

        <div className="text-[10px] font-mono text-faint mt-1.5">
          {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  );
}
