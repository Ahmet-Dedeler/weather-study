import { CLOUD_MAP_GLSL, CLOUD_PROBE_GLSL, cloudFragment, makeCloudNoise } from './clouds';
import { buildPalms } from './palms';
import type { SceneInputs } from './scene';
import { lightningChannels } from './lightning';
import type { CoastMeta, WeatherDataset, WeatherRuntimeState } from './types';
import type { VisualAssets } from './demo';

export interface CameraState {
  pos: [number, number, number];
  yaw: number; // radians, 0 = -Z
  pitch: number; // radians
  fovDeg: number;
}

export interface CameraPreset {
  id: string;
  label: string;
  pos: [number, number, number];
  yaw: number;
  pitch: number;
}

export const CAMERA_PRESETS: CameraPreset[] = [
  { id: 'coast', label: 'Coastline', pos: [32, 7.4, 122], yaw: -0.28, pitch: 0.045 },
  { id: 'beach', label: 'Waterline', pos: [-18, 2.25, 123], yaw: 0.09, pitch: 0.032 },
  { id: 'overlook', label: 'Offshore', pos: [-160, 13, -62], yaw: -1.85, pitch: 0.095 },
  { id: 'aerial', label: 'Cloud Deck', pos: [-98, 122, 186], yaw: 0.35, pitch: -0.19 },
];

// ---- Minimal rock-solid 4x4 matrix math (column-major for WebGL2) ----
function mat4Perspective(fovRad: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1.0 / Math.tan(fovRad * 0.5);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function mat4LookDir(eye: [number, number, number], yaw: number, pitch: number): {
  view: Float32Array;
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
} {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);

  // Forward vector (yaw=0 looks along -Z)
  const fx = sy * cp;
  const fy = sp;
  const fz = -cy * cp;

  // Right = normalize(cross(forward, worldUp(0,1,0)))
  let rx = -fz;
  let ry = 0;
  let rz = fx;
  const rlen = Math.hypot(rx, ry, rz) || 1;
  rx /= rlen;
  rz /= rlen;

  // Up = cross(right, forward)
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  const view = new Float32Array(16);
  view[0] = rx;
  view[4] = ry;
  view[8] = rz;
  view[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
  view[1] = ux;
  view[5] = uy;
  view[9] = uz;
  view[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  view[2] = -fx;
  view[6] = -fy;
  view[10] = -fz;
  view[14] = fx * eye[0] + fy * eye[1] + fz * eye[2];
  view[15] = 1;

  return { view, forward: [fx, fy, fz], right: [rx, ry, rz], up: [ux, uy, uz] };
}

function mat4Mul(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error(`Failed to create shader: ${label}`);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh) || 'unknown';
    gl.deleteShader(sh);
    throw new Error(`GLSL compile error (${label}):\n${info}`);
  }
  return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string, label: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, `${label}.vs`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, `${label}.fs`);
  const prog = gl.createProgram();
  if (!prog) throw new Error(`Failed to create program: ${label}`);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog) || 'unknown';
    gl.deleteProgram(prog);
    throw new Error(`GLSL link error (${label}):\n${info}`);
  }
  return prog;
}

// ============================================================================
// SHARED GLSL ATMOSPHERE, LIGHTING & TONEMAPPING SNIPPET
// ============================================================================
const COMMON_ATMOS_GLSL = /* glsl */ `
const float PI = 3.14159265359;

uniform vec4 uFilmicABCD;
uniform vec3 uFilmicEFW;

vec3 filmic(vec3 x) {
  float a = uFilmicABCD.x, b = uFilmicABCD.y, c = uFilmicABCD.z, d = uFilmicABCD.w;
  float e = uFilmicEFW.x, f = max(0.001, uFilmicEFW.y);
  return (x * (a * x + c * b) + d * e) / max(x * (a * x + b) + d * f, vec3(0.001)) - e / f;
}

vec3 displayTonemap(vec3 x) {
  float white = max(0.05, filmic(vec3(uFilmicEFW.z)).r);
  // Browser scene radiance is not in the original engine's exposure units.
  return clamp(filmic(max(x, 0.0) * 2.7) / white, 0.0, 1.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i + vec2(0.0, 0.0)), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float hgPhase(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(0.001, 1.0 + g2 - 2.0 * g * cosTheta), 1.5));
}

float fogTransmission(float dist, float camHeight, float objectHeight, float density, float layerBase, float falloff, float aerial) {
  float scale = max(1.0, falloff);
  float midpoint = (camHeight + objectHeight) * 0.5;
  float local = (exp(-max(0.0, camHeight - layerBase) / scale) +
                 4.0 * exp(-max(0.0, midpoint - layerBase) / scale) +
                 exp(-max(0.0, objectHeight - layerBase) / scale)) / 6.0;
  return exp(-dist * (aerial + density * 0.0048 * local));
}

vec3 safeNormalizeUpper(vec3 v) {
  vec3 u = vec3(v.x, max(v.y, 0.0), v.z);
  float len2 = dot(u, u);
  return len2 > 1e-8 ? u * inversesqrt(len2) : vec3(0.0, 1.0, 0.0);
}

// Analytic sky driven by the active timecycle.
vec3 evalSky(
  vec3 rd,
  vec3 sunDir,
  vec3 moonDir,
  vec3 wavelengthRGB,
  vec3 skyCol,
  vec3 sunCol,
  float sunIntensity,
  float aerosolDensity,
  float ozoneConc,
  float mieG,
  vec3 moonCol,
  float moonIntensity,
  vec3 airGlowCol,
  float airGlowIntensity,
  float stormDarkness,
  float sandstorm,
  float lightningFlash,
  vec3 lightningCol
) {
  float y = clamp(rd.y, 0.0, 1.0);
  float sunY = sunDir.y;
  float dayT = smoothstep(-0.14, 0.22, sunY);
  float twilightNorm = (sunY - 0.01) / 0.14;
  float twilightT = exp(-(twilightNorm * twilightNorm));

  // Rayleigh scattering beta proportional to (550 / lambda)^4
  // Notice in Hurricane XML, wavelengths tighten to (571, 550, 531) -> desaturated slate sky!
  vec3 invLambda4 = pow(vec3(550.0) / max(wavelengthRGB, vec3(320.0)), vec3(4.0));
  vec3 rayBase = normalize(invLambda4) * vec3(0.36, 0.68, 1.13);
  vec3 rayCol = mix(rayBase * skyCol, vec3(0.26, 0.32, 0.39) * skyCol, clamp(stormDarkness * 0.78, 0.0, 0.90));

  // Zenith to horizon optical depth
  float airmass = 1.0 / (y + 0.14);
  float horizonT = exp(-y * 6.7);
  float cosSun = dot(rd, sunDir);
  float sunsetDirection = 0.16 + 0.84 * pow(max(0.0, cosSun * 0.5 + 0.5), 4.0);

  // Ozone twilight band (deep cobalt zenith + warm coral/magenta/gold sunset horizon)
  vec3 ozoneTint = mix(vec3(1.0), vec3(0.55, 0.72, 1.28), clamp(ozoneConc * 1.6, 0.0, 0.85));
  vec3 zenithDay = rayCol * ozoneTint * (0.28 + 0.72 * dayT);
  zenithDay = mix(zenithDay, vec3(0.16, 0.20, 0.46), twilightT * 0.65 * (1.0 - stormDarkness * 0.7));
  vec3 horizonDay = mix(
    vec3(0.42, 0.61, 0.79) * mix(vec3(1.0), skyCol, 0.64),
    vec3(1.44, 0.48, 0.19) * sunCol,
    twilightT * sunsetDirection * (1.0 - stormDarkness * 0.6)
  );
  // Sandstorm amber sky shift from SandStorm timecycle
  horizonDay = mix(horizonDay, vec3(0.95, 0.66, 0.38), sandstorm * 0.82);
  zenithDay = mix(zenithDay, vec3(0.56, 0.38, 0.22), sandstorm * 0.72);

  vec3 daySky = mix(zenithDay, horizonDay, horizonT);
  // Darken dramatically during heavy storms/hurricanes
  daySky *= mix(1.0, 0.24, stormDarkness * 0.88);
  daySky *= (0.35 + 0.65 * clamp(sunIntensity, 0.2, 1.3));

  // Mie forward scattering halo around sun
  float miePhase = hgPhase(cosSun, clamp(mieG, 0.35, 0.86));
  float mieScale = clamp(0.14 + aerosolDensity * 0.16, 0.12, 1.1) * (1.0 - stormDarkness * 0.75);
  vec3 sunTint = mix(sunCol, vec3(1.8, 0.62, 0.26), twilightT);
  daySky += sunTint * miePhase * mieScale * dayT * (0.55 + 0.45 * horizonT);

  // Night sky + subtle green-cyan airglow from sky_air_glow_color + moonlight scattering
  vec3 nightZenith = vec3(0.008, 0.015, 0.036);
  vec3 nightHorizon = vec3(0.024, 0.042, 0.078) + airGlowCol * airGlowIntensity * 0.05;
  vec3 nightSky = mix(nightZenith, nightHorizon, pow(1.0 - y, 2.8));

  float moonVis = smoothstep(-0.08, 0.12, moonDir.y);
  float cosMoon = dot(rd, moonDir);
  float moonGlow = hgPhase(cosMoon, 0.72) * 0.24 * moonVis * (1.0 - stormDarkness * 0.75);
  nightSky += moonCol * moonGlow * clamp(0.35 + moonIntensity * 0.004, 0.25, 1.1);

  vec3 col = mix(nightSky, daySky, dayT);

  // Subtle aerosol horizon band (kept crisp on sunny days, thick during hurricanes/fog)
  float hazeMix = clamp(airmass * 0.014 * aerosolDensity * (1.0 - y) * (0.4 + stormDarkness * 1.4), 0.0, 0.55);
  vec3 hazeCol = mix(nightHorizon * 1.3, horizonDay * mix(0.82, 0.32, stormDarkness), dayT);
  col = mix(col, hazeCol, hazeMix);

  // Lightning sheet sky bounce
  col += lightningCol * lightningFlash * (0.12 + 0.19 * horizonT);
  return col;
}
`;

// ============================================================================
// PASS 1: FULLSCREEN SKY + RAYMARCHED VOLUMETRIC STS CLOUDS + CIRRUS + RAINBOW
// ============================================================================
const SKY_VS = /* glsl */ `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  vec2 p = POS[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.9999, 1.0);
}
`;

const SKY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform vec3 uCamPos;
uniform vec3 uCamForward;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uTanHalfFov;
uniform float uTime;
uniform sampler2D uCloudView;
uniform mat3 uCloudViewBasis;
uniform vec2 uCloudViewTan;

uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uWavelengthRGB;
uniform vec3 uSkyCol;
uniform vec3 uSunCol;
uniform float uSunIntensity;
uniform float uSunDiscSize;
uniform float uSunDiskMult;
uniform float uAerosol;
uniform float uOzone;
uniform float uMieG;
uniform vec3 uMoonCol;
uniform float uMoonIntensity;
uniform float uStarsIntensity;
uniform vec3 uAirGlowCol;
uniform float uAirGlowIntensity;

uniform float uCloudCoverage;
uniform float uCirrusDensity;
uniform float uCirrusHeight;
uniform float uCirrostratusDensity;
uniform float uStormDarkness;
uniform float uSandstorm;
uniform float uRainbowStrength;
uniform vec2 uWindOffset;

uniform float uLightningFlash;
uniform vec3 uLightningPos;
uniform vec3 uLightningCol;
uniform float uExposure;

${COMMON_ATMOS_GLSL}
${CLOUD_PROBE_GLSL}

vec4 sampleVisibleClouds(vec3 dir) {
  vec3 local = transpose(uCloudViewBasis) * dir;
  vec2 uv = local.xy / (max(0.01, local.z) * uCloudViewTan) * 0.5 + 0.5;
  float inset = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  if (inset <= 0.0 || local.z <= 0.0) return sampleCloudProbe(dir, 0.0);
  vec4 layer = texture(uCloudView, uv);
  if (inset >= 0.025) return layer;
  return mix(sampleCloudProbe(dir, 0.0), layer, smoothstep(0.0, 0.025, inset));
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  float aspect = uResolution.x / max(1.0, uResolution.y);
  vec3 rd = normalize(
    uCamForward +
    uCamRight * (ndc.x * aspect * uTanHalfFov) +
    uCamUp * (ndc.y * uTanHalfFov)
  );

  vec3 col = evalSky(
    rd, uSunDir, uMoonDir, uWavelengthRGB, uSkyCol, uSunCol, uSunIntensity,
    uAerosol, uOzone, uMieG, uMoonCol, uMoonIntensity, uAirGlowCol, uAirGlowIntensity,
    uStormDarkness, uSandstorm, uLightningFlash, uLightningCol
  );

  float dayT = smoothstep(-0.12, 0.18, uSunDir.y);
  float nightT = 1.0 - dayT;

  // ---- Sun Disc ----
  if (rd.y > -0.02 && uSunDir.y > -0.08) {
    float cosS = dot(rd, uSunDir);
    float discR = 0.0065 * clamp(uSunDiscSize, 0.45, 2.2);
    float disc = smoothstep(cos(discR * 1.45), cos(discR * 0.7), cosS);
    float corona = pow(max(0.0, cosS), 180.0) * 1.4;
    float sunVis = (1.0 - uStormDarkness * 0.92) * smoothstep(-0.05, 0.06, uSunDir.y);
    vec3 sunDiscCol = mix(vec3(1.5, 0.65, 0.25), uSunCol * 1.3, smoothstep(0.0, 0.25, uSunDir.y));
    col += sunDiscCol * (disc * clamp(uSunDiskMult / 20.0, 0.0, 24.0) + corona * 1.3) * sunVis;
  }

  // ---- Moon Disc & Night Stars ----
  if (rd.y > 0.0 && nightT > 0.02) {
    float cosM = dot(rd, uMoonDir);
    float mDisc = smoothstep(cos(0.015), cos(0.011), cosM);
    float mVis = nightT * smoothstep(-0.02, 0.08, uMoonDir.y) * (1.0 - uCloudCoverage * 0.85);
    // Subtle crater shading on moon
    float crater = 0.78 + 0.22 * valueNoise2(rd.xz * 120.0 + rd.y * 80.0);
    col += uMoonCol * (mDisc * 2.4 * crater + pow(max(0.0, cosM), 90.0) * 0.25) * mVis;

    // Crisp procedural starfield + subtle galaxy dust band
    vec2 sp = rd.xz / (rd.y + 0.35) * 240.0;
    vec2 cell = floor(sp);
    vec2 f = fract(sp) - 0.5;
    float rnd = hash12(cell);
    if (rnd > 0.985) {
      float star = exp(-dot(f, f) * 52.0);
      float twinkle = 0.7 + 0.3 * sin(uTime * 3.0 + rnd * 200.0);
      vec3 starCol = mix(vec3(0.75, 0.86, 1.0), vec3(1.0, 0.88, 0.72), fract(rnd * 91.7));
      float starVis = (1.0 - smoothstep(-0.28, -0.12, uSunDir.y)) * smoothstep(0.02, 0.25, rd.y);
      col += starCol * star * twinkle * (0.5 + uStarsIntensity * 10.0) * starVis;
    }
  }

  // ---- High-Altitude Cirrus & Cirrostratus Layer ----
  if (rd.y > 0.015 && (uCirrusDensity > 0.02 || uCirrostratusDensity > 0.02)) {
    float tCir = (uCirrusHeight - uCamPos.y) / max(0.02, rd.y);
    vec2 cp = (uCamPos.xz + rd.xz * tCir - uWindOffset * 0.55) * 0.00012;
    float w1 = valueNoise2(cp * vec2(1.0, 2.8));
    float w2 = valueNoise2(cp * vec2(2.6, 5.2) + w1 * 1.5);
    float cirrus = smoothstep(0.46, 0.86, w1 * 0.55 + w2 * 0.45);
    float fadeH = smoothstep(0.015, 0.16, rd.y);
    float alpha = clamp(cirrus * (uCirrusDensity * 0.12 + uCirrostratusDensity * 0.08) * fadeH, 0.0, 0.46);
    vec3 cirCol = mix(
      vec3(0.06, 0.08, 0.14),
      mix(vec3(1.05, 0.72, 0.52), vec3(1.0, 0.99, 0.98), smoothstep(0.02, 0.28, uSunDir.y)),
      dayT
    );
    cirCol *= mix(1.0, 0.45, uStormDarkness);
    cirCol += uLightningCol * uLightningFlash * 0.65;
    col = mix(col, cirCol, alpha);
  }

  col = compositeCloudVolume(col, sampleVisibleClouds(rd));

  // ---- Physical Primary Rainbow (42° anti-solar arc during sun + rain) ----
  if (uRainbowStrength > 0.01 && rd.y > 0.0) {
    float antiCos = dot(rd, -uSunDir);
    float deg = degrees(acos(clamp(antiCos, -1.0, 1.0)));
    float band = (deg - 40.5) / 2.6; // 0..1 across violet->red
    if (band > 0.0 && band < 1.0) {
      vec3 spec = clamp(vec3(
        smoothstep(0.45, 0.92, band),
        sin(band * PI),
        1.0 - smoothstep(0.08, 0.55, band)
      ), 0.0, 1.0);
      float env = sin(band * PI) * smoothstep(0.0, 0.14, rd.y);
      col += spec * env * uRainbowStrength * 0.34;
    }
  }

  // Filmic tone mapping + gamma
  col *= uExposure;
  col = displayTonemap(col);
  col = pow(col, vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}
`;

// ============================================================================
// PASS 2: COASTAL TERRAIN
// ============================================================================
const TERRAIN_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aPlantColor;
layout(location = 3) in vec2 aPlantBend;
layout(location = 4) in vec4 aPlacement;
layout(location = 5) in float aScale;

uniform mat4 uViewProj;
uniform bool uIsPlant;
uniform bool uIsProp;
uniform float uTime;
uniform float uPlantWind;
uniform vec2 uPlantWindDir;

out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vPlantColor;
out vec2 vMaterialUv;

void main() {
  vec3 pos = aPos;
  vec3 normal = aNormal;
  float phase = aPlantBend.y;
  float flex = aPlantBend.x;
  if (uIsProp) {
    float c = cos(aPlacement.w), s = sin(aPlacement.w);
    mat2 rot = mat2(c, s, -s, c);
    pos.xz = rot * pos.xz;
    pos = pos * aScale + aPlacement.xyz;
    normal.xz = rot * normal.xz;
    phase = aPlacement.w;
    float height = clamp(aPos.y * 0.045, 0.0, 1.0);
    flex = height * height * (0.49 + 0.67 * smoothstep(0.55, 1.0, height));
  }
  if (uIsPlant) {
    float gust = 0.64 + 0.27 * sin(uTime * 1.8 + phase) + 0.09 * sin(uTime * 4.5 + phase * 1.8);
    pos.xz += flex * uPlantWind * (uPlantWindDir * gust + vec2(-uPlantWindDir.y, uPlantWindDir.x) *
      sin(uTime * 2.6 + phase) * 0.19);
    pos.y -= flex * flex * uPlantWind * 0.24;
  }
  vWorldPos = pos;
  vNormal = normal;
  vPlantColor = aPlantColor;
  vMaterialUv = aPlantColor.xy;
  gl_Position = uViewProj * vec4(pos, 1.0);
}
`;

const TERRAIN_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vPlantColor;
in vec2 vMaterialUv;
out vec4 fragColor;

uniform sampler2D uSurfaceTex;
uniform float uCoastHalfSize;
uniform vec3 uCamPos;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uWavelengthRGB;
uniform vec3 uSkyCol;
uniform vec3 uSunCol;
uniform float uSunIntensity;
uniform float uAerosol;
uniform float uOzone;
uniform float uMieG;
uniform vec3 uMoonCol;
uniform float uMoonIntensity;
uniform vec3 uAirGlowCol;
uniform float uAirGlowIntensity;
uniform vec3 uLightDirCol;
uniform float uLightDirMult;
uniform vec3 uAmbientSkyCol;
uniform float uAmbientSkyIntensity;
uniform float uStormDarkness;
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uFogFalloff;
uniform float uHazeStrength;
uniform float uSandstorm;
uniform float uWetness;
uniform float uRainIntensity;
uniform float uPuddleRippleScale;
uniform float uLightningFlash;
uniform vec3 uLightningPos;
uniform vec3 uLightningCol;
uniform float uExposure;
uniform float uCloudBase;
uniform float uCloudShadowAlpha;
uniform bool uIsPlant;
uniform bool uIsProp;
uniform bool uNativeLand;
uniform bool uMapStructure;
uniform sampler2D uMaterialTex;

${COMMON_ATMOS_GLSL}
${CLOUD_MAP_GLSL}
${CLOUD_PROBE_GLSL}

void main() {
  vec3 N = normalize(vNormal) * (uIsPlant && !gl_FrontFacing ? -1.0 : 1.0);
  vec3 V = normalize(uCamPos - vWorldPos);
  float dist = length(uCamPos - vWorldPos);
  float dayT = smoothstep(-0.10, 0.18, uSunDir.y);

  float grain = valueNoise2(vWorldPos.xz * 0.21) * 0.65 + valueNoise2(vWorldPos.xz * 1.9) * 0.35;
  float macro = valueNoise2(vWorldPos.xz * 0.032);
  vec2 shoreUv = (vWorldPos.xz + uCoastHalfSize) / (2.0 * uCoastHalfSize);
  int m = int(texture(uSurfaceTex, shoreUv).r * 255.0 + 0.5);

  vec3 albedo;
  float rough = 0.85;
  float puddleMask = 0.0;

  float grassMask = smoothstep(0.8, 4.5, vWorldPos.y + (macro - 0.5) * 3.1);
  vec3 sand = mix(vec3(0.24, 0.179, 0.119), vec3(0.50, 0.41, 0.28), grain);
  vec3 scrub = mix(vec3(0.028, 0.048, 0.015), vec3(0.12, 0.145, 0.046), grain * 0.55 + macro * 0.45);
  if (uNativeLand && !uIsProp && !uMapStructure) {
    if (N.y < 0.0) N = -N;
    float stagger = valueNoise2(vWorldPos.xz * 0.105);
    float grains = valueNoise2(vWorldPos.xz * 14.0);
    grassMask = smoothstep(1.4, 5.6, vWorldPos.y + (stagger - 0.55) * 3.25);
    grassMask *= smoothstep(0.48, 0.90, N.y);
    float fine = mix(grains, 0.5, smoothstep(17.0, 66.0, dist));
    sand *= 0.83 + fine * 0.35 + stagger * 0.24;
    scrub *= 0.65 + stagger * 0.51 + fine * 0.31;
    float level = smoothstep(0.96, 0.995, N.y);
    float porous = 1.0 - grassMask * 0.78;
    puddleMask = smoothstep(0.55, 0.80, macro * 0.78 + stagger * 0.22) * level * porous * uWetness;
  } else if ((m == 2 || m == 3) && vWorldPos.y > 1.2) {
    puddleMask = smoothstep(0.50, 0.76, macro) * uWetness;
  }
  albedo = mix(sand, scrub, grassMask);
  if (uIsPlant) {
    albedo = vPlantColor;
    rough = 0.82;
    puddleMask = 0.0;
  }
  if (uIsProp) {
    vec4 texel = texture(uMaterialTex, vMaterialUv);
    if (texel.a < (uIsPlant ? 0.35 : 0.28)) discard;
    albedo = pow(texel.rgb, vec3(2.2));
    rough = uIsPlant ? 0.84 : 0.66;
    puddleMask = 0.0;
  }
  if (uMapStructure) {
    vec3 wall = mix(vec3(0.24, 0.23, 0.205), vec3(0.43, 0.41, 0.35), grain);
    vec3 roof = mix(vec3(0.075, 0.066, 0.056), vec3(0.25, 0.17, 0.125), macro);
    albedo = mix(wall, roof, smoothstep(0.5, 0.9, abs(N.y)));
    rough = 0.79;
    puddleMask = 0.0;
  }

  // Wetness darkens porous surfaces  & makes them glossy
  float absorption = uNativeLand ? mix(0.80, 0.53, grassMask) : (m == 2 ? 0.95 : 0.65);
  albedo *= mix(1.0, 0.52, uWetness * absorption);
  rough = mix(rough, 0.14, uWetness * 0.75);
  rough = mix(rough, 0.04, puddleMask);

  // Live Raindrop Puddle Ripples (PuddleRippleMin/MaxSizeModifier from WEATHER.XML)
  if (puddleMask > 0.05 && uRainIntensity > 0.04) {
    vec2 rp = vWorldPos.xz * (0.85 / max(0.4, uPuddleRippleScale));
    vec2 cell = floor(rp);
    vec2 f = fract(rp) - 0.5;
    float h = hash12(cell);
    float age = fract(uTime * 1.45 + h * 7.0);
    float r = length(f);
    float ring = sin((r - age * 0.45) * 48.0) * exp(-abs(r - age * 0.45) * 18.0) * (1.0 - age);
    vec2 rGrad = (f / max(r, 1e-4)) * ring * uRainIntensity * puddleMask * 0.32;
    N = normalize(N + vec3(rGrad.x, 0.0, rGrad.y));
  }

  // Direct Sun / Moon lighting
  vec3 L = (uSunDir.y > -0.02) ? uSunDir : uMoonDir;
  float ndl = max(dot(N, L), 0.0);
  float twilightNorm = (uSunDir.y - 0.02) / 0.14;
  float twilightT = exp(-(twilightNorm * twilightNorm));
  vec3 sunLight = mix(uSunCol * uLightDirCol, vec3(1.5, 0.62, 0.30), twilightT) *
    clamp(uLightDirMult, 0.5, 1.5) * mix(1.0, 0.25, uStormDarkness) * dayT;
  float projection = max(0.0, uCloudBase + 250.0 - vWorldPos.y) / max(0.14, L.y);
  vec2 shadowCloud = cloudFootprint(vWorldPos.xz + L.xz * projection);
  sunLight *= 1.0 - uCloudShadowAlpha * 0.75 * smoothstep(0.07, 0.85, max(shadowCloud.x, shadowCloud.y));
  vec3 moonLight = uMoonCol * 0.16 * (1.0 - dayT) * smoothstep(-0.04, 0.12, uMoonDir.y) * (1.0 - uStormDarkness * 0.7);
  vec3 directCol = sunLight + moonLight;

  // Ambient sky hemisphere lighting
  vec3 skyAmb = mix(vec3(0.03, 0.045, 0.08), vec3(0.32, 0.44, 0.62) * uAmbientSkyCol, dayT);
  skyAmb *= mix(1.0, 0.45, uStormDarkness) * (0.55 + 0.45 * clamp(uAmbientSkyIntensity, 0.2, 1.4));
  vec3 groundAmb = skyAmb * 0.35;
  vec3 amb = mix(groundAmb, skyAmb, N.y * 0.5 + 0.5);

  vec3 color = albedo * (amb + directCol * ndl * 1.12);
  if (uIsPlant) color += albedo * directCol * max(0.0, dot(-N, L)) * 0.19;

  // Specular + wet puddle sky reflections
  vec3 halfVec = L + V;
  float halfLen2 = dot(halfVec, halfVec);
  vec3 H = halfLen2 > 1e-8 ? halfVec * inversesqrt(halfLen2) : N;
  float specPow = mix(12.0, 180.0, 1.0 - rough);
  float spec = pow(max(dot(N, H), 0.0), specPow) * (0.04 + 0.75 * (1.0 - rough));
  color += directCol * spec;

  if (uWetness > 0.05 && !uIsPlant) {
    vec3 R = reflect(-V, N);
    float fresnelBase = max(0.0, 1.0 - max(dot(N, V), 0.0));
    float fresnel2 = fresnelBase * fresnelBase;
    float fresnel = fresnel2 * fresnel2;
    float outdoor = smoothstep(-0.08, 0.08, R.y);
    R = safeNormalizeUpper(R);
    vec3 reflSky = evalSky(
      R, uSunDir, uMoonDir, uWavelengthRGB, uSkyCol, uSunCol, uSunIntensity,
      uAerosol, uOzone, uMieG, uMoonCol, uMoonIntensity, uAirGlowCol, uAirGlowIntensity,
      uStormDarkness, uSandstorm, uLightningFlash, uLightningCol
    );
    reflSky = compositeClouds(reflSky, R, mix(3.4, 0.9, puddleMask));
    color = mix(color, reflSky, outdoor * clamp((puddleMask * 0.66 + uWetness * 0.08) * (0.20 + 0.80 * fresnel), 0.0, 0.74));
  }

  // Lightning illumination on terrain
  if (uLightningFlash > 0.01) {
    vec3 toBolt = normalize(vec3(uLightningPos.x - vWorldPos.x, 260.0 - vWorldPos.y, uLightningPos.z - vWorldPos.z));
    float lNdl = 0.25 + 0.75 * max(dot(N, toBolt), 0.0);
    color += albedo * uLightningCol * uLightningFlash * lNdl * 0.9;
  }

  // Distance fog & height mist matching the sky horizon seamlessly
  vec3 viewDir = normalize(vWorldPos - uCamPos);
  vec3 fogCol = evalSky(
    safeNormalizeUpper(viewDir),
    uSunDir, uMoonDir, uWavelengthRGB, uSkyCol, uSunCol, uSunIntensity,
    uAerosol, uOzone, uMieG, uMoonCol, uMoonIntensity, uAirGlowCol, uAirGlowIntensity,
    uStormDarkness, uSandstorm, uLightningFlash, uLightningCol
  );
  float fogCoeff = 0.00013 + uHazeStrength * 0.00075 + uSandstorm * 0.0042 + uRainIntensity * 0.0011;
  float visibility = fogTransmission(dist, uCamPos.y, vWorldPos.y, uFogDensity, uFogHeight, uFogFalloff, fogCoeff);
  color = mix(fogCol, color, visibility);

  color *= uExposure;
  color = displayTonemap(color);
  color = pow(color, vec3(1.0 / 2.2));
  fragColor = vec4(color, 1.0);
}
`;

// ============================================================================
// PASS 3: MULTI-OCTAVE GERSTNER OCEAN (OceanSimPresets + WEATHER.XML)
// ============================================================================
const SURF_GLSL = /* glsl */ `
uniform highp sampler2D uShoreField;
uniform sampler2D uWavefrontProfile;
uniform sampler2D uShoreVertexProfile;
uniform sampler2D uShorePixelProfile;
uniform float uCoastHalfSize;
uniform bool uNativeWater;

vec4 shoreAt(vec2 xz) {
  vec2 uv = xz / (uCoastHalfSize * 2.0) + 0.5;
  if (!uNativeWater || any(greaterThan(abs(uv - 0.5), vec2(0.496)))) return vec4(0.0);
  return textureLod(uShoreField, uv, 0.0);
}

float seabedAt(highp sampler2D heights, vec2 xz) {
  vec2 uv = xz / (uCoastHalfSize * 2.0) + 0.5;
  float distanceToEdge = 0.5 - max(abs(uv.x - 0.5), abs(uv.y - 0.5));
  if (distanceToEdge <= 0.0) return -24.0;
  return mix(-24.0, textureLod(heights, uv, 0.0).r, smoothstep(0.0, 0.048, distanceToEdge));
}

vec2 surfProfileUV(vec4 band, float time) {
  float waveType = clamp(floor(band.a + 0.5), 0.0, 4.0);
  float along = band.g * 3.1;
  float phase = fract(0.29 + band.r * 0.034 + time * (0.20 + waveType * 0.016) + along);
  return vec2(phase, (waveType + 0.5) / 8.0);
}

float wavefrontAt(vec2 uv) {
  const vec2 width = vec2(0.014, 0.0);
  return textureLod(uWavefrontProfile, uv, 0.0).r * 0.50 +
    (textureLod(uWavefrontProfile, uv - width, 0.0).r +
     textureLod(uWavefrontProfile, uv + width, 0.0).r) * 0.25;
}
`;

const OCEAN_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aGrid; // -1..1

uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform float uTime;
uniform vec2 uWindDirXZ;
uniform float uWindSpeed;
uniform float uOceanWaveAmp;
uniform float uShoreWaveAmp;
uniform float uOceanFetch;
uniform vec3 uOceanBandWeights;
uniform highp sampler2D uHeightTex;

out vec3 vWorldPos;
out vec3 vNormal;
out float vFoamCrest;
out vec2 vRestXZ;

${SURF_GLSL}

// Gerstner wave helper (accumulates displacement + tangent/binormal derivatives)
void addWave(
  vec2 pos, vec2 dir, float wavelength, float amp, float steepness, float speedMult,
  inout vec3 disp, inout vec3 tangent, inout vec3 binormal, inout float crest
) {
  float k = 6.2831853 / wavelength;
  float c = sqrt(9.81 / k) * speedMult;
  vec2 d = normalize(dir);
  float f = k * (dot(d, pos) - c * uTime);
  float a = amp;
  float q = min(1.25, clamp(steepness, 0.0, 0.72) / max(0.0001, k * a * 6.0));
  float cf = cos(f);
  float sf = sin(f);

  disp.x += d.x * (q * a * cf);
  disp.y += a * sf;
  disp.z += d.y * (q * a * cf);

  tangent += vec3(-d.x * d.x * (q * k * a * sf), d.x * (k * a * cf), -d.x * d.y * (q * k * a * sf));
  binormal += vec3(-d.x * d.y * (q * k * a * sf), d.y * (k * a * cf), -d.y * d.y * (q * k * a * sf));
  crest += max(0.0, sf) * (a * k * 1.4);
}

void main() {
  // Non-linear radial distribution: dense near camera/shoreline, stretching cleanly to 4.5 km horizon!
  vec2 sq = aGrid * abs(aGrid);
  vec2 worldXZ = vec2(uCamPos.x, uCamPos.z) + sq * 3600.0;

  // Sample real coast depth if inside the 1280m coastline patch
  float depth = max(0.0, 0.20 - seabedAt(uHeightTex, worldXZ));
  float shoreAtten = smoothstep(0.0, 5.0, depth);
  float distanceXZ = length(worldXZ - uCamPos.xz);
  float distAtten = 1.0 - smoothstep(400.0, 1600.0, distanceXZ);
  float chopAtten = 1.0 - smoothstep(38.0, 220.0, distanceXZ);

  vec4 band = shoreAt(worldXZ);
  float breakBand = band.b * smoothstep(-1.4, 4.0, band.r) * (1.0 - smoothstep(3.0, 8.0, depth));
  float ampScale = uOceanWaveAmp * shoreAtten * distAtten * 0.38 * (1.0 - breakBand * 0.49);
  float spd = 0.85 + clamp(uWindSpeed * 0.025, 0.0, 0.8);
  vec2 wd = normalize(uWindDirXZ + vec2(0.001, 0.001));
  vec2 wd2 = vec2(wd.x * 0.88 - wd.y * 0.47, wd.x * 0.47 + wd.y * 0.88);
  vec2 wd3 = vec2(wd.x * 0.92 + wd.y * 0.39, -wd.x * 0.39 + wd.y * 0.92);
  vec2 wd4 = vec2(-wd.y, wd.x);

  vec3 disp = vec3(0.0);
  vec3 tang = vec3(1.0, 0.0, 0.0);
  vec3 bino = vec3(0.0, 0.0, 1.0);
  float crest = 0.0;

  // 6 ocean octaves (from deep Atlantic fetch swells down to wind-driven chop)
  float fetchScale = clamp(uOceanFetch / 400.0, 0.55, 1.6);
  addWave(worldXZ + vec2(13, -4), wd, 67.0 * fetchScale, ampScale * 0.86 * uOceanBandWeights.x, 0.68, spd, disp, tang, bino, crest);
  addWave(worldXZ + vec2(-27, 8), wd2, 48.0 * fetchScale, ampScale * 0.57 * uOceanBandWeights.x, 0.57, spd, disp, tang, bino, crest);
  addWave(worldXZ, wd * 0.96 - wd4 * 0.28, 38.0 * fetchScale, ampScale * 0.36, 0.49, spd, disp, tang, bino, crest);
  addWave(worldXZ + vec2(-6, 7), wd3, 26.0, ampScale * 0.32 * uOceanBandWeights.y, 0.45, spd, disp, tang, bino, crest);
  addWave(worldXZ, wd3 + wd4 * 0.51, 17.1, ampScale * 0.20 * uOceanBandWeights.y, 0.39, spd, disp, tang, bino, crest);
  addWave(worldXZ, wd + wd2, 11.2, ampScale * 0.12 * uOceanBandWeights.z * chopAtten, 0.35, spd, disp, tang, bino, crest);
  addWave(worldXZ, wd - wd4 * 0.52, 7.3, ampScale * 0.082 * chopAtten, 0.28, spd, disp, tang, bino, crest);
  addWave(worldXZ, wd + wd4 * 0.45, 4.9, (ampScale * 0.044 + uShoreWaveAmp * 0.06 * (1.0 - shoreAtten) *
    smoothstep(0.0, 0.5, depth)) * chopAtten, 0.25, spd, disp, tang, bino, crest);

  vec2 profileUv = surfProfileUV(band, uTime);
  if (breakBand > 0.01) {
    float profile = wavefrontAt(profileUv);
    float shape = textureLod(uShoreVertexProfile, vec2(profileUv.x, 0.40), 0.0).r;
    disp.y += breakBand * pow(profile, 2.2) * (0.28 + shape * 0.72) * min(uShoreWaveAmp, 3.0) * 0.36;
  }
  vec3 pos = vec3(worldXZ.x + disp.x, 0.15 + disp.y, worldXZ.y + disp.z);
  vWorldPos = pos;
  vNormal = normalize(cross(bino, tang));
  float compression = 1.0 - (tang.x * bino.z - tang.z * bino.x);
  vFoamCrest = crest * 0.51 + max(0.0, compression) * 0.57;
  vRestXZ = worldXZ;
  gl_Position = uViewProj * vec4(pos, 1.0);
}
`;

const OCEAN_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vNormal;
in float vFoamCrest;
in vec2 vRestXZ;
out vec4 fragColor;

uniform vec3 uCamPos;
uniform float uTime;
uniform vec2 uWindDirXZ;
uniform float uWindSpeed;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uWavelengthRGB;
uniform vec3 uSkyCol;
uniform vec3 uSunCol;
uniform float uSunIntensity;
uniform float uAerosol;
uniform float uOzone;
uniform float uMieG;
uniform vec3 uMoonCol;
uniform float uMoonIntensity;
uniform vec3 uAirGlowCol;
uniform float uAirGlowIntensity;
uniform float uStormDarkness;
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uFogFalloff;
uniform float uHazeStrength;
uniform float uSandstorm;
uniform float uRainIntensity;
uniform float uOceanFoamIntensity;
uniform float uRippleBumpiness;
uniform float uWaterGustBump;
uniform sampler2D uWaterNoise;
uniform sampler2D uFoamTex;
uniform sampler2D uNativeFoam;
uniform sampler2D uBubbleFoam;
uniform sampler2D uCaustic;
uniform highp sampler2D uHeightTex;
uniform float uLightningFlash;
uniform vec3 uLightningPos;
uniform vec3 uLightningCol;
uniform float uExposure;

${COMMON_ATMOS_GLSL}
${CLOUD_PROBE_GLSL}
${SURF_GLSL}

float sunSpecular(vec3 N, vec3 V, vec3 L, float roughness) {
  vec3 halfVec = V + L;
  float halfLen2 = dot(halfVec, halfVec);
  vec3 H = halfLen2 > 1e-8 ? halfVec * inversesqrt(halfLen2) : N;
  float ndh = max(0.0, dot(N, H));
  float ndl = max(0.0, dot(N, L));
  float ndv = max(0.002, dot(N, V));
  float vdh = max(0.0, dot(V, H));
  float a2 = pow(roughness, 4.0);
  float denom = 1.0 + (a2 - 1.0) * ndh * ndh;
  float distribution = a2 / (PI * denom * denom);
  float smithV = ndl * sqrt(a2 + (1.0 - a2) * ndv * ndv);
  float smithL = ndv * sqrt(a2 + (1.0 - a2) * ndl * ndl);
  float omv = max(0.0, 1.0 - vdh);
  float omv2 = omv * omv;
  float f = 0.0204 + 0.9796 * omv2 * omv2 * omv;
  return min(2.3, distribution * (0.5 / max(smithV + smithL, 0.001)) * f * ndl);
}

void main() {
  vec3 V = normalize(uCamPos - vWorldPos);
  float dist = length(uCamPos - vWorldPos);
  float dayT = smoothstep(-0.10, 0.18, uSunDir.y);

  // Micro-capillary ripples + raindrop dimples + wind-gust water roughness (Water_WindGusts_MaxBumpIntensity)
  vec2 wd = uWindDirXZ;
  vec2 crosswind = vec2(-wd.y, wd.x);
  vec2 waterUV = vec2(dot(vWorldPos.xz, wd), dot(vWorldPos.xz, crosswind));
  vec2 drift = vec2(uTime * (0.033 + uWindSpeed * 0.0015), uTime * 0.008);
  vec2 n1 = texture(uWaterNoise, waterUV * vec2(0.075, 0.034) - drift).ga - vec2(0.553, 0.502);
  vec2 n2 = texture(uWaterNoise, waterUV.yx * vec2(0.20, 0.095) + drift * 1.45).ag - vec2(0.502, 0.553);
  vec2 capillary = texture(uWaterNoise, waterUV * vec2(0.55, 0.37) - drift.yx * 2.94).ga - vec2(0.553, 0.502);
  vec2 chop = n1 * 0.82 + n2 * 0.47 + capillary * (0.12 + uRainIntensity * 0.26);
  vec2 slope = wd * chop.x + crosswind * chop.y;
  float bumpStrength = 0.27 + uRippleBumpiness * 0.07 + uWaterGustBump * 0.33 + uRainIntensity * 0.19;
  vec3 N = normalize(vNormal + vec3(slope.x, 0.0, slope.y) * bumpStrength);

  // Fresnel reflection of live sky
  float ndv = max(dot(N, V), 0.001);
  float omn = max(0.0, 1.0 - ndv);
  float omn2 = omn * omn;
  float fresnel = 0.0204 + 0.9796 * omn2 * omn2 * omn;

  vec3 R = reflect(-V, N);
  float horizonBlock = smoothstep(-0.13, 0.03, R.y);
  R = normalize(vec3(R.x, max(R.y, 0.001), R.z));
  vec3 skyRefl = evalSky(
    R, uSunDir, uMoonDir, uWavelengthRGB, uSkyCol, uSunCol, uSunIntensity,
    uAerosol, uOzone, uMieG, uMoonCol, uMoonIntensity, uAirGlowCol, uAirGlowIntensity,
    uStormDarkness, uSandstorm, uLightningFlash, uLightningCol
  );
  skyRefl = compositeClouds(skyRefl, R, 0.17 + uRainIntensity * 0.68);

  // Refract into the depth field. Light travels to the bottom and back
  // through RGB absorption; deep water is lit by volume scatter, not sand tint.
  float depth = max(0.06, vWorldPos.y - seabedAt(uHeightTex, vRestXZ));
  vec3 transmitted = refract(-V, N, 0.7519);
  vec2 bottom = vWorldPos.xz + transmitted.xz * min(depth, 8.0) / max(0.38, -transmitted.y);
  float bottomDepth = max(0.06, vWorldPos.y - seabedAt(uHeightTex, bottom));
  depth = mix(depth, bottomDepth, 0.38 * (1.0 - smoothstep(4.0, 9.0, depth)));
  float path = depth * (1.23 + 0.85 / max(0.38, -transmitted.y));
  vec3 transmit = exp(-path * vec3(0.63, 0.235, 0.154));
  float sandTexture = 0.80 + 0.32 * valueNoise2(bottom * 0.73) + 0.20 * valueNoise2(bottom * 0.16);
  float sunThrough = dayT * (1.0 - 0.80 * uStormDarkness) * clamp(0.24 + uSunDir.y, 0.0, 1.0);
  vec3 deep = mix(vec3(0.0008, 0.0030, 0.0075), vec3(0.004, 0.038, 0.071), dayT) * (1.0 - uStormDarkness * 0.72);
  vec2 causticUV = bottom * 0.34;
  float caustic = texture(uCaustic, causticUV + vec2(uTime * 0.043, uTime * -0.024) + chop * 0.09).r;
  caustic = pow(caustic, 1.7) * (1.0 - smoothstep(1.0, 6.0, depth));
  vec3 seafloor = vec3(0.43, 0.36, 0.24) * sandTexture * (0.06 + sunThrough * (0.57 + caustic * 0.57));
  vec3 waterBody = deep * (1.0 - transmit) + seafloor * transmit;

  // Subsurface scattering glow through wave crests facing the sun
  float sss = pow(max(0.0, dot(V, normalize(-uSunDir + N * 0.53))), 4.0);
  waterBody += vec3(0.007, 0.14, 0.12) * sss * sunThrough * smoothstep(0.16, 1.55, vWorldPos.y);

  vec3 col = mix(waterBody, skyRefl * mix(0.34, 0.78, horizonBlock), fresnel);

  // Sun / Moon specular glints dancing across ocean swells
  vec3 L = (uSunDir.y > -0.02) ? uSunDir : uMoonDir;
  float roughness = clamp(0.12 + uWindSpeed * 0.004 + uRainIntensity * 0.053 + smoothstep(54.0, 440.0, dist) * 0.08, 0.12, 0.33);
  float glint = sunSpecular(N, V, L, roughness);
  float twilightNorm = (uSunDir.y - 0.02) / 0.14;
  float twilightT = exp(-(twilightNorm * twilightNorm));
  vec3 glintCol = (uSunDir.y > -0.02)
    ? mix(uSunCol * 3.8, vec3(3.6, 1.4, 0.55), twilightT) * (1.0 - uStormDarkness * 0.88) * dayT
    : uMoonCol * 0.9 * (1.0 - dayT) * smoothstep(-0.02, 0.12, uMoonDir.y) * (1.0 - uStormDarkness * 0.8);
  col += glintCol * glint;

  // Lightning reflection streak on dark storm ocean
  if (uLightningFlash > 0.01) {
    vec2 strikeDelta = uLightningPos.xz - vWorldPos.xz;
    float falloff = 1.0 / (1.0 + dot(strikeDelta, strikeDelta) / 90000.0);
    vec3 lDir = normalize(vec3(strikeDelta.x, 90.0, strikeDelta.y));
    float lSpec = sunSpecular(N, V, lDir, 0.27);
    // A vertical channel gives a streak, not a uniform white flash over the sea.
    vec2 rDir = dot(R.xz, R.xz) > 1e-8 ? normalize(R.xz) : vec2(0.0, 1.0);
    float crossRay = abs(strikeDelta.x * rDir.y - strikeDelta.y * rDir.x);
    float travel = max(0.0, dot(strikeDelta, rDir));
    float streak = exp(-crossRay / (0.9 + travel * 0.019)) * smoothstep(0.02, 0.14, R.y) *
      (1.0 - smoothstep(115.0, 270.0, travel * R.y)) * smoothstep(0.0, 15.0, travel);
    col += uLightningCol * uLightningFlash * falloff * (0.028 + lSpec * 0.85 + streak * fresnel * 1.65);
  }

  // Whitecaps on steep storm waves + breaking shoreline surf foam
  float foamNoise = texture(uFoamTex, waterUV * 0.12 - drift * 0.7).r;
  float foamCells = smoothstep(0.26, 0.72, foamNoise + 0.12 * valueNoise2(vWorldPos.xz * 0.82));
  float crestFoam = smoothstep(0.31, 0.69, vFoamCrest + foamNoise * 0.08) * clamp(uOceanFoamIntensity * 1.6, 0.0, 1.0);
  float wash = valueNoise2(vRestXZ * 0.30 - wd * uTime * 0.38);
  float surfBand = (1.0 - smoothstep(0.20, 1.65, depth)) * smoothstep(0.34, 0.83, wash + foamNoise * 0.12);
  if (uNativeWater) {
    vec4 band = shoreAt(vWorldPos.xz);
    vec2 profileUv = surfProfileUV(band, uTime);
    profileUv.x = fract(profileUv.x + 0.24 * (valueNoise2(vWorldPos.xz * 0.19) - 0.5));
    float wavefront = wavefrontAt(profileUv);
    float profile = texture(uShorePixelProfile, vec2(profileUv.x, 0.52)).b;
    vec4 thread = texture(uNativeFoam, waterUV * 0.064 - drift * 0.34);
    vec4 bubbles = texture(uBubbleFoam, vWorldPos.xz * 0.23 + drift * 0.28);
    foamCells = smoothstep(0.45, 0.80, thread.r * 0.65 + bubbles.g * 0.35);
    float breaking = smoothstep(0.46, 0.83, wavefront * (0.76 + profile * 0.33));
    float local = (1.0 - smoothstep(2.6, 7.0, depth)) * smoothstep(0.23, 0.68, wash + bubbles.g * 0.25);
    surfBand = local * band.b * smoothstep(-2.0, 2.0, band.r) * (0.07 + breaking * 0.79) + surfBand * 0.29;
  }
  float foam = clamp(crestFoam + surfBand * 0.89, 0.0, 1.0) * foamCells * exp(-dist * 0.0010);
  vec3 foamCol = mix(vec3(0.14, 0.18, 0.24), vec3(0.88, 0.93, 0.96), dayT) * mix(1.0, 0.55, uStormDarkness) + uLightningCol * uLightningFlash * 0.55;
  col = mix(col, foamCol, foam * 0.85);

  // Seamless horizon fog blend
  vec3 viewDir = normalize(vWorldPos - uCamPos);
  vec3 fogDir = safeNormalizeUpper(viewDir);
  vec3 fogCol = evalSky(
    fogDir,
    uSunDir, uMoonDir, uWavelengthRGB, uSkyCol, uSunCol, uSunIntensity,
    uAerosol, uOzone, uMieG, uMoonCol, uMoonIntensity, uAirGlowCol, uAirGlowIntensity,
    uStormDarkness, uSandstorm, uLightningFlash, uLightningCol
  );
  fogCol = compositeClouds(fogCol, fogDir, 0.0);
  float fogCoeff = 0.00016 + uHazeStrength * 0.00075 + uSandstorm * 0.0038 + uRainIntensity * 0.0009;
  float visibility = fogTransmission(dist, uCamPos.y, vWorldPos.y, uFogDensity, uFogHeight, uFogFalloff, fogCoeff);
  float fogFactor = max(1.0 - visibility, smoothstep(2100.0, 3500.0, dist));
  col = mix(col, fogCol, fogFactor);

  col *= uExposure;
  col = displayTonemap(col);
  col = pow(col, vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}
`;

// ============================================================================
// PASS 4A: GPU 3D PRECIPITATION (RAIN STREAKS / HAIL / SANDSTORM)
// ============================================================================
const PRECIP_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aSeed; // xyz in [0..1], w = vertex end (0=top, 1=bottom)

uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform float uTime;
uniform vec2 uWindDirXZ;
uniform float uWindSpeed;
uniform float uRainIntensity;
uniform float uHailIntensity;
uniform float uSandstorm;

out float vAlpha;
out float vMode; // 0=rain, 1=hail, 2=sand

void main() {
  float box = 48.0;
  float fallSpeed = (uSandstorm > 0.3) ? 2.5 : (uHailIntensity > 0.3 ? 28.0 : 22.0 + uRainIntensity * 12.0);
  vec3 windVel = vec3(uWindDirXZ.x * uWindSpeed * 0.55, -fallSpeed, uWindDirXZ.y * uWindSpeed * 0.55);

  vec3 local = fract(aSeed.xyz + (windVel * uTime - uCamPos) / box) * box - box * 0.5;
  vec3 worldPos = uCamPos + local;

  float streakLen = (uSandstorm > 0.3) ? 0.55 : (uHailIntensity > 0.3 ? 0.38 : 0.75 + uRainIntensity * 0.65);
  vec3 dir = normalize(windVel);
  worldPos += dir * (aSeed.w * streakLen);

  float distFade = 1.0 - smoothstep(4.0, 24.0, length(local));
  float activeAmt = max(max(uRainIntensity, uHailIntensity), uSandstorm);
  // Hide fraction of particles proportionally to intensity so light drizzle stays sparse
  float show = step(aSeed.x, activeAmt * 1.05);
  vAlpha = distFade * show * activeAmt;
  vMode = (uSandstorm > 0.3) ? 2.0 : (uHailIntensity > 0.3 ? 1.0 : 0.0);

  gl_Position = uViewProj * vec4(worldPos, 1.0);
}
`;

const PRECIP_FS = /* glsl */ `#version 300 es
precision highp float;
in float vAlpha;
in float vMode;
out vec4 fragColor;

uniform vec3 uSunDir;
uniform float uLightningFlash;
uniform vec3 uLightningCol;

void main() {
  if (vAlpha <= 0.01) discard;
  float dayT = smoothstep(-0.12, 0.2, uSunDir.y);
  vec3 col;
  float a;
  if (vMode > 1.5) {
    // Sandstorm dust streaks
    col = mix(vec3(0.45, 0.32, 0.20), vec3(0.88, 0.68, 0.44), dayT);
    a = vAlpha * 0.32;
  } else if (vMode > 0.5) {
    // Hailstones (bright icy white)
    col = mix(vec3(0.55, 0.65, 0.8), vec3(0.95, 0.98, 1.0), dayT) + uLightningCol * uLightningFlash;
    a = vAlpha * 0.72;
  } else {
    // Tropical rain streaks catching skylight + lightning
    col = mix(vec3(0.32, 0.40, 0.52), vec3(0.76, 0.84, 0.92), dayT) + uLightningCol * uLightningFlash * 1.4;
    a = vAlpha * (0.18 + uLightningFlash * 0.21);
  }
  fragColor = vec4(col, a);
}
`;

// ============================================================================
// PASS 4B: 3D BRANCHING LIGHTNING BOLTS (20,000K-40,000K PLANCK PLASMA)
// ============================================================================
const BOLT_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aTangent;
layout(location = 2) in vec4 aChannel;
uniform mat4 uViewProj;
uniform vec2 uResolution;
uniform float uTanHalfFov;
out vec4 vChannel;
out float vRange;
void main() {
  vec4 p = uViewProj * vec4(aPos, 1.0);
  vec4 d = uViewProj * vec4(aTangent, 0.0);
  vec2 along = (d.xy * p.w - p.xy * d.w) * uResolution;
  vec2 normal = vec2(-along.y, along.x) / max(length(along), 0.0001);
  float width = (1.15 + 2.45 * aChannel.y) * uResolution.y / (2.0 * uTanHalfFov * max(1.0, p.w));
  width = max(3.0 * uResolution.y / 1080.0, width);
  p.xy += normal * aChannel.x * width * 2.0 / uResolution * p.w;
  gl_Position = p;
  vChannel = aChannel;
  vRange = p.w;
}
`;

const BOLT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 vChannel;
in float vRange;
out vec4 fragColor;
uniform vec3 uLightningCol;
uniform float uLightningFlash;
uniform float uBoltAge;
void main() {
  float channel = vChannel.y;
  float visible = smoothstep(0.0, 0.018, uBoltAge + 0.012 - vChannel.z - vChannel.w * 0.024);
  if (vChannel.z == 0.0) visible *= smoothstep(0.0, 0.074, vChannel.w);
  float returnStroke = 1.0 + 0.10 * sin(vChannel.w * 83.0 + uBoltAge * 174.0);
  float x = abs(vChannel.x);
  float coreWidth = mix(0.105, 0.235, channel);
  float aa = min(0.26, fwidth(x) * 0.58);
  float core = (1.0 - smoothstep(coreWidth * 0.45, coreWidth + aa, x)) * channel * 1.38;
  float corona = exp(-x * x * 8.0) * channel * 0.23 + exp(-x * x * 2.7) * channel * 0.065;
  float edge = 1.0 - smoothstep(0.70, 1.0, x);
  vec3 glow = vec3(0.38, 0.46, 1.0) * uLightningCol;
  vec3 col = mix(uLightningCol, vec3(1.0), 0.78) * core + glow * corona;
  fragColor = vec4(col * edge * visible * returnStroke * uLightningFlash * exp(-max(vRange, 0.0) * 0.00035), 1.0);
}
`;

export class WeatherRenderer {
  private gl: WebGL2RenderingContext;
  private cloudProg: WebGLProgram;
  private skyProg: WebGLProgram;
  private terrainProg: WebGLProgram;
  private oceanProg: WebGLProgram;
  private precipProg: WebGLProgram;
  private boltProg: WebGLProgram;

  private emptyVao: WebGLVertexArrayObject;
  private terrainVao: WebGLVertexArrayObject;
  private terrainIndexCount = 0;
  private structures: { vao: WebGLVertexArrayObject; count: number } | null = null;
  private palmsVao: WebGLVertexArrayObject | null = null;
  private palmVertexCount = 0;
  private oceanVao: WebGLVertexArrayObject;
  private oceanIndexCount = 0;
  private precipVao: WebGLVertexArrayObject;
  private precipVertexCount = 0;
  private boltVao: WebGLVertexArrayObject;
  private boltVbo: WebGLBuffer;
  private boltVertexCount = 0;
  private lastBoltSeed = -1;
  private landHeights: Float32Array | null;
  private landGridSize: number;

  private heightTex: WebGLTexture;
  private surfaceTex: WebGLTexture;
  private cloudMapsTex: WebGLTexture;
  private cloudNoiseTex: WebGLTexture;
  private blueNoiseTex: WebGLTexture;
  private waterNoiseTex: WebGLTexture;
  private foamTex: WebGLTexture;
  private causticTex: WebGLTexture;
  private cloudProbe: WebGLTexture;
  private cloudFramebuffer: WebGLFramebuffer;
  private cloudLayers = new Map<string, number>();
  private probeWidth = 768;
  private probeHeight = 256;
  private cloudView: WebGLTexture;
  private cloudViewWidth = 0;
  private cloudViewHeight = 0;
  private cloudViewBasis = new Float32Array(9);
  private cloudViewTan: [number, number] = [1, 1];
  private nextCloudView = 0;
  private coastHalfSize = 640;

  private elapsed = 0;
  private nextCloudUpdate = 0;
  private windOffset: [number, number] = [0, 0];
  private noiseScale: number[];
  private cumulusWeights: [number[], number[]];
  private nimbusWeights: [number[], number[]];
  private noiseWeights = new Float32Array(6);
  private buffers: WebGLBuffer[] = [];
  private archiveMeshes: WebGLVertexArrayObject[] = [];
  private archiveTextures: WebGLTexture[] = [];
  private archiveProps: {
    vao: WebGLVertexArrayObject;
    instances: number;
    wind: boolean;
    batches: { texture: WebGLTexture; count: number; offset: number }[];
  }[] = [];
  private nativeNoise: WebGLTexture;
  private shoreField: WebGLTexture;
  private waterDetail: WebGLTexture[];
  private nativeScene: boolean;

  constructor(
    canvas: HTMLCanvasElement,
    coastHeights: Float32Array,
    coastMats: Uint8Array,
    coastMeta: CoastMeta,
    sts: WeatherDataset['stsConfig'],
    assets: VisualAssets,
    scene: SceneInputs | null = null,
  ) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.coastHalfSize = coastMeta.worldSizeMeters * 0.5;
    this.nativeScene = scene !== null;
    this.landHeights = scene?.heights ?? coastHeights;
    this.landGridSize = scene?.gridSize ?? coastMeta.gridSize;
    if (scene && (Math.abs(scene.depthHalfExtent - this.coastHalfSize) > 0.001 ||
        scene.center[0] !== coastMeta.originWorldX + this.coastHalfSize ||
        scene.center[1] !== coastMeta.originWorldY + this.coastHalfSize)) {
      throw new Error('Scene and coastline use different map origins');
    }
    const vector = (v: unknown, fallback: number[]) => Array.isArray(v) && v.length >= 3 ? v.slice(0, 3) : fallback;
    const weights = (name: string, fallback: number[]): [number[], number[]] => {
      const layer = sts[name];
      if (!layer || typeof layer === 'number' || Array.isArray(layer)) return [fallback, fallback];
      return [vector(layer.NoiseWeightsLow, fallback), vector(layer.NoiseWeightsHigh, fallback)];
    };
    this.noiseScale = vector(sts.CloudNoiseScale, [4000, 1000, 200]);
    this.cumulusWeights = weights('Cumulus', [0.3, 0.5, 0.15]);
    this.nimbusWeights = weights('Nimbus', [0.5, 0.3, 0.1]);

    this.cloudProg = linkProgram(gl, SKY_VS, cloudFragment(COMMON_ATMOS_GLSL), 'cloud probe');
    this.skyProg = linkProgram(gl, SKY_VS, SKY_FS, 'sky');
    this.terrainProg = linkProgram(gl, TERRAIN_VS, TERRAIN_FS, 'terrain');
    this.oceanProg = linkProgram(gl, OCEAN_VS, OCEAN_FS, 'ocean');
    this.precipProg = linkProgram(gl, PRECIP_VS, PRECIP_FS, 'precip');
    this.boltProg = linkProgram(gl, BOLT_VS, BOLT_FS, 'bolt');

    this.emptyVao = gl.createVertexArray()!;
    this.surfaceTex = this.createSurfaceTexture(coastMats, coastMeta.gridSize);
    if (scene) {
      this.heightTex = this.createHeightTexture(scene.depth, scene.gridSize);
      this.terrainVao = this.buildArchiveMesh(scene.land);
      this.terrainIndexCount = scene.land.indices.length;
      if (scene.structures.indices.length) {
        this.structures = { vao: this.buildArchiveMesh(scene.structures), count: scene.structures.indices.length };
      }
      const blank = this.createDetailTexture(null, [163, 150, 128, 255], false);
      this.archiveTextures.push(blank);
      const textures = new Map<string, WebGLTexture>();
      for (const [key, image] of scene.textures) {
        const texture = this.createDetailTexture(image, [], true);
        textures.set(key, texture);
        this.archiveTextures.push(texture);
      }
      for (const model of scene.models) {
        const placement = model.placements;
        if (!placement.length) continue;
        let offset = 0;
        this.archiveProps.push({
          vao: this.buildArchiveMesh(model, placement),
          instances: placement.length / 5,
          wind: model.wind,
          batches: model.batches.map((batch) => {
            const texture = (batch.texture && textures.get(batch.texture)) || blank;
            const out = { texture, count: batch.indexCount, offset };
            offset += batch.indexCount * 4;
            return out;
          }),
        });
      }
    } else {
      this.heightTex = this.createHeightTexture(coastHeights, coastMeta.gridSize);
      this.terrainVao = this.buildTerrainMesh(coastHeights, coastMeta);
      this.palmsVao = this.buildPalmMesh(buildPalms(coastHeights, coastMats, coastMeta));
    }
    this.oceanVao = this.buildOceanMesh(scene ? 224 : 192);
    this.precipVao = this.buildPrecipMesh(3200);
    this.cloudMapsTex = this.createCloudMaps(assets.cloudMaps);
    this.cloudNoiseTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.cloudNoiseTex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 64, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, makeCloudNoise());
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.nativeNoise = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.nativeNoise);
    const nativeSize = scene ? 32 : 1;
    const nativeBytes = scene?.noise ?? new Uint8Array([174]);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, nativeSize, nativeSize, nativeSize, 0, gl.RED, gl.UNSIGNED_BYTE, nativeBytes);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.shoreField = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.shoreField);
    const fieldSize = scene?.gridSize ?? 1;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, fieldSize, fieldSize, 0, gl.RGBA, gl.FLOAT, scene?.shoreline ?? new Float32Array(4));
    const fieldFilter = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, fieldFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, fieldFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.waterDetail = Array.from({ length: 5 }, (_, j) => this.createDetailTexture(scene?.detail[j] ?? null, [128, 128, 128, 255], true));
    this.blueNoiseTex = this.createDetailTexture(assets.blueNoise, [128, 128, 128, 255], false);
    this.waterNoiseTex = this.createDetailTexture(assets.waterNoise, [0, 141, 0, 128], true);
    this.foamTex = this.createDetailTexture(assets.foam, [84, 84, 84, 255], true);
    this.causticTex = this.createDetailTexture(assets.caustic, [0, 0, 0, 255], true);
    const anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
    if (anisotropy) {
      const amount = Math.min(8, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
      for (const tex of [this.waterNoiseTex, this.foamTex, this.causticTex, ...this.waterDetail.slice(0, 2)]) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, amount);
      }
    }
    this.cloudView = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.cloudView);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.cloudProbe = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.cloudProbe);
    gl.texStorage2D(gl.TEXTURE_2D, 5, gl.RGBA8, this.probeWidth, this.probeHeight);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.cloudFramebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cloudFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.cloudProbe, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Cloud buffer is incomplete');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.boltVao = gl.createVertexArray()!;
    this.boltVbo = gl.createBuffer()!;
    this.buffers.push(this.boltVbo);
    gl.bindVertexArray(this.boltVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boltVbo);
    for (const [loc, count, offset] of [[0, 3, 0], [1, 3, 12], [2, 4, 24]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, count, gl.FLOAT, false, 40, offset);
    }
    gl.bindVertexArray(null);
  }

  private buildArchiveMesh(mesh: SceneInputs['land'], instances?: Float32Array): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    const vertex = gl.createBuffer()!;
    const index = gl.createBuffer()!;
    this.buffers.push(vertex, index);
    this.archiveMeshes.push(vao);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertex);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    for (const [loc, count, offset] of [[0, 3, 0], [1, 3, 12], [2, 2, 24]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, count, gl.FLOAT, false, 32, offset);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    if (instances) {
      const placement = gl.createBuffer()!;
      this.buffers.push(placement);
      gl.bindBuffer(gl.ARRAY_BUFFER, placement);
      gl.bufferData(gl.ARRAY_BUFFER, instances, gl.STATIC_DRAW);
      for (const [loc, count, offset] of [[4, 4, 0], [5, 1, 16]]) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, count, gl.FLOAT, false, 20, offset);
        gl.vertexAttribDivisor(loc, 1);
      }
    }
    gl.bindVertexArray(null);
    return vao;
  }

  private createHeightTexture(heights: Float32Array, size: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const filter = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, size, size, 0, gl.RED, gl.FLOAT, heights);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private createSurfaceTexture(mats: Uint8Array, size: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, mats);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private createCloudMaps(images: Map<string, ImageBitmap>): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 5, gl.RGBA8, 256, 256, images.size + 1);
    for (const [name, img] of images) {
      const layer = this.cloudLayers.size + 1;
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, 256, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, img);
      this.cloudLayers.set(name, layer);
    }
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  private createDetailTexture(image: ImageBitmap | null, fallback: number[], mipmapped: boolean): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (image) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(fallback));
    if (mipmapped) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mipmapped ? gl.LINEAR : gl.NEAREST);
    return tex;
  }

  private buildTerrainMesh(heights: Float32Array, meta: CoastMeta): WebGLVertexArrayObject {
    const gl = this.gl;
    const W = meta.gridSize;
    const span = meta.worldSizeMeters;
    const half = span * 0.5;
    const cell = span / (W - 1);

    const verts = new Float32Array(W * W * 6);
    const getH = (x: number, y: number) => {
      const cx = Math.max(0, Math.min(W - 1, x));
      const cy = Math.max(0, Math.min(W - 1, y));
      return heights[cy * W + cx];
    };

    for (let iy = 0; iy < W; iy++) {
      for (let ix = 0; ix < W; ix++) {
        const idx = iy * W + ix;
        const wx = -half + ix * cell;
        const wz = -half + iy * cell;
        const wy = getH(ix, iy);

        const hL = getH(ix - 1, iy);
        const hR = getH(ix + 1, iy);
        const hD = getH(ix, iy - 1);
        const hU = getH(ix, iy + 1);
        let nx = hL - hR;
        let ny = 2.0 * cell;
        let nz = hD - hU;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;

        const o = idx * 6;
        verts[o] = wx;
        verts[o + 1] = wy;
        verts[o + 2] = wz;
        verts[o + 3] = nx;
        verts[o + 4] = ny;
        verts[o + 5] = nz;
      }
    }

    const indices = new Uint32Array((W - 1) * (W - 1) * 6);
    let ptr = 0;
    for (let iy = 0; iy < W - 1; iy++) {
      for (let ix = 0; ix < W - 1; ix++) {
        const i00 = iy * W + ix;
        const i10 = i00 + 1;
        const i01 = i00 + W;
        const i11 = i01 + 1;
        indices[ptr++] = i00;
        indices[ptr++] = i01;
        indices[ptr++] = i10;
        indices[ptr++] = i10;
        indices[ptr++] = i01;
        indices[ptr++] = i11;
      }
    }
    this.terrainIndexCount = indices.length;

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    const ebo = gl.createBuffer()!;
    this.buffers.push(vbo, ebo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    const stride = 6 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.bindVertexArray(null);
    return vao;
  }

  private buildOceanMesh(res: number): WebGLVertexArrayObject {
    const gl = this.gl;
    const verts = new Float32Array((res + 1) * (res + 1) * 2);
    let p = 0;
    for (let y = 0; y <= res; y++) {
      for (let x = 0; x <= res; x++) {
        verts[p++] = (x / res) * 2 - 1;
        verts[p++] = (y / res) * 2 - 1;
      }
    }
    const indices = new Uint32Array(res * res * 6);
    let idx = 0;
    const row = res + 1;
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i00 = y * row + x;
        indices[idx++] = i00;
        indices[idx++] = i00 + row;
        indices[idx++] = i00 + 1;
        indices[idx++] = i00 + 1;
        indices[idx++] = i00 + row;
        indices[idx++] = i00 + row + 1;
      }
    }
    this.oceanIndexCount = indices.length;

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const ebo = gl.createBuffer()!;
    this.buffers.push(vbo, ebo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  private buildPalmMesh(verts: Float32Array): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    this.buffers.push(vbo);
    this.palmVertexCount = verts.length / 11;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    for (const [attribute, count, offset] of [[0, 3, 0], [1, 3, 3], [2, 3, 6], [3, 2, 9]]) {
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attribute, count, gl.FLOAT, false, 44, offset * 4);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  private buildPrecipMesh(count: number): WebGLVertexArrayObject {
    const gl = this.gl;
    const data = new Float32Array(count * 2 * 4);
    let o = 0;
    for (let i = 0; i < count; i++) {
      const rx = Math.random();
      const ry = Math.random();
      const rz = Math.random();
      data[o++] = rx;
      data[o++] = ry;
      data[o++] = rz;
      data[o++] = 0.0;
      data[o++] = rx;
      data[o++] = ry;
      data[o++] = rz;
      data[o++] = 1.0;
    }
    this.precipVertexCount = count * 2;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    this.buffers.push(vbo);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  private rebuildLightningBolt(wx: number, wz: number, cloudBase: number, seed: number): void {
    const gx = Math.round((wx / this.coastHalfSize * 0.5 + 0.5) * (this.landGridSize - 1));
    const gz = Math.round((wz / this.coastHalfSize * 0.5 + 0.5) * (this.landGridSize - 1));
    const inside = gx >= 0 && gz >= 0 && gx < this.landGridSize && gz < this.landGridSize;
    const ground = Math.max(0.15, inside ? this.landHeights?.[gz * this.landGridSize + gx] ?? 0 : 0);
    const tris = lightningChannels([wx, ground, wz], Math.max(210, cloudBase * 0.84 + 70 - ground), seed);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boltVbo);
    gl.bufferData(gl.ARRAY_BUFFER, tris, gl.DYNAMIC_DRAW);
    this.boltVertexCount = tris.length / 10;
  }

  private setAtmosUniforms(prog: WebGLProgram, state: WeatherRuntimeState): void {
    const gl = this.gl;
    gl.uniform3fv(gl.getUniformLocation(prog, 'uSunDir'), state.sunDir);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uMoonDir'), state.moonDir);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uWavelengthRGB'), state.wavelengthRGB);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uSkyCol'), state.skyCol);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uSunCol'), state.sunCol);
    gl.uniform1f(gl.getUniformLocation(prog, 'uSunIntensity'), state.sunIntensity);
    gl.uniform1f(gl.getUniformLocation(prog, 'uAerosol'), state.aerosolDensity);
    gl.uniform1f(gl.getUniformLocation(prog, 'uOzone'), state.ozoneConcentration);
    gl.uniform1f(gl.getUniformLocation(prog, 'uMieG'), state.mieEccentricity);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uMoonCol'), state.moonCol);
    gl.uniform1f(gl.getUniformLocation(prog, 'uMoonIntensity'), state.moonIntensity);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uAirGlowCol'), state.airGlowCol);
    gl.uniform1f(gl.getUniformLocation(prog, 'uAirGlowIntensity'), state.airGlowIntensity);
    gl.uniform1f(gl.getUniformLocation(prog, 'uStormDarkness'), state.cloudStormDarkness);
    gl.uniform1f(gl.getUniformLocation(prog, 'uSandstorm'), state.sandstormIntensity);
    gl.uniform1f(gl.getUniformLocation(prog, 'uLightningFlash'), state.lightning.flashIntensity);
    gl.uniform3f(
      gl.getUniformLocation(prog, 'uLightningPos'),
      state.lightning.worldX,
      state.cloudBaseHeight,
      state.lightning.worldZ,
    );
    gl.uniform3fv(gl.getUniformLocation(prog, 'uLightningCol'), state.lightning.colorRGB);
    gl.uniform1f(gl.getUniformLocation(prog, 'uExposure'), state.exposure);
    gl.uniform4fv(gl.getUniformLocation(prog, 'uFilmicABCD'), state.filmicCurve, 0, 4);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uFilmicEFW'), state.filmicCurve, 4, 3);
    gl.uniform1f(gl.getUniformLocation(prog, 'uFogDensity'), state.fogDensity);
    gl.uniform1f(gl.getUniformLocation(prog, 'uFogHeight'), state.fogHeight);
    gl.uniform1f(gl.getUniformLocation(prog, 'uFogFalloff'), state.fogFalloff);
  }

  private bindTexture(prog: WebGLProgram, name: string, unit: number, texture: WebGLTexture, target: number = this.gl.TEXTURE_2D): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, texture);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
  }

  private setCloudMaps(prog: WebGLProgram, state: WeatherRuntimeState): void {
    const gl = this.gl;
    const layer = (name: string) => this.cloudLayers.get(name) ?? 0;
    const fromA = layer(state.cloudMapsFrom[0]);
    const fromB = layer(state.cloudMapsFrom[1]);
    const toA = layer(state.cloudMapsTo[0]);
    const toB = layer(state.cloudMapsTo[1]);
    this.bindTexture(prog, 'uCloudMaps', 2, this.cloudMapsTex, gl.TEXTURE_2D_ARRAY);
    gl.uniform4i(gl.getUniformLocation(prog, 'uCloudMapLayers'), fromA || fromB ? fromA : -1, fromB, toA || toB ? toA : -1, toB);
    gl.uniform1f(gl.getUniformLocation(prog, 'uCloudMapBlend'), state.cloudMapBlend);
    gl.uniform1f(gl.getUniformLocation(prog, 'uCloudCoverage'), state.cloudCoverage);
    gl.uniform2fv(gl.getUniformLocation(prog, 'uWindOffset'), this.windOffset);
  }

  private drawClouds(cam: CameraState, state: WeatherRuntimeState, probe: boolean, view: boolean): void {
    const gl = this.gl;
    const prog = this.cloudProg;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cloudFramebuffer);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    this.setAtmosUniforms(prog, state);
    this.setCloudMaps(prog, state);
    this.bindTexture(prog, 'uCloudNoise', 3, this.cloudNoiseTex, gl.TEXTURE_3D);
    this.bindTexture(prog, 'uNativeNoise', 8, this.nativeNoise, gl.TEXTURE_3D);
    gl.uniform1i(gl.getUniformLocation(prog, 'uHasNativeNoise'), Number(this.nativeScene));
    this.bindTexture(prog, 'uBlueNoise', 4, this.blueNoiseTex);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uCamPos'), cam.pos);
    gl.uniform1f(gl.getUniformLocation(prog, 'uCloudBase'), state.cloudBaseHeight);
    gl.uniform1f(gl.getUniformLocation(prog, 'uCloudTop'), Math.max(state.cloudTopHeight, state.cloudBaseHeight + 300));
    gl.uniform1f(gl.getUniformLocation(prog, 'uCloudDensity'), state.cloudDensity);
    gl.uniform1f(gl.getUniformLocation(prog, 'uCloudAnisotropy'), state.cloudAnisotropy);
    gl.uniform1f(gl.getUniformLocation(prog, 'uCloudMultiScatter'), state.cloudMultiScatter);
    gl.uniform1f(gl.getUniformLocation(prog, 'uCloudPowderExp'), state.cloudPowderExp);
    gl.uniform1f(gl.getUniformLocation(prog, 'uCloudWindShear'), state.cloudWindShear);
    gl.uniform2fv(gl.getUniformLocation(prog, 'uWindDirXZ'), state.windDirXZ);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uNoiseScale'), this.noiseScale);
    for (let i = 0; i < 6; i++) {
      const a = this.cumulusWeights[Math.floor(i / 3)][i % 3];
      const b = this.nimbusWeights[Math.floor(i / 3)][i % 3];
      this.noiseWeights[i] = a + (b - a) * state.cloudStormDarkness;
    }
    gl.uniform3fv(gl.getUniformLocation(prog, 'uStsWeightsLow'), this.noiseWeights, 0, 3);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uStsWeightsHigh'), this.noiseWeights, 3, 3);
    gl.bindVertexArray(this.emptyVao);
    const viewPass = gl.getUniformLocation(prog, 'uViewPass');
    if (probe) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.cloudProbe, 0);
      gl.viewport(0, 0, this.probeWidth, this.probeHeight);
      gl.uniform1i(viewPass, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (view) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.cloudView, 0);
      gl.viewport(0, 0, this.cloudViewWidth, this.cloudViewHeight);
      gl.uniform1i(viewPass, 1);
      gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'uCloudViewBasis'), false, this.cloudViewBasis);
      gl.uniform2fv(gl.getUniformLocation(prog, 'uCloudViewTan'), this.cloudViewTan);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (probe) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.cloudProbe);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  }

  isContextLost(): boolean {
    return this.gl.isContextLost();
  }

  capture4K(cam: CameraState, state: WeatherRuntimeState): Promise<Blob> {
    const gl = this.gl;
    if (gl.isContextLost()) return Promise.reject(new Error('WebGL context is lost'));
    const canvas = gl.canvas;
    if (!(canvas instanceof HTMLCanvasElement)) return Promise.reject(new Error('Capture needs a browser canvas'));
    const [width, height] = [canvas.width, canvas.height];
    const maxRb = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 3840;
    const maxVp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | number[] | null;
    const maxW = Math.min(maxRb, maxVp?.[0] || maxRb);
    const maxH = Math.min(maxRb, maxVp?.[1] || maxRb);
    const scale = Math.min(1, maxW / 3840, maxH / 2160);
    const targetW = Math.max(1, Math.floor(3840 * scale));
    const targetH = Math.max(1, Math.floor(2160 * scale));
    return new Promise((resolve, reject) => {
      try {
        canvas.width = targetW;
        canvas.height = targetH;
        this.render(0, cam, state, true);
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('4K image could not be encoded')), 'image/png');
      } finally {
        canvas.width = width;
        canvas.height = height;
        if (!gl.isContextLost()) {
          this.render(0, cam, state);
        }
      }
    });
  }

  render(dt: number, cam: CameraState, state: WeatherRuntimeState, still = false): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (w <= 0 || h <= 0) return;

    this.elapsed += dt;
    const drift = state.windTotalSpeed * state.cloudWindScale * dt;
    this.windOffset[0] += state.windDirXZ[0] * drift;
    this.windOffset[1] += state.windDirXZ[1] * drift;

    const fovRad = (cam.fovDeg * Math.PI) / 180;
    const aspect = w / Math.max(1, h);
    const tanHalfFov = Math.tan(fovRad * 0.5);
    const proj = mat4Perspective(fovRad, aspect, 0.5, 6500);
    const { view, forward, right, up } = mat4LookDir(cam.pos, cam.yaw, cam.pitch);
    const viewProj = mat4Mul(proj, view);

    const detailScale = still ? 0.60 : Math.min(0.60, 1040 / w, 640 / h);
    const cw = Math.max(1, Math.round(w * detailScale));
    const ch = Math.max(1, Math.round(h * detailScale));
    const resizeCloudView = cw !== this.cloudViewWidth || ch !== this.cloudViewHeight;
    if (resizeCloudView) {
      this.cloudViewWidth = cw;
      this.cloudViewHeight = ch;
      gl.bindTexture(gl.TEXTURE_2D, this.cloudView);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    const lightning = state.lightning.flashIntensity > 0.02;
    const refreshProbe = still || this.elapsed + dt * 0.20 >= this.nextCloudUpdate || lightning;
    const old = this.cloudViewBasis;
    const facing = old[6] * forward[0] + old[7] * forward[1] + old[8] * forward[2];
    const overscan = 1.08;
    const tanY = tanHalfFov * overscan;
    const refreshView = still || this.elapsed + dt * 0.20 >= this.nextCloudView || facing < 0.998 ||
      Math.abs(tanY - this.cloudViewTan[1]) > 0.008 || resizeCloudView || lightning;
    if (refreshView) {
      old.set(right, 0);
      old.set(up, 3);
      old.set(forward, 6);
      this.cloudViewTan[0] = tanY * aspect;
      this.cloudViewTan[1] = tanY;
      this.nextCloudView = this.elapsed + 1 / 40;
    }
    if (refreshProbe || refreshView) {
      this.drawClouds(cam, state, refreshProbe, refreshView);
      if (refreshProbe) this.nextCloudUpdate = this.elapsed + 1 / 24;
    }
    gl.viewport(0, 0, w, h);

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // ---- PASS 1: SKY + VOLUMETRIC STS CLOUDS + CIRRUS + RAINBOW ----
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.skyProg);
    gl.uniform2f(gl.getUniformLocation(this.skyProg, 'uResolution'), w, h);
    gl.uniform3fv(gl.getUniformLocation(this.skyProg, 'uCamPos'), cam.pos);
    gl.uniform3fv(gl.getUniformLocation(this.skyProg, 'uCamForward'), forward);
    gl.uniform3fv(gl.getUniformLocation(this.skyProg, 'uCamRight'), right);
    gl.uniform3fv(gl.getUniformLocation(this.skyProg, 'uCamUp'), up);
    gl.uniform1f(gl.getUniformLocation(this.skyProg, 'uTanHalfFov'), tanHalfFov);
    gl.uniform1f(gl.getUniformLocation(this.skyProg, 'uTime'), this.elapsed);
    this.setAtmosUniforms(this.skyProg, state);
    this.bindTexture(this.skyProg, 'uCloudProbe', 1, this.cloudProbe);
    this.bindTexture(this.skyProg, 'uCloudView', 8, this.cloudView);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.skyProg, 'uCloudViewBasis'), false, this.cloudViewBasis);
    gl.uniform2fv(gl.getUniformLocation(this.skyProg, 'uCloudViewTan'), this.cloudViewTan);
    gl.uniform1f(gl.getUniformLocation(this.skyProg, 'uSunDiscSize'), state.sunDiscSize);
    gl.uniform1f(gl.getUniformLocation(this.skyProg, 'uSunDiskMult'), state.sunDiskMult);
    gl.uniform1f(gl.getUniformLocation(this.skyProg, 'uStarsIntensity'), state.starsIntensity);
    gl.uniform1f(gl.getUniformLocation(this.skyProg, 'uCloudCoverage'), state.cloudCoverage);
    gl.uniform1f(gl.getUniformLocation(this.skyProg, 'uCirrusDensity'), state.cirrusDensity);
    gl.uniform1f(gl.getUniformLocation(this.skyProg, 'uCirrusHeight'), state.cirrusHeight);
    gl.uniform1f(gl.getUniformLocation(this.skyProg, 'uCirrostratusDensity'), state.cirrostratusDensity);
    gl.uniform1f(gl.getUniformLocation(this.skyProg, 'uRainbowStrength'), state.rainbowStrength);
    gl.uniform2fv(gl.getUniformLocation(this.skyProg, 'uWindOffset'), this.windOffset);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- PASS 2: COASTAL TERRAIN ----
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.useProgram(this.terrainProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.terrainProg, 'uViewProj'), false, viewProj);
    gl.uniform3fv(gl.getUniformLocation(this.terrainProg, 'uCamPos'), cam.pos);
    gl.uniform1f(gl.getUniformLocation(this.terrainProg, 'uTime'), this.elapsed);
    this.setAtmosUniforms(this.terrainProg, state);
    this.setCloudMaps(this.terrainProg, state);
    this.bindTexture(this.terrainProg, 'uCloudProbe', 1, this.cloudProbe);
    this.bindTexture(this.terrainProg, 'uSurfaceTex', 5, this.surfaceTex);
    gl.uniform1f(gl.getUniformLocation(this.terrainProg, 'uCoastHalfSize'), this.coastHalfSize);
    gl.uniform1f(gl.getUniformLocation(this.terrainProg, 'uCloudBase'), state.cloudBaseHeight);
    gl.uniform1f(gl.getUniformLocation(this.terrainProg, 'uCloudShadowAlpha'), state.cloudShadowAlpha);
    gl.uniform3fv(gl.getUniformLocation(this.terrainProg, 'uLightDirCol'), state.lightDirCol);
    gl.uniform1f(gl.getUniformLocation(this.terrainProg, 'uLightDirMult'), state.lightDirMult);
    gl.uniform3fv(gl.getUniformLocation(this.terrainProg, 'uAmbientSkyCol'), state.ambientSkyCol);
    gl.uniform1f(gl.getUniformLocation(this.terrainProg, 'uAmbientSkyIntensity'), state.ambientSkyIntensity);
    gl.uniform1f(gl.getUniformLocation(this.terrainProg, 'uHazeStrength'), state.hazeStrength);
    gl.uniform1f(gl.getUniformLocation(this.terrainProg, 'uWetness'), state.wetness);
    gl.uniform1f(gl.getUniformLocation(this.terrainProg, 'uRainIntensity'), state.rainIntensity);
    gl.uniform1f(gl.getUniformLocation(this.terrainProg, 'uPuddleRippleScale'), state.puddleRippleScale);
    const isPlant = gl.getUniformLocation(this.terrainProg, 'uIsPlant');
    const isProp = gl.getUniformLocation(this.terrainProg, 'uIsProp');
    gl.uniform1i(isPlant, 0);
    gl.uniform1i(isProp, 0);
    const mapStructure = gl.getUniformLocation(this.terrainProg, 'uMapStructure');
    gl.uniform1i(mapStructure, 0);
    gl.uniform1i(gl.getUniformLocation(this.terrainProg, 'uNativeLand'), Number(this.nativeScene));
    this.bindTexture(this.terrainProg, 'uMaterialTex', 9, this.archiveTextures[0] ?? this.foamTex);
    gl.bindVertexArray(this.terrainVao);
    gl.drawElements(gl.TRIANGLES, this.terrainIndexCount, gl.UNSIGNED_INT, 0);
    if (this.structures) {
      gl.uniform1i(mapStructure, 1);
      gl.bindVertexArray(this.structures.vao);
      gl.drawElements(gl.TRIANGLES, this.structures.count, gl.UNSIGNED_INT, 0);
      gl.uniform1i(mapStructure, 0);
    }
    gl.uniform1f(gl.getUniformLocation(this.terrainProg, 'uPlantWind'), Math.min(5.5, 0.11 + state.windTotalSpeed * 0.13));
    gl.uniform2fv(gl.getUniformLocation(this.terrainProg, 'uPlantWindDir'), state.windDirXZ);
    if (this.palmsVao) {
      gl.uniform1i(isPlant, 1);
      gl.bindVertexArray(this.palmsVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.palmVertexCount);
    }
    gl.uniform1i(isProp, 1);
    for (const prop of this.archiveProps) {
      gl.uniform1i(isPlant, Number(prop.wind));
      gl.bindVertexArray(prop.vao);
      for (const batch of prop.batches) {
        this.bindTexture(this.terrainProg, 'uMaterialTex', 9, batch.texture);
        gl.drawElementsInstanced(gl.TRIANGLES, batch.count, gl.UNSIGNED_INT, batch.offset, prop.instances);
      }
    }

    // ---- PASS 3: MULTI-OCTAVE GERSTNER OCEAN ----
    gl.useProgram(this.oceanProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.oceanProg, 'uViewProj'), false, viewProj);
    gl.uniform3fv(gl.getUniformLocation(this.oceanProg, 'uCamPos'), cam.pos);
    gl.uniform1f(gl.getUniformLocation(this.oceanProg, 'uTime'), this.elapsed);
    gl.uniform2fv(gl.getUniformLocation(this.oceanProg, 'uWindDirXZ'), state.windDirXZ);
    gl.uniform1f(gl.getUniformLocation(this.oceanProg, 'uWindSpeed'), state.windTotalSpeed);
    gl.uniform1f(gl.getUniformLocation(this.oceanProg, 'uOceanWaveAmp'), state.oceanWaveAmplitude);
    gl.uniform1f(gl.getUniformLocation(this.oceanProg, 'uShoreWaveAmp'), state.shoreWaveAmplitude);
    gl.uniform1f(gl.getUniformLocation(this.oceanProg, 'uOceanFetch'), state.oceanFetch);
    gl.uniform3fv(gl.getUniformLocation(this.oceanProg, 'uOceanBandWeights'), state.oceanBandWeights);
    gl.uniform1f(gl.getUniformLocation(this.oceanProg, 'uCoastHalfSize'), this.coastHalfSize);
    this.bindTexture(this.oceanProg, 'uHeightTex', 0, this.heightTex);
    this.bindTexture(this.oceanProg, 'uCloudProbe', 1, this.cloudProbe);
    this.bindTexture(this.oceanProg, 'uWaterNoise', 6, this.waterNoiseTex);
    this.bindTexture(this.oceanProg, 'uFoamTex', 7, this.foamTex);
    this.bindTexture(this.oceanProg, 'uCaustic', 14, this.causticTex);
    this.bindTexture(this.oceanProg, 'uShoreField', 8, this.shoreField);
    gl.uniform1i(gl.getUniformLocation(this.oceanProg, 'uNativeWater'), Number(this.nativeScene));
    ['uNativeFoam', 'uBubbleFoam', 'uWavefrontProfile', 'uShoreVertexProfile', 'uShorePixelProfile'].forEach((name, i) => {
      this.bindTexture(this.oceanProg, name, 9 + i, this.waterDetail[i]);
    });
    this.setAtmosUniforms(this.oceanProg, state);
    gl.uniform1f(gl.getUniformLocation(this.oceanProg, 'uHazeStrength'), state.hazeStrength);
    gl.uniform1f(gl.getUniformLocation(this.oceanProg, 'uRainIntensity'), state.rainIntensity);
    gl.uniform1f(gl.getUniformLocation(this.oceanProg, 'uOceanFoamIntensity'), state.oceanFoamIntensity);
    gl.uniform1f(gl.getUniformLocation(this.oceanProg, 'uRippleBumpiness'), state.rippleBumpiness);
    gl.uniform1f(gl.getUniformLocation(this.oceanProg, 'uWaterGustBump'), state.waterGustBump);
    gl.bindVertexArray(this.oceanVao);
    gl.drawElements(gl.TRIANGLES, this.oceanIndexCount, gl.UNSIGNED_INT, 0);

    // ---- PASS 4A: 3D BRANCHING LIGHTNING BOLT ----
    if (state.lightning.active && state.lightning.flashIntensity > 0.02) {
      if (state.lightning.seed !== this.lastBoltSeed) {
        this.lastBoltSeed = state.lightning.seed;
        this.rebuildLightningBolt(
          state.lightning.worldX,
          state.lightning.worldZ,
          state.cloudBaseHeight,
          state.lightning.seed,
        );
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.depthMask(false);
      gl.useProgram(this.boltProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.boltProg, 'uViewProj'), false, viewProj);
      gl.uniform2f(gl.getUniformLocation(this.boltProg, 'uResolution'), w, h);
      gl.uniform1f(gl.getUniformLocation(this.boltProg, 'uTanHalfFov'), tanHalfFov);
      gl.uniform1f(gl.getUniformLocation(this.boltProg, 'uBoltAge'), state.lightning.age);
      gl.uniform3fv(gl.getUniformLocation(this.boltProg, 'uLightningCol'), state.lightning.colorRGB);
      gl.uniform1f(gl.getUniformLocation(this.boltProg, 'uLightningFlash'), state.lightning.flashIntensity);
      gl.bindVertexArray(this.boltVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.boltVertexCount);
    }

    // ---- PASS 4B: GPU 3D PRECIPITATION (RAIN / HAIL / SANDSTORM) ----
    if (state.rainIntensity > 0.02 || state.hailIntensity > 0.02 || state.sandstormIntensity > 0.02) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.useProgram(this.precipProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.precipProg, 'uViewProj'), false, viewProj);
      gl.uniform3fv(gl.getUniformLocation(this.precipProg, 'uCamPos'), cam.pos);
      gl.uniform1f(gl.getUniformLocation(this.precipProg, 'uTime'), this.elapsed);
      gl.uniform2fv(gl.getUniformLocation(this.precipProg, 'uWindDirXZ'), state.windDirXZ);
      gl.uniform1f(gl.getUniformLocation(this.precipProg, 'uWindSpeed'), state.windTotalSpeed);
      gl.uniform1f(gl.getUniformLocation(this.precipProg, 'uRainIntensity'), state.rainIntensity);
      gl.uniform1f(gl.getUniformLocation(this.precipProg, 'uHailIntensity'), state.hailIntensity);
      gl.uniform1f(gl.getUniformLocation(this.precipProg, 'uSandstorm'), state.sandstormIntensity);
      gl.uniform3fv(gl.getUniformLocation(this.precipProg, 'uSunDir'), state.sunDir);
      gl.uniform1f(gl.getUniformLocation(this.precipProg, 'uLightningFlash'), state.lightning.flashIntensity);
      gl.uniform3fv(gl.getUniformLocation(this.precipProg, 'uLightningCol'), state.lightning.colorRGB);
      gl.bindVertexArray(this.precipVao);
      gl.drawArrays(gl.LINES, 0, this.precipVertexCount);
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    gl.deleteProgram(this.cloudProg);
    gl.deleteProgram(this.skyProg);
    gl.deleteProgram(this.terrainProg);
    gl.deleteProgram(this.oceanProg);
    gl.deleteProgram(this.precipProg);
    gl.deleteProgram(this.boltProg);
    for (const texture of [this.heightTex, this.surfaceTex, this.cloudMapsTex, this.cloudNoiseTex,
      this.blueNoiseTex, this.waterNoiseTex, this.foamTex, this.causticTex, this.cloudProbe, this.cloudView,
      this.nativeNoise, this.shoreField,
      ...this.waterDetail, ...this.archiveTextures]) gl.deleteTexture(texture);
    gl.deleteFramebuffer(this.cloudFramebuffer);
    for (const vao of new Set([this.emptyVao, this.terrainVao, this.palmsVao, this.oceanVao, this.precipVao,
      this.boltVao, ...this.archiveMeshes])) gl.deleteVertexArray(vao);
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
  }
}
