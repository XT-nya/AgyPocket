import { Cpu, KeyRound, Monitor, RefreshCw } from 'lucide-react';
import type { TelemetryData } from '../../api/client';
import type { CardRendererProps } from '../types';

export function SystemMiniCard({ payload, onAction }: CardRendererProps<Partial<TelemetryData>>) {
  const d = payload.data || {};
  return (
    <div className="glass-panel rounded-xl p-3 my-1.5 text-xs space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-semibold">
          <Monitor className="w-4 h-4 text-sky-400" />
          <span>远程电脑实时状态</span>
        </div>
        <button
          type="button"
          onClick={() => onAction('core.cards', 'system.refresh', {})}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10"
        >
          <RefreshCw className="w-3 h-3" />
          刷新
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-black/25 p-2">
          <div className="opacity-60 flex items-center gap-1">
            <Cpu className="w-3 h-3" /> CPU
          </div>
          <div className="font-mono font-semibold mt-0.5">{d.cpu_percent ?? '--'}%</div>
        </div>
        <div className="rounded-lg bg-black/25 p-2">
          <div className="opacity-60">内存</div>
          <div className="font-mono font-semibold mt-0.5">{d.ram_percent ?? '--'}%</div>
        </div>
        <div className="rounded-lg bg-black/25 p-2">
          <div className="opacity-60">磁盘</div>
          <div className="font-mono font-semibold mt-0.5">{d.disk_percent ?? '--'}%</div>
        </div>
      </div>
      {d.foreground_window && (
        <div className="opacity-75 truncate">前台窗口：{d.foreground_window}</div>
      )}
    </div>
  );
}

interface AuthGuideData {
  title?: string;
  message?: string;
  command?: string;
}

export function AuthGuideCard({ payload }: CardRendererProps<AuthGuideData>) {
  const { title = '需要完成 agy CLI 登录', message = '', command = 'agy' } = payload.data || {};
  return (
    <div className="glass-panel prism-border rounded-xl p-3.5 my-2 text-xs space-y-2 border-amber-400/35">
      <div className="flex items-center gap-2 font-semibold text-amber-300 text-sm">
        <KeyRound className="w-4 h-4 shrink-0" />
        <span>{title}</span>
      </div>
      <p className="opacity-85 leading-relaxed">
        首次使用需要在电脑终端执行一次官方登录命令，并在弹出的浏览器窗口中完成 Google 账号授权（之后即可长期免密续用）：
      </p>
      <pre className="p-2.5 rounded-lg bg-black/45 font-mono text-[11px] overflow-x-auto text-sky-200">
        {command}
      </pre>
      {message && <div className="opacity-65 text-[11px] break-all">原始提示：{message}</div>}
    </div>
  );
}
