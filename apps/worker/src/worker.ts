// Placeholder until the preview worker lands (milestone 0, apps/worker owner).
import { dataLayout, ensureLayout, resolveDataDir } from '@draftroom/dev-assets'

const layout = ensureLayout(dataLayout(resolveDataDir()))
console.log(`worker idle (data: ${layout.root})`)
setInterval(() => {}, 1 << 30)
