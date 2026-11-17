import {csrfField,type Shell} from './seo-blog-view.js';
import {base} from './creative-studio-view.js';
export function creativeMediaErasureForm(shell:Shell,kind:'source'|'local_output',id:string):string{
 if(!/^[a-f0-9-]{36}$/u.test(id))throw Error('Asset identity required');
 return '<form method="post" action="'+base(shell)+'/erase">'+csrfField(shell.csrf)+'<input type="hidden" name="kind" value="'+kind+'"><input type="hidden" name="id" value="'+id+'"><label><input type="checkbox" name="confirm" value="1" required> Delete this private media'+(kind==='source'?' and its derived local renders':'')+'. Future distribution stops; already published posts must be removed from the social account too.</label><button type="submit">Delete private media</button></form>';
}

/** Unmounted owner choice. Empty days means retain indefinitely, the default. */
export function creativeMediaRetentionForm(shell:Shell):string{
 return '<form method="post" action="'+base(shell)+'/retention">'+csrfField(shell.csrf)+'<label>Delete sources and local outputs after this many days (leave empty to keep indefinitely)<input type="number" name="days" min="1" max="3650"></label><label><input type="checkbox" name="confirm" value="1" required>I explicitly choose this library retention policy.</label><button type="submit">Save retention choice</button></form>';
}
