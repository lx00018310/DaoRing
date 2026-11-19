// ============================================================
// 运转演出队列调度器 (Animation & Stage Director)
// 职责：
// 1. 严格基于 executeTurn 的真实 simulation.logs 驱动视觉表现；
// 2. 调度“聚气 → 传导 → 增幅 → 释放”四拍节奏；
// 3. 终局驱动“周天贯通 × 破茧化仙”4.5 秒联合破境演出；
// 4. 提供跳过机制与可重入安全锁，杜绝串局。
// ============================================================

import { sound } from './audio';
import { DEMO_CONFIG } from './demoConfig';
import type { TurnExecutionResult } from './game';
import type { SimulationLogEntry } from './types';

export interface VisualCallbacks {
  /** 高亮/取消高亮指定阵眼 */
  setSlotHighlight: (slotIdx: number, level: 'normal' | 'active' | 'amplify' | 'release' | null) => void;
  /** 高亮槽位之间的连线 */
  highlightTrack: (fromSlot: number, toSlot: number) => void;
  /** 在指定阵眼附近弹出浮动数值提示（+20气、倍率+0.5、分裂等） */
  spawnFloatText: (slotIdx: number, text: string, type: 'amplify' | 'split' | 'crit' | 'release') => void;
  /** 更新主爆发大数字展示 */
  updateBurstScore: (score: number, delta: number, isFinal: boolean) => void;
  /** 触发小关突破轻量反馈 (初期->中期/中期->巅峰) */
  playMinorBreakthrough: () => Promise<void>;
  /** 触发炼气巅峰终局联合破境演出 (周天贯通 × 破茧化仙) */
  playGrandBreakthrough: (isReducedMotion: boolean) => Promise<void>;
  /** 运转全部结束回调 */
  onComplete: () => void;
}

export class AnimationQueueDirector {
  private isRunning: boolean = false;
  private isSkipped: boolean = false;
  private isCancelled: boolean = false;
  private activeTimers: Array<ReturnType<typeof setTimeout>> = [];
  private activeWaitResolvers: Array<() => void> = [];

  public get running(): boolean {
    return this.isRunning;
  }

  public get skipped(): boolean {
    return this.isSkipped;
  }

  public get cancelled(): boolean {
    return this.isCancelled;
  }

  /** 安全可取消延时 */
  public wait(ms: number): Promise<void> {
    if (this.isSkipped || this.isCancelled) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const wake = () => {
        const tIdx = this.activeTimers.indexOf(timer);
        if (tIdx !== -1) this.activeTimers.splice(tIdx, 1);
        const rIdx = this.activeWaitResolvers.indexOf(wake);
        if (rIdx !== -1) this.activeWaitResolvers.splice(rIdx, 1);
        resolve();
      };

      timer = setTimeout(wake, ms);
      this.activeTimers.push(timer);
      this.activeWaitResolvers.push(wake);
    });
  }

  /** 清除所有正在等待的定时器并彻底作废当前局演出 */
  public cancelAll(): void {
    this.isCancelled = true;
    this.isRunning = false;
    this.activeTimers.forEach((t) => clearTimeout(t));
    this.activeTimers = [];
    const resolvers = [...this.activeWaitResolvers];
    this.activeWaitResolvers = [];
    resolvers.forEach((r) => r());
  }

  /** 玩家点击跳过动画 */
  public skip(): void {
    if (!this.isRunning) return;
    this.isSkipped = true;
    this.activeTimers.forEach((t) => clearTimeout(t));
    this.activeTimers = [];
    const resolvers = [...this.activeWaitResolvers];
    this.activeWaitResolvers = [];
    resolvers.forEach((r) => r());
  }

  /** 执行整轮回合演出 */
  public async playTurn(
    result: TurnExecutionResult,
    isFinaleReady: boolean,
    isMinorReady: boolean,
    cb: VisualCallbacks,
  ): Promise<void> {
    this.cancelAll();
    this.isRunning = true;
    this.isSkipped = false;
    this.isCancelled = false;

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    return new Promise<void>((resolve) => {
      this.executeSequence(result, isFinaleReady, isMinorReady, reducedMotion, cb)
        .catch(() => {})
        .finally(() => {
          this.isRunning = false;
          // 若被外部 cancelAll() 强制取消，绝不调用旧局的 onComplete
          if (!this.isCancelled) {
            cb.onComplete();
          }
          resolve();
        });
    });
  }

  private async executeSequence(
    result: TurnExecutionResult,
    isFinaleReady: boolean,
    isMinorReady: boolean,
    reducedMotion: boolean,
    cb: VisualCallbacks,
  ): Promise<void> {
    const logs = result.simulation.logs;
    const timings = DEMO_CONFIG.timings;

    // 若用户直接跳过或无日志，直接结算
    if (this.isSkipped || logs.length === 0) {
      cb.updateBurstScore(result.simulation.turnQiGenerated, result.simulation.turnQiGenerated, true);
      if (isFinaleReady) {
        await cb.playGrandBreakthrough(true);
      } else if (isMinorReady) {
        await cb.playMinorBreakthrough();
      }
      return;
    }

    // 拍 1：聚气启动
    sound.playGather();
    cb.setSlotHighlight(0, 'active');
    await this.wait(timings.pulseStart);
    if (this.isSkipped) {
      this.finishQuickly(result, isFinaleReady, isMinorReady, cb);
      return;
    }

    // 拍 2 & 3 & 4：沿真实日志顺序逐步推进
    let currentTotalScore = 0;
    let lastSlot = 0;

    for (let i = 0; i < logs.length; i++) {
      if (this.isSkipped) break;
      const entry: SimulationLogEntry = logs[i];

      // 处理移动与巡航
      if (entry.action === 'MOVE' || entry.action === 'OUTER_LOOP') {
        sound.playStep();
        cb.highlightTrack(lastSlot, entry.slotIdx);
        cb.setSlotHighlight(entry.slotIdx, 'active');
        lastSlot = entry.slotIdx;
        await this.wait(timings.stepMove);
        continue;
      }

      // 处理分裂
      if (entry.action === 'CHAIN_SPLIT') {
        sound.playAmplify(true);
        cb.setSlotHighlight(entry.slotIdx, 'amplify');
        cb.spawnFloatText(entry.slotIdx, '⚡ 分光分裂', 'split');
        await this.wait(timings.amplify);
        continue;
      }

      // 处理增幅
      if (entry.action === 'AMPLIFY' || entry.action === 'SYNERGY') {
        sound.playAmplify(false);
        cb.setSlotHighlight(entry.slotIdx, 'amplify');
        const text = entry.action === 'SYNERGY' ? '✨ 道法连携' : (entry.detail.includes('baseQi+') ? '聚灵 +气' : '锋芒 暴击');
        cb.spawnFloatText(entry.slotIdx, text, 'amplify');
        await this.wait(timings.amplify);
        continue;
      }

      // 处理释放
      if (entry.action === 'RELEASE') {
        const delta = entry.qiDelta ?? 0;
        currentTotalScore += delta;
        sound.playRelease();
        cb.setSlotHighlight(entry.slotIdx, 'release');
        cb.spawnFloatText(entry.slotIdx, `💥 +${delta}`, 'release');
        cb.updateBurstScore(currentTotalScore, delta, false);
        await this.wait(timings.releaseBurst);
        continue;
      }
    }

    // 最终产气数值对齐
    cb.updateBurstScore(result.simulation.turnQiGenerated, 0, true);

    // 清理高亮
    for (let s = 0; s < 4; s++) {
      cb.setSlotHighlight(s, null);
    }

    if (this.isSkipped) {
      this.finishQuickly(result, isFinaleReady, isMinorReady, cb);
      return;
    }

    // 拍 5：若通关，播放突破演出
    if (isFinaleReady) {
      // 炼气巅峰通关：周天贯通 × 破茧化仙 (4.5s 联合演出)
      await cb.playGrandBreakthrough(reducedMotion);
    } else if (isMinorReady) {
      // 炼气初期/中期小突破：轻量反馈 (0.8s)
      await cb.playMinorBreakthrough();
    }
  }

  private finishQuickly(
    result: TurnExecutionResult,
    isFinaleReady: boolean,
    isMinorReady: boolean,
    cb: VisualCallbacks,
  ): void {
    cb.updateBurstScore(result.simulation.turnQiGenerated, result.simulation.turnQiGenerated, true);
    for (let s = 0; s < 4; s++) {
      cb.setSlotHighlight(s, null);
    }
    if (isFinaleReady) {
      cb.playGrandBreakthrough(true);
    } else if (isMinorReady) {
      cb.playMinorBreakthrough();
    }
  }
}

export const animationDirector = new AnimationQueueDirector();
