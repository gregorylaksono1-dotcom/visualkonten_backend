// Mulberry32 PRNG - fast, deterministic, 32-bit PRNG
export function mulberry32(a: number) {
  return function () {
    var t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed: number) {
  const random = mulberry32(seed);
  return {
    // 0 to 1
    next: () => random(),
    // min to max
    range: (min: number, max: number) => min + random() * (max - min),
    // pick from array
    pick: <T>(arr: T[]): T => arr[Math.floor(random() * arr.length)],
  };
}
