/**
 * Deep Intake form generator (LS-11). Renders a self-contained, brandable HTML
 * form DIRECTLY from the canonical INTAKE_FIELDS spec, so the customer-facing
 * form and the pipeline's A1–H4 input contract can never drift. Client-side
 * validation mirrors S0 (runS0) exactly — required, conditional-required,
 * min-words, option validity, placeholder-echo — so the customer fixes thin
 * answers before submitting; S0 stays the server-side authority.
 *
 * Output payload is the flat A1–H4 JSON the CLI consumes via `--input`.
 * Self-hosted (no Tally/Fillout account, no external calls). Founder can point
 * SUBMIT_ENDPOINT at a webhook later; default is download-the-JSON.
 */

import { INTAKE_FIELDS, type FieldSpec } from './spec.js';

const SECTION_TITLES: Record<string, string> = {
  A: 'The business',
  B: 'The numbers',
  C: 'Your customers',
  D: 'Offer & pricing',
  E: 'Competitors & position',
  F: 'Marketing history',
  G: 'Goals & constraints',
  H: 'Voice & brand',
};

const SECTION_BLURB: Record<string, string> = {
  A: 'The basics, so everything we build has your name on it.',
  B: 'Rough is fine — bands where we offer them. This sets how ambitious the plan can be.',
  C: 'The most important section. The more real detail here, the less generic everything downstream.',
  D: 'What you actually sell, in your words. We turn it into an offer ladder.',
  E: 'Honest beats flattering. The gap against rivals is where your positioning wins.',
  F: 'What you have, what worked, what flopped — so we double down and never repeat failures.',
  G: 'What you want, and what you can realistically give. A plan you can’t run is a failed plan.',
  H: 'How you sound. This governs the voice of every word we write for you.',
};

/** Customer-facing "why we ask" microcopy (design principle 1: every field earns its keep). */
const WHY: Record<string, string> = {
  A1: 'Goes on every page and document we build you.',
  A2: 'This one line sets your whole message — say it like you’d say it to a mate, not like a brochure.',
  A3: 'We read what’s there now so we can see the gap. Optional.',
  A4: 'Ten years and ten months get a different relaunch story.',
  A5: 'Decides whether we point you at local or national channels.',
  A6: 'Routes which playbook we run for you.',
  A7: 'So the plan fits the hands you’ve actually got. Optional.',
  B1: 'Sets how ambitious the 90-day plan should be. A band is fine.',
  B2: 'The single number the offer and ad maths hang on.',
  B3: 'Your baseline, so the targets are real.',
  B4: 'Where the money actually comes from today — be honest, not aspirational.',
  B5: 'Tells us what channel mix is realistic. A band is fine. Optional.',
  B6: 'So we only recommend things that actually pay. Optional.',
  C1: 'The one real person everything we write will speak to. Detail here pays off everywhere.',
  C2: 'The single most valuable box on this form. Their exact words become your marketing — copy-paste, don’t paraphrase.',
  C3: 'The thing underneath the surface job — that’s what your message really sells.',
  C4: 'The trigger moment — that’s where your best hooks come from.',
  C5: 'Every objection you name here, we answer in the copy.',
  C6: 'Naming who you don’t want sharpens who you do.',
  C7: 'Where we’ll aim to reach them. Optional.',
  C8: 'The stuff that failed them before you — great positioning fuel.',
  D1: 'Your raw offer — one per line, with prices. This is what we architect into a ladder.',
  D2: 'Tells us what to lead with.',
  D3: 'So the plan pulls toward where you want to go.',
  D4: 'A promise you can stand behind de-risks the sale. Optional.',
  D5: 'So the plan paces demand you can actually handle.',
  D6: 'Boundaries keep the copy honest and on-brand. Optional.',
  E1: 'Who we’re benchmarking you against.',
  E2: 'The honest gap is where the positioning wins.',
  E3: 'If you write “quality” or “service”, tell us what a customer actually sees or gets.',
  E4: 'Anchors how we price and position you.',
  E5: 'Calibrates the taste of what we make. Optional.',
  F1: 'Your current toolkit — what we’re working with.',
  F2: 'A cold list and a warm one get very different emails.',
  F3: 'So we never re-prescribe something that already flopped for you.',
  F4: 'So we double down on what’s already bringing customers in.',
  F5: 'The two platforms your month of content will target. Pick where your buyers actually are.',
  G1: 'Your north star for the next 90 days — specific beats “grow”.',
  G2: 'A 10-hour plan for a 2-hour week fails. We size it to you.',
  G3: 'What you’d spend if the plan earned it. A band is fine. Optional.',
  G4: 'Anything on the horizon we should plan around. Optional.',
  H1: 'Sets the voice of everything we write.',
  H2: 'Point at a vibe you rate — any industry — and we’ll calibrate to it.',
  H3: 'Words to ban or insist on. We enforce them in QA. Optional.',
  H4: 'Anything else that helps us get you right. Optional.',
};

const SLIDER_LABELS: Record<string, [string, string]> = {
  formal_casual: ['Formal', 'Casual'],
  playful_straight: ['Playful', 'Straight-talking'],
  bold_understated: ['Bold', 'Understated'],
};

const BOX_LABELS: Record<string, string> = {
  never_use: 'Words you’d never use',
  must_use: 'Words you must use',
};

/** Client-facing field descriptor (spec + microcopy), serialized into the page. */
interface ClientField {
  id: string;
  section: string;
  label: string;
  kind: FieldSpec['kind'];
  required: boolean;
  requiredIf?: { ifField: string; includes: string };
  minWords?: number;
  options?: string[];
  allowOther?: boolean;
  minSelections?: number;
  maxSelections?: number;
  placeholder?: string;
  sliders?: Array<{ key: string; left: string; right: string }>;
  boxes?: Array<{ key: string; label: string }>;
  why: string;
}

function toClientField(f: FieldSpec): ClientField {
  const cf: ClientField = {
    id: f.id,
    section: f.section,
    label: f.label,
    kind: f.kind,
    required: f.required === true,
    minWords: f.minWords,
    options: f.options,
    allowOther: f.allowOther,
    minSelections: f.minSelections,
    maxSelections: f.maxSelections,
    placeholder: f.placeholder,
    why: WHY[f.id] ?? '',
  };
  if (typeof f.required === 'object') cf.requiredIf = f.required;
  if (f.kind === 'sliders') {
    cf.sliders = (f.sliderKeys ?? []).map((key) => ({ key, left: SLIDER_LABELS[key]?.[0] ?? key, right: SLIDER_LABELS[key]?.[1] ?? '' }));
  }
  if (f.kind === 'two_box') {
    cf.boxes = (f.boxKeys ?? []).map((key) => ({ key, label: BOX_LABELS[key] ?? key }));
  }
  return cf;
}

/** Render the complete, self-contained intake form as an HTML document string. */
export function renderIntakeForm(opts: { submitEndpoint?: string } = {}): string {
  const fields = INTAKE_FIELDS.map(toClientField);
  const sections = [...new Set(fields.map((f) => f.section))];
  const sectionMeta = sections.map((s) => ({ id: s, title: SECTION_TITLES[s] ?? s, blurb: SECTION_BLURB[s] ?? '' }));
  const data = JSON.stringify({ fields, sections: sectionMeta, submitEndpoint: opts.submitEndpoint ?? null });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Relaunch72 — Deep Intake</title>
<style>${STYLE}</style>
</head>
<body>
<div id="app" aria-live="polite"></div>
<script id="intake-spec" type="application/json">${data}</script>
<script>${CLIENT}</script>
</body>
</html>`;
}

const STYLE = String.raw`
  :root{
    --ink:#0c1018;--paper:#f6f7fb;--card:#fff;--muted:#5b6577;--faint:#8b93a3;--hair:#e3e6ee;
    --electric:#3557ff;--electric-ink:#2a44d6;--wash:#eef1ff;--green:#17915a;--amber:#b1741a;--red:#c23b46;
    --shadow:0 1px 2px rgba(12,16,24,.05),0 10px 30px -18px rgba(12,16,24,.22);
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Code",Menlo,monospace;
  }
  @media (prefers-color-scheme:dark){:root{
    --ink:#eaeef6;--paper:#0c0f14;--card:#151a22;--muted:#99a2b3;--faint:#6c7686;--hair:#242c37;
    --electric:#6d86ff;--electric-ink:#93a6ff;--wash:#171f30;--green:#45c088;--amber:#d8a04e;--red:#e86b74;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 12px 34px -18px rgba(0,0,0,.7);
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased}
  .wrap{max-width:760px;margin:0 auto;padding:0 22px 120px}
  .kicker{font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--electric);font-weight:600}
  h1{font-size:clamp(30px,5.4vw,46px);line-height:1.05;letter-spacing:-.022em;margin:12px 0 0;font-weight:800;text-wrap:balance}
  h2{font-size:23px;letter-spacing:-.015em;margin:0;font-weight:800}
  p{margin:0}
  .lede{color:var(--muted);font-size:17px;margin:16px 0 0}
  .lede b{color:var(--ink)}
  .btn{font:inherit;font-weight:650;font-size:15px;border:none;border-radius:11px;padding:13px 22px;cursor:pointer;background:var(--electric);color:#fff;transition:transform .08s,filter .12s}
  .btn:hover{filter:brightness(1.06)}.btn:active{transform:translateY(1px)}
  .btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--hair)}
  .btn.ghost:hover{border-color:var(--muted);filter:none}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,.opt:focus-visible{outline:2px solid var(--electric);outline-offset:2px}

  /* intro */
  .intro{padding:64px 0 0}
  .intro .card{margin-top:28px;background:var(--card);border:1px solid var(--hair);border-radius:16px;box-shadow:var(--shadow);padding:26px}
  .intro ul{margin:14px 0 0;padding-left:18px;color:var(--muted);font-size:15px}
  .intro li{margin:6px 0}
  .intro .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:24px}
  .time{font-family:var(--mono);font-size:13px;color:var(--faint)}

  /* progress */
  .top{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--paper) 90%,transparent);backdrop-filter:blur(8px);padding:14px 0 12px;margin-bottom:4px}
  .bar{height:6px;border-radius:99px;background:var(--hair);overflow:hidden}
  .bar>i{display:block;height:100%;background:var(--electric);border-radius:99px;transition:width .3s ease}
  .steps{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
  .step{font-family:var(--mono);font-size:11px;letter-spacing:.03em;color:var(--faint);border:1px solid var(--hair);border-radius:99px;padding:3px 10px;cursor:pointer;background:none}
  .step.on{color:#fff;background:var(--electric);border-color:var(--electric)}
  .step.done{color:var(--electric-ink);border-color:var(--electric)}

  .sec-head{padding:22px 0 6px}
  .sec-head .n{font-family:var(--mono);font-size:12px;color:var(--electric);font-weight:700}
  .sec-head .blurb{color:var(--muted);font-size:15px;margin-top:8px}

  .field{background:var(--card);border:1px solid var(--hair);border-radius:14px;box-shadow:var(--shadow);padding:18px 18px 16px;margin-top:14px}
  .field.invalid{border-color:color-mix(in srgb,var(--red) 55%,var(--hair))}
  .q{font-size:16px;font-weight:700;letter-spacing:-.01em}
  .q .id{font-family:var(--mono);font-size:12px;color:var(--faint);font-weight:600;margin-right:8px}
  .q .req{color:var(--electric);margin-left:4px}
  .why{color:var(--muted);font-size:13px;margin-top:5px}
  .ctl{margin-top:12px}
  input[type=text],input[type=number],textarea,select{width:100%;font:inherit;color:var(--ink);background:var(--paper);border:1px solid var(--hair);border-radius:10px;padding:11px 13px}
  textarea{min-height:96px;resize:vertical;line-height:1.5}
  select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 18px) 55%,calc(100% - 13px) 55%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;cursor:pointer}
  .opts{display:flex;flex-wrap:wrap;gap:8px}
  .opt{font:inherit;font-size:14px;border:1px solid var(--hair);background:var(--paper);color:var(--ink);border-radius:99px;padding:8px 15px;cursor:pointer}
  .opt[aria-pressed=true]{background:var(--electric);border-color:var(--electric);color:#fff}
  .other{margin-top:8px}
  .count{font-family:var(--mono);font-size:11px;color:var(--faint);margin-top:7px}
  .count.warn{color:var(--amber)}.count.ok{color:var(--green)}
  .err{font-size:13px;color:var(--red);margin-top:8px;display:none}
  .field.invalid .err{display:block}
  .slider{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;margin-top:12px}
  .slider .l{font-size:13px;color:var(--muted)}.slider .l.r{text-align:right}
  .slider input[type=range]{width:100%;accent-color:var(--electric)}
  .slider .val{font-family:var(--mono);font-size:12px;color:var(--electric-ink);min-width:1.5em;text-align:center}
  .twobox{display:grid;gap:10px}
  .twobox label{font-size:13px;color:var(--muted);display:block;margin-bottom:4px}

  .nav{display:flex;justify-content:space-between;gap:12px;margin-top:26px}
  .foot{color:var(--faint);font-size:12px;margin-top:18px;text-align:center}
  .save{font-family:var(--mono);font-size:11px;color:var(--faint);text-align:center;margin-top:10px}

  /* review / done */
  .nudge{background:var(--card);border:1px solid color-mix(in srgb,var(--amber) 45%,var(--hair));border-radius:14px;padding:18px;margin-top:16px}
  .nudge h3{margin:0 0 8px;font-size:15px;color:var(--amber)}
  .nudge ul{margin:0;padding-left:18px;font-size:14px;color:var(--muted)}
  .nudge li{margin:5px 0;cursor:pointer}
  .nudge li b{color:var(--ink)}
  .done{text-align:center;padding:70px 0}
  .done .tick{width:60px;height:60px;border-radius:50%;background:var(--green);color:#fff;display:grid;place-items:center;font-size:30px;margin:0 auto 20px}
  .consent{display:flex;gap:11px;align-items:flex-start;margin-top:16px;font-size:14px;color:var(--muted)}
  .consent input{margin-top:3px;width:18px;height:18px;accent-color:var(--electric)}
  @media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const CLIENT = String.raw`
(function(){
  var SPEC = JSON.parse(document.getElementById("intake-spec").textContent);
  var FIELDS = SPEC.fields, SECTIONS = SPEC.sections;
  var KEY = "relaunch72-intake-v1";
  var state = load();          // { answers:{}, step:0 }
  var app = document.getElementById("app");

  // Purchase context carried from checkout (Stripe Payment Link success URL).
  var URLP = new URLSearchParams(location.search);
  var TIER = (URLP.get("tier") || "").toLowerCase();
  var SESSION = URLP.get("session") || "";
  var TIER_NAMES = { autopsy: "Marketing Autopsy", core: "Relaunch72 Core", pro: "Relaunch72 Pro" };
  if (TIER || SESSION) { state.tier = TIER || state.tier; state.session = SESSION || state.session; save(); }

  function load(){ try{ return JSON.parse(localStorage.getItem(KEY)) || {answers:{},step:0}; }catch(e){ return {answers:{},step:0}; } }
  function save(){ try{ localStorage.setItem(KEY, JSON.stringify(state)); }catch(e){} }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];}); }
  function words(s){ return String(s||"").split(/\s+/).filter(Boolean).length; }

  // ---- validation, mirroring S0 (runS0) ----
  function norm(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
  function jaccard(a,b){ var A=new Set(norm(a).split(" ").filter(Boolean)),B=new Set(norm(b).split(" ").filter(Boolean)); if(!A.size||!B.size)return 0; var i=0; A.forEach(function(x){if(B.has(x))i++;}); return i/(A.size+B.size-i); }
  function placeholderEcho(ans,ph){ if(!ph)return false; var a=norm(ans),p=norm(ph); if(!a||!p)return false; if(a===p||a.indexOf(p)>=0||p.indexOf(a)>=0)return true; return jaccard(ans,ph)>=0.6; }
  function isRequired(f){ if(f.requiredIf){ var g=state.answers[f.requiredIf.ifField]; return Array.isArray(g)&&g.indexOf(f.requiredIf.includes)>=0; } return f.required; }
  function isEmpty(v){ if(v==null)return true; if(typeof v==="string")return !v.trim(); if(Array.isArray(v))return v.length===0; if(typeof v==="object")return Object.keys(v).length===0; return false; }

  function fieldError(f){
    var v=state.answers[f.id], req=isRequired(f);
    if(isEmpty(v)) return req ? "This one’s required — please answer it." : null;
    if(f.kind==="text"||f.kind==="textarea"||f.kind==="short_text"){
      if(typeof v!=="string") return "Please enter text.";
      if(f.minWords && words(v)<f.minWords) return "A little more detail: at least "+f.minWords+" words (you have "+words(v)+"). Specifics are what make your output good.";
      if(f.placeholder && placeholderEcho(v,f.placeholder)) return "That looks like our example — tell us about YOUR business, in your own words.";
    }
    if(f.kind==="number"){ var n=typeof v==="string"?Number(v.replace(/[£$,\s]/g,"")):v; if(!isFinite(n)||n<0) return "Please enter a number."; if(f.id==="B2"&&n<=0) return "Average sale value must be more than zero."; }
    if(f.kind==="select"){ if(f.options && f.options.indexOf(v)<0 && !f.allowOther) return "Please pick one of the options."; }
    if(f.kind==="multi_select"){ if(!Array.isArray(v)) return "Please pick from the list."; if(f.minSelections && v.length<f.minSelections) return "Pick at least "+f.minSelections+"."; if(f.maxSelections && v.length>f.maxSelections) return "Pick at most "+f.maxSelections+" (you have "+v.length+")."; }
    if(f.kind==="sliders"){ for(var i=0;i<f.sliders.length;i++){ var sv=v&&v[f.sliders[i].key]; if(!(sv>=1&&sv<=5)) return "Please set all three sliders."; } }
    if(f.kind==="url_list"){ for(var j=0;j<v.length;j++){ if(/\s/.test(v[j].trim())||!/\S\.\S/.test(v[j])) return "“"+v[j]+"” doesn’t look like a link."; } }
    return null;
  }
  function sectionFields(sid){ return FIELDS.filter(function(f){return f.section===sid;}); }
  function sectionErrors(sid){ var e={}; sectionFields(sid).forEach(function(f){ var m=fieldError(f); if(m)e[f.id]=m; }); return e; }
  function answeredCount(){ var n=0; FIELDS.forEach(function(f){ if(!isEmpty(state.answers[f.id]))n++; }); return n; }

  // ---- payload: flat A1..H4 in the pipeline's contract ----
  function payload(){
    var out={};
    FIELDS.forEach(function(f){
      var v=state.answers[f.id];
      if(isEmpty(v))return;
      if(f.kind==="number"){ out[f.id]=typeof v==="string"?Number(v.replace(/[£$,\s]/g,"")):v; }
      else out[f.id]=v;
    });
    out.consent = !!state.answers.consent;
    out._generated_by = "relaunch72-deep-intake-form";
    if (state.tier) out._tier = state.tier;
    if (state.session) out._stripe_session = state.session;
    return out;
  }

  // ---- rendering ----
  function h(tag,attrs,html){ var a=Object.keys(attrs||{}).map(function(k){return k+'="'+esc(attrs[k])+'"';}).join(" "); return "<"+tag+(a?" "+a:"")+">"+(html==null?"":html)+"</"+tag+">"; }

  function controlHTML(f){
    var v=state.answers[f.id], id="ctl-"+f.id;
    if(f.kind==="short_text"||f.kind==="text") return '<input type="text" id="'+id+'" data-f="'+f.id+'" value="'+esc(v||"")+'" placeholder="'+esc(f.placeholder||"")+'"/>';
    if(f.kind==="number") return '<input type="text" inputmode="decimal" id="'+id+'" data-f="'+f.id+'" value="'+esc(v==null?"":v)+'" placeholder="e.g. 850"/>';
    if(f.kind==="textarea") return '<textarea id="'+id+'" data-f="'+f.id+'" placeholder="'+esc(f.placeholder||"")+'">'+esc(v||"")+'</textarea>'+(f.minWords?'<div class="count" data-count="'+f.id+'"></div>':"");
    if(f.kind==="url_list"){ var txt=Array.isArray(v)?v.join("\n"):(v||""); return '<textarea id="'+id+'" data-f="'+f.id+'" data-list="1" placeholder="one link per line">'+esc(txt)+'</textarea>'; }
    if(f.kind==="select"){
      var opts='<option value="">Choose…</option>'+(f.options||[]).map(function(o){return '<option'+(v===o?' selected':'')+'>'+esc(o)+'</option>';}).join("");
      if(f.allowOther) opts+='<option value="__other__"'+(v&&f.options.indexOf(v)<0?' selected':'')+'>Something else…</option>';
      var sel='<select id="'+id+'" data-f="'+f.id+'">'+opts+'</select>';
      if(f.allowOther){ var isOther=v&&f.options.indexOf(v)<0; sel+='<div class="other" data-other="'+f.id+'" style="'+(isOther?'':'display:none')+'"><input type="text" data-otherinput="'+f.id+'" value="'+esc(isOther?v:"")+'" placeholder="Tell us"/></div>'; }
      return sel;
    }
    if(f.kind==="multi_select"){
      var arr=Array.isArray(v)?v:[];
      var chips=(f.options||[]).map(function(o){ var on=arr.indexOf(o)>=0; return '<button type="button" class="opt" data-multi="'+f.id+'" data-val="'+esc(o)+'" aria-pressed="'+on+'">'+esc(o)+'</button>'; }).join("");
      var extra="";
      if(f.allowOther){ var customs=arr.filter(function(x){return (f.options||[]).indexOf(x)<0;}); extra=customs.map(function(o){ return '<button type="button" class="opt" data-multi="'+f.id+'" data-val="'+esc(o)+'" aria-pressed="true">'+esc(o)+' ✕</button>'; }).join(""); extra+='<input class="other" type="text" data-multiother="'+f.id+'" placeholder="Add your own + Enter"/>'; }
      return '<div class="opts">'+chips+extra+'</div>';
    }
    if(f.kind==="sliders"){
      return f.sliders.map(function(s){ var sv=(v&&v[s.key])||3; return '<div class="slider"><span class="l">'+esc(s.left)+'</span><input type="range" min="1" max="5" step="1" value="'+sv+'" data-slider="'+f.id+'" data-key="'+s.key+'"/><span class="l r">'+esc(s.right)+'</span><span class="val" data-slval="'+f.id+'-'+s.key+'">'+sv+'</span></div>'; }).join("");
    }
    if(f.kind==="two_box"){
      return '<div class="twobox">'+f.boxes.map(function(b){ var bv=(v&&v[b.key])||""; return '<div><label>'+esc(b.label)+'</label><input type="text" data-box="'+f.id+'" data-key="'+b.key+'" value="'+esc(bv)+'"/></div>'; }).join("")+'</div>';
    }
    return "";
  }

  function fieldHTML(f,showErr){
    var err=showErr?fieldError(f):null, req=isRequired(f);
    return '<div class="field'+(err?' invalid':'')+'" data-field="'+f.id+'">'+
      '<div class="q"><span class="id">'+f.id+'</span>'+esc(f.label)+(req?'<span class="req">*</span>':'')+'</div>'+
      (f.why?'<div class="why">'+esc(f.why)+'</div>':'')+
      '<div class="ctl">'+controlHTML(f)+'</div>'+
      '<div class="err">'+esc(err||"")+'</div>'+
    '</div>';
  }

  function renderIntro(){
    app.innerHTML='<div class="wrap intro">'+
      '<div class="kicker">Relaunch72 · Deep Intake</div>'+
      (state.tier && TIER_NAMES[state.tier] ? '<div class="time" style="margin-top:10px">Plan: <b style="color:var(--electric)">'+TIER_NAMES[state.tier]+'</b></div>' : '')+
      '<h1>The discovery day an agency charges $3k for — done in your own words.</h1>'+
      '<p class="lede">This is the single most important thing you’ll do in this process. <b>Generic answers in, generic marketing out.</b> Specific, honest ones give us the fuel to build you a relaunch that actually sounds like you.</p>'+
      '<div class="card">'+
        '<p class="time">⏱ 40–50 minutes · save-and-resume on · your answers stay in this browser until you send them</p>'+
        '<ul>'+
          '<li>Bands where we offer them — you never need exact figures for revenue or spend.</li>'+
          '<li>Section C (your customers) is the gold. Real quotes beat everything.</li>'+
          '<li>We’ll flag any thin answers before you send, so nothing weak reaches the build.</li>'+
        '</ul>'+
        '<div class="row"><button class="btn" id="start">Start the intake →</button>'+(answeredCount()?'<span class="time">'+answeredCount()+' answers saved</span>':'')+'</div>'+
      '</div>'+
      '<p class="foot">Your 72-hour clock starts only when we accept your completed intake — not before.</p>'+
    '</div>';
    document.getElementById("start").onclick=function(){ go(0); };
  }

  function renderSection(i){
    state.step=i; save();
    var sec=SECTIONS[i], fs=sectionFields(sec.id), n=SECTIONS.length;
    var pct=Math.round(((i)/(n))*100);
    var steps=SECTIONS.map(function(s,k){ var cls=k===i?'step on':(k<i?'step done':'step'); return '<button class="'+cls+'" data-step="'+k+'">'+s.id+'</button>'; }).join("");
    app.innerHTML='<div class="wrap">'+
      '<div class="top"><div class="bar"><i style="width:'+pct+'%"></i></div><div class="steps">'+steps+'</div></div>'+
      '<div class="sec-head"><div class="n">Section '+sec.id+' · '+(i+1)+' of '+n+'</div><h2>'+esc(sec.title)+'</h2><div class="blurb">'+esc(sec.blurb)+'</div></div>'+
      fs.map(function(f){return fieldHTML(f,false);}).join("")+
      '<div class="nav"><button class="btn ghost" id="prev">'+(i===0?'← Intro':'← Back')+'</button>'+
        (i===n-1?'<button class="btn" id="review">Review &amp; finish →</button>':'<button class="btn" id="next">Next section →</button>')+'</div>'+
      '<div class="save" id="savenote">Saved automatically</div>'+
    '</div>';
    wire(sec.id);
  }

  function wire(sid){
    app.querySelectorAll("[data-step]").forEach(function(b){ b.onclick=function(){ go(+b.getAttribute("data-step")); }; });
    var prev=document.getElementById("prev"); if(prev) prev.onclick=function(){ state.step<=0?renderIntro():go(state.step-1); };
    var next=document.getElementById("next"); if(next) next.onclick=function(){ advance(sid, state.step+1); };
    var review=document.getElementById("review"); if(review) review.onclick=function(){ advance(sid, "review"); };

    app.querySelectorAll("[data-f]").forEach(function(el){
      el.oninput=function(){ var f=el.getAttribute("data-f"),fs=FIELDS.filter(function(x){return x.id===f;})[0];
        if(el.getAttribute("data-list")==="1"){ state.answers[f]=el.value.split(/[\n,]+/).map(function(s){return s.trim();}).filter(Boolean); }
        else state.answers[f]=el.value;
        updateCount(fs); save(); revalidate(fs);
      };
    });
    app.querySelectorAll("select[data-f]").forEach(function(sel){
      sel.onchange=function(){ var f=sel.getAttribute("data-f"),box=app.querySelector('[data-other="'+f+'"]');
        if(sel.value==="__other__"){ if(box){box.style.display="";} state.answers[f]=(box&&box.querySelector("input").value)||""; }
        else { if(box)box.style.display="none"; state.answers[f]=sel.value; }
        save(); revalidate(FIELDS.filter(function(x){return x.id===f;})[0]);
      };
    });
    app.querySelectorAll("[data-otherinput]").forEach(function(inp){ inp.oninput=function(){ var f=inp.getAttribute("data-otherinput"); state.answers[f]=inp.value; save(); }; });
    app.querySelectorAll("[data-multi]").forEach(function(btn){
      btn.onclick=function(){ var f=btn.getAttribute("data-multi"),val=btn.getAttribute("data-val");
        var arr=Array.isArray(state.answers[f])?state.answers[f].slice():[]; var ix=arr.indexOf(val);
        var fs=FIELDS.filter(function(x){return x.id===f;})[0];
        if(ix>=0)arr.splice(ix,1); else { if(fs.maxSelections&&arr.length>=fs.maxSelections){ flashMax(f); return; } arr.push(val); }
        state.answers[f]=arr; save(); rerenderField(fs);
      };
    });
    app.querySelectorAll("[data-multiother]").forEach(function(inp){ inp.onkeydown=function(e){ if(e.key==="Enter"){ e.preventDefault(); var f=inp.getAttribute("data-multiother"),val=inp.value.trim(); if(!val)return; var arr=Array.isArray(state.answers[f])?state.answers[f].slice():[]; var fs=FIELDS.filter(function(x){return x.id===f;})[0]; if(fs.maxSelections&&arr.length>=fs.maxSelections){flashMax(f);return;} if(arr.indexOf(val)<0)arr.push(val); state.answers[f]=arr; save(); rerenderField(fs); } }; });
    app.querySelectorAll("[data-slider]").forEach(function(sl){ sl.oninput=function(){ var f=sl.getAttribute("data-slider"),key=sl.getAttribute("data-key"); var o=state.answers[f]||{}; o[key]=+sl.value; state.answers[f]=o; var lbl=app.querySelector('[data-slval="'+f+'-'+key+'"]'); if(lbl)lbl.textContent=sl.value; save(); }; });
    app.querySelectorAll("[data-box]").forEach(function(bx){ bx.oninput=function(){ var f=bx.getAttribute("data-box"),key=bx.getAttribute("data-key"); var o=state.answers[f]||{}; o[key]=bx.value; state.answers[f]=o; save(); }; });
    FIELDS.filter(function(f){return f.section===sid;}).forEach(updateCount);
  }
  function flashMax(f){ var el=app.querySelector('[data-field="'+f+'"]'); if(el){ el.classList.add("invalid"); el.querySelector(".err").textContent="That’s the max — deselect one to change it."; el.querySelector(".err").style.display="block"; } }
  function updateCount(f){ if(!f||!f.minWords)return; var el=app.querySelector('[data-count="'+f.id+'"]'); if(!el)return; var w=words(state.answers[f.id]); el.textContent=w+" / "+f.minWords+" words"; el.className="count"+(w>=f.minWords?" ok":(w>0?" warn":"")); }
  function revalidate(f){ if(!f)return; var wrap=app.querySelector('[data-field="'+f.id+'"]'); if(!wrap)return; var err=fieldError(f); if(!err){ wrap.classList.remove("invalid"); wrap.querySelector(".err").textContent=""; } }
  function rerenderField(f){ var wrap=app.querySelector('[data-field="'+f.id+'"]'); if(!wrap)return; var tmp=document.createElement("div"); tmp.innerHTML=fieldHTML(f,false); wrap.replaceWith(tmp.firstChild); wire(f.section); }

  function advance(sid,to){
    var errs=sectionErrors(sid);
    // re-render section to surface errors; block only on THIS section's issues
    if(Object.keys(errs).length){
      var sec=SECTIONS[state.step];
      renderSection(state.step);
      app.querySelectorAll('[data-field]').forEach(function(w){ var id=w.getAttribute("data-field"); if(errs[id]){ w.classList.add("invalid"); var e=w.querySelector(".err"); e.textContent=errs[id]; } });
      var first=app.querySelector(".field.invalid"); if(first)first.scrollIntoView({behavior:"smooth",block:"center"});
      return;
    }
    to==="review"?renderReview():go(to);
  }
  function go(i){ if(i<0){renderIntro();return;} if(i>=SECTIONS.length){renderReview();return;} window.scrollTo(0,0); renderSection(i); }

  function renderReview(){
    window.scrollTo(0,0);
    var allErrs=[]; FIELDS.forEach(function(f){ var m=fieldError(f); if(m)allErrs.push({f:f,m:m}); });
    var consentOk=!!state.answers.consent;
    var body;
    if(allErrs.length){
      body='<div class="nudge"><h3>A few answers need a little more before we can accept this</h3><ul>'+
        allErrs.map(function(x){return '<li data-jump="'+x.f.section+'"><b>'+x.f.id+' · '+esc(x.f.label)+'</b> — '+esc(x.m)+'</li>';}).join("")+
        '</ul></div>';
    } else {
      body='<p class="lede">Everything checks out. '+answeredCount()+' of '+FIELDS.length+' fields answered. Send it and your 72-hour clock starts the moment we accept it.</p>';
    }
    app.innerHTML='<div class="wrap"><div class="sec-head"><div class="n">Final step</div><h2>Review &amp; send</h2></div>'+
      body+
      '<label class="consent"><input type="checkbox" id="consent" '+(consentOk?'checked':'')+'/><span>I confirm my answers are accurate. I understand my marketing pack is produced with AI assistance and a human review before delivery, and that my data is handled per the privacy policy.</span></label>'+
      '<div class="nav"><button class="btn ghost" id="back">← Back to sections</button>'+
        '<button class="btn" id="send" '+((allErrs.length||!consentOk)?'disabled':'')+'>Send my intake →</button></div>'+
      '<div class="foot">Sending submits your answers to Relaunch72 — your 72-hour clock starts the moment we accept them.</div></div>';
    document.getElementById("back").onclick=function(){ go(SECTIONS.length-1); };
    document.getElementById("consent").onchange=function(e){ state.answers.consent=e.target.checked; save(); renderReview(); };
    app.querySelectorAll("[data-jump]").forEach(function(li){ li.onclick=function(){ var sid=li.getAttribute("data-jump"); go(SECTIONS.map(function(s){return s.id;}).indexOf(sid)); }; });
    var send=document.getElementById("send"); if(send&&!send.disabled) send.onclick=submit;
  }

  function submit(){
    var data=payload();
    var send=document.getElementById("send");
    if(SPEC.submitEndpoint){
      if(send){ send.disabled=true; send.textContent="Sending…"; }
      fetch(SPEC.submitEndpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)})
        .then(function(r){ return r.json().catch(function(){ return {}; }); })
        .then(function(res){
          if(res&&res.accepted===false){ renderRejected(res.issues||[]); return; }
          try{ localStorage.removeItem(KEY); }catch(e){}
          renderDone();
        })
        .catch(function(){ downloadCopy(data); });
    } else {
      // No backend wired (dev/preview) — keep a local copy so nothing is lost.
      downloadCopy(data);
      try{ localStorage.removeItem(KEY); }catch(e){}
    }
  }

  function renderDone(){
    app.innerHTML='<div class="wrap done"><div class="tick">✓</div><h1>That’s the hard part done.</h1>'+
      '<p class="lede">Your intake is in. We review it (usually within a few hours) and your 72-hour build clock starts the moment we accept it. Keep an eye on your inbox.</p>'+
      '<p class="foot" style="margin-top:24px">You can close this tab.</p></div>';
  }

  function renderRejected(issues){
    var lis=(issues||[]).map(function(x){
      var label=(x&&x.label)?x.label:((x&&x.field)?x.field:"An answer"); var reason=(x&&x.reason)?x.reason:String(x);
      return '<li><b>'+esc(label)+((x&&x.field)?' ('+esc(x.field)+')':'')+'</b> — '+esc(reason)+'</li>';
    }).join("");
    app.innerHTML='<div class="wrap"><div class="sec-head"><div class="n">Almost there</div><h2>A couple of answers need a little more before we can accept it</h2></div>'+
      '<div class="nudge"><ul>'+lis+'</ul></div>'+
      '<p class="lede">Nothing’s lost — go back, firm those up, and send again.</p>'+
      '<div class="nav"><button class="btn" id="reback">← Back to my answers</button></div></div>';
    document.getElementById("reback").onclick=function(){ go(SECTIONS.length-1); };
  }

  function downloadCopy(data){
    var name=(data.A1||"intake").toString().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"intake";
    var blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    var url=URL.createObjectURL(blob), a=document.createElement("a"); a.href=url; a.download=name+"-intake.json"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    app.innerHTML='<div class="wrap done"><div class="tick">✓</div><h1>Answers saved to your device.</h1>'+
      '<p class="lede">We couldn’t reach the server just now, so your answers downloaded as a file. Email it to <b>hello@relaunch72.com</b> and we’ll pick it straight up — nothing’s lost.</p>'+
      '<p class="foot" style="margin-top:24px">You can close this tab.</p></div>';
  }

  // boot
  if(answeredCount()>0 && state.step>0){ go(Math.min(state.step,SECTIONS.length-1)); } else { renderIntro(); }
})();
`;
