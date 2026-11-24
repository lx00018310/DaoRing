// ============================================================
// 斗法模式入口（battle.html）
// 一场一场的斗法：凝炼道韵灵印入阵 → 运转周天 → 万剑诀 / 灵爆术攻敌 →
// 单次产气破开护体魔光即斩敌晋升，获得道韵与灵宝；
// 真气不足以再运周天即身死道消。规则全部来自 game.ts / engine.ts。
// ============================================================
import { BOARD, getRelicConfig, getStageConfig } from '../config';
import { moveDao, placeDao, removeDao, type PlacementResult } from '../game';
import type { DaoRhyme, RelicConfig } from '../types';
import { BalatroBackdrop } from './balatroShader';
import { CATEGORY_HEX, CATEGORY_LABEL, DAO_ORB_FILES, ROMAN, formatQi, orbArtPath, shortName } from './daoVisual';
import { SLOT_HIT, STAGE_H, STAGE_W, slotPoint, type SlotRef } from './geometry';
import { FOE_ART_FILES, type FoeArt } from './foes';
import { attachOrbJuice, popBounce } from './orbJuice';
import { BattleScene, categoryOf } from './scene';
import { BattleSession, talentRows, upgradeSavedTalent, type BattleTurn } from './session';
import { loadKarmaProfile } from '../storage';
import { sfx } from './sfx';
import { sound } from '../audio';

type Action =
  | { mode: 'IDLE' }
  | { mode: 'FUEL_OVERWRITE'; target: SlotRef; cardUid: string }
  | { mode: 'FUEL_REMOVE'; target: SlotRef }
  | { mode: 'MOVE_DEST'; from: SlotRef }
  | { mode: 'FUEL_MOVE'; from: SlotRef; to: SlotRef };

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const stageEl = $('stage');
const canvas = $<HTMLCanvasElement>('cv');
const slotsEl = $('slots');
const menuEl = $('menu');
const handEl = $('hand');
const hintEl = $('hint');
const toastEl = $('toast');
const tallyEl = $('tally');
const calcBaseEl = $('calc-base');
const calcMultEl = $('calc-mult');
const calcTotalEl = $('calc-total');
const modalEl = $('modal');
const btnRun = $<HTMLButtonElement>('btn-run');
const btnFuse = $<HTMLButtonElement>('btn-fuse');
const btnSkip = $<HTMLButtonElement>('btn-skip');

const REALM_NAMES = BOARD.realmNames.map((name) => `${name}期`);

// WebGL 实时道韵漩涡底景
const backdrop = new BalatroBackdrop(document.getElementById('bg-gl') as HTMLCanvasElement | null);
backdrop.start();

// 触感反馈：道韵灵珠 3D 悬停倾角与高光
attachOrbJuice(handEl, '.card');

const foeArt = Object.fromEntries(
  (Object.keys(FOE_ART_FILES) as FoeArt[]).map((art) => [art, `assets/battle/${FOE_ART_FILES[art]}`]),
) as Record<FoeArt, string>;
const daoOrbArt = Object.fromEntries(
  Object.keys(DAO_ORB_FILES).map((id) => [id, orbArtPath(id)]),
);
const scene = new BattleScene(canvas, $('fx'), {
  // 全境界统一套用「方案二：演武巨殿」傍晚火烧云演武场（后续可按境界追加专属图）
  backgrounds: [
    'assets/battle/bg_martial_plaza.webp',
  ],
  hero: 'assets/battle/hero_cultivator.webp',
  foes: foeArt,
  daos: daoOrbArt,
}, BOARD.ringSlots);

let session = BattleSession.fromSavedProfile();
let action: Action = { mode: 'IDLE' };
let selectedUid: string | null = null;
let playing = false;
let shownDamage = 0;
let peakQi = 100;

interface HudModel {
  realm: number;
  subStage: number;
  qi: number;
  cost: number;
  freeTurns: number;
  turnInStage: number;
  tribName: string | null;
  tribDesc: string;
  relics: string[];
  foeName: string;
  threshold: number;
}
let hudOverride: HudModel | null = null;
let handFrozen = false;

function liveHud(): HudModel {
  const st = session.state;
  return {
    realm: st.realm,
    subStage: st.subStage,
    qi: st.currentQi,
    cost: session.nextCost,
    freeTurns: st.freeTurnsLeft,
    turnInStage: st.turnCountInStage,
    tribName: st.activeTribulation?.name ?? null,
    tribDesc: st.activeTribulation?.description ?? '',
    relics: [...st.relics],
    foeName: session.foe.name,
    threshold: st.stageThreshold,
  };
}

const sameRef = (a: SlotRef | null | undefined, b: SlotRef | null | undefined): boolean =>
  !!a && !!b && a.ring === b.ring && a.slot === b.slot;
const slotName = (ref: SlotRef): string =>
  ref.ring === 0 ? ['第一眼 · 入气', '第二眼', '第三眼', '第四眼'][ref.slot] ?? `第${ref.slot + 1}眼` : `第${ref.ring + 1}环 · ${ref.slot + 1}号眼`;
const busy = (): boolean => playing || !modalEl.hidden || session.isOver;

// ------------------------------------------------------------ 舞台缩放

function fit(): void {
  const s = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  stageEl.style.transform = `translate(${(window.innerWidth - STAGE_W * s) / 2}px, ${(window.innerHeight - STAGE_H * s) / 2}px) scale(${s})`;
}
window.addEventListener('resize', fit);
fit();

// ------------------------------------------------------------ 渲染

function setHint(html: string): void {
  hintEl.innerHTML = html;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(html: string, ms = 2600): void {
  toastEl.innerHTML = html;
  toastEl.classList.add('on');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms);
}

function setFoeBar(): void {
  const threshold = Math.max(1, (hudOverride ?? liveHud()).threshold);
  $('foe-fill').style.width = `${Math.max(0, (1 - shownDamage / threshold) * 100)}%`;
}

function renderHud(): void {
  const hud = hudOverride ?? liveHud();
  const cost = hud.cost;
  peakQi = Math.max(peakQi, hud.qi, cost * 1.2, 1);
  $('realm-txt').textContent = `${REALM_NAMES[hud.realm - 1] ?? ''} · ${['', '初期', '中期', '巅峰'][hud.subStage] ?? ''}`;
  $('qi-fill').style.width = `${Math.min(100, (hud.qi / peakQi) * 100)}%`;
  $('cost-mark').style.left = `${Math.min(100, (cost / peakQi) * 100)}%`;
  $('qi-txt').textContent = formatQi(hud.qi);
  const free = hud.freeTurns > 0 ? ` · <span class="good">免耗 ${hud.freeTurns} 次</span>` : '';
  const warn = hud.qi < cost ? 'warn' : '';
  $('cost-txt').innerHTML = `下次运转耗 <span class="${warn}">${formatQi(cost)}</span>${free} · 本关第 ${hud.turnInStage + 1} 次`;
  $('trib-tag').hidden = !hud.tribName;
  $('trib-tag').textContent = hud.tribName ?? '';
  $('trib-tag').title = hud.tribDesc;
  const relics = $('relics');
  relics.replaceChildren(...hud.relics.map((id) => {
    const cfg = getRelicConfig(id);
    const chip = document.createElement('span');
    chip.className = 'relic-chip';
    chip.textContent = cfg.name.slice(0, 1);
    chip.title = `${cfg.name}：${cfg.description}`;
    return chip;
  }));
  $('foe-txt').textContent = hud.foeName;
  $('th-txt').textContent = `护体魔光 ${formatQi(hud.threshold)} · 单次产气 ≥ ${formatQi(hud.threshold)} 方可破障`;
  $('run-cost').textContent = hud.freeTurns > 0 ? '免耗' : `耗 ${formatQi(cost)}`;
  btnRun.disabled = busy() || action.mode !== 'IDLE';
  btnFuse.disabled = busy() || session.fusionOptions().length === 0;
  $('tray').classList.toggle('locked', busy());
  setFoeBar();
}

function renderHand(): void {
  if (handFrozen) return;
  const hand = session.state.hand;
  if (!hand.length) {
    handEl.innerHTML = '<div class="empty-hand">玉匣已空 · 暂无蕴藏道韵</div>';
    return;
  }
  const fueling = action.mode === 'FUEL_OVERWRITE' || action.mode === 'FUEL_REMOVE' || action.mode === 'FUEL_MOVE';
  const sorted = [...hand].sort((a, b) => a.category.localeCompare(b.category) || a.configId.localeCompare(b.configId) || b.level - a.level);
  handEl.replaceChildren(...sorted.map((card, idx) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.uid = card.uid;
    b.dataset.configId = card.configId;
    b.className = `card dao-orb cat-${card.category} tier-${Math.min(5, Math.max(1, card.level))}`;
    b.style.setProperty('--bob-delay', `${(-idx * 0.45).toFixed(2)}s`);
    b.classList.toggle('sel', card.uid === selectedUid);
    b.classList.toggle('fuelable', fueling && !(action.mode === 'FUEL_OVERWRITE' && action.cardUid === card.uid));
    b.disabled = action.mode === 'MOVE_DEST' || (action.mode === 'FUEL_OVERWRITE' && action.cardUid === card.uid);
    b.innerHTML = `
      <span class="orb-ring" aria-hidden="true"></span>
      <span class="orb-core">
        <img class="orb-art" src="${orbArtPath(card.configId)}" alt="" draggable="false" />
        <span class="orb-sheen" aria-hidden="true"></span>
        <span class="orb-lv">${ROMAN[card.level] ?? card.level}</span>
      </span>
      <span class="orb-name">${shortName(card)}</span>
    `;
    b.title = `${card.name} ${ROMAN[card.level] ?? card.level}阶【${CATEGORY_LABEL[card.category]}】
${card.description}`;
    b.setAttribute('aria-label', `${card.name} ${card.level}级：${card.description}`);
    b.onclick = () => onCard(card);
    b.onmouseenter = () => {
      if (action.mode === 'IDLE' && !selectedUid && !busy()) setHint(cardHint(card));
    };
    return b;
  }));
}

function cardHint(card: DaoRhyme): string {
  return `<b style="color:${CATEGORY_HEX[card.category]}">${card.name} ${ROMAN[card.level] ?? ''}</b> · ${card.description}`;
}

function renderSlots(): void {
  const buttons: HTMLButtonElement[] = [];
  session.state.board.forEach((ring, r) => {
    if (!ring.unlocked) return;
    for (let s = 0; s < ring.maxSlots; s++) {
      const ref = { ring: r, slot: s };
      const p = slotPoint(r, s);
      const node = ring.slots[s];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slotbtn';
      b.id = `slot-${r}-${s}`;
      b.style.left = `${p.x - SLOT_HIT.w / 2}px`;
      b.style.top = `${p.y - SLOT_HIT.h / 2 - 8}px`;
      b.style.width = `${SLOT_HIT.w}px`;
      b.style.height = `${SLOT_HIT.h}px`;
      const label = `${slotName(ref)}：${node ? `${node.name} ${node.level}级` : '空'}`;
      b.setAttribute('aria-label', label);
      b.title = node ? `${label}
${node.description}` : label;
      b.onclick = (e) => {
        e.stopPropagation();
        onSlot(ref);
      };
      b.onmouseenter = () => {
        scene.view.hover = ref;
        if (action.mode === 'IDLE' && !selectedUid && !busy() && node) setHint(`${cardHint(node)} · 点击可拆除 / 移位`);
      };
      b.onmouseleave = () => {
        if (sameRef(scene.view.hover, ref)) scene.view.hover = null;
      };
      buttons.push(b);
    }
  });
  slotsEl.replaceChildren(...buttons);
}

function syncScene(): void {
  scene.view = {
    board: session.state.board,
    placing: action.mode === 'IDLE' && !!selectedUid,
    moveTargeting: action.mode === 'MOVE_DEST',
    target: action.mode === 'FUEL_OVERWRITE' || action.mode === 'FUEL_REMOVE' ? action.target
      : action.mode === 'MOVE_DEST' || action.mode === 'FUEL_MOVE' ? action.from : null,
    hover: scene.view.hover,
  };
}

function renderAll(): void {
  renderHud();
  renderHand();
  if (!handFrozen) renderSlots();
  syncScene();
}

// ------------------------------------------------------------ 布阵交互

function cancelAction(message = '已取消。'): void {
  action = { mode: 'IDLE' };
  selectedUid = null;
  closeMenu();
  renderAll();
  setHint(message);
}

function afterPlacement(result: PlacementResult, ref: SlotRef, kind: 'place' | 'overwrite' | 'remove' | 'move'): void {
  action = { mode: 'IDLE' };
  selectedUid = null;
  if (!result.success) {
    renderAll();
    setHint(`<span class="warn">${result.message}</span>`);
    return;
  }
  const node = session.state.board[ref.ring].slots[ref.slot];
  if (kind === 'remove') {
    scene.removeFx(ref);
    sfx.whoosh();
  } else if (node) {
    scene.placeFx(ref, categoryOf(node.configId), kind === 'overwrite');
    backdrop.pulse(0.28);
    sfx.place();
    sfx.chime(2);
  }
  renderAll();
  setHint(result.fuelWaived ? `<b>${result.message}</b>` : `${result.message.replace(/Ring (\d+) Slot (\d+)/, (_m, r, s) => slotName({ ring: Number(r), slot: Number(s) }))}。可继续布阵，或点击<b>周天</b>斗法。`);
  const ring = session.state.board[ref.ring].slots;
  const firstRelease = ring.findIndex((c) => c?.category === 'RELEASE');
  if (ref.ring === 0 && firstRelease >= 0 && ring.slice(firstRelease + 1).some((c) => c && c.category !== 'RELEASE')) {
    toast('灵气先遇到释放道韵就会出手，后面的增幅或分光可能来不及触发', 3200);
  }
}

function onCard(card: DaoRhyme): void {
  if (busy()) return;
  sfx.unlock();
  sound.unlock();
  closeMenu();
  const st = session.state;
  switch (action.mode) {
    case 'FUEL_OVERWRITE':
      afterPlacement(placeDao(st, action.cardUid, action.target.ring, action.target.slot, card.uid), action.target, 'overwrite');
      return;
    case 'FUEL_REMOVE':
      afterPlacement(removeDao(st, action.target.ring, action.target.slot, card.uid), action.target, 'remove');
      return;
    case 'FUEL_MOVE':
      afterPlacement(moveDao(st, action.from.ring, action.from.slot, action.to.ring, action.to.slot, card.uid), action.to, 'move');
      return;
    case 'MOVE_DEST':
      return;
    default:
      selectedUid = selectedUid === card.uid ? null : card.uid;
      sfx.place();
      renderAll();
      setHint(selectedUid ? `${cardHint(card)} → 点选阵眼凝入道韵（空眼耗 1 枚；覆盖需再炼化 1 枚作引）` : '已收回所选道韵灵印。');
  }
}

function onSlot(ref: SlotRef): void {
  if (busy()) return;
  sfx.unlock();
  closeMenu();
  const st = session.state;
  const node = st.board[ref.ring].slots[ref.slot];
  if (action.mode === 'MOVE_DEST') {
    if (node) {
      setHint('<span class="warn">移位只能移到空阵眼。</span>');
      return;
    }
    action = { mode: 'FUEL_MOVE', from: action.from, to: ref };
    renderAll();
    setHint(`移到${slotName(ref)}：点选 <b>1 枚</b>道韵灵印作炼化引火 · Esc 取消`);
    return;
  }
  if (action.mode !== 'IDLE') {
    cancelAction();
    return;
  }
  if (selectedUid) {
    if (!node) {
      afterPlacement(placeDao(st, selectedUid, ref.ring, ref.slot), ref, 'place');
      return;
    }
    if (st.hand.length < 2) {
      setHint('<span class="warn">覆盖需要待凝入的道韵和另一枚炼化引火。</span>');
      return;
    }
    action = { mode: 'FUEL_OVERWRITE', target: ref, cardUid: selectedUid };
    renderAll();
    setHint(`覆盖【${node.name}】：再选 <b>1 枚</b>道韵作炼化引火（旧道韵与引火皆散）· 再点阵眼或 Esc 取消`);
    return;
  }
  if (node) openMenu(ref, node);
  else setHint('先从下方玉匣点选一枚道韵灵印，再凝入此阵眼。');
}

function openMenu(ref: SlotRef, node: DaoRhyme): void {
  const p = slotPoint(ref.ring, ref.slot);
  const noFuel = session.state.hand.length < 1;
  const hasEmpty = session.state.board.some((ring) => ring.unlocked && ring.slots.includes(null));
  menuEl.replaceChildren();
  const add = (text: string, fn: () => void, disabled = false): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.disabled = disabled;
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    menuEl.append(b);
  };
  add('散去（炼化 1 枚）', () => {
    closeMenu();
    action = { mode: 'FUEL_REMOVE', target: ref };
    renderAll();
    setHint(`散去【${node.name}】：点选 <b>1 枚</b>道韵作炼化引火 · Esc 取消`);
  }, noFuel);
  add('移位（炼化 1 枚）', () => {
    closeMenu();
    action = { mode: 'MOVE_DEST', from: ref };
    renderAll();
    setHint(`移位【${node.name}】：先点一个<b>空阵眼</b> · Esc 取消`);
  }, noFuel || !hasEmpty);
  add('取消', closeMenu);
  menuEl.hidden = false;
  menuEl.style.left = `${Math.min(STAGE_W - 340, Math.max(10, p.x - 150))}px`;
  menuEl.style.top = `${p.y + 22}px`;
  menuEl.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}

function closeMenu(): void {
  menuEl.hidden = true;
}

// ------------------------------------------------------------ 弹窗

function openModal(html: string): HTMLElement {
  modalEl.innerHTML = `<div class="panel">${html}</div>`;
  modalEl.hidden = false;
  renderHud();
  return modalEl;
}

function closeModal(): void {
  modalEl.hidden = true;
  modalEl.innerHTML = '';
  renderHud();
}

function chooseRelic(choices: RelicConfig[]): Promise<void> {
  return new Promise((resolve) => {
    const m = openModal(`<div class="ptitle">灵宝认主</div><div class="psub">大境界突破，天地馈赠：三选一，永久生效</div><div class="opts"></div>
      <button type="button" class="linkbtn" id="relic-skip">暂不认主</button>`);
    const box = m.querySelector('.opts')!;
    choices.forEach((relic) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt relic';
      b.innerHTML = `<div class="g">${relic.name.slice(0, 1)}</div><div class="n">${relic.name}</div><div class="d">${relic.description}</div>`;
      b.onclick = () => {
        const out = session.chooseRelic(relic.id);
        closeModal();
        sfx.win();
        toast(out.message, 3600);
        resolve();
      };
      box.append(b);
    });
    m.querySelector<HTMLButtonElement>('#relic-skip')!.onclick = () => {
      session.skipRelic();
      closeModal();
      resolve();
    };
    box.querySelector<HTMLButtonElement>('button')?.focus();
  });
}

function showLoot(loot: DaoRhyme[], doubled: boolean): Promise<void> {
  return new Promise((resolve) => {
    const orbs = loot.map((card) => `<div class="loot cat-${card.category} tier-${Math.min(5, Math.max(1, card.level))}" title="${card.description}">
      <div class="loot-orb"><img src="${orbArtPath(card.configId)}" alt="" /></div>
      <div class="n" style="color:${CATEGORY_HEX[card.category]}">${card.name} ${ROMAN[card.level] ?? ''}</div></div>`).join('');
    const m = openModal(`<div class="ptitle">斩敌所得</div>
      <div class="psub">${loot.length ? `${loot.length} 枚道韵灵印凝入玉匣${doubled ? '（九霄神雷劫 · 战利品翻倍）' : ''}` : '此战未得道韵'}</div>
      <div class="loots">${orbs}</div>
      <button type="button" class="bigbtn" id="loot-ok">继续斗法</button>`);
    const ok = m.querySelector<HTMLButtonElement>('#loot-ok')!;
    ok.onclick = () => {
      closeModal();
      resolve();
    };
    ok.focus();
  });
}

function endModal(victory: boolean): void {
  const settle = session.settleKarma();
  const st = session.state;
  const stage = getStageConfig(st.realm, st.subStage);
  const stats = `<div class="stats">
    <div><b>${st.runStats.stagesCleared}</b>斩敌</div>
    <div><b>${st.runStats.turnsPlayed}</b>运转</div>
    <div><b>${formatQi(st.runStats.highestSingleQi)}</b>最高单次产气</div>
    <div><b>+${settle?.karmaGained ?? 0}</b>功德</div></div>`;
  const m = victory
    ? openModal(`<div class="ptitle">化 神 大 成</div><div class="psub">连斩 ${st.runStats.stagesCleared} 敌，飞升在即。累计功德 ${settle?.profile.totalKarma ?? 0}</div>${stats}
        <button type="button" class="bigbtn" id="again">再修一世</button>`)
    : openModal(`<div class="ptitle red">道 途 断 绝</div><div class="psub">真气枯竭，走火入魔，陨落于 ${stage.name} —— ${session.foe.name}</div>${stats}
        <button type="button" class="bigbtn" id="again">重入轮回</button>`);
  const again = m.querySelector<HTMLButtonElement>('#again')!;
  again.onclick = newGame;
  const panel = m.querySelector('.panel')!;
  const talents = document.createElement('button');
  talents.type = 'button';
  talents.className = 'linkbtn';
  talents.textContent = '参悟天赋';
  talents.onclick = () => talentModal(() => endModal(victory));
  panel.append(document.createElement('br'), talents);
  again.focus();
}

function talentModal(onClose: () => void = closeModal): void {
  const profile = loadKarmaProfile();
  const rows = talentRows(profile).map((t) => {
    const pips = '●'.repeat(t.level) + '○'.repeat(t.maxLevel - t.level);
    const btn = t.nextCost === null
      ? '<span class="maxed">已圆满</span>'
      : `<button type="button" class="talent-up" data-id="${t.id}" ${profile.totalKarma < t.nextCost ? 'disabled' : ''}>参悟 · ${t.nextCost} 功德</button>`;
    return `<div class="talent-row"><div class="tn"><b>${t.name}</b><span class="pips">${pips}</span></div><div class="td">${t.description}</div>${btn}</div>`;
  }).join('');
  const m = openModal(`<div class="ptitle" style="font-size:44px">参悟天赋</div>
    <div class="psub">现有功德 <b class="karma">${profile.totalKarma}</b> · 历史最高单次产气 ${formatQi(profile.historyHighQi)} · 已修 ${profile.totalRuns} 世，飞升 ${profile.victories} 次<br>天赋永久生效，从下一局开局起算</div>
    <div class="talents">${rows}</div>
    <button type="button" class="bigbtn" id="talent-close">合上</button>`);
  m.querySelectorAll<HTMLButtonElement>('.talent-up').forEach((b) => {
    b.onclick = () => {
      const out = upgradeSavedTalent(b.dataset.id ?? '');
      if (out.success) sfx.win();
      toast(out.message, 2600);
      talentModal(onClose);
    };
  });
  const close = m.querySelector<HTMLButtonElement>('#talent-close')!;
  close.onclick = () => {
    closeModal();
    onClose();
  };
  (m.querySelector<HTMLButtonElement>('.talent-up:not(:disabled)') ?? close).focus();
}

function bookModal(): void {
  const daoRows = ['dao_gather', 'dao_crit', 'dao_resonance', 'dao_chain', 'dao_jump', 'dao_reverse', 'dao_burst', 'dao_sword']
    .map((id) => {
      const card = session.state.hand.find((c) => c.configId === id);
      return card ? `<div class="row"><b style="color:${CATEGORY_HEX[card.category]}">${card.name}</b><span>${card.description}</span></div>` : '';
    }).join('');
  const m = openModal(`<div class="ptitle" style="font-size:44px">斗法规则</div><div class="book">
    <h4>一场斗法</h4>每次点<b>周天</b>先扣真气（第 n 次耗气 = 本关基数 × n^1.6，天劫可改写）。一股灵气从<b>第一眼 · 入气</b>出发顺时针流转，
    沿途被道韵灵印改变气势，走满一圈会自动升入外环；遇<b>释放</b>道韵出手：产气 = 基础气 × 倍率 × 释放系数。
    单次产气 ≥ 敌人<b>护体魔光</b>即斩敌晋升，获得道韵灵印战利品；否则敌人反击。真气付不起下一次运转即<b>身死道消</b>。
    <h4>境界与外环</h4>炼气 → 筑基 → 金丹 → 元婴 → 化神，每个大境界 3 战。大境界突破解锁新的一环，并可让一件灵宝认主。每个巅峰之战会降下天劫。
    <h4>布阵代价</h4>空眼凝入耗 1 枚；覆盖已有道韵需再炼化 1 枚作引；散去、移位也要炼化 1 枚。
    <h4>炼化</h4>3 枚同名同阶道韵可三合一升阶；2 枚同名同阶加 1 枚任意道韵作引也可催化精炼。
    <h4>连携</h4>增幅接增幅：倍率 +0.3；传导接传导：步数 +1；增幅直入释放：释放系数 +0.2；同一环全是同类道韵时触发共鸣 ×1.25。
    ${daoRows ? `<h4>玉匣所蕴道韵</h4>${daoRows}` : ''}
    </div><button type="button" class="bigbtn" id="book-close">合上</button>`);
  const close = m.querySelector<HTMLButtonElement>('#book-close')!;
  close.onclick = closeModal;
  close.focus();
}

function fuseModal(): void {
  const options = session.fusionOptions();
  if (!options.length) return;
  const m = openModal(`<div class="ptitle" style="font-size:44px">炼 化</div><div class="psub">同名同阶三合一；两枚时再炼化一枚最低阶道韵作引火</div><div class="fuse-list"></div>
    <button type="button" class="linkbtn" id="fuse-close">收起丹炉</button>`);
  const list = m.querySelector('.fuse-list')!;
  options.forEach((opt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fuse-row';
    const cost = opt.mode === 'fuse' ? `3 × ${opt.name} ${ROMAN[opt.level]}` : `2 × ${opt.name} ${ROMAN[opt.level]} + 引火 ${opt.catalyst?.name ?? ''} ${ROMAN[opt.catalyst?.level ?? 0] ?? ''}`;
    b.innerHTML = `<span class="mode">${opt.mode === 'fuse' ? '三合一' : '催化精炼'}</span><span>${cost}</span><span class="arrow">→</span><b>${opt.name} ${ROMAN[opt.level + 1]}</b>`;
    b.onclick = () => {
      const out = session.applyFusion(opt);
      closeModal();
      if (out.success) {
        sfx.win();
        backdrop.pulse(0.6);
        scene.splash('炼', { x: 800, y: 600, size: 150, dur: 1.2, tone: 'teal' });
      }
      toast(out.message, 3200);
      renderAll();
    };
    list.append(b);
  });
  m.querySelector<HTMLButtonElement>('#fuse-close')!.onclick = closeModal;
  list.querySelector<HTMLButtonElement>('button')?.focus();
}

// ------------------------------------------------------------ 斗法回合

const pause = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));

function resetCalculator(threshold: number): void {
  calcBaseEl.textContent = String(BOARD.initialBaseQi);
  calcMultEl.textContent = BOARD.initialMultiplier.toFixed(1);
  calcTotalEl.textContent = `产气 0 / ${formatQi(threshold)}`;
  tallyEl.classList.remove('burning');
  tallyEl.classList.add('on');
}

async function playTurn(turn: BattleTurn): Promise<void> {
  const { result, timeline, stage } = turn;
  if (result.isGameOver) {
    await scene.heroDeath();
    endModal(false);
    return;
  }
  if (turn.rebirthTriggered) toast('<b>天道生机</b> · 逆天改命，免死一次并注入 30 真气', 3600);
  const hand = scene.heroHand();
  if (result.charged > 0) scene.floatText(hand.x - 40, hand.y - 30, `−${formatQi(result.charged)} 真气`, '#9fffe8', 26, 1.4);

  resetCalculator(stage.threshold);
  shownDamage = 0;
  btnSkip.hidden = false;
  backdrop.setEnergy(0.75);

  await scene.play(timeline, {
    threshold: stage.threshold,
    onEnergy: (lvl) => {
      if (lvl > 0.8) backdrop.pulse(0.35);
      else backdrop.setEnergy(lvl);
    },
    onBeat: (beat, power) => {
      const nextBase = formatQi(power.baseQi);
      const nextMult = power.multiplier.toFixed(power.multiplier % 1 === 0 ? 1 : 2);
      if (calcBaseEl.textContent !== nextBase) {
        calcBaseEl.textContent = nextBase;
        popBounce(calcBaseEl.parentElement);
      }
      if (calcMultEl.textContent !== nextMult || beat.kind === 'crit' || beat.kind === 'synergy') {
        calcMultEl.textContent = nextMult;
        popBounce(calcMultEl.parentElement);
      }
      if (beat.kind === 'release') {
        popBounce(calcTotalEl);
      }
    },
    onHit: (total) => {
      shownDamage = total;
      calcTotalEl.textContent = `产气 ${formatQi(total)} / ${formatQi(stage.threshold)}`;
      popBounce(calcTotalEl);
      if (total >= stage.threshold) tallyEl.classList.add('burning');
      $('foe-fill').style.width = `${Math.max(0, (1 - total / Math.max(1, stage.threshold)) * 100)}%`;
    },
  });

  backdrop.setEnergy(0.08);
  btnSkip.hidden = true;
  setTimeout(() => {
    tallyEl.classList.remove('on');
    tallyEl.classList.remove('burning');
  }, 1050);

  const gain = result.simulation.turnQiGenerated;
  if (gain > 0) scene.floatText(hand.x + 70, hand.y - 110, `+${formatQi(gain)} 真气`, '#9fffe8', 30, 1.6);
  if (hudOverride) hudOverride.qi = session.state.currentQi;
  renderHud();

  if (result.cleared) {
    setHint(`破障斩敌！单次产气 <b>${formatQi(gain)}</b> ≥ 护体魔光 ${formatQi(stage.threshold)}`);
    backdrop.pulse(0.9);
    await scene.foeDefeated();
    if (result.isVictory) {
      await scene.ascension();
      endModal(true);
      return;
    }
    if (result.newRealmUnlocked) {
      renderSlots();
      scene.setBackground(session.state.realm);
      backdrop.setTheme(session.state.realm, session.state.activeTribulation?.id ?? null);
      await scene.breakthrough(session.state.realm - 1, REALM_NAMES[session.state.realm - 1] ?? '');
      toast(`阵盘第 ${session.state.realm} 环已解锁 · 灵气走满内环一周会自动升环`, 3400);
    }
    if (session.pendingRelics.length) await chooseRelic(session.pendingRelics);
    await showLoot(result.lootAwarded, result.context.activeTribulation?.modifiers.doubleLoot ?? false);
    handFrozen = false;
    hudOverride = null;
    shownDamage = 0;
    const trib = result.tribulationEncountered;
    if (trib) {
      backdrop.setTheme(session.state.realm, trib.id);
      scene.tribulationOmen(trib.id, trib.name);
      toast(`<b>${trib.name}</b> · ${trib.description}`, 5200);
    } else {
      backdrop.setTheme(session.state.realm, null);
    }
    scene.enemyEnter(session.foe);
    renderAll();
    setHint(`新敌现身：<b>${session.foe.name}</b> · 护体魔光 ${formatQi(session.state.stageThreshold)}。凝韵布阵，再运周天。`);
    return;
  }

  sfx.fail();
  toast(timeline.releaseCount > 0
    ? `护体魔光未破 · 本次产气 <b>${formatQi(gain)}</b> / 需单次 ≥ ${formatQi(stage.threshold)}`
    : '本次周天未能出手 · 阵中需要灵气走得到的<b>释放</b>道韵（灵爆术 / 万剑诀）', 3400);
  await pause(0.5);
  scene.counterAttack();
  shownDamage = 0;
  handFrozen = false;
  hudOverride = null;
  renderAll();
  if (turn.doomed) {
    await pause(1.2);
    const fatal = session.runTurn();
    if (fatal?.result.isGameOver) {
      await scene.heroDeath();
      endModal(false);
      return;
    }
  }
  setHint(`下次运转需耗 <b>${formatQi(session.nextCost)}</b> 真气（现有 ${formatQi(session.state.currentQi)}）。调整阵盘，再运周天。`);
}

async function onRun(): Promise<void> {
  sfx.unlock();
  sound.unlock();
  if (busy() || action.mode !== 'IDLE') return;
  closeMenu();
  selectedUid = null;
  renderAll();
  const before = liveHud();
  const turn = session.runTurn();
  if (!turn) return;
  hudOverride = before;
  handFrozen = true;
  playing = true;
  renderAll();
  setHint('周天运转中…… 观灵气沿道韵灵印流转倍增');
  try {
    await playTurn(turn);
  } finally {
    playing = false;
    handFrozen = false;
    hudOverride = null;
    btnSkip.hidden = true;
    backdrop.setEnergy(0);
    renderAll();
  }
}

function newGame(): void {
  scene.reset();
  closeModal();
  session = BattleSession.fromSavedProfile();
  action = { mode: 'IDLE' };
  selectedUid = null;
  playing = false;
  handFrozen = false;
  hudOverride = null;
  btnSkip.hidden = true;
  shownDamage = 0;
  peakQi = 100;
  backdrop.setTheme(session.state.realm, null);
  backdrop.setEnergy(0);
  renderAll();
  scene.enemyEnter(session.foe);
  setHint('点选下方玉匣中的<b>道韵灵印</b>，再点阵眼凝入。灵气从<b>第一眼 · 入气</b>出发顺时针流转，遇<b>释放</b>道韵化为攻势。');
}

// ------------------------------------------------------------ 事件

btnRun.onclick = () => void onRun();
btnFuse.onclick = () => {
  if (!busy()) fuseModal();
};
btnSkip.onclick = () => scene.skip();
$('btn-book').onclick = () => {
  if (!busy()) bookModal();
};
$('btn-talent').onclick = () => {
  if (!busy()) talentModal();
};
$('btn-reset').onclick = () => {
  if (!playing) newGame();
};
const btnMute = $('btn-mute');
const renderMute = (): void => {
  btnMute.textContent = sound.getMuted() ? '静' : '音';
  btnMute.setAttribute('aria-pressed', String(sound.getMuted()));
};
btnMute.onclick = () => {
  sound.toggleMute();
  renderMute();
  if (!sound.getMuted()) sfx.place();
};
stageEl.addEventListener('click', (e) => {
  if (e.target === canvas && action.mode === 'IDLE' && selectedUid) {
    selectedUid = null;
    renderAll();
    setHint('已收回所选道韵灵印。');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!menuEl.hidden) closeMenu();
  else if (action.mode !== 'IDLE' || selectedUid) cancelAction();
  else if (playing) scene.skip();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && playing) scene.skip();
});

renderMute();
scene.start();
newGame();
