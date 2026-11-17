// ============================================================
// 《周天破境录》核心数值引擎调试台 主交互入口
// 架构：原生 TypeScript 驱动 DOM，零框架依赖，极简高效
// ============================================================
import { BOARD } from './config';
import {
  createInitialGameState,
  executeTurn,
  moveDao,
  placeDao,
  removeDao,
  type TurnExecutionResult,
} from './game';
import type { DaoCategory, DaoRhyme, GameState } from './types';

// 全局状态与交互模式
let state: GameState = createInitialGameState();

type ActionState =
  | { mode: 'IDLE' }
  | { mode: 'SELECT_FUEL_OVERWRITE'; placeCardUid: string; ringIdx: number; slotIdx: number }
  | { mode: 'SELECT_FUEL_REMOVE'; ringIdx: number; slotIdx: number }
  | { mode: 'SELECT_MOVE_DEST'; fromRing: number; fromSlot: number }
  | { mode: 'SELECT_FUEL_MOVE'; fromRing: number; fromSlot: number; toRing: number; toSlot: number };

let selectedCardUid: string | null = null;
let actionState: ActionState = { mode: 'IDLE' };

// DOM 元素缓存
const dashboardEl = document.getElementById('dashboard')!;
const boardEl = document.getElementById('board')!;
const logEl = document.getElementById('log')!;
const handEl = document.getElementById('hand')!;
const handCountEl = document.getElementById('hand-count')!;
const hintEl = document.getElementById('hint')!;
const btnRun = document.getElementById('btn-run') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;

// 类别中文映射与类名
const CATEGORY_MAP: Record<DaoCategory, { label: string; className: string }> = {
  CONDUCT: { label: '传导', className: 'tag-conduct' },
  AMPLIFY: { label: '增幅', className: 'tag-amplify' },
  RELEASE: { label: '释放', className: 'tag-release' },
};

const SUBSTAGE_NAMES = ['', '初期', '中期', '巅峰'];

// ------------------------------------------------------------
// 渲染：顶部仪表盘
// ------------------------------------------------------------
function renderDashboard(): void {
  const realmName = BOARD.realmNames[state.realm - 1] ?? '未知';
  const stageName = `${realmName}期 · ${SUBSTAGE_NAMES[state.subStage] ?? ''} (${state.realm}-${state.subStage})`;

  let statusBadge = `<span class="dash-status status-normal">修道中</span>`;
  if (state.isVictory) {
    statusBadge = `<span class="dash-status status-victory">化神飞升 (大圆满)</span>`;
  } else if (state.isGameOver) {
    statusBadge = `<span class="dash-status status-danger">走火入魔 (Game Over)</span>`;
  }

  dashboardEl.innerHTML = `
    <div class="dash-title">
      <h1>《周天破境录》数值引擎调试台</h1>
      <span class="realm-badge">${stageName}</span>
      ${statusBadge}
    </div>
    <div class="dash-metrics">
      <div class="metric-item">
        <span class="metric-label">当前真气池</span>
        <span class="metric-val val-green">${state.currentQi}</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">破障阈值 (单次最低)</span>
        <span class="metric-val val-gold">${state.stageThreshold}</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">下次运转耗气 (第${state.turnCountInStage + 1}次)</span>
        <span class="metric-val ${state.currentQi < state.nextQiCost ? 'val-red' : 'val-purple'}">${state.nextQiCost}</span>
      </div>
    </div>
  `;

  btnRun.disabled = state.isGameOver || state.isVictory;
}

// ------------------------------------------------------------
// 渲染：中部阵盘区
// ------------------------------------------------------------
function renderBoard(): void {
  boardEl.innerHTML = '';

  state.board.forEach((ring) => {
    const realmName = BOARD.realmNames[ring.ringIdx];
    const ringEl = document.createElement('div');
    ringEl.className = `ring-container ${ring.unlocked ? '' : 'locked'}`;

    const ringHeader = document.createElement('div');
    ringHeader.className = 'ring-header';
    ringHeader.innerHTML = `
      <span>第 ${ring.ringIdx + 1} 环 · ${realmName}期 (${ring.maxSlots} 槽位)</span>
      <span>${ring.unlocked ? '已解锁' : '未解锁（需突破大境界）'}</span>
    `;
    ringEl.appendChild(ringHeader);

    const slotsGrid = document.createElement('div');
    slotsGrid.className = 'ring-slots-grid';

    ring.slots.forEach((node, slotIdx) => {
      const slotEl = document.createElement('div');
      slotEl.className = `slot-node ${node ? 'occupied' : 'empty'}`;

      if (!ring.unlocked) {
        slotEl.classList.add('locked');
        slotEl.innerHTML = `<span class="slot-idx">Ring ${ring.ringIdx} - [${slotIdx}]</span><span class="slot-desc">待解锁</span>`;
        slotsGrid.appendChild(slotEl);
        return;
      }

      if (node === null) {
        // 空槽
        let placeholder = `+ 空槽 [${slotIdx}]`;
        if (actionState.mode === 'SELECT_MOVE_DEST') {
          placeholder = `➤ 移至此处 [${slotIdx}]`;
        }
        slotEl.innerHTML = `<span class="slot-idx">Slot ${slotIdx}</span><span>${placeholder}</span>`;
        slotEl.onclick = () => onEmptySlotClick(ring.ringIdx, slotIdx);
      } else {
        // 已有道韵
        const catInfo = CATEGORY_MAP[node.category];
        slotEl.innerHTML = `
          <div class="slot-header">
            <span class="slot-idx">Slot ${slotIdx}</span>
            <span class="tag ${catInfo.className}">${catInfo.label}</span>
          </div>
          <div class="slot-name">${node.name} <span class="level-tag">LV${node.level}</span></div>
          <div class="slot-desc">${node.description}</div>
          <div class="slot-actions">
            <button class="slot-mini-btn" data-action="overwrite">覆盖</button>
            <button class="slot-mini-btn" data-action="move">移位</button>
            <button class="slot-mini-btn btn-danger" data-action="remove">拆除</button>
          </div>
        `;

        slotEl.onclick = (e) => {
          const target = e.target as HTMLElement;
          const action = target.getAttribute('data-action');
          if (action === 'overwrite') {
            e.stopPropagation();
            onStartOverwrite(ring.ringIdx, slotIdx);
          } else if (action === 'move') {
            e.stopPropagation();
            onStartMove(ring.ringIdx, slotIdx);
          } else if (action === 'remove') {
            e.stopPropagation();
            onStartRemove(ring.ringIdx, slotIdx);
          } else {
            onOccupiedSlotClick(ring.ringIdx, slotIdx);
          }
        };
      }

      slotsGrid.appendChild(slotEl);
    });

    ringEl.appendChild(slotsGrid);
    boardEl.appendChild(ringEl);
  });
}

// ------------------------------------------------------------
// 渲染：底部手牌区
// ------------------------------------------------------------
function renderHand(): void {
  handCountEl.textContent = `(${state.hand.length} 张)`;
  handEl.innerHTML = '';

  state.hand.forEach((card) => {
    const cardEl = document.createElement('div');
    const isSelected = selectedCardUid === card.uid;
    const isFuelTarget =
      actionState.mode === 'SELECT_FUEL_OVERWRITE' ||
      actionState.mode === 'SELECT_FUEL_REMOVE' ||
      actionState.mode === 'SELECT_FUEL_MOVE';

    cardEl.className = `hand-card ${isSelected ? 'selected' : ''} ${isFuelTarget && isSelected ? 'fuel-target' : ''}`;
    const catInfo = CATEGORY_MAP[card.category];

    cardEl.innerHTML = `
      <div class="card-top">
        <span class="tag ${catInfo.className}">${catInfo.label}</span>
        <span class="level-tag">LV${card.level}</span>
      </div>
      <div class="card-title">${card.name}</div>
      <div class="card-desc">${card.description}</div>
    `;

    cardEl.onclick = () => onCardClick(card);
    handEl.appendChild(cardEl);
  });

  updateHint();
}

function updateHint(): void {
  if (actionState.mode === 'SELECT_FUEL_OVERWRITE') {
    hintEl.className = 'hint active';
    hintEl.textContent = '【覆盖模式】请在手牌中点击 1 张作为【改阵燃料】进行销毁以完成覆盖（或点其他重置）';
  } else if (actionState.mode === 'SELECT_FUEL_REMOVE') {
    hintEl.className = 'hint active';
    hintEl.textContent = '【拆除模式】请在手牌中点击 1 张作为【改阵燃料】以清空所选槽位（或点其他重置）';
  } else if (actionState.mode === 'SELECT_MOVE_DEST') {
    hintEl.className = 'hint active';
    hintEl.textContent = '【移位模式】请点击阵盘上的任一【空槽】作为目标位置';
  } else if (actionState.mode === 'SELECT_FUEL_MOVE') {
    hintEl.className = 'hint active';
    hintEl.textContent = '【移位模式】请在手牌中点击 1 张作为【改阵燃料】以确认移位';
  } else if (selectedCardUid) {
    const card = state.hand.find((c) => c.uid === selectedCardUid);
    hintEl.className = 'hint active';
    hintEl.textContent = `已选定【${card?.name ?? ''}】：点击阵盘空槽可直接放入；点击已有道韵槽位可选择覆盖`;
  } else {
    hintEl.className = 'hint';
    hintEl.textContent = '点击手牌选中 · 点击阵盘空槽部署（消耗1）· 点击已有槽位覆盖（额外消耗1燃料）';
  }
}

// ------------------------------------------------------------
// 交互事件处理
// ------------------------------------------------------------

function onCardClick(card: DaoRhyme): void {
  // 处于选择燃料模式
  if (actionState.mode === 'SELECT_FUEL_OVERWRITE') {
    if (card.uid === actionState.placeCardUid) {
      appendLogEntry({
        seq: Date.now(),
        pulseId: 'UI',
        ringIdx: actionState.ringIdx,
        slotIdx: actionState.slotIdx,
        action: 'WARN',
        detail: '燃料卡不能与被放置的道韵卡相同，请选择另一张手牌',
      });
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

  // 普通选中 / 反选
  if (selectedCardUid === card.uid) {
    selectedCardUid = null;
  } else {
    selectedCardUid = card.uid;
  }
  renderHand();
}

function onEmptySlotClick(ringIdx: number, slotIdx: number): void {
  if (actionState.mode === 'SELECT_MOVE_DEST') {
    actionState = {
      mode: 'SELECT_FUEL_MOVE',
      fromRing: actionState.fromRing,
      fromSlot: actionState.fromSlot,
      toRing: ringIdx,
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

  const res = placeDao(state, selectedCardUid, ringIdx, slotIdx);
  appendNotice(res.message, res.success ? 'info' : 'warn');
  if (res.success) {
    selectedCardUid = null;
  }
  renderAll();
}

function onOccupiedSlotClick(ringIdx: number, slotIdx: number): void {
  if (selectedCardUid) {
    // 携带手牌点击已有槽位 -> 尝试进入覆盖
    onStartOverwrite(ringIdx, slotIdx);
  }
}

function onStartOverwrite(ringIdx: number, slotIdx: number): void {
  if (state.hand.length < 2) {
    appendNotice('覆盖已有道韵需要至少 2 张手牌（1 张放置 + 1 张燃料）', 'warn');
    return;
  }
  if (!selectedCardUid) {
    appendNotice('请先在手牌中选定准备放置的新道韵，随后再指定燃料卡', 'warn');
    return;
  }
  actionState = {
    mode: 'SELECT_FUEL_OVERWRITE',
    placeCardUid: selectedCardUid,
    ringIdx,
    slotIdx,
  };
  renderHand();
}

function onStartRemove(ringIdx: number, slotIdx: number): void {
  if (state.hand.length < 1) {
    appendNotice('拆除道韵需消耗 1 张手牌作为燃料，当前手牌为空', 'warn');
    return;
  }
  actionState = {
    mode: 'SELECT_FUEL_REMOVE',
    ringIdx,
    slotIdx,
  };
  renderHand();
}

function onStartMove(ringIdx: number, slotIdx: number): void {
  if (state.hand.length < 1) {
    appendNotice('移位道韵需消耗 1 张手牌作为燃料，当前手牌为空', 'warn');
    return;
  }
  actionState = {
    mode: 'SELECT_MOVE_DEST',
    fromRing: ringIdx,
    fromSlot: slotIdx,
  };
  renderBoard();
  renderHand();
}

function resetActionState(): void {
  selectedCardUid = null;
  actionState = { mode: 'IDLE' };
}

// ------------------------------------------------------------
// 运转与日志
// ------------------------------------------------------------

function runTurnAction(): void {
  resetActionState();

  const turnRes = executeTurn(state);
  renderDashboard();
  renderBoard();
  renderHand();

  // 输出日志汇总
  const summaryEl = document.createElement('div');
  if (turnRes.isGameOver) {
    summaryEl.className = 'log-entry summary lose';
    summaryEl.textContent = `【走火入魔】真气不足以支付本次运转消耗 (${state.nextQiCost})，游戏结束！`;
    logEl.prepend(summaryEl);
    showModal('走火入魔', '你的真气耗尽，无法维系周天运转，走火入魔！', false);
    return;
  }

  if (turnRes.cleared) {
    summaryEl.className = 'log-entry summary win';
    let text = `【破关大捷】单次产气 ${turnRes.simulation.turnQiGenerated} >= 阈值 ${state.stageThreshold}！突破至关卡 (${state.realm}-${state.subStage})`;
    if (turnRes.newRealmUnlocked) {
      text += `，境界突破！解锁第 ${state.realm} 环阵盘！`;
    }
    summaryEl.textContent = text;
    logEl.prepend(summaryEl);

    if (turnRes.isVictory) {
      showModal('化神大圆满', '恭喜你通关化神巅峰（5-3），周天圆满，飞升登仙！', true);
    } else {
      showLootModal(turnRes);
    }
  } else {
    summaryEl.className = 'log-entry summary';
    summaryEl.textContent = `【周天运转】扣气 ${turnRes.charged}，本次产气 ${turnRes.simulation.turnQiGenerated}（未达阈值 ${state.stageThreshold}），气池结余 ${state.currentQi}`;
    logEl.prepend(summaryEl);
  }

  // 逐行输出仿真日志
  turnRes.simulation.logs.forEach((item) => {
    appendLogEntry(item);
  });
}

function appendLogEntry(entry: {
  seq: number;
  pulseId: string;
  ringIdx: number;
  slotIdx: number;
  action: string;
  detail: string;
  qiDelta?: number;
}): void {
  const el = document.createElement('div');
  el.className = 'log-entry';
  const deltaStr = entry.qiDelta !== undefined ? ` [产气 +${entry.qiDelta}]` : '';
  el.innerHTML = `
    <span style="color:#8b949e">#${entry.seq}</span>
    <span style="color:#58a6ff">[${entry.pulseId}]</span>
    <span style="color:#bc8cff">R${entry.ringIdx}:S${entry.slotIdx}</span>
    <span class="log-action-${entry.action}">[${entry.action}]</span>
    <span>${entry.detail}</span>
    <strong style="color:#da3633">${deltaStr}</strong>
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
// 弹窗提示与战利品结算
// ------------------------------------------------------------

function showLootModal(res: TurnExecutionResult): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal-content';

  let realmBonusMsg = '';
  if (res.newRealmUnlocked) {
    realmBonusMsg = `<p style="color:var(--text-gold);font-weight:bold;">✨ 境界晋升至【${BOARD.realmNames[state.realm - 1]}期】，已解锁全新阵盘环！</p>`;
  }

  modal.innerHTML = `
    <h3>破关成功！缴获战利品</h3>
    <p>单次运转爆发真气：<strong class="val-gold">${res.simulation.turnQiGenerated}</strong> / 破障阈值：${state.stageThreshold}</p>
    ${realmBonusMsg}
    <p>获得以下 ${res.lootAwarded.length} 张全新道韵（LV${state.realm}）：</p>
    <div class="loot-grid">
      ${res.lootAwarded
        .map(
          (card) => `
        <div class="hand-card" style="cursor:default">
          <div class="card-top">
            <span class="tag ${CATEGORY_MAP[card.category].className}">${CATEGORY_MAP[card.category].label}</span>
            <span class="level-tag">LV${card.level}</span>
          </div>
          <div class="card-title">${card.name}</div>
          <div class="card-desc">${card.description}</div>
        </div>
      `,
        )
        .join('')}
    </div>
    <div class="modal-footer">
      <button class="btn btn-primary" id="btn-loot-confirm">纳入行囊，进入下一小关</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  document.getElementById('btn-loot-confirm')!.onclick = () => {
    document.body.removeChild(overlay);
    renderAll();
  };
}

function showModal(title: string, content: string, isWin: boolean): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal-content';
  modal.innerHTML = `
    <h3 style="color:${isWin ? 'var(--text-gold)' : 'var(--text-red)'}">${title}</h3>
    <p>${content}</p>
    <div class="modal-footer">
      <button class="btn btn-primary" id="btn-modal-reset">重开新局</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  document.getElementById('btn-modal-reset')!.onclick = () => {
    document.body.removeChild(overlay);
    resetGame();
  };
}

function resetGame(): void {
  state = createInitialGameState();
  resetActionState();
  logEl.innerHTML = '';
  appendNotice('周天阵盘已重置，大道重修开局。', 'info');
  renderAll();
}

function renderAll(): void {
  renderDashboard();
  renderBoard();
  renderHand();
}

// 绑定全局按钮
btnRun.onclick = runTurnAction;
btnReset.onclick = resetGame;

// 初始挂载渲染
renderAll();
appendNotice('调试台初始化完成。请在下方选择道韵卡布置阵盘，随后点击【运转周天】。', 'info');
