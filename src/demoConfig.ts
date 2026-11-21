// ============================================================
// 《周天破境录：炼气篇》Demo V3 专用配置与常量
// ============================================================

export interface DemoConfig {
  /** 仅展示的最大境界（1 = 炼气） */
  maxRealm: number;
  /** V3 首局教学手牌：1 张 LV1 聚灵 + 1 张 LV1 灵爆 */
  fixedFirstHandIds: string[];
  /** 初期达标奖励候选 */
  midStageChoices: {
    configId: string;
    name: string;
    recommendedSlot: number;
    recommendedSlotName: string;
    advice: string;
  }[];
  /** 中期附赠机动手牌 */
  midStageBonusCardId: string;
  /** 巅峰前补发卡牌（未选中期牌 + 万剑诀） */
  zenithBonusCardId: string;
  /** 首次通关教学固定天劫 ID */
  fixedTribulationId: string;
  /** 动画节拍时长配置 (毫秒) 与播放预算 */
  timings: {
    /** 初始聚气光点产生 */
    pulseStart: number;
    /** 普通传导移动一步 */
    stepMove: number;
    /** 节点触发增幅 */
    amplify: number;
    /** 单次释放爆发 */
    releaseBurst: number;
    /** 连续多束释放时的间隔压缩 */
    releaseInterval: number;
    /** 普通回合常规演出前台硬上限 (毫秒: 3.2s) */
    normalTurnBudgetMax: number;
    /** 小关突破轻量反馈 (毫秒: 0.8s) */
    minorBreakthrough: number;
    /** 低运动模式普通回合上限 */
    reducedMotionNormalMax: number;
    /** prefers-reduced-motion 模式下的终局总时长 */
    reducedMotionFinale: number;
    /** 终局破境动画各分镜时长 (总长约 4.5s) */
    finale: {
      /** 0.0~0.7s: 周天归一，能量向阵心收束 */
      converge: number;
      /** 0.7~1.5s: 灵气入体，经脉依次亮起 */
      meridian: number;
      /** 1.5~2.3s: 破茧冲关，金茧裂纹微震 */
      breakCocoon: number;
      /** 2.3~3.2s: 周天贯通，环形同心冲击波穿透阵盘 */
      shockwave: number;
      /** 3.2~4.5s: 炼气圆满，文字定格与结算 */
      complete: number;
    };
  };
}

export const DEMO_CONFIG: DemoConfig = {
  maxRealm: 1,
  // V3 首局开局手牌：聚灵(Slot 1 推荐) + 灵爆(Slot 3 推荐)
  fixedFirstHandIds: ['dao_gather', 'dao_burst'],
  midStageChoices: [
    {
      configId: 'dao_chain',
      name: '分光道韵',
      recommendedSlot: 0,
      recommendedSlotName: '第一眼 · 入气',
      advice: '建议放置在第一眼，能量一入阵即分光为两束。',
    },
    {
      configId: 'dao_crit',
      name: '锋芒道韵',
      recommendedSlot: 2,
      recommendedSlotName: '第三眼',
      advice: '建议放置在第三眼，承接聚灵增幅后叠加倍率暴击。',
    },
  ],
  midStageBonusCardId: 'dao_gather',
  zenithBonusCardId: 'dao_sword',
  fixedTribulationId: 'trib_cloud', // 玄黄祥云劫（前两次免费）
  timings: {
    pulseStart: 250,
    stepMove: 200,
    amplify: 220,
    releaseBurst: 400,
    releaseInterval: 140,
    normalTurnBudgetMax: 3200,
    minorBreakthrough: 800,
    reducedMotionNormalMax: 1200,
    reducedMotionFinale: 800,
    finale: {
      converge: 700,
      meridian: 800,
      breakCocoon: 800,
      shockwave: 900,
      complete: 1300,
    },
  },
};

/** 会话状态跟踪：会话内首次通关前为教学流程，通关后开启随机天劫 */
class DemoSessionState {
  private hasClearedOnce: boolean = false;

  public get isFirstClearCompleted(): boolean {
    return this.hasClearedOnce;
  }

  public markCleared(): void {
    this.hasClearedOnce = true;
  }

  public resetForTest(): void {
    this.hasClearedOnce = false;
  }
}

export const demoSession = new DemoSessionState();

/** 轻量数据记录埋点事件类型 */
export type DemoAnalyticsEvent =
  | 'demo_open'
  | 'first_card_placed'
  | 'first_run'
  | 'first_release'
  | 'stage_clear'
  | 'run_end'
  | 'restart';

export interface AnalyticsRecord {
  event: DemoAnalyticsEvent;
  timestamp: number;
  runId: string;
  stage?: string;
  turnIndex?: number;
  tribulationId?: string;
  stageThreshold?: number;
  effectiveCost?: number;
  qiGenerated?: number;
  boardSlots?: (string | null)[];
  branchChoice?: string;
  boardModified?: boolean;
  highestQi?: number;
  endType?: 'VICTORY' | 'GAMEOVER' | 'RESTART';
  watchedRelease?: boolean;
  skipped?: boolean;
  detail?: string;
}

class DemoAnalytics {
  private runId: string = Math.random().toString(36).substring(2, 9);
  private records: AnalyticsRecord[] = [];

  public get currentRunId(): string {
    return this.runId;
  }

  track(event: DemoAnalyticsEvent, payload: Partial<AnalyticsRecord> = {}): void {
    const record: AnalyticsRecord = {
      event,
      timestamp: Date.now(),
      runId: this.runId,
      ...payload,
    };
    this.records.push(record);
    try {
      const stored = JSON.parse(localStorage.getItem('zt_demo_analytics') || '[]');
      stored.push(record);
      // 最多缓存 300 条
      if (stored.length > 300) stored.shift();
      localStorage.setItem('zt_demo_analytics', JSON.stringify(stored));
    } catch {
      // 忽略存储异常
    }
  }

  newRun(isRestartExplicit = true): void {
    if (isRestartExplicit) {
      this.track('restart', { endType: 'RESTART', detail: '主动重修一局' });
    }
    this.runId = Math.random().toString(36).substring(2, 9);
  }

  dump(): AnalyticsRecord[] {
    return [...this.records];
  }

  exportJson(): string {
    return JSON.stringify(this.records, null, 2);
  }
}

export const demoAnalytics = new DemoAnalytics();
