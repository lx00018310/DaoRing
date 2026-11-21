import { describe, expect, it } from 'vitest';
import { createInitialGameState, moveDao, placeDao, removeDao } from '../src/game';

describe('阵盘放置与燃料经济测试 (Fuel & Placement Economy)', () => {
  it('空槽放置：应只消耗待放置的道韵卡本身（成本 = 1）', () => {
    const state = createInitialGameState();
    const initialHandCount = state.hand.length;
    const cardToPlace = state.hand[0];

    const res = placeDao(state, cardToPlace.uid, 0, 1);
    expect(res.success).toBe(true);
    expect(state.hand.length).toBe(initialHandCount - 1);
    expect(state.board[0].slots[1]?.uid).toBe(cardToPlace.uid);
    expect(state.hand.find((c) => c.uid === cardToPlace.uid)).toBeUndefined();
  });

  it('覆盖已有道韵：必须提供燃料卡，成功后扣除放置卡与燃料卡共 2 张（成本 = 2）', () => {
    const state = createInitialGameState();
    const card1 = state.hand[0];
    const card2 = state.hand[1];
    const fuel = state.hand[2];
    const initialHandCount = state.hand.length;

    // 先空槽放置 card1
    placeDao(state, card1.uid, 0, 0);
    expect(state.board[0].slots[0]?.uid).toBe(card1.uid);
    expect(state.hand.length).toBe(initialHandCount - 1);

    // 未提供燃料卡进行覆盖应失败
    const failRes = placeDao(state, card2.uid, 0, 0);
    expect(failRes.success).toBe(false);
    expect(failRes.message).toContain('燃料');

    // 燃料卡不能与被放置卡相同
    const sameFailRes = placeDao(state, card2.uid, 0, 0, card2.uid);
    expect(sameFailRes.success).toBe(false);

    // 正常传入燃料卡进行覆盖
    const successRes = placeDao(state, card2.uid, 0, 0, fuel.uid);
    expect(successRes.success).toBe(true);
    expect(state.board[0].slots[0]?.uid).toBe(card2.uid);
    // 覆盖操作消耗了 card2 和 fuel 两张手牌
    expect(state.hand.find((c) => c.uid === card2.uid)).toBeUndefined();
    expect(state.hand.find((c) => c.uid === fuel.uid)).toBeUndefined();
    expect(state.hand.length).toBe(initialHandCount - 1 - 2);
  });

  it('拆除与移位已布置道韵：应消耗 1 张手牌作为燃料', () => {
    const state = createInitialGameState();
    const card = state.hand[0];
    const fuel1 = state.hand[1];
    const fuel2 = state.hand[2];

    placeDao(state, card.uid, 0, 0);
    expect(state.board[0].slots[0]?.uid).toBe(card.uid);

    // 移位测试：消耗 fuel1
    const moveRes = moveDao(state, 0, 0, 0, 2, fuel1.uid);
    expect(moveRes.success).toBe(true);
    expect(state.board[0].slots[0]).toBeNull();
    expect(state.board[0].slots[2]?.uid).toBe(card.uid);
    expect(state.hand.find((c) => c.uid === fuel1.uid)).toBeUndefined();

    // 拆除测试：消耗 fuel2
    const removeRes = removeDao(state, 0, 2, fuel2.uid);
    expect(removeRes.success).toBe(true);
    expect(state.board[0].slots[2]).toBeNull();
    expect(state.hand.find((c) => c.uid === fuel2.uid)).toBeUndefined();
  });

  it('向未解锁环或越界槽位放置应拒绝', () => {
    const state = createInitialGameState();
    const card = state.hand[0];

    // Ring 1 初始未解锁
    const resRingLocked = placeDao(state, card.uid, 1, 0);
    expect(resRingLocked.success).toBe(false);

    // Ring 0 只有 4 个槽 (0..3)，访问槽位 4 越界
    const resOutOfBound = placeDao(state, card.uid, 0, 4);
    expect(resOutOfBound.success).toBe(false);
  });

  it('非法参数（小数、负数、NaN、不存在燃料）原子拒绝且不扣除手牌与改阵', () => {
    const state = createInitialGameState();
    const initialHandCount = state.hand.length;
    const card = state.hand[0];

    // 负数
    const resNeg = placeDao(state, card.uid, -1, 0);
    expect(resNeg.success).toBe(false);
    expect(state.hand.length).toBe(initialHandCount);

    // 小数
    const resFloat = placeDao(state, card.uid, 0, 1.5);
    expect(resFloat.success).toBe(false);
    expect(state.hand.length).toBe(initialHandCount);

    // NaN
    const resNaN = placeDao(state, card.uid, 0, NaN);
    expect(resNaN.success).toBe(false);
    expect(state.hand.length).toBe(initialHandCount);

    // 移位非法参数
    placeDao(state, card.uid, 0, 0);
    const handCountAfterPlace = state.hand.length;
    const resMoveNaN = moveDao(state, 0, 0, 0, NaN, 'invalid_fuel');
    expect(resMoveNaN.success).toBe(false);
    expect(state.hand.length).toBe(handCountAfterPlace);
    expect(state.board[0].slots[0]?.uid).toBe(card.uid);
  });
});
