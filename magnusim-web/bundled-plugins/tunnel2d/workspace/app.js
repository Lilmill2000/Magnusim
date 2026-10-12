import{connect as Ht}from"@magnusim/workspace";import{colormapRgb as Zt,Field as D,NumberUnitInput as oe,Select as se,Hint as H,Button as ae,Icon as Ue,Toggle as pe,fromSi as Jt,DisabledReason as Le,ColorLegend as Qt,EmptyState as es}from"@magnusim/plugin-ui";import{useSyncExternalStore as ts,useState as te,useEffect as j,useRef as be,createElement as Be}from"react";import{createRoot as ss}from"react-dom/client";import{jsxs as C,jsx as f,Fragment as Oe}from"react/jsx-runtime";const Mt={1:[.058,361.4],2:[.126,51.64],3:[.2025,15.957],4:[.29,6.643],5:[.391,3.23]},Pt={2:[.13,51.99,764e-6],3:[.217,15.793,.00677],4:[.318,6.52,.0303],5:[.441,3.191,.1355]},at=20,rt=250,ns=81;class le extends Error{}const is=/^\s*(?:naca\s*)?(\d{4,5})\s*$/i;function st(i){const e=is.exec(String(i??""));if(!e)throw new le("Enter a NACA 4-digit or 5-digit designation, such as 2412 or 23012.");const s=e[1];return s.length===4?as(s):rs(s),s}const ie=(i,e)=>Number(i[e]);function as(i){const e=ie(i,0),s=ie(i,1);if(Number(i.slice(2))<=0)throw new le(`NACA ${i}: the thickness (last two digits) must be above 0.`);if(e===0!=(s===0))throw new le(`NACA ${i}: camber and its position must both be 0 or both be above 0.`)}function rs(i){const e=ie(i,0),s=ie(i,1),t=ie(i,2);if(Number(i.slice(3))<=0)throw new le(`NACA ${i}: the thickness (last two digits) must be above 0.`);if(e===0)throw new le(`NACA ${i}: the first digit (design lift) must be above 0.`);if(t!==0&&t!==1)throw new le(`NACA ${i}: the third digit must be 0 (standard) or 1 (reflexed).`);const n=t?Pt:Mt;if(!(s in n)){const r=Object.keys(n).sort().join(", ");throw new le(`NACA ${i}: a ${t?"reflexed":"standard"} 5-digit mean line has its second digit in ${r}.`)}}function os(i,e,s){const t=s?-.1036:-.1015;return 5*e*(.2969*Math.sqrt(i)-.126*i-.3516*i**2+.2843*i**3+t*i**4)}function ls(i,e){const s=ie(i,0)/100,t=ie(i,1)/10;return s===0?[0,0]:e<t?[s/t**2*(2*t*e-e**2),2*s/t**2*(t-e)]:[s/(1-t)**2*(1-2*t+2*t*e-e**2),2*s/(1-t)**2*(t-e)]}function cs(i,e){const s=ie(i,0),t=ie(i,1),a=ie(i,2),n=3*s/20/.3;if(!a){const[d,h]=Mt[t];return e<d?[n*(h/6*(e**3-3*d*e**2+d**2*(3-d)*e)),n*(h/6*(3*e**2-6*d*e+d**2*(3-d)))]:[n*(h*d**3/6*(1-e)),n*(-h*d**3/6)]}const[r,c,o]=Pt[t],l=o*(1-r)**3;return e<r?[n*(c/6*((e-r)**3-l*e-r**3*e+r**3)),n*(c/6*(3*(e-r)**2-l-r**3))]:[n*(c/6*(o*(e-r)**3-l*e-r**3*e+r**3)),n*(c/6*(3*o*(e-r)**2-l-r**3))]}function ot(i){const e=Math.round(i*1e10)/1e10;return e===0?0:e}function ds(i,e=ns,s=!1){const t=st(i),a=Math.trunc(e);if(!(a>=at&&a<=rt))throw new le(`Points per side must be from ${at} to ${rt}.`);const n=Number(t.slice(-2))/100,r=t.length===4?ls:cs,c=[],o=[];for(let d=0;d<a;d++){const h=Math.PI*d/(a-1),m=.5*(1-Math.cos(h)),u=os(m,n,s),[g,p]=r(t,m),A=Math.atan(p);c.push([m-u*Math.sin(A),g+u*Math.cos(A)]),o.push([m+u*Math.sin(A),g-u*Math.cos(A)])}const l=[...c.reverse(),...o.slice(1)];return{code:t,name:`NACA ${t}`,x:l.map(d=>ot(d[0])),y:l.map(d=>ot(d[1]))}}function Bt(i){let e=0;const s=i.length/2;for(let t=0;t<s;t++){const a=(t+1)%s;e+=i[2*t]*i[2*a+1]-i[2*a]*i[2*t+1]}return e/2}function us(i){if(Bt(i)>=0)return i;const e=[];for(let s=i.length/2-1;s>=0;s--)e.push(i[2*s],i[2*s+1]);return e}function hs(i){let e=1/0,s=1/0,t=-1/0,a=-1/0;for(let n=0;n<i.length;n+=2)e=Math.min(e,i[n]),t=Math.max(t,i[n]),s=Math.min(s,i[n+1]),a=Math.max(a,i[n+1]);return{x0:e,y0:s,x1:t,y1:a}}function Ke(i){let e=0;for(let s=0;s<i.length;s+=2)e=Math.max(e,Math.hypot(i[s],i[s+1]));return e}function St(i,e,s=1){const t=Math.cos(e.theta),a=Math.sin(e.theta),n=new Array(i.length);for(let r=0;r<i.length;r+=2){const c=i[r]*s,o=i[r+1]*s;n[r]=e.x+t*c-a*o,n[r+1]=e.y+a*c+t*o}return n}function De(i,e,s){let t=!1;const a=i.length/2;for(let n=0,r=a-1;n<a;r=n++){const c=i[2*n],o=i[2*n+1],l=i[2*r],d=i[2*r+1];o>s!=d>s&&e<(l-c)*(s-o)/(d-o)+c&&(t=!t)}return t}function fs(i,e,s,t,a,n){const r=a-s,c=n-t,o=r*r+c*c;let l=o>0?((i-s)*r+(e-t)*c)/o:0;return l=Math.max(0,Math.min(1,l)),Math.hypot(i-(s+l*r),e-(t+l*c))}function lt(i,e,s){let t=1/0;const a=i.length/2;for(let n=0;n<a;n++){const r=(n+1)%a;t=Math.min(t,fs(e,s,i[2*n],i[2*n+1],i[2*r],i[2*r+1]))}return De(i,e,s)?-t:t}function ms(i){const e=i.length/2,s=(t,a,n,r,c,o)=>(n-t)*(o-a)-(r-a)*(c-t);for(let t=0;t<e;t++){const a=(t+1)%e;for(let n=t+1;n<e;n++){const r=(n+1)%e;if(n===a||r===t)continue;const[c,o,l,d]=[i[2*t],i[2*t+1],i[2*a],i[2*a+1]],[h,m,u,g]=[i[2*n],i[2*n+1],i[2*r],i[2*r+1]],p=s(c,o,l,d,h,m),A=s(c,o,l,d,u,g),v=s(h,m,u,g,c,o),S=s(h,m,u,g,l,d);if(p*A<0&&v*S<0)return!0}}return!1}const ps=256;function ct(i,e,s=ps){const t=[];for(let a=0;a<s;a++){const n=2*Math.PI*a/s;t.push(i*Math.cos(n),e*Math.sin(n))}return t}function dt(i,e){return[-i/2,-e/2,i/2,-e/2,i/2,e/2,-i/2,e/2]}function ut(i,e,s){const t=[];for(let a=0;a<i.length;a++)t.push((i[a]-.25)*s,e[a]*s);return us(t)}function Se(i){switch(i.kind){case"naca":{const e=ds(i.code,121);return ut(e.x,e.y,i.chord)}case"dat":return ut(i.x,i.y,i.chord);case"circle":return ct(i.diameter/2,i.diameter/2);case"ellipse":return ct(i.width/2,i.height/2);case"rect":return dt(i.width,i.height);case"plate":return dt(i.length,i.thickness)}}function xe(i){switch(i.kind){case"naca":case"dat":return i.chord;case"circle":return i.diameter;case"ellipse":case"rect":return i.height;case"plate":return i.length}}function Ge(i){switch(i.kind){case"naca":return`NACA ${i.code}`;case"dat":return i.name;case"circle":return"Cylinder";case"ellipse":return"Ellipse";case"rect":return"Rectangle";case"plate":return"Flat plate"}}const ys=4,gs=2,bs=4e6;function At(i,e=ys){const s=hs(i),t=e+2;let a=1/gs,n=Math.ceil((s.x1-s.x0+2*t)/a)+1,r=Math.ceil((s.y1-s.y0+2*t)/a)+1;for(;n*r>bs;)a*=1.5,n=Math.ceil((s.x1-s.x0+2*t)/a)+1,r=Math.ceil((s.y1-s.y0+2*t)/a)+1;const c=s.x0-t,o=s.y0-t,l=new Float32Array(n*r).fill(e),d=i.length/2;for(let u=0;u<d;u++){const g=i[2*u],p=i[2*u+1],A=i[2*((u+1)%d)],v=i[2*((u+1)%d)+1],S=Math.max(0,Math.floor((Math.min(g,A)-e-c)/a)),B=Math.min(n-1,Math.ceil((Math.max(g,A)+e-c)/a)),y=Math.max(0,Math.floor((Math.min(p,v)-e-o)/a)),x=Math.min(r-1,Math.ceil((Math.max(p,v)+e-o)/a)),w=A-g,k=v-p,M=w*w+k*k;for(let P=y;P<=x;P++){const $=o+P*a;for(let b=S;b<=B;b++){const E=c+b*a;let U=M>0?((E-g)*w+($-p)*k)/M:0;U=U<0?0:U>1?1:U;const F=E-(g+U*w),T=$-(p+U*k),R=Math.sqrt(F*F+T*T),Z=P*n+b;R<l[Z]&&(l[Z]=R)}}}const h=[];for(let u=0;u<r;u++){const g=o+u*a;h.length=0;for(let p=0;p<d;p++){const A=i[2*p+1],v=i[2*((p+1)%d)+1];if(A>g!=v>g){const S=i[2*p],B=i[2*((p+1)%d)];h.push(S+(g-A)*(B-S)/(v-A))}}h.sort((p,A)=>p-A);for(let p=0;p+1<h.length;p+=2){const A=Math.max(0,Math.ceil((h[p]-c)/a)),v=Math.min(n-1,Math.floor((h[p+1]-c)/a));for(let S=A;S<=v;S++)l[u*n+S]=-l[u*n+S]}}let m=0;for(let u=0;u<d;u++)m=Math.max(m,Math.hypot(i[2*u],i[2*u+1]));return{data:l,w:n,h:r,ox:c,oy:o,texel:a,band:e,bound:m+1}}const X=128,q=8,ee=2048,Ne=1048576,Q=ee*q*2,Ve=Q+4,ke=.1,Me=.2,ne=[0,1,0,-1,0,1,-1,-1,1],ue=[0,0,1,0,-1,1,1,-1,-1],fe=[4/9,1/9,1/9,1/9,1/9,1/36,1/36,1/36,1/36],xs=[0,3,4,1,2,7,8,5,6],vs=[0,1,4,3,2,8,7,6,5],ws={slip:0,noslip:1,periodic:2},I=i=>i.toFixed(10),z=i=>i.toFixed(1),Ie=`
struct Params {
  nx: u32, ny: u32, n: u32, nBodies: u32,
  omega: f32, smag: f32, uIn: f32, absorb: f32,
  absorbIn: f32, spongeX: f32, frameSteps: u32, profile: u32,
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
fn sdfAt(p: vec2f, near: u32, bp: ptr<function, array<vec4f, ${q}>>) -> Hit {
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
fn poses(p: vec2f, t: f32, bp: ptr<function, array<vec4f, ${q}>>) -> u32 {
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
`,qe=`
const CXF = array<f32, 9>(${ne.map(z).join(", ")});
const CYF = array<f32, 9>(${ue.map(z).join(", ")});
const WF = array<f32, 9>(${fe.map(I).join(", ")});
`;function $t(){const i=(n,r)=>`fin[${n}u * P.n + ${r}]`,e=(n,r,c,o)=>`(${I(fe[n])} * ${r} * (1.0 + 3.0 * (${z(ne[n])} * ${c} + ${z(ue[n])} * ${o}) + 4.5 * (${z(ne[n])} * ${c} + ${z(ue[n])} * ${o}) * (${z(ne[n])} * ${c} + ${z(ue[n])} * ${o}) - 1.5 * (${c} * ${c} + ${o} * ${o})))`;let s="";for(let n=1;n<9;n++){const r=xs[n],c=ne[n],o=ue[n];let l="";c>0&&(l=`if (x == 0u) { f${n} = 0.0; } else `),c<0&&(l=`if (x == P.nx - 1u) { f${n} = ${i(n,"idx")}; } else `);let d="";if(o!==0){const m=o>0?"y == 0u":"y == P.ny - 1u",u=o>0?"P.ny - 1u":"0u";d=`if (${m}) {
      if (WALLS == 1u) { f${n} = ${i(r,"idx")}; }
      else if (WALLS == 0u) { f${n} = ${i(vs[n],`u32(i32(x) - (${c})) + y * P.nx`)}; }
      else { f${n} = ${i(n,`u32(i32(x) - (${c})) + ${u} * P.nx`)}; }
    } else `}const h=`(${z(c)} * uw.x + ${z(o)} * uw.y)`;s+=`
  var f${n}: f32;
  ${l}${d}{
    let sx = i32(x) - (${c});
    let sy = i32(y) - (${o});
    let src = u32(sx) + u32(sy) * P.nx;
    var hit = Hit(4.0, 0u);
    if (near != 0u) { hit = sdfAt(vec2f(f32(sx), f32(sy)), near, &bp); }
    if (hit.d < 0.0) {
      // Bouzidi: direction ${r} leaves this cell into the body, q of the way to its wall.
      var q = clamp(d0 / (d0 - hit.d), 0.001, 1.0);
      let bx = i32(x) + (${c});
      let by = i32(y) + (${o});
      var behindFluid = bx >= 0 && by >= 0 && bx < i32(P.nx) && by < i32(P.ny);
      if (behindFluid && q < 0.5) { behindFluid = sdfAt(vec2f(f32(bx), f32(by)), near, &bp).d >= 0.0; }
      if (q < 0.5 && !behindFluid) { q = 0.5; }
      let c = bp[hit.b].xy;
      let uw = wallU(hit.b, vec2f(f32(sx), f32(sy)), c);
      let fi = ${i(r,"idx")};
      let mw = ${I(6*fe[n])} * ${h};
      if (q < 0.5) { f${n} = 2.0 * q * fi + (1.0 - 2.0 * q) * ${i(r,"u32(bx) + u32(by) * P.nx")} + mw; }
      else { f${n} = fi / (2.0 * q) + (2.0 * q - 1.0) / (2.0 * q) * ${i(n,"idx")} + mw / (2.0 * q); }
      let slot = (S.slot * ${q}u + hit.b) * 2u;
      atomicAdd(&force[slot], i32(round((${z(ne[r])} * (fi + f${n}) - uw.x * (fi - f${n})) * ${Ne}.0)));
      atomicAdd(&force[slot + 1u], i32(round((${z(ue[r])} * (fi + f${n}) - uw.y * (fi - f${n})) * ${Ne}.0)));
    } else {
      f${n} = ${i(n,"src")};
    }
  }`}let t="";for(let n=0;n<9;n++)t+=`  let e${n} = ${e(n,"rho","ux","uy")};
`;const a=n=>`(f${n} - e${n})`;t+=`
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
  let omP = 1.0 / tP;
  let axxy = 2.0 * ux * pxy + uy * pxx;
  let axyy = 2.0 * uy * pxy + ux * pyy;
  let keep = 1.0 - omP;
`;for(let n=0;n<9;n++){const r=ne[n],c=ue[n],o=r*r-1/3,l=c*c-1/3,d=r*c,h=r*r*c-c/3,m=r*c*c-r/3;t+=`  var o${n} = ${I(fe[n])} * rho * (1.0 + 3.0 * (${I(r)} * ux + ${I(c)} * uy) + 4.5 * (${I(o)} * ux * ux + ${I(l)} * uy * uy + ${I(2*d)} * ux * uy) + 13.5 * (${I(h)} * ux * ux * uy + ${I(m)} * ux * uy * uy))
    + keep * ${I(fe[n])} * (4.5 * (${I(o)} * pxx + ${I(l)} * pyy + ${I(2*d)} * pxy) + 13.5 * (${I(h)} * axxy + ${I(m)} * axyy));
`}return t+=`  if (sig > 0.0) {
    let uT = P.uIn;
${Array.from({length:9},(n,r)=>`    o${r} = mix(o${r}, ${I(fe[r])} * (1.0 + 3.0 * ${z(ne[r])} * uT + 4.5 * ${z(ne[r]*ne[r])} * uT * uT - 1.5 * uT * uT), sig);`).join(`
`)}
  }
${Array.from({length:9},(n,r)=>`  fout[${r}u * P.n + idx] = o${r};`).join(`
`)}
`,`
override WALLS: u32 = 0u;
override SMAG: bool = false;
struct Step { slot: u32, p0: u32, p1: u32, p2: u32 };
@group(0) @binding(0) var<storage, read> fin: array<f32>;
@group(0) @binding(1) var<storage, read_write> fout: array<f32>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
@group(0) @binding(5) var<storage, read_write> force: array<atomic<i32>>;
@group(1) @binding(0) var<uniform> S: Step;
${qe}
${Ie}

@compute @workgroup_size(${X})
fn step(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${X}u;
  if (idx >= P.n) { return; }
  let x = idx % P.nx;
  let y = idx / P.nx;
  let xf = f32(x);
  let p = vec2f(xf, f32(y));
  var bp: array<vec4f, ${q}>;
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
  var f0 = ${i(0,"idx")};
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
    atomicAdd(&force[${Q}u], 1);
    atomicMax(&force[${Q+1}u], i32(P.n - idx));
  }
  var ux = (f1 - f3 + f5 - f6 - f7 + f8) / rho;
  var uy = (f2 - f4 + f5 + f6 - f7 - f8) / rho;
  // The limiter: flow squeezed in a gap two moving bodies close has nowhere to go. A cell
  // whose density leaves ±${ke*100} % or whose speed passes ${Me} (4 x the inflow) is put
  // back to equilibrium inside those bounds. Ordinary flow here stays within about 1 %, so
  // only such pockets are touched; each use is counted and the page says so.
  let usq0 = ux * ux + uy * uy;
  if (!(rho >= ${1-ke} && rho <= ${1+ke} && usq0 <= ${Me*Me})) {
    atomicAdd(&force[${Q+2}u], 1);
    let ok = rho == rho && ux == ux && uy == uy;
    rho = select(1.0, clamp(rho, ${1-ke}, ${1+ke}), ok);
    var uc = select(vec2f(0.0), vec2f(ux, uy), ok);
    let m = length(uc);
    if (m > ${Me}) { uc = uc * (${Me} / m); }
    ux = uc.x;
    uy = uc.y;
${Array.from({length:9},(n,r)=>`    f${r} = feqAt(${r}u, rho, uc);`).join(`
`)}
  }
${t}
}
`}function Ct(){return`
@group(0) @binding(0) var<storage, read> fin: array<f32>;
@group(0) @binding(1) var<storage, read_write> mac: array<vec4f>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
${qe}
${Ie}

@compute @workgroup_size(${X})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${X}u;
  if (idx >= P.n) { return; }
  let p = vec2f(f32(idx % P.nx), f32(idx / P.nx));
  var bp: array<vec4f, ${q}>;
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
`}function Rt(){return`
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

@compute @workgroup_size(${X})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${X}u;
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
`}function Tt(){return`
struct View {
  scale: f32, ox: f32, oy: f32, lo: f32,
  hi: f32, nxf: f32, nyf: f32, absorbIn: f32,
  spongeX: f32, uRef: f32, arrowCells: f32, flags: u32,
  bg: vec4f, body: vec4f, edge: vec4f, zone: vec4f,
  plain: vec4f, arrow: vec4f,
  dye: array<vec4f, 4>,
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
${qe}
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
  if ((Vw.flags & 1u) != 0u) {
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
  var bp: array<vec4f, ${q}>;
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
`}function ks(){return[{label:"step",code:$t()},{label:"macro",code:Ct()},{label:"field",code:Rt()},{label:"render",code:Tt()}]}class Ms{device;ctx;format;pipe;viewBuf;lutBuf;lutName="";dummyBuf;dummyTex;constructor(e,s){this.device=e;const t=s.getContext("webgpu");if(!t)throw new Error("The canvas has no WebGPU context.");this.ctx=t,this.format=navigator.gpu.getPreferredCanvasFormat(),t.configure({device:e,format:this.format,alphaMode:"opaque"});const a=e.createShaderModule({code:Tt(),label:"tunnel render"});this.pipe=e.createRenderPipeline({layout:"auto",vertex:{module:a,entryPoint:"vs"},fragment:{module:a,entryPoint:"fs",targets:[{format:this.format}]},primitive:{topology:"triangle-list"}}),this.viewBuf=e.createBuffer({size:208,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.lutBuf=e.createBuffer({size:256*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.dummyBuf=e.createBuffer({size:64,usage:GPUBufferUsage.STORAGE}),this.dummyTex=e.createTexture({size:[1,1],format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING})}setColormap(e){if(e===this.lutName)return;const s=Zt(e),t=s.length/3,a=new Float32Array(256*4);for(let n=0;n<256;n++){const r=Math.min(t-1,Math.round(n/255*(t-1)));a[4*n]=s[3*r]/255,a[4*n+1]=s[3*r+1]/255,a[4*n+2]=s[3*r+2]/255,a[4*n+3]=1}this.device.queue.writeBuffer(this.lutBuf,0,a),this.lutName=e}get size(){const e=this.ctx.getCurrentTexture();return{w:e.width,h:e.height}}encode(e,s,t,a,n,r,c){const o=s.buffers,l=this.device.createBindGroup({layout:this.pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:o.scalar}},{binding:1,resource:{buffer:this.viewBuf}},{binding:2,resource:{buffer:o.params}},{binding:3,resource:{buffer:o.bodies}},{binding:4,resource:{buffer:o.sdf}},{binding:5,resource:{buffer:this.lutBuf}},{binding:6,resource:{buffer:s.macroBuf}},{binding:7,resource:{buffer:r.dye??this.dummyBuf}},{binding:8,resource:(r.trail??this.dummyTex).createView()}]}),d=(r.plain?1:0)|(r.arrows?2:0)|(r.dye?4:0)|(r.trail?8:0),h=new ArrayBuffer(208),m=new Float32Array(h),u=new Uint32Array(h);m.set([t.scale,t.ox,t.oy,a.lo,a.hi,s.nx,s.ny,s.absorbInX,s.spongeX,r.uRef,r.arrowCells]),u[11]=d,m.set([...n.bg,1],12),m.set([...n.body,1],16),m.set([...n.edge,1],20),m.set(n.zone,24),m.set([...n.plain,1],28),m.set(n.arrow,32);for(let p=0;p<4;p++)m.set(r.dyeColors[p]??[0,0,0,0],36+4*p);this.device.queue.writeBuffer(this.viewBuf,0,h);const g=e.beginRenderPass({colorAttachments:[{view:this.ctx.getCurrentTexture().createView(),loadOp:"clear",storeOp:"store",clearValue:{r:n.bg[0],g:n.bg[1],b:n.bg[2],a:1}}]});g.setPipeline(this.pipe),g.setBindGroup(0,l),g.draw(3),c?.(g),g.end()}destroy(){this.viewBuf.destroy(),this.lutBuf.destroy(),this.dummyBuf.destroy(),this.dummyTex.destroy(),this.ctx.unconfigure()}}const ht=256*1024,Ps=80,He=10,Ze=1e3;class W extends Error{}function Bs(i){const e=i.trim().split(/[\s,;]+/).filter(Boolean),s=[];for(const t of e){const a=Number(t.replace(/[Dd]/,"e"));if(t===""||Number.isNaN(a))return null;s.push(a)}return s}function Xe(i){return i.replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,Ps)}const Je=(i,e)=>i.flatMap((s,t)=>[s,e[t]]);function Ss(i,e=""){if(new TextEncoder().encode(i).length>ht)throw new W(`The file is larger than ${ht/1024} KB; an airfoil file is a few KB.`);const s=i.replace(/^﻿/,"").split(/\r\n|\r|\n/);let t="";const a=[];let n=!1;if(s.forEach((h,m)=>{const u=m+1,g=h.trim();if(!g||g.startsWith("#"))return;const p=Bs(g);if(!n&&!t&&(p===null||p.length!==2)){t=Xe(g);return}if(p===null)throw new W(`Line ${u}: expected two numbers (x and y), found “${Xe(g).slice(0,40)}”.`);if(p.length!==2)throw new W(`Line ${u}: expected two numbers (x and y), found ${p.length}.`);if(!p.every(Number.isFinite))throw new W(`Line ${u}: the numbers must be finite.`);a.push([u,p[0],p[1]]),n=!0}),!t){const h=String(e||"").replace(/\\/g,"/").split("/").pop()?.replace(/\.[A-Za-z0-9]{1,4}$/,"")??"";t=Xe(h)||"Imported airfoil"}if(!a.length)throw new W("The file has no coordinates.");const r=[],c=a[0];let o,l,d;return c[1]>=2&&c[2]>=2&&Number.isInteger(c[1])&&Number.isInteger(c[2])?([o,l]=As(a,c[1],c[2]),d="lednicer",r.push("Read as a Lednicer file (upper and lower surfaces apart) and joined in Selig order.")):(o=a.map(h=>h[1]),l=a.map(h=>h[2]),d="selig"),[o,l]=$s(o,l,r),{name:t,x:o,y:l,layout:d,warnings:r}}function As(i,e,s){const t=i.slice(1);if(t.length!==e+s)throw new W(`Line ${i[0][0]}: the file says ${e} upper and ${s} lower points, but it has ${t.length} points.`);const a=t.slice(0,e),n=t.slice(e),r=a.map(d=>d[1]).reverse(),c=a.map(d=>d[2]).reverse();let o=n.map(d=>d[1]),l=n.map(d=>d[2]);return n.length&&a.length&&Math.abs(n[0][1]-a[0][1])<=1e-9&&Math.abs(n[0][2]-a[0][2])<=1e-9&&(o=o.slice(1),l=l.slice(1)),[[...r,...o],[...c,...l]]}function $s(i,e,s){let t=[i[0]],a=[e[0]],n=0;for(let u=1;u<i.length;u++){if(Math.abs(i[u]-t[t.length-1])<=1e-12&&Math.abs(e[u]-a[a.length-1])<=1e-12){n++;continue}t.push(i[u]),a.push(e[u])}if(n&&s.push(`Removed ${n} repeated point${n!==1?"s":""}.`),t.length<He)throw new W(`The file has ${t.length} points; an airfoil needs at least ${He}.`);if(t.length>Ze)throw new W(`The file has ${t.length} points; at most ${Ze} are read.`);const r=Math.min(...t),o=Math.max(...t)-r;if(o<=0)throw new W("Every point has the same x: this is not an airfoil.");const l=t.indexOf(r);if(l===0||l===t.length-1)throw new W("The points must start at the trailing edge, run over one surface to the leading edge and back along the other (Selig order).");if(Math.min(t[0],t[t.length-1])<r+.5*o)throw new W("The first and last points must be at the trailing edge (Selig order).");const d=t[l],h=a[l],m=Math.min(...t.map((u,g)=>Math.hypot(u,a[g])))<=.002;if((Math.abs(o-1)>.001||!m)&&(t=t.map(u=>(u-d)/o),a=a.map(u=>(u-h)/o),s.push(Math.abs(o-1)>.001?`Scaled to chord 1 (it was ${Number(o.toPrecision(6))}).`:"Moved so that the leading edge is at (0, 0).")),Bt(Je(t,a))<0&&(t=t.reverse(),a=a.reverse(),s.push("The points ran over the lower surface first; reversed to Selig order (upper surface first).")),ms(Je(t,a)))throw new W("The outline crosses itself.");if(Cs(t,a)<.002)throw new W("The section is thinner than 0.2 % of its chord.");return[t,a]}function Cs(i,e){const s=Je(i,e);let t=0;for(let a=1;a<50;a++){const n=a/50,r=[],c=s.length/2;for(let o=0;o<c;o++){const l=(o+1)%c,[d,h,m,u]=[s[2*o],s[2*o+1],s[2*l],s[2*l+1]];d>n!=m>n&&r.push(h+(n-d)*(u-h)/(m-d))}r.length>=2&&(t=Math.max(t,Math.max(...r)-Math.min(...r)))}return t}const Ce=2,Re={air:{label:"Air (20 °C)",nu:1516e-8,rho:1.204},water:{label:"Water (20 °C)",nu:1004e-9,rho:998.2}},G={length:[.01,1e3],height:[.005,1e3],speed:[1e-4,340],maxBodies:8,maxRakes:8,maxDyeRakes:4,emitters:[1,64]},_e=6;let ve=0;function nt(){return ve=(ve+1)%1e6,`b${Date.now().toString(36)}${ve.toString(36)}`}function Et(){return ve=(ve+1)%1e6,`r${Date.now().toString(36)}${ve.toString(36)}`}function Te(){return{version:Ce,tunnel:{length:8,height:4,walls:"slip",resolution:"auto"},flow:{speed:10,fluid:"air"},bodies:[{id:nt(),name:"NACA 2412",shape:{kind:"naca",code:"2412",chord:1},x:2.5,y:2,angle:6,spin:0,enabled:!0,locked:!1}],rakes:[],view:{field:"vorticity",autoRange:!0,min:-10,max:10,speed:"max",tracers:!0,density:"normal",trail:"short",arrows:!1,streamlines:!1}}}class Fe extends Error{}const N=(i,e,s=-1/0,t=1/0)=>{const a=Number(i);if(!Number.isFinite(a)||a<s||a>t)throw new Fe(`${e} must be a number from ${s} to ${t}.`);return a},ce=(i,e,s)=>e.includes(i)?i:s;function Rs(i){const e=i??{};switch(e.kind){case"naca":return{kind:"naca",code:st(String(e.code)),chord:N(e.chord,"Chord",1e-4,1e3)};case"dat":{const s=Array.isArray(e.x)?e.x.map(Number):[],t=Array.isArray(e.y)?e.y.map(Number):[];if(s.length!==t.length||s.length<He||s.length>Ze||![...s,...t].every(Number.isFinite))throw new Fe("An imported airfoil needs matching x and y lists of finite numbers.");return{kind:"dat",name:String(e.name??"Imported airfoil").slice(0,80),x:s,y:t,chord:N(e.chord,"Chord",1e-4,1e3)}}case"circle":return{kind:"circle",diameter:N(e.diameter,"Diameter",1e-4,1e3)};case"rect":return{kind:"rect",width:N(e.width,"Width",1e-4,1e3),height:N(e.height,"Height",1e-4,1e3)};case"ellipse":return{kind:"ellipse",width:N(e.width,"Width",1e-4,1e3),height:N(e.height,"Height",1e-4,1e3)};case"plate":return{kind:"plate",length:N(e.length,"Length",1e-4,1e3),thickness:N(e.thickness,"Thickness",1e-5,1e3)};default:throw new Fe(`Unknown body shape “${String(e.kind)}”.`)}}function Ts(i){const e=i??{},s=Number(e.version??Ce);if(s>Ce)throw new Fe(`This tunnel was saved by a newer version of the plugin (scene version ${s}).`);const t=Te(),a=e.tunnel??{},n=e.flow??{},r=e.view??{},c=(Array.isArray(e.bodies)?e.bodies:[]).slice(0,G.maxBodies).map(l=>({id:typeof l?.id=="string"&&l.id?l.id.slice(0,40):nt(),name:String(l?.name??"Body").slice(0,80),shape:Rs(l?.shape),x:N(l?.x,"Body x"),y:N(l?.y,"Body y"),angle:N(l?.angle??0,"Body angle",-3600,3600),spin:N(l?.spin??0,"Body spin",-1e4,1e4),enabled:l?.enabled!==!1,locked:l?.locked===!0})),o=(Array.isArray(e.rakes)?e.rakes:[]).slice(0,G.maxRakes).map((l,d)=>({id:typeof l?.id=="string"&&l.id?l.id.slice(0,40):Et(),kind:ce(l?.kind,["streaks","timelines","dye"],"streaks"),x0:N(l?.x0,"Rake x"),y0:N(l?.y0,"Rake y"),x1:N(l?.x1,"Rake x"),y1:N(l?.y1,"Rake y"),emitters:Math.round(N(l?.emitters??12,"Rake emitters",...G.emitters)),color:Math.round(N(l?.color??d%_e,"Rake colour",0,_e-1)),enabled:l?.enabled!==!1}));return{version:Ce,tunnel:{length:N(a.length??t.tunnel.length,"Tunnel length",...G.length),height:N(a.height??t.tunnel.height,"Tunnel height",...G.height),walls:ce(a.walls,["slip","noslip","periodic"],t.tunnel.walls),resolution:ce(a.resolution,["auto","low","medium","high","ultra"],t.tunnel.resolution)},flow:{speed:N(n.speed??t.flow.speed,"Wind speed",...G.speed),fluid:ce(n.fluid,["air","water"],t.flow.fluid)},bodies:c,rakes:o,view:{field:ce(r.field,["vorticity","speed","pressure","schlieren","none"],t.view.field),autoRange:r.autoRange!==!1,min:Number.isFinite(Number(r.min))?Number(r.min):t.view.min,max:Number.isFinite(Number(r.max))?Number(r.max):t.view.max,speed:ce(r.speed,["max","realtime"],t.view.speed),tracers:r.tracers!==void 0?r.tracers!==!1:t.view.tracers,density:ce(r.density,["low","normal","high"],t.view.density),trail:ce(r.trail,["off","short","long"],t.view.trail),arrows:r.arrows===!0,streamlines:r.streamlines===!0}}}const Es=3,Us=48,ft=2.5,it=`
struct G { nx: u32, ny: u32, dt: f32, sign: f32, nsrc: u32, r: f32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<uniform> Gd: G;
`,Ut=`
fn idx(i: i32, j: i32) -> u32 { return u32(clamp(i, 0, i32(Gd.nx) - 1)) + u32(clamp(j, 0, i32(Gd.ny) - 1)) * Gd.nx; }
fn bil(c: vec2f) -> vec4f {
  let p = clamp(c, vec2f(0.0), vec2f(f32(Gd.nx) - 1.001, f32(Gd.ny) - 1.001));
  let i = i32(p.x);
  let j = i32(p.y);
  let f = p - vec2f(f32(i), f32(j));
  return mix(mix(src[idx(i, j)], src[idx(i + 1, j)], f.x), mix(src[idx(i, j + 1)], src[idx(i + 1, j + 1)], f.x), f.y);
}
`,Dt=()=>`${it}
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec4f>;
${Ut}
@compute @workgroup_size(${X})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${X}u;
  if (k >= Gd.nx * Gd.ny) { return; }
  let m = mac[k];
  if (m.w > 0.5) { dst[k] = vec4f(0.0); return; }
  let p = vec2f(f32(k % Gd.nx), f32(k / Gd.nx));
  dst[k] = bil(p - Gd.sign * Gd.dt * m.xy);
}
`,Gt=()=>`${it}
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read> fwd: array<vec4f>;
@group(0) @binding(4) var<storage, read> back: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> dst: array<vec4f>;
${Ut}
@compute @workgroup_size(${X})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${X}u;
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
`,Nt=()=>`${it}
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
`;class Ds{device;nx;ny;bufs;cur=0;advect;correct;inject;unis=[];srcBuf;srcCount=0;srcKey="";constructor(e,s,t){this.device=e,this.nx=s,this.ny=t;const a=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.bufs=[0,1,2,3].map(()=>e.createBuffer({size:s*t*16,usage:a}));const n=(r,c)=>e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:r,label:c}),entryPoint:"main"}});this.advect=n(Dt(),"dye advect"),this.correct=n(Gt(),"dye correct"),this.inject=n(Nt(),"dye inject"),this.srcBuf=e.createBuffer({size:16*512,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.unis=[0,1].map(()=>e.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}))}get field(){return this.bufs[this.cur]}setSources(e){const s=e.map(r=>`${r.x.toFixed(2)},${r.y.toFixed(2)},${r.channel}`).join("|");if(s===this.srcKey)return;this.srcKey=s;const t=new ArrayBuffer(16*Math.min(512,e.length)),a=new Float32Array(t),n=new Uint32Array(t);e.slice(0,512).forEach((r,c)=>{a[4*c]=r.x,a[4*c+1]=r.y,n[4*c+2]=r.channel}),t.byteLength&&this.device.queue.writeBuffer(this.srcBuf,0,t),this.srcCount=Math.min(512,e.length)}clear(){for(const e of this.bufs)this.device.queue.writeBuffer(e,0,new Float32Array(this.nx*this.ny*4))}uniform(e,s,t){const a=new ArrayBuffer(32),n=new Uint32Array(a),r=new Float32Array(a);n[0]=this.nx,n[1]=this.ny,r[2]=s,r[3]=t,n[4]=this.srcCount,r[5]=ft;const c=this.unis[e];return this.device.queue.writeBuffer(c,0,a),c}encode(e,s,t){if(s<=0||this.srcCount===0)return;const a=Math.min(Us,Math.max(1,Math.ceil(s*.1/Es))),n=s/a,r=this.uniform(0,n,1),c=this.uniform(1,n,-1),o=this.nx*this.ny,l=Math.ceil(o/X),d=Math.min(l,32768),h=Math.ceil(l/d),m=(p,A,v)=>this.device.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:A}},...v.map((S,B)=>({binding:2+B,resource:{buffer:S}}))]}),u=2*Math.ceil(ft)+1,g=e.beginComputePass({label:"dye"});for(let p=0;p<a;p++){const A=this.bufs[this.cur],[v,S,B]=[1,2,3].map(y=>this.bufs[(this.cur+y)%4]);g.setPipeline(this.advect),g.setBindGroup(0,m(this.advect,r,[A,v])),g.dispatchWorkgroups(d,h),g.setBindGroup(0,m(this.advect,c,[v,S])),g.dispatchWorkgroups(d,h),g.setPipeline(this.correct),g.setBindGroup(0,m(this.correct,r,[A,v,S,B])),g.dispatchWorkgroups(d,h),g.setPipeline(this.inject),g.setBindGroup(0,m(this.inject,r,[this.srcBuf,B])),g.dispatchWorkgroups(Math.ceil(this.srcCount*u*u/64)),this.cur=(this.cur+3)%4}g.end()}async read(){const e=this.device.createBuffer({size:this.nx*this.ny*16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),s=this.device.createCommandEncoder();s.copyBufferToBuffer(this.field,0,e,0,this.nx*this.ny*16),this.device.queue.submit([s.finish()]),await e.mapAsync(GPUMapMode.READ);const t=new Float32Array(e.getMappedRange().slice(0));return e.destroy(),t}destroy(){for(const e of[...this.bufs,this.srcBuf,...this.unis])e.destroy()}}const Gs=.8,Ns=.12,_s=160,K=8,ze=1.4,Fs=320,We=14,_t=()=>`
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
${qe}
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

@compute @workgroup_size(${X})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * ${X}u;
  if (i >= Ad.count) { return; }
  var m = pmeta[i];
  if (m.w < 0.5) { return; }
  var q = pos[i].xy;
  var prev = q;
  var gone = false;
  var bp: array<vec4f, ${q}>;
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
    if (gone || m.x > Ad.maxAge) {
      // A tracer that left (or grew too old in a dead-water zone) comes back in with the
      // stream: anywhere in the strip the inflow brought in this frame.
      q = vec2f(Ad.respawnX0 + rnd(i, Ad.seed) * Ad.respawnW, rnd(i, Ad.seed ^ 0x9e3779b9u) * (Ad.ny - 1.0));
      m.x = 0.0;
      prev = q;
    }
  } else if (gone) {
    m.w = 0.0;
  }
  pos[i] = vec4f(q, prev);
  pmeta[i] = m;
}
`,Ft=()=>`
struct D {
  scale: f32, ox: f32, oy: f32, w: f32,
  h: f32, halfW: f32, maxSeg: f32, pad: f32,
  tracer: vec4f,
  colors: array<vec4f, ${K}>,
};
@group(0) @binding(0) var<storage, read> pos: array<vec4f>;
@group(0) @binding(1) var<storage, read> pmeta: array<vec4f>;
@group(0) @binding(2) var<uniform> Dr: D;

struct Out { @builtin(position) p: vec4f, @location(0) c: vec4f, @location(1) d: f32 };

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var o: Out;
  let m = pmeta[ii];
  if (m.w < 0.5 || m.x < 0.0) { o.p = vec4f(2.0, 2.0, 0.0, 1.0); return o; }
  let q = pos[ii];
  let b = vec2f((q.x - Dr.ox) / Dr.scale, (Dr.oy - q.y) / Dr.scale);
  var a = vec2f((q.z - Dr.ox) / Dr.scale, (Dr.oy - q.w) / Dr.scale);
  if (distance(a, b) > Dr.maxSeg) { a = b; }
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
  o.c = select(Dr.colors[min(u32(m.z), ${K-1}u)], Dr.tracer, m.y < 0.0);
  o.d = c.y;
  return o;
}

@fragment
fn fs(i: Out) -> @location(0) vec4f {
  // Soft edges across the segment's width.
  let a = i.c.a * clamp((1.0 - abs(i.d)) * 2.0, 0.0, 1.0);
  return vec4f(i.c.rgb, a);
}
`,It=()=>`
struct D {
  scale: f32, ox: f32, oy: f32, w: f32,
  h: f32, halfW: f32, maxSeg: f32, first: f32,
  colors: array<vec4f, ${K}>,
  gaps: array<vec4f, ${K}>,
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
  let src = min(u32(ma.y), ${K-1}u);
  if (abs(ma.x - mb.x) > Dr.gaps[src].x) { return o; }
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
  o.c = Dr.colors[min(u32(ma.z), ${K-1}u)];
  o.d = c.y;
  return o;
}

@fragment
fn fs(i: Out) -> @location(0) vec4f {
  return vec4f(i.c.rgb, i.c.a * clamp((1.0 - abs(i.d)) * 1.8, 0.0, 1.0));
}
`,qt=`
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f { return vec4f(0.0); }
`;class Is{device;pos=null;meta=null;capacity=0;tracers=0;rakes=[];layoutKey="";advectPipe;advectUni;drawPipe;fadePipe;drawUni;linePipe=null;lineUni;seed=1;streakGap=1;trail=null;trailKey="";clearTrail=!0;format="rgba16float";constructor(e){this.device=e,this.advectPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:_t(),label:"particles advect"}),entryPoint:"main"}}),this.advectUni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});const s=e.createShaderModule({code:Ft(),label:"particles draw"}),t={color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}};this.drawPipe=e.createRenderPipeline({layout:"auto",vertex:{module:s,entryPoint:"vs"},fragment:{module:s,entryPoint:"fs",targets:[{format:this.format,blend:t}]},primitive:{topology:"triangle-list"}});const a=e.createShaderModule({code:qt,label:"trail fade"});this.fadePipe=e.createRenderPipeline({layout:"auto",vertex:{module:a,entryPoint:"vs"},fragment:{module:a,entryPoint:"fs",targets:[{format:this.format,blend:{color:{srcFactor:"zero",dstFactor:"constant",operation:"add"},alpha:{srcFactor:"zero",dstFactor:"constant",operation:"add"}}}]},primitive:{topology:"triangle-list"}}),this.drawUni=e.createBuffer({size:48+16*K,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.lineUni=e.createBuffer({size:32+32*K,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}encodeRakeLines(e,s,t,a,n,r){if(!this.pos||!this.meta||!this.rakes.length)return;if(!this.linePipe){const d=this.device.createShaderModule({code:It(),label:"rake lines"});this.linePipe=this.device.createRenderPipeline({layout:"auto",vertex:{module:d,entryPoint:"vs"},fragment:{module:d,entryPoint:"fs",targets:[{format:s,blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-list"}})}const c=new Float32Array(8+8*K);c.set([a.scale,a.ox,a.oy,t.w,t.h,1.3*r,80*r,this.tracers]),n.slice(0,K).forEach((d,h)=>c.set(d,8+4*h));for(const d of this.rakes)c[8+4*K+4*Math.min(d.index,K-1)]=d.rake.kind==="streaks"?this.streakGap*2.5:.5;this.device.queue.writeBuffer(this.lineUni,0,c);const o=this.device.createBindGroup({layout:this.linePipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.pos}},{binding:1,resource:{buffer:this.meta}},{binding:2,resource:{buffer:this.lineUni}}]});e.setPipeline(this.linePipe),e.setBindGroup(0,o);const l=this.capacity-this.tracers-1;l>0&&e.draw(6,l)}get count(){return this.capacity}get tracerCount(){return this.tracers}get buffers(){return this.pos&&this.meta?{pos:this.pos,meta:this.meta}:null}get pools(){return this.rakes.map(e=>({id:e.rake.id,index:e.index,base:e.base,slots:e.slots}))}configure(e,s,t){const a=[];let n=e;s.forEach((m,u)=>{const g=m.kind==="streaks"?Math.ceil(t.nx*1.2*ze):Fs,p=m.kind==="streaks"?g*m.emitters:g*We;a.push({rake:m,index:u,base:n,per:g,slots:p,head:0,acc:0}),n+=p});const r=`${e}|${t.nx}x${t.ny}|${s.map(m=>`${m.id}:${m.kind}:${m.emitters}`).join(",")}`;if(r===this.layoutKey){a.forEach((m,u)=>{this.rakes[u].rake=m.rake});return}this.layoutKey=r,this.rakes=a,this.tracers=e;const c=Math.max(1,n);if(c>this.capacity||!this.pos){this.pos?.destroy(),this.meta?.destroy();const m=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.pos=this.device.createBuffer({size:c*16,usage:m}),this.meta=this.device.createBuffer({size:c*16,usage:m})}this.capacity=c;const o=new Float32Array(c*4),l=new Float32Array(c*4);let d=12345;const h=()=>(d=d*1103515245+12345&2147483647)/2147483647;for(let m=0;m<e;m++){const u=t.absorbInX+h()*(t.outX-t.absorbInX),g=h()*(t.ny-1);o.set([u,g,u,g],4*m),l.set([0,-1,0,1],4*m)}this.device.queue.writeBuffer(this.pos,0,o),this.device.queue.writeBuffer(this.meta,0,l),this.clearTrail=!0}emit(e){if(!(!this.pos||!this.meta||e.steps<=0))for(const s of this.rakes){const{rake:t}=s;if(t.kind==="streaks"){this.streakGap=1/(e.u*ze),s.acc+=e.u*e.steps*ze;const a=Math.min(s.per,Math.floor(s.acc));if(s.acc-=a,a<=0)continue;const n=new Float32Array(a*4),r=new Float32Array(a*4);for(let c=0;c<t.emitters;c++){const o=t.emitters===1?.5:c/(t.emitters-1),l=t.x0+(t.x1-t.x0)*o,d=t.y0+(t.y1-t.y0)*o;for(let h=0;h<a;h++)n.set([l,d,l,d],4*h),r.set([-((h+.5)/a)*e.steps,s.index,t.color,1],4*h);this.writeRing(s.base+c*s.per,s.per,s.head,n,r,a)}s.head=(s.head+a)%s.per}else{const a=e.nx*.1/e.u;for(s.acc+=e.steps;s.acc>=a;){s.acc-=a;const n=-Math.max(0,e.steps-s.acc),r=new Float32Array(s.per*4),c=new Float32Array(s.per*4);for(let l=0;l<s.per;l++){const d=l/(s.per-1),h=t.x0+(t.x1-t.x0)*d,m=t.y0+(t.y1-t.y0)*d;r.set([h,m,h,m],4*l),c.set([n,s.index,t.color,1],4*l)}const o=s.head%We;this.device.queue.writeBuffer(this.pos,(s.base+o*s.per)*16,r),this.device.queue.writeBuffer(this.meta,(s.base+o*s.per)*16,c),s.head=(s.head+1)%We}}}}writeRing(e,s,t,a,n,r){const c=Math.min(r,s-t);this.device.queue.writeBuffer(this.pos,(e+t)*16,a,0,c*4),this.device.queue.writeBuffer(this.meta,(e+t)*16,n,0,c*4),r>c&&(this.device.queue.writeBuffer(this.pos,e*16,a,c*4,(r-c)*4),this.device.queue.writeBuffer(this.meta,e*16,n,c*4,(r-c)*4))}encodeAdvect(e,s,t,a){if(!this.pos||!this.meta||s.steps<=0)return;this.emit(s);const n=Math.min(_s,Math.max(1,Math.ceil(s.steps*Ns/Gs))),r=new ArrayBuffer(48),c=new Uint32Array(r),o=new Float32Array(r);c[0]=this.capacity,c[1]=n,o[2]=s.steps/n,c[3]=this.seed=this.seed*1664525+1013904223>>>0,o[4]=s.nx,o[5]=s.ny,o[6]=s.outX,o[7]=s.absorbInX,o[8]=Math.max(1,s.u*s.steps),o[9]=3*s.nx/s.u,c[10]=s.wrapY?1:0,this.device.queue.writeBuffer(this.advectUni,0,r);const l=this.device.createBindGroup({layout:this.advectPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:this.pos}},{binding:2,resource:{buffer:this.meta}},{binding:3,resource:{buffer:a.params}},{binding:4,resource:{buffer:a.bodies}},{binding:5,resource:{buffer:a.sdf}},{binding:6,resource:{buffer:this.advectUni}}]}),d=Math.ceil(this.capacity/X),h=Math.min(d,32768),m=e.beginComputePass({label:"particles"});m.setPipeline(this.advectPipe),m.setBindGroup(0,l),m.dispatchWorkgroups(h,Math.ceil(d/h)),m.end()}ensureTrail(e,s,t){const a=`${e}x${s}`;(!this.trail||a!==this.trailKey)&&(this.trail?.destroy(),this.trail=this.device.createTexture({size:[e,s],format:this.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),this.trailKey=a,this.clearTrail=!0),t!==this.lastView&&(this.lastView=t,this.clearTrail=!0)}lastView="";encodeDraw(e,s,t,a,n,r){const c=`${t.scale.toFixed(9)}|${t.ox.toFixed(4)}|${t.oy.toFixed(4)}`;this.ensureTrail(s.w,s.h,c);const o=this.trail.createView(),l=e.beginRenderPass({colorAttachments:[{view:o,loadOp:this.clearTrail?"clear":"load",storeOp:"store",clearValue:{r:0,g:0,b:0,a:0}}]});if(this.clearTrail=!1,l.setPipeline(this.fadePipe),l.setBlendConstant({r:a,g:a,b:a,a}),l.draw(3),this.pos&&this.meta&&n.tracers&&this.tracers>0){const d=new Float32Array(12+4*K);d.set([t.scale,t.ox,t.oy,s.w,s.h,.75,60,0]),d.set(r.tracer,8),this.device.queue.writeBuffer(this.drawUni,0,d);const h=this.device.createBindGroup({layout:this.drawPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.pos}},{binding:1,resource:{buffer:this.meta}},{binding:2,resource:{buffer:this.drawUni}}]});l.setPipeline(this.drawPipe),l.setBindGroup(0,h),l.draw(6,this.tracers)}l.end()}async read(){if(!this.pos||!this.meta)return null;const e=this.capacity*16,s=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),t=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),a=this.device.createCommandEncoder();a.copyBufferToBuffer(this.pos,0,s,0,e),a.copyBufferToBuffer(this.meta,0,t,0,e),this.device.queue.submit([a.finish()]),await Promise.all([s.mapAsync(GPUMapMode.READ),t.mapAsync(GPUMapMode.READ)]);const n={pos:new Float32Array(s.getMappedRange().slice(0)),meta:new Float32Array(t.getMappedRange().slice(0))};return s.destroy(),t.destroy(),n}clear(){this.clearTrail=!0,this.layoutKey=""}destroy(){this.pos?.destroy(),this.meta?.destroy(),this.trail?.destroy(),this.advectUni.destroy(),this.drawUni.destroy(),this.lineUni.destroy()}}const Pe=1024,mt=512,Lt=`
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
`,Ot=`
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
`;class qs{device;verts;trace;draw;traceUni;drawUni;lines=0;constructor(e,s){this.device=e,this.verts=e.createBuffer({size:mt*Pe*16,usage:GPUBufferUsage.STORAGE}),this.trace=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:Lt,label:"streamlines trace"}),entryPoint:"main"}});const t=e.createShaderModule({code:Ot,label:"streamlines draw"});this.draw=e.createRenderPipeline({layout:"auto",vertex:{module:t,entryPoint:"vs"},fragment:{module:t,entryPoint:"fs",targets:[{format:s,blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-list"}}),this.traceUni=e.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.drawUni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}get count(){return this.lines}encodeTrace(e,s,t,a,n){this.lines=Math.max(1,Math.min(mt,Math.floor(n)));const r=new ArrayBuffer(32),c=new Float32Array(r),o=new Uint32Array(r);c[0]=t.nx,c[1]=t.ny,o[2]=this.lines,o[3]=Pe,c[4]=a,c[5]=0,c[6]=(t.ny-1)/this.lines,c[7]=Math.max(.5,t.nx*1.4/Pe),this.device.queue.writeBuffer(this.traceUni,0,r);const l=this.device.createBindGroup({layout:this.trace.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:s}},{binding:1,resource:{buffer:this.verts}},{binding:2,resource:{buffer:this.traceUni}}]}),d=e.beginComputePass({label:"streamlines"});d.setPipeline(this.trace),d.setBindGroup(0,l),d.dispatchWorkgroups(Math.ceil(this.lines/64)),d.end()}encodeDraw(e,s,t,a,n){if(!this.lines)return;this.device.queue.writeBuffer(this.drawUni,0,new Float32Array([t.scale,t.ox,t.oy,s.w,s.h,.7*n,Pe,0,...a]));const r=this.device.createBindGroup({layout:this.draw.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.verts}},{binding:1,resource:{buffer:this.drawUni}}]});e.setPipeline(this.draw),e.setBindGroup(0,r),e.draw(6,this.lines*(Pe-1))}destroy(){this.verts.destroy(),this.traceUni.destroy(),this.drawUni.destroy()}}const Ls={vorticity:0,speed:1,pressure:2,schlieren:3,none:1},je=4;class Qe{nx;ny;n;config;device;f;cur=0;paramsBuf;params=new ArrayBuffer(48);bodiesBuf;bodyData=new ArrayBuffer(q*64);sdfBuf;sdfKey="";sdfOffsets=[];forceBuf;staging=[];stepPipe;stepPipeKey="";stepBG=null;slotBGs=[];slotBuf;macroPipe;fieldPipe;stepModule;macroBuf;scalarBuf;fieldUni;sampledBuf;sampledRead;sampledBusy=!1;sampleW;sampleH;bodies=[];physics={u:.05,tau:.6,smagorinsky:!1,smagCs:.1};groups;destroyed=!1;stepsDone=0;constructor(e,s){this.device=e,this.config={profile:0,absorbing:!0,...s},this.nx=s.nx,this.ny=s.ny,this.n=s.nx*s.ny;const t=GPUBufferUsage,a=9*this.n*4;this.f=[e.createBuffer({size:a,usage:t.STORAGE|t.COPY_DST}),e.createBuffer({size:a,usage:t.STORAGE|t.COPY_DST})],this.paramsBuf=e.createBuffer({size:48,usage:t.UNIFORM|t.COPY_DST}),this.bodiesBuf=e.createBuffer({size:q*64,usage:t.STORAGE|t.COPY_DST}),this.sdfBuf=e.createBuffer({size:16,usage:t.STORAGE|t.COPY_DST}),this.forceBuf=e.createBuffer({size:Ve*4,usage:t.STORAGE|t.COPY_SRC|t.COPY_DST}),this.slotBuf=e.createBuffer({size:ee*256,usage:t.UNIFORM|t.COPY_DST});const n=new Uint32Array(ee*64);for(let c=0;c<ee;c++)n[c*64]=c;e.queue.writeBuffer(this.slotBuf,0,n),this.macroBuf=e.createBuffer({size:this.n*16,usage:t.STORAGE}),this.scalarBuf=e.createBuffer({size:this.n*4,usage:t.STORAGE}),this.fieldUni=e.createBuffer({size:48,usage:t.UNIFORM|t.COPY_DST}),this.sampleW=Math.ceil(this.nx/je),this.sampleH=Math.ceil(this.ny/je),this.sampledBuf=e.createBuffer({size:this.sampleW*this.sampleH*4,usage:t.STORAGE|t.COPY_SRC}),this.sampledRead=e.createBuffer({size:this.sampleW*this.sampleH*4,usage:t.MAP_READ|t.COPY_DST}),this.stepModule=e.createShaderModule({code:$t(),label:"tunnel step"}),this.macroPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:Ct(),label:"tunnel macro"}),entryPoint:"main"}}),this.fieldPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:Rt(),label:"tunnel field"}),entryPoint:"main"}});const r=Math.ceil(this.n/X);this.groups=[Math.min(r,32768),Math.ceil(r/Math.min(r,32768))],this.writeBodies(),this.reset()}reset(e=this.physics.u){const s=new Float32Array(9*this.n),t=1.5*e*e;for(let a=0;a<9;a++){const n=3*[0,1,0,-1,0,1,-1,-1,1][a]*e;s.fill(fe[a]*(1+n+.5*n*n-t),a*this.n,(a+1)*this.n)}this.device.queue.writeBuffer(this.f[0],0,s),this.device.queue.writeBuffer(this.f[1],0,s),this.stepsDone=0}setPhysics(e){this.physics=e;const s=`${this.config.walls}|${e.smagorinsky}`;s!==this.stepPipeKey&&(this.stepPipe=this.device.createComputePipeline({layout:"auto",compute:{module:this.stepModule,entryPoint:"step",constants:{WALLS:ws[this.config.walls],SMAG:e.smagorinsky?1:0}}}),this.stepPipeKey=s,this.stepBG=null,this.slotBGs=[])}writeParams(e){const s=new Uint32Array(this.params),t=new Float32Array(this.params),a=this.physics;s[0]=this.nx,s[1]=this.ny,s[2]=this.n,s[3]=this.bodies.length,t[4]=1/a.tau,t[5]=18*Math.SQRT2*a.smagCs*a.smagCs,t[6]=a.u,t[7]=this.config.absorbing?.05:0,t[8]=this.config.absorbing?this.absorbInX:-1,t[9]=this.spongeX,s[10]=Math.max(1,e),s[11]=this.config.profile,this.device.queue.writeBuffer(this.paramsBuf,0,this.params)}get absorbInX(){return this.config.absorbing?this.nx*.05:-1}get spongeX(){return this.nx*.85}setBodies(e){if(e.length>q)throw new Error(`At most ${q} bodies are in the flow at once.`);this.bodies=e;const s=e.map(t=>t.key).join("|");if(s!==this.sdfKey){const t=Math.max(4,e.reduce((n,r)=>n+r.sdf.data.length,0));this.sdfBuf.size<t*4&&(this.sdfBuf.destroy(),this.sdfBuf=this.device.createBuffer({size:t*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.stepBG=null,this.renderBGDirty=!0),this.sdfOffsets=[];let a=0;for(const n of e)this.sdfOffsets.push(a),this.device.queue.writeBuffer(this.sdfBuf,a*4,n.sdf.data),a+=n.sdf.data.length;this.sdfKey=s}this.writeBodies()}renderBGDirty=!1;writeBodies(){const e=new Float32Array(this.bodyData),s=new Uint32Array(this.bodyData);this.bodies.forEach((t,a)=>{const n=a*16;e[n]=t.from.x,e[n+1]=t.from.y,e[n+2]=t.to.x,e[n+3]=t.to.y,e[n+4]=t.from.theta,e[n+5]=t.to.theta,e[n+6]=t.sdf.bound,e[n+7]=t.sdf.texel,e[n+8]=t.sdf.ox,e[n+9]=t.sdf.oy,s[n+10]=t.sdf.w,s[n+11]=t.sdf.h,s[n+12]=this.sdfOffsets[a]??0}),this.device.queue.writeBuffer(this.bodiesBuf,0,this.bodyData)}get buffers(){return{params:this.paramsBuf,bodies:this.bodiesBuf,sdf:this.sdfBuf,scalar:this.scalarBuf}}bindGroups(){if(!this.stepBG){const e=this.stepPipe.getBindGroupLayout(0),s=(t,a)=>this.device.createBindGroup({layout:e,entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:a}},{binding:2,resource:{buffer:this.paramsBuf}},{binding:3,resource:{buffer:this.bodiesBuf}},{binding:4,resource:{buffer:this.sdfBuf}},{binding:5,resource:{buffer:this.forceBuf}}]});this.stepBG=[s(this.f[0],this.f[1]),s(this.f[1],this.f[0])]}if(!this.slotBGs.length){const e=this.stepPipe.getBindGroupLayout(1);for(let s=0;s<ee;s++)this.slotBGs.push(this.device.createBindGroup({layout:e,entries:[{binding:0,resource:{buffer:this.slotBuf,offset:s*256,size:16}}]}))}return this.stepBG}encodeFrame(e,s,t){const a=Math.min(ee,Math.max(0,Math.floor(s)));this.writeParams(Math.max(1,a)),this.writeBodies();const n=this.bindGroups();let r=!1;if(a>0){e.clearBuffer(this.forceBuf,0,Math.min(Ve*4,a*q*8)),e.clearBuffer(this.forceBuf,Q*4,16);const c=e.beginComputePass({label:"tunnel steps"});c.setPipeline(this.stepPipe);for(let o=0;o<a;o++)c.setBindGroup(0,n[this.cur]),c.setBindGroup(1,this.slotBGs[o]),c.dispatchWorkgroups(this.groups[0],this.groups[1]),this.cur^=1;c.end(),this.stepsDone+=a,r=!0}return this.encodeField(e,t),{readForces:r}}encodeField(e,s){const t=new ArrayBuffer(48),a=new Uint32Array(t),n=new Float32Array(t);a[0]=this.nx,a[1]=this.ny,a[2]=s.mode,a[3]=je,n[4]=s.uRef,n[5]=s.lRef,n[8]=s.rhoRef??1,a[6]=this.sampleW,a[7]=this.sampleH,this.device.queue.writeBuffer(this.fieldUni,0,t);const r=this.device.createBindGroup({layout:this.macroPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.f[this.cur]}},{binding:1,resource:{buffer:this.macroBuf}},{binding:2,resource:{buffer:this.paramsBuf}},{binding:3,resource:{buffer:this.bodiesBuf}},{binding:4,resource:{buffer:this.sdfBuf}}]}),c=this.device.createBindGroup({layout:this.fieldPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.macroBuf}},{binding:1,resource:{buffer:this.scalarBuf}},{binding:2,resource:{buffer:this.fieldUni}},{binding:3,resource:{buffer:this.sampledBuf}}]}),o=e.beginComputePass({label:"tunnel field"});o.setPipeline(this.macroPipe),o.setBindGroup(0,r),o.dispatchWorkgroups(this.groups[0],this.groups[1]),o.setPipeline(this.fieldPipe),o.setBindGroup(0,c),o.dispatchWorkgroups(this.groups[0],this.groups[1]),o.end()}prepareRead(e,s){const t=Math.min(ee,s),a=t*q*8;let n=this.staging.pop();n||(n=this.device.createBuffer({size:Ve*4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})),e.copyBufferToBuffer(this.forceBuf,0,n,0,a),e.copyBufferToBuffer(this.forceBuf,Q*4,n,Q*4,16);const r=n;return async()=>{try{await r.mapAsync(GPUMapMode.READ)}catch{return null}const c=new Int32Array(r.getMappedRange().slice(0));r.unmap(),this.destroyed?r.destroy():this.staging.push(r);const o=this.bodies.map((d,h)=>{const m=new Float64Array(t*2);let u=0,g=0;for(let p=0;p<t;p++){const A=c[(p*q+h)*2]/Ne,v=c[(p*q+h)*2+1]/Ne;m[2*p]=A,m[2*p+1]=v,u+=A,g+=v}return{fx:u,fy:g,perStep:m}}),l=c[Q]>0?this.n-c[Q+1]:-1;return{steps:t,forces:o,bad:c[Q],limited:c[Q+2],badCell:l>=0?{x:l%this.nx,y:Math.floor(l/this.nx)}:null}}}async readSampled(){if(this.sampledBusy||this.destroyed)return null;this.sampledBusy=!0;try{const e=this.device.createCommandEncoder();e.copyBufferToBuffer(this.sampledBuf,0,this.sampledRead,0,this.sampledRead.size),this.device.queue.submit([e.finish()]),await this.sampledRead.mapAsync(GPUMapMode.READ);const s=new Float32Array(this.sampledRead.getMappedRange().slice(0));this.sampledRead.unmap();for(let t=0;t<s.length;t++)s[t]>1e29&&(s[t]=NaN);return s}catch{return null}finally{this.sampledBusy=!1}}destroy(){this.destroyed=!0;for(const e of[...this.f,this.paramsBuf,this.bodiesBuf,this.sdfBuf,this.forceBuf,this.slotBuf,this.macroBuf,this.scalarBuf,this.fieldUni,this.sampledBuf,...this.staging])e.destroy();this.staging=[]}}const Os=.05,Vs=50,Xs=.005,pt=.1,yt=1/3;function zs(i,e,s,t){const a=i/e;let n=Os;const r=h=>t*h/(s*a);r(n)>yt&&(n=yt*s*a/t);const c=r(n),o=n/Vs,l=Math.max(c,o),d=n*a/s;return{dx:a,dt:d,u:n,nu:l,tau:3*l+.5,capped:c<o,smagorinsky:l<Xs}}function Ws(i,e,s,t){return{real:s*e/t,sim:i.u*(e/i.dx)/i.nu}}const he={low:512*256,medium:1024*512,high:1536*768,ultra:2048*1024},gt=.05,js=.1,Ys=12,Vt={vorticity:"balance",speed:"viridis",pressure:"balance",schlieren:"viridis",none:"viridis"},Ks={low:1/1500,normal:1/500,high:1/150},Hs=3e3,Zs=6e4,Js={off:0,short:.6,long:.9},Qs=34,en=14;function et(i,e){const{length:s,height:t}=i.tunnel;let a=Math.round(Math.sqrt(e*s/t)),n=Math.round(e/a);return a=Math.max(32,Math.min(8192,a)),n=Math.max(16,Math.min(8192,n)),{nx:a,ny:n}}const bt=new Map;class tn{device;adapterName;canvas;renderer;solver=null;scene=null;map=null;bodies=new Map;order=[];targets=new Map;raf=0;stepsTarget=64;gpuMs=0;lastFrame=0;fpsEma=0;readPending=!1;sampledAt=0;listeners=new Set;range={lo:-10,hi:10};autoRange={lo:-10,hi:10,ready:!1};gridKey="";rangeField=null;rhoRef=1;physKey="";paused=!1;unstable=!1;palette;worldView={cx:4,cy:2,mpp:.01,w:800,h:400,dpr:1};simTime=0;stats;particles;dye=null;streamlines;rakeGpu=[];dyeChannels=new Map;frameNo=0;markerColors=null;recordForces=!1;onUnstable=null;unstableAt=null;constructor(e,s,t,a){this.device=e,this.adapterName=t,this.palette=a,this.canvas=s,this.renderer=new Ms(e,s),this.particles=new Is(e),this.streamlines=new qs(e,this.renderer.format),this.stats={adapter:t,nx:0,ny:0,stepsPerFrame:0,mlups:0,speedRatio:0,simTime:0,fps:0,map:null,state:"running"}}subscribe(e){return this.listeners.add(e),()=>{this.listeners.delete(e)}}emit(){for(const e of this.listeners)e()}get solverReady(){return!!this.solver}get lattice(){return this.map}get grid(){return this.solver?{nx:this.solver.nx,ny:this.solver.ny}:null}benchmark(){return this.benchmarkAt(1024,512)}async benchmarkAt(e,s){const t=`${e}x${s}`,a=bt.get(t);if(a!==void 0)return a;const n=new Qe(this.device,{nx:e,ny:s,walls:"slip"});n.setPhysics({u:.05,tau:.51,smagorinsky:!0,smagCs:pt});const r=async h=>{const m=this.device.createCommandEncoder();n.encodeFrame(m,h,{mode:0,uRef:.05,lRef:50}),this.device.queue.submit([m.finish()]),await this.device.queue.onSubmittedWorkDone()};await r(30);const c=Math.max(40,Math.min(400,Math.round(2e8/(e*s)))),o=performance.now();await r(c);const l=Math.max(.1,performance.now()-o);n.destroy();const d=e*s*c/(l/1e3)/1e6;return bt.set(t,d),d}async cellsFor(e,s){if(e!=="auto")return he[e];const t=async a=>{const{nx:n,ny:r}=et(s,he[a]),c=8*n*n*r*1.25/1e6;return await this.benchmarkAt(n,r)>=c};return await t("medium")?await t("high")?await t("ultra")?he.ultra:he.high:he.medium:he.low}async setScene(e){this.scene=e;const s=await this.cellsFor(e.tunnel.resolution,e);if(this.scene!==e)return;const{nx:t,ny:a}=et(e,s),n=`${t}x${a}|${e.tunnel.walls}|${e.tunnel.length}`;n!==this.gridKey&&(this.solver?.destroy(),this.solver=new Qe(this.device,{nx:t,ny:a,walls:e.tunnel.walls}),this.particles.clear(),this.dye?.destroy(),this.dye=null,this.gridKey=n,this.bodies.clear(),this.physKey="",this.simTime=0,this.unstable=!1,this.autoRange.ready=!1,this.rhoRef=1);const r=Re[e.flow.fluid];this.map=zs(e.tunnel.length,t,e.flow.speed,r.nu);const c=`${this.map.u}|${this.map.tau}|${this.map.smagorinsky}`;c!==this.physKey&&(this.solver.setPhysics({u:this.map.u,tau:this.map.tau,smagorinsky:this.map.smagorinsky,smagCs:pt}),this.physKey||this.solver.reset(this.map.u),this.physKey=c),this.syncBodies(e),await this.syncMarkers(e),this.emit()}async syncMarkers(e){const s=this.solver,t=this.map.dx,a=await this.benchmark();let n=e.view.tracers?Math.round(s.n*Ks[e.view.density]):0;a<Hs&&(n=Math.min(n,Zs));const r=l=>l/t-.5,c=e.rakes.filter(l=>l.enabled);this.rakeGpu=c.filter(l=>l.kind!=="dye").map(l=>({id:l.id,kind:l.kind,x0:r(l.x0),y0:r(l.y0),x1:r(l.x1),y1:r(l.y1),emitters:l.emitters,color:l.color})),this.particles.configure(n,this.rakeGpu,{nx:s.nx,ny:s.ny,absorbInX:Math.max(0,s.absorbInX),outX:s.spongeX});const o=c.filter(l=>l.kind==="dye").slice(0,G.maxDyeRakes);if(this.dyeChannels=new Map(o.map((l,d)=>[l.id,d])),o.length){this.dye||(this.dye=new Ds(this.device,s.nx,s.ny),this.dye.clear());const l=[];o.forEach((d,h)=>{for(let m=0;m<d.emitters;m++){const u=d.emitters===1?.5:m/(d.emitters-1);l.push({x:r(d.x0+(d.x1-d.x0)*u),y:r(d.y0+(d.y1-d.y0)*u),channel:h})}}),this.dye.setSources(l)}else this.dye&&(this.dye.destroy(),this.dye=null)}get dyeChannelOf(){return this.dyeChannels}async readParticles(){const e=await this.particles.read();return e?{...e,tracers:this.particles.tracerCount,pools:this.particles.pools,dx:this.map?.dx??0}:null}async readDye(){return this.dye?{data:await this.dye.read(),nx:this.dye.nx,ny:this.dye.ny,channels:Object.fromEntries(this.dyeChannels),dx:this.map?.dx??0}:null}get streamlineCount(){return this.scene?.view.streamlines?this.streamlines.count:0}syncBodies(e){const s=this.map.dx,t=e.bodies.filter(n=>n.enabled).slice(0,q),a=new Set(t.map(n=>n.id));for(const n of[...this.bodies.keys()])a.has(n)||this.bodies.delete(n);for(const n of t){const r=`${JSON.stringify(n.shape)}@${s}`,c=this.bodies.get(n.id),o=this.targetPose(n);if(!c||c.key!==r){const l=St(Se(n.shape),{x:0,y:0,theta:0},1/s),d=At(l);this.bodies.set(n.id,{body:n,key:r,sdf:d,rCells:Ke(l),pose:c?.pose??o,spinAngle:c?.spinAngle??0,fxEma:0,fyEma:0,history:[]})}else c.body=n}this.order=t.map(n=>n.id)}targetPose(e){const s=this.map.dx,t=this.targets.get(e.id),a=t?.x??e.x,n=t?.y??e.y,r=t?.angle??e.angle,c=this.bodies.get(e.id)?.spinAngle??0;return{x:a/s-.5,y:n/s-.5,theta:-r*Math.PI/180+c}}setTarget(e,s){s?this.targets.set(e,s):this.targets.delete(e)}livePose(e){const s=this.bodies.get(e);if(!s||!this.map)return null;const t=this.map.dx;return{x:(s.pose.x+.5)*t,y:(s.pose.y+.5)*t,angle:-(s.pose.theta-s.spinAngle)*180/Math.PI}}bodyLive(e){const s=this.bodies.get(e),t=this.livePose(e);if(!s||!t||!this.map||!this.scene)return null;const a=Re[this.scene.flow.fluid],n=this.map.u,r=.5*n*n*(xe(s.body.shape)/this.map.dx),c=o=>o/r*.5*a.rho*this.scene.flow.speed**2*xe(s.body.shape);return{...t,fx:c(s.fxEma),fy:c(s.fyEma),cd:s.fxEma/r,cl:s.fyEma/r}}spinCap(e){const s=this.bodies.get(e);return!s||!this.map?null:js/Math.max(1,s.rCells)/this.map.dt}forceHistory(e){return this.bodies.get(e)?.history??[]}reynoldsFor(e){return!this.map||!this.scene?null:Ws(this.map,xe(e.shape),this.scene.flow.speed,Re[this.scene.flow.fluid].nu)}resetFlow(){if(!(!this.solver||!this.map)){this.solver.reset(this.map.u),this.simTime=0,this.rhoRef=1,this.particles.clear(),this.dye?.clear(),this.scene&&this.syncMarkers(this.scene),this.unstable=!1;for(const e of this.bodies.values())e.fxEma=0,e.fyEma=0,e.history=[];this.emit()}}setColormap(e){this.renderer.setColormap(e)}get autoRangeNow(){return this.autoRange.ready?{lo:this.autoRange.lo,hi:this.autoRange.hi}:null}setRange(e,s){this.range={lo:e,hi:s}}start(){if(this.raf)return;const e=s=>{this.raf=requestAnimationFrame(e),this.frame(s)};this.raf=requestAnimationFrame(e)}stop(){cancelAnimationFrame(this.raf),this.raf=0}lRefCells(){const e=this.order.length?this.bodies.get(this.order[0]):null;return e&&this.map?xe(e.body.shape)/this.map.dx:this.solver?this.solver.ny/8:50}frame(e){const s=this.solver,t=this.scene,a=this.map;if(!s||!t||!a)return;const n=this.lastFrame?Math.min(100,e-this.lastFrame):16;this.lastFrame=e,this.fpsEma=this.fpsEma?this.fpsEma*.9+1e3/Math.max(1,n)*.1:60;let r=this.paused||this.unstable?0:Math.round(this.stepsTarget);r>0&&t.view.speed==="realtime"&&(r=Math.max(1,Math.min(r,Math.round(n/1e3/a.dt)))),r=Math.min(ee,r);const c=[];for(const w of this.order){const k=this.bodies.get(w);if(r>0&&k.body.spin){const $=this.spinCap(k.body.id)??1/0;k.spinAngle+=Math.sign(k.body.spin)*Math.min(Math.abs(k.body.spin),$)*a.dt*r}const M=this.targetPose(k.body),P={...k.pose};if(r===0)k.pose=M;else{const $=gt*r,b=M.x-P.x,E=M.y-P.y,U=Math.hypot(b,E),F=U>$?$/U:1;let T=M.theta-P.theta;const R=gt*r/Math.max(1,k.rCells);Math.abs(T)>R&&(T=Math.sign(T)*R),k.pose={x:P.x+b*F,y:P.y+E*F,theta:P.theta+T}}c.push({key:`${w}:${k.key}`,sdf:k.sdf,from:r===0?k.pose:P,to:k.pose})}s.setBodies(c);const o=Ls[t.view.field],l=this.device.createCommandEncoder();t.view.field!==this.rangeField&&(this.rangeField=t.view.field,this.autoRange={lo:0,hi:1,ready:!1});const{readForces:d}=s.encodeFrame(l,r,{mode:o,uRef:a.u,lRef:this.lRefCells(),rhoRef:this.rhoRef}),h=t.view.autoRange&&this.autoRange.ready?this.autoRange:this.range;this.renderer.setColormap(Vt[t.view.field]);const m=this.latticeView(a.dx),u=t.view,g=u.field==="none",p=this.markerColors,A={steps:r,u:a.u,nx:s.nx,ny:s.ny,absorbInX:Math.max(0,s.absorbInX),outX:s.spongeX,wrapY:t.tunnel.walls==="periodic"};if(this.particles.encodeAdvect(l,A,s.macroBuf,s.buffers),this.dye?.encode(l,r,s.macroBuf),this.frameNo++,u.streamlines&&(r>0||this.frameNo%10===0)){const w=t.tunnel.height/this.worldView.mpp/en;this.streamlines.encodeTrace(l,s.macroBuf,s,Math.max(0,s.absorbInX)+1,Math.max(8,w))}const v=this.renderer.size,S=u.tracers&&this.particles.tracerCount>0;S&&p&&this.particles.encodeDraw(l,v,m,r>0?Js[u.trail]:0,{tracers:!0},{tracer:g?p.tracerLight:p.tracerDark});const B=[...this.dyeChannels.entries()].sort((w,k)=>w[1]-k[1]).map(([w])=>{const k=t.rakes.find(P=>P.id===w),M=p?.rakes[k?.color??0]??[0,0,0,1];return[M[0],M[1],M[2],.9]});this.renderer.encode(l,s,m,h,this.palette,{plain:g,arrows:u.arrows,arrowCells:Qs*this.worldView.mpp/a.dx,uRef:a.u,dye:this.dye?this.dye.field:null,dyeColors:B,trail:S&&p?this.particles.trail:null},p?w=>{u.streamlines&&this.streamlines.encodeDraw(w,v,m,g?p.streamlineLight:p.streamline,this.worldView.dpr),this.rakeGpu.length&&this.particles.encodeRakeLines(w,this.renderer.format,v,m,p.rakes,this.worldView.dpr)}:void 0);const y=d&&!this.readPending?s.prepareRead(l,r):null,x=performance.now();this.device.queue.submit([l.finish()]),this.simTime+=r*a.dt,r>0&&this.device.queue.onSubmittedWorkDone().then(()=>{const w=performance.now()-x;this.gpuMs=this.gpuMs?this.gpuMs*.8+w*.2:w;const k=this.gpuMs/r,M=Ys/Math.max(1e-4,k);this.stepsTarget=Math.max(1,Math.min(ee,this.stepsTarget*.7+M*.3))}),y&&(this.readPending=!0,y().then(w=>{this.readPending=!1,w&&this.takeForces(w)})),t.view.autoRange&&e-this.sampledAt>400&&(this.sampledAt=e,s.readSampled().then(w=>w&&this.takeSample(w,t.view.field))),this.stats={adapter:this.adapterName,nx:s.nx,ny:s.ny,stepsPerFrame:r,mlups:r>0&&this.gpuMs>0?s.n*r/(this.gpuMs/1e3)/1e6:this.stats.mlups,speedRatio:r*a.dt/Math.max(.001,n/1e3),simTime:this.simTime,fps:this.fpsEma,map:a,state:this.unstable?"unstable":this.paused?"paused":"running"}}limitedAt=0;limitedTotal=0;takeForces(e){if(e.limited>0&&(this.limitedAt=performance.now(),this.limitedTotal+=e.limited),e.bad>0&&!this.unstable){this.unstable=!0,this.unstableAt=e.badCell&&this.map?{x:(e.badCell.x+.5)*this.map.dx,y:(e.badCell.y+.5)*this.map.dx,poses:this.order.map(s=>({id:s,...this.livePose(s)}))}:null,this.onUnstable?.(),this.emit();return}e.forces.forEach((s,t)=>{const a=this.bodies.get(this.order[t]);if(!a||e.steps===0)return;const n=s.fx/e.steps,r=s.fy/e.steps,c=Math.min(1,e.steps/400);if(a.fxEma=a.fxEma?a.fxEma*(1-c)+n*c:n,a.fyEma=a.fyEma?a.fyEma*(1-c)+r*c:r,this.recordForces)for(let o=0;o<e.steps;o++)a.history.push(s.perStep[2*o],s.perStep[2*o+1])})}takeSample(e,s){if(s!==this.rangeField)return;if(s==="pressure"&&this.solver&&this.map){const o=this.solver.sampleW,l=Math.min(o-1,Math.ceil((this.solver.absorbInX+this.solver.nx*.03)/4)),d=[];for(let h=0;h<this.solver.sampleH;h++){const m=e[h*o+l];Number.isFinite(m)&&d.push(m)}if(d.length>4){d.sort((m,u)=>m-u);const h=d[Math.floor(d.length/2)];if(this.rhoRef+=h*1.5*this.map.u*this.map.u,Math.abs(h)>.02)return}}const t=Array.from(e).filter(o=>Number.isFinite(o));if(t.length<16)return;t.sort((o,l)=>o-l);const a=o=>t[Math.min(t.length-1,Math.max(0,Math.round(o*(t.length-1))))];let n,r;if(s==="vorticity"){const o=t.map(Math.abs).sort((d,h)=>d-h),l=Math.max(1e-6,o[Math.round(.985*(o.length-1))]);n=-l,r=l}else if(s==="pressure"){const o=Math.max(Math.abs(a(.01)),Math.abs(a(.99)),.001);n=-o,r=o}else n=0,r=Math.max(1e-6,a(.995));const c=this.autoRange.ready?.3:1;this.autoRange={lo:this.autoRange.lo*(1-c)+n*c,hi:this.autoRange.hi*(1-c)+r*c,ready:!0},this.emit()}sampleField(){return this.solver?this.solver.readSampled():Promise.resolve(null)}latticeView(e){const s=this.worldView;return{scale:s.mpp/s.dpr/e,ox:(s.cx-s.w/2*s.mpp)/e-.5,oy:(s.cy+s.h/2*s.mpp)/e-.5}}destroy(){this.stop(),this.solver?.destroy(),this.particles.destroy(),this.dye?.destroy(),this.streamlines.destroy(),this.renderer.destroy()}}const xt=100;class sn{state;listeners=new Set;past=[];future=[];onSceneChange=null;constructor(e){this.state={scene:e,selected:null,save:"saved",saveError:""}}get=()=>this.state;subscribe=e=>(this.listeners.add(e),()=>{this.listeners.delete(e)});set(e){this.state={...this.state,...e};for(const s of this.listeners)s()}commit(e,s=!0){s&&(this.past.push(this.state.scene),this.past.length>xt&&this.past.shift(),this.future=[]);const t=this.state.selected,a=t&&(e.bodies.some(n=>n.id===t)||e.rakes.some(n=>n.id===t))?t:null;this.set({scene:e,selected:a}),this.onSceneChange?.(e)}commitFrom(e,s){this.past.push(e),this.past.length>xt&&this.past.shift(),this.future=[],this.commit(s,!1)}updateBody(e,s,t=!0){const a=this.state.scene;this.commit({...a,bodies:a.bodies.map(n=>n.id===e?{...n,...s}:n)},t)}get canUndo(){return this.past.length>0}get canRedo(){return this.future.length>0}undo(){const e=this.past.pop();return e?(this.future.push(this.state.scene),this.commit(e,!1),!0):!1}redo(){const e=this.future.pop();return e?(this.past.push(this.state.scene),this.commit(e,!1),!0):!1}select(e){this.set({selected:e})}setSave(e,s=""){this.set({save:e,saveError:s})}}function O(i,e){return ts(i.subscribe,()=>e(i.get()))}const nn=new Intl.NumberFormat("en-US",{maximumSignificantDigits:3}),re=i=>nn.format(i);function we({title:i,children:e,attr:s}){return C("section",{className:"t2d-section","data-t2d-section":s??i.toLowerCase(),children:[f("h2",{className:"t2d-section-title",children:i}),f("div",{className:"t2d-section-body",children:e})]})}const tt=i=>i==="imperial"?"ft":"m";function vt({label:i,value:e,onCommit:s,error:t,attr:a}){const[n,r]=te(e);return j(()=>r(e),[e]),f("span",{className:"mgk-type mgk-value-row",children:f("input",{className:"mgk-input mgk-input--wide","aria-label":i,value:n,"data-t2d-text":a,"aria-invalid":t?!0:void 0,onChange:c=>r(c.target.value),onBlur:()=>n!==e&&s(n),onKeyDown:c=>{c.key==="Enter"&&c.target.blur(),c.key==="Escape"&&(r(e),c.target.blur())}})})}function an({store:i,engine:e,units:s}){const t=O(i,d=>d.scene),a=O(i,d=>d.selected),[,n]=te(0);j(()=>e.subscribe(()=>n(d=>d+1)),[e]);const r=d=>i.commit({...t,flow:{...t.flow,...d}}),c=t.bodies.find(d=>d.id===a)??t.bodies.find(d=>d.enabled)??null,o=c?e.reynoldsFor(c):null,l=e.lattice;return C(we,{title:"Wind",children:[f(D,{label:"Wind speed",help:"The speed of the flow coming in at the left.",children:f(oe,{label:"Wind speed",quantity:"velocity",units:s,valueSi:t.flow.speed,onCommitSi:d=>r({speed:Math.min(G.speed[1],Math.max(G.speed[0],d))})})}),f(D,{label:"Fluid",children:f(se,{label:"Fluid",value:t.flow.fluid,options:Object.entries(Re).map(([d,h])=>({value:d,label:h.label})),onChange:d=>r({fluid:d})})}),c&&o?C("div",{className:"t2d-re","data-t2d-re":!0,"data-real":o.real,"data-sim":o.sim,children:[f("div",{className:"t2d-re-row",children:C("span",{children:["Reynolds number (",Ge(c.shape),", ",re(xe(c.shape))," m)"]})}),C("div",{className:"t2d-re-row",children:[f("span",{className:"t2d-re-k",children:"Real"}),f("span",{className:"t2d-re-v","data-t2d-re-real":!0,children:re(o.real)}),f("span",{className:"t2d-re-k",children:"Simulated"}),f("span",{className:"t2d-re-v","data-t2d-re-sim":!0,children:re(o.sim)})]}),l?.capped?C(H,{tone:"warning",children:["This grid resolves a Reynolds number of about ",re(o.sim)," here, so the flow is simulated at that, not at ",re(o.real),". Wakes, shedding and separation show as they do; forces are those of the lower Reynolds number. A finer resolution raises it."]}):null]}):f(H,{children:"Add a body to see its Reynolds number."})]})}function rn({store:i,engine:e,units:s}){const t=O(i,o=>o.scene),[,a]=te(0);j(()=>e.subscribe(()=>a(o=>o+1)),[e]);const n=o=>i.commit({...t,tunnel:{...t.tunnel,...o}}),r=e.grid,c=o=>{const l=et(t,he[o]);return`${o[0].toUpperCase()}${o.slice(1)} (${l.nx} × ${l.ny})`};return C(we,{title:"Tunnel",children:[f(D,{label:"Length",help:"The tunnel from inlet to outlet.",children:f(oe,{label:"Length",quantity:"length",unit:tt(s),units:s,valueSi:t.tunnel.length,onCommitSi:o=>n({length:Math.min(G.length[1],Math.max(G.length[0],o))})})}),f(D,{label:"Height",children:f(oe,{label:"Height",quantity:"length",unit:tt(s),units:s,valueSi:t.tunnel.height,onCommitSi:o=>n({height:Math.min(G.height[1],Math.max(G.height[0],o))})})}),f(D,{label:"Walls",help:"Slip walls let the flow slide along them, like open air. Solid walls have boundary layers, like a real tunnel. Periodic: what leaves at the top comes in at the bottom.",children:f(se,{label:"Walls",value:t.tunnel.walls,options:[{value:"slip",label:"Slip (open air)"},{value:"noslip",label:"Solid"},{value:"periodic",label:"Periodic"}],onChange:o=>n({walls:o})})}),f(D,{label:"Resolution",help:"Cells in the grid. Finer grids show more detail and a higher Reynolds number, and run slower. Auto picks the finest this GPU runs smoothly.",children:f(se,{label:"Resolution",value:t.tunnel.resolution,options:[{value:"auto",label:t.tunnel.resolution==="auto"&&r?`Auto (${r.nx} × ${r.ny})`:"Auto"},...["low","medium","high","ultra"].map(o=>({value:o,label:c(o)}))],onChange:o=>n({resolution:o})})}),f(H,{children:"The shaded strips at the inlet and the outlet absorb pressure waves; the flow there is not physical."})]})}const on=[{value:"vorticity",label:"Vorticity"},{value:"speed",label:"Speed"},{value:"pressure",label:"Pressure (Cp)"},{value:"schlieren",label:"Density gradient (schlieren)"},{value:"none",label:"None (markers on a dark background)"}];function ln({store:i}){const e=O(i,t=>t.scene),s=t=>i.commit({...e,view:{...e.view,...t}},!1);return C(we,{title:"View",children:[f(D,{label:"Show",children:f(se,{label:"Show",value:e.view.field,options:on,onChange:t=>s({field:t})})}),f(D,{label:"Colour range",help:"Automatic follows the flow; turn it off to fix the range (in the legend's units).",children:f(pe,{label:"Automatic colour range",checked:e.view.autoRange,onChange:t=>s({autoRange:t})})}),f(D,{label:"Run speed",help:"As fast as possible runs as many steps as the GPU manages each frame. Real time slows it to the speed of the real flow, when the GPU is fast enough.",children:f(se,{label:"Run speed",value:e.view.speed,options:[{value:"max",label:"As fast as possible"},{value:"realtime",label:"Real time"}],onChange:t=>s({speed:t})})})]})}function Xt(i,e,s){const{length:t,height:a}=i.tunnel,n=Ke(Se(e)),r=i.bodies.map(l=>({x:l.x,y:l.y,r:Ke(Se(l.shape))})),c=(l,d)=>r.every(h=>Math.hypot(h.x-l,h.y-d)>(h.r+n)*1.1);let o={x:t*.35,y:a/2};e:for(const l of[.3,.42,.54,.66,.24])for(const d of[.5,.3,.7,.2,.8]){const h=t*l,m=a*d;if(!(m-n<0||m+n>a)&&c(h,m)){o={x:h,y:m};break e}}return{id:nt(),name:s,shape:e,x:o.x,y:o.y,angle:0,spin:0,enabled:!0,locked:!1}}function wt(i,e){const s=i.get().scene,t=s.tunnel.height,a={naca:[{kind:"naca",code:"0012",chord:t/4},"NACA 0012"],circle:[{kind:"circle",diameter:t/10},"Cylinder"],rect:[{kind:"rect",width:t/8,height:t/8},"Rectangle"],ellipse:[{kind:"ellipse",width:t/5,height:t/10},"Ellipse"],plate:[{kind:"plate",length:t/4,thickness:t/80},"Flat plate"]},[n,r]=a[e],c=Xt(s,n,r);i.commit({...s,bodies:[...s.bodies,c]}),i.select(c.id)}function cn({store:i,ws:e}){const s=O(i,o=>o.scene),t=O(i,o=>o.selected),a=be(null),n=s.bodies.length>=G.maxBodies,r=async o=>{try{const l=Ss(await o.text(),o.name),d=i.get().scene,h=Xt(d,{kind:"dat",name:l.name,x:l.x,y:l.y,chord:d.tunnel.height/4},l.name);i.commit({...d,bodies:[...d.bodies,h]}),i.select(h.id),e.ui.toast(l.warnings.length?`Imported ${l.name}. ${l.warnings.join(" ")}`:`Imported ${l.name}.`,{kind:"success"})}catch(l){e.ui.toast(l instanceof W?`${o.name}: ${l.message}`:`${o.name} could not be read: ${String(l)}`,{kind:"error"})}},c=o=>{const l=i.get().scene;i.commit({...l,bodies:l.bodies.filter(d=>d.id!==o.id)}),e.ui.toast(`Removed ${o.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})};return C(we,{title:"Bodies",children:[C("div",{className:"t2d-add-row",children:[f(ae,{variant:"secondary",disabled:n,onClick:()=>wt(i,"naca"),attrs:{"data-t2d-add":"naca"},children:"Add airfoil"}),f(se,{label:"Add shape",value:"",disabled:n,options:[{value:"",label:"Add shape…"},{value:"circle",label:"Cylinder"},{value:"rect",label:"Rectangle"},{value:"ellipse",label:"Ellipse"},{value:"plate",label:"Flat plate"}],onChange:o=>o&&wt(i,o)}),f(ae,{variant:"neutral",disabled:n,onClick:()=>a.current?.click(),attrs:{"data-t2d-import":"1"},children:"Import .dat…"}),f("input",{ref:a,type:"file",accept:".dat,.txt",hidden:!0,"data-t2d-file":!0,onChange:o=>{const l=o.target.files?.[0];o.target.value="",l&&r(l)}})]}),n?C(H,{tone:"warning",children:["A tunnel holds at most ",G.maxBodies," bodies."]}):null,s.bodies.length===0?f(H,{children:"No bodies yet: add an airfoil or a shape, or import an airfoil’s .dat file."}):null,f("ul",{className:"t2d-body-list",role:"listbox","aria-label":"Bodies",children:s.bodies.map(o=>C("li",{role:"option","aria-selected":o.id===t,className:`t2d-body-row${o.id===t?" is-selected":""}${o.enabled?"":" is-off"}`,"data-t2d-body":o.id,onClick:()=>i.select(o.id),children:[f("span",{className:"t2d-body-name",children:o.name}),f("span",{className:"t2d-body-kind",children:Ge(o.shape)===o.name?"":Ge(o.shape)}),f("button",{type:"button",className:"t2d-icon-btn",title:o.enabled?"Take it out of the flow":"Put it in the flow","aria-label":o.enabled?`Take ${o.name} out of the flow`:`Put ${o.name} in the flow`,"aria-pressed":o.enabled,onClick:l=>{l.stopPropagation(),i.updateBody(o.id,{enabled:!o.enabled})},children:f(Ue,{path:o.enabled?"M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6":"M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6",size:14})}),f("button",{type:"button",className:"t2d-icon-btn",title:`Remove ${o.name}`,"aria-label":`Remove ${o.name}`,onClick:l=>{l.stopPropagation(),c(o)},children:f(Ue,{name:"trash",size:14})})]},o.id))})]})}function kt(i,e){const s=i.spinCap(e.id);return s!==null&&Math.abs(e.spin)>s?s:null}function dn({store:i,ws:e,units:s,engine:t}){const a=O(i,v=>v.scene),n=O(i,v=>v.selected),[r,c]=te(""),o=a.bodies.find(v=>v.id===n);if(j(()=>c(""),[n]),!o)return f(we,{title:"Body",attr:"body",children:f(H,{children:"Select a body to edit it. Drag a body to move it, and drag the round handle above it to turn it (Shift: whole degrees)."})});const l=tt(s),d=v=>i.updateBody(o.id,v),h=v=>d({shape:{...o.shape,...v}}),m=v=>Math.max(1e-4,Math.min(1e3,v)),u=(v,S,B,y)=>f(D,{label:v,help:y,children:f(oe,{label:v,quantity:"length",unit:l,units:s,valueSi:S,onCommitSi:x=>B(m(x))})});let g=null;switch(o.shape.kind){case"naca":{const v=o.shape.code;g=C(Oe,{children:[f(D,{label:"NACA designation",help:"4 or 5 digits, such as 2412 or 23012.",children:f(vt,{label:"NACA designation",attr:"naca",value:v,error:r,onCommit:S=>{try{const B=st(S);c("");const y=o.name===`NACA ${v}`?`NACA ${B}`:o.name;d({shape:{...o.shape,code:B},name:y})}catch(B){c(B instanceof le?B.message:String(B))}}})}),r?f(H,{tone:"danger",children:f("span",{"data-t2d-naca-error":!0,children:r})}):null,u("Chord",o.shape.chord,S=>h({chord:S}))]});break}case"dat":g=u("Chord",o.shape.chord,v=>h({chord:v}));break;case"circle":g=u("Diameter",o.shape.diameter,v=>h({diameter:v}));break;case"rect":case"ellipse":g=C(Oe,{children:[u("Width",o.shape.width,v=>h({width:v}),"Along the flow, before turning."),u("Height",o.shape.height,v=>h({height:v}))]});break;case"plate":g=C(Oe,{children:[u("Length",o.shape.length,v=>h({length:v})),u("Thickness",o.shape.thickness,v=>h({thickness:v}),"A plate thinner than about two cells of the grid is drawn thicker than it is.")]});break}const p=t.lattice?.dx??0,A=o.shape.kind==="plate"&&p>0&&o.shape.thickness<2*p;return C(we,{title:"Body",attr:"body",children:[f(D,{label:"Name",children:f(vt,{label:"Name",attr:"name",value:o.name,onCommit:v=>d({name:v.trim().slice(0,80)||o.name})})}),f("div",{className:"t2d-shape-kind",children:Ge(o.shape)}),g,A?C(H,{tone:"warning",children:["This plate is thinner than two grid cells (",re(Jt("length",2*p,s==="imperial"?"in":"mm"))," ",s==="imperial"?"in":"mm","): the flow sees a thicker one."]}):null,u("Position x",o.x,v=>d({x:Math.min(a.tunnel.length,Math.max(0,v))}),o.shape.kind==="naca"||o.shape.kind==="dat"?"Of the quarter chord, from the inlet.":"Of the centre, from the inlet."),f(D,{label:"Position y",help:"From the bottom wall.",children:f(oe,{label:"Position y",quantity:"length",unit:l,units:s,valueSi:o.y,onCommitSi:v=>d({y:Math.min(a.tunnel.height,Math.max(0,v))})})}),f(D,{label:o.shape.kind==="naca"||o.shape.kind==="dat"?"Angle of attack":"Angle",help:"Positive raises the leading (left) side.",children:f(oe,{label:"Angle",unit:"°",valueSi:o.angle,onCommitSi:v=>d({angle:Math.max(-180,Math.min(180,v))})})}),f(D,{label:"Spin",help:"Turns the body continuously; positive is counter-clockwise. A spinning cylinder shows the Magnus effect.",children:f(oe,{label:"Spin",quantity:"angular_velocity",unit:"rpm",units:s,valueSi:o.spin,onCommitSi:v=>d({spin:Math.max(-1e4,Math.min(1e4,v))})})}),kt(t,o)?f(H,{tone:"warning",children:C("span",{"data-t2d-spin-capped":!0,children:["This spin is held to ",re(kt(t,o)*(60/(2*Math.PI)))," rpm: the body’s edge would move faster than twice the wind speed, more than the lattice can carry."]})}):null,f(D,{label:"In the flow",children:f(pe,{label:"In the flow",checked:o.enabled,onChange:v=>d({enabled:v})})}),f(D,{label:"Locked",help:"A locked body cannot be dragged or turned with the mouse.",children:f(pe,{label:"Locked",checked:o.locked,onChange:v=>d({locked:v})})}),f("div",{className:"t2d-panel-foot",children:f(ae,{variant:"danger",onClick:()=>{const v=i.get().scene;i.commit({...v,bodies:v.bodies.filter(S=>S.id!==o.id)}),e.ui.toast(`Removed ${o.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})},attrs:{"data-t2d-remove":o.id},children:"Remove body"})})]})}const un={streaks:"Streaks",timelines:"Timelines",dye:"Dye"},hn=["Blue","Purple","Green","Orange","Sky blue","Pink"],fn=i=>`var(--mg-series-${i%_e+1})`;function zt({title:i,children:e,attr:s}){return C("section",{className:"t2d-section","data-t2d-section":s,children:[f("h2",{className:"t2d-section-title",children:i}),f("div",{className:"t2d-section-body",children:e})]})}function de(i,e){const s=i.rakes.filter(t=>t.kind===e.kind);return`${un[e.kind]} ${s.indexOf(e)+1}`}function mn(i,e){const s=i.get().scene,{length:t,height:a}=s.tunnel,n=new Set(s.rakes.map(d=>d.color));let r=0;for(;n.has(r)&&r<_e-1;)r++;const c=s.rakes.length,o=t*(.1+.02*(c%4)),l={id:Et(),kind:e,x0:o,y0:a*.3,x1:o,y1:a*.7,emitters:e==="dye"?7:12,color:r,enabled:!0};i.commit({...s,rakes:[...s.rakes,l]}),i.select(l.id)}function pn({store:i,ws:e}){const s=O(i,l=>l.scene),t=O(i,l=>l.selected),a=s.view,n=l=>i.commit({...s,view:{...a,...l}},!1),r=s.rakes.filter(l=>l.kind==="dye").length,c=s.rakes.length>=G.maxRakes,o=l=>{const d=i.get().scene;i.commit({...d,rakes:d.rakes.filter(h=>h.id!==l.id)}),e.ui.toast(`Removed ${de(s,l)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})};return C(zt,{title:"Flow markers",attr:"markers",children:[f(D,{label:"Tracer particles",help:"Particles spread through the whole tunnel, carried by the flow.",children:f(pe,{label:"Tracer particles",checked:a.tracers,onChange:l=>n({tracers:l})})}),f(D,{label:"Particle count",children:f(se,{label:"Particle count",value:a.density,disabled:!a.tracers,options:[{value:"low",label:"Few"},{value:"normal",label:"Normal"},{value:"high",label:"Many"}],onChange:l=>n({density:l})})}),f(D,{label:"Trails",help:"How long each particle’s path stays drawn behind it.",children:f(se,{label:"Trails",value:a.trail,options:[{value:"off",label:"Off"},{value:"short",label:"Short"},{value:"long",label:"Long"}],onChange:l=>n({trail:l})})}),f(D,{label:"Velocity arrows",children:f(pe,{label:"Velocity arrows",checked:a.arrows,onChange:l=>n({arrows:l})})}),f(D,{label:"Streamlines",help:"Lines along the flow’s direction now, from just past the inlet. In shedding flow they differ from the particles’ paths.",children:f(pe,{label:"Streamlines",checked:a.streamlines,onChange:l=>n({streamlines:l})})}),f("div",{className:"t2d-add-row",children:f(se,{label:"Add rake",value:"",disabled:c,options:[{value:"",label:"Add rake…"},{value:"streaks",label:"Streaks (a thread from each emitter)"},{value:"timelines",label:"Timelines (a line released at intervals)"},{value:"dye",label:"Dye",disabled:r>=G.maxDyeRakes}],onChange:l=>l&&mn(i,l)})}),c?C(H,{tone:"warning",children:["A tunnel holds at most ",G.maxRakes," rakes."]}):null,r>=G.maxDyeRakes?C(H,{children:["At most ",G.maxDyeRakes," dye rakes: one colour each."]}):null,s.rakes.length?f("ul",{className:"t2d-body-list",role:"listbox","aria-label":"Rakes",children:s.rakes.map(l=>C("li",{role:"option","aria-selected":l.id===t,className:`t2d-body-row${l.id===t?" is-selected":""}${l.enabled?"":" is-off"}`,"data-t2d-rake":l.id,onClick:()=>i.select(l.id),children:[f("span",{className:"t2d-swatch",style:{background:fn(l.color)}}),f("span",{className:"t2d-body-name",children:de(s,l)}),f("span",{className:"t2d-body-kind"}),f("button",{type:"button",className:"t2d-icon-btn","aria-pressed":l.enabled,"aria-label":l.enabled?`Stop ${de(s,l)}`:`Start ${de(s,l)}`,title:l.enabled?"Stop it":"Start it",onClick:d=>{d.stopPropagation();const h=i.get().scene;i.commit({...h,rakes:h.rakes.map(m=>m.id===l.id?{...m,enabled:!m.enabled}:m)})},children:f(Ue,{path:l.enabled?"M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6":"M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6",size:14})}),f("button",{type:"button",className:"t2d-icon-btn","aria-label":`Remove ${de(s,l)}`,title:"Remove it",onClick:d=>{d.stopPropagation(),o(l)},children:f(Ue,{name:"trash",size:14})})]},l.id))}):f(H,{children:"A rake releases streaks, timelines or dye from a line you place and drag in the tunnel."})]})}function yn({store:i,ws:e,units:s,rake:t}){const a=O(i,u=>u.scene),n=s==="imperial"?"ft":"m",r=u=>{const g=i.get().scene;i.commit({...g,rakes:g.rakes.map(p=>p.id===t.id?{...p,...u}:p)})},{length:c,height:o}=a.tunnel,l=u=>Math.min(c,Math.max(0,u)),d=u=>Math.min(o,Math.max(0,u)),h=a.rakes.filter(u=>u.kind==="dye"&&u.id!==t.id).length,m=(u,g,p)=>f(D,{label:u,children:f(oe,{label:u,quantity:"length",unit:n,units:s,valueSi:g,onCommitSi:p})});return C(zt,{title:"Rake",attr:"rake",children:[f("div",{className:"t2d-shape-kind","data-t2d-rake-name":!0,children:de(a,t)}),f(D,{label:"Releases",children:f(se,{label:"Releases",value:t.kind,options:[{value:"streaks",label:"Streaks"},{value:"timelines",label:"Timelines"},{value:"dye",label:"Dye",disabled:h>=G.maxDyeRakes}],onChange:u=>r({kind:u})})}),t.kind!=="timelines"?f(D,{label:"Emitters",help:"Points along the rake that release the markers.",children:f(oe,{label:"Emitters",valueSi:t.emitters,onCommitSi:u=>r({emitters:Math.round(Math.min(G.emitters[1],Math.max(G.emitters[0],u)))})})}):null,f(D,{label:"Colour",children:f(se,{label:"Colour",value:String(t.color),options:hn.map((u,g)=>({value:String(g),label:u})),onChange:u=>r({color:Number(u)})})}),m("Start x",t.x0,u=>r({x0:l(u)})),m("Start y",t.y0,u=>r({y0:d(u)})),m("End x",t.x1,u=>r({x1:l(u)})),m("End y",t.y1,u=>r({y1:d(u)})),f(D,{label:"Releasing",children:f(pe,{label:"Releasing",checked:t.enabled,onChange:u=>r({enabled:u})})}),f(H,{children:"Drag the rake to move it, or one of its ends to stretch or turn it."}),f("div",{className:"t2d-panel-foot",children:f(ae,{variant:"danger",attrs:{"data-t2d-remove-rake":t.id},onClick:()=>{const u=i.get().scene;i.commit({...u,rakes:u.rakes.filter(g=>g.id!==t.id)}),e.ui.toast(`Removed ${de(a,t)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})},children:"Remove rake"})})]})}const gn=26,Ye=7,$e=new Map;function bn(i){const e=JSON.stringify(i.shape);let s=$e.get(e);return s||(s=Se(i.shape),$e.size>64&&$e.clear(),$e.set(e,s)),s}function me(i,e){return St(bn(i),{x:e.x,y:e.y,theta:-e.angle*Math.PI/180})}function Wt(i,e){const s=i.worldView,t=(o,l)=>({x:s.w/2+(o-s.cx)/s.mpp,y:s.h/2-(l-s.cy)/s.mpp}),a=i.livePose(e.id)??{x:e.x,y:e.y,angle:e.angle},n=me(e,a);let r=1/0;for(let o=1;o<n.length;o+=2)r=Math.min(r,t(0,n[o]).y);const c=t(a.x,a.y);return{x:c.x,y:r-gn,cx:c.x,cy:c.y}}function Ee(i,e){const s=i.worldView,{length:t,height:a}=e.tunnel,n=Math.max(t/Math.max(50,s.w-32),a/Math.max(50,s.h-32));i.worldView={...s,cx:t/2,cy:a/2,mpp:n}}function xn({engine:i,store:e,onStatus:s}){const t=be(null),a=be(null),n=be(null),r=be(null),c=be("");j(()=>{const y=t.current,x=new ResizeObserver(()=>{const w=y.getBoundingClientRect(),k=window.devicePixelRatio||1,M=i.canvas;M.width=Math.max(1,Math.round(w.width*k)),M.height=Math.max(1,Math.round(w.height*k));const P=n.current;P.width=M.width,P.height=M.height,i.worldView={...i.worldView,w:w.width,h:w.height,dpr:k};const $=e.get().scene,b=`${$.tunnel.length}x${$.tunnel.height}`;c.current!==b&&(Ee(i,$),c.current=b)});return x.observe(y),()=>x.disconnect()},[i,e]),j(()=>{const y=a.current;return y.replaceWith(i.canvas),i.canvas.className="t2d-canvas",i.canvas.setAttribute("data-t2d-canvas","1"),()=>{i.canvas.replaceWith(y)}},[i]),j(()=>e.subscribe(()=>{const y=e.get().scene,x=`${y.tunnel.length}x${y.tunnel.height}`;c.current&&c.current!==x&&(Ee(i,y),c.current=x)}),[i,e]);const o=(y,x)=>{const w=t.current.getBoundingClientRect(),k=i.worldView;return{x:k.cx+(y-w.left-k.w/2)*k.mpp,y:k.cy-(x-w.top-k.h/2)*k.mpp}},l=(y,x)=>{const w=i.worldView;return{x:w.w/2+(y-w.cx)/w.mpp,y:w.h/2-(x-w.cy)/w.mpp}},d=y=>i.livePose(y.id)??{x:y.x,y:y.y,angle:y.angle},h=y=>Wt(i,y);j(()=>{let y=0;const x=getComputedStyle(document.documentElement),w=x.getPropertyValue("--t2d-select").trim()||"black",k=x.getPropertyValue("--t2d-ghost").trim()||"gray",M=x.getPropertyValue("--mg-bg").trim()||"white",P=()=>{y=requestAnimationFrame(P);const $=n.current;if(!$)return;const b=$.getContext("2d"),E=i.worldView;b.setTransform(E.dpr,0,0,E.dpr,0,0),b.clearRect(0,0,E.w,E.h);const{scene:U,selected:F}=e.get(),T=r.current;for(const R of U.rakes){const Z=x.getPropertyValue(`--mg-series-${R.color%6+1}`).trim()||w,L=l(R.x0,R.y0),Y=l(R.x1,R.y1),ye=R.id===F;if(b.globalAlpha=R.enabled?1:.45,b.beginPath(),b.moveTo(L.x,L.y),b.lineTo(Y.x,Y.y),b.strokeStyle=Z,b.lineWidth=ye?3:2,b.setLineDash(R.kind==="timelines"?[6,4]:[]),b.stroke(),b.setLineDash([]),R.kind!=="timelines"){b.fillStyle=Z;for(let _=0;_<R.emitters;_++){const V=R.emitters===1?.5:_/(R.emitters-1);b.beginPath(),b.arc(L.x+(Y.x-L.x)*V,L.y+(Y.y-L.y)*V,2.5,0,Math.PI*2),b.fill()}}if(ye)for(const _ of[L,Y])b.fillStyle=M,b.strokeStyle=Z,b.lineWidth=2,b.fillRect(_.x-5,_.y-5,10,10),b.strokeRect(_.x-5,_.y-5,10,10);b.globalAlpha=1}for(const R of U.bodies){const Z=R.id===F,L=T&&(T.kind==="move"||T.kind==="turn")&&T.id===R.id?{x:T.kind==="move"?T.bodyX:T.x,y:T.kind==="move"?T.bodyY:T.y,angle:T.angle}:null,Y=d(R),ye=_=>{b.beginPath();for(let V=0;V<_.length;V+=2){const Ae=l(_[V],_[V+1]);V===0?b.moveTo(Ae.x,Ae.y):b.lineTo(Ae.x,Ae.y)}b.closePath()};if(R.enabled||(ye(me(R,Y)),b.setLineDash([4,4]),b.strokeStyle=k,b.lineWidth=1.5,b.stroke(),b.setLineDash([])),L&&(Math.abs(L.x-Y.x)>1e-6||Math.abs(L.y-Y.y)>1e-6||Math.abs(L.angle-Y.angle)>.001)&&(ye(me(R,L)),b.setLineDash([5,4]),b.strokeStyle=k,b.lineWidth=1.5,b.stroke(),b.setLineDash([])),Z){if(ye(me(R,Y)),b.strokeStyle=w,b.lineWidth=2,b.stroke(),!R.locked){const V=h(R);b.beginPath(),b.moveTo(V.cx,V.cy),b.lineTo(V.x,V.y+Ye),b.strokeStyle=w,b.lineWidth=1,b.stroke(),b.beginPath(),b.arc(V.x,V.y,Ye,0,Math.PI*2),b.fillStyle=M,b.fill(),b.lineWidth=2,b.stroke()}const _=l(Y.x,Y.y);b.beginPath(),b.moveTo(_.x-5,_.y),b.lineTo(_.x+5,_.y),b.moveTo(_.x,_.y-5),b.lineTo(_.x,_.y+5),b.lineWidth=1.5,b.stroke()}}};return y=requestAnimationFrame(P),()=>cancelAnimationFrame(y)},[i,e]);const m=(y,x)=>{const w=e.get().scene.bodies;for(let k=w.length-1;k>=0;k--){const M=w[k];if(De(me(M,d(M)),y,x))return M}return null},u=(y,x)=>{const w=t.current.getBoundingClientRect(),k=y-w.left,M=x-w.top,{scene:P,selected:$}=e.get();for(let b=P.rakes.length-1;b>=0;b--){const E=P.rakes[b],U=l(E.x0,E.y0),F=l(E.x1,E.y1);if(E.id===$){if(Math.hypot(k-U.x,M-U.y)<=8)return{rake:E,part:"start"};if(Math.hypot(k-F.x,M-F.y)<=8)return{rake:E,part:"end"}}const T=F.x-U.x,R=F.y-U.y,Z=T*T+R*R,L=Z>0?Math.max(0,Math.min(1,((k-U.x)*T+(M-U.y)*R)/Z)):0;if(Math.hypot(k-(U.x+L*T),M-(U.y+L*R))<=6)return{rake:E,part:"all"}}return null},g=(y,x)=>{const w=e.get().scene.tunnel;return{x:Math.min(w.length,Math.max(0,y)),y:Math.min(w.height,Math.max(0,x))}},p=y=>{y.target.setPointerCapture(y.pointerId);const x=o(y.clientX,y.clientY),w=i.worldView;if(y.button===1){r.current={kind:"pan",startX:y.clientX,startY:y.clientY,cx:w.cx,cy:w.cy};return}if(y.button!==0)return;const{scene:k,selected:M}=e.get(),P=k.bodies.find(E=>E.id===M);if(P&&!P.locked){const E=h(P),U=t.current.getBoundingClientRect();if(Math.hypot(y.clientX-U.left-E.x,y.clientY-U.top-E.y)<=Ye+4){const F=d(P),T=Math.atan2(x.y-F.y,x.x-F.x);r.current={kind:"turn",id:P.id,startAngle:P.angle,pointerStart:T,angle:P.angle,x:P.x,y:P.y};return}}const $=u(y.clientX,y.clientY);if($){e.select($.rake.id),r.current={kind:"rake",id:$.rake.id,part:$.part,startX:x.x,startY:x.y,r0:$.rake,before:e.get().scene};return}const b=m(x.x,x.y);if(b){e.select(b.id),b.locked||(r.current={kind:"move",id:b.id,startX:x.x,startY:x.y,bodyX:b.x,bodyY:b.y,angle:b.angle,moved:!1});return}e.select(null),r.current={kind:"pan",startX:y.clientX,startY:y.clientY,cx:w.cx,cy:w.cy}},A=y=>{const x=r.current;if(!x){const M=o(y.clientX,y.clientY),P=u(y.clientX,y.clientY),$=P?null:m(M.x,M.y);t.current.style.cursor=P?P.part==="all"?"move":"crosshair":$&&!$.locked?"grab":"default";return}if(x.kind==="rake"){const M=o(y.clientX,y.clientY),P=M.x-x.startX,$=M.y-x.startY,b=x.r0,E=g(b.x0+(x.part==="end"?0:P),b.y0+(x.part==="end"?0:$)),U=g(b.x1+(x.part==="start"?0:P),b.y1+(x.part==="start"?0:$)),F=e.get().scene;e.commit({...F,rakes:F.rakes.map(T=>T.id===x.id?{...T,x0:E.x,y0:E.y,x1:U.x,y1:U.y}:T)},!1);return}if(x.kind==="pan"){const M=i.worldView;i.worldView={...M,cx:x.cx-(y.clientX-x.startX)*M.mpp,cy:x.cy+(y.clientY-x.startY)*M.mpp};return}const w=o(y.clientX,y.clientY),k=e.get().scene.bodies.find(M=>M.id===x.id);if(k)if(x.kind==="move"){const M=g(k.x+(w.x-x.startX),k.y+(w.y-x.startY));x.bodyX=M.x,x.bodyY=M.y,x.moved=!0,t.current.style.cursor="grabbing",i.setTarget(x.id,{x:M.x,y:M.y,angle:x.angle}),s?.(`x ${M.x.toFixed(3)} m, y ${M.y.toFixed(3)} m`)}else{const M=d(k),P=Math.atan2(w.y-M.y,w.x-M.x);let $=x.startAngle-(P-x.pointerStart)*180/Math.PI;$=(($+180)%360+360)%360-180,y.shiftKey&&($=Math.round($)),x.angle=$,i.setTarget(x.id,{x:x.x,y:x.y,angle:$}),s?.(`Angle ${$.toFixed(1)}°`)}},v=()=>{const y=r.current;if(r.current=null,s?.(""),!(!y||y.kind==="pan")){if(y.kind==="rake"){const x=e.get().scene;x!==y.before&&e.commitFrom(y.before,x);return}y.kind==="move"&&y.moved&&e.updateBody(y.id,{x:y.bodyX,y:y.bodyY}),y.kind==="turn"&&e.updateBody(y.id,{angle:y.angle}),i.setTarget(y.id,null)}};return C("div",{ref:t,className:"t2d-viewport","data-t2d-viewport":!0,onPointerDown:p,onPointerMove:A,onPointerUp:v,onPointerCancel:v,onWheel:y=>{const x=i.worldView,w=o(y.clientX,y.clientY),k=e.get().scene.tunnel,M=Math.min(Math.max(k.length,k.height)/50,Math.max(k.length/1e5,x.mpp*Math.exp(y.deltaY*.0015)));i.worldView={...x,mpp:M};const P=o(y.clientX,y.clientY);i.worldView={...i.worldView,cx:i.worldView.cx+(w.x-P.x),cy:i.worldView.cy+(w.y-P.y)}},onDoubleClick:y=>{const x=o(y.clientX,y.clientY);m(x.x,x.y)||Ee(i,e.get().scene)},onContextMenu:y=>y.preventDefault(),children:[f("canvas",{ref:a}),f("canvas",{ref:n,className:"t2d-overlay"})]})}function vn(i,e,s){const t=e.flow.speed;switch(i){case"vorticity":return{title:"Vorticity",unit:"1/s",k:t/s,centred:!0};case"speed":return{title:"Speed",unit:"m/s",k:t,centred:!1};case"pressure":return{title:"Pressure coefficient Cp",unit:"",k:1,centred:!0};case"schlieren":return{title:"Density gradient (relative)",unit:"",k:1,centred:!1};case"none":return{title:"",unit:"",k:1,centred:!1}}}function jt(i){const[,e]=te(0);j(()=>{const s=setInterval(()=>e(t=>t+1),i);return()=>clearInterval(s)},[i])}function wn({engine:i,store:e}){jt(300);const s=O(e,n=>n.save),t=i.stats,a={saved:"Saved",pending:"Not saved yet",saving:"Saving…",failed:"Not saved",conflict:"Saved elsewhere"}[s];return C("div",{className:"t2d-status","data-t2d-status":!0,"data-state":t.state,"data-steps":t.stepsPerFrame,"data-grid":`${t.nx}x${t.ny}`,children:[f("span",{title:"The GPU the flow runs on",children:t.adapter}),C("span",{children:[t.nx," × ",t.ny," cells"]}),C("span",{children:[t.stepsPerFrame," steps a frame"]}),f("span",{title:"Simulated seconds per second",children:t.state==="running"?`×${re(t.speedRatio)} real time`:t.state==="paused"?"Paused":"Stopped"}),performance.now()-i.limitedAt<2e3?f("span",{className:"t2d-squeeze","data-t2d-squeeze":!0,title:"Flow squeezed between bodies that touch or close a gap is held to equilibrium there, so the flow in that gap is approximate.",children:"Bodies close a gap: flow there approximated"}):null,C("span",{"data-t2d-simtime":t.simTime,children:["t = ",t.simTime<1?`${(t.simTime*1e3).toPrecision(3)} ms`:`${t.simTime.toPrecision(4)} s`]}),f("span",{className:`t2d-save t2d-save--${s}`,"data-t2d-save":s,children:a})]})}function kn({engine:i,store:e}){jt(400);const s=O(e,l=>l.scene),t=s.bodies.find(l=>l.enabled),a=t?xe(t.shape):s.tunnel.height/8,n=vn(s.view.field,s,a),r=i.autoRangeNow,c=s.view.autoRange?r?.lo??s.view.min/n.k:s.view.min/n.k,o=s.view.autoRange?r?.hi??s.view.max/n.k:s.view.max/n.k;return j(()=>{s.view.autoRange||i.setRange(s.view.min/n.k,s.view.max/n.k)},[i,s.view.autoRange,s.view.min,s.view.max,n.k]),s.view.field==="none"?null:C("div",{className:"t2d-legend","data-t2d-legend":!0,"data-lo":c*n.k,"data-hi":o*n.k,children:[f(Qt,{map:Vt[s.view.field],min:c*n.k,max:o*n.k,title:n.title,unit:n.unit,centred:n.centred,ticks:5,format:re}),s.view.autoRange?null:f(Mn,{lo:s.view.min,hi:s.view.max,onCommit:(l,d)=>e.commit({...s,view:{...s.view,min:l,max:d}},!1)})]})}function Mn({lo:i,hi:e,onCommit:s}){const[t,a]=te(String(i)),[n,r]=te(String(e));j(()=>{a(String(i)),r(String(e))},[i,e]);const c=()=>{const o=Number(t),l=Number(n);Number.isFinite(o)&&Number.isFinite(l)&&l>o?s(o,l):(a(String(i)),r(String(e)))};return C("div",{className:"t2d-range",children:[f("input",{className:"mgk-input","aria-label":"Colour range minimum",value:t,onChange:o=>a(o.target.value),onBlur:c,onKeyDown:o=>o.key==="Enter"&&c()}),f("span",{children:"to"}),f("input",{className:"mgk-input","aria-label":"Colour range maximum",value:n,onChange:o=>r(o.target.value),onBlur:c,onKeyDown:o=>o.key==="Enter"&&c()})]})}function Pn({ws:i,store:e,engine:s,units:t,problem:a}){const[n,r]=te(t),[c,o]=te(!1),[l,d]=te(!1),[h,m]=te(""),u=O(e,S=>S.save),g=O(e,S=>S.saveError),p=O(e,S=>S.scene.rakes.find(B=>B.id===S.selected)??null);j(()=>i.on("units",r),[i]),j(()=>(s.onUnstable=()=>{d(!0),i.ui.toast("The flow became unstable and was stopped. Reset the flow to start again.",{kind:"error"})},()=>{s.onUnstable=null}),[s,i]);const A=()=>{s.paused=!s.paused,o(s.paused)},v=()=>{s.resetFlow(),d(!1)};return j(()=>{const S=B=>{const y=B.target;if(y&&(y.tagName==="INPUT"||y.tagName==="SELECT"||y.tagName==="TEXTAREA"||y.isContentEditable))return;const x=B.ctrlKey||B.metaKey;if(x&&B.key.toLowerCase()==="z"&&!B.shiftKey)B.preventDefault(),e.undo();else if(x&&(B.key.toLowerCase()==="y"||B.key.toLowerCase()==="z"&&B.shiftKey))B.preventDefault(),e.redo();else if(B.key===" "&&!x)B.preventDefault(),A();else if((B.key==="Delete"||B.key==="Backspace")&&e.get().selected){B.preventDefault();const w=e.get().scene,k=w.bodies.find(P=>P.id===e.get().selected),M=w.rakes.find(P=>P.id===e.get().selected);k?(e.commit({...w,bodies:w.bodies.filter(P=>P.id!==k.id)}),i.ui.toast(`Removed ${k.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})):M&&(e.commit({...w,rakes:w.rakes.filter(P=>P.id!==M.id)}),i.ui.toast(`Removed ${de(w,M)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"}))}else if(B.key==="Escape")e.select(null);else if(B.key.startsWith("Arrow")&&e.get().selected){const w=e.get().scene,k=w.bodies.find($=>$.id===e.get().selected);if(!k||k.locked)return;B.preventDefault();const M=w.tunnel.height/200*(B.shiftKey?10:1),P={ArrowLeft:[-M,0],ArrowRight:[M,0],ArrowUp:[0,M],ArrowDown:[0,-M]}[B.key]??[0,0];e.updateBody(k.id,{x:Math.min(w.tunnel.length,Math.max(0,k.x+P[0])),y:Math.min(w.tunnel.height,Math.max(0,k.y+P[1]))})}};return window.addEventListener("keydown",S),()=>window.removeEventListener("keydown",S)}),C("div",{className:"t2d-app","data-t2d-app":!0,children:[C("header",{className:"t2d-toolbar",role:"toolbar","aria-label":"Tunnel",children:[f(ae,{variant:c?"primary":"secondary",onClick:A,attrs:{"data-t2d-play":c?"paused":"running"},title:"Space",children:c?"Run":"Pause"}),f(ae,{variant:"neutral",onClick:v,attrs:{"data-t2d-reset":"1"},title:"Start the flow again from a uniform stream",children:"Reset flow"}),f("span",{className:"t2d-sep"}),f(ae,{variant:"neutral",onClick:()=>e.undo(),disabled:!e.canUndo,title:"Ctrl+Z",attrs:{"data-t2d-undo":"1"},children:"Undo"}),f(ae,{variant:"neutral",onClick:()=>e.redo(),disabled:!e.canRedo,title:"Ctrl+Y",attrs:{"data-t2d-redo":"1"},children:"Redo"}),f(ae,{variant:"neutral",onClick:()=>Ee(s,e.get().scene),title:"Double-click empty space",attrs:{"data-t2d-fit":"1"},children:"Fit view"}),f("span",{className:"t2d-toolbar-hint","data-t2d-hint":!0,children:h})]}),C("div",{className:"t2d-main",children:[C("aside",{className:"t2d-side",children:[f(an,{store:e,engine:s,units:n}),f(cn,{store:e,ws:i}),f(pn,{store:e,ws:i}),f(rn,{store:e,engine:s,units:n}),f(ln,{store:e})]}),C("div",{className:"t2d-stage",children:[a?f("div",{className:"t2d-banner",children:f(Le,{reason:`The saved tunnel could not be read (${a}), so a new one was started.`,role:"alert"})}):null,u==="conflict"||u==="failed"?f("div",{className:"t2d-banner","data-t2d-save-problem":!0,children:f(Le,{reason:u==="conflict"?g:`The tunnel could not be saved: ${g}`,role:"alert"})}):null,l?f("div",{className:"t2d-banner","data-t2d-unstable":!0,children:f(Le,{reason:"The flow became unstable and was stopped.",fix:{label:"Reset flow",onFix:v},role:"alert"})}):null,f(xn,{engine:s,store:e,onStatus:m}),f(kn,{engine:s,store:e}),f(wn,{engine:s,store:e})]}),f("aside",{className:"t2d-side t2d-side--right",children:p?f(yn,{store:e,ws:i,units:n,rake:p}):f(dn,{store:e,ws:i,units:n,engine:s})})]})]})}const Bn=400,Yt=i=>`studies/${i}/scene.json`;async function Sn(i,e){const s=Yt(e),t=await i.files.stat(s);if(!t)return{scene:Te(),etag:null,problem:""};const a=await i.files.read(s);if(!a)return{scene:Te(),etag:null,problem:""};try{return{scene:Ts(JSON.parse(new TextDecoder().decode(a))),etag:t.etag,problem:""}}catch(n){return{scene:Te(),etag:t.etag,problem:n instanceof Error?n.message:String(n)}}}class An{constructor(e,s,t,a){this.ws=e,this.store=s,this.studyId=t,this.etag=a}timer=null;latest=null;writing=null;schedule(e){this.store.get().save!=="conflict"&&(this.latest=e,this.store.setSave("pending"),this.ws.nav.setDirty(!0,"The tunnel’s last changes are not saved yet."),this.timer&&clearTimeout(this.timer),this.timer=setTimeout(()=>void this.flush(),Bn))}async flush(){this.timer&&clearTimeout(this.timer),this.timer=null,this.writing&&await this.writing;const e=this.latest;e&&(this.latest=null,this.store.setSave("saving"),this.writing=(async()=>{try{const s=await this.ws.files.write(Yt(this.studyId),JSON.stringify(e,null,1),{ifMatch:this.etag});this.etag=s.etag,this.latest||(this.store.setSave("saved"),await this.ws.nav.setDirty(!1))}catch(s){s?.code==="changed"?(this.store.setSave("conflict","This tunnel was saved from another tab. Reopen it to see that version; changes here are not saved."),await this.ws.nav.setDirty(!1)):(this.latest=this.latest??e,this.store.setSave("failed",s instanceof Error?s.message:String(s)))}finally{this.writing=null}})(),await this.writing)}async create(e){this.latest=e,await this.flush()}}function $n(i,e,s,t,a=.3){const n=2/(s*s*t),r=i.length,c=Math.floor(r*(1-a));let o=0;for(let p=c;p<r;p++)o+=e[p]*n;o/=r-c;const l=[];for(let p=c+1;p<r;p++){const A=e[p-1]*n-o,v=e[p]*n-o;A<0&&v>=0&&l.push(p-1+A/(A-v))}let d=-1/0,h=0,m=-1/0;for(let p=c;p<r;p++)d=Math.max(d,i[p]*n),h+=i[p]*n,m=Math.max(m,e[p]*n);const u=l.length-1,g=u>0?(l[l.length-1]-l[0])/u:NaN;return{St:t/(g*s),cdMax:d,cdMean:h/(r-c),clMax:m,periods:u}}async function Cn(i,e=20,s=200,t){const a=Math.round(4.1*e),n=22*e,r=.05,c=2/3*r,o=c*e/100,l=new Qe(i,{nx:n,ny:a,walls:"noslip",profile:1,absorbing:!1});l.setPhysics({u:r,tau:3*o+.5,smagorinsky:!1,smagCs:0}),l.reset(0);const d=Se({kind:"circle",diameter:e}),h=At(d),m={x:2*e,y:-.5+2*e,theta:0};l.setBodies([{key:"cyl",sdf:h,from:m,to:m}]);const u=Math.ceil(s*e/c),g=new Float64Array(u),p=new Float64Array(u),A=performance.now();let v=0,S=0;const B=Math.ceil(2*e/c);for(let x=0;x<u;){const w=Math.min(ee,u-x,x<B?200:ee),k=x<B?.5*(1-Math.cos(Math.PI*x/B)):1;l.setPhysics({u:r*k,tau:3*o+.5,smagorinsky:!1,smagCs:0});const M=i.createCommandEncoder();l.encodeFrame(M,w,{mode:1,uRef:r,lRef:e});const P=l.prepareRead(M,w);i.queue.submit([M.finish()]);const $=await P();if(!$)throw new Error("The force readback failed.");for(let b=0;b<w;b++)g[x+b]=$.forces[0].perStep[2*b],p[x+b]=$.forces[0].perStep[2*b+1];if(v+=$.bad,S+=$.limited,x+=w,v)break}l.destroy();const y=$n(g,p,c,e);return{N:e,steps:u,seconds:(performance.now()-A)/1e3,...y,bad:v,limited:S}}function Rn({store:i,engine:e,device:s}){window.__TUNNEL__={ready:!0,scene:()=>i.get().scene,selected:()=>i.get().selected,save:()=>i.get().save,stats:()=>({...e.stats,map:e.lattice,unstableAt:e.unstableAt,limitedTotal:e.limitedTotal}),view:()=>({...e.worldView}),livePose:t=>e.livePose(t),bodyLive:t=>e.bodyLive(t),sampleField:async()=>{const t=await e.sampleField();return t?Array.from(t,a=>Number.isFinite(a)?a:null):null},toScreen:(t,a)=>{const n=e.worldView,r=e.canvas.getBoundingClientRect();return{x:r.left+n.w/2+(t-n.cx)/n.mpp,y:r.top+n.h/2-(a-n.cy)/n.mpp}},turnHandle:t=>{const a=i.get().scene.bodies.find(c=>c.id===t);if(!a)return null;const n=e.canvas.getBoundingClientRect(),r=Wt(e,a);return{x:n.left+r.x,y:n.top+r.y,cx:n.left+r.cx,cy:n.top+r.cy}},validate:(t=20,a=200)=>Cn(s,t,a),particles:async()=>{const t=await e.readParticles();if(!t)return null;const a=i.get().scene,n=t.dx,r=a.bodies.filter(h=>h.enabled).map(h=>({b:h,poly:me(h,e.livePose(h.id)??{x:h.x,y:h.y,angle:h.angle})}));let c=0,o=0,l=0;const d=t.pools.map(h=>({id:h.id,alive:0,maxX:-1/0}));for(let h=0;h<t.meta.length/4;h++){if(t.meta[4*h+3]<.5||t.meta[4*h]<0)continue;const m=(t.pos[4*h]+.5)*n,u=(t.pos[4*h+1]+.5)*n;if(!Number.isFinite(m)||!Number.isFinite(u)){o++;continue}const g=t.meta[4*h+1];if(g<0)c++;else{const p=d[g];p&&(p.alive++,p.maxX=Math.max(p.maxX,m))}for(const{poly:p}of r)De(p,m,u)&&lt(p,m,u)<-.5*n&&l++}return{tracers:t.tracers,tracersAlive:c,nan:o,inside:l,pools:d}},dye:async()=>{const t=await e.readDye();if(!t)return null;const a=[0,0,0,0],n=[-1/0,-1/0,-1/0,-1/0],c=i.get().scene.bodies.filter(l=>l.enabled).map(l=>me(l,e.livePose(l.id)??{x:l.x,y:l.y,angle:l.angle}));let o=0;for(const l of c){let d=1/0,h=-1/0,m=1/0,u=-1/0;for(let g=0;g<l.length;g+=2)d=Math.min(d,l[g]),h=Math.max(h,l[g]),m=Math.min(m,l[g+1]),u=Math.max(u,l[g+1]);for(let g=Math.max(0,Math.floor(m/t.dx));g<=Math.min(t.ny-1,Math.ceil(u/t.dx));g++)for(let p=Math.max(0,Math.floor(d/t.dx));p<=Math.min(t.nx-1,Math.ceil(h/t.dx));p++){const A=(p+.5)*t.dx,v=(g+.5)*t.dx;if(De(l,A,v)&&lt(l,A,v)<-t.dx){const S=g*t.nx+p;o+=t.data[4*S]+t.data[4*S+1]+t.data[4*S+2]+t.data[4*S+3]}}}for(let l=0;l<t.nx*t.ny;l++)for(let d=0;d<4;d++){const h=t.data[4*l+d];h>.05&&(a[d]+=h,n[d]=Math.max(n[d],(l%t.nx+.5)*t.dx))}return{channels:t.channels,sums:a,maxX:n,insideSum:o}},streamlines:()=>e.streamlineCount}}function Tn(){return[...ks(),{label:"particles advect",code:_t()},{label:"particles draw",code:Ft()},{label:"trail fade",code:qt},{label:"rake lines",code:It()},{label:"dye advect",code:Dt()},{label:"dye correct",code:Gt()},{label:"dye inject",code:Nt()},{label:"streamlines trace",code:Lt},{label:"streamlines draw",code:Ot}]}async function En(i){for(const e of Tn()){const t=(await i.createShaderModule({code:e.code,label:e.label}).getCompilationInfo()).messages.find(a=>a.type==="error");if(t)return`${e.label} shader, line ${t.lineNum}: ${t.message}`}return null}const Un=document.getElementById("t2d-root"),Kt=ss(Un);function ge(i,e){Kt.render(Be("div",{className:"t2d-fatal",role:"alert","data-t2d-fatal":"1"},Be(es,null,Be("strong",null,i),Be("p",null,e))))}function J(i){const e=getComputedStyle(document.documentElement).getPropertyValue(i).trim(),s=document.createElement("canvas").getContext("2d");s.fillStyle=e||"black";const t=s.fillStyle;if(t.startsWith("#"))return[parseInt(t.slice(1,3),16)/255,parseInt(t.slice(3,5),16)/255,parseInt(t.slice(5,7),16)/255];const a=/rgba?\(([^)]+)\)/.exec(t),n=a?a[1].split(",").map(Number):[0,0,0];return[n[0]/255,n[1]/255,n[2]/255]}async function Dn(){let i;try{i=await Ht({timeoutMs:15e3})}catch(u){ge("The wind tunnel could not start",`${u instanceof Error?u.message:String(u)}. Open the tunnel from its project in Magnusim.`);return}if(!("gpu"in navigator)||!navigator.gpu){ge("This wind tunnel needs WebGPU","This browser does not offer WebGPU (navigator.gpu is missing), and the tunnel solves the flow on the GPU with it. Open Magnusim in a current Chrome or Edge on a computer with a GPU driver from the last few years.");return}const e=await navigator.gpu.requestAdapter({powerPreference:"high-performance"}).catch(()=>null);if(!e){ge("This wind tunnel needs WebGPU","The browser offers WebGPU but found no GPU it can use (requestAdapter gave none). Check that hardware acceleration is on in the browser’s settings and that the graphics driver is up to date.");return}let s;try{s=await e.requestDevice({requiredLimits:{maxStorageBufferBindingSize:e.limits.maxStorageBufferBindingSize,maxBufferSize:e.limits.maxBufferSize}})}catch(u){ge("The GPU could not be opened",String(u));return}const t=await En(s);if(t){ge("The wind tunnel’s GPU code did not compile on this GPU",`${t}. Please report this with the GPU’s name (${e.info?.vendor??""} ${e.info?.architecture??""}).`);return}const a=e.info,n=a?.description||[a?.vendor,a?.architecture].filter(Boolean).join(" ")||"GPU";s.lost.then(u=>{u.reason!=="destroyed"&&ge("The GPU stopped the wind tunnel",`${u.message||"The GPU device was lost"}. Leave the tunnel and open it again; the scene is saved.`)});const r=i.context.study,c=await Sn(i,r.id),o=new sn(c.scene),l=new An(i,o,r.id,c.etag);c.etag||await l.create(c.scene);const d={bg:J("--t2d-bg"),body:J("--t2d-body"),edge:J("--t2d-edge"),zone:[...J("--t2d-zone"),.14],plain:J("--t2d-plain"),arrow:[...J("--t2d-arrow"),.85]},h=document.createElement("canvas"),m=new tn(s,h,n,d);m.markerColors={tracerDark:[...J("--t2d-particle-dark"),.55],tracerLight:[...J("--t2d-particle-light"),.7],rakes:[1,2,3,4,5,6].map(u=>[...J(`--mg-series-${u}`),.95]),streamline:[...J("--t2d-streamline"),.75],streamlineLight:[...J("--t2d-particle-light"),.6]},o.onSceneChange=u=>{l.schedule(u),m.setScene(u)},await m.setScene(c.scene),m.start(),Rn({store:o,engine:m,device:s}),window.addEventListener("pagehide",()=>void l.flush()),Kt.render(Be(Pn,{ws:i,store:o,engine:m,units:i.context.units,problem:c.problem}))}Dn();
