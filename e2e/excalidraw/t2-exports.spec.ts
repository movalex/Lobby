// Wave T, WS3 (T2): the storyboard exports as FILES, from the Export dialog:
//  - the storyboard PDF sheet (3 panels a page): every panel's number and every field's words are text a viewer
//    finds (pdf.js), the pictures image objects, a page per three panels;
//  - the image sequence: a ZIP of one PNG per panel at the chosen width and aspect, timings.csv and a CMX3600
//    animatic.edl whose events are the panels back to back at the chosen rate;
//  - the shot numbers are drawn into an ordinary export (the export layer `storyboard`): the board's SVG holds them;
//  - a disguised audio file (HTML named .mp3) is an octet-stream attachment, and a storyboard naming it plays silent;
//  - downloads only through the browser's download (no File System Access picker), nothing leaves Lobby's origins.
// Needs a sync that takes planning keys (t2-kit.ts PLANNING_SYNC_ENV and WS1's rules).
import { expect, test } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { downloadFrom, pdfPageTexts, readPdf } from '../tests/support/present-export.ts'
import { openBoardExport } from './present-kit.ts'
import {
  countPickers,
  foreignRequests,
  openAnimatic,
  PLANNING_SYNC_ENV,
  placeFileCard,
  planningSwitches,
  player,
  seedStoryboard,
  setHead,
  sixPanels,
  upload,
} from './t2-kit.ts'

test.use({ syncEnv: PLANNING_SYNC_ENV })

const DURATIONS = [700, 1300, 500, 900, 1100, 600]

interface Entry {
  name: string
  data: Buffer
}

/** The entries of a ZIP (its central directory and each local header; stored entries only). */
function unzip(buf: Buffer): Entry[] {
  const eocd = buf.length - 22
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50)
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  const out: Entry[] = []
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50)
    expect(buf.readUInt16LE(at + 10), 'stored').toBe(0)
    const size = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    out.push({ name, data: buf.subarray(start, start + size) })
    at += 46 + nameLen
  }
  return out
}

const pngSize = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) })

test.describe('T2 storyboard exports', () => {
  test('the PDF sheet: every number and field is searchable text; the image sequence: PNGs, timings.csv and an EDL; shot numbers in the SVG', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    const foreign = foreignRequests(a.context)
    const pickers = await countPickers(a.page)
    await planningSwitches(a.page)
    await seedStoryboard(a.page, {
      head: 't2x-h',
      title: 'Spot 30',
      settings: { aspect: '16:9', fps: 25 },
      panels: sixPanels('t2x-h', DURATIONS),
    })

    await openBoardExport(a.page)
    const dialog = a.page.getByTestId('export-dialog')
    await expect(dialog.getByTestId('export-sb-sheet-section')).toBeVisible()
    await expect(dialog.getByTestId('export-sb-sequence-section')).toBeVisible()

    // the sheet, 3 panels a page
    await dialog.getByTestId('export-sb-sheet-3').check()
    const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-sb-sheet').click())
    expect(pdf.name).toBe('Spot 30 - storyboard.pdf')
    await expect(dialog.getByTestId('export-status')).toHaveText(
      'Downloaded “Spot 30 - storyboard.pdf” (2 pages).',
    )
    const info = await readPdf(pdf.bytes)
    expect(info.pages).toHaveLength(2)
    // each panel's picture is an image object on its page
    expect(info.pages.map((p) => p.images.length)).toEqual([3, 3])
    const texts = await pdfPageTexts(pdf.bytes)
    for (let n = 1; n <= 6; n++) {
      const page = texts[Math.floor((n - 1) / 3)] ?? ''
      expect(page, `SH 0${n}`).toContain(`SH 0${n}`)
      for (const word of [
        `Camera ${n} wide`,
        `Action ${n} she turns`,
        `Dialogue ${n} hello`,
        `Sfx ${n} door`,
        `Music ${n} strings`,
      ])
        expect(page, word).toContain(word)
    }
    expect(texts[0]).toContain('Running time 0:05')
    expect(texts[1]).toContain('Page 2 of 2')

    // the image sequence, 1280 wide at 25 fps
    await dialog.getByTestId('export-sb-sequence-width').selectOption('1280')
    await expect(dialog.getByTestId('export-sb-sequence-fps')).toHaveValue('25')
    const zip = await downloadFrom(a.page, () => dialog.getByTestId('export-sb-sequence').click())
    expect(zip.name).toBe('Spot 30 - image sequence.zip')
    await expect(dialog.getByTestId('export-status')).toContainText(
      'Downloaded “Spot 30 - image sequence.zip” (6 frames',
    )
    const entries = unzip(zip.bytes)
    expect(entries.map((e) => e.name)).toEqual([
      'Spot 30_0001.png',
      'Spot 30_0002.png',
      'Spot 30_0003.png',
      'Spot 30_0004.png',
      'Spot 30_0005.png',
      'Spot 30_0006.png',
      'timings.csv',
      'animatic.edl',
    ])
    for (const e of entries.slice(0, 6)) {
      expect(e.data.subarray(0, 8).toString('latin1'), e.name).toBe('\x89PNG\r\n\x1a\n')
      expect(pngSize(e.data), e.name).toEqual({ width: 1280, height: 720 })
    }
    const csv = (entries[6] as Entry).data.toString('utf8')
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const rows = csv.slice(1).trimEnd().split('\r\n')
    expect(rows[0]).toBe(
      'Shot,File,Start,End,Duration (s),Duration (frames),Name,Camera,Action,Dialogue,SFX,Music',
    )
    expect(rows[1]).toBe(
      '1,Spot 30_0001.png,00:00:00:00,00:00:00:18,0.7,18,Panel 1,Camera 1 wide,Action 1 she turns,Dialogue 1 hello,Sfx 1 door,Music 1 strings',
    )
    expect(rows).toHaveLength(7)
    const edl = (entries[7] as Entry).data.toString('utf8').split('\r\n')
    expect(edl.slice(0, 2)).toEqual(['TITLE: Spot 30', 'FCM: NON-DROP FRAME'])
    const events = edl.filter((l) => /^\d{3} {2}AX/.test(l))
    expect(events).toEqual([
      '001  AX       V     C        00:00:00:00 00:00:00:18 00:00:00:00 00:00:00:18',
      '002  AX       V     C        00:00:00:00 00:00:01:07 00:00:00:18 00:00:02:00',
      '003  AX       V     C        00:00:00:00 00:00:00:13 00:00:02:00 00:00:02:13',
      '004  AX       V     C        00:00:00:00 00:00:00:22 00:00:02:13 00:00:03:10',
      '005  AX       V     C        00:00:00:00 00:00:01:03 00:00:03:10 00:00:04:13',
      '006  AX       V     C        00:00:00:00 00:00:00:15 00:00:04:13 00:00:05:03',
    ])
    expect(edl).toContain('* FROM CLIP NAME: Spot 30_0006.png')

    // an ordinary SVG export of the board draws the shot numbers
    const svg = await downloadFrom(a.page, () => dialog.getByTestId('export-svg').click())
    const svgText = svg.bytes.toString('utf8')
    for (let n = 1; n <= 6; n++) expect(svgText).toContain(`>SH 0${n}</text>`)

    expect(await pickers()).toBe(0)
    expect(foreign).toEqual([])
  })

  test('a disguised audio file (HTML named .mp3) is an attachment, and a storyboard naming it plays without sound', async ({
    canvasSession,
    users,
    board,
  }) => {
    const a = await canvasSession('alice')
    await planningSwitches(a.page)
    const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>')
    const fake = await upload(users, board, 'track.mp3', 'audio/mpeg', html)
    expect(fake).toMatchObject({ kind: 'other', mimeType: 'application/octet-stream' })
    const res = await (await users.api('alice')).request.get(
      `${WEB_URL}/files/${fake.assetId}/${fake.versionId}/original?board=${board}`,
    )
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toBe('application/octet-stream')
    expect(res.headers()['content-disposition']).toMatch(/^attachment/)
    expect(res.headers()['x-content-type-options']).toBe('nosniff')

    await seedStoryboard(a.page, {
      head: 't2d-h',
      title: 'Silent',
      settings: { aspect: '16:9' },
      panels: sixPanels('t2d-h', [500, 500]),
    })
    await placeFileCard(a.page, 't2d-fake', fake, { x: 0, y: 600 })
    await setHead(a.page, 't2d-h', { aspect: '16:9', audio: 't2d-fake' })
    await openAnimatic(a.page, 't2d-h-p1')
    await expect(player(a.page).getByTestId('animatic-audio')).toHaveCount(0)
    await expect(a.page.getByTestId('animatic-status')).not.toContainText('Sound:')
  })
})
