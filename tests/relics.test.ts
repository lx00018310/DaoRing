import { describe, expect, it } from 'vitest';
import { createDao } from '../src/config';
import { simulateBoardTick } from '../src/engine';
import { createInitialBoard, createInitialGameState, equipRelic, executeTurn } from '../src/game';

describe('先天灵宝与心法被动测试 (Relics & Cultivation Passives)', () => {
  it('混沌青莲：初始最大步数 TTL 增加 2 点', () => {
    const board = createInitialBoard(1);
    // 空阵盘仿真，默认 TTL=12，装备混沌青莲后为 14
    const resNormal = simulateBoardTick(board);
    expect(resNormal.expiredCount).toBe(1);

    const resRelic = simulateBoardTick(board, Math.random, { relics: ['relic_lotus'] });
    expect(resRelic.expiredCount).toBe(1);
    // 检查日志中初始能量脉冲行数增加 2 步（TTL=12 为 11 步，TTL=14 为 13 步）
    const moveLogs = resRelic.logs.filter((l) => l.action === 'MOVE' || l.action === 'OUTER_LOOP');
    expect(moveLogs.length).toBe(13);
  });

  it('九转金丹：所有释放类道韵基础产气系数提升 25%', () => {
    const board = createInitialBoard(1);
    board[0].slots[0] = createDao('dao_burst', 1, 'b1'); // LV1 灵爆术基础系数 1.25

    // 未装配：10 * 1.0 * 1.25 = 12
    const res1 = simulateBoardTick(board);
    expect(res1.turnQiGenerated).toBe(12);

    // 装配九转金丹：系数 + 0.25 -> 1.50 -> 10 * 1.0 * 1.50 = 15
    const res2 = simulateBoardTick(board, Math.random, { relics: ['relic_elixir'] });
    expect(res2.turnQiGenerated).toBe(15);
  });

  it('五行转轮：每次自动升环使能量 baseQi 永久额外增加 10 点', () => {
    const board = createInitialBoard(2);
    // 在 Ring 1 Slot 1 放灵爆术，让 Ring 0 走满 4 步升环后触发
    board[1].slots[1] = createDao('dao_burst', 1, 'b1');

    const res = simulateBoardTick(board, Math.random, { relics: ['relic_five_elements'] });
    // 升环后 baseQi 从 10 变为 20
    // 产气: floor(20 * 1.0 * 1.25) = 25
    expect(res.turnQiGenerated).toBe(25);
  });

  it('太虚神行：升维道韵跃迁时必定克隆衍生能量', () => {
    const board = createInitialBoard(2);
    board[0].slots[0] = createDao('dao_jump', 1, 'j1');
    board[1].slots[0] = createDao('dao_burst', 1, 'b1');

    const res = simulateBoardTick(board, Math.random, { relics: ['relic_void_walk'] });
    // 应该触发太虚神行克隆
    expect(res.totalSpawned).toBeGreaterThanOrEqual(2);
    const cloneLog = res.logs.find((l) => l.action === 'RELIC_CLONE');
    expect(cloneLog).toBeDefined();
  });

  it('天道生机：走火入魔时免死 1 次并注入 30 点真气', () => {
    const state = createInitialGameState();
    equipRelic(state, 'relic_rebirth');
    state.currentQi = 5; // 不够扣费 10
    state.nextQiCost = 10;

    const res = executeTurn(state);
    expect(res.isGameOver).toBe(false);
    expect(state.isGameOver).toBe(false);
    expect(state.rebirthUsed).toBe(true);
    // 触发免死后注入 30 气，5 + 30 = 35，然后扣除 10 费 -> 结余 25
    expect(state.currentQi).toBeGreaterThanOrEqual(25);
  });
});
