// ============================================================
// 《周天破境录》核心数据结构
// 严格遵循方案文档第 2 节 TypeScript Schema，
// 并包含肉鸽机制深化（合成、灵宝、天劫、共鸣连携、局外功德）所需类型定义。
// ============================================================

/** 道韵类别：传导 | 增幅 | 释放 */
export type DaoCategory = 'CONDUCT' | 'AMPLIFY' | 'RELEASE';

/** 效果种类（由配置 effect 字段驱动，引擎按此分派） */
export type EffectKind =
  | 'CHAIN_SPLIT'
  | 'FORCE_JUMP'
  | 'REVERSE_FLOW'
  | 'GATHER'
  | 'CRIT'
  | 'RESONANCE'
  | 'RELEASE_BURST'
  | 'RELEASE_SWORD';

/** 道韵静态配置与实例（文档定义接口） */
export interface DaoRhyme {
  uid: string;          // 实例唯一ID
  configId: string;     // 模板ID，如 "dao_chain"
  name: string;         // 名称，如 "分光道韵"
  category: DaoCategory;
  level: number;        // 等级 1 ~ 5
  description: string;
}

/** 能量束对象（在阵盘上移动的实体） */
export interface EnergyPulse {
  id: string;
  baseQi: number;               // 基础气值 (Chips)，初始默认 10
  multiplier: number;           // 道法倍率 (Mult)，初始默认 1.0
  ringIdx: number;              // 当前所在环 (0 ~ 4)
  slotIdx: number;              // 当前所在槽位
  ttl: number;                  // 剩余步数寿命，初始默认 12
  stepsInCurrentRing: number;   // 在当前环已移动的步数
  jumpCount: number;            // 累计升环次数
  reverseCount: number;         // 逆流已触发次数，防死循环（上限由配置给出）
  lastCategory?: DaoCategory;   // 上一个触发的道韵类型（用于道法连携计算）
}

/** 阵盘单环结构 */
export interface RingTrack {
  ringIdx: number;
  maxSlots: number;             // Ring 0..4 分别为 4, 6, 8, 10, 12
  unlocked: boolean;
  slots: (DaoRhyme | null)[];
}

/** 单局运行统计数据（供功德结算） */
export interface RunStats {
  stagesCleared: number;        // 累计通关小关数
  totalQiGenerated: number;     // 累计产气总量
  highestSingleQi: number;      // 单次最高运转产气
  turnsPlayed: number;          // 累计运转轮次
  daosFused: number;            // 累计合成道韵次数
}

/** 游戏全局状态 */
export interface GameState {
  realm: number;                // 当前大境界 1(炼气) ~ 5(化神)
  subStage: number;             // 当前小关 1(初期), 2(中期), 3(巅峰)
  currentQi: number;            // 玩家当前累计的总气池
  turnCountInStage: number;     // 当前小关已运转次数 n
  nextQiCost: number;           // 下一次运转需要消耗的气
  stageThreshold: number;       // 当前小关单次攻击需要达到的破障阈值
  board: RingTrack[];           // 5层同心圆阵盘（跨局永久保留）
  hand: DaoRhyme[];             // 玩家当前持有的道韵手牌（放置 + 燃料）
  relics: string[];             // 已装配的先天灵宝/心法 ID 列表
  activeTribulation: TribulationConfig | null; // 当前关卡激活的天劫异象
  rebirthUsed: boolean;         // 天道生机（免死）是否已消耗
  freeTurnsLeft: number;        // 天劫赋予的免费运转次数
  runStats: RunStats;           // 单局运行统计数据
  appliedTalents: Record<string, number>; // 当前局生效的局外天赋等级
  isGameOver: boolean;
  isVictory: boolean;
}

// ============================================================
// 先天灵宝、天劫、天赋与功德类型定义
// ============================================================

export interface RelicModifiers {
  ttlBonus?: number;               // 初始最大 TTL 增量 (如混沌青莲 +2)
  initialQiPerTurnBonus?: number;  // 每关运转前获得真气补助
  releaseFactorBonus?: number;     // 所有释放类道韵系数提升 (如九转金丹 +0.25)
  freeCruiseChance?: number;       // 顺时针巡航时免扣 TTL 概率 (如天衍神算 0.20)
  ascendBaseQiBonus?: number;      // 每次升环能量获得 baseQi 奖励 (如五行转轮 +10)
  critChanceBonus?: number;        // 增幅道韵暴击概率额外提升 (如诛仙剑意 +0.15)
  critFactorBonus?: number;        // 增幅道韵暴击倍率提升 (如诛仙剑意 +0.5)
  jumpCloneChance?: number;        // 升维跃迁时克隆能量束概率 (如太虚神行 1.0)
  hasRebirth?: boolean;            // 走火入魔时免死一次保留 30 气 (天道生机)
}

export interface RelicConfig {
  id: string;
  name: string;
  description: string;
  modifiers: RelicModifiers;
}

export interface TribulationModifiers {
  costExponentOverride?: number;   // 耗气公式指数改写 (如 1.8)
  doubleLoot?: boolean;            // 战利品翻倍
  ttlPenalty?: number;             // 初始 TTL 扣减 (如 -4)
  releaseMultiplierBonus?: number; // 释放系数额外加成 (如 +1.0)
  freeTurnsCount?: number;         // 免费运转次数 (如 2)
}

export interface TribulationConfig {
  id: string;
  name: string;
  description: string;
  targetSubStage: number;          // 生效小关（通常为巅峰 3）
  modifiers: TribulationModifiers;
}

export interface KarmaTalentConfig {
  id: string;
  name: string;
  description: string;
  maxLevel: number;
  costPerLevel: number[];          // 升每级所需功德点
  bonusPerLevel: {
    initialQi?: number;            // 开局初始真气增量
    initialHand?: number;          // 开局初始手牌张数增量
    freeFuelChance?: number;       // 覆盖/移位免燃料概率
  };
}

export interface KarmaProfile {
  totalKarma: number;              // 剩余可用功德
  accumulatedKarma: number;        // 历史累计总功德
  unlockedTalents: Record<string, number>; // 天赋 ID -> 等级
  historyHighQi: number;           // 历史最高单次产气
  totalRuns: number;               // 累计总局数
  victories: number;               // 累计通关化神巅峰次数
}

// ============================================================
// 配置层基础类型
// ============================================================

export interface DaoLevelParams {
  guaranteedSplits?: number;
  extraSplitChance?: number;
  baseQiBonus?: number;
  reverseChance?: number;
  ttlRestore?: number;
  maxTriggers?: number;
  baseQiAdd?: number;
  multiplierAdd?: number;
  critChance?: number;
  critFactor?: number;
  multiplierPerJump?: number;
  releaseFactor?: number;
  ttlBonusFactor?: number;
}

export interface DaoLevelConfig {
  level: number;
  params: DaoLevelParams;
  description: string;
}

export interface DaoConfig {
  configId: string;
  name: string;
  category: DaoCategory;
  effect: EffectKind;
  levels: DaoLevelConfig[];
}

export interface StageConfig {
  realm: number;
  subStage: number;
  name: string;
  threshold: number;
  baseCost: number;
}

export interface BoardConfig {
  realmNames: string[];
  ringSlots: number[];
  initialQi: number;
  initialHandSize: number;
  initialTtl: number;
  initialBaseQi: number;
  initialMultiplier: number;
  maxPulses: number;
  maxTicksPerTurn: number;
  qiCostExponent: number;
  dropCountMin: number;
  dropCountMax: number;
  combineRequiredCount: number;    // 同道三合一所需数量 (3)
}

/** 运转仿真日志条目 */
export interface SimulationLogEntry {
  seq: number;
  pulseId: string;
  ringIdx: number;
  slotIdx: number;
  action: string;
  detail: string;
  qiDelta?: number;

  // V3 结构化字段供演出与分析回溯
  fromRing?: number;
  fromSlot?: number;
  toRing?: number;
  toSlot?: number;
  spawnedPulseIds?: string[];
  spawnedSlots?: number[];
  baseQiDelta?: number;
  multiplierDelta?: number;
  releaseFactorDelta?: number;
  ttlDelta?: number;
  critFactor?: number;
  isCrit?: boolean;
}

/** 回合执行前的快照上下文（防跨阶段污染、保持前态一致） */
export interface TurnContext {
  realm: number;
  subStage: number;
  turnIndex: number;
  stageName: string;
  stageThreshold: number;
  effectiveCost: number;
  qiBefore: number;
  activeTribulation: TribulationConfig | null;
}

/** 单次运转仿真结果 */
export interface SimulationResult {
  turnQiGenerated: number;
  logs: SimulationLogEntry[];
  totalSpawned: number;
  releasedCount: number;
  expiredCount: number;
}
