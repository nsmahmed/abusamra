// Stage chains for both flows. All capacities and times are placeholders until calibrated with GAC data.
// pullTo: trucks leave this buffer only when the named downstream stage has a free (unreserved) slot,
// so the queue waits in the buffer lot instead of at the gates in between.
// pick(p,a): route by truck attributes (red risk lane -> inspection ramps). mul(p,a): per-truck service multiplier
// (a pre-arrival declaration cuts clearance / document time to PRE_CLEAR of the full time).
if(typeof module!=="undefined"){var PRE_CLEAR=require("./sim.js").PRE_CLEAR}
const IMPORT={
  key:"import",parkIdx:4,
  stages:[
    {key:"road",num:"1",en:"Truck road from Saudi Arabia",ar:"طريق الشاحنات القادمة من السعودية",kind:"road",zone:"out",cap:()=>Infinity,svc:()=>[2,0.3]},
    {key:"rad",num:"2",en:"Radiation portals",ar:"بوابات كشف المواد المشعة",kind:"gate",zone:"prop",cap:p=>p.radLanes,svc:p=>[p.radMin,0.3],alpr:true},
    {key:"hold",num:"P",en:"External parking",ar:"المواقف الخارجية",kind:"buffer",zone:"prop",cap:p=>p.holdCap,svc:()=>[1,0.2],optional:p=>p.holdCap>0,pullTo:"park"},
    {key:"appt",num:"3",en:"Appointment check gates",ar:"بوابات التحقق من الموعد",kind:"gate",zone:"prop",cap:p=>p.apptGates,svc:p=>[p.apptMin,0.4],alpr:true},
    {key:"park",num:"4",en:"Main parking",ar:"المواقف الرئيسية",kind:"buffer",zone:"op",cap:p=>p.parking,svc:p=>[p.clearMin,0.6],mul:(p,a)=>a.pre?PRE_CLEAR:1},
    {key:"xray",num:"5",en:"X-ray scanning",ar:"منطقة المسح بالأشعة",kind:"gate",zone:"op",cap:p=>p.xrayLanes,svc:p=>[p.xrayMin,0.25],alpr:true},
    {key:"ramps",num:"6",en:"Inspection ramps",ar:"رمبات التفتيش",kind:"ramps",zone:"op",cap:p=>p.ramps,svc:p=>[p.inspMin,0.5],pick:(p,a)=>a.red},
    {key:"rel",num:"7",en:"Release gate",ar:"بوابة الإفراج",kind:"gate",zone:"op",cap:p=>p.relGates,svc:p=>[p.relMin,0.3],alpr:true}
  ],
  defaults:{daily:900,surge:0,radLanes:2,holdCap:100,apptGates:3,parking:700,xrayLanes:6,ramps:130,relGates:2,
    radMin:1.5,apptMin:3,clearMin:140,xrayMin:4,inspShare:46,inspMin:150,relMin:2,aeoShare:18,preShare:35}
};
const EXPORT={
  key:"export",parkIdx:1,
  stages:[
    {key:"road",num:"1",en:"Truck road from Doha",ar:"طريق الشاحنات القادمة من الدوحة",kind:"road",zone:"out",cap:()=>Infinity,svc:()=>[2,0.3]},
    {key:"ext",num:"2",en:"External parking",ar:"المواقف الخارجية لمنطقة الصادر",kind:"buffer",zone:"prop",cap:p=>p.extPark,svc:p=>[p.docMin,0.6],mul:(p,a)=>a.pre?PRE_CLEAR:1,pullTo:"park"},
    {key:"permit",num:"3",en:"Permit gate",ar:"مخرج المواقف الخارجية",kind:"gate",zone:"prop",cap:p=>p.permitGates,svc:p=>[p.permitMin,0.4],alpr:true},
    {key:"entry",num:"4",en:"Entry check gates",ar:"مدخل منطقة الصادر التشغيلية",kind:"gate",zone:"op",cap:p=>p.entryGates,svc:p=>[p.entryMin,0.3],alpr:true},
    {key:"park",num:"5",en:"Operational parking",ar:"مواقف منطقة الصادر",kind:"buffer",zone:"op",cap:p=>p.parking,svc:p=>[p.parkMin,0.5]},
    {key:"ramps",num:"6",en:"Inspection ramps",ar:"رمبات التفتيش",kind:"ramps",zone:"op",cap:p=>p.ramps,svc:p=>[p.inspMin,0.5],pick:(p,a)=>a.red},
    {key:"rel",num:"7",en:"Release gate",ar:"بوابة الإفراج",kind:"gate",zone:"op",cap:p=>p.relGates,svc:p=>[p.relMin,0.3],alpr:true}
  ],
  defaults:{daily:500,surge:0,extPark:150,permitGates:1,entryGates:2,parking:12,ramps:10,relGates:1,
    docMin:54,permitMin:1.2,entryMin:1.5,parkMin:15,inspShare:34,inspMin:60,relMin:2.2,aeoShare:22,preShare:40}
};
if(typeof module!=="undefined")module.exports={IMPORT,EXPORT};
