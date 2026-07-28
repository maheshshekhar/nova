// Parse a Kubernetes resource quantity (memory) into bytes. Supports binary
// suffixes (Ki, Mi, Gi, Ti, Pi), decimal SI suffixes (k, M, G, T, P) and plain
// byte counts. Returns null for unparseable input. Pure.

const BINARY: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
}

const DECIMAL: Record<string, number> = {
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
}

export function parseQuantity(value: string | number | undefined | null): number | null {
  if (value == null) return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  const s = value.trim()
  if (s === "") return null

  // Binary suffix (Ki/Mi/…).
  const bin = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi)$/.exec(s)
  if (bin) return Math.round(parseFloat(bin[1]) * BINARY[bin[2]])

  // Decimal suffix (k/M/G/…), optionally with a trailing "i"-less form.
  const dec = /^(\d+(?:\.\d+)?)(k|M|G|T|P)$/.exec(s)
  if (dec) return Math.round(parseFloat(dec[1]) * DECIMAL[dec[2]])

  // Plain number (bytes) or scientific/decimal.
  const plain = /^(\d+(?:\.\d+)?(?:e\d+)?)$/i.exec(s)
  if (plain) return Math.round(parseFloat(plain[1]))

  return null
}
