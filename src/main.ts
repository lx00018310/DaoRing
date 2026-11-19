// ============================================================
// 《周天破境录：炼气篇》主交互入口
// 架构：原生 TypeScript 驱动 DOM + SVG，零重型框架依赖
// 核心：真实数值引擎驱动 + 周天贯通破茧化仙联合破境
// ============================================================

import { animationDirector } from './animationQueue';
import { sound } from './audio';
import { demoAnalytics } from './demoConfig';
import {
  createDemoInitialGameState,
  executeDemoTurn,
  moveDao,
  placeDao,
  removeDao,
  type TurnExecutionResult,
} from './game';
import type { DaoCategory, DaoRhyme, GameState } from './types';

// 全局游戏状态
let state: GameState = createDemoInitialGameState();
let lastTurnQi: number | null = null;
let highestQi: number = 0;
let isExecuting: boolean = false;

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

// ------------------------------------------------------------
// 渲染：顶部状态栏 (HUD)
// ------------------------------------------------------------
function renderHUD(): void {
  // 步骤条高亮
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
  statCostEl.textContent = String(state.nextQiCost);

  if (state.currentQi < state.nextQiCost) {
    statCostEl.className = 'stat-val val-red';
  } else {
    statCostEl.className = 'stat-val val-purple';
  }

  btnRun.disabled = isExecuting || state.isGameOver || state.isVictory;
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

  ring.slots.forEach((node, slotIdx) => {
    const slotEl = slotEls[slotIdx];
    if (!slotEl) return;

    slotEl.innerHTML = '';
    slotEl.className = `slot-node slot-pos-${slotIdx}`;

    if (node === null) {
      // 空槽位
      slotEl.classList.add('empty');
      if (selectedCardUid || actionState.mode === 'SELECT_MOVE_DEST') {
        slotEl.classList.add('target-active');
      }
      slotEl.innerHTML = `
        <span class="slot-empty-label">+ 空槽</span>
        <span style="font-size:0.62rem;color:var(--text-muted)">阵眼 #${slotIdx}</span>
      `;
      slotEl.onclick = () => onEmptySlotClick(slotIdx);
    } else {
      // 已占用阵眼
      slotEl.classList.add('occupied');
      const cat = CATEGORY_MAP[node.category];
      slotEl.innerHTML = `
        <div class="slot-badge-row">
          <span class="slot-cat-badge ${cat.badgeClass}">${cat.label}</span>
          <span class="slot-level-tag">LV${node.level}</span>
        </div>
        <div class="slot-card-name">${node.name}</div>
      `;
      slotEl.onclick = () => onOccupiedSlotClick(slotIdx);
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
    handDeckEl.appendChild(cardEl);
  });

  updateHint();
}

function updateHint(): void {
  if (actionState.mode === 'SELECT_FUEL_OVERWRITE') {
    hintBarEl.className = 'hint-bar active';
    hintBarEl.textContent = '【覆盖】请点击手牌中 1 张作为改阵燃料销毁（或点其他重置）';
  } else if (actionState.mode === 'SELECT_FUEL_REMOVE') {
    hintBarEl.className = 'hint-bar active';
    hintBarEl.textContent = '【拆除】请点击手牌中 1 张作为燃料清空该槽位';
  } else if (actionState.mode === 'SELECT_MOVE_DEST') {
    hintBarEl.className = 'hint-bar active';
    hintBarEl.textContent = '【移位】请点击阵盘上的任一【空槽】作为目标位置';
  } else if (actionState.mode === 'SELECT_FUEL_MOVE') {
    hintBarEl.className = 'hint-bar active';
    hintBarEl.textContent = '【移位】请点击手牌中 1 张作为燃料确认移位';
  } else if (selectedCardUid) {
    const c = state.hand.find((item) => item.uid === selectedCardUid);
    hintBarEl.className = 'hint-bar active';
    hintBarEl.textContent = `已选【${c?.name ?? ''}】：点击阵盘空槽布置；点击已有槽位覆盖`;
  } else {
    hintBarEl.className = 'hint-bar';
    hintBarEl.textContent = '点击手牌选中 · 放入阵眼部署 · 点击“运转周天”引发连锁';
  }
}

// ------------------------------------------------------------
// 交互事件处理
// ------------------------------------------------------------

function onCardClick(card: DaoRhyme): void {
  sound.unlock();
  if (isExecuting) return;

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
  if (isExecuting) return;

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
  if (isExecuting) return;

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
    // 未选手牌点击已有槽位 -> 弹出微操作选择 (移位/拆除)
    showSlotActionMenu(slotIdx);
  }
}

function showSlotActionMenu(slotIdx: number): void {
  const node = state.board[0]?.slots[slotIdx];
  if (!node) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-layer';

  const modal = document.createElement('div');
  modal.className = 'modal-card';
  modal.innerHTML = `
    <div class="modal-title">调整阵眼 #${slotIdx}</div>
    <div class="modal-desc">当前驻留：【${node.name} LV${node.level}】(${CATEGORY_MAP[node.category].label})</div>
    <div class="modal-btn-row">
      <button class="btn btn-secondary" id="menu-move" style="flex:1">移位 (消耗1燃料)</button>
      <button class="btn btn-warning" id="menu-remove" style="flex:1">拆除 (消耗1燃料)</button>
    </div>
    <button class="btn btn-secondary" id="menu-cancel" style="margin-top:6px">取消</button>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => {
    if (document.body.contains(overlay)) document.body.removeChild(overlay);
  };

  modal.querySelector('#menu-cancel')!.addEventListener('click', close);

  modal.querySelector('#menu-move')!.addEventListener('click', () => {
    close();
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
  if (isExecuting || state.isGameOver || state.isVictory) return;

  resetActionState();
  isExecuting = true;
  renderHUD();

  // 记录前态
  const prevQi = lastTurnQi;

  // 真实结算
  const turnRes: TurnExecutionResult = executeDemoTurn(state);

  // 记录最高单轮爆发
  if (turnRes.simulation.turnQiGenerated > highestQi) {
    highestQi = turnRes.simulation.turnQiGenerated;
  }

  // 写入实时抽屉日志
  appendLogSummary(turnRes);
  turnRes.simulation.logs.forEach((log) => appendLogEntry(log));

  // 埋点
  demoAnalytics.track('first_run', {
    stage: `1-${state.subStage}`,
    qiGenerated: turnRes.simulation.turnQiGenerated,
  });

  // 判断小突破与终局大突破
  const isMinorReady = turnRes.cleared && !turnRes.isVictory;
  const isFinaleReady = turnRes.cleared && turnRes.isVictory;

  // 启动演出队列
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
        setTimeout(() => track.classList.remove('active'), 350);
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

    updateBurstScore: (score, delta, isFinal) => {
      burstTotalEl.textContent = String(score);
      burstTotalEl.classList.add('visible');

      if (delta > 0) {
        burstDeltaEl.textContent = `+${delta}`;
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
      // 0.8s 轻量反馈：阵心丹田微亮
      dantianCore.classList.add('gold');
      await new Promise((r) => setTimeout(r, 800));
      dantianCore.classList.remove('gold');
    },

    playGrandBreakthrough: async (isReduced) => {
      // 终局 4.5s 联合演出分镜 (或低运动版 0.8s)
      if (isReduced) {
        dantianCore.classList.add('gold');
        meridianNetwork.querySelectorAll('.meridian-path').forEach((p) => p.classList.add('active'));
        await new Promise((r) => setTimeout(r, 800));
        return;
      }

      // 分镜 1 (0.0~0.7s): 周天归一，能量向阵心收束
      sound.playFinaleCharge();
      convergeLines.forEach((line) => line.classList.add('active'));
      await new Promise((r) => setTimeout(r, 700));

      // 分镜 2 (0.7~1.5s): 灵气入体，经脉依次点亮
      sound.playFinaleMeridian();
      dantianCore.classList.add('gold');
      meridianNetwork.querySelectorAll('.meridian-path').forEach((p) => p.classList.add('active'));
      await new Promise((r) => setTimeout(r, 800));

      // 分镜 3 (1.5~2.3s): 破茧冲关，光茧与裂纹
      sound.playFinaleBreak();
      cocoonHull.classList.add('active');
      cocoonCracks.querySelectorAll('.crack-line').forEach((c) => c.classList.add('active'));
      stageCircleEl.classList.add('screen-shake');
      setTimeout(() => stageCircleEl.classList.remove('screen-shake'), 300);
      await new Promise((r) => setTimeout(r, 800));

      // 分镜 4 (2.3~3.2s): 周天贯通，金色冲击波掠过四阵眼
      sound.playFinaleComplete();
      cocoonHull.classList.remove('active');
      cocoonCracks.querySelectorAll('.crack-line').forEach((c) => c.classList.remove('active'));
      shockwave1.classList.add('active');
      shockwave2.classList.add('active');
      slotEls.forEach((el) => el.classList.add('amplify-pulse'));
      await new Promise((r) => setTimeout(r, 900));

      // 分镜 5 (3.2~4.5s): 炼气圆满成就定格
      slotEls.forEach((el) => el.classList.remove('amplify-pulse'));
      convergeLines.forEach((line) => line.classList.remove('active'));
      await new Promise((r) => setTimeout(r, 500));
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
        showVictoryModal();
        return;
      }

      if (turnRes.cleared) {
        showStageClearModal(turnRes);
      }
    },
  });
}

// ------------------------------------------------------------
// 弹窗与结算界面
// ------------------------------------------------------------

function showStageClearModal(turnRes: TurnExecutionResult): void {
  modalLayer.style.display = 'flex';
  modalCard.innerHTML = `
    <div class="modal-title" style="color:var(--text-green)">突破大捷</div>
    <div class="modal-desc">
      真气爆发 <strong class="val-gold">${turnRes.simulation.turnQiGenerated}</strong> 达成突破！<br />
      境界精进至【炼气期 · 第 ${state.subStage} 阶段】
    </div>
    <div class="modal-score-box">
      <div class="modal-score-label">缴获全新道韵卡</div>
      <div style="font-size:0.85rem;color:var(--text-cyan)">
        ${turnRes.lootAwarded.map((c) => `【${c.name}】`).join(' ')}
      </div>
    </div>
    <div class="modal-btn-row">
      <button class="btn btn-primary" id="btn-next-stage">纳入行囊，继续冲关</button>
    </div>
  `;

  modalCard.querySelector('#btn-next-stage')!.addEventListener('click', () => {
    modalLayer.style.display = 'none';
    burstTotalEl.classList.remove('visible');
    burstCompareEl.classList.remove('visible');
    renderAll();
  });
}

function showVictoryModal(): void {
  demoAnalytics.track('run_end', { detail: '炼气圆满通关', qiGenerated: highestQi });
  modalLayer.style.display = 'flex';
  modalCard.innerHTML = `
    <div class="modal-title" style="color:var(--text-gold-bright)">✨ 炼气圆满 ✨</div>
    <div class="modal-desc">
      周天贯通，灵气破茧！<br />
      你的阵法之道成功助修士通达炼气大圆满之境！
    </div>
    <div class="modal-score-box">
      <div class="modal-score-label">单轮最高爆发气值</div>
      <div class="modal-score-val">${highestQi}</div>
    </div>
    <div class="modal-btn-row">
      <button class="btn btn-primary" id="btn-replay">再修一局 (尝试更高爆发)</button>
    </div>
  `;

  modalCard.querySelector('#btn-replay')!.addEventListener('click', () => {
    modalLayer.style.display = 'none';
    resetGame();
  });
}

function showGameOverModal(): void {
  demoAnalytics.track('run_end', { detail: '走火入魔' });
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
  lastTurnQi = null;
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
    el.classList.remove('active-pulse', 'amplify-pulse', 'release-pulse');
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
  el.textContent = `【周天运转】扣费 ${turnRes.charged}，产气 ${turnRes.simulation.turnQiGenerated} (阈值 ${state.stageThreshold})`;
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
// 绑定全局事件
// ------------------------------------------------------------

btnRun.onclick = runTurnAction;
btnReset.onclick = resetGame;
btnSkip.onclick = () => animationDirector.skip();

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

// 初始启动
renderAll();
appendNotice('《周天破境录：炼气篇》已就绪。请选牌布阵，随后点击【运转周天】。', 'info');
demoAnalytics.track('demo_open');
