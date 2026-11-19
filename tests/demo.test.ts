import { describe, expect, it } from 'vitest';
import {
  createDemoInitialGameState,
  executeDemoTurn,
  placeDao,
} from '../src/game';

describe('炼气篇 Demo P0/P1 核心闭环测试', () => {
  it('炼气巅峰通关后应止步于炼气圆满（isVictory=true），绝不跳转筑基与解锁外环', () => {
    const state = createDemoInitialGameState();
    state.realm = 1;
    state.subStage = 3;
    state.stageThreshold = 120;
    state.currentQi = 999;

    // 在四个槽位布满强力道韵以确保通关
    // Slot 0: 分光, Slot 1: 聚灵, Slot 2: 锋芒, Slot 3: 灵爆
    placeDao(state, state.hand.find((c) => c.configId === 'dao_chain')!.uid, 0, 0);
    placeDao(state, state.hand.find((c) => c.configId === 'dao_gather')!.uid, 0, 1);
    placeDao(state, state.hand.find((c) => c.configId === 'dao_crit')!.uid, 0, 2);
    placeDao(state, state.hand.find((c) => c.configId === 'dao_burst')!.uid, 0, 3);

    const res = executeDemoTurn(state);

    expect(res.cleared).toBe(true);
    expect(res.isVictory).toBe(true);
    expect(state.isVictory).toBe(true);
    // 依然停留在炼气期
    expect(state.realm).toBe(1);
    // 筑基环（Ring 1）依然处于未解锁状态
    expect(state.board[1].unlocked).toBe(false);
    // 不会触发灵宝三选一
    expect(res.relicChoices).toBeUndefined();
  });

  it('首局固定示范开局在真实数值规则下必然产生分裂、增幅与释放', () => {
    const state = createDemoInitialGameState();
    // 初始手牌应当包含完整的四要素
    const cChain = state.hand.find((c) => c.configId === 'dao_chain');
    const cGather = state.hand.find((c) => c.configId === 'dao_gather');
    const cCrit = state.hand.find((c) => c.configId === 'dao_crit');
    const cBurst = state.hand.find((c) => c.configId === 'dao_burst');

    expect(cChain).toBeDefined();
    expect(cGather).toBeDefined();
    expect(cCrit).toBeDefined();
    expect(cBurst).toBeDefined();

    // 依次放入阵盘 4 槽
    expect(placeDao(state, cChain!.uid, 0, 0).success).toBe(true);
    expect(placeDao(state, cGather!.uid, 0, 1).success).toBe(true);
    expect(placeDao(state, cCrit!.uid, 0, 2).success).toBe(true);
    expect(placeDao(state, cBurst!.uid, 0, 3).success).toBe(true);

    const res = executeDemoTurn(state);

    // 验证真实模拟日志包含了完整的连锁链条
    const actions = res.simulation.logs.map((l) => l.action);
    expect(actions).toContain('CHAIN_SPLIT'); // 分光分裂
    expect(actions).toContain('AMPLIFY');     // 增幅
    expect(actions).toContain('RELEASE');     // 灵爆释放

    // 真实产气值大于第 1 小关阈值 30
    expect(res.simulation.turnQiGenerated).toBeGreaterThanOrEqual(30);
    expect(res.cleared).toBe(true);
    // 释放总和等于 simulation.turnQiGenerated
    const totalReleased = res.simulation.logs
      .filter((l) => l.action === 'RELEASE')
      .reduce((sum, l) => sum + (l.qiDelta ?? 0), 0);
    expect(totalReleased).toBe(res.simulation.turnQiGenerated);
  });
});
