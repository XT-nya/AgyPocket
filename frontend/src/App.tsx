import { useCallback, useEffect, useState } from 'react';
import { MessageSquareCode, MonitorSmartphone, Settings2, ShieldAlert } from 'lucide-react';
import {
  api,
  type ApprovalPolicy,
  type AuthStatus,
  type BridgeStatus,
  type ModelFamily,
  type PendingApproval,
  type PermissionSpec,
  type PermissionTier,
  type ProjectItem,
  type SettingsData,
} from './api/client';
import { ChatWorkbench } from './pages/ChatWorkbench';
import { DesktopRemote } from './pages/DesktopRemote';
import { LockScreen } from './pages/LockScreen';
import { SettingsDrawer, type ThemeChoice } from './pages/SettingsDrawer';
import { UserManualModal } from './components/UserManualModal';
import {
  applyDisplayPrefs,
  loadDisplayPrefs,
  saveDisplayPrefs,
  type DisplayPrefs,
} from './utils/displayPrefs';
import { loadRemotePrefs, saveRemotePrefs, type RemotePrefs } from './utils/remotePrefs';

const PERM_CYCLE: PermissionTier[] = ['auto', 'full', 'controlled', 'readonly'];
const APPROVAL_CYCLE: ApprovalPolicy[] = ['remote_smart', 'remote_all', 'desktop_only'];
const APPROVAL_LABELS: Record<ApprovalPolicy, string> = {
  remote_smart: '手机智能审批',
  remote_all: '手机全量审批',
  desktop_only: '仅电脑端审批',
};

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function readInitialTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem('agypocket-color-scheme');
    if (saved === 'light' || saved === 'dark' || saved === 'light dark') return saved;
  } catch {
    // ignore storage restriction
  }
  return 'dark';
}

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [permissionSpecs, setPermissionSpecs] = useState<PermissionSpec[]>([]);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [boundProjectId, setBoundProjectId] = useState<string>('');
  const [modelFamilies, setModelFamilies] = useState<ModelFamily[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);

  const [activeTab, setActiveTab] = useState<'chat' | 'desktop'>('chat');
  const [desktopFullscreen, setDesktopFullscreen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(readInitialTheme);
  const [displayPrefs, setDisplayPrefs] = useState<DisplayPrefs>(loadDisplayPrefs);
  const [remotePrefs, setRemotePrefs] = useState<RemotePrefs>(loadRemotePrefs);
  const [toast, setToast] = useState('');
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    applyDisplayPrefs(displayPrefs);
  }, [displayPrefs]);

  const handleChangeDisplayPrefs = useCallback((next: DisplayPrefs) => {
    setDisplayPrefs(next);
    saveDisplayPrefs(next);
    applyDisplayPrefs(next);
  }, []);

  const handleChangeRemotePrefs = useCallback((next: RemotePrefs) => {
    setRemotePrefs(next);
    saveRemotePrefs(next);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
  }, []);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      showToast('AgyPocket 已成功添加到桌面');
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [showToast]);

  const handleInstallPwa = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      setInstallPrompt(null);
    }
  };

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  const applyTheme = useCallback((next: ThemeChoice) => {
    setTheme(next);
    try {
      localStorage.setItem('agypocket-color-scheme', next);
    } catch {
      // ignore
    }
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', next);
    document.documentElement.dataset.theme = next === 'light' ? 'light' : next === 'dark' ? 'dark' : 'system';
  }, []);

  const fetchModels = useCallback(async (force = false) => {
    setModelsLoading(true);
    try {
      const cat = await api.listModels(force);
      setModelFamilies(cat.families || []);
      setModelsError(cat.error || '');
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : '拉取模型清单失败');
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const refreshBridge = useCallback(async () => {
    try {
      const b = await api.getBridgeStatus();
      setBridgeStatus(b);
    } catch {
      // ignore
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const p = await api.listProjects();
      setProjects(p.projects || []);
      setBoundProjectId(p.bound_project_id || '');
    } catch {
      // ignore
    }
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const st = await api.authStatus();
      setAuth(st);
      if (st.authenticated) {
        const cfg = await api.getSettings();
        setSettings(cfg.settings);
        setPermissionSpecs(cfg.permission_tiers);
        setBridgeStatus(cfg.bridge || null);
        setProjects(cfg.projects?.projects || []);
        setBoundProjectId(cfg.projects?.bound_project_id || '');
        fetchModels(false);
      }
    } catch {
      // keep retrying or display error state
    }
  }, [fetchModels]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const handleCyclePermission = async () => {
    if (!settings) return;
    const idx = PERM_CYCLE.indexOf(settings.default_permission_mode);
    const nextTier = PERM_CYCLE[(idx + 1) % PERM_CYCLE.length];
    try {
      const res = await api.updateSettings({ default_permission_mode: nextTier });
      setSettings(res.settings);
      const label = permissionSpecs.find((p) => p.id === nextTier)?.short_label || nextTier;
      showToast(`已切换权限为「${label}」`);
    } catch {
      showToast('切换权限失败');
    }
  };

  const handleCycleApprovalPolicy = async () => {
    if (!settings) return;
    const cur = settings.approval_policy || 'remote_smart';
    const idx = APPROVAL_CYCLE.indexOf(cur);
    const nextPol = APPROVAL_CYCLE[(idx + 1) % APPROVAL_CYCLE.length];
    try {
      const res = await api.updateSettings({ approval_policy: nextPol });
      setSettings(res.settings);
      showToast(`审批策略: ${APPROVAL_LABELS[nextPol]}`);
    } catch {
      showToast('切换审批策略失败');
    }
  };

  const handleDefaultModelChange = async (modelId: string) => {
    try {
      const res = await api.updateSettings({ model: modelId });
      setSettings(res.settings);
    } catch {
      showToast('保存默认模型失败');
    }
  };

  const resolveModelDisplay = (modelId: string) => {
    for (const fam of modelFamilies) {
      if (fam.default_model_id === modelId && fam.efforts.length === 0 && fam.planners.length === 0) {
        return fam.display_name;
      }
      const eff = fam.efforts.find((e) => e.model_id === modelId);
      if (eff) return eff.display_name;
      const pl = fam.planners.find((p) => p.model_id === modelId);
      if (pl) return pl.display_name;
    }
    return modelId;
  };

  if (!auth) {
    return (
      <div className="h-[100dvh] obsidian-bg flex items-center justify-center text-sm opacity-75">
        正在连接 AgyPocket...
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <>
        <LockScreen status={auth} onUnlocked={refreshAll} onOpenManual={() => setManualOpen(true)} />
        <UserManualModal open={manualOpen} onClose={() => setManualOpen(false)} />
      </>
    );
  }

  const isRemoteFullscreen = activeTab === 'desktop' && desktopFullscreen;

  return (
    <div className="h-[100dvh] obsidian-bg flex flex-col overflow-hidden">
      {/* Top Navigation Bar (hidden during DesktopRemote fullscreen) */}
      {!isRemoteFullscreen && (
        <header className="px-3 pt-[max(0.35rem,env(safe-area-inset-top))] pb-1.5 border-b border-white/10 glass-panel flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-sky-500/35 to-violet-500/35 border border-white/15 flex items-center justify-center font-bold text-xs text-sky-200">
              A
            </div>
            <span className="font-bold text-sm tracking-tight hidden sm:inline">AgyPocket</span>
          </div>

          {/* Tab Switcher */}
          <nav className="flex items-center p-0.5 rounded-2xl bg-black/25 border border-white/10" aria-label="主界面切换">
            <button
              type="button"
              onClick={() => {
                setDesktopFullscreen(false);
                setActiveTab('chat');
              }}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 transition relative ${
                activeTab === 'chat' ? 'bg-sky-500/25 text-sky-200 shadow-sm' : 'opacity-70 hover:opacity-100'
              }`}
            >
              <MessageSquareCode className="w-3.5 h-3.5" />
              <span>反重力工作台</span>
              {pendingApprovals.length > 0 && activeTab !== 'chat' && (
                <span className="ml-0.5 px-1.5 py-0.2 rounded-full bg-amber-500 text-black font-bold text-[10px]">
                  {pendingApprovals.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('desktop')}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 transition ${
                activeTab === 'desktop' ? 'bg-violet-500/25 text-violet-200 shadow-sm' : 'opacity-70 hover:opacity-100'
              }`}
            >
              <MonitorSmartphone className="w-3.5 h-3.5" />
              <span>电脑遥控</span>
            </button>
          </nav>

          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="w-9 h-9 rounded-xl glass-panel hover:bg-white/10 flex items-center justify-center"
            aria-label="打开设置"
          >
            <Settings2 className="w-4 h-4" />
          </button>
        </header>
      )}

      {/* Cross-Tab Approval Alert Banner when user is on Tab 2 (non-fullscreen) */}
      {activeTab === 'desktop' && !desktopFullscreen && pendingApprovals.length > 0 && (
        <div className="px-3 py-1.5 bg-amber-500/20 border-b border-amber-400/40 flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldAlert className="w-4 h-4 text-amber-300 shrink-0" />
            <span className="truncate font-medium">
              桌面版有 {pendingApprovals.length} 项工具操作等待你审批：{pendingApprovals[0].summary}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setDesktopFullscreen(false);
              setActiveTab('chat');
            }}
            className="px-3 py-1 rounded-xl bg-amber-400 text-black font-semibold shrink-0"
          >
            去审批
          </button>
        </div>
      )}

      {/* Main Content (Keep ChatWorkbench mounted so WS & approvals stay live across tabs) */}
      <main className="flex-1 min-h-0 flex flex-col">
        <div className={activeTab === 'chat' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <ChatWorkbench
            permissionMode={settings?.default_permission_mode || 'auto'}
            approvalPolicy={settings?.approval_policy || 'remote_smart'}
            model={settings?.model || ''}
            preventSleep={settings?.prevent_sleep ?? true}
            bridgeStatus={bridgeStatus}
            projects={projects}
            boundProjectId={boundProjectId}
            modelFamilies={modelFamilies}
            modelsLoading={modelsLoading}
            modelsError={modelsError}
            modelPickerOpen={modelPickerOpen}
            onSetModelPickerOpen={setModelPickerOpen}
            onRefreshModels={() => fetchModels(true)}
            onDefaultModelChange={handleDefaultModelChange}
            onCyclePermission={handleCyclePermission}
            onCycleApprovalPolicy={handleCycleApprovalPolicy}
            onRefreshProjects={refreshProjects}
            onPendingApprovalsChange={setPendingApprovals}
            onSwitchToDesktop={() => setActiveTab('desktop')}
            onOpenSettings={() => setSettingsOpen(true)}
            onToast={showToast}
          />
        </div>
        {activeTab === 'desktop' && (
          <DesktopRemote
            fullscreen={desktopFullscreen}
            remotePrefs={remotePrefs}
            onFullscreenChange={setDesktopFullscreen}
            onToast={showToast}
          />
        )}
      </main>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        permissionSpecs={permissionSpecs}
        bridgeStatus={bridgeStatus}
        modelDisplayLabel={resolveModelDisplay(settings?.model || '')}
        totpEnabled={auth.totp_enabled}
        theme={theme}
        displayPrefs={displayPrefs}
        remotePrefs={remotePrefs}
        canInstallPwa={Boolean(installPrompt)}
        onInstallPwa={handleInstallPwa}
        onChangeTheme={applyTheme}
        onChangeDisplayPrefs={handleChangeDisplayPrefs}
        onChangeRemotePrefs={handleChangeRemotePrefs}
        onSettingsUpdated={setSettings}
        onRefreshBridge={refreshBridge}
        onOpenModelPicker={() => {
          setDesktopFullscreen(false);
          setActiveTab('chat');
          setModelPickerOpen(true);
        }}
        onOpenManual={() => setManualOpen(true)}
        onAuthChanged={refreshAll}
        onToast={showToast}
      />

      <UserManualModal open={manualOpen} onClose={() => setManualOpen(false)} />

      {toast && (
        <div
          role="status"
          className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full glass-elevated prism-border text-xs font-medium shadow-xl pointer-events-none"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
