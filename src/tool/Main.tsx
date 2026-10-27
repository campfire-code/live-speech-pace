// 主界面：大号字/分钟读数 + 阈值与告警设置 + 历史曲线。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellRing, Mic, MicOff, ShieldCheck, Volume2 } from 'lucide-react';
import {
  AlarmGate, PaceEngine, PRESETS, SENSITIVITY, chartPoints, formatDuration, historyStats, pushHistory, zoneOf,
  type HistoryPoint, type PaceSnapshot, type SensitivityKey, type Zone,
} from './core';
import { keepAwake, micErrorText, playAlarm, startMic, type MicSession } from './audio';
import { DEFAULTS, loadSettings, saveSettings, type Settings, type Voice } from './store';
import { DEMO_NOW, demo, isPreview, type AlarmLog } from './preview';
import './tool.css';

const SPAN_MS = 5 * 60 * 1000; // 曲线显示最近 5 分钟
const KEEP_MS = 10 * 60 * 1000;
const ZONE_TEXT: Record<Zone, string> = { idle: '等待说话…', ok: '语速正常', warn: '接近上限', over: '语速过快！' };

const hhmmss = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });

export function Main() {
  const [settings, setSettings] = useState<Settings>(isPreview ? demo.settings : DEFAULTS);
  const [running, setRunning] = useState(isPreview);
  const [snap, setSnap] = useState<Pick<PaceSnapshot, 'cpm' | 'level' | 'silent'>>(isPreview ? { cpm: demo.cpm, level: demo.level, silent: false } : { cpm: 0, level: 0, silent: true });
  const [history, setHistory] = useState<HistoryPoint[]>(isPreview ? demo.history : []);
  const [alarms, setAlarms] = useState<AlarmLog[]>(isPreview ? demo.alarms : []);
  const [elapsed, setElapsed] = useState(isPreview ? demo.elapsedSec : 0);
  const [alertUntil, setAlertUntil] = useState(0);
  const [error, setError] = useState('');
  const [now, setNow] = useState(isPreview ? DEMO_NOW : Date.now());

  const cfgRef = useRef(settings);
  const engineRef = useRef<PaceEngine | null>(null);
  const micRef = useRef<MicSession | null>(null);
  const gate = useRef(new AlarmGate());
  const releaseRef = useRef<() => void>(() => {});
  const lastHistoryAt = useRef(0);

  useEffect(() => { cfgRef.current = settings; }, [settings]);
  useEffect(() => {
    if (isPreview) return;
    void loadSettings().then(setSettings);
  }, []);
  const patch = useCallback((p: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...p };
      if (!isPreview) void saveSettings(next);
      return next;
    });
  }, []);

  // 检测参数随设置实时下发
  useEffect(() => {
    const sens = SENSITIVITY[settings.sensitivity];
    engineRef.current?.setOptions({ syllableRatio: sens.syllableRatio, peakAbsRatio: sens.peakAbsRatio, windowMs: settings.windowSec * 1000 });
  }, [settings.sensitivity, settings.windowSec]);

  const fire = useCallback((cpm: number, t: number) => {
    const c = cfgRef.current;
    if (c.sound) playAlarm(c.voice, c.volume);
    setAlertUntil(t + 4000);
    setAlarms((a) => [{ at: t, cpm }, ...a].slice(0, 20));
  }, []);

  const stop = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    engineRef.current = null;
    releaseRef.current();
    gate.current.reset();
    setRunning(false);
    setSnap({ cpm: 0, level: 0, silent: true });
  }, []);

  const start = useCallback(async () => {
    setError('');
    try {
      const sens = SENSITIVITY[cfgRef.current.sensitivity];
      let engine: PaceEngine | null = null;
      const mic = await startMic((c) => engine?.push(c));
      engine = new PaceEngine(mic.sampleRate, { syllableRatio: sens.syllableRatio, peakAbsRatio: sens.peakAbsRatio, windowMs: cfgRef.current.windowSec * 1000 });
      engineRef.current = engine;
      micRef.current = mic;
      gate.current.reset();
      lastHistoryAt.current = 0;
      setHistory([]);
      setAlarms([]);
      setElapsed(0);
      setRunning(true);
      releaseRef.current = await keepAwake();
    } catch (e) {
      setError(micErrorText(e));
      stop();
    }
  }, [stop]);

  // 测速中：每 200ms 读一次引擎
  useEffect(() => {
    if (!running || isPreview) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const eng = engineRef.current;
      if (!eng) return;
      const s = eng.snapshot();
      const t = Date.now();
      setSnap({ cpm: s.cpm, level: s.level, silent: s.silent });
      setNow(t);
      setElapsed(Math.floor((t - startedAt) / 1000));
      const c = cfgRef.current;
      if (gate.current.update(s.cpm, t, { threshold: c.threshold, holdMs: c.holdSec * 1000, cooldownMs: c.cooldownSec * 1000 })) fire(s.cpm, t);
      if (t - lastHistoryAt.current >= 1000) {
        lastHistoryAt.current = t;
        setHistory((h) => pushHistory(h, { t, cpm: s.cpm }, KEEP_MS));
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [running, fire]);

  useEffect(() => () => { micRef.current?.stop(); releaseRef.current(); }, []);

  const zone = running ? zoneOf(snap.cpm, settings.threshold) : 'idle';
  const alerting = settings.flash && now < alertUntil;
  const stats = useMemo(() => historyStats(history, settings.threshold), [history, settings.threshold]);
  const cfg = { threshold: settings.threshold, holdMs: settings.holdSec * 1000, cooldownMs: settings.cooldownSec * 1000 };
  const cooldownLeft = Math.ceil(gate.current.cooldownLeft(now, cfg) / 1000);
  const inCooldown = running && alarms.length > 0 && cooldownLeft > 0 && !isPreview;
  const lastAlarm = alarms[0];

  return (
    <div className={`ls-root${alerting ? ' alert' : ''}`}>
      <div className="ls-left">
        <section className={`ls-hero z-${zone}`} aria-live="polite">
          <div className="ls-hero-top">
            <span className="ls-state"><i className={running ? 'live' : ''} />{running ? '正在测速' : '未开始'}</span>
            {running && <span className="k-muted k-num">已监测 {formatDuration(elapsed)}</span>}
          </div>
          <div className="ls-read">
            <span className="ls-num k-num" aria-label={`当前语速 ${snap.cpm} 字每分钟`}>{running ? snap.cpm : '--'}</span>
            <span className="ls-unit">字 / 分钟</span>
          </div>
          <div className="ls-line">
            <span>阈值 <b className="k-num">{settings.threshold}</b></span>
            <span className={`ls-zone z-${zone}`}>{running ? ZONE_TEXT[zone] : '点「开始监测」后开始统计'}</span>
          </div>
          <div className="ls-meter" role="img" aria-label="麦克风电平"><i style={{ width: `${Math.round(snap.level * 100)}%` }} /></div>
          <div className="ls-actions">
            {running
              ? <button className="k-btn big" onClick={stop}><MicOff size={18} />停止监测</button>
              : <button className="k-btn primary big" onClick={start}><Mic size={18} />开始监测</button>}
            <button className="k-btn big" onClick={() => fire(settings.threshold, Date.now())} title="试听报警音并预览画面效果"><BellRing size={18} />试一下报警</button>
          </div>
          {error && <div className="ls-error" role="alert">{error}</div>}
          {alerting && <div className="ls-banner" role="alert"><BellRing size={20} />语速过快，请放慢一点</div>}
        </section>

        <section className="ls-card ls-chart">
          <div className="ls-card-head">
            <h3>最近 5 分钟语速</h3>
            <div className="ls-stats k-muted">
              <span>平均 <b className="k-num">{stats.avg || '--'}</b></span>
              <span>最高 <b className="k-num">{stats.max || '--'}</b></span>
              <span>超速 <b className="k-num">{stats.overSeconds}</b> 秒</span>
            </div>
          </div>
          <Chart history={history} threshold={settings.threshold} nowT={running ? now : (history.at(-1)?.t ?? now)} />
          <div className="ls-log">
            {lastAlarm
              ? <><Bell size={15} /><span>最近一次报警 <b className="k-num">{hhmmss(lastAlarm.at)}</b>，当时 <b className="k-num">{lastAlarm.cpm}</b> 字/分钟；本次共报警 <b className="k-num">{alarms.length}</b> 次{inCooldown ? `，冷静期还剩 ${cooldownLeft} 秒` : ''}</span></>
              : <span className="k-muted">本次还没有触发过报警</span>}
          </div>
        </section>
      </div>

      <aside className="ls-side">
        <section className="ls-card">
          <h3>超速阈值</h3>
          <div className="ls-th">
            <input className="k-input k-num" type="number" min={100} max={800} step={10} value={settings.threshold} aria-label="超速阈值（字/分钟）" onChange={(e) => patch({ threshold: Math.round(Number(e.target.value) || DEFAULTS.threshold) })} />
            <span className="k-muted">字 / 分钟</span>
          </div>
          <input className="ls-range" type="range" min={150} max={500} step={10} value={Math.min(500, Math.max(150, settings.threshold))} aria-label="阈值滑块" onChange={(e) => patch({ threshold: Number(e.target.value) })} />
          <div className="ls-presets">
            {PRESETS.map((p) => (
              <button key={p.label} className={`k-chip${settings.threshold === p.value ? ' on' : ''}`} onClick={() => patch({ threshold: p.value })}>{p.label} {p.value}</button>
            ))}
          </div>
          <p className="k-muted ls-hint">数字是经验参考，不是标准；先正常讲一两分钟，看自己的常态读数再定。</p>
        </section>

        <section className="ls-card">
          <h3>报警方式</h3>
          <Row label="提示音">
            <label className="k-toggle"><input type="checkbox" checked={settings.sound} onChange={(e) => patch({ sound: e.target.checked })} /><span>{settings.sound ? '开' : '关'}</span></label>
          </Row>
          {settings.sound && <>
            <Row label="音色">
              <Seg value={settings.voice} onChange={(v) => patch({ voice: v as Voice })} options={[['single', '一声'], ['double', '两声'], ['triple', '三声']]} />
            </Row>
            <Row label={<><Volume2 size={14} /> 音量</>}>
              <input className="ls-range" type="range" min={0.1} max={1} step={0.05} value={settings.volume} aria-label="报警音量" onChange={(e) => patch({ volume: Number(e.target.value) })} />
            </Row>
          </>}
          <Row label="画面闪红">
            <label className="k-toggle"><input type="checkbox" checked={settings.flash} onChange={(e) => patch({ flash: e.target.checked })} /><span>{settings.flash ? '开' : '关'}</span></label>
          </Row>
          <Row label="持续超速">
            <Seg value={String(settings.holdSec)} onChange={(v) => patch({ holdSec: Number(v) })} options={[['0', '立即'], ['2', '2 秒'], ['3', '3 秒'], ['5', '5 秒']]} />
          </Row>
          <Row label="冷静期">
            <Seg value={String(settings.cooldownSec)} onChange={(v) => patch({ cooldownSec: Number(v) })} options={[['10', '10 秒'], ['30', '30 秒'], ['60', '1 分钟'], ['120', '2 分钟']]} />
          </Row>
          <p className="k-muted ls-hint">超速持续满设定时间才报警；报警后在冷静期内不再重复响。</p>
        </section>

        <section className="ls-card">
          <h3>检测</h3>
          <Row label="灵敏度">
            <Seg value={settings.sensitivity} onChange={(v) => patch({ sensitivity: v as SensitivityKey })} options={(Object.keys(SENSITIVITY) as SensitivityKey[]).map((k) => [k, SENSITIVITY[k].label.split('（')[0]])} />
          </Row>
          <Row label="统计窗口">
            <Seg value={String(settings.windowSec)} onChange={(v) => patch({ windowSec: Number(v) })} options={[['2', '2 秒'], ['3', '3 秒'], ['5', '5 秒']]} />
          </Row>
          <p className="k-muted ls-hint">读数偏低或漏字：调高灵敏度；背景有杂音被误数：调低。窗口越短反应越快，但数字跳得更厉害。</p>
        </section>

        <p className="ls-privacy"><ShieldCheck size={16} />声音只在本机即时计算，不录音、不保存、不联网。</p>
      </aside>
    </div>
  );
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return <div className="ls-row"><span className="ls-row-l">{label}</span><div className="ls-row-c">{children}</div></div>;
}

function Seg({ value, options, onChange }: { value: string; options: (readonly [string, string])[]; onChange: (v: string) => void }) {
  return (
    <div className="k-seg" role="radiogroup">
      {options.map(([v, l]) => <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

const W = 560, H = 150;

function Chart({ history, threshold, nowT }: { history: HistoryPoint[]; threshold: number; nowT: number }) {
  const yMax = Math.max(400, Math.ceil((Math.max(threshold, ...history.map((p) => p.cpm)) * 1.1) / 100) * 100);
  const pts = chartPoints(history, W, H, SPAN_MS, yMax, nowT);
  const ty = H - (threshold / yMax) * H;
  const ticks = [0, 1, 2, 3, 4, 5].map((m) => ({ x: W - (m * 60000 / SPAN_MS) * W, m }));
  return (
    <svg className="ls-svg" viewBox={`-34 -8 ${W + 44} ${H + 30}`} role="img" aria-label="语速历史曲线" preserveAspectRatio="none">
      {[0, 0.5, 1].map((r) => (
        <g key={r}>
          <line x1={0} x2={W} y1={H - r * H} y2={H - r * H} className="grid" />
          <text x={-6} y={H - r * H + 4} textAnchor="end" className="axis">{Math.round(yMax * r)}</text>
        </g>
      ))}
      {ticks.map((t) => <text key={t.m} x={t.x} y={H + 18} textAnchor={t.m === 0 ? 'end' : t.m === 5 ? 'start' : 'middle'} className="axis">{t.m === 0 ? '现在' : `${t.m}分钟前`}</text>)}
      <line x1={0} x2={W} y1={ty} y2={ty} className="th" />
      <text x={W} y={ty - 5} textAnchor="end" className="th-t">阈值 {threshold}</text>
      {history.length > 1 && <polyline points={pts} className="line" />}
    </svg>
  );
}
