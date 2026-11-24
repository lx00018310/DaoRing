import { animationDirector } from './animationQueue';
import { orbArtPath } from './battle/daoVisual';
import { attachOrbJuice } from './battle/orbJuice';
import { sound } from './audio';
import { createDao, getDaoConfig } from './config';
import { DEMO_CONFIG, demoAnalytics, demoSession } from './demoConfig';
import {
  canRecallDao, createDemoInitialGameState, executeDemoTurn, generateUid, getEffectiveQiCost,
  moveDao, placeDao, recallDao, removeDao,
  type PlacementResult, type TurnExecutionResult,
} from './game';
import type { DaoCategory, DaoRhyme, SimulationLogEntry } from './types';

type ActionState =
  | { mode: 'IDLE' }
  | { mode: 'SELECT_FUEL_OVERWRITE'; slot: number; cardUid: string }
  | { mode: 'SELECT_FUEL_REMOVE'; slot: number }
  | { mode: 'SELECT_MOVE_DEST'; from: number }
  | { mode: 'SELECT_FUEL_MOVE'; from: number; to: number };

let state = createDemoInitialGameState();
let isExecuting = false;
let lastTurnQi: number | null = null;
let lastTurnTribulation: string | undefined;
let lastTurnBoard: string | null = null;
let midBranch: string | null = null;
let selectedCardUid: string | null = null;
let action: ActionState = { mode: 'IDLE' };
let finishPlaybackRecord: ((skipped: boolean) => void) | null = null;

const byId = <T extends HTMLElement | SVGElement = HTMLElement>(id: string) => document.getElementById(id)! as unknown as T;
const stepEls = [1, 2, 3].map((stage) => byId(`step-${stage}`));
const statQi = byId('stat-qi');
const statTarget = byId('stat-target');
const statCost = byId('stat-cost');
const stageCircle = byId('circle-stage');
const handDeck = byId('hand-deck');
const hint = byId('hint-bar');
const feedback = byId('action-feedback');
const btnRun = byId<HTMLButtonElement>('btn-run');
const btnReset = byId<HTMLButtonElement>('btn-reset');
const btnSkip = byId<HTMLButtonElement>('btn-skip');
const btnAudio = byId<HTMLButtonElement>('btn-audio');
const btnToggleLog = byId<HTMLButtonElement>('btn-toggle-log');
const drawer = byId('dev-log-drawer');
const log = byId('log');
const modal = byId<HTMLDialogElement>('modal-layer');
const modalCard = byId('modal-card');
const burstDelta = byId('burst-delta');
const burstTotal = byId('burst-total');
const burstCompare = byId('burst-compare');
const dantian = byId('dantian-core');
const meridians = [...byId('meridian-network').querySelectorAll<SVGPathElement>('.meridian-path')];
const cocoon = byId('cocoon-hull');
const cracks = [...byId('cocoon-cracks').querySelectorAll('.crack-line')];
const shockwaves = [byId('shockwave-ring-1'), byId('shockwave-ring-2')];
const finaleTitle = byId('finale-title');
const pulseLayer = byId<SVGGElement>('energy-pulses');
const slots = [0, 1, 2, 3].map((slot) => byId<HTMLButtonElement>(`slot-${slot}`));
const convergeLines = slots.map((_, slot) => byId(`conv-${slot}`));
const tracks = slots.map((_, slot) => byId<SVGPathElement>(`track-${slot}-${(slot + 1) % slots.length}`));

const SLOT_NAMES = ['第一眼 · 入气', '第二眼', '第三眼', '第四眼'];
const CATEGORY: Record<DaoCategory, { label: string; badge: string }> = {
  CONDUCT: { label: '传导', badge: 'badge-conduct' },
  AMPLIFY: { label: '增幅', badge: 'badge-amplify' },
  RELEASE: { label: '释放', badge: 'badge-release' },
};

const locked = () => isExecuting || modal.open || state.isVictory || state.isGameOver;

function renderHud(): void {
  stepEls.forEach((el, i) => {
    el.classList.toggle('cleared', i + 1 < state.subStage || state.isVictory);
    el.classList.toggle('active', i + 1 === state.subStage && !state.isVictory && !state.isGameOver);
  });
  const cost = getEffectiveQiCost(state);
  statQi.textContent = String(state.currentQi);
  statTarget.textContent = String(state.stageThreshold);
  statCost.textContent = state.freeTurnsLeft > 0 ? `0 · 余 ${state.freeTurnsLeft} 次` : String(cost);
  statCost.className = `stat-val ${state.freeTurnsLeft > 0 ? 'val-green' : state.currentQi < cost ? 'val-red' : 'val-purple'}`;
  btnRun.disabled = locked() || action.mode !== 'IDLE';
  btnRun.textContent = isExecuting ? '周天运转中…' : '运转周天';
  btnSkip.style.display = isExecuting ? 'inline-block' : 'none';
}

function cardTags(card: DaoRhyme): string {
  const category = CATEGORY[card.category];
  return `<span class="slot-cat-badge ${category.badge}">${category.label}</span>
    <span class="slot-level-tag">LV${card.level}</span>`;
}

function recommendedSlot(card?: DaoRhyme): number | undefined {
  if (state.subStage === 1) {
    if (card?.configId === 'dao_gather') return 1;
    if (card?.configId === 'dao_burst') return 3;
  }
  return DEMO_CONFIG.midStageChoices.find((choice) => choice.configId === card?.configId)?.recommendedSlot;
}

function renderBoard(): void {
  const board = state.board[0].slots;
  const selected = state.hand.find((card) => card.uid === selectedCardUid);
  const nextStarter = state.subStage === 1 ? state.hand.find((card) => recommendedSlot(card) !== undefined) : undefined;
  const recommendation = action.mode === 'IDLE' ? recommendedSlot(selected ?? nextStarter) : undefined;
  const fuelSlot = action.mode === 'SELECT_FUEL_OVERWRITE' || action.mode === 'SELECT_FUEL_REMOVE'
    ? action.slot
    : action.mode === 'SELECT_FUEL_MOVE' ? action.to : undefined;

  board.forEach((card, index) => {
    const el = slots[index];
    el.className = `slot-node slot-pos-${index} ${card ? 'occupied' : 'empty'}`;
    el.classList.toggle('target-active', !card && (action.mode === 'SELECT_MOVE_DEST' || (action.mode === 'IDLE' && !!selected)));
    el.classList.toggle('recommended', !card && index === recommendation);
    el.classList.toggle('fuel-destination', index === fuelSlot);
    el.setAttribute('aria-label', `${SLOT_NAMES[index]}，${card ? card.name : '空槽'}`);
    el.innerHTML = card
      ? `<img class="slot-orb-bg" src="${orbArtPath(card.configId)}" alt="" aria-hidden="true" draggable="false" />` +
        `<span class="slot-badge-row">${cardTags(card)}</span><span class="slot-card-name">${card.name}</span>`
      : '<span class="slot-empty-label">+ 空槽</span>';
    const label = document.createElement('span');
    label.className = index === 0 ? 'slot-empty-label entrance' : 'slot-empty-label';
    label.textContent = SLOT_NAMES[index];
    el.append(label);
    el.onclick = () => onSlotClick(index);
  });
}

function renderHand(): void {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.cardUid : undefined;
  const nextStarter = state.subStage === 1 && !selectedCardUid ? state.hand[0]?.uid : undefined;
  const elements = state.hand.map((card) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.cardUid = card.uid;
    button.dataset.configId = card.configId;
    button.className = `hand-card dao-orb-mini cat-${card.category}`;
    button.classList.toggle('selected', card.uid === selectedCardUid);
    button.classList.toggle('recommended', card.uid === nextStarter);
    button.disabled = action.mode === 'SELECT_MOVE_DEST' ||
      (action.mode === 'SELECT_FUEL_OVERWRITE' && action.cardUid === card.uid);
    button.setAttribute('aria-pressed', String(card.uid === selectedCardUid));
    button.title = `${card.name} LV${card.level}：${card.description}`;
    button.innerHTML = `
      <span class="mini-orb-wrap">
        <span class="mini-orb-ring" aria-hidden="true"></span>
        <img class="mini-orb-art" src="${orbArtPath(card.configId)}" alt="" draggable="false" />
        <span class="mini-orb-sheen" aria-hidden="true"></span>
        <span class="slot-level-tag mini-lv">LV${card.level}</span>
      </span>
      <span class="card-name">${card.name}</span>
      <span class="card-desc">${card.description}</span>`;
    button.onclick = () => onCardClick(card);
    return button;
  });
  const scrollLeft = handDeck.scrollLeft;
  handDeck.replaceChildren(...elements);
  handDeck.scrollLeft = scrollLeft;
  if (focused) {
    const target = elements.find((el) => el.dataset.cardUid === focused && !el.disabled) ??
      elements.find((el) => !el.disabled);
    (target ?? btnRun).focus({ preventScroll: true });
  }
}

function updateHint(): void {
  const selected = state.hand.find((card) => card.uid === selectedCardUid);
  let text: string;
  switch (action.mode) {
    case 'SELECT_FUEL_OVERWRITE':
      text = `${SLOT_NAMES[action.slot]} · 用${selected?.name}覆盖${state.board[0].slots[action.slot]?.name}。旧道韵与所选燃料均会消耗。`;
      break;
    case 'SELECT_FUEL_REMOVE':
      text = `拆除${SLOT_NAMES[action.slot]}。选择 1 张手牌作为燃料。`;
      break;
    case 'SELECT_MOVE_DEST':
      text = `移位${SLOT_NAMES[action.from]}的道韵。先选择一个空槽。`;
      break;
    case 'SELECT_FUEL_MOVE':
      text = `移到${SLOT_NAMES[action.to]}。选择 1 张手牌作为燃料。`;
      break;
    default: {
      if (selected) {
        const destination = recommendedSlot(selected);
        const suggestion = destination === undefined ? '选择一个空槽' : `建议放入${SLOT_NAMES[destination]}`;
        const release = selected.category === 'RELEASE' ? '。灵气在这里结算，后续阵眼可能不触发' : '';
        text = `已选${selected.name} · ${suggestion}${release}。`;
      } else if (state.subStage === 1 && state.hand.length) {
        text = `开局布阵 · ${state.hand[0].name}放入${SLOT_NAMES[recommendedSlot(state.hand[0]) ?? 0]}。`;
      } else {
        text = state.hand.length ? '选牌、落阵，或点击已布置的阵眼调整。' : '阵盘已就绪。点击「运转周天」查看结果。';
      }
    }
  }
  hint.textContent = text;
  hint.classList.toggle('active', action.mode !== 'IDLE' || !!selected);
  if (action.mode !== 'IDLE') {
    const cancel = document.createElement('button');
    cancel.className = 'hint-cancel';
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.onclick = () => cancelAction();
    hint.append(' ', cancel);
  }
}

function renderAll(): void {
  renderHud();
  renderBoard();
  renderHand();
  updateHint();
}

function setFeedback(text = '', warning = false): void {
  feedback.textContent = text;
  feedback.hidden = !text;
  feedback.classList.toggle('warn', warning);
}

function resetAction(): void {
  action = { mode: 'IDLE' };
  selectedCardUid = null;
}

function cancelAction(): void {
  resetAction();
  setFeedback();
  attachOrbJuice(handDeck, '.hand-card');
renderAll();
}

function resolvePlacement(result: PlacementResult, slot: number): void {
  resetAction();
  setFeedback(result.success ? '' : result.message, !result.success);
  renderAll();
  slots[slot].focus({ preventScroll: true });
}

function onCardClick(card: DaoRhyme): void {
  if (locked()) return;
  sound.unlock();
  setFeedback();
  switch (action.mode) {
    case 'SELECT_FUEL_OVERWRITE':
      resolvePlacement(placeDao(state, action.cardUid, 0, action.slot, card.uid), action.slot);
      return;
    case 'SELECT_FUEL_REMOVE':
      resolvePlacement(removeDao(state, 0, action.slot, card.uid), action.slot);
      return;
    case 'SELECT_FUEL_MOVE':
      resolvePlacement(moveDao(state, 0, action.from, 0, action.to, card.uid), action.to);
      return;
    case 'SELECT_MOVE_DEST':
      return;
    default:
      selectedCardUid = selectedCardUid === card.uid ? null : card.uid;
      renderAll();
  }
}

function onSlotClick(slot: number): void {
  if (locked()) return;
  sound.unlock();
  setFeedback();
  const occupant = state.board[0].slots[slot];
  if (action.mode === 'SELECT_MOVE_DEST') {
    if (occupant) {
      setFeedback('移位目标必须是空槽。', true);
      return;
    }
    action = { mode: 'SELECT_FUEL_MOVE', from: action.from, to: slot };
    renderAll();
    return;
  }
  if (action.mode !== 'IDLE') {
    setFeedback('请从手牌选择燃料，或先取消当前操作。', true);
    return;
  }
  if (!selectedCardUid) {
    if (occupant) showSlotMenu(slot, occupant);
    else setFeedback('先选一张手牌，再点这个阵眼。', true);
    return;
  }
  if (occupant) {
    if (state.hand.length < 2) {
      setFeedback('覆盖需要待放入的道韵和另一张燃料牌。', true);
      return;
    }
    action = { mode: 'SELECT_FUEL_OVERWRITE', slot, cardUid: selectedCardUid };
    renderAll();
    return;
  }

  const result = placeDao(state, selectedCardUid, 0, slot);
  if (result.success) {
    demoAnalytics.track('first_card_placed', { stage: `${state.realm}-${state.subStage}`, detail: SLOT_NAMES[slot] });
  }
  resolvePlacement(result, slot);
  const reachedRelease = state.board[0].slots.findIndex((card) => card?.category === 'RELEASE');
  if (result.success && reachedRelease >= 0 && state.board[0].slots.slice(reachedRelease + 1)
    .some((card) => card && card.category !== 'RELEASE')) {
    setFeedback('灵气先遇到释放道韵，后面的增幅或分裂可能来不及触发。', true);
  }
}

let dismissibleDialog = false;

function openDialog(content: string, dismissible = false): void {
  dismissibleDialog = dismissible;
  modalCard.innerHTML = content;
  modal.showModal();
  renderHud();
  modalCard.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}

function closeDialog(): void {
  if (modal.open) modal.close();
  renderHud();
}

function showSlotMenu(slot: number, card: DaoRhyme): void {
  const canMove = state.board[0].slots.includes(null) && state.hand.length > 0;
  openDialog(`
    <h2 class="modal-title" id="modal-title">${SLOT_NAMES[slot]} · ${card.name}</h2>
    <p class="modal-desc">${card.description}</p>
    <div class="modal-btn-row">
      ${canRecallDao(state, 0, slot) ? '<button class="btn btn-primary" id="menu-recall">收回道韵</button>' : ''}
      <button class="btn btn-secondary" id="menu-move" ${canMove ? '' : 'disabled'}>移位 · 1 张燃料</button>
      <button class="btn btn-warning" id="menu-remove" ${state.hand.length ? '' : 'disabled'}>拆除 · 1 张燃料</button>
    </div>
    ${canMove ? '' : `<p class="modal-desc">${state.hand.length ? '阵盘已满，移位需要一个空槽。' : '拆除和移位都需要一张手牌作为燃料。'}</p>`}
    <button class="btn btn-secondary" id="menu-cancel">取消</button>`, true);

  byId<HTMLButtonElement>('menu-cancel').onclick = closeDialog;
  modalCard.querySelector<HTMLButtonElement>('#menu-recall')?.addEventListener('click', () => {
    closeDialog();
    resolvePlacement(recallDao(state, 0, slot), slot);
  });
  byId<HTMLButtonElement>('menu-move').onclick = () => {
    closeDialog();
    action = { mode: 'SELECT_MOVE_DEST', from: slot };
    renderAll();
  };
  byId<HTMLButtonElement>('menu-remove').onclick = () => {
    closeDialog();
    action = { mode: 'SELECT_FUEL_REMOVE', slot };
    renderAll();
  };
}

const visualTimers = new Set<ReturnType<typeof setTimeout>>();
const trackTimers = new Map<SVGPathElement, ReturnType<typeof setTimeout>>();
const pulseFrames = new Map<string, number>();
const pulseDots = new Map<string, SVGCircleElement>();
let deltaTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleEffect(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    visualTimers.delete(timer);
    callback();
  }, delay);
  visualTimers.add(timer);
  return timer;
}

function cancelEffect(timer?: ReturnType<typeof setTimeout>): void {
  if (timer === undefined) return;
  clearTimeout(timer);
  visualTimers.delete(timer);
}

function removePulse(pulseId: string): void {
  const frame = pulseFrames.get(pulseId);
  if (frame !== undefined) cancelAnimationFrame(frame);
  pulseFrames.delete(pulseId);
  pulseDots.get(pulseId)?.remove();
  pulseDots.delete(pulseId);
}

function spawnPulse(pulseId: string, slot: number): SVGCircleElement {
  const existing = pulseDots.get(pulseId);
  if (existing) return existing;
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  const point = tracks[slot].getPointAtLength(0);
  // 静止光点贴阵眼右缘，触发文字仍能读清。
  const offset = Math.min(25, 14 + pulseDots.size * 6);
  dot.setAttribute('cx', String(point.x + offset));
  dot.setAttribute('cy', String(point.y - 25));
  dot.setAttribute('r', pulseId === 'P0' ? '7' : '6');
  dot.setAttribute('class', pulseId === 'P0' ? 'energy-pulse' : 'energy-pulse branch');
  dot.dataset.pulse = pulseId;
  pulseLayer.append(dot);
  pulseDots.set(pulseId, dot);
  return dot;
}

function movePulse(pulseId: string, from: number, to: number, duration: number): void {
  if (to !== (from + 1) % slots.length) return;
  const dot = spawnPulse(pulseId, from);
  const previous = pulseFrames.get(pulseId);
  if (previous !== undefined) cancelAnimationFrame(previous);
  const path = tracks[from];
  const length = path.getTotalLength();
  const start = performance.now();
  const frame = (time: number) => {
    const progress = Math.min(1, (time - start) / Math.max(1, duration));
    const point = path.getPointAtLength(length * progress);
    const arrival = Math.max(0, (progress - 0.86) / 0.14);
    dot.setAttribute('cx', String(point.x + arrival * 16));
    dot.setAttribute('cy', String(point.y - arrival * 25));
    if (progress < 1) pulseFrames.set(pulseId, requestAnimationFrame(frame));
    else pulseFrames.delete(pulseId);
  };
  pulseFrames.set(pulseId, requestAnimationFrame(frame));
}

function setSlotHighlight(slot: number, level: 'active' | 'amplify' | 'release' | null): void {
  slots[slot].classList.remove('active-pulse', 'amplify-pulse', 'release-pulse');
  if (level) slots[slot].classList.add(`${level}-pulse`);
}

function clearEffects(): void {
  visualTimers.forEach((timer) => clearTimeout(timer));
  visualTimers.clear();
  trackTimers.clear();
  deltaTimer = undefined;
  pulseDots.forEach((_, pulseId) => removePulse(pulseId));
  stageCircle.querySelectorAll('.float-notice').forEach((el) => el.remove());
  slots.forEach((_, index) => setSlotHighlight(index, null));
  slots.forEach((slot) => slot.classList.remove('converge-source'));
  [...tracks, ...convergeLines, ...meridians, ...cracks, ...shockwaves, cocoon]
    .forEach((el) => el.classList.remove('active'));
  dantian.classList.remove('gold');
  stageCircle.classList.remove('screen-shake');
  burstDelta.style.opacity = '0';
  finaleTitle.hidden = true;
}

function clearScore(): void {
  burstTotal.classList.remove('visible');
  burstCompare.classList.remove('visible');
  burstDelta.textContent = '';
  burstTotal.textContent = '';
  burstCompare.textContent = '';
}

function releaseSummary(result: TurnExecutionResult): string {
  const releases = result.simulation.logs.filter((entry) => entry.action === 'RELEASE');
  const total = result.simulation.turnQiGenerated;
  if (!releases.length) return '本轮没有释放';
  if (releases.length === 1) return `1 次释放 · ${total}`;
  if (releases.length <= 4) return `${releases.map((entry) => entry.qiDelta ?? 0).join(' + ')} = ${total}`;
  return `${releases.length} 次释放 · 合计 ${total}`;
}

function runTurnAction(): void {
  if (locked() || action.mode !== 'IDLE') return;
  sound.unlock();
  resetAction();
  setFeedback();
  clearEffects();
  clearScore();
  isExecuting = true;
  renderHud();

  const boardSlots = state.board[0].slots.map((card) => card?.configId ?? null);
  const boardKey = JSON.stringify(boardSlots);
  const result = executeDemoTurn(state);
  const { context, simulation } = result;
  const tribulation = context.activeTribulation;
  const tally = releaseSummary(result);
  const fields = {
    stage: `${context.realm}-${context.subStage}`,
    turnIndex: context.turnIndex,
    stageThreshold: context.stageThreshold,
    effectiveCost: context.effectiveCost,
    charged: result.charged,
    qiGenerated: simulation.turnQiGenerated,
    tribulationId: tribulation?.id,
    boardSlots,
    branchChoice: midBranch ?? undefined,
    boardModified: lastTurnBoard !== null && lastTurnBoard !== boardKey,
  };
  lastTurnBoard = boardKey;
  writeTurnLog(result);
  if (simulation.totalSpawned > 0) demoAnalytics.track('first_run', fields);
  demoAnalytics.track('turn_resolved', fields);
  if (result.cleared) demoAnalytics.track('stage_clear', fields);

  let watchedRelease = false;
  const firstRelease = simulation.releasedCount > 0
    ? demoAnalytics.track('first_release', { ...fields, watchedRelease: false, skipped: false })
    : undefined;
  finishPlaybackRecord = (skipped) => {
    if (firstRelease) demoAnalytics.recordPlayback(firstRelease, watchedRelease, skipped);
  };

  void animationDirector.playTurn(result, result.isVictory, result.cleared && !result.isVictory, {
    setSlotHighlight,
    spawnPulse,
    movePulse,
    removePulse,
    highlightTrack: (from, to) => {
      if (to !== (from + 1) % slots.length) return;
      const track = tracks[from];
      cancelEffect(trackTimers.get(track));
      track.classList.add('active');
      trackTimers.set(track, scheduleEffect(() => {
        track.classList.remove('active');
        trackTimers.delete(track);
      }, 320));
    },
    spawnFloatText: (slot, text, type) => {
      const position = slots[slot].getBoundingClientRect();
      const origin = stageCircle.getBoundingClientRect();
      const float = document.createElement('div');
      float.className = `float-notice float-${type}`;
      float.textContent = text;
      float.style.left = `${position.left + position.width / 2 - origin.left}px`;
      float.style.top = `${position.top - origin.top}px`;
      stageCircle.append(float);
      scheduleEffect(() => float.remove(), 750);
    },
    updateBurstScore: (score, delta, final, summary) => {
      burstTotal.textContent = String(score);
      burstTotal.classList.add('visible');
      if (delta > 0 && !final) {
        cancelEffect(deltaTimer);
        burstDelta.textContent = summary ?? `+${delta}`;
        burstDelta.style.opacity = '1';
        deltaTimer = scheduleEffect(() => { burstDelta.style.opacity = '0'; }, 300);
      }
      if (final) {
        const comparison = lastTurnQi === null ? '' : ` · 上轮 ${lastTurnQi}`;
        const hazard = tribulation?.id !== lastTurnTribulation ? ` · ${tribulation?.name ?? '天劫已变更'}` : '';
        burstCompare.textContent = tally + comparison + hazard;
        burstCompare.classList.add('visible');
      }
    },
    onReleaseShown: () => { watchedRelease = true; },
    clearEffects,
    playMinorBreakthrough: async (wait) => {
      dantian.classList.add('gold');
      if (await wait(DEMO_CONFIG.timings.minorBreakthrough)) dantian.classList.remove('gold');
    },
    playGrandBreakthrough: async (reduced, releaseSlots, wait) => {
      const timing = DEMO_CONFIG.timings;
      if (reduced) {
        dantian.classList.add('gold');
        meridians.forEach((line) => line.classList.add('active'));
        finaleTitle.hidden = false;
        await wait(timing.reducedMotionFinale);
        return;
      }

      sound.playFinaleCharge();
      releaseSlots.forEach((slot) => {
        slots[slot].classList.add('converge-source');
        convergeLines[slot].classList.add('active');
      });
      if (!await wait(timing.finale.converge)) return;
      releaseSlots.forEach((slot) => slots[slot].classList.remove('converge-source'));

      sound.playFinaleMeridian();
      dantian.classList.add('gold');
      meridians.forEach((el, index) => {
        scheduleEffect(() => el.classList.add('active'), index * 85);
      });
      if (!await wait(timing.finale.meridian)) return;

      sound.playFinaleBreak();
      cocoon.classList.add('active');
      scheduleEffect(() => {
        cracks.forEach((el) => el.classList.add('active'));
        stageCircle.classList.add('screen-shake');
        scheduleEffect(() => stageCircle.classList.remove('screen-shake'), 250);
      }, 150);
      if (!await wait(timing.finale.breakCocoon)) return;

      sound.playFinaleComplete();
      cocoon.classList.remove('active');
      cracks.forEach((el) => el.classList.remove('active'));
      shockwaves.forEach((el) => el.classList.add('active'));
      slots.forEach((_, index) => scheduleEffect(() => setSlotHighlight(index, 'amplify'), index * 105));
      if (!await wait(timing.finale.shockwave)) return;

      convergeLines.forEach((el) => el.classList.remove('active'));
      finaleTitle.hidden = false;
      await wait(timing.finale.complete);
    },
    onComplete: () => {
      finishPlaybackRecord?.(animationDirector.skipped);
      finishPlaybackRecord = null;
      isExecuting = false;
      lastTurnQi = simulation.turnQiGenerated;
      lastTurnTribulation = tribulation?.id;
      renderAll();
      if (result.isGameOver) showGameOver(result);
      else if (result.isVictory) showVictory(result, tally);
      else if (result.cleared && context.subStage === 1) showMidChoice(result, tally);
      else if (result.cleared && context.subStage === 2) showZenithIntro(result, tally);
      else {
        const reason = simulation.releasedCount ? tally : '本轮没有释放，先检查阵盘是否放了释放道韵。';
        setFeedback(`${reason} · 剩余真气 ${state.currentQi} · 下次需要 ${getEffectiveQiCost(state)}`, simulation.releasedCount === 0);
        btnRun.focus({ preventScroll: true });
      }
    },
  }).catch((error: unknown) => console.warn('周天演出异常', error));
}

function addReward(configId: string): DaoRhyme {
  const card = createDao(configId, 1, generateUid('reward'));
  state.hand.push(card);
  return card;
}

function showMidChoice(result: TurnExecutionResult, tally: string): void {
  const choices = DEMO_CONFIG.midStageChoices;
  openDialog(`
    <h2 class="modal-title" id="modal-title">突破至炼气中期</h2>
    <p class="modal-desc">${tally} · 已达目标 ${result.context.stageThreshold}。下一关目标 ${state.stageThreshold}。</p>
    <div class="branch-choices">
      ${choices.map((choice) => `<button type="button" class="btn btn-secondary branch-card" data-id="${choice.configId}">
        <span>${choice.name}</span><span>${choice.advice}</span></button>`).join('')}
    </div>
    <p class="modal-desc">任选一张，另领一张聚灵，可布置或用作改阵燃料。</p>`);
  for (const button of modalCard.querySelectorAll<HTMLButtonElement>('.branch-card')) {
    button.onclick = () => {
      const chosen = choices.find((choice) => choice.configId === button.dataset.id);
      if (!modal.open || midBranch || !chosen) return;
      midBranch = chosen.configId;
      addReward(chosen.configId);
      addReward(DEMO_CONFIG.midStageBonusCardId);
      demoAnalytics.track('branch_chosen', { stage: '1-1', branchChoice: chosen.configId });
      closeDialog();
      clearScore();
      setFeedback(chosen.advice);
      renderAll();
      handDeck.querySelector<HTMLButtonElement>('button')?.focus();
    };
  }
}

function showZenithIntro(result: TurnExecutionResult, tally: string): void {
  const other = DEMO_CONFIG.midStageChoices.find((choice) => choice.configId !== midBranch);
  const rewards = [other?.configId, DEMO_CONFIG.zenithBonusCardId]
    .filter((id): id is string => id !== undefined).map((id) => getDaoConfig(id));
  const tribulation = result.tribulationEncountered ?? state.activeTribulation;
  const effect = tribulation?.modifiers.doubleLoot
    ? '运转耗气增长加快。'
    : tribulation?.description;
  openDialog(`
    <h2 class="modal-title" id="modal-title">炼气巅峰 · ${tribulation?.name ?? '天劫'}</h2>
    <p class="modal-desc">${tally} · 已达目标 ${result.context.stageThreshold}。下一关目标 ${state.stageThreshold}。</p>
    <p class="modal-desc">${effect ?? ''}</p>
    <p class="modal-desc">本次耗气 ${getEffectiveQiCost(state)}。迎战可领取${rewards.map((card) => card.name).join('、')}。</p>
    <button class="btn btn-primary" id="btn-enter-zenith">迎战天劫</button>`);
  byId<HTMLButtonElement>('btn-enter-zenith').onclick = () => {
    if (!modal.open) return;
    rewards.forEach((card) => addReward(card.configId));
    closeDialog();
    clearScore();
    setFeedback('检查天劫效果。补齐两种道韵的连携，或用万剑诀试一次更早的释放。');
    renderAll();
    handDeck.querySelector<HTMLButtonElement>('button')?.focus();
  };
}

function showVictory(result: TurnExecutionResult, tally: string): void {
  demoSession.markCleared();
  const highestQi = state.runStats.highestSingleQi;
  demoAnalytics.track('run_end', { highestQi, qiGenerated: result.simulation.turnQiGenerated, endType: 'VICTORY' });
  openDialog(`
    <h2 class="modal-title" id="modal-title">炼气圆满</h2>
    <p class="modal-desc">周天贯通，灵气入体。<br>${tally} · 破障目标 ${result.context.stageThreshold}</p>
    <div class="modal-score-box"><div class="modal-score-label">本局最高产气</div><div class="modal-score-val">${highestQi}</div></div>
    <button class="btn btn-primary" id="btn-replay">再修一局 · 随机天劫</button>
    <a class="btn btn-secondary" id="link-battle-victory" href="battle.html">进入斗法 · 炼气至化神</a>`);
  byId<HTMLButtonElement>('btn-replay').onclick = resetGame;
}

function showGameOver(result: TurnExecutionResult): void {
  demoAnalytics.track('run_end', { highestQi: state.runStats.highestSingleQi, endType: 'GAMEOVER' });
  openDialog(`
    <h2 class="modal-title val-red" id="modal-title">走火入魔</h2>
    <p class="modal-desc">剩余真气 ${result.context.qiBefore}，本次运转需要 ${result.context.effectiveCost}。</p>
    <button class="btn btn-primary" id="btn-retry">重修一局</button>`);
  byId<HTMLButtonElement>('btn-retry').onclick = resetGame;
}

function setDrawer(open: boolean): void {
  drawer.hidden = !open;
  btnToggleLog.setAttribute('aria-expanded', String(open));
  if (open) byId('btn-close-log').focus();
}

function resetGame(): void {
  finishPlaybackRecord?.(true);
  finishPlaybackRecord = null;
  animationDirector.cancelAll();
  sound.stopAll();
  clearEffects();
  clearScore();
  closeDialog();
  setDrawer(false);
  setFeedback();
  demoAnalytics.newRun(state.isVictory || state.isGameOver, state.runStats.highestSingleQi);
  state = createDemoInitialGameState();
  midBranch = null;
  lastTurnQi = null;
  lastTurnTribulation = undefined;
  lastTurnBoard = null;
  isExecuting = false;
  resetAction();
  log.replaceChildren();
  renderAll();
  handDeck.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
}

function createLogRow(text: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'log-entry';
  row.textContent = text;
  return row;
}

function formatLog(entry: SimulationLogEntry): string {
  return `#${entry.seq} ${entry.pulseId} · ${entry.action} · ${entry.detail}${entry.qiDelta === undefined ? '' : ` [+${entry.qiDelta}]`}`;
}

function writeTurnLog(result: TurnExecutionResult): void {
  const { context, simulation } = result;
  const limit = 160;
  const summary = createLogRow(`第 ${context.subStage} 阶段 · 阈值 ${context.stageThreshold} · 扣费 ${result.charged} · 产气 ${simulation.turnQiGenerated}`);
  const rows = simulation.logs.slice(0, limit).map((entry) => createLogRow(formatLog(entry)));
  if (simulation.logs.length > limit) rows.push(createLogRow(`另有 ${simulation.logs.length - limit} 条引擎事件。`));
  log.replaceChildren(summary, ...rows);
}

function renderSound(): void {
  btnAudio.textContent = sound.getMuted() ? '🔇' : '🔊';
  btnAudio.setAttribute('aria-pressed', String(sound.getMuted()));
}

btnRun.onclick = runTurnAction;
btnReset.onclick = resetGame;
btnSkip.onclick = () => animationDirector.skip();
btnAudio.onclick = () => {
  sound.toggleMute();
  sound.unlock();
  renderSound();
};
btnToggleLog.onclick = () => setDrawer(drawer.hidden);
byId('btn-close-log').onclick = () => {
  setDrawer(false);
  btnToggleLog.focus();
};
byId('btn-export-log').onclick = () => {
  const url = URL.createObjectURL(new Blob([demoAnalytics.exportJson()], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'zhoutian-demo-playtest.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

modal.addEventListener('cancel', (event) => {
  event.preventDefault();
  if (dismissibleDialog) closeDialog();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && isExecuting) animationDirector.skip();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || modal.open) return;
  if (!drawer.hidden) {
    setDrawer(false);
    btnToggleLog.focus();
  } else if (action.mode !== 'IDLE' || selectedCardUid) {
    cancelAction();
  }
});

renderAll();
renderSound();
demoAnalytics.track('demo_open');
