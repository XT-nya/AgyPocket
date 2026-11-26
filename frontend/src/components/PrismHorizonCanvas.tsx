import { useEffect, useRef } from 'react';

interface PrismHorizonCanvasProps {
  status: 'idle' | 'thinking' | 'running' | 'error' | 'aborted';
  awaitingApproval?: boolean;
}

const SPECTRUM_DARK: Array<[number, number, number]> = [
  [66, 133, 244],  // Cobalt
  [155, 114, 203], // Iris
  [234, 67, 53],   // Coral
  [251, 188, 4],   // Amber
];

const SPECTRUM_APPROVAL: Array<[number, number, number]> = [
  [251, 188, 4],
  [234, 67, 53],
  [245, 158, 11],
  [155, 114, 203],
];

const LOBE_PHASES = [0.35, 2.45, 4.55];
const LOBE_ANGLES = [2.85, 0.52, 4.62];

function mixColor(
  stops: Array<[number, number, number]>,
  t: number
): [number, number, number] {
  const n = stops.length;
  const wrapped = ((t % 1) + 1) % 1;
  const scaled = wrapped * n;
  const i = Math.floor(scaled) % n;
  const f = scaled - Math.floor(scaled);
  const a = stops[i];
  const b = stops[(i + 1) % n];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export function PrismHorizonCanvas({ status, awaitingApproval = false }: PrismHorizonCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ status, awaitingApproval });

  useEffect(() => {
    stateRef.current = { status, awaitingApproval };
  }, [status, awaitingApproval]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const mqReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let rafId = 0;
    let lastDraw = 0;
    let phaseTime = 2.4;
    let lastTick = performance.now();

    const syncSize = () => {
      const parent = canvas.parentElement;
      const w = parent?.clientWidth || window.innerWidth;
      const h = parent?.clientHeight || window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 1);
      const cw = Math.max(1, Math.round(w * dpr));
      const ch = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
    };

    const drawFrame = (nowMs: number, staticSnapshot: boolean) => {
      if (canvas.width === 0 || canvas.height === 0) return;
      const w = canvas.width;
      const h = canvas.height;
      const diag = Math.hypot(w, h);
      const dark = document.documentElement.dataset.theme !== 'light';

      const dt = Math.min(0.1, Math.max(0, (nowMs - lastTick) / 1000));
      lastTick = nowMs;

      const { status: st, awaitingApproval: apr } = stateRef.current;
      const isBusy = st === 'thinking' || st === 'running';
      const speedMul = apr ? 1.55 : isBusy ? 2.55 : 0.85;
      if (!staticSnapshot) {
        phaseTime += dt * speedMul;
      }

      ctx.clearRect(0, 0, w, h);

      const palette = apr ? SPECTRUM_APPROVAL : SPECTRUM_DARK;
      const intensity = apr ? 0.32 : isBusy ? (dark ? 0.34 : 0.24) : (dark ? 0.16 : 0.11);
      const reachFactor = isBusy ? 0.56 : apr ? 0.44 : 0.34;

      // 1. Large sweeping prism nebula lobes
      for (let i = 0; i < 3; i++) {
        const period = 8.4 + i * 2.2;
        const env = 0.5 + 0.5 * Math.sin((Math.PI * 2 * phaseTime) / period + LOBE_PHASES[i]);
        const dir = i === 1 ? -1 : 1;
        const ang =
          LOBE_ANGLES[i] +
          0.62 * Math.sin(phaseTime * (0.22 + i * 0.04) + i * 1.7) +
          dir * phaseTime * (0.12 + i * 0.025);
        const rx = (0.36 + 0.09 * Math.cos(phaseTime * 0.19 + i)) * w;
        const ry = (0.28 + 0.08 * Math.sin(phaseTime * 0.23 + i)) * h;
        const cx = 0.5 * w + rx * Math.cos(ang);
        const cy = (isBusy ? 0.54 : 0.68) * h + ry * Math.sin(ang) * 0.72;
        const radius = diag * (isBusy ? 0.48 : 0.36) * (0.85 + 0.28 * env);

        const hueShift = phaseTime * (isBusy ? 0.08 : 0.03) + i * 0.28;
        const [r, g, b] = mixColor(palette, hueShift);
        const alpha = intensity * (0.55 + 0.45 * env);

        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`);
        grad.addColorStop(0.52, `rgba(${r}, ${g}, ${b}, ${(alpha * 0.42).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      }

      // 2. Sweeping chromatic bottom horizon aurora
      const horizonH = Math.max(90, h * reachFactor);
      const waveX = w * (0.5 + 0.34 * Math.sin(phaseTime * 0.42));
      const hGrad = ctx.createLinearGradient(waveX - w * 0.65, h, waveX + w * 0.65, h - horizonH * 0.3);
      for (let k = 0; k <= 4; k++) {
        const [r, g, b] = mixColor(palette, phaseTime * (isBusy ? 0.12 : 0.04) + k * 0.24);
        const edgeFade = k === 0 || k === 4 ? 0.55 : 1;
        const a = (isBusy ? 0.28 : 0.13) * edgeFade;
        hGrad.addColorStop(k / 4, `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`);
      }

      ctx.save();
      const maskGrad = ctx.createLinearGradient(0, h, 0, h - horizonH);
      maskGrad.addColorStop(0, 'rgba(255,255,255,1)');
      maskGrad.addColorStop(0.55, 'rgba(255,255,255,0.45)');
      maskGrad.addColorStop(1, 'rgba(255,255,255,0)');

      ctx.globalCompositeOperation = dark ? 'screen' : 'multiply';
      ctx.fillStyle = hGrad;
      ctx.beginPath();
      ctx.moveTo(0, h);
      const steps = 14;
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const x = u * w;
        const wave =
          Math.sin(u * Math.PI * 2 + phaseTime * (isBusy ? 1.8 : 0.7)) *
          (isBusy ? 22 : 9);
        const y = h - horizonH * (0.45 + 0.35 * Math.sin(u * Math.PI)) + wave;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();

      // Subtle vertical fade vignette near bottom composer
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = maskGrad;
      ctx.restore();
    };

    const tick = (nowMs: number) => {
      if (document.hidden || mqReduced?.matches) {
        rafId = 0;
        return;
      }
      const isBusy = stateRef.current.status === 'thinking' || stateRef.current.status === 'running';
      const minGap = isBusy ? 33 : 66;
      if (nowMs - lastDraw >= minGap) {
        lastDraw = nowMs;
        drawFrame(nowMs, false);
      }
      rafId = window.requestAnimationFrame(tick);
    };

    const startLoop = () => {
      syncSize();
      if (mqReduced?.matches) {
        drawFrame(performance.now(), true);
        return;
      }
      if (!rafId && !document.hidden) {
        lastTick = performance.now();
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const ro = new ResizeObserver(() => {
      syncSize();
      if (mqReduced?.matches) drawFrame(performance.now(), true);
    });
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const onVis = () => {
      if (document.hidden) {
        if (rafId) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else {
        startLoop();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    mqReduced?.addEventListener?.('change', startLoop);
    startLoop();

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      mqReduced?.removeEventListener?.('change', startLoop);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 w-full h-full z-0"
    />
  );
}
