export const CLOUD_MAP_GLSL = /* glsl */ `
uniform highp sampler2DArray uCloudMaps;
uniform ivec4 uCloudMapLayers;
uniform float uCloudMapBlend;
uniform float uCloudCoverage;
uniform vec2 uWindOffset;

vec2 readCloudFootprint(vec2 uv, ivec2 layers, float lod) {
  if (layers.x < 0) {
    float cells = valueNoise2(uv * 13.0) * 0.72 + 0.28 * valueNoise2(uv * 34.0);
    return vec2(smoothstep(0.76 - uCloudCoverage * 0.65, 0.98 - uCloudCoverage * 0.65, cells), 0.0);
  }
  vec3 a = textureLod(uCloudMaps, vec3(uv, float(layers.x)), lod).rgb;
  vec3 b = textureLod(uCloudMaps, vec3(uv, float(layers.y)), lod).rgb;
  // Pack the low and upper cloud footprints into separate RGB maps.
  return vec2(max(a.b * 2.15, max(a.r, a.g) * 1.2), max(b.r, b.g * 0.78));
}

vec2 cloudFootprint(vec2 worldXZ, float lod) {
  vec2 uv = (worldXZ - uWindOffset) / 32000.0 + vec2(0.66, 0.59);
  vec2 mass = readCloudFootprint(uv, uCloudMapLayers.xy, lod);
  if (uCloudMapBlend > 0.001 && any(notEqual(uCloudMapLayers.xy, uCloudMapLayers.zw))) {
    mass = mix(mass, readCloudFootprint(uv, uCloudMapLayers.zw, lod), uCloudMapBlend);
  }
  return mass;
}

vec2 cloudFootprint(vec2 worldXZ) {
  return cloudFootprint(worldXZ, 1.7);
}
`;

export const CLOUD_PROBE_GLSL = /* glsl */ `
uniform sampler2D uCloudProbe;
const float TWO_PI = 6.28318530718;

vec4 sampleCloudProbe(vec3 dir, float lod) {
  vec2 uv = vec2(atan(dir.x, -dir.z) / TWO_PI + 0.5, asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5);
  return textureLod(uCloudProbe, uv, lod);
}

vec3 compositeCloudVolume(vec3 sky, vec4 volume) {
  return sky * (1.0 - volume.a) + volume.rgb * volume.rgb / 0.32;
}

vec3 compositeClouds(vec3 sky, vec3 dir, float lod) {
  return compositeCloudVolume(sky, sampleCloudProbe(dir, lod));
}
`;

export function cloudFragment(atmosphere: string): string {
  return /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform highp sampler3D uCloudNoise;
uniform highp sampler3D uNativeNoise;
uniform bool uHasNativeNoise;
uniform sampler2D uBlueNoise;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uMoonDir;
uniform vec3 uMoonCol;
uniform vec3 uSkyCol;
uniform float uStormDarkness;
uniform float uCloudBase;
uniform float uCloudTop;
uniform float uCloudDensity;
uniform float uCloudAnisotropy;
uniform float uCloudMultiScatter;
uniform float uCloudPowderExp;
uniform float uCloudWindShear;
uniform vec2 uWindDirXZ;
uniform vec3 uStsWeightsLow;
uniform vec3 uStsWeightsHigh;
uniform vec3 uNoiseScale;
uniform vec3 uLightningPos;
uniform float uLightningFlash;
uniform vec3 uLightningCol;
uniform bool uViewPass;
uniform mat3 uCloudViewBasis;
uniform vec2 uCloudViewTan;

${atmosphere}
${CLOUD_MAP_GLSL}

float densityAt(vec3 p, bool detail, float fine) {
  float thickness = max(300.0, uCloudTop - uCloudBase);
  vec2 delta = p.xz - uCamPos.xz;
  float h = (p.y - uCloudBase + dot(delta, delta) / 12742000.0) / thickness;
  if (h <= 0.0 || h >= 1.0) return 0.0;
  vec2 drifted = p.xz - uWindDirXZ * h * uCloudWindShear;
  vec2 mask = cloudFootprint(drifted, mix(1.7, 0.85, fine));
  if (max(mask.x, mask.y) < 0.014) return 0.0;
  vec3 q = vec3(drifted.x - uWindOffset.x, p.y, drifted.y - uWindOffset.y);
  vec3 shape = textureLod(uCloudNoise, q * vec3(0.9, 1.75, 0.9) / uNoiseScale.x, 0.0).rgb;
  if (uHasNativeNoise) {
    vec3 base = q * vec3(1.0, 1.8, 1.0) / (uNoiseScale.x * 0.86);
    float nativeBillow = clamp(0.56 + 2.7 * (textureLod(uNativeNoise, base, 0.0).r - 0.68), 0.0, 1.0);
    shape.rb = mix(shape.rb, vec2(nativeBillow), vec2(0.64, 0.38));
  }
  float billow = shape.r * 0.82 + shape.b * 0.18;
  float height = mix(0.50 + 0.13 * shape.b, 0.73 + 0.20 * shape.b, uStormDarkness);
  float baseVariation = (shape.g - 0.5) * mix(0.10, 0.29, uStormDarkness);
  float bottom = smoothstep(0.085, 0.205, h - baseVariation);
  float top = 1.0 - smoothstep(height - 0.15, height, h);
  float cumulus = min(mask.x, 1.0) * bottom * top;
  float stratus = mask.y * smoothstep(0.12, 0.24, h) * (1.0 - smoothstep(0.35, 0.53, h));
  float mass = max(cumulus, stratus * mix(0.43, 0.93, uStormDarkness));
  float d = mass * 1.04 - (1.0 - billow) * 0.68;
  if (detail && d > 0.0) {
    vec3 weights = mix(uStsWeightsLow, uStsWeightsHigh, h);
    vec3 erosion = textureLod(uCloudNoise, q / uNoiseScale.y, 0.0).rgb;
    float wisps = textureLod(uCloudNoise, q / uNoiseScale.z, 0.0).g;
    if (uHasNativeNoise) wisps = clamp(0.45 + 3.1 * (textureLod(uNativeNoise, q / uNoiseScale.z, 0.0).r - 0.68), 0.0, 1.0);
    float fractalEdge = dot(1.0 - erosion, weights) * mix(0.20, 0.38, fine) +
      wisps * mix(0.048, 0.10, fine);
    d -= fractalEdge * (1.0 - smoothstep(0.10, 0.58, d));
  }
  return max(0.0, d) * uCloudDensity;
}

vec2 shellIntersections(float y, float rayY, float altitude) {
  const float earthRadius = 6371000.0;
  float b = (earthRadius + y) * rayY;
  float c = (y - altitude) * (2.0 * earthRadius + y + altitude);
  float discriminant = b * b - c;
  if (discriminant < 0.0) return vec2(-1.0);
  float q = -b + (b > 0.0 ? -1.0 : 1.0) * sqrt(discriminant);
  float other = abs(q) > 0.001 ? c / q : 0.0;
  return vec2(min(q, other), max(q, other));
}

void main() {
  fragColor = vec4(0.0);
  float phi = (vUv.x - 0.5) * (2.0 * PI);
  float elevation = (vUv.y - 0.5) * PI;
  vec3 ray = uViewPass
    ? normalize(uCloudViewBasis * vec3((vUv * 2.0 - 1.0) * uCloudViewTan, 1.0))
    : vec3(sin(phi) * cos(elevation), sin(elevation), -cos(phi) * cos(elevation));
  if (uCamPos.y < uCloudBase && ray.y < -0.004) return;
  vec2 top = shellIntersections(uCamPos.y, ray.y, uCloudTop);
  vec2 base = shellIntersections(uCamPos.y, ray.y, uCloudBase);
  float start = max(0.0, max(top.x, uCamPos.y < uCloudBase ? base.y : 0.0));
  float end = min(36000.0, base.x > start ? base.x : top.y);
  if (end <= start) return;

  float day = smoothstep(-0.14, 0.15, uSunDir.y);
  float lowSun = exp(-pow((uSunDir.y - 0.02) / 0.19, 2.0));
  vec3 lightDir = uSunDir.y > -0.04 ? normalize(vec3(uSunDir.x, max(0.06, uSunDir.y), uSunDir.z)) : uMoonDir;
  float mu = dot(ray, lightDir);
  float phase = 0.66 + min(0.95, 1.55 * hgPhase(mu, min(0.79, uCloudAnisotropy)));
  vec3 daylight = mix(uSunCol * vec3(1.38, 1.33, 1.27), vec3(1.28, 0.58, 0.31), lowSun);
  vec3 directCol = mix(uMoonCol * 0.07, daylight, day) * mix(1.0, 0.19, uStormDarkness);
  vec3 skyLight = mix(vec3(0.010, 0.017, 0.031), mix(vec3(0.20, 0.27, 0.34), vec3(0.085, 0.099, 0.121), uStormDarkness) *
    mix(vec3(1.0), uSkyCol, 0.25), day);

  float span = end - start;
  int steps = uViewPass ? int(clamp(28.0 + span / 115.0, 44.0, 72.0)) : 40;
  float invSteps = 1.0 / float(steps);
  // Limit grain in the closer view. Wider jitter breaks up long, low-angle ray steps.
  float jitterSpan = mix(0.27, 0.52, smoothstep(2800.0, 18000.0, span));
  float jitter = 0.5 + (texture(uBlueNoise, gl_FragCoord.xy / 64.0).r - 0.5) * jitterSpan;
  vec3 radiance = vec3(0.0);
  float trans = 1.0;
  float visibleOpacity = 0.0;
  for (int i = 0; i < 72; i++) {
    if (i >= steps) break;
    float u0 = float(i) * invSteps;
    float u1 = float(i + 1) * invSteps;
    float nearT = start + span * (u0 * 0.7 + 0.3 * u0 * u0);
    float farT = start + span * (u1 * 0.7 + 0.3 * u1 * u1);
    float t = mix(nearT, farT, jitter);
    vec3 p = uCamPos + ray * t;
    float fine = uViewPass ? 1.0 - smoothstep(5200.0, 15500.0, t) : 0.0;
    float d = densityAt(p, true, fine);
    if (d <= 0.001) continue;
    float opticalDepth = densityAt(p + lightDir * 40.0, fine > 0.4, fine) * 0.72
      + densityAt(p + lightDir * 150.0, false, fine) * 1.27
      + densityAt(p + lightDir * 420.0, false, 0.0) * 2.3
      + densityAt(p + lightDir * 950.0, false, 0.0) * 3.2;
    float lighting = exp(-opticalDepth) * phase;
    float multiple = exp(-opticalDepth * 0.31) * (1.0 - exp(-opticalDepth * clamp(uCloudPowderExp, 0.6, 2.5))) * 0.42;
    float skylightDepth = exp(-opticalDepth * mix(0.27, 0.53, uStormDarkness));
    vec3 lit = skyLight * mix(mix(0.52, 0.25, uStormDarkness), 1.14, skylightDepth) +
      directCol * (lighting + multiple * uCloudMultiScatter);
    if (uLightningFlash > 0.01) {
      lit += uLightningCol * uLightningFlash * 1.55 * exp(-length(p - uLightningPos) / 1350.0);
    }
    float alpha = 1.0 - exp(-d * (farT - nearT) * 0.0085);
    float aerial = exp(-t * mix(0.000053, 0.000081, uStormDarkness)) * (1.0 - smoothstep(24500.0, 35000.0, t));
    float weight = trans * alpha * aerial;
    radiance += weight * lit;
    visibleOpacity += weight;
    trans *= 1.0 - alpha;
    if (trans < 0.025) break;
  }
  // Compand premultiplied linear radiance into a portable RGBA8 render target.
  fragColor = vec4(sqrt(radiance * 0.32), visibleOpacity);
}
`;
}

export function makeCloudNoise(size = 64): Uint8Array {
  const data = new Uint8Array(size ** 3 * 4);
  const fract = (v: number) => v - Math.floor(v);
  const hash = (x: number, y: number, z: number, seed: number) =>
    fract(Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 17.13) * 43758.5453);
  const fade = (x: number) => x * x * (3 - 2 * x);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const makeField = (period: number, seed: number) => {
    const field = Float32Array.from({ length: period ** 3 }, (_, i) =>
      hash(i % period, Math.floor(i / period) % period, Math.floor(i / period ** 2), seed));
    const at = (x: number, y: number, z: number) =>
      field[(z % period) * period ** 2 + (y % period) * period + (x % period)];
    return (x: number, y: number, z: number) => {
      const ix = Math.floor(x * period), iy = Math.floor(y * period), iz = Math.floor(z * period);
      const tx = fade(fract(x * period)), ty = fade(fract(y * period)), tz = fade(fract(z * period));
      return lerp(
        lerp(lerp(at(ix, iy, iz), at(ix + 1, iy, iz), tx), lerp(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), tx), ty),
        lerp(lerp(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), tx), lerp(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), tx), ty), tz);
    };
  };
  const coarse = makeField(3, 4);
  const mid = makeField(7, 5);
  const fine = makeField(17, 6);
  const grit = makeField(28, 7);
  for (let z = 0, i = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++, i += 4) {
        const p = x / size, q = y / size, r = z / size;
        const a = coarse(p, q, r), b = mid(p, q, r), c = fine(p, q, r), d = grit(p, q, r);
        data[i] = Math.round((a * 0.56 + b * 0.28 + c * 0.16) * 255);
        data[i + 1] = Math.round((c * 0.68 + d * 0.32) * 255);
        data[i + 2] = Math.round((1 - Math.abs(b * 2 - 1)) * 255);
        data[i + 3] = 255;
      }
    }
  }
  return data;
}
