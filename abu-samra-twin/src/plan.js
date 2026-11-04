// ===== WASL planning layer: lever cost model, goal seeking, projection, text-to-map =====
// Pure logic (no DOM). Evaluations go through an async evalMany(paramsList) -> [forecast results] supplied by the app
// (a Web Worker pool when available), so the search never blocks the 3D view.

// ---- Levers: one step of an intervention, with an indicative cost (QAR million) and lead time (months) ----
// capex: one-off build or procurement; opex: added running cost per year (staff, maintenance, licences);
// lead: months until the step is in service. Figures are planning placeholders for comparison between plans,
// not quotations; replace with GAC programme costs when available.
const LEVERS={
  import:[
    {key:"xrayLanes",d:1,max:4,capex:14,opex:1.1,lead:10,kind:"build",label:"Add an X-ray scanning lane"},
    {key:"radLanes",d:1,max:3,capex:4.5,opex:0.3,lead:6,kind:"build",label:"Add a radiation portal lane"},
    {key:"apptGates",d:1,max:4,capex:2.2,opex:0.7,lead:3,kind:"build",label:"Open another appointment gate"},
    {key:"relGates",d:1,max:3,capex:2.2,opex:0.7,lead:3,kind:"build",label:"Open another release lane"},
    {key:"parking",d:50,max:2,capex:3.5,opex:0.1,lead:5,kind:"build",label:"Pave 50 more main-lot slots"},
    {key:"holdCap",d:20,max:2,capex:1.4,opex:0.05,lead:3,kind:"build",label:"Add 20 external parking slots"},
    {key:"ramps",d:10,max:4,capex:7.5,opex:0.9,lead:8,kind:"build",label:"Build 10 more inspection ramps"},
    {key:"inspMin",d:-15,max:4,capex:0.3,opex:2.4,lead:2,kind:"staff",label:"More inspectors per ramp (15 min faster)"},
    {key:"clearMin",d:-20,max:3,capex:9,opex:0.8,lead:9,kind:"digital",label:"Automate clearance rules (20 min faster)"},
    {key:"xrayMin",d:-0.5,max:3,capex:3,opex:0.4,lead:5,kind:"digital",label:"Scanner image-analysis upgrade (30 s faster)"},
    {key:"inspShare",d:-6,max:3,capex:4,opex:0.6,lead:7,kind:"digital",label:"AI risk targeting (6 pts fewer red-lane trucks)"},
    {key:"aeoShare",d:10,max:3,capex:1.2,opex:0.4,lead:12,kind:"program",label:"Grow AEO membership by 10 pts"},
    {key:"preShare",d:15,max:3,capex:1.5,opex:0.3,lead:6,kind:"program",label:"Require pre-arrival declarations (+15 pts)"},
    {key:"apptMin",d:-0.5,max:2,capex:1.2,opex:0.1,lead:4,kind:"digital",label:"Plate-reader auto-check at appointment gates"},
    {key:"relMin",d:-0.5,max:2,capex:1.2,opex:0.1,lead:4,kind:"digital",label:"Plate-reader auto-release"}],
  export:[
    {key:"permitGates",d:1,max:3,capex:2,opex:0.6,lead:3,kind:"build",label:"Open another permit gate"},
    {key:"entryGates",d:1,max:3,capex:2.2,opex:0.7,lead:3,kind:"build",label:"Open another entry gate"},
    {key:"relGates",d:1,max:3,capex:2.2,opex:0.7,lead:3,kind:"build",label:"Open another release lane"},
    {key:"parking",d:3,max:4,capex:0.6,opex:0.05,lead:2,kind:"build",label:"Add 3 operational parking slots"},
    {key:"ramps",d:2,max:4,capex:1.6,opex:0.25,lead:5,kind:"build",label:"Build 2 more inspection ramps"},
    {key:"extPark",d:20,max:3,capex:1.4,opex:0.05,lead:3,kind:"build",label:"Add 20 external parking slots"},
    {key:"inspMin",d:-10,max:3,capex:0.2,opex:1.2,lead:2,kind:"staff",label:"More inspectors per ramp (10 min faster)"},
    {key:"docMin",d:-10,max:3,capex:2.5,opex:0.4,lead:6,kind:"digital",label:"Electronic export documents (10 min faster)"},
    {key:"inspShare",d:-6,max:3,capex:4,opex:0.6,lead:7,kind:"digital",label:"AI risk targeting (6 pts fewer red-lane trucks)"},
    {key:"aeoShare",d:10,max:3,capex:1.2,opex:0.4,lead:12,kind:"program",label:"Grow AEO membership by 10 pts"},
    {key:"preShare",d:15,max:3,capex:1.5,opex:0.3,lead:6,kind:"program",label:"Require pre-arrival declarations (+15 pts)"},
    {key:"relMin",d:-0.5,max:2,capex:1.2,opex:0.1,lead:4,kind:"digital",label:"Plate-reader auto-release"}]
};
const COST_YEARS=5; // plans are compared on capex + 5 years of added running cost
// ---- Strategies: how the greedy search ranks the next step (gain = hours saved by that step) ----
// fast: physical capacity and staff only (money buys time); cheap: hours saved per riyal, any lever, however slow;
// balanced: weighs cost and lead time together. If balanced ends up identical to another plan it is searched again
// without that plan's biggest lever, so the three options are always genuinely different.
const STRATEGIES=[
  {id:"fast",name:"Fast track",color:"--s1",blurb:"Adds capacity and staff where it bites first. Highest spend, results within months.",allow:l=>l.kind==="build"||l.kind==="staff",score:(g,l)=>g/(l.lead+1.5),finish:(l,c)=>l.lead*1000+c},
  {id:"balanced",name:"Balanced",color:"--s2",blurb:"Weighs cost and time to deliver equally.",allow:()=>true,score:(g,l,c)=>g/Math.sqrt(c*(l.lead+1.5)),finish:(l,c)=>Math.sqrt(c*(l.lead+1.5))},
  {id:"cheap",name:"Cost-smart",color:"--s3",blurb:"Most hours saved per riyal, often digital and programme changes. Lowest spend, slower to land.",allow:()=>true,score:(g,l,c)=>g/c,finish:(l,c)=>c}];
const leverCost=l=>l.capex+COST_YEARS*l.opex;
const pkey=(f,p)=>f+JSON.stringify(Object.keys(p).sort().map(k=>[k,+(+p[k]).toFixed(3)]));
function clampTo(def,v){if(!def)return v;const [, ,mn,mx,st]=def;return Math.min(mx,Math.max(mn,Math.round(v/st)*st))}

// Greedy goal seek. ctx: {flow, base, target, evalMany, sliderDef, onProgress, maxSteps}
async function goalSeek(ctx){
  const {flow,base,target,evalMany,sliderDef,onProgress}=ctx;const maxSteps=ctx.maxSteps||8;const L=LEVERS[flow];
  const cache=new Map();
  const ev=async list=>{const todo=[],idx=[];list.forEach((p,i)=>{const k=pkey(flow,p);if(!cache.has(k)){todo.push(p);idx.push(k)}});
    if(todo.length){const rs=await evalMany(todo);rs.forEach((r,i)=>cache.set(idx[i],r))}return list.map(p=>cache.get(pkey(flow,p)))};
  const [start]=await ev([base]);
  const step=(p,l)=>{const def=sliderDef(flow,l.key);const v=clampTo(def,p[l.key]+l.d);return v===p[l.key]?null:{...p,[l.key]:v}};
  // strategies advance in lock-step so each round's candidate forecasts run as one parallel batch
  const run=async(S,prog)=>{let round=0;
    while(S.some(x=>!x.done)&&round<maxSteps){round++;
      const cand=[];for(const x of S){if(x.done)continue;for(const l of L){if((x.used[l.key]||0)>=l.max||!x.s.allow(l)||x.ex.has(l.key))continue;const q=step(x.p,l);if(q)cand.push({x,l,q})}}
      if(!cand.length)break;
      const rs=await ev(cand.map(c=>c.q));if(prog)prog(round);
      for(const x of S){if(x.done)continue;let best=null;
        // finishing rule: if some step reaches the goal on its own, take the one this strategy likes best
        // (cheapest, quickest, or best balanced) instead of the biggest gain, so plans do not overshoot
        cand.forEach((c,i)=>{if(c.x!==x||rs[i].avgH>target)return;const fin=x.s.finish(c.l,leverCost(c.l));if(!best||fin<best.fin)best={fin,c,r:rs[i],g:x.r.avgH-rs[i].avgH}});
        if(!best)cand.forEach((c,i)=>{if(c.x!==x)return;const g=x.r.avgH-rs[i].avgH;if(g<0.04)return;const sc=x.s.score(g,c.l,leverCost(c.l));if(!best||sc>best.sc)best={sc,c,r:rs[i],g}});
        if(!best){x.done=true;continue}
        x.p=best.c.q;x.r=best.r;x.used[best.c.l.key]=(x.used[best.c.l.key]||0)+1;x.steps.push({lever:best.c.l,gain:best.g,avgH:best.r.avgH});
        if(x.r.avgH<=target)x.done=true}}};
  const mk=(s,ex)=>({s,p:{...base},r:start,steps:[],used:{},done:false,ex:ex||new Set()});
  const S=STRATEGIES.map(s=>mk(s));await run(S,r=>onProgress&&onProgress(Math.min(r,maxSteps)*0.85,maxSteps));
  const sig=x=>x.steps.map(t=>t.lever.key).sort().join(",");const bi=S.findIndex(x=>x.s.id==="balanced");
  for(let tries=0;tries<2;tries++){const dup=S.find((x,i)=>i!==bi&&sig(x)===sig(S[bi]));if(!dup||!S[bi].steps.length)break;
    const top=[...dup.steps].sort((a,b)=>b.gain-a.gain)[0].lever.key;const ex=new Set([...S[bi].ex,top]);S[bi]=mk(S[bi].s,ex);await run([S[bi]])}
  // prune: drop any step the plan can do without and still meet the goal (most expensive first)
  const replay=steps=>{const p={...base};for(const t of steps)p[t.lever.key]=clampTo(sliderDef(flow,t.lever.key),p[t.lever.key]+t.lever.d);return p};
  for(let it=0;it<4;it++){const tries=[];for(const x of S){if(x.r.avgH>target||x.steps.length<2)continue;const seen=new Set();
      for(let i=x.steps.length-1;i>=0;i--){const k=x.steps[i].lever.key;if(seen.has(k))continue;seen.add(k);const st=x.steps.filter((_,j)=>j!==i);tries.push({x,st,save:leverCost(x.steps[i].lever)})}}
    if(!tries.length)break;const rs=await ev(tries.map(t=>replay(t.st)));let any=false;
    for(const x of S){let best=null;tries.forEach((t,i)=>{if(t.x===x&&rs[i].avgH<=target&&(!best||t.save>best.save))best={...t,r:rs[i]}});
      if(best){x.steps=best.st;x.p=replay(best.st);x.r=best.r;any=true}}if(!any)break}
  if(onProgress)onProgress(maxSteps,maxSteps);
  const plans=S.map(x=>{const capex=x.steps.reduce((a,s)=>a+s.lever.capex,0),opex=x.steps.reduce((a,s)=>a+s.lever.opex,0);
    return{params:x.p,result:x.r,steps:x.steps,capex,opex,cost5:capex+COST_YEARS*opex,lead:x.steps.reduce((a,s)=>Math.max(a,s.lever.lead),0),met:x.r.avgH<=target}});
  return{start,plans:nameByOutcome(plans)}
}
// The search rules steer each plan, but the names describe what came out: quickest to land = Fast track,
// cheapest of the rest = Cost-smart, the third = Balanced. Blurbs are written from the plans' own numbers.
function nameByOutcome(P){const left=[...P.keys()];const take=(cmp)=>{left.sort(cmp);return left.shift()};
  const useful=i=>P[i].steps.length?0:1;
  const fi=take((a,b)=>useful(a)-useful(b)||P[a].lead-P[b].lead||P[a].result.avgH-P[b].result.avgH);
  const ci=take((a,b)=>useful(a)-useful(b)||P[a].cost5-P[b].cost5||P[a].lead-P[b].lead);const bi=left[0];
  const maxC=Math.max(...P.map(p=>p.cost5)),maxL=Math.max(...P.map(p=>p.lead));const q=v=>v>=10?v.toFixed(0):v.toFixed(1);
  const F=P[fi],C=P[ci],B=P[bi];
  Object.assign(F,{id:"fast",name:"Fast track",color:"--s1",blurb:`Quickest to land: every change in service within ${F.lead} months.`+(F.cost5>=maxC-1e-9?" The highest spend of the three.":"")});
  Object.assign(C,{id:"cheap",name:"Cost-smart",color:"--s3",blurb:`Lowest spend: QAR ${q(C.cost5)}M over five years.`+(C.lead>=maxL&&C.lead>F.lead?" Slower to land.":"")});
  const between=B.cost5<=Math.max(F.cost5,C.cost5)&&B.cost5>=Math.min(F.cost5,C.cost5)&&B.lead<=Math.max(F.lead,C.lead);
  Object.assign(B,{id:"balanced",name:"Balanced",color:"--s2",blurb:between?"Sits between the other two on cost and on time to deliver.":"A different mix of levers, weighing cost and time to deliver."});
  return [F,B,C]}
// Params of a plan as they stand `m` months from now: only steps whose lead time has passed are in service.
function planAt(base,plan,m,flow,sliderDef){const p={...base};
  for(const s of plan.steps)if(s.lever.lead<=m)p[s.lever.key]=clampTo(sliderDef(flow,s.lever.key),p[s.lever.key]+s.lever.d);return p}
const PROJ_MONTHS=[0,3,6,9,12,18,24,30,36];
// projection points average two seeds: a different demand level reshuffles the random arrivals, so one run is noisy
// Average time in port for "do nothing" and each plan, with demand growing `growth` % a year.
async function projectPlans(ctx){const {flow,base,plans,growth,evalMany,sliderDef}=ctx;const seeds=ctx.seeds||[11,23];const list=[],tag=[];
  for(const m of PROJ_MONTHS){const mult=Math.pow(1+growth/100,m/12);const dmd=p=>({...p,daily:Math.round(p.daily*mult)});
    list.push(dmd(base));tag.push(["base",m]);for(const pl of plans){list.push(dmd(planAt(base,pl,m,flow,sliderDef)));tag.push([pl.id,m])}}
  const runs=await Promise.all(seeds.map(sd=>evalMany(list,sd)));const out={base:[]};plans.forEach(p=>out[p.id]=[]);
  list.forEach((_,i)=>out[tag[i][0]].push({m:tag[i][1],avgH:runs.reduce((a,r)=>a+r[i].avgH,0)/runs.length,bn:runs[0][i].bottleneck}));return out}

// ---- Text to map: plain-language edits -> planner parameter changes ----
const AR_DIGITS="٠١٢٣٤٥٦٧٨٩";
const NUM_WORDS={a:1,an:1,one:1,another:1,single:1,two:2,couple:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,twelve:12,fifteen:15,twenty:20,thirty:30,forty:40,fifty:50,hundred:100,
  "واحد":1,"واحدة":1,"اثنين":2,"اثنان":2,"ثلاث":3,"ثلاثة":3,"أربع":4,"أربعة":4,"خمس":5,"خمسة":5,"عشر":10,"عشرة":10};
// entity -> [capacity key, time key] per flow; tests are run in order, first match wins
const ENTITIES=[
  {id:"aeo",re:/\baeo\b|authori[sz]ed economic|المشغل الاقتصادي/i,cap:{import:"aeoShare",export:"aeoShare"},pct:true},
  {id:"pre",re:/pre-?arrival|advance (declaration|filing)|e-?declaration|التصريح المسبق|مسبق/i,cap:{import:"preShare",export:"preShare"},pct:true},
  {id:"surge",re:/surge|\beid\b|season|peak demand|عيد|موسم|ذروة/i,cap:{import:"surge",export:"surge"},pct:true},
  {id:"demand",re:/trucks? (per|a|each) day|daily trucks|demand|traffic|volume|arrivals|الطلب|حركة الشاحنات|عدد الشاحنات/i,cap:{import:"daily",export:"daily"}},
  {id:"xray",re:/x-?ray|scanner|scanning|أشعة|الأشعة|المسح/i,cap:{import:"xrayLanes"},time:{import:"xrayMin"}},
  {id:"rad",re:/radiation|portal|إشعاع|المشعة/i,cap:{import:"radLanes"},time:{import:"radMin"}},
  {id:"appt",re:/appointment|booking|الموعد|المواعيد/i,cap:{import:"apptGates"},time:{import:"apptMin"}},
  {id:"permit",re:/permit|التصاريح|مخرج المواقف/i,cap:{export:"permitGates"},time:{export:"permitMin"}},
  {id:"entry",re:/entry|مدخل/i,cap:{export:"entryGates"},time:{export:"entryMin"}},
  {id:"release",re:/release|exit gate|الإفراج|الافراج/i,cap:{import:"relGates",export:"relGates"},time:{import:"relMin",export:"relMin"}},
  {id:"share",re:/(inspection|red[- ]lane) (rate|share|percentage)|red[- ]lane|risk (rate|selection)|نسبة التفتيش|المسار الأحمر/i,cap:{import:"inspShare",export:"inspShare"},pct:true},
  {id:"ramps",re:/ramps?|inspection bays?|docks?|inspection|رمب|رمبات|التفتيش/i,cap:{import:"ramps",export:"ramps"},time:{import:"inspMin",export:"inspMin"}},
  {id:"clear",re:/clearance|customs processing|documents?|paperwork|التخليص|المستندات/i,cap:{},time:{import:"clearMin",export:"docMin"},timeOnly:true},
  {id:"hold",re:/external|holding|outside|overflow|buffer|الخارجية/i,cap:{import:"holdCap",export:"extPark"},parkingWord:true},
  {id:"park",re:/operational|op\.? parking|main (parking|lot)|parking|lot|slots?|bays?|مواقف|المواقف/i,cap:{import:"parking",export:"parking"},time:{export:"parkMin"}}];
const RE_TIME=/\b(min(ute)?s?|hours?|hrs?|time|duration|faster|slower|quicker|speed)\b|دقيقة|دقائق|ساعة|وقت|أسرع|أبطأ/i;
const RE_UP=/\b(add(ing)?|more|increase|raise|extra|another|expand|build|open|boost|grow|higher|plus|up)\b|زيادة|زد|أضف|اضف|إضافة|اضافة|افتح|توسيع|رفع/i;
const RE_DOWN=/\b(reduce|cut|remove|fewer|less|decrease|close|lower|drop|minus|shrink|down|shorten|faster|quicker)\b|خفض|تقليل|قلل|إزالة|ازالة|أغلق|تخفيض|إنقاص|أسرع/i;
const RE_SET=/\b(to|set|=|at|make it|becomes?)\b\s*[-+]?\d|إلى\s*\d|الى\s*\d|يصبح/i;
function normText(t){return t.replace(/[٠-٩]/g,c=>AR_DIGITS.indexOf(c)).replace(/٪/g,"%").replace(/،/g,",")}
function parseText(text,flow,params,sliderDef){
  const clauses=normText(text).split(/[\n;.!?]+|,(?!\d)|\band then\b|\bthen\b|\balso\b|\band\b|\s+و(?=[^\d\s]{2,}\s)/i).map(s=>s.trim()).filter(s=>s.length>1);
  const items=[],ignored=[];const next={...params};
  for(const c of clauses){const low=c.toLowerCase();
    let ent=ENTITIES.find(e=>e.re.test(low)&&((e.cap&&e.cap[flow])||(e.time&&e.time[flow])));
    if(!ent){ignored.push({text:c,why:"No planner setting matches this"});continue}
    const isTime=RE_TIME.test(low)&&ent.time&&ent.time[flow];const key=isTime||ent.timeOnly?(ent.time&&ent.time[flow]):ent.cap[flow];
    if(!key){ignored.push({text:c,why:"Not available in the "+flow+" flow"});continue}
    const def=sliderDef(flow,key);if(!def){ignored.push({text:c,why:"Not available in the "+flow+" flow"});continue}
    const cur=next[key];let m=low.match(/[-+]?\d+(\.\d+)?/);let n=m?parseFloat(m[0]):null;
    if(n==null){for(const w in NUM_WORDS){if(new RegExp("(^|\\s)"+w+"(\\s|$)","i").test(low)){n=NUM_WORDS[w];break}}}
    const pct=/%|percent|per cent|بالمئة|بالمائة/.test(low);const unitPct=ent.pct||def[5].trim()==="%";
    let v=null,how="";
    if(/\bdouble\b|ضعف|مضاعفة/.test(low)){v=cur*2;how="doubled"}
    else if(/\btriple\b/.test(low)){v=cur*3;how="tripled"}
    else if(/\bhalve\b|\bhalf\b|النصف/.test(low)){v=cur/2;how="halved"}
    else if(n!=null&&RE_SET.test(low)&&!RE_UP.test(low.replace(/\bto\b.*$/,""))&&!RE_DOWN.test(low.replace(/\bto\b.*$/,""))){v=n;how="set"}
    else if(n!=null){const down=RE_DOWN.test(low)&&!(/slower|أبطأ/.test(low));const up=RE_UP.test(low)||/slower|أبطأ/.test(low);const sign=down&&!up?-1:down&&up?(low.search(RE_DOWN)<low.search(RE_UP)?-1:1):up?1:(m&&m[0].startsWith("-")?-1:1);
      const mag=Math.abs(n);v=pct&&!unitPct?cur*(1+sign*mag/100):cur+sign*mag;how=sign>0?"increased":"reduced"}
    else if(RE_UP.test(low)||RE_DOWN.test(low)){const down=RE_DOWN.test(low)&&!RE_UP.test(low);v=cur+(down?-1:1)*def[4]*(isTime?2:1);how=down?"reduced":"increased"}
    if(v==null){ignored.push({text:c,why:"Found "+def[1].toLowerCase()+" but no amount or direction"});continue}
    const cl=clampTo(def,v);next[key]=cl;
    items.push({text:c,key,label:def[1],from:cur,to:cl,unit:def[5],clamped:Math.abs(cl-v)>1e-9,how})}
  const changes={};for(const it of items)changes[it.key]=next[it.key];
  return{items,ignored,changes}}
if(typeof module!=="undefined")module.exports={LEVERS,STRATEGIES,goalSeek,projectPlans,planAt,parseText,PROJ_MONTHS,leverCost};
