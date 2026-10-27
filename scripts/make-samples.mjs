// 生成验收用的合成示例音频（samples/*.wav）：用「字」形状的短音模拟每秒 N 个字。
// 运行：node scripts/make-samples.mjs。示例音频是合成的嗡嗡声，不是真人说话。
import { mkdirSync, writeFileSync } from 'node:fs';

const SR = 16000;
function speech(seconds, perSec) {
  const n = SR * seconds, a = new Int16Array(n), period = SR / perSec;
  for (let i = 0; i < n; i++) {
    const ph = (i % period) / period, t = i / SR;
    const env = ph < 0.7 ? Math.sin((ph / 0.7) * Math.PI) ** 2 : 0.02;
    const v = Math.sin(2 * Math.PI * 180 * t) + 0.6 * Math.sin(2 * Math.PI * 900 * t) + 0.4 * Math.sin(2 * Math.PI * 1620 * t);
    a[i] = Math.round(Math.max(-1, Math.min(1, 0.3 * env * v)) * 32767);
  }
  return a;
}
function wav(samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer).copy(b, 44);
  return b;
}
mkdirSync('samples', { recursive: true });
writeFileSync('samples/示例-每秒4字-约240字每分钟.wav', wav(speech(40, 4)));
writeFileSync('samples/示例-每秒6字-约360字每分钟.wav', wav(speech(40, 6)));
console.log('已生成 samples/');
