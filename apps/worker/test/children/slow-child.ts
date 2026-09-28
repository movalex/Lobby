// Stand-in for a slow but healthy PDF render: waits 3 s (longer than the test's whole lease), then runs
// the real renderer on the same request (still buffered on stdin).
await new Promise((r) => setTimeout(r, 3_000))
await import('../../src/pdf-child.ts')
