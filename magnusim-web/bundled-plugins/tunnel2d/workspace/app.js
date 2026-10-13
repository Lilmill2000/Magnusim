import{connect as en}from"@magnusim/workspace";import{colormapRgb as tn,Field as N,NumberUnitInput as Se,Select as ie,Hint as te,Button as Ae,Icon as ft,Toggle as qe,fromSi as sn,DisabledReason as kt,ColorLegend as nn,EmptyState as rn}from"@magnusim/plugin-ui";import{useSyncExternalStore as an,useState as ge,useEffect as ue,useRef as Ie,createElement as et}from"react";import{createRoot as on}from"react-dom/client";import{jsxs as F,jsx as m,Fragment as Mt}from"react/jsx-runtime";const xs={1:[.058,361.4],2:[.126,51.64],3:[.2025,15.957],4:[.29,6.643],5:[.391,3.23]},gs={2:[.13,51.99,764e-6],3:[.217,15.793,.00677],4:[.318,6.52,.0303],5:[.441,3.191,.1355]},Qt=20,Zt=250,ln=81;class Be extends Error{}const cn=/^\s*(?:naca\s*)?(\d{4,5})\s*$/i;function Vt(r){const e=cn.exec(String(r??""));if(!e)throw new Be("Enter a NACA 4-digit or 5-digit designation, such as 2412 or 23012.");const s=e[1];return s.length===4?un(s):dn(s),s}const we=(r,e)=>Number(r[e]);function un(r){const e=we(r,0),s=we(r,1);if(Number(r.slice(2))<=0)throw new Be(`NACA ${r}: the thickness (last two digits) must be above 0.`);if(e===0!=(s===0))throw new Be(`NACA ${r}: camber and its position must both be 0 or both be above 0.`)}function dn(r){const e=we(r,0),s=we(r,1),t=we(r,2);if(Number(r.slice(3))<=0)throw new Be(`NACA ${r}: the thickness (last two digits) must be above 0.`);if(e===0)throw new Be(`NACA ${r}: the first digit (design lift) must be above 0.`);if(t!==0&&t!==1)throw new Be(`NACA ${r}: the third digit must be 0 (standard) or 1 (reflexed).`);const a=t?gs:xs;if(!(s in a)){const i=Object.keys(a).sort().join(", ");throw new Be(`NACA ${r}: a ${t?"reflexed":"standard"} 5-digit mean line has its second digit in ${i}.`)}}function hn(r,e,s){const t=s?-.1036:-.1015;return 5*e*(.2969*Math.sqrt(r)-.126*r-.3516*r**2+.2843*r**3+t*r**4)}function fn(r,e){const s=we(r,0)/100,t=we(r,1)/10;return s===0?[0,0]:e<t?[s/t**2*(2*t*e-e**2),2*s/t**2*(t-e)]:[s/(1-t)**2*(1-2*t+2*t*e-e**2),2*s/(1-t)**2*(t-e)]}function pn(r,e){const s=we(r,0),t=we(r,1),n=we(r,2),a=3*s/20/.3;if(!n){const[u,h]=xs[t];return e<u?[a*(h/6*(e**3-3*u*e**2+u**2*(3-u)*e)),a*(h/6*(3*e**2-6*u*e+u**2*(3-u)))]:[a*(h*u**3/6*(1-e)),a*(-h*u**3/6)]}const[i,l,o]=gs[t],c=o*(1-i)**3;return e<i?[a*(l/6*((e-i)**3-c*e-i**3*e+i**3)),a*(l/6*(3*(e-i)**2-c-i**3))]:[a*(l/6*(o*(e-i)**3-c*e-i**3*e+i**3)),a*(l/6*(3*o*(e-i)**2-c-i**3))]}function Jt(r){const e=Math.round(r*1e10)/1e10;return e===0?0:e}function Et(r,e=ln,s=!1){const t=Vt(r),n=Math.trunc(e);if(!(n>=Qt&&n<=Zt))throw new Be(`Points per side must be from ${Qt} to ${Zt}.`);const a=Number(t.slice(-2))/100,i=t.length===4?fn:pn,l=[],o=[];for(let u=0;u<n;u++){const h=Math.PI*u/(n-1),d=.5*(1-Math.cos(h)),f=hn(d,a,s),[y,p]=i(t,d),b=Math.atan(p);l.push([d-f*Math.sin(b),y+f*Math.cos(b)]),o.push([d+f*Math.sin(b),y-f*Math.cos(b)])}const c=[...l.reverse(),...o.slice(1)];return{code:t,name:`NACA ${t}`,x:c.map(u=>Jt(u[0])),y:c.map(u=>Jt(u[1]))}}function bs(r){let e=0;const s=r.length/2;for(let t=0;t<s;t++){const n=(t+1)%s;e+=r[2*t]*r[2*n+1]-r[2*n]*r[2*t+1]}return e/2}function Wt(r){if(bs(r)>=0)return r;const e=[];for(let s=r.length/2-1;s>=0;s--)e.push(r[2*s],r[2*s+1]);return e}function vs(r){let e=1/0,s=1/0,t=-1/0,n=-1/0;for(let a=0;a<r.length;a+=2)e=Math.min(e,r[a]),t=Math.max(t,r[a]),s=Math.min(s,r[a+1]),n=Math.max(n,r[a+1]);return{x0:e,y0:s,x1:t,y1:n}}function _t(r){let e=0;for(let s=0;s<r.length;s+=2)e=Math.max(e,Math.hypot(r[s],r[s+1]));return e}function ze(r,e,s=1){const t=Math.cos(e.theta),n=Math.sin(e.theta),a=new Array(r.length);for(let i=0;i<r.length;i+=2){const l=r[i]*s,o=r[i+1]*s;a[i]=e.x+t*l-n*o,a[i+1]=e.y+n*l+t*o}return a}function pt(r,e,s){let t=!1;const n=r.length/2;for(let a=0,i=n-1;a<n;i=a++){const l=r[2*a],o=r[2*a+1],c=r[2*i],u=r[2*i+1];o>s!=u>s&&e<(c-l)*(s-o)/(u-o)+l&&(t=!t)}return t}function mn(r,e,s,t,n,a){const i=n-s,l=a-t,o=i*i+l*l;let c=o>0?((r-s)*i+(e-t)*l)/o:0;return c=Math.max(0,Math.min(1,c)),Math.hypot(r-(s+c*i),e-(t+c*l))}function Pt(r,e,s){let t=1/0;const n=r.length/2;for(let a=0;a<n;a++){const i=(a+1)%n;t=Math.min(t,mn(e,s,r[2*a],r[2*a+1],r[2*i],r[2*i+1]))}return pt(r,e,s)?-t:t}function yn(r){const e=r.length/2,s=(t,n,a,i,l,o)=>(a-t)*(o-n)-(i-n)*(l-t);for(let t=0;t<e;t++){const n=(t+1)%e;for(let a=t+1;a<e;a++){const i=(a+1)%e;if(a===n||i===t)continue;const[l,o,c,u]=[r[2*t],r[2*t+1],r[2*n],r[2*n+1]],[h,d,f,y]=[r[2*a],r[2*a+1],r[2*i],r[2*i+1]],p=s(l,o,c,u,h,d),b=s(l,o,c,u,f,y),g=s(h,d,f,y,l,o),S=s(h,d,f,y,c,u);if(p*b<0&&g*S<0)return!0}}return!1}const xn=256;function es(r,e,s=xn){const t=[];for(let n=0;n<s;n++){const a=2*Math.PI*n/s;t.push(r*Math.cos(a),e*Math.sin(a))}return t}function ts(r,e){return[-r/2,-e/2,r/2,-e/2,r/2,e/2,-r/2,e/2]}function ws(r,e,s){if(!(s>0))return{x:r,y:e};let t=0;for(let o=1;o<r.length;o++)r[o]<r[t]&&(t=o);const n=Array.from({length:t+1},(o,c)=>t-c),a=Array.from({length:r.length-t},(o,c)=>t+c),i=(o,c)=>{for(let u=1;u<o.length;u++){const h=o[u-1],d=o[u];if(r[d]>=c)return r[d]===r[h]?e[d]:e[h]+(e[d]-e[h])*(c-r[h])/(r[d]-r[h])}return e[o[o.length-1]]},l=e.slice();for(let o=0;o<r.length;o++){if(r[o]<.5)continue;const c=o<t,u=i(c?a:n,r[o]);if((c?e[o]-u:u-e[o])>=s)continue;const d=.5*(e[o]+u);l[o]=d+(c?.5:-.5)*s}return{x:r,y:l}}function ss(r,e,s,t=0){const n=ws(r,e,t/s),a=[];for(let i=0;i<n.x.length;i++)a.push((n.x[i]-.25)*s,n.y[i]*s);return Wt(a)}function We(r,e=0){switch(r.kind){case"naca":{const s=Et(r.code,121);return ss(s.x,s.y,r.chord,e)}case"dat":return ss(r.x,r.y,r.chord,e);case"circle":return es(r.diameter/2,r.diameter/2);case"ellipse":return es(r.width/2,r.height/2);case"rect":return ts(r.width,r.height);case"plate":return ts(r.length,r.thickness)}}function Ue(r){switch(r.kind){case"naca":case"dat":return r.chord;case"circle":return r.diameter;case"ellipse":case"rect":return r.height;case"plate":return r.length}}function mt(r){switch(r.kind){case"naca":return`NACA ${r.code}`;case"dat":return r.name;case"circle":return"Cylinder";case"ellipse":return"Ellipse";case"rect":return"Rectangle";case"plate":return"Flat plate"}}const gn=4,bn=2,vn=4e6;function it(r,e=gn){const s=vs(r),t=e+2;let n=1/bn,a=Math.ceil((s.x1-s.x0+2*t)/n)+1,i=Math.ceil((s.y1-s.y0+2*t)/n)+1;for(;a*i>vn;)n*=1.5,a=Math.ceil((s.x1-s.x0+2*t)/n)+1,i=Math.ceil((s.y1-s.y0+2*t)/n)+1;const l=s.x0-t,o=s.y0-t,c=new Float32Array(a*i).fill(e),u=r.length/2;for(let f=0;f<u;f++){const y=r[2*f],p=r[2*f+1],b=r[2*((f+1)%u)],g=r[2*((f+1)%u)+1],S=Math.max(0,Math.floor((Math.min(y,b)-e-l)/n)),P=Math.min(a-1,Math.ceil((Math.max(y,b)+e-l)/n)),x=Math.max(0,Math.floor((Math.min(p,g)-e-o)/n)),v=Math.min(i-1,Math.ceil((Math.max(p,g)+e-o)/n)),M=b-y,$=g-p,k=M*M+$*$;for(let R=x;R<=v;R++){const T=o+R*n;for(let w=S;w<=P;w++){const E=l+w*n;let B=k>0?((E-y)*M+(T-p)*$)/k:0;B=B<0?0:B>1?1:B;const C=E-(y+B*M),U=T-(p+B*$),A=Math.sqrt(C*C+U*U),D=R*a+w;A<c[D]&&(c[D]=A)}}}const h=[];for(let f=0;f<i;f++){const y=o+f*n;h.length=0;for(let p=0;p<u;p++){const b=r[2*p+1],g=r[2*((p+1)%u)+1];if(b>y!=g>y){const S=r[2*p],P=r[2*((p+1)%u)];h.push(S+(y-b)*(P-S)/(g-b))}}h.sort((p,b)=>p-b);for(let p=0;p+1<h.length;p+=2){const b=Math.max(0,Math.ceil((h[p]-l)/n)),g=Math.min(a-1,Math.floor((h[p+1]-l)/n));for(let S=b;S<=g;S++)c[f*a+S]=-c[f*a+S]}}let d=0;for(let f=0;f<u;f++)d=Math.max(d,Math.hypot(r[2*f],r[2*f+1]));return{data:c,w:a,h:i,ox:l,oy:o,texel:n,band:e,bound:d+1}}const wn=new Uint8Array([0,0,4,1,0,5,1,1,6,1,1,8,2,1,10,2,2,12,2,2,14,3,2,16,4,3,18,4,3,20,5,4,23,6,4,25,7,5,27,8,5,29,9,6,31,10,7,34,11,7,36,12,8,38,13,8,41,14,9,43,16,9,45,17,10,48,18,10,50,20,11,52,21,11,55,22,11,57,24,12,60,25,12,62,27,12,65,28,12,67,30,12,69,31,12,72,33,12,74,35,12,76,36,12,79,38,12,81,40,11,83,41,11,85,43,11,87,45,11,89,47,10,91,49,10,92,50,10,94,52,10,95,54,9,97,56,9,98,57,9,99,59,9,100,61,9,101,62,9,102,64,10,103,66,10,104,68,10,104,69,10,105,71,11,106,73,11,106,74,12,107,76,12,107,77,13,108,79,13,108,81,14,108,82,14,109,84,15,109,85,15,109,87,16,110,89,16,110,90,17,110,92,18,110,93,18,110,95,19,110,97,19,110,98,20,110,100,21,110,101,21,110,103,22,110,105,22,110,106,23,110,108,24,110,109,24,110,111,25,110,113,25,110,114,26,110,116,26,110,117,27,110,119,28,109,120,28,109,122,29,109,124,29,109,125,30,109,127,30,108,128,31,108,130,32,108,132,32,107,133,33,107,135,33,107,136,34,106,138,34,106,140,35,105,141,35,105,143,36,105,144,37,104,146,37,104,147,38,103,149,38,103,151,39,102,152,39,102,154,40,101,155,41,100,157,41,100,159,42,99,160,42,99,162,43,98,163,44,97,165,44,96,166,45,96,168,46,95,169,46,94,171,47,94,173,48,93,174,48,92,176,49,91,177,50,90,179,50,90,180,51,89,182,52,88,183,53,87,185,53,86,186,54,85,188,55,84,189,56,83,191,57,82,192,58,81,193,58,80,195,59,79,196,60,78,198,61,77,199,62,76,200,63,75,202,64,74,203,65,73,204,66,72,206,67,71,207,68,70,208,69,69,210,70,68,211,71,67,212,72,66,213,74,65,215,75,63,216,76,62,217,77,61,218,78,60,219,80,59,221,81,58,222,82,56,223,83,55,224,85,54,225,86,53,226,87,52,227,89,51,228,90,49,229,92,48,230,93,47,231,94,46,232,96,45,233,97,43,234,99,42,235,100,41,235,102,40,236,103,38,237,105,37,238,106,36,239,108,35,239,110,33,240,111,32,241,113,31,241,115,29,242,116,28,243,118,27,243,120,25,244,121,24,245,123,23,245,125,21,246,126,20,246,128,19,247,130,18,247,132,16,248,133,15,248,135,14,248,137,12,249,139,11,249,140,10,249,142,9,250,144,8,250,146,7,250,148,7,251,150,6,251,151,6,251,153,6,251,155,6,251,157,7,252,159,7,252,161,8,252,163,9,252,165,10,252,166,12,252,168,13,252,170,15,252,172,17,252,174,18,252,176,20,252,178,22,252,180,24,251,182,26,251,184,29,251,186,31,251,188,33,251,190,35,250,192,38,250,194,40,250,196,42,250,198,45,249,199,47,249,201,50,249,203,53,248,205,55,248,207,58,247,209,61,247,211,64,246,213,67,246,215,70,245,217,73,245,219,76,244,221,79,244,223,83,244,225,86,243,227,90,243,229,93,242,230,97,242,232,101,242,234,105,241,236,109,241,237,113,241,239,117,241,241,121,242,242,125,242,244,130,243,245,134,243,246,138,244,248,142,245,249,146,246,250,150,248,251,154,249,252,157,250,253,161,252,255,164]),O=128,K=8,ve=2048,yt=1048576,ye=ve*K*2,At=ye+4,He=.1,Qe=.2,be=[0,1,0,-1,0,1,-1,-1,1],_e=[0,0,1,0,-1,1,1,-1,-1],Pe=[4/9,1/9,1/9,1/9,1/9,1/36,1/36,1/36,1/36],kn=[0,3,4,1,2,7,8,5,6],Mn=[0,1,4,3,2,8,7,6,5],Pn={slip:0,noslip:1,periodic:2,farfield:3},G=r=>r.toFixed(10),Q=r=>r.toFixed(1),bt=`
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
fn sdfAt(p: vec2f, near: u32, bp: ptr<function, array<vec4f, ${K}>>) -> Hit {
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
fn sdfGrad(p: vec2f, near: u32, bp: ptr<function, array<vec4f, ${K}>>) -> vec2f {
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
fn poses(p: vec2f, t: f32, bp: ptr<function, array<vec4f, ${K}>>) -> u32 {
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
`,rt=`
const CXF = array<f32, 9>(${be.map(Q).join(", ")});
const CYF = array<f32, 9>(${_e.map(Q).join(", ")});
const WF = array<f32, 9>(${Pe.map(G).join(", ")});
`,An={off:0,wall:1,sa:2},Le=.41,ks=5,me={cb1:.1355,sigma:2/3,cb2:.622,cw2:.3,cw3:2,cv1:7.1,cv2:.7,cv3:.9},Sn=me.cb1/(Le*Le)+(1+me.cb2)/me.sigma,Bn=.2,jt=2,Ms=32,Ge=2,Rn=`
const KAPPA = ${G(Le)};
const WALL_EKB = ${G(Math.exp(-Le*ks))};
const SA_CB1 = ${G(me.cb1)};
const SA_SIGMA = ${G(me.sigma)};
const SA_CB2 = ${G(me.cb2)};
const SA_CW1 = ${G(Sn)};
const SA_CW2 = ${G(me.cw2)};
const SA_CW3_6 = ${G(me.cw3**6)};
const SA_CV1_3 = ${G(me.cv1**3)};
const SA_CV2 = ${G(me.cv2)};
const SA_CV3 = ${G(me.cv3)};

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
fn wallDist(p: vec2f, bp: ptr<function, array<vec4f, ${K}>>) -> f32 {
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
  return clamp(n0 + prod - dest + diff + cross - adv, 0.0, ${Bn});
}

fn saFv1(nt: f32) -> f32 {
  let chi = nt / P.nuMol;
  let chi3 = chi * chi * chi;
  return chi3 / (chi3 + SA_CV1_3);
}
`,Ps=`
fn postRR(k: u32, rho: f32, u: vec2f, pxx: f32, pyy: f32, pxy: f32, tau: f32) -> f32 {
  let cx = CXF[k];
  let cy = CYF[k];
  let hxx = cx * cx - 1.0 / 3.0;
  let hyy = cy * cy - 1.0 / 3.0;
  let hxy = cx * cy;
  let hxxy = cx * cx * cy - cy / 3.0;
  let hxyy = cx * cy * cy - cx / 3.0;
  let keep = 1.0 - 1.0 / tau;
  let half = 0.5 * (pxx + pyy);
  let kb = select(KEEP_BULK, keep, KEEP_BULK < 0.0);
  let dxx = keep * (pxx - half) + kb * half;
  let dyy = keep * (pyy - half) + kb * half;
  let dxy = keep * pxy;
  let axxy = 2.0 * u.x * pxy + u.y * pxx;
  let axyy = 2.0 * u.y * pxy + u.x * pyy;
  let ux = u.x;
  let uy = u.y;
  return WF[k] * ((rho - 1.0) + rho * (3.0 * (cx * ux + cy * uy) + 4.5 * (hxx * ux * ux + hyy * uy * uy + 2.0 * hxy * ux * uy) + 13.5 * (hxxy * ux * ux * uy + hxyy * ux * uy * uy)))
    + WF[k] * (4.5 * (hxx * dxx + hyy * dyy + 2.0 * hxy * dxy) + 13.5 * keep * (hxxy * axxy + hxyy * axyy));
}

/** Rescale Π_neq between levels: the shear part by f, the trace by g. */
fn rescale(p: vec3f, f: f32, g: f32) -> vec3f {
  let half = 0.5 * (p.x + p.y);
  return vec3f(f * (p.x - half) + g * half, f * (p.y - half) + g * half, f * p.z);
}
`,Cn=`
struct Edge { ox: u32, oy: u32, nxc: u32, prime: u32 };
@group(2) @binding(0) var<uniform> E: Edge;
@group(2) @binding(1) var<storage, read> momT: array<vec4f>;
@group(2) @binding(2) var<storage, read> momT1: array<vec4f>;
@group(2) @binding(3) var<storage, read> auxT: array<vec4f>;
@group(2) @binding(4) var<storage, read> auxT1: array<vec4f>;

/** The parent's (ρ, u, ν) and (Π_neq, ν̃) at cell (i, j), fraction th from its older to its newer time. */
fn parentAt(i: i32, j: i32, th: f32) -> array<vec4f, 2> {
  let k = u32(i) + u32(j) * E.nxc;
  let a = mix(auxT[k], auxT1[k], th);
  let m = mix(momT[k], momT1[k], th);
  return array<vec4f, 2>(vec4f(m.x, a.x, a.y, max(a.w, 0.0)), vec4f(m.y, m.z, m.w, max(a.z, 0.0)));
}

fn edgeCell(x: u32, y: u32, idx: u32) {
  // This step goes to fine time (slot parity + 1) / 2 of the parent's step.
  let th = select(f32((S.slot & 1u) + 1u) * 0.5, 1.0, E.prime == 1u);
  let vertical = x == 0u || x == P.nx - 1u;
  let t = select(x, y, vertical);
  let ci = i32(E.ox) + i32(x / 2u);
  let cj = i32(E.oy) + i32(y / 2u);
  var m0: vec4f;
  var m1: vec4f;
  if ((t & 1u) == 0u) {
    let v = parentAt(ci, cj, th);
    m0 = v[0];
    m1 = v[1];
  } else {
    let dx = select(1, 0, vertical);
    let dy = select(0, 1, vertical);
    let p = parentAt(ci - dx, cj - dy, th);
    let q = parentAt(ci, cj, th);
    let s = parentAt(ci + dx, cj + dy, th);
    let w = parentAt(ci + 2 * dx, cj + 2 * dy, th);
    m0 = (9.0 * (q[0] + s[0]) - (p[0] + w[0])) / 16.0;
    m1 = (9.0 * (q[1] + s[1]) - (p[1] + w[1])) / 16.0;
    m0.w = 0.5 * (q[0].w + s[0].w);
    m1.w = 0.5 * (q[1].w + s[1].w);
  }
  let rho = m0.x;
  let u = m0.yz;
  let tauC = 3.0 * m0.w + 0.5;
  let nuF = 2.0 * m0.w;
  let tauF = 3.0 * nuF + 0.5;
  let pf = rescale(m1.xyz, tauF / (2.0 * tauC), 0.5);
  for (var k = 0u; k < 9u; k++) { fout[k * P.n + idx] = postRR(k, rho, u, pf.x, pf.y, pf.z, tauF); }
  auxOut[idx] = vec4f(u, 2.0 * m1.w, nuF);
}
`,ns=12;function Dt(r=!1){const e=(i,l)=>`fin[${i}u * P.n + ${l}]`,s=i=>`(${G(Pe[i])} * (drho + rho * (3.0 * (${Q(be[i])} * ux + ${Q(_e[i])} * uy) + 4.5 * (${Q(be[i])} * ux + ${Q(_e[i])} * uy) * (${Q(be[i])} * ux + ${Q(_e[i])} * uy) - 1.5 * (ux * ux + uy * uy))))`;let t="";for(let i=1;i<9;i++){const l=kn[i],o=be[i],c=_e[i];let u="";o>0&&(u=`if (x == 0u) { f${i} = 0.0; } else `),o<0&&(u=`if (x == P.nx - 1u) { f${i} = ${e(i,"idx")}; } else `);let h="";if(c!==0){const f=c>0?"y == 0u":"y == P.ny - 1u",y=c>0?"P.ny - 1u":"0u";h=`if (${f}) {
      if (WALLS == 1u) { f${i} = ${e(l,"idx")}; }
      else if (WALLS == 0u) { f${i} = ${e(Mn[i],`u32(i32(x) - (${o})) + y * P.nx`)}; }
      else if (WALLS == 3u) { f${i} = ${G(Pe[i])} * (3.0 * ${Q(o)} * P.uIn + 4.5 * ${Q(o*o)} * P.uIn * P.uIn - 1.5 * P.uIn * P.uIn); }
      else { f${i} = ${e(i,`u32(i32(x) - (${o})) + ${y} * P.nx`)}; }
    } else `}const d=`(${Q(o)} * uw.x + ${Q(c)} * uw.y)`;t+=`
  var f${i}: f32;
  ${u}${h}{
    let sx = i32(x) - (${o});
    let sy = i32(y) - (${c});
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
        let hm = sdfAt(vec2f(f32(x) - ${Q(o*.5)}, f32(y) - ${Q(c*.5)}), near, &bp);
        if (hm.d < 0.0 && dot(sdfGrad(p, near, &bp), sdfGrad(vec2f(f32(sx), f32(sy)), near, &bp)) < 0.0) {
          hit = hm;
          qThin = clamp(0.5 * d0 / (d0 - hm.d), 0.001, 0.5);
        }
      }
    }
    if (hit.d < 0.0) {
      // Bouzidi: direction ${l} leaves this cell into the body, q of the way to its wall.
      var q = select(clamp(d0 / (d0 - hit.d), 0.001, 1.0), qThin, qThin >= 0.0);
      let bx = i32(x) + (${o});
      let by = i32(y) + (${c});
      var behindFluid = bx >= 0 && by >= 0 && bx < i32(P.nx) && by < i32(P.ny);
      if (behindFluid && q < 0.5) { behindFluid = sdfAt(vec2f(f32(bx), f32(by)), near, &bp).d >= 0.0; }
      if (q < 0.5 && !behindFluid) { q = 0.5; }
      let c = bp[hit.b].xy;
      let uwB = wallU(hit.b, vec2f(f32(sx), f32(sy)), c);
      // The wall model's slip moves the wall along itself (only the body it was worked out for).
      let uw = uwB + select(vec2f(0.0), slip, hit.b == wfB);
      let fi = ${e(l,"idx")};
      let mw = ${G(6*Pe[i])} * ${d};
      if (q < 0.5) { f${i} = 2.0 * q * fi + (1.0 - 2.0 * q) * ${e(l,"u32(bx) + u32(by) * P.nx")} + mw; }
      else { f${i} = fi / (2.0 * q) + (2.0 * q - 1.0) / (2.0 * q) * ${e(i,"idx")} + mw / (2.0 * q); }
      let slot = (S.slot * ${K}u + hit.b) * 2u;
      atomicAdd(&force[slot], i32(round((${Q(be[l])} * (fi + f${i}) - uwB.x * (fi - f${i})) * ${yt}.0)));
      atomicAdd(&force[slot + 1u], i32(round((${Q(_e[l])} * (fi + f${i}) - uwB.y * (fi - f${i})) * ${yt}.0)));
    } else {
      f${i} = ${e(i,"src")};
    }
  }`}let n="";for(let i=0;i<9;i++)n+=`  let e${i} = ${s(i)};
`;const a=i=>`(f${i} - e${i})`;n+=`
  let pxx = ${[1,3,5,6,7,8].map(a).join(" + ")};
  let pyy = ${[2,4,5,6,7,8].map(a).join(" + ")};
  let pxy = ${a(5)} - ${a(6)} + ${a(7)} - ${a(8)};
  var tP = 1.0 / P.omega;
  // In a refinement patch the least viscosity ramps up to the coarse grid's (twice the
  // patch's, in its own units) over the last cells before its edge, so the viscosity is
  // the same either side of the interface.
  var floorV = P.nuFloor;
  if (PATCH) {
    let dEdge = f32(min(min(x, y), min(P.nx - 1u - x, P.ny - 1u - y)));
    floorV = P.nuFloor * (1.0 + clamp(1.0 - (dEdge - 1.0) / 8.0, 0.0, 1.0));
    tP = 3.0 * max(P.nuMol, floorV) + 0.5;
  }
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
    tP = 3.0 * max(P.nuMol + ntOut * saFv1(ntOut), floorV) + 0.5;
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
  if (TURB > 0u || AUXW) { auxOut[idx] = vec4f(ux, uy, ntOut, nuCell); }
  // The pre-collision moments a refinement interface carries across (density, Π_neq).
  if (MOMW) { mom[idx] = vec4f(rho, pxx, pyy, pxy); }
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
`;for(let i=0;i<9;i++){const l=be[i],o=_e[i],c=l*l-1/3,u=o*o-1/3,h=l*o,d=l*l*o-o/3,f=l*o*o-l/3;n+=`  var o${i} = ${G(Pe[i])} * (drho + rho * (3.0 * (${G(l)} * ux + ${G(o)} * uy) + 4.5 * (${G(c)} * ux * ux + ${G(u)} * uy * uy + ${G(2*h)} * ux * uy) + 13.5 * (${G(d)} * ux * ux * uy + ${G(f)} * ux * uy * uy)))
    + ${G(Pe[i])} * (4.5 * (${G(c)} * dxx + ${G(u)} * dyy + ${G(2*h)} * dxy) + 13.5 * keep * (${G(d)} * axxy + ${G(f)} * axyy));
`}return n+=`  if (sig > 0.0) {
    let uT = P.uIn;
${Array.from({length:9},(i,l)=>`    o${l} = mix(o${l}, ${G(Pe[l])} * (3.0 * ${Q(be[l])} * uT + 4.5 * ${Q(be[l]*be[l])} * uT * uT - 1.5 * uT * uT), sig);`).join(`
`)}
  }
${Array.from({length:9},(i,l)=>`  fout[${l}u * P.n + idx] = o${l};`).join(`
`)}
`,`
override WALLS: u32 = 0u;
override SMAG: bool = false;
override TURB: u32 = 0u;
/** 1 - the bulk relaxation rate (0: the stress's trace fully relaxed each step; below 0: as the shear's). */
override KEEP_BULK: f32 = 0.0;
/** A refinement patch: its edge cells are not stepped (the interface sets them). */
override PATCH: bool = false;
/** Write the auxiliary field (velocity, ν̃, viscosity) without a turbulence model: refinement needs it. */
override AUXW: bool = false;
/** Write each cell's pre-collision moments (refinement). */
override MOMW: bool = false;
struct Step { slot: u32, p0: u32, p1: u32, p2: u32 };
@group(0) @binding(0) var<storage, read> fin: array<f32>;
@group(0) @binding(1) var<storage, read_write> fout: array<f32>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
@group(0) @binding(5) var<storage, read_write> force: array<atomic<i32>>;
@group(0) @binding(6) var<storage, read> auxIn: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> auxOut: array<vec4f>;
@group(0) @binding(8) var<storage, read_write> mom: array<vec4f>;
@group(1) @binding(0) var<uniform> S: Step;
${rt}
${bt}
${Rn}
${r?Ps+Cn:""}

@compute @workgroup_size(${O})
fn step(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${O}u;
  if (idx >= P.n) { return; }
  let x = idx % P.nx;
  let y = idx / P.nx;
  ${r?`if (x == 0u || y == 0u || x == P.nx - 1u || y == P.ny - 1u) {
    edgeCell(x, y, idx);
    return;
  }`:""}
  let xf = f32(x);
  let p = vec2f(xf, f32(y));
  var bp: array<vec4f, ${K}>;
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
      if (TURB > 0u || AUXW) { auxOut[idx] = vec4f(uw, 0.0, -1.0); }
      if (MOMW) { mom[idx] = vec4f(1.0, 0.0, 0.0, 0.0); }
      return;
    }
  }
  // The wall model, in the cells next to a wall: the friction velocity from the wall law at
  // the velocity ${Ge} cells off the wall (last step's), then the slip that makes the
  // stress resolved between the wall and the point one cell off it the law's (that point, not
  // this cell: a cell on the wall would set its own slip), and ν̃ = κ u_τ d here.
  var slip = vec2f(0.0);
  var wfB = ${K}u;
  var wfNt = -1.0;
  if (TURB > 0u && near != 0u && d0 < 1.5) {
    let gx = sdfAt(p + vec2f(0.5, 0.0), near, &bp).d - sdfAt(p - vec2f(0.5, 0.0), near, &bp).d;
    let gy = sdfAt(p + vec2f(0.0, 0.5), near, &bp).d - sdfAt(p - vec2f(0.0, 0.5), near, &bp).d;
    let gl = length(vec2f(gx, gy));
    if (gl > 1e-6) {
      let nrm = vec2f(gx, gy) / gl;
      let xw = p - d0 * nrm;
      let ub = wallU(b0, xw, bp[b0].xy);
      let aR = auxLerp(xw + ${Ge.toFixed(3)} * nrm);
      let aV = auxLerp(xw + nrm);
      let uR = aR.xy - ub;
      let utR = uR - dot(uR, nrm) * nrm;
      let ut = length(utR);
      if (ut > 1e-7 && aR.w >= 0.0 && aV.w >= 0.0) {
        let t = utR / ut;
        let utau = ut / wallUplus(${Ge.toFixed(3)} * ut / P.nuMol);
        let uv = dot(aV.xy - ub, t);
        let s = clamp(uv - utau * utau / max(aV.w, P.nuMol), 0.0, max(uv, 0.0));
        slip = s * t;
        wfB = b0;
        wfNt = KAPPA * utau * d0;
      }
    }
  }
  var f0 = ${e(0,"idx")};
  ${t}
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
    atomicAdd(&force[${ye}u], 1);
    atomicMax(&force[${ye+1}u], i32(P.n - idx));
  }
  var ux = (f1 - f3 + f5 - f6 - f7 + f8) / rho;
  var uy = (f2 - f4 + f5 + f6 - f7 - f8) / rho;
  // The limiter: flow squeezed in a gap two moving bodies close has nowhere to go. A cell
  // whose density leaves ±${He*100} % or whose speed passes ${Qe} (4 x the inflow) is put
  // back to equilibrium inside those bounds. Ordinary flow here stays within about 1 %, so
  // only such pockets are touched; each use is counted and the page says so.
  let usq0 = ux * ux + uy * uy;
  if (!(rho >= ${1-He} && rho <= ${1+He} && usq0 <= ${Qe*Qe})) {
    atomicAdd(&force[${ye+2}u], 1);
    let ok = rho == rho && ux == ux && uy == uy;
    rho = select(1.0, clamp(rho, ${1-He}, ${1+He}), ok);
    var uc = select(vec2f(0.0), vec2f(ux, uy), ok);
    let m = length(uc);
    if (m > ${Qe}) { uc = uc * (${Qe} / m); }
    ux = uc.x;
    uy = uc.y;
    drho = rho - 1.0;
${Array.from({length:9},(i,l)=>`    f${l} = feqAt(${l}u, rho, uc) - ${G(Pe[l])};`).join(`
`)}
  }
${n}
}
`}function As(){return`
@group(0) @binding(0) var<storage, read> fin: array<f32>;
@group(0) @binding(1) var<storage, read_write> mac: array<vec4f>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
${rt}
${bt}

@compute @workgroup_size(${O})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${O}u;
  if (idx >= P.n) { return; }
  let p = vec2f(f32(idx % P.nx), f32(idx / P.nx));
  var bp: array<vec4f, ${K}>;
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
`}function Ss(){return`
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

@compute @workgroup_size(${O})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${O}u;
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
`}function Bs(){return`
struct View {
  scale: f32, ox: f32, oy: f32, lo: f32,
  hi: f32, nxf: f32, nyf: f32, absorbIn: f32,
  spongeX: f32, uRef: f32, arrowCells: f32, flags: u32,
  bg: vec4f, body: vec4f, edge: vec4f, zone: vec4f,
  plain: vec4f, arrow: vec4f,
  dye: array<vec4f, 4>,
  rBase: vec4f, l1dir: vec4f, l1col: vec4f, l2dir: vec4f, l2col: vec4f,
  rParams: vec4f,
  /** A refinement patch drawn from its own cells: its rectangle (lattice) and (cells per lattice cell, its grid, on). */
  patchBox: vec4f, patchGrid: vec4f,
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
@group(0) @binding(10) var<storage, read> fineScalar: array<f32>;
${rt}
${bt}

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
  // Inside a refinement patch (a cell in from its edge): its own, finer field.
  let pb = Vw.patchBox;
  if (Vw.patchGrid.w > 0.5 && l.x > pb.x + 1.0 && l.y > pb.y + 1.0 && l.x < pb.z - 1.0 && l.y < pb.w - 1.0) {
    let nx = u32(Vw.patchGrid.y);
    let ny = u32(Vw.patchGrid.z);
    let q = clamp((l - pb.xy) * Vw.patchGrid.x, vec2f(0.0), vec2f(f32(nx) - 1.001, f32(ny) - 1.001));
    let i = u32(q.x);
    let j = u32(q.y);
    let f = fract(q);
    let k = i + j * nx;
    return mix(mix(fineScalar[k], fineScalar[k + 1u], f.x), mix(fineScalar[k + nx], fineScalar[k + nx + 1u], f.x), f.y);
  }
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
  var bp: array<vec4f, ${K}>;
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
`}function $n(){return[{label:"step",code:Dt()},{label:"patch step",code:Dt(!0)},{label:"macro",code:As()},{label:"field",code:Ss()},{label:"render",code:Bs()}]}function Rs(r){return r==="inferno"?wn:tn(r)}class Un{device;ctx;format;pipe;viewBuf;lutBuf;lutName="";dummyBuf;dummyTex;constructor(e,s){this.device=e;const t=s.getContext("webgpu");if(!t)throw new Error("The canvas has no WebGPU context.");this.ctx=t,this.format=navigator.gpu.getPreferredCanvasFormat(),t.configure({device:e,format:this.format,alphaMode:"opaque"});const n=e.createShaderModule({code:Bs(),label:"tunnel render"});this.pipe=e.createRenderPipeline({layout:"auto",vertex:{module:n,entryPoint:"vs"},fragment:{module:n,entryPoint:"fs",targets:[{format:this.format}]},primitive:{topology:"triangle-list"}}),this.viewBuf=e.createBuffer({size:336,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.lutBuf=e.createBuffer({size:256*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.dummyBuf=e.createBuffer({size:64,usage:GPUBufferUsage.STORAGE}),this.dummyTex=e.createTexture({size:[1,1],format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING})}setColormap(e){if(e===this.lutName)return;const s=Rs(e),t=s.length/3,n=new Float32Array(256*4);for(let a=0;a<256;a++){const i=Math.min(t-1,Math.round(a/255*(t-1)));n[4*a]=s[3*i]/255,n[4*a+1]=s[3*i+1]/255,n[4*a+2]=s[3*i+2]/255,n[4*a+3]=1}this.device.queue.writeBuffer(this.lutBuf,0,n),this.lutName=e}get lut(){return this.lutBuf}get dummies(){return{scalar:this.dummyBuf,lut:this.lutBuf}}get size(){const e=this.ctx.getCurrentTexture();return{w:e.width,h:e.height}}encode(e,s,t,n,a,i,l){const o=s.buffers,c=this.device.createBindGroup({layout:this.pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:o.scalar}},{binding:1,resource:{buffer:this.viewBuf}},{binding:2,resource:{buffer:o.params}},{binding:3,resource:{buffer:o.bodies}},{binding:4,resource:{buffer:o.sdf}},{binding:5,resource:{buffer:this.lutBuf}},{binding:6,resource:{buffer:s.macroBuf}},{binding:7,resource:{buffer:i.dye??this.dummyBuf}},{binding:8,resource:(i.trail??this.dummyTex).createView()},{binding:9,resource:{buffer:i.rheo?.field??this.dummyBuf}},{binding:10,resource:{buffer:i.patch?.scalar??this.dummyBuf}}]}),u=(i.plain?1:0)|(i.arrows?2:0)|(i.dye?4:0)|(i.trail?8:0)|(i.rheo?16:0),h=new ArrayBuffer(336),d=new Float32Array(h),f=new Uint32Array(h);d.set([t.scale,t.ox,t.oy,n.lo,n.hi,s.nx,s.ny,s.absorbInX,s.spongeX,i.uRef,i.arrowCells]),f[11]=u,d.set([...a.bg,1],12),d.set([...a.body,1],16),d.set([...a.edge,1],20),d.set(a.zone,24),d.set([...a.plain,1],28),d.set(a.arrow,32);for(let p=0;p<4;p++)d.set(i.dyeColors[p]??[0,0,0,0],36+4*p);if(i.rheo){const p=i.rheo.look;d.set([...p.base,1],52),d.set([...p.l1.dir,0],56),d.set([...p.l1.color,p.l1.diffuse],60),d.set([...p.l2.dir,0],64),d.set([...p.l2.color,p.l2.diffuse],68),d.set([p.sharp,i.rheo.sparkle[0],i.rheo.sparkle[1],p.glint],72)}if(i.patch){const p=i.patch;d.set([p.x0,p.y0,p.x1,p.y1,p.scale,p.nx,p.ny,1],76)}this.device.queue.writeBuffer(this.viewBuf,0,h);const y=e.beginRenderPass({colorAttachments:[{view:this.ctx.getCurrentTexture().createView(),loadOp:"clear",storeOp:"store",clearValue:{r:a.bg[0],g:a.bg[1],b:a.bg[2],a:1}}]});y.setPipeline(this.pipe),y.setBindGroup(0,c),y.draw(3),l?.(y),y.end()}destroy(){this.viewBuf.destroy(),this.lutBuf.destroy(),this.dummyBuf.destroy(),this.dummyTex.destroy(),this.ctx.unconfigure()}}const is=256*1024,Tn=80,Gt=10,Nt=1e3;class ce extends Error{}function Fn(r){const e=r.trim().split(/[\s,;]+/).filter(Boolean),s=[];for(const t of e){const n=Number(t.replace(/[Dd]/,"e"));if(t===""||Number.isNaN(n))return null;s.push(n)}return s}function St(r){return r.replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,Tn)}const qt=(r,e)=>r.flatMap((s,t)=>[s,e[t]]);function En(r,e=""){if(new TextEncoder().encode(r).length>is)throw new ce(`The file is larger than ${is/1024} KB; an airfoil file is a few KB.`);const s=r.replace(/^﻿/,"").split(/\r\n|\r|\n/);let t="";const n=[];let a=!1;if(s.forEach((h,d)=>{const f=d+1,y=h.trim();if(!y||y.startsWith("#"))return;const p=Fn(y);if(!a&&!t&&(p===null||p.length!==2)){t=St(y);return}if(p===null)throw new ce(`Line ${f}: expected two numbers (x and y), found “${St(y).slice(0,40)}”.`);if(p.length!==2)throw new ce(`Line ${f}: expected two numbers (x and y), found ${p.length}.`);if(!p.every(Number.isFinite))throw new ce(`Line ${f}: the numbers must be finite.`);n.push([f,p[0],p[1]]),a=!0}),!t){const h=String(e||"").replace(/\\/g,"/").split("/").pop()?.replace(/\.[A-Za-z0-9]{1,4}$/,"")??"";t=St(h)||"Imported airfoil"}if(!n.length)throw new ce("The file has no coordinates.");const i=[],l=n[0];let o,c,u;return l[1]>=2&&l[2]>=2&&Number.isInteger(l[1])&&Number.isInteger(l[2])?([o,c]=_n(n,l[1],l[2]),u="lednicer",i.push("Read as a Lednicer file (upper and lower surfaces apart) and joined in Selig order.")):(o=n.map(h=>h[1]),c=n.map(h=>h[2]),u="selig"),[o,c]=Dn(o,c,i),{name:t,x:o,y:c,layout:u,warnings:i}}function _n(r,e,s){const t=r.slice(1);if(t.length!==e+s)throw new ce(`Line ${r[0][0]}: the file says ${e} upper and ${s} lower points, but it has ${t.length} points.`);const n=t.slice(0,e),a=t.slice(e),i=n.map(u=>u[1]).reverse(),l=n.map(u=>u[2]).reverse();let o=a.map(u=>u[1]),c=a.map(u=>u[2]);return a.length&&n.length&&Math.abs(a[0][1]-n[0][1])<=1e-9&&Math.abs(a[0][2]-n[0][2])<=1e-9&&(o=o.slice(1),c=c.slice(1)),[[...i,...o],[...l,...c]]}function Dn(r,e,s){let t=[r[0]],n=[e[0]],a=0;for(let f=1;f<r.length;f++){if(Math.abs(r[f]-t[t.length-1])<=1e-12&&Math.abs(e[f]-n[n.length-1])<=1e-12){a++;continue}t.push(r[f]),n.push(e[f])}if(a&&s.push(`Removed ${a} repeated point${a!==1?"s":""}.`),t.length<Gt)throw new ce(`The file has ${t.length} points; an airfoil needs at least ${Gt}.`);if(t.length>Nt)throw new ce(`The file has ${t.length} points; at most ${Nt} are read.`);const i=Math.min(...t),o=Math.max(...t)-i;if(o<=0)throw new ce("Every point has the same x: this is not an airfoil.");const c=t.indexOf(i);if(c===0||c===t.length-1)throw new ce("The points must start at the trailing edge, run over one surface to the leading edge and back along the other (Selig order).");if(Math.min(t[0],t[t.length-1])<i+.5*o)throw new ce("The first and last points must be at the trailing edge (Selig order).");const u=t[c],h=n[c],d=Math.min(...t.map((f,y)=>Math.hypot(f,n[y])))<=.002;if((Math.abs(o-1)>.001||!d)&&(t=t.map(f=>(f-u)/o),n=n.map(f=>(f-h)/o),s.push(Math.abs(o-1)>.001?`Scaled to chord 1 (it was ${Number(o.toPrecision(6))}).`:"Moved so that the leading edge is at (0, 0).")),bs(qt(t,n))<0&&(t=t.reverse(),n=n.reverse(),s.push("The points ran over the lower surface first; reversed to Selig order (upper surface first).")),yn(qt(t,n)))throw new ce("The outline crosses itself.");if(Gn(t,n)<.002)throw new ce("The section is thinner than 0.2 % of its chord.");return[t,n]}function Gn(r,e){const s=qt(r,e);let t=0;for(let n=1;n<50;n++){const a=n/50,i=[],l=s.length/2;for(let o=0;o<l;o++){const c=(o+1)%l,[u,h,d,f]=[s[2*o],s[2*o+1],s[2*c],s[2*c+1]];u>a!=d>a&&i.push(h+(a-u)*(f-h)/(d-u))}i.length>=2&&(t=Math.max(t,Math.max(...i)-Math.min(...i)))}return t}const ut=4,tt={air:{label:"Air (20 °C)",nu:1516e-8,rho:1.204},water:{label:"Water (20 °C)",nu:1004e-9,rho:998.2}},L={length:[.01,1e3],height:[.005,1e3],speed:[1e-4,340],maxBodies:8,maxRakes:8,maxDyeRakes:4,emitters:[1,64]},xt=6;let Ve=0;function Xt(){return Ve=(Ve+1)%1e6,`b${Date.now().toString(36)}${Ve.toString(36)}`}function Cs(){return Ve=(Ve+1)%1e6,`r${Date.now().toString(36)}${Ve.toString(36)}`}function dt(){return{version:ut,tunnel:{length:8,height:4,walls:"farfield",resolution:"auto",refine:0},flow:{speed:10,fluid:"air",model:"auto"},bodies:[{id:Xt(),name:"NACA 2412",shape:{kind:"naca",code:"2412",chord:1},x:2.5,y:2,angle:6,spin:0,enabled:!0,locked:!1}],rakes:[],view:{field:"particles",autoRange:!0,min:-10,max:10,speed:"max",tracers:!1,density:"normal",trail:"short",arrows:!1,streamlines:!1,rheoPreset:"kalliroscope",particleColor:"speed"}}}const Nn=1e5;function rs(r){if(r.flow.model!=="auto")return r.flow.model==="sa"?"sa":"off";const e=tt[r.flow.fluid].nu;return Math.max(0,...r.bodies.filter(t=>t.enabled).map(t=>r.flow.speed*Ue(t.shape)/e))>=Nn?"sa":"off"}class gt extends Error{}const V=(r,e,s=-1/0,t=1/0)=>{const n=Number(r);if(!Number.isFinite(n)||n<s||n>t)throw new gt(`${e} must be a number from ${s} to ${t}.`);return n},pe=(r,e,s)=>e.includes(r)?r:s;function qn(r){const e=r??{};switch(e.kind){case"naca":return{kind:"naca",code:Vt(String(e.code)),chord:V(e.chord,"Chord",1e-4,1e3)};case"dat":{const s=Array.isArray(e.x)?e.x.map(Number):[],t=Array.isArray(e.y)?e.y.map(Number):[];if(s.length!==t.length||s.length<Gt||s.length>Nt||![...s,...t].every(Number.isFinite))throw new gt("An imported airfoil needs matching x and y lists of finite numbers.");return{kind:"dat",name:String(e.name??"Imported airfoil").slice(0,80),x:s,y:t,chord:V(e.chord,"Chord",1e-4,1e3)}}case"circle":return{kind:"circle",diameter:V(e.diameter,"Diameter",1e-4,1e3)};case"rect":return{kind:"rect",width:V(e.width,"Width",1e-4,1e3),height:V(e.height,"Height",1e-4,1e3)};case"ellipse":return{kind:"ellipse",width:V(e.width,"Width",1e-4,1e3),height:V(e.height,"Height",1e-4,1e3)};case"plate":return{kind:"plate",length:V(e.length,"Length",1e-4,1e3),thickness:V(e.thickness,"Thickness",1e-5,1e3)};default:throw new gt(`Unknown body shape “${String(e.kind)}”.`)}}function zn(r){const e=r??{},s=Number(e.version??ut);if(s>ut)throw new gt(`This tunnel was saved by a newer version of the plugin (scene version ${s}).`);const t=dt(),n=e.tunnel??{},a=e.flow??{},i=e.view??{},l=(Array.isArray(e.bodies)?e.bodies:[]).slice(0,L.maxBodies).map(c=>({id:typeof c?.id=="string"&&c.id?c.id.slice(0,40):Xt(),name:String(c?.name??"Body").slice(0,80),shape:qn(c?.shape),x:V(c?.x,"Body x"),y:V(c?.y,"Body y"),angle:V(c?.angle??0,"Body angle",-3600,3600),spin:V(c?.spin??0,"Body spin",-1e4,1e4),enabled:c?.enabled!==!1,locked:c?.locked===!0})),o=(Array.isArray(e.rakes)?e.rakes:[]).slice(0,L.maxRakes).map((c,u)=>({id:typeof c?.id=="string"&&c.id?c.id.slice(0,40):Cs(),kind:pe(c?.kind,["streaks","timelines","dye"],"streaks"),x0:V(c?.x0,"Rake x"),y0:V(c?.y0,"Rake y"),x1:V(c?.x1,"Rake x"),y1:V(c?.y1,"Rake y"),emitters:Math.round(V(c?.emitters??12,"Rake emitters",...L.emitters)),color:Math.round(V(c?.color??u%xt,"Rake colour",0,xt-1)),enabled:c?.enabled!==!1}));return{version:ut,tunnel:{length:V(n.length??t.tunnel.length,"Tunnel length",...L.length),height:V(n.height??t.tunnel.height,"Tunnel height",...L.height),walls:pe(n.walls,["farfield","slip","noslip","periodic"],t.tunnel.walls),resolution:pe(n.resolution,["auto","low","medium","high","ultra"],t.tunnel.resolution),refine:[0,1,2].find(c=>c===Number(n.refine))??t.tunnel.refine},flow:{speed:V(a.speed??t.flow.speed,"Wind speed",...L.speed),fluid:pe(a.fluid,["air","water"],t.flow.fluid),model:pe(a.model,["auto","resolved","sa"],t.flow.model)},bodies:l,rakes:o,view:{field:pe(i.field,["particles","vorticity","speed","pressure","schlieren","rheoscopic","none"],t.view.field),autoRange:i.autoRange!==!1,min:Number.isFinite(Number(i.min))?Number(i.min):t.view.min,max:Number.isFinite(Number(i.max))?Number(i.max):t.view.max,speed:pe(i.speed,["max","realtime"],t.view.speed),tracers:i.tracers===!0,density:pe(i.density,["low","normal","high"],t.view.density),trail:pe(i.trail,["off","short","long"],t.view.trail),arrows:i.arrows===!0,streamlines:i.streamlines===!0,rheoPreset:pe(i.rheoPreset,["kalliroscope","pearl","copper"],t.view.rheoPreset),particleColor:pe(i.particleColor,["speed","vorticity"],t.view.particleColor)}}}const Ln=3,On=48,as=2.5,Yt=`
struct G { nx: u32, ny: u32, dt: f32, sign: f32, nsrc: u32, r: f32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<uniform> Gd: G;
`,$s=`
fn idx(i: i32, j: i32) -> u32 { return u32(clamp(i, 0, i32(Gd.nx) - 1)) + u32(clamp(j, 0, i32(Gd.ny) - 1)) * Gd.nx; }
fn bil(c: vec2f) -> vec4f {
  let p = clamp(c, vec2f(0.0), vec2f(f32(Gd.nx) - 1.001, f32(Gd.ny) - 1.001));
  let i = i32(p.x);
  let j = i32(p.y);
  let f = p - vec2f(f32(i), f32(j));
  return mix(mix(src[idx(i, j)], src[idx(i + 1, j)], f.x), mix(src[idx(i, j + 1)], src[idx(i + 1, j + 1)], f.x), f.y);
}
`,Us=()=>`${Yt}
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec4f>;
${$s}
@compute @workgroup_size(${O})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${O}u;
  if (k >= Gd.nx * Gd.ny) { return; }
  let m = mac[k];
  if (m.w > 0.5) { dst[k] = vec4f(0.0); return; }
  let p = vec2f(f32(k % Gd.nx), f32(k / Gd.nx));
  dst[k] = bil(p - Gd.sign * Gd.dt * m.xy);
}
`,Ts=()=>`${Yt}
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read> fwd: array<vec4f>;
@group(0) @binding(4) var<storage, read> back: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> dst: array<vec4f>;
${$s}
@compute @workgroup_size(${O})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${O}u;
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
`,Fs=()=>`${Yt}
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
`;class In{device;nx;ny;bufs;cur=0;advect;correct;inject;unis=[];srcBuf;srcCount=0;srcKey="";constructor(e,s,t){this.device=e,this.nx=s,this.ny=t;const n=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.bufs=[0,1,2,3].map(()=>e.createBuffer({size:s*t*16,usage:n}));const a=(i,l)=>e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:i,label:l}),entryPoint:"main"}});this.advect=a(Us(),"dye advect"),this.correct=a(Ts(),"dye correct"),this.inject=a(Fs(),"dye inject"),this.srcBuf=e.createBuffer({size:16*512,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.unis=[0,1].map(()=>e.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}))}get field(){return this.bufs[this.cur]}setSources(e){const s=e.map(i=>`${i.x.toFixed(2)},${i.y.toFixed(2)},${i.channel}`).join("|");if(s===this.srcKey)return;this.srcKey=s;const t=new ArrayBuffer(16*Math.min(512,e.length)),n=new Float32Array(t),a=new Uint32Array(t);e.slice(0,512).forEach((i,l)=>{n[4*l]=i.x,n[4*l+1]=i.y,a[4*l+2]=i.channel}),t.byteLength&&this.device.queue.writeBuffer(this.srcBuf,0,t),this.srcCount=Math.min(512,e.length)}clear(){for(const e of this.bufs)this.device.queue.writeBuffer(e,0,new Float32Array(this.nx*this.ny*4))}uniform(e,s,t){const n=new ArrayBuffer(32),a=new Uint32Array(n),i=new Float32Array(n);a[0]=this.nx,a[1]=this.ny,i[2]=s,i[3]=t,a[4]=this.srcCount,i[5]=as;const l=this.unis[e];return this.device.queue.writeBuffer(l,0,n),l}encode(e,s,t){if(s<=0||this.srcCount===0)return;const n=Math.min(On,Math.max(1,Math.ceil(s*.1/Ln))),a=s/n,i=this.uniform(0,a,1),l=this.uniform(1,a,-1),o=this.nx*this.ny,c=Math.ceil(o/O),u=Math.min(c,32768),h=Math.ceil(c/u),d=(p,b,g)=>this.device.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:b}},...g.map((S,P)=>({binding:2+P,resource:{buffer:S}}))]}),f=2*Math.ceil(as)+1,y=e.beginComputePass({label:"dye"});for(let p=0;p<n;p++){const b=this.bufs[this.cur],[g,S,P]=[1,2,3].map(x=>this.bufs[(this.cur+x)%4]);y.setPipeline(this.advect),y.setBindGroup(0,d(this.advect,i,[b,g])),y.dispatchWorkgroups(u,h),y.setBindGroup(0,d(this.advect,l,[g,S])),y.dispatchWorkgroups(u,h),y.setPipeline(this.correct),y.setBindGroup(0,d(this.correct,i,[b,g,S,P])),y.dispatchWorkgroups(u,h),y.setPipeline(this.inject),y.setBindGroup(0,d(this.inject,i,[this.srcBuf,P])),y.dispatchWorkgroups(Math.ceil(this.srcCount*f*f/64)),this.cur=(this.cur+3)%4}y.end()}async read(){const e=this.device.createBuffer({size:this.nx*this.ny*16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),s=this.device.createCommandEncoder();s.copyBufferToBuffer(this.field,0,e,0,this.nx*this.ny*16),this.device.queue.submit([s.finish()]),await e.mapAsync(GPUMapMode.READ);const t=new Float32Array(e.getMappedRange().slice(0));return e.destroy(),t}destroy(){for(const e of[...this.bufs,this.srcBuf,...this.unis])e.destroy()}}const Vn=.8,Wn=.12,jn=160,le=8,Bt=1.4,Xn=320,Rt=14,Es=()=>`
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
${rt}
${bt}

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

@compute @workgroup_size(${O})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * ${O}u;
  if (i >= Ad.count) { return; }
  var m = pmeta[i];
  if (m.w < 0.5) { return; }
  var q = pos[i].xy;
  var prev = q;
  var gone = false;
  var bp: array<vec4f, ${K}>;
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
`,_s=()=>`
struct D {
  scale: f32, ox: f32, oy: f32, w: f32,
  h: f32, halfW: f32, maxSeg: f32, tail: f32,
  tracer: vec4f,
  colors: array<vec4f, ${le}>,
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
  o.c = select(Dr.colors[min(u32(m.z), ${le-1}u)], Dr.tracer, m.y < 0.0);
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
`,Ds=()=>`
struct D {
  scale: f32, ox: f32, oy: f32, w: f32,
  h: f32, halfW: f32, maxSeg: f32, first: f32,
  colors: array<vec4f, ${le}>,
  gaps: array<vec4f, ${le}>,
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
  let src = min(u32(ma.y), ${le-1}u);
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
  let col = Dr.colors[min(u32(ma.z), ${le-1}u)];
  o.c = vec4f(col.rgb, col.a * fade);
  o.d = c.y;
  return o;
}

@fragment
fn fs(i: Out) -> @location(0) vec4f {
  return vec4f(i.c.rgb, i.c.a * clamp((1.0 - abs(i.d)) * 1.6, 0.0, 1.0));
}
`,Gs=`
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f { return vec4f(0.0); }
`;class Yn{device;pos=null;meta=null;capacity=0;tracers=0;rakes=[];layoutKey="";advectPipe;advectUni;drawPipe;fadePipe;drawUni;linePipe=null;lineUni;seed=1;streakGap=1;fadeSteps=1e4;trail=null;trailKey="";clearTrail=!0;format="rgba16float";constructor(e){this.device=e,this.advectPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:Es(),label:"particles advect"}),entryPoint:"main"}}),this.advectUni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});const s=e.createShaderModule({code:_s(),label:"particles draw"}),t={color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}};this.drawPipe=e.createRenderPipeline({layout:"auto",vertex:{module:s,entryPoint:"vs"},fragment:{module:s,entryPoint:"fs",targets:[{format:this.format,blend:t}]},primitive:{topology:"triangle-list"}});const n=e.createShaderModule({code:Gs,label:"trail fade"});this.fadePipe=e.createRenderPipeline({layout:"auto",vertex:{module:n,entryPoint:"vs"},fragment:{module:n,entryPoint:"fs",targets:[{format:this.format,blend:{color:{srcFactor:"zero",dstFactor:"constant",operation:"add"},alpha:{srcFactor:"zero",dstFactor:"constant",operation:"add"}}}]},primitive:{topology:"triangle-list"}}),this.drawUni=e.createBuffer({size:80+16*le,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.lineUni=e.createBuffer({size:32+32*le,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}encodeRakeLines(e,s,t,n,a,i){if(!this.pos||!this.meta||!this.rakes.length)return;if(!this.linePipe){const u=this.device.createShaderModule({code:Ds(),label:"rake lines"});this.linePipe=this.device.createRenderPipeline({layout:"auto",vertex:{module:u,entryPoint:"vs"},fragment:{module:u,entryPoint:"fs",targets:[{format:s,blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-list"}})}const l=new Float32Array(8+8*le);l.set([n.scale,n.ox,n.oy,t.w,t.h,.75*i,80*i,this.tracers]),a.slice(0,le).forEach((u,h)=>l.set(u,8+4*h));for(const u of this.rakes){const h=8+4*le+4*Math.min(u.index,le-1);l[h]=u.rake.kind==="streaks"?this.streakGap*2.5:.5,l[h+1]=this.fadeSteps}this.device.queue.writeBuffer(this.lineUni,0,l);const o=this.device.createBindGroup({layout:this.linePipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.pos}},{binding:1,resource:{buffer:this.meta}},{binding:2,resource:{buffer:this.lineUni}}]});e.setPipeline(this.linePipe),e.setBindGroup(0,o);const c=this.capacity-this.tracers-1;c>0&&e.draw(6,c)}get count(){return this.capacity}get tracerCount(){return this.tracers}get buffers(){return this.pos&&this.meta?{pos:this.pos,meta:this.meta}:null}get pools(){return this.rakes.map(e=>({id:e.rake.id,index:e.index,base:e.base,slots:e.slots}))}configure(e,s,t){const n=[];let a=e;s.forEach((d,f)=>{const y=d.kind==="streaks"?Math.ceil(t.nx*1.2*Bt):Xn,p=d.kind==="streaks"?y*d.emitters:y*Rt;n.push({rake:d,index:f,base:a,per:y,slots:p,head:0,acc:0}),a+=p});const i=`${e}|${t.nx}x${t.ny}|${s.map(d=>`${d.id}:${d.kind}:${d.emitters}`).join(",")}`;if(i===this.layoutKey){n.forEach((d,f)=>{this.rakes[f].rake=d.rake});return}this.layoutKey=i,this.rakes=n,this.tracers=e;const l=Math.max(1,a);if(l>this.capacity||!this.pos){this.pos?.destroy(),this.meta?.destroy();const d=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.pos=this.device.createBuffer({size:l*16,usage:d}),this.meta=this.device.createBuffer({size:l*16,usage:d})}this.capacity=l;const o=new Float32Array(l*4),c=new Float32Array(l*4);let u=12345;const h=()=>(u=u*1103515245+12345&2147483647)/2147483647;for(let d=0;d<e;d++){const f=t.absorbInX+h()*(t.outX-t.absorbInX),y=h()*(t.ny-1);o.set([f,y,f,y],4*d),c.set([0,-1,0,1],4*d)}this.device.queue.writeBuffer(this.pos,0,o),this.device.queue.writeBuffer(this.meta,0,c),this.clearTrail=!0}emit(e){if(!(!this.pos||!this.meta||e.steps<=0))for(const s of this.rakes){const{rake:t}=s;if(t.kind==="streaks"){this.streakGap=1/(e.u*Bt),this.fadeSteps=.85*e.nx/e.u,s.acc+=e.u*e.steps*Bt;const n=Math.min(s.per,Math.floor(s.acc));if(s.acc-=n,n<=0)continue;const a=new Float32Array(n*4),i=new Float32Array(n*4);for(let l=0;l<t.emitters;l++){const o=t.emitters===1?.5:l/(t.emitters-1),c=t.x0+(t.x1-t.x0)*o,u=t.y0+(t.y1-t.y0)*o;for(let h=0;h<n;h++)a.set([c,u,c,u],4*h),i.set([-((h+.5)/n)*e.steps,s.index,t.color,1],4*h);this.writeRing(s.base+l*s.per,s.per,s.head,a,i,n)}s.head=(s.head+n)%s.per}else{const n=e.nx*.1/e.u;for(this.fadeSteps=.85*e.nx/e.u,s.acc+=e.steps;s.acc>=n;){s.acc-=n;const a=-Math.max(0,e.steps-s.acc),i=new Float32Array(s.per*4),l=new Float32Array(s.per*4);for(let c=0;c<s.per;c++){const u=c/(s.per-1),h=t.x0+(t.x1-t.x0)*u,d=t.y0+(t.y1-t.y0)*u;i.set([h,d,h,d],4*c),l.set([a,s.index,t.color,1],4*c)}const o=s.head%Rt;this.device.queue.writeBuffer(this.pos,(s.base+o*s.per)*16,i),this.device.queue.writeBuffer(this.meta,(s.base+o*s.per)*16,l),s.head=(s.head+1)%Rt}}}}writeRing(e,s,t,n,a,i){const l=Math.min(i,s-t);this.device.queue.writeBuffer(this.pos,(e+t)*16,n,0,l*4),this.device.queue.writeBuffer(this.meta,(e+t)*16,a,0,l*4),i>l&&(this.device.queue.writeBuffer(this.pos,e*16,n,l*4,(i-l)*4),this.device.queue.writeBuffer(this.meta,e*16,a,l*4,(i-l)*4))}encodeAdvect(e,s,t,n){if(!this.pos||!this.meta||s.steps<=0)return;this.emit(s);const a=Math.min(jn,Math.max(1,Math.ceil(s.steps*Wn/Vn))),i=new ArrayBuffer(48),l=new Uint32Array(i),o=new Float32Array(i);l[0]=this.capacity,l[1]=a,o[2]=s.steps/a,l[3]=this.seed=this.seed*1664525+1013904223>>>0,o[4]=s.nx,o[5]=s.ny,o[6]=s.outX,o[7]=s.absorbInX,o[8]=Math.max(1,s.u*s.steps),o[9]=.35*s.nx/s.u,l[10]=s.wrapY?1:0,this.device.queue.writeBuffer(this.advectUni,0,i);const c=this.device.createBindGroup({layout:this.advectPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:this.pos}},{binding:2,resource:{buffer:this.meta}},{binding:3,resource:{buffer:n.params}},{binding:4,resource:{buffer:n.bodies}},{binding:5,resource:{buffer:n.sdf}},{binding:6,resource:{buffer:this.advectUni}}]}),u=Math.ceil(this.capacity/O),h=Math.min(u,32768),d=e.beginComputePass({label:"particles"});d.setPipeline(this.advectPipe),d.setBindGroup(0,c),d.dispatchWorkgroups(h,Math.ceil(u/h)),d.end()}ensureTrail(e,s,t){const n=`${e}x${s}`;(!this.trail||n!==this.trailKey)&&(this.trail?.destroy(),this.trail=this.device.createTexture({size:[e,s],format:this.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),this.trailKey=n,this.clearTrail=!0),t!==this.lastView&&(this.lastView=t,this.clearTrail=!0)}lastView="";encodeDraw(e,s,t,n,a,i,l,o){const c=`${t.scale.toFixed(9)}|${t.ox.toFixed(4)}|${t.oy.toFixed(4)}`;this.ensureTrail(s.w,s.h,c);const u=this.trail.createView(),h=e.beginRenderPass({colorAttachments:[{view:u,loadOp:this.clearTrail?"clear":"load",storeOp:"store",clearValue:{r:0,g:0,b:0,a:0}}]});if(this.clearTrail=!1,h.setPipeline(this.fadePipe),h.setBlendConstant({r:n,g:n,b:n,a:n}),h.draw(3),this.pos&&this.meta&&a.tracers&&this.tracers>0){const d=new Float32Array(20+4*le);d.set([t.scale,t.ox,t.oy,s.w,s.h,s.dot,60,s.tail]),d.set(i.tracer,8);const f=12+4*le;d.set([l?.lo??0,l?.hi??1,l?1:0,l?.nx??1,l?.lift??0,l?.ny??1,s.taper?1:0,0],f),this.device.queue.writeBuffer(this.drawUni,0,d);const y=this.device.createBindGroup({layout:this.drawPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.pos}},{binding:1,resource:{buffer:this.meta}},{binding:2,resource:{buffer:this.drawUni}},{binding:3,resource:{buffer:l?.scalar??o.scalar}},{binding:4,resource:{buffer:l?.lut??o.lut}}]});h.setPipeline(this.drawPipe),h.setBindGroup(0,y),h.draw(6,this.tracers)}h.end()}async read(){if(!this.pos||!this.meta)return null;const e=this.capacity*16,s=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),t=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),n=this.device.createCommandEncoder();n.copyBufferToBuffer(this.pos,0,s,0,e),n.copyBufferToBuffer(this.meta,0,t,0,e),this.device.queue.submit([n.finish()]),await Promise.all([s.mapAsync(GPUMapMode.READ),t.mapAsync(GPUMapMode.READ)]);const a={pos:new Float32Array(s.getMappedRange().slice(0)),meta:new Float32Array(t.getMappedRange().slice(0))};return s.destroy(),t.destroy(),a}clear(){this.clearTrail=!0,this.layoutKey=""}destroy(){this.pos?.destroy(),this.meta?.destroy(),this.trail?.destroy(),this.advectUni.destroy(),this.drawUni.destroy(),this.lineUni.destroy()}}const Ct=96,Kn=.25,Hn=24,Ns=()=>`
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

@compute @workgroup_size(${O})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${O}u;
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
  let sub = u32(clamp(ceil(rate * Rp.dt / ${Kn}), 1.0, ${Hn}.0));
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
`;class Qn{device;nx;ny;bufs;cur=0;pipe;uni;frame=0;seed=7;constructor(e,s,t){this.device=e,this.nx=s,this.ny=t;const n=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.bufs=[e.createBuffer({size:s*t*32,usage:n}),e.createBuffer({size:s*t*32,usage:n})],this.pipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:Ns(),label:"rheoscopic"}),entryPoint:"main"}}),this.uni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.reset()}reset(){const e=new Float32Array(this.nx*this.ny*8);let s=99;const t=()=>(s=s*1103515245+12345&2147483647)/2147483647;for(let n=0;n<this.nx*this.ny;n++)e.set([1/3,1/3,1/3,0,0,0,t(),t()],8*n);this.device.queue.writeBuffer(this.bufs[0],0,e),this.device.queue.writeBuffer(this.bufs[1],0,e),this.frame=0}get field(){return this.bufs[this.cur]}get sparkleWeights(){const e=this.frame%Ct/Ct,s=Math.sin(Math.PI*e)**2;return[s,1-s]}encode(e,s,t,n){if(s<=0)return;const a=new ArrayBuffer(48),i=new Uint32Array(a),l=new Float32Array(a);i[0]=this.nx,i[1]=this.ny,i[2]=this.frame,i[3]=this.seed=this.seed*1664525+1013904223>>>0,l[4]=s,l[5]=1/Math.max(1,n.depthCells),l[6]=1/Math.max(1,n.relaxSteps),l[7]=n.inletX,i[8]=Ct,this.device.queue.writeBuffer(this.uni,0,a);const o=this.device.createBindGroup({layout:this.pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:this.bufs[this.cur]}},{binding:2,resource:{buffer:this.bufs[this.cur^1]}},{binding:3,resource:{buffer:this.uni}}]}),c=this.nx*this.ny,u=Math.ceil(c/O),h=Math.min(u,32768),d=e.beginComputePass({label:"rheoscopic"});d.setPipeline(this.pipe),d.setBindGroup(0,o),d.dispatchWorkgroups(h,Math.ceil(u/h)),d.end(),this.cur^=1,this.frame++}async read(){const e=this.nx*this.ny*32,s=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),t=this.device.createCommandEncoder();t.copyBufferToBuffer(this.field,0,s,0,e),this.device.queue.submit([t.finish()]),await s.mapAsync(GPUMapMode.READ);const n=new Float32Array(s.getMappedRange().slice(0));return s.destroy(),n}destroy(){this.bufs[0].destroy(),this.bufs[1].destroy(),this.uni.destroy()}}const Ze=1024,os=512,qs=`
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
`,zs=`
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
`;class Zn{device;verts;trace;draw;traceUni;drawUni;lines=0;constructor(e,s){this.device=e,this.verts=e.createBuffer({size:os*Ze*16,usage:GPUBufferUsage.STORAGE}),this.trace=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:qs,label:"streamlines trace"}),entryPoint:"main"}});const t=e.createShaderModule({code:zs,label:"streamlines draw"});this.draw=e.createRenderPipeline({layout:"auto",vertex:{module:t,entryPoint:"vs"},fragment:{module:t,entryPoint:"fs",targets:[{format:s,blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-list"}}),this.traceUni=e.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.drawUni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}get count(){return this.lines}encodeTrace(e,s,t,n,a){this.lines=Math.max(1,Math.min(os,Math.floor(a)));const i=new ArrayBuffer(32),l=new Float32Array(i),o=new Uint32Array(i);l[0]=t.nx,l[1]=t.ny,o[2]=this.lines,o[3]=Ze,l[4]=n,l[5]=0,l[6]=(t.ny-1)/this.lines,l[7]=Math.max(.5,t.nx*1.4/Ze),this.device.queue.writeBuffer(this.traceUni,0,i);const c=this.device.createBindGroup({layout:this.trace.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:s}},{binding:1,resource:{buffer:this.verts}},{binding:2,resource:{buffer:this.traceUni}}]}),u=e.beginComputePass({label:"streamlines"});u.setPipeline(this.trace),u.setBindGroup(0,c),u.dispatchWorkgroups(Math.ceil(this.lines/64)),u.end()}encodeDraw(e,s,t,n,a){if(!this.lines)return;this.device.queue.writeBuffer(this.drawUni,0,new Float32Array([t.scale,t.ox,t.oy,s.w,s.h,.6*a,Ze,0,...n]));const i=this.device.createBindGroup({layout:this.draw.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.verts}},{binding:1,resource:{buffer:this.drawUni}}]});e.setPipeline(this.draw),e.setBindGroup(0,i),e.draw(6,this.lines*(Ze-1))}destroy(){this.verts.destroy(),this.traceUni.destroy(),this.drawUni.destroy()}}const $t={particles:0,vorticity:0,speed:1,pressure:2,schlieren:3,rheoscopic:1,none:1},Ut=4;class je{nx;ny;n;config;device;f;cur=0;paramsBuf;params=new ArrayBuffer(64);bodiesBuf;bodyData=new ArrayBuffer(K*64);sdfBuf;sdfKey="";sdfOffsets=[];forceBuf;staging=[];stepPipe;stepPipeKey="";stepBG=null;slotBGs=[];slotBuf;macroPipe;fieldPipe;stepModule;aux=null;auxDummy;mom=null;momDummy;children=[];macroBuf;scalarBuf;fieldUni;sampledBuf;sampledRead;sampledBusy=!1;sampleW;sampleH;bodies=[];physics={u:.05,tau:.6,smagorinsky:!1,smagCs:.1};groups;destroyed=!1;stepsDone=0;constructor(e,s){this.device=e,this.config={profile:0,absorbing:!s.patch,patch:!1,...s},this.nx=s.nx,this.ny=s.ny,this.n=s.nx*s.ny;const t=GPUBufferUsage,n=9*this.n*4;this.f=[e.createBuffer({size:n,usage:t.STORAGE|t.COPY_DST}),e.createBuffer({size:n,usage:t.STORAGE|t.COPY_DST})],this.paramsBuf=e.createBuffer({size:64,usage:t.UNIFORM|t.COPY_DST}),this.bodiesBuf=e.createBuffer({size:K*64,usage:t.STORAGE|t.COPY_DST}),this.sdfBuf=e.createBuffer({size:16,usage:t.STORAGE|t.COPY_DST}),this.forceBuf=e.createBuffer({size:At*4,usage:t.STORAGE|t.COPY_SRC|t.COPY_DST}),this.slotBuf=e.createBuffer({size:ve*256,usage:t.UNIFORM|t.COPY_DST}),this.auxDummy=[e.createBuffer({size:16,usage:t.STORAGE}),e.createBuffer({size:16,usage:t.STORAGE})],this.momDummy=[e.createBuffer({size:16,usage:t.STORAGE}),e.createBuffer({size:16,usage:t.STORAGE})];const a=new Uint32Array(ve*64);for(let l=0;l<ve;l++)a[l*64]=l;e.queue.writeBuffer(this.slotBuf,0,a),this.macroBuf=e.createBuffer({size:this.n*16,usage:t.STORAGE|t.COPY_SRC}),this.scalarBuf=e.createBuffer({size:this.n*4,usage:t.STORAGE}),this.fieldUni=e.createBuffer({size:48,usage:t.UNIFORM|t.COPY_DST}),this.sampleW=Math.ceil(this.nx/Ut),this.sampleH=Math.ceil(this.ny/Ut),this.sampledBuf=e.createBuffer({size:this.sampleW*this.sampleH*4,usage:t.STORAGE|t.COPY_SRC}),this.sampledRead=e.createBuffer({size:this.sampleW*this.sampleH*4,usage:t.MAP_READ|t.COPY_DST}),this.stepModule=e.createShaderModule({code:Dt(this.config.patch),label:this.config.patch?"tunnel patch step":"tunnel step"}),this.macroPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:As(),label:"tunnel macro"}),entryPoint:"main"}}),this.fieldPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:Ss(),label:"tunnel field"}),entryPoint:"main"}});const i=Math.ceil(this.n/O);this.groups=[Math.min(i,32768),Math.ceil(i/Math.min(i,32768))],this.writeBodies(),this.reset()}reset(e=this.physics.u){const s=new Float32Array(9*this.n),t=1.5*e*e;for(let n=0;n<9;n++){const a=3*[0,1,0,-1,0,1,-1,-1,1][n]*e;s.fill(Pe[n]*(a+.5*a*a-t),n*this.n,(n+1)*this.n)}this.device.queue.writeBuffer(this.f[0],0,s),this.device.queue.writeBuffer(this.f[1],0,s),this.resetAux(e),this.stepsDone=0}resetAux(e=this.physics.u){if(!this.aux)return;const s=new Float32Array(4*this.n),t=this.physics.nuMol??0,n=Math.max(t,this.physics.nuFloor??0);for(let a=0;a<this.n;a++)s[4*a]=e,s[4*a+2]=3*t,s[4*a+3]=n;this.device.queue.writeBuffer(this.aux[0],0,s),this.device.queue.writeBuffer(this.aux[1],0,s)}get refining(){return this.config.patch||this.children.length>0}setPatches(e){const s=this.refining;this.children=e,this.refining!==s&&this.setPhysics(this.physics,!0)}get patches(){return this.children}gen=0;swapCur(){this.cur^=1}get levelBuffers(){return{f:this.f,aux:this.aux??this.auxDummy,mom:this.mom??this.momDummy,cur:this.cur}}setPhysics(e,s=!1){this.physics=e;const t=e.turb??"off",n=t!=="off"||this.refining;if(this.refining&&!this.mom){const l=()=>this.device.createBuffer({size:16*this.n,usage:GPUBufferUsage.STORAGE});this.mom=[l(),l()],this.stepBG=null,this.gen++}else if(!this.refining&&this.mom){for(const l of this.mom)l.destroy();this.mom=null,this.stepBG=null,this.gen++}if(n&&!this.aux){const l=GPUBufferUsage;this.aux=[this.device.createBuffer({size:16*this.n,usage:l.STORAGE|l.COPY_DST|l.COPY_SRC}),this.device.createBuffer({size:16*this.n,usage:l.STORAGE|l.COPY_DST|l.COPY_SRC})],this.resetAux(),this.stepBG=null,this.gen++}else if(!n&&this.aux){for(const l of this.aux)l.destroy();this.aux=null,this.stepBG=null,this.gen++}const a=e.bulkKeep??0,i=`${this.config.walls}|${e.smagorinsky}|${t}|${a}|${this.config.patch}|${this.refining}`;(i!==this.stepPipeKey||s)&&(this.stepPipe=this.device.createComputePipeline({layout:"auto",compute:{module:this.stepModule,entryPoint:"step",constants:{WALLS:Pn[this.config.walls],SMAG:e.smagorinsky?1:0,TURB:An[t],KEEP_BULK:a,PATCH:this.config.patch?1:0,AUXW:this.refining?1:0,MOMW:this.refining?1:0}}}),this.stepPipeKey=i,this.stepBG=null,this.slotBGs=[],this.gen++)}writeParams(e){const s=new Uint32Array(this.params),t=new Float32Array(this.params),n=this.physics;s[0]=this.nx,s[1]=this.ny,s[2]=this.n,s[3]=this.bodies.length,t[4]=1/n.tau,t[5]=18*Math.SQRT2*n.smagCs*n.smagCs,t[6]=n.u,t[7]=this.config.absorbing||this.config.walls==="farfield"?.05:0,t[8]=this.config.absorbing?this.absorbInX:-1,t[9]=this.spongeX,s[10]=Math.max(1,e),s[11]=this.config.profile,t[12]=this.config.walls==="farfield"?Math.max(4,this.ny*.06):0,t[13]=n.nuMol??0,t[14]=n.nuFloor??0,t[15]=3*(n.nuMol??0),this.device.queue.writeBuffer(this.paramsBuf,0,this.params)}get absorbInX(){return this.config.absorbing?this.nx*.05:-1}get spongeX(){return this.config.patch?1e9:this.nx*.85}setBodies(e){if(e.length>K)throw new Error(`At most ${K} bodies are in the flow at once.`);this.bodies=e;const s=e.map(t=>t.key).join("|");if(s!==this.sdfKey){const t=Math.max(4,e.reduce((a,i)=>a+i.sdf.data.length,0));this.sdfBuf.size<t*4&&(this.sdfBuf.destroy(),this.sdfBuf=this.device.createBuffer({size:t*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.stepBG=null,this.renderBGDirty=!0),this.sdfOffsets=[];let n=0;for(const a of e)this.sdfOffsets.push(n),this.device.queue.writeBuffer(this.sdfBuf,n*4,a.sdf.data),n+=a.sdf.data.length;this.sdfKey=s}this.writeBodies()}renderBGDirty=!1;writeBodies(){const e=new Float32Array(this.bodyData),s=new Uint32Array(this.bodyData);this.bodies.forEach((t,n)=>{const a=n*16;e[a]=t.from.x,e[a+1]=t.from.y,e[a+2]=t.to.x,e[a+3]=t.to.y,e[a+4]=t.from.theta,e[a+5]=t.to.theta,e[a+6]=t.sdf.bound,e[a+7]=t.sdf.texel,e[a+8]=t.sdf.ox,e[a+9]=t.sdf.oy,s[a+10]=t.sdf.w,s[a+11]=t.sdf.h,s[a+12]=this.sdfOffsets[n]??0,e[a+13]=t.sdf.band}),this.device.queue.writeBuffer(this.bodiesBuf,0,this.bodyData)}get buffers(){return{params:this.paramsBuf,bodies:this.bodiesBuf,sdf:this.sdfBuf,scalar:this.scalarBuf}}bindGroups(){if(!this.stepBG){const e=this.stepPipe.getBindGroupLayout(0),s=this.aux??this.auxDummy,t=this.mom??this.momDummy,n=(a,i,l,o,c)=>this.device.createBindGroup({layout:e,entries:[{binding:0,resource:{buffer:a}},{binding:1,resource:{buffer:i}},{binding:2,resource:{buffer:this.paramsBuf}},{binding:3,resource:{buffer:this.bodiesBuf}},{binding:4,resource:{buffer:this.sdfBuf}},{binding:5,resource:{buffer:this.forceBuf}},{binding:6,resource:{buffer:l}},{binding:7,resource:{buffer:o}},{binding:8,resource:{buffer:c}}]});this.stepBG=[n(this.f[0],this.f[1],s[0],s[1],t[1]),n(this.f[1],this.f[0],s[1],s[0],t[0])]}if(!this.slotBGs.length){const e=this.stepPipe.getBindGroupLayout(1);for(let s=0;s<ve;s++)this.slotBGs.push(this.device.createBindGroup({layout:e,entries:[{binding:0,resource:{buffer:this.slotBuf,offset:s*256,size:16}}]}))}return this.stepBG}get maxFrameSteps(){return Math.floor(ve/this.depthFactor)}get depthFactor(){return this.children.reduce((e,s)=>Math.max(e,2*s.fine.depthFactor),1)}beginFrame(e,s){this.writeParams(Math.max(1,s)),this.writeBodies(),this.bindGroups(),s>0&&(e.clearBuffer(this.forceBuf,0,Math.min(At*4,s*K*8)),e.clearBuffer(this.forceBuf,ye*4,16));for(const t of this.children)t.fine.beginFrame(e,2*s)}get edgeLayout(){return this.stepPipe.getBindGroupLayout(2)}encodeStep(e,s,t){const n=this.bindGroups();if(e.setPipeline(this.stepPipe),e.setBindGroup(0,n[this.cur]),e.setBindGroup(1,this.slotBGs[s]),this.config.patch){if(!t)throw new Error("A patch steps with its edge group.");e.setBindGroup(2,t)}e.dispatchWorkgroups(this.groups[0],this.groups[1]),this.cur^=1,this.stepsDone++;for(const a of this.children)a.encodeCoupled(e,s)}encodeFrame(e,s,t){const n=Math.min(this.maxFrameSteps,Math.max(0,Math.floor(s)));this.beginFrame(e,n);let a=!1;if(n>0){const i=e.beginComputePass({label:"tunnel steps"});for(let l=0;l<n;l++)this.encodeStep(i,l);i.end(),a=n>0}return this.encodeField(e,t),{readForces:a}}encodeField(e,s){const t=new ArrayBuffer(48),n=new Uint32Array(t),a=new Float32Array(t);n[0]=this.nx,n[1]=this.ny,n[2]=s.mode,n[3]=Ut,a[4]=s.uRef,a[5]=s.lRef,a[8]=s.rhoRef??1,n[6]=this.sampleW,n[7]=this.sampleH,this.device.queue.writeBuffer(this.fieldUni,0,t);const i=this.device.createBindGroup({layout:this.macroPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.f[this.cur]}},{binding:1,resource:{buffer:this.macroBuf}},{binding:2,resource:{buffer:this.paramsBuf}},{binding:3,resource:{buffer:this.bodiesBuf}},{binding:4,resource:{buffer:this.sdfBuf}}]}),l=this.device.createBindGroup({layout:this.fieldPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.macroBuf}},{binding:1,resource:{buffer:this.scalarBuf}},{binding:2,resource:{buffer:this.fieldUni}},{binding:3,resource:{buffer:this.sampledBuf}}]}),o=e.beginComputePass({label:"tunnel field"});o.setPipeline(this.macroPipe),o.setBindGroup(0,i),o.dispatchWorkgroups(this.groups[0],this.groups[1]),o.setPipeline(this.fieldPipe),o.setBindGroup(0,l),o.dispatchWorkgroups(this.groups[0],this.groups[1]),o.end()}prepareRead(e,s){const t=Math.min(ve,s),n=t*K*8;let a=this.staging.pop();a||(a=this.device.createBuffer({size:At*4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})),e.copyBufferToBuffer(this.forceBuf,0,a,0,n),e.copyBufferToBuffer(this.forceBuf,ye*4,a,ye*4,16);const i=a;return async()=>{try{await i.mapAsync(GPUMapMode.READ)}catch{return null}const l=new Int32Array(i.getMappedRange().slice(0));i.unmap(),this.destroyed?i.destroy():this.staging.push(i);const o=this.bodies.map((u,h)=>{const d=new Float64Array(t*2);let f=0,y=0;for(let p=0;p<t;p++){const b=l[(p*K+h)*2]/yt,g=l[(p*K+h)*2+1]/yt;d[2*p]=b,d[2*p+1]=g,f+=b,y+=g}return{fx:f,fy:y,perStep:d}}),c=l[ye]>0?this.n-l[ye+1]:-1;return{steps:t,forces:o,bad:l[ye],limited:l[ye+2],badCell:c>=0?{x:c%this.nx,y:Math.floor(c/this.nx)}:null}}}async readSampled(){if(this.sampledBusy||this.destroyed)return null;this.sampledBusy=!0;try{const e=this.device.createCommandEncoder();e.copyBufferToBuffer(this.sampledBuf,0,this.sampledRead,0,this.sampledRead.size),this.device.queue.submit([e.finish()]),await this.sampledRead.mapAsync(GPUMapMode.READ);const s=new Float32Array(this.sampledRead.getMappedRange().slice(0));this.sampledRead.unmap();for(let t=0;t<s.length;t++)s[t]>1e29&&(s[t]=NaN);return s}catch{return null}finally{this.sampledBusy=!1}}async readFields(){const e=this.n*16,s=GPUBufferUsage,t=()=>this.device.createBuffer({size:e,usage:s.MAP_READ|s.COPY_DST}),n=t(),a=this.aux?t():null,i=this.device.createCommandEncoder();i.copyBufferToBuffer(this.macroBuf,0,n,0,e),a&&this.aux&&i.copyBufferToBuffer(this.aux[this.cur],0,a,0,e),this.device.queue.submit([i.finish()]);const l=async u=>{await u.mapAsync(GPUMapMode.READ);const h=new Float32Array(u.getMappedRange().slice(0));return u.unmap(),u.destroy(),h},[o,c]=await Promise.all([l(n),a?l(a):Promise.resolve(null)]);return{mac:o,aux:c}}destroy(){this.destroyed=!0;for(const e of[...this.aux??[],...this.auxDummy,...this.momDummy,...this.mom??[]])e.destroy();for(const e of this.children)e.destroy();for(const e of[...this.f,this.paramsBuf,this.bodiesBuf,this.sdfBuf,this.forceBuf,this.slotBuf,this.macroBuf,this.scalarBuf,this.fieldUni,this.sampledBuf,...this.staging])e.destroy();this.staging=[]}}const Ls=`
override KEEP_BULK: f32 = 0.0;
struct R {
  ox: u32, oy: u32, wc: u32, hc: u32,
  nxf: u32, nyf: u32, nxc: u32, nf: u32,
  nc: u32, sCount: u32, slotA: u32, slotB: u32,
  theta: f32, p0: f32, p1: f32, p2: f32,
};
${rt}
${Ps}
`;function Os(){return`${Ls}
@group(0) @binding(0) var<uniform> U: R;
@group(0) @binding(1) var<storage, read> momF: array<vec4f>;
@group(0) @binding(2) var<storage, read> auxF: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> coarseF: array<f32>;
@group(0) @binding(4) var<storage, read_write> coarseAux: array<vec4f>;

@compute @workgroup_size(${O})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let w = U.wc - 1u;
  let h = U.hc - 1u;
  if (gid.x >= w * h) { return; }
  let i = gid.x % w + 1u;
  let j = gid.x / w + 1u;
  let fc = 2u * i + 2u * j * U.nxf;
  let kc = (U.ox + i) + (U.oy + j) * U.nxc;
  let ac = auxF[fc];
  if (ac.w < 0.0) {
    // In a body: equilibrium at the wall's speed, as the coarse step keeps it.
    for (var k = 0u; k < 9u; k++) { coarseF[k * U.nc + kc] = postRR(k, 1.0, ac.xy, 0.0, 0.0, 0.0, 1.0); }
    coarseAux[kc] = vec4f(ac.xy, 0.0, -1.0);
    return;
  }
  // Π_neq through the binomial filter (1/4 here, 1/8 each side, 1/16 each corner), with a
  // body's cells left out (their weight goes to the centre).
  var p = vec3f(0.0);
  var wsum = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let wgt = select(select(0.0625, 0.125, dx == 0 || dy == 0), 0.25, dx == 0 && dy == 0);
      let kf = u32(i32(fc) + dx + dy * i32(U.nxf));
      if (auxF[kf].w < 0.0) { continue; }
      p += wgt * momF[kf].yzw;
      wsum += wgt;
    }
  }
  p /= wsum;
  let rho = momF[fc].x;
  let nuF = ac.w;
  let tauF = 3.0 * nuF + 0.5;
  let nuC = 0.5 * nuF;
  let tauC = 3.0 * nuC + 0.5;
  let pc = rescale(p, 2.0 * tauC / tauF, 2.0);
  for (var k = 0u; k < 9u; k++) { coarseF[k * U.nc + kc] = postRR(k, rho, ac.xy, pc.x, pc.y, pc.z, tauC); }
  coarseAux[kc] = vec4f(ac.xy, 0.5 * ac.z, nuC);
}
`}function Is(){return`${Ls}
struct O { ox: u32, oy: u32, nx: u32, ny: u32, valid: u32, n: u32, p0: u32, p1: u32 };
@group(0) @binding(0) var<uniform> U: R;
@group(0) @binding(1) var<uniform> Old: O;
@group(0) @binding(2) var<storage, read> parentF: array<f32>;
@group(0) @binding(3) var<storage, read> parentMom: array<vec4f>;
@group(0) @binding(4) var<storage, read> parentAux: array<vec4f>;
@group(0) @binding(5) var<storage, read> oldF: array<f32>;
@group(0) @binding(6) var<storage, read> oldAux: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> newF: array<f32>;
@group(0) @binding(8) var<storage, read_write> newAux: array<vec4f>;

@compute @workgroup_size(${O})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${O}u;
  if (idx >= U.nf) { return; }
  let a = idx % U.nxf;
  let b = idx / U.nxf;
  // The same spot in the old patch's cells (both grids are on the parent's half cells).
  let oa = i32(a) + 2 * (i32(U.ox) - i32(Old.ox));
  let ob = i32(b) + 2 * (i32(U.oy) - i32(Old.oy));
  if (Old.valid == 1u && oa >= 0 && ob >= 0 && oa < i32(Old.nx) && ob < i32(Old.ny)) {
    let k0 = u32(oa) + u32(ob) * Old.nx;
    for (var k = 0u; k < 9u; k++) { newF[k * U.nf + idx] = oldF[k * Old.n + k0]; }
    newAux[idx] = oldAux[k0];
    return;
  }
  let X = f32(U.ox) + 0.5 * f32(a);
  let Y = f32(U.oy) + 0.5 * f32(b);
  let i0 = u32(floor(X));
  let j0 = u32(floor(Y));
  let fx = X - floor(X);
  let fy = Y - floor(Y);
  var rho = 0.0;
  var u = vec2f(0.0);
  var pp = vec3f(0.0);
  var nu = 0.0;
  var nt = 0.0;
  var ws = 0.0;
  for (var q = 0u; q < 4u; q++) {
    let di = q & 1u;
    let dj = q >> 1u;
    let kc = (i0 + di) + (j0 + dj) * U.nxc;
    let ax = parentAux[kc];
    if (ax.w < 0.0) { continue; }
    let w = select(1.0 - fx, fx, di == 1u) * select(1.0 - fy, fy, dj == 1u);
    var dr = 0.0;
    var m = vec2f(0.0);
    for (var k = 0u; k < 9u; k++) {
      let g = parentF[k * U.nc + kc];
      dr += g;
      m += g * vec2f(CXF[k], CYF[k]);
    }
    let r = 1.0 + dr;
    let mo = parentMom[kc];
    rho += w * r;
    u += w * m / r;
    if (mo.x > 0.5) { pp += w * mo.yzw; }
    nu += w * ax.w;
    nt += w * ax.z;
    ws += w;
  }
  if (ws < 1e-6) {
    rho = 1.0;
    ws = 1.0;
  }
  rho /= ws;
  u /= ws;
  pp /= ws;
  nu /= ws;
  nt /= ws;
  let tauC = 3.0 * nu + 0.5;
  let nuF = 2.0 * nu;
  let tauF = 3.0 * nuF + 0.5;
  let pf = rescale(pp, tauF / (2.0 * tauC), 0.5);
  for (var k = 0u; k < 9u; k++) { newF[k * U.nf + idx] = postRR(k, rho, u, pf.x, pf.y, pf.z, tauF); }
  newAux[idx] = vec4f(u, 2.0 * max(nt, 0.0), nuF);
}
`}function Jn(){return[{label:"refine restrict",code:Os()},{label:"refine fill",code:Is()}]}class Vs{rect;fine;device;parent;uni;edgeUni;fillPipe;restrictPipe;bgCache=new Map;constructor(e,s,t,n,a){if(this.device=e,this.parent=s,this.fine=t,this.rect=n,t.nx!==2*n.wc+1||t.ny!==2*n.hc+1)throw new Error("A patch grid must be 2 x its parent cells + 1.");if(n.ox<2||n.oy<2||n.ox+n.wc>s.nx-3||n.oy+n.hc>s.ny-3)throw new Error("A patch must lie inside its parent grid, two cells in.");const i=(l,o)=>e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:l,label:o}),entryPoint:"main",constants:{KEEP_BULK:a}}});this.restrictPipe=i(Os(),"refine restrict"),this.fillPipe=i(Is(),"refine fill"),this.oldUni=e.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.uni=e.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.edgeUni=[0,1].map(()=>e.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})),this.writeUniforms()}writeUniforms(){const{rect:e,fine:s,parent:t}=this,n=new Uint32Array(16);n.set([e.ox,e.oy,e.wc,e.hc,s.nx,s.ny,t.nx,s.n,t.n]),this.device.queue.writeBuffer(this.uni,0,n),this.edgeUni.forEach((a,i)=>this.device.queue.writeBuffer(a,0,new Uint32Array([e.ox,e.oy,t.nx,i])))}encodeFill(e,s){const t=this.parent.levelBuffers,n=this.fine.levelBuffers,a=s?.solver===this.fine,i=s?s.solver.levelBuffers:null;this.device.queue.writeBuffer(this.oldUni,0,new Uint32Array(s?[s.rect.ox,s.rect.oy,s.solver.nx,s.solver.ny,1,s.solver.n,0,0]:[0,0,0,0,0,0,0,0]));const l=a?n.cur^1:n.cur,o=this.device.createBindGroup({layout:this.fillPipe.getBindGroupLayout(0),entries:[this.uni,this.oldUni,t.f[t.cur],t.mom[t.cur],t.aux[t.cur],i?i.f[i.cur]:n.f[n.cur^1],i?i.aux[i.cur]:n.aux[n.cur^1],n.f[l],n.aux[l]].map((h,d)=>({binding:d,resource:{buffer:h}}))}),c=e.beginComputePass({label:"refine fill"});c.setPipeline(this.fillPipe),c.setBindGroup(0,o);const u=Math.ceil(this.fine.n/O);c.dispatchWorkgroups(Math.min(u,32768),Math.ceil(u/Math.min(u,32768))),c.end(),a&&this.fine.swapCur(),this.needPrime=!0}oldUni;shiftOrigin(e,s){this.rect.ox+=e,this.rect.oy+=s,this.writeUniforms(),this.invalidate(),this.needPrime=!0}encodeMoveTo(e,s,t){const n={...this.rect};this.rect.ox=s,this.rect.oy=t,this.writeUniforms(),this.invalidate(),this.encodeFill(e,{solver:this.fine,rect:n})}bg(e,s,t){const n=`${e}|${this.parent.gen}|${this.fine.gen}`;let a=this.bgCache.get(n);return a||(a=this.device.createBindGroup({layout:s,entries:t.map((i,l)=>({binding:l,resource:{buffer:i}}))}),this.bgCache.set(n,a)),a}invalidate(){this.bgCache.clear()}needPrime=!0;prime(){this.needPrime=!0}encodeCoupled(e,s){const t=this.parent.levelBuffers,n=this.needPrime?1:0,a=this.bg(`edge${t.cur}|${n}`,this.fine.edgeLayout,[this.edgeUni[n],t.mom[t.cur^1],t.mom[t.cur],t.aux[t.cur^1],t.aux[t.cur]]);this.fine.encodeStep(e,2*s,a),this.fine.encodeStep(e,2*s+1,a);const i=this.fine.levelBuffers;e.setPipeline(this.restrictPipe),e.setBindGroup(0,this.bg(`res|${i.cur}|${t.cur}`,this.restrictPipe.getBindGroupLayout(0),[this.uni,i.mom[i.cur],i.aux[i.cur],t.f[t.cur],t.aux[t.cur]])),e.dispatchWorkgroups(Math.ceil((this.rect.wc-1)*(this.rect.hc-1)/O)),this.needPrime=!1}destroy(){this.fine.destroy(),this.oldUni.destroy(),this.uni.destroy();for(const e of this.edgeUni)e.destroy()}}class Ws{levels=[];sdfs=new Map;constructor(e,s,t,n,a=!0){let i=s;for(const l of t){const o=new je(e,{nx:2*l.wc+1,ny:2*l.hc+1,walls:"slip",patch:!0}),c=new Vs(e,i,o,{...l},n.bulkKeep??0);(i!==s||a)&&i.setPatches([c]),this.levels.push(c),i=o}this.setPhysics(n);for(const l of this.levels)l.fine.reset(n.u)}encodeFill(e,s){this.levels.forEach((t,n)=>{const a=s?.levels[n];if(!a){t.encodeFill(e,null);return}let i={...a.rect};if(n>0){const l=s.levels[n-1].rect,o=this.levels[n-1].rect;i={...i,ox:i.ox+2*(l.ox-o.ox),oy:i.oy+2*(l.oy-o.oy)}}t.encodeFill(e,{solver:a.fine,rect:i})})}get finestBox(){let e=0,s=0,t=1,n=0,a=0;for(const i of this.levels)e+=i.rect.ox/t,s+=i.rect.oy/t,n=i.rect.wc/t,a=i.rect.hc/t,t*=2;return{x0:e,y0:s,x1:e+n,y1:s+a,scale:t}}get finest(){return this.levels[this.levels.length-1].fine}get scale(){return 2**this.levels.length}setPhysics(e){this.levels.forEach((s,t)=>{const n=2**(t+1),a=(e.nuMol??0)*n;s.fine.setPhysics({...e,nuMol:a,tau:3*Math.max(a,e.nuFloor??0)+.5})})}poseAt(e,s){let t=s.x,n=s.y;for(let a=0;a<=e;a++)t=2*(t-this.levels[a].rect.ox),n=2*(n-this.levels[a].rect.oy);return{x:t,y:n,theta:s.theta}}setBodies(e){this.levels.forEach((s,t)=>{const n=2**(t+1);s.fine.setBodies(e.map(a=>{const i=`${a.key}@L${t+1}`;let l=this.sdfs.get(i);return l||(l=it(ze(a.local,{x:0,y:0,theta:0},n),a.band),this.sdfs.set(i,l)),{key:i,sdf:l,from:this.poseAt(t,a.from),to:this.poseAt(t,a.to)}}))})}prepareRead(e,s){const t=this.scale,n=this.finest.prepareRead(e,t*s);return async()=>{const a=await n();if(!a)return null;const i=t*t,l=a.forces.map(o=>{const c=new Float64Array(s*2);let u=0,h=0;for(let d=0;d<s;d++){let f=0,y=0;for(let p=0;p<t;p++)f+=o.perStep[2*(d*t+p)],y+=o.perStep[2*(d*t+p)+1];c[2*d]=f/i,c[2*d+1]=y/i,u+=f/i,h+=y/i}return{fx:u,fy:h,perStep:c}});return{...a,steps:s,forces:l}}}destroy(){for(const e of this.levels)e.destroy()}}function ei(r,e,s,t){let n=1/0,a=1/0,i=-1/0,l=-1/0;for(let d=0;d<r.length;d+=2)n=Math.min(n,r[d]),i=Math.max(i,r[d]),a=Math.min(a,r[d+1]),l=Math.max(l,r[d+1]);const o=Math.max(t.x0,Math.floor(n-s.ahead*e)),c=Math.max(t.y0,Math.floor(a-s.side*e)),u=Math.min(t.x1,Math.ceil(i+s.behind*e)),h=Math.min(t.y1,Math.ceil(l+s.side*e));return{ox:o,oy:c,wc:Math.max(4,u-o),hc:Math.max(4,h-c)}}const ti=[{ahead:.25,side:.25,behind:.6},{ahead:.06,side:.08,behind:.15}],at=1.15,ot=8,si=(r,e)=>r.x0<=e.x1&&e.x0<=r.x1&&r.y0<=e.y1&&e.y0<=r.y1,Je=(r,e)=>({x0:Math.min(r.x0,e.x0),y0:Math.min(r.y0,e.y0),x1:Math.max(r.x1,e.x1),y1:Math.max(r.y1,e.y1)}),ls=(r,e)=>r.x0>=e.ox&&r.y0>=e.oy&&r.x1<=e.ox+e.wc&&r.y1<=e.oy+e.hc;class ni{device;coarse;groups=[];levels=0;physics=null;constructor(e,s){this.device=e,this.coarse=s}get depth(){return this.levels}get refinedIds(){return new Set(this.groups.flatMap(e=>e.ids))}get scale(){return 2**this.levels}clear(){for(const e of this.groups)e.ref.destroy();this.groups=[],this.coarse.setPatches([])}setPhysics(e){this.physics=e;for(const s of this.groups)s.ref.setPhysics(e)}box(e,s,t=1,n={x:0,y:0}){const a=ze(e.local,e.to),i=vs(a),l=Math.max(i.x1-i.x0,i.y1-i.y0)*t,o=ti[s],c=h=>t*(h-n.x),u=h=>t*(h-n.y);return{x0:c(i.x0)-o.ahead*l,y0:u(i.y0)-o.side*l,x1:c(i.x1)+o.behind*l,y1:u(i.y1)+o.side*l}}rectFor(e,s){const t=Math.ceil((e.x1-e.x0)*at/ot)*ot,n=Math.ceil((e.y1-e.y0)*at/ot)*ot;let a=Math.floor((e.x0+e.x1)/2-t/2),i=Math.floor((e.y0+e.y1)/2-n/2);return t>s.x1-s.x0||n>s.y1-s.y0?null:(a=Math.max(s.x0,Math.min(s.x1-t,a)),i=Math.max(s.y0,Math.min(s.y1-n,i)),{ox:a,oy:i,wc:t,hc:n})}update(e,s,t,n){if(!this.physics)return;if(t!==this.levels&&(this.clear(),this.levels=t),t===0||!s.length){this.groups.length&&this.clear();return}const a=s.map(u=>this.box(u,0)),i=s.map((u,h)=>[h]);for(let u=!0;u;){u=!1;e:for(let h=0;h<i.length;h++)for(let d=h+1;d<i.length;d++){const f=i[h].map(p=>a[p]).reduce(Je),y=i[d].map(p=>a[p]).reduce(Je);if(si(f,y)){i[h].push(...i[d]),i.splice(d,1),u=!0;break e}}}const l=[],o=new Set,c=u=>({x0:4,y0:4,x1:2*u.wc-4,y1:2*u.hc-4});for(const u of i){const h=u.map(b=>s[b]),d=h.map(b=>b.id).sort(),f=u.map(b=>a[b]).reduce(Je),y=this.groups.find(b=>!o.has(b)&&b.ids.join("|")===d.join("|"));let p=null;if(y&&(o.add(y),p=this.keep(e,y,h,f,n,c)),!p){const b=this.rectFor(f,n);if(!b)continue;const g=[b];if(t>1){const x=h.map(M=>this.box(M,1,2,{x:b.ox,y:b.oy})).reduce(Je),v=this.rectFor(x,c(b));v&&g.push(v)}const S=new Ws(this.device,this.coarse,g,this.physics,!1),P=this.groups.find(x=>!o.has(x)&&x.ids.some(v=>d.includes(v)));S.encodeFill(e,P?.ref??null),p={ids:d,order:[],ref:S}}p.order=h.map(b=>b.id),p.ref.setBodies(h.map(b=>({key:b.key,local:b.local,band:b.band,from:b.from,to:b.to}))),l.push(p)}for(const u of this.groups)l.includes(u)||u.ref.destroy();this.groups=l,this.coarse.setPatches(l.map(u=>u.ref.levels[0]))}keep(e,s,t,n,a,i){const l=s.ref.levels[0];if(((u,h)=>(u.x1-u.x0)*(u.y1-u.y0)*at*at<.5*h.wc*h.hc)(n,l.rect))return null;if(!ls(n,l.rect)){const u=this.rectFor(n,a);if(!u||u.wc!==l.rect.wc||u.hc!==l.rect.hc)return null;const h=u.ox-l.rect.ox,d=u.oy-l.rect.oy;l.encodeMoveTo(e,u.ox,u.oy),s.ref.levels[1]?.shiftOrigin(-2*h,-2*d)}const c=s.ref.levels[1];if(c){const u=l.rect,h=t.map(d=>this.box(d,1,2,{x:u.ox,y:u.oy})).reduce(Je);if(!ls(h,c.rect)||c.rect.ox<2||c.rect.oy<2||c.rect.ox+c.rect.wc>2*u.wc-2||c.rect.oy+c.rect.hc>2*u.hc-2){const d=this.rectFor(h,i(u));if(!d||d.wc!==c.rect.wc||d.hc!==c.rect.hc)return null;c.encodeMoveTo(e,d.ox,d.oy)}}return s}prepareRead(e,s){const t=this.groups.map(n=>({g:n,read:n.ref.prepareRead(e,s)}));return async()=>{const n=new Map;let a=0,i=0;for(const{g:l,read:o}of t){const c=await o();if(!c)return null;a+=c.bad,i+=c.limited,l.order.forEach((u,h)=>n.set(u,c.forces[h]))}return{byId:n,bad:a,limited:i}}}encodeDisplay(e,s){const t=this.groups[0];if(!t)return null;const n=t.ref.finestBox,a=t.ref.finest;return a.encodeField(e,{...s,lRef:s.lRef*n.scale}),{scalar:a.buffers.scalar,scale:n.scale,nx:a.nx,ny:a.ny,x0:n.x0,y0:n.y0,x1:n.x1,y1:n.y1}}info(){return this.groups.map(e=>({ids:e.order,levels:e.ref.levels.map(s=>({...s.rect,nx:s.fine.nx,ny:s.fine.ny}))}))}destroy(){this.clear()}}const st=.05,Kt=50,zt=.005,nt=.1,cs=1/3;function ii(r,e,s,t){const n=r/e;let a=st;const i=h=>t*h/(s*n);i(a)>cs&&(a=cs*s*n/t);const l=i(a),o=a/Kt,c=Math.max(l,o),u=a*n/s;return{dx:n,dt:u,u:a,nu:c,nuFluid:l,nuFloor:o,tau:3*c+.5,capped:l<o,smagorinsky:c<zt}}function ri(r,e,s,t){return{real:s*e/t,sim:r.u*(e/r.dx)/r.nu}}const De={low:512*256,medium:1024*512,high:1536*768,ultra:2048*1024},lt=.03;function Tt(r,e,s,t){const n=e+s*r,a=Math.exp(-s*t);return[(r+n*t)*a,(n-s*(r+n*t))*a]}const ai=.1,oi=12,li={particles:"inferno",vorticity:"balance",speed:"viridis",pressure:"balance",schlieren:"viridis",rheoscopic:"viridis",none:"viridis"},ci=.3,ui=1.5,di={low:1/110,normal:1/40,high:1/16},hi=3e3,fi=4e4,pi={off:0,short:11,long:22},mi=34,yi=14;function js(r){return r.field==="particles"?r.particleColor==="vorticity"?"balance":"inferno":li[r.field]}function Lt(r,e){const{length:s,height:t}=r.tunnel;let n=Math.round(Math.sqrt(e*s/t)),a=Math.round(e/n);return n=Math.max(32,Math.min(8192,n)),a=Math.max(16,Math.min(8192,a)),{nx:n,ny:a}}const us=new Map;class xi{device;adapterName;canvas;renderer;solver=null;scene=null;map=null;bodies=new Map;order=[];targets=new Map;raf=0;stepsTarget=64;gpuMs=0;lastFrame=0;fpsEma=0;readPending=!1;sampledAt=0;listeners=new Set;range={lo:-10,hi:10};autoRange={lo:-10,hi:10,ready:!1};gridKey="";rangeField=null;rangeKey="";rhoRef=1;physKey="";turb="off";refine=null;physics=null;paused=!1;unstable=!1;palette;worldView={cx:4,cy:2,mpp:.01,w:800,h:400,dpr:1};simTime=0;stats;particles;dye=null;rheo=null;rheoLooks={};streamlines;rakeGpu=[];dyeChannels=new Map;frameNo=0;markerColors=null;recordForces=!1;onUnstable=null;unstableAt=null;constructor(e,s,t,n){this.device=e,this.adapterName=t,this.palette=n,this.canvas=s,this.renderer=new Un(e,s),this.particles=new Yn(e),this.streamlines=new Zn(e,this.renderer.format),this.stats={adapter:t,nx:0,ny:0,stepsPerFrame:0,mlups:0,speedRatio:0,simTime:0,fps:0,map:null,state:"running"}}subscribe(e){return this.listeners.add(e),()=>{this.listeners.delete(e)}}emit(){for(const e of this.listeners)e()}get solverReady(){return!!this.solver}get lattice(){return this.map}get grid(){return this.solver?{nx:this.solver.nx,ny:this.solver.ny}:null}benchmark(){return this.benchmarkAt(1024,512)}get refineUnavailable(){const e=this.device.limits.maxStorageBuffersPerShaderStage;return e<ns?`This GPU lets a shader use ${e} storage buffers; refinement needs ${ns}.`:""}refineLevels(e){return this.refineUnavailable?0:e.tunnel.refine}cellsAcross(e){if(!this.map)return null;const s=this.refine?.refinedIds.has(e.id)?this.refine.scale:1;return Ue(e.shape)/this.map.dx*s}refineInfo(){return this.refine?.info()??[]}get flowModel(){return this.turb}async benchmarkAt(e,s,t="off"){const n=`${e}x${s}|${t}`,a=us.get(n);if(a!==void 0)return a;const i=new je(this.device,{nx:e,ny:s,walls:"slip"});t==="sa"?i.setPhysics({u:st,tau:.51,smagorinsky:!1,smagCs:nt,turb:"sa",nuMol:1e-6,nuFloor:st/Kt}):i.setPhysics({u:st,tau:.51,smagorinsky:!0,smagCs:nt});const l=async d=>{const f=this.device.createCommandEncoder();i.encodeFrame(f,d,{mode:0,uRef:.05,lRef:50}),this.device.queue.submit([f.finish()]),await this.device.queue.onSubmittedWorkDone()};await l(30);const o=Math.max(40,Math.min(400,Math.round(2e8/(e*s)))),c=performance.now();await l(o);const u=Math.max(.1,performance.now()-c);i.destroy();const h=e*s*o/(u/1e3)/1e6;return us.set(n,h),h}async cellsFor(e,s){if(e!=="auto")return De[e];const t=rs(s),n=async a=>{const{nx:i,ny:l}=Lt(s,De[a]),o=8*i*i*l*1.25/1e6;return await this.benchmarkAt(i,l,t)>=o};return await n("medium")?await n("high")?await n("ultra")?De.ultra:De.high:De.medium:De.low}async setScene(e){this.scene=e;const s=await this.cellsFor(e.tunnel.resolution,e);if(this.scene!==e)return;const{nx:t,ny:n}=Lt(e,s),a=`${t}x${n}|${e.tunnel.walls}|${e.tunnel.length}`;a!==this.gridKey&&(this.refine?.clear(),this.solver?.destroy(),this.solver=new je(this.device,{nx:t,ny:n,walls:e.tunnel.walls}),this.refine=new ni(this.device,this.solver),this.particles.clear(),this.dye?.destroy(),this.dye=null,this.rheo?.destroy(),this.rheo=null,this.gridKey=a,this.bodies.clear(),this.physKey="",this.simTime=0,this.unstable=!1,this.autoRange.ready=!1,this.rhoRef=1);const i=tt[e.flow.fluid];this.map=ii(e.tunnel.length,t,e.flow.speed,i.nu),this.turb=rs(e);const l=this.turb==="sa",o=`${this.map.u}|${this.map.tau}|${this.map.smagorinsky}|${this.turb}|${this.map.nuFluid}`;o!==this.physKey&&(this.physics={u:this.map.u,tau:this.map.tau,smagorinsky:this.map.smagorinsky&&!l,smagCs:nt,turb:this.turb,nuMol:this.map.nuFluid,nuFloor:this.map.nuFloor},this.solver.setPhysics(this.physics),this.refine.setPhysics(this.physics),this.physKey||this.solver.reset(this.map.u),this.physKey=o),this.syncBodies(e),await this.syncMarkers(e),this.emit()}async syncMarkers(e){const s=this.solver,t=this.map.dx,n=await this.benchmark();let i=e.view.tracers||e.view.field==="particles"?Math.round(s.n*di[e.view.density]):0;n<hi&&(i=Math.min(i,fi));const l=u=>u/t-.5,o=e.rakes.filter(u=>u.enabled);this.rakeGpu=o.filter(u=>u.kind!=="dye").map(u=>({id:u.id,kind:u.kind,x0:l(u.x0),y0:l(u.y0),x1:l(u.x1),y1:l(u.y1),emitters:u.emitters,color:u.color})),this.particles.configure(i,this.rakeGpu,{nx:s.nx,ny:s.ny,absorbInX:Math.max(0,s.absorbInX),outX:s.spongeX});const c=o.filter(u=>u.kind==="dye").slice(0,L.maxDyeRakes);if(this.dyeChannels=new Map(c.map((u,h)=>[u.id,h])),c.length){this.dye||(this.dye=new In(this.device,s.nx,s.ny),this.dye.clear());const u=[];c.forEach((h,d)=>{for(let f=0;f<h.emitters;f++){const y=h.emitters===1?.5:f/(h.emitters-1);u.push({x:l(h.x0+(h.x1-h.x0)*y),y:l(h.y0+(h.y1-h.y0)*y),channel:d})}}),this.dye.setSources(u)}else this.dye&&(this.dye.destroy(),this.dye=null)}get dyeChannelOf(){return this.dyeChannels}async readParticles(){const e=await this.particles.read();return e?{...e,tracers:this.particles.tracerCount,pools:this.particles.pools,dx:this.map?.dx??0}:null}async readDye(){return this.dye?{data:await this.dye.read(),nx:this.dye.nx,ny:this.dye.ny,channels:Object.fromEntries(this.dyeChannels),dx:this.map?.dx??0}:null}async readRheo(){if(!this.rheo)return null;const e=await this.rheo.read(),s=this.rheo.nx*this.rheo.ny;let t=0,n=0,a=0,i=0,l=1/0,o=-1/0;for(let u=0;u<s;u++){const h=e.slice(8*u,8*u+6);if(!h.every(Number.isFinite)){a++;continue}t+=h[2],n+=Math.abs(h[3]),i+=h[0]+h[1]+h[2],l=Math.min(l,h[2]),o=Math.max(o,h[2])}const c=Math.max(1,s-a);return{meanZZ:t/c,meanAbsXY:n/c,meanTrace:i/c,minZZ:l,maxZZ:o,nan:a,nx:this.rheo.nx,ny:this.rheo.ny,data:null}}get streamlineCount(){return this.scene?.view.streamlines?this.streamlines.count:0}syncBodies(e){const s=this.map.dx,t=e.bodies.filter(a=>a.enabled).slice(0,K),n=new Set(t.map(a=>a.id));for(const a of[...this.bodies.keys()])n.has(a)||this.bodies.delete(a);for(const a of t){const i=this.turb==="sa"?Ms:void 0,l=2**this.refineLevels(e),o=`${JSON.stringify(a.shape)}@${s}|${i??""}|${l}`,c=this.bodies.get(a.id),u=this.targetPose(a);if(!c||c.key!==o){const h=ze(We(a.shape,jt*s/l),{x:0,y:0,theta:0},1/s),d=it(h,i);this.bodies.set(a.id,{body:a,key:o,sdf:d,local:h,rCells:_t(h),pose:c?.pose??u,spinAngle:c?.spinAngle??0,vel:c?.vel??{x:0,y:0,theta:0},fxEma:0,fyEma:0,history:[]})}else c.body=a}this.order=t.map(a=>a.id)}targetPose(e){const s=this.map.dx,t=this.targets.get(e.id),n=t?.x??e.x,a=t?.y??e.y,i=t?.angle??e.angle,l=this.bodies.get(e.id)?.spinAngle??0;return{x:n/s-.5,y:a/s-.5,theta:-i*Math.PI/180+l}}setTarget(e,s){s?this.targets.set(e,s):this.targets.delete(e)}livePose(e){const s=this.bodies.get(e);if(!s||!this.map)return null;const t=this.map.dx;return{x:(s.pose.x+.5)*t,y:(s.pose.y+.5)*t,angle:-(s.pose.theta-s.spinAngle)*180/Math.PI}}bodyLive(e){const s=this.bodies.get(e),t=this.livePose(e);if(!s||!t||!this.map||!this.scene)return null;const n=tt[this.scene.flow.fluid],a=this.map.u,i=.5*a*a*(Ue(s.body.shape)/this.map.dx),l=o=>o/i*.5*n.rho*this.scene.flow.speed**2*Ue(s.body.shape);return{...t,fx:l(s.fxEma),fy:l(s.fyEma),cd:s.fxEma/i,cl:s.fyEma/i}}spinCap(e){const s=this.bodies.get(e);return!s||!this.map?null:ai/Math.max(1,s.rCells)/this.map.dt}forceHistory(e){return this.bodies.get(e)?.history??[]}reynoldsFor(e){if(!this.map||!this.scene)return null;const s=ri(this.map,Ue(e.shape),this.scene.flow.speed,tt[this.scene.flow.fluid].nu);if(this.turb==="sa")return{real:s.real,sim:s.real};const t=this.refine?.refinedIds.has(e.id)?this.refine.scale:1;return{real:s.real,sim:Math.min(s.real,s.sim*t)}}resetFlow(){if(!(!this.solver||!this.map)){this.solver.reset(this.map.u),this.refine?.clear(),this.simTime=0,this.rhoRef=1,this.particles.clear(),this.dye?.clear(),this.rheo?.reset(),this.scene&&this.syncMarkers(this.scene),this.unstable=!1;for(const e of this.bodies.values())e.fxEma=0,e.fyEma=0,e.history=[];this.emit()}}setColormap(e){this.renderer.setColormap(e)}bodyLook=null;get autoRangeNow(){return this.autoRange.ready?{lo:this.autoRange.lo,hi:this.autoRange.hi}:null}setRange(e,s){this.range={lo:e,hi:s}}start(){if(this.raf)return;const e=s=>{this.raf=requestAnimationFrame(e),this.frame(s)};this.raf=requestAnimationFrame(e)}stop(){cancelAnimationFrame(this.raf),this.raf=0}lRefCells(){const e=this.order.length?this.bodies.get(this.order[0]):null;return e&&this.map?Ue(e.body.shape)/this.map.dx:this.solver?this.solver.ny/8:50}frame(e){const s=this.solver,t=this.scene,n=this.map;if(!s||!t||!n)return;const a=this.lastFrame?Math.min(100,e-this.lastFrame):16;this.lastFrame=e,this.fpsEma=this.fpsEma?this.fpsEma*.9+1e3/Math.max(1,a)*.1:60;let i=this.paused||this.unstable?0:Math.round(this.stepsTarget);i>0&&t.view.speed==="realtime"&&(i=Math.max(1,Math.min(i,Math.round(a/1e3/n.dt)))),i=Math.min(ve>>this.refineLevels(t),i);const l=[];for(const B of this.order){const C=this.bodies.get(B);if(i>0&&C.body.spin){const D=this.spinCap(C.body.id)??1/0;C.spinAngle+=Math.sign(C.body.spin)*Math.min(Math.abs(C.body.spin),D)*n.dt*i}const U=this.targetPose(C.body),A={...C.pose};if(i===0)C.pose=U,C.vel={x:0,y:0,theta:0};else{const D=1/Math.max(300,4*C.rCells/.577),j=Math.max(1,C.rCells),[W,I]=Tt(A.x-U.x,C.vel.x,D,i),[q,H]=Tt(A.y-U.y,C.vel.y,D,i),[he,Fe]=Tt(A.theta-U.theta,C.vel.theta,D,i);let Re=U.x+W-A.x,ee=U.y+q-A.y,Ce=U.theta+he-A.theta;const Ee=Math.hypot(Re,ee);Ee>lt*i&&(Re*=lt*i/Ee,ee*=lt*i/Ee);const re=lt*i/j;Math.abs(Ce)>re&&(Ce=Math.sign(Ce)*re);const Ye=Math.hypot(Re,ee)<Ee-1e-9;C.vel={x:Ye?Re/i:I,y:Ye?ee/i:H,theta:Math.abs(Ce)>=re?Ce/i:Fe},C.pose={x:A.x+Re,y:A.y+ee,theta:A.theta+Ce}}l.push({key:`${B}:${C.key}`,sdf:C.sdf,from:i===0?C.pose:A,to:C.pose})}s.setBodies(l);const o=this.device.createCommandEncoder();if(this.refine){const B=t.tunnel.walls==="farfield"?Math.max(4,s.ny*.06):0,C={x0:Math.ceil(Math.max(0,s.absorbInX))+4,y0:Math.ceil(B)+4,x1:Math.floor(s.spongeX)-4,y1:Math.floor(s.ny-B)-5};this.refine.update(o,this.order.map((U,A)=>{const D=this.bodies.get(U);return{id:U,key:l[A].key,local:D.local,band:D.sdf.band,from:l[A].from,to:l[A].to,r:D.rCells}}),i>0?this.refineLevels(t):this.refine.depth,C)}const c=t.view.field==="particles",u=c?t.view.particleColor==="vorticity"?$t.vorticity:$t.speed:$t[t.view.field],h=c?`particles:${t.view.particleColor}`:t.view.field;h!==this.rangeKey&&(this.rangeKey=h,this.rangeField=c?t.view.particleColor==="vorticity"?"vorticity":"speed":t.view.field,this.autoRange={lo:0,hi:1,ready:!1});const d={mode:u,uRef:n.u,lRef:this.lRefCells(),rhoRef:this.rhoRef},{readForces:f}=s.encodeFrame(o,i,d),y=this.refine?.encodeDisplay(o,d)??null,p=t.view.autoRange&&this.autoRange.ready?this.autoRange:this.range;this.renderer.setColormap(js(t.view));const b=this.latticeView(n.dx),g=t.view,S=g.field==="none",P=S||g.field==="rheoscopic"||c,x=this.markerColors,v={steps:i,u:n.u,nx:s.nx,ny:s.ny,absorbInX:Math.max(0,s.absorbInX),outX:s.spongeX,wrapY:t.tunnel.walls==="periodic"};this.particles.encodeAdvect(o,v,s.macroBuf,s.buffers),this.dye?.encode(o,i,s.macroBuf);const M=g.field==="rheoscopic";if(M&&!this.rheo&&(this.rheo=new Qn(this.device,s.nx,s.ny)),!M&&this.rheo&&(this.rheo.destroy(),this.rheo=null),this.rheo?.encode(o,i,s.macroBuf,{depthCells:s.ny*ci,relaxSteps:ui*s.nx/n.u,inletX:Math.max(1,s.absorbInX)}),this.frameNo++,g.streamlines&&(i>0||this.frameNo%10===0)){const B=t.tunnel.height/this.worldView.mpp/yi;this.streamlines.encodeTrace(o,s.macroBuf,s,Math.max(0,s.absorbInX)+1,Math.max(8,B))}const $=this.renderer.size,k=(g.tracers||g.field==="particles")&&this.particles.tracerCount>0;if(k&&x){const B=this.worldView.dpr,C=c?{scalar:s.buffers.scalar,lut:this.renderer.lut,nx:s.nx,ny:s.ny,lo:p.lo,hi:p.hi,lift:.36}:null,U=c?[1,1,1,.66]:P?x.tracerLight:[...x.tracerDark.slice(0,3),.3];this.particles.encodeDraw(o,{...$,dot:(c?.95:.6)*B,tail:i>0?pi[g.trail]*B:0,taper:!0},b,0,{tracers:!0},{tracer:U},C,this.renderer.dummies)}const R=[...this.dyeChannels.entries()].sort((B,C)=>B[1]-C[1]).map(([B])=>{const C=t.rakes.find(A=>A.id===B),U=x?.rakesOnDark[C?.color??0]??[0,0,0,1];return[U[0],U[1],U[2],.95]});this.renderer.encode(o,s,b,p,(c||g.field==="rheoscopic")&&this.bodyLook?{...this.palette,...this.bodyLook}:this.palette,{plain:S,arrows:g.arrows,arrowCells:mi*this.worldView.mpp/n.dx,uRef:n.u,dye:this.dye?this.dye.field:null,dyeColors:R,trail:k&&x?this.particles.trail:null,rheo:this.rheo&&this.rheoLooks[g.rheoPreset]?{field:this.rheo.field,look:this.rheoLooks[g.rheoPreset],sparkle:this.rheo.sparkleWeights}:null,patch:y},x?B=>{g.streamlines&&this.streamlines.encodeDraw(B,$,b,P?x.streamlineLight:x.streamline,this.worldView.dpr),this.rakeGpu.length&&this.particles.encodeRakeLines(B,this.renderer.format,$,b,P?x.rakesOnDark:x.rakes,this.worldView.dpr)}:void 0);const T=f&&!this.readPending?s.prepareRead(o,i):null,w=T&&this.refine?.depth?this.refine.prepareRead(o,i):null,E=performance.now();this.device.queue.submit([o.finish()]),this.simTime+=i*n.dt,i>0&&this.device.queue.onSubmittedWorkDone().then(()=>{const B=performance.now()-E;this.gpuMs=this.gpuMs?this.gpuMs*.8+B*.2:B;const C=this.gpuMs/i,U=oi/Math.max(1e-4,C);this.stepsTarget=Math.max(1,Math.min(ve,this.stepsTarget*.7+U*.3))}),T&&(this.readPending=!0,T().then(B=>{this.readPending=!1,B&&(w?w().then(C=>{C&&(B.forces=B.forces.map((U,A)=>C.byId.get(this.order[A])??U),B.bad+=C.bad,B.limited+=C.limited),this.takeForces(B)}):this.takeForces(B))})),t.view.autoRange&&e-this.sampledAt>400&&(this.sampledAt=e,s.readSampled().then(B=>B&&this.rangeField&&this.takeSample(B,this.rangeField))),this.stats={adapter:this.adapterName,nx:s.nx,ny:s.ny,stepsPerFrame:i,mlups:i>0&&this.gpuMs>0?s.n*i/(this.gpuMs/1e3)/1e6:this.stats.mlups,speedRatio:i*n.dt/Math.max(.001,a/1e3),simTime:this.simTime,fps:this.fpsEma,map:n,state:this.unstable?"unstable":this.paused?"paused":"running"}}limitedAt=0;limitedTotal=0;takeForces(e){if(e.limited>0&&(this.limitedAt=performance.now(),this.limitedTotal+=e.limited),e.bad>0&&!this.unstable){this.unstable=!0,this.unstableAt=e.badCell&&this.map?{x:(e.badCell.x+.5)*this.map.dx,y:(e.badCell.y+.5)*this.map.dx,poses:this.order.map(s=>({id:s,...this.livePose(s)}))}:null,this.onUnstable?.(),this.emit();return}e.forces.forEach((s,t)=>{const n=this.bodies.get(this.order[t]);if(!n||e.steps===0)return;const a=s.fx/e.steps,i=s.fy/e.steps,l=Math.min(1,e.steps/400);if(n.fxEma=n.fxEma?n.fxEma*(1-l)+a*l:a,n.fyEma=n.fyEma?n.fyEma*(1-l)+i*l:i,this.recordForces)for(let o=0;o<e.steps;o++)n.history.push(s.perStep[2*o],s.perStep[2*o+1])})}takeSample(e,s){if(s!==this.rangeField)return;if(s==="pressure"&&this.solver&&this.map){const o=this.solver.sampleW,c=Math.min(o-1,Math.ceil((this.solver.absorbInX+this.solver.nx*.03)/4)),u=[];for(let h=0;h<this.solver.sampleH;h++){const d=e[h*o+c];Number.isFinite(d)&&u.push(d)}if(u.length>4){u.sort((d,f)=>d-f);const h=u[Math.floor(u.length/2)];if(this.rhoRef+=h*1.5*this.map.u*this.map.u,Math.abs(h)>.02)return}}const t=Array.from(e).filter(o=>Number.isFinite(o));if(t.length<16)return;t.sort((o,c)=>o-c);const n=o=>t[Math.min(t.length-1,Math.max(0,Math.round(o*(t.length-1))))];let a,i;if(s==="vorticity"){const o=t.map(Math.abs).sort((u,h)=>u-h),c=Math.max(1e-6,o[Math.round(.985*(o.length-1))]);a=-c,i=c}else if(s==="pressure"){const o=Math.max(Math.abs(n(.01)),Math.abs(n(.99)),.001);a=-o,i=o}else a=0,i=Math.max(s==="speed"?1.8:1e-6,n(.995));const l=this.autoRange.ready?.3:1;this.autoRange={lo:this.autoRange.lo*(1-l)+a*l,hi:this.autoRange.hi*(1-l)+i*l,ready:!0},this.emit()}sampleField(){return this.solver?this.solver.readSampled():Promise.resolve(null)}latticeView(e){const s=this.worldView;return{scale:s.mpp/s.dpr/e,ox:(s.cx-s.w/2*s.mpp)/e-.5,oy:(s.cy+s.h/2*s.mpp)/e-.5}}destroy(){this.stop(),this.solver?.destroy(),this.particles.destroy(),this.dye?.destroy(),this.rheo?.destroy(),this.streamlines.destroy(),this.renderer.destroy()}}const ds=100;class gi{state;listeners=new Set;past=[];future=[];onSceneChange=null;constructor(e){this.state={scene:e,selected:null,save:"saved",saveError:""}}get=()=>this.state;subscribe=e=>(this.listeners.add(e),()=>{this.listeners.delete(e)});set(e){this.state={...this.state,...e};for(const s of this.listeners)s()}commit(e,s=!0){s&&(this.past.push(this.state.scene),this.past.length>ds&&this.past.shift(),this.future=[]);const t=this.state.selected,n=t&&(e.bodies.some(a=>a.id===t)||e.rakes.some(a=>a.id===t))?t:null;this.set({scene:e,selected:n}),this.onSceneChange?.(e)}commitFrom(e,s){this.past.push(e),this.past.length>ds&&this.past.shift(),this.future=[],this.commit(s,!1)}updateBody(e,s,t=!0){const n=this.state.scene;this.commit({...n,bodies:n.bodies.map(a=>a.id===e?{...a,...s}:a)},t)}get canUndo(){return this.past.length>0}get canRedo(){return this.future.length>0}undo(){const e=this.past.pop();return e?(this.future.push(this.state.scene),this.commit(e,!1),!0):!1}redo(){const e=this.future.pop();return e?(this.past.push(this.state.scene),this.commit(e,!1),!0):!1}select(e){this.set({selected:e})}setSave(e,s=""){this.set({save:e,saveError:s})}}function se(r,e){return an(r.subscribe,()=>e(r.get()))}const bi=new Intl.NumberFormat("en-US",{maximumSignificantDigits:3}),xe=r=>bi.format(r);function Xe({title:r,children:e,attr:s}){return F("section",{className:"t2d-section","data-t2d-section":s??r.toLowerCase(),children:[m("h2",{className:"t2d-section-title",children:r}),m("div",{className:"t2d-section-body",children:e})]})}const Ot=r=>r==="imperial"?"ft":"m";function hs({label:r,value:e,onCommit:s,error:t,attr:n}){const[a,i]=ge(e);return ue(()=>i(e),[e]),m("span",{className:"mgk-type mgk-value-row",children:m("input",{className:"mgk-input mgk-input--wide","aria-label":r,value:a,"data-t2d-text":n,"aria-invalid":t?!0:void 0,onChange:l=>i(l.target.value),onBlur:()=>a!==e&&s(a),onKeyDown:l=>{l.key==="Enter"&&l.target.blur(),l.key==="Escape"&&(i(e),l.target.blur())}})})}function vi(r){return r==null||r<150?10:r<250?5:3}function wi({store:r,engine:e,units:s}){const t=se(r,d=>d.scene),n=se(r,d=>d.selected),[,a]=ge(0);ue(()=>e.subscribe(()=>a(d=>d+1)),[e]);const i=d=>r.commit({...t,flow:{...t.flow,...d}}),l=t.bodies.find(d=>d.id===n)??t.bodies.find(d=>d.enabled)??null,o=l?e.reynoldsFor(l):null,c=e.lattice,u=e.flowModel,h=l?e.cellsAcross(l):null;return F(Xe,{title:"Wind",children:[m(N,{label:"Wind speed",help:"The speed of the flow coming in at the left.",children:m(Se,{label:"Wind speed",quantity:"velocity",units:s,valueSi:t.flow.speed,onCommitSi:d=>i({speed:Math.min(L.speed[1],Math.max(L.speed[0],d))})})}),m(N,{label:"Fluid",children:m(ie,{label:"Fluid",value:t.flow.fluid,options:Object.entries(tt).map(([d,f])=>({value:d,label:f.label})),onChange:d=>i({fluid:d})})}),m(N,{label:"Flow model",help:"Resolved: the grid's own flow, exact when the grid resolves the Reynolds number, otherwise run at the highest one it does. Turbulence model: Spalart–Allmaras with wall functions, at the real Reynolds number. Auto: the turbulence model from a Reynolds number of 100,000 up.",children:m(ie,{label:"Flow model",value:t.flow.model,options:[{value:"auto",label:`Auto (${u==="sa"?"turbulence model":"resolved"})`},{value:"resolved",label:"Resolved"},{value:"sa",label:"Turbulence model (SA)"}],onChange:d=>i({model:d})})}),l&&o?F("div",{className:"t2d-re","data-t2d-re":!0,"data-real":o.real,"data-sim":o.sim,"data-t2d-model":u,children:[m("div",{className:"t2d-re-row",children:F("span",{children:["Reynolds number (",mt(l.shape),", ",xe(Ue(l.shape))," m)"]})}),F("div",{className:"t2d-re-row",children:[m("span",{className:"t2d-re-k",children:"Real"}),m("span",{className:"t2d-re-v","data-t2d-re-real":!0,children:xe(o.real)}),m("span",{className:"t2d-re-k",children:"Simulated"}),m("span",{className:"t2d-re-v","data-t2d-re-sim":!0,children:xe(o.sim)})]}),u==="sa"?m(te,{tone:o.real<3e5?"warning":void 0,children:F("span",{"data-t2d-model-note":"sa",children:["Turbulence model on (Spalart–Allmaras, wall functions) at the real Reynolds number. It gives the mean flow: attached boundary layers, stall to within a few degrees, and lift to within about ",vi(h)," % with ",xe(Math.round(h??0))," cells across the body",(h??0)<250?" (Refine near bodies narrows it)":"",". Drag reads high (up to about twice the real drag at this resolution), and past the stall the flow is not reliable. Turbulent eddies themselves are not drawn: 2D turbulence is not the real, 3D kind.",o.real<3e5?" Below a Reynolds number of about 300,000, real airfoils often have laminar separation bubbles this model does not capture.":""]})}):c?.capped?m(te,{tone:"warning",children:F("span",{"data-t2d-model-note":"capped",children:["This grid resolves a Reynolds number of about ",xe(o.sim)," here, so the flow is simulated at that, not at ",xe(o.real),". Wakes, shedding and separation show as they do at the lower Reynolds number, and so do the forces. A finer resolution raises it",o.real>=1e5?"; the turbulence model runs the real one":"","."]})}):null]}):m(te,{children:"Add a body to see its Reynolds number."})]})}function ki({store:r,engine:e,units:s}){const t=se(r,o=>o.scene),[,n]=ge(0);ue(()=>e.subscribe(()=>n(o=>o+1)),[e]);const a=o=>r.commit({...t,tunnel:{...t.tunnel,...o}}),i=e.grid,l=o=>{const c=Lt(t,De[o]);return`${o[0].toUpperCase()}${o.slice(1)} (${c.nx} × ${c.ny})`};return F(Xe,{title:"Tunnel",children:[m(N,{label:"Length",help:"The tunnel from inlet to outlet.",children:m(Se,{label:"Length",quantity:"length",unit:Ot(s),units:s,valueSi:t.tunnel.length,onCommitSi:o=>a({length:Math.min(L.length[1],Math.max(L.length[0],o))})})}),m(N,{label:"Height",children:m(Se,{label:"Height",quantity:"length",unit:Ot(s),units:s,valueSi:t.tunnel.height,onCommitSi:o=>a({height:Math.min(L.height[1],Math.max(L.height[0],o))})})}),m(N,{label:"Walls",help:"Open: no walls; the free stream goes on beyond the top and bottom, and waves and wakes pass out through them (a body in open air). Slip walls let the flow slide along them. Solid walls have boundary layers, like a real tunnel. Periodic: what leaves at the top comes in at the bottom.",children:m(ie,{label:"Walls",value:t.tunnel.walls,options:[{value:"farfield",label:"Open (no walls)"},{value:"slip",label:"Slip walls"},{value:"noslip",label:"Solid"},{value:"periodic",label:"Periodic"}],onChange:o=>a({walls:o})})}),m(N,{label:"Resolution",help:"Cells in the grid. Finer grids show more detail and a higher Reynolds number, and run slower. Auto picks the finest this GPU runs smoothly.",children:m(ie,{label:"Resolution",value:t.tunnel.resolution,options:[{value:"auto",label:t.tunnel.resolution==="auto"&&i?`Auto (${i.nx} × ${i.ny})`:"Auto"},...["low","medium","high","ultra"].map(o=>({value:o,label:l(o)}))],onChange:o=>a({resolution:o})})}),m(N,{label:"Refine near bodies",help:"Cells half (x2) or a quarter (x4) the size round each body, moving with it: thinner boundary layers, sharper leading and trailing edges, and, when the flow is resolved, twice or four times the Reynolds number near the body. The flow runs about 3 or 7 times slower. At a real Reynolds number of millions, drag still reads high: that needs cells far smaller than any real-time grid.",children:m(ie,{label:"Refine near bodies",value:String(t.tunnel.refine),options:[{value:"0",label:"Off"},{value:"1",label:"x2 finer"},{value:"2",label:"x4 finer"}],onChange:o=>a({refine:Number(o)}),disabled:!!e.refineUnavailable})}),e.refineUnavailable?m(te,{tone:"warning",children:e.refineUnavailable}):null,m(te,{children:"The shaded strips at the inlet and the outlet absorb pressure waves; the flow there is not physical."})]})}const Mi=[{value:"particles",label:"Flow with particles"},{value:"vorticity",label:"Vorticity"},{value:"speed",label:"Speed"},{value:"pressure",label:"Pressure (Cp)"},{value:"schlieren",label:"Density gradient (schlieren)"},{value:"rheoscopic",label:"Rheoscopic (flakes in a tank)"},{value:"none",label:"None (markers on a dark background)"}];function Pi({store:r}){const e=se(r,t=>t.scene),s=t=>r.commit({...e,view:{...e.view,...t}},!1);return F(Xe,{title:"View",children:[m(N,{label:"Show",children:m(ie,{label:"Show",value:e.view.field,options:Mi,onChange:t=>s({field:t})})}),e.view.field==="particles"?m(N,{label:"Colour by",help:"The flow's speed or its vorticity, drawn under the particles; each particle is a lighter shade of the colour where it is.",children:m(ie,{label:"Colour by",value:e.view.particleColor,options:[{value:"speed",label:"Speed"},{value:"vorticity",label:"Vorticity"}],onChange:t=>s({particleColor:t})})}):null,e.view.field==="rheoscopic"?m(N,{label:"Flakes",help:"How the tank looks: the flakes' colour and the two lights over it. Flakes lie flat and tilt with the flow, and catch the light where the flow shears and turns; still water goes dull.",children:m(ie,{label:"Flakes",value:e.view.rheoPreset,options:[{value:"kalliroscope",label:"Kalliroscope blue"},{value:"pearl",label:"Pearl"},{value:"copper",label:"Copper"}],onChange:t=>s({rheoPreset:t})})}):null,m(N,{label:"Colour range",help:"Automatic follows the flow; turn it off to fix the range (in the legend's units).",children:m(qe,{label:"Automatic colour range",checked:e.view.autoRange,onChange:t=>s({autoRange:t})})}),m(N,{label:"Run speed",help:"As fast as possible runs as many steps as the GPU manages each frame. Real time slows it to the speed of the real flow, when the GPU is fast enough.",children:m(ie,{label:"Run speed",value:e.view.speed,options:[{value:"max",label:"As fast as possible"},{value:"realtime",label:"Real time"}],onChange:t=>s({speed:t})})})]})}function Xs(r,e,s){const{length:t,height:n}=r.tunnel,a=_t(We(e)),i=r.bodies.map(c=>({x:c.x,y:c.y,r:_t(We(c.shape))})),l=(c,u)=>i.every(h=>Math.hypot(h.x-c,h.y-u)>(h.r+a)*1.1);let o={x:t*.35,y:n/2};e:for(const c of[.3,.42,.54,.66,.24])for(const u of[.5,.3,.7,.2,.8]){const h=t*c,d=n*u;if(!(d-a<0||d+a>n)&&l(h,d)){o={x:h,y:d};break e}}return{id:Xt(),name:s,shape:e,x:o.x,y:o.y,angle:0,spin:0,enabled:!0,locked:!1}}function fs(r,e){const s=r.get().scene,t=s.tunnel.height,n={naca:[{kind:"naca",code:"0012",chord:t/4},"NACA 0012"],circle:[{kind:"circle",diameter:t/10},"Cylinder"],rect:[{kind:"rect",width:t/8,height:t/8},"Rectangle"],ellipse:[{kind:"ellipse",width:t/5,height:t/10},"Ellipse"],plate:[{kind:"plate",length:t/4,thickness:t/80},"Flat plate"]},[a,i]=n[e],l=Xs(s,a,i);r.commit({...s,bodies:[...s.bodies,l]}),r.select(l.id)}function Ai({store:r,ws:e}){const s=se(r,o=>o.scene),t=se(r,o=>o.selected),n=Ie(null),a=s.bodies.length>=L.maxBodies,i=async o=>{try{const c=En(await o.text(),o.name),u=r.get().scene,h=Xs(u,{kind:"dat",name:c.name,x:c.x,y:c.y,chord:u.tunnel.height/4},c.name);r.commit({...u,bodies:[...u.bodies,h]}),r.select(h.id),e.ui.toast(c.warnings.length?`Imported ${c.name}. ${c.warnings.join(" ")}`:`Imported ${c.name}.`,{kind:"success"})}catch(c){e.ui.toast(c instanceof ce?`${o.name}: ${c.message}`:`${o.name} could not be read: ${String(c)}`,{kind:"error"})}},l=o=>{const c=r.get().scene;r.commit({...c,bodies:c.bodies.filter(u=>u.id!==o.id)}),e.ui.toast(`Removed ${o.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})};return F(Xe,{title:"Bodies",children:[F("div",{className:"t2d-add-row",children:[m(Ae,{variant:"secondary",disabled:a,onClick:()=>fs(r,"naca"),attrs:{"data-t2d-add":"naca"},children:"Add airfoil"}),m(ie,{label:"Add shape",value:"",disabled:a,options:[{value:"",label:"Add shape…"},{value:"circle",label:"Cylinder"},{value:"rect",label:"Rectangle"},{value:"ellipse",label:"Ellipse"},{value:"plate",label:"Flat plate"}],onChange:o=>o&&fs(r,o)}),m(Ae,{variant:"neutral",disabled:a,onClick:()=>n.current?.click(),attrs:{"data-t2d-import":"1"},children:"Import .dat…"}),m("input",{ref:n,type:"file",accept:".dat,.txt",hidden:!0,"data-t2d-file":!0,onChange:o=>{const c=o.target.files?.[0];o.target.value="",c&&i(c)}})]}),a?F(te,{tone:"warning",children:["A tunnel holds at most ",L.maxBodies," bodies."]}):null,s.bodies.length===0?m(te,{children:"No bodies yet: add an airfoil or a shape, or import an airfoil’s .dat file."}):null,m("ul",{className:"t2d-body-list",role:"listbox","aria-label":"Bodies",children:s.bodies.map(o=>F("li",{role:"option","aria-selected":o.id===t,className:`t2d-body-row${o.id===t?" is-selected":""}${o.enabled?"":" is-off"}`,"data-t2d-body":o.id,onClick:()=>r.select(o.id),children:[m("span",{className:"t2d-body-name",children:o.name}),m("span",{className:"t2d-body-kind",children:mt(o.shape)===o.name?"":mt(o.shape)}),m("button",{type:"button",className:"t2d-icon-btn",title:o.enabled?"Take it out of the flow":"Put it in the flow","aria-label":o.enabled?`Take ${o.name} out of the flow`:`Put ${o.name} in the flow`,"aria-pressed":o.enabled,onClick:c=>{c.stopPropagation(),r.updateBody(o.id,{enabled:!o.enabled})},children:m(ft,{path:o.enabled?"M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6":"M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6",size:14})}),m("button",{type:"button",className:"t2d-icon-btn",title:`Remove ${o.name}`,"aria-label":`Remove ${o.name}`,onClick:c=>{c.stopPropagation(),l(o)},children:m(ft,{name:"trash",size:14})})]},o.id))})]})}function ps(r,e){const s=r.spinCap(e.id);return s!==null&&Math.abs(e.spin)>s?s:null}function Si({store:r,ws:e,units:s,engine:t}){const n=se(r,g=>g.scene),a=se(r,g=>g.selected),[i,l]=ge(""),o=n.bodies.find(g=>g.id===a);if(ue(()=>l(""),[a]),!o)return m(Xe,{title:"Body",attr:"body",children:m(te,{children:"Select a body to edit it. Drag a body to move it, and drag the round handle above it to turn it (Shift: whole degrees)."})});const c=Ot(s),u=g=>r.updateBody(o.id,g),h=g=>u({shape:{...o.shape,...g}}),d=g=>Math.max(1e-4,Math.min(1e3,g)),f=(g,S,P,x)=>m(N,{label:g,help:x,children:m(Se,{label:g,quantity:"length",unit:c,units:s,valueSi:S,onCommitSi:v=>P(d(v))})});let y=null;switch(o.shape.kind){case"naca":{const g=o.shape.code;y=F(Mt,{children:[m(N,{label:"NACA designation",help:"4 or 5 digits, such as 2412 or 23012.",children:m(hs,{label:"NACA designation",attr:"naca",value:g,error:i,onCommit:S=>{try{const P=Vt(S);l("");const x=o.name===`NACA ${g}`?`NACA ${P}`:o.name;u({shape:{...o.shape,code:P},name:x})}catch(P){l(P instanceof Be?P.message:String(P))}}})}),i?m(te,{tone:"danger",children:m("span",{"data-t2d-naca-error":!0,children:i})}):null,f("Chord",o.shape.chord,S=>h({chord:S}))]});break}case"dat":y=f("Chord",o.shape.chord,g=>h({chord:g}));break;case"circle":y=f("Diameter",o.shape.diameter,g=>h({diameter:g}));break;case"rect":case"ellipse":y=F(Mt,{children:[f("Width",o.shape.width,g=>h({width:g}),"Along the flow, before turning."),f("Height",o.shape.height,g=>h({height:g}))]});break;case"plate":y=F(Mt,{children:[f("Length",o.shape.length,g=>h({length:g})),f("Thickness",o.shape.thickness,g=>h({thickness:g}),"A plate thinner than about two cells of the grid is drawn thicker than it is.")]});break}const p=t.lattice?.dx??0,b=o.shape.kind==="plate"&&p>0&&o.shape.thickness<2*p;return F(Xe,{title:"Body",attr:"body",children:[m(N,{label:"Name",children:m(hs,{label:"Name",attr:"name",value:o.name,onCommit:g=>u({name:g.trim().slice(0,80)||o.name})})}),m("div",{className:"t2d-shape-kind",children:mt(o.shape)}),y,b?F(te,{tone:"warning",children:["This plate is thinner than two grid cells (",xe(sn("length",2*p,s==="imperial"?"in":"mm"))," ",s==="imperial"?"in":"mm","): the flow sees a thicker one."]}):null,f("Position x",o.x,g=>u({x:Math.min(n.tunnel.length,Math.max(0,g))}),o.shape.kind==="naca"||o.shape.kind==="dat"?"Of the quarter chord, from the inlet.":"Of the centre, from the inlet."),m(N,{label:"Position y",help:"From the bottom wall.",children:m(Se,{label:"Position y",quantity:"length",unit:c,units:s,valueSi:o.y,onCommitSi:g=>u({y:Math.min(n.tunnel.height,Math.max(0,g))})})}),m(N,{label:o.shape.kind==="naca"||o.shape.kind==="dat"?"Angle of attack":"Angle",help:"Positive raises the leading (left) side.",children:m(Se,{label:"Angle",unit:"°",valueSi:o.angle,onCommitSi:g=>u({angle:Math.max(-180,Math.min(180,g))})})}),m(N,{label:"Spin",help:"Turns the body continuously; positive is counter-clockwise. A spinning cylinder shows the Magnus effect.",children:m(Se,{label:"Spin",quantity:"angular_velocity",unit:"rpm",units:s,valueSi:o.spin,onCommitSi:g=>u({spin:Math.max(-1e4,Math.min(1e4,g))})})}),ps(t,o)?m(te,{tone:"warning",children:F("span",{"data-t2d-spin-capped":!0,children:["This spin is held to ",xe(ps(t,o)*(60/(2*Math.PI)))," rpm: the body’s edge would move faster than twice the wind speed, more than the lattice can carry."]})}):null,m(N,{label:"In the flow",children:m(qe,{label:"In the flow",checked:o.enabled,onChange:g=>u({enabled:g})})}),m(N,{label:"Locked",help:"A locked body cannot be dragged or turned with the mouse.",children:m(qe,{label:"Locked",checked:o.locked,onChange:g=>u({locked:g})})}),m("div",{className:"t2d-panel-foot",children:m(Ae,{variant:"danger",onClick:()=>{const g=r.get().scene;r.commit({...g,bodies:g.bodies.filter(S=>S.id!==o.id)}),e.ui.toast(`Removed ${o.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})},attrs:{"data-t2d-remove":o.id},children:"Remove body"})})]})}const Bi={streaks:"Streaks",timelines:"Timelines",dye:"Dye"},Ri=["Blue","Purple","Green","Orange","Sky blue","Pink"],Ci=r=>`var(--mg-series-${r%xt+1})`;function Ys({title:r,children:e,attr:s}){return F("section",{className:"t2d-section","data-t2d-section":s,children:[m("h2",{className:"t2d-section-title",children:r}),m("div",{className:"t2d-section-body",children:e})]})}function Te(r,e){const s=r.rakes.filter(t=>t.kind===e.kind);return`${Bi[e.kind]} ${s.indexOf(e)+1}`}function $i(r,e){const s=r.get().scene,{length:t,height:n}=s.tunnel,a=new Set(s.rakes.map(u=>u.color));let i=0;for(;a.has(i)&&i<xt-1;)i++;const l=s.rakes.length,o=t*(.1+.02*(l%4)),c={id:Cs(),kind:e,x0:o,y0:n*.3,x1:o,y1:n*.7,emitters:e==="dye"?7:12,color:i,enabled:!0};r.commit({...s,rakes:[...s.rakes,c]}),r.select(c.id)}function Ui({store:r,ws:e}){const s=se(r,c=>c.scene),t=se(r,c=>c.selected),n=s.view,a=c=>r.commit({...s,view:{...n,...c}},!1),i=s.rakes.filter(c=>c.kind==="dye").length,l=s.rakes.length>=L.maxRakes,o=c=>{const u=r.get().scene;r.commit({...u,rakes:u.rakes.filter(h=>h.id!==c.id)}),e.ui.toast(`Removed ${Te(s,c)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})};return F(Ys,{title:"Flow markers",attr:"markers",children:[n.field==="particles"?m(te,{children:"The particles view shows the tracer particles; here you set how many and their trails."}):m(N,{label:"Tracer particles",help:"Particles carried by the flow, drawn faintly over the field.",children:m(qe,{label:"Tracer particles",checked:n.tracers,onChange:c=>a({tracers:c})})}),m(N,{label:"Particle count",children:m(ie,{label:"Particle count",value:n.density,disabled:!n.tracers&&n.field!=="particles",options:[{value:"low",label:"Few"},{value:"normal",label:"Normal"},{value:"high",label:"Many"}],onChange:c=>a({density:c})})}),m(N,{label:"Streaks",help:"Each particle is drawn as a short streak along its motion.",children:m(ie,{label:"Streaks",value:n.trail,options:[{value:"off",label:"Dots"},{value:"short",label:"Short"},{value:"long",label:"Long"}],onChange:c=>a({trail:c})})}),m(N,{label:"Velocity arrows",children:m(qe,{label:"Velocity arrows",checked:n.arrows,onChange:c=>a({arrows:c})})}),m(N,{label:"Streamlines",help:"Lines along the flow’s direction now, from just past the inlet. In shedding flow they differ from the particles’ paths.",children:m(qe,{label:"Streamlines",checked:n.streamlines,onChange:c=>a({streamlines:c})})}),m("div",{className:"t2d-add-row",children:m(ie,{label:"Add rake",value:"",disabled:l,options:[{value:"",label:"Add rake…"},{value:"streaks",label:"Streaks (a thread from each emitter)"},{value:"timelines",label:"Timelines (a line released at intervals)"},{value:"dye",label:"Dye",disabled:i>=L.maxDyeRakes}],onChange:c=>c&&$i(r,c)})}),l?F(te,{tone:"warning",children:["A tunnel holds at most ",L.maxRakes," rakes."]}):null,i>=L.maxDyeRakes?F(te,{children:["At most ",L.maxDyeRakes," dye rakes: one colour each."]}):null,s.rakes.length?m("ul",{className:"t2d-body-list",role:"listbox","aria-label":"Rakes",children:s.rakes.map(c=>F("li",{role:"option","aria-selected":c.id===t,className:`t2d-body-row${c.id===t?" is-selected":""}${c.enabled?"":" is-off"}`,"data-t2d-rake":c.id,onClick:()=>r.select(c.id),children:[m("span",{className:"t2d-swatch",style:{background:Ci(c.color)}}),m("span",{className:"t2d-body-name",children:Te(s,c)}),m("span",{className:"t2d-body-kind"}),m("button",{type:"button",className:"t2d-icon-btn","aria-pressed":c.enabled,"aria-label":c.enabled?`Stop ${Te(s,c)}`:`Start ${Te(s,c)}`,title:c.enabled?"Stop it":"Start it",onClick:u=>{u.stopPropagation();const h=r.get().scene;r.commit({...h,rakes:h.rakes.map(d=>d.id===c.id?{...d,enabled:!d.enabled}:d)})},children:m(ft,{path:c.enabled?"M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6":"M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6",size:14})}),m("button",{type:"button",className:"t2d-icon-btn","aria-label":`Remove ${Te(s,c)}`,title:"Remove it",onClick:u=>{u.stopPropagation(),o(c)},children:m(ft,{name:"trash",size:14})})]},c.id))}):m(te,{children:"A rake releases streaks, timelines or dye from a line you place and drag in the tunnel."})]})}function Ti({store:r,ws:e,units:s,rake:t}){const n=se(r,f=>f.scene),a=s==="imperial"?"ft":"m",i=f=>{const y=r.get().scene;r.commit({...y,rakes:y.rakes.map(p=>p.id===t.id?{...p,...f}:p)})},{length:l,height:o}=n.tunnel,c=f=>Math.min(l,Math.max(0,f)),u=f=>Math.min(o,Math.max(0,f)),h=n.rakes.filter(f=>f.kind==="dye"&&f.id!==t.id).length,d=(f,y,p)=>m(N,{label:f,children:m(Se,{label:f,quantity:"length",unit:a,units:s,valueSi:y,onCommitSi:p})});return F(Ys,{title:"Rake",attr:"rake",children:[m("div",{className:"t2d-shape-kind","data-t2d-rake-name":!0,children:Te(n,t)}),m(N,{label:"Releases",children:m(ie,{label:"Releases",value:t.kind,options:[{value:"streaks",label:"Streaks"},{value:"timelines",label:"Timelines"},{value:"dye",label:"Dye",disabled:h>=L.maxDyeRakes}],onChange:f=>i({kind:f})})}),t.kind!=="timelines"?m(N,{label:"Emitters",help:"Points along the rake that release the markers.",children:m(Se,{label:"Emitters",valueSi:t.emitters,onCommitSi:f=>i({emitters:Math.round(Math.min(L.emitters[1],Math.max(L.emitters[0],f)))})})}):null,m(N,{label:"Colour",children:m(ie,{label:"Colour",value:String(t.color),options:Ri.map((f,y)=>({value:String(y),label:f})),onChange:f=>i({color:Number(f)})})}),d("Start x",t.x0,f=>i({x0:c(f)})),d("Start y",t.y0,f=>i({y0:u(f)})),d("End x",t.x1,f=>i({x1:c(f)})),d("End y",t.y1,f=>i({y1:u(f)})),m(N,{label:"Releasing",children:m(qe,{label:"Releasing",checked:t.enabled,onChange:f=>i({enabled:f})})}),m(te,{children:"Drag the rake to move it, or one of its ends to stretch or turn it."}),m("div",{className:"t2d-panel-foot",children:m(Ae,{variant:"danger",attrs:{"data-t2d-remove-rake":t.id},onClick:()=>{const f=r.get().scene;r.commit({...f,rakes:f.rakes.filter(y=>y.id!==t.id)}),e.ui.toast(`Removed ${Te(n,t)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})},children:"Remove rake"})})]})}const Fi=26,Ft=7,ct=new Map;function Ei(r){const e=JSON.stringify(r.shape);let s=ct.get(e);return s||(s=We(r.shape),ct.size>64&&ct.clear(),ct.set(e,s)),s}function Ne(r,e){return ze(Ei(r),{x:e.x,y:e.y,theta:-e.angle*Math.PI/180})}function Ks(r,e){const s=r.worldView,t=(o,c)=>({x:s.w/2+(o-s.cx)/s.mpp,y:s.h/2-(c-s.cy)/s.mpp}),n=r.livePose(e.id)??{x:e.x,y:e.y,angle:e.angle},a=Ne(e,n);let i=1/0;for(let o=1;o<a.length;o+=2)i=Math.min(i,t(0,a[o]).y);const l=t(n.x,n.y);return{x:l.x,y:i-Fi,cx:l.x,cy:l.y}}function ht(r,e){const s=r.worldView,{length:t,height:n}=e.tunnel,a=Math.max(t/Math.max(50,s.w-32),n/Math.max(50,s.h-32));r.worldView={...s,cx:t/2,cy:n/2,mpp:a}}function _i({engine:r,store:e,onStatus:s}){const t=Ie(null),n=Ie(null),a=Ie(null),i=Ie(null),l=Ie("");ue(()=>{const x=t.current,v=new ResizeObserver(()=>{const M=x.getBoundingClientRect(),$=window.devicePixelRatio||1,k=r.canvas;k.width=Math.max(1,Math.round(M.width*$)),k.height=Math.max(1,Math.round(M.height*$));const R=a.current;R.width=k.width,R.height=k.height,r.worldView={...r.worldView,w:M.width,h:M.height,dpr:$};const T=e.get().scene,w=`${T.tunnel.length}x${T.tunnel.height}`;l.current!==w&&(ht(r,T),l.current=w)});return v.observe(x),()=>v.disconnect()},[r,e]),ue(()=>{const x=n.current;return x.replaceWith(r.canvas),r.canvas.className="t2d-canvas",r.canvas.setAttribute("data-t2d-canvas","1"),()=>{r.canvas.replaceWith(x)}},[r]),ue(()=>e.subscribe(()=>{const x=e.get().scene,v=`${x.tunnel.length}x${x.tunnel.height}`;l.current&&l.current!==v&&(ht(r,x),l.current=v)}),[r,e]);const o=(x,v)=>{const M=t.current.getBoundingClientRect(),$=r.worldView;return{x:$.cx+(x-M.left-$.w/2)*$.mpp,y:$.cy-(v-M.top-$.h/2)*$.mpp}},c=(x,v)=>{const M=r.worldView;return{x:M.w/2+(x-M.cx)/M.mpp,y:M.h/2-(v-M.cy)/M.mpp}},u=x=>r.livePose(x.id)??{x:x.x,y:x.y,angle:x.angle},h=x=>Ks(r,x);ue(()=>{let x=0;const v=getComputedStyle(document.documentElement),M=v.getPropertyValue("--t2d-select").trim()||"black",$=v.getPropertyValue("--t2d-ghost").trim()||"gray",k=v.getPropertyValue("--mg-bg").trim()||"white",R=()=>{x=requestAnimationFrame(R);const T=a.current;if(!T)return;const w=T.getContext("2d"),E=r.worldView;w.setTransform(E.dpr,0,0,E.dpr,0,0),w.clearRect(0,0,E.w,E.h);const{scene:B,selected:C}=e.get(),U=i.current;for(const A of B.rakes){const D=v.getPropertyValue(`--mg-series-${A.color%6+1}`).trim()||M,j=c(A.x0,A.y0),W=c(A.x1,A.y1),I=A.id===C;if(w.globalAlpha=A.enabled?1:.45,w.beginPath(),w.moveTo(j.x,j.y),w.lineTo(W.x,W.y),w.strokeStyle=D,w.lineWidth=I?3:2,w.setLineDash(A.kind==="timelines"?[6,4]:[]),w.stroke(),w.setLineDash([]),A.kind!=="timelines"){w.fillStyle=D;for(let q=0;q<A.emitters;q++){const H=A.emitters===1?.5:q/(A.emitters-1);w.beginPath(),w.arc(j.x+(W.x-j.x)*H,j.y+(W.y-j.y)*H,2.5,0,Math.PI*2),w.fill()}}if(I)for(const q of[j,W])w.fillStyle=k,w.strokeStyle=D,w.lineWidth=2,w.fillRect(q.x-5,q.y-5,10,10),w.strokeRect(q.x-5,q.y-5,10,10);w.globalAlpha=1}for(const A of B.bodies){const D=A.id===C,j=U&&(U.kind==="move"||U.kind==="turn")&&U.id===A.id?{x:U.kind==="move"?U.bodyX:U.x,y:U.kind==="move"?U.bodyY:U.y,angle:U.angle}:null,W=u(A),I=q=>{w.beginPath();for(let H=0;H<q.length;H+=2){const he=c(q[H],q[H+1]);H===0?w.moveTo(he.x,he.y):w.lineTo(he.x,he.y)}w.closePath()};if(A.enabled||(I(Ne(A,W)),w.setLineDash([4,4]),w.strokeStyle=$,w.lineWidth=1.5,w.stroke(),w.setLineDash([])),j&&(Math.abs(j.x-W.x)>1e-6||Math.abs(j.y-W.y)>1e-6||Math.abs(j.angle-W.angle)>.001)&&(I(Ne(A,j)),w.setLineDash([5,4]),w.strokeStyle=$,w.lineWidth=1.5,w.stroke(),w.setLineDash([])),D){if(I(Ne(A,W)),w.strokeStyle=M,w.lineWidth=2,w.stroke(),!A.locked){const H=h(A);w.beginPath(),w.moveTo(H.cx,H.cy),w.lineTo(H.x,H.y+Ft),w.strokeStyle=M,w.lineWidth=1,w.stroke(),w.beginPath(),w.arc(H.x,H.y,Ft,0,Math.PI*2),w.fillStyle=k,w.fill(),w.lineWidth=2,w.stroke()}const q=c(W.x,W.y);w.beginPath(),w.moveTo(q.x-5,q.y),w.lineTo(q.x+5,q.y),w.moveTo(q.x,q.y-5),w.lineTo(q.x,q.y+5),w.lineWidth=1.5,w.stroke()}}};return x=requestAnimationFrame(R),()=>cancelAnimationFrame(x)},[r,e]);const d=(x,v)=>{const M=e.get().scene.bodies;for(let $=M.length-1;$>=0;$--){const k=M[$];if(pt(Ne(k,u(k)),x,v))return k}return null},f=(x,v)=>{const M=t.current.getBoundingClientRect(),$=x-M.left,k=v-M.top,{scene:R,selected:T}=e.get();for(let w=R.rakes.length-1;w>=0;w--){const E=R.rakes[w],B=c(E.x0,E.y0),C=c(E.x1,E.y1);if(E.id===T){if(Math.hypot($-B.x,k-B.y)<=8)return{rake:E,part:"start"};if(Math.hypot($-C.x,k-C.y)<=8)return{rake:E,part:"end"}}const U=C.x-B.x,A=C.y-B.y,D=U*U+A*A,j=D>0?Math.max(0,Math.min(1,(($-B.x)*U+(k-B.y)*A)/D)):0;if(Math.hypot($-(B.x+j*U),k-(B.y+j*A))<=6)return{rake:E,part:"all"}}return null},y=(x,v)=>{const M=e.get().scene.tunnel;return{x:Math.min(M.length,Math.max(0,x)),y:Math.min(M.height,Math.max(0,v))}},p=x=>{x.target.setPointerCapture(x.pointerId);const v=o(x.clientX,x.clientY),M=r.worldView;if(x.button===1){i.current={kind:"pan",startX:x.clientX,startY:x.clientY,cx:M.cx,cy:M.cy};return}if(x.button!==0)return;const{scene:$,selected:k}=e.get(),R=$.bodies.find(E=>E.id===k);if(R&&!R.locked){const E=h(R),B=t.current.getBoundingClientRect();if(Math.hypot(x.clientX-B.left-E.x,x.clientY-B.top-E.y)<=Ft+4){const C=u(R),U=Math.atan2(v.y-C.y,v.x-C.x);i.current={kind:"turn",id:R.id,startAngle:R.angle,pointerStart:U,angle:R.angle,x:R.x,y:R.y};return}}const T=f(x.clientX,x.clientY);if(T){e.select(T.rake.id),i.current={kind:"rake",id:T.rake.id,part:T.part,startX:v.x,startY:v.y,r0:T.rake,before:e.get().scene};return}const w=d(v.x,v.y);if(w){e.select(w.id),w.locked||(i.current={kind:"move",id:w.id,startX:v.x,startY:v.y,bodyX:w.x,bodyY:w.y,angle:w.angle,moved:!1});return}e.select(null),i.current={kind:"pan",startX:x.clientX,startY:x.clientY,cx:M.cx,cy:M.cy}},b=x=>{const v=i.current;if(!v){const k=o(x.clientX,x.clientY),R=f(x.clientX,x.clientY),T=R?null:d(k.x,k.y);t.current.style.cursor=R?R.part==="all"?"move":"crosshair":T&&!T.locked?"grab":"default";return}if(v.kind==="rake"){const k=o(x.clientX,x.clientY),R=k.x-v.startX,T=k.y-v.startY,w=v.r0,E=y(w.x0+(v.part==="end"?0:R),w.y0+(v.part==="end"?0:T)),B=y(w.x1+(v.part==="start"?0:R),w.y1+(v.part==="start"?0:T)),C=e.get().scene;e.commit({...C,rakes:C.rakes.map(U=>U.id===v.id?{...U,x0:E.x,y0:E.y,x1:B.x,y1:B.y}:U)},!1);return}if(v.kind==="pan"){const k=r.worldView;r.worldView={...k,cx:v.cx-(x.clientX-v.startX)*k.mpp,cy:v.cy+(x.clientY-v.startY)*k.mpp};return}const M=o(x.clientX,x.clientY),$=e.get().scene.bodies.find(k=>k.id===v.id);if($)if(v.kind==="move"){const k=y($.x+(M.x-v.startX),$.y+(M.y-v.startY));v.bodyX=k.x,v.bodyY=k.y,v.moved=!0,t.current.style.cursor="grabbing",r.setTarget(v.id,{x:k.x,y:k.y,angle:v.angle}),s?.(`x ${k.x.toFixed(3)} m, y ${k.y.toFixed(3)} m`)}else{const k=u($),R=Math.atan2(M.y-k.y,M.x-k.x);let T=v.startAngle-(R-v.pointerStart)*180/Math.PI;T=((T+180)%360+360)%360-180,x.shiftKey&&(T=Math.round(T)),v.angle=T,r.setTarget(v.id,{x:v.x,y:v.y,angle:T}),s?.(`Angle ${T.toFixed(1)}°`)}},g=()=>{const x=i.current;if(i.current=null,s?.(""),!(!x||x.kind==="pan")){if(x.kind==="rake"){const v=e.get().scene;v!==x.before&&e.commitFrom(x.before,v);return}x.kind==="move"&&x.moved&&e.updateBody(x.id,{x:x.bodyX,y:x.bodyY}),x.kind==="turn"&&e.updateBody(x.id,{angle:x.angle}),r.setTarget(x.id,null)}};return F("div",{ref:t,className:"t2d-viewport","data-t2d-viewport":!0,onPointerDown:p,onPointerMove:b,onPointerUp:g,onPointerCancel:g,onWheel:x=>{const v=r.worldView,M=o(x.clientX,x.clientY),$=e.get().scene.tunnel,k=Math.min(Math.max($.length,$.height)/50,Math.max($.length/1e5,v.mpp*Math.exp(x.deltaY*.0015)));r.worldView={...v,mpp:k};const R=o(x.clientX,x.clientY);r.worldView={...r.worldView,cx:r.worldView.cx+(M.x-R.x),cy:r.worldView.cy+(M.y-R.y)}},onDoubleClick:x=>{const v=o(x.clientX,x.clientY);d(v.x,v.y)||ht(r,e.get().scene)},onContextMenu:x=>x.preventDefault(),children:[m("canvas",{ref:n}),m("canvas",{ref:a,className:"t2d-overlay"})]})}function Di(r,e,s){const t=e.flow.speed;switch(r){case"vorticity":return{title:"Vorticity",unit:"1/s",k:t/s,centred:!0};case"speed":return{title:"Speed",unit:"m/s",k:t,centred:!1};case"pressure":return{title:"Pressure coefficient Cp",unit:"",k:1,centred:!0};case"schlieren":return{title:"Density gradient (relative)",unit:"",k:1,centred:!1};case"particles":return e.view.particleColor==="vorticity"?{title:"Vorticity",unit:"1/s",k:t/s,centred:!0}:{title:"Speed",unit:"m/s",k:t,centred:!1};case"none":case"rheoscopic":return{title:"",unit:"",k:1,centred:!1}}}function Hs(r){const[,e]=ge(0);ue(()=>{const s=setInterval(()=>e(t=>t+1),r);return()=>clearInterval(s)},[r])}function Gi({engine:r,store:e}){Hs(300);const s=se(e,a=>a.save),t=r.stats,n={saved:"Saved",pending:"Not saved yet",saving:"Saving…",failed:"Not saved",conflict:"Saved elsewhere"}[s];return F("div",{className:"t2d-status","data-t2d-status":!0,"data-state":t.state,"data-steps":t.stepsPerFrame,"data-grid":`${t.nx}x${t.ny}`,children:[m("span",{title:"The GPU the flow runs on",children:t.adapter}),F("span",{children:[t.nx," × ",t.ny," cells"]}),F("span",{children:[t.stepsPerFrame," steps a frame"]}),m("span",{title:"Simulated seconds per second",children:t.state==="running"?`×${xe(t.speedRatio)} real time`:t.state==="paused"?"Paused":"Stopped"}),performance.now()-r.limitedAt<2e3?m("span",{className:"t2d-squeeze","data-t2d-squeeze":!0,title:"Where the flow went faster, or was squeezed harder, than the lattice can carry (a body dragged fast, or a gap closing between bodies), it is held to those limits there, so the flow at that spot is approximate.",children:"Flow held to its limits where it moved too fast"}):null,F("span",{"data-t2d-simtime":t.simTime,children:["t = ",t.simTime<1?`${(t.simTime*1e3).toPrecision(3)} ms`:`${t.simTime.toPrecision(4)} s`]}),m("span",{className:`t2d-save t2d-save--${s}`,"data-t2d-save":s,children:n})]})}function Ni({engine:r,store:e}){Hs(400);const s=se(e,u=>u.scene),t=s.bodies.find(u=>u.enabled),n=t?Ue(t.shape):s.tunnel.height/8,a=Di(s.view.field,s,n),i=r.autoRangeNow,l=s.view.autoRange?i?.lo??s.view.min/a.k:s.view.min/a.k,o=s.view.autoRange?i?.hi??s.view.max/a.k:s.view.max/a.k;if(ue(()=>{s.view.autoRange||r.setRange(s.view.min/a.k,s.view.max/a.k)},[r,s.view.autoRange,s.view.min,s.view.max,a.k]),s.view.field==="none"||s.view.field==="rheoscopic")return null;const c=js(s.view);return F("div",{className:"t2d-legend","data-t2d-legend":!0,"data-lo":l*a.k,"data-hi":o*a.k,children:[c==="inferno"?m(qi,{map:c,min:l*a.k,max:o*a.k,title:a.title,unit:a.unit}):m(nn,{map:c,min:l*a.k,max:o*a.k,title:a.title,unit:a.unit,centred:a.centred,ticks:5,format:xe}),s.view.autoRange?null:m(zi,{lo:s.view.min,hi:s.view.max,onCommit:(u,h)=>e.commit({...s,view:{...s.view,min:u,max:h}},!1)})]})}function qi({map:r,min:e,max:s,title:t,unit:n}){const a=Rs(r),i=Array.from({length:9},(o,c)=>{const u=Math.round(c/8*255);return`rgb(${a[3*u]}, ${a[3*u+1]}, ${a[3*u+2]}) ${c/8*100}%`}),l=Array.from({length:5},(o,c)=>e+(s-e)*c/4);return F("div",{className:"t2d-maplegend",children:[F("div",{className:"mgk-legend-title",children:[t,n?` (${n})`:""]}),m("div",{className:"mgk-legend-bar",style:{background:`linear-gradient(to right, ${i.join(", ")})`}}),m("div",{className:"mgk-legend-ticks",children:l.map((o,c)=>m("span",{children:xe(o)},c))})]})}function zi({lo:r,hi:e,onCommit:s}){const[t,n]=ge(String(r)),[a,i]=ge(String(e));ue(()=>{n(String(r)),i(String(e))},[r,e]);const l=()=>{const o=Number(t),c=Number(a);Number.isFinite(o)&&Number.isFinite(c)&&c>o?s(o,c):(n(String(r)),i(String(e)))};return F("div",{className:"t2d-range",children:[m("input",{className:"mgk-input","aria-label":"Colour range minimum",value:t,onChange:o=>n(o.target.value),onBlur:l,onKeyDown:o=>o.key==="Enter"&&l()}),m("span",{children:"to"}),m("input",{className:"mgk-input","aria-label":"Colour range maximum",value:a,onChange:o=>i(o.target.value),onBlur:l,onKeyDown:o=>o.key==="Enter"&&l()})]})}function Li({ws:r,store:e,engine:s,units:t,problem:n}){const[a,i]=ge(t),[l,o]=ge(!1),[c,u]=ge(!1),[h,d]=ge(""),f=se(e,S=>S.save),y=se(e,S=>S.saveError),p=se(e,S=>S.scene.rakes.find(P=>P.id===S.selected)??null);ue(()=>r.on("units",i),[r]),ue(()=>(s.onUnstable=()=>{u(!0),r.ui.toast("The flow became unstable and was stopped. Reset the flow to start again.",{kind:"error"})},()=>{s.onUnstable=null}),[s,r]);const b=()=>{s.paused=!s.paused,o(s.paused)},g=()=>{s.resetFlow(),u(!1)};return ue(()=>{const S=P=>{const x=P.target;if(x&&(x.tagName==="INPUT"||x.tagName==="SELECT"||x.tagName==="TEXTAREA"||x.isContentEditable))return;const v=P.ctrlKey||P.metaKey;if(v&&P.key.toLowerCase()==="z"&&!P.shiftKey)P.preventDefault(),e.undo();else if(v&&(P.key.toLowerCase()==="y"||P.key.toLowerCase()==="z"&&P.shiftKey))P.preventDefault(),e.redo();else if(P.key===" "&&!v)P.preventDefault(),b();else if((P.key==="Delete"||P.key==="Backspace")&&e.get().selected){P.preventDefault();const M=e.get().scene,$=M.bodies.find(R=>R.id===e.get().selected),k=M.rakes.find(R=>R.id===e.get().selected);$?(e.commit({...M,bodies:M.bodies.filter(R=>R.id!==$.id)}),r.ui.toast(`Removed ${$.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})):k&&(e.commit({...M,rakes:M.rakes.filter(R=>R.id!==k.id)}),r.ui.toast(`Removed ${Te(M,k)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"}))}else if(P.key==="Escape")e.select(null);else if(P.key.startsWith("Arrow")&&e.get().selected){const M=e.get().scene,$=M.bodies.find(T=>T.id===e.get().selected);if(!$||$.locked)return;P.preventDefault();const k=M.tunnel.height/200*(P.shiftKey?10:1),R={ArrowLeft:[-k,0],ArrowRight:[k,0],ArrowUp:[0,k],ArrowDown:[0,-k]}[P.key]??[0,0];e.updateBody($.id,{x:Math.min(M.tunnel.length,Math.max(0,$.x+R[0])),y:Math.min(M.tunnel.height,Math.max(0,$.y+R[1]))})}};return window.addEventListener("keydown",S),()=>window.removeEventListener("keydown",S)}),F("div",{className:"t2d-app","data-t2d-app":!0,children:[F("header",{className:"t2d-toolbar",role:"toolbar","aria-label":"Tunnel",children:[m(Ae,{variant:l?"primary":"secondary",onClick:b,attrs:{"data-t2d-play":l?"paused":"running"},title:"Space",children:l?"Run":"Pause"}),m(Ae,{variant:"neutral",onClick:g,attrs:{"data-t2d-reset":"1"},title:"Start the flow again from a uniform stream",children:"Reset flow"}),m("span",{className:"t2d-sep"}),m(Ae,{variant:"neutral",onClick:()=>e.undo(),disabled:!e.canUndo,title:"Ctrl+Z",attrs:{"data-t2d-undo":"1"},children:"Undo"}),m(Ae,{variant:"neutral",onClick:()=>e.redo(),disabled:!e.canRedo,title:"Ctrl+Y",attrs:{"data-t2d-redo":"1"},children:"Redo"}),m(Ae,{variant:"neutral",onClick:()=>ht(s,e.get().scene),title:"Double-click empty space",attrs:{"data-t2d-fit":"1"},children:"Fit view"}),m("span",{className:"t2d-toolbar-hint","data-t2d-hint":!0,children:h})]}),F("div",{className:"t2d-main",children:[F("aside",{className:"t2d-side",children:[m(wi,{store:e,engine:s,units:a}),m(Ai,{store:e,ws:r}),m(Ui,{store:e,ws:r}),m(ki,{store:e,engine:s,units:a}),m(Pi,{store:e})]}),F("div",{className:"t2d-stage",children:[n?m("div",{className:"t2d-banner",children:m(kt,{reason:`The saved tunnel could not be read (${n}), so a new one was started.`,role:"alert"})}):null,f==="conflict"||f==="failed"?m("div",{className:"t2d-banner","data-t2d-save-problem":!0,children:m(kt,{reason:f==="conflict"?y:`The tunnel could not be saved: ${y}`,role:"alert"})}):null,c?m("div",{className:"t2d-banner","data-t2d-unstable":!0,children:m(kt,{reason:"The flow became unstable and was stopped.",fix:{label:"Reset flow",onFix:g},role:"alert"})}):null,m(_i,{engine:s,store:e,onStatus:d}),m(Ni,{engine:s,store:e}),m(Gi,{engine:s,store:e})]}),m("aside",{className:"t2d-side t2d-side--right",children:p?m(Ti,{store:e,ws:r,units:a,rake:p}):m(Si,{store:e,ws:r,units:a,engine:s})})]})]})}const Oi=400,Qs=r=>`studies/${r}/scene.json`;async function Ii(r,e){const s=Qs(e),t=await r.files.stat(s);if(!t)return{scene:dt(),etag:null,problem:""};const n=await r.files.read(s);if(!n)return{scene:dt(),etag:null,problem:""};try{return{scene:zn(JSON.parse(new TextDecoder().decode(n))),etag:t.etag,problem:""}}catch(a){return{scene:dt(),etag:t.etag,problem:a instanceof Error?a.message:String(a)}}}class Vi{constructor(e,s,t,n){this.ws=e,this.store=s,this.studyId=t,this.etag=n}timer=null;latest=null;writing=null;schedule(e){this.store.get().save!=="conflict"&&(this.latest=e,this.store.setSave("pending"),this.ws.nav.setDirty(!0,"The tunnel’s last changes are not saved yet."),this.timer&&clearTimeout(this.timer),this.timer=setTimeout(()=>void this.flush(),Oi))}async flush(){this.timer&&clearTimeout(this.timer),this.timer=null,this.writing&&await this.writing;const e=this.latest;e&&(this.latest=null,this.store.setSave("saving"),this.writing=(async()=>{try{const s=await this.ws.files.write(Qs(this.studyId),JSON.stringify(e,null,1),{ifMatch:this.etag});this.etag=s.etag,this.latest||(this.store.setSave("saved"),await this.ws.nav.setDirty(!1))}catch(s){s?.code==="changed"?(this.store.setSave("conflict","This tunnel was saved from another tab. Reopen it to see that version; changes here are not saved."),await this.ws.nav.setDirty(!1)):(this.latest=this.latest??e,this.store.setSave("failed",s instanceof Error?s.message:String(s)))}finally{this.writing=null}})(),await this.writing)}async create(e){this.latest=e,await this.flush()}}function Wi(r,e,s,t,n=.3){const a=2/(s*s*t),i=r.length,l=Math.floor(i*(1-n));let o=0;for(let p=l;p<i;p++)o+=e[p]*a;o/=i-l;const c=[];for(let p=l+1;p<i;p++){const b=e[p-1]*a-o,g=e[p]*a-o;b<0&&g>=0&&c.push(p-1+b/(b-g))}let u=-1/0,h=0,d=-1/0;for(let p=l;p<i;p++)u=Math.max(u,r[p]*a),h+=r[p]*a,d=Math.max(d,e[p]*a);const f=c.length-1,y=f>0?(c[c.length-1]-c[0])/f:NaN;return{St:t/(y*s),cdMax:u,cdMean:h/(i-l),clMax:d,periods:f}}async function ji(r,e=20,s=200,t,n=!1){const a=Math.round(4.1*e),i=22*e,l=.05,o=2/3*l,c=o*e/100,u=new je(r,{nx:i,ny:a,walls:"noslip",profile:1,absorbing:!1});u.setPhysics({u:l,tau:3*c+.5,smagorinsky:!1,smagCs:0}),u.reset(0);const h=We({kind:"circle",diameter:e}),d=it(h),f={x:2*e,y:-.5+2*e,theta:0};u.setBodies([{key:"cyl",sdf:d,from:f,to:f}]);let y=null;const p=2*c;if(n){const k={ox:Math.round(1*e),oy:Math.round(.6*e),wc:Math.round(4*e),hc:Math.round(2.8*e)},R=new je(r,{nx:2*k.wc+1,ny:2*k.hc+1,walls:"noslip",patch:!0});R.setPhysics({u:l,tau:3*p+.5,smagorinsky:!1,smagCs:0,nuMol:p,nuFloor:0}),R.reset(0);const T={x:2*(f.x-k.ox),y:2*(f.y-k.oy),theta:0};R.setBodies([{key:"cylf",sdf:it(We({kind:"circle",diameter:2*e})),from:T,to:T}]),y=new Vs(r,u,R,k,0),u.setPatches([y]),u.setPhysics({u:l,tau:3*c+.5,smagorinsky:!1,smagCs:0})}const b=Math.ceil(s*e/o),g=new Float64Array(b),S=new Float64Array(b),P=performance.now();let x=0,v=0;const M=Math.ceil(2*e/o);for(let k=0;k<b;){const R=Math.min(u.maxFrameSteps,b-k,k<M?200:ve),T=k<M?.5*(1-Math.cos(Math.PI*k/M)):1;u.setPhysics({u:l*T,tau:3*c+.5,smagorinsky:!1,smagCs:0}),y?.fine.setPhysics({u:l*T,tau:3*p+.5,smagorinsky:!1,smagCs:0,nuMol:p,nuFloor:0});const w=r.createCommandEncoder();u.encodeFrame(w,R,{mode:1,uRef:l,lRef:e});const E=u.prepareRead(w,R),B=y?y.fine.prepareRead(w,2*R):null;r.queue.submit([w.finish()]);const C=await E(),U=B?await B():null;if(!C||B&&!U)throw new Error("The force readback failed.");for(let A=0;A<R;A++)if(U){const D=U.forces[0].perStep;g[k+A]=(D[4*A]+D[4*A+2])/4,S[k+A]=(D[4*A+1]+D[4*A+3])/4}else g[k+A]=C.forces[0].perStep[2*A],S[k+A]=C.forces[0].perStep[2*A+1];if(x+=C.bad+(U?.bad??0),v+=C.limited+(U?.limited??0),k+=R,x)break}u.destroy();const $=Wi(g,S,o,e);return{N:e,steps:b,seconds:(performance.now()-P)/1e3,...$,bad:x,limited:v}}const ms=Math.exp(-Le*ks);function Xi(r){let e=Math.min(Math.sqrt(Math.max(r,0)),45);for(let s=0;s<40;s++){const t=Le*e,n=Math.exp(t),a=e+ms*(n-1-t-.5*t*t-t*t*t/6),i=1+ms*Le*(n-1-t-.5*t*t),l=Math.max(e-(a*e-r)/(i*e+a),1e-4);if(Math.abs(l-e)<1e-10*e)return l;e=l}return e}function It(r,e,s){const t=Math.min(Math.max(e,0),r.nx-1.001),n=Math.min(Math.max(s,0),r.ny-1.001),a=Math.floor(t),i=Math.floor(n),l=t-a,o=n-i;let c=0,u=0,h=0,d=0;for(let f=0;f<4;f++){const y=f&1,p=f>>1,b=(i+p)*r.nx+a+y;if(r.mac[4*b+3]>.5)continue;const g=(y?l:1-l)*(p?o:1-o);c+=g*r.mac[4*b],u+=g*r.mac[4*b+1],h+=g*r.mac[4*b+2],d+=g}return d<1e-6?null:{ux:c/d,uy:u/d,rho:h/d}}function Yi(r,e,s){const t=.5*s.rho*s.u*s.u,n=e.length/2,a=[];let i=0,l=0,o=0,c=0;for(let h=0;h<n;h++){const d=e[2*h],f=e[2*h+1],y=e[2*((h+1)%n)],p=e[2*((h+1)%n)+1],b=Math.hypot(y-d,p-f);if(b<1e-9)continue;const g=Math.max(1,Math.ceil(b)),S=b/g,P=(y-d)/b,x=(p-f)/b,v=x,M=-P;for(let $=0;$<g;$++){const k=d+P*S*($+.5),R=f+x*S*($+.5),T=It(r,k+v,R+M),w=It(r,k+Ge*v,R+Ge*M);if(!T||!w)continue;const E=(T.rho-s.rho)/3;let B;const C=T.ux*P+T.uy*x,U=w.ux*P+w.uy*x;if(s.shear==="resolved"){const A=Ge,D=(A*A*C-U)/(A*A-A);B=T.rho*s.nu*D}else{const A=Math.abs(U),D=A>1e-12?A/Xi(Ge*A/s.nu):0;B=Math.sign(U)*T.rho*D*D}i+=-E*v*S,l+=-E*M*S,o+=B*P*S,c+=B*x*S,a.push({x:k,y:R,nx:v,ny:M,ds:S,cp:E/t,cf:B/t})}}const u=1/(t*s.lRef);return{panels:a,cxP:i*u,cyP:l*u,cxF:o*u,cyF:c*u,cx:(i+o)*u,cy:(l+c)*u}}function Ki(r,e,s,t,n,a,i){const l=-n,o=t,c=i.rho/3+.5*i.rho*i.u*i.u,u=.01*.5*i.rho*i.u*i.u,h=[0],d=[0];let f=-1;for(let P=.5;P<=a;P+=.5){const x=It(r,e+t*P,s+n*P);if(!x)return null;h.push(x.ux*l+x.uy*o),d.push(P);const v=x.rho/3+.5*x.rho*(x.ux*x.ux+x.uy*x.uy);if(P>=1&&v>=c-u){f=h.length-1;break}}if(f<1)return null;const y=Math.sign(h[f])||1,p=h.map(P=>P*y),b=p[f];let g=0,S=0;for(let P=1;P<=f;P++){const x=p[P-1]/b,v=p[P]/b,M=d[P]-d[P-1];g+=.5*M*(1-x+(1-v)),S+=.5*M*(x*(1-x)+v*(1-v))}return{ue:b,delta:d[f],dstar:g,theta:S,h:g/S}}function Hi(r,e,s){let t=0,n=0;const a=(f,y)=>{const p=4*(y*r.nx+f);return{ux:r.mac[p],uy:r.mac[p+1],rho:r.mac[p+2],solid:r.mac[p+3]>.5}},i=s.rho/3,l=(f,y,p,b)=>{const g=a(f,y);if(g.solid)return;const S=g.rho/3-i,P=g.ux*p+g.uy*b;t-=S*p+g.rho*g.ux*P,n-=S*b+g.rho*g.uy*P},o=Math.round(e.x0),c=Math.round(e.x1),u=Math.round(e.y0),h=Math.round(e.y1);for(let f=o;f<c;f++)l(f,u,0,-1),l(f,h,0,1);for(let f=u;f<h;f++)l(o,f,-1,0),l(c,f,1,0);const d=.5*s.rho*s.u*s.u*s.lRef;return{cd:t/d,cl:n/d}}function Qi(r,e,s=181,t=jt){const n=ws(Et(r,s).x,Et(r,s).y,t/e),a=[];for(let i=0;i<n.x.length;i++)a.push((n.x[i]-.25)*e,n.y[i]*e);return Wt(a)}function Zi(r,e,s=48){const t=4*e,n=e/2,a=[],i=-r/2+t,l=r/2-t;for(let o=0;o<=s;o++){const c=-Math.PI/2+Math.PI*o/s;a.push(l+t*Math.cos(c),n*Math.sin(c))}for(let o=0;o<=s;o++){const c=Math.PI/2+Math.PI*o/s;a.push(i+t*Math.cos(c),n*Math.sin(c))}return Wt(a)}async function ys(r,e,s){const t=e.u??st,n=t*e.lRef/e.re,a=t/(e.gridRe??Kt),i=Math.max(n,a),l=new je(r,{nx:e.nx,ny:e.ny,walls:e.walls??"farfield"}),o=e.turb==="sa";l.setPhysics({u:t,tau:3*i+.5,smagorinsky:!o&&i<zt,smagCs:nt,turb:e.turb,nuMol:n,nuFloor:a,bulkKeep:e.bulkKeep}),l.reset(t);const c=e.turb==="sa"?Ms:void 0,u=it(e.poly,c),h=-e.alpha*Math.PI/180,d={x:e.x,y:e.y,theta:h};l.setBodies([{key:"case",sdf:u,from:d,to:d}]);let f=null;const y=e.refine??0;if(y>0){const _={u:t,tau:3*i+.5,smagorinsky:!o&&i<zt,smagCs:nt,turb:e.turb,nuMol:n,nuFloor:a,bulkKeep:e.bulkKeep},z=Math.max(4,e.ny*.06),X=[];let Me=ze(e.poly,d),ne={x0:Math.ceil(e.nx*.05)+6,y0:Math.ceil(z)+6,x1:Math.floor(e.nx*.85)-6,y1:Math.floor(e.ny-z)-6},ae=e.lRef;for(let de=0;de<y;de++){const Y=e.refineMargin??1,oe=de===0?{ahead:.3*Y,side:.3*Y,behind:.7*Y}:{ahead:.12*Y,side:.12*Y,behind:.3*Y},Z=ei(Me,ae,oe,ne);X.push(Z),Me=Me.map((fe,$e)=>2*(fe-($e%2?Z.oy:Z.ox))),ae*=2,ne={x0:6,y0:6,x1:2*Z.wc-6,y1:2*Z.hc-6}}f=new Ws(r,l,X,_),f.setBodies([{key:"case",local:e.poly,band:c,from:d,to:d}])}const p=e.lRef/t,b=Math.ceil(e.tstar*p),g=Math.floor(b*(1-(e.tail??.25)));let S=0,P=0,x=0,v=0,M=0,$=1/0,k=-1/0,R=1/0,T=-1/0;const w=[];let E=0,B=0,C=0;const U=.5*t*t*e.lRef,A=performance.now();for(let _=0;_<b;){const z=Math.min(l.maxFrameSteps,b-_),X=r.createCommandEncoder();l.encodeFrame(X,z,{mode:1,uRef:t,lRef:e.lRef});const Me=l.prepareRead(X,z),ne=f?f.prepareRead(X,z):null;r.queue.submit([X.finish()]);const ae=await Me(),de=ne?await ne():null;if(!ae||ne&&!de)throw new Error("The force readback failed.");const Y=de??ae;S+=ae.bad+(de?.bad??0),P+=ae.limited+(de?.limited??0);for(let oe=0;oe<z;oe++){const Z=Y.forces[0].perStep[2*oe]/U,fe=Y.forces[0].perStep[2*oe+1]/U;E+=Z,B+=fe,C++,_+oe>=g&&(x+=Z,v+=fe,M++,$=Math.min($,Z),k=Math.max(k,Z),R=Math.min(R,fe),T=Math.max(T,fe)),(_+oe+1)%Math.round(p)===0&&(w.push([(_+oe+1)/p,E/C,B/C]),E=0,B=0,C=0)}if(_+=z,S)break}await r.queue.onSubmittedWorkDone();const D=(performance.now()-A)/1e3,{mac:j,aux:W}=await l.readFields();let I=null;if(f){const _=r.createCommandEncoder();f.finest.encodeField(_,{mode:1,uRef:t,lRef:e.lRef*f.scale}),r.queue.submit([_.finish()]);const z=await f.finest.readFields();I={nx:f.finest.nx,ny:f.finest.ny,mac:z.mac,k:f.scale,pose:f.poseAt(f.levels.length-1,d)},f.destroy()}const q=j;l.destroy();const H=Math.round(e.nx*.08),he=[];for(let _=Math.round(e.ny*.2);_<Math.round(e.ny*.8);_++)he.push(q[4*(_*e.nx+H)+2]);he.sort((_,z)=>_-z);const Fe=he[Math.floor(he.length/2)]??1,Re=ze(e.poly,d),ee=I?.k??1,Ce=I?ze(e.poly,I.pose,ee):Re,Ee=I?{nx:I.nx,ny:I.ny,mac:I.mac}:{nx:e.nx,ny:e.ny,mac:q},re=Yi(Ee,Ce,{u:t,rho:Fe,lRef:e.lRef*ee,shear:e.turb==="off"?"resolved":"wall",nu:(e.turb==="off"?i:n)*ee});let Ye;if(e.blStations){const _=Ee,z=Math.cos(-h),X=Math.sin(-h),Me=I?.pose.x??e.x,ne=I?.pose.y??e.y,ae=re.panels.map(Y=>{const oe=(Y.x-Me)/ee,Z=(Y.y-ne)/ee;return{p:Y,xc:(z*oe-X*Z-(e.leX??0))/e.lRef,yc:(X*oe+z*Z)/e.lRef}}),de=(Y,oe)=>{const Z=ae.filter(Ke=>oe?Ke.yc>0:Ke.yc<=0);if(!Z.length)return null;const fe=Z.reduce((Ke,Ht)=>Math.abs(Ht.xc-Y)<Math.abs(Ke.xc-Y)?Ht:Ke,Z[0]),$e=Ki(_,fe.p.x,fe.p.y,fe.p.nx,fe.p.ny,.25*e.lRef*ee,{rho:Fe,u:t}),wt=e.lRef*ee;return $e?{...$e,delta:$e.delta/wt,dstar:$e.dstar/wt,theta:$e.theta/wt,ue:$e.ue/t}:null};Ye=e.blStations.map(Y=>({xc:Y,upper:de(Y,!0),lower:de(Y,!1)}))}const Js=[.25,.5,1].map(_=>{const z=_*e.lRef,X=Re.reduce((ne,ae,de)=>de%2?{...ne,y0:Math.min(ne.y0,ae),y1:Math.max(ne.y1,ae)}:{...ne,x0:Math.min(ne.x0,ae),x1:Math.max(ne.x1,ae)},{x0:1/0,y0:1/0,x1:-1/0,y1:-1/0}),Me={x0:Math.max(e.nx*.06,X.x0-z),x1:Math.min(e.nx*.84,X.x1+z),y0:Math.max(e.ny*.07,X.y0-z),y1:Math.min(e.ny*.93,X.y1+z)};return{margin:_,...Hi({nx:e.nx,ny:e.ny,mac:q},Me,{rho:Fe,u:t,lRef:e.lRef})}});let vt=0;const ke={macNaN:0,auxNaN:0,z:[1/0,-1/0],w:[1/0,-1/0],rhoInf:Fe,panels:re.panels.length};for(let _=0;_<e.nx*e.ny;_++)Number.isFinite(q[4*_+2])||ke.macNaN++;if(W)for(let _=0;_<e.nx*e.ny;_++){const z=W[4*_+2],X=W[4*_+3];if(!Number.isFinite(z)||!Number.isFinite(X)){ke.auxNaN++;continue}ke.z=[Math.min(ke.z[0],z),Math.max(ke.z[1],z)],ke.w=[Math.min(ke.w[0],X),Math.max(ke.w[1],X)],X>=0&&(vt=Math.max(vt,z/n))}return console.log("R1 diag",JSON.stringify(ke)),{steps:b,seconds:D,mlups:e.nx*e.ny*b/D/1e6,bad:S,limited:P,cd:M?x/M:NaN,cl:M?v/M:NaN,cdSpread:k-$,clSpread:T-R,surface:{cd:re.cx,cl:re.cy,cdP:re.cxP,cdF:re.cxF,clP:re.cyP,clF:re.cyF},history:w,panels:I?re.panels.map(_=>({..._,x:e.x+(_.x-I.pose.x)/ee,y:e.y+(_.y-I.pose.y)/ee,ds:_.ds/ee})):re.panels,rhoInf:Fe,nuMol:n,nuFloor:a,nutMax:vt,boxes:Js,bl:Ye,fields:e.dump?{nx:e.nx,ny:e.ny,mac:Array.from(q),aux:W?Array.from(W):null}:void 0}}function Ji(r){const e=r.up??4,s=r.down??8,t=r.half??4;return{poly:Qi(r.code,r.chord,181,r.teMin??jt),lRef:r.chord,re:r.re,turb:r.turb,x:e*r.chord+(r.offset??0),y:t*r.chord+(r.offset??0),alpha:r.alpha,nx:Math.round((e+s)*r.chord),ny:Math.round(2*t*r.chord),tstar:r.tstar??12,gridRe:r.gridRe,dump:r.dump,bulkKeep:r.bulkKeep,u:r.u,walls:r.walls,blStations:r.blStations,refine:r.refine,refineMargin:r.refineMargin,leX:-.25*r.chord}}function er(r){const e=r.length;return{poly:Zi(e,r.thickness??6),lRef:e,re:r.re,turb:r.turb,x:.3*e+e/2,y:Math.round(.2*e)+(r.yOffset??.3),alpha:0,nx:Math.round(1.9*e),ny:Math.round(.4*e),tstar:r.tstar??3,gridRe:r.gridRe,dump:r.dump,bulkKeep:r.bulkKeep,u:r.u}}function tr({store:r,engine:e,device:s}){window.__TUNNEL__={ready:!0,scene:()=>r.get().scene,selected:()=>r.get().selected,save:()=>r.get().save,stats:()=>({...e.stats,map:e.lattice,unstableAt:e.unstableAt,limitedTotal:e.limitedTotal}),view:()=>({...e.worldView}),livePose:t=>e.livePose(t),bodyLive:t=>e.bodyLive(t),sampleField:async()=>{const t=await e.sampleField();return t?Array.from(t,n=>Number.isFinite(n)?n:null):null},toScreen:(t,n)=>{const a=e.worldView,i=e.canvas.getBoundingClientRect();return{x:i.left+a.w/2+(t-a.cx)/a.mpp,y:i.top+a.h/2-(n-a.cy)/a.mpp}},turnHandle:t=>{const n=r.get().scene.bodies.find(l=>l.id===t);if(!n)return null;const a=e.canvas.getBoundingClientRect(),i=Ks(e,n);return{x:a.left+i.x,y:a.top+i.y,cx:a.left+i.cx,cy:a.top+i.cy}},validate:(t=20,n=200,a=!1)=>ji(s,t,n,void 0,a),validateAirfoil:t=>ys(s,Ji(t)),validatePlate:t=>ys(s,er(t)),particles:async()=>{const t=await e.readParticles();if(!t)return null;const n=r.get().scene,a=t.dx,i=n.bodies.filter(d=>d.enabled).map(d=>({b:d,poly:Ne(d,e.livePose(d.id)??{x:d.x,y:d.y,angle:d.angle})}));let l=0,o=0,c=0;const u=[],h=t.pools.map(d=>({id:d.id,alive:0,maxX:-1/0}));for(let d=0;d<t.meta.length/4;d++){if(t.meta[4*d+3]<.5||t.meta[4*d]<0)continue;const f=(t.pos[4*d]+.5)*a,y=(t.pos[4*d+1]+.5)*a;if(!Number.isFinite(f)||!Number.isFinite(y)){o++;continue}const p=t.meta[4*d+1];if(p<0)l++;else{const b=h[p];b&&(b.alive++,b.maxX=Math.max(b.maxX,f))}for(const{poly:b}of i)pt(b,f,y)&&Pt(b,f,y)<-.5*a&&(c++,u.length<6&&u.push({x:f,y,depthCells:Pt(b,f,y)/a,age:t.meta[4*d],src:t.meta[4*d+1],prevX:(t.pos[4*d+2]+.5)*a,prevY:(t.pos[4*d+3]+.5)*a}))}return{tracers:t.tracers,tracersAlive:l,nan:o,inside:c,insideAt:u,pools:h}},dye:async()=>{const t=await e.readDye();if(!t)return null;const n=[0,0,0,0],a=[-1/0,-1/0,-1/0,-1/0],l=r.get().scene.bodies.filter(c=>c.enabled).map(c=>Ne(c,e.livePose(c.id)??{x:c.x,y:c.y,angle:c.angle}));let o=0;for(const c of l){let u=1/0,h=-1/0,d=1/0,f=-1/0;for(let y=0;y<c.length;y+=2)u=Math.min(u,c[y]),h=Math.max(h,c[y]),d=Math.min(d,c[y+1]),f=Math.max(f,c[y+1]);for(let y=Math.max(0,Math.floor(d/t.dx));y<=Math.min(t.ny-1,Math.ceil(f/t.dx));y++)for(let p=Math.max(0,Math.floor(u/t.dx));p<=Math.min(t.nx-1,Math.ceil(h/t.dx));p++){const b=(p+.5)*t.dx,g=(y+.5)*t.dx;if(pt(c,b,g)&&Pt(c,b,g)<-t.dx){const S=y*t.nx+p;o+=t.data[4*S]+t.data[4*S+1]+t.data[4*S+2]+t.data[4*S+3]}}}for(let c=0;c<t.nx*t.ny;c++)for(let u=0;u<4;u++){const h=t.data[4*c+u];h>.05&&(n[u]+=h,a[u]=Math.max(a[u],(c%t.nx+.5)*t.dx))}return{channels:t.channels,sums:n,maxX:a,insideSum:o}},streamlines:()=>e.streamlineCount,refine:()=>e.refineInfo(),rheo:()=>e.readRheo()}}function sr(){return[...$n(),{label:"particles advect",code:Es()},{label:"particles draw",code:_s()},{label:"trail fade",code:Gs},{label:"rake lines",code:Ds()},{label:"dye advect",code:Us()},{label:"dye correct",code:Ts()},{label:"dye inject",code:Fs()},{label:"streamlines trace",code:qs},{label:"streamlines draw",code:zs},{label:"rheoscopic",code:Ns()},...Jn()]}async function nr(r){for(const e of sr()){const t=(await r.createShaderModule({code:e.code,label:e.label}).getCompilationInfo()).messages.find(n=>n.type==="error");if(t)return`${e.label} shader, line ${t.lineNum}: ${t.message}`}return null}const ir=document.getElementById("t2d-root"),Zs=on(ir);function Oe(r,e){Zs.render(et("div",{className:"t2d-fatal",role:"alert","data-t2d-fatal":"1"},et(rn,null,et("strong",null,r),et("p",null,e))))}function J(r){const e=getComputedStyle(document.documentElement).getPropertyValue(r).trim(),s=document.createElement("canvas").getContext("2d");s.fillStyle=e||"black";const t=s.fillStyle;if(t.startsWith("#"))return[parseInt(t.slice(1,3),16)/255,parseInt(t.slice(3,5),16)/255,parseInt(t.slice(5,7),16)/255];const n=/rgba?\(([^)]+)\)/.exec(t),a=n?n[1].split(",").map(Number):[0,0,0];return[a[0]/255,a[1]/255,a[2]/255]}async function rr(){let r;try{r=await en({timeoutMs:15e3})}catch(p){Oe("The wind tunnel could not start",`${p instanceof Error?p.message:String(p)}. Open the tunnel from its project in Magnusim.`);return}if(!("gpu"in navigator)||!navigator.gpu){Oe("This wind tunnel needs WebGPU","This browser does not offer WebGPU (navigator.gpu is missing), and the tunnel solves the flow on the GPU with it. Open Magnusim in a current Chrome or Edge on a computer with a GPU driver from the last few years.");return}const e=await navigator.gpu.requestAdapter({powerPreference:"high-performance"}).catch(()=>null);if(!e){Oe("This wind tunnel needs WebGPU","The browser offers WebGPU but found no GPU it can use (requestAdapter gave none). Check that hardware acceleration is on in the browser’s settings and that the graphics driver is up to date.");return}let s;try{s=await e.requestDevice({requiredLimits:{maxStorageBufferBindingSize:e.limits.maxStorageBufferBindingSize,maxBufferSize:e.limits.maxBufferSize,maxStorageBuffersPerShaderStage:Math.min(e.limits.maxStorageBuffersPerShaderStage,16)}})}catch(p){Oe("The GPU could not be opened",String(p));return}const t=await nr(s);if(t){Oe("The wind tunnel’s GPU code did not compile on this GPU",`${t}. Please report this with the GPU’s name (${e.info?.vendor??""} ${e.info?.architecture??""}).`);return}const n=e.info,a=n?.description||[n?.vendor,n?.architecture].filter(Boolean).join(" ")||"GPU";s.lost.then(p=>{p.reason!=="destroyed"&&Oe("The GPU stopped the wind tunnel",`${p.message||"The GPU device was lost"}. Leave the tunnel and open it again; the scene is saved.`)});const i=r.context.study,l=await Ii(r,i.id),o=new gi(l.scene),c=new Vi(r,o,i.id,l.etag);l.etag||await c.create(l.scene);const u={bg:J("--t2d-bg"),body:J("--t2d-body"),edge:J("--t2d-edge"),zone:[...J("--t2d-zone"),.14],plain:J("--t2d-plain"),arrow:[...J("--t2d-arrow"),.85]},h=document.createElement("canvas"),d=new xi(s,h,a,u),f=p=>{const b=16*Math.PI/180,g=p*Math.PI/180;return[Math.cos(b)*Math.cos(g),Math.cos(b)*Math.sin(g),Math.sin(b)]},y=(p,b,g,S,P)=>({base:J(`--t2d-rheo-${p}-base`),l1:{dir:f(135),color:J(`--t2d-rheo-${p}-light1`),diffuse:b},l2:{dir:f(-45),color:J(`--t2d-rheo-${p}-light2`),diffuse:g},sharp:S,glint:P});d.rheoLooks={kalliroscope:y("kalliroscope",.16,.12,12,1.8),pearl:y("pearl",.18,.14,12,1.6),copper:y("copper",.17,.12,10,1.8)},d.bodyLook={body:J("--t2d-body-dark"),edge:J("--t2d-edge-light")},d.markerColors={tracerDark:[...J("--t2d-particle-dark"),.5],tracerLight:[...J("--t2d-particle-light"),.85],rakes:[1,2,3,4,5,6].map(p=>[...J(`--mg-series-${p}`),.85]),rakesOnDark:[1,2,3,4,5,6].map(p=>{const b=J(`--mg-series-${p}`);return[b[0]+(1-b[0])*.35,b[1]+(1-b[1])*.35,b[2]+(1-b[2])*.35,.85]}),streamline:[...J("--t2d-streamline"),.4],streamlineLight:[...J("--t2d-particle-light"),.35]},o.onSceneChange=p=>{c.schedule(p),d.setScene(p)},await d.setScene(l.scene),d.start(),tr({store:o,engine:d,device:s}),window.addEventListener("pagehide",()=>void c.flush()),Zs.render(et(Li,{ws:r,store:o,engine:d,units:r.context.units,problem:l.problem}))}rr();
