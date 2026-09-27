import type { IncomingMessage } from 'node:http'
import { HttpError } from './respond.ts'

// Thrown before the body has been read: close the connection rather than drain what we refused.
const refuse = (status: number, code: string, message: string) =>
  new HttpError(status, code, message, { Connection: 'close' })

/** Reads a JSON request body of at most `limitBytes` (413 above it, also enforced while streaming). */
export async function readJson(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '')
  if (!/^application\/json\s*(;|$)/i.test(type))
    throw refuse(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.')
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limitBytes)
    throw refuse(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limitBytes) throw refuse(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON.')
  }
}
