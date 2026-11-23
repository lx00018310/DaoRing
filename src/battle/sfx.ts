// ============================================================
// 斗法音效：Web Audio 合成（零外部资源），与炼气篇共用静音开关
// ============================================================
import { sound } from '../audio';

class BattleSfx {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;

  private audio(): AudioContext | null {
    if (sound.getMuted()) return null;
    try {
      if (!this.ctx && typeof window !== 'undefined') {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (Ctor) this.ctx = new Ctor();
      }
      if (this.ctx && !this.noise) {
        const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        this.noise = buffer;
      }
      if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    } catch {
      return null;
    }
  }

  unlock(): void {
    this.audio();
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.12, slide = 0): void {
    const a = this.audio();
    if (!a) return;
    try {
      const osc = a.createOscillator();
      const gain = a.createGain();
      const t = a.currentTime;
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(a.destination);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    } catch {
      // 音频失败不影响演出
    }
  }

  private hiss(dur: number, f0: number, f1: number, vol: number, type: BiquadFilterType = 'lowpass'): void {
    const a = this.audio();
    if (!a || !this.noise) return;
    try {
      const src = a.createBufferSource();
      const filter = a.createBiquadFilter();
      const gain = a.createGain();
      const t = a.currentTime;
      src.buffer = this.noise;
      src.loop = true;
      filter.type = type;
      filter.frequency.setValueAtTime(f0, t);
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(a.destination);
      src.start(t);
      src.stop(t + dur + 0.05);
    } catch {
      // ignore
    }
  }

  place(): void { this.tone(520, 0.2, 'triangle', 0.1); }
  chime(step = 0): void { this.tone(620 * Math.pow(1.12, step), 0.5, 'sine', 0.09); }
  whoosh(): void { this.hiss(0.35, 3200, 700, 0.1, 'bandpass'); }
  sword(): void { this.hiss(0.22, 5000, 1500, 0.06, 'highpass'); }
  boom(): void { this.hiss(0.9, 900, 60, 0.4); this.tone(72, 0.8, 'sine', 0.3, 0.5); }
  hit(): void { this.hiss(0.25, 1800, 200, 0.18); }
  thunder(): void { this.hiss(1.2, 2600, 90, 0.28); this.tone(55, 1, 'sawtooth', 0.05, 0.6); }
  fail(): void { this.tone(240, 0.7, 'sawtooth', 0.05, 0.55); }
  win(): void {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 1, 'sine', 0.1), i * 110));
  }
}

export const sfx = new BattleSfx();
