import cv2, numpy as np
U="/mnt/user-data/uploads/"
imgs={k:cv2.imread(U+f) for k,f in [("h1","high_level_1.png"),("h2","high_level_2.png"),("h3","high_level_3.png"),("fi","1793086674392_image.png"),("fe","1793086681596_image.png")]}
for k,v in imgs.items(): print(k,v.shape)
sift=cv2.SIFT_create(8000)
def feats(img,mask=None):
    g=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY); return sift.detectAndCompute(g,mask)
# masks to drop UI overlays (google buttons, flow-map legends)
def mask_for(k,img):
    h,w=img.shape[:2]; m=np.full((h,w),255,np.uint8)
    if k=="h1": m[740:,870:]=0; m[:12,:]=0
    if k=="h2": m[:10,:]=0; m[740:,930:]=0
    if k=="h3": m[790:,:]=0; m[730:,1100:]=0
    if k=="fi": m[665:,:]=0
    if k=="fe": m[740:,:]=0
    return m
F={k:feats(v,mask_for(k,v)) for k,v in imgs.items()}
bf=cv2.BFMatcher()
def H(a,b):  # homography mapping a -> b
    ka,da=F[a];kb,db=F[b]
    m=bf.knnMatch(da,db,k=2); good=[x for x,y in m if x.distance<0.72*y.distance]
    if len(good)<10: return None,len(good),0
    src=np.float32([ka[g.queryIdx].pt for g in good]);dst=np.float32([kb[g.trainIdx].pt for g in good])
    Hm,inl=cv2.findHomography(src,dst,cv2.RANSAC,4.0)
    return Hm,len(good),int(inl.sum()) if inl is not None else 0
for a,b in [("h2","h3"),("h1","h2"),("h1","h3"),("fi","h3"),("fi","h2"),("fe","h2"),("fe","h1"),("fe","h3")]:
    Hm,n,i=H(a,b); print(a,"->",b,"matches",n,"inliers",i)
    if Hm is not None: np.save(f"H_{a}_{b}.npy",Hm)
