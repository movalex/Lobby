// Reports what the PDF child was started with: its node flags (the heap cap) and any environment
// variable that looks like a credential (there must be none). Answers as a failed render so the report
// travels in the response's `name` (logged by processJob as the PDF_INVALID detail).
let input = ''
for await (const c of process.stdin) input += String(c)
JSON.parse(input)
const leaked = Object.keys(process.env).filter((k) => /TOKEN|SECRET|DRAFTROOM|R2_|DATABASE/i.test(k))
const name = `execArgv=[${process.execArgv.join(' ')}] env=[${leaked.join(',')}]`
process.stdout.write(JSON.stringify({ ok: false, reason: 'invalid', name }), () => process.exit(0))
