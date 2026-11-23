// ============================================================
// 斗法场景 · 引擎日志 → 演出时间轴
// 演出只消费引擎的真实结算日志（simulateBoardTick 产出的 SimulationLogEntry），
// 不自行推算任何规则：每股能量的路径、分裂、增幅与释放产气都来自日志。
//
// 时间单位为「拍」：一股能量在一个阵眼上触发效果发生在第 t 拍，
// 向下一阵眼的移动占用 t → t+1。分裂出的子束在第 t 拍从母束所在阵眼飞出，
// 第 t+1 拍抵达自己的起点。
// ============================================================
import { BOARD } from '../config';
import type { SimulationLogEntry } from '../types';
import type { SlotRef } from './geometry';

export type MoveKind = 'step' | 'ascend' | 'jump' | 'reverse' | 'split';

export interface PulseMove {
  t: number;
  from: SlotRef;
  to: SlotRef;
  kind: MoveKind;
}

export interface PulsePower {
  t: number;
  baseQi: number;
  multiplier: number;
}

export interface PulseEnd {
  t: number;
  kind: 'release' | 'expire';
  at: SlotRef;
}

export interface PulseTrack {
  id: string;
  parentId?: string;
  birth: number;
  start: SlotRef;
  moves: PulseMove[];
  power: PulsePower[];
  end?: PulseEnd;
}

export type BeatKind =
  | 'amplify'
  | 'crit'
  | 'split'
  | 'synergy'
  | 'jump'
  | 'reverse'
  | 'lucky'
  | 'release'
  | 'expire';

export interface Beat {
  t: number;
  seq: number;
  kind: BeatKind;
  pulseId: string;
  at: SlotRef;
  text: string;
  /** 仅 release：本束实际产气（等于日志 qiDelta） */
  qi?: number;
  /** 仅 release：释放道韵名，用于区分万剑诀 / 灵爆术演出 */
  releaseName?: string;
  big?: boolean;
}

export interface Timeline {
  pulses: PulseTrack[];
  beats: Beat[];
  /** 最晚一拍 */
  maxT: number;
  /** 所有释放产气之和，必须等于 SimulationResult.turnQiGenerated */
  totalQi: number;
  releaseCount: number;
  tickLimited: boolean;
}

const ref = (ring: number, slot: number): SlotRef => ({ ring, slot });

function fromOf(entry: SimulationLogEntry): SlotRef | null {
  return entry.fromRing === undefined || entry.fromSlot === undefined ? null : ref(entry.fromRing, entry.fromSlot);
}

function toOf(entry: SimulationLogEntry): SlotRef | null {
  return entry.toRing === undefined || entry.toSlot === undefined ? null : ref(entry.toRing, entry.toSlot);
}

export function buildTimeline(
  logs: SimulationLogEntry[],
  initialBaseQi: number = BOARD.initialBaseQi,
  initialMultiplier: number = BOARD.initialMultiplier,
): Timeline {
  const tracks = new Map<string, PulseTrack>();
  const clocks = new Map<string, number>();
  const beats: Beat[] = [];
  let totalQi = 0;
  let releaseCount = 0;
  let tickLimited = false;

  const ensure = (id: string, entry: SimulationLogEntry): PulseTrack => {
    let track = tracks.get(id);
    if (!track) {
      // 跨环日志记录的是移动后的位置，起点要取 from
      const start = fromOf(entry) ?? ref(entry.ringIdx, entry.slotIdx);
      track = { id, birth: 0, start, moves: [], power: [{ t: 0, baseQi: initialBaseQi, multiplier: initialMultiplier }] };
      tracks.set(id, track);
      clocks.set(id, 0);
    }
    return track;
  };
  const powerOf = (track: PulseTrack): PulsePower => track.power[track.power.length - 1];
  const setPower = (track: PulseTrack, t: number, baseQi: number, multiplier: number): void => {
    const last = powerOf(track);
    if (last.t === t) {
      last.baseQi = baseQi;
      last.multiplier = multiplier;
    } else {
      track.power.push({ t, baseQi, multiplier });
    }
  };

  const ordered = [...logs].sort((a, b) => a.seq - b.seq);
  for (const entry of ordered) {
    if (entry.action === 'TICK_LIMIT') {
      tickLimited = true;
      continue;
    }
    const here = ref(entry.ringIdx, entry.slotIdx);
    const track = ensure(entry.pulseId, entry);
    const t = clocks.get(entry.pulseId) ?? 0;
    const power = powerOf(track);
    const beat = (kind: BeatKind, text: string, at: SlotRef = here, extra: Partial<Beat> = {}): void => {
      beats.push({ t, seq: entry.seq, kind, pulseId: entry.pulseId, at, text, ...extra });
    };

    switch (entry.action) {
      case 'MOVE':
      case 'OUTER_LOOP':
      case 'AUTO_ASCEND': {
        const from = fromOf(entry);
        const to = toOf(entry);
        if (from && to) {
          track.moves.push({ t, from, to, kind: entry.action === 'AUTO_ASCEND' ? 'ascend' : 'step' });
          clocks.set(entry.pulseId, t + 1);
        }
        if (entry.baseQiDelta) setPower(track, t + 1, power.baseQi + entry.baseQiDelta, power.multiplier);
        break;
      }
      case 'FORCE_JUMP': {
        const from = fromOf(entry);
        const to = toOf(entry);
        const base = power.baseQi + (entry.baseQiDelta ?? 0);
        setPower(track, t, base, power.multiplier);
        beat('jump', `升维 · 基础气 +${entry.baseQiDelta ?? 0}`, from ?? here);
        if (from && to) {
          track.moves.push({ t, from, to, kind: 'jump' });
          clocks.set(entry.pulseId, t + 1);
        }
        break;
      }
      case 'REVERSE_FLOW': {
        const from = fromOf(entry);
        const to = toOf(entry);
        beat('reverse', '逆流倒灌 · 步数回复', from ?? here);
        if (from && to) {
          track.moves.push({ t, from, to, kind: 'reverse' });
          clocks.set(entry.pulseId, t + 1);
        }
        break;
      }
      case 'CHAIN_SPLIT':
      case 'RELIC_CLONE': {
        const ids = entry.spawnedPulseIds ?? [];
        const slots = entry.spawnedSlots ?? [];
        ids.forEach((childId, i) => {
          const dest = ref(entry.ringIdx, slots[i] ?? entry.slotIdx);
          const child: PulseTrack = {
            id: childId,
            parentId: entry.pulseId,
            birth: t,
            start: here,
            moves: [{ t, from: here, to: dest, kind: 'split' }],
            power: [{ t, baseQi: power.baseQi, multiplier: power.multiplier }],
          };
          tracks.set(childId, child);
          clocks.set(childId, t + 1);
        });
        if (ids.length > 0) {
          beat('split', entry.action === 'RELIC_CLONE' ? '太虚神行 · 分身' : `分光 ×${ids.length}`, here, { big: ids.length > 1 });
        }
        break;
      }
      case 'AMPLIFY': {
        let base = power.baseQi + (entry.baseQiDelta ?? 0);
        let mult = power.multiplier + (entry.multiplierDelta ?? 0);
        if (entry.isCrit && entry.critFactor) mult *= entry.critFactor;
        base = Math.max(0, base);
        setPower(track, t, base, mult);
        if (entry.isCrit && entry.critFactor) {
          beat('crit', `锋芒暴击 ×${entry.critFactor.toFixed(2)}`, here, { big: true });
        } else if (entry.baseQiDelta !== undefined) {
          beat('amplify', `基础气 +${entry.baseQiDelta}`);
        } else {
          beat('amplify', `倍率 +${(entry.multiplierDelta ?? 0).toFixed(2)}`);
        }
        break;
      }
      case 'SYNERGY': {
        if (entry.multiplierDelta) setPower(track, t, power.baseQi, power.multiplier + entry.multiplierDelta);
        const text = entry.releaseFactorDelta !== undefined
          ? `连携 · 释放系数 +${entry.releaseFactorDelta}`
          : entry.ttlDelta !== undefined
            ? `连携 · 步数 +${entry.ttlDelta}`
            : `连携 · 倍率 +${entry.multiplierDelta ?? 0}`;
        beat('synergy', text);
        break;
      }
      case 'CRUISE_LUCKY':
        beat('lucky', '天衍神算 · 免耗步数');
        break;
      case 'RELEASE': {
        const qi = entry.qiDelta ?? 0;
        totalQi += qi;
        releaseCount += 1;
        const releaseName = entry.detail.split('(')[0];
        beat('release', `+${qi}`, here, { qi, releaseName });
        track.end = { t, kind: 'release', at: here };
        break;
      }
      case 'EXPIRE':
        beat('expire', '灵气消散');
        track.end = { t, kind: 'expire', at: here };
        break;
      default:
        // SPLIT_LIMIT 等诊断日志不需要演出
        break;
    }
  }

  let maxT = 0;
  for (const track of tracks.values()) {
    maxT = Math.max(maxT, clocks.get(track.id) ?? 0, track.end?.t ?? 0);
  }
  beats.sort((a, b) => a.t - b.t || a.seq - b.seq);
  return { pulses: [...tracks.values()], beats, maxT, totalQi, releaseCount, tickLimited };
}

/** 某股能量在第 u 拍（可为小数）所在的位置与当时的气势；已结束或未出生返回 null。 */
export function pulseStateAt(
  track: PulseTrack,
  u: number,
): { move: PulseMove | null; progress: number; at: SlotRef; power: PulsePower } | null {
  if (u < track.birth) return null;
  if (track.end && u > track.end.t + 0.15) return null;
  let at = track.start;
  let move: PulseMove | null = null;
  let progress = 0;
  for (const m of track.moves) {
    if (m.t + 1 <= u) {
      at = m.to;
    } else if (m.t <= u) {
      move = m;
      progress = u - m.t;
      break;
    } else {
      break;
    }
  }
  let power = track.power[0];
  for (const p of track.power) {
    if (p.t <= u) power = p;
    else break;
  }
  return { move, progress, at, power };
}
