// ============================================================
// 斗法场景 · 道韵视觉映射（符字、简称、类别配色）与数值格式化
// ============================================================
import type { DaoCategory, DaoRhyme } from '../types';

const GLYPH: Record<string, string> = {
  dao_chain: '分',
  dao_jump: '升',
  dao_reverse: '逆',
  dao_gather: '聚',
  dao_crit: '锋',
  dao_resonance: '周',
  dao_burst: '爆',
  dao_sword: '剑',
};

const SHORT: Record<string, string> = {
  dao_chain: '分光',
  dao_jump: '升维',
  dao_reverse: '逆流',
  dao_gather: '聚灵',
  dao_crit: '锋芒',
  dao_resonance: '周天',
  dao_burst: '灵爆',
  dao_sword: '万剑',
};

export const CATEGORY_RGB: Record<DaoCategory, string> = {
  CONDUCT: '127,255,224',
  AMPLIFY: '255,210,122',
  RELEASE: '255,120,88',
};

export const CATEGORY_HEX: Record<DaoCategory, string> = {
  CONDUCT: '#8fffe6',
  AMPLIFY: '#ffd98a',
  RELEASE: '#ff9a78',
};

export const CATEGORY_LABEL: Record<DaoCategory, string> = {
  CONDUCT: '传导',
  AMPLIFY: '增幅',
  RELEASE: '释放',
};

export const ROMAN = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ'];

type DaoLike = Pick<DaoRhyme, 'configId' | 'name'>;

export function glyphOf(card: DaoLike): string {
  return GLYPH[card.configId] ?? card.name.charAt(0);
}

export function shortName(card: DaoLike): string {
  return SHORT[card.configId] ?? card.name.slice(0, 2);
}

/** 大数值按中文习惯缩写：12,345 → 1.2万，3.2亿 */
export function formatQi(value: number): string {
  const n = Math.floor(value);
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(n >= 1e9 ? 0 : 1)}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(n >= 1e5 ? 0 : 1)}万`;
  return String(n);
}
