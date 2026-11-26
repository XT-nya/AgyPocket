export type PermissionTier = 'auto' | 'full' | 'controlled' | 'readonly';
export type ApprovalPolicy = 'remote_smart' | 'remote_all' | 'desktop_only';
export type ApprovalDecision = 'auto_approve' | 'deny' | 'allow';

export interface PermissionSpec {
  id: PermissionTier;
  label: string;
  short_label: string;
  description: string;
  cli_flags: string[];
}

export interface AuthStatus {
  authenticated: boolean;
  needs_setup: boolean;
  totp_enabled: boolean;
  is_loopback: boolean;
  device_name?: string;
  connection_mode?: 'fixed' | 'temp';
}

export interface SettingsData {
  port: number;
  default_permission_mode: PermissionTier;
  approval_policy: ApprovalPolicy;
  approval_timeout_seconds: number;
  default_project_id: string;
  workspace_dir: string;
  device_name?: string;
  connection_mode?: 'fixed' | 'temp';
  model: string;
  prevent_sleep: boolean;
  tunnel_mode: 'quick' | 'named' | 'external';
  named_tunnel_configured?: boolean;
  external_public_url?: string;
  cloudflared_path?: string;
  message_dispatch_mode?: 'native_first' | 'bridge_only';
  screen_fps: number;
  screen_quality: number;
  screen_scale: number;
}

export interface ProjectItem {
  id: string;
  name: string;
  folders: string[];
  primary_folder: string;
  is_bound: boolean;
}

export interface ProjectsResponse {
  projects: ProjectItem[];
  bound_project_id: string;
}

export interface ModelEffortTier {
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  label: string;
  model_id: string;
  display_name: string;
}

export interface ModelPlannerOption {
  id: string;
  label: string;
  model_id: string;
  display_name: string;
}

export interface ModelFamily {
  family_id: string;
  display_name: string;
  provider: string;
  adjustable: boolean;
  default_model_id: string;
  default_effort: string;
  efforts: ModelEffortTier[];
  planners: ModelPlannerOption[];
  fixed_note: string;
}

export interface ModelsCatalogResponse {
  families: ModelFamily[];
  fetched_at: number;
  cached: boolean;
  error: string;
}

export interface BridgeStatus {
  plugin_installed: boolean;
  plugin_enabled: boolean;
  sidecar_running: boolean;
  agentapi_available: boolean;
  bound_project_id: string;
  needs_app_restart: boolean;
  detail: string;
}

export interface PendingApproval {
  approval_id: string;
  conversation_id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  summary: string;
  detail: string;
  model_name: string;
  step_idx: number | null;
  created_at: number;
  expires_at: number;
  status: string;
  decision: string;
}

export interface ConversationTelemetry {
  model_name: string;
  uncached_input: number;
  cache_read: number;
  cache_write: number;
  output_tokens: number;
  active_context_tokens: number;
  context_limit: number | null;
  usage_percent: number | null;
  step_count?: number;
  request_count?: number;
}

export interface CardPayload<T = Record<string, unknown>> {
  cardType: string;
  id: string;
  data: T;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thought: string;
  cards: CardPayload[];
  timestamp: number;
  status: 'streaming' | 'done' | 'error' | 'aborted';
}

export interface SessionSummary {
  id: string;
  title: string;
  agy_conversation_id: string;
  project_id?: string;
  workspace_dir: string;
  permission_mode: PermissionTier;
  model: string;
  active_model?: string;
  app_status?: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  source?: 'pocket' | 'antigravity_local';
  sync_fingerprint?: string;
  last_synced_at?: number;
  step_count?: number;
}

export interface SessionDetail extends Omit<SessionSummary, 'message_count'> {
  messages: ChatMessage[];
}

export interface AlignLocalItem {
  conversation_id: string;
  session_id: string;
  title: string;
  project_id?: string;
  workspace_dir: string;
  active_model?: string;
  app_status?: string;
  step_count: number;
  updated_at: number;
  fingerprint: string;
  status: 'new' | 'needs_update' | 'up_to_date';
  server_cached: boolean;
}

export interface AlignLocalResponse {
  items: AlignLocalItem[];
  counts: {
    total: number;
    new: number;
    needs_update: number;
    up_to_date: number;
  };
}

export interface PullLocalResponse {
  synced_sessions: SessionDetail[];
  parsed_count: number;
  cache_hit_count: number;
}

export interface TelemetryData {
  cpu_percent: number;
  ram_percent: number;
  ram_used_gb: number;
  ram_total_gb: number;
  disk_percent: number;
  battery: { percent: number; plugged_in: boolean } | null;
  foreground_window: string;
  uptime_seconds: number;
  prevent_sleep: boolean;
}

export interface DesktopControlItem {
  index: number;
  name: string;
  role: string;
  rect: [number, number, number, number];
  center: [number, number];
  norm_rect: [number, number, number, number];
  norm_center: [number, number];
}

export interface ControlsScanResult {
  window_title: string;
  monitor_index: number;
  screen_left: number;
  screen_top: number;
  screen_width: number;
  screen_height: number;
  controls: DesktopControlItem[];
}

export interface PluginManifestItem {
  id: string;
  name: string;
  version: string;
  description: string;
  slots: string[];
  card_types: string[];
  enabled: boolean;
}

export interface PluginContributions {
  plugins: PluginManifestItem[];
  slots: {
    'bottom-capsule': {
      plugin_id: string;
      model: string;
      permission_mode: PermissionTier;
      approval_policy?: ApprovalPolicy;
      status: string;
      prevent_sleep: boolean;
    };
    'quick-toolbar': Array<{
      id: string;
      label: string;
      insert?: string;
      toggle?: string;
      plugin_action?: [string, string];
    }>;
  };
}

export class ApiError extends Error {
  status: number;
  detail: string;
  retryAfter?: number;

  constructor(status: number, detail: string, retryAfter?: number) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

function getCookie(name: string): string {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrf = getCookie('agypocket_csrf');
    if (csrf) {
      headers.set('X-CSRF-Token', csrf);
    }
  }

  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const json = await res.json();
      detail = json.detail || detail;
    } catch {
      // ignore non-json error bodies
    }
    const retryHeader = res.headers.get('Retry-After');
    const retryAfter = retryHeader ? parseInt(retryHeader, 10) : undefined;
    throw new ApiError(res.status, detail, Number.isFinite(retryAfter) ? retryAfter : undefined);
  }
  return res.json() as Promise<T>;
}

export const api = {
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  setupAuth: (passphrase: string) =>
    request<{ ok: boolean }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ passphrase }),
    }),
  login: (passphrase: string, totp_code = '') =>
    request<{ ok: boolean }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ passphrase, totp_code }),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  revokeAll: () => request<{ ok: boolean; message: string }>('/api/auth/revoke-all', { method: 'POST' }),
  createPairToken: () =>
    request<{
      token: string;
      expires_at: number;
      pair_path: string;
      mode?: 'fixed' | 'temp';
      device_name?: string;
      qr_path?: string;
    }>('/api/auth/pair-token', {
      method: 'POST',
    }),
  totpSetup: () =>
    request<{ secret: string; otpauth_uri: string; qr_png_base64: string }>('/api/auth/totp/setup', {
      method: 'POST',
    }),
  totpEnable: (passphrase: string, code: string) =>
    request<{ ok: boolean; totp_enabled: boolean }>('/api/auth/totp/enable', {
      method: 'POST',
      body: JSON.stringify({ passphrase, code }),
    }),
  totpDisable: (passphrase: string, code: string) =>
    request<{ ok: boolean; totp_enabled: boolean }>('/api/auth/totp/disable', {
      method: 'POST',
      body: JSON.stringify({ passphrase, code }),
    }),

  getSettings: () =>
    request<{
      settings: SettingsData;
      permission_tiers: PermissionSpec[];
      agy: { installed: boolean; path: string; running: boolean };
      bridge: BridgeStatus;
      projects: ProjectsResponse;
    }>('/api/settings'),
  updateSettings: (patch: Partial<SettingsData>) =>
    request<{ ok: boolean; settings: SettingsData }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  listProjects: () => request<ProjectsResponse>('/api/projects'),
  setDefaultProject: (project_id: string) =>
    request<{ ok: boolean; bound_project_id: string; restart_recommended: boolean }>('/api/projects/default', {
      method: 'POST',
      body: JSON.stringify({ project_id }),
    }),
  listModels: (refresh = false) => request<ModelsCatalogResponse>(`/api/models?refresh=${refresh ? 'true' : 'false'}`),
  getBridgeStatus: () => request<BridgeStatus>('/api/bridge/status'),
  listPendingApprovals: () => request<{ pending: PendingApproval[] }>('/api/approvals/pending'),
  decideApproval: (approval_id: string, decision: ApprovalDecision, reason = '') =>
    request<{ ok: boolean; approval_id: string; decision: ApprovalDecision }>(
      `/api/approvals/${approval_id}/decide`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, reason }),
      }
    ),

  listSessions: () => request<{ sessions: SessionSummary[] }>('/api/sessions'),
  createSession: (
    payload: {
      title?: string;
      workspace_dir?: string;
      permission_mode?: PermissionTier;
      model?: string;
      project_id?: string;
    } = {}
  ) =>
    request<{ session: SessionDetail }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getSession: (id: string) =>
    request<{ session: SessionDetail; running: boolean; telemetry: ConversationTelemetry | null }>(
      `/api/sessions/${id}`
    ),
  getSessionTelemetry: (id: string) =>
    request<{ telemetry: ConversationTelemetry | null }>(`/api/sessions/${id}/telemetry`),
  forkSessionWithModel: (id: string, model: string, prompt = '') =>
    request<{ session: SessionDetail }>(`/api/sessions/${id}/fork-model`, {
      method: 'POST',
      body: JSON.stringify({ model, prompt }),
    }),
  patchSession: (id: string, patch: Partial<SessionSummary>) =>
    request<{ session: SessionDetail }>(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),

  alignLocalSessions: (client_fingerprints: Record<string, string>) =>
    request<AlignLocalResponse>('/api/sync/local/align', {
      method: 'POST',
      body: JSON.stringify({ client_fingerprints }),
    }),
  pullLocalSessions: (conversation_ids?: string[], client_fingerprints: Record<string, string> = {}) =>
    request<PullLocalResponse>('/api/sync/local/pull', {
      method: 'POST',
      body: JSON.stringify({ conversation_ids: conversation_ids ?? null, client_fingerprints }),
    }),

  getPluginContributions: () => request<PluginContributions>('/api/plugins/contributions'),
  dispatchPluginAction: (pluginId: string, actionId: string, payload: Record<string, unknown> = {}) =>
    request<Record<string, unknown>>(`/api/plugins/${pluginId}/action`, {
      method: 'POST',
      body: JSON.stringify({ action_id: actionId, payload }),
    }),

  getTelemetry: () => request<TelemetryData>('/api/desktop/telemetry'),
  getMonitors: () =>
    request<{ monitors: Array<{ index: number; left: number; top: number; width: number; height: number }> }>(
      '/api/desktop/monitors'
    ),
  scanControls: (monitorIndex = 1) => request<ControlsScanResult>(`/api/desktop/controls?monitor_index=${monitorIndex}`),
  clickControl: (x: number, y: number, action: 'click' | 'double_click' | 'right_click' = 'click') =>
    request<{ ok: boolean }>('/api/desktop/click-control', {
      method: 'POST',
      body: JSON.stringify({ x, y, action }),
    }),
  desktopAction: (payload: {
    kind: 'mouse' | 'text' | 'hotkey';
    action?: string;
    x?: number;
    y?: number;
    delta?: number;
    count?: number;
    interval_ms?: number;
    to_x?: number;
    to_y?: number;
    text?: string;
    hotkey?: string;
  }) =>
    request<{ ok: boolean }>('/api/desktop/action', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  emergencyEsc: () => request<{ ok: boolean; message: string }>('/api/desktop/emergency-esc', { method: 'POST' }),

  tunnelStatus: () =>
    request<{ status: string; mode: string; public_url: string; binary_exists: boolean; last_error: string }>(
      '/api/tunnel/status'
    ),
  killTunnel: () => request<{ status: string }>('/api/tunnel/kill', { method: 'POST' }),
};
