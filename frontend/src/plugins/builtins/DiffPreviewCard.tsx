import { FileDiff } from 'lucide-react';
import type { CardRendererProps } from '../types';

interface DiffData {
  file?: string;
  summary?: string;
  added?: number;
  removed?: number;
}

export function DiffPreviewCard({ payload }: CardRendererProps<DiffData>) {
  const { file = '未命名文件', summary = '', added = 0, removed = 0 } = payload.data || {};
  return (
    <div className="glass-panel rounded-xl px-3 py-2.5 my-1.5 text-xs flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <FileDiff className="w-4 h-4 text-violet-400 shrink-0" />
        <div className="min-w-0">
          <div className="font-mono font-medium truncate">{file}</div>
          {summary && <div className="opacity-65 truncate">{summary}</div>}
        </div>
      </div>
      <div className="flex items-center gap-1.5 font-mono shrink-0">
        <span className="text-emerald-400">+{added}</span>
        <span className="text-rose-400">-{removed}</span>
      </div>
    </div>
  );
}
