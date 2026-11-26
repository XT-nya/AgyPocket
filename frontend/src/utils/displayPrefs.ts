export type DensityPreset = 'compact' | 'normal' | 'comfortable';

export interface DisplayPrefs {
  density: DensityPreset;
  letterSpacing: number;
  fontSize: number;
  lineHeight: number;
}

export const DISPLAY_PREFS_STORAGE_KEY = 'agypocket-display-prefs';

export const DENSITY_PRESETS: Record<
  DensityPreset,
  {
    label: string;
    desc: string;
    chatGap: string;
    chatPadX: string;
    bubblePadX: string;
    bubblePadY: string;
    bubbleMaxW: string;
    proseMargin: string;
    fontSize: number;
    lineHeight: number;
    letterSpacing: number;
  }
> = {
  compact: {
    label: '紧凑高密',
    desc: '缩小气泡间隔与边距，同屏容纳更多内容',
    chatGap: '0.45rem',
    chatPadX: '0.5rem',
    bubblePadX: '0.68rem',
    bubblePadY: '0.45rem',
    bubbleMaxW: '96%',
    proseMargin: '0.28em',
    fontSize: 13.5,
    lineHeight: 1.48,
    letterSpacing: -0.01,
  },
  normal: {
    label: '标准均衡',
    desc: '兼顾信息密度与段落呼吸感',
    chatGap: '0.7rem',
    chatPadX: '0.75rem',
    bubblePadX: '0.85rem',
    bubblePadY: '0.6rem',
    bubbleMaxW: '91%',
    proseMargin: '0.4em',
    fontSize: 14.5,
    lineHeight: 1.58,
    letterSpacing: 0,
  },
  comfortable: {
    label: '宽松舒展',
    desc: '更大字号、行距与气泡留白',
    chatGap: '1rem',
    chatPadX: '1rem',
    bubblePadX: '1rem',
    bubblePadY: '0.75rem',
    bubbleMaxW: '86%',
    proseMargin: '0.5em',
    fontSize: 15.5,
    lineHeight: 1.68,
    letterSpacing: 0.015,
  },
};

export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = {
  density: 'compact',
  letterSpacing: DENSITY_PRESETS.compact.letterSpacing,
  fontSize: DENSITY_PRESETS.compact.fontSize,
  lineHeight: DENSITY_PRESETS.compact.lineHeight,
};

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function sanitizeDisplayPrefs(raw: Partial<DisplayPrefs> | null | undefined): DisplayPrefs {
  const density: DensityPreset =
    raw?.density === 'normal' || raw?.density === 'comfortable' || raw?.density === 'compact'
      ? raw.density
      : DEFAULT_DISPLAY_PREFS.density;
  const preset = DENSITY_PRESETS[density];
  return {
    density,
    letterSpacing: clamp(Number(raw?.letterSpacing), -0.04, 0.08, preset.letterSpacing),
    fontSize: clamp(Number(raw?.fontSize), 12, 16, preset.fontSize),
    lineHeight: clamp(Number(raw?.lineHeight), 1.3, 1.75, preset.lineHeight),
  };
}

export function loadDisplayPrefs(): DisplayPrefs {
  try {
    const raw = localStorage.getItem(DISPLAY_PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DISPLAY_PREFS };
    return sanitizeDisplayPrefs(JSON.parse(raw) as Partial<DisplayPrefs>);
  } catch {
    return { ...DEFAULT_DISPLAY_PREFS };
  }
}

export function saveDisplayPrefs(prefs: DisplayPrefs): void {
  try {
    localStorage.setItem(DISPLAY_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage quota errors
  }
}

export function applyDisplayPrefs(prefs: DisplayPrefs): void {
  const clean = sanitizeDisplayPrefs(prefs);
  const preset = DENSITY_PRESETS[clean.density];
  const root = document.documentElement;
  root.dataset.density = clean.density;
  root.style.setProperty('--chat-gap', preset.chatGap);
  root.style.setProperty('--chat-pad-x', preset.chatPadX);
  root.style.setProperty('--bubble-pad-x', preset.bubblePadX);
  root.style.setProperty('--bubble-pad-y', preset.bubblePadY);
  root.style.setProperty('--bubble-max-w', preset.bubbleMaxW);
  root.style.setProperty('--prose-p-margin', preset.proseMargin);
  root.style.setProperty('--chat-font-size', `${clean.fontSize}px`);
  root.style.setProperty('--chat-line-height', String(clean.lineHeight));
  root.style.setProperty('--chat-letter-spacing', `${clean.letterSpacing}em`);
}
