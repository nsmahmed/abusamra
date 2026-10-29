import cv2, numpy as np, json
import os
U=os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","data","map-imagery","")
h1=cv2.imread(U+"high level 1.png");h2=cv2.imread(U+"high level 2.png");h3=cv2.imread(U+"high level 3.png")
H23=np.load("H_h2_h3.npy");H12=np.load("H_h1_h2.npy");H13=H23@H12
print("H23",np.round(H23,3));print("H13",np.round(H13,3))
def crop(img,k):
    h,w=img.shape[:2];m=np.full((h,w),255,np.uint8)
    if k==1: m[730:,860:]=0; m[:14,:]=0
    if k==2: m[:12,:]=0; m[745:,925:]=0
    if k==3: m[792:,:]=0; m[725:,1100:]=0; m[:4,:]=0
    return m
corners=[]
for img,Hm in [(h1,H13),(h2,H23),(h3,np.eye(3))]:
    h,w=img.shape[:2];c=np.float32([[0,0],[w,0],[w,h],[0,h]]).reshape(-1,1,2);corners.append(cv2.perspectiveTransform(c,Hm))
allc=np.concatenate(corners);x0,y0=np.floor(allc.min(axis=(0,1)));x1,y1=np.ceil(allc.max(axis=(0,1)))
print("bounds",x0,y0,x1,y1)
S=2.0  # upscale for texture resolution
T=np.array([[S,0,-x0*S],[0,S,-y0*S],[0,0,1]])
W,Hh=int((x1-x0)*S),int((y1-y0)*S);print("canvas",W,Hh)
canvas=np.zeros((Hh,W,3),np.float32);wsum=np.zeros((Hh,W),np.float32)
for k,img,Hm in [(1,h1,H13),(2,h2,H23),(3,h3,np.eye(3))]:
    M=T@Hm;wimg=cv2.warpPerspective(img,M,(W,Hh),flags=cv2.INTER_CUBIC)
    m=cv2.warpPerspective(crop(img,k),M,(W,Hh),flags=cv2.INTER_NEAREST)
    d=cv2.distanceTransform((m>0).astype(np.uint8),cv2.DIST_L2,5);wt=np.clip(d/60,0,1)*(1.0 if k==3 else 0.9)
    canvas+=wimg*wt[...,None];wsum+=wt
cov=wsum>0;out=np.zeros_like(canvas);out[cov]=canvas[cov]/wsum[cov][:,None]
out=out.astype(np.uint8);cv2.imwrite("mosaic.png",out);cv2.imwrite("cov.png",(cov*255).astype(np.uint8))
np.save("T.npy",T);json.dump({"W":W,"H":Hh,"S":S,"x0":float(x0),"y0":float(y0)},open("mosaic.json","w"))
small=cv2.resize(out,(W//2,Hh//2));cv2.imwrite("mosaic_small.jpg",small)
