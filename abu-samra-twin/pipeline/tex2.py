import cv2, numpy as np, json
rng=np.random.default_rng(5)
mos=cv2.imread("mosaic.png").astype(np.float32);cov=(cv2.imread("cov.png",0)>0)
H,W=cov.shape;PAD=700;Hp,Wp=H+2*PAD,W+2*PAD
img=np.zeros((Hp,Wp,3),np.float32);img[PAD:PAD+H,PAD:PAD+W]=mos
m=np.zeros((Hp,Wp),np.float32);m[PAD:PAD+H,PAD:PAD+W]=cov
K=4096/Wp
img=cv2.resize(img,(4096,4096),interpolation=cv2.INTER_AREA);m=cv2.resize(m,(4096,4096),interpolation=cv2.INTER_AREA)
Hp=Wp=4096;m=(m>0.98).astype(np.float32);m=cv2.erode(m,np.ones((5,5),np.uint8))
# 1) push-pull colour extension (normalized convolution, coarse to fine)
DS=8;smallI=cv2.resize(img*m[...,None],(Wp//DS,Hp//DS),interpolation=cv2.INTER_AREA);smallM=cv2.resize(m,(Wp//DS,Hp//DS),interpolation=cv2.INTER_AREA)
def nc(s):
    a=cv2.GaussianBlur(smallI,(0,0),s/DS);b=cv2.GaussianBlur(smallM,(0,0),s/DS);return a/np.maximum(b,1e-6)[...,None],b
hsv=cv2.cvtColor(mos.astype(np.uint8),cv2.COLOR_BGR2HSV)
sand=cov&(hsv[...,2]>120)&(hsv[...,1]<120)
gmean=mos[sand].mean(0)
base=np.empty_like(smallI);base[:]=gmean
for s in [400,200,90,40]:
    L,b=nc(s);w=np.clip(b*4,0,1)[...,None];base=base*(1-w)+L*w
base=cv2.resize(base,(Wp,Hp),interpolation=cv2.INTER_CUBIC)
# 2) fractal tone variation for far desert (light sand <-> brown sabkha)
def fbm(h,w,octs=6,seed=0):
    r=np.random.default_rng(seed);acc=np.zeros((h,w),np.float32);amp=1;tot=0
    for o in range(octs):
        n=r.random((max(2,h>>(8-o)),max(2,w>>(8-o)))).astype(np.float32)
        acc+=amp*cv2.resize(n,(w,h),interpolation=cv2.INTER_CUBIC);tot+=amp;amp*=0.55
    return acc/tot
n1=fbm(Hp,Wp,7,1);n1=(n1-n1.mean())/n1.std()
light=np.float32(np.percentile(mos[sand],80,axis=0));dark=np.float32(np.percentile(mos[sand],15,axis=0))
dist=cv2.distanceTransform((m<0.5).astype(np.uint8),cv2.DIST_L2,5)
far=np.clip(dist/500,0,1)[...,None]
t=np.clip(0.5+0.35*n1,0,1)[...,None]
tone=dark*(1-t)+light*t
base=base*(1-far*0.75)+tone*(far*0.75)
# 3) fine detail: zero-mean high-pass from plain sand patches
gray=cv2.cvtColor(mos.astype(np.uint8),cv2.COLOR_BGR2GRAY);edges=cv2.Canny(gray,40,110)
P=256;c=[]
for y in range(0,H-P,64):
    for x in range(0,W-P,64):
        if sand[y:y+P,x:x+P].mean()<0.97: continue
        e=edges[y:y+P,x:x+P].mean()
        if e<5: c.append((x,y))
print("patches",len(c))
hp=lambda p:p-cv2.GaussianBlur(p,(0,0),18)
import time;t0=time.time()
det=np.zeros((Hp,Wp,3),np.float32);ws=np.zeros((Hp,Wp),np.float32)
win=np.outer(np.hanning(P),np.hanning(P)).astype(np.float32)+1e-3
for y in range(-P//2,Hp,P//2):
    for x in range(-P//2,Wp,P//2):
        sx,sy=c[rng.integers(len(c))];p=hp(mos[sy:sy+P,sx:sx+P]);p=np.rot90(p,rng.integers(4)).copy()
        y0,x0=max(0,y),max(0,x);y1,x1=min(Hp,y+P),min(Wp,x+P)
        if y1<=y0 or x1<=x0: continue
        py,px=y0-y,x0-x;ww=win[py:py+y1-y0,px:px+x1-x0]
        det[y0:y1,x0:x1]+=p[py:py+y1-y0,px:px+x1-x0]*ww[...,None];ws[y0:y1,x0:x1]+=ww
print('det',time.time()-t0);det/=np.maximum(ws,1e-3)[...,None];det*=1.15
syn=base+det
# 4) pyramid blend
def pyr_blend(A,B,mask,levels=6):
    ga=[A];gb=[B];gm=[mask]
    for i in range(levels):ga.append(cv2.pyrDown(ga[-1]));gb.append(cv2.pyrDown(gb[-1]));gm.append(cv2.pyrDown(gm[-1]))
    out=ga[-1]*gm[-1][...,None]+gb[-1]*(1-gm[-1][...,None])
    for i in range(levels-1,-1,-1):
        size=(ga[i].shape[1],ga[i].shape[0]);la=ga[i]-cv2.pyrUp(ga[i+1],dstsize=size);lb=gb[i]-cv2.pyrUp(gb[i+1],dstsize=size)
        out=cv2.pyrUp(out,dstsize=size)+la*gm[i][...,None]+lb*(1-gm[i][...,None])
    return out
A=img.copy();A[m<0.5]=syn[m<0.5]
mk=cv2.GaussianBlur(cv2.erode(m,np.ones((41,41),np.uint8)),(0,0),18)
out=np.clip(pyr_blend(A,syn,mk),0,255)
# 5) roads outside coverage
g=json.load(open("geo.json"));road=np.zeros((Hp,Wp),np.uint8)
def dp(pts,w):cv2.polylines(road,[((np.float32(pts)+PAD)*K).astype(np.int32)],False,255,max(2,int(w*K)),cv2.LINE_AA)
def ext(a,b,L=2600):a=np.float32(a);d=a-np.float32(b);d/=np.linalg.norm(d);return (a+d*L).tolist()
imp=g["import"]["path"];exp=g["export"]["path"]
dp([ext(imp[0],imp[1])]+imp[:13],24);dp([ext(exp[0],exp[1])]+exp[:3],44)
dp(imp[-3:]+[ext(imp[-1],imp[-2])],24);dp(exp[-3:]+[ext(exp[-1],exp[-2])],24)
cvm=cv2.dilate((m>0.5).astype(np.uint8),np.ones((11,11),np.uint8)).astype(bool)
rm=((road>0)&~cvm).astype(np.float32);rmf=cv2.GaussianBlur(rm,(0,0),1.2)
sh=cv2.GaussianBlur(cv2.dilate(rm,np.ones((11,11),np.uint8)),(0,0),5)
out=out*(1-0.22*sh[...,None])+np.float32([165,175,182])*0.22*sh[...,None]
asph=np.float32([66,68,70])+rng.normal(0,3.5,(Hp,Wp,1)).astype(np.float32)
out=out*(1-rmf[...,None])+asph*rmf[...,None]
out=np.clip(out,0,255).astype(np.uint8)
tex=out
cv2.imwrite("ground_4096.jpg",tex,[cv2.IMWRITE_JPEG_QUALITY,82])
cv2.imwrite("ground_prev.jpg",cv2.resize(out,(1400,1400)))
json.dump({"PAD":PAD,"Wp":H+2*PAD,"Hp":H+2*PAD,"Worig":W+2*PAD,"edge":[float(x) for x in gmean[::-1]]},open("tex.json","w"))
import os;print(os.path.getsize("ground_4096.jpg")/1e6,"MB")
