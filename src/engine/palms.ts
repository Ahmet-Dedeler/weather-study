import type { CoastMeta } from './types';

type Vec3 = [number, number, number];
type Vertex = [pos: Vec3, color: Vec3, bend: number];

export function buildPalms(heights: Float32Array, surface: Uint8Array, coast: CoastMeta): Float32Array {
  const vertices: number[] = [];
  let seed = 239;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const half = coast.worldSizeMeters / 2;
  const size = coast.gridSize;
  const cell = coast.worldSizeMeters / (size - 1);
  const index = (x: number, z: number) => Math.round((z + half) / cell) * size + Math.round((x + half) / cell);
  const locations: Vec3[] = [];
  for (let i = 0; i < 180; i++) {
    const x = (rand() - 0.21) * half * 0.48, z = (rand() - 0.51) * half;
    const j = index(x, z);
    if (surface[j] !== 0 || heights[j] < 1.8 || x > 110) continue;
    if (locations.some(([px, pz]) => Math.hypot(x - px, z - pz) < 13)) continue;
    locations.push([x, z, 4.6 + rand() * 5.8]);
  }

  for (const [x, z, height] of locations) {
    const j = index(x, z);
    if (surface[j] === 1 || heights[j] < 0.65) continue;
    const ground = heights[j] - 0.34;
    const phase = rand() * Math.PI * 2;
    const lean = 0.65 + rand() * 1.35;
    const tipX = Math.cos(phase) * lean, tipZ = Math.sin(phase) * lean;
    const radius = (0.18 + rand() * 0.13) * (height / 10) ** 0.6;
    const tint = rand();
    const bark: Vec3 = [0.19 + tint * 0.047, 0.132 + tint * 0.035, 0.087 + tint * 0.029];
    const green: Vec3 = [0.053 + tint * 0.027, 0.120 + tint * 0.042, 0.019 + tint * 0.016];
    const gold: Vec3 = [0.22, 0.24, 0.052];
    const triangle = (a: Vertex, b: Vertex, c: Vertex) => {
      const u = b[0].map((p, i) => p - a[0][i]);
      const v = c[0].map((p, i) => p - a[0][i]);
      const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
      const len = Math.hypot(nx, ny, nz) || 1;
      for (const [pos, color, bend] of [a, b, c]) vertices.push(...pos, nx / len, ny / len, nz / len, ...color, bend, phase);
    };
    const trunkVertex = (t: number, side: number, ring: number): Vertex => {
      const angle = side * Math.PI / 4;
      const r = radius * (1.04 - 0.53 * t + 0.26 * Math.exp(-t * 12) + 0.17 * t ** 16);
      const stripe = ring % 3 === 0 ? 0.76 : 1.0;
      const color: Vec3 = bark.map((v) => v * stripe) as Vec3;
      return [[x + tipX * t ** 1.8 + r * Math.cos(angle), ground + height * t, z + tipZ * t ** 1.8 + r * Math.sin(angle)], color, t * t * 0.47];
    };
    const rings = 25;
    for (let k = 0; k < rings; k++) {
      for (let side = 0; side < 8; side++) {
        const a = trunkVertex(k / rings, side, k), b = trunkVertex(k / rings, side + 1, k);
        const c = trunkVertex((k + 1) / rings, side, k + 1), d = trunkVertex((k + 1) / rings, side + 1, k + 1);
        triangle(a, c, b);
        triangle(b, c, d);
      }
    }
    for (let k = 0; k < 14; k++) {
      const theta = phase + k * 2.399963;
      const dx = Math.cos(theta), dz = Math.sin(theta);
      const reach = (2.3 + rand() * 1.5) * Math.min(1.17, height / 10);
      const lift = 0.25 + k / 14 * 1.4;
      const droop = 1.2 + rand() * 0.82 - k / 14;
      const color = k < 2 ? gold : green;
      const frond = (t: number): Vec3 => [
        x + tipX + dx * reach * t,
        ground + height + lift * Math.sin(t * 2.55) - droop * t * t,
        z + tipZ + dz * reach * t,
      ];
      const rachis = (t: number, side: number): Vertex => {
        const p = frond(t), w = 0.044 * (1 - t * 0.93) * side;
        return [[p[0] - dz * w, p[1], p[2] + dx * w], color, 0.47 + t * 0.48];
      };
      for (let n = 0; n < 12; n++) {
        const t = n / 12, next = (n + 1) / 12;
        triangle(rachis(t, -1), rachis(next, -1), rachis(t, 1));
        triangle(rachis(t, 1), rachis(next, -1), rachis(next, 1));
      }
      for (let n = 1; n <= 26; n++) {
        const t = n / 28;
        const p = frond(t), f = frond(Math.min(1, t + 0.035));
        const span = reach * 0.24 * Math.sin(Math.PI * t) ** 0.7 * (0.8 + rand() * 0.32);
        for (const side of [1, -1]) {
          const tip: Vec3 = [p[0] + dx * span * 0.52 - dz * side * span, p[1] - span * 0.58, p[2] + dz * span * 0.52 + dx * side * span];
          const mid: Vec3 = [p[0] + dx * span * 0.39 - dz * side * span * 0.5, p[1] - span * 0.16, p[2] + dz * span * 0.39 + dx * side * span * 0.5];
          const bend = 0.47 + t * 0.45;
          triangle([p, color, bend], [mid, color, bend + 0.08], [f, color, bend]);
          triangle([f, color, bend], [mid, color, bend + 0.08], [tip, color, bend + 0.19]);
        }
      }
    }
  }
  return new Float32Array(vertices);
}
