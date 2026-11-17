import { describe, expect, it } from 'vitest';
import { createDao, getTribulationConfig } from '../src/config';
import { createInitialGameState, executeTurn } from '../src/game';

describe('天劫异象与突破词缀测试 (Tribulations & Modifiers)', () => {
  it('九霄神雷劫：破关战利品翻倍且耗气指数提升', () => {
    const state = createInitialGameState();
    state.subStage = 3;
    state.activeTribulation = getTribulationConfig('trib_thunder');

    // 强力阵盘秒过关
    state.board[0].slots[0] = createDao('dao_gather', 5, 'g1');
    state.board[0].slots[1] = createDao('dao_burst', 5, 'b1');

    const res = executeTurn(state);
    expect(res.cleared).toBe(true);
    // 战利品基础 3~5 张，翻倍后应 >= 6 张
    expect(res.lootAwarded.length).toBeGreaterThanOrEqual(6);
  });

  it('玄黄祥云劫：前 2 次运转免收真气费用', () => {
    const state = createInitialGameState();
    state.subStage = 3;
    const trib = getTribulationConfig('trib_cloud');
    state.activeTribulation = trib;
    state.freeTurnsLeft = trib.modifiers.freeTurnsCount ?? 2;

    const initialQi = state.currentQi;

    // 第一次运转
    const res1 = executeTurn(state);
    expect(res1.charged).toBe(0);
    expect(state.currentQi).toBeGreaterThanOrEqual(initialQi);
    expect(state.freeTurnsLeft).toBe(1);

    // 第二次运转
    const res2 = executeTurn(state);
    expect(res2.charged).toBe(0);
    expect(state.freeTurnsLeft).toBe(0);
  });

  it('九幽心魔劫：初始 TTL 减 4，但释放系数大幅提升', () => {
    const state = createInitialGameState();
    state.subStage = 3;
    state.activeTribulation = getTribulationConfig('trib_demon');

    // 放灵爆术 LV1 基础 1.25 -> 九幽心魔提升 100% (系数 * 2.0 = 2.5)
    // 10 * 1.0 * 2.5 = 25
    state.board[0].slots[0] = createDao('dao_burst', 1, 'b1');

    const res = executeTurn(state);
    expect(res.simulation.turnQiGenerated).toBe(25);
  });
});
