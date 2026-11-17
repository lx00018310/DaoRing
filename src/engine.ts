// ============================================================
// 运转结算仿真器 (Tick Simulation Engine)
// 严格实现方案文档第 3 节，并整合肉鸽深化机制：
// 1. 先天灵宝被动挂钩 (Relic Modifiers)
// 2. 阵盘灵脉同相共鸣 (Mono-Ring Resonance) 与道法连携 (Sequence Flow Synergy)
// 3. 天劫异象动态干预 (Tribulations)
// 4. 濒死免死逆天改命 (Rebirth Hook)
// ============================================================
import {
  BOARD,
  calcQiCost,
  getDaoConfig,
  getLevelParams,
  getRelicConfig,
  getStageConfig,
} from './config';
import type {
  DaoCategory,
  EnergyPulse,
  GameState,
  RelicModifiers,
  RingTrack,
  SimulationLogEntry,
  SimulationResult,
  TribulationConfig,
} from './types';

type Rng = () => number;

export interface SimulationOptions {
  relics?: string[];
  tribulation?: TribulationConfig | null;
}

/** 汇总所装配灵宝的加成系数 */
export function aggregateRelicModifiers(relicIds: string[] = []): RelicModifiers {
  const merged: RelicModifiers = {};
  for (const id of relicIds) {
    const cfg = getRelicConfig(id);
    const m = cfg.modifiers;
    if (m.ttlBonus) merged.ttlBonus = (merged.ttlBonus ?? 0) + m.ttlBonus;
    if (m.initialQiPerTurnBonus) merged.initialQiPerTurnBonus = (merged.initialQiPerTurnBonus ?? 0) + m.initialQiPerTurnBonus;
    if (m.releaseFactorBonus) merged.releaseFactorBonus = (merged.releaseFactorBonus ?? 0) + m.releaseFactorBonus;
    if (m.freeCruiseChance) merged.freeCruiseChance = (merged.freeCruiseChance ?? 0) + m.freeCruiseChance;
    if (m.ascendBaseQiBonus) merged.ascendBaseQiBonus = (merged.ascendBaseQiBonus ?? 0) + m.ascendBaseQiBonus;
    if (m.critChanceBonus) merged.critChanceBonus = (merged.critChanceBonus ?? 0) + m.critChanceBonus;
    if (m.critFactorBonus) merged.critFactorBonus = (merged.critFactorBonus ?? 0) + m.critFactorBonus;
    if (m.jumpCloneChance) merged.jumpCloneChance = Math.max(merged.jumpCloneChance ?? 0, m.jumpCloneChance);
    if (m.hasRebirth) merged.hasRebirth = true;
  }
  return merged;
}

/** 检测某环是否处于“同相纯色共鸣”（至少有 2 个非空道韵，且全部为同一类别） */
export function checkRingResonance(ring: RingTrack): { isMono: boolean; category?: DaoCategory } {
  const activeNodes = ring.slots.filter((n) => n !== null);
  if (activeNodes.length < 2) return { isMono: false };
  const firstCat = activeNodes[0]!.category;
  const isMono = activeNodes.every((n) => n!.category === firstCat);
  return { isMono, category: isMono ? firstCat : undefined };
}

/** 创建初始能量束注入 Ring 0 / Slot 0 */
function makeInitialPulse(relicMods: RelicModifiers, tribulation?: TribulationConfig | null): EnergyPulse {
  let ttl = BOARD.initialTtl + (relicMods.ttlBonus ?? 0);
  if (tribulation?.modifiers.ttlPenalty) {
    ttl = Math.max(1, ttl - tribulation.modifiers.ttlPenalty);
  }

  return {
    id: 'P0',
    baseQi: BOARD.initialBaseQi,
    multiplier: BOARD.initialMultiplier,
    ringIdx: 0,
    slotIdx: 0,
    ttl,
    stepsInCurrentRing: 0,
    jumpCount: 0,
    reverseCount: 0,
  };
}

/** 空仿真结果 */
function emptyResult(): SimulationResult {
  return { turnQiGenerated: 0, logs: [], totalSpawned: 0, releasedCount: 0, expiredCount: 0 };
}

/**
 * 阵盘传导仿真
 */
export function simulateBoardTick(
  board: RingTrack[],
  rng: Rng = Math.random,
  options: SimulationOptions = {},
): SimulationResult {
  const logs: SimulationLogEntry[] = [];
  let seq = 0;
  let tick = 0;

  const relicMods = aggregateRelicModifiers(options.relics);
  const trib = options.tribulation;

  const log = (p: EnergyPulse, action: string, detail: string, qiDelta?: number): void => {
    logs.push({
      seq: seq++,
      pulseId: p.id,
      ringIdx: p.ringIdx,
      slotIdx: p.slotIdx,
      action,
      detail,
      ...(qiDelta === undefined ? {} : { qiDelta }),
    });
  };

  const unlockedRings = board.filter((r) => r.unlocked).length;
  const activeQueue: EnergyPulse[] = [makeInitialPulse(relicMods, trib)];
  let totalSpawned = 1;
  let turnQiGenerated = 0;
  let releasedCount = 0;
  let expiredCount = 0;

  while (activeQueue.length > 0 && tick < BOARD.maxTicksPerTurn) {
    tick += 1;
    const pulse = activeQueue.shift()!;
    const ring = board[pulse.ringIdx];

    let forcedCrossRing = false;
    let skipTtlDecay = false;

    // ---------- 步骤 A：触发当前槽位道韵 ----------
    const node = ring.slots[pulse.slotIdx];
    if (node !== null) {
      const cfg = getDaoConfig(node.configId);
      const params = getLevelParams(node.configId, node.level);
      const ringResonance = checkRingResonance(ring);

      // 1. 同环共鸣加成倍率 (1.25x)
      const resonanceFactor = ringResonance.isMono ? 1.25 : 1.0;

      // 2. 道法连携检查 (Sequence Synergy)
      if (pulse.lastCategory === 'AMPLIFY' && node.category === 'AMPLIFY') {
        pulse.multiplier += 0.3;
        log(pulse, 'SYNERGY', `【道法连携·聚气生锋】连续增幅，倍率+0.3→${pulse.multiplier.toFixed(2)}`);
      } else if (pulse.lastCategory === 'CONDUCT' && node.category === 'CONDUCT') {
        pulse.ttl += 1;
        log(pulse, 'SYNERGY', `【道法连携·虚空借道】连续传导，TTL+1→${pulse.ttl}`);
      }

      switch (cfg.effect) {
        // ---- 释放类 ----
        case 'RELEASE_BURST':
        case 'RELEASE_SWORD': {
          let factor = (params.releaseFactor ?? 1) + (relicMods.releaseFactorBonus ?? 0);
          if (cfg.effect === 'RELEASE_SWORD') {
            factor *= 1 + (params.ttlBonusFactor ?? 0) * pulse.ttl;
          }
          // 极尽升华连携：上一步若是增幅，释放系数额外 +0.2
          if (pulse.lastCategory === 'AMPLIFY') {
            factor += 0.2;
            log(pulse, 'SYNERGY', `【道法连携·极尽升华】增幅直入释放，系数+0.2`);
          }
          // 天劫释放加成
          if (trib?.modifiers.releaseMultiplierBonus) {
            factor *= 1 + trib.modifiers.releaseMultiplierBonus;
          }
          // 同环纯色共鸣加成
          factor *= resonanceFactor;

          const qi = Math.floor(pulse.baseQi * pulse.multiplier * factor);
          turnQiGenerated += qi;
          releasedCount += 1;
          log(
            pulse,
            'RELEASE',
            `${node.name}(LV${node.level})${ringResonance.isMono ? '【共鸣】' : ''} · ${pulse.baseQi} × ${pulse.multiplier.toFixed(2)} × ${factor.toFixed(2)}`,
            qi,
          );
          continue; // 能量束终结
        }

        // ---- 增幅类 ----
        case 'GATHER': {
          const add = Math.round((params.baseQiAdd ?? 0) * resonanceFactor);
          pulse.baseQi += add;
          log(pulse, 'AMPLIFY', `${node.name}${ringResonance.isMono ? '【共鸣】' : ''} · baseQi+${add}→${pulse.baseQi}`);
          break;
        }
        case 'CRIT': {
          const multAdd = (params.multiplierAdd ?? 0) * resonanceFactor;
          pulse.multiplier += multAdd;

          const critChance = (params.critChance ?? 0) + (relicMods.critChanceBonus ?? 0);
          const critFactor = (params.critFactor ?? 1) + (relicMods.critFactorBonus ?? 0);

          let detail = `${node.name}${ringResonance.isMono ? '【共鸣】' : ''} · 倍率+${multAdd.toFixed(2)}→${pulse.multiplier.toFixed(2)}`;
          if (rng() < critChance) {
            pulse.multiplier *= critFactor;
            detail += ` · 暴击×${critFactor.toFixed(2)}→${pulse.multiplier.toFixed(2)}`;
          }
          log(pulse, 'AMPLIFY', detail);
          break;
        }
        case 'RESONANCE': {
          const gain = (params.multiplierPerJump ?? 0) * pulse.jumpCount * resonanceFactor;
          pulse.multiplier += gain;
          log(pulse, 'AMPLIFY', `${node.name}${ringResonance.isMono ? '【共鸣】' : ''} · 升环${pulse.jumpCount}次 · 倍率+${gain.toFixed(2)}→${pulse.multiplier.toFixed(2)}`);
          break;
        }

        // ---- 传导类 ----
        case 'FORCE_JUMP': {
          pulse.baseQi += params.baseQiBonus ?? 0;
          if (pulse.ringIdx + 1 < unlockedRings) {
            const nextRing = board[pulse.ringIdx + 1];

            // 太虚神行灵宝：升维跃迁时克隆衍生能量束（顺位偏移下一格）
            if (relicMods.jumpCloneChance && rng() < relicMods.jumpCloneChance && totalSpawned < BOARD.maxPulses) {
              const clone: EnergyPulse = {
                ...pulse,
                id: `P${totalSpawned}`,
                slotIdx: (pulse.slotIdx + 1) % ring.maxSlots,
              };
              activeQueue.push(clone);
              totalSpawned += 1;
              log(pulse, 'RELIC_CLONE', `【太虚神行】跃迁克隆衍生出 1 股新能量至 Slot${clone.slotIdx}`);
            }

            pulse.slotIdx = Math.floor((pulse.slotIdx * nextRing.maxSlots) / ring.maxSlots);
            pulse.ringIdx += 1;
            pulse.stepsInCurrentRing = 0;
            pulse.jumpCount += 1;
            forcedCrossRing = true;
            skipTtlDecay = true;
            log(pulse, 'FORCE_JUMP', `${node.name} · 升环→Ring${pulse.ringIdx} Slot${pulse.slotIdx} · baseQi=${pulse.baseQi}（免TTL）`);
          } else {
            log(pulse, 'FORCE_JUMP', `${node.name} · 已在最外环 · baseQi=${pulse.baseQi}`);
          }
          break;
        }
        case 'REVERSE_FLOW': {
          if (
            pulse.ringIdx > 0 &&
            pulse.reverseCount < (params.maxTriggers ?? 0) &&
            rng() < (params.reverseChance ?? 0)
          ) {
            const innerRing = board[pulse.ringIdx - 1];
            pulse.slotIdx = Math.floor((pulse.slotIdx * innerRing.maxSlots) / ring.maxSlots);
            pulse.ringIdx -= 1;
            pulse.stepsInCurrentRing = 0;
            pulse.reverseCount += 1;
            pulse.ttl += params.ttlRestore ?? 0;
            forcedCrossRing = true;
            log(pulse, 'REVERSE_FLOW', `${node.name} · 倒灌→Ring${pulse.ringIdx} Slot${pulse.slotIdx} · TTL+${params.ttlRestore}→${pulse.ttl}（${pulse.reverseCount}/${params.maxTriggers}）`);
          }
          break;
        }
        case 'CHAIN_SPLIT': {
          const guaranteed = params.guaranteedSplits ?? 0;
          const extra = rng() < (params.extraSplitChance ?? 0) ? 1 : 0;
          const splitCount = guaranteed + extra;
          let spawned = 0;
          for (let i = 0; i < splitCount; i += 1) {
            if (totalSpawned >= BOARD.maxPulses) {
              log(pulse, 'SPLIT_LIMIT', `衍生能量已达上限 ${BOARD.maxPulses}，停止分裂`);
              break;
            }
            const clone: EnergyPulse = {
              ...pulse,
              id: `P${totalSpawned}`,
              slotIdx: (pulse.slotIdx + 1 + i) % ring.maxSlots,
            };
            activeQueue.push(clone);
            totalSpawned += 1;
            spawned += 1;
          }
          log(pulse, 'CHAIN_SPLIT', `${node.name} · 分裂${spawned}股（额外${((params.extraSplitChance ?? 0) * 100).toFixed(0)}%）`);
          break;
        }
      }

      pulse.lastCategory = node.category;
    }

    // ---------- 步骤 B：步数寿命衰减 ----------
    if (!skipTtlDecay) {
      // 天衍神算灵宝：顺时针巡航时概率免扣 TTL
      if (relicMods.freeCruiseChance && rng() < relicMods.freeCruiseChance) {
        log(pulse, 'CRUISE_LUCKY', `【天衍神算】灵光一闪，本次位移免扣 TTL（剩余 ${pulse.ttl}）`);
      } else {
        pulse.ttl -= 1;
        if (pulse.ttl <= 0) {
          expiredCount += 1;
          log(pulse, 'EXPIRE', '步数耗尽消散（得分 0）');
          continue;
        }
      }
    }

    // ---------- 步骤 C：默认移动与满圈自动升环 ----------
    if (!forcedCrossRing) {
      const currentRing = board[pulse.ringIdx];
      pulse.stepsInCurrentRing += 1;
      if (pulse.stepsInCurrentRing >= currentRing.maxSlots) {
        if (pulse.ringIdx + 1 < unlockedRings) {
          const nextRing = board[pulse.ringIdx + 1];
          pulse.slotIdx = Math.floor((pulse.slotIdx * nextRing.maxSlots) / currentRing.maxSlots);
          pulse.ringIdx += 1;
          pulse.stepsInCurrentRing = 0;
          pulse.jumpCount += 1;

          // 五行转轮灵宝：升环增加 baseQi
          if (relicMods.ascendBaseQiBonus) {
            pulse.baseQi += relicMods.ascendBaseQiBonus;
            log(pulse, 'AUTO_ASCEND', `走满一圈 · 自动升环→Ring${pulse.ringIdx} Slot${pulse.slotIdx} · 【五行转轮】baseQi+${relicMods.ascendBaseQiBonus}→${pulse.baseQi}`);
          } else {
            log(pulse, 'AUTO_ASCEND', `走满一圈 · 自动升环→Ring${pulse.ringIdx} Slot${pulse.slotIdx}`);
          }
        } else {
          pulse.slotIdx = (pulse.slotIdx + 1) % currentRing.maxSlots;
          log(pulse, 'OUTER_LOOP', `最外环巡航→Slot${pulse.slotIdx}`);
        }
      } else {
        pulse.slotIdx = (pulse.slotIdx + 1) % currentRing.maxSlots;
        log(pulse, 'MOVE', `顺时针→Slot${pulse.slotIdx}（${pulse.stepsInCurrentRing}/${currentRing.maxSlots}）`);
      }
    }

    activeQueue.push(pulse);
  }

  if (tick >= BOARD.maxTicksPerTurn && activeQueue.length > 0) {
    log(makeInitialPulse(relicMods, trib), 'TICK_LIMIT', `达到步数上限 ${BOARD.maxTicksPerTurn}，剩余 ${activeQueue.length} 股能量强制回收`);
  }

  return { turnQiGenerated, logs, totalSpawned, releasedCount, expiredCount };
}

/**
 * 完整运转（步骤 1 扣费 + 步骤 2~3 仿真 + 步骤 4 结算与免死判定）
 */
export function runTurn(
  state: GameState,
  rng: Rng = Math.random,
): { result: SimulationResult; charged: number; cleared: boolean } {
  if (state.isGameOver || state.isVictory) return { result: emptyResult(), charged: 0, cleared: false };

  // 灵宝加成解析
  const relicMods = aggregateRelicModifiers(state.relics);

  // 步骤 1：前置检定与扣费
  let charged = 0;
  if (state.freeTurnsLeft > 0) {
    // 天劫赋予的免费运转
    charged = 0;
    state.freeTurnsLeft -= 1;
  } else {
    // 检查气池是否足够
    if (state.currentQi < state.nextQiCost) {
      // 逆天改命免死判定 (天道生机)
      if (relicMods.hasRebirth && !state.rebirthUsed) {
        state.rebirthUsed = true;
        state.currentQi += 30;
      } else {
        state.isGameOver = true;
        return { result: emptyResult(), charged: 0, cleared: false };
      }
    }

    charged = Math.min(state.currentQi, state.nextQiCost);
    state.currentQi -= charged;
  }

  // 灵宝“混沌青莲”每轮运转额外补助真气
  if (relicMods.initialQiPerTurnBonus) {
    state.currentQi += relicMods.initialQiPerTurnBonus;
  }

  state.turnCountInStage += 1;
  state.runStats.turnsPlayed += 1;

  // 动态指数（九霄神雷可能重载指数）
  const exponent = state.activeTribulation?.modifiers.costExponentOverride ?? BOARD.qiCostExponent;
  state.nextQiCost = calcQiCost(
    getStageConfig(state.realm, state.subStage).baseCost,
    state.turnCountInStage + 1,
    exponent,
  );

  // 步骤 2~3：传导仿真
  const result = simulateBoardTick(state.board, rng, {
    relics: state.relics,
    tribulation: state.activeTribulation,
  });

  // 步骤 4：气池结算与破关判定
  state.currentQi += result.turnQiGenerated;
  state.runStats.totalQiGenerated += result.turnQiGenerated;
  state.runStats.highestSingleQi = Math.max(state.runStats.highestSingleQi, result.turnQiGenerated);

  const cleared = result.turnQiGenerated >= state.stageThreshold;
  if (cleared) {
    state.runStats.stagesCleared += 1;
  }

  return { result, charged, cleared };
}
