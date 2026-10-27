// 纯函数与纯状态机：不依赖麦克风、浏览器音频接口和界面，便于用合成音频做单元测试。
// 检测思路移植自参考仓库（中文一个字约一个音节，数短时能量包络的峰），并改成按采样点时钟推进，
// 这样测试里喂一段合成音频就能得到确定的结果。

export interface DetectorOptions {
  /** 字间峰谷比：峰值 / 前一个谷 ≥ 此值才算一个字（核心灵敏度） */
  syllableRatio: number;
  /** 峰值要达到噪声基线的多少倍 */
  peakAbsRatio: number;
  /** 两个字之间最短间隔（毫秒） */
  minSyllableGapMs: number;
  /** 包络平滑系数 0~1 */
  smoothAlpha: number;
  /** 计算语速的滚动窗口（毫秒） */
  windowMs: number;
  /** 连续这么久没有字就判为静默，语速归零（毫秒） */
  silenceResetMs: number;
}

export const DEFAULT_DETECTOR: DetectorOptions = {
  syllableRatio: 1.35,
  peakAbsRatio: 1.4,
  minSyllableGapMs: 60,
  smoothAlpha: 0.5,
  windowMs: 3000,
  silenceResetMs: 5000,
};

/** 灵敏度三档：只调峰谷比与噪声倍数，其余保持默认 */
export const SENSITIVITY = {
  low: { label: '低（环境嘈杂）', syllableRatio: 1.6, peakAbsRatio: 2.2 },
  mid: { label: '中（默认）', syllableRatio: 1.35, peakAbsRatio: 1.4 },
  high: { label: '高（声音小或安静）', syllableRatio: 1.15, peakAbsRatio: 1.2 },
} as const;
export type SensitivityKey = keyof typeof SENSITIVITY;

// ---------------- 带通滤波（300～3400 Hz，人声主要能量） ----------------

/** 二阶滤波器（RBJ 公式），type 为 high 或 low */
export class Biquad {
  private b0 = 0; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(type: 'high' | 'low', freq: number, sampleRate: number, q = Math.SQRT1_2) {
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    if (type === 'low') {
      this.b0 = (1 - cos) / 2 / a0; this.b1 = (1 - cos) / a0; this.b2 = this.b0;
    } else {
      this.b0 = (1 + cos) / 2 / a0; this.b1 = -(1 + cos) / a0; this.b2 = this.b0;
    }
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// ---------------- 包络峰值跟踪（音节计数） ----------------

type Phase = 'searching' | 'rising' | 'falling';

export class PeakTracker {
  readonly timestamps: number[] = [];
  totalCount = 0;
  noiseFloor = 0.005;
  level = 0;
  lastPeak = 0;
  lastRatio = 0;
  private prevEnv = 0;
  private valley = Infinity;
  private phase: Phase = 'searching';
  private lastPeakTime = -Infinity;
  constructor(public opts: DetectorOptions) {}

  /** 喂入一帧的短时 RMS；nowMs 是时间（毫秒） */
  step(rms: number, nowMs: number): void {
    const o = this.opts;
    const env = this.prevEnv * (1 - o.smoothAlpha) + rms * o.smoothAlpha;
    this.level = Math.min(1, env * 5);
    if (env < this.noiseFloor * 1.5) this.noiseFloor = this.noiseFloor * 0.99 + env * 0.01;
    if (this.noiseFloor < 0.003) this.noiseFloor = 0.003;
    const absThreshold = this.noiseFloor * o.peakAbsRatio;

    if (env > this.prevEnv) {
      if (this.phase !== 'rising') {
        this.valley = Math.min(this.valley === Infinity ? this.prevEnv : this.valley, this.prevEnv);
        this.phase = 'rising';
      }
    } else if (env < this.prevEnv) {
      if (this.phase === 'rising') {
        const peak = this.prevEnv;
        const valley = this.valley === Infinity ? this.noiseFloor : this.valley;
        this.lastPeak = peak;
        this.lastRatio = peak / Math.max(valley, 1e-6);
        if (peak >= absThreshold && peak >= valley * o.syllableRatio && nowMs - this.lastPeakTime > o.minSyllableGapMs) {
          this.timestamps.push(nowMs);
          this.lastPeakTime = nowMs;
          this.totalCount++;
        }
        this.phase = 'falling';
        this.valley = env;
      } else {
        this.valley = Math.min(this.valley, env);
      }
    }
    this.prevEnv = env;
  }

  /** 窗口内字数；顺便丢掉窗口外的旧时间戳 */
  windowCount(nowMs: number): number {
    const cutoff = nowMs - this.opts.windowMs;
    while (this.timestamps.length && this.timestamps[0] < cutoff) this.timestamps.shift();
    return this.timestamps.length;
  }
  lastSyllableAt(): number {
    return this.timestamps.length ? this.timestamps[this.timestamps.length - 1] : -Infinity;
  }
}

// ---------------- 引擎：原始采样 → 字/分钟 ----------------

export interface PaceSnapshot {
  /** 当前语速（字/分钟），静默时为 0 */
  cpm: number;
  windowCount: number;
  silent: boolean;
  /** 电平 0~1 */
  level: number;
  noiseFloor: number;
  totalCount: number;
  /** 已处理的音频时长（毫秒） */
  tMs: number;
}

/** 每 FRAME_MS 毫秒算一次 RMS，窗口长 1024 个采样点，和参考实现每帧取 1024 点一致 */
const FRAME_MS = 16;
const RMS_WINDOW = 1024;
/** 刚开始时窗口还没满，最少按这么久算，避免开头几个字被放大成虚高的语速 */
const MIN_RATE_SPAN_MS = 1500;

export class PaceEngine {
  private hp: Biquad;
  private lp: Biquad;
  private ring = new Float32Array(RMS_WINDOW);
  private ringPos = 0;
  private filled = 0;
  private sinceFrame = 0;
  private samples = 0;
  private hop: number;
  readonly tracker: PeakTracker;

  constructor(public readonly sampleRate: number, opts: Partial<DetectorOptions> = {}) {
    this.hp = new Biquad('high', 300, sampleRate);
    this.lp = new Biquad('low', 3400, sampleRate);
    this.hop = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
    this.tracker = new PeakTracker({ ...DEFAULT_DETECTOR, ...opts });
  }

  setOptions(opts: Partial<DetectorOptions>): void {
    this.tracker.opts = { ...this.tracker.opts, ...opts };
  }

  get nowMs(): number {
    return (this.samples / this.sampleRate) * 1000;
  }

  push(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) {
      const v = this.lp.process(this.hp.process(chunk[i]));
      this.ring[this.ringPos] = v;
      this.ringPos = (this.ringPos + 1) % RMS_WINDOW;
      if (this.filled < RMS_WINDOW) this.filled++;
      this.samples++;
      if (++this.sinceFrame >= this.hop) {
        this.sinceFrame = 0;
        let sum = 0;
        for (let k = 0; k < this.filled; k++) sum += this.ring[k] * this.ring[k];
        this.tracker.step(Math.sqrt(sum / this.filled), this.nowMs);
      }
    }
  }

  snapshot(): PaceSnapshot {
    const t = this.nowMs;
    const o = this.tracker.opts;
    const count = this.tracker.windowCount(t);
    const silent = count === 0 || t - this.tracker.lastSyllableAt() > o.silenceResetMs;
    const span = Math.min(o.windowMs, Math.max(MIN_RATE_SPAN_MS, t));
    return {
      cpm: silent ? 0 : Math.round((count / (span / 1000)) * 60),
      windowCount: count,
      silent,
      level: this.tracker.level,
      noiseFloor: this.tracker.noiseFloor,
      totalCount: this.tracker.totalCount,
      tMs: t,
    };
  }
}

/** 离线分析一整段音频，按 stepMs 间隔取语速快照；测试和校准用 */
export function analyzeSignal(samples: Float32Array, sampleRate: number, opts: Partial<DetectorOptions> = {}, stepMs = 500): PaceSnapshot[] {
  const eng = new PaceEngine(sampleRate, opts);
  const out: PaceSnapshot[] = [];
  const step = Math.round((sampleRate * stepMs) / 1000);
  for (let i = 0; i < samples.length; i += step) {
    eng.push(samples.subarray(i, Math.min(samples.length, i + step)));
    out.push(eng.snapshot());
  }
  return out;
}

// ---------------- 告警判定（持续超速 + 冷静期） ----------------

export interface AlarmConfig {
  /** 超速阈值（字/分钟） */
  threshold: number;
  /** 持续超速多久才报警（毫秒），过滤偶尔一两个快字 */
  holdMs: number;
  /** 两次报警之间的冷静期（毫秒） */
  cooldownMs: number;
}

export type Zone = 'idle' | 'ok' | 'warn' | 'over';

/** 90% 以上算「接近上限」 */
export function zoneOf(cpm: number, threshold: number): Zone {
  if (cpm <= 0) return 'idle';
  if (cpm >= threshold) return 'over';
  if (cpm >= threshold * 0.9) return 'warn';
  return 'ok';
}

export class AlarmGate {
  private overSince: number | null = null;
  private lastFire = -Infinity;
  /** 当前是否处于超速（用于画面闪烁） */
  over = false;

  /** 每次语速更新时调用；返回 true 表示这一刻应当响铃 */
  update(cpm: number, nowMs: number, cfg: AlarmConfig): boolean {
    this.over = cpm >= cfg.threshold && cpm > 0;
    if (!this.over) {
      this.overSince = null;
      return false;
    }
    if (this.overSince === null) this.overSince = nowMs;
    if (nowMs - this.overSince >= cfg.holdMs && nowMs - this.lastFire >= cfg.cooldownMs) {
      this.lastFire = nowMs;
      return true;
    }
    return false;
  }

  /** 冷静期还剩多少毫秒，0 表示可以再报警 */
  cooldownLeft(nowMs: number, cfg: AlarmConfig): number {
    return Math.max(0, cfg.cooldownMs - (nowMs - this.lastFire));
  }

  reset(): void {
    this.overSince = null;
    this.lastFire = -Infinity;
    this.over = false;
  }
}

// ---------------- 历史曲线 ----------------

export interface HistoryPoint { t: number; cpm: number }

/** 追加一个点并只保留最近 maxMs；返回新数组 */
export function pushHistory(h: HistoryPoint[], p: HistoryPoint, maxMs: number): HistoryPoint[] {
  const cutoff = p.t - maxMs;
  const out = h.filter((x) => x.t >= cutoff);
  out.push(p);
  return out;
}

export interface HistoryStats { avg: number; max: number; overSeconds: number; samples: number }

/** 统计：只算有声音的点（cpm>0）的平均与最大值，以及超速点数（每点按 stepSec 秒计） */
export function historyStats(h: HistoryPoint[], threshold: number, stepSec = 1): HistoryStats {
  const voiced = h.filter((p) => p.cpm > 0);
  const avg = voiced.length ? Math.round(voiced.reduce((s, p) => s + p.cpm, 0) / voiced.length) : 0;
  const max = voiced.reduce((m, p) => Math.max(m, p.cpm), 0);
  return { avg, max, overSeconds: voiced.filter((p) => p.cpm >= threshold).length * stepSec, samples: h.length };
}

/** 生成 SVG 折线的坐标串；横轴按时间铺满 spanMs，纵轴 0~yMax */
export function chartPoints(h: HistoryPoint[], w: number, hgt: number, spanMs: number, yMax: number, nowT: number): string {
  return h
    .map((p) => {
      const x = w - ((nowT - p.t) / spanMs) * w;
      const y = hgt - Math.min(1, p.cpm / yMax) * hgt;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

// ---------------- 其他 ----------------

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** 常见场景参考语速（参考仓库的设置页提示，经验值，非标准） */
export const PRESETS = [
  { label: '播音', value: 240 },
  { label: '口播', value: 280 },
  { label: '带货', value: 320 },
  { label: '快节奏', value: 380 },
];
