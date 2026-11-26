import { useEffect, useRef } from 'react';
import { BookOpen, Globe, Hand, HelpCircle, QrCode, Shield, Smartphone, X } from 'lucide-react';

interface UserManualModalProps {
  open: boolean;
  onClose: () => void;
}

export function UserManualModal({ open, onClose }: UserManualModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  // Fallback for browsers without native closedby="any" support (per modern-web-guidance light-dismiss-a-dialog)
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg || 'closedBy' in HTMLDialogElement.prototype) return;

    let pressedOutside = false;
    const isOutside = (e: PointerEvent) => {
      const r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    const onDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
        onClose();
      }
      pressedOutside = false;
    };
    dlg.addEventListener('pointerdown', onDown);
    dlg.addEventListener('pointerup', onUp);
    return () => {
      dlg.removeEventListener('pointerdown', onDown);
      dlg.removeEventListener('pointerup', onUp);
    };
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="user-manual-title"
      {...({ closedby: 'any' } as Record<string, string>)}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      className="m-auto w-[min(36rem,94dvw)] max-h-[88dvh] rounded-3xl"
    >
      <div className="glass-elevated prism-border rounded-3xl flex flex-col max-h-[88dvh] overflow-hidden shadow-2xl">
        <div className="px-4 py-3.5 border-b border-white/10 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-sky-400" />
            <h1 id="user-manual-title" className="text-base font-bold">
              AgyPocket 使用说明书
            </h1>
          </div>
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="w-9 h-9 rounded-xl hover:bg-white/10 flex items-center justify-center"
            aria-label="关闭说明书"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto obsidian-scroll p-4 space-y-4 text-xs leading-relaxed">
          <section className="glass-panel rounded-2xl p-3.5 space-y-1.5">
            <div className="font-semibold text-sm flex items-center gap-1.5 text-sky-300">
              <QrCode className="w-4 h-4" />
              <span>1. 快速上手与首次配对</span>
            </div>
            <p className="opacity-85">
              在电脑端运行 <code className="font-mono">启动反重力远程终端.bat</code>，首次启动按提示设置访问口令并确认接入地址，终端会生成{' '}
              <strong>2 分钟有效的一次性二合一配对二维码</strong>。
            </p>
            <p className="opacity-80">
              使用原生 Android App 扫码可自动记住设备名称、连接模式（固定/临时）与自签 HTTPS 指纹，并自动完成免密登录；也可直接在手机浏览器打开配对链接。
            </p>
          </section>

          <section className="glass-panel rounded-2xl p-3.5 space-y-1.5">
            <div className="font-semibold text-sm flex items-center gap-1.5 text-violet-300">
              <Shield className="w-4 h-4" />
              <span>2. 固定模式（Fixed）与临时模式（Temp）</span>
            </div>
            <ul className="list-disc pl-4 space-y-1 opacity-85">
              <li>
                <strong>固定模式（Fixed）</strong>：适合局域网固定 IP、SakuraFrp、Tailscale、自建 frp 或 Cloudflare Named Tunnel。启动 App 时若暂未连上，会停留在离线重试页，不会盲目跳扫码。
              </li>
              <li>
                <strong>临时模式（Temp）</strong>：适合 Cloudflare 免费临时隧道（每次启动都会变新域名）。启动 App 若检测到旧临时地址已失效（2.5 秒探活超时），将自动打开扫码页面提示扫描电脑新二维码。
              </li>
            </ul>
          </section>

          <section className="glass-panel rounded-2xl p-3.5 space-y-1.5">
            <div className="font-semibold text-sm flex items-center gap-1.5 text-emerald-300">
              <Globe className="w-4 h-4" />
              <span>3. 自选内网穿透方案</span>
            </div>
            <ul className="list-disc pl-4 space-y-1 opacity-85">
              <li>
                <strong>Cloudflare 免费隧道</strong>：无需公网 IP。自行安装 <code className="font-mono">cloudflared</code> 到系统 PATH 后即可使用零配置临时链接（Quick）或绑定自己域名的固定链接（Named）。
              </li>
              <li>
                <strong>SakuraFrp / 自建 frp / Tailscale</strong>：保持 <code className="font-mono">tunnel_mode = external</code>，在设置或启动器 <code className="font-mono">[U]</code> 中填入公网/内网穿透地址即可。
              </li>
              <li>
                <strong>纯局域网直连</strong>：手机与电脑在同一 Wi-Fi 下时，直接使用启动器自动探测的 <code className="font-mono">http://&lt;局域网IP&gt;:18765</code>。
              </li>
            </ul>
          </section>

          <section className="glass-panel rounded-2xl p-3.5 space-y-1.5">
            <div className="font-semibold text-sm flex items-center gap-1.5 text-amber-300">
              <Hand className="w-4 h-4" />
              <span>4. 桌面遥控台手势与鼠标高阶动作</span>
            </div>
            <ul className="list-disc pl-4 space-y-1 opacity-85">
              <li>
                <strong>自由留白拖动（默认）</strong>：即使 1.0x 倍率也可拖动画面，支持把桌面边缘拖入屏幕中央；在暗色点阵留白区滑动手指，一样能将准星精准推到 0.0 / 1.0 屏幕边角（关闭按钮、任务栏、开始菜单）。
              </li>
              <li>
                <strong>自动边缘对齐</strong>：可在设置抽屉切换，1.0x 严格居中、放大后不露黑边。
              </li>
              <li>
                <strong>双指捏合与一键复位</strong>：双指捏合可在 1.0x–3.5x 间缩放并跟随双指中点平移；点击倍率数字（如 <code className="font-mono">1.5x</code>）一键居中复位。
              </li>
              <li>
                <strong>按住拖动 / 按住 / 连点</strong>：支持左键按住、右键按住、起点锚点+虚线预览的「按住拖动」，以及「连点」（短按连点指定次数，长按超过 280ms 持续连点）。快捷按钮可在设置中自由增减。
              </li>
              <li>
                <strong>按钮编号 / 横屏全屏 / Esc 急停</strong>：点击「按钮编号」可用 UIA 自动给前台窗口按钮标号直点；「横屏全屏」支持自动或手动旋转 90°；右上角红色 <strong>Esc 急停</strong> 会释放所有按住键与修饰键并发送系统 Esc。
              </li>
            </ul>
          </section>

          <section className="glass-panel rounded-2xl p-3.5 space-y-1.5">
            <div className="font-semibold text-sm flex items-center gap-1.5 text-sky-300">
              <Smartphone className="w-4 h-4" />
              <span>5. 原生 Android App 三指快捷菜单</span>
            </div>
            <p className="opacity-85">
              在原生安卓客户端任意页面<strong>三指同时轻触屏幕</strong>，即可呼出原生控制面板：一键打开扫码连接、切换固定/临时模式、在多台已保存电脑间快速切换、开启聊天极致沉浸全屏、或离线查看本说明书。
            </p>
          </section>

          <section className="glass-panel rounded-2xl p-3.5 space-y-1.5">
            <div className="font-semibold text-sm flex items-center gap-1.5 text-rose-300">
              <HelpCircle className="w-4 h-4" />
              <span>6. 常见问题排查</span>
            </div>
            <ul className="list-disc pl-4 space-y-1 opacity-85">
              <li>
                <strong>Tab 2 显示“电脑处于锁屏状态”</strong>：Windows 锁屏桌面会隔离普通截图与鼠标注入，建议关闭自动锁屏并仅关闭显示器息屏；Tab 1 对话工作台在锁屏期间仍可正常收发任务。
              </li>
              <li>
                <strong>提示 Sidecar 尚未在线</strong>：在电脑端运行一次 <code className="font-mono">install-bridge-plugin.ps1</code> 并重启桌面版 Antigravity 即可。
              </li>
              <li>
                <strong>自签 HTTPS 证书提示</strong>：通过 App 扫码接入时会自动以 TOFU 机制绑定该域名的 SHA-256 指纹；更换新证书后，可在三指菜单清除证书记录后重新扫码绑定。
              </li>
            </ul>
          </section>
        </div>
      </div>
    </dialog>
  );
}
