import {randomUUID} from 'node:crypto';
import {SeoBlogError} from '../seo-blog/types.js';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA=/^[a-f0-9]{64}$/u;
export type PrivateReviewDecision='reviewed_private'|'rejected_private'|'withdrawn_private';
export interface PrivateOutputReview {
 readonly outputId:string;readonly revision:number;readonly sha256:string;
 readonly decision:PrivateReviewDecision|null;readonly reviewedBy:string|null;
 readonly technicalStatus:'verified_technical'|'rejected'|'awaiting_probe';
 readonly durationMs:number|null;readonly width:number|null;readonly height:number|null;
 readonly createdAt:string|null;
}
export interface PrivateReviewInput {
 readonly workspaceId:string;readonly outputId:string;readonly outputSha256:string;
 readonly commandId?:string;readonly expectedRevision:number;
 readonly decision:PrivateReviewDecision;
 /** These are new, specific statements about the exact reviewed output. */
 readonly rightsConfirmed:boolean;readonly claimsConfirmed:boolean;
 readonly disclosureConfirmed:boolean;
}
export function checkedPrivateReview(input:PrivateReviewInput):Readonly<PrivateReviewInput & {commandId:string}> {
 const commandId=input.commandId??randomUUID();
 if(!UUID.test(input.workspaceId)||!UUID.test(input.outputId)||!UUID.test(commandId)
   ||!SHA.test(input.outputSha256)||!Number.isInteger(input.expectedRevision)
   ||input.expectedRevision<0||input.expectedRevision>=100
   ||!['reviewed_private','rejected_private','withdrawn_private'].includes(input.decision)
   ||typeof input.rightsConfirmed!=='boolean'||typeof input.claimsConfirmed!=='boolean'
   ||typeof input.disclosureConfirmed!=='boolean')
   throw new SeoBlogError(400,'Exact video, revision, decision and owner attestations required');
 if(input.decision==='reviewed_private'&&
    !(input.rightsConfirmed&&input.claimsConfirmed&&input.disclosureConfirmed))
   throw new SeoBlogError(409,'Review requires rights, truthful claims and disclosure confirmations');
 return Object.freeze({...input,commandId});
}
