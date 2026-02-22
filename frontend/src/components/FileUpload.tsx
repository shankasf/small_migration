import { useRef } from 'react';
import { Plus } from 'lucide-react';

interface FileUploadProps {
  onUpload: (files: File[]) => void;
}

export default function FileUpload({ onUpload }: FileUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      onUpload(Array.from(files));
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <>
      <button
        onClick={() => fileInputRef.current?.click()}
        className="p-2 rounded-full hover:bg-gray-200 transition-colors text-gray-500 hover:text-gray-700"
        title="Attach files"
      >
        <Plus className="w-5 h-5" />
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".csv,.xlsx,.xls,.txt,.sql,.json,.xml,.md,.py,.js,.ts,.yaml,.yml,.log"
        onChange={handleFileSelect}
        className="hidden"
      />
    </>
  );
}
