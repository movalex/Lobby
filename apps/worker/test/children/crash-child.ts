// Stand-in for a PDF child that dies without answering (native abort, OOM): exit code only.
process.stderr.write('simulated native abort at C:\\secret\\path\\file.pdf\n')
process.exit(3)
