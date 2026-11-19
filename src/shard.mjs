// Vaste verdeling van URL's over N jobs (FNV-1a hash), zodat elke URL altijd in hetzelfde deel valt.
export function shardOf(s, n) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % n;
}
