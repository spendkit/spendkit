import { isIP } from "node:net";

/** Expands an IPv6 address into its eight 16-bit groups, or undefined if it is not a valid IPv6 literal. */
function ipv6Groups(ip: string): number[] | undefined {
  let v = ip.toLowerCase().split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) {
    const o = dotted[1]!.split(".").map(Number);
    if (o.length !== 4 || o.some((n) => !(n >= 0 && n <= 255))) return undefined;
    v = v.slice(0, -dotted[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = v.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : undefined;
}

/**
 * True for anything that is not an ordinary public unicast address. IPv6 forms that wrap an IPv4 address
 * (mapped, NAT64, 6to4, compatible) are unwrapped and judged by the IPv4 rules, or rejected outright.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const g = isIP(ip) === 6 ? ipv6Groups(ip) : undefined;
  if (!g) return true; // not an address we can reason about
  const v4 = (hi: number, lo: number) => isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return v4(g[6]!, g[7]!); // mapped, compatible, ::, ::1
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!); // 6to4
  if (g[0] === 0) return true; // ::/16 remainder
  const top = g[0]! & 0xffc0;
  return (g[0]! & 0xfe00) === 0xfc00 || top === 0xfe80 || top === 0xfec0 || (g[0]! & 0xff00) === 0xff00 || (g[0]! === 0x2001 && g[1]! === 0xdb8);
}
