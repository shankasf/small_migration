import { UploadedFile } from '../types';
import { FileText, FileSpreadsheet, FileCode, File, CheckCircle2 } from 'lucide-react';

interface FileUploadMessageProps {
  files: UploadedFile[];
}

const categoryLabels: Record<string, { label: string; color: string }> = {
  template: { label: 'Template', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  mapping: { label: 'Mapping Doc', color: 'bg-green-100 text-green-700 border-green-200' },
  dbt_add_info: { label: 'ADD_INFO Model', color: 'bg-purple-100 text-purple-700 border-purple-200' },
  dbt_stg_add_info: { label: 'STG Model', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  sql_file: { label: 'SQL File', color: 'bg-yellow-100 text-yellow-700 border-yellow-200' },
  other: { label: 'Document', color: 'bg-gray-100 text-gray-700 border-gray-200' },
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
      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-gray-700 to-gray-900 flex items-center justify-center flex-shrink-0 shadow-md">
        <FileText className="w-4 h-4 text-white" />
      </div>

      <div className="flex-1 max-w-[85%]">
        <div className="text-[11px] font-semibold mb-1.5 tracking-wide text-gray-400">
          Files Uploaded
        </div>

        <div className="bg-gradient-to-br from-gray-50 to-white rounded-2xl rounded-tl-md border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 className="w-4 h-4 text-green-500" />
            <span className="text-sm font-medium text-gray-700">
              {files.length} file{files.length > 1 ? 's' : ''} uploaded successfully
            </span>
          </div>

          <div className="space-y-2">
            {files.map((file) => {
              const catInfo = categoryLabels[file.category] || categoryLabels.other;
              return (
                <div
                  key={file.id}
                  className="flex items-center gap-3 p-2.5 bg-white rounded-lg border border-gray-100 hover:border-gray-200 transition-colors"
                >
                  <div className="text-gray-500">
                    {getFileIcon(file.filename)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">
                      {file.filename}
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 text-[10px] font-semibold rounded-full border ${catInfo.color}`}>
                    {catInfo.label}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="mt-3 pt-3 border-t border-gray-100">
            <p className="text-xs text-gray-500">
              Files are ready for analysis. Ask me to analyze them or generate migration scripts.
            </p>
          </div>
        </div>

        <div className="text-[10px] text-gray-400 mt-1.5">
          {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  );
}
