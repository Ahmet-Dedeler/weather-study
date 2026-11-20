import type { CoastMeta, WeatherDataset, WeatherTypeData, WeatherTypeEntry } from './types';

export interface VisualAssets {
  cloudMaps: Map<string, ImageBitmap>;
  blueNoise: ImageBitmap | null;
  waterNoise: ImageBitmap | null;
  foam: ImageBitmap | null;
  caustic: ImageBitmap | null;
}

export const DEMO_PRESETS: [string, string, number, number, number, number, number][] = [
  ['SCATTERED', 'Scattered', 0.71, 0, 0.01, 5, 0.28],
  ['SUNNY', 'Sunny', 0.95, 0, 0, 3, 0.08],
  ['COASTAL_FOG', 'Coastal Fog', 0.44, 0, 0.82, 2, 0.24],
  ['OVERCAST', 'Overcast', 0.28, 0, 0.07, 8, 0.63],
  ['DRIZZLE', 'Drizzle', 0.24, 0.28, 0.09, 9, 0.66],
  ['HEAVY_RAIN', 'Heavy Rain', 0.13, 0.77, 0.13, 16, 0.78],
  ['THUNDERSTORM', 'Thunderstorm', 0.09, 0.91, 0.08, 24, 0.80],
  ['HURRICANE', 'Hurricane', 0.045, 0.98, 0.15, 48, 0.97],
];

const hours = [0, 3, 5, 6.5, 8, 10, 12.5, 15, 17, 18.5, 20, 21.5, 23];

export function createDemoWeather(): WeatherDataset {
  const weatherTypeDatas: WeatherDataset['weatherTypeDatas'] = {};
  const weatherAppTypes: WeatherDataset['weatherAppTypes'] = {};
  const weatherLabels: WeatherDataset['weatherLabels'] = {};
  const timecycles: WeatherDataset['timecycles'] = {};
  const weatherTypes = DEMO_PRESETS.map(([name, label, sun, rain, fog, wind, clouds], index): WeatherTypeEntry => {
    const cloudMap = name === 'SUNNY' ? 'fair' : rain > 0.5 ? 'storm' : clouds > 0.4 ? 'deck' : 'scattered';
    const weather: WeatherTypeData = {
      Name: name, Sun: sun, Rain: rain, Fog: fog, CloudType: clouds / 2.1,
      CloudMapA: cloudMap, CloudMapB: `${cloudMap}_upper`,
      WindMin: wind * 0.69, WindMax: wind * 1.27, WindAngle: 34 + index * 6,
      WindGustsChance: 16 + wind * 1.6, WindGustsSpeedMin: wind * 0.34,
      WindGustsSpeedMax: wind * 0.69, WindGustsDurationMin: 3, WindGustsDurationMax: 7,
      OceanWaveAmplitude: 1.05 + wind * 0.18, ShoreWaveAmplitude: 0.68 + wind * 0.10,
      OceanWaveMaxAmplitude: 4.1 + wind * 0.17, OceanFoamIntensity: 0.072 + wind * 0.009,
      RippleBumpiness: 0.16 + rain * 0.61,
    };
    weatherTypeDatas[name] = weather;
    weatherLabels[name] = label;
    weatherAppTypes[name] = { name, icon: name, iconNight: name, background: '', descriptionKey: name };
    const day = (hour: number) => Math.max(0, Math.sin((hour - 6) / 24 * Math.PI * 2));
    const global = {
      sky_scattering_aerosol_density_scale: hours.map((h) => 0.18 + 0.12 * (1 - day(h)) + fog * 0.55),
      light_dir_mult: hours.map((h) => 0.7 + 0.37 * day(h) * sun),
      local_atmosphere_cloud_height: hours.map((h) => 420 - rain * 115 + day(h) * 70),
    };
    timecycles[name] = {
      GLOBAL: global,
      URBAN: { ...global, sky_scattering_aerosol_density_scale: global.sky_scattering_aerosol_density_scale.map((n) => n + 0.43),
        local_atmosphere_fog_density: hours.map(() => 0.002) },
    };
    return { name, shortName: label, dataName: name, weatherAppDataName: name,
      mods: { atmosphere: '', precipitation: '', temperature: '', humidity: '', wind: '', fetch: '', misc: '', niceness: '' },
      skipDebugCycling: name === 'HURRICANE' };
  });
  return {
    source: 'Original demo presets',
    timeSamples: hours.map((hour, i) => ({ name: `sample_${i}`, hour, interp: 'EASE_QUARTIC_INOUT' })),
    weatherTypeDatas, weatherTypes, weatherAppTypes, weatherLabels, timecycles, weatherCycles: [], modifiers: {},
    stsConfig: { CloudNoiseScale: [4900, 1060, 240] },
    oceanPresets: { presets: [] },
    customCloudsStats: { maxStrikeChance: 0, maxBurstChance: 0, nonZeroStrikeEntries: 0, totalCloudLayers: 0 },
  };
}

function coastEdge(z: number) {
  return -8 + 21 * Math.sin(z * 0.012 + 0.32) + 12 * Math.sin(z * 0.026);
}

export function createDemoCoast() {
  const gridSize = 321;
  const worldSizeMeters = 1280;
  const heights = new Float32Array(gridSize ** 2);
  const materials = new Uint8Array(heights.length);
  let water = 0;
  for (let i = 0; i < heights.length; i++) {
    const x = (i % gridSize / (gridSize - 1) - 0.5) * worldSizeMeters;
    const z = (Math.floor(i / gridSize) / (gridSize - 1) - 0.5) * worldSizeMeters;
    // The mainland curls away at the far end of the bay.
    const inland = Math.min(x - coastEdge(z), z + 290 + 0.38 * Math.max(0, x));
    const dunes = Math.sin(z * 0.026 + x * 0.019) * 1.8 + Math.sin(z * 0.018 - x * 0.049) * 1.2;
    const rise = 1 - Math.exp(-Math.max(0, inland) / 46);
    heights[i] = inland < 0 ? Math.max(-24, inland * 0.105)
      : 0.15 + Math.min(0.063 * inland, 2.8) + rise * (2.5 + dunes);
    materials[i] = inland < 0 ? 1 : 0;
    water += materials[i];
  }
  const meta: CoastMeta = { gridSize, worldSizeMeters, originWorldX: -640, originWorldY: -640, waterRatio: water / heights.length };
  return { meta, heights, materials };
}

async function makeBitmap(size: number, pixel: (x: number, y: number) => number[]) {
  const image = new ImageData(size, size);
  for (let i = 0; i < size ** 2; i++) image.data.set(pixel(i % size / size, Math.floor(i / size) / size), 4 * i);
  return createImageBitmap(image, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

export async function createDemoTextures(): Promise<VisualAssets> {
  const tau = Math.PI * 2;
  const wave = (x: number, y: number, a: number, b: number, phase = 0) => Math.sin(tau * (x * a + y * b + phase));
  let seed = 59321;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const cloudMaps = new Map<string, ImageBitmap>();
  for (const [i, kind] of ['fair', 'scattered', 'deck', 'storm'].entries()) {
    for (const upper of [false, true]) {
      cloudMaps.set(kind + (upper ? '_upper' : ''), await makeBitmap(256, (x, y) => {
        const cells = wave(x, y, 4, 2, i * 0.12) * 0.34 + wave(x, y, 3, -5) * 0.29 +
          wave(x, y, 7, 4, y) * 0.20 + wave(x, y, 11, -7) * 0.11 + wave(x, y, 16, 13) * 0.06;
        const cover = Math.max(0, Math.min(1, (cells + 0.19 + i * 0.21) * 1.1));
        return upper ? [cover * i * 40, cover * i * 21, 0, 255] : [cover * 106, cover * 92, cover * 133, 255];
      }));
    }
  }
  return {
    cloudMaps,
    blueNoise: await makeBitmap(64, () => { const n = random() * 255; return [n, n, n, 255]; }),
    waterNoise: await makeBitmap(128, (x, y) => [
      0, 141 + 35 * wave(x, y, 11, 5, 0.3 * wave(x, y, 2, -2)) + 21 * wave(x, y, 20, 17),
      0, 128 + 37 * wave(x, y, -8, 7, 0.3 * wave(x, y, 3, 2)) + 23 * wave(x, y, 19, -14),
    ]),
    foam: await makeBitmap(256, (x, y) => {
      const n = 65 + 112 * Math.pow(Math.abs(wave(x, y, 13, 9, 0.18 * wave(x, y, 8, -9))), 5) + random() * 30;
      return [n, n, n, 255];
    }),
    caustic: await makeBitmap(128, (x, y) => {
      const n = 235 * Math.pow(1 - Math.abs(wave(x, y, 6, 5, 0.21 * wave(x, y, 4, -5))), 5);
      return [n, n, n, 255];
    }),
  };
}

export function closeTextures(assets: VisualAssets) {
  for (const texture of assets.cloudMaps.values()) texture.close();
  for (const texture of [assets.blueNoise, assets.waterNoise, assets.foam, assets.caustic]) texture?.close();
}
