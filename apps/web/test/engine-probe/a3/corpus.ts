/**
 * Spike check A3: the 208-label corpus laid out in Node and in Chromium (plan §2.11, §8.2 A3).
 *
 * Deterministic: the same labels, fonts, sizes and widths on every run and in both runtimes.
 * Categories (counts): short 30, medium 50, long 30, unbroken 20, emoji 20, cjk 24, newlines 24,
 * punct 10 = 208. The calibration samples in `../browser/calibrate.ts` exclude every character used
 * here outside the per-character table, so class widths (CJK, emoji) are tested on held-out glyphs.
 */

export type Category = 'short' | 'medium' | 'long' | 'unbroken' | 'emoji' | 'cjk' | 'newlines' | 'punct'

export interface CorpusLabel {
  id: string
  category: Category
  text: string
  fontFamily: 5 | 6 | 8
  baseFontSize: number
  width: number
}

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const VOCAB = (
  'the a an and or but so to of in on for with at by from as is are was be we our team client brand ' +
  'campaign launch shoot edit script scene shot color grade sound mix music voice cast crew budget ' +
  'schedule deadline review feedback approve draft final version asset render export deliver ' +
  'storyboard moodboard palette typography logo concept pitch deck strategy audience channel social ' +
  'video photo motion graphics animation title credits location permit travel lunch meeting call ' +
  'notes idea question risk blocker owner next steps priority quick win follow up sync decide ' +
  'research insight persona journey workshop sprint retro backlog ticket estimate scope timeline ' +
  'quarter goal metric revenue growth engagement reach impressions conversion landing page website ' +
  'newsletter podcast episode interview transcript caption subtitle thumbnail banner poster print ' +
  'billboard presentation handoff production postproduction preproduction exploration iteration ' +
  'alignment stakeholder responsibility accountability collaboration communication documentation ' +
  'wonderful tiny huge simple complex early late urgent optional important nice bold warm cool'
).split(' ')

const sentence = (rand: () => number, words: number): string => {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(VOCAB[Math.floor(rand() * VOCAB.length)] ?? 'idea')
  const s = out.join(' ')
  return s.charAt(0).toUpperCase() + s.slice(1) + (rand() < 0.3 ? '.' : rand() < 0.5 ? '?' : '')
}

const SHORT = [
  'Ship it',
  'Q3 goals',
  'Ask legal',
  'Budget?',
  'Kickoff Monday',
  'Hero shot',
  'Moodboard',
  'Call Dana',
  'Color grade',
  'Final mix',
  'Logo v2',
  'Storyboard',
  'Cast list',
  'Location scout',
  'Wrap party',
  'B-roll',
  'Voiceover',
  'Rough cut',
  'Thumbnail',
  'Pitch deck',
  'Launch',
  'Retro',
  'Sprint 12',
  'Risks',
  'Owner: Sam',
  'Due Fri',
  'Blocked',
  'Nice to have',
  'MVP',
  'Parking lot',
]

const UNBROKEN = [
  'https://dbc.example.com/projects/2026/brand-refresh/assets/final-cut',
  'Supercalifragilisticexpialidocious',
  'Donaudampfschifffahrtsgesellschaftskapitän',
  '#brandrefresh2026campaignlaunchweek',
  'a3f9c2e1b7d84f6a9e0c1d2b3a4f5e6d',
  'CamelCaseIdentifierThatNeverEndsAtAll',
  'snake_case_variable_name_for_the_export_pipeline',
  '2026-09-28T14:30:00.000Z',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  'first.last@darkburncreative.example.com',
  'See https://docs.example.org/guide/getting-started/installation for the setup steps',
  'Pneumonoultramicroscopicsilicovolcanoconiosis is a long word',
  'The file is FINAL_FINAL_v7_really_final_approved_by_client.mov',
  'Tag: #colorgrade #vfx #postproduction #deliverables',
  'Reference AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
  'iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii',
  'Path C:\\Users\\Producer\\Projects\\Lobby\\exports\\2026\\september',
  'Mix of short and extraordinarilylongunbrokenwordsthatmustbreak here',
  'Hashtag#without#spaces#between#any#of#the#words#at#all',
]

const EMOJI = [
  'Great idea 🎉',
  '🚀 Launch day',
  '🔥🔥🔥',
  'Done ✅ / Not done ❌',
  '👍 from the team 👏🙌',
  'Coffee ☕ first, then the review',
  '🎨 palette 🎬 shots 🎧 music',
  'Offices: 🇺🇸 🇯🇵 🇧🇷',
  'Team 👩‍💻👨‍🎨 pairing on the edit',
  'Thanks 👍🏽👋🏾 everyone',
  'Step 1️⃣ script, 2️⃣ shoot, 3️⃣ edit',
  '💡 What if the intro was a single continuous shot through the studio? 🎥',
  'Pizza 🍕 or tacos 🌮 for the wrap party?',
  '📌 Pin this: the client prefers warm tones 🌅',
  '⭐⭐⭐⭐⭐ reviews from the test audience',
  'Deadline ⏰ moved to Thursday 📅',
  'Budget 💰 approved 🏆',
  '🎯 Goal: 10k views in week one 📈',
  'Mood: 🌧️ moody, ❄️ cold, 🌙 night',
  '🤔🤔 not sure about the font 🔤',
]

const CJK = [
  '会议记录：下周一开始拍摄',
  '预算需要再确认一次',
  '客户希望色调更温暖一些，请调整调色方案。',
  '剪辑初版已完成，等待反馈',
  '品牌更新项目的时间表',
  '字幕需要中英双语',
  '今日の打ち合わせメモ',
  'ロケハンは金曜日に行います。',
  'サムネイルの色をもう少し明るくしてください',
  'スケジュール確認お願いします！',
  '台本の第二稿を共有しました',
  '撮影スタッフのリスト',
  '다음 주 촬영 일정',
  '예산 승인 완료',
  '클라이언트 피드백을 반영해 주세요.',
  '편집 마감은 목요일입니다',
  'Q3の目標: 売上を増やす',
  '2026年のキャンペーン計画',
  'Logo 设计第三版 v3',
  'Final cut 最终版本 (4K)',
  '「重要」明日までに提出',
  '【确认】拍摄许可已经拿到了',
  '音楽とナレーションのミックスを調整する必要があります。',
  '이번 분기 목표는 조회수 증가와 구독자 확보입니다.',
]

const NEWLINES = [
  'Agenda\n• Intro\n• Budget\n• Next steps',
  '1. Script\n2. Shoot\n3. Edit\n4. Deliver',
  'Line one\nLine two',
  'Title\n\nBody after a blank line',
  'Trailing newline\n',
  '\nLeading newline',
  'Owner: Sam\nDue: Friday\nStatus: in review',
  'A long first line that will need to wrap inside the note\nand a short second',
  '• Warm tones\n• Handheld camera\n• Natural light\n• Minimal text on screen',
  'Q: Who approves?\nA: The client lead, after the internal review',
  'Pros\n+ fast\n+ cheap\nCons\n- risky',
  'Shot list:\n1. Wide establishing\n2. Medium on host\n3. Close-up on product\n4. Cutaways',
  'Monday\nTuesday\nWednesday\nThursday\nFriday\nSaturday\nSunday',
  'Header\n\n\nThree blank lines above',
  'Remember:\nkeep the logo clear of the safe area on every export size',
  'Ideas\n- podcast series\n- behind the scenes reel\n- client testimonial',
  'Mixed 🎬\nemoji line\n会议 line',
  'x\ny\nz',
  'Draft\nv1 → v2 → v3',
  'Very long line one with many words that keeps going and going past the edge\nVery long line two that also keeps going and going past the edge of the note',
  'Top\n\nMiddle\n\nBottom',
  '1) prep\n2) record\n3) review',
  'Notes from the call\nClient liked the second concept\nWants a faster intro\nMusic too loud',
  'End with\n\n',
]

const PUNCT = [
  'Café naïve résumé — déjà vu',
  '“Quoted” and ‘single’ quotes',
  '$1,250.00 + 20% (est.)',
  'well-known, state-of-the-art, end-to-end workflow',
  'Q&A: who/what/when/where/why?',
  "C'est très bien! Ça marche.",
  'Größe: 3×4 m², Übergröße',
  '±5% ≈ fine… probably',
  "It's 9:30 a.m. — don't be late!",
  'Señor Muñoz’s «notes» ¿sí? ¡Olé!',
]

/** Excalidraw's `FONT_SIZES` (sm 16, md 20, lg 28, xl 36) plus Lobby's 24. */
const SIZES = [20, 28, 16, 36, 24]
const WIDTHS = [200, 200, 250, 150, 300, 200, 180]

export const buildCorpus = (): CorpusLabel[] => {
  const rand = mulberry32(20260928)
  const texts: { category: Category; text: string }[] = []
  for (const text of SHORT) texts.push({ category: 'short', text })
  for (let i = 0; i < 50; i++)
    texts.push({ category: 'medium', text: sentence(rand, 4 + Math.floor(rand() * 12)) })
  for (let i = 0; i < 30; i++) {
    const n = 16 + Math.floor(rand() * 45)
    let t = sentence(rand, n)
    if (i % 3 === 0) t = `${t} ${sentence(rand, 8)}`
    texts.push({ category: 'long', text: t })
  }
  for (const text of UNBROKEN) texts.push({ category: 'unbroken', text })
  for (const text of EMOJI) texts.push({ category: 'emoji', text })
  for (const text of CJK) texts.push({ category: 'cjk', text })
  for (const text of NEWLINES) texts.push({ category: 'newlines', text })
  for (const text of PUNCT) texts.push({ category: 'punct', text })
  if (texts.length !== 208) throw new Error(`corpus has ${texts.length} labels, expected 208`)
  return texts.map(({ category, text }, i) => ({
    id: `a3-${String(i).padStart(3, '0')}`,
    category,
    text,
    // 60% Nunito (Lobby's default, family 6), 40% Excalifont (family 5), not aligned with categories
    fontFamily: (i * 7) % 5 < 3 ? 6 : 5,
    baseFontSize: SIZES[(i * 3) % SIZES.length] ?? 20,
    width: WIDTHS[(i * 5) % WIDTHS.length] ?? 200,
  }))
}

/** Every character of the corpus (for the calibration's held-out check). */
export const corpusChars = (): Set<string> => {
  const s = new Set<string>()
  for (const l of buildCorpus()) for (const ch of l.text) s.add(ch)
  return s
}
