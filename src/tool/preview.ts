// 截图与浏览器预览用的示例状态：不需要真实麦克风。
// 画面：正在测速、显示 260 字/分钟、阈值 300、刚触发过一次报警（5 分钟窗口里有一段冲过阈值的曲线）。
import type { HistoryPoint } from './core';
import { DEFAULTS, type Settings } from './store';

export interface AlarmLog { at: number; cpm: number }

/** 固定的示例时刻（本地时间显示），保证每次截图一致 */
export const DEMO_NOW = new Date(2026, 9, 24, 20, 32, 8).getTime();

export function demoHistory(): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  for (let i = 0; i <= 270; i++) {
    const t = DEMO_NOW - (270 - i) * 1000;
    let v = 255 + 22 * Math.sin(i / 11) + 9 * Math.sin(i / 3.7);
    if (i > 118 && i < 150) v += 78 * Math.sin(((i - 118) / 32) * Math.PI); // 加速冲过阈值
    if (i > 205 && i < 214) v = 0; // 一次换气停顿
    out.push({ t, cpm: Math.max(0, Math.round(v)) });
  }
  out[out.length - 1].cpm = 260;
  return out;
}

export const demo = {
  settings: { ...DEFAULTS, threshold: 300 } as Settings,
  cpm: 260,
  level: 0.58,
  history: demoHistory,
  alarms: [{ at: DEMO_NOW - 128_000, cpm: 328 }] as AlarmLog[],
  elapsedSec: 272,
  now: DEMO_NOW,
};

export const isPreview = typeof location !== 'undefined' && /preview\.html$/.test(location.pathname);
