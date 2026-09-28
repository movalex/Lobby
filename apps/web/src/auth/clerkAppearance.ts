// Clerk's <SignIn> in the app's colours, light or dark. @clerk/react 6.17.2 takes `appearance` on the
// component (type `Theme`: `variables`, `elements`, `captcha`, ...); its `variables` are CSS colours,
// so we hand it our own --dr-* tokens (styles.css), resolved to #rrggbb for the theme in use. Clerk's
// prebuilt dark theme lives in @clerk/ui, which is not a dependency here: our tokens are the theme.
//
// No @clerk/react value import: the types below are erased, so this module stays out of the Clerk
// chunk's way and runs in the node unit tests.

import type { SignIn } from '@clerk/react'
import type { ComponentProps } from 'react'
import type { ColorMode } from '../theme/theme.ts'

export type ClerkAppearance = NonNullable<ComponentProps<typeof SignIn>['appearance']>

/** The tokens the appearance is built from (every one has a light and a dark value in styles.css). */
export const CLERK_TOKENS = [
  '--dr-navy',
  '--dr-on-navy',
  '--dr-accent-ink',
  '--dr-surface',
  '--dr-inset',
  '--dr-hover',
  '--dr-ink',
  '--dr-ink-2',
  '--dr-line-strong',
  '--dr-focus',
  '--dr-danger',
  '--dr-live',
  '--dr-warn',
] as const
export type ClerkToken = (typeof CLERK_TOKENS)[number]
export type ThemeTokens = Partial<Record<ClerkToken, string>>

/** styles.css :root values, for a token the page does not resolve (clerkAppearance.test.ts keeps them equal). */
export const LIGHT_FALLBACK: Record<ClerkToken, string> = {
  '--dr-navy': '#1f3a5f',
  '--dr-on-navy': '#ffffff',
  '--dr-accent-ink': '#1f3a5f',
  '--dr-surface': '#ffffff',
  '--dr-inset': '#faf9f5',
  '--dr-hover': '#f1efe8',
  '--dr-ink': '#1b2330',
  '--dr-ink-2': '#4a5566',
  '--dr-line-strong': '#c4bfb0',
  '--dr-focus': '#2563eb',
  '--dr-danger': '#a3211a',
  '--dr-live': '#17663f',
  '--dr-warn': '#7a4a00',
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

/**
 * An opaque colour as #rrggbb: hex (#rgb, #rrggbb, #rrggbbaa with full alpha) or rgb()/rgba() in either
 * syntax. Anything else (names, var(), translucent colours) is null: the caller falls back.
 */
export function toHex(value: string): string | null {
  const v = value.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  const long = /^#([0-9a-f]{6})(ff)?$/.exec(v)
  if (long) return `#${long[1]}`
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(v)
  if (!rgb) return null
  const alpha = rgb[4]
  if (alpha !== undefined && alpha !== '1' && alpha !== '100%') return null
  const channels = [rgb[1], rgb[2], rgb[3]].map(Number)
  if (channels.some((c) => c > 255)) return null
  return `#${channels.map(hex2).join('')}`
}

export function clerkAppearance(tokens: ThemeTokens, mode: ColorMode): ClerkAppearance {
  const c = (t: ClerkToken) => toHex(tokens[t] ?? '') ?? LIGHT_FALLBACK[t]
  // Clerk colours links with colorPrimary; on dark surfaces our navy fill is too dark for text
  // (about 3:1), so links get the accent ink the rest of the app uses for links.
  const link = { color: c('--dr-accent-ink') }
  return {
    variables: {
      colorPrimary: c('--dr-navy'),
      colorPrimaryForeground: c('--dr-on-navy'),
      colorBackground: c('--dr-surface'),
      colorForeground: c('--dr-ink'),
      colorMuted: c('--dr-hover'),
      colorMutedForeground: c('--dr-ink-2'),
      colorInput: c('--dr-inset'),
      colorInputForeground: c('--dr-ink'),
      // Borders, hovers and dividers are derived from it: dark shades in light mode, light in dark.
      colorNeutral: c('--dr-ink'),
      colorBorder: c('--dr-line-strong'),
      colorRing: c('--dr-focus'),
      colorDanger: c('--dr-danger'),
      colorSuccess: c('--dr-live'),
      colorWarning: c('--dr-warn'),
      colorShadow: mode === 'dark' ? '#000000' : c('--dr-ink'),
    },
    elements: {
      footerActionLink: link,
      formFieldAction: link,
      formResendCodeLink: link,
      identityPreviewEditButton: link,
    },
    captcha: { theme: mode },
  }
}

/** The tokens as the page currently resolves them (html[data-theme] switches every one). */
export function readThemeTokens(root: Element = document.documentElement): ThemeTokens {
  const style = getComputedStyle(root)
  const out: ThemeTokens = {}
  for (const t of CLERK_TOKENS) {
    const v = style.getPropertyValue(t).trim()
    if (v) out[t] = v
  }
  return out
}
