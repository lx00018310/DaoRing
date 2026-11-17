// ============================================================
// 本地持久化管理器 (Storage Manager)
// 支持浏览器 localStorage 与 Node 运行时内存 MemoryStore 双模平滑切换
// ============================================================
import type { GameState, KarmaProfile } from './types';

const KARMA_STORAGE_KEY = 'zhoutian_pojinglu_karma_profile_v1';
const SESSION_STORAGE_KEY = 'zhoutian_pojinglu_session_v1';

const memoryStore = new Map<string, string>();

function getItem(key: string): string | null {
  if (typeof localStorage !== 'undefined') {
    try {
      return localStorage.getItem(key);
    } catch {
      // 降级为 memoryStore
    }
  }
  return memoryStore.get(key) ?? null;
}

function setItem(key: string, val: string): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(key, val);
      return;
    } catch {
      // 降级为 memoryStore
    }
  }
  memoryStore.set(key, val);
}

function removeItem(key: string): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(key);
      return;
    } catch {
      // 降级为 memoryStore
    }
  }
  memoryStore.delete(key);
}

/** 初始空功德档案 */
export function createDefaultKarmaProfile(): KarmaProfile {
  return {
    totalKarma: 0,
    accumulatedKarma: 0,
    unlockedTalents: {},
    historyHighQi: 0,
    totalRuns: 0,
    victories: 0,
  };
}

export function loadKarmaProfile(): KarmaProfile {
  const raw = getItem(KARMA_STORAGE_KEY);
  if (!raw) return createDefaultKarmaProfile();
  try {
    return JSON.parse(raw) as KarmaProfile;
  } catch {
    return createDefaultKarmaProfile();
  }
}

export function saveKarmaProfile(profile: KarmaProfile): void {
  setItem(KARMA_STORAGE_KEY, JSON.stringify(profile));
}

export function saveGameSession(state: GameState): void {
  setItem(SESSION_STORAGE_KEY, JSON.stringify(state));
}

export function loadGameSession(): GameState | null {
  const raw = getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GameState;
  } catch {
    return null;
  }
}

export function clearGameSession(): void {
  removeItem(SESSION_STORAGE_KEY);
}
