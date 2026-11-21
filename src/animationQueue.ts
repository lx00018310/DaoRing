// ============================================================
// 运转演出队列调度器 (Animation & Stage Director) - V3 真实流路与预算控制
// 职责：
// 1. 严格基于 executeTurn 的结构化 logs 驱动视觉表现；
// 2. 真实流路起终点对应，分束独立记录；
// 3. 严格预算控制（常规上限 3.2s，极端日志自适应压缩与尾段合并）；
// 4. 终局向心流光精确回溯本回合真实释放阵眼；
// 5. 绝对隔离的 Session 身份标记与多重取消锁，杜绝重开串局。
// ============================================================

import { sound } from './audio';
import { DEMO_CONFIG } from './demoConfig';
import type { TurnExecutionResult } from './game';
import type { SimulationLogEntry } from './types';

export interface VisualCallbacks {
  /** 高亮/取消高亮指定阵眼 */
  setSlotHighlight: (slotIdx: number, level: 'normal' | 'active' | 'amplify' | 'release' | null) => void;
  /** 高亮特定阵眼间的导引轨道 */
  highlightTrack: (fromSlot: number, toSlot: number) => void;
  /** 在指定阵眼附近弹出浮动数值提示（+20气、倍率+0.5、分裂等） */
  spawnFloatText: (slotIdx: number, text: string, type: 'amplify' | 'split' | 'crit' | 'release' | 'synergy') => void;
  /** 更新主爆发大数字展示与尾段合并摘要 */
  updateBurstScore: (score: number, delta: number, isFinal: boolean, summaryText?: string) => void;
  /** 触发小关突破轻量反馈 (0.8s) */
  playMinorBreakthrough: () => Promise<void>;
  /** 触发炼气巅峰终局联合破境演出 (4.5s，仅从真实释放阵眼汇聚向心流光) */
  playGrandBreakthrough: (isReducedMotion: boolean, releaseSlots: number[]) => Promise<void>;
  /** 运转全部结束回调（仅在当前局未被取消时触发） */
  onComplete: () => void;
}

export class AnimationQueueDirector {
  private isRunning: boolean = false;
  private isSkipped: boolean = false;
  private isCancelled: boolean = false;
  private currentSessionId: number = 0;
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

  /** 安全可取消延时，校验 session 身份 */
  public wait(ms: number, sessionId: number): Promise<boolean> {
    if (this.isSkipped || this.isCancelled || this.currentSessionId !== sessionId) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const wake = () => {
        const tIdx = this.activeTimers.indexOf(timer);
        if (tIdx !== -1) this.activeTimers.splice(tIdx, 1);
        const rIdx = this.activeWaitResolvers.indexOf(wake);
        if (rIdx !== -1) this.activeWaitResolvers.splice(rIdx, 1);
        const valid = !this.isCancelled && this.currentSessionId === sessionId;
        resolve(valid);
      };

      timer = setTimeout(wake, ms);
      this.activeTimers.push(timer);
      this.activeWaitResolvers.push(wake);
    });
  }

  /** 清除所有正在等待的定时器并彻底作废当前局演出 */
  public cancelAll(): void {
    this.currentSessionId += 1;
    this.isCancelled = true;
    this.isRunning = false;
    this.isSkipped = false;
    sound.stopAll();
    this.activeTimers.forEach((t) => clearTimeout(t));
    this.activeTimers = [];
    const resolvers = [...this.activeWaitResolvers];
    this.activeWaitResolvers = [];
    resolvers.forEach((r) => r());
  }

  /** 玩家点击跳过动画或切后台时收束 */
  public skip(): void {
    if (!this.isRunning) return;
    this.isSkipped = true;
    sound.stopAll();
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
    const sessionId = ++this.currentSessionId;
    this.isRunning = true;
    this.isSkipped = false;
    this.isCancelled = false;

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // 统计本轮回合的真实释放槽位集合（去重供向心流光使用）
    const releaseSlots = Array.from(
      new Set(
        result.simulation.logs
          .filter((l) => l.action === 'RELEASE')
          .map((l) => l.slotIdx),
      ),
    );

    return new Promise<void>((resolve) => {
      this.executeSequence(result, isFinaleReady, isMinorReady, reducedMotion, releaseSlots, sessionId, cb)
        .catch(() => {})
        .finally(() => {
          if (this.currentSessionId === sessionId) {
            this.isRunning = false;
            if (!this.isCancelled) {
              cb.onComplete();
            }
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
    releaseSlots: number[],
    sessionId: number,
    cb: VisualCallbacks,
  ): Promise<void> {
    const logs = result.simulation.logs;
    const timings = DEMO_CONFIG.timings;

    // 若用户直接跳过、无日志、或低运动模式快速收束
    if (this.isSkipped || logs.length === 0 || reducedMotion) {
      await this.finishQuickly(result, isFinaleReady, isMinorReady, reducedMotion, releaseSlots, sessionId, cb);
      return;
    }

    // 拍 1：聚气启动 (Slot 0 入气)
    sound.playGather();
    cb.setSlotHighlight(0, 'active');
    const ok1 = await this.wait(timings.pulseStart, sessionId);
    if (!ok1 || this.isSkipped) {
      await this.finishQuickly(result, isFinaleReady, isMinorReady, reducedMotion, releaseSlots, sessionId, cb);
      return;
    }

    // 拍 2 & 3 & 4：沿真实日志推进，实施 3.2s 播放预算保护
    const startTime = Date.now();
    const maxBudgetMs = timings.normalTurnBudgetMax; // 3200ms
    let currentTotalScore = 0;
    let releasesCounted = 0;
    const totalReleasesInLog = logs.filter((l) => l.action === 'RELEASE').length;

    for (let i = 0; i < logs.length; i++) {
      if (this.isSkipped || this.isCancelled || this.currentSessionId !== sessionId) break;
      const entry: SimulationLogEntry = logs[i];

      // 预算溢出检查：若已消耗较长时间且后续释放较多，启用尾部合并
      const elapsed = Date.now() - startTime;
      if (elapsed > maxBudgetMs - 400 && i < logs.length - 1) {
        // 快速统计剩余释放
        const remainingLogs = logs.slice(i);
        const remainingDelta = remainingLogs
          .filter((l) => l.action === 'RELEASE')
          .reduce((sum, l) => sum + (l.qiDelta ?? 0), 0);
        const remainingCount = remainingLogs.filter((l) => l.action === 'RELEASE').length;

        if (remainingCount > 0) {
          currentTotalScore += remainingDelta;
          sound.playRelease();
          cb.updateBurstScore(
            currentTotalScore,
            remainingDelta,
            false,
            `后续 ${remainingCount} 束合计 +${remainingDelta}`,
          );
          await this.wait(timings.releaseInterval, sessionId);
        }
        break;
      }

      // 处理移动与巡航（使用真实的起终点槽位）
      if (entry.action === 'MOVE' || entry.action === 'OUTER_LOOP') {
        const fromS = entry.fromSlot ?? entry.slotIdx;
        const toS = entry.toSlot ?? entry.slotIdx;
        sound.playStep();
        if (fromS !== toS) {
          cb.highlightTrack(fromS, toS);
        }
        cb.setSlotHighlight(toS, 'active');
        const ok = await this.wait(timings.stepMove, sessionId);
        if (!ok) return;
        continue;
      }

      // 处理分裂
      if (entry.action === 'CHAIN_SPLIT') {
        const spawnedCount = entry.spawnedPulseIds?.length ?? 0;
        if (spawnedCount > 0) {
          sound.playAmplify(true);
          cb.setSlotHighlight(entry.slotIdx, 'amplify');
          cb.spawnFloatText(entry.slotIdx, `⚡ 分裂 +${spawnedCount}束`, 'split');
          const ok = await this.wait(timings.amplify, sessionId);
          if (!ok) return;
        }
        continue;
      }

      // 处理增幅 (聚灵/锋芒/周天)
      if (entry.action === 'AMPLIFY') {
        sound.playAmplify(false);
        cb.setSlotHighlight(entry.slotIdx, 'amplify');
        let floatText = '增幅';
        if (entry.baseQiDelta !== undefined) {
          floatText = `聚灵 气+${entry.baseQiDelta}`;
        } else if (entry.isCrit) {
          floatText = `锋芒 暴击×${(entry.critFactor ?? 1.5).toFixed(1)}`;
        } else if (entry.multiplierDelta !== undefined) {
          floatText = `倍率+${entry.multiplierDelta.toFixed(2)}`;
        }
        cb.spawnFloatText(entry.slotIdx, floatText, entry.isCrit ? 'crit' : 'amplify');
        const ok = await this.wait(timings.amplify, sessionId);
        if (!ok) return;
        continue;
      }

      // 处理道法连携
      if (entry.action === 'SYNERGY') {
        sound.playAmplify(false);
        cb.setSlotHighlight(entry.slotIdx, 'amplify');
        const text = entry.detail.includes('极尽升华')
          ? '✨ 极尽升华(系数+0.2)'
          : entry.detail.includes('聚气生锋')
            ? '✨ 聚气生锋(倍率+0.3)'
            : '✨ 虚空借道(TTL+1)';
        cb.spawnFloatText(entry.slotIdx, text, 'synergy');
        const ok = await this.wait(timings.amplify, sessionId);
        if (!ok) return;
        continue;
      }

      // 处理释放
      if (entry.action === 'RELEASE') {
        const delta = entry.qiDelta ?? 0;
        currentTotalScore += delta;
        releasesCounted += 1;
        sound.playRelease();
        cb.setSlotHighlight(entry.slotIdx, 'release');
        cb.spawnFloatText(entry.slotIdx, `💥 +${delta}`, 'release');

        // 多束释放时压缩间隔
        const burstWait =
          releasesCounted > 1 && totalReleasesInLog > 2
            ? timings.releaseInterval
            : timings.releaseBurst;

        cb.updateBurstScore(currentTotalScore, delta, false);
        const ok = await this.wait(burstWait, sessionId);
        if (!ok) return;
        continue;
      }
    }

    // 最终产气数值对齐
    cb.updateBurstScore(result.simulation.turnQiGenerated, 0, true);

    // 清理高亮
    for (let s = 0; s < 4; s++) {
      cb.setSlotHighlight(s, null);
    }

    if (this.isSkipped || this.isCancelled || this.currentSessionId !== sessionId) {
      await this.finishQuickly(result, isFinaleReady, isMinorReady, reducedMotion, releaseSlots, sessionId, cb);
      return;
    }

    // 拍 5：突破与圆满分镜
    if (isFinaleReady) {
      // 炼气巅峰通关：周天贯通 × 破茧化仙 (4.5s 联合演出，只从真实释放阵眼汇聚)
      await cb.playGrandBreakthrough(reducedMotion, releaseSlots);
    } else if (isMinorReady) {
      // 炼气初期/中期小突破：轻量反馈 (0.8s)
      await cb.playMinorBreakthrough();
    }
  }

  private async finishQuickly(
    result: TurnExecutionResult,
    isFinaleReady: boolean,
    isMinorReady: boolean,
    reducedMotion: boolean,
    releaseSlots: number[],
    sessionId: number,
    cb: VisualCallbacks,
  ): Promise<void> {
    if (this.currentSessionId !== sessionId || this.isCancelled) return;
    cb.updateBurstScore(result.simulation.turnQiGenerated, result.simulation.turnQiGenerated, true);
    for (let s = 0; s < 4; s++) {
      cb.setSlotHighlight(s, null);
    }
    if (isFinaleReady) {
      await cb.playGrandBreakthrough(reducedMotion || true, releaseSlots);
    } else if (isMinorReady) {
      await cb.playMinorBreakthrough();
    }
  }
}

export const animationDirector = new AnimationQueueDirector();
