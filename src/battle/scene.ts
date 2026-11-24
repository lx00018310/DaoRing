// ============================================================
// 斗法场景 · Canvas 渲染与「演武巨殿」原生场景融合 + 21:9 漫画特写演出
// 镜头构图：
//   1. 主角原生绘入左下后肩前景（bg_martial_plaza_ots.webp），零贴图接缝；
//   2. 对手按真实透视比例立于演武场远端中心石台，带夕阳逆光长影与接触投影；
//   3. 主角发招（万剑诀 / 灵爆术）由前景石阵沿纵深射向远处对手，随距离自然透视缩小；
//   4. 对手反击 / 致命一击先切入 21:9 漫画镜头拉近特写，随即魔焰血雷由远及近扑向前景。
// 本文件只负责「怎么画」；「发生了什么」全部来自引擎日志构建的 Timeline。
// ============================================================
import { getDaoConfig } from '../config';
import type { DaoCategory, RingTrack } from '../types';
import { BATTLE_CONFIG } from './battleConfig';
import { CATEGORY_HEX, CATEGORY_RGB, ROMAN, formatQi, glyphOf } from './daoVisual';
import { FOE_CUTIN_STYLE, type FoeArt, type FoeConfig } from './foes';
import {
  LAYOUT,
  STAGE_H,
  STAGE_W,
  ringRadius,
  slotAngle,
  slotPoint,
  type Point,
  type SlotRef,
} from './geometry';
import { sfx } from './sfx';
import { pulseStateAt, type Beat, type MoveKind, type Timeline } from './timeline';

const TAU = Math.PI * 2;
const RING_COUNT = 5;

/** 演武巨殿 OTS 视角（bg_martial_plaza_ots.webp）中 6 处可见火盆的精确坐标 */
const BRAZIERS: readonly { x: number; y: number; r: number; phase: number }[] = [
  { x: 189, y: 451, r: 155, phase: 0.2 },
  { x: 665, y: 447, r: 68, phase: 2.6 },
  { x: 1017, y: 411, r: 66, phase: 3.7 },
  { x: 1229, y: 443, r: 95, phase: 4.9 },
  { x: 1405, y: 450, r: 165, phase: 0.9 },
  { x: 1572, y: 427, r: 112, phase: 2.1 },
];

export interface SceneAssets {
  /** 各大境界的背景（下标 0 = 炼气）；缺省时沿用最后一张 */
  backgrounds: string[];
  /** 可选独立主角立绘；为空时表示主角已原生绘入背景 OTS 前景中 */
  hero?: string;
  /** 每个大境界的远景敌人立绘 */
  foes: Record<FoeArt, string>;
  /** 每个大境界的 21:9 漫画发招特写图 */
  cutins?: Record<FoeArt, string>;
  /** 8 种道韵的悬空灵印珠贴图（configId -> 路径） */
  daos?: Record<string, string>;
}

/** UI 每次渲染时推给场景的阵盘视图 */
export interface SceneBoardView {
  board: RingTrack[];
  placing: boolean;
  moveTargeting: boolean;
  target: SlotRef | null;
  hover: SlotRef | null;
}

export interface PlayOptions {
  threshold: number;
  onHit: (shownTotal: number) => void;
  onBeat?: (beat: Beat, power: { baseQi: number; multiplier: number }) => void;
  onEnergy?: (boost: number) => void;
}

interface Playback {
  timeline: Timeline;
  step: number;
  capBeat: number;
  beats: Beat[];
  tailQi: number;
  tailCount: number;
  tailFired: boolean;
  clock: number;
  next: number;
  flowEnd: number;
  shown: number;
  crossed: boolean;
  swordsLeft: number;
  seenRelease: Set<string>;
  comboStep: number;
  opts: PlayOptions;
  resolve: () => void;
  trails: Map<string, Point[]>;
  startedAt: number;
  lastFloat: Map<string, number>;
}

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; r: number; sprite: HTMLCanvasElement; drag: number;
}
interface Wave { x: number; y: number; r: number; maxR: number; life: number; max: number; rgb: string; }
interface Ash { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number; delay: number; }
interface Smoke { x: number; y: number; vx: number; vy: number; r: number; life: number; max: number; }
interface Bolt { pts: [number, number][]; life: number; max: number; rgb: string; width: number; }
interface FloatText { x: number; y: number; text: string; color: string; size: number; life: number; max: number; age: number; }
interface Projectile {
  kind: 'sword' | 'orb' | 'foeOrb';
  x0: number; y0: number; x1: number; y1: number; cx: number; cy: number;
  x: number; y: number; angle: number;
  t: number; dur: number; trail: Point[];
  qi: number; size: number; charge: number;
  rgb?: string;
}
interface Fog { x: number; y: number; s: number; v: number; a: number; near: boolean; }
interface Ember { x: number; y: number; vx: number; vy: number; r: number; p: number; warm: boolean; }

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function glowSprite(rgb: string, hard = false): HTMLCanvasElement {
  const c = canvasOf(128, 128);
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, `rgba(${rgb},1)`);
  g.addColorStop(hard ? 0.18 : 0.24, `rgba(${rgb},${hard ? 0.85 : 0.55})`);
  g.addColorStop(0.55, `rgba(${rgb},0.14)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return c;
}

function radialSprite(w: number, h: number, stops: [number, string][]): HTMLCanvasElement {
  const c = canvasOf(w, h);
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) / 2);
  stops.forEach(([o, col]) => g.addColorStop(o, col));
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  return c;
}

function silhouette(img: HTMLImageElement, color: string): HTMLCanvasElement {
  const c = canvasOf(img.naturalWidth, img.naturalHeight);
  const x = c.getContext('2d')!;
  x.drawImage(img, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

const easeInOut = (k: number): number => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const ready = (img: HTMLImageElement | undefined): img is HTMLImageElement => !!img && img.complete && img.naturalWidth > 0;

export class BattleScene {
  public view: SceneBoardView = { board: [], placing: false, moveTargeting: false, target: null, hover: null };
  public foe: FoeConfig | null = null;
  public tribulationId: string | null = null;
  public readonly ringReveal: number[] = [1, 0, 0, 0, 0];
  public readonly reducedMotion: boolean;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly img: {
    bgs: HTMLImageElement[];
    hero: HTMLImageElement | null;
    foes: Record<FoeArt, HTMLImageElement>;
    daos: Record<string, HTMLImageElement>;
  };
  private readonly cutinSrcs: Partial<Record<FoeArt, string>>;
  private readonly cutinLayer: HTMLElement | null;
  private bgIndex = 0;
  private bgPrev = 0;
  private bgFade = 1;
  private readonly glow = {
    teal: glowSprite('96,255,226'),
    gold: glowSprite('255,210,104'),
    red: glowSprite('255,68,48'),
    white: glowSprite('255,255,255', true),
    orange: glowSprite('255,134,54'),
    amber: glowSprite('255,172,72'),
    violet: glowSprite('196,142,255'),
    emerald: glowSprite('72,255,164'),
  };
  private readonly smokeSprite = radialSprite(128, 128, [[0, 'rgba(22,6,14,.84)'], [0.5, 'rgba(32,10,18,.32)'], [1, 'rgba(32,10,18,0)']]);
  private readonly fogSprite = radialSprite(256, 128, [[0, 'rgba(225,152,108,.26)'], [0.55, 'rgba(140,86,74,.10)'], [1, 'rgba(110,68,62,0)']]);
  private readonly foeWhite = new Map<FoeArt, HTMLCanvasElement>();
  private readonly foeGold = new Map<FoeArt, HTMLCanvasElement>();
  private heroRed: HTMLCanvasElement | null = null;

  private time = 0;
  private last = 0;
  private slowmo = 0;
  private hitstop = 0;
  private impactFrame = 0;
  private zoom = 1;
  private targetZoom = 1;
  private shake = 0;
  private flash = 0;
  private flashRgb = '255,255,255';
  private rimFlash = 0;
  private mouse = { x: 0, y: 0 };
  private heroAlpha = 1;
  private heroHit = 0;
  private heroCast = 0;
  private foeAlpha = 0;
  private foeHit = 0;
  private foeKnock = 0;
  private foeDead = true;
  private nextAmbientBolt = 1.8;
  private nextTribBolt = 2;
  private desaturate = false;
  private beam: { t: number; dur: number } | null = null;
  private playback: Playback | null = null;

  private readonly particles: Particle[] = [];
  private readonly waves: Wave[] = [];
  private readonly ash: Ash[] = [];
  private readonly smokes: Smoke[] = [];
  private readonly bolts: Bolt[] = [];
  private readonly floats: FloatText[] = [];
  private readonly projectiles: Projectile[] = [];
  private readonly slotFx: number[][];
  private readonly fogs: Fog[] = [];
  private readonly embers: Ember[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly fxLayer: HTMLElement,
    assets: SceneAssets,
    ringSlots: readonly number[],
    cutinLayer: HTMLElement | null = null,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.cutinLayer = cutinLayer;
    this.cutinSrcs = assets.cutins ?? {};
    const load = (src: string): HTMLImageElement => {
      const image = new Image();
      image.src = src;
      return image;
    };
    const foes = {} as Record<FoeArt, HTMLImageElement>;
    (Object.keys(assets.foes) as FoeArt[]).forEach((art) => { foes[art] = load(assets.foes[art]); });
    // 预加载 21:9 漫画特写图，发招瞬间零延迟切入
    Object.values(this.cutinSrcs).forEach((src) => { if (src) load(src); });
    const daos: Record<string, HTMLImageElement> = {};
    if (assets.daos) {
      Object.entries(assets.daos).forEach(([id, src]) => { daos[id] = load(src); });
    }
    this.img = {
      bgs: assets.backgrounds.map(load),
      hero: assets.hero ? load(assets.hero) : null,
      foes,
      daos,
    };
    this.slotFx = ringSlots.map((n) => Array.from({ length: n }, () => 0));
    this.reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    for (let i = 0; i < 12; i++) {
      this.fogs.push({ x: Math.random() * 1800 - 100, y: 460 + Math.random() * 340, s: 1.5 + Math.random() * 2.2, v: 5 + Math.random() * 12, a: 0.14 + Math.random() * 0.18, near: i < 4 });
    }
    for (let i = 0; i < (this.reducedMotion ? 16 : 60); i++) {
      const warm = i < 48;
      this.embers.push({
        x: Math.random() * STAGE_W,
        y: Math.random() * STAGE_H,
        vx: warm ? (10 + Math.random() * 24) : (Math.random() - 0.5) * 10,
        vy: warm ? (16 + Math.random() * 38) : (8 + Math.random() * 16),
        r: warm ? (2.2 + Math.random() * 4.2) : (2.8 + Math.random() * 4.5),
        p: Math.random() * TAU,
        warm,
      });
    }
    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX / window.innerWidth - 0.5;
      this.mouse.y = e.clientY / window.innerHeight - 0.5;
    });
  }

  // ------------------------------------------------------------ 生命周期

  start(): void {
    const loop = (now: number): void => {
      const real = Math.max(0, (now - this.last) / 1000 || 0);
      this.last = now;
      const rdt = Math.min(0.05, real);
      const clockDt = Math.min(0.5, real);

      if (this.impactFrame > 0) this.impactFrame = Math.max(0, this.impactFrame - rdt);
      if (this.hitstop > 0) {
        this.hitstop = Math.max(0, this.hitstop - rdt);
        this.render();
        requestAnimationFrame(loop);
        return;
      }

      let scale = 1;
      if (this.slowmo > 0) {
        this.slowmo -= clockDt;
        scale = 0.28;
      }
      this.update(rdt * scale, rdt, clockDt * scale);
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame((now) => {
      this.last = now;
      loop(now);
    });
  }

  reset(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    if (this.playback) {
      const pb = this.playback;
      this.playback = null;
      pb.resolve();
    }
    this.hideCutIn();
    this.particles.length = 0;
    this.waves.length = 0;
    this.ash.length = 0;
    this.smokes.length = 0;
    this.bolts.length = 0;
    this.floats.length = 0;
    this.projectiles.length = 0;
    this.fxLayer.replaceChildren();
    this.beam = null;
    this.heroAlpha = 1;
    this.heroHit = 0;
    this.foeAlpha = 0;
    this.foeDead = true;
    this.shake = 0;
    this.flash = 0;
    this.rimFlash = 0;
    this.slowmo = 0;
    this.hitstop = 0;
    this.impactFrame = 0;
    this.zoom = 1;
    this.targetZoom = 1;
    this.desaturate = false;
    this.canvas.classList.remove('dead');
    this.tribulationId = null;
    this.ringReveal.splice(0, RING_COUNT, 1, 0, 0, 0, 0);
    this.bgIndex = 0;
    this.bgPrev = 0;
    this.bgFade = 1;
  }

  get playing(): boolean {
    return this.playback !== null;
  }

  private wait(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, seconds * 1000);
      this.timers.add(timer);
    });
  }

  setMouseNeutral(): void {
    this.mouse.x = 0;
    this.mouse.y = 0;
  }

  private triggerChroma(): void {
    if (this.reducedMotion) return;
    const stage = this.canvas.parentElement;
    if (!stage) return;
    stage.classList.remove('chroma-hit');
    void stage.offsetWidth;
    stage.classList.add('chroma-hit');
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      stage.classList.remove('chroma-hit');
    }, 260);
    this.timers.add(timer);
  }

  // ------------------------------------------------------------ 空间几何（原生后肩 OTS + 远景对手落地）

  /** 轻微全景视差：同步带动背景、主角、火盆与远景对手，保证绝无相对滑移 */
  private bgParallax(): Point {
    return {
      x: -this.mouse.x * 16,
      y: -this.mouse.y * 8,
    };
  }

  private slotXY(ref: SlotRef): Point {
    return slotPoint(ref.ring, ref.slot, this.ringReveal[ref.ring] ?? 1);
  }

  private lerpSlots(from: SlotRef, to: SlotRef, k: number, kind: MoveKind): Point {
    let a1 = slotAngle(from.ring, from.slot);
    let a2 = slotAngle(to.ring, to.slot);
    if (from.ring === to.ring && (kind === 'step' || kind === 'split')) {
      while (a2 <= a1) a2 += TAU;
    } else {
      let d = a2 - a1;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      a2 = a1 + d;
    }
    const a = a1 + (a2 - a1) * k;
    const r1 = ringRadius(from.ring, this.ringReveal[from.ring] ?? 1);
    const r2 = ringRadius(to.ring, this.ringReveal[to.ring] ?? 1);
    const r = r1 + (r2 - r1) * k;
    const hop = kind === 'step' ? 0 : Math.sin(Math.PI * k) * (kind === 'split' ? 48 : 32);
    return { x: LAYOUT.cx + r * Math.cos(a), y: LAYOUT.cy + r * LAYOUT.ratio * Math.sin(a) - 18 - hop };
  }

  /** 主角施法点（位于背景原生后肩主角右肩前沿，向前注入石阵第一眼） */
  heroHand(): Point {
    const par = this.bgParallax();
    return { x: 472 + par.x, y: 618 + par.y };
  }

  /** 主角中心受击点（用于敌人反击雷焰扑击落点与浮字） */
  heroCore(): Point {
    const par = this.bgParallax();
    return { x: 345 + par.x, y: 610 + par.y };
  }

  /** 对手双脚在演武场远端中心石台上的精确锚点（随背景同步，零漂移） */
  private foeFoot(): Point {
    const par = this.bgParallax();
    return {
      x: 855 + par.x + this.foeKnock * 0.45,
      y: 506 + par.y,
    };
  }

  /** 远景对手透视包围盒：按真实距离缩放（约 132–182px），真正立于远端演武场中心 */
  private foeBox(): { x: number; y: number; w: number; h: number } {
    const scale = this.foe?.scale ?? 1;
    const h = 162 * scale;
    const img = this.foeImage();
    const ar = ready(img) ? img.naturalWidth / img.naturalHeight : 0.82;
    const w = h * ar;
    const foot = this.foeFoot();
    const breathe = this.reducedMotion ? 0 : Math.sin(this.time * 1.6) * 1.8;
    return { x: foot.x - 0.44 * w, y: foot.y - 0.94 * h + breathe, w, h };
  }

  private foeImage(): HTMLImageElement {
    return this.img.foes[this.foe?.art ?? 'elder'] ?? this.img.foes.elder;
  }

  foeCore(): Point {
    const b = this.foeBox();
    return { x: b.x + 0.44 * b.w, y: b.y + 0.46 * b.h };
  }

  private foeGlowSprite(): HTMLCanvasElement {
    switch (this.foe?.art) {
      case 'corpse': return this.glow.emerald;
      case 'lord': return this.glow.orange;
      case 'bone': return this.glow.violet;
      case 'god': return this.glow.gold;
      default: return this.glow.red;
    }
  }

  // ------------------------------------------------------------ 21:9 漫画镜头拉近特写

  private hideCutIn(): void {
    if (!this.cutinLayer) return;
    this.cutinLayer.classList.remove('show', 'exit');
    this.cutinLayer.hidden = true;
  }

  private async playCutIn(fatal = false): Promise<void> {
    const layer = this.cutinLayer;
    const art = this.foe?.art ?? 'elder';
    const src = this.cutinSrcs[art];
    if (!layer || !src) return;

    const style = FOE_CUTIN_STYLE[art];
    const imgEl = layer.querySelector<HTMLImageElement>('#cutin-img');
    const foeEl = layer.querySelector<HTMLElement>('#cutin-foe');
    const skillEl = layer.querySelector<HTMLElement>('#cutin-skill');

    if (imgEl) {
      imgEl.src = src;
      const hue = this.foe?.hue ?? 0;
      imgEl.style.filter = hue ? `hue-rotate(${Math.round(hue * 0.35)}deg) saturate(1.12)` : '';
    }
    if (foeEl) foeEl.textContent = this.foe?.name ?? '';
    if (skillEl) skillEl.textContent = fatal ? `绝杀 · ${style.skill}` : style.skill;
    layer.style.setProperty('--cutin-accent', style.accent);
    layer.style.setProperty('--cutin-rgb', style.rgb);

    layer.classList.remove('show', 'exit');
    layer.hidden = false;
    void layer.offsetWidth;
    layer.classList.add('show');

    sfx.whoosh();
    this.kick(fatal ? 14 : 9);
    this.flashScreen(0.24, style.rgb);

    const hold = this.reducedMotion ? 0.55 : (fatal ? 1.05 : 0.88);
    await this.wait(hold);

    layer.classList.add('exit');
    await this.wait(this.reducedMotion ? 0.12 : 0.22);
    this.hideCutIn();
  }

  // ------------------------------------------------------------ 特效原语

  private spark(x: number, y: number, n: number, sprite: HTMLCanvasElement, speed: number, life: number, size: number): void {
    const count = this.reducedMotion ? Math.ceil(n / 3) : n;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const v = speed * (0.3 + Math.random());
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.2, life: life * (0.6 + Math.random() * 0.6), max: life, r: size * (0.5 + Math.random()), sprite, drag: 0.9 });
    }
  }

  private ringWave(x: number, y: number, rgb: string, maxR: number, life: number): void {
    this.waves.push({ x, y, r: 10, maxR, life, max: life, rgb });
  }

  floatText(x: number, y: number, text: string, color: string, size = 26, life = 1.2): void {
    this.floats.push({ x, y, text, color, size, life, max: life, age: 0 });
  }

  private bolt(x1: number, y1: number, x2: number, y2: number, rgb = '255,70,60', life = 0.22, width = 3): void {
    let pts: [number, number][] = [[x1, y1], [x2, y2]];
    let disp = Math.hypot(x2 - x1, y2 - y1) * 0.22;
    for (let it = 0; it < 6; it++) {
      const next: [number, number][] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        next.push(a, [(a[0] + b[0]) / 2 + (Math.random() - 0.5) * disp, (a[1] + b[1]) / 2 + (Math.random() - 0.5) * disp]);
      }
      next.push(pts[pts.length - 1]);
      pts = next;
      disp *= 0.55;
    }
    this.bolts.push({ pts, life, max: life, rgb, width });
  }

  private kick(amount: number): void {
    if (!this.reducedMotion) this.shake = Math.max(this.shake, amount);
  }

  private flashScreen(amount: number, rgb: string): void {
    this.flash = Math.max(this.flash, this.reducedMotion ? amount * 0.4 : amount);
    this.flashRgb = rgb;
  }

  private dissolve(img: HTMLImageElement, box: { x: number; y: number; w: number; h: number }, tint: string | null): void {
    const step = 4;
    try {
      const c = canvasOf(Math.max(1, box.w | 0), Math.max(1, box.h | 0));
      const x = c.getContext('2d')!;
      x.drawImage(img, 0, 0, c.width, c.height);
      const data = x.getImageData(0, 0, c.width, c.height).data;
      for (let yy = 0; yy < c.height; yy += step) {
        for (let xx = 0; xx < c.width; xx += step) {
          const i = (yy * c.width + xx) * 4;
          if (data[i + 3] < 120) continue;
          this.ash.push({
            x: box.x + xx, y: box.y + yy, vx: (Math.random() - 0.35) * 35, vy: -20 - Math.random() * 55,
            life: 0.7 + Math.random() * 1.5 + ((c.height - yy) / c.height) * 0.5, max: 2.2,
            color: tint ?? `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`, size: step,
            delay: Math.random() * 0.4 + (xx / c.width) * 0.3,
          });
        }
      }
    } catch {
      for (let i = 0; i < 450; i++) {
        this.ash.push({ x: box.x + Math.random() * box.w, y: box.y + Math.random() * box.h, vx: (Math.random() - 0.3) * 35, vy: -18 - Math.random() * 50, life: 0.9 + Math.random() * 1.4, max: 2.3, color: tint ?? '#632', size: 4, delay: Math.random() * 0.4 });
      }
    }
  }

  splash(text: string, opts: { x?: number; y?: number; size?: number; dur?: number; tone?: 'gold' | 'red' | 'teal' } = {}): void {
    const el = document.createElement('div');
    el.className = `splash ${opts.tone ?? 'gold'}`;
    el.style.left = `${opts.x ?? 800}px`;
    el.style.top = `${opts.y ?? 380}px`;
    el.style.fontSize = `${opts.size ?? 170}px`;
    const span = document.createElement('span');
    span.textContent = text;
    span.style.setProperty('--d', `${opts.dur ?? 1.6}s`);
    el.append(span);
    this.fxLayer.append(el);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      el.remove();
    }, (opts.dur ?? 1.6) * 1000 + 100);
    this.timers.add(timer);
  }

  // ------------------------------------------------------------ 布阵反馈

  placeFx(ref: SlotRef, category: DaoCategory, overwrite = false): void {
    const p = this.slotXY(ref);
    const fx = this.slotFx[ref.ring];
    if (fx) fx[ref.slot] = overwrite ? 1.5 : 1.3;
    const sprite = category === 'AMPLIFY' ? this.glow.gold : category === 'RELEASE' ? this.glow.orange : this.glow.teal;
    this.ringWave(p.x, p.y - 4, CATEGORY_RGB[category], overwrite ? 105 : 78, 0.45);
    this.spark(p.x, p.y - 12, overwrite ? 28 : 20, sprite, overwrite ? 210 : 165, 0.75, overwrite ? 12 : 10);
  }

  removeFx(ref: SlotRef): void {
    const p = this.slotXY(ref);
    this.spark(p.x, p.y - 10, 20, this.glow.white, 120, 0.7, 8);
  }

  // ------------------------------------------------------------ 敌人登场 / 天劫

  enemyEnter(foe: FoeConfig): void {
    this.foe = foe;
    this.setBackground(foe.realm);
    this.foeDead = false;
    this.foeAlpha = 0;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const fc = this.foeCore();
      const foot = this.foeFoot();
      const style = FOE_CUTIN_STYLE[foe.art];
      for (let i = 0; i < 26; i++) {
        this.smokes.push({ x: foot.x + (Math.random() - 0.5) * 90, y: foot.y - Math.random() * 140, vx: (Math.random() - 0.5) * 40, vy: -14 - Math.random() * 22, r: 22 + Math.random() * 34, life: 1.4, max: 1.4 });
      }
      this.bolt(fc.x + 8, -20, fc.x, fc.y - 30, style.rgb, 0.28, 3);
      this.ringWave(foot.x, foot.y, style.rgb, 145, 0.65);
      sfx.thunder();
      this.flashScreen(0.18, style.rgb);
      this.splash(foe.name, { x: 855, y: 310, size: 52, dur: 1.9, tone: 'red' });
    }, 300);
    this.timers.add(timer);
  }

  setBackground(realm: number): void {
    const idx = Math.max(0, Math.min(this.img.bgs.length - 1, realm - 1));
    if (idx === this.bgIndex) return;
    this.bgPrev = this.bgIndex;
    this.bgIndex = idx;
    this.bgFade = this.reducedMotion ? 1 : 0;
  }

  tribulationOmen(tribId: string, name: string): void {
    this.tribulationId = tribId;
    const tone = tribId === 'trib_cloud' ? 'gold' : tribId === 'trib_demon' ? 'red' : 'teal';
    this.splash(name, { x: 800, y: 290, size: 96, dur: 2.4, tone });
    if (tribId === 'trib_thunder') {
      for (let i = 0; i < 3; i++) this.bolt(300 + Math.random() * 1000, -20, 300 + Math.random() * 1000, 300 + Math.random() * 300, '200,170,255', 0.35, 5);
      sfx.thunder();
      this.flashScreen(0.45, '220,200,255');
    } else if (tribId === 'trib_demon') {
      this.flashScreen(0.35, '255,30,30');
      sfx.fail();
    } else {
      this.flashScreen(0.35, '255,230,160');
      sfx.win();
    }
  }

  // ------------------------------------------------------------ 一回合演出

  play(timeline: Timeline, opts: PlayOptions): Promise<void> {
    if (this.playback) {
      const old = this.playback;
      this.playback = null;
      old.resolve();
    }
    const cfg = BATTLE_CONFIG.timings;
    const step = Math.max(cfg.beatMin, Math.min(cfg.beatMax, cfg.flowBudget / (timeline.maxT + 1)));
    const capBeat = Math.floor(cfg.flowCap / step);
    const beats = timeline.beats.filter((b) => b.t <= capBeat);
    const tail = timeline.beats.filter((b) => b.t > capBeat && b.kind === 'release');
    this.heroCast = 1;
    this.targetZoom = this.reducedMotion ? 1 : 1.035;
    this.beam = { t: 0, dur: 0.75 };
    const hand = this.heroHand();
    this.spark(hand.x, hand.y, 28, this.glow.teal, 175, 0.8, 10);
    sfx.whoosh();
    opts.onEnergy?.(0.65);
    return new Promise((resolve) => {
      this.playback = {
        timeline, step, capBeat, beats,
        tailQi: tail.reduce((sum, b) => sum + (b.qi ?? 0), 0), tailCount: tail.length, tailFired: false,
        clock: 0, next: 0,
        flowEnd: cfg.castLead + (Math.min(timeline.maxT, capBeat) + 1) * step,
        shown: 0, crossed: false, swordsLeft: BATTLE_CONFIG.maxSwordsPerTurn, seenRelease: new Set(),
        comboStep: 0,
        opts, resolve, trails: new Map(), startedAt: performance.now(), lastFloat: new Map(),
      };
    });
  }

  skip(): void {
    const pb = this.playback;
    if (!pb) return;
    this.projectiles.length = 0;
    this.beam = null;
    this.targetZoom = 1;
    pb.shown = pb.timeline.totalQi;
    pb.opts.onHit(pb.shown);
    this.finishPlayback();
  }

  private finishPlayback(): void {
    const pb = this.playback;
    if (!pb) return;
    this.targetZoom = 1;
    if (pb.shown !== pb.timeline.totalQi) {
      pb.shown = pb.timeline.totalQi;
      pb.opts.onHit(pb.shown);
    }
    pb.opts.onEnergy?.(0);
    this.playback = null;
    pb.resolve();
  }

  private powerForBeat(pb: Playback, beat: Beat): { baseQi: number; multiplier: number } {
    const track = pb.timeline.pulses.find((tr) => tr.id === beat.pulseId);
    if (!track) return { baseQi: 10, multiplier: 1 };
    let power = track.power[0];
    for (const entry of track.power) {
      if (entry.t <= beat.t) power = entry;
      else break;
    }
    return { baseQi: power.baseQi, multiplier: power.multiplier };
  }

  private fireBeat(pb: Playback, beat: Beat): void {
    const p = this.slotXY(beat.at);
    const fx = this.slotFx[beat.at.ring];
    const power = this.powerForBeat(pb, beat);
    pb.opts.onBeat?.(beat, power);

    if (beat.kind === 'release') {
      if (fx) fx[beat.at.slot] = 1.9;
      this.fireRelease(pb, beat, { x: p.x, y: p.y - 26 });
      return;
    }
    if (fx) fx[beat.at.slot] = Math.min(1.7, (fx[beat.at.slot] ?? 0) + 1.1);
    const floatKey = `${beat.at.ring}:${beat.at.slot}:${beat.kind}:${beat.text}`;
    const lastShown = pb.lastFloat.get(floatKey);
    const showFloat = beat.big || lastShown === undefined || pb.clock - lastShown > 0.6;
    if (showFloat) pb.lastFloat.set(floatKey, pb.clock);
    if (beat.kind === 'expire') {
      this.spark(p.x, p.y - 20, 12, this.glow.white, 60, 0.8, 6);
      if (showFloat) this.floatText(p.x, p.y - 56, beat.text, '#aab9b5', 20, 1);
      return;
    }
    const gold = beat.kind === 'amplify' || beat.kind === 'crit' || beat.kind === 'synergy';
    const color = gold ? CATEGORY_HEX.AMPLIFY : CATEGORY_HEX.CONDUCT;
    this.spark(p.x, p.y - 20, beat.big ? 38 : 16, gold ? this.glow.gold : this.glow.teal, beat.big ? 280 : 165, 0.72, beat.big ? 15 : 9);
    if (beat.big) {
      this.ringWave(p.x, p.y - 10, gold ? CATEGORY_RGB.AMPLIFY : CATEGORY_RGB.CONDUCT, 140, 0.6);
      this.kick(6);
      pb.opts.onEnergy?.(1.1);
    }
    if (showFloat) this.floatText(p.x, p.y - 62 - (beat.kind === 'synergy' ? 22 : 0), beat.text, color, beat.big ? 32 : 22, 1.1);
    const basePitch: Record<string, number> = { amplify: 0, crit: 4, split: 5, jump: 7, reverse: 1, synergy: 3, lucky: 6 };
    pb.comboStep = Math.min(10, pb.comboStep + 1);
    sfx.chime((basePitch[beat.kind] ?? 0) + pb.comboStep * 0.45);
  }

  private fireRelease(pb: Playback, beat: Beat, src: Point): void {
    const qi = beat.qi ?? 0;
    const isSword = beat.releaseName?.includes('剑') ?? false;
    this.ringWave(src.x, src.y + 18, '255,150,90', 165, 0.55);
    this.spark(src.x, src.y, 32, this.glow.orange, 260, 0.72, 13);
    this.kick(5);
    pb.opts.onEnergy?.(1.25);
    const name = beat.releaseName ?? '';
    if (!pb.seenRelease.has(name)) {
      pb.seenRelease.add(name);
      this.splash(isSword ? '万剑诀' : '灵爆术', { x: 855, y: 310, size: 104, dur: 1.35 });
    }
    const fc = this.foeCore();
    const share = qi / Math.max(1, pb.opts.threshold);
    if (isSword && pb.swordsLeft > 0) {
      const n = Math.min(pb.swordsLeft, Math.max(4, Math.min(16, 4 + Math.round(share * 11))));
      pb.swordsLeft -= n;
      sfx.sword();
      for (let i = 0; i < n; i++) {
        // 飞剑群从石阵弧线纵深齐射向远端对手
        const tx = fc.x + (Math.random() - 0.5) * 68;
        const ty = fc.y + (Math.random() - 0.5) * 90;
        const spreadX = (Math.random() - 0.5) * 280;
        this.projectiles.push({
          kind: 'sword',
          x0: src.x + (Math.random() - 0.5) * 55,
          y0: src.y - Math.random() * 45,
          x1: tx,
          y1: ty,
          cx: (src.x + tx) / 2 + spreadX,
          cy: Math.min(src.y, ty) - 110 - Math.random() * 145,
          x: src.x, y: src.y, angle: 0,
          t: -i * 0.042 - 0.08,
          dur: 0.46 + Math.random() * 0.18,
          trail: [],
          qi: i === 0 ? qi : 0, size: 0, charge: 0,
        });
      }
    } else {
      this.projectiles.push({
        kind: 'orb',
        x0: src.x, y0: src.y, x1: fc.x, y1: fc.y,
        cx: (src.x + fc.x) / 2 + (src.x < fc.x ? -50 : 50),
        cy: Math.min(src.y, fc.y) - 140,
        x: src.x, y: src.y, angle: 0,
        t: -0.26,
        dur: BATTLE_CONFIG.timings.projectileFlight,
        trail: [],
        qi, size: 26 + Math.min(44, Math.sqrt(Math.max(0, share)) * 34), charge: 0,
      });
      sfx.whoosh();
    }
  }

  private applyHit(pb: Playback, qi: number): void {
    pb.shown += qi;
    const fc = this.foeCore();
    this.floatText(fc.x + (Math.random() - 0.5) * 60, fc.y - 60 - Math.random() * 30, `-${formatQi(qi)}`, '#ffe288', 58, 1.55);
    this.foeHit = 1;
    this.rimFlash = 1;
    this.foeKnock = 14;
    this.kick(11);
    sfx.hit();
    pb.opts.onHit(pb.shown);
    if (!pb.crossed && pb.shown >= pb.opts.threshold) {
      pb.crossed = true;
      if (!this.reducedMotion) {
        this.hitstop = 0.065;
        this.impactFrame = 0.085;
        this.slowmo = 0.65;
      }
      this.triggerChroma();
      this.flashScreen(0.75, '255,242,204');
      sfx.boom();
      this.ringWave(fc.x, fc.y + 35, '255,230,150', 360, 0.92);
      this.spark(fc.x, fc.y, 95, this.glow.gold, 460, 1.15, 16);
    }
  }

  // ------------------------------------------------------------ 胜负演出与漫画特写反击

  async foeDefeated(): Promise<void> {
    const fc = this.foeCore();
    this.splash('斩', { x: fc.x, y: fc.y - 35, size: 240, dur: 1.8 });
    this.triggerChroma();
    if (!this.reducedMotion) this.impactFrame = 0.09;
    await this.wait(0.24);
    const box = this.foeBox();
    const foeImg = this.foeImage();
    if (ready(foeImg)) this.dissolve(foeImg, box, null);
    this.foeDead = true;
    this.foeAlpha = 0;
    this.flashScreen(0.65, '255,255,255');
    sfx.boom();
    this.kick(24);
    this.ringWave(fc.x, fc.y + 35, '255,90,60', 440, 1.25);
    await this.wait(1.6);
  }

  /** 对手反击：先切入 21:9 漫画镜头拉近特写，再从远处演武场放出由小变大扑向前景主角的魔焰血雷 */
  async counterAttack(): Promise<void> {
    const art = this.foe?.art ?? 'elder';
    const style = FOE_CUTIN_STYLE[art];

    // 1. 漫画镜头拉近特写
    await this.playCutIn(false);

    // 2. 切回演武场：魔焰/雷球从远处对手高速扑向前景主角（透视由小变大）
    const fc = this.foeCore();
    const h = this.heroCore();
    this.projectiles.push({
      kind: 'foeOrb',
      x0: fc.x, y0: fc.y,
      x1: h.x + 20, y1: h.y - 10,
      cx: (fc.x + h.x) / 2,
      cy: fc.y - 60,
      x: fc.x, y: fc.y, angle: 0,
      t: 0, dur: 0.34, trail: [],
      qi: 0, size: 22, charge: 1,
      rgb: style.rgb,
    });
    this.bolt(fc.x, fc.y - 10, h.x + 30, h.y - 40, style.rgb, 0.32, 4);
    sfx.whoosh();

    await this.wait(0.32);

    this.bolt(fc.x, fc.y, h.x + 60, h.y + 10, style.rgb, 0.28, 3);
    this.heroHit = 1;
    this.kick(16);
    this.triggerChroma();
    this.flashScreen(0.30, style.rgb);
    sfx.thunder();
    this.floatText(h.x + 110, h.y - 130, style.skill, style.accent, 40, 1.3);
    this.spark(h.x + 50, h.y - 30, 52, this.foeGlowSprite(), 340, 0.85, 14);
  }

  async heroDeath(): Promise<void> {
    const art = this.foe?.art ?? 'elder';
    const style = FOE_CUTIN_STYLE[art];

    // 致命一击 21:9 漫画镜头拉近
    await this.playCutIn(true);

    const h = this.heroCore();
    const fc = this.foeCore();
    for (let i = 0; i < 4; i++) {
      this.bolt(fc.x, fc.y - 15, h.x + (Math.random() - 0.5) * 140, h.y - 40 + (Math.random() - 0.5) * 110, style.rgb, 0.4, 5);
      this.kick(18);
      sfx.thunder();
      this.flashScreen(0.34, style.rgb);
      this.spark(h.x + (Math.random() - 0.5) * 100, h.y + (Math.random() - 0.5) * 80, 32, this.foeGlowSprite(), 300, 0.8, 13);
      await this.wait(0.18);
    }
    await this.wait(0.1);
    this.desaturate = true;
    this.canvas.classList.add('dead');
    // 前景主角区域升起暗灰余烬
    for (let i = 0; i < 260; i++) {
      this.ash.push({
        x: 90 + Math.random() * 440,
        y: 360 + Math.random() * 520,
        vx: (Math.random() - 0.3) * 40,
        vy: -25 - Math.random() * 75,
        life: 1.0 + Math.random() * 1.6,
        max: 2.6,
        color: '#3a3030',
        size: 5,
        delay: Math.random() * 0.5,
      });
    }
    this.heroAlpha = 0;
    this.splash('身死道消', { x: 800, y: 380, size: 150, dur: 2.6, tone: 'red' });
    sfx.boom();
    await this.wait(2.2);
  }

  async breakthrough(ringIdx: number, realmName: string): Promise<void> {
    this.ringReveal[ringIdx] = 0;
    this.splash(`突破 · ${realmName}`, { x: 800, y: 330, size: 130, dur: 2.4 });
    sfx.win();
    this.triggerChroma();
    this.flashScreen(0.55, '255,230,170');
    const hc = this.heroCore();
    for (let i = 0; i < 90; i++) {
      this.particles.push({ x: hc.x + (Math.random() - 0.5) * 260, y: hc.y + 80 + Math.random() * 140, vx: (Math.random() - 0.5) * 30, vy: -80 - Math.random() * 160, life: 1.4 + Math.random(), max: 2.4, r: 8 + Math.random() * 10, sprite: this.glow.gold, drag: 0.99 });
    }
    const fx = this.slotFx[ringIdx];
    if (fx) fx.fill(1.5);
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        this.ringReveal[ringIdx] = Math.min(1, (performance.now() - t0) / 1400);
        if (this.ringReveal[ringIdx] >= 1) resolve();
        else requestAnimationFrame(tick);
      };
      tick();
    });
    await this.wait(0.9);
  }

  async ascension(): Promise<void> {
    this.splash('化神大成', { x: 800, y: 360, size: 150, dur: 2.4 });
    sfx.win();
    this.triggerChroma();
    this.flashScreen(0.85, '255,240,200');
    const hc = this.heroCore();
    this.ringWave(hc.x, hc.y, '255,230,160', 920, 1.6);
    for (let i = 0; i < 180; i++) {
      this.particles.push({ x: hc.x + (Math.random() - 0.5) * 340, y: hc.y + Math.random() * 200, vx: (Math.random() - 0.5) * 60, vy: -120 - Math.random() * 240, life: 1.6 + Math.random(), max: 2.6, r: 8 + Math.random() * 14, sprite: this.glow.gold, drag: 0.99 });
    }
    await this.wait(2.4);
  }

  // ------------------------------------------------------------ 每帧更新

  private update(dt: number, rdt: number, clockDt: number): void {
    this.time += dt;
    this.zoom += (this.targetZoom - this.zoom) * Math.min(1, rdt * 5.5);
    if (this.beam) {
      this.beam.t += clockDt;
      if (this.beam.t > this.beam.dur + 0.3) this.beam = null;
    }
    const pb = this.playback;
    if (pb) {
      pb.clock += clockDt;
      const lead = BATTLE_CONFIG.timings.castLead;
      while (pb.next < pb.beats.length && lead + pb.beats[pb.next].t * pb.step <= pb.clock) {
        this.fireBeat(pb, pb.beats[pb.next]);
        pb.next += 1;
      }
      if (pb.clock >= pb.flowEnd && !pb.tailFired && pb.tailCount > 0) {
        pb.tailFired = true;
        const fc = this.foeCore();
        const src = { x: LAYOUT.cx, y: LAYOUT.cy - 40 };
        this.floatText(src.x, src.y - 40, `后续 ${pb.tailCount} 束合计 +${formatQi(pb.tailQi)}`, '#ffe2b0', 26, 1.6);
        this.projectiles.push({ kind: 'orb', x0: src.x, y0: src.y, x1: fc.x, y1: fc.y, cx: (src.x + fc.x) / 2, cy: src.y - 180, x: src.x, y: src.y, angle: 0, t: -0.2, dur: 0.5, trail: [], qi: pb.tailQi, size: 40, charge: 0 });
      }
      if (pb.clock >= pb.flowEnd && (pb.tailFired || pb.tailCount === 0) && this.projectiles.length === 0) {
        this.finishPlayback();
      } else if (pb.clock > BATTLE_CONFIG.timings.hardLimit || (performance.now() - pb.startedAt) / 1000 > BATTLE_CONFIG.timings.hardLimit) {
        this.projectiles.length = 0;
        this.finishPlayback();
      }
    }
    this.updateProjectiles(clockDt);
    this.updateParticles(dt, Math.min(0.15, clockDt));
    this.updateAmbient(dt);
    this.shake *= Math.pow(0.035, rdt);
    this.flash = Math.max(0, this.flash - rdt * 1.7);
    this.rimFlash = Math.max(0, this.rimFlash - rdt * 3.0);
    this.foeHit = Math.max(0, this.foeHit - rdt * 4);
    this.heroHit = Math.max(0, this.heroHit - rdt * 2.4);
    this.heroCast = Math.max(0, this.heroCast - rdt * 0.8);
    this.foeKnock *= Math.pow(0.02, rdt);
    if (this.bgFade < 1) this.bgFade = Math.min(1, this.bgFade + clockDt / 1.2);
    if (!this.foeDead && this.foeAlpha < 1) this.foeAlpha = Math.min(1, this.foeAlpha + clockDt * 1.2);
    for (const ring of this.slotFx) for (let s = 0; s < ring.length; s++) ring[s] = Math.max(0, ring[s] - dt * 1.6);
  }

  private updateProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.t += dt;
      if (p.t < 0) {
        if (p.kind === 'orb') p.charge = Math.min(1, p.charge + dt * 3.5);
        continue;
      }
      const k = Math.min(1, p.t / p.dur);
      const e = p.kind === 'orb' || p.kind === 'foeOrb' ? k * k : 1 - Math.pow(1 - k, 2);
      const u = 1 - e;
      p.x = u * u * p.x0 + 2 * u * e * p.cx + e * e * p.x1;
      p.y = u * u * p.y0 + 2 * u * e * p.cy + e * e * p.y1;
      p.angle = Math.atan2(2 * u * (p.cy - p.y0) + 2 * e * (p.y1 - p.cy), 2 * u * (p.cx - p.x0) + 2 * e * (p.x1 - p.cx));
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > (p.kind === 'sword' ? 14 : 22)) p.trail.shift();
      if (k >= 1) {
        this.projectiles.splice(i, 1);
        if (p.kind === 'foeOrb') {
          this.spark(p.x, p.y, 62, this.foeGlowSprite(), 420, 0.8, 18);
          this.ringWave(p.x, p.y, p.rgb ?? '255,68,52', 320, 0.65);
          sfx.boom();
        } else if (p.kind === 'orb') {
          this.spark(p.x, p.y, 58, this.glow.gold, 340, 0.85, 14);
          this.ringWave(p.x, p.y + 18, '255,200,110', 220, 0.72);
          this.flashScreen(0.28, '255,220,160');
          sfx.boom();
        } else {
          this.spark(p.x, p.y, 10, this.glow.teal, 200, 0.45, 7);
          this.foeHit = Math.max(this.foeHit, 0.55);
          this.rimFlash = Math.max(this.rimFlash, 0.65);
          this.foeKnock = Math.max(this.foeKnock, 6);
          this.kick(3.5);
        }
        if (p.qi > 0 && this.playback) this.applyHit(this.playback, p.qi);
      }
    }
  }

  private updateParticles(dt: number, slowDt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = Math.pow(p.drag, dt * 60);
      p.vx *= drag;
      p.vy = p.vy * drag + 30 * dt;
    }
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.life -= dt;
      if (w.life <= 0) { this.waves.splice(i, 1); continue; }
      w.r += (w.maxR - w.r) * Math.min(1, dt * 6);
    }
    for (let i = this.ash.length - 1; i >= 0; i--) {
      const a = this.ash[i];
      if (a.delay > 0) { a.delay -= slowDt; continue; }
      a.life -= slowDt;
      if (a.life <= 0) { this.ash.splice(i, 1); continue; }
      a.x += a.vx * slowDt;
      a.y += a.vy * slowDt;
      a.vx += 20 * slowDt;
      a.vy -= 10 * slowDt;
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.life -= slowDt;
      if (s.life <= 0) { this.smokes.splice(i, 1); continue; }
      s.x += s.vx * slowDt;
      s.y += s.vy * slowDt;
      s.r += 20 * slowDt;
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      this.bolts[i].life -= dt;
      if (this.bolts[i].life <= 0) this.bolts.splice(i, 1);
    }
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i];
      f.life -= dt;
      f.age += dt;
      f.y -= 36 * dt;
      if (f.life <= 0) this.floats.splice(i, 1);
    }
  }

  private updateAmbient(dt: number): void {
    if (!this.foeDead && this.foeAlpha > 0.3 && Math.random() < dt * (this.reducedMotion ? 4 : 14)) {
      const b = this.foeBox();
      this.smokes.push({ x: b.x + b.w * (0.2 + Math.random() * 0.6), y: b.y + b.h * (0.55 + Math.random() * 0.4), vx: 6 + Math.random() * 14, vy: -14 - Math.random() * 18, r: 10 + Math.random() * 16, life: 1.4, max: 1.4 });
    }
    this.nextAmbientBolt -= dt;
    if (this.nextAmbientBolt <= 0 && !this.foeDead && this.foeAlpha > 0.5) {
      this.nextAmbientBolt = 1.6 + Math.random() * 2.8;
      const b = this.foeBox();
      const style = FOE_CUTIN_STYLE[this.foe?.art ?? 'elder'];
      const x0 = b.x + b.w * (0.3 + Math.random() * 0.4);
      const y0 = b.y + b.h * 0.12;
      this.bolt(x0, y0, x0 + (Math.random() - 0.5) * 140, y0 - 40 - Math.random() * 90, style.rgb, 0.16, 1.8);
    }
    if (this.tribulationId === 'trib_thunder') {
      this.nextTribBolt -= dt;
      if (this.nextTribBolt <= 0) {
        this.nextTribBolt = 1.6 + Math.random() * 2.5;
        const x = 200 + Math.random() * 1200;
        this.bolt(x, -20, x + (Math.random() - 0.5) * 300, 200 + Math.random() * 250, '200,170,255', 0.25, 3);
        this.flashScreen(0.12, '210,190,255');
      }
    }
    for (const f of this.fogs) {
      f.x += f.v * dt;
      if (f.x > STAGE_W + 300) f.x = -400;
    }
    for (const e of this.embers) {
      e.y -= e.vy * dt;
      e.x += (e.vx + Math.sin(this.time * 1.8 + e.p) * 14) * dt;
      if (e.y < -20 || e.x > STAGE_W + 30) {
        e.y = STAGE_H * (0.55 + Math.random() * 0.48);
        e.x = Math.random() * STAGE_W;
      }
    }
  }

  // ------------------------------------------------------------ 绘制

  private drawGlow(sprite: HTMLCanvasElement, x: number, y: number, r: number, alpha: number): void {
    if (alpha <= 0 || r <= 0) return;
    this.ctx.globalAlpha = Math.min(1, alpha);
    this.ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2);
  }

  private render(): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, STAGE_W, STAGE_H);

    ctx.save();
    ctx.translate(STAGE_W / 2 + (Math.random() - 0.5) * this.shake * 2, STAGE_H / 2 + (Math.random() - 0.5) * this.shake * 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-STAGE_W / 2, -STAGE_H / 2);

    this.drawBackground();
    this.drawBraziers();
    this.drawFog(false);
    this.drawEmbers();
    this.drawFoe();
    this.drawBolts();
    this.drawBoard();
    this.drawHeroFx();
    this.drawBeam();
    this.drawPulses();
    this.drawProjectiles();
    this.drawParticles();
    this.drawFog(true);
    this.drawFloats();
    ctx.restore();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 前景主角受击时的左下红光冲击暗角
    if (this.heroHit > 0) {
      const hg = ctx.createRadialGradient(260, 720, 40, 260, 720, 560);
      hg.addColorStop(0, `rgba(255,48,38,${this.heroHit * 0.45})`);
      hg.addColorStop(1, 'rgba(255,48,38,0)');
      ctx.fillStyle = hg;
      ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    }
    if (this.tribulationId === 'trib_demon' && !this.desaturate) {
      const v = ctx.createRadialGradient(STAGE_W / 2, STAGE_H / 2, STAGE_H * 0.32, STAGE_W / 2, STAGE_H / 2, STAGE_H);
      v.addColorStop(0, 'rgba(120,0,0,0)');
      v.addColorStop(1, `rgba(170,0,16,${0.32 + Math.sin(this.time * 2.2) * 0.08})`);
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    } else if (this.tribulationId === 'trib_cloud') {
      ctx.globalCompositeOperation = 'lighter';
      this.drawGlow(this.glow.gold, 800, -80, 720, 0.24 + Math.sin(this.time) * 0.05);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    if (this.flash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(${this.flashRgb},${Math.min(0.65, this.flash * 0.72)})`;
      ctx.fillRect(0, 0, STAGE_W, STAGE_H);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (this.impactFrame > 0 && !this.reducedMotion) {
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = `rgba(255,250,235,${Math.min(0.82, this.impactFrame * 9)})`;
      ctx.fillRect(0, 0, STAGE_W, STAGE_H);
      ctx.globalCompositeOperation = 'source-over';
    }
    const vignette = ctx.createRadialGradient(STAGE_W / 2, STAGE_H * 0.48, STAGE_H * 0.44, STAGE_W / 2, STAGE_H / 2, STAGE_H * 1.05);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(10,4,2,.56)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  }

  private drawBackground(): void {
    const ctx = this.ctx;
    const par = this.bgParallax();
    const paint = (bg: HTMLImageElement | undefined, alpha: number): void => {
      if (!ready(bg) || alpha <= 0) return;
      const bw = STAGE_W + 48;
      const bh = Math.max((bw * bg.naturalHeight) / bg.naturalWidth, STAGE_H + 28);
      // 91% 实景 + 9% 底层 WebGL 火烧云动态能量暗流，确保原生主角清晰锐利
      ctx.globalAlpha = alpha * 0.91;
      ctx.drawImage(bg, -24 + par.x, (STAGE_H - bh) / 2 + par.y, bw, bh);
    };
    if (this.bgFade < 1) paint(this.img.bgs[this.bgPrev], 1);
    paint(this.img.bgs[this.bgIndex], this.bgFade < 1 ? this.bgFade : 1);

    const g = ctx.createLinearGradient(0, 0, 0, STAGE_H);
    g.addColorStop(0, 'rgba(14,6,5,.44)');
    g.addColorStop(0.26, 'rgba(14,6,5,.02)');
    g.addColorStop(0.75, 'rgba(10,5,4,.12)');
    g.addColorStop(1, 'rgba(6,3,3,.64)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  }

  /** 蟠龙石柱旁 6 处可见火盆的实时跳动火光 */
  private drawBraziers(): void {
    const ctx = this.ctx;
    const par = this.bgParallax();
    ctx.globalCompositeOperation = 'lighter';
    for (const b of BRAZIERS) {
      const flick = this.reducedMotion ? 0 : Math.sin(this.time * 7.3 + b.phase) * 0.14 + Math.sin(this.time * 13.7 + b.phase * 2) * 0.08;
      const bx = b.x + par.x;
      const by = b.y + par.y;
      this.drawGlow(this.glow.orange, bx, by, b.r * (1 + flick * 0.6), 0.34 + flick * 0.35);
      this.drawGlow(this.glow.gold, bx, by - 4, b.r * 0.42 * (1 + flick * 0.4), 0.44 + flick * 0.3);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  private drawFog(near: boolean): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    for (const f of this.fogs) {
      if (f.near !== near) continue;
      ctx.globalAlpha = f.a * (near ? 0.38 : 0.34);
      ctx.drawImage(this.fogSprite, f.x - this.mouse.x * (near ? 28 : 12), f.y, 256 * f.s, 128 * f.s * 0.6);
    }
    ctx.globalAlpha = 1;
  }

  private drawEmbers(): void {
    this.ctx.globalCompositeOperation = 'lighter';
    for (const e of this.embers) {
      const pulse = 0.34 + 0.32 * Math.sin(this.time * 3.1 + e.p);
      this.drawGlow(e.warm ? this.glow.amber : this.glow.gold, e.x - this.mouse.x * 16, e.y, e.r, pulse);
    }
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;
  }

  /** 远景对手：立于演武场远端中心石台，带夕阳方向性长影、接触阴影与火烧云背光 */
  private drawFoe(): void {
    const ctx = this.ctx;
    const img = this.foeImage();
    if (!ready(img)) return;
    const art = this.foe?.art ?? 'elder';
    let white = this.foeWhite.get(art);
    if (!white) {
      white = silhouette(img, '#fff');
      this.foeWhite.set(art, white);
    }
    let gold = this.foeGold.get(art);
    if (!gold) {
      gold = silhouette(img, '#ffd278');
      this.foeGold.set(art, gold);
    }
    const b = this.foeBox();
    const foot = this.foeFoot();

    if (!this.foeDead && this.foeAlpha > 0) {
      // 1. 夕阳逆光长投影（从对手脚下斜向前左石板拉长，与参考图一致）
      ctx.save();
      const lg = ctx.createLinearGradient(foot.x, foot.y, foot.x - 165, foot.y + 46);
      lg.addColorStop(0, `rgba(10,4,3,${0.66 * this.foeAlpha})`);
      lg.addColorStop(0.55, `rgba(14,6,5,${0.32 * this.foeAlpha})`);
      lg.addColorStop(1, 'rgba(14,6,5,0)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(foot.x - 18, foot.y - 3);
      ctx.lineTo(foot.x + 20, foot.y + 4);
      ctx.lineTo(foot.x - 140, foot.y + 50);
      ctx.lineTo(foot.x - 172, foot.y + 32);
      ctx.closePath();
      ctx.fill();

      // 2. 脚底致密接触投影（Contact Shadow）
      ctx.translate(foot.x, foot.y);
      ctx.scale(1, 0.26);
      const shR = b.w * 0.44;
      const sh = ctx.createRadialGradient(0, 0, shR * 0.08, 0, 0, shR);
      sh.addColorStop(0, `rgba(8,3,3,${0.88 * this.foeAlpha})`);
      sh.addColorStop(0.6, `rgba(14,5,5,${0.46 * this.foeAlpha})`);
      sh.addColorStop(1, 'rgba(14,5,5,0)');
      ctx.fillStyle = sh;
      ctx.beginPath();
      ctx.arc(0, 0, shR, 0, TAU);
      ctx.fill();
      ctx.restore();

      // 3. 夕阳背光辉光 + 魔气威压光晕
      ctx.globalCompositeOperation = 'lighter';
      this.drawGlow(this.glow.amber, foot.x, b.y + b.h * 0.5, b.h * 0.72, (0.24 + Math.sin(this.time * 2.0) * 0.04) * this.foeAlpha);
      this.drawGlow(this.foeGlowSprite(), foot.x, foot.y - 8, b.w * 0.52, (0.22 + Math.sin(this.time * 2.4) * 0.05) * this.foeAlpha);
      if (this.rimFlash > 0) {
        this.drawGlow(this.glow.gold, foot.x, b.y + b.h * 0.45, b.h * 0.95, this.rimFlash * 0.55);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    for (const s of this.smokes) {
      ctx.globalAlpha = Math.max(0, s.life / s.max) * 0.48;
      ctx.drawImage(this.smokeSprite, s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
    }

    if (this.foeAlpha > 0) {
      ctx.globalAlpha = this.foeAlpha;
      const hue = this.foe?.hue ?? 0;
      if (hue) ctx.filter = `hue-rotate(${hue}deg) saturate(1.06)`;
      ctx.drawImage(img, b.x, b.y, b.w, b.h);
      ctx.filter = 'none';
      if (this.rimFlash > 0) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = this.rimFlash * 0.42;
        ctx.drawImage(gold, b.x - 2, b.y, b.w, b.h);
        ctx.globalCompositeOperation = 'source-over';
      }
      if (this.foeHit > 0) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = this.foeHit * 0.85;
        ctx.drawImage(white, b.x, b.y, b.w, b.h);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawBolts(): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const b of this.bolts) {
      const a = b.life / b.max;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      b.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.strokeStyle = `rgba(${b.rgb},${0.38 * a})`;
      ctx.lineWidth = b.width * 4.5;
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,242,240,${a})`;
      ctx.lineWidth = b.width;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  private ellipse(radius: number): void {
    this.ctx.beginPath();
    this.ctx.ellipse(LAYOUT.cx, LAYOUT.cy, radius, radius * LAYOUT.ratio, 0, 0, TAU);
  }

  private drawBoard(): void {
    const ctx = this.ctx;
    const board = this.view.board;
    if (!board.length) return;
    const running = this.playback !== null;
    let outer = 0;
    board.forEach((ring, r) => { if (ring.unlocked) outer = Math.max(outer, ringRadius(r, this.ringReveal[r])); });
    if (outer > 0) {
      const shadowR = outer + 60;
      ctx.save();
      ctx.translate(LAYOUT.cx, LAYOUT.cy);
      ctx.scale(1, LAYOUT.ratio);
      const g = ctx.createRadialGradient(0, 0, shadowR * 0.12, 0, 0, shadowR);
      g.addColorStop(0, 'rgba(14,8,6,.44)');
      g.addColorStop(0.68, 'rgba(14,8,6,.26)');
      g.addColorStop(1, 'rgba(14,8,6,0)');
      ctx.fillStyle = g;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(0, 0, shadowR, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    // 丹田星轨法阵
    ctx.save();
    ctx.translate(LAYOUT.cx, LAYOUT.cy);
    ctx.scale(1, LAYOUT.ratio);
    ctx.globalCompositeOperation = 'lighter';
    ctx.save();
    ctx.rotate(this.time * (running ? 0.9 : 0.25));
    ctx.strokeStyle = `rgba(255,214,130,${running ? 0.72 : 0.36})`;
    ctx.lineWidth = 2;
    for (let i = 0; i < 8; i++) {
      ctx.rotate(TAU / 8);
      ctx.beginPath();
      ctx.moveTo(22, 0);
      ctx.lineTo(58, 0);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, 60, 0, TAU);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.rotate(-this.time * (running ? 1.2 : 0.35));
    ctx.strokeStyle = `rgba(110,255,226,${running ? 0.58 : 0.28})`;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.arc(0, 0, 40, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, TAU);
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    ctx.globalCompositeOperation = 'lighter';
    this.drawGlow(this.glow.gold, LAYOUT.cx, LAYOUT.cy, running ? 76 : 50, running ? 0.56 : 0.30);
    // 同心环
    board.forEach((ring, r) => {
      const radius = ringRadius(r, ring.unlocked ? this.ringReveal[r] : 1);
      if (ring.unlocked) {
        const a = (0.46 + (running ? 0.36 : 0)) * this.ringReveal[r];
        this.ellipse(radius + 6);
        ctx.strokeStyle = `rgba(255,198,108,${a * 0.58})`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.stroke();
        this.ellipse(radius);
        ctx.strokeStyle = `rgba(255,224,148,${a})`;
        ctx.lineWidth = 3;
        ctx.stroke();
        this.ellipse(radius - 7);
        ctx.strokeStyle = `rgba(115,255,228,${a * 0.78})`;
        ctx.lineWidth = 2.2;
        ctx.setLineDash([4, 15]);
        ctx.lineDashOffset = -this.time * (running ? 115 : 28) * (r % 2 === 0 ? 1 : -1);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        this.ellipse(radius);
        ctx.strokeStyle = 'rgba(255,216,160,.09)';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([5, 14]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    const list: { ref: SlotRef; p: Point }[] = [];
    board.forEach((ring, r) => {
      if (!ring.unlocked) return;
      for (let s = 0; s < ring.maxSlots; s++) list.push({ ref: { ring: r, slot: s }, p: this.slotXY({ ring: r, slot: s }) });
    });
    list.sort((a, b) => a.p.y - b.p.y);
    for (const item of list) this.drawSlot(item.ref, item.p);
  }

  private drawSlot(ref: SlotRef, p: Point): void {
    const ctx = this.ctx;
    const ring = this.view.board[ref.ring];
    const node = ring.slots[ref.slot];
    const fx = this.slotFx[ref.ring]?.[ref.slot] ?? 0;
    const reveal = this.ringReveal[ref.ring];
    const cat = node?.category ?? null;
    const rgb = cat ? CATEGORY_RGB[cat] : '235,196,120';
    const rx = ref.ring === 0 ? 34 : 29;
    const ry = rx * 0.35;
    const isTarget = this.view.target?.ring === ref.ring && this.view.target.slot === ref.slot;
    const hover = this.view.hover?.ring === ref.ring && this.view.hover.slot === ref.slot;
    const aiming = !node && (this.view.placing || this.view.moveTargeting);

    ctx.globalCompositeOperation = 'lighter';
    const sprite = cat === 'AMPLIFY' ? this.glow.gold : cat === 'RELEASE' ? this.glow.orange : cat === 'CONDUCT' ? this.glow.teal : this.glow.amber;
    this.drawGlow(sprite, p.x, p.y, 56 + fx * 34, ((node ? 0.38 : 0.14) + fx * 0.55) * reveal);
    ctx.globalCompositeOperation = 'source-over';

    const g = ctx.createRadialGradient(p.x - 8, p.y - 4, 2, p.x, p.y, rx);
    g.addColorStop(0, node ? `rgba(${rgb},.78)` : 'rgba(130,96,64,.52)');
    g.addColorStop(0.58, 'rgba(26,18,16,.90)');
    g.addColorStop(1, 'rgba(10,7,6,.95)');
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, rx, ry, 0, 0, TAU);
    ctx.fillStyle = g;
    ctx.globalAlpha = reveal * (node ? 1 : 0.80);
    ctx.fill();
    ctx.lineWidth = isTarget ? 3 : hover ? 2.5 : 1.8;
    ctx.strokeStyle = isTarget ? 'rgba(255,110,85,.98)' : hover ? 'rgba(255,245,205,.98)' : `rgba(238,196,112,${node ? 0.94 : 0.58})`;
    if (!node) ctx.setLineDash([4, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (aiming) {
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rx + 6 + Math.sin(this.time * 6) * 3, ry + 3, 0, 0, TAU);
      ctx.strokeStyle = 'rgba(255,242,190,.92)';
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }

    if (node && cat) {
      ctx.globalCompositeOperation = 'lighter';
      const ph = 64 + fx * 62;
      const pg = ctx.createLinearGradient(0, p.y - ph, 0, p.y);
      pg.addColorStop(0, `rgba(${rgb},0)`);
      pg.addColorStop(1, `rgba(${rgb},${0.32 + fx * 0.48})`);
      ctx.fillStyle = pg;
      ctx.globalAlpha = reveal;
      ctx.beginPath();
      ctx.moveTo(p.x - rx * 0.44, p.y);
      ctx.lineTo(p.x - rx * 0.18, p.y - ph);
      ctx.lineTo(p.x + rx * 0.18, p.y - ph);
      ctx.lineTo(p.x + rx * 0.44, p.y);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';

      const bob = this.reducedMotion ? 0 : Math.sin(this.time * 2.4 + ref.ring * 2 + ref.slot) * 3.5;
      const fy = p.y - 26 + bob;
      const orbSize = (ref.ring === 0 ? 46 : 40) + fx * 10;
      const orbImg = this.img.daos[node.configId];
      if (ready(orbImg)) {
        ctx.save();
        ctx.globalAlpha = reveal * 0.96;
        ctx.drawImage(orbImg, p.x - orbSize / 2, fy - orbSize / 2, orbSize, orbSize);
        ctx.restore();
      }
      ctx.globalAlpha = reveal;
      ctx.font = `${ref.ring === 0 ? 23 : 20}px "Ma Shan Zheng","STKaiti","KaiTi",serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(12,6,4,.88)';
      ctx.strokeText(glyphOf(node), p.x, fy + 1);
      ctx.fillStyle = '#fff9e8';
      ctx.fillText(glyphOf(node), p.x, fy + 1);

      ctx.font = '700 11px "Noto Serif SC",serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.strokeText(ROMAN[node.level] ?? String(node.level), p.x + orbSize * 0.42, fy + orbSize * 0.28);
      ctx.fillStyle = CATEGORY_HEX[cat];
      ctx.fillText(ROMAN[node.level] ?? String(node.level), p.x + orbSize * 0.42, fy + orbSize * 0.28);
    }

    if (ref.ring === 0 && ref.slot === 0) {
      ctx.font = '700 12px "Noto Serif SC",serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(12,6,4,.85)';
      ctx.strokeText('入气', p.x, p.y + ry + 12);
      ctx.fillStyle = 'rgba(170,255,238,.96)';
      ctx.fillText('入气', p.x, p.y + ry + 12);
    }
    ctx.globalAlpha = 1;
  }

  /** 前景原生主角的施法掌心聚灵光效（不再重复粘贴 2D 角色贴图） */
  private drawHeroFx(): void {
    const ctx = this.ctx;
    // 若用户显式传入了独立 hero 图才绘制；默认使用原生融合 OTS 背景
    if (this.img.hero && ready(this.img.hero) && this.heroAlpha > 0) {
      if (!this.heroRed) this.heroRed = silhouette(this.img.hero, '#ff3020');
      const h = 540;
      const w = h * (this.img.hero.naturalWidth / this.img.hero.naturalHeight);
      ctx.globalAlpha = this.heroAlpha;
      ctx.drawImage(this.img.hero, -80, STAGE_H - h + 60, w, h);
    }
    if (this.heroAlpha <= 0) return;
    ctx.globalCompositeOperation = 'lighter';
    const hand = this.heroHand();
    const idlePulse = 0.26 + Math.sin(this.time * 2.4) * 0.08;
    this.drawGlow(this.glow.teal, hand.x, hand.y, 30 + this.heroCast * 62, idlePulse + this.heroCast * 0.65);
    if (this.heroCast > 0.05) {
      this.drawGlow(this.glow.white, hand.x, hand.y, 16 + this.heroCast * 24, this.heroCast * 0.85);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  private drawBeam(): void {
    if (!this.beam) return;
    const ctx = this.ctx;
    const hand = this.heroHand();
    const s0 = this.slotXY({ ring: 0, slot: 0 });
    const k = Math.min(1, this.beam.t / this.beam.dur);
    const a = this.beam.t > this.beam.dur ? 1 - (this.beam.t - this.beam.dur) / 0.3 : 1;
    const cx = (hand.x + s0.x) / 2;
    const cy = Math.min(hand.y, s0.y) - 65;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(hand.x, hand.y);
    let px = hand.x;
    let py = hand.y;
    for (let i = 1; i <= 24; i++) {
      const t = (i / 24) * k;
      const u = 1 - t;
      px = u * u * hand.x + 2 * u * t * cx + t * t * s0.x;
      py = u * u * hand.y + 2 * u * t * cy + t * t * (s0.y - 16);
      ctx.lineTo(px, py);
    }
    ctx.strokeStyle = `rgba(96,255,226,${0.32 * a})`;
    ctx.lineWidth = 15;
    ctx.stroke();
    ctx.strokeStyle = `rgba(245,255,252,${0.95 * a})`;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    this.drawGlow(this.glow.white, px, py, 26, a);
    this.drawGlow(this.glow.teal, px, py, 50, 0.75 * a);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  private drawPulses(): void {
    const pb = this.playback;
    if (!pb) return;
    const u = (pb.clock - BATTLE_CONFIG.timings.castLead) / pb.step;
    if (u < 0 || u > pb.capBeat + 1) return;
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    for (const track of pb.timeline.pulses) {
      const state = pulseStateAt(track, u);
      const trail = pb.trails.get(track.id) ?? [];
      pb.trails.set(track.id, trail);
      let pos: Point | null = null;
      if (state) {
        if (state.move) pos = this.lerpSlots(state.move.from, state.move.to, easeInOut(Math.min(1, state.progress)), state.move.kind);
        else {
          const q = this.slotXY(state.at);
          pos = { x: q.x, y: q.y - 18 };
        }
        trail.push(pos);
        if (trail.length > 18) trail.shift();
      } else if (trail.length) {
        trail.shift();
      }
      const mult = state?.power.multiplier ?? 1;
      const base = state?.power.baseQi ?? 10;
      const goldness = Math.max(0, Math.min(1, (mult - 1) / 1.5));
      const radius = 15 + Math.min(36, Math.sqrt(Math.max(0, base)) * 2.4);
      trail.forEach((t, i) => {
        const f = (i + 1) / trail.length;
        this.drawGlow(this.glow.teal, t.x, t.y, radius * f * 0.95, 0.48 * f * (1 - goldness));
        this.drawGlow(this.glow.gold, t.x, t.y, radius * f * 0.95, 0.52 * f * goldness);
      });
      if (pos) {
        this.drawGlow(this.glow.teal, pos.x, pos.y, radius * 2.3, 0.58 * (1 - goldness) + 0.16);
        this.drawGlow(this.glow.gold, pos.x, pos.y, radius * 2.3, 0.68 * goldness);
        this.drawGlow(this.glow.white, pos.x, pos.y, radius * 0.78, 1);
        if (!this.reducedMotion && Math.random() < 0.45) {
          this.particles.push({ x: pos.x, y: pos.y, vx: (Math.random() - 0.5) * 68, vy: -24 - Math.random() * 44, life: 0.52, max: 0.52, r: 5.5, sprite: goldness > 0.5 ? this.glow.gold : this.glow.teal, drag: 0.95 });
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  private drawSword(x: number, y: number, angle: number, len: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.85;
    ctx.drawImage(this.glow.teal, -len * 0.72, -len * 0.24, len * 1.45, len * 0.48);
    ctx.globalAlpha = 1;
    const g = ctx.createLinearGradient(-len * 0.4, 0, len * 0.5, 0);
    g.addColorStop(0, 'rgba(150,255,235,.68)');
    g.addColorStop(1, 'rgba(255,255,255,1)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(len * 0.54, 0);
    ctx.lineTo(-len * 0.25, -len * 0.048);
    ctx.lineTo(-len * 0.25, len * 0.048);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,228,158,.96)';
    ctx.fillRect(-len * 0.28, -len * 0.10, len * 0.045, len * 0.20);
    ctx.fillRect(-len * 0.45, -len * 0.024, len * 0.17, len * 0.048);
    ctx.restore();
  }

  /** 带真实纵深透视缩放的法术投射物：主角发招由近及远缩小；对手发招由远及近放大扑面而来 */
  private drawProjectiles(): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.projectiles) {
      if (p.t < 0) {
        if (p.kind === 'orb') {
          this.drawGlow(this.glow.gold, p.x0, p.y0, p.size * (1 + p.charge * 1.55), 0.92 * p.charge);
          this.drawGlow(this.glow.white, p.x0, p.y0, p.size * 0.65 * p.charge, p.charge);
        }
        continue;
      }
      const k = Math.max(0, Math.min(1, p.t / p.dur));
      if (p.kind === 'foeOrb') {
        // 敌人反击：由远及近透视放大（0.45 -> 2.15）
        const persp = 0.45 + 1.70 * (k * k);
        const sprite = this.foeGlowSprite();
        p.trail.forEach((t, i) => {
          const f = (i + 1) / p.trail.length;
          this.drawGlow(sprite, t.x, t.y, p.size * persp * 1.8 * f, 0.58 * f);
        });
        this.drawGlow(sprite, p.x, p.y, p.size * persp * 2.8, 1);
        this.drawGlow(this.glow.white, p.x, p.y, p.size * persp * 0.95, 0.95);
      } else if (p.kind === 'sword') {
        // 主角万剑诀：由近及远透视缩小（1.25 -> 0.52）
        const persp = 1.25 - 0.73 * k;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        p.trail.forEach((t, i) => (i ? ctx.lineTo(t.x, t.y) : ctx.moveTo(t.x, t.y)));
        ctx.strokeStyle = 'rgba(130,255,232,.42)';
        ctx.lineWidth = Math.max(2, 6.2 * persp);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.78)';
        ctx.lineWidth = Math.max(1, 1.8 * persp);
        ctx.stroke();
        this.drawSword(p.x, p.y, p.angle, 74 * persp);
      } else {
        // 主角灵爆术：由近及远透视缩小（1.22 -> 0.58）
        const persp = 1.22 - 0.64 * k;
        p.trail.forEach((t, i) => {
          const f = (i + 1) / p.trail.length;
          this.drawGlow(this.glow.orange, t.x, t.y, p.size * persp * 1.85 * f, 0.54 * f);
          this.drawGlow(this.glow.gold, t.x, t.y, p.size * persp * f, 0.65 * f);
        });
        this.drawGlow(this.glow.gold, p.x, p.y, p.size * persp * 2.7, 1);
        this.drawGlow(this.glow.white, p.x, p.y, p.size * persp * 1.05, 1);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const a = Math.max(0, p.life / p.max);
      this.drawGlow(p.sprite, p.x, p.y, p.r * (0.5 + a), a);
    }
    for (const w of this.waves) {
      const a = Math.max(0, w.life / w.max);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.ellipse(w.x, w.y, w.r, w.r * 0.36, 0, 0, TAU);
      ctx.strokeStyle = `rgba(${w.rgb},${a * 0.85})`;
      ctx.lineWidth = 2 + 8 * a;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const a of this.ash) {
      ctx.fillStyle = a.color;
      if (a.delay > 0) {
        ctx.globalAlpha = 1;
        ctx.fillRect(a.x, a.y, a.size, a.size);
        continue;
      }
      const k = a.life / a.max + 0.3;
      ctx.globalAlpha = Math.max(0, Math.min(1, a.life / 1.2));
      ctx.fillRect(a.x, a.y, a.size * k, a.size * k);
    }
    ctx.globalAlpha = 1;
  }

  private drawFloats(): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of this.floats) {
      const a = Math.min(1, f.life / (f.max * 0.4));
      const pop = f.age < 0.12 ? 1.55 - (f.age / 0.12) * 0.55 : 1;
      ctx.globalAlpha = Math.max(0, a);
      ctx.font = `${Math.round(f.size * pop)}px "Ma Shan Zheng","STKaiti","KaiTi",serif`;
      ctx.lineWidth = Math.max(3, f.size / 8);
      ctx.strokeStyle = 'rgba(0,0,0,.72)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }
}

export function categoryOf(configId: string): DaoCategory {
  return getDaoConfig(configId).category;
}
