// ============================================================
// 《周天破境录：炼气篇》主交互入口 - V3 完整闭环
// 架构：原生 TypeScript 驱动 DOM + SVG，零重型框架依赖
// 核心：真实数值引擎驱动 + 阶段化教学与抉择 + 周天贯通破茧化仙
// ============================================================

import { animationDirector } from './animationQueue';
import { sound } from './audio';
import { createDao, getDaoConfig } from './config';
import { DEMO_CONFIG, demoAnalytics, demoSession } from './demoConfig';
import {
  canRecallDao,
  createDemoInitialGameState,
  executeDemoTurn,
  getEffectiveQiCost,
  moveDao,
  placeDao,
  recallDao,
  removeDao,
  type TurnExecutionResult,
} from './game';
import type { DaoCategory, DaoRhyme, GameState } from './types';

// 全局游戏状态（彻底摒弃页面本地最高分，严格统一到 state.runStats）
let state: GameState = createDemoInitialGameState();
let lastTurnQi: number | null = null;
let isExecuting: boolean = false;
let pendingChoice: boolean = false; // 中期二选一弹窗挂起时禁止运转与改阵
let selectedMidBranch: string | null = null; // 记录本局中期所选分支

// 交互操作状态
type ActionState =
  | { mode: 'IDLE' }
  | { mode: 'SELECT_FUEL_OVERWRITE'; placeCardUid: string; ringIdx: number; slotIdx: number }
  | { mode: 'SELECT_FUEL_REMOVE'; ringIdx: number; slotIdx: number }
  | { mode: 'SELECT_MOVE_DEST'; fromRing: number; fromSlot: number }
  | { mode: 'SELECT_FUEL_MOVE'; fromRing: number; fromSlot: number; toRing: number; toSlot: number };

let selectedCardUid: string | null = null;
let actionState: ActionState = { mode: 'IDLE' };

// DOM 元素缓存
const stepEls = [
  null,
  document.getElementById('step-1')!,
  document.getElementById('step-2')!,
  document.getElementById('step-3')!,
];

const statQiEl = document.getElementById('stat-qi')!;
const statTargetEl = document.getElementById('stat-target')!;
const statCostEl = document.getElementById('stat-cost')!;

const stageCircleEl = document.getElementById('circle-stage')!;
const handDeckEl = document.getElementById('hand-deck')!;
const hintBarEl = document.getElementById('hint-bar')!;

const btnRun = document.getElementById('btn-run') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const btnSkip = document.getElementById('btn-skip') as HTMLButtonElement;
const btnAudio = document.getElementById('btn-audio') as HTMLButtonElement;
const btnToggleLog = document.getElementById('btn-toggle-log') as HTMLButtonElement;
const btnCloseLog = document.getElementById('btn-close-log') as HTMLButtonElement;

const devLogDrawer = document.getElementById('dev-log-drawer')!;
const logEl = document.getElementById('log')!;

const burstDeltaEl = document.getElementById('burst-delta')!;
const burstTotalEl = document.getElementById('burst-total')!;
const burstCompareEl = document.getElementById('burst-compare')!;

const modalLayer = document.getElementById('modal-layer')!;
const modalCard = document.getElementById('modal-card')!;

// 修士剪影与破境 SVG 元素
const dantianCore = document.getElementById('dantian-core')!;
const meridianNetwork = document.getElementById('meridian-network')!;
const cocoonHull = document.getElementById('cocoon-hull')!;
const cocoonCracks = document.getElementById('cocoon-cracks')!;
const shockwave1 = document.getElementById('shockwave-ring-1')!;
const shockwave2 = document.getElementById('shockwave-ring-2')!;

// 4 槽元素与汇聚光线
const slotEls = [
  document.getElementById('slot-0')!,
  document.getElementById('slot-1')!,
  document.getElementById('slot-2')!,
  document.getElementById('slot-3')!,
];

const convergeLines = [
  document.getElementById('conv-0')!,
  document.getElementById('conv-1')!,
  document.getElementById('conv-2')!,
  document.getElementById('conv-3')!,
];

const trackMap: Record<string, SVGPathElement | null> = {
  '0-1': document.getElementById('track-0-1') as SVGPathElement | null,
  '1-2': document.getElementById('track-1-2') as SVGPathElement | null,
  '2-3': document.getElementById('track-2-3') as SVGPathElement | null,
  '3-0': document.getElementById('track-3-0') as SVGPathElement | null,
};

// 类别显示信息
const CATEGORY_MAP: Record<DaoCategory, { label: string; badgeClass: string }> = {
  CONDUCT: { label: '传导', badgeClass: 'badge-conduct' },
  AMPLIFY: { label: '增幅', badgeClass: 'badge-amplify' },
  RELEASE: { label: '释放', badgeClass: 'badge-release' },
};

const SLOT_NAMES = ['第一眼 · 入气', '第二眼', '第三眼', '第四眼'];

// ------------------------------------------------------------
// 渲染：顶部状态栏 (HUD)
// ------------------------------------------------------------
function renderHUD(): void {
  for (let i = 1; i <= 3; i++) {
    const el = stepEls[i];
    if (!el) continue;
    el.className = 'stage-step';
    if (i < state.subStage || (state.isVictory && i <= 3)) {
      el.classList.add('cleared');
    } else if (i === state.subStage && !state.isGameOver) {
      el.classList.add('active');
    }
  }

  statQiEl.textContent = String(state.currentQi);
  statTargetEl.textContent = String(state.stageThreshold);

  // 统一有效费用逻辑：祥云劫或免费次数大于 0 时准确显示 0
  const effCost = getEffectiveQiCost(state);
  if (state.freeTurnsLeft > 0) {
    statCostEl.textContent = `0 (免费剩余 ${state.freeTurnsLeft}次)`;
    statCostEl.className = 'stat-val val-green';
  } else {
    statCostEl.textContent = String(effCost);
    if (state.currentQi < effCost) {
      statCostEl.className = 'stat-val val-red';
    } else {
      statCostEl.className = 'stat-val val-purple';
    }
  }

  btnRun.disabled = isExecuting || pendingChoice || state.isGameOver || state.isVictory;
  if (isExecuting) {
    btnRun.textContent = '周天运转中...';
    btnSkip.style.display = 'inline-block';
  } else {
    btnRun.textContent = '运转周天';
    btnSkip.style.display = 'none';
  }
}

// ------------------------------------------------------------
// 渲染：周天阵盘四槽阵眼
// ------------------------------------------------------------
function renderBoard(): void {
  const ring = state.board[0];
  if (!ring) return;

  // 软引导检测：首局未完成布阵时的推荐槽位高亮
  const isEarlyTutorial = state.realm === 1 && state.subStage === 1;
  const hasGatherInHand = state.hand.some((c) => c.configId === 'dao_gather');
  const hasBurstInHand = state.hand.some((c) => c.configId === 'dao_burst');

  ring.slots.forEach((node, slotIdx) => {
    const slotEl = slotEls[slotIdx];
    if (!slotEl) return;

    slotEl.innerHTML = '';
    slotEl.className = `slot-node slot-pos-${slotIdx}`;
    slotEl.setAttribute('role', 'button');
    slotEl.setAttribute('tabindex', '0');

    if (node === null) {
      slotEl.classList.add('empty');
      if (selectedCardUid || actionState.mode === 'SELECT_MOVE_DEST') {
        slotEl.classList.add('target-active');
      }

      // 推荐高亮：若持有聚灵且选中的是聚灵，高亮 Slot 1；若持有灵爆且选中灵爆，高亮 Slot 3
      if (isEarlyTutorial) {
        const selCard = state.hand.find((c) => c.uid === selectedCardUid);
        if (selCard?.configId === 'dao_gather' && slotIdx === 1) {
          slotEl.classList.add('recommended');
        } else if (selCard?.configId === 'dao_burst' && slotIdx === 3) {
          slotEl.classList.add('recommended');
        } else if (!selectedCardUid && hasGatherInHand && slotIdx === 1) {
          slotEl.classList.add('recommended');
        } else if (!selectedCardUid && !hasGatherInHand && hasBurstInHand && slotIdx === 3) {
          slotEl.classList.add('recommended');
        }
      }

      slotEl.innerHTML = `
        <span class="slot-empty-label">+ 空槽</span>
        <span style="font-size:0.62rem;color:var(--text-muted)">${SLOT_NAMES[slotIdx]}</span>
      `;
      slotEl.onclick = () => onEmptySlotClick(slotIdx);
      slotEl.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEmptySlotClick(slotIdx);
        }
      };
    } else {
      slotEl.classList.add('occupied');
      const cat = CATEGORY_MAP[node.category];
      slotEl.innerHTML = `
        <div class="slot-badge-row">
          <span class="slot-cat-badge ${cat.badgeClass}">${cat.label}</span>
          <span class="slot-level-tag">LV${node.level}</span>
        </div>
        <div class="slot-card-name">${node.name}</div>
        <div style="font-size:0.55rem;color:var(--text-muted)">${SLOT_NAMES[slotIdx]}</div>
      `;
      slotEl.onclick = () => onOccupiedSlotClick(slotIdx);
      slotEl.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOccupiedSlotClick(slotIdx);
        }
      };
    }
  });
}

// ------------------------------------------------------------
// 渲染：底部手牌区
// ------------------------------------------------------------
function renderHand(): void {
  handDeckEl.innerHTML = '';

  state.hand.forEach((card) => {
    const cardEl = document.createElement('div');
    const isSelected = selectedCardUid === card.uid;
    const isFuelTarget =
      actionState.mode === 'SELECT_FUEL_OVERWRITE' ||
      actionState.mode === 'SELECT_FUEL_REMOVE' ||
      actionState.mode === 'SELECT_FUEL_MOVE';

    cardEl.className = `hand-card ${isSelected ? 'selected' : ''} ${isFuelTarget && isSelected ? 'fuel-target' : ''}`;
    cardEl.setAttribute('role', 'button');
    cardEl.setAttribute('tabindex', '0');
    const cat = CATEGORY_MAP[card.category];

    cardEl.innerHTML = `
      <div class="card-top">
        <span class="slot-cat-badge ${cat.badgeClass}">${cat.label}</span>
        <span class="slot-level-tag">LV${card.level}</span>
      </div>
      <div class="card-name">${card.name}</div>
      <div class="card-desc">${card.description}</div>
    `;

    cardEl.onclick = () => onCardClick(card);
    cardEl.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onCardClick(card);
      }
    };
    handDeckEl.appendChild(cardEl);
  });

  updateHint();
}

function updateHint(): void {
  if (actionState.mode === 'SELECT_FUEL_OVERWRITE') {
    hintBarEl.className = 'hint-bar active';
    hintBarEl.innerHTML = '【覆盖模式】点击手牌中 1 张作为改阵燃料销毁（<span style="text-decoration:underline;cursor:pointer" id="hint-cancel">取消</span>）';
  } else if (actionState.mode === 'SELECT_FUEL_REMOVE') {
    hintBarEl.className = 'hint-bar active';
    hintBarEl.innerHTML = '【拆除模式】点击手牌中 1 张作为燃料清空该槽位（<span style="text-decoration:underline;cursor:pointer" id="hint-cancel">取消</span>）';
  } else if (actionState.mode === 'SELECT_MOVE_DEST') {
    hintBarEl.className = 'hint-bar active';
    hintBarEl.innerHTML = '【移位模式】请点击阵盘上的任一【空槽】作为目标（<span style="text-decoration:underline;cursor:pointer" id="hint-cancel">取消</span>）';
  } else if (actionState.mode === 'SELECT_FUEL_MOVE') {
    hintBarEl.className = 'hint-bar active';
    hintBarEl.innerHTML = '【移位模式】点击手牌中 1 张作为燃料确认移位（<span style="text-decoration:underline;cursor:pointer" id="hint-cancel">取消</span>）';
  } else if (selectedCardUid) {
    const c = state.hand.find((item) => item.uid === selectedCardUid);
    hintBarEl.className = 'hint-bar active';
    const catLabel = c ? CATEGORY_MAP[c.category].label : '';
    let advice = '';
    if (c?.configId === 'dao_gather') advice = ' · 推荐放入第二眼增加基础真气';
    if (c?.configId === 'dao_burst') advice = ' · 推荐放入第四眼作为终结释放';
    hintBarEl.textContent = `已选【${c?.name ?? ''}】(${catLabel})：点击阵盘空槽布置${advice}`;
  } else {
    hintBarEl.className = 'hint-bar';
    // 初期软引导
    if (state.realm === 1 && state.subStage === 1 && state.hand.length === 2) {
      hintBarEl.textContent = '开局教学：点击下方【聚灵道韵】，放入第二眼；点击【灵爆术】，放入第四眼。';
    } else {
      hintBarEl.textContent = '点击手牌选中 · 放入阵眼部署 · 点击“运转周天”引发连锁';
    }
  }

  const cancelBtn = document.getElementById('hint-cancel');
  if (cancelBtn) {
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      resetActionState();
      renderAll();
    };
  }
}

// ------------------------------------------------------------
// 交互事件处理
// ------------------------------------------------------------

function onCardClick(card: DaoRhyme): void {
  sound.unlock();
  if (isExecuting || pendingChoice) return;

  if (actionState.mode === 'SELECT_FUEL_OVERWRITE') {
    if (card.uid === actionState.placeCardUid) {
      appendNotice('燃料卡不能与被放置的道韵卡相同，请选择另一张手牌', 'warn');
      return;
    }
    const res = placeDao(state, actionState.placeCardUid, actionState.ringIdx, actionState.slotIdx, card.uid);
    appendNotice(res.message, res.success ? 'info' : 'warn');
    resetActionState();
    renderAll();
    return;
  }

  if (actionState.mode === 'SELECT_FUEL_REMOVE') {
    const res = removeDao(state, actionState.ringIdx, actionState.slotIdx, card.uid);
    appendNotice(res.message, res.success ? 'info' : 'warn');
    resetActionState();
    renderAll();
    return;
  }

  if (actionState.mode === 'SELECT_FUEL_MOVE') {
    const res = moveDao(
      state,
      actionState.fromRing,
      actionState.fromSlot,
      actionState.toRing,
      actionState.toSlot,
      card.uid,
    );
    appendNotice(res.message, res.success ? 'info' : 'warn');
    resetActionState();
    renderAll();
    return;
  }

  // 普通反选或切换选中
  if (selectedCardUid === card.uid) {
    selectedCardUid = null;
  } else {
    selectedCardUid = card.uid;
  }
  renderHand();
  renderBoard();
}

function onEmptySlotClick(slotIdx: number): void {
  sound.unlock();
  if (isExecuting || pendingChoice) return;

  // 移位模式处理
  if (actionState.mode === 'SELECT_MOVE_DEST') {
    actionState = {
      mode: 'SELECT_FUEL_MOVE',
      fromRing: actionState.fromRing,
      fromSlot: actionState.fromSlot,
      toRing: 0,
      toSlot: slotIdx,
    };
    renderBoard();
    renderHand();
    return;
  }

  // 等待燃料状态下点击空槽：安全拦截并提示，绝不消耗卡牌
  if (
    actionState.mode === 'SELECT_FUEL_OVERWRITE' ||
    actionState.mode === 'SELECT_FUEL_REMOVE' ||
    actionState.mode === 'SELECT_FUEL_MOVE'
  ) {
    appendNotice('当前正处于选择燃料阶段，请点击手牌作为燃料，或点击取消', 'warn');
    return;
  }

  if (!selectedCardUid) {
    appendNotice('请先在下方手牌池中点击选择一张道韵卡', 'warn');
    return;
  }

  const res = placeDao(state, selectedCardUid, 0, slotIdx);
  appendNotice(res.message, res.success ? 'info' : 'warn');
  if (res.success) {
    demoAnalytics.track('first_card_placed', { stage: `1-${state.subStage}`, detail: `Slot ${slotIdx}` });
    selectedCardUid = null;
  }
  renderAll();
}

function onOccupiedSlotClick(slotIdx: number): void {
  sound.unlock();
  if (isExecuting || pendingChoice) return;

  if (actionState.mode === 'SELECT_MOVE_DEST') {
    appendNotice('移位目标必须是空槽，该槽位已占用', 'warn');
    return;
  }

  if (
    actionState.mode === 'SELECT_FUEL_OVERWRITE' ||
    actionState.mode === 'SELECT_FUEL_REMOVE' ||
    actionState.mode === 'SELECT_FUEL_MOVE'
  ) {
    appendNotice('当前正处于选择燃料阶段，请点击手牌作为燃料，或点击取消', 'warn');
    return;
  }

  if (selectedCardUid) {
    // 携带手牌点击已有槽位 -> 尝试进入覆盖
    if (state.hand.length < 2) {
      appendNotice('覆盖已有道韵需要至少 2 张手牌（1 张放置 + 1 张燃料）', 'warn');
      return;
    }
    actionState = {
      mode: 'SELECT_FUEL_OVERWRITE',
      placeCardUid: selectedCardUid,
      ringIdx: 0,
      slotIdx,
    };
    renderHand();
  } else {
    // 未选手牌点击已有槽位 -> 弹出操作菜单
    showSlotActionMenu(slotIdx);
  }
}

function showSlotActionMenu(slotIdx: number): void {
  const node = state.board[0]?.slots[slotIdx];
  if (!node) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-layer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const canRecall = canRecallDao(state, 0, slotIdx);

  const modal = document.createElement('div');
  modal.className = 'modal-card';
  modal.innerHTML = `
    <div class="modal-title">调整阵眼：${SLOT_NAMES[slotIdx]}</div>
    <div class="modal-desc">当前驻留：【${node.name} LV${node.level}】(${CATEGORY_MAP[node.category].label})</div>
    <div class="modal-btn-row">
      ${
        canRecall
          ? `<button class="btn btn-primary" id="menu-recall" style="flex:1">收回道韵 (无损)</button>`
          : ''
      }
      <button class="btn btn-secondary" id="menu-move" style="flex:1">移位 (消耗1燃料)</button>
      <button class="btn btn-warning" id="menu-remove" style="flex:1">拆除 (消耗1燃料)</button>
    </div>
    <button class="btn btn-secondary" id="menu-cancel" style="margin-top:8px">取消</button>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => {
    if (document.body.contains(overlay)) document.body.removeChild(overlay);
  };

  modal.querySelector('#menu-cancel')!.addEventListener('click', close);

  if (canRecall) {
    modal.querySelector('#menu-recall')?.addEventListener('click', () => {
      close();
      const res = recallDao(state, 0, slotIdx);
      appendNotice(res.message, res.success ? 'info' : 'warn');
      renderAll();
    });
  }

  modal.querySelector('#menu-move')!.addEventListener('click', () => {
    close();
    // 满盘检查
    const hasEmpty = state.board[0]?.slots.some((s) => s === null);
    if (!hasEmpty) {
      appendNotice('阵盘已满，无可用空槽可供移位（请使用覆盖或拆除）', 'warn');
      return;
    }
    if (state.hand.length < 1) {
      appendNotice('移位需消耗 1 张手牌作为燃料，手牌不足', 'warn');
      return;
    }
    actionState = {
      mode: 'SELECT_MOVE_DEST',
      fromRing: 0,
      fromSlot: slotIdx,
    };
    renderBoard();
    renderHand();
  });

  modal.querySelector('#menu-remove')!.addEventListener('click', () => {
    close();
    if (state.hand.length < 1) {
      appendNotice('拆除需消耗 1 张手牌作为燃料，手牌不足', 'warn');
      return;
    }
    actionState = {
      mode: 'SELECT_FUEL_REMOVE',
      ringIdx: 0,
      slotIdx,
    };
    renderHand();
  });
}

function resetActionState(): void {
  selectedCardUid = null;
  actionState = { mode: 'IDLE' };
}

// ------------------------------------------------------------
// 运转周天与基于真实日志的演出
// ------------------------------------------------------------

function runTurnAction(): void {
  sound.unlock();
  if (isExecuting || pendingChoice || state.isGameOver || state.isVictory) return;

  const effCost = getEffectiveQiCost(state);
  if (state.currentQi < effCost && !state.relics.includes('relic_rebirth')) {
    appendNotice(`真气不足以支付本次周天运转 (${effCost})，已走火入魔！`, 'warn');
    state.isGameOver = true;
    showGameOverModal();
    return;
  }

  resetActionState();
  isExecuting = true;
  renderHUD();

  const prevQi = lastTurnQi;

  // 真实结算（执行时在 state 内部捕获前态快照 context）
  const turnRes: TurnExecutionResult = executeDemoTurn(state);

  // 抽屉日志记录（严格基于前态快照）
  appendLogSummary(turnRes);
  turnRes.simulation.logs.forEach((log) => appendLogEntry(log));

  // 埋点
  demoAnalytics.track('first_run', {
    stage: `${turnRes.context.realm}-${turnRes.context.subStage}`,
    qiGenerated: turnRes.simulation.turnQiGenerated,
    effectiveCost: turnRes.charged,
    stageThreshold: turnRes.context.stageThreshold,
  });

  if (turnRes.simulation.releasedCount > 0) {
    demoAnalytics.track('first_release', {
      qiGenerated: turnRes.simulation.turnQiGenerated,
      watchedRelease: true,
    });
  }

  // 判断小关突破与终局
  const isMinorReady = turnRes.cleared && !turnRes.isVictory;
  const isFinaleReady = turnRes.cleared && turnRes.isVictory;

  // 启动演出调度器（携带真实流路与播放预算）
  animationDirector.playTurn(turnRes, isFinaleReady, isMinorReady, {
    setSlotHighlight: (slotIdx, level) => {
      const el = slotEls[slotIdx];
      if (!el) return;
      el.classList.remove('active-pulse', 'amplify-pulse', 'release-pulse');
      if (level === 'active') el.classList.add('active-pulse');
      if (level === 'amplify') el.classList.add('amplify-pulse');
      if (level === 'release') el.classList.add('release-pulse');
    },

    highlightTrack: (fromSlot, toSlot) => {
      const key = `${fromSlot}-${toSlot}`;
      const track = trackMap[key];
      if (track) {
        track.classList.add('active');
        setTimeout(() => track.classList.remove('active'), 320);
      }
    },

    spawnFloatText: (slotIdx, text, type) => {
      const slotEl = slotEls[slotIdx];
      if (!slotEl) return;
      const rect = slotEl.getBoundingClientRect();
      const stageRect = stageCircleEl.getBoundingClientRect();

      const floatEl = document.createElement('div');
      floatEl.className = `float-notice float-${type}`;
      floatEl.textContent = text;
      floatEl.style.left = `${rect.left + rect.width / 2 - stageRect.left}px`;
      floatEl.style.top = `${rect.top - stageRect.top}px`;

      stageCircleEl.appendChild(floatEl);
      setTimeout(() => {
        if (stageCircleEl.contains(floatEl)) stageCircleEl.removeChild(floatEl);
      }, 850);
    },

    updateBurstScore: (score, delta, isFinal, summaryText) => {
      burstTotalEl.textContent = String(score);
      burstTotalEl.classList.add('visible');

      if (delta > 0) {
        burstDeltaEl.textContent = summaryText ? summaryText : `+${delta}`;
        burstDeltaEl.style.opacity = '1';
        setTimeout(() => {
          burstDeltaEl.style.opacity = '0';
        }, 300);
      }

      if (isFinal) {
        if (prevQi !== null && prevQi > 0) {
          const diff = score - prevQi;
          const pct = Math.round((diff / prevQi) * 100);
          burstCompareEl.textContent = `本轮 ${score} · 上轮 ${prevQi} · ${pct >= 0 ? `提升 +${pct}%` : `变化 ${pct}%`}`;
          burstCompareEl.classList.add('visible');
        } else {
          burstCompareEl.textContent = `首轮爆发 ${score}`;
          burstCompareEl.classList.add('visible');
        }
      }
    },

    playMinorBreakthrough: async () => {
      dantianCore.classList.add('gold');
      await animationDirector.wait(DEMO_CONFIG.timings.minorBreakthrough, -1);
      dantianCore.classList.remove('gold');
    },

    playGrandBreakthrough: async (isReduced, releaseSlots) => {
      if (isReduced) {
        dantianCore.classList.add('gold');
        meridianNetwork.querySelectorAll('.meridian-path').forEach((p) => p.classList.add('active'));
        await animationDirector.wait(DEMO_CONFIG.timings.reducedMotionFinale, -1);
        return;
      }

      // 分镜 1 (0.0~0.7s): 周天归一，能量仅从真实释放阵眼向阵心汇聚
      sound.playFinaleCharge();
      releaseSlots.forEach((s) => {
        const line = convergeLines[s];
        if (line) line.classList.add('active');
      });
      await animationDirector.wait(DEMO_CONFIG.timings.finale.converge, -1);

      // 分镜 2 (0.7~1.5s): 灵气入体，经脉依次点亮
      sound.playFinaleMeridian();
      dantianCore.classList.add('gold');
      meridianNetwork.querySelectorAll('.meridian-path').forEach((p) => p.classList.add('active'));
      await animationDirector.wait(DEMO_CONFIG.timings.finale.meridian, -1);

      // 分镜 3 (1.5~2.3s): 破茧冲关，光茧微震显裂纹
      sound.playFinaleBreak();
      cocoonHull.classList.add('active');
      cocoonCracks.querySelectorAll('.crack-line').forEach((c) => c.classList.add('active'));
      stageCircleEl.classList.add('screen-shake');
      setTimeout(() => stageCircleEl.classList.remove('screen-shake'), 300);
      await animationDirector.wait(DEMO_CONFIG.timings.finale.breakCocoon, -1);

      // 分镜 4 (2.3~3.2s): 周天贯通，金色冲击波掠过四阵眼
      sound.playFinaleComplete();
      cocoonHull.classList.remove('active');
      cocoonCracks.querySelectorAll('.crack-line').forEach((c) => c.classList.remove('active'));
      shockwave1.classList.add('active');
      shockwave2.classList.add('active');
      slotEls.forEach((el) => el.classList.add('amplify-pulse'));
      await animationDirector.wait(DEMO_CONFIG.timings.finale.shockwave, -1);

      // 分镜 5 (3.2~4.5s): 炼气圆满成就定格
      slotEls.forEach((el) => el.classList.remove('amplify-pulse'));
      convergeLines.forEach((line) => line.classList.remove('active'));
      await animationDirector.wait(DEMO_CONFIG.timings.finale.complete, -1);
    },

    onComplete: () => {
      isExecuting = false;
      lastTurnQi = turnRes.simulation.turnQiGenerated;

      renderAll();

      if (turnRes.isGameOver) {
        showGameOverModal();
        return;
      }

      if (turnRes.isVictory) {
        demoSession.markCleared();
        showVictoryModal();
        return;
      }

      if (turnRes.cleared) {
        // V3 教学流程：初期突破弹出二选一，中期突破预告巅峰
        if (turnRes.context.subStage === 1) {
          showMidStageChoiceModal(turnRes);
        } else if (turnRes.context.subStage === 2) {
          showZenithIntroModal(turnRes);
        }
      }
    },
  });
}

// ------------------------------------------------------------
// 弹窗与结算界面 - V3 完整规范
// ------------------------------------------------------------

/** V3 中期二选一与机动牌发放弹窗 */
function showMidStageChoiceModal(turnRes: TurnExecutionResult): void {
  pendingChoice = true;
  modalLayer.style.display = 'flex';

  const choices = DEMO_CONFIG.midStageChoices;

  modalCard.innerHTML = `
    <div class="modal-title" style="color:var(--text-green)">突破大捷 · 炼气初期圆满</div>
    <div class="modal-desc">
      真气爆发 <strong class="val-gold">${turnRes.simulation.turnQiGenerated}</strong> 达成破障！<br />
      精进至【炼气中期】（目标破障阈值 60）。请选择中期构筑分支：
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;margin:14px 0;">
      ${choices
        .map(
          (c) => `
        <div class="branch-card" data-id="${c.configId}" style="border:1px solid var(--border-color);border-radius:8px;padding:10px;cursor:pointer;background:rgba(21,31,46,0.8);transition:all 0.2s;">
          <div style="font-weight:600;color:var(--text-gold-bright)">【${c.name}】</div>
          <div style="font-size:0.8rem;color:var(--text-muted);margin-top:3px">${c.advice}</div>
        </div>
      `,
        )
        .join('')}
    </div>
    <div style="font-size:0.75rem;color:var(--text-cyan);text-align:center;margin-bottom:8px">
      ✦ 选择分支后，将附赠 1 张【聚灵道韵】作为机动手牌/改阵燃料 ✦
    </div>
  `;

  // 绑定分支卡片点击
  modalCard.querySelectorAll('.branch-card').forEach((el) => {
    el.addEventListener('click', () => {
      const configId = el.getAttribute('data-id')!;
      confirmMidChoice(configId);
    });
  });
}

function confirmMidChoice(chosenConfigId: string): void {
  selectedMidBranch = chosenConfigId;
  const chosenCfg = getDaoConfig(chosenConfigId);

  // 发放所选分支卡 + 1 张机动聚灵
  const cardChosen = createDao(chosenConfigId, 1, `branch_${chosenConfigId}`);
  const cardGatherBonus = createDao(DEMO_CONFIG.midStageBonusCardId, 1, 'bonus_gather');
  state.hand.push(cardChosen, cardGatherBonus);

  demoAnalytics.track('stage_clear', {
    stage: '1-1',
    branchChoice: chosenConfigId,
    detail: `选择 ${chosenCfg.name} 并获得机动聚灵`,
  });

  pendingChoice = false;
  modalLayer.style.display = 'none';
  burstTotalEl.classList.remove('visible');
  burstCompareEl.classList.remove('visible');

  appendNotice(`已领受【${chosenCfg.name}】与机动手牌【聚灵道韵】，可根据构筑布局。`, 'info');
  renderAll();
}

/** V3 巅峰关卡与天劫降临预告弹窗 */
function showZenithIntroModal(turnRes: TurnExecutionResult): void {
  pendingChoice = true;
  modalLayer.style.display = 'flex';

  // 发放未选的中期分支牌 + 1 张万剑诀
  const otherChoice = DEMO_CONFIG.midStageChoices.find((c) => c.configId !== selectedMidBranch);
  const otherCardId = otherChoice ? otherChoice.configId : 'dao_crit';
  const cardOther = createDao(otherCardId, 1, `zenith_bonus_${otherCardId}`);
  const cardSword = createDao(DEMO_CONFIG.zenithBonusCardId, 1, 'zenith_sword');
  state.hand.push(cardOther, cardSword);

  const tribName = state.activeTribulation?.name ?? '玄黄祥云劫';
  const isCloud = state.activeTribulation?.id === 'trib_cloud' || !state.activeTribulation;

  modalCard.innerHTML = `
    <div class="modal-title" style="color:var(--text-gold-bright)">天劫降临 · 炼气巅峰</div>
    <div class="modal-desc">
      真气爆发 <strong class="val-gold">${turnRes.simulation.turnQiGenerated}</strong> 突破炼气中期！大道感应，天劫【${tribName}】已至！<br />
      ${
        isCloud
          ? '<strong class="val-green">玄黄祥云庇佑：前两次周天运转免费 (0消耗)！</strong>'
          : '<strong class="val-purple">天劫异象已降临，请谨慎测算真气消耗！</strong>'
      }
    </div>
    <div class="modal-score-box">
      <div class="modal-score-label">巅峰赠礼（补齐道韵）</div>
      <div style="font-size:0.85rem;color:var(--text-cyan)">
        【${cardOther.name}】 + 【${cardSword.name}】已放入手牌
      </div>
    </div>
    <div class="modal-btn-row">
      <button class="btn btn-primary" id="btn-enter-zenith">迎战天劫，冲击圆满</button>
    </div>
  `;

  modalCard.querySelector('#btn-enter-zenith')!.addEventListener('click', () => {
    pendingChoice = false;
    modalLayer.style.display = 'none';
    burstTotalEl.classList.remove('visible');
    burstCompareEl.classList.remove('visible');
    renderAll();
  });
}

function showVictoryModal(): void {
  const finalHighQi = state.runStats.highestSingleQi;
  demoAnalytics.track('run_end', {
    detail: '炼气圆满通关',
    qiGenerated: finalHighQi,
    highestQi: finalHighQi,
    endType: 'VICTORY',
  });

  modalLayer.style.display = 'flex';
  modalCard.innerHTML = `
    <div class="modal-title" style="color:var(--text-gold-bright)">✨ 炼气圆满 ✨</div>
    <div class="modal-desc">
      周天贯通，灵气破茧！<br />
      你的阵法之道成功助修士通达炼气大圆满之境！
    </div>
    <div class="modal-score-box">
      <div class="modal-score-label">单轮最高爆发气值</div>
      <div class="modal-score-val">${finalHighQi}</div>
    </div>
    <div class="modal-btn-row">
      <button class="btn btn-primary" id="btn-replay">再修一局 (天劫随机挑战)</button>
    </div>
  `;

  modalCard.querySelector('#btn-replay')!.addEventListener('click', () => {
    modalLayer.style.display = 'none';
    resetGame();
  });
}

function showGameOverModal(): void {
  demoAnalytics.track('run_end', { detail: '走火入魔', endType: 'GAMEOVER' });
  modalLayer.style.display = 'flex';
  modalCard.innerHTML = `
    <div class="modal-title" style="color:var(--text-red)">走火入魔</div>
    <div class="modal-desc">
      真气池耗尽，无法支付周天运转消耗！
    </div>
    <div class="modal-btn-row">
      <button class="btn btn-primary" id="btn-retry">重铸道基</button>
    </div>
  `;

  modalCard.querySelector('#btn-retry')!.addEventListener('click', () => {
    modalLayer.style.display = 'none';
    resetGame();
  });
}

// ------------------------------------------------------------
// 重置与环境初始化
// ------------------------------------------------------------

function resetGame(): void {
  animationDirector.cancelAll();
  isExecuting = false;
  pendingChoice = false;
  lastTurnQi = null;
  selectedMidBranch = null;

  state = createDemoInitialGameState();
  resetActionState();
  demoAnalytics.newRun();

  // 清除视觉残留
  dantianCore.setAttribute('class', 'dantian-core');
  meridianNetwork.querySelectorAll('.meridian-path').forEach((p) => p.classList.remove('active'));
  cocoonHull.classList.remove('active');
  cocoonCracks.querySelectorAll('.crack-line').forEach((c) => c.classList.remove('active'));
  shockwave1.classList.remove('active');
  shockwave2.classList.remove('active');
  convergeLines.forEach((l) => l.classList.remove('active'));
  slotEls.forEach((el) => {
    el.classList.remove('active-pulse', 'amplify-pulse', 'release-pulse', 'recommended');
  });

  burstTotalEl.classList.remove('visible');
  burstCompareEl.classList.remove('visible');

  logEl.innerHTML = '';
  appendNotice('周天阵盘已重置，大道重修开局。', 'info');
  renderAll();
}

function renderAll(): void {
  renderHUD();
  renderBoard();
  renderHand();
}

// ------------------------------------------------------------
// 实时抽屉日志记录辅助
// ------------------------------------------------------------

function appendLogSummary(turnRes: TurnExecutionResult): void {
  const el = document.createElement('div');
  el.className = 'log-entry';
  el.style.borderLeft = turnRes.cleared ? '3px solid var(--text-green)' : '3px solid var(--text-gold)';
  // 严格使用前态快照阈值，保证初期显示 30 而非 60
  el.textContent = `【周天运转】扣费 ${turnRes.charged}，产气 ${turnRes.simulation.turnQiGenerated} (第${turnRes.context.subStage}阶段 · 阈值 ${turnRes.context.stageThreshold})`;
  logEl.prepend(el);
}

function appendLogEntry(item: { seq: number; pulseId: string; action: string; detail: string; qiDelta?: number }): void {
  const el = document.createElement('div');
  el.className = 'log-entry';
  const deltaStr = item.qiDelta !== undefined ? ` [+${item.qiDelta}]` : '';
  el.innerHTML = `
    <span style="color:var(--text-muted)">#${item.seq}</span>
    <span style="color:var(--text-cyan)">[${item.action}]</span>
    <span>${item.detail}</span>
    <strong style="color:var(--text-gold)">${deltaStr}</strong>
  `;
  logEl.prepend(el);
}

function appendNotice(msg: string, type: 'info' | 'warn' = 'info'): void {
  const el = document.createElement('div');
  el.className = 'log-entry';
  el.style.color = type === 'warn' ? 'var(--text-red)' : 'var(--text-gold)';
  el.textContent = `➤ ${msg}`;
  logEl.prepend(el);
}

// ------------------------------------------------------------
// 绑定全局事件与键盘可达性
// ------------------------------------------------------------

btnRun.onclick = runTurnAction;
btnReset.onclick = resetGame;
btnSkip.onclick = () => animationDirector.skip();

// 读取已保存的静音状态
btnAudio.textContent = sound.getMuted() ? '🔇' : '🔊';
btnAudio.onclick = () => {
  sound.unlock();
  const muted = sound.toggleMute();
  btnAudio.textContent = muted ? '🔇' : '🔊';
};

btnToggleLog.onclick = () => {
  devLogDrawer.classList.toggle('open');
};

btnCloseLog.onclick = () => {
  devLogDrawer.classList.remove('open');
};

// 后台切出切回收束演出（Page Visibility API）
document.addEventListener('visibilitychange', () => {
  if (document.hidden && isExecuting) {
    animationDirector.skip();
  }
});

// 全局键盘监听 (Esc 取消/关闭，Enter 触发)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (actionState.mode !== 'IDLE') {
      resetActionState();
      renderAll();
    } else if (modalLayer.style.display === 'flex' && !pendingChoice) {
      modalLayer.style.display = 'none';
    }
  }
});

// 初始启动
renderAll();
appendNotice('《周天破境录：炼气篇》就绪。开局推荐：Slot 1 聚灵，Slot 3 灵爆。', 'info');
demoAnalytics.track('demo_open');
