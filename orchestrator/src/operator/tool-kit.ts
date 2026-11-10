/** Shared argument readers and the tool shape for the operator's MCP tools. */
import type { OperatorBrand } from './config.js';
import type { McpToolDefinition } from './mcp.js';

export type ToolArgs = Record<string, unknown>;

export interface OperatorTool extends McpToolDefinition {
  /** Write tools are offered only when R72_OPERATOR_WRITES=enabled. */
  readonly write: boolean;
  run(args: ToolArgs): Promise<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const BRAND_SCHEMA = { type: 'string', enum: ['pp', 'mhp'], description: 'pp = Property Predator (Growth HQ), mhp = Martin Howard Property marketing workspace' } as const;
export const ID_SCHEMA = { type: 'string', description: 'UUID' } as const;

export function str(args: ToolArgs, key: string, max = 2000, required = false): string {
  const v = args[key];
  if (v === undefined || v === null) { if (required) throw new Error(`${key} is required.`); return ''; }
  if (typeof v !== 'string') throw new Error(`${key} must be text.`);
  const out = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (required && !out) throw new Error(`${key} is required.`);
  return out.slice(0, max);
}

export function id(args: ToolArgs, key: string): string {
  const v = str(args, key, 64, true);
  if (!UUID.test(v)) throw new Error(`${key} must be a UUID.`);
  return v.toLowerCase();
}

export function optionalId(args: ToolArgs, key: string): string {
  return args[key] === undefined || args[key] === null || args[key] === '' ? '' : id(args, key);
}

export function int(args: ToolArgs, key: string, min: number, max: number, fallback: number): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`${key} must be a whole number between ${min} and ${max}.`);
  return v;
}

export function brand(args: ToolArgs): OperatorBrand {
  const v = args.brand;
  if (v !== 'pp' && v !== 'mhp') throw new Error('brand must be "pp" or "mhp".');
  return v;
}

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
