// ============================================================
// 配置加载器 —— 全局唯一数据入口
// 架构原则：数据与逻辑解耦，所有数值来自 JSON，引擎零硬编码。
// ============================================================
import boardRaw from './data/board.json';
import daosRaw from './data/daos.json';
import karmaTalentsRaw from './data/karma_talents.json';
import relicsRaw from './data/relics.json';
import stagesRaw from './data/stages.json';
import tribulationsRaw from './data/tribulations.json';
import type {
  BoardConfig,
  DaoConfig,
  DaoLevelConfig,
  DaoLevelParams,
  DaoRhyme,
  KarmaTalentConfig,
  RelicConfig,
  StageConfig,
  TribulationConfig,
} from './types';

export const BOARD: BoardConfig = boardRaw as BoardConfig;

const DAO_MAP = new Map<string, DaoConfig>(
  Object.values(daosRaw as Record<string, DaoConfig>).map((cfg) => [cfg.configId, cfg]),
);

const STAGE_MAP = new Map<string, StageConfig>(
  (stagesRaw as StageConfig[]).map((s) => [`${s.realm}-${s.subStage}`, s]),
);

const RELIC_MAP = new Map<string, RelicConfig>(
  (relicsRaw as RelicConfig[]).map((r) => [r.id, r]),
);

const TRIBULATION_MAP = new Map<string, TribulationConfig>(
  (tribulationsRaw as TribulationConfig[]).map((t) => [t.id, t]),
);

const TALENT_MAP = new Map<string, KarmaTalentConfig>(
  (karmaTalentsRaw as KarmaTalentConfig[]).map((t) => [t.id, t]),
);

export const ALL_DAO_IDS: string[] = Array.from(DAO_MAP.keys());
export const ALL_RELIC_IDS: string[] = Array.from(RELIC_MAP.keys());
export const ALL_TRIBULATION_IDS: string[] = Array.from(TRIBULATION_MAP.keys());
export const ALL_TALENT_IDS: string[] = Array.from(TALENT_MAP.keys());

/** 取道韵静态配置 */
export function getDaoConfig(configId: string): DaoConfig {
  const cfg = DAO_MAP.get(configId);
  if (!cfg) throw new Error(`[config] 未知道韵配置: ${configId}`);
  return cfg;
}

/** 取某道韵某等级的参数（level 1..5） */
export function getLevelParams(configId: string, level: number): DaoLevelParams {
  const cfg = getDaoConfig(configId);
  const lc: DaoLevelConfig | undefined = cfg.levels[level - 1];
  if (!lc || lc.level !== level) {
    throw new Error(`[config] ${configId} 缺少 LV${level} 配置`);
  }
  return lc.params;
}

/** 取某道韵某等级的描述 */
export function getLevelDescription(configId: string, level: number): string {
  const cfg = getDaoConfig(configId);
  const lc: DaoLevelConfig | undefined = cfg.levels[level - 1];
  if (!lc || lc.level !== level) {
    throw new Error(`[config] ${configId} 缺少 LV${level} 描述`);
  }
  return lc.description;
}

/** 取关卡配置；不存在时抛错 */
export function getStageConfig(realm: number, subStage: number): StageConfig {
  const cfg = STAGE_MAP.get(`${realm}-${subStage}`);
  if (!cfg) throw new Error(`[config] 未配置关卡 ${realm}-${subStage}`);
  return cfg;
}

/** 全部关卡 */
export function getAllStages(): StageConfig[] {
  return Array.from(STAGE_MAP.values()).sort(
    (a, b) => a.realm - b.realm || a.subStage - b.subStage,
  );
}

/** 取先天灵宝配置 */
export function getRelicConfig(relicId: string): RelicConfig {
  const cfg = RELIC_MAP.get(relicId);
  if (!cfg) throw new Error(`[config] 未知先天灵宝配置: ${relicId}`);
  return cfg;
}

/** 全部灵宝列表 */
export function getAllRelics(): RelicConfig[] {
  return Array.from(RELIC_MAP.values());
}

/** 取天劫异象配置 */
export function getTribulationConfig(tribId: string): TribulationConfig {
  const cfg = TRIBULATION_MAP.get(tribId);
  if (!cfg) throw new Error(`[config] 未知天劫异象配置: ${tribId}`);
  return cfg;
}

/** 全部天劫列表 */
export function getAllTribulations(): TribulationConfig[] {
  return Array.from(TRIBULATION_MAP.values());
}

/** 取局外天赋配置 */
export function getTalentConfig(talentId: string): KarmaTalentConfig {
  const cfg = TALENT_MAP.get(talentId);
  if (!cfg) throw new Error(`[config] 未知天赋配置: ${talentId}`);
  return cfg;
}

/** 全部局外天赋列表 */
export function getAllTalents(): KarmaTalentConfig[] {
  return Array.from(TALENT_MAP.values());
}

/** 由配置实例化一张道韵卡 */
export function createDao(configId: string, level: number, uid: string): DaoRhyme {
  const cfg = getDaoConfig(configId);
  return {
    uid,
    configId: cfg.configId,
    name: cfg.name,
    category: cfg.category,
    level,
    description: getLevelDescription(configId, level),
  };
}

/** 耗气公式：BaseCost(n) = BaseCost_stage × n^exponent，四舍五入 */
export function calcQiCost(baseCost: number, n: number, exponent: number = BOARD.qiCostExponent): number {
  return Math.round(baseCost * Math.pow(n, exponent));
}
