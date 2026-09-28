// One LibreOffice conversion (Office document → PDF) in a separate process, the way docs/WAVE4-CONTRACTS.md
// asks for it:
//   - its own, freshly made user profile per job (-env:UserInstallation), with macros disabled, linked
//     files from untrusted documents blocked and document locking off (HARDENING_XCU), plus HOME and
//     TMPDIR inside the job's scratch directory, which is removed afterwards;
//   - a minimal environment (no worker token, no credentials);
//   - the import filter forced to the format the content was sniffed as, so a file is never handed to
//     another importer because of what it claims to be;
//   - a hard timeout that kills the whole process tree (soffice → oosplash → soffice.bin);
//   - the output re-checked: one regular file where we asked for it, starting with %PDF-, within the size cap.
// No network and the memory cap come from where it runs: the office sidecar container has no network
// and its own memory limit (deploy/nas/worker/docker-compose.yml). Run directly by the worker, this is
// the development mode (office.ts refuses it when NODE_ENV=production).
import { copyFile, lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OfficeExt } from '@draftroom/dev-assets'
import { AbortedError, PreviewError } from './errors.ts'
import { run, stderrTail } from './run.ts'

/** The LibreOffice import filter for each format (filter/source/config/fragments/filters in LibreOffice). */
export const IMPORT_FILTERS: Record<OfficeExt, string> = {
  docx: 'MS Word 2007 XML',
  pptx: 'Impress MS PowerPoint 2007 XML',
  xlsx: 'Calc MS Excel 2007 XML',
  odt: 'writer8',
  odp: 'impress8',
  ods: 'calc8',
}

/**
 * The job profile's registrymodifications.xcu (paths checked against LibreOffice 25.2's registry schema).
 * Macros: security level "very high" (3) with no trusted locations, and macro execution disabled
 * outright. Untrusted documents may not pull in linked files: on the NAS a picture linked to a local
 * file was rendered into the preview with a default profile and was not with this one. No lock files, no
 * first-start work. (Writer/Calc "update links when loading" is left alone: linked sections and sheets
 * pointing at local files were not loaded during a headless conversion under any value, and the two
 * schemas number "never" differently, so a guessed value could only make things worse.)
 */
export const HARDENING_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="UseLocking" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
`

export interface SofficeOptions {
  /** argv prefix: ['soffice'], ['/usr/lib/libreoffice/program/soffice'], or a test stand-in. */
  command: readonly string[]
  /** Parent of the per-job scratch directory (profile, HOME, TMPDIR). */
  workRoot: string
  timeoutMs: number
  /** The converted PDF may not be larger than this. */
  maxOutputBytes: number
  signal?: AbortSignal
}

/** The converted PDF's path: `<outDir>/<input name without extension>.pdf`. */
export const outputPdfPath = (input: string, outDir: string) =>
  join(outDir, `${basename(input, extname(input))}.pdf`)

/** Environment of the soffice process: nothing from the worker's own environment but PATH (and SYSTEMROOT on Windows). */
export function sofficeEnv(scratch: string): NodeJS.ProcessEnv {
  const home = join(scratch, 'home')
  const tmp = join(scratch, 'tmp')
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    // Headless rendering without any display server; no OpenCL probing.
    SAL_USE_VCLPLUGIN: 'svp',
    SAL_DISABLE_OPENCL: '1',
  }
  if (process.platform === 'win32') {
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT
    env.USERPROFILE = home
  } else {
    env.LANG = 'C.UTF-8'
  }
  return env
}

async function startsWithPdf(path: string): Promise<boolean> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(1024)
    const { bytesRead } = await fh.read(buf, 0, 1024, 0)
    return buf.subarray(0, bytesRead).includes('%PDF-', 0, 'latin1')
  } finally {
    await fh.close()
  }
}

/**
 * Converts `input` (sniffed as `ext`) to PDF in `outDir` and returns the PDF's path. Throws PreviewError
 * (TIMEOUT, OFFICE_INVALID, OFFICE_UNAVAILABLE, FILE_TOO_LARGE) or AbortedError.
 */
export async function convertWithSoffice(
  input: string,
  ext: OfficeExt,
  outDir: string,
  o: SofficeOptions,
): Promise<string> {
  const [cmd, ...prefix] = o.command
  if (!cmd) throw new PreviewError('OFFICE_UNAVAILABLE', 'no soffice command configured')
  const scratch = await mkdtemp(join(o.workRoot, 'lo-'))
  try {
    const profile = join(scratch, 'profile')
    await mkdir(join(profile, 'user'), { recursive: true })
    await mkdir(join(scratch, 'home'))
    await mkdir(join(scratch, 'tmp'))
    await writeFile(join(profile, 'user', 'registrymodifications.xcu'), HARDENING_XCU)
    // LibreOffice names its output after the input; give it a fixed name with the right extension
    // (the worker's original has neither) unless the caller already did.
    let src = input
    if (basename(input) !== `document.${ext}`) {
      src = join(scratch, `document.${ext}`)
      await copyFile(input, src)
    }
    const pdf = outputPdfPath(src, outDir)
    const r = await run(
      cmd,
      [
        ...prefix,
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless',
        '--invisible',
        '--nodefault',
        '--nolockcheck',
        '--nologo',
        '--norestore',
        `--infilter=${IMPORT_FILTERS[ext]}`,
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        src,
      ],
      {
        timeoutMs: o.timeoutMs,
        maxStdoutBytes: 64 * 1024,
        signal: o.signal,
        env: sofficeEnv(scratch),
        cwd: scratch,
        killTree: true,
      },
    )
    if (r.aborted) throw new AbortedError()
    if (r.timedOut) throw new PreviewError('TIMEOUT', `soffice killed after ${r.ms} ms`)
    if (r.spawnError) {
      throw new PreviewError(
        'OFFICE_UNAVAILABLE',
        `soffice could not start (${r.spawnError}); check SOFFICE_PATH`,
      )
    }
    // A signal we did not send is almost always the memory cap (OOM killer): the document is too big.
    if (r.code !== 0 || r.signal) {
      throw new PreviewError(
        'OFFICE_INVALID',
        `soffice exit code=${r.code} signal=${r.signal} ${stderrTail(r.stderr)}`.trim(),
      )
    }
    let st: Awaited<ReturnType<typeof lstat>>
    try {
      st = await lstat(pdf)
    } catch {
      // soffice exits 0 without output when it cannot load the file ("source file could not be loaded").
      throw new PreviewError('OFFICE_INVALID', `no output ${stderrTail(r.stderr)}`.trim())
    }
    if (!st.isFile()) throw new PreviewError('OFFICE_INVALID', 'output is not a regular file')
    if (st.size > o.maxOutputBytes)
      throw new PreviewError('FILE_TOO_LARGE', `converted PDF has ${st.size} bytes`)
    if (st.size === 0 || !(await startsWithPdf(pdf)))
      throw new PreviewError('OFFICE_INVALID', 'output is not a PDF')
    return pdf
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
  }
}
