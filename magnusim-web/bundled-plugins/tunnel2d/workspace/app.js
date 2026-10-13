import{connect as $s}from"@magnusim/workspace";import{colormapRgb as Ts,Field as N,NumberUnitInput as be,Select as ie,Hint as J,Button as xe,Icon as He,Toggle as Re,fromSi as _s,DisabledReason as rt,ColorLegend as Es,EmptyState as Us}from"@magnusim/plugin-ui";import{useSyncExternalStore as Ds,useState as ue,useEffect as ae,useRef as _e,createElement as ze}from"react";import{createRoot as Ns}from"react-dom/client";import{jsxs as _,jsx as m,Fragment as ot}from"react/jsx-runtime";const Jt={1:[.058,361.4],2:[.126,51.64],3:[.2025,15.957],4:[.29,6.643],5:[.391,3.23]},es={2:[.13,51.99,764e-6],3:[.217,15.793,.00677],4:[.318,6.52,.0303],5:[.441,3.191,.1355]},Dt=20,Nt=250,Fs=81;class ve extends Error{}const Gs=/^\s*(?:naca\s*)?(\d{4,5})\s*$/i;function St(n){const e=Gs.exec(String(n??""));if(!e)throw new ve("Enter a NACA 4-digit or 5-digit designation, such as 2412 or 23012.");const s=e[1];return s.length===4?zs(s):qs(s),s}const me=(n,e)=>Number(n[e]);function zs(n){const e=me(n,0),s=me(n,1);if(Number(n.slice(2))<=0)throw new ve(`NACA ${n}: the thickness (last two digits) must be above 0.`);if(e===0!=(s===0))throw new ve(`NACA ${n}: camber and its position must both be 0 or both be above 0.`)}function qs(n){const e=me(n,0),s=me(n,1),t=me(n,2);if(Number(n.slice(3))<=0)throw new ve(`NACA ${n}: the thickness (last two digits) must be above 0.`);if(e===0)throw new ve(`NACA ${n}: the first digit (design lift) must be above 0.`);if(t!==0&&t!==1)throw new ve(`NACA ${n}: the third digit must be 0 (standard) or 1 (reflexed).`);const i=t?es:Jt;if(!(s in i)){const r=Object.keys(i).sort().join(", ");throw new ve(`NACA ${n}: a ${t?"reflexed":"standard"} 5-digit mean line has its second digit in ${r}.`)}}function Ls(n,e,s){const t=s?-.1036:-.1015;return 5*e*(.2969*Math.sqrt(n)-.126*n-.3516*n**2+.2843*n**3+t*n**4)}function Is(n,e){const s=me(n,0)/100,t=me(n,1)/10;return s===0?[0,0]:e<t?[s/t**2*(2*t*e-e**2),2*s/t**2*(t-e)]:[s/(1-t)**2*(1-2*t+2*t*e-e**2),2*s/(1-t)**2*(t-e)]}function Os(n,e){const s=me(n,0),t=me(n,1),a=me(n,2),i=3*s/20/.3;if(!a){const[d,u]=Jt[t];return e<d?[i*(u/6*(e**3-3*d*e**2+d**2*(3-d)*e)),i*(u/6*(3*e**2-6*d*e+d**2*(3-d)))]:[i*(u*d**3/6*(1-e)),i*(-u*d**3/6)]}const[r,c,o]=es[t],l=o*(1-r)**3;return e<r?[i*(c/6*((e-r)**3-l*e-r**3*e+r**3)),i*(c/6*(3*(e-r)**2-l-r**3))]:[i*(c/6*(o*(e-r)**3-l*e-r**3*e+r**3)),i*(c/6*(3*o*(e-r)**2-l-r**3))]}function Ft(n){const e=Math.round(n*1e10)/1e10;return e===0?0:e}function xt(n,e=Fs,s=!1){const t=St(n),a=Math.trunc(e);if(!(a>=Dt&&a<=Nt))throw new ve(`Points per side must be from ${Dt} to ${Nt}.`);const i=Number(t.slice(-2))/100,r=t.length===4?Is:Os,c=[],o=[];for(let d=0;d<a;d++){const u=Math.PI*d/(a-1),h=.5*(1-Math.cos(u)),f=Ls(h,i,s),[x,p]=r(t,h),w=Math.atan(p);c.push([h-f*Math.sin(w),x+f*Math.cos(w)]),o.push([h+f*Math.sin(w),x-f*Math.cos(w)])}const l=[...c.reverse(),...o.slice(1)];return{code:t,name:`NACA ${t}`,x:l.map(d=>Ft(d[0])),y:l.map(d=>Ft(d[1]))}}function ts(n){let e=0;const s=n.length/2;for(let t=0;t<s;t++){const a=(t+1)%s;e+=n[2*t]*n[2*a+1]-n[2*a]*n[2*t+1]}return e/2}function Bt(n){if(ts(n)>=0)return n;const e=[];for(let s=n.length/2-1;s>=0;s--)e.push(n[2*s],n[2*s+1]);return e}function Vs(n){let e=1/0,s=1/0,t=-1/0,a=-1/0;for(let i=0;i<n.length;i+=2)e=Math.min(e,n[i]),t=Math.max(t,n[i]),s=Math.min(s,n[i+1]),a=Math.max(a,n[i+1]);return{x0:e,y0:s,x1:t,y1:a}}function bt(n){let e=0;for(let s=0;s<n.length;s+=2)e=Math.max(e,Math.hypot(n[s],n[s+1]));return e}function Rt(n,e,s=1){const t=Math.cos(e.theta),a=Math.sin(e.theta),i=new Array(n.length);for(let r=0;r<n.length;r+=2){const c=n[r]*s,o=n[r+1]*s;i[r]=e.x+t*c-a*o,i[r+1]=e.y+a*c+t*o}return i}function Qe(n,e,s){let t=!1;const a=n.length/2;for(let i=0,r=a-1;i<a;r=i++){const c=n[2*i],o=n[2*i+1],l=n[2*r],d=n[2*r+1];o>s!=d>s&&e<(l-c)*(s-o)/(d-o)+c&&(t=!t)}return t}function Ws(n,e,s,t,a,i){const r=a-s,c=i-t,o=r*r+c*c;let l=o>0?((n-s)*r+(e-t)*c)/o:0;return l=Math.max(0,Math.min(1,l)),Math.hypot(n-(s+l*r),e-(t+l*c))}function lt(n,e,s){let t=1/0;const a=n.length/2;for(let i=0;i<a;i++){const r=(i+1)%a;t=Math.min(t,Ws(e,s,n[2*i],n[2*i+1],n[2*r],n[2*r+1]))}return Qe(n,e,s)?-t:t}function Xs(n){const e=n.length/2,s=(t,a,i,r,c,o)=>(i-t)*(o-a)-(r-a)*(c-t);for(let t=0;t<e;t++){const a=(t+1)%e;for(let i=t+1;i<e;i++){const r=(i+1)%e;if(i===a||r===t)continue;const[c,o,l,d]=[n[2*t],n[2*t+1],n[2*a],n[2*a+1]],[u,h,f,x]=[n[2*i],n[2*i+1],n[2*r],n[2*r+1]],p=s(c,o,l,d,u,h),w=s(c,o,l,d,f,x),b=s(u,h,f,x,c,o),A=s(u,h,f,x,l,d);if(p*w<0&&b*A<0)return!0}}return!1}const js=256;function Gt(n,e,s=js){const t=[];for(let a=0;a<s;a++){const i=2*Math.PI*a/s;t.push(n*Math.cos(i),e*Math.sin(i))}return t}function zt(n,e){return[-n/2,-e/2,n/2,-e/2,n/2,e/2,-n/2,e/2]}function ss(n,e,s){if(!(s>0))return{x:n,y:e};let t=0;for(let o=1;o<n.length;o++)n[o]<n[t]&&(t=o);const a=Array.from({length:t+1},(o,l)=>t-l),i=Array.from({length:n.length-t},(o,l)=>t+l),r=(o,l)=>{for(let d=1;d<o.length;d++){const u=o[d-1],h=o[d];if(n[h]>=l)return n[h]===n[u]?e[h]:e[u]+(e[h]-e[u])*(l-n[u])/(n[h]-n[u])}return e[o[o.length-1]]},c=e.slice();for(let o=0;o<n.length;o++){if(n[o]<.5)continue;const l=o<t,d=r(l?i:a,n[o]);if((l?e[o]-d:d-e[o])>=s)continue;const h=.5*(e[o]+d);c[o]=h+(l?.5:-.5)*s}return{x:n,y:c}}function qt(n,e,s,t=0){const a=ss(n,e,t/s),i=[];for(let r=0;r<a.x.length;r++)i.push((a.x[r]-.25)*s,a.y[r]*s);return Bt(i)}function Ie(n,e=0){switch(n.kind){case"naca":{const s=xt(n.code,121);return qt(s.x,s.y,n.chord,e)}case"dat":return qt(n.x,n.y,n.chord,e);case"circle":return Gt(n.diameter/2,n.diameter/2);case"ellipse":return Gt(n.width/2,n.height/2);case"rect":return zt(n.width,n.height);case"plate":return zt(n.length,n.thickness)}}function Ae(n){switch(n.kind){case"naca":case"dat":return n.chord;case"circle":return n.diameter;case"ellipse":case"rect":return n.height;case"plate":return n.length}}function Ze(n){switch(n.kind){case"naca":return`NACA ${n.code}`;case"dat":return n.name;case"circle":return"Cylinder";case"ellipse":return"Ellipse";case"rect":return"Rectangle";case"plate":return"Flat plate"}}const Ys=4,Ks=2,Hs=4e6;function Ct(n,e=Ys){const s=Vs(n),t=e+2;let a=1/Ks,i=Math.ceil((s.x1-s.x0+2*t)/a)+1,r=Math.ceil((s.y1-s.y0+2*t)/a)+1;for(;i*r>Hs;)a*=1.5,i=Math.ceil((s.x1-s.x0+2*t)/a)+1,r=Math.ceil((s.y1-s.y0+2*t)/a)+1;const c=s.x0-t,o=s.y0-t,l=new Float32Array(i*r).fill(e),d=n.length/2;for(let f=0;f<d;f++){const x=n[2*f],p=n[2*f+1],w=n[2*((f+1)%d)],b=n[2*((f+1)%d)+1],A=Math.max(0,Math.floor((Math.min(x,w)-e-c)/a)),M=Math.min(i-1,Math.ceil((Math.max(x,w)+e-c)/a)),g=Math.max(0,Math.floor((Math.min(p,b)-e-o)/a)),v=Math.min(r-1,Math.ceil((Math.max(p,b)+e-o)/a)),k=w-x,B=b-p,S=k*k+B*B;for(let R=g;R<=v;R++){const P=o+R*a;for(let y=A;y<=M;y++){const $=c+y*a;let T=S>0?(($-x)*k+(P-p)*B)/S:0;T=T<0?0:T>1?1:T;const G=$-(x+T*k),E=P-(p+T*B),C=Math.sqrt(G*G+E*E),O=R*i+y;C<l[O]&&(l[O]=C)}}}const u=[];for(let f=0;f<r;f++){const x=o+f*a;u.length=0;for(let p=0;p<d;p++){const w=n[2*p+1],b=n[2*((p+1)%d)+1];if(w>x!=b>x){const A=n[2*p],M=n[2*((p+1)%d)];u.push(A+(x-w)*(M-A)/(b-w))}}u.sort((p,w)=>p-w);for(let p=0;p+1<u.length;p+=2){const w=Math.max(0,Math.ceil((u[p]-c)/a)),b=Math.min(i-1,Math.floor((u[p+1]-c)/a));for(let A=w;A<=b;A++)l[f*i+A]=-l[f*i+A]}}let h=0;for(let f=0;f<d;f++)h=Math.max(h,Math.hypot(n[2*f],n[2*f+1]));return{data:l,w:i,h:r,ox:c,oy:o,texel:a,band:e,bound:h+1}}const Qs=new Uint8Array([0,0,4,1,0,5,1,1,6,1,1,8,2,1,10,2,2,12,2,2,14,3,2,16,4,3,18,4,3,20,5,4,23,6,4,25,7,5,27,8,5,29,9,6,31,10,7,34,11,7,36,12,8,38,13,8,41,14,9,43,16,9,45,17,10,48,18,10,50,20,11,52,21,11,55,22,11,57,24,12,60,25,12,62,27,12,65,28,12,67,30,12,69,31,12,72,33,12,74,35,12,76,36,12,79,38,12,81,40,11,83,41,11,85,43,11,87,45,11,89,47,10,91,49,10,92,50,10,94,52,10,95,54,9,97,56,9,98,57,9,99,59,9,100,61,9,101,62,9,102,64,10,103,66,10,104,68,10,104,69,10,105,71,11,106,73,11,106,74,12,107,76,12,107,77,13,108,79,13,108,81,14,108,82,14,109,84,15,109,85,15,109,87,16,110,89,16,110,90,17,110,92,18,110,93,18,110,95,19,110,97,19,110,98,20,110,100,21,110,101,21,110,103,22,110,105,22,110,106,23,110,108,24,110,109,24,110,111,25,110,113,25,110,114,26,110,116,26,110,117,27,110,119,28,109,120,28,109,122,29,109,124,29,109,125,30,109,127,30,108,128,31,108,130,32,108,132,32,107,133,33,107,135,33,107,136,34,106,138,34,106,140,35,105,141,35,105,143,36,105,144,37,104,146,37,104,147,38,103,149,38,103,151,39,102,152,39,102,154,40,101,155,41,100,157,41,100,159,42,99,160,42,99,162,43,98,163,44,97,165,44,96,166,45,96,168,46,95,169,46,94,171,47,94,173,48,93,174,48,92,176,49,91,177,50,90,179,50,90,180,51,89,182,52,88,183,53,87,185,53,86,186,54,85,188,55,84,189,56,83,191,57,82,192,58,81,193,58,80,195,59,79,196,60,78,198,61,77,199,62,76,200,63,75,202,64,74,203,65,73,204,66,72,206,67,71,207,68,70,208,69,69,210,70,68,211,71,67,212,72,66,213,74,65,215,75,63,216,76,62,217,77,61,218,78,60,219,80,59,221,81,58,222,82,56,223,83,55,224,85,54,225,86,53,226,87,52,227,89,51,228,90,49,229,92,48,230,93,47,231,94,46,232,96,45,233,97,43,234,99,42,235,100,41,235,102,40,236,103,38,237,105,37,238,106,36,239,108,35,239,110,33,240,111,32,241,113,31,241,115,29,242,116,28,243,118,27,243,120,25,244,121,24,245,123,23,245,125,21,246,126,20,246,128,19,247,130,18,247,132,16,248,133,15,248,135,14,248,137,12,249,139,11,249,140,10,249,142,9,250,144,8,250,146,7,250,148,7,251,150,6,251,151,6,251,153,6,251,155,6,251,157,7,252,159,7,252,161,8,252,163,9,252,165,10,252,166,12,252,168,13,252,170,15,252,172,17,252,174,18,252,176,20,252,178,22,252,180,24,251,182,26,251,184,29,251,186,31,251,188,33,251,190,35,250,192,38,250,194,40,250,196,42,250,198,45,249,199,47,249,201,50,249,203,53,248,205,55,248,207,58,247,209,61,247,211,64,246,213,67,246,215,70,245,217,73,245,219,76,244,221,79,244,223,83,244,225,86,243,227,90,243,229,93,242,230,97,242,232,101,242,234,105,241,236,109,241,237,113,241,239,117,241,241,121,242,242,125,242,244,130,243,245,134,243,246,138,244,248,142,245,249,146,246,250,150,248,251,154,249,252,157,250,253,161,252,255,164]),K=128,W=8,re=2048,Je=1048576,de=re*W*2,ct=de+4,Ne=.1,Fe=.2,fe=[0,1,0,-1,0,1,-1,-1,1],Me=[0,0,1,0,-1,1,1,-1,-1],ge=[4/9,1/9,1/9,1/9,1/9,1/36,1/36,1/36,1/36],Zs=[0,3,4,1,2,7,8,5,6],Js=[0,1,4,3,2,8,7,6,5],en={slip:0,noslip:1,periodic:2,farfield:3},D=n=>n.toFixed(10),Y=n=>n.toFixed(1),nt=`
struct Params {
  nx: u32, ny: u32, n: u32, nBodies: u32,
  omega: f32, smag: f32, uIn: f32, absorb: f32,
  absorbIn: f32, spongeX: f32, frameSteps: u32, profile: u32,
  farW: f32, nuMol: f32, nuFloor: f32, nuInf: f32,
};
struct Body {
  c0: vec2f, c1: vec2f,
  a0: f32, a1: f32, bound: f32, texel: f32,
  org: vec2f, w: u32, h: u32,
  off: u32, band: f32, p1: u32, p2: u32,
};
struct Hit { d: f32, b: u32 };

fn sdfLocal(b: u32, lp: vec2f) -> f32 {
  let bd = B[b];
  let uv = (lp - bd.org) / bd.texel;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > f32(bd.w - 1u) || uv.y > f32(bd.h - 1u)) { return bd.band; }
  let i = min(u32(uv.x), bd.w - 2u);
  let j = min(u32(uv.y), bd.h - 2u);
  let f = uv - vec2f(f32(i), f32(j));
  let k = bd.off + j * bd.w + i;
  return mix(mix(sdf[k], sdf[k + 1u], f.x), mix(sdf[k + bd.w], sdf[k + bd.w + 1u], f.x), f.y);
}

/** The nearest body's signed distance (cells) at p, over the bodies in the mask. */
fn sdfAt(p: vec2f, near: u32, bp: ptr<function, array<vec4f, ${W}>>) -> Hit {
  var h = Hit(4.0, 0u);
  for (var b = 0u; b < P.nBodies; b++) {
    if ((near & (1u << b)) == 0u) { continue; }
    let q = (*bp)[b];
    let r = p - q.xy;
    let lp = vec2f(q.z * r.x + q.w * r.y, -q.w * r.x + q.z * r.y);
    let d = sdfLocal(b, lp);
    if (d < h.d) { h = Hit(d, b); }
  }
  return h;
}

/** The distance field's gradient at p (unnormalized, half-cell differences). */
fn sdfGrad(p: vec2f, near: u32, bp: ptr<function, array<vec4f, ${W}>>) -> vec2f {
  return vec2f(sdfAt(p + vec2f(0.5, 0.0), near, bp).d - sdfAt(p - vec2f(0.5, 0.0), near, bp).d,
               sdfAt(p + vec2f(0.0, 0.5), near, bp).d - sdfAt(p - vec2f(0.0, 0.5), near, bp).d);
}

/** A body's wall velocity (cells per step) at p: its translation and its turn. */
fn wallU(b: u32, p: vec2f, c: vec2f) -> vec2f {
  let bd = B[b];
  let fs = f32(P.frameSteps);
  let v = (bd.c1 - bd.c0) / fs;
  let w = (bd.a1 - bd.a0) / fs;
  return v + w * vec2f(-(p.y - c.y), p.x - c.x);
}

/** Each body's pose at fraction t of the frame (x, y, cos, sin) and the ones near p. */
fn poses(p: vec2f, t: f32, bp: ptr<function, array<vec4f, ${W}>>) -> u32 {
  var near = 0u;
  for (var b = 0u; b < P.nBodies; b++) {
    let bd = B[b];
    let c = mix(bd.c0, bd.c1, t);
    let a = mix(bd.a0, bd.a1, t);
    (*bp)[b] = vec4f(c, cos(a), sin(a));
    if (distance(p, c) < bd.bound + 2.0) { near |= 1u << b; }
  }
  return near;
}

fn feqAt(k: u32, rho: f32, u: vec2f) -> f32 {
  let c = vec2f(CXF[k], CYF[k]);
  let cu = dot(c, u);
  return WF[k] * rho * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * dot(u, u));
}
`,it=`
const CXF = array<f32, 9>(${fe.map(Y).join(", ")});
const CYF = array<f32, 9>(${Me.map(Y).join(", ")});
const WF = array<f32, 9>(${ge.map(D).join(", ")});
`,tn={off:0,wall:1,sa:2},Ce=.41,ns=5,ce={cb1:.1355,sigma:2/3,cb2:.622,cw2:.3,cw3:2,cv1:7.1,cv2:.7,cv3:.9},sn=ce.cb1/(Ce*Ce)+(1+ce.cb2)/ce.sigma,nn=.2,$t=2,is=32,Se=2,an=`
const KAPPA = ${D(Ce)};
const WALL_EKB = ${D(Math.exp(-Ce*ns))};
const SA_CB1 = ${D(ce.cb1)};
const SA_SIGMA = ${D(ce.sigma)};
const SA_CB2 = ${D(ce.cb2)};
const SA_CW1 = ${D(sn)};
const SA_CW2 = ${D(ce.cw2)};
const SA_CW3_6 = ${D(ce.cw3**6)};
const SA_CV1_3 = ${D(ce.cv1**3)};
const SA_CV2 = ${D(ce.cv2)};
const SA_CV3 = ${D(ce.cv3)};

/** u+ where y ut / ν = reY on Spalding's law (Newton from the right: the law is convex). */
fn wallUplus(reY: f32) -> f32 {
  var up = min(sqrt(max(reY, 0.0)), 45.0);
  for (var i = 0; i < 18; i++) {
    let k = KAPPA * up;
    let ek = exp(k);
    let Y = up + WALL_EKB * (ek - 1.0 - k - 0.5 * k * k - k * k * k / 6.0);
    let dY = 1.0 + WALL_EKB * KAPPA * (ek - 1.0 - k - 0.5 * k * k);
    up = max(up - (Y * up - reY) / (dY * up + Y), 1e-4);
  }
  return up;
}

fn auxAt(x: i32, y: i32) -> vec4f {
  let cx = clamp(x, 0, i32(P.nx) - 1);
  let cy = clamp(y, 0, i32(P.ny) - 1);
  return auxIn[u32(cx) + u32(cy) * P.nx];
}

/** The last step's auxiliary field at l (bilinear over the fluid cells only; w -1 if none). */
fn auxLerp(l: vec2f) -> vec4f {
  let c = clamp(l, vec2f(0.0), vec2f(f32(P.nx) - 1.001, f32(P.ny) - 1.001));
  let i = vec2i(floor(c));
  let f = c - floor(c);
  var s = vec4f(0.0);
  var wsum = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let a = auxAt(i.x + o.x, i.y + o.y);
    let w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1);
    if (a.w >= 0.0) { s += w * a; wsum += w; }
  }
  return select(vec4f(0.0, 0.0, 0.0, -1.0), s / wsum, wsum > 1e-6);
}

/** Distance (cells) to the nearest body, beyond the baked band too (a lower bound there). */
fn wallDist(p: vec2f, bp: ptr<function, array<vec4f, ${W}>>) -> f32 {
  var d = 1e6;
  for (var b = 0u; b < P.nBodies; b++) {
    let q = (*bp)[b];
    let bd = B[b];
    let r = p - q.xy;
    let far = length(r) - bd.bound;
    if (far > bd.band) { d = min(d, far); continue; }
    let lp = vec2f(q.z * r.x + q.w * r.y, -q.w * r.x + q.z * r.y);
    let s = sdfLocal(b, lp);
    d = min(d, select(s, max(s, far), s >= bd.band - 0.01));
  }
  return max(d, 0.05);
}

/** One explicit step of ν̃ at a fluid cell: advection (third-order upwind), diffusion, production, destruction. */
fn saStep(xi: i32, yi: i32, u: vec2f, d: f32) -> f32 {
  let c = auxAt(xi, yi);
  let e = auxAt(xi + 1, yi);
  let w = auxAt(xi - 1, yi);
  let n = auxAt(xi, yi + 1);
  let s = auxAt(xi, yi - 1);
  let n0 = c.z;
  let nE = select(e.z, 0.0, e.w < 0.0);
  let nW = select(w.z, 0.0, w.w < 0.0);
  let nN = select(n.z, 0.0, n.w < 0.0);
  let nS = select(s.z, 0.0, s.w < 0.0);
  let ee = auxAt(xi + 2, yi);
  let ww = auxAt(xi - 2, yi);
  let nn = auxAt(xi, yi + 2);
  let ss = auxAt(xi, yi - 2);
  let nEE = select(ee.z, 0.0, ee.w < 0.0);
  let nWW = select(ww.z, 0.0, ww.w < 0.0);
  let nNN = select(nn.z, 0.0, nn.w < 0.0);
  let nSS = select(ss.z, 0.0, ss.w < 0.0);
  var adv = 0.0;
  if (u.x > 0.0) { adv += u.x * (2.0 * nE + 3.0 * n0 - 6.0 * nW + nWW) / 6.0; }
  else { adv += u.x * (-nEE + 6.0 * nE - 3.0 * n0 - 2.0 * nW) / 6.0; }
  if (u.y > 0.0) { adv += u.y * (2.0 * nN + 3.0 * n0 - 6.0 * nS + nSS) / 6.0; }
  else { adv += u.y * (-nNN + 6.0 * nN - 3.0 * n0 - 2.0 * nS) / 6.0; }
  let nu = P.nuMol;
  let diff = ((nu + 0.5 * (n0 + nE)) * (nE - n0) - (nu + 0.5 * (n0 + nW)) * (n0 - nW)
            + (nu + 0.5 * (n0 + nN)) * (nN - n0) - (nu + 0.5 * (n0 + nS)) * (n0 - nS)) / SA_SIGMA;
  let gx = 0.5 * (nE - nW);
  let gy = 0.5 * (nN - nS);
  let cross = SA_CB2 / SA_SIGMA * (gx * gx + gy * gy);
  let om = abs(0.5 * (e.y - w.y) - 0.5 * (n.x - s.x));
  let chi = n0 / nu;
  let chi3 = chi * chi * chi;
  let fv1 = chi3 / (chi3 + SA_CV1_3);
  let fv2 = 1.0 - chi / (1.0 + chi * fv1);
  let kd2 = KAPPA * KAPPA * d * d;
  let sbar = n0 * fv2 / kd2;
  var st = om + sbar;
  if (sbar < -SA_CV2 * om) { st = om + om * (SA_CV2 * SA_CV2 * om + SA_CV3 * sbar) / ((SA_CV3 - 2.0 * SA_CV2) * om - sbar); }
  var r = 10.0;
  if (st > 1e-12) { r = min(n0 / (st * kd2), 10.0); }
  let r2 = r * r;
  let g = r + SA_CW2 * (r2 * r2 * r2 - r);
  let g2 = g * g;
  let fw = g * pow((1.0 + SA_CW3_6) / (g2 * g2 * g2 + SA_CW3_6), 1.0 / 6.0);
  let prod = SA_CB1 * st * n0;
  let dest = SA_CW1 * fw * (n0 / d) * (n0 / d);
  return clamp(n0 + prod - dest + diff + cross - adv, 0.0, ${nn});
}

fn saFv1(nt: f32) -> f32 {
  let chi = nt / P.nuMol;
  let chi3 = chi * chi * chi;
  return chi3 / (chi3 + SA_CV1_3);
}
`;function as(){const n=(i,r)=>`fin[${i}u * P.n + ${r}]`,e=i=>`(${D(ge[i])} * (drho + rho * (3.0 * (${Y(fe[i])} * ux + ${Y(Me[i])} * uy) + 4.5 * (${Y(fe[i])} * ux + ${Y(Me[i])} * uy) * (${Y(fe[i])} * ux + ${Y(Me[i])} * uy) - 1.5 * (ux * ux + uy * uy))))`;let s="";for(let i=1;i<9;i++){const r=Zs[i],c=fe[i],o=Me[i];let l="";c>0&&(l=`if (x == 0u) { f${i} = 0.0; } else `),c<0&&(l=`if (x == P.nx - 1u) { f${i} = ${n(i,"idx")}; } else `);let d="";if(o!==0){const h=o>0?"y == 0u":"y == P.ny - 1u",f=o>0?"P.ny - 1u":"0u";d=`if (${h}) {
      if (WALLS == 1u) { f${i} = ${n(r,"idx")}; }
      else if (WALLS == 0u) { f${i} = ${n(Js[i],`u32(i32(x) - (${c})) + y * P.nx`)}; }
      else if (WALLS == 3u) { f${i} = ${D(ge[i])} * (3.0 * ${Y(c)} * P.uIn + 4.5 * ${Y(c*c)} * P.uIn * P.uIn - 1.5 * P.uIn * P.uIn); }
      else { f${i} = ${n(i,`u32(i32(x) - (${c})) + ${f} * P.nx`)}; }
    } else `}const u=`(${Y(c)} * uw.x + ${Y(o)} * uw.y)`;s+=`
  var f${i}: f32;
  ${l}${d}{
    let sx = i32(x) - (${c});
    let sy = i32(y) - (${o});
    let src = u32(sx) + u32(sy) * P.nx;
    var hit = Hit(4.0, 0u);
    var qThin = -1.0;
    if (near != 0u) {
      hit = sdfAt(vec2f(f32(sx), f32(sy)), near, &bp);
      // A body thinner than a cell (a trailing edge, a plate) can lie between two fluid
      // cells: the link's middle is inside it. Without this the flow streams through it.
      // Only a real crossing counts: the two cells on opposite sides (the field's gradients
      // there point apart), not a link grazing a wall the interpolated field dips under.
      if (hit.d >= 0.0 && d0 < 0.75) {
        let hm = sdfAt(vec2f(f32(x) - ${Y(c*.5)}, f32(y) - ${Y(o*.5)}), near, &bp);
        if (hm.d < 0.0 && dot(sdfGrad(p, near, &bp), sdfGrad(vec2f(f32(sx), f32(sy)), near, &bp)) < 0.0) {
          hit = hm;
          qThin = clamp(0.5 * d0 / (d0 - hm.d), 0.001, 0.5);
        }
      }
    }
    if (hit.d < 0.0) {
      // Bouzidi: direction ${r} leaves this cell into the body, q of the way to its wall.
      var q = select(clamp(d0 / (d0 - hit.d), 0.001, 1.0), qThin, qThin >= 0.0);
      let bx = i32(x) + (${c});
      let by = i32(y) + (${o});
      var behindFluid = bx >= 0 && by >= 0 && bx < i32(P.nx) && by < i32(P.ny);
      if (behindFluid && q < 0.5) { behindFluid = sdfAt(vec2f(f32(bx), f32(by)), near, &bp).d >= 0.0; }
      if (q < 0.5 && !behindFluid) { q = 0.5; }
      let c = bp[hit.b].xy;
      let uwB = wallU(hit.b, vec2f(f32(sx), f32(sy)), c);
      // The wall model's slip moves the wall along itself (only the body it was worked out for).
      let uw = uwB + select(vec2f(0.0), slip, hit.b == wfB);
      let fi = ${n(r,"idx")};
      let mw = ${D(6*ge[i])} * ${u};
      if (q < 0.5) { f${i} = 2.0 * q * fi + (1.0 - 2.0 * q) * ${n(r,"u32(bx) + u32(by) * P.nx")} + mw; }
      else { f${i} = fi / (2.0 * q) + (2.0 * q - 1.0) / (2.0 * q) * ${n(i,"idx")} + mw / (2.0 * q); }
      let slot = (S.slot * ${W}u + hit.b) * 2u;
      atomicAdd(&force[slot], i32(round((${Y(fe[r])} * (fi + f${i}) - uwB.x * (fi - f${i})) * ${Je}.0)));
      atomicAdd(&force[slot + 1u], i32(round((${Y(Me[r])} * (fi + f${i}) - uwB.y * (fi - f${i})) * ${Je}.0)));
    } else {
      f${i} = ${n(i,"src")};
    }
  }`}let t="";for(let i=0;i<9;i++)t+=`  let e${i} = ${e(i)};
`;const a=i=>`(f${i} - e${i})`;t+=`
  let pxx = ${[1,3,5,6,7,8].map(a).join(" + ")};
  let pyy = ${[2,4,5,6,7,8].map(a).join(" + ")};
  let pxy = ${a(5)} - ${a(6)} + ${a(7)} - ${a(8)};
  var tP = 1.0 / P.omega;
  if (SMAG) {
    let Q = sqrt(pxx * pxx + pyy * pyy + 2.0 * pxy * pxy);
    tP = 0.5 * (tP + sqrt(tP * tP + P.smag * Q / rho));
  }
  // Spalart–Allmaras: this cell's ν̃ (from the wall law in the first cells off a wall), and
  // its total viscosity ν + ν_t, floored where the grid cannot carry less.
  var ntOut = 0.0;
  if (TURB == 2u) {
    if (wfNt >= 0.0) { ntOut = wfNt; }
    else { ntOut = saStep(i32(x), i32(y), vec2f(ux, uy), wallDist(p, &bp)); }
    tP = 3.0 * max(P.nuMol + ntOut * saFv1(ntOut), P.nuFloor) + 0.5;
  }
  let nuCell = (tP - 0.5) / 3.0;
  var sig = 0.0;
  if (xf > P.spongeX) { let r = (xf - P.spongeX) / (f32(P.nx) - P.spongeX); tP += r * r; sig = P.absorb * r * r; }
  if (xf < P.absorbIn) { let r = (P.absorbIn - xf) / P.absorbIn; sig = P.absorb * r * r; }
  if (WALLS == 3u) {
    // Open top and bottom: a band that relaxes to the free stream, so what reaches the
    // edge (sound, a wake) passes out instead of reflecting.
    let yb = min(f32(y), f32(P.ny - 1u) - f32(y));
    if (yb < P.farW) { let r = (P.farW - yb) / P.farW; sig = max(sig, P.absorb * r * r); }
  }
  if (TURB == 2u) {
    if (x == 0u) { ntOut = P.nuInf; }
    ntOut = mix(ntOut, P.nuInf, sig);
  }
  if (TURB > 0u) { auxOut[idx] = vec4f(ux, uy, ntOut, nuCell); }
  let omP = 1.0 / tP;
  let axxy = 2.0 * ux * pxy + uy * pxx;
  let axyy = 2.0 * uy * pxy + ux * pyy;
  let keep = 1.0 - omP;
  // Bulk viscosity: the stress's trace (compression) relaxes fully every step while its
  // deviatoric part (shear) relaxes at omP. Sound waves (from dragged bodies, the start)
  // then die out within a few cells instead of ringing between the walls, and the
  // incompressible flow is unchanged (the Schafer-Turek check runs with it).
  let half = 0.5 * (pxx + pyy);
  let kb = select(KEEP_BULK, keep, KEEP_BULK < 0.0);
  let dxx = keep * (pxx - half) + kb * half;
  let dyy = keep * (pyy - half) + kb * half;
  let dxy = keep * pxy;
`;for(let i=0;i<9;i++){const r=fe[i],c=Me[i],o=r*r-1/3,l=c*c-1/3,d=r*c,u=r*r*c-c/3,h=r*c*c-r/3;t+=`  var o${i} = ${D(ge[i])} * (drho + rho * (3.0 * (${D(r)} * ux + ${D(c)} * uy) + 4.5 * (${D(o)} * ux * ux + ${D(l)} * uy * uy + ${D(2*d)} * ux * uy) + 13.5 * (${D(u)} * ux * ux * uy + ${D(h)} * ux * uy * uy)))
    + ${D(ge[i])} * (4.5 * (${D(o)} * dxx + ${D(l)} * dyy + ${D(2*d)} * dxy) + 13.5 * keep * (${D(u)} * axxy + ${D(h)} * axyy));
`}return t+=`  if (sig > 0.0) {
    let uT = P.uIn;
${Array.from({length:9},(i,r)=>`    o${r} = mix(o${r}, ${D(ge[r])} * (3.0 * ${Y(fe[r])} * uT + 4.5 * ${Y(fe[r]*fe[r])} * uT * uT - 1.5 * uT * uT), sig);`).join(`
`)}
  }
${Array.from({length:9},(i,r)=>`  fout[${r}u * P.n + idx] = o${r};`).join(`
`)}
`,`
override WALLS: u32 = 0u;
override SMAG: bool = false;
override TURB: u32 = 0u;
/** 1 - the bulk relaxation rate (0: the stress's trace fully relaxed each step; below 0: as the shear's). */
override KEEP_BULK: f32 = 0.0;
struct Step { slot: u32, p0: u32, p1: u32, p2: u32 };
@group(0) @binding(0) var<storage, read> fin: array<f32>;
@group(0) @binding(1) var<storage, read_write> fout: array<f32>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
@group(0) @binding(5) var<storage, read_write> force: array<atomic<i32>>;
@group(0) @binding(6) var<storage, read> auxIn: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> auxOut: array<vec4f>;
@group(1) @binding(0) var<uniform> S: Step;
${it}
${nt}
${an}

@compute @workgroup_size(${K})
fn step(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${K}u;
  if (idx >= P.n) { return; }
  let x = idx % P.nx;
  let y = idx / P.nx;
  let xf = f32(x);
  let p = vec2f(xf, f32(y));
  var bp: array<vec4f, ${W}>;
  let near = poses(p, f32(S.slot + 1u) / f32(P.frameSteps), &bp);
  var d0 = 4.0;
  var b0 = 0u;
  if (near != 0u) {
    let h0 = sdfAt(p, near, &bp);
    d0 = h0.d;
    b0 = h0.b;
    if (d0 < 0.0) {
      let uw = wallU(h0.b, p, bp[h0.b].xy);
      for (var k = 0u; k < 9u; k++) { fout[k * P.n + idx] = feqAt(k, 1.0, uw) - WF[k]; }
      if (TURB > 0u) { auxOut[idx] = vec4f(uw, 0.0, -1.0); }
      return;
    }
  }
  // The wall model, in the cells next to a wall: the friction velocity from the wall law at
  // the velocity ${Se} cells off the wall (last step's), then the slip that makes the
  // stress resolved between the wall and the point one cell off it the law's (that point, not
  // this cell: a cell on the wall would set its own slip), and ν̃ = κ u_τ d here.
  var slip = vec2f(0.0);
  var wfB = ${W}u;
  var wfNt = -1.0;
  if (TURB > 0u && near != 0u && d0 < 1.5) {
    let gx = sdfAt(p + vec2f(0.5, 0.0), near, &bp).d - sdfAt(p - vec2f(0.5, 0.0), near, &bp).d;
    let gy = sdfAt(p + vec2f(0.0, 0.5), near, &bp).d - sdfAt(p - vec2f(0.0, 0.5), near, &bp).d;
    let gl = length(vec2f(gx, gy));
    if (gl > 1e-6) {
      let nrm = vec2f(gx, gy) / gl;
      let xw = p - d0 * nrm;
      let ub = wallU(b0, xw, bp[b0].xy);
      let aR = auxLerp(xw + ${Se.toFixed(3)} * nrm);
      let aV = auxLerp(xw + nrm);
      let uR = aR.xy - ub;
      let utR = uR - dot(uR, nrm) * nrm;
      let ut = length(utR);
      if (ut > 1e-7 && aR.w >= 0.0 && aV.w >= 0.0) {
        let t = utR / ut;
        let utau = ut / wallUplus(${Se.toFixed(3)} * ut / P.nuMol);
        let uv = dot(aV.xy - ub, t);
        let s = clamp(uv - utau * utau / max(aV.w, P.nuMol), 0.0, max(uv, 0.0));
        slip = s * t;
        wfB = b0;
        wfNt = KAPPA * utau * d0;
      }
    }
  }
  var f0 = ${n(0,"idx")};
  ${s}
  if (x == 0u) {
    var u = P.uIn;
    if (P.profile == 1u) {
      let H = f32(P.ny);
      let yy = f32(y) + 0.5;
      u = 4.0 * P.uIn * yy * (H - yy) / (H * H);
    }
    let r = (1.0 + f0 + f2 + f4 + 2.0 * (f3 + f6 + f7)) / (1.0 - u);
    f1 = f3 + (2.0 / 3.0) * r * u;
    f5 = f7 - 0.5 * (f2 - f4) + (1.0 / 6.0) * r * u;
    f8 = f6 + 0.5 * (f2 - f4) + (1.0 / 6.0) * r * u;
  }
  if (x == P.nx - 1u) {
    let uo = f0 + f2 + f4 + 2.0 * (f1 + f5 + f8);
    f3 = f1 - (2.0 / 3.0) * uo;
    f7 = f5 + 0.5 * (f2 - f4) - (1.0 / 6.0) * uo;
    f6 = f8 - 0.5 * (f2 - f4) - (1.0 / 6.0) * uo;
  }
  var drho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
  var rho = 1.0 + drho;
  if (!(rho > 0.5 && rho < 2.0)) {
    atomicAdd(&force[${de}u], 1);
    atomicMax(&force[${de+1}u], i32(P.n - idx));
  }
  var ux = (f1 - f3 + f5 - f6 - f7 + f8) / rho;
  var uy = (f2 - f4 + f5 + f6 - f7 - f8) / rho;
  // The limiter: flow squeezed in a gap two moving bodies close has nowhere to go. A cell
  // whose density leaves ±${Ne*100} % or whose speed passes ${Fe} (4 x the inflow) is put
  // back to equilibrium inside those bounds. Ordinary flow here stays within about 1 %, so
  // only such pockets are touched; each use is counted and the page says so.
  let usq0 = ux * ux + uy * uy;
  if (!(rho >= ${1-Ne} && rho <= ${1+Ne} && usq0 <= ${Fe*Fe})) {
    atomicAdd(&force[${de+2}u], 1);
    let ok = rho == rho && ux == ux && uy == uy;
    rho = select(1.0, clamp(rho, ${1-Ne}, ${1+Ne}), ok);
    var uc = select(vec2f(0.0), vec2f(ux, uy), ok);
    let m = length(uc);
    if (m > ${Fe}) { uc = uc * (${Fe} / m); }
    ux = uc.x;
    uy = uc.y;
    drho = rho - 1.0;
${Array.from({length:9},(i,r)=>`    f${r} = feqAt(${r}u, rho, uc) - ${D(ge[r])};`).join(`
`)}
  }
${t}
}
`}function rs(){return`
@group(0) @binding(0) var<storage, read> fin: array<f32>;
@group(0) @binding(1) var<storage, read_write> mac: array<vec4f>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
${it}
${nt}

@compute @workgroup_size(${K})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${K}u;
  if (idx >= P.n) { return; }
  let p = vec2f(f32(idx % P.nx), f32(idx / P.nx));
  var bp: array<vec4f, ${W}>;
  let near = poses(p, 1.0, &bp);
  if (near != 0u) {
    let h = sdfAt(p, near, &bp);
    if (h.d < 0.0) {
      mac[idx] = vec4f(wallU(h.b, p, bp[h.b].xy), 1.0, 1.0);
      return;
    }
  }
  // Stored as f - w: the density is 1 + their sum, the momentum their first moment.
  var drho = 0.0;
  var m = vec2f(0.0);
  for (var k = 0u; k < 9u; k++) {
    let g = fin[k * P.n + idx];
    drho += g;
    m += g * vec2f(CXF[k], CYF[k]);
  }
  let rho = 1.0 + drho;
  mac[idx] = vec4f(m / rho, rho, 0.0);
}
`}function os(){return`
struct D { nx: u32, ny: u32, mode: u32, stride: u32, uRef: f32, lRef: f32, sw: u32, sh: u32, rhoRef: f32, p0: f32, p1: f32, p2: f32 };
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> scalar: array<f32>;
@group(0) @binding(2) var<uniform> V: D;
@group(0) @binding(3) var<storage, read_write> sampled: array<f32>;

fn at(x: i32, y: i32) -> vec4f {
  let cx = clamp(x, 0, i32(V.nx) - 1);
  let cy = clamp(y, 0, i32(V.ny) - 1);
  return mac[u32(cx) + u32(cy) * V.nx];
}

@compute @workgroup_size(${K})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${K}u;
  if (idx >= V.nx * V.ny) { return; }
  let x = i32(idx % V.nx);
  let y = i32(idx / V.nx);
  let m = mac[idx];
  var s = 0.0;
  if (V.mode == 0u) {
    // Vorticity x reference length / free-stream speed.
    let dvdx = 0.5 * (at(x + 1, y).y - at(x - 1, y).y);
    let dudy = 0.5 * (at(x, y + 1).x - at(x, y - 1).x);
    s = (dvdx - dudy) * V.lRef / V.uRef;
  } else if (V.mode == 1u) {
    s = length(m.xy) / V.uRef;
  } else if (V.mode == 2u) {
    // Pressure coefficient against the free stream's pressure (rhoRef, measured upstream).
    s = ((m.z - V.rhoRef) / 3.0) / (0.5 * V.uRef * V.uRef);
  } else {
    let g = vec2f(at(x + 1, y).z - at(x - 1, y).z, at(x, y + 1).z - at(x, y - 1).z) * 0.5;
    s = length(g) / (V.uRef * V.uRef) * V.lRef;
  }
  if (m.w > 0.5) { s = 0.0; }
  scalar[idx] = s;
  if (u32(x) % V.stride == 0u && u32(y) % V.stride == 0u) {
    let sx = u32(x) / V.stride;
    let sy = u32(y) / V.stride;
    if (sx < V.sw && sy < V.sh) { sampled[sx + sy * V.sw] = select(s, 1e30, m.w > 0.5); }
  }
}
`}function ls(){return`
struct View {
  scale: f32, ox: f32, oy: f32, lo: f32,
  hi: f32, nxf: f32, nyf: f32, absorbIn: f32,
  spongeX: f32, uRef: f32, arrowCells: f32, flags: u32,
  bg: vec4f, body: vec4f, edge: vec4f, zone: vec4f,
  plain: vec4f, arrow: vec4f,
  dye: array<vec4f, 4>,
  rBase: vec4f, l1dir: vec4f, l1col: vec4f, l2dir: vec4f, l2col: vec4f,
  rParams: vec4f,
};
@group(0) @binding(0) var<storage, read> scalar: array<f32>;
@group(0) @binding(1) var<uniform> Vw: View;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
@group(0) @binding(5) var<storage, read> lut: array<vec4f, 256>;
@group(0) @binding(6) var<storage, read> mac: array<vec4f>;
@group(0) @binding(7) var<storage, read> dye: array<vec4f>;
@group(0) @binding(8) var trail: texture_2d<f32>;
@group(0) @binding(9) var<storage, read> rheo: array<vec4f>;
${it}
${nt}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn cellIndex(c: vec2f) -> vec4u {
  let nx = u32(Vw.nxf);
  let n = nx * u32(Vw.nyf);
  let i = u32(c.x);
  let j = u32(c.y);
  let k = i + j * nx;
  return vec4u(k, min(k + 1u, n - 1u), min(k + nx, n - 1u), min(k + nx + 1u, n - 1u));
}
fn clampCell(l: vec2f) -> vec2f { return clamp(l, vec2f(0.0), vec2f(Vw.nxf - 1.001, Vw.nyf - 1.001)); }

fn sampleScalar(l: vec2f) -> f32 {
  let c = clampCell(l);
  let k = cellIndex(c);
  let f = fract(c);
  return mix(mix(scalar[k.x], scalar[k.y], f.x), mix(scalar[k.z], scalar[k.w], f.x), f.y);
}
fn sampleMac(l: vec2f) -> vec4f {
  let c = clampCell(l);
  let k = cellIndex(c);
  let f = fract(c);
  return mix(mix(mac[k.x], mac[k.y], f.x), mix(mac[k.z], mac[k.w], f.x), f.y);
}
fn sampleDye(l: vec2f) -> vec4f {
  let c = clampCell(l);
  let k = cellIndex(c);
  let f = fract(c);
  return mix(mix(dye[k.x], dye[k.y], f.x), mix(dye[k.z], dye[k.w], f.x), f.y);
}

/**
 * The flakes' colour at l: two lights low over the tank, the eye straight above. Each
 * light gives a two-sided diffuse term sqrt(lᵀQl) (its strength in the light's alpha) and
 * a glint (hᵀQh)^k (rParams: k, the two sparkle layers' weights, glint strength), the
 * glint lit up where the carried sparkle noise is high.
 */
fn rheoColor(l: vec2f) -> vec3f {
  let c = clampCell(l);
  let k = cellIndex(c);
  let f = fract(c);
  let a = mix(mix(rheo[2u * k.x], rheo[2u * k.y], f.x), mix(rheo[2u * k.z], rheo[2u * k.w], f.x), f.y);
  let b = mix(mix(rheo[2u * k.x + 1u], rheo[2u * k.y + 1u], f.x), mix(rheo[2u * k.z + 1u], rheo[2u * k.w + 1u], f.x), f.y);
  let Q = mat3x3f(vec3f(a.x, a.w, b.x), vec3f(a.w, a.y, b.y), vec3f(b.x, b.y, a.z));
  let eye = vec3f(0.0, 0.0, 1.0);
  let sparkle = Vw.rParams.y * b.z + Vw.rParams.z * b.w;
  let glitter = 0.35 + 2.4 * smoothstep(0.62, 1.0, sparkle);
  var col = Vw.rBase.rgb;
  for (var i = 0u; i < 2u; i++) {
    let ld = normalize(select(Vw.l2dir.xyz, Vw.l1dir.xyz, i == 0u));
    let lc = select(Vw.l2col, Vw.l1col, i == 0u);
    let dif = sqrt(max(dot(ld, Q * ld), 0.0));
    let hv = normalize(ld + eye);
    let gl = pow(clamp(dot(hv, Q * hv), 0.0, 1.0), Vw.rParams.x);
    col += lc.rgb * (lc.a * dif + Vw.rParams.w * gl * glitter);
  }
  return col;
}

/** Coverage (0..1) of the velocity arrow of the grid cell around l. */
fn arrowCover(l: vec2f) -> f32 {
  let G = Vw.arrowCells;
  let c = (floor(l / G) + 0.5) * G;
  if (c.x < 0.0 || c.y < 0.0 || c.x > Vw.nxf - 1.0 || c.y > Vw.nyf - 1.0) { return 0.0; }
  let m = sampleMac(c);
  if (m.w > 0.25) { return 0.0; }
  let sp = length(m.xy);
  if (sp < Vw.uRef * 0.02) { return 0.0; }
  let L = clamp(sp / Vw.uRef, 0.05, 2.0) * 0.42 * G;
  let d = m.xy / sp;
  let r = l - c;
  let along = dot(r, d) + L * 0.5;
  let across = abs(dot(r, vec2f(-d.y, d.x)));
  let px = Vw.scale;
  let head = min(L * 0.4, 7.0 * px);
  var dist = 1e9;
  if (along >= 0.0 && along <= L - head) { dist = across - 0.6 * px; }
  if (along > L - head && along <= L) {
    let half = (L - along) / head * head * 0.45;
    dist = min(dist, across - half);
  }
  return clamp(0.5 - dist / px, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let l = vec2f(Vw.ox + pos.x * Vw.scale, Vw.oy - pos.y * Vw.scale);
  if (l.x < -0.5 || l.y < -0.5 || l.x > Vw.nxf - 0.5 || l.y > Vw.nyf - 0.5) { return Vw.bg; }
  var col: vec3f;
  if ((Vw.flags & 16u) != 0u) {
    col = rheoColor(l);
  } else if ((Vw.flags & 1u) != 0u) {
    col = Vw.plain.rgb;
  } else {
    let s = sampleScalar(l);
    let t = clamp((s - Vw.lo) / max(1e-12, Vw.hi - Vw.lo), 0.0, 1.0);
    col = lut[u32(t * 255.0 + 0.5)].rgb;
  }
  if (l.x < Vw.absorbIn || l.x > Vw.spongeX) { col = mix(col, Vw.zone.rgb, Vw.zone.a); }
  if ((Vw.flags & 4u) != 0u) {
    let d = sampleDye(l);
    for (var c = 0u; c < 4u; c++) { col = mix(col, Vw.dye[c].rgb, clamp(d[c], 0.0, 1.0) * Vw.dye[c].a); }
  }
  if ((Vw.flags & 8u) != 0u) {
    let t = textureLoad(trail, vec2i(pos.xy), 0);
    col = col * (1.0 - clamp(t.a, 0.0, 1.0)) + t.rgb;
  }
  if ((Vw.flags & 2u) != 0u) {
    col = mix(col, Vw.arrow.rgb, arrowCover(l) * Vw.arrow.a);
  }
  var bp: array<vec4f, ${W}>;
  let near = poses(l, 1.0, &bp);
  if (near != 0u) {
    let h = sdfAt(l, near, &bp);
    let px = h.d / Vw.scale;
    let fill = clamp(0.5 - px, 0.0, 1.0);
    let edge = clamp(1.0 - abs(px + 0.5) / 1.0, 0.0, 1.0);
    col = mix(col, Vw.body.rgb, fill);
    col = mix(col, Vw.edge.rgb, edge * 0.85);
  }
  return vec4f(col, 1.0);
}
`}function rn(){return[{label:"step",code:as()},{label:"macro",code:rs()},{label:"field",code:os()},{label:"render",code:ls()}]}function cs(n){return n==="inferno"?Qs:Ts(n)}class on{device;ctx;format;pipe;viewBuf;lutBuf;lutName="";dummyBuf;dummyTex;constructor(e,s){this.device=e;const t=s.getContext("webgpu");if(!t)throw new Error("The canvas has no WebGPU context.");this.ctx=t,this.format=navigator.gpu.getPreferredCanvasFormat(),t.configure({device:e,format:this.format,alphaMode:"opaque"});const a=e.createShaderModule({code:ls(),label:"tunnel render"});this.pipe=e.createRenderPipeline({layout:"auto",vertex:{module:a,entryPoint:"vs"},fragment:{module:a,entryPoint:"fs",targets:[{format:this.format}]},primitive:{topology:"triangle-list"}}),this.viewBuf=e.createBuffer({size:304,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.lutBuf=e.createBuffer({size:256*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.dummyBuf=e.createBuffer({size:64,usage:GPUBufferUsage.STORAGE}),this.dummyTex=e.createTexture({size:[1,1],format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING})}setColormap(e){if(e===this.lutName)return;const s=cs(e),t=s.length/3,a=new Float32Array(256*4);for(let i=0;i<256;i++){const r=Math.min(t-1,Math.round(i/255*(t-1)));a[4*i]=s[3*r]/255,a[4*i+1]=s[3*r+1]/255,a[4*i+2]=s[3*r+2]/255,a[4*i+3]=1}this.device.queue.writeBuffer(this.lutBuf,0,a),this.lutName=e}get lut(){return this.lutBuf}get dummies(){return{scalar:this.dummyBuf,lut:this.lutBuf}}get size(){const e=this.ctx.getCurrentTexture();return{w:e.width,h:e.height}}encode(e,s,t,a,i,r,c){const o=s.buffers,l=this.device.createBindGroup({layout:this.pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:o.scalar}},{binding:1,resource:{buffer:this.viewBuf}},{binding:2,resource:{buffer:o.params}},{binding:3,resource:{buffer:o.bodies}},{binding:4,resource:{buffer:o.sdf}},{binding:5,resource:{buffer:this.lutBuf}},{binding:6,resource:{buffer:s.macroBuf}},{binding:7,resource:{buffer:r.dye??this.dummyBuf}},{binding:8,resource:(r.trail??this.dummyTex).createView()},{binding:9,resource:{buffer:r.rheo?.field??this.dummyBuf}}]}),d=(r.plain?1:0)|(r.arrows?2:0)|(r.dye?4:0)|(r.trail?8:0)|(r.rheo?16:0),u=new ArrayBuffer(304),h=new Float32Array(u),f=new Uint32Array(u);h.set([t.scale,t.ox,t.oy,a.lo,a.hi,s.nx,s.ny,s.absorbInX,s.spongeX,r.uRef,r.arrowCells]),f[11]=d,h.set([...i.bg,1],12),h.set([...i.body,1],16),h.set([...i.edge,1],20),h.set(i.zone,24),h.set([...i.plain,1],28),h.set(i.arrow,32);for(let p=0;p<4;p++)h.set(r.dyeColors[p]??[0,0,0,0],36+4*p);if(r.rheo){const p=r.rheo.look;h.set([...p.base,1],52),h.set([...p.l1.dir,0],56),h.set([...p.l1.color,p.l1.diffuse],60),h.set([...p.l2.dir,0],64),h.set([...p.l2.color,p.l2.diffuse],68),h.set([p.sharp,r.rheo.sparkle[0],r.rheo.sparkle[1],p.glint],72)}this.device.queue.writeBuffer(this.viewBuf,0,u);const x=e.beginRenderPass({colorAttachments:[{view:this.ctx.getCurrentTexture().createView(),loadOp:"clear",storeOp:"store",clearValue:{r:i.bg[0],g:i.bg[1],b:i.bg[2],a:1}}]});x.setPipeline(this.pipe),x.setBindGroup(0,l),x.draw(3),c?.(x),x.end()}destroy(){this.viewBuf.destroy(),this.lutBuf.destroy(),this.dummyBuf.destroy(),this.dummyTex.destroy(),this.ctx.unconfigure()}}const Lt=256*1024,ln=80,vt=10,wt=1e3;class ne extends Error{}function cn(n){const e=n.trim().split(/[\s,;]+/).filter(Boolean),s=[];for(const t of e){const a=Number(t.replace(/[Dd]/,"e"));if(t===""||Number.isNaN(a))return null;s.push(a)}return s}function dt(n){return n.replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,ln)}const kt=(n,e)=>n.flatMap((s,t)=>[s,e[t]]);function dn(n,e=""){if(new TextEncoder().encode(n).length>Lt)throw new ne(`The file is larger than ${Lt/1024} KB; an airfoil file is a few KB.`);const s=n.replace(/^﻿/,"").split(/\r\n|\r|\n/);let t="";const a=[];let i=!1;if(s.forEach((u,h)=>{const f=h+1,x=u.trim();if(!x||x.startsWith("#"))return;const p=cn(x);if(!i&&!t&&(p===null||p.length!==2)){t=dt(x);return}if(p===null)throw new ne(`Line ${f}: expected two numbers (x and y), found “${dt(x).slice(0,40)}”.`);if(p.length!==2)throw new ne(`Line ${f}: expected two numbers (x and y), found ${p.length}.`);if(!p.every(Number.isFinite))throw new ne(`Line ${f}: the numbers must be finite.`);a.push([f,p[0],p[1]]),i=!0}),!t){const u=String(e||"").replace(/\\/g,"/").split("/").pop()?.replace(/\.[A-Za-z0-9]{1,4}$/,"")??"";t=dt(u)||"Imported airfoil"}if(!a.length)throw new ne("The file has no coordinates.");const r=[],c=a[0];let o,l,d;return c[1]>=2&&c[2]>=2&&Number.isInteger(c[1])&&Number.isInteger(c[2])?([o,l]=un(a,c[1],c[2]),d="lednicer",r.push("Read as a Lednicer file (upper and lower surfaces apart) and joined in Selig order.")):(o=a.map(u=>u[1]),l=a.map(u=>u[2]),d="selig"),[o,l]=hn(o,l,r),{name:t,x:o,y:l,layout:d,warnings:r}}function un(n,e,s){const t=n.slice(1);if(t.length!==e+s)throw new ne(`Line ${n[0][0]}: the file says ${e} upper and ${s} lower points, but it has ${t.length} points.`);const a=t.slice(0,e),i=t.slice(e),r=a.map(d=>d[1]).reverse(),c=a.map(d=>d[2]).reverse();let o=i.map(d=>d[1]),l=i.map(d=>d[2]);return i.length&&a.length&&Math.abs(i[0][1]-a[0][1])<=1e-9&&Math.abs(i[0][2]-a[0][2])<=1e-9&&(o=o.slice(1),l=l.slice(1)),[[...r,...o],[...c,...l]]}function hn(n,e,s){let t=[n[0]],a=[e[0]],i=0;for(let f=1;f<n.length;f++){if(Math.abs(n[f]-t[t.length-1])<=1e-12&&Math.abs(e[f]-a[a.length-1])<=1e-12){i++;continue}t.push(n[f]),a.push(e[f])}if(i&&s.push(`Removed ${i} repeated point${i!==1?"s":""}.`),t.length<vt)throw new ne(`The file has ${t.length} points; an airfoil needs at least ${vt}.`);if(t.length>wt)throw new ne(`The file has ${t.length} points; at most ${wt} are read.`);const r=Math.min(...t),o=Math.max(...t)-r;if(o<=0)throw new ne("Every point has the same x: this is not an airfoil.");const l=t.indexOf(r);if(l===0||l===t.length-1)throw new ne("The points must start at the trailing edge, run over one surface to the leading edge and back along the other (Selig order).");if(Math.min(t[0],t[t.length-1])<r+.5*o)throw new ne("The first and last points must be at the trailing edge (Selig order).");const d=t[l],u=a[l],h=Math.min(...t.map((f,x)=>Math.hypot(f,a[x])))<=.002;if((Math.abs(o-1)>.001||!h)&&(t=t.map(f=>(f-d)/o),a=a.map(f=>(f-u)/o),s.push(Math.abs(o-1)>.001?`Scaled to chord 1 (it was ${Number(o.toPrecision(6))}).`:"Moved so that the leading edge is at (0, 0).")),ts(kt(t,a))<0&&(t=t.reverse(),a=a.reverse(),s.push("The points ran over the lower surface first; reversed to Selig order (upper surface first).")),Xs(kt(t,a)))throw new ne("The outline crosses itself.");if(fn(t,a)<.002)throw new ne("The section is thinner than 0.2 % of its chord.");return[t,a]}function fn(n,e){const s=kt(n,e);let t=0;for(let a=1;a<50;a++){const i=a/50,r=[],c=s.length/2;for(let o=0;o<c;o++){const l=(o+1)%c,[d,u,h,f]=[s[2*o],s[2*o+1],s[2*l],s[2*l+1]];d>i!=h>i&&r.push(u+(i-d)*(f-u)/(h-d))}r.length>=2&&(t=Math.max(t,Math.max(...r)-Math.min(...r)))}return t}const Xe=3,qe={air:{label:"Air (20 °C)",nu:1516e-8,rho:1.204},water:{label:"Water (20 °C)",nu:1004e-9,rho:998.2}},L={length:[.01,1e3],height:[.005,1e3],speed:[1e-4,340],maxBodies:8,maxRakes:8,maxDyeRakes:4,emitters:[1,64]},et=6;let Ee=0;function Tt(){return Ee=(Ee+1)%1e6,`b${Date.now().toString(36)}${Ee.toString(36)}`}function ds(){return Ee=(Ee+1)%1e6,`r${Date.now().toString(36)}${Ee.toString(36)}`}function je(){return{version:Xe,tunnel:{length:8,height:4,walls:"farfield",resolution:"auto"},flow:{speed:10,fluid:"air",model:"auto"},bodies:[{id:Tt(),name:"NACA 2412",shape:{kind:"naca",code:"2412",chord:1},x:2.5,y:2,angle:6,spin:0,enabled:!0,locked:!1}],rakes:[],view:{field:"particles",autoRange:!0,min:-10,max:10,speed:"max",tracers:!1,density:"normal",trail:"short",arrows:!1,streamlines:!1,rheoPreset:"kalliroscope",particleColor:"speed"}}}const pn=1e5;function It(n){if(n.flow.model!=="auto")return n.flow.model==="sa"?"sa":"off";const e=qe[n.flow.fluid].nu;return Math.max(0,...n.bodies.filter(t=>t.enabled).map(t=>n.flow.speed*Ae(t.shape)/e))>=pn?"sa":"off"}class tt extends Error{}const I=(n,e,s=-1/0,t=1/0)=>{const a=Number(n);if(!Number.isFinite(a)||a<s||a>t)throw new tt(`${e} must be a number from ${s} to ${t}.`);return a},le=(n,e,s)=>e.includes(n)?n:s;function mn(n){const e=n??{};switch(e.kind){case"naca":return{kind:"naca",code:St(String(e.code)),chord:I(e.chord,"Chord",1e-4,1e3)};case"dat":{const s=Array.isArray(e.x)?e.x.map(Number):[],t=Array.isArray(e.y)?e.y.map(Number):[];if(s.length!==t.length||s.length<vt||s.length>wt||![...s,...t].every(Number.isFinite))throw new tt("An imported airfoil needs matching x and y lists of finite numbers.");return{kind:"dat",name:String(e.name??"Imported airfoil").slice(0,80),x:s,y:t,chord:I(e.chord,"Chord",1e-4,1e3)}}case"circle":return{kind:"circle",diameter:I(e.diameter,"Diameter",1e-4,1e3)};case"rect":return{kind:"rect",width:I(e.width,"Width",1e-4,1e3),height:I(e.height,"Height",1e-4,1e3)};case"ellipse":return{kind:"ellipse",width:I(e.width,"Width",1e-4,1e3),height:I(e.height,"Height",1e-4,1e3)};case"plate":return{kind:"plate",length:I(e.length,"Length",1e-4,1e3),thickness:I(e.thickness,"Thickness",1e-5,1e3)};default:throw new tt(`Unknown body shape “${String(e.kind)}”.`)}}function yn(n){const e=n??{},s=Number(e.version??Xe);if(s>Xe)throw new tt(`This tunnel was saved by a newer version of the plugin (scene version ${s}).`);const t=je(),a=e.tunnel??{},i=e.flow??{},r=e.view??{},c=(Array.isArray(e.bodies)?e.bodies:[]).slice(0,L.maxBodies).map(l=>({id:typeof l?.id=="string"&&l.id?l.id.slice(0,40):Tt(),name:String(l?.name??"Body").slice(0,80),shape:mn(l?.shape),x:I(l?.x,"Body x"),y:I(l?.y,"Body y"),angle:I(l?.angle??0,"Body angle",-3600,3600),spin:I(l?.spin??0,"Body spin",-1e4,1e4),enabled:l?.enabled!==!1,locked:l?.locked===!0})),o=(Array.isArray(e.rakes)?e.rakes:[]).slice(0,L.maxRakes).map((l,d)=>({id:typeof l?.id=="string"&&l.id?l.id.slice(0,40):ds(),kind:le(l?.kind,["streaks","timelines","dye"],"streaks"),x0:I(l?.x0,"Rake x"),y0:I(l?.y0,"Rake y"),x1:I(l?.x1,"Rake x"),y1:I(l?.y1,"Rake y"),emitters:Math.round(I(l?.emitters??12,"Rake emitters",...L.emitters)),color:Math.round(I(l?.color??d%et,"Rake colour",0,et-1)),enabled:l?.enabled!==!1}));return{version:Xe,tunnel:{length:I(a.length??t.tunnel.length,"Tunnel length",...L.length),height:I(a.height??t.tunnel.height,"Tunnel height",...L.height),walls:le(a.walls,["farfield","slip","noslip","periodic"],t.tunnel.walls),resolution:le(a.resolution,["auto","low","medium","high","ultra"],t.tunnel.resolution)},flow:{speed:I(i.speed??t.flow.speed,"Wind speed",...L.speed),fluid:le(i.fluid,["air","water"],t.flow.fluid),model:le(i.model,["auto","resolved","sa"],t.flow.model)},bodies:c,rakes:o,view:{field:le(r.field,["particles","vorticity","speed","pressure","schlieren","rheoscopic","none"],t.view.field),autoRange:r.autoRange!==!1,min:Number.isFinite(Number(r.min))?Number(r.min):t.view.min,max:Number.isFinite(Number(r.max))?Number(r.max):t.view.max,speed:le(r.speed,["max","realtime"],t.view.speed),tracers:r.tracers===!0,density:le(r.density,["low","normal","high"],t.view.density),trail:le(r.trail,["off","short","long"],t.view.trail),arrows:r.arrows===!0,streamlines:r.streamlines===!0,rheoPreset:le(r.rheoPreset,["kalliroscope","pearl","copper"],t.view.rheoPreset),particleColor:le(r.particleColor,["speed","vorticity"],t.view.particleColor)}}}const gn=3,xn=48,Ot=2.5,_t=`
struct G { nx: u32, ny: u32, dt: f32, sign: f32, nsrc: u32, r: f32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<uniform> Gd: G;
`,us=`
fn idx(i: i32, j: i32) -> u32 { return u32(clamp(i, 0, i32(Gd.nx) - 1)) + u32(clamp(j, 0, i32(Gd.ny) - 1)) * Gd.nx; }
fn bil(c: vec2f) -> vec4f {
  let p = clamp(c, vec2f(0.0), vec2f(f32(Gd.nx) - 1.001, f32(Gd.ny) - 1.001));
  let i = i32(p.x);
  let j = i32(p.y);
  let f = p - vec2f(f32(i), f32(j));
  return mix(mix(src[idx(i, j)], src[idx(i + 1, j)], f.x), mix(src[idx(i, j + 1)], src[idx(i + 1, j + 1)], f.x), f.y);
}
`,hs=()=>`${_t}
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec4f>;
${us}
@compute @workgroup_size(${K})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${K}u;
  if (k >= Gd.nx * Gd.ny) { return; }
  let m = mac[k];
  if (m.w > 0.5) { dst[k] = vec4f(0.0); return; }
  let p = vec2f(f32(k % Gd.nx), f32(k / Gd.nx));
  dst[k] = bil(p - Gd.sign * Gd.dt * m.xy);
}
`,fs=()=>`${_t}
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read> fwd: array<vec4f>;
@group(0) @binding(4) var<storage, read> back: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> dst: array<vec4f>;
${us}
@compute @workgroup_size(${K})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${K}u;
  if (k >= Gd.nx * Gd.ny) { return; }
  let m = mac[k];
  if (m.w > 0.5) { dst[k] = vec4f(0.0); return; }
  let p = vec2f(f32(k % Gd.nx), f32(k / Gd.nx)) - Gd.dt * m.xy;
  let q = clamp(p, vec2f(0.0), vec2f(f32(Gd.nx) - 1.001, f32(Gd.ny) - 1.001));
  let i = i32(q.x);
  let j = i32(q.y);
  let a = src[idx(i, j)];
  let b = src[idx(i + 1, j)];
  let c = src[idx(i, j + 1)];
  let d = src[idx(i + 1, j + 1)];
  let lo = min(min(a, b), min(c, d));
  let hi = max(max(a, b), max(c, d));
  dst[k] = clamp(fwd[k] + 0.5 * (src[k] - back[k]), lo, hi);
}
`,ps=()=>`${_t}
struct Src { x: f32, y: f32, ch: u32, pad: u32 };
@group(0) @binding(2) var<storage, read> srcs: array<Src>;
@group(0) @binding(3) var<storage, read_write> dye: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let side = 2u * u32(ceil(Gd.r)) + 1u;
  let per = side * side;
  let s = gid.x / per;
  if (s >= Gd.nsrc) { return; }
  let o = gid.x % per;
  let sc = srcs[s];
  let ci = i32(round(sc.x)) - i32(side / 2u) + i32(o % side);
  let cj = i32(round(sc.y)) - i32(side / 2u) + i32(o / side);
  if (ci < 0 || cj < 0 || ci >= i32(Gd.nx) || cj >= i32(Gd.ny)) { return; }
  let dd = distance(vec2f(f32(ci), f32(cj)), vec2f(sc.x, sc.y));
  if (dd > Gd.r) { return; }
  let k = u32(ci) + u32(cj) * Gd.nx;
  if (mac[k].w > 0.5) { return; }
  var v = dye[k];
  let w = clamp(1.0 - dd / Gd.r, 0.0, 1.0) * 0.5 + 0.5;
  v[sc.ch] = max(v[sc.ch], w);
  dye[k] = v;
}
`;class bn{device;nx;ny;bufs;cur=0;advect;correct;inject;unis=[];srcBuf;srcCount=0;srcKey="";constructor(e,s,t){this.device=e,this.nx=s,this.ny=t;const a=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.bufs=[0,1,2,3].map(()=>e.createBuffer({size:s*t*16,usage:a}));const i=(r,c)=>e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:r,label:c}),entryPoint:"main"}});this.advect=i(hs(),"dye advect"),this.correct=i(fs(),"dye correct"),this.inject=i(ps(),"dye inject"),this.srcBuf=e.createBuffer({size:16*512,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.unis=[0,1].map(()=>e.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}))}get field(){return this.bufs[this.cur]}setSources(e){const s=e.map(r=>`${r.x.toFixed(2)},${r.y.toFixed(2)},${r.channel}`).join("|");if(s===this.srcKey)return;this.srcKey=s;const t=new ArrayBuffer(16*Math.min(512,e.length)),a=new Float32Array(t),i=new Uint32Array(t);e.slice(0,512).forEach((r,c)=>{a[4*c]=r.x,a[4*c+1]=r.y,i[4*c+2]=r.channel}),t.byteLength&&this.device.queue.writeBuffer(this.srcBuf,0,t),this.srcCount=Math.min(512,e.length)}clear(){for(const e of this.bufs)this.device.queue.writeBuffer(e,0,new Float32Array(this.nx*this.ny*4))}uniform(e,s,t){const a=new ArrayBuffer(32),i=new Uint32Array(a),r=new Float32Array(a);i[0]=this.nx,i[1]=this.ny,r[2]=s,r[3]=t,i[4]=this.srcCount,r[5]=Ot;const c=this.unis[e];return this.device.queue.writeBuffer(c,0,a),c}encode(e,s,t){if(s<=0||this.srcCount===0)return;const a=Math.min(xn,Math.max(1,Math.ceil(s*.1/gn))),i=s/a,r=this.uniform(0,i,1),c=this.uniform(1,i,-1),o=this.nx*this.ny,l=Math.ceil(o/K),d=Math.min(l,32768),u=Math.ceil(l/d),h=(p,w,b)=>this.device.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:w}},...b.map((A,M)=>({binding:2+M,resource:{buffer:A}}))]}),f=2*Math.ceil(Ot)+1,x=e.beginComputePass({label:"dye"});for(let p=0;p<a;p++){const w=this.bufs[this.cur],[b,A,M]=[1,2,3].map(g=>this.bufs[(this.cur+g)%4]);x.setPipeline(this.advect),x.setBindGroup(0,h(this.advect,r,[w,b])),x.dispatchWorkgroups(d,u),x.setBindGroup(0,h(this.advect,c,[b,A])),x.dispatchWorkgroups(d,u),x.setPipeline(this.correct),x.setBindGroup(0,h(this.correct,r,[w,b,A,M])),x.dispatchWorkgroups(d,u),x.setPipeline(this.inject),x.setBindGroup(0,h(this.inject,r,[this.srcBuf,M])),x.dispatchWorkgroups(Math.ceil(this.srcCount*f*f/64)),this.cur=(this.cur+3)%4}x.end()}async read(){const e=this.device.createBuffer({size:this.nx*this.ny*16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),s=this.device.createCommandEncoder();s.copyBufferToBuffer(this.field,0,e,0,this.nx*this.ny*16),this.device.queue.submit([s.finish()]),await e.mapAsync(GPUMapMode.READ);const t=new Float32Array(e.getMappedRange().slice(0));return e.destroy(),t}destroy(){for(const e of[...this.bufs,this.srcBuf,...this.unis])e.destroy()}}const vn=.8,wn=.12,kn=160,se=8,ut=1.4,Mn=320,ht=14,ms=()=>`
struct A {
  count: u32, substeps: u32, dt: f32, seed: u32,
  nx: f32, ny: f32, outX: f32, respawnX0: f32,
  respawnW: f32, maxAge: f32, wrapY: u32, pad: u32,
};
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> pmeta: array<vec4f>;
@group(0) @binding(3) var<uniform> P: Params;
@group(0) @binding(4) var<storage, read> B: array<Body>;
@group(0) @binding(5) var<storage, read> sdf: array<f32>;
@group(0) @binding(6) var<uniform> Ad: A;
${it}
${nt}

fn hash(u: u32) -> u32 {
  var x = u;
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}
fn rnd(a: u32, b: u32) -> f32 { return f32(hash(a * 1664525u + hash(b)) & 0xffffffu) / 16777216.0; }

fn vel(p: vec2f) -> vec2f {
  let c = clamp(p, vec2f(0.0), vec2f(Ad.nx - 1.001, Ad.ny - 1.001));
  let i = u32(c.x);
  let j = u32(c.y);
  let f = c - vec2f(f32(i), f32(j));
  let nx = u32(Ad.nx);
  let k = i + j * nx;
  return mix(mix(mac[k].xy, mac[k + 1u].xy, f.x), mix(mac[k + nx].xy, mac[k + nx + 1u].xy, f.x), f.y);
}

@compute @workgroup_size(${K})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * ${K}u;
  if (i >= Ad.count) { return; }
  var m = pmeta[i];
  if (m.w < 0.5) { return; }
  var q = pos[i].xy;
  var prev = q;
  var gone = false;
  var bp: array<vec4f, ${W}>;
  for (var s = 0u; s < Ad.substeps; s++) {
    m.x += Ad.dt;
    if (m.x < 0.0) { prev = q; continue; }
    let v1 = vel(q);
    q += Ad.dt * vel(q + 0.5 * Ad.dt * v1);
    if (P.nBodies > 0u) {
      let near = poses(q, f32(s + 1u) / f32(Ad.substeps), &bp);
      if (near != 0u) {
        let h = sdfAt(q, near, &bp);
        if (h.d < 0.35) {
          let e = 0.5;
          let g = vec2f(sdfAt(q + vec2f(e, 0.0), near, &bp).d - sdfAt(q - vec2f(e, 0.0), near, &bp).d,
                        sdfAt(q + vec2f(0.0, e), near, &bp).d - sdfAt(q - vec2f(0.0, e), near, &bp).d);
          let gl = length(g);
          if (gl > 1e-6) { q += (g / gl) * (0.35 - h.d); }
          // Deep inside (where the field is flat, so there is no way out to follow): the
          // particle cannot be put back on the surface; it leaves the flow.
          if (gl <= 1e-6 || sdfAt(q, near, &bp).d < 0.0) { gone = true; break; }
        }
      }
    }
    if (Ad.wrapY == 1u && (q.y < 0.0 || q.y > Ad.ny - 1.0)) {
      q.y = q.y - floor(q.y / (Ad.ny - 1.0)) * (Ad.ny - 1.0);
      prev = q;
    }
    if (q.x < 0.0 || q.x > Ad.outX || q.y < 0.0 || q.y > Ad.ny - 1.0 || q.x != q.x || q.y != q.y) { gone = true; break; }
  }
  if (m.y < 0.0) {
    // Each tracer lives a while of its own (a third to all of maxAge), so they do not all
    // renew at once; then it starts again somewhere at random, which keeps them spread
    // evenly (dead-water zones included). One that leaves the tunnel comes back in with the
    // stream, in the strip the inflow brought in this frame.
    let life = Ad.maxAge * (0.35 + 0.65 * rnd(i, 7u));
    if (gone) {
      q = vec2f(Ad.respawnX0 + rnd(i, Ad.seed) * Ad.respawnW, rnd(i, Ad.seed ^ 0x9e3779b9u) * (Ad.ny - 1.0));
      m.x = 0.0;
      prev = q;
    } else if (m.x > life) {
      // A random spot clear of every body (a few tries; else back in with the stream).
      var placed = false;
      for (var t = 0u; t < 4u && !placed; t++) {
        let c = vec2f(Ad.respawnX0 + rnd(i + t * 7919u, Ad.seed) * (Ad.outX - Ad.respawnX0), rnd(i + t * 7919u, Ad.seed ^ 0x9e3779b9u) * (Ad.ny - 1.0));
        var ok = true;
        if (P.nBodies > 0u) {
          let near = poses(c, 1.0, &bp);
          if (near != 0u) { ok = sdfAt(c, near, &bp).d > 1.0; }
        }
        if (ok) { q = c; placed = true; }
      }
      if (!placed) { q = vec2f(Ad.respawnX0 + rnd(i, Ad.seed) * Ad.respawnW, rnd(i, Ad.seed ^ 0x9e3779b9u) * (Ad.ny - 1.0)); }
      m.x = 0.0;
      prev = q;
    }
  } else if (gone) {
    m.w = 0.0;
  }
  pos[i] = vec4f(q, prev);
  pmeta[i] = m;
}
`,ys=()=>`
struct D {
  scale: f32, ox: f32, oy: f32, w: f32,
  h: f32, halfW: f32, maxSeg: f32, tail: f32,
  tracer: vec4f,
  colors: array<vec4f, ${se}>,
  // byField: 1 when a tracer takes its colour from the field (lo..hi through the colour map).
  lo: f32, hi: f32, byField: f32, nx: f32,
  lift: f32, ny: f32, taper: f32, pad1: f32,
};
@group(0) @binding(0) var<storage, read> pos: array<vec4f>;
@group(0) @binding(1) var<storage, read> pmeta: array<vec4f>;
@group(0) @binding(2) var<uniform> Dr: D;
@group(0) @binding(3) var<storage, read> scalar: array<f32>;
@group(0) @binding(4) var<storage, read> lut: array<vec4f, 256>;

fn fieldColor(p: vec2f) -> vec3f {
  let c = clamp(p, vec2f(0.0), vec2f(Dr.nx - 1.001, Dr.ny - 1.001));
  let nx = u32(Dr.nx);
  let k = u32(c.x) + u32(c.y) * nx;
  let f = fract(c);
  let v = mix(mix(scalar[k], scalar[k + 1u], f.x), mix(scalar[k + nx], scalar[k + nx + 1u], f.x), f.y);
  let t = clamp((v - Dr.lo) / max(1e-12, Dr.hi - Dr.lo), 0.0, 1.0);
  // A shade of the field's own colour: lighter where the map is dark, darker where it is
  // light (so the particles show on every part of every map).
  let base = lut[u32(t * 255.0 + 0.5)].rgb;
  let lum = dot(base, vec3f(0.299, 0.587, 0.114));
  return mix(base, select(vec3f(1.0), vec3f(0.0), lum > 0.62), Dr.lift);
}

// d: across the stroke (-1..1); s: along it, in pixels from the head (0) back; len: tail length.
struct Out { @builtin(position) p: vec4f, @location(0) c: vec4f, @location(1) d: f32, @location(2) s: f32, @location(3) len: f32 };

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var o: Out;
  let m = pmeta[ii];
  if (m.w < 0.5 || m.x < 0.0) { o.p = vec4f(2.0, 2.0, 0.0, 1.0); return o; }
  let q = pos[ii];
  let b = vec2f((q.x - Dr.ox) / Dr.scale, (Dr.oy - q.y) / Dr.scale);
  var a = vec2f((q.z - Dr.ox) / Dr.scale, (Dr.oy - q.w) / Dr.scale);
  if (distance(a, b) > Dr.maxSeg) { a = b; }
  // The tail: back along this frame's motion, at most Dr.tail pixels (0: a dot).
  let back = a - b;
  let bl = length(back);
  a = b + select(vec2f(0.0), back / max(bl, 1e-6) * min(bl * 3.0, Dr.tail), bl > 1e-4);
  var dir = b - a;
  let len = length(dir);
  dir = select(vec2f(1.0, 0.0), dir / max(len, 1e-6), len > 1e-3);
  let nrm = vec2f(-dir.y, dir.x);
  let hw = Dr.halfW;
  // Two triangles around the segment, a little longer than it on each end.
  let corner = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = corner[vi];
  let along = select(a - dir * hw, b + dir * hw, c.x > 0.5);
  let px = along + nrm * hw * c.y;
  o.p = vec4f(px.x / Dr.w * 2.0 - 1.0, 1.0 - px.y / Dr.h * 2.0, 0.0, 1.0);
  o.c = select(Dr.colors[min(u32(m.z), ${se-1}u)], Dr.tracer, m.y < 0.0);
  if (m.y < 0.0 && Dr.byField > 0.5) { o.c = vec4f(fieldColor(q.xy), Dr.tracer.a); }
  o.d = c.y;
  o.len = len;
  o.s = select(len + hw, -hw, c.x > 0.5);
  return o;
}

@fragment
fn fs(i: Out) -> @location(0) vec4f {
  let hw = Dr.halfW;
  let across = abs(i.d) * hw;
  if (Dr.taper < 0.5) {
    // Long trails: an even stroke each frame, so the fading trail builds a smooth line.
    return vec4f(i.c.rgb, i.c.a * clamp(hw - across + 0.5, 0.0, 1.0));
  }
  // A comet: a round head, and a tail that thins and fades back to nothing.
  var r: f32;
  if (i.s <= 0.0) {
    r = length(vec2f(i.s, across));
  } else {
    let t = clamp(i.s / max(i.len, 1e-3), 0.0, 1.0);
    r = across / max(1.0 - 0.75 * t, 0.05);
  }
  let edge = clamp(hw - r + 0.5, 0.0, 1.0);
  let fade = select(1.0, pow(1.0 - clamp(i.s / max(i.len + hw, 1e-3), 0.0, 1.0), 1.6), i.s > 0.0);
  return vec4f(i.c.rgb, i.c.a * edge * fade);
}
`,gs=()=>`
struct D {
  scale: f32, ox: f32, oy: f32, w: f32,
  h: f32, halfW: f32, maxSeg: f32, first: f32,
  colors: array<vec4f, ${se}>,
  gaps: array<vec4f, ${se}>,
};
@group(0) @binding(0) var<storage, read> pos: array<vec4f>;
@group(0) @binding(1) var<storage, read> pmeta: array<vec4f>;
@group(0) @binding(2) var<uniform> Dr: D;
struct Out { @builtin(position) p: vec4f, @location(0) c: vec4f, @location(1) d: f32 };

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var o: Out;
  let i = u32(Dr.first) + ii;
  let ma = pmeta[i];
  let mb = pmeta[i + 1u];
  o.p = vec4f(2.0, 2.0, 0.0, 1.0);
  if (ma.w < 0.5 || mb.w < 0.5 || ma.x < 0.0 || mb.x < 0.0 || ma.y < 0.0 || ma.y != mb.y) { return o; }
  let src = min(u32(ma.y), ${se-1}u);
  if (abs(ma.x - mb.x) > Dr.gaps[src].x) { return o; }
  // Older parts of a streak or timeline fade, as smoke thins out downstream.
  let fade = pow(clamp(1.0 - ma.x / max(Dr.gaps[src].y, 1.0), 0.12, 1.0), 0.8);
  let qa = pos[i];
  let qb = pos[i + 1u];
  let a = vec2f((qa.x - Dr.ox) / Dr.scale, (Dr.oy - qa.y) / Dr.scale);
  let b = vec2f((qb.x - Dr.ox) / Dr.scale, (Dr.oy - qb.y) / Dr.scale);
  let len = distance(a, b);
  if (len > Dr.maxSeg) { return o; }
  var dir = select(vec2f(1.0, 0.0), (b - a) / max(len, 1e-6), len > 1e-4);
  let n = vec2f(-dir.y, dir.x);
  let corner = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = corner[vi];
  let px = select(a - dir * Dr.halfW * 0.5, b + dir * Dr.halfW * 0.5, c.x > 0.5) + n * Dr.halfW * c.y;
  o.p = vec4f(px.x / Dr.w * 2.0 - 1.0, 1.0 - px.y / Dr.h * 2.0, 0.0, 1.0);
  let col = Dr.colors[min(u32(ma.z), ${se-1}u)];
  o.c = vec4f(col.rgb, col.a * fade);
  o.d = c.y;
  return o;
}

@fragment
fn fs(i: Out) -> @location(0) vec4f {
  return vec4f(i.c.rgb, i.c.a * clamp((1.0 - abs(i.d)) * 1.6, 0.0, 1.0));
}
`,xs=`
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f { return vec4f(0.0); }
`;class Pn{device;pos=null;meta=null;capacity=0;tracers=0;rakes=[];layoutKey="";advectPipe;advectUni;drawPipe;fadePipe;drawUni;linePipe=null;lineUni;seed=1;streakGap=1;fadeSteps=1e4;trail=null;trailKey="";clearTrail=!0;format="rgba16float";constructor(e){this.device=e,this.advectPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:ms(),label:"particles advect"}),entryPoint:"main"}}),this.advectUni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});const s=e.createShaderModule({code:ys(),label:"particles draw"}),t={color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}};this.drawPipe=e.createRenderPipeline({layout:"auto",vertex:{module:s,entryPoint:"vs"},fragment:{module:s,entryPoint:"fs",targets:[{format:this.format,blend:t}]},primitive:{topology:"triangle-list"}});const a=e.createShaderModule({code:xs,label:"trail fade"});this.fadePipe=e.createRenderPipeline({layout:"auto",vertex:{module:a,entryPoint:"vs"},fragment:{module:a,entryPoint:"fs",targets:[{format:this.format,blend:{color:{srcFactor:"zero",dstFactor:"constant",operation:"add"},alpha:{srcFactor:"zero",dstFactor:"constant",operation:"add"}}}]},primitive:{topology:"triangle-list"}}),this.drawUni=e.createBuffer({size:80+16*se,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.lineUni=e.createBuffer({size:32+32*se,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}encodeRakeLines(e,s,t,a,i,r){if(!this.pos||!this.meta||!this.rakes.length)return;if(!this.linePipe){const d=this.device.createShaderModule({code:gs(),label:"rake lines"});this.linePipe=this.device.createRenderPipeline({layout:"auto",vertex:{module:d,entryPoint:"vs"},fragment:{module:d,entryPoint:"fs",targets:[{format:s,blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-list"}})}const c=new Float32Array(8+8*se);c.set([a.scale,a.ox,a.oy,t.w,t.h,.75*r,80*r,this.tracers]),i.slice(0,se).forEach((d,u)=>c.set(d,8+4*u));for(const d of this.rakes){const u=8+4*se+4*Math.min(d.index,se-1);c[u]=d.rake.kind==="streaks"?this.streakGap*2.5:.5,c[u+1]=this.fadeSteps}this.device.queue.writeBuffer(this.lineUni,0,c);const o=this.device.createBindGroup({layout:this.linePipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.pos}},{binding:1,resource:{buffer:this.meta}},{binding:2,resource:{buffer:this.lineUni}}]});e.setPipeline(this.linePipe),e.setBindGroup(0,o);const l=this.capacity-this.tracers-1;l>0&&e.draw(6,l)}get count(){return this.capacity}get tracerCount(){return this.tracers}get buffers(){return this.pos&&this.meta?{pos:this.pos,meta:this.meta}:null}get pools(){return this.rakes.map(e=>({id:e.rake.id,index:e.index,base:e.base,slots:e.slots}))}configure(e,s,t){const a=[];let i=e;s.forEach((h,f)=>{const x=h.kind==="streaks"?Math.ceil(t.nx*1.2*ut):Mn,p=h.kind==="streaks"?x*h.emitters:x*ht;a.push({rake:h,index:f,base:i,per:x,slots:p,head:0,acc:0}),i+=p});const r=`${e}|${t.nx}x${t.ny}|${s.map(h=>`${h.id}:${h.kind}:${h.emitters}`).join(",")}`;if(r===this.layoutKey){a.forEach((h,f)=>{this.rakes[f].rake=h.rake});return}this.layoutKey=r,this.rakes=a,this.tracers=e;const c=Math.max(1,i);if(c>this.capacity||!this.pos){this.pos?.destroy(),this.meta?.destroy();const h=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.pos=this.device.createBuffer({size:c*16,usage:h}),this.meta=this.device.createBuffer({size:c*16,usage:h})}this.capacity=c;const o=new Float32Array(c*4),l=new Float32Array(c*4);let d=12345;const u=()=>(d=d*1103515245+12345&2147483647)/2147483647;for(let h=0;h<e;h++){const f=t.absorbInX+u()*(t.outX-t.absorbInX),x=u()*(t.ny-1);o.set([f,x,f,x],4*h),l.set([0,-1,0,1],4*h)}this.device.queue.writeBuffer(this.pos,0,o),this.device.queue.writeBuffer(this.meta,0,l),this.clearTrail=!0}emit(e){if(!(!this.pos||!this.meta||e.steps<=0))for(const s of this.rakes){const{rake:t}=s;if(t.kind==="streaks"){this.streakGap=1/(e.u*ut),this.fadeSteps=.85*e.nx/e.u,s.acc+=e.u*e.steps*ut;const a=Math.min(s.per,Math.floor(s.acc));if(s.acc-=a,a<=0)continue;const i=new Float32Array(a*4),r=new Float32Array(a*4);for(let c=0;c<t.emitters;c++){const o=t.emitters===1?.5:c/(t.emitters-1),l=t.x0+(t.x1-t.x0)*o,d=t.y0+(t.y1-t.y0)*o;for(let u=0;u<a;u++)i.set([l,d,l,d],4*u),r.set([-((u+.5)/a)*e.steps,s.index,t.color,1],4*u);this.writeRing(s.base+c*s.per,s.per,s.head,i,r,a)}s.head=(s.head+a)%s.per}else{const a=e.nx*.1/e.u;for(this.fadeSteps=.85*e.nx/e.u,s.acc+=e.steps;s.acc>=a;){s.acc-=a;const i=-Math.max(0,e.steps-s.acc),r=new Float32Array(s.per*4),c=new Float32Array(s.per*4);for(let l=0;l<s.per;l++){const d=l/(s.per-1),u=t.x0+(t.x1-t.x0)*d,h=t.y0+(t.y1-t.y0)*d;r.set([u,h,u,h],4*l),c.set([i,s.index,t.color,1],4*l)}const o=s.head%ht;this.device.queue.writeBuffer(this.pos,(s.base+o*s.per)*16,r),this.device.queue.writeBuffer(this.meta,(s.base+o*s.per)*16,c),s.head=(s.head+1)%ht}}}}writeRing(e,s,t,a,i,r){const c=Math.min(r,s-t);this.device.queue.writeBuffer(this.pos,(e+t)*16,a,0,c*4),this.device.queue.writeBuffer(this.meta,(e+t)*16,i,0,c*4),r>c&&(this.device.queue.writeBuffer(this.pos,e*16,a,c*4,(r-c)*4),this.device.queue.writeBuffer(this.meta,e*16,i,c*4,(r-c)*4))}encodeAdvect(e,s,t,a){if(!this.pos||!this.meta||s.steps<=0)return;this.emit(s);const i=Math.min(kn,Math.max(1,Math.ceil(s.steps*wn/vn))),r=new ArrayBuffer(48),c=new Uint32Array(r),o=new Float32Array(r);c[0]=this.capacity,c[1]=i,o[2]=s.steps/i,c[3]=this.seed=this.seed*1664525+1013904223>>>0,o[4]=s.nx,o[5]=s.ny,o[6]=s.outX,o[7]=s.absorbInX,o[8]=Math.max(1,s.u*s.steps),o[9]=.35*s.nx/s.u,c[10]=s.wrapY?1:0,this.device.queue.writeBuffer(this.advectUni,0,r);const l=this.device.createBindGroup({layout:this.advectPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:this.pos}},{binding:2,resource:{buffer:this.meta}},{binding:3,resource:{buffer:a.params}},{binding:4,resource:{buffer:a.bodies}},{binding:5,resource:{buffer:a.sdf}},{binding:6,resource:{buffer:this.advectUni}}]}),d=Math.ceil(this.capacity/K),u=Math.min(d,32768),h=e.beginComputePass({label:"particles"});h.setPipeline(this.advectPipe),h.setBindGroup(0,l),h.dispatchWorkgroups(u,Math.ceil(d/u)),h.end()}ensureTrail(e,s,t){const a=`${e}x${s}`;(!this.trail||a!==this.trailKey)&&(this.trail?.destroy(),this.trail=this.device.createTexture({size:[e,s],format:this.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),this.trailKey=a,this.clearTrail=!0),t!==this.lastView&&(this.lastView=t,this.clearTrail=!0)}lastView="";encodeDraw(e,s,t,a,i,r,c,o){const l=`${t.scale.toFixed(9)}|${t.ox.toFixed(4)}|${t.oy.toFixed(4)}`;this.ensureTrail(s.w,s.h,l);const d=this.trail.createView(),u=e.beginRenderPass({colorAttachments:[{view:d,loadOp:this.clearTrail?"clear":"load",storeOp:"store",clearValue:{r:0,g:0,b:0,a:0}}]});if(this.clearTrail=!1,u.setPipeline(this.fadePipe),u.setBlendConstant({r:a,g:a,b:a,a}),u.draw(3),this.pos&&this.meta&&i.tracers&&this.tracers>0){const h=new Float32Array(20+4*se);h.set([t.scale,t.ox,t.oy,s.w,s.h,s.dot,60,s.tail]),h.set(r.tracer,8);const f=12+4*se;h.set([c?.lo??0,c?.hi??1,c?1:0,c?.nx??1,c?.lift??0,c?.ny??1,s.taper?1:0,0],f),this.device.queue.writeBuffer(this.drawUni,0,h);const x=this.device.createBindGroup({layout:this.drawPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.pos}},{binding:1,resource:{buffer:this.meta}},{binding:2,resource:{buffer:this.drawUni}},{binding:3,resource:{buffer:c?.scalar??o.scalar}},{binding:4,resource:{buffer:c?.lut??o.lut}}]});u.setPipeline(this.drawPipe),u.setBindGroup(0,x),u.draw(6,this.tracers)}u.end()}async read(){if(!this.pos||!this.meta)return null;const e=this.capacity*16,s=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),t=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),a=this.device.createCommandEncoder();a.copyBufferToBuffer(this.pos,0,s,0,e),a.copyBufferToBuffer(this.meta,0,t,0,e),this.device.queue.submit([a.finish()]),await Promise.all([s.mapAsync(GPUMapMode.READ),t.mapAsync(GPUMapMode.READ)]);const i={pos:new Float32Array(s.getMappedRange().slice(0)),meta:new Float32Array(t.getMappedRange().slice(0))};return s.destroy(),t.destroy(),i}clear(){this.clearTrail=!0,this.layoutKey=""}destroy(){this.pos?.destroy(),this.meta?.destroy(),this.trail?.destroy(),this.advectUni.destroy(),this.drawUni.destroy(),this.lineUni.destroy()}}const ft=96,An=.25,Sn=24,bs=()=>`
struct R {
  nx: u32, ny: u32, frame: u32, seed: u32,
  dt: f32, kappa: f32, relax: f32, inletX: f32,
  period: u32, pad0: u32, pad1: u32, pad2: u32,
};
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<storage, read> qin: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> qout: array<vec4f>;
@group(0) @binding(3) var<uniform> Rp: R;

fn hash(u: u32) -> u32 {
  var x = u;
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}
fn rnd(a: u32, b: u32) -> f32 { return f32(hash(a * 1664525u + hash(b)) & 0xffffffu) / 16777216.0; }

fn cid(i: i32, j: i32) -> u32 { return u32(clamp(i, 0, i32(Rp.nx) - 1)) + u32(clamp(j, 0, i32(Rp.ny) - 1)) * Rp.nx; }
fn u2(i: i32, j: i32) -> vec2f { return mac[cid(i, j)].xy; }

/** Bilinear sample of the two vec4s of cell data (2 per cell) at p. */
fn sampleQ(p: vec2f) -> array<vec4f, 2> {
  let c = clamp(p, vec2f(0.0), vec2f(f32(Rp.nx) - 1.001, f32(Rp.ny) - 1.001));
  let i = i32(c.x);
  let j = i32(c.y);
  let f = c - vec2f(f32(i), f32(j));
  let a = cid(i, j); let b = cid(i + 1, j); let d = cid(i, j + 1); let e = cid(i + 1, j + 1);
  let q0 = mix(mix(qin[2u * a], qin[2u * b], f.x), mix(qin[2u * d], qin[2u * e], f.x), f.y);
  let q1 = mix(mix(qin[2u * a + 1u], qin[2u * b + 1u], f.x), mix(qin[2u * d + 1u], qin[2u * e + 1u], f.x), f.y);
  return array<vec4f, 2>(q0, q1);
}

@compute @workgroup_size(${K})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${K}u;
  if (k >= Rp.nx * Rp.ny) { return; }
  let i = i32(k % Rp.nx);
  let j = i32(k / Rp.nx);
  let m = mac[k];
  // Sparkle layers: each is renewed (fresh noise) once a period, half a period apart.
  let ph = Rp.frame % Rp.period;
  let renew1 = ph == 0u;
  let renew2 = ph == Rp.period / 2u;
  if (m.w > 0.5 || f32(i) < Rp.inletX) {
    // Inside a body, or coming in at the inlet: random flakes.
    qout[2u * k] = vec4f(1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0, 0.0);
    qout[2u * k + 1u] = vec4f(0.0, 0.0, rnd(k, Rp.seed), rnd(k, Rp.seed ^ 0x51ed27u));
    return;
  }
  // Carried by the flow (semi-Lagrangian, from where this fluid was a frame ago).
  let s = sampleQ(vec2f(f32(i), f32(j)) - Rp.dt * m.xy);
  var xx = s[0].x; var yy = s[0].y; var zz = s[0].z; var xy = s[0].w;
  var xz = s[1].x; var yz = s[1].y;
  var n1 = s[1].z; var n2 = s[1].w;
  if (renew1) { n1 = rnd(k, Rp.seed); }
  if (renew2) { n2 = rnd(k, Rp.seed ^ 0x51ed27u); }

  // The velocity gradient (per step), in plane and across the depth.
  let dudx = 0.5 * (u2(i + 1, j).x - u2(i - 1, j).x);
  let dudy = 0.5 * (u2(i, j + 1).x - u2(i, j - 1).x);
  let dvdx = 0.5 * (u2(i + 1, j).y - u2(i - 1, j).y);
  let dvdy = 0.5 * (u2(i, j + 1).y - u2(i, j - 1).y);
  let dudz = Rp.kappa * m.x;
  let dvdz = Rp.kappa * m.y;
  // L = [[dudx, dudy, dudz], [dvdx, dvdy, dvdz], [0, 0, 0]] (no vertical velocity).
  let rate = abs(dudx) + abs(dudy) + abs(dvdx) + abs(dvdy) + abs(dudz) + abs(dvdz);
  let sub = u32(clamp(ceil(rate * Rp.dt / ${An}), 1.0, ${Sn}.0));
  let h = Rp.dt / f32(sub);
  let rlx = 1.0 - exp(-Rp.relax * h);
  for (var q = 0u; q < sub; q++) {
    // Q as a matrix (symmetric).
    let Q = mat3x3f(vec3f(xx, xy, xz), vec3f(xy, yy, yz), vec3f(xz, yz, zz));
    let L = mat3x3f(vec3f(dudx, dvdx, 0.0), vec3f(dudy, dvdy, 0.0), vec3f(dudz, dvdz, 0.0));
    let QL = Q * L;
    let LtQ = transpose(L) * Q;
    let qdl = xx * dudx + xy * dudy + xz * dudz + xy * dvdx + yy * dvdy + yz * dvdz;
    let dQ = 2.0 * qdl * Q - LtQ - QL;
    xx += h * dQ[0].x; yy += h * dQ[1].y; zz += h * dQ[2].z;
    xy += h * 0.5 * (dQ[1].x + dQ[0].y);
    xz += h * 0.5 * (dQ[2].x + dQ[0].z);
    yz += h * 0.5 * (dQ[2].y + dQ[1].z);
    // Tumbling back to random where nothing aligns them.
    xx += rlx * (1.0 / 3.0 - xx); yy += rlx * (1.0 / 3.0 - yy); zz += rlx * (1.0 / 3.0 - zz);
    xy -= rlx * xy; xz -= rlx * xz; yz -= rlx * yz;
    // Keep it a second moment: a positive diagonal, trace 1.
    xx = max(xx, 0.0); yy = max(yy, 0.0); zz = max(zz, 0.0);
    let tr = max(xx + yy + zz, 1e-6);
    xx /= tr; yy /= tr; zz /= tr; xy /= tr; xz /= tr; yz /= tr;
    // And its off-diagonal terms bounded as a second moment's are: |Q_ij| <= sqrt(Q_ii Q_jj).
    let bxy = sqrt(xx * yy); let bxz = sqrt(xx * zz); let byz = sqrt(yy * zz);
    xy = clamp(xy, -bxy, bxy); xz = clamp(xz, -bxz, bxz); yz = clamp(yz, -byz, byz);
  }
  if (!(xx == xx && yy == yy && zz == zz && xy == xy && xz == xz && yz == yz)) {
    xx = 1.0 / 3.0; yy = 1.0 / 3.0; zz = 1.0 / 3.0; xy = 0.0; xz = 0.0; yz = 0.0;
  }
  qout[2u * k] = vec4f(xx, yy, zz, xy);
  qout[2u * k + 1u] = vec4f(xz, yz, n1, n2);
}
`;class Bn{device;nx;ny;bufs;cur=0;pipe;uni;frame=0;seed=7;constructor(e,s,t){this.device=e,this.nx=s,this.ny=t;const a=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.bufs=[e.createBuffer({size:s*t*32,usage:a}),e.createBuffer({size:s*t*32,usage:a})],this.pipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:bs(),label:"rheoscopic"}),entryPoint:"main"}}),this.uni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.reset()}reset(){const e=new Float32Array(this.nx*this.ny*8);let s=99;const t=()=>(s=s*1103515245+12345&2147483647)/2147483647;for(let a=0;a<this.nx*this.ny;a++)e.set([1/3,1/3,1/3,0,0,0,t(),t()],8*a);this.device.queue.writeBuffer(this.bufs[0],0,e),this.device.queue.writeBuffer(this.bufs[1],0,e),this.frame=0}get field(){return this.bufs[this.cur]}get sparkleWeights(){const e=this.frame%ft/ft,s=Math.sin(Math.PI*e)**2;return[s,1-s]}encode(e,s,t,a){if(s<=0)return;const i=new ArrayBuffer(48),r=new Uint32Array(i),c=new Float32Array(i);r[0]=this.nx,r[1]=this.ny,r[2]=this.frame,r[3]=this.seed=this.seed*1664525+1013904223>>>0,c[4]=s,c[5]=1/Math.max(1,a.depthCells),c[6]=1/Math.max(1,a.relaxSteps),c[7]=a.inletX,r[8]=ft,this.device.queue.writeBuffer(this.uni,0,i);const o=this.device.createBindGroup({layout:this.pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:this.bufs[this.cur]}},{binding:2,resource:{buffer:this.bufs[this.cur^1]}},{binding:3,resource:{buffer:this.uni}}]}),l=this.nx*this.ny,d=Math.ceil(l/K),u=Math.min(d,32768),h=e.beginComputePass({label:"rheoscopic"});h.setPipeline(this.pipe),h.setBindGroup(0,o),h.dispatchWorkgroups(u,Math.ceil(d/u)),h.end(),this.cur^=1,this.frame++}async read(){const e=this.nx*this.ny*32,s=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),t=this.device.createCommandEncoder();t.copyBufferToBuffer(this.field,0,s,0,e),this.device.queue.submit([t.finish()]),await s.mapAsync(GPUMapMode.READ);const a=new Float32Array(s.getMappedRange().slice(0));return s.destroy(),a}destroy(){this.bufs[0].destroy(),this.bufs[1].destroy(),this.uni.destroy()}}const Ge=1024,Vt=512,vs=`
struct L { nx: f32, ny: f32, lines: u32, K: u32, x0: f32, y0: f32, dy: f32, h: f32 };
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> verts: array<vec4f>;
@group(0) @binding(2) var<uniform> Lp: L;

fn at(p: vec2f) -> vec4f {
  let c = clamp(p, vec2f(0.0), vec2f(Lp.nx - 1.001, Lp.ny - 1.001));
  let i = u32(c.x);
  let j = u32(c.y);
  let f = c - vec2f(f32(i), f32(j));
  let nx = u32(Lp.nx);
  let k = i + j * nx;
  return mix(mix(mac[k], mac[k + 1u], f.x), mix(mac[k + nx], mac[k + nx + 1u], f.x), f.y);
}
fn dir(p: vec2f) -> vec2f {
  let v = at(p).xy;
  let l = length(v);
  return select(vec2f(0.0), v / l, l > 1e-7);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let s = gid.x;
  if (s >= Lp.lines) { return; }
  var q = vec2f(Lp.x0, Lp.y0 + Lp.dy * (f32(s) + 0.5));
  var alive = true;
  for (var k = 0u; k < Lp.K; k++) {
    verts[s * Lp.K + k] = vec4f(q, select(0.0, 1.0, alive), 0.0);
    if (!alive) { continue; }
    let d1 = dir(q);
    let d2 = dir(q + 0.5 * Lp.h * d1);
    if (dot(d2, d2) < 0.5) { alive = false; continue; }
    q += Lp.h * d2;
    if (q.x < 0.0 || q.y < 0.0 || q.x > Lp.nx - 1.0 || q.y > Lp.ny - 1.0 || at(q).w > 0.5) { alive = false; }
  }
}
`,ws=`
struct D { scale: f32, ox: f32, oy: f32, w: f32, h: f32, halfW: f32, K: f32, pad: f32, color: vec4f };
@group(0) @binding(0) var<storage, read> verts: array<vec4f>;
@group(0) @binding(1) var<uniform> Dr: D;
struct Out { @builtin(position) p: vec4f, @location(0) d: f32 };

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var o: Out;
  let K = u32(Dr.K);
  let line = ii / (K - 1u);
  let k = ii % (K - 1u);
  let va = verts[line * K + k];
  let vb = verts[line * K + k + 1u];
  if (va.z < 0.5 || vb.z < 0.5) { o.p = vec4f(2.0, 2.0, 0.0, 1.0); return o; }
  let a = vec2f((va.x - Dr.ox) / Dr.scale, (Dr.oy - va.y) / Dr.scale);
  let b = vec2f((vb.x - Dr.ox) / Dr.scale, (Dr.oy - vb.y) / Dr.scale);
  var dv = b - a;
  let len = length(dv);
  dv = select(vec2f(1.0, 0.0), dv / max(len, 1e-6), len > 1e-4);
  let n = vec2f(-dv.y, dv.x);
  let corner = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = corner[vi];
  let px = select(a, b, c.x > 0.5) + n * Dr.halfW * c.y;
  o.p = vec4f(px.x / Dr.w * 2.0 - 1.0, 1.0 - px.y / Dr.h * 2.0, 0.0, 1.0);
  o.d = c.y;
  return o;
}

@fragment
fn fs(i: Out) -> @location(0) vec4f {
  return vec4f(Dr.color.rgb, Dr.color.a * clamp((1.0 - abs(i.d)) * 1.6, 0.0, 1.0));
}
`;class Rn{device;verts;trace;draw;traceUni;drawUni;lines=0;constructor(e,s){this.device=e,this.verts=e.createBuffer({size:Vt*Ge*16,usage:GPUBufferUsage.STORAGE}),this.trace=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:vs,label:"streamlines trace"}),entryPoint:"main"}});const t=e.createShaderModule({code:ws,label:"streamlines draw"});this.draw=e.createRenderPipeline({layout:"auto",vertex:{module:t,entryPoint:"vs"},fragment:{module:t,entryPoint:"fs",targets:[{format:s,blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-list"}}),this.traceUni=e.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.drawUni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}get count(){return this.lines}encodeTrace(e,s,t,a,i){this.lines=Math.max(1,Math.min(Vt,Math.floor(i)));const r=new ArrayBuffer(32),c=new Float32Array(r),o=new Uint32Array(r);c[0]=t.nx,c[1]=t.ny,o[2]=this.lines,o[3]=Ge,c[4]=a,c[5]=0,c[6]=(t.ny-1)/this.lines,c[7]=Math.max(.5,t.nx*1.4/Ge),this.device.queue.writeBuffer(this.traceUni,0,r);const l=this.device.createBindGroup({layout:this.trace.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:s}},{binding:1,resource:{buffer:this.verts}},{binding:2,resource:{buffer:this.traceUni}}]}),d=e.beginComputePass({label:"streamlines"});d.setPipeline(this.trace),d.setBindGroup(0,l),d.dispatchWorkgroups(Math.ceil(this.lines/64)),d.end()}encodeDraw(e,s,t,a,i){if(!this.lines)return;this.device.queue.writeBuffer(this.drawUni,0,new Float32Array([t.scale,t.ox,t.oy,s.w,s.h,.6*i,Ge,0,...a]));const r=this.device.createBindGroup({layout:this.draw.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.verts}},{binding:1,resource:{buffer:this.drawUni}}]});e.setPipeline(this.draw),e.setBindGroup(0,r),e.draw(6,this.lines*(Ge-1))}destroy(){this.verts.destroy(),this.traceUni.destroy(),this.drawUni.destroy()}}const pt={particles:0,vorticity:0,speed:1,pressure:2,schlieren:3,rheoscopic:1,none:1},mt=4;class st{nx;ny;n;config;device;f;cur=0;paramsBuf;params=new ArrayBuffer(64);bodiesBuf;bodyData=new ArrayBuffer(W*64);sdfBuf;sdfKey="";sdfOffsets=[];forceBuf;staging=[];stepPipe;stepPipeKey="";stepBG=null;slotBGs=[];slotBuf;macroPipe;fieldPipe;stepModule;aux=null;auxDummy;macroBuf;scalarBuf;fieldUni;sampledBuf;sampledRead;sampledBusy=!1;sampleW;sampleH;bodies=[];physics={u:.05,tau:.6,smagorinsky:!1,smagCs:.1};groups;destroyed=!1;stepsDone=0;constructor(e,s){this.device=e,this.config={profile:0,absorbing:!0,...s},this.nx=s.nx,this.ny=s.ny,this.n=s.nx*s.ny;const t=GPUBufferUsage,a=9*this.n*4;this.f=[e.createBuffer({size:a,usage:t.STORAGE|t.COPY_DST}),e.createBuffer({size:a,usage:t.STORAGE|t.COPY_DST})],this.paramsBuf=e.createBuffer({size:64,usage:t.UNIFORM|t.COPY_DST}),this.bodiesBuf=e.createBuffer({size:W*64,usage:t.STORAGE|t.COPY_DST}),this.sdfBuf=e.createBuffer({size:16,usage:t.STORAGE|t.COPY_DST}),this.forceBuf=e.createBuffer({size:ct*4,usage:t.STORAGE|t.COPY_SRC|t.COPY_DST}),this.slotBuf=e.createBuffer({size:re*256,usage:t.UNIFORM|t.COPY_DST}),this.auxDummy=[e.createBuffer({size:16,usage:t.STORAGE}),e.createBuffer({size:16,usage:t.STORAGE})];const i=new Uint32Array(re*64);for(let c=0;c<re;c++)i[c*64]=c;e.queue.writeBuffer(this.slotBuf,0,i),this.macroBuf=e.createBuffer({size:this.n*16,usage:t.STORAGE|t.COPY_SRC}),this.scalarBuf=e.createBuffer({size:this.n*4,usage:t.STORAGE}),this.fieldUni=e.createBuffer({size:48,usage:t.UNIFORM|t.COPY_DST}),this.sampleW=Math.ceil(this.nx/mt),this.sampleH=Math.ceil(this.ny/mt),this.sampledBuf=e.createBuffer({size:this.sampleW*this.sampleH*4,usage:t.STORAGE|t.COPY_SRC}),this.sampledRead=e.createBuffer({size:this.sampleW*this.sampleH*4,usage:t.MAP_READ|t.COPY_DST}),this.stepModule=e.createShaderModule({code:as(),label:"tunnel step"}),this.macroPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:rs(),label:"tunnel macro"}),entryPoint:"main"}}),this.fieldPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:os(),label:"tunnel field"}),entryPoint:"main"}});const r=Math.ceil(this.n/K);this.groups=[Math.min(r,32768),Math.ceil(r/Math.min(r,32768))],this.writeBodies(),this.reset()}reset(e=this.physics.u){const s=new Float32Array(9*this.n),t=1.5*e*e;for(let a=0;a<9;a++){const i=3*[0,1,0,-1,0,1,-1,-1,1][a]*e;s.fill(ge[a]*(i+.5*i*i-t),a*this.n,(a+1)*this.n)}this.device.queue.writeBuffer(this.f[0],0,s),this.device.queue.writeBuffer(this.f[1],0,s),this.resetAux(e),this.stepsDone=0}resetAux(e=this.physics.u){if(!this.aux)return;const s=new Float32Array(4*this.n),t=this.physics.nuMol??0,a=Math.max(t,this.physics.nuFloor??0);for(let i=0;i<this.n;i++)s[4*i]=e,s[4*i+2]=3*t,s[4*i+3]=a;this.device.queue.writeBuffer(this.aux[0],0,s),this.device.queue.writeBuffer(this.aux[1],0,s)}setPhysics(e){this.physics=e;const s=e.turb??"off";if(s!=="off"&&!this.aux){const i=GPUBufferUsage;this.aux=[this.device.createBuffer({size:16*this.n,usage:i.STORAGE|i.COPY_DST|i.COPY_SRC}),this.device.createBuffer({size:16*this.n,usage:i.STORAGE|i.COPY_DST|i.COPY_SRC})],this.resetAux(),this.stepBG=null}else if(s==="off"&&this.aux){for(const i of this.aux)i.destroy();this.aux=null,this.stepBG=null}const t=e.bulkKeep??0,a=`${this.config.walls}|${e.smagorinsky}|${s}|${t}`;a!==this.stepPipeKey&&(this.stepPipe=this.device.createComputePipeline({layout:"auto",compute:{module:this.stepModule,entryPoint:"step",constants:{WALLS:en[this.config.walls],SMAG:e.smagorinsky?1:0,TURB:tn[s],KEEP_BULK:t}}}),this.stepPipeKey=a,this.stepBG=null,this.slotBGs=[])}writeParams(e){const s=new Uint32Array(this.params),t=new Float32Array(this.params),a=this.physics;s[0]=this.nx,s[1]=this.ny,s[2]=this.n,s[3]=this.bodies.length,t[4]=1/a.tau,t[5]=18*Math.SQRT2*a.smagCs*a.smagCs,t[6]=a.u,t[7]=this.config.absorbing||this.config.walls==="farfield"?.05:0,t[8]=this.config.absorbing?this.absorbInX:-1,t[9]=this.spongeX,s[10]=Math.max(1,e),s[11]=this.config.profile,t[12]=this.config.walls==="farfield"?Math.max(4,this.ny*.06):0,t[13]=a.nuMol??0,t[14]=a.nuFloor??0,t[15]=3*(a.nuMol??0),this.device.queue.writeBuffer(this.paramsBuf,0,this.params)}get absorbInX(){return this.config.absorbing?this.nx*.05:-1}get spongeX(){return this.nx*.85}setBodies(e){if(e.length>W)throw new Error(`At most ${W} bodies are in the flow at once.`);this.bodies=e;const s=e.map(t=>t.key).join("|");if(s!==this.sdfKey){const t=Math.max(4,e.reduce((i,r)=>i+r.sdf.data.length,0));this.sdfBuf.size<t*4&&(this.sdfBuf.destroy(),this.sdfBuf=this.device.createBuffer({size:t*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.stepBG=null,this.renderBGDirty=!0),this.sdfOffsets=[];let a=0;for(const i of e)this.sdfOffsets.push(a),this.device.queue.writeBuffer(this.sdfBuf,a*4,i.sdf.data),a+=i.sdf.data.length;this.sdfKey=s}this.writeBodies()}renderBGDirty=!1;writeBodies(){const e=new Float32Array(this.bodyData),s=new Uint32Array(this.bodyData);this.bodies.forEach((t,a)=>{const i=a*16;e[i]=t.from.x,e[i+1]=t.from.y,e[i+2]=t.to.x,e[i+3]=t.to.y,e[i+4]=t.from.theta,e[i+5]=t.to.theta,e[i+6]=t.sdf.bound,e[i+7]=t.sdf.texel,e[i+8]=t.sdf.ox,e[i+9]=t.sdf.oy,s[i+10]=t.sdf.w,s[i+11]=t.sdf.h,s[i+12]=this.sdfOffsets[a]??0,e[i+13]=t.sdf.band}),this.device.queue.writeBuffer(this.bodiesBuf,0,this.bodyData)}get buffers(){return{params:this.paramsBuf,bodies:this.bodiesBuf,sdf:this.sdfBuf,scalar:this.scalarBuf}}bindGroups(){if(!this.stepBG){const e=this.stepPipe.getBindGroupLayout(0),s=this.aux??this.auxDummy,t=(a,i,r,c)=>this.device.createBindGroup({layout:e,entries:[{binding:0,resource:{buffer:a}},{binding:1,resource:{buffer:i}},{binding:2,resource:{buffer:this.paramsBuf}},{binding:3,resource:{buffer:this.bodiesBuf}},{binding:4,resource:{buffer:this.sdfBuf}},{binding:5,resource:{buffer:this.forceBuf}},{binding:6,resource:{buffer:r}},{binding:7,resource:{buffer:c}}]});this.stepBG=[t(this.f[0],this.f[1],s[0],s[1]),t(this.f[1],this.f[0],s[1],s[0])]}if(!this.slotBGs.length){const e=this.stepPipe.getBindGroupLayout(1);for(let s=0;s<re;s++)this.slotBGs.push(this.device.createBindGroup({layout:e,entries:[{binding:0,resource:{buffer:this.slotBuf,offset:s*256,size:16}}]}))}return this.stepBG}encodeFrame(e,s,t){const a=Math.min(re,Math.max(0,Math.floor(s)));this.writeParams(Math.max(1,a)),this.writeBodies();const i=this.bindGroups();let r=!1;if(a>0){e.clearBuffer(this.forceBuf,0,Math.min(ct*4,a*W*8)),e.clearBuffer(this.forceBuf,de*4,16);const c=e.beginComputePass({label:"tunnel steps"});c.setPipeline(this.stepPipe);for(let o=0;o<a;o++)c.setBindGroup(0,i[this.cur]),c.setBindGroup(1,this.slotBGs[o]),c.dispatchWorkgroups(this.groups[0],this.groups[1]),this.cur^=1;c.end(),this.stepsDone+=a,r=!0}return this.encodeField(e,t),{readForces:r}}encodeField(e,s){const t=new ArrayBuffer(48),a=new Uint32Array(t),i=new Float32Array(t);a[0]=this.nx,a[1]=this.ny,a[2]=s.mode,a[3]=mt,i[4]=s.uRef,i[5]=s.lRef,i[8]=s.rhoRef??1,a[6]=this.sampleW,a[7]=this.sampleH,this.device.queue.writeBuffer(this.fieldUni,0,t);const r=this.device.createBindGroup({layout:this.macroPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.f[this.cur]}},{binding:1,resource:{buffer:this.macroBuf}},{binding:2,resource:{buffer:this.paramsBuf}},{binding:3,resource:{buffer:this.bodiesBuf}},{binding:4,resource:{buffer:this.sdfBuf}}]}),c=this.device.createBindGroup({layout:this.fieldPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.macroBuf}},{binding:1,resource:{buffer:this.scalarBuf}},{binding:2,resource:{buffer:this.fieldUni}},{binding:3,resource:{buffer:this.sampledBuf}}]}),o=e.beginComputePass({label:"tunnel field"});o.setPipeline(this.macroPipe),o.setBindGroup(0,r),o.dispatchWorkgroups(this.groups[0],this.groups[1]),o.setPipeline(this.fieldPipe),o.setBindGroup(0,c),o.dispatchWorkgroups(this.groups[0],this.groups[1]),o.end()}prepareRead(e,s){const t=Math.min(re,s),a=t*W*8;let i=this.staging.pop();i||(i=this.device.createBuffer({size:ct*4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})),e.copyBufferToBuffer(this.forceBuf,0,i,0,a),e.copyBufferToBuffer(this.forceBuf,de*4,i,de*4,16);const r=i;return async()=>{try{await r.mapAsync(GPUMapMode.READ)}catch{return null}const c=new Int32Array(r.getMappedRange().slice(0));r.unmap(),this.destroyed?r.destroy():this.staging.push(r);const o=this.bodies.map((d,u)=>{const h=new Float64Array(t*2);let f=0,x=0;for(let p=0;p<t;p++){const w=c[(p*W+u)*2]/Je,b=c[(p*W+u)*2+1]/Je;h[2*p]=w,h[2*p+1]=b,f+=w,x+=b}return{fx:f,fy:x,perStep:h}}),l=c[de]>0?this.n-c[de+1]:-1;return{steps:t,forces:o,bad:c[de],limited:c[de+2],badCell:l>=0?{x:l%this.nx,y:Math.floor(l/this.nx)}:null}}}async readSampled(){if(this.sampledBusy||this.destroyed)return null;this.sampledBusy=!0;try{const e=this.device.createCommandEncoder();e.copyBufferToBuffer(this.sampledBuf,0,this.sampledRead,0,this.sampledRead.size),this.device.queue.submit([e.finish()]),await this.sampledRead.mapAsync(GPUMapMode.READ);const s=new Float32Array(this.sampledRead.getMappedRange().slice(0));this.sampledRead.unmap();for(let t=0;t<s.length;t++)s[t]>1e29&&(s[t]=NaN);return s}catch{return null}finally{this.sampledBusy=!1}}async readFields(){const e=this.n*16,s=GPUBufferUsage,t=()=>this.device.createBuffer({size:e,usage:s.MAP_READ|s.COPY_DST}),a=t(),i=this.aux?t():null,r=this.device.createCommandEncoder();r.copyBufferToBuffer(this.macroBuf,0,a,0,e),i&&this.aux&&r.copyBufferToBuffer(this.aux[this.cur],0,i,0,e),this.device.queue.submit([r.finish()]);const c=async d=>{await d.mapAsync(GPUMapMode.READ);const u=new Float32Array(d.getMappedRange().slice(0));return d.unmap(),d.destroy(),u},[o,l]=await Promise.all([c(a),i?c(i):Promise.resolve(null)]);return{mac:o,aux:l}}destroy(){this.destroyed=!0;for(const e of[...this.aux??[],...this.auxDummy])e.destroy();for(const e of[...this.f,this.paramsBuf,this.bodiesBuf,this.sdfBuf,this.forceBuf,this.slotBuf,this.macroBuf,this.scalarBuf,this.fieldUni,this.sampledBuf,...this.staging])e.destroy();this.staging=[]}}const Le=.05,Et=50,ks=.005,Ye=.1,Wt=1/3;function Cn(n,e,s,t){const a=n/e;let i=Le;const r=u=>t*u/(s*a);r(i)>Wt&&(i=Wt*s*a/t);const c=r(i),o=i/Et,l=Math.max(c,o),d=i*a/s;return{dx:a,dt:d,u:i,nu:l,nuFluid:c,nuFloor:o,tau:3*l+.5,capped:c<o,smagorinsky:l<ks}}function $n(n,e,s,t){return{real:s*e/t,sim:n.u*(e/n.dx)/n.nu}}const Pe={low:512*256,medium:1024*512,high:1536*768,ultra:2048*1024},Ve=.03;function yt(n,e,s,t){const a=e+s*n,i=Math.exp(-s*t);return[(n+a*t)*i,(a-s*(n+a*t))*i]}const Tn=.1,_n=12,En={particles:"inferno",vorticity:"balance",speed:"viridis",pressure:"balance",schlieren:"viridis",rheoscopic:"viridis",none:"viridis"},Un=.3,Dn=1.5,Nn={low:1/110,normal:1/40,high:1/16},Fn=3e3,Gn=4e4,zn={off:0,short:11,long:22},qn=34,Ln=14;function Ms(n){return n.field==="particles"?n.particleColor==="vorticity"?"balance":"inferno":En[n.field]}function Mt(n,e){const{length:s,height:t}=n.tunnel;let a=Math.round(Math.sqrt(e*s/t)),i=Math.round(e/a);return a=Math.max(32,Math.min(8192,a)),i=Math.max(16,Math.min(8192,i)),{nx:a,ny:i}}const Xt=new Map;class In{device;adapterName;canvas;renderer;solver=null;scene=null;map=null;bodies=new Map;order=[];targets=new Map;raf=0;stepsTarget=64;gpuMs=0;lastFrame=0;fpsEma=0;readPending=!1;sampledAt=0;listeners=new Set;range={lo:-10,hi:10};autoRange={lo:-10,hi:10,ready:!1};gridKey="";rangeField=null;rangeKey="";rhoRef=1;physKey="";turb="off";paused=!1;unstable=!1;palette;worldView={cx:4,cy:2,mpp:.01,w:800,h:400,dpr:1};simTime=0;stats;particles;dye=null;rheo=null;rheoLooks={};streamlines;rakeGpu=[];dyeChannels=new Map;frameNo=0;markerColors=null;recordForces=!1;onUnstable=null;unstableAt=null;constructor(e,s,t,a){this.device=e,this.adapterName=t,this.palette=a,this.canvas=s,this.renderer=new on(e,s),this.particles=new Pn(e),this.streamlines=new Rn(e,this.renderer.format),this.stats={adapter:t,nx:0,ny:0,stepsPerFrame:0,mlups:0,speedRatio:0,simTime:0,fps:0,map:null,state:"running"}}subscribe(e){return this.listeners.add(e),()=>{this.listeners.delete(e)}}emit(){for(const e of this.listeners)e()}get solverReady(){return!!this.solver}get lattice(){return this.map}get grid(){return this.solver?{nx:this.solver.nx,ny:this.solver.ny}:null}benchmark(){return this.benchmarkAt(1024,512)}get flowModel(){return this.turb}async benchmarkAt(e,s,t="off"){const a=`${e}x${s}|${t}`,i=Xt.get(a);if(i!==void 0)return i;const r=new st(this.device,{nx:e,ny:s,walls:"slip"});t==="sa"?r.setPhysics({u:Le,tau:.51,smagorinsky:!1,smagCs:Ye,turb:"sa",nuMol:1e-6,nuFloor:Le/Et}):r.setPhysics({u:Le,tau:.51,smagorinsky:!0,smagCs:Ye});const c=async h=>{const f=this.device.createCommandEncoder();r.encodeFrame(f,h,{mode:0,uRef:.05,lRef:50}),this.device.queue.submit([f.finish()]),await this.device.queue.onSubmittedWorkDone()};await c(30);const o=Math.max(40,Math.min(400,Math.round(2e8/(e*s)))),l=performance.now();await c(o);const d=Math.max(.1,performance.now()-l);r.destroy();const u=e*s*o/(d/1e3)/1e6;return Xt.set(a,u),u}async cellsFor(e,s){if(e!=="auto")return Pe[e];const t=It(s),a=async i=>{const{nx:r,ny:c}=Mt(s,Pe[i]),o=8*r*r*c*1.25/1e6;return await this.benchmarkAt(r,c,t)>=o};return await a("medium")?await a("high")?await a("ultra")?Pe.ultra:Pe.high:Pe.medium:Pe.low}async setScene(e){this.scene=e;const s=await this.cellsFor(e.tunnel.resolution,e);if(this.scene!==e)return;const{nx:t,ny:a}=Mt(e,s),i=`${t}x${a}|${e.tunnel.walls}|${e.tunnel.length}`;i!==this.gridKey&&(this.solver?.destroy(),this.solver=new st(this.device,{nx:t,ny:a,walls:e.tunnel.walls}),this.particles.clear(),this.dye?.destroy(),this.dye=null,this.rheo?.destroy(),this.rheo=null,this.gridKey=i,this.bodies.clear(),this.physKey="",this.simTime=0,this.unstable=!1,this.autoRange.ready=!1,this.rhoRef=1);const r=qe[e.flow.fluid];this.map=Cn(e.tunnel.length,t,e.flow.speed,r.nu),this.turb=It(e);const c=this.turb==="sa",o=`${this.map.u}|${this.map.tau}|${this.map.smagorinsky}|${this.turb}|${this.map.nuFluid}`;o!==this.physKey&&(this.solver.setPhysics({u:this.map.u,tau:this.map.tau,smagorinsky:this.map.smagorinsky&&!c,smagCs:Ye,turb:this.turb,nuMol:this.map.nuFluid,nuFloor:this.map.nuFloor}),this.physKey||this.solver.reset(this.map.u),this.physKey=o),this.syncBodies(e),await this.syncMarkers(e),this.emit()}async syncMarkers(e){const s=this.solver,t=this.map.dx,a=await this.benchmark();let r=e.view.tracers||e.view.field==="particles"?Math.round(s.n*Nn[e.view.density]):0;a<Fn&&(r=Math.min(r,Gn));const c=d=>d/t-.5,o=e.rakes.filter(d=>d.enabled);this.rakeGpu=o.filter(d=>d.kind!=="dye").map(d=>({id:d.id,kind:d.kind,x0:c(d.x0),y0:c(d.y0),x1:c(d.x1),y1:c(d.y1),emitters:d.emitters,color:d.color})),this.particles.configure(r,this.rakeGpu,{nx:s.nx,ny:s.ny,absorbInX:Math.max(0,s.absorbInX),outX:s.spongeX});const l=o.filter(d=>d.kind==="dye").slice(0,L.maxDyeRakes);if(this.dyeChannels=new Map(l.map((d,u)=>[d.id,u])),l.length){this.dye||(this.dye=new bn(this.device,s.nx,s.ny),this.dye.clear());const d=[];l.forEach((u,h)=>{for(let f=0;f<u.emitters;f++){const x=u.emitters===1?.5:f/(u.emitters-1);d.push({x:c(u.x0+(u.x1-u.x0)*x),y:c(u.y0+(u.y1-u.y0)*x),channel:h})}}),this.dye.setSources(d)}else this.dye&&(this.dye.destroy(),this.dye=null)}get dyeChannelOf(){return this.dyeChannels}async readParticles(){const e=await this.particles.read();return e?{...e,tracers:this.particles.tracerCount,pools:this.particles.pools,dx:this.map?.dx??0}:null}async readDye(){return this.dye?{data:await this.dye.read(),nx:this.dye.nx,ny:this.dye.ny,channels:Object.fromEntries(this.dyeChannels),dx:this.map?.dx??0}:null}async readRheo(){if(!this.rheo)return null;const e=await this.rheo.read(),s=this.rheo.nx*this.rheo.ny;let t=0,a=0,i=0,r=0,c=1/0,o=-1/0;for(let d=0;d<s;d++){const u=e.slice(8*d,8*d+6);if(!u.every(Number.isFinite)){i++;continue}t+=u[2],a+=Math.abs(u[3]),r+=u[0]+u[1]+u[2],c=Math.min(c,u[2]),o=Math.max(o,u[2])}const l=Math.max(1,s-i);return{meanZZ:t/l,meanAbsXY:a/l,meanTrace:r/l,minZZ:c,maxZZ:o,nan:i,nx:this.rheo.nx,ny:this.rheo.ny,data:null}}get streamlineCount(){return this.scene?.view.streamlines?this.streamlines.count:0}syncBodies(e){const s=this.map.dx,t=e.bodies.filter(i=>i.enabled).slice(0,W),a=new Set(t.map(i=>i.id));for(const i of[...this.bodies.keys()])a.has(i)||this.bodies.delete(i);for(const i of t){const r=this.turb==="sa"?is:void 0,c=`${JSON.stringify(i.shape)}@${s}|${r??""}`,o=this.bodies.get(i.id),l=this.targetPose(i);if(!o||o.key!==c){const d=Rt(Ie(i.shape,$t*s),{x:0,y:0,theta:0},1/s),u=Ct(d,r);this.bodies.set(i.id,{body:i,key:c,sdf:u,rCells:bt(d),pose:o?.pose??l,spinAngle:o?.spinAngle??0,vel:o?.vel??{x:0,y:0,theta:0},fxEma:0,fyEma:0,history:[]})}else o.body=i}this.order=t.map(i=>i.id)}targetPose(e){const s=this.map.dx,t=this.targets.get(e.id),a=t?.x??e.x,i=t?.y??e.y,r=t?.angle??e.angle,c=this.bodies.get(e.id)?.spinAngle??0;return{x:a/s-.5,y:i/s-.5,theta:-r*Math.PI/180+c}}setTarget(e,s){s?this.targets.set(e,s):this.targets.delete(e)}livePose(e){const s=this.bodies.get(e);if(!s||!this.map)return null;const t=this.map.dx;return{x:(s.pose.x+.5)*t,y:(s.pose.y+.5)*t,angle:-(s.pose.theta-s.spinAngle)*180/Math.PI}}bodyLive(e){const s=this.bodies.get(e),t=this.livePose(e);if(!s||!t||!this.map||!this.scene)return null;const a=qe[this.scene.flow.fluid],i=this.map.u,r=.5*i*i*(Ae(s.body.shape)/this.map.dx),c=o=>o/r*.5*a.rho*this.scene.flow.speed**2*Ae(s.body.shape);return{...t,fx:c(s.fxEma),fy:c(s.fyEma),cd:s.fxEma/r,cl:s.fyEma/r}}spinCap(e){const s=this.bodies.get(e);return!s||!this.map?null:Tn/Math.max(1,s.rCells)/this.map.dt}forceHistory(e){return this.bodies.get(e)?.history??[]}reynoldsFor(e){if(!this.map||!this.scene)return null;const s=$n(this.map,Ae(e.shape),this.scene.flow.speed,qe[this.scene.flow.fluid].nu);return this.turb==="sa"?{real:s.real,sim:s.real}:s}resetFlow(){if(!(!this.solver||!this.map)){this.solver.reset(this.map.u),this.simTime=0,this.rhoRef=1,this.particles.clear(),this.dye?.clear(),this.rheo?.reset(),this.scene&&this.syncMarkers(this.scene),this.unstable=!1;for(const e of this.bodies.values())e.fxEma=0,e.fyEma=0,e.history=[];this.emit()}}setColormap(e){this.renderer.setColormap(e)}bodyLook=null;get autoRangeNow(){return this.autoRange.ready?{lo:this.autoRange.lo,hi:this.autoRange.hi}:null}setRange(e,s){this.range={lo:e,hi:s}}start(){if(this.raf)return;const e=s=>{this.raf=requestAnimationFrame(e),this.frame(s)};this.raf=requestAnimationFrame(e)}stop(){cancelAnimationFrame(this.raf),this.raf=0}lRefCells(){const e=this.order.length?this.bodies.get(this.order[0]):null;return e&&this.map?Ae(e.body.shape)/this.map.dx:this.solver?this.solver.ny/8:50}frame(e){const s=this.solver,t=this.scene,a=this.map;if(!s||!t||!a)return;const i=this.lastFrame?Math.min(100,e-this.lastFrame):16;this.lastFrame=e,this.fpsEma=this.fpsEma?this.fpsEma*.9+1e3/Math.max(1,i)*.1:60;let r=this.paused||this.unstable?0:Math.round(this.stepsTarget);r>0&&t.view.speed==="realtime"&&(r=Math.max(1,Math.min(r,Math.round(i/1e3/a.dt)))),r=Math.min(re,r);const c=[];for(const P of this.order){const y=this.bodies.get(P);if(r>0&&y.body.spin){const G=this.spinCap(y.body.id)??1/0;y.spinAngle+=Math.sign(y.body.spin)*Math.min(Math.abs(y.body.spin),G)*a.dt*r}const $=this.targetPose(y.body),T={...y.pose};if(r===0)y.pose=$,y.vel={x:0,y:0,theta:0};else{const G=1/Math.max(300,4*y.rCells/.577),E=Math.max(1,y.rCells),[C,O]=yt(T.x-$.x,y.vel.x,G,r),[q,V]=yt(T.y-$.y,y.vel.y,G,r),[he,U]=yt(T.theta-$.theta,y.vel.theta,G,r);let z=$.x+C-T.x,ee=$.y+q-T.y,Q=$.theta+he-T.theta;const F=Math.hypot(z,ee);F>Ve*r&&(z*=Ve*r/F,ee*=Ve*r/F);const X=Ve*r/E;Math.abs(Q)>X&&(Q=Math.sign(Q)*X);const te=Math.hypot(z,ee)<F-1e-9;y.vel={x:te?z/r:O,y:te?ee/r:V,theta:Math.abs(Q)>=X?Q/r:U},y.pose={x:T.x+z,y:T.y+ee,theta:T.theta+Q}}c.push({key:`${P}:${y.key}`,sdf:y.sdf,from:r===0?y.pose:T,to:y.pose})}s.setBodies(c);const o=t.view.field==="particles",l=o?t.view.particleColor==="vorticity"?pt.vorticity:pt.speed:pt[t.view.field],d=o?`particles:${t.view.particleColor}`:t.view.field,u=this.device.createCommandEncoder();d!==this.rangeKey&&(this.rangeKey=d,this.rangeField=o?t.view.particleColor==="vorticity"?"vorticity":"speed":t.view.field,this.autoRange={lo:0,hi:1,ready:!1});const{readForces:h}=s.encodeFrame(u,r,{mode:l,uRef:a.u,lRef:this.lRefCells(),rhoRef:this.rhoRef}),f=t.view.autoRange&&this.autoRange.ready?this.autoRange:this.range;this.renderer.setColormap(Ms(t.view));const x=this.latticeView(a.dx),p=t.view,w=p.field==="none",b=w||p.field==="rheoscopic"||o,A=this.markerColors,M={steps:r,u:a.u,nx:s.nx,ny:s.ny,absorbInX:Math.max(0,s.absorbInX),outX:s.spongeX,wrapY:t.tunnel.walls==="periodic"};this.particles.encodeAdvect(u,M,s.macroBuf,s.buffers),this.dye?.encode(u,r,s.macroBuf);const g=p.field==="rheoscopic";if(g&&!this.rheo&&(this.rheo=new Bn(this.device,s.nx,s.ny)),!g&&this.rheo&&(this.rheo.destroy(),this.rheo=null),this.rheo?.encode(u,r,s.macroBuf,{depthCells:s.ny*Un,relaxSteps:Dn*s.nx/a.u,inletX:Math.max(1,s.absorbInX)}),this.frameNo++,p.streamlines&&(r>0||this.frameNo%10===0)){const P=t.tunnel.height/this.worldView.mpp/Ln;this.streamlines.encodeTrace(u,s.macroBuf,s,Math.max(0,s.absorbInX)+1,Math.max(8,P))}const v=this.renderer.size,k=(p.tracers||p.field==="particles")&&this.particles.tracerCount>0;if(k&&A){const P=this.worldView.dpr,y=o?{scalar:s.buffers.scalar,lut:this.renderer.lut,nx:s.nx,ny:s.ny,lo:f.lo,hi:f.hi,lift:.36}:null,$=o?[1,1,1,.66]:b?A.tracerLight:[...A.tracerDark.slice(0,3),.3];this.particles.encodeDraw(u,{...v,dot:(o?.95:.6)*P,tail:r>0?zn[p.trail]*P:0,taper:!0},x,0,{tracers:!0},{tracer:$},y,this.renderer.dummies)}const B=[...this.dyeChannels.entries()].sort((P,y)=>P[1]-y[1]).map(([P])=>{const y=t.rakes.find(T=>T.id===P),$=A?.rakesOnDark[y?.color??0]??[0,0,0,1];return[$[0],$[1],$[2],.95]});this.renderer.encode(u,s,x,f,(o||p.field==="rheoscopic")&&this.bodyLook?{...this.palette,...this.bodyLook}:this.palette,{plain:w,arrows:p.arrows,arrowCells:qn*this.worldView.mpp/a.dx,uRef:a.u,dye:this.dye?this.dye.field:null,dyeColors:B,trail:k&&A?this.particles.trail:null,rheo:this.rheo&&this.rheoLooks[p.rheoPreset]?{field:this.rheo.field,look:this.rheoLooks[p.rheoPreset],sparkle:this.rheo.sparkleWeights}:null},A?P=>{p.streamlines&&this.streamlines.encodeDraw(P,v,x,b?A.streamlineLight:A.streamline,this.worldView.dpr),this.rakeGpu.length&&this.particles.encodeRakeLines(P,this.renderer.format,v,x,b?A.rakesOnDark:A.rakes,this.worldView.dpr)}:void 0);const S=h&&!this.readPending?s.prepareRead(u,r):null,R=performance.now();this.device.queue.submit([u.finish()]),this.simTime+=r*a.dt,r>0&&this.device.queue.onSubmittedWorkDone().then(()=>{const P=performance.now()-R;this.gpuMs=this.gpuMs?this.gpuMs*.8+P*.2:P;const y=this.gpuMs/r,$=_n/Math.max(1e-4,y);this.stepsTarget=Math.max(1,Math.min(re,this.stepsTarget*.7+$*.3))}),S&&(this.readPending=!0,S().then(P=>{this.readPending=!1,P&&this.takeForces(P)})),t.view.autoRange&&e-this.sampledAt>400&&(this.sampledAt=e,s.readSampled().then(P=>P&&this.rangeField&&this.takeSample(P,this.rangeField))),this.stats={adapter:this.adapterName,nx:s.nx,ny:s.ny,stepsPerFrame:r,mlups:r>0&&this.gpuMs>0?s.n*r/(this.gpuMs/1e3)/1e6:this.stats.mlups,speedRatio:r*a.dt/Math.max(.001,i/1e3),simTime:this.simTime,fps:this.fpsEma,map:a,state:this.unstable?"unstable":this.paused?"paused":"running"}}limitedAt=0;limitedTotal=0;takeForces(e){if(e.limited>0&&(this.limitedAt=performance.now(),this.limitedTotal+=e.limited),e.bad>0&&!this.unstable){this.unstable=!0,this.unstableAt=e.badCell&&this.map?{x:(e.badCell.x+.5)*this.map.dx,y:(e.badCell.y+.5)*this.map.dx,poses:this.order.map(s=>({id:s,...this.livePose(s)}))}:null,this.onUnstable?.(),this.emit();return}e.forces.forEach((s,t)=>{const a=this.bodies.get(this.order[t]);if(!a||e.steps===0)return;const i=s.fx/e.steps,r=s.fy/e.steps,c=Math.min(1,e.steps/400);if(a.fxEma=a.fxEma?a.fxEma*(1-c)+i*c:i,a.fyEma=a.fyEma?a.fyEma*(1-c)+r*c:r,this.recordForces)for(let o=0;o<e.steps;o++)a.history.push(s.perStep[2*o],s.perStep[2*o+1])})}takeSample(e,s){if(s!==this.rangeField)return;if(s==="pressure"&&this.solver&&this.map){const o=this.solver.sampleW,l=Math.min(o-1,Math.ceil((this.solver.absorbInX+this.solver.nx*.03)/4)),d=[];for(let u=0;u<this.solver.sampleH;u++){const h=e[u*o+l];Number.isFinite(h)&&d.push(h)}if(d.length>4){d.sort((h,f)=>h-f);const u=d[Math.floor(d.length/2)];if(this.rhoRef+=u*1.5*this.map.u*this.map.u,Math.abs(u)>.02)return}}const t=Array.from(e).filter(o=>Number.isFinite(o));if(t.length<16)return;t.sort((o,l)=>o-l);const a=o=>t[Math.min(t.length-1,Math.max(0,Math.round(o*(t.length-1))))];let i,r;if(s==="vorticity"){const o=t.map(Math.abs).sort((d,u)=>d-u),l=Math.max(1e-6,o[Math.round(.985*(o.length-1))]);i=-l,r=l}else if(s==="pressure"){const o=Math.max(Math.abs(a(.01)),Math.abs(a(.99)),.001);i=-o,r=o}else i=0,r=Math.max(s==="speed"?1.8:1e-6,a(.995));const c=this.autoRange.ready?.3:1;this.autoRange={lo:this.autoRange.lo*(1-c)+i*c,hi:this.autoRange.hi*(1-c)+r*c,ready:!0},this.emit()}sampleField(){return this.solver?this.solver.readSampled():Promise.resolve(null)}latticeView(e){const s=this.worldView;return{scale:s.mpp/s.dpr/e,ox:(s.cx-s.w/2*s.mpp)/e-.5,oy:(s.cy+s.h/2*s.mpp)/e-.5}}destroy(){this.stop(),this.solver?.destroy(),this.particles.destroy(),this.dye?.destroy(),this.rheo?.destroy(),this.streamlines.destroy(),this.renderer.destroy()}}const jt=100;class On{state;listeners=new Set;past=[];future=[];onSceneChange=null;constructor(e){this.state={scene:e,selected:null,save:"saved",saveError:""}}get=()=>this.state;subscribe=e=>(this.listeners.add(e),()=>{this.listeners.delete(e)});set(e){this.state={...this.state,...e};for(const s of this.listeners)s()}commit(e,s=!0){s&&(this.past.push(this.state.scene),this.past.length>jt&&this.past.shift(),this.future=[]);const t=this.state.selected,a=t&&(e.bodies.some(i=>i.id===t)||e.rakes.some(i=>i.id===t))?t:null;this.set({scene:e,selected:a}),this.onSceneChange?.(e)}commitFrom(e,s){this.past.push(e),this.past.length>jt&&this.past.shift(),this.future=[],this.commit(s,!1)}updateBody(e,s,t=!0){const a=this.state.scene;this.commit({...a,bodies:a.bodies.map(i=>i.id===e?{...i,...s}:i)},t)}get canUndo(){return this.past.length>0}get canRedo(){return this.future.length>0}undo(){const e=this.past.pop();return e?(this.future.push(this.state.scene),this.commit(e,!1),!0):!1}redo(){const e=this.future.pop();return e?(this.past.push(this.state.scene),this.commit(e,!1),!0):!1}select(e){this.set({selected:e})}setSave(e,s=""){this.set({save:e,saveError:s})}}function Z(n,e){return Ds(n.subscribe,()=>e(n.get()))}const Vn=new Intl.NumberFormat("en-US",{maximumSignificantDigits:3}),pe=n=>Vn.format(n);function Ue({title:n,children:e,attr:s}){return _("section",{className:"t2d-section","data-t2d-section":s??n.toLowerCase(),children:[m("h2",{className:"t2d-section-title",children:n}),m("div",{className:"t2d-section-body",children:e})]})}const Pt=n=>n==="imperial"?"ft":"m";function Yt({label:n,value:e,onCommit:s,error:t,attr:a}){const[i,r]=ue(e);return ae(()=>r(e),[e]),m("span",{className:"mgk-type mgk-value-row",children:m("input",{className:"mgk-input mgk-input--wide","aria-label":n,value:i,"data-t2d-text":a,"aria-invalid":t?!0:void 0,onChange:c=>r(c.target.value),onBlur:()=>i!==e&&s(i),onKeyDown:c=>{c.key==="Enter"&&c.target.blur(),c.key==="Escape"&&(r(e),c.target.blur())}})})}function Wn({store:n,engine:e,units:s}){const t=Z(n,u=>u.scene),a=Z(n,u=>u.selected),[,i]=ue(0);ae(()=>e.subscribe(()=>i(u=>u+1)),[e]);const r=u=>n.commit({...t,flow:{...t.flow,...u}}),c=t.bodies.find(u=>u.id===a)??t.bodies.find(u=>u.enabled)??null,o=c?e.reynoldsFor(c):null,l=e.lattice,d=e.flowModel;return _(Ue,{title:"Wind",children:[m(N,{label:"Wind speed",help:"The speed of the flow coming in at the left.",children:m(be,{label:"Wind speed",quantity:"velocity",units:s,valueSi:t.flow.speed,onCommitSi:u=>r({speed:Math.min(L.speed[1],Math.max(L.speed[0],u))})})}),m(N,{label:"Fluid",children:m(ie,{label:"Fluid",value:t.flow.fluid,options:Object.entries(qe).map(([u,h])=>({value:u,label:h.label})),onChange:u=>r({fluid:u})})}),m(N,{label:"Flow model",help:"Resolved: the grid's own flow, exact when the grid resolves the Reynolds number, otherwise run at the highest one it does. Turbulence model: Spalart–Allmaras with wall functions, at the real Reynolds number. Auto: the turbulence model from a Reynolds number of 100,000 up.",children:m(ie,{label:"Flow model",value:t.flow.model,options:[{value:"auto",label:`Auto (${d==="sa"?"turbulence model":"resolved"})`},{value:"resolved",label:"Resolved"},{value:"sa",label:"Turbulence model (SA)"}],onChange:u=>r({model:u})})}),c&&o?_("div",{className:"t2d-re","data-t2d-re":!0,"data-real":o.real,"data-sim":o.sim,"data-t2d-model":d,children:[m("div",{className:"t2d-re-row",children:_("span",{children:["Reynolds number (",Ze(c.shape),", ",pe(Ae(c.shape))," m)"]})}),_("div",{className:"t2d-re-row",children:[m("span",{className:"t2d-re-k",children:"Real"}),m("span",{className:"t2d-re-v","data-t2d-re-real":!0,children:pe(o.real)}),m("span",{className:"t2d-re-k",children:"Simulated"}),m("span",{className:"t2d-re-v","data-t2d-re-sim":!0,children:pe(o.sim)})]}),d==="sa"?m(J,{tone:o.real<3e5?"warning":void 0,children:_("span",{"data-t2d-model-note":"sa",children:["Turbulence model on (Spalart–Allmaras, wall functions) at the real Reynolds number. It gives the mean flow: attached boundary layers, lift to within about 5 % and stall to within a few degrees. Drag reads high at this grid (up to about twice the real drag), and past the stall the flow is not reliable. Turbulent eddies themselves are not drawn: 2D turbulence is not the real, 3D kind.",o.real<3e5?" Below a Reynolds number of about 300,000, real airfoils often have laminar separation bubbles this model does not capture.":""]})}):l?.capped?m(J,{tone:"warning",children:_("span",{"data-t2d-model-note":"capped",children:["This grid resolves a Reynolds number of about ",pe(o.sim)," here, so the flow is simulated at that, not at ",pe(o.real),". Wakes, shedding and separation show as they do at the lower Reynolds number, and so do the forces. A finer resolution raises it",o.real>=1e5?"; the turbulence model runs the real one":"","."]})}):null]}):m(J,{children:"Add a body to see its Reynolds number."})]})}function Xn({store:n,engine:e,units:s}){const t=Z(n,o=>o.scene),[,a]=ue(0);ae(()=>e.subscribe(()=>a(o=>o+1)),[e]);const i=o=>n.commit({...t,tunnel:{...t.tunnel,...o}}),r=e.grid,c=o=>{const l=Mt(t,Pe[o]);return`${o[0].toUpperCase()}${o.slice(1)} (${l.nx} × ${l.ny})`};return _(Ue,{title:"Tunnel",children:[m(N,{label:"Length",help:"The tunnel from inlet to outlet.",children:m(be,{label:"Length",quantity:"length",unit:Pt(s),units:s,valueSi:t.tunnel.length,onCommitSi:o=>i({length:Math.min(L.length[1],Math.max(L.length[0],o))})})}),m(N,{label:"Height",children:m(be,{label:"Height",quantity:"length",unit:Pt(s),units:s,valueSi:t.tunnel.height,onCommitSi:o=>i({height:Math.min(L.height[1],Math.max(L.height[0],o))})})}),m(N,{label:"Walls",help:"Open: no walls; the free stream goes on beyond the top and bottom, and waves and wakes pass out through them (a body in open air). Slip walls let the flow slide along them. Solid walls have boundary layers, like a real tunnel. Periodic: what leaves at the top comes in at the bottom.",children:m(ie,{label:"Walls",value:t.tunnel.walls,options:[{value:"farfield",label:"Open (no walls)"},{value:"slip",label:"Slip walls"},{value:"noslip",label:"Solid"},{value:"periodic",label:"Periodic"}],onChange:o=>i({walls:o})})}),m(N,{label:"Resolution",help:"Cells in the grid. Finer grids show more detail and a higher Reynolds number, and run slower. Auto picks the finest this GPU runs smoothly.",children:m(ie,{label:"Resolution",value:t.tunnel.resolution,options:[{value:"auto",label:t.tunnel.resolution==="auto"&&r?`Auto (${r.nx} × ${r.ny})`:"Auto"},...["low","medium","high","ultra"].map(o=>({value:o,label:c(o)}))],onChange:o=>i({resolution:o})})}),m(J,{children:"The shaded strips at the inlet and the outlet absorb pressure waves; the flow there is not physical."})]})}const jn=[{value:"particles",label:"Flow with particles"},{value:"vorticity",label:"Vorticity"},{value:"speed",label:"Speed"},{value:"pressure",label:"Pressure (Cp)"},{value:"schlieren",label:"Density gradient (schlieren)"},{value:"rheoscopic",label:"Rheoscopic (flakes in a tank)"},{value:"none",label:"None (markers on a dark background)"}];function Yn({store:n}){const e=Z(n,t=>t.scene),s=t=>n.commit({...e,view:{...e.view,...t}},!1);return _(Ue,{title:"View",children:[m(N,{label:"Show",children:m(ie,{label:"Show",value:e.view.field,options:jn,onChange:t=>s({field:t})})}),e.view.field==="particles"?m(N,{label:"Colour by",help:"The flow's speed or its vorticity, drawn under the particles; each particle is a lighter shade of the colour where it is.",children:m(ie,{label:"Colour by",value:e.view.particleColor,options:[{value:"speed",label:"Speed"},{value:"vorticity",label:"Vorticity"}],onChange:t=>s({particleColor:t})})}):null,e.view.field==="rheoscopic"?m(N,{label:"Flakes",help:"How the tank looks: the flakes' colour and the two lights over it. Flakes lie flat and tilt with the flow, and catch the light where the flow shears and turns; still water goes dull.",children:m(ie,{label:"Flakes",value:e.view.rheoPreset,options:[{value:"kalliroscope",label:"Kalliroscope blue"},{value:"pearl",label:"Pearl"},{value:"copper",label:"Copper"}],onChange:t=>s({rheoPreset:t})})}):null,m(N,{label:"Colour range",help:"Automatic follows the flow; turn it off to fix the range (in the legend's units).",children:m(Re,{label:"Automatic colour range",checked:e.view.autoRange,onChange:t=>s({autoRange:t})})}),m(N,{label:"Run speed",help:"As fast as possible runs as many steps as the GPU manages each frame. Real time slows it to the speed of the real flow, when the GPU is fast enough.",children:m(ie,{label:"Run speed",value:e.view.speed,options:[{value:"max",label:"As fast as possible"},{value:"realtime",label:"Real time"}],onChange:t=>s({speed:t})})})]})}function Ps(n,e,s){const{length:t,height:a}=n.tunnel,i=bt(Ie(e)),r=n.bodies.map(l=>({x:l.x,y:l.y,r:bt(Ie(l.shape))})),c=(l,d)=>r.every(u=>Math.hypot(u.x-l,u.y-d)>(u.r+i)*1.1);let o={x:t*.35,y:a/2};e:for(const l of[.3,.42,.54,.66,.24])for(const d of[.5,.3,.7,.2,.8]){const u=t*l,h=a*d;if(!(h-i<0||h+i>a)&&c(u,h)){o={x:u,y:h};break e}}return{id:Tt(),name:s,shape:e,x:o.x,y:o.y,angle:0,spin:0,enabled:!0,locked:!1}}function Kt(n,e){const s=n.get().scene,t=s.tunnel.height,a={naca:[{kind:"naca",code:"0012",chord:t/4},"NACA 0012"],circle:[{kind:"circle",diameter:t/10},"Cylinder"],rect:[{kind:"rect",width:t/8,height:t/8},"Rectangle"],ellipse:[{kind:"ellipse",width:t/5,height:t/10},"Ellipse"],plate:[{kind:"plate",length:t/4,thickness:t/80},"Flat plate"]},[i,r]=a[e],c=Ps(s,i,r);n.commit({...s,bodies:[...s.bodies,c]}),n.select(c.id)}function Kn({store:n,ws:e}){const s=Z(n,o=>o.scene),t=Z(n,o=>o.selected),a=_e(null),i=s.bodies.length>=L.maxBodies,r=async o=>{try{const l=dn(await o.text(),o.name),d=n.get().scene,u=Ps(d,{kind:"dat",name:l.name,x:l.x,y:l.y,chord:d.tunnel.height/4},l.name);n.commit({...d,bodies:[...d.bodies,u]}),n.select(u.id),e.ui.toast(l.warnings.length?`Imported ${l.name}. ${l.warnings.join(" ")}`:`Imported ${l.name}.`,{kind:"success"})}catch(l){e.ui.toast(l instanceof ne?`${o.name}: ${l.message}`:`${o.name} could not be read: ${String(l)}`,{kind:"error"})}},c=o=>{const l=n.get().scene;n.commit({...l,bodies:l.bodies.filter(d=>d.id!==o.id)}),e.ui.toast(`Removed ${o.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})};return _(Ue,{title:"Bodies",children:[_("div",{className:"t2d-add-row",children:[m(xe,{variant:"secondary",disabled:i,onClick:()=>Kt(n,"naca"),attrs:{"data-t2d-add":"naca"},children:"Add airfoil"}),m(ie,{label:"Add shape",value:"",disabled:i,options:[{value:"",label:"Add shape…"},{value:"circle",label:"Cylinder"},{value:"rect",label:"Rectangle"},{value:"ellipse",label:"Ellipse"},{value:"plate",label:"Flat plate"}],onChange:o=>o&&Kt(n,o)}),m(xe,{variant:"neutral",disabled:i,onClick:()=>a.current?.click(),attrs:{"data-t2d-import":"1"},children:"Import .dat…"}),m("input",{ref:a,type:"file",accept:".dat,.txt",hidden:!0,"data-t2d-file":!0,onChange:o=>{const l=o.target.files?.[0];o.target.value="",l&&r(l)}})]}),i?_(J,{tone:"warning",children:["A tunnel holds at most ",L.maxBodies," bodies."]}):null,s.bodies.length===0?m(J,{children:"No bodies yet: add an airfoil or a shape, or import an airfoil’s .dat file."}):null,m("ul",{className:"t2d-body-list",role:"listbox","aria-label":"Bodies",children:s.bodies.map(o=>_("li",{role:"option","aria-selected":o.id===t,className:`t2d-body-row${o.id===t?" is-selected":""}${o.enabled?"":" is-off"}`,"data-t2d-body":o.id,onClick:()=>n.select(o.id),children:[m("span",{className:"t2d-body-name",children:o.name}),m("span",{className:"t2d-body-kind",children:Ze(o.shape)===o.name?"":Ze(o.shape)}),m("button",{type:"button",className:"t2d-icon-btn",title:o.enabled?"Take it out of the flow":"Put it in the flow","aria-label":o.enabled?`Take ${o.name} out of the flow`:`Put ${o.name} in the flow`,"aria-pressed":o.enabled,onClick:l=>{l.stopPropagation(),n.updateBody(o.id,{enabled:!o.enabled})},children:m(He,{path:o.enabled?"M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6":"M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6",size:14})}),m("button",{type:"button",className:"t2d-icon-btn",title:`Remove ${o.name}`,"aria-label":`Remove ${o.name}`,onClick:l=>{l.stopPropagation(),c(o)},children:m(He,{name:"trash",size:14})})]},o.id))})]})}function Ht(n,e){const s=n.spinCap(e.id);return s!==null&&Math.abs(e.spin)>s?s:null}function Hn({store:n,ws:e,units:s,engine:t}){const a=Z(n,b=>b.scene),i=Z(n,b=>b.selected),[r,c]=ue(""),o=a.bodies.find(b=>b.id===i);if(ae(()=>c(""),[i]),!o)return m(Ue,{title:"Body",attr:"body",children:m(J,{children:"Select a body to edit it. Drag a body to move it, and drag the round handle above it to turn it (Shift: whole degrees)."})});const l=Pt(s),d=b=>n.updateBody(o.id,b),u=b=>d({shape:{...o.shape,...b}}),h=b=>Math.max(1e-4,Math.min(1e3,b)),f=(b,A,M,g)=>m(N,{label:b,help:g,children:m(be,{label:b,quantity:"length",unit:l,units:s,valueSi:A,onCommitSi:v=>M(h(v))})});let x=null;switch(o.shape.kind){case"naca":{const b=o.shape.code;x=_(ot,{children:[m(N,{label:"NACA designation",help:"4 or 5 digits, such as 2412 or 23012.",children:m(Yt,{label:"NACA designation",attr:"naca",value:b,error:r,onCommit:A=>{try{const M=St(A);c("");const g=o.name===`NACA ${b}`?`NACA ${M}`:o.name;d({shape:{...o.shape,code:M},name:g})}catch(M){c(M instanceof ve?M.message:String(M))}}})}),r?m(J,{tone:"danger",children:m("span",{"data-t2d-naca-error":!0,children:r})}):null,f("Chord",o.shape.chord,A=>u({chord:A}))]});break}case"dat":x=f("Chord",o.shape.chord,b=>u({chord:b}));break;case"circle":x=f("Diameter",o.shape.diameter,b=>u({diameter:b}));break;case"rect":case"ellipse":x=_(ot,{children:[f("Width",o.shape.width,b=>u({width:b}),"Along the flow, before turning."),f("Height",o.shape.height,b=>u({height:b}))]});break;case"plate":x=_(ot,{children:[f("Length",o.shape.length,b=>u({length:b})),f("Thickness",o.shape.thickness,b=>u({thickness:b}),"A plate thinner than about two cells of the grid is drawn thicker than it is.")]});break}const p=t.lattice?.dx??0,w=o.shape.kind==="plate"&&p>0&&o.shape.thickness<2*p;return _(Ue,{title:"Body",attr:"body",children:[m(N,{label:"Name",children:m(Yt,{label:"Name",attr:"name",value:o.name,onCommit:b=>d({name:b.trim().slice(0,80)||o.name})})}),m("div",{className:"t2d-shape-kind",children:Ze(o.shape)}),x,w?_(J,{tone:"warning",children:["This plate is thinner than two grid cells (",pe(_s("length",2*p,s==="imperial"?"in":"mm"))," ",s==="imperial"?"in":"mm","): the flow sees a thicker one."]}):null,f("Position x",o.x,b=>d({x:Math.min(a.tunnel.length,Math.max(0,b))}),o.shape.kind==="naca"||o.shape.kind==="dat"?"Of the quarter chord, from the inlet.":"Of the centre, from the inlet."),m(N,{label:"Position y",help:"From the bottom wall.",children:m(be,{label:"Position y",quantity:"length",unit:l,units:s,valueSi:o.y,onCommitSi:b=>d({y:Math.min(a.tunnel.height,Math.max(0,b))})})}),m(N,{label:o.shape.kind==="naca"||o.shape.kind==="dat"?"Angle of attack":"Angle",help:"Positive raises the leading (left) side.",children:m(be,{label:"Angle",unit:"°",valueSi:o.angle,onCommitSi:b=>d({angle:Math.max(-180,Math.min(180,b))})})}),m(N,{label:"Spin",help:"Turns the body continuously; positive is counter-clockwise. A spinning cylinder shows the Magnus effect.",children:m(be,{label:"Spin",quantity:"angular_velocity",unit:"rpm",units:s,valueSi:o.spin,onCommitSi:b=>d({spin:Math.max(-1e4,Math.min(1e4,b))})})}),Ht(t,o)?m(J,{tone:"warning",children:_("span",{"data-t2d-spin-capped":!0,children:["This spin is held to ",pe(Ht(t,o)*(60/(2*Math.PI)))," rpm: the body’s edge would move faster than twice the wind speed, more than the lattice can carry."]})}):null,m(N,{label:"In the flow",children:m(Re,{label:"In the flow",checked:o.enabled,onChange:b=>d({enabled:b})})}),m(N,{label:"Locked",help:"A locked body cannot be dragged or turned with the mouse.",children:m(Re,{label:"Locked",checked:o.locked,onChange:b=>d({locked:b})})}),m("div",{className:"t2d-panel-foot",children:m(xe,{variant:"danger",onClick:()=>{const b=n.get().scene;n.commit({...b,bodies:b.bodies.filter(A=>A.id!==o.id)}),e.ui.toast(`Removed ${o.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})},attrs:{"data-t2d-remove":o.id},children:"Remove body"})})]})}const Qn={streaks:"Streaks",timelines:"Timelines",dye:"Dye"},Zn=["Blue","Purple","Green","Orange","Sky blue","Pink"],Jn=n=>`var(--mg-series-${n%et+1})`;function As({title:n,children:e,attr:s}){return _("section",{className:"t2d-section","data-t2d-section":s,children:[m("h2",{className:"t2d-section-title",children:n}),m("div",{className:"t2d-section-body",children:e})]})}function ke(n,e){const s=n.rakes.filter(t=>t.kind===e.kind);return`${Qn[e.kind]} ${s.indexOf(e)+1}`}function ei(n,e){const s=n.get().scene,{length:t,height:a}=s.tunnel,i=new Set(s.rakes.map(d=>d.color));let r=0;for(;i.has(r)&&r<et-1;)r++;const c=s.rakes.length,o=t*(.1+.02*(c%4)),l={id:ds(),kind:e,x0:o,y0:a*.3,x1:o,y1:a*.7,emitters:e==="dye"?7:12,color:r,enabled:!0};n.commit({...s,rakes:[...s.rakes,l]}),n.select(l.id)}function ti({store:n,ws:e}){const s=Z(n,l=>l.scene),t=Z(n,l=>l.selected),a=s.view,i=l=>n.commit({...s,view:{...a,...l}},!1),r=s.rakes.filter(l=>l.kind==="dye").length,c=s.rakes.length>=L.maxRakes,o=l=>{const d=n.get().scene;n.commit({...d,rakes:d.rakes.filter(u=>u.id!==l.id)}),e.ui.toast(`Removed ${ke(s,l)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})};return _(As,{title:"Flow markers",attr:"markers",children:[a.field==="particles"?m(J,{children:"The particles view shows the tracer particles; here you set how many and their trails."}):m(N,{label:"Tracer particles",help:"Particles carried by the flow, drawn faintly over the field.",children:m(Re,{label:"Tracer particles",checked:a.tracers,onChange:l=>i({tracers:l})})}),m(N,{label:"Particle count",children:m(ie,{label:"Particle count",value:a.density,disabled:!a.tracers&&a.field!=="particles",options:[{value:"low",label:"Few"},{value:"normal",label:"Normal"},{value:"high",label:"Many"}],onChange:l=>i({density:l})})}),m(N,{label:"Streaks",help:"Each particle is drawn as a short streak along its motion.",children:m(ie,{label:"Streaks",value:a.trail,options:[{value:"off",label:"Dots"},{value:"short",label:"Short"},{value:"long",label:"Long"}],onChange:l=>i({trail:l})})}),m(N,{label:"Velocity arrows",children:m(Re,{label:"Velocity arrows",checked:a.arrows,onChange:l=>i({arrows:l})})}),m(N,{label:"Streamlines",help:"Lines along the flow’s direction now, from just past the inlet. In shedding flow they differ from the particles’ paths.",children:m(Re,{label:"Streamlines",checked:a.streamlines,onChange:l=>i({streamlines:l})})}),m("div",{className:"t2d-add-row",children:m(ie,{label:"Add rake",value:"",disabled:c,options:[{value:"",label:"Add rake…"},{value:"streaks",label:"Streaks (a thread from each emitter)"},{value:"timelines",label:"Timelines (a line released at intervals)"},{value:"dye",label:"Dye",disabled:r>=L.maxDyeRakes}],onChange:l=>l&&ei(n,l)})}),c?_(J,{tone:"warning",children:["A tunnel holds at most ",L.maxRakes," rakes."]}):null,r>=L.maxDyeRakes?_(J,{children:["At most ",L.maxDyeRakes," dye rakes: one colour each."]}):null,s.rakes.length?m("ul",{className:"t2d-body-list",role:"listbox","aria-label":"Rakes",children:s.rakes.map(l=>_("li",{role:"option","aria-selected":l.id===t,className:`t2d-body-row${l.id===t?" is-selected":""}${l.enabled?"":" is-off"}`,"data-t2d-rake":l.id,onClick:()=>n.select(l.id),children:[m("span",{className:"t2d-swatch",style:{background:Jn(l.color)}}),m("span",{className:"t2d-body-name",children:ke(s,l)}),m("span",{className:"t2d-body-kind"}),m("button",{type:"button",className:"t2d-icon-btn","aria-pressed":l.enabled,"aria-label":l.enabled?`Stop ${ke(s,l)}`:`Start ${ke(s,l)}`,title:l.enabled?"Stop it":"Start it",onClick:d=>{d.stopPropagation();const u=n.get().scene;n.commit({...u,rakes:u.rakes.map(h=>h.id===l.id?{...h,enabled:!h.enabled}:h)})},children:m(He,{path:l.enabled?"M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6":"M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6",size:14})}),m("button",{type:"button",className:"t2d-icon-btn","aria-label":`Remove ${ke(s,l)}`,title:"Remove it",onClick:d=>{d.stopPropagation(),o(l)},children:m(He,{name:"trash",size:14})})]},l.id))}):m(J,{children:"A rake releases streaks, timelines or dye from a line you place and drag in the tunnel."})]})}function si({store:n,ws:e,units:s,rake:t}){const a=Z(n,f=>f.scene),i=s==="imperial"?"ft":"m",r=f=>{const x=n.get().scene;n.commit({...x,rakes:x.rakes.map(p=>p.id===t.id?{...p,...f}:p)})},{length:c,height:o}=a.tunnel,l=f=>Math.min(c,Math.max(0,f)),d=f=>Math.min(o,Math.max(0,f)),u=a.rakes.filter(f=>f.kind==="dye"&&f.id!==t.id).length,h=(f,x,p)=>m(N,{label:f,children:m(be,{label:f,quantity:"length",unit:i,units:s,valueSi:x,onCommitSi:p})});return _(As,{title:"Rake",attr:"rake",children:[m("div",{className:"t2d-shape-kind","data-t2d-rake-name":!0,children:ke(a,t)}),m(N,{label:"Releases",children:m(ie,{label:"Releases",value:t.kind,options:[{value:"streaks",label:"Streaks"},{value:"timelines",label:"Timelines"},{value:"dye",label:"Dye",disabled:u>=L.maxDyeRakes}],onChange:f=>r({kind:f})})}),t.kind!=="timelines"?m(N,{label:"Emitters",help:"Points along the rake that release the markers.",children:m(be,{label:"Emitters",valueSi:t.emitters,onCommitSi:f=>r({emitters:Math.round(Math.min(L.emitters[1],Math.max(L.emitters[0],f)))})})}):null,m(N,{label:"Colour",children:m(ie,{label:"Colour",value:String(t.color),options:Zn.map((f,x)=>({value:String(x),label:f})),onChange:f=>r({color:Number(f)})})}),h("Start x",t.x0,f=>r({x0:l(f)})),h("Start y",t.y0,f=>r({y0:d(f)})),h("End x",t.x1,f=>r({x1:l(f)})),h("End y",t.y1,f=>r({y1:d(f)})),m(N,{label:"Releasing",children:m(Re,{label:"Releasing",checked:t.enabled,onChange:f=>r({enabled:f})})}),m(J,{children:"Drag the rake to move it, or one of its ends to stretch or turn it."}),m("div",{className:"t2d-panel-foot",children:m(xe,{variant:"danger",attrs:{"data-t2d-remove-rake":t.id},onClick:()=>{const f=n.get().scene;n.commit({...f,rakes:f.rakes.filter(x=>x.id!==t.id)}),e.ui.toast(`Removed ${ke(a,t)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})},children:"Remove rake"})})]})}const ni=26,gt=7,We=new Map;function ii(n){const e=JSON.stringify(n.shape);let s=We.get(e);return s||(s=Ie(n.shape),We.size>64&&We.clear(),We.set(e,s)),s}function Be(n,e){return Rt(ii(n),{x:e.x,y:e.y,theta:-e.angle*Math.PI/180})}function Ss(n,e){const s=n.worldView,t=(o,l)=>({x:s.w/2+(o-s.cx)/s.mpp,y:s.h/2-(l-s.cy)/s.mpp}),a=n.livePose(e.id)??{x:e.x,y:e.y,angle:e.angle},i=Be(e,a);let r=1/0;for(let o=1;o<i.length;o+=2)r=Math.min(r,t(0,i[o]).y);const c=t(a.x,a.y);return{x:c.x,y:r-ni,cx:c.x,cy:c.y}}function Ke(n,e){const s=n.worldView,{length:t,height:a}=e.tunnel,i=Math.max(t/Math.max(50,s.w-32),a/Math.max(50,s.h-32));n.worldView={...s,cx:t/2,cy:a/2,mpp:i}}function ai({engine:n,store:e,onStatus:s}){const t=_e(null),a=_e(null),i=_e(null),r=_e(null),c=_e("");ae(()=>{const g=t.current,v=new ResizeObserver(()=>{const k=g.getBoundingClientRect(),B=window.devicePixelRatio||1,S=n.canvas;S.width=Math.max(1,Math.round(k.width*B)),S.height=Math.max(1,Math.round(k.height*B));const R=i.current;R.width=S.width,R.height=S.height,n.worldView={...n.worldView,w:k.width,h:k.height,dpr:B};const P=e.get().scene,y=`${P.tunnel.length}x${P.tunnel.height}`;c.current!==y&&(Ke(n,P),c.current=y)});return v.observe(g),()=>v.disconnect()},[n,e]),ae(()=>{const g=a.current;return g.replaceWith(n.canvas),n.canvas.className="t2d-canvas",n.canvas.setAttribute("data-t2d-canvas","1"),()=>{n.canvas.replaceWith(g)}},[n]),ae(()=>e.subscribe(()=>{const g=e.get().scene,v=`${g.tunnel.length}x${g.tunnel.height}`;c.current&&c.current!==v&&(Ke(n,g),c.current=v)}),[n,e]);const o=(g,v)=>{const k=t.current.getBoundingClientRect(),B=n.worldView;return{x:B.cx+(g-k.left-B.w/2)*B.mpp,y:B.cy-(v-k.top-B.h/2)*B.mpp}},l=(g,v)=>{const k=n.worldView;return{x:k.w/2+(g-k.cx)/k.mpp,y:k.h/2-(v-k.cy)/k.mpp}},d=g=>n.livePose(g.id)??{x:g.x,y:g.y,angle:g.angle},u=g=>Ss(n,g);ae(()=>{let g=0;const v=getComputedStyle(document.documentElement),k=v.getPropertyValue("--t2d-select").trim()||"black",B=v.getPropertyValue("--t2d-ghost").trim()||"gray",S=v.getPropertyValue("--mg-bg").trim()||"white",R=()=>{g=requestAnimationFrame(R);const P=i.current;if(!P)return;const y=P.getContext("2d"),$=n.worldView;y.setTransform($.dpr,0,0,$.dpr,0,0),y.clearRect(0,0,$.w,$.h);const{scene:T,selected:G}=e.get(),E=r.current;for(const C of T.rakes){const O=v.getPropertyValue(`--mg-series-${C.color%6+1}`).trim()||k,q=l(C.x0,C.y0),V=l(C.x1,C.y1),he=C.id===G;if(y.globalAlpha=C.enabled?1:.45,y.beginPath(),y.moveTo(q.x,q.y),y.lineTo(V.x,V.y),y.strokeStyle=O,y.lineWidth=he?3:2,y.setLineDash(C.kind==="timelines"?[6,4]:[]),y.stroke(),y.setLineDash([]),C.kind!=="timelines"){y.fillStyle=O;for(let U=0;U<C.emitters;U++){const z=C.emitters===1?.5:U/(C.emitters-1);y.beginPath(),y.arc(q.x+(V.x-q.x)*z,q.y+(V.y-q.y)*z,2.5,0,Math.PI*2),y.fill()}}if(he)for(const U of[q,V])y.fillStyle=S,y.strokeStyle=O,y.lineWidth=2,y.fillRect(U.x-5,U.y-5,10,10),y.strokeRect(U.x-5,U.y-5,10,10);y.globalAlpha=1}for(const C of T.bodies){const O=C.id===G,q=E&&(E.kind==="move"||E.kind==="turn")&&E.id===C.id?{x:E.kind==="move"?E.bodyX:E.x,y:E.kind==="move"?E.bodyY:E.y,angle:E.angle}:null,V=d(C),he=U=>{y.beginPath();for(let z=0;z<U.length;z+=2){const ee=l(U[z],U[z+1]);z===0?y.moveTo(ee.x,ee.y):y.lineTo(ee.x,ee.y)}y.closePath()};if(C.enabled||(he(Be(C,V)),y.setLineDash([4,4]),y.strokeStyle=B,y.lineWidth=1.5,y.stroke(),y.setLineDash([])),q&&(Math.abs(q.x-V.x)>1e-6||Math.abs(q.y-V.y)>1e-6||Math.abs(q.angle-V.angle)>.001)&&(he(Be(C,q)),y.setLineDash([5,4]),y.strokeStyle=B,y.lineWidth=1.5,y.stroke(),y.setLineDash([])),O){if(he(Be(C,V)),y.strokeStyle=k,y.lineWidth=2,y.stroke(),!C.locked){const z=u(C);y.beginPath(),y.moveTo(z.cx,z.cy),y.lineTo(z.x,z.y+gt),y.strokeStyle=k,y.lineWidth=1,y.stroke(),y.beginPath(),y.arc(z.x,z.y,gt,0,Math.PI*2),y.fillStyle=S,y.fill(),y.lineWidth=2,y.stroke()}const U=l(V.x,V.y);y.beginPath(),y.moveTo(U.x-5,U.y),y.lineTo(U.x+5,U.y),y.moveTo(U.x,U.y-5),y.lineTo(U.x,U.y+5),y.lineWidth=1.5,y.stroke()}}};return g=requestAnimationFrame(R),()=>cancelAnimationFrame(g)},[n,e]);const h=(g,v)=>{const k=e.get().scene.bodies;for(let B=k.length-1;B>=0;B--){const S=k[B];if(Qe(Be(S,d(S)),g,v))return S}return null},f=(g,v)=>{const k=t.current.getBoundingClientRect(),B=g-k.left,S=v-k.top,{scene:R,selected:P}=e.get();for(let y=R.rakes.length-1;y>=0;y--){const $=R.rakes[y],T=l($.x0,$.y0),G=l($.x1,$.y1);if($.id===P){if(Math.hypot(B-T.x,S-T.y)<=8)return{rake:$,part:"start"};if(Math.hypot(B-G.x,S-G.y)<=8)return{rake:$,part:"end"}}const E=G.x-T.x,C=G.y-T.y,O=E*E+C*C,q=O>0?Math.max(0,Math.min(1,((B-T.x)*E+(S-T.y)*C)/O)):0;if(Math.hypot(B-(T.x+q*E),S-(T.y+q*C))<=6)return{rake:$,part:"all"}}return null},x=(g,v)=>{const k=e.get().scene.tunnel;return{x:Math.min(k.length,Math.max(0,g)),y:Math.min(k.height,Math.max(0,v))}},p=g=>{g.target.setPointerCapture(g.pointerId);const v=o(g.clientX,g.clientY),k=n.worldView;if(g.button===1){r.current={kind:"pan",startX:g.clientX,startY:g.clientY,cx:k.cx,cy:k.cy};return}if(g.button!==0)return;const{scene:B,selected:S}=e.get(),R=B.bodies.find($=>$.id===S);if(R&&!R.locked){const $=u(R),T=t.current.getBoundingClientRect();if(Math.hypot(g.clientX-T.left-$.x,g.clientY-T.top-$.y)<=gt+4){const G=d(R),E=Math.atan2(v.y-G.y,v.x-G.x);r.current={kind:"turn",id:R.id,startAngle:R.angle,pointerStart:E,angle:R.angle,x:R.x,y:R.y};return}}const P=f(g.clientX,g.clientY);if(P){e.select(P.rake.id),r.current={kind:"rake",id:P.rake.id,part:P.part,startX:v.x,startY:v.y,r0:P.rake,before:e.get().scene};return}const y=h(v.x,v.y);if(y){e.select(y.id),y.locked||(r.current={kind:"move",id:y.id,startX:v.x,startY:v.y,bodyX:y.x,bodyY:y.y,angle:y.angle,moved:!1});return}e.select(null),r.current={kind:"pan",startX:g.clientX,startY:g.clientY,cx:k.cx,cy:k.cy}},w=g=>{const v=r.current;if(!v){const S=o(g.clientX,g.clientY),R=f(g.clientX,g.clientY),P=R?null:h(S.x,S.y);t.current.style.cursor=R?R.part==="all"?"move":"crosshair":P&&!P.locked?"grab":"default";return}if(v.kind==="rake"){const S=o(g.clientX,g.clientY),R=S.x-v.startX,P=S.y-v.startY,y=v.r0,$=x(y.x0+(v.part==="end"?0:R),y.y0+(v.part==="end"?0:P)),T=x(y.x1+(v.part==="start"?0:R),y.y1+(v.part==="start"?0:P)),G=e.get().scene;e.commit({...G,rakes:G.rakes.map(E=>E.id===v.id?{...E,x0:$.x,y0:$.y,x1:T.x,y1:T.y}:E)},!1);return}if(v.kind==="pan"){const S=n.worldView;n.worldView={...S,cx:v.cx-(g.clientX-v.startX)*S.mpp,cy:v.cy+(g.clientY-v.startY)*S.mpp};return}const k=o(g.clientX,g.clientY),B=e.get().scene.bodies.find(S=>S.id===v.id);if(B)if(v.kind==="move"){const S=x(B.x+(k.x-v.startX),B.y+(k.y-v.startY));v.bodyX=S.x,v.bodyY=S.y,v.moved=!0,t.current.style.cursor="grabbing",n.setTarget(v.id,{x:S.x,y:S.y,angle:v.angle}),s?.(`x ${S.x.toFixed(3)} m, y ${S.y.toFixed(3)} m`)}else{const S=d(B),R=Math.atan2(k.y-S.y,k.x-S.x);let P=v.startAngle-(R-v.pointerStart)*180/Math.PI;P=((P+180)%360+360)%360-180,g.shiftKey&&(P=Math.round(P)),v.angle=P,n.setTarget(v.id,{x:v.x,y:v.y,angle:P}),s?.(`Angle ${P.toFixed(1)}°`)}},b=()=>{const g=r.current;if(r.current=null,s?.(""),!(!g||g.kind==="pan")){if(g.kind==="rake"){const v=e.get().scene;v!==g.before&&e.commitFrom(g.before,v);return}g.kind==="move"&&g.moved&&e.updateBody(g.id,{x:g.bodyX,y:g.bodyY}),g.kind==="turn"&&e.updateBody(g.id,{angle:g.angle}),n.setTarget(g.id,null)}};return _("div",{ref:t,className:"t2d-viewport","data-t2d-viewport":!0,onPointerDown:p,onPointerMove:w,onPointerUp:b,onPointerCancel:b,onWheel:g=>{const v=n.worldView,k=o(g.clientX,g.clientY),B=e.get().scene.tunnel,S=Math.min(Math.max(B.length,B.height)/50,Math.max(B.length/1e5,v.mpp*Math.exp(g.deltaY*.0015)));n.worldView={...v,mpp:S};const R=o(g.clientX,g.clientY);n.worldView={...n.worldView,cx:n.worldView.cx+(k.x-R.x),cy:n.worldView.cy+(k.y-R.y)}},onDoubleClick:g=>{const v=o(g.clientX,g.clientY);h(v.x,v.y)||Ke(n,e.get().scene)},onContextMenu:g=>g.preventDefault(),children:[m("canvas",{ref:a}),m("canvas",{ref:i,className:"t2d-overlay"})]})}function ri(n,e,s){const t=e.flow.speed;switch(n){case"vorticity":return{title:"Vorticity",unit:"1/s",k:t/s,centred:!0};case"speed":return{title:"Speed",unit:"m/s",k:t,centred:!1};case"pressure":return{title:"Pressure coefficient Cp",unit:"",k:1,centred:!0};case"schlieren":return{title:"Density gradient (relative)",unit:"",k:1,centred:!1};case"particles":return e.view.particleColor==="vorticity"?{title:"Vorticity",unit:"1/s",k:t/s,centred:!0}:{title:"Speed",unit:"m/s",k:t,centred:!1};case"none":case"rheoscopic":return{title:"",unit:"",k:1,centred:!1}}}function Bs(n){const[,e]=ue(0);ae(()=>{const s=setInterval(()=>e(t=>t+1),n);return()=>clearInterval(s)},[n])}function oi({engine:n,store:e}){Bs(300);const s=Z(e,i=>i.save),t=n.stats,a={saved:"Saved",pending:"Not saved yet",saving:"Saving…",failed:"Not saved",conflict:"Saved elsewhere"}[s];return _("div",{className:"t2d-status","data-t2d-status":!0,"data-state":t.state,"data-steps":t.stepsPerFrame,"data-grid":`${t.nx}x${t.ny}`,children:[m("span",{title:"The GPU the flow runs on",children:t.adapter}),_("span",{children:[t.nx," × ",t.ny," cells"]}),_("span",{children:[t.stepsPerFrame," steps a frame"]}),m("span",{title:"Simulated seconds per second",children:t.state==="running"?`×${pe(t.speedRatio)} real time`:t.state==="paused"?"Paused":"Stopped"}),performance.now()-n.limitedAt<2e3?m("span",{className:"t2d-squeeze","data-t2d-squeeze":!0,title:"Where the flow went faster, or was squeezed harder, than the lattice can carry (a body dragged fast, or a gap closing between bodies), it is held to those limits there, so the flow at that spot is approximate.",children:"Flow held to its limits where it moved too fast"}):null,_("span",{"data-t2d-simtime":t.simTime,children:["t = ",t.simTime<1?`${(t.simTime*1e3).toPrecision(3)} ms`:`${t.simTime.toPrecision(4)} s`]}),m("span",{className:`t2d-save t2d-save--${s}`,"data-t2d-save":s,children:a})]})}function li({engine:n,store:e}){Bs(400);const s=Z(e,d=>d.scene),t=s.bodies.find(d=>d.enabled),a=t?Ae(t.shape):s.tunnel.height/8,i=ri(s.view.field,s,a),r=n.autoRangeNow,c=s.view.autoRange?r?.lo??s.view.min/i.k:s.view.min/i.k,o=s.view.autoRange?r?.hi??s.view.max/i.k:s.view.max/i.k;if(ae(()=>{s.view.autoRange||n.setRange(s.view.min/i.k,s.view.max/i.k)},[n,s.view.autoRange,s.view.min,s.view.max,i.k]),s.view.field==="none"||s.view.field==="rheoscopic")return null;const l=Ms(s.view);return _("div",{className:"t2d-legend","data-t2d-legend":!0,"data-lo":c*i.k,"data-hi":o*i.k,children:[l==="inferno"?m(ci,{map:l,min:c*i.k,max:o*i.k,title:i.title,unit:i.unit}):m(Es,{map:l,min:c*i.k,max:o*i.k,title:i.title,unit:i.unit,centred:i.centred,ticks:5,format:pe}),s.view.autoRange?null:m(di,{lo:s.view.min,hi:s.view.max,onCommit:(d,u)=>e.commit({...s,view:{...s.view,min:d,max:u}},!1)})]})}function ci({map:n,min:e,max:s,title:t,unit:a}){const i=cs(n),r=Array.from({length:9},(o,l)=>{const d=Math.round(l/8*255);return`rgb(${i[3*d]}, ${i[3*d+1]}, ${i[3*d+2]}) ${l/8*100}%`}),c=Array.from({length:5},(o,l)=>e+(s-e)*l/4);return _("div",{className:"t2d-maplegend",children:[_("div",{className:"mgk-legend-title",children:[t,a?` (${a})`:""]}),m("div",{className:"mgk-legend-bar",style:{background:`linear-gradient(to right, ${r.join(", ")})`}}),m("div",{className:"mgk-legend-ticks",children:c.map((o,l)=>m("span",{children:pe(o)},l))})]})}function di({lo:n,hi:e,onCommit:s}){const[t,a]=ue(String(n)),[i,r]=ue(String(e));ae(()=>{a(String(n)),r(String(e))},[n,e]);const c=()=>{const o=Number(t),l=Number(i);Number.isFinite(o)&&Number.isFinite(l)&&l>o?s(o,l):(a(String(n)),r(String(e)))};return _("div",{className:"t2d-range",children:[m("input",{className:"mgk-input","aria-label":"Colour range minimum",value:t,onChange:o=>a(o.target.value),onBlur:c,onKeyDown:o=>o.key==="Enter"&&c()}),m("span",{children:"to"}),m("input",{className:"mgk-input","aria-label":"Colour range maximum",value:i,onChange:o=>r(o.target.value),onBlur:c,onKeyDown:o=>o.key==="Enter"&&c()})]})}function ui({ws:n,store:e,engine:s,units:t,problem:a}){const[i,r]=ue(t),[c,o]=ue(!1),[l,d]=ue(!1),[u,h]=ue(""),f=Z(e,A=>A.save),x=Z(e,A=>A.saveError),p=Z(e,A=>A.scene.rakes.find(M=>M.id===A.selected)??null);ae(()=>n.on("units",r),[n]),ae(()=>(s.onUnstable=()=>{d(!0),n.ui.toast("The flow became unstable and was stopped. Reset the flow to start again.",{kind:"error"})},()=>{s.onUnstable=null}),[s,n]);const w=()=>{s.paused=!s.paused,o(s.paused)},b=()=>{s.resetFlow(),d(!1)};return ae(()=>{const A=M=>{const g=M.target;if(g&&(g.tagName==="INPUT"||g.tagName==="SELECT"||g.tagName==="TEXTAREA"||g.isContentEditable))return;const v=M.ctrlKey||M.metaKey;if(v&&M.key.toLowerCase()==="z"&&!M.shiftKey)M.preventDefault(),e.undo();else if(v&&(M.key.toLowerCase()==="y"||M.key.toLowerCase()==="z"&&M.shiftKey))M.preventDefault(),e.redo();else if(M.key===" "&&!v)M.preventDefault(),w();else if((M.key==="Delete"||M.key==="Backspace")&&e.get().selected){M.preventDefault();const k=e.get().scene,B=k.bodies.find(R=>R.id===e.get().selected),S=k.rakes.find(R=>R.id===e.get().selected);B?(e.commit({...k,bodies:k.bodies.filter(R=>R.id!==B.id)}),n.ui.toast(`Removed ${B.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})):S&&(e.commit({...k,rakes:k.rakes.filter(R=>R.id!==S.id)}),n.ui.toast(`Removed ${ke(k,S)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"}))}else if(M.key==="Escape")e.select(null);else if(M.key.startsWith("Arrow")&&e.get().selected){const k=e.get().scene,B=k.bodies.find(P=>P.id===e.get().selected);if(!B||B.locked)return;M.preventDefault();const S=k.tunnel.height/200*(M.shiftKey?10:1),R={ArrowLeft:[-S,0],ArrowRight:[S,0],ArrowUp:[0,S],ArrowDown:[0,-S]}[M.key]??[0,0];e.updateBody(B.id,{x:Math.min(k.tunnel.length,Math.max(0,B.x+R[0])),y:Math.min(k.tunnel.height,Math.max(0,B.y+R[1]))})}};return window.addEventListener("keydown",A),()=>window.removeEventListener("keydown",A)}),_("div",{className:"t2d-app","data-t2d-app":!0,children:[_("header",{className:"t2d-toolbar",role:"toolbar","aria-label":"Tunnel",children:[m(xe,{variant:c?"primary":"secondary",onClick:w,attrs:{"data-t2d-play":c?"paused":"running"},title:"Space",children:c?"Run":"Pause"}),m(xe,{variant:"neutral",onClick:b,attrs:{"data-t2d-reset":"1"},title:"Start the flow again from a uniform stream",children:"Reset flow"}),m("span",{className:"t2d-sep"}),m(xe,{variant:"neutral",onClick:()=>e.undo(),disabled:!e.canUndo,title:"Ctrl+Z",attrs:{"data-t2d-undo":"1"},children:"Undo"}),m(xe,{variant:"neutral",onClick:()=>e.redo(),disabled:!e.canRedo,title:"Ctrl+Y",attrs:{"data-t2d-redo":"1"},children:"Redo"}),m(xe,{variant:"neutral",onClick:()=>Ke(s,e.get().scene),title:"Double-click empty space",attrs:{"data-t2d-fit":"1"},children:"Fit view"}),m("span",{className:"t2d-toolbar-hint","data-t2d-hint":!0,children:u})]}),_("div",{className:"t2d-main",children:[_("aside",{className:"t2d-side",children:[m(Wn,{store:e,engine:s,units:i}),m(Kn,{store:e,ws:n}),m(ti,{store:e,ws:n}),m(Xn,{store:e,engine:s,units:i}),m(Yn,{store:e})]}),_("div",{className:"t2d-stage",children:[a?m("div",{className:"t2d-banner",children:m(rt,{reason:`The saved tunnel could not be read (${a}), so a new one was started.`,role:"alert"})}):null,f==="conflict"||f==="failed"?m("div",{className:"t2d-banner","data-t2d-save-problem":!0,children:m(rt,{reason:f==="conflict"?x:`The tunnel could not be saved: ${x}`,role:"alert"})}):null,l?m("div",{className:"t2d-banner","data-t2d-unstable":!0,children:m(rt,{reason:"The flow became unstable and was stopped.",fix:{label:"Reset flow",onFix:b},role:"alert"})}):null,m(ai,{engine:s,store:e,onStatus:h}),m(li,{engine:s,store:e}),m(oi,{engine:s,store:e})]}),m("aside",{className:"t2d-side t2d-side--right",children:p?m(si,{store:e,ws:n,units:i,rake:p}):m(Hn,{store:e,ws:n,units:i,engine:s})})]})]})}const hi=400,Rs=n=>`studies/${n}/scene.json`;async function fi(n,e){const s=Rs(e),t=await n.files.stat(s);if(!t)return{scene:je(),etag:null,problem:""};const a=await n.files.read(s);if(!a)return{scene:je(),etag:null,problem:""};try{return{scene:yn(JSON.parse(new TextDecoder().decode(a))),etag:t.etag,problem:""}}catch(i){return{scene:je(),etag:t.etag,problem:i instanceof Error?i.message:String(i)}}}class pi{constructor(e,s,t,a){this.ws=e,this.store=s,this.studyId=t,this.etag=a}timer=null;latest=null;writing=null;schedule(e){this.store.get().save!=="conflict"&&(this.latest=e,this.store.setSave("pending"),this.ws.nav.setDirty(!0,"The tunnel’s last changes are not saved yet."),this.timer&&clearTimeout(this.timer),this.timer=setTimeout(()=>void this.flush(),hi))}async flush(){this.timer&&clearTimeout(this.timer),this.timer=null,this.writing&&await this.writing;const e=this.latest;e&&(this.latest=null,this.store.setSave("saving"),this.writing=(async()=>{try{const s=await this.ws.files.write(Rs(this.studyId),JSON.stringify(e,null,1),{ifMatch:this.etag});this.etag=s.etag,this.latest||(this.store.setSave("saved"),await this.ws.nav.setDirty(!1))}catch(s){s?.code==="changed"?(this.store.setSave("conflict","This tunnel was saved from another tab. Reopen it to see that version; changes here are not saved."),await this.ws.nav.setDirty(!1)):(this.latest=this.latest??e,this.store.setSave("failed",s instanceof Error?s.message:String(s)))}finally{this.writing=null}})(),await this.writing)}async create(e){this.latest=e,await this.flush()}}function mi(n,e,s,t,a=.3){const i=2/(s*s*t),r=n.length,c=Math.floor(r*(1-a));let o=0;for(let p=c;p<r;p++)o+=e[p]*i;o/=r-c;const l=[];for(let p=c+1;p<r;p++){const w=e[p-1]*i-o,b=e[p]*i-o;w<0&&b>=0&&l.push(p-1+w/(w-b))}let d=-1/0,u=0,h=-1/0;for(let p=c;p<r;p++)d=Math.max(d,n[p]*i),u+=n[p]*i,h=Math.max(h,e[p]*i);const f=l.length-1,x=f>0?(l[l.length-1]-l[0])/f:NaN;return{St:t/(x*s),cdMax:d,cdMean:u/(r-c),clMax:h,periods:f}}async function yi(n,e=20,s=200,t){const a=Math.round(4.1*e),i=22*e,r=.05,c=2/3*r,o=c*e/100,l=new st(n,{nx:i,ny:a,walls:"noslip",profile:1,absorbing:!1});l.setPhysics({u:r,tau:3*o+.5,smagorinsky:!1,smagCs:0}),l.reset(0);const d=Ie({kind:"circle",diameter:e}),u=Ct(d),h={x:2*e,y:-.5+2*e,theta:0};l.setBodies([{key:"cyl",sdf:u,from:h,to:h}]);const f=Math.ceil(s*e/c),x=new Float64Array(f),p=new Float64Array(f),w=performance.now();let b=0,A=0;const M=Math.ceil(2*e/c);for(let v=0;v<f;){const k=Math.min(re,f-v,v<M?200:re),B=v<M?.5*(1-Math.cos(Math.PI*v/M)):1;l.setPhysics({u:r*B,tau:3*o+.5,smagorinsky:!1,smagCs:0});const S=n.createCommandEncoder();l.encodeFrame(S,k,{mode:1,uRef:r,lRef:e});const R=l.prepareRead(S,k);n.queue.submit([S.finish()]);const P=await R();if(!P)throw new Error("The force readback failed.");for(let y=0;y<k;y++)x[v+y]=P.forces[0].perStep[2*y],p[v+y]=P.forces[0].perStep[2*y+1];if(b+=P.bad,A+=P.limited,v+=k,b)break}l.destroy();const g=mi(x,p,c,e);return{N:e,steps:f,seconds:(performance.now()-w)/1e3,...g,bad:b,limited:A}}const Qt=Math.exp(-Ce*ns);function gi(n){let e=Math.min(Math.sqrt(Math.max(n,0)),45);for(let s=0;s<40;s++){const t=Ce*e,a=Math.exp(t),i=e+Qt*(a-1-t-.5*t*t-t*t*t/6),r=1+Qt*Ce*(a-1-t-.5*t*t),c=Math.max(e-(i*e-n)/(r*e+i),1e-4);if(Math.abs(c-e)<1e-10*e)return c;e=c}return e}function At(n,e,s){const t=Math.min(Math.max(e,0),n.nx-1.001),a=Math.min(Math.max(s,0),n.ny-1.001),i=Math.floor(t),r=Math.floor(a),c=t-i,o=a-r;let l=0,d=0,u=0,h=0;for(let f=0;f<4;f++){const x=f&1,p=f>>1,w=(r+p)*n.nx+i+x;if(n.mac[4*w+3]>.5)continue;const b=(x?c:1-c)*(p?o:1-o);l+=b*n.mac[4*w],d+=b*n.mac[4*w+1],u+=b*n.mac[4*w+2],h+=b}return h<1e-6?null:{ux:l/h,uy:d/h,rho:u/h}}function xi(n,e,s){const t=.5*s.rho*s.u*s.u,a=e.length/2,i=[];let r=0,c=0,o=0,l=0;for(let u=0;u<a;u++){const h=e[2*u],f=e[2*u+1],x=e[2*((u+1)%a)],p=e[2*((u+1)%a)+1],w=Math.hypot(x-h,p-f);if(w<1e-9)continue;const b=Math.max(1,Math.ceil(w)),A=w/b,M=(x-h)/w,g=(p-f)/w,v=g,k=-M;for(let B=0;B<b;B++){const S=h+M*A*(B+.5),R=f+g*A*(B+.5),P=At(n,S+v,R+k),y=At(n,S+Se*v,R+Se*k);if(!P||!y)continue;const $=(P.rho-s.rho)/3;let T;const G=P.ux*M+P.uy*g,E=y.ux*M+y.uy*g;if(s.shear==="resolved"){const C=Se,O=(C*C*G-E)/(C*C-C);T=P.rho*s.nu*O}else{const C=Math.abs(E),O=C>1e-12?C/gi(Se*C/s.nu):0;T=Math.sign(E)*P.rho*O*O}r+=-$*v*A,c+=-$*k*A,o+=T*M*A,l+=T*g*A,i.push({x:S,y:R,nx:v,ny:k,ds:A,cp:$/t,cf:T/t})}}const d=1/(t*s.lRef);return{panels:i,cxP:r*d,cyP:c*d,cxF:o*d,cyF:l*d,cx:(r+o)*d,cy:(c+l)*d}}function bi(n,e,s,t,a,i,r){const c=-a,o=t,l=r.rho/3+.5*r.rho*r.u*r.u,d=.01*.5*r.rho*r.u*r.u,u=[0],h=[0];let f=-1;for(let M=.5;M<=i;M+=.5){const g=At(n,e+t*M,s+a*M);if(!g)return null;u.push(g.ux*c+g.uy*o),h.push(M);const v=g.rho/3+.5*g.rho*(g.ux*g.ux+g.uy*g.uy);if(M>=1&&v>=l-d){f=u.length-1;break}}if(f<1)return null;const x=Math.sign(u[f])||1,p=u.map(M=>M*x),w=p[f];let b=0,A=0;for(let M=1;M<=f;M++){const g=p[M-1]/w,v=p[M]/w,k=h[M]-h[M-1];b+=.5*k*(1-g+(1-v)),A+=.5*k*(g*(1-g)+v*(1-v))}return{ue:w,delta:h[f],dstar:b,theta:A,h:b/A}}function vi(n,e,s=181,t=$t){const a=ss(xt(n,s).x,xt(n,s).y,t/e),i=[];for(let r=0;r<a.x.length;r++)i.push((a.x[r]-.25)*e,a.y[r]*e);return Bt(i)}function wi(n,e,s=48){const t=4*e,a=e/2,i=[],r=-n/2+t,c=n/2-t;for(let o=0;o<=s;o++){const l=-Math.PI/2+Math.PI*o/s;i.push(c+t*Math.cos(l),a*Math.sin(l))}for(let o=0;o<=s;o++){const l=Math.PI/2+Math.PI*o/s;i.push(r+t*Math.cos(l),a*Math.sin(l))}return Bt(i)}async function Zt(n,e,s){const t=e.u??Le,a=t*e.lRef/e.re,i=t/(e.gridRe??Et),r=Math.max(a,i),c=new st(n,{nx:e.nx,ny:e.ny,walls:e.walls??"farfield"}),o=e.turb==="sa";c.setPhysics({u:t,tau:3*r+.5,smagorinsky:!o&&r<ks,smagCs:Ye,turb:e.turb,nuMol:a,nuFloor:i,bulkKeep:e.bulkKeep}),c.reset(t);const l=Ct(e.poly,e.turb==="sa"?is:void 0),d=-e.alpha*Math.PI/180,u={x:e.x,y:e.y,theta:d};c.setBodies([{key:"case",sdf:l,from:u,to:u}]);const h=e.lRef/t,f=Math.ceil(e.tstar*h),x=Math.floor(f*(1-(e.tail??.25)));let p=0,w=0,b=0,A=0,M=0,g=1/0,v=-1/0,k=1/0,B=-1/0;const S=[];let R=0,P=0,y=0;const $=.5*t*t*e.lRef,T=performance.now();for(let F=0;F<f;){const X=Math.min(re,f-F),te=n.createCommandEncoder();c.encodeFrame(te,X,{mode:1,uRef:t,lRef:e.lRef});const at=c.prepareRead(te,X);n.queue.submit([te.finish()]);const we=await at();if(!we)throw new Error("The force readback failed.");p+=we.bad,w+=we.limited;for(let j=0;j<X;j++){const ye=we.forces[0].perStep[2*j]/$,oe=we.forces[0].perStep[2*j+1]/$;R+=ye,P+=oe,y++,F+j>=x&&(b+=ye,A+=oe,M++,g=Math.min(g,ye),v=Math.max(v,ye),k=Math.min(k,oe),B=Math.max(B,oe)),(F+j+1)%Math.round(h)===0&&(S.push([(F+j+1)/h,R/y,P/y]),R=0,P=0,y=0)}if(F+=X,p)break}await n.queue.onSubmittedWorkDone();const G=(performance.now()-T)/1e3,{mac:E,aux:C}=await c.readFields();c.destroy();const O=Math.round(e.nx*.08),q=[];for(let F=Math.round(e.ny*.2);F<Math.round(e.ny*.8);F++)q.push(E[4*(F*e.nx+O)+2]);q.sort((F,X)=>F-X);const V=q[Math.floor(q.length/2)]??1,he=Rt(e.poly,u),U=xi({nx:e.nx,ny:e.ny,mac:E},he,{u:t,rho:V,lRef:e.lRef,shear:e.turb==="off"?"resolved":"wall",nu:e.turb==="off"?r:a});let z;if(e.blStations){const F={nx:e.nx,ny:e.ny,mac:E},X=Math.cos(-d),te=Math.sin(-d),at=U.panels.map(j=>{const ye=j.x-e.x,oe=j.y-e.y;return{p:j,xc:(X*ye-te*oe-(e.leX??0))/e.lRef,yc:(te*ye+X*oe)/e.lRef}}),we=(j,ye)=>{const oe=at.filter(De=>ye?De.yc>0:De.yc<=0);if(!oe.length)return null;const Oe=oe.reduce((De,Ut)=>Math.abs(Ut.xc-j)<Math.abs(De.xc-j)?Ut:De,oe[0]),$e=bi(F,Oe.p.x,Oe.p.y,Oe.p.nx,Oe.p.ny,.25*e.lRef,{rho:V,u:t});return $e?{...$e,delta:$e.delta/e.lRef,dstar:$e.dstar/e.lRef,theta:$e.theta/e.lRef,ue:$e.ue/t}:null};z=e.blStations.map(j=>({xc:j,upper:we(j,!0),lower:we(j,!1)}))}let ee=0;const Q={macNaN:0,auxNaN:0,z:[1/0,-1/0],w:[1/0,-1/0],rhoInf:V,panels:U.panels.length};for(let F=0;F<e.nx*e.ny;F++)Number.isFinite(E[4*F+2])||Q.macNaN++;if(C)for(let F=0;F<e.nx*e.ny;F++){const X=C[4*F+2],te=C[4*F+3];if(!Number.isFinite(X)||!Number.isFinite(te)){Q.auxNaN++;continue}Q.z=[Math.min(Q.z[0],X),Math.max(Q.z[1],X)],Q.w=[Math.min(Q.w[0],te),Math.max(Q.w[1],te)],te>=0&&(ee=Math.max(ee,X/a))}return console.log("R1 diag",JSON.stringify(Q)),{steps:f,seconds:G,mlups:e.nx*e.ny*f/G/1e6,bad:p,limited:w,cd:M?b/M:NaN,cl:M?A/M:NaN,cdSpread:v-g,clSpread:B-k,surface:{cd:U.cx,cl:U.cy,cdP:U.cxP,cdF:U.cxF,clP:U.cyP,clF:U.cyF},history:S,panels:U.panels,rhoInf:V,nuMol:a,nuFloor:i,nutMax:ee,bl:z,fields:e.dump?{nx:e.nx,ny:e.ny,mac:Array.from(E),aux:C?Array.from(C):null}:void 0}}function ki(n){const e=n.up??4,s=n.down??8,t=n.half??4;return{poly:vi(n.code,n.chord,181,n.teMin??$t),lRef:n.chord,re:n.re,turb:n.turb,x:e*n.chord+(n.offset??0),y:t*n.chord+(n.offset??0),alpha:n.alpha,nx:Math.round((e+s)*n.chord),ny:Math.round(2*t*n.chord),tstar:n.tstar??12,gridRe:n.gridRe,dump:n.dump,bulkKeep:n.bulkKeep,u:n.u,walls:n.walls,blStations:n.blStations,leX:-.25*n.chord}}function Mi(n){const e=n.length;return{poly:wi(e,n.thickness??6),lRef:e,re:n.re,turb:n.turb,x:.3*e+e/2,y:Math.round(.2*e)+(n.yOffset??.3),alpha:0,nx:Math.round(1.9*e),ny:Math.round(.4*e),tstar:n.tstar??3,gridRe:n.gridRe,dump:n.dump,bulkKeep:n.bulkKeep,u:n.u}}function Pi({store:n,engine:e,device:s}){window.__TUNNEL__={ready:!0,scene:()=>n.get().scene,selected:()=>n.get().selected,save:()=>n.get().save,stats:()=>({...e.stats,map:e.lattice,unstableAt:e.unstableAt,limitedTotal:e.limitedTotal}),view:()=>({...e.worldView}),livePose:t=>e.livePose(t),bodyLive:t=>e.bodyLive(t),sampleField:async()=>{const t=await e.sampleField();return t?Array.from(t,a=>Number.isFinite(a)?a:null):null},toScreen:(t,a)=>{const i=e.worldView,r=e.canvas.getBoundingClientRect();return{x:r.left+i.w/2+(t-i.cx)/i.mpp,y:r.top+i.h/2-(a-i.cy)/i.mpp}},turnHandle:t=>{const a=n.get().scene.bodies.find(c=>c.id===t);if(!a)return null;const i=e.canvas.getBoundingClientRect(),r=Ss(e,a);return{x:i.left+r.x,y:i.top+r.y,cx:i.left+r.cx,cy:i.top+r.cy}},validate:(t=20,a=200)=>yi(s,t,a),validateAirfoil:t=>Zt(s,ki(t)),validatePlate:t=>Zt(s,Mi(t)),particles:async()=>{const t=await e.readParticles();if(!t)return null;const a=n.get().scene,i=t.dx,r=a.bodies.filter(h=>h.enabled).map(h=>({b:h,poly:Be(h,e.livePose(h.id)??{x:h.x,y:h.y,angle:h.angle})}));let c=0,o=0,l=0;const d=[],u=t.pools.map(h=>({id:h.id,alive:0,maxX:-1/0}));for(let h=0;h<t.meta.length/4;h++){if(t.meta[4*h+3]<.5||t.meta[4*h]<0)continue;const f=(t.pos[4*h]+.5)*i,x=(t.pos[4*h+1]+.5)*i;if(!Number.isFinite(f)||!Number.isFinite(x)){o++;continue}const p=t.meta[4*h+1];if(p<0)c++;else{const w=u[p];w&&(w.alive++,w.maxX=Math.max(w.maxX,f))}for(const{poly:w}of r)Qe(w,f,x)&&lt(w,f,x)<-.5*i&&(l++,d.length<6&&d.push({x:f,y:x,depthCells:lt(w,f,x)/i,age:t.meta[4*h],src:t.meta[4*h+1],prevX:(t.pos[4*h+2]+.5)*i,prevY:(t.pos[4*h+3]+.5)*i}))}return{tracers:t.tracers,tracersAlive:c,nan:o,inside:l,insideAt:d,pools:u}},dye:async()=>{const t=await e.readDye();if(!t)return null;const a=[0,0,0,0],i=[-1/0,-1/0,-1/0,-1/0],c=n.get().scene.bodies.filter(l=>l.enabled).map(l=>Be(l,e.livePose(l.id)??{x:l.x,y:l.y,angle:l.angle}));let o=0;for(const l of c){let d=1/0,u=-1/0,h=1/0,f=-1/0;for(let x=0;x<l.length;x+=2)d=Math.min(d,l[x]),u=Math.max(u,l[x]),h=Math.min(h,l[x+1]),f=Math.max(f,l[x+1]);for(let x=Math.max(0,Math.floor(h/t.dx));x<=Math.min(t.ny-1,Math.ceil(f/t.dx));x++)for(let p=Math.max(0,Math.floor(d/t.dx));p<=Math.min(t.nx-1,Math.ceil(u/t.dx));p++){const w=(p+.5)*t.dx,b=(x+.5)*t.dx;if(Qe(l,w,b)&&lt(l,w,b)<-t.dx){const A=x*t.nx+p;o+=t.data[4*A]+t.data[4*A+1]+t.data[4*A+2]+t.data[4*A+3]}}}for(let l=0;l<t.nx*t.ny;l++)for(let d=0;d<4;d++){const u=t.data[4*l+d];u>.05&&(a[d]+=u,i[d]=Math.max(i[d],(l%t.nx+.5)*t.dx))}return{channels:t.channels,sums:a,maxX:i,insideSum:o}},streamlines:()=>e.streamlineCount,rheo:()=>e.readRheo()}}function Ai(){return[...rn(),{label:"particles advect",code:ms()},{label:"particles draw",code:ys()},{label:"trail fade",code:xs},{label:"rake lines",code:gs()},{label:"dye advect",code:hs()},{label:"dye correct",code:fs()},{label:"dye inject",code:ps()},{label:"streamlines trace",code:vs},{label:"streamlines draw",code:ws},{label:"rheoscopic",code:bs()}]}async function Si(n){for(const e of Ai()){const t=(await n.createShaderModule({code:e.code,label:e.label}).getCompilationInfo()).messages.find(a=>a.type==="error");if(t)return`${e.label} shader, line ${t.lineNum}: ${t.message}`}return null}const Bi=document.getElementById("t2d-root"),Cs=Ns(Bi);function Te(n,e){Cs.render(ze("div",{className:"t2d-fatal",role:"alert","data-t2d-fatal":"1"},ze(Us,null,ze("strong",null,n),ze("p",null,e))))}function H(n){const e=getComputedStyle(document.documentElement).getPropertyValue(n).trim(),s=document.createElement("canvas").getContext("2d");s.fillStyle=e||"black";const t=s.fillStyle;if(t.startsWith("#"))return[parseInt(t.slice(1,3),16)/255,parseInt(t.slice(3,5),16)/255,parseInt(t.slice(5,7),16)/255];const a=/rgba?\(([^)]+)\)/.exec(t),i=a?a[1].split(",").map(Number):[0,0,0];return[i[0]/255,i[1]/255,i[2]/255]}async function Ri(){let n;try{n=await $s({timeoutMs:15e3})}catch(p){Te("The wind tunnel could not start",`${p instanceof Error?p.message:String(p)}. Open the tunnel from its project in Magnusim.`);return}if(!("gpu"in navigator)||!navigator.gpu){Te("This wind tunnel needs WebGPU","This browser does not offer WebGPU (navigator.gpu is missing), and the tunnel solves the flow on the GPU with it. Open Magnusim in a current Chrome or Edge on a computer with a GPU driver from the last few years.");return}const e=await navigator.gpu.requestAdapter({powerPreference:"high-performance"}).catch(()=>null);if(!e){Te("This wind tunnel needs WebGPU","The browser offers WebGPU but found no GPU it can use (requestAdapter gave none). Check that hardware acceleration is on in the browser’s settings and that the graphics driver is up to date.");return}let s;try{s=await e.requestDevice({requiredLimits:{maxStorageBufferBindingSize:e.limits.maxStorageBufferBindingSize,maxBufferSize:e.limits.maxBufferSize}})}catch(p){Te("The GPU could not be opened",String(p));return}const t=await Si(s);if(t){Te("The wind tunnel’s GPU code did not compile on this GPU",`${t}. Please report this with the GPU’s name (${e.info?.vendor??""} ${e.info?.architecture??""}).`);return}const a=e.info,i=a?.description||[a?.vendor,a?.architecture].filter(Boolean).join(" ")||"GPU";s.lost.then(p=>{p.reason!=="destroyed"&&Te("The GPU stopped the wind tunnel",`${p.message||"The GPU device was lost"}. Leave the tunnel and open it again; the scene is saved.`)});const r=n.context.study,c=await fi(n,r.id),o=new On(c.scene),l=new pi(n,o,r.id,c.etag);c.etag||await l.create(c.scene);const d={bg:H("--t2d-bg"),body:H("--t2d-body"),edge:H("--t2d-edge"),zone:[...H("--t2d-zone"),.14],plain:H("--t2d-plain"),arrow:[...H("--t2d-arrow"),.85]},u=document.createElement("canvas"),h=new In(s,u,i,d),f=p=>{const w=16*Math.PI/180,b=p*Math.PI/180;return[Math.cos(w)*Math.cos(b),Math.cos(w)*Math.sin(b),Math.sin(w)]},x=(p,w,b,A,M)=>({base:H(`--t2d-rheo-${p}-base`),l1:{dir:f(135),color:H(`--t2d-rheo-${p}-light1`),diffuse:w},l2:{dir:f(-45),color:H(`--t2d-rheo-${p}-light2`),diffuse:b},sharp:A,glint:M});h.rheoLooks={kalliroscope:x("kalliroscope",.16,.12,12,1.8),pearl:x("pearl",.18,.14,12,1.6),copper:x("copper",.17,.12,10,1.8)},h.bodyLook={body:H("--t2d-body-dark"),edge:H("--t2d-edge-light")},h.markerColors={tracerDark:[...H("--t2d-particle-dark"),.5],tracerLight:[...H("--t2d-particle-light"),.85],rakes:[1,2,3,4,5,6].map(p=>[...H(`--mg-series-${p}`),.85]),rakesOnDark:[1,2,3,4,5,6].map(p=>{const w=H(`--mg-series-${p}`);return[w[0]+(1-w[0])*.35,w[1]+(1-w[1])*.35,w[2]+(1-w[2])*.35,.85]}),streamline:[...H("--t2d-streamline"),.4],streamlineLight:[...H("--t2d-particle-light"),.35]},o.onSceneChange=p=>{l.schedule(p),h.setScene(p)},await h.setScene(c.scene),h.start(),Pi({store:o,engine:h,device:s}),window.addEventListener("pagehide",()=>void l.flush()),Cs.render(ze(ui,{ws:n,store:o,engine:h,units:n.context.units,problem:c.problem}))}Ri();
