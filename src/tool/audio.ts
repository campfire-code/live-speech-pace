// 本机音频：麦克风采集与报警音。声音只在内存里即时计算，不保存、不上传。
import type { Voice } from './store';

/** 在音频线程里把麦克风原始采样攒成大块再发回主线程（窗口在后台时也不会被降频） */
const WORKLET_SRC = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('pace-tap', Tap);
`;

export interface MicSession {
  sampleRate: number;
  stop(): void;
}

export function micErrorText(e: unknown): string {
  const err = e as { name?: string; message?: string };
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '没有麦克风权限。Mac：打开「系统设置 → 隐私与安全性 → 麦克风」，勾选本软件后重新打开；Windows：打开「设置 → 隐私和安全性 → 麦克风」，允许桌面应用使用麦克风。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '没有找到可用的麦克风，请接好麦克风后再试。';
    case 'NotReadableError':
      return '麦克风被其他程序占用或被系统禁用，请关闭占用它的程序后再试。';
    default:
      return `启动失败：${err?.message ?? String(e)}`;
  }
}

/** 打开麦克风并持续回调原始采样（单声道 Float32）。关闭回声消除、降噪和自动增益，否则会抹平字与字之间的起伏。 */
export async function startMic(onChunk: (c: Float32Array) => void): Promise<MicSession> {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('当前环境不支持麦克风'), { name: 'NotFoundError' });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  const src = ctx.createMediaStreamSource(stream);
  const nodes: AudioNode[] = [src];
  let url = '';
  try {
    url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const tap = new AudioWorkletNode(ctx, 'pace-tap', { numberOfOutputs: 0 });
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => onChunk(e.data);
    src.connect(tap);
    nodes.push(tap);
  } catch {
    // 退路：旧接口，主线程处理
    const sp = ctx.createScriptProcessor(2048, 1, 1);
    sp.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(sp);
    sp.connect(mute);
    mute.connect(ctx.destination);
    nodes.push(sp, mute);
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
  if (ctx.state === 'suspended') await ctx.resume();
  return {
    sampleRate: ctx.sampleRate,
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      nodes.forEach((n) => { try { n.disconnect(); } catch { /* 已断开 */ } });
      void ctx.close();
    },
  };
}

let beepCtx: AudioContext | null = null;

/** 报警音：合成的两声短促蜂鸣，不依赖音频文件 */
export function playAlarm(voice: Voice, volume: number): void {
  try {
    beepCtx ??= new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ac = beepCtx;
    if (ac.state === 'suspended') void ac.resume();
    const beep = (start: number, freq: number) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = ac.currentTime + start;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(Math.min(1, volume), t0 + 0.02);
      gain.gain.linearRampToValueAtTime(0, t0 + 0.18);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(t0);
      osc.stop(t0 + 0.2);
    };
    if (voice === 'single') beep(0, 1000);
    else if (voice === 'triple') { beep(0, 1200); beep(0.25, 1200); beep(0.5, 1200); }
    else { beep(0, 1200); beep(0.25, 1200); }
  } catch {
    // 没有音频输出设备时静默忽略
  }
}

/** 直播时不让屏幕休眠（桌面端多数没有该接口，失败就忽略） */
export async function keepAwake(): Promise<() => void> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    const lock = await nav.wakeLock?.request('screen');
    return () => void lock?.release().catch(() => {});
  } catch {
    return () => {};
  }
}
