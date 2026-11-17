import { describe, expect, it } from 'vitest';
import { createDao, getStageConfig } from '../src/config';
import { createInitialGameState, executeTurn, placeDao } from '../src/game';

describe('游戏状态流转与关卡推进测试 (Game State & Loop)', () => {
  it('开局初始状态：气池 100，手牌 6 张且必含至少 1 张灵爆术', () => {
    const state = createInitialGameState();
    expect(state.currentQi).toBe(100);
    expect(state.realm).toBe(1);
    expect(state.subStage).toBe(1);
    expect(state.board[0].unlocked).toBe(true);
    expect(state.board[1].unlocked).toBe(false);
    expect(state.hand.length).toBe(6);
    expect(state.hand.some((c) => c.configId === 'dao_burst')).toBe(true);
    expect(state.isGameOver).toBe(false);
    expect(state.isVictory).toBe(false);
  });

  it('耗气不足导致走火入魔 (Game Over)', () => {
    const state = createInitialGameState();
    state.currentQi = 5; // 关卡 1-1 第 1 次运转需要 10 气，气不足
    state.nextQiCost = 10;

    const res = executeTurn(state);
    expect(res.isGameOver).toBe(true);
    expect(state.isGameOver).toBe(true);
    expect(res.charged).toBe(0);
  });

  it('单次产气未达阈值时继续扣费递增，不推进关卡', () => {
    const state = createInitialGameState();
    // 关卡 1-1 阈值是 30，放一个产出 12 气的灵爆术在 Slot 0
    const burstCard = state.hand.find((c) => c.configId === 'dao_burst')!;
    placeDao(state, burstCard.uid, 0, 0);

    // 第 1 次运转：扣费 10，产气 12，最终气池 100 - 10 + 12 = 102
    const res1 = executeTurn(state);
    expect(res1.cleared).toBe(false);
    expect(res1.charged).toBe(10);
    expect(state.currentQi).toBe(102);
    expect(state.turnCountInStage).toBe(1);
    // 第 2 次运转费用：10 * 2^1.6 ≈ 30
    expect(state.nextQiCost).toBe(30);
    expect(state.subStage).toBe(1);
  });

  it('单次产气达到破障阈值时破关：发放战利品并推进关卡', () => {
    const state = createInitialGameState();
    // 关卡 1-1 阈值是 30
    // 我们布置一个能产气 31 的组合：Slot 0 升维道韵 (baseQi+15=25) -> 解锁 Ring 1 放灵爆术 (floor(25*1.25)=31)
    state.board[1].unlocked = true;
    state.board[0].slots[0] = createDao('dao_jump', 1, 'j1');
    state.board[1].slots[0] = createDao('dao_burst', 1, 'b1');

    const handBeforeCount = state.hand.length;
    const res = executeTurn(state);

    expect(res.cleared).toBe(true);
    expect(res.lootAwarded.length).toBeGreaterThanOrEqual(3);
    expect(state.hand.length).toBe(handBeforeCount + res.lootAwarded.length);
    // 小关推进到 1-2
    expect(state.subStage).toBe(2);
    expect(state.turnCountInStage).toBe(0);
    // 下一关 1-2 破障阈值 60，初始耗气 15
    const stage1_2 = getStageConfig(1, 2);
    expect(state.stageThreshold).toBe(stage1_2.threshold);
    expect(state.nextQiCost).toBe(stage1_2.baseCost);
  });

  it('通关 1-3 巅峰时突破大境界至筑基期并自动解锁 Ring 1', () => {
    const state = createInitialGameState();
    state.subStage = 3; // 处于 1-3 巅峰
    state.stageThreshold = 120;
    // 布置强力阵盘直接过关 (产气 200)
    state.board[0].slots[0] = createDao('dao_burst', 5, 'b_strong'); // LV5 灵爆术系数 2.25
    state.board[0].slots[0].level = 5;

    // 手动调整初始能量测试突破，或者用测试 mock
    // 这里放一个高倍率道韵
    const highDao = createDao('dao_burst', 1, 'b_test');
    state.board[0].slots[0] = highDao;
    // 直接让 baseQi 充裕
    state.board[0].slots[1] = createDao('dao_burst', 1, 'b_test2');

    // 我们放聚灵 LV5 (baseQi +100) + 灵爆 LV5 (系数 2.25) -> (10 + 100) * 2.25 = 247 >= 120
    state.board[0].slots[0] = createDao('dao_gather', 5, 'g_lv5');
    state.board[0].slots[1] = createDao('dao_burst', 5, 'b_lv5');

    const res = executeTurn(state);
    expect(res.cleared).toBe(true);
    expect(res.newRealmUnlocked).toBe(true);
    expect(state.realm).toBe(2);
    expect(state.subStage).toBe(1);
    expect(state.board[1].unlocked).toBe(true);
  });
});
