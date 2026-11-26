export type CanvasBoundaryMode = 'free_margin' | 'edge_snap';

export type ToolbarButtonKey =
  | 'left_click'
  | 'double_click'
  | 'right_click'
  | 'left_hold'
  | 'right_hold'
  | 'drag'
  | 'rapid_click'
  | 'scroll_up'
  | 'scroll_down';

export type RapidClickCount = 2 | 3 | 5 | 10;

export interface RemotePrefs {
  canvasBoundaryMode: CanvasBoundaryMode;
  toolbarButtons: Record<ToolbarButtonKey, boolean>;
  rapidClickCount: RapidClickCount;
}

export const REMOTE_PREFS_STORAGE_KEY = 'agypocket-remote-prefs';

export const TOOLBAR_BUTTON_ITEMS: Array<{
  key: ToolbarButtonKey;
  label: string;
  desc: string;
}> = [
  { key: 'left_click', label: '左键点击', desc: '单次左键点击准星位置' },
  { key: 'double_click', label: '双击', desc: '左键连续双击' },
  { key: 'right_click', label: '右键', desc: '打开右键菜单' },
  { key: 'left_hold', label: '左键按住', desc: '切换左键按住/松开（配合移动可框选或绘图）' },
  { key: 'right_hold', label: '右键按住', desc: '切换右键按住/松开（3D 视角旋转常用）' },
  { key: 'drag', label: '按住拖动', desc: '锁定起点并画线预览，再点击松开完成拖拽' },
  { key: 'rapid_click', label: '连点', desc: '点按触发固定次数连点，长按持续连点' },
  { key: 'scroll_up', label: '上滚', desc: '鼠标滚轮向上滚动' },
  { key: 'scroll_down', label: '下滚', desc: '鼠标滚轮向下滚动' },
];

export const RAPID_CLICK_OPTIONS: RapidClickCount[] = [2, 3, 5, 10];

export const DEFAULT_REMOTE_PREFS: RemotePrefs = {
  canvasBoundaryMode: 'free_margin',
  toolbarButtons: {
    left_click: true,
    double_click: true,
    right_click: true,
    left_hold: true,
    right_hold: false,
    drag: true,
    rapid_click: true,
    scroll_up: true,
    scroll_down: true,
  },
  rapidClickCount: 3,
};

export function sanitizeRemotePrefs(raw: Partial<RemotePrefs> | null | undefined): RemotePrefs {
  const canvasBoundaryMode: CanvasBoundaryMode =
    raw?.canvasBoundaryMode === 'edge_snap' ? 'edge_snap' : 'free_margin';

  const rawButtons = (raw?.toolbarButtons ?? {}) as Partial<Record<ToolbarButtonKey, unknown>>;
  const toolbarButtons = { ...DEFAULT_REMOTE_PREFS.toolbarButtons };
  for (const item of TOOLBAR_BUTTON_ITEMS) {
    if (typeof rawButtons[item.key] === 'boolean') {
      toolbarButtons[item.key] = Boolean(rawButtons[item.key]);
    }
  }

  const rawCount = Number(raw?.rapidClickCount);
  const rapidClickCount: RapidClickCount = RAPID_CLICK_OPTIONS.includes(rawCount as RapidClickCount)
    ? (rawCount as RapidClickCount)
    : DEFAULT_REMOTE_PREFS.rapidClickCount;

  return {
    canvasBoundaryMode,
    toolbarButtons,
    rapidClickCount,
  };
}

export function loadRemotePrefs(): RemotePrefs {
  try {
    const raw = localStorage.getItem(REMOTE_PREFS_STORAGE_KEY);
    if (!raw) {
      return {
        ...DEFAULT_REMOTE_PREFS,
        toolbarButtons: { ...DEFAULT_REMOTE_PREFS.toolbarButtons },
      };
    }
    return sanitizeRemotePrefs(JSON.parse(raw) as Partial<RemotePrefs>);
  } catch {
    return {
      ...DEFAULT_REMOTE_PREFS,
      toolbarButtons: { ...DEFAULT_REMOTE_PREFS.toolbarButtons },
    };
  }
}

export function saveRemotePrefs(prefs: RemotePrefs): void {
  try {
    localStorage.setItem(REMOTE_PREFS_STORAGE_KEY, JSON.stringify(sanitizeRemotePrefs(prefs)));
  } catch {
    // ignore storage quota errors
  }
}
