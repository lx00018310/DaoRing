// ============================================================
// 斗法场景 · 敌人配置（数据来自 src/data/foes.json，与 stages.json 一一对应）
// ============================================================
import foesRaw from '../data/foes.json';

export interface FoeConfig {
  realm: number;
  subStage: number;
  name: string;
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
      hue: 0,
      scale: 1,
    }
  );
}

export function getAllFoes(): FoeConfig[] {
  return [...FOES];
}
