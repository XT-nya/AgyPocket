import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  GitBranchPlus,
  MonitorSmartphone,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import type { ModelFamily } from '../api/client';
import { extractEffortBadge, resolveModelTheme } from '../utils/modelTheme';

interface ModelEffortPickerProps {
  open: boolean;
  onClose: () => void;
  families: ModelFamily[];
  loading: boolean;
  error?: string;
  currentModelId: string;
  isExistingConversation: boolean;
  onRefresh: () => void;
  onConfirmNewModel: (modelId: string) => void;
  onForkWithModel: (modelId: string) => void;
  onSwitchToDesktop: () => void;
}

function findFamilyAndIndex(
  families: ModelFamily[],
  modelId: string
): { family: ModelFamily | null; effortIdx: number; plannerId: string } {
  const target = (modelId || '').trim();
  for (const fam of families) {
    if (fam.family_id === 'orchestrator') {
      const p = fam.planners.find((item) => item.model_id === target);
      if (p) {
        return { family: fam, effortIdx: 0, plannerId: p.id };
      }
    }
    const eIdx = fam.efforts.findIndex((e) => e.model_id === target);
    if (eIdx >= 0) {
      return { family: fam, effortIdx: eIdx, plannerId: '' };
    }
    if (fam.default_model_id === target) {
      const defIdx = Math.max(
        0,
        fam.efforts.findIndex((e) => e.model_id === fam.default_model_id)
      );
      return { family: fam, effortIdx: defIdx, plannerId: fam.planners[0]?.id || '' };
    }
  }
  const first = families[0] || null;
  if (!first) return { family: null, effortIdx: 0, plannerId: '' };
  const defIdx = Math.max(
    0,
    first.efforts.findIndex((e) => e.model_id === first.default_model_id)
  );
  return { family: first, effortIdx: defIdx, plannerId: first.planners[0]?.id || '' };
}

export function ModelEffortPicker({
  open,
  onClose,
  families,
  loading,
  error,
  currentModelId,
  isExistingConversation,
  onRefresh,
  onConfirmNewModel,
  onForkWithModel,
  onSwitchToDesktop,
}: ModelEffortPickerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selectedFamilyId, setSelectedFamilyId] = useState<string>('');
  const [effortIndex, setEffortIndex] = useState<number>(0);
  const [plannerId, setPlannerId] = useState<string>('');

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
      const matched = findFamilyAndIndex(families, currentModelId);
      if (matched.family) {
        setSelectedFamilyId(matched.family.family_id);
        setEffortIndex(matched.effortIdx);
        setPlannerId(matched.plannerId);
      }
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open, families, currentModelId]);

  const activeFamily = useMemo(
    () => families.find((f) => f.family_id === selectedFamilyId) || families[0] || null,
    [families, selectedFamilyId]
  );

  const selectedModelId = useMemo(() => {
    if (!activeFamily) return '';
    if (activeFamily.family_id === 'orchestrator') {
      const p = activeFamily.planners.find((item) => item.id === plannerId) || activeFamily.planners[0];
      return p?.model_id || activeFamily.default_model_id;
    }
    if (activeFamily.efforts.length > 0) {
      const clamped = Math.min(Math.max(0, effortIndex), activeFamily.efforts.length - 1);
      return activeFamily.efforts[clamped].model_id;
    }
    return activeFamily.default_model_id;
  }, [activeFamily, effortIndex, plannerId]);

  const selectedLabel = useMemo(() => {
    if (!activeFamily) return '';
    if (activeFamily.family_id === 'orchestrator') {
      const p = activeFamily.planners.find((item) => item.id === plannerId) || activeFamily.planners[0];
      return p?.display_name || activeFamily.display_name;
    }
    if (activeFamily.efforts.length > 0) {
      const clamped = Math.min(Math.max(0, effortIndex), activeFamily.efforts.length - 1);
      return activeFamily.efforts[clamped].display_name;
    }
    return activeFamily.display_name;
  }, [activeFamily, effortIndex, plannerId]);

  const changedExisting =
    isExistingConversation &&
    Boolean(selectedModelId) &&
    Boolean(currentModelId) &&
    selectedModelId !== currentModelId;

  const activeTheme = useMemo(
    () =>
      resolveModelTheme(
        activeFamily ? `${activeFamily.family_id} ${activeFamily.display_name}` : selectedModelId
      ),
    [activeFamily, selectedModelId]
  );

  const grouped = useMemo(() => {
    const groups: Record<string, ModelFamily[]> = {};
    for (const fam of families) {
      const key = fam.provider || 'Other';
      if (!groups[key]) groups[key] = [];
      groups[key].push(fam);
    }
    return Object.entries(groups);
  }, [families]);

  const handleSelectFamily = (fam: ModelFamily) => {
    setSelectedFamilyId(fam.family_id);
    if (fam.family_id === 'orchestrator') {
      setPlannerId(fam.planners[0]?.id || 'neon');
      setEffortIndex(0);
    } else if (fam.efforts.length > 0) {
      const idx = fam.efforts.findIndex((e) => e.model_id === fam.default_model_id);
      setEffortIndex(idx >= 0 ? idx : 0);
    } else {
      setEffortIndex(0);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="model-picker-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
      className="mx-auto mt-auto sm:my-auto w-[min(32rem,100dvw)] max-h-[88dvh] rounded-t-3xl sm:rounded-3xl"
    >
      <div className="glass-elevated border border-white/15 rounded-t-3xl sm:rounded-3xl flex flex-col max-h-[88dvh]">
        {/* Header */}
        <div className="px-4 py-3.5 border-b border-white/10 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-sky-400" />
            <h2 id="model-picker-title" className="text-sm font-bold">
              真实模型与思考强度
            </h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="w-9 h-9 rounded-xl hover:bg-white/10 flex items-center justify-center disabled:opacity-40"
              aria-label="刷新模型列表"
              title="从本地 agy models 刷新账号可用模型"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-9 h-9 rounded-xl hover:bg-white/10 flex items-center justify-center"
              aria-label="关闭模型选择"
              autoFocus
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto obsidian-scroll p-4 space-y-4 text-xs">
          {error && (
            <div className="rounded-xl bg-rose-500/15 border border-rose-400/35 px-3 py-2 text-rose-200">
              {error}
            </div>
          )}

          {families.length === 0 ? (
            <div className="py-8 text-center opacity-70">
              {loading ? '正在从本地 Antigravity 拉取可用模型...' : '暂无可用模型，请点击右上角刷新按钮'}
            </div>
          ) : (
            <>
              {/* Model family list */}
              <div className="space-y-3">
                {grouped.map(([provider, items]) => (
                  <div key={provider} className="space-y-1.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wider opacity-55 px-1">
                      {provider}
                    </div>
                    <div className="grid grid-cols-1 gap-1.5">
                      {items.map((fam) => {
                        const selected = activeFamily?.family_id === fam.family_id;
                        const famTheme = resolveModelTheme(`${fam.family_id} ${fam.display_name}`);
                        const badgeText = selected
                          ? extractEffortBadge(selectedLabel, fam.fixed_note)
                          : extractEffortBadge(fam.display_name, fam.fixed_note);

                        if (fam.family_id === 'orchestrator') {
                          return (
                            <button
                              key={fam.family_id}
                              type="button"
                              data-active={selected ? 'true' : 'false'}
                              onClick={() => handleSelectFamily(fam)}
                              className="orch-nebula-btn w-full min-h-[42px] px-4 py-2 flex items-center justify-center gap-2 text-sm font-semibold active:scale-[0.98]"
                            >
                              <span className="orch-nebula-flare-l" aria-hidden="true" />
                              <span className="orch-nebula-flare-r" aria-hidden="true" />
                              <span
                                className="orch-star-dot"
                                style={{ right: '14%', top: '26%', '--dur': '3.8s', '--del': '0s' } as CSSProperties}
                                aria-hidden="true"
                              />
                              <span
                                className="orch-star-dot"
                                style={{ right: '28%', top: '68%', '--dur': '4.6s', '--del': '1.2s' } as CSSProperties}
                                aria-hidden="true"
                              />
                              <span
                                className="orch-star-dot"
                                style={{ right: '42%', top: '34%', '--dur': '5.1s', '--del': '0.5s' } as CSSProperties}
                                aria-hidden="true"
                              />
                              <Sparkles className="w-4 h-4 relative z-10 text-rose-100" />
                              <span className="relative z-10 tracking-wide">{fam.display_name}</span>
                              {selected && <Check className="w-4 h-4 relative z-10 text-rose-100" />}
                            </button>
                          );
                        }

                        return (
                          <button
                            key={fam.family_id}
                            type="button"
                            onClick={() => handleSelectFamily(fam)}
                            className={`w-full text-left rounded-2xl px-3.5 py-2.5 border transition flex items-center justify-between gap-2 ${
                              selected
                                ? 'bg-white/10 border-white/25 shadow-sm'
                                : 'bg-white/5 border-white/10 hover:bg-white/10'
                            }`}
                          >
                            <div className="min-w-0 flex items-center gap-2.5">
                              <span
                                className="w-2.5 h-2.5 rounded-full shrink-0"
                                style={{
                                  backgroundColor: famTheme.dotColor,
                                  boxShadow: selected ? `0 0 10px ${famTheme.dotColor}` : undefined,
                                }}
                                aria-hidden="true"
                              />
                              <div className="min-w-0">
                                <div className="font-semibold text-sm flex items-center gap-1.5 flex-wrap">
                                  <span className="truncate">{fam.display_name}</span>
                                  {badgeText && (
                                    <span
                                      className="text-xs font-semibold"
                                      style={{ color: famTheme.accentText }}
                                    >
                                      {badgeText}
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] opacity-65 mt-0.5 truncate">
                                  {fam.adjustable
                                    ? `思考强度: ${fam.efforts.map((e) => e.label).join(' / ')}`
                                    : fam.fixed_note || fam.default_model_id}
                                </div>
                              </div>
                            </div>
                            {selected && <Check className="w-4 h-4 shrink-0" style={{ color: famTheme.accentText }} />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* Thinking Effort Slider / Planner Bar */}
              {activeFamily && (
                <div className="glass-panel prism-border rounded-2xl p-3.5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-semibold text-sm">
                      <SlidersHorizontal className="w-4 h-4" style={{ color: activeTheme.accentText }} />
                      <span>
                        {activeFamily.family_id === 'orchestrator' ? 'Planner 规划模型' : '思考强度'}
                      </span>
                    </div>
                    <span className="font-semibold text-xs" style={{ color: activeTheme.accentText }}>
                      {selectedLabel}
                    </span>
                  </div>

                  {activeFamily.adjustable && activeFamily.efforts.length > 1 ? (
                    <div className="space-y-2.5">
                      <label htmlFor="effort-range-slider" className="sr-only">
                        思考强度
                      </label>
                      <div className="effort-slider-wrap">
                        <div className="effort-slider-shimmer" aria-hidden="true" />
                        <input
                          id="effort-range-slider"
                          type="range"
                          min={0}
                          max={activeFamily.efforts.length - 1}
                          step={1}
                          value={Math.min(effortIndex, activeFamily.efforts.length - 1)}
                          aria-valuetext={selectedLabel}
                          onChange={(e) => setEffortIndex(Number(e.target.value))}
                          style={
                            {
                              '--attr-min': 0,
                              '--attr-max': activeFamily.efforts.length - 1,
                              '--control-value': Math.min(effortIndex, activeFamily.efforts.length - 1),
                              '--effort-c0': activeTheme.stops[0],
                              '--effort-c1': activeTheme.stops[1],
                              '--effort-c2': activeTheme.stops[2],
                              '--effort-c3': activeTheme.stops[3],
                            } as CSSProperties
                          }
                          className="effort-liquid-slider"
                        />
                      </div>
                      <div
                        className="grid gap-1.5"
                        style={{
                          gridTemplateColumns: `repeat(${activeFamily.efforts.length}, minmax(0, 1fr))`,
                        }}
                      >
                        {activeFamily.efforts.map((tier, idx) => {
                          const active = idx === effortIndex;
                          return (
                            <button
                              key={tier.model_id}
                              type="button"
                              onClick={() => setEffortIndex(idx)}
                              style={
                                active
                                  ? {
                                      borderColor: activeTheme.dotColor,
                                      boxShadow: `0 0 12px -3px ${activeTheme.glowRgba}`,
                                    }
                                  : undefined
                              }
                              className={`min-h-[36px] rounded-xl border text-xs font-medium transition ${
                                active
                                  ? 'bg-white/15 text-white'
                                  : 'bg-white/5 border-white/10 opacity-75 hover:opacity-100'
                              }`}
                            >
                              {tier.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : activeFamily.family_id === 'orchestrator' && activeFamily.planners.length > 0 ? (
                    <div className="space-y-2">
                      <div
                        className="grid gap-1.5"
                        style={{
                          gridTemplateColumns: `repeat(${activeFamily.planners.length}, minmax(0, 1fr))`,
                        }}
                      >
                        {activeFamily.planners.map((pl) => {
                          const active = pl.id === plannerId;
                          return (
                            <button
                              key={pl.model_id}
                              type="button"
                              onClick={() => setPlannerId(pl.id)}
                              className={`min-h-[38px] rounded-xl border text-xs font-medium transition ${
                                active
                                  ? 'bg-violet-500/30 border-violet-400/60 text-violet-100'
                                  : 'bg-white/5 border-white/10 opacity-75 hover:opacity-100'
                              }`}
                            >
                              {pl.label}
                            </button>
                          );
                        })}
                      </div>
                      <div className="text-[11px] opacity-70">{activeFamily.fixed_note}</div>
                    </div>
                  ) : (
                    <div className="text-[11px] opacity-75">
                      {activeFamily.fixed_note || '当前模型为固定思考预算。'}
                    </div>
                  )}
                </div>
              )}

              {/* Existing Conversation Soft-Guard Dual Action */}
              {changedExisting && (
                <div className="rounded-2xl bg-amber-500/12 border border-amber-400/35 p-3.5 space-y-2.5">
                  <div className="flex items-start gap-2">
                    <ArrowRightLeft className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                    <div className="space-y-0.5">
                      <div className="font-semibold text-amber-200">当前对话已绑定模型</div>
                      <div className="text-[11px] opacity-85 leading-relaxed">
                        官方桌面联动仅支持在新建对话时指定模型（`agentapi` 限制）。你可以直接按新模型新开续聊，或切去电脑遥控点击桌面模型栏。
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onForkWithModel(selectedModelId);
                        onClose();
                      }}
                      className="min-h-[42px] rounded-xl bg-sky-500/25 border border-sky-400/50 text-sky-100 font-semibold flex items-center justify-center gap-1.5 px-3"
                    >
                      <GitBranchPlus className="w-4 h-4 shrink-0" />
                      <span>同项目新开续聊</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onSwitchToDesktop();
                      }}
                      className="min-h-[42px] rounded-xl bg-violet-500/20 border border-violet-400/45 text-violet-100 font-medium flex items-center justify-center gap-1.5 px-3"
                    >
                      <MonitorSmartphone className="w-4 h-4 shrink-0" />
                      <span>去 Tab 2 点桌面模型栏</span>
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/10 flex items-center justify-between gap-2 shrink-0">
          <div className="text-[11px] opacity-65 truncate font-mono">{selectedModelId || '未选择'}</div>
          <button
            type="button"
            disabled={!selectedModelId}
            onClick={() => {
              onConfirmNewModel(selectedModelId);
              onClose();
            }}
            className="min-h-[40px] px-5 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 text-white font-semibold text-xs disabled:opacity-40"
          >
            {isExistingConversation ? '设为新建默认' : '确认使用此模型'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
