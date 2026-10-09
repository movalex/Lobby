// The words of the sort feature that more than one file uses.

/** `3 notes`, `1 note`: the count and the noun. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
