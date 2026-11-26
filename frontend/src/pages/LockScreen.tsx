import { useEffect, useState } from 'react';
import { BookOpen, Eye, EyeOff, KeyRound, Lock, QrCode, ShieldCheck, Smartphone } from 'lucide-react';
import { api, ApiError, type AuthStatus } from '../api/client';

interface LockScreenProps {
  status: AuthStatus;
  onUnlocked: () => void;
  onOpenManual: () => void;
}

export function LockScreen({ status, onUnlocked, onOpenManual }: LockScreenProps) {
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(status.totp_enabled);
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lockSeconds, setLockSeconds] = useState(0);

  useEffect(() => {
    setNeedsTotp(status.totp_enabled);
  }, [status.totp_enabled]);

  useEffect(() => {
    if (lockSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setLockSeconds((s) => (s > 1 ? s - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [lockSeconds]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lockSeconds > 0 || loading) return;
    setError('');

    if (status.needs_setup) {
      if (passphrase.length < 6) {
        setError('访问口令至少需要 6 个字符');
        return;
      }
      if (passphrase !== confirmPassphrase) {
        setError('两次输入的访问口令不一致');
        return;
      }
      setLoading(true);
      try {
        await api.setupAuth(passphrase);
        onUnlocked();
      } catch (err) {
        setError(err instanceof Error ? err.message : '初始化口令失败');
      } finally {
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      await api.login(passphrase, totpCode);
      onUnlocked();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.detail === 'TOTP_REQUIRED') {
          setNeedsTotp(true);
          setError('请输入手机验证器中的 6 位动态码');
        } else {
          setError(err.detail);
        }
        if (err.status === 429 && err.retryAfter) {
          setLockSeconds(err.retryAfter);
        }
      } else {
        setError('连接失败，请确认远程电脑服务或穿透隧道是否在线');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[100dvh] obsidian-bg flex flex-col items-center justify-center p-5">
      <div className="w-full max-w-sm glass-elevated prism-border rounded-3xl p-6 space-y-6 shadow-2xl">
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-sky-500/30 to-violet-500/30 border border-white/15 flex items-center justify-center">
            {status.needs_setup ? <KeyRound className="w-7 h-7 text-sky-300" /> : <Lock className="w-7 h-7 text-sky-300" />}
          </div>
          <h1 className="text-xl font-bold tracking-tight">AgyPocket</h1>
          <p className="text-xs opacity-70">
            {status.needs_setup
              ? status.is_loopback
                ? '首次在本机启动，请设置访问口令'
                : '请先在远程电脑端完成口令初始化'
              : `${status.device_name ? `${status.device_name} · ` : ''}反重力远程终端 · 安全验证`}
          </p>
        </div>

        {status.needs_setup && !status.is_loopback ? (
          <div className="rounded-2xl bg-amber-500/10 border border-amber-400/30 p-4 text-xs leading-relaxed text-amber-200">
            出于安全策略，首次访问口令只能在电脑本机终端或本机浏览器中初始化。请在电脑端运行{' '}
            <code className="font-mono">启动反重力远程终端.bat</code> 完成设置后刷新此页。
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="agy-passphrase" className="text-xs font-medium opacity-80 block">
                {status.needs_setup ? '设置高强度访问口令（至少 6 位）' : '访问口令'}
              </label>
              <div className="relative">
                <input
                  id="agy-passphrase"
                  type={showPass ? 'text' : 'password'}
                  autoComplete={status.needs_setup ? 'new-password' : 'current-password'}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="输入访问口令..."
                  className="w-full min-h-[46px] rounded-xl bg-black/30 border border-white/15 px-3.5 pr-11 text-sm focus:outline-none focus:border-sky-400"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPass((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-lg opacity-70 hover:opacity-100"
                  aria-label={showPass ? '隐藏口令' : '显示口令'}
                >
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {status.needs_setup && (
              <div className="space-y-1.5">
                <label htmlFor="agy-passphrase-confirm" className="text-xs font-medium opacity-80 block">
                  确认访问口令
                </label>
                <input
                  id="agy-passphrase-confirm"
                  type={showPass ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmPassphrase}
                  onChange={(e) => setConfirmPassphrase(e.target.value)}
                  placeholder="再次输入口令..."
                  className="w-full min-h-[46px] rounded-xl bg-black/30 border border-white/15 px-3.5 text-sm focus:outline-none focus:border-sky-400"
                  required
                />
              </div>
            )}

            {!status.needs_setup && needsTotp && (
              <div className="space-y-1.5">
                <label htmlFor="agy-totp" className="text-xs font-medium opacity-80 flex items-center gap-1.5">
                  <Smartphone className="w-3.5 h-3.5 text-sky-400" />
                  <span>6 位动态验证码 (TOTP)</span>
                </label>
                <input
                  id="agy-totp"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="w-full min-h-[46px] rounded-xl bg-black/30 border border-white/15 px-3.5 text-center font-mono text-lg tracking-[0.35em] focus:outline-none focus:border-sky-400"
                />
              </div>
            )}

            {error && (
              <div className="rounded-xl bg-rose-500/15 border border-rose-400/35 px-3 py-2 text-xs text-rose-200">
                {error}
                {lockSeconds > 0 && <span className="ml-1 font-mono">({lockSeconds}s)</span>}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || lockSeconds > 0}
              className="w-full min-h-[48px] rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 text-white font-semibold text-sm shadow-lg shadow-sky-500/20 disabled:opacity-50 active:scale-[0.98] transition flex items-center justify-center gap-2"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>{loading ? '正在验证...' : status.needs_setup ? '完成初始化并进入' : '解锁终端'}</span>
            </button>
          </form>
        )}

        <div className="space-y-2">
          <div className="text-center text-[11px] opacity-55 leading-relaxed">
            连续输错 5 次将自动锁定 15 分钟 · 支持电脑端扫码一键配对
          </div>
          <div className="flex items-center justify-center gap-2 pt-1">
            {(
              window as unknown as {
                AgyPocketNative?: { isNativeApp?: () => boolean; openQrScanner?: () => void };
              }
            ).AgyPocketNative?.isNativeApp?.() && (
              <button
                type="button"
                onClick={() =>
                  (
                    window as unknown as { AgyPocketNative?: { openQrScanner?: () => void } }
                  ).AgyPocketNative?.openQrScanner?.()
                }
                className="px-3 py-1.5 rounded-xl bg-sky-500/15 border border-sky-400/30 text-sky-200 text-xs inline-flex items-center gap-1.5 hover:bg-sky-500/25"
              >
                <QrCode className="w-3.5 h-3.5" />
                <span>扫码连接电脑</span>
              </button>
            )}
            <button
              type="button"
              onClick={onOpenManual}
              className="px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-xs inline-flex items-center gap-1.5 hover:bg-white/10"
            >
              <BookOpen className="w-3.5 h-3.5 text-sky-300" />
              <span>查看使用说明书</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
