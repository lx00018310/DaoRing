import { describe, expect, it } from 'vitest';
import { ALL_DAO_IDS, ALL_RELIC_IDS, ALL_TRIBULATION_IDS, BOARD, createDao, getAllStages, getTribulationConfig } from '../src/config';
import { simulateBoardTick } from '../src/engine';
import { createInitialBoard } from '../src/game';
import type { RingTrack } from '../src/types';
import { getAllFoes, getFoeConfig } from '../src/battle/foes';
import { LAYOUT, SLOT_HIT, STAGE_H, STAGE_W, slotPoint, type SlotRef } from '../src/battle/geometry';
import { BattleSession, ensureOpeningGather } from '../src/battle/session';
import { buildTimeline, pulseStateAt } from '../src/battle/timeline';

/** 可复现的伪随机源 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBoard(rng: () => number, rings: number): RingTrack[] {
  const board = createInitialBoard(rings);
  let uid = 0;
  board.forEach((ring) => {
    if (!ring.unlocked) return;
    for (let s = 0; s < ring.maxSlots; s++) {
      if (rng() < 0.35) continue;
      const id = ALL_DAO_IDS[Math.floor(rng() * ALL_DAO_IDS.length)];
      ring.slots[s] = createDao(id, 1 + Math.floor(rng() * 5), `t${uid++}`);
    }
  });
  return board;
}

const same = (a: SlotRef, b: SlotRef): boolean => a.ring === b.ring && a.slot === b.slot;

describe('斗法演出时间轴：只消费引擎日志', () => {
  it('600 个随机阵盘（含灵宝、天劫、五环）：演出伤害之和 = 引擎产气，路径连续', () => {
    for (let seed = 1; seed <= 600; seed++) {
      const rng = seeded(seed);
      const rings = 1 + (seed % 5);
      const board = randomBoard(rng, rings);
      const relics = ALL_RELIC_IDS.filter(() => rng() < 0.3);
      const tribulation = rng() < 0.5 ? getTribulationConfig(ALL_TRIBULATION_IDS[seed % ALL_TRIBULATION_IDS.length]) : null;
      const sim = simulateBoardTick(board, seeded(seed * 7), { relics, tribulation });
      const tl = buildTimeline(sim.logs);

      expect(tl.totalQi).toBe(sim.turnQiGenerated);
      expect(tl.releaseCount).toBe(sim.releasedCount);
      const releaseQi = tl.beats.filter((b) => b.kind === 'release').map((b) => b.qi).sort();
      const logQi = sim.logs.filter((e) => e.action === 'RELEASE').map((e) => e.qiDelta).sort();
      expect(releaseQi).toEqual(logQi);

      for (let i = 1; i < tl.beats.length; i++) {
        expect(tl.beats[i].t).toBeGreaterThanOrEqual(tl.beats[i - 1].t);
      }
      const byId = new Map(tl.pulses.map((p) => [p.id, p]));
      for (const track of tl.pulses) {
        for (let i = 1; i < track.moves.length; i++) {
          const prev = track.moves[i - 1];
          const cur = track.moves[i];
          expect(same(prev.to, cur.from)).toBe(true);
          expect(cur.t).toBeGreaterThanOrEqual(prev.t + 1);
        }
        if (track.parentId) {
          const parent = byId.get(track.parentId)!;
          const at = pulseStateAt(parent, track.birth);
          expect(at).not.toBeNull();
          expect(same(at!.move ? at!.move.from : at!.at, track.start)).toBe(true);
        }
        if (track.end) {
          const last = track.moves[track.moves.length - 1];
          const endAt = last ? last.to : track.start;
          expect(same(endAt, track.end.at)).toBe(true);
        }
      }
    }
  });

  it('初期建议阵（空→聚灵→空→灵爆）产气 43，单股能量走 3 拍后释放', () => {
    const board = createInitialBoard(1);
    board[0].slots[1] = createDao('dao_gather', 1, 'g');
    board[0].slots[3] = createDao('dao_burst', 1, 'b');
    const sim = simulateBoardTick(board, () => 0.4);
    const tl = buildTimeline(sim.logs);
    expect(tl.totalQi).toBe(43);
    expect(tl.pulses).toHaveLength(1);
    expect(tl.pulses[0].end).toEqual({ t: 3, kind: 'release', at: { ring: 0, slot: 3 } });
    expect(tl.pulses[0].power.some((p) => p.baseQi === 30)).toBe(true);
  });

  it('分光子束从母束所在阵眼飞出，落到引擎给出的槽位', () => {
    const board = createInitialBoard(1);
    board[0].slots[0] = createDao('dao_chain', 1, 'c');
    board[0].slots[2] = createDao('dao_burst', 1, 'b');
    const sim = simulateBoardTick(board, () => 0.99);
    const tl = buildTimeline(sim.logs);
    const child = tl.pulses.find((p) => p.parentId === 'P0')!;
    expect(child.start).toEqual({ ring: 0, slot: 0 });
    expect(child.moves[0]).toEqual({ t: 0, from: { ring: 0, slot: 0 }, to: { ring: 0, slot: 1 }, kind: 'split' });
    expect(tl.beats.find((b) => b.kind === 'split')?.text).toBe('分光 ×1');
  });

  it('四分光压力阵打满 2000 Tick：时间轴仍可构建且总产气一致', () => {
    const board = createInitialBoard(1);
    for (let s = 0; s < 4; s++) board[0].slots[s] = createDao('dao_chain', 1, `c${s}`);
    const sim = simulateBoardTick(board, () => 0.4);
    const tl = buildTimeline(sim.logs);
    expect(tl.tickLimited).toBe(true);
    expect(tl.totalQi).toBe(sim.turnQiGenerated);
    expect(tl.maxT).toBeGreaterThan(0);
  });
});

describe('斗法阵盘几何', () => {
  const all: { ref: SlotRef; x: number; y: number }[] = [];
  BOARD.ringSlots.forEach((n, ring) => {
    for (let slot = 0; slot < n; slot++) all.push({ ref: { ring, slot }, ...slotPoint(ring, slot) });
  });

  it('五环全开的 40 个阵眼点击区域互不重叠', () => {
    expect(all).toHaveLength(40);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const dx = Math.abs(all[i].x - all[j].x);
        const dy = Math.abs(all[i].y - all[j].y);
        expect(dx >= SLOT_HIT.w || dy >= SLOT_HIT.h).toBe(true);
      }
    }
  });

  it('阵眼都在舞台内，且不压住底部手牌区与左侧主角', () => {
    const trayTop = STAGE_H - 10 - 169;
    for (const p of all) {
      expect(p.x - SLOT_HIT.w / 2).toBeGreaterThan(360);
      expect(p.x + SLOT_HIT.w / 2).toBeLessThan(STAGE_W);
      expect(p.y - SLOT_HIT.h / 2).toBeGreaterThan(300);
      expect(p.y + SLOT_HIT.h / 2 - 8).toBeLessThan(trayTop);
    }
  });

  it('Slot 0 位于正左方，升环后的落点在更外侧的环上', () => {
    const inner = slotPoint(0, 0);
    expect(inner.x).toBeLessThan(LAYOUT.cx);
    expect(Math.round(inner.y)).toBe(LAYOUT.cy);
    const outer = slotPoint(1, Math.floor((1 * 6) / 4));
    const innerSame = slotPoint(0, 1);
    expect(Math.hypot(outer.x - LAYOUT.cx, (outer.y - LAYOUT.cy) / LAYOUT.ratio))
      .toBeGreaterThan(Math.hypot(innerSame.x - LAYOUT.cx, (innerSame.y - LAYOUT.cy) / LAYOUT.ratio));
  });
});

describe('斗法敌人配置', () => {
  it('15 个关卡各有专属敌人，名字不重复', () => {
    const stages = getAllStages();
    expect(getAllFoes()).toHaveLength(stages.length);
    const names = new Set(stages.map((s) => getFoeConfig(s.realm, s.subStage).name));
    expect(names.size).toBe(stages.length);
  });
});

describe('斗法会话：一场一场打到化神', () => {
  it('开局 6 张、必含灵爆，且保底至少一张聚灵或升维', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const session = new BattleSession({ rng: seeded(seed) });
      const ids = session.state.hand.map((c) => c.configId);
      expect(ids).toHaveLength(BOARD.initialHandSize);
      expect(ids).toContain('dao_burst');
      expect(ids.includes('dao_gather') || ids.includes('dao_jump')).toBe(true);
    }
    const hand = [createDao('dao_burst', 1, 'b'), createDao('dao_crit', 1, 'c')];
    ensureOpeningGather(hand);
    expect(hand.map((c) => c.configId)).toEqual(['dao_burst', 'dao_gather']);
  });

  it('连斩 15 敌：每次大境界突破解锁外环并灵宝三选一，巅峰降天劫，最终化神大成并结算功德', () => {
    const session = new BattleSession({ rng: seeded(42) });
    const st = session.state;
    st.board[0].slots[0] = createDao('dao_gather', 5, 'g');
    st.board[0].slots[1] = createDao('dao_burst', 5, 'b');
    let relicRounds = 0;
    let tribulations = 0;
    let lootCards = 0;
    for (let stage = 0; stage < 15; stage++) {
      st.currentQi = 1e9;
      st.stageThreshold = 1; // 只验证流程衔接，数值平衡另测
      const turn = session.runTurn()!;
      expect(turn.result.cleared).toBe(true);
      expect(turn.stage.foe.name).toBe(getFoeConfig(turn.stage.realm, turn.stage.subStage).name);
      lootCards += turn.result.lootAwarded.length;
      if (turn.result.tribulationEncountered) tribulations += 1;
      if (turn.result.newRealmUnlocked) {
        expect(st.board[st.realm - 1].unlocked).toBe(true);
        expect(session.pendingRelics).toHaveLength(3);
        expect(session.runTurn()).toBeNull();
        expect(session.chooseRelic('relic_not_exist').success).toBe(false);
        expect(session.chooseRelic(session.pendingRelics[0].id).success).toBe(true);
        expect(session.pendingRelics).toHaveLength(0);
        relicRounds += 1;
      }
    }
    expect(relicRounds).toBe(4);
    expect(st.relics).toHaveLength(4);
    expect(tribulations).toBe(5);
    expect(lootCards).toBeGreaterThanOrEqual(15 * BOARD.dropCountMin);
    expect(st.isVictory).toBe(true);
    expect(st.board.every((ring) => ring.unlocked)).toBe(true);
    expect(session.runTurn()).toBeNull();
    const settle = session.settleKarma({ totalKarma: 0, accumulatedKarma: 0, unlockedTalents: {}, historyHighQi: 0, totalRuns: 0, victories: 0 })!;
    expect(settle.karmaGained).toBeGreaterThanOrEqual(100 + 15 * 5);
    expect(settle.profile.victories).toBe(1);
    expect(session.settleKarma()).toBe(settle);
  });

  it('打不破护体又付不起下次运转：判定必死，下一次运转由引擎宣告走火入魔', () => {
    const session = new BattleSession({ rng: seeded(7) });
    const qi: number[] = [];
    let turn = session.runTurn()!;
    qi.push(session.state.currentQi);
    expect(turn.doomed).toBe(false);
    turn = session.runTurn()!;
    qi.push(session.state.currentQi);
    turn = session.runTurn()!;
    qi.push(session.state.currentQi);
    expect(qi).toEqual([90, 60, 2]);
    expect(turn.result.cleared).toBe(false);
    expect(turn.doomed).toBe(true);
    expect(session.isDoomed()).toBe(true);
    const fatal = session.runTurn()!;
    expect(fatal.result.isGameOver).toBe(true);
    expect(fatal.result.charged).toBe(0);
    expect(session.isOver).toBe(true);
    expect(session.runTurn()).toBeNull();
    expect(session.settleKarma({ totalKarma: 0, accumulatedKarma: 0, unlockedTalents: {}, historyHighQi: 0, totalRuns: 0, victories: 0 })!.profile.totalRuns).toBe(1);
  });

  it('天道生机：真气不足时不判必死，运转时免死一次', () => {
    const session = new BattleSession({ rng: seeded(9) });
    session.state.relics.push('relic_rebirth');
    session.state.currentQi = 5;
    expect(session.isDoomed()).toBe(false);
    const turn = session.runTurn()!;
    expect(turn.rebirthTriggered).toBe(true);
    expect(turn.result.isGameOver).toBe(false);
    expect(session.rebirthAvailable).toBe(false);
  });

  it('炼化：三合一与催化精炼都走 game.ts 规则', () => {
    const session = new BattleSession({ rng: seeded(3) });
    session.state.hand = [
      createDao('dao_gather', 1, 'g1'), createDao('dao_gather', 1, 'g2'), createDao('dao_gather', 1, 'g3'),
      createDao('dao_crit', 2, 'c1'), createDao('dao_crit', 2, 'c2'), createDao('dao_burst', 1, 'b1'),
    ];
    const options = session.fusionOptions();
    const fuse = options.find((o) => o.mode === 'fuse')!;
    const refine = options.find((o) => o.mode === 'refine')!;
    expect(fuse.configId).toBe('dao_gather');
    expect(refine.configId).toBe('dao_crit');
    expect(refine.catalyst?.level).toBe(1);
    expect(session.applyFusion(fuse).success).toBe(true);
    expect(session.state.hand.some((c) => c.configId === 'dao_gather' && c.level === 2)).toBe(true);
    const again = session.fusionOptions().find((o) => o.mode === 'refine' && o.configId === 'dao_crit')!;
    expect(session.applyFusion(again).success).toBe(true);
    expect(session.state.hand.some((c) => c.configId === 'dao_crit' && c.level === 3)).toBe(true);
    expect(session.state.runStats.daosFused).toBe(2);
  });
});
