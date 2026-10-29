import cv2, numpy as np, json, re
T=np.load("T.npy");Hi=T@np.load("H_fi_h3.npy")
def tf(pts):
    a=np.float32(pts).reshape(-1,1,2);return cv2.perspectiveTransform(a,Hi).reshape(-1,2).round(1).tolist()
app=open("/home/claude/twin/app.js").read()
seg=app[app.index("import:{"):app.index("export:{")]
path=json.loads(re.search(r'path:(\[\[.*?\]\]),',seg).group(1))
imp={
 "path":tf(path),"opStart":12,
 "st":{"road":{"idx":5},"rad":{"idx":5,"layout":"lanes"},
   "hold":{"idx":6,"layout":"poly","poly":tf([[390+265*np.cos(a),310+140*np.sin(a)] for a in np.linspace(0,2*np.pi,48,endpoint=False)])},
   "appt":{"idx":7,"layout":"lanes"},
   "park":{"idx":16,"layout":"poly","polys":[tf([[760,302],[978,302],[978,478],[760,478]]),tf([[1012,302],[1190,302],[1190,478],[1012,478]])]},
   "xray":{"idx":25,"layout":"lanes","building":True},
   "ramps":{"idx":34,"layout":"sheds","sheds":[[[2154,2146],[2278,2274]],[[2068,2230],[2191,2359]],[[2043,2378],[2105,2443]]],"inner":True},
   "rel":{"idx":41,"layout":"lanes"}},
 "label":{k:tf([v])[0] for k,v in {"road":[90,30],"rad":[175,215],"hold":[420,265],"appt":[150,560],"park":[1180,280],"xray":[1060,110],"ramps":[1730,330],"rel":[1610,610]}.items()},
 "opZone":tf([[700,150],[1090,128],[1290,150],[1400,250],[1450,330],[1960,330],[1985,600],[1500,612],[1440,525],[680,525],[700,400]]),
 "prop":tf([[390+290*np.cos(a),310+165*np.sin(a)] for a in np.linspace(0,2*np.pi,48,endpoint=False)])
}
exp={
 "path":[[2950,-200],[2850,0],[2740,250],[2640,500],[2560,760],[2510,960],[2485,1075],[2445,1100],[2405,1085],[2345,1005],[2300,925],[2262,850],[2232,775],[2290,690],[2345,600],[2255,420],[2150,340],[2035,332],[1990,395],[2060,520],[2140,650],[2200,750],[2250,835],[2278,893],[2230,925],[2140,985],[2020,1065],[1910,1150],[1840,1230],[1800,1320],[1790,1420],[1770,1475],[1700,1485],[1620,1488],[1555,1500],[1470,1540],[1420,1595],[1390,1660],[1370,1720],[1320,1800],[1250,1900],[1150,2050],[1000,2280]],
 "opStart":23,
 "st":{"road":{"idx":12},"ext":{"idx":14,"layout":"poly","polys":[[[2065,345],[2255,322],[2400,632],[2222,705]]]},"permit":{"idx":17,"layout":"lanes"},"entry":{"idx":23,"layout":"lanes"},
   "park":{"idx":27,"layout":"along","from":24,"to":31,"side":1},"ramps":{"idx":35,"layout":"sheds","sheds":[[[1468,1592],[1530,1532]]],"area":[[1440,1505],[1560,1505],[1560,1640],[1440,1640]]},"rel":{"idx":38,"layout":"lanes"}},
 "label":{"road":[2620,560],"ext":[2230,250],"permit":[1960,300],"entry":[2400,900],"park":[1880,1300],"ramps":[1560,1420],"rel":[1270,1700]},
 "opZone":[[2300,880],[2250,960],[1940,1180],[1860,1330],[1840,1500],[1600,1530],[1580,1680],[1420,1700],[1330,1800],[1270,1780],[1350,1640],[1400,1500],[1560,1450],[1730,1440],[1745,1300],[1790,1200],[1880,1110],[2230,880]],
 "prop":[[2045,325],[2270,300],[2425,640],[2210,728]]
}
buildings=[ # [corners..., height m, kind]
 {"poly":[[2250,2300],[2126,2173],[2154,2146],[2278,2274]],"h":10,"k":"shed"},
 {"poly":[[2164,2385],[2040,2256],[2068,2230],[2191,2359]],"h":10,"k":"shed"},
 {"poly":[[2079,2469],[2016,2404],[2043,2378],[2105,2443]],"h":10,"k":"shed"},
 {"poly":[[1511,1598],[1462,1546],[1490,1520],[1539,1572]],"h":9,"k":"bld"},
]
def sq(cx,cy,w,d,ang):
    a=np.deg2rad(ang);u=np.array([np.cos(a),np.sin(a)]);v=np.array([-np.sin(a),np.cos(a)]);c=np.array([cx,cy])
    return [(c+u*w/2+v*d/2).round(1).tolist(),(c-u*w/2+v*d/2).round(1).tolist(),(c-u*w/2-v*d/2).round(1).tolist(),(c+u*w/2-v*d/2).round(1).tolist()]
buildings+= [{"poly":sq(1607,1893,92,86,-43),"h":13,"k":"bld"},{"poly":sq(1722,1993,86,84,-43),"h":13,"k":"bld"},
             {"poly":sq(1853,1871,105,85,-43),"h":15,"k":"bld"},{"poly":sq(1930,1950,60,45,-43),"h":9,"k":"bld"},
             {"poly":sq(2096,1690,46,28,-43),"h":7,"k":"canopy"},{"poly":sq(1622,1747,240,10,-35),"h":6,"k":"canopy"},{"poly":sq(1640,1770,240,10,-35),"h":6,"k":"canopy"},
             {"poly":sq(2275,1235,190,14,-43),"h":7,"k":"canopy"},{"poly":sq(2300,1260,190,14,-43),"h":7,"k":"canopy"}]
json.dump({"import":imp,"export":exp,"buildings":buildings},open("geo.json","w"))
# verification overlay
img=cv2.imread("mosaic.png")
for g,col in [(imp,(0,220,255)),(exp,(255,80,255))]:
    q=np.int32(g["path"]);cv2.polylines(img,[q],False,col,5)
    for k,p in enumerate(q):cv2.putText(img,str(k),tuple(p),0,0.9,(255,255,255),2)
    for k,s in g["st"].items():
        p=q[s["idx"]];cv2.circle(img,tuple(p),14,(0,0,255),3);cv2.putText(img,k,(p[0]+15,p[1]),0,1.1,(0,0,255),3)
    cv2.polylines(img,[np.int32(g["opZone"])],True,(80,200,80),3)
for b in buildings: cv2.polylines(img,[np.int32(b["poly"])],True,(255,255,0),3)
cv2.imwrite("geo_vis.jpg",cv2.resize(img[0:3000,700:3300],None,fx=0.42,fy=0.42))
