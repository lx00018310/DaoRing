import { sound } from './audio';
import { DEMO_CONFIG } from './demoConfig';
import type { TurnExecutionResult } from './game';
import type { SimulationLogEntry } from './types';

type PlaybackWait = (ms: number) => Promise<boolean>;

export interface VisualCallbacks {
  setSlotHighlight: (slotIdx: number, level: 'active' | 'amplify' | 'release' | null) => void;
  spawnPulse?: (pulseId: string, slotIdx: number) => void;
  movePulse?: (pulseId: string, fromSlot: number, toSlot: number, duration: number) => void;
  removePulse?: (pulseId: string) => void;
  highlightTrack: (fromSlot: number, toSlot: number) => void;
  spawnFloatText: (slotIdx: number, text: string, type: 'amplify' | 'split' | 'crit' | 'release' | 'synergy') => void;
  updateBurstScore: (score: number, delta: number, isFinal: boolean, summaryText?: string) => void;
  onReleaseShown?: () => void;
  clearEffects?: () => void;
  playMinorBreakthrough: (wait: PlaybackWait) => Promise<void>;
  playGrandBreakthrough: (isReducedMotion: boolean, releaseSlots: number[], wait: PlaybackWait) => Promise<void>;
  onComplete: () => void;
}

interface Playback {
  skipped: boolean;
  cancelled: boolean;
  interrupt: (() => void) | null;
}

function visualEvents(logs: SimulationLogEntry[]): SimulationLogEntry[] {
  const events = logs.filter((entry) =>
    entry.ringIdx === 0 && (
      ['MOVE', 'OUTER_LOOP', 'AMPLIFY', 'SYNERGY', 'RELEASE', 'EXPIRE'].includes(entry.action) ||
      (entry.action === 'CHAIN_SPLIT' && (entry.spawnedPulseIds?.length ?? 0) > 0)
    ),
  );
  if (events.length <= 24) return events;

  // 保留起步与第一次关键效果。长回合仍可看到第一束实际释放及其邻近轨迹。
  const selected = new Set(events.slice(0, 8));
  for (const action of ['AMPLIFY', 'CHAIN_SPLIT', 'EXPIRE']) {
    const first = events.find((entry) => entry.action === action);
    if (first) selected.add(first);
  }
  const releaseIndex = events.findIndex((entry) => entry.action === 'RELEASE');
  if (releaseIndex >= 0) {
    const firstRelease = events[releaseIndex];
    selected.add(firstRelease);
    const previous = events.slice(0, releaseIndex).filter((entry) => entry.pulseId === firstRelease.pulseId);
    for (const event of previous.slice(-4)) selected.add(event);
  }
  return [...selected].sort((a, b) => a.seq - b.seq);
}

function eventDuration(entry: SimulationLogEntry): number {
  const timings = DEMO_CONFIG.timings;
  if (entry.action === 'MOVE' || entry.action === 'OUTER_LOOP') return timings.stepMove;
  if (entry.action === 'RELEASE') return timings.releaseBurst;
  return timings.amplify;
}

export class AnimationQueueDirector {
  private current: Playback | null = null;

  public get running(): boolean {
    return this.current !== null;
  }

  public get skipped(): boolean {
    return this.current?.skipped ?? false;
  }

  public cancelAll(): void {
    if (!this.current) return;
    const playback = this.current;
    this.current = null;
    playback.cancelled = true;
    playback.interrupt?.();
    sound.stopAll();
  }

  public skip(): void {
    if (!this.current) return;
    this.current.skipped = true;
    this.current.interrupt?.();
    sound.stopAll();
  }

  public async playTurn(
    result: TurnExecutionResult,
    isFinaleReady: boolean,
    isMinorReady: boolean,
    cb: VisualCallbacks,
  ): Promise<void> {
    this.cancelAll();
    const playback: Playback = { skipped: false, cancelled: false, interrupt: null };
    this.current = playback;
    const wait: PlaybackWait = (ms) => {
      if (playback.skipped || playback.cancelled) return Promise.resolve(false);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          playback.interrupt = null;
          resolve(true);
        }, ms);
        playback.interrupt = () => {
          clearTimeout(timer);
          playback.interrupt = null;
          resolve(false);
        };
      });
    };

    const reducedMotion = typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const releases = result.simulation.logs.filter((entry) => entry.action === 'RELEASE');
    const releaseSlots = [...new Set(releases.filter((entry) => entry.ringIdx === 0).map((entry) => entry.slotIdx))];
    const timings = DEMO_CONFIG.timings;
    let scoreShown = false;

    try {
      if (reducedMotion && result.simulation.logs.length > 0) {
        for (const slot of releaseSlots) cb.setSlotHighlight(slot, 'release');
        if (releaseSlots.length > 0) cb.onReleaseShown?.();
        cb.updateBurstScore(result.simulation.turnQiGenerated, 0, true);
        scoreShown = true;
        await wait(timings.reducedMotionNormalMax);
      } else if (result.simulation.logs.length > 0) {
        await this.playNormal(result.simulation.logs, releases, wait, cb);
      }

      if (playback.cancelled) return;
      cb.clearEffects?.();
      for (let slot = 0; slot < 4; slot++) cb.setSlotHighlight(slot, null);
      if (!scoreShown) {
        const total = result.simulation.turnQiGenerated;
        cb.updateBurstScore(total, playback.skipped ? total : 0, true);
      }

      if (!playback.skipped) {
        if (isFinaleReady) await cb.playGrandBreakthrough(reducedMotion, releaseSlots, wait);
        else if (isMinorReady) await cb.playMinorBreakthrough(wait);
      }
    } finally {
      if (this.current === playback) {
        if (playback.skipped) cb.clearEffects?.();
        // 结算回调需要读取本次播放的跳过状态。
        try {
          cb.onComplete();
        } finally {
          if (this.current === playback) this.current = null;
        }
      }
    }
  }

  private async playNormal(
    logs: SimulationLogEntry[],
    releases: SimulationLogEntry[],
    wait: PlaybackWait,
    cb: VisualCallbacks,
  ): Promise<void> {
    const timings = DEMO_CONFIG.timings;
    const events = visualEvents(logs);
    const displayed = new Set(events);
    const remainingReleases = releases.filter((entry) => !displayed.has(entry));
    const tailDuration = remainingReleases.length ? timings.releaseInterval : 0;
    const unscaled = events.reduce((ms, entry) => ms + eventDuration(entry), 0) + tailDuration;
    // 聚气计入整段预算，留少量定时器和绘制余量。
    const scale = Math.min(1, (timings.normalTurnBudgetMax - timings.pulseStart - 80) / Math.max(1, unscaled));
    let score = 0;

    sound.playGather();
    cb.spawnPulse?.('P0', 0);
    cb.setSlotHighlight(0, 'active');
    if (!await wait(timings.pulseStart)) return;

    for (const entry of events) {
      const duration = Math.floor(eventDuration(entry) * scale);
      switch (entry.action) {
        case 'MOVE':
        case 'OUTER_LOOP': {
          const { fromSlot, toSlot } = entry;
          if (fromSlot === undefined || toSlot === undefined || fromSlot === toSlot) continue;
          sound.playStep();
          cb.highlightTrack(fromSlot, toSlot);
          cb.movePulse?.(entry.pulseId, fromSlot, toSlot, duration);
          cb.setSlotHighlight(toSlot, 'active');
          break;
        }
        case 'CHAIN_SPLIT':
          sound.playAmplify(true);
          cb.setSlotHighlight(entry.slotIdx, 'amplify');
          entry.spawnedPulseIds?.forEach((pulseId, index) => {
            const target = entry.spawnedSlots?.[index];
            if (target !== undefined) cb.spawnPulse?.(pulseId, target);
          });
          cb.spawnFloatText(entry.slotIdx, `分裂 +${entry.spawnedPulseIds?.length} 束`, 'split');
          break;
        case 'AMPLIFY':
          sound.playAmplify();
          cb.setSlotHighlight(entry.slotIdx, 'amplify');
          if (entry.baseQiDelta !== undefined) {
            cb.spawnFloatText(entry.slotIdx, `基础气 +${entry.baseQiDelta}`, 'amplify');
          } else if (entry.isCrit && entry.critFactor !== undefined) {
            cb.spawnFloatText(entry.slotIdx, `锋芒 暴击 ×${entry.critFactor}`, 'crit');
          } else if (entry.multiplierDelta !== undefined) {
            cb.spawnFloatText(entry.slotIdx, `倍率 +${entry.multiplierDelta.toFixed(2)}`, 'amplify');
          }
          break;
        case 'SYNERGY': {
          const text = entry.releaseFactorDelta !== undefined
            ? `连携 · 释放系数 +${entry.releaseFactorDelta}`
            : entry.ttlDelta !== undefined
              ? `连携 · 剩余步数 +${entry.ttlDelta}`
              : `连携 · 倍率 +${entry.multiplierDelta ?? 0}`;
          cb.spawnFloatText(entry.slotIdx, text, 'synergy');
          break;
        }
        case 'EXPIRE':
          cb.removePulse?.(entry.pulseId);
          cb.spawnFloatText(entry.slotIdx, '灵气消散', 'synergy');
          break;
        case 'RELEASE': {
          const delta = entry.qiDelta ?? 0;
          score += delta;
          cb.removePulse?.(entry.pulseId);
          cb.onReleaseShown?.();
          sound.playRelease();
          cb.setSlotHighlight(entry.slotIdx, 'release');
          cb.spawnFloatText(entry.slotIdx, `+${delta}`, 'release');
          cb.updateBurstScore(score, delta, false);
          break;
        }
      }
      if (!await wait(duration)) return;
    }

    if (remainingReleases.length > 0) {
      const delta = remainingReleases.reduce((total, entry) => total + (entry.qiDelta ?? 0), 0);
      cb.onReleaseShown?.();
      sound.playRelease();
      cb.updateBurstScore(score + delta, delta, false, `后续 ${remainingReleases.length} 束合计 +${delta}`);
      await wait(Math.floor(tailDuration * scale));
    }
  }
}

export const animationDirector = new AnimationQueueDirector();
