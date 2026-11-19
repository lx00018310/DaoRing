import { describe, expect, it, vi } from 'vitest';
import { animationDirector } from '../src/animationQueue';
import {
  createDemoInitialGameState,
  executeDemoTurn,
  placeDao,
} from '../src/game';

describe('炼气篇 Demo P0/P1/P2 核心闭环与系统测试', () => {
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

  it('当真气耗尽无法支付运转费用时，正确结算为走火入魔', () => {
    const state = createDemoInitialGameState();
    state.currentQi = 0; // 真气耗尽
    state.nextQiCost = 10;

    const res = executeDemoTurn(state);
    expect(res.isGameOver).toBe(true);
    expect(state.isGameOver).toBe(true);
    expect(res.cleared).toBe(false);
  });

  it('动画调度器 cancelAll 应彻底阻断旧局 onComplete 回调触发（防串局）', async () => {
    const onComplete = vi.fn();
    const dummyResult = {
      charged: 10,
      simulation: {
        turnQiGenerated: 50,
        logs: [
          { seq: 1, pulseId: 'P0', ringIdx: 0, slotIdx: 0, action: 'MOVE', detail: 'test' },
        ],
        totalSpawned: 1,
        releasedCount: 1,
        expiredCount: 0,
      },
      cleared: true,
      lootAwarded: [],
      newRealmUnlocked: false,
      isVictory: false,
      isGameOver: false,
    };

    const promise = animationDirector.playTurn(dummyResult, false, false, {
      setSlotHighlight: vi.fn(),
      highlightTrack: vi.fn(),
      spawnFloatText: vi.fn(),
      updateBurstScore: vi.fn(),
      playMinorBreakthrough: vi.fn().mockResolvedValue(undefined),
      playGrandBreakthrough: vi.fn().mockResolvedValue(undefined),
      onComplete,
    });

    // 立即执行取消
    animationDirector.cancelAll();
    await promise;

    // 验证取消后决不触发 onComplete
    expect(onComplete).not.toHaveBeenCalled();
    expect(animationDirector.running).toBe(false);
  });

  it('动画调度器 skip 应毫秒级中断并完成结算', async () => {
    const onComplete = vi.fn();
    const dummyResult = {
      charged: 10,
      simulation: {
        turnQiGenerated: 66,
        logs: [
          { seq: 1, pulseId: 'P0', ringIdx: 0, slotIdx: 0, action: 'MOVE', detail: 'test' },
          { seq: 2, pulseId: 'P0', ringIdx: 0, slotIdx: 1, action: 'AMPLIFY', detail: 'test' },
        ],
        totalSpawned: 1,
        releasedCount: 1,
        expiredCount: 0,
      },
      cleared: false,
      lootAwarded: [],
      newRealmUnlocked: false,
      isVictory: false,
      isGameOver: false,
    };

    const updateBurstScore = vi.fn();
    const promise = animationDirector.playTurn(dummyResult, false, false, {
      setSlotHighlight: vi.fn(),
      highlightTrack: vi.fn(),
      spawnFloatText: vi.fn(),
      updateBurstScore,
      playMinorBreakthrough: vi.fn().mockResolvedValue(undefined),
      playGrandBreakthrough: vi.fn().mockResolvedValue(undefined),
      onComplete,
    });

    // 跳过
    animationDirector.skip();
    await promise;

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(updateBurstScore).toHaveBeenCalledWith(66, 66, true);
  });
});
