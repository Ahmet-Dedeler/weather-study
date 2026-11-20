type Point = [number, number, number];

export function lightningChannels(ground: Point, height: number, seed: number): Float32Array {
  let bits = (seed * 0x100000) >>> 0;
  const random = () => {
    bits = (Math.imul(bits, 1664525) + 1013904223) >>> 0;
    return bits / 2 ** 32;
  };
  const out: number[] = [];

  function subdivide(a: Point, b: Point, depth: number, bend: number): Point[] {
    if (!depth) return [a, b];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const radius = length * bend;
    const t = 0.41 + random() * 0.18;
    const mid: Point = [
      a[0] + (b[0] - a[0]) * t + (random() - 0.5) * radius * 2,
      a[1] + (b[1] - a[1]) * t + (random() - 0.5) * radius * 0.25,
      a[2] + (b[2] - a[2]) * t + (random() - 0.5) * radius * 2,
    ];
    return [...subdivide(a, mid, depth - 1, bend).slice(0, -1), ...subdivide(mid, b, depth - 1, bend)];
  }

  function emit(path: Point[], energy: number, birth: number) {
    const push = (i: number, side: number) => {
      const p = path[i];
      const a = path[Math.max(i - 1, 0)], b = path[Math.min(i + 1, path.length - 1)];
      const t = i / (path.length - 1);
      const strength = energy === 1 ? 0.84 + 0.16 * t : energy * Math.pow(1 - t, 0.72);
      out.push(...p, b[0] - a[0], b[1] - a[1], b[2] - a[2], side, strength, birth, t);
    };
    for (let i = 0; i < path.length - 1; i++) {
      push(i, -1); push(i, 1); push(i + 1, -1);
      push(i, 1); push(i + 1, 1); push(i + 1, -1);
    }
  }

  const top: Point = [ground[0] + (random() - 0.5) * height * 0.24, ground[1] + height,
    ground[2] + (random() - 0.5) * height * 0.24];
  const trunk = subdivide(top, ground, 6, 0.24);
  emit(trunk, 1, 0);
  const phase = random() * Math.PI * 2;
  for (let i = 0; i < 8; i++) {
    const along = 0.14 + i * 0.087 + random() * 0.048;
    const start = trunk[Math.floor(along * (trunk.length - 1))];
    const angle = phase + i * 2.40 + (random() - 0.5) * 0.6;
    const reach = height * (0.10 + 0.24 * random()) * (1 - along * 0.64);
    const branch = subdivide(start, [start[0] + Math.cos(angle) * reach,
      Math.max(ground[1] + 13, start[1] - reach * (0.42 + random() * 0.7)),
      start[2] + Math.sin(angle) * reach], 4, 0.30);
    emit(branch, 0.39 + random() * 0.28, 0.012 + along * 0.025);
    for (let f = 0; f < 2; f++) {
      const p = branch[3 + Math.floor(random() * 9)];
      const fork = angle + (f ? -1 : 1) * (0.45 + random() * 0.8);
      const len = reach * (0.23 + random() * 0.35);
      emit(subdivide(p, [p[0] + Math.cos(fork) * len, p[1] - len * 0.62,
        p[2] + Math.sin(fork) * len], 3, 0.28), 0.20 + random() * 0.17, 0.024 + along * 0.033);
    }
  }
  return Float32Array.from(out);
}
