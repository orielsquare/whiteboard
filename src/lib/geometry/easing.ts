export type EasingName = 'linear' | 'cubicIn' | 'cubicOut' | 'cubicInOut' | 'quintOut'

/** Evaluate a named easing at t (clamped to 0..1). Drives natural pen accel/decel. */
export function ease(name: EasingName, t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  switch (name) {
    case 'linear':
      return x
    case 'cubicIn':
      return x * x * x
    case 'cubicOut':
      return 1 - Math.pow(1 - x, 3)
    case 'cubicInOut':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
    case 'quintOut':
      return 1 - Math.pow(1 - x, 5)
    default:
      return x
  }
}

export const EASING_NAMES: EasingName[] = ['linear', 'cubicIn', 'cubicOut', 'cubicInOut', 'quintOut']
