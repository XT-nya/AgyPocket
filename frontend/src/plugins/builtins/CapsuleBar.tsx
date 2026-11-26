import { Cpu, ShieldCheck, Sparkles, Square } from 'lucide-react';
import type { ApprovalPolicy } from '../../api/client';
import { resolveModelTheme } from '../../utils/modelTheme';
import type { CapsuleSlotProps } from '../types';

const APPROVAL_BADGE: Record<ApprovalPolicy, { label: string; tone: string }> = {
  remote_smart: { label: '手机审批', tone: 'text-sky-300 bg-sky-500/15 border-sky-400/30' },
  remote_all: { label: '全量审批', tone: 'text-amber-300 bg-amber-500/15 border-amber-400/30' },
  desktop_only: { label: '仅电脑端', tone: 'text-slate-300 bg-white/10 border-white/20' },
};

const STATUS_META: Record<CapsuleSlotProps['agentStatus'], { label: string; dot: string }> = {
  idle: { label: '待命', dot: 'bg-emerald-400' },
  thinking: { label: '思考中', dot: 'bg-violet-400 prism-pulse' },
  running: { label: '执行中', dot: 'bg-sky-400 prism-pulse' },
  error: { label: '异常', dot: 'bg-rose-400' },
  aborted: { label: '已停止', dot: 'bg-amber-400' },
};

function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function CapsuleBar({
  model,
  modelDisplayLabel,
  approvalPolicy = 'remote_smart',
  bridgeStatus,
  telemetry,
  agentStatus,
  usageSummary,
  onCycleApprovalPolicy,
  onAbort,
  onOpenSettings,
  onOpenModelPicker,
}: CapsuleSlotProps) {
  const st = STATUS_META[agentStatus];
  const isBusy = agentStatus === 'thinking' || agentStatus === 'running';
  const apr = APPROVAL_BADGE[approvalPolicy] ?? APPROVAL_BADGE.remote_smart;
  const modelTheme = resolveModelTheme(modelDisplayLabel || model);

  const bridgeOnline = Boolean(bridgeStatus?.sidecar_running);
  const bridgeTitle = bridgeStatus?.detail || (bridgeOnline ? '桌面 App Sidecar 已联动' : '桌面 App 待重启/连接');

  let contextLabel = usageSummary || '';
  if (telemetry && telemetry.active_context_tokens > 0) {
    const used = formatCompactTokens(telemetry.active_context_tokens);
    if (telemetry.context_limit) {
      const pct = telemetry.usage_percent != null ? `${telemetry.usage_percent}%` : '';
      contextLabel = `${used}/${formatCompactTokens(telemetry.context_limit)}${pct ? ` · ${pct}` : ''}`;
    } else {
      contextLabel = `${used} ctx`;
    }
  }

  return (
    <div
      className={`glass-panel capsule-shell rounded-2xl px-2.5 py-1.5 flex items-center justify-between gap-1.5 text-xs transition-shadow ${
        isBusy ? 'capsule-reasoning-active border-white/25' : 'prism-border'
      }`}
    >
      {isBusy && (
        <>
          <div className="capsule-beam-ring" aria-hidden="true">
            <div className="capsule-beam-rotor" />
          </div>
          <div className="capsule-liquid-shimmer" aria-hidden="true" />
        </>
      )}

      <div className="relative z-10 flex items-center gap-1.5 min-w-0">
        <button
          type="button"
          onClick={onOpenSettings}
          title={bridgeTitle}
          className="inline-flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-white/10 transition shrink-0"
        >
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              isBusy ? st.dot : bridgeOnline ? 'bg-emerald-400' : 'bg-amber-400'
            }`}
            aria-hidden="true"
          />
          <span className="font-medium opacity-90">
            {isBusy ? st.label : bridgeOnline ? 'App联动' : '待连接'}
          </span>
          {isBusy && (
            <span className="inline-flex items-end gap-[2px] h-2.5 text-sky-300" aria-hidden="true">
              <span className="capsule-eq-bar" style={{ animationDelay: '0ms' }} />
              <span className="capsule-eq-bar" style={{ animationDelay: '180ms' }} />
              <span className="capsule-eq-bar" style={{ animationDelay: '340ms' }} />
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={onOpenModelPicker || onOpenSettings}
          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border transition truncate max-w-[172px] ${
            isBusy
              ? 'bg-white/10 border-white/20 shadow-sm'
              : 'bg-white/5 hover:bg-white/12 border-white/10'
          }`}
          title="点选真实模型与思考强度滑条"
        >
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{
              backgroundColor: modelTheme.dotColor,
              boxShadow: isBusy ? `0 0 8px ${modelTheme.dotColor}` : undefined,
            }}
            aria-hidden="true"
          />
          <Sparkles className={`w-3 h-3 shrink-0 ${isBusy ? 'text-sky-300 animate-spin' : 'text-sky-400'}`} />
          <span className="truncate font-medium">{modelDisplayLabel || model || '选择模型'}</span>
        </button>
      </div>

      <div className="relative z-10 flex items-center gap-1.5 shrink-0">
        {contextLabel && (
          <span
            className="hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-black/25 border border-white/10 text-[11px] opacity-80 font-mono"
            title="当前对话上下文占用"
          >
            <Cpu className="w-3 h-3 text-violet-300" />
            <span>{contextLabel}</span>
          </span>
        )}

        <button
          type="button"
          onClick={onCycleApprovalPolicy || onOpenSettings}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border font-medium transition ${apr.tone}`}
          title="点击切换手机端工具审批策略"
        >
          <ShieldCheck className="w-3 h-3" />
          <span>{apr.label}</span>
        </button>

        {isBusy && (
          <button
            type="button"
            onClick={onAbort}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-rose-500/25 border border-rose-400/50 text-rose-200 font-medium active:scale-95 transition"
          >
            <Square className="w-3 h-3 fill-current" />
            <span>停止</span>
          </button>
        )}
      </div>
    </div>
  );
}
