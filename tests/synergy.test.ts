import { describe, expect, it } from 'vitest';
import { createDao } from '../src/config';
import { checkRingResonance, simulateBoardTick } from '../src/engine';
import { createInitialBoard } from '../src/game';

describe('阵盘灵脉与道法连携测试 (Resonance & Sequence Synergy)', () => {
  it('同环纯色共鸣检测：整环全为同一类别时激活共鸣', () => {
    const board = createInitialBoard(1);
    expect(checkRingResonance(board[0]).isMono).toBe(false);

    board[0].slots[0] = createDao('dao_gather', 1, 'g1');
    board[0].slots[1] = createDao('dao_crit', 1, 'c1');
    // 两个都是 AMPLIFY
    expect(checkRingResonance(board[0]).isMono).toBe(true);
    expect(checkRingResonance(board[0]).category).toBe('AMPLIFY');

    // 混入一个 RELEASE
    board[0].slots[2] = createDao('dao_burst', 1, 'b1');
    expect(checkRingResonance(board[0]).isMono).toBe(false);
  });

  it('同环纯色共鸣加成：聚灵道韵享有 1.25 倍增幅', () => {
    const board = createInitialBoard(1);
    // 放 2 个聚灵道韵 LV1 (baseQi +20)
    // 纯色共鸣下每次 + 20 * 1.25 = 25
    board[0].slots[0] = createDao('dao_gather', 1, 'g1');
    board[0].slots[1] = createDao('dao_gather', 1, 'g2');

    const res = simulateBoardTick(board);
    // 初始 10 -> Slot 0 变成 10 + 25 = 35 -> Slot 1 变成 35 + 25 = 60
    const logs = res.logs.filter((l) => l.action === 'AMPLIFY');
    expect(logs[0].detail).toContain('baseQi+25→35');
    expect(logs[1].detail).toContain('baseQi+25→60');
  });

  it('道法连携·极尽升华：增幅道韵紧随释放道韵，释放系数额外 +0.2', () => {
    const board = createInitialBoard(1);
    // Slot 0: 聚灵 (AMPLIFY, baseQi + 20)
    // Slot 1: 灵爆术 (RELEASE, LV1 系数 1.25)
    // 混杂了 AMPLIFY 和 RELEASE，不触发同环纯色共鸣
    board[0].slots[0] = createDao('dao_gather', 1, 'g1');
    board[0].slots[1] = createDao('dao_burst', 1, 'b1');

    const res = simulateBoardTick(board);
    // 检查是否有连携日志
    const synLog = res.logs.find((l) => l.action === 'SYNERGY' && l.detail.includes('极尽升华'));
    expect(synLog).toBeDefined();

    // 释放系数从 1.25 变成 1.45
    // baseQi = 10 + 20 = 30
    // multiplier = 1.0
    // 产气: floor(30 * 1.0 * 1.45) = 43
    expect(res.turnQiGenerated).toBe(43);
  });

  it('道法连携·聚气生锋：连续经过两个增幅道韵，倍率额外 +0.3', () => {
    const board = createInitialBoard(1);
    // Slot 0: 锋芒 (AMPLIFY, LV1 multiplier +0.5)
    // Slot 1: 锋芒 (AMPLIFY, LV1 multiplier +0.5)
    // Slot 2: 灵爆术 (RELEASE)
    board[0].slots[0] = createDao('dao_crit', 1, 'c1');
    board[0].slots[1] = createDao('dao_crit', 1, 'c2');
    board[0].slots[2] = createDao('dao_burst', 1, 'b1');

    // 确定性 rng 不暴击 (0.99)
    const res = simulateBoardTick(board, () => 0.99);

    const synLog = res.logs.find((l) => l.action === 'SYNERGY' && l.detail.includes('聚气生锋'));
    expect(synLog).toBeDefined();
  });
});
