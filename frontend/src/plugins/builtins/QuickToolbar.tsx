import { Camera, Cpu, Slash } from 'lucide-react';

interface QuickToolbarProps {
  attachScreenshot: boolean;
  onToggleScreenshot: () => void;
  onInsertCommand: (text: string) => void;
  onSnapshotSystemCard: () => void;
}

export function QuickToolbar({
  attachScreenshot,
  onToggleScreenshot,
  onInsertCommand,
  onSnapshotSystemCard,
}: QuickToolbarProps) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto obsidian-scroll pb-1 text-xs">
      <button
        type="button"
        onClick={() => onInsertCommand('/plan ')}
        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full glass-panel hover:bg-white/10 transition"
      >
        <Slash className="w-3 h-3 text-sky-400" />
        <span>plan 规划</span>
      </button>
      <button
        type="button"
        onClick={() => onInsertCommand('/compact')}
        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full glass-panel hover:bg-white/10 transition"
      >
        <Slash className="w-3 h-3 text-violet-400" />
        <span>compact 压缩</span>
      </button>
      <button
        type="button"
        onClick={onToggleScreenshot}
        className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full border transition ${
          attachScreenshot
            ? 'bg-sky-500/25 border-sky-400/50 text-sky-200'
            : 'glass-panel opacity-85 hover:opacity-100'
        }`}
      >
        <Camera className="w-3 h-3" />
        <span>{attachScreenshot ? '已附带当前截屏' : '附带电脑截屏'}</span>
      </button>
      <button
        type="button"
        onClick={onSnapshotSystemCard}
        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full glass-panel hover:bg-white/10 transition"
      >
        <Cpu className="w-3 h-3 text-emerald-400" />
        <span>电脑速览</span>
      </button>
    </div>
  );
}
