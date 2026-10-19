// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): the extract-text op kind on the api (worker/ops-kinds.ts OpKindHandler).
// The worker sends the version's pages in `/text` batches and completes with ExtractTextResult; this kind stores the
// pages (./file-text.ts storeTextPages) and, at complete, the version's file_text_state. It makes no output blobs: every
// `/output` reservation is refused. The op has no requester (the api enqueues it: ./file-backfill.ts), so no `file.op`
// event goes to anyone.

import type { OpKindHandler } from '../../worker/ops-kinds.ts'
import { OpRefused } from '../../worker/ops-kinds.ts'
import { completeFileText, storeTextPages } from './file-text.ts'

export const extractTextKind: OpKindHandler = {
  kind: 'extract-text',
  async checkOutput() {
    throw new OpRefused(400, 'NO_OUTPUTS', 'This op kind makes no files.')
  },
  async acceptText(tx, op, input) {
    await storeTextPages(tx, op, input)
  },
  async complete(tx, op, done) {
    if (done.outputs.length) throw new OpRefused(400, 'NO_OUTPUTS', 'This op kind makes no files.')
    const { result } = await completeFileText(tx, op, done.result, done.now)
    return { result }
  },
}
