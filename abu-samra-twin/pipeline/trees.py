"""Detect tree crowns (small round dark blobs) on the high-res composite -> geo.json "trees" [[x, y, r], ...] in mosaic px."""
import cv2, numpy as np, json, os, sys
A=os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","assets");S=1.38
HR=cv2.imread("hr_full.png");g=cv2.cvtColor(HR,cv2.COLOR_BGR2GRAY)
valid=cv2.erode((HR.max(2)>0).astype(np.uint8),np.ones((25,25),np.uint8))
bg=cv2.medianBlur(g,41).astype(np.int16)
d=bg-g.astype(np.int16)                                   # local darkness
m=((d>22)&(valid>0)).astype(np.uint8)
m=cv2.morphologyEx(m,cv2.MORPH_OPEN,np.ones((3,3),np.uint8))
n,lab,st,cen=cv2.connectedComponentsWithStats(m)
trees=[]
for i in range(1,n):
    x,y,w,h,ar=st[i]
    if ar<14 or ar>230: continue
    if max(w,h)>2.6*min(w,h): continue                     # elongated: cars, kerbs, shadows of walls
    if ar<0.45*w*h: continue                                # ragged
    X,Y=cen[i]
    if bg[int(Y),int(X)]<70: continue                        # on asphalt / in deep shadow
    trees.append([round(X/S,1),round(Y/S,1),round(np.sqrt(ar/np.pi)/S,1)])
# exclusions: building footprints, the scrap yard by the roundabout, the inspection yard apron, bright roofs/concrete
G_=json.load(open(os.path.join(A,"geo.json"),encoding="utf-8"))
ex=np.zeros(g.shape,np.uint8)
for b in G_["buildings"]:cv2.fillPoly(ex,[(np.float32(b["poly"])*S).astype(np.int32)],1)
for poly in ([[1800,2290],[1960,2290],[1960,2460],[1800,2460]],[[2000,2000],[2420,2250],[2150,2520],[1950,2350]],[[1180,2900],[1500,2700],[1600,2850],[1300,3100]]):
    cv2.fillPoly(ex,[(np.float32(poly)*S).astype(np.int32)],1)
ex=cv2.dilate(ex,np.ones((21,21),np.uint8))
trees=[t for t in trees if not ex[int(t[1]*S),int(t[0]*S)] and bg[int(t[1]*S),int(t[0]*S)]<175]
# drop dense clusters of tiny blobs (scrap yards, parked vehicles)
pts=np.array([t[:2] for t in trees]);keep=[]
for i,t in enumerate(trees):
    nb=((np.abs(pts[:,0]-t[0])<12)&(np.abs(pts[:,1]-t[1])<12)).sum()
    if nb<=5: keep.append(t)
trees=keep
# de-duplicate across tile borders
trees.sort();out=[]
for t in trees:
    if not out or abs(out[-1][0]-t[0])>2 or abs(out[-1][1]-t[1])>2: out.append(t)
# landscaped zones (planted trees); everything else is desert scrub
ZONES=[[[1263,1714],[1553,1479],[2114,1461],[2259,1407],[2477,1714],[2368,2077],[2368,2512],[2042,2602],[1643,2512],[1209,2439],[1263,1968]],
       [[2223,700],[2700,700],[2700,1100],[2223,1000]],[[2380,60],[2800,60],[2800,760],[2380,760]]]
zm=np.zeros((3580,3598),np.uint8)
for z in ZONES:cv2.fillPoly(zm,[np.int32(z)],1)
out=[t+[int(zm[int(t[1]),int(t[0])])] for t in out]
print(len(out),"trees+shrubs,",sum(t[3] for t in out),"in landscaped zones")
if "--vis" in sys.argv:
    x0,y0,x1,y1=[int(v*S) for v in (1100,700,2700,3300)];vis=HR[y0:y1,x0:x1].copy()
    for X,Y,r in out:
        cv2.circle(vis,(int(X*S)-x0,int(Y*S)-y0),8,(0,0,255),-1)
    cv2.imwrite("tree_vis.jpg",cv2.resize(vis,None,fx=0.4,fy=0.4))
g_=json.load(open(os.path.join(A,"geo.json"),encoding="utf-8"));g_["trees"]=out
json.dump(g_,open(os.path.join(A,"geo.json"),"w",encoding="utf-8"),separators=(",",":"))
