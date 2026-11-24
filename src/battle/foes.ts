// ============================================================
// 斗法场景 · 敌人配置（远景立绘 + 21:9 漫画发招特写配置）
// 数据来自 src/data/foes.json，与 stages.json 一一对应
// ============================================================
import foesRaw from '../data/foes.json';

/** 立绘：每个大境界一张，同境界内小怪换色复用 */
export type FoeArt = 'elder' | 'corpse' | 'lord' | 'bone' | 'god';

export const FOE_ART_FILES: Record<FoeArt, string> = {
  elder: 'foe_demon_elder.webp',
  corpse: 'foe_corpse_master.webp',
  lord: 'foe_demon_lord.webp',
  bone: 'foe_bone_ancestor.webp',
  god: 'foe_demon_god.webp',
};

/** 对手发招时切入的 21:9 漫画镜头拉近特写图 */
export const FOE_CUTIN_FILES: Record<FoeArt, string> = {
  elder: 'cutin_demon_elder.webp',
  corpse: 'cutin_corpse_master.webp',
  lord: 'cutin_demon_lord.webp',
  bone: 'cutin_bone_ancestor.webp',
  god: 'cutin_demon_god.webp',
};

export interface FoeCutInStyle {
  skill: string;
  rgb: string;
  accent: string;
}

export const FOE_CUTIN_STYLE: Record<FoeArt, FoeCutInStyle> = {
  elder: { skill: '血魂魔雷', rgb: '255,64,52', accent: '#ff5244' },
  corpse: { skill: '阴尸噬魂', rgb: '64,255,152', accent: '#4aff9c' },
  lord: { skill: '赤魇魔焰', rgb: '255,112,48', accent: '#ff7c3a' },
  bone: { skill: '万骨冥火', rgb: '192,102,255', accent: '#c972ff' },
  god: { skill: '域外天劫', rgb: '255,212,84', accent: '#ffd85c' },
};

export interface FoeConfig {
  realm: number;
  subStage: number;
  name: string;
  art: FoeArt;
  /** 立绘色相偏移（度），同一张魔修立绘按关卡换色复用 */
  hue: number;
  /** 立绘缩放，越往后越高大 */
  scale: number;
}

const FOES = foesRaw as FoeConfig[];

export function getFoeConfig(realm: number, subStage: number): FoeConfig {
  return (
    FOES.find((foe) => foe.realm === realm && foe.subStage === subStage) ?? {
      realm,
      subStage,
      name: '无名魔修',
      art: 'elder',
      hue: 0,
      scale: 1,
    }
  );
}

export function getAllFoes(): FoeConfig[] {
  return [...FOES];
}
