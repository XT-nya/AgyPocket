import { useEffect, useRef, useState } from 'react';
import {
  Blocks,
  BookOpen,
  Download,
  Globe,
  LogOut,
  MessageSquare,
  Monitor,
  MousePointerClick,
  Palette,
  PowerOff,
  QrCode,
  RefreshCw,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  X,
} from 'lucide-react';
import {
  api,
  type ApprovalPolicy,
  type BridgeStatus,
  type PermissionSpec,
  type PluginManifestItem,
  type SettingsData,
} from '../api/client';
import {
  DEFAULT_DISPLAY_PREFS,
  DENSITY_PRESETS,
  type DensityPreset,
  type DisplayPrefs,
} from '../utils/displayPrefs';
import {
  DEFAULT_REMOTE_PREFS,
  RAPID_CLICK_OPTIONS,
  type RemotePrefs,
  TOOLBAR_BUTTON_ITEMS,
} from '../utils/remotePrefs';

export type ThemeChoice = 'dark' | 'light' | 'light dark';

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  settings: SettingsData | null;
  permissionSpecs: PermissionSpec[];
  bridgeStatus: BridgeStatus | null;
  modelDisplayLabel: string;
  totpEnabled: boolean;
  theme: ThemeChoice;
  displayPrefs: DisplayPrefs;
  remotePrefs: RemotePrefs;
  canInstallPwa: boolean;
  onInstallPwa: () => void;
  onChangeTheme: (choice: ThemeChoice) => void;
  onChangeDisplayPrefs: (next: DisplayPrefs) => void;
  onChangeRemotePrefs: (next: RemotePrefs) => void;
  onSettingsUpdated: (next: SettingsData) => void;
  onRefreshBridge: () => void;
  onOpenModelPicker: () => void;
  onOpenManual: () => void;
  onAuthChanged: () => void;
  onToast: (msg: string) => void;
}

const APPROVAL_POLICIES: Array<{
  id: ApprovalPolicy;
  label: string;
  desc: string;
}> = [
  {
    id: 'remote_smart',
    label: '手机智能审批（推荐）',
    desc: '桌面端执行命令、写文件、浏览器或 MCP 高敏工具时，实时推送到手机点击允许/拒绝；只读检索秒级自动放行。',
  },
  {
    id: 'remote_all',
    label: '手机全量审批',
    desc: '所有工具调用均先请求手机端确认；手机离线或超时自动交还电脑桌面处理。',
  },
  {
    id: 'desktop_only',
    label: '仅电脑桌面审批',
    desc: '手机端不拦截工具请求，全部交由远程电脑桌面版 Antigravity 原权限策略处理。',
  },
];

export function SettingsDrawer({
  open,
  onClose,
  settings,
  bridgeStatus,
  modelDisplayLabel,
  totpEnabled,
  theme,
  displayPrefs,
  remotePrefs,
  canInstallPwa,
  onInstallPwa,
  onChangeTheme,
  onChangeDisplayPrefs,
  onChangeRemotePrefs,
  onSettingsUpdated,
  onRefreshBridge,
  onOpenModelPicker,
  onOpenManual,
  onAuthChanged,
  onToast,
}: SettingsDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [workspaceDir, setWorkspaceDir] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [cloudflaredPath, setCloudflaredPath] = useState('');
  const [plugins, setPlugins] = useState<PluginManifestItem[]>([]);
  const [pairUrl, setPairUrl] = useState('');

  // TOTP UI state
  const [totpSetupData, setTotpSetupData] = useState<{ secret: string; qr_png_base64: string } | null>(null);
  const [totpPassphrase, setTotpPassphrase] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [disablingTotp, setDisablingTotp] = useState(false);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
      api
        .getPluginContributions()
        .then((res) => setPlugins(res.plugins))
        .catch(() => {});
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  useEffect(() => {
    if (settings) {
      setWorkspaceDir(settings.workspace_dir || '');
      setDeviceName(settings.device_name || '');
      setExternalUrl(settings.external_public_url || '');
      setCloudflaredPath(settings.cloudflared_path || '');
    }
  }, [settings]);

  const patchSettings = async (patch: Partial<SettingsData>, successMsg?: string) => {
    try {
      const res = await api.updateSettings(patch);
      onSettingsUpdated(res.settings);
      if (successMsg) onToast(successMsg);
    } catch (err) {
      onToast(err instanceof Error ? err.message : '保存设置失败');
    }
  };

  const handleStartTotpSetup = async () => {
    try {
      const res = await api.totpSetup();
      setTotpSetupData({ secret: res.secret, qr_png_base64: res.qr_png_base64 });
    } catch {
      onToast('生成动态码绑定信息失败');
    }
  };

  const handleEnableTotp = async () => {
    try {
      await api.totpEnable(totpPassphrase, totpCode);
      setTotpSetupData(null);
      setTotpPassphrase('');
      setTotpCode('');
      onAuthChanged();
      onToast('已开启 TOTP 6 位动态码双重验证');
    } catch (err) {
      onToast(err instanceof Error ? err.message : '启用失败');
    }
  };

  const handleDisableTotp = async () => {
    try {
      await api.totpDisable(totpPassphrase, totpCode);
      setDisablingTotp(false);
      setTotpPassphrase('');
      setTotpCode('');
      onAuthChanged();
      onToast('已关闭 TOTP 动态码');
    } catch (err) {
      onToast(err instanceof Error ? err.message : '关闭失败');
    }
  };

  const handleGeneratePair = async () => {
    try {
      const res = await api.createPairToken();
      setPairUrl(`${window.location.origin}${res.qr_path || res.pair_path}`);
      onToast('已生成 2 分钟一次性二合一配对链接');
    } catch {
      onToast('生成配对链接失败');
    }
  };

  const handleRevokeAll = async () => {
    try {
      await api.revokeAll();
      onClose();
      onAuthChanged();
      onToast('已注销全部设备登录态');
    } catch {
      onToast('注销失败');
    }
  };

  const handleKillTunnel = async () => {
    try {
      await api.killTunnel();
      onToast('已发送紧急切断隧道指令');
    } catch {
      onToast('切断隧道失败');
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="settings-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
      className="ml-auto w-[min(26rem,100dvw)] h-[100dvh] sm:rounded-l-3xl"
    >
      <div className="h-full glass-elevated border-l border-white/15 flex flex-col">
        <div className="px-4 py-3.5 border-b border-white/10 flex items-center justify-between">
          <h1 id="settings-dialog-title" className="text-base font-bold">
            控制中心与设置
          </h1>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-xl hover:bg-white/10 flex items-center justify-center"
            aria-label="关闭设置"
            autoFocus
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto obsidian-scroll p-4 space-y-6 text-xs">
          {/* Quick Manual Banner */}
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenManual();
            }}
            className="w-full min-h-[42px] rounded-2xl bg-gradient-to-r from-sky-500/20 to-violet-500/20 border border-sky-400/35 px-3.5 flex items-center justify-between text-sky-100 hover:bg-sky-500/25 transition"
          >
            <span className="flex items-center gap-2 font-semibold text-sm">
              <BookOpen className="w-4 h-4 text-sky-300" />
              <span>查看 AgyPocket 使用说明书</span>
            </span>
            <span className="text-[11px] opacity-80">配对 / 穿透 / 手势指南 →</span>
          </button>

          {/* 1. Antigravity Desktop Bridge Status */}
          <section className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 font-semibold text-sm">
                <Sparkles className="w-4 h-4 text-sky-400" />
                <span>桌面版 Antigravity 联动状态</span>
              </div>
              <button
                type="button"
                onClick={onRefreshBridge}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10"
              >
                <RefreshCw className="w-3 h-3" />
                <span>检测</span>
              </button>
            </div>
            <div className="glass-panel rounded-2xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="opacity-75">官方联动插件 (agy-pocket-bridge)</span>
                <span className={bridgeStatus?.plugin_installed ? 'text-emerald-400 font-medium' : 'text-amber-300'}>
                  {bridgeStatus?.plugin_installed ? '已安装' : '未安装'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="opacity-75">桌面版 Sidecar 通道</span>
                <span className={bridgeStatus?.sidecar_running ? 'text-emerald-400 font-medium' : 'text-amber-300'}>
                  {bridgeStatus?.sidecar_running ? '已在线联动' : '等待桌面版重启'}
                </span>
              </div>
              {bridgeStatus?.detail && (
                <div className="rounded-xl bg-black/25 border border-white/10 p-2 text-[11px] opacity-85 leading-relaxed">
                  {bridgeStatus.detail}
                </div>
              )}
            </div>
          </section>

          {/* 2. Mobile Tool Approval Policy */}
          <section className="space-y-2.5">
            <div className="flex items-center gap-1.5 font-semibold text-sm">
              <Shield className="w-4 h-4 text-sky-400" />
              <span>手机端工具权限审批策略</span>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {APPROVAL_POLICIES.map((pol) => {
                const active = (settings?.approval_policy || 'remote_smart') === pol.id;
                return (
                  <button
                    key={pol.id}
                    type="button"
                    onClick={() => patchSettings({ approval_policy: pol.id }, `已切换为「${pol.label}」`)}
                    className={`text-left rounded-xl p-3 border transition ${
                      active
                        ? 'bg-sky-500/20 border-sky-400/50'
                        : 'bg-white/5 border-white/10 hover:bg-white/10'
                    }`}
                  >
                    <div className="flex items-center justify-between font-semibold text-sm">
                      <span>{pol.label}</span>
                      {active && <span className="text-[11px] text-sky-300">当前启用</span>}
                    </div>
                    <div className="opacity-70 mt-1 leading-relaxed">{pol.desc}</div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 2b. Message Dispatch Mode (Native UI Sync vs Bridge) */}
          <section className="space-y-2.5">
            <div className="flex items-center gap-1.5 font-semibold text-sm">
              <MessageSquare className="w-4 h-4 text-sky-400" />
              <span>手机发送消息同步方式</span>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {(
                [
                  [
                    'native_first',
                    '原生输入框同步优先（推荐）',
                    '续聊时优先同步写入桌面版 Antigravity 对话输入框，电脑界面实时显示用户气泡；锁屏或窗口不匹配时自动回退 Sidecar。',
                  ],
                  [
                    'bridge_only',
                    '仅 Sidecar 静默通道',
                    '全程通过官方 Sidecar 通道发送指令，不触发电脑桌面输入框与剪贴板。',
                  ],
                ] as const
              ).map(([modeId, label, desc]) => {
                const active = (settings?.message_dispatch_mode || 'native_first') === modeId;
                return (
                  <button
                    key={modeId}
                    type="button"
                    onClick={() => patchSettings({ message_dispatch_mode: modeId }, `已切换为「${label}」`)}
                    className={`text-left rounded-xl p-3 border transition ${
                      active ? 'bg-sky-500/20 border-sky-400/50' : 'bg-white/5 border-white/10 hover:bg-white/10'
                    }`}
                  >
                    <div className="flex items-center justify-between font-semibold text-sm">
                      <span>{label}</span>
                      {active && <span className="text-[11px] text-sky-300">当前启用</span>}
                    </div>
                    <div className="opacity-70 mt-1 leading-relaxed">{desc}</div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 3. Default Model (Visual Picker) & Workspace */}
          <section className="space-y-2.5">
            <div className="font-semibold text-sm">默认模型与工作区</div>
            <div className="space-y-2.5 glass-panel rounded-2xl p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="opacity-70">新建对话默认模型与思考强度</div>
                  <div className="font-medium text-sm text-sky-200 truncate mt-0.5">
                    {modelDisplayLabel || settings?.model || '跟随桌面版默认'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenModelPicker();
                  }}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-sky-500/25 border border-sky-400/45 text-sky-100 font-medium"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span>点选/滑条</span>
                </button>
              </div>

              <label className="block space-y-1 pt-1 border-t border-white/10">
                <span className="opacity-75">默认工作区路径</span>
                <input
                  type="text"
                  value={workspaceDir}
                  onChange={(e) => setWorkspaceDir(e.target.value)}
                  className="w-full min-h-[40px] rounded-xl bg-black/30 border border-white/15 px-3 font-mono text-xs"
                />
              </label>
              <button
                type="button"
                onClick={() => patchSettings({ workspace_dir: workspaceDir }, '工作区路径已保存')}
                className="w-full min-h-[40px] rounded-xl bg-sky-500/25 border border-sky-400/40 font-medium"
              >
                保存工作区路径
              </button>
            </div>
          </section>

          {/* 4. Theme & Prevent Sleep */}
          <section className="space-y-2.5">
            <div className="flex items-center gap-1.5 font-semibold text-sm">
              <Palette className="w-4 h-4 text-violet-400" />
              <span>外观与远程电脑电源</span>
            </div>
            <div className="glass-panel rounded-2xl p-3 space-y-3">
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    ['dark', '黑曜深色'],
                    ['light', '霜白浅色'],
                    ['light dark', '跟随系统'],
                  ] as const
                ).map(([val, lbl]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => onChangeTheme(val)}
                    className={`min-h-[38px] rounded-xl border font-medium ${
                      theme === val ? 'bg-violet-500/25 border-violet-400/50' : 'bg-white/5 border-white/10'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              <label className="flex items-center justify-between gap-3 pt-1 cursor-pointer">
                <div className="flex items-center gap-2">
                  <Monitor className="w-4 h-4 text-emerald-400" />
                  <div>
                    <div className="font-medium text-sm">防止远程电脑自动休眠</div>
                    <div className="opacity-65">保持远程连接不断线（仍可关闭显示器）</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={Boolean(settings?.prevent_sleep)}
                  onChange={(e) => patchSettings({ prevent_sleep: e.target.checked })}
                  className="w-5 h-5 accent-sky-500"
                />
              </label>

              {/* Chat Typography & Information Density */}
              <div className="pt-2.5 border-t border-white/10 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">聊天信息密度与字距</span>
                  <button
                    type="button"
                    onClick={() => onChangeDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS })}
                    className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] opacity-80"
                  >
                    恢复默认
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  {(['compact', 'normal', 'comfortable'] as DensityPreset[]).map((presetId) => {
                    const p = DENSITY_PRESETS[presetId];
                    const active = displayPrefs.density === presetId;
                    return (
                      <button
                        key={presetId}
                        type="button"
                        onClick={() =>
                          onChangeDisplayPrefs({
                            density: presetId,
                            fontSize: p.fontSize,
                            lineHeight: p.lineHeight,
                            letterSpacing: p.letterSpacing,
                          })
                        }
                        className={`min-h-[38px] rounded-xl border font-medium transition ${
                          active ? 'bg-sky-500/25 border-sky-400/50 text-sky-100' : 'bg-white/5 border-white/10'
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>

                <label className="block space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="opacity-80">字之间疏密（字距）</span>
                    <span className="font-mono text-sky-300">
                      {displayPrefs.letterSpacing >= 0 ? `+${displayPrefs.letterSpacing.toFixed(3)}` : displayPrefs.letterSpacing.toFixed(3)}em
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-0.04}
                    max={0.08}
                    step={0.005}
                    value={displayPrefs.letterSpacing}
                    onChange={(e) =>
                      onChangeDisplayPrefs({ ...displayPrefs, letterSpacing: parseFloat(e.target.value) })
                    }
                    className="w-full accent-sky-500 cursor-pointer"
                  />
                </label>

                <label className="block space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="opacity-80">气泡字号大小</span>
                    <span className="font-mono text-sky-300">{displayPrefs.fontSize.toFixed(1)}px</span>
                  </div>
                  <input
                    type="range"
                    min={12}
                    max={16}
                    step={0.5}
                    value={displayPrefs.fontSize}
                    onChange={(e) =>
                      onChangeDisplayPrefs({ ...displayPrefs, fontSize: parseFloat(e.target.value) })
                    }
                    className="w-full accent-sky-500 cursor-pointer"
                  />
                </label>

                <label className="block space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="opacity-80">段落行高疏密</span>
                    <span className="font-mono text-sky-300">{displayPrefs.lineHeight.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={1.3}
                    max={1.75}
                    step={0.05}
                    value={displayPrefs.lineHeight}
                    onChange={(e) =>
                      onChangeDisplayPrefs({ ...displayPrefs, lineHeight: parseFloat(e.target.value) })
                    }
                    className="w-full accent-sky-500 cursor-pointer"
                  />
                </label>

                <div
                  className="rounded-xl bg-black/25 border border-white/10 px-2.5 py-2 opacity-90"
                  style={{
                    fontSize: `${displayPrefs.fontSize}px`,
                    lineHeight: displayPrefs.lineHeight,
                    letterSpacing: `${displayPrefs.letterSpacing}em`,
                  }}
                >
                  实时预览：AgyPocket 手机高密度排版效果预览，气泡边距与字距实时联动。
                </div>
              </div>
            </div>
          </section>

          {/* 4a. Desktop Remote & Toolbar Customization */}
          <section className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 font-semibold text-sm">
                <MousePointerClick className="w-4 h-4 text-sky-400" />
                <span>桌面遥控与工具栏自定义</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  onChangeRemotePrefs({
                    ...DEFAULT_REMOTE_PREFS,
                    toolbarButtons: { ...DEFAULT_REMOTE_PREFS.toolbarButtons },
                  });
                  onToast('已恢复桌面遥控默认设置');
                }}
                className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] opacity-80"
              >
                恢复默认
              </button>
            </div>
            <div className="glass-panel rounded-2xl p-3 space-y-3">
              <div className="space-y-1.5">
                <div className="opacity-75">画布拖动边界模式</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    [
                      ['free_margin', '自由留白拖动（推荐）'],
                      ['edge_snap', '自动边缘对齐'],
                    ] as const
                  ).map(([bMode, label]) => {
                    const active = remotePrefs.canvasBoundaryMode === bMode;
                    return (
                      <button
                        key={bMode}
                        type="button"
                        onClick={() => onChangeRemotePrefs({ ...remotePrefs, canvasBoundaryMode: bMode })}
                        className={`min-h-[38px] px-2 rounded-xl border font-medium transition ${
                          active ? 'bg-sky-500/25 border-sky-400/50 text-sky-100' : 'bg-white/5 border-white/10'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div className="text-[11px] opacity-65 leading-relaxed">
                  自由留白模式下 1.0x 也可拖动画面，手指在留白区起手也能轻松点到关闭按钮、任务栏与屏幕边角。
                </div>
              </div>

              <div className="space-y-1.5 pt-2 border-t border-white/10">
                <div className="opacity-75">短按连点次数</div>
                <div className="grid grid-cols-4 gap-1.5">
                  {RAPID_CLICK_OPTIONS.map((cnt) => {
                    const active = remotePrefs.rapidClickCount === cnt;
                    return (
                      <button
                        key={cnt}
                        type="button"
                        onClick={() => onChangeRemotePrefs({ ...remotePrefs, rapidClickCount: cnt })}
                        className={`min-h-[34px] rounded-xl border font-mono font-medium transition ${
                          active ? 'bg-amber-500/25 border-amber-400/50 text-amber-100' : 'bg-white/5 border-white/10'
                        }`}
                      >
                        {cnt} 次
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1.5 pt-2 border-t border-white/10">
                <div className="opacity-75">快捷操作栏显示按钮（竖屏与全屏通用）</div>
                <div className="grid grid-cols-1 gap-1.5">
                  {TOOLBAR_BUTTON_ITEMS.map((item) => (
                    <label
                      key={item.key}
                      className="flex items-center justify-between gap-2 rounded-xl bg-black/20 border border-white/10 px-2.5 py-2 cursor-pointer"
                    >
                      <div className="min-w-0">
                        <div className="font-medium">{item.label}</div>
                        <div className="text-[11px] opacity-65 truncate">{item.desc}</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={remotePrefs.toolbarButtons[item.key]}
                        onChange={(e) =>
                          onChangeRemotePrefs({
                            ...remotePrefs,
                            toolbarButtons: {
                              ...remotePrefs.toolbarButtons,
                              [item.key]: e.target.checked,
                            },
                          })
                        }
                        className="w-4 h-4 accent-sky-500 shrink-0"
                      />
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* 4b. Remote Tunnel Mode & Device Connection Mode */}
          <section className="space-y-2.5">
            <div className="flex items-center gap-1.5 font-semibold text-sm">
              <Globe className="w-4 h-4 text-sky-400" />
              <span>远程穿透与设备连接模式</span>
            </div>
            <div className="glass-panel rounded-2xl p-3 space-y-3">
              <div className="space-y-1.5">
                <div className="opacity-75">本机设备名称（用于扫码识别多台电脑）</div>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    placeholder="My-PC"
                    className="flex-1 min-h-[38px] rounded-xl bg-black/30 border border-white/15 px-3 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => patchSettings({ device_name: deviceName }, '设备名称已保存')}
                    className="px-3 min-h-[38px] rounded-xl bg-white/10 hover:bg-white/15 font-medium"
                  >
                    保存
                  </button>
                </div>
              </div>

              <div className="space-y-1.5 pt-1 border-t border-white/10">
                <div className="opacity-75">App 扫码连接模式</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    [
                      ['fixed', '固定地址模式 (Fixed)'],
                      ['temp', '临时随机模式 (Temp)'],
                    ] as const
                  ).map(([cMode, label]) => {
                    const active = (settings?.connection_mode || 'fixed') === cMode;
                    return (
                      <button
                        key={cMode}
                        type="button"
                        onClick={() => patchSettings({ connection_mode: cMode }, `已切换为「${label}」`)}
                        className={`min-h-[38px] rounded-xl border font-medium transition ${
                          active ? 'bg-violet-500/25 border-violet-400/50 text-violet-100' : 'bg-white/5 border-white/10'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-1.5 pt-1 border-t border-white/10">
                {(
                  [
                    ['external', '外部 / 局域网'],
                    ['quick', 'CF 临时'],
                    ['named', 'CF 固定'],
                  ] as const
                ).map(([modeId, modeLabel]) => {
                  const active = (settings?.tunnel_mode || 'external') === modeId;
                  return (
                    <button
                      key={modeId}
                      type="button"
                      onClick={() =>
                        patchSettings(
                          { tunnel_mode: modeId },
                          `已切换为「${modeLabel}」模式（重建隧道或下次启动生效）`
                        )
                      }
                      className={`min-h-[38px] rounded-xl border font-medium transition ${
                        active ? 'bg-sky-500/25 border-sky-400/50 text-sky-100' : 'bg-white/5 border-white/10'
                      }`}
                    >
                      {modeLabel}
                    </button>
                  );
                })}
              </div>

              {settings?.tunnel_mode === 'external' ? (
                <div className="space-y-2 pt-1 border-t border-white/10">
                  <label className="block space-y-1">
                    <span className="opacity-75">局域网 / SakuraFrp / Tailscale / 自定义穿透地址</span>
                    <input
                      type="url"
                      value={externalUrl}
                      onChange={(e) => setExternalUrl(e.target.value)}
                      placeholder="https://remote.example.com:8443"
                      className="w-full min-h-[40px] rounded-xl bg-black/30 border border-white/15 px-3 font-mono text-xs"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      patchSettings(
                        { tunnel_mode: 'external', external_public_url: externalUrl },
                        '已保存外部穿透地址（重建隧道或下次启动生效）'
                      )
                    }
                    className="w-full min-h-[40px] rounded-xl bg-sky-500/25 border border-sky-400/40 font-medium"
                  >
                    保存外部穿透地址
                  </button>
                </div>
              ) : (
                <div className="space-y-2 pt-1 border-t border-white/10">
                  <div className="text-[11px] opacity-70 leading-relaxed">
                    {settings?.tunnel_mode === 'named'
                      ? '使用 Cloudflare Named Tunnel（需在 config/settings.json 填入 named_tunnel_token），支持多路冗余与自动重连。'
                      : '使用 Cloudflare 免费临时隧道，需本机自行安装 cloudflared（加入 PATH 或在下方填写路径）。'}
                  </div>
                  <label className="block space-y-1">
                    <span className="opacity-75">cloudflared 可执行文件路径（可选，留空自动探测 PATH）</span>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={cloudflaredPath}
                        onChange={(e) => setCloudflaredPath(e.target.value)}
                        placeholder="留空自动探测系统 PATH"
                        className="flex-1 min-h-[38px] rounded-xl bg-black/30 border border-white/15 px-3 font-mono text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => patchSettings({ cloudflared_path: cloudflaredPath }, 'cloudflared 路径已保存')}
                        className="px-3 min-h-[38px] rounded-xl bg-white/10 hover:bg-white/15 font-medium"
                      >
                        保存
                      </button>
                    </div>
                  </label>
                </div>
              )}
            </div>
          </section>

          {/* 5. Add to Home Screen & Android Shortcut Permission Guide */}
          <section className="space-y-2.5">
            <div className="flex items-center gap-1.5 font-semibold text-sm">
              <Download className="w-4 h-4 text-sky-400" />
              <span>添加到手机桌面 (PWA)</span>
            </div>
            <div className="glass-panel rounded-2xl p-3 space-y-2.5">
              {(window as unknown as {
                AgyPocketNative?: {
                  isNativeApp?: () => boolean;
                  openServerConfig?: () => void;
                  openQrScanner?: () => void;
                };
              }).AgyPocketNative?.isNativeApp?.() ? (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      (
                        window as unknown as { AgyPocketNative?: { openQrScanner?: () => void } }
                      ).AgyPocketNative?.openQrScanner?.();
                    }}
                    className="w-full min-h-[42px] rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 text-white font-semibold flex items-center justify-center gap-2 shadow-md shadow-sky-500/20"
                  >
                    <QrCode className="w-4 h-4" />
                    <span>原生扫码切换 / 配对电脑</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      (
                        window as unknown as { AgyPocketNative?: { openServerConfig?: () => void } }
                      ).AgyPocketNative?.openServerConfig?.();
                    }}
                    className="w-full min-h-[40px] rounded-xl bg-white/10 hover:bg-white/15 font-medium flex items-center justify-center gap-2"
                  >
                    <Smartphone className="w-4 h-4" />
                    <span>原生 App 壳 · 设备列表 / 沉浸设置</span>
                  </button>
                </div>
              ) : canInstallPwa ? (
                <button
                  type="button"
                  onClick={onInstallPwa}
                  className="w-full min-h-[42px] rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 text-white font-semibold flex items-center justify-center gap-2 shadow-md shadow-sky-500/20"
                >
                  <Download className="w-4 h-4" />
                  <span>一键安装为桌面 App</span>
                </button>
              ) : (
                <div className="text-[11px] opacity-75">
                  请使用 Chrome 或 Edge 浏览器菜单中的「安装应用 / 添加到主屏幕」。
                </div>
              )}
              <div className="rounded-xl bg-amber-500/10 border border-amber-400/25 p-2.5 space-y-1 text-[11px] leading-relaxed">
                <div className="font-semibold text-amber-300">提示“已创建快捷方式”但桌面没有图标？</div>
                <div className="opacity-85">
                  小米 / 华为 / OPPO / vivo 默认拦截浏览器在桌面建图标。请去手机：
                  <br />
                  <span className="font-mono text-sky-200">
                    设置 → 应用管理 → [所用浏览器] → 权限管理 → 桌面快捷方式 → 始终允许
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* 6. Modular Plugin Registry Preview */}
          <section className="space-y-2.5">
            <div className="flex items-center gap-1.5 font-semibold text-sm">
              <Blocks className="w-4 h-4 text-sky-400" />
              <span>模块化插件与卡片槽位</span>
            </div>
            <div className="space-y-2">
              {plugins.map((p) => (
                <div key={p.id} className="glass-panel rounded-xl p-3 space-y-1">
                  <div className="flex items-center justify-between font-medium">
                    <span>{p.name}</span>
                    <span className="font-mono text-[10px] opacity-60">v{p.version}</span>
                  </div>
                  <div className="opacity-70 leading-relaxed">{p.description}</div>
                </div>
              ))}
            </div>
          </section>

          {/* 7. Security Center */}
          <section className="space-y-2.5 pb-6">
            <div className="flex items-center gap-1.5 font-semibold text-sm">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>安全中心与紧急制动</span>
            </div>

            <div className="glass-panel rounded-2xl p-3 space-y-3">
              {/* TOTP 2FA */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-medium">
                    <Smartphone className="w-4 h-4 text-sky-400" />
                    <span>TOTP 6 位动态验证码</span>
                  </div>
                  <span className={totpEnabled ? 'text-emerald-400 font-medium' : 'opacity-60'}>
                    {totpEnabled ? '已开启' : '未开启'}
                  </span>
                </div>

                {!totpEnabled && !totpSetupData && (
                  <button
                    type="button"
                    onClick={handleStartTotpSetup}
                    className="w-full min-h-[38px] rounded-xl bg-white/10 hover:bg-white/15 font-medium"
                  >
                    绑定手机验证器（Google / Microsoft Authenticator）
                  </button>
                )}

                {totpSetupData && (
                  <div className="space-y-2 rounded-xl bg-black/30 p-3 border border-white/10">
                    <img
                      src={totpSetupData.qr_png_base64}
                      alt="TOTP 二维码"
                      className="w-36 h-36 mx-auto rounded-lg bg-white p-1"
                    />
                    <div className="font-mono text-[11px] text-center break-all opacity-80">
                      密钥：{totpSetupData.secret}
                    </div>
                    <input
                      type="password"
                      value={totpPassphrase}
                      onChange={(e) => setTotpPassphrase(e.target.value)}
                      placeholder="输入当前访问口令确认"
                      className="w-full min-h-[38px] rounded-lg bg-black/35 border border-white/15 px-3"
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="输入验证器显示的 6 位数字"
                      className="w-full min-h-[38px] rounded-lg bg-black/35 border border-white/15 px-3 font-mono text-center"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleEnableTotp}
                        className="flex-1 min-h-[38px] rounded-lg bg-emerald-500/25 border border-emerald-400/40 font-medium"
                      >
                        验证并开启
                      </button>
                      <button
                        type="button"
                        onClick={() => setTotpSetupData(null)}
                        className="px-3 min-h-[38px] rounded-lg bg-white/10"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}

                {totpEnabled && !disablingTotp && (
                  <button
                    type="button"
                    onClick={() => setDisablingTotp(true)}
                    className="w-full min-h-[38px] rounded-xl bg-white/10 hover:bg-white/15"
                  >
                    关闭 TOTP 动态码
                  </button>
                )}

                {disablingTotp && (
                  <div className="space-y-2 rounded-xl bg-black/30 p-3 border border-white/10">
                    <input
                      type="password"
                      value={totpPassphrase}
                      onChange={(e) => setTotpPassphrase(e.target.value)}
                      placeholder="当前访问口令"
                      className="w-full min-h-[38px] rounded-lg bg-black/35 border border-white/15 px-3"
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="当前 6 位动态码"
                      className="w-full min-h-[38px] rounded-lg bg-black/35 border border-white/15 px-3 font-mono text-center"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleDisableTotp}
                        className="flex-1 min-h-[38px] rounded-lg bg-amber-500/25 border border-amber-400/40"
                      >
                        确认关闭
                      </button>
                      <button
                        type="button"
                        onClick={() => setDisablingTotp(false)}
                        className="px-3 min-h-[38px] rounded-lg bg-white/10"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <hr className="border-white/10" />

              {/* One-time pairing link */}
              <button
                type="button"
                onClick={handleGeneratePair}
                className="w-full min-h-[40px] rounded-xl bg-white/10 hover:bg-white/15 flex items-center justify-center gap-1.5 font-medium"
              >
                <QrCode className="w-4 h-4 text-sky-400" />
                <span>生成 2 分钟一次性配对链接（给另一台设备）</span>
              </button>
              {pairUrl && (
                <div className="rounded-lg bg-black/35 p-2 font-mono text-[11px] break-all select-all">
                  {pairUrl}
                </div>
              )}

              {/* Emergency Actions */}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleRevokeAll}
                  className="min-h-[42px] rounded-xl bg-amber-500/20 border border-amber-400/40 text-amber-200 font-medium flex items-center justify-center gap-1.5"
                >
                  <LogOut className="w-4 h-4" />
                  <span>注销全部设备</span>
                </button>
                <button
                  type="button"
                  onClick={handleKillTunnel}
                  className="min-h-[42px] rounded-xl bg-rose-600/30 border border-rose-400/50 text-rose-100 font-semibold flex items-center justify-center gap-1.5"
                >
                  <PowerOff className="w-4 h-4" />
                  <span>紧急切断隧道</span>
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </dialog>
  );
}
