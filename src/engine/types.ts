export interface TimeSample {
  name: string;
  hour: number;
  interp: string;
}

export interface WeatherTypeData {
  Name: string;
  Sun?: number;
  WindMin?: number;
  WindMax?: number;
  WindAngle?: number;
  WindDowndraft?: number;
  WindGustsChance?: number;
  WindGustsSpeedMin?: number;
  WindGustsSpeedMax?: number;
  WindGustsDurationMin?: number;
  WindGustsDurationMax?: number;
  WindGustsFadeInRatioMin?: number;
  WindGustsFadeInRatioMax?: number;
  WindGustsFadeOutRatioMin?: number;
  WindGustsFadeOutRatioMax?: number;
  Rain?: number;
  Snow?: number;
  Fog?: number;
  CloudType?: number;
  CloudMapA?: string;
  CloudMapB?: string;
  MudWashSpeed?: number;
  Sandstorm?: boolean;
  IsNice?: boolean;
  Niceness?: number;
  IsBlizzard?: boolean;
  RippleBumpiness?: number;
  RippleMinBumpiness?: number;
  RippleMaxBumpiness?: number;
  RippleBumpinessWindScale?: number;
  RippleSpeed?: number;
  OceanBumpiness?: number;
  DeepOceanScale?: number;
  OceanNoiseMinAmplitude?: number;
  OceanWaveAmplitude?: number;
  ShoreWaveAmplitude?: number;
  OceanWaveWindScale?: number;
  ShoreWaveWindScale?: number;
  OceanWaveMinAmplitude?: number;
  ShoreWaveMinAmplitude?: number;
  OceanWaveMaxAmplitude?: number;
  ShoreWaveMaxAmplitude?: number;
  OceanFoamIntensity?: number;
  Water_WindGusts_MinBumpIntensity?: number;
  Water_WindGusts_MaxBumpIntensity?: number;
  Water_WindGusts_MaxGustVel?: number;
  PuddleRippleMinSizeModifier?: number;
  PuddleRippleMaxSizeModifier?: number;
  PuddleRippleMinDurationModifier?: number;
  PuddleRippleMaxDurationModifier?: number;
  [key: string]: number | boolean | string | undefined;
}

export interface WeatherTypeEntry {
  name: string;
  shortName: string;
  dataName: string;
  weatherAppDataName: string;
  mods: {
    atmosphere: string;
    precipitation: string;
    temperature: string;
    humidity: string;
    wind: string;
    fetch: string;
    misc: string;
    niceness: string;
  };
  skipDebugCycling: boolean;
}

export interface WeatherAppTypeData {
  name: string;
  icon: string;
  iconNight: string;
  background: string;
  descriptionKey: string;
}

export interface ModifierAxis {
  t: number[];
  curves: Record<string, number[]>;
}

export interface WeatherModifier {
  submodifiers: string[];
  scalars: Record<string, number[]>;
  axes: Record<string, ModifierAxis>;
  gradients?: Record<string, [number, number, number, number]>;
}

export interface OceanPreset {
  name: string;
  octaves: number[][][];
}

export interface WeatherDataset {
  source: string;
  timeSamples: TimeSample[];
  weatherTypeDatas: Record<string, WeatherTypeData>;
  weatherTypes: WeatherTypeEntry[];
  weatherAppTypes: Record<string, WeatherAppTypeData>;
  weatherCycles: { name: string; timeMult: number }[];
  weatherLabels: Record<string, string>;
  timecycles: Record<string, Record<string, Record<string, number[]>>>;
  modifiers: Record<string, WeatherModifier>;
  stsConfig: Record<string, Record<string, number | number[]> | number | number[]>;
  oceanPresets: { presets: OceanPreset[] };
  customCloudsStats: {
    maxStrikeChance: number;
    maxBurstChance: number;
    nonZeroStrikeEntries: number;
    totalCloudLayers: number;
  };
}

export interface CoastMeta {
  gridSize: number;
  worldSizeMeters: number;
  originWorldX: number;
  originWorldY: number;
  waterRatio: number;
}

export interface LightningBoltState {
  active: boolean;
  age: number;
  duration: number;
  flashIntensity: number;
  worldX: number;
  worldZ: number;
  seed: number;
  colorRGB: [number, number, number];
  kelvin: number;
  distanceMeters: number;
}

export interface WeatherRuntimeState {
  // Identity & transitions
  currentWeatherName: string;
  targetWeatherName: string;
  transitionProgress: number; // 0..1
  dataName: string;
  appTypeName: string;
  appDescription: string;
  appIcon: string;
  activeMods: string[];

  // Time & astronomy
  timeOfDayHours: number; // 0..24
  sunDir: [number, number, number];
  moonDir: [number, number, number];
  sunElevation: number; // -1..1
  isNight: boolean;

  // Atmosphere & Sky (directly from timecycles + W_MOD_atmos_*)
  wavelengthRGB: [number, number, number]; // nm (e.g. 680, 550, 440 or 571, 550, 531 in Hurricane)
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

  // Clouds (STS_Config + timecycle + CloudType)
  cloudMapsFrom: [string, string];
  cloudMapsTo: [string, string];
  cloudMapBlend: number;
  cloudCoverage: number; // 0..1
  cloudDensity: number; // 0..2
  cloudBaseHeight: number; // meters
  cloudTopHeight: number; // meters
  cirrusDensity: number;
  cirrusHeight: number;
  cloudWindScale: number;
  cloudWindShear: number;
  cloudShadowAlpha: number;
  cloudMultiScatter: number;
  cirrostratusDensity: number;
  cloudAnisotropy: number;
  cloudPowderExp: number;
  cloudStormDarkness: number; // 0..1

  // Fog & Haze
  fogDensity: number; // 0..1
  fogHeight: number;
  fogFalloff: number;
  hazeStrength: number;

  // Precipitation & Wetness
  rainIntensity: number; // 0..1
  hailIntensity: number; // 0..1
  sandstormIntensity: number; // 0..1
  wetness: number; // 0..1 (accumulates with rain, dries in sun)
  puddleRippleScale: number;
  rainbowStrength: number;

  // Wind & Gusts
  windBaseSpeed: number; // m/s
  windGustSpeed: number; // m/s
  windTotalSpeed: number; // m/s
  windAngleDeg: number;
  windDirXZ: [number, number];
  gustActive: boolean;
  gustEnvelope: number; // 0..1

  // Ocean & Waves (WEATHER.XML + W_MOD_fetch_* + OceanSimPresets)
  oceanFetch: number;
  oceanWaveAmplitude: number;
  oceanWaveMaxAmplitude: number;
  shoreWaveAmplitude: number;
  oceanFoamIntensity: number;
  rippleBumpiness: number;
  waterGustBump: number;

  // Climate & Phone Telemetry
  temperatureC: number;
  humidityPct: number;
  pressureHpa: number;
  niceness: number;

  // Lightning
  lightning: LightningBoltState;
  lightningTempMin: number;
  lightningTempMax: number;

  // Exposure
  exposure: number;
  filmicCurve: number[];
  oceanBandWeights: number[];
}
