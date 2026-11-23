// ============================================================
// 斗法场景 · 阵盘几何
// 舞台坐标固定为 1600×900，按窗口等比缩放。五层同心环按透视椭圆排布，
// 参数经过搜索：五环全开（40 个阵眼）时任意两个阵眼的点击区域互不重叠，
// 且不压住左侧主角与底部手牌区。
// ============================================================
import { BOARD } from '../config';

export const STAGE_W = 1600;
export const STAGE_H = 900;

export interface Point {
  x: number;
  y: number;
}

export interface SlotRef {
  ring: number;
  slot: number;
}

export const LAYOUT = {
  cx: 840,
  cy: 530,
  baseRadius: 100,
  ringGap: 85,
  ratio: 0.37,
} as const;

/** 环的横向半径。reveal 为外环展开进度（0 收拢、1 完全展开）。 */
export function ringRadius(ringIdx: number, reveal = 1): number {
  const full = LAYOUT.baseRadius + LAYOUT.ringGap * ringIdx;
  return full * (0.72 + 0.28 * reveal);
}

/**
 * 阵眼角度：Slot 0 在正左方，索引递增为屏幕上的顺时针方向。
 * 与引擎升环映射 floor(slot × 外环槽数 / 内环槽数) 一致：同一比例位置落在同一方向。
 */
export function slotAngle(ringIdx: number, slotIdx: number, ringSlots: readonly number[] = BOARD.ringSlots): number {
  return Math.PI + (slotIdx * Math.PI * 2) / ringSlots[ringIdx];
}

export function pointAt(angle: number, radius: number): Point {
  return {
    x: LAYOUT.cx + radius * Math.cos(angle),
    y: LAYOUT.cy + radius * LAYOUT.ratio * Math.sin(angle),
  };
}

export function slotPoint(
  ringIdx: number,
  slotIdx: number,
  reveal = 1,
  ringSlots: readonly number[] = BOARD.ringSlots,
): Point {
  return pointAt(slotAngle(ringIdx, slotIdx, ringSlots), ringRadius(ringIdx, reveal));
}

/** 阵眼点击区域尺寸（舞台坐标） */
export const SLOT_HIT = { w: 64, h: 40 } as const;
