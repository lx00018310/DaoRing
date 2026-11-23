// ============================================================
// 斗法场景 · Canvas 渲染与特效
// 画面分层（后 → 前）：背景视差 → 远雾与灵光 → 敌人（血光、黑气、雷光）
// → 阵盘（透视同心环、阵眼、道韵符字） → 主角 → 能量束 → 飞剑 / 灵爆
// → 粒子、冲击波 → 近雾 → 浮字 → 全屏闪光与暗角。
// 本文件只负责「怎么画」；「发生了什么」全部来自引擎日志构建的 Timeline。
// ============================================================
import { getDaoConfig } from '../config';
import type { DaoCategory, RingTrack } from '../types';
import { BATTLE_CONFIG } from './battleConfig';
import { CATEGORY_HEX, CATEGORY_RGB, ROMAN, formatQi, glyphOf } from './daoVisual';
import type { FoeArt, FoeConfig } from './foes';
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

export interface SceneAssets {
  /** 各大境界的背景（下标 0 = 炼气）；缺省时沿用最后一张 */
  backgrounds: string[];
  hero: string;
  /** 每个大境界的敌人立绘 */
  foes: Record<FoeArt, string>;
}

/** UI 每次渲染时推给场景的阵盘视图 */
export interface SceneBoardView {
  board: RingTrack[];
  /** 已选中手牌，等待落子 */
  placing: boolean;
  /** 正在为移位挑选空阵眼 */
  moveTargeting: boolean;
  /** 覆盖 / 拆除 / 移位操作的对象阵眼 */
  target: SlotRef | null;
  hover: SlotRef | null;
}

interface PlayOptions {
  threshold: number;
  onHit: (shownTotal: number) => void;
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
  opts: PlayOptions;
  resolve: () => void;
  trails: Map<string, Point[]>;
  /** 真实开始时间（毫秒），用于硬上限 */
  startedAt: number;
  /** 浮字去重：同一阵眼同类提示在短时间内只显示一次 */
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
  kind: 'sword' | 'orb';
  x0: number; y0: number; x1: number; y1: number; cx: number; cy: number;
  x: number; y: number; angle: number;
  t: number; dur: number; trail: Point[];
  qi: number; size: number; charge: number;
}
interface Fog { x: number; y: number; s: number; v: number; a: number; near: boolean; }
interface Mote { x: number; y: number; v: number; r: number; p: number; }

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
  g.addColorStop(hard ? 0.18 : 0.22, `rgba(${rgb},${hard ? 0.8 : 0.5})`);
  g.addColorStop(0.55, `rgba(${rgb},0.12)`);
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
const ready = (img: HTMLImageElement): boolean => img.complete && img.naturalWidth > 0;

export class BattleScene {
  public view: SceneBoardView = { board: [], placing: false, moveTargeting: false, target: null, hover: null };
  public foe: FoeConfig | null = null;
  public tribulationId: string | null = null;
  public readonly ringReveal: number[] = [1, 0, 0, 0, 0];
  public readonly reducedMotion: boolean;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly img: { bgs: HTMLImageElement[]; hero: HTMLImageElement; foes: Record<FoeArt, HTMLImageElement> };
  /** 背景切换：当前境界下标、上一张下标与淡入进度（0 → 1） */
  private bgIndex = 0;
  private bgPrev = 0;
  private bgFade = 1;
  private readonly glow = {
    teal: glowSprite('120,255,225'),
    gold: glowSprite('255,205,110'),
    red: glowSprite('255,60,50'),
    white: glowSprite('255,255,255', true),
    orange: glowSprite('255,130,60'),
    violet: glowSprite('190,140,255'),
  };
  private readonly smokeSprite = radialSprite(128, 128, [[0, 'rgba(25,6,22,.85)'], [0.5, 'rgba(30,8,26,.35)'], [1, 'rgba(30,8,26,0)']]);
  private readonly fogSprite = radialSprite(256, 128, [[0, 'rgba(205,228,230,.55)'], [0.6, 'rgba(190,215,220,.18)'], [1, 'rgba(190,215,220,0)']]);
  private readonly foeWhite = new Map<FoeArt, HTMLCanvasElement>();
  private heroRed: HTMLCanvasElement | null = null;

  private time = 0;
  private last = 0;
  private slowmo = 0;
  private shake = 0;
  private flash = 0;
  private flashRgb = '255,255,255';
  private mouse = { x: 0, y: 0 };
  private heroAlpha = 1;
  private heroHit = 0;
  private heroCast = 0;
  private foeAlpha = 0;
  private foeHit = 0;
  private foeKnock = 0;
  private foeDead = true;
  private nextAmbientBolt = 1.5;
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
  private readonly motes: Mote[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly fxLayer: HTMLElement,
    assets: SceneAssets,
    ringSlots: readonly number[],
  ) {
    this.ctx = canvas.getContext('2d')!;
    const load = (src: string): HTMLImageElement => {
      const image = new Image();
      image.src = src;
      return image;
    };
    const foes = {} as Record<FoeArt, HTMLImageElement>;
    (Object.keys(assets.foes) as FoeArt[]).forEach((art) => { foes[art] = load(assets.foes[art]); });
    this.img = { bgs: assets.backgrounds.map(load), hero: load(assets.hero), foes };
    this.slotFx = ringSlots.map((n) => Array.from({ length: n }, () => 0));
    this.reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    for (let i = 0; i < 16; i++) {
      this.fogs.push({ x: Math.random() * 1800 - 100, y: 520 + Math.random() * 380, s: 1.4 + Math.random() * 2.4, v: 6 + Math.random() * 14, a: 0.25 + Math.random() * 0.35, near: i < 5 });
    }
    for (let i = 0; i < (this.reducedMotion ? 16 : 46); i++) {
      this.motes.push({ x: Math.random() * STAGE_W, y: Math.random() * STAGE_H, v: 8 + Math.random() * 22, r: 3 + Math.random() * 6, p: Math.random() * TAU });
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
      // 粒子等物理效果按帧推进（单帧最多 0.05s，防止跳变）；
      // 回合时间轴与投射物按真实时间推进（单帧最多 0.5s），掉帧的机器上演出也不会被拖长
      const rdt = Math.min(0.05, real);
      const clockDt = Math.min(0.5, real);
      let scale = 1;
      if (this.slowmo > 0) {
        this.slowmo -= clockDt;
        scale = 0.3;
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

  /** 新开一局：清空所有特效与残留回调 */
  reset(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    if (this.playback) {
      const pb = this.playback;
      this.playback = null;
      pb.resolve();
    }
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
    this.slowmo = 0;
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

  // ------------------------------------------------------------ 几何

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
    const hop = kind === 'step' ? 0 : Math.sin(Math.PI * k) * (kind === 'split' ? 46 : 30);
    return { x: LAYOUT.cx + r * Math.cos(a), y: LAYOUT.cy + r * LAYOUT.ratio * Math.sin(a) - 16 - hop };
  }

  private heroBox(): { x: number; y: number; w: number; h: number } {
    const h = 440;
    const ar = ready(this.img.hero) ? this.img.hero.naturalWidth / this.img.hero.naturalHeight : 1;
    const w = h * ar;
    return { x: -70, y: STAGE_H - h + 32, w, h };
  }

  heroHand(): Point {
    const b = this.heroBox();
    return { x: b.x + 0.79 * b.w, y: b.y + 0.22 * b.h };
  }

  heroCore(): Point {
    const b = this.heroBox();
    return { x: b.x + 0.5 * b.w, y: b.y + 0.45 * b.h };
  }

  private foeBox(): { x: number; y: number; w: number; h: number } {
    const scale = this.foe?.scale ?? 1;
    const h = 480 * scale;
    const img = this.foeImage();
    const ar = ready(img) ? img.naturalWidth / img.naturalHeight : 0.82;
    const w = h * ar;
    const bob = this.reducedMotion ? 0 : Math.sin(this.time * 1.3) * 10;
    return { x: 1340 - 0.31 * w + this.foeKnock, y: 320 - 0.44 * h + bob, w, h };
  }

  private foeImage(): HTMLImageElement {
    return this.img.foes[this.foe?.art ?? 'elder'] ?? this.img.foes.elder;
  }

  foeCore(): Point {
    const b = this.foeBox();
    return { x: b.x + 0.33 * b.w, y: b.y + 0.42 * b.h };
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

  private bolt(x1: number, y1: number, x2: number, y2: number, rgb = '255,70,60', life = 0.2, width = 3): void {
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
    const step = 7;
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
            x: box.x + xx, y: box.y + yy, vx: (Math.random() - 0.3) * 40, vy: -20 - Math.random() * 60,
            life: 0.8 + Math.random() * 1.8 + ((c.height - yy) / c.height) * 0.6, max: 2.6,
            color: tint ?? `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`, size: step - 1,
            delay: Math.random() * 0.5 + (xx / c.width) * 0.4,
          });
        }
      }
    } catch {
      for (let i = 0; i < 900; i++) {
        this.ash.push({ x: box.x + Math.random() * box.w, y: box.y + Math.random() * box.h, vx: (Math.random() - 0.3) * 40, vy: -20 - Math.random() * 60, life: 1 + Math.random() * 1.6, max: 2.6, color: tint ?? '#552', size: 5, delay: Math.random() * 0.6 });
      }
    }
  }

  /** 书法大字（DOM 层，便于使用网络字体与描金渐变） */
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
    if (fx) fx[ref.slot] = overwrite ? 1.4 : 1.2;
    const sprite = category === 'AMPLIFY' ? this.glow.gold : category === 'RELEASE' ? this.glow.orange : this.glow.teal;
    this.spark(p.x, p.y - 10, overwrite ? 26 : 18, sprite, overwrite ? 200 : 160, 0.75, overwrite ? 12 : 10);
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
      for (let i = 0; i < 40; i++) {
        this.smokes.push({ x: fc.x + (Math.random() - 0.5) * 200, y: fc.y + (Math.random() - 0.5) * 260, vx: (Math.random() - 0.5) * 60, vy: -20 - Math.random() * 30, r: 40 + Math.random() * 60, life: 1.6, max: 1.6 });
      }
      this.bolt(fc.x + 20, -20, fc.x - 10, fc.y - 100, '255,70,60', 0.3, 4);
      sfx.thunder();
      this.flashScreen(0.2, '255,60,50');
      this.splash(foe.name, { x: 1180, y: 600, size: 58, dur: 1.9, tone: 'red' });
    }, 300);
    this.timers.add(timer);
  }

  /** 按大境界切换背景，跨境界时 1.2 秒淡入 */
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
    this.splash(name, { x: 800, y: 300, size: 96, dur: 2.4, tone });
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

  /**
   * 播放一次运转。所有数字来自 timeline（即引擎日志）：
   * 每束释放的伤害 = 该束 RELEASE 的 qiDelta，总和 = turnQiGenerated。
   */
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
    this.beam = { t: 0, dur: 0.75 };
    const hand = this.heroHand();
    this.spark(hand.x, hand.y, 24, this.glow.teal, 160, 0.8, 10);
    sfx.whoosh();
    return new Promise((resolve) => {
      this.playback = {
        timeline, step, capBeat, beats,
        tailQi: tail.reduce((sum, b) => sum + (b.qi ?? 0), 0), tailCount: tail.length, tailFired: false,
        clock: 0, next: 0,
        flowEnd: cfg.castLead + (Math.min(timeline.maxT, capBeat) + 1) * step,
        shown: 0, crossed: false, swordsLeft: BATTLE_CONFIG.maxSwordsPerTurn, seenRelease: new Set(),
        opts, resolve, trails: new Map(), startedAt: performance.now(), lastFloat: new Map(),
      };
    });
  }

  /** 跳过：清掉在途投射物，直接显示真实结果 */
  skip(): void {
    const pb = this.playback;
    if (!pb) return;
    this.projectiles.length = 0;
    this.beam = null;
    pb.shown = pb.timeline.totalQi;
    pb.opts.onHit(pb.shown);
    this.finishPlayback();
  }

  private finishPlayback(): void {
    const pb = this.playback;
    if (!pb) return;
    if (pb.shown !== pb.timeline.totalQi) {
      pb.shown = pb.timeline.totalQi;
      pb.opts.onHit(pb.shown);
    }
    this.playback = null;
    pb.resolve();
  }

  private fireBeat(pb: Playback, beat: Beat): void {
    const p = this.slotXY(beat.at);
    const fx = this.slotFx[beat.at.ring];
    if (beat.kind === 'release') {
      if (fx) fx[beat.at.slot] = 1.8;
      this.fireRelease(pb, beat, { x: p.x, y: p.y - 30 });
      return;
    }
    if (fx) fx[beat.at.slot] = Math.min(1.6, (fx[beat.at.slot] ?? 0) + 1);
    // 多股能量同时经过同一阵眼时，同类浮字 0.6 秒内只出一次，避免叠成一团
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
    this.spark(p.x, p.y - 20, beat.big ? 34 : 14, gold ? this.glow.gold : this.glow.teal, beat.big ? 260 : 150, 0.7, beat.big ? 14 : 9);
    if (beat.big) {
      this.ringWave(p.x, p.y - 10, gold ? CATEGORY_RGB.AMPLIFY : CATEGORY_RGB.CONDUCT, 120, 0.6);
      this.kick(5);
    }
    if (showFloat) this.floatText(p.x, p.y - 60 - (beat.kind === 'synergy' ? 22 : 0), beat.text, color, beat.big ? 30 : 22, 1.1);
    const pitch: Record<string, number> = { amplify: 0, crit: 3, split: 5, jump: 7, reverse: 1, synergy: 4, lucky: 6 };
    sfx.chime(pitch[beat.kind] ?? 0);
  }

  private fireRelease(pb: Playback, beat: Beat, src: Point): void {
    const qi = beat.qi ?? 0;
    const isSword = beat.releaseName?.includes('剑') ?? false;
    this.ringWave(src.x, src.y + 20, '255,150,90', 150, 0.5);
    this.spark(src.x, src.y, 30, this.glow.orange, 260, 0.7, 12);
    this.kick(4);
    const name = beat.releaseName ?? '';
    if (!pb.seenRelease.has(name)) {
      pb.seenRelease.add(name);
      this.splash(isSword ? '万剑诀' : '灵爆术', { x: 1040, y: 470, size: 110, dur: 1.4 });
    }
    const fc = this.foeCore();
    const share = qi / Math.max(1, pb.opts.threshold);
    if (isSword && pb.swordsLeft > 0) {
      const n = Math.min(pb.swordsLeft, Math.max(3, Math.min(14, 3 + Math.round(share * 10))));
      pb.swordsLeft -= n;
      sfx.sword();
      for (let i = 0; i < n; i++) {
        const tx = fc.x + (Math.random() - 0.5) * 120;
        const ty = fc.y + (Math.random() - 0.5) * 150;
        this.projectiles.push({
          kind: 'sword', x0: src.x + (Math.random() - 0.5) * 60, y0: src.y - Math.random() * 50, x1: tx, y1: ty,
          cx: (src.x + tx) / 2 + (Math.random() - 0.5) * 220, cy: Math.min(src.y, ty) - 120 - Math.random() * 200,
          x: src.x, y: src.y, angle: 0, t: -i * 0.045 - 0.1, dur: 0.5 + Math.random() * 0.2, trail: [],
          qi: i === 0 ? qi : 0, size: 0, charge: 0,
        });
      }
    } else {
      this.projectiles.push({
        kind: 'orb', x0: src.x, y0: src.y, x1: fc.x, y1: fc.y, cx: (src.x + fc.x) / 2, cy: Math.min(src.y, fc.y) - 160,
        x: src.x, y: src.y, angle: 0, t: -0.3, dur: BATTLE_CONFIG.timings.projectileFlight, trail: [],
        qi, size: 22 + Math.min(44, Math.sqrt(Math.max(0, share)) * 34), charge: 0,
      });
      sfx.whoosh();
    }
  }

  private applyHit(pb: Playback, qi: number): void {
    pb.shown += qi;
    const fc = this.foeCore();
    this.floatText(fc.x - 60 + (Math.random() - 0.5) * 80, fc.y - 80 - Math.random() * 40, `-${formatQi(qi)}`, '#ffe08a', 64, 1.5);
    this.foeHit = 1;
    this.foeKnock = 26;
    this.kick(10);
    sfx.hit();
    pb.opts.onHit(pb.shown);
    if (!pb.crossed && pb.shown >= pb.opts.threshold) {
      pb.crossed = true;
      if (!this.reducedMotion) this.slowmo = 0.7;
      this.flashScreen(0.7, '255,240,200');
      sfx.boom();
      this.ringWave(fc.x, fc.y, '255,230,160', 420, 0.9);
      this.spark(fc.x, fc.y, 90, this.glow.gold, 520, 1.1, 18);
    }
  }

  // ------------------------------------------------------------ 胜负演出

  async foeDefeated(): Promise<void> {
    this.splash('斩', { x: 1180, y: 380, size: 260, dur: 1.8 });
    await this.wait(0.26);
    const box = this.foeBox();
    const foeImg = this.foeImage();
    if (ready(foeImg)) this.dissolve(foeImg, box, null);
    this.foeDead = true;
    this.foeAlpha = 0;
    this.flashScreen(0.6, '255,255,255');
    sfx.boom();
    this.kick(22);
    const fc = this.foeCore();
    this.ringWave(fc.x, fc.y, '255,90,60', 520, 1.2);
    await this.wait(1.6);
  }

  counterAttack(): void {
    const fc = this.foeCore();
    const h = this.heroCore();
    this.bolt(fc.x - 40, fc.y - 40, h.x + 40, h.y - 60, '255,60,60', 0.35, 4);
    this.bolt(fc.x - 30, fc.y - 20, h.x + 60, h.y - 20, '255,90,80', 0.3, 2);
    this.heroHit = 1;
    this.kick(14);
    this.flashScreen(0.25, '255,40,30');
    sfx.thunder();
    this.floatText(h.x + 60, h.y - 160, '魔威压顶', '#ff7a6a', 34, 1.3);
    this.spark(h.x + 40, h.y - 60, 40, this.glow.red, 260, 0.8, 12);
  }

  async heroDeath(): Promise<void> {
    const h = this.heroCore();
    const fc = this.foeCore();
    for (let i = 0; i < 4; i++) {
      this.bolt(fc.x - 20, fc.y - 40, h.x + (Math.random() - 0.5) * 80, h.y - 60 + (Math.random() - 0.5) * 80, '255,40,40', 0.4, 5);
      this.kick(18);
      sfx.thunder();
      this.flashScreen(0.3, '255,20,20');
      await this.wait(0.18);
    }
    await this.wait(0.1);
    this.desaturate = true;
    this.canvas.classList.add('dead');
    if (ready(this.img.hero)) this.dissolve(this.img.hero, this.heroBox(), '#3a3030');
    this.heroAlpha = 0;
    this.splash('身死道消', { x: 800, y: 380, size: 150, dur: 2.6, tone: 'red' });
    sfx.boom();
    await this.wait(2.2);
  }

  async breakthrough(ringIdx: number, realmName: string): Promise<void> {
    this.ringReveal[ringIdx] = 0;
    this.splash(`突破 · ${realmName}`, { x: 800, y: 330, size: 130, dur: 2.4 });
    sfx.win();
    this.flashScreen(0.5, '255,230,170');
    const hc = this.heroCore();
    for (let i = 0; i < 80; i++) {
      this.particles.push({ x: hc.x + (Math.random() - 0.5) * 200, y: hc.y + 100 + Math.random() * 120, vx: (Math.random() - 0.5) * 30, vy: -80 - Math.random() * 160, life: 1.4 + Math.random(), max: 2.4, r: 8 + Math.random() * 10, sprite: this.glow.gold, drag: 0.99 });
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
    this.flashScreen(0.8, '255,240,200');
    const hc = this.heroCore();
    this.ringWave(hc.x, hc.y, '255,230,160', 900, 1.6);
    for (let i = 0; i < 160; i++) {
      this.particles.push({ x: hc.x + (Math.random() - 0.5) * 300, y: hc.y + Math.random() * 200, vx: (Math.random() - 0.5) * 60, vy: -120 - Math.random() * 240, life: 1.6 + Math.random(), max: 2.6, r: 8 + Math.random() * 14, sprite: this.glow.gold, drag: 0.99 });
    }
    await this.wait(2.4);
  }

  // ------------------------------------------------------------ 每帧更新

  private update(dt: number, rdt: number, clockDt: number): void {
    this.time += dt;
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
        this.projectiles.push({ kind: 'orb', x0: src.x, y0: src.y, x1: fc.x, y1: fc.y, cx: (src.x + fc.x) / 2, cy: src.y - 200, x: src.x, y: src.y, angle: 0, t: -0.2, dur: 0.5, trail: [], qi: pb.tailQi, size: 40, charge: 0 });
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
    this.shake *= Math.pow(0.04, rdt);
    this.flash = Math.max(0, this.flash - rdt * 1.6);
    this.foeHit = Math.max(0, this.foeHit - rdt * 4);
    this.heroHit = Math.max(0, this.heroHit - rdt * 2.5);
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
      const e = p.kind === 'orb' ? k * k : 1 - Math.pow(1 - k, 2);
      const u = 1 - e;
      p.x = u * u * p.x0 + 2 * u * e * p.cx + e * e * p.x1;
      p.y = u * u * p.y0 + 2 * u * e * p.cy + e * e * p.y1;
      p.angle = Math.atan2(2 * u * (p.cy - p.y0) + 2 * e * (p.y1 - p.cy), 2 * u * (p.cx - p.x0) + 2 * e * (p.x1 - p.cx));
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > (p.kind === 'orb' ? 22 : 12)) p.trail.shift();
      if (k >= 1) {
        this.projectiles.splice(i, 1);
        if (p.kind === 'orb') {
          this.spark(p.x, p.y, 60, this.glow.gold, 420, 0.9, 16);
          this.ringWave(p.x, p.y, '255,200,110', 260, 0.7);
          this.flashScreen(0.25, '255,220,160');
          sfx.boom();
        } else {
          this.spark(p.x, p.y, 10, this.glow.teal, 240, 0.5, 8);
          this.foeHit = Math.max(this.foeHit, 0.5);
          this.foeKnock = Math.max(this.foeKnock, 8);
          this.kick(3);
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
    // 化灰与黑气属于胜负演出，按真实时间推进，掉帧时也会按时散尽
    for (let i = this.ash.length - 1; i >= 0; i--) {
      const a = this.ash[i];
      if (a.delay > 0) { a.delay -= slowDt; continue; }
      a.life -= slowDt;
      if (a.life <= 0) { this.ash.splice(i, 1); continue; }
      a.x += a.vx * slowDt;
      a.y += a.vy * slowDt;
      a.vx += 25 * slowDt;
      a.vy -= 10 * slowDt;
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.life -= slowDt;
      if (s.life <= 0) { this.smokes.splice(i, 1); continue; }
      s.x += s.vx * slowDt;
      s.y += s.vy * slowDt;
      s.r += 30 * slowDt;
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      this.bolts[i].life -= dt;
      if (this.bolts[i].life <= 0) this.bolts.splice(i, 1);
    }
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i];
      f.life -= dt;
      f.age += dt;
      f.y -= 34 * dt;
      if (f.life <= 0) this.floats.splice(i, 1);
    }
  }

  private updateAmbient(dt: number): void {
    if (!this.foeDead && this.foeAlpha > 0.3 && Math.random() < dt * (this.reducedMotion ? 6 : 22)) {
      const b = this.foeBox();
      this.smokes.push({ x: b.x + b.w * (0.15 + Math.random() * 0.6), y: b.y + b.h * (0.3 + Math.random() * 0.7), vx: 10 + Math.random() * 30, vy: -20 - Math.random() * 30, r: 20 + Math.random() * 30, life: 1.8, max: 1.8 });
    }
    this.nextAmbientBolt -= dt;
    if (this.nextAmbientBolt <= 0 && !this.foeDead && this.foeAlpha > 0.5) {
      this.nextAmbientBolt = 1 + Math.random() * 2.4;
      const b = this.foeBox();
      const x0 = b.x + b.w * (0.2 + Math.random() * 0.3);
      const y0 = b.y + b.h * 0.15;
      this.bolt(x0, y0, x0 + (Math.random() - 0.3) * 260, y0 - 60 - Math.random() * 160, '255,70,70', 0.16, 2);
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
    for (const m of this.motes) {
      m.y -= m.v * dt;
      m.x += Math.sin(this.time + m.p) * 8 * dt;
      if (m.y < -20) {
        m.y = STAGE_H + 20;
        m.x = Math.random() * STAGE_W;
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
    ctx.fillStyle = '#081218';
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    ctx.translate((Math.random() - 0.5) * this.shake * 2, (Math.random() - 0.5) * this.shake * 2);
    this.drawBackground();
    this.drawFog(false);
    this.drawMotes();
    this.drawFoe();
    this.drawBolts();
    this.drawBoard();
    this.drawHero();
    this.drawBeam();
    this.drawPulses();
    this.drawProjectiles();
    this.drawParticles();
    this.drawFog(true);
    this.drawFloats();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.tribulationId === 'trib_demon' && !this.desaturate) {
      const v = ctx.createRadialGradient(STAGE_W / 2, STAGE_H / 2, STAGE_H * 0.35, STAGE_W / 2, STAGE_H / 2, STAGE_H);
      v.addColorStop(0, 'rgba(120,0,0,0)');
      v.addColorStop(1, `rgba(150,0,10,${0.28 + Math.sin(this.time * 2) * 0.06})`);
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    } else if (this.tribulationId === 'trib_cloud') {
      ctx.globalCompositeOperation = 'lighter';
      this.drawGlow(this.glow.gold, 800, -80, 700, 0.18 + Math.sin(this.time) * 0.04);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    if (this.flash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(${this.flashRgb},${Math.min(0.6, this.flash * 0.7)})`;
      ctx.fillRect(0, 0, STAGE_W, STAGE_H);
      ctx.globalCompositeOperation = 'source-over';
    }
    const vignette = ctx.createRadialGradient(STAGE_W / 2, STAGE_H / 2, STAGE_H * 0.45, STAGE_W / 2, STAGE_H / 2, STAGE_H * 1.05);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  }

  private drawBackground(): void {
    const ctx = this.ctx;
    const paint = (bg: HTMLImageElement | undefined, alpha: number): void => {
      if (!bg || !ready(bg) || alpha <= 0) return;
      const bw = STAGE_W + 90;
      const bh = Math.max((bw * bg.naturalHeight) / bg.naturalWidth, STAGE_H + 30);
      ctx.globalAlpha = alpha;
      ctx.drawImage(bg, -45 - this.mouse.x * 30, (STAGE_H - bh) / 2 - this.mouse.y * 16, bw, bh);
    };
    if (this.bgFade < 1) paint(this.img.bgs[this.bgPrev], 1);
    paint(this.img.bgs[this.bgIndex], this.bgFade < 1 ? this.bgFade : 1);
    const g = ctx.createLinearGradient(0, 0, 0, STAGE_H);
    g.addColorStop(0, 'rgba(6,14,22,.55)');
    g.addColorStop(0.35, 'rgba(6,14,22,.12)');
    g.addColorStop(0.7, 'rgba(6,14,22,.2)');
    g.addColorStop(1, 'rgba(4,10,14,.7)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  }

  private drawFog(near: boolean): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    for (const f of this.fogs) {
      if (f.near !== near) continue;
      ctx.globalAlpha = f.a * (near ? 0.55 : 0.5);
      ctx.drawImage(this.fogSprite, f.x - this.mouse.x * (near ? 40 : 15), f.y, 256 * f.s, 128 * f.s * 0.6);
    }
    ctx.globalAlpha = 1;
  }

  private drawMotes(): void {
    this.ctx.globalCompositeOperation = 'lighter';
    for (const m of this.motes) this.drawGlow(this.glow.teal, m.x - this.mouse.x * 20, m.y, m.r, 0.25 + 0.2 * Math.sin(this.time * 2 + m.p));
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;
  }

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
    const b = this.foeBox();
    ctx.globalCompositeOperation = 'lighter';
    if (!this.foeDead) this.drawGlow(this.glow.red, b.x + b.w * 0.35, b.y + b.h * 0.45, b.h * 0.6, (0.18 + Math.sin(this.time * 2) * 0.05) * this.foeAlpha);
    ctx.globalCompositeOperation = 'source-over';
    for (const s of this.smokes) {
      ctx.globalAlpha = Math.max(0, s.life / s.max) * 0.55;
      ctx.drawImage(this.smokeSprite, s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
    }
    if (this.foeAlpha > 0) {
      ctx.globalAlpha = this.foeAlpha;
      const hue = this.foe?.hue ?? 0;
      if (hue) ctx.filter = `hue-rotate(${hue}deg) saturate(1.1)`;
      ctx.drawImage(img, b.x, b.y, b.w, b.h);
      ctx.filter = 'none';
      if (this.foeHit > 0) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = this.foeHit * 0.75;
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
      ctx.strokeStyle = `rgba(${b.rgb},${0.35 * a})`;
      ctx.lineWidth = b.width * 4;
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,235,235,${a})`;
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
    // 阵盘投影：在已解锁的环下压一层暗色椭圆，亮色背景（如宗门广场）上阵纹也清楚
    let outer = 0;
    board.forEach((ring, r) => { if (ring.unlocked) outer = Math.max(outer, ringRadius(r, this.ringReveal[r])); });
    if (outer > 0) {
      const shadowR = outer + 70;
      ctx.save();
      ctx.translate(LAYOUT.cx, LAYOUT.cy);
      ctx.scale(1, LAYOUT.ratio);
      const g = ctx.createRadialGradient(0, 0, shadowR * 0.2, 0, 0, shadowR);
      g.addColorStop(0, 'rgba(3,10,14,.62)');
      g.addColorStop(0.7, 'rgba(3,10,14,.42)');
      g.addColorStop(1, 'rgba(3,10,14,0)');
      ctx.fillStyle = g;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(0, 0, shadowR, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    // 丹田阵纹
    ctx.save();
    ctx.translate(LAYOUT.cx, LAYOUT.cy);
    ctx.scale(1, LAYOUT.ratio);
    ctx.rotate(this.time * 0.25);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(255,214,140,${running ? 0.5 : 0.28})`;
    ctx.lineWidth = 2;
    for (let i = 0; i < 8; i++) {
      ctx.rotate(TAU / 8);
      ctx.beginPath();
      ctx.moveTo(24, 0);
      ctx.lineTo(56, 0);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, 60, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, TAU);
    ctx.stroke();
    ctx.restore();
    ctx.globalCompositeOperation = 'lighter';
    this.drawGlow(this.glow.gold, LAYOUT.cx, LAYOUT.cy, running ? 64 : 46, running ? 0.45 : 0.25);
    // 同心环
    board.forEach((ring, r) => {
      const radius = ringRadius(r, ring.unlocked ? this.ringReveal[r] : 1);
      if (ring.unlocked) {
        const a = (0.35 + (running ? 0.3 : 0)) * this.ringReveal[r];
        this.ellipse(radius + 6);
        ctx.strokeStyle = `rgba(255,205,120,${a * 0.55})`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.stroke();
        this.ellipse(radius);
        ctx.strokeStyle = `rgba(255,215,140,${a})`;
        ctx.lineWidth = 3;
        ctx.stroke();
        this.ellipse(radius - 7);
        ctx.strokeStyle = `rgba(140,255,225,${a * 0.7})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 16]);
        ctx.lineDashOffset = -this.time * (running ? 90 : 24);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        this.ellipse(radius);
        ctx.strokeStyle = 'rgba(200,220,215,.06)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 12]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // 阵眼（按纵深排序，后排先画）
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
    const rgb = cat ? CATEGORY_RGB[cat] : '150,220,210';
    const rx = ref.ring === 0 ? 34 : 30;
    const ry = rx * 0.38;
    const isTarget = this.view.target?.ring === ref.ring && this.view.target.slot === ref.slot;
    const hover = this.view.hover?.ring === ref.ring && this.view.hover.slot === ref.slot;
    const aiming = !node && (this.view.placing || this.view.moveTargeting);
    ctx.globalCompositeOperation = 'lighter';
    const sprite = cat === 'AMPLIFY' ? this.glow.gold : cat === 'RELEASE' ? this.glow.orange : this.glow.teal;
    this.drawGlow(sprite, p.x, p.y, 56 + fx * 30, ((node ? 0.3 : 0.12) + fx * 0.5) * reveal);
    ctx.globalCompositeOperation = 'source-over';
    const g = ctx.createRadialGradient(p.x - 8, p.y - 4, 2, p.x, p.y, rx);
    g.addColorStop(0, node ? `rgba(${rgb},.75)` : 'rgba(90,140,130,.55)');
    g.addColorStop(0.6, 'rgba(22,60,56,.85)');
    g.addColorStop(1, 'rgba(8,24,24,.9)');
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, rx, ry, 0, 0, TAU);
    ctx.fillStyle = g;
    ctx.globalAlpha = reveal * (node ? 1 : 0.7);
    ctx.fill();
    ctx.lineWidth = isTarget ? 3 : 2;
    ctx.strokeStyle = isTarget ? 'rgba(255,120,90,.95)' : hover ? 'rgba(255,240,200,.95)' : `rgba(225,190,110,${node ? 0.9 : 0.5})`;
    if (!node) ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (aiming) {
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rx + 6 + Math.sin(this.time * 6) * 3, ry + 3, 0, 0, TAU);
      ctx.strokeStyle = 'rgba(255,240,190,.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (node && cat) {
      ctx.globalCompositeOperation = 'lighter';
      const ph = 60 + fx * 60;
      const pg = ctx.createLinearGradient(0, p.y - ph, 0, p.y);
      pg.addColorStop(0, `rgba(${rgb},0)`);
      pg.addColorStop(1, `rgba(${rgb},${0.28 + fx * 0.45})`);
      ctx.fillStyle = pg;
      ctx.globalAlpha = reveal;
      ctx.beginPath();
      ctx.moveTo(p.x - rx * 0.45, p.y);
      ctx.lineTo(p.x - rx * 0.2, p.y - ph);
      ctx.lineTo(p.x + rx * 0.2, p.y - ph);
      ctx.lineTo(p.x + rx * 0.45, p.y);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      const fy = p.y - 26 + (this.reducedMotion ? 0 : Math.sin(this.time * 2 + ref.ring * 2 + ref.slot) * 3);
      ctx.font = `${ref.ring === 0 ? 32 : 28}px "Ma Shan Zheng","STKaiti","KaiTi",serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.strokeText(glyphOf(node), p.x, fy);
      ctx.fillStyle = CATEGORY_HEX[cat];
      ctx.fillText(glyphOf(node), p.x, fy);
      ctx.font = '700 11px "Noto Serif SC",serif';
      ctx.fillStyle = 'rgba(255,240,210,.85)';
      ctx.fillText(ROMAN[node.level] ?? String(node.level), p.x + 20, fy + 10);
    }
    if (ref.ring === 0 && ref.slot === 0) {
      ctx.font = '500 12px "Noto Serif SC",serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(220,240,232,.8)';
      ctx.fillText('入气', p.x, p.y + ry + 11);
    }
    ctx.globalAlpha = 1;
  }

  private drawHero(): void {
    const ctx = this.ctx;
    const img = this.img.hero;
    if (!ready(img) || this.heroAlpha <= 0) return;
    if (!this.heroRed) this.heroRed = silhouette(img, '#ff3020');
    const b = this.heroBox();
    ctx.save();
    const breathe = this.reducedMotion ? 0 : Math.sin(this.time * 1.6) * 0.006;
    ctx.translate(b.x + b.w / 2, b.y + b.h);
    ctx.transform(1, 0, this.reducedMotion ? 0 : Math.sin(this.time * 0.9) * 0.012, 1 + breathe, 0, 0);
    ctx.globalAlpha = this.heroAlpha;
    ctx.drawImage(img, -b.w / 2, -b.h, b.w, b.h);
    if (this.heroHit > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = this.heroHit * 0.6;
      ctx.drawImage(this.heroRed, -b.w / 2, -b.h, b.w, b.h);
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'lighter';
    const hand = this.heroHand();
    this.drawGlow(this.glow.teal, hand.x, hand.y, 40 + this.heroCast * 50, 0.35 + this.heroCast * 0.6);
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
    const cy = Math.min(hand.y, s0.y) - 90;
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
    ctx.strokeStyle = `rgba(120,255,225,${0.25 * a})`;
    ctx.lineWidth = 14;
    ctx.stroke();
    ctx.strokeStyle = `rgba(235,255,250,${0.9 * a})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    this.drawGlow(this.glow.white, px, py, 26, a);
    this.drawGlow(this.glow.teal, px, py, 50, 0.7 * a);
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
          pos = { x: q.x, y: q.y - 16 };
        }
        trail.push(pos);
        if (trail.length > 16) trail.shift();
      } else if (trail.length) {
        trail.shift();
      }
      const mult = state?.power.multiplier ?? 1;
      const base = state?.power.baseQi ?? 10;
      const goldness = Math.max(0, Math.min(1, (mult - 1) / 1.6));
      const radius = 14 + Math.min(34, Math.sqrt(Math.max(0, base)) * 2.3);
      trail.forEach((t, i) => {
        const f = (i + 1) / trail.length;
        this.drawGlow(this.glow.teal, t.x, t.y, radius * f * 0.9, 0.45 * f * (1 - goldness));
        this.drawGlow(this.glow.gold, t.x, t.y, radius * f * 0.9, 0.45 * f * goldness);
      });
      if (pos) {
        this.drawGlow(this.glow.teal, pos.x, pos.y, radius * 2.2, 0.55 * (1 - goldness) + 0.15);
        this.drawGlow(this.glow.gold, pos.x, pos.y, radius * 2.2, 0.6 * goldness);
        this.drawGlow(this.glow.white, pos.x, pos.y, radius * 0.7, 1);
        if (!this.reducedMotion && Math.random() < 0.4) {
          this.particles.push({ x: pos.x, y: pos.y, vx: (Math.random() - 0.5) * 60, vy: -20 - Math.random() * 40, life: 0.5, max: 0.5, r: 5, sprite: goldness > 0.5 ? this.glow.gold : this.glow.teal, drag: 0.95 });
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
    ctx.globalAlpha = 0.8;
    ctx.drawImage(this.glow.teal, -len * 0.7, -16, len * 1.4, 32);
    ctx.globalAlpha = 1;
    const g = ctx.createLinearGradient(-len * 0.4, 0, len * 0.5, 0);
    g.addColorStop(0, 'rgba(160,255,235,.6)');
    g.addColorStop(1, 'rgba(255,255,255,1)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(len * 0.5, 0);
    ctx.lineTo(-len * 0.25, -3.2);
    ctx.lineTo(-len * 0.25, 3.2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,225,160,.95)';
    ctx.fillRect(-len * 0.28, -7, 3, 14);
    ctx.fillRect(-len * 0.45, -1.6, len * 0.17, 3.2);
    ctx.restore();
  }

  private drawProjectiles(): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.projectiles) {
      if (p.t < 0) {
        if (p.kind === 'orb') {
          this.drawGlow(this.glow.gold, p.x0, p.y0, p.size * (1 + p.charge * 1.6), 0.9 * p.charge);
          this.drawGlow(this.glow.white, p.x0, p.y0, p.size * 0.6 * p.charge, p.charge);
        }
        continue;
      }
      if (p.kind === 'sword') {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        p.trail.forEach((t, i) => (i ? ctx.lineTo(t.x, t.y) : ctx.moveTo(t.x, t.y)));
        ctx.strokeStyle = 'rgba(140,255,230,.35)';
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        this.drawSword(p.x, p.y, p.angle, 70);
      } else {
        p.trail.forEach((t, i) => {
          const f = (i + 1) / p.trail.length;
          this.drawGlow(this.glow.orange, t.x, t.y, p.size * 1.8 * f, 0.5 * f);
          this.drawGlow(this.glow.gold, t.x, t.y, p.size * f, 0.6 * f);
        });
        this.drawGlow(this.glow.gold, p.x, p.y, p.size * 2.6, 1);
        this.drawGlow(this.glow.white, p.x, p.y, p.size, 1);
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
      ctx.ellipse(w.x, w.y, w.r, w.r * 0.45, 0, 0, TAU);
      ctx.strokeStyle = `rgba(${w.rgb},${a * 0.8})`;
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
      const pop = f.age < 0.12 ? 1.5 - (f.age / 0.12) * 0.5 : 1;
      ctx.globalAlpha = Math.max(0, a);
      ctx.font = `${Math.round(f.size * pop)}px "Ma Shan Zheng","STKaiti","KaiTi",serif`;
      ctx.lineWidth = Math.max(3, f.size / 9);
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }
}

/** 道韵类别（供 UI 在落子后调用 placeFx） */
export function categoryOf(configId: string): DaoCategory {
  return getDaoConfig(configId).category;
}
