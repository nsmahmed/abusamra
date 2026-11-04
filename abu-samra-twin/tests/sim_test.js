const {Sim,forecast}=require('../src/sim.js');const {IMPORT,EXPORT}=require('../src/flows.js');
for(const F of [IMPORT,EXPORT]){
  let t0=Date.now();const r=forecast(F,F.defaults,7);console.log(F.key,"ms",Date.now()-t0);
  console.log(JSON.stringify({avgH:r.avgH.toFixed(2),p90:r.p90H.toFixed(2),cleared:r.cleared,peakRoad:r.peakRoad,idleH:r.idleH.toFixed(0),bott:F.stages[r.bottleneck].key,bu:r.bottleneckUtil.toFixed(2),util:r.util.map(u=>u==null?null:+u.toFixed(2)),arr:r.arrivals}));
}
const F=IMPORT;
for(const ch of [{xrayLanes:4},{surge:40},{holdCap:200},{aeoShare:50},{preShare:80},{inspShare:30},{apptGates:2}]){const r=forecast(F,{...F.defaults,...ch},7);console.log(JSON.stringify(ch),r.avgH.toFixed(2),r.peakRoad,r.cleared,F.stages[r.bottleneck].key)}
const E=EXPORT;
for(const ch of [{permitGates:2},{parking:24},{surge:40},{ramps:14}]){const r=forecast(E,{...E.defaults,...ch},7);console.log("exp",JSON.stringify(ch),r.avgH.toFixed(2),r.peakRoad,r.cleared,E.stages[r.bottleneck].key)}
console.log("noise");for(const sd of [7,8,9]){const a=forecast(E,E.defaults,sd),b=forecast(E,{...E.defaults,ramps:14},sd);console.log(sd,a.avgH.toFixed(2),b.avgH.toFixed(2))}
for(const sd of [7,8]){const a=forecast(F,F.defaults,sd),b=forecast(F,{...F.defaults,ramps:150},sd);console.log(sd,a.avgH.toFixed(2),b.avgH.toFixed(2))}
// text to map
const {parseText}=require('../src/plan.js');const SL={xrayLanes:[1,12,1,""],clearMin:[30,300,10," min"],parking:[200,800,50,""],aeoShare:[0,90,2,"%"]};
const sd=(f,k)=>SL[k]?[k,k,...SL[k]]:null;
const r=parseText("Add 2 X-ray lanes, cut clearance time by 30 minutes and expand main parking by 100 slots. Paint the gates blue.","import",F.defaults,sd);
console.log("ttm",JSON.stringify(r.changes),r.ignored.length,"ignored");
