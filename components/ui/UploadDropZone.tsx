'use client';

import { useState, type RefObject } from 'react';
import { Loader2, Upload } from 'lucide-react';
import clsx from 'clsx';

export function UploadDropZone({
  uploading = false,
  onFile,
  inputRef,
  accept,
  title,
  hint,
  className,
}: {
  uploading?: boolean;
  onFile: (file: File) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  accept: string;
  title: string;
  hint: string;
  className?: string;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        const file = event.dataTransfer.files[0];
        if (file) onFile(file);
      }}
      className={clsx(
        'dropzone',
        dragOver
          ? 'border-sage-600 ll-tint'
          : 'border-[var(--color-border)] bg-[var(--color-bg)] hover:border-sage-400 hover:bg-[var(--color-sage-50)]',
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
        }}
      />
      <div className="flex justify-center mb-3">
        <span className="upload-badge">
          {uploading
            ? <Loader2 className="w-5 h-5 animate-spin" />
            : <Upload className="w-5 h-5" strokeWidth={1.9} />}
        </span>
      </div>
      <div className="drop-title">{uploading ? '업로드 중...' : title}</div>
      <div className="drop-help">{hint}</div>
    </div>
  );
}
