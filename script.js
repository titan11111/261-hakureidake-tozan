(()=>{
'use strict';
const $=id=>document.getElementById(id);
const isTouch = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;
if(isTouch) document.body.classList.add('touch');
$('keys').textContent = '';
$('keys').append(
  document.createTextNode(isTouch
    ? '左側をなぞって移動、右側をなぞって見回す。'
    : 'W A S D で歩く、ドラッグで見回す。'),
);
const keysBr=document.createElement('br');
$('keys').append(keysBr);
$('keys').append(document.createTextNode(isTouch
  ? '「走る」は押している間だけ。「倍速」で10倍速。近づくと「調べる」。右上で音・視点・一時停止。'
  : 'Shift で走る、T で10倍速、Q で調べる、R で小休止、E で小屋、V で視点、G で挨拶、F で行動食、H でサル。'));
let lastTouchEnd=0;
document.addEventListener('touchend',e=>{const now=Date.now();if(now-lastTouchEnd<=300)e.preventDefault();lastTouchEnd=now},{passive:false});
document.addEventListener('touchmove',e=>{if(e.target.closest('[data-scrollable]'))return;e.preventDefault()},{passive:false});
document.addEventListener('dblclick',e=>e.preventDefault());
document.addEventListener('contextmenu',e=>e.preventDefault());
document.addEventListener('selectstart',e=>e.preventDefault());
document.addEventListener('dragstart',e=>e.preventDefault());
document.addEventListener('gesturestart',e=>e.preventDefault());
const CFG={look:1,invert:false,vib:true,mute:false};
function loadCfg(){
  try{
    const c=JSON.parse(localStorage.getItem('tg.261.ctrl')||'null');
    if(c&&typeof c.look==='number')CFG.look=c.look;
    if(c&&typeof c.invert==='boolean')CFG.invert=c.invert;
    if(c&&typeof c.vib==='boolean')CFG.vib=c.vib;
    CFG.mute=localStorage.getItem('tg.261.mute')==='1';
  }catch(e){}
}
function saveCfg(){
  try{
    localStorage.setItem('tg.261.ctrl',JSON.stringify({look:CFG.look,invert:CFG.invert,vib:CFG.vib}));
    localStorage.setItem('tg.261.mute',CFG.mute?'1':'0');
  }catch(e){}
}
loadCfg();

/* ---------- helpers ---------- */
const C=h=>new THREE.Color(h).convertSRGBToLinear();
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
function smooth(a,b,x){const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)}
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const rnd=mulberry32(3026);

/* ---------- noise ---------- */
const P=new Uint8Array(512);
{const p=[...Array(256).keys()];for(let i=255;i>0;i--){const j=Math.floor(rnd()*(i+1));[p[i],p[j]]=[p[j],p[i]]}for(let i=0;i<512;i++)P[i]=p[i&255];}
const GX=[1,-1,1,-1,1,-1,0,0],GY=[1,1,-1,-1,0,0,1,-1];
function perlin(x,y){
  const X=Math.floor(x),Y=Math.floor(y);x-=X;y-=Y;const xi=X&255,yi=Y&255;
  const u=x*x*x*(x*(x*6-15)+10),v=y*y*y*(y*(y*6-15)+10);
  const aa=P[P[xi]+yi]&7,ab=P[P[xi]+yi+1]&7,ba=P[P[xi+1]+yi]&7,bb=P[P[xi+1]+yi+1]&7;
  const n00=GX[aa]*x+GY[aa]*y, n10=GX[ba]*(x-1)+GY[ba]*y, n01=GX[ab]*x+GY[ab]*(y-1), n11=GX[bb]*(x-1)+GY[bb]*(y-1);
  const a=n00+(n10-n00)*u, b=n01+(n11-n01)*u; return a+(b-a)*v;
}
function fbm(x,y,o){let s=0,a=.5,f=1;for(let i=0;i<o;i++){s+=a*perlin(x*f,y*f);f*=2.02;a*=.5}return s}
function ridged(x,y,o){let s=0,a=.5,f=1,n=0;for(let i=0;i<o;i++){let r=1-Math.abs(perlin(x*f,y*f));s+=a*r*r;n+=a;f*=2.03;a*=.5}return s/n}

/* ---------- world constants ---------- */
const HALF=4000,SEG=400,N=SEG+1,CELL=HALF*2/SEG,BASE_ALT=1250,PEAK=1776,CLOUD_Y=520,BOUND=3000;

function baseH(x,z){
  const r=Math.hypot(x,z);
  const u=Math.pow(r/900,2.2), m=PEAK/(1+u), f=m/PEAK;
  const hills=fbm(x*.0011+11.3,z*.0011-4.7,5)*110*(1-f*.6);
  const ridge=(ridged(x*.0017+3.1,z*.0017-7.3,5)-.45)*280*Math.pow(f,1.1)*smooth(120,650,r);
  const ranges=1000*smooth(3100,3900,r)*(.45+ridged(x*.0008+1.1,z*.0008+2.2,4)*.8);
  let h=m+hills+ridge+ranges;
  const w=1-smooth(30,200,r);
  return h*(1-w)+(PEAK-r*.25)*w;
}

/* ---------- trail generation ---------- */
function makeTrail(){
  const b0=200*Math.PI/180, r0=1850;
  let px=Math.sin(b0)*r0, pz=-Math.cos(b0)*r0;
  const raw=[]; let s=1,leg=0,prev=null,trav=0; const STEP=3;
  // 折り返しの隣り合うレッグは、地形グリッド(CELL=20m)が両方の高さを表現できる
  // だけ離す。近すぎると1セルに高低差の違う道が2本入り、低い側が山に埋まる。
  // 必要な標高差 = 目標の水平間隔 × その場の地形の傾き（2026-09-26）
  const MIN_SEP=100;
  const bslope=(x,z)=>Math.hypot(baseH(x+CELL,z)-baseH(x-CELL,z),baseH(x,z+CELL)-baseH(x,z-CELL))/(2*CELL);
  let hFlip=baseH(px,pz);
  for(let it=0;it<7000;it++){
    raw.push([px,pz]);
    const r=Math.hypot(px,pz); if(r<5) break;
    const ix=-px/r, iz=-pz/r, tx=-iz*s, tz=ix*s;
    const h0=baseH(px,pz);
    const target=r<200?.22:(r<700?.16:.13);
    let best=null;
    for(let a=0;a<=110;a+=5){
      const ar=a*Math.PI/180; let dx=ix*Math.cos(ar)+tx*Math.sin(ar), dz=iz*Math.cos(ar)+tz*Math.sin(ar);
      if(prev){dx=dx*.55+prev[0]*.45;dz=dz*.55+prev[1]*.45;const l=Math.hypot(dx,dz);dx/=l;dz/=l}
      if(r<35){dx=ix;dz=iz}
      const g=(baseH(px+dx*STEP,pz+dz*STEP)-h0)/STEP;
      best=[dx,dz,a];
      if(g<=target||r<35) break;
    }
    if(!best)best=[ix,iz,0];
    if(best[2]<30&&r>450){const w=.62*Math.sin(trav/70)+.3*Math.sin(trav/24+1),c=Math.cos(w),sn=Math.sin(w);best=[best[0]*c-best[1]*sn,best[0]*sn+best[1]*c,best[2]]}
    trav+=STEP;
    px+=best[0]*STEP; pz+=best[1]*STEP; prev=[best[0],best[1]];
    if(best[2]>=25){leg+=STEP;
      const need=Math.max(26,MIN_SEP*bslope(px,pz));
      if(leg>140&&(h0-hFlip)>=need){s=-s;leg=0;hFlip=h0}
    } else leg=Math.max(0,leg-STEP);
  }
  raw.push([0,0]);
  // smooth xz
  let a=raw;
  for(let pass=0;pass<4;pass++){
    const b=a.map(p=>p.slice());
    for(let i=1;i<a.length-1;i++){let sx=0,sz=0,n=0;for(let k=-3;k<=3;k++){const q=a[clamp(i+k,0,a.length-1)];sx+=q[0];sz+=q[1];n++}b[i]=[sx/n,sz/n]}
    a=b;
  }
  // resample 2m
  const out=[{x:a[0][0],z:a[0][1],dist:0}]; let cx=a[0][0],cz=a[0][1],need=2;
  for(let k=1;k<a.length;k++){
    const [x,z]=a[k]; let seg=Math.hypot(x-cx,z-cz);
    while(seg>=need){const t=need/seg;cx+=(x-cx)*t;cz+=(z-cz)*t;out.push({x:cx,z:cz,dist:out[out.length-1].dist+2});seg-=need;need=2}
    need-=seg; cx=x;cz=z;
  }
  const lastP=out[out.length-1]; if(Math.hypot(lastP.x,lastP.z)>.5) out.push({x:0,z:0,dist:lastP.dist+Math.hypot(lastP.x,lastP.z)});
  // heights
  let hs=out.map(p=>baseH(p.x,p.z));
  for(let pass=0;pass<3;pass++){
    const nh=hs.slice();
    for(let i=0;i<hs.length;i++){let s2=0,n=0;for(let k=-15;k<=15;k++){s2+=hs[clamp(i+k,0,hs.length-1)];n++}nh[i]=s2/n}
    hs=nh;
  }
  {const n=hs.length,diff=PEAK-hs[n-1];for(let i=0;i<n;i++)hs[i]+=diff*smooth(n*0.55,n-1,i);}
  const MAX_UP=.22,MAX_DN=.32;
  for(let i=1;i<hs.length;i++){
    const dist=Math.max(out[i].dist-out[i-1].dist,1);
    const dh=hs[i]-hs[i-1];
    if(dh>MAX_UP*dist)hs[i]=hs[i-1]+MAX_UP*dist;
    else if(dh<-MAX_DN*dist)hs[i]=hs[i-1]-MAX_DN*dist;
  }
  hs[hs.length-1]=Math.max(hs[hs.length-1],PEAK);
  out.forEach((p,i)=>p.h=hs[i]);
  return out;
}

/* ---------- globals ---------- */
let LM={clears:[],evs:[],animals:[],water:null,stream:null},hiker=null,flowTex=null;
const BODY=0.42, PATH_CLEAR=1.2, SCELL=10;
const solids=[], solidGrid=new Map(), looks=[], treads=[], ribbon=[], chainSpans=[];
const FOOT_CLEAR=.08;
let lookTarget=null;
function addSolid(x,z,r){
  if(!(r>0.12))return;
  const np=nearPath(x,z);
  if(np.i>=0){
    const room=np.d-PATH_CLEAR;
    if(room<0.18)return;
    if(r>room)r=room;
  }
  const s={x,z,r};
  solids.push(s);
  const ix=Math.floor(x/SCELL),iz=Math.floor(z/SCELL),k=ix+','+iz;
  let a=solidGrid.get(k);if(!a)solidGrid.set(k,a=[]);a.push(s);
}
function hitSolid(x,z,pad){
  const ix=Math.floor(x/SCELL),iz=Math.floor(z/SCELL);
  for(let j=iz-1;j<=iz+1;j++)for(let i=ix-1;i<=ix+1;i++){
    const a=solidGrid.get(i+','+j);if(!a)continue;
    for(const s of a)if(Math.hypot(x-s.x,z-s.z)<s.r+pad)return s;
  }
  return null;
}
function addLook(x,z,r,title,text){looks.push({x,z,r,title,text})}
function updateLook(){
  lookTarget=null;let best=1e9;
  for(const o of looks){const d=Math.hypot(S.x-o.x,S.z-o.z);if(d<o.r&&d<best){best=d;lookTarget=o}}
  const b=$('lookBtn');
  const on=!!lookTarget&&mode==='play'&&!paused;
  b.classList.toggle('show',on);
  b.disabled=!on;
}
function examine(){
  if(!lookTarget||mode!=='play'||paused)return;
  const o=lookTarget;
  toast(o.title+'。'+o.text,3400);
}
let renderer,scene,camera,sun,hemi,headlamp,skyMat,cloudMats=[],cloudPlanes=[],heavy=[],H,pts,pathLen,huts=[],hash,hutWindowMat,hutLights=[],smokes=[],trailMesh=null;
let profileImg=null;

const HCELL=30;
const hkey=(cx,cz)=>cx*100000+cz;
function nearPath(x,z){
  const cx=Math.floor(x/HCELL),cz=Math.floor(z/HCELL);let bd=1e12,bi=-1;
  for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++){const arr=hash.get(hkey(cx+a,cz+b));if(!arr)continue;
    for(const i of arr){const p=pts[i];const d=(p.x-x)**2+(p.z-z)**2;if(d<bd){bd=d;bi=i}}}
  return {d:Math.sqrt(bd),i:bi};
}
function heightAt(x,z){
  let fx=clamp((x+HALF)/CELL,0,SEG-1e-4), fz=clamp((z+HALF)/CELL,0,SEG-1e-4);
  const i=Math.floor(fx),j=Math.floor(fz),u=fx-i,v=fz-j;
  const a=H[j*N+i],b=H[j*N+i+1],c=H[(j+1)*N+i],d=H[(j+1)*N+i+1];
  if(u+v<1) return a+(b-a)*u+(c-a)*v;
  return d+(c-d)*(1-u)+(b-d)*(1-v);
}
function ribbonAt(x,z){
  if(!ribbon.length) return null;
  const np=nearPath(x,z);
  if(np.i<0) return null;
  let best=null;
  const i0=Math.max(0,np.i-1), i1=Math.min(ribbon.length-2,np.i+1);
  for(let i=i0;i<=i1;i++){
    const a=ribbon[i], b=ribbon[i+1];
    const abx=b.x-a.x, abz=b.z-a.z, ab2=abx*abx+abz*abz||1;
    const t=clamp(((x-a.x)*abx+(z-a.z)*abz)/ab2,0,1);
    const cx=a.x+abx*t, cz=a.z+abz*t;
    let ux=a.ux+(b.ux-a.ux)*t, uz=a.uz+(b.uz-a.uz)*t;
    const ul=Math.hypot(ux,uz)||1; ux/=ul; uz/=ul;
    const across=(x-cx)*ux+(z-cz)*uz;
    const hw=a.hw+(b.hw-a.hw)*t;
    const yL=a.yL+(b.yL-a.yL)*t, yR=a.yR+(b.yR-a.yR)*t;
    const u=hw>1e-4?clamp(across/hw,-1,1):0;
    const y=(yL+yR)*.5+(yL-yR)*.5*u;
    const d=Math.abs(across);
    if(!best||d<best.d) best={y,d,hw,chain:!!(a.chain&&b.chain)};
  }
  return best;
}
function walkY(x,z){
  let y=heightAt(x,z)+.02;
  const r=ribbonAt(x,z);
  if(r){
    const fade=1-smooth(r.hw, r.hw+.4, r.d);
    if(fade>0) y+=(Math.max(r.y+FOOT_CLEAR,y)-y)*fade;
  }
  for(const t of treads){
    const px=x-t.x,pz=z-t.z,across=px*t.nx+pz*t.nz,along=px*t.tx+pz*t.tz;
    if(Math.abs(across)<t.across&&Math.abs(along)<t.along) y=Math.max(y,t.top);
  }
  return y;
}
function chainHere(x,z){const r=ribbonAt(x,z);return !!(r&&r.chain&&r.d<r.hw+.9)}
function slopeAt(x,z){const e=3;return Math.hypot(heightAt(x+e,z)-heightAt(x-e,z),heightAt(x,z+e)-heightAt(x,z-e))/(2*e)}
const realAlt=h=>BASE_ALT+h;

/* ---------- textures ---------- */
function noiseTex(size,base,varr,dots){
  const c=document.createElement('canvas');c.width=c.height=size;const g=c.getContext('2d');
  const img=g.createImageData(size,size);
  for(let i=0;i<size*size;i++){const v=base+(Math.random()-.5)*varr;img.data[i*4]=img.data[i*4+1]=img.data[i*4+2]=clamp(v,0,255);img.data[i*4+3]=255}
  g.putImageData(img,0,0);
  if(dots){for(let k=0;k<dots;k++){g.fillStyle=`rgba(${Math.random()<.5?255:0},${Math.random()<.5?255:0},${Math.random()<.5?255:0},0)`;
    const v=Math.random()*80+150|0;g.fillStyle=`rgba(${v},${v},${v},.5)`;g.beginPath();g.arc(Math.random()*size,Math.random()*size,Math.random()*2+.5,0,7);g.fill()}}
  const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.encoding=THREE.sRGBEncoding;return t;
}
function gravelTex(){
  const s=256,c=document.createElement('canvas');c.width=c.height=s;const g=c.getContext('2d');
  g.fillStyle='#6f5c48';g.fillRect(0,0,s,s);
  for(let i=0;i<2600;i++){const v=Math.random();g.fillStyle=v<.4?'rgba(40,30,22,.35)':v<.8?'rgba(150,135,115,.45)':'rgba(190,180,165,.5)';
    g.beginPath();g.ellipse(Math.random()*s,Math.random()*s,Math.random()*2.6+.6,Math.random()*2+.5,Math.random()*3,0,7);g.fill()}
  // edge grass fade
  const gr=g.createLinearGradient(0,0,s,0);gr.addColorStop(0,'rgba(60,70,40,.55)');gr.addColorStop(.18,'rgba(60,70,40,0)');gr.addColorStop(.82,'rgba(60,70,40,0)');gr.addColorStop(1,'rgba(60,70,40,.55)');
  g.fillStyle=gr;g.fillRect(0,0,s,s);
  const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.encoding=THREE.sRGBEncoding;t.anisotropy=4;return t;
}
function signTex(lines,w=512,h=256,bg='#5b3c22'){
  const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');
  g.fillStyle=bg;g.fillRect(0,0,w,h);
  for(let i=0;i<40;i++){g.strokeStyle=`rgba(0,0,0,${Math.random()*.18})`;g.lineWidth=Math.random()*3+1;g.beginPath();const y=Math.random()*h;g.moveTo(0,y);g.bezierCurveTo(w*.3,y+Math.random()*10-5,w*.6,y+Math.random()*10-5,w,y+Math.random()*8-4);g.stroke()}
  g.strokeStyle='rgba(20,10,4,.6)';g.lineWidth=10;g.strokeRect(5,5,w-10,h-10);
  g.fillStyle='#f1e6cc';g.textAlign='center';g.textBaseline='middle';
  const total=lines.reduce((s,l)=>s+l.s*1.25,0);let y=h/2-total/2;
  for(const l of lines){g.font=`${l.b||800} ${l.s}px "Shippori Mincho B1","Hiragino Mincho ProN",serif`;y+=l.s*.625;g.fillText(l.t,w/2,y);y+=l.s*.625}
  const t=new THREE.CanvasTexture(c);t.encoding=THREE.sRGBEncoding;t.anisotropy=4;return t;
}
function smokeTex(){const s=64,c=document.createElement('canvas');c.width=c.height=s;const g=c.getContext('2d');
  const gr=g.createRadialGradient(s/2,s/2,2,s/2,s/2,s/2);gr.addColorStop(0,'rgba(230,230,230,.55)');gr.addColorStop(1,'rgba(230,230,230,0)');g.fillStyle=gr;g.fillRect(0,0,s,s);
  return new THREE.CanvasTexture(c)}


function makeAnimal(kind,x,z,f,msg){
  const g=new THREE.Group();const M=(c,r=.9)=>new THREE.MeshStandardMaterial({color:C(c),roughness:r});
  const part=(geo,m,px,py,pz,sx=1,sy=1,sz=1)=>{const o=new THREE.Mesh(geo,m);o.position.set(px,py,pz);o.scale.set(sx,sy,sz);o.castShadow=true;g.add(o);return o};
  const sph=new THREE.SphereGeometry(1,12,10);
  if(kind==='serow'){
    const fur=M('#46403a'),light=M('#8e867a');
    part(sph,fur,0,.85,0,.28,.32,.62);part(sph,light,0,.95,-.55,.16,.18,.22);
    part(sph,fur,0,1.05,-.72,.13,.15,.2);
    for(const [lx,lz] of [[-.14,-.4],[.14,-.4],[-.14,.4],[.14,.4]])part(new THREE.CylinderGeometry(.05,.04,.6,6),fur,lx,.3,lz);
    for(const hx of [-.05,.05])part(new THREE.ConeGeometry(.025,.16,5),M('#1c1a18'),hx,1.24,-.72);
  }else{
    const body=M('#8d7c62',.95),white=M('#f1efe9',.9);
    part(sph,body,0,.16,0,.14,.13,.19);part(sph,white,0,.11,.02,.12,.09,.16);part(sph,body,0,.3,-.13,.075,.075,.075);
    part(new THREE.BoxGeometry(.05,.015,.02),M('#d0372c',.5),0,.34,-.18);
    for(const lx of [-.04,.04])part(new THREE.CylinderGeometry(.018,.018,.08,5),white,lx,.04,0);
  }
  g.position.set(x,heightAt(x,z),z);g.rotation.y=Math.atan2(-f.tx,-f.tz)+1.2;scene.add(g);
  let ax=x-f.p.x,az=z-f.p.z;const l=Math.hypot(ax,az)||1;
  return {g,kind,x,z,x0:x,z0:z,dx:ax/l,dz:az/l,fled:false,t:0,msg};
}
function buildHiker(o={}){
  const M=(c,r=.8)=>new THREE.MeshStandardMaterial({color:C(c),roughness:r});
  const jacket=M(o.jacket||'#c8452f',.65),pants=M(o.pants||'#394048'),boot=M('#4a3524'),pack=M(o.pack||'#2f5663',.75),skin=M(o.skin||'#d7ab85'),cap=M(o.cap||'#2b2f33'),glove=M('#26292c'),mat=M(o.mat||'#d9b63c',.6);
  const poleM=new THREE.MeshStandardMaterial({color:C('#aab2b8'),metalness:.6,roughness:.35});
  const root=new THREE.Group(),body=new THREE.Group();root.add(body);
  const upper=new THREE.Group();upper.position.y=.93;body.add(upper);
  const mesh=(g,m,x,y,z,parent)=>{const o2=new THREE.Mesh(g,m);o2.position.set(x,y,z);o2.castShadow=true;(parent||upper).add(o2);return o2};
  const limb=(len,r)=>{const g=new THREE.CylinderGeometry(r,r*.85,len,8);g.translate(0,-len/2,0);return g};
  function leg(sx){const hip=new THREE.Group();hip.position.set(sx,.93,0);body.add(hip);
    const thigh=new THREE.CylinderGeometry(.11,.08,.46,8);thigh.translate(0,-.23,0);mesh(thigh,pants,0,0,0,hip);
    const knee=new THREE.Group();knee.position.y=-.46;hip.add(knee);
    mesh(new THREE.SphereGeometry(.082,10,8),pants,0,0,0,knee);
    const calf=new THREE.CylinderGeometry(.05,.09,.46,8);calf.translate(0,-.23,0);mesh(calf,pants,0,0,0,knee);
    const ankle=new THREE.Group();ankle.position.y=-.46;knee.add(ankle);
    const bg=new THREE.BoxGeometry(.15,.12,.30);bg.translate(0,.02,-.06);mesh(bg,boot,0,0,0,ankle);
    return{hip,knee,ankle}}
  function arm(sx){const sh=new THREE.Group();sh.position.set(sx,.54,0);upper.add(sh);mesh(limb(.3,.062),jacket,0,0,0,sh);
    const el=new THREE.Group();el.position.y=-.3;sh.add(el);mesh(limb(.27,.052),jacket,0,0,0,el);mesh(new THREE.SphereGeometry(.058,8,6),glove,0,-.29,0,el);
    const pg=new THREE.CylinderGeometry(.012,.012,1.2,5);pg.translate(0,-.52,0);const p=mesh(pg,poleM,0,-.29,0,el);p.rotation.x=.35;return{sh,el}}
  const L=leg(-.11),R=leg(.11),AL=arm(-.28),AR=arm(.28);
  mesh(new THREE.BoxGeometry(.44,.58,.27),jacket,0,.30,0);
  mesh(new THREE.BoxGeometry(.4,.16,.25),pants,0,.02,0);
  mesh(new THREE.BoxGeometry(.4,.64,.3),pack,0,.37,.27);
  mesh(new THREE.BoxGeometry(.3,.22,.08),pack,0,.23,.44);
  mesh(new THREE.BoxGeometry(.06,.5,.04),M('#1f3a44'),-.16,.37,.1);mesh(new THREE.BoxGeometry(.06,.5,.04),M('#1f3a44'),.16,.37,.1);
  const roll=mesh(new THREE.CylinderGeometry(.1,.1,.5,10),mat,0,.75,.27);roll.rotation.z=Math.PI/2;
  const head=new THREE.Group();head.position.set(0,.69,0);upper.add(head);
  mesh(new THREE.CylinderGeometry(.06,.07,.1,8),skin,0,-.02,0,head);
  mesh(new THREE.SphereGeometry(.125,14,12),skin,0,.12,0,head);
  mesh(new THREE.SphereGeometry(.135,14,8,0,Math.PI*2,0,Math.PI/2),cap,0,.15,0,head);
  mesh(new THREE.BoxGeometry(.2,.02,.12),cap,0,.15,-.15,head);
  if(o.hat){mesh(new THREE.CylinderGeometry(.26,.26,.02,18),cap,0,.2,0,head);mesh(new THREE.CylinderGeometry(.12,.15,.16,14),cap,0,.28,0,head);mesh(new THREE.BoxGeometry(.02,.14,.04),M('#b8322a'),.14,.3,.02,head)}
  if(o.beard){mesh(new THREE.BoxGeometry(.13,.035,.04),M('#cfcac0'),0,.07,-.115,head);mesh(new THREE.TorusGeometry(.035,.006,4,10),M('#222'),-.045,.13,-.12,head);mesh(new THREE.TorusGeometry(.035,.006,4,10),M('#222'),.045,.13,-.12,head)}
  const lamp=mesh(new THREE.BoxGeometry(.07,.045,.03),new THREE.MeshStandardMaterial({color:0x222222,emissive:C('#fff2d0'),emissiveIntensity:0}),0,.21,-.13,head);
  scene.add(root);
  return{root,body,upper,L,R,AL,AR,head,lamp,amp:0};
}
// two-bone leg IK in the leg's sagittal plane (hip at origin, target tz forward=-z, ty negative = down)
const LEG1=.46,LEG2=.46;
function solveLeg(leg,tz,ty,k,footPitch){
  let d=clamp(Math.hypot(tz,ty),.3,LEG1+LEG2-.003);
  const knee=Math.PI-Math.acos(clamp((LEG1*LEG1+LEG2*LEG2-d*d)/(2*LEG1*LEG2),-1,1));
  const A=Math.acos(clamp((LEG1*LEG1+d*d-LEG2*LEG2)/(2*LEG1*d),-1,1));
  const hip=Math.atan2(-tz,-ty)+A;
  leg.hip.rotation.x+=(hip-leg.hip.rotation.x)*k;
  leg.knee.rotation.x+=(-knee-leg.knee.rotation.x)*k;
  leg.ankle.rotation.x=-(leg.hip.rotation.x+leg.knee.rotation.x)+footPitch;
}
function animHiker(h,st,dt,moved,running,grade){
  const sp=moved/Math.max(dt,1e-4);h.amp+=(((moved>0)?Math.min(1.2,sp/6)*(running?1.2:1):0)-h.amp)*Math.min(1,dt*8);
  const a=h.amp,ph=st.phase,k=Math.min(1,dt*18);
  const to=(o,v)=>{o.rotation.x+=(v-o.rotation.x)*k};
  if(st.resting){
    to(h.L.hip,1.45);to(h.R.hip,1.4);to(h.L.knee,-1.5);to(h.R.knee,-1.45);h.L.ankle.rotation.x=h.R.ankle.rotation.x=0;
    to(h.AL.sh,.55);to(h.AR.sh,.5);to(h.AL.el,-.9);to(h.AR.el,-.9);to(h.upper,.12);
    h.body.position.y+=(-.46-h.body.position.y)*k;h.head.rotation.x=0;return;
  }
  const f=h.root.rotation.y,cf=Math.cos(f),sf=Math.sin(f),rx=h.root.position.x,ry=h.root.position.y,rz=h.root.position.z;
  // slope along facing direction (for leaning and foot pitch)
  const fx=-sf,fz=-cf,slope=(heightAt(rx+fx*.5,rz+fz*.5)-heightAt(rx-fx*.5,rz-fz*.5));
  const stride=(running?.42:.3)*Math.min(a,1.1);
  const legs=[[h.L,-.11,ph],[h.R,.11,ph+Math.PI]],g=[],tz=[],lift=[];
  for(const [leg,sx,p] of legs){
    const z=-Math.sin(p)*stride, wx=rx+sx*cf+z*sf, wz=rz-sx*sf+z*cf;
    g.push(walkY(wx,wz)-ry);tz.push(z);lift.push(Math.max(0,Math.cos(p))*(running?.2:.13)*Math.min(a,1));
  }
  // pelvis drops to the lower foot so the uphill foot never sinks and the downhill foot still reaches
  const drop=clamp(Math.min(0,g[0],g[1]),-.5,0);
  const bodyY=drop-.03*Math.min(a,1)+.02*Math.min(a,1)*Math.abs(Math.cos(ph))-(st.exhausted?.04:0);
  h.body.position.y+=(bodyY-h.body.position.y)*Math.min(1,dt*14);
  const footPitch=Math.atan(clamp(slope,-1,1));
  for(let n=0;n<2;n++){
    const leg=legs[n][0],ty=(g[n]+lift[n]+.06)-h.body.position.y-.93;
    solveLeg(leg,tz[n],ty,k,lift[n]>.01?footPitch*.4:footPitch);
  }
  to(h.AL.sh,-Math.sin(ph)*.5*a+.1+Math.max(slope,0)*.3);to(h.AR.sh,Math.sin(ph)*.5*a+.1+Math.max(slope,0)*.3);
  to(h.AL.el,-.35-.2*a);to(h.AR.el,-.35-.2*a);
  to(h.upper,-(running?.25:.08)*a-(st.exhausted?.3:0)-clamp(slope,0,1)*.35);
  h.head.rotation.x=st.exhausted?-.2:clamp(slope,0,1)*.25;
}

/* ---------- other hikers & greetings ---------- */
const NPC_DEF=[
  {jacket:'#2f6db0',pack:'#3b3b3b',cap:'#c9c2b0',dir:-1,f:.3,speed:2.6},
  {jacket:'#d9a82a',pack:'#7a2d2d',cap:'#2b2f33',dir:-1,f:.48,speed:2.3},
  {jacket:'#3e7a4a',pack:'#29425c',cap:'#8a2b2b',dir:-1,f:.64,speed:2.8},
  {jacket:'#6a4c93',pack:'#444444',cap:'#d9d4c8',dir:-1,f:.8,speed:2.2},
  {jacket:'#d9772b',pack:'#2f5663',cap:'#2b2f33',dir:-1,f:.95,speed:2.5},
  {jacket:'#2b8a8a',pack:'#5a4632',cap:'#e6b44a',dir:1,f:.13,speed:1.5},
  {jacket:'#a33a5a',pack:'#303a44',cap:'#2b2f33',dir:1,f:.56,speed:1.3},
];
const LINES_DOWN=['山頂は風が強いので上着を忘れずに','この先の鎖場、ゆっくり行けば大丈夫ですよ','雲海、最高でしたよ！','がんばってください、もう少しです','ライチョウいましたよ。会えるといいですね','白嶺小屋のコーヒー、おいしかったです','水場の水、冷たくてうまいですよ'];
const LINES_UP=['お先にどうぞ〜','いいペースですね！','お互い気をつけて登りましょう','山頂でまた会いましょう'];
let npcs=[];
function trailAt(d){d=clamp(d,0,pathLen);const fi=d/2,i=Math.min(Math.floor(fi),pts.length-2),t=clamp(fi-i,0,1),a=pts[i],b=pts[i+1];let tx=b.x-a.x,tz=b.z-a.z;const l=Math.hypot(tx,tz)||1;return{x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t,tx:tx/l,tz:tz/l}}
function placeNpc(n){n.d=n.f*pathLen;const tr=trailAt(n.d);n.off=.5*n.side;n.x=tr.x-tr.tz*n.off;n.z=tr.z+tr.tx*n.off;n.face=Math.atan2(-tr.tx*n.dir,-tr.tz*n.dir);n.phase=Math.random()*6;n.saidHi=false;n.greeted=false;n.pause=0;if(n.h){n.h.root.position.set(n.x,walkY(n.x,n.z),n.z);n.h.root.rotation.y=n.face}}
const bubbles=[];
function say(who,text,dur=2.6){
  let b=bubbles.find(x=>x.who===who);
  if(!b){const el=document.createElement('div');el.className='bubble';$('bubbles').appendChild(el);b={who,el};bubbles.push(b)}
  b.el.textContent=text;b.el.classList.toggle('me',who==='player');b.until=T+dur;b.el.style.display='block';
}
const _bp=new THREE.Vector3();
function updateBubbles(){
  camera.updateMatrixWorld();
  for(const b of bubbles){
    if(T>b.until||mode!=='play'){b.el.style.display='none';continue}
    if(b.who==='player'){if(S.view!==3){b.el.style.display='none';continue}_bp.set(S.x,hiker.root.position.y+hiker.body.position.y+2.05,S.z)}
    else _bp.set(b.who.x,b.who.h.root.position.y+2.05,b.who.z);
    _bp.project(camera);
    if(_bp.z>1||_bp.z<-1){b.el.style.display='none';continue}
    b.el.style.display='block';b.el.style.transform=`translate(${(_bp.x+1)/2*innerWidth}px,${(1-_bp.y)/2*innerHeight}px) translate(-50%,-100%)`;
  }
}
let greetTarget=null;
function greet(){
  const n=greetTarget;
  if(!n&&oji&&oji.st==='follow'&&mode==='play'){say('player','こんにちは！',1.6);setTimeout(()=>say(oji,OJI_EXTRA[0],3.4),700);oji.extra+=2;oji.t=-1;return}
  if(!n||n.greeted||mode!=='play')return;
  n.greeted=true;n.pause=2.8;S.greets++;
  say('player','こんにちは！',1.8);
  setTimeout(()=>{const L=n.dir<0?LINES_DOWN:LINES_UP;say(n,L[(Math.random()*L.length)|0],3.4);S.stam=Math.min(100,S.stam+8);toastQ.push('元気をもらった（体力+8）')},850);
}
function updateNpcs(dt){
  greetTarget=null;let best=1e9;
  for(const n of npcs){
    const dp=Math.hypot(S.x-n.x,S.z-n.z);
    n.pause-=dt;
    const spd=n.pause>0?0:n.speed*(dp<8?.55:1);
    n.d+=n.dir*spd*dt;
    if(n.dir<0&&n.d<25){n.d=pathLen-40;n.saidHi=n.greeted=false}
    if(n.dir>0&&n.d>pathLen-30){n.d=40;n.saidHi=n.greeted=false}
    const tr=trailAt(n.d);
    n.off+=((dp<16?1.55:.45)*n.side-n.off)*Math.min(1,dt*2);
    const nx=tr.x-tr.tz*n.off,nz=tr.z+tr.tx*n.off;
    const moved=Math.hypot(nx-n.x,nz-n.z),grade=moved>1e-4?(heightAt(nx,nz)-heightAt(n.x,n.z))/moved:0;
    n.x=nx;n.z=nz;n.phase+=moved*.78;
    const tf=n.pause>0?Math.atan2(-(S.x-n.x),-(S.z-n.z)):Math.atan2(-tr.tx*n.dir,-tr.tz*n.dir);
    let dd=((tf-n.face+Math.PI*3)%(Math.PI*2))-Math.PI;n.face+=dd*Math.min(1,dt*6);
    n.h.root.position.set(nx,walkY(nx,nz),nz);n.h.root.rotation.y=n.face;
    n.h.root.visible=dp<900;
    if(dp<160)animHiker(n.h,n,dt,moved,false,grade);
    if(mode==='play'){
      if(dp<11&&!n.saidHi){n.saidHi=true;say(n,n.dir<0?'こんにちは〜':'こんにちは！',2.2)}
      if(dp>50){n.saidHi=false;n.greeted=false}
      if(dp<12&&!n.greeted&&dp<best){best=dp;greetTarget=n}
    }
  }
  $('greetBtn').classList.toggle('show',!!greetTarget);
}

/* ---------- the advice ojisan ---------- */
const OJI_A=['おっ、登山かい？ちょっといいかな','そのザック、肩ベルトもっと締めたほうがいいよ','登りはね、歩幅を小さく。これ基本だから','わしが若い頃はこの山、2時間で登ったもんだよ','水はね、喉が渇く前に飲むの。わかる？','その靴、ちょっとソールが柔らかすぎるね','ストックはあと5cm短くしたほうがいいな','呼吸はね、2回吸って2回吐く。ほら、やってみて','天気図見てきた？午後から崩れるよ、たぶん','樺平小屋のカレーは食べとかないと損だよ'];
const OJI_B=['また会ったねぇ！さっきの続きだけどね','雪のとこはね、かかとから踏み込むんだよ','レイヤリングって知ってる？汗冷えが一番怖いの','ライチョウはね、追いかけちゃダメだよ','わしはこの山、今年で48回目なんだよ','山頂の写真はね、逆光に気をつけて','下りのほうが事故は多いからね。油断しないように','サルにはね、食べ物を見せないの。これ大事'];
const OJI_EXTRA=['挨拶できる若者はいいねぇ！よし、もう1つ教えよう','ザックの重いものは背中側に入れるんだよ','地図はね、紙も持ってなきゃダメだよ'];
let oji=null;
function ojiReset(){if(!oji)return;Object.assign(oji,{st:'wait',spot:0,line:0,t:0,quota:0,x:oji.A.x,z:oji.A.z,phase:0,resting:false,exhausted:false,extra:0});oji.face=oji.A.face;oji.h.root.position.set(oji.x,walkY(oji.x,oji.z),oji.z);oji.h.root.rotation.y=oji.face}
function updateOji(dt){
  if(!oji)return;const o=oji,dp=Math.hypot(S.x-o.x,S.z-o.z);let moved=0,grade=0;
  const lines=o.spot===0?OJI_A:OJI_B;
  if(o.st==='wait'){
    o.face+=(((Math.atan2(-(S.x-o.x),-(S.z-o.z))-o.face+Math.PI*3)%(Math.PI*2))-Math.PI)*(dp<30?Math.min(1,dt*3):0);
    if(dp<14&&mode==='play'&&!S.done){o.st='follow';o.line=0;o.t=0;o.quota=lines.length;say(o,lines[0],3.4);o.line=1;S.advice++;toastQ.push('話好きのおじさんに捕まった…（走れば振り切れる）')}
  }else if(o.st==='follow'){
    const fx=-Math.sin(S.face),fz=-Math.cos(S.face);
    const tx=S.x+fz*-1.7-fx*1.1,tz=S.z-fx*-1.7-fz*1.1; // right side, a bit behind
    let dx=tx-o.x,dz=tz-o.z;const l=Math.hypot(dx,dz);
    if(l>.15){const g0=(heightAt(o.x+dx/l,o.z+dz/l)-heightAt(o.x,o.z));const sp=Math.min(l*3,7.9*clamp(Math.exp(-1.3*Math.abs(g0+.05))/Math.exp(-.065),.45,1.1));
      const st=Math.min(l,sp*dt);const nx=o.x+dx/l*st,nz=o.z+dz/l*st;moved=st;grade=(heightAt(nx,nz)-heightAt(o.x,o.z))/Math.max(st,1e-4);o.x=nx;o.z=nz;
      o.face+=(((Math.atan2(-dx,-dz)-o.face+Math.PI*3)%(Math.PI*2))-Math.PI)*Math.min(1,dt*8)}
    else o.face+=(((S.face-o.face+Math.PI*3)%(Math.PI*2))-Math.PI)*Math.min(1,dt*4);
    o.phase+=moved*.78;
    o.t+=dt;
    if(o.t>4.3){o.t=0;
      if(o.extra>0){say(o,OJI_EXTRA[1+((Math.random()*2)|0)],3.6);o.extra--;S.advice++}
      else if(o.line<o.quota){say(o,lines[o.line++],3.6);S.advice++}
      else{say(o,o.spot===0?'ま、がんばって！わしはここで一服するよ':'じゃ、山頂でまたね！',3);o.st='bye';o.t=0;toastQ.push('おじさんのアドバイスを全部聞いた（'+S.advice+'個）')}}
    if(dp>30){say(o,'おーい、まだ話は終わってないよ〜！',2.6);toastQ.push('おじさんを振り切った');o.st='bye';o.t=0}
  }else if(o.st==='bye'){
    o.t+=dt;if(o.t>6&&dp>40){if(o.spot===0&&o.B){o.spot=1;o.x=o.B.x;o.z=o.B.z;o.face=o.B.face;o.st='wait'}else o.st='gone'}
  }
  o.h.root.position.set(o.x,walkY(o.x,o.z),o.z);o.h.root.rotation.y=o.face;o.h.root.visible=o.st!=='gone';
  if(dp<160)animHiker(o.h,o,dt,moved,false,grade);
}

/* ---------- food-stealing monkeys ---------- */
let troops=[];
function buildMonkey(){
  const M=(c,r=.95)=>new THREE.MeshStandardMaterial({color:C(c),roughness:r});
  const fur=M('#7b6a57'),dark=M('#5a4d40'),face=M('#d5786c',.6),eye=M('#1a1410',.4);
  const root=new THREE.Group(),body=new THREE.Group();root.add(body);
  const sph=new THREE.SphereGeometry(1,12,10);
  const part=(g,m,x,y,z,sx,sy,sz,p)=>{const o=new THREE.Mesh(g,m);o.position.set(x,y,z);o.scale.set(sx,sy,sz);o.castShadow=true;(p||body).add(o);return o};
  part(sph,fur,0,0,0,.2,.19,.3);
  part(sph,face,0,-.02,.27,.08,.07,.05);
  const head=new THREE.Group();head.position.set(0,.14,-.3);body.add(head);
  part(sph,fur,0,0,0,.13,.13,.13,head);part(sph,face,0,-.01,-.1,.085,.08,.05,head);
  part(sph,eye,-.035,.02,-.14,.015,.015,.01,head);part(sph,eye,.035,.02,-.14,.015,.015,.01,head);
  const legs=[];
  for(const [x,z] of [[-.11,-.2],[.11,-.2],[-.11,.2],[.11,.2]]){const g=new THREE.Group();g.position.set(x,-.05,z);body.add(g);const lg=new THREE.CylinderGeometry(.045,.035,.36,6);lg.translate(0,-.18,0);part(lg,dark,0,0,0,1,1,1,g);legs.push(g)}
  const tail=part(new THREE.CylinderGeometry(.03,.02,.14,5),fur,0,.08,.32,1,1,1);tail.rotation.x=-.8;
  const carry=new THREE.Group();carry.position.set(0,-.08,-.14);head.add(carry);
  part(new THREE.CylinderGeometry(.09,.09,.05,3),M('#f3f1ea'),0,0,0,1,1,1,carry).rotation.x=Math.PI/2;
  part(new THREE.BoxGeometry(.08,.07,.055),M('#1c2a1c'),0,-.03,0,1,1,1,carry);
  carry.visible=false;
  scene.add(root);
  return{root,body,head,legs,carry};
}
function squeak(){const ctx=AU.ctx;if(!ctx||!AU.on)return;const t=ctx.currentTime;for(let i=0;i<2;i++){const o=ctx.createOscillator(),g=ctx.createGain();o.type='sawtooth';o.frequency.setValueAtTime(1400,t+i*.18);o.frequency.exponentialRampToValueAtTime(2300,t+i*.18+.08);o.frequency.exponentialRampToValueAtTime(900,t+i*.18+.16);
  const f=ctx.createBiquadFilter();f.type='bandpass';f.frequency.value=1800;f.Q.value=2;g.gain.setValueAtTime(0,t+i*.18);g.gain.linearRampToValueAtTime(.08,t+i*.18+.02);g.gain.exponentialRampToValueAtTime(.001,t+i*.18+.17);o.connect(f).connect(g).connect(AU.master);o.start(t+i*.18);o.stop(t+i*.18+.2)}}
function monkeysReset(){for(const tr of troops){tr.seen=false;for(const m of tr.ms){Object.assign(m,{x:m.hx,z:m.hz,st:'idle',t:Math.random()*3,cool:0,wx:m.hx,wz:m.hz,ph:0,face:Math.random()*6});m.g.carry.visible=false}}}
function shoo(){
  if(mode!=='play')return;let any=false;
  for(const tr of troops)for(const m of tr.ms){const d=Math.hypot(S.x-m.x,S.z-m.z);if(d<15&&m.st!=='flee'){m.st='scared';m.t=3.2;m.cool=30;any=true}}
  say('player','シッ！シッ！',1.4);if(any){squeak();toastQ.push('サルを追い払った')}
}
function eat(){
  if(mode!=='play'||S.eating>0)return;
  if(S.food<=0){toast('行動食がない。小屋で買い足そう',2200);return}
  S.food--;S.eating=2;say('player','もぐもぐ…',2);
  for(const tr of troops)for(const m of tr.ms){if(Math.hypot(S.x-m.x,S.z-m.z)<50&&m.st==='idle'&&m.cool<=0){m.st='approach';m.t=0}}
}
let shooShow=false;
function updateMonkeys(dt){
  shooShow=false;
  for(const tr of troops){
    const dT=Math.hypot(S.x-tr.x,S.z-tr.z);
    if(dT>260)continue;
    if(!tr.seen&&dT<45&&mode==='play'){tr.seen=true;toastQ.push('サルの群れだ。食べ物に注意');squeak()}
    for(const m of tr.ms){
      const dp=Math.hypot(S.x-m.x,S.z-m.z);m.cool-=dt;m.t-=dt;
      let tx=m.x,tz=m.z,sp=0;
      if(m.st==='idle'){
        if(m.t<0){m.t=2+Math.random()*4;const a=Math.random()*6.28,r=Math.random()*6;m.wx=m.hx+Math.sin(a)*r;m.wz=m.hz+Math.cos(a)*r}
        tx=m.wx;tz=m.wz;sp=1.3;
        const bait=S.resting?30:20;
        if(S.food>0&&m.cool<=0&&dp<bait&&Math.random()<dt*.6&&mode==='play'){m.st='approach';squeak()}
      }else if(m.st==='approach'){
        tx=S.x;tz=S.z;sp=6.6;
        if(dp<1.5){
          if(S.food>0){S.food--;S.stolen++;m.g.carry.visible=true;toastQ.push('サルに行動食を取られた！');squeak();say('player','あっ！',1.2)}
          m.st='flee';m.t=4;m.cool=30;
        }else if(dp>38||S.food<=0){m.st='return';m.cool=12}
        if(dp<13)shooShow=true;
      }
      if(m.st==='flee'||m.st==='scared'){
        const l=Math.max(dp,.01);tx=m.x-(S.x-m.x)/l*10;tz=m.z-(S.z-m.z)/l*10;sp=8.5;
        if(m.t<0){m.st='return'}
      }else if(m.st==='return'){
        tx=m.hx;tz=m.hz;sp=3;if(Math.hypot(m.x-m.hx,m.z-m.hz)<1.5){m.st='idle';m.g.carry.visible=false;m.t=1}
      }
      const dx=tx-m.x,dz=tz-m.z,l=Math.hypot(dx,dz);let moved=0;
      if(l>.3&&sp>0){const st=Math.min(l,sp*dt);const nx=m.x+dx/l*st,nz=m.z+dz/l*st;if((heightAt(nx,nz)-heightAt(m.x,m.z))/st<1.4){m.x=nx;m.z=nz;moved=st}
        m.face+=(((Math.atan2(-dx,-dz)-m.face+Math.PI*3)%(Math.PI*2))-Math.PI)*Math.min(1,dt*10)}
      m.ph+=moved*2.2;
      const g=m.g,run=moved>0;
      g.root.position.set(m.x,heightAt(m.x,m.z)+.4+(run&&sp>5?Math.abs(Math.sin(m.ph))*.1:0),m.z);g.root.rotation.y=m.face;
      const sit=!run&&m.st==='idle';
      g.body.rotation.x+=((sit?.85:(run?Math.sin(m.ph)*.08:.1))-g.body.rotation.x)*Math.min(1,dt*8);
      g.body.position.y+=((sit?.02:0)-g.body.position.y)*Math.min(1,dt*8);
      g.legs.forEach((lg,k)=>{lg.rotation.x=sit?(k<2?-.9:-1.4):(run?Math.sin(m.ph+(k%2?Math.PI:0)+(k<2?0:1.2))*.7:0)});
      g.head.rotation.x=sit?-.7+Math.sin(T*1.3+m.hx)*.15:0;
    }
  }
  $('shooBtn').classList.toggle('show',shooShow&&mode==='play');
}

/* ---------- build world ---------- */
// 生成は重いので、ところどころで主スレッドを返す。返さないと読み込み中に画面とタップが止まる
const breathe=()=>new Promise(r=>setTimeout(r,0));
async function build(){
  pts=makeTrail(); pathLen=pts[pts.length-1].dist;
  hash=new Map();
  pts.forEach((p,i)=>{const k=hkey(Math.floor(p.x/HCELL),Math.floor(p.z/HCELL));let a=hash.get(k);if(!a)hash.set(k,a=[]);a.push(i)});

  // heights
  H=new Float32Array(N*N);
  for(let j=0;j<N;j++){
    for(let i=0;i<N;i++){const x=-HALF+i*CELL,z=-HALF+j*CELL;H[j*N+i]=baseH(x,z)}
    if(j%40===39)await breathe();
  }
  for(let j=0;j<N;j++){
  if(j%6===5)await breathe();
  for(let i=0;i<N;i++){
    const x=-HALF+i*CELL,z=-HALF+j*CELL;
    const np=nearPath(x,z);if(np.i<0)continue;
    let best=null;
    const i0=Math.max(0,np.i-25),i1=Math.min(pts.length-2,np.i+25);
    for(let k=i0;k<=i1;k++){
      const a=pts[k],b=pts[k+1],abx=b.x-a.x,abz=b.z-a.z,ab2=abx*abx+abz*abz||1;
      const t=clamp(((x-a.x)*abx+(z-a.z)*abz)/ab2,0,1);
      const cx=a.x+abx*t,cz=a.z+abz*t,d2=(x-cx)**2+(z-cz)**2;
      if(!best||d2<best.d2)best={d2,h:a.h+(b.h-a.h)*t};
    }
    if(!best)continue;
    const d=Math.sqrt(best.d2);if(d>50)continue;
    const w=d<32?1:1-smooth(32,48,d);
    H[j*N+i]=lerp(H[j*N+i],best.h-.1,w);
  }
  }
  // huts
  const hutDefs=[{name:'樺平小屋',h:950},{name:'白嶺小屋',h:1460}];
  for(const hd of hutDefs){
    let idx=pts.findIndex((p,i)=>i>200&&p.h>=hd.h); if(idx<0) idx=Math.min(200,pts.length-8);
    const p=pts[idx],q=pts[Math.min(idx+3,pts.length-1)];
    let tx=q.x-p.x,tz=q.z-p.z;const l=Math.hypot(tx,tz)||1;tx/=l;tz/=l;
    let nx=-tz,nz=tx; if(Math.hypot(p.x+nx*16,p.z+nz*16)<Math.hypot(p.x-nx*16,p.z-nz*16)){nx=-nx;nz=-nz}
    const hx=p.x+nx*16,hz=p.z+nz*16,hh=p.h;
    huts.push({name:hd.name,x:hx,z:hz,h:hh,idx,px:p.x,pz:p.z});
    const i0=Math.floor((hx-40+HALF)/CELL),i1=Math.ceil((hx+40+HALF)/CELL),j0=Math.floor((hz-40+HALF)/CELL),j1=Math.ceil((hz+40+HALF)/CELL);
    for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){const x=-HALF+i*CELL,z=-HALF+j*CELL;
      // 小屋の平坦化パッドが、20m隣を通る別の折り返しレッグを埋めていた（2026-09-26）。
      // いちばん近い道が小屋から遠い区間なら、その節点は触らない
      const np2=nearPath(x,z); if(np2.i>=0&&Math.abs(np2.i-idx)>60) continue;
      const d=Math.hypot(x-hx,z-hz);const w=1-smooth(12,32,d);H[j*N+i]=lerp(H[j*N+i],hh-.2,w)}
  }

  // renderer
  renderer=new THREE.WebGLRenderer({canvas:$('gl'),antialias:true,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,isTouch?1.3:1.75));
  renderer.setSize(innerWidth,innerHeight,false);
  renderer.outputEncoding=THREE.sRGBEncoding;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.95;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  scene=new THREE.Scene();
  scene.fog=new THREE.FogExp2(0x9aa7b0,.0005);
  camera=new THREE.PerspectiveCamera(66,innerWidth/innerHeight,.1,30000);
  camera.rotation.order='YXZ';
  scene.add(camera);

  // lights
  hemi=new THREE.HemisphereLight(0xbcd0e0,0x3a3528,.5);scene.add(hemi);
  sun=new THREE.DirectionalLight(0xffffff,2);sun.castShadow=true;
  const sm=isTouch?1024:2048;sun.shadow.mapSize.set(sm,sm);
  const sc=sun.shadow.camera;sc.left=-90;sc.right=90;sc.top=90;sc.bottom=-90;sc.near=10;sc.far=1200;
  sun.shadow.bias=-.0005;sun.shadow.normalBias=.8;
  scene.add(sun);scene.add(sun.target);
  headlamp=new THREE.SpotLight(0xfff0d8,0,60,.55,.55,1.4);scene.add(headlamp);scene.add(headlamp.target);

  // sky
  skyMat=new THREE.ShaderMaterial({
    uniforms:{uZen:{value:new THREE.Color()},uHor:{value:new THREE.Color()},uSunCol:{value:new THREE.Color()},uSunDir:{value:new THREE.Vector3(0,1,0)},uNight:{value:0}},
    vertexShader:`varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`uniform vec3 uZen,uHor,uSunCol,uSunDir;uniform float uNight;varying vec3 vDir;
      void main(){vec3 d=normalize(vDir);float y=d.y;float t=pow(clamp(y,0.,1.),.45);
        vec3 col=mix(uHor,uZen,t);
        if(y<0.)col=mix(uHor,uHor*.55,clamp(-y*5.,0.,1.));
        float sd=max(dot(d,uSunDir),0.);
        col+=uSunCol*(pow(sd,5.)*.22+pow(sd,60.)*.45+pow(sd,3.)*.2*(1.-t));
        col+=uSunCol*smoothstep(.99935,.9998,sd)*9.*step(-.02,y);
        vec3 q=floor(d*380.);float h=fract(sin(dot(q,vec3(12.9898,78.233,37.719)))*43758.5453);
        col+=vec3(.9,.95,1.)*smoothstep(.9972,1.,h)*uNight*step(0.,y)*1.6;
        gl_FragColor=vec4(col,1.);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }`,
    side:THREE.BackSide,depthWrite:false,depthTest:false,fog:false});
  const sky=new THREE.Mesh(new THREE.SphereGeometry(20000,32,16),skyMat);sky.renderOrder=-10;sky.frustumCulled=false;sky.name='sky';scene.add(sky);

  // terrain
  const pos=new Float32Array(N*N*3),col=new Float32Array(N*N*3),uv=new Float32Array(N*N*2);
  const cForest=[C('#2f3d24'),C('#3e4a2c'),C('#4a5332')],cMeadow=C('#7a7446'),cAutumn=C('#8c4a26'),cGold=C('#9a7e3c'),cPine=C('#2e4428'),
        cRock=C('#77746c'),cRockD=C('#58564f'),cSnow=C('#e9eef2'),cValley=C('#44532f');
  const tmp=new THREE.Color();
  for(let j=0;j<N;j++)for(let i=0;i<N;i++){
    const k=j*N+i,x=-HALF+i*CELL,z=-HALF+j*CELL,h=H[k];
    pos[k*3]=x;pos[k*3+1]=h;pos[k*3+2]=z;uv[k*2]=x/14;uv[k*2+1]=z/14;
    const hx=(H[j*N+Math.min(i+1,SEG)]-H[j*N+Math.max(i-1,0)])/(2*CELL),hz=(H[Math.min(j+1,SEG)*N+i]-H[Math.max(j-1,0)*N+i])/(2*CELL);
    const slope=Math.hypot(hx,hz),alt=realAlt(h);
    const n=fbm(x*.012,z*.012,3),n2=fbm(x*.004+5,z*.004-3,3);
    // forest
    tmp.copy(cForest[0]).lerp(cForest[1],clamp(n*.9+.5,0,1)).lerp(cForest[2],clamp(n2+.3,0,1)*.5);
    tmp.lerp(cValley,1-smooth(1400,1650,alt));
    // alpine band
    const alp=smooth(2330,2560,alt);
    if(alp>0){const a=cMeadow.clone().lerp(n2>.08?cAutumn:cGold,clamp(Math.abs(n2)*3,0,1)*.8).lerp(cPine,clamp(n*1.4+.3,0,1)*(1-smooth(2700,2850,alt)));tmp.lerp(a,alp)}
    // rock
    const rk=Math.max(smooth(.62,1.0,slope),smooth(2780,2950,alt));
    tmp.lerp(cRock.clone().lerp(cRockD,clamp(n*1.5+.5,0,1)),rk);
    // snow
    const sn=smooth(2870,2990,alt)*(1-smooth(.5,.8,slope))*clamp(.6+n*2,0,1);
    tmp.lerp(cSnow,sn);
    col[k*3]=tmp.r;col[k*3+1]=tmp.g;col[k*3+2]=tmp.b;
  }
  const idx=new Uint32Array(SEG*SEG*6);let p=0;
  for(let j=0;j<SEG;j++)for(let i=0;i<SEG;i++){const a=j*N+i,b=a+1,c=a+N,d=c+1;idx[p++]=a;idx[p++]=c;idx[p++]=b;idx[p++]=b;idx[p++]=c;idx[p++]=d}
  const tg=new THREE.BufferGeometry();
  tg.setAttribute('position',new THREE.BufferAttribute(pos,3));tg.setAttribute('color',new THREE.BufferAttribute(col,3));tg.setAttribute('uv',new THREE.BufferAttribute(uv,2));
  tg.setIndex(new THREE.BufferAttribute(idx,1));tg.computeVertexNormals();
  const det=noiseTex(256,228,70);det.anisotropy=renderer.capabilities.getMaxAnisotropy();
  const terrain=new THREE.Mesh(tg,new THREE.MeshStandardMaterial({vertexColors:true,map:det,roughness:.97,metalness:0}));
  terrain.receiveShadow=true;terrain.castShadow=true;scene.add(terrain);

  // trail ribbon — a shelf. Stretches that would stand up as a wall become chain pitches.
  {
    const n=pts.length,rp=new Float32Array(n*2*3),ru=new Float32Array(n*2*2),ri=[];
    const meta=[];
    for(let i=0;i<n;i++){
      const a=pts[Math.max(i-1,0)],b=pts[Math.min(i+1,n-1)];let tx=b.x-a.x,tz=b.z-a.z;const l=Math.hypot(tx,tz)||1;tx/=l;tz/=l;
      const w=1.25+.2*Math.sin(i*.37)+(i>n-40?1.5:0),pp=pts[i];
      const ux=-tz,uz=tx,lx=pp.x+ux*w,lz=pp.z+uz*w,rx=pp.x-ux*w,rz=pp.z-uz*w;
      const rawL=heightAt(lx,lz),rawR=heightAt(rx,rz);
      const dist=Math.max(Math.hypot(b.x-a.x,b.z-a.z),1);
      const along=Math.abs(heightAt(b.x,b.z)-heightAt(a.x,a.z))/dist;
      const cross=Math.abs(rawL-rawR)/(2*w);
      meta.push({ux,uz,w,lx,lz,rx,rz,rawL,rawR,along,cross,pp});
    }
    const mark=new Uint8Array(n);
    for(let i=1;i<n-1;i++) if(meta[i].along>.72||meta[i].cross>.62) mark[i]=1;
    const dil=new Uint8Array(n);
    for(let i=0;i<n;i++) if(mark[i]) for(let k=-2;k<=2;k++){const j=i+k;if(j>1&&j<n-1)dil[j]=1}
    let run=0;
    for(let i=0;i<=n;i++){
      if(i<n&&dil[i]) run++;
      else{if(run>0&&run<5){for(let j=i-run;j<i;j++)dil[j]=0}run=0}
    }
    chainSpans.length=0;let s0=-1;
    for(let i=0;i<=n;i++){
      if(i<n&&dil[i]){if(s0<0)s0=i}
      else if(s0>=0){chainSpans.push([s0,i-1]);s0=-1}
    }
    // 道は地形より下へ潜らせない（2026-09-26）。
    // 折り返しが近接すると 20m の地形グリッドが両方の高さを表現できず、低い側の道が
    // 山に埋まって「道が途切れた」ように見えていた（実測 最悪26.9m・全長の36%）。
    // 地形が道より高い区間では、道をその地形の上まで持ち上げて必ず見える状態にする。
    const benches=new Float32Array(n),grounds=new Float32Array(n);
    for(let i=0;i<n;i++){
      const m=meta[i],c0=heightAt(m.pp.x,m.pp.z);
      // 道の設計高 pp.h ではなく、実際にできあがった地形の面に沿わせる。
      // pp.h を下限にすると地形が下がった折り返しで道が宙に浮き（最悪19.8m）、
      // そのまま使うと地形が上がった折り返しで道が埋まる（最悪26.9m）。地形に沿えば両方消える。
      // 崖の横断勾配で持ち上がりすぎないよう、左右の端が押し上げてよい量は45cmまでに抑える
      grounds[i]=c0+Math.min(Math.max(0,Math.max(m.rawL,m.rawR)-c0),.45);
      benches[i]=grounds[i]+.12;
    }
    // 角をならす。ならした結果は必ず [地面+12cm, 地面+45cm] に収め、潜りも浮きも作らない
    {
      const nb=benches.slice();
      for(let i=0;i<n;i++){let a=0,c=0;for(let k=-2;k<=2;k++){const j=clamp(i+k,0,n-1);a+=benches[j];c++}nb[i]=a/c}
      for(let i=0;i<n;i++)benches[i]=clamp(nb[i],grounds[i]+.12,grounds[i]+.45);
    }
    for(let i=0;i<n;i++){
      const m=meta[i];
      const bench=benches[i];
      ribbon.push({x:m.pp.x,z:m.pp.z,yL:bench,yR:bench,ux:m.ux,uz:m.uz,hw:m.w,chain:!!dil[i]});
      rp.set([m.lx,bench,m.lz,m.rx,bench,m.rz],i*6);
      ru.set([0,m.pp.dist/3,1,m.pp.dist/3],i*4);
      if(i<n-1){const q=i*2;ri.push(q,q+2,q+1,q+1,q+2,q+3)}
    }
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(rp,3));g.setAttribute('uv',new THREE.BufferAttribute(ru,2));g.setIndex(ri);g.computeVertexNormals();
    const m=new THREE.MeshStandardMaterial({map:gravelTex(),roughness:1,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-4});
    const mesh=new THREE.Mesh(g,m);mesh.receiveShadow=true;mesh.name='trail';scene.add(mesh);trailMesh=mesh;
  }


  // ---- landmark planning (positions first, so vegetation keeps clear) ----
  const idxAt=d=>clamp(Math.round(d/2),2,pts.length-3);
  const frame=(i)=>{const a=pts[i-1],b=pts[i+1];let tx=b.x-a.x,tz=b.z-a.z;const l=Math.hypot(tx,tz)||1;tx/=l;tz/=l;return{p:pts[i],tx,tz,nx:-tz,nz:tx}};
  const side=(i,off,al=0)=>{const f=frame(i);return{x:f.p.x+f.nx*off+f.tx*al,z:f.p.z+f.nz*off+f.tz*al,f}};
  const distOfH=h=>{const i=pts.findIndex(p=>p.h>=h);return i<0?pathLen:pts[i].dist};
  const plan=[];
  const addLM=(d,kind,msg,r=10,off=0)=>{const i=idxAt(d),q=side(i,off);plan.push({d:pts[i].dist,i,kind,msg,x:q.x,z:q.z,off});LM.clears.push({x:q.x,z:q.z,r});};
  addLM(40,'board',null,6,-4.5);
  addLM(150,'stream','沢の音。丸太橋を渡ろう',9,0);
  addLM(280,'jizo','苔むしたお地蔵さんが見守っている',5,3.6);
  addLM(400,'serow',null,4,16);
  addLM(520,'log',null,8,5.5);
  addLM(640,'spring',null,6,-3.8);
  addLM(700,'steps','木の階段が続く急登',2,0);
  addLM(1000,'bench','ベンチで小休止できる',5,3.5);
  addLM(1250,'boulder','天狗岩。見上げるほどの巨岩',12,-9);
  addLM(1480,'birches','ダケカンバの黄葉が始まった',3,0);
  addLM(distOfH(1150),'treeline','森林限界を越えた。視界が一気に開ける',4,3.2);
  addLM(distOfH(1150)+160,'raicho',null,3,7);
  {let best=-1,bg=0;const a=idxAt(distOfH(1200)),b=idxAt(Math.min(distOfH(1440),pathLen-200));for(let i=a;i<b-18;i++){const g=(pts[i+18].h-pts[i].h)/36;if(g>bg){bg=g;best=i}}
   if(best>0)addLM(pts[best].dist,'chain','鎖場。鎖をつかんで慎重に',3,2.1);}
  addLM(Math.min(distOfH(1640),pathLen-260),'snow','足元に雪が出てきた',3,0);
  addLM(pathLen-220,'almost','山頂まであと少し',3,2.8);
  addLM(1180,'ojiA',null,4,3);
  for(const d of [360,900,1600]) if(d<distOfH(1080)) addLM(d,'monkeys',null,8,13);
  for(const d of [2000,2200,2550,2800,3150]) if(d<pathLen-250) addLM(d,'cairn',null,2,2.4+Math.random());
  LM.evs.push({d:distOfH(CLOUD_Y+25),msg:'雲海の上に出た。遠くの峰まで見渡せる'});
  plan.forEach(p=>{if(p.msg)LM.evs.push({d:p.d,msg:p.msg})});
  // vegetation & rocks
  const dummy=new THREE.Object3D();
  const coneG=new THREE.ConeGeometry(1,1,7,1);coneG.translate(0,.5,0);
  const trunkG=new THREE.CylinderGeometry(.6,1,1,5);trunkG.translate(0,.5,0);
  const blobG=new THREE.IcosahedronGeometry(1,1);
  const rockG=new THREE.DodecahedronGeometry(1,0);
  const mk=(g,max,color,rough=.95)=>{const m=new THREE.InstancedMesh(g,new THREE.MeshStandardMaterial({color:0xffffff,roughness:rough}),max);m.castShadow=true;m.receiveShadow=true;m.frustumCulled=false;m.count=0;m.userData.c=color;scene.add(m);return m};
  const conifer=mk(coneG,12000),trunk=mk(trunkG,15000),birch=mk(blobG,3200),pine=mk(blobG,5000),rock=mk(rockG,5000),bush=mk(blobG,14000),fern=mk(coneG,6000);bush.castShadow=false;fern.castShadow=false;
  heavy.push(conifer,trunk,birch,pine,rock,bush,fern);
  const put=(im,x,y,z,sx,sy,sz,ry,col,rx=0)=>{if(im.count>=im.instanceMatrix.count)return;dummy.position.set(x,y,z);dummy.rotation.set(rx,ry,0);dummy.scale.set(sx,sy,sz);dummy.updateMatrix();im.setMatrixAt(im.count,dummy.matrix);im.setColorAt(im.count,col);im.count++;
    if(im===trunk)addSolid(x,z,Math.max(sx,sz)*.62);
    else if(im===rock)addSolid(x,z,Math.max(sx,sz)*.7)};
  const conCols=['#22331d','#2a3b22','#1f2f1c','#314227'].map(C),birCols=['#c9a23a','#d4b04a','#b98a2c','#c4772c','#a8402b'].map(C),pinCols=['#2a4526','#324f2c','#26401f'].map(C),
        rockCols=['#7d7a73','#6b6962','#8f8c84','#5f5d58'].map(C),trunkC=C('#4a3626'),birchT=C('#d6d0c3');
  const clearOf=(x,z)=>{for(const c of LM.clears)if(Math.hypot(x-c.x,z-c.z)<c.r)return false;for(const h of huts)if(Math.hypot(x-h.x,z-h.z)<24)return false;if(Math.hypot(x,z)<28)return false;if(Math.hypot(x-pts[0].x,z-pts[0].z)<16)return false;return Math.hypot(x,z)<BOUND+150};
  function plant(x,z,pathMin){
    if(!clearOf(x,z))return;const np=nearPath(x,z);if(np.i>=0&&np.d<pathMin)return;
    const y=heightAt(x,z),alt=realAlt(y),sl=slopeAt(x,z),r=rnd();
    if(alt<2330){
      if(sl>.9)return;
      if(alt>1850&&r<.22){const Hh=6+rnd()*6;put(trunk,x,y-.2,z,.22,Hh*.7,.22,0,birchT);put(birch,x,y+Hh*.62,z,2+rnd()*1.2,2.6+rnd()*1.4,2+rnd()*1.2,rnd()*6,birCols[(rnd()*birCols.length)|0]);return}
      const Hh=(9+rnd()*12)*(1-smooth(1950,2400,alt)*.55);const R=Hh*(.2+rnd()*.06);
      put(trunk,x,y-.3,z,.35,Hh*.3,.35,0,trunkC);put(conifer,x,y+Hh*.12,z,R,Hh*.9,R,rnd()*6,conCols[(rnd()*4)|0]);
    }else if(alt<2480){
      if(sl>1)return;
      if(r<.35){const Hh=3+rnd()*4;put(conifer,x,y,z,Hh*.3,Hh,Hh*.3,rnd()*6,conCols[(rnd()*4)|0])}
      else if(r<.5){put(birch,x,y+1.2,z,1.6,1.3,1.6,rnd()*6,birCols[(rnd()*birCols.length)|0])}
      else put(pine,x,y+.2,z,2+rnd()*3,.9+rnd()*.8,2+rnd()*3,rnd()*6,pinCols[(rnd()*3)|0]);
    }else if(alt<2860){
      if(sl>1.1)return;
      if(r<.68)put(pine,x,y+.15,z,1.8+rnd()*3.2,.7+rnd()*.8,1.8+rnd()*3.2,rnd()*6,pinCols[(rnd()*3)|0]);
      else{const s=.5+rnd()*2;put(rock,x,y+s*.25,z,s,s*(.5+rnd()*.4),s*(.8+rnd()*.5),rnd()*6,rockCols[(rnd()*4)|0],rnd())}
    }else{
      if(r<.6){const s=.4+rnd()*1.8;put(rock,x,y+s*.2,z,s,s*(.45+rnd()*.4),s*(.8+rnd()*.5),rnd()*6,rockCols[(rnd()*4)|0],rnd())}
    }
  }
  for(let i=0;i<pts.length;i+=3){
    if(i%60===0)await breathe();
    const a=pts[Math.max(i-1,0)],b=pts[Math.min(i+1,pts.length-1)];let tx=b.x-a.x,tz=b.z-a.z;const l=Math.hypot(tx,tz)||1;tx/=l;tz/=l;
    for(let k=0;k<7;k++){const side=rnd()<.5?-1:1,off=(5+Math.pow(rnd(),1.7)*170)*side,al=(rnd()-.5)*12;plant(pts[i].x-tz*off+tx*al,pts[i].z+tx*off+tz*al,4.2)}
    if(i%9===0&&realAlt(pts[i].h)>2250){const side=rnd()<.5?-1:1,off=(1.9+rnd()*1.8)*side;const x=pts[i].x-tz*off,z=pts[i].z+tx*off,s=.25+rnd()*.6;put(rock,x,heightAt(x,z)+s*.2,z,s,s*.6,s*.9,rnd()*6,rockCols[(rnd()*4)|0],rnd())}
  }
  // near-path forest & undergrowth so the trail edge is never empty
  const sasaC=['#4f6b33','#5b7a3a','#465f2e'].map(C),fernC=['#3f6a2e','#4d7a35'].map(C),alpC=['#9a3b26','#b35a2a','#a88a3a','#6f7a3c','#c9b060'].map(C),mossC=C('#56683a'),snowC=C('#eef2f5');
  for(let i=2;i<pts.length-4;i+=2){
    if(i%80===0)await breathe();
    const f=frame(i),alt=realAlt(pts[i].h);
    if(rnd()<.55){const sd=rnd()<.5?-1:1,off=(4.2+rnd()*16)*sd;plant(f.p.x+f.nx*off+f.tx*(rnd()-.5)*4,f.p.z+f.nz*off+f.tz*(rnd()-.5)*4,4)}
    for(let k=0;k<4;k++){
      const sd=rnd()<.5?-1:1,off=(1.7+Math.pow(rnd(),1.4)*7)*sd,x=f.p.x+f.nx*off+f.tx*(rnd()-.5)*4,z=f.p.z+f.nz*off+f.tz*(rnd()-.5)*4;
      if(!clearOf(x,z))continue;const y=heightAt(x,z);
      if(alt<2330){
        if(rnd()<.7){const sz=.5+rnd()*.7;put(bush,x,y+sz*.25,z,sz*1.4,sz*.55,sz*1.4,rnd()*6,sasaC[(rnd()*3)|0])}
        else{const sz=.5+rnd()*.5;put(fern,x,y+sz*.9,z,sz*.9,sz*.9,sz*.9,rnd()*6,fernC[(rnd()*2)|0],Math.PI)}
      }else if(alt<2880){const sz=.25+rnd()*.5;put(bush,x,y+sz*.15,z,sz*1.6,sz*.4,sz*1.6,rnd()*6,alpC[(rnd()*5)|0])}
      else if(rnd()<.35){const sz=.8+rnd()*1.6;put(bush,x,y+.02,z,sz*1.6,.12,sz,rnd()*6,snowC)}
    }
  }
  // extra snow fields near summit
  for(let k=0;k<260;k++){const r=60+rnd()*280,t=rnd()*6.283,x=Math.sin(t)*r,z=Math.cos(t)*r;if(realAlt(heightAt(x,z))<2900||slopeAt(x,z)>.6||!clearOf(x,z))continue;const np2=nearPath(x,z);if(np2.i>=0&&np2.d<3)continue;const sz=2+rnd()*6;put(bush,x,heightAt(x,z)+.05,z,sz*1.5,.2,sz,rnd()*6,snowC)}
  for(let k=0;k<4500;k++){if(k%400===399)await breathe();const r=Math.sqrt(rnd())*BOUND,t=rnd()*Math.PI*2;plant(Math.sin(t)*r,Math.cos(t)*r,6)}
  for(const im of [conifer,trunk,birch,pine,rock,bush,fern]){im.instanceMatrix.needsUpdate=true;if(im.instanceColor)im.instanceColor.needsUpdate=true}

  // trail markers (posts + red tape)
  const postG=new THREE.BoxGeometry(.12,1.3,.12);postG.translate(0,.65,0);
  const tapeG=new THREE.BoxGeometry(.16,.18,.16);
  const postM=new THREE.InstancedMesh(postG,new THREE.MeshStandardMaterial({color:C('#6b5236'),roughness:.9}),200),tapeM=new THREE.InstancedMesh(tapeG,new THREE.MeshStandardMaterial({color:C('#d23b2e'),roughness:.6}),200);
  postM.count=tapeM.count=0;postM.castShadow=true;postM.frustumCulled=tapeM.frustumCulled=false;
  for(let i=15;i<pts.length-20;i+=30){
    const a=pts[i-1],b=pts[i+1];let tx=b.x-a.x,tz=b.z-a.z;const l=Math.hypot(tx,tz)||1;tx/=l;tz/=l;const s=(i/30)%2?1:-1;
    const x=pts[i].x-tz*2.3*s,z=pts[i].z+tx*2.3*s,y=heightAt(x,z);
    dummy.position.set(x,y,z);dummy.rotation.set(0,rnd()*3,0);dummy.scale.set(1,1,1);dummy.updateMatrix();postM.setMatrixAt(postM.count++,dummy.matrix);
    addSolid(x,z,.2);
    dummy.position.set(x,y+1.1,z);dummy.updateMatrix();tapeM.setMatrixAt(tapeM.count++,dummy.matrix);
  }
  scene.add(postM,tapeM);

  // signs
  const woodM=new THREE.MeshStandardMaterial({color:C('#5b3f26'),roughness:.9});
  function sign(x,z,faceX,faceZ,lines,w=1.5,hgt=.75,postH=1.3){
    const g=new THREE.Group();const y=heightAt(x,z);g.position.set(x,y,z);
    const post=new THREE.Mesh(new THREE.BoxGeometry(.14,postH+hgt,.14),woodM);post.position.y=(postH+hgt)/2;post.castShadow=true;g.add(post);
    const tex=signTex(lines);const fm=new THREE.MeshStandardMaterial({map:tex,roughness:.85});
    const board=new THREE.Mesh(new THREE.BoxGeometry(w,hgt,.07),[woodM,woodM,woodM,woodM,fm,fm]);board.position.y=postH+hgt/2;board.castShadow=true;g.add(board);
    g.lookAt(faceX,y,faceZ);scene.add(g);
    addSolid(x,z,Math.max(.32,Math.min(w*.38,1.05)));
    const title=(lines[0]&&lines[0].t)||'標識';
    const text=lines.slice(1).map(l=>l.t).filter(Boolean).join('　')||title;
    addLook(x,z,Math.max(2.8,w+1.4),title,text);
    return g;
  }
  const kan=['','一','二','三','四','五','六','七','八','九'];
  const h0=pts[0].h,gain=(PEAK-h0)/10;
  for(let k=1;k<=9;k++){
    const i=pts.findIndex(p=>p.h>=h0+k*gain);if(i<2)continue;
    const a=pts[i-1],b=pts[i+1];let tx=b.x-a.x,tz=b.z-a.z;const l=Math.hypot(tx,tz)||1;tx/=l;tz/=l;
    const x=pts[i].x+tz*2.8,z=pts[i].z-tx*2.8;
    LM.evs.push({d:pts[i].dist,msg:kan[k]+'合目 標高'+Math.round(realAlt(pts[i].h)).toLocaleString()+'m'});
    sign(x,z,pts[i].x,pts[i].z,[{t:kan[k]+'合目',s:92},{t:'標高 '+Math.round(realAlt(pts[i].h)).toLocaleString()+'m',s:40,b:700},{t:'山頂まで '+((pathLen-pts[i].dist)/1000).toFixed(1)+'km',s:36,b:700}],1.3,.7);
  }
  {const p=pts[0],q=pts[4];let tx=q.x-p.x,tz=q.z-p.z;const l=Math.hypot(tx,tz);tx/=l;tz/=l;
    sign(p.x-tz*4+tx*2,p.z+tx*4+tz*2,p.x-tx*6,p.z-tz*6,[{t:'白嶺岳 登山口',s:78},{t:'標高 '+Math.round(realAlt(p.h)).toLocaleString()+'m',s:42,b:700},{t:'山頂まで '+(pathLen/1000).toFixed(1)+'km',s:40,b:700}],2.2,1.05,1.2);
    // 登山ポスト
    const bx=p.x+tz*3.5+tx*1,bz=p.z-tx*3.5+tz*1,by=heightAt(bx,bz);
    const post=new THREE.Mesh(new THREE.BoxGeometry(.55,.7,.4),new THREE.MeshStandardMaterial({color:C('#b8322a'),roughness:.5}));post.position.set(bx,by+1.05,bz);post.castShadow=true;scene.add(post);
    const leg=new THREE.Mesh(new THREE.BoxGeometry(.12,.8,.12),new THREE.MeshStandardMaterial({color:C('#555'),roughness:.6}));leg.position.set(bx,by+.4,bz);scene.add(leg);
    post.lookAt(p.x,by+1.05,p.z);
    addSolid(bx,bz,.45);
    addLook(bx,bz,2.6,'登山ポスト','登山口の赤いポスト。ここから山頂までは長い。');
  }

  // huts
  hutWindowMat=new THREE.MeshStandardMaterial({color:C('#3a2c1c'),emissive:C('#ffc980'),emissiveIntensity:.3});
  const stoneM=new THREE.MeshStandardMaterial({color:C('#6e6a62'),roughness:.95,map:noiseTex(64,200,110)});
  const wallM=new THREE.MeshStandardMaterial({color:C('#6a4a2d'),roughness:.9,side:THREE.DoubleSide});
  const roofM=new THREE.MeshStandardMaterial({color:C('#8c2f24'),roughness:.55,metalness:.3});
  const doorM=new THREE.MeshStandardMaterial({color:C('#2e2016'),roughness:.8});
  const sTex=smokeTex();
  for(const h of huts){
    const g=new THREE.Group();g.position.set(h.x,h.h,h.z);
    const add=(geo,mat,x,y,z,rx=0)=>{const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.rotation.x=rx;m.castShadow=true;m.receiveShadow=true;g.add(m);return m};
    add(new THREE.BoxGeometry(13,5,9),stoneM,0,-2.1,0);
    add(new THREE.BoxGeometry(12,3.8,8),wallM,0,2.3,0);
    const ang=.52,span=4.7,L=span/Math.cos(ang);
    add(new THREE.BoxGeometry(13.6,.3,L),roofM,0,4.2+Math.tan(ang)*span/2,span/2,ang);
    add(new THREE.BoxGeometry(13.6,.3,L),roofM,0,4.2+Math.tan(ang)*span/2,-span/2,-ang);
    const tri=new THREE.Shape();tri.moveTo(-4,0);tri.lineTo(4,0);tri.lineTo(0,Math.tan(ang)*4);tri.lineTo(-4,0);
    const tg2=new THREE.ShapeGeometry(tri);
    for(const sx of [-6,6]){const m=new THREE.Mesh(tg2,wallM);m.position.set(sx,4.2,0);m.rotation.y=Math.PI/2*(sx>0?1:-1);g.add(m)}
    add(new THREE.BoxGeometry(1.5,2.4,.2),doorM,-3,1.6,4.02);
    for(const wx of [-.2,2.6,5]){add(new THREE.PlaneGeometry(1.4,1),hutWindowMat,wx,2.6,4.02)}
    for(const wx of [-4.5,-1.5,1.5,4.5]){const m=add(new THREE.PlaneGeometry(1.4,1),hutWindowMat,wx,2.6,-4.02);m.rotation.y=Math.PI}
    add(new THREE.BoxGeometry(.9,2.2,.9),stoneM,3.5,6.6,-1.5);
    // board over door
    const bt=signTex([{t:h.name,s:96}],512,160,'#3b2615');
    const board=add(new THREE.PlaneGeometry(4.2,1.3),new THREE.MeshStandardMaterial({map:bt,roughness:.85}),1.2,4.1,4.25);board.castShadow=false;
    // bench
    add(new THREE.BoxGeometry(3,.12,.6),wallM,3.4,.55,5.2);add(new THREE.BoxGeometry(.12,.5,.5),wallM,2.1,.25,5.2);add(new THREE.BoxGeometry(.12,.5,.5),wallM,4.7,.25,5.2);
    g.lookAt(h.px,h.h,h.pz);scene.add(g);
    addSolid(h.x,h.z,6.2);
    const lt=new THREE.PointLight(0xffb870,0,34,1.6);lt.position.set(0,2.5,6);g.add(lt);hutLights.push(lt);
    const chim=new THREE.Vector3(3.5,7.8,-1.5);g.localToWorld(chim);
    for(let k=0;k<9;k++){const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:sTex,transparent:true,depthWrite:false,opacity:0}));sp.userData={o:chim.clone(),t:k/9};scene.add(sp);smokes.push(sp)}
    // sign at path
    const a=pts[h.idx-2],b=pts[h.idx+2];let tx=b.x-a.x,tz=b.z-a.z;const l=Math.hypot(tx,tz);tx/=l;tz/=l;
    const dx=h.x-h.px,dz=h.z-h.pz,dl=Math.hypot(dx,dz);
    sign(h.px+dx/dl*3.4+tx*4,h.pz+dz/dl*3.4+tz*4,h.px,h.pz,[{t:h.name,s:84},{t:'標高 '+Math.round(realAlt(h.h)).toLocaleString()+'m',s:42,b:700},{t:'休憩・給水できます',s:36,b:700}],1.6,.8);
  }

  // ---- landmarks ----
  {
  const stoneG=new THREE.MeshStandardMaterial({color:C('#8a877f'),roughness:.95,map:noiseTex(64,200,110)});
  const mossM=new THREE.MeshStandardMaterial({color:C('#5d6b45'),roughness:1,map:noiseTex(64,200,120)});
  const logM=new THREE.MeshStandardMaterial({color:C('#6b5037'),roughness:.9});
  const rockGeo=new THREE.DodecahedronGeometry(1,0);
  const add=(geo,mat,x,y,z,opt={})=>{const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);if(opt.s)m.scale.set(...opt.s);if(opt.r)m.rotation.set(...opt.r);m.castShadow=opt.cast!==false;m.receiveShadow=true;scene.add(m);return m};
  const boulder=(x,z,s,mat)=>{addSolid(x,z,Math.max(.25,s*.62));return add(rockGeo,mat||stoneG,x,heightAt(x,z)+s*.35,z,{s:[s,s*(.6+Math.random()*.3),s*(.8+Math.random()*.4)],r:[Math.random(),Math.random()*6,0]})};
  const FLAVOR={
    stream:['丸太橋','沢を渡る丸太。足もとを見て渡ろう。',3.6],
    jizo:['お地蔵さん','苔むしたお地蔵さんが、登る人を見守っている。',3.2],
    log:['倒木','太い倒木が横たわっている。端を回って進もう。',4.4],
    spring:['水場','冷たい湧き水。そばに寄ると汲める。',3.6],
    steps:['木の階段','急登に組まれた木の階段。一段ずつ登ろう。',3.2],
    bench:['ベンチ','腰を下ろせる木のベンチ。',3.0],
    boulder:['天狗岩','見上げるほどの巨岩。風が割れ目を抜けていく。',8],
    birches:['ダケカンバ','黄葉が始まり、白い幹が霧に浮かんでいる。',5],
    chain:['鎖場','鎖をつかんで、足元を確かめて進もう。',4.2],
    cairn:['ケルン','先を歩いた人が積んだ石。道標だ。',2.8]
  };
  flowTex=noiseTex(128,190,120);flowTex.repeat.set(1,3);
  for(const p of plan){
    const i=p.i,f=frame(i),y=heightAt(p.x,p.z);
    if(p.kind==='board'){
      sign(p.x,p.z,f.p.x,f.p.z,[{t:'白嶺岳 登山案内',s:70},{t:'登山口 → 樺平小屋 → 白嶺小屋 → 山頂',s:28,b:700},{t:'全長 '+(pathLen/1000).toFixed(1)+'km  クマ・落石に注意',s:28,b:700}],2.4,1.2,1.1);
    }else if(p.kind==='stream'){
      const n=40,wp=[],wi=[],wu=[];
      // 水面も丸太も「生の地形」ではなく「登山道の面(walkY)」を基準にする。
      // 道は平滑化した pts[i].h+0.12 で地形より最大1.7m浮いており、heightAt基準だと
      // 水が道を突き抜けて道が途切れ、丸太が道に埋まって見えなくなっていた（2026-09-26修正）
      for(let k=0;k<=n;k++){const o=(k-n/2)*2.2,cx=f.p.x+f.nx*o+Math.sin(k*.7)*1.2*f.tx,cz=f.p.z+f.nz*o+Math.sin(k*.7)*1.2*f.tz;
        const t=smooth(1.2,4,Math.abs(o));            // 0=道の上 / 1=道から離れた場所
        const yAt=(x,z)=>walkY(x,z)+(t*.14-(1-t)*.34); // 道の下を34cmくぐり、道の外では地形+16cm
        const w=2.3;                                   // 沢幅4.6m。道幅2.5mより広いので前後に水が見える
        const ax=cx+f.tx*w,az=cz+f.tz*w,bx=cx-f.tx*w,bz=cz-f.tz*w;
        wp.push(ax,yAt(ax,az),az,bx,yAt(bx,bz),bz);wu.push(0,k*.6,1,k*.6);
        if(k<n)wi.push(k*2,k*2+1,k*2+2,k*2+1,k*2+3,k*2+2);
        if(k%3===0&&Math.abs(o)>3){boulder(cx+f.tx*(1.6+Math.random()),cz+f.tz*(1.6+Math.random()),.4+Math.random()*.6,mossM);boulder(cx-f.tx*(1.6+Math.random()),cz-f.tz*(1.6+Math.random()),.4+Math.random()*.5)}}
      const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(wp,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(wu,2));g.setIndex(wi);g.computeVertexNormals();
      const wm=new THREE.MeshStandardMaterial({color:C('#6f98a6'),roughness:.08,metalness:.2,map:flowTex,transparent:true,opacity:.88,side:THREE.DoubleSide});
      const wmesh=new THREE.Mesh(g,wm);wmesh.receiveShadow=true;scene.add(wmesh);
      const bY=walkY(f.p.x,f.p.z);  // 登山道の面。丸太はこの上に載せる
      for(const d of [-.62,.62]){add(new THREE.CylinderGeometry(.3,.34,6.2,9),logM,f.p.x+f.nx*d,bY+.24,f.p.z+f.nz*d,{r:[Math.PI/2,Math.atan2(f.tx,f.tz),0]}).rotation.order='YXZ';
        treads.push({x:f.p.x+f.nx*d,z:f.p.z+f.nz*d,tx:f.tx,tz:f.tz,nx:f.nx,nz:f.nz,along:3.1,across:.36,top:bY+.5});}
      LM.stream={x:f.p.x,z:f.p.z};
    }else if(p.kind==='jizo'){
      add(new THREE.BoxGeometry(.9,.25,.7),stoneG,p.x,y+.1,p.z);
      for(const [dx,sc] of [[-.18,1],[.25,.75]]){const gx=p.x+f.tx*dx,gz=p.z+f.tz*dx,b=y+.22;
        add(new THREE.CylinderGeometry(.15*sc,.2*sc,.5*sc,10),stoneG,gx,b+.25*sc,gz);
        add(new THREE.SphereGeometry(.14*sc,12,10),stoneG,gx,b+.62*sc,gz);
        const bib=add(new THREE.ConeGeometry(.19*sc,.24*sc,10,1,true),new THREE.MeshStandardMaterial({color:C('#c0392b'),roughness:.8,side:THREE.DoubleSide}),gx,b+.36*sc,gz);bib.rotation.x=Math.PI;}
      for(let k=0;k<5;k++)boulder(p.x+(Math.random()-.5)*1.4,p.z+(Math.random()-.5)*1.4,.12,stoneG);
      addSolid(p.x,p.z,.55);
    }else if(p.kind==='serow'){
      LM.animals.push(makeAnimal('serow',p.x,p.z,f,'カモシカが斜面を駆け上がっていった'));
    }else if(p.kind==='raicho'){
      LM.animals.push(makeAnimal('raicho',p.x,p.z,f,'ライチョウだ！ハイマツの陰に隠れた'));
    }else if(p.kind==='log'){
      const l=add(new THREE.CylinderGeometry(.35,.45,11,9),logM,p.x,y+.4,p.z,{r:[0,Math.atan2(f.tx,f.tz)+.4,Math.PI/2]});
      const yaw=Math.atan2(f.tx,f.tz)+.4;
      for(const t of [-4,0,4])addSolid(p.x+Math.cos(yaw)*t,p.z+Math.sin(yaw)*t,.75);
      for(let k=0;k<4;k++)boulder(p.x+f.nx*(1.5+k*1.2)+f.tx*(Math.random()*4-2),p.z+f.nz*(1.5+k*1.2)+f.tz*(Math.random()*4-2),.6+Math.random()*.9,mossM);
    }else if(p.kind==='spring'){
      add(new THREE.BoxGeometry(1.4,.45,.6),logM,p.x,y+.22,p.z,{r:[0,Math.atan2(f.nx,f.nz),0]});
      const water=add(new THREE.BoxGeometry(1.25,.05,.45),new THREE.MeshStandardMaterial({color:C('#7fb3c8'),roughness:.05,metalness:.2}),p.x,y+.42,p.z,{r:[0,Math.atan2(f.nx,f.nz),0]});
      const pipe=add(new THREE.CylinderGeometry(.04,.04,1.2,6),new THREE.MeshStandardMaterial({color:C('#6c7a70'),metalness:.5,roughness:.4}),p.x-f.nx*.6,y+.75,p.z-f.nz*.6,{r:[Math.PI/2.4,Math.atan2(f.nx,f.nz),0]});
      boulder(p.x-f.nx*1.4,p.z-f.nz*1.4,1.3,mossM);
      sign(p.x+f.tx*1.6,p.z+f.tz*1.6,f.p.x,f.p.z,[{t:'水場',s:110},{t:'冷たい湧き水',s:40,b:700}],.9,.6,.9);
      LM.water={x:p.x,z:p.z,t:-99};
    }else if(p.kind==='steps'){
      const n=70;const geo=new THREE.CylinderGeometry(.11,.11,2.6,7);const im=new THREE.InstancedMesh(geo,logM,n);let c=0;const d=new THREE.Object3D();
      for(let k=0;k<n;k++){const j=i+k;if(j>=pts.length-2)break;if(k%1)continue;const fr=frame(j);d.position.set(fr.p.x,heightAt(fr.p.x,fr.p.z)+.36,fr.p.z);d.rotation.order='YXZ';d.rotation.set(0,Math.atan2(fr.tx,fr.tz),Math.PI/2);d.updateMatrix();im.setMatrixAt(c++,d.matrix);
        treads.push({x:fr.p.x,z:fr.p.z,tx:fr.tx,tz:fr.tz,nx:fr.nx,nz:fr.nz,along:.16,across:1.3,top:heightAt(fr.p.x,fr.p.z)+.56})}
      im.count=c;im.castShadow=true;im.receiveShadow=true;scene.add(im);
    }else if(p.kind==='bench'){
      const ry=Math.atan2(-f.nx,-f.nz);
      const g=new THREE.Group();g.position.set(p.x,y,p.z);g.rotation.y=ry;scene.add(g);
      const m=(geo,x,yy,z)=>{const o=new THREE.Mesh(geo,logM);o.position.set(x,yy,z);o.castShadow=true;g.add(o)};
      m(new THREE.BoxGeometry(2,.1,.45),0,.48,0);m(new THREE.BoxGeometry(.12,.45,.4),-.8,.22,0);m(new THREE.BoxGeometry(.12,.45,.4),.8,.22,0);m(new THREE.BoxGeometry(2,.3,.06),0,.8,.22);
      addSolid(p.x,p.z,1.05);
    }else if(p.kind==='boulder'){
      boulder(p.x,p.z,7,mossM);boulder(p.x+f.tx*6,p.z+f.tz*6,3.2,stoneG);boulder(p.x-f.tx*5+f.nx*3,p.z-f.tz*5+f.nz*3,2.4,mossM);
      const q=side(i,-2.8,3);sign(q.x,q.z,f.p.x,f.p.z,[{t:'天狗岩',s:110}],1.1,.55,1);
    }else if(p.kind==='birches'){
      // handled by vegetation colors; add a grove of yellow birches hugging the trail
      for(let k=0;k<40;k++){const q=side(Math.min(i+k*2,pts.length-3),(3.5+Math.random()*9)*(Math.random()<.5?-1:1));const yy=heightAt(q.x,q.z),Hh=6+Math.random()*4;
        add(new THREE.CylinderGeometry(.14,.18,Hh*.75,6),new THREE.MeshStandardMaterial({color:C('#ddd6c8'),roughness:.8}),q.x,yy+Hh*.37,q.z);
        addSolid(q.x,q.z,.28);
        add(new THREE.IcosahedronGeometry(1,1),new THREE.MeshStandardMaterial({color:C(['#d8b040','#e0a83a','#c98a2e'][k%3]),roughness:.9}),q.x,yy+Hh*.72,q.z,{s:[2,2.6,2]});}
    }else if(p.kind==='treeline'){
      sign(p.x,p.z,f.p.x,f.p.z,[{t:'森林限界',s:96},{t:'ここから岩稜帯',s:42,b:700}],1.3,.7);
    }else if(p.kind==='chain'){
      const chainM=new THREE.MeshStandardMaterial({color:C('#4a4d50'),metalness:.8,roughness:.35});let prev=null;
      for(let k=0;k<=16;k+=2){const fr=frame(Math.min(i+k,pts.length-3)),x=fr.p.x+fr.nx*2.1,z=fr.p.z+fr.nz*2.1,yy=heightAt(x,z);
        add(new THREE.CylinderGeometry(.05,.05,1.1,6),chainM,x,yy+.55,z);boulder(x+fr.nx*.8,z+fr.nz*.8,.9+Math.random());
        const top=new THREE.Vector3(x,yy+1.05,z);
        if(prev){const mid=prev.clone().add(top).multiplyScalar(.5);mid.y-=.15;const len=prev.distanceTo(top);const c=add(new THREE.CylinderGeometry(.018,.018,len,5),chainM,mid.x,mid.y,mid.z,{cast:false});c.lookAt(top);c.rotateX(Math.PI/2)}
        prev=top}
    }else if(p.kind==='almost'){
      sign(p.x,p.z,f.p.x,f.p.z,[{t:'山頂まで',s:70},{t:'あと200m',s:80}],1.2,.8);
    }else if(p.kind==='cairn'){
      for(let k=0;k<5;k++){const sc=.55-k*.08;add(rockGeo,stoneG,p.x+(Math.random()-.5)*.1,y+.2+k*.3,p.z+(Math.random()-.5)*.1,{s:[sc,sc*.6,sc],r:[Math.random(),Math.random()*6,0]})}
      addSolid(p.x,p.z,.55);
    }
    const fl=FLAVOR[p.kind];
    if(fl)addLook(p.x,p.z,fl[2],fl[0],fl[1]);
  }
  const chainM=new THREE.MeshStandardMaterial({color:C('#4a4d50'),metalness:.8,roughness:.35});
  for(const [i0,i1] of chainSpans){
    let prev=null;
    for(let i=i0;i<=i1;i+=2){
      const f=frame(Math.min(i,pts.length-2));
      const up=heightAt(f.p.x+f.nx,f.p.z+f.nz)>=heightAt(f.p.x-f.nx,f.p.z-f.nz)?1:-1;
      const x=f.p.x+f.nx*1.35*up,z=f.p.z+f.nz*1.35*up,yy=heightAt(x,z);
      add(new THREE.CylinderGeometry(.045,.045,1.35,6),chainM,x,yy+.7,z);
      const top=new THREE.Vector3(x,yy+1.25,z);
      if(prev){const mid=prev.clone().add(top).multiplyScalar(.5);mid.y-=.18;const len=Math.max(prev.distanceTo(top),.2);
        const c=add(new THREE.CylinderGeometry(.028,.028,len,5),chainM,mid.x,mid.y,mid.z,{cast:false});c.lookAt(top);c.rotateX(Math.PI/2)}
      prev=top;
      if((i-i0)%6===0)boulder(x+f.nx*up*1.6,z+f.nz*up*1.6,.65+Math.random()*.35,stoneG);
    }
    const p=pts[i0];
    addLook(p.x,p.z,5,'鎖場','岩が立っている。鎖をつかんで、ゆっくり登ろう。');
    LM.evs.push({d:p.dist,msg:'鎖場。走らず、ゆっくり登ろう'});
  }
  }
  // summit
  {
    const y=heightAt(0,0);
    sign(2.5,1.5,0,-8,[{t:'白嶺岳',s:110},{t:'山頂 3,026m',s:52,b:700}],1.8,1.0,1.5);
    const sh=new THREE.Group();sh.position.set(-3,heightAt(-3,-2),-2);
    const st=new THREE.Mesh(new THREE.BoxGeometry(1.4,.9,1),stoneM);st.position.y=.45;st.castShadow=true;sh.add(st);
    const hk=new THREE.Mesh(new THREE.BoxGeometry(.8,.8,.7),wallM);hk.position.y=1.3;hk.castShadow=true;sh.add(hk);
    const rf=new THREE.Mesh(new THREE.ConeGeometry(.75,.55,4),roofM);rf.position.y=1.98;rf.rotation.y=Math.PI/4;rf.castShadow=true;sh.add(rf);
    sh.lookAt(0,sh.position.y,6);scene.add(sh);
    addSolid(-3,-2,.9);
    const tri=new THREE.Mesh(new THREE.BoxGeometry(.18,.5,.18),new THREE.MeshStandardMaterial({color:C('#c9c4b8'),roughness:.7}));tri.position.set(1,heightAt(1,-3)+.25,-3);scene.add(tri);
    for(let k=0;k<7;k++){const s=.9-k*.11;const m=new THREE.Mesh(rockG,stoneM);m.scale.set(s,s*.6,s);m.position.set(3.5+(rnd()-.5)*.2,heightAt(3.5,-3)+.3+k*.42,-3+(rnd()-.5)*.2);m.rotation.set(rnd(),rnd()*6,0);m.castShadow=true;scene.add(m)}
    addSolid(3.5,-3,.85);
  }

  hiker=buildHiker();
  {const pa=plan.find(p=>p.kind==='ojiA');const h2=huts[1];
   if(pa){const f=frame(pa.i);oji={h:buildHiker({jacket:'#b9a57b',pants:'#6d5c46',cap:'#56584a',pack:'#6b4a2e',skin:'#cf9f7c',hat:true,beard:true}),
     A:{x:pa.x,z:pa.z,face:Math.atan2(f.nx,f.nz)},B:h2?{x:(h2.x*2+h2.px)/3,z:(h2.z*2+h2.pz)/3,face:Math.atan2(-(h2.px-h2.x),-(h2.pz-h2.z))}:null};ojiReset()}}
  troops=plan.filter(p=>p.kind==='monkeys').map(p=>{const ms=[];for(let k=0;k<3+(Math.random()*2|0);k++){const a=Math.random()*6.28,r=2+Math.random()*5;const hx=p.x+Math.sin(a)*r,hz=p.z+Math.cos(a)*r;ms.push({g:buildMonkey(),hx,hz})}return{x:p.x,z:p.z,ms}});
  monkeysReset();
  npcs=NPC_DEF.map((d,k)=>{const n=Object.assign({},d,{side:k%2?1:-1,h:buildHiker(d),resting:false,exhausted:false});placeNpc(n);return n});
  // clouds
  const cloudVS=`varying vec3 vW;void main(){vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`;
  const cloudFS=`uniform float uTime,uLight,uBelow,uAlpha,uSeed;uniform vec3 uSunCol,uCam,uShade;varying vec3 vW;
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}
    float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*vn(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return s;}
    void main(){vec2 p=vW.xz*.00055+vec2(uTime*.004+uSeed,uTime*.0016);float n=fbm(p);float d=fbm(p*3.1+n*1.3);
      float dens=smoothstep(.34,.68,n*.75+d*.35);
      float dist=length(vW.xz-uCam.xz);float far=1.-smoothstep(7000.,13500.,dist);
      float a=dens*uAlpha*far;
      if(uBelow>.5)a=mix(.5,.88,dens)*uAlpha*far;
      vec3 lit=mix(vec3(1.),uSunCol,.45);
      vec3 col=mix(uShade,lit,clamp(d*1.2-.1,0.,1.))*uLight;
      if(uBelow>.5)col=uShade*uLight*mix(.85,.6,dens);
      gl_FragColor=vec4(col,a);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }`;
  [[0,.62,0],[24,.5,3.7]].forEach(([dy,al,seed],k)=>{
    const m=new THREE.ShaderMaterial({uniforms:{uTime:{value:0},uLight:{value:1},uBelow:{value:0},uAlpha:{value:al},uSeed:{value:seed},uSunCol:{value:new THREE.Color()},uCam:{value:new THREE.Vector3()},uShade:{value:C('#9aa4ad')}},
      vertexShader:cloudVS,fragmentShader:cloudFS,transparent:true,depthWrite:false,side:THREE.DoubleSide});
    m.userData.base=al;
    const pl=new THREE.Mesh(new THREE.PlaneGeometry(28000,28000,1,1),m);pl.rotation.x=-Math.PI/2;pl.position.y=CLOUD_Y+dy;pl.renderOrder=5+k;pl.frustumCulled=false;scene.add(pl);cloudMats.push(m);cloudPlanes.push(pl);
  });

  // profile precompute
  profileImg=[];for(let k=0;k<=120;k++){const i=Math.round(k/120*(pts.length-1));profileImg.push(pts[i].h)}
}

/* ---------- state ---------- */
const S={},INTRO=4.2;
function resetState(){
  const p=pts[3],q=pts[14];
  Object.assign(S,{x:p.x,z:p.z,yaw:Math.atan2(-(q.x-p.x),-(q.z-p.z)),pitch:-.2,view:(S.view||3),face:Math.atan2(-(q.x-p.x),-(q.z-p.z)),cam:null,stam:100,water:1500,time:5+20/60,startTime:5+20/60,
    exhausted:false,resting:false,rests:0,walked:0,done:false,idx:3,phase:0,camY:heightAt(p.x,p.z)+1.62,realStart:performance.now(),realEnd:0,arrive:0,lastHut:-1,offWarn:0,steepWarn:0,
    intro:INTRO,introMax:INTRO});
  LM.evs.forEach(e=>e.done=false);LM.animals.forEach(a=>{a.fled=false;a.t=0;a.g.visible=true;a.g.position.set(a.x0,heightAt(a.x0,a.z0),a.z0)});toastQ.length=0;S.greets=0;S.food=3;S.eating=0;S.stolen=0;S.advice=0;ojiReset();monkeysReset();npcs.forEach(placeNpc);bubbles.forEach(b=>b.until=0);
  setTurbo(false);
}

/* ---------- input ---------- */
const keys={};let runBtn=false,turbo=false;
function setTurbo(on){
  turbo=!!on;
  const b=$('turboBtn');
  b.classList.toggle('on',turbo);
  b.setAttribute('aria-pressed',turbo?'true':'false');
  b.textContent=turbo?'10倍':'倍速';
}
addEventListener('keydown',e=>{keys[e.code]=true;
  if(mode!=='play')return;
  if(e.code==='KeyR')toggleRest();
  if(e.code==='KeyE')tryHut();
  if(e.code==='KeyQ')examine();
  if(e.code==='KeyV')toggleView();
  if(e.code==='KeyG')greet();
  if(e.code==='KeyF')eat();
  if(e.code==='KeyH')shoo();
  if(e.code==='KeyT')setTurbo(!turbo);
  if(e.code==='Escape'||e.code==='KeyP'){if(!$('pause').hidden)closeSettings();else if(mode==='play')openSettings()}
});
addEventListener('keyup',e=>{keys[e.code]=false});
addEventListener('blur',()=>{for(const k in keys)keys[k]=false;runBtn=false;setTurbo(false)});
const joy={id:null,ox:0,oy:0,x:0,y:0},look={id:null,lx:0,ly:0};
const cv=$('gl');
cv.addEventListener('pointerdown',e=>{
  if(mode!=='play'||paused)return;
  cv.setPointerCapture(e.pointerId);
  if(e.pointerType==='touch'&&e.clientX<innerWidth*.45&&joy.id===null){joy.id=e.pointerId;joy.ox=e.clientX;joy.oy=e.clientY;joy.x=joy.y=0;const j=$('joy');j.style.display='block';j.style.left=e.clientX+'px';j.style.top=e.clientY+'px';j.firstChild.style.transform='';}
  else if(look.id===null){look.id=e.pointerId;look.lx=e.clientX;look.ly=e.clientY}
});
cv.addEventListener('pointermove',e=>{
  if(e.pointerId===joy.id){let dx=e.clientX-joy.ox,dy=e.clientY-joy.oy;const l=Math.hypot(dx,dy),m=55;if(l>m){dx*=m/l;dy*=m/l}joy.x=dx/m;joy.y=dy/m;$('joy').firstChild.style.transform=`translate(${dx}px,${dy}px)`}
  else if(e.pointerId===look.id){const k=(e.pointerType==='touch'?.0052:.0034)*CFG.look;const sy=CFG.invert?-1:1;S.yaw-=(e.clientX-look.lx)*k;S.pitch=clamp(S.pitch-(e.clientY-look.ly)*k*sy,-1.3,1.2);look.lx=e.clientX;look.ly=e.clientY}
});
const endPtr=e=>{if(e.pointerId===joy.id){joy.id=null;joy.x=joy.y=0;$('joy').style.display='none'}if(e.pointerId===look.id)look.id=null};
cv.addEventListener('pointerup',endPtr);cv.addEventListener('pointercancel',endPtr);
const rb=$('runBtn');
rb.addEventListener('pointerdown',e=>{e.preventDefault();try{rb.setPointerCapture(e.pointerId)}catch(_){}runBtn=true;rb.classList.add('on');if(CFG.vib&&navigator.vibrate)navigator.vibrate(12)});
const runEnd=()=>{runBtn=false;rb.classList.remove('on')};
['pointerup','pointercancel','lostpointercapture'].forEach(t=>rb.addEventListener(t,runEnd));
bindPress($('turboBtn'),()=>setTurbo(!turbo));

/* ---------- audio ---------- */
const AU={ctx:null,on:!CFG.mute};
function initAudio(){
  if(AU.ctx){AU.ctx.resume();return}
  try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)();AU.ctx=ctx;
    const len=ctx.sampleRate*2,buf=ctx.createBuffer(1,len,ctx.sampleRate),d=buf.getChannelData(0);let b0=0,b1=0,b2=0;
    for(let i=0;i<len;i++){const w=Math.random()*2-1;b0=.99765*b0+w*.099;b1=.963*b1+w*.2965;b2=.57*b2+w*1.0526;d[i]=(b0+b1+b2+w*.1848)*.2}
    AU.noise=buf;AU.master=ctx.createGain();AU.master.gain.value=.9;AU.master.connect(ctx.destination);
    const loop=(f,q,type)=>{const s=ctx.createBufferSource();s.buffer=buf;s.loop=true;const fl=ctx.createBiquadFilter();fl.type=type;fl.frequency.value=f;fl.Q.value=q;const g=ctx.createGain();g.gain.value=0;s.connect(fl).connect(g).connect(AU.master);s.start();return{g,fl}};
    const w=loop(420,.5,'bandpass');    AU.windG=w.g;AU.windF=w.fl;
    const st=loop(1500,.35,'bandpass');AU.streamG=st.g;
    const b=loop(1100,1.1,'bandpass');AU.breathG=b.g;
    AU.master.gain.value=AU.on?.9:0;
  }catch(e){AU.ctx=null}
}
function footstep(kind){
  const ctx=AU.ctx;if(!ctx||!AU.on)return;const t=ctx.currentTime;
  const s=ctx.createBufferSource();s.buffer=AU.noise;const f=ctx.createBiquadFilter();f.type='lowpass';f.frequency.value=kind==='rock'?2200:kind==='path'?1300:650;
  const g=ctx.createGain();g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(kind==='soft'?.5:.38,t+.012);g.gain.exponentialRampToValueAtTime(.001,t+.17);
  s.connect(f).connect(g).connect(AU.master);s.start(t,Math.random()*1.6,.2);
}
function uiTap(){
  const ctx=AU.ctx;if(!ctx||!AU.on)return;const t=ctx.currentTime,o=ctx.createOscillator(),g=ctx.createGain();
  o.type='triangle';o.frequency.setValueAtTime(740,t);o.frequency.exponentialRampToValueAtTime(420,t+.05);
  g.gain.setValueAtTime(.035,t);g.gain.exponentialRampToValueAtTime(.001,t+.06);
  o.connect(g).connect(AU.master);o.start(t);o.stop(t+.07);
}
function bindPress(el,fn){
  if(!el)return;
  el.addEventListener('pointerdown',e=>{
    if(el.disabled)return;
    e.preventDefault();
    try{el.setPointerCapture(e.pointerId)}catch(_){}
    el.classList.add('is-pressed');
    if(CFG.vib&&navigator.vibrate)navigator.vibrate(15);
    unlockAudio();uiTap();fn(e);
  });
  const up=()=>el.classList.remove('is-pressed');
  el.addEventListener('pointerup',up);
  el.addEventListener('pointercancel',up);
  el.addEventListener('lostpointercapture',up);
}
function unlockAudio(){initAudio();if(AU.ctx&&AU.ctx.state==='suspended')AU.ctx.resume()}
addEventListener('pointerdown',()=>{if(!AU.ctx)initAudio();else if(AU.ctx.state==='suspended')AU.ctx.resume()},{passive:true});
function bird(){
  const ctx=AU.ctx;if(!ctx||!AU.on)return;let t=ctx.currentTime;const base=2600+Math.random()*1400,n=2+(Math.random()*3|0);
  for(let i=0;i<n;i++){const o=ctx.createOscillator(),g=ctx.createGain();o.type='sine';o.frequency.setValueAtTime(base,t);o.frequency.exponentialRampToValueAtTime(base*(1.2+Math.random()*.3),t+.09);
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(.05,t+.02);g.gain.exponentialRampToValueAtTime(.001,t+.12);o.connect(g).connect(AU.master);o.start(t);o.stop(t+.14);t+=.16+Math.random()*.08}
}

/* ---------- UI helpers ---------- */
let toastT=0;
function toast(msg,dur=2600){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('show'),dur)}
const fmtClock=h=>{h=((h%24)+24)%24;const hh=Math.floor(h),mm=Math.floor((h-hh)*60);return hh+':'+String(mm).padStart(2,'0')};
const fmtDur=h=>{const hh=Math.floor(h),mm=Math.round((h-hh)*60);return hh+'時間'+mm+'分'};
function toggleRest(){if(mode!=='play')return;S.resting=!S.resting;$('restBtn').classList.toggle('on',S.resting);$('restBtn').textContent=S.resting?'歩き出す':'小休止';if(S.resting)toast('腰を下ろして呼吸を整える',1800)}
let nearHut=null;
function tryHut(){
  if(!nearHut||busy)return;busy=true;const h=nearHut;
  $('fade').style.opacity=1;
  setTimeout(()=>{S.time+=.75;S.stam=100;S.water=1500;S.food=Math.max(S.food,3);S.exhausted=false;S.rests++;S.resting=false;$('restBtn').classList.remove('on');$('restBtn').textContent='小休止';
    $('fade').style.opacity=0;busy=false;toast(h.name+'で45分休憩。水と行動食を補給して体力が戻った',3200)},900);
}
let busy=false;

/* ---------- environment ---------- */
const SKY=[ // elev, zen, hor, sunCol
  [-14,'#050a14','#0d1624','#000000'],
  [-5,'#16264a','#4a4a66','#3a2230'],
  [1,'#2e4a7a','#e39a6e','#ff8a4a'],
  [9,'#3a68a4','#dcc2a6','#ffc690'],
  [24,'#3a6db2','#b9cee0','#fff1de'],
].map(r=>[r[0],C(r[1]),C(r[2]),C(r[3])]);
const _z=new THREE.Color(),_h=new THREE.Color(),_s=new THREE.Color(),_f=new THREE.Color(),_tmp=new THREE.Color();
const grey=C('#8f9aa1'),white=C('#c9cfd3');
const sunDir=new THREE.Vector3();
let envInfo={e:0,night:0};
function updateEnv(hour,dt){
  const e=62*Math.sin(Math.PI*(hour-5.7)/12.6);
  const az=(90+180*(hour-5.7)/12.6)*Math.PI/180,er=e*Math.PI/180;
  sunDir.set(Math.sin(az)*Math.cos(er),Math.sin(er),-Math.cos(az)*Math.cos(er)).normalize();
  let k=0;while(k<SKY.length-2&&e>SKY[k+1][0])k++;
  const t=clamp((e-SKY[k][0])/(SKY[k+1][0]-SKY[k][0]),0,1);
  _z.copy(SKY[k][1]).lerp(SKY[k+1][1],t);_h.copy(SKY[k][2]).lerp(SKY[k+1][2],t);_s.copy(SKY[k][3]).lerp(SKY[k+1][3],t);
  const night=1-smooth(-8,2,e),day=smooth(-6,14,e);
  skyMat.uniforms.uZen.value.copy(_z);skyMat.uniforms.uHor.value.copy(_h);skyMat.uniforms.uSunCol.value.copy(_s);skyMat.uniforms.uSunDir.value.copy(sunDir);skyMat.uniforms.uNight.value=night;
  scene.getObjectByName('sky').position.copy(camera.position);

  const cy=camera.position.y;
  const below=1-smooth(CLOUD_Y-70,CLOUD_Y-8,cy),inside=1-smooth(10,60,Math.abs(cy-CLOUD_Y-10));
  const lightLv=.12+.88*day;
  _f.copy(_h).lerp(_tmp.copy(grey).multiplyScalar(lightLv),below*.8).lerp(_tmp.copy(white).multiplyScalar(lightLv),inside);
  scene.fog.color.copy(_f);
  scene.fog.density=lerp(lerp(.00011,.0012,below),.012,inside);

  sun.color.copy(_s);sun.intensity=2.6*smooth(-2,10,e)*lerp(1,.28,below);
  sun.position.set(S.x+sunDir.x*500,camera.position.y+Math.max(sunDir.y,.05)*500,S.z+sunDir.z*500);sun.target.position.set(S.x,camera.position.y,S.z);
  hemi.color.copy(_z).lerp(_h,.5).lerp(_tmp.set(1,1,1),.2);hemi.intensity=.12+.55*day+below*.15;
  hemi.groundColor.setRGB(.06,.055,.04).multiplyScalar(.4+day);
  renderer.toneMappingExposure=lerp(1.25,.95,day);
  headlamp.intensity=mode==='play'?2.4*(1-smooth(-1,6,e))*(1+below*.3):0;
  if(hiker)hiker.lamp.material.emissiveIntensity=headlamp.intensity>.1?2.5:0;
  hutWindowMat.emissiveIntensity=.35+night*1.8+below*.5;
  hutLights.forEach(l=>l.intensity=(night*1.4+below*.4));
  for(const m of cloudMats){const u=m.uniforms;u.uTime.value+=dt*(mode==='title'?4:1);u.uLight.value=lightLv;u.uBelow.value=cy<CLOUD_Y?1:0;u.uAlpha.value=m.userData.base*(1-inside*.85);u.uSunCol.value.copy(_s);u.uCam.value.copy(camera.position)}
  envInfo={e,night,below,day};
}

/* ---------- gameplay ---------- */
let mode='loading',paused=false,built=false,T=0,birdT=4,hudT=0,lastToastAt=-9;const toastQ=[],_v=new THREE.Vector3();
function update(dt){
  const alt=realAlt(heightAt(S.x,S.z));
  const o2=Math.exp(-alt/8400);
  // input
  let ix=0,iy=0;
  if(keys.KeyW||keys.ArrowUp)iy+=1;if(keys.KeyS||keys.ArrowDown)iy-=1;if(keys.KeyA||keys.ArrowLeft)ix-=1;if(keys.KeyD||keys.ArrowRight)ix+=1;
  ix+=joy.x;iy-=joy.y;let il=Math.hypot(ix,iy);if(il>1){ix/=il;iy/=il;il=1}
  if(il>.15&&S.intro>.7)S.intro=.7;
  if(il>.15&&S.resting)toggleRest();
  const running=(keys.ShiftLeft||keys.ShiftRight||runBtn)&&!S.exhausted&&il>.3;
  const fx=-Math.sin(S.yaw),fz=-Math.cos(S.yaw),rx=Math.cos(S.yaw),rz=-Math.sin(S.yaw);
  let mx=fx*iy+rx*ix,mz=fz*iy+rz*ix;
  const np=nearPath(S.x,S.z),onPath=np.i>=0&&np.d<3.2;
  let moved=0,grade=0;
  if(il>.05&&!S.resting){
    let sp=S.exhausted?2.6:(running?11.5:7.2);
    const h0=walkY(S.x,S.z),probe=1.2;
    const px=S.x+mx/il*probe,pz=S.z+mz/il*probe;
    const gTest=(walkY(px,pz)-h0)/probe;
    if(!running&&gTest>.32)sp*=clamp(1-(gTest-.32), .55, 1);
    else sp*=clamp(Math.exp(-1.3*Math.abs(gTest+.05))/Math.exp(-.065),.45,1.1);
    let step1=sp*il*dt;
    const hops=turbo?10:1;
    let nx=S.x,nz=S.z;
    // 行動制限は全廃止（2026-09-26）。斜面の傾き・段差・木や岩では止まらない。
    // 地図の外へ落ちるのだけは防ぐが、トーストは出さず無言で押し戻す
    for(let hop=0;hop<hops;hop++){
      let tx=nx+mx/il*step1,tz=nz+mz/il*step1;
      const rr=Math.hypot(tx,tz);
      if(rr>=BOUND){const k=(BOUND-.5)/rr;tx*=k;tz*=k}
      nx=tx;nz=tz;
    }
    moved=Math.hypot(nx-S.x,nz-S.z);
    if(moved>0){grade=(walkY(nx,nz)-h0)/moved}
    S.x=nx;S.z=nz;S.walked+=moved;
    // footsteps
    const before=S.phase;S.phase+=moved*(running?.62:.78);
    if(Math.floor(before/Math.PI)!==Math.floor(S.phase/Math.PI)){const a=realAlt(heightAt(S.x,S.z));footstep(onPath?'path':(a>2780?'rock':'soft'))}
  }
  // stamina
  const speedNow=moved/Math.max(dt,1e-4);
  if(moved>0){
    const up=Math.max(grade,0);
    const pace=speedNow/(turbo?10:1);
    let drain=up*(running?5.5:1.25)*(pace/7.2)+(running?1.6:0);
    drain*=1/o2*(S.water<=0?1.35:1);
    const regen=(up<.08&&!running)?1.4*o2*o2:0;
    S.stam+=(regen-drain)*dt;
  }else{
    S.stam+=(S.resting?16:7)*o2*o2*(S.water<=0?.5:1)*dt;
  }
  const maxSt=S.water<=0?60:100;
  S.stam=clamp(S.stam,0,maxSt);
  if(S.stam<=0&&!S.exhausted){S.exhausted=true;toast('息が上がった。ゆっくり歩くか小休止しよう',3000)}
  if(S.exhausted&&S.stam>28)S.exhausted=false;
  // water
  const exertion=moved>0?(1+Math.max(grade,0)*3+(running?1.5:0)):.3;
  const heat=clamp((currentTemp(alt)-5)/15,0,1);
  S.water=Math.max(0,S.water-(.55+exertion*.7)*(1+heat*.5)*dt);
  if(S.water<=0&&!S.warnedWater){S.warnedWater=true;toast('水が尽きた。次の小屋で補給しよう',3200)}
  if(S.water>0)S.warnedWater=false;
  // time
  S.time+=dt*15/3600*(S.resting?4:1);
  // hiker + camera
  if(moved>0){const tf=Math.atan2(-mx,-mz);let d=((tf-S.face+Math.PI*3)%(Math.PI*2))-Math.PI;S.face+=d*Math.min(1,dt*9)}
  const feet=walkY(S.x,S.z);
  hiker.root.position.set(S.x,feet,S.z);hiker.root.rotation.y=S.face;
  if(S.intro>0)S.intro=Math.max(0,S.intro-dt);
  const intro=S.intro>0?smooth(0,1,S.intro/S.introMax):0;
  let hutFrame=null;if(!intro)for(const h of huts)if(Math.hypot(S.x-h.x,S.z-h.z)<26)hutFrame=h;
  hiker.root.visible=S.view===3||!!hutFrame||intro>0;
  animHiker(hiker,S,dt,moved,running,grade);
  updateNpcs(dt);updateOji(dt);updateMonkeys(dt);
  if(S.eating>0){S.eating-=dt;S.stam=Math.min(S.water<=0?60:100,S.stam+17*dt)}
  const eye=S.resting?1.05:1.62;
  const bob=moved>0?Math.sin(S.phase*2)*.05*(running?1.6:1):0;
  const breath=Math.sin(T*(S.exhausted?5:2))*(S.exhausted?.03:.008);
  const target=feet+eye+bob+breath;
  S.camY+=(target-S.camY)*Math.min(1,dt*14);
  camera.position.set(S.x,S.camY,S.z);
  if(hutFrame){
    let dx=S.x-hutFrame.x,dz=S.z-hutFrame.z;const dl=Math.hypot(dx,dz)||1;dx/=dl;dz/=dl;
    const cx=hutFrame.x+dx*22,cz=hutFrame.z+dz*22,cy=Math.max(hutFrame.h+9,walkY(hutFrame.x+dx*22,hutFrame.z+dz*22)+1.4);
    if(!S.cam)S.cam=new THREE.Vector3(cx,cy,cz);else S.cam.lerp(_v.set(cx,cy,cz),Math.min(1,dt*4));
    camera.position.copy(S.cam);camera.lookAt(hutFrame.x,hutFrame.h+3.1,hutFrame.z);
  }else if(S.view===3||intro>0){
    const pp=clamp(S.pitch,-1.05,.42),dist=(S.resting?3.6:(running?4.9:4.3))+intro*13;
    const sw=S.yaw+intro*.34,bx=Math.sin(sw),bz=Math.cos(sw),ty=feet+(S.resting?1.05:1.5);
    let cx=S.x+bx*dist*Math.cos(pp),cz=S.z+bz*dist*Math.cos(pp),cy=ty-dist*Math.sin(pp)+.3+intro*6.5;
    cy=Math.max(cy,walkY(cx,cz)+.45,walkY((cx+S.x)/2,(cz+S.z)/2)+.6);
    if(!S.cam)S.cam=new THREE.Vector3(cx,cy,cz);else S.cam.lerp(_v.set(cx,cy,cz),Math.min(1,dt*9));
    camera.position.copy(S.cam);camera.lookAt(S.x,ty+.2,S.z);
  }else camera.rotation.set(S.pitch+(S.exhausted?Math.sin(T*2.6)*.012:0),S.yaw,moved>0?Math.sin(S.phase)*.006:0);
  // headlamp follows the head, pointing where the hiker faces
  {const fx2=S.view===3?-Math.sin(S.face):-Math.sin(S.yaw),fz2=S.view===3?-Math.cos(S.face):-Math.cos(S.yaw);
   headlamp.position.set(S.x+fx2*.2,feet+(S.resting?1.2:1.8),S.z+fz2*.2);headlamp.target.position.set(S.x+fx2*7,feet+(S.view===3?.2:.9)+Math.min(0,S.view===3?0:S.pitch*5),S.z+fz2*7);}
  // events along the trail
  {const cd=pts[S.idx].dist;for(const ev of LM.evs)if(!ev.done&&cd>=ev.d-8&&cd<ev.d+80&&np.d<30){ev.done=true;toastQ.push(ev.msg)}}
  for(const a of LM.animals){
    const d=Math.hypot(S.x-a.g.position.x,S.z-a.g.position.z);
    if(!a.fled&&d<(a.kind==='raicho'?11:26)){a.fled=true;toastQ.push(a.msg)}
    if(a.fled&&a.g.visible){a.t+=dt;const sp2=a.kind==='raicho'?2.2:7;const x=a.g.position.x+a.dx*sp2*dt,z=a.g.position.z+a.dz*sp2*dt;a.g.position.set(x,heightAt(x,z)+(a.kind==='raicho'?Math.abs(Math.sin(a.t*9))*.12:Math.abs(Math.sin(a.t*8))*.25),z);a.g.rotation.y=Math.atan2(-a.dx,-a.dz);if(a.t>3.2)a.g.visible=false}
    else if(!a.fled){a.g.children[a.kind==='raicho'?2:2].position.y+=Math.sin(T*2+a.x0)*.0006}
  }
  if(LM.water&&Math.hypot(S.x-LM.water.x,S.z-LM.water.z)<6&&T-LM.water.t>40){LM.water.t=T;S.water=1500;toastQ.push('水場で冷たい水を汲んだ。水が満タンに')}
  if(toastQ.length&&T-lastToastAt>2.8){lastToastAt=T;toast(toastQ.shift(),2600)}
  // path index & warnings
  if(np.i>=0)S.idx=np.i;
  if((np.i<0||np.d>45)&&T-S.offWarn>8){S.offWarn=T;toast('登山道から外れている。赤いテープの道標をたどろう',3000)}
  // hut
  nearHut=null;for(const h of huts)if(Math.hypot(S.x-h.x,S.z-h.z)<22)nearHut=h;
  const hb=$('hutBtn');if(nearHut){hb.textContent=nearHut.name+'で休む';hb.classList.add('show')}else hb.classList.remove('show');
  updateLook();
  // summit
  if(!S.done&&Math.hypot(S.x,S.z)<14){S.done=true;S.arrive=S.time;S.realEnd=performance.now();setTimeout(showClear,1200);toast('山頂に着いた',2400)}
  // audio
  if(AU.ctx){
    const t=AU.ctx.currentTime,h=heightAt(S.x,S.z)/PEAK;
    const wind=2+13*h+2.5*Math.sin(T*.31)+1.8*Math.sin(T*1.13+1)*h;
    S.wind=Math.max(0,wind*(1-envInfo.below*.55));
    if(AU.streamG&&LM.stream){const ds=Math.hypot(S.x-LM.stream.x,S.z-LM.stream.z);AU.streamG.gain.setTargetAtTime(AU.on?.32*(1-smooth(6,110,ds)):0,t,.3)}
    AU.windG.gain.setTargetAtTime(AU.on?(.015+S.wind*.011):0,t,.4);AU.windF.frequency.setTargetAtTime(260+S.wind*28,t,.5);
    const bl=AU.on?clamp((1-S.stam/40),0,1)*.5+(running?.12:0):0;
    const br=Math.pow(Math.max(0,Math.sin(T*(S.exhausted?5.5:3.2))),2);
    AU.breathG.gain.setTargetAtTime(bl*br,t,.05);
    birdT-=dt;if(birdT<0){birdT=3+Math.random()*7;if(realAlt(heightAt(S.x,S.z))<2350&&envInfo.e>-2)bird()}
  }
  // vignette
  $('vig').style.opacity=clamp((1-S.stam/35),0,1)*(.75+Math.sin(T*(S.exhausted?5:3))*.15)+(envInfo.night>.6?.2:0);
}
function currentTemp(alt){return 17-6.5*(alt-BASE_ALT)/1000-3.6*Math.cos((S.time-4)/24*Math.PI*2)}

/* ---------- HUD ---------- */
const cmp=$('compass').getContext('2d'),prf=$('prof').getContext('2d');
const DIRS=['北','北東','東','南東','南','南西','西','北西'];
function drawCompass(){
  const W=520,Hh=72;cmp.clearRect(0,0,W,Hh);
  cmp.fillStyle='rgba(16,24,31,.5)';cmp.beginPath();cmp.roundRect?cmp.roundRect(0,6,W,Hh-12,18):cmp.rect(0,6,W,Hh-12);cmp.fill();
  const head=((-S.yaw*180/Math.PI)%360+360)%360,ppd=W/120;
  cmp.save();cmp.beginPath();cmp.rect(8,6,W-16,Hh-12);cmp.clip();
  cmp.textAlign='center';cmp.textBaseline='middle';
  for(let d=Math.floor((head-65)/5)*5;d<=head+65;d+=5){
    const x=W/2+(d-head)*ppd,dd=((d%360)+360)%360;
    if(dd%45===0){cmp.fillStyle=dd===0?'#e6b44a':'#eef1ec';cmp.font='700 22px "Zen Kaku Gothic New",sans-serif';cmp.fillText(DIRS[dd/45],x,36)}
    else{cmp.fillStyle='rgba(238,241,236,.45)';cmp.fillRect(x-1,dd%15===0?22:26,2,dd%15===0?10:6)}
  }
  const mark=(tx,tz,col,label)=>{let b=Math.atan2(tx-S.x,-(tz-S.z))*180/Math.PI;let rel=((b-head+540)%360)-180;const cl=clamp(rel,-58,58);const x=W/2+cl*ppd;
    cmp.fillStyle=col;cmp.beginPath();cmp.moveTo(x,54);cmp.lineTo(x-8,64);cmp.lineTo(x+8,64);cmp.closePath();cmp.fill();
    if(Math.abs(rel)<58){cmp.font='700 15px "Zen Kaku Gothic New",sans-serif';cmp.fillText(label,x,16)}};
  const nh=huts.find(h=>h.idx>S.idx+5);
  if(nh)mark(nh.x,nh.z,'#e6b44a',nh.name);
  mark(0,0,'#d23b2e','山頂');
  cmp.restore();
  cmp.fillStyle='#eef1ec';cmp.fillRect(W/2-1.5,8,3,8);
}
function drawProfile(){
  const W=336,Hh=92;prf.clearRect(0,0,W,Hh);
  const n=profileImg.length,minH=profileImg[0]-20,rng=PEAK-minH+10;
  const X=i=>i/(n-1)*W,Y=h=>Hh-6-(h-minH)/rng*(Hh-14);
  prf.beginPath();prf.moveTo(0,Hh);profileImg.forEach((h,i)=>prf.lineTo(X(i),Y(h)));prf.lineTo(W,Hh);prf.closePath();
  const g=prf.createLinearGradient(0,0,0,Hh);g.addColorStop(0,'rgba(238,241,236,.5)');g.addColorStop(1,'rgba(238,241,236,.06)');prf.fillStyle=g;prf.fill();
  prf.strokeStyle='rgba(238,241,236,.7)';prf.lineWidth=2;prf.beginPath();profileImg.forEach((h,i)=>i?prf.lineTo(X(i),Y(h)):prf.moveTo(X(i),Y(h)));prf.stroke();
  prf.fillStyle='#e6b44a';for(const h of huts){const i=h.idx/(pts.length-1)*(n-1);prf.fillRect(X(i)-5,Y(h.h)-14,10,8)}
  const pi=S.idx/(pts.length-1)*(n-1);const ph=pts[S.idx].h;
  prf.fillStyle='#d23b2e';prf.beginPath();prf.arc(X(pi),Y(ph),7,0,7);prf.fill();prf.strokeStyle='#fff';prf.lineWidth=2;prf.stroke();
}
function updateHUD(){
  $('foodV').textContent='◆'.repeat(Math.max(0,S.food||0));$('foodN').textContent=(S.food||0)+'個';
  const alt=realAlt(heightAt(S.x,S.z));
  $('altV').textContent=Math.round(alt).toLocaleString();
  $('clockV').textContent=fmtClock(S.time);
  $('tempV').textContent=Math.round(currentTemp(alt))+'℃';
  $('windV').textContent=Math.round(S.wind||0)+'m/s';
  $('o2V').textContent=Math.round(Math.exp(-alt/8400)/Math.exp(-0)*100)+'%';
  const sb=$('stamB');sb.style.width=S.stam+'%';sb.style.background=S.stam<25?'#d23b2e':S.stam<50?'#e6b44a':'#6f9a63';$('stamV').textContent=Math.round(S.stam);
  $('waterB').style.width=(S.water/15)+'%';$('waterB').style.background='#7fb3d5';$('waterV').textContent=(S.water/1000).toFixed(1)+'L';
  const d=pts[S.idx].dist,nh=huts.find(h=>h.idx>S.idx+5);
  $('nextV').textContent=S.done?'山頂にいます':nh?`${nh.name}まで ${((pts[nh.idx].dist-d)/1000).toFixed(1)}km`:`山頂まで ${((pathLen-d)/1000).toFixed(1)}km`;
  drawProfile();
}

/* ---------- screens ---------- */
function showClear(){
  const real=(S.realEnd-S.realStart)/1000,mm=Math.floor(real/60),ss=Math.round(real%60);
  let best=null;try{best=JSON.parse((localStorage.getItem('tg.261.best')||localStorage.getItem('hakurei-best'))||'null')}catch(e){}
  const isBest=!best||real<best;
  try{if(isBest)localStorage.setItem('tg.261.best',JSON.stringify(real))}catch(e){}
  $('stats').innerHTML=`<dt>山頂到着</dt><dd>${fmtClock(S.arrive)}</dd><dt>行動時間</dt><dd>${fmtDur(S.arrive-S.startTime)}</dd><dt>歩いた距離</dt><dd>${(S.walked/1000).toFixed(2)}km</dd><dt>小屋での休憩</dt><dd>${S.rests}回</dd><dt>挨拶した人</dt><dd>${S.greets}人</dd><dt>聞いたアドバイス</dt><dd>${S.advice}個</dd><dt>サルに取られた</dt><dd>${S.stolen}個</dd><dt>プレイ時間</dt><dd>${mm}分${String(ss).padStart(2,'0')}秒</dd>`;
  $('bestV').textContent=isBest?'自己ベスト更新':(best?`自己ベスト ${Math.floor(best/60)}分${String(Math.round(best%60)).padStart(2,'0')}秒`:'');
  $('clear').hidden=false;mode='clear';document.body.classList.remove('playing');
}
function openSettings(){
  const playing=mode==='play';
  if(playing){paused=true;document.body.classList.remove('playing')}
  $('pauseTitle').textContent=playing?'一時停止':'操作設定';
  $('resumeBtn').textContent=playing?'登山を再開する':'閉じる';
  $('restartBtn').hidden=!playing;
  $('lookBtn').classList.remove('show');
  syncCfgUI();
  $('pause').hidden=false;
}
function closeSettings(){
  $('pause').hidden=true;
  if(mode==='play'){paused=false;document.body.classList.add('playing')}
}
function syncCfgUI(){
  $('invertBtn').textContent='上下反転 '+(CFG.invert?'オン':'オフ');
  $('vibBtn').textContent='振動 '+(CFG.vib?'オン':'オフ');
  $('soundBtn').textContent='音 '+(AU.on?'オン':'オフ');
  const m=$('muteBtn');m.textContent=AU.on?'音':'消';m.setAttribute('aria-label',AU.on?'音を消す':'音を出す');
  document.querySelectorAll('#lookSeg button').forEach(b=>b.classList.toggle('on',Math.abs(parseFloat(b.dataset.look)-CFG.look)<.05));
}
function setMute(on){AU.on=!!on;CFG.mute=!AU.on;saveCfg();if(AU.master)AU.master.gain.value=AU.on?.9:0;syncCfgUI()}
bindPress($('pauseBtn'),()=>{if(mode==='play')openSettings()});
bindPress($('cfgBtn'),openSettings);
function toggleView(){if(mode!=='play')return;S.view=S.view===3?1:3;S.cam=null;S.pitch=S.view===3?-.2:-.05;toast(S.view===3?'後ろから見る視点':'登山者の目線',1400)}
bindPress($('camBtn'),toggleView);
bindPress($('greetBtn'),greet);
bindPress($('shooBtn'),shoo);
bindPress($('eatBtn'),eat);
bindPress($('restBtn'),toggleRest);
bindPress($('hutBtn'),tryHut);
bindPress($('lookBtn'),examine);
bindPress($('resumeBtn'),closeSettings);
bindPress($('soundBtn'),()=>setMute(!AU.on));
bindPress($('muteBtn'),()=>setMute(!AU.on));
bindPress($('invertBtn'),()=>{CFG.invert=!CFG.invert;saveCfg();syncCfgUI()});
bindPress($('vibBtn'),()=>{CFG.vib=!CFG.vib;saveCfg();syncCfgUI()});
document.querySelectorAll('#lookSeg button').forEach(b=>bindPress(b,()=>{CFG.look=parseFloat(b.dataset.look)||1;saveCfg();syncCfgUI()}));
syncCfgUI();
// タイトルは遠景を映すだけなので影と解像度を落とす。登り始めで元に戻す
function setQuality(full){
  if(!renderer)return;
  renderer.shadowMap.enabled=full;
  renderer.setPixelRatio(full?Math.min(devicePixelRatio,isTouch?1.3:1.75):1);
  renderer.setSize(innerWidth,innerHeight,false);
  cloudPlanes.forEach(p=>p.visible=full); // 雲は画面いっぱいの半透明2枚。タイトルでは止める
  heavy.forEach(m=>m.visible=full);       // 木・岩・低木は4万本以上。遠景のタイトルでは出さない
  if(full)renderer.shadowMap.needsUpdate=true;
}
function startClimb(){
  initAudio();
  setQuality(true);
  $('fade').style.opacity=1;
  setTimeout(()=>{resetState();$('title').hidden=true;$('clear').hidden=true;$('pause').hidden=true;paused=false;mode='play';document.body.classList.add('playing');
    $('fade').style.opacity=0;cv.focus();setTimeout(()=>toast('夜明け前の登山口。ヘッドランプを点けて出発',3200),900)},700);
}
bindPress($('startBtn'),startClimb);
bindPress($('restartBtn'),startClimb);
bindPress($('againBtn'),startClimb);
bindPress($('viewBtn'),()=>{$('clear').hidden=true;mode='play';document.body.classList.add('playing')});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden&&mode==='play'&&!paused)openSettings();
  if(!document.hidden&&AU.ctx&&AU.ctx.state==='suspended')AU.ctx.resume();
});
addEventListener('pageshow',()=>{if(AU.ctx&&AU.ctx.state==='suspended')AU.ctx.resume()});

addEventListener('resize',()=>{if(!renderer)return;renderer.setSize(innerWidth,innerHeight,false);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix()});

/* ---------- loop ---------- */
let last=performance.now(),orbit=.4;
function frame(now){
  requestAnimationFrame(frame);
  if(!built)return; // 生成が終わるまでは描かない（途中の材質を触るとエラーになる）
  const dt=Math.min(.05,(now-last)/1000);last=now;T+=dt;
  if(mode==='title'){
    orbit+=dt*.03;
    camera.position.set(Math.sin(orbit)*4600,1650,Math.cos(orbit)*4600);camera.lookAt(0,1250,0);
    updateEnv(6.05,dt);
  }else{
    if(mode==='play'&&!paused)update(dt);
    updateEnv(S.time,dt);
    hudT-=dt;if(hudT<=0&&mode==='play'){hudT=.2;updateHUD()}
    if(mode==='play')drawCompass();
  }
  if(flowTex)flowTex.offset.y-=dt*.6;
  if(mode==='play')updateBubbles();
  // smoke
  for(const sp of smokes){const u=sp.userData;u.t=(u.t+dt*.07)%1;sp.position.set(u.o.x+u.t*6,u.o.y+u.t*14,u.o.z+u.t*3);const s=2+u.t*7;sp.scale.set(s,s,1);sp.material.opacity=Math.sin(u.t*Math.PI)*.45}
  renderer.render(scene,camera);
}

/* ---------- boot ---------- */
(async()=>{
  requestAnimationFrame(frame);
  try{await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,2500))])}catch(e){}
  await new Promise(r=>setTimeout(r,30));
  await build();
  built=true;
  setQuality(false);
  resetState();
  mode='title';
  $('startBtn').disabled=false;$('loading').textContent='';
  $('fade').style.opacity=0;
})();
})();
