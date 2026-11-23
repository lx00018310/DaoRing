// ============================================================
// 平衡性模拟：用真实引擎 + 贪心布阵机器人整局对打，统计每关通过率
// 机器人每关先炼化，再逐张试放手牌（含覆盖），选「实际产气 + 0.9 × 释放潜力」最高的落点；
// 释放潜力 = 若在某个空阵眼放一张灵爆，能量第一波抵达时的气势之和。
// ============================================================
import { getAllStages, getStageConfig } from '../src/config';
import { simulateBoardTick } from '../src/engine';
import { placeDao } from '../src/game';
import { BattleSession } from '../src/battle/session';
import { buildTimeline, pulseStateAt } from '../src/battle/timeline';
import type { GameState, RingTrack } from '../src/types';

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

const RELIC_PREF = ['relic_elixir', 'relic_sword_intent', 'relic_lotus', 'relic_five_elements', 'relic_void_walk', 'relic_calculation', 'relic_rebirth'];
const EVAL_SEEDS = [11, 23];

function evalBoard(board: RingTrack[], st: GameState): number {
  // 实际产气 + 0.9 × 潜力。潜力：若在某个空阵眼放一张灵爆，能量第一波抵达该处时的气势之和
  // （释放会让能量提前终结，之后的分裂与绕圈都不会发生，所以只算第一波）
  let total = 0;
  for (const s of EVAL_SEEDS) {
    const sim = simulateBoardTick(board, seeded(s), { relics: st.relics, tribulation: st.activeTribulation });
    const tl = buildTimeline(sim.logs);
    const arrivals = new Map<string, { t: number; power: number }[]>();
    for (const track of tl.pulses) {
      const visits = [{ at: track.start, t: track.birth }, ...track.moves.map((m) => ({ at: m.to, t: m.t + 1 }))];
      const firstSeen = new Set<string>();
      for (const v of visits) {
        if (board[v.at.ring]?.slots[v.at.slot] !== null) continue;
        const key = v.at.ring + ':' + v.at.slot;
        if (firstSeen.has(key)) continue;
        firstSeen.add(key);
        const state = pulseStateAt(track, v.t);
        const power = state ? state.power : track.power[track.power.length - 1];
        const list = arrivals.get(key) ?? [];
        list.push({ t: v.t, power: power.baseQi * power.multiplier * 1.25 });
        arrivals.set(key, list);
      }
    }
    let potential = 0;
    for (const list of arrivals.values()) {
      const t0 = Math.min(...list.map((a) => a.t));
      potential = Math.max(potential, list.filter((a) => a.t <= t0 + 1).reduce((sum, a) => sum + a.power, 0));
    }
    total += sim.turnQiGenerated + 0.9 * potential;
  }
  return total / EVAL_SEEDS.length;
}

function optimize(session: BattleSession): void {
  const st = session.state;
  // 先炼化：同名同级三张必合
  for (let guard = 0; guard < 10; guard++) {
    const fuse = session.fusionOptions().find((o) => o.mode === 'fuse');
    if (!fuse) break;
    session.applyFusion(fuse);
  }
  for (let guard = 0; guard < 40; guard++) {
    const base = evalBoard(st.board, st);
    let best: { uid: string; ring: number; slot: number; fuel?: string; gain: number } | null = null;
    const seen = new Set<string>();
    for (const card of st.hand) {
      const key = card.configId + '@' + card.level;
      if (seen.has(key)) continue;
      seen.add(key);
      st.board.forEach((ring, r) => {
        if (!ring.unlocked) return;
        for (let s = 0; s < ring.maxSlots; s++) {
          const old = ring.slots[s];
          if (old && st.hand.length < 3) continue;
          ring.slots[s] = card;
          const v = evalBoard(st.board, st);
          ring.slots[s] = old;
          // 覆盖要多烧一张，要求明显更好
          const gain = old ? v - base * 1.15 - 5 : v - base;
          if (gain > 0.5 && (!best || gain > best.gain)) best = { uid: card.uid, ring: r, slot: s, gain };
        }
      });
    }
    if (!best) break;
    const b = best as { uid: string; ring: number; slot: number; gain: number };
    const occupied = st.board[b.ring].slots[b.slot] !== null;
    let fuel: string | undefined;
    if (occupied) {
      const cheapest = st.hand.filter((c) => c.uid !== b.uid).sort((x, y) => x.level - y.level)[0];
      fuel = cheapest?.uid;
    }
    const res = placeDao(st, b.uid, b.ring, b.slot, fuel);
    if (!res.success) break;
  }
}

export function runBalance(runs: number, seedBase = 1000): void {
  const stages = getAllStages();
  const reached = new Array(stages.length + 1).fill(0);
  const deathsAt = new Array(stages.length).fill(0);
  const bestRatio: number[][] = stages.map(() => []);
  const turnsAt: number[][] = stages.map(() => []);
  let wins = 0;
  for (let run = 0; run < runs; run++) {
    const session = new BattleSession({ rng: seeded(seedBase + run) });
    const st = session.state;
    let idx = 0;
    let turnsThisStage = 0;
    let best = 0;
    reached[0]++;
    for (let guard = 0; guard < 400 && !session.isOver; guard++) {
      optimize(session);
      const turn = session.runTurn();
      if (!turn) break;
      turnsThisStage++;
      best = Math.max(best, turn.result.simulation.turnQiGenerated);
      if (turn.result.isGameOver) {
        deathsAt[idx]++;
        bestRatio[idx].push(best / turn.stage.threshold);
        break;
      }
      if (turn.result.cleared) {
        bestRatio[idx].push(best / turn.stage.threshold);
        turnsAt[idx].push(turnsThisStage);
        idx++;
        reached[idx]++;
        turnsThisStage = 0;
        best = 0;
        if (session.pendingRelics.length) {
          const pick = RELIC_PREF.find((id) => session.pendingRelics.some((r) => r.id === id)) ?? session.pendingRelics[0].id;
          session.chooseRelic(pick);
        }
        if (st.isVictory) wins++;
      }
    }
  }
  const med = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
  console.log('BAL ' + JSON.stringify({ runs, wins, reached, deathsAt }));
  console.log(`runs=${runs} wins=${wins} (${((wins / runs) * 100).toFixed(1)}%)`);
  stages.forEach((s, i) => {
    const cfg = getStageConfig(s.realm, s.subStage);
    const passRate = reached[i] ? (reached[i + 1] / reached[i]) * 100 : 0;
    console.log(`${s.realm}-${s.subStage} ${cfg.name.padEnd(6)} th=${String(cfg.threshold).padStart(8)} cost=${String(cfg.baseCost).padStart(8)} reached=${String(reached[i]).padStart(4)} pass=${passRate.toFixed(0).padStart(3)}% deaths=${deathsAt[i]} medBest/th=${med(bestRatio[i]).toFixed(2)} medTurns=${med(turnsAt[i])}`);
  });
}

export function census(runs: number, seedBase: number): void {
  const rows: number[][] = [];
  for (let run = 0; run < runs; run++) {
    const session = new BattleSession({ rng: seeded(seedBase + run) });
    const st = session.state;
    const power: number[] = [];
    for (let stage = 0; stage < 15 && !session.isOver; stage++) {
      optimize(session);
      let sum = 0;
      for (const sd of [101, 202, 303, 404]) {
        sum += simulateBoardTick(st.board, seeded(sd), { relics: st.relics, tribulation: st.activeTribulation }).turnQiGenerated;
      }
      power.push(Math.round(sum / 4));
      st.currentQi = 1e15;
      st.stageThreshold = 0;
      const turn = session.runTurn();
      if (!turn || !turn.result.cleared) break;
      if (session.pendingRelics.length) {
        const pick = RELIC_PREF.find((id) => session.pendingRelics.some((r) => r.id === id)) ?? session.pendingRelics[0].id;
        session.chooseRelic(pick);
      }
    }
    rows.push(power);
  }
  console.log('CENSUS ' + JSON.stringify(rows));
}

// 用法：npx vite-node scripts/balance.ts [局数=40] [起始种子=1000]
//      npx vite-node scripts/balance.ts census [局数=40] [起始种子=5000]
declare const process: { argv: string[] };
const args = process.argv.slice(2);
if (args[0] === 'census') census(Number(args[1] ?? 40), Number(args[2] ?? 5000));
else runBalance(Number(args[0] ?? 40), Number(args[1] ?? 1000));
