export type WsState = 'connecting' | 'open' | 'closed';

export class ManagedWebSocket {
  private path: string;
  private ws: WebSocket | null = null;
  private closedManually = false;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private onJson: (data: Record<string, unknown>) => void;
  private onBinary?: (buf: Blob) => void;
  private onState?: (state: WsState) => void;

  constructor(opts: {
    path: string;
    onJson: (data: Record<string, unknown>) => void;
    onBinary?: (buf: Blob) => void;
    onState?: (state: WsState) => void;
  }) {
    this.path = opts.path;
    this.onJson = opts.onJson;
    this.onBinary = opts.onBinary;
    this.onState = opts.onState;
  }

  connect() {
    this.closedManually = false;
    this.openSocket();
  }

  private openSocket() {
    if (this.closedManually) return;
    this.onState?.('connecting');
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}${this.path}`;
    const socket = new WebSocket(url);
    this.ws = socket;

    socket.onopen = () => {
      this.onState?.('open');
      if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = window.setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.sendJson({ type: 'ping' });
        }
      }, 25000);
    };

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const parsed = JSON.parse(event.data);
          this.onJson(parsed);
        } catch {
          // ignore malformed messages
        }
      } else if (event.data instanceof Blob) {
        this.onBinary?.(event.data);
      }
    };

    socket.onclose = (ev) => {
      this.onState?.('closed');
      if (this.heartbeatTimer) {
        window.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (!this.closedManually && ev.code !== 4401) {
        this.reconnectTimer = window.setTimeout(() => this.openSocket(), 2000);
      }
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  sendJson(payload: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  close() {
    this.closedManually = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.ws?.close();
    this.ws = null;
  }
}
