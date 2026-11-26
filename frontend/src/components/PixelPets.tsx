import { useEffect, useRef } from 'react';

interface PixelPetsProps {
  busy: boolean;
  awaitingApproval?: boolean;
}

type ActorId = 'clawd' | 'cat';

interface SpriteLayer {
  ox: number;
  oy: number;
  rows: string[];
  grounded?: boolean;
}

const PX = 2.5;
const CANVAS_W = 80;
const CANVAS_H = 75;
const HIT_W = 52;
const HIT_H = 42;
const OX_GRID = 8; // (8 + 8) * 2.5 = 40px horizontal center
const OY_GRID = 20; // (20 + 10) * 2.5 = 75px bottom foot baseline
const MOUNT_STEP_H = 22;

const SHARED_PROP_PALETTE: Record<string, string> = {
  k: '#9c958c',
  w: '#fbf8f1',
  c: '#ecdfc6',
  g: '#a8a194',
  B: '#5b8fb9',
  b: '#cfe3ee',
  r: '#cc4f45',
  y: '#e8b64a',
  h: 'rgba(20, 20, 19, 0.20)',
  d: '#9a8e80',
  D: '#6f8ca6',
  p: '#ef9aa6',
  n: '#8b5e3c',
  l: '#6a6158',
  e: '#78716a',
  m: 'rgba(120, 112, 104, 0.55)',
  G: '#7dff9b',
  t: 'rgba(125, 255, 155, 0.38)',
  N: '#ff6bd6',
  u: 'rgba(255, 107, 214, 0.38)',
  W: '#effff3',
  P: '#d87e64',
  a: '#c6d9f7',
  v: '#788eac',
};

const PALETTES: Record<ActorId, Record<string, string>> = {
  clawd: {
    ...SHARED_PROP_PALETTE,
    '#': '#d97757',
    s: '#bf684c',
    o: '#141413',
  },
  cat: {
    ...SHARED_PROP_PALETTE,
    '#': '#947fd6',
    s: '#735eb5',
    o: '#141413',
    k: '#a89fc4',
  },
};

// Subset of dual-mascot-rig.js RLE atlas covering all core poses, drags, bounces, and easter eggs
const SPRITE_ATLAS_RAW =
  'c.shadow!w12=2,10,g:12h;w14=1,10,g:14h;w10=3,10,g:10h|' +
  'c.body!stand=2,0:12#*8;tall=2,-1:12#*9;squash=1,2:.12s./14#*6;flat=2,7:12s/12#*2;turnL=2,0:11#s*8;turnR=2,0:s11#*8|' +
  'c.eyes!open=4,2:o6.o*2;openL=3,2:o6.o*2;openR=5,2:o6.o*2;half=4,3:o6.o;shut=3,3:oo6.oo;happy=3,2:.o6.o./o.o4.o.o;squint=4,2:o6.o/.o4.o./o6.o;wide=3,2:oo6.oo*2;flatEyes=4,8:oo4.oo;blink=3,3:ss6.ss|' +
  'c.legs!stand=2,8:.#.#4.#.#.*2;crouch=2,9:.#.#4.#.#.;tuck=2,8:..#.#..#.#..*2;walkA=2,8:.#.s4.#.s./.#6.#3.;walkB=2,8:.s.#4.s.#./3.#6.#.;dangle=2,8:.#.#4.#.#./.#.#8.*2;dangle2=2,8:.#.#4.#.#./8.#.#.*2;flailA=2,8:#3.#..#3.#/#10.#;flailB=2,8:..#.#..#.#../4.#..#4.;flailC=2,8:#..#4.#..#/3.#4.#..#|' +
  'c.clawL!stub=0,5:##*2;front=0,5:ss*2;up=0,-2:##*2/#.;open=0,4:##/.#/##;flatLeft=0,8:ss|' +
  'c.clawR!stub=14,5:##*2;front=14,5:ss*2;up=14,-2:##*2/.#;open=14,4:##/#./##;waveOut=14,-1:.##*2/#..;flatRight=14,8:ss|' +
  'k.ears!stand=2,-1:#10.#/##8.##;nod=2,0:#10.#/##8.##;loaf=2,2:#10.#/##8.##;airplane=0,0:##12.##/3#10.3#;flat=1,6:#12.#;twitchL=2,-1:11.#/##8.##;twitchR=2,-1:#11./##8.##|' +
  'k.body!stand=2,1:12#*7;loaf=1,4:.12s./14#*5;turnL=2,1:11#s*7;turnR=2,1:s11#*7|' +
  'k.eyes!loafShut=3,6:oo6.oo;loafHalf=4,6:o6.o|' +
  'k.paws!none=0,0:;cheer=0,2:#14.#*2;up=0,-1:##12.##*2;write1=13,5:ss*2;upR=14,0:##*2|' +
  'k.tail!up=14,3:.s/.#*2/##;sway=14,3:.#*2/s#/#.;curl=14,4:##/.#/s#;loaf=14,6:.#*2/s#;puff=14,2:.#/##*2/s#/#.|' +
  'p!iceCrystal=5,-6:..av../.aavv./3a3v/.aavv./..av..;hotCup0=12,3:.m..m./m..m../5D./D3nDD/D3nD./.3D..;hotCup1=12,3:m..m../.m..m./5D./D3nDD/D3nD./.3D..;book0=12,4:5B/B3wB/BwgwB/B3wB/5B;book1=12,4:BB.BB/BwBwB/BwgwB/BwBwB/BB.BB;stickUp=14,-9:WW/GG*6;stickLT=9,-9:5.tt/WG3.tt/.GG..tt/..GG.tt/3.GGtt/4.GGt/5.GG;stickRT=14,-9:tt5./tt3.GW/tt..GG./tt.GG../ttGG3./tGG4./GG5.;habCactus=0,0,g:3.P3./..lGl../l.lGl../lGlGl.l/..lGlGl/.5n./..3n..|' +
  's!heart=5,-7:.r.r./5r/.3r./..r..;spark=5,-8:..y..*2/5y/..y..*2;vein=5,-7:.r.r./rr.rr/5./rr.rr/.r.r.;bang=6,-8:.r.*3/3./.r.;note=5,-8:..kk./..k.k/..k../3k../kk3.;sweat=13,-4:.B./BbB*2/.B.;tilde=5,-7:.k3./k.k.k/3.k.;dozeZ0=12,-3:3k/.k./3k;dozeZ1=13,-7:4k/..k./.k../4k;dozeZ2=14,-12:5k/3.k./..k../.k3./5k';

function mirrorLayer(fr: SpriteLayer, partW = 16): SpriteLayer {
  const w = Math.max(1, ...fr.rows.map((r) => r.length));
  const rows = fr.rows.map((r) => r.padEnd(w, '.').split('').reverse().join(''));
  return { rows, ox: partW - (fr.ox + w), oy: fr.oy, grounded: fr.grounded };
}

function recolorLayer(fr: SpriteLayer, map: Record<string, string>): SpriteLayer {
  return {
    ...fr,
    rows: fr.rows.map((r) => r.replace(/./g, (ch) => map[ch] || ch)),
  };
}

function decodeAtlas() {
  const out: {
    c: Record<string, Record<string, SpriteLayer>>;
    k: Record<string, Record<string, SpriteLayer>>;
    p: Record<string, SpriteLayer>;
    s: Record<string, SpriteLayer>;
  } = { c: {}, k: {}, p: {}, s: {} };

  for (const sec of SPRITE_ATLAS_RAW.split('|')) {
    const bi = sec.indexOf('!');
    const pk = sec.slice(0, bi).split('.');
    const grp: Record<string, SpriteLayer> = {};
    for (const item of sec.slice(bi + 1).split(';')) {
      const eq = item.indexOf('=');
      const co = item.indexOf(':', eq + 1);
      const [ox, oy, fl] = item.slice(eq + 1, co).split(',');
      const body = item.slice(co + 1);
      const rows: string[] = [];
      if (body) {
        for (const seg of body.split('/')) {
          const st = seg.indexOf('*');
          const rRaw = st >= 0 ? seg.slice(0, st) : seg;
          const n = st >= 0 ? +seg.slice(st + 1) : 1;
          const row = rRaw.replace(/(\d+)(.)/g, (_, cnt: string, ch: string) => ch.repeat(+cnt));
          for (let i = 0; i < n; i++) rows.push(row);
        }
      }
      grp[item.slice(0, eq)] =
        fl === 'g' ? { ox: +ox, oy: +oy, grounded: true, rows } : { ox: +ox, oy: +oy, rows };
    }
    if (pk[0] === 'p') out.p = grp;
    else if (pk[0] === 's') out.s = grp;
    else if (pk[0] === 'c') out.c[pk[1]] = grp;
    else if (pk[0] === 'k') out.k[pk[1]] = grp;
  }

  const clawdParts = out.c;
  const catParts: Record<string, Record<string, SpriteLayer>> = {
    shadow: clawdParts.shadow,
    ...out.k,
    legs: clawdParts.legs,
  };
  catParts.body.squash = clawdParts.body.squash;
  catParts.body.flat = clawdParts.body.flat;
  for (const [ek, ef] of Object.entries(clawdParts.eyes)) {
    catParts.eyes[ek] = ek === 'flatEyes' ? ef : { ...ef, oy: ef.oy + 1 };
  }

  const props = out.p;
  props.iceCrystalHi = { ...props.iceCrystal, oy: props.iceCrystal.oy - 1 };
  ['stickUp', 'stickLT', 'stickRT'].forEach((k) => {
    props[`${k}M`] = recolorLayer(mirrorLayer(props[k], 16), { G: 'N', t: 'u' });
  });

  const syms = out.s;
  const symSet = new WeakSet<SpriteLayer>(Object.values(syms));
  const rigidSet = new WeakSet<SpriteLayer>([...Object.values(props), ...Object.values(syms)]);

  return { clawdParts, catParts, props, syms, symSet, rigidSet };
}

const ATLAS = decodeAtlas();

function drawLayers(
  ctx: CanvasRenderingContext2D,
  palette: Record<string, string>,
  layers: SpriteLayer[]
) {
  let lastFill = '';
  for (const part of layers) {
    for (let ry = 0; ry < part.rows.length; ry++) {
      const row = part.rows[ry];
      const py = (OY_GRID + part.oy + ry) * PX;
      for (let rx = 0; rx < row.length; rx++) {
        const ch = row[rx];
        if (ch === '.' || ch === ' ') continue;
        const color = palette[ch];
        if (!color) continue;
        let run = 1;
        while (rx + run < row.length && palette[row[rx + run]] === color) {
          run++;
        }
        if (color !== lastFill) {
          ctx.fillStyle = color;
          lastFill = color;
        }
        ctx.fillRect((OX_GRID + part.ox + rx) * PX, py, PX * run, PX);
        rx += run - 1;
      }
    }
  }
}

function renderSpriteToCanvas(
  canvas: HTMLCanvasElement,
  actorId: ActorId,
  layers: SpriteLayer[],
  mirror: boolean
) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const targetW = Math.round(CANVAS_W * dpr);
  const targetH = Math.round(CANVAS_H * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.imageSmoothingEnabled = false;

  const palette = PALETTES[actorId];
  const anchorX = (OX_GRID + 8) * PX;

  const grounded: SpriteLayer[] = [];
  const flipLayers: SpriteLayer[] = [];
  const symLayers: SpriteLayer[] = [];

  for (const l of layers) {
    if (!l || !l.rows.length) continue;
    if (l.grounded) grounded.push(l);
    else if (mirror && ATLAS.symSet.has(l)) symLayers.push(l);
    else flipLayers.push(l);
  }

  if (grounded.length) {
    ctx.save();
    if (mirror) {
      ctx.translate(anchorX, 0);
      ctx.scale(-1, 1);
      ctx.translate(-anchorX, 0);
    }
    drawLayers(ctx, palette, grounded);
    ctx.restore();
  }

  ctx.save();
  if (mirror) {
    ctx.translate(anchorX, 0);
    ctx.scale(-1, 1);
    ctx.translate(-anchorX, 0);
  }
  drawLayers(ctx, palette, flipLayers);
  ctx.restore();

  if (mirror && symLayers.length) {
    const placed = symLayers.map((s) => {
      const w = Math.max(1, ...s.rows.map((r) => r.length));
      return { ...s, ox: 16 - (s.ox + w) };
    });
    drawLayers(ctx, palette, placed);
  }
}

type ClipPose =
  | 'idle'
  | 'walk'
  | 'happy'
  | 'pet'
  | 'dangle'
  | 'flat'
  | 'wow'
  | 'angry'
  | 'wave'
  | 'feedCoffee'
  | 'slashLearnBook'
  | 'sleep'
  | 'cheerSticks';

interface ActorState {
  id: ActorId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  mirror: boolean;
  stackedOn: ActorId | null;
  dragging: boolean;
  ballisticActive: boolean;
  flightSeq: number;
  rafId: number;
  clipPose: ClipPose;
  clipUntil: number;
  clipStartedAt: number;
  sym: string | null;
  symUntil: number;
  throws: number;
  lastThrowAt: number;
  eggIdx: number;
  lastTapAt: number;
}

const EASTER_EGGS: Array<{ pose: ClipPose; ms: number }> = [
  { pose: 'feedCoffee', ms: 2400 },
  { pose: 'slashLearnBook', ms: 2600 },
  { pose: 'sleep', ms: 3200 },
  { pose: 'cheerSticks', ms: 2400 },
];

export function PixelPets({ busy, awaitingApproval = false }: PixelPetsProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const clawdHitRef = useRef<HTMLDivElement>(null);
  const catHitRef = useRef<HTMLDivElement>(null);
  const clawdCanvasRef = useRef<HTMLCanvasElement>(null);
  const catCanvasRef = useRef<HTMLCanvasElement>(null);
  const cactusCanvasRef = useRef<HTMLCanvasElement>(null);

  const busyRef = useRef(busy);
  const approvalRef = useRef(awaitingApproval);
  busyRef.current = busy;
  approvalRef.current = awaitingApproval;

  useEffect(() => {
    // Render static pixel cactus once
    if (cactusCanvasRef.current) {
      const c = cactusCanvasRef.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      c.width = Math.round(20 * dpr);
      c.height = Math.round(20 * dpr);
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = false;
        const rows = ATLAS.props.habCactus.rows;
        const pal = PALETTES.clawd;
        rows.forEach((row, ry) => {
          for (let rx = 0; rx < row.length; rx++) {
            const fill = pal[row[rx]];
            if (fill) {
              ctx.fillStyle = fill;
              ctx.fillRect(rx * 2.5, ry * 2.5, 2.5, 2.5);
            }
          }
        });
      }
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const reducedMotion = Boolean(mq?.matches);

    const actors: Record<ActorId, ActorState> = {
      cat: {
        id: 'cat',
        x: 18,
        y: 0,
        vx: 0,
        vy: 0,
        rot: 0,
        mirror: false,
        stackedOn: null,
        dragging: false,
        ballisticActive: false,
        flightSeq: 0,
        rafId: 0,
        clipPose: 'idle',
        clipUntil: 0,
        clipStartedAt: 0,
        sym: null,
        symUntil: 0,
        throws: 0,
        lastThrowAt: 0,
        eggIdx: 0,
        lastTapAt: 0,
      },
      clawd: {
        id: 'clawd',
        x: 18,
        y: 0,
        vx: 0,
        vy: 0,
        rot: 0,
        mirror: false,
        stackedOn: 'cat',
        dragging: false,
        ballisticActive: false,
        flightSeq: 0,
        rafId: 0,
        clipPose: 'idle',
        clipUntil: 0,
        clipStartedAt: 0,
        sym: null,
        symUntil: 0,
        throws: 0,
        lastThrowAt: 0,
        eggIdx: 0,
        lastTapAt: 0,
      },
    };

    const pairCooldowns: Record<string, number> = {};
    const canPair = (key: string, now: number, ms: number) => {
      if ((pairCooldowns[key] || 0) > now) return false;
      pairCooldowns[key] = now + ms;
      return true;
    };

    let disposed = false;
    let tickIdx = 0;

    const getStageMaxX = () => {
      const w = stageRef.current?.clientWidth || window.innerWidth || 360;
      return Math.max(60, w - HIT_W - 36);
    };

    const clampX = (x: number) => Math.max(4, Math.min(getStageMaxX(), x));

    const worldY = (ent: ActorState): number => {
      if (!ent.stackedOn) return ent.y;
      const base = actors[ent.stackedOn];
      return (base ? worldY(base) : 0) - MOUNT_STEP_H;
    };

    const worldX = (ent: ActorState): number => {
      if (!ent.stackedOn) return ent.x;
      const base = actors[ent.stackedOn];
      return base ? worldX(base) : ent.x;
    };

    const syncDom = () => {
      (['cat', 'clawd'] as ActorId[]).forEach((id) => {
        const ent = actors[id];
        const hitEl = id === 'cat' ? catHitRef.current : clawdHitRef.current;
        if (!hitEl) return;
        const wx = ent.stackedOn ? worldX(ent) : ent.x;
        const wy = ent.stackedOn ? worldY(ent) : ent.y;
        hitEl.style.transform = `translate3d(${Math.round(wx)}px, ${Math.round(wy)}px, 0) rotate(${ent.rot.toFixed(1)}deg)`;
        hitEl.style.zIndex = ent.dragging ? '30' : ent.stackedOn ? '25' : '20';
        hitEl.style.cursor = ent.dragging ? 'grabbing' : 'grab';
      });
    };

    const enforceGroundSeparation = () => {
      const a = actors.clawd;
      const b = actors.cat;
      if (a.stackedOn || b.stackedOn || a.dragging || b.dragging || a.ballisticActive || b.ballisticActive) return;
      if (Math.abs(a.y) > 2 || Math.abs(b.y) > 2) return;
      const minGap = 42;
      const dx = a.x - b.x;
      if (Math.abs(dx) < minGap) {
        const push = (minGap - Math.abs(dx)) / 2 + 1;
        const dir = dx >= 0 ? 1 : -1;
        a.x = clampX(a.x + dir * push);
        b.x = clampX(b.x - dir * push);
      }
    };

    const startClip = (ent: ActorState, pose: ClipPose, ms: number, sym: string | null = null) => {
      const now = performance.now();
      ent.clipPose = pose;
      ent.clipStartedAt = now;
      ent.clipUntil = now + ms;
      if (sym) {
        ent.sym = sym;
        ent.symUntil = now + ms;
      }
    };

    const resolveLayersFor = (ent: ActorState, now: number): SpriteLayer[] => {
      const isCat = ent.id === 'cat';
      const p = isCat ? ATLAS.catParts : ATLAS.clawdParts;
      const activeClip = now < ent.clipUntil ? ent.clipPose : 'idle';
      const pose: ClipPose = ent.dragging ? 'dangle' : ent.ballisticActive && activeClip !== 'flat' ? 'dangle' : activeClip;
      const phase4 = tickIdx % 4;
      const clipTick = Math.floor((now - ent.clipStartedAt) / 100);
      const clipMod = clipTick % 2 === 0;
      const blink = tickIdx % 36 === 0 || tickIdx % 36 === 1;
      const isBusy = busyRef.current;

      let shadow: SpriteLayer | null = ent.dragging || ent.ballisticActive || ent.stackedOn ? null : p.shadow.w12;
      let body: SpriteLayer | null = p.body.stand;
      let eyes: SpriteLayer | null = blink && !isBusy ? p.eyes.blink : p.eyes.open;
      let legs: SpriteLayer | null = p.legs.stand;
      let clawL: SpriteLayer | null = !isCat ? p.clawL.stub : null;
      let clawR: SpriteLayer | null = !isCat ? p.clawR.stub : null;
      let ears: SpriteLayer | null = isCat ? (tickIdx % 29 === 4 ? p.ears.twitchL : p.ears.stand) : null;
      let paws: SpriteLayer | null = isCat ? p.paws.none : null;
      let tail: SpriteLayer | null = isCat ? (Math.floor(tickIdx / 4) % 2 === 0 ? p.tail.up : p.tail.sway) : null;
      let prop1: SpriteLayer | null = null;
      let prop2: SpriteLayer | null = null;
      let sym: SpriteLayer | null = now < ent.symUntil && ent.sym ? ATLAS.syms[ent.sym] || null : null;

      if (pose === 'dangle') {
        shadow = null;
        eyes = p.eyes.wide;
        const flails = ['dangle', 'flailA', 'dangle2', 'flailB'];
        legs = p.legs[flails[phase4]];
        if (!isCat) {
          body = tickIdx % 2 === 0 ? p.body.turnL : p.body.turnR;
          clawL = p.clawL.up;
          clawR = p.clawR.up;
        } else {
          ears = p.ears.airplane;
          tail = p.tail.puff;
        }
      } else if (pose === 'flat') {
        shadow = p.shadow.w14;
        body = p.body.flat;
        eyes = p.eyes.flatEyes;
        legs = null;
        if (!isCat) {
          clawL = p.clawL.flatLeft;
          clawR = p.clawR.flatRight;
        } else {
          ears = p.ears.flat;
          tail = p.tail.curl;
        }
      } else if (pose === 'happy' || pose === 'pet') {
        eyes = p.eyes.happy;
        if (!isCat) {
          body = tickIdx % 2 === 0 ? p.body.squash : p.body.stand;
          legs = tickIdx % 2 === 0 ? p.legs.crouch : p.legs.stand;
          clawL = p.clawL.up;
          clawR = p.clawR.up;
        } else {
          ears = tickIdx % 2 === 0 ? p.ears.nod : p.ears.stand;
          paws = p.paws.cheer;
          tail = tickIdx % 2 === 0 ? p.tail.up : p.tail.puff;
        }
      } else if (pose === 'wow') {
        eyes = p.eyes.wide;
        if (!isCat) {
          body = p.body.tall;
          clawL = p.clawL.up;
          clawR = p.clawR.up;
        } else {
          paws = p.paws.up;
          tail = p.tail.puff;
        }
      } else if (pose === 'angry') {
        body = tickIdx % 2 === 0 ? p.body.squash : p.body.stand;
        legs = tickIdx % 2 === 0 ? p.legs.walkA : p.legs.walkB;
        if (!isCat) {
          eyes = p.eyes.squint;
        } else {
          ears = p.ears.airplane;
          eyes = p.eyes.wide;
          tail = p.tail.puff;
        }
        if (!sym) sym = ATLAS.syms.vein;
      } else if (pose === 'wave') {
        const w = clipTick < 12;
        const b = Math.floor(clipTick / 2) % 2;
        eyes = p.eyes.happy;
        if (isCat) {
          ears = p.ears.nod;
          paws = w && !b ? p.paws.upR : p.paws.none;
        } else {
          clawR = w ? (b ? p.clawR.waveOut : p.clawR.up) : p.clawR.stub;
        }
        if (!sym) sym = ATLAS.syms.note;
      } else if (pose === 'feedCoffee') {
        eyes = p.eyes.happy;
        prop1 = clipMod ? ATLAS.props.hotCup0 : ATLAS.props.hotCup1;
        if (!isCat) clawR = p.clawR.front;
        else {
          ears = clipMod ? p.ears.nod : p.ears.stand;
          tail = clipMod ? p.tail.up : p.tail.puff;
        }
        if (!sym) sym = ATLAS.syms.heart;
      } else if (pose === 'slashLearnBook') {
        eyes = clipMod ? p.eyes.half : p.eyes.open;
        prop1 = clipMod ? ATLAS.props.book0 : ATLAS.props.book1;
        if (!isCat) clawR = p.clawR.front;
        else {
          ears = p.ears.nod;
          paws = p.paws.write1;
          tail = p.tail.sway;
        }
        if (!sym) sym = ATLAS.syms.note;
      } else if (pose === 'sleep') {
        if (isCat) {
          shadow = p.shadow.w14;
          ears = p.ears.loaf;
          body = p.body.loaf;
          legs = null;
          eyes = phase4 === 3 ? p.eyes.loafShut : p.eyes.loafHalf;
          tail = p.tail.loaf;
        } else {
          body = p.body.squash;
          eyes = p.eyes.shut;
          legs = p.legs.tuck;
        }
        if (!sym) sym = [ATLAS.syms.dozeZ0, ATLAS.syms.dozeZ1, ATLAS.syms.dozeZ2][Math.floor(tickIdx / 5) % 3];
      } else if (pose === 'cheerSticks') {
        body = tickIdx % 2 === 0 ? p.body.squash : p.body.stand;
        legs = tickIdx % 2 === 0 ? p.legs.crouch : p.legs.stand;
        eyes = p.eyes.happy;
        const st1 = ['stickLT', 'stickUp', 'stickRT', 'stickUp'][phase4];
        const st2 = ['stickRTM', 'stickUpM', 'stickLTM', 'stickUpM'][phase4];
        prop1 = ATLAS.props[st1];
        prop2 = ATLAS.props[st2];
        if (!isCat) {
          clawL = p.clawL.up;
          clawR = p.clawR.up;
        } else {
          ears = clipMod ? p.ears.stand : p.ears.nod;
          paws = p.paws.up;
          tail = p.tail.puff;
        }
        if (!sym) sym = ATLAS.syms.note;
      } else if (isBusy) {
        // Energetic working loop
        const hopUp = (isCat ? tickIdx % 4 >= 2 : tickIdx % 4 < 2);
        if (hopUp) {
          body = p.body.squash;
          legs = p.legs.crouch;
        } else {
          legs = tickIdx % 6 < 3 ? p.legs.walkA : p.legs.walkB;
        }
        if (!isCat) {
          clawL = hopUp ? p.clawL.up : p.clawL.stub;
          clawR = hopUp ? p.clawR.up : p.clawR.stub;
        } else {
          tail = hopUp ? p.tail.puff : p.tail.sway;
          paws = hopUp ? p.paws.cheer : p.paws.none;
        }
        if (!sym && !isCat && tickIdx % 6 < 3) sym = ATLAS.syms.spark;
      }

      if (approvalRef.current && !isCat && !sym && pose === 'idle') {
        sym = ATLAS.syms.bang;
      }

      // Floating Ice Crystal above Clawd (when no head prop / non-sleep symbol blocks it)
      const hideCrystal = pose === 'flat' || pose === 'cheerSticks' || (sym && sym !== ATLAS.syms.dozeZ0 && sym !== ATLAS.syms.dozeZ1 && sym !== ATLAS.syms.dozeZ2);
      const crystal =
        !isCat && !hideCrystal
          ? (tickIdx % (isBusy ? 4 : 8) < (isBusy ? 2 : 4) ? ATLAS.props.iceCrystal : ATLAS.props.iceCrystalHi)
          : null;

      const out: SpriteLayer[] = [];
      if (shadow) out.push(shadow);
      if (legs) out.push(legs);
      if (body) out.push(body);
      if (ears) out.push(ears);
      if (eyes) out.push(eyes);
      if (clawL) out.push(clawL);
      if (clawR) out.push(clawR);
      if (paws) out.push(paws);
      if (tail) out.push(tail);
      if (prop1) out.push(prop1);
      if (prop2) out.push(prop2);
      if (crystal) out.push(crystal);
      if (sym) out.push(sym);
      return out;
    };

    const renderAll = (now = performance.now()) => {
      syncDom();
      if (catCanvasRef.current) {
        renderSpriteToCanvas(catCanvasRef.current, 'cat', resolveLayersFor(actors.cat, now), actors.cat.mirror);
      }
      if (clawdCanvasRef.current) {
        renderSpriteToCanvas(clawdCanvasRef.current, 'clawd', resolveLayersFor(actors.clawd, now), actors.clawd.mirror);
      }
    };

    const trySnapOntoOther = (mover: ActorState, now: number): boolean => {
      if (mover.dragging) return false;
      const other = actors[mover.id === 'cat' ? 'clawd' : 'cat'];
      if (other.dragging || other.ballisticActive || other.stackedOn === mover.id) return false;
      const otherWx = worldX(other);
      const otherWy = worldY(other);
      const perchY = otherWy - MOUNT_STEP_H;
      if (Math.abs(mover.x - otherWx) <= 30 && mover.y >= perchY - 24 && mover.y <= perchY + 20) {
        mover.flightSeq += 1;
        mover.ballisticActive = false;
        mover.vx = 0;
        mover.vy = 0;
        mover.rot = 0;
        mover.stackedOn = other.id;
        mover.y = 0;
        startClip(mover, 'happy', 950, 'heart');
        renderAll(now);
        return true;
      }
      return false;
    };

    const startGravitySettle = (rider: ActorState) => {
      if (reducedMotion) {
        rider.stackedOn = null;
        rider.y = 0;
        rider.rot = 0;
        enforceGroundSeparation();
        renderAll(performance.now());
        return;
      }
      const seq = ++rider.flightSeq;
      rider.ballisticActive = true;
      let vy = 0.65;
      let prev = performance.now();
      const step = (now: number) => {
        if (disposed || seq !== rider.flightSeq || rider.dragging) {
          if (disposed || rider.dragging) rider.ballisticActive = false;
          return;
        }
        const k = Math.max(0.5, Math.min(2.5, (now - prev) / 16.6667));
        prev = now;
        vy = Math.min(14, vy + 0.54 * k);
        rider.y += vy * k;
        rider.vy = vy;
        if (rider.y >= 0) {
          rider.y = 0;
          rider.vy = 0;
          rider.vx = 0;
          rider.rot = 0;
          rider.ballisticActive = false;
          startClip(rider, 'flat', 180);
          enforceGroundSeparation();
          renderAll(now);
          return;
        }
        renderAll(now);
        rider.rafId = window.requestAnimationFrame(step);
      };
      rider.rafId = window.requestAnimationFrame(step);
    };

    const startEntityBallistic = (ent: ActorState, vx0: number, vy0: number, noSnap = false) => {
      if (reducedMotion) {
        ent.ballisticActive = false;
        ent.vx = 0;
        ent.vy = 0;
        ent.rot = 0;
        if (noSnap || !trySnapOntoOther(ent, performance.now())) {
          ent.y = 0;
          enforceGroundSeparation();
          renderAll(performance.now());
        }
        return;
      }
      const seq = ++ent.flightSeq;
      let vx = Math.max(-18, Math.min(18, vx0));
      let vy = Math.max(-18, Math.min(18, vy0));
      let bounces = 0;
      ent.ballisticActive = true;
      let prev = performance.now();

      const step = (now: number) => {
        if (disposed || seq !== ent.flightSeq || ent.dragging) {
          if (disposed || ent.dragging) ent.ballisticActive = false;
          return;
        }
        if (document.hidden) {
          ent.ballisticActive = false;
          ent.y = 0;
          ent.vx = 0;
          ent.vy = 0;
          ent.rot = 0;
          enforceGroundSeparation();
          renderAll(now);
          return;
        }

        const k = Math.max(0.5, Math.min(2.5, (now - prev) / 16.6667));
        prev = now;
        vy += 0.44 * k;
        const drag = Math.pow(0.988, k);
        vx *= drag;
        vy *= drag;

        ent.x += vx * k;
        ent.y += vy * k;
        const maxX = getStageMaxX();
        if (ent.x < 4) {
          ent.x = 4;
          vx = -0.45 * vx;
        } else if (ent.x > maxX) {
          ent.x = maxX;
          vx = -0.45 * vx;
        }
        if (ent.y < -180) {
          ent.y = -180;
          vy = -0.45 * vy;
        }
        ent.vx = vx;
        ent.vy = vy;

        if (!noSnap && vy >= 0 && trySnapOntoOther(ent, now)) return;

        // Ballistic collision with grounded other pet
        const other = actors[ent.id === 'cat' ? 'clawd' : 'cat'];
        if (
          !other.dragging &&
          !other.stackedOn &&
          !ent.stackedOn &&
          Math.abs(ent.x - other.x) < 40 &&
          Math.abs(ent.y - other.y) < 22 &&
          ((ent.x < other.x && vx > 0.35) || (ent.x >= other.x && vx < -0.35)) &&
          canPair('ballisticBump', now, 650)
        ) {
          const sign = ent.x < other.x ? -1 : 1;
          ent.x = clampX(other.x + sign * 40);
          const incomingVx = vx;
          vx = -incomingVx * 0.46;
          if (Math.abs(vx) < 1.6) vx = sign * 1.8;
          ent.sym = 'sweat';
          ent.symUntil = now + 750;
          other.mirror = sign < 0;
          startClip(other, 'wow', 800, 'bang');
          startEntityBallistic(other, Math.max(-7.2, Math.min(7.2, incomingVx * 0.62 || -sign * 2.6)), -2.7, true);
        }

        if (ent.y >= 0) {
          ent.y = 0;
          if (Math.abs(vy) > 2.4 && bounces < 2) {
            vy = -vy * 0.36;
            vx *= 0.82;
            bounces += 1;
            startClip(ent, 'flat', 140);
          } else {
            ent.ballisticActive = false;
            ent.vx = 0;
            ent.vy = 0;
            ent.rot = 0;
            startClip(ent, 'flat', 180);
            if (ent.throws >= 3) {
              ent.throws = 0;
              startClip(ent, 'angry', 1400, 'vein');
            }
            enforceGroundSeparation();
            renderAll(now);
            return;
          }
        }

        ent.rot = Math.max(-14, Math.min(14, -vx * 0.65));
        ent.vx = vx;
        ent.vy = vy;
        renderAll(now);
        ent.rafId = window.requestAnimationFrame(step);
      };

      ent.rafId = window.requestAnimationFrame(step);
    };

    const bindPointer = (ent: ActorState, hitEl: HTMLDivElement) => {
      let downX = 0;
      let downY = 0;
      let startX = 0;
      let startY = 0;
      let lastMoveX = 0;
      let lastMoveY = 0;
      let lastMoveT = 0;
      let moved = false;
      let petTimer = 0;
      let petTriggered = false;

      const onDown = (evt: PointerEvent) => {
        if (evt.button !== 0) return;
        evt.preventDefault();
        evt.stopPropagation();
        try {
          hitEl.setPointerCapture(evt.pointerId);
        } catch {
          // ignore
        }

        ent.flightSeq += 1;
        ent.ballisticActive = false;
        downX = evt.clientX;
        downY = evt.clientY;
        startX = worldX(ent);
        startY = worldY(ent);
        lastMoveX = evt.clientX;
        lastMoveY = evt.clientY;
        lastMoveT = performance.now();
        moved = false;
        petTriggered = false;

        window.clearTimeout(petTimer);
        petTimer = window.setTimeout(() => {
          if (!moved && !disposed) {
            petTriggered = true;
            startClip(ent, 'pet', 1100, 'heart');
            renderAll(performance.now());
          }
        }, 360);
      };

      const onMove = (evt: PointerEvent) => {
        if (lastMoveT === 0) return;
        const dxTotal = evt.clientX - downX;
        const dyTotal = evt.clientY - downY;

        if (!moved && Math.hypot(dxTotal, dyTotal) > 7) {
          moved = true;
          window.clearTimeout(petTimer);
          const other = actors[ent.id === 'cat' ? 'clawd' : 'cat'];
          if (other.stackedOn === ent.id) {
            other.x = worldX(other);
            other.y = worldY(other);
            other.stackedOn = null;
            startGravitySettle(other);
          }
          ent.stackedOn = null;
          ent.dragging = true;
          ent.x = startX;
          ent.y = startY;
        }
        if (!moved) return;

        evt.stopPropagation();
        const now = performance.now();
        const dt = Math.max(4, now - lastMoveT);
        ent.vx = ent.vx * 0.4 + (((evt.clientX - lastMoveX) / dt) * 16) * 0.6;
        ent.vy = ent.vy * 0.4 + (((evt.clientY - lastMoveY) / dt) * 16) * 0.6;
        ent.rot = Math.max(-14, Math.min(14, -ent.vx * 0.7));
        ent.mirror = ent.vx < -0.4 ? true : ent.vx > 0.4 ? false : ent.mirror;
        lastMoveX = evt.clientX;
        lastMoveY = evt.clientY;
        lastMoveT = now;

        ent.x = clampX(startX + dxTotal);
        ent.y = Math.max(-180, Math.min(0, startY + dyTotal));

        // Ground drag pass / bump interaction with the other pet
        if (!reducedMotion && ent.y > -22) {
          const other = actors[ent.id === 'cat' ? 'clawd' : 'cat'];
          if (!other.dragging && !other.stackedOn && other.y === 0 && Math.abs(ent.x - other.x) < 38) {
            if (Math.abs(ent.vx) >= 2.0 && canPair('dragBump', now, 750)) {
              const pushDir = ent.vx >= 0 ? 1 : -1;
              other.mirror = pushDir > 0;
              startClip(other, 'wow', 750, 'bang');
              startEntityBallistic(other, pushDir * Math.min(5.2, Math.abs(ent.vx) * 0.58), -2.5, true);
            } else if (Math.abs(ent.vx) < 2.0 && canPair('dragPass', now, 1400)) {
              other.mirror = ent.x < other.x;
              startClip(other, 'wave', 750, 'note');
            }
          }
        }
        renderAll(now);
      };

      const onUp = (evt: PointerEvent) => {
        if (lastMoveT === 0) return;
        window.clearTimeout(petTimer);
        try {
          hitEl.releasePointerCapture(evt.pointerId);
        } catch {
          // ignore
        }
        const prevMoveT = lastMoveT;
        lastMoveT = 0;
        const pNow = performance.now();

        if (moved) {
          ent.dragging = false;
          if (pNow - prevMoveT > 35) {
            ent.vx = 0;
            ent.vy = 0;
          }
          if (Math.hypot(ent.vx, ent.vy) < 4.5 && trySnapOntoOther(ent, pNow)) {
            moved = false;
            return;
          }
          const wallNow = Date.now();
          if (wallNow - ent.lastThrowAt > 8000) ent.throws = 0;
          ent.throws += 1;
          ent.lastThrowAt = wallNow;
          startEntityBallistic(ent, ent.vx * 0.85, ent.vy * 0.85);
          moved = false;
          return;
        }

        if (!petTriggered) {
          if (pNow - ent.lastTapAt < 340) {
            // Double tap: cycle easter egg animations
            ent.lastTapAt = 0;
            const egg = EASTER_EGGS[ent.eggIdx % EASTER_EGGS.length];
            ent.eggIdx += 1;
            startClip(ent, egg.pose, egg.ms);
            renderAll(pNow);
          } else {
            ent.lastTapAt = pNow;
            startClip(ent, 'happy', 850, 'heart');
            if (!ent.stackedOn && !reducedMotion) {
              startEntityBallistic(ent, 0, -3.2, true);
            } else {
              renderAll(pNow);
            }
          }
        }
      };

      hitEl.addEventListener('pointerdown', onDown);
      hitEl.addEventListener('pointermove', onMove);
      hitEl.addEventListener('pointerup', onUp);
      hitEl.addEventListener('pointercancel', onUp);

      return () => {
        window.clearTimeout(petTimer);
        hitEl.removeEventListener('pointerdown', onDown);
        hitEl.removeEventListener('pointermove', onMove);
        hitEl.removeEventListener('pointerup', onUp);
        hitEl.removeEventListener('pointercancel', onUp);
      };
    };

    const unbindCat = catHitRef.current ? bindPointer(actors.cat, catHitRef.current) : () => {};
    const unbindClawd = clawdHitRef.current ? bindPointer(actors.clawd, clawdHitRef.current) : () => {};

    renderAll(performance.now());

    const tickTimer = window.setInterval(() => {
      if (disposed || document.hidden) return;
      tickIdx += 1;
      if (reducedMotion && tickIdx % 6 !== 0) return;
      renderAll(performance.now());
    }, 100);

    const onResize = () => {
      actors.cat.x = clampX(actors.cat.x);
      actors.clawd.x = clampX(actors.clawd.x);
      renderAll(performance.now());
    };
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      window.clearInterval(tickTimer);
      window.cancelAnimationFrame(actors.cat.rafId);
      window.cancelAnimationFrame(actors.clawd.rafId);
      window.removeEventListener('resize', onResize);
      unbindCat();
      unbindClawd();
    };
  }, []);

  return (
    <div
      ref={stageRef}
      className="pointer-events-none select-none absolute left-0 right-0 bottom-full h-0 overflow-visible z-20"
      aria-hidden="true"
    >
      {/* Gemini Cat hit container + overflowing crisp pixel canvas */}
      <div
        ref={catHitRef}
        title="轻点开心 · 长按撒娇 · 拖拽抛飞 · 双击彩蛋"
        style={{ width: HIT_W, height: HIT_H }}
        className="pointer-events-auto touch-none absolute left-0 bottom-[-1px] overflow-visible select-none"
      >
        <canvas
          ref={catCanvasRef}
          style={{ width: CANVAS_W, height: CANVAS_H, left: (HIT_W - CANVAS_W) / 2 }}
          className="pointer-events-none absolute bottom-0"
        />
      </div>

      {/* Clawd hit container + overflowing crisp pixel canvas */}
      <div
        ref={clawdHitRef}
        title="轻点开心 · 长按撒娇 · 拖拽抛飞 · 双击彩蛋"
        style={{ width: HIT_W, height: HIT_H }}
        className="pointer-events-auto touch-none absolute left-0 bottom-[-1px] overflow-visible select-none"
      >
        <canvas
          ref={clawdCanvasRef}
          style={{ width: CANVAS_W, height: CANVAS_H, left: (HIT_W - CANVAS_W) / 2 }}
          className="pointer-events-none absolute bottom-0"
        />
      </div>

      {/* Right-side Pixel Cactus */}
      <div className="absolute right-4 bottom-[-1px] pointer-events-none">
        <canvas ref={cactusCanvasRef} style={{ width: 20, height: 20 }} />
      </div>
    </div>
  );
}
