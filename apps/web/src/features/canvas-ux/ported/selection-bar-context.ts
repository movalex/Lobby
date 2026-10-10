// Wave M (M1-3, M1-4): what the selection bar tells its items (./SelectionBar.tsx provides it).
import { createContext } from 'react'

/** Whether the bar is drawn compact (a narrow canvas, or folded because the full bar fits nowhere). */
export const SelectionBarCompact = createContext(false)
