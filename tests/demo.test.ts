import { describe, expect, it, vi } from 'vitest';
import { animationDirector, AnimationQueueDirector } from '../src/animationQueue';
import { createDao } from '../src/config';
import { DEMO_CONFIG, demoSession } from '../src/demoConfig';
import { simulateBoardTick } from '../src/engine';
import {
  canRecallDao,
  createDemoInitialGameState,
  executeDemoTurn,
  getEffectiveQiCost,
  moveDao,
  placeDao,
  recallDao,
  type TurnExecutionResult,
} from '../src/game';

describe('炼气篇 Demo V3 核心闭环与系统测试', () => {
  it('炼气巅峰通关后应止步于炼气圆满（isVictory=true），绝不跳转筑基与解锁外环', () => {
    const state = createDemoInitialGameState();
    state.realm = 1;
    state.subStage = 3;
    state.stageThreshold = 120;
    state.currentQi = 999;

    // 直接在四个槽位布置强力道韵以确保通关
    // Slot 0: 分光, Slot 1: 聚灵, Slot 2: 锋芒, Slot 3: 灵爆
    state.board[0].slots[0] = createDao('dao_chain', 1, 'test_c0');
    state.board[0].slots[1] = createDao('dao_gather', 1, 'test_c1');
    state.board[0].slots[2] = createDao('dao_crit', 1, 'test_c2');
    state.board[0].slots[3] = createDao('dao_burst', 1, 'test_c3');

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
    expect(res.lootAwarded).toEqual([]);
  });

  it('V3 首局开局仅发 1 聚灵 + 1 灵爆，推荐 Slot1 聚灵 + Slot3 灵爆真实产气 43 顺利突破初期', () => {
    const state = createDemoInitialGameState();
    expect(state.hand.length).toBe(2);
    const cGather = state.hand.find((c) => c.configId === 'dao_gather');
    const cBurst = state.hand.find((c) => c.configId === 'dao_burst');

    expect(cGather).toBeDefined();
    expect(cBurst).toBeDefined();

    // 推荐布阵：Slot 1 聚灵，Slot 3 灵爆
    expect(placeDao(state, cGather!.uid, 0, 1).success).toBe(true);
    expect(placeDao(state, cBurst!.uid, 0, 3).success).toBe(true);
    expect(state.hand.length).toBe(0);

    // 运行首轮：输入确定性 rng (0.4)
    const res = executeDemoTurn(state, () => 0.4);

    // 真实产气 43（聚灵 30 基础气 * 1.0 倍率 * 1.45 释放连携 = 43）
    expect(res.simulation.turnQiGenerated).toBe(43);
    expect(res.cleared).toBe(true);
    expect(res.lootAwarded).toEqual([]);
    expect(state.hand).toEqual([]);
    expect(res.charged).toBe(10); // 初期基础消耗 10
    // 回合前态快照准确记录
    expect(res.context.realm).toBe(1);
    expect(res.context.subStage).toBe(1);
    expect(res.context.stageThreshold).toBe(30);
    expect(res.context.effectiveCost).toBe(10);
  });

  it('V3 初期两张开局牌支持无损收回，非开局牌或转入中期后不可无损收回', () => {
    const state = createDemoInitialGameState();
    const cGather = state.hand.find((c) => c.configId === 'dao_gather')!;
    placeDao(state, cGather.uid, 0, 1);

    expect(canRecallDao(state, 0, 1)).toBe(true);
    const recallRes = recallDao(state, 0, 1);
    expect(recallRes.success).toBe(true);
    expect(state.hand.some((c) => c.configId === 'dao_gather')).toBe(true);
    expect(state.board[0].slots[1]).toBeNull();

    // 放入一张非开局牌（如额外生成的牌）
    const foreignCard = createDao('dao_chain', 1, 'foreign_1');
    state.hand.push(foreignCard);
    placeDao(state, foreignCard.uid, 0, 0);
    expect(canRecallDao(state, 0, 0)).toBe(false);

    // 转入中期（subStage = 2）后，即便聚灵在槽位也不允许无损收回
    state.subStage = 2;
    state.hand.push(cGather);
    placeDao(state, cGather.uid, 0, 1);
    expect(canRecallDao(state, 0, 1)).toBe(false);
  });

  it('V3 偏离推荐路线（先Slot0聚灵、Slot1灵爆）亦可通关初期并用机动聚灵燃料移位', () => {
    const state = createDemoInitialGameState();
    const cGather = state.hand.find((c) => c.configId === 'dao_gather')!;
    const cBurst = state.hand.find((c) => c.configId === 'dao_burst')!;

    // 玩家放入 Slot 0 聚灵，Slot 1 灵爆
    placeDao(state, cGather.uid, 0, 0);
    placeDao(state, cBurst.uid, 0, 1);

    const res1 = executeDemoTurn(state, () => 0.4);
    expect(res1.cleared).toBe(true); // 30 基础气 * 1.45 = 43 >= 30

    // 进入中期后获得分光与机动聚灵
    const cChain = createDao('dao_chain', 1, 'branch_chain');
    const cFuelGather = createDao('dao_gather', 1, 'fuel_gather');
    state.hand.push(cChain, cFuelGather);

    // 用机动聚灵作为燃料，将 Slot 1 的灵爆移位至 Slot 3
    const moveRes = moveDao(state, 0, 1, 0, 3, cFuelGather.uid);
    expect(moveRes.success).toBe(true);
    expect(state.board[0].slots[3]?.configId).toBe('dao_burst');
    expect(state.board[0].slots[1]).toBeNull();

    // 空出来的 Slot 1 放入分光，此时盘面：Slot 0 聚灵，Slot 1 分光，Slot 3 灵爆
    const placeBranchRes = placeDao(state, cChain.uid, 0, 1);
    expect(placeBranchRes.success).toBe(true);
    const middle = executeDemoTurn(state, () => 0.4);
    expect(middle.simulation.turnQiGenerated).toBe(80);
    expect(middle.cleared).toBe(true);
  });

  it('V3 玄黄祥云劫前两次运转免费，第三次计费 145；神雷前三次应付为 25/87/181', () => {
    const state = createDemoInitialGameState();
    state.realm = 1;
    state.subStage = 3;
    state.stageThreshold = 120;
    state.currentQi = 300;

    // 首次进入巅峰，强制锁定玄黄祥云劫
    demoSession.resetForTest();
    const res1 = executeDemoTurn(state, () => 0.4);
    expect(res1.context.activeTribulation?.id).toBe('trib_cloud');
    expect(res1.context.effectiveCost).toBe(0); // 第一次免费
    expect(res1.charged).toBe(0);
    expect(state.freeTurnsLeft).toBe(1);

    const res2 = executeDemoTurn(state, () => 0.4);
    expect(res2.charged).toBe(0); // 第二次免费
    expect(state.freeTurnsLeft).toBe(0);

    // 第三次费用恢复正常且递增 (基准 25，第 3 次：25 * 3^1.6 = 144.57 -> 145)
    expect(getEffectiveQiCost(state)).toBe(145);
    const res3 = executeDemoTurn(state, () => 0.4);
    expect(res3.charged).toBe(145);

    // 测试九霄神雷 (指数 1.8，基数 25)
    const stateThunder = createDemoInitialGameState();
    stateThunder.realm = 1;
    stateThunder.subStage = 3;
    stateThunder.currentQi = 500;
    stateThunder.nextQiCost = 25; // 巅峰期基础费用 25
    // 强制装配九霄神雷
    stateThunder.activeTribulation = {
      id: 'trib_thunder',
      name: '九霄神雷劫',
      description: 'test',
      targetSubStage: 3,
      modifiers: { costExponentOverride: 1.8, doubleLoot: true },
    };
    // 初始 nextQiCost: 25 * 1^1.8 = 25
    expect(stateThunder.nextQiCost).toBe(25);
    executeDemoTurn(stateThunder, () => 0.4);
    // 第 2 次: 25 * 2^1.8 = 87.05 -> 87
    expect(stateThunder.nextQiCost).toBe(87);
    executeDemoTurn(stateThunder, () => 0.4);
    // 第 3 次: 25 * 3^1.8 = 181.16 -> 181
    expect(stateThunder.nextQiCost).toBe(181);
  });

  it('已结束的游戏再次调用 executeTurn 保持幂等，状态与真气均不改变', () => {
    const state = createDemoInitialGameState();
    state.isVictory = true;
    state.currentQi = 150;
    const initialQi = state.currentQi;

    const res = executeDemoTurn(state);
    expect(res.simulation.turnQiGenerated).toBe(0);
    expect(res.charged).toBe(0);
    expect(state.currentQi).toBe(initialQi);
    expect(res.context.effectiveCost).toBe(0);
  });

  it('V3 第 2.5 节引擎数值回归样例表完全对齐', () => {
    // 1. 初期建议：空 → 聚灵 → 空 → 灵爆
    const b1 = createDemoInitialGameState().board;
    b1[0].slots[1] = createDao('dao_gather', 1, 'g1');
    b1[0].slots[3] = createDao('dao_burst', 1, 'b1');
    const r1 = simulateBoardTick(b1, () => 0.4);
    expect(r1.turnQiGenerated).toBe(43);

    // 2. 中期分光：分光 → 聚灵 → 空 → 灵爆
    const b2 = createDemoInitialGameState().board;
    b2[0].slots[0] = createDao('dao_chain', 1, 'c2');
    b2[0].slots[1] = createDao('dao_gather', 1, 'g2');
    b2[0].slots[3] = createDao('dao_burst', 1, 'b2');
    expect(simulateBoardTick(b2, () => 0.4).turnQiGenerated).toBe(86);
    expect(simulateBoardTick(b2, () => 0.0).turnQiGenerated).toBe(98);

    // 3. 中期锋芒：空 → 聚灵 → 锋芒 → 灵爆
    const b3 = createDemoInitialGameState().board;
    b3[0].slots[1] = createDao('dao_gather', 1, 'g3');
    b3[0].slots[2] = createDao('dao_crit', 1, 'cr3');
    b3[0].slots[3] = createDao('dao_burst', 1, 'b3');
    expect(simulateBoardTick(b3, () => 0.4).turnQiGenerated).toBe(78);
    expect(simulateBoardTick(b3, () => 0.0).turnQiGenerated).toBe(117);

    // 4. 巅峰补齐：分光 → 聚灵 → 锋芒 → 灵爆
    const b4 = createDemoInitialGameState().board;
    b4[0].slots[0] = createDao('dao_chain', 1, 'c4');
    b4[0].slots[1] = createDao('dao_gather', 1, 'g4');
    b4[0].slots[2] = createDao('dao_crit', 1, 'cr4');
    b4[0].slots[3] = createDao('dao_burst', 1, 'b4');
    expect(simulateBoardTick(b4, () => 0.4).turnQiGenerated).toBe(156);
    expect(simulateBoardTick(b4, () => 0.0).turnQiGenerated).toBe(266);

    // 5. 巅峰万剑诀：分光 → 聚灵 → 锋芒 → 万剑诀
    const b5 = createDemoInitialGameState().board;
    b5[0].slots[0] = createDao('dao_chain', 1, 'c5');
    b5[0].slots[1] = createDao('dao_gather', 1, 'g5');
    b5[0].slots[2] = createDao('dao_crit', 1, 'cr5');
    b5[0].slots[3] = createDao('dao_sword', 1, 'sw5');
    expect(simulateBoardTick(b5, () => 0.4).turnQiGenerated).toBe(230);
    expect(simulateBoardTick(b5, () => 0.0).turnQiGenerated).toBe(398);
  });

  it('跨局重开最高分隔离：第一局心魔劫 312 后重开第二局祥云劫 156，第二局最高分准确记录 156', () => {
    // 第一局：在心魔劫下打出 312
    const state1 = createDemoInitialGameState();
    state1.realm = 1;
    state1.subStage = 3;
    state1.currentQi = 500;
    state1.board[0].slots[0] = createDao('dao_chain', 1, 'c1');
    state1.board[0].slots[1] = createDao('dao_gather', 1, 'g1');
    state1.board[0].slots[2] = createDao('dao_crit', 1, 'cr1');
    state1.board[0].slots[3] = createDao('dao_burst', 1, 'b1');
    state1.activeTribulation = {
      id: 'trib_mind_demon',
      name: '心魔焚心劫',
      description: 'test',
      targetSubStage: 3,
      modifiers: { releaseMultiplierBonus: 1.0 },
    };
    executeDemoTurn(state1, () => 0.4);
    expect(state1.runStats.highestSingleQi).toBe(312);

    // 重开第二局：创建全新的 GameState
    const state2 = createDemoInitialGameState();
    state2.realm = 1;
    state2.subStage = 3;
    state2.currentQi = 500;
    state2.board[0].slots[0] = createDao('dao_chain', 1, 'c2');
    state2.board[0].slots[1] = createDao('dao_gather', 1, 'g2');
    state2.board[0].slots[2] = createDao('dao_crit', 1, 'cr2');
    state2.board[0].slots[3] = createDao('dao_burst', 1, 'b2');
    state2.activeTribulation = {
      id: 'trib_cloud',
      name: '玄黄祥云劫',
      description: 'test',
      targetSubStage: 3,
      modifiers: { freeTurnsCount: 2 },
    };
    executeDemoTurn(state2, () => 0.4);
    // 第二局最高产气严格为 156，绝不残留第一局的 312
    expect(state2.runStats.highestSingleQi).toBe(156);
  });

  it('极端压力盘面（4 张分光满圈）Tick 达到 2000 上限时安全终止并生成 TICK_LIMIT 日志', () => {
    const b = createDemoInitialGameState().board;
    // 4 槽全部放分光
    b[0].slots[0] = createDao('dao_chain', 1, 'c0');
    b[0].slots[1] = createDao('dao_chain', 1, 'c1');
    b[0].slots[2] = createDao('dao_chain', 1, 'c2');
    b[0].slots[3] = createDao('dao_chain', 1, 'c3');

    const result = simulateBoardTick(b, () => 0.4);
    expect(result.logs.length).toBeGreaterThan(500);
    const limitLog = result.logs.find((l) => l.action === 'TICK_LIMIT');
    expect(limitLog).toBeDefined();
    expect(limitLog?.detail).toContain('达到步数上限');
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
    const dummyResult: TurnExecutionResult = {
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
      context: {
        realm: 1,
        subStage: 1,
        turnIndex: 1,
        stageName: '炼气初期',
        stageThreshold: 30,
        effectiveCost: 10,
        qiBefore: 100,
        activeTribulation: null,
      },
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
    const dummyResult: TurnExecutionResult = {
      charged: 10,
      simulation: {
        turnQiGenerated: 66,
        logs: [
          { seq: 1, pulseId: 'P0', ringIdx: 0, slotIdx: 1, fromSlot: 0, toSlot: 1, action: 'MOVE', detail: 'test' },
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
      context: {
        realm: 1,
        subStage: 1,
        turnIndex: 1,
        stageName: '炼气初期',
        stageThreshold: 30,
        effectiveCost: 10,
        qiBefore: 100,
        activeTribulation: null,
      },
    };

    const updateBurstScore = vi.fn();
    const movePulse = vi.fn();
    vi.useFakeTimers();
    try {
      const promise = animationDirector.playTurn(dummyResult, false, false, {
        setSlotHighlight: vi.fn(),
        highlightTrack: vi.fn(),
        spawnFloatText: vi.fn(),
        movePulse,
        updateBurstScore,
        playMinorBreakthrough: vi.fn().mockResolvedValue(undefined),
        playGrandBreakthrough: vi.fn().mockResolvedValue(undefined),
        onComplete,
      });
      await vi.advanceTimersByTimeAsync(DEMO_CONFIG.timings.pulseStart + 1);
      expect(movePulse).toHaveBeenCalledTimes(1);
      animationDirector.skip();
      await promise;
    } finally {
      animationDirector.cancelAll();
      vi.useRealTimers();
    }

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(updateBurstScore).toHaveBeenCalledWith(66, 66, true);
  });

  it('逐束回放真实的分裂和移动，保留两次释放与普通锋芒', async () => {
    const state = createDemoInitialGameState();
    state.board[0].slots = ['dao_chain', 'dao_gather', 'dao_crit', 'dao_burst']
      .map((id) => createDao(id, 1, id));
    const result = executeDemoTurn(state, () => 0.4);
    const director = new AnimationQueueDirector();
    const move = vi.fn();
    const spawn = vi.fn();
    const score = vi.fn();
    const float = vi.fn();
    vi.useFakeTimers();
    try {
      const playback = director.playTurn(result, false, false, {
        setSlotHighlight: vi.fn(), highlightTrack: vi.fn(), spawnPulse: spawn, movePulse: move,
        spawnFloatText: float, updateBurstScore: score,
        playMinorBreakthrough: vi.fn(), playGrandBreakthrough: vi.fn(), onComplete: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(DEMO_CONFIG.timings.normalTurnBudgetMax);
      expect(director.running).toBe(false);
      await playback;
      expect(spawn).toHaveBeenCalledWith('P1', 1);
      expect(move.mock.calls.filter(([, from, to]) => from === 1 && to === 2).map(([id]) => id)).toEqual(['P1', 'P0']);
      expect(score.mock.calls).toEqual([[78, 78, false], [156, 78, false], [156, 0, true]]);
      expect(float.mock.calls.some(([, label]) => label.includes('暴击'))).toBe(false);
    } finally {
      director.cancelAll();
      vi.useRealTimers();
    }
  });

  it('四分光真实压力回合在包括聚气的预算内结束', async () => {
    const state = createDemoInitialGameState();
    state.board[0].slots = Array.from({ length: 4 }, (_, i) => createDao('dao_chain', 1, `split_${i}`));
    const result = executeDemoTurn(state, () => 0.4);
    const director = new AnimationQueueDirector();
    const completed = vi.fn();
    const score = vi.fn();
    vi.useFakeTimers();
    try {
      const playback = director.playTurn(result, false, false, {
        setSlotHighlight: vi.fn(), highlightTrack: vi.fn(), spawnFloatText: vi.fn(), updateBurstScore: score,
        playMinorBreakthrough: vi.fn(), playGrandBreakthrough: vi.fn(), onComplete: completed,
      });
      await vi.advanceTimersByTimeAsync(DEMO_CONFIG.timings.normalTurnBudgetMax);
      expect(completed).toHaveBeenCalledTimes(1);
      await playback;
      expect(score).toHaveBeenLastCalledWith(0, 0, true);
      expect(result.simulation.logs).toHaveLength(7964);
    } finally {
      director.cancelAll();
      vi.useRealTimers();
    }
  });
});
