"""Register Google Earth close-ups onto the mosaic (mosaic px frame). Writes closeups.json with homographies."""
import cv2, numpy as np, json, glob, os, re
D=os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","data","map-imagery")
mos=cv2.imread("mosaic.png");cov=cv2.imread("cov.png",0)
sift=cv2.SIFT_create(20000,contrastThreshold=0.02)
gm=cv2.cvtColor(mos,cv2.COLOR_BGR2GRAY)
km,dm=sift.detectAndCompute(gm,(cov>0).astype(np.uint8)*255)
print("mosaic kp",len(km))
flann=cv2.FlannBasedMatcher(dict(algorithm=1,trees=5),dict(checks=80))
def ui_mask(img):
    h,w=img.shape[:2];m=np.full((h,w),255,np.uint8)
    m[h-95:,:]=0;m[:10,:]=0       # attribution bar / top border
    m[h-200:,w-560:]=0             # nav buttons
    m[h-190:,:160]=0               # minimap thumbnail
    return m
out={}
for f in sorted(glob.glob(os.path.join(D,"closeup *.png")),key=lambda s:int(re.findall(r"\d+",os.path.basename(s))[0])):
    name=os.path.basename(f);img=cv2.imread(f);h,w=img.shape[:2]
    s=0.7  # bring close-up near mosaic scale for matching
    sm=cv2.resize(img,None,fx=s,fy=s,interpolation=cv2.INTER_AREA);g=cv2.cvtColor(sm,cv2.COLOR_BGR2GRAY)
    mk=cv2.resize(ui_mask(img),(sm.shape[1],sm.shape[0]),interpolation=cv2.INTER_NEAREST)
    kc,dc=sift.detectAndCompute(g,mk)
    m=flann.knnMatch(dc,dm,k=2);good=[a for a,b in m if a.distance<0.75*b.distance]
    src=np.float32([kc[a.queryIdx].pt for a in good])/s;dst=np.float32([km[a.trainIdx].pt for a in good])
    H,inl=cv2.findHomography(src,dst,cv2.RANSAC,3.0,maxIters=20000,confidence=0.999)
    ni=int(inl.sum()) if inl is not None else 0
    # refine with a similarity-ish check
    sc=np.sqrt(abs(np.linalg.det(H[:2,:2]))) if H is not None else 0
    print(f"{name:16s} good={len(good):5d} inliers={ni:4d} scale={sc:.3f}")
    out[name]={"H":H.tolist(),"inliers":ni,"scale":float(sc),"w":w,"h":h}
json.dump(out,open("closeups.json","w"),indent=1)
