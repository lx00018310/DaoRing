// ============================================================
// 斗法场景 · 道韵视觉映射（符字、简称、灵印贴图、类别配色）与数值格式化
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

export const DAO_ORB_FILES: Record<string, string> = {
  dao_chain: 'dao_chain.png',
  dao_jump: 'dao_jump.png',
  dao_reverse: 'dao_reverse.png',
  dao_gather: 'dao_gather.png',
  dao_crit: 'dao_crit.png',
  dao_resonance: 'dao_resonance.png',
  dao_burst: 'dao_burst.png',
  dao_sword: 'dao_sword.png',
};

export const CATEGORY_RGB: Record<DaoCategory, string> = {
  CONDUCT: '92,255,224',
  AMPLIFY: '255,212,112',
  RELEASE: '255,112,78',
};

export const CATEGORY_HEX: Record<DaoCategory, string> = {
  CONDUCT: '#7effe4',
  AMPLIFY: '#ffd878',
  RELEASE: '#ff8a66',
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

export function orbArtPath(configId: string): string {
  const file = DAO_ORB_FILES[configId] ?? 'dao_gather.png';
  return `assets/daos/${file}`;
}

/** 大数值按中文习惯缩写：12,345 → 1.2万，3.2亿 */
export function formatQi(value: number): string {
  const n = Math.floor(value);
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(n >= 1e9 ? 0 : 1)}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(n >= 1e5 ? 0 : 1)}万`;
  return String(n);
}
