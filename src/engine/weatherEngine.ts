import type {
  LightningBoltState,
  TimeSample,
  WeatherDataset,
  WeatherModifier,
  WeatherRuntimeState,
  WeatherTypeData,
  WeatherTypeEntry,
} from './types';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngleDeg(a: number, b: number, t: number): number {
  const delta = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + delta * t) % 360) + 360) % 360;
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function easeQuarticInOut(t: number): number {
  return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
}

/** Planckian blackbody approximation for lightning (20,000K..40,000K -> crisp blue-white). */
function kelvinToRGB(kelvin: number): [number, number, number] {
  const k = clamp(kelvin, 1000, 45000) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (k <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(k) - 161.1195681661;
    b = k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(k - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(k - 60, -0.0755148492);
    b = 255;
  }
  return [clamp(r / 255, 0, 1), clamp(g / 255, 0, 1), clamp(b / 255, 0, 1)];
}

export interface EvaluatedSnapshot {
  dataName: string;
  appTypeName: string;
  appDescription: string;
  appIcon: string;
  activeMods: string[];
  wavelengthRGB: [number, number, number];
  rayScatteringCol: [number, number, number];
  aerosolDensity: number;
  ozoneConcentration: number;
  mieEccentricity: number;
  skyCol: [number, number, number];
  sunCol: [number, number, number];
  sunIntensity: number;
  sunDiskMult: number;
  sunDiscSize: number;
  moonCol: [number, number, number];
  moonIntensity: number;
  starsIntensity: number;
  airGlowCol: [number, number, number];
  airGlowIntensity: number;
  lightDirCol: [number, number, number];
  lightDirMult: number;
  ambientSkyCol: [number, number, number];
  ambientSkyIntensity: number;
  cloudMapNames: [string, string];
  cloudCoverage: number;
  cloudDensity: number;
  cloudBaseHeight: number;
  cloudTopHeight: number;
  cirrusDensity: number;
  cirrusHeight: number;
  cloudWindScale: number;
  cloudWindShear: number;
  cloudShadowAlpha: number;
  cloudMultiScatter: number;
  cirrostratusDensity: number;
  cloudAnisotropy: number;
  cloudPowderExp: number;
  cloudStormDarkness: number;
  fogDensity: number;
  fogHeight: number;
  fogFalloff: number;
  hazeStrength: number;
  rainIntensity: number;
  hailIntensity: number;
  sandstormIntensity: number;
  puddleRippleScale: number;
  windBaseSpeed: number;
  windAngleDeg: number;
  windGustChance: number;
  windGustSpeedMin: number;
  windGustSpeedMax: number;
  windGustDurMin: number;
  windGustDurMax: number;
  windGustFadeIn: number;
  windGustFadeOut: number;
  oceanFetch: number;
  oceanWaveAmplitude: number;
  oceanWaveMaxAmplitude: number;
  shoreWaveAmplitude: number;
  oceanFoamIntensity: number;
  rippleBumpiness: number;
  waterGustMaxBump: number;
  filmicCurve: number[];
  temperatureC: number;
  humidityPct: number;
  pressureHpa: number;
  niceness: number;
  lightningChance: number;
  lightningTempMin: number;
  lightningTempMax: number;
}

export class WeatherEngine {
  readonly dataset: WeatherDataset;
  private weatherMap = new Map<string, WeatherTypeEntry>();
  private dataMap = new Map<string, WeatherTypeData>();
  private tcMap = new Map<string, Record<string, Record<string, number[]>>>();
  private modMap = new Map<string, WeatherModifier>();

  // Simulation clocks
  timeOfDayHours = 16.5;
  timeSpeed = 12; // 12x real-time (1 game hour every 5 minutes)
  paused = false;
  private _autoCycle = false;

  // Weather state & smooth cross-fade
  currentWeatherName: string;
  targetWeatherName: string;
  timecycleRegion: 'GLOBAL' | 'URBAN' = 'GLOBAL';
  transitionProgress = 1.0;
  transitionDurationSec = 6.0;
  private transitionFromSnapshot: EvaluatedSnapshot | null = null;
  private autoCycleNames: string[];
  private autoCycleIndex = 0;
  private autoCycleTimer = 0;
  private autoCycleHoldSec = 26;

  get autoCycle(): boolean {
    return this._autoCycle;
  }

  set autoCycle(value: boolean) {
    if (value && !this._autoCycle) {
      this.autoCycleTimer = 0;
      const idx = this.autoCycleNames.indexOf(this.targetWeatherName);
      if (idx !== -1) this.autoCycleIndex = idx;
    }
    this._autoCycle = value;
  }

  // Persistent physical state
  private wetness = 0.0;

  // Wind gust state machine driven by WEATHER.XML WindGusts*
  private gustActive = false;
  private gustAge = 0;
  private gustDuration = 6;
  private gustTargetSpeed = 0;
  private gustFadeIn = 0.2;
  private gustFadeOut = 0.7;
  private gustCooldown = 2.0;

  // Lightning state machine
  private lightningCooldown = 2.5;
  private lightning: LightningBoltState = {
    active: false,
    age: 0,
    duration: 0.35,
    flashIntensity: 0,
    worldX: 0,
    worldZ: -350,
    seed: 1,
    colorRGB: [0.78, 0.88, 1.0],
    kelvin: 28000,
    distanceMeters: 600,
  };

  onThunderCallback?: (distanceMeters: number, intensity: number) => void;

  constructor(dataset: WeatherDataset) {
    this.dataset = dataset;
    const first = dataset.weatherTypes[0];
    if (!first) throw new Error('Add at least one weather preset');
    this.currentWeatherName = this.targetWeatherName = first.name;
    this.autoCycleNames = dataset.weatherTypes.filter((entry) => !entry.skipDebugCycling).map(({ name }) => name);
    if (!this.autoCycleNames.length) this.autoCycleNames = [first.name];
    this.autoCycleIndex = Math.max(0, this.autoCycleNames.indexOf(first.name));
    for (const wt of dataset.weatherTypes) {
      this.weatherMap.set(wt.name.toLowerCase(), wt);
    }
    for (const [k, v] of Object.entries(dataset.weatherTypeDatas)) {
      this.dataMap.set(k.toLowerCase(), v);
    }
    for (const [k, v] of Object.entries(dataset.timecycles)) {
      this.tcMap.set(k.toLowerCase(), v);
    }
    for (const [k, v] of Object.entries(dataset.modifiers)) {
      this.modMap.set(k.toLowerCase(), v);
    }
  }

  getWeatherEntry(name: string): WeatherTypeEntry | undefined {
    return this.weatherMap.get(name.toLowerCase());
  }

  private evaluateCurrentSnapshot(hour: number): EvaluatedSnapshot {
    const snapB = this.evaluateWeatherAtTime(this.targetWeatherName, hour);
    if (this.transitionProgress >= 1.0) return snapB;
    const snapA =
      this.transitionFromSnapshot ??
      (this.currentWeatherName === this.targetWeatherName
        ? snapB
        : this.evaluateWeatherAtTime(this.currentWeatherName, hour));
    return this.blendSnapshots(snapA, snapB, this.transitionProgress);
  }

  setWeather(name: string, instant = false): void {
    const entry = this.weatherMap.get(name.toLowerCase());
    if (!entry) return;
    if (!instant && entry.name === this.targetWeatherName) {
      return;
    }

    const cycleIdx = this.autoCycleNames.indexOf(entry.name);
    if (cycleIdx !== -1) {
      this.autoCycleIndex = cycleIdx;
    }
    this.autoCycleTimer = 0;

    if (instant) {
      this.currentWeatherName = entry.name;
      this.targetWeatherName = entry.name;
      this.transitionFromSnapshot = null;
      this.transitionProgress = 1.0;
      // Snap wetness partially on instant switch so Rain/Hurricane looks wet immediately
      const snap = this.evaluateWeatherAtTime(entry.name, this.timeOfDayHours);
      this.wetness = snap.rainIntensity > 0.05 ? clamp(snap.rainIntensity * 0.9, 0.25, 1) : 0.02;
    } else {
      if (this.transitionProgress < 1.0) {
        this.transitionFromSnapshot = this.evaluateCurrentSnapshot(this.timeOfDayHours);
        if (this.transitionProgress >= 0.5) {
          this.currentWeatherName = this.targetWeatherName;
        }
      } else {
        this.transitionFromSnapshot = null;
        this.currentWeatherName = this.targetWeatherName;
      }
      this.targetWeatherName = entry.name;
      this.transitionProgress = 0.0;
    }
  }

  triggerLightningNow(camPos?: [number, number, number], camYaw?: number): void {
    const snap = this.evaluateWeatherAtTime(this.targetWeatherName, this.timeOfDayHours);
    this.spawnLightning(snap, camPos, camYaw);
  }

  /** Interpolate using the timecycle's own hours and easing. */
  private sampleTimecycle(values: number[] | undefined, hour: number, fallback: number): number {
    if (!values || values.length === 0) return fallback;
    if (values.length === 1) return values[0];
    const samples: TimeSample[] = this.dataset.timeSamples;
    const n = Math.min(samples.length, values.length);
    if (n <= 1) return n === 1 ? values[0] : fallback;
    const h = ((hour % 24) + 24) % 24;

    // Find bracketing keyframes cyclically across 24h
    let i0 = n - 1;
    let i1 = 0;
    for (let i = 0; i < n; i++) {
      if (samples[i].hour <= h) {
        i0 = i;
        i1 = (i + 1) % n;
      } else {
        break;
      }
    }
    const h0 = samples[i0].hour;
    let h1 = samples[i1].hour;
    let hc = h;
    if (h1 <= h0) {
      h1 += 24;
      if (hc < h0) hc += 24;
    }
    const span = Math.max(0.0001, h1 - h0);
    let t = clamp((hc - h0) / span, 0, 1);
    if (samples[i1].interp === 'EASE_QUARTIC_INOUT') {
      t = easeQuarticInOut(t);
    }
    return lerp(values[i0], values[i1], t);
  }

  /** Sample a modifier's season_adjusted_time curve (t in 0..1 across 24h). */
  private sampleAxisCurve(ts: number[], vs: number[], t01: number): number {
    if (ts.length === 0 || vs.length === 0) return 0;
    if (t01 <= ts[0]) return vs[0];
    if (t01 >= ts[ts.length - 1]) return vs[vs.length - 1];
    for (let i = 0; i < ts.length - 1; i++) {
      if (t01 >= ts[i] && t01 <= ts[i + 1]) {
        const span = Math.max(1e-5, ts[i + 1] - ts[i]);
        return lerp(vs[i], vs[i + 1], (t01 - ts[i]) / span);
      }
    }
    return vs[vs.length - 1];
  }

  /** Resolve all active W_MOD_* modifiers and their recursive submodifiers. */
  private resolveModifiers(entry: WeatherTypeEntry, hour: number): {
    names: string[];
    values: Record<string, number>;
  } {
    const queue: string[] = [];
    for (const m of Object.values(entry.mods)) {
      if (m) queue.push(m);
    }
    const visited = new Set<string>();
    const names: string[] = [];
    const values: Record<string, number> = {};
    const t01 = (((hour % 24) + 24) % 24) / 24.0;

    while (queue.length > 0) {
      const rawName = queue.shift()!;
      const key = rawName.toLowerCase();
      if (visited.has(key)) continue;
      visited.add(key);
      const mod = this.modMap.get(key);
      if (!mod) continue;
      names.push(rawName);
      for (const sub of mod.submodifiers) {
        if (!visited.has(sub.toLowerCase())) queue.push(sub);
      }
      for (const [param, pair] of Object.entries(mod.scalars)) {
        if (pair.length > 0) values[param] = pair[0];
      }
      for (const [param, [, , min, max]] of Object.entries(mod.gradients ?? {})) {
        // Constant gradients need no knowledge of the original spatial control value.
        if (min === max) values[param] = min;
      }
      for (const axis of Object.values(mod.axes)) {
        for (const [param, curve] of Object.entries(axis.curves)) {
          values[param] = this.sampleAxisCurve(axis.t, curve, t01);
        }
      }
    }
    return { names, values };
  }

  /** Evaluate a weather preset at any hour of the day. */
  evaluateWeatherAtTime(weatherName: string, hour: number): EvaluatedSnapshot {
    const entry =
      this.weatherMap.get(weatherName.toLowerCase()) ?? this.dataset.weatherTypes[0];
    const dataKey = (entry.dataName || entry.name).toLowerCase();
    const wtd: WeatherTypeData =
      this.dataMap.get(dataKey) ?? this.dataMap.get('sunny') ?? { Name: entry.name };
    const tcRegions =
      this.tcMap.get(dataKey) ?? this.tcMap.get('sunny') ?? Object.values(this.dataset.timecycles)[0];
    const regional = tcRegions?.[this.timecycleRegion];

    const { names: activeMods, values: modVals } = this.resolveModifiers(entry, hour);

    const tc = (key: string, fb: number): number => {
      if (modVals[key] !== undefined) return modVals[key];
      return this.sampleTimecycle(regional?.[key] ?? tcRegions?.GLOBAL?.[key], hour, fb);
    };

    const nameUpper = entry.name.toUpperCase();
    const dataUpper = (entry.dataName || '').toUpperCase();
    const precipMod = (entry.mods.precipitation || '').toUpperCase();
    const windMod = (entry.mods.wind || '').toUpperCase();
    const atmosMod = (entry.mods.atmosphere || '').toUpperCase();
    const tempMod = (entry.mods.temperature || '').toUpperCase();
    const humMod = (entry.mods.humidity || '').toUpperCase();
    const fetchMod = (entry.mods.fetch || '').toUpperCase();

    // ---- Cloud coverage derived directly from CloudType + CLOUDSCAPE_* + Rain ----
    const cloudTypeVal = Number(wtd.CloudType ?? 0.05);
    let cloudCoverage = clamp(cloudTypeVal * 2.1, 0.03, 0.98);
    if (dataUpper.includes('CLOUDLESS')) cloudCoverage = 0.05;
    else if (dataUpper.includes('CLEAR')) cloudCoverage = 0.18;
    else if (dataUpper.includes('SCATTERED')) cloudCoverage = 0.44;
    else if (dataUpper.includes('THINLAYER')) cloudCoverage = 0.56;
    else if (dataUpper.includes('THICKLAYER') || dataUpper.includes('OVERCAST')) cloudCoverage = 0.78;
    else if (dataUpper.includes('MIXED_HEAVY')) cloudCoverage = 0.86;
    else if (dataUpper.includes('MIXED')) cloudCoverage = 0.64;
    else if (dataUpper.includes('TROPICAL_STORM')) cloudCoverage = 0.93;
    else if (dataUpper.includes('HURRICANE')) cloudCoverage = 0.98;
    else if (dataUpper === 'HIGHPRESSURE') cloudCoverage = 0.04;
    else if (dataUpper === 'SUNNY') cloudCoverage = 0.16;
    else if (dataUpper === 'CLOUDS') cloudCoverage = 0.55;
    else if (dataUpper === 'OVERCASTDARK') cloudCoverage = 0.88;
    else if (dataUpper === 'THUNDER' || dataUpper === 'THUNDERSTORM') cloudCoverage = 0.94;
    else if (dataUpper === 'RAIN' || dataUpper === 'DRIZZLE') cloudCoverage = 0.84;
    else if (dataUpper === 'SANDSTORM') cloudCoverage = 0.45;

    // ---- Rain / Precipitation (base WEATHER.XML + W_MOD_precip_*) ----
    let rainIntensity = Number(wtd.Rain ?? 0);
    if (modVals['gpu_fx_density'] !== undefined && precipMod && !precipMod.endsWith('_0')) {
      const heavy = modVals['gpu_fx_heaviness'] ?? 0.5;
      rainIntensity = Math.max(rainIntensity, clamp(modVals['gpu_fx_density'] * (0.45 + 0.55 * heavy), 0, 1));
    } else if (precipMod.includes('HEAVYRAIN')) {
      rainIntensity = Math.max(rainIntensity, 0.92);
    } else if (precipMod.includes('RAIN')) {
      rainIntensity = Math.max(rainIntensity, 0.65);
    } else if (precipMod.includes('DRIZZLE')) {
      rainIntensity = Math.max(rainIntensity, 0.3);
    }
    if (nameUpper.includes('HURRICANE') || nameUpper.includes('TROPICAL_STORM')) {
      rainIntensity = Math.max(rainIntensity, 0.88);
    }
    if (rainIntensity > 0.25) {
      cloudCoverage = Math.max(cloudCoverage, 0.72 + rainIntensity * 0.24);
    }

    const hailIntensity = nameUpper.includes('HAIL') ? 0.85 : 0.0;
    const sandstormIntensity = Boolean(wtd.Sandstorm) || nameUpper.includes('SANDSTORM') ? 1.0 : 0.0;

    // ---- Fog & Haze (base Fog + W_MOD_atmos_* + aerosol) ----
    const fogDensity = clamp(Math.max(
      Number(wtd.Fog ?? 0) * 0.85,
      tc('local_atmosphere_fog_density', 0) * 65.0,
      modVals.Fog ?? modVals.gradient ?? 0,
    ), 0, 1);
    const aerosolDensity = tc('sky_scattering_aerosol_density_scale', 0.25);
    const hazeStrength = clamp(
      (aerosolDensity - 0.1) * 0.28 +
        (atmosMod.includes('VHAZY') ? 0.45 : atmosMod.includes('HAZY') || atmosMod.includes('SMOG') ? 0.28 : 0) +
        sandstormIntensity * 0.75 +
        rainIntensity * 0.28,
      0,
      1,
    );

    // ---- Wind & Gusts (WEATHER.XML + W_MOD_wind_*) ----
    let windMin = Number(wtd.WindMin ?? 1.5);
    let windMax = Number(wtd.WindMax ?? 3.0);
    let gustMin = Number(wtd.WindGustsSpeedMin ?? 5.0);
    let gustMax = Number(wtd.WindGustsSpeedMax ?? 10.0);
    let gustChance = Number(wtd.WindGustsChance ?? 40.0);
    let gustDurMin = Number(wtd.WindGustsDurationMin ?? 4.0);
    let gustDurMax = Number(wtd.WindGustsDurationMax ?? 10.0);

    // W_MOD_wind_* stores km/h -> convert to m/s (/ 3.6)
    if (modVals['wind_gust_speed_min_kmh'] !== undefined) {
      gustMin = modVals['wind_gust_speed_min_kmh'] / 3.6;
    }
    if (modVals['wind_gust_speed_max_kmh'] !== undefined) {
      gustMax = modVals['wind_gust_speed_max_kmh'] / 3.6;
    }
    if (modVals['wind_gust_duration_min'] !== undefined) gustDurMin = modVals['wind_gust_duration_min'];
    if (modVals['wind_gust_duration_max'] !== undefined) gustDurMax = modVals['wind_gust_duration_max'];
    if (windMod.includes('HURRICANE')) {
      windMin = Math.max(windMin, 24);
      windMax = Math.max(windMax, 33);
      gustChance = 100;
    } else if (windMod.includes('STORM')) {
      windMin = Math.max(windMin, 14);
      windMax = Math.max(windMax, 21);
      gustChance = 95;
    } else if (windMod.includes('STRONGGUSTY') || windMod.includes('STRONG')) {
      windMin = Math.max(windMin, 9);
      windMax = Math.max(windMax, 14);
      gustChance = 80;
    } else if (windMod.includes('MID')) {
      windMin = Math.max(windMin, 4.5);
      windMax = Math.max(windMax, 7.5);
    } else if (windMod.includes('CALM')) {
      windMin = 0.6;
      windMax = 1.4;
    }
    const windSpeedMult = tc('wind_speed_mult', 1.0);
    const windBaseSpeed = ((windMin + windMax) * 0.5) * windSpeedMult;
    const windAngleDeg = Number(wtd.WindAngle ?? 135);

    // ---- Ocean Fetch & Waves (WEATHER.XML + W_MOD_fetch_*) ----
    let oceanFetch = modVals['water_ocean_fetch'] ?? 220;
    if (modVals['water_ocean_fetch'] === undefined) {
      if (fetchMod.includes('VHIGH')) oceanFetch = 800;
      else if (fetchMod.includes('HIGH')) oceanFetch = 550;
      else if (fetchMod.includes('MID')) oceanFetch = 320;
      else if (fetchMod.includes('VLOW')) oceanFetch = 80;
      else if (fetchMod.includes('LOW')) oceanFetch = 150;
    }
    if (nameUpper.includes('HURRICANE')) oceanFetch = Math.max(oceanFetch, 900);
    else if (nameUpper.includes('TROPICAL_STORM') || nameUpper.includes('THUNDERSTORM')) {
      oceanFetch = Math.max(oceanFetch, 650);
    }

    const fetchFactor = clamp(oceanFetch / 500, 0.25, 2.0);
    const windWaveBoost = clamp(windBaseSpeed / 14, 0.2, 2.2);
    const baseWaveAmp = Number(wtd.OceanWaveAmplitude ?? 2.5);
    const maxWaveAmp = Number(wtd.OceanWaveMaxAmplitude ?? 14.5);
    const oceanWaveAmplitude = clamp(
      lerp(0.35, Math.min(maxWaveAmp * 0.45, 5.2), clamp((windWaveBoost * 0.6 + fetchFactor * 0.4) * 0.55, 0, 1)) *
        (baseWaveAmp / 3.0),
      0.22,
      6.5,
    );
    const shoreWaveAmplitude = clamp(
      Number(wtd.ShoreWaveAmplitude ?? 1.5) * clamp(0.35 + windWaveBoost * 0.45, 0.3, 1.8),
      0.25,
      3.5,
    );
    const oceanFoamIntensity =
      Number(wtd.OceanFoamIntensity ?? 0.14) *
      tc('water_foam_intensity_mult', 1.0) *
      (0.7 + windWaveBoost * 0.9);

    // ---- Storm Darkness & Lightning Probability ----
    const isStorm =
      nameUpper.includes('THUNDER') ||
      nameUpper.includes('HURRICANE') ||
      nameUpper.includes('TROPICAL_STORM');
    const isHeavyStorm = nameUpper.includes('HURRICANE') || nameUpper.includes('THUNDERSTORM') || nameUpper.includes('THUNDER_STORM') || nameUpper.includes('TROPICAL_STORM');
    const cloudStormDarkness = clamp(
      (1.0 - Number(wtd.Sun ?? 0.5)) * 0.55 +
        rainIntensity * 0.45 +
        (isHeavyStorm ? 0.35 : isStorm ? 0.22 : 0),
      0,
      1,
    );
    const lightningChance = isHeavyStorm ? 0.95 : isStorm ? 0.55 : rainIntensity > 0.75 ? 0.2 : 0.0;

    // ---- Temperature & Humidity (Real W_MOD_temperature_* diurnal curves!) ----
    let temperatureC = modVals['temperature_target'];
    if (temperatureC === undefined || temperatureC === 0) {
      // subtropical diurnal curve (subtropical baseline)
      const diurnal = Math.sin(((hour - 9) / 24) * Math.PI * 2); // peak ~15:00, low ~03:00
      let baseT = 27.5;
      if (tempMod.includes('VERYHOT')) baseT = 32.5;
      else if (tempMod.includes('HOT')) baseT = 30.5;
      else if (tempMod.includes('MIDWARM') || tempMod.includes('WARM')) baseT = 28.5;
      else if (tempMod.includes('MIDCOOL')) baseT = 22.0;
      else if (tempMod.includes('COOL')) baseT = 18.5;
      else if (tempMod.includes('COLD')) baseT = 13.5;
      else if (nameUpper.includes('HURRICANE')) baseT = 25.5;
      else if (nameUpper.includes('HAIL')) baseT = 16.0;
      else if (nameUpper.includes('SANDSTORM')) baseT = 34.0;
      temperatureC = baseT + diurnal * 3.8 - rainIntensity * 2.5;
    }

    let humidityPct = 62;
    if (humMod.includes('VERYHIGH')) humidityPct = 94;
    else if (humMod.includes('MIDHIGH')) humidityPct = 82;
    else if (humMod.includes('HIGH')) humidityPct = 88;
    else if (humMod.includes('LOW')) humidityPct = 42;
    else if (rainIntensity > 0.1) humidityPct = clamp(74 + rainIntensity * 24, 70, 99);
    else if (fogDensity > 0.3) humidityPct = 92;
    else if (sandstormIntensity > 0.5) humidityPct = 22;

    const pressureHpa = nameUpper.includes('HURRICANE')
      ? 956
      : nameUpper.includes('TROPICAL_STORM')
        ? 984
        : isStorm
          ? 998
          : nameUpper.includes('HIGHPRESSURE')
            ? 1026
            : 1014 - rainIntensity * 14;

    // ---- Phone App Display ----
    const appData =
      this.dataset.weatherAppTypes[entry.weatherAppDataName] ??
      this.dataset.weatherAppTypes[
        nameUpper.includes('HURRICANE')
          ? 'Hurricane'
          : isStorm
            ? 'Thunderstorm'
            : rainIntensity > 0.5
              ? 'HeavyRain'
              : rainIntensity > 0.1
                ? 'Rain'
                : fogDensity > 0.4
                  ? 'Fog'
                  : 'Sunny'
      ];
    const rawDesc =
      (appData && this.dataset.weatherLabels[appData.descriptionKey]) ||
      entry.name.replace(/^AM_/, '').replace(/_/g, ' ');
    const appDescription = rawDesc
      .replace(/Scatteredclouds/gi, 'Scattered Clouds')
      .replace(/Partlycloudy/gi, 'Partly Cloudy')
      .replace(/Mostlycloudy/gi, 'Mostly Cloudy')
      .replace(/Mostlyclear/gi, 'Mostly Clear')
      .replace(/Highpressure/gi, 'High Pressure')
      .replace(/Overcastbright/gi, 'Bright Overcast')
      .replace(/Overcastdark/gi, 'Dark Overcast')
      .replace(/Overcastlight/gi, 'Light Overcast')
      .replace(/Veryfoggy/gi, 'Dense Fog')
      .replace(/Veryhaze/gi, 'Heavy Haze')
      .replace(/Patchymist/gi, 'Patchy Mist')
      .replace(/Heavyshower/gi, 'Heavy Shower')
      .replace(/Heavyrain/gi, 'Heavy Rain')
      .replace(/Tropicalstorm/gi, 'Tropical Storm')
      .replace(/Thunderlightning/gi, 'Thunder & Lightning');

    return {
      dataName: entry.dataName || entry.name,
      appTypeName: appData?.name ?? entry.name,
      appDescription,
      appIcon: appData?.icon ?? 'WEATHER_ICON_SUN_CLEAR',
      activeMods,
      wavelengthRGB: [
        tc('sky_scattering_red_wavelength', 680),
        tc('sky_scattering_green_wavelength', 550),
        tc('sky_scattering_blue_wavelength', 440),
      ],
      rayScatteringCol: [
        modVals['sky_new_ray_scattering_col_r'] ?? 0.22,
        modVals['sky_new_ray_scattering_col_g'] ?? 0.48,
        modVals['sky_new_ray_scattering_col_b'] ?? 0.98,
      ],
      aerosolDensity,
      ozoneConcentration: tc('sky_scattering_ozone_concentration', 0.12),
      mieEccentricity: modVals['sky_new_mie_phase_eccentricity'] ?? 0.78,
      skyCol: [
        tc('sky_scattering_sky_col_r', 1.0),
        tc('sky_scattering_sky_col_g', 1.0),
        tc('sky_scattering_sky_col_b', 1.0),
      ],
      sunCol: [
        tc('sky_scattering_sun_col_r', 1.0),
        tc('sky_scattering_sun_col_g', 0.96),
        tc('sky_scattering_sun_col_b', 0.9),
      ],
      sunIntensity: tc('sky_scattering_sun_intensity_multiplier', 1.0),
      sunDiskMult: tc('sky_scattering_sun_disk_intensity_multiplier', 256.0),
      sunDiscSize: tc('sky_scattering_disk_radius', 2.0) * 0.5,
      moonCol: [
        tc('sky_moon_col_r', 0.8),
        tc('sky_moon_col_g', 0.88),
        tc('sky_moon_col_b', 1.0),
      ],
      moonIntensity: tc('sky_moon_iten', 10.0),
      starsIntensity: tc('sky_stars_iten', 0.01),
      airGlowCol: [
        tc('sky_air_glow_color_r', 0.184),
        tc('sky_air_glow_color_g', 1.0),
        tc('sky_air_glow_color_b', 0.494),
      ],
      airGlowIntensity: tc('sky_air_glow_intensity', 0.2),
      lightDirCol: [
        tc('light_dir_col_r', 1.0),
        tc('light_dir_col_g', 1.0),
        tc('light_dir_col_b', 1.0),
      ],
      lightDirMult: tc('light_dir_mult', 1.0),
      ambientSkyCol: [
        tc('ambient_sky_color_mult_r', 1.0),
        tc('ambient_sky_color_mult_g', 1.0),
        tc('ambient_sky_color_mult_b', 1.0),
      ],
      ambientSkyIntensity: tc('ambient_sky_intensity', 0.5),
      cloudMapNames: [(wtd.CloudMapA ?? '').toLowerCase(), (wtd.CloudMapB ?? '').toLowerCase()],
      cloudCoverage,
      cloudDensity: 0.45 + cloudCoverage * 0.85,
      cloudBaseHeight: tc('local_atmosphere_cloud_height', 200),
      cloudTopHeight: tc('local_atmosphere_cloud_height_top', 1500),
      cirrusDensity: clamp(tc('local_atmosphere_cloud_cirrus_density_x', 0.6), 0, 3.0),
      cirrusHeight: tc('local_atmosphere_cloud_cirrus_height', 8000),
      cloudWindScale: tc('local_atmosphere_cloud_wind_velocity_scale', 0.5),
      cloudWindShear: tc('local_atmosphere_cloud_wind_shear', 0),
      cloudShadowAlpha: clamp(tc('local_atmosphere_cloud_shadow_alpha', 0.8), 0, 1),
      cloudMultiScatter: clamp(tc('local_atmosphere_cloud_multi_scatter_radiance_scale', 1), 0, 3),
      cirrostratusDensity: clamp(tc('local_atmosphere_cloud_cirrostratus_density', 0.4), 0, 2.0),
      cloudAnisotropy: clamp(tc('local_atmosphere_anisotropy_high_density', 0.8), 0.2, 0.95),
      cloudPowderExp: clamp(tc('local_atmosphere_powder_exponent', 1.0), 0.2, 4.0),
      cloudStormDarkness,
      fogDensity,
      fogHeight: tc('local_atmosphere_fog_height', 0),
      fogFalloff: (modVals.Fog !== undefined || modVals.gradient !== undefined)
        ? (atmosMod.includes('SEAFOG') ? 22 : 65)
        : tc('local_atmosphere_fog_falloff', 80),
      hazeStrength,
      rainIntensity,
      hailIntensity,
      sandstormIntensity,
      puddleRippleScale: Number(wtd.PuddleRippleMaxSizeModifier ?? 1.0),
      windBaseSpeed,
      windAngleDeg,
      windGustChance: gustChance,
      windGustSpeedMin: gustMin,
      windGustSpeedMax: gustMax,
      windGustDurMin: gustDurMin,
      windGustDurMax: gustDurMax,
      windGustFadeIn: Number(wtd.WindGustsFadeInRatioMax ?? 0.25),
      windGustFadeOut: Number(wtd.WindGustsFadeOutRatioMin ?? 0.65),
      oceanFetch,
      oceanWaveAmplitude,
      oceanWaveMaxAmplitude: maxWaveAmp,
      shoreWaveAmplitude,
      oceanFoamIntensity,
      rippleBumpiness: Number(wtd.RippleBumpiness ?? 1.0),
      waterGustMaxBump: Number(wtd.Water_WindGusts_MaxBumpIntensity ?? 0.3),
      filmicCurve: ['a', 'b', 'c', 'd', 'e', 'f', 'w'].map((key, i) =>
        tc(`postfx_tonemap_filmic_${key}`, [0.1, 0.4, 0.1, 0.2, 0.01, 0.3, 4][i])),
      temperatureC,
      humidityPct,
      pressureHpa,
      niceness: Number(wtd.Niceness ?? 5.0),
      lightningChance,
      lightningTempMin: tc('vfx_lightning_temperature_min', 20000),
      lightningTempMax: tc('vfx_lightning_temperature_max', 40000),
    };
  }

  private blendSnapshots(a: EvaluatedSnapshot, b: EvaluatedSnapshot, t: number): EvaluatedSnapshot {
    const s = t * t * (3 - 2 * t);
    const pick = s >= 0.5 ? b : a;
    return {
      ...pick,
      wavelengthRGB: lerp3(a.wavelengthRGB, b.wavelengthRGB, s),
      rayScatteringCol: lerp3(a.rayScatteringCol, b.rayScatteringCol, s),
      aerosolDensity: lerp(a.aerosolDensity, b.aerosolDensity, s),
      ozoneConcentration: lerp(a.ozoneConcentration, b.ozoneConcentration, s),
      mieEccentricity: lerp(a.mieEccentricity, b.mieEccentricity, s),
      skyCol: lerp3(a.skyCol, b.skyCol, s),
      sunCol: lerp3(a.sunCol, b.sunCol, s),
      sunIntensity: lerp(a.sunIntensity, b.sunIntensity, s),
      sunDiskMult: lerp(a.sunDiskMult, b.sunDiskMult, s),
      sunDiscSize: lerp(a.sunDiscSize, b.sunDiscSize, s),
      moonCol: lerp3(a.moonCol, b.moonCol, s),
      moonIntensity: lerp(a.moonIntensity, b.moonIntensity, s),
      starsIntensity: lerp(a.starsIntensity, b.starsIntensity, s),
      airGlowCol: lerp3(a.airGlowCol, b.airGlowCol, s),
      airGlowIntensity: lerp(a.airGlowIntensity, b.airGlowIntensity, s),
      lightDirCol: lerp3(a.lightDirCol, b.lightDirCol, s),
      lightDirMult: lerp(a.lightDirMult, b.lightDirMult, s),
      ambientSkyCol: lerp3(a.ambientSkyCol, b.ambientSkyCol, s),
      ambientSkyIntensity: lerp(a.ambientSkyIntensity, b.ambientSkyIntensity, s),
      cloudCoverage: lerp(a.cloudCoverage, b.cloudCoverage, s),
      cloudDensity: lerp(a.cloudDensity, b.cloudDensity, s),
      cloudBaseHeight: lerp(a.cloudBaseHeight, b.cloudBaseHeight, s),
      cloudTopHeight: lerp(a.cloudTopHeight, b.cloudTopHeight, s),
      cirrusDensity: lerp(a.cirrusDensity, b.cirrusDensity, s),
      cirrusHeight: lerp(a.cirrusHeight, b.cirrusHeight, s),
      cloudWindScale: lerp(a.cloudWindScale, b.cloudWindScale, s),
      cloudWindShear: lerp(a.cloudWindShear, b.cloudWindShear, s),
      cloudShadowAlpha: lerp(a.cloudShadowAlpha, b.cloudShadowAlpha, s),
      cloudMultiScatter: lerp(a.cloudMultiScatter, b.cloudMultiScatter, s),
      cirrostratusDensity: lerp(a.cirrostratusDensity, b.cirrostratusDensity, s),
      cloudAnisotropy: lerp(a.cloudAnisotropy, b.cloudAnisotropy, s),
      cloudPowderExp: lerp(a.cloudPowderExp, b.cloudPowderExp, s),
      cloudStormDarkness: lerp(a.cloudStormDarkness, b.cloudStormDarkness, s),
      fogDensity: lerp(a.fogDensity, b.fogDensity, s),
      fogHeight: lerp(a.fogHeight, b.fogHeight, s),
      fogFalloff: lerp(a.fogFalloff, b.fogFalloff, s),
      hazeStrength: lerp(a.hazeStrength, b.hazeStrength, s),
      rainIntensity: lerp(a.rainIntensity, b.rainIntensity, s),
      hailIntensity: lerp(a.hailIntensity, b.hailIntensity, s),
      sandstormIntensity: lerp(a.sandstormIntensity, b.sandstormIntensity, s),
      puddleRippleScale: lerp(a.puddleRippleScale, b.puddleRippleScale, s),
      windBaseSpeed: lerp(a.windBaseSpeed, b.windBaseSpeed, s),
      windAngleDeg: lerpAngleDeg(a.windAngleDeg, b.windAngleDeg, s),
      windGustChance: lerp(a.windGustChance, b.windGustChance, s),
      windGustSpeedMin: lerp(a.windGustSpeedMin, b.windGustSpeedMin, s),
      windGustSpeedMax: lerp(a.windGustSpeedMax, b.windGustSpeedMax, s),
      windGustDurMin: lerp(a.windGustDurMin, b.windGustDurMin, s),
      windGustDurMax: lerp(a.windGustDurMax, b.windGustDurMax, s),
      windGustFadeIn: lerp(a.windGustFadeIn, b.windGustFadeIn, s),
      windGustFadeOut: lerp(a.windGustFadeOut, b.windGustFadeOut, s),
      oceanFetch: lerp(a.oceanFetch, b.oceanFetch, s),
      oceanWaveAmplitude: lerp(a.oceanWaveAmplitude, b.oceanWaveAmplitude, s),
      oceanWaveMaxAmplitude: lerp(a.oceanWaveMaxAmplitude, b.oceanWaveMaxAmplitude, s),
      shoreWaveAmplitude: lerp(a.shoreWaveAmplitude, b.shoreWaveAmplitude, s),
      oceanFoamIntensity: lerp(a.oceanFoamIntensity, b.oceanFoamIntensity, s),
      rippleBumpiness: lerp(a.rippleBumpiness, b.rippleBumpiness, s),
      waterGustMaxBump: lerp(a.waterGustMaxBump, b.waterGustMaxBump, s),
      filmicCurve: a.filmicCurve.map((v, i) => lerp(v, b.filmicCurve[i], s)),
      temperatureC: lerp(a.temperatureC, b.temperatureC, s),
      humidityPct: lerp(a.humidityPct, b.humidityPct, s),
      pressureHpa: lerp(a.pressureHpa, b.pressureHpa, s),
      niceness: lerp(a.niceness, b.niceness, s),
      lightningChance: lerp(a.lightningChance, b.lightningChance, s),
      lightningTempMin: lerp(a.lightningTempMin, b.lightningTempMin, s),
      lightningTempMax: lerp(a.lightningTempMax, b.lightningTempMax, s),
    };
  }

  private spawnLightning(
    snap: EvaluatedSnapshot,
    camPos?: [number, number, number],
    camYaw?: number,
  ): void {
    const kelvin = lerp(snap.lightningTempMin, snap.lightningTempMax, Math.random());
    const baseYaw = camYaw ?? 0;
    const angle = baseYaw + (Math.random() - 0.5) * 0.75;
    const dist = 320 + Math.random() * 440;
    const cx = camPos ? camPos[0] : 0;
    const cz = camPos ? camPos[2] : 0;
    this.lightning = {
      active: true,
      age: 0,
      duration: 0.42 + Math.random() * 0.25,
      flashIntensity: 1.0,
      worldX: cx + Math.sin(angle) * dist,
      worldZ: cz - Math.cos(angle) * dist,
      seed: Math.random() * 1000,
      colorRGB: kelvinToRGB(kelvin),
      kelvin,
      distanceMeters: dist,
    };
    this.onThunderCallback?.(dist, 0.65 + Math.random() * 0.35);
  }

  step(dtRaw: number, camPos?: [number, number, number], camYaw?: number): WeatherRuntimeState {
    const dt = clamp(dtRaw, 0, 0.1);

    // 1. Advance 24h game clock
    if (!this.paused) {
      this.timeOfDayHours = (this.timeOfDayHours + (dt * this.timeSpeed) / 3600) % 24;
    }

    // 2. Advance weather cross-fade
    if (this.transitionProgress < 1.0) {
      this.transitionProgress = Math.min(
        1.0,
        this.transitionProgress + dt / Math.max(0.5, this.transitionDurationSec),
      );
      if (this.transitionProgress >= 1.0) {
        this.currentWeatherName = this.targetWeatherName;
        this.transitionFromSnapshot = null;
      }
    }

    // 3. Auto-cycle Weather Director
    if (this.autoCycle && this.transitionProgress >= 1.0) {
      this.autoCycleTimer += dt;
      if (this.autoCycleTimer >= this.autoCycleHoldSec) {
        this.autoCycleTimer = 0;
        this.autoCycleIndex = (this.autoCycleIndex + 1) % this.autoCycleNames.length;
        this.setWeather(this.autoCycleNames[this.autoCycleIndex], false);
      }
    }

    // 4. Evaluate current & target snapshots at exact time of day
    const snapB = this.evaluateWeatherAtTime(this.targetWeatherName, this.timeOfDayHours);
    const snapA =
      this.transitionProgress >= 1.0
        ? snapB
        : this.transitionFromSnapshot ??
          (this.currentWeatherName === this.targetWeatherName
            ? snapB
            : this.evaluateWeatherAtTime(this.currentWeatherName, this.timeOfDayHours));
    const snap =
      this.transitionProgress >= 1.0
        ? snapB
        : this.blendSnapshots(snapA, snapB, this.transitionProgress);

    // 5. Subtropical Sun & Moon astronomy (~25.8°N subtropical latitude)
    const sunAngle = ((this.timeOfDayHours - 6.0) / 24.0) * Math.PI * 2.0; // 6am rise, 12pm zenith, 18pm set
    const latTilt = 0.34; // ~20° southward arc in northern hemisphere
    const sx = Math.cos(sunAngle);
    const sy = Math.sin(sunAngle) * Math.cos(latTilt);
    const sz = -Math.sin(sunAngle) * Math.sin(latTilt) - 0.25 * Math.cos(sunAngle);
    const slen = Math.hypot(sx, sy, sz) || 1;
    const sunDir: [number, number, number] = [sx / slen, sy / slen, sz / slen];

    // Moon trails ~11.5 hours behind sun with slight orbital offset
    const moonAngle = sunAngle + Math.PI * 0.94;
    const mx = Math.cos(moonAngle);
    const my = Math.sin(moonAngle) * 0.86;
    const mz = -Math.sin(moonAngle) * 0.32 + 0.18;
    const mlen = Math.hypot(mx, my, mz) || 1;
    const moonDir: [number, number, number] = [mx / mlen, my / mlen, mz / mlen];

    // 6. Real Wind Gust State Machine (WEATHER.XML WindGusts*)
    let gustEnvelope = 0;
    if (this.gustActive) {
      this.gustAge += dt;
      const u = this.gustAge / Math.max(0.5, this.gustDuration);
      if (u >= 1.0) {
        this.gustActive = false;
        this.gustCooldown = lerp(1.5, 7.0, 1.0 - clamp(snap.windGustChance / 100, 0, 1));
      } else if (u < this.gustFadeIn) {
        gustEnvelope = u / Math.max(0.05, this.gustFadeIn);
      } else if (u > this.gustFadeOut) {
        gustEnvelope = 1.0 - (u - this.gustFadeOut) / Math.max(0.05, 1.0 - this.gustFadeOut);
      } else {
        gustEnvelope = 1.0;
      }
      gustEnvelope = clamp(gustEnvelope, 0, 1);
    } else {
      this.gustCooldown -= dt;
      if (this.gustCooldown <= 0) {
        if (Math.random() * 100 < snap.windGustChance) {
          this.gustActive = true;
          this.gustAge = 0;
          this.gustDuration = lerp(snap.windGustDurMin, snap.windGustDurMax, Math.random());
          this.gustTargetSpeed = lerp(snap.windGustSpeedMin, snap.windGustSpeedMax, Math.random());
          this.gustFadeIn = clamp(snap.windGustFadeIn, 0.08, 0.35);
          this.gustFadeOut = clamp(snap.windGustFadeOut, 0.55, 0.9);
        } else {
          this.gustCooldown = 2.0 + Math.random() * 3.0;
        }
      }
    }
    const windGustSpeed = this.gustActive ? this.gustTargetSpeed * gustEnvelope : 0;
    const windTotalSpeed = snap.windBaseSpeed + windGustSpeed;
    const windRad = (snap.windAngleDeg * Math.PI) / 180;
    const windDirXZ: [number, number] = [Math.cos(windRad), Math.sin(windRad)];

    // 7. Surface wetness accumulation & solar drying
    if (snap.rainIntensity > 0.02 || snap.hailIntensity > 0.02) {
      const rate = (snap.rainIntensity + snap.hailIntensity * 0.5) * 0.14;
      this.wetness = clamp(this.wetness + rate * dt, 0, 1);
    } else {
      const dryRate = 0.025 + Math.max(0, sunDir[1]) * 0.05 + windTotalSpeed * 0.002;
      this.wetness = clamp(this.wetness - dryRate * dt, 0, 1);
    }

    // 8. Lightning Generator (real 20,000K-40,000K double-flicker storm bolts)
    if (this.lightning.active) {
      this.lightning.age += dt;
      const u = this.lightning.age / this.lightning.duration;
      if (u >= 1.0) {
        this.lightning.active = false;
        this.lightning.flashIntensity = 0;
      } else {
        // Authentic multi-return-stroke flicker envelope
        const primary = Math.exp(-u * 6.5);
        const restrike = Math.exp(-Math.pow((u - 0.34) * 14, 2)) * 0.85;
        const tail = Math.exp(-Math.pow((u - 0.62) * 16, 2)) * 0.4;
        this.lightning.flashIntensity = clamp(primary + restrike + tail, 0, 1.2);
      }
    } else if (snap.lightningChance > 0.05) {
      this.lightningCooldown -= dt;
      if (this.lightningCooldown <= 0) {
        this.spawnLightning(snap, camPos, camYaw);
        const baseWait = lerp(12.0, 2.8, snap.lightningChance);
        this.lightningCooldown = baseWait * (0.55 + Math.random() * 0.95);
      }
    }

    // 9. Rainbow condition (low-to-mid sun + active rain or lingering wetness after shower)
    const rainbowStrength =
      sunDir[1] > 0.04 && sunDir[1] < 0.62 && snap.rainIntensity > 0.08 && snap.cloudStormDarkness < 0.72
        ? clamp(snap.rainIntensity * 1.6 * (1.0 - Math.abs(sunDir[1] - 0.26) / 0.38), 0, 0.85)
        : 0.0;

    // 10. Auto-exposure balance (smoothly adapts day/twilight/night so stars & city are clearly visible)
    const dayFactor = clamp((sunDir[1] + 0.08) / 0.32, 0, 1);
    const stormBoost = snap.cloudStormDarkness * 0.25;
    const exposure = lerp(1.65, 1.05, dayFactor) + stormBoost;
    // Ramp the band envelopes by concurrent wind and fetch.
    const ocean = this.dataset.oceanPresets.presets[0];
    const fetchT = clamp(snap.oceanFetch / 800, 0, 1);
    const oceanBandWeights = [0, 1, 2].map((i) => {
      const points = ocean?.octaves[i];
      return points?.length
        ? this.sampleAxisCurve(points.map((p) => p[0]), points.map((p) => p[1]), fetchT)
        : 1;
    });

    return {
      currentWeatherName: this.currentWeatherName,
      targetWeatherName: this.targetWeatherName,
      transitionProgress: this.transitionProgress,
      dataName: snap.dataName,
      appTypeName: snap.appTypeName,
      appDescription: snap.appDescription,
      appIcon: snap.appIcon,
      activeMods: snap.activeMods,
      timeOfDayHours: this.timeOfDayHours,
      sunDir,
      moonDir,
      sunElevation: sunDir[1],
      isNight: sunDir[1] < -0.02,
      wavelengthRGB: snap.wavelengthRGB,
      rayScatteringCol: snap.rayScatteringCol,
      aerosolDensity: snap.aerosolDensity,
      ozoneConcentration: snap.ozoneConcentration,
      mieEccentricity: snap.mieEccentricity,
      skyCol: snap.skyCol,
      sunCol: snap.sunCol,
      sunIntensity: snap.sunIntensity,
      sunDiskMult: snap.sunDiskMult,
      sunDiscSize: snap.sunDiscSize,
      moonCol: snap.moonCol,
      moonIntensity: snap.moonIntensity,
      starsIntensity: snap.starsIntensity,
      airGlowCol: snap.airGlowCol,
      airGlowIntensity: snap.airGlowIntensity,
      lightDirCol: snap.lightDirCol,
      lightDirMult: snap.lightDirMult,
      ambientSkyCol: snap.ambientSkyCol,
      ambientSkyIntensity: snap.ambientSkyIntensity,
      cloudMapsFrom: snapA.cloudMapNames,
      cloudMapsTo: snapB.cloudMapNames,
      cloudMapBlend: this.transitionProgress ** 2 * (3 - 2 * this.transitionProgress),
      cloudCoverage: snap.cloudCoverage,
      cloudDensity: snap.cloudDensity,
      cloudBaseHeight: snap.cloudBaseHeight,
      cloudTopHeight: snap.cloudTopHeight,
      cirrusDensity: snap.cirrusDensity,
      cirrusHeight: snap.cirrusHeight,
      cloudWindScale: snap.cloudWindScale,
      cloudWindShear: snap.cloudWindShear,
      cloudShadowAlpha: snap.cloudShadowAlpha,
      cloudMultiScatter: snap.cloudMultiScatter,
      cirrostratusDensity: snap.cirrostratusDensity,
      cloudAnisotropy: snap.cloudAnisotropy,
      cloudPowderExp: snap.cloudPowderExp,
      cloudStormDarkness: snap.cloudStormDarkness,
      fogDensity: snap.fogDensity,
      fogHeight: snap.fogHeight,
      fogFalloff: snap.fogFalloff,
      hazeStrength: snap.hazeStrength,
      rainIntensity: snap.rainIntensity,
      hailIntensity: snap.hailIntensity,
      sandstormIntensity: snap.sandstormIntensity,
      wetness: this.wetness,
      puddleRippleScale: snap.puddleRippleScale,
      rainbowStrength,
      windBaseSpeed: snap.windBaseSpeed,
      windGustSpeed,
      windTotalSpeed,
      windAngleDeg: snap.windAngleDeg,
      windDirXZ,
      gustActive: this.gustActive,
      gustEnvelope,
      oceanFetch: snap.oceanFetch,
      oceanWaveAmplitude: snap.oceanWaveAmplitude,
      oceanWaveMaxAmplitude: snap.oceanWaveMaxAmplitude,
      shoreWaveAmplitude: snap.shoreWaveAmplitude,
      oceanFoamIntensity: snap.oceanFoamIntensity,
      rippleBumpiness: snap.rippleBumpiness,
      waterGustBump: snap.waterGustMaxBump * gustEnvelope,
      temperatureC: snap.temperatureC,
      humidityPct: snap.humidityPct,
      pressureHpa: snap.pressureHpa,
      niceness: snap.niceness,
      lightning: { ...this.lightning },
      lightningTempMin: snap.lightningTempMin,
      lightningTempMax: snap.lightningTempMax,
      exposure,
      filmicCurve: snap.filmicCurve,
      oceanBandWeights,
    };
  }

  /** Build the simulated forecast for the weather panel. */
  getHourlyForecast(hoursAhead = 6): {
    hour: number;
    tempC: number;
    rainPct: number;
    icon: string;
  }[] {
    const out = [];
    const baseHour = Math.floor(this.timeOfDayHours);
    for (let i = 0; i < hoursAhead; i++) {
      const h = (baseHour + i) % 24;
      const wName = this.autoCycle
        ? this.autoCycleNames[(this.autoCycleIndex + Math.floor(i / 2)) % this.autoCycleNames.length]
        : this.targetWeatherName;
      const snap = this.evaluateWeatherAtTime(wName, h + 0.5);
      out.push({
        hour: h,
        tempC: Math.round(snap.temperatureC),
        rainPct: Math.round(clamp(snap.rainIntensity * 100, 0, 100)),
        icon: snap.appIcon,
      });
    }
    return out;
  }
}
