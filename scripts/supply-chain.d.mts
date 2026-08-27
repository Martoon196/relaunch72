export interface SupplyChainVerification {
  packageCount: number;
  externalPackageCount: number;
  declaredInstallScripts: string[];
  canonicalLockSha256: string;
}

export const SUPPLY_CHAIN_POLICY_VERSION: number;
export const TRUSTED_REGISTRY_ORIGIN: string;
export const DECLARED_INSTALL_SCRIPT_ALLOWLIST: ReadonlySet<string>;
export function canonicalJson(value: unknown): string;
export function verifyPackageManifest(value: unknown, label: string): void;
export function verifyPackageLock(value: unknown): SupplyChainVerification;
export function buildCycloneDxSbom(value: unknown): Record<string, unknown>;
export function renderCycloneDxSbom(value: unknown): string;
export function runSupplyChainCommand(mode: '--check' | '--write'): Promise<void>;
