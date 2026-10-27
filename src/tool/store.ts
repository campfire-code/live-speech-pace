// 设置的保存：放在本机设置文件 settings.json（键 custom.c33）。不保存任何音频，也不联网。
import { settingsStore } from '../kit/platform';
import { SENSITIVITY, type SensitivityKey } from './core';

export type Voice = 'double' | 'single' | 'triple';

export interface Settings {
  threshold: number;
  /** 持续超速多少秒才报警 */
  holdSec: number;
  /** 冷静期（秒） */
  cooldownSec: number;
  sound: boolean;
  voice: Voice;
  volume: number;
  /** 超速时画面闪红 */
  flash: boolean;
  sensitivity: SensitivityKey;
  /** 计算语速的窗口（秒） */
  windowSec: number;
}

export const DEFAULTS: Settings = {
  threshold: 300,
  holdSec: 2,
  cooldownSec: 30,
  sound: true,
  voice: 'double',
  volume: 0.6,
  flash: true,
  sensitivity: 'mid',
  windowSec: 3,
};

const KEY = 'custom.c33';
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** 容错解析：缺的、类型不对的、超范围的都回到合理值 */
export function parseSettings(v: unknown): Settings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    threshold: Math.round(num(o.threshold, 100, 800, DEFAULTS.threshold)),
    holdSec: num(o.holdSec, 0, 30, DEFAULTS.holdSec),
    cooldownSec: num(o.cooldownSec, 3, 600, DEFAULTS.cooldownSec),
    sound: typeof o.sound === 'boolean' ? o.sound : DEFAULTS.sound,
    voice: o.voice === 'single' || o.voice === 'triple' || o.voice === 'double' ? o.voice : DEFAULTS.voice,
    volume: num(o.volume, 0.05, 1, DEFAULTS.volume),
    flash: typeof o.flash === 'boolean' ? o.flash : DEFAULTS.flash,
    sensitivity: typeof o.sensitivity === 'string' && o.sensitivity in SENSITIVITY ? (o.sensitivity as SensitivityKey) : DEFAULTS.sensitivity,
    windowSec: num(o.windowSec, 2, 10, DEFAULTS.windowSec),
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    return parseSettings(await (await settingsStore()).get(KEY));
  } catch {
    return DEFAULTS;
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  try {
    await (await settingsStore()).set(KEY, s);
  } catch {
    // 预览页里没有本机设置文件，忽略
  }
}
