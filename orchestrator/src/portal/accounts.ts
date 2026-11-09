/**
 * Portal accounts — the login table (email → tenant + password credential).
 * Persisted to JSON for now, swappable to a real DB behind the same interface.
 *
 * New passwords use a versioned, salted scrypt encoding. The verifier still
 * accepts the original unsalted SHA-256 rows and upgrades them after the next
 * successful login, so existing customers are not locked out during migration.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const SCRYPT_VERSION = 'v1';
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const LEGACY_SHA256 = /^[a-f0-9]{64}$/i;
// Fixed non-credential work factor used when an account/hash is absent or
// malformed, so login timing does not become a cheap email-enumeration oracle.
const DUMMY_SCRYPT_HASH = 'scrypt$v1$16384,8,1$cmVsYXVuY2g3Mi1kdW1teSE$Y7Oitgu565adLUmSlFbA8WqgV7OGWtnQkb689EpLUts';

/**
 * All portal password hashing and verification crosses this process-wide
 * boundary. Node's default worker pool has four threads, so admitting more
 * simultaneous scrypt jobs only grows memory pressure and an implicit queue.
 * Extra work fails closed instead of retaining an unbounded waiter list.
 */
export class PortalScryptCapacityError extends Error {
  readonly code = 'PORTAL_SCRYPT_CAPACITY';

  constructor() {
    super('Portal password work is temporarily at capacity');
    this.name = 'PortalScryptCapacityError';
  }
}

export interface PortalScryptWorkLimiter {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export class PortalScryptLimiter implements PortalScryptWorkLimiter {
  private active = 0;

  constructor(private readonly maxConcurrent = 4) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64) {
      throw new Error('Portal scrypt concurrency must be an integer between 1 and 64');
    }
  }

  get inFlight(): number {
    return this.active;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) throw new PortalScryptCapacityError();
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
    }
  }
}

const PROCESS_WIDE_PORTAL_SCRYPT_LIMITER = new PortalScryptLimiter();

export interface Account {
  email: string;
  tenantId: string;
  /** Empty only while a new account is waiting for its one-time setup link. */
  passHash: string;
  /** SHA-256 is appropriate here because setup tokens contain 256 random bits. */
  setupTokenHash?: string;
  setupExpiresAt?: string;
}

export interface AccountStore {
  create(email: string, tenantId: string, password: string): Promise<Account>;
  /** Create a passwordless account waiting for a one-use setup token. */
  createPending(email: string, tenantId: string, setupToken: string, expiresAt: string): Promise<Account>;
  /** Consume a valid setup token, set the chosen password and return its tenant. */
  completeSetup(setupToken: string, password: string, now?: number): Promise<string | null>;
  /** Remove only the still-pending account matching this exact setup token. */
  discardPending(email: string, setupToken: string): Promise<boolean>;
  /** Return the tenant id iff the password matches, else null. */
  verify(email: string, password: string): Promise<string | null>;
  has(email: string): Promise<boolean>;
  findByEmail(email: string): Promise<Account | null>;
  /** The account owning a tenant (to resolve a tenant's email for billing). */
  findByTenant(tenantId: string): Promise<Account | null>;
}

function legacyHash(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function setupTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function deriveScrypt(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  limiter: PortalScryptWorkLimiter,
): Promise<Buffer> {
  return limiter.run(() => new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, { N: n, r, p, maxmem: SCRYPT_MAXMEM }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  }));
}

/** Versioned format: scrypt$v1$N,r,p$base64url(salt)$base64url(key). */
export async function hashPassword(
  password: string,
  limiter: PortalScryptWorkLimiter = PROCESS_WIDE_PORTAL_SCRYPT_LIMITER,
): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await deriveScrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, limiter);
  return `scrypt$${SCRYPT_VERSION}$${SCRYPT_N},${SCRYPT_R},${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

interface ParsedScryptCredential {
  salt: Buffer;
  expected: Buffer;
  n: number;
  r: number;
  p: number;
}

function parseScryptCredential(encoded: string): ParsedScryptCredential | null {
  const parts = encoded.split('$');
  if (parts.length !== 5 || parts[0] !== 'scrypt' || parts[1] !== SCRYPT_VERSION) return null;
  const params = parts[2]!.split(',').map(Number);
  if (params.length !== 3) return null;
  const [n, r, p] = params;
  // Bound parameters before feeding persisted data into scrypt. This prevents a
  // corrupted or edited JSON row from causing unbounded CPU/memory work.
  if (!n || !r || !p || n < 16_384 || n > 262_144 || (n & (n - 1)) !== 0 || r > 32 || p > 8) return null;
  const salt = Buffer.from(parts[3]!, 'base64url');
  const expected = Buffer.from(parts[4]!, 'base64url');
  if (salt.length < 16 || expected.length !== SCRYPT_KEY_LENGTH) return null;
  return { salt, expected, n, r, p };
}

async function passwordMatches(
  encoded: string,
  password: string,
  limiter: PortalScryptWorkLimiter,
): Promise<boolean> {
  const parsed = parseScryptCredential(encoded);
  if (!parsed) {
    // A corrupt scrypt-shaped row must cost the same bounded dummy work as an
    // absent account; otherwise storage corruption becomes an email oracle.
    if (encoded === DUMMY_SCRYPT_HASH) return false;
    return passwordMatches(DUMMY_SCRYPT_HASH, password, limiter);
  }
  try {
    const actual = await deriveScrypt(password, parsed.salt, parsed.n, parsed.r, parsed.p, limiter);
    return crypto.timingSafeEqual(actual, parsed.expected);
  } catch (error) {
    // Capacity has the same public response for present and absent accounts,
    // but must reach the router so its throttle reservation is released rather
    // than being recorded as a bad password.
    if (error instanceof PortalScryptCapacityError) throw error;
    return false;
  }
}

export interface StoredPasswordVerification {
  matches: boolean;
  /** True only for a matching original unsalted SHA-256 credential. */
  needsUpgrade: boolean;
}

/** Verify either the current scrypt format or the one-time legacy import format. */
export async function verifyStoredPassword(
  encoded: string | null | undefined,
  password: string,
  limiter: PortalScryptWorkLimiter = PROCESS_WIDE_PORTAL_SCRYPT_LIMITER,
): Promise<StoredPasswordVerification> {
  if (encoded?.startsWith('scrypt$')) {
    return { matches: await passwordMatches(encoded, password, limiter), needsUpgrade: false };
  }
  if (encoded && LEGACY_SHA256.test(encoded)) {
    const matches = Boolean(password) && safeEqualHex(legacyHash(password), encoded);
    // Legacy SHA-256 comparison is intentionally followed by the same bounded
    // scrypt work used for an absent account. Imported accounts must not be a
    // cheap timing oracle (or a cheap remote password-guess path) before their
    // first successful compare-and-swap upgrade.
    await passwordMatches(DUMMY_SCRYPT_HASH, password || '', limiter);
    return { matches, needsUpgrade: matches };
  }
  await passwordMatches(DUMMY_SCRYPT_HASH, password || '', limiter);
  return { matches: false, needsUpgrade: false };
}

export class JsonAccountStore implements AccountStore {
  private accounts: Account[] = [];
  /** In-process claim prevents two submissions consuming one setup token. */
  private readonly setupClaims = new Set<string>();

  /** Omit `file` for an in-memory store (tests). */
  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
        if (!Array.isArray(parsed) || !parsed.every((row) => {
          if (!row || typeof row !== 'object') return false;
          const account = row as Partial<Account>;
          return typeof account.email === 'string' && typeof account.tenantId === 'string' && typeof account.passHash === 'string';
        })) throw new Error('expected an array of account records');
        this.accounts = parsed as Account[];
      } catch (error) {
        throw new Error(`refusing to load corrupt portal account store ${file}: ${(error as Error).message}`);
      }
    }
  }

  private persist(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.accounts, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* best effort cleanup of this exact temp file */ }
      throw error;
    }
  }

  async findByEmail(email: string): Promise<Account | null> {
    const e = email.trim().toLowerCase();
    return this.accounts.find((a) => a.email === e) ?? null;
  }

  async findByTenant(tenantId: string): Promise<Account | null> {
    return this.accounts.find((a) => a.tenantId === tenantId) ?? null;
  }

  async has(email: string): Promise<boolean> {
    return (await this.findByEmail(email)) !== null;
  }

  async create(email: string, tenantId: string, password: string): Promise<Account> {
    const e = email.trim().toLowerCase();
    const passHash = await hashPassword(password);
    const existing = this.accounts.find((a) => a.email === e);
    if (existing) {
      existing.tenantId = tenantId;
      existing.passHash = passHash;
      delete existing.setupTokenHash;
      delete existing.setupExpiresAt;
      this.persist();
      return existing;
    }
    const account: Account = { email: e, tenantId, passHash };
    this.accounts.push(account);
    this.persist();
    return account;
  }

  async createPending(email: string, tenantId: string, setupToken: string, expiresAt: string): Promise<Account> {
    const e = email.trim().toLowerCase();
    if (!setupToken || !Number.isFinite(Date.parse(expiresAt))) throw new Error('invalid account setup token or expiry');
    const existing = this.accounts.find((a) => a.email === e);
    if (existing) {
      // Never turn an established account back into a pending one. A separate,
      // authenticated password-reset flow should own that lifecycle later.
      if (existing.passHash) return existing;
      existing.tenantId = tenantId;
      existing.setupTokenHash = setupTokenHash(setupToken);
      existing.setupExpiresAt = expiresAt;
      this.persist();
      return existing;
    }
    const account: Account = {
      email: e,
      tenantId,
      passHash: '',
      setupTokenHash: setupTokenHash(setupToken),
      setupExpiresAt: expiresAt,
    };
    this.accounts.push(account);
    this.persist();
    return account;
  }

  async completeSetup(setupToken: string, password: string, now = Date.now()): Promise<string | null> {
    if (!setupToken || password.length < 12 || password.length > 1_024) return null;
    const candidate = setupTokenHash(setupToken);
    if (this.setupClaims.has(candidate)) return null;
    const account = this.accounts.find((item) => item.setupTokenHash && safeEqualHex(candidate, item.setupTokenHash));
    if (!account?.setupExpiresAt) return null;
    const expiresAt = Date.parse(account.setupExpiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
    this.setupClaims.add(candidate);
    try {
      // Claim is taken before the asynchronous hash begins, so another request
      // in this process cannot race in and make the last submitted password win.
      account.passHash = await hashPassword(password);
      delete account.setupTokenHash;
      delete account.setupExpiresAt;
      this.persist();
      return account.tenantId;
    } finally {
      this.setupClaims.delete(candidate);
    }
  }

  async discardPending(email: string, setupToken: string): Promise<boolean> {
    const normalized = email.trim().toLowerCase();
    const candidate = setupTokenHash(setupToken);
    const index = this.accounts.findIndex((account) => account.email === normalized
      && !account.passHash
      && Boolean(account.setupTokenHash)
      && safeEqualHex(candidate, account.setupTokenHash!));
    if (index < 0) return false;
    this.accounts.splice(index, 1);
    this.persist();
    return true;
  }

  async verify(email: string, password: string): Promise<string | null> {
    const account = await this.findByEmail(email);
    const verified = await verifyStoredPassword(account?.passHash, password);
    if (!account || !verified.matches) return null;
    if (verified.needsUpgrade) {
      account.passHash = await hashPassword(password);
      this.persist();
    }
    return account.tenantId;
  }
}
