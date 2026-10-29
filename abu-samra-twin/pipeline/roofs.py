import cv2, numpy as np, json
im=cv2.imread("mosaic.png");cov=cv2.imread("cov.png",0)>0
hsv=cv2.cvtColor(im,cv2.COLOR_BGR2HSV)
v=hsv[...,2].astype(int);s=hsv[...,1].astype(int)
mask=((v>200)&(s<45)&cov).astype(np.uint8)*255
mask=cv2.morphologyEx(mask,cv2.MORPH_OPEN,np.ones((3,3),np.uint8))
mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((5,5),np.uint8))
n,lab,st,cen=cv2.connectedComponentsWithStats(mask)
out=[];vis=im.copy()
for i in range(1,n):
    a=st[i,4]
    if a<350: continue
    cnt,_=cv2.findContours((lab==i).astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    c=max(cnt,key=cv2.contourArea)
    rect=cv2.minAreaRect(c);box=cv2.boxPoints(rect)
    fill=a/max(1,rect[1][0]*rect[1][1])
    if fill<0.55: continue
    out.append({"box":box.round(1).tolist(),"area":int(a)})
    cv2.drawContours(vis,[box.astype(int)],0,(0,0,255),3)
print(len(out))
json.dump(out,open("roofs.json","w"))
cv2.imwrite("roofs_vis.jpg",cv2.resize(vis[700:3000,800:3200],None,fx=0.45,fy=0.45))
