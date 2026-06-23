import type { SectionKind } from './types'

/** A stroke section as a run of skeleton pixel indices, with end-node degrees. */
export interface PixelSection {
  pixels: number[]
  kind: SectionKind
  componentId: number
  degA: number
  degB: number
}

export interface GraphResult {
  sections: PixelSection[]
  /** Nodes (endpoints + junctions), pixel index → degree. */
  nodes: { index: number; degree: number }[]
  /** Per-pixel skeleton degree (0 for non-skeleton). */
  deg: Uint8Array
}

const OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
]

function neighbors(i: number, w: number, h: number, skel: Uint8Array): number[] {
  const x = i % w
  const y = (i / w) | 0
  const out: number[] = []
  for (const [dx, dy] of OFFSETS) {
    const nx = x + dx
    const ny = y + dy
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) {
      const j = ny * w + nx
      if (skel[j]) out.push(j)
    }
  }
  return out
}

function degreeMap(skel: Uint8Array, w: number, h: number): Uint8Array {
  const deg = new Uint8Array(skel.length)
  for (let i = 0; i < skel.length; i++) {
    if (skel[i]) deg[i] = neighbors(i, w, h, skel).length
  }
  return deg
}

function connectedComponents(skel: Uint8Array, w: number, h: number): Int32Array {
  const label = new Int32Array(skel.length).fill(-1)
  const stack: number[] = []
  let next = 0
  for (let s = 0; s < skel.length; s++) {
    if (!skel[s] || label[s] >= 0) continue
    label[s] = next
    stack.length = 0
    stack.push(s)
    while (stack.length) {
      const c = stack.pop() as number
      for (const nb of neighbors(c, w, h, skel)) {
        if (label[nb] < 0) {
          label[nb] = next
          stack.push(nb)
        }
      }
    }
    next++
  }
  return label
}

/**
 * Walk the skeleton into raw sections: split at every node (degree ≠ 2). Pure
 * loops get a synthetic seam; isolated pixels (dots) become single-point sections.
 */
export function extractSections(skel: Uint8Array, w: number, h: number): GraphResult {
  const deg = degreeMap(skel, w, h)
  const comp = connectedComponents(skel, w, h)

  const nodes: { index: number; degree: number }[] = []
  for (let i = 0; i < skel.length; i++) {
    if (skel[i] && deg[i] !== 2) nodes.push({ index: i, degree: deg[i] })
  }

  const sections: PixelSection[] = []
  const visited = new Set<number>()
  const N = skel.length
  const key = (a: number, b: number) => (a < b ? a * N + b : b * N + a)

  for (const { index: start } of nodes) {
    for (const first of neighbors(start, w, h, skel)) {
      if (visited.has(key(start, first))) continue
      const path = [start, first]
      visited.add(key(start, first))
      let prev = start
      let cur = first
      while (deg[cur] === 2) {
        const nbs = neighbors(cur, w, h, skel)
        let nextPix = -1
        for (const c of nbs) {
          if (c !== prev && !visited.has(key(cur, c))) {
            nextPix = c
            break
          }
        }
        if (nextPix === -1) break
        visited.add(key(cur, nextPix))
        path.push(nextPix)
        prev = cur
        cur = nextPix
      }
      sections.push({
        pixels: path,
        kind: 'line',
        componentId: comp[start],
        degA: deg[start],
        degB: deg[cur],
      })
    }
  }

  // pure loops
  const covered = new Uint8Array(N)
  for (const s of sections) for (const p of s.pixels) covered[p] = 1
  for (let i = 0; i < N; i++) {
    if (!skel[i] || deg[i] !== 2 || covered[i]) continue
    const path = [i]
    covered[i] = 1
    let prev = -1
    let cur = i
    while (true) {
      const nbs = neighbors(cur, w, h, skel)
      let nextPix = -1
      for (const c of nbs) {
        if (c !== prev && !covered[c]) {
          nextPix = c
          break
        }
      }
      if (nextPix === -1) break
      covered[nextPix] = 1
      path.push(nextPix)
      prev = cur
      cur = nextPix
    }
    path.push(i)
    sections.push({ pixels: path, kind: 'loop', componentId: comp[i], degA: 0, degB: 0 })
  }

  // isolated dots
  for (let i = 0; i < N; i++) {
    if (skel[i] && deg[i] === 0 && !covered[i]) {
      sections.push({ pixels: [i], kind: 'line', componentId: comp[i], degA: 0, degB: 0 })
      covered[i] = 1
    }
  }

  return { sections, nodes, deg }
}

/** Unit direction pointing from a section's end node *into* the section. */
function awayDir(pixels: number[], end: 0 | 1, w: number): { x: number; y: number } {
  const n = pixels.length
  const k = Math.min(4, n - 1)
  const ai = end === 0 ? pixels[0] : pixels[n - 1]
  const bi = end === 0 ? pixels[k] : pixels[n - 1 - k]
  const dx = (bi % w) - (ai % w)
  const dy = ((bi / w) | 0) - ((ai / w) | 0)
  const l = Math.hypot(dx, dy) || 1
  return { x: dx / l, y: dy / l }
}

/**
 * Merge the most-collinear pair of branches through each junction into a single
 * through-stroke (e.g. the two halves of an 'r' stem rejoin into one stem, while
 * the arch stays a separate branch). Greedy by smallest turn angle.
 */
export function linkSectionsAtJunctions(
  sections: PixelSection[],
  deg: Uint8Array,
  w: number,
): PixelSection[] {
  const N = sections.length
  const portKey = (sec: number, end: 0 | 1) => sec * 2 + end

  // group linkable ports (ends sitting on a junction pixel) by that pixel
  const portsByNode = new Map<number, { sec: number; end: 0 | 1 }[]>()
  for (let i = 0; i < N; i++) {
    const s = sections[i]
    if (s.kind === 'loop' || s.pixels.length < 2) continue
    for (const end of [0, 1] as const) {
      const pix = end === 0 ? s.pixels[0] : s.pixels[s.pixels.length - 1]
      if (deg[pix] >= 3) {
        const arr = portsByNode.get(pix) ?? []
        arr.push({ sec: i, end })
        portsByNode.set(pix, arr)
      }
    }
  }

  const match = new Map<number, number>()
  for (const ports of portsByNode.values()) {
    const dirs = ports.map((p) => awayDir(sections[p.sec].pixels, p.end, w))
    const pairs: { i: number; j: number; score: number }[] = []
    for (let i = 0; i < ports.length; i++) {
      for (let j = i + 1; j < ports.length; j++) {
        if (ports[i].sec === ports[j].sec) continue
        pairs.push({ i, j, score: dirs[i].x * dirs[j].x + dirs[i].y * dirs[j].y })
      }
    }
    pairs.sort((a, b) => a.score - b.score) // most negative (straightest through) first
    const usedPort = new Set<number>()
    for (const pr of pairs) {
      if (pr.score > -0.4) break // > ~114° turn: not collinear enough to link
      if (usedPort.has(pr.i) || usedPort.has(pr.j)) continue
      usedPort.add(pr.i)
      usedPort.add(pr.j)
      const ka = portKey(ports[pr.i].sec, ports[pr.i].end)
      const kb = portKey(ports[pr.j].sec, ports[pr.j].end)
      match.set(ka, kb)
      match.set(kb, ka)
    }
  }

  const used = new Uint8Array(N)
  const result: PixelSection[] = []

  // pass through loops and dots unchanged
  for (let i = 0; i < N; i++) {
    if (sections[i].kind === 'loop' || sections[i].pixels.length < 2) {
      result.push(sections[i])
      used[i] = 1
    }
  }

  for (let i = 0; i < N; i++) {
    if (used[i]) continue
    used[i] = 1
    let chain = sections[i].pixels.slice()

    // extend the tail (end 1)
    let tailSec = i
    let tailEnd: 0 | 1 = 1
    while (true) {
      const m = match.get(portKey(tailSec, tailEnd))
      if (m === undefined) break
      const j = Math.floor(m / 2)
      const e = (m % 2) as 0 | 1
      if (used[j]) break
      used[j] = 1
      const jp = sections[j].pixels
      if (e === 0) {
        for (let t = 1; t < jp.length; t++) chain.push(jp[t])
        tailEnd = 1
      } else {
        for (let t = jp.length - 2; t >= 0; t--) chain.push(jp[t])
        tailEnd = 0
      }
      tailSec = j
    }

    // extend the head (end 0)
    let headSec = i
    let headEnd: 0 | 1 = 0
    while (true) {
      const m = match.get(portKey(headSec, headEnd))
      if (m === undefined) break
      const j = Math.floor(m / 2)
      const e = (m % 2) as 0 | 1
      if (used[j]) break
      used[j] = 1
      const jp = sections[j].pixels
      const prefix = e === 1 ? jp.slice(0, jp.length - 1) : jp.slice(1).reverse()
      chain = prefix.concat(chain)
      headEnd = e === 1 ? 0 : 1
      headSec = j
    }

    const a = chain[0]
    const b = chain[chain.length - 1]
    result.push({
      pixels: chain,
      kind: 'curve',
      componentId: sections[i].componentId,
      degA: deg[a],
      degB: deg[b],
    })
  }

  return result
}

function pathLengthPx(pixels: number[], w: number): number {
  let total = 0
  for (let k = 1; k < pixels.length; k++) {
    const a = pixels[k - 1]
    const b = pixels[k]
    total += Math.hypot((a % w) - (b % w), ((a / w) | 0) - ((b / w) | 0))
  }
  return total
}

/**
 * Remove short leaf sections — a section with exactly one free endpoint hanging
 * off a junction, shorter than k × the local stroke width (serif feet, ink-trap
 * barbs). Strokes with two free ends (the linked stem) are never removed.
 */
export function pruneLeafSections(
  sections: PixelSection[],
  deg: Uint8Array,
  dt: Float32Array,
  w: number,
  k: number,
): PixelSection[] {
  const out: PixelSection[] = []
  for (const s of sections) {
    if (s.kind === 'loop' || s.pixels.length < 2) {
      out.push(s)
      continue
    }
    const a = s.pixels[0]
    const b = s.pixels[s.pixels.length - 1]
    const freeA = deg[a] === 1
    const freeB = deg[b] === 1
    if (freeA !== freeB) {
      const junctionPix = freeA ? b : a
      const width = 2 * dt[junctionPix]
      if (pathLengthPx(s.pixels, w) < k * width) continue // drop barb
    }
    out.push(s)
  }
  return out
}
