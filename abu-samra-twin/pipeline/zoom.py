"""Render a region of the close-up composite in mosaic px with a labelled grid (for digitizing).
usage: python zoom.py x0 y0 x1 y1 [scale] out.jpg"""
import cv2, numpy as np, json, os, sys
D=os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","data","map-imagery")
x0,y0,x1,y1=map(float,sys.argv[1:5]);S=float(sys.argv[5]) if len(sys.argv)>6 else 1.5;out=sys.argv[-1]
C=json.load(open("closeups.json"));W,Hh=int((x1-x0)*S),int((y1-y0)*S)
M=np.array([[S,0,-x0*S],[0,S,-y0*S],[0,0,1]])
acc=np.zeros((Hh,W,3),np.float32);ws=np.zeros((Hh,W),np.float32)
for name,v in C.items():
    img=cv2.imread(os.path.join(D,name))[..., :3].astype(np.float32);h,w=img.shape[:2]
    mk=np.full((h,w),255,np.uint8);mk[h-95:]=0;mk[:10]=0;mk[h-200:,w-560:]=0;mk[h-190:,:160]=0;mk[:,:3]=0;mk[:,-3:]=0
    d=np.clip(cv2.distanceTransform(mk,cv2.DIST_L2,5)/80,0,1)**3
    Mi=M@np.array(v["H"]);acc+=cv2.warpPerspective(img,Mi,(W,Hh),flags=cv2.INTER_CUBIC)*cv2.warpPerspective(d,Mi,(W,Hh))[...,None];ws+=cv2.warpPerspective(d,Mi,(W,Hh))
im=(acc/np.maximum(ws,1e-6)[...,None]).clip(0,255).astype(np.uint8)
step=25
for gx in np.arange(np.ceil(x0/step)*step,x1,step):
    X=int((gx-x0)*S);cv2.line(im,(X,0),(X,Hh),(0,255,255) if gx%100==0 else (0,160,160),1)
    if gx%50==0:cv2.putText(im,str(int(gx)),(X+2,14),0,0.45,(0,255,255),1)
for gy in np.arange(np.ceil(y0/step)*step,y1,step):
    Y=int((gy-y0)*S);cv2.line(im,(0,Y),(W,Y),(0,255,255) if gy%100==0 else (0,160,160),1)
    if gy%50==0:cv2.putText(im,str(int(gy)),(2,Y-2),0,0.45,(0,255,255),1)
cv2.imwrite(out,im,[cv2.IMWRITE_JPEG_QUALITY,88])
