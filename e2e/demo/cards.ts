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

/** Where the phone inset goes during the guest scene (the screen area inside the frame). */
export const PHONE_SCREEN = { x: 1304, y: 118, w: 392, h: 848 }
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

export function titleCardHtml(repoRoot: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${STAGE_CSS}
.wrap { position: absolute; left: 250px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 72px; }
.hero { width: 300px; height: 300px; filter: drop-shadow(0 30px 60px rgba(0,0,0,.35)); animation: pop 1s cubic-bezier(.2,.8,.2,1) .15s both; }
.text { display: flex; flex-direction: column; }
.lockup { font-size: 132px; line-height: 1; letter-spacing: -.02em; animation: up .9s cubic-bezier(.2,.8,.2,1) .45s both; }
.lockup b { font-weight: 800; letter-spacing: -.035em; }
.lockup span { font-weight: 300; }
.rule { width: 132px; height: 7px; border-radius: 4px; background: ${ORANGE}; margin: 40px 0 34px; transform-origin: left;
  animation: grow .6s cubic-bezier(.2,.8,.2,1) 1.05s both; }
.tag { font-size: 46px; font-weight: 600; letter-spacing: -.01em; animation: up .8s cubic-bezier(.2,.8,.2,1) 1.25s both; }
.sub { margin-top: 18px; max-width: 900px; font-size: 30px; line-height: 1.4; font-weight: 400; color: rgba(246,244,238,.72);
  animation: up .8s cubic-bezier(.2,.8,.2,1) 1.6s both; }
.foot { position: absolute; left: 250px; bottom: 90px; font-size: 22px; font-weight: 600; letter-spacing: .16em;
  text-transform: uppercase; color: rgba(246,244,238,.5); animation: fade 1s ease 2.1s both; }
</style></head><body><div class="stage"><div class="dots"></div><div class="glow"></div><div class="vignette"></div></div>
<div class="wrap">${heroMark(repoRoot)}<div class="text">
<div class="lockup"><b>DBC</b> <span>Lobby</span></div><div class="rule"></div>
<div class="tag">Dark Burn Creative’s own whiteboard</div>
<div class="sub">Every project gets a lobby: shared boards for sketching, planning and reviewing work together.</div>
</div></div><div class="foot">Product tour · recorded on a local Lobby build</div></body></html>`
}

export function outroCardHtml(repoRoot: string): string {
  const facts: Array<[string, string]> = [
    ['Real-time collaboration', 'Live cursors, sticky notes, connectors and mind maps, saved as they happen'],
    [
      'Guests, private brainstorms and votes',
      'Clients join with just a name; ideas stay hidden until the reveal',
    ],
    ['Our own stack', 'Files in Cloudflare R2, previews on DBC’s server, offsite backups'],
  ]
  const items = facts
    .map(
      (
        [t, d],
        i,
      ) => `<li style="animation-delay:${(1.25 + i * 0.35).toFixed(2)}s"><i></i><div><strong>${esc(t)}</strong>
<span>${esc(d)}</span></div></li>`,
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${STAGE_CSS}
.wrap { position: absolute; left: 250px; right: 200px; top: 50%; transform: translateY(-50%); }
.head { display: flex; align-items: center; gap: 44px; }
.hero { width: 170px; height: 170px; filter: drop-shadow(0 24px 50px rgba(0,0,0,.35)); animation: pop .9s cubic-bezier(.2,.8,.2,1) .1s both; }
h1 { font-size: 104px; line-height: 1; letter-spacing: -.02em; font-weight: 300; animation: up .9s cubic-bezier(.2,.8,.2,1) .35s both; }
h1 b { font-weight: 800; }
h1 em { font-style: normal; color: ${ORANGE}; font-weight: 700; }
ul { list-style: none; margin-top: 76px; display: grid; gap: 34px; }
li { display: flex; gap: 28px; align-items: flex-start; animation: up .75s cubic-bezier(.2,.8,.2,1) both; }
li i { flex: none; width: 44px; height: 44px; margin-top: 4px; border-radius: 12px; background: ${ORANGE};
  box-shadow: 0 8px 24px rgba(254,90,5,.35); position: relative; }
li i::after { content: ""; position: absolute; left: 15px; top: 9px; width: 10px; height: 19px; border: solid #fff;
  border-width: 0 4px 4px 0; transform: rotate(45deg); }
li strong { display: block; font-size: 44px; font-weight: 600; letter-spacing: -.01em; }
li span { display: block; margin-top: 6px; font-size: 28px; color: rgba(246,244,238,.7); }
</style></head><body><div class="stage"><div class="dots"></div><div class="glow"></div><div class="vignette"></div></div>
<div class="wrap"><div class="head">${heroMark(repoRoot)}<h1><b>Lobby</b> — <em>live today</em></h1></div>
<ul>${items}</ul></div></body></html>`
}

/**
 * A lower-third caption (transparent PNG, full frame). It sits above the bottom band where the app
 * keeps its toolbar, vote bar and notices; `bottom` moves it for a scene that needs it elsewhere.
 */
export function captionHtml(text: string, bottom = 215): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
html, body { background: transparent; }
.cap { position: absolute; left: 50%; bottom: ${bottom}px; transform: translateX(-50%); display: flex; align-items: center; gap: 18px;
  padding: 16px 30px 17px 22px; border-radius: 16px; white-space: nowrap;
  background: rgba(20, 29, 49, .80); border: 1px solid rgba(255,255,255,.14);
  box-shadow: 0 14px 40px rgba(8, 12, 24, .35); }
.cap i { width: 6px; height: 34px; border-radius: 3px; background: ${ORANGE}; }
.cap span { color: #fff; font-size: 34px; font-weight: 600; letter-spacing: -.005em; }
</style></head><body><div class="cap"><i></i><span>${esc(text)}</span></div></body></html>`
}

/** The divider and the two name labels (transparent PNG, full frame). */
export function labelsHtml(people: {
  left: { name: string; color: string }
  right: { name: string; color: string }
}) {
  const pill = (p: { name: string; color: string }, side: 'left' | 'right') =>
    `<div class="pill ${side}"><i style="background:${p.color}"></i>${esc(p.name)}</div>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
html, body { background: transparent; }
.div { position: absolute; left: ${W / 2 - 2}px; top: 0; width: 4px; height: ${H}px; background: ${NAVY}; }
.pill { position: absolute; bottom: 42px; display: flex; align-items: center; gap: 8px; padding: 5px 13px 6px 9px;
  border-radius: 999px; background: rgba(20, 29, 49, .80); color: #fff; font-size: 19px; font-weight: 600;
  box-shadow: 0 4px 14px rgba(8,12,24,.22); }
.pill i { width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 0 2px rgba(255,255,255,.85); }
.left { left: 58px; }
.right { left: ${W / 2 + 58}px; }
</style></head><body><div class="div"></div>${pill(people.left, 'left')}${pill(people.right, 'right')}</body></html>`
}

/** A phone body around PHONE_SCREEN, with a label; the screen area stays transparent. */
export function phoneFrameHtml(label: string): string {
  const s = PHONE_SCREEN
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
html, body { background: transparent; }
.body { position: absolute; left: ${s.x - BEZEL}px; top: ${s.y - BEZEL}px; width: ${s.w + BEZEL * 2}px; height: ${s.h + BEZEL * 2}px;
  border-radius: 58px; border: ${BEZEL}px solid #0d1320; box-shadow: 0 0 0 2px #3a4560, 0 40px 90px rgba(0,0,0,.55); }
.lab { position: absolute; top: ${s.y + s.h + BEZEL + 18}px; left: ${s.x + s.w / 2}px; transform: translateX(-50%); white-space: nowrap;
  padding: 8px 16px 9px; border-radius: 999px; background: rgba(20, 29, 49, .86); color: #fff; font-size: 21px; font-weight: 600; }
</style></head><body><div class="body"></div><div class="lab">${esc(label)}</div></body></html>`
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
