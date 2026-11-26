import { useEffect, useState } from 'react';
import { Monitor, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import type { ApprovalDecision } from '../../api/client';
import type { CardRendererProps } from '../types';

interface ApprovalData {
  approval_id?: string;
  tool_name?: string;
  title?: string;
  summary?: string;
  detail?: string;
  model_name?: string;
  expires_at?: number;
  decision?: string;
}

const DECISION_LABELS: Record<string, string> = {
  approve: '已允许执行',
  auto_approve: '已允许执行',
  deny: '已拒绝',
  allow: '已交由电脑端处理',
};

export function ApprovalCard({ payload, onAction }: CardRendererProps<ApprovalData>) {
  const [localDecision, setLocalDecision] = useState<string | undefined>(payload.data?.decision);
  const [remaining, setRemaining] = useState<number>(0);

  const approvalId = payload.data?.approval_id || payload.id;
  const heading = payload.data?.summary || payload.data?.title || '桌面版工具执行需要审批';
  const detail = payload.data?.detail || '';
  const toolName = payload.data?.tool_name || '';
  const expiresAt = payload.data?.expires_at || 0;

  useEffect(() => {
    setLocalDecision(payload.data?.decision);
  }, [payload.data?.decision]);

  useEffect(() => {
    if (!expiresAt || localDecision) return;
    const tick = () => {
      setRemaining(Math.max(0, Math.ceil(expiresAt - Date.now() / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, localDecision]);

  const decide = (decision: ApprovalDecision) => {
    setLocalDecision(decision);
    onAction('core.cards', 'approval.decide', {
      card_id: payload.id,
      approval_id: approvalId,
      decision,
    });
  };

  return (
    <div className="glass-elevated prism-border rounded-2xl p-3.5 my-2 text-xs space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="font-semibold text-sm leading-snug break-words">{heading}</div>
            {toolName && (
              <div className="text-[11px] opacity-65 font-mono mt-0.5">工具: {toolName}</div>
            )}
          </div>
        </div>
        {!localDecision && expiresAt > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-400/35 text-amber-200 font-mono text-[10px] shrink-0">
            {remaining}s
          </span>
        )}
      </div>

      {detail && (
        <pre className="rounded-xl bg-black/35 border border-white/10 px-3 py-2 font-mono text-[11px] opacity-85 whitespace-pre-wrap break-all max-h-40 overflow-y-auto obsidian-scroll">
          {detail}
        </pre>
      )}

      {localDecision ? (
        <div className="text-xs font-medium text-emerald-300">
          {DECISION_LABELS[localDecision] || `已处理: ${localDecision}`}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={() => decide('auto_approve')}
            className="min-h-[40px] rounded-xl bg-emerald-500/25 border border-emerald-400/45 text-emerald-100 font-semibold flex items-center justify-center gap-1 active:scale-95 transition"
          >
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            <span>允许</span>
          </button>
          <button
            type="button"
            onClick={() => decide('deny')}
            className="min-h-[40px] rounded-xl bg-rose-500/20 border border-rose-400/40 text-rose-200 font-medium flex items-center justify-center gap-1 active:scale-95 transition"
          >
            <XCircle className="w-3.5 h-3.5 shrink-0" />
            <span>拒绝</span>
          </button>
          <button
            type="button"
            onClick={() => decide('allow')}
            className="min-h-[40px] rounded-xl bg-white/10 border border-white/15 text-slate-200 font-medium flex items-center justify-center gap-1 active:scale-95 transition"
          >
            <Monitor className="w-3.5 h-3.5 shrink-0" />
            <span>电脑端</span>
          </button>
        </div>
      )}
    </div>
  );
}
