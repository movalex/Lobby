// The composer's graphics, drawn as HTML by Chromium so the type is real Segoe UI: the title and outro
// cards (rendered frame by frame, animations seeked to each frame's time, piped into ffmpeg), and the
// transparent overlays (lower-third captions, name labels, the phone frame).
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser } from '@playwright/test'

export const W = 1920
export const H = 1080
export const FPS = 30

export const NAVY = '#213150'
export const ORANGE = '#FE5A05'
const PAPER = '#f6f4ee'
const FONT = `"Segoe UI", "Segoe UI Variable Text", system-ui, sans-serif`

/**
 * Every picture ends up as HD video: BT.709 colours, limited ("TV") range, tagged as such, so players
 * show the DBC navy and orange as the browser drew them. Screenshots (and the recorder's JPEG frames)
 * are converted from full range.
 */
export const BT709_TAGS = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv'
export const TO_BT709 = `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,${BT709_TAGS}`
export const BT709_FLAGS = [
  ...['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'],
]

/**
 * The split-screen layout: two browser panes side by side over a bottom band that holds the names and
 * the scene's caption, so no overlay ever covers the app. Each pane is recorded at PANE device pixels
 * from a PANE / DSF CSS-pixel window (the UI drawn 1.2x larger, still sharp).
 */
export const BAND_H = 72
export const PANE = { w: W / 2, h: H - BAND_H }
export const DSF = 1.2
export const PANE_CSS = { width: Math.round(PANE.w / DSF), height: Math.round(PANE.h / DSF) }

/** Where the phone inset goes during the guest scene (the screen area inside the frame). */
export const PHONE_SCREEN = { x: 1240, y: 52, w: 400, h: 866 }
const BEZEL = 14

function heroMark(repoRoot: string): string {
  return readFileSync(join(repoRoot, 'apps/web/public/brand/lobby-hero.svg'), 'utf8')
    .replace(/<title>[^<]*<\/title>/, '')
    .replace('<svg ', '<svg class="hero" ')
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const BASE_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
body { font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
`

const STAGE_CSS = `
body { background: ${NAVY}; color: ${PAPER}; }
.stage { position: absolute; inset: 0; overflow: hidden; }
.dots { position: absolute; inset: -40px; opacity: .10;
  background-image: radial-gradient(circle, rgba(246,244,238,.9) 1.3px, transparent 1.6px); background-size: 34px 34px;
  animation: drift 14s linear both; }
@keyframes drift { from { transform: translate(0, 0) } to { transform: translate(-34px, -20px) } }
.glow { position: absolute; width: 1400px; height: 1400px; border-radius: 50%;
  background: radial-gradient(circle, rgba(254,90,5,.30) 0%, rgba(254,90,5,.10) 38%, rgba(254,90,5,0) 68%);
  right: -380px; top: -520px; animation: glow 14s ease-in-out both; }
@keyframes glow { from { transform: translate(40px, -30px) scale(.94) } to { transform: translate(-80px, 40px) scale(1.04) } }
.vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at 40% 55%, rgba(0,0,0,0) 45%, rgba(8,12,24,.45) 100%); }
@keyframes up { from { opacity: 0; transform: translateY(26px) } to { opacity: 1; transform: none } }
@keyframes pop { from { opacity: 0; transform: scale(.82) } to { opacity: 1; transform: none } }
@keyframes grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
`

/** A sticky note on the title card's little board (position in the board's box, rotation, pop-in time). */
interface CardNote {
  text: string
  color: string
  x: number
  y: number
  rot: number
  at: number
}

/** The connector Alex draws on the title card: Sam's new note to the villain idea it builds on (board coordinates). */
const CARD_LINK = 'M 394 546 C 352 462, 330 362, 380 258'

/**
 * The title card: the DBC Lobby lockup on the left; on the right a small live board (a frame of sticky
 * notes, Sam's cursor adding one, Alex's drawing a connector), so the first thing on screen already
 * says "a whiteboard people use together".
 */
export function titleCardHtml(repoRoot: string): string {
  const notes: CardNote[] = [
    { text: 'Open on the boss fight', color: '#FFD66B', x: 60, y: 70, rot: -2.5, at: 0.95 },
    { text: 'Tell it from the villain’s side', color: '#FFB07C', x: 336, y: 40, rot: 2, at: 1.15 },
    { text: 'Premiere it live with creators', color: '#A9D6F5', x: 40, y: 330, rot: 1.6, at: 1.35 },
    { text: 'Hide a code in the last frame', color: '#AEE2B4', x: 404, y: 306, rot: -1.8, at: 1.55 },
    { text: 'Show the villain’s first win', color: '#D9C2F7', x: 300, y: 548, rot: -1, at: 2.75 },
  ]
  const noteHtml = notes
    .map(
      (n) =>
        `<div class="note" style="left:${n.x}px;top:${n.y}px;background:${n.color};--r:${n.rot}deg;animation-delay:${n.at}s">${esc(n.text)}</div>`,
    )
    .join('')
  const cursor = (who: string, color: string, cls: string) =>
    `<div class="cur ${cls}"><svg width="30" height="30" viewBox="0 0 26 26"><path d="M4 2.5v19.2l5.1-4.9 3.3 7.4 3.5-1.5-3.3-7.3h7.1z" fill="${color}" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg><span style="background:${color}">${esc(who)}</span></div>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${STAGE_CSS}
.wrap { position: absolute; left: 168px; top: 50%; transform: translateY(-50%); width: 900px; }
.hero { width: 176px; height: 176px; display: block; filter: drop-shadow(0 26px 50px rgba(0,0,0,.40));
  animation: pop 1s cubic-bezier(.2,.8,.2,1) .15s both; }
.lockup { margin-top: 46px; font-size: 128px; line-height: 1; letter-spacing: -.02em; animation: up .9s cubic-bezier(.2,.8,.2,1) .4s both; }
.lockup b { font-weight: 800; letter-spacing: -.035em; }
.lockup span { font-weight: 300; }
.rule { width: 128px; height: 7px; border-radius: 4px; background: ${ORANGE}; margin: 38px 0 32px; transform-origin: left;
  animation: grow .6s cubic-bezier(.2,.8,.2,1) .95s both; }
.tag { font-size: 46px; font-weight: 600; letter-spacing: -.01em; animation: up .8s cubic-bezier(.2,.8,.2,1) 1.15s both; }
.sub { margin-top: 18px; max-width: 800px; font-size: 30px; line-height: 1.42; color: rgba(246,244,238,.72);
  animation: up .8s cubic-bezier(.2,.8,.2,1) 1.45s both; }
.foot { position: absolute; left: 168px; bottom: 78px; font-size: 20px; font-weight: 600; letter-spacing: .2em;
  text-transform: uppercase; color: rgba(246,244,238,.46); animation: fade 1s ease 2.1s both; }
.board { position: absolute; left: 1128px; top: 168px; width: 700px; height: 790px; animation: drift-y 12s linear both; }
@keyframes drift-y { from { transform: translateY(8px) } to { transform: translateY(-14px) } }
.frame { position: absolute; inset: 0; border-radius: 26px; background: rgba(246,244,238,.045);
  border: 1.5px solid rgba(246,244,238,.13); animation: fade .9s ease .55s both; }
.frame-label { position: absolute; left: 6px; top: -38px; font-size: 21px; font-weight: 600; color: rgba(246,244,238,.5);
  animation: fade .9s ease .7s both; }
.note { position: absolute; width: 214px; height: 214px; border-radius: 7px; padding: 24px; display: flex; align-items: center;
  justify-content: center; text-align: center; font-size: 26px; line-height: 1.26; font-weight: 600; color: #1d2433;
  box-shadow: 0 22px 36px rgba(5,9,20,.38), 0 2px 5px rgba(5,9,20,.25); transform: rotate(var(--r));
  animation: note .55s cubic-bezier(.2,.9,.25,1.15) both; }
@keyframes note { from { opacity: 0; transform: rotate(var(--r)) scale(.6) } to { opacity: 1; transform: rotate(var(--r)) scale(1) } }
.link { position: absolute; left: 0; top: 0; overflow: visible; }
.link path { fill: none; stroke: #f6f4ee; stroke-width: 4.5; stroke-linecap: round; stroke-linejoin: round; }
.link .line { stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 1.05s cubic-bezier(.4,0,.2,1) 3.3s both; }
.link .tip { animation: fade .18s ease 4.3s both; }
@keyframes draw { to { stroke-dashoffset: 0 } }
.link { filter: drop-shadow(0 3px 6px rgba(0,0,0,.35)); }
.cur { position: absolute; left: 0; top: 0; display: flex; align-items: flex-start; gap: 2px;
  filter: drop-shadow(0 4px 8px rgba(0,0,0,.35)); }
.cur span { margin-top: 24px; padding: 4px 11px 5px; border-radius: 8px; color: #fff; font-size: 18px; font-weight: 600; white-space: nowrap; }
.sam { animation: fade .4s ease 1.2s both, sam 2.6s cubic-bezier(.45,0,.25,1) 1.2s both; }
@keyframes sam { 0% { transform: translate(-94px, 798px) } 50% { transform: translate(388px, 640px) }
  62% { transform: translate(388px, 640px) } 100% { transform: translate(548px, 700px) } }
.alex-in { position: absolute; left: 0; top: 0; width: 700px; height: 790px;
  animation: fade .4s ease 1.6s both, alex-in 1.5s cubic-bezier(.45,0,.25,1) 1.6s both; }
@keyframes alex-in { from { transform: translate(358px, 352px) } to { transform: none } }
.alex { offset-path: path('${CARD_LINK}'); offset-rotate: 0deg; offset-anchor: 4px 2px; offset-distance: 0%;
  animation: alex-go 1.05s cubic-bezier(.4,0,.2,1) 3.3s both; }
@keyframes alex-go { to { offset-distance: 100% } }
</style></head><body><div class="stage"><div class="dots"></div><div class="glow"></div><div class="vignette"></div></div>
<div class="wrap">${heroMark(repoRoot)}
<div class="lockup"><b>DBC</b> <span>Lobby</span></div><div class="rule"></div>
<div class="tag">Dark Burn Creative’s own whiteboard</div>
<div class="sub">Every project gets a lobby: shared boards for sketching, planning and reviewing work together.</div>
</div>
<div class="board"><div class="frame"></div><div class="frame-label">Trailer brainstorm</div>${noteHtml}
<svg class="link" width="700" height="790"><path class="line" pathLength="1" d="${CARD_LINK}"/><path class="tip" d="M 362.2 271 L 380 258 L 380.7 280"/></svg>
${cursor('Sam Lee', '#c8102e', 'sam')}<div class="alex-in">${cursor('Alex Rivera', '#0e7c86', 'alex')}</div></div>
<div class="foot">Product tour · September 2026</div></body></html>`
}

/** The outro card: "Lobby — live today" and three cards that sum the tour up. */
export function outroCardHtml(repoRoot: string): string {
  const facts: Array<[string, string]> = [
    ['Real-time collaboration', 'Live cursors, sticky notes, connectors and mind maps, saved as they happen.'],
    [
      'Workshops built in',
      'Private brainstorms, secret dot votes, present mode, and guests who join with just a name.',
    ],
    ['Our own stack', 'Files in Cloudflare R2, previews on DBC’s own server, backups offsite.'],
  ]
  const cards = facts
    .map(
      ([t, d], i) =>
        `<div class="card" style="animation-delay:${(1.05 + i * 0.28).toFixed(2)}s"><i></i><strong>${esc(t)}</strong><span>${esc(d)}</span></div>`,
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${STAGE_CSS}
.head { position: absolute; left: 0; right: 0; top: 196px; display: flex; justify-content: center; align-items: center; gap: 42px; }
.hero { width: 150px; height: 150px; filter: drop-shadow(0 24px 50px rgba(0,0,0,.40)); animation: pop .9s cubic-bezier(.2,.8,.2,1) .1s both; }
h1 { font-size: 112px; line-height: 1; letter-spacing: -.02em; font-weight: 300; animation: up .9s cubic-bezier(.2,.8,.2,1) .3s both; }
h1 b { font-weight: 800; }
h1 em { font-style: normal; color: ${ORANGE}; font-weight: 700; }
.grid { position: absolute; left: 50%; top: 470px; transform: translateX(-50%); display: grid;
  grid-template-columns: repeat(3, 500px); gap: 36px; }
.card { padding: 38px 38px 42px; border-radius: 24px; background: rgba(246,244,238,.055);
  border: 1px solid rgba(246,244,238,.12); box-shadow: 0 30px 60px rgba(5,9,20,.28);
  animation: up .75s cubic-bezier(.2,.8,.2,1) both; }
.card i { display: block; width: 52px; height: 52px; border-radius: 14px; background: ${ORANGE}; position: relative;
  box-shadow: 0 10px 26px rgba(254,90,5,.38); }
.card i::after { content: ""; position: absolute; left: 18px; top: 10px; width: 12px; height: 23px; border: solid #fff;
  border-width: 0 4.5px 4.5px 0; transform: rotate(45deg); }
.card strong { display: block; margin-top: 28px; font-size: 38px; font-weight: 600; letter-spacing: -.012em; }
.card span { display: block; margin-top: 12px; font-size: 26px; line-height: 1.45; color: rgba(246,244,238,.72); }
.foot { position: absolute; left: 0; right: 0; bottom: 84px; text-align: center; font-size: 20px; font-weight: 600;
  letter-spacing: .22em; text-transform: uppercase; color: rgba(246,244,238,.46); animation: fade 1s ease 2.2s both; }
</style></head><body><div class="stage"><div class="dots"></div><div class="glow"></div><div class="vignette"></div></div>
<div class="head">${heroMark(repoRoot)}<h1><b>Lobby</b> — <em>live today</em></h1></div>
<div class="grid">${cards}</div><div class="foot">Dark Burn Creative · DBC Lobby</div></body></html>`
}

const BAND_BG = '#16223a'

/**
 * The scene's caption, centred in the bottom band (transparent PNG, full frame): an orange tick and
 * the feature's name, in the same type as the cards.
 */
export function captionHtml(text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
html, body { background: transparent; }
.cap { position: absolute; left: 50%; top: ${PANE.h}px; height: ${BAND_H}px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 16px; white-space: nowrap; padding: 0 34px;
  background: ${BAND_BG}; }
.cap i { width: 5px; height: 30px; border-radius: 3px; background: ${ORANGE}; }
.cap span { color: #fff; font-size: 31px; font-weight: 600; letter-spacing: -.005em; }
</style></head><body><div class="cap"><i></i><span>${esc(text)}</span></div></body></html>`
}

/**
 * The frame around the two panes (opaque band, transparent panes, full frame): the divider between
 * the panes and the bottom band with each person's name in their presence colour, at the outer edges
 * (the caption takes the middle).
 */
export function bandHtml(people: {
  left: { name: string; role: string; color: string }
  right: { name: string; role: string; color: string }
}) {
  const who = (p: { name: string; role: string; color: string }, side: 'left' | 'right') =>
    `<div class="who ${side}"><i style="background:${p.color}"></i><b>${esc(p.name)}</b><small>${esc(p.role)}</small></div>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
html, body { background: transparent; }
.div { position: absolute; left: ${W / 2 - 2}px; top: 0; width: 4px; height: ${PANE.h}px; background: ${BAND_BG}; }
.band { position: absolute; left: 0; top: ${PANE.h}px; width: ${W}px; height: ${BAND_H}px; background: ${BAND_BG};
  box-shadow: 0 -1px 0 rgba(255,255,255,.07) inset; }
.band::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px;
  background: linear-gradient(90deg, rgba(254,90,5,0) 0%, rgba(254,90,5,.55) 50%, rgba(254,90,5,0) 100%); }
.who { position: absolute; top: ${PANE.h}px; height: ${BAND_H}px; display: flex; align-items: center; gap: 12px;
  color: #fff; font-size: 23px; white-space: nowrap; }
.who i { width: 13px; height: 13px; border-radius: 50%; box-shadow: 0 0 0 2.5px rgba(255,255,255,.9); margin-right: 3px; }
.who b { font-weight: 600; }
.who small { font-size: 20px; color: rgba(246,244,238,.58); font-weight: 400; }
.left { left: 34px; }
.right { right: 34px; }
</style></head><body><div class="div"></div><div class="band"></div>${who(people.left, 'left')}${who(people.right, 'right')}</body></html>`
}

/** A phone body around PHONE_SCREEN, with a label; the screen area stays transparent. */
export function phoneFrameHtml(label: string): string {
  const s = PHONE_SCREEN
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
html, body { background: transparent; }
.body { position: absolute; left: ${s.x - BEZEL}px; top: ${s.y - BEZEL}px; width: ${s.w + BEZEL * 2}px; height: ${s.h + BEZEL * 2}px;
  border-radius: 58px; border: ${BEZEL}px solid #0d1320; box-shadow: 0 0 0 2px #3a4560, 0 40px 90px rgba(0,0,0,.55); }
.lab { position: absolute; top: ${s.y + s.h + BEZEL + 14}px; left: ${s.x + s.w / 2}px; transform: translateX(-50%); white-space: nowrap;
  display: flex; align-items: center; gap: 10px; padding: 7px 16px 8px 12px; border-radius: 999px;
  background: rgba(22, 34, 58, .92); color: #fff; font-size: 20px; font-weight: 600; }
.lab i { width: 11px; height: 11px; border-radius: 50%; background: ${ORANGE}; box-shadow: 0 0 0 2px rgba(255,255,255,.9); }
</style></head><body><div class="body"></div><div class="lab"><i></i>${esc(label)}</div></body></html>`
}

/** Renders a transparent overlay PNG (full frame). */
export async function renderPng(browser: Browser, html: string, file: string) {
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  try {
    await page.setContent(html)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: file, omitBackground: true })
  } finally {
    await page.close()
  }
}

/**
 * Renders an animated card to an H.264 file, frame by frame: every CSS animation is paused and seeked
 * to the frame's time before the screenshot, so the result does not depend on the machine's speed.
 */
export async function renderCard(
  browser: Browser,
  html: string,
  seconds: number,
  file: string,
  ffmpeg = 'ffmpeg',
) {
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  const frames = Math.round(seconds * FPS)
  const enc = spawn(
    ffmpeg,
    [
      ...[
        '-y',
        '-loglevel',
        'error',
        '-f',
        'image2pipe',
        '-framerate',
        String(FPS),
        '-c:v',
        'mjpeg',
        '-i',
        'pipe:0',
      ],
      ...['-frames:v', String(frames), '-vf', TO_BT709],
      ...['-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv420p', ...BT709_FLAGS],
      ...['-r', String(FPS), '-video_track_timescale', '15360', file],
    ],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
  )
  let err = ''
  enc.stderr.on('data', (d) => {
    err += String(d)
  })
  const closed = new Promise<number>((r) => enc.once('close', (c) => r(c ?? 1)))
  try {
    await page.setContent(html)
    await page.evaluate(() => document.fonts.ready)
    for (let i = 0; i < frames; i++) {
      const t = (i / FPS) * 1000
      await page.evaluate((ms) => {
        for (const a of document.getAnimations()) {
          a.pause()
          a.currentTime = ms
        }
      }, t)
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 95 })
      if (!enc.stdin.write(jpeg)) await new Promise((r) => enc.stdin.once('drain', r))
    }
    enc.stdin.end()
    const code = await closed
    if (code !== 0) throw new Error(`ffmpeg (card) exited ${code}: ${err}`)
  } finally {
    await page.close()
  }
}
