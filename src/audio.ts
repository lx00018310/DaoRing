// ============================================================
// 纯原生 Web Audio API 声音合成模块
// 零外部资源依赖，防 404，支持静音开关与用户手势解锁与完整取消回收
// ============================================================

class SoundManager {
  private ctx: AudioContext | null = null;
  private isMuted: boolean = false;
  private unlocked: boolean = false;
  private pendingTimers: Array<ReturnType<typeof setTimeout>> = [];

  constructor() {
    try {
      this.isMuted = localStorage.getItem('zt_demo_muted') === 'true';
    } catch {
      this.isMuted = false;
    }
  }

  private initCtx(): AudioContext | null {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public unlock(): void {
    if (!this.unlocked) {
      this.initCtx();
      this.unlocked = true;
    }
  }

  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    try {
      localStorage.setItem('zt_demo_muted', String(this.isMuted));
    } catch {
      // ignore
    }
    if (this.isMuted) {
      this.stopAll();
    }
    return this.isMuted;
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  /** 取消所有尚未触发的延迟音效 */
  public stopAll(): void {
    this.pendingTimers.forEach((t) => clearTimeout(t));
    this.pendingTimers = [];
  }

  private safeSetTimeout(fn: () => void, delayMs: number): void {
    if (this.isMuted) return;
    const timer = setTimeout(() => {
      const idx = this.pendingTimers.indexOf(timer);
      if (idx !== -1) this.pendingTimers.splice(idx, 1);
      if (!this.isMuted) fn();
    }, delayMs);
    this.pendingTimers.push(timer);
  }

  /** 播放简短正弦音 */
  private playTone(freq: number, type: OscillatorType, duration: number, gainVal: number, rampDown = true): void {
    if (this.isMuted) return;
    const ctx = this.initCtx();
    if (!ctx) return;

    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);

      gain.gain.setValueAtTime(gainVal, ctx.currentTime);
      if (rampDown) {
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
      }

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch {
      // 容错降级
    }
  }

  /** 聚气启动音 (清脆柔和角调) */
  public playGather(): void {
    this.playTone(440, 'sine', 0.25, 0.12);
  }

  /** 槽位传导步进音 */
  public playStep(): void {
    this.playTone(523.25, 'triangle', 0.12, 0.08); // C5
  }

  /** 节点分裂或增幅音 (徵调上行) */
  public playAmplify(isSplit = false): void {
    if (isSplit) {
      this.playTone(659.25, 'sine', 0.18, 0.15); // E5
      this.safeSetTimeout(() => this.playTone(880, 'sine', 0.2, 0.12), 70); // A5
    } else {
      this.playTone(587.33, 'sine', 0.2, 0.12); // D5
    }
  }

  /** 单次灵爆释放爆发音 */
  public playRelease(): void {
    if (this.isMuted) return;
    const ctx = this.initCtx();
    if (!ctx) return;

    try {
      this.playTone(130.81, 'triangle', 0.45, 0.25); // C3
      this.safeSetTimeout(() => this.playTone(523.25, 'sine', 0.35, 0.15), 50);
    } catch {
      // ignore
    }
  }

  /** 终局：低沉蓄力音 (0.0~0.7s) */
  public playFinaleCharge(): void {
    if (this.isMuted) return;
    const ctx = this.initCtx();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(110, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.7);
      gain.gain.setValueAtTime(0.05, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 0.65);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.75);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.75);
    } catch {
      // ignore
    }
  }

  /** 终局：经脉流光激活音 (0.7~1.5s) */
  public playFinaleMeridian(): void {
    [330, 392, 440, 523, 659].forEach((freq, idx) => {
      this.safeSetTimeout(() => {
        this.playTone(freq, 'sine', 0.22, 0.08);
      }, idx * 120);
    });
  }

  /** 终局：短促破茧音 (1.5~2.3s) */
  public playFinaleBreak(): void {
    this.playTone(220, 'sawtooth', 0.3, 0.18);
    this.safeSetTimeout(() => this.playTone(880, 'sine', 0.4, 0.2), 60);
  }

  /** 终局：金色冲击波与周天圆满清亮大音 (2.3~4.0s) */
  public playFinaleComplete(): void {
    if (this.isMuted) return;
    const freqs = [261.63, 329.63, 392.0, 523.25, 659.25, 783.99]; // C和弦如沐仙光
    freqs.forEach((f, idx) => {
      this.safeSetTimeout(() => {
        this.playTone(f, 'sine', 1.2, 0.15 - idx * 0.015);
      }, idx * 90);
    });
  }
}

export const sound = new SoundManager();
