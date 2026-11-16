/** Private streaming object backend for the canonical media catalogue.
 * Mount a durable private directory on the worker/server; no public filesystem URL.
 * All object paths derive from workspace/source IDs and a content digest.
 */
import {constants} from 'node:fs';
import {mkdir,lstat,realpath,open,link,unlink,chmod,rm} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {SeoBlogError} from '../seo-blog/types.js';
import {checkedEditId} from './media-edit-plan.js';
export const LARGE_MEDIA_MAX_BYTES=1_073_741_824;
export const LARGE_MEDIA_PART_BYTES=8_388_608;
const SHA=/^[a-f0-9]{64}$/u;
export interface PrivateMediaObject {workspaceId:string;sourceId:string;sha256:string;byteLength:number;mime:'video/mp4'|'video/webm';objectKey:string}
export interface PrivateMediaFile extends PrivateMediaObject {readonly path:string}
function checkedObject(v:PrivateMediaObject):PrivateMediaObject{
 const workspaceId=checkedEditId(v.workspaceId),sourceId=checkedEditId(v.sourceId);
 const ext=v.mime==='video/mp4'?'mp4':v.mime==='video/webm'?'webm':null;
 if(!ext||!SHA.test(v.sha256)||!Number.isSafeInteger(v.byteLength)||v.byteLength<1024||v.byteLength>LARGE_MEDIA_MAX_BYTES||v.objectKey!==`${workspaceId}/${sourceId}/${v.sha256}.${ext}`)throw new SeoBlogError(400,'Exact private media object required');
 return Object.freeze({...v,workspaceId,sourceId});
}
export class PrivateMediaFiles {
 private readonly root:string;
 constructor(root:string){if(!root||!isAbsolute(root)||resolve(root)==='/')throw new SeoBlogError(503,'Private media directory must be configured');this.root=resolve(root);}
 private async dir(...parts:string[]):Promise<string>{
  await mkdir(this.root,{recursive:true,mode:0o700});
  const root=await lstat(this.root);
  if(!root.isDirectory()||root.isSymbolicLink()||(root.mode&0o077)!==0||await realpath(this.root)!==this.root)throw new SeoBlogError(503,'Media root must be a private real directory');
  let path=this.root;
  for(const part of parts){path=join(path,part);await mkdir(path,{mode:0o700}).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new SeoBlogError(409,'Unsafe private media directory');}
  return path;
 }
 private async partReceipt(path:string,sha:string){
  let fd;try{fd=await open(path+'.sha256',constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o400);await fd.writeFile(sha);await fd.sync();}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}finally{await fd?.close();}
 }
 async putPart(workspace:string,uploadId:string,index:number,totalBytes:number,bytes:Buffer):Promise<{sha256:string;replayed:boolean}>{
  const ws=checkedEditId(workspace),id=checkedEditId(uploadId),snapshot=Buffer.from(bytes);
  const expected=Math.min(LARGE_MEDIA_PART_BYTES,totalBytes-index*LARGE_MEDIA_PART_BYTES);
  if(!Number.isSafeInteger(totalBytes)||totalBytes<1024||totalBytes>LARGE_MEDIA_MAX_BYTES||!Number.isInteger(index)||index<0||index>=128||expected<1||snapshot.length!==expected)throw new SeoBlogError(400,'Exact bounded object part required');
  const path=join(await this.dir(ws,'uploads',id),String(index)+'.part');const sha256=createHash('sha256').update(snapshot).digest('hex');
  const temp=path+'.'+randomUUID()+'.tmp';
  try{
   const fd=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   try{await fd.writeFile(snapshot);await fd.sync();}finally{await fd.close();}
   try{await link(temp,path);await this.partReceipt(path,sha256);return{sha256,replayed:false};}
   catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const previous=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const old=await previous.readFile();if(old.length!==snapshot.length||createHash('sha256').update(old).digest('hex')!==sha256)throw new SeoBlogError(409,'Object part replay changed bytes');await this.partReceipt(path,sha256);return{sha256,replayed:true};}finally{await previous.close();}}
  }finally{await unlink(temp).catch(()=>{});}
 }
 async assemble(input:PrivateMediaObject,uploadId:string):Promise<PrivateMediaFile>{
  const v=checkedObject(input),upload=checkedEditId(uploadId),partDir=await this.dir(v.workspaceId,'uploads',upload),outDir=await this.dir(v.workspaceId,v.sourceId);
  const temp=join(outDir,'.assembling-'+randomUUID()),out=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  const digest=createHash('sha256');let count=0,signature=Buffer.alloc(0);
  try{
   for(let index=0;index<Math.ceil(v.byteLength/LARGE_MEDIA_PART_BYTES);index++){
    const fd=await open(join(partDir,index+'.part'),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
     const expected=Math.min(LARGE_MEDIA_PART_BYTES,v.byteLength-index*LARGE_MEDIA_PART_BYTES),info=await fd.stat();
     if(!info.isFile()||info.size!==expected)throw new SeoBlogError(409,'Incomplete object upload');
     const buffer=Buffer.allocUnsafe(1024*1024);let position=0;
     while(position<expected){const read=await fd.read(buffer,0,Math.min(buffer.length,expected-position),position);if(read.bytesRead===0)throw new SeoBlogError(409,'Truncated object part');const chunk=buffer.subarray(0,read.bytesRead);if(count===0)signature=Buffer.from(chunk.subarray(0,32));digest.update(chunk);await out.writeFile(chunk);position+=read.bytesRead;count+=read.bytesRead;}
    }finally{await fd.close();}
   }
   if(count!==v.byteLength||digest.digest('hex')!==v.sha256)throw new SeoBlogError(409,'Complete private object checksum mismatch');
   if(v.mime==='video/mp4'?(signature.toString('ascii',4,8)!=='ftyp'):(signature.subarray(0,4).toString('hex')!=='1a45dfa3'))throw new SeoBlogError(400,'Object container signature rejected');
   await out.sync();await out.close();
   const final=join(outDir,v.sha256+(v.mime==='video/mp4'?'.mp4':'.webm'));
   try{await link(temp,final);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   const verified=await this.verify(v);const locked=await open(final,constants.O_RDONLY|constants.O_NOFOLLOW);try{await locked.chmod(0o400);}finally{await locked.close();}return verified;
  }finally{await out.close().catch(()=>{});await unlink(temp).catch(()=>{});}
 }
 async verify(input:PrivateMediaObject):Promise<PrivateMediaFile>{
  const v=checkedObject(input);await this.dir(v.workspaceId,v.sourceId);const path=join(this.root,v.objectKey),fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=await fd.stat();if(!info.isFile()||info.size!==v.byteLength)throw new SeoBlogError(409,'Private object size changed');const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let position=0;while(position<info.size){const r=await fd.read(buffer,0,Math.min(buffer.length,info.size-position),position);if(!r.bytesRead)throw new SeoBlogError(409,'Private object truncated');hash.update(buffer.subarray(0,r.bytesRead));position+=r.bytesRead;}if(hash.digest('hex')!==v.sha256)throw new SeoBlogError(409,'Private object checksum changed');return Object.freeze({...v,path});}finally{await fd.close();}
 }
 // Immutable files are checksum-verified at assembly/probe/render boundaries.
 // Range serving checks the opened inode and size, without O(file size) hashing.
 async readRange(input:PrivateMediaObject,start:number,end:number){
  const v=checkedObject(input);await this.dir(v.workspaceId,v.sourceId);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>=v.byteLength)throw new SeoBlogError(416,'Invalid private object byte range');
  const fd=await open(join(this.root,v.objectKey),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=await fd.stat();if(!info.isFile()||info.size!==v.byteLength||(info.mode&0o222)!==0)throw new SeoBlogError(409,'Private immutable object changed');return fd.createReadStream({start,end,autoClose:true});}catch(e){await fd.close();throw e;}
 }
 async parts(workspace:string,uploadId:string,totalBytes:number):Promise<Array<{index:number;sha256:string}>>{
  const dir=await this.dir(checkedEditId(workspace),'uploads',checkedEditId(uploadId)),parts:Array<{index:number;sha256:string}>=[];
  if(!Number.isSafeInteger(totalBytes)||totalBytes<1024||totalBytes>LARGE_MEDIA_MAX_BYTES)throw new SeoBlogError(400,'Bounded object size required');
  for(let index=0;index<Math.ceil(totalBytes/LARGE_MEDIA_PART_BYTES);index++){
   let fd;try{fd=await open(join(dir,index+'.part'),constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
   try{const info=await fd.stat();if(!info.isFile()||info.size!==Math.min(LARGE_MEDIA_PART_BYTES,totalBytes-index*LARGE_MEDIA_PART_BYTES))throw new SeoBlogError(409,'Saved object part changed');const receipt=await open(join(dir,index+'.part.sha256'),constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await receipt.stat();if(info.size!==64)throw new SeoBlogError(409,'Part receipt unavailable');const digest=(await receipt.readFile()).toString('ascii');if(!SHA.test(digest))throw new SeoBlogError(409,'Part receipt invalid');parts.push({index,sha256:digest});}finally{await receipt.close();}}finally{await fd.close();}
  }return parts;
 }
 async discardUncommitted(input:PrivateMediaObject):Promise<void>{const v=checkedObject(input);const path=await this.dir(v.workspaceId,v.sourceId);await rm(path,{recursive:true,force:true});}
 async clearParts(workspace:string,uploadId:string):Promise<void>{const path=await this.dir(checkedEditId(workspace),'uploads',checkedEditId(uploadId));await rm(path,{recursive:true,force:true});}
}
