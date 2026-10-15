// OWNER: WS1 (wave Q, the icons). The build report on the command line:
//
//   pnpm --filter @draftroom/icon-sets report          the summary the web build logs
//   pnpm --filter @draftroom/icon-sets report --names  and every icon left out, by reason (Brand only counted)
//   pnpm --filter @draftroom/icon-sets report --json   the whole report as JSON (with each refusal's detail)
import { formatReport, generateIcons } from './generate.ts'

const started = Date.now()
const { report } = generateIcons()
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  console.log(formatReport(report, { names: process.argv.includes('--names') }))
  console.log(`generated in ${Date.now() - started} ms`)
}
