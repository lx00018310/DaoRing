// ============================================================
// 斗法模式 · 对局会话（纯逻辑，可在 Node 中测试）
// 一切规则都委托给 game.ts / engine.ts：本文件只负责把「一场一场的斗法」
// 串起来 —— 运转、斩敌、灵宝三选一、炼化、身死道消判定与功德结算。
// ============================================================
import { createDao, getStageConfig } from '../config';
import { aggregateRelicModifiers } from '../engine';
import {
  createInitialGameState,
  equipRelic,
  executeTurn,
  fuseThreeDaos,
  generateUid,
  getEffectiveQiCost,
  refineDaoWithCatalyst,
  type CraftResult,
  type TurnExecutionResult,
} from '../game';
import { settleRunKarma } from '../karma';
import { loadKarmaProfile, saveKarmaProfile } from '../storage';
import type { DaoRhyme, GameState, KarmaProfile, RelicConfig, StageConfig } from '../types';
import { BATTLE_CONFIG } from './battleConfig';
import { getFoeConfig, type FoeConfig } from './foes';
import { buildTimeline, type Timeline } from './timeline';

type Rng = () => number;

export interface StageSnapshot {
  realm: number;
  subStage: number;
  stageName: string;
  threshold: number;
  foe: FoeConfig;
}

export interface BattleTurn {
  result: TurnExecutionResult;
  timeline: Timeline;
  /** 本回合交战的关卡与敌人（结算前） */
  stage: StageSnapshot;
  /** 本回合是否触发了天道生机免死 */
  rebirthTriggered: boolean;
  /** 结算后已付不起下一次运转（且无免死），下一次运转必然走火入魔 */
  doomed: boolean;
}

export interface FusionOption {
  mode: 'fuse' | 'refine';
  configId: string;
  name: string;
  level: number;
  /** 主材（fuse 3 张；refine 2 张） */
  uids: string[];
  /** refine 时作为催化剂烧掉的牌 */
  catalyst?: DaoRhyme;
}

export interface KarmaSettlement {
  karmaGained: number;
  profile: KarmaProfile;
}

export class BattleSession {
  public state: GameState;
  public pendingRelics: RelicConfig[] = [];
  private readonly rng: Rng;
  private settlement: KarmaSettlement | null = null;
  private readonly persist: boolean;

  constructor(options: { rng?: Rng; talents?: Record<string, number>; persist?: boolean } = {}) {
    this.rng = options.rng ?? Math.random;
    this.persist = options.persist ?? false;
    this.state = createInitialGameState(this.rng, options.talents ?? {});
    if (BATTLE_CONFIG.guaranteeOpeningGather) ensureOpeningGather(this.state.hand);
  }

  /** 按本地功德档案中的天赋开局（浏览器内使用） */
  static fromSavedProfile(rng: Rng = Math.random): BattleSession {
    const profile = loadKarmaProfile();
    return new BattleSession({ rng, talents: profile.unlockedTalents, persist: true });
  }

  get stageConfig(): StageConfig {
    return getStageConfig(this.state.realm, this.state.subStage);
  }

  get foe(): FoeConfig {
    return getFoeConfig(this.state.realm, this.state.subStage);
  }

  get nextCost(): number {
    return getEffectiveQiCost(this.state);
  }

  get isOver(): boolean {
    return this.state.isGameOver || this.state.isVictory;
  }

  /** 天道生机是否仍可免死一次 */
  get rebirthAvailable(): boolean {
    return !!aggregateRelicModifiers(this.state.relics).hasRebirth && !this.state.rebirthUsed;
  }

  /** 已付不起下一次运转，且没有免死可用 */
  isDoomed(): boolean {
    if (this.isOver) return false;
    return this.state.currentQi < this.nextCost && !this.rebirthAvailable;
  }

  snapshot(): StageSnapshot {
    return {
      realm: this.state.realm,
      subStage: this.state.subStage,
      stageName: this.stageConfig.name,
      threshold: this.state.stageThreshold,
      foe: this.foe,
    };
  }

  /** 运转周天：完全由 executeTurn 结算，返回演出所需的时间轴 */
  runTurn(): BattleTurn | null {
    if (this.isOver || this.pendingRelics.length > 0) return null;
    const stage = this.snapshot();
    const rebirthBefore = this.state.rebirthUsed;
    const result = executeTurn(this.state, this.rng, { maxRealm: BATTLE_CONFIG.maxRealm });
    const timeline = buildTimeline(result.simulation.logs);
    if (result.relicChoices && result.relicChoices.length > 0) this.pendingRelics = result.relicChoices;
    return {
      result,
      timeline,
      stage,
      rebirthTriggered: !rebirthBefore && this.state.rebirthUsed,
      doomed: this.isDoomed(),
    };
  }

  chooseRelic(relicId: string): { success: boolean; message: string } {
    if (!this.pendingRelics.some((relic) => relic.id === relicId)) {
      return { success: false, message: '该灵宝不在本次三选一之列' };
    }
    const outcome = equipRelic(this.state, relicId);
    if (outcome.success) this.pendingRelics = [];
    return outcome;
  }

  skipRelic(): void {
    this.pendingRelics = [];
  }

  /** 手牌中可炼化的组合：同名同级 3 张三合一；2 张时用另一张最低级的牌作催化剂 */
  fusionOptions(): FusionOption[] {
    const groups = new Map<string, DaoRhyme[]>();
    for (const card of this.state.hand) {
      if (card.level >= 5) continue;
      const key = `${card.configId}@${card.level}`;
      groups.set(key, [...(groups.get(key) ?? []), card]);
    }
    const options: FusionOption[] = [];
    for (const cards of groups.values()) {
      const head = cards[0];
      if (cards.length >= 3) {
        options.push({ mode: 'fuse', configId: head.configId, name: head.name, level: head.level, uids: cards.slice(0, 3).map((c) => c.uid) });
      } else if (cards.length === 2) {
        const catalyst = this.state.hand
          .filter((c) => !cards.includes(c))
          .sort((a, b) => a.level - b.level)[0];
        if (catalyst) {
          options.push({ mode: 'refine', configId: head.configId, name: head.name, level: head.level, uids: cards.map((c) => c.uid), catalyst });
        }
      }
    }
    return options.sort((a, b) => (a.mode === b.mode ? b.level - a.level : a.mode === 'fuse' ? -1 : 1));
  }

  applyFusion(option: FusionOption): CraftResult {
    if (option.mode === 'fuse') {
      const [a, b, c] = option.uids;
      return fuseThreeDaos(this.state, a, b, c);
    }
    if (!option.catalyst) return { success: false, message: '缺少催化剂' };
    const [a, b] = option.uids;
    return refineDaoWithCatalyst(this.state, a, b, option.catalyst.uid);
  }

  /** 单局结束时结算功德（幂等），浏览器内会写入本地档案 */
  settleKarma(profile: KarmaProfile = loadKarmaProfile()): KarmaSettlement | null {
    if (!this.isOver) return null;
    if (this.settlement) return this.settlement;
    const { karmaGained, updatedProfile } = settleRunKarma(this.state, profile);
    if (this.persist) saveKarmaProfile(updatedProfile);
    this.settlement = { karmaGained, profile: updatedProfile };
    return this.settlement;
  }
}

/** 开局保底：既无聚灵也无升维时，把一张非灵爆的牌换成 LV1 聚灵 */
export function ensureOpeningGather(hand: DaoRhyme[]): void {
  if (hand.some((card) => card.configId === 'dao_gather' || card.configId === 'dao_jump')) return;
  const idx = hand.findIndex((card) => card.configId !== 'dao_burst');
  const gather = createDao('dao_gather', 1, generateUid('battle_open'));
  if (idx >= 0) hand[idx] = gather;
  else hand.push(gather);
}
