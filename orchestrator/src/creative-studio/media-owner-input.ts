/** Digest uploaded evidence on the server; owners never type content hashes. */
import {createHash} from 'node:crypto';
import {SeoBlogError} from '../seo-blog/types.js';
export function mediaEvidenceDigest(bytes:Buffer|null,required:boolean):string|null{
 if(bytes===null){if(required)throw new SeoBlogError(400,'Upload the supporting licence or programme document');return null;}
 if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>5_000_000)throw new SeoBlogError(400,'Evidence document must be below 5 MB');
 return createHash('sha256').update(bytes).digest('hex');
}
