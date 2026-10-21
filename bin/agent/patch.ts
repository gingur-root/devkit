/** Git quotes control characters and encodes non-ASCII bytes as octal escapes. */
export function patchPath(name: string): string {
  if (!name.startsWith('"')) return name;
  const escapes: Record<string, string> = {
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
  };
  return Buffer.concat(
    [...name.slice(1, -1).matchAll(/\\([0-7]{3}|.)|([^\\]+)/g)].map(([, escaped, plain]) => {
      if (plain !== undefined) return Buffer.from(plain);
      return /^[0-7]{3}$/.test(escaped!)
        ? Buffer.from([Number.parseInt(escaped!, 8)])
        : Buffer.from(escapes[escaped!] ?? escaped!);
    }),
  ).toString('utf8');
}
