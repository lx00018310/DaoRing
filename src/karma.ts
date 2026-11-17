// ============================================================
// 局外轮回与功德天道系统 (Karma & Metagame)
// 负责：单局功德点结算、天赋升级与全局天赋增益提取
// ============================================================
import { getTalentConfig } from './config';
import type { GameState, KarmaProfile } from './types';

export interface TalentBonuses {
  initialQi: number;
  initialHand: number;
  freeFuelChance: number;
}

/** 提取玩家当前已解锁天赋的总增益 */
export function getAppliedTalentBonuses(unlockedTalents: Record<string, number> = {}): TalentBonuses {
  const bonuses: TalentBonuses = {
    initialQi: 0,
    initialHand: 0,
    freeFuelChance: 0,
  };

  for (const [talentId, level] of Object.entries(unlockedTalents)) {
    if (level <= 0) continue;
    const cfg = getTalentConfig(talentId);
    if (cfg.bonusPerLevel.initialQi) {
      bonuses.initialQi += cfg.bonusPerLevel.initialQi * level;
    }
    if (cfg.bonusPerLevel.initialHand) {
      bonuses.initialHand += cfg.bonusPerLevel.initialHand * level;
    }
    if (cfg.bonusPerLevel.freeFuelChance) {
      bonuses.freeFuelChance += cfg.bonusPerLevel.freeFuelChance * level;
    }
  }

  return bonuses;
}

/**
 * 单局结束功德结算
 * 公式：
 * 功德 = 通关小关数 × 5 + 累计产气 / 1000 + log10(单次最高产气)*10 + 合成次数 × 2 + 通关大胜奖励(100)
 */
export function calculateRunKarma(state: GameState): number {
  const stats = state.runStats;
  let karma = stats.stagesCleared * 5;

  karma += Math.floor(stats.totalQiGenerated / 1000);

  if (stats.highestSingleQi > 0) {
    karma += Math.floor(Math.log10(stats.highestSingleQi + 1) * 10);
  }

  karma += stats.daosFused * 2;

  if (state.isVictory) {
    karma += 100;
  }

  return Math.max(1, karma);
}

/** 结算并写入功德档案 */
export function settleRunKarma(
  state: GameState,
  profile: KarmaProfile,
): { karmaGained: number; updatedProfile: KarmaProfile } {
  const karmaGained = calculateRunKarma(state);
  const updatedProfile: KarmaProfile = {
    ...profile,
    totalKarma: profile.totalKarma + karmaGained,
    accumulatedKarma: profile.accumulatedKarma + karmaGained,
    historyHighQi: Math.max(profile.historyHighQi, state.runStats.highestSingleQi),
    totalRuns: profile.totalRuns + 1,
    victories: profile.victories + (state.isVictory ? 1 : 0),
  };
  return { karmaGained, updatedProfile };
}

/** 升级天赋 */
export function upgradeTalent(
  profile: KarmaProfile,
  talentId: string,
): { success: boolean; message: string; updatedProfile: KarmaProfile } {
  const cfg = getTalentConfig(talentId);
  const currentLevel = profile.unlockedTalents[talentId] ?? 0;

  if (currentLevel >= cfg.maxLevel) {
    return { success: false, message: `天赋【${cfg.name}】已达最高等级`, updatedProfile: profile };
  }

  const cost = cfg.costPerLevel[currentLevel];
  if (profile.totalKarma < cost) {
    return {
      success: false,
      message: `功德点不足，升级【${cfg.name}】需要 ${cost} 功德，当前仅有 ${profile.totalKarma}`,
      updatedProfile: profile,
    };
  }

  const updatedProfile: KarmaProfile = {
    ...profile,
    totalKarma: profile.totalKarma - cost,
    unlockedTalents: {
      ...profile.unlockedTalents,
      [talentId]: currentLevel + 1,
    },
  };

  return {
    success: true,
    message: `成功消耗 ${cost} 功德，将【${cfg.name}】提升至 LV${currentLevel + 1}`,
    updatedProfile,
  };
}
