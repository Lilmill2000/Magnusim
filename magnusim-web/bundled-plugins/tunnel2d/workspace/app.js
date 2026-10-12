import{connect as as}from"@magnusim/workspace";import{colormapRgb as rs,Field as U,NumberUnitInput as ce,Select as J,Hint as H,Button as le,Icon as Ge,Toggle as ge,fromSi as os,DisabledReason as Xe,ColorLegend as ls,EmptyState as cs}from"@magnusim/plugin-ui";import{useSyncExternalStore as ds,useState as se,useEffect as Q,useRef as ve,createElement as Ae}from"react";import{createRoot as us}from"react-dom/client";import{jsxs as C,jsx as p,Fragment as je}from"react/jsx-runtime";const Ct={1:[.058,361.4],2:[.126,51.64],3:[.2025,15.957],4:[.29,6.643],5:[.391,3.23]},Tt={2:[.13,51.99,764e-6],3:[.217,15.793,.00677],4:[.318,6.52,.0303],5:[.441,3.191,.1355]},pt=20,mt=250,hs=81;class de extends Error{}const fs=/^\s*(?:naca\s*)?(\d{4,5})\s*$/i;function dt(n){const e=fs.exec(String(n??""));if(!e)throw new de("Enter a NACA 4-digit or 5-digit designation, such as 2412 or 23012.");const s=e[1];return s.length===4?ps(s):ms(s),s}const oe=(n,e)=>Number(n[e]);function ps(n){const e=oe(n,0),s=oe(n,1);if(Number(n.slice(2))<=0)throw new de(`NACA ${n}: the thickness (last two digits) must be above 0.`);if(e===0!=(s===0))throw new de(`NACA ${n}: camber and its position must both be 0 or both be above 0.`)}function ms(n){const e=oe(n,0),s=oe(n,1),t=oe(n,2);if(Number(n.slice(3))<=0)throw new de(`NACA ${n}: the thickness (last two digits) must be above 0.`);if(e===0)throw new de(`NACA ${n}: the first digit (design lift) must be above 0.`);if(t!==0&&t!==1)throw new de(`NACA ${n}: the third digit must be 0 (standard) or 1 (reflexed).`);const i=t?Tt:Ct;if(!(s in i)){const r=Object.keys(i).sort().join(", ");throw new de(`NACA ${n}: a ${t?"reflexed":"standard"} 5-digit mean line has its second digit in ${r}.`)}}function ys(n,e,s){const t=s?-.1036:-.1015;return 5*e*(.2969*Math.sqrt(n)-.126*n-.3516*n**2+.2843*n**3+t*n**4)}function gs(n,e){const s=oe(n,0)/100,t=oe(n,1)/10;return s===0?[0,0]:e<t?[s/t**2*(2*t*e-e**2),2*s/t**2*(t-e)]:[s/(1-t)**2*(1-2*t+2*t*e-e**2),2*s/(1-t)**2*(t-e)]}function xs(n,e){const s=oe(n,0),t=oe(n,1),a=oe(n,2),i=3*s/20/.3;if(!a){const[d,u]=Ct[t];return e<d?[i*(u/6*(e**3-3*d*e**2+d**2*(3-d)*e)),i*(u/6*(3*e**2-6*d*e+d**2*(3-d)))]:[i*(u*d**3/6*(1-e)),i*(-u*d**3/6)]}const[r,l,o]=Tt[t],c=o*(1-r)**3;return e<r?[i*(l/6*((e-r)**3-c*e-r**3*e+r**3)),i*(l/6*(3*(e-r)**2-c-r**3))]:[i*(l/6*(o*(e-r)**3-c*e-r**3*e+r**3)),i*(l/6*(3*o*(e-r)**2-c-r**3))]}function yt(n){const e=Math.round(n*1e10)/1e10;return e===0?0:e}function bs(n,e=hs,s=!1){const t=dt(n),a=Math.trunc(e);if(!(a>=pt&&a<=mt))throw new de(`Points per side must be from ${pt} to ${mt}.`);const i=Number(t.slice(-2))/100,r=t.length===4?gs:xs,l=[],o=[];for(let d=0;d<a;d++){const u=Math.PI*d/(a-1),h=.5*(1-Math.cos(u)),f=ys(h,i,s),[g,m]=r(t,h),w=Math.atan(m);l.push([h-f*Math.sin(w),g+f*Math.cos(w)]),o.push([h+f*Math.sin(w),g-f*Math.cos(w)])}const c=[...l.reverse(),...o.slice(1)];return{code:t,name:`NACA ${t}`,x:c.map(d=>yt(d[0])),y:c.map(d=>yt(d[1]))}}function Et(n){let e=0;const s=n.length/2;for(let t=0;t<s;t++){const a=(t+1)%s;e+=n[2*t]*n[2*a+1]-n[2*a]*n[2*t+1]}return e/2}function vs(n){if(Et(n)>=0)return n;const e=[];for(let s=n.length/2-1;s>=0;s--)e.push(n[2*s],n[2*s+1]);return e}function ws(n){let e=1/0,s=1/0,t=-1/0,a=-1/0;for(let i=0;i<n.length;i+=2)e=Math.min(e,n[i]),t=Math.max(t,n[i]),s=Math.min(s,n[i+1]),a=Math.max(a,n[i+1]);return{x0:e,y0:s,x1:t,y1:a}}function it(n){let e=0;for(let s=0;s<n.length;s+=2)e=Math.max(e,Math.hypot(n[s],n[s+1]));return e}function Ut(n,e,s=1){const t=Math.cos(e.theta),a=Math.sin(e.theta),i=new Array(n.length);for(let r=0;r<n.length;r+=2){const l=n[r]*s,o=n[r+1]*s;i[r]=e.x+t*l-a*o,i[r+1]=e.y+a*l+t*o}return i}function Ne(n,e,s){let t=!1;const a=n.length/2;for(let i=0,r=a-1;i<a;r=i++){const l=n[2*i],o=n[2*i+1],c=n[2*r],d=n[2*r+1];o>s!=d>s&&e<(c-l)*(s-o)/(d-o)+l&&(t=!t)}return t}function ks(n,e,s,t,a,i){const r=a-s,l=i-t,o=r*r+l*l;let c=o>0?((n-s)*r+(e-t)*l)/o:0;return c=Math.max(0,Math.min(1,c)),Math.hypot(n-(s+c*r),e-(t+c*l))}function We(n,e,s){let t=1/0;const a=n.length/2;for(let i=0;i<a;i++){const r=(i+1)%a;t=Math.min(t,ks(e,s,n[2*i],n[2*i+1],n[2*r],n[2*r+1]))}return Ne(n,e,s)?-t:t}function Ps(n){const e=n.length/2,s=(t,a,i,r,l,o)=>(i-t)*(o-a)-(r-a)*(l-t);for(let t=0;t<e;t++){const a=(t+1)%e;for(let i=t+1;i<e;i++){const r=(i+1)%e;if(i===a||r===t)continue;const[l,o,c,d]=[n[2*t],n[2*t+1],n[2*a],n[2*a+1]],[u,h,f,g]=[n[2*i],n[2*i+1],n[2*r],n[2*r+1]],m=s(l,o,c,d,u,h),w=s(l,o,c,d,f,g),b=s(u,h,f,g,l,o),B=s(u,h,f,g,c,d);if(m*w<0&&b*B<0)return!0}}return!1}const Ms=256;function gt(n,e,s=Ms){const t=[];for(let a=0;a<s;a++){const i=2*Math.PI*a/s;t.push(n*Math.cos(i),e*Math.sin(i))}return t}function xt(n,e){return[-n/2,-e/2,n/2,-e/2,n/2,e/2,-n/2,e/2]}function bt(n,e,s){const t=[];for(let a=0;a<n.length;a++)t.push((n[a]-.25)*s,e[a]*s);return vs(t)}function Re(n){switch(n.kind){case"naca":{const e=bs(n.code,121);return bt(e.x,e.y,n.chord)}case"dat":return bt(n.x,n.y,n.chord);case"circle":return gt(n.diameter/2,n.diameter/2);case"ellipse":return gt(n.width/2,n.height/2);case"rect":return xt(n.width,n.height);case"plate":return xt(n.length,n.thickness)}}function we(n){switch(n.kind){case"naca":case"dat":return n.chord;case"circle":return n.diameter;case"ellipse":case"rect":return n.height;case"plate":return n.length}}function qe(n){switch(n.kind){case"naca":return`NACA ${n.code}`;case"dat":return n.name;case"circle":return"Cylinder";case"ellipse":return"Ellipse";case"rect":return"Rectangle";case"plate":return"Flat plate"}}const Bs=4,Ss=2,As=4e6;function Dt(n,e=Bs){const s=ws(n),t=e+2;let a=1/Ss,i=Math.ceil((s.x1-s.x0+2*t)/a)+1,r=Math.ceil((s.y1-s.y0+2*t)/a)+1;for(;i*r>As;)a*=1.5,i=Math.ceil((s.x1-s.x0+2*t)/a)+1,r=Math.ceil((s.y1-s.y0+2*t)/a)+1;const l=s.x0-t,o=s.y0-t,c=new Float32Array(i*r).fill(e),d=n.length/2;for(let f=0;f<d;f++){const g=n[2*f],m=n[2*f+1],w=n[2*((f+1)%d)],b=n[2*((f+1)%d)+1],B=Math.max(0,Math.floor((Math.min(g,w)-e-l)/a)),R=Math.min(i-1,Math.ceil((Math.max(g,w)+e-l)/a)),x=Math.max(0,Math.floor((Math.min(m,b)-e-o)/a)),v=Math.min(r-1,Math.ceil((Math.max(m,b)+e-o)/a)),k=w-g,S=b-m,M=k*k+S*S;for(let A=x;A<=v;A++){const P=o+A*a;for(let y=B;y<=R;y++){const $=l+y*a;let T=M>0?(($-g)*k+(P-m)*S)/M:0;T=T<0?0:T>1?1:T;const N=$-(g+T*k),D=P-(m+T*S),E=Math.sqrt(N*N+D*D),Z=A*i+y;E<c[Z]&&(c[Z]=E)}}}const u=[];for(let f=0;f<r;f++){const g=o+f*a;u.length=0;for(let m=0;m<d;m++){const w=n[2*m+1],b=n[2*((m+1)%d)+1];if(w>g!=b>g){const B=n[2*m],R=n[2*((m+1)%d)];u.push(B+(g-w)*(R-B)/(b-w))}}u.sort((m,w)=>m-w);for(let m=0;m+1<u.length;m+=2){const w=Math.max(0,Math.ceil((u[m]-l)/a)),b=Math.min(i-1,Math.floor((u[m+1]-l)/a));for(let B=w;B<=b;B++)c[f*i+B]=-c[f*i+B]}}let h=0;for(let f=0;f<d;f++)h=Math.max(h,Math.hypot(n[2*f],n[2*f+1]));return{data:c,w:i,h:r,ox:l,oy:o,texel:a,band:e,bound:h+1}}const Rs=new Uint8Array([0,0,4,1,0,5,1,1,6,1,1,8,2,1,10,2,2,12,2,2,14,3,2,16,4,3,18,4,3,20,5,4,23,6,4,25,7,5,27,8,5,29,9,6,31,10,7,34,11,7,36,12,8,38,13,8,41,14,9,43,16,9,45,17,10,48,18,10,50,20,11,52,21,11,55,22,11,57,24,12,60,25,12,62,27,12,65,28,12,67,30,12,69,31,12,72,33,12,74,35,12,76,36,12,79,38,12,81,40,11,83,41,11,85,43,11,87,45,11,89,47,10,91,49,10,92,50,10,94,52,10,95,54,9,97,56,9,98,57,9,99,59,9,100,61,9,101,62,9,102,64,10,103,66,10,104,68,10,104,69,10,105,71,11,106,73,11,106,74,12,107,76,12,107,77,13,108,79,13,108,81,14,108,82,14,109,84,15,109,85,15,109,87,16,110,89,16,110,90,17,110,92,18,110,93,18,110,95,19,110,97,19,110,98,20,110,100,21,110,101,21,110,103,22,110,105,22,110,106,23,110,108,24,110,109,24,110,111,25,110,113,25,110,114,26,110,116,26,110,117,27,110,119,28,109,120,28,109,122,29,109,124,29,109,125,30,109,127,30,108,128,31,108,130,32,108,132,32,107,133,33,107,135,33,107,136,34,106,138,34,106,140,35,105,141,35,105,143,36,105,144,37,104,146,37,104,147,38,103,149,38,103,151,39,102,152,39,102,154,40,101,155,41,100,157,41,100,159,42,99,160,42,99,162,43,98,163,44,97,165,44,96,166,45,96,168,46,95,169,46,94,171,47,94,173,48,93,174,48,92,176,49,91,177,50,90,179,50,90,180,51,89,182,52,88,183,53,87,185,53,86,186,54,85,188,55,84,189,56,83,191,57,82,192,58,81,193,58,80,195,59,79,196,60,78,198,61,77,199,62,76,200,63,75,202,64,74,203,65,73,204,66,72,206,67,71,207,68,70,208,69,69,210,70,68,211,71,67,212,72,66,213,74,65,215,75,63,216,76,62,217,77,61,218,78,60,219,80,59,221,81,58,222,82,56,223,83,55,224,85,54,225,86,53,226,87,52,227,89,51,228,90,49,229,92,48,230,93,47,231,94,46,232,96,45,233,97,43,234,99,42,235,100,41,235,102,40,236,103,38,237,105,37,238,106,36,239,108,35,239,110,33,240,111,32,241,113,31,241,115,29,242,116,28,243,118,27,243,120,25,244,121,24,245,123,23,245,125,21,246,126,20,246,128,19,247,130,18,247,132,16,248,133,15,248,135,14,248,137,12,249,139,11,249,140,10,249,142,9,250,144,8,250,146,7,250,148,7,251,150,6,251,151,6,251,153,6,251,155,6,251,157,7,252,159,7,252,161,8,252,163,9,252,165,10,252,166,12,252,168,13,252,170,15,252,172,17,252,174,18,252,176,20,252,178,22,252,180,24,251,182,26,251,184,29,251,186,31,251,188,33,251,190,35,250,192,38,250,194,40,250,196,42,250,198,45,249,199,47,249,201,50,249,203,53,248,205,55,248,207,58,247,209,61,247,211,64,246,213,67,246,215,70,245,217,73,245,219,76,244,221,79,244,223,83,244,225,86,243,227,90,243,229,93,242,230,97,242,232,101,242,234,105,241,236,109,241,237,113,241,239,117,241,241,121,242,242,125,242,244,130,243,245,134,243,246,138,244,248,142,245,249,146,246,250,150,248,251,154,249,252,157,250,253,161,252,255,164]),I=128,V=8,te=2048,ze=1048576,ee=te*V*2,Ye=ee+4,Me=.1,Be=.2,ae=[0,1,0,-1,0,1,-1,-1,1],pe=[0,0,1,0,-1,1,1,-1,-1],he=[4/9,1/9,1/9,1/9,1/9,1/36,1/36,1/36,1/36],$s=[0,3,4,1,2,7,8,5,6],Cs=[0,1,4,3,2,8,7,6,5],Ts={slip:0,noslip:1,periodic:2,farfield:3},F=n=>n.toFixed(10),X=n=>n.toFixed(1),Ie=`
struct Params {
  nx: u32, ny: u32, n: u32, nBodies: u32,
  omega: f32, smag: f32, uIn: f32, absorb: f32,
  absorbIn: f32, spongeX: f32, frameSteps: u32, profile: u32,
  farW: f32, p0: f32, p1: f32, p2: f32,
};
struct Body {
  c0: vec2f, c1: vec2f,
  a0: f32, a1: f32, bound: f32, texel: f32,
  org: vec2f, w: u32, h: u32,
  off: u32, p0: u32, p1: u32, p2: u32,
};
struct Hit { d: f32, b: u32 };

fn sdfLocal(b: u32, lp: vec2f) -> f32 {
  let bd = B[b];
  let uv = (lp - bd.org) / bd.texel;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > f32(bd.w - 1u) || uv.y > f32(bd.h - 1u)) { return 4.0; }
  let i = min(u32(uv.x), bd.w - 2u);
  let j = min(u32(uv.y), bd.h - 2u);
  let f = uv - vec2f(f32(i), f32(j));
  let k = bd.off + j * bd.w + i;
  return mix(mix(sdf[k], sdf[k + 1u], f.x), mix(sdf[k + bd.w], sdf[k + bd.w + 1u], f.x), f.y);
}

/** The nearest body's signed distance (cells) at p, over the bodies in the mask. */
fn sdfAt(p: vec2f, near: u32, bp: ptr<function, array<vec4f, ${V}>>) -> Hit {
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

/** A body's wall velocity (cells per step) at p: its translation and its turn. */
fn wallU(b: u32, p: vec2f, c: vec2f) -> vec2f {
  let bd = B[b];
  let fs = f32(P.frameSteps);
  let v = (bd.c1 - bd.c0) / fs;
  let w = (bd.a1 - bd.a0) / fs;
  return v + w * vec2f(-(p.y - c.y), p.x - c.x);
}

/** Each body's pose at fraction t of the frame (x, y, cos, sin) and the ones near p. */
fn poses(p: vec2f, t: f32, bp: ptr<function, array<vec4f, ${V}>>) -> u32 {
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
`,Oe=`
const CXF = array<f32, 9>(${ae.map(X).join(", ")});
const CYF = array<f32, 9>(${pe.map(X).join(", ")});
const WF = array<f32, 9>(${he.map(F).join(", ")});
`;function _t(){const n=(i,r)=>`fin[${i}u * P.n + ${r}]`,e=(i,r,l,o)=>`(${F(he[i])} * ${r} * (1.0 + 3.0 * (${X(ae[i])} * ${l} + ${X(pe[i])} * ${o}) + 4.5 * (${X(ae[i])} * ${l} + ${X(pe[i])} * ${o}) * (${X(ae[i])} * ${l} + ${X(pe[i])} * ${o}) - 1.5 * (${l} * ${l} + ${o} * ${o})))`;let s="";for(let i=1;i<9;i++){const r=$s[i],l=ae[i],o=pe[i];let c="";l>0&&(c=`if (x == 0u) { f${i} = 0.0; } else `),l<0&&(c=`if (x == P.nx - 1u) { f${i} = ${n(i,"idx")}; } else `);let d="";if(o!==0){const h=o>0?"y == 0u":"y == P.ny - 1u",f=o>0?"P.ny - 1u":"0u";d=`if (${h}) {
      if (WALLS == 1u) { f${i} = ${n(r,"idx")}; }
      else if (WALLS == 0u) { f${i} = ${n(Cs[i],`u32(i32(x) - (${l})) + y * P.nx`)}; }
      else if (WALLS == 3u) { f${i} = ${F(he[i])} * (1.0 + 3.0 * ${X(l)} * P.uIn + 4.5 * ${X(l*l)} * P.uIn * P.uIn - 1.5 * P.uIn * P.uIn); }
      else { f${i} = ${n(i,`u32(i32(x) - (${l})) + ${f} * P.nx`)}; }
    } else `}const u=`(${X(l)} * uw.x + ${X(o)} * uw.y)`;s+=`
  var f${i}: f32;
  ${c}${d}{
    let sx = i32(x) - (${l});
    let sy = i32(y) - (${o});
    let src = u32(sx) + u32(sy) * P.nx;
    var hit = Hit(4.0, 0u);
    if (near != 0u) { hit = sdfAt(vec2f(f32(sx), f32(sy)), near, &bp); }
    if (hit.d < 0.0) {
      // Bouzidi: direction ${r} leaves this cell into the body, q of the way to its wall.
      var q = clamp(d0 / (d0 - hit.d), 0.001, 1.0);
      let bx = i32(x) + (${l});
      let by = i32(y) + (${o});
      var behindFluid = bx >= 0 && by >= 0 && bx < i32(P.nx) && by < i32(P.ny);
      if (behindFluid && q < 0.5) { behindFluid = sdfAt(vec2f(f32(bx), f32(by)), near, &bp).d >= 0.0; }
      if (q < 0.5 && !behindFluid) { q = 0.5; }
      let c = bp[hit.b].xy;
      let uw = wallU(hit.b, vec2f(f32(sx), f32(sy)), c);
      let fi = ${n(r,"idx")};
      let mw = ${F(6*he[i])} * ${u};
      if (q < 0.5) { f${i} = 2.0 * q * fi + (1.0 - 2.0 * q) * ${n(r,"u32(bx) + u32(by) * P.nx")} + mw; }
      else { f${i} = fi / (2.0 * q) + (2.0 * q - 1.0) / (2.0 * q) * ${n(i,"idx")} + mw / (2.0 * q); }
      let slot = (S.slot * ${V}u + hit.b) * 2u;
      atomicAdd(&force[slot], i32(round((${X(ae[r])} * (fi + f${i}) - uw.x * (fi - f${i})) * ${ze}.0)));
      atomicAdd(&force[slot + 1u], i32(round((${X(pe[r])} * (fi + f${i}) - uw.y * (fi - f${i})) * ${ze}.0)));
    } else {
      f${i} = ${n(i,"src")};
    }
  }`}let t="";for(let i=0;i<9;i++)t+=`  let e${i} = ${e(i,"rho","ux","uy")};
`;const a=i=>`(f${i} - e${i})`;t+=`
  let pxx = ${[1,3,5,6,7,8].map(a).join(" + ")};
  let pyy = ${[2,4,5,6,7,8].map(a).join(" + ")};
  let pxy = ${a(5)} - ${a(6)} + ${a(7)} - ${a(8)};
  var tP = 1.0 / P.omega;
  if (SMAG) {
    let Q = sqrt(pxx * pxx + pyy * pyy + 2.0 * pxy * pxy);
    tP = 0.5 * (tP + sqrt(tP * tP + P.smag * Q / rho));
  }
  var sig = 0.0;
  if (xf > P.spongeX) { let r = (xf - P.spongeX) / (f32(P.nx) - P.spongeX); tP += r * r; sig = P.absorb * r * r; }
  if (xf < P.absorbIn) { let r = (P.absorbIn - xf) / P.absorbIn; sig = P.absorb * r * r; }
  if (WALLS == 3u) {
    // Open top and bottom: a band that relaxes to the free stream, so what reaches the
    // edge (sound, a wake) passes out instead of reflecting.
    let yb = min(f32(y), f32(P.ny - 1u) - f32(y));
    if (yb < P.farW) { let r = (P.farW - yb) / P.farW; sig = max(sig, P.absorb * r * r); }
  }
  let omP = 1.0 / tP;
  let axxy = 2.0 * ux * pxy + uy * pxx;
  let axyy = 2.0 * uy * pxy + ux * pyy;
  let keep = 1.0 - omP;
  // Bulk viscosity: the stress's trace (compression) relaxes fully every step while its
  // deviatoric part (shear) relaxes at omP. Sound waves (from dragged bodies, the start)
  // then die out within a few cells instead of ringing between the walls, and the
  // incompressible flow is unchanged (the Schafer-Turek check runs with it).
  let half = 0.5 * (pxx + pyy);
  let dxx = keep * (pxx - half) + KEEP_BULK * half;
  let dyy = keep * (pyy - half) + KEEP_BULK * half;
  let dxy = keep * pxy;
`;for(let i=0;i<9;i++){const r=ae[i],l=pe[i],o=r*r-1/3,c=l*l-1/3,d=r*l,u=r*r*l-l/3,h=r*l*l-r/3;t+=`  var o${i} = ${F(he[i])} * rho * (1.0 + 3.0 * (${F(r)} * ux + ${F(l)} * uy) + 4.5 * (${F(o)} * ux * ux + ${F(c)} * uy * uy + ${F(2*d)} * ux * uy) + 13.5 * (${F(u)} * ux * ux * uy + ${F(h)} * ux * uy * uy))
    + ${F(he[i])} * (4.5 * (${F(o)} * dxx + ${F(c)} * dyy + ${F(2*d)} * dxy) + 13.5 * keep * (${F(u)} * axxy + ${F(h)} * axyy));
`}return t+=`  if (sig > 0.0) {
    let uT = P.uIn;
${Array.from({length:9},(i,r)=>`    o${r} = mix(o${r}, ${F(he[r])} * (1.0 + 3.0 * ${X(ae[r])} * uT + 4.5 * ${X(ae[r]*ae[r])} * uT * uT - 1.5 * uT * uT), sig);`).join(`
`)}
  }
${Array.from({length:9},(i,r)=>`  fout[${r}u * P.n + idx] = o${r};`).join(`
`)}
`,`
override WALLS: u32 = 0u;
override SMAG: bool = false;
/** 1 - the bulk relaxation rate (0: the stress's trace fully relaxed each step). */
const KEEP_BULK = 0.0;
struct Step { slot: u32, p0: u32, p1: u32, p2: u32 };
@group(0) @binding(0) var<storage, read> fin: array<f32>;
@group(0) @binding(1) var<storage, read_write> fout: array<f32>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
@group(0) @binding(5) var<storage, read_write> force: array<atomic<i32>>;
@group(1) @binding(0) var<uniform> S: Step;
${Oe}
${Ie}

@compute @workgroup_size(${I})
fn step(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${I}u;
  if (idx >= P.n) { return; }
  let x = idx % P.nx;
  let y = idx / P.nx;
  let xf = f32(x);
  let p = vec2f(xf, f32(y));
  var bp: array<vec4f, ${V}>;
  let near = poses(p, f32(S.slot + 1u) / f32(P.frameSteps), &bp);
  var d0 = 4.0;
  if (near != 0u) {
    let h0 = sdfAt(p, near, &bp);
    d0 = h0.d;
    if (d0 < 0.0) {
      let uw = wallU(h0.b, p, bp[h0.b].xy);
      for (var k = 0u; k < 9u; k++) { fout[k * P.n + idx] = feqAt(k, 1.0, uw); }
      return;
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
    let r = (f0 + f2 + f4 + 2.0 * (f3 + f6 + f7)) / (1.0 - u);
    f1 = f3 + (2.0 / 3.0) * r * u;
    f5 = f7 - 0.5 * (f2 - f4) + (1.0 / 6.0) * r * u;
    f8 = f6 + 0.5 * (f2 - f4) + (1.0 / 6.0) * r * u;
  }
  if (x == P.nx - 1u) {
    let uo = -1.0 + (f0 + f2 + f4 + 2.0 * (f1 + f5 + f8));
    f3 = f1 - (2.0 / 3.0) * uo;
    f7 = f5 + 0.5 * (f2 - f4) - (1.0 / 6.0) * uo;
    f6 = f8 - 0.5 * (f2 - f4) - (1.0 / 6.0) * uo;
  }
  var rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
  if (!(rho > 0.5 && rho < 2.0)) {
    atomicAdd(&force[${ee}u], 1);
    atomicMax(&force[${ee+1}u], i32(P.n - idx));
  }
  var ux = (f1 - f3 + f5 - f6 - f7 + f8) / rho;
  var uy = (f2 - f4 + f5 + f6 - f7 - f8) / rho;
  // The limiter: flow squeezed in a gap two moving bodies close has nowhere to go. A cell
  // whose density leaves ±${Me*100} % or whose speed passes ${Be} (4 x the inflow) is put
  // back to equilibrium inside those bounds. Ordinary flow here stays within about 1 %, so
  // only such pockets are touched; each use is counted and the page says so.
  let usq0 = ux * ux + uy * uy;
  if (!(rho >= ${1-Me} && rho <= ${1+Me} && usq0 <= ${Be*Be})) {
    atomicAdd(&force[${ee+2}u], 1);
    let ok = rho == rho && ux == ux && uy == uy;
    rho = select(1.0, clamp(rho, ${1-Me}, ${1+Me}), ok);
    var uc = select(vec2f(0.0), vec2f(ux, uy), ok);
    let m = length(uc);
    if (m > ${Be}) { uc = uc * (${Be} / m); }
    ux = uc.x;
    uy = uc.y;
${Array.from({length:9},(i,r)=>`    f${r} = feqAt(${r}u, rho, uc);`).join(`
`)}
  }
${t}
}
`}function Gt(){return`
@group(0) @binding(0) var<storage, read> fin: array<f32>;
@group(0) @binding(1) var<storage, read_write> mac: array<vec4f>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
${Oe}
${Ie}

@compute @workgroup_size(${I})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${I}u;
  if (idx >= P.n) { return; }
  let p = vec2f(f32(idx % P.nx), f32(idx / P.nx));
  var bp: array<vec4f, ${V}>;
  let near = poses(p, 1.0, &bp);
  if (near != 0u) {
    let h = sdfAt(p, near, &bp);
    if (h.d < 0.0) {
      mac[idx] = vec4f(wallU(h.b, p, bp[h.b].xy), 1.0, 1.0);
      return;
    }
  }
  var rho = 0.0;
  var m = vec2f(0.0);
  for (var k = 0u; k < 9u; k++) {
    let f = fin[k * P.n + idx];
    rho += f;
    m += f * vec2f(CXF[k], CYF[k]);
  }
  mac[idx] = vec4f(m / rho, rho, 0.0);
}
`}function Nt(){return`
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

@compute @workgroup_size(${I})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${I}u;
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
`}function qt(){return`
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
${Oe}
${Ie}

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
  var bp: array<vec4f, ${V}>;
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
`}function Es(){return[{label:"step",code:_t()},{label:"macro",code:Gt()},{label:"field",code:Nt()},{label:"render",code:qt()}]}function zt(n){return n==="inferno"?Rs:rs(n)}class Us{device;ctx;format;pipe;viewBuf;lutBuf;lutName="";dummyBuf;dummyTex;constructor(e,s){this.device=e;const t=s.getContext("webgpu");if(!t)throw new Error("The canvas has no WebGPU context.");this.ctx=t,this.format=navigator.gpu.getPreferredCanvasFormat(),t.configure({device:e,format:this.format,alphaMode:"opaque"});const a=e.createShaderModule({code:qt(),label:"tunnel render"});this.pipe=e.createRenderPipeline({layout:"auto",vertex:{module:a,entryPoint:"vs"},fragment:{module:a,entryPoint:"fs",targets:[{format:this.format}]},primitive:{topology:"triangle-list"}}),this.viewBuf=e.createBuffer({size:304,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.lutBuf=e.createBuffer({size:256*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.dummyBuf=e.createBuffer({size:64,usage:GPUBufferUsage.STORAGE}),this.dummyTex=e.createTexture({size:[1,1],format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING})}setColormap(e){if(e===this.lutName)return;const s=zt(e),t=s.length/3,a=new Float32Array(256*4);for(let i=0;i<256;i++){const r=Math.min(t-1,Math.round(i/255*(t-1)));a[4*i]=s[3*r]/255,a[4*i+1]=s[3*r+1]/255,a[4*i+2]=s[3*r+2]/255,a[4*i+3]=1}this.device.queue.writeBuffer(this.lutBuf,0,a),this.lutName=e}get lut(){return this.lutBuf}get dummies(){return{scalar:this.dummyBuf,lut:this.lutBuf}}get size(){const e=this.ctx.getCurrentTexture();return{w:e.width,h:e.height}}encode(e,s,t,a,i,r,l){const o=s.buffers,c=this.device.createBindGroup({layout:this.pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:o.scalar}},{binding:1,resource:{buffer:this.viewBuf}},{binding:2,resource:{buffer:o.params}},{binding:3,resource:{buffer:o.bodies}},{binding:4,resource:{buffer:o.sdf}},{binding:5,resource:{buffer:this.lutBuf}},{binding:6,resource:{buffer:s.macroBuf}},{binding:7,resource:{buffer:r.dye??this.dummyBuf}},{binding:8,resource:(r.trail??this.dummyTex).createView()},{binding:9,resource:{buffer:r.rheo?.field??this.dummyBuf}}]}),d=(r.plain?1:0)|(r.arrows?2:0)|(r.dye?4:0)|(r.trail?8:0)|(r.rheo?16:0),u=new ArrayBuffer(304),h=new Float32Array(u),f=new Uint32Array(u);h.set([t.scale,t.ox,t.oy,a.lo,a.hi,s.nx,s.ny,s.absorbInX,s.spongeX,r.uRef,r.arrowCells]),f[11]=d,h.set([...i.bg,1],12),h.set([...i.body,1],16),h.set([...i.edge,1],20),h.set(i.zone,24),h.set([...i.plain,1],28),h.set(i.arrow,32);for(let m=0;m<4;m++)h.set(r.dyeColors[m]??[0,0,0,0],36+4*m);if(r.rheo){const m=r.rheo.look;h.set([...m.base,1],52),h.set([...m.l1.dir,0],56),h.set([...m.l1.color,m.l1.diffuse],60),h.set([...m.l2.dir,0],64),h.set([...m.l2.color,m.l2.diffuse],68),h.set([m.sharp,r.rheo.sparkle[0],r.rheo.sparkle[1],m.glint],72)}this.device.queue.writeBuffer(this.viewBuf,0,u);const g=e.beginRenderPass({colorAttachments:[{view:this.ctx.getCurrentTexture().createView(),loadOp:"clear",storeOp:"store",clearValue:{r:i.bg[0],g:i.bg[1],b:i.bg[2],a:1}}]});g.setPipeline(this.pipe),g.setBindGroup(0,c),g.draw(3),l?.(g),g.end()}destroy(){this.viewBuf.destroy(),this.lutBuf.destroy(),this.dummyBuf.destroy(),this.dummyTex.destroy(),this.ctx.unconfigure()}}const vt=256*1024,Ds=80,nt=10,at=1e3;class K extends Error{}function _s(n){const e=n.trim().split(/[\s,;]+/).filter(Boolean),s=[];for(const t of e){const a=Number(t.replace(/[Dd]/,"e"));if(t===""||Number.isNaN(a))return null;s.push(a)}return s}function Ke(n){return n.replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,Ds)}const rt=(n,e)=>n.flatMap((s,t)=>[s,e[t]]);function Gs(n,e=""){if(new TextEncoder().encode(n).length>vt)throw new K(`The file is larger than ${vt/1024} KB; an airfoil file is a few KB.`);const s=n.replace(/^﻿/,"").split(/\r\n|\r|\n/);let t="";const a=[];let i=!1;if(s.forEach((u,h)=>{const f=h+1,g=u.trim();if(!g||g.startsWith("#"))return;const m=_s(g);if(!i&&!t&&(m===null||m.length!==2)){t=Ke(g);return}if(m===null)throw new K(`Line ${f}: expected two numbers (x and y), found “${Ke(g).slice(0,40)}”.`);if(m.length!==2)throw new K(`Line ${f}: expected two numbers (x and y), found ${m.length}.`);if(!m.every(Number.isFinite))throw new K(`Line ${f}: the numbers must be finite.`);a.push([f,m[0],m[1]]),i=!0}),!t){const u=String(e||"").replace(/\\/g,"/").split("/").pop()?.replace(/\.[A-Za-z0-9]{1,4}$/,"")??"";t=Ke(u)||"Imported airfoil"}if(!a.length)throw new K("The file has no coordinates.");const r=[],l=a[0];let o,c,d;return l[1]>=2&&l[2]>=2&&Number.isInteger(l[1])&&Number.isInteger(l[2])?([o,c]=Ns(a,l[1],l[2]),d="lednicer",r.push("Read as a Lednicer file (upper and lower surfaces apart) and joined in Selig order.")):(o=a.map(u=>u[1]),c=a.map(u=>u[2]),d="selig"),[o,c]=qs(o,c,r),{name:t,x:o,y:c,layout:d,warnings:r}}function Ns(n,e,s){const t=n.slice(1);if(t.length!==e+s)throw new K(`Line ${n[0][0]}: the file says ${e} upper and ${s} lower points, but it has ${t.length} points.`);const a=t.slice(0,e),i=t.slice(e),r=a.map(d=>d[1]).reverse(),l=a.map(d=>d[2]).reverse();let o=i.map(d=>d[1]),c=i.map(d=>d[2]);return i.length&&a.length&&Math.abs(i[0][1]-a[0][1])<=1e-9&&Math.abs(i[0][2]-a[0][2])<=1e-9&&(o=o.slice(1),c=c.slice(1)),[[...r,...o],[...l,...c]]}function qs(n,e,s){let t=[n[0]],a=[e[0]],i=0;for(let f=1;f<n.length;f++){if(Math.abs(n[f]-t[t.length-1])<=1e-12&&Math.abs(e[f]-a[a.length-1])<=1e-12){i++;continue}t.push(n[f]),a.push(e[f])}if(i&&s.push(`Removed ${i} repeated point${i!==1?"s":""}.`),t.length<nt)throw new K(`The file has ${t.length} points; an airfoil needs at least ${nt}.`);if(t.length>at)throw new K(`The file has ${t.length} points; at most ${at} are read.`);const r=Math.min(...t),o=Math.max(...t)-r;if(o<=0)throw new K("Every point has the same x: this is not an airfoil.");const c=t.indexOf(r);if(c===0||c===t.length-1)throw new K("The points must start at the trailing edge, run over one surface to the leading edge and back along the other (Selig order).");if(Math.min(t[0],t[t.length-1])<r+.5*o)throw new K("The first and last points must be at the trailing edge (Selig order).");const d=t[c],u=a[c],h=Math.min(...t.map((f,g)=>Math.hypot(f,a[g])))<=.002;if((Math.abs(o-1)>.001||!h)&&(t=t.map(f=>(f-d)/o),a=a.map(f=>(f-u)/o),s.push(Math.abs(o-1)>.001?`Scaled to chord 1 (it was ${Number(o.toPrecision(6))}).`:"Moved so that the leading edge is at (0, 0).")),Et(rt(t,a))<0&&(t=t.reverse(),a=a.reverse(),s.push("The points ran over the lower surface first; reversed to Selig order (upper surface first).")),Ps(rt(t,a)))throw new K("The outline crosses itself.");if(zs(t,a)<.002)throw new K("The section is thinner than 0.2 % of its chord.");return[t,a]}function zs(n,e){const s=rt(n,e);let t=0;for(let a=1;a<50;a++){const i=a/50,r=[],l=s.length/2;for(let o=0;o<l;o++){const c=(o+1)%l,[d,u,h,f]=[s[2*o],s[2*o+1],s[2*c],s[2*c+1]];d>i!=h>i&&r.push(u+(i-d)*(f-u)/(h-d))}r.length>=2&&(t=Math.max(t,Math.max(...r)-Math.min(...r)))}return t}const Ee=2,Ue={air:{label:"Air (20 °C)",nu:1516e-8,rho:1.204},water:{label:"Water (20 °C)",nu:1004e-9,rho:998.2}},G={length:[.01,1e3],height:[.005,1e3],speed:[1e-4,340],maxBodies:8,maxRakes:8,maxDyeRakes:4,emitters:[1,64]},Fe=6;let ke=0;function ut(){return ke=(ke+1)%1e6,`b${Date.now().toString(36)}${ke.toString(36)}`}function Ft(){return ke=(ke+1)%1e6,`r${Date.now().toString(36)}${ke.toString(36)}`}function De(){return{version:Ee,tunnel:{length:8,height:4,walls:"farfield",resolution:"auto"},flow:{speed:10,fluid:"air"},bodies:[{id:ut(),name:"NACA 2412",shape:{kind:"naca",code:"2412",chord:1},x:2.5,y:2,angle:6,spin:0,enabled:!0,locked:!1}],rakes:[],view:{field:"particles",autoRange:!0,min:-10,max:10,speed:"max",tracers:!1,density:"normal",trail:"short",arrows:!1,streamlines:!1,rheoPreset:"kalliroscope",particleColor:"speed"}}}class Le extends Error{}const q=(n,e,s=-1/0,t=1/0)=>{const a=Number(n);if(!Number.isFinite(a)||a<s||a>t)throw new Le(`${e} must be a number from ${s} to ${t}.`);return a},ne=(n,e,s)=>e.includes(n)?n:s;function Fs(n){const e=n??{};switch(e.kind){case"naca":return{kind:"naca",code:dt(String(e.code)),chord:q(e.chord,"Chord",1e-4,1e3)};case"dat":{const s=Array.isArray(e.x)?e.x.map(Number):[],t=Array.isArray(e.y)?e.y.map(Number):[];if(s.length!==t.length||s.length<nt||s.length>at||![...s,...t].every(Number.isFinite))throw new Le("An imported airfoil needs matching x and y lists of finite numbers.");return{kind:"dat",name:String(e.name??"Imported airfoil").slice(0,80),x:s,y:t,chord:q(e.chord,"Chord",1e-4,1e3)}}case"circle":return{kind:"circle",diameter:q(e.diameter,"Diameter",1e-4,1e3)};case"rect":return{kind:"rect",width:q(e.width,"Width",1e-4,1e3),height:q(e.height,"Height",1e-4,1e3)};case"ellipse":return{kind:"ellipse",width:q(e.width,"Width",1e-4,1e3),height:q(e.height,"Height",1e-4,1e3)};case"plate":return{kind:"plate",length:q(e.length,"Length",1e-4,1e3),thickness:q(e.thickness,"Thickness",1e-5,1e3)};default:throw new Le(`Unknown body shape “${String(e.kind)}”.`)}}function Ls(n){const e=n??{},s=Number(e.version??Ee);if(s>Ee)throw new Le(`This tunnel was saved by a newer version of the plugin (scene version ${s}).`);const t=De(),a=e.tunnel??{},i=e.flow??{},r=e.view??{},l=(Array.isArray(e.bodies)?e.bodies:[]).slice(0,G.maxBodies).map(c=>({id:typeof c?.id=="string"&&c.id?c.id.slice(0,40):ut(),name:String(c?.name??"Body").slice(0,80),shape:Fs(c?.shape),x:q(c?.x,"Body x"),y:q(c?.y,"Body y"),angle:q(c?.angle??0,"Body angle",-3600,3600),spin:q(c?.spin??0,"Body spin",-1e4,1e4),enabled:c?.enabled!==!1,locked:c?.locked===!0})),o=(Array.isArray(e.rakes)?e.rakes:[]).slice(0,G.maxRakes).map((c,d)=>({id:typeof c?.id=="string"&&c.id?c.id.slice(0,40):Ft(),kind:ne(c?.kind,["streaks","timelines","dye"],"streaks"),x0:q(c?.x0,"Rake x"),y0:q(c?.y0,"Rake y"),x1:q(c?.x1,"Rake x"),y1:q(c?.y1,"Rake y"),emitters:Math.round(q(c?.emitters??12,"Rake emitters",...G.emitters)),color:Math.round(q(c?.color??d%Fe,"Rake colour",0,Fe-1)),enabled:c?.enabled!==!1}));return{version:Ee,tunnel:{length:q(a.length??t.tunnel.length,"Tunnel length",...G.length),height:q(a.height??t.tunnel.height,"Tunnel height",...G.height),walls:ne(a.walls,["farfield","slip","noslip","periodic"],t.tunnel.walls),resolution:ne(a.resolution,["auto","low","medium","high","ultra"],t.tunnel.resolution)},flow:{speed:q(i.speed??t.flow.speed,"Wind speed",...G.speed),fluid:ne(i.fluid,["air","water"],t.flow.fluid)},bodies:l,rakes:o,view:{field:ne(r.field,["particles","vorticity","speed","pressure","schlieren","rheoscopic","none"],t.view.field),autoRange:r.autoRange!==!1,min:Number.isFinite(Number(r.min))?Number(r.min):t.view.min,max:Number.isFinite(Number(r.max))?Number(r.max):t.view.max,speed:ne(r.speed,["max","realtime"],t.view.speed),tracers:r.tracers===!0,density:ne(r.density,["low","normal","high"],t.view.density),trail:ne(r.trail,["off","short","long"],t.view.trail),arrows:r.arrows===!0,streamlines:r.streamlines===!0,rheoPreset:ne(r.rheoPreset,["kalliroscope","pearl","copper"],t.view.rheoPreset),particleColor:ne(r.particleColor,["speed","vorticity"],t.view.particleColor)}}}const Is=3,Os=48,wt=2.5,ht=`
struct G { nx: u32, ny: u32, dt: f32, sign: f32, nsrc: u32, r: f32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<uniform> Gd: G;
`,Lt=`
fn idx(i: i32, j: i32) -> u32 { return u32(clamp(i, 0, i32(Gd.nx) - 1)) + u32(clamp(j, 0, i32(Gd.ny) - 1)) * Gd.nx; }
fn bil(c: vec2f) -> vec4f {
  let p = clamp(c, vec2f(0.0), vec2f(f32(Gd.nx) - 1.001, f32(Gd.ny) - 1.001));
  let i = i32(p.x);
  let j = i32(p.y);
  let f = p - vec2f(f32(i), f32(j));
  return mix(mix(src[idx(i, j)], src[idx(i + 1, j)], f.x), mix(src[idx(i, j + 1)], src[idx(i + 1, j + 1)], f.x), f.y);
}
`,It=()=>`${ht}
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec4f>;
${Lt}
@compute @workgroup_size(${I})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${I}u;
  if (k >= Gd.nx * Gd.ny) { return; }
  let m = mac[k];
  if (m.w > 0.5) { dst[k] = vec4f(0.0); return; }
  let p = vec2f(f32(k % Gd.nx), f32(k / Gd.nx));
  dst[k] = bil(p - Gd.sign * Gd.dt * m.xy);
}
`,Ot=()=>`${ht}
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read> fwd: array<vec4f>;
@group(0) @binding(4) var<storage, read> back: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> dst: array<vec4f>;
${Lt}
@compute @workgroup_size(${I})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${I}u;
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
`,Vt=()=>`${ht}
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
`;class Vs{device;nx;ny;bufs;cur=0;advect;correct;inject;unis=[];srcBuf;srcCount=0;srcKey="";constructor(e,s,t){this.device=e,this.nx=s,this.ny=t;const a=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.bufs=[0,1,2,3].map(()=>e.createBuffer({size:s*t*16,usage:a}));const i=(r,l)=>e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:r,label:l}),entryPoint:"main"}});this.advect=i(It(),"dye advect"),this.correct=i(Ot(),"dye correct"),this.inject=i(Vt(),"dye inject"),this.srcBuf=e.createBuffer({size:16*512,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.unis=[0,1].map(()=>e.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}))}get field(){return this.bufs[this.cur]}setSources(e){const s=e.map(r=>`${r.x.toFixed(2)},${r.y.toFixed(2)},${r.channel}`).join("|");if(s===this.srcKey)return;this.srcKey=s;const t=new ArrayBuffer(16*Math.min(512,e.length)),a=new Float32Array(t),i=new Uint32Array(t);e.slice(0,512).forEach((r,l)=>{a[4*l]=r.x,a[4*l+1]=r.y,i[4*l+2]=r.channel}),t.byteLength&&this.device.queue.writeBuffer(this.srcBuf,0,t),this.srcCount=Math.min(512,e.length)}clear(){for(const e of this.bufs)this.device.queue.writeBuffer(e,0,new Float32Array(this.nx*this.ny*4))}uniform(e,s,t){const a=new ArrayBuffer(32),i=new Uint32Array(a),r=new Float32Array(a);i[0]=this.nx,i[1]=this.ny,r[2]=s,r[3]=t,i[4]=this.srcCount,r[5]=wt;const l=this.unis[e];return this.device.queue.writeBuffer(l,0,a),l}encode(e,s,t){if(s<=0||this.srcCount===0)return;const a=Math.min(Os,Math.max(1,Math.ceil(s*.1/Is))),i=s/a,r=this.uniform(0,i,1),l=this.uniform(1,i,-1),o=this.nx*this.ny,c=Math.ceil(o/I),d=Math.min(c,32768),u=Math.ceil(c/d),h=(m,w,b)=>this.device.createBindGroup({layout:m.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:w}},...b.map((B,R)=>({binding:2+R,resource:{buffer:B}}))]}),f=2*Math.ceil(wt)+1,g=e.beginComputePass({label:"dye"});for(let m=0;m<a;m++){const w=this.bufs[this.cur],[b,B,R]=[1,2,3].map(x=>this.bufs[(this.cur+x)%4]);g.setPipeline(this.advect),g.setBindGroup(0,h(this.advect,r,[w,b])),g.dispatchWorkgroups(d,u),g.setBindGroup(0,h(this.advect,l,[b,B])),g.dispatchWorkgroups(d,u),g.setPipeline(this.correct),g.setBindGroup(0,h(this.correct,r,[w,b,B,R])),g.dispatchWorkgroups(d,u),g.setPipeline(this.inject),g.setBindGroup(0,h(this.inject,r,[this.srcBuf,R])),g.dispatchWorkgroups(Math.ceil(this.srcCount*f*f/64)),this.cur=(this.cur+3)%4}g.end()}async read(){const e=this.device.createBuffer({size:this.nx*this.ny*16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),s=this.device.createCommandEncoder();s.copyBufferToBuffer(this.field,0,e,0,this.nx*this.ny*16),this.device.queue.submit([s.finish()]),await e.mapAsync(GPUMapMode.READ);const t=new Float32Array(e.getMappedRange().slice(0));return e.destroy(),t}destroy(){for(const e of[...this.bufs,this.srcBuf,...this.unis])e.destroy()}}const Xs=.8,js=.12,Ws=160,Y=8,He=1.4,Ys=320,Qe=14,Xt=()=>`
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
${Oe}
${Ie}

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

@compute @workgroup_size(${I})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * ${I}u;
  if (i >= Ad.count) { return; }
  var m = pmeta[i];
  if (m.w < 0.5) { return; }
  var q = pos[i].xy;
  var prev = q;
  var gone = false;
  var bp: array<vec4f, ${V}>;
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
`,jt=()=>`
struct D {
  scale: f32, ox: f32, oy: f32, w: f32,
  h: f32, halfW: f32, maxSeg: f32, tail: f32,
  tracer: vec4f,
  colors: array<vec4f, ${Y}>,
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
  o.c = select(Dr.colors[min(u32(m.z), ${Y-1}u)], Dr.tracer, m.y < 0.0);
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
`,Wt=()=>`
struct D {
  scale: f32, ox: f32, oy: f32, w: f32,
  h: f32, halfW: f32, maxSeg: f32, first: f32,
  colors: array<vec4f, ${Y}>,
  gaps: array<vec4f, ${Y}>,
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
  let src = min(u32(ma.y), ${Y-1}u);
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
  let col = Dr.colors[min(u32(ma.z), ${Y-1}u)];
  o.c = vec4f(col.rgb, col.a * fade);
  o.d = c.y;
  return o;
}

@fragment
fn fs(i: Out) -> @location(0) vec4f {
  return vec4f(i.c.rgb, i.c.a * clamp((1.0 - abs(i.d)) * 1.6, 0.0, 1.0));
}
`,Yt=`
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f { return vec4f(0.0); }
`;class Ks{device;pos=null;meta=null;capacity=0;tracers=0;rakes=[];layoutKey="";advectPipe;advectUni;drawPipe;fadePipe;drawUni;linePipe=null;lineUni;seed=1;streakGap=1;fadeSteps=1e4;trail=null;trailKey="";clearTrail=!0;format="rgba16float";constructor(e){this.device=e,this.advectPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:Xt(),label:"particles advect"}),entryPoint:"main"}}),this.advectUni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});const s=e.createShaderModule({code:jt(),label:"particles draw"}),t={color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}};this.drawPipe=e.createRenderPipeline({layout:"auto",vertex:{module:s,entryPoint:"vs"},fragment:{module:s,entryPoint:"fs",targets:[{format:this.format,blend:t}]},primitive:{topology:"triangle-list"}});const a=e.createShaderModule({code:Yt,label:"trail fade"});this.fadePipe=e.createRenderPipeline({layout:"auto",vertex:{module:a,entryPoint:"vs"},fragment:{module:a,entryPoint:"fs",targets:[{format:this.format,blend:{color:{srcFactor:"zero",dstFactor:"constant",operation:"add"},alpha:{srcFactor:"zero",dstFactor:"constant",operation:"add"}}}]},primitive:{topology:"triangle-list"}}),this.drawUni=e.createBuffer({size:80+16*Y,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.lineUni=e.createBuffer({size:32+32*Y,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}encodeRakeLines(e,s,t,a,i,r){if(!this.pos||!this.meta||!this.rakes.length)return;if(!this.linePipe){const d=this.device.createShaderModule({code:Wt(),label:"rake lines"});this.linePipe=this.device.createRenderPipeline({layout:"auto",vertex:{module:d,entryPoint:"vs"},fragment:{module:d,entryPoint:"fs",targets:[{format:s,blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-list"}})}const l=new Float32Array(8+8*Y);l.set([a.scale,a.ox,a.oy,t.w,t.h,.75*r,80*r,this.tracers]),i.slice(0,Y).forEach((d,u)=>l.set(d,8+4*u));for(const d of this.rakes){const u=8+4*Y+4*Math.min(d.index,Y-1);l[u]=d.rake.kind==="streaks"?this.streakGap*2.5:.5,l[u+1]=this.fadeSteps}this.device.queue.writeBuffer(this.lineUni,0,l);const o=this.device.createBindGroup({layout:this.linePipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.pos}},{binding:1,resource:{buffer:this.meta}},{binding:2,resource:{buffer:this.lineUni}}]});e.setPipeline(this.linePipe),e.setBindGroup(0,o);const c=this.capacity-this.tracers-1;c>0&&e.draw(6,c)}get count(){return this.capacity}get tracerCount(){return this.tracers}get buffers(){return this.pos&&this.meta?{pos:this.pos,meta:this.meta}:null}get pools(){return this.rakes.map(e=>({id:e.rake.id,index:e.index,base:e.base,slots:e.slots}))}configure(e,s,t){const a=[];let i=e;s.forEach((h,f)=>{const g=h.kind==="streaks"?Math.ceil(t.nx*1.2*He):Ys,m=h.kind==="streaks"?g*h.emitters:g*Qe;a.push({rake:h,index:f,base:i,per:g,slots:m,head:0,acc:0}),i+=m});const r=`${e}|${t.nx}x${t.ny}|${s.map(h=>`${h.id}:${h.kind}:${h.emitters}`).join(",")}`;if(r===this.layoutKey){a.forEach((h,f)=>{this.rakes[f].rake=h.rake});return}this.layoutKey=r,this.rakes=a,this.tracers=e;const l=Math.max(1,i);if(l>this.capacity||!this.pos){this.pos?.destroy(),this.meta?.destroy();const h=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.pos=this.device.createBuffer({size:l*16,usage:h}),this.meta=this.device.createBuffer({size:l*16,usage:h})}this.capacity=l;const o=new Float32Array(l*4),c=new Float32Array(l*4);let d=12345;const u=()=>(d=d*1103515245+12345&2147483647)/2147483647;for(let h=0;h<e;h++){const f=t.absorbInX+u()*(t.outX-t.absorbInX),g=u()*(t.ny-1);o.set([f,g,f,g],4*h),c.set([0,-1,0,1],4*h)}this.device.queue.writeBuffer(this.pos,0,o),this.device.queue.writeBuffer(this.meta,0,c),this.clearTrail=!0}emit(e){if(!(!this.pos||!this.meta||e.steps<=0))for(const s of this.rakes){const{rake:t}=s;if(t.kind==="streaks"){this.streakGap=1/(e.u*He),this.fadeSteps=.85*e.nx/e.u,s.acc+=e.u*e.steps*He;const a=Math.min(s.per,Math.floor(s.acc));if(s.acc-=a,a<=0)continue;const i=new Float32Array(a*4),r=new Float32Array(a*4);for(let l=0;l<t.emitters;l++){const o=t.emitters===1?.5:l/(t.emitters-1),c=t.x0+(t.x1-t.x0)*o,d=t.y0+(t.y1-t.y0)*o;for(let u=0;u<a;u++)i.set([c,d,c,d],4*u),r.set([-((u+.5)/a)*e.steps,s.index,t.color,1],4*u);this.writeRing(s.base+l*s.per,s.per,s.head,i,r,a)}s.head=(s.head+a)%s.per}else{const a=e.nx*.1/e.u;for(this.fadeSteps=.85*e.nx/e.u,s.acc+=e.steps;s.acc>=a;){s.acc-=a;const i=-Math.max(0,e.steps-s.acc),r=new Float32Array(s.per*4),l=new Float32Array(s.per*4);for(let c=0;c<s.per;c++){const d=c/(s.per-1),u=t.x0+(t.x1-t.x0)*d,h=t.y0+(t.y1-t.y0)*d;r.set([u,h,u,h],4*c),l.set([i,s.index,t.color,1],4*c)}const o=s.head%Qe;this.device.queue.writeBuffer(this.pos,(s.base+o*s.per)*16,r),this.device.queue.writeBuffer(this.meta,(s.base+o*s.per)*16,l),s.head=(s.head+1)%Qe}}}}writeRing(e,s,t,a,i,r){const l=Math.min(r,s-t);this.device.queue.writeBuffer(this.pos,(e+t)*16,a,0,l*4),this.device.queue.writeBuffer(this.meta,(e+t)*16,i,0,l*4),r>l&&(this.device.queue.writeBuffer(this.pos,e*16,a,l*4,(r-l)*4),this.device.queue.writeBuffer(this.meta,e*16,i,l*4,(r-l)*4))}encodeAdvect(e,s,t,a){if(!this.pos||!this.meta||s.steps<=0)return;this.emit(s);const i=Math.min(Ws,Math.max(1,Math.ceil(s.steps*js/Xs))),r=new ArrayBuffer(48),l=new Uint32Array(r),o=new Float32Array(r);l[0]=this.capacity,l[1]=i,o[2]=s.steps/i,l[3]=this.seed=this.seed*1664525+1013904223>>>0,o[4]=s.nx,o[5]=s.ny,o[6]=s.outX,o[7]=s.absorbInX,o[8]=Math.max(1,s.u*s.steps),o[9]=.35*s.nx/s.u,l[10]=s.wrapY?1:0,this.device.queue.writeBuffer(this.advectUni,0,r);const c=this.device.createBindGroup({layout:this.advectPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:this.pos}},{binding:2,resource:{buffer:this.meta}},{binding:3,resource:{buffer:a.params}},{binding:4,resource:{buffer:a.bodies}},{binding:5,resource:{buffer:a.sdf}},{binding:6,resource:{buffer:this.advectUni}}]}),d=Math.ceil(this.capacity/I),u=Math.min(d,32768),h=e.beginComputePass({label:"particles"});h.setPipeline(this.advectPipe),h.setBindGroup(0,c),h.dispatchWorkgroups(u,Math.ceil(d/u)),h.end()}ensureTrail(e,s,t){const a=`${e}x${s}`;(!this.trail||a!==this.trailKey)&&(this.trail?.destroy(),this.trail=this.device.createTexture({size:[e,s],format:this.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),this.trailKey=a,this.clearTrail=!0),t!==this.lastView&&(this.lastView=t,this.clearTrail=!0)}lastView="";encodeDraw(e,s,t,a,i,r,l,o){const c=`${t.scale.toFixed(9)}|${t.ox.toFixed(4)}|${t.oy.toFixed(4)}`;this.ensureTrail(s.w,s.h,c);const d=this.trail.createView(),u=e.beginRenderPass({colorAttachments:[{view:d,loadOp:this.clearTrail?"clear":"load",storeOp:"store",clearValue:{r:0,g:0,b:0,a:0}}]});if(this.clearTrail=!1,u.setPipeline(this.fadePipe),u.setBlendConstant({r:a,g:a,b:a,a}),u.draw(3),this.pos&&this.meta&&i.tracers&&this.tracers>0){const h=new Float32Array(20+4*Y);h.set([t.scale,t.ox,t.oy,s.w,s.h,s.dot,60,s.tail]),h.set(r.tracer,8);const f=12+4*Y;h.set([l?.lo??0,l?.hi??1,l?1:0,l?.nx??1,l?.lift??0,l?.ny??1,s.taper?1:0,0],f),this.device.queue.writeBuffer(this.drawUni,0,h);const g=this.device.createBindGroup({layout:this.drawPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.pos}},{binding:1,resource:{buffer:this.meta}},{binding:2,resource:{buffer:this.drawUni}},{binding:3,resource:{buffer:l?.scalar??o.scalar}},{binding:4,resource:{buffer:l?.lut??o.lut}}]});u.setPipeline(this.drawPipe),u.setBindGroup(0,g),u.draw(6,this.tracers)}u.end()}async read(){if(!this.pos||!this.meta)return null;const e=this.capacity*16,s=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),t=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),a=this.device.createCommandEncoder();a.copyBufferToBuffer(this.pos,0,s,0,e),a.copyBufferToBuffer(this.meta,0,t,0,e),this.device.queue.submit([a.finish()]),await Promise.all([s.mapAsync(GPUMapMode.READ),t.mapAsync(GPUMapMode.READ)]);const i={pos:new Float32Array(s.getMappedRange().slice(0)),meta:new Float32Array(t.getMappedRange().slice(0))};return s.destroy(),t.destroy(),i}clear(){this.clearTrail=!0,this.layoutKey=""}destroy(){this.pos?.destroy(),this.meta?.destroy(),this.trail?.destroy(),this.advectUni.destroy(),this.drawUni.destroy(),this.lineUni.destroy()}}const Ze=96,Hs=.25,Qs=24,Kt=()=>`
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

@compute @workgroup_size(${I})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${I}u;
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
  let sub = u32(clamp(ceil(rate * Rp.dt / ${Hs}), 1.0, ${Qs}.0));
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
`;class Zs{device;nx;ny;bufs;cur=0;pipe;uni;frame=0;seed=7;constructor(e,s,t){this.device=e,this.nx=s,this.ny=t;const a=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.bufs=[e.createBuffer({size:s*t*32,usage:a}),e.createBuffer({size:s*t*32,usage:a})],this.pipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:Kt(),label:"rheoscopic"}),entryPoint:"main"}}),this.uni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.reset()}reset(){const e=new Float32Array(this.nx*this.ny*8);let s=99;const t=()=>(s=s*1103515245+12345&2147483647)/2147483647;for(let a=0;a<this.nx*this.ny;a++)e.set([1/3,1/3,1/3,0,0,0,t(),t()],8*a);this.device.queue.writeBuffer(this.bufs[0],0,e),this.device.queue.writeBuffer(this.bufs[1],0,e),this.frame=0}get field(){return this.bufs[this.cur]}get sparkleWeights(){const e=this.frame%Ze/Ze,s=Math.sin(Math.PI*e)**2;return[s,1-s]}encode(e,s,t,a){if(s<=0)return;const i=new ArrayBuffer(48),r=new Uint32Array(i),l=new Float32Array(i);r[0]=this.nx,r[1]=this.ny,r[2]=this.frame,r[3]=this.seed=this.seed*1664525+1013904223>>>0,l[4]=s,l[5]=1/Math.max(1,a.depthCells),l[6]=1/Math.max(1,a.relaxSteps),l[7]=a.inletX,r[8]=Ze,this.device.queue.writeBuffer(this.uni,0,i);const o=this.device.createBindGroup({layout:this.pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:this.bufs[this.cur]}},{binding:2,resource:{buffer:this.bufs[this.cur^1]}},{binding:3,resource:{buffer:this.uni}}]}),c=this.nx*this.ny,d=Math.ceil(c/I),u=Math.min(d,32768),h=e.beginComputePass({label:"rheoscopic"});h.setPipeline(this.pipe),h.setBindGroup(0,o),h.dispatchWorkgroups(u,Math.ceil(d/u)),h.end(),this.cur^=1,this.frame++}async read(){const e=this.nx*this.ny*32,s=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),t=this.device.createCommandEncoder();t.copyBufferToBuffer(this.field,0,s,0,e),this.device.queue.submit([t.finish()]),await s.mapAsync(GPUMapMode.READ);const a=new Float32Array(s.getMappedRange().slice(0));return s.destroy(),a}destroy(){this.bufs[0].destroy(),this.bufs[1].destroy(),this.uni.destroy()}}const Se=1024,kt=512,Ht=`
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
`,Qt=`
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
`;class Js{device;verts;trace;draw;traceUni;drawUni;lines=0;constructor(e,s){this.device=e,this.verts=e.createBuffer({size:kt*Se*16,usage:GPUBufferUsage.STORAGE}),this.trace=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:Ht,label:"streamlines trace"}),entryPoint:"main"}});const t=e.createShaderModule({code:Qt,label:"streamlines draw"});this.draw=e.createRenderPipeline({layout:"auto",vertex:{module:t,entryPoint:"vs"},fragment:{module:t,entryPoint:"fs",targets:[{format:s,blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-list"}}),this.traceUni=e.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.drawUni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}get count(){return this.lines}encodeTrace(e,s,t,a,i){this.lines=Math.max(1,Math.min(kt,Math.floor(i)));const r=new ArrayBuffer(32),l=new Float32Array(r),o=new Uint32Array(r);l[0]=t.nx,l[1]=t.ny,o[2]=this.lines,o[3]=Se,l[4]=a,l[5]=0,l[6]=(t.ny-1)/this.lines,l[7]=Math.max(.5,t.nx*1.4/Se),this.device.queue.writeBuffer(this.traceUni,0,r);const c=this.device.createBindGroup({layout:this.trace.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:s}},{binding:1,resource:{buffer:this.verts}},{binding:2,resource:{buffer:this.traceUni}}]}),d=e.beginComputePass({label:"streamlines"});d.setPipeline(this.trace),d.setBindGroup(0,c),d.dispatchWorkgroups(Math.ceil(this.lines/64)),d.end()}encodeDraw(e,s,t,a,i){if(!this.lines)return;this.device.queue.writeBuffer(this.drawUni,0,new Float32Array([t.scale,t.ox,t.oy,s.w,s.h,.6*i,Se,0,...a]));const r=this.device.createBindGroup({layout:this.draw.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.verts}},{binding:1,resource:{buffer:this.drawUni}}]});e.setPipeline(this.draw),e.setBindGroup(0,r),e.draw(6,this.lines*(Se-1))}destroy(){this.verts.destroy(),this.traceUni.destroy(),this.drawUni.destroy()}}const Je={particles:0,vorticity:0,speed:1,pressure:2,schlieren:3,rheoscopic:1,none:1},et=4;class ot{nx;ny;n;config;device;f;cur=0;paramsBuf;params=new ArrayBuffer(64);bodiesBuf;bodyData=new ArrayBuffer(V*64);sdfBuf;sdfKey="";sdfOffsets=[];forceBuf;staging=[];stepPipe;stepPipeKey="";stepBG=null;slotBGs=[];slotBuf;macroPipe;fieldPipe;stepModule;macroBuf;scalarBuf;fieldUni;sampledBuf;sampledRead;sampledBusy=!1;sampleW;sampleH;bodies=[];physics={u:.05,tau:.6,smagorinsky:!1,smagCs:.1};groups;destroyed=!1;stepsDone=0;constructor(e,s){this.device=e,this.config={profile:0,absorbing:!0,...s},this.nx=s.nx,this.ny=s.ny,this.n=s.nx*s.ny;const t=GPUBufferUsage,a=9*this.n*4;this.f=[e.createBuffer({size:a,usage:t.STORAGE|t.COPY_DST}),e.createBuffer({size:a,usage:t.STORAGE|t.COPY_DST})],this.paramsBuf=e.createBuffer({size:64,usage:t.UNIFORM|t.COPY_DST}),this.bodiesBuf=e.createBuffer({size:V*64,usage:t.STORAGE|t.COPY_DST}),this.sdfBuf=e.createBuffer({size:16,usage:t.STORAGE|t.COPY_DST}),this.forceBuf=e.createBuffer({size:Ye*4,usage:t.STORAGE|t.COPY_SRC|t.COPY_DST}),this.slotBuf=e.createBuffer({size:te*256,usage:t.UNIFORM|t.COPY_DST});const i=new Uint32Array(te*64);for(let l=0;l<te;l++)i[l*64]=l;e.queue.writeBuffer(this.slotBuf,0,i),this.macroBuf=e.createBuffer({size:this.n*16,usage:t.STORAGE}),this.scalarBuf=e.createBuffer({size:this.n*4,usage:t.STORAGE}),this.fieldUni=e.createBuffer({size:48,usage:t.UNIFORM|t.COPY_DST}),this.sampleW=Math.ceil(this.nx/et),this.sampleH=Math.ceil(this.ny/et),this.sampledBuf=e.createBuffer({size:this.sampleW*this.sampleH*4,usage:t.STORAGE|t.COPY_SRC}),this.sampledRead=e.createBuffer({size:this.sampleW*this.sampleH*4,usage:t.MAP_READ|t.COPY_DST}),this.stepModule=e.createShaderModule({code:_t(),label:"tunnel step"}),this.macroPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:Gt(),label:"tunnel macro"}),entryPoint:"main"}}),this.fieldPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:Nt(),label:"tunnel field"}),entryPoint:"main"}});const r=Math.ceil(this.n/I);this.groups=[Math.min(r,32768),Math.ceil(r/Math.min(r,32768))],this.writeBodies(),this.reset()}reset(e=this.physics.u){const s=new Float32Array(9*this.n),t=1.5*e*e;for(let a=0;a<9;a++){const i=3*[0,1,0,-1,0,1,-1,-1,1][a]*e;s.fill(he[a]*(1+i+.5*i*i-t),a*this.n,(a+1)*this.n)}this.device.queue.writeBuffer(this.f[0],0,s),this.device.queue.writeBuffer(this.f[1],0,s),this.stepsDone=0}setPhysics(e){this.physics=e;const s=`${this.config.walls}|${e.smagorinsky}`;s!==this.stepPipeKey&&(this.stepPipe=this.device.createComputePipeline({layout:"auto",compute:{module:this.stepModule,entryPoint:"step",constants:{WALLS:Ts[this.config.walls],SMAG:e.smagorinsky?1:0}}}),this.stepPipeKey=s,this.stepBG=null,this.slotBGs=[])}writeParams(e){const s=new Uint32Array(this.params),t=new Float32Array(this.params),a=this.physics;s[0]=this.nx,s[1]=this.ny,s[2]=this.n,s[3]=this.bodies.length,t[4]=1/a.tau,t[5]=18*Math.SQRT2*a.smagCs*a.smagCs,t[6]=a.u,t[7]=this.config.absorbing||this.config.walls==="farfield"?.05:0,t[8]=this.config.absorbing?this.absorbInX:-1,t[9]=this.spongeX,s[10]=Math.max(1,e),s[11]=this.config.profile,t[12]=this.config.walls==="farfield"?Math.max(4,this.ny*.06):0,this.device.queue.writeBuffer(this.paramsBuf,0,this.params)}get absorbInX(){return this.config.absorbing?this.nx*.05:-1}get spongeX(){return this.nx*.85}setBodies(e){if(e.length>V)throw new Error(`At most ${V} bodies are in the flow at once.`);this.bodies=e;const s=e.map(t=>t.key).join("|");if(s!==this.sdfKey){const t=Math.max(4,e.reduce((i,r)=>i+r.sdf.data.length,0));this.sdfBuf.size<t*4&&(this.sdfBuf.destroy(),this.sdfBuf=this.device.createBuffer({size:t*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.stepBG=null,this.renderBGDirty=!0),this.sdfOffsets=[];let a=0;for(const i of e)this.sdfOffsets.push(a),this.device.queue.writeBuffer(this.sdfBuf,a*4,i.sdf.data),a+=i.sdf.data.length;this.sdfKey=s}this.writeBodies()}renderBGDirty=!1;writeBodies(){const e=new Float32Array(this.bodyData),s=new Uint32Array(this.bodyData);this.bodies.forEach((t,a)=>{const i=a*16;e[i]=t.from.x,e[i+1]=t.from.y,e[i+2]=t.to.x,e[i+3]=t.to.y,e[i+4]=t.from.theta,e[i+5]=t.to.theta,e[i+6]=t.sdf.bound,e[i+7]=t.sdf.texel,e[i+8]=t.sdf.ox,e[i+9]=t.sdf.oy,s[i+10]=t.sdf.w,s[i+11]=t.sdf.h,s[i+12]=this.sdfOffsets[a]??0}),this.device.queue.writeBuffer(this.bodiesBuf,0,this.bodyData)}get buffers(){return{params:this.paramsBuf,bodies:this.bodiesBuf,sdf:this.sdfBuf,scalar:this.scalarBuf}}bindGroups(){if(!this.stepBG){const e=this.stepPipe.getBindGroupLayout(0),s=(t,a)=>this.device.createBindGroup({layout:e,entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:a}},{binding:2,resource:{buffer:this.paramsBuf}},{binding:3,resource:{buffer:this.bodiesBuf}},{binding:4,resource:{buffer:this.sdfBuf}},{binding:5,resource:{buffer:this.forceBuf}}]});this.stepBG=[s(this.f[0],this.f[1]),s(this.f[1],this.f[0])]}if(!this.slotBGs.length){const e=this.stepPipe.getBindGroupLayout(1);for(let s=0;s<te;s++)this.slotBGs.push(this.device.createBindGroup({layout:e,entries:[{binding:0,resource:{buffer:this.slotBuf,offset:s*256,size:16}}]}))}return this.stepBG}encodeFrame(e,s,t){const a=Math.min(te,Math.max(0,Math.floor(s)));this.writeParams(Math.max(1,a)),this.writeBodies();const i=this.bindGroups();let r=!1;if(a>0){e.clearBuffer(this.forceBuf,0,Math.min(Ye*4,a*V*8)),e.clearBuffer(this.forceBuf,ee*4,16);const l=e.beginComputePass({label:"tunnel steps"});l.setPipeline(this.stepPipe);for(let o=0;o<a;o++)l.setBindGroup(0,i[this.cur]),l.setBindGroup(1,this.slotBGs[o]),l.dispatchWorkgroups(this.groups[0],this.groups[1]),this.cur^=1;l.end(),this.stepsDone+=a,r=!0}return this.encodeField(e,t),{readForces:r}}encodeField(e,s){const t=new ArrayBuffer(48),a=new Uint32Array(t),i=new Float32Array(t);a[0]=this.nx,a[1]=this.ny,a[2]=s.mode,a[3]=et,i[4]=s.uRef,i[5]=s.lRef,i[8]=s.rhoRef??1,a[6]=this.sampleW,a[7]=this.sampleH,this.device.queue.writeBuffer(this.fieldUni,0,t);const r=this.device.createBindGroup({layout:this.macroPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.f[this.cur]}},{binding:1,resource:{buffer:this.macroBuf}},{binding:2,resource:{buffer:this.paramsBuf}},{binding:3,resource:{buffer:this.bodiesBuf}},{binding:4,resource:{buffer:this.sdfBuf}}]}),l=this.device.createBindGroup({layout:this.fieldPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.macroBuf}},{binding:1,resource:{buffer:this.scalarBuf}},{binding:2,resource:{buffer:this.fieldUni}},{binding:3,resource:{buffer:this.sampledBuf}}]}),o=e.beginComputePass({label:"tunnel field"});o.setPipeline(this.macroPipe),o.setBindGroup(0,r),o.dispatchWorkgroups(this.groups[0],this.groups[1]),o.setPipeline(this.fieldPipe),o.setBindGroup(0,l),o.dispatchWorkgroups(this.groups[0],this.groups[1]),o.end()}prepareRead(e,s){const t=Math.min(te,s),a=t*V*8;let i=this.staging.pop();i||(i=this.device.createBuffer({size:Ye*4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})),e.copyBufferToBuffer(this.forceBuf,0,i,0,a),e.copyBufferToBuffer(this.forceBuf,ee*4,i,ee*4,16);const r=i;return async()=>{try{await r.mapAsync(GPUMapMode.READ)}catch{return null}const l=new Int32Array(r.getMappedRange().slice(0));r.unmap(),this.destroyed?r.destroy():this.staging.push(r);const o=this.bodies.map((d,u)=>{const h=new Float64Array(t*2);let f=0,g=0;for(let m=0;m<t;m++){const w=l[(m*V+u)*2]/ze,b=l[(m*V+u)*2+1]/ze;h[2*m]=w,h[2*m+1]=b,f+=w,g+=b}return{fx:f,fy:g,perStep:h}}),c=l[ee]>0?this.n-l[ee+1]:-1;return{steps:t,forces:o,bad:l[ee],limited:l[ee+2],badCell:c>=0?{x:c%this.nx,y:Math.floor(c/this.nx)}:null}}}async readSampled(){if(this.sampledBusy||this.destroyed)return null;this.sampledBusy=!0;try{const e=this.device.createCommandEncoder();e.copyBufferToBuffer(this.sampledBuf,0,this.sampledRead,0,this.sampledRead.size),this.device.queue.submit([e.finish()]),await this.sampledRead.mapAsync(GPUMapMode.READ);const s=new Float32Array(this.sampledRead.getMappedRange().slice(0));this.sampledRead.unmap();for(let t=0;t<s.length;t++)s[t]>1e29&&(s[t]=NaN);return s}catch{return null}finally{this.sampledBusy=!1}}destroy(){this.destroyed=!0;for(const e of[...this.f,this.paramsBuf,this.bodiesBuf,this.sdfBuf,this.forceBuf,this.slotBuf,this.macroBuf,this.scalarBuf,this.fieldUni,this.sampledBuf,...this.staging])e.destroy();this.staging=[]}}const ei=.05,ti=50,si=.005,Pt=.1,Mt=1/3;function ii(n,e,s,t){const a=n/e;let i=ei;const r=u=>t*u/(s*a);r(i)>Mt&&(i=Mt*s*a/t);const l=r(i),o=i/ti,c=Math.max(l,o),d=i*a/s;return{dx:a,dt:d,u:i,nu:c,tau:3*c+.5,capped:l<o,smagorinsky:c<si}}function ni(n,e,s,t){return{real:s*e/t,sim:n.u*(e/n.dx)/n.nu}}const me={low:512*256,medium:1024*512,high:1536*768,ultra:2048*1024},Ce=.03;function tt(n,e,s,t){const a=e+s*n,i=Math.exp(-s*t);return[(n+a*t)*i,(a-s*(n+a*t))*i]}const ai=.1,ri=12,oi={particles:"inferno",vorticity:"balance",speed:"viridis",pressure:"balance",schlieren:"viridis",rheoscopic:"viridis",none:"viridis"},li=.3,ci=1.5,di={low:1/110,normal:1/40,high:1/16},ui=3e3,hi=4e4,fi={off:0,short:11,long:22},pi=34,mi=14;function Zt(n){return n.field==="particles"?n.particleColor==="vorticity"?"balance":"inferno":oi[n.field]}function lt(n,e){const{length:s,height:t}=n.tunnel;let a=Math.round(Math.sqrt(e*s/t)),i=Math.round(e/a);return a=Math.max(32,Math.min(8192,a)),i=Math.max(16,Math.min(8192,i)),{nx:a,ny:i}}const Bt=new Map;class yi{device;adapterName;canvas;renderer;solver=null;scene=null;map=null;bodies=new Map;order=[];targets=new Map;raf=0;stepsTarget=64;gpuMs=0;lastFrame=0;fpsEma=0;readPending=!1;sampledAt=0;listeners=new Set;range={lo:-10,hi:10};autoRange={lo:-10,hi:10,ready:!1};gridKey="";rangeField=null;rangeKey="";rhoRef=1;physKey="";paused=!1;unstable=!1;palette;worldView={cx:4,cy:2,mpp:.01,w:800,h:400,dpr:1};simTime=0;stats;particles;dye=null;rheo=null;rheoLooks={};streamlines;rakeGpu=[];dyeChannels=new Map;frameNo=0;markerColors=null;recordForces=!1;onUnstable=null;unstableAt=null;constructor(e,s,t,a){this.device=e,this.adapterName=t,this.palette=a,this.canvas=s,this.renderer=new Us(e,s),this.particles=new Ks(e),this.streamlines=new Js(e,this.renderer.format),this.stats={adapter:t,nx:0,ny:0,stepsPerFrame:0,mlups:0,speedRatio:0,simTime:0,fps:0,map:null,state:"running"}}subscribe(e){return this.listeners.add(e),()=>{this.listeners.delete(e)}}emit(){for(const e of this.listeners)e()}get solverReady(){return!!this.solver}get lattice(){return this.map}get grid(){return this.solver?{nx:this.solver.nx,ny:this.solver.ny}:null}benchmark(){return this.benchmarkAt(1024,512)}async benchmarkAt(e,s){const t=`${e}x${s}`,a=Bt.get(t);if(a!==void 0)return a;const i=new ot(this.device,{nx:e,ny:s,walls:"slip"});i.setPhysics({u:.05,tau:.51,smagorinsky:!0,smagCs:Pt});const r=async u=>{const h=this.device.createCommandEncoder();i.encodeFrame(h,u,{mode:0,uRef:.05,lRef:50}),this.device.queue.submit([h.finish()]),await this.device.queue.onSubmittedWorkDone()};await r(30);const l=Math.max(40,Math.min(400,Math.round(2e8/(e*s)))),o=performance.now();await r(l);const c=Math.max(.1,performance.now()-o);i.destroy();const d=e*s*l/(c/1e3)/1e6;return Bt.set(t,d),d}async cellsFor(e,s){if(e!=="auto")return me[e];const t=async a=>{const{nx:i,ny:r}=lt(s,me[a]),l=8*i*i*r*1.25/1e6;return await this.benchmarkAt(i,r)>=l};return await t("medium")?await t("high")?await t("ultra")?me.ultra:me.high:me.medium:me.low}async setScene(e){this.scene=e;const s=await this.cellsFor(e.tunnel.resolution,e);if(this.scene!==e)return;const{nx:t,ny:a}=lt(e,s),i=`${t}x${a}|${e.tunnel.walls}|${e.tunnel.length}`;i!==this.gridKey&&(this.solver?.destroy(),this.solver=new ot(this.device,{nx:t,ny:a,walls:e.tunnel.walls}),this.particles.clear(),this.dye?.destroy(),this.dye=null,this.rheo?.destroy(),this.rheo=null,this.gridKey=i,this.bodies.clear(),this.physKey="",this.simTime=0,this.unstable=!1,this.autoRange.ready=!1,this.rhoRef=1);const r=Ue[e.flow.fluid];this.map=ii(e.tunnel.length,t,e.flow.speed,r.nu);const l=`${this.map.u}|${this.map.tau}|${this.map.smagorinsky}`;l!==this.physKey&&(this.solver.setPhysics({u:this.map.u,tau:this.map.tau,smagorinsky:this.map.smagorinsky,smagCs:Pt}),this.physKey||this.solver.reset(this.map.u),this.physKey=l),this.syncBodies(e),await this.syncMarkers(e),this.emit()}async syncMarkers(e){const s=this.solver,t=this.map.dx,a=await this.benchmark();let r=e.view.tracers||e.view.field==="particles"?Math.round(s.n*di[e.view.density]):0;a<ui&&(r=Math.min(r,hi));const l=d=>d/t-.5,o=e.rakes.filter(d=>d.enabled);this.rakeGpu=o.filter(d=>d.kind!=="dye").map(d=>({id:d.id,kind:d.kind,x0:l(d.x0),y0:l(d.y0),x1:l(d.x1),y1:l(d.y1),emitters:d.emitters,color:d.color})),this.particles.configure(r,this.rakeGpu,{nx:s.nx,ny:s.ny,absorbInX:Math.max(0,s.absorbInX),outX:s.spongeX});const c=o.filter(d=>d.kind==="dye").slice(0,G.maxDyeRakes);if(this.dyeChannels=new Map(c.map((d,u)=>[d.id,u])),c.length){this.dye||(this.dye=new Vs(this.device,s.nx,s.ny),this.dye.clear());const d=[];c.forEach((u,h)=>{for(let f=0;f<u.emitters;f++){const g=u.emitters===1?.5:f/(u.emitters-1);d.push({x:l(u.x0+(u.x1-u.x0)*g),y:l(u.y0+(u.y1-u.y0)*g),channel:h})}}),this.dye.setSources(d)}else this.dye&&(this.dye.destroy(),this.dye=null)}get dyeChannelOf(){return this.dyeChannels}async readParticles(){const e=await this.particles.read();return e?{...e,tracers:this.particles.tracerCount,pools:this.particles.pools,dx:this.map?.dx??0}:null}async readDye(){return this.dye?{data:await this.dye.read(),nx:this.dye.nx,ny:this.dye.ny,channels:Object.fromEntries(this.dyeChannels),dx:this.map?.dx??0}:null}async readRheo(){if(!this.rheo)return null;const e=await this.rheo.read(),s=this.rheo.nx*this.rheo.ny;let t=0,a=0,i=0,r=0,l=1/0,o=-1/0;for(let d=0;d<s;d++){const u=e.slice(8*d,8*d+6);if(!u.every(Number.isFinite)){i++;continue}t+=u[2],a+=Math.abs(u[3]),r+=u[0]+u[1]+u[2],l=Math.min(l,u[2]),o=Math.max(o,u[2])}const c=Math.max(1,s-i);return{meanZZ:t/c,meanAbsXY:a/c,meanTrace:r/c,minZZ:l,maxZZ:o,nan:i,nx:this.rheo.nx,ny:this.rheo.ny,data:null}}get streamlineCount(){return this.scene?.view.streamlines?this.streamlines.count:0}syncBodies(e){const s=this.map.dx,t=e.bodies.filter(i=>i.enabled).slice(0,V),a=new Set(t.map(i=>i.id));for(const i of[...this.bodies.keys()])a.has(i)||this.bodies.delete(i);for(const i of t){const r=`${JSON.stringify(i.shape)}@${s}`,l=this.bodies.get(i.id),o=this.targetPose(i);if(!l||l.key!==r){const c=Ut(Re(i.shape),{x:0,y:0,theta:0},1/s),d=Dt(c);this.bodies.set(i.id,{body:i,key:r,sdf:d,rCells:it(c),pose:l?.pose??o,spinAngle:l?.spinAngle??0,vel:l?.vel??{x:0,y:0,theta:0},fxEma:0,fyEma:0,history:[]})}else l.body=i}this.order=t.map(i=>i.id)}targetPose(e){const s=this.map.dx,t=this.targets.get(e.id),a=t?.x??e.x,i=t?.y??e.y,r=t?.angle??e.angle,l=this.bodies.get(e.id)?.spinAngle??0;return{x:a/s-.5,y:i/s-.5,theta:-r*Math.PI/180+l}}setTarget(e,s){s?this.targets.set(e,s):this.targets.delete(e)}livePose(e){const s=this.bodies.get(e);if(!s||!this.map)return null;const t=this.map.dx;return{x:(s.pose.x+.5)*t,y:(s.pose.y+.5)*t,angle:-(s.pose.theta-s.spinAngle)*180/Math.PI}}bodyLive(e){const s=this.bodies.get(e),t=this.livePose(e);if(!s||!t||!this.map||!this.scene)return null;const a=Ue[this.scene.flow.fluid],i=this.map.u,r=.5*i*i*(we(s.body.shape)/this.map.dx),l=o=>o/r*.5*a.rho*this.scene.flow.speed**2*we(s.body.shape);return{...t,fx:l(s.fxEma),fy:l(s.fyEma),cd:s.fxEma/r,cl:s.fyEma/r}}spinCap(e){const s=this.bodies.get(e);return!s||!this.map?null:ai/Math.max(1,s.rCells)/this.map.dt}forceHistory(e){return this.bodies.get(e)?.history??[]}reynoldsFor(e){return!this.map||!this.scene?null:ni(this.map,we(e.shape),this.scene.flow.speed,Ue[this.scene.flow.fluid].nu)}resetFlow(){if(!(!this.solver||!this.map)){this.solver.reset(this.map.u),this.simTime=0,this.rhoRef=1,this.particles.clear(),this.dye?.clear(),this.rheo?.reset(),this.scene&&this.syncMarkers(this.scene),this.unstable=!1;for(const e of this.bodies.values())e.fxEma=0,e.fyEma=0,e.history=[];this.emit()}}setColormap(e){this.renderer.setColormap(e)}bodyLook=null;get autoRangeNow(){return this.autoRange.ready?{lo:this.autoRange.lo,hi:this.autoRange.hi}:null}setRange(e,s){this.range={lo:e,hi:s}}start(){if(this.raf)return;const e=s=>{this.raf=requestAnimationFrame(e),this.frame(s)};this.raf=requestAnimationFrame(e)}stop(){cancelAnimationFrame(this.raf),this.raf=0}lRefCells(){const e=this.order.length?this.bodies.get(this.order[0]):null;return e&&this.map?we(e.body.shape)/this.map.dx:this.solver?this.solver.ny/8:50}frame(e){const s=this.solver,t=this.scene,a=this.map;if(!s||!t||!a)return;const i=this.lastFrame?Math.min(100,e-this.lastFrame):16;this.lastFrame=e,this.fpsEma=this.fpsEma?this.fpsEma*.9+1e3/Math.max(1,i)*.1:60;let r=this.paused||this.unstable?0:Math.round(this.stepsTarget);r>0&&t.view.speed==="realtime"&&(r=Math.max(1,Math.min(r,Math.round(i/1e3/a.dt)))),r=Math.min(te,r);const l=[];for(const P of this.order){const y=this.bodies.get(P);if(r>0&&y.body.spin){const N=this.spinCap(y.body.id)??1/0;y.spinAngle+=Math.sign(y.body.spin)*Math.min(Math.abs(y.body.spin),N)*a.dt*r}const $=this.targetPose(y.body),T={...y.pose};if(r===0)y.pose=$,y.vel={x:0,y:0,theta:0};else{const N=1/Math.max(300,4*y.rCells/.577),D=Math.max(1,y.rCells),[E,Z]=tt(T.x-$.x,y.vel.x,N,r),[L,W]=tt(T.y-$.y,y.vel.y,N,r),[ue,_]=tt(T.theta-$.theta,y.vel.theta,N,r);let z=$.x+E-T.x,ie=$.y+L-T.y,xe=$.theta+ue-T.theta;const $e=Math.hypot(z,ie);$e>Ce*r&&(z*=Ce*r/$e,ie*=Ce*r/$e);const Ve=Ce*r/D;Math.abs(xe)>Ve&&(xe=Math.sign(xe)*Ve);const ft=Math.hypot(z,ie)<$e-1e-9;y.vel={x:ft?z/r:Z,y:ft?ie/r:W,theta:Math.abs(xe)>=Ve?xe/r:_},y.pose={x:T.x+z,y:T.y+ie,theta:T.theta+xe}}l.push({key:`${P}:${y.key}`,sdf:y.sdf,from:r===0?y.pose:T,to:y.pose})}s.setBodies(l);const o=t.view.field==="particles",c=o?t.view.particleColor==="vorticity"?Je.vorticity:Je.speed:Je[t.view.field],d=o?`particles:${t.view.particleColor}`:t.view.field,u=this.device.createCommandEncoder();d!==this.rangeKey&&(this.rangeKey=d,this.rangeField=o?t.view.particleColor==="vorticity"?"vorticity":"speed":t.view.field,this.autoRange={lo:0,hi:1,ready:!1});const{readForces:h}=s.encodeFrame(u,r,{mode:c,uRef:a.u,lRef:this.lRefCells(),rhoRef:this.rhoRef}),f=t.view.autoRange&&this.autoRange.ready?this.autoRange:this.range;this.renderer.setColormap(Zt(t.view));const g=this.latticeView(a.dx),m=t.view,w=m.field==="none",b=w||m.field==="rheoscopic"||o,B=this.markerColors,R={steps:r,u:a.u,nx:s.nx,ny:s.ny,absorbInX:Math.max(0,s.absorbInX),outX:s.spongeX,wrapY:t.tunnel.walls==="periodic"};this.particles.encodeAdvect(u,R,s.macroBuf,s.buffers),this.dye?.encode(u,r,s.macroBuf);const x=m.field==="rheoscopic";if(x&&!this.rheo&&(this.rheo=new Zs(this.device,s.nx,s.ny)),!x&&this.rheo&&(this.rheo.destroy(),this.rheo=null),this.rheo?.encode(u,r,s.macroBuf,{depthCells:s.ny*li,relaxSteps:ci*s.nx/a.u,inletX:Math.max(1,s.absorbInX)}),this.frameNo++,m.streamlines&&(r>0||this.frameNo%10===0)){const P=t.tunnel.height/this.worldView.mpp/mi;this.streamlines.encodeTrace(u,s.macroBuf,s,Math.max(0,s.absorbInX)+1,Math.max(8,P))}const v=this.renderer.size,k=(m.tracers||m.field==="particles")&&this.particles.tracerCount>0;if(k&&B){const P=this.worldView.dpr,y=o?{scalar:s.buffers.scalar,lut:this.renderer.lut,nx:s.nx,ny:s.ny,lo:f.lo,hi:f.hi,lift:.36}:null,$=o?[1,1,1,.66]:b?B.tracerLight:[...B.tracerDark.slice(0,3),.3];this.particles.encodeDraw(u,{...v,dot:(o?.95:.6)*P,tail:r>0?fi[m.trail]*P:0,taper:!0},g,0,{tracers:!0},{tracer:$},y,this.renderer.dummies)}const S=[...this.dyeChannels.entries()].sort((P,y)=>P[1]-y[1]).map(([P])=>{const y=t.rakes.find(T=>T.id===P),$=B?.rakesOnDark[y?.color??0]??[0,0,0,1];return[$[0],$[1],$[2],.95]});this.renderer.encode(u,s,g,f,(o||m.field==="rheoscopic")&&this.bodyLook?{...this.palette,...this.bodyLook}:this.palette,{plain:w,arrows:m.arrows,arrowCells:pi*this.worldView.mpp/a.dx,uRef:a.u,dye:this.dye?this.dye.field:null,dyeColors:S,trail:k&&B?this.particles.trail:null,rheo:this.rheo&&this.rheoLooks[m.rheoPreset]?{field:this.rheo.field,look:this.rheoLooks[m.rheoPreset],sparkle:this.rheo.sparkleWeights}:null},B?P=>{m.streamlines&&this.streamlines.encodeDraw(P,v,g,b?B.streamlineLight:B.streamline,this.worldView.dpr),this.rakeGpu.length&&this.particles.encodeRakeLines(P,this.renderer.format,v,g,b?B.rakesOnDark:B.rakes,this.worldView.dpr)}:void 0);const M=h&&!this.readPending?s.prepareRead(u,r):null,A=performance.now();this.device.queue.submit([u.finish()]),this.simTime+=r*a.dt,r>0&&this.device.queue.onSubmittedWorkDone().then(()=>{const P=performance.now()-A;this.gpuMs=this.gpuMs?this.gpuMs*.8+P*.2:P;const y=this.gpuMs/r,$=ri/Math.max(1e-4,y);this.stepsTarget=Math.max(1,Math.min(te,this.stepsTarget*.7+$*.3))}),M&&(this.readPending=!0,M().then(P=>{this.readPending=!1,P&&this.takeForces(P)})),t.view.autoRange&&e-this.sampledAt>400&&(this.sampledAt=e,s.readSampled().then(P=>P&&this.rangeField&&this.takeSample(P,this.rangeField))),this.stats={adapter:this.adapterName,nx:s.nx,ny:s.ny,stepsPerFrame:r,mlups:r>0&&this.gpuMs>0?s.n*r/(this.gpuMs/1e3)/1e6:this.stats.mlups,speedRatio:r*a.dt/Math.max(.001,i/1e3),simTime:this.simTime,fps:this.fpsEma,map:a,state:this.unstable?"unstable":this.paused?"paused":"running"}}limitedAt=0;limitedTotal=0;takeForces(e){if(e.limited>0&&(this.limitedAt=performance.now(),this.limitedTotal+=e.limited),e.bad>0&&!this.unstable){this.unstable=!0,this.unstableAt=e.badCell&&this.map?{x:(e.badCell.x+.5)*this.map.dx,y:(e.badCell.y+.5)*this.map.dx,poses:this.order.map(s=>({id:s,...this.livePose(s)}))}:null,this.onUnstable?.(),this.emit();return}e.forces.forEach((s,t)=>{const a=this.bodies.get(this.order[t]);if(!a||e.steps===0)return;const i=s.fx/e.steps,r=s.fy/e.steps,l=Math.min(1,e.steps/400);if(a.fxEma=a.fxEma?a.fxEma*(1-l)+i*l:i,a.fyEma=a.fyEma?a.fyEma*(1-l)+r*l:r,this.recordForces)for(let o=0;o<e.steps;o++)a.history.push(s.perStep[2*o],s.perStep[2*o+1])})}takeSample(e,s){if(s!==this.rangeField)return;if(s==="pressure"&&this.solver&&this.map){const o=this.solver.sampleW,c=Math.min(o-1,Math.ceil((this.solver.absorbInX+this.solver.nx*.03)/4)),d=[];for(let u=0;u<this.solver.sampleH;u++){const h=e[u*o+c];Number.isFinite(h)&&d.push(h)}if(d.length>4){d.sort((h,f)=>h-f);const u=d[Math.floor(d.length/2)];if(this.rhoRef+=u*1.5*this.map.u*this.map.u,Math.abs(u)>.02)return}}const t=Array.from(e).filter(o=>Number.isFinite(o));if(t.length<16)return;t.sort((o,c)=>o-c);const a=o=>t[Math.min(t.length-1,Math.max(0,Math.round(o*(t.length-1))))];let i,r;if(s==="vorticity"){const o=t.map(Math.abs).sort((d,u)=>d-u),c=Math.max(1e-6,o[Math.round(.985*(o.length-1))]);i=-c,r=c}else if(s==="pressure"){const o=Math.max(Math.abs(a(.01)),Math.abs(a(.99)),.001);i=-o,r=o}else i=0,r=Math.max(s==="speed"?1.8:1e-6,a(.995));const l=this.autoRange.ready?.3:1;this.autoRange={lo:this.autoRange.lo*(1-l)+i*l,hi:this.autoRange.hi*(1-l)+r*l,ready:!0},this.emit()}sampleField(){return this.solver?this.solver.readSampled():Promise.resolve(null)}latticeView(e){const s=this.worldView;return{scale:s.mpp/s.dpr/e,ox:(s.cx-s.w/2*s.mpp)/e-.5,oy:(s.cy+s.h/2*s.mpp)/e-.5}}destroy(){this.stop(),this.solver?.destroy(),this.particles.destroy(),this.dye?.destroy(),this.rheo?.destroy(),this.streamlines.destroy(),this.renderer.destroy()}}const St=100;class gi{state;listeners=new Set;past=[];future=[];onSceneChange=null;constructor(e){this.state={scene:e,selected:null,save:"saved",saveError:""}}get=()=>this.state;subscribe=e=>(this.listeners.add(e),()=>{this.listeners.delete(e)});set(e){this.state={...this.state,...e};for(const s of this.listeners)s()}commit(e,s=!0){s&&(this.past.push(this.state.scene),this.past.length>St&&this.past.shift(),this.future=[]);const t=this.state.selected,a=t&&(e.bodies.some(i=>i.id===t)||e.rakes.some(i=>i.id===t))?t:null;this.set({scene:e,selected:a}),this.onSceneChange?.(e)}commitFrom(e,s){this.past.push(e),this.past.length>St&&this.past.shift(),this.future=[],this.commit(s,!1)}updateBody(e,s,t=!0){const a=this.state.scene;this.commit({...a,bodies:a.bodies.map(i=>i.id===e?{...i,...s}:i)},t)}get canUndo(){return this.past.length>0}get canRedo(){return this.future.length>0}undo(){const e=this.past.pop();return e?(this.future.push(this.state.scene),this.commit(e,!1),!0):!1}redo(){const e=this.future.pop();return e?(this.past.push(this.state.scene),this.commit(e,!1),!0):!1}select(e){this.set({selected:e})}setSave(e,s=""){this.set({save:e,saveError:s})}}function j(n,e){return ds(n.subscribe,()=>e(n.get()))}const xi=new Intl.NumberFormat("en-US",{maximumSignificantDigits:3}),re=n=>xi.format(n);function Pe({title:n,children:e,attr:s}){return C("section",{className:"t2d-section","data-t2d-section":s??n.toLowerCase(),children:[p("h2",{className:"t2d-section-title",children:n}),p("div",{className:"t2d-section-body",children:e})]})}const ct=n=>n==="imperial"?"ft":"m";function At({label:n,value:e,onCommit:s,error:t,attr:a}){const[i,r]=se(e);return Q(()=>r(e),[e]),p("span",{className:"mgk-type mgk-value-row",children:p("input",{className:"mgk-input mgk-input--wide","aria-label":n,value:i,"data-t2d-text":a,"aria-invalid":t?!0:void 0,onChange:l=>r(l.target.value),onBlur:()=>i!==e&&s(i),onKeyDown:l=>{l.key==="Enter"&&l.target.blur(),l.key==="Escape"&&(r(e),l.target.blur())}})})}function bi({store:n,engine:e,units:s}){const t=j(n,d=>d.scene),a=j(n,d=>d.selected),[,i]=se(0);Q(()=>e.subscribe(()=>i(d=>d+1)),[e]);const r=d=>n.commit({...t,flow:{...t.flow,...d}}),l=t.bodies.find(d=>d.id===a)??t.bodies.find(d=>d.enabled)??null,o=l?e.reynoldsFor(l):null,c=e.lattice;return C(Pe,{title:"Wind",children:[p(U,{label:"Wind speed",help:"The speed of the flow coming in at the left.",children:p(ce,{label:"Wind speed",quantity:"velocity",units:s,valueSi:t.flow.speed,onCommitSi:d=>r({speed:Math.min(G.speed[1],Math.max(G.speed[0],d))})})}),p(U,{label:"Fluid",children:p(J,{label:"Fluid",value:t.flow.fluid,options:Object.entries(Ue).map(([d,u])=>({value:d,label:u.label})),onChange:d=>r({fluid:d})})}),l&&o?C("div",{className:"t2d-re","data-t2d-re":!0,"data-real":o.real,"data-sim":o.sim,children:[p("div",{className:"t2d-re-row",children:C("span",{children:["Reynolds number (",qe(l.shape),", ",re(we(l.shape))," m)"]})}),C("div",{className:"t2d-re-row",children:[p("span",{className:"t2d-re-k",children:"Real"}),p("span",{className:"t2d-re-v","data-t2d-re-real":!0,children:re(o.real)}),p("span",{className:"t2d-re-k",children:"Simulated"}),p("span",{className:"t2d-re-v","data-t2d-re-sim":!0,children:re(o.sim)})]}),c?.capped?C(H,{tone:"warning",children:["This grid resolves a Reynolds number of about ",re(o.sim)," here, so the flow is simulated at that, not at ",re(o.real),". Wakes, shedding and separation show as they do; forces are those of the lower Reynolds number. A finer resolution raises it."]}):null]}):p(H,{children:"Add a body to see its Reynolds number."})]})}function vi({store:n,engine:e,units:s}){const t=j(n,o=>o.scene),[,a]=se(0);Q(()=>e.subscribe(()=>a(o=>o+1)),[e]);const i=o=>n.commit({...t,tunnel:{...t.tunnel,...o}}),r=e.grid,l=o=>{const c=lt(t,me[o]);return`${o[0].toUpperCase()}${o.slice(1)} (${c.nx} × ${c.ny})`};return C(Pe,{title:"Tunnel",children:[p(U,{label:"Length",help:"The tunnel from inlet to outlet.",children:p(ce,{label:"Length",quantity:"length",unit:ct(s),units:s,valueSi:t.tunnel.length,onCommitSi:o=>i({length:Math.min(G.length[1],Math.max(G.length[0],o))})})}),p(U,{label:"Height",children:p(ce,{label:"Height",quantity:"length",unit:ct(s),units:s,valueSi:t.tunnel.height,onCommitSi:o=>i({height:Math.min(G.height[1],Math.max(G.height[0],o))})})}),p(U,{label:"Walls",help:"Open: no walls; the free stream goes on beyond the top and bottom, and waves and wakes pass out through them (a body in open air). Slip walls let the flow slide along them. Solid walls have boundary layers, like a real tunnel. Periodic: what leaves at the top comes in at the bottom.",children:p(J,{label:"Walls",value:t.tunnel.walls,options:[{value:"farfield",label:"Open (no walls)"},{value:"slip",label:"Slip walls"},{value:"noslip",label:"Solid"},{value:"periodic",label:"Periodic"}],onChange:o=>i({walls:o})})}),p(U,{label:"Resolution",help:"Cells in the grid. Finer grids show more detail and a higher Reynolds number, and run slower. Auto picks the finest this GPU runs smoothly.",children:p(J,{label:"Resolution",value:t.tunnel.resolution,options:[{value:"auto",label:t.tunnel.resolution==="auto"&&r?`Auto (${r.nx} × ${r.ny})`:"Auto"},...["low","medium","high","ultra"].map(o=>({value:o,label:l(o)}))],onChange:o=>i({resolution:o})})}),p(H,{children:"The shaded strips at the inlet and the outlet absorb pressure waves; the flow there is not physical."})]})}const wi=[{value:"particles",label:"Flow with particles"},{value:"vorticity",label:"Vorticity"},{value:"speed",label:"Speed"},{value:"pressure",label:"Pressure (Cp)"},{value:"schlieren",label:"Density gradient (schlieren)"},{value:"rheoscopic",label:"Rheoscopic (flakes in a tank)"},{value:"none",label:"None (markers on a dark background)"}];function ki({store:n}){const e=j(n,t=>t.scene),s=t=>n.commit({...e,view:{...e.view,...t}},!1);return C(Pe,{title:"View",children:[p(U,{label:"Show",children:p(J,{label:"Show",value:e.view.field,options:wi,onChange:t=>s({field:t})})}),e.view.field==="particles"?p(U,{label:"Colour by",help:"The flow's speed or its vorticity, drawn under the particles; each particle is a lighter shade of the colour where it is.",children:p(J,{label:"Colour by",value:e.view.particleColor,options:[{value:"speed",label:"Speed"},{value:"vorticity",label:"Vorticity"}],onChange:t=>s({particleColor:t})})}):null,e.view.field==="rheoscopic"?p(U,{label:"Flakes",help:"How the tank looks: the flakes' colour and the two lights over it. Flakes lie flat and tilt with the flow, and catch the light where the flow shears and turns; still water goes dull.",children:p(J,{label:"Flakes",value:e.view.rheoPreset,options:[{value:"kalliroscope",label:"Kalliroscope blue"},{value:"pearl",label:"Pearl"},{value:"copper",label:"Copper"}],onChange:t=>s({rheoPreset:t})})}):null,p(U,{label:"Colour range",help:"Automatic follows the flow; turn it off to fix the range (in the legend's units).",children:p(ge,{label:"Automatic colour range",checked:e.view.autoRange,onChange:t=>s({autoRange:t})})}),p(U,{label:"Run speed",help:"As fast as possible runs as many steps as the GPU manages each frame. Real time slows it to the speed of the real flow, when the GPU is fast enough.",children:p(J,{label:"Run speed",value:e.view.speed,options:[{value:"max",label:"As fast as possible"},{value:"realtime",label:"Real time"}],onChange:t=>s({speed:t})})})]})}function Jt(n,e,s){const{length:t,height:a}=n.tunnel,i=it(Re(e)),r=n.bodies.map(c=>({x:c.x,y:c.y,r:it(Re(c.shape))})),l=(c,d)=>r.every(u=>Math.hypot(u.x-c,u.y-d)>(u.r+i)*1.1);let o={x:t*.35,y:a/2};e:for(const c of[.3,.42,.54,.66,.24])for(const d of[.5,.3,.7,.2,.8]){const u=t*c,h=a*d;if(!(h-i<0||h+i>a)&&l(u,h)){o={x:u,y:h};break e}}return{id:ut(),name:s,shape:e,x:o.x,y:o.y,angle:0,spin:0,enabled:!0,locked:!1}}function Rt(n,e){const s=n.get().scene,t=s.tunnel.height,a={naca:[{kind:"naca",code:"0012",chord:t/4},"NACA 0012"],circle:[{kind:"circle",diameter:t/10},"Cylinder"],rect:[{kind:"rect",width:t/8,height:t/8},"Rectangle"],ellipse:[{kind:"ellipse",width:t/5,height:t/10},"Ellipse"],plate:[{kind:"plate",length:t/4,thickness:t/80},"Flat plate"]},[i,r]=a[e],l=Jt(s,i,r);n.commit({...s,bodies:[...s.bodies,l]}),n.select(l.id)}function Pi({store:n,ws:e}){const s=j(n,o=>o.scene),t=j(n,o=>o.selected),a=ve(null),i=s.bodies.length>=G.maxBodies,r=async o=>{try{const c=Gs(await o.text(),o.name),d=n.get().scene,u=Jt(d,{kind:"dat",name:c.name,x:c.x,y:c.y,chord:d.tunnel.height/4},c.name);n.commit({...d,bodies:[...d.bodies,u]}),n.select(u.id),e.ui.toast(c.warnings.length?`Imported ${c.name}. ${c.warnings.join(" ")}`:`Imported ${c.name}.`,{kind:"success"})}catch(c){e.ui.toast(c instanceof K?`${o.name}: ${c.message}`:`${o.name} could not be read: ${String(c)}`,{kind:"error"})}},l=o=>{const c=n.get().scene;n.commit({...c,bodies:c.bodies.filter(d=>d.id!==o.id)}),e.ui.toast(`Removed ${o.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})};return C(Pe,{title:"Bodies",children:[C("div",{className:"t2d-add-row",children:[p(le,{variant:"secondary",disabled:i,onClick:()=>Rt(n,"naca"),attrs:{"data-t2d-add":"naca"},children:"Add airfoil"}),p(J,{label:"Add shape",value:"",disabled:i,options:[{value:"",label:"Add shape…"},{value:"circle",label:"Cylinder"},{value:"rect",label:"Rectangle"},{value:"ellipse",label:"Ellipse"},{value:"plate",label:"Flat plate"}],onChange:o=>o&&Rt(n,o)}),p(le,{variant:"neutral",disabled:i,onClick:()=>a.current?.click(),attrs:{"data-t2d-import":"1"},children:"Import .dat…"}),p("input",{ref:a,type:"file",accept:".dat,.txt",hidden:!0,"data-t2d-file":!0,onChange:o=>{const c=o.target.files?.[0];o.target.value="",c&&r(c)}})]}),i?C(H,{tone:"warning",children:["A tunnel holds at most ",G.maxBodies," bodies."]}):null,s.bodies.length===0?p(H,{children:"No bodies yet: add an airfoil or a shape, or import an airfoil’s .dat file."}):null,p("ul",{className:"t2d-body-list",role:"listbox","aria-label":"Bodies",children:s.bodies.map(o=>C("li",{role:"option","aria-selected":o.id===t,className:`t2d-body-row${o.id===t?" is-selected":""}${o.enabled?"":" is-off"}`,"data-t2d-body":o.id,onClick:()=>n.select(o.id),children:[p("span",{className:"t2d-body-name",children:o.name}),p("span",{className:"t2d-body-kind",children:qe(o.shape)===o.name?"":qe(o.shape)}),p("button",{type:"button",className:"t2d-icon-btn",title:o.enabled?"Take it out of the flow":"Put it in the flow","aria-label":o.enabled?`Take ${o.name} out of the flow`:`Put ${o.name} in the flow`,"aria-pressed":o.enabled,onClick:c=>{c.stopPropagation(),n.updateBody(o.id,{enabled:!o.enabled})},children:p(Ge,{path:o.enabled?"M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6":"M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6",size:14})}),p("button",{type:"button",className:"t2d-icon-btn",title:`Remove ${o.name}`,"aria-label":`Remove ${o.name}`,onClick:c=>{c.stopPropagation(),l(o)},children:p(Ge,{name:"trash",size:14})})]},o.id))})]})}function $t(n,e){const s=n.spinCap(e.id);return s!==null&&Math.abs(e.spin)>s?s:null}function Mi({store:n,ws:e,units:s,engine:t}){const a=j(n,b=>b.scene),i=j(n,b=>b.selected),[r,l]=se(""),o=a.bodies.find(b=>b.id===i);if(Q(()=>l(""),[i]),!o)return p(Pe,{title:"Body",attr:"body",children:p(H,{children:"Select a body to edit it. Drag a body to move it, and drag the round handle above it to turn it (Shift: whole degrees)."})});const c=ct(s),d=b=>n.updateBody(o.id,b),u=b=>d({shape:{...o.shape,...b}}),h=b=>Math.max(1e-4,Math.min(1e3,b)),f=(b,B,R,x)=>p(U,{label:b,help:x,children:p(ce,{label:b,quantity:"length",unit:c,units:s,valueSi:B,onCommitSi:v=>R(h(v))})});let g=null;switch(o.shape.kind){case"naca":{const b=o.shape.code;g=C(je,{children:[p(U,{label:"NACA designation",help:"4 or 5 digits, such as 2412 or 23012.",children:p(At,{label:"NACA designation",attr:"naca",value:b,error:r,onCommit:B=>{try{const R=dt(B);l("");const x=o.name===`NACA ${b}`?`NACA ${R}`:o.name;d({shape:{...o.shape,code:R},name:x})}catch(R){l(R instanceof de?R.message:String(R))}}})}),r?p(H,{tone:"danger",children:p("span",{"data-t2d-naca-error":!0,children:r})}):null,f("Chord",o.shape.chord,B=>u({chord:B}))]});break}case"dat":g=f("Chord",o.shape.chord,b=>u({chord:b}));break;case"circle":g=f("Diameter",o.shape.diameter,b=>u({diameter:b}));break;case"rect":case"ellipse":g=C(je,{children:[f("Width",o.shape.width,b=>u({width:b}),"Along the flow, before turning."),f("Height",o.shape.height,b=>u({height:b}))]});break;case"plate":g=C(je,{children:[f("Length",o.shape.length,b=>u({length:b})),f("Thickness",o.shape.thickness,b=>u({thickness:b}),"A plate thinner than about two cells of the grid is drawn thicker than it is.")]});break}const m=t.lattice?.dx??0,w=o.shape.kind==="plate"&&m>0&&o.shape.thickness<2*m;return C(Pe,{title:"Body",attr:"body",children:[p(U,{label:"Name",children:p(At,{label:"Name",attr:"name",value:o.name,onCommit:b=>d({name:b.trim().slice(0,80)||o.name})})}),p("div",{className:"t2d-shape-kind",children:qe(o.shape)}),g,w?C(H,{tone:"warning",children:["This plate is thinner than two grid cells (",re(os("length",2*m,s==="imperial"?"in":"mm"))," ",s==="imperial"?"in":"mm","): the flow sees a thicker one."]}):null,f("Position x",o.x,b=>d({x:Math.min(a.tunnel.length,Math.max(0,b))}),o.shape.kind==="naca"||o.shape.kind==="dat"?"Of the quarter chord, from the inlet.":"Of the centre, from the inlet."),p(U,{label:"Position y",help:"From the bottom wall.",children:p(ce,{label:"Position y",quantity:"length",unit:c,units:s,valueSi:o.y,onCommitSi:b=>d({y:Math.min(a.tunnel.height,Math.max(0,b))})})}),p(U,{label:o.shape.kind==="naca"||o.shape.kind==="dat"?"Angle of attack":"Angle",help:"Positive raises the leading (left) side.",children:p(ce,{label:"Angle",unit:"°",valueSi:o.angle,onCommitSi:b=>d({angle:Math.max(-180,Math.min(180,b))})})}),p(U,{label:"Spin",help:"Turns the body continuously; positive is counter-clockwise. A spinning cylinder shows the Magnus effect.",children:p(ce,{label:"Spin",quantity:"angular_velocity",unit:"rpm",units:s,valueSi:o.spin,onCommitSi:b=>d({spin:Math.max(-1e4,Math.min(1e4,b))})})}),$t(t,o)?p(H,{tone:"warning",children:C("span",{"data-t2d-spin-capped":!0,children:["This spin is held to ",re($t(t,o)*(60/(2*Math.PI)))," rpm: the body’s edge would move faster than twice the wind speed, more than the lattice can carry."]})}):null,p(U,{label:"In the flow",children:p(ge,{label:"In the flow",checked:o.enabled,onChange:b=>d({enabled:b})})}),p(U,{label:"Locked",help:"A locked body cannot be dragged or turned with the mouse.",children:p(ge,{label:"Locked",checked:o.locked,onChange:b=>d({locked:b})})}),p("div",{className:"t2d-panel-foot",children:p(le,{variant:"danger",onClick:()=>{const b=n.get().scene;n.commit({...b,bodies:b.bodies.filter(B=>B.id!==o.id)}),e.ui.toast(`Removed ${o.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})},attrs:{"data-t2d-remove":o.id},children:"Remove body"})})]})}const Bi={streaks:"Streaks",timelines:"Timelines",dye:"Dye"},Si=["Blue","Purple","Green","Orange","Sky blue","Pink"],Ai=n=>`var(--mg-series-${n%Fe+1})`;function es({title:n,children:e,attr:s}){return C("section",{className:"t2d-section","data-t2d-section":s,children:[p("h2",{className:"t2d-section-title",children:n}),p("div",{className:"t2d-section-body",children:e})]})}function fe(n,e){const s=n.rakes.filter(t=>t.kind===e.kind);return`${Bi[e.kind]} ${s.indexOf(e)+1}`}function Ri(n,e){const s=n.get().scene,{length:t,height:a}=s.tunnel,i=new Set(s.rakes.map(d=>d.color));let r=0;for(;i.has(r)&&r<Fe-1;)r++;const l=s.rakes.length,o=t*(.1+.02*(l%4)),c={id:Ft(),kind:e,x0:o,y0:a*.3,x1:o,y1:a*.7,emitters:e==="dye"?7:12,color:r,enabled:!0};n.commit({...s,rakes:[...s.rakes,c]}),n.select(c.id)}function $i({store:n,ws:e}){const s=j(n,c=>c.scene),t=j(n,c=>c.selected),a=s.view,i=c=>n.commit({...s,view:{...a,...c}},!1),r=s.rakes.filter(c=>c.kind==="dye").length,l=s.rakes.length>=G.maxRakes,o=c=>{const d=n.get().scene;n.commit({...d,rakes:d.rakes.filter(u=>u.id!==c.id)}),e.ui.toast(`Removed ${fe(s,c)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})};return C(es,{title:"Flow markers",attr:"markers",children:[a.field==="particles"?p(H,{children:"The particles view shows the tracer particles; here you set how many and their trails."}):p(U,{label:"Tracer particles",help:"Particles carried by the flow, drawn faintly over the field.",children:p(ge,{label:"Tracer particles",checked:a.tracers,onChange:c=>i({tracers:c})})}),p(U,{label:"Particle count",children:p(J,{label:"Particle count",value:a.density,disabled:!a.tracers&&a.field!=="particles",options:[{value:"low",label:"Few"},{value:"normal",label:"Normal"},{value:"high",label:"Many"}],onChange:c=>i({density:c})})}),p(U,{label:"Streaks",help:"Each particle is drawn as a short streak along its motion.",children:p(J,{label:"Streaks",value:a.trail,options:[{value:"off",label:"Dots"},{value:"short",label:"Short"},{value:"long",label:"Long"}],onChange:c=>i({trail:c})})}),p(U,{label:"Velocity arrows",children:p(ge,{label:"Velocity arrows",checked:a.arrows,onChange:c=>i({arrows:c})})}),p(U,{label:"Streamlines",help:"Lines along the flow’s direction now, from just past the inlet. In shedding flow they differ from the particles’ paths.",children:p(ge,{label:"Streamlines",checked:a.streamlines,onChange:c=>i({streamlines:c})})}),p("div",{className:"t2d-add-row",children:p(J,{label:"Add rake",value:"",disabled:l,options:[{value:"",label:"Add rake…"},{value:"streaks",label:"Streaks (a thread from each emitter)"},{value:"timelines",label:"Timelines (a line released at intervals)"},{value:"dye",label:"Dye",disabled:r>=G.maxDyeRakes}],onChange:c=>c&&Ri(n,c)})}),l?C(H,{tone:"warning",children:["A tunnel holds at most ",G.maxRakes," rakes."]}):null,r>=G.maxDyeRakes?C(H,{children:["At most ",G.maxDyeRakes," dye rakes: one colour each."]}):null,s.rakes.length?p("ul",{className:"t2d-body-list",role:"listbox","aria-label":"Rakes",children:s.rakes.map(c=>C("li",{role:"option","aria-selected":c.id===t,className:`t2d-body-row${c.id===t?" is-selected":""}${c.enabled?"":" is-off"}`,"data-t2d-rake":c.id,onClick:()=>n.select(c.id),children:[p("span",{className:"t2d-swatch",style:{background:Ai(c.color)}}),p("span",{className:"t2d-body-name",children:fe(s,c)}),p("span",{className:"t2d-body-kind"}),p("button",{type:"button",className:"t2d-icon-btn","aria-pressed":c.enabled,"aria-label":c.enabled?`Stop ${fe(s,c)}`:`Start ${fe(s,c)}`,title:c.enabled?"Stop it":"Start it",onClick:d=>{d.stopPropagation();const u=n.get().scene;n.commit({...u,rakes:u.rakes.map(h=>h.id===c.id?{...h,enabled:!h.enabled}:h)})},children:p(Ge,{path:c.enabled?"M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6":"M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6",size:14})}),p("button",{type:"button",className:"t2d-icon-btn","aria-label":`Remove ${fe(s,c)}`,title:"Remove it",onClick:d=>{d.stopPropagation(),o(c)},children:p(Ge,{name:"trash",size:14})})]},c.id))}):p(H,{children:"A rake releases streaks, timelines or dye from a line you place and drag in the tunnel."})]})}function Ci({store:n,ws:e,units:s,rake:t}){const a=j(n,f=>f.scene),i=s==="imperial"?"ft":"m",r=f=>{const g=n.get().scene;n.commit({...g,rakes:g.rakes.map(m=>m.id===t.id?{...m,...f}:m)})},{length:l,height:o}=a.tunnel,c=f=>Math.min(l,Math.max(0,f)),d=f=>Math.min(o,Math.max(0,f)),u=a.rakes.filter(f=>f.kind==="dye"&&f.id!==t.id).length,h=(f,g,m)=>p(U,{label:f,children:p(ce,{label:f,quantity:"length",unit:i,units:s,valueSi:g,onCommitSi:m})});return C(es,{title:"Rake",attr:"rake",children:[p("div",{className:"t2d-shape-kind","data-t2d-rake-name":!0,children:fe(a,t)}),p(U,{label:"Releases",children:p(J,{label:"Releases",value:t.kind,options:[{value:"streaks",label:"Streaks"},{value:"timelines",label:"Timelines"},{value:"dye",label:"Dye",disabled:u>=G.maxDyeRakes}],onChange:f=>r({kind:f})})}),t.kind!=="timelines"?p(U,{label:"Emitters",help:"Points along the rake that release the markers.",children:p(ce,{label:"Emitters",valueSi:t.emitters,onCommitSi:f=>r({emitters:Math.round(Math.min(G.emitters[1],Math.max(G.emitters[0],f)))})})}):null,p(U,{label:"Colour",children:p(J,{label:"Colour",value:String(t.color),options:Si.map((f,g)=>({value:String(g),label:f})),onChange:f=>r({color:Number(f)})})}),h("Start x",t.x0,f=>r({x0:c(f)})),h("Start y",t.y0,f=>r({y0:d(f)})),h("End x",t.x1,f=>r({x1:c(f)})),h("End y",t.y1,f=>r({y1:d(f)})),p(U,{label:"Releasing",children:p(ge,{label:"Releasing",checked:t.enabled,onChange:f=>r({enabled:f})})}),p(H,{children:"Drag the rake to move it, or one of its ends to stretch or turn it."}),p("div",{className:"t2d-panel-foot",children:p(le,{variant:"danger",attrs:{"data-t2d-remove-rake":t.id},onClick:()=>{const f=n.get().scene;n.commit({...f,rakes:f.rakes.filter(g=>g.id!==t.id)}),e.ui.toast(`Removed ${fe(a,t)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})},children:"Remove rake"})})]})}const Ti=26,st=7,Te=new Map;function Ei(n){const e=JSON.stringify(n.shape);let s=Te.get(e);return s||(s=Re(n.shape),Te.size>64&&Te.clear(),Te.set(e,s)),s}function ye(n,e){return Ut(Ei(n),{x:e.x,y:e.y,theta:-e.angle*Math.PI/180})}function ts(n,e){const s=n.worldView,t=(o,c)=>({x:s.w/2+(o-s.cx)/s.mpp,y:s.h/2-(c-s.cy)/s.mpp}),a=n.livePose(e.id)??{x:e.x,y:e.y,angle:e.angle},i=ye(e,a);let r=1/0;for(let o=1;o<i.length;o+=2)r=Math.min(r,t(0,i[o]).y);const l=t(a.x,a.y);return{x:l.x,y:r-Ti,cx:l.x,cy:l.y}}function _e(n,e){const s=n.worldView,{length:t,height:a}=e.tunnel,i=Math.max(t/Math.max(50,s.w-32),a/Math.max(50,s.h-32));n.worldView={...s,cx:t/2,cy:a/2,mpp:i}}function Ui({engine:n,store:e,onStatus:s}){const t=ve(null),a=ve(null),i=ve(null),r=ve(null),l=ve("");Q(()=>{const x=t.current,v=new ResizeObserver(()=>{const k=x.getBoundingClientRect(),S=window.devicePixelRatio||1,M=n.canvas;M.width=Math.max(1,Math.round(k.width*S)),M.height=Math.max(1,Math.round(k.height*S));const A=i.current;A.width=M.width,A.height=M.height,n.worldView={...n.worldView,w:k.width,h:k.height,dpr:S};const P=e.get().scene,y=`${P.tunnel.length}x${P.tunnel.height}`;l.current!==y&&(_e(n,P),l.current=y)});return v.observe(x),()=>v.disconnect()},[n,e]),Q(()=>{const x=a.current;return x.replaceWith(n.canvas),n.canvas.className="t2d-canvas",n.canvas.setAttribute("data-t2d-canvas","1"),()=>{n.canvas.replaceWith(x)}},[n]),Q(()=>e.subscribe(()=>{const x=e.get().scene,v=`${x.tunnel.length}x${x.tunnel.height}`;l.current&&l.current!==v&&(_e(n,x),l.current=v)}),[n,e]);const o=(x,v)=>{const k=t.current.getBoundingClientRect(),S=n.worldView;return{x:S.cx+(x-k.left-S.w/2)*S.mpp,y:S.cy-(v-k.top-S.h/2)*S.mpp}},c=(x,v)=>{const k=n.worldView;return{x:k.w/2+(x-k.cx)/k.mpp,y:k.h/2-(v-k.cy)/k.mpp}},d=x=>n.livePose(x.id)??{x:x.x,y:x.y,angle:x.angle},u=x=>ts(n,x);Q(()=>{let x=0;const v=getComputedStyle(document.documentElement),k=v.getPropertyValue("--t2d-select").trim()||"black",S=v.getPropertyValue("--t2d-ghost").trim()||"gray",M=v.getPropertyValue("--mg-bg").trim()||"white",A=()=>{x=requestAnimationFrame(A);const P=i.current;if(!P)return;const y=P.getContext("2d"),$=n.worldView;y.setTransform($.dpr,0,0,$.dpr,0,0),y.clearRect(0,0,$.w,$.h);const{scene:T,selected:N}=e.get(),D=r.current;for(const E of T.rakes){const Z=v.getPropertyValue(`--mg-series-${E.color%6+1}`).trim()||k,L=c(E.x0,E.y0),W=c(E.x1,E.y1),ue=E.id===N;if(y.globalAlpha=E.enabled?1:.45,y.beginPath(),y.moveTo(L.x,L.y),y.lineTo(W.x,W.y),y.strokeStyle=Z,y.lineWidth=ue?3:2,y.setLineDash(E.kind==="timelines"?[6,4]:[]),y.stroke(),y.setLineDash([]),E.kind!=="timelines"){y.fillStyle=Z;for(let _=0;_<E.emitters;_++){const z=E.emitters===1?.5:_/(E.emitters-1);y.beginPath(),y.arc(L.x+(W.x-L.x)*z,L.y+(W.y-L.y)*z,2.5,0,Math.PI*2),y.fill()}}if(ue)for(const _ of[L,W])y.fillStyle=M,y.strokeStyle=Z,y.lineWidth=2,y.fillRect(_.x-5,_.y-5,10,10),y.strokeRect(_.x-5,_.y-5,10,10);y.globalAlpha=1}for(const E of T.bodies){const Z=E.id===N,L=D&&(D.kind==="move"||D.kind==="turn")&&D.id===E.id?{x:D.kind==="move"?D.bodyX:D.x,y:D.kind==="move"?D.bodyY:D.y,angle:D.angle}:null,W=d(E),ue=_=>{y.beginPath();for(let z=0;z<_.length;z+=2){const ie=c(_[z],_[z+1]);z===0?y.moveTo(ie.x,ie.y):y.lineTo(ie.x,ie.y)}y.closePath()};if(E.enabled||(ue(ye(E,W)),y.setLineDash([4,4]),y.strokeStyle=S,y.lineWidth=1.5,y.stroke(),y.setLineDash([])),L&&(Math.abs(L.x-W.x)>1e-6||Math.abs(L.y-W.y)>1e-6||Math.abs(L.angle-W.angle)>.001)&&(ue(ye(E,L)),y.setLineDash([5,4]),y.strokeStyle=S,y.lineWidth=1.5,y.stroke(),y.setLineDash([])),Z){if(ue(ye(E,W)),y.strokeStyle=k,y.lineWidth=2,y.stroke(),!E.locked){const z=u(E);y.beginPath(),y.moveTo(z.cx,z.cy),y.lineTo(z.x,z.y+st),y.strokeStyle=k,y.lineWidth=1,y.stroke(),y.beginPath(),y.arc(z.x,z.y,st,0,Math.PI*2),y.fillStyle=M,y.fill(),y.lineWidth=2,y.stroke()}const _=c(W.x,W.y);y.beginPath(),y.moveTo(_.x-5,_.y),y.lineTo(_.x+5,_.y),y.moveTo(_.x,_.y-5),y.lineTo(_.x,_.y+5),y.lineWidth=1.5,y.stroke()}}};return x=requestAnimationFrame(A),()=>cancelAnimationFrame(x)},[n,e]);const h=(x,v)=>{const k=e.get().scene.bodies;for(let S=k.length-1;S>=0;S--){const M=k[S];if(Ne(ye(M,d(M)),x,v))return M}return null},f=(x,v)=>{const k=t.current.getBoundingClientRect(),S=x-k.left,M=v-k.top,{scene:A,selected:P}=e.get();for(let y=A.rakes.length-1;y>=0;y--){const $=A.rakes[y],T=c($.x0,$.y0),N=c($.x1,$.y1);if($.id===P){if(Math.hypot(S-T.x,M-T.y)<=8)return{rake:$,part:"start"};if(Math.hypot(S-N.x,M-N.y)<=8)return{rake:$,part:"end"}}const D=N.x-T.x,E=N.y-T.y,Z=D*D+E*E,L=Z>0?Math.max(0,Math.min(1,((S-T.x)*D+(M-T.y)*E)/Z)):0;if(Math.hypot(S-(T.x+L*D),M-(T.y+L*E))<=6)return{rake:$,part:"all"}}return null},g=(x,v)=>{const k=e.get().scene.tunnel;return{x:Math.min(k.length,Math.max(0,x)),y:Math.min(k.height,Math.max(0,v))}},m=x=>{x.target.setPointerCapture(x.pointerId);const v=o(x.clientX,x.clientY),k=n.worldView;if(x.button===1){r.current={kind:"pan",startX:x.clientX,startY:x.clientY,cx:k.cx,cy:k.cy};return}if(x.button!==0)return;const{scene:S,selected:M}=e.get(),A=S.bodies.find($=>$.id===M);if(A&&!A.locked){const $=u(A),T=t.current.getBoundingClientRect();if(Math.hypot(x.clientX-T.left-$.x,x.clientY-T.top-$.y)<=st+4){const N=d(A),D=Math.atan2(v.y-N.y,v.x-N.x);r.current={kind:"turn",id:A.id,startAngle:A.angle,pointerStart:D,angle:A.angle,x:A.x,y:A.y};return}}const P=f(x.clientX,x.clientY);if(P){e.select(P.rake.id),r.current={kind:"rake",id:P.rake.id,part:P.part,startX:v.x,startY:v.y,r0:P.rake,before:e.get().scene};return}const y=h(v.x,v.y);if(y){e.select(y.id),y.locked||(r.current={kind:"move",id:y.id,startX:v.x,startY:v.y,bodyX:y.x,bodyY:y.y,angle:y.angle,moved:!1});return}e.select(null),r.current={kind:"pan",startX:x.clientX,startY:x.clientY,cx:k.cx,cy:k.cy}},w=x=>{const v=r.current;if(!v){const M=o(x.clientX,x.clientY),A=f(x.clientX,x.clientY),P=A?null:h(M.x,M.y);t.current.style.cursor=A?A.part==="all"?"move":"crosshair":P&&!P.locked?"grab":"default";return}if(v.kind==="rake"){const M=o(x.clientX,x.clientY),A=M.x-v.startX,P=M.y-v.startY,y=v.r0,$=g(y.x0+(v.part==="end"?0:A),y.y0+(v.part==="end"?0:P)),T=g(y.x1+(v.part==="start"?0:A),y.y1+(v.part==="start"?0:P)),N=e.get().scene;e.commit({...N,rakes:N.rakes.map(D=>D.id===v.id?{...D,x0:$.x,y0:$.y,x1:T.x,y1:T.y}:D)},!1);return}if(v.kind==="pan"){const M=n.worldView;n.worldView={...M,cx:v.cx-(x.clientX-v.startX)*M.mpp,cy:v.cy+(x.clientY-v.startY)*M.mpp};return}const k=o(x.clientX,x.clientY),S=e.get().scene.bodies.find(M=>M.id===v.id);if(S)if(v.kind==="move"){const M=g(S.x+(k.x-v.startX),S.y+(k.y-v.startY));v.bodyX=M.x,v.bodyY=M.y,v.moved=!0,t.current.style.cursor="grabbing",n.setTarget(v.id,{x:M.x,y:M.y,angle:v.angle}),s?.(`x ${M.x.toFixed(3)} m, y ${M.y.toFixed(3)} m`)}else{const M=d(S),A=Math.atan2(k.y-M.y,k.x-M.x);let P=v.startAngle-(A-v.pointerStart)*180/Math.PI;P=((P+180)%360+360)%360-180,x.shiftKey&&(P=Math.round(P)),v.angle=P,n.setTarget(v.id,{x:v.x,y:v.y,angle:P}),s?.(`Angle ${P.toFixed(1)}°`)}},b=()=>{const x=r.current;if(r.current=null,s?.(""),!(!x||x.kind==="pan")){if(x.kind==="rake"){const v=e.get().scene;v!==x.before&&e.commitFrom(x.before,v);return}x.kind==="move"&&x.moved&&e.updateBody(x.id,{x:x.bodyX,y:x.bodyY}),x.kind==="turn"&&e.updateBody(x.id,{angle:x.angle}),n.setTarget(x.id,null)}};return C("div",{ref:t,className:"t2d-viewport","data-t2d-viewport":!0,onPointerDown:m,onPointerMove:w,onPointerUp:b,onPointerCancel:b,onWheel:x=>{const v=n.worldView,k=o(x.clientX,x.clientY),S=e.get().scene.tunnel,M=Math.min(Math.max(S.length,S.height)/50,Math.max(S.length/1e5,v.mpp*Math.exp(x.deltaY*.0015)));n.worldView={...v,mpp:M};const A=o(x.clientX,x.clientY);n.worldView={...n.worldView,cx:n.worldView.cx+(k.x-A.x),cy:n.worldView.cy+(k.y-A.y)}},onDoubleClick:x=>{const v=o(x.clientX,x.clientY);h(v.x,v.y)||_e(n,e.get().scene)},onContextMenu:x=>x.preventDefault(),children:[p("canvas",{ref:a}),p("canvas",{ref:i,className:"t2d-overlay"})]})}function Di(n,e,s){const t=e.flow.speed;switch(n){case"vorticity":return{title:"Vorticity",unit:"1/s",k:t/s,centred:!0};case"speed":return{title:"Speed",unit:"m/s",k:t,centred:!1};case"pressure":return{title:"Pressure coefficient Cp",unit:"",k:1,centred:!0};case"schlieren":return{title:"Density gradient (relative)",unit:"",k:1,centred:!1};case"particles":return e.view.particleColor==="vorticity"?{title:"Vorticity",unit:"1/s",k:t/s,centred:!0}:{title:"Speed",unit:"m/s",k:t,centred:!1};case"none":case"rheoscopic":return{title:"",unit:"",k:1,centred:!1}}}function ss(n){const[,e]=se(0);Q(()=>{const s=setInterval(()=>e(t=>t+1),n);return()=>clearInterval(s)},[n])}function _i({engine:n,store:e}){ss(300);const s=j(e,i=>i.save),t=n.stats,a={saved:"Saved",pending:"Not saved yet",saving:"Saving…",failed:"Not saved",conflict:"Saved elsewhere"}[s];return C("div",{className:"t2d-status","data-t2d-status":!0,"data-state":t.state,"data-steps":t.stepsPerFrame,"data-grid":`${t.nx}x${t.ny}`,children:[p("span",{title:"The GPU the flow runs on",children:t.adapter}),C("span",{children:[t.nx," × ",t.ny," cells"]}),C("span",{children:[t.stepsPerFrame," steps a frame"]}),p("span",{title:"Simulated seconds per second",children:t.state==="running"?`×${re(t.speedRatio)} real time`:t.state==="paused"?"Paused":"Stopped"}),performance.now()-n.limitedAt<2e3?p("span",{className:"t2d-squeeze","data-t2d-squeeze":!0,title:"Where the flow went faster, or was squeezed harder, than the lattice can carry (a body dragged fast, or a gap closing between bodies), it is held to those limits there, so the flow at that spot is approximate.",children:"Flow held to its limits where it moved too fast"}):null,C("span",{"data-t2d-simtime":t.simTime,children:["t = ",t.simTime<1?`${(t.simTime*1e3).toPrecision(3)} ms`:`${t.simTime.toPrecision(4)} s`]}),p("span",{className:`t2d-save t2d-save--${s}`,"data-t2d-save":s,children:a})]})}function Gi({engine:n,store:e}){ss(400);const s=j(e,d=>d.scene),t=s.bodies.find(d=>d.enabled),a=t?we(t.shape):s.tunnel.height/8,i=Di(s.view.field,s,a),r=n.autoRangeNow,l=s.view.autoRange?r?.lo??s.view.min/i.k:s.view.min/i.k,o=s.view.autoRange?r?.hi??s.view.max/i.k:s.view.max/i.k;if(Q(()=>{s.view.autoRange||n.setRange(s.view.min/i.k,s.view.max/i.k)},[n,s.view.autoRange,s.view.min,s.view.max,i.k]),s.view.field==="none"||s.view.field==="rheoscopic")return null;const c=Zt(s.view);return C("div",{className:"t2d-legend","data-t2d-legend":!0,"data-lo":l*i.k,"data-hi":o*i.k,children:[c==="inferno"?p(Ni,{map:c,min:l*i.k,max:o*i.k,title:i.title,unit:i.unit}):p(ls,{map:c,min:l*i.k,max:o*i.k,title:i.title,unit:i.unit,centred:i.centred,ticks:5,format:re}),s.view.autoRange?null:p(qi,{lo:s.view.min,hi:s.view.max,onCommit:(d,u)=>e.commit({...s,view:{...s.view,min:d,max:u}},!1)})]})}function Ni({map:n,min:e,max:s,title:t,unit:a}){const i=zt(n),r=Array.from({length:9},(o,c)=>{const d=Math.round(c/8*255);return`rgb(${i[3*d]}, ${i[3*d+1]}, ${i[3*d+2]}) ${c/8*100}%`}),l=Array.from({length:5},(o,c)=>e+(s-e)*c/4);return C("div",{className:"t2d-maplegend",children:[C("div",{className:"mgk-legend-title",children:[t,a?` (${a})`:""]}),p("div",{className:"mgk-legend-bar",style:{background:`linear-gradient(to right, ${r.join(", ")})`}}),p("div",{className:"mgk-legend-ticks",children:l.map((o,c)=>p("span",{children:re(o)},c))})]})}function qi({lo:n,hi:e,onCommit:s}){const[t,a]=se(String(n)),[i,r]=se(String(e));Q(()=>{a(String(n)),r(String(e))},[n,e]);const l=()=>{const o=Number(t),c=Number(i);Number.isFinite(o)&&Number.isFinite(c)&&c>o?s(o,c):(a(String(n)),r(String(e)))};return C("div",{className:"t2d-range",children:[p("input",{className:"mgk-input","aria-label":"Colour range minimum",value:t,onChange:o=>a(o.target.value),onBlur:l,onKeyDown:o=>o.key==="Enter"&&l()}),p("span",{children:"to"}),p("input",{className:"mgk-input","aria-label":"Colour range maximum",value:i,onChange:o=>r(o.target.value),onBlur:l,onKeyDown:o=>o.key==="Enter"&&l()})]})}function zi({ws:n,store:e,engine:s,units:t,problem:a}){const[i,r]=se(t),[l,o]=se(!1),[c,d]=se(!1),[u,h]=se(""),f=j(e,B=>B.save),g=j(e,B=>B.saveError),m=j(e,B=>B.scene.rakes.find(R=>R.id===B.selected)??null);Q(()=>n.on("units",r),[n]),Q(()=>(s.onUnstable=()=>{d(!0),n.ui.toast("The flow became unstable and was stopped. Reset the flow to start again.",{kind:"error"})},()=>{s.onUnstable=null}),[s,n]);const w=()=>{s.paused=!s.paused,o(s.paused)},b=()=>{s.resetFlow(),d(!1)};return Q(()=>{const B=R=>{const x=R.target;if(x&&(x.tagName==="INPUT"||x.tagName==="SELECT"||x.tagName==="TEXTAREA"||x.isContentEditable))return;const v=R.ctrlKey||R.metaKey;if(v&&R.key.toLowerCase()==="z"&&!R.shiftKey)R.preventDefault(),e.undo();else if(v&&(R.key.toLowerCase()==="y"||R.key.toLowerCase()==="z"&&R.shiftKey))R.preventDefault(),e.redo();else if(R.key===" "&&!v)R.preventDefault(),w();else if((R.key==="Delete"||R.key==="Backspace")&&e.get().selected){R.preventDefault();const k=e.get().scene,S=k.bodies.find(A=>A.id===e.get().selected),M=k.rakes.find(A=>A.id===e.get().selected);S?(e.commit({...k,bodies:k.bodies.filter(A=>A.id!==S.id)}),n.ui.toast(`Removed ${S.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})):M&&(e.commit({...k,rakes:k.rakes.filter(A=>A.id!==M.id)}),n.ui.toast(`Removed ${fe(k,M)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"}))}else if(R.key==="Escape")e.select(null);else if(R.key.startsWith("Arrow")&&e.get().selected){const k=e.get().scene,S=k.bodies.find(P=>P.id===e.get().selected);if(!S||S.locked)return;R.preventDefault();const M=k.tunnel.height/200*(R.shiftKey?10:1),A={ArrowLeft:[-M,0],ArrowRight:[M,0],ArrowUp:[0,M],ArrowDown:[0,-M]}[R.key]??[0,0];e.updateBody(S.id,{x:Math.min(k.tunnel.length,Math.max(0,S.x+A[0])),y:Math.min(k.tunnel.height,Math.max(0,S.y+A[1]))})}};return window.addEventListener("keydown",B),()=>window.removeEventListener("keydown",B)}),C("div",{className:"t2d-app","data-t2d-app":!0,children:[C("header",{className:"t2d-toolbar",role:"toolbar","aria-label":"Tunnel",children:[p(le,{variant:l?"primary":"secondary",onClick:w,attrs:{"data-t2d-play":l?"paused":"running"},title:"Space",children:l?"Run":"Pause"}),p(le,{variant:"neutral",onClick:b,attrs:{"data-t2d-reset":"1"},title:"Start the flow again from a uniform stream",children:"Reset flow"}),p("span",{className:"t2d-sep"}),p(le,{variant:"neutral",onClick:()=>e.undo(),disabled:!e.canUndo,title:"Ctrl+Z",attrs:{"data-t2d-undo":"1"},children:"Undo"}),p(le,{variant:"neutral",onClick:()=>e.redo(),disabled:!e.canRedo,title:"Ctrl+Y",attrs:{"data-t2d-redo":"1"},children:"Redo"}),p(le,{variant:"neutral",onClick:()=>_e(s,e.get().scene),title:"Double-click empty space",attrs:{"data-t2d-fit":"1"},children:"Fit view"}),p("span",{className:"t2d-toolbar-hint","data-t2d-hint":!0,children:u})]}),C("div",{className:"t2d-main",children:[C("aside",{className:"t2d-side",children:[p(bi,{store:e,engine:s,units:i}),p(Pi,{store:e,ws:n}),p($i,{store:e,ws:n}),p(vi,{store:e,engine:s,units:i}),p(ki,{store:e})]}),C("div",{className:"t2d-stage",children:[a?p("div",{className:"t2d-banner",children:p(Xe,{reason:`The saved tunnel could not be read (${a}), so a new one was started.`,role:"alert"})}):null,f==="conflict"||f==="failed"?p("div",{className:"t2d-banner","data-t2d-save-problem":!0,children:p(Xe,{reason:f==="conflict"?g:`The tunnel could not be saved: ${g}`,role:"alert"})}):null,c?p("div",{className:"t2d-banner","data-t2d-unstable":!0,children:p(Xe,{reason:"The flow became unstable and was stopped.",fix:{label:"Reset flow",onFix:b},role:"alert"})}):null,p(Ui,{engine:s,store:e,onStatus:h}),p(Gi,{engine:s,store:e}),p(_i,{engine:s,store:e})]}),p("aside",{className:"t2d-side t2d-side--right",children:m?p(Ci,{store:e,ws:n,units:i,rake:m}):p(Mi,{store:e,ws:n,units:i,engine:s})})]})]})}const Fi=400,is=n=>`studies/${n}/scene.json`;async function Li(n,e){const s=is(e),t=await n.files.stat(s);if(!t)return{scene:De(),etag:null,problem:""};const a=await n.files.read(s);if(!a)return{scene:De(),etag:null,problem:""};try{return{scene:Ls(JSON.parse(new TextDecoder().decode(a))),etag:t.etag,problem:""}}catch(i){return{scene:De(),etag:t.etag,problem:i instanceof Error?i.message:String(i)}}}class Ii{constructor(e,s,t,a){this.ws=e,this.store=s,this.studyId=t,this.etag=a}timer=null;latest=null;writing=null;schedule(e){this.store.get().save!=="conflict"&&(this.latest=e,this.store.setSave("pending"),this.ws.nav.setDirty(!0,"The tunnel’s last changes are not saved yet."),this.timer&&clearTimeout(this.timer),this.timer=setTimeout(()=>void this.flush(),Fi))}async flush(){this.timer&&clearTimeout(this.timer),this.timer=null,this.writing&&await this.writing;const e=this.latest;e&&(this.latest=null,this.store.setSave("saving"),this.writing=(async()=>{try{const s=await this.ws.files.write(is(this.studyId),JSON.stringify(e,null,1),{ifMatch:this.etag});this.etag=s.etag,this.latest||(this.store.setSave("saved"),await this.ws.nav.setDirty(!1))}catch(s){s?.code==="changed"?(this.store.setSave("conflict","This tunnel was saved from another tab. Reopen it to see that version; changes here are not saved."),await this.ws.nav.setDirty(!1)):(this.latest=this.latest??e,this.store.setSave("failed",s instanceof Error?s.message:String(s)))}finally{this.writing=null}})(),await this.writing)}async create(e){this.latest=e,await this.flush()}}function Oi(n,e,s,t,a=.3){const i=2/(s*s*t),r=n.length,l=Math.floor(r*(1-a));let o=0;for(let m=l;m<r;m++)o+=e[m]*i;o/=r-l;const c=[];for(let m=l+1;m<r;m++){const w=e[m-1]*i-o,b=e[m]*i-o;w<0&&b>=0&&c.push(m-1+w/(w-b))}let d=-1/0,u=0,h=-1/0;for(let m=l;m<r;m++)d=Math.max(d,n[m]*i),u+=n[m]*i,h=Math.max(h,e[m]*i);const f=c.length-1,g=f>0?(c[c.length-1]-c[0])/f:NaN;return{St:t/(g*s),cdMax:d,cdMean:u/(r-l),clMax:h,periods:f}}async function Vi(n,e=20,s=200,t){const a=Math.round(4.1*e),i=22*e,r=.05,l=2/3*r,o=l*e/100,c=new ot(n,{nx:i,ny:a,walls:"noslip",profile:1,absorbing:!1});c.setPhysics({u:r,tau:3*o+.5,smagorinsky:!1,smagCs:0}),c.reset(0);const d=Re({kind:"circle",diameter:e}),u=Dt(d),h={x:2*e,y:-.5+2*e,theta:0};c.setBodies([{key:"cyl",sdf:u,from:h,to:h}]);const f=Math.ceil(s*e/l),g=new Float64Array(f),m=new Float64Array(f),w=performance.now();let b=0,B=0;const R=Math.ceil(2*e/l);for(let v=0;v<f;){const k=Math.min(te,f-v,v<R?200:te),S=v<R?.5*(1-Math.cos(Math.PI*v/R)):1;c.setPhysics({u:r*S,tau:3*o+.5,smagorinsky:!1,smagCs:0});const M=n.createCommandEncoder();c.encodeFrame(M,k,{mode:1,uRef:r,lRef:e});const A=c.prepareRead(M,k);n.queue.submit([M.finish()]);const P=await A();if(!P)throw new Error("The force readback failed.");for(let y=0;y<k;y++)g[v+y]=P.forces[0].perStep[2*y],m[v+y]=P.forces[0].perStep[2*y+1];if(b+=P.bad,B+=P.limited,v+=k,b)break}c.destroy();const x=Oi(g,m,l,e);return{N:e,steps:f,seconds:(performance.now()-w)/1e3,...x,bad:b,limited:B}}function Xi({store:n,engine:e,device:s}){window.__TUNNEL__={ready:!0,scene:()=>n.get().scene,selected:()=>n.get().selected,save:()=>n.get().save,stats:()=>({...e.stats,map:e.lattice,unstableAt:e.unstableAt,limitedTotal:e.limitedTotal}),view:()=>({...e.worldView}),livePose:t=>e.livePose(t),bodyLive:t=>e.bodyLive(t),sampleField:async()=>{const t=await e.sampleField();return t?Array.from(t,a=>Number.isFinite(a)?a:null):null},toScreen:(t,a)=>{const i=e.worldView,r=e.canvas.getBoundingClientRect();return{x:r.left+i.w/2+(t-i.cx)/i.mpp,y:r.top+i.h/2-(a-i.cy)/i.mpp}},turnHandle:t=>{const a=n.get().scene.bodies.find(l=>l.id===t);if(!a)return null;const i=e.canvas.getBoundingClientRect(),r=ts(e,a);return{x:i.left+r.x,y:i.top+r.y,cx:i.left+r.cx,cy:i.top+r.cy}},validate:(t=20,a=200)=>Vi(s,t,a),particles:async()=>{const t=await e.readParticles();if(!t)return null;const a=n.get().scene,i=t.dx,r=a.bodies.filter(h=>h.enabled).map(h=>({b:h,poly:ye(h,e.livePose(h.id)??{x:h.x,y:h.y,angle:h.angle})}));let l=0,o=0,c=0;const d=[],u=t.pools.map(h=>({id:h.id,alive:0,maxX:-1/0}));for(let h=0;h<t.meta.length/4;h++){if(t.meta[4*h+3]<.5||t.meta[4*h]<0)continue;const f=(t.pos[4*h]+.5)*i,g=(t.pos[4*h+1]+.5)*i;if(!Number.isFinite(f)||!Number.isFinite(g)){o++;continue}const m=t.meta[4*h+1];if(m<0)l++;else{const w=u[m];w&&(w.alive++,w.maxX=Math.max(w.maxX,f))}for(const{poly:w}of r)Ne(w,f,g)&&We(w,f,g)<-.5*i&&(c++,d.length<6&&d.push({x:f,y:g,depthCells:We(w,f,g)/i,age:t.meta[4*h],src:t.meta[4*h+1],prevX:(t.pos[4*h+2]+.5)*i,prevY:(t.pos[4*h+3]+.5)*i}))}return{tracers:t.tracers,tracersAlive:l,nan:o,inside:c,insideAt:d,pools:u}},dye:async()=>{const t=await e.readDye();if(!t)return null;const a=[0,0,0,0],i=[-1/0,-1/0,-1/0,-1/0],l=n.get().scene.bodies.filter(c=>c.enabled).map(c=>ye(c,e.livePose(c.id)??{x:c.x,y:c.y,angle:c.angle}));let o=0;for(const c of l){let d=1/0,u=-1/0,h=1/0,f=-1/0;for(let g=0;g<c.length;g+=2)d=Math.min(d,c[g]),u=Math.max(u,c[g]),h=Math.min(h,c[g+1]),f=Math.max(f,c[g+1]);for(let g=Math.max(0,Math.floor(h/t.dx));g<=Math.min(t.ny-1,Math.ceil(f/t.dx));g++)for(let m=Math.max(0,Math.floor(d/t.dx));m<=Math.min(t.nx-1,Math.ceil(u/t.dx));m++){const w=(m+.5)*t.dx,b=(g+.5)*t.dx;if(Ne(c,w,b)&&We(c,w,b)<-t.dx){const B=g*t.nx+m;o+=t.data[4*B]+t.data[4*B+1]+t.data[4*B+2]+t.data[4*B+3]}}}for(let c=0;c<t.nx*t.ny;c++)for(let d=0;d<4;d++){const u=t.data[4*c+d];u>.05&&(a[d]+=u,i[d]=Math.max(i[d],(c%t.nx+.5)*t.dx))}return{channels:t.channels,sums:a,maxX:i,insideSum:o}},streamlines:()=>e.streamlineCount,rheo:()=>e.readRheo()}}function ji(){return[...Es(),{label:"particles advect",code:Xt()},{label:"particles draw",code:jt()},{label:"trail fade",code:Yt},{label:"rake lines",code:Wt()},{label:"dye advect",code:It()},{label:"dye correct",code:Ot()},{label:"dye inject",code:Vt()},{label:"streamlines trace",code:Ht},{label:"streamlines draw",code:Qt},{label:"rheoscopic",code:Kt()}]}async function Wi(n){for(const e of ji()){const t=(await n.createShaderModule({code:e.code,label:e.label}).getCompilationInfo()).messages.find(a=>a.type==="error");if(t)return`${e.label} shader, line ${t.lineNum}: ${t.message}`}return null}const Yi=document.getElementById("t2d-root"),ns=us(Yi);function be(n,e){ns.render(Ae("div",{className:"t2d-fatal",role:"alert","data-t2d-fatal":"1"},Ae(cs,null,Ae("strong",null,n),Ae("p",null,e))))}function O(n){const e=getComputedStyle(document.documentElement).getPropertyValue(n).trim(),s=document.createElement("canvas").getContext("2d");s.fillStyle=e||"black";const t=s.fillStyle;if(t.startsWith("#"))return[parseInt(t.slice(1,3),16)/255,parseInt(t.slice(3,5),16)/255,parseInt(t.slice(5,7),16)/255];const a=/rgba?\(([^)]+)\)/.exec(t),i=a?a[1].split(",").map(Number):[0,0,0];return[i[0]/255,i[1]/255,i[2]/255]}async function Ki(){let n;try{n=await as({timeoutMs:15e3})}catch(m){be("The wind tunnel could not start",`${m instanceof Error?m.message:String(m)}. Open the tunnel from its project in Magnusim.`);return}if(!("gpu"in navigator)||!navigator.gpu){be("This wind tunnel needs WebGPU","This browser does not offer WebGPU (navigator.gpu is missing), and the tunnel solves the flow on the GPU with it. Open Magnusim in a current Chrome or Edge on a computer with a GPU driver from the last few years.");return}const e=await navigator.gpu.requestAdapter({powerPreference:"high-performance"}).catch(()=>null);if(!e){be("This wind tunnel needs WebGPU","The browser offers WebGPU but found no GPU it can use (requestAdapter gave none). Check that hardware acceleration is on in the browser’s settings and that the graphics driver is up to date.");return}let s;try{s=await e.requestDevice({requiredLimits:{maxStorageBufferBindingSize:e.limits.maxStorageBufferBindingSize,maxBufferSize:e.limits.maxBufferSize}})}catch(m){be("The GPU could not be opened",String(m));return}const t=await Wi(s);if(t){be("The wind tunnel’s GPU code did not compile on this GPU",`${t}. Please report this with the GPU’s name (${e.info?.vendor??""} ${e.info?.architecture??""}).`);return}const a=e.info,i=a?.description||[a?.vendor,a?.architecture].filter(Boolean).join(" ")||"GPU";s.lost.then(m=>{m.reason!=="destroyed"&&be("The GPU stopped the wind tunnel",`${m.message||"The GPU device was lost"}. Leave the tunnel and open it again; the scene is saved.`)});const r=n.context.study,l=await Li(n,r.id),o=new gi(l.scene),c=new Ii(n,o,r.id,l.etag);l.etag||await c.create(l.scene);const d={bg:O("--t2d-bg"),body:O("--t2d-body"),edge:O("--t2d-edge"),zone:[...O("--t2d-zone"),.14],plain:O("--t2d-plain"),arrow:[...O("--t2d-arrow"),.85]},u=document.createElement("canvas"),h=new yi(s,u,i,d),f=m=>{const w=16*Math.PI/180,b=m*Math.PI/180;return[Math.cos(w)*Math.cos(b),Math.cos(w)*Math.sin(b),Math.sin(w)]},g=(m,w,b,B,R)=>({base:O(`--t2d-rheo-${m}-base`),l1:{dir:f(135),color:O(`--t2d-rheo-${m}-light1`),diffuse:w},l2:{dir:f(-45),color:O(`--t2d-rheo-${m}-light2`),diffuse:b},sharp:B,glint:R});h.rheoLooks={kalliroscope:g("kalliroscope",.16,.12,12,1.8),pearl:g("pearl",.18,.14,12,1.6),copper:g("copper",.17,.12,10,1.8)},h.bodyLook={body:O("--t2d-body-dark"),edge:O("--t2d-edge-light")},h.markerColors={tracerDark:[...O("--t2d-particle-dark"),.5],tracerLight:[...O("--t2d-particle-light"),.85],rakes:[1,2,3,4,5,6].map(m=>[...O(`--mg-series-${m}`),.85]),rakesOnDark:[1,2,3,4,5,6].map(m=>{const w=O(`--mg-series-${m}`);return[w[0]+(1-w[0])*.35,w[1]+(1-w[1])*.35,w[2]+(1-w[2])*.35,.85]}),streamline:[...O("--t2d-streamline"),.4],streamlineLight:[...O("--t2d-particle-light"),.35]},o.onSceneChange=m=>{c.schedule(m),h.setScene(m)},await h.setScene(l.scene),h.start(),Xi({store:o,engine:h,device:s}),window.addEventListener("pagehide",()=>void c.flush()),ns.render(Ae(zi,{ws:n,store:o,engine:h,units:n.context.units,problem:l.problem}))}Ki();
