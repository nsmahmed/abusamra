// ===== Simulation engine (discrete-time, 1-minute ticks, tandem stages with blocking) =====
const PROFILE_RAW=[1,0.7,0.5,0.5,0.8,1.6,3.2,5.4,6.6,6.8,6.2,5.6,5.0,5.2,5.6,6.0,6.4,6.6,6.0,5.0,4.0,3.0,2.2,1.4];
const PSUM=PROFILE_RAW.reduce((a,b)=>a+b,0);
const PROFILE=PROFILE_RAW.map(v=>v/PSUM);
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const PLATE_MIX=[["KSA",44],["QAT",24],["KWT",7],["UAE",8],["OMN",5],["BHR",4],["JOR",4],["IRQ",2],["EGY",2]];
const PLATE_TOTAL=PLATE_MIX.reduce((a,b)=>a+b[1],0);
const LETTERS="ABDEGHJKLNRSTUVXZ";
// ===== Truck attributes (synthetic until declaration data is connected) =====
// o: origin (import: country of loading; export: destination), k: cargo, aeo: Authorized Economic Operator,
// pre: pre-arrival declaration filed, red: risk lane (red = physical inspection, green = no inspection).
// Red-lane odds scale with origin and cargo risk; AEO trucks carry 0.3x the risk. Normalised so that a non-AEO
// population is sent to inspection at p.inspShare on average.
const ORIGINS={import:[["KSA",38,0.8],["UAE",17,0.9],["TUR",8,1.25],["IND",7,1.3],["OMN",7,0.9],["CHN",6,1.4],["KWT",6,0.9],["JOR",6,1.2],["EGY",5,1.3]],
  export:[["KSA",45,0.9],["UAE",15,1.0],["KWT",10,1.0],["OMN",8,1.0],["JOR",8,1.2],["BHR",7,1.0],["IRQ",7,1.3]]};
const CARGO=[["Food and perishables",26,0.8],["Construction materials",22,0.9],["Consumer goods",20,1.0],["Machinery",9,1.0],["Vehicles and parts",9,1.15],["Chemicals",8,1.7],["Livestock and feed",6,0.7]];
const AEO_RISK=0.3,PRE_CLEAR=0.55;
const mixNorm=m=>{const T=m.reduce((a,b)=>a+b[1],0);return m.reduce((a,b)=>a+b[1]*b[2],0)/T};
const RISK_NORM={import:mixNorm(ORIGINS.import)*mixNorm(CARGO),export:mixNorm(ORIGINS.export)*mixNorm(CARGO)};
function pickW(m,r){const T=m.reduce((a,b)=>a+b[1],0);let x=r*T;for(let i=0;i<m.length;i++){if((x-=m[i][1])<0)return i}return m.length-1}
class Sim{
  constructor(flow,params,seed,opts={}){
    this.flow=flow;this.p={...params};this.rng=mulberry32(seed||1);this.t=0;this.nextId=1;
    this.active=new Map();this.byPlate=new Map();
    this.stages=flow.stages.map(d=>({def:d,occ:0,slots:[],queue:[],occInt:0,order:[]}));
    this.events=opts.events?[]:null;this.onEvent=opts.onEvent||null;this.records=[];
    this.win=opts.window||null;this.peakRoad=0;this.roadInt=0;this.series=[];this.released=0;
    // drive[j]: minutes of driving to reach stage j (set by the app from the georeferenced routes; 0 in node tests)
    this.drive=opts.drive||flow.drive||null;
    this.pull=flow.stages.map(d=>d.pullTo?flow.stages.findIndex(x=>x.key===d.pullTo):-1);this.res=flow.stages.map(()=>0);
  }
  cap(i){const c=this.flow.stages[i].cap(this.p);return c}
  gauss(){let u=0;while(u===0)u=this.rng();const v=this.rng();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)}
  poisson(l){if(l<=0)return 0;if(l<30){const L=Math.exp(-l);let k=0,p=1;do{k++;p*=this.rng()}while(p>L);return k-1}return Math.max(0,Math.round(l+Math.sqrt(l)*this.gauss()))}
  svc(i,tr){const d=this.flow.stages[i];let [m,cv]=d.svc(this.p);if(d.mul&&tr.a)m*=d.mul(this.p,tr.a);if(m<=0)return 0;if(cv<=0)return m;const s2=Math.log(1+cv*cv);const mu=Math.log(m)-s2/2;return Math.exp(mu+Math.sqrt(s2)*tr.u[i])}
  plate(){let r=this.rng()*PLATE_TOTAL,c="KSA";for(const [k,w] of PLATE_MIX){if((r-=w)<0){c=k;break}}
    const n=String(Math.floor(this.rng()*900000)+100000);
    if(c==="KSA"){const l=[0,1,2].map(()=>LETTERS[Math.floor(this.rng()*LETTERS.length)]).join("");return c+" "+n.slice(0,4)+" "+l}
    return c+" "+n.slice(0,c==="QAT"?6:5)}
  attrs(){const F=this.flow,p=this.p,O=ORIGINS[F.key]||ORIGINS.import;
    const o=pickW(O,this.rng()),k=pickW(CARGO,this.rng()),aeo=this.rng()<(p.aeoShare||0)/100,pre=this.rng()<(p.preShare||0)/100;
    const risk=O[o][2]*CARGO[k][2]/(RISK_NORM[F.key]||1)*(aeo?AEO_RISK:1);const red=this.rng()<Math.min(0.97,(p.inspShare||0)/100*risk);
    return{o,k,aeo,pre,red}}
  spawn(){
    const F=this.flow,p=this.p;const a=this.attrs();
    const route=F.stages.map(d=>{const u=this.rng();if(d.optional&&!d.optional(p))return false;if(d.pick)return d.pick(p,a);const sh=d.share?d.share(p):1;return u<sh});const uu=F.stages.map(()=>this.gauss());
    route[0]=true;let plate=this.plate();while(this.byPlate.has(plate))plate=plate.slice(0,-1)+LETTERS[(LETTERS.indexOf(plate.slice(-1))+1)%LETTERS.length];
    const tr={id:this.nextId++,plate,arr:this.t,stage:-1,slot:-1,readyAt:0,waiting:false,route,u:uu,log:[],res:-1,a};
    this.active.set(tr.id,tr);this.byPlate.set(plate,tr);this.move(tr,0);
  }
  nextStage(tr){const N=this.flow.stages.length;for(let j=tr.stage+1;j<N;j++)if(tr.route[j])return j;return N}
  leave(tr){if(tr.stage<0)return;const S=this.stages[tr.stage];S.occ--;if(S.def.kind==="road"){const k=S.order.indexOf(tr);if(k>=0)S.order.splice(k,1)}else if(tr.slot>=0)S.slots[tr.slot]=null}
  move(tr,j){
    this.leave(tr);const S=this.stages[j];S.occ++;
    if(S.def.kind==="road"){S.order.push(tr);tr.slot=-1}else{let k=S.slots.indexOf(null);if(k<0){k=S.slots.length;S.slots.push(tr)}else S.slots[k]=tr;tr.slot=k}
    if(tr.res===j){this.res[j]--;tr.res=-1}
    const dr=this.drive&&j>0?this.drive[j]||0:0;
    tr.stage=j;tr.moveT=this.t;tr.arrT=this.t+dr;tr.readyAt=tr.arrT+this.svc(j,tr);tr.waiting=false;tr.log.push([j,this.t]);
    if(S.def.alpr){const e={t:this.t,plate:tr.plate,stage:j};if(this.events){this.events.push(e);if(this.events.length>20000)this.events.splice(0,5000)}if(this.onEvent)this.onEvent(e,tr)}
  }
  release(tr){this.leave(tr);tr.stage=-1;tr.out=this.t;tr.log.push([-1,this.t]);this.active.delete(tr.id);this.byPlate.delete(tr.plate);this.records.push({arr:tr.arr,out:tr.out});this.released++;
    if(this.onEvent)this.onEvent({t:this.t,plate:tr.plate,stage:-1},tr);
    if(this.records.length>30000&&!this.win)this.records.splice(0,10000)}
  step(){
    const t=this.t,p=this.p,N=this.flow.stages.length;const h=Math.floor(t/60)%24;
    const n=this.poisson(p.daily*(1+p.surge/100)*PROFILE[h]/60);for(let k=0;k<n;k++)this.spawn();
    for(const tr of this.active.values()){if(tr.waiting||tr.readyAt>t)continue;const j=this.nextStage(tr);if(j>=N){this.release(tr);continue}
      // pull admission: stay in the buffer lot until the downstream lot has a slot nobody has claimed yet
      const k=this.pull[tr.stage];if(k>=0){const Sj=this.stages[j];if(Sj.occ+Sj.queue.length>=this.cap(j))continue;
        if(tr.route[k]){if(this.stages[k].occ+this.res[k]>=this.cap(k))continue;this.res[k]++;tr.res=k}}
      tr.waiting=true;this.stages[j].queue.push(tr)}
    for(let j=N-1;j>=0;j--){const S=this.stages[j];const c=this.cap(j);while(S.queue.length&&S.occ<c){this.move(S.queue.shift(),j)}}
    const inWin=!this.win||(t>=this.win[0]&&t<this.win[1]);
    if(inWin){for(const S of this.stages)S.occInt+=S.occ;const r=this.roadWaiting();this.roadInt+=r;if(r>this.peakRoad)this.peakRoad=r}
    if(this.win&&t%60===0&&t>=this.win[0]&&t<this.win[1])this.series.push({h:(t-this.win[0])/60,road:this.roadWaiting(),park:this.stages[this.flow.parkIdx].occ});
    this.t++;
  }
  roadWaiting(){// trucks on the public road that are queued (not just driving)
    const S=this.stages[0];let n=0;for(const tr of S.order)if(tr.waiting)n++;
    // trucks blocked at the first gate also block the road
    return n}
}
function forecast(flow,params,seed){
  const W=[1440,2880];const s=new Sim(flow,params,seed||7,{window:W});
  for(let i=0;i<4320;i++)s.step();
  const times=[];let cleared=0;
  for(const r of s.records){if(r.arr>=W[0]&&r.arr<W[1])times.push(r.out-r.arr);if(r.out>=W[0]&&r.out<W[1])cleared++}
  for(const tr of s.active.values())if(tr.arr>=W[0]&&tr.arr<W[1])times.push(4320-tr.arr);
  times.sort((a,b)=>a-b);const avg=times.reduce((a,b)=>a+b,0)/Math.max(1,times.length);
  const p90=times.length?times[Math.floor(times.length*0.9)]:0;
  const util=s.stages.map((S,i)=>{const c=s.cap(i);if(!isFinite(c)||c<=0)return null;return S.occInt/(c*(W[1]-W[0]))});
  let bi=-1,bu=-1;for(let i=util.length-1;i>=0;i--){if(util[i]!=null&&util[i]>0.85){bi=i;bu=util[i];break}}
  if(bi<0)util.forEach((u,i)=>{if(u!=null&&u>bu){bu=u;bi=i}});
  const idleH=s.roadInt/60;
  return{avgH:avg/60,p90H:p90/60,cleared,peakRoad:s.peakRoad,queueKm:s.peakRoad*0.02,idleH,co2t:idleH*8/1000,util,bottleneck:bi,bottleneckUtil:bu,series:s.series,arrivals:times.length};
}
if(typeof module!=="undefined")module.exports={Sim,forecast,PROFILE,ORIGINS,CARGO,PRE_CLEAR};
