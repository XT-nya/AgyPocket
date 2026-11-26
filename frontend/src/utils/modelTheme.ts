export interface ModelThemePalette {
  id: string;
  dotColor: string;
  accentText: string;
  stops: [string, string, string, string];
  glowRgba: string;
}

const MODEL_THEMES: Record<string, ModelThemePalette> = {
  neon: {
    id: 'neon',
    dotColor: '#e14d67',
    accentText: '#fb7185',
    stops: ['#3d0d26', '#7a193f', '#a82c52', '#d64565'],
    glowRgba: 'rgba(225, 77, 103, 0.45)',
  },
  carbon: {
    id: 'carbon',
    dotColor: '#c78c3c',
    accentText: '#fbbf24',
    stops: ['#241b11', '#533b1d', '#8c6129', '#c78c3c'],
    glowRgba: 'rgba(199, 140, 60, 0.42)',
  },
  argon: {
    id: 'argon',
    dotColor: '#7c5ce6',
    accentText: '#a78bfa',
    stops: ['#19163c', '#342c7a', '#533ba6', '#7c5ce6'],
    glowRgba: 'rgba(124, 92, 230, 0.45)',
  },
  hydrogen: {
    id: 'hydrogen',
    dotColor: '#38a3c7',
    accentText: '#38bdf8',
    stops: ['#0d2e45', '#155275', '#217c9e', '#38a3c7'],
    glowRgba: 'rgba(56, 163, 199, 0.45)',
  },
  flash: {
    id: 'flash',
    dotColor: '#eab308',
    accentText: '#facc15',
    stops: ['#3a2d0a', '#6e5412', '#a37b18', '#cca024'],
    glowRgba: 'rgba(234, 179, 8, 0.42)',
  },
  opus: {
    id: 'opus',
    dotColor: '#e07b53',
    accentText: '#f4a37f',
    stops: ['#3a1d10', '#843b1c', '#bc5a2e', '#e07b53'],
    glowRgba: 'rgba(224, 123, 83, 0.45)',
  },
  sonnet: {
    id: 'sonnet',
    dotColor: '#e07b53',
    accentText: '#f4a37f',
    stops: ['#33221d', '#6e3c2e', '#9c5640', '#d97757'],
    glowRgba: 'rgba(217, 119, 87, 0.45)',
  },
  orchestrator: {
    id: 'orchestrator',
    dotColor: '#f06a82',
    accentText: '#fda4af',
    stops: ['#3d0d26', '#6b1a44', '#8e244c', '#b33856'],
    glowRgba: 'rgba(240, 106, 130, 0.48)',
  },
  default: {
    id: 'default',
    dotColor: '#7c5ce6',
    accentText: '#93c5fd',
    stops: ['#172044', '#2b4594', '#4668c9', '#60a5fa'],
    glowRgba: 'rgba(96, 165, 250, 0.42)',
  },
};

export function resolveModelTheme(modelIdOrFamily: string): ModelThemePalette {
  const s = (modelIdOrFamily || '').toLowerCase();
  if (!s) return MODEL_THEMES.default;
  if (s.includes('orchestrator') || s.includes('planner')) return MODEL_THEMES.orchestrator;
  if (s.includes('neon')) return MODEL_THEMES.neon;
  if (s.includes('carbon')) return MODEL_THEMES.carbon;
  if (s.includes('argon')) return MODEL_THEMES.argon;
  if (s.includes('hydrogen')) return MODEL_THEMES.hydrogen;
  if (s.includes('flash')) return MODEL_THEMES.flash;
  if (s.includes('opus')) return MODEL_THEMES.opus;
  if (s.includes('sonnet') || s.includes('claude')) return MODEL_THEMES.sonnet;
  return MODEL_THEMES.default;
}

export function extractEffortBadge(displayName: string, fixedNote = ''): string {
  const match = /\(([^)]+)\)/.exec(displayName || '');
  if (match) return match[1].trim();
  const note = (fixedNote || '').toLowerCase();
  if (note.includes('medium')) return 'Medium';
  if (note.includes('high')) return 'High';
  if (note.includes('low')) return 'Low';
  return '';
}
