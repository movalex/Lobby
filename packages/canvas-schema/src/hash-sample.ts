/**
 * The sample board of the hash check (spike B contracts step C0): live elements and tombstones, with
 * non-ASCII text, fractional numbers, an image with a local status and nested arrays, so the Node and
 * browser digests are compared on the cases that could differ. Used by hash.test.ts (Node) and
 * e2e/spike-b/contracts/hash-browser.spec.ts (Chromium). No imports.
 */
export const HASH_SAMPLE: readonly Readonly<Record<string, unknown>>[] = [
  {
    id: 'note-1',
    type: 'stickynote',
    x: 10.25,
    y: -40.5,
    width: 200,
    height: 212.7,
    angle: 0.2617993877991494,
    baseHeight: 200,
    index: 'a1',
    version: 7,
    versionNonce: 1_234_567,
    isDeleted: false,
    boundElements: [{ id: 'note-1.t', type: 'text' }],
    groupIds: [],
    frameId: 'frame-1',
    created: null,
    updated: 1_790_000_000_123,
    customData: { lobby: { 'plusOne:usr_0123456789': true, 'tag:idées': { name: 'idées', color: 'green' } } },
  },
  {
    id: 'note-1.t',
    type: 'text',
    text: 'Grüße, 世界 🙂\nzweite Zeile',
    originalText: 'Grüße, 世界 🙂 zweite Zeile',
    containerId: 'note-1',
    fontFamily: 6,
    fontSize: 18.5,
    index: 'a1V',
    version: 12,
    isDeleted: false,
  },
  {
    id: 'arrow-1',
    type: 'arrow',
    x: 205.01,
    y: 50,
    angle: 0,
    points: [
      [0, 0],
      [150.33, 49.97],
      [300, 299.99],
    ],
    startBinding: { elementId: 'note-1', fixedPoint: [1, 0.5], mode: 'orbit' },
    endBinding: null,
    elbowed: false,
    index: 'a2',
    version: 4,
    isDeleted: false,
  },
  {
    id: 'image-1',
    type: 'image',
    fileId: 'ver_0123456789abcdef',
    status: 'saved',
    scale: [1, -1],
    crop: null,
    index: 'a3',
    version: 2,
    isDeleted: false,
  },
  { id: 'frame-1', type: 'frame', name: 'Retro — Q3', index: 'a0', version: 3, isDeleted: false },
  { id: 'gone-1', type: 'rectangle', x: 1e-7, y: 123456.789, index: 'Zz', version: 9, isDeleted: true },
  {
    id: 'gone-2.t',
    type: 'text',
    text: 'deleted',
    originalText: 'deleted',
    containerId: null,
    version: 5,
    isDeleted: true,
  },
]

/**
 * The lowercase hex SHA-256 of `HASH_SAMPLE` (pinned; both runtimes must give it). CONTRACTS_REV 7: the
 * two tombstones are hashed by their TOMBSTONE_KEYS only (W5-02).
 */
export const HASH_SAMPLE_DIGEST = '526c966eac705939be6ef9bc9c730e240aa5f6103e27e7a3ff7b13fb12fee85c'
