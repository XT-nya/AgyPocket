import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileText,
  FolderGit2,
  FolderOpen,
  HardDriveDownload,
  MessageSquarePlus,
  PanelLeft,
  Pin,
  RefreshCw,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  api,
  type ApprovalDecision,
  type ApprovalPolicy,
  type BridgeStatus,
  type ChatMessage,
  type ConversationTelemetry,
  type ModelFamily,
  type PendingApproval,
  type PermissionTier,
  type ProjectItem,
  type SessionDetail,
  type SessionSummary,
} from '../api/client';
import { ManagedWebSocket, type WsState } from '../api/ws';
import { ModelEffortPicker } from '../components/ModelEffortPicker';
import { PixelPets } from '../components/PixelPets';
import { PrismHorizonCanvas } from '../components/PrismHorizonCanvas';
import { ApprovalCard } from '../plugins/builtins/ApprovalCard';
import { QuickToolbar } from '../plugins/builtins/QuickToolbar';
import { frontendPluginRegistry, renderPluginCard } from '../plugins/registry';
import {
  getAllCachedSessions,
  getCachedFingerprintMap,
  getCachedSession,
  putCachedSession,
  putCachedSessions,
  removeCachedSession,
} from '../storage/sessionCache';

interface ChatWorkbenchProps {
  permissionMode: PermissionTier;
  approvalPolicy: ApprovalPolicy;
  model: string;
  preventSleep: boolean;
  bridgeStatus: BridgeStatus | null;
  projects: ProjectItem[];
  boundProjectId: string;
  modelFamilies: ModelFamily[];
  modelsLoading: boolean;
  modelsError: string;
  modelPickerOpen: boolean;
  onSetModelPickerOpen: (open: boolean) => void;
  onRefreshModels: () => void;
  onDefaultModelChange: (modelId: string) => void;
  onCyclePermission: () => void;
  onCycleApprovalPolicy: () => void;
  onRefreshProjects: () => void;
  onPendingApprovalsChange: (approvals: PendingApproval[]) => void;
  onSwitchToDesktop: () => void;
  onOpenSettings: () => void;
  onToast: (msg: string) => void;
}

function CodeBlockPre(props: React.HTMLAttributes<HTMLPreElement>) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = preRef.current?.innerText || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore clipboard denial
    }
  };

  return (
    <div className="relative group my-2">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/10 hover:bg-white/20 text-[11px] text-slate-200 backdrop-blur"
        aria-label="复制代码"
      >
        {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
      <pre ref={preRef} {...props} />
    </div>
  );
}

function resolveDisplayLabel(families: ModelFamily[], modelId: string): string {
  const target = (modelId || '').trim();
  if (!target) return '';
  for (const fam of families) {
    if (fam.default_model_id === target && fam.efforts.length === 0 && fam.planners.length === 0) {
      return fam.display_name;
    }
    const eff = fam.efforts.find((e) => e.model_id === target);
    if (eff) return eff.display_name;
    const pl = fam.planners.find((p) => p.model_id === target);
    if (pl) return pl.display_name;
  }
  return target;
}

export function ChatWorkbench({
  permissionMode,
  approvalPolicy,
  model,
  preventSleep,
  bridgeStatus,
  projects,
  boundProjectId,
  modelFamilies,
  modelsLoading,
  modelsError,
  modelPickerOpen,
  onSetModelPickerOpen,
  onRefreshModels,
  onDefaultModelChange,
  onCyclePermission,
  onCycleApprovalPolicy,
  onRefreshProjects,
  onPendingApprovalsChange,
  onSwitchToDesktop,
  onOpenSettings,
  onToast,
}: ChatWorkbenchProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<SessionDetail | null>(null);
  const [telemetry, setTelemetry] = useState<ConversationTelemetry | null>(null);
  const [wsState, setWsState] = useState<WsState>('connecting');
  const [agentStatus, setAgentStatus] = useState<'idle' | 'thinking' | 'running' | 'error' | 'aborted'>('idle');
  const [prompt, setPrompt] = useState('');
  const [attachScreenshot, setAttachScreenshot] = useState(false);
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});
  const [syncingLocal, setSyncingLocal] = useState(false);
  const [syncSummary, setSyncSummary] = useState('');
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [dismissedBridgeBanner, setDismissedBridgeBanner] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  const wsRef = useRef<ManagedWebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDialogElement>(null);
  const lightboxRef = useRef<HTMLDialogElement>(null);
  const activeSessionIdRef = useRef<string>('');

  useEffect(() => {
    const dlg = lightboxRef.current;
    if (!dlg) return;
    if (lightbox && !dlg.open) {
      dlg.showModal();
    } else if (!lightbox && dlg.open) {
      dlg.close();
    }
  }, [lightbox]);

  useEffect(() => {
    const dlg = lightboxRef.current;
    if (!dlg) return;
    const onClose = () => setLightbox(null);
    dlg.addEventListener('close', onClose);

    // Mandatory fallback for browsers without <dialog closedby="any"> support
    let onFallbackClick: ((event: MouseEvent) => void) | null = null;
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      onFallbackClick = (event: MouseEvent) => {
        if (event.target !== dlg) return;
        const rect = dlg.getBoundingClientRect();
        const inside =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (!inside) dlg.close();
      };
      dlg.addEventListener('click', onFallbackClick);
    }
    return () => {
      dlg.removeEventListener('close', onClose);
      if (onFallbackClick) dlg.removeEventListener('click', onFallbackClick);
    };
  }, []);

  const markdownComponents = useMemo<Components>(
    () => ({
      pre: CodeBlockPre,
      img: ({ src, alt }) => {
        if (!src) return null;
        const label = alt || '图片';
        const isSticker = label.includes('agy-meme') || src.includes('agy-meme');
        return (
          <img
            src={src}
            alt={label}
            loading="lazy"
            onClick={() => setLightbox({ src, alt: label })}
            className={isSticker ? 'chat-sticker-img' : 'chat-media-img'}
          />
        );
      },
      a: ({ href, children }) => {
        if (!href) return <span>{children}</span>;
        if (href.startsWith('/api/media?')) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-0.5 my-0.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/35 text-sky-200 text-xs no-underline align-middle max-w-full"
            >
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate max-w-[220px]">{children}</span>
              <Download className="w-3 h-3 opacity-75 shrink-0" />
            </a>
          );
        }
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-300 underline underline-offset-2"
          >
            {children}
          </a>
        );
      },
    }),
    []
  );

  useEffect(() => {
    activeSessionIdRef.current = activeSession?.id || '';
  }, [activeSession?.id]);

  useEffect(() => {
    onPendingApprovalsChange(pendingApprovals);
  }, [pendingApprovals, onPendingApprovalsChange]);

  const toSummary = (d: SessionDetail): SessionSummary => ({
    id: d.id,
    title: d.title,
    agy_conversation_id: d.agy_conversation_id,
    project_id: d.project_id,
    workspace_dir: d.workspace_dir,
    permission_mode: d.permission_mode,
    model: d.model,
    active_model: d.active_model,
    app_status: d.app_status,
    created_at: d.created_at,
    updated_at: d.updated_at,
    message_count: d.messages.length,
    source: d.source,
    sync_fingerprint: d.sync_fingerprint,
    last_synced_at: d.last_synced_at,
    step_count: d.step_count,
  });

  const loadSessionDetail = async (id: string, summaryHint?: SessionSummary) => {
    const cached = await getCachedSession(id);
    if (cached) {
      setActiveSession(cached);
      if (
        summaryHint?.source === 'antigravity_local' &&
        summaryHint.sync_fingerprint &&
        cached.sync_fingerprint === summaryHint.sync_fingerprint &&
        summaryHint.app_status !== 'running'
      ) {
        setAgentStatus('idle');
        if (cached.agy_conversation_id) {
          api
            .getSessionTelemetry(id)
            .then((t) => setTelemetry(t.telemetry))
            .catch(() => {});
        } else {
          setTelemetry(null);
        }
        return;
      }
    }
    const res = await api.getSession(id);
    setActiveSession(res.session);
    setTelemetry(res.telemetry || null);
    setAgentStatus(res.running || res.session.app_status === 'running' ? 'running' : 'idle');
    await putCachedSession(res.session);
    setCachedIds((prev) => new Set(prev).add(res.session.id));
    if (res.running || res.session.app_status === 'running') {
      wsRef.current?.sendJson({ type: 'watch_session', session_id: res.session.id });
    }
  };

  const refreshSessions = async (selectId?: string) => {
    const res = await api.listSessions();
    setSessions(res.sessions);
    const targetId = selectId || activeSessionIdRef.current || res.sessions[0]?.id;
    if (targetId) {
      const hint = res.sessions.find((x) => x.id === targetId);
      await loadSessionDetail(targetId, hint);
    }
  };

  const syncLocalAntigravity = async (manual = false) => {
    if (syncingLocal) return;
    setSyncingLocal(true);
    try {
      const fpMap = await getCachedFingerprintMap();
      const alignRes = await api.alignLocalSessions(fpMap);
      const changed = alignRes.items.filter((x) => x.status !== 'up_to_date');

      if (changed.length > 0) {
        const pullRes = await api.pullLocalSessions(
          changed.map((x) => x.conversation_id),
          fpMap
        );
        await putCachedSessions(pullRes.synced_sessions);
        const updatedCacheSet = new Set(cachedIds);
        for (const s of pullRes.synced_sessions) updatedCacheSet.add(s.id);
        setCachedIds(updatedCacheSet);
        setSyncSummary(`已增量更新 ${pullRes.synced_sessions.length} 个桌面版会话并缓存`);
        if (manual) onToast(`已对齐并更新 ${pullRes.synced_sessions.length} 个本地反重力会话`);
      } else {
        setSyncSummary(`已对齐（${alignRes.counts.total} 个桌面会话全部最新）`);
        if (manual) onToast('全部本地会话已与手机缓存一致');
      }

      await refreshSessions();
    } catch {
      setSyncSummary('对齐本地反重力失败');
      if (manual) onToast('对齐本地反重力会话失败');
    } finally {
      setSyncingLocal(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await getAllCachedSessions();
      if (!cancelled && cached.length > 0) {
        cached.sort((a, b) => b.updated_at - a.updated_at);
        setCachedIds(new Set(cached.map((c) => c.id)));
        setSessions(cached.map(toSummary));
        setActiveSession(cached[0]);
      }
      if (!cancelled) {
        await syncLocalAntigravity(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const ws = new ManagedWebSocket({
      path: '/ws/chat',
      onState: (nextState) => {
        setWsState(nextState);
        if (nextState === 'open') {
          api
            .listPendingApprovals()
            .then((r) => setPendingApprovals(r.pending || []))
            .catch(() => {});
        }
      },
      onJson: (ev) => {
        const type = String(ev.type || '');

        if (type === 'pending_approvals') {
          const arr = (ev.approvals as PendingApproval[]) || [];
          setPendingApprovals(arr);
          return;
        }
        if (type === 'approval_request') {
          const apr = ev.approval as PendingApproval | undefined;
          if (!apr) return;
          setPendingApprovals((prev) => {
            const exists = prev.some((p) => p.approval_id === apr.approval_id);
            return exists ? prev : [apr, ...prev];
          });
          return;
        }
        if (type === 'approval_resolved') {
          const aid = String(ev.approval_id || '');
          setPendingApprovals((prev) => prev.filter((p) => p.approval_id !== aid));
          return;
        }
        if (type === 'active_model') {
          const convId = String(ev.conversation_id || '');
          const mName = String(ev.model_name || '');
          if (convId && mName) {
            setActiveSession((prev) =>
              prev && prev.agy_conversation_id === convId ? { ...prev, active_model: mName } : prev
            );
          }
          return;
        }
        if (type === 'session_synced') {
          const synced = ev.session as SessionDetail | undefined;
          const appStatus = String(ev.app_status || synced?.app_status || 'idle');
          const tel = (ev.telemetry as ConversationTelemetry | null | undefined) || null;
          if (!synced) return;

          putCachedSession(synced).catch(() => {});
          setCachedIds((prev) => new Set(prev).add(synced.id));

          setSessions((prev) => {
            const sum = toSummary(synced);
            const idx = prev.findIndex((x) => x.id === synced.id);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = sum;
              return copy;
            }
            return [sum, ...prev];
          });

          if (synced.id === activeSessionIdRef.current) {
            setActiveSession(synced);
            if (tel) setTelemetry(tel);
            setAgentStatus(appStatus === 'running' ? 'running' : 'idle');
          }
          return;
        }

        const sid = String(ev.session_id || '');
        const mid = String(ev.message_id || '');
        if (!sid || sid !== activeSessionIdRef.current) return;

        if (type === 'run_start') {
          setAgentStatus('running');
          setActiveSession((prev) => {
            if (!prev) return prev;
            const exists = prev.messages.some((m) => m.id === mid);
            if (exists) return prev;
            const nextMsg: ChatMessage = {
              id: mid,
              role: 'assistant',
              content: '',
              thought: '',
              cards: [],
              timestamp: Date.now() / 1000,
              status: 'streaming',
            };
            return { ...prev, messages: [...prev.messages, nextMsg] };
          });
        } else if (type === 'card_emit') {
          const card = ev.card as ChatMessage['cards'][number];
          if (!card) return;
          setActiveSession((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              messages: prev.messages.map((m) => {
                if (m.id !== mid) return m;
                const idx = m.cards.findIndex((c) => c.id === card.id);
                const nextCards = [...m.cards];
                if (idx >= 0) nextCards[idx] = card;
                else nextCards.push(card);
                return { ...m, cards: nextCards };
              }),
            };
          });
        } else if (type === 'run_error') {
          setAgentStatus('error');
          const msg = String(ev.message || '执行失败');
          setActiveSession((prev) =>
            prev
              ? {
                  ...prev,
                  messages: prev.messages.map((m) =>
                    m.id === mid ? { ...m, content: m.content || `执行出错：${msg}`, status: 'error' } : m
                  ),
                }
              : prev
          );
        } else if (type === 'run_done') {
          const finalSt = String(ev.status || 'done') as ChatMessage['status'];
          setAgentStatus(finalSt === 'error' ? 'error' : finalSt === 'aborted' ? 'aborted' : 'idle');
          setActiveSession((prev) => {
            if (!prev) return prev;
            const nextSession: SessionDetail = {
              ...prev,
              messages: prev.messages.map((m) => (m.id === mid ? { ...m, status: finalSt } : m)),
            };
            putCachedSession(nextSession).catch(() => {});
            return nextSession;
          });
          api.listSessions().then((r) => setSessions(r.sessions)).catch(() => {});
        }
      },
    });
    ws.connect();
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || showJumpBottom) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [activeSession?.messages, showJumpBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJumpBottom(distanceFromBottom > 140);
  };

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    setShowJumpBottom(false);
  };

  const effectiveModelId = useMemo(() => {
    if (activeSession?.agy_conversation_id) {
      return activeSession.active_model || activeSession.model || model;
    }
    return activeSession?.model || model;
  }, [activeSession, model]);

  const effectiveModelLabel = useMemo(
    () => resolveDisplayLabel(modelFamilies, effectiveModelId) || effectiveModelId || '选择模型',
    [modelFamilies, effectiveModelId]
  );

  const activeProjectName = useMemo(() => {
    const pid = activeSession?.project_id || boundProjectId;
    const match = projects.find((p) => p.id === pid);
    return match?.name || '';
  }, [projects, activeSession?.project_id, boundProjectId]);

  const handleSend = () => {
    const trimmed = prompt.trim();
    if (!trimmed || !activeSession || agentStatus === 'running' || agentStatus === 'thinking') return;
    const sent = wsRef.current?.sendJson({
      type: 'send_prompt',
      session_id: activeSession.id,
      prompt: trimmed,
      model: effectiveModelId,
      project_id: activeSession.project_id || boundProjectId,
      attach_screenshot: attachScreenshot,
    });
    if (!sent) {
      onToast('WebSocket 尚未连上，请稍候重试');
      return;
    }
    const localUserMsg: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: trimmed,
      thought: '',
      cards: [],
      timestamp: Date.now() / 1000,
      status: 'done',
    };
    setActiveSession((prev) => (prev ? { ...prev, messages: [...prev.messages, localUserMsg] } : prev));
    setAgentStatus('running');
    setPrompt('');
    setAttachScreenshot(false);
    setShowJumpBottom(false);
  };

  const handleAbort = () => {
    if (!activeSession) return;
    wsRef.current?.sendJson({ type: 'abort', session_id: activeSession.id });
    setAgentStatus('idle');
    onToast('已停止手机端监听（如需强行中断桌面生成，请去 Tab 2 点 Esc 急停）');
  };

  const handleCreateSession = async (project?: ProjectItem) => {
    const targetPid = project?.id || boundProjectId;
    const res = await api.createSession({
      permission_mode: permissionMode,
      project_id: targetPid,
      workspace_dir: project?.primary_folder || undefined,
      model: model || undefined,
    });
    await refreshSessions(res.session.id);
    drawerRef.current?.close();
  };

  const handleSetDefaultProject = async (project: ProjectItem) => {
    try {
      await api.setDefaultProject(project.id);
      onRefreshProjects();
      onToast(`已设「${project.name}」为新建对话默认项目（重启桌面版后完全生效）`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : '设置默认项目失败');
    }
  };

  const handleForkWithModel = async (newModelId: string) => {
    if (!activeSession) return;
    try {
      const res = await api.forkSessionWithModel(activeSession.id, newModelId, prompt.trim());
      if (prompt.trim()) setPrompt('');
      await refreshSessions(res.session.id);
      onToast(`已使用 ${resolveDisplayLabel(modelFamilies, newModelId)} 在同项目新开续聊`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : '新开续聊失败');
    }
  };

  const handleConfirmModelForNew = async (newModelId: string) => {
    onDefaultModelChange(newModelId);
    if (activeSession && !activeSession.agy_conversation_id) {
      try {
        const res = await api.patchSession(activeSession.id, { model: newModelId, active_model: newModelId });
        setActiveSession(res.session);
      } catch {
        // ignore
      }
    }
    onToast(`已选择 ${resolveDisplayLabel(modelFamilies, newModelId)}`);
  };

  const handleDeleteSession = async (id: string) => {
    try {
      await api.deleteSession(id);
      await removeCachedSession(id);
      setCachedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await refreshSessions();
    } catch (err) {
      onToast(err instanceof Error ? err.message : '无法删除会话');
    }
  };

  const handleApprovalDecision = async (approvalId: string, decision: ApprovalDecision) => {
    try {
      await api.decideApproval(approvalId, decision);
      setPendingApprovals((prev) => prev.filter((p) => p.approval_id !== approvalId));
      onToast(
        decision === 'auto_approve'
          ? '已发送允许执行指令'
          : decision === 'deny'
            ? '已拒绝该工具执行'
            : '已转交电脑桌面端确认'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : '审批操作失败');
    }
  };

  const handlePluginAction = async (pluginId: string, actionId: string, data?: Record<string, unknown>) => {
    try {
      const res = await api.dispatchPluginAction(pluginId, actionId, data || {});
      if (res.emit_card && activeSession) {
        const card = res.emit_card as ChatMessage['cards'][number];
        const sysMsg: ChatMessage = {
          id: `sys-${Date.now()}`,
          role: 'assistant',
          content: '',
          thought: '',
          cards: [card],
          timestamp: Date.now() / 1000,
          status: 'done',
        };
        setActiveSession((prev) => (prev ? { ...prev, messages: [...prev.messages, sysMsg] } : prev));
      } else if (actionId === 'system.refresh' && res.data && activeSession) {
        setActiveSession((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            messages: prev.messages.map((m) => ({
              ...m,
              cards: m.cards.map((c) =>
                c.cardType === 'core.system-mini' ? { ...c, data: res.data as Record<string, unknown> } : c
              ),
            })),
          };
        });
      }
    } catch {
      onToast('插件动作执行失败');
    }
  };

  const groupedSessions = useMemo(() => {
    const knownProjectIds = new Set(projects.map((p) => p.id));
    const byProject = new Map<string, SessionSummary[]>();
    for (const p of projects) byProject.set(p.id, []);
    const outside: SessionSummary[] = [];

    for (const s of sessions) {
      const pid = (s.project_id || '').trim();
      if (pid && knownProjectIds.has(pid)) {
        byProject.get(pid)!.push(s);
      } else {
        outside.push(s);
      }
    }
    return { byProject, outside };
  }, [projects, sessions]);

  const CapsuleSlot = useMemo(() => frontendPluginRegistry.getCapsuleComponent(), []);
  const isBusy = agentStatus === 'thinking' || agentStatus === 'running';
  const isExistingConv = Boolean(activeSession?.agy_conversation_id);

  return (
    <div className="flex-1 min-h-0 flex flex-col relative overflow-hidden">
      <PrismHorizonCanvas status={agentStatus} awaitingApproval={pendingApprovals.length > 0} />

      {/* Compact Session Strip */}
      <div className="relative z-10 px-3 py-1.5 flex items-center justify-between gap-2 border-b border-white/10 text-xs">
        <button
          type="button"
          onClick={() => drawerRef.current?.showModal()}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl glass-panel hover:bg-white/10 min-w-0 max-w-[65%]"
        >
          <PanelLeft className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <span className="truncate font-medium">{activeSession?.title || '主工作台'}</span>
          {activeProjectName && (
            <span className="hidden sm:inline px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 text-[10px] shrink-0">
              {activeProjectName}
            </span>
          )}
        </button>

        <div className="flex items-center gap-2 shrink-0">
          <span className="hidden md:inline-flex items-center gap-1 opacity-65 max-w-[180px] truncate">
            <FolderGit2 className="w-3.5 h-3.5" />
            <span className="truncate">{activeSession?.workspace_dir || ''}</span>
          </span>
          <span
            className={`w-2 h-2 rounded-full ${wsState === 'open' ? 'bg-emerald-400' : 'bg-amber-400'}`}
            title={wsState === 'open' ? '实时通道已连接' : '重连中'}
          />
          <button
            type="button"
            onClick={() => handleCreateSession()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl glass-panel hover:bg-white/10"
            aria-label="新建会话"
          >
            <MessageSquarePlus className="w-3.5 h-3.5 text-sky-400" />
            <span className="hidden sm:inline">新对话</span>
          </button>
        </div>
      </div>

      {/* Bridge Restart Hint Banner */}
      {bridgeStatus && !bridgeStatus.sidecar_running && !dismissedBridgeBanner && (
        <div className="relative z-10 mx-3 mt-2 rounded-2xl bg-amber-500/15 border border-amber-400/35 px-3 py-2 text-xs flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0" />
            <span className="truncate">
              {bridgeStatus.needs_app_restart
                ? '官方联动插件已启用，请重启一次电脑端 Antigravity 桌面版以激活发消息与审批联动'
                : bridgeStatus.detail || '桌面版联动 Sidecar 尚未启动'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setDismissedBridgeBanner(true)}
            className="p-1 rounded-lg hover:bg-white/10 shrink-0"
            aria-label="关闭提示"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Live Remote Tool Approvals Floating Stack */}
      {pendingApprovals.length > 0 && (
        <div className="relative z-10 px-3 pt-2 space-y-2 max-h-60 overflow-y-auto obsidian-scroll border-b border-amber-400/20 bg-amber-950/20">
          {pendingApprovals.map((apr) => (
            <ApprovalCard
              key={apr.approval_id}
              payload={{
                cardType: 'core.approval',
                id: apr.approval_id,
                data: {
                  approval_id: apr.approval_id,
                  tool_name: apr.tool_name,
                  summary: apr.summary,
                  detail: apr.detail,
                  model_name: apr.model_name,
                  expires_at: apr.expires_at,
                },
              }}
              onAction={(_pid, _aid, d) => {
                const dec = (d?.decision as ApprovalDecision) || 'allow';
                handleApprovalDecision(apr.approval_id, dec);
              }}
            />
          ))}
        </div>
      )}

      {/* Message Stream */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative z-10 flex-1 min-h-0 overflow-y-auto obsidian-scroll chat-stream"
      >
        {(!activeSession || activeSession.messages.length === 0) && (
          <div className="max-w-lg mx-auto my-8 glass-panel prism-border rounded-3xl p-5 space-y-3 text-center">
            <div className="text-base font-semibold">桌面版 Antigravity 口袋联动已就绪</div>
            <p className="text-xs opacity-75 leading-relaxed">
              新发送的指令将直接同步进电脑桌面版 Antigravity 窗口，点击底部胶囊的{' '}
              <span className="text-sky-300 font-medium">{effectiveModelLabel}</span>{' '}
              即可自由点选账号真实模型与思考强度滑条。
            </p>
            <div className="flex flex-wrap justify-center gap-2 pt-1 text-xs">
              {['检查当前项目最近改动并汇报', '运行项目测试确认状态', '/plan 设计一个新功能'].map((sample) => (
                <button
                  key={sample}
                  type="button"
                  onClick={() => setPrompt(sample)}
                  className="px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 transition"
                >
                  {sample}
                </button>
              ))}
            </div>
          </div>
        )}

        {activeSession?.messages.map((msg) => {
          if (msg.role === 'user') {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="chat-bubble-user rounded-2xl rounded-tr-sm bg-gradient-to-br from-sky-500/25 to-indigo-500/25 border border-sky-400/30 agy-prose">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </div>
            );
          }

          const thoughtOpen = !!expandedThoughts[msg.id];
          return (
            <div key={msg.id} className="max-w-3xl mx-auto w-full space-y-1.5">
              {msg.thought && (
                <div className="glass-panel rounded-xl px-2.5 py-1.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setExpandedThoughts((p) => ({ ...p, [msg.id]: !p[msg.id] }))}
                    className="w-full flex items-center gap-1.5 opacity-80 hover:opacity-100 text-left"
                  >
                    {thoughtOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    <span>思考与执行细节</span>
                  </button>
                  {thoughtOpen && (
                    <pre className="mt-1.5 pt-1.5 border-t border-white/10 font-mono text-[11px] opacity-75 whitespace-pre-wrap break-words max-h-56 overflow-y-auto obsidian-scroll">
                      {msg.thought}
                    </pre>
                  )}
                </div>
              )}

              {msg.cards?.map((card) => renderPluginCard(card, handlePluginAction))}

              {(msg.content || msg.status === 'streaming') && (
                <div className="glass-panel chat-bubble-ai rounded-2xl rounded-tl-sm agy-prose">
                  {msg.content ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight]}
                      components={markdownComponents}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  ) : (
                    <div className="flex items-center gap-2 text-xs opacity-70">
                      <span className="inline-block w-2 h-2 rounded-full bg-sky-400 prism-pulse" />
                      <span>桌面版 Antigravity 正在处理并回传步骤...</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showJumpBottom && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute right-4 bottom-40 z-20 w-10 h-10 rounded-full glass-elevated prism-border flex items-center justify-center shadow-lg"
          aria-label="滚动到最新消息"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}

      {/* Sticky Bottom Composer + Capsule Slot + Pixel Pets */}
      <div className="relative z-20 px-3 pt-1.5 pb-[calc(0.65rem+env(safe-area-inset-bottom))] space-y-2 glass-panel">
        <PixelPets busy={isBusy} awaitingApproval={pendingApprovals.length > 0} />
        <div
          className="prism-rainbow-rail -mx-3 -mt-1.5 mb-1.5"
          data-busy={isBusy ? 'true' : 'false'}
          aria-hidden="true"
        />
        <QuickToolbar
          attachScreenshot={attachScreenshot}
          onToggleScreenshot={() => setAttachScreenshot((v) => !v)}
          onInsertCommand={(text) => setPrompt((prev) => (prev ? `${prev} ${text}` : text))}
          onSnapshotSystemCard={() => handlePluginAction('core.toolbar', 'system.snapshot_card')}
        />

        {CapsuleSlot && (
          <CapsuleSlot
            model={effectiveModelId}
            modelDisplayLabel={effectiveModelLabel}
            permissionMode={permissionMode}
            approvalPolicy={approvalPolicy}
            bridgeStatus={bridgeStatus}
            telemetry={telemetry}
            agentStatus={agentStatus}
            preventSleep={preventSleep}
            onCyclePermission={onCyclePermission}
            onCycleApprovalPolicy={onCycleApprovalPolicy}
            onAbort={handleAbort}
            onOpenSettings={onOpenSettings}
            onOpenModelPicker={() => onSetModelPickerOpen(true)}
          />
        )}

        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && window.innerWidth >= 768) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="输入指令同步发送到远程桌面版 Antigravity..."
            className="flex-1 min-h-[46px] max-h-36 rounded-2xl bg-black/25 border border-white/15 px-3.5 py-2.5 text-sm resize-none focus:outline-none focus:border-sky-400 obsidian-scroll"
          />
          {isBusy ? (
            <button
              type="button"
              onClick={handleAbort}
              className="w-12 h-[46px] shrink-0 rounded-2xl bg-rose-500/30 border border-rose-400/50 text-rose-100 flex items-center justify-center active:scale-95 transition"
              aria-label="停止监听"
            >
              <Square className="w-4 h-4 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!prompt.trim()}
              className="w-12 h-[46px] shrink-0 rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-500 text-white flex items-center justify-center disabled:opacity-40 active:scale-95 transition shadow-md shadow-sky-500/20"
              aria-label="发送指令"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* IDE Model & Thinking Effort Picker Modal */}
      <ModelEffortPicker
        open={modelPickerOpen}
        onClose={() => onSetModelPickerOpen(false)}
        families={modelFamilies}
        loading={modelsLoading}
        error={modelsError}
        currentModelId={effectiveModelId}
        isExistingConversation={isExistingConv}
        onRefresh={onRefreshModels}
        onConfirmNewModel={handleConfirmModelForNew}
        onForkWithModel={handleForkWithModel}
        onSwitchToDesktop={onSwitchToDesktop}
      />

      {/* Project-Grouped Session History Drawer */}
      <dialog
        ref={drawerRef}
        aria-labelledby="session-drawer-title"
        onClick={(e) => {
          if (e.target === drawerRef.current) drawerRef.current?.close();
        }}
        className="w-[min(23rem,90dvw)] h-[100dvh] rounded-r-3xl"
      >
        <div className="h-full glass-elevated border-r border-white/15 flex flex-col p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 id="session-drawer-title" className="text-base font-bold">
              共享项目与会话
            </h2>
            <button
              type="button"
              onClick={() => drawerRef.current?.close()}
              className="w-10 h-10 rounded-xl hover:bg-white/10 flex items-center justify-center"
              aria-label="关闭会话列表"
              autoFocus
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => handleCreateSession()}
              className="min-h-[42px] rounded-xl bg-sky-500/20 border border-sky-400/40 text-sky-200 font-medium text-xs flex items-center justify-center gap-1.5"
            >
              <MessageSquarePlus className="w-4 h-4" />
              <span>新建对话</span>
            </button>
            <button
              type="button"
              onClick={() => syncLocalAntigravity(true)}
              disabled={syncingLocal}
              className="min-h-[42px] rounded-xl bg-emerald-500/20 border border-emerald-400/40 text-emerald-200 font-medium text-xs flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncingLocal ? 'animate-spin' : ''}`} />
              <span>{syncingLocal ? '对齐中...' : '对齐桌面会话'}</span>
            </button>
          </div>

          {syncSummary && (
            <div className="rounded-xl bg-white/5 border border-white/10 px-2.5 py-1.5 text-[11px] opacity-80 flex items-center gap-1.5">
              <HardDriveDownload className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate">{syncSummary}</span>
            </div>
          )}

          <div className="flex-1 overflow-y-auto obsidian-scroll space-y-4">
            {projects.map((proj) => {
              const list = groupedSessions.byProject.get(proj.id) || [];
              return (
                <div key={proj.id} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-1.5 px-1">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-semibold text-xs text-sky-200 truncate">
                        <FolderOpen className="w-3.5 h-3.5 shrink-0 text-sky-400" />
                        <span className="truncate">{proj.name}</span>
                        {proj.is_bound && (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px]">
                            默认新建
                          </span>
                        )}
                      </div>
                      {proj.primary_folder && (
                        <div className="text-[10px] opacity-55 font-mono truncate">{proj.primary_folder}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {!proj.is_bound && (
                        <button
                          type="button"
                          onClick={() => handleSetDefaultProject(proj)}
                          className="p-1.5 rounded-lg hover:bg-white/10 opacity-70 hover:opacity-100"
                          title="设为 Sidecar 默认新建项目"
                        >
                          <Pin className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleCreateSession(proj)}
                        className="p-1.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 text-sky-300"
                        title="在此项目新建对话"
                      >
                        <MessageSquarePlus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {list.length === 0 ? (
                    <div className="text-[11px] opacity-50 px-2 py-1">暂无会话</div>
                  ) : (
                    list.map((s) => {
                      const selected = s.id === activeSession?.id;
                      const isCached = cachedIds.has(s.id);
                      const mLabel = resolveDisplayLabel(modelFamilies, s.active_model || s.model);
                      return (
                        <div
                          key={s.id}
                          className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-xs border transition ${
                            selected ? 'bg-sky-500/20 border-sky-400/40' : 'bg-white/5 border-transparent hover:bg-white/10'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={async () => {
                              await loadSessionDetail(s.id, s);
                              drawerRef.current?.close();
                            }}
                            className="flex-1 min-w-0 text-left space-y-1"
                          >
                            <div className="font-medium truncate text-sm">{s.title}</div>
                            <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                              {s.app_status === 'running' && (
                                <span className="px-1.5 py-0.5 rounded bg-sky-500/25 text-sky-200">运行中</span>
                              )}
                              {mLabel && (
                                <span className="px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-200 truncate max-w-[140px]">
                                  {mLabel}
                                </span>
                              )}
                              {isCached && (
                                <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200">已缓存</span>
                              )}
                              <span className="opacity-60">{s.message_count} 条</span>
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteSession(s.id)}
                            className="w-8 h-8 rounded-lg hover:bg-rose-500/20 text-rose-300 flex items-center justify-center shrink-0"
                            aria-label="删除会话"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })}

            {groupedSessions.outside.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-semibold opacity-65 px-1">项目外对话 / 待发送</div>
                {groupedSessions.outside.map((s) => {
                  const selected = s.id === activeSession?.id;
                  const isLocal = s.source === 'antigravity_local';
                  const isCached = cachedIds.has(s.id);
                  return (
                    <div
                      key={s.id}
                      className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-xs border transition ${
                        selected ? 'bg-sky-500/20 border-sky-400/40' : 'bg-white/5 border-transparent hover:bg-white/10'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={async () => {
                          await loadSessionDetail(s.id, s);
                          drawerRef.current?.close();
                        }}
                        className="flex-1 min-w-0 text-left space-y-1"
                      >
                        <div className="font-medium truncate text-sm">{s.title}</div>
                        <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                          <span
                            className={`px-1.5 py-0.5 rounded ${
                              isLocal ? 'bg-violet-500/25 text-violet-200' : 'bg-sky-500/20 text-sky-200'
                            }`}
                          >
                            {isLocal ? '桌面版' : '手机新建'}
                          </span>
                          {isCached && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200">已缓存</span>
                          )}
                          <span className="opacity-60">{s.message_count} 条</span>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSession(s.id)}
                        className="w-8 h-8 rounded-lg hover:bg-rose-500/20 text-rose-300 flex items-center justify-center shrink-0"
                        aria-label="删除会话"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </dialog>

      {/* Native Top-Layer Lightbox Dialog for Images & Stickers */}
      <dialog
        ref={lightboxRef}
        aria-label={lightbox?.alt || '图片预览'}
        {...({ closedby: 'any' } as Record<string, string>)}
        className="m-auto max-w-[96dvw] max-h-[92dvh] rounded-2xl overflow-visible"
      >
        {lightbox && (
          <div className="relative glass-elevated prism-border rounded-2xl p-2 flex flex-col items-center gap-2 max-w-[96dvw] max-h-[92dvh]">
            <div className="w-full flex items-center justify-between gap-2 px-1">
              <span className="text-xs opacity-80 truncate">{lightbox.alt}</span>
              <div className="flex items-center gap-1.5 shrink-0">
                <a
                  href={
                    lightbox.src.startsWith('/api/media?') && !lightbox.src.includes('download=1')
                      ? `${lightbox.src}&download=1`
                      : lightbox.src
                  }
                  download
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-sky-500/20 border border-sky-400/40 text-sky-100 text-xs"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>原图</span>
                </a>
                <button
                  type="button"
                  onClick={() => lightboxRef.current?.close()}
                  className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center"
                  aria-label="关闭大图预览"
                  autoFocus
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <img
              src={lightbox.src}
              alt={lightbox.alt}
              className="max-w-[92dvw] max-h-[78dvh] object-contain rounded-xl bg-black/40"
            />
          </div>
        )}
      </dialog>
    </div>
  );
}
