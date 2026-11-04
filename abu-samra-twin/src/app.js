// ===== World mapping: mosaic pixels (0.8 m/px) -> world units (1 unit = 10 m) =====
const ILLUS=true; // illustrated ground (the satellite variant was retired)
const K=0.08,CX=TEXINFO.W/2,CY=TEXINFO.H/2,PADX=TEXINFO.PAD;
const conv=p=>[(p[0]-CX)*K,(p[1]-CY)*K];
const W2=p=>{const [x,z]=conv(p);return{x,z}};
const addPx=(o,e,a,r,b)=>[o[0]+e[0]*a+r[0]*b,o[1]+e[1]*a+r[1]*b];
const BLD=GEOJ.buildings;
const GEO={import:GEOJ.import,export:GEOJ.export};
GEO.import.st.ramps.shedPolys=BLD.filter(b=>b.role==="ramps_import").map(b=>b.poly);
GEO.export.st.ramps.shedPolys=BLD.filter(b=>b.role==="ramps_export").map(b=>b.poly);
// [key, label, min, max, step, unit]
const SLIDERS={
  import:[
    ["Demand",[["daily","Trucks per day",300,2000,50,""],["surge","Demand surge (Eid, season)",-30,80,5,"%"]]],
    ["Gates and lanes",[["radLanes","Radiation portal lanes",1,6,1,""],["apptGates","Appointment check gates",1,8,1,""],["xrayLanes","X-ray scanning slots",1,12,1,""],["relGates","Release gate lanes",1,6,1,""]]],
    ["Parking and ramps",[["holdCap","External parking slots",0,140,10,""],["parking","Main parking slots",200,800,50,""],["ramps","Inspection ramps",20,200,10,""]]],
    ["Time at each stage",[["radMin","Radiation portal scan",0.5,5,0.5," min"],["apptMin","Appointment check",1,10,0.5," min"],["clearMin","Clearance, no pre-arrival filing",30,300,10," min"],["xrayMin","X-ray scan",2,10,0.5," min"],["inspMin","Physical inspection",30,300,10," min"],["relMin","Release check",1,6,0.5," min"]]],
    ["Risk and programmes",[["inspShare","Red-lane rate, non-AEO trucks",5,80,2,"%"],["aeoShare","Trucks run by AEO operators",0,90,2,"%"],["preShare","Pre-arrival declarations filed",0,100,5,"%"]]]
  ],
  export:[
    ["Demand",[["daily","Trucks per day",200,1200,50,""],["surge","Demand surge (Eid, season)",-30,80,5,"%"]]],
    ["Gates and lanes",[["permitGates","Permit gates",1,4,1,""],["entryGates","Entry check gates",1,6,1,""],["relGates","Release gate lanes",1,4,1,""]]],
    ["Parking and ramps",[["extPark","External parking slots",50,220,10,""],["parking","Operational parking slots",6,24,1,""],["ramps","Inspection ramps",4,24,1,""]]],
    ["Time at each stage",[["docMin","Document wait, no pre-arrival filing",15,180,2," min"],["permitMin","Permit gate check",1,8,0.5," min"],["entryMin","Entry gate check",1,8,0.5," min"],["parkMin","Operational parking dwell",5,60,5," min"],["inspMin","Physical inspection",20,180,10," min"],["relMin","Release check",1,6,0.5," min"]]],
    ["Risk and programmes",[["inspShare","Red-lane rate, non-AEO trucks",5,80,2,"%"],["aeoShare","Trucks run by AEO operators",0,90,2,"%"],["preShare","Pre-arrival declarations filed",0,100,5,"%"]]]
  ]
};
// which stage each parameter belongs to (for callouts and fly-to)
const PARAM_STAGE={radLanes:"rad",apptGates:"appt",xrayLanes:"xray",relGates:"rel",holdCap:"hold",parking:"park",ramps:"ramps",permitGates:"permit",entryGates:"entry",extPark:"ext",
  radMin:"rad",apptMin:"appt",clearMin:"park",xrayMin:"xray",inspShare:"ramps",inspMin:"ramps",relMin:"rel",docMin:"ext",permitMin:"permit",entryMin:"entry",parkMin:"park",
  aeoShare:"ramps",preShare:"park"};
const stageOfParam=(f,k)=>k==="preShare"&&f==="export"?"ext":PARAM_STAGE[k];
const CAPACITY_KEYS={import:["xrayLanes","apptGates","radLanes","holdCap","parking","ramps","relGates"],export:["permitGates","entryGates","extPark","parking","ramps","relGates"]};
const UNIT_NOUN={radLanes:"portal lanes",apptGates:"check gates",xrayLanes:"X-ray slots",relGates:"release lanes",holdCap:"parking slots",parking:"parking slots",ramps:"inspection ramps",permitGates:"permit gates",entryGates:"entry gates",extPark:"parking slots"};
const FLOWS={import:IMPORT,export:EXPORT};
const sliderDef=(flow,key)=>{for(const [,items] of SLIDERS[flow])for(const it of items)if(it[0]===key)return it;return null};
const V_DRIVE=41.7; // driving speed inside the port, world units per simulated minute (25 km/h)
const LANE=0.17;    // trucks keep to the right-hand lane, 1.7 m right of the route centreline

// ===== State =====
const store={get(k,d){try{const v=localStorage.getItem("ast:"+k);return v==null?d:JSON.parse(v)}catch(e){return d}},set(k,v){try{localStorage.setItem("ast:"+k,JSON.stringify(v))}catch(e){}}};
const state={flow:"import",params:{import:{...IMPORT.defaults},export:{...EXPORT.defaults}},base:{import:{...IMPORT.defaults},export:{...EXPORT.defaults}},speed:2,tracked:null,baseFc:{},
  light:"auto",show:{labels:true,route:true,bays:true,status:false,lane:false,fly:true}};
let sim=null,G=null;
const $=id=>document.getElementById(id);
const fmtT=m=>{m=Math.floor(m);const h=Math.floor(m/60)%24,mm=m%60;return String(h).padStart(2,"0")+":"+String(mm).padStart(2,"0")};
const fmtH=h=>h>=10?h.toFixed(0)+" h":h.toFixed(1)+" h";
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function plateHTML(p){const [c,...rest]=p.split(" ");return `<span class="plate ${esc(c)}"><em>${esc(c)}</em><span>${esc(rest.join(" "))}</span></span>`}
function toast(msg){const t=$("toast");t.textContent=msg;t.classList.add("on");clearTimeout(toast._t);toast._t=setTimeout(()=>t.classList.remove("on"),2400)}

// ===== Path + geometry helpers =====
function offsetPts(pts,off){return pts.map((p,i)=>{const a=pts[Math.max(0,i-1)],b=pts[Math.min(pts.length-1,i+1)];let dx=b[0]-a[0],dz=b[1]-a[1];const L=Math.hypot(dx,dz)||1;dx/=L;dz/=L;return[p[0]-dz*off,p[1]+dx*off]})}
function buildPath(geo,off){let pts=geo.path.map(conv);if(off)pts=offsetPts(pts,off);const cum=[0];for(let i=1;i<pts.length;i++)cum.push(cum[i-1]+Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]));return{pts,cum,total:cum[cum.length-1]}}
function pointAt(P,d){const {pts,cum}=P;
  if(d<=0){const a=pts[0],b=pts[1],L=cum[1];const ux=(b[0]-a[0])/L,uz=(b[1]-a[1])/L;return{x:a[0]+ux*d,z:a[1]+uz*d,ang:Math.atan2(uz,ux)}}
  if(d>=P.total){const n=pts.length,a=pts[n-2],b=pts[n-1],L=cum[n-1]-cum[n-2];const ux=(b[0]-a[0])/L,uz=(b[1]-a[1])/L,e=d-P.total;return{x:b[0]+ux*e,z:b[1]+uz*e,ang:Math.atan2(uz,ux)}}
  let lo=0,hi=cum.length-1;while(hi-lo>1){const m=(lo+hi)>>1;if(cum[m]<=d)lo=m;else hi=m}
  const a=pts[lo],b=pts[hi];const f=(d-cum[lo])/((cum[hi]-cum[lo])||1);return{x:a[0]+(b[0]-a[0])*f,z:a[1]+(b[1]-a[1])*f,ang:Math.atan2(b[1]-a[1],b[0]-a[0])}}
// points along the path from d0 to d1 (inclusive ends); also handles extrapolation before the start / after the end
function pathSpan(P,d0,d1){const out=[pointAt(P,d0)];for(let i=0;i<P.pts.length;i++)if(P.cum[i]>d0+0.05&&P.cum[i]<d1-0.05)out.push({x:P.pts[i][0],z:P.pts[i][1]});out.push(pointAt(P,d1));return out}
function nearestD(P,x,z,d0,d1){let best=1e9,bd=d0;for(let i=0;i<P.pts.length;i++){const c=P.cum[i];if(c<d0||c>d1)continue;const q=(P.pts[i][0]-x)**2+(P.pts[i][1]-z)**2;if(q<best){best=q;bd=c}}return bd}
function inPoly(x,z,poly){let c=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const [xi,zi]=poly[i],[xj,zj]=poly[j];if(((zi>z)!==(zj>z))&&(x<(xj-xi)*(z-zi)/(zj-zi)+xi))c=!c}return c}
function shedFrame(polyPx){const p=polyPx.map(conv);let best=-1,bi=0;for(let i=0;i<4;i++){const a=p[i],b=p[(i+1)%4];const L=Math.hypot(b[0]-a[0],b[1]-a[1]);if(L>best){best=L;bi=i}}
  const a=p[bi],b=p[(bi+1)%4],c=p[(bi+2)%4],d=p[(bi+3)%4];
  const m1=[(a[0]+d[0])/2,(a[1]+d[1])/2],m2=[(b[0]+c[0])/2,(b[1]+c[1])/2];const hw=Math.hypot(d[0]-a[0],d[1]-a[1])/2;return{m1,m2,hw,L:best}}

// ===== Slot layouts with drive-in / drive-out manoeuvres =====
// Every slot: {x,z,rot, in:[waypoints before the slot], out:[waypoints after leaving], jin, jout}
// jin/jout: distance along the lane path where the truck leaves / rejoins the route. A waypoint with rev:true is
// reached by reversing (the truck keeps facing the other way), e.g. backing into a dock or out of a bay.
function stageSlots(flowKey,key,cap){
  const g=G.geo,P=G.LP,s=g.st[key];const out=[];if(!s||!isFinite(cap))return out;cap=Math.max(0,Math.round(cap));if(!cap)return out;
  const aD=P.cum[s.idx],eD=P.cum[s.exitIdx!=null?s.exitIdx:s.idx],a=pointAt(P,aD);
  if(s.layout==="lanes"){const nx=-Math.sin(a.ang),nz=Math.cos(a.ang),fx=Math.cos(a.ang),fz=Math.sin(a.ang);
    for(let k=0;k<cap;k++){const o=(k-(cap-1)/2)*0.58-LANE;const x=a.x+nx*o,z=a.z+nz*o;
      out.push({x,z,rot:a.ang,in:[{x:x-fx*1.6,z:z-fz*1.6}],out:[{x:x+fx*1.8,z:z+fz*1.8}],jin:aD-2.4,jout:aD+2.6})}return out}
  if(s.layout==="lot"){const L=s.lot,TL=21,AIS=30,len=L.bays*L.bayPitch;const rot=Math.atan2(-L.r[1],-L.r[0]);
    const front0=addPx(L.o,L.e,-16,L.r,-14),front1=addPx(L.o,L.e,len+16,L.r,-14);const far=Math.hypot(L.exit[0]-front1[0],L.exit[1]-front1[1])<Math.hypot(L.exit[0]-front0[0],L.exit[1]-front0[1]);
    for(let r=0;r<L.rows&&out.length<cap;r++)for(let b=0;b<L.bays&&out.length<cap;b++){const al=(b+0.5)*L.bayPitch,ra=r*L.rowPitch+AIS;
      const c=W2(addPx(L.o,L.e,al,L.r,r*L.rowPitch+TL/2));
      const inW=[W2(L.entry),W2(front0),W2(addPx(L.o,L.e,-16,L.r,ra)),W2(addPx(L.o,L.e,al-16,L.r,ra))];
      const outW=[{...W2(addPx(L.o,L.e,al,L.r,ra)),rev:true},W2(addPx(L.o,L.e,len+16,L.r,ra)),W2(front1)];if(!far)outW.push(W2(front0));outW.push(W2(L.exit));
      out.push({x:c.x,z:c.z,rot,in:inW,out:outW,jin:aD,jout:eD})}
    return out}
  if(s.layout==="bays"){// main import lot: angled bays on the fitted row lattice; trucks face west, enter from the SE edge and leave at the NW edge
    const lot=s.polys[0],S=(k,u)=>s.phase+s.tilt*u+s.pitch*k,pos=(k,u)=>addPx(s.o,s.e,S(k,u),s.r,u);
    const inside=p=>inPoly(p[0],p[1],lot);const uRange=k=>{let lo=null,hi=null;for(let u=0;u<480;u+=3){if(inside(pos(k,u))){if(lo==null)lo=u;hi=u}}return[lo,hi]};
    const Lp=(s.pitch/2)/0.758;let bay=s.bay,cand=[];
    for(let att=0;att<5;att++){cand=[];for(let k=0;k<22;k++)for(let u=8;u<480;u+=bay){const c=pos(k,u);if(inside(c)&&inside([c[0]-13,c[1]])&&inside([c[0]+13,c[1]]))cand.push({k,u,c})}if(cand.length>=cap)break;bay*=0.86}
    cand.sort((p,q)=>Math.hypot(p.c[0]-s.entry[0],p.c[1]-s.entry[1])-Math.hypot(q.c[0]-s.entry[0],q.c[1]-s.entry[1]));
    for(const {k,u,c} of cand.slice(0,cap)){const up=uRange(k+0.5),dn=uRange(k-0.5);const A=[c[0]+Lp,c[1]],uA=(A[0]-s.o[0])*s.r[0]+(A[1]-s.o[1])*s.r[1];
      const cw=W2(c);const inW=[W2(s.entry)];if(up[1]!=null)inW.push(W2(pos(k+0.5,up[1]-4)));inW.push(W2(pos(k+0.5,Math.min(uA+14,up[1]!=null?up[1]-4:uA+14))));
      const outW=[W2([c[0]-Lp,c[1]])];if(dn[0]!=null)outW.push(W2(pos(k-0.5,dn[0]+4)));outW.push(W2(s.exit));
      out.push({x:cw.x,z:cw.z,rot:Math.PI,in:inW,out:outW,jin:aD,jout:eD})}
    return out}
  if(s.layout==="along"){const d0=P.cum[s.fromIdx],d1=P.cum[s.toIdx];let k=0,row=0;while(out.length<cap&&row<4){const d=d0+1.4+k*2.3;if(d>d1-1){k=0;row++;continue}
      const p=pointAt(P,d);const nx=-Math.sin(p.ang),nz=Math.cos(p.ang),fx=Math.cos(p.ang),fz=Math.sin(p.ang);const o=0.5+row*0.45;const x=p.x+nx*o,z=p.z+nz*o;
      out.push({x,z,rot:p.ang,in:[{x:x-fx*1.4-nx*0.35,z:z-fz*1.4-nz*0.35}],out:[{x:x+fx*1.6-nx*0.4,z:z+fz*1.6-nz*0.4}],jin:d-2.6,jout:d+2.6});k++}return out}
  if(s.layout==="sheds"){const frames=s.shedPolys.map(shedFrame);let ring=0;
    while(out.length<cap&&ring<4){for(const f of frames){const ux=(f.m2[0]-f.m1[0])/f.L,uz=(f.m2[1]-f.m1[1])/f.L,nx=-uz,nz=ux;
      for(const side of [1,-1])for(let t=0.3;t<f.L-0.2&&out.length<cap;t+=0.44){const o=side*(f.hw+0.9+ring*2.4);const x=f.m1[0]+ux*t+nx*o,z=f.m1[1]+uz*t+nz*o;
        const ox=nx*side,oz=nz*side,Px=x+ox*2.1,Pz=z+oz*2.1;
        const jin=nearestD(P,Px,Pz,aD,eD);const jp=pointAt(P,jin);const dir=Math.sign((Px-jp.x)*ux+(Pz-jp.z)*uz)||1;// approach along the apron from the join side
        out.push({x,z,rot:Math.atan2(oz,ox),in:[{x:Px-ux*dir*1.6,z:Pz-uz*dir*1.6},{x:Px+ux*dir*0.6,z:Pz+uz*dir*0.6},{x:x+ox*0.4,z:z+oz*0.4,rev:true}],revLast:true,
          out:[{x:Px,z:Pz}],jin,jout:Math.max(jin,nearestD(P,Px,Pz,jin,eD))})}}ring++}
    return out}
  return out;
}

// ===== Three.js scene =====
const M4=new THREE.Matrix4(),Q=new THREE.Quaternion(),S1=new THREE.Vector3(1,1,1),SV=new THREE.Vector3(),YA=new THREE.Vector3(0,1,0),PV=new THREE.Vector3();
const stageEl=$("stage");
const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:"high-performance"});
renderer.setPixelRatio(Math.min(2,window.devicePixelRatio||1));
renderer.outputEncoding=THREE.sRGBEncoding;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
stageEl.prepend(renderer.domElement);
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(36,1,0.2,4000);
const controls=new THREE.OrbitControls(camera,renderer.domElement);
controls.enableDamping=true;controls.maxPolarAngle=1.45;controls.minDistance=3;controls.maxDistance=600;controls.screenSpacePanning=false;
const hemi=new THREE.HemisphereLight(0xDCE9F2,0x9C8462,0.7);scene.add(hemi);
const sun=new THREE.DirectionalLight(0xFFF1DA,0.75);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);
Object.assign(sun.shadow.camera,{left:-110,right:110,top:110,bottom:-110,near:10,far:700});sun.shadow.bias=-0.0006;sun.shadow.normalBias=0.02;
scene.add(sun);scene.add(sun.target);
const EDGE=new THREE.Color().setRGB(TEXINFO.edge[0]/255,TEXINFO.edge[1]/255,TEXINFO.edge[2]/255).convertSRGBToLinear();
scene.fog=new THREE.Fog(0xC9D6DC,260,1100);
// sky dome
const skyGeo=new THREE.SphereGeometry(2000,32,16);const skyCol=new Float32Array(skyGeo.attributes.position.count*3);skyGeo.setAttribute("color",new THREE.BufferAttribute(skyCol,3));
const sky=new THREE.Mesh(skyGeo,new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.BackSide,fog:false,depthWrite:false}));scene.add(sky);
// ground: real imagery
const TW=(TEXINFO.W+2*PADX)*K,TH=(TEXINFO.H+2*PADX)*K;
const groundTex=new THREE.TextureLoader().load(GROUND_URI);
groundTex.encoding=THREE.sRGBEncoding;groundTex.anisotropy=renderer.capabilities.getMaxAnisotropy();
const groundMat=new THREE.MeshLambertMaterial({map:groundTex});
const ground=new THREE.Mesh(new THREE.PlaneGeometry(TW,TH),groundMat);ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
const outer=new THREE.Mesh(new THREE.RingGeometry(Math.max(TW,TH)*0.55,3500,64),new THREE.MeshLambertMaterial({color:new THREE.Color().setRGB(TEXINFO.edge[0]/255*0.96,TEXINFO.edge[1]/255*0.94,TEXINFO.edge[2]/255*0.92)}));
outer.rotation.x=-Math.PI/2;outer.position.y=-0.03;scene.add(outer);
// fill the square corners between texture and ring with sand
const under=new THREE.Mesh(new THREE.PlaneGeometry(Math.max(TW,TH)*1.2,Math.max(TW,TH)*1.2),outer.material);under.rotation.x=-Math.PI/2;under.position.y=-0.04;scene.add(under);
// high-resolution imagery tiles (~0.6 m/texel) over the port, oriented along the facility, alpha-feathered into the base
const texLoader=new THREE.TextureLoader();
const HR=(TEXINFO.tiles||[]).map(t=>{const p00=t.p00,du=[t.p10[0]-p00[0],t.p10[1]-p00[1]],dv=[t.p01[0]-p00[0],t.p01[1]-p00[1]];
  const corners=[p00,t.p10,[t.p10[0]+dv[0],t.p10[1]+dv[1]],t.p01].map(conv);
  const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(corners.flatMap(([x,z])=>[x,0,z]),3));
  g.setAttribute("uv",new THREE.Float32BufferAttribute([0,1,1,1,1,0,0,0],2));g.setAttribute("normal",new THREE.Float32BufferAttribute([0,1,0,0,1,0,0,1,0,0,1,0],3));const [a,b,c]=corners;g.setIndex((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])>0?[0,2,1,0,3,2]:[0,1,2,0,2,3]);
  const map=texLoader.load(HR_URIS[t.file]);map.encoding=THREE.sRGBEncoding;map.anisotropy=renderer.capabilities.getMaxAnisotropy();
  const alphaMap=texLoader.load(HR_URIS[t.mask]);
  const mat=new THREE.MeshLambertMaterial({map,alphaMap,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});
  const m=new THREE.Mesh(g,mat);m.receiveShadow=true;m.renderOrder=-2;scene.add(m);
  return{p00,du,dv,L2u:du[0]**2+du[1]**2,L2v:dv[0]**2+dv[1]**2,map,roof:new THREE.MeshLambertMaterial({map,side:THREE.DoubleSide})}});
const baseUV=(x,z)=>[(x/K+CX+PADX)/(TEXINFO.W+2*PADX),1-(z/K+CY+PADX)/(TEXINFO.H+2*PADX)];
// fractional position inside a tile (null when outside)
function tileUV(t,x,z){const px=x/K+CX-t.p00[0],py=z/K+CY-t.p00[1];const a=(px*t.du[0]+py*t.du[1])/t.L2u,b=(px*t.dv[0]+py*t.dv[1])/t.L2v;return a>0.002&&a<0.998&&b>0.002&&b<0.998?[a,1-b]:null}
function roofTile(pts){const c=pts.reduce((s,p)=>[s[0]+p[0]/pts.length,s[1]+p[1]/pts.length],[0,0]);return HR.find(t=>pts.every(p=>tileUV(t,p[0],p[1]))&&tileUV(t,c[0],c[1]))||null}

// ===== Static structures from footprints (roofs textured from imagery, procedural facades) =====
const statics=new THREE.Group();scene.add(statics);
function canvasTex(w,h,draw){const c=document.createElement("canvas");c.width=w;c.height=h;const g=c.getContext("2d");draw(g,w,h);
  const d=g.getImageData(0,0,w,h);for(let i=0;i<d.data.length;i+=4){const n=(Math.random()-0.5)*9;d.data[i]+=n;d.data[i+1]+=n;d.data[i+2]+=n}g.putImageData(d,0,0);
  const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.encoding=THREE.sRGBEncoding;t.anisotropy=8;return t}
// texture world sizes [u, v] in units (1 unit = 10 m)
const FACADE={
  bld:{size:[2.4,1.2],tex:canvasTex(256,256,(g,w,h)=>{g.fillStyle=ILLUS?"#F1EEE8":"#E4DACA";g.fillRect(0,0,w,h);
    for(let f=0;f<3;f++){const y=h-(f+1)*85+24;g.fillStyle=ILLUS?"#5D7C93":"#34424C";g.fillRect(0,y,w,36);g.fillStyle=ILLUS?"#9CC0D6":"#5E7480";g.fillRect(0,y,w,7);
      g.fillStyle="#D8CDB9";for(let x=0;x<w;x+=32)g.fillRect(x,y,6,36);g.fillStyle="#C9BDA7";g.fillRect(0,y+36,w,4)}
    g.fillStyle="#CDBFA8";g.fillRect(0,0,w,10)})},
  tower:{size:[1.6,1.2],tex:canvasTex(128,256,(g,w,h)=>{g.fillStyle="#E8E2D6";g.fillRect(0,0,w,h);
    for(let f=0;f<4;f++){const y=h-(f+1)*64+12;g.fillStyle="#2E3D48";g.fillRect(6,y,w-12,42);g.fillStyle="#557080";g.fillRect(6,y,w-12,8);g.fillStyle="#E0D8CA";for(let x=6;x<w;x+=24)g.fillRect(x,y,4,42)}})},
  shed:{size:[3.2,1.2],tex:canvasTex(256,128,(g,w,h)=>{g.fillStyle="#DDDEDB";g.fillRect(0,0,w,h);g.fillStyle="#C3C6C4";for(let x=0;x<w;x+=8)g.fillRect(x,0,3,h);
    g.fillStyle="#B8B2A5";g.fillRect(0,h-16,w,16);g.fillStyle="#A2A7AA";g.fillRect(0,0,w,6)})},
  canopy:{size:[2.0,0.1],tex:canvasTex(128,32,(g,w,h)=>{g.fillStyle="#F0EFEA";g.fillRect(0,0,w,h);g.fillStyle="#8A1538";g.fillRect(0,13,w,7);g.fillStyle="#C8C8C2";g.fillRect(0,h-3,w,3)})}};
function litWindows(w,h,floors,fh,y0,bay,inset){return canvasTex(w,h,(g)=>{g.fillStyle="#000";g.fillRect(0,0,w,h);
  for(let f=0;f<floors;f++)for(let x=inset;x<w;x+=bay){if(Math.random()<0.45)continue;const t=Math.random();g.fillStyle=t<0.7?"#FFD9A0":"#CFE3FF";g.fillRect(x+3,h-(f+1)*fh+y0+6,bay-9,fh*0.38)}})}
FACADE.bld.glow=litWindows(256,256,3,85,24,32,6);FACADE.tower.glow=litWindows(128,256,4,64,12,24,6);
const wallMats={};for(const k in FACADE)wallMats[k]=new THREE.MeshLambertMaterial({map:FACADE[k].tex,vertexColors:true,side:THREE.DoubleSide,emissiveMap:FACADE[k].glow||null,emissive:0x000000});
const underMat=new THREE.MeshLambertMaterial({color:0x8E918F,emissive:0x000000});
function extrude(polyPx,h,kind,uvf){
  const p=polyPx.map(conv);const n=p.length;const pos=[],uv=[],col=[],idx=[];const F=FACADE[kind]||FACADE.bld;
  const canopy=kind==="canopy",y0=canopy?h-0.1:0,roofY=kind==="bld"||kind==="tower"?h-0.07:h;let cum=0;
  for(let i=0;i<n;i++){const a=p[i],b=p[(i+1)%n];const base=pos.length/3;const L=Math.hypot(b[0]-a[0],b[1]-a[1]);
    const shade=0.9+0.1*Math.abs(Math.cos(Math.atan2(b[1]-a[1],b[0]-a[0])+0.6));const u0=cum/F.size[0],u1=(cum+L)/F.size[0];cum+=L;
    pos.push(a[0],y0,a[1],b[0],y0,b[1],b[0],h,b[1],a[0],h,a[1]);const v1=canopy?1:(h-y0)/F.size[1];uv.push(u0,0,u1,0,u1,v1,u0,v1);
    for(let k=0;k<4;k++)col.push(shade,shade,shade);idx.push(base,base+2,base+1,base,base+3,base+2)}
  const wallCount=idx.length;
  const rb=pos.length/3;for(const [x,z] of p){pos.push(x,roofY,z);const t=uvf(x,z);uv.push(t[0],t[1]);col.push(1,1,1)}
  for(let i=1;i<n-1;i++)idx.push(rb,rb+i+1,rb+i);const roofCount=idx.length-wallCount;
  if(canopy){const ub=pos.length/3;for(const [x,z] of p){pos.push(x,y0,z);uv.push(0,0);col.push(1,1,1)}for(let i=1;i<n-1;i++)idx.push(ub,ub+i,ub+i+1)}
  const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));g.setAttribute("uv",new THREE.Float32BufferAttribute(uv,2));g.setAttribute("color",new THREE.Float32BufferAttribute(col,3));
  g.setIndex(idx);g.computeVertexNormals();g.addGroup(0,wallCount,0);g.addGroup(wallCount,roofCount,1);if(canopy)g.addGroup(wallCount+roofCount,idx.length-wallCount-roofCount,2);
  return g}
const roofMat=new THREE.MeshLambertMaterial({map:groundTex,side:THREE.DoubleSide});
function rectFrame(poly){const p=poly.map(conv);const e1=Math.hypot(p[1][0]-p[0][0],p[1][1]-p[0][1]),e2=Math.hypot(p[2][0]-p[1][0],p[2][1]-p[1][1]);
  const c=[(p[0][0]+p[2][0])/2,(p[0][1]+p[2][1])/2];const [a,b,L,W]=e1>=e2?[p[0],p[1],e1,e2]:[p[1],p[2],e2,e1];const ux=(b[0]-a[0])/L,uz=(b[1]-a[1])/L;return{c,ux,uz,vx:-uz,vz:ux,L,W}}
function buildStatics(){
  const pillars=[],domes=[];
  for(const b of BLD){const h=b.h/10;const kind=FACADE[b.k]?b.k:"bld";const tl=roofTile(b.poly.map(conv));
    const g=extrude(b.poly,h,kind,tl?(x,z)=>tileUV(tl,x,z):baseUV);
    const m=new THREE.Mesh(g,[wallMats[kind],tl?tl.roof:roofMat,underMat]);m.castShadow=true;m.receiveShadow=true;statics.add(m);
    const f=rectFrame(b.poly);
    if(kind==="canopy"){// pillar grid under the canopy
      const nu=Math.max(2,Math.round(f.L/1.3)+1),nv=Math.max(2,Math.round(f.W/1.5)+1);
      for(let i=0;i<nu;i++)for(let j=0;j<nv;j++){const s=(i/(nu-1)-0.5)*(f.L-0.12),t=(j/(nv-1)-0.5)*(f.W-0.1);pillars.push([f.c[0]+f.ux*s+f.vx*t,f.c[1]+f.uz*s+f.vz*t,h-0.1])}}
    if(b.dome)for(const s of [-0.28,0.28])domes.push([f.c[0]+f.ux*s*f.L,f.c[1]+f.uz*s*f.L,h-0.07,Math.min(f.W*0.38,0.6)]);
    if(kind==="shed"){// dock doors along both long sides
      const sf=shedFrame(b.poly);const ux=(sf.m2[0]-sf.m1[0])/sf.L,uz=(sf.m2[1]-sf.m1[1])/sf.L,nx=-uz,nz=ux;const ang=Math.atan2(uz,ux);
      for(const side of [1,-1])for(let t=0.3;t<sf.L-0.2;t+=0.44){const x=sf.m1[0]+ux*t+nx*side*(sf.hw+0.006),z=sf.m1[1]+uz*t+nz*side*(sf.hw+0.006);statics.add(Object.assign(box(0.3,0.38,0.012,0x4E585C,x,0.19,z,-ang),{castShadow:false}))}}
  }
  if(pillars.length){const im=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03,0.035,1,8),new THREE.MeshLambertMaterial({color:0xD9D9D4}),pillars.length);
    pillars.forEach(([x,z,ht],i)=>{M4.compose(PV.set(x,ht/2,z),Q.identity(),SV.set(1,ht,1));im.setMatrixAt(i,M4)});im.castShadow=true;statics.add(im)}
  for(const [x,z,y,r] of domes){const d=new THREE.Mesh(new THREE.SphereGeometry(r,24,12,0,Math.PI*2,0,Math.PI/2),new THREE.MeshPhongMaterial({color:0xEFE9DC,shininess:20}));d.position.set(x,y,z);d.castShadow=true;statics.add(d)}
  addVegetation();addLamps();
}
function box(w,h,d,color,x,y,z,rot,emissive){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshLambertMaterial({color,emissive:emissive||0}));m.position.set(x,y,z);if(rot)m.rotation.y=rot;m.castShadow=true;m.receiveShadow=true;return m}
// trees (palms + broadleaf) in the landscaped zones, low scrub in the desert, all detected from the imagery
function addVegetation(){
  const T=GEOJ.trees||[];if(!T.length)return;const rnd=i=>{const x=Math.sin(i*127.1+311.7)*43758.5453;return x-Math.floor(x)};
  const palm=[],broad=[],scrub=[];T.forEach((t,i)=>{const [x,z]=conv(t);(t[3]?(rnd(i)<0.45?palm:broad):scrub).push([x,z,t[2]*K,i])});
  const trunkG=new THREE.CylinderGeometry(0.018,0.026,1,6).translate(0,0.5,0);
  const frondParts=[];for(let k=0;k<9;k++){const a=k/9*Math.PI*2;const g=new THREE.BoxGeometry(0.26,0.008,0.05).translate(0.13,0,0).rotateZ(-0.35-0.15*(k%2)).rotateY(a).translate(0,1,0);frondParts.push([g,0x56693A])}
  frondParts.push([new THREE.SphereGeometry(0.035,6,4).translate(0,1,0),0x6E6A3C]);
  const frondG=mergeColored(frondParts);
  const crownG=new THREE.IcosahedronGeometry(1,1);{const P=crownG.attributes.position;for(let i=0;i<P.count;i++){const s=0.85+0.3*rnd(i+7);P.setXYZ(i,P.getX(i)*s,P.getY(i)*s*0.8,P.getZ(i)*s)}crownG.computeVertexNormals()}
  const tc=new THREE.Color();
  const mk=(geo,mat,arr,fn,cast)=>{if(!arr.length)return;const im=new THREE.InstancedMesh(geo,mat,arr.length);im.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(arr.length*3).fill(1),3);
    arr.forEach((a,i)=>{const c=fn(a,i);im.setMatrixAt(i,M4);if(c)im.setColorAt(i,c)});im.castShadow=cast;im.receiveShadow=true;statics.add(im)};
  const palmM=([x,z,,i],sx)=>M4.compose(PV.set(x,0,z),Q.setFromAxisAngle(YA,rnd(i+3)*6.28),SV.set(sx,0.55+0.3*rnd(i),sx));
  mk(trunkG,new THREE.MeshLambertMaterial({color:0x7A6448}),palm,a=>{palmM(a,1);return null},true);
  mk(frondG,new THREE.MeshLambertMaterial({vertexColors:true}),palm,a=>{palmM(a,1.1);return ILLUS?tc.setHSL(0.24,0.42,0.42+0.08*rnd(a[3]+5)):tc.setHSL(0.2,0.25,0.42+0.1*rnd(a[3]+5))},true);
  mk(trunkG,new THREE.MeshLambertMaterial({color:0x6A5A44}),broad,([x,z,r,i])=>{M4.compose(PV.set(x,0,z),Q.identity(),SV.set(1,0.22+0.1*rnd(i),1));return null},true);
  mk(crownG,new THREE.MeshLambertMaterial({color:0xffffff}),broad,([x,z,r,i])=>{const rr=Math.min(0.42,Math.max(0.16,r*1.1));M4.compose(PV.set(x,0.24+rr*0.75,z),Q.setFromAxisAngle(YA,rnd(i)*6.28),SV.set(rr,rr,rr));return ILLUS?tc.setHSL(0.26+0.04*rnd(i+1),0.42,0.33+0.08*rnd(i+2)):tc.setHSL(0.17+0.04*rnd(i+1),0.32,0.24+0.08*rnd(i+2))},true);
  mk(crownG,new THREE.MeshLambertMaterial({color:0xffffff}),scrub,([x,z,r,i])=>{const rr=Math.min(0.13,Math.max(0.05,r*0.6));M4.compose(PV.set(x,rr*0.35,z),Q.setFromAxisAngle(YA,rnd(i)*6.28),SV.set(rr,rr*0.7,rr));return tc.setHSL(0.13+0.03*rnd(i+1),0.22,0.3+0.08*rnd(i+2))},false);
}
// street lights (instanced) along both routes: 12 m poles with an arm reaching over the carriageway
let lampHeads=null,lampPools=null,lampGlow=null;
function radialTex(stops){const c=document.createElement("canvas");c.width=c.height=128;const g=c.getContext("2d");const gr=g.createRadialGradient(64,64,0,64,64,64);
  for(const [o,col] of stops)gr.addColorStop(o,col);g.fillStyle=gr;g.fillRect(0,0,128,128);const t=new THREE.CanvasTexture(c);t.encoding=THREE.sRGBEncoding;return t}
function addLamps(){
  const pts=[];for(const f of ["import","export"]){const P=buildPath(GEO[f]);for(let d=2;d<P.total-2;d+=5.5){const p=pointAt(P,d);const nx=-Math.sin(p.ang),nz=Math.cos(p.ang);const s=(Math.round(d/5.5)%2?1:-1);pts.push([p.x+nx*s*0.75,p.z+nz*s*0.75,Math.atan2(-nz*s,-nx*s)])}}
  const n=pts.length;const poles=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.014,0.024,1.2,6).translate(0,0.6,0),new THREE.MeshLambertMaterial({color:0x9AA1A4}),n);
  const arms=new THREE.InstancedMesh(new THREE.BoxGeometry(0.24,0.012,0.012).translate(0.12,1.19,0),poles.material,n);
  lampHeads=new THREE.InstancedMesh(new THREE.BoxGeometry(0.1,0.025,0.05).translate(0.24,1.175,0),new THREE.MeshBasicMaterial({color:0x666666}),n);
  lampPools=new THREE.InstancedMesh(new THREE.CircleGeometry(1.5,32),new THREE.MeshBasicMaterial({map:radialTex([[0,"rgba(255,214,150,0.9)"],[0.35,"rgba(255,190,110,0.45)"],[1,"rgba(255,170,80,0)"]]),transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false}),n);
  const Rx=new THREE.Matrix4().makeRotationX(-Math.PI/2);
  pts.forEach(([x,z,a],i)=>{M4.compose(PV.set(x,0,z),Q.setFromAxisAngle(YA,-a),S1);poles.setMatrixAt(i,M4);arms.setMatrixAt(i,M4);lampHeads.setMatrixAt(i,M4);
    M4.makeTranslation(x+Math.cos(a)*0.24,0.02,z+Math.sin(a)*0.24).multiply(Rx);lampPools.setMatrixAt(i,M4)});
  poles.castShadow=true;arms.castShadow=true;statics.add(poles);statics.add(arms);statics.add(lampHeads);statics.add(lampPools);
  const gp=new Float32Array(n*3);pts.forEach(([x,z,a],i)=>{gp[i*3]=x+Math.cos(a)*0.24;gp[i*3+1]=1.16;gp[i*3+2]=z+Math.sin(a)*0.24});
  const gg=new THREE.BufferGeometry();gg.setAttribute("position",new THREE.BufferAttribute(gp,3));
  lampGlow=new THREE.Points(gg,new THREE.PointsMaterial({map:radialTex([[0,"rgba(255,240,210,1)"],[0.2,"rgba(255,200,130,0.6)"],[1,"rgba(255,170,80,0)"]]),size:0.9,sizeAttenuation:true,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false}));statics.add(lampGlow);
}

// ===== Per-flow overlay: route, zones, capacity markings, gates =====
let world=new THREE.Group();scene.add(world);let decor=new THREE.Group();scene.add(decor);
function ribbon(pts,width,y,color,opacity){const pos=[],idx=[];const n=pts.length;
  for(let i=0;i<n;i++){const p=pts[i];const a=pts[Math.max(0,i-1)],b=pts[Math.min(n-1,i+1)];let dx=b[0]-a[0],dz=b[1]-a[1];const L=Math.hypot(dx,dz)||1;dx/=L;dz/=L;const nx=-dz*width/2,nz=dx*width/2;pos.push(p[0]+nx,y,p[1]+nz,p[0]-nx,y,p[1]-nz);if(i<n-1){const k=i*2;idx.push(k,k+1,k+2,k+1,k+3,k+2)}}
  const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);
  return new THREE.Mesh(g,new THREE.MeshBasicMaterial({color,transparent:true,opacity,side:THREE.DoubleSide,depthWrite:false}))}
function flatPoly(pts,y,color,opacity){const sh=new THREE.Shape(pts.map(p=>new THREE.Vector2(p[0],-p[1])));const g=new THREE.ShapeGeometry(sh);g.rotateX(-Math.PI/2);const m=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color,transparent:true,opacity,depthWrite:false}));m.position.y=y;return m}
const heat={};
function stagePolys(s){if(s.layout==="lot")return[s.lot.poly.map(conv)];if(s.layout==="bays")return s.polys.map(pl=>pl.map(conv));if(s.area)return[s.area.map(conv)];return null}
function stageJ(key){const s=G.geo.st[key],P=G.LP;const aD=P.cum[s.idx],eD=P.cum[s.exitIdx!=null?s.exitIdx:s.idx];return s.layout==="lanes"?[aD-2.4,aD+2.6]:s.layout==="along"?[P.cum[s.fromIdx],P.cum[s.toIdx]]:[aD,eD]}
// minutes of driving between consecutive stages, from the georeferenced route (fed into the simulation)
function computeDrive(){const st=G.flow.stages;const drv=st.map(()=>0);
  for(let j=1;j<st.length;j++){const [jin]=stageJ(st[j].key),[,jout]=stageJ(st[j-1].key);const man=st[j].kind==="buffer"||st[j].kind==="ramps"?6:1.5;drv[j]=Math.max(0.25,(Math.max(0,jin-jout)+man)/V_DRIVE)}
  G.flow.drive=drv;G.roadHead=stageJ(st[1].key)[0]-0.6}
function buildWorld(){
  scene.remove(world);world=new THREE.Group();scene.add(world);
  const geo=GEO[state.flow];G={geo,P:buildPath(geo,0),LP:buildPath(geo,LANE),flow:FLOWS[state.flow],slots:{},ver:1};const P=G.P;
  const route=new THREE.Group();route.name="route";
  route.add(ribbon(P.pts.slice(0,geo.opStart+1),0.14,0.05,0xF2BE2E,0.7));route.add(ribbon(P.pts.slice(geo.opStart),0.14,0.05,0x2FD39A,0.7));
  const chev=new THREE.ConeGeometry(0.09,0.24,3).rotateZ(-Math.PI/2);const cm1=new THREE.MeshBasicMaterial({color:0xF2BE2E}),cm2=new THREE.MeshBasicMaterial({color:0x2FD39A});
  for(let d=3;d<P.total;d+=7){const p=pointAt(P,d);const c=new THREE.Mesh(chev,d<P.cum[geo.opStart]?cm1:cm2);c.position.set(p.x,0.07,p.z);c.rotation.y=-p.ang;route.add(c)}
  for(const k in heat)delete heat[k];
  for(const [key,s] of Object.entries(geo.st)){const polys=stagePolys(s);if(!polys)continue;
    for(const pl of polys){const m=flatPoly(pl,0.035,0x2E9E78,0.06);(heat[key]=heat[key]||[]).push(m.material);route.add(m)}}
  world.add(route);route.visible=state.show.route;
  computeDrive();rebuildCapacity();buildLabels();buildStrip();userMoved=false;fitCamera();
}
// capacity markings: painted bays/docks for parking and ramps, lane booths for gates.
// Compared with the baseline: existing = white, added = gold, removed = red.
const C_EXIST=new THREE.Color(0xF4F1E8),C_NEW=new THREE.Color(0xFFB938),C_GONE=new THREE.Color(0xFF3B5C);
const bayTex=(()=>{const c=document.createElement("canvas");c.width=128;c.height=32;const g=c.getContext("2d");g.fillStyle="rgba(255,255,255,0.16)";g.fillRect(0,0,128,32);g.strokeStyle="#fff";g.lineWidth=4;g.strokeRect(2,2,124,28);return new THREE.CanvasTexture(c)})();
const bayGeo=new THREE.PlaneGeometry(1.8,0.38).rotateX(-Math.PI/2);
// X-ray scanning tunnel: an arched, drive-through tube along the lane (30 m long, 5.2 m wide, 5.6 m high)
const XR={L:3.0,W:0.52,H0:0.3};
function archShape(w,h0,t){const sh=new THREE.Shape(),r=w/2;sh.moveTo(-r,0);sh.lineTo(-r,h0);sh.absarc(0,h0,r,Math.PI,0,true);sh.lineTo(r,0);sh.lineTo(r-t,0);sh.lineTo(r-t,h0);sh.absarc(0,h0,r-t,0,Math.PI,false);sh.lineTo(-r+t,0);sh.closePath();return sh}
const tubeGeo=new THREE.ExtrudeGeometry(archShape(XR.W,XR.H0,0.035),{depth:XR.L,bevelEnabled:false,curveSegments:16}).translate(0,0,-XR.L/2).rotateY(Math.PI/2);
const ringGeo=new THREE.ExtrudeGeometry(archShape(XR.W+0.03,XR.H0,0.05),{depth:0.08,bevelEnabled:false,curveSegments:16}).translate(0,0,-0.04).rotateY(Math.PI/2);
const tubeMat=new THREE.MeshPhongMaterial({color:0xDDE1E3,shininess:40,specular:0x333333,transparent:true,opacity:0.72,side:THREE.DoubleSide,depthWrite:false});
const ringMat=new THREE.MeshLambertMaterial({color:0x8A1538}),warnMat=new THREE.MeshLambertMaterial({color:0xF2C14E});
function gateDecor(st,s,c,cb){
  const P=G.P;const a=pointAt(P,P.cum[s.idx]);const n=Math.max(c,cb,1);const nx=-Math.sin(a.ang),nz=Math.cos(a.ang),fx=Math.cos(a.ang),fz=Math.sin(a.ang);const r=-a.ang;
  const span=n*0.58+0.5,cx=a.x-nx*LANE,cz=a.z-nz*LANE;
  decor.add(Object.assign(box(s.building?XR.L+0.6:1.7,0.006,span,0x46484A,cx,0.012,cz,r),{castShadow:false}));
  const status=k=>k<Math.min(c,cb)?0:k<c?1:2;
  const mat=(k,base)=>{const t=status(k);if(t===0)return base;return new THREE.MeshLambertMaterial({color:t===1?0xFFB938:0xFF3B5C,emissive:t===1?0x6A4300:0x5A0010,transparent:t===2,opacity:t===2?0.55:1})};
  const bx=(w,h,d,m,x,y,z)=>{const o=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m);o.position.set(x,y,z);o.rotation.y=r;o.castShadow=true;o.receiveShadow=true;decor.add(o);return o};
  const white=new THREE.MeshLambertMaterial({color:0xEDEBE6}),grey=new THREE.MeshLambertMaterial({color:0xA4ABAD}),booth=new THREE.MeshLambertMaterial({color:0x3F6E9E}),wall=new THREE.MeshLambertMaterial({color:0xC8CCC6}),stripe=new THREE.MeshLambertMaterial({color:0xF2C14E});
  for(let k=0;k<n;k++){const o=(k-(n-1)/2)*0.58;const x=cx+nx*o,z=cz+nz*o;const t=status(k);
    if(s.building){// one scanning tunnel per lane; added lanes gold, removed lanes red ghosts
      const tm=t===0?tubeMat:new THREE.MeshPhongMaterial({color:t===1?0xFFC24D:0xFF3B5C,emissive:t===1?0x5A3A00:0x4A0010,transparent:true,opacity:t===1?0.8:0.4,side:THREE.DoubleSide,depthWrite:false});
      const tube=new THREE.Mesh(tubeGeo,tm);tube.position.set(x,0,z);tube.rotation.y=r;tube.renderOrder=4;tube.castShadow=t!==2;decor.add(tube);
      for(const e of [-1,1]){const rg=new THREE.Mesh(ringGeo,t===2?tm:ringMat);rg.position.set(x+fx*e*XR.L/2,0,z+fz*e*XR.L/2);rg.rotation.y=r;rg.castShadow=true;decor.add(rg)}
      bx(0.05,0.004,XR.W*0.9,warnMat,x-fx*(XR.L/2+0.2),0.016,z-fz*(XR.L/2+0.2))}
    else{bx(0.75,0.05,0.56,mat(k,white),x,0.58,z);bx(0.02,0.02,0.42,new THREE.MeshLambertMaterial({color:t===2?0x777777:0xD94848}),x+fx*0.45,0.16,z+fz*0.45)}
    if(t){const ring=new THREE.Mesh(new THREE.RingGeometry(0.2,0.27,32).rotateX(-Math.PI/2),new THREE.MeshBasicMaterial({color:t===1?0xFFB938:0xFF3B5C,transparent:true,opacity:0.9,depthWrite:false}));ring.position.set(x,0.03,z);ring.userData.pulse=true;decor.add(ring)}}
  for(let k=0;k<=n;k++){const o=(k-n/2)*0.58;const x=cx+nx*o,z=cz+nz*o;
    if(s.building){if(k===0||k===n)bx(0.32,0.22,0.22,booth,x+fx*(XR.L/2-0.3)+nx*(k?0.18:-0.18),0.11,z+fz*(XR.L/2-0.3)+nz*(k?0.18:-0.18))}else{bx(0.2,0.24,0.12,booth,x,0.12,z);bx(0.035,0.56,0.035,grey,x+fx*0.33,0.28,z+fz*0.33);bx(0.035,0.56,0.035,grey,x-fx*0.33,0.28,z-fz*0.33)}}
}
function rebuildCapacity(){
  scene.remove(decor);decor=new THREE.Group();scene.add(decor);
  const p=state.params[state.flow],b=state.base[state.flow];const marks=[];G.ver++;
  G.flow.stages.forEach(st=>{const s=G.geo.st[st.key];if(!s||st.kind==="road")return;let c=Math.round(st.cap(p)),cb=Math.round(st.cap(b));if(st.optional&&!st.optional(p))c=0;if(st.optional&&!st.optional(b))cb=0;
    const all=stageSlots(state.flow,st.key,Math.max(c,cb));G.slots[st.key]=all.slice(0,c);
    if(s.layout==="lanes")gateDecor(st,s,c,cb);else all.forEach((sl,k)=>marks.push([sl,k<Math.min(c,cb)?0:k<c?1:2]))});
  if(marks.length){const im=new THREE.InstancedMesh(bayGeo,new THREE.MeshBasicMaterial({map:bayTex,transparent:true,depthWrite:false,opacity:0.85}),marks.length);
    im.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(marks.length*3),3);
    marks.forEach(([sl,t],i)=>{Q.setFromAxisAngle(YA,-sl.rot);M4.compose(PV.set(sl.x,0.022,sl.z),Q,S1);im.setMatrixAt(i,M4);im.setColorAt(i,t===0?C_EXIST:t===1?C_NEW:C_GONE)});
    im.renderOrder=1;im.name="bays";im.visible=state.show.bays;decor.add(im)}
  if(sim)updateStripCaps();
}

// ===== Labels, tags and callouts (HTML over the canvas) =====
let labelEls=[],callouts=[];
function stageCentre(key){const s=G.geo.st[key];const sl=G.slots[key];if(sl&&sl.length){let x=0,z=0;for(const q of sl){x+=q.x;z+=q.z}return{x:x/sl.length,z:z/sl.length}}const pl=stagePolys(s);if(pl){let x=0,z=0;for(const q of pl[0]){x+=q[0];z+=q[1]}return{x:x/pl[0].length,z:z/pl[0].length}}const a=pointAt(G.P,G.P.cum[s.idx]);return{x:a.x,z:a.z}}
function buildLabels(){const L=$("labels");L.innerHTML="";labelEls=[];
  G.flow.stages.forEach((st,i)=>{const anchor=G.geo.label[st.key];if(!anchor)return;const [x,z]=conv(anchor);
    const el=document.createElement("div");el.className="lbl";el.innerHTML=`<span class="n ${st.zone}">${st.num}</span><span class="t"><span class="ar" lang="ar">${st.ar}</span><span class="en">${st.en}</span></span><span class="v"></span>`;
    el.onclick=()=>flyToStage(st.key);L.appendChild(el);labelEls.push({el,v:el.querySelector(".v"),pos:new THREE.Vector3(x,1.6,z),i})})}
const tmpV=new THREE.Vector3();
function project(v){tmpV.copy(v).project(camera);return tmpV.z<1&&tmpV.x>-1.1&&tmpV.x<1.1&&tmpV.y>-1.1&&tmpV.y<1.1?[(tmpV.x+1)/2*innerWidth,(1-tmpV.y)/2*innerHeight]:null}
function updateLabels(){const on=state.show.labels;const dist=camera.position.distanceTo(controls.target);
  for(const L of labelEls){const p=on?project(L.pos):null;L.el.style.display=p?"flex":"none";if(!p)continue;L.el.style.transform=`translate(${p[0]}px,${p[1]}px) translate(-50%,-100%)`;L.el.classList.toggle("compact",dist>260)}
  for(const c of callouts){const p=project(c.pos);c.el.style.display=p?"block":"none";if(p){c.el.style.left=p[0]+"px";c.el.style.top=p[1]+"px"}}
  const tg=$("trackTag");if(tg){const d=state.tracked&&disp.get(state.tracked.id);const p=d?project(PV.set(d.x,0.75,d.z)):null;tg.style.display=p?"flex":"none";if(p){tg.style.left=p[0]+"px";tg.style.top=p[1]+"px"}}}
function updateLabelValues(){if(!sim)return;for(const L of labelEls){const S=sim.stages[L.i];const st=S.def;let txt,hot=false;
  if(st.kind==="road"){const n=sim.roadWaiting();txt=n?n+" waiting":"flowing";hot=n>20}else{const c=sim.cap(L.i);if(st.optional&&!st.optional(sim.p))txt="not built";else{txt=S.occ+" / "+c;hot=S.occ>=c&&S.queue.length>0}}
  L.v.textContent=txt;L.v.classList.toggle("hot",hot)}}
function showCallout(key,text,minus){if(!G.geo.st[key])return;const c=stageCentre(key);const el=document.createElement("div");el.className="callout"+(minus?" minus":"");el.innerHTML=`<div>${esc(text)}</div>`;$("tags").appendChild(el);
  const old=callouts.find(q=>q.key===key);if(old){old.el.remove();callouts.splice(callouts.indexOf(old),1)}
  const item={key,el,pos:new THREE.Vector3(c.x,1.2,c.z)};callouts.push(item);
  setTimeout(()=>el.classList.add("fade"),3200);setTimeout(()=>{el.remove();const i=callouts.indexOf(item);if(i>=0)callouts.splice(i,1)},4100)}

// ===== Truck models (instanced) =====
function mergeColored(parts){// parts: [geometry, colorHex]
  let pos=[],nor=[],col=[];for(const [g0,c] of parts){const g=g0.index?g0.toNonIndexed():g0;const C=new THREE.Color(c);const P=g.attributes.position.array,N=g.attributes.normal.array;
    for(let i=0;i<P.length;i++){pos.push(P[i]);nor.push(N[i])}for(let i=0;i<P.length/3;i++)col.push(C.r,C.g,C.b)}
  const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));g.setAttribute("normal",new THREE.Float32BufferAttribute(nor,3));g.setAttribute("color",new THREE.Float32BufferAttribute(col,3));return g}
const BG=(w,h,d,x,y,z)=>new THREE.BoxGeometry(w,h,d).translate(x,y,z);
const CY_X=(r,len,x,y,z,seg)=>new THREE.CylinderGeometry(r,r,len,seg||14).rotateZ(Math.PI/2).translate(x,y,z);
// Truck kit (forward = +x, front bumper at x = +0.72, 1 unit = 10 m). Bodies are white in the geometry and take a
// per-truck tint; details (glass, tyres, chrome, chassis, reflective stripes, lamps) keep their own colours.
const C_GLASS=0x22303A,C_TYRE=0x17181A,C_RIM=0xB9BEC2,C_CHASSIS=0x2A2B2E,C_CHROME=0xD3D7DB,C_GRILLE=0x2C2D30,C_RED=0xC8202A,C_REFL=0xF2F2EE;
function wheelSet(xs,parts,r){r=r||0.05;for(const x of xs)for(const z of [-0.105,0.105]){parts.push([new THREE.CylinderGeometry(r,r,0.034,14).rotateX(Math.PI/2).translate(x,r,z),C_TYRE]);parts.push([new THREE.CylinderGeometry(r*0.5,r*0.5,0.037,10).rotateX(Math.PI/2).translate(x,r,z),C_RIM])}}
function stripes(x0,x1,y,parts){const n=Math.max(2,Math.round((x1-x0)/0.06));const L=(x1-x0)/n;for(let i=0;i<n;i++)for(const z of [-0.127,0.127])parts.push([BG(L,0.014,0.003,x0+L*(i+0.5),y,z),i%2?C_REFL:C_RED])}
const TRACTOR={
  eu:{// European cab-over: flat face, roof fairing, short wheelbase, tandem drive axles
    body:[BG(0.23,0.27,0.25,0.60,0.265,0),BG(0.2,0.05,0.23,0.60,0.425,0),BG(0.07,0.035,0.25,0.495,0.135,0)],
    detail:()=>{const p=[[BG(0.006,0.09,0.22,0.716,0.33,0),C_GLASS],[BG(0.006,0.075,0.17,0.716,0.205,0),C_GRILLE],[BG(0.03,0.04,0.25,0.71,0.12,0),0x3A3C3F],
      [BG(0.08,0.07,0.004,0.665,0.33,0.126),C_GLASS],[BG(0.08,0.07,0.004,0.665,0.33,-0.126),C_GLASS],[BG(0.02,0.06,0.02,0.70,0.33,0.142),0x2E3033],[BG(0.02,0.06,0.02,0.70,0.33,-0.142),0x2E3033],
      [BG(0.62,0.04,0.16,0.19,0.09,0),C_CHASSIS],[BG(0.15,0.06,0.03,0.38,0.11,0.115),C_CHROME],[BG(0.15,0.06,0.03,0.38,0.11,-0.115),C_CHROME],[BG(0.12,0.012,0.14,0.2,0.125,0),0x3B3D40]];
      wheelSet([0.60,0.27,0.15],p);return p}},
  us:{// North-American conventional: long hood, cab, tall sleeper, chrome stacks and tanks
    body:[BG(0.22,0.15,0.22,0.61,0.215,0),BG(0.22,0.27,0.25,0.39,0.265,0),BG(0.18,0.31,0.25,0.19,0.285,0),BG(0.15,0.05,0.27,0.62,0.125,0)],
    detail:()=>{const p=[[BG(0.006,0.075,0.22,0.501,0.335,0),C_GLASS],[BG(0.006,0.13,0.16,0.721,0.215,0),C_CHROME],[BG(0.03,0.04,0.26,0.72,0.12,0),C_CHROME],
      [BG(0.08,0.07,0.004,0.43,0.33,0.126),C_GLASS],[BG(0.08,0.07,0.004,0.43,0.33,-0.126),C_GLASS],
      [new THREE.CylinderGeometry(0.011,0.011,0.4,8).translate(0.29,0.33,0.132),C_CHROME],[new THREE.CylinderGeometry(0.011,0.011,0.4,8).translate(0.29,0.33,-0.132),C_CHROME],
      [CY_X(0.035,0.15,0.38,0.1,0.118,10),C_CHROME],[CY_X(0.035,0.15,0.38,0.1,-0.118,10),C_CHROME],[BG(0.66,0.04,0.16,0.33,0.09,0),C_CHASSIS]];
      wheelSet([0.62,0.14,0.02],p);return p}},
  rigid:{// rigid truck: smaller cab-over, the load body sits on the same chassis
    body:[BG(0.21,0.23,0.24,0.615,0.245,0),BG(0.17,0.03,0.22,0.615,0.375,0)],
    detail:()=>{const p=[[BG(0.006,0.085,0.21,0.721,0.30,0),C_GLASS],[BG(0.006,0.06,0.16,0.721,0.185,0),C_GRILLE],[BG(0.03,0.035,0.24,0.715,0.115,0),0x3A3C3F],
      [BG(0.08,0.065,0.004,0.67,0.30,0.121),C_GLASS],[BG(0.08,0.065,0.004,0.67,0.30,-0.121),C_GLASS],[BG(1.0,0.04,0.15,0.2,0.09,0),C_CHASSIS],[BG(0.12,0.05,0.03,0.42,0.105,0.11),C_CHROME]];
      wheelSet([0.62,-0.12],p,0.048);return p}}};
function ribs(x0,x1,y0,y1){const out=[];for(let x=x0+0.03;x<x1-0.02;x+=0.045)for(const z of [-0.127,0.127])out.push(BG(0.012,y1-y0,0.004,x,(y0+y1)/2,z));return out}
const tailLamps=(x,p)=>{p.push([BG(0.01,0.03,0.05,x,0.11,0.09),C_RED],[BG(0.01,0.03,0.05,x,0.11,-0.09),C_RED])};
const LOAD={
  box_eu:{body:[BG(1.39,0.28,0.25,-0.255,0.27,0)],
    detail:()=>{const p=[[BG(1.39,0.012,0.252,-0.255,0.135,0),0x8E9398],[BG(1.25,0.035,0.16,-0.3,0.11,0),C_CHASSIS],[BG(0.02,0.05,0.02,0.05,0.07,0.08),0x55585B],[BG(0.02,0.05,0.02,0.05,0.07,-0.08),0x55585B]];
      tailLamps(-0.952,p);stripes(-0.62,-0.02,0.12,p);wheelSet([-0.62,-0.74,-0.86],p);return p}},
  cont_eu:{body:[BG(1.22,0.26,0.25,-0.3,0.285,0),...ribs(-0.91,0.31,0.16,0.41)],
    detail:()=>{const p=[[BG(1.3,0.03,0.2,-0.3,0.13,0),C_CHASSIS],[BG(0.006,0.24,0.24,-0.913,0.285,0),0x9AA0A5]];tailLamps(-0.95,p);stripes(-0.6,-0.05,0.12,p);wheelSet([-0.62,-0.74,-0.86],p);return p}},
  tank_us:{body:[CY_X(0.12,1.18,-0.58,0.28,0,18),new THREE.SphereGeometry(0.12,16,10).scale(0.35,1,1).translate(0.01,0.28,0),new THREE.SphereGeometry(0.12,16,10).scale(0.35,1,1).translate(-1.17,0.28,0)],
    detail:()=>{const p=[[BG(1.15,0.035,0.16,-0.6,0.13,0),C_CHASSIS],[BG(1.1,0.01,0.05,-0.58,0.405,0),0xA9AEB2],[BG(0.3,0.02,0.24,-0.55,0.13,0),0x7D8287]];
      for(const x of [-1.0,-0.7,-0.4,-0.1])p.push([CY_X(0.122,0.012,x,0.28,0,18),0xA7ACB1]);tailLamps(-1.215,p);stripes(-0.8,-0.3,0.115,p);wheelSet([-0.97,-1.09],p);return p}},
  box_us:{body:[BG(1.31,0.29,0.25,-0.595,0.275,0)],
    detail:()=>{const p=[[BG(1.31,0.012,0.252,-0.595,0.135,0),0x8E9398],[BG(1.2,0.035,0.16,-0.6,0.11,0),C_CHASSIS]];tailLamps(-1.252,p);stripes(-0.9,-0.35,0.12,p);wheelSet([-0.97,-1.09],p);return p}},
  box_rigid:{body:[BG(0.78,0.27,0.25,0.09,0.265,0)],
    detail:()=>{const p=[[BG(0.78,0.012,0.252,0.09,0.13,0),0x8E9398]];tailLamps(-0.302,p);stripes(-0.05,0.35,0.115,p);return p}},
  curtain_rigid:{body:[BG(0.76,0.24,0.245,0.09,0.27,0)],
    detail:()=>{const p=[[BG(0.8,0.03,0.25,0.09,0.135,0),0x8B8F93],[BG(0.8,0.015,0.25,0.09,0.395,0),0x9A9EA2]];tailLamps(-0.312,p);
      for(let x=-0.27;x<0.47;x+=0.15)for(const z of [-0.124,0.124])p.push([BG(0.012,0.24,0.004,x,0.27,z),0x6E7378]);
      for(let x=-0.27;x<0.47;x+=0.05)for(const z of [-0.124,0.124])p.push([BG(0.008,0.012,0.004,x,0.165,z),0x3A3C3F]);return p}}};
const KINDS=[{t:"eu",l:"box_eu",w:7},{t:"eu",l:"cont_eu",w:4},{t:"us",l:"tank_us",w:2},{t:"us",l:"box_us",w:3},{t:"rigid",l:"box_rigid",w:2},{t:"rigid",l:"curtain_rigid",w:2}];
const KIND_OF=[];KINDS.forEach((k,i)=>{for(let j=0;j<k.w;j++)KIND_OF.push(i)});
const MAXT=2600,TMESH=[];
function IM(geo,mat,cast=true,colored=false,pick=false){const m=new THREE.InstancedMesh(geo,mat,MAXT);if(colored){m.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(MAXT*3).fill(1),3);m.instanceColor.setUsage(THREE.DynamicDrawUsage)}
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);m.castShadow=cast;m.receiveShadow=true;m.count=0;m.frustumCulled=false;m.userData={ids:new Int32Array(MAXT),n:0,pick};scene.add(m);TMESH.push(m);return m}
const whiteParts=g=>mergeColored(g.map(x=>[x,0xffffff]));
const bodyMat=()=>new THREE.MeshPhongMaterial({vertexColors:true,shininess:55,specular:0x3a3a3a});
const TB={},TD={},LB={},LD={};
for(const k in TRACTOR){TB[k]=IM(whiteParts(TRACTOR[k].body),bodyMat(),true,true,true);TD[k]=IM(mergeColored(TRACTOR[k].detail()),new THREE.MeshPhongMaterial({vertexColors:true,shininess:70,specular:0x444444}),true,false,true)}
for(const k in LOAD){LB[k]=IM(whiteParts(LOAD[k].body),k==="tank_us"?new THREE.MeshPhongMaterial({vertexColors:true,shininess:110,specular:0x8a8a8a}):bodyMat(),true,true,true);LD[k]=IM(mergeColored(LOAD[k].detail()),new THREE.MeshLambertMaterial({vertexColors:true}),true,false,true)}
const T_lights=IM(mergeColored([[BG(0.012,0.03,0.055,0.728,0.15,0.09),0xFFF6D8],[BG(0.012,0.03,0.055,0.728,0.15,-0.09),0xFFF6D8]]),new THREE.MeshBasicMaterial({vertexColors:true}),false);
// headlight beams: a soft additive pool on the road ahead of each cab, plus a glow at the lamps
const beamTex=(()=>{const c=document.createElement("canvas");c.width=128;c.height=64;const g=c.getContext("2d");const gr=g.createRadialGradient(10,32,2,30,32,110);gr.addColorStop(0,"rgba(255,244,214,0.95)");gr.addColorStop(0.45,"rgba(255,228,170,0.35)");gr.addColorStop(1,"rgba(255,220,150,0)");g.fillStyle=gr;g.beginPath();g.moveTo(0,26);g.lineTo(128,0);g.lineTo(128,64);g.lineTo(0,38);g.closePath();g.fill();const t=new THREE.CanvasTexture(c);t.encoding=THREE.sRGBEncoding;return t})();
const T_beam=IM(new THREE.PlaneGeometry(1.5,0.75).rotateX(-Math.PI/2).translate(1.48,0.03,0),new THREE.MeshBasicMaterial({map:beamTex,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,opacity:0.9}),false);
const T_glow=IM(new THREE.PlaneGeometry(0.34,0.2).rotateY(Math.PI/2).translate(0.74,0.15,0),new THREE.MeshBasicMaterial({map:radialTex([[0,"rgba(255,250,235,1)"],[0.3,"rgba(255,230,180,0.5)"],[1,"rgba(255,220,150,0)"]]),transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide}),false);
T_beam.receiveShadow=T_glow.receiveShadow=false;T_beam.renderOrder=T_glow.renderOrder=3;
// liveries: mostly white and silver (as on the reference sheet), a few fleet colours
const cols=a=>a.map(c=>new THREE.Color(c));
const CAB_TINTS=cols([0xF4F4F2,0xF4F4F2,0xF4F4F2,0xF4F4F2,0xF0F1F2,0xE6E8EA,0xC9CDD1,0xF4F4F2,0x8A1538,0x1F3B63,0xA92A23,0xF4F4F2,0xDADDE0]);
const LOAD_TINTS={box_eu:cols([0xF2F2F0,0xF2F2F0,0xF2F2F0,0xE4E6E8,0xD3D6D9,0xF2F2F0,0x2A5C8A]),box_us:cols([0xF2F2F0,0xF2F2F0,0xE4E6E8,0xCDD1D5]),box_rigid:cols([0xF2F2F0,0xF2F2F0,0xE9EAEB,0xD8DBDE]),
  cont_eu:cols([0xE8E9EA,0xD4D7DA,0x8A1538,0x2A5C8A,0x3E6B48,0xB5652B,0xE8E9EA,0x6B7075]),tank_us:cols([0xDCE0E4,0xC7CCD1,0xE8EAEC]),curtain_rigid:cols([0xEDEDE8,0xE2E2DC,0x2A5C8A,0xC8C8C2])};
const GHOST=new THREE.Color(0x6B6E73),C_RL=new THREE.Color(0xD5304C),C_GL=new THREE.Color(0x1FA36B);
const beam=new THREE.Group();beam.add(new THREE.Mesh(new THREE.CylinderGeometry(0.035,0.035,3,10),new THREE.MeshBasicMaterial({color:0x2F8CFF,transparent:true,opacity:0.55})));beam.children[0].position.y=1.9;
const ring=new THREE.Mesh(new THREE.RingGeometry(0.62,0.74,48),new THREE.MeshBasicMaterial({color:0x2F8CFF,side:THREE.DoubleSide,transparent:true,opacity:0.9,depthWrite:false}));ring.rotation.x=-Math.PI/2;ring.position.y=0.05;beam.add(ring);beam.visible=false;scene.add(beam);
const C_OK=new THREE.Color(0x2EAE7E),C_MID=new THREE.Color(0xF0A81C),C_BAD=new THREE.Color(0xD21F55),C_TRACK=new THREE.Color(0x2F8CFF);

// ===== Truck motion =====
// A truck's position is a function of simulated time. When the simulation moves a truck to a new stage, a route is
// planned: leave the old slot (its exit manoeuvre), follow the right-hand lane of the georeferenced road to the new
// stage, then its entry manoeuvre into the slot. The drive takes the simulated drive time (moveT -> arrT), with
// smooth acceleration and braking, so trucks move at a believable pace at every speed and never leave the roads.
// Trucks on the public road form a single-file queue that creeps forward without overtaking.
const disp=new Map(),leaving=[];let simT=0;
function hashId(id){return id*2654435761>>>0}
function chaikin(w){if(w.length<3)return w;const o=[w[0]];for(let i=0;i<w.length-1;i++){const a=w[i],b=w[i+1],rv=!!b.rev;o.push({x:a.x*0.75+b.x*0.25,z:a.z*0.75+b.z*0.25,rev:rv},{x:a.x*0.25+b.x*0.75,z:a.z*0.25+b.z*0.75,rev:rv})}o.push(w[w.length-1]);return o}
function mkPoly(w){const xs=[],zs=[],rv=[],cum=[];for(const p of w){if(xs.length){const dd=Math.hypot(p.x-xs[xs.length-1],p.z-zs[zs.length-1]);if(dd<1e-4)continue;cum.push(cum[cum.length-1]+dd)}else cum.push(0);xs.push(p.x);zs.push(p.z);rv.push(!!p.rev)}return{xs,zs,rv,cum,L:cum[cum.length-1]}}
const PA={x:0,z:0,ang:0};
function polyAt(pl,s){const c=pl.cum,n=c.length;if(n<2){PA.x=pl.xs[0];PA.z=pl.zs[0];return PA}
  s=Math.max(0,Math.min(pl.L,s));let lo=0,hi=n-1;while(hi-lo>1){const m=(lo+hi)>>1;if(c[m]<=s)lo=m;else hi=m}
  const f=(s-c[lo])/((c[hi]-c[lo])||1),dx=pl.xs[hi]-pl.xs[lo],dz=pl.zs[hi]-pl.zs[lo];PA.x=pl.xs[lo]+dx*f;PA.z=pl.zs[lo]+dz*f;PA.ang=Math.atan2(dz,dx)+(pl.rv[hi]?Math.PI:0);return PA}
const ease=f=>{const a=0.16;if(f<=0)return 0;if(f>=1)return 1;const v=1/(1-a);if(f<a)return v*f*f/(2*a);if(f>1-a)return 1-v*(1-f)*(1-f)/(2*a);return v*(f-a/2)};
const slotOf=(j,i)=>{const a=G.slots[G.flow.stages[j].key];return a&&a[i]||null};
function plan(d,tr){
  const w=[{x:d.x,z:d.z}];let fromD;
  if(d.mode==="road")fromD=d.s;else if(d.slotRef){for(const p of d.slotRef.out)w.push(p);fromD=d.slotRef.jout}else fromD=nearestD(G.LP,d.x,d.z,0,G.LP.total);
  if(tr){const ns=slotOf(tr.stage,tr.slot);const jin=ns?ns.jin:stageJ(G.flow.stages[tr.stage].key)[0];
    if(jin>fromD+0.2)for(const p of pathSpan(G.LP,fromD,jin))w.push(p);
    if(ns){for(const p of ns.in)w.push(p);w.push({x:ns.x,z:ns.z,rev:!!ns.revLast})}
    d.slotRef=ns;d.stage=tr.stage;d.slot=tr.slot;d.ver=G.ver;d.goal=ns||pointAt(G.LP,jin);d.goalRot=ns?ns.rot:pointAt(G.LP,jin).ang;
    d.pl=mkPoly(chaikin(chaikin(w)));const t0=Math.min(tr.moveT!=null?tr.moveT:simT,simT);const want=(tr.arrT!=null?tr.arrT:t0)-t0;
    d.t0=t0;d.t1=t0+Math.max(want,d.pl.L/(V_DRIVE*1.5),0.05);d.mode="move"}
  else{for(const p of pathSpan(G.LP,fromD,G.LP.total+30))w.push(p);d.pl=mkPoly(chaikin(w));d.t0=simT;d.t1=simT+Math.max(0.1,d.pl.L/V_DRIVE);d.mode="leave";d.slotRef=null}
}
function settle(d){// a parked truck whose slot geometry changed (capacity edited) takes a short drive to its new slot
  const ns=slotOf(d.stage,d.slot);d.ver=G.ver;if(!ns||Math.hypot(ns.x-d.x,ns.z-d.z)<0.02){d.slotRef=ns;return}
  d.slotRef=ns;d.goal=ns;d.goalRot=ns.rot;d.pl=mkPoly([{x:d.x,z:d.z},{x:ns.x,z:ns.z}]);d.t0=simT;d.t1=simT+Math.max(0.2,d.pl.L/V_DRIVE);d.mode="move"}
function turn(d,target,k){let da=target-d.rot;while(da>Math.PI)da-=2*Math.PI;while(da<-Math.PI)da+=2*Math.PI;d.rot+=da*k}
let nightOn=false;
function updateTrucks(dt,dT){
  const k=Math.min(1,dt*9);
  // 1) public-road queue
  const order=sim.stages[0].order;let prev=Infinity;
  for(let i=0;i<order.length;i++){const tr=order[i];let d=disp.get(tr.id);
    if(!d){d={x:0,z:0,rot:0,mode:"road",s:Math.min(G.roadHead-70,prev-2.2),stage:0,slot:-1,h:hashId(tr.id)};disp.set(tr.id,d);const p=pointAt(G.LP,d.s);d.x=p.x;d.z=p.z;d.rot=p.ang}
    const target=Math.min(G.roadHead-i*2.2,prev-2.2);if(d.s<target)d.s=Math.min(target,d.s+V_DRIVE*dT);else d.s=Math.min(d.s,prev-2.2);
    prev=d.s;const p=pointAt(G.LP,d.s);d.x=p.x;d.z=p.z;turn(d,p.ang,k);d.seen=true}
  // 2) trucks inside the port
  for(const tr of sim.active.values()){if(tr.stage===0)continue;let d=disp.get(tr.id);
    if(!d){const ns=slotOf(tr.stage,tr.slot)||pointAt(G.LP,stageJ(G.flow.stages[tr.stage].key)[0]);d={x:ns.x,z:ns.z,rot:ns.rot||ns.ang||0,mode:"park",stage:tr.stage,slot:tr.slot,slotRef:slotOf(tr.stage,tr.slot),ver:G.ver,h:hashId(tr.id)};disp.set(tr.id,d)}
    if(d.stage!==tr.stage||d.slot!==tr.slot||d.mode==="road")plan(d,tr);else if(d.mode==="park"&&d.ver!==G.ver)settle(d);
    if(d.mode==="move"){const f=(simT-d.t0)/(d.t1-d.t0);if(f>=1){d.mode="park";if(d.goal){d.x=d.goal.x;d.z=d.goal.z}}else{const q=polyAt(d.pl,d.pl.L*ease(Math.max(0,f)));d.x=q.x;d.z=q.z;turn(d,q.ang,k)}}
    if(d.mode==="park")turn(d,d.goalRot!=null?d.goalRot:d.rot,k);d.seen=true}
  // 3) released trucks drive off the end of the route
  for(const [id,d] of disp){if(d.seen){d.seen=false;continue}disp.delete(id);plan(d,null);leaving.push(d)}
  for(let i=leaving.length-1;i>=0;i--){const d=leaving[i];const f=(simT-d.t0)/(d.t1-d.t0);if(f>=1){leaving.splice(i,1);continue}const q=polyAt(d.pl,d.pl.L*ease(f));d.x=q.x;d.z=q.z;turn(d,q.ang,k)}
  // 4) instances: tracked truck blue; filtered-out trucks grey; optional colour by wait or by risk lane
  for(const m of TMESH)m.userData.n=0;
  const status=state.show.status,lane=state.show.lane,t=sim.t,fa=filterActive();
  for(const [id,d] of disp){const tr=sim.active.get(id);let cc=null,lc=null;
    if(tr&&tr===state.tracked)cc=C_TRACK;else if(fa&&tr&&!matchF(tr))cc=lc=GHOST;else if(lane&&tr)cc=tr.a&&tr.a.red?C_RL:C_GL;
    else if(status&&tr){const age=(t-tr.arr)/60;cc=age<2?C_OK:age<6?C_MID:C_BAD}
    if(!putTruck(d,id,cc,lc))break}
  for(const d of leaving){if(!putTruck(d,-1,fa?GHOST:null,fa?GHOST:null))break}
  for(const m of TMESH){m.count=m.userData.n;m.instanceMatrix.needsUpdate=true;if(m.instanceColor)m.instanceColor.needsUpdate=true}
  if(state.tracked){const d=disp.get(state.tracked.id);if(d)beam.position.set(d.x,0,d.z)}
}
function put(m,id,col){const n=m.userData.n;if(n>=MAXT)return false;m.setMatrixAt(n,M4);if(col)m.setColorAt(n,col);m.userData.ids[n]=id;m.userData.n=n+1;return true}
function putTruck(d,id,cc,lc){Q.setFromAxisAngle(YA,-d.rot);PV.set(d.x,0,d.z);M4.compose(PV,Q,S1);const K=KINDS[KIND_OF[d.h%KIND_OF.length]];const lt=LOAD_TINTS[K.l];
  const ok=put(TB[K.t],id,cc||CAB_TINTS[(d.h>>>7)%CAB_TINTS.length]);put(TD[K.t],id);put(LB[K.l],id,lc||lt[(d.h>>>3)%lt.length]);put(LD[K.l],id);
  put(T_lights,id);put(T_beam,id);put(T_glow,id);return ok}

// ===== Heat, sky, sun =====
const HC=[new THREE.Color(0x2E9E78),new THREE.Color(0xE0A21B),new THREE.Color(0xC2185B)],HT=new THREE.Color();
function utilColor(u){if(u<0.6)HT.copy(HC[0]).lerp(HC[1],u/0.6);else HT.copy(HC[1]).lerp(HC[2],Math.min(1,(u-0.6)/0.4));return HT}
function updateHeat(){G.flow.stages.forEach((st,i)=>{const mats=heat[st.key];if(!mats)return;const c=sim.cap(i);const u=c>0?Math.min(1,sim.stages[i].occ/c):0;utilColor(u);for(const m of mats){m.color.copy(HT);m.opacity=c>0?0.04+0.2*u:0}})}
const SKY=ILLUS?{dayTop:new THREE.Color(0x6FA3D6),dayHor:new THREE.Color(0xE8EEF0),duskTop:new THREE.Color(0x45507F),duskHor:new THREE.Color(0xF5B07A),nightTop:new THREE.Color(0x0A1022),nightHor:new THREE.Color(0x24304A)}
  :{dayTop:new THREE.Color(0x5E95C9),dayHor:new THREE.Color(0xD9E3E6),duskTop:new THREE.Color(0x3B4E78),duskHor:new THREE.Color(0xF0A86B),nightTop:new THREE.Color(0x070C18),nightHor:new THREE.Color(0x1C2838)};
const cTop=new THREE.Color(),cHor=new THREE.Color(),tmpC=new THREE.Color(),MOON=new THREE.Color(0x7F95C8),WHITE3=new THREE.Color(0xffffff);let lastSkyKey=-1;
const lightHour=()=>state.light==="auto"?(simT/60)%24:+state.light;
function updateLight(){const h=lightHour();const elev=Math.sin(Math.PI*(h-6)/12);const day=Math.max(0,Math.min(1,elev*2.2+0.15));const dusk=Math.max(0,1-Math.abs(elev)*4.5)*(h>4&&h<20?1:0);
  cTop.copy(SKY.nightTop).lerp(SKY.dayTop,day).lerp(SKY.duskTop,dusk*0.6);cHor.copy(SKY.nightHor).lerp(SKY.dayHor,day).lerp(SKY.duskHor,dusk*0.75);
  const key=Math.round(h*12);if(key!==lastSkyKey){lastSkyKey=key;const pos=skyGeo.attributes.position;for(let i=0;i<pos.count;i++){const y=pos.getY(i)/2000;const t=Math.pow(Math.max(0,y),0.55);tmpC.copy(cHor).lerp(cTop,t);if(y<0)tmpC.copy(cHor).multiplyScalar(0.9);skyCol[i*3]=tmpC.r;skyCol[i*3+1]=tmpC.g;skyCol[i*3+2]=tmpC.b}skyGeo.attributes.color.needsUpdate=true;updateSkyIcon(h,day)}
  scene.fog.color.copy(cHor);renderer.setClearColor(cHor);const cd=camera.position.distanceTo(controls.target);scene.fog.near=cd*1.3+80;scene.fog.far=cd*4+900;
  const az=Math.PI*(h-6)/12;const el=Math.max(0.12,elev);const tgt=controls.target;
  sun.position.set(tgt.x+Math.cos(az)*300,40+el*320,tgt.z+120-Math.sin(az)*40);sun.target.position.copy(tgt);
  const fr=Math.min(240,Math.max(30,cd*0.75));const sc=sun.shadow.camera;if(Math.abs(sc.right-fr)>fr*0.15){sc.left=sc.bottom=-fr;sc.right=sc.top=fr;sc.updateProjectionMatrix()}
  const night=1-day;
  sun.intensity=0.1+0.58*day;sun.color.setHSL(0.09,0.55,0.75+0.2*day).lerp(MOON,night);hemi.intensity=0.22+0.36*day;hemi.color.copy(cTop).lerp(WHITE3,0.5).lerp(MOON,night*0.6);
  if(lampHeads){lampHeads.material.color.setRGB(0.4+0.6*night,0.36+0.58*night,0.3+0.45*night);lampPools.material.opacity=0.85*night;lampGlow.material.opacity=night}
  for(const k of ["bld","tower"])wallMats[k].emissive.setRGB(1,0.82,0.6).multiplyScalar(night*0.95);underMat.emissive.setRGB(0.95,0.9,0.78).multiplyScalar(night*0.75);
  nightOn=night>0.3;T_lights.visible=night>0.2;T_beam.visible=T_glow.visible=nightOn;T_beam.material.opacity=Math.min(1,(night-0.3)*2);
}
function updateSkyIcon(h,day){const el=$("skyIc");if(!el)return;const isDay=day>0.35;
  el.innerHTML=isDay?'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
    :'<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';el.title=state.light==="auto"?"Lighting follows the clock":"Lighting fixed at "+fmtT(h*60)}

// ===== Live simulation =====
let feedBuf=[];
function startSim(){const flow=FLOWS[state.flow];
  sim=new Sim(flow,state.params[state.flow],Math.floor(Math.random()*1e9),{events:true,onEvent:(e,tr)=>{if(warm)return;feedBuf.push({e,tr})}});
  let warm=true;for(let i=0;i<1440+480;i++)sim.step();warm=false;sim.events.length=0;simT=sim.t;
  feedBuf=[];disp.clear();leaving.length=0;untrack();$("feed").innerHTML="";
  const order=sim.stages[0].order;order.forEach((tr,i)=>{const s=G.roadHead-i*2.2;const p=pointAt(G.LP,s);disp.set(tr.id,{x:p.x,z:p.z,rot:p.ang,mode:"road",s,stage:0,slot:-1,h:hashId(tr.id)})});
  sim.dayStart=1440;lastSkyKey=-1;updateStripCaps()}
let acc=0,last=performance.now(),uiT=0,frames=0;
function frame(now){const dt=Math.min(0.1,(now-last)/1000);last=now;let dT=0;
  if(sim&&state.speed>0){dT=dt*state.speed;acc+=dT;let guard=0;while(acc>=1&&guard<200){sim.step();acc-=1;guard++;if(sim.t%1440===0)sim.dayStart=sim.t}simT=sim.t+acc}
  if(sim){updateTrucks(dt,dT);uiT+=dt;if(uiT>0.25){uiT=0;updateLabelValues();updateHeat();updateKpis();updateStrip();flushFeed();updateFilterPanel();if(state.tracked)renderJourney()}updateLight()}
  pulse(now);stepCam(now,dt);controls.update();updateLabels();renderer.render(scene,camera);
  if(++frames===3)setTimeout(()=>$("loading").classList.add("done"),250);requestAnimationFrame(frame)}
function pulse(now){const s=1+0.25*Math.sin(now/260);decor.children.forEach(o=>{if(o.userData.pulse){o.scale.set(s,1,s);o.material.opacity=0.55+0.35*Math.sin(now/260)}})}

// ===== Camera: fit, fly-to, follow =====
let userMoved=false,follow=false,chase=false,camAnim=null;
function fitCamera(){// frame the port between the open side panels
  const st=G.geo.st,P=G.P;const i0=Math.max(0,st.road.idx-60),i1=Math.min(P.pts.length-1,Math.max(...Object.values(st).map(v=>Math.max(v.idx,v.exitIdx||0)))+40);
  const pts=P.pts.slice(i0,i1+1);let mx=0,mz=0;for(const [x,z] of pts){mx+=x;mz+=z}mx/=pts.length;mz/=pts.length;
  let sxx=0,szz=0,sxz=0;for(const [x,z] of pts){sxx+=(x-mx)**2;szz+=(z-mz)**2;sxz+=(x-mx)*(z-mz)}const ang=0.5*Math.atan2(2*sxz,sxx-szz);
  const ux=Math.cos(ang),uz=Math.sin(ang),vx=-uz,vz=ux;let u0=1e9,u1=-1e9,v0=1e9,v1=-1e9;for(const [x,z] of pts){const u=(x-mx)*ux+(z-mz)*uz,v=(x-mx)*vx+(z-mz)*vz;u0=Math.min(u0,u);u1=Math.max(u1,u);v0=Math.min(v0,v);v1=Math.max(v1,v)}
  const cx=mx+ux*(u0+u1)/2+vx*(v0+v1)/2,cz=mz+uz*(u0+u1)/2+vz*(v0+v1)/2;const Wd=(u1-u0)+10,Dd=(v1-v0)+10;
  const cs=getComputedStyle(document.body),sl=parseFloat(cs.getPropertyValue("--sl"))||12,sr=parseFloat(cs.getPropertyValue("--sr"))||12,W=innerWidth,free=Math.max(0.35,(W-sl-sr)/W);
  const vf=camera.fov*Math.PI/180,hf=2*Math.atan(Math.tan(vf/2)*camera.aspect);const dist=Math.max((Wd/2)/Math.tan(hf/2)/free,(Dd*0.62)/Math.tan(vf/2))*1.02;
  let sx=vx,sz=vz;if(sz<0){sx=-sx;sz=-sz}const el=0.95;
  // shift the target so the port is centred in the free area, not the window
  const shift=((sr-sl)/2)/W*2*dist*Math.tan(hf/2);const rx=-sz,rz=sx;
  controls.target.set(cx+rx*shift,0,cz+rz*shift);camera.position.set(controls.target.x+sx*Math.cos(el)*dist,Math.sin(el)*dist,controls.target.z+sz*Math.cos(el)*dist);controls.update()}
function camSph(){const off=camera.position.clone().sub(controls.target);const r=off.length();return{r,el:Math.asin(Math.max(-1,Math.min(1,off.y/r))),az:Math.atan2(off.z,off.x)}}
function flyTo(x,z,dist,el,az,dur){const s=camSph();camAnim={t0:performance.now(),dur:(dur||1.5)*1000,ft:controls.target.clone(),tt:new THREE.Vector3(x,0,z),fr:s.r,tr:dist||s.r,fel:s.el,tel:el!=null?el:s.el,faz:s.az,taz:az!=null?az:s.az};userMoved=true}
function stepCam(now,dt){
  if(follow&&state.tracked){const d=disp.get(state.tracked.id);if(d){if(camAnim)camAnim.tt.set(d.x,0,d.z);else{const dx=d.x-controls.target.x,dz=d.z-controls.target.z,kk=Math.min(1,dt*6);controls.target.x+=dx*kk;controls.target.z+=dz*kk;camera.position.x+=dx*kk;camera.position.z+=dz*kk;
    if(chase){const s=camSph();let da=(d.rot+Math.PI)-s.az;while(da>Math.PI)da-=2*Math.PI;while(da<-Math.PI)da+=2*Math.PI;const az=s.az+da*Math.min(1,dt*1.5);camera.position.set(controls.target.x+Math.cos(az)*Math.cos(s.el)*s.r,Math.sin(s.el)*s.r,controls.target.z+Math.sin(az)*Math.cos(s.el)*s.r)}}}}
  if(!camAnim)return;const k=Math.min(1,(now-camAnim.t0)/camAnim.dur);const e=k<.5?4*k*k*k:1-Math.pow(-2*k+2,3)/2;
  const a=camAnim;const t=a.ft.clone().lerp(a.tt,e);let daz=a.taz-a.faz;while(daz>Math.PI)daz-=2*Math.PI;while(daz<-Math.PI)daz+=2*Math.PI;
  // pull back a little mid-flight so long hops read as a flight, not a slide
  const hop=Math.min(1,a.ft.distanceTo(a.tt)/120);const r=a.fr+(a.tr-a.fr)*e+Math.sin(Math.PI*e)*hop*60,el=a.fel+(a.tel-a.fel)*e,az=a.faz+daz*e;
  controls.target.copy(t);camera.position.set(t.x+Math.cos(az)*Math.cos(el)*r,Math.sin(el)*r,t.z+Math.sin(az)*Math.cos(el)*r);if(k>=1)camAnim=null}
function flyToStage(key){const s=G.geo.st[key];if(!s)return;const c=stageCentre(key);const big=s.layout==="lot"||s.layout==="bays";flyTo(c.x,c.z,big?44:s.layout==="sheds"?34:s.layout==="along"?22:16,big?0.78:0.62)}
function resize(){const w=innerWidth,h=innerHeight;renderer.setSize(w,h,false);camera.aspect=w/Math.max(1,h);camera.updateProjectionMatrix();if(G&&!userMoved)fitCamera()}
addEventListener("resize",resize);controls.addEventListener("start",()=>{userMoved=true;camAnim=null});

// ===== KPIs, stage strip, feed, tracking =====
function bottleneck(){const st=G.flow.stages;for(let i=st.length-1;i>0;i--){const S=sim.stages[i];if(S.queue.length>0&&S.occ>=sim.cap(i))return i}return -1}
function updateKpis(){const t=sim.t;$("clock").textContent=fmtT(t);$("day").textContent="Day "+Math.floor(t/1440);
  const st=G.flow.stages;let inPort=0;for(const tr of sim.active.values())if(tr.stage>0)inPort++;const road=sim.roadWaiting();
  const recent=sim.records.slice(-60);const avg=recent.length?recent.reduce((a,r)=>a+(r.out-r.arr),0)/recent.length/60:0;let today=0;for(let i=sim.records.length-1;i>=0&&sim.records[i].out>=sim.dayStart;i--)today++;
  const bn=bottleneck();
  $("kpis").innerHTML=`<div class="kpi"><div class="l">Trucks inside the port</div><div class="v">${inPort}</div></div>
   <div class="kpi${road>20?" alert":""}"><div class="l">Queued on the public road</div><div class="v">${road}<small>${road?(road*0.022).toFixed(1)+" km":""}</small></div></div>
   <div class="kpi"><div class="l">Average time in port, last 60</div><div class="v">${avg.toFixed(1)}<small>h</small></div></div>
   <div class="kpi"><div class="l">Released since 00:00</div><div class="v">${today}</div></div>
   <div class="kpi wide${bn>=0?" alert":""}"><div class="l">Current bottleneck</div><div class="v">${bn>=0?esc(st[bn].en):"None"}</div></div>`}
function buildStrip(){const st=G.flow.stages;
  $("flowstrip").innerHTML=st.map((s,i)=>`<button class="stg" data-k="${s.key}" title="${esc(s.en)}: click to fly there"><span class="h" title="${esc(s.en)}"><i class="z-${s.zone}">${s.num}</i><span>${esc(s.en.replace("Truck road from Saudi Arabia","Road from KSA").replace("Truck road from Doha","Road from Doha").replace(" check gates"," gates").replace("Appointment","Appt.").replace("Operational","Op."))}</span></span><span class="m"></span><span class="bar"><b></b></span></button>`).join("");
  $("occ").innerHTML=st.map((s,i)=>i===0?"":`<div class="r" data-k="${s.key}"><span class="nm"><i class="z-${s.zone}">${s.num}</i>${esc(s.en)}</span><span class="vv"></span><span class="bar"><b></b></span></div>`).join("");
  for(const el of document.querySelectorAll("#flowstrip .stg,#occ .r"))el.onclick=()=>flyToStage(el.dataset.k)}
function updateStripCaps(){}
function updateStrip(){const st=G.flow.stages;const bn=bottleneck();const strip=$("flowstrip").children,occ={};for(const r of $("occ").children)occ[r.dataset.k]=r;
  st.forEach((s,i)=>{const S=sim.stages[i];let txt,u=0,hot=false;
    if(s.kind==="road"){const n=sim.roadWaiting();txt=n?n+" waiting":"flowing";u=Math.min(1,n/80);hot=n>20}
    else{const c=sim.cap(i);if(s.optional&&!s.optional(sim.p)){txt="not built"}else{txt=S.occ+" / "+c+(S.queue.length?" · "+S.queue.length+" wait":"");u=c>0?Math.min(1,S.occ/c):0;hot=S.occ>=c&&S.queue.length>0}}
    const col="#"+utilColor(u).getHexString();const el=strip[i];if(el){el.querySelector(".m").textContent=txt;el.querySelector(".m").classList.toggle("hot",hot);const b=el.querySelector(".bar b");b.style.width=(u*100)+"%";b.style.background=col;el.classList.toggle("bn",i===bn)}
    const r=occ[s.key];if(r){r.querySelector(".vv").textContent=txt;const b=r.querySelector(".bar b");b.style.width=(u*100)+"%";b.style.background=col}})}
function flushFeed(){if(!feedBuf.length)return;const ul=$("feed");const items=feedBuf.slice(-12);feedBuf=[];
  for(const {e,tr} of items){const li=document.createElement("li");li.className="new";const name=e.stage<0?"Left the port":G.flow.stages[e.stage].en;li.innerHTML=`<span class="t">${fmtT(e.t)}</span>${plateHTML(tr.plate)}<span class="st">${esc(name)}</span>`;li.onclick=()=>track(tr.plate);ul.prepend(li)}
  while(ul.children.length>60)ul.lastChild.remove();const dl=$("plates");if(!dl._t||performance.now()-dl._t>3000){dl._t=performance.now();dl.innerHTML=[...sim.active.values()].slice(-150).map(t=>`<option value="${t.plate}">`).join("")}}
function untrack(){state.tracked=null;follow=false;chase=false;beam.visible=false;const tg=$("trackTag");if(tg)tg.remove();$("journey").innerHTML=""}
function track(plate){plate=(plate||"").trim().toUpperCase().replace(/\s+/g," ");const tr=sim.byPlate.get(plate);if(!tr){toast(plate?"No truck with plate "+plate+" is in the port right now":"Type a plate first");return}
  state.tracked=tr;beam.visible=true;$("plateIn").value=tr.plate;follow=true;openTab("track");setFold("right",false);
  let tg=$("trackTag");if(!tg){tg=document.createElement("div");tg.id="trackTag";tg.className="tag";$("tags").appendChild(tg)}
  const d=disp.get(tr.id);if(d)flyTo(d.x,d.z,9,0.5,d.rot+Math.PI+0.5,1.6);renderJourney()}
function renderJourney(){const tr=state.tracked;if(!tr)return;const st=G.flow.stages;
  if(!sim.active.has(tr.id)){$("journey").innerHTML=`<div class="tcard">${plateHTML(tr.plate)}<p class="hint" style="margin:8px 0 0">Left the port at ${fmtT(tr.out)} after ${fmtH((tr.out-tr.arr)/60)}.</p></div>`;state.tracked=null;follow=false;beam.visible=false;const tg=$("trackTag");if(tg)tg.remove();return}
  const when={};for(const [j,t] of tr.log)if(j>=0)when[j]=t;const d=disp.get(tr.id);const moving=d&&d.mode==="move";
  const lis=st.map((s,j)=>{if(!tr.route[j])return s.optional&&!s.optional(sim.p)?"":`<li class="skip"><span>${esc(s.en)}</span><time>not selected</time></li>`;const cls=j<tr.stage?"done":j===tr.stage?"now":"";return `<li class="${cls}"><span>${esc(s.en)}${j===tr.stage&&tr.waiting?" · waiting":""}</span><time>${when[j]!=null?fmtT(when[j]):""}</time></li>`}).join("");
  const now=st[tr.stage].en,h=(sim.t-tr.arr)/60;
  $("journey").innerHTML=`<div class="tcard"><div class="top">${plateHTML(tr.plate)}<span class="el num">${fmtH(h)}</span></div>${tr.a?attrsHTML(tr.a):""}<p class="hint" style="margin:8px 0 0">${moving?"Driving to":"At"} <b>${esc(now)}</b>${tr.waiting?", waiting for the next stage":""}.</p>
   <div class="row"><button class="btn" id="fwBtn">${follow?"Stop following":"Follow"}</button><button class="btn" id="chBtn" aria-pressed="${chase}">${chase?"Free camera":"Chase cam"}</button><button class="btn ghost" id="untBtn">Clear</button></div><ul class="journey">${lis}</ul></div>`;
  $("fwBtn").onclick=()=>{follow=!follow;if(follow){const dd=disp.get(tr.id);if(dd)flyTo(dd.x,dd.z,9,0.5,null,1)}renderJourney()};$("chBtn").onclick=()=>{chase=!chase;follow=follow||chase;renderJourney()};$("untBtn").onclick=untrack;
  const tg=$("trackTag");if(tg)tg.innerHTML=`<div class="card">${plateHTML(tr.plate)} <b>${fmtH(h)}</b> · ${esc(now)}</div><div class="stem"></div>`}
$("trackBtn").onclick=()=>track($("plateIn").value);$("plateIn").addEventListener("keydown",e=>{if(e.key==="Enter")track($("plateIn").value)});
$("randBtn").onclick=()=>{const arr=[...sim.active.values()].filter(t=>t.stage>0);if(arr.length)track(arr[Math.floor(Math.random()*arr.length)].plate)};
const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();let downAt=null;
renderer.domElement.addEventListener("pointerdown",e=>{downAt=[e.clientX,e.clientY]});
renderer.domElement.addEventListener("pointerup",e=>{if(!downAt||Math.hypot(e.clientX-downAt[0],e.clientY-downAt[1])>5)return;const r=renderer.domElement.getBoundingClientRect();
  mouse.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(mouse,camera);const hit=ray.intersectObjects(TMESH.filter(m=>m.userData.pick&&m.count>0))[0];
  if(hit&&hit.instanceId!=null){const id=hit.object.userData.ids[hit.instanceId];const tr=sim.active.get(id);if(tr)track(tr.plate)}});

// ===== Panels, tabs, map controls, keyboard =====
function setFold(side,folded){const el=$(side==="left"?"left":"right");el.classList.toggle("folded",folded);document.body.classList.toggle(side==="left"?"foldL":"foldR",folded);if(G&&!userMoved)setTimeout(fitCamera,360);$(side==="left"?"railL":"railR").classList.toggle("on",folded);store.set("fold:"+side,folded)}
$("foldL").onclick=()=>setFold("left",true);$("unfoldL").onclick=()=>setFold("left",false);$("foldR").onclick=()=>setFold("right",true);$("unfoldR").onclick=()=>setFold("right",false);
{const narrow=innerWidth<900;setFold("left",store.get("fold:left",narrow));setFold("right",store.get("fold:right",narrow))}
function openTab(k){for(const b of document.querySelectorAll(".tabs button"))b.setAttribute("aria-selected",b.dataset.tab===k);for(const p of document.querySelectorAll(".tabpane"))p.classList.toggle("on",p.dataset.pane===k)}
for(const b of document.querySelectorAll(".tabs button"))b.onclick=()=>openTab(b.dataset.tab);
function toggleBtn(id,key,fn){const b=$(id);b.setAttribute("aria-pressed",state.show[key]);b.onclick=()=>{state.show[key]=!state.show[key];b.setAttribute("aria-pressed",state.show[key]);if(fn)fn();renderLegend()}}
toggleBtn("tLabels","labels");toggleBtn("tRoute","route",()=>{const r=world.getObjectByName("route");if(r)r.visible=state.show.route});
toggleBtn("tBays","bays",()=>{const b=decor.getObjectByName("bays");if(b)b.visible=state.show.bays});toggleBtn("tStatus","status",()=>{if(state.show.status&&state.show.lane){state.show.lane=false;$("tLane").setAttribute("aria-pressed",false)}});
toggleBtn("tLane","lane",()=>{if(state.show.lane&&state.show.status){state.show.status=false;$("tStatus").setAttribute("aria-pressed",false)}});toggleBtn("tFly","fly");
$("recenter").onclick=()=>{userMoved=false;follow=false;camAnim=null;fitCamera()};
function renderLegend(){const it=[["#F2BE2E","Route outside the port"],["#2FD39A","Route inside the port"],["#FFB938","Added capacity"],["#FF3B5C","Removed capacity"]];
  if(state.show.status)it.push(["#2EAE7E","Cab: under 2 h"],["#F0A81C","Cab: 2 to 6 h"],["#D21F55","Cab: over 6 h"]);
  if(state.show.lane)it.push(["#D5304C","Cab: red lane (inspection)"],["#1FA36B","Cab: green lane"]);
  if(filterActive())it.push(["#6B6E73","Outside the filter"]);
  $("legend").innerHTML=it.map(([c,t])=>`<span><i style="background:${c}"></i>${t}</span>`).join("")}
renderLegend();
$("speeds").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;setSpeed(+b.dataset.s)});
function setSpeed(s){state.speed=s;for(const x of $("speeds").children)x.setAttribute("aria-pressed",Math.abs(+x.dataset.s-s)<1e-6)}
let lastSpeed=2;
$("lighting").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;state.light=b.dataset.h;lastSkyKey=-1;for(const x of $("lighting").children)x.setAttribute("aria-pressed",x===b)});
$("themeBtn").onclick=()=>{const dark=document.documentElement.dataset.theme?document.documentElement.dataset.theme==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.dataset.theme=dark?"light":"dark";store.set("theme",document.documentElement.dataset.theme)};
{const th=store.get("theme",null);if(th)document.documentElement.dataset.theme=th}
$("helpBtn").onclick=()=>{$("help").hidden=false};$("helpClose").onclick=()=>{$("help").hidden=true;store.set("helped",true)};
addEventListener("keydown",e=>{if(e.target.closest("input,textarea,select"))return;
  if(e.key==="["){setFold("left",!$("left").classList.contains("folded"))}else if(e.key==="]"){setFold("right",!$("right").classList.contains("folded"))}
  else if(e.key===" "){e.preventDefault();if(state.speed>0){lastSpeed=state.speed;setSpeed(0)}else setSpeed(lastSpeed||2)}else if(e.key==="Escape"){if(!$("studio").hidden){closeStudio();return}$("help").hidden=true;if(state.tracked)untrack()}});
$("aboutTxt").textContent="Ground is an illustrated rendering generated from satellite imagery, at true scale. "+"Truck routes follow the roads of the GAC trip maps. Volumes, service times and capacities are illustrative until real gate and declaration data is connected. Idle emissions assume 8 kg CO₂ per truck-hour of queuing.";

// ===== Planner =====
function renderControls(){const f=state.flow,p=state.params[f];let html="";
  SLIDERS[f].forEach(([group,items],gi)=>{html+=`<details class="grp" ${gi<3?"open":""}><summary>${group}<span class="cnt" data-g="${gi}" hidden></span><svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></summary>`;
    for(const [k,label,mn,mx,stp] of items)html+=`<div class="ctl" id="c_${k}"><label for="s_${k}">${label}</label><output id="o_${k}" class="num"></output><input type="range" id="s_${k}" min="${mn}" max="${mx}" step="${stp}" value="${p[k]}"><span class="base" id="b_${k}"></span></div>`;
    html+=`</details>`});
  $("controls").innerHTML=html;for(const [,items] of SLIDERS[f])for(const it of items){const k=it[0];$("s_"+k).addEventListener("input",e=>setParam(k,+e.target.value,true))}
  refreshOutputs();$("optRes").innerHTML=CAPACITY_KEYS[f].map(k=>`<option value="${k}">${sliderDef(f,k)[1]}</option>`).join("")}
function refreshOutputs(){const f=state.flow,p=state.params[f],b=state.base[f];
  SLIDERS[f].forEach(([,items],gi)=>{let n=0;for(const [k,,mn,mx,,unit] of items){const o=$("o_"+k);if(!o)continue;o.textContent=(k==="surge"&&p[k]>0?"+":"")+p[k]+unit;const ch=p[k]!==b[k];if(ch)n++;
      o.classList.toggle("changed",ch);$("c_"+k).classList.toggle("changed",ch);$("b_"+k).textContent=ch?"baseline "+b[k]+unit:"";const s=$("s_"+k);s.value=p[k];s.style.setProperty("--p",((p[k]-mn)/(mx-mn)*100)+"%")}
    const c=document.querySelector(`.cnt[data-g="${gi}"]`);if(c){c.hidden=!n;c.textContent=n+" changed"}})}
let decorT=null,flyT=null;
function setParam(k,v,user){const f=state.flow,p=state.params[f];const prev=p[k];p[k]=v;if(sim)sim.p[k]=v;refreshOutputs();clearTimeout(decorT);decorT=setTimeout(rebuildCapacity,90);
  if(!user||prev===v)return;const key=stageOfParam(f,k);if(!key||!G.geo.st[key])return;const b=state.base[f][k];const def=sliderDef(f,k);
  if(UNIT_NOUN[k]){const dlt=v-b;showCallout(key,dlt===0?"Back to baseline":(dlt>0?"+":"−")+Math.abs(dlt)+" "+UNIT_NOUN[k],dlt<0)}
  else showCallout(key,`${def[1]}: ${b} → ${v}${def[5]}`,false);
  if(state.show.fly){clearTimeout(flyT);flyT=setTimeout(()=>{if(!follow)flyToStage(key)},450)}}
function applyChanges(ch,user){for(const [k,v] of Object.entries(ch))setParam(k,v,user)}
$("resetBase").onclick=()=>{applyChanges({...state.base[state.flow]});toast("Back to baseline")};
$("setBase").onclick=()=>{state.base[state.flow]={...state.params[state.flow]};delete state.baseFc[state.flow];refreshOutputs();rebuildCapacity();toast("Current scenario is now the baseline")};

// ===== Forecast =====
function fcAvg(flow,params){const a=forecast(flow,params,11),b=forecast(flow,params,23);const m=k=>(a[k]+b[k])/2;
  return{avgH:m("avgH"),p90H:m("p90H"),cleared:Math.round(m("cleared")),peakRoad:Math.round(m("peakRoad")),idleH:m("idleH"),co2t:m("co2t"),util:a.util.map((u,i)=>u==null?null:(u+b.util[i])/2),bottleneck:a.bottleneck,series:a.series.map((s,i)=>({h:s.h,road:(s.road+(b.series[i]?b.series[i].road:s.road))/2,park:s.park}))}}
function baseFc(){const f=state.flow;const key=JSON.stringify(state.base[f]);if(!state.baseFc[f]||state.baseFc[f].key!==key)state.baseFc[f]={key,r:fcAvg(FLOWS[f],state.base[f])};return state.baseFc[f].r}
function compact(r){const st=FLOWS[state.flow].stages;const util={};r.util.forEach((u,i)=>{if(u!=null)util[st[i].en]=Math.round(u*100)+"%"});
  return{avgHoursInPort:+r.avgH.toFixed(2),p90HoursInPort:+r.p90H.toFixed(2),trucksClearedPerDay:r.cleared,peakTrucksQueuedOnPublicRoad:r.peakRoad,idleTruckHoursOnRoad:Math.round(r.idleH),co2TonnesFromIdling:+r.co2t.toFixed(1),bottleneck:r.bottleneck>=0?st[r.bottleneck].en:"none",utilization:util}}
function runForecastUI(){const btn=$("runFc");btn.disabled=true;const lbl=btn.innerHTML;btn.textContent="Simulating…";setTimeout(()=>{const f=state.flow;const B=baseFc();const S=fcAvg(FLOWS[f],state.params[f]);renderFc(B,S);btn.disabled=false;btn.innerHTML=lbl},30)}
function renderFc(B,S){const st=FLOWS[state.flow].stages;$("fcBlock").hidden=false;
  const row=(name,b,s,fmt,lowerBetter=true)=>{const d=s-b;const rel=b?d/b:0;const cls=Math.abs(rel)<0.02?"":(d<0)===lowerBetter?"down":"up";const sign=d>0?"+":d<0?"−":"";return `<tr><td>${name}</td><td>${fmt(b)}</td><td>${fmt(s)}</td><td class="${cls}">${Math.abs(rel)<0.005?"same":sign+Math.abs(rel*100).toFixed(0)+"%"}</td></tr>`};
  const h=v=>v.toFixed(1)+" h",n=v=>Math.round(v).toLocaleString("en-US"),t=v=>v.toFixed(1)+" t";
  let html=`<table class="cmp"><thead><tr><th></th><th>Baseline</th><th>Scenario</th><th>Change</th></tr></thead><tbody>`+row("Average time in port",B.avgH,S.avgH,h)+row("Slowest 10% take",B.p90H,S.p90H,h)+row("Trucks cleared per day",B.cleared,S.cleared,n,false)+row("Peak queue on public road",B.peakRoad,S.peakRoad,n)+row("Truck-hours idling on road",B.idleH,S.idleH,n)+row("CO₂ from idling",B.co2t,S.co2t,t)+`</tbody></table>`;
  const W=300,H=130,pad=26;const mx=Math.max(10,...B.series.map(s=>s.road),...S.series.map(s=>s.road));const pt=s=>`${pad+s.h/24*(W-pad-6)},${H-18-s.road/mx*(H-30)}`;
  const grid=[0,6,12,18,24].map(x=>`<line x1="${pad+x/24*(W-pad-6)}" y1="10" x2="${pad+x/24*(W-pad-6)}" y2="${H-18}" stroke="var(--hair)"/><text x="${pad+x/24*(W-pad-6)}" y="${H-5}" font-size="9" fill="var(--muted)" text-anchor="middle" font-family="JetBrains Mono,monospace">${String(x).padStart(2,"0")}:00</text>`).join("");
  html+=`<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Trucks queued on the public road by hour">${grid}<text x="2" y="14" font-size="9" fill="var(--muted)">${Math.round(mx)}</text><text x="2" y="${H-18}" font-size="9" fill="var(--muted)">0</text><polyline fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-dasharray="4 3" points="${B.series.map(pt).join(" ")}"/><polyline fill="none" stroke="var(--maroon)" stroke-width="2.2" points="${S.series.map(pt).join(" ")}"/></svg>
  <div class="chartkey"><span>Trucks queued on the public road, by hour</span><span><i style="border-color:var(--muted);border-top-style:dashed"></i>Baseline</span><span><i style="border-color:var(--maroon)"></i>Scenario</span></div></div>`;
  const bn=S.bottleneck>=0?st[S.bottleneck].en:"none";const dAvg=S.avgH-B.avgH;
  html+=`<div class="verdict">${Math.abs(dAvg)<0.05?"Average time in port barely moves.":dAvg<0?`Trucks leave <b>${Math.abs(dAvg).toFixed(1)} h sooner</b> on average.`:`Trucks stay <b>${dAvg.toFixed(1)} h longer</b> on average.`} The limiting stage in this scenario is <b>${esc(bn)}</b>${S.bottleneck>=0?` at ${Math.round(S.util[S.bottleneck]*100)}% busy`:""}.</div>`;
  $("fcOut").innerHTML=html;$("fcBlock").scrollIntoView({behavior:"smooth",block:"nearest"})}
$("runFc").onclick=runForecastUI;
$("optTarget").oninput=e=>{$("optTargetV").textContent=e.target.value+" h";e.target.style.setProperty("--p",((e.target.value-1)/11*100)+"%")};$("optTarget").style.setProperty("--p",(3/11*100)+"%");
function optimize(key,target){const f=state.flow;const def=sliderDef(f,key);const p={...state.params[f]};const start=p[key];const tried=[];
  for(let v=start;v<=def[3]+1e-9;v+=def[4]){const r=forecast(FLOWS[f],{...p,[key]:v},11);tried.push([v,r]);if(r.avgH<=target)return{ok:true,v,r,start,def,tried}}return{ok:false,v:def[3],r:tried[tried.length-1][1],start,def,tried}}
$("runOpt").onclick=()=>{const key=$("optRes").value,target=+$("optTarget").value;const btn=$("runOpt");btn.disabled=true;btn.textContent="Testing values…";
  setTimeout(()=>{const res=optimize(key,target);btn.disabled=false;btn.textContent="Find it";const st=FLOWS[state.flow].stages;const lab=res.def[1];let html;
    if(res.ok&&res.v===res.start)html=`<div class="verdict">Already met: ${lab.toLowerCase()} at ${res.v} gives ${fmtH(res.r.avgH)} average.</div>`;
    else if(res.ok)html=`<div class="verdict">${lab}: <b>${res.start} → ${res.v}</b> brings the average to ${fmtH(res.r.avgH)} (${res.tried.length} values tested).</div><div class="row"><button class="btn primary" id="optApply">Apply ${res.v} and show me</button></div>`;
    else html=`<div class="verdict">Even at ${res.v}, the average stays at ${fmtH(res.r.avgH)}. ${lab} is not what limits the port. The limiting stage is <b>${res.r.bottleneck>=0?esc(st[res.r.bottleneck].en):"elsewhere"}</b>.</div>`;
    $("optOut").innerHTML=html;const a=$("optApply");if(a)a.onclick=()=>{setParam(key,res.v,true);toast(lab+" set to "+res.v)}},30)};
function setFlow(f){state.flow=f;$("fImport").setAttribute("aria-pressed",f==="import");$("fExport").setAttribute("aria-pressed",f==="export");buildWorld();startSim();renderControls();$("fcBlock").hidden=true;$("optOut").innerHTML="";renderChips();
  clearFilters();renderTTMChips();runTTM();$("planChip").hidden=true;document.body.classList.remove("hasPlan");closeStudio();GS.key=null;GS.touched=false;if($("left").querySelector('[data-ppane="goal"]').classList.contains("on"))refreshGoalNow()}
$("fImport").onclick=()=>setFlow("import");$("fExport").onclick=()=>setFlow("export");

// ===== Ask the twin =====
let sample=null,turns=[],ctl=null,blocked=false;
const CHIPS={import:["What if traffic is 40% higher during Eid?","What is the cheapest way to get average time in port under 4 hours?","ماذا لو خفضنا المواقف الخارجية إلى ٥٠ موقفاً؟"],export:["Why do export trucks wait so long?","Would a second permit gate or more operational parking help more?","ماذا يحدث لو زادت الشاحنات ٣٠٪؟"]};
function renderChips(){$("chips").innerHTML=CHIPS[state.flow].map(c=>`<button class="chip" dir="auto">${c}</button>`).join("");for(const b of $("chips").children)b.onclick=()=>{$("q").value=b.textContent;ask()}}
function rules(){const f=state.flow;const st=FLOWS[f].stages.map(s=>s.en+(s.optional?" (optional)":"")).join(" → ");
  return `You are the planning assistant inside a 3D digital twin of the Abu Samra land border customs port between Qatar and Saudi Arabia, built for Qatar’s General Authority of Customs.
Current view: ${f==="import"?"IMPORT flow (trucks arriving from Saudi Arabia)":"EXPORT flow (trucks leaving Qatar for Saudi Arabia)"}. Stages in order: ${st}.
The twin is a discrete-event simulation. Trucks wait in the external parking until the next parking area has a free slot. Capacities, volumes and service times are illustrative placeholders until real GAC data is connected; mention this only when it matters.
Tools: get_state returns the current scenario, the baseline, the allowed range of every parameter, and live status. run_forecast simulates a typical 24-hour day with your changes applied on top of the current scenario and returns KPIs for the scenario and the baseline. apply_changes moves the planner’s controls in the live twin; call it only when the user asks to apply, set or try something in the twin.
Always test with run_forecast instead of guessing. For "cheapest", "minimum" or "which helps more" questions, compare a few options (at most 5 forecasts).
Reply in the same language as the user’s question (Arabic or English). Start with the number that answers the question, then 2 to 4 short sentences on why, naming the bottleneck. Under 120 words. Plain sentences, no headings, no tables, no markdown symbols.`}
function tools(){const f=state.flow;const keys=Object.keys(FLOWS[f].defaults);const props={};
  for(const k of keys){const d=sliderDef(f,k);if(d)props[k]={type:"number",description:`${d[1]} (${d[2]}–${d[3]}${d[5]})`}}
  const clean=ch=>{const out={};for(const [k,v] of Object.entries(ch||{})){const d=sliderDef(f,k);if(!d)throw new Error("Unknown parameter "+k);let n=Number(v);if(!isFinite(n))throw new Error("Not a number: "+k);out[k]=Math.min(d[3],Math.max(d[2],Math.round(n/d[4])*d[4]))}return out};
  const step=t=>{const div=document.createElement("div");div.textContent=t;$("steps").appendChild(div)};
  const desc=ch=>Object.entries(ch).map(([k,v])=>sliderDef(f,k)[1].toLowerCase()+" "+v).join(", ")||"current scenario";
  return[{name:"get_state",description:"Returns current scenario parameters, baseline parameters, allowed ranges, and live port status. Call first.",
    execute:()=>{const live={trucksQueuedOnRoad:sim.roadWaiting(),clock:fmtT(sim.t)};FLOWS[f].stages.forEach((s,i)=>{if(i>0)live[s.en]=sim.stages[i].occ+"/"+sim.cap(i)});const ranges={};for(const k of keys){const d=sliderDef(f,k);if(d)ranges[k]={label:d[1],min:d[2],max:d[3],step:d[4],unit:d[5].trim()}}step("Read the current scenario");return{flow:f,scenario:state.params[f],baseline:state.base[f],ranges,live}}},
   {name:"run_forecast",description:"Simulates a typical 24-hour day with the given parameter changes applied on top of the current scenario. Returns scenario KPIs and baseline KPIs.",inputSchema:{type:"object",properties:{changes:{type:"object",properties:props,description:"Parameters to change. Empty object = current scenario as is."}},required:["changes"]},
    execute:async input=>{const ch=clean(input.changes);step("Forecast: "+desc(ch));await new Promise(r=>setTimeout(r,20));const S=fcAvg(FLOWS[f],{...state.params[f],...ch});return{testedChanges:ch,scenario:compact(S),baseline:compact(baseFc())}}},
   {name:"apply_changes",description:"Sets the planner controls in the live twin to these values so the user sees the effect. Only when the user asked to apply or try something.",inputSchema:{type:"object",properties:{changes:{type:"object",properties:props}},required:["changes"]},
    execute:input=>{const ch=clean(input.changes);applyChanges(ch,true);step("Applied: "+desc(ch));toast("Twin updated: "+desc(ch));return{applied:ch,scenario:state.params[f]}}}]}
async function ask(){const q=$("q").value.trim();if(!q||!sample||blocked)return;ctl?.abort();ctl=new AbortController();$("steps").innerHTML="";$("answer").textContent="Thinking…";$("askBtn").disabled=true;$("stopBtn").hidden=false;
  turns.push({role:"user",content:q});if(turns.length>8)turns=turns.slice(-8);while(turns[0]&&turns[0].role!=="user")turns.shift();
  const clean=t=>t.replace(/\*\*/g,"").replace(/^#+\s*/gm,"").trim();
  try{const {text}=await sample([{role:"user",content:rules()},...turns],{tools:tools(),signal:ctl.signal,onText:({text})=>{$("answer").textContent=clean(text)}});const final=clean(text);$("answer").textContent=final;turns.push({role:"assistant",content:final})}
  catch(e){const keep=e&&e.text?clean(e.text):"";const msg={not_granted:"Claude isn’t allowed for this page. Use the planner instead.",rate_limited:"Too many questions in a row. Wait a minute and ask again.",cancelled:"Stopped.",tools_unavailable:"This view can’t run the simulation tools. Use the planner instead."}[e&&e.code]||"The answer was interrupted. Ask again.";
    $("answer").textContent=(keep?keep+"\n\n":"")+msg;turns.pop();if(e&&(e.code==="not_granted"||e.code==="sampling_disabled"))blocked=true}
  finally{$("askBtn").disabled=blocked;$("stopBtn").hidden=true}}
$("askBtn").onclick=ask;$("stopBtn").onclick=()=>ctl?.abort();$("q").addEventListener("keydown",e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey))ask()});
async function initCaps(){if(!window.claude||!window.claude.use)return;
  claude.use("sample").then(s=>{if(s){sample=s;$("askTab").hidden=false;renderChips()}}).catch(()=>{});
  claude.use("downloads").then(d=>{if(!d)return;$("csvBtn").hidden=false;$("csvBtn").onclick=async()=>{const base=new Date();base.setHours(0,0,0,0);const st=G.flow.stages;const lines=["timestamp,plate,country,checkpoint,checkpoint_ar,flow"];
    for(const e of sim.events){const ts=new Date(base.getTime()+(e.t-1440)*60000);const iso=ts.getFullYear()+"-"+String(ts.getMonth()+1).padStart(2,"0")+"-"+String(ts.getDate()).padStart(2,"0")+"T"+fmtT(e.t);const s=e.stage>=0?st[e.stage]:{en:"Left the port",ar:"غادر المنفذ"};lines.push([iso,e.plate,e.plate.split(" ")[0],s.en,s.ar,state.flow].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(","))}
    if(lines.length<2){toast("No gate reads yet. Let the twin run a little.");return}try{await d.save({filename:`abu-samra-${state.flow}-gate-events.csv`,data:"﻿"+lines.join("\n")})}catch(err){if(err&&err.code==="unavailable")$("csvBtn").hidden=true}}}).catch(()=>{})}
const _rel=Sim.prototype.release;Sim.prototype.release=function(tr){_rel.call(this,tr);if(this.events)this.events.push({t:this.t,plate:tr.plate,stage:-1})};
// ===== Live filters and bottleneck pattern =====
const ORIG_LABEL={KSA:"Saudi Arabia",UAE:"UAE",TUR:"Türkiye",IND:"India",OMN:"Oman",CHN:"China",KWT:"Kuwait",JOR:"Jordan",EGY:"Egypt",BHR:"Bahrain",IRQ:"Iraq"};
state.filter={o:new Set(),k:new Set(),lane:null,aeo:null,pre:null};
function filterActive(){const F=state.filter;return !!(F&&(F.o.size||F.k.size||F.lane||F.aeo!=null||F.pre!=null))}
function matchF(tr){const F=state.filter,a=tr.a;if(!a)return false;if(F.o.size&&!F.o.has(a.o))return false;if(F.k.size&&!F.k.has(a.k))return false;
  if(F.lane&&(F.lane==="red")!==a.red)return false;if(F.aeo!=null&&F.aeo!==a.aeo)return false;if(F.pre!=null&&F.pre!==a.pre)return false;return true}
const originsOf=f=>ORIGINS[f]||ORIGINS.import;
const originName=(f,i)=>{const o=originsOf(f)[i];return o?ORIG_LABEL[o[0]]||o[0]:"?"};
function facets(){const f=state.flow;return[
  {id:"lane",label:"Risk lane",single:true,vals:[{v:"red",label:"Red: physical inspection",sw:"var(--red-lane)",t:a=>a.red},{v:"green",label:"Green: no inspection",sw:"var(--green-lane)",t:a=>!a.red}]},
  {id:"aeo",label:"Authorized Economic Operator (AEO)",single:true,vals:[{v:true,label:"AEO",t:a=>a.aeo},{v:false,label:"Not AEO",t:a=>!a.aeo}]},
  {id:"pre",label:"Pre-arrival declaration",single:true,vals:[{v:true,label:"Filed",t:a=>a.pre},{v:false,label:"Not filed",t:a=>!a.pre}]},
  {id:"o",label:f==="import"?"Country of loading":"Destination",vals:originsOf(f).map((o,i)=>({v:i,label:ORIG_LABEL[o[0]]||o[0],t:a=>a.o===i}))},
  {id:"k",label:"Cargo",vals:CARGO.map((c,i)=>({v:i,label:c[0],t:a=>a.k===i}))}]}
const isOn=(fc,v)=>fc.single?state.filter[fc.id]===v:state.filter[fc.id].has(v);
function toggleF(fc,v){const F=state.filter;if(fc.single)F[fc.id]=F[fc.id]===v?null:v;else{if(F[fc.id].has(v))F[fc.id].delete(v);else F[fc.id].add(v)}renderFilters();updateFilterPanel(true)}
function clearFilters(){state.filter={o:new Set(),k:new Set(),lane:null,aeo:null,pre:null};renderFilters();updateFilterPanel(true)}
function renderFilters(){const fcs=facets();
  $("fGroups").innerHTML=fcs.map((fc,gi)=>`<div class="fgroup"><span>${esc(fc.label)}</span><div class="chips">${fc.vals.map((v,vi)=>`<button class="chip" data-g="${gi}" data-v="${vi}" aria-pressed="${isOn(fc,v.v)}">${v.sw?`<i class="sw" style="background:${v.sw}"></i>`:""}${esc(v.label)}</button>`).join("")}</div></div>`).join("");
  for(const b of $("fGroups").querySelectorAll(".chip"))b.onclick=()=>{const fc=fcs[+b.dataset.g];toggleF(fc,fc.vals[+b.dataset.v].v)};
  const F=state.filter;const n=F.o.size+F.k.size+(F.lane?1:0)+(F.aeo!=null?1:0)+(F.pre!=null?1:0);
  $("filtersTab").innerHTML="Filters"+(n?`<span class="badge">${n}</span>`:"");renderLegend()}
let patT=0;
function updateFilterPanel(force){if(!sim)return;const vis=$("right").querySelector('[data-pane="filters"]').classList.contains("on")&&!$("right").classList.contains("folded");if(!vis&&!force)return;
  const st=G.flow.stages,fa=filterActive();let n=0,m=0,hs=0;const per=st.map(()=>0);
  for(const tr of sim.active.values()){if(tr.stage<=0)continue;n++;if(!fa||matchF(tr)){m++;hs+=(sim.t-tr.arr)/60;per[tr.stage]++}}
  $("fSum").innerHTML=fa?`<b>${m}</b><span>of ${n} trucks in the port match</span>${m?`<span class="num" style="color:var(--muted)">· ${(hs/m).toFixed(1)} h so far</span>`:""}<button class="btn ghost clr" id="fClear" style="padding:5px 9px">Clear</button>`
    :`<b>${n}</b><span>trucks in the port. No filter set.</span>`;
  const fc=$("fClear");if(fc)fc.onclick=clearFilters;
  const mx=Math.max(1,...per);$("fOcc").innerHTML=st.map((s,i)=>i===0?"":`<div class="r" data-k="${s.key}"><span class="nm"><i class="z-${s.zone}">${s.num}</i>${esc(s.en)}</span><span class="vv">${per[i]}</span><span class="bar"><b style="width:${per[i]/mx*100}%;background:var(--maroon)"></b></span></div>`).join("");
  for(const el of $("fOcc").children)el.onclick=()=>flyToStage(el.dataset.k);
  const now=performance.now();if(force||now-patT>1200){patT=now;renderPattern()}}
const PATTERN_WHY={lane:{red:"Red-lane trucks wait for physical inspection. AI risk targeting or more AEO members move trucks to the green lane."},
  aeo:{false:"Operators outside the AEO programme are inspected more often. Growing AEO membership shrinks this group."},
  pre:{false:"Without a pre-arrival declaration, clearance takes longer. Requiring pre-arrival filing shortens their stay."}};
function renderPattern(){const st=G.flow.stages;let bn=bottleneck(),busiest=false;
  if(bn<0){let bu=0.7;st.forEach((s,i)=>{if(i===0)return;const c=sim.cap(i);if(!(c>0)||!isFinite(c))return;const u=sim.stages[i].occ/c;if(u>bu){bu=u;bn=i;busiest=true}})}
  if(bn<0){$("pattern").innerHTML=`<p class="hint" style="margin:0">No stage is holding trucks right now. A pattern appears when a stage fills up and trucks queue for it.</p>`;return}
  const held=[...sim.stages[bn].queue];for(const tr of sim.active.values())if(tr.stage===bn)held.push(tr);
  const all=[...sim.active.values()].filter(t=>t.a);const H=held.filter(t=>t.a);
  const head=`<div class="bnhead">${busiest?"Busiest stage":"Bottleneck now"}: <b>${esc(st[bn].en)}</b><span class="num" style="margin-left:auto">${H.length} held</span></div>`;
  if(H.length<5){$("pattern").innerHTML=head+`<p class="hint" style="margin:8px 0 0">Too few trucks held there to read a pattern yet.</p>`;return}
  const cand=[];for(const fc of facets())for(const v of fc.vals){const sH=H.filter(t=>v.t(t.a)).length/H.length,sA=all.filter(t=>v.t(t.a)).length/Math.max(1,all.length);
    if(sH>=0.25&&sA>0&&sH/sA>=1.2)cand.push({fc,v,sH,sA,lift:sH/sA})}
  cand.sort((a,b)=>(b.sH-b.sA)-(a.sH-a.sA));const top=[];const seen=new Set();for(const c of cand){if(seen.has(c.fc.id))continue;seen.add(c.fc.id);top.push(c);if(top.length===3)break}
  if(!top.length){$("pattern").innerHTML=head+`<p class="hint" style="margin:8px 0 0">Trucks held at ${esc(st[bn].en.toLowerCase())} look like the rest of the port: no lane, operator, origin or cargo stands out. This is a capacity limit, so more lanes or faster processing there will help more than risk or paperwork programmes.</p>`;return}
  const why=c=>{const w=PATTERN_WHY[c.fc.id];if(w&&w[String(c.v.v)])return w[String(c.v.v)];if(c.fc.id==="o")return state.flow==="import"?`Loads from ${c.v.label} carry a higher risk score and are sent to inspection more often.`:`Trucks bound for ${c.v.label} carry a higher risk score.`;if(c.fc.id==="k")return `${c.v.label} carry a higher risk score and are inspected more often.`;return ""};
  $("pattern").innerHTML=head+`<div class="pattern">${top.map(c=>`<div class="p"><span><b>${esc(c.fc.label)}: ${esc(c.v.label)}</b></span><span class="lift">${c.lift.toFixed(1)}×</span>
    <span class="cmpbar" title="${Math.round(c.sH*100)}% at the bottleneck, ${Math.round(c.sA*100)}% port-wide"><b style="width:${c.sH*100}%"></b><s style="left:calc(${c.sA*100}% - 1px)"></s></span>
    <small>${Math.round(c.sH*100)}% of trucks held here, against ${Math.round(c.sA*100)}% port-wide (black tick). ${esc(why(c))}</small></div>`).join("")}</div>
    <div class="row"><button class="btn" id="patApply">Show these trucks on the map</button></div>`;
  $("patApply").onclick=()=>{clearFilters();const c=top[0];toggleF(c.fc,c.v.v);toast("Showing "+c.fc.label.toLowerCase()+": "+c.v.label.toLowerCase()+". Other trucks are grey.")}}
const attrsHTML=a=>`<div class="attrs"><span class="${a.red?"red":"green"}">${a.red?"Red lane":"Green lane"}</span><span>${a.aeo?"AEO operator":"Not AEO"}</span><span>${a.pre?"Pre-arrival filed":"No pre-arrival filing"}</span><span>${esc((state.flow==="import"?"Loaded in ":"To ")+originName(state.flow,a.o))}</span><span>${esc(CARGO[a.k][0])}</span></div>`;

// ===== Planner tabs =====
function setPtab(k){for(const b of document.querySelectorAll(".ptabs button"))b.setAttribute("aria-selected",b.dataset.ptab===k);for(const p of document.querySelectorAll("#left .pane"))p.classList.toggle("on",p.dataset.ppane===k);
  if(k==="goal")refreshGoalNow();store.set("ptab",k)}
for(const b of document.querySelectorAll(".ptabs button"))b.onclick=()=>setPtab(b.dataset.ptab);

// ===== Text to map =====
const TTM_EX={import:["Add 2 X-ray lanes and cut clearance time by 30 minutes","Open one more appointment gate, expand main parking by 100 slots","Raise AEO membership to 40% and get pre-arrival declarations to 70%","Traffic grows 20% during Eid, add 20 inspection ramps","أضف ٢ مسارات أشعة وخفض وقت التخليص ٣٠ دقيقة"],
  export:["Add a second permit gate and 4 operational parking slots","Cut document time by 20 minutes and open another release lane","Raise AEO membership to 40%","زيادة رمبات التفتيش إلى ١٤"]};
let ttmRes=null;
const fmtV=(v,u)=>(Math.round(v*100)/100)+(u||"");
function runTTM(){const txt=$("ttmIn").value;ttmRes=txt.trim()?parseText(txt,state.flow,state.params[state.flow],sliderDef):null;renderTTM()}
function renderTTM(){const ul=$("ttmOut");if(!ttmRes){ul.innerHTML="";$("ttmApply").disabled=true;$("ttmApply").textContent="Apply to what-if";return}
  ul.innerHTML=ttmRes.items.map(it=>`<li><span class="ic">✓</span><span>${esc(it.label)}: <b class="v">${fmtV(it.from,it.unit)} → ${fmtV(it.to,it.unit)}</b>${it.clamped?" (held to the planner's range)":""}</span><span class="q" dir="auto">“${esc(it.text)}”</span></li>`).join("")
    +ttmRes.ignored.map(g=>`<li class="skip"><span class="ic">–</span><span>Ignored. ${esc(g.why)}.</span><span class="q" dir="auto">“${esc(g.text)}”</span></li>`).join("");
  const n=Object.keys(ttmRes.changes).length;$("ttmApply").disabled=!n;$("ttmApply").textContent=n?`Apply ${n} change${n>1?"s":""} to what-if`:"Apply to what-if"}
$("ttmIn").addEventListener("input",()=>{clearTimeout(runTTM._t);runTTM._t=setTimeout(runTTM,200)});
$("ttmApply").onclick=()=>{if(!ttmRes)return;const ch=ttmRes.changes,n=Object.keys(ch).length;applyChanges(ch,true);setPtab("whatif");toast(`Applied ${n} change${n>1?"s":""}. Running the forecast.`);setTimeout(runForecastUI,700)};
$("ttmClear").onclick=()=>{$("ttmIn").value="";ttmRes=null;renderTTM()};
function renderTTMChips(){$("ttmChips").innerHTML=TTM_EX[state.flow].map(c=>`<button class="chip" dir="auto">${esc(c)}</button>`).join("");for(const b of $("ttmChips").children)b.onclick=()=>{$("ttmIn").value=b.textContent;runTTM()}}

// ===== Forecast workers: goal seeking runs many forecasts, so they go to a small Web Worker pool =====
const POOL={ws:[],idle:[],q:[],jobs:new Map(),id:0,mode:null,init:null};
function poolInit(){if(POOL.init)return POOL.init;
  POOL.init=new Promise(res=>{try{
    const src=SIM_SRC+"\nself.onmessage=function(e){var m=e.data;if(m.ping){postMessage({id:m.id,pong:1});return}var F=m.flow==='import'?IMPORT:EXPORT;F.drive=m.drive;var r=forecast(F,m.params,m.seed);"
      +"postMessage({id:m.id,r:{avgH:r.avgH,p90H:r.p90H,cleared:r.cleared,peakRoad:r.peakRoad,idleH:r.idleH,co2t:r.co2t,util:r.util,bottleneck:r.bottleneck}})};";
    const url=URL.createObjectURL(new Blob([src],{type:"text/javascript"}));const n=Math.max(2,Math.min(6,(navigator.hardwareConcurrency||4)-2));let ok=0;
    const to=setTimeout(()=>{if(!ok){POOL.ws.forEach(w=>w.terminate());POOL.ws=[];POOL.mode="main";res("main")}},3000);
    for(let i=0;i<n;i++){const w=new Worker(url);w.onmessage=e=>{const m=e.data;if(m.pong){if(!ok++){clearTimeout(to);POOL.mode="workers";res("workers")}POOL.idle.push(w);pump();return}
        const j=POOL.jobs.get(m.id);POOL.jobs.delete(m.id);POOL.idle.push(w);if(j)j.resolve(m.r);pump()};POOL.ws.push(w);w.postMessage({ping:1,id:-1})}
  }catch(e){POOL.mode="main";res("main")}});return POOL.init}
function pump(){while(POOL.idle.length&&POOL.q.length){const w=POOL.idle.pop(),j=POOL.q.shift();POOL.jobs.set(j.id,j);w.postMessage({id:j.id,flow:j.flow,params:j.params,seed:j.seed,drive:FLOWS[j.flow].drive||null})}}
async function evalMany(flow,list,seed){seed=seed||11;await poolInit();
  if(POOL.mode==="workers")return Promise.all(list.map(p=>new Promise(resolve=>{POOL.q.push({id:++POOL.id,flow,params:p,seed,resolve});pump()})));
  const out=[];for(const p of list){out.push(forecast(FLOWS[flow],p,seed));await new Promise(r=>setTimeout(r,0))}return out}

// ===== Goal seek =====
const GS={now:null,key:null,res:null,running:false,touched:false};
const fg=t=>(+t).toFixed(Math.round(t*4)%2?2:1);
const qar=v=>v>=100?Math.round(v)+"":v>=10?v.toFixed(0):v.toFixed(1);
function setGoal(t){const s=$("gsTarget");s.value=t;const v=+s.value;$("gsTargetO").textContent=fg(v)+" h";$("gsTargetV").innerHTML=`${fg(v)}<small>h</small>`;s.style.setProperty("--p",((v-s.min)/(s.max-s.min)*100)+"%")}
$("gsTarget").oninput=e=>{GS.touched=true;setGoal(+e.target.value)};
$("gsGrowth").oninput=e=>{$("gsGrowthO").textContent=e.target.value+"%";e.target.style.setProperty("--p",(e.target.value/15*100)+"%")};$("gsGrowth").style.setProperty("--p",(5/15*100)+"%");
async function refreshGoalNow(){const f=state.flow;const key=pkey(f,state.base[f]);if(GS.key===key&&GS.now!=null)return GS.now;GS.key=key;GS.now=null;$("gsNow").innerHTML=`…<small>h</small>`;
  const [r]=await evalMany(f,[{...state.base[f]}]);if(GS.key!==key)return null;GS.now=r.avgH;$("gsNow").innerHTML=`${r.avgH.toFixed(1)}<small>h</small>`;
  const s=$("gsTarget");s.max=Math.max(12,Math.ceil(r.avgH));if(!GS.touched)setGoal(Math.max(1,Math.round(r.avgH*0.65*4)/4));else setGoal(+s.value);return r.avgH}
function gsProgress(f,msg){$("gsProg").hidden=f==null;if(f!=null)$("gsProg").firstElementChild.style.width=(f*100)+"%";if(msg!=null)$("gsStatus").textContent=msg}
$("gsRun").onclick=async()=>{if(GS.running)return;const f=state.flow,target=+$("gsTarget").value,growth=+$("gsGrowth").value;const btn=$("gsRun");
  GS.running=true;btn.disabled=true;gsProgress(0.03,"Forecasting today's port…");
  try{const now=await refreshGoalNow();
    if(now!=null&&now<=target){gsProgress(null,`Today's forecast (${now.toFixed(1)} h) already meets ${fg(target)} h. Set a lower goal.`);return}
    const t0=performance.now();let nEval=0;const ev=async(list,seed)=>{nEval+=list.length;return evalMany(f,list,seed)};const base={...state.base[f]};
    const res=await goalSeek({flow:f,base,target,evalMany:ev,sliderDef,maxSteps:8,onProgress:(r,m)=>gsProgress(0.05+0.75*r/m,`Round ${r}: testing every lever for each of the three plans…`)});
    gsProgress(0.85,"Projecting the next three years…");
    const proj=await projectPlans({flow:f,base,plans:res.plans,growth,evalMany:ev,sliderDef});
    GS.res={...res,target,growth,flow:f,nEval,secs:(performance.now()-t0)/1000,proj};
    gsProgress(null,`${nEval} scenarios simulated in ${GS.res.secs.toFixed(0)} s${POOL.mode==="workers"?` on ${POOL.ws.length} parallel workers`:""}.`);
    renderMini();openStudio()}
  catch(e){gsProgress(null,"The search stopped: "+(e&&e.message||e))}
  finally{GS.running=false;btn.disabled=false}};
function renderMini(){const R=GS.res;if(!R){$("gsMini").innerHTML="";return}
  $("gsMini").innerHTML=R.plans.map(p=>`<li data-id="${p.id}"><i style="background:var(${p.color})"></i>${esc(p.name)}<span class="n">${p.result.avgH.toFixed(1)} h · QAR ${qar(p.cost5)}M</span></li>`).join("")+`<li data-open="1"><span>Open the plan comparison</span></li>`;
  for(const li of $("gsMini").children)li.onclick=()=>openStudio()}
function monthsToGoal(R,p){const s=R.proj[p.id];const hit=s.find(q=>q.avgH<=R.target);return hit?hit.m:null}
function groupSteps(p){const g=new Map();for(const s of p.steps){const k=s.lever.key;if(!g.has(k))g.set(k,{l:s.lever,n:0,gain:0});const x=g.get(k);x.n++;x.gain+=s.gain}return[...g.values()]}
function openStudio(){const R=GS.res;if(!R)return;$("studio").hidden=false;const f=R.flow;
  $("stNow").textContent=R.start.avgH.toFixed(1)+" h";$("stGoal").textContent=fg(R.target)+" h";
  $("stTitle").textContent=(f==="import"?"Import":"Export")+": three ways to reach the goal";
  $("stSub").textContent=`Each plan was built one lever at a time, testing every option in the twin and keeping the best by its own rule. The projection lets demand grow ${R.growth}% a year and switches each change on once its lead time has passed.`;
  const cards=R.plans.map(p=>{const m=monthsToGoal(R,p);const gs=groupSteps(p);
    const met=m!=null?`<p class="met">✓ Meets the goal ${m===0?"right away":`from month ${m}`}, with demand growing ${R.growth}% a year</p>`:p.met?`<p class="met no">Meets the goal at today's demand, but growth of ${R.growth}% a year erodes it within three years</p>`:`<p class="met no">Gets to ${p.result.avgH.toFixed(1)} h. The goal needs more than these levers can give</p>`;
    const items=gs.length?gs.map(x=>`<li><span>${esc(x.l.label)}${x.n>1?` ×${x.n}`:""}</span><span class="c">QAR ${qar(x.l.capex*x.n)}M${x.l.opex?` + ${qar(x.l.opex*x.n)}M/yr`:""}</span><span class="g">saves ${x.gain.toFixed(1)} h · in service after ${x.l.lead} mo</span></li>`).join("")
      :`<li><span>No lever moved the average by more than a few minutes. The limit is outside the planner (demand, or a stage without a lever).</span></li>`;
    return `<article class="plan" style="--pc:var(${p.color})"><h3><i></i>${esc(p.name)}</h3><p class="blurb">${esc(p.blurb)}</p>
      <div class="stats"><div><span>5-year cost</span><b>${qar(p.cost5)}<small>QAR M</small></b></div><div><span>All in service</span><b>${p.lead}<small>months</small></b></div><div><span>Average then</span><b>${p.result.avgH.toFixed(1)}<small>h</small></b></div></div>
      ${met}<ol>${items}</ol><button class="btn primary" data-viz="${p.id}" ${p.steps.length?"":"disabled"}>Visualize in the twin</button></article>`}).join("");
  $("stBody").innerHTML=cards+`<section class="vizcard span2"><h4>Average time in port over the next three years</h4><p>Doing nothing versus each plan, as demand grows ${R.growth}% a year. Hover to read the months.</p><div id="chProj"></div></section>
    <section class="vizcard"><h4>Cost against hours saved</h4><p>Five-year cost in QAR millions, hours saved at today's demand.</p><div id="chCost"></div></section>`;
  $("stFoot").textContent=`Costs are indicative QAR millions: capital plus five years of running cost. ${R.nEval} scenarios simulated with the twin's placeholder volumes and service times; replace them with GAC data for decisions.`;
  for(const b of $("stBody").querySelectorAll("[data-viz]"))b.onclick=()=>visualizePlan(b.dataset.viz);
  drawProjection($("chProj"),R);drawCost($("chCost"),R)}
function closeStudio(){$("studio").hidden=true;$("vtip").hidden=true}
$("stClose").onclick=closeStudio;
function niceMax(v){const e=Math.pow(10,Math.floor(Math.log10(v)));for(const m of [1,1.5,2,2.5,3,4,5,6,8,10])if(m*e>=v)return m*e;return 10*e}
function tipAt(ev,html){const t=$("vtip");t.innerHTML=html;t.hidden=false;const w=t.offsetWidth,h=t.offsetHeight;let x=ev.clientX+14,y=ev.clientY+14;if(x+w>innerWidth-8)x=ev.clientX-w-14;if(y+h>innerHeight-8)y=ev.clientY-h-14;t.style.left=x+"px";t.style.top=y+"px"}
function drawProjection(el,R){const W=760,H=290,L=46,Rp=128,T=14,B=30,pw=W-L-Rp,ph=H-T-B;const M=PROJ_MONTHS,mx=M[M.length-1];
  const series=[{id:"base",name:"Do nothing",col:"var(--s0)",dash:"6 4",pts:R.proj.base},...R.plans.map(p=>({id:p.id,name:p.name,col:`var(${p.color})`,pts:R.proj[p.id]}))];
  const all=series.flatMap(s=>s.pts.map(q=>q.avgH));const planMax=Math.max(R.start.avgH,...R.plans.flatMap(p=>R.proj[p.id].map(q=>q.avgH)));
  const ymax=niceMax(Math.min(Math.max(...all),Math.max(planMax*1.15,R.start.avgH*1.6,R.target*1.5))*1.05);
  const X=m=>L+m/mx*pw,Y=v=>T+ph-Math.min(v,ymax*1.04)/ymax*ph;
  const ystep=[1,2,2.5,5,10].map(m=>m*Math.pow(10,Math.floor(Math.log10(ymax/4)))).find(v=>ymax/v<=5);const yt=[];for(let v=0;v<=ymax+1e-9;v+=ystep)yt.push(v);
  let s=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average time in port by month for doing nothing and each plan"><defs><clipPath id="pclip"><rect x="${L}" y="${T-4}" width="${pw+6}" height="${ph+4}"/></clipPath></defs>`;
  s+=yt.map(v=>`<line x1="${L}" x2="${L+pw}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--hair)" stroke-width="1"/><text x="${L-8}" y="${Y(v)+3.5}" text-anchor="end" font-size="10.5" fill="var(--muted)" font-family="JetBrains Mono,monospace">${v%1?v.toFixed(1):v} h</text>`).join("");
  s+=[0,6,12,18,24,30,36].map(m=>`<text x="${X(m)}" y="${H-10}" text-anchor="middle" font-size="10.5" fill="var(--muted)" font-family="JetBrains Mono,monospace">${m?m+" mo":"Now"}</text>`).join("");
  s+=`<line x1="${L}" x2="${L+pw}" y1="${Y(R.target)}" y2="${Y(R.target)}" stroke="var(--ink-2)" stroke-width="1.2" stroke-dasharray="2 3"/><text x="${L+pw-4}" y="${Y(R.target)+15}" text-anchor="end" font-size="11" fill="var(--ink-2)" font-weight="600">Goal ${fg(R.target)} h</text>`;
  s+=`<g clip-path="url(#pclip)">`+series.map(se=>`<polyline fill="none" stroke="${se.col}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" ${se.dash?`stroke-dasharray="${se.dash}"`:""} points="${se.pts.map(q=>X(q.m)+","+Y(q.avgH)).join(" ")}"/>`).join("")+`</g>`;
  // direct labels at the right end, nudged apart so they never overlap
  const ends=series.map(se=>{const v=se.pts[se.pts.length-1].avgH;return{se,v,y:Y(v),off:v>ymax}}).sort((a,b)=>a.y-b.y);for(let i=1;i<ends.length;i++)if(ends[i].y-ends[i-1].y<15)ends[i].y=ends[i-1].y+15;
  s+=ends.map(e=>`<circle cx="${X(mx)}" cy="${Y(e.v)}" r="3.5" fill="${e.se.col}" stroke="var(--solid)" stroke-width="2"/><text x="${X(mx)+10}" y="${e.y+4}" font-size="11.5" fill="var(--ink)"><tspan font-weight="600">${esc(e.se.name)}</tspan><tspan fill="var(--muted)" font-family="JetBrains Mono,monospace"> ${e.off?"↑":""}${e.v.toFixed(1)} h</tspan></text>`).join("");
  s+=`<line id="pcross" x1="0" x2="0" y1="${T}" y2="${T+ph}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/><g id="pdots"></g><rect x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent" id="phit"/></svg>`;
  s+=`<div class="lg">${series.map(se=>`<span><i style="border-color:${se.col};${se.dash?"border-top-style:dashed":""}"></i>${esc(se.name)}</span>`).join("")}<span><i style="border-color:var(--ink-2);border-top-style:dotted"></i>Goal</span></div>`;
  el.innerHTML=s;const svg=el.querySelector("svg"),hit=el.querySelector("#phit"),cross=el.querySelector("#pcross"),dots=el.querySelector("#pdots");
  hit.addEventListener("mousemove",ev=>{const r=svg.getBoundingClientRect();const x=(ev.clientX-r.left)/r.width*W;let bi=0;M.forEach((m,i)=>{if(Math.abs(X(m)-x)<Math.abs(X(M[bi])-x))bi=i});const m=M[bi];
    cross.setAttribute("x1",X(m));cross.setAttribute("x2",X(m));cross.setAttribute("visibility","visible");
    dots.innerHTML=series.map(se=>`<circle cx="${X(m)}" cy="${Y(se.pts[bi].avgH)}" r="4.5" fill="${se.col}" stroke="var(--solid)" stroke-width="2"/>`).join("");
    tipAt(ev,`<div class="h">${m?"Month "+m:"Now"}</div>`+series.map(se=>`<div class="r"><i style="background:${se.col}"></i><span>${esc(se.name)}</span><b>${se.pts[bi].avgH.toFixed(1)} h</b></div>`).join(""))});
  hit.addEventListener("mouseleave",()=>{cross.setAttribute("visibility","hidden");dots.innerHTML="";$("vtip").hidden=true})}
function drawCost(el,R){const W=380,H=290,L=46,Rp=16,T=14,B=40,pw=W-L-Rp,ph=H-T-B;const need=R.start.avgH-R.target;
  const pts=R.plans.map(p=>({p,x:p.cost5,y:R.start.avgH-p.result.avgH}));const xm=niceMax(Math.max(5,...pts.map(q=>q.x))*1.18),ym=niceMax(Math.max(need,...pts.map(q=>q.y),0.5)*1.25);
  const X=v=>L+v/xm*pw,Y=v=>T+ph-v/ym*ph;
  let s=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Five-year cost against hours saved for each plan">`;
  s+=[0,0.5,1].map(f=>f*ym).map(v=>`<line x1="${L}" x2="${L+pw}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--hair)"/><text x="${L-8}" y="${Y(v)+3.5}" text-anchor="end" font-size="10.5" fill="var(--muted)" font-family="JetBrains Mono,monospace">${v.toFixed(1)} h</text>`).join("");
  s+=[0,0.5,1].map(f=>f*xm).map(v=>`<text x="${X(v)}" y="${T+ph+16}" text-anchor="middle" font-size="10.5" fill="var(--muted)" font-family="JetBrains Mono,monospace">${qar(v)}</text>`).join("")+`<text x="${L+pw/2}" y="${H-4}" text-anchor="middle" font-size="11" fill="var(--muted)">QAR million, 5 years</text>`;
  const nl=`Needed ${need.toFixed(1)} h`;s+=`<line x1="${L}" x2="${L+pw}" y1="${Y(need)}" y2="${Y(need)}" stroke="var(--ink-2)" stroke-width="1.2" stroke-dasharray="2 3"/><text x="${L+4}" y="${Y(need)-6}" font-size="11" fill="var(--ink-2)" font-weight="600">${nl}</text>`;
  // label placement: try right, left, above, below each dot; keep the first spot that hits no other label, dot or the goal note
  const boxes=[[L+2,Y(need)-17,L+8+nl.length*6.2,Y(need)-3],...pts.map(q=>[X(q.x)-9,Y(q.y)-9,X(q.x)+9,Y(q.y)+9])];
  const hitB=b=>boxes.some(o=>b[0]<o[2]&&b[2]>o[0]&&b[1]<o[3]&&b[3]>o[1]);const labs=[];
  for(const q of [...pts].sort((a,b)=>b.y-a.y)){const w=q.p.name.length*6.8+4,cx=X(q.x),cy=Y(q.y);
    const opts=[[cx+12,cy-7],[cx-12-w,cy-7],[cx-w/2,cy-26],[cx-w/2,cy+12],[cx+12,cy-24],[cx-12-w,cy-24],[cx+12,cy+10],[cx-12-w,cy+10]];
    let pick=opts.find(([x,y])=>x>=L&&x+w<=W-2&&y>=2&&y+14<=T+ph+2&&!hitB([x,y,x+w,y+14]))||opts[0];boxes.push([pick[0],pick[1],pick[0]+w,pick[1]+14]);labs.push({q,x:pick[0],y:pick[1]})}
  s+=pts.map((q,i)=>`<circle data-i="${i}" cx="${X(q.x)}" cy="${Y(q.y)}" r="7" fill="var(${q.p.color})" stroke="var(--solid)" stroke-width="2" style="cursor:pointer"/>`).join("");
  s+=labs.map(l=>`<text x="${l.x}" y="${l.y+11}" font-size="11.5" fill="var(--ink)" font-weight="600">${esc(l.q.p.name)}</text>`).join("")+`</svg>`;
  s+=`<div class="lg">${pts.map(q=>`<span><i style="border:0;width:9px;height:9px;border-radius:50%;background:var(${q.p.color})"></i>${esc(q.p.name)}: QAR ${qar(q.x)}M, ${q.y.toFixed(1)} h</span>`).join("")}</div>`;
  el.innerHTML=s;for(const c of el.querySelectorAll("circle[data-i]")){const q=pts[+c.dataset.i];
    c.addEventListener("mousemove",ev=>tipAt(ev,`<div class="h">${esc(q.p.name)}</div><div class="r"><span>5-year cost</span><b>QAR ${qar(q.x)}M</b></div><div class="r"><span>Hours saved</span><b>${q.y.toFixed(1)} h</b></div><div class="r"><span>All in service</span><b>${q.p.lead} mo</b></div>`));
    c.addEventListener("mouseleave",()=>{$("vtip").hidden=true});c.addEventListener("click",()=>visualizePlan(q.p.id))}}
function visualizePlan(id){const R=GS.res;if(!R)return;const pl=R.plans.find(p=>p.id===id);if(!pl)return;if(R.flow!==state.flow)setFlow(R.flow);
  closeStudio();setPtab("whatif");setFold("left",false);const f=R.flow,base=state.base[f];const fly=state.show.fly;state.show.fly=false;
  applyChanges({...base},false);const ch={};for(const k in pl.params)if(pl.params[k]!==base[k])ch[k]=pl.params[k];applyChanges(ch,true);state.show.fly=fly;
  const top=[...pl.steps].sort((a,b)=>leverCost(b.lever)-leverCost(a.lever))[0];
  if(top){const key=stageOfParam(f,top.lever.key);setTimeout(()=>{if(G.geo.st[key])flyToStage(key)},500)}
  const c=$("planChip");c.hidden=false;document.body.classList.add("hasPlan");c.querySelector("i").style.background=`var(${pl.color})`;c.querySelector("b").textContent=pl.name+" plan";
  const n=Object.keys(ch).length;toast(`${pl.name} plan in the twin: ${n} change${n>1?"s":""}. Gold marks new capacity.`);setTimeout(runForecastUI,900)}
$("planChipReset").onclick=()=>{applyChanges({...state.base[state.flow]},false);$("planChip").hidden=true;document.body.classList.remove("hasPlan");toast("Back to baseline")};

// ===== Boot =====
buildStatics();setFlow("import");setPtab(store.get("ptab","whatif")=="goal"?"whatif":store.get("ptab","whatif"));resize();requestAnimationFrame(frame);initCaps();
if(!store.get("helped",false))setTimeout(()=>{$("help").hidden=false},1400);
