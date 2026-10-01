// Loaded by apps/web/index.html before main.tsx: starts the theme controller on every page (sign-in and
// invite pages included), so "System" follows an OS switch and a choice made in another tab applies
// here too. The first paint was already set by the classic head script (public/theme-boot.js); the canvas
// follows the app theme through canvas/engine/theme.ts.
import { getTheme } from './theme.ts'

getTheme()
