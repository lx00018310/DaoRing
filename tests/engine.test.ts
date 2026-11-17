import { describe, expect, it } from 'vitest';
import { createDao } from '../src/config';
import { simulateBoardTick } from '../src/engine';
import { createInitialBoard } from '../src/game';

describe('运转仿真引擎测试 (Tick Simulation Engine)', () => {
  it('TTL 耗尽消散：空阵盘上移动 12 步后能量消散，产气为 0', () => {
    // 只有 Ring 0 解锁（4 槽），空阵盘
    const board = createInitialBoard(1);
    const result = simulateBoardTick(board);

    expect(result.turnQiGenerated).toBe(0);
    expect(result.releasedCount).toBe(0);
    expect(result.expiredCount).toBe(1);

    // 检查日志是否记录 EXPIRE
    const expireLog = result.logs.find((l) => l.action === 'EXPIRE');
    expect(expireLog).toBeDefined();
    expect(expireLog?.detail).toContain('步数耗尽消散');
  });

  it('满圈自动升环：当解锁 2 环时，Ring 0 走满 4 步后自动升至 Ring 1', () => {
    // 解锁 Ring 0 (4 槽) 和 Ring 1 (6 槽)
    const board = createInitialBoard(2);
    // 在 Ring 1 的 Slot 1 放置一个灵爆术，让升环后的能量触发
    board[1].slots[1] = createDao('dao_burst', 1, 'burst_r1s1');

    const result = simulateBoardTick(board);

    // 检查是否有 AUTO_ASCEND 日志
    const ascendLog = result.logs.find((l) => l.action === 'AUTO_ASCEND');
    expect(ascendLog).toBeDefined();
    expect(ascendLog?.ringIdx).toBe(1);

    // 检查是否在 Ring 1 被释放产气
    expect(result.releasedCount).toBe(1);
    expect(result.turnQiGenerated).toBeGreaterThan(0);
  });

  it('灵爆术（释放）：在 Slot 0 直接触发终结并产气', () => {
    const board = createInitialBoard(1);
    // 初始能量 P0 进入 Ring 0 Slot 0，放入 LV1 灵爆术 (系数 1.25)
    board[0].slots[0] = createDao('dao_burst', 1, 'burst_lv1');

    const result = simulateBoardTick(board);
    // 初始 baseQi = 10, multiplier = 1.0, releaseFactor = 1.25 -> 10 * 1.0 * 1.25 = 12 (floor)
    expect(result.turnQiGenerated).toBe(12);
    expect(result.releasedCount).toBe(1);
    expect(result.expiredCount).toBe(0);
  });

  it('万剑诀（释放）：剩余 TTL 提供额外加成', () => {
    const board = createInitialBoard(1);
    // LV1 万剑诀: 基础 0.8, 每点剩余 TTL +15% (0.15)
    board[0].slots[0] = createDao('dao_sword', 1, 'sword_lv1');

    const result = simulateBoardTick(board);
    // 在 Slot 0 触发释放，此时 TTL 仍为初始 12 点
    // factor = 0.8 * (1 + 0.15 * 12) = 0.8 * 2.8 = 2.24
    // 产气 = floor(10 * 1.0 * 2.24) = 22
    expect(result.turnQiGenerated).toBe(22);
    expect(result.releasedCount).toBe(1);
  });

  it('升维道韵：直接向外环跃迁且本次移动不消耗 TTL', () => {
    const board = createInitialBoard(2);
    // Ring 0 Slot 0 放升维道韵 LV1 (baseQi +15, 强制跃迁到 Ring 1)
    board[0].slots[0] = createDao('dao_jump', 1, 'jump_lv1');
    // Ring 1 对应槽位 (0*6/4 = 0) 放灵爆术 LV1
    board[1].slots[0] = createDao('dao_burst', 1, 'burst_lv1');

    const result = simulateBoardTick(board);

    // 验证跃迁日志
    const jumpLog = result.logs.find((l) => l.action === 'FORCE_JUMP');
    expect(jumpLog).toBeDefined();
    expect(jumpLog?.detail).toContain('免TTL');

    // baseQi = 10 + 15 = 25, multiplier = 1.0, 灵爆 LV1 系数 1.25 -> floor(25 * 1.0 * 1.25) = 31
    expect(result.turnQiGenerated).toBe(31);
  });

  it('聚灵与锋芒增幅：baseQi 与 multiplier 累加生效（含道法连携）', () => {
    const board = createInitialBoard(1);
    // Slot 0: 聚灵道韵 LV1 (baseQi +20)
    board[0].slots[0] = createDao('dao_gather', 1, 'gather_lv1');
    // Slot 1: 锋芒道韵 LV1 (multiplier +0.5，触发聚气生锋连携 multiplier +0.3)
    board[0].slots[1] = createDao('dao_crit', 1, 'crit_lv1');
    // Slot 2: 灵爆术 LV1 (系数 1.25，触发极尽升华连携系数 +0.2 -> 1.45)
    board[0].slots[2] = createDao('dao_burst', 1, 'burst_lv1');

    // 传入确定性 rng (不触发暴击: rng 返回 0.99 > 0.10)
    const result = simulateBoardTick(board, () => 0.99);

    // 基础 baseQi: 10 + 20 = 30
    // 倍率 multiplier: 1.0 + 0.3(连携) + 0.5 = 1.8
    // 释放系数: 1.25 + 0.2(连携) = 1.45
    // 释放产气: floor(30 * 1.8 * 1.45) = 78
    expect(result.turnQiGenerated).toBe(78);
  });

  it('周天道韵：随升环次数提升倍率（含极尽升华连携）', () => {
    const board = createInitialBoard(2);
    // Slot 0: 升维道韵 LV1 (jumpCount 变为 1, baseQi + 15 -> 25)
    board[0].slots[0] = createDao('dao_jump', 1, 'jump_lv1');
    // 跃迁到 Ring 1 Slot 0 放周天道韵 LV1 (每个 jumpCount 增加 multiplier 0.4 -> 1.0 + 0.4 = 1.4)
    board[1].slots[0] = createDao('dao_resonance', 1, 'res_lv1');
    // Ring 1 Slot 1 放灵爆术 LV1 (增幅直入释放，触发极尽升华系数 +0.2 -> 1.45)
    board[1].slots[1] = createDao('dao_burst', 1, 'burst_lv1');

    const result = simulateBoardTick(board);
    // baseQi = 25
    // multiplier = 1.4
    // 灵爆 LV1 连携系数 = 1.25 + 0.2 = 1.45
    // 产出: floor(25 * 1.4 * 1.45) = 50
    expect(result.turnQiGenerated).toBe(50);
  });

  it('分光道韵：能量经过必定分裂出新能量', () => {
    const board = createInitialBoard(1);
    // Slot 0 放分光道韵 LV1 (保证分裂 1 股)
    board[0].slots[0] = createDao('dao_chain', 1, 'chain_lv1');
    // Slot 1 放灵爆术 LV1，两股能量都会撞到释放
    board[0].slots[1] = createDao('dao_burst', 1, 'burst_lv1');

    // mock rng 不触发额外分裂 (0.99 > 0.10)
    const result = simulateBoardTick(board, () => 0.99);

    // 母能量与分裂出的子能量都经过 Slot 1 释放
    expect(result.releasedCount).toBe(2);
    expect(result.totalSpawned).toBe(2);
  });
});
