import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Terminal, XCircle } from 'lucide-react';
import type { CardRendererProps } from '../types';

interface ToolCallData {
  name?: string;
  args?: Record<string, unknown>;
  status?: 'running' | 'done' | 'error';
  output?: string;
}

export function ToolCallCard({ payload }: CardRendererProps<ToolCallData>) {
  const [expanded, setExpanded] = useState(false);
  const { name = 'tool', args = {}, status = 'done', output = '' } = payload.data || {};
  const argsPreview = Object.keys(args).length ? JSON.stringify(args) : '';

  return (
    <div className="glass-panel rounded-xl px-3 py-2.5 my-1.5 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 text-left min-h-[32px]"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Terminal className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <span className="font-mono font-semibold truncate">{name}</span>
          {argsPreview && (
            <span className="opacity-60 font-mono truncate max-w-[160px]">{argsPreview}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {status === 'running' && <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" />}
          {status === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
          {status === 'error' && <XCircle className="w-3.5 h-3.5 text-rose-400" />}
          {expanded ? <ChevronDown className="w-3.5 h-3.5 opacity-70" /> : <ChevronRight className="w-3.5 h-3.5 opacity-70" />}
        </div>
      </button>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-white/10 space-y-2">
          {argsPreview && (
            <div>
              <div className="text-[11px] opacity-60 mb-1">参数</div>
              <pre className="p-2 rounded-lg bg-black/35 overflow-x-auto font-mono text-[11px] whitespace-pre-wrap break-all">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {output && (
            <div>
              <div className="text-[11px] opacity-60 mb-1">输出</div>
              <pre className="p-2 rounded-lg bg-black/35 overflow-x-auto font-mono text-[11px] max-h-56 whitespace-pre-wrap break-all">
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
