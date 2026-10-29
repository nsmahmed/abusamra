import cv2, numpy as np, re, json
T=np.load("T.npy");H23=np.load("H_h2_h3.npy")
Hi=T@np.load("H_fi_h3.npy")
He1=T@H23@np.load("H_fe_h2.npy")
app=open("/home/claude/twin/app.js").read()
def grab(name):
    i=app.index(name+":{");seg=app[i:]
    m=re.search(r'path:(\[\[.*?\]\]),',seg);return json.loads(m.group(1))
pi=grab("import");pe=grab("export")
def tf(H,pts):
    a=np.float32(pts).reshape(-1,1,2);return cv2.perspectiveTransform(a,H).reshape(-1,2)
img=cv2.imread("mosaic.png")
for H,pts,col in [(Hi,pi,(0,220,255)),(He1,pe,(255,80,255))]:
    q=tf(H,pts).astype(int)
    for a,b in zip(q[:-1],q[1:]):cv2.line(img,tuple(a),tuple(b),col,6)
    for k,p in enumerate(q):cv2.putText(img,str(k),tuple(p),cv2.FONT_HERSHEY_SIMPLEX,1.1,(255,255,255),3)
cv2.imwrite("ov.jpg",cv2.resize(img,(1800,1790)))
