export class FlowWorkspaceError extends Error { constructor(readonly status: number, message: string) { super(message); this.name = 'FlowWorkspaceError'; } }
export interface FlowBrandSnapshot { readonly canonical: string; readonly sha256: string; readonly ref: string; readonly productName: string; readonly primaryColor: string | null; readonly accentColor: string | null }
