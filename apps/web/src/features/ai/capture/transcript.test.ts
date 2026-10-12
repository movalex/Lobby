// Wave N (WS5, N5-4): a transcript as the capture sends it (./transcript.ts): .vtt and .srt cue numbers, timestamps and
// markup out, speaker names kept, repeats once; plain and Markdown text with their leading timestamps out; and the
// notice past 60,000 characters.
import { CAPTURE_TRANSCRIPT_MAX_CHARS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { formatOf, parseTranscript, TRANSCRIPT_READ_BYTES, transcriptLimit } from './transcript.ts'

const VTT = `WEBVTT
Kind: captions
Language: en

NOTE This meeting was recorded.
It has two speakers.

STYLE
::cue { color: yellow }

1
00:00:01.000 --> 00:00:04.200 align:start position:10%
<v Ana Lopez>We should move the shoot to the 14th.</v>

2
00:00:04.200 --> 00:00:07.000
<v Bo>Agreed, the studio is free</v>
<v Bo>then.</v>

c3-a
00:00:07.000 --> 00:00:09.500
<v.loud Ana Lopez><c.yellow>Bo</c> will send the <i>revised</i> budget &amp; the plan.</v>

00:00:09.500 --> 00:00:11.000
<v.loud Ana Lopez><c.yellow>Bo</c> will send the <i>revised</i> budget &amp; the plan.</v>

00:00:11.000 --> 00:00:12.000
<00:00:11.200>Thanks<00:00:11.600> everyone.
`

const SRT = `1
00:00:01,000 --> 00:00:04,000
ANA: We should move the shoot
to the 14th.

2
00:00:04,500 --> 00:00:06,000
{\\an8}<i>BO: Agreed.</i>

3
00:00:06,000 --> 00:00:08,000
- Travel is over budget.
`

describe('parsing', () => {
  it('a .vtt: header, NOTE and STYLE blocks, cue ids, timings and markup out; speakers kept; a repeat once', () => {
    expect(parseTranscript(VTT, 'vtt')).toBe(
      [
        'Ana Lopez: We should move the shoot to the 14th.',
        'Bo: Agreed, the studio is free then.',
        'Ana Lopez: Bo will send the revised budget & the plan.',
        'Thanks everyone.',
      ].join('\n'),
    )
  })

  it('a .srt: numbers, timings and positioning out; the speaker as written stays', () => {
    expect(parseTranscript(SRT, 'srt')).toBe(
      ['ANA: We should move the shoot to the 14th.', 'BO: Agreed.', '- Travel is over budget.'].join('\n'),
    )
  })

  it('plain text and Markdown: leading timestamps out, Markdown marks out, blank runs once', () => {
    const txt = '[00:01:02] Ana: Hello\r\n00:01:09 - Bo: Hi\n\n\n\n(1:15) Sam: Last point'
    expect(parseTranscript(txt, 'txt')).toBe('Ana: Hello\nBo: Hi\n\nSam: Last point')
    const md = '# Weekly sync\n\n- **Ana**: ship Friday\n> Bo: fine'
    expect(parseTranscript(md, 'md')).toBe('Weekly sync\n\nAna: ship Friday\nBo: fine')
  })

  it('the format from the file name, else from the first line', () => {
    expect(formatOf('Meeting.VTT', '')).toBe('vtt')
    expect(formatOf('notes.srt', '')).toBe('srt')
    expect(formatOf('notes.md', '')).toBe('md')
    expect(formatOf('pasted', 'WEBVTT\n\n00:00.000 --> 00:01.000\nHi')).toBe('vtt')
    expect(formatOf('pasted', '1\n00:00:01,000 --> 00:00:02,000\nHi')).toBe('srt')
    expect(formatOf('pasted', 'Ana: hi')).toBe('txt')
  })
})

describe('the limit', () => {
  it('within it, nothing is said; past it, "Only the first 60,000 characters will be used." and the text is cut', () => {
    expect(transcriptLimit('  hello  ')).toEqual({ text: 'hello', length: 5, truncated: false, notice: null })
    const long = transcriptLimit('x'.repeat(CAPTURE_TRANSCRIPT_MAX_CHARS + 10))
    expect(long.truncated).toBe(true)
    expect(long.text).toHaveLength(CAPTURE_TRANSCRIPT_MAX_CHARS)
    expect(long.length).toBe(CAPTURE_TRANSCRIPT_MAX_CHARS + 10)
    expect(long.notice).toBe('Only the first 60,000 characters will be used.')
    // never half an emoji at the cut
    const emoji = transcriptLimit(`${'x'.repeat(9)}😀abc`, 10)
    expect(emoji.text).toBe('x'.repeat(9))
  })

  it('text of 3 bytes a character is cut where the api stops reading, and the notice says how much is used', () => {
    expect(TRANSCRIPT_READ_BYTES).toBe(132_000)
    // 50,000 characters of Chinese are 150,000 bytes: the api reads about 44,000 of them
    const cjk = transcriptLimit('会'.repeat(50_000))
    expect(cjk.truncated).toBe(true)
    expect(cjk.length).toBe(50_000)
    expect(cjk.text).toHaveLength(44_000)
    expect(new TextEncoder().encode(cjk.text).length).toBeLessThanOrEqual(TRANSCRIPT_READ_BYTES)
    expect(cjk.notice).toBe('Only the first 44,000 characters will be used.')
    // Latin text within 60,000 characters is read whole
    expect(transcriptLimit('Ana: ok. '.repeat(6_000).slice(0, 54_000)).truncated).toBe(false)
    // accented Latin (2 bytes a letter) at the character limit still fits the bytes
    expect(transcriptLimit('é'.repeat(60_000)).truncated).toBe(false)
    // never half an emoji at a byte cut either (4 bytes each)
    const emoji = transcriptLimit('😀'.repeat(10), 100, 10)
    expect(emoji.text).toBe('😀😀')
    expect(emoji.notice).toBe('Only the first 4 characters will be used.')
  })
})
