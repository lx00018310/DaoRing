import { describe, expect, it } from 'vitest';
import { createDao } from '../src/config';
import { createInitialGameState, fuseThreeDaos, refineDaoWithCatalyst } from '../src/game';

describe('道韵合成与精炼系统测试 (Crafting & Refinement)', () => {
  it('同道三合一：消耗 3 张同名同级卡，合成 1 张升阶卡', () => {
    const state = createInitialGameState();
    const c1 = createDao('dao_chain', 1, 'c1');
    const c2 = createDao('dao_chain', 1, 'c2');
    const c3 = createDao('dao_chain', 1, 'c3');
    state.hand = [c1, c2, c3];

    const res = fuseThreeDaos(state, 'c1', 'c2', 'c3');
    expect(res.success).toBe(true);
    expect(state.hand.length).toBe(1);
    expect(state.hand[0].configId).toBe('dao_chain');
    expect(state.hand[0].level).toBe(2);
    expect(state.runStats.daosFused).toBe(1);
  });

  it('三合一校验：不同模板、不同等级或 LV5 满级时拒绝', () => {
    const state = createInitialGameState();
    const c1 = createDao('dao_chain', 1, 'c1');
    const c2 = createDao('dao_gather', 1, 'c2');
    const c3 = createDao('dao_chain', 1, 'c3');
    state.hand = [c1, c2, c3];

    // 模板不同
    const resDiff = fuseThreeDaos(state, 'c1', 'c2', 'c3');
    expect(resDiff.success).toBe(false);

    // 等级不同
    state.hand = [
      createDao('dao_chain', 1, 'c1'),
      createDao('dao_chain', 2, 'c2'),
      createDao('dao_chain', 1, 'c3'),
    ];
    const resLevel = fuseThreeDaos(state, 'c1', 'c2', 'c3');
    expect(resLevel.success).toBe(false);

    // LV5 满级
    state.hand = [
      createDao('dao_chain', 5, 'c1'),
      createDao('dao_chain', 5, 'c2'),
      createDao('dao_chain', 5, 'c3'),
    ];
    const resMax = fuseThreeDaos(state, 'c1', 'c2', 'c3');
    expect(resMax.success).toBe(false);
    expect(resMax.message).toContain('最高等级');
  });

  it('催化精炼：2 张同名同级卡 + 1 张任意催化卡，升阶成功', () => {
    const state = createInitialGameState();
    const c1 = createDao('dao_burst', 2, 'b1');
    const c2 = createDao('dao_burst', 2, 'b2');
    const catalyst = createDao('dao_gather', 1, 'cat1');
    state.hand = [c1, c2, catalyst];

    const res = refineDaoWithCatalyst(state, 'b1', 'b2', 'cat1');
    expect(res.success).toBe(true);
    expect(state.hand.length).toBe(1);
    expect(state.hand[0].configId).toBe('dao_burst');
    expect(state.hand[0].level).toBe(3);
    expect(state.runStats.daosFused).toBe(1);
  });
});
