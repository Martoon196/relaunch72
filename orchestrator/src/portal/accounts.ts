/**
 * Portal accounts — the login table (email → tenant + hashed password). Persisted
 * to JSON now, swappable to a real DB later behind the same interface. Passwords
 * are stored only as a SHA-256 hash and compared in constant time. Separate from
 * the CRM store so credentials and business data have distinct lifecycles.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

export interface Account {
  email: string;
  tenantId: string;
  passHash: string;
}

export interface AccountStore {
  create(email: string, tenantId: string, password: string): Promise<Account>;
  /** Return the tenant id iff the password matches, else null. */
  verify(email: string, password: string): Promise<string | null>;
  has(email: string): Promise<boolean>;
  findByEmail(email: string): Promise<Account | null>;
}

function hash(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export class JsonAccountStore implements AccountStore {
  private accounts: Account[] = [];

  /** Omit `file` for an in-memory store (tests). */
  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      try { this.accounts = JSON.parse(fs.readFileSync(file, 'utf8')) as Account[]; } catch { this.accounts = []; }
    }
  }

  private persist(): void {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.accounts, null, 2), 'utf8');
  }

  async findByEmail(email: string): Promise<Account | null> {
    const e = email.trim().toLowerCase();
    return this.accounts.find((a) => a.email === e) ?? null;
  }

  async has(email: string): Promise<boolean> {
    return (await this.findByEmail(email)) !== null;
  }

  async create(email: string, tenantId: string, password: string): Promise<Account> {
    const e = email.trim().toLowerCase();
    const existing = this.accounts.find((a) => a.email === e);
    if (existing) { existing.tenantId = tenantId; existing.passHash = hash(password); this.persist(); return existing; }
    const account: Account = { email: e, tenantId, passHash: hash(password) };
    this.accounts.push(account);
    this.persist();
    return account;
  }

  async verify(email: string, password: string): Promise<string | null> {
    const account = await this.findByEmail(email);
    if (!account) return null;
    const a = Buffer.from(hash(password));
    const b = Buffer.from(account.passHash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return account.tenantId;
  }
}
