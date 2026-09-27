import { useSyncExternalStore } from 'react'

/** Live `window.matchMedia(query).matches` (false where matchMedia does not exist). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  )
}

/**
 * Board top-bar breakpoints (PRI-02): `tablet` (768 px and below) moves feature controls into the
 * "⋯" menu; `phone` (480 px and below) also moves the people list and the account button there.
 */
export type TopBarWidth = 'wide' | 'tablet' | 'phone'
export const TABLET_QUERY = '(max-width: 768px)'
export const PHONE_QUERY = '(max-width: 480px)'

export function useTopBarWidth(): TopBarWidth {
  const tablet = useMediaQuery(TABLET_QUERY)
  const phone = useMediaQuery(PHONE_QUERY)
  return phone ? 'phone' : tablet ? 'tablet' : 'wide'
}
