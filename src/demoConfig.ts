// ============================================================
// 《周天破境录：炼气篇》Demo 专用配置与常量
// ============================================================

export interface DemoConfig {
  /** 仅展示的最大境界（1 = 炼气） */
  maxRealm: number;
  /** 首局固定发牌的道韵 configId 列表（保证真实规则下必然产生分裂、增幅与爆发） */
  fixedFirstHandIds: string[];
  /** 动画节拍时长配置 (毫秒) */
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
    /** prefers-reduced-motion 模式下的终局总时长 */
    reducedMotionFinale: number;
  };
}

export const DEMO_CONFIG: DemoConfig = {
  maxRealm: 1,
  // 教学手牌：分光(分裂) + 聚灵(基础气+20) + 锋芒(倍率+0.5) + 灵爆术(释放1.25)
  // 外加额外两张聚灵/锋芒，共 6 张
  fixedFirstHandIds: [
    'dao_chain',
    'dao_gather',
    'dao_crit',
    'dao_burst',
    'dao_gather',
    'dao_crit',
  ],
  timings: {
    pulseStart: 300,
    stepMove: 220,
    amplify: 260,
    releaseBurst: 450,
    releaseInterval: 180,
    finale: {
      converge: 700,
      meridian: 800,
      breakCocoon: 800,
      shockwave: 900,
      complete: 1300,
    },
    reducedMotionFinale: 800,
  },
};

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
  qiGenerated?: number;
  detail?: string;
}

class DemoAnalytics {
  private runId: string = Math.random().toString(36).substring(2, 9);
  private records: AnalyticsRecord[] = [];

  track(event: DemoAnalyticsEvent, payload: { stage?: string; qiGenerated?: number; detail?: string } = {}): void {
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
      // 最多缓存 200 条
      if (stored.length > 200) stored.shift();
      localStorage.setItem('zt_demo_analytics', JSON.stringify(stored));
    } catch {
      // 忽略存储异常
    }
  }

  newRun(): void {
    this.runId = Math.random().toString(36).substring(2, 9);
    this.track('restart');
  }

  dump(): AnalyticsRecord[] {
    return [...this.records];
  }
}

export const demoAnalytics = new DemoAnalytics();
