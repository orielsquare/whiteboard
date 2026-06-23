/**
 * Guo-Hall thinning → a 1px-wide, 8-connected skeleton (medial axis approximation).
 * Input/output are binary masks (1 = ink). Produces fewer staircase artifacts and
 * 2px nubs than Zhang-Suen.
 *
 * Reference: Z. Guo & R. W. Hall, "Parallel thinning with two-subiteration
 * algorithms", CACM 1989.
 */
export function thinGuoHall(src: Uint8Array, w: number, h: number): Uint8Array {
  const img = Uint8Array.from(src)
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x]

  const toDelete: number[] = []
  let changed = true

  while (changed) {
    changed = false
    for (let iter = 0; iter < 2; iter++) {
      toDelete.length = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!img[y * w + x]) continue
          // 8-neighbourhood:  p9 p2 p3 / p8 p1 p4 / p7 p6 p5
          const p2 = at(x, y - 1)
          const p3 = at(x + 1, y - 1)
          const p4 = at(x + 1, y)
          const p5 = at(x + 1, y + 1)
          const p6 = at(x, y + 1)
          const p7 = at(x - 1, y + 1)
          const p8 = at(x - 1, y)
          const p9 = at(x - 1, y - 1)

          const C =
            (!p2 && (p3 || p4) ? 1 : 0) +
            (!p4 && (p5 || p6) ? 1 : 0) +
            (!p6 && (p7 || p8) ? 1 : 0) +
            (!p8 && (p9 || p2) ? 1 : 0)
          const N1 =
            (p9 || p2 ? 1 : 0) + (p3 || p4 ? 1 : 0) + (p5 || p6 ? 1 : 0) + (p7 || p8 ? 1 : 0)
          const N2 =
            (p2 || p3 ? 1 : 0) + (p4 || p5 ? 1 : 0) + (p6 || p7 ? 1 : 0) + (p8 || p9 ? 1 : 0)
          const N = Math.min(N1, N2)
          const m = iter === 0 ? (p6 || p7 || !p9) && p8 : (p2 || p3 || !p5) && p4

          if (C === 1 && N >= 2 && N <= 3 && !m) toDelete.push(y * w + x)
        }
      }
      if (toDelete.length) {
        changed = true
        for (const i of toDelete) img[i] = 0
      }
    }
  }

  return img
}
