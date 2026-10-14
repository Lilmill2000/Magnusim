import{connect as Ni}from"@magnusim/workspace";import{colormapRgb as Li,Icon as Ft,Select as he,Button as Re,Field as q,NumberUnitInput as je,Hint as H,Toggle as ut,fromSi as qi,DisabledReason as yn,ColorLegend as Gi,EmptyState as zi}from"@magnusim/plugin-ui";import{useSyncExternalStore as Is,useState as be,useRef as Qe,useEffect as fe,createElement as Bt}from"react";import{createRoot as Vi}from"react-dom/client";import{jsxs as D,jsx as v,Fragment as Vt}from"react/jsx-runtime";const Os={1:[.058,361.4],2:[.126,51.64],3:[.2025,15.957],4:[.29,6.643],5:[.391,3.23]},Ns={2:[.13,51.99,764e-6],3:[.217,15.793,.00677],4:[.318,6.52,.0303],5:[.441,3.191,.1355]},is=20,rs=250,Wi=81;class Xe extends Error{}const ji=/^\s*(?:naca\s*)?(\d{4,5})\s*$/i;function jn(s){const e=ji.exec(String(s??""));if(!e)throw new Xe("Enter a NACA 4-digit or 5-digit designation, such as 2412 or 23012.");const t=e[1];return t.length===4?Xi(t):Ki(t),t}const Le=(s,e)=>Number(s[e]);function Xi(s){const e=Le(s,0),t=Le(s,1);if(Number(s.slice(2))<=0)throw new Xe(`NACA ${s}: the thickness (last two digits) must be above 0.`);if(e===0!=(t===0))throw new Xe(`NACA ${s}: camber and its position must both be 0 or both be above 0.`)}function Ki(s){const e=Le(s,0),t=Le(s,1),n=Le(s,2);if(Number(s.slice(3))<=0)throw new Xe(`NACA ${s}: the thickness (last two digits) must be above 0.`);if(e===0)throw new Xe(`NACA ${s}: the first digit (design lift) must be above 0.`);if(n!==0&&n!==1)throw new Xe(`NACA ${s}: the third digit must be 0 (standard) or 1 (reflexed).`);const o=n?Ns:Os;if(!(t in o)){const r=Object.keys(o).sort().join(", ");throw new Xe(`NACA ${s}: a ${n?"reflexed":"standard"} 5-digit mean line has its second digit in ${r}.`)}}function Yi(s,e,t){const n=t?-.1036:-.1015;return 5*e*(.2969*Math.sqrt(s)-.126*s-.3516*s**2+.2843*s**3+n*s**4)}function Hi(s,e){const t=Le(s,0)/100,n=Le(s,1)/10;return t===0?[0,0]:e<n?[t/n**2*(2*n*e-e**2),2*t/n**2*(n-e)]:[t/(1-n)**2*(1-2*n+2*n*e-e**2),2*t/(1-n)**2*(n-e)]}function Qi(s,e){const t=Le(s,0),n=Le(s,1),i=Le(s,2),o=3*t/20/.3;if(!i){const[u,h]=Os[n];return e<u?[o*(h/6*(e**3-3*u*e**2+u**2*(3-u)*e)),o*(h/6*(3*e**2-6*u*e+u**2*(3-u)))]:[o*(h*u**3/6*(1-e)),o*(-h*u**3/6)]}const[r,a,c]=Ns[n],l=c*(1-r)**3;return e<r?[o*(a/6*((e-r)**3-l*e-r**3*e+r**3)),o*(a/6*(3*(e-r)**2-l-r**3))]:[o*(a/6*(c*(e-r)**3-l*e-r**3*e+r**3)),o*(a/6*(3*c*(e-r)**2-l-r**3))]}function os(s){const e=Math.round(s*1e10)/1e10;return e===0?0:e}function _n(s,e=Wi,t=!1){const n=jn(s),i=Math.trunc(e);if(!(i>=is&&i<=rs))throw new Xe(`Points per side must be from ${is} to ${rs}.`);const o=Number(n.slice(-2))/100,r=n.length===4?Hi:Qi,a=[],c=[];for(let u=0;u<i;u++){const h=Math.PI*u/(i-1),d=.5*(1-Math.cos(h)),f=Yi(d,o,t),[y,p]=r(n,d),m=Math.atan(p);a.push([d-f*Math.sin(m),y+f*Math.cos(m)]),c.push([d+f*Math.sin(m),y-f*Math.cos(m)])}const l=[...a.reverse(),...c.slice(1)];return{code:n,name:`NACA ${n}`,x:l.map(u=>os(u[0])),y:l.map(u=>os(u[1]))}}function Ls(s){let e=0;const t=s.length/2;for(let n=0;n<t;n++){const i=(n+1)%t;e+=s[2*n]*s[2*i+1]-s[2*i]*s[2*n+1]}return e/2}function ln(s){if(Ls(s)>=0)return s;const e=[];for(let t=s.length/2-1;t>=0;t--)e.push(s[2*t],s[2*t+1]);return e}function Zi(s){let e=1/0,t=1/0,n=-1/0,i=-1/0;for(let o=0;o<s.length;o+=2)e=Math.min(e,s[o]),n=Math.max(n,s[o]),t=Math.min(t,s[o+1]),i=Math.max(i,s[o+1]);return{x0:e,y0:t,x1:n,y1:i}}function Ji(s){let e=0;for(let t=0;t<s.length;t+=2)e=Math.max(e,Math.hypot(s[t],s[t+1]));return e}function Zt(s,e,t=1){const n=Math.cos(e.theta),i=Math.sin(e.theta),o=new Array(s.length);for(let r=0;r<s.length;r+=2){const a=s[r]*t,c=s[r+1]*t;o[r]=e.x+n*a-i*c,o[r+1]=e.y+i*a+n*c}return o}function qs(s,e,t){let n=!1;const i=s.length/2;for(let o=0,r=i-1;o<i;r=o++){const a=s[2*o],c=s[2*o+1],l=s[2*r],u=s[2*r+1];c>t!=u>t&&e<(l-a)*(t-c)/(u-c)+a&&(n=!n)}return n}function er(s,e,t,n,i,o){const r=i-t,a=o-n,c=r*r+a*a;let l=c>0?((s-t)*r+(e-n)*a)/c:0;return l=Math.max(0,Math.min(1,l)),Math.hypot(s-(t+l*r),e-(n+l*a))}function tr(s,e,t){let n=1/0;const i=s.length/2;for(let o=0;o<i;o++){const r=(o+1)%i;n=Math.min(n,er(e,t,s[2*o],s[2*o+1],s[2*r],s[2*r+1]))}return qs(s,e,t)?-n:n}function nr(s){const e=s.length/2,t=(n,i,o,r,a,c)=>(o-n)*(c-i)-(r-i)*(a-n);for(let n=0;n<e;n++){const i=(n+1)%e;for(let o=n+1;o<e;o++){const r=(o+1)%e;if(o===i||r===n)continue;const[a,c,l,u]=[s[2*n],s[2*n+1],s[2*i],s[2*i+1]],[h,d,f,y]=[s[2*o],s[2*o+1],s[2*r],s[2*r+1]],p=t(a,c,l,u,h,d),m=t(a,c,l,u,f,y),g=t(h,d,f,y,a,c),x=t(h,d,f,y,l,u);if(p*m<0&&g*x<0)return!0}}return!1}function tn(s,e,t){let n=!1;for(const i of s)qs(i,e,t)&&(n=!n);return n}function gn(s,e,t){let n=1/0;for(const i of s)n=Math.min(n,Math.abs(tr(i,e,t)));return tn(s,e,t)?-n:n}function cn(s,e,t=1){return s.map(n=>Zt(n,e,t))}function Un(s){return s.reduce((e,t)=>Math.max(e,Ji(t)),0)}function un(s){const e={x0:1/0,y0:1/0,x1:-1/0,y1:-1/0};for(const t of s){const n=Zi(t);e.x0=Math.min(e.x0,n.x0),e.y0=Math.min(e.y0,n.y0),e.x1=Math.max(e.x1,n.x1),e.y1=Math.max(e.y1,n.y1)}return e}const sr="origin",It=Math.PI*2,de=(s,e)=>[s[0]+e[0],s[1]+e[1]],N=(s,e)=>[s[0]-e[0],s[1]-e[1]],Y=(s,e)=>[s[0]*e,s[1]*e],Ye=(s,e)=>s[0]*e[0]+s[1]*e[1],$t=(s,e)=>s[0]*e[1]-s[1]*e[0],nn=s=>Math.hypot(s[0],s[1]),X=(s,e)=>Math.hypot(e[0]-s[0],e[1]-s[1]),Gs=(s,e,t)=>[s[0]+(e[0]-s[0])*t,s[1]+(e[1]-s[1])*t],zs=s=>[-s[1],s[0]];function Ke(s){const e=nn(s);return e>0?[s[0]/e,s[1]/e]:[0,0]}const ie=(s,e,t)=>[s[0]+e*Math.cos(t),s[1]+e*Math.sin(t)],mt=(s,e)=>Math.atan2(e[1]-s[1],e[0]-s[0]);function Xn(s){const e=s%It;return e<0?e+It:e}function Tt(s){let e=Xn(s);return e>Math.PI&&(e-=It),e}function ir(s,e){const t=Xn(e-s);return t===0?It:t}function rr(s,e,t){const n=N(t,e),i=Ye(n,n);if(i===0)return{p:e,t:0};const o=Math.max(0,Math.min(1,Ye(N(s,e),n)/i));return{p:Gs(e,t,o),t:o}}function Ot(s,e,t){const n=N(t,e),i=Ye(n,n);if(i===0)return{p:e,t:0};const o=Ye(N(s,e),n)/i;return{p:Gs(e,t,o),t:o}}function or(s,e,t=1e-9){const n=Xn(e-s.a0);return n<=s.sweep+t||n>=It-t}function ar(s,e,t){const n=N(s,e),i=nn(n);return i===0?[e[0]+t,e[1]]:de(e,Y(n,t/i))}function lr(s,e){const t=mt(e.c,s);if(or(e,t))return ie(e.c,e.r,t);const n=ie(e.c,e.r,e.a0),i=ie(e.c,e.r,e.a0+e.sweep);return X(s,n)<=X(s,i)?n:i}function Vs(s,e,t,n){const i=N(e,s),o=N(n,t),r=$t(i,o),a=nn(i)*nn(o);if(a===0||Math.abs(r)<1e-12*a)return null;const c=N(t,s),l=$t(c,o)/r,u=$t(c,i)/r;return{p:de(s,Y(i,l)),t:l,s:u}}function cr(s,e,t){const n=s[0],i=s[1],o=e[0],r=e[1],a=t[0],c=t[1],l=2*(n*(r-c)+o*(c-i)+a*(i-r)),u=Math.max(X(s,e),X(e,t),X(s,t));if(u===0||Math.abs(l)<1e-9*u*u)return null;const h=n*n+i*i,d=o*o+r*r,f=a*a+c*c,y=(h*(r-c)+d*(c-i)+f*(i-r))/l,p=(h*(a-o)+d*(n-a)+f*(o-n))/l,m=[y,p],g=$t(N(e,s),N(t,e))>0;return{c:m,r:X(m,s),ccw:g}}function ur(s){const e=[];return s.knots.forEach((t,n)=>{for(let i=0;i<s.mults[n];i++)e.push(t)}),e}function Ws(s){const e=[],t=[];for(const n of s)e.length&&Math.abs(n-e[e.length-1])<1e-14?t[t.length-1]++:(e.push(n),t.push(1));return{knots:e,mults:t}}function Kn(s,e,t,n){if(t>=n[s+1])return s;if(t<=n[e])return e;let i=e,o=s+1,r=i+o>>1;for(;t<n[r]||t>=n[r+1];)t<n[r]?o=r:i=r,r=i+o>>1;return r}function Yn(s,e,t,n,i){const o=Array.from({length:t+1},()=>new Array(t+1).fill(0)),r=new Array(t+1).fill(0),a=new Array(t+1).fill(0);o[0][0]=1;for(let h=1;h<=t;h++){r[h]=e-i[s+1-h],a[h]=i[s+h]-e;let d=0;for(let f=0;f<h;f++){o[h][f]=a[f+1]+r[h-f];const y=o[f][h-1]/o[h][f];o[f][h]=d+a[f+1]*y,d=r[h-f]*y}o[h][h]=d}const c=Array.from({length:n+1},()=>new Array(t+1).fill(0));for(let h=0;h<=t;h++)c[0][h]=o[h][t];const l=[new Array(t+1).fill(0),new Array(t+1).fill(0)];for(let h=0;h<=t;h++){let d=0,f=1;l[0][0]=1;for(let y=1;y<=n;y++){let p=0;const m=h-y,g=t-y;h>=y&&(l[f][0]=l[d][0]/o[g+1][m],p=l[f][0]*o[m][g]);const x=m>=-1?1:-m,w=h-1<=g?y-1:t-h;for(let S=x;S<=w;S++)l[f][S]=(l[d][S]-l[d][S-1])/o[g+1][m+S],p+=l[f][S]*o[m+S][g];h<=g&&(l[f][y]=-l[d][y-1]/o[g+1][h],p+=l[f][y]*o[h][g]),c[y][h]=p;const k=d;d=f,f=k}}let u=t;for(let h=1;h<=n;h++){for(let d=0;d<=t;d++)c[h][d]*=u;u*=t-h}return c}function Hn(s){return[s.knots[0],s.knots[s.knots.length-1]]}function js(s,e,t=1){const n=ur(s),i=s.poles.length-1,o=s.degree,[r,a]=Hn(s),c=Math.min(a,Math.max(r,e)),l=Kn(i,o,c,n),u=Yn(l,c,o,Math.min(t,o),n),h=[];for(let d=0;d<=t;d++){if(d>o){h.push([0,0]);continue}let f=0,y=0;for(let p=0;p<=o;p++){const m=s.poles[l-o+p];f+=u[d][p]*m[0],y+=u[d][p]*m[1]}h.push([f,y])}return h}function Dn(s,e){return js(s,e,0)[0]}function dr(s,e){const t=s.length,n=s.map((i,o)=>[...i,e[o][0],e[o][1]]);for(let i=0;i<t;i++){let o=i;for(let r=i+1;r<t;r++)Math.abs(n[r][i])>Math.abs(n[o][i])&&(o=r);if(Math.abs(n[o][i])<1e-14)throw new Error("the spline points do not give a curve (two points in one place?)");[n[i],n[o]]=[n[o],n[i]];for(let r=0;r<t;r++){if(r===i)continue;const a=n[r][i]/n[i][i];if(a)for(let c=i;c<=t+1;c++)n[r][c]-=a*n[i][c]}}return n.map((i,o)=>[i[t]/n[o][o],i[t+1]/n[o][o]])}function Xs(s,e,t){const n=s.length-e-1;if(t.length!==n)throw new Error("spline interpolation: rows and poles differ");const i=n-1,o=(a,c,l,u)=>{const h=Kn(i,e,a,s),d=Yn(h,a,e,c,s);for(let f=0;f<=e;f++)u[h-e+f]+=l*d[c][f]},r=t.map(a=>{const c=new Array(n).fill(0);return o(a.u,a.order,1,c),a.minus&&o(a.minus.u,a.minus.order,-1,c),c});return dr(r,t.map(a=>a.rhs))}function hr(s,e=!1,t){const n=e?[...s,s[0]]:[...s],i=[0],o=n.length-1;for(let a=1;a<n.length;a++){let c=Math.hypot(n[a][0]-n[a-1][0],n[a][1]-n[a-1][1]);t&&!e&&(a===1&&(c*=t[0]),a===o&&o>1&&(c*=t[1])),i.push(i[a-1]+c)}const r=i[i.length-1];if(!(r>0))throw new Error("the spline points are all in one place");return i.map(a=>a/r)}function fr(s,e={}){const t=!!e.closed&&s.length>=3;if(s.length<2)throw new Error("a spline needs two points or more");const n=t?[...s,s[0]]:[...s],i=e.params??hr(s,t,e.spans);for(let d=1;d<i.length;d++)if(!(i[d]-i[d-1]>1e-12))throw new Error("two spline points in one place");const o=3,a=[0,0,0,0,...i.slice(1,-1),1,1,1,1],c=n.map((d,f)=>({u:i[f],order:0,rhs:d})),l=i[1]-i[0],u=i[i.length-1]-i[i.length-2];if(t)c.push({u:0,order:1,rhs:[0,0],minus:{u:1,order:1}}),c.push({u:0,order:2,rhs:[0,0],minus:{u:1,order:2}});else{const[d,f]=e.handles??[null,null];c.push(d?{u:0,order:1,rhs:[3*(d[0]-n[0][0])/l,3*(d[1]-n[0][1])/l]}:{u:0,order:2,rhs:[0,0]});const y=n[n.length-1];c.push(f?{u:1,order:1,rhs:[3*(y[0]-f[0])/u,3*(y[1]-f[1])/u]}:{u:1,order:2,rhs:[0,0]})}const h=Xs(a,o,c);return h[0]=[n[0][0],n[0][1]],h[h.length-1]=t?[n[0][0],n[0][1]]:[n[n.length-1][0],n[n.length-1][1]],{degree:o,poles:h,...Ws(a)}}function pr(s,e){const t=s.length;if(t<e+1)throw new Error(`a degree ${e} spline needs ${e+1} control points or more`);const n=t-e,i=Array.from({length:n+1},(r,a)=>a/n),o=i.map((r,a)=>a===0||a===n?e+1:1);return{degree:e,poles:s.map(r=>[r[0],r[1]]),knots:i,mults:o}}function mr(s,e){const t=s.length;if(t<e+1)throw new Error(`a closed degree ${e} spline needs ${e+1} control points or more`);const n=[...s,...s.slice(0,e)].map(h=>[h[0],h[1]]),i=Array.from({length:n.length+e+1},(h,d)=>d),o=(h,d)=>{const f=Kn(n.length-1,e,h,i),y=Yn(f,h,e,d,i);let p=0,m=0;for(let g=0;g<=e;g++)p+=y[d][g]*n[f-e+g][0],m+=y[d][g]*n[f-e+g][1];return[p,m]},r=Array.from({length:t-1},(h,d)=>(d+1)/t),a=[...new Array(e+1).fill(0),...r,...new Array(e+1).fill(1)],c=a.length-e-1,l=[];for(let h=0;h<c;h++){let d=0;for(let f=1;f<=e;f++)d+=a[h+f];d/=e,l.push({u:d,order:0,rhs:o(e+d*t,0)})}const u=Xs(a,e,l);return u[u.length-1]=[u[0][0],u[0][1]],{degree:e,poles:u,...Ws(a)}}function yr(s){if(s.form==="fit")return fr(s.pts,{closed:s.closed,handles:s.handles,spans:s.spans});if(s.knots&&s.mults){if(s.mults.reduce((t,n)=>t+n,0)!==s.pts.length+s.degree+1)throw new Error("the spline knots do not fit its control points");return{degree:s.degree,poles:s.pts.map(t=>[t[0],t[1]]),knots:[...s.knots],mults:[...s.mults]}}return s.closed?mr(s.pts,s.degree):pr(s.pts,s.degree)}function Ks(s,e=16){const t=[];for(let i=0;i<s.knots.length-1;i++){const o=s.knots[i],r=s.knots[i+1];for(let a=0;a<e;a++){const c=o+(r-o)*a/e;t.push({u:c,p:Dn(s,c)})}}const[,n]=Hn(s);return t.push({u:n,p:Dn(s,n)}),t}function gr(s,e=16){return Ks(s,e).map(t=>t.p)}function xr(s,e){const t=Ks(s,24);let n=0,i=1/0;t.forEach((u,h)=>{const d=Math.hypot(u.p[0]-e[0],u.p[1]-e[1]);d<i&&(i=d,n=h)});const[o,r]=Hn(s);let a=t[n].u;for(let u=0;u<20;u++){const[h,d,f]=js(s,a,2),y=[h[0]-e[0],h[1]-e[1]],p=y[0]*d[0]+y[1]*d[1],m=d[0]*d[0]+d[1]*d[1]+y[0]*f[0]+y[1]*f[1];if(!(Math.abs(m)>1e-300))break;const g=Math.min(r,Math.max(o,a-p/m));if(Math.abs(g-a)<1e-14){a=g;break}a=g}const c=Dn(s,a),l=Math.hypot(c[0]-e[0],c[1]-e[1]);return l<=i?{u:a,p:c,d:l}:{u:t[n].u,p:t[n].p,d:i}}const xn=(s,e)=>e==="origin"?[0,0]:s.points[e]??null;function br(s){const e=[...s.pts];for(const t of s.handles??[])t&&!e.includes(t)&&e.push(t);return e}function Ys(s,e){const t=[];for(const i of e.pts){const o=xn(s,i);if(!o)return null;t.push(o)}const n=[e.handles?.[0]?xn(s,e.handles[0]):null,e.handles?.[1]?xn(s,e.handles[1]):null];try{return yr({form:e.form,degree:e.degree,pts:t,closed:e.closed,handles:n,knots:e.knots,mults:e.mults,spans:e.spans})}catch{return null}}function Hs(s,e,t=48){const n=Ys(s,e);if(!n)return[];const i=n.knots.length-1;return gr(n,Math.max(4,Math.ceil(t/Math.max(1,i))))}function vr(s,e,t){const n=Ys(s,e);return n?xr(n,t).d:1/0}function ae(s){const e=new Uint8Array(8);if(typeof crypto<"u"&&typeof crypto.getRandomValues=="function")crypto.getRandomValues(e);else for(let n=0;n<e.length;n++)e[n]=Math.floor(Math.random()*256);let t=0n;for(const n of e)t=t<<8n|BigInt(n);return`${s}_${(t&(1n<<60n)-1n).toString(36).padStart(12,"0")}`}const wr=(s,e)=>`${s.id}:${e}`;function kr(s,e){return[e[0]-(s.base?.[0]??0),e[1]-(s.base?.[1]??0)]}function et(s,e,t){const n=t[wr(s,e)];if(typeof n=="number"&&Number.isFinite(n))return n;const i=/^\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*(mm|deg|°)?\s*$/i.exec(s.exprs[e]??"");return i?Number(i[1]):null}function Mr(s,e){const t=s.count[0];if(t<2)return null;if(s.full)return 360/t;const n=et(s,"angle",e);return n==null?null:n/(t-1)}function Pr(s,e,t){const n=et(s,"spacing1",t),i=et(s,"angle1",t);if(n==null||i==null)return null;let o=e[0]*n*Math.cos(i*Math.PI/180),r=e[0]*n*Math.sin(i*Math.PI/180);if(e[1]){const a=et(s,"spacing2",t),c=et(s,"angle2",t);if(a==null||c==null)return null;o+=e[1]*a*Math.cos(c*Math.PI/180),r+=e[1]*a*Math.sin(c*Math.PI/180)}return[o,r]}function Sr(s,e){const t=[],n=new Map(s.entities.map(o=>[o.id,o])),i=o=>o==="origin"||!!s.points[o];for(const o of s.ties??[]){let r=0;const a=()=>`${o.id}#${r++}`;if(o.kind==="offset"){Ar(s.points,o,n,e,i,t,a);continue}for(const c of o.copies){const l=kr(o,c.at),u=Object.entries(c.points).filter(([h,d])=>i(h)&&i(d)&&h!==d);if(o.kind==="linear"){const h=(o.along??[null,null]).map(f=>f&&n.get(f)?.kind==="line"?f:null);if(h[0]&&l[0]||h[1]&&l[1]){const f=[0,0],y=[],p=[];let m=!0;if([0,1].forEach(g=>{if(!l[g])return;const x=et(o,g===0?"spacing1":"spacing2",e);if(x==null){m=!1;return}const w=h[g];if(w)y.push(w),p.push(l[g]*x);else{const k=et(o,g===0?"angle1":"angle2",e);if(k==null){m=!1;return}f[0]+=l[g]*x*Math.cos(k*Math.PI/180),f[1]+=l[g]*x*Math.sin(k*Math.PI/180)}}),!m)continue;for(const[g,x]of u)t.push({id:a(),kind:"pattern_along",refs:[g,x,...y],value:[f[0],f[1],...p]})}else{const f=Pr(o,l,e);if(!f)continue;for(const[y,p]of u)t.push({id:a(),kind:"pattern_shift",refs:[y,p],value:f})}}else{const h=Mr(o,e);if(h==null||!o.centre||!i(o.centre))continue;for(const[d,f]of u)t.push({id:a(),kind:"pattern_rotate",refs:[o.centre,d,f],value:l[0]*h})}for(const[h,d]of Object.entries(c.entities))n.get(h)?.kind==="circle"&&n.get(d)?.kind==="circle"&&t.push({id:a(),kind:"equal",refs:[h,d]})}}return t}function Ar(s,e,t,n,i,o,r){const a=et(e,"distance",n);if(a==null)return;const c=e.sources.map(m=>t.get(m)),l=c.length,u=m=>{const g=c[(m-1+l)%l],x=c[m];if(!g||!x||l<2||m===0&&!h)return null;const w=rt(g).find(A=>rt(x).includes(A));if(!w)return null;const k=as(s,g,w),S=as(s,x,w),b=!!k&&!!S&&Math.abs(k[0]*S[1]-k[1]*S[0])<=1e-9,M=g.kind==="line"&&x.kind==="line"||g.kind==="arc"&&x.kind==="arc"&&g.c===x.c;return{point:w,smooth:b,square:M}};let h=!1;l>2&&c[0]&&c[l-1]&&(h=rt(c[l-1]).some(m=>rt(c[0]).includes(m))),l===2&&c[0]&&c[1]&&(h=rt(c[0]).length===2&&rt(c[0]).every(m=>rt(c[1]).includes(m)));const d=c.map((m,g)=>u(g)),f=h&&d.every(m=>m?.smooth),y=h&&!f?Math.max(0,d.findIndex(m=>m&&!m.smooth)):0;let p=-1;for(let m=0;m<l;m++)c[(y+m)%l]?.kind==="line"&&(p=(y+m)%l);for(const m of e.copies){const g=new Map;for(const x of c){const w=x?.kind==="line"?x.p:x?.kind==="arc"?[x.a,x.b]:x?.kind==="spline"&&!x.closed?[x.pts[0],x.pts[x.pts.length-1]]:[];for(const k of w)g.set(k,(g.get(k)??0)+1)}for(let x=0;x<l;x++){const w=(y+x)%l,k=c[w],S=t.get(m.entities[e.sources[w]]??"");if(!k||!S)continue;const b=d[w],M=x===0||!b||!b.smooth;if(b?.smooth&&(b.square||!(f&&p<0&&x===0))){const A=c[(w-1+l)%l],B=t.get(m.entities[A.id]??""),R=m.points[b.point];B&&R&&i(R)&&(b.square?o.push({id:r(),kind:"offset_end",refs:[b.point,R,A.id]}):o.push({id:r(),kind:"tangent",refs:[B.id,S.id]}))}if(k.kind==="line"&&S.kind==="line"){f&&w===p||o.push({id:r(),kind:"parallel",refs:[S.id,k.id]}),M&&o.push({id:r(),kind:"distance",refs:[S.p[0],k.id],value:a});for(const A of k.p){const B=m.points[A];B&&g.get(A)===1&&i(B)&&o.push({id:r(),kind:"offset_end",refs:[A,B,k.id]})}}else if(k.kind==="arc"&&S.kind==="arc"){M&&o.push({id:r(),kind:"distance",refs:[S.a,k.id],value:a});for(const A of[k.a,k.b]){const B=m.points[A];B&&g.get(A)===1&&i(B)&&o.push({id:r(),kind:"offset_end",refs:[A,B,k.id]})}}else k.kind==="circle"&&S.kind==="circle"&&o.push({id:r(),kind:"distance",refs:[S.id,k.id],value:a})}}}const rt=s=>s.kind==="line"?[s.p[0],s.p[1]]:s.kind==="arc"?[s.a,s.b]:[];function as(s,e,t){const n=i=>i==="origin"?[0,0]:s[i]??null;if(e.kind==="line"){const i=n(e.p[0]),o=n(e.p[1]);if(!i||!o)return null;const r=Math.hypot(o[0]-i[0],o[1]-i[1]);return r>0?[(o[0]-i[0])/r,(o[1]-i[1])/r]:null}if(e.kind==="arc"){const i=n(e.c),o=n(t);if(!i||!o)return null;const r=Math.hypot(o[0]-i[0],o[1]-i[1]);return r>0?[-(o[1]-i[1])/r,(o[0]-i[0])/r]:null}return null}const xt=sr,Qs="#origin",Br=["distance","distance_x","distance_y","radius","diameter","angle"];function Ve(s){return Br.includes(s.kind)}function ve(s,e){return e===xt?[0,0]:s.points[e]??null}function st(s,e){return s.entities.find(t=>t.id===e)??null}function Fn(s){switch(s.kind){case"point":return[s.p];case"line":return[s.p[0],s.p[1]];case"circle":return[s.c];case"arc":return[s.c,s.a,s.b];case"spline":return br(s)}}function dn(s,e){if(e===xt||s.points[e])return"point";const t=st(s,e);return t?t.kind==="point"?"point":t.kind:null}function tt(s,e){if(e===xt||s.points[e])return e;const t=st(s,e);return t?.kind==="point"?t.p:null}function Nt(s,e){const t=ve(s,e.c),n=ve(s,e.a),i=ve(s,e.b);if(!t||!n||!i)return null;const o=X(t,n),r=e.ccw!==!1,a=mt(t,r?n:i),c=mt(t,r?i:n);return{c:t,r:o,a0:a,sweep:ir(a,c)}}function Rr(s,e,t){switch(e.kind){case"point":{const n=ve(s,e.p);return n?X(t,n):1/0}case"line":{const n=ve(s,e.p[0]),i=ve(s,e.p[1]);return n&&i?X(t,rr(t,n,i).p):1/0}case"circle":{const n=ve(s,e.c);return n?X(t,ar(t,n,e.r)):1/0}case"arc":{const n=Nt(s,e);return n?X(t,lr(t,n)):1/0}case"spline":return vr(s,e,t)}}function V(s,e){const t=st(s,e);if(t?.kind!=="line")return null;const n=ve(s,t.p[0]),i=ve(s,t.p[1]);return n&&i?[n,i]:null}function pt(s,e){const t=st(s,e);return t?.kind==="circle"||t?.kind==="arc"?t.c:null}function Lt(s,e){const t=st(s,e);return t?.kind==="circle"?t.r:t?.kind==="arc"?Nt(s,t)?.r??null:null}function We(s,e){const t=e.refs.map(i=>dn(s,i)),n=i=>{const o=tt(s,i);return o?ve(s,o):null};switch(e.kind){case"distance":{if(t.length===1&&t[0]==="line"){const i=V(s,e.refs[0]);return i?X(i[0],i[1]):null}if(t[0]==="point"&&t[1]==="point"){const i=n(e.refs[0]),o=n(e.refs[1]);return i&&o?X(i,o):null}if(t[0]==="point"&&t[1]==="line"||t[0]==="line"&&t[1]==="point"){const i=n(t[0]==="point"?e.refs[0]:e.refs[1]),o=V(s,t[0]==="line"?e.refs[0]:e.refs[1]);return i&&o?Math.abs(ls(i,o[0],o[1])):null}if(t[0]==="line"&&t[1]==="line"){const i=V(s,e.refs[0]),o=V(s,e.refs[1]);return i&&o?Math.abs(ls(i[0],o[0],o[1])):null}return null}case"distance_x":case"distance_y":{const i=e.kind==="distance_x"?0:1;if(t.length===1&&t[0]==="line"){const o=V(s,e.refs[0]);return o?o[1][i]-o[0][i]:null}if(t.length===1&&t[0]==="point"){const o=n(e.refs[0]);return o?o[i]:null}if(t[0]==="point"&&t[1]==="point"){const o=n(e.refs[0]),r=n(e.refs[1]);return o&&r?r[i]-o[i]:null}return null}case"radius":case"diameter":{const i=Lt(s,e.refs[0]);return i==null?null:e.kind==="radius"?i:2*i}case"angle":{if(t.length===2&&t[0]==="line"&&t[1]==="line"){const i=V(s,e.refs[0]),o=V(s,e.refs[1]);if(!i||!o)return null;const r=N(i[1],i[0]),a=N(o[1],o[0]);return Tt(Math.atan2(a[1],a[0])-Math.atan2(r[1],r[0]))*180/Math.PI}if(t.length===1&&t[0]==="line"){const i=V(s,e.refs[0]);if(!i)return null;const o=N(i[1],i[0]);return Math.atan2(o[1],o[0])*180/Math.PI}return null}}}function ls(s,e,t){const n=Ke(N(t,e));return $t(n,N(s,e))}function Cr(s){if(s===Qs||s.startsWith("#"))return null;const e=s.indexOf("#");return e>0?s.slice(0,e):s}function cs(s){const e=[];for(const t of s){const n=Cr(t);n&&!e.includes(n)&&e.push(n)}return e}function Zs(s,e={}){const t={[xt]:[0,0]};for(const[r,a]of Object.entries(s.points))t[r]=[a[0],a[1]];const n=s.entities.map(r=>{const a={id:r.id,...r.construction?{construction:!0}:{}};switch(r.kind){case"point":return{...a,kind:"point",p:r.p};case"line":return{...a,kind:"line",p:[r.p[0],r.p[1]]};case"circle":return{...a,kind:"circle",c:r.c,r:r.r};case"arc":return{...a,kind:"arc",c:r.c,a:r.a,b:r.b,...r.ccw===!1?{ccw:!1}:{}};case"spline":return{...a,kind:"spline",form:r.form,pts:[...r.pts],degree:r.degree,...r.closed?{closed:!0}:{},...r.handles?{handles:[r.handles[0],r.handles[1]]}:{},...r.knots&&r.mults?{knots:[...r.knots],mults:[...r.mults]}:{},...r.spans?{spans:[r.spans[0],r.spans[1]]}:{}}}}),i=[{id:Qs,kind:"fix",refs:[xt],value:[0,0]}];for(const r of s.constraints){if(Ve(r)){const a=e[r.id]??We(s,r);if(a==null||!Number.isFinite(a))continue;i.push({id:r.id,kind:r.kind,refs:[...r.refs],value:a,...r.driving?{}:{driving:!1}});continue}if(r.kind==="collinear"){const a=st(s,r.refs[1]);if(a?.kind!=="line")continue;i.push({id:`${r.id}#a`,kind:"point_on_line",refs:[a.p[0],r.refs[0]]},{id:`${r.id}#b`,kind:"point_on_line",refs:[a.p[1],r.refs[0]]});continue}if(r.kind==="fix"){i.push({id:r.id,kind:"fix",refs:[...r.refs],...r.value?{value:[r.value[0],r.value[1]]}:{}});continue}i.push({id:r.id,kind:r.kind,refs:[...r.refs]})}const o=new Set;for(const r of s.entities)if(r.link){for(const a of Fn(r))o.has(a)||!t[a]||(o.add(a),i.push({id:`#ln:${a}`,kind:"fix",refs:[a],value:[t[a][0],t[a][1]]}));r.kind==="circle"&&i.push({id:`#lr:${r.id}`,kind:"radius",refs:[r.id],value:r.r})}return i.push(...Sr(s,e)),{points:t,entities:n,constraints:i}}function bn(s,e){const t={};for(const i of Object.keys(s.points)){const o=e.points[i];t[i]=o?[o[0],o[1]]:s.points[i]}const n=s.entities.map(i=>i.kind==="circle"&&e.radii[i.id]!=null&&e.radii[i.id]!==i.r?{...i,r:e.radii[i.id]}:i);return{...s,points:t,entities:n}}const $r={coincident:"Coincident",horizontal:"Horizontal",vertical:"Vertical",parallel:"Parallel",perpendicular:"Perpendicular",tangent:"Tangent",equal:"Equal",midpoint:"Midpoint",symmetric:"Symmetric",point_on_line:"On line",point_on_circle:"On curve",concentric:"Concentric",collinear:"Collinear",fix:"Fix"};function us(s,e){if(!s&&!e)return{state:"unsolved",dof:0,conflicting:[],redundant:[]};const t=cs([...e?.conflicting??[],...s?.conflicting??[]]),n=cs([...e?.redundant??[],...s?.redundant??[]]).filter(o=>!t.includes(o)),i=Math.max(0,e?.dof??s?.dof??0);return t.length||n.length?{state:"over",dof:i,conflicting:t,redundant:n}:s&&!s.solved?{state:"unsolved",dof:i,conflicting:t,redundant:n}:{state:i>0?"under":"fully",dof:i,conflicting:t,redundant:n}}function Tr(s,e=!1){if(!s)return"";switch(s.state){case"under":return`Under defined · ${s.dof} DOF`;case"fully":return e?"No geometry yet":"Fully defined";case"over":return s.conflicting.length?`Over defined · ${s.conflicting.length} conflicting`:`Over defined · ${s.redundant.length} redundant`;case"unsolved":return"Not solved: the constraints cannot all hold"}}function Er(s,e,t,n){return n.has(s)?"over":s===xt?"fully":(e==="entity"?t?.perEntity[s]:t?.perPoint[s])??"under"}function _r(s,e){const t=new Set,n=new Set(e);for(const i of s.constraints)if(n.has(i.id))for(const o of i.refs){t.add(o);const r=s.entities.find(a=>a.id===o);r?.kind==="line"&&r.p.forEach(a=>t.add(a))}return t}const Ur=Math.PI/180;function ds(s,e,t){if(!t)return"distance";const n=Math.min(s[0],e[0]),i=Math.max(s[0],e[0]),o=Math.min(s[1],e[1]),r=Math.max(s[1],e[1]),a=Math.max(i-n,r-o,1e-12),c=i-n<1e-9*a,l=r-o<1e-9*a;return(t[1]>r||t[1]<o)&&t[0]>=n&&t[0]<=i&&!c?l?"distance":"distance_x":(t[0]>i||t[0]<n)&&t[1]>=o&&t[1]<=r&&!l?c?"distance":"distance_y":"distance"}function Dr(s,e,t){const n=e.map(h=>dn(s,h));if(e.length===0)return{reason:"Pick a line, a circle, an arc or two points"};if(n.some(h=>h===null))return{reason:"That is not in the sketch"};if(n.includes("spline"))return{reason:"A spline takes dimensions on its points: pick its points (or a point and a line)"};const i=h=>ve(s,tt(s,h)),o=(h,d)=>{const f=i(h),y=i(d);if(X(f,y)<1e-9)return{reason:"Those two points are at the same place"};let p=ds(f,y,t),m=[tt(s,h),tt(s,d)];if(p!=="distance"){const x=p==="distance_x"?0:1;Math.abs(y[x]-f[x])<1e-9?p="distance":y[x]<f[x]&&(m=[m[1],m[0]])}const g=We(s,{kind:p,refs:m});return{kind:p,refs:m,value:Math.abs(g)}};if(e.length===1){const[h]=n;if(h==="line"){const d=V(s,e[0]),f=st(s,e[0]);return f?.kind==="line"&&t&&ds(d[0],d[1],t)!=="distance"?o(f.p[0],f.p[1]):{kind:"distance",refs:[e[0]],value:X(d[0],d[1])}}return h==="circle"?{kind:"diameter",refs:[e[0]],value:2*Lt(s,e[0])}:h==="arc"?{kind:"radius",refs:[e[0]],value:Lt(s,e[0])}:{reason:"Pick a second point, a line or a circle"}}if(e.length>2)return{reason:"Smart Dimension takes one or two picks"};const[r,a]=e,[c,l]=n,u=h=>h==="circle"||h==="arc";if(c==="point"&&l==="point")return o(r,a);if(c==="point"&&l==="line"||c==="line"&&l==="point"){const h=c==="point"?r:a,d=c==="line"?r:a,f=[tt(s,h),d],y=We(s,{kind:"distance",refs:f});return!y||y<1e-9?{reason:"That point lies on the line: dimension it some other way"}:{kind:"distance",refs:f,value:y}}if(c==="line"&&l==="line"){const h=V(s,r),d=V(s,a),f=N(h[1],h[0]),y=N(d[1],d[0]);if(Math.abs(f[0]*y[1]-f[1]*y[0])/(Math.hypot(...f)*Math.hypot(...y))<Math.sin(.01*Ur)){const g=We(s,{kind:"distance",refs:[r,a]});return!g||g<1e-9?{reason:"Those lines lie on one line"}:{kind:"distance",refs:[r,a],value:g}}const m=We(s,{kind:"angle",refs:[r,a]});return m>=0?{kind:"angle",refs:[r,a],value:m}:{kind:"angle",refs:[a,r],value:-m}}if(c==="point"&&u(l)||u(c)&&l==="point"){const h=c==="point"?r:a,d=pt(s,c==="point"?a:r);return o(h,d)}if(u(c)&&u(l))return o(pt(s,r),pt(s,a));if(c==="line"&&u(l)||u(c)&&l==="line"){const f=[pt(s,u(c)?r:a),c==="line"?r:a],y=We(s,{kind:"distance",refs:f});return!y||y<1e-9?{reason:"That centre lies on the line"}:{kind:"distance",refs:f,value:y}}return{reason:"Pick a line, a circle, an arc or two points"}}function vn(s,e,t,n){const i=3*t,o=6*t,r=e.refs.map(l=>dn(s,l)),a=l=>{const u=tt(s,l);return u?ve(s,u):null},c=e.at??Lr(s,e,t);if(!c)return null;switch(e.kind){case"distance":{if(r.length===1&&r[0]==="line"){const l=V(s,e.refs[0]);return l?In(l[0],l[1],c,i,o):null}if(r[0]==="point"&&r[1]==="point"){const l=a(e.refs[0]),u=a(e.refs[1]);return l&&u?In(l,u,c,i,o):null}if(r.includes("line")&&r.includes("point")){const l=a(e.refs[r.indexOf("point")]),u=V(s,e.refs[r.indexOf("line")]);return l&&u?Ir(l,u,c,i,o):null}if(r[0]==="line"&&r[1]==="line"){const l=V(s,e.refs[0]),u=V(s,e.refs[1]);if(!l||!u)return null;const h=Ot(c,l[0],l[1]).p,d=Ot(c,u[0],u[1]).p;return{lines:[[h,d]],arrows:Qn(h,d),text:c}}return null}case"distance_x":case"distance_y":{const l=e.kind==="distance_x"?0:1;let u,h;if(r.length===1&&r[0]==="line"){const d=V(s,e.refs[0]);u=d?.[0]??null,h=d?.[1]??null}else r.length===1?(u=[0,0],h=a(e.refs[0])):(u=a(e.refs[0]),h=a(e.refs[1]));return!u||!h?null:Fr(u,h,c,l,i,o)}case"radius":case"diameter":{const l=pt(s,e.refs[0]),u=l?ve(s,l):null,h=Lt(s,e.refs[0]);if(!u||h==null)return null;let d=N(c,u);Math.hypot(d[0],d[1])<1e-12&&(d=[1,0]),d=Ke(d);const f=de(u,Y(d,h)),y=Ye(N(c,u),d)>h;if(e.kind==="radius")return{lines:[[u,y?c:f]],arrows:[{at:f,dir:y?Y(d,-1):d}],text:c};const p=N(u,Y(d,h));return{lines:[[p,y?c:f]],arrows:[{at:f,dir:y?Y(d,-1):d},{at:p,dir:Y(d,-1)}],text:c}}case"angle":{let l,u,h,d,f;if(r.length===1&&r[0]==="line"){const C=V(s,e.refs[0]);if(!C)return null;l=C[0],u=0;const E=N(C[1],C[0]);h=Math.atan2(E[1],E[0]),d=[l,de(l,[X(C[0],C[1]),0])],f=C}else{if(r.length!==2)return null;const C=V(s,e.refs[0]),E=V(s,e.refs[1]);if(!C||!E)return null;const _=Vs(C[0],C[1],E[0],E[1]);if(!_)return null;l=_.p,d=C,f=E;const P=N(d[1],d[0]),T=N(f[1],f[0]);u=Math.atan2(P[1],P[0]),h=Tt(Math.atan2(T[1],T[0])-u)}const y=h>=0?u:u+h,p=Math.abs(h),m=Math.max(X(l,c),12*t),g=[],x=Math.max(8,Math.ceil(p/(Math.PI/2)*16));let w=ie(l,m,y);for(let C=1;C<=x;C++){const E=ie(l,m,y+p*C/x);g.push([w,E]),w=E}for(const[C,E]of[[d,y],[f,y+p]]){const _=ie(l,m+o,E),P=Math.max(X(l,C[0]),X(l,C[1]));m>P&&g.push([ie(l,P+i,E),_])}const k=Math.atan2(c[1]-l[1],c[0]-l[0]),S=Tt(k-(y+p)),b=Tt(y-k);if(S>0&&S<Math.PI/2){const C=Math.max(2,Math.ceil(S/(Math.PI/2)*16));let E=ie(l,m,y+p);for(let _=1;_<=C;_++){const P=ie(l,m,y+p+S*_/C);g.push([E,P]),E=P}}else if(b>0&&b<Math.PI/2){const C=Math.max(2,Math.ceil(b/(Math.PI/2)*16));let E=ie(l,m,y);for(let _=1;_<=C;_++){const P=ie(l,m,y-b*_/C);g.push([E,P]),E=P}}const M=ie(l,m,y),A=ie(l,m,y+p),B=[-Math.sin(y),Math.cos(y)],R=[-Math.sin(y+p),Math.cos(y+p)];return{lines:g,arrows:[{at:M,dir:Y(B,-1)},{at:A,dir:R}],text:c}}}}function Qn(s,e){const t=Ke(N(e,s));return[{at:s,dir:Y(t,-1)},{at:e,dir:t}]}function In(s,e,t,n,i){const o=Ke(N(e,s)),r=zs(o),a=Ye(N(t,s),r),c=a>=0?1:-1,l=de(s,Y(r,a)),u=de(e,Y(r,a)),h=[];Math.abs(a)>n&&(h.push([de(s,Y(r,c*n)),de(l,Y(r,c*i))]),h.push([de(e,Y(r,c*n)),de(u,Y(r,c*i))]));const d=Ye(N(t,s),o),f=X(s,e),y=d<0?de(l,Y(o,d)):l,p=d>f?de(l,Y(o,d)):u;return h.push([y,p]),{lines:h,arrows:Qn(l,u),text:de(l,Y(o,d))}}function Fr(s,e,t,n,i,o){const r=1-n,a=n===0?[s[0],t[1]]:[t[0],s[1]],c=n===0?[e[0],t[1]]:[t[0],e[1]],l=[];for(const[p,m]of[[s,a],[e,c]]){const g=m[r]-p[r];if(Math.abs(g)>i){const x=Math.sign(g),w=[...p];w[r]+=x*i;const k=[...m];k[r]+=x*o,l.push([w,k])}}const u=Math.min(a[n],c[n],t[n]),h=Math.max(a[n],c[n],t[n]),d=[...a],f=[...a];d[n]=u,f[n]=h,l.push([d,f]);const y=[...a];return y[n]=t[n],{lines:l,arrows:Qn(a,c),text:y}}function Ir(s,e,t,n,i){const o=Ot(s,e[0],e[1]),r=[];if(o.t<0||o.t>1){const c=o.t<0?e[0]:e[1],l=Ke(N(o.p,c));r.push([de(c,Y(l,n)),de(o.p,Y(l,i))])}const a=In(s,o.p,t,n,i);return{lines:[...r,...a.lines],arrows:a.arrows,text:a.text}}function Or(s,e){const t=new Set;for(const r of e){const a=st(s,r);if(a)for(const c of Fn(a))t.add(c);else s.points[r]&&t.add(r)}const n=new Set,i=[...t];for(;i.length;){const r=i.pop();if(!n.has(r)){n.add(r);for(const a of s.entities){const c=Fn(a);if(c.includes(r))for(const l of c)n.has(l)||i.push(l)}}}const o=[];for(const r of n){const a=s.points[r];a&&o.push(a)}return o}const Js=10,ei=28;function Rt(s,e,t,n){return Math.max(ei*s,Js*s+0)}function hs(s,e,t,n,i,o){const r=Math.abs(t)/2,a=e+t/2,c=[[-Math.sin(e),Math.cos(e)],[-Math.sin(e+t),Math.cos(e+t)]],l=h=>Math.max(...c.map(d=>Js*i+Math.max(0,0)));if(r<1e-6){const h=ie(s,n,e);return de(h,Y(c[0],Rt(i)))}let u=n;for(let h=0;h<4;h++){const d=l(ie(s,u,a))/Math.sin(Math.min(r,Math.PI/2));if(d<=u*(1+1e-9))break;u=d}if(u>Nr*n&&r<Math.PI/4){const h=t>=0?1:-1,d=e+t,f=Math.PI/6;let y=n,p=ie(s,y,d+h*f);for(let m=0;m<4;m++){const g=l();y=Math.max(n,g/Math.sin(f)),p=ie(s,y,d+h*Math.asin(Math.min(1,g/y)))}if(y<u)return p}return ie(s,u,a)}const Nr=1.25;function Lr(s,e,t,n){const i=ei*t,o=e.refs.map(p=>dn(s,p)),r=p=>{const m=tt(s,p);return m?ve(s,m):null};if((e.kind==="radius"||e.kind==="diameter")&&e.refs[0]){const p=pt(s,e.refs[0]),m=p?ve(s,p):null,g=Lt(s,e.refs[0]);return!m||g==null?null:(ie(m,g,Math.PI/4),ie(m,g+Rt(t),Math.PI/4))}if(e.kind==="angle"&&e.refs.length===1){const p=V(s,e.refs[0]);if(!p)return null;const m=mt(p[0],p[1]);return hs(p[0],0,m,Math.max(i,X(p[0],p[1])*.4),t)}if(e.kind==="angle"){const p=V(s,e.refs[0]),m=V(s,e.refs[1]);if(!p||!m)return null;const g=Vs(p[0],p[1],m[0],m[1]);if(!g)return null;const x=mt([0,0],N(p[1],p[0])),w=Tt(mt([0,0],N(m[1],m[0]))-x),k=Math.min(X(p[0],p[1]),X(m[0],m[1]));return hs(g.p,x,w,Math.max(i,k*.4),t)}let a=null,c=null;if(o.length===1&&o[0]==="line")[a,c]=V(s,e.refs[0])??[null,null];else if(o.length===1)a=[0,0],c=r(e.refs[0]);else if(o.includes("line")&&o.includes("point")){a=r(e.refs[o.indexOf("point")]);const p=V(s,e.refs[o.indexOf("line")]);c=a&&p?Ot(a,p[0],p[1]).p:null}else if(o[0]==="line"&&o[1]==="line"){const p=V(s,e.refs[0]),m=V(s,e.refs[1]);a=p?[(p[0][0]+p[1][0])/2,(p[0][1]+p[1][1])/2]:null,c=a&&m?Ot(a,m[0],m[1]).p:null}else a=r(e.refs[0]),c=r(e.refs[1]);if(!a||!c)return null;const l=[(a[0]+c[0])/2,(a[1]+c[1])/2];if(e.kind==="distance_x"){const p=[l[0],Math.max(a[1],c[1])];return[p[0],p[1]+Rt(t)]}if(e.kind==="distance_y"){const p=[Math.max(a[0],c[0]),l[1]];return[p[0]+Rt(t),p[1]]}const u=N(c,a),h=Ke(zs(u)),d=Or(s,e.refs);let f=Ye(l,h)>=0?1:-1;if(d.length){const p=[d.reduce((g,x)=>g+x[0],0)/d.length,d.reduce((g,x)=>g+x[1],0)/d.length],m=Ye(N(l,p),h);Math.abs(m)>1e-9*Math.max(1,Math.hypot(u[0],u[1]))&&(f=m>0?1:-1)}const y=Y(h,f);return de(l,Y(y,Rt(t)))}function ti(s){const e=Math.round(s*100)/100;return String(Object.is(e,-0)?0:e)}const $e=(s,e,t=1.6)=>`M${s-t} ${e}a${t} ${t} 0 1 0 ${2*t} 0a${t} ${t} 0 1 0 ${-2*t} 0`,J={line:`M6 18L18 6 ${$e(6,18)} ${$e(18,6)}`,rectangle:`M5 7h14v10H5z ${$e(5,7,1.3)} ${$e(19,17,1.3)}`,circle:`M12 12m-7.5 0a7.5 7.5 0 1 0 15 0a7.5 7.5 0 1 0 -15 0 ${$e(12,12,1.2)}`,arc:`M4.5 17a8.5 8.5 0 0 1 15 0 ${$e(4.5,17,1.4)} ${$e(12,8.6,1.4)} ${$e(19.5,17,1.4)}`,point:`${$e(12,12,2.2)} M12 4v3.5 M12 16.5V20 M4 12h3.5 M16.5 12H20`,coincident:`${$e(10,12,3)} ${$e(14,12,3)}`,horizontal:"M4 12h16 M4 9v6 M20 9v6",vertical:"M12 4v16 M9 4h6 M9 20h6",parallel:"M5 17L13 5 M11 19l8-12",perpendicular:"M5 19h14 M12 19V5 M12 15h4v4",tangent:"M12 14m-5 0a5 5 0 1 0 10 0a5 5 0 1 0 -10 0 M3 9h18",equal:"M5 9h14 M5 15h14",midpoint:"M4 16L20 8 M12 12l-2.5-3.5 M12 12l3.2-2.2",symmetric:"M12 3v2 M12 8v2 M12 13v2 M12 18v2 M9 8l-5 4 5 4z M15 8l5 4-5 4z",concentric:"M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0 M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",collinear:"M3 16l6-4 M13 9.3L21 4 M3 16h0",fix:"M7 11V8a5 5 0 0 1 10 0v3 M5 11h14v9H5z M12 15v2",onCurve:`M4 17a9 9 0 0 1 16 0 ${$e(12,8.5,2.2)}`,intersection:"M5 5l14 14 M19 5L5 19",dimension:"M4 7v10 M20 7v10 M4 12h16 M7.5 9.5L4 12l3.5 2.5 M16.5 9.5L20 12l-3.5 2.5"},qr={coincident:J.coincident,horizontal:J.horizontal,vertical:J.vertical,parallel:J.parallel,perpendicular:J.perpendicular,tangent:J.tangent,equal:J.equal,midpoint:J.midpoint,symmetric:J.symmetric,point_on_line:J.onCurve,point_on_circle:J.onCurve,"on-curve":J.onCurve,intersection:J.intersection,concentric:J.concentric,collinear:J.collinear,fix:J.fix},Gr="solver/solver-worker.js";function zr(s){const e=s.readyTimeoutMs??2e4,t=s.callTimeoutMs??2e4;let n=null,i=null,o=!1,r=1,a=0,c=!1;const l=[],u=new Map,h=()=>s.url??new URL(Gr,document.baseURI).href;function d(m){const g=n;n=null,i=null,o=!1;try{g?.terminate()}catch{}for(const x of[...u.values(),...l.splice(0)])x.timer&&clearTimeout(x.timer),x.reject(new Error(m));u.clear()}function f(m){u.set(m.id,m),m.timer=setTimeout(()=>d(`the sketch solver stopped answering (${m.op} took more than ${Math.round(t/1e3)} s)`),t),n.postMessage({type:"call",id:m.id,op:m.op,params:m.params})}function y(){return c?Promise.reject(new Error("the sketch solver was shut down")):i||(a+=1,i=new Promise((m,g)=>{let x;try{x=s.spawn(h())}catch(k){i=null,g(new Error(`the sketch solver could not start: ${k instanceof Error?k.message:String(k)}`));return}n=x;const w=setTimeout(()=>{g(new Error(`the sketch solver did not start within ${Math.round(e/1e3)} s`)),d("the sketch solver did not start")},e);x.addEventListener("message",k=>{if(x!==n)return;const S=k.data;if(S?.type==="ready"){clearTimeout(w),o=!0,m();for(const b of l.splice(0))f(b);return}if(S?.type==="error"){clearTimeout(w),g(new Error(`the sketch solver could not start: ${S.error??"unknown error"}`)),d(`the sketch solver could not start: ${S.error??"unknown error"}`);return}if(S?.type==="result"&&typeof S.id=="number"){const b=u.get(S.id);if(!b)return;u.delete(S.id),b.timer&&clearTimeout(b.timer),S.ok?b.resolve(S.result):b.reject(new Error(S.error??"the sketch solver failed"))}}),x.addEventListener("error",k=>{if(x!==n)return;const S=k.message||"the worker failed";clearTimeout(w),g(new Error(`the sketch solver stopped: ${S}`)),d(`the sketch solver stopped: ${S}`)})}),i.catch(()=>{}),i)}function p(m,...g){return new Promise((x,w)=>{const k={id:r++,op:m,params:g,resolve:x,reject:w};o&&n?f(k):(l.push(k),y().catch(S=>{const b=l.indexOf(k);b>=0&&(l.splice(b,1),w(S))}))})}return{get starts(){return a},ready:()=>y(),solveFeature(m,g){return p("solveOnce",Zs(m,g))},load:m=>p("load",m),solve:()=>p("solve"),analyze:()=>p("analyze"),setValue:(m,g)=>p("setValue",m,g),dragStart:(m,g)=>p("dragStart",m,g??{}),dragStartEntity:(m,g,x)=>p("dragStartEntity",m,g,x??{}),dragMove:(m,g)=>p("dragMove",m,g),dragEnd:()=>p("dragEnd"),dispose(){c=!0,d("the sketch solver was shut down")}}}const Vr="solver/solver-worker.js",ni=()=>({points:{},entities:[],constraints:[]}),Wr=s=>!!s.construction||s.kind==="line"&&!!s.centerline,jr=4*Math.PI/180;function wn(s,e,t,n){const i=Math.max(2,Math.ceil(n/jr)),o=[];for(let r=0;r<=i;r++){const a=t+n*r/i;o.push([s[0]+e*Math.cos(a),s[1]+e*Math.sin(a)])}return o}function Xr(s){const e=new Map,t=d=>{let f=d;for(;e.has(f)&&e.get(f)!==f;)f=e.get(f);let y=d;for(;e.has(y)&&e.get(y)!==f;){const p=e.get(y);e.set(y,f),y=p}return f};for(const d of s.constraints){if(Ve(d)||d.kind!=="coincident"||d.refs.length!==2)continue;const[f,y]=d.refs;if(!(f in s.points)||!(y in s.points))continue;const p=t(f),m=t(y);p!==m&&e.set(p,m)}const n=[],i=[],o=[];for(const d of s.entities)if(!Wr(d)){if(d.kind==="circle"){const f=s.points[d.c];f&&d.r>0&&n.push(wn(f,d.r,0,2*Math.PI).slice(0,-1)),f&&d.r>0&&o.push(wn(f,d.r,0,2*Math.PI))}else if(d.kind==="line"){const f=s.points[d.p[0]],y=s.points[d.p[1]];f&&y&&i.push({a:t(d.p[0]),b:t(d.p[1]),poly:[f,y]})}else if(d.kind==="arc"){const f=Nt(s,d);if(!f)continue;const y=wn(f.c,f.r,f.a0,f.sweep),p=d.ccw!==!1;i.push(p?{a:t(d.a),b:t(d.b),poly:y}:{a:t(d.b),b:t(d.a),poly:y})}else if(d.kind==="spline"){const f=Hs(s,d,96);if(f.length<2)continue;d.closed?n.push(f.slice(0,-1)):i.push({a:t(d.pts[0]),b:t(d.pts[d.pts.length-1]),poly:f}),o.push(f)}}for(const d of i)o.includes(d.poly)||o.push(d.poly);const r=new Map;i.forEach((d,f)=>{if(d.a!==d.b)for(const y of[d.a,d.b])r.has(y)||r.set(y,[]),r.get(y).push(f)});const a=d=>{for(const[f,y]of Object.entries(s.points))if(t(f)===d)return y;return[0,0]},c=[],l=[],u=new Set;for(const[d,f]of r)f.length===1&&c.push(a(d)),f.length>2&&l.push(a(d)),f.length!==2&&u.add(d);const h=new Set;return i.forEach((d,f)=>{if(h.has(f)||d.a===d.b)return;const y=[];let p=d.a,m=f,g=!0;for(let x=0;x<=i.length;x++){u.has(p)&&(g=!1),h.add(m);const w=i[m],k=w.a===p,S=k?w.poly:[...w.poly].reverse();if(y.push(...S.slice(0,-1)),p=k?w.b:w.a,p===d.a)break;const b=(r.get(p)??[]).find(M=>M!==m&&!h.has(M));if(b===void 0){g=!1;break}m=b}g&&p===d.a&&y.length>=3&&n.push(y)}),{rings:n,open:c,branch:l,curves:o}}const Kr={mm:{q:"length",k:1},cm:{q:"length",k:10},m:{q:"length",k:1e3},in:{q:"length",k:25.4},'"':{q:"length",k:25.4},ft:{q:"length",k:304.8},deg:{q:"angle",k:1},"°":{q:"angle",k:1},rad:{q:"angle",k:180/Math.PI}};function si(s,e){const t=/^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z°"]*)\s*$/i.exec(s);if(!t)return{error:`Enter a number${e==="length"?", with mm, cm, m, in or ft":", with deg or rad"} if you like.`};const n=Number(t[1]),i=t[2].toLowerCase();if(!i)return n>0||e==="angle"?{value:n}:{error:"A length must be more than 0."};const o=Kr[i];if(!o||o.q!==e)return{error:`“${t[2]}” is not a unit of ${e==="length"?"length":"angle"} here.`};const r=n*o.k;return e==="length"&&!(r>0)?{error:"A length must be more than 0."}:{value:r}}function ii(s,e){const t=Math.round(s*1e4)/1e4;return e==="length"?`${t} mm`:`${t} deg`}function Yr(s){const e={},t={};for(const n of s.constraints){if(!Ve(n)||!n.driving)continue;const i=n.kind==="angle"?"angle":"length",o=si(String(n.expr??""),i);"value"in o?e[n.id]=o.value:t[n.id]=o.error}return{values:e,errors:t}}const Hr=256;function fs(s,e,t=Hr){const n=[];for(let i=0;i<t;i++){const o=2*Math.PI*i/t;n.push(s*Math.cos(o),e*Math.sin(o))}return n}function ps(s,e){return[-s/2,-e/2,s/2,-e/2,s/2,e/2,-s/2,e/2]}function ri(s,e,t){if(!(t>0))return{x:s,y:e};let n=0;for(let c=1;c<s.length;c++)s[c]<s[n]&&(n=c);const i=Array.from({length:n+1},(c,l)=>n-l),o=Array.from({length:s.length-n},(c,l)=>n+l),r=(c,l)=>{for(let u=1;u<c.length;u++){const h=c[u-1],d=c[u];if(s[d]>=l)return s[d]===s[h]?e[d]:e[h]+(e[d]-e[h])*(l-s[h])/(s[d]-s[h])}return e[c[c.length-1]]},a=e.slice();for(let c=0;c<s.length;c++){if(s[c]<.5)continue;const l=c<n,u=r(l?o:i,s[c]);if((l?e[c]-u:u-e[c])>=t)continue;const d=.5*(e[c]+u);a[c]=d+(l?.5:-.5)*t}return{x:s,y:a}}function ms(s,e,t,n=0){const i=ri(s,e,n/t),o=[];for(let r=0;r<i.x.length;r++)o.push((i.x[r]-.25)*t,i.y[r]*t);return ln(o)}const ys=new WeakMap;function dt(s){let e=ys.get(s);return e||(e=Xr(s),ys.set(s,e)),e}function hn(s){return dt(s).rings.map(e=>ln(e.flatMap(([t,n])=>[t/1e3,n/1e3])))}const qt=s=>s.kind!=="sketch"||hn(s.sketch).length>0;function sn(s,e=0){return s.kind==="sketch"?hn(s.sketch):[On(s,e)]}function On(s,e=0){switch(s.kind){case"sketch":{const t=hn(s.sketch);let n=[],i=-1;for(const o of t){const r=un([o]),a=(r.x1-r.x0)*(r.y1-r.y0);a>i&&(i=a,n=o)}return n}case"naca":{const t=_n(s.code,121);return ms(t.x,t.y,s.chord,e)}case"dat":return ms(s.x,s.y,s.chord,e);case"circle":return fs(s.diameter/2,s.diameter/2);case"ellipse":return fs(s.width/2,s.height/2);case"rect":return ps(s.width,s.height);case"plate":return ps(s.length,s.thickness)}}function Se(s){switch(s.kind){case"naca":case"dat":return s.chord;case"circle":return s.diameter;case"ellipse":case"rect":return s.height;case"plate":return s.length;case"sketch":{const e=hn(s.sketch);if(e.length){const o=un(e);return Math.max(o.x1-o.x0,o.y1-o.y0)}const t=dt(s.sketch).curves.flat();if(!t.length)return .01;const n=t.map(o=>o[0]),i=t.map(o=>o[1]);return Math.max(.01,(Math.max(...n)-Math.min(...n))/1e3,(Math.max(...i)-Math.min(...i))/1e3)}}}function rn(s){switch(s.kind){case"naca":return`NACA ${s.code}`;case"dat":return s.name;case"circle":return"Cylinder";case"ellipse":return"Ellipse";case"rect":return"Rectangle";case"plate":return"Flat plate";case"sketch":return s.name||"Sketch"}}const Qr=4,Zr=2,Jr=4e6;function Gt(s,e=Qr){const t=s.length&&Array.isArray(s[0])?s:[s],n=un(t),i=e+2;let o=1/Zr,r=Math.ceil((n.x1-n.x0+2*i)/o)+1,a=Math.ceil((n.y1-n.y0+2*i)/o)+1;for(;r*a>Jr;)o*=1.5,r=Math.ceil((n.x1-n.x0+2*i)/o)+1,a=Math.ceil((n.y1-n.y0+2*i)/o)+1;const c=n.x0-i,l=n.y0-i,u=new Float32Array(r*a).fill(e);for(const f of t){const y=f.length/2;for(let p=0;p<y;p++){const m=f[2*p],g=f[2*p+1],x=f[2*((p+1)%y)],w=f[2*((p+1)%y)+1],k=Math.max(0,Math.floor((Math.min(m,x)-e-c)/o)),S=Math.min(r-1,Math.ceil((Math.max(m,x)+e-c)/o)),b=Math.max(0,Math.floor((Math.min(g,w)-e-l)/o)),M=Math.min(a-1,Math.ceil((Math.max(g,w)+e-l)/o)),A=x-m,B=w-g,R=A*A+B*B;for(let C=b;C<=M;C++){const E=l+C*o;for(let _=k;_<=S;_++){const P=c+_*o;let T=R>0?((P-m)*A+(E-g)*B)/R:0;T=T<0?0:T>1?1:T;const $=P-(m+T*A),U=E-(g+T*B),I=Math.sqrt($*$+U*U),W=C*r+_;I<u[W]&&(u[W]=I)}}}}const h=[];for(let f=0;f<a;f++){const y=l+f*o;h.length=0;for(const p of t){const m=p.length/2;for(let g=0;g<m;g++){const x=p[2*g+1],w=p[2*((g+1)%m)+1];if(x>y!=w>y){const k=p[2*g],S=p[2*((g+1)%m)];h.push(k+(y-x)*(S-k)/(w-x))}}}h.sort((p,m)=>p-m);for(let p=0;p+1<h.length;p+=2){const m=Math.max(0,Math.ceil((h[p]-c)/o)),g=Math.min(r-1,Math.floor((h[p+1]-c)/o));for(let x=m;x<=g;x++)u[f*r+x]=-u[f*r+x]}}let d=0;for(const f of t)for(let y=0;y<f.length;y+=2)d=Math.max(d,Math.hypot(f[y],f[y+1]));return{data:u,w:r,h:a,ox:c,oy:l,texel:o,band:e,bound:d+1}}const eo=new Uint8Array([0,0,4,1,0,5,1,1,6,1,1,8,2,1,10,2,2,12,2,2,14,3,2,16,4,3,18,4,3,20,5,4,23,6,4,25,7,5,27,8,5,29,9,6,31,10,7,34,11,7,36,12,8,38,13,8,41,14,9,43,16,9,45,17,10,48,18,10,50,20,11,52,21,11,55,22,11,57,24,12,60,25,12,62,27,12,65,28,12,67,30,12,69,31,12,72,33,12,74,35,12,76,36,12,79,38,12,81,40,11,83,41,11,85,43,11,87,45,11,89,47,10,91,49,10,92,50,10,94,52,10,95,54,9,97,56,9,98,57,9,99,59,9,100,61,9,101,62,9,102,64,10,103,66,10,104,68,10,104,69,10,105,71,11,106,73,11,106,74,12,107,76,12,107,77,13,108,79,13,108,81,14,108,82,14,109,84,15,109,85,15,109,87,16,110,89,16,110,90,17,110,92,18,110,93,18,110,95,19,110,97,19,110,98,20,110,100,21,110,101,21,110,103,22,110,105,22,110,106,23,110,108,24,110,109,24,110,111,25,110,113,25,110,114,26,110,116,26,110,117,27,110,119,28,109,120,28,109,122,29,109,124,29,109,125,30,109,127,30,108,128,31,108,130,32,108,132,32,107,133,33,107,135,33,107,136,34,106,138,34,106,140,35,105,141,35,105,143,36,105,144,37,104,146,37,104,147,38,103,149,38,103,151,39,102,152,39,102,154,40,101,155,41,100,157,41,100,159,42,99,160,42,99,162,43,98,163,44,97,165,44,96,166,45,96,168,46,95,169,46,94,171,47,94,173,48,93,174,48,92,176,49,91,177,50,90,179,50,90,180,51,89,182,52,88,183,53,87,185,53,86,186,54,85,188,55,84,189,56,83,191,57,82,192,58,81,193,58,80,195,59,79,196,60,78,198,61,77,199,62,76,200,63,75,202,64,74,203,65,73,204,66,72,206,67,71,207,68,70,208,69,69,210,70,68,211,71,67,212,72,66,213,74,65,215,75,63,216,76,62,217,77,61,218,78,60,219,80,59,221,81,58,222,82,56,223,83,55,224,85,54,225,86,53,226,87,52,227,89,51,228,90,49,229,92,48,230,93,47,231,94,46,232,96,45,233,97,43,234,99,42,235,100,41,235,102,40,236,103,38,237,105,37,238,106,36,239,108,35,239,110,33,240,111,32,241,113,31,241,115,29,242,116,28,243,118,27,243,120,25,244,121,24,245,123,23,245,125,21,246,126,20,246,128,19,247,130,18,247,132,16,248,133,15,248,135,14,248,137,12,249,139,11,249,140,10,249,142,9,250,144,8,250,146,7,250,148,7,251,150,6,251,151,6,251,153,6,251,155,6,251,157,7,252,159,7,252,161,8,252,163,9,252,165,10,252,166,12,252,168,13,252,170,15,252,172,17,252,174,18,252,176,20,252,178,22,252,180,24,251,182,26,251,184,29,251,186,31,251,188,33,251,190,35,250,192,38,250,194,40,250,196,42,250,198,45,249,199,47,249,201,50,249,203,53,248,205,55,248,207,58,247,209,61,247,211,64,246,213,67,246,215,70,245,217,73,245,219,76,244,221,79,244,223,83,244,225,86,243,227,90,243,229,93,242,230,97,242,232,101,242,234,105,241,236,109,241,237,113,241,239,117,241,241,121,242,242,125,242,244,130,243,245,134,243,246,138,244,248,142,245,249,146,246,250,150,248,251,154,249,252,157,250,253,161,252,255,164]),Z=128,re=8,Ne=2048,on=1048576,Fe=Ne*re*2,kn=Fe+4,kt=.1,Mt=.2,Oe=[0,1,0,-1,0,1,-1,-1,1],ot=[0,0,1,0,-1,1,1,-1,-1],ze=[4/9,1/9,1/9,1/9,1/9,1/36,1/36,1/36,1/36],to=[0,3,4,1,2,7,8,5,6],no=[0,1,4,3,2,8,7,6,5],so={slip:0,noslip:1,periodic:2,farfield:3},L=s=>s.toFixed(10),oe=s=>s.toFixed(1),fn=`
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
fn sdfAt(p: vec2f, near: u32, bp: ptr<function, array<vec4f, ${re}>>) -> Hit {
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
fn sdfGrad(p: vec2f, near: u32, bp: ptr<function, array<vec4f, ${re}>>) -> vec2f {
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
fn poses(p: vec2f, t: f32, bp: ptr<function, array<vec4f, ${re}>>) -> u32 {
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
`,zt=`
const CXF = array<f32, 9>(${Oe.map(oe).join(", ")});
const CYF = array<f32, 9>(${ot.map(oe).join(", ")});
const WF = array<f32, 9>(${ze.map(L).join(", ")});
`,io={off:0,wall:1,sa:2},ht=.41,oi=5,De={cb1:.1355,sigma:2/3,cb2:.622,cw2:.3,cw3:2,cv1:7.1,cv2:.7,cv3:.9},ro=De.cb1/(ht*ht)+(1+De.cb2)/De.sigma,oo=.2,Zn=2,ai=32,lt=2,ao=`
const KAPPA = ${L(ht)};
const WALL_EKB = ${L(Math.exp(-ht*oi))};
const SA_CB1 = ${L(De.cb1)};
const SA_SIGMA = ${L(De.sigma)};
const SA_CB2 = ${L(De.cb2)};
const SA_CW1 = ${L(ro)};
const SA_CW2 = ${L(De.cw2)};
const SA_CW3_6 = ${L(De.cw3**6)};
const SA_CV1_3 = ${L(De.cv1**3)};
const SA_CV2 = ${L(De.cv2)};
const SA_CV3 = ${L(De.cv3)};

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
fn wallDist(p: vec2f, bp: ptr<function, array<vec4f, ${re}>>) -> f32 {
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
  return clamp(n0 + prod - dest + diff + cross - adv, 0.0, ${oo});
}

fn saFv1(nt: f32) -> f32 {
  let chi = nt / P.nuMol;
  let chi3 = chi * chi * chi;
  return chi3 / (chi3 + SA_CV1_3);
}
`,li=`
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
`,lo=`
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
`,gs=12;function Nn(s=!1){const e=(r,a)=>`fin[${r}u * P.n + ${a}]`,t=r=>`(${L(ze[r])} * (drho + rho * (3.0 * (${oe(Oe[r])} * ux + ${oe(ot[r])} * uy) + 4.5 * (${oe(Oe[r])} * ux + ${oe(ot[r])} * uy) * (${oe(Oe[r])} * ux + ${oe(ot[r])} * uy) - 1.5 * (ux * ux + uy * uy))))`;let n="";for(let r=1;r<9;r++){const a=to[r],c=Oe[r],l=ot[r];let u="";c>0&&(u=`if (x == 0u) { f${r} = 0.0; } else `),c<0&&(u=`if (x == P.nx - 1u) { f${r} = ${e(r,"idx")}; } else `);let h="";if(l!==0){const f=l>0?"y == 0u":"y == P.ny - 1u",y=l>0?"P.ny - 1u":"0u";h=`if (${f}) {
      if (WALLS == 1u) { f${r} = ${e(a,"idx")}; }
      else if (WALLS == 0u) { f${r} = ${e(no[r],`u32(i32(x) - (${c})) + y * P.nx`)}; }
      else if (WALLS == 3u) { f${r} = ${L(ze[r])} * (3.0 * ${oe(c)} * P.uIn + 4.5 * ${oe(c*c)} * P.uIn * P.uIn - 1.5 * P.uIn * P.uIn); }
      else { f${r} = ${e(r,`u32(i32(x) - (${c})) + ${y} * P.nx`)}; }
    } else `}const d=`(${oe(c)} * uw.x + ${oe(l)} * uw.y)`;n+=`
  var f${r}: f32;
  ${u}${h}{
    let sx = i32(x) - (${c});
    let sy = i32(y) - (${l});
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
        let hm = sdfAt(vec2f(f32(x) - ${oe(c*.5)}, f32(y) - ${oe(l*.5)}), near, &bp);
        if (hm.d < 0.0 && dot(sdfGrad(p, near, &bp), sdfGrad(vec2f(f32(sx), f32(sy)), near, &bp)) < 0.0) {
          hit = hm;
          qThin = clamp(0.5 * d0 / (d0 - hm.d), 0.001, 0.5);
        }
      }
    }
    if (hit.d < 0.0) {
      // Bouzidi: direction ${a} leaves this cell into the body, q of the way to its wall.
      var q = select(clamp(d0 / (d0 - hit.d), 0.001, 1.0), qThin, qThin >= 0.0);
      let bx = i32(x) + (${c});
      let by = i32(y) + (${l});
      var behindFluid = bx >= 0 && by >= 0 && bx < i32(P.nx) && by < i32(P.ny);
      if (behindFluid && q < 0.5) { behindFluid = sdfAt(vec2f(f32(bx), f32(by)), near, &bp).d >= 0.0; }
      if (q < 0.5 && !behindFluid) { q = 0.5; }
      let c = bp[hit.b].xy;
      let uwB = wallU(hit.b, vec2f(f32(sx), f32(sy)), c);
      // The wall model's slip moves the wall along itself (only the body it was worked out for).
      let uw = uwB + select(vec2f(0.0), slip, hit.b == wfB);
      let fi = ${e(a,"idx")};
      let mw = ${L(6*ze[r])} * ${d};
      if (q < 0.5) { f${r} = 2.0 * q * fi + (1.0 - 2.0 * q) * ${e(a,"u32(bx) + u32(by) * P.nx")} + mw; }
      else { f${r} = fi / (2.0 * q) + (2.0 * q - 1.0) / (2.0 * q) * ${e(r,"idx")} + mw / (2.0 * q); }
      let slot = (S.slot * ${re}u + hit.b) * 2u;
      atomicAdd(&force[slot], i32(round((${oe(Oe[a])} * (fi + f${r}) - uwB.x * (fi - f${r})) * ${on}.0)));
      atomicAdd(&force[slot + 1u], i32(round((${oe(ot[a])} * (fi + f${r}) - uwB.y * (fi - f${r})) * ${on}.0)));
    } else {
      f${r} = ${e(r,"src")};
    }
  }`}let i="";for(let r=0;r<9;r++)i+=`  let e${r} = ${t(r)};
`;const o=r=>`(f${r} - e${r})`;i+=`
  let pxx = ${[1,3,5,6,7,8].map(o).join(" + ")};
  let pyy = ${[2,4,5,6,7,8].map(o).join(" + ")};
  let pxy = ${o(5)} - ${o(6)} + ${o(7)} - ${o(8)};
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
`;for(let r=0;r<9;r++){const a=Oe[r],c=ot[r],l=a*a-1/3,u=c*c-1/3,h=a*c,d=a*a*c-c/3,f=a*c*c-a/3;i+=`  var o${r} = ${L(ze[r])} * (drho + rho * (3.0 * (${L(a)} * ux + ${L(c)} * uy) + 4.5 * (${L(l)} * ux * ux + ${L(u)} * uy * uy + ${L(2*h)} * ux * uy) + 13.5 * (${L(d)} * ux * ux * uy + ${L(f)} * ux * uy * uy)))
    + ${L(ze[r])} * (4.5 * (${L(l)} * dxx + ${L(u)} * dyy + ${L(2*h)} * dxy) + 13.5 * keep * (${L(d)} * axxy + ${L(f)} * axyy));
`}return i+=`  if (sig > 0.0) {
    let uT = P.uIn;
${Array.from({length:9},(r,a)=>`    o${a} = mix(o${a}, ${L(ze[a])} * (3.0 * ${oe(Oe[a])} * uT + 4.5 * ${oe(Oe[a]*Oe[a])} * uT * uT - 1.5 * uT * uT), sig);`).join(`
`)}
  }
${Array.from({length:9},(r,a)=>`  fout[${a}u * P.n + idx] = o${a};`).join(`
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
${zt}
${fn}
${ao}
${s?li+lo:""}

@compute @workgroup_size(${Z})
fn step(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${Z}u;
  if (idx >= P.n) { return; }
  let x = idx % P.nx;
  let y = idx / P.nx;
  ${s?`if (x == 0u || y == 0u || x == P.nx - 1u || y == P.ny - 1u) {
    edgeCell(x, y, idx);
    return;
  }`:""}
  let xf = f32(x);
  let p = vec2f(xf, f32(y));
  var bp: array<vec4f, ${re}>;
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
  // the velocity ${lt} cells off the wall (last step's), then the slip that makes the
  // stress resolved between the wall and the point one cell off it the law's (that point, not
  // this cell: a cell on the wall would set its own slip), and ν̃ = κ u_τ d here.
  var slip = vec2f(0.0);
  var wfB = ${re}u;
  var wfNt = -1.0;
  if (TURB > 0u && near != 0u && d0 < 1.5) {
    let gx = sdfAt(p + vec2f(0.5, 0.0), near, &bp).d - sdfAt(p - vec2f(0.5, 0.0), near, &bp).d;
    let gy = sdfAt(p + vec2f(0.0, 0.5), near, &bp).d - sdfAt(p - vec2f(0.0, 0.5), near, &bp).d;
    let gl = length(vec2f(gx, gy));
    if (gl > 1e-6) {
      let nrm = vec2f(gx, gy) / gl;
      let xw = p - d0 * nrm;
      let ub = wallU(b0, xw, bp[b0].xy);
      let aR = auxLerp(xw + ${lt.toFixed(3)} * nrm);
      let aV = auxLerp(xw + nrm);
      let uR = aR.xy - ub;
      let utR = uR - dot(uR, nrm) * nrm;
      let ut = length(utR);
      if (ut > 1e-7 && aR.w >= 0.0 && aV.w >= 0.0) {
        let t = utR / ut;
        let utau = ut / wallUplus(${lt.toFixed(3)} * ut / P.nuMol);
        let uv = dot(aV.xy - ub, t);
        let s = clamp(uv - utau * utau / max(aV.w, P.nuMol), 0.0, max(uv, 0.0));
        slip = s * t;
        wfB = b0;
        wfNt = KAPPA * utau * d0;
      }
    }
  }
  var f0 = ${e(0,"idx")};
  ${n}
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
    atomicAdd(&force[${Fe}u], 1);
    atomicMax(&force[${Fe+1}u], i32(P.n - idx));
  }
  var ux = (f1 - f3 + f5 - f6 - f7 + f8) / rho;
  var uy = (f2 - f4 + f5 + f6 - f7 - f8) / rho;
  // The limiter: flow squeezed in a gap two moving bodies close has nowhere to go. A cell
  // whose density leaves ±${kt*100} % or whose speed passes ${Mt} (4 x the inflow) is put
  // back to equilibrium inside those bounds. Ordinary flow here stays within about 1 %, so
  // only such pockets are touched; each use is counted and the page says so.
  let usq0 = ux * ux + uy * uy;
  if (!(rho >= ${1-kt} && rho <= ${1+kt} && usq0 <= ${Mt*Mt})) {
    atomicAdd(&force[${Fe+2}u], 1);
    let ok = rho == rho && ux == ux && uy == uy;
    rho = select(1.0, clamp(rho, ${1-kt}, ${1+kt}), ok);
    var uc = select(vec2f(0.0), vec2f(ux, uy), ok);
    let m = length(uc);
    if (m > ${Mt}) { uc = uc * (${Mt} / m); }
    ux = uc.x;
    uy = uc.y;
    drho = rho - 1.0;
${Array.from({length:9},(r,a)=>`    f${a} = feqAt(${a}u, rho, uc) - ${L(ze[a])};`).join(`
`)}
  }
${i}
}
`}function ci(){return`
@group(0) @binding(0) var<storage, read> fin: array<f32>;
@group(0) @binding(1) var<storage, read_write> mac: array<vec4f>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
${zt}
${fn}

@compute @workgroup_size(${Z})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${Z}u;
  if (idx >= P.n) { return; }
  let p = vec2f(f32(idx % P.nx), f32(idx / P.nx));
  var bp: array<vec4f, ${re}>;
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
`}function ui(){return`
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

@compute @workgroup_size(${Z})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${Z}u;
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
`}function di(){return`
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
${zt}
${fn}

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
  var bp: array<vec4f, ${re}>;
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
`}function co(){return[{label:"step",code:Nn()},{label:"patch step",code:Nn(!0)},{label:"macro",code:ci()},{label:"field",code:ui()},{label:"render",code:di()}]}function hi(s){return s==="inferno"?eo:Li(s)}class uo{device;ctx;format;pipe;viewBuf;lutBuf;lutName="";dummyBuf;dummyTex;constructor(e,t){this.device=e;const n=t.getContext("webgpu");if(!n)throw new Error("The canvas has no WebGPU context.");this.ctx=n,this.format=navigator.gpu.getPreferredCanvasFormat(),n.configure({device:e,format:this.format,alphaMode:"opaque"});const i=e.createShaderModule({code:di(),label:"tunnel render"});this.pipe=e.createRenderPipeline({layout:"auto",vertex:{module:i,entryPoint:"vs"},fragment:{module:i,entryPoint:"fs",targets:[{format:this.format}]},primitive:{topology:"triangle-list"}}),this.viewBuf=e.createBuffer({size:336,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.lutBuf=e.createBuffer({size:256*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.dummyBuf=e.createBuffer({size:64,usage:GPUBufferUsage.STORAGE}),this.dummyTex=e.createTexture({size:[1,1],format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING})}setColormap(e){if(e===this.lutName)return;const t=hi(e),n=t.length/3,i=new Float32Array(256*4);for(let o=0;o<256;o++){const r=Math.min(n-1,Math.round(o/255*(n-1)));i[4*o]=t[3*r]/255,i[4*o+1]=t[3*r+1]/255,i[4*o+2]=t[3*r+2]/255,i[4*o+3]=1}this.device.queue.writeBuffer(this.lutBuf,0,i),this.lutName=e}get lut(){return this.lutBuf}get dummies(){return{scalar:this.dummyBuf,lut:this.lutBuf}}get size(){const e=this.ctx.getCurrentTexture();return{w:e.width,h:e.height}}encode(e,t,n,i,o,r,a){const c=t.buffers,l=this.device.createBindGroup({layout:this.pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:c.scalar}},{binding:1,resource:{buffer:this.viewBuf}},{binding:2,resource:{buffer:c.params}},{binding:3,resource:{buffer:c.bodies}},{binding:4,resource:{buffer:c.sdf}},{binding:5,resource:{buffer:this.lutBuf}},{binding:6,resource:{buffer:t.macroBuf}},{binding:7,resource:{buffer:r.dye??this.dummyBuf}},{binding:8,resource:(r.trail??this.dummyTex).createView()},{binding:9,resource:{buffer:r.rheo?.field??this.dummyBuf}},{binding:10,resource:{buffer:r.patch?.scalar??this.dummyBuf}}]}),u=(r.plain?1:0)|(r.arrows?2:0)|(r.dye?4:0)|(r.trail?8:0)|(r.rheo?16:0),h=new ArrayBuffer(336),d=new Float32Array(h),f=new Uint32Array(h);d.set([n.scale,n.ox,n.oy,i.lo,i.hi,t.nx,t.ny,t.absorbInX,t.spongeX,r.uRef,r.arrowCells]),f[11]=u,d.set([...o.bg,1],12),d.set([...o.body,1],16),d.set([...o.edge,1],20),d.set(o.zone,24),d.set([...o.plain,1],28),d.set(o.arrow,32);for(let p=0;p<4;p++)d.set(r.dyeColors[p]??[0,0,0,0],36+4*p);if(r.rheo){const p=r.rheo.look;d.set([...p.base,1],52),d.set([...p.l1.dir,0],56),d.set([...p.l1.color,p.l1.diffuse],60),d.set([...p.l2.dir,0],64),d.set([...p.l2.color,p.l2.diffuse],68),d.set([p.sharp,r.rheo.sparkle[0],r.rheo.sparkle[1],p.glint],72)}if(r.patch){const p=r.patch;d.set([p.x0,p.y0,p.x1,p.y1,p.scale,p.nx,p.ny,1],76)}this.device.queue.writeBuffer(this.viewBuf,0,h);const y=e.beginRenderPass({colorAttachments:[{view:this.ctx.getCurrentTexture().createView(),loadOp:"clear",storeOp:"store",clearValue:{r:o.bg[0],g:o.bg[1],b:o.bg[2],a:1}}]});y.setPipeline(this.pipe),y.setBindGroup(0,l),y.draw(3),a?.(y),y.end()}destroy(){this.viewBuf.destroy(),this.lutBuf.destroy(),this.dummyBuf.destroy(),this.dummyTex.destroy(),this.ctx.unconfigure()}}const xs=256*1024,ho=80,Ln=10,qn=1e3;class Be extends Error{}function fo(s){const e=s.trim().split(/[\s,;]+/).filter(Boolean),t=[];for(const n of e){const i=Number(n.replace(/[Dd]/,"e"));if(n===""||Number.isNaN(i))return null;t.push(i)}return t}function Mn(s){return s.replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,ho)}const Gn=(s,e)=>s.flatMap((t,n)=>[t,e[n]]);function po(s,e=""){if(new TextEncoder().encode(s).length>xs)throw new Be(`The file is larger than ${xs/1024} KB; an airfoil file is a few KB.`);const t=s.replace(/^﻿/,"").split(/\r\n|\r|\n/);let n="";const i=[];let o=!1;if(t.forEach((h,d)=>{const f=d+1,y=h.trim();if(!y||y.startsWith("#"))return;const p=fo(y);if(!o&&!n&&(p===null||p.length!==2)){n=Mn(y);return}if(p===null)throw new Be(`Line ${f}: expected two numbers (x and y), found “${Mn(y).slice(0,40)}”.`);if(p.length!==2)throw new Be(`Line ${f}: expected two numbers (x and y), found ${p.length}.`);if(!p.every(Number.isFinite))throw new Be(`Line ${f}: the numbers must be finite.`);i.push([f,p[0],p[1]]),o=!0}),!n){const h=String(e||"").replace(/\\/g,"/").split("/").pop()?.replace(/\.[A-Za-z0-9]{1,4}$/,"")??"";n=Mn(h)||"Imported airfoil"}if(!i.length)throw new Be("The file has no coordinates.");const r=[],a=i[0];let c,l,u;return a[1]>=2&&a[2]>=2&&Number.isInteger(a[1])&&Number.isInteger(a[2])?([c,l]=mo(i,a[1],a[2]),u="lednicer",r.push("Read as a Lednicer file (upper and lower surfaces apart) and joined in Selig order.")):(c=i.map(h=>h[1]),l=i.map(h=>h[2]),u="selig"),[c,l]=yo(c,l,r),{name:n,x:c,y:l,layout:u,warnings:r}}function mo(s,e,t){const n=s.slice(1);if(n.length!==e+t)throw new Be(`Line ${s[0][0]}: the file says ${e} upper and ${t} lower points, but it has ${n.length} points.`);const i=n.slice(0,e),o=n.slice(e),r=i.map(u=>u[1]).reverse(),a=i.map(u=>u[2]).reverse();let c=o.map(u=>u[1]),l=o.map(u=>u[2]);return o.length&&i.length&&Math.abs(o[0][1]-i[0][1])<=1e-9&&Math.abs(o[0][2]-i[0][2])<=1e-9&&(c=c.slice(1),l=l.slice(1)),[[...r,...c],[...a,...l]]}function yo(s,e,t){let n=[s[0]],i=[e[0]],o=0;for(let f=1;f<s.length;f++){if(Math.abs(s[f]-n[n.length-1])<=1e-12&&Math.abs(e[f]-i[i.length-1])<=1e-12){o++;continue}n.push(s[f]),i.push(e[f])}if(o&&t.push(`Removed ${o} repeated point${o!==1?"s":""}.`),n.length<Ln)throw new Be(`The file has ${n.length} points; an airfoil needs at least ${Ln}.`);if(n.length>qn)throw new Be(`The file has ${n.length} points; at most ${qn} are read.`);const r=Math.min(...n),c=Math.max(...n)-r;if(c<=0)throw new Be("Every point has the same x: this is not an airfoil.");const l=n.indexOf(r);if(l===0||l===n.length-1)throw new Be("The points must start at the trailing edge, run over one surface to the leading edge and back along the other (Selig order).");if(Math.min(n[0],n[n.length-1])<r+.5*c)throw new Be("The first and last points must be at the trailing edge (Selig order).");const u=n[l],h=i[l],d=Math.min(...n.map((f,y)=>Math.hypot(f,i[y])))<=.002;if((Math.abs(c-1)>.001||!d)&&(n=n.map(f=>(f-u)/c),i=i.map(f=>(f-h)/c),t.push(Math.abs(c-1)>.001?`Scaled to chord 1 (it was ${Number(c.toPrecision(6))}).`:"Moved so that the leading edge is at (0, 0).")),Ls(Gn(n,i))<0&&(n=n.reverse(),i=i.reverse(),t.push("The points ran over the lower surface first; reversed to Selig order (upper surface first).")),nr(Gn(n,i)))throw new Be("The outline crosses itself.");if(go(n,i)<.002)throw new Be("The section is thinner than 0.2 % of its chord.");return[n,i]}function go(s,e){const t=Gn(s,e);let n=0;for(let i=1;i<50;i++){const o=i/50,r=[],a=t.length/2;for(let c=0;c<a;c++){const l=(c+1)%a,[u,h,d,f]=[t[2*c],t[2*c+1],t[2*l],t[2*l+1]];u>o!=d>o&&r.push(h+(o-u)*(f-h)/(d-u))}r.length>=2&&(n=Math.max(n,Math.max(...r)-Math.min(...r)))}return n}const Jt=5,yt={air:{label:"Air (20 °C)",nu:1516e-8,rho:1.204},water:{label:"Water (20 °C)",nu:1004e-9,rho:998.2}},Q={length:[.01,1e3],height:[.005,1e3],speed:[1e-4,340],maxBodies:8,maxRakes:8,maxDyeRakes:4,emitters:[1,64]},an=6;let gt=0;function pn(){return gt=(gt+1)%1e6,`b${Date.now().toString(36)}${gt.toString(36)}`}function fi(){return gt=(gt+1)%1e6,`r${Date.now().toString(36)}${gt.toString(36)}`}function Et(){return{version:Jt,tunnel:{length:8,height:4,walls:"farfield",resolution:"auto",refine:0},flow:{speed:10,fluid:"air",model:"auto"},bodies:[{id:pn(),name:"NACA 2412",shape:{kind:"naca",code:"2412",chord:1},x:2.5,y:2,angle:6,spin:0,enabled:!0,locked:!1}],rakes:[],view:{field:"particles",autoRange:!0,min:-10,max:10,speed:"max",tracers:!1,density:"normal",trail:"short",arrows:!1,streamlines:!1,rheoPreset:"kalliroscope",particleColor:"speed"},preset:null}}const xo=1e5;function bs(s){if(s.flow.model!=="auto")return s.flow.model==="sa"?"sa":"off";const e=yt[s.flow.fluid].nu;return Math.max(0,...s.bodies.filter(n=>n.enabled).map(n=>s.flow.speed*Se(n.shape)/e))>=xo?"sa":"off"}class nt extends Error{}const ee=(s,e,t=-1/0,n=1/0)=>{const i=Number(s);if(!Number.isFinite(i)||i<t||i>n)throw new nt(`${e} must be a number from ${t} to ${n}.`);return i},Ue=(s,e,t)=>e.includes(s)?s:t;function bo(s){const e=s??{},t={},n=e.points&&typeof e.points=="object"?e.points:{},i=Object.keys(n);if(i.length>5e3)throw new nt("A sketch may have at most 5,000 points.");for(const c of i){const l=n[c];if(!Array.isArray(l)||l.length!==2||!l.every(u=>Number.isFinite(Number(u))))throw new nt(`Sketch point ${c} is not two numbers.`);t[c]=[Number(l[0]),Number(l[1])]}const o=Array.isArray(e.entities)?e.entities:[],r=Array.isArray(e.constraints)?e.constraints:[];if(o.length>5e3||r.length>1e4)throw new nt("That sketch is too large.");const a=c=>typeof c=="string"&&(c in t||c==="origin");for(const c of o){const l=c?.kind==="line"?c.p??[]:c?.kind==="circle"?[c.c]:c?.kind==="arc"?[c.c,c.a,c.b]:c?.kind==="point"?[c.p]:c?.kind==="spline"?c.pts??[]:[null];if(typeof c?.id!="string"||!Array.isArray(l)||!l.every(a))throw new nt(`Sketch entity ${String(c?.id)} refers to points that are not in the sketch.`)}return{points:t,entities:o,constraints:r}}function vo(s){const e=s??{};switch(e.kind){case"naca":return{kind:"naca",code:jn(String(e.code)),chord:ee(e.chord,"Chord",1e-4,1e3)};case"dat":{const t=Array.isArray(e.x)?e.x.map(Number):[],n=Array.isArray(e.y)?e.y.map(Number):[];if(t.length!==n.length||t.length<Ln||t.length>qn||![...t,...n].every(Number.isFinite))throw new nt("An imported airfoil needs matching x and y lists of finite numbers.");return{kind:"dat",name:String(e.name??"Imported airfoil").slice(0,80),x:t,y:n,chord:ee(e.chord,"Chord",1e-4,1e3)}}case"circle":return{kind:"circle",diameter:ee(e.diameter,"Diameter",1e-4,1e3)};case"rect":return{kind:"rect",width:ee(e.width,"Width",1e-4,1e3),height:ee(e.height,"Height",1e-4,1e3)};case"ellipse":return{kind:"ellipse",width:ee(e.width,"Width",1e-4,1e3),height:ee(e.height,"Height",1e-4,1e3)};case"plate":return{kind:"plate",length:ee(e.length,"Length",1e-4,1e3),thickness:ee(e.thickness,"Thickness",1e-5,1e3)};case"sketch":return{kind:"sketch",name:String(e.name??"Sketch").slice(0,80),sketch:bo(e.sketch)};default:throw new nt(`Unknown body shape “${String(e.kind)}”.`)}}function wo(s){const e=s??{},t=Number(e.version??Jt);if(t>Jt)throw new nt(`This tunnel was saved by a newer version of the plugin (scene version ${t}).`);const n=Et(),i=e.tunnel??{},o=e.flow??{},r=e.view??{},a=(Array.isArray(e.bodies)?e.bodies:[]).slice(0,Q.maxBodies).map(l=>({id:typeof l?.id=="string"&&l.id?l.id.slice(0,40):pn(),name:String(l?.name??"Body").slice(0,80),shape:vo(l?.shape),x:ee(l?.x,"Body x"),y:ee(l?.y,"Body y"),angle:ee(l?.angle??0,"Body angle",-3600,3600),spin:ee(l?.spin??0,"Body spin",-1e4,1e4),enabled:l?.enabled!==!1,locked:l?.locked===!0})),c=(Array.isArray(e.rakes)?e.rakes:[]).slice(0,Q.maxRakes).map((l,u)=>({id:typeof l?.id=="string"&&l.id?l.id.slice(0,40):fi(),kind:Ue(l?.kind,["streaks","timelines","dye"],"streaks"),x0:ee(l?.x0,"Rake x"),y0:ee(l?.y0,"Rake y"),x1:ee(l?.x1,"Rake x"),y1:ee(l?.y1,"Rake y"),emitters:Math.round(ee(l?.emitters??12,"Rake emitters",...Q.emitters)),color:Math.round(ee(l?.color??u%an,"Rake colour",0,an-1)),enabled:l?.enabled!==!1}));return{version:Jt,tunnel:{length:ee(i.length??n.tunnel.length,"Tunnel length",...Q.length),height:ee(i.height??n.tunnel.height,"Tunnel height",...Q.height),walls:Ue(i.walls,["farfield","slip","noslip","periodic"],n.tunnel.walls),resolution:Ue(i.resolution,["auto","low","medium","high","ultra"],n.tunnel.resolution),refine:[0,1,2].find(l=>l===Number(i.refine))??n.tunnel.refine},flow:{speed:ee(o.speed??n.flow.speed,"Wind speed",...Q.speed),fluid:Ue(o.fluid,["air","water"],n.flow.fluid),model:Ue(o.model,["auto","resolved","sa"],n.flow.model)},bodies:a,rakes:c,view:{field:Ue(r.field,["particles","vorticity","speed","pressure","schlieren","rheoscopic","none"],n.view.field),autoRange:r.autoRange!==!1,min:Number.isFinite(Number(r.min))?Number(r.min):n.view.min,max:Number.isFinite(Number(r.max))?Number(r.max):n.view.max,speed:Ue(r.speed,["max","realtime"],n.view.speed),tracers:r.tracers===!0,density:Ue(r.density,["low","normal","high"],n.view.density),trail:Ue(r.trail,["off","short","long"],n.view.trail),arrows:r.arrows===!0,streamlines:r.streamlines===!0,rheoPreset:Ue(r.rheoPreset,["kalliroscope","pearl","copper"],n.view.rheoPreset),particleColor:Ue(r.particleColor,["speed","vorticity"],n.view.particleColor)},preset:typeof e.preset=="string"&&e.preset?e.preset.slice(0,40):null}}const ko=3,Mo=48,vs=2.5,Jn=`
struct G { nx: u32, ny: u32, dt: f32, sign: f32, nsrc: u32, r: f32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<uniform> Gd: G;
`,pi=`
fn idx(i: i32, j: i32) -> u32 { return u32(clamp(i, 0, i32(Gd.nx) - 1)) + u32(clamp(j, 0, i32(Gd.ny) - 1)) * Gd.nx; }
fn bil(c: vec2f) -> vec4f {
  let p = clamp(c, vec2f(0.0), vec2f(f32(Gd.nx) - 1.001, f32(Gd.ny) - 1.001));
  let i = i32(p.x);
  let j = i32(p.y);
  let f = p - vec2f(f32(i), f32(j));
  return mix(mix(src[idx(i, j)], src[idx(i + 1, j)], f.x), mix(src[idx(i, j + 1)], src[idx(i + 1, j + 1)], f.x), f.y);
}
`,mi=()=>`${Jn}
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec4f>;
${pi}
@compute @workgroup_size(${Z})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${Z}u;
  if (k >= Gd.nx * Gd.ny) { return; }
  let m = mac[k];
  if (m.w > 0.5) { dst[k] = vec4f(0.0); return; }
  let p = vec2f(f32(k % Gd.nx), f32(k / Gd.nx));
  dst[k] = bil(p - Gd.sign * Gd.dt * m.xy);
}
`,yi=()=>`${Jn}
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read> fwd: array<vec4f>;
@group(0) @binding(4) var<storage, read> back: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> dst: array<vec4f>;
${pi}
@compute @workgroup_size(${Z})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${Z}u;
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
`,gi=()=>`${Jn}
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
`;class Po{device;nx;ny;bufs;cur=0;advect;correct;inject;unis=[];srcBuf;srcCount=0;srcKey="";constructor(e,t,n){this.device=e,this.nx=t,this.ny=n;const i=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.bufs=[0,1,2,3].map(()=>e.createBuffer({size:t*n*16,usage:i}));const o=(r,a)=>e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:r,label:a}),entryPoint:"main"}});this.advect=o(mi(),"dye advect"),this.correct=o(yi(),"dye correct"),this.inject=o(gi(),"dye inject"),this.srcBuf=e.createBuffer({size:16*512,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.unis=[0,1].map(()=>e.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}))}get field(){return this.bufs[this.cur]}setSources(e){const t=e.map(r=>`${r.x.toFixed(2)},${r.y.toFixed(2)},${r.channel}`).join("|");if(t===this.srcKey)return;this.srcKey=t;const n=new ArrayBuffer(16*Math.min(512,e.length)),i=new Float32Array(n),o=new Uint32Array(n);e.slice(0,512).forEach((r,a)=>{i[4*a]=r.x,i[4*a+1]=r.y,o[4*a+2]=r.channel}),n.byteLength&&this.device.queue.writeBuffer(this.srcBuf,0,n),this.srcCount=Math.min(512,e.length)}clear(){for(const e of this.bufs)this.device.queue.writeBuffer(e,0,new Float32Array(this.nx*this.ny*4))}uniform(e,t,n){const i=new ArrayBuffer(32),o=new Uint32Array(i),r=new Float32Array(i);o[0]=this.nx,o[1]=this.ny,r[2]=t,r[3]=n,o[4]=this.srcCount,r[5]=vs;const a=this.unis[e];return this.device.queue.writeBuffer(a,0,i),a}encode(e,t,n){if(t<=0||this.srcCount===0)return;const i=Math.min(Mo,Math.max(1,Math.ceil(t*.1/ko))),o=t/i,r=this.uniform(0,o,1),a=this.uniform(1,o,-1),c=this.nx*this.ny,l=Math.ceil(c/Z),u=Math.min(l,32768),h=Math.ceil(l/u),d=(p,m,g)=>this.device.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:n}},{binding:1,resource:{buffer:m}},...g.map((x,w)=>({binding:2+w,resource:{buffer:x}}))]}),f=2*Math.ceil(vs)+1,y=e.beginComputePass({label:"dye"});for(let p=0;p<i;p++){const m=this.bufs[this.cur],[g,x,w]=[1,2,3].map(k=>this.bufs[(this.cur+k)%4]);y.setPipeline(this.advect),y.setBindGroup(0,d(this.advect,r,[m,g])),y.dispatchWorkgroups(u,h),y.setBindGroup(0,d(this.advect,a,[g,x])),y.dispatchWorkgroups(u,h),y.setPipeline(this.correct),y.setBindGroup(0,d(this.correct,r,[m,g,x,w])),y.dispatchWorkgroups(u,h),y.setPipeline(this.inject),y.setBindGroup(0,d(this.inject,r,[this.srcBuf,w])),y.dispatchWorkgroups(Math.ceil(this.srcCount*f*f/64)),this.cur=(this.cur+3)%4}y.end()}async read(){const e=this.device.createBuffer({size:this.nx*this.ny*16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),t=this.device.createCommandEncoder();t.copyBufferToBuffer(this.field,0,e,0,this.nx*this.ny*16),this.device.queue.submit([t.finish()]),await e.mapAsync(GPUMapMode.READ);const n=new Float32Array(e.getMappedRange().slice(0));return e.destroy(),n}destroy(){for(const e of[...this.bufs,this.srcBuf,...this.unis])e.destroy()}}const So=.8,Ao=.12,Bo=160,Ae=8,Pn=1.4,Ro=320,Sn=14,xi=()=>`
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
${zt}
${fn}

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

@compute @workgroup_size(${Z})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * ${Z}u;
  if (i >= Ad.count) { return; }
  var m = pmeta[i];
  if (m.w < 0.5) { return; }
  var q = pos[i].xy;
  var prev = q;
  var gone = false;
  var bp: array<vec4f, ${re}>;
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
`,bi=()=>`
struct D {
  scale: f32, ox: f32, oy: f32, w: f32,
  h: f32, halfW: f32, maxSeg: f32, tail: f32,
  tracer: vec4f,
  colors: array<vec4f, ${Ae}>,
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
  o.c = select(Dr.colors[min(u32(m.z), ${Ae-1}u)], Dr.tracer, m.y < 0.0);
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
`,vi=()=>`
struct D {
  scale: f32, ox: f32, oy: f32, w: f32,
  h: f32, halfW: f32, maxSeg: f32, first: f32,
  colors: array<vec4f, ${Ae}>,
  gaps: array<vec4f, ${Ae}>,
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
  let src = min(u32(ma.y), ${Ae-1}u);
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
  let col = Dr.colors[min(u32(ma.z), ${Ae-1}u)];
  o.c = vec4f(col.rgb, col.a * fade);
  o.d = c.y;
  return o;
}

@fragment
fn fs(i: Out) -> @location(0) vec4f {
  return vec4f(i.c.rgb, i.c.a * clamp((1.0 - abs(i.d)) * 1.6, 0.0, 1.0));
}
`,wi=`
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f { return vec4f(0.0); }
`;class Co{device;pos=null;meta=null;capacity=0;tracers=0;rakes=[];layoutKey="";advectPipe;advectUni;drawPipe;fadePipe;drawUni;linePipe=null;lineUni;seed=1;streakGap=1;fadeSteps=1e4;trail=null;trailKey="";clearTrail=!0;format="rgba16float";constructor(e){this.device=e,this.advectPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:xi(),label:"particles advect"}),entryPoint:"main"}}),this.advectUni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});const t=e.createShaderModule({code:bi(),label:"particles draw"}),n={color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}};this.drawPipe=e.createRenderPipeline({layout:"auto",vertex:{module:t,entryPoint:"vs"},fragment:{module:t,entryPoint:"fs",targets:[{format:this.format,blend:n}]},primitive:{topology:"triangle-list"}});const i=e.createShaderModule({code:wi,label:"trail fade"});this.fadePipe=e.createRenderPipeline({layout:"auto",vertex:{module:i,entryPoint:"vs"},fragment:{module:i,entryPoint:"fs",targets:[{format:this.format,blend:{color:{srcFactor:"zero",dstFactor:"constant",operation:"add"},alpha:{srcFactor:"zero",dstFactor:"constant",operation:"add"}}}]},primitive:{topology:"triangle-list"}}),this.drawUni=e.createBuffer({size:80+16*Ae,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.lineUni=e.createBuffer({size:32+32*Ae,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}encodeRakeLines(e,t,n,i,o,r){if(!this.pos||!this.meta||!this.rakes.length)return;if(!this.linePipe){const u=this.device.createShaderModule({code:vi(),label:"rake lines"});this.linePipe=this.device.createRenderPipeline({layout:"auto",vertex:{module:u,entryPoint:"vs"},fragment:{module:u,entryPoint:"fs",targets:[{format:t,blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-list"}})}const a=new Float32Array(8+8*Ae);a.set([i.scale,i.ox,i.oy,n.w,n.h,.75*r,80*r,this.tracers]),o.slice(0,Ae).forEach((u,h)=>a.set(u,8+4*h));for(const u of this.rakes){const h=8+4*Ae+4*Math.min(u.index,Ae-1);a[h]=u.rake.kind==="streaks"?this.streakGap*2.5:.5,a[h+1]=this.fadeSteps}this.device.queue.writeBuffer(this.lineUni,0,a);const c=this.device.createBindGroup({layout:this.linePipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.pos}},{binding:1,resource:{buffer:this.meta}},{binding:2,resource:{buffer:this.lineUni}}]});e.setPipeline(this.linePipe),e.setBindGroup(0,c);const l=this.capacity-this.tracers-1;l>0&&e.draw(6,l)}get count(){return this.capacity}get tracerCount(){return this.tracers}get buffers(){return this.pos&&this.meta?{pos:this.pos,meta:this.meta}:null}get pools(){return this.rakes.map(e=>({id:e.rake.id,index:e.index,base:e.base,slots:e.slots}))}configure(e,t,n){const i=[];let o=e;t.forEach((d,f)=>{const y=d.kind==="streaks"?Math.ceil(n.nx*1.2*Pn):Ro,p=d.kind==="streaks"?y*d.emitters:y*Sn;i.push({rake:d,index:f,base:o,per:y,slots:p,head:0,acc:0}),o+=p});const r=`${e}|${n.nx}x${n.ny}|${t.map(d=>`${d.id}:${d.kind}:${d.emitters}`).join(",")}`;if(r===this.layoutKey){i.forEach((d,f)=>{this.rakes[f].rake=d.rake});return}this.layoutKey=r,this.rakes=i,this.tracers=e;const a=Math.max(1,o);if(a>this.capacity||!this.pos){this.pos?.destroy(),this.meta?.destroy();const d=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.pos=this.device.createBuffer({size:a*16,usage:d}),this.meta=this.device.createBuffer({size:a*16,usage:d})}this.capacity=a;const c=new Float32Array(a*4),l=new Float32Array(a*4);let u=12345;const h=()=>(u=u*1103515245+12345&2147483647)/2147483647;for(let d=0;d<e;d++){const f=n.absorbInX+h()*(n.outX-n.absorbInX),y=h()*(n.ny-1);c.set([f,y,f,y],4*d),l.set([0,-1,0,1],4*d)}this.device.queue.writeBuffer(this.pos,0,c),this.device.queue.writeBuffer(this.meta,0,l),this.clearTrail=!0}emit(e){if(!(!this.pos||!this.meta||e.steps<=0))for(const t of this.rakes){const{rake:n}=t;if(n.kind==="streaks"){this.streakGap=1/(e.u*Pn),this.fadeSteps=.85*e.nx/e.u,t.acc+=e.u*e.steps*Pn;const i=Math.min(t.per,Math.floor(t.acc));if(t.acc-=i,i<=0)continue;const o=new Float32Array(i*4),r=new Float32Array(i*4);for(let a=0;a<n.emitters;a++){const c=n.emitters===1?.5:a/(n.emitters-1),l=n.x0+(n.x1-n.x0)*c,u=n.y0+(n.y1-n.y0)*c;for(let h=0;h<i;h++)o.set([l,u,l,u],4*h),r.set([-((h+.5)/i)*e.steps,t.index,n.color,1],4*h);this.writeRing(t.base+a*t.per,t.per,t.head,o,r,i)}t.head=(t.head+i)%t.per}else{const i=e.nx*.1/e.u;for(this.fadeSteps=.85*e.nx/e.u,t.acc+=e.steps;t.acc>=i;){t.acc-=i;const o=-Math.max(0,e.steps-t.acc),r=new Float32Array(t.per*4),a=new Float32Array(t.per*4);for(let l=0;l<t.per;l++){const u=l/(t.per-1),h=n.x0+(n.x1-n.x0)*u,d=n.y0+(n.y1-n.y0)*u;r.set([h,d,h,d],4*l),a.set([o,t.index,n.color,1],4*l)}const c=t.head%Sn;this.device.queue.writeBuffer(this.pos,(t.base+c*t.per)*16,r),this.device.queue.writeBuffer(this.meta,(t.base+c*t.per)*16,a),t.head=(t.head+1)%Sn}}}}writeRing(e,t,n,i,o,r){const a=Math.min(r,t-n);this.device.queue.writeBuffer(this.pos,(e+n)*16,i,0,a*4),this.device.queue.writeBuffer(this.meta,(e+n)*16,o,0,a*4),r>a&&(this.device.queue.writeBuffer(this.pos,e*16,i,a*4,(r-a)*4),this.device.queue.writeBuffer(this.meta,e*16,o,a*4,(r-a)*4))}encodeAdvect(e,t,n,i){if(!this.pos||!this.meta||t.steps<=0)return;this.emit(t);const o=Math.min(Bo,Math.max(1,Math.ceil(t.steps*Ao/So))),r=new ArrayBuffer(48),a=new Uint32Array(r),c=new Float32Array(r);a[0]=this.capacity,a[1]=o,c[2]=t.steps/o,a[3]=this.seed=this.seed*1664525+1013904223>>>0,c[4]=t.nx,c[5]=t.ny,c[6]=t.outX,c[7]=t.absorbInX,c[8]=Math.max(1,t.u*t.steps),c[9]=.35*t.nx/t.u,a[10]=t.wrapY?1:0,this.device.queue.writeBuffer(this.advectUni,0,r);const l=this.device.createBindGroup({layout:this.advectPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:n}},{binding:1,resource:{buffer:this.pos}},{binding:2,resource:{buffer:this.meta}},{binding:3,resource:{buffer:i.params}},{binding:4,resource:{buffer:i.bodies}},{binding:5,resource:{buffer:i.sdf}},{binding:6,resource:{buffer:this.advectUni}}]}),u=Math.ceil(this.capacity/Z),h=Math.min(u,32768),d=e.beginComputePass({label:"particles"});d.setPipeline(this.advectPipe),d.setBindGroup(0,l),d.dispatchWorkgroups(h,Math.ceil(u/h)),d.end()}ensureTrail(e,t,n){const i=`${e}x${t}`;(!this.trail||i!==this.trailKey)&&(this.trail?.destroy(),this.trail=this.device.createTexture({size:[e,t],format:this.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),this.trailKey=i,this.clearTrail=!0),n!==this.lastView&&(this.lastView=n,this.clearTrail=!0)}lastView="";encodeDraw(e,t,n,i,o,r,a,c){const l=`${n.scale.toFixed(9)}|${n.ox.toFixed(4)}|${n.oy.toFixed(4)}`;this.ensureTrail(t.w,t.h,l);const u=this.trail.createView(),h=e.beginRenderPass({colorAttachments:[{view:u,loadOp:this.clearTrail?"clear":"load",storeOp:"store",clearValue:{r:0,g:0,b:0,a:0}}]});if(this.clearTrail=!1,h.setPipeline(this.fadePipe),h.setBlendConstant({r:i,g:i,b:i,a:i}),h.draw(3),this.pos&&this.meta&&o.tracers&&this.tracers>0){const d=new Float32Array(20+4*Ae);d.set([n.scale,n.ox,n.oy,t.w,t.h,t.dot,60,t.tail]),d.set(r.tracer,8);const f=12+4*Ae;d.set([a?.lo??0,a?.hi??1,a?1:0,a?.nx??1,a?.lift??0,a?.ny??1,t.taper?1:0,0],f),this.device.queue.writeBuffer(this.drawUni,0,d);const y=this.device.createBindGroup({layout:this.drawPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.pos}},{binding:1,resource:{buffer:this.meta}},{binding:2,resource:{buffer:this.drawUni}},{binding:3,resource:{buffer:a?.scalar??c.scalar}},{binding:4,resource:{buffer:a?.lut??c.lut}}]});h.setPipeline(this.drawPipe),h.setBindGroup(0,y),h.draw(6,this.tracers)}h.end()}async read(){if(!this.pos||!this.meta)return null;const e=this.capacity*16,t=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),n=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),i=this.device.createCommandEncoder();i.copyBufferToBuffer(this.pos,0,t,0,e),i.copyBufferToBuffer(this.meta,0,n,0,e),this.device.queue.submit([i.finish()]),await Promise.all([t.mapAsync(GPUMapMode.READ),n.mapAsync(GPUMapMode.READ)]);const o={pos:new Float32Array(t.getMappedRange().slice(0)),meta:new Float32Array(n.getMappedRange().slice(0))};return t.destroy(),n.destroy(),o}clear(){this.clearTrail=!0,this.layoutKey=""}destroy(){this.pos?.destroy(),this.meta?.destroy(),this.trail?.destroy(),this.advectUni.destroy(),this.drawUni.destroy(),this.lineUni.destroy()}}const An=96,$o=.25,To=24,ki=()=>`
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

@compute @workgroup_size(${Z})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${Z}u;
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
  let sub = u32(clamp(ceil(rate * Rp.dt / ${$o}), 1.0, ${To}.0));
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
`;class Eo{device;nx;ny;bufs;cur=0;pipe;uni;frame=0;seed=7;constructor(e,t,n){this.device=e,this.nx=t,this.ny=n;const i=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;this.bufs=[e.createBuffer({size:t*n*32,usage:i}),e.createBuffer({size:t*n*32,usage:i})],this.pipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:ki(),label:"rheoscopic"}),entryPoint:"main"}}),this.uni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.reset()}reset(){const e=new Float32Array(this.nx*this.ny*8);let t=99;const n=()=>(t=t*1103515245+12345&2147483647)/2147483647;for(let i=0;i<this.nx*this.ny;i++)e.set([1/3,1/3,1/3,0,0,0,n(),n()],8*i);this.device.queue.writeBuffer(this.bufs[0],0,e),this.device.queue.writeBuffer(this.bufs[1],0,e),this.frame=0}get field(){return this.bufs[this.cur]}get sparkleWeights(){const e=this.frame%An/An,t=Math.sin(Math.PI*e)**2;return[t,1-t]}encode(e,t,n,i){if(t<=0)return;const o=new ArrayBuffer(48),r=new Uint32Array(o),a=new Float32Array(o);r[0]=this.nx,r[1]=this.ny,r[2]=this.frame,r[3]=this.seed=this.seed*1664525+1013904223>>>0,a[4]=t,a[5]=1/Math.max(1,i.depthCells),a[6]=1/Math.max(1,i.relaxSteps),a[7]=i.inletX,r[8]=An,this.device.queue.writeBuffer(this.uni,0,o);const c=this.device.createBindGroup({layout:this.pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:n}},{binding:1,resource:{buffer:this.bufs[this.cur]}},{binding:2,resource:{buffer:this.bufs[this.cur^1]}},{binding:3,resource:{buffer:this.uni}}]}),l=this.nx*this.ny,u=Math.ceil(l/Z),h=Math.min(u,32768),d=e.beginComputePass({label:"rheoscopic"});d.setPipeline(this.pipe),d.setBindGroup(0,c),d.dispatchWorkgroups(h,Math.ceil(u/h)),d.end(),this.cur^=1,this.frame++}async read(){const e=this.nx*this.ny*32,t=this.device.createBuffer({size:e,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),n=this.device.createCommandEncoder();n.copyBufferToBuffer(this.field,0,t,0,e),this.device.queue.submit([n.finish()]),await t.mapAsync(GPUMapMode.READ);const i=new Float32Array(t.getMappedRange().slice(0));return t.destroy(),i}destroy(){this.bufs[0].destroy(),this.bufs[1].destroy(),this.uni.destroy()}}const Pt=1024,ws=512,Mi=`
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
`,Pi=`
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
`;class _o{device;verts;trace;draw;traceUni;drawUni;lines=0;constructor(e,t){this.device=e,this.verts=e.createBuffer({size:ws*Pt*16,usage:GPUBufferUsage.STORAGE}),this.trace=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:Mi,label:"streamlines trace"}),entryPoint:"main"}});const n=e.createShaderModule({code:Pi,label:"streamlines draw"});this.draw=e.createRenderPipeline({layout:"auto",vertex:{module:n,entryPoint:"vs"},fragment:{module:n,entryPoint:"fs",targets:[{format:t,blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-list"}}),this.traceUni=e.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.drawUni=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}get count(){return this.lines}encodeTrace(e,t,n,i,o){this.lines=Math.max(1,Math.min(ws,Math.floor(o)));const r=new ArrayBuffer(32),a=new Float32Array(r),c=new Uint32Array(r);a[0]=n.nx,a[1]=n.ny,c[2]=this.lines,c[3]=Pt,a[4]=i,a[5]=0,a[6]=(n.ny-1)/this.lines,a[7]=Math.max(.5,n.nx*1.4/Pt),this.device.queue.writeBuffer(this.traceUni,0,r);const l=this.device.createBindGroup({layout:this.trace.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:this.verts}},{binding:2,resource:{buffer:this.traceUni}}]}),u=e.beginComputePass({label:"streamlines"});u.setPipeline(this.trace),u.setBindGroup(0,l),u.dispatchWorkgroups(Math.ceil(this.lines/64)),u.end()}encodeDraw(e,t,n,i,o){if(!this.lines)return;this.device.queue.writeBuffer(this.drawUni,0,new Float32Array([n.scale,n.ox,n.oy,t.w,t.h,.6*o,Pt,0,...i]));const r=this.device.createBindGroup({layout:this.draw.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.verts}},{binding:1,resource:{buffer:this.drawUni}}]});e.setPipeline(this.draw),e.setBindGroup(0,r),e.draw(6,this.lines*(Pt-1))}destroy(){this.verts.destroy(),this.traceUni.destroy(),this.drawUni.destroy()}}const Bn={particles:0,vorticity:0,speed:1,pressure:2,schlieren:3,rheoscopic:1,none:1},Rn=4;class bt{nx;ny;n;config;device;f;cur=0;paramsBuf;params=new ArrayBuffer(64);bodiesBuf;bodyData=new ArrayBuffer(re*64);sdfBuf;sdfKey="";sdfOffsets=[];forceBuf;staging=[];stepPipe;stepPipeKey="";pipes=new Map;stepBG=null;slotBGs=[];slotBuf;macroPipe;fieldPipe;stepModule;aux=null;auxDummy;mom=null;momDummy;children=[];macroBuf;scalarBuf;fieldUni;sampledBuf;sampledRead;sampledBusy=!1;sampleW;sampleH;bodies=[];physics={u:.05,tau:.6,smagorinsky:!1,smagCs:.1};groups;destroyed=!1;stepsDone=0;constructor(e,t){this.device=e,this.config={profile:0,absorbing:!t.patch,patch:!1,...t},this.nx=t.nx,this.ny=t.ny,this.n=t.nx*t.ny;const n=GPUBufferUsage,i=9*this.n*4;this.f=[e.createBuffer({size:i,usage:n.STORAGE|n.COPY_DST}),e.createBuffer({size:i,usage:n.STORAGE|n.COPY_DST})],this.paramsBuf=e.createBuffer({size:64,usage:n.UNIFORM|n.COPY_DST}),this.bodiesBuf=e.createBuffer({size:re*64,usage:n.STORAGE|n.COPY_DST}),this.sdfBuf=e.createBuffer({size:16,usage:n.STORAGE|n.COPY_DST}),this.forceBuf=e.createBuffer({size:kn*4,usage:n.STORAGE|n.COPY_SRC|n.COPY_DST}),this.slotBuf=e.createBuffer({size:Ne*256,usage:n.UNIFORM|n.COPY_DST}),this.auxDummy=[e.createBuffer({size:16,usage:n.STORAGE}),e.createBuffer({size:16,usage:n.STORAGE})],this.momDummy=[e.createBuffer({size:16,usage:n.STORAGE}),e.createBuffer({size:16,usage:n.STORAGE})];const o=new Uint32Array(Ne*64);for(let a=0;a<Ne;a++)o[a*64]=a;e.queue.writeBuffer(this.slotBuf,0,o),this.macroBuf=e.createBuffer({size:this.n*16,usage:n.STORAGE|n.COPY_SRC}),this.scalarBuf=e.createBuffer({size:this.n*4,usage:n.STORAGE}),this.fieldUni=e.createBuffer({size:48,usage:n.UNIFORM|n.COPY_DST}),this.sampleW=Math.ceil(this.nx/Rn),this.sampleH=Math.ceil(this.ny/Rn),this.sampledBuf=e.createBuffer({size:this.sampleW*this.sampleH*4,usage:n.STORAGE|n.COPY_SRC}),this.sampledRead=e.createBuffer({size:this.sampleW*this.sampleH*4,usage:n.MAP_READ|n.COPY_DST}),this.stepModule=e.createShaderModule({code:Nn(this.config.patch),label:this.config.patch?"tunnel patch step":"tunnel step"}),this.macroPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:ci(),label:"tunnel macro"}),entryPoint:"main"}}),this.fieldPipe=e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:ui(),label:"tunnel field"}),entryPoint:"main"}});const r=Math.ceil(this.n/Z);this.groups=[Math.min(r,32768),Math.ceil(r/Math.min(r,32768))],this.writeBodies(),this.reset()}reset(e=this.physics.u){const t=new Float32Array(9*this.n),n=1.5*e*e;for(let i=0;i<9;i++){const o=3*[0,1,0,-1,0,1,-1,-1,1][i]*e;t.fill(ze[i]*(o+.5*o*o-n),i*this.n,(i+1)*this.n)}this.device.queue.writeBuffer(this.f[0],0,t),this.device.queue.writeBuffer(this.f[1],0,t),this.resetAux(e),this.stepsDone=0}resetAux(e=this.physics.u){if(!this.aux)return;const t=new Float32Array(4*this.n),n=this.physics.nuMol??0,i=Math.max(n,this.physics.nuFloor??0);for(let o=0;o<this.n;o++)t[4*o]=e,t[4*o+2]=3*n,t[4*o+3]=i;this.device.queue.writeBuffer(this.aux[0],0,t),this.device.queue.writeBuffer(this.aux[1],0,t)}get refining(){return this.config.patch||this.children.length>0}setPatches(e){const t=this.refining;this.children=e,this.refining!==t&&this.setPhysics(this.physics,!0)}get patches(){return this.children}gen=0;swapCur(){this.cur^=1}get levelBuffers(){return{f:this.f,aux:this.aux??this.auxDummy,mom:this.mom??this.momDummy,cur:this.cur}}setPhysics(e,t=!1){this.physics=e;const n=e.turb??"off",i=n!=="off"||this.refining;if(this.refining&&!this.mom){const a=()=>this.device.createBuffer({size:16*this.n,usage:GPUBufferUsage.STORAGE});this.mom=[a(),a()],this.stepBG=null,this.gen++}else if(!this.refining&&this.mom){for(const a of this.mom)a.destroy();this.mom=null,this.stepBG=null,this.gen++}if(i&&!this.aux){const a=GPUBufferUsage;this.aux=[this.device.createBuffer({size:16*this.n,usage:a.STORAGE|a.COPY_DST|a.COPY_SRC}),this.device.createBuffer({size:16*this.n,usage:a.STORAGE|a.COPY_DST|a.COPY_SRC})],this.resetAux(),this.stepBG=null,this.gen++}else if(!i&&this.aux){for(const a of this.aux)a.destroy();this.aux=null,this.stepBG=null,this.gen++}const o=e.bulkKeep??0,r=this.pipeKey(e.smagorinsky,n,o);(r!==this.stepPipeKey||t)&&(this.stepPipe=this.pipes.get(r)??this.device.createComputePipeline(this.pipeDesc(e.smagorinsky,n,o)),this.pipes.set(r,this.stepPipe),this.warmOther(e.smagorinsky,n,o),this.stepPipeKey=r,this.stepBG=null,this.slotBGs=[],this.gen++)}pipeKey(e,t,n){return`${this.config.walls}|${e}|${t}|${n}|${this.config.patch}|${this.refining}`}pipeDesc(e,t,n){return{layout:"auto",compute:{module:this.stepModule,entryPoint:"step",constants:{WALLS:so[this.config.walls],SMAG:e?1:0,TURB:io[t],KEEP_BULK:n,PATCH:this.config.patch?1:0,AUXW:this.refining?1:0,MOMW:this.refining?1:0}}}}warmOther(e,t,n){const i=t==="sa"?[[!1,"off"],[!0,"off"]]:[[!1,"sa"]];t!=="sa"&&i.push([!e,"off"]);for(const[o,r]of i){const a=this.pipeKey(o,r,n);this.pipes.has(a)||(this.pipes.set(a,null),this.device.createComputePipelineAsync(this.pipeDesc(o,r,n)).then(c=>{this.pipes.get(a)===null&&this.pipes.set(a,c)}).catch(()=>this.pipes.delete(a)))}}writeParams(e){const t=new Uint32Array(this.params),n=new Float32Array(this.params),i=this.physics;t[0]=this.nx,t[1]=this.ny,t[2]=this.n,t[3]=this.bodies.length,n[4]=1/i.tau,n[5]=18*Math.SQRT2*i.smagCs*i.smagCs,n[6]=i.u,n[7]=this.config.absorbing||this.config.walls==="farfield"?.05:0,n[8]=this.config.absorbing?this.absorbInX:-1,n[9]=this.spongeX,t[10]=Math.max(1,e),t[11]=this.config.profile,n[12]=this.config.walls==="farfield"?Math.max(4,this.ny*.06):0,n[13]=i.nuMol??0,n[14]=i.nuFloor??0,n[15]=3*(i.nuMol??0),this.device.queue.writeBuffer(this.paramsBuf,0,this.params)}get absorbInX(){return this.config.absorbing?this.nx*.05:-1}get spongeX(){return this.config.patch?1e9:this.nx*.85}setBodies(e){if(e.length>re)throw new Error(`At most ${re} bodies are in the flow at once.`);this.bodies=e;const t=e.map(n=>n.key).join("|");if(t!==this.sdfKey){const n=Math.max(4,e.reduce((o,r)=>o+r.sdf.data.length,0));this.sdfBuf.size<n*4&&(this.sdfBuf.destroy(),this.sdfBuf=this.device.createBuffer({size:n*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.stepBG=null,this.renderBGDirty=!0),this.sdfOffsets=[];let i=0;for(const o of e)this.sdfOffsets.push(i),this.device.queue.writeBuffer(this.sdfBuf,i*4,o.sdf.data),i+=o.sdf.data.length;this.sdfKey=t}this.writeBodies()}renderBGDirty=!1;writeBodies(){const e=new Float32Array(this.bodyData),t=new Uint32Array(this.bodyData);this.bodies.forEach((n,i)=>{const o=i*16;e[o]=n.from.x,e[o+1]=n.from.y,e[o+2]=n.to.x,e[o+3]=n.to.y,e[o+4]=n.from.theta,e[o+5]=n.to.theta,e[o+6]=n.sdf.bound,e[o+7]=n.sdf.texel,e[o+8]=n.sdf.ox,e[o+9]=n.sdf.oy,t[o+10]=n.sdf.w,t[o+11]=n.sdf.h,t[o+12]=this.sdfOffsets[i]??0,e[o+13]=n.sdf.band}),this.device.queue.writeBuffer(this.bodiesBuf,0,this.bodyData)}get buffers(){return{params:this.paramsBuf,bodies:this.bodiesBuf,sdf:this.sdfBuf,scalar:this.scalarBuf}}bindGroups(){if(!this.stepBG){const e=this.stepPipe.getBindGroupLayout(0),t=this.aux??this.auxDummy,n=this.mom??this.momDummy,i=(o,r,a,c,l)=>this.device.createBindGroup({layout:e,entries:[{binding:0,resource:{buffer:o}},{binding:1,resource:{buffer:r}},{binding:2,resource:{buffer:this.paramsBuf}},{binding:3,resource:{buffer:this.bodiesBuf}},{binding:4,resource:{buffer:this.sdfBuf}},{binding:5,resource:{buffer:this.forceBuf}},{binding:6,resource:{buffer:a}},{binding:7,resource:{buffer:c}},{binding:8,resource:{buffer:l}}]});this.stepBG=[i(this.f[0],this.f[1],t[0],t[1],n[1]),i(this.f[1],this.f[0],t[1],t[0],n[0])]}if(!this.slotBGs.length){const e=this.stepPipe.getBindGroupLayout(1);for(let t=0;t<Ne;t++)this.slotBGs.push(this.device.createBindGroup({layout:e,entries:[{binding:0,resource:{buffer:this.slotBuf,offset:t*256,size:16}}]}))}return this.stepBG}get maxFrameSteps(){return Math.floor(Ne/this.depthFactor)}get depthFactor(){return this.children.reduce((e,t)=>Math.max(e,2*t.fine.depthFactor),1)}beginFrame(e,t){this.writeParams(Math.max(1,t)),this.writeBodies(),this.bindGroups(),t>0&&(e.clearBuffer(this.forceBuf,0,Math.min(kn*4,t*re*8)),e.clearBuffer(this.forceBuf,Fe*4,16));for(const n of this.children)n.fine.beginFrame(e,2*t)}get edgeLayout(){return this.stepPipe.getBindGroupLayout(2)}encodeStep(e,t,n){const i=this.bindGroups();if(e.setPipeline(this.stepPipe),e.setBindGroup(0,i[this.cur]),e.setBindGroup(1,this.slotBGs[t]),this.config.patch){if(!n)throw new Error("A patch steps with its edge group.");e.setBindGroup(2,n)}e.dispatchWorkgroups(this.groups[0],this.groups[1]),this.cur^=1,this.stepsDone++;for(const o of this.children)o.encodeCoupled(e,t)}encodeFrame(e,t,n){const i=Math.min(this.maxFrameSteps,Math.max(0,Math.floor(t)));this.beginFrame(e,i);let o=!1;if(i>0){const r=e.beginComputePass({label:"tunnel steps"});for(let a=0;a<i;a++)this.encodeStep(r,a);r.end(),o=i>0}return this.encodeField(e,n),{readForces:o}}encodeField(e,t){const n=new ArrayBuffer(48),i=new Uint32Array(n),o=new Float32Array(n);i[0]=this.nx,i[1]=this.ny,i[2]=t.mode,i[3]=Rn,o[4]=t.uRef,o[5]=t.lRef,o[8]=t.rhoRef??1,i[6]=this.sampleW,i[7]=this.sampleH,this.device.queue.writeBuffer(this.fieldUni,0,n);const r=this.device.createBindGroup({layout:this.macroPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.f[this.cur]}},{binding:1,resource:{buffer:this.macroBuf}},{binding:2,resource:{buffer:this.paramsBuf}},{binding:3,resource:{buffer:this.bodiesBuf}},{binding:4,resource:{buffer:this.sdfBuf}}]}),a=this.device.createBindGroup({layout:this.fieldPipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.macroBuf}},{binding:1,resource:{buffer:this.scalarBuf}},{binding:2,resource:{buffer:this.fieldUni}},{binding:3,resource:{buffer:this.sampledBuf}}]}),c=e.beginComputePass({label:"tunnel field"});c.setPipeline(this.macroPipe),c.setBindGroup(0,r),c.dispatchWorkgroups(this.groups[0],this.groups[1]),c.setPipeline(this.fieldPipe),c.setBindGroup(0,a),c.dispatchWorkgroups(this.groups[0],this.groups[1]),c.end()}prepareRead(e,t){const n=Math.min(Ne,t),i=n*re*8;let o=this.staging.pop();o||(o=this.device.createBuffer({size:kn*4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})),e.copyBufferToBuffer(this.forceBuf,0,o,0,i),e.copyBufferToBuffer(this.forceBuf,Fe*4,o,Fe*4,16);const r=o;return async()=>{try{await r.mapAsync(GPUMapMode.READ)}catch{return null}const a=new Int32Array(r.getMappedRange().slice(0));r.unmap(),this.destroyed?r.destroy():this.staging.push(r);const c=this.bodies.map((u,h)=>{const d=new Float64Array(n*2);let f=0,y=0;for(let p=0;p<n;p++){const m=a[(p*re+h)*2]/on,g=a[(p*re+h)*2+1]/on;d[2*p]=m,d[2*p+1]=g,f+=m,y+=g}return{fx:f,fy:y,perStep:d}}),l=a[Fe]>0?this.n-a[Fe+1]:-1;return{steps:n,forces:c,bad:a[Fe],limited:a[Fe+2],badCell:l>=0?{x:l%this.nx,y:Math.floor(l/this.nx)}:null}}}async readSampled(){if(this.sampledBusy||this.destroyed)return null;this.sampledBusy=!0;try{const e=this.device.createCommandEncoder();e.copyBufferToBuffer(this.sampledBuf,0,this.sampledRead,0,this.sampledRead.size),this.device.queue.submit([e.finish()]),await this.sampledRead.mapAsync(GPUMapMode.READ);const t=new Float32Array(this.sampledRead.getMappedRange().slice(0));this.sampledRead.unmap();for(let n=0;n<t.length;n++)t[n]>1e29&&(t[n]=NaN);return t}catch{return null}finally{this.sampledBusy=!1}}async readFields(){const e=this.n*16,t=GPUBufferUsage,n=()=>this.device.createBuffer({size:e,usage:t.MAP_READ|t.COPY_DST}),i=n(),o=this.aux?n():null,r=this.device.createCommandEncoder();r.copyBufferToBuffer(this.macroBuf,0,i,0,e),o&&this.aux&&r.copyBufferToBuffer(this.aux[this.cur],0,o,0,e),this.device.queue.submit([r.finish()]);const a=async u=>{await u.mapAsync(GPUMapMode.READ);const h=new Float32Array(u.getMappedRange().slice(0));return u.unmap(),u.destroy(),h},[c,l]=await Promise.all([a(i),o?a(o):Promise.resolve(null)]);return{mac:c,aux:l}}rowRead=null;async readRow(e){if(this.destroyed||e<0||e>=this.ny||this.rowRead&&this.rowRead.mapState!=="unmapped")return null;const t=this.nx*16;this.rowRead||(this.rowRead=this.device.createBuffer({size:t,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}));const n=this.rowRead,i=this.device.createCommandEncoder();i.copyBufferToBuffer(this.macroBuf,e*t,n,0,t),this.device.queue.submit([i.finish()]);try{await n.mapAsync(GPUMapMode.READ)}catch{return null}const o=new Float32Array(n.getMappedRange().slice(0));return n.unmap(),o}destroy(){this.destroyed=!0,this.rowRead?.destroy();for(const e of[...this.aux??[],...this.auxDummy,...this.momDummy,...this.mom??[]])e.destroy();for(const e of this.children)e.destroy();for(const e of[...this.f,this.paramsBuf,this.bodiesBuf,this.sdfBuf,this.forceBuf,this.slotBuf,this.macroBuf,this.scalarBuf,this.fieldUni,this.sampledBuf,...this.staging])e.destroy();this.staging=[]}}const Uo=s=>s.length&&Array.isArray(s[0])?s:[s],Si=`
override KEEP_BULK: f32 = 0.0;
struct R {
  ox: u32, oy: u32, wc: u32, hc: u32,
  nxf: u32, nyf: u32, nxc: u32, nf: u32,
  nc: u32, sCount: u32, slotA: u32, slotB: u32,
  theta: f32, p0: f32, p1: f32, p2: f32,
};
${zt}
${li}
`;function Ai(){return`${Si}
@group(0) @binding(0) var<uniform> U: R;
@group(0) @binding(1) var<storage, read> momF: array<vec4f>;
@group(0) @binding(2) var<storage, read> auxF: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> coarseF: array<f32>;
@group(0) @binding(4) var<storage, read_write> coarseAux: array<vec4f>;

@compute @workgroup_size(${Z})
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
`}function Bi(){return`${Si}
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

@compute @workgroup_size(${Z})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${Z}u;
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
`}function Do(){return[{label:"refine restrict",code:Ai()},{label:"refine fill",code:Bi()}]}class Ri{rect;fine;device;parent;uni;edgeUni;fillPipe;restrictPipe;bgCache=new Map;constructor(e,t,n,i,o){if(this.device=e,this.parent=t,this.fine=n,this.rect=i,n.nx!==2*i.wc+1||n.ny!==2*i.hc+1)throw new Error("A patch grid must be 2 x its parent cells + 1.");if(i.ox<2||i.oy<2||i.ox+i.wc>t.nx-3||i.oy+i.hc>t.ny-3)throw new Error("A patch must lie inside its parent grid, two cells in.");const r=(a,c)=>e.createComputePipeline({layout:"auto",compute:{module:e.createShaderModule({code:a,label:c}),entryPoint:"main",constants:{KEEP_BULK:o}}});this.restrictPipe=r(Ai(),"refine restrict"),this.fillPipe=r(Bi(),"refine fill"),this.oldUni=e.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.uni=e.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.edgeUni=[0,1].map(()=>e.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})),this.writeUniforms()}writeUniforms(){const{rect:e,fine:t,parent:n}=this,i=new Uint32Array(16);i.set([e.ox,e.oy,e.wc,e.hc,t.nx,t.ny,n.nx,t.n,n.n]),this.device.queue.writeBuffer(this.uni,0,i),this.edgeUni.forEach((o,r)=>this.device.queue.writeBuffer(o,0,new Uint32Array([e.ox,e.oy,n.nx,r])))}encodeFill(e,t){const n=this.parent.levelBuffers,i=this.fine.levelBuffers,o=t?.solver===this.fine,r=t?t.solver.levelBuffers:null;this.device.queue.writeBuffer(this.oldUni,0,new Uint32Array(t?[t.rect.ox,t.rect.oy,t.solver.nx,t.solver.ny,1,t.solver.n,0,0]:[0,0,0,0,0,0,0,0]));const a=o?i.cur^1:i.cur,c=this.device.createBindGroup({layout:this.fillPipe.getBindGroupLayout(0),entries:[this.uni,this.oldUni,n.f[n.cur],n.mom[n.cur],n.aux[n.cur],r?r.f[r.cur]:i.f[i.cur^1],r?r.aux[r.cur]:i.aux[i.cur^1],i.f[a],i.aux[a]].map((h,d)=>({binding:d,resource:{buffer:h}}))}),l=e.beginComputePass({label:"refine fill"});l.setPipeline(this.fillPipe),l.setBindGroup(0,c);const u=Math.ceil(this.fine.n/Z);l.dispatchWorkgroups(Math.min(u,32768),Math.ceil(u/Math.min(u,32768))),l.end(),o&&this.fine.swapCur(),this.needPrime=!0}oldUni;shiftOrigin(e,t){this.rect.ox+=e,this.rect.oy+=t,this.writeUniforms(),this.invalidate(),this.needPrime=!0}encodeMoveTo(e,t,n){const i={...this.rect};this.rect.ox=t,this.rect.oy=n,this.writeUniforms(),this.invalidate(),this.encodeFill(e,{solver:this.fine,rect:i})}bg(e,t,n){const i=`${e}|${this.parent.gen}|${this.fine.gen}`;let o=this.bgCache.get(i);return o||(o=this.device.createBindGroup({layout:t,entries:n.map((r,a)=>({binding:a,resource:{buffer:r}}))}),this.bgCache.set(i,o)),o}invalidate(){this.bgCache.clear()}needPrime=!0;prime(){this.needPrime=!0}encodeCoupled(e,t){const n=this.parent.levelBuffers,i=this.needPrime?1:0,o=this.bg(`edge${n.cur}|${i}`,this.fine.edgeLayout,[this.edgeUni[i],n.mom[n.cur^1],n.mom[n.cur],n.aux[n.cur^1],n.aux[n.cur]]);this.fine.encodeStep(e,2*t,o),this.fine.encodeStep(e,2*t+1,o);const r=this.fine.levelBuffers;e.setPipeline(this.restrictPipe),e.setBindGroup(0,this.bg(`res|${r.cur}|${n.cur}`,this.restrictPipe.getBindGroupLayout(0),[this.uni,r.mom[r.cur],r.aux[r.cur],n.f[n.cur],n.aux[n.cur]])),e.dispatchWorkgroups(Math.ceil((this.rect.wc-1)*(this.rect.hc-1)/Z)),this.needPrime=!1}destroy(){this.fine.destroy(),this.oldUni.destroy(),this.uni.destroy();for(const e of this.edgeUni)e.destroy()}}class Ci{levels=[];sdfs=new Map;constructor(e,t,n,i,o=!0){let r=t;for(const a of n){const c=new bt(e,{nx:2*a.wc+1,ny:2*a.hc+1,walls:"slip",patch:!0}),l=new Ri(e,r,c,{...a},i.bulkKeep??0);(r!==t||o)&&r.setPatches([l]),this.levels.push(l),r=c}this.setPhysics(i);for(const a of this.levels)a.fine.reset(i.u)}encodeFill(e,t){this.levels.forEach((n,i)=>{const o=t?.levels[i];if(!o){n.encodeFill(e,null);return}let r={...o.rect};if(i>0){const a=t.levels[i-1].rect,c=this.levels[i-1].rect;r={...r,ox:r.ox+2*(a.ox-c.ox),oy:r.oy+2*(a.oy-c.oy)}}n.encodeFill(e,{solver:o.fine,rect:r})})}get finestBox(){let e=0,t=0,n=1,i=0,o=0;for(const r of this.levels)e+=r.rect.ox/n,t+=r.rect.oy/n,i=r.rect.wc/n,o=r.rect.hc/n,n*=2;return{x0:e,y0:t,x1:e+i,y1:t+o,scale:n}}get finest(){return this.levels[this.levels.length-1].fine}get scale(){return 2**this.levels.length}setPhysics(e){this.levels.forEach((t,n)=>{const i=2**(n+1),o=(e.nuMol??0)*i;t.fine.setPhysics({...e,nuMol:o,tau:3*Math.max(o,e.nuFloor??0)+.5})})}poseAt(e,t){let n=t.x,i=t.y;for(let o=0;o<=e;o++)n=2*(n-this.levels[o].rect.ox),i=2*(i-this.levels[o].rect.oy);return{x:n,y:i,theta:t.theta}}setBodies(e){this.levels.forEach((t,n)=>{const i=2**(n+1);t.fine.setBodies(e.map(o=>{const r=`${o.key}@L${n+1}`;let a=this.sdfs.get(r);return a||(a=Gt(cn(Uo(o.local),{x:0,y:0,theta:0},i),o.band),this.sdfs.set(r,a)),{key:r,sdf:a,from:this.poseAt(n,o.from),to:this.poseAt(n,o.to)}}))})}prepareRead(e,t){const n=this.scale,i=this.finest.prepareRead(e,n*t);return async()=>{const o=await i();if(!o)return null;const r=n*n,a=o.forces.map(c=>{const l=new Float64Array(t*2);let u=0,h=0;for(let d=0;d<t;d++){let f=0,y=0;for(let p=0;p<n;p++)f+=c.perStep[2*(d*n+p)],y+=c.perStep[2*(d*n+p)+1];l[2*d]=f/r,l[2*d+1]=y/r,u+=f/r,h+=y/r}return{fx:u,fy:h,perStep:l}});return{...o,steps:t,forces:a}}}destroy(){for(const e of this.levels)e.destroy()}}function Fo(s,e,t,n){let i=1/0,o=1/0,r=-1/0,a=-1/0;for(let d=0;d<s.length;d+=2)i=Math.min(i,s[d]),r=Math.max(r,s[d]),o=Math.min(o,s[d+1]),a=Math.max(a,s[d+1]);const c=Math.max(n.x0,Math.floor(i-t.ahead*e)),l=Math.max(n.y0,Math.floor(o-t.side*e)),u=Math.min(n.x1,Math.ceil(r+t.behind*e)),h=Math.min(n.y1,Math.ceil(a+t.side*e));return{ox:c,oy:l,wc:Math.max(4,u-c),hc:Math.max(4,h-l)}}const Io=[{ahead:.25,side:.25,behind:.6},{ahead:.06,side:.08,behind:.15}],Wt=1.15,jt=8,Oo=(s,e)=>s.x0<=e.x1&&e.x0<=s.x1&&s.y0<=e.y1&&e.y0<=s.y1,St=(s,e)=>({x0:Math.min(s.x0,e.x0),y0:Math.min(s.y0,e.y0),x1:Math.max(s.x1,e.x1),y1:Math.max(s.y1,e.y1)}),ks=(s,e)=>s.x0>=e.ox&&s.y0>=e.oy&&s.x1<=e.ox+e.wc&&s.y1<=e.oy+e.hc;class No{device;coarse;groups=[];levels=0;physics=null;constructor(e,t){this.device=e,this.coarse=t}get depth(){return this.levels}get refinedIds(){return new Set(this.groups.flatMap(e=>e.ids))}get scale(){return 2**this.levels}clear(){for(const e of this.groups)e.ref.destroy();this.groups=[],this.coarse.setPatches([])}setPhysics(e){this.physics=e;for(const t of this.groups)t.ref.setPhysics(e)}box(e,t,n=1,i={x:0,y:0}){const o=un(cn(e.local,e.to)),r=Math.max(o.x1-o.x0,o.y1-o.y0)*n,a=Io[t],c=u=>n*(u-i.x),l=u=>n*(u-i.y);return{x0:c(o.x0)-a.ahead*r,y0:l(o.y0)-a.side*r,x1:c(o.x1)+a.behind*r,y1:l(o.y1)+a.side*r}}rectFor(e,t){const n=Math.ceil((e.x1-e.x0)*Wt/jt)*jt,i=Math.ceil((e.y1-e.y0)*Wt/jt)*jt;let o=Math.floor((e.x0+e.x1)/2-n/2),r=Math.floor((e.y0+e.y1)/2-i/2);return n>t.x1-t.x0||i>t.y1-t.y0?null:(o=Math.max(t.x0,Math.min(t.x1-n,o)),r=Math.max(t.y0,Math.min(t.y1-i,r)),{ox:o,oy:r,wc:n,hc:i})}update(e,t,n,i){if(!this.physics)return;if(n!==this.levels&&(this.clear(),this.levels=n),n===0||!t.length){this.groups.length&&this.clear();return}const o=t.map(u=>this.box(u,0)),r=t.map((u,h)=>[h]);for(let u=!0;u;){u=!1;e:for(let h=0;h<r.length;h++)for(let d=h+1;d<r.length;d++){const f=r[h].map(p=>o[p]).reduce(St),y=r[d].map(p=>o[p]).reduce(St);if(Oo(f,y)){r[h].push(...r[d]),r.splice(d,1),u=!0;break e}}}const a=[],c=new Set,l=u=>({x0:4,y0:4,x1:2*u.wc-4,y1:2*u.hc-4});for(const u of r){const h=u.map(m=>t[m]),d=h.map(m=>m.id).sort(),f=u.map(m=>o[m]).reduce(St),y=this.groups.find(m=>!c.has(m)&&m.ids.join("|")===d.join("|"));let p=null;if(y&&(c.add(y),p=this.keep(e,y,h,f,i,l)),!p){const m=this.rectFor(f,i);if(!m)continue;const g=[m];if(n>1){const k=h.map(b=>this.box(b,1,2,{x:m.ox,y:m.oy})).reduce(St),S=this.rectFor(k,l(m));S&&g.push(S)}const x=new Ci(this.device,this.coarse,g,this.physics,!1),w=this.groups.find(k=>!c.has(k)&&k.ids.some(S=>d.includes(S)));x.encodeFill(e,w?.ref??null),p={ids:d,order:[],ref:x}}p.order=h.map(m=>m.id),p.ref.setBodies(h.map(m=>({key:m.key,local:m.local,band:m.band,from:m.from,to:m.to}))),a.push(p)}for(const u of this.groups)a.includes(u)||u.ref.destroy();this.groups=a,this.coarse.setPatches(a.map(u=>u.ref.levels[0]))}keep(e,t,n,i,o,r){const a=t.ref.levels[0];if(((u,h)=>(u.x1-u.x0)*(u.y1-u.y0)*Wt*Wt<.5*h.wc*h.hc)(i,a.rect))return null;if(!ks(i,a.rect)){const u=this.rectFor(i,o);if(!u||u.wc!==a.rect.wc||u.hc!==a.rect.hc)return null;const h=u.ox-a.rect.ox,d=u.oy-a.rect.oy;a.encodeMoveTo(e,u.ox,u.oy),t.ref.levels[1]?.shiftOrigin(-2*h,-2*d)}const l=t.ref.levels[1];if(l){const u=a.rect,h=n.map(d=>this.box(d,1,2,{x:u.ox,y:u.oy})).reduce(St);if(!ks(h,l.rect)||l.rect.ox<2||l.rect.oy<2||l.rect.ox+l.rect.wc>2*u.wc-2||l.rect.oy+l.rect.hc>2*u.hc-2){const d=this.rectFor(h,r(u));if(!d||d.wc!==l.rect.wc||d.hc!==l.rect.hc)return null;l.encodeMoveTo(e,d.ox,d.oy)}}return t}prepareRead(e,t){const n=this.groups.map(i=>({g:i,read:i.ref.prepareRead(e,t)}));return async()=>{const i=new Map;let o=0,r=0;for(const{g:a,read:c}of n){const l=await c();if(!l)return null;o+=l.bad,r+=l.limited,a.order.forEach((u,h)=>i.set(u,l.forces[h]))}return{byId:i,bad:o,limited:r}}}encodeDisplay(e,t){const n=this.groups[0];if(!n)return null;const i=n.ref.finestBox,o=n.ref.finest;return o.encodeField(e,{...t,lRef:t.lRef*i.scale}),{scalar:o.buffers.scalar,scale:i.scale,nx:o.nx,ny:o.ny,x0:i.x0,y0:i.y0,x1:i.x1,y1:i.y1}}info(){return this.groups.map(e=>({ids:e.order,levels:e.ref.levels.map(t=>({...t.rect,nx:t.fine.nx,ny:t.fine.ny}))}))}destroy(){this.clear()}}const _t=.05,es=50,Ms=.005,Ut=.1,Ps=1/3;function Lo(s,e,t,n){const i=s/e;let o=_t;const r=d=>n*d/(t*i);r(o)>Ps&&(o=Ps*t*i/n);const a=r(o),c=o/es,l=Math.max(a,c),u=o*i/t,h=a<c;return{dx:i,dt:u,u:o,nu:l,nuFluid:a,nuFloor:c,tau:3*l+.5,capped:h,smagorinsky:h}}function qo(s,e,t,n){return{real:t*e/n,sim:s.u*(e/s.dx)/s.nu}}const at={low:512*256,medium:1024*512,high:1536*768,ultra:2048*1024},Xt=.03;function Cn(s,e,t,n){const i=e+t*s,o=Math.exp(-t*n);return[(s+i*n)*o,(i-t*(s+i*n))*o]}const Go=.1,Ss=12,zo={particles:"inferno",vorticity:"balance",speed:"viridis",pressure:"balance",schlieren:"viridis",rheoscopic:"viridis",none:"viridis"},Vo=.3,Wo=1.5,jo={low:1/110,normal:1/40,high:1/16},Xo=3e3,Ko=4e4,Yo={off:0,short:11,long:22},Ho=34,Qo=14;function $i(s){return s.field==="particles"?s.particleColor==="vorticity"?"balance":"inferno":zo[s.field]}function zn(s,e){const{length:t,height:n}=s.tunnel;let i=Math.round(Math.sqrt(e*t/n)),o=Math.round(e/i);return i=Math.max(32,Math.min(8192,i)),o=Math.max(16,Math.min(8192,o)),{nx:i,ny:o}}const As=4e4,Bs=new Map;class Zo{device;adapterName;canvas;renderer;solver=null;scene=null;map=null;bodies=new Map;order=[];targets=new Map;raf=0;stepsTarget=64;gpuMs=0;perStepMs=0;slowFrames=0;lastFrame=0;fpsEma=0;readPending=!1;sampledAt=0;listeners=new Set;range={lo:-10,hi:10};autoRange={lo:-10,hi:10,ready:!1};gridKey="";rangeField=null;rangeKey="";rhoRef=1;physKey="";turb="off";refine=null;physics=null;paused=!1;unstable=!1;palette;worldView={cx:4,cy:2,mpp:.01,w:800,h:400,dpr:1};simTime=0;stats;particles;dye=null;rheo=null;rheoLooks={};streamlines;rakeGpu=[];dyeChannels=new Map;frameNo=0;markerColors=null;recordForces=!1;onUnstable=null;unstableAt=null;constructor(e,t,n,i){this.device=e,this.adapterName=n,this.palette=i,this.canvas=t,this.renderer=new uo(e,t),this.particles=new Co(e),this.streamlines=new _o(e,this.renderer.format),this.stats={adapter:n,nx:0,ny:0,stepsPerFrame:0,mlups:0,speedRatio:0,simTime:0,fps:0,map:null,state:"running"}}subscribe(e){return this.listeners.add(e),()=>{this.listeners.delete(e)}}emit(){for(const e of this.listeners)e()}get solverReady(){return!!this.solver}get lattice(){return this.map}get grid(){return this.solver?{nx:this.solver.nx,ny:this.solver.ny}:null}benchmark(){return this.benchmarkAt(1024,512)}get refineUnavailable(){const e=this.device.limits.maxStorageBuffersPerShaderStage;return e<gs?`This GPU lets a shader use ${e} storage buffers; refinement needs ${gs}.`:""}refineLevels(e){return this.refineUnavailable?0:e.tunnel.refine}cellsAcross(e){if(!this.map)return null;const t=this.refine?.refinedIds.has(e.id)?this.refine.scale:1;return Se(e.shape)/this.map.dx*t}refineInfo(){return this.refine?.info()??[]}get flowModel(){return this.turb}async benchmarkAt(e,t,n="off"){const i=`${e}x${t}|${n}`,o=Bs.get(i);if(o!==void 0)return o;const r=new bt(this.device,{nx:e,ny:t,walls:"slip"});n==="sa"?r.setPhysics({u:_t,tau:.51,smagorinsky:!1,smagCs:Ut,turb:"sa",nuMol:1e-6,nuFloor:_t/es}):r.setPhysics({u:_t,tau:.51,smagorinsky:!0,smagCs:Ut});const a=async d=>{const f=this.device.createCommandEncoder();r.encodeFrame(f,d,{mode:0,uRef:.05,lRef:50}),this.device.queue.submit([f.finish()]),await this.device.queue.onSubmittedWorkDone()};await a(30);const c=Math.max(40,Math.min(400,Math.round(2e8/(e*t)))),l=performance.now();await a(c);const u=Math.max(.1,performance.now()-l);r.destroy();const h=e*t*c/(u/1e3)/1e6;return Bs.set(i,h),h}async cellsFor(e,t){if(e!=="auto")return at[e];const n=bs(t),i=async o=>{const{nx:r,ny:a}=zn(t,at[o]),c=8*r*r*a*1.25/1e6;return await this.benchmarkAt(r,a,n)>=c};return await i("medium")?await i("high")?await i("ultra")?at.ultra:at.high:at.medium:at.low}async setScene(e){this.scene=e;const t=await this.cellsFor(e.tunnel.resolution,e);if(this.scene!==e)return;const{nx:n,ny:i}=zn(e,t),o=`${n}x${i}|${e.tunnel.walls}|${e.tunnel.length}`;o!==this.gridKey&&(this.refine?.clear(),this.solver?.destroy(),this.solver=new bt(this.device,{nx:n,ny:i,walls:e.tunnel.walls}),this.refine=new No(this.device,this.solver),this.particles.clear(),this.dye?.destroy(),this.dye=null,this.rheo?.destroy(),this.rheo=null,this.gridKey=o,this.epoch++,this.bodies.clear(),this.physKey="",this.simTime=0,this.unstable=!1,this.autoRange.ready=!1,this.rhoRef=1);const r=yt[e.flow.fluid];this.map=Lo(e.tunnel.length,n,e.flow.speed,r.nu),this.turb=bs(e);const a=this.turb==="sa",c=`${this.map.u}|${this.map.tau}|${this.map.smagorinsky}|${this.turb}|${this.map.nuFluid}`;if(c!==this.physKey){this.physics={u:this.map.u,tau:this.map.tau,smagorinsky:this.map.smagorinsky&&!a,smagCs:Ut,turb:this.turb,nuMol:this.map.nuFluid,nuFloor:this.map.nuFloor},this.solver.setPhysics(this.physics),this.refine.setPhysics(this.physics),this.physKey||this.solver.reset(this.map.u),this.physKey=c;for(const l of this.bodies.values())l.samples={t:[],cd:[],cl:[]}}this.syncBodies(e),await this.syncMarkers(e),this.emit()}async syncMarkers(e){const t=this.solver,n=this.map.dx,i=await this.benchmark();let r=e.view.tracers||e.view.field==="particles"?Math.round(t.n*jo[e.view.density]):0;i<Xo&&(r=Math.min(r,Ko));const a=u=>u/n-.5,c=e.rakes.filter(u=>u.enabled);this.rakeGpu=c.filter(u=>u.kind!=="dye").map(u=>({id:u.id,kind:u.kind,x0:a(u.x0),y0:a(u.y0),x1:a(u.x1),y1:a(u.y1),emitters:u.emitters,color:u.color})),this.particles.configure(r,this.rakeGpu,{nx:t.nx,ny:t.ny,absorbInX:Math.max(0,t.absorbInX),outX:t.spongeX});const l=c.filter(u=>u.kind==="dye").slice(0,Q.maxDyeRakes);if(this.dyeChannels=new Map(l.map((u,h)=>[u.id,h])),l.length){this.dye||(this.dye=new Po(this.device,t.nx,t.ny),this.dye.clear());const u=[];l.forEach((h,d)=>{for(let f=0;f<h.emitters;f++){const y=h.emitters===1?.5:f/(h.emitters-1);u.push({x:a(h.x0+(h.x1-h.x0)*y),y:a(h.y0+(h.y1-h.y0)*y),channel:d})}}),this.dye.setSources(u)}else this.dye&&(this.dye.destroy(),this.dye=null)}get dyeChannelOf(){return this.dyeChannels}async readParticles(){const e=await this.particles.read();return e?{...e,tracers:this.particles.tracerCount,pools:this.particles.pools,dx:this.map?.dx??0}:null}async readDye(){return this.dye?{data:await this.dye.read(),nx:this.dye.nx,ny:this.dye.ny,channels:Object.fromEntries(this.dyeChannels),dx:this.map?.dx??0}:null}async readRheo(){if(!this.rheo)return null;const e=await this.rheo.read(),t=this.rheo.nx*this.rheo.ny;let n=0,i=0,o=0,r=0,a=1/0,c=-1/0;for(let u=0;u<t;u++){const h=e.slice(8*u,8*u+6);if(!h.every(Number.isFinite)){o++;continue}n+=h[2],i+=Math.abs(h[3]),r+=h[0]+h[1]+h[2],a=Math.min(a,h[2]),c=Math.max(c,h[2])}const l=Math.max(1,t-o);return{meanZZ:n/l,meanAbsXY:i/l,meanTrace:r/l,minZZ:a,maxZZ:c,nan:o,nx:this.rheo.nx,ny:this.rheo.ny,data:null}}get streamlineCount(){return this.scene?.view.streamlines?this.streamlines.count:0}syncBodies(e){const t=this.map.dx,n=e.bodies.filter(r=>r.enabled&&qt(r.shape)).slice(0,re),i=new Set(n.map(r=>r.id));for(const r of[...this.bodies.keys()])i.has(r)||this.bodies.delete(r);for(const r of n){const a=this.turb==="sa"?ai:void 0,c=2**this.refineLevels(e),l=`${JSON.stringify(r.shape)}@${t}|${a??""}|${c}`,u=this.bodies.get(r.id),h=this.targetPose(r);if(!u||u.key!==l){const d=cn(sn(r.shape,Zn*t/c),{x:0,y:0,theta:0},1/t),f=Gt(d,a);this.bodies.set(r.id,{body:r,key:l,sdf:f,local:d,rCells:Un(d),pose:u?.pose??h,spinAngle:u?.spinAngle??0,vel:u?.vel??{x:0,y:0,theta:0},fxEma:0,fyEma:0,history:[],samples:{t:[],cd:[],cl:[]}})}else u.body=r}const o=n.map(r=>r.id);o.join("|")!==this.order.join("|")&&this.epoch++,this.order=o}targetPose(e){const t=this.map.dx,n=this.targets.get(e.id),i=n?.x??e.x,o=n?.y??e.y,r=n?.angle??e.angle,a=this.bodies.get(e.id)?.spinAngle??0;return{x:i/t-.5,y:o/t-.5,theta:-r*Math.PI/180+a}}setTarget(e,t){t?this.targets.set(e,t):this.targets.delete(e)}livePose(e){const t=this.bodies.get(e);if(!t||!this.map)return null;const n=this.map.dx;return{x:(t.pose.x+.5)*n,y:(t.pose.y+.5)*n,angle:-(t.pose.theta-t.spinAngle)*180/Math.PI}}bodyLive(e){const t=this.bodies.get(e),n=this.livePose(e);if(!t||!n||!this.map||!this.scene)return null;const i=yt[this.scene.flow.fluid],o=this.map.u,r=.5*o*o*(Se(t.body.shape)/this.map.dx),a=c=>c/r*.5*i.rho*this.scene.flow.speed**2*Se(t.body.shape);return{...n,fx:a(t.fxEma),fy:a(t.fyEma),cd:t.fxEma/r,cl:t.fyEma/r}}spinCap(e){const t=this.bodies.get(e);return!t||!this.map?null:Go/Math.max(1,t.rCells)/this.map.dt}measure(e,t){const n=this.bodies.get(e);if(!n||!this.scene||!this.map)return null;const{t:i,cd:o,cl:r}=n.samples;if(i.length<4)return null;const a=i[i.length-1];let c=i.length-1;for(;c>0&&i[c-1]>=a-t;)c--;const l=i.length-c;if(l<4)return null;let u=0,h=0,d=1/0,f=-1/0;for(let g=c;g<i.length;g++)u+=o[g],h+=r[g],d=Math.min(d,r[g]),f=Math.max(f,r[g]);u/=l,h/=l;const y=[];for(let g=c+1;g<i.length;g++){const x=r[g-1]-h,w=r[g]-h;x<0&&w>=0&&y.push(i[g-1]+(i[g]-i[g-1])*x/(x-w))}const p=(f-d)/2;let m=null;if(y.length>=3&&p>.01*Math.abs(u)){const g=(y[y.length-1]-y[0])/(y.length-1);m=Se(n.body.shape)/(g*this.scene.flow.speed)}return{since:a-i[0],span:a-i[c],cd:u,cl:h,clAmp:p,st:m}}async wakeLength(e){const t=this.bodies.get(e),n=this.solver;if(!t||!n||!this.map)return null;const i=Math.round(t.pose.y),o=await n.readRow(i);if(!o)return null;const r=Se(t.body.shape)/this.map.dx,a=t.pose.x+r/2;let c=Math.ceil(a);for(;c<n.nx-1&&o[4*c+3]>.5;)c++;if(!(o[4*c]<0))return null;for(;c<n.nx-1&&o[4*(c+1)]<0;)c++;const l=o[4*c],u=o[4*(c+1)];return(c+l/(l-u)-a)/r}forceHistory(e){return this.bodies.get(e)?.history??[]}reynoldsFor(e){if(!this.map||!this.scene)return null;const t=qo(this.map,Se(e.shape),this.scene.flow.speed,yt[this.scene.flow.fluid].nu);if(this.turb==="sa")return{real:t.real,sim:t.real};const n=this.refine?.refinedIds.has(e.id)?this.refine.scale:1;return{real:t.real,sim:Math.min(t.real,t.sim*n)}}resetFlow(){if(!(!this.solver||!this.map)){this.solver.reset(this.map.u),this.epoch++,this.refine?.clear(),this.simTime=0,this.rhoRef=1,this.particles.clear(),this.dye?.clear(),this.rheo?.reset(),this.scene&&this.syncMarkers(this.scene),this.unstable=!1;for(const e of this.bodies.values())e.fxEma=0,e.fyEma=0,e.history=[],e.samples={t:[],cd:[],cl:[]};this.emit()}}setColormap(e){this.renderer.setColormap(e)}bodyLook=null;get autoRangeNow(){return this.autoRange.ready?{lo:this.autoRange.lo,hi:this.autoRange.hi}:null}setRange(e,t){this.range={lo:e,hi:t}}start(){if(this.raf)return;const e=t=>{this.raf=requestAnimationFrame(e),this.frame(t)};this.raf=requestAnimationFrame(e)}stop(){cancelAnimationFrame(this.raf),this.raf=0}lRefCells(){const e=this.order.length?this.bodies.get(this.order[0]):null;return e&&this.map?Se(e.body.shape)/this.map.dx:this.solver?this.solver.ny/8:50}frame(e){const t=this.solver,n=this.scene,i=this.map;if(!t||!n||!i)return;const o=this.lastFrame?Math.min(100,e-this.lastFrame):16;this.lastFrame=e,this.fpsEma=this.fpsEma?this.fpsEma*.9+1e3/Math.max(1,o)*.1:60;let r=this.paused||this.unstable?0:Math.round(this.stepsTarget);r>0&&n.view.speed==="realtime"&&(r=Math.max(1,Math.min(r,Math.round(o/1e3/i.dt)))),r=Math.min(Ne>>this.refineLevels(n),r);const a=[];for(const T of this.order){const $=this.bodies.get(T);if(r>0&&$.body.spin){const W=this.spinCap($.body.id)??1/0;$.spinAngle+=Math.sign($.body.spin)*Math.min(Math.abs($.body.spin),W)*i.dt*r}const U=this.targetPose($.body),I={...$.pose};if(r===0)$.pose=U,$.vel={x:0,y:0,theta:0};else{const W=1/Math.max(300,4*$.rCells/.577),F=Math.max(1,$.rCells),[we,le]=Cn(I.x-U.x,$.vel.x,W,r),[K,ke]=Cn(I.y-U.y,$.vel.y,W,r),[z,G]=Cn(I.theta-U.theta,$.vel.theta,W,r);let me=U.x+we-I.x,ye=U.y+K-I.y,te=U.theta+z-I.theta;const Ie=Math.hypot(me,ye);Ie>Xt*r&&(me*=Xt*r/Ie,ye*=Xt*r/Ie);const it=Xt*r/F;Math.abs(te)>it&&(te=Math.sign(te)*it);const Ee=Math.hypot(me,ye)<Ie-1e-9;$.vel={x:Ee?me/r:le,y:Ee?ye/r:ke,theta:Math.abs(te)>=it?te/r:G},$.pose={x:I.x+me,y:I.y+ye,theta:I.theta+te}}a.push({key:`${T}:${$.key}`,sdf:$.sdf,from:r===0?$.pose:I,to:$.pose})}t.setBodies(a);const c=this.device.createCommandEncoder();if(this.refine){const T=n.tunnel.walls==="farfield"?Math.max(4,t.ny*.06):0,$={x0:Math.ceil(Math.max(0,t.absorbInX))+4,y0:Math.ceil(T)+4,x1:Math.floor(t.spongeX)-4,y1:Math.floor(t.ny-T)-5};this.refine.update(c,this.order.map((U,I)=>{const W=this.bodies.get(U);return{id:U,key:a[I].key,local:W.local,band:W.sdf.band,from:a[I].from,to:a[I].to,r:W.rCells}}),r>0?this.refineLevels(n):this.refine.depth,$)}const l=n.view.field==="particles",u=l?n.view.particleColor==="vorticity"?Bn.vorticity:Bn.speed:Bn[n.view.field],h=l?`particles:${n.view.particleColor}`:n.view.field;h!==this.rangeKey&&(this.rangeKey=h,this.rangeField=l?n.view.particleColor==="vorticity"?"vorticity":"speed":n.view.field,this.autoRange={lo:0,hi:1,ready:!1});const d={mode:u,uRef:i.u,lRef:this.lRefCells(),rhoRef:this.rhoRef},{readForces:f}=t.encodeFrame(c,r,d),y=this.refine?.encodeDisplay(c,d)??null,p=n.view.autoRange&&this.autoRange.ready?this.autoRange:this.range;this.renderer.setColormap($i(n.view));const m=this.latticeView(i.dx),g=n.view,x=g.field==="none",w=x||g.field==="rheoscopic"||l,k=this.markerColors,S={steps:r,u:i.u,nx:t.nx,ny:t.ny,absorbInX:Math.max(0,t.absorbInX),outX:t.spongeX,wrapY:n.tunnel.walls==="periodic"};this.particles.encodeAdvect(c,S,t.macroBuf,t.buffers),this.dye?.encode(c,r,t.macroBuf);const b=g.field==="rheoscopic";if(b&&!this.rheo&&(this.rheo=new Eo(this.device,t.nx,t.ny)),!b&&this.rheo&&(this.rheo.destroy(),this.rheo=null),this.rheo?.encode(c,r,t.macroBuf,{depthCells:t.ny*Vo,relaxSteps:Wo*t.nx/i.u,inletX:Math.max(1,t.absorbInX)}),this.frameNo++,g.streamlines&&(r>0||this.frameNo%10===0)){const T=n.tunnel.height/this.worldView.mpp/Qo;this.streamlines.encodeTrace(c,t.macroBuf,t,Math.max(0,t.absorbInX)+1,Math.max(8,T))}const M=this.renderer.size,A=(g.tracers||g.field==="particles")&&this.particles.tracerCount>0;if(A&&k){const T=this.worldView.dpr,$=l?{scalar:t.buffers.scalar,lut:this.renderer.lut,nx:t.nx,ny:t.ny,lo:p.lo,hi:p.hi,lift:.36}:null,U=l?[1,1,1,.66]:w?k.tracerLight:[...k.tracerDark.slice(0,3),.3];this.particles.encodeDraw(c,{...M,dot:(l?.95:.6)*T,tail:r>0?Yo[g.trail]*T:0,taper:!0},m,0,{tracers:!0},{tracer:U},$,this.renderer.dummies)}const B=[...this.dyeChannels.entries()].sort((T,$)=>T[1]-$[1]).map(([T])=>{const $=n.rakes.find(I=>I.id===T),U=k?.rakesOnDark[$?.color??0]??[0,0,0,1];return[U[0],U[1],U[2],.95]});this.renderer.encode(c,t,m,p,(l||g.field==="rheoscopic")&&this.bodyLook?{...this.palette,...this.bodyLook}:this.palette,{plain:x,arrows:g.arrows,arrowCells:Ho*this.worldView.mpp/i.dx,uRef:i.u,dye:this.dye?this.dye.field:null,dyeColors:B,trail:A&&k?this.particles.trail:null,rheo:this.rheo&&this.rheoLooks[g.rheoPreset]?{field:this.rheo.field,look:this.rheoLooks[g.rheoPreset],sparkle:this.rheo.sparkleWeights}:null,patch:y},k?T=>{g.streamlines&&this.streamlines.encodeDraw(T,M,m,w?k.streamlineLight:k.streamline,this.worldView.dpr),this.rakeGpu.length&&this.particles.encodeRakeLines(T,this.renderer.format,M,m,w?k.rakesOnDark:k.rakes,this.worldView.dpr)}:void 0);const R=f&&!this.readPending?t.prepareRead(c,r):null,C=this.simTime,E=this.epoch,_=R&&this.refine?.depth?this.refine.prepareRead(c,r):null,P=performance.now();this.device.queue.submit([c.finish()]),this.simTime+=r*i.dt,r>0&&this.device.queue.onSubmittedWorkDone().then(()=>{const T=performance.now()-P,$=T/r;if(this.perStepMs&&$>4*this.perStepMs&&++this.slowFrames<4)return;this.slowFrames=0,this.perStepMs=this.perStepMs?this.perStepMs*.8+$*.2:$,this.gpuMs=this.perStepMs*r;let U=Ss/Math.max(1e-4,this.perStepMs);T<Ss/2&&(U=Math.max(U,r*2)),this.stepsTarget=Math.max(1,Math.min(Ne,this.stepsTarget*.7+U*.3))}),R&&(this.readPending=!0,R().then(T=>{this.readPending=!1,T&&(_?_().then($=>{$&&(T.forces=T.forces.map((U,I)=>$.byId.get(this.order[I])??U),T.bad+=$.bad,T.limited+=$.limited),this.takeForces(T,C,E)}):this.takeForces(T,C,E))})),n.view.autoRange&&e-this.sampledAt>400&&(this.sampledAt=e,t.readSampled().then(T=>T&&this.rangeField&&this.takeSample(T,this.rangeField))),this.stats={adapter:this.adapterName,nx:t.nx,ny:t.ny,stepsPerFrame:r,mlups:r>0&&this.gpuMs>0?t.n*r/(this.gpuMs/1e3)/1e6:this.stats.mlups,speedRatio:r*i.dt/Math.max(.001,o/1e3),simTime:this.simTime,fps:this.fpsEma,map:i,state:this.unstable?"unstable":this.paused?"paused":"running"}}limitedAt=0;limitedTotal=0;epoch=0;takeForces(e,t,n){if(n===this.epoch){if(e.limited>0&&(this.limitedAt=performance.now(),this.limitedTotal+=e.limited),e.bad>0&&!this.unstable){this.unstable=!0,this.unstableAt=e.badCell&&this.map?{x:(e.badCell.x+.5)*this.map.dx,y:(e.badCell.y+.5)*this.map.dx,poses:this.order.map(i=>({id:i,...this.livePose(i)}))}:null,this.onUnstable?.(),this.emit();return}e.forces.forEach((i,o)=>{const r=this.bodies.get(this.order[o]);if(!r||e.steps===0)return;const a=i.fx/e.steps,c=i.fy/e.steps,l=Math.min(1,e.steps/400);if(r.fxEma=r.fxEma?r.fxEma*(1-l)+a*l:a,r.fyEma=r.fyEma?r.fyEma*(1-l)+c*l:c,this.recordForces)for(let u=0;u<e.steps;u++)r.history.push(i.perStep[2*u],i.perStep[2*u+1]);if(this.map){const u=Se(r.body.shape)/this.map.dx,h=.5*this.map.u*this.map.u*u,d=Math.max(1,Math.floor(u/this.map.u/50)),f=r.samples;f.t.length&&t<f.t[f.t.length-1]&&(r.samples={t:[],cd:[],cl:[]});const y=r.samples;for(let p=0;p<e.steps;p+=d){const m=Math.min(d,e.steps-p);let g=0,x=0;for(let w=0;w<m;w++)g+=i.perStep[2*(p+w)],x+=i.perStep[2*(p+w)+1];y.t.push(t+(p+m/2)*this.map.dt),y.cd.push(g/m/h),y.cl.push(x/m/h)}if(y.t.length>As){const p=y.t.length-As;y.t.splice(0,p),y.cd.splice(0,p),y.cl.splice(0,p)}}})}}takeSample(e,t){if(t!==this.rangeField)return;if(t==="pressure"&&this.solver&&this.map){const c=this.solver.sampleW,l=Math.min(c-1,Math.ceil((this.solver.absorbInX+this.solver.nx*.03)/4)),u=[];for(let h=0;h<this.solver.sampleH;h++){const d=e[h*c+l];Number.isFinite(d)&&u.push(d)}if(u.length>4){u.sort((d,f)=>d-f);const h=u[Math.floor(u.length/2)];if(this.rhoRef+=h*1.5*this.map.u*this.map.u,Math.abs(h)>.02)return}}const n=Array.from(e).filter(c=>Number.isFinite(c));if(n.length<16)return;n.sort((c,l)=>c-l);const i=c=>n[Math.min(n.length-1,Math.max(0,Math.round(c*(n.length-1))))];let o,r;if(t==="vorticity"){const c=n.map(Math.abs).sort((u,h)=>u-h),l=Math.max(1e-6,c[Math.round(.985*(c.length-1))]);o=-l,r=l}else if(t==="pressure"){const c=Math.max(Math.abs(i(.01)),Math.abs(i(.99)),.001);o=-c,r=c}else o=0,r=Math.max(t==="speed"?1.8:1e-6,i(.995));const a=this.autoRange.ready?.3:1;this.autoRange={lo:this.autoRange.lo*(1-a)+o*a,hi:this.autoRange.hi*(1-a)+r*a,ready:!0},this.emit()}sampleField(){return this.solver?this.solver.readSampled():Promise.resolve(null)}latticeView(e){const t=this.worldView;return{scale:t.mpp/t.dpr/e,ox:(t.cx-t.w/2*t.mpp)/e-.5,oy:(t.cy+t.h/2*t.mpp)/e-.5}}destroy(){this.stop(),this.solver?.destroy(),this.particles.destroy(),this.dye?.destroy(),this.rheo?.destroy(),this.streamlines.destroy(),this.renderer.destroy()}}const Rs=100;class Jo{state;listeners=new Set;past=[];future=[];onSceneChange=null;constructor(e){this.state={scene:e,selected:null,save:"saved",saveError:""}}get=()=>this.state;subscribe=e=>(this.listeners.add(e),()=>{this.listeners.delete(e)});set(e){this.state={...this.state,...e};for(const t of this.listeners)t()}commit(e,t=!0){t&&(this.past.push(this.state.scene),this.past.length>Rs&&this.past.shift(),this.future=[]);const n=this.state.selected,i=n&&(e.bodies.some(o=>o.id===n)||e.rakes.some(o=>o.id===n))?n:null;this.set({scene:e,selected:i}),this.onSceneChange?.(e)}commitFrom(e,t){this.past.push(e),this.past.length>Rs&&this.past.shift(),this.future=[],this.commit(t,!1)}updateBody(e,t,n=!0){const i=this.state.scene;this.commit({...i,bodies:i.bodies.map(o=>o.id===e?{...o,...t}:o)},n)}get canUndo(){return this.past.length>0}get canRedo(){return this.future.length>0}undo(){const e=this.past.pop();return e?(this.future.push(this.state.scene),this.commit(e,!1),!0):!1}redo(){const e=this.future.pop();return e?(this.past.push(this.state.scene),this.commit(e,!1),!0):!1}select(e){this.set({selected:e})}setSave(e,t=""){this.set({save:e,saveError:t})}}function pe(s,e){return Is(s.subscribe,()=>e(s.get()))}const Dt=s=>({points:{...s.points},entities:s.entities.map(e=>({...e})),constraints:s.constraints.map(e=>({...e,refs:[...e.refs]}))});function xe(s,e,t){if(t&&t!=="origin"&&t in s.points)return t;const n=ae("pt");return s.points[n]=[e[0],e[1]],t==="origin"&&s.constraints.push({id:ae("c"),kind:"coincident",refs:[n,"origin"]}),n}function Ct(s,e,t,n=!1){const i=ae("e");return s.entities.push({id:i,kind:"line",p:[e,t],...n?{construction:!0}:{}}),i}function ea(s,e,t){const n=Ct(s,e,t),i=N(s.points[t],s.points[e]),o=Math.abs(Math.atan2(i[1],i[0])*180/Math.PI)%180;return Math.min(o,180-o)<2?s.constraints.push({id:ae("c"),kind:"horizontal",refs:[n],inferred:!0}):Math.abs(o-90)<2&&s.constraints.push({id:ae("c"),kind:"vertical",refs:[n],inferred:!0}),n}function ta(s,e,t,n){const i=xe(s,e,n),o=s.points[i],r=xe(s,[t[0],o[1]],null),a=xe(s,t,null),c=xe(s,[o[0],t[1]],null),l=[Ct(s,i,r),Ct(s,r,a),Ct(s,a,c),Ct(s,c,i)];return s.constraints.push({id:ae("c"),kind:"horizontal",refs:[l[0]]},{id:ae("c"),kind:"horizontal",refs:[l[2]]},{id:ae("c"),kind:"vertical",refs:[l[1]]},{id:ae("c"),kind:"vertical",refs:[l[3]]}),l}function na(s,e,t,n){const i=xe(s,e,n),o=ae("e");return s.entities.push({id:o,kind:"circle",c:i,r:t}),o}function sa(s,e,t,n){const i=cr(s.points[e],n,s.points[t]);if(!i)return null;const o=xe(s,i.c,null),r=ae("e");return s.entities.push({id:r,kind:"arc",c:o,a:e,b:t,...i.ccw?{}:{ccw:!1}}),r}function ia(s,e,t=!1){const n=ae("e");return s.entities.push({id:n,kind:"spline",form:"fit",pts:e,degree:3,...t?{closed:!0}:{}}),n}function ra(s,e){const t=ae("e");return s.entities.push({id:t,kind:"point",p:e}),t}function oa(s,e,t){const n=ae("c");return s.constraints.push({id:n,kind:e,refs:[...t]}),n}function Ti(s,e,t,n,i){const o=ae("c");return s.constraints.push({id:o,kind:e,refs:[...t],expr:ii(n,e==="angle"?"angle":"length"),driving:!0,...i?{at:i}:{}}),o}function aa(s,e){return s.entities.filter(t=>t.kind==="line"&&(t.p[0]===e||t.p[1]===e))}function la(s,e,t){const n=aa(s,e);if(n.length!==2)return{ok:!1,reason:"A fillet goes at a corner where two lines meet."};const i=s.points[e],o=b=>b.p[0]===e?b.p[1]:b.p[0],r=s.points[o(n[0])],a=s.points[o(n[1])],c=Ke(N(r,i)),l=Ke(N(a,i)),u=Math.max(-1,Math.min(1,c[0]*l[0]+c[1]*l[1])),h=Math.acos(u)/2;if(h<.001||Math.PI/2-h<.001)return{ok:!1,reason:"The two lines are in line: there is no corner to round."};const d=t/Math.tan(h);if(d>=X(i,r)||d>=X(i,a))return{ok:!1,reason:"That radius is too large for these lines."};const f=[i[0]+c[0]*d,i[1]+c[1]*d],y=[i[0]+l[0]*d,i[1]+l[1]*d],p=Ke([c[0]+l[0],c[1]+l[1]]),m=[i[0]+p[0]*t/Math.sin(h),i[1]+p[1]*t/Math.sin(h)],g=xe(s,f,null),x=xe(s,y,null),w=xe(s,m,null);for(const[b,M]of[[n[0],g],[n[1],x]]){const A=b.p[0]===e?0:1,B=s.entities.find(R=>R.id===b.id);B.p=A===0?[M,B.p[1]]:[B.p[0],M]}const k=(f[0]-m[0])*(y[1]-m[1])-(f[1]-m[1])*(y[0]-m[0]),S=ae("e");return s.entities.push({id:S,kind:"arc",c:w,a:g,b:x,...k>0?{}:{ccw:!1}}),s.constraints=s.constraints.filter(b=>!b.refs.includes(e)),delete s.points[e],s.constraints.push({id:ae("c"),kind:"tangent",refs:[n[0].id,S]},{id:ae("c"),kind:"tangent",refs:[n[1].id,S]}),Ti(s,"radius",[S],t,null),{ok:!0,arc:S}}function Cs(s){switch(s.kind){case"point":return[s.p];case"line":return[...s.p];case"circle":return[s.c];case"arc":return[s.c,s.a,s.b];case"spline":return[...s.pts,...(s.handles??[]).filter(Boolean)]}}function ca(s,e){const t=Dt(s),n=new Set(e);t.entities=t.entities.filter(r=>!n.has(r.id)&&!Cs(r).some(a=>n.has(a)));const i=new Set(t.entities.flatMap(Cs));for(const r of Object.keys(t.points))i.has(r)||delete t.points[r];const o=r=>r==="origin"||r in t.points||t.entities.some(a=>a.id===r);return t.constraints=t.constraints.filter(r=>!n.has(r.id)&&r.refs.every(o)),t}function ua(s,e){const t=Dt(s),n=!t.entities.filter(i=>e.includes(i.id)).every(i=>i.construction);return t.entities=t.entities.map(i=>e.includes(i.id)&&i.kind!=="point"?{...i,construction:n||void 0}:i),t}const $n={select:"Select",line:"Line",rectangle:"Rectangle",circle:"Circle",arc:"Arc",spline:"Spline",point:"Point",fillet:"Fillet",dimension:"Dimension"},da=["coincident","horizontal","vertical","parallel","perpendicular","tangent","equal","concentric","fix"],$s=9,ha=7;class fa{bodyId=null;tool="line";selection=[];status=null;analysis=null;message="";busy=!1;editingDim=null;store;engine;solverOf;listeners=new Set;clicks=[];chain=null;cursor=null;cursorSnap=null;hover=null;dimPicks=[];drag=null;solveSeq=0;constructor(e,t,n){this.store=e,this.engine=t,this.solverOf=n}subscribe(e){return this.listeners.add(e),()=>this.listeners.delete(e)}version=0;emit(){this.version++;for(const e of this.listeners)e()}get body(){return this.store.get().scene.bodies.find(e=>e.id===this.bodyId&&e.shape.kind==="sketch")??null}get sketch(){const e=this.body;return e&&e.shape.kind==="sketch"?e.shape.sketch:ni()}withSketch(e,t){return{...e,bodies:e.bodies.map(n=>n.id===this.bodyId&&n.shape.kind==="sketch"?{...n,shape:{...n.shape,sketch:t}}:n)}}open(e,t="select"){this.bodyId=e,this.tool=t,this.reset(),this.store.select(e),this.emit(),this.solveAndCommit(this.sketch,null)}close(){this.reset(),this.bodyId=null,this.editingDim=null,this.emit()}resync(){if(!this.bodyId)return;if(!this.body)return this.close();this.clicks=[],this.chain=null,this.dimPicks=[],this.drag=null;const e=new Set([...Object.keys(this.sketch.points),...this.sketch.entities.map(t=>t.id),...this.sketch.constraints.map(t=>t.id)]);this.selection=this.selection.filter(t=>e.has(t)),this.solveAndCommit(this.sketch,null)}get editing(){return!!this.body}setTool(e){this.tool=e,this.reset(),this.emit()}reset(){this.clicks=[],this.chain=null,this.dimPicks=[],this.message="",this.tool!=="select"&&(this.selection=[])}pose(){const e=this.body;return{x:e.x,y:e.y,theta:-e.angle*Math.PI/180}}toLocal(e,t){const n=this.pose(),i=e-n.x,o=t-n.y,r=Math.cos(n.theta),a=Math.sin(n.theta);return[(r*i+a*o)*1e3,(-a*i+r*o)*1e3]}toWorld(e){const t=this.pose(),n=Math.cos(t.theta),i=Math.sin(t.theta),o=e[0]/1e3,r=e[1]/1e3;return{x:t.x+n*o-i*r,y:t.y+i*o+n*r}}mmPerPx(){return this.engine.worldView.mpp*1e3}pickPoint(e,t=null){const n=this.sketch,i=$s*this.mmPerPx();let o=null,r=i;Math.hypot(e[0],e[1])<=r&&(o="origin",r=Math.hypot(e[0],e[1]));for(const[a,c]of Object.entries(n.points)){if(a===t)continue;const l=Math.hypot(c[0]-e[0],c[1]-e[1]);l<=r&&(r=l,o=a)}return o}pickEntity(e){const t=this.sketch,n=ha*this.mmPerPx();let i=null,o=n;for(const r of t.entities){if(r.kind==="point")continue;const a=Rr(t,r,e);a<=o&&(o=a,i=r.id)}return i}pickDimension(e,t){for(const n of this.sketch.constraints){if(!Ve(n))continue;const i=vn(this.sketch,n,this.mmPerPx());if(!i)continue;const o=this.toWorld(i.text),r=t(o.x,o.y);if(Math.abs(e.x-r.x)<=30&&Math.abs(e.y-r.y)<=10)return n.id}return null}async solveAndCommit(e,t){const n=++this.solveSeq;this.busy=!0,this.emit(),t&&this.store.commit(this.withSketch(this.store.get().scene,e),!1);const i=await this.solverOf().solve(e);if(n!==this.solveSeq||!this.editing)return!1;if(this.sketch!==e)return this.busy=!1,this.emit(),!1;if(this.busy=!1,i.error)return t&&this.store.commit(t,!1),this.message=i.error,this.emit(),!1;this.status=i.status,this.analysis=i.analysis;const o=this.withSketch(this.store.get().scene,i.sketch);return t?this.store.commitFrom(t,o):this.store.commit(o,!1),this.emit(),!0}edit(e){const t=this.store.get().scene,n=Dt(this.sketch),i=e(n)??n;return this.solveAndCommit(i,t)}applyRelation(e){const t=this.selection.filter(n=>!this.sketch.constraints.some(i=>i.id===n));if(!t.length){this.message="Select the points or curves first (Select tool, Shift adds to the selection).",this.emit();return}this.edit(n=>{oa(n,e,t)}).then(n=>{n||(this.message=`A ${e.replace("_"," ")} relation does not fit those: ${this.message}`),this.emit()})}toggleConstruction(){if(!this.selection.length)return;const e=this.store.get().scene;this.solveAndCommit(ua(this.sketch,this.selection),e)}deleteSelection(){if(!this.selection.length)return;const e=this.store.get().scene,t=ca(this.sketch,this.selection);this.selection=[],this.solveAndCommit(t,e)}setDimension(e,t){const n=this.sketch.constraints.find(r=>r.id===e);if(!n||!Ve(n))return"That dimension is gone.";const i=n.kind==="angle"?"angle":"length",o=si(t,i);return"error"in o?o.error:(this.editingDim=null,this.edit(r=>{const a=r.constraints.find(c=>c.id===e);a.expr=ii(o.value,i),a.driving=!0}),null)}startDimensionEdit(e,t,n){const i=this.sketch.constraints.find(r=>r.id===e);if(!i||!Ve(i))return;const o=We(this.sketch,i);this.editingDim={id:e,x:t,y:n,text:o==null?"":ti(o)},this.emit()}cancelDimensionEdit(){this.editingDim&&(this.editingDim=null,this.emit())}dimensionLabels(e){const t=[];for(const n of this.sketch.constraints){if(!Ve(n))continue;const i=vn(this.sketch,n,this.mmPerPx());if(!i)continue;const o=this.toWorld(i.text);t.push({id:n.id,kind:n.kind,...e(o.x,o.y),value:We(this.sketch,n)})}return t}statusWords(){if(this.busy)return"Solving…";const e=dt(this.sketch);if(!this.sketch.entities.length)return"Draw a closed outline";const t=Tr(this.status,!1);return e.rings.length?t:`${t} · not closed: the body is not in the flow`}pointerDown(e,t,n,i,o){if(!this.editing)return!1;const r=this.toLocal(e,t),a=this.pickPoint(r),c=a&&a!=="origin"?this.sketch.points[a]:a==="origin"?[0,0]:r;switch(this.message="",this.tool){case"select":{const l=this.pickDimension(n,o);if(l&&i.clicks>=2)return this.startDimensionEdit(l,n.x,n.y),!0;const u=l??(a!=="origin"?a:null)??this.pickEntity(r);return u?(this.selection=i.shift?this.selection.includes(u)?this.selection.filter(h=>h!==u):[...this.selection,u]:[u],a&&a!=="origin"&&u===a&&(this.drag={point:a,before:this.store.get().scene,moved:!1},this.solverOf().dragStart(this.sketch,a).then(h=>{!h&&this.drag&&(this.message="That point cannot move: its relations and dimensions hold it.",this.drag=null,this.emit())})),this.emit(),!0):(this.selection=[],this.emit(),!0)}case"point":return this.edit(l=>{ra(l,xe(l,c,a))}),!0;case"line":{if(!this.chain){const y=this.store.get().scene,p=Dt(this.sketch),m=xe(p,c,a);return this.store.commit(this.withSketch(this.store.get().scene,p),!1),this.chain={from:m,first:m,before:y},this.emit(),!0}const l=Dt(this.sketch),u=a??null;if(u===this.chain.from)return i.clicks>=2&&this.key("Escape"),!0;const h=xe(l,c,u);ea(l,this.chain.from,h);const d=h===this.chain.first,f=this.chain.before;return this.chain=d||i.clicks>=2?null:{from:h,first:this.chain.first,before:f},this.chain?this.store.commit(this.withSketch(this.store.get().scene,l),!1):this.solveAndCommit(l,f),this.emit(),!0}case"rectangle":case"circle":{if(this.clicks.push({p:c,snap:a}),this.clicks.length<2)return this.emitTrue();const[l,u]=this.clicks;if(this.clicks=[],this.tool==="rectangle"){if(Math.abs(u.p[0]-l.p[0])<1e-6||Math.abs(u.p[1]-l.p[1])<1e-6)return this.emitTrue();this.edit(h=>{ta(h,l.p,u.p,l.snap)})}else{const h=Math.hypot(u.p[0]-l.p[0],u.p[1]-l.p[1]);if(h<1e-6)return this.emitTrue();this.edit(d=>{na(d,l.p,h,l.snap)})}return!0}case"arc":{if(this.clicks.push({p:c,snap:a}),this.clicks.length<3)return this.emitTrue();const[l,u,h]=this.clicks;return this.clicks=[],this.edit(d=>{const f=xe(d,l.p,l.snap),y=xe(d,u.p,u.snap);sa(d,f,y,h.p)||(this.message="Those three points are in line: no arc goes through them.")}),!0}case"spline":{const l=this.clicks[this.clicks.length-1];return i.clicks>=2&&l&&Math.hypot(l.p[0]-c[0],l.p[1]-c[1])<=$s*this.mmPerPx()||this.clicks.push({p:c,snap:a}),i.clicks>=2&&this.clicks.length>=2?this.finishSpline():this.emit(),!0}case"fillet":{const l=a&&a!=="origin"?a:null;if(!l)return this.message="Click a corner where two lines meet.",this.emitTrue();const u=this.sketch,h=u.entities.filter(f=>f.kind==="line"&&f.p.includes(l)).map(f=>Math.hypot(u.points[f.p[1]][0]-u.points[f.p[0]][0],u.points[f.p[1]][1]-u.points[f.p[0]][1])),d=Math.max(.001,Number((.2*Math.min(...h,1/0)).toPrecision(2)));return this.edit(f=>{const y=la(f,l,Number.isFinite(d)?d:1);y.ok||(this.message=y.reason)}),!0}case"dimension":{const l=(a!=="origin"?a:null)??this.pickEntity(r);if(l)return this.dimPicks=this.dimPicks.includes(l)?this.dimPicks:[...this.dimPicks,l].slice(-2),this.emitTrue();if(!this.dimPicks.length)return this.message="Pick a line, a circle, an arc, or two points or lines, then click where the dimension goes.",this.emitTrue();const u=Dr(this.sketch,this.dimPicks,r);return this.dimPicks=[],"reason"in u?(this.message=u.reason,this.emitTrue()):(this.edit(h=>{Ti(h,u.kind,u.refs,u.value,r)}),!0)}}return!1}emitTrue(){return this.emit(),!0}pointerMove(e,t){if(!this.editing)return!1;const n=this.toLocal(e,t);if(this.drag){this.drag.moved=!0;const i=this.sketch;return this.solverOf().dragMove(i,n[0],n[1]).then(o=>{o&&this.drag&&this.store.commit(this.withSketch(this.store.get().scene,o),!1)}),!0}return this.cursorSnap=this.pickPoint(n,this.chain?.from??null),this.cursor=this.cursorSnap==="origin"?[0,0]:this.cursorSnap?this.sketch.points[this.cursorSnap]:n,this.hover=this.cursorSnap&&this.cursorSnap!=="origin"?this.cursorSnap:this.pickEntity(n),!0}pointerUp(){if(!this.editing)return!1;const e=this.drag;if(this.drag=null,e){const t=this.sketch;this.solverOf().dragEnd(t).then(n=>{if(!this.editing)return;this.status=n.status,this.analysis=n.analysis;const i=this.withSketch(this.store.get().scene,n.sketch);e.moved?this.store.commitFrom(e.before,i):this.store.commit(i,!1),this.emit()})}return!0}finishSpline(){const e=this.clicks;if(this.clicks=[],e.length<2)return this.emit();this.edit(t=>{const n=e.map(o=>xe(t,o.p,o.snap)),i=n.length>=4&&n[0]===n[n.length-1];ia(t,i?n.slice(0,-1):n,i)})}key(e){if(!this.editing)return!1;if(e==="Escape"){if(this.chain){const t=this.sketch,n=this.chain.before;return this.chain=null,this.solveAndCommit(t,n),!0}return this.clicks.length||this.dimPicks.length?(this.clicks=[],this.dimPicks=[],this.emitTrue()):this.tool!=="select"?(this.setTool("select"),!0):(this.close(),!0)}if(e==="Enter"){if(this.tool==="spline")this.finishSpline();else if(this.chain)return this.key("Escape");return!0}return(e==="Delete"||e==="Backspace")&&this.selection.length?(this.deleteSelection(),!0):!1}draw(e,t,n){if(!this.editing)return;const i=this.sketch,o=p=>{const m=this.toWorld(p);return t(m.x,m.y)},r=_r(i,[...this.status?.conflicting??[],...this.status?.redundant??[]]),a=(p,m,g)=>{if(this.selection.includes(p))return n.pick;if(g)return n.construction;const x=Er(p,m,this.analysis,r);return x==="over"?n.over:x==="fully"?n.fully:n.under},c=(p,m,g={})=>{p.length<2||(e.beginPath(),p.forEach((x,w)=>w?e.lineTo(x.x,x.y):e.moveTo(x.x,x.y)),g.closed&&e.closePath(),e.setLineDash([]),e.strokeStyle=n.halo,e.lineWidth=(g.width??1.75)+3,e.stroke(),e.setLineDash(g.dash?[6,4]:[]),e.strokeStyle=m,e.lineWidth=g.width??1.75,e.stroke(),e.setLineDash([]))},l=p=>{switch(p.kind){case"line":return[i.points[p.p[0]],i.points[p.p[1]]];case"circle":{const m=i.points[p.c];return Array.from({length:97},(g,x)=>[m[0]+p.r*Math.cos(x/96*2*Math.PI),m[1]+p.r*Math.sin(x/96*2*Math.PI)])}case"arc":{const m=Nt(i,p);return m?Array.from({length:49},(g,x)=>[m.c[0]+m.r*Math.cos(m.a0+m.sweep*x/48),m.c[1]+m.r*Math.sin(m.a0+m.sweep*x/48)]):[]}case"spline":return Hs(i,p,96);default:return[]}},u=o([0,0]);e.strokeStyle=n.construction,e.lineWidth=1,e.beginPath(),e.moveTo(u.x-8,u.y),e.lineTo(u.x+8,u.y),e.moveTo(u.x,u.y-8),e.lineTo(u.x,u.y+8),e.stroke();for(const p of i.entities){if(p.kind==="point")continue;const m=!!p.construction||p.kind==="line"&&!!p.centerline,g=l(p).map(o),x=this.hover===p.id||this.dimPicks.includes(p.id);c(g,x?n.preview:a(p.id,"entity",m),{dash:m,width:x?2.5:1.75})}for(const[p,m]of Object.entries(i.points)){const g=o(m),x=this.selection.includes(p)||this.dimPicks.includes(p);e.beginPath(),e.arc(g.x,g.y,x||this.hover===p?4.5:3,0,2*Math.PI),e.fillStyle=x?n.pick:a(p,"point",!1),e.strokeStyle=n.halo,e.lineWidth=1.5,e.fill(),e.stroke()}const h=dt(i);for(const p of[...h.open,...h.branch]){const m=o(p);e.beginPath(),e.arc(m.x,m.y,8,0,2*Math.PI),e.strokeStyle=n.over,e.lineWidth=2,e.stroke()}const d=this.mmPerPx();e.font="12px system-ui, sans-serif",e.textAlign="center",e.textBaseline="middle";for(const p of i.constraints){if(!Ve(p))continue;const m=vn(i,p,d);if(!m)continue;const g=this.selection.includes(p.id)?n.pick:p.driving?n.fully:n.construction;for(const[b,M]of m.lines)c([o(b),o(M)],g,{width:1});for(const b of m.arrows){const M=o(b.at),A=o([b.at[0]-b.dir[0]*8*d,b.at[1]-b.dir[1]*8*d]),B=M.x-A.x,R=M.y-A.y;e.beginPath(),e.moveTo(M.x,M.y),e.lineTo(A.x-R*.35,A.y+B*.35),e.lineTo(A.x+R*.35,A.y-B*.35),e.closePath(),e.fillStyle=g,e.fill()}if(this.editingDim?.id===p.id)continue;const x=o(m.text),w=We(i,p),k=pa(p,w),S=e.measureText(k).width+10;e.fillStyle=n.halo,e.fillRect(x.x-S/2,x.y-9,S,18),e.strokeStyle=g,e.lineWidth=1,e.strokeRect(x.x-S/2,x.y-9,S,18),e.fillStyle=g,e.fillText(k,x.x,x.y)}const f=new Map;for(const p of i.constraints){if(Ve(p)||p.refs.includes("origin")&&p.kind==="coincident")continue;const m=qr[p.kind],g=this.anchorOf(p);if(!m||!g)continue;const x=`${Math.round(g[0]*1e3)}:${Math.round(g[1]*1e3)}`,w=f.get(x)??0;f.set(x,w+1);const k=o(g),S=k.x+10+w*16,b=k.y-16;e.fillStyle=n.halo,e.fillRect(S-1,b-1,15,15),e.strokeStyle=this.status?.conflicting.includes(p.id)?n.over:n.construction,e.lineWidth=1,e.strokeRect(S-1,b-1,15,15),e.save(),e.translate(S+.5,b+.5),e.scale(12/24,12/24),e.strokeStyle=this.selection.includes(p.id)?n.pick:n.fully,e.lineWidth=2.5,e.stroke(new Path2D(m)),e.restore()}const y=this.cursor;if(y){this.chain&&c([o(i.points[this.chain.from]),o(y)],n.preview);const p=this.clicks[0]?.p;if(p&&this.tool==="rectangle"&&c([o(p),o([y[0],p[1]]),o(y),o([p[0],y[1]])],n.preview,{closed:!0}),p&&this.tool==="circle"){const m=Math.hypot(y[0]-p[0],y[1]-p[1]);c(Array.from({length:65},(g,x)=>o([p[0]+m*Math.cos(x/64*2*Math.PI),p[1]+m*Math.sin(x/64*2*Math.PI)])),n.preview)}if((this.tool==="arc"||this.tool==="spline")&&c([...this.clicks.map(m=>o(m.p)),o(y)],n.preview,{dash:this.tool==="arc"}),this.cursorSnap){const m=o(y);e.beginPath(),e.arc(m.x,m.y,6,0,2*Math.PI),e.strokeStyle=n.preview,e.lineWidth=1.5,e.stroke()}}}anchorOf(e){const t=this.sketch,n=e.refs.find(r=>r!=="origin");if(!n)return null;if(n in t.points)return t.points[n];const i=t.entities.find(r=>r.id===n);if(!i)return null;if(i.kind==="line")return[(t.points[i.p[0]][0]+t.points[i.p[1]][0])/2,(t.points[i.p[0]][1]+t.points[i.p[1]][1])/2];if(i.kind==="circle")return[t.points[i.c][0]+i.r*Math.SQRT1_2,t.points[i.c][1]+i.r*Math.SQRT1_2];if(i.kind==="arc"){const r=Nt(t,i);return r?[r.c[0]+r.r*Math.cos(r.a0+r.sweep/2),r.c[1]+r.r*Math.sin(r.a0+r.sweep/2)]:null}const o=tt(t,n);return o?t.points[o]:null}}function pa(s,e){const t=e==null?"?":ti(e),n=s.kind==="angle"?`${t}°`:`${s.kind==="radius"?"R":s.kind==="diameter"?"⌀":""}${t} mm`;return s.driving?n:`(${n})`}const ma={select:"M6 3l12 9-5.5 1L15 19l-2.5 1.2-2.6-6L6 17z",line:J.line,rectangle:J.rectangle,circle:J.circle,arc:J.arc,spline:"M4 17c3-9 6-9 8-5s5 4 8-5 M4 17h0 M20 7h0",point:J.point,fillet:"M5 20V12a7 7 0 0 1 7-7h7 M5 20h0 M19 5h0",dimension:J.dimension},Ts={select:"Click a point, curve or dimension; Shift adds to the selection. Drag a point to move it; double-click a dimension to change it.",line:"Click point after point; back on the first point closes the outline. Double-click or Enter ends the chain.",rectangle:"Click two opposite corners.",circle:"Click the centre, then a point on the circle.",arc:"Click the start, the end, then a point the arc passes through.",spline:"Click the points it passes through; double-click or Enter finishes.",point:"Click to place a point.",fillet:"Click a corner where two lines meet to round it.",dimension:"Pick a line, circle or arc (or two points or lines), then click where the dimension goes."};function ts(s){return Is(e=>s.subscribe(e),()=>s.version)}function ya({editor:s}){if(ts(s),!s.editing)return null;const e=s.status?.state??"unsolved",t=s.statusWords(),n=!s.busy&&s.sketch.entities.length>0&&!dt(s.sketch).rings.length;return D("div",{className:"t2d-sketchbar",role:"toolbar","aria-label":"Sketch","data-t2d-sketchbar":!0,children:[D("div",{className:"t2d-sketchbar-row",children:[v("span",{className:"t2d-sketchbar-title",children:s.body?.name??"Sketch"}),Object.keys($n).map(i=>v("button",{type:"button",className:`t2d-tool${s.tool===i?" is-on":""}`,"aria-pressed":s.tool===i,"aria-label":$n[i],title:`${$n[i]}: ${Ts[i]}`,"data-t2d-tool":i,onClick:()=>s.setTool(i),children:v(Ft,{path:ma[i],size:18})},i)),v("span",{className:"t2d-sep"}),v(he,{label:"Add relation",value:"",options:[{value:"",label:"Relation…"},...da.map(i=>({value:i,label:$r[i]}))],onChange:i=>i&&s.applyRelation(i)}),v(Re,{variant:"neutral",disabled:!s.selection.length,onClick:()=>s.toggleConstruction(),title:"Construction geometry guides the outline but is not part of the body",attrs:{"data-t2d-sketch-construction":"1"},children:"Construction"}),v(Re,{variant:"neutral",disabled:!s.selection.length,onClick:()=>s.deleteSelection(),title:"Delete",attrs:{"data-t2d-sketch-delete":"1"},children:"Delete"}),v("span",{className:"t2d-sep"}),v(Re,{variant:"primary",onClick:()=>s.close(),title:"Esc",attrs:{"data-t2d-sketch-done":"1"},children:"Done"})]}),D("div",{className:"t2d-sketchbar-row t2d-sketchbar-status",children:[v("span",{className:`t2d-sketch-chip t2d-sketch-chip--${n?"open":e}`,"data-t2d-sketch-status":n?"open":e,children:t}),v("span",{className:"t2d-sketch-help",children:Ts[s.tool]})]}),s.message?v("div",{className:"t2d-sketch-message",role:"status","data-t2d-sketch-message":!0,children:s.message}):null]})}function ga({editor:s}){ts(s);const e=s.editingDim;return!e||!s.editing?null:v(xa,{editor:s,d:e},`${e.id}:${e.x}:${e.y}`)}function xa({editor:s,d:e}){const[t,n]=be(e.text),[i,o]=be(""),r=Qe(null);fe(()=>{r.current?.focus(),r.current?.select()},[]);const a=()=>s.cancelDimensionEdit();return D("div",{className:"t2d-dim-edit",style:{left:e.x,top:e.y},"data-t2d-dim-edit":e.id,children:[v("input",{ref:r,className:"mgk-input","aria-label":"Dimension value","aria-invalid":i?!0:void 0,value:t,onChange:c=>n(c.target.value),onKeyDown:c=>{if(c.stopPropagation(),c.key==="Enter"){const l=s.setDimension(e.id,t);o(l??"")}else c.key==="Escape"&&a()},onBlur:()=>{s.editingDim?.id===e.id&&a()}}),i?v("div",{className:"t2d-dim-error",role:"alert","data-t2d-dim-error":!0,children:i}):null]})}const ba=new Intl.NumberFormat("en-US",{maximumSignificantDigits:3}),Te=s=>ba.format(s);function vt({title:s,children:e,attr:t}){return D("section",{className:"t2d-section","data-t2d-section":t??s.toLowerCase(),children:[v("h2",{className:"t2d-section-title",children:s}),v("div",{className:"t2d-section-body",children:e})]})}const Vn=s=>s==="imperial"?"ft":"m";function Es({label:s,value:e,onCommit:t,error:n,attr:i}){const[o,r]=be(e);return fe(()=>r(e),[e]),v("span",{className:"mgk-type mgk-value-row",children:v("input",{className:"mgk-input mgk-input--wide","aria-label":s,value:o,"data-t2d-text":i,"aria-invalid":n?!0:void 0,onChange:a=>r(a.target.value),onBlur:()=>o!==e&&t(o),onKeyDown:a=>{a.key==="Enter"&&a.target.blur(),a.key==="Escape"&&(r(e),a.target.blur())}})})}function va(s){return s==null||s<150?10:s<250?5:3}function wa({store:s,engine:e,units:t}){const n=pe(s,f=>f.scene),i=pe(s,f=>f.selected),[,o]=be(0);fe(()=>e.subscribe(()=>o(f=>f+1)),[e]);const r=f=>s.commit({...n,flow:{...n.flow,...f}}),a=f=>f.enabled&&qt(f.shape),c=n.bodies.find(f=>f.id===i&&qt(f.shape))??n.bodies.find(a)??null,l=c?e.reynoldsFor(c):null,u=e.lattice,h=e.flowModel,d=c?e.cellsAcross(c):null;return D(vt,{title:"Wind",children:[v(q,{label:"Wind speed",help:"The speed of the flow coming in at the left.",children:v(je,{label:"Wind speed",quantity:"velocity",units:t,valueSi:n.flow.speed,onCommitSi:f=>r({speed:Math.min(Q.speed[1],Math.max(Q.speed[0],f))})})}),v(q,{label:"Fluid",children:v(he,{label:"Fluid",value:n.flow.fluid,options:Object.entries(yt).map(([f,y])=>({value:f,label:y.label})),onChange:f=>r({fluid:f})})}),v(q,{label:"Flow model",help:"Resolved: the grid's own flow, exact when the grid resolves the Reynolds number, otherwise run at the highest one it does. Turbulence model: Spalart–Allmaras with wall functions, at the real Reynolds number. Auto: the turbulence model from a Reynolds number of 100,000 up.",children:v(he,{label:"Flow model",value:n.flow.model,options:[{value:"auto",label:`Auto (${h==="sa"?"turbulence model":"resolved"})`},{value:"resolved",label:"Resolved"},{value:"sa",label:"Turbulence model (SA)"}],onChange:f=>r({model:f})})}),c&&l?D("div",{className:"t2d-re","data-t2d-re":!0,"data-real":l.real,"data-sim":l.sim,"data-t2d-model":h,children:[v("div",{className:"t2d-re-row",children:D("span",{children:["Reynolds number (",rn(c.shape),", ",Te(Se(c.shape))," m)"]})}),D("div",{className:"t2d-re-row",children:[v("span",{className:"t2d-re-k",children:"Real"}),v("span",{className:"t2d-re-v","data-t2d-re-real":!0,children:Te(l.real)}),v("span",{className:"t2d-re-k",children:"Simulated"}),v("span",{className:"t2d-re-v","data-t2d-re-sim":!0,children:Te(l.sim)})]}),h==="sa"?v(H,{tone:l.real<3e5?"warning":void 0,children:D("span",{"data-t2d-model-note":"sa",children:["Turbulence model on (Spalart–Allmaras, wall functions) at the real Reynolds number. It gives the mean flow: attached boundary layers, stall to within a few degrees, and lift to within about ",va(d)," % with ",Te(Math.round(d??0))," cells across the body",(d??0)<250?" (Refine near bodies narrows it)":"",". Drag reads high (up to about twice the real drag at this resolution), and past the stall the flow is not reliable. Turbulent eddies themselves are not drawn: 2D turbulence is not the real, 3D kind.",l.real<3e5?" Below a Reynolds number of about 300,000, real airfoils often have laminar separation bubbles this model does not capture.":""]})}):u&&!u.capped?v(H,{children:v("span",{"data-t2d-model-note":"resolved",children:"The grid resolves this Reynolds number: the flow runs as it is, with no model (exact in two dimensions)."})}):u?.capped?v(H,{tone:"warning",children:D("span",{"data-t2d-model-note":"capped",children:["This grid resolves a Reynolds number of about ",Te(l.sim)," here, so the flow is simulated at that, not at ",Te(l.real),". Wakes, shedding and separation show as they do at the lower Reynolds number, and so do the forces. A finer resolution raises it",l.real>=1e5?"; the turbulence model runs the real one":"","."]})}):null]}):v(H,{children:n.bodies.length?"No body is in the flow: put one in to see its Reynolds number.":"Add a body to see its Reynolds number."})]})}function ka({store:s,engine:e,units:t}){const n=pe(s,c=>c.scene),[,i]=be(0);fe(()=>e.subscribe(()=>i(c=>c+1)),[e]);const o=c=>s.commit({...n,tunnel:{...n.tunnel,...c}}),r=e.grid,a=c=>{const l=zn(n,at[c]);return`${c[0].toUpperCase()}${c.slice(1)} (${l.nx} × ${l.ny})`};return D(vt,{title:"Tunnel",children:[v(q,{label:"Length",help:"The tunnel from inlet to outlet.",children:v(je,{label:"Length",quantity:"length",unit:Vn(t),units:t,valueSi:n.tunnel.length,onCommitSi:c=>o({length:Math.min(Q.length[1],Math.max(Q.length[0],c))})})}),v(q,{label:"Height",children:v(je,{label:"Height",quantity:"length",unit:Vn(t),units:t,valueSi:n.tunnel.height,onCommitSi:c=>o({height:Math.min(Q.height[1],Math.max(Q.height[0],c))})})}),v(q,{label:"Walls",help:"Open: no walls; the free stream goes on beyond the top and bottom, and waves and wakes pass out through them (a body in open air). Slip walls let the flow slide along them. Solid walls have boundary layers, like a real tunnel. Periodic: what leaves at the top comes in at the bottom.",children:v(he,{label:"Walls",value:n.tunnel.walls,options:[{value:"farfield",label:"Open (no walls)"},{value:"slip",label:"Slip walls"},{value:"noslip",label:"Solid"},{value:"periodic",label:"Periodic"}],onChange:c=>o({walls:c})})}),v(q,{label:"Resolution",help:"Cells in the grid. Finer grids show more detail and a higher Reynolds number, and run slower. Auto picks the finest this GPU runs smoothly.",children:v(he,{label:"Resolution",value:n.tunnel.resolution,options:[{value:"auto",label:n.tunnel.resolution==="auto"&&r?`Auto (${r.nx} × ${r.ny})`:"Auto"},...["low","medium","high","ultra"].map(c=>({value:c,label:a(c)}))],onChange:c=>o({resolution:c})})}),v(q,{label:"Refine near bodies",help:"Cells half (x2) or a quarter (x4) the size round each body, moving with it: thinner boundary layers, sharper leading and trailing edges, and, when the flow is resolved, twice or four times the Reynolds number near the body. The flow runs about 3 or 7 times slower. At a real Reynolds number of millions, drag still reads high: that needs cells far smaller than any real-time grid.",children:v(he,{label:"Refine near bodies",value:String(n.tunnel.refine),options:[{value:"0",label:"Off"},{value:"1",label:"x2 finer"},{value:"2",label:"x4 finer"}],onChange:c=>o({refine:Number(c)}),disabled:!!e.refineUnavailable})}),e.refineUnavailable?v(H,{tone:"warning",children:e.refineUnavailable}):null,v(H,{children:"The shaded strips at the inlet and the outlet absorb pressure waves; the flow there is not physical."})]})}const Ma=[{value:"particles",label:"Flow with particles"},{value:"vorticity",label:"Vorticity"},{value:"speed",label:"Speed"},{value:"pressure",label:"Pressure (Cp)"},{value:"schlieren",label:"Density gradient (schlieren)"},{value:"rheoscopic",label:"Rheoscopic (flakes in a tank)"},{value:"none",label:"None (markers on a dark background)"}];function Pa({store:s}){const e=pe(s,n=>n.scene),t=n=>s.commit({...e,view:{...e.view,...n}},!1);return D(vt,{title:"View",children:[v(q,{label:"Show",children:v(he,{label:"Show",value:e.view.field,options:Ma,onChange:n=>t({field:n})})}),e.view.field==="particles"?v(q,{label:"Colour by",help:"The flow's speed or its vorticity, drawn under the particles; each particle is a lighter shade of the colour where it is.",children:v(he,{label:"Colour by",value:e.view.particleColor,options:[{value:"speed",label:"Speed"},{value:"vorticity",label:"Vorticity"}],onChange:n=>t({particleColor:n})})}):null,e.view.field==="rheoscopic"?v(q,{label:"Flakes",help:"How the tank looks: the flakes' colour and the two lights over it. Flakes lie flat and tilt with the flow, and catch the light where the flow shears and turns; still water goes dull.",children:v(he,{label:"Flakes",value:e.view.rheoPreset,options:[{value:"kalliroscope",label:"Kalliroscope blue"},{value:"pearl",label:"Pearl"},{value:"copper",label:"Copper"}],onChange:n=>t({rheoPreset:n})})}):null,v(q,{label:"Colour range",help:"Automatic follows the flow; turn it off to fix the range (in the legend's units).",children:v(ut,{label:"Automatic colour range",checked:e.view.autoRange,onChange:n=>t({autoRange:n})})}),v(q,{label:"Run speed",help:"As fast as possible runs as many steps as the GPU manages each frame. Real time slows it to the speed of the real flow, when the GPU is fast enough.",children:v(he,{label:"Run speed",value:e.view.speed,options:[{value:"max",label:"As fast as possible"},{value:"realtime",label:"Real time"}],onChange:n=>t({speed:n})})})]})}function ns(s,e,t){const{length:n,height:i}=s.tunnel,o=Un(sn(e)),r=s.bodies.map(l=>({x:l.x,y:l.y,r:Un(sn(l.shape))})),a=(l,u)=>r.every(h=>Math.hypot(h.x-l,h.y-u)>(h.r+o)*1.1);let c={x:n*.35,y:i/2};e:for(const l of[.3,.42,.54,.66,.24])for(const u of[.5,.3,.7,.2,.8]){const h=n*l,d=i*u;if(!(d-o<0||d+o>i)&&a(h,d)){c={x:h,y:d};break e}}return{id:pn(),name:t,shape:e,x:c.x,y:c.y,angle:0,spin:0,enabled:!0,locked:!1}}function _s(s,e){const t=s.get().scene,n=t.tunnel.height,i={naca:[{kind:"naca",code:"0012",chord:n/4},"NACA 0012"],circle:[{kind:"circle",diameter:n/10},"Cylinder"],rect:[{kind:"rect",width:n/8,height:n/8},"Rectangle"],ellipse:[{kind:"ellipse",width:n/5,height:n/10},"Ellipse"],plate:[{kind:"plate",length:n/4,thickness:n/80},"Flat plate"]},[o,r]=i[e],a=ns(t,o,r);s.commit({...t,bodies:[...t.bodies,a]}),s.select(a.id)}function Sa(s,e){const t=s.get().scene,n=t.bodies.filter(r=>r.shape.kind==="sketch").length,i=n?`Sketch ${n+1}`:"Sketch",o=ns(t,{kind:"sketch",name:i,sketch:ni()},i);s.commit({...t,bodies:[...t.bodies,o]}),e.open(o.id,"line")}function Aa(s){if(s.kind!=="sketch")return"";const e=dt(s.sketch);return e.rings.length?"":s.sketch.entities.some(t=>!t.construction&&t.kind!=="point")?e.branch.length?`Its outline branches (${e.branch.length===1?"a point where three or more curves meet":`${e.branch.length} points where three or more curves meet`}): a body’s outline is a closed loop.`:e.open.length?`Its outline is not closed (${e.open.length} open ${e.open.length===1?"end":"ends"}, circled in red): join them to close it.`:"It has no closed outline.":"It has no outline yet: draw a closed outline."}function Ba({store:s,ws:e,editor:t}){const n=pe(s,l=>l.scene),i=pe(s,l=>l.selected),o=Qe(null),r=n.bodies.length>=Q.maxBodies,a=async l=>{try{const u=po(await l.text(),l.name),h=s.get().scene,d=ns(h,{kind:"dat",name:u.name,x:u.x,y:u.y,chord:h.tunnel.height/4},u.name);s.commit({...h,bodies:[...h.bodies,d]}),s.select(d.id),e.ui.toast(u.warnings.length?`Imported ${u.name}. ${u.warnings.join(" ")}`:`Imported ${u.name}.`,{kind:"success"})}catch(u){e.ui.toast(u instanceof Be?`${l.name}: ${u.message}`:`${l.name} could not be read: ${String(u)}`,{kind:"error"})}},c=l=>{const u=s.get().scene;s.commit({...u,bodies:u.bodies.filter(h=>h.id!==l.id)}),e.ui.toast(`Removed ${l.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})};return D(vt,{title:"Bodies",children:[D("div",{className:"t2d-add-row",children:[v(Re,{variant:"secondary",disabled:r,onClick:()=>_s(s,"naca"),attrs:{"data-t2d-add":"naca"},children:"Add airfoil"}),v(he,{label:"Add shape",value:"",disabled:r,options:[{value:"",label:"Add shape…"},{value:"circle",label:"Cylinder"},{value:"rect",label:"Rectangle"},{value:"ellipse",label:"Ellipse"},{value:"plate",label:"Flat plate"},{value:"sketch",label:"Sketch…"}],onChange:l=>l==="sketch"?Sa(s,t):l&&_s(s,l)}),v(Re,{variant:"neutral",disabled:r,onClick:()=>o.current?.click(),attrs:{"data-t2d-import":"1"},children:"Import .dat…"}),v("input",{ref:o,type:"file",accept:".dat,.txt",hidden:!0,"data-t2d-file":!0,onChange:l=>{const u=l.target.files?.[0];l.target.value="",u&&a(u)}})]}),r?D(H,{tone:"warning",children:["A tunnel holds at most ",Q.maxBodies," bodies."]}):null,n.bodies.length===0?v(H,{children:"No bodies yet: add an airfoil or a shape, or import an airfoil’s .dat file."}):null,v("ul",{className:"t2d-body-list",role:"listbox","aria-label":"Bodies",children:n.bodies.map(l=>D("li",{role:"option","aria-selected":l.id===i,className:`t2d-body-row${l.id===i?" is-selected":""}${l.enabled?"":" is-off"}`,"data-t2d-body":l.id,onClick:()=>s.select(l.id),children:[v("span",{className:"t2d-body-name",children:l.name}),v("span",{className:"t2d-body-kind",children:rn(l.shape)===l.name?"":rn(l.shape)}),v("button",{type:"button",className:"t2d-icon-btn",title:l.enabled?"Take it out of the flow":"Put it in the flow","aria-label":l.enabled?`Take ${l.name} out of the flow`:`Put ${l.name} in the flow`,"aria-pressed":l.enabled,onClick:u=>{u.stopPropagation(),s.updateBody(l.id,{enabled:!l.enabled})},children:v(Ft,{path:l.enabled?"M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6":"M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6",size:14})}),v("button",{type:"button",className:"t2d-icon-btn",title:`Remove ${l.name}`,"aria-label":`Remove ${l.name}`,onClick:u=>{u.stopPropagation(),c(l)},children:v(Ft,{name:"trash",size:14})})]},l.id))})]})}function Us(s,e){const t=s.spinCap(e.id);return t!==null&&Math.abs(e.spin)>t?t:null}function Ra({store:s,ws:e,units:t,engine:n,editor:i}){ts(i);const o=pe(s,x=>x.scene),r=pe(s,x=>x.selected),[a,c]=be(""),l=o.bodies.find(x=>x.id===r);if(fe(()=>c(""),[r]),!l)return v(vt,{title:"Body",attr:"body",children:v(H,{children:"Select a body to edit it. Drag a body to move it, and drag the round handle above it to turn it (Shift: whole degrees)."})});const u=Vn(t),h=x=>s.updateBody(l.id,x),d=x=>h({shape:{...l.shape,...x}}),f=x=>Math.max(1e-4,Math.min(1e3,x)),y=(x,w,k,S)=>v(q,{label:x,help:S,children:v(je,{label:x,quantity:"length",unit:u,units:t,valueSi:w,onCommitSi:b=>k(f(b))})});let p=null;switch(l.shape.kind){case"naca":{const x=l.shape.code;p=D(Vt,{children:[v(q,{label:"NACA designation",help:"4 or 5 digits, such as 2412 or 23012.",children:v(Es,{label:"NACA designation",attr:"naca",value:x,error:a,onCommit:w=>{try{const k=jn(w);c("");const S=l.name===`NACA ${x}`?`NACA ${k}`:l.name;h({shape:{...l.shape,code:k},name:S})}catch(k){c(k instanceof Xe?k.message:String(k))}}})}),a?v(H,{tone:"danger",children:v("span",{"data-t2d-naca-error":!0,children:a})}):null,y("Chord",l.shape.chord,w=>d({chord:w}))]});break}case"dat":p=y("Chord",l.shape.chord,x=>d({chord:x}));break;case"circle":p=y("Diameter",l.shape.diameter,x=>d({diameter:x}));break;case"rect":case"ellipse":p=D(Vt,{children:[y("Width",l.shape.width,x=>d({width:x}),"Along the flow, before turning."),y("Height",l.shape.height,x=>d({height:x}))]});break;case"sketch":{const x=i.editing&&i.bodyId===l.id,w=Aa(l.shape);p=D(Vt,{children:[v("div",{className:"t2d-add-row",children:x?v(Re,{variant:"primary",onClick:()=>i.close(),attrs:{"data-t2d-sketch-done":"panel"},children:"Done"}):v(Re,{variant:"secondary",onClick:()=>i.open(l.id,"select"),attrs:{"data-t2d-sketch-edit":l.id},children:"Edit sketch"})}),w?v(H,{tone:"warning",children:D("span",{"data-t2d-sketch-problem":!0,children:["Not in the flow. ",w]})}):D(H,{children:["Size ",Te(Se(l.shape)*1e3)," mm across. Its origin is the body’s pivot: position and angle move and turn it about there."]})]});break}case"plate":p=D(Vt,{children:[y("Length",l.shape.length,x=>d({length:x})),y("Thickness",l.shape.thickness,x=>d({thickness:x}),"A plate thinner than about two cells of the grid is drawn thicker than it is.")]});break}const m=n.lattice?.dx??0,g=l.shape.kind==="plate"&&m>0&&l.shape.thickness<2*m;return D(vt,{title:"Body",attr:"body",children:[v(q,{label:"Name",children:v(Es,{label:"Name",attr:"name",value:l.name,onCommit:x=>h({name:x.trim().slice(0,80)||l.name})})}),v("div",{className:"t2d-shape-kind",children:rn(l.shape)}),p,g?D(H,{tone:"warning",children:["This plate is thinner than two grid cells (",Te(qi("length",2*m,t==="imperial"?"in":"mm"))," ",t==="imperial"?"in":"mm","): the flow sees a thicker one."]}):null,y("Position x",l.x,x=>h({x:Math.min(o.tunnel.length,Math.max(0,x))}),l.shape.kind==="naca"||l.shape.kind==="dat"?"Of the quarter chord, from the inlet.":"Of the centre, from the inlet."),v(q,{label:"Position y",help:"From the bottom wall.",children:v(je,{label:"Position y",quantity:"length",unit:u,units:t,valueSi:l.y,onCommitSi:x=>h({y:Math.min(o.tunnel.height,Math.max(0,x))})})}),v(q,{label:l.shape.kind==="naca"||l.shape.kind==="dat"?"Angle of attack":"Angle",help:"Positive raises the leading (left) side.",children:v(je,{label:"Angle",unit:"°",valueSi:l.angle,onCommitSi:x=>h({angle:Math.max(-180,Math.min(180,x))})})}),v(q,{label:"Spin",help:"Turns the body continuously; positive is counter-clockwise. A spinning cylinder shows the Magnus effect.",children:v(je,{label:"Spin",quantity:"angular_velocity",unit:"rpm",units:t,valueSi:l.spin,onCommitSi:x=>h({spin:Math.max(-1e4,Math.min(1e4,x))})})}),Us(n,l)?v(H,{tone:"warning",children:D("span",{"data-t2d-spin-capped":!0,children:["This spin is held to ",Te(Us(n,l)*(60/(2*Math.PI)))," rpm: the body’s edge would move faster than twice the wind speed, more than the lattice can carry."]})}):null,v(q,{label:"In the flow",children:v(ut,{label:"In the flow",checked:l.enabled,onChange:x=>h({enabled:x})})}),v(q,{label:"Locked",help:"A locked body cannot be dragged or turned with the mouse.",children:v(ut,{label:"Locked",checked:l.locked,onChange:x=>h({locked:x})})}),v("div",{className:"t2d-panel-foot",children:v(Re,{variant:"danger",onClick:()=>{const x=s.get().scene;s.commit({...x,bodies:x.bodies.filter(w=>w.id!==l.id)}),e.ui.toast(`Removed ${l.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})},attrs:{"data-t2d-remove":l.id},children:"Remove body"})})]})}const Ca={streaks:"Streaks",timelines:"Timelines",dye:"Dye"},$a=["Blue","Purple","Green","Orange","Sky blue","Pink"],Ta=s=>`var(--mg-series-${s%an+1})`;function Ei({title:s,children:e,attr:t}){return D("section",{className:"t2d-section","data-t2d-section":t,children:[v("h2",{className:"t2d-section-title",children:s}),v("div",{className:"t2d-section-body",children:e})]})}function Ze(s,e){const t=s.rakes.filter(n=>n.kind===e.kind);return`${Ca[e.kind]} ${t.indexOf(e)+1}`}function Ea(s,e){const t=s.get().scene,{length:n,height:i}=t.tunnel,o=new Set(t.rakes.map(u=>u.color));let r=0;for(;o.has(r)&&r<an-1;)r++;const a=t.rakes.length,c=n*(.1+.02*(a%4)),l={id:fi(),kind:e,x0:c,y0:i*.3,x1:c,y1:i*.7,emitters:e==="dye"?7:12,color:r,enabled:!0};s.commit({...t,rakes:[...t.rakes,l]}),s.select(l.id)}function _a({store:s,ws:e}){const t=pe(s,l=>l.scene),n=pe(s,l=>l.selected),i=t.view,o=l=>s.commit({...t,view:{...i,...l}},!1),r=t.rakes.filter(l=>l.kind==="dye").length,a=t.rakes.length>=Q.maxRakes,c=l=>{const u=s.get().scene;s.commit({...u,rakes:u.rakes.filter(h=>h.id!==l.id)}),e.ui.toast(`Removed ${Ze(t,l)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})};return D(Ei,{title:"Flow markers",attr:"markers",children:[i.field==="particles"?v(H,{children:"The particles view shows the tracer particles; here you set how many and their trails."}):v(q,{label:"Tracer particles",help:"Particles carried by the flow, drawn faintly over the field.",children:v(ut,{label:"Tracer particles",checked:i.tracers,onChange:l=>o({tracers:l})})}),v(q,{label:"Particle count",children:v(he,{label:"Particle count",value:i.density,disabled:!i.tracers&&i.field!=="particles",options:[{value:"low",label:"Few"},{value:"normal",label:"Normal"},{value:"high",label:"Many"}],onChange:l=>o({density:l})})}),v(q,{label:"Streaks",help:"Each particle is drawn as a short streak along its motion.",children:v(he,{label:"Streaks",value:i.trail,options:[{value:"off",label:"Dots"},{value:"short",label:"Short"},{value:"long",label:"Long"}],onChange:l=>o({trail:l})})}),v(q,{label:"Velocity arrows",children:v(ut,{label:"Velocity arrows",checked:i.arrows,onChange:l=>o({arrows:l})})}),v(q,{label:"Streamlines",help:"Lines along the flow’s direction now, from just past the inlet. In shedding flow they differ from the particles’ paths.",children:v(ut,{label:"Streamlines",checked:i.streamlines,onChange:l=>o({streamlines:l})})}),v("div",{className:"t2d-add-row",children:v(he,{label:"Add rake",value:"",disabled:a,options:[{value:"",label:"Add rake…"},{value:"streaks",label:"Streaks (a thread from each emitter)"},{value:"timelines",label:"Timelines (a line released at intervals)"},{value:"dye",label:"Dye",disabled:r>=Q.maxDyeRakes}],onChange:l=>l&&Ea(s,l)})}),a?D(H,{tone:"warning",children:["A tunnel holds at most ",Q.maxRakes," rakes."]}):null,r>=Q.maxDyeRakes?D(H,{children:["At most ",Q.maxDyeRakes," dye rakes: one colour each."]}):null,t.rakes.length?v("ul",{className:"t2d-body-list",role:"listbox","aria-label":"Rakes",children:t.rakes.map(l=>D("li",{role:"option","aria-selected":l.id===n,className:`t2d-body-row${l.id===n?" is-selected":""}${l.enabled?"":" is-off"}`,"data-t2d-rake":l.id,onClick:()=>s.select(l.id),children:[v("span",{className:"t2d-swatch",style:{background:Ta(l.color)}}),v("span",{className:"t2d-body-name",children:Ze(t,l)}),v("span",{className:"t2d-body-kind"}),v("button",{type:"button",className:"t2d-icon-btn","aria-pressed":l.enabled,"aria-label":l.enabled?`Stop ${Ze(t,l)}`:`Start ${Ze(t,l)}`,title:l.enabled?"Stop it":"Start it",onClick:u=>{u.stopPropagation();const h=s.get().scene;s.commit({...h,rakes:h.rakes.map(d=>d.id===l.id?{...d,enabled:!d.enabled}:d)})},children:v(Ft,{path:l.enabled?"M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6":"M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6",size:14})}),v("button",{type:"button",className:"t2d-icon-btn","aria-label":`Remove ${Ze(t,l)}`,title:"Remove it",onClick:u=>{u.stopPropagation(),c(l)},children:v(Ft,{name:"trash",size:14})})]},l.id))}):v(H,{children:"A rake releases streaks, timelines or dye from a line you place and drag in the tunnel."})]})}function Ua({store:s,ws:e,units:t,rake:n}){const i=pe(s,f=>f.scene),o=t==="imperial"?"ft":"m",r=f=>{const y=s.get().scene;s.commit({...y,rakes:y.rakes.map(p=>p.id===n.id?{...p,...f}:p)})},{length:a,height:c}=i.tunnel,l=f=>Math.min(a,Math.max(0,f)),u=f=>Math.min(c,Math.max(0,f)),h=i.rakes.filter(f=>f.kind==="dye"&&f.id!==n.id).length,d=(f,y,p)=>v(q,{label:f,children:v(je,{label:f,quantity:"length",unit:o,units:t,valueSi:y,onCommitSi:p})});return D(Ei,{title:"Rake",attr:"rake",children:[v("div",{className:"t2d-shape-kind","data-t2d-rake-name":!0,children:Ze(i,n)}),v(q,{label:"Releases",children:v(he,{label:"Releases",value:n.kind,options:[{value:"streaks",label:"Streaks"},{value:"timelines",label:"Timelines"},{value:"dye",label:"Dye",disabled:h>=Q.maxDyeRakes}],onChange:f=>r({kind:f})})}),n.kind!=="timelines"?v(q,{label:"Emitters",help:"Points along the rake that release the markers.",children:v(je,{label:"Emitters",valueSi:n.emitters,onCommitSi:f=>r({emitters:Math.round(Math.min(Q.emitters[1],Math.max(Q.emitters[0],f)))})})}):null,v(q,{label:"Colour",children:v(he,{label:"Colour",value:String(n.color),options:$a.map((f,y)=>({value:String(y),label:f})),onChange:f=>r({color:Number(f)})})}),d("Start x",n.x0,f=>r({x0:l(f)})),d("Start y",n.y0,f=>r({y0:u(f)})),d("End x",n.x1,f=>r({x1:l(f)})),d("End y",n.y1,f=>r({y1:u(f)})),v(q,{label:"Releasing",children:v(ut,{label:"Releasing",checked:n.enabled,onChange:f=>r({enabled:f})})}),v(H,{children:"Drag the rake to move it, or one of its ends to stretch or turn it."}),v("div",{className:"t2d-panel-foot",children:v(Re,{variant:"danger",attrs:{"data-t2d-remove-rake":n.id},onClick:()=>{const f=s.get().scene;s.commit({...f,rakes:f.rakes.filter(y=>y.id!==n.id)}),e.ui.toast(`Removed ${Ze(i,n)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})},children:"Remove rake"})})]})}const Da=26,Tn=7,Kt=new Map;function Fa(s){const e=JSON.stringify(s.shape);let t=Kt.get(e);return t||(t=sn(s.shape),Kt.size>64&&Kt.clear(),Kt.set(e,t)),t}function ct(s,e){return cn(Fa(s),{x:e.x,y:e.y,theta:-e.angle*Math.PI/180})}function _i(s,e){const t=s.worldView,n=(a,c)=>({x:t.w/2+(a-t.cx)/t.mpp,y:t.h/2-(c-t.cy)/t.mpp}),i=s.livePose(e.id)??{x:e.x,y:e.y,angle:e.angle};let o=n(0,i.y).y;for(const a of ct(e,i))for(let c=1;c<a.length;c+=2)o=Math.min(o,n(0,a[c]).y);const r=n(i.x,i.y);return{x:r.x,y:o-Da,cx:r.x,cy:r.y}}function en(s,e){const t=s.worldView,{length:n,height:i}=e.tunnel,o=Math.max(n/Math.max(50,t.w-32),i/Math.max(50,t.h-32));s.worldView={...t,cx:n/2,cy:i/2,mpp:o}}function Ia(s){const e=(t,n)=>s.getPropertyValue(t).trim()||n;return{under:e("--t2d-sketch-under","blue"),fully:e("--t2d-sketch-full","black"),over:e("--t2d-sketch-over","red"),construction:e("--t2d-sketch-construction","gray"),pick:e("--t2d-sketch-pick","green"),halo:e("--t2d-sketch-halo","white"),preview:e("--t2d-sketch-preview","blue")}}function Oa({engine:s,store:e,editor:t,onStatus:n}){const i=Qe(null),o=Qe({t:0,x:0,y:0,n:0}),r=Qe(null),a=Qe(null),c=Qe(null),l=Qe("");fe(()=>{const b=i.current,M=new ResizeObserver(()=>{const A=b.getBoundingClientRect(),B=window.devicePixelRatio||1,R=s.canvas;R.width=Math.max(1,Math.round(A.width*B)),R.height=Math.max(1,Math.round(A.height*B));const C=a.current;C.width=R.width,C.height=R.height,s.worldView={...s.worldView,w:A.width,h:A.height,dpr:B};const E=e.get().scene,_=`${E.tunnel.length}x${E.tunnel.height}`;l.current!==_&&(en(s,E),l.current=_)});return M.observe(b),()=>M.disconnect()},[s,e]),fe(()=>{const b=r.current;return b.replaceWith(s.canvas),s.canvas.className="t2d-canvas",s.canvas.setAttribute("data-t2d-canvas","1"),()=>{s.canvas.replaceWith(b)}},[s]),fe(()=>e.subscribe(()=>{const b=e.get().scene,M=`${b.tunnel.length}x${b.tunnel.height}`;l.current&&l.current!==M&&(en(s,b),l.current=M)}),[s,e]);const u=(b,M)=>{const A=i.current.getBoundingClientRect(),B=s.worldView;return{x:B.cx+(b-A.left-B.w/2)*B.mpp,y:B.cy-(M-A.top-B.h/2)*B.mpp}},h=(b,M)=>{const A=s.worldView;return{x:A.w/2+(b-A.cx)/A.mpp,y:A.h/2-(M-A.cy)/A.mpp}},d=b=>s.livePose(b.id)??{x:b.x,y:b.y,angle:b.angle},f=b=>_i(s,b);fe(()=>{let b=0;const M=getComputedStyle(document.documentElement),A=M.getPropertyValue("--t2d-select").trim()||"black",B=M.getPropertyValue("--t2d-ghost").trim()||"gray",R=M.getPropertyValue("--mg-bg").trim()||"white",C=Ia(M),E=()=>{b=requestAnimationFrame(E);const _=a.current;if(!_)return;const P=_.getContext("2d"),T=s.worldView;P.setTransform(T.dpr,0,0,T.dpr,0,0),P.clearRect(0,0,T.w,T.h);const{scene:$,selected:U}=e.get(),I=c.current;for(const F of $.rakes){const we=M.getPropertyValue(`--mg-series-${F.color%6+1}`).trim()||A,le=h(F.x0,F.y0),K=h(F.x1,F.y1),ke=F.id===U;if(P.globalAlpha=F.enabled?1:.45,P.beginPath(),P.moveTo(le.x,le.y),P.lineTo(K.x,K.y),P.strokeStyle=we,P.lineWidth=ke?3:2,P.setLineDash(F.kind==="timelines"?[6,4]:[]),P.stroke(),P.setLineDash([]),F.kind!=="timelines"){P.fillStyle=we;for(let z=0;z<F.emitters;z++){const G=F.emitters===1?.5:z/(F.emitters-1);P.beginPath(),P.arc(le.x+(K.x-le.x)*G,le.y+(K.y-le.y)*G,2.5,0,Math.PI*2),P.fill()}}if(ke)for(const z of[le,K])P.fillStyle=R,P.strokeStyle=we,P.lineWidth=2,P.fillRect(z.x-5,z.y-5,10,10),P.strokeRect(z.x-5,z.y-5,10,10);P.globalAlpha=1}const W=t?.editing?t.bodyId:null;for(const F of $.bodies){const we=F.id===U&&F.id!==W,le=I&&(I.kind==="move"||I.kind==="turn")&&I.id===F.id?{x:I.kind==="move"?I.bodyX:I.x,y:I.kind==="move"?I.bodyY:I.y,angle:I.angle}:null,K=d(F),ke=z=>{P.beginPath();for(const G of z){for(let me=0;me<G.length;me+=2){const ye=h(G[me],G[me+1]);me===0?P.moveTo(ye.x,ye.y):P.lineTo(ye.x,ye.y)}P.closePath()}};if(F.shape.kind==="sketch"&&F.id!==W&&!qt(F.shape)){const z=-K.angle*Math.PI/180,G=Math.cos(z),me=Math.sin(z);P.beginPath();for(const ye of dt(F.shape.sketch).curves)ye.forEach(([te,Ie],it)=>{const Ee=h(K.x+(G*te-me*Ie)/1e3,K.y+(me*te+G*Ie)/1e3);it===0?P.moveTo(Ee.x,Ee.y):P.lineTo(Ee.x,Ee.y)});P.setLineDash([4,4]),P.strokeStyle=we?A:B,P.lineWidth=1.5,P.stroke(),P.setLineDash([])}if(F.enabled||(ke(ct(F,K)),P.setLineDash([4,4]),P.strokeStyle=B,P.lineWidth=1.5,P.stroke(),P.setLineDash([])),le&&(Math.abs(le.x-K.x)>1e-6||Math.abs(le.y-K.y)>1e-6||Math.abs(le.angle-K.angle)>.001)&&(ke(ct(F,le)),P.setLineDash([5,4]),P.strokeStyle=B,P.lineWidth=1.5,P.stroke(),P.setLineDash([])),we){if(ke(ct(F,K)),P.strokeStyle=A,P.lineWidth=2,P.stroke(),!F.locked){const G=f(F);P.beginPath(),P.moveTo(G.cx,G.cy),P.lineTo(G.x,G.y+Tn),P.strokeStyle=A,P.lineWidth=1,P.stroke(),P.beginPath(),P.arc(G.x,G.y,Tn,0,Math.PI*2),P.fillStyle=R,P.fill(),P.lineWidth=2,P.stroke()}const z=h(K.x,K.y);P.beginPath(),P.moveTo(z.x-5,z.y),P.lineTo(z.x+5,z.y),P.moveTo(z.x,z.y-5),P.lineTo(z.x,z.y+5),P.lineWidth=1.5,P.stroke()}}W&&t.draw(P,h,C)};return b=requestAnimationFrame(E),()=>cancelAnimationFrame(b)},[s,e,t]);const y=(b,M)=>{const A=e.get().scene.bodies;for(let B=A.length-1;B>=0;B--){const R=A[B];if(tn(ct(R,d(R)),b,M))return R}return null},p=(b,M)=>{const A=i.current.getBoundingClientRect(),B=b-A.left,R=M-A.top,{scene:C,selected:E}=e.get();for(let _=C.rakes.length-1;_>=0;_--){const P=C.rakes[_],T=h(P.x0,P.y0),$=h(P.x1,P.y1);if(P.id===E){if(Math.hypot(B-T.x,R-T.y)<=8)return{rake:P,part:"start"};if(Math.hypot(B-$.x,R-$.y)<=8)return{rake:P,part:"end"}}const U=$.x-T.x,I=$.y-T.y,W=U*U+I*I,F=W>0?Math.max(0,Math.min(1,((B-T.x)*U+(R-T.y)*I)/W)):0;if(Math.hypot(B-(T.x+F*U),R-(T.y+F*I))<=6)return{rake:P,part:"all"}}return null},m=(b,M)=>{const A=e.get().scene.tunnel;return{x:Math.min(A.length,Math.max(0,b)),y:Math.min(A.height,Math.max(0,M))}},g=b=>{b.target.setPointerCapture(b.pointerId);const M=u(b.clientX,b.clientY),A=s.worldView;if(b.button===1){c.current={kind:"pan",startX:b.clientX,startY:b.clientY,cx:A.cx,cy:A.cy};return}if(b.button!==0)return;if(t?.editing){b.preventDefault();const P=document.activeElement;P&&P!==document.body&&P.blur();const T=i.current.getBoundingClientRect(),$=o.current,U=performance.now(),I=U-$.t<400&&Math.hypot(b.clientX-$.x,b.clientY-$.y)<6?$.n+1:1;o.current={t:U,x:b.clientX,y:b.clientY,n:I},t.pointerDown(M.x,M.y,{x:b.clientX-T.left,y:b.clientY-T.top},{shift:b.shiftKey,clicks:I},h);return}const{scene:B,selected:R}=e.get(),C=B.bodies.find(P=>P.id===R);if(C&&!C.locked){const P=f(C),T=i.current.getBoundingClientRect();if(Math.hypot(b.clientX-T.left-P.x,b.clientY-T.top-P.y)<=Tn+4){const $=d(C),U=Math.atan2(M.y-$.y,M.x-$.x);c.current={kind:"turn",id:C.id,startAngle:C.angle,pointerStart:U,angle:C.angle,x:C.x,y:C.y};return}}const E=p(b.clientX,b.clientY);if(E){e.select(E.rake.id),c.current={kind:"rake",id:E.rake.id,part:E.part,startX:M.x,startY:M.y,r0:E.rake,before:e.get().scene};return}const _=y(M.x,M.y);if(_){e.select(_.id),_.locked||(c.current={kind:"move",id:_.id,startX:M.x,startY:M.y,bodyX:_.x,bodyY:_.y,angle:_.angle,moved:!1});return}e.select(null),c.current={kind:"pan",startX:b.clientX,startY:b.clientY,cx:A.cx,cy:A.cy}},x=b=>{const M=c.current;if(t?.editing&&(!M||M.kind!=="pan")){const R=u(b.clientX,b.clientY);t.pointerMove(R.x,R.y),i.current.style.cursor="crosshair";return}if(!M){const R=u(b.clientX,b.clientY),C=p(b.clientX,b.clientY),E=C?null:y(R.x,R.y);i.current.style.cursor=C?C.part==="all"?"move":"crosshair":E&&!E.locked?"grab":"default";return}if(M.kind==="rake"){const R=u(b.clientX,b.clientY),C=R.x-M.startX,E=R.y-M.startY,_=M.r0,P=m(_.x0+(M.part==="end"?0:C),_.y0+(M.part==="end"?0:E)),T=m(_.x1+(M.part==="start"?0:C),_.y1+(M.part==="start"?0:E)),$=e.get().scene;e.commit({...$,rakes:$.rakes.map(U=>U.id===M.id?{...U,x0:P.x,y0:P.y,x1:T.x,y1:T.y}:U)},!1);return}if(M.kind==="pan"){const R=s.worldView;s.worldView={...R,cx:M.cx-(b.clientX-M.startX)*R.mpp,cy:M.cy+(b.clientY-M.startY)*R.mpp};return}const A=u(b.clientX,b.clientY),B=e.get().scene.bodies.find(R=>R.id===M.id);if(B)if(M.kind==="move"){const R=m(B.x+(A.x-M.startX),B.y+(A.y-M.startY));M.bodyX=R.x,M.bodyY=R.y,M.moved=!0,i.current.style.cursor="grabbing",s.setTarget(M.id,{x:R.x,y:R.y,angle:M.angle}),n?.(`x ${R.x.toFixed(3)} m, y ${R.y.toFixed(3)} m`)}else{const R=d(B),C=Math.atan2(A.y-R.y,A.x-R.x);let E=M.startAngle-(C-M.pointerStart)*180/Math.PI;E=((E+180)%360+360)%360-180,b.shiftKey&&(E=Math.round(E)),M.angle=E,s.setTarget(M.id,{x:M.x,y:M.y,angle:E}),n?.(`Angle ${E.toFixed(1)}°`)}},w=()=>{const b=c.current;if(c.current=null,t?.editing&&!b){t.pointerUp();return}if(n?.(""),!(!b||b.kind==="pan")){if(b.kind==="rake"){const M=e.get().scene;M!==b.before&&e.commitFrom(b.before,M);return}b.kind==="move"&&b.moved&&e.updateBody(b.id,{x:b.bodyX,y:b.bodyY}),b.kind==="turn"&&e.updateBody(b.id,{angle:b.angle}),s.setTarget(b.id,null)}};return D("div",{ref:i,className:"t2d-viewport","data-t2d-viewport":!0,onPointerDown:g,onPointerMove:x,onPointerUp:w,onPointerCancel:w,onWheel:b=>{const M=s.worldView,A=u(b.clientX,b.clientY),B=e.get().scene.tunnel,R=Math.min(Math.max(B.length,B.height)/50,Math.max(B.length/1e5,M.mpp*Math.exp(b.deltaY*.0015)));s.worldView={...M,mpp:R};const C=u(b.clientX,b.clientY);s.worldView={...s.worldView,cx:s.worldView.cx+(A.x-C.x),cy:s.worldView.cy+(A.y-C.y)}},onDoubleClick:b=>{if(t?.editing)return;const M=u(b.clientX,b.clientY);y(M.x,M.y)||en(s,e.get().scene)},onContextMenu:b=>b.preventDefault(),children:[v("canvas",{ref:r}),v("canvas",{ref:a,className:"t2d-overlay"})]})}const Je=.02,Na=yt.water.nu,Yt={length:45,height:30,x:12};function At(s,e,t,n={}){const i=Et();return{...i,tunnel:{...i.tunnel,length:Yt.length*Je,height:Yt.height*Je,walls:"farfield",resolution:"high",refine:0},flow:{speed:s*Na/Je,fluid:"water",model:"resolved"},bodies:[{id:pn(),name:t,shape:e,x:Yt.x*Je,y:Yt.height/2*Je,angle:0,spin:0,enabled:!0,locked:!1}],rakes:[],view:{...i.view,field:"vorticity",autoRange:!0,streamlines:!!n.streamlines,tracers:!1}}}const Ht={kind:"circle",diameter:Je},Ui=[{id:"cylinder-re20",title:"Cylinder, Re 20: a steady wake",summary:"Slow flow past a cylinder: a small pair of standing vortices sits behind it and nothing sheds.",build:()=>({...At(20,Ht,"Cylinder",{streamlines:!0}),preset:"cylinder-re20"}),refs:{cd:[1.99,2.15],wake:[.88,.97]},sources:"Dennis & Chang 1970; Fornberg 1980; Park, Kwon & Choi 1998.",settle:120,window:20},{id:"cylinder-re40",title:"Cylinder, Re 40: twin vortices",summary:"The standing vortex pair has grown to over two diameters long, still steady: the last Reynolds number before the wake starts to shed.",build:()=>({...At(40,Ht,"Cylinder",{streamlines:!0}),preset:"cylinder-re40"}),refs:{cd:[1.5,1.6],wake:[2.13,2.35]},sources:"Dennis & Chang 1970; Fornberg 1980; Park, Kwon & Choi 1998; Tritton 1959 (experiment).",settle:160,window:20},{id:"cylinder-re100",title:"Cylinder, Re 100: the Kármán vortex street",summary:"The wake sheds vortices from each side in turn, at a Strouhal number of about 0.165, and the cylinder feels a lift that swings with them.",build:()=>({...At(100,Ht,"Cylinder"),preset:"cylinder-re100"}),refs:{st:[.162,.168],cd:[1.31,1.37],clAmp:[.31,.35]},sources:"Williamson 1996 (experiment, St); Park, Kwon & Choi 1998; Posdziech & Grundmann 2007; Qu et al. 2013.",settle:120,window:40},{id:"cylinder-re200",title:"Cylinder, Re 200: a stronger street",summary:"Shedding is faster (St about 0.196) and the lift swing about twice as large as at Re 100.",caveat:"A real cylinder wake turns three-dimensional from Re about 190: this is the two-dimensional flow, which the published 2D simulations match, not an experiment.",build:()=>({...At(200,Ht,"Cylinder"),preset:"cylinder-re200"}),refs:{st:[.19,.2],cd:[1.3,1.4],clAmp:[.64,.72]},sources:"Braza, Chassaing & Ha Minh 1986; Henderson 1995 (2D); Posdziech & Grundmann 2007.",settle:100,window:30},{id:"square-re100",title:"Square cylinder, Re 100",summary:"A square cylinder, a face to the flow: the flow leaves at its sharp front corners, and the street sheds more slowly than a round cylinder’s (St about 0.146).",build:()=>({...At(100,{kind:"rect",width:Je,height:Je},"Square cylinder"),preset:"square-re100"}),refs:{st:[.141,.15],cd:[1.45,1.53]},sources:"Sohankar, Norberg & Davidson 1998; Sharma & Eswaran 2004.",settle:120,window:40}];function Di(s){return Ui.find(e=>e.id===s)??null}function La(s,e){const t=e.build(),n=(o,r)=>Math.abs(o-r)<=1e-9*Math.max(1,Math.abs(r));if(!n(s.tunnel.length,t.tunnel.length)||!n(s.tunnel.height,t.tunnel.height)||s.tunnel.walls!==t.tunnel.walls||!n(s.flow.speed,t.flow.speed)||s.flow.fluid!==t.flow.fluid||s.flow.model==="sa")return!1;const i=s.bodies.filter(o=>o.enabled);return i.length!==t.bodies.length?!1:i.every((o,r)=>{const a=t.bodies[r];return JSON.stringify(o.shape)===JSON.stringify(a.shape)&&n(o.x,a.x)&&n(o.y,a.y)&&n(o.angle,a.angle)&&o.spin===0})}function qa({store:s,engine:e,ws:t}){return v(he,{label:"Presets",value:"",options:[{value:"",label:"Presets…"},...Ui.map(n=>({value:n.id,label:n.title}))],onChange:n=>{const i=Di(n);i&&(s.commit(i.build()),s.select(null),e.resetFlow(),t.ui.toast(`${i.title}. Undo (Ctrl+Z) brings your tunnel back.`,{kind:"info"}))}})}const En=(s,e=3)=>s.toFixed(e);function Qt({label:s,value:e,range:t,digits:n,attr:i}){const o=e!=null&&e>=t[0]&&e<=t[1],r=e==null||o?null:(e<t[0]?e/t[0]-1:e/t[1]-1)*100;return D("tr",{"data-t2d-preset-row":i,"data-value":e??"","data-within":o?"yes":e==null?"":"no",children:[v("th",{scope:"row",children:s}),v("td",{children:e==null?"…":En(e,n)}),D("td",{children:[En(t[0],n)," – ",En(t[1],n)]}),v("td",{className:"t2d-preset-off",children:r==null?"":`${r>0?"+":""}${r.toFixed(1)} %`})]})}function Ga({store:s,engine:e}){const t=pe(s,p=>p.scene),n=Di(t.preset),[i,o]=be(null),[r,a]=be(null),c=t.bodies.find(p=>p.enabled)??null;if(fe(()=>{if(!n||!c)return;let p=!0;const m=async()=>{const w=Se(c.shape)/t.flow.speed;if(o(e.measure(c.id,n.window*w)),n.refs.wake){const k=await e.wakeLength(c.id);p&&a(k)}},g=window.setInterval(()=>void m(),500);return m(),()=>{p=!1,window.clearInterval(g)}},[n,c,e,t.flow.speed]),!n||!c)return null;const l=La(t,n),u=e.lattice,h=u&&!u.capped&&e.flowModel==="off",d=Se(c.shape)/t.flow.speed,f=i?Math.min(1,i.since/(n.settle*d)):0,y=f>=1?i:null;return D("section",{className:"t2d-section","data-t2d-section":"preset","data-t2d-preset":n.id,"data-settled":f>=1?"yes":"no",children:[v("h2",{className:"t2d-section-title",children:n.title}),D("div",{className:"t2d-section-body",children:[v("p",{className:"t2d-preset-summary",children:n.summary}),l?h?v(H,{children:v("span",{"data-t2d-preset-exact":!0,children:"The grid resolves this Reynolds number: the flow runs as it is, with no model, so it is the real flow in two dimensions."})}):v(H,{tone:"warning",children:"The flow is not resolved at this setting, so the published values below do not apply. (A coarser resolution or the turbulence model changes it.)"}):v(H,{tone:"warning",children:"The setup has been changed from the preset (the flow, the tunnel or the body): the published values below no longer apply."}),n.caveat?v(H,{tone:"warning",children:n.caveat}):null,D("table",{className:"t2d-preset-table",children:[v("thead",{children:D("tr",{children:[v("th",{}),v("th",{scope:"col",children:"This run"}),v("th",{scope:"col",children:"Published"}),v("th",{})]})}),D("tbody",{children:[n.refs.st?v(Qt,{label:"Strouhal number",value:y?.st??null,range:n.refs.st,digits:3,attr:"st"}):null,n.refs.cd?v(Qt,{label:"Drag coefficient",value:y?.cd??null,range:n.refs.cd,digits:2,attr:"cd"}):null,n.refs.clAmp?v(Qt,{label:"Lift swing (±)",value:y?.clAmp??null,range:n.refs.clAmp,digits:2,attr:"clAmp"}):null,n.refs.wake?v(Qt,{label:"Wake length (diameters)",value:f>=1?r:null,range:n.refs.wake,digits:2,attr:"wake"}):null]})]}),D("p",{className:"t2d-preset-note",children:[f<1?`Settling: ${Math.round(f*100)} % of ${n.settle} passes of the flow past the body before measuring. `:`Measured over the last ${n.window} passes. `,"Published: ",n.sources]})]})]})}function za(s,e,t){const n=e.flow.speed;switch(s){case"vorticity":return{title:"Vorticity",unit:"1/s",k:n/t,centred:!0};case"speed":return{title:"Speed",unit:"m/s",k:n,centred:!1};case"pressure":return{title:"Pressure coefficient Cp",unit:"",k:1,centred:!0};case"schlieren":return{title:"Density gradient (relative)",unit:"",k:1,centred:!1};case"particles":return e.view.particleColor==="vorticity"?{title:"Vorticity",unit:"1/s",k:n/t,centred:!0}:{title:"Speed",unit:"m/s",k:n,centred:!1};case"none":case"rheoscopic":return{title:"",unit:"",k:1,centred:!1}}}function Fi(s){const[,e]=be(0);fe(()=>{const t=setInterval(()=>e(n=>n+1),s);return()=>clearInterval(t)},[s])}function Va({engine:s,store:e}){Fi(300);const t=pe(e,o=>o.save),n=s.stats,i={saved:"Saved",pending:"Not saved yet",saving:"Saving…",failed:"Not saved",conflict:"Saved elsewhere"}[t];return D("div",{className:"t2d-status","data-t2d-status":!0,"data-state":n.state,"data-steps":n.stepsPerFrame,"data-grid":`${n.nx}x${n.ny}`,children:[v("span",{title:"The GPU the flow runs on",children:n.adapter}),D("span",{children:[n.nx," × ",n.ny," cells"]}),D("span",{children:[n.stepsPerFrame," steps a frame"]}),v("span",{title:"Simulated seconds per second",children:n.state==="running"?`×${Te(n.speedRatio)} real time`:n.state==="paused"?"Paused":"Stopped"}),performance.now()-s.limitedAt<2e3?v("span",{className:"t2d-squeeze","data-t2d-squeeze":!0,title:"Where the flow went faster, or was squeezed harder, than the lattice can carry (a body dragged fast, or a gap closing between bodies), it is held to those limits there, so the flow at that spot is approximate.",children:"Flow held to its limits where it moved too fast"}):null,D("span",{"data-t2d-simtime":n.simTime,children:["t = ",n.simTime<1?`${(n.simTime*1e3).toPrecision(3)} ms`:`${n.simTime.toPrecision(4)} s`]}),v("span",{className:`t2d-save t2d-save--${t}`,"data-t2d-save":t,children:i})]})}function Wa({engine:s,store:e}){Fi(400);const t=pe(e,u=>u.scene),n=t.bodies.find(u=>u.enabled&&qt(u.shape)),i=n?Se(n.shape):t.tunnel.height/8,o=za(t.view.field,t,i),r=s.autoRangeNow,a=t.view.autoRange?r?.lo??t.view.min/o.k:t.view.min/o.k,c=t.view.autoRange?r?.hi??t.view.max/o.k:t.view.max/o.k;if(fe(()=>{t.view.autoRange||s.setRange(t.view.min/o.k,t.view.max/o.k)},[s,t.view.autoRange,t.view.min,t.view.max,o.k]),t.view.field==="none"||t.view.field==="rheoscopic")return null;const l=$i(t.view);return D("div",{className:"t2d-legend","data-t2d-legend":!0,"data-lo":a*o.k,"data-hi":c*o.k,children:[l==="inferno"?v(ja,{map:l,min:a*o.k,max:c*o.k,title:o.title,unit:o.unit}):v(Gi,{map:l,min:a*o.k,max:c*o.k,title:o.title,unit:o.unit,centred:o.centred,ticks:5,format:Te}),t.view.autoRange?null:v(Xa,{lo:t.view.min,hi:t.view.max,onCommit:(u,h)=>e.commit({...t,view:{...t.view,min:u,max:h}},!1)})]})}function ja({map:s,min:e,max:t,title:n,unit:i}){const o=hi(s),r=Array.from({length:9},(c,l)=>{const u=Math.round(l/8*255);return`rgb(${o[3*u]}, ${o[3*u+1]}, ${o[3*u+2]}) ${l/8*100}%`}),a=Array.from({length:5},(c,l)=>e+(t-e)*l/4);return D("div",{className:"t2d-maplegend",children:[D("div",{className:"mgk-legend-title",children:[n,i?` (${i})`:""]}),v("div",{className:"mgk-legend-bar",style:{background:`linear-gradient(to right, ${r.join(", ")})`}}),v("div",{className:"mgk-legend-ticks",children:a.map((c,l)=>v("span",{children:Te(c)},l))})]})}function Xa({lo:s,hi:e,onCommit:t}){const[n,i]=be(String(s)),[o,r]=be(String(e));fe(()=>{i(String(s)),r(String(e))},[s,e]);const a=()=>{const c=Number(n),l=Number(o);Number.isFinite(c)&&Number.isFinite(l)&&l>c?t(c,l):(i(String(s)),r(String(e)))};return D("div",{className:"t2d-range",children:[v("input",{className:"mgk-input","aria-label":"Colour range minimum",value:n,onChange:c=>i(c.target.value),onBlur:a,onKeyDown:c=>c.key==="Enter"&&a()}),v("span",{children:"to"}),v("input",{className:"mgk-input","aria-label":"Colour range maximum",value:o,onChange:c=>r(c.target.value),onBlur:a,onKeyDown:c=>c.key==="Enter"&&a()})]})}function Ka({ws:s,store:e,engine:t,editor:n,units:i,problem:o}){const[r,a]=be(i),[c,l]=be(!1),[u,h]=be(!1),[d,f]=be(""),y=pe(e,S=>S.save),p=pe(e,S=>S.saveError),m=pe(e,S=>S.scene.rakes.find(b=>b.id===S.selected)??null);fe(()=>s.on("units",a),[s]),fe(()=>e.subscribe(()=>{if(!n.bodyId)return;const{scene:S,selected:b}=e.get();(b!==n.bodyId||!S.bodies.some(M=>M.id===n.bodyId&&M.shape.kind==="sketch"))&&n.close()}),[n,e]);const g=()=>{e.undo(),n.resync()},x=()=>{e.redo(),n.resync()};fe(()=>(t.onUnstable=()=>{h(!0),s.ui.toast("The flow became unstable and was stopped. Reset the flow to start again.",{kind:"error"})},()=>{t.onUnstable=null}),[t,s]);const w=()=>{t.paused=!t.paused,l(t.paused)},k=()=>{t.resetFlow(),h(!1)};return fe(()=>{const S=b=>{const M=b.target;if(M&&(M.tagName==="INPUT"||M.tagName==="SELECT"||M.tagName==="TEXTAREA"||M.isContentEditable))return;const A=b.ctrlKey||b.metaKey;if(A&&b.key.toLowerCase()==="z"&&!b.shiftKey)b.preventDefault(),g();else if(A&&(b.key.toLowerCase()==="y"||b.key.toLowerCase()==="z"&&b.shiftKey))b.preventDefault(),x();else if(n.editing&&b.key!==" ")n.key(b.key)&&b.preventDefault();else if(b.key===" "&&!A)b.preventDefault(),w();else if((b.key==="Delete"||b.key==="Backspace")&&e.get().selected){b.preventDefault();const B=e.get().scene,R=B.bodies.find(E=>E.id===e.get().selected),C=B.rakes.find(E=>E.id===e.get().selected);R?(e.commit({...B,bodies:B.bodies.filter(E=>E.id!==R.id)}),s.ui.toast(`Removed ${R.name}. Undo (Ctrl+Z) brings it back.`,{kind:"info"})):C&&(e.commit({...B,rakes:B.rakes.filter(E=>E.id!==C.id)}),s.ui.toast(`Removed ${Ze(B,C)}. Undo (Ctrl+Z) brings it back.`,{kind:"info"}))}else if(b.key==="Escape")e.select(null);else if(b.key.startsWith("Arrow")&&e.get().selected){const B=e.get().scene,R=B.bodies.find(_=>_.id===e.get().selected);if(!R||R.locked)return;b.preventDefault();const C=B.tunnel.height/200*(b.shiftKey?10:1),E={ArrowLeft:[-C,0],ArrowRight:[C,0],ArrowUp:[0,C],ArrowDown:[0,-C]}[b.key]??[0,0];e.updateBody(R.id,{x:Math.min(B.tunnel.length,Math.max(0,R.x+E[0])),y:Math.min(B.tunnel.height,Math.max(0,R.y+E[1]))})}};return window.addEventListener("keydown",S),()=>window.removeEventListener("keydown",S)}),D("div",{className:"t2d-app","data-t2d-app":!0,children:[D("header",{className:"t2d-toolbar",role:"toolbar","aria-label":"Tunnel",children:[v(Re,{variant:c?"primary":"secondary",onClick:w,attrs:{"data-t2d-play":c?"paused":"running"},title:"Space",children:c?"Run":"Pause"}),v(Re,{variant:"neutral",onClick:k,attrs:{"data-t2d-reset":"1"},title:"Start the flow again from a uniform stream",children:"Reset flow"}),v("span",{className:"t2d-sep"}),v(Re,{variant:"neutral",onClick:g,disabled:!e.canUndo,title:"Ctrl+Z",attrs:{"data-t2d-undo":"1"},children:"Undo"}),v(Re,{variant:"neutral",onClick:x,disabled:!e.canRedo,title:"Ctrl+Y",attrs:{"data-t2d-redo":"1"},children:"Redo"}),v(Re,{variant:"neutral",onClick:()=>en(t,e.get().scene),title:"Double-click empty space",attrs:{"data-t2d-fit":"1"},children:"Fit view"}),v("span",{className:"t2d-sep"}),v(qa,{store:e,engine:t,ws:s}),v("span",{className:"t2d-toolbar-hint","data-t2d-hint":!0,children:d})]}),D("div",{className:"t2d-main",children:[D("aside",{className:"t2d-side",children:[v(Ga,{store:e,engine:t}),v(wa,{store:e,engine:t,units:r}),v(Ba,{store:e,ws:s,editor:n}),v(_a,{store:e,ws:s}),v(ka,{store:e,engine:t,units:r}),v(Pa,{store:e})]}),D("div",{className:"t2d-stage",children:[o?v("div",{className:"t2d-banner",children:v(yn,{reason:`The saved tunnel could not be read (${o}), so a new one was started.`,role:"alert"})}):null,y==="conflict"||y==="failed"?v("div",{className:"t2d-banner","data-t2d-save-problem":!0,children:v(yn,{reason:y==="conflict"?p:`The tunnel could not be saved: ${p}`,role:"alert"})}):null,u?v("div",{className:"t2d-banner","data-t2d-unstable":!0,children:v(yn,{reason:"The flow became unstable and was stopped.",fix:{label:"Reset flow",onFix:k},role:"alert"})}):null,v(Oa,{engine:t,store:e,editor:n,onStatus:f}),v(ya,{editor:n}),v(ga,{editor:n}),v(Wa,{engine:t,store:e}),v(Va,{engine:t,store:e})]}),v("aside",{className:"t2d-side t2d-side--right",children:m?v(Ua,{store:e,ws:s,units:r,rake:m}):v(Ra,{store:e,ws:s,units:r,engine:t,editor:n})})]})]})}const Ya=400,Ii=s=>`studies/${s}/scene.json`;async function Ha(s,e){const t=Ii(e),n=await s.files.stat(t);if(!n)return{scene:Et(),etag:null,problem:""};const i=await s.files.read(t);if(!i)return{scene:Et(),etag:null,problem:""};try{return{scene:wo(JSON.parse(new TextDecoder().decode(i))),etag:n.etag,problem:""}}catch(o){return{scene:Et(),etag:n.etag,problem:o instanceof Error?o.message:String(o)}}}class Qa{constructor(e,t,n,i){this.ws=e,this.store=t,this.studyId=n,this.etag=i}timer=null;latest=null;writing=null;schedule(e){this.store.get().save!=="conflict"&&(this.latest=e,this.store.setSave("pending"),this.ws.nav.setDirty(!0,"The tunnel’s last changes are not saved yet."),this.timer&&clearTimeout(this.timer),this.timer=setTimeout(()=>void this.flush(),Ya))}async flush(){this.timer&&clearTimeout(this.timer),this.timer=null,this.writing&&await this.writing;const e=this.latest;e&&(this.latest=null,this.store.setSave("saving"),this.writing=(async()=>{try{const t=await this.ws.files.write(Ii(this.studyId),JSON.stringify(e,null,1),{ifMatch:this.etag});this.etag=t.etag,this.latest||(this.store.setSave("saved"),await this.ws.nav.setDirty(!1))}catch(t){t?.code==="changed"?(this.store.setSave("conflict","This tunnel was saved from another tab. Reopen it to see that version; changes here are not saved."),await this.ws.nav.setDirty(!1)):(this.latest=this.latest??e,this.store.setSave("failed",t instanceof Error?t.message:String(t)))}finally{this.writing=null}})(),await this.writing)}async create(e){this.latest=e,await this.flush()}}function Za(s,e,t,n,i=.3){const o=2/(t*t*n),r=s.length,a=Math.floor(r*(1-i));let c=0;for(let p=a;p<r;p++)c+=e[p]*o;c/=r-a;const l=[];for(let p=a+1;p<r;p++){const m=e[p-1]*o-c,g=e[p]*o-c;m<0&&g>=0&&l.push(p-1+m/(m-g))}let u=-1/0,h=0,d=-1/0;for(let p=a;p<r;p++)u=Math.max(u,s[p]*o),h+=s[p]*o,d=Math.max(d,e[p]*o);const f=l.length-1,y=f>0?(l[l.length-1]-l[0])/f:NaN;return{St:n/(y*t),cdMax:u,cdMean:h/(r-a),clMax:d,periods:f}}async function Ja(s,e=20,t=200,n,i=!1){const o=Math.round(4.1*e),r=22*e,a=.05,c=2/3*a,l=c*e/100,u=new bt(s,{nx:r,ny:o,walls:"noslip",profile:1,absorbing:!1});u.setPhysics({u:a,tau:3*l+.5,smagorinsky:!1,smagCs:0}),u.reset(0);const h=On({kind:"circle",diameter:e}),d=Gt(h),f={x:2*e,y:-.5+2*e,theta:0};u.setBodies([{key:"cyl",sdf:d,from:f,to:f}]);let y=null;const p=2*l;if(i){const A={ox:Math.round(1*e),oy:Math.round(.6*e),wc:Math.round(4*e),hc:Math.round(2.8*e)},B=new bt(s,{nx:2*A.wc+1,ny:2*A.hc+1,walls:"noslip",patch:!0});B.setPhysics({u:a,tau:3*p+.5,smagorinsky:!1,smagCs:0,nuMol:p,nuFloor:0}),B.reset(0);const R={x:2*(f.x-A.ox),y:2*(f.y-A.oy),theta:0};B.setBodies([{key:"cylf",sdf:Gt(On({kind:"circle",diameter:2*e})),from:R,to:R}]),y=new Ri(s,u,B,A,0),u.setPatches([y]),u.setPhysics({u:a,tau:3*l+.5,smagorinsky:!1,smagCs:0})}const m=Math.ceil(t*e/c),g=new Float64Array(m),x=new Float64Array(m),w=performance.now();let k=0,S=0;const b=Math.ceil(2*e/c);for(let A=0;A<m;){const B=Math.min(u.maxFrameSteps,m-A,A<b?200:Ne),R=A<b?.5*(1-Math.cos(Math.PI*A/b)):1;u.setPhysics({u:a*R,tau:3*l+.5,smagorinsky:!1,smagCs:0}),y?.fine.setPhysics({u:a*R,tau:3*p+.5,smagorinsky:!1,smagCs:0,nuMol:p,nuFloor:0});const C=s.createCommandEncoder();u.encodeFrame(C,B,{mode:1,uRef:a,lRef:e});const E=u.prepareRead(C,B),_=y?y.fine.prepareRead(C,2*B):null;s.queue.submit([C.finish()]);const P=await E(),T=_?await _():null;if(!P||_&&!T)throw new Error("The force readback failed.");for(let $=0;$<B;$++)if(T){const U=T.forces[0].perStep;g[A+$]=(U[4*$]+U[4*$+2])/4,x[A+$]=(U[4*$+1]+U[4*$+3])/4}else g[A+$]=P.forces[0].perStep[2*$],x[A+$]=P.forces[0].perStep[2*$+1];if(k+=P.bad+(T?.bad??0),S+=P.limited+(T?.limited??0),A+=B,k)break}u.destroy();const M=Za(g,x,c,e);return{N:e,steps:m,seconds:(performance.now()-w)/1e3,...M,bad:k,limited:S}}const Ds=Math.exp(-ht*oi);function el(s){let e=Math.min(Math.sqrt(Math.max(s,0)),45);for(let t=0;t<40;t++){const n=ht*e,i=Math.exp(n),o=e+Ds*(i-1-n-.5*n*n-n*n*n/6),r=1+Ds*ht*(i-1-n-.5*n*n),a=Math.max(e-(o*e-s)/(r*e+o),1e-4);if(Math.abs(a-e)<1e-10*e)return a;e=a}return e}function Wn(s,e,t){const n=Math.min(Math.max(e,0),s.nx-1.001),i=Math.min(Math.max(t,0),s.ny-1.001),o=Math.floor(n),r=Math.floor(i),a=n-o,c=i-r;let l=0,u=0,h=0,d=0;for(let f=0;f<4;f++){const y=f&1,p=f>>1,m=(r+p)*s.nx+o+y;if(s.mac[4*m+3]>.5)continue;const g=(y?a:1-a)*(p?c:1-c);l+=g*s.mac[4*m],u+=g*s.mac[4*m+1],h+=g*s.mac[4*m+2],d+=g}return d<1e-6?null:{ux:l/d,uy:u/d,rho:h/d}}function tl(s,e,t){const n=.5*t.rho*t.u*t.u,i=e.length/2,o=[];let r=0,a=0,c=0,l=0;for(let h=0;h<i;h++){const d=e[2*h],f=e[2*h+1],y=e[2*((h+1)%i)],p=e[2*((h+1)%i)+1],m=Math.hypot(y-d,p-f);if(m<1e-9)continue;const g=Math.max(1,Math.ceil(m)),x=m/g,w=(y-d)/m,k=(p-f)/m,S=k,b=-w;for(let M=0;M<g;M++){const A=d+w*x*(M+.5),B=f+k*x*(M+.5),R=Wn(s,A+S,B+b),C=Wn(s,A+lt*S,B+lt*b);if(!R||!C)continue;const E=(R.rho-t.rho)/3;let _;const P=R.ux*w+R.uy*k,T=C.ux*w+C.uy*k;if(t.shear==="resolved"){const $=lt,U=($*$*P-T)/($*$-$);_=R.rho*t.nu*U}else{const $=Math.abs(T),U=$>1e-12?$/el(lt*$/t.nu):0;_=Math.sign(T)*R.rho*U*U}r+=-E*S*x,a+=-E*b*x,c+=_*w*x,l+=_*k*x,o.push({x:A,y:B,nx:S,ny:b,ds:x,cp:E/n,cf:_/n})}}const u=1/(n*t.lRef);return{panels:o,cxP:r*u,cyP:a*u,cxF:c*u,cyF:l*u,cx:(r+c)*u,cy:(a+l)*u}}function nl(s,e,t,n,i,o,r){const a=-i,c=n,l=r.rho/3+.5*r.rho*r.u*r.u,u=.01*.5*r.rho*r.u*r.u,h=[0],d=[0];let f=-1;for(let w=.5;w<=o;w+=.5){const k=Wn(s,e+n*w,t+i*w);if(!k)return null;h.push(k.ux*a+k.uy*c),d.push(w);const S=k.rho/3+.5*k.rho*(k.ux*k.ux+k.uy*k.uy);if(w>=1&&S>=l-u){f=h.length-1;break}}if(f<1)return null;const y=Math.sign(h[f])||1,p=h.map(w=>w*y),m=p[f];let g=0,x=0;for(let w=1;w<=f;w++){const k=p[w-1]/m,S=p[w]/m,b=d[w]-d[w-1];g+=.5*b*(1-k+(1-S)),x+=.5*b*(k*(1-k)+S*(1-S))}return{ue:m,delta:d[f],dstar:g,theta:x,h:g/x}}function sl(s,e,t){let n=0,i=0;const o=(f,y)=>{const p=4*(y*s.nx+f);return{ux:s.mac[p],uy:s.mac[p+1],rho:s.mac[p+2],solid:s.mac[p+3]>.5}},r=t.rho/3,a=(f,y,p,m)=>{const g=o(f,y);if(g.solid)return;const x=g.rho/3-r,w=g.ux*p+g.uy*m;n-=x*p+g.rho*g.ux*w,i-=x*m+g.rho*g.uy*w},c=Math.round(e.x0),l=Math.round(e.x1),u=Math.round(e.y0),h=Math.round(e.y1);for(let f=c;f<l;f++)a(f,u,0,-1),a(f,h,0,1);for(let f=u;f<h;f++)a(c,f,-1,0),a(l,f,1,0);const d=.5*t.rho*t.u*t.u*t.lRef;return{cd:n/d,cl:i/d}}function il(s,e,t=181,n=Zn){const i=ri(_n(s,t).x,_n(s,t).y,n/e),o=[];for(let r=0;r<i.x.length;r++)o.push((i.x[r]-.25)*e,i.y[r]*e);return ln(o)}function rl(s,e,t=48){const n=4*e,i=e/2,o=[],r=-s/2+n,a=s/2-n;for(let c=0;c<=t;c++){const l=-Math.PI/2+Math.PI*c/t;o.push(a+n*Math.cos(l),i*Math.sin(l))}for(let c=0;c<=t;c++){const l=Math.PI/2+Math.PI*c/t;o.push(r+n*Math.cos(l),i*Math.sin(l))}return ln(o)}async function Fs(s,e,t){const n=e.u??_t,i=n*e.lRef/e.re,o=n/(e.gridRe??es),r=Math.max(i,o),a=new bt(s,{nx:e.nx,ny:e.ny,walls:e.walls??"farfield"}),c=e.turb==="sa";a.setPhysics({u:n,tau:3*r+.5,smagorinsky:!c&&r<Ms,smagCs:Ut,turb:e.turb,nuMol:i,nuFloor:o,bulkKeep:e.bulkKeep}),a.reset(n);const l=e.turb==="sa"?ai:void 0,u=Gt(e.poly,l),h=-e.alpha*Math.PI/180,d={x:e.x,y:e.y,theta:h};a.setBodies([{key:"case",sdf:u,from:d,to:d}]);let f=null;const y=e.refine??0;if(y>0){const O={u:n,tau:3*r+.5,smagorinsky:!c&&r<Ms,smagCs:Ut,turb:e.turb,nuMol:i,nuFloor:o,bulkKeep:e.bulkKeep},j=Math.max(4,e.ny*.06),ne=[];let Ge=Zt(e.poly,d),ge={x0:Math.ceil(e.nx*.05)+6,y0:Math.ceil(j)+6,x1:Math.floor(e.nx*.85)-6,y1:Math.floor(e.ny-j)-6},Me=e.lRef;for(let Ce=0;Ce<y;Ce++){const se=e.refineMargin??1,Pe=Ce===0?{ahead:.3*se,side:.3*se,behind:.7*se}:{ahead:.12*se,side:.12*se,behind:.3*se},ce=Fo(Ge,Me,Pe,ge);ne.push(ce),Ge=Ge.map((_e,He)=>2*(_e-(He%2?ce.oy:ce.ox))),Me*=2,ge={x0:6,y0:6,x1:2*ce.wc-6,y1:2*ce.hc-6}}f=new Ci(s,a,ne,O),f.setBodies([{key:"case",local:e.poly,band:l,from:d,to:d}])}const p=e.lRef/n,m=Math.ceil(e.tstar*p),g=Math.floor(m*(1-(e.tail??.25)));let x=0,w=0,k=0,S=0,b=0,M=1/0,A=-1/0,B=1/0,R=-1/0;const C=[];let E=0,_=0,P=0;const T=.5*n*n*e.lRef,$=performance.now();for(let O=0;O<m;){const j=Math.min(a.maxFrameSteps,m-O),ne=s.createCommandEncoder();a.encodeFrame(ne,j,{mode:1,uRef:n,lRef:e.lRef});const Ge=a.prepareRead(ne,j),ge=f?f.prepareRead(ne,j):null;s.queue.submit([ne.finish()]);const Me=await Ge(),Ce=ge?await ge():null;if(!Me||ge&&!Ce)throw new Error("The force readback failed.");const se=Ce??Me;x+=Me.bad+(Ce?.bad??0),w+=Me.limited+(Ce?.limited??0);for(let Pe=0;Pe<j;Pe++){const ce=se.forces[0].perStep[2*Pe]/T,_e=se.forces[0].perStep[2*Pe+1]/T;E+=ce,_+=_e,P++,O+Pe>=g&&(k+=ce,S+=_e,b++,M=Math.min(M,ce),A=Math.max(A,ce),B=Math.min(B,_e),R=Math.max(R,_e)),(O+Pe+1)%Math.round(p)===0&&(C.push([(O+Pe+1)/p,E/P,_/P]),E=0,_=0,P=0)}if(O+=j,x)break}await s.queue.onSubmittedWorkDone();const U=(performance.now()-$)/1e3,{mac:I,aux:W}=await a.readFields();let F=null;if(f){const O=s.createCommandEncoder();f.finest.encodeField(O,{mode:1,uRef:n,lRef:e.lRef*f.scale}),s.queue.submit([O.finish()]);const j=await f.finest.readFields();F={nx:f.finest.nx,ny:f.finest.ny,mac:j.mac,k:f.scale,pose:f.poseAt(f.levels.length-1,d)},f.destroy()}const we=I;a.destroy();const le=Math.round(e.nx*.08),K=[];for(let O=Math.round(e.ny*.2);O<Math.round(e.ny*.8);O++)K.push(we[4*(O*e.nx+le)+2]);K.sort((O,j)=>O-j);const ke=K[Math.floor(K.length/2)]??1,z=Zt(e.poly,d),G=F?.k??1,me=F?Zt(e.poly,F.pose,G):z,ye=F?{nx:F.nx,ny:F.ny,mac:F.mac}:{nx:e.nx,ny:e.ny,mac:we},te=tl(ye,me,{u:n,rho:ke,lRef:e.lRef*G,shear:e.turb==="off"?"resolved":"wall",nu:(e.turb==="off"?r:i)*G});let Ie;if(e.blStations){const O=ye,j=Math.cos(-h),ne=Math.sin(-h),Ge=F?.pose.x??e.x,ge=F?.pose.y??e.y,Me=te.panels.map(se=>{const Pe=(se.x-Ge)/G,ce=(se.y-ge)/G;return{p:se,xc:(j*Pe-ne*ce-(e.leX??0))/e.lRef,yc:(ne*Pe+j*ce)/e.lRef}}),Ce=(se,Pe)=>{const ce=Me.filter(wt=>Pe?wt.yc>0:wt.yc<=0);if(!ce.length)return null;const _e=ce.reduce((wt,ss)=>Math.abs(ss.xc-se)<Math.abs(wt.xc-se)?ss:wt,ce[0]),He=nl(O,_e.p.x,_e.p.y,_e.p.nx,_e.p.ny,.25*e.lRef*G,{rho:ke,u:n}),mn=e.lRef*G;return He?{...He,delta:He.delta/mn,dstar:He.dstar/mn,theta:He.theta/mn,ue:He.ue/n}:null};Ie=e.blStations.map(se=>({xc:se,upper:Ce(se,!0),lower:Ce(se,!1)}))}const it=[.25,.5,1].map(O=>{const j=O*e.lRef,ne=z.reduce((ge,Me,Ce)=>Ce%2?{...ge,y0:Math.min(ge.y0,Me),y1:Math.max(ge.y1,Me)}:{...ge,x0:Math.min(ge.x0,Me),x1:Math.max(ge.x1,Me)},{x0:1/0,y0:1/0,x1:-1/0,y1:-1/0}),Ge={x0:Math.max(e.nx*.06,ne.x0-j),x1:Math.min(e.nx*.84,ne.x1+j),y0:Math.max(e.ny*.07,ne.y0-j),y1:Math.min(e.ny*.93,ne.y1+j)};return{margin:O,...sl({nx:e.nx,ny:e.ny,mac:we},Ge,{rho:ke,u:n,lRef:e.lRef})}});let Ee=0;const qe={macNaN:0,auxNaN:0,z:[1/0,-1/0],w:[1/0,-1/0],rhoInf:ke,panels:te.panels.length};for(let O=0;O<e.nx*e.ny;O++)Number.isFinite(we[4*O+2])||qe.macNaN++;if(W)for(let O=0;O<e.nx*e.ny;O++){const j=W[4*O+2],ne=W[4*O+3];if(!Number.isFinite(j)||!Number.isFinite(ne)){qe.auxNaN++;continue}qe.z=[Math.min(qe.z[0],j),Math.max(qe.z[1],j)],qe.w=[Math.min(qe.w[0],ne),Math.max(qe.w[1],ne)],ne>=0&&(Ee=Math.max(Ee,j/i))}return console.log("R1 diag",JSON.stringify(qe)),{steps:m,seconds:U,mlups:e.nx*e.ny*m/U/1e6,bad:x,limited:w,cd:b?k/b:NaN,cl:b?S/b:NaN,cdSpread:A-M,clSpread:R-B,surface:{cd:te.cx,cl:te.cy,cdP:te.cxP,cdF:te.cxF,clP:te.cyP,clF:te.cyF},history:C,panels:F?te.panels.map(O=>({...O,x:e.x+(O.x-F.pose.x)/G,y:e.y+(O.y-F.pose.y)/G,ds:O.ds/G})):te.panels,rhoInf:ke,nuMol:i,nuFloor:o,nutMax:Ee,boxes:it,bl:Ie,fields:e.dump?{nx:e.nx,ny:e.ny,mac:Array.from(we),aux:W?Array.from(W):null}:void 0}}function ol(s){const e=s.up??4,t=s.down??8,n=s.half??4;return{poly:il(s.code,s.chord,181,s.teMin??Zn),lRef:s.chord,re:s.re,turb:s.turb,x:e*s.chord+(s.offset??0),y:n*s.chord+(s.offset??0),alpha:s.alpha,nx:Math.round((e+t)*s.chord),ny:Math.round(2*n*s.chord),tstar:s.tstar??12,gridRe:s.gridRe,dump:s.dump,bulkKeep:s.bulkKeep,u:s.u,walls:s.walls,blStations:s.blStations,refine:s.refine,refineMargin:s.refineMargin,leX:-.25*s.chord}}function al(s){const e=s.length;return{poly:rl(e,s.thickness??6),lRef:e,re:s.re,turb:s.turb,x:.3*e+e/2,y:Math.round(.2*e)+(s.yOffset??.3),alpha:0,nx:Math.round(1.9*e),ny:Math.round(.4*e),tstar:s.tstar??3,gridRe:s.gridRe,dump:s.dump,bulkKeep:s.bulkKeep,u:s.u}}function ll({store:s,engine:e,device:t,editor:n}){window.__TUNNEL__={ready:!0,scene:()=>s.get().scene,selected:()=>s.get().selected,save:()=>s.get().save,stats:()=>({...e.stats,map:e.lattice,unstableAt:e.unstableAt,limitedTotal:e.limitedTotal}),view:()=>({...e.worldView}),livePose:i=>e.livePose(i),bodyLive:i=>e.bodyLive(i),sampleField:async()=>{const i=await e.sampleField();return i?Array.from(i,o=>Number.isFinite(o)?o:null):null},toScreen:(i,o)=>{const r=e.worldView,a=e.canvas.getBoundingClientRect();return{x:a.left+r.w/2+(i-r.cx)/r.mpp,y:a.top+r.h/2-(o-r.cy)/r.mpp}},turnHandle:i=>{const o=s.get().scene.bodies.find(c=>c.id===i);if(!o)return null;const r=e.canvas.getBoundingClientRect(),a=_i(e,o);return{x:r.left+a.x,y:r.top+a.y,cx:r.left+a.cx,cy:r.top+a.cy}},validate:(i=20,o=200,r=!1)=>Ja(t,i,o,void 0,r),validateAirfoil:i=>Fs(t,ol(i)),validatePlate:i=>Fs(t,al(i)),particles:async()=>{const i=await e.readParticles();if(!i)return null;const o=s.get().scene,r=i.dx,a=o.bodies.filter(f=>f.enabled).map(f=>({b:f,poly:ct(f,e.livePose(f.id)??{x:f.x,y:f.y,angle:f.angle})}));let c=0,l=0,u=0;const h=[],d=i.pools.map(f=>({id:f.id,alive:0,maxX:-1/0}));for(let f=0;f<i.meta.length/4;f++){if(i.meta[4*f+3]<.5||i.meta[4*f]<0)continue;const y=(i.pos[4*f]+.5)*r,p=(i.pos[4*f+1]+.5)*r;if(!Number.isFinite(y)||!Number.isFinite(p)){l++;continue}const m=i.meta[4*f+1];if(m<0)c++;else{const g=d[m];g&&(g.alive++,g.maxX=Math.max(g.maxX,y))}for(const{poly:g}of a)tn(g,y,p)&&gn(g,y,p)<-.5*r&&(u++,h.length<6&&h.push({x:y,y:p,depthCells:gn(g,y,p)/r,age:i.meta[4*f],src:i.meta[4*f+1],prevX:(i.pos[4*f+2]+.5)*r,prevY:(i.pos[4*f+3]+.5)*r}))}return{tracers:i.tracers,tracersAlive:c,nan:l,inside:u,insideAt:h,pools:d}},dye:async()=>{const i=await e.readDye();if(!i)return null;const o=[0,0,0,0],r=[-1/0,-1/0,-1/0,-1/0],c=s.get().scene.bodies.filter(u=>u.enabled).map(u=>ct(u,e.livePose(u.id)??{x:u.x,y:u.y,angle:u.angle}));let l=0;for(const u of c){let h=1/0,d=-1/0,f=1/0,y=-1/0;for(const p of u)for(let m=0;m<p.length;m+=2)h=Math.min(h,p[m]),d=Math.max(d,p[m]),f=Math.min(f,p[m+1]),y=Math.max(y,p[m+1]);for(let p=Math.max(0,Math.floor(f/i.dx));p<=Math.min(i.ny-1,Math.ceil(y/i.dx));p++)for(let m=Math.max(0,Math.floor(h/i.dx));m<=Math.min(i.nx-1,Math.ceil(d/i.dx));m++){const g=(m+.5)*i.dx,x=(p+.5)*i.dx;if(tn(u,g,x)&&gn(u,g,x)<-i.dx){const w=p*i.nx+m;l+=i.data[4*w]+i.data[4*w+1]+i.data[4*w+2]+i.data[4*w+3]}}}for(let u=0;u<i.nx*i.ny;u++)for(let h=0;h<4;h++){const d=i.data[4*u+h];d>.05&&(o[h]+=d,r[h]=Math.max(r[h],(u%i.nx+.5)*i.dx))}return{channels:i.channels,sums:o,maxX:r,insideSum:l}},streamlines:()=>e.streamlineCount,refine:()=>e.refineInfo(),rheo:()=>e.readRheo(),sketch:()=>{const i=e.worldView,o=e.canvas.getBoundingClientRect(),r=(a,c)=>({x:o.left+i.w/2+(a-i.cx)/i.mpp,y:o.top+i.h/2-(c-i.cy)/i.mpp});return{bodyId:n.bodyId,tool:n.tool,status:n.status,words:n.statusWords(),message:n.message,selection:n.selection,busy:n.busy,labels:n.editing?n.dimensionLabels(r):[]}}}}class cl{client;chain=Promise.resolve();constructor(e){this.client=zr({spawn:e,url:new URL(Vr,document.baseURI).href})}queue(e){const t=this.chain.then(e,e);return this.chain=t.catch(()=>{}),t}async loadAndSolve(e){const{values:t,errors:n}=Yr(e),i=Object.values(n)[0];if(i)return{sketch:e,status:{state:"unsolved",dof:0,conflicting:[],redundant:[]},analysis:null,error:i};await this.client.load(Zs(e,t));const o=await this.client.solve(),r=await this.client.analyze().catch(()=>null),a=us(o,r??void 0);return{sketch:o.solved?bn(e,o.values):e,status:a,analysis:r}}solve(e){return this.queue(async()=>{try{return await this.loadAndSolve(e)}catch(t){return{sketch:e,status:{state:"unsolved",dof:0,conflicting:[],redundant:[]},analysis:null,error:t instanceof Error?t.message:String(t)}}})}dragStart(e,t){return this.queue(async()=>{try{await this.loadAndSolve(e);const n=await this.client.dragStart(t,{freeze:!0});return n.ok&&n.movable}catch{return!1}})}dragWant=null;dragBusy=!1;dragMove(e,t,n){return new Promise(i=>{this.dragWant?.resolve(null),this.dragWant={s:e,u:t,v:n,resolve:i},this.pumpDrag()})}pumpDrag(){if(this.dragBusy||!this.dragWant)return;const e=this.dragWant;this.dragWant=null,this.dragBusy=!0,this.queue(async()=>{try{const t=await this.client.dragMove(e.u,e.v);e.resolve(t.superseded||!t.values?null:bn(e.s,t.values))}catch{e.resolve(null)}}).finally(()=>{this.dragBusy=!1,this.pumpDrag()})}dragEnd(e){return this.queue(async()=>{try{const t=await this.client.dragEnd(),n=await this.client.analyze().catch(()=>null);return{sketch:t.solved?bn(e,t.values):e,status:us(t,n??void 0),analysis:n}}catch(t){return{sketch:e,status:{state:"unsolved",dof:0,conflicting:[],redundant:[]},analysis:null,error:t instanceof Error?t.message:String(t)}}})}dispose(){this.client.dispose()}}function ul(){return[...co(),{label:"particles advect",code:xi()},{label:"particles draw",code:bi()},{label:"trail fade",code:wi},{label:"rake lines",code:vi()},{label:"dye advect",code:mi()},{label:"dye correct",code:yi()},{label:"dye inject",code:gi()},{label:"streamlines trace",code:Mi},{label:"streamlines draw",code:Pi},{label:"rheoscopic",code:ki()},...Do()]}async function dl(s){for(const e of ul()){const n=(await s.createShaderModule({code:e.code,label:e.label}).getCompilationInfo()).messages.find(i=>i.type==="error");if(n)return`${e.label} shader, line ${n.lineNum}: ${n.message}`}return null}const hl=document.getElementById("t2d-root"),Oi=Vi(hl);function ft(s,e){Oi.render(Bt("div",{className:"t2d-fatal",role:"alert","data-t2d-fatal":"1"},Bt(zi,null,Bt("strong",null,s),Bt("p",null,e))))}function ue(s){const e=getComputedStyle(document.documentElement).getPropertyValue(s).trim(),t=document.createElement("canvas").getContext("2d");t.fillStyle=e||"black";const n=t.fillStyle;if(n.startsWith("#"))return[parseInt(n.slice(1,3),16)/255,parseInt(n.slice(3,5),16)/255,parseInt(n.slice(5,7),16)/255];const i=/rgba?\(([^)]+)\)/.exec(n),o=i?i[1].split(",").map(Number):[0,0,0];return[o[0]/255,o[1]/255,o[2]/255]}async function fl(){let s;try{s=await Ni({timeoutMs:15e3})}catch(g){ft("The wind tunnel could not start",`${g instanceof Error?g.message:String(g)}. Open the tunnel from its project in Magnusim.`);return}if(!("gpu"in navigator)||!navigator.gpu){ft("This wind tunnel needs WebGPU","This browser does not offer WebGPU (navigator.gpu is missing), and the tunnel solves the flow on the GPU with it. Open Magnusim in a current Chrome or Edge on a computer with a GPU driver from the last few years.");return}const e=await navigator.gpu.requestAdapter({powerPreference:"high-performance"}).catch(()=>null);if(!e){ft("This wind tunnel needs WebGPU","The browser offers WebGPU but found no GPU it can use (requestAdapter gave none). Check that hardware acceleration is on in the browser’s settings and that the graphics driver is up to date.");return}let t;try{t=await e.requestDevice({requiredLimits:{maxStorageBufferBindingSize:e.limits.maxStorageBufferBindingSize,maxBufferSize:e.limits.maxBufferSize,maxStorageBuffersPerShaderStage:Math.min(e.limits.maxStorageBuffersPerShaderStage,16)}})}catch(g){ft("The GPU could not be opened",String(g));return}const n=await dl(t);if(n){ft("The wind tunnel’s GPU code did not compile on this GPU",`${n}. Please report this with the GPU’s name (${e.info?.vendor??""} ${e.info?.architecture??""}).`);return}const i=e.info,o=i?.description||[i?.vendor,i?.architecture].filter(Boolean).join(" ")||"GPU";t.lost.then(g=>{g.reason!=="destroyed"&&ft("The GPU stopped the wind tunnel",`${g.message||"The GPU device was lost"}. Leave the tunnel and open it again; the scene is saved.`)});const r=s.context.study,a=await Ha(s,r.id),c=new Jo(a.scene),l=new Qa(s,c,r.id,a.etag);a.etag||await l.create(a.scene);const u={bg:ue("--t2d-bg"),body:ue("--t2d-body"),edge:ue("--t2d-edge"),zone:[...ue("--t2d-zone"),.14],plain:ue("--t2d-plain"),arrow:[...ue("--t2d-arrow"),.85]},h=document.createElement("canvas"),d=new Zo(t,h,o,u),f=g=>{const x=16*Math.PI/180,w=g*Math.PI/180;return[Math.cos(x)*Math.cos(w),Math.cos(x)*Math.sin(w),Math.sin(x)]},y=(g,x,w,k,S)=>({base:ue(`--t2d-rheo-${g}-base`),l1:{dir:f(135),color:ue(`--t2d-rheo-${g}-light1`),diffuse:x},l2:{dir:f(-45),color:ue(`--t2d-rheo-${g}-light2`),diffuse:w},sharp:k,glint:S});d.rheoLooks={kalliroscope:y("kalliroscope",.16,.12,12,1.8),pearl:y("pearl",.18,.14,12,1.6),copper:y("copper",.17,.12,10,1.8)},d.bodyLook={body:ue("--t2d-body-dark"),edge:ue("--t2d-edge-light")},d.markerColors={tracerDark:[...ue("--t2d-particle-dark"),.5],tracerLight:[...ue("--t2d-particle-light"),.85],rakes:[1,2,3,4,5,6].map(g=>[...ue(`--mg-series-${g}`),.85]),rakesOnDark:[1,2,3,4,5,6].map(g=>{const x=ue(`--mg-series-${g}`);return[x[0]+(1-x[0])*.35,x[1]+(1-x[1])*.35,x[2]+(1-x[2])*.35,.85]}),streamline:[...ue("--t2d-streamline"),.4],streamlineLight:[...ue("--t2d-particle-light"),.35]},c.onSceneChange=g=>{l.schedule(g),d.setScene(g)},await d.setScene(a.scene),d.start();let p=null;const m=new fa(c,d,()=>p??=new cl(g=>s.spawnWorker(g)));ll({store:c,engine:d,device:t,editor:m}),window.addEventListener("pagehide",()=>void l.flush()),Oi.render(Bt(Ka,{ws:s,store:c,engine:d,editor:m,units:s.context.units,problem:a.problem}))}fl();
