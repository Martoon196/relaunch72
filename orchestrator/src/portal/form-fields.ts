/** Shared native form fields, extracted from the existing investor form builder. */
import { escapeHtml as e } from './ui.js';
export const hidden=(name:string,value:unknown):string=>`<input type="hidden" name="${e(name)}" value="${e(value)}">`;
export interface FieldOptions {required?:boolean;min?:number;max?:number;step?:number;placeholder?:string}
export function field(label:string,name:string,value='',type='text',maximum=200,options:FieldOptions={}):string {
 const attrs=(options.required?' required':'')+(options.min!==undefined?` min="${e(options.min)}"`:'')+(options.max!==undefined?` max="${e(options.max)}"`:'')+(options.step!==undefined?` step="${e(options.step)}"`:'')+(options.placeholder?` placeholder="${e(options.placeholder)}"`:'');
 return `<label class="iv-field">${e(label)}<input name="${e(name)}" type="${e(type)}" value="${e(value)}" maxlength="${maximum}"${type==='email'?' autocomplete="email"':''}${attrs}></label>`;
}
export const area=(label:string,name:string,value='',maximum=1000,required=false):string=>`<label class="iv-field">${e(label)}<textarea name="${e(name)}" rows="4" maxlength="${maximum}"${required?' required':''}>${e(value)}</textarea></label>`;
