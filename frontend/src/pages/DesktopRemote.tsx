import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronUp,
  Crosshair,
  Hand,
  Hash,
  Keyboard,
  Lock,
  Maximize2,
  Minimize2,
  Monitor,
  MousePointerClick,
  Move,
  OctagonAlert,
  Pause,
  Play,
  RotateCw,
  ScanSearch,
  Send,
  SlidersHorizontal,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { api, type DesktopControlItem, type TelemetryData } from '../api/client';
import { ManagedWebSocket } from '../api/ws';
import {
  type CanvasBoundaryMode,
  type RemotePrefs,
  TOOLBAR_BUTTON_ITEMS,
  type ToolbarButtonKey,
} from '../utils/remotePrefs';

interface DesktopRemoteProps {
  fullscreen: boolean;
  remotePrefs: RemotePrefs;
  onFullscreenChange: (fs: boolean) => void;
  onToast: (msg: string) => void;
}

interface AgyPocketNativeBridge {
  isNativeApp?: () => boolean;
  setRemoteFullscreen?: (enable: boolean) => void;
  openServerConfig?: () => void;
  openQrScanner?: () => void;
  openManual?: () => void;
  getServerUrl?: () => string;
}

function getNativeBridge(): AgyPocketNativeBridge | undefined {
  return (window as unknown as { AgyPocketNative?: AgyPocketNativeBridge }).AgyPocketNative;
}

interface FrameMeta {
  width: number;
  height: number;
  monitor_left: number;
  monitor_top: number;
  monitor_width: number;
  monitor_height: number;
  screen_locked: boolean;
}

const HOTKEYS = [
  { label: 'Enter', chord: 'ENTER' },
  { label: '退格', chord: 'BACKSPACE' },
  { label: 'Tab', chord: 'TAB' },
  { label: 'Ctrl+C', chord: 'CTRL+C' },
  { label: 'Ctrl+V', chord: 'CTRL+V' },
  { label: 'Ctrl+Z', chord: 'CTRL+Z' },
  { label: 'Alt+Tab', chord: 'ALT+TAB' },
  { label: 'Win', chord: 'WIN' },
];

function clampPanAxis(
  val: number,
  viewSize: number,
  stageSize: number,
  boundaryMode: CanvasBoundaryMode
): number {
  if (viewSize <= 0 || stageSize <= 0) return 0;
  if (boundaryMode === 'edge_snap') {
    const maxOffset = Math.max(0, (stageSize - viewSize) / 2);
    return Math.max(-maxOffset, Math.min(maxOffset, val));
  }
  const edgeSlack = Math.max(0, (stageSize - viewSize) / 2) + viewSize * 0.42;
  const minVisible = Math.max(viewSize * 0.18, Math.min(stageSize, viewSize) * 0.18);
  const visibleBound = (viewSize + stageSize) / 2 - minVisible;
  const limit = Math.max(0, Math.min(edgeSlack, visibleBound));
  return Math.max(-limit, Math.min(limit, val));
}

function clampPan(
  next: { x: number; y: number },
  vw: number,
  vh: number,
  sw: number,
  sh: number,
  boundaryMode: CanvasBoundaryMode
): { x: number; y: number } {
  return {
    x: clampPanAxis(next.x, vw, sw, boundaryMode),
    y: clampPanAxis(next.y, vh, sh, boundaryMode),
  };
}

export function DesktopRemote({ fullscreen, remotePrefs, onFullscreenChange, onToast }: DesktopRemoteProps) {
  const [frameUrl, setFrameUrl] = useState<string>('');
  const [meta, setMeta] = useState<FrameMeta>({
    width: 1920,
    height: 1080,
    monitor_left: 0,
    monitor_top: 0,
    monitor_width: 1920,
    monitor_height: 1080,
    screen_locked: false,
  });
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [preset, setPreset] = useState<'fast' | 'balanced' | 'hd'>('balanced');
  const [paused, setPaused] = useState(false);
  const [mode, setMode] = useState<'crosshair' | 'controls'>('crosshair');
  const [touchBehavior, setTouchBehavior] = useState<'aim' | 'pan'>('aim');
  const [controls, setControls] = useState<DesktopControlItem[]>([]);
  const [controlsWindow, setControlsWindow] = useState('');
  const [controlFilter, setControlFilter] = useState('');
  const [scanning, setScanning] = useState(false);

  // Fullscreen & virtual landscape rotation state
  const [virtualLandscape, setVirtualLandscape] = useState(false);
  const [hudCollapsed, setHudCollapsed] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [isPortrait, setIsPortrait] = useState(() =>
    typeof window !== 'undefined' ? window.innerHeight > window.innerWidth : true
  );

  // Crosshair, pan, zoom & advanced mouse states
  const [aimNorm, setAimNorm] = useState<{ x: number; y: number }>({ x: 0.5, y: 0.5 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({ w: 360, h: 400 });
  const [textInput, setTextInput] = useState('');
  const [leftHeld, setLeftHeld] = useState(false);
  const [rightHeld, setRightHeld] = useState(false);
  const [dragOrigin, setDragOrigin] = useState<{ nx: number; ny: number; sx: number; sy: number } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<ManagedWebSocket | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const prevUrlRef = useRef<string>('');
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const pinchStartRef = useRef<{
    dist: number;
    midX: number;
    midY: number;
    zoom: number;
    panX: number;
    panY: number;
  } | null>(null);
  const enteredNativeFsRef = useRef(false);

  const lastMoveSentRef = useRef<number>(0);
  const rapidHoldTimerRef = useRef<number | null>(null);
  const rapidIntervalRef = useRef<number | null>(null);
  const rapidTriggeredContinuousRef = useRef<boolean>(false);
  const rapidPointerActiveRef = useRef<boolean>(false);

  const leftHeldRef = useRef(leftHeld);
  const rightHeldRef = useRef(rightHeld);
  const dragOriginRef = useRef(dragOrigin);
  const aimCoordsRef = useRef({ sx: 960, sy: 540 });

  useEffect(() => {
    leftHeldRef.current = leftHeld;
  }, [leftHeld]);
  useEffect(() => {
    rightHeldRef.current = rightHeld;
  }, [rightHeld]);
  useEffect(() => {
    dragOriginRef.current = dragOrigin;
  }, [dragOrigin]);

  const computeStageDimensions = useCallback(
    (z: number) => {
      const aspect = (meta.monitor_width || 16) / (meta.monitor_height || 9);
      const pad = fullscreen ? 4 : 16;
      const availW = Math.max(200, viewportSize.w - pad);
      const availH = Math.max(160, viewportSize.h - pad);
      const baseW = Math.min(availW, availH * aspect);
      const width = Math.round(baseW * z);
      const height = Math.round(width / aspect);
      return { width, height };
    },
    [meta.monitor_width, meta.monitor_height, viewportSize.w, viewportSize.h, fullscreen]
  );

  const stageDimensions = useMemo(() => computeStageDimensions(zoom), [computeStageDimensions, zoom]);

  const sendMouseAction = useCallback(
    async (payload: {
      action: string;
      x: number;
      y: number;
      delta?: number;
      count?: number;
      interval_ms?: number;
      to_x?: number;
      to_y?: number;
    }) => {
      const sentViaWs = wsRef.current?.sendJson({ type: 'mouse', ...payload });
      if (sentViaWs) return;
      await api.desktopAction({ kind: 'mouse', ...payload });
    },
    []
  );

  const stopRapidTimers = useCallback(() => {
    if (rapidHoldTimerRef.current !== null) {
      window.clearTimeout(rapidHoldTimerRef.current);
      rapidHoldTimerRef.current = null;
    }
    if (rapidIntervalRef.current !== null) {
      window.clearInterval(rapidIntervalRef.current);
      rapidIntervalRef.current = null;
    }
  }, []);

  const releaseAllHeldInputs = useCallback(() => {
    stopRapidTimers();
    rapidPointerActiveRef.current = false;
    rapidTriggeredContinuousRef.current = false;

    const { sx, sy } = aimCoordsRef.current;
    if (leftHeldRef.current || dragOriginRef.current) {
      leftHeldRef.current = false;
      dragOriginRef.current = null;
      setLeftHeld(false);
      setDragOrigin(null);
      void sendMouseAction({ action: 'left_up', x: sx, y: sy }).catch(() => {});
    }
    if (rightHeldRef.current) {
      rightHeldRef.current = false;
      setRightHeld(false);
      void sendMouseAction({ action: 'right_up', x: sx, y: sy }).catch(() => {});
    }
  }, [sendMouseAction, stopRapidTimers]);

  useEffect(() => {
    const onResize = () => {
      const portrait = window.innerHeight > window.innerWidth;
      setIsPortrait(portrait);
      if (!portrait) {
        setVirtualLandscape(false);
      }
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        releaseAllHeldInputs();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      releaseAllHeldInputs();
    };
  }, [releaseAllHeldInputs]);

  useEffect(() => {
    releaseAllHeldInputs();
  }, [fullscreen, releaseAllHeldInputs]);

  useEffect(() => {
    const onFsChange = () => {
      const active = Boolean(
        document.fullscreenElement ||
          (document as unknown as { webkitFullscreenElement?: Element | null }).webkitFullscreenElement
      );
      if (!active && enteredNativeFsRef.current) {
        enteredNativeFsRef.current = false;
        setVirtualLandscape(false);
        setHudCollapsed(false);
        setKeyboardOpen(false);
        getNativeBridge()?.setRemoteFullscreen?.(false);
        onFullscreenChange(false);
        try {
          (screen.orientation as { unlock?: () => void })?.unlock?.();
        } catch {
          // ignore
        }
      }
    };
    const onNativeExit = () => {
      enteredNativeFsRef.current = false;
      setVirtualLandscape(false);
      setHudCollapsed(false);
      setKeyboardOpen(false);
      onFullscreenChange(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    window.addEventListener('agypocket-exit-fullscreen', onNativeExit);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      window.removeEventListener('agypocket-exit-fullscreen', onNativeExit);
    };
  }, [onFullscreenChange]);

  const enterFullscreen = useCallback(async () => {
    onFullscreenChange(true);
    setHudCollapsed(false);
    setKeyboardOpen(false);

    const nativeBridge = getNativeBridge();
    if (nativeBridge?.setRemoteFullscreen) {
      nativeBridge.setRemoteFullscreen(true);
    }

    const el = rootRef.current as
      | (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> })
      | null;
    if (el && !nativeBridge?.isNativeApp?.()) {
      try {
        if (el.requestFullscreen) {
          await el.requestFullscreen();
          enteredNativeFsRef.current = true;
        } else if (el.webkitRequestFullscreen) {
          await el.webkitRequestFullscreen();
          enteredNativeFsRef.current = true;
        }
      } catch {
        enteredNativeFsRef.current = false;
      }
    }

    try {
      const orient = screen.orientation as { lock?: (mode: string) => Promise<void> } | undefined;
      if (orient?.lock && !nativeBridge?.isNativeApp?.()) {
        await orient.lock('landscape');
      }
    } catch {
      // Orientation lock not permitted in many mobile browsers / WebViews; fallback below handles it
    }

    const waitMs = nativeBridge?.isNativeApp?.() ? 320 : 120;
    window.setTimeout(() => {
      const stillPortrait = window.innerHeight > window.innerWidth;
      if (stillPortrait) {
        setVirtualLandscape(true);
        onToast('已进入全屏横屏（已自动顺时针旋转90°，可点顶部旋转按钮切换）');
      }
    }, waitMs);
  }, [onFullscreenChange, onToast]);

  const exitFullscreen = useCallback(async () => {
    enteredNativeFsRef.current = false;
    setVirtualLandscape(false);
    setHudCollapsed(false);
    setKeyboardOpen(false);
    getNativeBridge()?.setRemoteFullscreen?.(false);
    onFullscreenChange(false);
    try {
      (screen.orientation as { unlock?: () => void })?.unlock?.();
    } catch {
      // ignore
    }
    try {
      const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> };
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (doc.webkitExitFullscreen) {
        await doc.webkitExitFullscreen();
      }
    } catch {
      // ignore
    }
  }, [onFullscreenChange]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const updateSize = () => {
      setViewportSize({ w: el.clientWidth, h: el.clientHeight });
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fullscreen, virtualLandscape]);

  useEffect(() => {
    setPan((prev) =>
      clampPan(
        prev,
        viewportSize.w,
        viewportSize.h,
        stageDimensions.width,
        stageDimensions.height,
        remotePrefs.canvasBoundaryMode
      )
    );
  }, [
    viewportSize.w,
    viewportSize.h,
    stageDimensions.width,
    stageDimensions.height,
    remotePrefs.canvasBoundaryMode,
  ]);

  useEffect(() => {
    const ws = new ManagedWebSocket({
      path: '/ws/desktop',
      onJson: (msg) => {
        if (msg.type === 'frame_meta') {
          setMeta(msg as unknown as FrameMeta);
        } else if (msg.type === 'telemetry') {
          setTelemetry(msg.data as TelemetryData);
        }
      },
      onBinary: (blob) => {
        const nextUrl = URL.createObjectURL(blob);
        if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current);
        prevUrlRef.current = nextUrl;
        setFrameUrl(nextUrl);
      },
    });
    ws.connect();
    wsRef.current = ws;
    return () => {
      ws.close();
      if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current);
    };
  }, []);

  useEffect(() => {
    wsRef.current?.sendJson({ type: 'config', preset, paused });
  }, [preset, paused]);

  const handleScanControls = async () => {
    setScanning(true);
    try {
      const res = await api.scanControls(1);
      setControls(res.controls);
      setControlsWindow(res.window_title);
      setMode('controls');
      onToast(`已识别 ${res.controls.length} 个可点按钮/控件`);
    } catch {
      onToast('控件扫描失败');
    } finally {
      setScanning(false);
    }
  };

  const switchToControlsMode = () => {
    releaseAllHeldInputs();
    setMode('controls');
    if (controls.length === 0 && !scanning) {
      handleScanControls();
    }
  };

  const handleClickControl = async (ctrl: DesktopControlItem) => {
    try {
      await api.clickControl(ctrl.center[0], ctrl.center[1], 'click');
      onToast(`已点击 [${ctrl.index}] ${ctrl.name}`);
    } catch {
      onToast('点击失败');
    }
  };

  const aimScreenCoords = useMemo(() => {
    const sx = Math.round(meta.monitor_left + aimNorm.x * meta.monitor_width);
    const sy = Math.round(meta.monitor_top + aimNorm.y * meta.monitor_height);
    return { sx, sy };
  }, [aimNorm, meta]);

  useEffect(() => {
    aimCoordsRef.current = aimScreenCoords;
  }, [aimScreenCoords]);

  const updateCrosshairFromPointer = (clientX: number, clientY: number, pointerType: string) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;

    let nx: number;
    let ny: number;
    if (fullscreen && virtualLandscape) {
      // Container is rotated 90deg CW: screen +Y maps to logical +X, screen -X maps to logical +Y
      const fingerOffsetPx = pointerType === 'touch' ? 24 : 0;
      nx = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      ny = Math.max(0, Math.min(1, (rect.right - (clientX + fingerOffsetPx)) / rect.width));
    } else {
      const fingerOffsetPx = pointerType === 'touch' ? 28 : 0;
      nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      ny = Math.max(0, Math.min(1, (clientY - rect.top - fingerOffsetPx) / rect.height));
    }
    setAimNorm({ x: nx, y: ny });

    if (leftHeldRef.current || rightHeldRef.current || dragOriginRef.current) {
      const now = performance.now();
      if (now - lastMoveSentRef.current >= 40) {
        lastMoveSentRef.current = now;
        const sx = Math.round(meta.monitor_left + nx * meta.monitor_width);
        const sy = Math.round(meta.monitor_top + ny * meta.monitor_height);
        void sendMouseAction({ action: 'move', x: sx, y: sy }).catch(() => {});
      }
    }
  };

  const mapScreenDeltaToLogical = (dx: number, dy: number) => {
    if (fullscreen && virtualLandscape) {
      return { dx: dy, dy: -dx };
    }
    return { dx, dy };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;

    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (e.pointerType === 'touch' && activePointersRef.current.size === 2) {
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      pinchStartRef.current = { dist, midX, midY, zoom, panX: pan.x, panY: pan.y };
      panStartRef.current = null;
      return;
    }

    if (mode === 'crosshair') {
      if (touchBehavior === 'pan') {
        panStartRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      } else {
        updateCrosshairFromPointer(e.clientX, e.clientY, e.pointerType);
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch' && e.buttons === 0) {
      return;
    }
    if (activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (e.pointerType === 'touch' && activePointersRef.current.size === 2 && pinchStartRef.current) {
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const start = pinchStartRef.current;

      const nextZoom =
        start.dist > 10
          ? Math.max(1, Math.min(3.5, Number(((start.zoom * dist) / start.dist).toFixed(2))))
          : start.zoom;
      const nextStage = computeStageDimensions(nextZoom);
      const delta = mapScreenDeltaToLogical(midX - start.midX, midY - start.midY);
      setZoom(nextZoom);
      setPan(
        clampPan(
          { x: start.panX + delta.dx, y: start.panY + delta.dy },
          viewportSize.w,
          viewportSize.h,
          nextStage.width,
          nextStage.height,
          remotePrefs.canvasBoundaryMode
        )
      );
      return;
    }
    if (activePointersRef.current.size > 1) return;

    if (mode === 'crosshair') {
      if (touchBehavior === 'pan' && panStartRef.current) {
        const delta = mapScreenDeltaToLogical(
          e.clientX - panStartRef.current.x,
          e.clientY - panStartRef.current.y
        );
        setPan(
          clampPan(
            { x: panStartRef.current.panX + delta.dx, y: panStartRef.current.panY + delta.dy },
            viewportSize.w,
            viewportSize.h,
            stageDimensions.width,
            stageDimensions.height,
            remotePrefs.canvasBoundaryMode
          )
        );
      } else if (touchBehavior === 'aim') {
        updateCrosshairFromPointer(e.clientX, e.clientY, e.pointerType);
      }
    }
  };

  const handlePointerUpOrCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) {
      pinchStartRef.current = null;
    }
    if (activePointersRef.current.size === 0) {
      panStartRef.current = null;
    }
  };

  const resetCanvasView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setTouchBehavior('aim');
  };

  const triggerMouseAction = async (
    action: 'click' | 'double_click' | 'right_click' | 'scroll' | 'rapid_click',
    delta = 0
  ) => {
    try {
      await sendMouseAction({
        action,
        x: aimScreenCoords.sx,
        y: aimScreenCoords.sy,
        delta,
        count: action === 'rapid_click' ? remotePrefs.rapidClickCount : 1,
        interval_ms: 55,
      });
    } catch {
      onToast('鼠标指令发送失败');
    }
  };

  const toggleHoldButton = async (which: 'left' | 'right') => {
    const { sx, sy } = aimScreenCoords;
    try {
      if (which === 'left') {
        if (leftHeld) {
          await sendMouseAction({ action: 'left_up', x: sx, y: sy });
          setLeftHeld(false);
        } else {
          if (dragOrigin) setDragOrigin(null);
          await sendMouseAction({ action: 'left_down', x: sx, y: sy });
          setLeftHeld(true);
        }
      } else {
        if (rightHeld) {
          await sendMouseAction({ action: 'right_up', x: sx, y: sy });
          setRightHeld(false);
        } else {
          await sendMouseAction({ action: 'right_down', x: sx, y: sy });
          setRightHeld(true);
        }
      }
    } catch {
      onToast('按住状态切换失败');
    }
  };

  const toggleInteractiveDrag = async () => {
    const { sx, sy } = aimScreenCoords;
    try {
      if (!dragOrigin) {
        if (leftHeld) setLeftHeld(false);
        setDragOrigin({ nx: aimNorm.x, ny: aimNorm.y, sx, sy });
        await sendMouseAction({ action: 'left_down', x: sx, y: sy });
        onToast('已锁定拖动起点，移动准星后再次点击「松开完成」');
      } else {
        await sendMouseAction({ action: 'move', x: sx, y: sy });
        await sendMouseAction({ action: 'left_up', x: sx, y: sy });
        setDragOrigin(null);
        onToast('已完成拖动释放');
      }
    } catch {
      setDragOrigin(null);
      onToast('拖动指令失败');
    }
  };

  const handleRapidPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    stopRapidTimers();
    rapidPointerActiveRef.current = true;
    rapidTriggeredContinuousRef.current = false;
    rapidHoldTimerRef.current = window.setTimeout(() => {
      rapidTriggeredContinuousRef.current = true;
      void sendMouseAction({
        action: 'click',
        x: aimCoordsRef.current.sx,
        y: aimCoordsRef.current.sy,
      }).catch(() => {});
      rapidIntervalRef.current = window.setInterval(() => {
        void sendMouseAction({
          action: 'click',
          x: aimCoordsRef.current.sx,
          y: aimCoordsRef.current.sy,
        }).catch(() => {});
      }, 95);
    }, 280);
  };

  const handleRapidPointerEnd = () => {
    if (!rapidPointerActiveRef.current) return;
    rapidPointerActiveRef.current = false;
    stopRapidTimers();
    if (!rapidTriggeredContinuousRef.current) {
      void triggerMouseAction('rapid_click');
    }
    rapidTriggeredContinuousRef.current = false;
  };

  const handleSendText = async () => {
    if (!textInput) return;
    try {
      await api.desktopAction({ kind: 'text', text: textInput });
      setTextInput('');
      onToast('文本已输入到电脑光标处');
    } catch {
      onToast('文本发送失败');
    }
  };

  const handleHotkey = async (chord: string) => {
    try {
      await api.desktopAction({ kind: 'hotkey', hotkey: chord });
    } catch {
      onToast('快捷键发送失败');
    }
  };

  const handleEmergencyEsc = async () => {
    releaseAllHeldInputs();
    try {
      await api.emergencyEsc();
      onToast('已触发系统级 Esc 急停（已释放所有按住键）');
    } catch {
      onToast('Esc 急停发送失败');
    }
  };

  const filteredControls = useMemo(() => {
    const q = controlFilter.trim().toLowerCase();
    if (!q) return controls;
    return controls.filter(
      (c) => c.name.toLowerCase().includes(q) || c.role.toLowerCase().includes(q) || String(c.index) === q
    );
  }, [controls, controlFilter]);

  const enabledToolbarKeys = useMemo<ToolbarButtonKey[]>(() => {
    const keys = TOOLBAR_BUTTON_ITEMS.filter((it) => remotePrefs.toolbarButtons[it.key]).map((it) => it.key);
    return keys.length > 0 ? keys : ['left_click'];
  }, [remotePrefs.toolbarButtons]);

  const showPanToggle =
    mode === 'crosshair' && (remotePrefs.canvasBoundaryMode === 'free_margin' || zoom > 1.05);

  const renderMouseToolbarButtons = (compact: boolean) =>
    enabledToolbarKeys.map((key) => {
      const minH = compact ? 'min-h-[36px]' : 'min-h-[38px]';
      switch (key) {
        case 'left_click':
          return (
            <button
              key={key}
              type="button"
              onClick={() => triggerMouseAction('click')}
              className={`shrink-0 px-3 ${minH} rounded-xl bg-sky-500/30 border border-sky-400/50 text-sky-100 font-medium flex items-center gap-1 active:scale-95`}
            >
              <MousePointerClick className="w-3.5 h-3.5" />
              <span>{compact ? '左键' : '左键点击'}</span>
            </button>
          );
        case 'double_click':
          return (
            <button
              key={key}
              type="button"
              onClick={() => triggerMouseAction('double_click')}
              className={`shrink-0 px-2.5 ${minH} rounded-xl ${compact ? 'bg-white/10' : 'glass-panel'} active:scale-95`}
            >
              双击
            </button>
          );
        case 'right_click':
          return (
            <button
              key={key}
              type="button"
              onClick={() => triggerMouseAction('right_click')}
              className={`shrink-0 px-2.5 ${minH} rounded-xl ${compact ? 'bg-white/10' : 'glass-panel'} active:scale-95`}
            >
              右键
            </button>
          );
        case 'left_hold':
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggleHoldButton('left')}
              className={`shrink-0 px-2.5 ${minH} rounded-xl border active:scale-95 ${
                leftHeld
                  ? 'bg-amber-500/35 border-amber-400 text-amber-100 font-semibold'
                  : compact
                    ? 'bg-white/10 border-white/10'
                    : 'glass-panel border-white/10'
              }`}
            >
              {leftHeld ? '松开左键' : '左键按住'}
            </button>
          );
        case 'right_hold':
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggleHoldButton('right')}
              className={`shrink-0 px-2.5 ${minH} rounded-xl border active:scale-95 ${
                rightHeld
                  ? 'bg-violet-500/35 border-violet-400 text-violet-100 font-semibold'
                  : compact
                    ? 'bg-white/10 border-white/10'
                    : 'glass-panel border-white/10'
              }`}
            >
              {rightHeld ? '松开右键' : '右键按住'}
            </button>
          );
        case 'drag':
          return (
            <button
              key={key}
              type="button"
              onClick={toggleInteractiveDrag}
              className={`shrink-0 px-2.5 ${minH} rounded-xl border flex items-center gap-1 active:scale-95 ${
                dragOrigin
                  ? 'bg-emerald-500/35 border-emerald-400 text-emerald-100 font-semibold'
                  : compact
                    ? 'bg-white/10 border-white/10'
                    : 'glass-panel border-white/10'
              }`}
            >
              <Move className="w-3.5 h-3.5" />
              <span>{dragOrigin ? '松开完成' : '拖动'}</span>
            </button>
          );
        case 'rapid_click':
          return (
            <button
              key={key}
              type="button"
              onPointerDown={handleRapidPointerDown}
              onPointerUp={handleRapidPointerEnd}
              onPointerLeave={handleRapidPointerEnd}
              onPointerCancel={handleRapidPointerEnd}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void triggerMouseAction('rapid_click');
                }
              }}
              className={`shrink-0 px-2.5 ${minH} rounded-xl flex items-center gap-1 ${
                compact ? 'bg-white/10' : 'glass-panel'
              } active:scale-95 select-none`}
              title="轻点连点，长按持续连点"
            >
              <Zap className="w-3.5 h-3.5 text-amber-300" />
              <span>连点×{remotePrefs.rapidClickCount}</span>
            </button>
          );
        case 'scroll_up':
          return (
            <button
              key={key}
              type="button"
              onClick={() => triggerMouseAction('scroll', 300)}
              className={`shrink-0 px-2.5 ${minH} rounded-xl ${compact ? 'bg-white/10' : 'glass-panel'} active:scale-95`}
            >
              上滚
            </button>
          );
        case 'scroll_down':
          return (
            <button
              key={key}
              type="button"
              onClick={() => triggerMouseAction('scroll', -300)}
              className={`shrink-0 px-2.5 ${minH} rounded-xl ${compact ? 'bg-white/10' : 'glass-panel'} active:scale-95`}
            >
              下滚
            </button>
          );
      }
    });

  const viewportTouchAction = mode === 'crosshair' ? 'none' : 'pan-x pan-y';

  const rotatedStyle: React.CSSProperties | undefined =
    fullscreen && virtualLandscape
      ? {
          position: 'fixed',
          top: '50%',
          left: '50%',
          width: '100dvh',
          height: '100dvw',
          transform: 'translate(-50%, -50%) rotate(90deg)',
        }
      : undefined;

  const canvasViewport = (
    <div
      ref={viewportRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUpOrCancel}
      onPointerCancel={handlePointerUpOrCancel}
      style={{
        touchAction: viewportTouchAction,
        backgroundImage: 'radial-gradient(circle, rgba(148,163,184,0.16) 1px, transparent 1px)',
        backgroundSize: '18px 18px',
      }}
      className={`flex-1 min-h-0 overflow-hidden relative flex items-center justify-center select-none ${
        fullscreen ? 'bg-[#06080d]' : 'bg-[#090c14]'
      }`}
    >
      {meta.screen_locked ? (
        <div className="m-auto glass-panel rounded-2xl p-6 max-w-sm text-center space-y-2">
          <Lock className="w-8 h-8 text-amber-400 mx-auto" />
          <div className="font-semibold">远程电脑当前处于锁屏状态</div>
          <p className="text-xs opacity-75 leading-relaxed">
            Windows 锁屏界面会阻止普通程序抓取画面和输入鼠标。Tab 1 的反重力对话仍可正常使用；如需使用 Tab 2 遥控屏幕，建议电脑端保持解锁并仅关闭显示器电源。
          </p>
        </div>
      ) : (
        <div
          style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0)` }}
          className={`shrink-0 overflow-hidden bg-black will-change-transform ${
            fullscreen ? 'rounded-md shadow-2xl' : 'rounded-xl border border-white/15 shadow-2xl'
          }`}
        >
          <div
            ref={stageRef}
            style={{
              width: `${stageDimensions.width}px`,
              height: `${stageDimensions.height}px`,
            }}
            className="relative select-none"
          >
            {frameUrl ? (
              <img
                src={frameUrl}
                alt="远程电脑实时画面"
                className="w-full h-full object-fill block pointer-events-none"
                draggable={false}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs opacity-60">
                正在连接远程电脑桌面画面...
              </div>
            )}

            {/* Interactive Drag Anchor + Vector Line */}
            {mode === 'crosshair' && dragOrigin && (
              <svg
                className="absolute inset-0 w-full h-full pointer-events-none"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                <line
                  x1={dragOrigin.nx * 100}
                  y1={dragOrigin.ny * 100}
                  x2={aimNorm.x * 100}
                  y2={aimNorm.y * 100}
                  stroke="#34d399"
                  strokeWidth="0.7"
                  strokeDasharray="2 1.5"
                />
              </svg>
            )}
            {mode === 'crosshair' && dragOrigin && (
              <div
                style={{ left: `${dragOrigin.nx * 100}%`, top: `${dragOrigin.ny * 100}%` }}
                className="absolute w-0 h-0 pointer-events-none"
              >
                <div className="absolute -left-3 -top-3 w-6 h-6 rounded-full border-2 border-emerald-400 bg-emerald-400/20 animate-pulse" />
              </div>
            )}

            {/* Mode 1: Numbered UIA Control Badges */}
            {mode === 'controls' &&
              controls.map((ctrl) => {
                const [nx, ny, nw, nh] = ctrl.norm_rect;
                return (
                  <button
                    key={ctrl.index}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClickControl(ctrl);
                    }}
                    style={{
                      left: `${nx * 100}%`,
                      top: `${ny * 100}%`,
                      width: `${nw * 100}%`,
                      height: `${nh * 100}%`,
                    }}
                    className="absolute border border-sky-400/75 bg-sky-500/10 hover:bg-sky-500/30 transition"
                    title={`[${ctrl.index}] ${ctrl.name}`}
                  >
                    <span className="absolute -top-2.5 -left-1 px-1.5 py-0.5 rounded bg-sky-500 text-white font-mono text-[10px] font-bold leading-none shadow">
                      {ctrl.index}
                    </span>
                  </button>
                );
              })}

            {/* Mode 2: Zero-Offset Precision Crosshair */}
            {mode === 'crosshair' && (
              <div
                style={{ left: `${aimNorm.x * 100}%`, top: `${aimNorm.y * 100}%` }}
                className="absolute w-0 h-0 pointer-events-none"
              >
                <div
                  className={`absolute -left-4 -top-4 w-8 h-8 rounded-full border-2 shadow-[0_0_0_1.5px_rgba(0,0,0,0.75)] flex items-center justify-center ${
                    leftHeld || dragOrigin
                      ? 'border-emerald-400'
                      : rightHeld
                        ? 'border-violet-400'
                        : 'border-amber-400'
                  }`}
                >
                  <div className="absolute inset-x-1.5 top-1/2 h-[1px] -translate-y-1/2 bg-amber-300/75" />
                  <div className="absolute inset-y-1.5 left-1/2 w-[1px] -translate-x-1/2 bg-amber-300/75" />
                  <div className="w-1.5 h-1.5 rounded-full bg-rose-500 ring-1 ring-white/80" />
                </div>
                <div className="absolute left-1/2 -translate-x-1/2 top-5 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-mono text-amber-200 whitespace-nowrap">
                  {aimScreenCoords.sx}, {aimScreenCoords.sy}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  if (fullscreen) {
    return (
      <div ref={rootRef} className="fixed inset-0 z-40 bg-black overflow-hidden">
        <div
          style={{
            ...rotatedStyle,
            paddingTop: 'env(safe-area-inset-top, 0px)',
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            paddingLeft: 'env(safe-area-inset-left, 0px)',
            paddingRight: 'env(safe-area-inset-right, 0px)',
          }}
          className={`flex flex-col bg-black ${virtualLandscape ? '' : 'w-full h-full'}`}
        >
          {canvasViewport}

          {/* Floating Top Control Pill Bar */}
          {hudCollapsed ? (
            <button
              type="button"
              onClick={() => setHudCollapsed(false)}
              className="absolute top-2.5 left-2.5 z-50 px-2.5 py-1.5 rounded-full bg-black/70 backdrop-blur-md border border-white/20 text-xs flex items-center gap-1.5 text-slate-100 shadow-lg"
              aria-label="展开全屏工具栏"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-sky-400" />
              <span>工具栏</span>
            </button>
          ) : (
            <div className="absolute top-2 left-2 right-2 z-50 flex items-center justify-between gap-1.5 pointer-events-none">
              <div className="pointer-events-auto flex items-center gap-1 px-2 py-1 rounded-2xl bg-black/70 backdrop-blur-md border border-white/15 text-xs overflow-x-auto obsidian-scroll max-w-full shadow-xl">
                <button
                  type="button"
                  onClick={handleEmergencyEsc}
                  className="shrink-0 px-2.5 py-1.5 rounded-xl bg-rose-600 text-white font-bold flex items-center gap-1 active:scale-95"
                >
                  <OctagonAlert className="w-3.5 h-3.5" />
                  <span>Esc</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (mode === 'crosshair') {
                      switchToControlsMode();
                    } else {
                      setMode('crosshair');
                    }
                  }}
                  className={`shrink-0 px-2 py-1.5 rounded-xl border flex items-center gap-1 ${
                    mode === 'controls' ? 'bg-sky-500/30 border-sky-400/50 text-sky-100' : 'bg-white/10 border-white/15'
                  }`}
                >
                  {mode === 'controls' ? <Hash className="w-3.5 h-3.5" /> : <Crosshair className="w-3.5 h-3.5" />}
                  <span>{mode === 'controls' ? '编号' : '准星'}</span>
                </button>

                {mode === 'controls' && (
                  <button
                    type="button"
                    onClick={handleScanControls}
                    disabled={scanning}
                    className="shrink-0 px-2 py-1.5 rounded-xl bg-emerald-500/25 border border-emerald-400/40 text-emerald-100 flex items-center gap-1"
                  >
                    <ScanSearch className="w-3.5 h-3.5" />
                    <span>{scanning ? '扫描' : '重扫'}</span>
                  </button>
                )}

                {showPanToggle && (
                  <button
                    type="button"
                    onClick={() => setTouchBehavior((b) => (b === 'aim' ? 'pan' : 'aim'))}
                    className={`shrink-0 px-2 py-1.5 rounded-xl border flex items-center gap-1 ${
                      touchBehavior === 'pan' ? 'bg-amber-500/30 border-amber-400/50' : 'bg-white/10 border-white/15'
                    }`}
                  >
                    <Hand className="w-3.5 h-3.5" />
                    <span>{touchBehavior === 'pan' ? '拖画面' : '拖准星'}</span>
                  </button>
                )}

                <select
                  aria-label="画面清晰度"
                  value={preset}
                  onChange={(e) => setPreset(e.target.value as 'fast' | 'balanced' | 'hd')}
                  className="shrink-0 px-1.5 py-1.5 rounded-xl bg-black/55 border border-white/15 text-xs"
                >
                  <option value="fast">流畅</option>
                  <option value="balanced">均衡</option>
                  <option value="hd">高清</option>
                </select>

                <button
                  type="button"
                  onClick={() => setPaused((p) => !p)}
                  className="shrink-0 p-1.5 rounded-xl bg-white/10"
                  aria-label={paused ? '恢复画面' : '暂停画面'}
                >
                  {paused ? <Play className="w-3.5 h-3.5 text-emerald-400" /> : <Pause className="w-3.5 h-3.5" />}
                </button>

                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.max(1, Number((z - 0.5).toFixed(1))))}
                  className="shrink-0 p-1.5 rounded-xl bg-white/10"
                  aria-label="缩小"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={resetCanvasView}
                  className="shrink-0 px-1.5 py-1 rounded-xl bg-white/10 font-mono text-[11px]"
                  title="点击重置缩放并居中"
                >
                  {zoom.toFixed(1)}x
                </button>
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.min(3.5, Number((z + 0.5).toFixed(1))))}
                  className="shrink-0 p-1.5 rounded-xl bg-white/10"
                  aria-label="放大"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>

                {isPortrait && (
                  <button
                    type="button"
                    onClick={() => setVirtualLandscape((v) => !v)}
                    className={`shrink-0 px-2 py-1.5 rounded-xl border flex items-center gap-1 ${
                      virtualLandscape ? 'bg-violet-500/35 border-violet-400/50 text-violet-100' : 'bg-white/10 border-white/15'
                    }`}
                    aria-label="旋转90度"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                    <span>旋转</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setKeyboardOpen((k) => !k)}
                  className={`shrink-0 px-2 py-1.5 rounded-xl border flex items-center gap-1 ${
                    keyboardOpen ? 'bg-sky-500/30 border-sky-400/50' : 'bg-white/10 border-white/15'
                  }`}
                  aria-label="键盘与快捷键"
                >
                  <Keyboard className="w-3.5 h-3.5" />
                  <span>键盘</span>
                </button>

                <button
                  type="button"
                  onClick={() => setHudCollapsed(true)}
                  className="shrink-0 p-1.5 rounded-xl bg-white/10"
                  aria-label="收起工具栏"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>

                <button
                  type="button"
                  onClick={exitFullscreen}
                  className="shrink-0 px-2 py-1.5 rounded-xl bg-white/15 hover:bg-white/25 flex items-center gap-1"
                  aria-label="退出全屏"
                >
                  <Minimize2 className="w-3.5 h-3.5" />
                  <span>退出</span>
                </button>
              </div>
            </div>
          )}

          {/* Floating Bottom Mouse Actions OR Numbered Control Chips */}
          {!keyboardOpen && mode === 'crosshair' && (
            <div className="absolute bottom-2.5 right-2.5 left-2.5 sm:left-auto z-50 flex items-center gap-1 p-1 rounded-2xl bg-black/70 backdrop-blur-md border border-white/15 text-xs shadow-xl overflow-x-auto obsidian-scroll">
              {renderMouseToolbarButtons(true)}
            </div>
          )}

          {!keyboardOpen && mode === 'controls' && controls.length > 0 && (
            <div className="absolute bottom-2 left-2 right-2 z-50 flex items-center gap-1.5 p-1.5 rounded-2xl bg-black/75 backdrop-blur-md border border-white/15 overflow-x-auto obsidian-scroll text-xs shadow-xl">
              {filteredControls.map((ctrl) => (
                <button
                  key={ctrl.index}
                  type="button"
                  onClick={() => handleClickControl(ctrl)}
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 rounded-xl bg-white/10 hover:bg-sky-500/30"
                >
                  <span className="px-1.5 py-0.5 rounded bg-sky-500 text-white font-mono text-[10px] font-bold">
                    {ctrl.index}
                  </span>
                  <span className="max-w-[120px] truncate">{ctrl.name}</span>
                </button>
              ))}
            </div>
          )}

          {/* Floating Keyboard & Hotkeys Panel */}
          {keyboardOpen && (
            <div className="absolute bottom-2 left-2 right-2 z-50 p-2 rounded-2xl bg-black/85 backdrop-blur-md border border-white/20 space-y-2 shadow-2xl">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 overflow-x-auto obsidian-scroll text-[11px]">
                  {HOTKEYS.map((hk) => (
                    <button
                      key={hk.chord}
                      type="button"
                      onClick={() => handleHotkey(hk.chord)}
                      className="shrink-0 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 font-mono"
                    >
                      {hk.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setKeyboardOpen(false)}
                  className="p-1.5 rounded-lg bg-white/10 shrink-0"
                  aria-label="关闭键盘"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSendText();
                  }}
                  placeholder="输入文本发送到电脑光标处..."
                  className="flex-1 min-h-[38px] rounded-xl bg-black/50 border border-white/20 px-3 text-sm focus:outline-none focus:border-sky-400"
                />
                <button
                  type="button"
                  onClick={handleSendText}
                  disabled={!textInput}
                  className="w-10 h-[38px] rounded-xl bg-sky-500 text-white flex items-center justify-center disabled:opacity-40"
                  aria-label="发送输入文本"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex-1 min-h-0 flex flex-col">
      {/* Top Status + Prominent Emergency Esc */}
      <div className="px-3 py-1.5 border-b border-white/10 flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <Monitor className="w-4 h-4 text-sky-400 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium truncate">
              {telemetry?.foreground_window || controlsWindow || '远程电脑桌面'}
            </div>
            <div className="text-[11px] opacity-65 font-mono">
              CPU {telemetry?.cpu_percent ?? '--'}% · 内存 {telemetry?.ram_percent ?? '--'}%
              {telemetry?.prevent_sleep ? ' · 防休眠' : ''}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={handleEmergencyEsc}
          className="shrink-0 min-h-[38px] px-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs shadow-lg shadow-rose-600/30 flex items-center gap-1.5 active:scale-95 transition"
        >
          <OctagonAlert className="w-4 h-4" />
          <span>Esc 急停</span>
        </button>
      </div>

      {/* Mode & Zoom Toolbar */}
      <div className="px-3 py-1.5 flex items-center justify-between gap-2 border-b border-white/10 text-xs overflow-x-auto obsidian-scroll">
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setMode('crosshair')}
            className={`px-2.5 py-1.5 rounded-lg border flex items-center gap-1 ${
              mode === 'crosshair' ? 'bg-violet-500/25 border-violet-400/50 text-violet-200' : 'glass-panel opacity-80'
            }`}
          >
            <Crosshair className="w-3.5 h-3.5" />
            <span>自由准星</span>
          </button>
          <button
            type="button"
            onClick={switchToControlsMode}
            className={`px-2.5 py-1.5 rounded-lg border flex items-center gap-1 ${
              mode === 'controls' ? 'bg-sky-500/25 border-sky-400/50 text-sky-200' : 'glass-panel opacity-80'
            }`}
          >
            <Hash className="w-3.5 h-3.5" />
            <span>按钮编号</span>
          </button>

          <button
            type="button"
            onClick={enterFullscreen}
            className="px-2.5 py-1.5 rounded-lg bg-sky-500/20 border border-sky-400/40 text-sky-200 flex items-center gap-1 active:scale-95 transition"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            <span>横屏全屏</span>
          </button>

          {showPanToggle && (
            <button
              type="button"
              onClick={() => setTouchBehavior((b) => (b === 'aim' ? 'pan' : 'aim'))}
              className={`px-2.5 py-1.5 rounded-lg border flex items-center gap-1 ${
                touchBehavior === 'pan'
                  ? 'bg-amber-500/25 border-amber-400/50 text-amber-200'
                  : 'glass-panel opacity-85'
              }`}
              title="切换单指拖动画面或移动准星"
            >
              <Hand className="w-3.5 h-3.5" />
              <span>{touchBehavior === 'pan' ? '拖画面中' : '拖准星中'}</span>
            </button>
          )}

          {mode === 'controls' && (
            <button
              type="button"
              onClick={handleScanControls}
              disabled={scanning}
              className="px-2.5 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-400/40 text-emerald-200 flex items-center gap-1 active:scale-95 transition"
            >
              <ScanSearch className="w-3.5 h-3.5" />
              <span>{scanning ? '扫描中...' : '重新扫描'}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <select
            aria-label="画面清晰度"
            value={preset}
            onChange={(e) => setPreset(e.target.value as 'fast' | 'balanced' | 'hd')}
            className="px-2 py-1.5 rounded-lg bg-black/35 border border-white/15 text-xs"
          >
            <option value="fast">流畅省流</option>
            <option value="balanced">均衡清晰</option>
            <option value="hd">原画高清</option>
          </select>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="p-1.5 rounded-lg glass-panel"
            aria-label={paused ? '恢复画面' : '暂停画面'}
          >
            {paused ? <Play className="w-4 h-4 text-emerald-400" /> : <Pause className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(1, Number((z - 0.5).toFixed(1))))}
            className="p-1.5 rounded-lg glass-panel active:scale-95"
            aria-label="缩小"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={resetCanvasView}
            className="px-1.5 py-1 rounded-lg glass-panel font-mono text-[11px] min-w-[42px]"
            title="点击重置为 1.0x 并居中"
          >
            {zoom.toFixed(1)}x
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(3.5, Number((z + 0.5).toFixed(1))))}
            className="p-1.5 rounded-lg glass-panel active:scale-95"
            aria-label="放大"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Mode Explanation Banner for Button Index Mode */}
      {mode === 'controls' && (
        <div className="px-3 py-1 bg-sky-500/10 border-b border-sky-400/20 text-[11px] text-sky-200/90">
          自动识别当前窗口的按钮与输入框并标注 [1][2][3] 序号，直接点选即可精准点击中心，不怕小屏点偏。
        </div>
      )}

      {/* Screen Canvas Viewport */}
      {canvasViewport}

      {/* Mode-Specific Control Bar */}
      {mode === 'controls' && controls.length > 0 && (
        <div className="px-3 py-2 border-t border-white/10 glass-panel space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              type="search"
              value={controlFilter}
              onChange={(e) => setControlFilter(e.target.value)}
              placeholder="输入编号或按钮名快速筛选..."
              className="flex-1 min-h-[36px] rounded-lg bg-black/30 border border-white/15 px-2.5 text-xs focus:outline-none focus:border-sky-400"
            />
            <span className="text-[11px] opacity-60 shrink-0">{filteredControls.length} 个</span>
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto obsidian-scroll pb-1 text-xs">
            {filteredControls.map((ctrl) => (
              <button
                key={ctrl.index}
                type="button"
                onClick={() => handleClickControl(ctrl)}
                className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-sky-500/30 border border-white/10 transition"
              >
                <span className="px-1.5 py-0.5 rounded bg-sky-500 text-white font-mono text-[10px] font-bold">
                  {ctrl.index}
                </span>
                <span className="max-w-[140px] truncate">{ctrl.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === 'crosshair' && (
        <div className="px-3 py-1.5 border-t border-white/10 glass-panel flex items-center gap-1.5 text-xs overflow-x-auto obsidian-scroll">
          {renderMouseToolbarButtons(false)}
        </div>
      )}

      {/* Bottom Keyboard & Hotkeys Bar */}
      <div className="px-3 py-1.5 pb-[calc(0.5rem+env(safe-area-inset-bottom))] border-t border-white/10 glass-panel space-y-1.5">
        <div className="flex items-center gap-1.5 overflow-x-auto obsidian-scroll text-[11px]">
          <Keyboard className="w-3.5 h-3.5 opacity-60 shrink-0" />
          {HOTKEYS.map((hk) => (
            <button
              key={hk.chord}
              type="button"
              onClick={() => handleHotkey(hk.chord)}
              className="shrink-0 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 font-mono"
            >
              {hk.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSendText();
            }}
            placeholder="输入中文/英文直接打字到电脑当前光标处..."
            className="flex-1 min-h-[40px] rounded-xl bg-black/30 border border-white/15 px-3 text-sm focus:outline-none focus:border-sky-400"
          />
          <button
            type="button"
            onClick={handleSendText}
            disabled={!textInput}
            className="w-11 h-[40px] rounded-xl bg-sky-500 text-white flex items-center justify-center disabled:opacity-40 active:scale-95"
            aria-label="发送输入文本"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
