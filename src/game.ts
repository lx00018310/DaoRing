// ============================================================
// 游戏状态管理与经济层 (Game State & Economy)
// 包含：阵盘部署燃料扣费、道韵合成精炼、灵宝抽取装配、天劫异象流转与关卡推进
// ============================================================
import {
  ALL_DAO_IDS,
  ALL_RELIC_IDS,
  ALL_TRIBULATION_IDS,
  BOARD,
  calcQiCost,
  createDao,
  getRelicConfig,
  getStageConfig,
  getTribulationConfig,
} from './config';
import { DEMO_CONFIG, demoSession } from './demoConfig';
import { getEffectiveQiCost, runTurn } from './engine';
import { getAppliedTalentBonuses } from './karma';
import type {
  DaoRhyme,
  GameState,
  RelicConfig,
  RingTrack,
  RunStats,
  SimulationResult,
  TribulationConfig,
  TurnContext,
} from './types';

let nextUid = 1;
export function generateUid(prefix = 'dao'): string {
  return `${prefix}_${Date.now()}_${nextUid++}`;
}

type Rng = () => number;

export { getEffectiveQiCost };

/** 创建 5 层同心圆阵盘（跨局永久保留） */
export function createInitialBoard(unlockedCount = 1): RingTrack[] {
  return BOARD.ringSlots.map((maxSlots, ringIdx) => ({
    ringIdx,
    maxSlots,
    unlocked: ringIdx < unlockedCount,
    slots: Array.from({ length: maxSlots }, () => null),
  }));
}

/** 生成随机道韵战利品（等级对应当前大境界） */
export function generateRandomDao(realm: number, rng: Rng = Math.random): DaoRhyme {
  const configId = ALL_DAO_IDS[Math.floor(rng() * ALL_DAO_IDS.length)];
  return createDao(configId, realm, generateUid());
}

/** 生成战利品掉落（3~5 张，九霄神雷天劫下翻倍） */
export function generateLoot(
  realm: number,
  count?: number,
  rng: Rng = Math.random,
  isDouble = false,
): DaoRhyme[] {
  let num = count ?? Math.floor(rng() * (BOARD.dropCountMax - BOARD.dropCountMin + 1)) + BOARD.dropCountMin;
  if (isDouble) num *= 2;

  const loot: DaoRhyme[] = [];
  for (let i = 0; i < num; i += 1) {
    loot.push(generateRandomDao(realm, rng));
  }
  return loot;
}

/** 生成初始手牌（基础 6 张 LV1，受天赋增益加持，必含 1 张灵爆术） */
export function createInitialHand(extraCapacity = 0, rng: Rng = Math.random): DaoRhyme[] {
  const hand: DaoRhyme[] = [createDao('dao_burst', 1, generateUid())];
  const targetSize = BOARD.initialHandSize + extraCapacity;
  while (hand.length < targetSize) {
    hand.push(generateRandomDao(1, rng));
  }
  return hand;
}

/** 创建初始运行统计数据 */
export function createInitialRunStats(): RunStats {
  return {
    stagesCleared: 0,
    totalQiGenerated: 0,
    highestSingleQi: 0,
    turnsPlayed: 0,
    daosFused: 0,
  };
}

/** 初始化全局游戏状态（可传入局外天赋） */
export function createInitialGameState(
  rng: Rng = Math.random,
  talents: Record<string, number> = {},
): GameState {
  const realm = 1;
  const subStage = 1;
  const stageCfg = getStageConfig(realm, subStage);
  const bonuses = getAppliedTalentBonuses(talents);

  return {
    realm,
    subStage,
    currentQi: BOARD.initialQi + bonuses.initialQi,
    turnCountInStage: 0,
    nextQiCost: calcQiCost(stageCfg.baseCost, 1),
    stageThreshold: stageCfg.threshold,
    board: createInitialBoard(1),
    hand: createInitialHand(bonuses.initialHand, rng),
    relics: [],
    activeTribulation: null,
    rebirthUsed: false,
    freeTurnsLeft: 0,
    runStats: createInitialRunStats(),
    appliedTalents: talents,
    isGameOver: false,
    isVictory: false,
  };
}

// ------------------------------------------------------------
// 阵盘部署与燃料经济系统
// ------------------------------------------------------------

export interface PlacementResult {
  success: boolean;
  message: string;
  fuelWaived?: boolean; // 是否触发天赋免除燃料
}

/** 判定是否通过天赋免除燃料消耗 */
function checkFreeFuel(talents: Record<string, number>, rng: Rng): boolean {
  const bonuses = getAppliedTalentBonuses(talents);
  if (bonuses.freeFuelChance > 0 && rng() < bonuses.freeFuelChance) {
    return true;
  }
  return false;
}

/** 放置道韵到阵盘 */
export function placeDao(
  state: GameState,
  handCardUid: string,
  ringIdx: number,
  slotIdx: number,
  fuelCardUid?: string,
  rng: Rng = Math.random,
): PlacementResult {
  if (state.isGameOver || state.isVictory) {
    return { success: false, message: '游戏已结束，无法调整阵盘' };
  }

  // 参数合法性与整数校验
  if (!Number.isInteger(ringIdx) || ringIdx < 0 || ringIdx >= state.board.length) {
    return { success: false, message: '目标环索引不合法' };
  }
  const ring = state.board[ringIdx];
  if (!ring || !ring.unlocked) {
    return { success: false, message: '目标环未解锁或不存在' };
  }
  if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= ring.maxSlots) {
    return { success: false, message: '目标槽位超出该环上限或不合法' };
  }

  const cardIdx = state.hand.findIndex((c) => c.uid === handCardUid);
  if (cardIdx === -1) {
    return { success: false, message: '所选道韵卡不在手牌中' };
  }
  const targetCard = state.hand[cardIdx];
  const currentOccupant = ring.slots[slotIdx];

  if (currentOccupant === null) {
    // 空槽放置：只消耗待放置卡
    state.hand.splice(cardIdx, 1);
    ring.slots[slotIdx] = targetCard;
    return { success: true, message: `成功放置 ${targetCard.name} 到 Ring ${ringIdx} Slot ${slotIdx}` };
  }

  // 纯覆盖已有道韵
  const fuelWaived = checkFreeFuel(state.appliedTalents, rng);

  if (fuelWaived) {
    // 天赋免除燃料
    state.hand.splice(cardIdx, 1);
    const oldName = currentOccupant.name;
    ring.slots[slotIdx] = targetCard;
    return {
      success: true,
      message: `【炉火纯青】天赋触发！免去燃料消耗，成功用 ${targetCard.name} 覆盖旧道韵 ${oldName}`,
      fuelWaived: true,
    };
  }

  if (!fuelCardUid) {
    return { success: false, message: '覆盖已有道韵需额外提供一张手牌作为改阵燃料' };
  }
  if (fuelCardUid === handCardUid) {
    return { success: false, message: '燃料卡不能与被放置的道韵卡相同' };
  }

  const fuelIdx = state.hand.findIndex((c) => c.uid === fuelCardUid);
  if (fuelIdx === -1) {
    return { success: false, message: '所选燃料卡不在手牌中' };
  }

  const indices = [cardIdx, fuelIdx].sort((a, b) => b - a);
  for (const idx of indices) {
    state.hand.splice(idx, 1);
  }

  const oldName = currentOccupant.name;
  ring.slots[slotIdx] = targetCard;
  return {
    success: true,
    message: `消耗 1 张燃料卡，成功用 ${targetCard.name} 覆盖旧道韵 ${oldName}`,
    fuelWaived: false,
  };
}

/** 拆除阵盘上已布置的道韵 */
export function removeDao(
  state: GameState,
  ringIdx: number,
  slotIdx: number,
  fuelCardUid?: string,
  rng: Rng = Math.random,
): PlacementResult {
  if (state.isGameOver || state.isVictory) {
    return { success: false, message: '游戏已结束，无法调整阵盘' };
  }

  if (!Number.isInteger(ringIdx) || ringIdx < 0 || ringIdx >= state.board.length) {
    return { success: false, message: '目标环索引不合法' };
  }
  const ring = state.board[ringIdx];
  if (!ring || !ring.unlocked) {
    return { success: false, message: '目标环未解锁' };
  }
  if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= ring.maxSlots) {
    return { success: false, message: '目标槽位超出该环上限或不合法' };
  }
  if (!ring.slots[slotIdx]) {
    return { success: false, message: '目标槽位为空，无需拆除' };
  }

  const fuelWaived = checkFreeFuel(state.appliedTalents, rng);
  if (!fuelWaived) {
    if (!fuelCardUid) {
      return { success: false, message: '拆除道韵需消耗 1 张手牌作为改阵燃料' };
    }
    const fuelIdx = state.hand.findIndex((c) => c.uid === fuelCardUid);
    if (fuelIdx === -1) {
      return { success: false, message: '所选燃料卡不在手牌中' };
    }
    state.hand.splice(fuelIdx, 1);
  }

  const old = ring.slots[slotIdx]!;
  ring.slots[slotIdx] = null;
  return {
    success: true,
    message: fuelWaived ? `【炉火纯青】免燃料，已拆除 ${old.name}` : `消耗 1 张燃料卡，已拆除 ${old.name}`,
    fuelWaived,
  };
}

/** 移位阵盘上已布置的道韵 */
export function moveDao(
  state: GameState,
  fromRing: number,
  fromSlot: number,
  toRing: number,
  toSlot: number,
  fuelCardUid?: string,
  rng: Rng = Math.random,
): PlacementResult {
  if (state.isGameOver || state.isVictory) {
    return { success: false, message: '游戏已结束，无法调整阵盘' };
  }

  if (
    !Number.isInteger(fromRing) ||
    !Number.isInteger(toRing) ||
    fromRing < 0 ||
    fromRing >= state.board.length ||
    toRing < 0 ||
    toRing >= state.board.length
  ) {
    return { success: false, message: '源环或目标环索引不合法' };
  }

  const srcRing = state.board[fromRing];
  const dstRing = state.board[toRing];
  if (!srcRing || !srcRing.unlocked || !dstRing || !dstRing.unlocked) {
    return { success: false, message: '源环或目标环未解锁' };
  }
  if (!Number.isInteger(fromSlot) || fromSlot < 0 || fromSlot >= srcRing.maxSlots) {
    return { success: false, message: '源槽位索引不合法' };
  }
  if (!Number.isInteger(toSlot) || toSlot < 0 || toSlot >= dstRing.maxSlots) {
    return { success: false, message: '目标槽位索引不合法' };
  }

  if (!srcRing.slots[fromSlot]) {
    return { success: false, message: '源槽位没有道韵' };
  }
  if (dstRing.slots[toSlot] !== null) {
    return { success: false, message: '目标槽位已有道韵，无法直接移位（请使用覆盖）' };
  }

  // 校验目标环是否还有空槽（满盘检查）
  const hasEmptySlot = dstRing.slots.some((s) => s === null);
  if (!hasEmptySlot) {
    return { success: false, message: '目标环已满，无可用空槽可供移位' };
  }

  const fuelWaived = checkFreeFuel(state.appliedTalents, rng);
  if (!fuelWaived) {
    if (!fuelCardUid) {
      return { success: false, message: '移位道韵需消耗 1 张手牌作为改阵燃料' };
    }
    const fuelIdx = state.hand.findIndex((c) => c.uid === fuelCardUid);
    if (fuelIdx === -1) {
      return { success: false, message: '所选燃料卡不在手牌中' };
    }
    state.hand.splice(fuelIdx, 1);
  }

  const target = srcRing.slots[fromSlot];
  srcRing.slots[fromSlot] = null;
  dstRing.slots[toSlot] = target;

  return {
    success: true,
    message: fuelWaived
      ? `【炉火纯青】免燃料，已将 ${target!.name} 移位至 Ring ${toRing} Slot ${toSlot}`
      : `消耗 1 张燃料卡，已将 ${target!.name} 移位至 Ring ${toRing} Slot ${toSlot}`,
    fuelWaived,
  };
}

/**
 * V3 教学优化：判断阵眼上的道韵是否可在初期无损收回手牌
 * 规则：炼气初期（1-1）、未结束、属于两张开局牌（聚灵/灵爆）
 */
export function canRecallDao(state: GameState, ringIdx: number, slotIdx: number): boolean {
  if (state.isGameOver || state.isVictory) return false;
  if (state.realm !== 1 || state.subStage !== 1) return false;
  const ring = state.board[ringIdx];
  if (!ring || !ring.unlocked) return false;
  const node = ring.slots[slotIdx];
  if (!node) return false;
  // 属于初期开局的两张卡之一
  return node.configId === 'dao_gather' || node.configId === 'dao_burst';
}

/**
 * V3 教学优化：无燃料消耗将开局道韵收回手牌（仅初期生效）
 */
export function recallDao(state: GameState, ringIdx: number, slotIdx: number): PlacementResult {
  if (!canRecallDao(state, ringIdx, slotIdx)) {
    return { success: false, message: '当前条件不满足无损收回道韵规则' };
  }
  const ring = state.board[ringIdx];
  const target = ring.slots[slotIdx]!;
  ring.slots[slotIdx] = null;
  state.hand.push(target);
  return {
    success: true,
    message: `已无损收回【${target.name}】至手牌，可重新调整布阵。`,
    fuelWaived: true,
  };
}

// ------------------------------------------------------------
// 道韵合成与精炼系统 (Crafting & Refinement)
// ------------------------------------------------------------

export interface CraftResult {
  success: boolean;
  message: string;
  craftedCard?: DaoRhyme;
}

/**
 * 同道三合一 (Three-in-One Fusion)
 * 消耗手牌中 3 张相同 configId 且相同 level (< 5) 的道韵卡，合成 1 张 level + 1 的同名卡
 */
export function fuseThreeDaos(
  state: GameState,
  uid1: string,
  uid2: string,
  uid3: string,
): CraftResult {
  if (new Set([uid1, uid2, uid3]).size !== 3) {
    return { success: false, message: '合成需要 3 张互不相同的手牌' };
  }

  const cards = [
    state.hand.find((c) => c.uid === uid1),
    state.hand.find((c) => c.uid === uid2),
    state.hand.find((c) => c.uid === uid3),
  ];

  if (cards.some((c) => c === undefined)) {
    return { success: false, message: '待合成的道韵卡不在手牌中' };
  }

  const [c1, c2, c3] = cards as [DaoRhyme, DaoRhyme, DaoRhyme];
  if (c1.configId !== c2.configId || c2.configId !== c3.configId) {
    return { success: false, message: '同道三合一必须使用 3 张同名道韵卡' };
  }
  if (c1.level !== c2.level || c2.level !== c3.level) {
    return { success: false, message: '待合成的 3 张道韵卡等级必须相同' };
  }
  if (c1.level >= 5) {
    return { success: false, message: '该道韵已达最高等级 LV5，无法继续熔炼' };
  }

  const targetLevel = c1.level + 1;
  const targetConfigId = c1.configId;

  // 从手牌中剔除这 3 张卡
  const uidsToRemove = new Set([uid1, uid2, uid3]);
  state.hand = state.hand.filter((c) => !uidsToRemove.has(c.uid));

  // 生成新高阶卡
  const crafted = createDao(targetConfigId, targetLevel, generateUid());
  state.hand.push(crafted);
  state.runStats.daosFused += 1;

  return {
    success: true,
    message: `三元归一！成功将 3 张【${c1.name} LV${c1.level}】合成为【${crafted.name} LV${crafted.level}】！`,
    craftedCard: crafted,
  };
}

/**
 * 催化精炼 (Catalyzed Refine)
 * 消耗手牌中 2 张相同 configId 且相同 level (< 5) 的道韵卡 + 1 张任意其他手牌作为催化剂，合成 1 张 level + 1 的同名卡
 */
export function refineDaoWithCatalyst(
  state: GameState,
  uid1: string,
  uid2: string,
  catalystUid: string,
): CraftResult {
  if (new Set([uid1, uid2, catalystUid]).size !== 3) {
    return { success: false, message: '精炼需要 3 张互不相同的手牌' };
  }

  const c1 = state.hand.find((c) => c.uid === uid1);
  const c2 = state.hand.find((c) => c.uid === uid2);
  const catalyst = state.hand.find((c) => c.uid === catalystUid);

  if (!c1 || !c2 || !catalyst) {
    return { success: false, message: '指定的手牌不存在' };
  }

  if (c1.configId !== c2.configId) {
    return { success: false, message: '前两张道韵卡必须为同名道韵' };
  }
  if (c1.level !== c2.level) {
    return { success: false, message: '两张主道韵卡等级必须相同' };
  }
  if (c1.level >= 5) {
    return { success: false, message: '道韵已达最高等级 LV5，无法精炼' };
  }

  const targetLevel = c1.level + 1;
  const targetConfigId = c1.configId;

  const uidsToRemove = new Set([uid1, uid2, catalystUid]);
  state.hand = state.hand.filter((c) => !uidsToRemove.has(c.uid));

  const crafted = createDao(targetConfigId, targetLevel, generateUid());
  state.hand.push(crafted);
  state.runStats.daosFused += 1;

  return {
    success: true,
    message: `天地熔炉！消耗【${catalyst.name}】作催化剂，成功精炼出【${crafted.name} LV${crafted.level}】！`,
    craftedCard: crafted,
  };
}

// ------------------------------------------------------------
// 先天灵宝与天劫系统
// ------------------------------------------------------------

/** 随机抽取 3 个尚未获得的先天灵宝供玩家三选一 (Fisher-Yates 洗牌) */
export function drawRelicChoices(state: GameState, count = 3, rng: Rng = Math.random): RelicConfig[] {
  const available = ALL_RELIC_IDS.filter((id) => !state.relics.includes(id));
  if (available.length === 0) return [];

  const shuffled = [...available];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const temp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = temp;
  }
  const pickedIds = shuffled.slice(0, Math.min(count, shuffled.length));
  return pickedIds.map((id) => getRelicConfig(id));
}

/** 装配选中的先天灵宝 */
export function equipRelic(state: GameState, relicId: string): { success: boolean; message: string } {
  if (state.relics.includes(relicId)) {
    return { success: false, message: '该先天灵宝已装配' };
  }
  const cfg = getRelicConfig(relicId);
  state.relics.push(relicId);
  return { success: true, message: `已成功融合先天灵宝【${cfg.name}】！${cfg.description}` };
}

/** 检测并在巅峰小关降下天劫（支持指定天劫 ID，如教学玄黄祥云劫） */
export function checkAndApplyTribulation(
  state: GameState,
  rng: Rng = Math.random,
  fixedTribId?: string,
): TribulationConfig | null {
  if (state.subStage === 3 && state.activeTribulation === null) {
    const tribId = fixedTribId ?? ALL_TRIBULATION_IDS[Math.floor(rng() * ALL_TRIBULATION_IDS.length)];
    const trib = getTribulationConfig(tribId);
    state.activeTribulation = trib;
    if (trib.modifiers.freeTurnsCount) {
      state.freeTurnsLeft = trib.modifiers.freeTurnsCount;
    }
    return trib;
  }
  return null;
}

// ------------------------------------------------------------
// 关卡推进与完整运转包装
// ------------------------------------------------------------

export interface TurnExecutionResult {
  charged: number;
  simulation: SimulationResult;
  cleared: boolean;
  lootAwarded: DaoRhyme[];
  newRealmUnlocked: boolean;
  relicChoices?: RelicConfig[];
  tribulationEncountered?: TribulationConfig | null;
  isVictory: boolean;
  isGameOver: boolean;
  context: TurnContext;
}

/** 执行一次运转攻击，并自动处理天劫、破关、灵宝与战利品结算 */
export function executeTurn(
  state: GameState,
  rng: Rng = Math.random,
  options?: { maxRealm?: number; fixedTribulationId?: string; awardLoot?: boolean },
): TurnExecutionResult {
  // 防御性边界：已结束状态下调用保持绝对幂等
  if (state.isGameOver || state.isVictory) {
    const emptyContext: TurnContext = {
      realm: state.realm,
      subStage: state.subStage,
      turnIndex: state.turnCountInStage + 1,
      stageName: getStageConfig(state.realm, state.subStage).name,
      stageThreshold: state.stageThreshold,
      effectiveCost: 0,
      qiBefore: state.currentQi,
      activeTribulation: state.activeTribulation,
    };
    return {
      charged: 0,
      simulation: { turnQiGenerated: 0, logs: [], totalSpawned: 0, releasedCount: 0, expiredCount: 0 },
      cleared: false,
      lootAwarded: [],
      newRealmUnlocked: false,
      isVictory: state.isVictory,
      isGameOver: state.isGameOver,
      context: emptyContext,
    };
  }

  // 若处于巅峰关卡且尚未触发天劫，先行降下天劫
  checkAndApplyTribulation(state, rng, options?.fixedTribulationId);

  // 严格在状态修改前捕获本轮执行上下文（前态事实）
  const context: TurnContext = {
    realm: state.realm,
    subStage: state.subStage,
    turnIndex: state.turnCountInStage + 1,
    stageName: getStageConfig(state.realm, state.subStage).name,
    stageThreshold: state.stageThreshold,
    effectiveCost: getEffectiveQiCost(state),
    qiBefore: state.currentQi,
    activeTribulation: state.activeTribulation,
  };

  const { result, charged, cleared } = runTurn(state, rng);

  let lootAwarded: DaoRhyme[] = [];
  let newRealmUnlocked = false;
  let relicChoices: RelicConfig[] | undefined = undefined;
  let tribulationEncountered: TribulationConfig | null = null;

  if (cleared) {
    // 战利品发放（九霄神雷翻倍）
    if (options?.awardLoot !== false) {
      const isDouble = state.activeTribulation?.modifiers.doubleLoot ?? false;
      lootAwarded = generateLoot(state.realm, undefined, rng, isDouble);
      state.hand.push(...lootAwarded);
    }

    // 破关离开小关时清空当前天劫
    if (state.activeTribulation) {
      state.activeTribulation = null;
      state.freeTurnsLeft = 0;
    }

    // 关卡推进
    const maxRealm = options?.maxRealm ?? 5;
    if (state.subStage === 3) {
      if (state.realm >= maxRealm) {
        state.isVictory = true;
      } else {
        state.realm += 1;
        state.subStage = 1;
        // 解锁外环
        if (state.board[state.realm - 1]) {
          state.board[state.realm - 1].unlocked = true;
          newRealmUnlocked = true;
        }
        // 大境界突破：灵宝三选一
        relicChoices = drawRelicChoices(state, 3, rng);
      }
    } else {
      state.subStage += 1;
      // 若下一关是巅峰关，提前触发天劫
      tribulationEncountered = checkAndApplyTribulation(state, rng, options?.fixedTribulationId);
    }

    // 重置本关已运转次数与费用
    state.turnCountInStage = 0;
    if (!state.isVictory) {
      const nextCfg = getStageConfig(state.realm, state.subStage);
      state.stageThreshold = nextCfg.threshold;
      state.nextQiCost = calcQiCost(nextCfg.baseCost, 1);
    }
  }

  return {
    charged,
    simulation: result,
    cleared,
    lootAwarded,
    newRealmUnlocked,
    relicChoices,
    tribulationEncountered,
    isVictory: state.isVictory,
    isGameOver: state.isGameOver,
    context,
  };
}

/** 创建 Demo 初始手牌（V3 规则：1 张聚灵 + 1 张灵爆） */
export function createDemoInitialHand(): DaoRhyme[] {
  return DEMO_CONFIG.fixedFirstHandIds.map((id) => createDao(id, 1, generateUid('init_dao')));
}

/** 创建 Demo 初始状态（限制炼气期且提供 V3 固定开局两张手牌） */
export function createDemoInitialGameState(talents: Record<string, number> = {}): GameState {
  const s = createInitialGameState(Math.random, talents);
  s.hand = createDemoInitialHand();
  return s;
}

/** 执行 Demo 单轮回合（封顶炼气圆满，不跳转筑基；首局锁定祥云劫） */
export function executeDemoTurn(state: GameState, rng: Rng = Math.random): TurnExecutionResult {
  const fixedTribId = !demoSession.isFirstClearCompleted ? DEMO_CONFIG.fixedTribulationId : undefined;
  return executeTurn(state, rng, {
    maxRealm: DEMO_CONFIG.maxRealm,
    fixedTribulationId: fixedTribId,
    awardLoot: false,
  });
}
