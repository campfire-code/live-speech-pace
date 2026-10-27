import { describe, expect, it } from 'vitest';
import {
  AlarmGate, Biquad, PaceEngine, PeakTracker, DEFAULT_DETECTOR, analyzeSignal, chartPoints, formatDuration, historyStats, pushHistory, zoneOf,
  type AlarmConfig,
} from './core';

const SR = 16000;

/** 确定性伪随机，保证测试每次一样 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/** 合成「说话」：每秒 perSec 个字，每个字是一段带共振峰的短音（余弦包络），字间有凹陷；另加底噪 */
function synthSpeech(seconds: number, perSec: number, opts: { amp?: number; noise?: number; f0?: number } = {}): Float32Array {
  const { amp = 0.3, noise = 0.003, f0 = 180 } = opts;
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const r = rng(7);
  const period = SR / perSec;
  for (let i = 0; i < n; i++) {
    const phase = (i % period) / period; // 0..1
    // 字的能量包络：占 70% 的时长，余弦抬升，其余为凹陷
    const env = phase < 0.7 ? Math.sin((phase / 0.7) * Math.PI) ** 2 : 0.02;
    const t = i / SR;
    const voiced = Math.sin(2 * Math.PI * f0 * t) + 0.6 * Math.sin(2 * Math.PI * f0 * 5 * t) + 0.4 * Math.sin(2 * Math.PI * f0 * 9 * t);
    out[i] = amp * env * voiced + noise * r();
  }
  return out;
}

const lastCpm = (s: Float32Array) => analyzeSignal(s, SR).at(-1)!.cpm;

describe('滤波器', () => {
  const rms = (x: number[]) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  const tone = (f: number) => {
    const hp = new Biquad('high', 300, SR);
    const lp = new Biquad('low', 3400, SR);
    const out: number[] = [];
    for (let i = 0; i < SR; i++) out.push(lp.process(hp.process(Math.sin((2 * Math.PI * f * i) / SR))));
    return rms(out.slice(SR / 2));
  };
  it('人声频段通过，低频和高频被压低', () => {
    expect(tone(1000)).toBeGreaterThan(0.6);
    expect(tone(50)).toBeLessThan(0.05);
    expect(tone(7000)).toBeLessThan(0.15);
  });
});

describe('语速检测（合成音频）', () => {
  it('每秒 4 字约 240 字/分钟', () => {
    const v = lastCpm(synthSpeech(12, 4));
    expect(v).toBeGreaterThan(210);
    expect(v).toBeLessThan(270);
  });
  it('每秒 5 字约 300 字/分钟，每秒 6 字约 360 字/分钟，且越快读数越大', () => {
    const a = lastCpm(synthSpeech(12, 4));
    const b = lastCpm(synthSpeech(12, 5));
    const c = lastCpm(synthSpeech(12, 6));
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(Math.abs(b - 300)).toBeLessThan(40);
    expect(Math.abs(c - 360)).toBeLessThan(50);
  });
  it('音量大小不影响字数（音量差 5 倍结果相近）', () => {
    const loud = lastCpm(synthSpeech(12, 5, { amp: 0.5 }));
    const soft = lastCpm(synthSpeech(12, 5, { amp: 0.1 }));
    expect(Math.abs(loud - soft)).toBeLessThan(40);
  });
  it('只有底噪时读数为 0，并判为静默', () => {
    const snaps = analyzeSignal(synthSpeech(10, 5, { amp: 0 }), SR);
    expect(snaps.at(-1)!.cpm).toBe(0);
    expect(snaps.at(-1)!.silent).toBe(true);
    expect(snaps.at(-1)!.totalCount).toBeLessThan(5);
  });
  it('持续低频嗡嗡声（50Hz 工频）不会被当成字', () => {
    const n = SR * 8;
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 50 * i) / SR);
    expect(analyzeSignal(s, SR).at(-1)!.cpm).toBe(0);
  });
  it('说话后停顿，超过静默时间读数归零', () => {
    const speech = synthSpeech(6, 5);
    const quiet = new Float32Array(SR * 7);
    const all = new Float32Array(speech.length + quiet.length);
    all.set(speech);
    all.set(quiet, speech.length);
    const snaps = analyzeSignal(all, SR);
    expect(snaps[10].cpm).toBeGreaterThan(200);
    expect(snaps.at(-1)!.cpm).toBe(0);
  });
  it('开头窗口未满时不会把读数放大', () => {
    const snaps = analyzeSignal(synthSpeech(3, 5), SR, {}, 250);
    // 第 1 秒内的读数不应超过稳定读数的 1.5 倍
    expect(snaps[3].cpm).toBeLessThan(450);
  });
  it('调高灵敏度（降低峰谷比）能数到更多弱起伏，调低则更少', () => {
    const s = synthSpeech(12, 5, { amp: 0.05, noise: 0.01 });
    const hi = analyzeSignal(s, SR, { syllableRatio: 1.15, peakAbsRatio: 1.2 }).at(-1)!.totalCount;
    const lo = analyzeSignal(s, SR, { syllableRatio: 1.6, peakAbsRatio: 2.2 }).at(-1)!.totalCount;
    expect(hi).toBeGreaterThanOrEqual(lo);
  });
  it('分块喂入与一次喂入结果一致', () => {
    const s = synthSpeech(8, 5);
    const a = new PaceEngine(SR);
    a.push(s);
    const b = new PaceEngine(SR);
    for (let i = 0; i < s.length; i += 128) b.push(s.subarray(i, i + 128));
    expect(b.snapshot().totalCount).toBe(a.snapshot().totalCount);
  });
});

describe('PeakTracker', () => {
  it('两个峰之间间隔小于最小字间隔只算一个', () => {
    const t = new PeakTracker({ ...DEFAULT_DETECTOR, smoothAlpha: 1, minSyllableGapMs: 100 });
    const seq = [0.01, 0.1, 0.01, 0.1, 0.01, 0.01];
    seq.forEach((v, i) => t.step(v, i * 20));
    expect(t.totalCount).toBe(1);
  });
});

describe('告警判定', () => {
  const cfg: AlarmConfig = { threshold: 300, holdMs: 2000, cooldownMs: 30000 };
  it('瞬间超速不报警，持续满 2 秒才报警', () => {
    const g = new AlarmGate();
    expect(g.update(320, 0, cfg)).toBe(false);
    expect(g.update(320, 1900, cfg)).toBe(false);
    expect(g.update(320, 2000, cfg)).toBe(true);
  });
  it('中途回落会重新计时', () => {
    const g = new AlarmGate();
    g.update(320, 0, cfg);
    g.update(250, 1500, cfg);
    expect(g.update(320, 2000, cfg)).toBe(false);
    expect(g.update(320, 4000, cfg)).toBe(true);
  });
  it('冷静期内不重复报警，过后再响', () => {
    const g = new AlarmGate();
    g.update(330, 0, cfg);
    expect(g.update(330, 2000, cfg)).toBe(true);
    expect(g.update(330, 20000, cfg)).toBe(false);
    expect(g.cooldownLeft(20000, cfg)).toBe(12000);
    expect(g.update(330, 32000, cfg)).toBe(true);
  });
  it('语速为 0（静默）不算超速；阈值正好等于语速算超速', () => {
    const g = new AlarmGate();
    g.update(0, 0, { ...cfg, threshold: 0 });
    expect(g.over).toBe(false);
    g.update(300, 0, cfg);
    expect(g.over).toBe(true);
  });
  it('分区：90% 以上为接近上限', () => {
    expect(zoneOf(0, 300)).toBe('idle');
    expect(zoneOf(200, 300)).toBe('ok');
    expect(zoneOf(270, 300)).toBe('warn');
    expect(zoneOf(300, 300)).toBe('over');
  });
});

describe('历史曲线', () => {
  it('只保留最近一段时间', () => {
    let h = pushHistory([], { t: 0, cpm: 100 }, 5000);
    h = pushHistory(h, { t: 3000, cpm: 200 }, 5000);
    h = pushHistory(h, { t: 6000, cpm: 300 }, 5000);
    expect(h.map((p) => p.t)).toEqual([3000, 6000]);
  });
  it('统计忽略静默点', () => {
    const h = [0, 240, 280, 320, 0].map((cpm, i) => ({ t: i * 1000, cpm }));
    expect(historyStats(h, 300)).toEqual({ avg: 280, max: 320, overSeconds: 1, samples: 5 });
  });
  it('折线坐标：最新点在右端，超过上限的点贴顶', () => {
    const pts = chartPoints([{ t: 0, cpm: 0 }, { t: 10000, cpm: 999 }], 100, 50, 10000, 500, 10000).split(' ');
    expect(pts).toEqual(['0.0,50.0', '100.0,0.0']);
  });
  it('时长格式', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(-3)).toBe('0:00');
  });
});

import { DEFAULTS, parseSettings } from './store';
describe('设置解析', () => {
  it('空值、坏值回到默认，超范围的夹到边界', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULTS);
    expect(parseSettings({ threshold: 'abc', sound: 1, voice: 'x', sensitivity: 'zzz' })).toEqual(DEFAULTS);
    const s = parseSettings({ threshold: 99999, cooldownSec: 0, volume: 5, windowSec: 1 });
    expect(s.threshold).toBe(800);
    expect(s.cooldownSec).toBe(3);
    expect(s.volume).toBe(1);
    expect(s.windowSec).toBe(2);
  });
  it('合法值原样保留', () => {
    const s = { ...DEFAULTS, threshold: 350, sensitivity: 'high' as const, voice: 'triple' as const };
    expect(parseSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});
