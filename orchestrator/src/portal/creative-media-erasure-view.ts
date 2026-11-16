import {csrfField,type Shell} from './seo-blog-view.js';
import {base} from './creative-studio-view.js';
export function creativeMediaErasureForm(shell:Shell,kind:'source'|'local_output'|'provider_output',id:string):string{
 if(!/^[a-f0-9-]{36}$/u.test(id))throw Error('Asset identity required');
 return '<form method="post" action="'+base(shell)+'/erase">'+csrfField(shell.csrf)+'<input type="hidden" name="kind" value="'+kind+'"><input type="hidden" name="id" value="'+id+'"><label><input type="checkbox" name="confirm" value="1" required> Delete this private media'+(kind==='source'?' and its derived local renders':'')+'. Future distribution stops; provider copies require takedown.</label><button type="submit">Delete private media</button></form>';
}
