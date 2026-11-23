// ============================================================
// 斗法场景 · 敌人配置（数据来自 src/data/foes.json，与 stages.json 一一对应）
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
