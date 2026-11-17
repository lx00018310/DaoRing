import { describe, expect, it } from 'vitest';
import { createInitialGameState, placeDao } from '../src/game';
import { calculateRunKarma, getAppliedTalentBonuses, settleRunKarma, upgradeTalent } from '../src/karma';
import { createDefaultKarmaProfile, loadGameSession, saveGameSession } from '../src/storage';

describe('局外轮回与功德天道测试 (Karma & Persistence)', () => {
  it('功德结算公式：通关数、产气量与合成次数准确折算', () => {
    const state = createInitialGameState();
    state.runStats.stagesCleared = 3; // 3 * 5 = 15
    state.runStats.totalQiGenerated = 2500; // 2500 / 1000 = 2
    state.runStats.highestSingleQi = 999; // log10(1000) * 10 = 30
    state.runStats.daosFused = 2; // 2 * 2 = 4
    state.isVictory = false;

    // 15 + 2 + 30 + 4 = 51
    const karma = calculateRunKarma(state);
    expect(karma).toBe(51);

    const profile = createDefaultKarmaProfile();
    const { karmaGained, updatedProfile } = settleRunKarma(state, profile);
    expect(karmaGained).toBe(51);
    expect(updatedProfile.totalKarma).toBe(51);
    expect(updatedProfile.accumulatedKarma).toBe(51);
    expect(updatedProfile.historyHighQi).toBe(999);
    expect(updatedProfile.totalRuns).toBe(1);
  });

  it('天赋升级：功德扣除、等级递增与上限保护', () => {
    let profile = createDefaultKarmaProfile();
    profile.totalKarma = 15; // 升级 talent_qi_foundation LV1 需 10 点

    const res1 = upgradeTalent(profile, 'talent_qi_foundation');
    expect(res1.success).toBe(true);
    expect(res1.updatedProfile.totalKarma).toBe(5);
    expect(res1.updatedProfile.unlockedTalents['talent_qi_foundation']).toBe(1);

    // 余额不足升 LV2 (需 25 点)
    const res2 = upgradeTalent(res1.updatedProfile, 'talent_qi_foundation');
    expect(res2.success).toBe(false);
    expect(res2.message).toContain('功德点不足');
  });

  it('天赋增益：加持开局初始真气与手牌上限', () => {
    const talents = {
      talent_qi_foundation: 2, // 2 * 25 = 50
      talent_hand_capacity: 1, // 1 * 1 = 1
    };

    const bonuses = getAppliedTalentBonuses(talents);
    expect(bonuses.initialQi).toBe(50);
    expect(bonuses.initialHand).toBe(1);

    // 注入开局状态
    const state = createInitialGameState(Math.random, talents);
    // 基础 100 + 50 = 150
    expect(state.currentQi).toBe(150);
    // 基础 6 + 1 = 7 张手牌
    expect(state.hand.length).toBe(7);
  });

  it('天赋【炉火纯青】：覆盖槽位时免除燃料手牌消耗', () => {
    const talents = {
      talent_free_fuel: 1, // 触发免除燃料
    };
    const state = createInitialGameState(Math.random, talents);

    const c1 = state.hand[0];
    const c2 = state.hand[1];
    placeDao(state, c1.uid, 0, 0);

    const handBefore = state.hand.length;
    // mock rng 恒为 0，必然 < 0.20 触发免燃料
    const res = placeDao(state, c2.uid, 0, 0, undefined, () => 0.01);
    expect(res.success).toBe(true);
    expect(res.fuelWaived).toBe(true);
    // 仅消耗了 c2，未消耗额外燃料手牌
    expect(state.hand.length).toBe(handBefore - 1);
  });

  it('本地持久化存取：能够正常保存与恢复局内会话', () => {
    const state = createInitialGameState();
    state.currentQi = 888;
    saveGameSession(state);

    const loaded = loadGameSession();
    expect(loaded).not.toBeNull();
    expect(loaded?.currentQi).toBe(888);
  });
});
