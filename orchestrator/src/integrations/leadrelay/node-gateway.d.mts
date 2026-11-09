import type { IncomingMessage, ServerResponse } from 'node:http';
export const ALL_ACTIONS: readonly string[];
export interface Installation { id: string; label: string; origin: string; key: string }
export function loadInstallations(raw?: string, env?: NodeJS.ProcessEnv): Map<string, Installation>;
export function createNodeHandler(options: {
  installations: Map<string, Installation>;
  apiBase: string;
  authenticate(req: IncomingMessage): Promise<{userId: string; workspaceId: string} | null>;
  authorize(identity: {userId: string; workspaceId: string}, installationId: string): Promise<string[]>;
  verifyCsrf(identity: unknown, req: IncomingMessage): Promise<boolean>;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
