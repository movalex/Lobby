// OWNER: 3i. Reduced motion for the a11y feature's camera moves (the early wave-5 review W5-21: every camera
// move animated under `prefers-reduced-motion: reduce`; present mode was the only one that honoured it). A
// move this feature makes (bringing a traversed item into view, F6 entering the board, the phone sheet's Zoom
// to fit) jumps when the person asks for less motion, and glides otherwise.

/** The person asks for less motion (the media query; false where there is no `matchMedia`, as in Node). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** The `animate` option of a camera move: off under reduced motion. */
export const animateCamera = (): boolean => !prefersReducedMotion()
