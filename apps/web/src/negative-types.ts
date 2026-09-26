// Compile-time assertions (tsc fails if any @ts-expect-error is unused).
import type { UseSyncOptions } from '@tldraw/sync'
import type { Editor, TLAssetStore } from 'tldraw'

declare const editor: Editor
declare const assets: TLAssetStore
// @ts-expect-error userInfo was removed in 5.x (use `users: TLUserStore`)
const o: UseSyncOptions = { uri: 'ws://x', assets, userInfo: { id: 'a' } }
void o
// @ts-expect-error unknown prop on the custom shape
editor.createShape({ type: 'dr-file-card', props: { nmae: 'x' } })
// @ts-expect-error bad enum value
editor.createShape({ type: 'dr-file-card', props: { kind: 'docx' } })
// @ts-expect-error unknown shape type
editor.createShape({ type: 'not-a-shape' })
editor.createShape({ type: 'dr-file-card', props: { name: 'ok', kind: 'pdf' } })
