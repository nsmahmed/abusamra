"""Detect bright roof footprints on the high-res tiles -> candidates in mosaic px (for curation)."""
import cv2, numpy as np, json, os, sys
A=os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","assets")
T=json.load(open(os.path.join(A,"tex.json")))
VMIN=int(sys.argv[1]) if len(sys.argv)>1 else 185
cands=[]
for t in T["tiles"]:
    img=cv2.imread(os.path.join(A,t["file"]));msk=cv2.imread(os.path.join(A,t["mask"]),0)
    msk=cv2.resize(msk,(img.shape[1],img.shape[0]))>200
    hsv=cv2.cvtColor(img,cv2.COLOR_BGR2HSV);v=hsv[...,2].astype(int);s=hsv[...,1].astype(int)
    m=((v>VMIN)&(s<55)&msk).astype(np.uint8)*255
    m=cv2.morphologyEx(m,cv2.MORPH_OPEN,np.ones((5,5),np.uint8));m=cv2.morphologyEx(m,cv2.MORPH_CLOSE,np.ones((7,7),np.uint8))
    n,lab,st,_=cv2.connectedComponentsWithStats(m)
    p00=np.array(t["p00"]);ea=(np.array(t["p10"])-p00)/t["w"];eb=(np.array(t["p01"])-p00)/t["h"]
    for i in range(1,n):
        if st[i,4]<500: continue
        c,_=cv2.findContours((lab==i).astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE);c=max(c,key=cv2.contourArea)
        r=cv2.minAreaRect(c);fill=st[i,4]/max(1,r[1][0]*r[1][1])
        if fill<0.6: continue
        box=cv2.boxPoints(r);mp=[(p00+ea*x+eb*y).round(1).tolist() for x,y in box]
        area_m2=st[i,4]*(0.8/1.38)**2
        cands.append({"poly":mp,"area":round(area_m2),"fill":round(fill,2),"tile":t["file"]})
# dedupe across tile overlaps (none expected) and sort
cands.sort(key=lambda c:-c["area"])
json.dump(cands,open("roof_cands.json","w"))
print(len(cands),"candidates")
mos=cv2.imread("mosaic.png")
for k,c in enumerate(cands):
    q=np.int32(c["poly"]);cv2.polylines(mos,[q],True,(0,0,255),3);cv2.putText(mos,str(k),tuple(q.mean(0).astype(int)),0,1.3,(0,255,255),3)
x0,y0,x1,y1=900,700,2900,3000
cv2.imwrite("roof_vis.jpg",cv2.resize(mos[y0:y1,x0:x1],None,fx=0.6,fy=0.6))
