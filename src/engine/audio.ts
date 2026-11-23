import type { WeatherRuntimeState } from './types';

/**
 * Procedural WebAudio storm, wind-gust, rain, surf, and distance-delayed thunder engine
 * driven strictly by WEATHER.XML runtime state.
 */
export class WeatherAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private oceanGain: GainNode | null = null;
  private oceanFilter: BiquadFilterNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private suspendTimer: number | null = null;
  enabled = false;

  private clearSuspendTimer(): void {
    if (this.suspendTimer !== null) {
      window.clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
  }

  toggle(): boolean {
    if (!this.ctx) {
      this.init();
    }
    if (!this.ctx || !this.masterGain) {
      this.enabled = false;
      return false;
    }
    this.enabled = !this.enabled;
    this.clearSuspendTimer();

    const ctx = this.ctx;
    const gain = this.masterGain.gain;
    const now = ctx.currentTime;

    if (this.enabled && ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }

    if (typeof gain.cancelAndHoldAtTime === 'function') {
      gain.cancelAndHoldAtTime(now);
    } else {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
    }
    gain.setTargetAtTime(this.enabled ? 0.65 : 0.0, now, 0.18);

    if (!this.enabled) {
      this.suspendTimer = window.setTimeout(() => {
        this.suspendTimer = null;
        if (!this.enabled && this.ctx && this.ctx.state === 'running') {
          void this.ctx.suspend().catch(() => {});
        }
      }, 1000);
    }
    return this.enabled;
  }

  private init(): void {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    let ctx: AudioContext;
    try {
      ctx = new AudioCtx();
    } catch {
      return;
    }
    this.ctx = ctx;

    try {
      // 4-second seamless pink/brown-ish noise buffer
      const len = ctx.sampleRate * 4;
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.96900 * b2 + w * 0.1538520;
          b3 = 0.86650 * b3 + w * 0.3104856;
          b4 = 0.55000 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.0168980;
          data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.08;
          b6 = w * 0.115926;
        }
      }
      this.noiseBuffer = buf;

      const master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
      this.masterGain = master;

      const makeLoop = (filterType: BiquadFilterType, freq: number, q: number) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const filt = ctx.createBiquadFilter();
        filt.type = filterType;
        filt.frequency.value = freq;
        filt.Q.value = q;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(filt);
        filt.connect(gain);
        gain.connect(master);
        src.start();
        return { filt, gain };
      };

      const wind = makeLoop('bandpass', 240, 2.2);
      this.windFilter = wind.filt;
      this.windGain = wind.gain;

      const rain = makeLoop('highpass', 1100, 0.7);
      this.rainFilter = rain.filt;
      this.rainGain = rain.gain;

      const ocean = makeLoop('lowpass', 260, 0.9);
      this.oceanFilter = ocean.filt;
      this.oceanGain = ocean.gain;
    } catch {
      this.dispose();
    }
  }

  update(state: WeatherRuntimeState, elapsedSec: number): void {
    if (
      !this.ctx ||
      this.ctx.state !== 'running' ||
      !this.enabled ||
      !this.windGain ||
      !this.windFilter ||
      !this.rainGain ||
      !this.rainFilter ||
      !this.oceanGain ||
      !this.oceanFilter
    ) {
      return;
    }
    const now = this.ctx.currentTime;
    const windNorm = Math.min(1, state.windTotalSpeed / 35);
    this.windGain.gain.setTargetAtTime(0.04 + windNorm * 0.65, now, 0.15);
    this.windFilter.frequency.setTargetAtTime(160 + windNorm * 580 + state.gustEnvelope * 260, now, 0.15);

    const precip = Math.max(state.rainIntensity, state.hailIntensity * 0.9, state.sandstormIntensity * 0.55);
    this.rainGain.gain.setTargetAtTime(precip * 0.52, now, 0.2);
    this.rainFilter.frequency.setTargetAtTime(state.sandstormIntensity > 0.3 ? 650 : 1200 + precip * 800, now, 0.2);

    const surfWave = 0.5 + 0.5 * Math.sin(elapsedSec * (0.45 + state.oceanWaveAmplitude * 0.12));
    const oceanNorm = Math.min(1, state.oceanWaveAmplitude / 4.0);
    this.oceanGain.gain.setTargetAtTime((0.08 + oceanNorm * 0.38) * (0.72 + surfWave * 0.28), now, 0.25);
    this.oceanFilter.frequency.setTargetAtTime(160 + oceanNorm * 240 + surfWave * 110, now, 0.25);
  }

  triggerThunder(distanceMeters: number, intensity: number): void {
    if (!this.ctx || this.ctx.state !== 'running' || !this.enabled || !this.masterGain || !this.noiseBuffer) return;
    // Speed of sound ~343 m/s (capped to 2.4s for snappy interactive feel)
    const delay = Math.min(2.4, Math.max(0.15, distanceMeters / 343));
    const start = this.ctx.currentTime + delay;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(distanceMeters < 420 ? 950 : 380, start);
    lp.frequency.exponentialRampToValueAtTime(65, start + 2.6);

    const gain = this.ctx.createGain();
    const vol = Math.max(0.0001, Math.min(0.95, intensity * (600 / Math.max(250, distanceMeters))));
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(vol, start + 0.06);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol * 0.45), start + 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 3.2);

    src.connect(lp);
    lp.connect(gain);
    gain.connect(this.masterGain);
    src.onended = () => {
      src.disconnect();
      lp.disconnect();
      gain.disconnect();
    };
    src.start(start);
    src.stop(start + 3.4);
  }

  dispose(): void {
    this.clearSuspendTimer();
    this.enabled = false;
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.masterGain = null;
    this.windGain = null;
    this.windFilter = null;
    this.rainGain = null;
    this.rainFilter = null;
    this.oceanGain = null;
    this.oceanFilter = null;
    this.noiseBuffer = null;
  }
}
