import { domainToASCII } from 'node:url';

const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[a-z2-7]{52}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function canonicalDomain(value: string): string {
  const ascii = domainToASCII(value.trim()).toLowerCase();
  if (!ascii || ascii.length > 253
      || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/u.test(ascii)
      || ascii.split('.').length < 2
      || ascii.split('.').some((label) => label.length < 1 || label.length > 63)) {
    throw new Error('Mailgun reply domain is invalid');
  }
  return ascii;
}

/** RFC 4648 base32 without padding, emitted lowercase for mailbox stability. */
export function propertyPredatorMailgunReplyToken(sha256: string): string {
  if (!SHA256.test(sha256)) {
    throw new Error('Mailgun reply correlation must be a canonical SHA-256 digest');
  }
  const source = Buffer.from(sha256, 'hex');
  let accumulator = 0;
  let bits = 0;
  let token = '';
  for (const byte of source) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      token += BASE32[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) token += BASE32[(accumulator << (5 - bits)) & 31];
  if (!TOKEN.test(token)) throw new Error('Mailgun reply correlation encoding failed');
  return token;
}

/** Decode the full 256-bit correlation; truncated aliases are never accepted. */
export function propertyPredatorMailgunReplyDigest(token: string): string {
  if (!TOKEN.test(token)) throw new Error('Mailgun reply correlation token is invalid');
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of token) {
    const value = BASE32.indexOf(character);
    accumulator = (accumulator << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bytes.length !== 32 || bits !== 4 || accumulator !== 0) {
    throw new Error('Mailgun reply correlation token is non-canonical');
  }
  return Buffer.from(bytes).toString('hex');
}

export function propertyPredatorMailgunReplyAddress(
  sha256: string,
  domain: string,
): string {
  const address = `reply+${propertyPredatorMailgunReplyToken(sha256)}@${canonicalDomain(domain)}`;
  const localPart = address.slice(0, address.indexOf('@'));
  if (Buffer.byteLength(localPart, 'ascii') > 64) {
    throw new Error('Mailgun reply local part exceeds the SMTP limit');
  }
  return address;
}
