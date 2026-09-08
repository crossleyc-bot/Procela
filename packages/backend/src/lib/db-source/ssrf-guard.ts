// SSRF guard for the direct-connect driver layer.
//
// A direct-connect connection's host is user-supplied (by an EDITOR+ who
// configures the connection), and fetchDbRows opens a real socket to it. That
// lets a configured host point the server at internal infrastructure — most
// dangerously the cloud instance-metadata endpoint (169.254.169.254), which
// hands out IAM credentials to anything that can reach it.
//
// The block list is deliberately narrow so it does NOT break the product's
// real deployments: Procela legitimately connects to databases on loopback
// (local dev, the connector integration tests) and on private ranges (on-prem
// customer databases at 10.x / 192.168.x). So by default we block ONLY the
// link-local range 169.254.0.0/16 (and its IPv6 peers) — where cloud metadata
// lives and where no real database is ever hosted.
//
// Hardened cloud deployments that never connect to an internal database can
// set DB_SOURCE_BLOCK_PRIVATE_HOSTS=1 to additionally refuse loopback and
// RFC-1918 / unique-local private ranges.
//
// Hostnames are resolved and every resolved address is classified, so a name
// that points at a blocked range is caught too. (A determined caller could
// still DNS-rebind after this check; resolving here raises the bar without a
// full connect-time pin, which the drivers don't expose.)

import { isIP } from 'net';
import { lookup } from 'dns/promises';

export type IpClass = 'metadata-link-local' | 'loopback' | 'private' | 'public';

/** Classify an IP literal (v4 or v6) into the buckets the guard cares about.
 *  Pure — no DNS, no sockets — so the range logic unit-tests directly. */
export function classifyIp(ip: string): IpClass {
  const v = isIP(ip);
  if (v === 4) return classifyV4(ip);
  if (v === 6) return classifyV6(ip.toLowerCase());
  // Not an IP literal — caller is responsible for resolving first.
  return 'public';
}

function classifyV4(ip: string): IpClass {
  const p = ip.split('.').map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'public';
  const [a, b] = p;
  if (a === 169 && b === 254) return 'metadata-link-local'; // 169.254.0.0/16 (incl. 169.254.169.254)
  if (a === 127) return 'loopback';                          // 127.0.0.0/8
  if (a === 10) return 'private';                            // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return 'private';     // 172.16.0.0/12
  if (a === 192 && b === 168) return 'private';              // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return 'private';    // 100.64.0.0/10 (CGNAT)
  if (a === 0) return 'loopback';                            // 0.0.0.0/8 (unspecified → local)
  return 'public';
}

function classifyV6(ip: string): IpClass {
  if (ip === '::1' || ip === '::') return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded v4.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return classifyV4(mapped[1]);
  if (ip.startsWith('fe80')) return 'metadata-link-local'; // link-local unicast
  if (ip === 'fd00:ec2::254') return 'metadata-link-local'; // AWS IMDS over IPv6
  if (ip.startsWith('fc') || ip.startsWith('fd')) return 'private'; // unique-local fc00::/7
  return 'public';
}

/** True when private/loopback ranges should also be refused (opt-in hardening
 *  for cloud deployments that never reach an internal database). */
export function blockPrivateHosts(): boolean {
  return process.env.DB_SOURCE_BLOCK_PRIVATE_HOSTS === '1'
    || process.env.DB_SOURCE_BLOCK_PRIVATE_HOSTS === 'true';
}

/** Strip an optional port and IPv6 brackets from a configured host value. */
export function normalizeHost(host: string): string {
  let h = host.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end > 0) return h.slice(1, end); // [::1]:5432 → ::1
  }
  // Only strip a trailing :port for hostnames / IPv4 (an unbracketed IPv6
  // literal contains colons of its own and is left intact).
  if (isIP(h) === 0) {
    const colon = h.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  }
  return h;
}

/**
 * Throw if `host` resolves to a blocked address. Always refuses the cloud
 * metadata / link-local range; also refuses loopback + private ranges when
 * DB_SOURCE_BLOCK_PRIVATE_HOSTS is set. Resolves hostnames so a name pointing
 * at a blocked range is caught.
 */
export async function assertConnectableHost(host: string): Promise<void> {
  const h = normalizeHost(host);
  if (!h) throw new Error('Database source is missing a host');

  const addrs: string[] = isIP(h) !== 0
    ? [h]
    : (await lookup(h, { all: true })).map((a) => a.address);

  // A name that resolves to nothing is left for the driver to fail on.
  for (const addr of addrs) {
    const cls = classifyIp(addr);
    if (cls === 'metadata-link-local') {
      throw new Error(`Refusing to connect to link-local/metadata address (${addr}) for host "${h}".`);
    }
    if ((cls === 'loopback' || cls === 'private') && blockPrivateHosts()) {
      throw new Error(`Refusing to connect to ${cls} address (${addr}) for host "${h}" (DB_SOURCE_BLOCK_PRIVATE_HOSTS is set).`);
    }
  }
}
