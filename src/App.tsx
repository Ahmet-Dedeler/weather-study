import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Camera,
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSun,
  Download,
  Eye,
  EyeOff,
  ListFilter,
  Moon,
  Pause,
  Play,
  RefreshCw,
  Smartphone,
  Sun,
  Volume2,
  VolumeX,
  Wind,
  Zap,
} from 'lucide-react';
import type { WeatherRuntimeState } from './engine/types';
import { WeatherEngine } from './engine/weatherEngine';
import { CAMERA_PRESETS, WeatherRenderer, type CameraState } from './engine/renderer';
import { closeTextures, createDemoCoast, createDemoTextures, createDemoWeather, DEMO_PRESETS } from './engine/demo';
import { WeatherAudioEngine } from './engine/audio';

const TIME_PRESETS = [
  { label: 'Dawn', hour: 6.15 },
  { label: 'Noon', hour: 12.5 },
  { label: 'Sunset', hour: 17.86 },
  { label: 'Night', hour: 23.2 },
];

const SPEEDS = [
  { mult: 1, label: '1×' },
  { mult: 12, label: '12×' },
  { mult: 60, label: '60×' },
  { mult: 360, label: '360×' },
];

function downloadStill(blob: Blob, lightning: boolean) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = lightning ? 'weather-study-lightning-4k.png' : 'weather-study-4k.png';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatClock(hours: number): string {
  const minutesPerDay = 24 * 60;
  // Slider values can land just below a whole minute due to floating-point representation.
  const totalMinutes = Math.floor(hours * 60 + 1e-9);
  const minuteOfDay = ((totalMinutes % minutesPerDay) + minutesPerDay) % minutesPerDay;
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function WeatherGlyph({ icon, night, size = 24 }: { icon: string; night: boolean; size?: number }) {
  const up = icon.toUpperCase();
  if (up.includes('STORM') || up.includes('HURRICANE') || up.includes('THUNDER')) {
    return <CloudLightning size={size} color="#9bc8ff" />;
  }
  if (up.includes('RAIN') || up.includes('DRIZZLE') || up.includes('SHOWER')) {
    return <CloudRain size={size} color="#7dc4ff" />;
  }
  if (up.includes('FOG') || up.includes('MIST') || up.includes('HAZE')) {
    return <CloudFog size={size} color="#cbd5e1" />;
  }
  if (up.includes('OVERCAST') || up.includes('CLOUD')) {
    return night ? <Cloud size={size} color="#94a3b8" /> : <CloudSun size={size} color="#fde047" />;
  }
  return night ? <Moon size={size} color="#c7d2fe" /> : <Sun size={size} color="#facc15" />;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<WeatherEngine | null>(null);
  const rendererRef = useRef<WeatherRenderer | null>(null);
  const audioRef = useRef<WeatherAudioEngine | null>(null);
  const pendingStill = useRef<'frame' | 'strike' | null>(null);

  const camRef = useRef<CameraState>({
    pos: [...CAMERA_PRESETS[0].pos],
    yaw: CAMERA_PRESETS[0].yaw,
    pitch: CAMERA_PRESETS[0].pitch,
    fovDeg: 58,
  });
  const keysRef = useRef<Set<string>>(new Set());
  const dragRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
    active: false,
    lastX: 0,
    lastY: 0,
  });

  const [ready, setReady] = useState(false);
  const [contextLost, setContextLost] = useState(false);
  const contextLostRef = useRef(false);
  const dataset = useMemo(createDemoWeather, []);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<WeatherRuntimeState | null>(null);
  const [fps, setFps] = useState(60);
  const [savingStill, setSavingStill] = useState(false);
  const [stillError, setStillError] = useState('');

  // UI Controls
  const [paused, setPaused] = useState(false);
  const [speedMult, setSpeedMult] = useState(12);
  const [autoCycle, setAutoCycle] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [showInspector, setShowInspector] = useState(false);
  const [showPhone, setShowPhone] = useState(false);
  const [hideUi, setHideUi] = useState(false);
  const [useFahrenheit, setUseFahrenheit] = useState(true);
  const [activeCamId, setActiveCamId] = useState(CAMERA_PRESETS[0].id);
  const [region, setRegion] = useState<'GLOBAL' | 'URBAN'>('GLOBAL');

  useEffect(() => {
    let cancelled = false;
    let buildSeq = 0;
    const canvas = canvasRef.current;
    if (!canvas) {
      setError('Canvas not mounted');
      return;
    }

    const coast = createDemoCoast();

    const syncCanvasSize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.max(1, Math.floor(window.innerWidth * dpr));
      const h = Math.max(1, Math.floor(window.innerHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    const buildRenderer = async () => {
      const seq = ++buildSeq;
      const visuals = await createDemoTextures();
      try {
        if (cancelled || seq !== buildSeq || contextLostRef.current) return;
        syncCanvasSize();
        rendererRef.current?.dispose();
        rendererRef.current = new WeatherRenderer(
          canvas,
          coast.heights,
          coast.materials,
          coast.meta,
          dataset.stsConfig,
          visuals,
        );
      } finally {
        closeTextures(visuals);
      }

      if (!engineRef.current) {
        const engine = new WeatherEngine(dataset);
        const audio = new WeatherAudioEngine();
        engine.onThunderCallback = (dist, inten) => audio.triggerThunder(dist, inten);
        engineRef.current = engine;
        audioRef.current = audio;
      }
      setError(null);
      setContextLost(false);
      setReady(true);
    };

    const onContextLost = (e: Event) => {
      e.preventDefault();
      contextLostRef.current = true;
      buildSeq++;
      rendererRef.current?.dispose();
      rendererRef.current = null;
      if (pendingStill.current) {
        pendingStill.current = null;
        setSavingStill(false);
        setStillError('WebGL context lost');
      }
      setContextLost(true);
    };

    const onContextRestored = () => {
      contextLostRef.current = false;
      void buildRenderer().catch((e) => {
        if (!cancelled) {
          setContextLost(false);
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    };

    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    void buildRenderer().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      cancelled = true;
      buildSeq++;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      rendererRef.current?.dispose();
      audioRef.current?.dispose();
      rendererRef.current = null;
      audioRef.current = null;
      engineRef.current = null;
    };
  }, [dataset]);

  // Main 60 FPS Simulation & Render Loop
  useEffect(() => {
    if (!ready) return;
    let rafId = 0;
    let lastTs = performance.now();
    let elapsedTotal = 0;
    let uiAccum = 0;
    let frames = 0;
    let fpsAccum = 0;

    const resize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.max(1, Math.floor(window.innerWidth * dpr));
      const h = Math.max(1, Math.floor(window.innerHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    resize();
    window.addEventListener('resize', resize);

    const tick = (now: number) => {
      const dt = Math.min(0.08, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;
      elapsedTotal += dt;

      // Update free-fly WASD camera
      const keys = keysRef.current;
      if (keys.size > 0) {
        const cam = camRef.current;
        const moveSpeed = (keys.has('shift') ? 130 : 48) * dt;
        const sy = Math.sin(cam.yaw);
        const cy = Math.cos(cam.yaw);
        const fwdX = sy;
        const fwdZ = -cy;
        const rightX = cy;
        const rightZ = sy;
        if (keys.has('w') || keys.has('arrowup')) {
          cam.pos[0] += fwdX * moveSpeed;
          cam.pos[2] += fwdZ * moveSpeed;
        }
        if (keys.has('s') || keys.has('arrowdown')) {
          cam.pos[0] -= fwdX * moveSpeed;
          cam.pos[2] -= fwdZ * moveSpeed;
        }
        if (keys.has('d') || keys.has('arrowright')) {
          cam.pos[0] += rightX * moveSpeed;
          cam.pos[2] += rightZ * moveSpeed;
        }
        if (keys.has('a') || keys.has('arrowleft')) {
          cam.pos[0] -= rightX * moveSpeed;
          cam.pos[2] -= rightZ * moveSpeed;
        }
        if (keys.has('e') || keys.has(' ')) cam.pos[1] += moveSpeed * 0.7;
        if (keys.has('q')) cam.pos[1] -= moveSpeed * 0.7;
        cam.pos[1] = Math.max(2.5, Math.min(480, cam.pos[1]));
      }

      const engine = engineRef.current;
      const renderer = rendererRef.current;
      if (engine && renderer && !contextLostRef.current && !renderer.isContextLost()) {
        const st = engine.step(dt, camRef.current.pos, camRef.current.yaw);
        renderer.render(dt, camRef.current, st);
        audioRef.current?.update(st, elapsedTotal);
        const still = pendingStill.current;
        if (still === 'frame' || (still === 'strike' && (
          st.lightning.age >= 0.10 && st.lightning.flashIntensity > 0.54 || st.lightning.age >= 0.26))) {
          pendingStill.current = null;
          void renderer.capture4K(camRef.current, st)
            .then((blob) => downloadStill(blob, still === 'strike'))
            .catch((err: Error) => setStillError(err.message))
            .finally(() => setSavingStill(false));
        }

        uiAccum += dt;
        if (uiAccum >= 0.08) {
          uiAccum = 0;
          setRuntime(st);
        }
      }

      frames++;
      fpsAccum += dt;
      if (fpsAccum >= 0.5) {
        setFps(Math.round(frames / fpsAccum));
        frames = 0;
        fpsAccum = 0;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
    };
  }, [ready]);

  // Keyboard & mouse listeners
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable) {
        return;
      }
      const k = e.key.toLowerCase();
      if (k === ' ' && (tag === 'BUTTON' || tag === 'A' || Boolean(target?.closest('button, a')))) {
        return;
      }
      if (k === 'h') {
        if (e.repeat) return;
        setHideUi((v) => !v);
        return;
      }
      keysRef.current.add(k);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key.toLowerCase());
    };
    const clearKeys = () => {
      keysRef.current.clear();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearKeys);
    document.addEventListener('visibilitychange', clearKeys);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearKeys);
      document.removeEventListener('visibilitychange', clearKeys);
    };
  }, []);

  const filteredWeatherTypes = useMemo(() => {
    if (!dataset) return [];
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return dataset.weatherTypes;
    return dataset.weatherTypes.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        w.dataName.toLowerCase().includes(q) ||
        w.weatherAppDataName.toLowerCase().includes(q),
    );
  }, [dataset, pickerQuery]);

  const hourlyForecast = useMemo(() => {
    if (!engineRef.current || !runtime) return [];
    return engineRef.current.getHourlyForecast(6);
  }, [runtime?.targetWeatherName, runtime ? Math.floor(runtime.timeOfDayHours) : 0, autoCycle]);

  const selectWeather = (name: string, instant = false) => {
    engineRef.current?.setWeather(name, instant);
    setAutoCycle(false);
    if (engineRef.current) engineRef.current.autoCycle = false;
  };

  const setTimeOfDay = (hour: number) => {
    if (!Number.isFinite(hour)) return;
    if (engineRef.current) engineRef.current.timeOfDayHours = hour;
    setRuntime((prev) => (prev ? { ...prev, timeOfDayHours: hour } : prev));
  };

  const applyCameraPreset = (presetId: string) => {
    const p = CAMERA_PRESETS.find((c) => c.id === presetId);
    if (!p) return;
    camRef.current.pos = [...p.pos];
    camRef.current.yaw = p.yaw;
    camRef.current.pitch = p.pitch;
    setActiveCamId(presetId);
  };

  const formatTemp = (c: number) =>
    useFahrenheit ? `${Math.round((c * 9) / 5 + 32)}°` : `${Math.round(c)}°`;
  const clock = runtime ? formatClock(runtime.timeOfDayHours) : undefined;

  return (
    <div className="viewport">
      <canvas
        ref={canvasRef}
        className="gl-canvas"
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Pointer capture can throw on detached or synthetic pointer events.
          }
          dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
        }}
        onPointerMove={(e) => {
          if (!e.isPrimary || !dragRef.current.active) return;
          if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
            dragRef.current.active = false;
            return;
          }
          const dx = e.clientX - dragRef.current.lastX;
          const dy = e.clientY - dragRef.current.lastY;
          dragRef.current.lastX = e.clientX;
          dragRef.current.lastY = e.clientY;
          camRef.current.yaw += dx * 0.0045;
          camRef.current.pitch = Math.max(-1.1, Math.min(1.2, camRef.current.pitch - dy * 0.0045));
        }}
        onPointerUp={(e) => {
          if (!e.isPrimary) return;
          dragRef.current.active = false;
          try {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
          } catch {
            // Ignore if capture is not active.
          }
        }}
        onPointerCancel={(e) => {
          if (!e.isPrimary) return;
          dragRef.current.active = false;
        }}
        onLostPointerCapture={() => {
          dragRef.current.active = false;
        }}
        onWheel={(e) => {
          camRef.current.fovDeg = Math.max(32, Math.min(82, camRef.current.fovDeg + e.deltaY * 0.03));
        }}
      />

      {error && (
        <div className="loading-screen" style={{ position: 'absolute', inset: 0, zIndex: 50 }}>
          <h2 style={{ color: '#ff7096' }}>Weather Engine Error</h2>
          <pre style={{ maxWidth: 680, whiteSpace: 'pre-wrap', fontSize: 12, opacity: 0.85 }}>{error}</pre>
        </div>
      )}

      {contextLost && !error && (
        <div className="loading-screen" style={{ position: 'absolute', inset: 0, zIndex: 45 }}>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '0.08em' }}>
            WebGL Context Lost
          </div>
          <div style={{ fontSize: 12, opacity: 0.65 }}>
            Rendering paused while waiting for the graphics context to restore...
          </div>
        </div>
      )}

      {!runtime && !error && (
        <div className="loading-screen" style={{ position: 'absolute', inset: 0, zIndex: 40 }}>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '0.08em' }}>
            Loading Weather Study...
          </div>
          <div style={{ fontSize: 12, opacity: 0.65 }}>
            Generating the coastline and weather textures
          </div>
        </div>
      )}

      {runtime && !hideUi && (
        <>
          {/* TOP CONTROL BAR */}
          <div className="top-bar glass">
            <div className="top-row">
              <div className="brand">
                <img className="brand-mark" src={new URL('../assets/logo.svg', import.meta.url).href} alt="" width="22" height="22" />
                <span>Weather Study</span>
              </div>

              <div className="clock-group">
                <button
                  className="btn"
                  onClick={() => {
                    const next = !paused;
                    setPaused(next);
                    if (engineRef.current) engineRef.current.paused = next;
                  }}
                >
                  {paused ? <Play size={13} /> : <Pause size={13} />}
                </button>
                <span className="clock-readout">{clock}</span>
                <input
                  type="range"
                  aria-label="Time of day"
                  aria-valuetext={clock}
                  className="time-slider"
                  min={0}
                  max={23.98}
                  step={0.02}
                  value={runtime.timeOfDayHours}
                  onChange={(e) => {
                    setTimeOfDay(parseFloat(e.target.value));
                  }}
                />
                {TIME_PRESETS.map((tp) => (
                  <button
                    key={tp.label}
                    className="btn btn-pill"
                    onClick={() => {
                      setTimeOfDay(tp.hour);
                    }}
                  >
                    {tp.label}
                  </button>
                ))}
                {SPEEDS.map((s) => (
                  <button
                    key={s.mult}
                    className={`btn ${speedMult === s.mult ? 'active' : ''}`}
                    onClick={() => {
                      setSpeedMult(s.mult);
                      if (engineRef.current) engineRef.current.timeSpeed = s.mult;
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              <button
                className={`btn ${autoCycle ? 'active' : ''}`}
                onClick={() => {
                  const next = !autoCycle;
                  setAutoCycle(next);
                  if (engineRef.current) engineRef.current.autoCycle = next;
                }}
              >
                <RefreshCw size={13} /> Auto-Cycle
              </button>

              <button
                className="btn"
                title="Trigger a simulated lightning strike"
                onClick={() => engineRef.current?.triggerLightningNow(camRef.current.pos, camRef.current.yaw)}
              >
                <Zap size={13} color="#9bc8ff" /> Strike
              </button>

              <button
                className="btn"
                title={stillError || 'Download a HUD-free 3840 × 2160 PNG. Shift-click to capture a lightning strike.'}
                disabled={savingStill}
                onClick={(e) => {
                  setStillError('');
                  setSavingStill(true);
                  pendingStill.current = e.shiftKey ? 'strike' : 'frame';
                  if (e.shiftKey) engineRef.current?.triggerLightningNow(camRef.current.pos, camRef.current.yaw);
                }}
              >
                <Download size={13} /> {savingStill ? 'Rendering…' : stillError ? 'Retry 4K' : '4K PNG'}
              </button>

              <button
                className={`btn ${soundOn ? 'active' : ''}`}
                onClick={() => {
                  const on = audioRef.current?.toggle() ?? false;
                  setSoundOn(on);
                }}
              >
                {soundOn ? <Volume2 size={13} /> : <VolumeX size={13} />}
                {soundOn ? 'Audio On' : 'Audio'}
              </button>

              <button className={`btn ${showPicker ? 'active' : ''}`} onClick={() => setShowPicker((v) => !v)}>
                <ListFilter size={13} /> Presets
              </button>

              <button className={`btn ${showInspector ? 'active' : ''}`} aria-label="Weather data" aria-pressed={showInspector} onClick={() => setShowInspector((v) => !v)}>
                <Activity size={13} />
              </button>

              <button className={`btn ${showPhone ? 'active' : ''}`} aria-label="Forecast" aria-pressed={showPhone} onClick={() => setShowPhone((v) => !v)}>
                <Smartphone size={13} />
              </button>

              <button className="btn" title="Hide HUD (H)" onClick={() => setHideUi(true)}>
                <EyeOff size={13} />
              </button>
            </div>

            <div className="pills-row">
              {DEMO_PRESETS.map(([name, label]) => {
                const isActive = runtime.targetWeatherName === name;
                return (
                  <button
                    key={name}
                    className={`btn btn-pill ${isActive ? 'active' : ''}`}
                    onClick={() => selectWeather(name, false)}
                    onDoubleClick={() => selectWeather(name, true)}
                    title={`Click to cross-fade · Double-click for instant (${name})`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {showPicker && (
            <div className="picker-popover glass">
              <input
                className="search-input"
                placeholder="Filter weather presets..."
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                autoFocus
              />
              <div className="picker-list">
                {filteredWeatherTypes.map((w) => (
                  <button
                    key={w.name}
                    className={`picker-item ${runtime.targetWeatherName === w.name ? 'active' : ''}`}
                    onClick={() => {
                      selectWeather(w.name, false);
                      setShowPicker(false);
                    }}
                  >
                    <span>{w.name}</span>
                    <span className="picker-sub">{w.dataName}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Data inspector */}
          {showInspector && (
            <div className="inspector glass">
              <div className="insp-title">
                <span>Weather Data Inspector</span>
                <span style={{ color: '#86efac' }}>{fps} FPS</span>
              </div>

              <div className="insp-row">
                <span>WeatherType</span>
                <span className="insp-val">
                  {runtime.transitionProgress < 0.99
                    ? `${runtime.currentWeatherName} → ${runtime.targetWeatherName} (${Math.round(runtime.transitionProgress * 100)}%)`
                    : runtime.targetWeatherName}
                </span>
              </div>
              <div className="insp-row">
                <span>Base Timecycle</span>
                <span className="insp-val">{runtime.dataName}</span>
              </div>
              <div className="insp-row">
                <span>Timecycle Region</span>
                <select aria-label="Timecycle region" className="btn" value={region} onChange={(e) => {
                  const next = e.target.value === 'URBAN' ? 'URBAN' : 'GLOBAL';
                  setRegion(next);
                  if (engineRef.current) engineRef.current.timecycleRegion = next;
                }}>
                  <option value="GLOBAL">Global</option>
                  <option value="URBAN">Urban</option>
                </select>
              </div>
              <div className="insp-row">
                <span>Rayleigh λ (nm)</span>
                <span className="insp-val">
                  {runtime.wavelengthRGB.map((v) => v.toFixed(0)).join(' / ')}
                </span>
              </div>
              <div className="insp-row">
                <span>Aerosol / Ozone</span>
                <span className="insp-val">
                  {runtime.aerosolDensity.toFixed(2)} / {runtime.ozoneConcentration.toFixed(2)}
                </span>
              </div>
              <div className="insp-row">
                <span>Est. Cover / Deck</span>
                <span className="insp-val">
                  {Math.round(runtime.cloudCoverage * 100)}% ({Math.round(runtime.cloudBaseHeight)}–{Math.round(runtime.cloudTopHeight)}m)
                </span>
              </div>
              <div className="insp-section" style={{ fontSize: 10, opacity: 0.72, overflowWrap: 'anywhere' }}>
                Cloud maps: {runtime.cloudMapsTo.join(' + ') || 'Procedural fallback'}
              </div>
              <div className="insp-row">
                <span>Rain / Wetness</span>
                <span className="insp-val">
                  {Math.round(runtime.rainIntensity * 100)}% / {Math.round(runtime.wetness * 100)}%
                </span>
              </div>

              <div className="insp-section">
                <div className="insp-row">
                  <span>Wind + Gust</span>
                  <span className="insp-val">
                    {runtime.windTotalSpeed.toFixed(1)} m/s ({Math.round(runtime.windTotalSpeed * 3.6)} km/h)
                    {runtime.gustActive ? ' ⚡GUST' : ''}
                  </span>
                </div>
                <div className="insp-row">
                  <span>Ocean Fetch / Swell</span>
                  <span className="insp-val">
                    {Math.round(runtime.oceanFetch)}m / {runtime.oceanWaveAmplitude.toFixed(2)}m
                  </span>
                </div>
                <div className="insp-row">
                  <span>Shore Wave / Foam</span>
                  <span className="insp-val">
                    {runtime.shoreWaveAmplitude.toFixed(2)}m / {runtime.oceanFoamIntensity.toFixed(2)}
                  </span>
                </div>
                <div className="insp-row">
                  <span>Lightning Temp</span>
                  <span className="insp-val">
                    {Math.round(runtime.lightningTempMin / 1000)}k–{Math.round(runtime.lightningTempMax / 1000)}k K
                  </span>
                </div>
              </div>

              {runtime.activeMods.length > 0 && (
                <div className="insp-section">
                  <div style={{ fontSize: 10, opacity: 0.6, marginBottom: 4 }}>
                    ACTIVE W_MOD_* STACK ({runtime.activeMods.length})
                  </div>
                  <div className="mod-tags">
                    {runtime.activeMods.slice(0, 10).map((m) => (
                      <span key={m} className="mod-tag">
                        {m.replace(/^W_MOD_/, '')}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}

          {/* BOTTOM CENTER CAMERA PRESETS DOCK */}
          <div className="bottom-dock glass">
            <Camera size={13} style={{ opacity: 0.7, marginLeft: 4 }} />
            {CAMERA_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`btn btn-pill ${activeCamId === p.id ? 'active' : ''}`}
                onClick={() => applyCameraPreset(p.id)}
              >
                {p.label}
              </button>
            ))}
            <span style={{ fontSize: 10.5, opacity: 0.55, padding: '0 6px' }}>
              Drag: Look · WASD/QE: Fly
            </span>
          </div>

          {showPhone && (
            <div className="phone-widget">
              <div className="phone-notch" />
              <div className="phone-loc">
                <span>COASTAL STATION</span>
                <span>{clock}</span>
              </div>

              <div className="phone-temp-row">
                <div
                  className="phone-temp"
                  title="Click to toggle °F / °C"
                  onClick={() => setUseFahrenheit((v) => !v)}
                >
                  {formatTemp(runtime.temperatureC)}
                </div>
                <WeatherGlyph icon={runtime.appIcon} night={runtime.isNight} size={42} />
              </div>

              <div className="phone-desc">{runtime.appDescription}</div>
              <div style={{ fontSize: 10.5, opacity: 0.58, marginTop: 1 }}>
                {runtime.targetWeatherName} · Niceness {runtime.niceness.toFixed(0)}/10
              </div>

              <div className="phone-metrics">
                <div className="phone-metric">
                  <div className="phone-metric-lbl">Wind</div>
                  <div className="phone-metric-val" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Wind size={12} /> {Math.round(runtime.windTotalSpeed * 2.237)} mph
                  </div>
                </div>
                <div className="phone-metric">
                  <div className="phone-metric-lbl">Humidity</div>
                  <div className="phone-metric-val">{Math.round(runtime.humidityPct)}%</div>
                </div>
                <div className="phone-metric">
                  <div className="phone-metric-lbl">Ocean Swell</div>
                  <div className="phone-metric-val">{runtime.oceanWaveAmplitude.toFixed(1)} m</div>
                </div>
                <div className="phone-metric">
                  <div className="phone-metric-lbl">Pressure</div>
                  <div className="phone-metric-val">{Math.round(runtime.pressureHpa)} hPa</div>
                </div>
              </div>

              <div className="phone-forecast">
                {hourlyForecast.map((f, i) => (
                  <div key={i} className="fc-col">
                    <span className="fc-hr">{i === 0 ? 'Now' : `${String(f.hour).padStart(2, '0')}h`}</span>
                    <WeatherGlyph icon={f.icon} night={f.hour < 6 || f.hour >= 20} size={14} />
                    <span className="fc-tmp">{formatTemp(f.tempC)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {hideUi && (
        <button className="cinema-hint glass" onClick={() => setHideUi(false)}>
          <Eye size={12} style={{ verticalAlign: 'middle', marginRight: 5 }} /> Show HUD (H)
        </button>
      )}
    </div>
  );
}
