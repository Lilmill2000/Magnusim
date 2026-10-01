import{connect as rm}from"@magnusim/workspace";import{useRef as _n,useCallback as Wu,useSyncExternalStore as sm,useState as Lt,useLayoutEffect as ah,useEffect as Cn,createContext as am,useContext as om,createElement as lm}from"react";import{createRoot as cm}from"react-dom/client";import{jsxs as Ae,jsx as k,Fragment as Ai}from"react/jsx-runtime";function um(n){const e=/^\s*(\d+)\.(\d+)/.exec(String(n??""));return e?[Number(e[1]),Number(e[2])]:null}function $u(n,e,t){const i=um(n);return i?i[0]>e||i[0]===e&&i[1]>=t:!1}function fm(n){let e=n.context.units;n.on("units",o=>{e=o});const t=$u(n.context.hostVersion,1,2),i=n.files,r=t&&i&&typeof i.read=="function"&&typeof i.write=="function"&&typeof i.stat=="function"&&typeof i.list=="function"&&typeof i.delete=="function"?i:null,s=n.nav,a=t&&typeof s.setDirty=="function";return{context:n.context,studyId:n.context.study.id,units:()=>e,onUnits:o=>n.on("units",o),onStudy:o=>n.on("study",o),study:{get:()=>n.study.get(),update:(o,l)=>n.study.update(o,l)},data:{read:o=>n.data.read(o),write:(o,l)=>n.data.write(o,l)},files:r,toast(o,l="info"){n.ui.toast(o,{kind:l}).catch(c=>console.warn("[cad] toast failed",c))},confirm:o=>n.ui.confirm(o),prompt:o=>n.ui.prompt(o),back:async()=>await n.nav.back()!==!1,setDirty(o,l){a&&s.setDirty(o,l).catch(c=>console.warn("[cad] setDirty failed",c))},hostAtLeast:(o,l)=>$u(n.context.hostVersion,o,l),spawnWorker:o=>n.spawnWorker(o),raw:n}}function dm(){const n=new Map,e={on(t,i){let r=n.get(t);return r||n.set(t,r=new Set),r.add(i),()=>{r.delete(i)}},once(t,i){const r=e.on(t,s=>{r(),i(s)});return r},emit(t,i){const r=n.get(t);if(r)for(const s of[...r])try{s(i)}catch(a){console.error(`[cad] handler of ${String(t)} failed`,a)}}};return e}function oh(n,e){if(Object.is(n,e))return!0;if(typeof n!="object"||typeof e!="object"||n===null||e===null||Array.isArray(n)!==Array.isArray(e))return!1;const t=Object.keys(n),i=Object.keys(e);if(t.length!==i.length)return!1;for(const r of t)if(!Object.prototype.hasOwnProperty.call(e,r)||!Object.is(n[r],e[r]))return!1;return!0}function Ki(n){let e=n;const t=new Set;return{get:()=>e,set(i){const r=e,s=typeof i=="function"?i(r):{...r,...i};if(!oh(r,s)){e=s;for(const a of[...t])try{a(e,r)}catch(o){console.error("[cad] state listener failed",o)}}},subscribe(i){return t.add(i),()=>{t.delete(i)}}}}function it(n,e){const t=_n(e);t.current=e;const i=_n(null),r=Wu(()=>{const a=n.get(),o=t.current,l=i.current;if(l&&Object.is(l.src,a)&&l.sel===o)return l.out;const c=o?o(a):a;return l&&oh(l.out,c)?(i.current={src:a,sel:o,out:l.out},l.out):(i.current={src:a,sel:o,out:c},c)},[n]),s=Wu(a=>n.subscribe(()=>a()),[n]);return sm(s,r,r)}function As(n){switch(n.kind){case"face":case"edge":case"vertex":return`${n.kind}:${n.body}:${n.index}`;case"body":return`body:${n.body}`;case"feature":return`feature:${n.feature}`;case"origin":return`origin:${n.ref}`}}function hm(){return Ki({items:[],filter:[]})}function Ds(n,e){const t=As(e);return n.items.some(i=>As(i)===t)}function Ri(n,e,t){n.set(i=>{if(!t)return{...i,items:[e]};const r=As(e),s=i.items.some(a=>As(a)===r);return{...i,items:s?i.items.filter(a=>As(a)!==r):[...i.items,e]}})}function ru(n){n.set(e=>e.items.length?{...e,items:[]}:e)}function Xu(n,e){n.set(t=>({...t,filter:e}))}function $i(n){const e=new Uint8Array(8);if(typeof crypto<"u"&&typeof crypto.getRandomValues=="function")crypto.getRandomValues(e);else for(let i=0;i<e.length;i++)e[i]=Math.floor(Math.random()*256);let t=0n;for(const i of e)t=t<<8n|BigInt(i);return`${n}_${(t&(1n<<60n)-1n).toString(36).padStart(12,"0")}`}function su(n,e){const t=new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")} (\\d+)$`);let i=0;for(const r of e){const s=t.exec(r);s&&(i=Math.max(i,Number(s[1])))}return`${n} ${i+1}`}const Ms=1,Wn={"origin:top":{label:"Top plane",origin:[0,0,0],normal:[0,0,1],xdir:[1,0,0]},"origin:front":{label:"Front plane",origin:[0,0,0],normal:[0,-1,0],xdir:[1,0,0]},"origin:right":{label:"Right plane",origin:[0,0,0],normal:[1,0,0],xdir:[0,1,0]}},oo={repair:"Try repair",retry:"Retry"},Kl="doc";function qu(n,e="data"){return{rel:`studies/${n}/model.json`,schema:1,store:e,view:`studies/${n}/view.json`}}function lh(n){const e=n?n[Kl]:void 0;return!e||typeof e!="object"||typeof e.rel!="string"||!e.rel||typeof e.view!="string"||!e.view||e.store!=="data"&&e.store!=="files"?null:{rel:e.rel,view:e.view,store:e.store,schema:1}}class au extends Error{code="conflict";constructor(e="Changed in another tab"){super(e),this.name="DocConflictError"}}class pm extends Error{constructor(e,t){super(e),this.code=t,this.name="DocSaveError"}}const mm=6,gm=1500,_m=2e3,vm=1e4,Yu=[3e3,1e4,3e4,6e4];function Ku(n){return(n instanceof Error?n.message:String(n)).replace(/^Error:\s*/,"")||"the app did not answer"}class xm{constructor(e){this.o=e,this.etag=e.etag,this.interval=e.intervalMs??gm,this.burst=Math.max(1,e.burst??mm),this.viewInterval=e.viewIntervalMs??_m,this.tokens=this.burst,this.savedDoc=e.etag?e.getDoc():null,this.savedAt=e.etag?e.savedAt??null:null,this.checkedAt=Date.now()}etag;dirty=!1;viewDirty=!1;savedDoc=null;savedAt;timer=null;writing=null;urgent=!1;failures=0;stopped=null;shown=null;tokens;refillAt=0;interval;burst;viewInterval;viewTimer=null;viewWriting=null;viewAt=0;checkedAt;gen=0;leaving=!1;get conflicted(){return this.stopped==="conflict"}get lastSavedAt(){return this.savedAt}send(e){this.shown=e.state,this.o.onState(e)}modelChanged(){if(!this.stopped){if(!this.writing&&this.o.getDoc()===this.savedDoc){this.dirty=!1,this.timer&&(clearTimeout(this.timer),this.timer=null),this.send({state:"saved",at:this.savedAt}),this.viewDirty&&this.kickView();return}this.dirty=!0,this.send({state:"pending"}),this.kick()}}viewChanged(){this.stopped||(this.viewDirty=!0,this.dirty||this.kickView())}refill(e){if(this.tokens>=this.burst){this.refillAt=e;return}const t=Math.floor((e-this.refillAt)/this.interval);t>0&&(this.tokens=Math.min(this.burst,this.tokens+t),this.refillAt=this.tokens>=this.burst?e:this.refillAt+t*this.interval)}kick(){if(this.stopped||this.writing||this.timer)return;if(this.failures){this.schedule(Yu[Math.min(this.failures-1,Yu.length-1)]);return}const e=Date.now();if(this.refill(e),this.tokens>=1){this.tokens-=1,this.write();return}this.schedule(Math.max(0,this.refillAt+this.interval-e))}schedule(e){this.stopped||(this.timer&&clearTimeout(this.timer),this.timer=setTimeout(()=>{this.timer=null,this.refill(Date.now()),this.tokens>=1&&(this.tokens-=1),this.write()},e))}clearViewTimer(){this.viewTimer&&clearTimeout(this.viewTimer),this.viewTimer=null}kickView(){if(this.stopped||!this.viewDirty||this.viewTimer||this.viewWriting)return;const e=this.viewAt+this.viewInterval-Date.now();if(e<=0){this.writeView();return}this.viewTimer=setTimeout(()=>{this.viewTimer=null,this.dirty||this.writeView()},e)}writeView(e=!1){if(this.stopped||!this.viewDirty||this.viewWriting&&!e)return;this.clearViewTimer(),this.viewDirty=!1,this.viewAt=Date.now();const i=this.o.store.saveView(this.o.getView()).catch(r=>{this.o.log?.("the view was not saved",r)}).finally(()=>{this.viewWriting===i&&(this.viewWriting=null),this.viewDirty&&!this.dirty&&this.kickView()});this.viewWriting=i}async write(){if(this.stopped)return;if(!this.dirty){(this.shown==="pending"||this.shown==="saving")&&this.send({state:"saved",at:this.savedAt}),this.viewDirty&&this.kickView();return}if(this.writing)return;const e=this.doWrite();this.writing=e;try{await e}finally{this.writing=null}this.afterWrite()}afterWrite(){if(!this.stopped){if(this.dirty&&this.o.getDoc()===this.savedDoc&&(this.dirty=!1,this.send({state:"saved",at:this.savedAt})),!this.dirty){this.urgent=!1,!this.leaving&&(this.shown==="saving"||this.shown==="pending")&&this.send({state:"saved",at:this.savedAt}),this.viewDirty&&this.kickView();return}if(!this.timer){if(this.urgent&&!this.failures){this.urgent=!1,this.write();return}this.kick()}}}async doWrite(){const e=this.viewDirty&&!this.viewWriting,t=this.o.getDoc(),i=this.gen;this.dirty=!1,e&&(this.viewDirty=!1,this.clearViewTimer(),this.viewAt=Date.now()),this.send({state:"saving"});try{const r=await this.o.store.saveModel(t,this.etag);if(this.checkedAt=Date.now(),i===this.gen&&(this.etag=r,this.savedDoc=t),e&&i===this.gen&&await this.o.store.saveView(this.o.getView()).catch(s=>{this.o.log?.("the view was not saved",s)}),this.failures=0,i!==this.gen)return;this.savedAt=new Date().toISOString(),this.dirty||this.send({state:"saved",at:this.savedAt})}catch(r){if(i!==this.gen){this.o.log?.("a save overtaken by the save on leaving failed",r);return}if(r instanceof au){this.stopped="conflict",this.timer&&clearTimeout(this.timer),this.timer=null,this.clearViewTimer(),this.send({state:"conflict",message:"Changed in another tab"});return}this.failures++,this.dirty=!0,e&&(this.viewDirty=!0),this.o.log?.("the model was not saved",r),this.send({state:"error",message:Ku(r)})}}flushNow(){if(!this.stopped&&(this.viewDirty&&!this.dirty&&this.writeView(!0),!!this.dirty)){if(this.timer&&(clearTimeout(this.timer),this.timer=null),this.writing){this.urgent=!0;return}this.write()}}leaveNow(){if(this.stopped||(this.viewDirty&&this.writeView(!0),!this.dirty&&(!this.writing||this.o.getDoc()===this.savedDoc)))return;const e=this.o.store;if(typeof e.saveModelNow!="function"||Date.now()-this.checkedAt>vm){this.flushNow();return}this.timer&&(clearTimeout(this.timer),this.timer=null);const t=this.o.getDoc(),i={etag:this.etag,doc:this.savedDoc},r=++this.gen;let s;try{s=e.saveModelNow(t,this.etag)}catch(a){this.o.log?.("the model was not saved",a),this.flushNow();return}this.etag=s.etag,this.savedDoc=t,this.dirty=!1,this.urgent=!1,this.leaving=!0,this.send({state:"saving"}),s.done.then(()=>{r===this.gen&&(this.leaving=!1),!(this.stopped||r!==this.gen)&&(this.checkedAt=Date.now(),this.failures=0,this.savedAt=new Date().toISOString(),!this.dirty&&!this.writing&&this.send({state:"saved",at:this.savedAt}))},a=>{r===this.gen&&(this.leaving=!1),!(this.stopped||r!==this.gen)&&(this.etag=i.etag,this.savedDoc=i.doc,this.failures++,this.dirty=!0,this.o.log?.("the model was not saved",a),this.send({state:"error",message:Ku(a)}),this.kick())})}retryNow(){this.stopped||!this.dirty||this.writing||(this.timer&&(clearTimeout(this.timer),this.timer=null),this.write())}async flush(){let e=0;for(;;){if(this.writing){await this.writing.catch(()=>{}),await Promise.resolve();continue}if(this.viewWriting){await this.viewWriting,await Promise.resolve();continue}if(this.stopped||!this.dirty&&!this.viewDirty||e>=2)return;this.timer&&(clearTimeout(this.timer),this.timer=null),e++,this.dirty?await this.write():this.writeView()}}dispose(){this.timer&&clearTimeout(this.timer),this.timer=null,this.clearViewTimer(),this.stopped||(this.stopped="disposed")}}const ou={mm:1,cm:10,m:1e3,in:25.4,ft:304.8},Do={deg:1,rad:180/Math.PI},lu=["sin","cos","tan","sqrt","abs","min","max"],ch=["pi"],uh={mm:{v:1,L:1,A:0},cm:{v:10,L:1,A:0},m:{v:1e3,L:1,A:0},in:{v:25.4,L:1,A:0},ft:{v:304.8,L:1,A:0},deg:{v:1,L:0,A:1},rad:{v:180/Math.PI,L:0,A:1},"°":{v:1,L:0,A:1}};function No(n){return Object.prototype.hasOwnProperty.call(uh,n.toLowerCase())}function ym(n){const e=n.toLowerCase();return No(e)||lu.includes(e)||ch.includes(e)}class _t extends Error{constructor(e,t){super(e),this.at=t,this.name="ExprError"}}const bm=/^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/,Sm=/^[A-Za-z_][A-Za-z0-9_]*/;function fh(n){const e=[];let t=0;for(;t<n.length;){const i=n[t];if(/\s/.test(i)){t++;continue}const r=n.slice(t),s=bm.exec(r);if(s){e.push({t:"num",v:Number(s[0]),at:t,end:t+s[0].length}),t+=s[0].length;continue}const a=Sm.exec(r);if(a){e.push({t:"id",s:a[0],at:t,end:t+a[0].length}),t+=a[0].length;continue}if(i==="°"){e.push({t:"deg",at:t,end:t+1}),t++;continue}if("+-*/^(),".includes(i)){e.push({t:"op",s:i,at:t,end:t+1}),t++;continue}throw new _t(`"${i}" is not allowed here`,t)}return e.push({t:"end",at:n.length,end:n.length}),e}function dh(n){if(!n.trim())throw new _t("Enter a value",0);const e=fh(n);let t=0;const i=()=>e[t],r=g=>{const p=e[t];return p.t==="op"&&p.s===g};function s(g){if(!r(g)){const p=i();throw new _t(p.t==="end"?`Missing "${g}"`:`Expected "${g}" before ${a(p)}`,p.at)}t++}function a(g){return g.t==="end"?"the end":g.t==="num"?`"${n.slice(g.at,g.end)}"`:g.t==="id"?`"${g.s}"`:g.t==="deg"?'"°"':`"${g.s}"`}function o(){let g=l();for(;r("+")||r("-");){const p=e[t++],m=l();g={k:"bin",op:p.s,a:g,b:m,at:p.at}}return g}function l(){let g=c();for(;r("*")||r("/");){const p=e[t++],m=c();g={k:"bin",op:p.s,a:g,b:m,at:p.at}}return g}function c(){if(r("-")){const g=e[t++].at;return{k:"neg",a:c(),at:g}}return r("+")?(t++,c()):f()}function f(){const g=d();if(r("^")){const p=e[t++].at;return{k:"bin",op:"^",a:g,b:c(),at:p}}return g}function d(){const g=i(),p=u(),m=i(),v=g.t==="num"||g.t==="op"&&g.s==="("||p.k==="ref"&&p.name.toLowerCase()==="pi";if(v&&m.t==="deg")return t++,{k:"unit",a:p,unit:"°",at:m.at};if(v&&m.t==="id"){if(No(m.s))return t++,{k:"unit",a:p,unit:m.s.toLowerCase(),at:m.at};throw new _t(`"${m.s}" is not a unit (use * to multiply)`,m.at)}return p}function u(){const g=i();if(g.t==="num")return t++,{k:"num",v:g.v,at:g.at};if(g.t==="id"){if(t++,r("(")){t++;const p=[];if(!r(")"))for(p.push(o());r(",");)t++,p.push(o());return s(")"),{k:"call",fn:g.s,args:p,at:g.at}}return{k:"ref",name:g.s,at:g.at}}if(g.t==="op"&&g.s==="("){t++;const p=o();return s(")"),p}throw g.t==="end"?new _t(`"${n.trim()}" is incomplete`,g.at):new _t(`Expected a number, a parameter or "(" before ${a(g)}`,g.at)}const h=o(),_=i();if(_.t!=="end")throw _.t==="op"&&_.s===")"?new _t('There is a ")" without a matching "("',_.at):new _t(`Expected an operator before ${a(_)}`,_.at);return h}function Mm(n){const e=[],t=i=>{switch(i.k){case"ref":!ch.includes(i.name.toLowerCase())&&!e.includes(i.name)&&e.push(i.name);break;case"call":i.args.forEach(t);break;case"neg":case"unit":t(i.a);break;case"bin":t(i.a),t(i.b);break}};return t(n),e}function Zl(n){try{return Mm(dh(n))}catch{return[]}}function Ka(n,e,t){let i;try{i=fh(n)}catch{return n}let r="",s=0;for(let a=0;a<i.length;a++){const o=i[a];if(o.t!=="id"||o.s!==e)continue;const l=i[a+1],c=i[a-1];l&&l.t==="op"&&l.s==="("||c&&(c.t==="num"||c.t==="op"&&c.s===")")&&No(o.s)||(r+=n.slice(s,o.at)+t,s=o.end)}return r+n.slice(s)}const Mi=n=>n.L===0&&n.A===0,Zu=n=>n.L===1&&n.A===0||n.L===0&&n.A===1,hh=(n,e)=>n.L===e.L&&n.A===e.A;function ri(n){const{L:e,A:t}=n;return e===0&&t===0?"a number":t===0&&e===1?"a length":t===0&&e===2?"an area":t===0&&e===3?"a volume":e===0&&t===1?"an angle":`a quantity in ${[e?`mm${e===1?"":`^${e}`}`:"",t?`deg${t===1?"":`^${t}`}`:""].filter(Boolean).join("·")}`}function Ju(n,e,t){return e.L===1?{v:n.v*ou[t.length],L:1,A:0}:{v:n.v*Do[t.angle],L:0,A:1}}function ph(n,e,t,i,r){if(hh(n,e))return[n,e];if(Mi(n)&&Zu(e))return[Ju(n,e,t),e];if(Mi(e)&&Zu(n))return[n,Ju(e,n,t)];throw new _t(`Cannot ${i} ${ri(n)} and ${ri(e)}`,r)}const Qu=1e-9;function Xr(n,e,t){switch(n.k){case"num":return{v:n.v,L:0,A:0};case"unit":{const i=Xr(n.a,e,t);if(!Mi(i))throw new _t(`A unit can follow only a plain number, not ${ri(i)}`,n.at);const r=uh[n.unit];return{v:i.v*r.v,L:r.L,A:r.A}}case"ref":{const i=n.name.toLowerCase();if(i==="pi")return{v:Math.PI,L:0,A:0};if(lu.includes(i))throw new _t(`${i} needs parentheses, as in ${i}(30 deg)`,n.at);if(No(i))throw new _t(`"${n.name}" is a unit: write it after a number, as in 20 ${i}`,n.at);const r=e.param(n.name);if(!r)throw new _t(`Unknown parameter "${n.name}"`,n.at);if(t.add(n.name),!r.ok)throw new _t(r.error.startsWith("Circular reference")||r.error.startsWith('Parameter "')?r.error:`Parameter "${n.name}" has an error: ${r.error}`,n.at);return r.q}case"neg":{const i=Xr(n.a,e,t);return{...i,v:-i.v}}case"bin":{const i=Xr(n.a,e,t),r=Xr(n.b,e,t);switch(n.op){case"+":case"-":{const[s,a]=ph(i,r,e.units,n.op==="+"?"add":"subtract",n.at);return{v:n.op==="+"?s.v+a.v:s.v-a.v,L:s.L,A:s.A}}case"*":return{v:i.v*r.v,L:i.L+r.L,A:i.A+r.A};case"/":if(r.v===0)throw new _t("Division by zero",n.at);return{v:i.v/r.v,L:i.L-r.L,A:i.A-r.A};case"^":{if(!Mi(r))throw new _t(`The power must be a plain number, not ${ri(r)}`,n.at);const s=i.L*r.v,a=i.A*r.v;if(Math.abs(s-Math.round(s))>Qu||Math.abs(a-Math.round(a))>Qu)throw new _t(`Cannot raise ${ri(i)} to the power ${r.v}`,n.at);return{v:Math.pow(i.v,r.v),L:Math.round(s),A:Math.round(a)}}}break}case"call":return wm(n,e,t)}throw new _t("Unsupported expression",0)}function wm(n,e,t){const i=n.fn.toLowerCase();if(!lu.includes(i))throw e.param(n.fn)?new _t(`"${n.fn}" is a parameter, not a function (use * to multiply)`,n.at):new _t(`Unknown function "${n.fn}"`,n.at);const r=n.args.map(a=>Xr(a,e,t)),s=()=>{if(r.length!==1)throw new _t(`${i} takes one value`,n.at);return r[0]};switch(i){case"sin":case"cos":case"tan":{const a=s();let o;if(a.L===0&&a.A===1)o=a.v;else if(Mi(a))o=a.v*Do[e.units.angle];else throw new _t(`${i} takes an angle, not ${ri(a)}`,n.at);const l=o*Math.PI/180;return{v:i==="sin"?Math.sin(l):i==="cos"?Math.cos(l):Math.tan(l),L:0,A:0}}case"sqrt":{const a=s();if(a.L%2!==0||a.A%2!==0)throw new _t(`Cannot take the square root of ${ri(a)}`,n.at);if(a.v<0)throw new _t("Cannot take the square root of a negative number",n.at);return{v:Math.sqrt(a.v),L:a.L/2,A:a.A/2}}case"abs":{const a=s();return{...a,v:Math.abs(a.v)}}case"min":case"max":{if(!r.length)throw new _t(`${i} needs at least one value`,n.at);const a=r.find(c=>!Mi(c)),o=a?r.map(c=>ph(c,a,e.units,"compare",n.at)[0]):r;for(const c of o)if(!hh(c,o[0]))throw new _t(`Cannot compare ${ri(o[0])} and ${ri(c)}`,n.at);return{v:i==="min"?Math.min(...o.map(c=>c.v)):Math.max(...o.map(c=>c.v)),L:o[0].L,A:o[0].A}}}throw new _t(`Unknown function "${n.fn}"`,n.at)}const Em={length:"a length",angle:"an angle",scalar:"a number without units"};function Tm(n){return n==="length"?{L:1,A:0}:n==="angle"?{L:0,A:1}:{L:0,A:0}}function Am(n,e,t){if(e==="length"){if(n.L===1&&n.A===0)return n.v;if(Mi(n))return n.v*ou[t.length]}else if(e==="angle"){if(n.L===0&&n.A===1)return n.v;if(Mi(n))return n.v*Do[t.angle]}else if(Mi(n))return n.v;throw new _t(`Expected ${Em[e]}, got ${ri(n)}`)}function mh(n,e,t){const i=new Set;try{const r=dh(String(n??"")),s=Xr(r,t,i),a=Am(s,e,t.units);return Number.isFinite(a)?{ok:!0,value:a,quantity:e,uses:[...i]}:{ok:!1,error:"The result is not a finite number"}}catch(r){return r instanceof _t?r.at===void 0?{ok:!1,error:r.message}:{ok:!1,error:r.message,at:r.at}:{ok:!1,error:String(r instanceof Error?r.message:r)}}}const Rm=2e4,Cm=6e4,Pm={import_step:3e5,export_step:12e4,props:12e4,topo:12e4,tessellate:6e4,check:6e4};function gh(n){return Pm[n]??Rm}const _h=2e3,Lm=12e4;function vh(n,e){return e>_h?Math.max(Lm,gh(n)):void 0}const xh=[.001,.01],Dm=.001,yh={join:"join",cut:"cut",intersect:"intersect"};async function Xs(n,e,t,i,r){let s=0;for(const c of[...t,...i])s+=await n.faces(c);const a=vh("boolean",s),l=(await n.kernel.call("boolean",{op:e,targets:t,tools:i,...r?{fuzzy:r}:{}},a?{timeoutMs:a}:{})).result;return{id:l.id,valid:l.valid!==!1,empty:!!l.empty,solids:typeof l.solids=="number"?l.solids:1,reason:l.reason}}function Nm(n,e){return n==="join"?`Nothing to join: ${e} shares no face with a body made before it`:`Nothing to ${yh[n]}: ${e} does not overlap any body made before it (touching is not enough)`}function Im(n,e,t){return n[0]<=e[3]+t&&e[0]<=n[3]+t&&n[1]<=e[4]+t&&e[1]<=n[4]+t&&n[2]<=e[5]+t&&e[2]<=n[5]+t}async function ju(n,e){const t=await n.kernel.call("props",{id:e,volume:!0,bbox:"none",bbox_mode:"fast"});return typeof t.result.volume=="number"?t.result.volume:NaN}async function Um(n,e){let t=null;try{const i=vh("repair",await n.faces(e)),r=await n.kernel.call("repair",{id:e},i?{timeoutMs:i}:{});if(t=r.result.id,r.result.valid===!1)return null;const[s,a]=[await ju(n,e),await ju(n,t)];if(!(s>0)||!(a>0)||Math.abs(a-s)>Dm*s)return null;const o=t;return t=null,o}catch(i){const r=i.kind;if(r==="occt"||r==="input"||r==="internal")return null;throw i}finally{t!=null&&await n.release([t])}}async function bh(n,e,t,i){if(n.op==="new")return t.valid?n.creates?{ok:!0,bodies:[{id:n.creates,shape:t.shape,valid:!0}],removed:[]}:(await i.release([t.shape]),{ok:!1,message:`${e} has no body to create`}):(await i.release([t.shape]),{ok:!1,message:`${e} failed: the result is not a valid solid`});const r=[],s=n.repair?.fuzzy;try{if(!t.valid)return{ok:!1,message:`${e} failed: its shape is not a valid solid`};const a=yh[n.op];let o;const l=new Map;if(n.scope.length){if(o=n.scope.map(m=>i.bodies.get(m)).filter(m=>!!m),!o.length){const m=n.scope.map(v=>i.bodyName(v)).join(", ");return{ok:!1,message:`Nothing to ${a}: ${m} ${n.scope.length===1?"is":"are"} not there at this point`}}}else{const m=await i.bbox(t.shape),v=1e-7*Math.max(1,Math.hypot(m[3]-m[0],m[4]-m[1],m[5]-m[2]));o=[];for(const w of i.bodies.values()){if(!Im(m,await i.bbox(w.shape),v))continue;const y=await Xs(i,"common",[w.shape],[t.shape],s);if(y.empty){if(await i.release([y.id]),n.op==="join"){const S=await Xs(i,"fuse",[w.shape],[t.shape],s);await i.release([S.id]),S.valid&&!S.empty&&S.solids===1&&o.push(w)}continue}o.push(w),n.op==="intersect"?(r.push(y.id),l.set(w.id,y)):await i.release([y.id])}if(!o.length)return{ok:!1,message:Nm(n.op,e)}}const c=[],f=[],d=[];if(n.op==="join"){const[m,...v]=o,w=await Xs(i,"fuse",[m.shape],[t.shape,...v.map(y=>y.shape)],s);r.push(w.id),c.push({id:m.id,shape:w.id,valid:w.valid,reason:w.reason}),f.push(...v.map(y=>y.id))}else for(const m of o){let v=l.get(m.id);v||(v=await Xs(i,n.op==="cut"?"cut":"common",[m.shape],[t.shape],s),r.push(v.id)),v.empty?(f.push(m.id),d.push(i.bodyName(m.id))):c.push({id:m.id,shape:v.id,valid:v.valid,reason:v.reason})}const u=[];if(n.repair)for(const m of c){if(m.valid)continue;const v=await Um(i,m.shape);v!=null&&(r.push(v),m.shape=v,m.valid=!0,u.push(i.bodyName(m.id)))}const h=c.find(m=>!m.valid);if(h){const m=h.reason?`: ${h.reason.replace(/^invalid result\s*/i,"").trim()}`:"",v=s?` (repair with a ${s} mm tolerance did not fix it)`:"",w=xh.find(y=>y>(s??0));return{ok:!1,message:`${e} failed: the result is not a valid solid${v}${m}`,actions:w?["repair"]:void 0}}const _=new Set(c.map(m=>m.shape)),g=r.filter(m=>!_.has(m));r.length=0,await i.release(g);const p=[];return d.length&&p.push(`${d.join(", ")} ${d.length===1?"was":"were"} removed completely`),u.length&&p.push(`${u.join(", ")} ${u.length===1?"was":"were"} repaired: check the result`),{ok:!0,bodies:c.map(({id:m,shape:v,valid:w})=>({id:m,shape:v,valid:w})),removed:f,...p.length?{warning:p.join("; ")}:{}}}finally{await i.release([t.shape,...r]).catch(()=>{})}}const Fm="M3 9l5-4h13v10l-5 4H3z M3 9h13v10 M16 9l5-4",Bm="M6 6a6 2.5 0 1 0 12 0a6 2.5 0 1 0 -12 0 M6 6v12a6 2.5 0 0 0 12 0V6",Sh={mm:"20 mm",cm:"2 cm",m:"0.02 m",in:"1 in",ft:"1 in"},Om={"origin:x":[1,0,0],"origin:y":[0,1,0],"origin:z":[0,0,1]},km=1e-6;function Mh(n,e){return e>0?e<km?`${n} must be at least 0.000001 mm`:null:`${n} must be more than 0`}function wh(n,e){const t=[];for(const i of n){const r=e.evaluate(typeof i.expr=="string"?i.expr:String(i.expr??""),i.quantity);if(!r.ok)return{ok:!1,message:`${i.label}: ${r.error}`};if(i.positive){const s=Mh(i.label,r.value);if(s)return{ok:!1,message:s}}t.push(r.value)}return{ok:!0,values:t}}function Eh(n){return n.features.map(e=>e.name)}const Th={type:"box",label:"Box",icon:Fm,create(n,e={}){const t=Sh[n.units.length];return{id:$i("f"),type:"box",name:su("Box",Eh(n)),op:"new",creates:null,scope:[],origin:["0","0","0"],size:[t,t,t],...e}},resolve(n,e){const t=n.origin??["","",""],i=n.size??["","",""],r=wh([{label:"Length",expr:i[0],quantity:"length",positive:!0},{label:"Width",expr:i[1],quantity:"length",positive:!0},{label:"Height",expr:i[2],quantity:"length",positive:!0},{label:"Corner X",expr:t[0],quantity:"length"},{label:"Corner Y",expr:t[1],quantity:"length"},{label:"Corner Z",expr:t[2],quantity:"length"}],e);if(!r.ok)return r;const[s,a,o,l,c,f]=r.values;return{ok:!0,values:{size:[s,a,o],origin:[l,c,f]}}},incomplete(n,e){const t=Th.resolve(n,e);return t.ok?null:t.message},parents:()=>[],async build(n,e,t){const i=await t.kernel.call("box",{dx:e.size[0],dy:e.size[1],dz:e.size[2],origin:e.origin});return bh(n,n.name,{shape:i.result.id,valid:i.result.valid!==!1},t)}},Ah={type:"cylinder",label:"Cylinder",icon:Bm,create(n,e={}){const t=Sh[n.units.length];return{id:$i("f"),type:"cylinder",name:su("Cylinder",Eh(n)),op:"new",creates:null,scope:[],origin:["0","0","0"],axis:"origin:z",diameter:t,height:t,...e}},resolve(n,e){const t=Om[n.axis];if(!t)return{ok:!1,message:"Axis: pick the X, Y or Z axis"};const i=n.origin??["","",""],r=wh([{label:"Diameter",expr:n.diameter,quantity:"length",positive:!0},{label:"Height",expr:n.height,quantity:"length",positive:!0},{label:"Centre X",expr:i[0],quantity:"length"},{label:"Centre Y",expr:i[1],quantity:"length"},{label:"Centre Z",expr:i[2],quantity:"length"}],e);if(!r.ok)return r;const[s,a,o,l,c]=r.values;return{ok:!0,values:{diameter:s,height:a,origin:[o,l,c],axis:t}}},incomplete(n,e){const t=Ah.resolve(n,e);return t.ok?null:t.message},parents:()=>[],async build(n,e,t){const i=await t.kernel.call("cylinder",{r:e.diameter/2,h:e.height,origin:e.origin,axis:e.axis});return bh(n,n.name,{shape:i.result.id,valid:i.result.valid!==!1},t)}};function zm(){const n=new Map;return{register(e){n.set(e.type,e)},get:e=>n.get(e),all:()=>[...n.values()]}}function Vm(){const n=zm();return n.register(Th),n.register(Ah),n}const Hm=/^[A-Za-z_][A-Za-z0-9_]*$/,ef=64;function Rh(n,e,t){return n?n.length>ef?`A name can have at most ${ef} characters`:Hm.test(n)?ym(n)?`"${n}" is a unit or function name`:e.find(r=>r.id!==t&&r.name===n)?`There is already a parameter called ${n}`:null:"A name starts with a letter or _ and has only letters, digits and _":"Enter a name"}function Ch(n,e){const t=new Map(n.map(l=>[l.name,l])),i=new Map,r=new Map,s=[];function a(l){const c=t.get(l);if(!c)return;const f=i.get(l);if(f)return f;const d=s.indexOf(l);if(d>=0)return{ok:!1,error:`Circular reference: ${[...s.slice(d),l].join(" → ")}`};s.push(l);let u;try{u=mh(c.expr,c.quantity,o)}finally{s.pop()}const h=u.ok?{ok:!0,value:u.value,q:{v:u.value,...Tm(c.quantity)}}:{ok:!1,error:u.error};return i.set(l,h),r.set(l,u),h}const o={units:e,param(l){const c=a(l);if(c)return c.ok?{ok:!0,q:c.q}:{ok:!1,error:c.error}},valueOf(l){if(t.has(l))return a(l),r.get(l)??{ok:!1,error:i.get(l)?.ok===!1?i.get(l).error:"Not evaluated"}}};return o}const tf=new WeakMap;function Gm(n,e){const t=`${e.length}|${e.angle}`,i=tf.get(n);if(i&&i.key===t)return i.scope;const r=Ch(n,e);return tf.set(n,{key:t,scope:r}),r}function Ph(n){const e=[],t=(r,s)=>{if(typeof r=="string")e.push({path:s,expr:r});else if(Array.isArray(r))r.forEach((a,o)=>t(a,`${s}[${o}]`));else if(r&&typeof r=="object")for(const[a,o]of Object.entries(r))t(o,s?`${s}.${a}`:a)},i=new Set(["id","type","name","op","creates","scope","axis","suppressed","repair"]);for(const[r,s]of Object.entries(n))i.has(r)||t(s,r);return e}function Wm(n,e){return{params:n.params.filter(t=>t.name!==e&&Zl(t.expr).includes(e)),features:n.features.filter(t=>Ph(t).some(i=>Zl(i.expr).includes(e)))}}function Jl(n){return n===null||typeof n!="object"?typeof n=="number"&&!Number.isFinite(n)?"null":JSON.stringify(n)??"null":Array.isArray(n)?`[${n.map(t=>t===void 0?"null":Jl(t)).join(",")}]`:`{${Object.keys(n).filter(t=>n[t]!==void 0).sort().map(t=>`${JSON.stringify(t)}:${Jl(n[t])}`).join(",")}}`}function $m(n,e=0){let t=3735928559^e,i=1103547991^e;for(let r=0;r<n.length;r++){const s=n.charCodeAt(r);t=Math.imul(t^s,2654435761),i=Math.imul(i^s,1597334677)}return t=Math.imul(t^t>>>16,2246822507)^Math.imul(i^i>>>13,3266489909),i=Math.imul(i^i>>>16,2246822507)^Math.imul(t^t>>>13,3266489909),(4294967296*(2097151&i)+(t>>>0)).toString(36)}const lo="0.1.0",cu="#bdc9db",Lh=/^#[0-9a-fA-F]{6}$/;function Xm(n){return{length:n==="imperial"?"in":"mm",angle:"deg"}}function nf(n,e=new Date){return{schema:Ms,units:Xm(n),params:[],bodies:{},features:[],meta:{created_at:e.toISOString(),written_by:lo}}}function Dh(){return{rollback:null,hiddenBodies:[],expanded:["origin"]}}function Za(n){if(n&&typeof n=="object"&&!Object.isFrozen(n)){Object.freeze(n);for(const e of Object.keys(n))Za(n[e])}return n}class tn extends Error{constructor(e){super(e),this.name="DocReadError"}}const qm=["mm","cm","m","in","ft"],Ym=["length","angle","scalar"];function ur(n,e,t){return typeof t=="string"&&t.trim()?`${n} "${t.trim()}"`:`${n} ${e+1}`}function Km(n){if(n==null)return[];if(!Array.isArray(n))throw new tn("its parameters are not a list");return n.map((e,t)=>{if(!e||typeof e!="object")throw new tn(`${ur("parameter",t,null)} is not a parameter`);const i=e;if(typeof i.name!="string"||!i.name.trim())throw new tn(`${ur("parameter",t,null)} has no name`);if(typeof i.expr!="string")throw new tn(`${ur("parameter",t,i.name)} has no expression`);if(!Ym.includes(i.quantity))throw new tn(`${ur("parameter",t,i.name)} does not say whether it is a length, an angle or a number`);return typeof i.id=="string"&&i.id?e:{...i,id:$i("p")}})}function Zm(n){if(n==null)return[];if(!Array.isArray(n))throw new tn("its features are not a list");return n.map((e,t)=>{if(!e||typeof e!="object")throw new tn(`${ur("feature",t,null)} is not a feature`);const i=e;if(typeof i.name!="string"||!i.name.trim())throw new tn(`${ur("feature",t,null)} has no name`);if(typeof i.type!="string"||!i.type)throw new tn(`${ur("feature",t,i.name)} has no type`);return typeof i.id=="string"&&i.id?e:{...i,id:$i("f")}})}function uu(n){if(!n||typeof n!="object")throw new tn("the model file is not a Part document");const e=n;if(typeof e.schema!="number")throw new tn("the model file has no schema version");if(e.schema>Ms)throw new tn(`it was saved by a newer Magnusim CAD (schema ${e.schema}); this one reads schema ${Ms}`);if(e.schema!==Ms)throw new tn(`schema ${e.schema} is not known`);const t=e.units&&typeof e.units=="object"?e.units:{},i={schema:Ms,units:{length:qm.includes(t.length)?t.length:"mm",angle:t.angle==="rad"?"rad":"deg"},params:Km(e.params),bodies:{},features:Zm(e.features),meta:{created_at:typeof e.meta?.created_at=="string"?e.meta.created_at:new Date().toISOString(),written_by:typeof e.meta?.written_by=="string"?e.meta.written_by:"unknown"}};if(e.bodies&&typeof e.bodies=="object")for(const[r,s]of Object.entries(e.bodies)){const a=s&&typeof s=="object"?s:{};i.bodies[r]={name:typeof a.name=="string"&&a.name?a.name:"Body",color:typeof a.color=="string"&&Lh.test(a.color)?a.color:cu}}return i}function Jm(n,e){const t=n&&typeof n=="object"?n:{},i=Dh();typeof t.rollback=="number"&&Number.isInteger(t.rollback)&&t.rollback>=0&&t.rollback<e&&(i.rollback=t.rollback),Array.isArray(t.hiddenBodies)&&(i.hiddenBodies=t.hiddenBodies.filter(s=>typeof s=="string")),Array.isArray(t.expanded)&&(i.expanded=t.expanded.filter(s=>typeof s=="string")),t.planes==="always"&&(i.planes="always");const r=Nh(t.camera);return r&&(i.camera=r),i}const Vo=n=>Array.isArray(n)&&n.length===3&&n.every(e=>typeof e=="number"&&Number.isFinite(e))?[n[0],n[1],n[2]]:null;function Nh(n){if(!n||typeof n!="object")return null;const e=n,t=Vo(e.position),i=Vo(e.target),r=Vo(e.up);if(!t||!i||!r)return null;const s=Math.hypot(t[0]-i[0],t[1]-i[1],t[2]-i[2]);if(!(s>0)||!(Math.hypot(...r)>0))return null;const a=typeof e.orthoHeight=="number"&&Number.isFinite(e.orthoHeight)&&e.orthoHeight>0?e.orthoHeight:s;return{position:t,target:i,up:r,orthoHeight:a,projection:e.projection==="orthographic"?"orthographic":"perspective"}}function Qm(n){if(!Number.isFinite(n))return String(n);const e=Math.abs(n);return e!==0&&(e<.001||e>=1e6)?n.toExponential(4):String(Number(n.toPrecision(6)))}const jm=Object.freeze([]);function Ih(n,e=()=>jm){function t(i){return i==="length"?n().length:i==="angle"?n().angle==="deg"?"°":"rad":""}return{units:n,unitLabel:t,evaluate(i,r){return mh(i,r,Gm(e(),n()))},format(i,r,s={}){let a=i;r==="length"&&(a=i/ou[n().length]),r==="angle"&&(a=i/Do[n().angle]);const o=s.digits!=null?String(Number(a.toFixed(s.digits))):Qm(a),l=t(r);return s.unit===!1||!l?o:l==="°"?`${o}°`:`${o} ${l}`}}}const eg=_h,tg=200,ng=3,Uh="\0name\0";function Ho(n,e){return e?n.split(e).join(Uh):n}function Go(n,e){return n.split(Uh).join(e)}function Wo(n){return n.kind==="watchdog"||n.kind==="trap"||n.kind==="crash"||!!n.oom}function ig(n){const e=n.split(/:\s*/).map(t=>t.trim()).filter(Boolean);return e.length&&e.every(t=>/^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/.test(t))?`the geometry kernel could not build it (${e[e.length-1]})`:n}function rg(n,e){return e.kind==="watchdog"?`${n.name} was stopped after ${(e.seconds??0).toFixed(1)} s`:e.oom?`${n.name} ran out of memory: ${e.message}`:`${n.name} stopped the kernel: ${e.message}`}function sg(n){const e=i=>new Float32Array(n[i]??new ArrayBuffer(0)),t=i=>new Uint32Array(n[i]??new ArrayBuffer(0));return{positions:e("positions"),normals:e("normals"),indices:t("indices"),faceRanges:t("face_ranges"),edgePositions:e("edge_positions"),edgeRanges:t("edge_ranges"),edgeFlags:n.edge_flags?new Uint8Array(n.edge_flags):null}}function ag(n){if(n.length<3)return[0,0,0,0,0,0];const e=[1/0,1/0,1/0,-1/0,-1/0,-1/0];for(let t=0;t+2<n.length;t+=3)for(let i=0;i<3;i++){const r=n[t+i];r<e[i]&&(e[i]=r),r>e[i+3]&&(e[i+3]=r)}return e}class og{constructor(e){this.opts=e,this.offRespawn=e.kernel.onRespawn(t=>{this.epoch++,this.cache.clear(),this.tess.clear(),this.props.clear(),this.bboxes.clear(),this.latestBodies=[],this.opts.onRespawn?.(t),this.respawnsInARow++;const i=this.pending??this.last;if(!(!i||this.disposed)){if(this.respawnsInARow>ng){this.pending=null;const r={};for(const s of i.doc.features)r[s.id]={state:"pending"};this.opts.onResult({features:r,bodies:[],ms:0,failed:[],message:`The kernel stopped ${this.respawnsInARow} times in a row while rebuilding (${t}). Edit the part or reload it to try again.`},i);return}this.pending=i,this.pump()}})}epoch=0;seq=0;running=!1;pending=null;last=null;disposed=!1;cache=new Map;tess=new Map;props=new Map;bboxes=new Map;stopped=new Map;respawnsInARow=0;idle=Promise.resolve();idleResolve=null;latestBodies=[];offRespawn;request(e){this.disposed||(this.respawnsInARow=0,this.pending=e,this.pump())}whenIdle(){return this.idle}retry(e){let t=!1;for(const[i,r]of this.stopped)r.feature===e&&(this.stopped.delete(i),t=!0);return t&&this.last&&this.request(this.last),t}async measure(e){const t=this.latestBodies.find(i=>i.id===e);if(!t)throw new Error("That body is not in the part at the rollback position");return this.propsOf(t.shape,this.epoch)}dispose(){this.disposed=!0,this.offRespawn(),this.pending=null}async pump(){if(!(this.running||this.disposed)){this.running=!0,this.idle=new Promise(e=>this.idleResolve=e);try{for(;this.pending&&!this.disposed;){const e=this.pending;this.pending=null,this.last=e,this.opts.onStart?.();const t=await this.build(e).catch(i=>({features:{},bodies:[],ms:0,failed:[],message:`The rebuild failed: ${i instanceof Error?i.message:String(i)}`}));t&&!this.disposed&&(t.message||(this.respawnsInARow=0),this.opts.onResult(t,e),!this.pending&&!t.message&&await this.opts.kernel.recycleIfLarge().catch(()=>!1))}}finally{this.running=!1;const e=this.idleResolve;this.idleResolve=null,e?.()}}}async release(e,t){if(!(!e.length||t!==this.epoch)){for(const i of e)this.tess.delete(i),this.props.delete(i),this.bboxes.delete(i);await this.opts.kernel.call("release",{ids:e}).catch(()=>{})}}async propsOf(e,t){const i=this.props.get(e);if(i)return i;const s=(await this.opts.kernel.call("props",{id:e,volume:!0,area:!0,bbox:"exact",bbox_mode:"optimal"})).result,a=s.bbox??[0,0,0,0,0,0],o={volume:s.volume??0,area:s.area??0,centroid:s.centroid??null,bbox:a,faces:s.faces,edges:s.edges,solids:s.solids};return t===this.epoch&&(this.props.set(e,o),this.bboxes.has(e)||this.bboxes.set(e,{bbox:a,faces:s.faces})),o}async fastOf(e,t){const i=this.bboxes.get(e);if(i)return i;const r=await this.opts.kernel.call("props",{id:e,bbox:"fast",bbox_mode:"fast"}),s={bbox:r.result.bbox??[0,0,0,0,0,0],faces:r.result.faces};return t===this.epoch&&this.bboxes.set(e,s),s}async build(e){const t=performance.now(),{doc:i,view:r}=e,s=this.opts.kernel,a={};for(const M of i.features)a[M.id]={state:"pending"};const o=s.status.get();if(o.state==="failed"||o.state==="closed")return{features:a,bodies:[],ms:0,failed:[],message:`The kernel is not running${o.message?`: ${o.message}`:""}`};try{await s.start()}catch(M){return{features:a,bodies:[],ms:0,failed:[],message:`The kernel is not running: ${M instanceof Error?M.message:String(M)}`}}const l=this.epoch,c=++this.seq,f=Ih(()=>i.units,()=>i.params),d=new Map,u=new Set,h=[],_=r.rollback??i.features.length,g=M=>i.bodies[M]?.name??"a deleted body";for(let M=0;M<i.features.length;M++){const E=i.features[M];if(M>=_){a[E.id]={state:"rolled-back"};continue}const b=d.size;if(E.suppressed){a[E.id]={bodiesBefore:b,state:"suppressed"};continue}const T=this.opts.registry.get(E.type);if(!T){a[E.id]={bodiesBefore:b,state:"error",message:`${E.name}: this version of Magnusim CAD cannot build "${E.type}" features`},h.push(E.id);continue}const C=T.resolve(E,f);if(!C.ok){a[E.id]={bodiesBefore:b,state:"error",message:`${E.name}: ${C.message}`},h.push(E.id);continue}const D=E,R=D.op==="new"?[]:D.scope&&D.scope.length?D.scope:[...d.keys()],{name:N,suppressed:I,...z}=E,$=Jl({f:z,v:C.values,in:R.map(Q=>[Q,d.get(Q)?.key??null])}),X=this.stopped.get($);if(X){a[E.id]={bodiesBefore:b,state:"error",message:Go(X.message,E.name),actions:["retry"]},h.push(E.id);continue}let re=this.cache.get($);if(!re){if(this.pending)return null;const Q={kernel:s,units:f,bodies:new Map([...d].map(([Fe,Re])=>[Fe,{id:Re.id,shape:Re.shape,valid:Re.valid,feature:Re.feature}])),doc:i,bodyName:g,bbox:async Fe=>(await this.fastOf(Fe,l)).bbox,faces:async Fe=>(await this.fastOf(Fe,l)).faces,release:Fe=>this.release(Fe,l)},te=performance.now();let ue;try{ue=await T.build(E,C.values,Q)}catch(Fe){const Re=Fe;if(Wo(Re))return this.stopped.set($,{feature:E.id,message:Ho(rg(E,Re),E.name)}),null;if(l!==this.epoch||Re.kind==="restarted")return null;if(Re.kind==="boot")return{features:a,bodies:[],ms:0,failed:[],message:`The kernel is not running: ${Re.message}`};ue={ok:!1,message:`${E.name} failed: ${ig(Re instanceof Error?Re.message:String(Re))}`}}if(l!==this.epoch)return null;re={result:ue.ok?ue.warning?{...ue,warning:Ho(ue.warning,E.name)}:ue:{...ue,message:Ho(ue.message,E.name)},shapes:ue.ok?ue.bodies.map(Fe=>Fe.shape):[],ms:performance.now()-te,lastUsed:c},this.cache.set($,re)}re.lastUsed=c,u.add($);const J=re.result;if(J.ok){for(const Q of J.bodies)d.set(Q.id,{id:Q.id,shape:Q.shape,valid:Q.valid,feature:E.id,key:$m(`${$}#${Q.id}`)});for(const Q of J.removed)d.delete(Q);a[E.id]=J.warning?{bodiesBefore:b,state:"warning",message:Go(J.warning,E.name),ms:re.ms}:{bodiesBefore:b,state:"ok",ms:re.ms}}else{const Q={bodiesBefore:b,state:"error",message:Go(J.message,E.name),ms:re.ms};J.actions?.length&&(Q.actions=[...J.actions]),a[E.id]=Q,h.push(E.id)}}const p=new Set(r.hiddenBodies),m=[];for(const M of d.values()){let E=this.tess.get(M.shape);const b=this.stopped.get(`tess:${M.key}`);if(b)a[M.feature]={...a[M.feature],state:a[M.feature]?.state==="error"?"error":"warning",message:b.message,actions:["retry"]};else if(!E){try{const R=await s.call("tessellate",{id:M.shape});E=sg(R.buffers)}catch(R){const N=R;if(Wo(N))return this.stopped.set(`tess:${M.key}`,{feature:M.feature,message:`${g(M.id)} could not be displayed: ${N.message}`}),null;if(l!==this.epoch||N.kind==="restarted")return null;E=void 0}if(l!==this.epoch)return null;E&&this.tess.set(M.shape,E)}const T=E?E.faceRanges.length/2:0;let C=this.props.get(M.shape)??null;if(!C&&E&&T<=(this.opts.eagerPropsMaxFaces??eg)&&!this.stopped.has(`props:${M.key}`))try{C=await this.propsOf(M.shape,l)}catch(R){const N=R;if(Wo(N))return this.stopped.set(`props:${M.key}`,{feature:M.feature,message:N.message}),null;if(l!==this.epoch||N.kind==="restarted")return null;C=null}const D=i.bodies[M.id];m.push({id:M.id,name:D?.name??"Body",color:D?.color??cu,feature:M.feature,shape:M.shape,valid:M.valid,faces:C?.faces??T,edges:C?.edges??(E?E.edgeRanges.length/2:0),bbox:C?.bbox??(E?ag(E.positions):[0,0,0,0,0,0]),volume:C?.volume??null,area:C?.area??null,visible:!p.has(M.id),tessKey:M.key,tess:E??null})}if(l!==this.epoch)return null;const v=[...this.cache.entries()].filter(([M])=>!u.has(M)).sort((M,E)=>M[1].lastUsed-E[1].lastUsed),w=v.slice(0,Math.max(0,v.length-tg)),y=new Set(m.map(M=>M.shape)),S=[];for(const[M,E]of w){this.cache.delete(M);for(const b of E.shapes)y.has(b)||S.push(b)}return await this.release(S,l),this.latestBodies=m,{features:a,bodies:m,ms:performance.now()-t,failed:h,message:null}}}const co="magnusim-cad/model",fu="magnusim-cad/view";function qs(n){return n&&Number.parseInt(n,10)||0}function du(n){if(!n||typeof n!="object"||n.format!==co)throw new tn("the model file is not a Part model");return n}class lg{constructor(e,t,i){this.data=e,this.pointer=t,this.session=i}kind="data";async loadModel(){const e=await this.data.read(this.pointer.rel);if(e==null)return null;const t=du(e);if(t.moved_to)throw new tn(`the model moved to plugin ${t.moved_to}; reload the Part`);return{doc:uu(t.doc),etag:String(t.etag??""),savedAt:typeof t.saved_at=="string"?t.saved_at:null}}lastPosted=null;nowSeq=0;nowDone=null;ours(e){return!!e&&e.endsWith(`.${this.session}`)}async saveModel(e,t){const i=this.nowSeq,r=await this.data.read(this.pointer.rel);if(i!==this.nowSeq&&this.nowDone)return this.nowDone;const s=r==null?null:String(r.etag??"");if(s!==t&&!this.ours(s))throw new au;const a=`${qs(s)+1}.${this.session}`,o={format:co,etag:a,saved_at:new Date().toISOString(),doc:e};return this.lastPosted=a,await this.data.write(this.pointer.rel,o),a}saveModelNow(e,t){this.nowSeq++;const i=qs(this.lastPosted)>qs(t)?this.lastPosted:t,r=`${qs(i)+1}.${this.session}`,s={format:co,etag:r,saved_at:new Date().toISOString(),doc:e};this.lastPosted=r;const a=this.data.write(this.pointer.rel,s).then(()=>r);return this.nowDone=a,{etag:r,done:a}}async loadView(){return Fh(await this.data.read(this.pointer.view))}async saveView(e){const t={format:fu,view:e};await this.data.write(this.pointer.view,t)}}function Fh(n){const e=n;return e&&typeof e=="object"&&e.format===fu?e.view:null}function ks(n){if(!n||typeof n!="object")return null;const e=n.code;return typeof e=="string"?e:n.status===409?"changed":null}const uo=n=>{const e=ks(n);return e==="changed"||e==="conflict"};function cg(n){return(n instanceof Error?n.message:typeof n=="string"?n:"").replace(/^Error:\s*/,"").trim()}function ug(n){const e=cg(n);switch(ks(n)){case"too_large":return e?`the part is too large to save (${e})`:"the part is too large to save";case"quota":return e?`Magnusim CAD's files in this project are full (${e})`:"Magnusim CAD's files in this project are full";case"disk_full":return"the disk is full";case"plugin_off":return"Magnusim CAD was turned off";case"busy":return"another program has the part's file open";case"invalid_path":return"the part's file name was refused";case"study_not_found":case"study_record":return"this Part was deleted";case"project_not_found":return"the project was removed";case"too_many_uploads":return"too many files are being saved at once";case"unavailable":return"the app is busy";case"checksum":return"the part arrived damaged at the app";default:return e||"the app did not answer"}}const fg=new TextDecoder;class Bh{constructor(e,t,i){this.files=e,this.data=t,this.pointer=i}kind="files";async readJson(e){for(let t=0;;t++){const i=await this.files.stat(e);if(!i)return null;try{const r=await this.files.read(e,{ifMatch:i.etag});if(r==null)return null;let s;try{s=JSON.parse(fg.decode(r))}catch{throw new tn(`${e} is not valid JSON`)}return{json:s,etag:i.etag,bytes:r}}catch(r){if(uo(r)&&t<2)continue;throw r}}}async loadModel(){const e=await this.readJson(this.pointer.rel);if(!e)return null;const t=du(e.json);if(t.moved_to)throw new tn(`the model moved to plugin ${t.moved_to}; reload the Part`);return{doc:uu(t.doc),etag:e.etag,savedAt:typeof t.saved_at=="string"?t.saved_at:null}}async saveModel(e,t){const i={format:co,saved_at:new Date().toISOString(),doc:e};try{return(await this.files.write(this.pointer.rel,JSON.stringify(i),{ifMatch:t})).etag}catch(r){throw uo(r)?new au:new pm(ug(r),ks(r))}}async loadView(){return Fh(await this.data.read(this.pointer.view))}async saveView(e){const t={format:fu,view:e};await this.data.write(this.pointer.view,t)}}function rf(n){return n.rel.replace(/\.json$/,"")+".p1.json"}function dg(n){return n.files}function hg(n,e,t,i){if(e.store==="files"){if(!i)throw new Error("this Part is saved with plugin files, which need Magnusim with host API 1.2 or newer");return new Bh(i,n.data,e)}return new lg(n.data,e,t)}async function sf(n,e,t){try{return{record:await n.study.update({[Kl]:e},t.rev),pointer:e}}catch(i){const r=await n.study.get(),s=lh(r);if(s&&s.store===e.store)return{record:r,pointer:s};if(r.rev===t.rev)throw i;return{record:await n.study.update({[Kl]:e},r.rev),pointer:e}}}async function pg(n,e,t){for(let i=0;;i++){const r=await n.readJson(t.rel);if(!r)return null;const s=du(r.json);if(typeof s.etag!="string"||s.moved_to)return null;const a=uu(s.doc);try{await e.write(rf(t),r.bytes,{ifMatch:null})}catch(o){if(!uo(o))throw o}try{return await n.saveModel(a,r.etag),`moved to plugin files (the P1 file is kept as ${rf(t)})`}catch(o){if(i<2&&(uo(o)||ks(o)==="conflict"))continue;throw o}}}async function mg(n,e,t=()=>{}){let i=await n.study.get().catch(()=>n.context.study),r=dg(n),s=lh(i),a=null;if(r&&(!s||s.store==="data")){const o=s?{...s,store:"files"}:qu(n.studyId,"files");try{s?a=await pg(new Bh(r,n.data,o),r,o):await r.stat(o.rel);const l=await sf(n,o,i);i=l.record,s=l.pointer}catch(l){if(ks(l)==="not_allowed")t("plugin files are not usable here (not_allowed); using ws.data",l),r=null;else if(s)t("could not move the model to plugin files",l);else throw l}}if(!s){const o=await sf(n,qu(n.studyId,"data"),i);i=o.record,s=o.pointer}return{store:hg(n,s,e,r),rev:i.rev,note:a}}const gg=100;function _g(n=gg){let e=[],t=[];return{push(i){e.push(i),e.length>n&&(e=e.slice(e.length-n)),t=[]},undo(){const i=e.pop();return i?(t.push(i),i.before):null},redo(){const i=t.pop();return i?(e.push(i),i.after):null},get canUndo(){return e.length>0},get canRedo(){return t.length>0},get undoLabel(){return e.length?e[e.length-1].label:null},get redoLabel(){return t.length?t[t.length-1].label:null},clear(){e=[],t=[]}}}const Ys=80,vg=["length","angle","scalar"],yi=n=>"op"in n&&"scope"in n;function af(n,e,t){const i=new Set(t(e));if(yi(e))for(const r of e.scope){const s=n.features.find(a=>yi(a)&&a.creates===r);s&&i.add(s.id)}return i.delete(e.id),[...i]}function of(n){const e=new Set(n.features.filter(yi).map(r=>r.creates).filter(r=>!!r)),t=Object.keys(n.bodies);if(t.every(r=>e.has(r)))return n;const i={};for(const r of t)e.has(r)&&(i[r]=n.bodies[r]);return{...n,bodies:i}}function Ks(n,e){return{...n,features:n.features.map(t=>t.id===e.id?e:t)}}function Ql(n,e){const t=e.features.length,i=n.rollback==null||n.rollback>=t?null:Math.max(0,n.rollback);return i===n.rollback?n:{...n,rollback:i}}function xg(n,e,t){const i=n.rollback;if(i==null||i>=e.features.length)return Ql(n,t);const r=t.features.map(a=>a.id);let s=null;for(let a=i;a<e.features.length&&s==null;a++){const o=r.indexOf(e.features[a].id);o>=0&&(s=o)}for(let a=i-1;a>=0&&s==null;a--){const o=r.indexOf(e.features[a].id);o>=0&&(s=o+1)}return s==null&&(s=Math.min(i,r.length)),Ql(s===i?n:{...n,rollback:s},t)}function yg(n){return n.meta.written_by===lo?n:{...n,meta:{...n.meta,written_by:lo}}}function bg(n){const{bridge:e,kernel:t,bus:i}=n,r=n.log??((A,x)=>console.warn(`[cad] ${A}`,x??"")),s=Vm(),a=$i("s"),o=_g(),l=Ki({status:"loading",error:null,doc:Za(nf(e.units())),view:Dh(),rebuild:{status:"idle",seq:0,features:{},bodies:[],ms:null,message:null},save:{state:"saved",at:null},history:{canUndo:!1,canRedo:!1,undoLabel:null,redoLabel:null},session:null}),c=Ih(()=>l.get().doc.units,()=>l.get().doc.params);let f=null,d=null,u=e.context.study.rev,h=0,_=!1,g=null;const p=new og({kernel:t,registry:s,onStart(){l.set(A=>A.rebuild.status==="running"?A:{...A,rebuild:{...A.rebuild,status:"running"}})},onResult(A){let x=0;l.set(L=>{x=L.rebuild.seq+1;const F=new Set(L.view.hiddenBodies),B=A.bodies.map(q=>q.visible===!F.has(q.id)?q:{...q,visible:!F.has(q.id)});return{...L,rebuild:{status:A.message?"failed":"done",seq:x,features:A.features,bodies:B,ms:A.ms,message:A.message}}}),i.emit("doc:rebuilt",{seq:x,ms:A.ms,failed:A.failed})},onRespawn(A){i.emit("kernel:respawned",{reason:A,count:t.status.get().respawns})}});function m(){const A=l.get();A.status==="ready"&&p.request({doc:A.doc,view:A.view})}function v(){return{canUndo:o.canUndo,canRedo:o.canRedo,undoLabel:o.undoLabel,redoLabel:o.redoLabel}}function w(A,x,L){const F=L??l.get().doc;if(A===l.get().doc&&!x)return;const B=Za(yg(A));x&&B!==F&&o.push({label:x,before:F,after:B}),l.set(q=>({...q,doc:B,view:Ql(q.view,B),history:v()})),d?.modelChanged(),m()}function y(A,x={}){const L=l.get();A!==L.view&&(l.set(F=>{let B=F.rebuild;const q=new Set(A.hiddenBodies);return B.bodies.some(oe=>oe.visible===q.has(oe.id))&&(B={...B,bodies:B.bodies.map(oe=>oe.visible===!q.has(oe.id)?oe:{...oe,visible:!q.has(oe.id)})}),{...F,view:A,rebuild:B}}),d?.viewChanged(),x.rebuild&&m())}function S(){const A=l.get();return A.status==="loading"?"The part is still loading":A.status==="error"?A.error??"The part could not be read":A.save.state==="conflict"?"Changed in another tab · Reload to keep editing":!0}function M(){const A=S();return A===!0?null:{ok:!1,reason:A}}function E(A){return l.get().doc.features.find(x=>x.id===A)}function b(){g&&g.commit()}class T{constructor(x,L,F){this.isNew=L,this.insertAt=F,this.feature=x.id,this.current=x,this.before=l.get().doc,this.viewBefore=l.get().view,this.inDoc=!L,this.lastCreates=yi(x)?x.creates:null,L&&this.apply()}id=$i("s");feature;open=!0;current;before;viewBefore;inDoc;lastCreates;get draft(){return this.current}def(){return s.get(this.current.type)}incomplete(){const x=this.def();return x?x.incomplete(this.current,c):`This version of Magnusim CAD cannot edit "${this.current.type}" features`}apply(){if(this.incomplete()!==null)return;let x=l.get().doc,L=this.current;if(yi(L)&&L.op==="new"){let F=L.creates??this.lastCreates;if(F||(F=$i("b")),this.lastCreates=F,!x.bodies[F]){const B=su("Body",Object.values(x.bodies).map(q=>q.name));x={...x,bodies:{...x.bodies,[F]:{name:B,color:cu}}}}L.creates!==F&&(L={...L,creates:F}),this.current=L}if(this.inDoc)x=Ks(x,L);else{const F=[...x.features];F.splice(this.insertAt,0,L),x={...x,features:F},this.inDoc=!0;const B=l.get().view;B.rollback!=null&&B.rollback>=this.insertAt&&y({...B,rollback:B.rollback+1})}w(x,null),l.set(F=>F.session&&F.session.id===this.id?F:{...F,session:{id:this.id,feature:this.feature,isNew:this.isNew}})}update(x){if(!this.open||S()!==!0)return;const{id:L,type:F,...B}=x;let q={...this.current,...B};yi(q)&&"op"in B&&(q.op!=="new"&&q.creates?(this.lastCreates=q.creates,q={...q,creates:null}):q.op==="new"&&!q.creates&&(q={...q,creates:this.lastCreates}),q.op==="new"&&q.scope.length&&(q={...q,scope:[]})),this.current=q,this.apply()}commit(){if(!this.open)return;if(this.isNew&&(!this.inDoc||this.incomplete()!==null)){this.discard();return}this.open=!1,g=null;const x=of(l.get().doc),L=E(this.feature),F=this.isNew?L?.name??"New feature":`Edit ${L?.name??"feature"}`;x!==this.before&&(JSON.stringify(x)===JSON.stringify(this.before)?w(this.before,null):w(x,F,this.before)),l.set(B=>({...B,session:null,history:v()}))}discard(){this.open&&(this.open=!1,g=null,l.get().doc!==this.before&&w(this.before,null),this.isNew&&l.get().view.rollback!==this.viewBefore.rollback&&y({...l.get().view,rollback:this.viewBefore.rollback},{rebuild:!0}),l.set(x=>({...x,session:null})))}}function C(A,x){const L=S();if(L!==!0)throw new Error(L);const F=s.get(A);if(!F)throw new Error(`Unknown feature type "${A}"`);b();const B=l.get().doc,q=F.create(B,x),oe=l.get().view.rollback??B.features.length,j=new T(q,!0,oe);return g=j,l.set(W=>({...W,session:{id:j.id,feature:j.feature,isNew:!0}})),j}function D(A){const x=S();if(x!==!0)throw new Error(x);if(g&&g.feature===A)return g;b();const L=E(A);if(!L)throw new Error("That feature is not in the part");const F=l.get().doc.features.indexOf(L);return g=new T(L,!1,F),l.set(B=>({...B,session:{id:g.id,feature:A,isNew:!1}})),g}function R(A){const x=M();if(x)return x;b();const L=A(l.get().doc);return"ok"in L?L:(L.doc!==l.get().doc&&w(L.doc,L.label),{ok:!0})}function N(A,x){return R(L=>{const F=L.features.find(oe=>oe.id===A);if(!F)return{ok:!1,reason:"That feature is not in the part"};const B=String(x??"").trim();if(!B)return{ok:!1,reason:"Enter a name"};if(B.length>Ys)return{ok:!1,reason:`A name can have at most ${Ys} characters`};if(B===F.name)return{doc:L,label:""};const q=L.features.find(oe=>oe.id!==A&&oe.name.toLowerCase()===B.toLowerCase());return q?{ok:!1,reason:`Another feature is already called ${q.name}`}:{doc:Ks(L,{...F,name:B}),label:`Rename ${F.name}`}})}function I(A,x){return R(L=>{const F=L.features.find(q=>q.id===A);if(!F)return{ok:!1,reason:"That feature is not in the part"};if(!!F.suppressed===x)return{doc:L,label:""};const B={...F};return x?B.suppressed=!0:delete B.suppressed,{doc:Ks(L,B),label:`${x?"Suppress":"Unsuppress"} ${F.name}`}})}function z(A,x){return A.features.filter(L=>L.id!==x.id&&af(A,L,F=>s.get(F.type)?.parents(F)??[]).includes(x.id))}function $(A){const x=M();return x||(g&&g.feature===A&&g.discard(),R(L=>{const F=L.features.findIndex(fe=>fe.id===A);if(F<0)return{ok:!1,reason:"That feature is not in the part"};const B=L.features[F],q=z(L,B);if(q.length){const fe=q[0],de=yi(B)&&B.creates&&yi(fe)&&fe.scope.includes(B.creates)?`${L.bodies[B.creates]?.name??"the body"} of ${B.name}`:B.name;return{ok:!1,reason:`${fe.name} uses ${de}: delete ${fe.name} or change what it uses first`}}const oe=L.features.filter(fe=>fe.id!==A),j=of({...L,features:oe}),W=l.get().view,ce=Object.keys(L.bodies).filter(fe=>!j.bodies[fe]);return(W.rollback!=null&&F<W.rollback||ce.some(fe=>W.hiddenBodies.includes(fe)))&&y({...W,rollback:W.rollback!=null&&F<W.rollback?W.rollback-1:W.rollback,hiddenBodies:W.hiddenBodies.filter(fe=>!ce.includes(fe))}),{doc:j,label:`Delete ${B.name}`}}))}function X(A,x){return R(L=>{const F=L.features.findIndex(ce=>ce.id===A);if(F<0)return{ok:!1,reason:"That feature is not in the part"};const B=L.features[F],q=Math.max(0,Math.min(L.features.length-1,Math.floor(x)));if(q===F)return{doc:L,label:""};const j=af(L,B,ce=>s.get(ce.type)?.parents(ce)??[]);for(const ce of j){const fe=L.features.findIndex(me=>me.id===ce);if(fe>=q&&fe!==F)return{ok:!1,reason:`${B.name} uses ${L.features[fe].name}: it cannot move above it`}}for(const ce of z(L,B))if(L.features.indexOf(ce)<=q)return{ok:!1,reason:`${ce.name} uses ${B.name}: ${B.name} cannot move below it`};const W=[...L.features];return W.splice(F,1),W.splice(q,0,B),{doc:{...L,features:W},label:`Move ${B.name}`}})}function re(A,x){return R(L=>{const F=L.bodies[A];if(!F)return{ok:!1,reason:"That body is not in the part"};const B=String(x??"").trim();if(!B)return{ok:!1,reason:"Enter a name"};if(B.length>Ys)return{ok:!1,reason:`A name can have at most ${Ys} characters`};if(B===F.name)return{doc:L,label:""};const q=Object.entries(L.bodies).find(([oe,j])=>oe!==A&&j.name.toLowerCase()===B.toLowerCase());return q?{ok:!1,reason:`Another body is already called ${q[1].name}`}:{doc:{...L,bodies:{...L.bodies,[A]:{...F,name:B}}},label:`Rename ${F.name}`}})}function J(A,x){return R(L=>{const F=L.bodies[A];if(!F)return{ok:!1,reason:"That body is not in the part"};const B=String(x??"").trim().toLowerCase();return Lh.test(B)?B===F.color.toLowerCase()?{doc:L,label:""}:{doc:{...L,bodies:{...L.bodies,[A]:{...F,color:B}}},label:`Colour of ${F.name}`}:{ok:!1,reason:"A colour is written #rrggbb"}})}function Q(A,x,L){const F=Rh(x.name,A,x.id);if(F)return F;if(!vg.includes(x.quantity))return"Pick length, angle or number";const q=Ch(A,L).valueOf(x.name);return!q||!q.ok?q?q.error:"Not evaluated":null}function te(A){const x=M();if(x)return x;b();const L=l.get().doc,F={id:$i("p"),name:String(A.name??"").trim(),expr:String(A.expr??"").trim(),quantity:A.quantity??"length"};A.comment&&(F.comment=String(A.comment)),A.favorite&&(F.favorite=!0);const B=[...L.params,F],q=Q(B,F,L.units);return q?{ok:!1,reason:q}:(w({...L,params:B},`Add parameter ${F.name}`),F.id)}function ue(A,x){return R(L=>{const F=L.params.find(W=>W.id===A);if(!F)return{ok:!1,reason:"That parameter is not in the part"};const B={...F,...x,id:A};B.name=String(B.name??"").trim(),B.expr=String(B.expr??"").trim(),B.comment||delete B.comment,B.favorite||delete B.favorite;let q=L.params.map(W=>W.id===A?B:W),oe=L.features;B.name!==F.name&&(q=q.map(W=>W.id===A?W:{...W,expr:Ka(W.expr,F.name,B.name)}),oe=oe.map(W=>Ph(W).some(fe=>Ka(fe.expr,F.name,B.name)!==fe.expr)?Mg(W,F.name,B.name):W),B.expr=Ka(B.expr,F.name,B.name));const j=Q(q,q.find(W=>W.id===A),L.units);return j?{ok:!1,reason:j}:{doc:{...L,params:q,features:oe},label:`Edit parameter ${B.name}`}})}function be(A){return R(x=>{const L=x.params.find(q=>q.id===A);if(!L)return{ok:!1,reason:"That parameter is not in the part"};const F=Wm(x,L.name),B=[...F.params.map(q=>q.name),...F.features.map(q=>q.name)];return B.length?{ok:!1,reason:`${L.name} can't be deleted: ${Sg(B)} ${B.length===1?"uses":"use"} it`}:{doc:{...x,params:x.params.filter(q=>q.id!==A)},label:`Delete parameter ${L.name}`}})}function Fe(A){if(S()!==!0)return;b();const x=l.get().doc,L=A?o.redo():o.undo();if(!L)return;const F=L,B=xg(l.get().view,x,F),q=B!==l.get().view;l.set(oe=>({...oe,doc:F,view:B,history:v()})),q&&d?.viewChanged(),d?.modelChanged(),m()}function Re(A){return R(x=>{const L=x.features.find(q=>q.id===A);if(!L)return{ok:!1,reason:"That feature is not in the part"};if(!l.get().rebuild.features[A]?.actions?.includes("repair")||!yi(L))return{ok:!1,reason:`${L.name} has nothing to repair`};const B=xh.find(q=>q>(L.repair?.fuzzy??0));return B?{doc:Ks(x,{...L,repair:{fuzzy:B}}),label:`${oo.repair} ${L.name}`}:{ok:!1,reason:`${L.name} cannot be repaired further`}})}function je(A){const x=E(A);return x?p.retry(A)?{ok:!0}:{ok:!1,reason:`${x.name} was not stopped`}:{ok:!1,reason:"That feature is not in the part"}}function ne(A){if(l.get().status!=="ready")return;b();const x=l.get(),L=x.doc.features.length;let F=A==null?null:Math.max(0,Math.min(L,Math.floor(A)));F===L&&(F=null),F!==x.view.rollback&&y({...x.view,rollback:F},{rebuild:!0})}function ae(A,x){const L=l.get().view;L.hiddenBodies.includes(A)!==!x&&y({...L,hiddenBodies:x?L.hiddenBodies.filter(B=>B!==A):[...L.hiddenBodies,A]})}function Me(A,x){const L=l.get().view;L.expanded.includes(A)!==x&&y({...L,expanded:x?[...L.expanded,A]:L.expanded.filter(B=>B!==A)})}function Be(A){const x=l.get().view;if(l.get().status!=="ready"||(x.planes??"auto")===A)return;const L={...x};A==="always"?L.planes="always":delete L.planes,y(L)}function ve(A){const x=l.get().view,L=Nh(A);l.get().status!=="ready"||!L||JSON.stringify(x.camera??null)===JSON.stringify(L)||y({...x,camera:L})}async function ke(A){const x=await p.measure(A);return l.set(L=>{const F=L.rebuild.bodies.findIndex(j=>j.id===A);if(F<0)return L;const B=L.rebuild.bodies[F];if(B.volume===x.volume&&B.area===x.area)return L;const q={...B,volume:x.volume,area:x.area,bbox:x.bbox,faces:x.faces,edges:x.edges},oe=[...L.rebuild.bodies];return oe[F]=q,{...L,rebuild:{...L.rebuild,bodies:oe}}}),x}async function Pt(){const A=++h;g&&(g.open=!1,g=null),d?.dispose(),d=null,l.set({status:"loading",error:null,session:null});try{for(let x=0;;x++){const L=await mg(e,a,r);if(A!==h||_)return;u=Math.max(u,L.rev),f=L.store,L.note&&r(`the model ${L.note}`);const F=await f.loadModel(),B=Za(F?F.doc:nf(e.units())),q=Jm(await f.loadView().catch(()=>null),B.features.length);if(A!==h||_)return;o.clear();const oe=new xm({store:f,etag:F?F.etag:null,savedAt:F?F.savedAt??null:null,getDoc:()=>l.get().doc,getView:()=>l.get().view,onState:W=>{d===oe&&l.set({save:W})},intervalMs:n.saveIntervalMs,burst:n.saveBurst,viewIntervalMs:n.saveViewIntervalMs,log:r});d=oe;const j={};for(const W of B.features)j[W.id]={state:"pending"};if(l.set({status:"ready",error:null,doc:B,view:q,save:{state:"saved",at:F?F.savedAt??null:null},history:v(),session:null,rebuild:{status:"idle",seq:l.get().rebuild.seq,features:j,bodies:[],ms:null,message:null}}),!(!F&&(oe.modelChanged(),await oe.flush(),oe.conflicted&&x===0))){m();return}}}catch(x){if(A!==h)return;const L=x instanceof Error?x.message:String(x);r("the part could not be read",x),l.set({status:"error",error:`Could not read the part: ${L}`})}}const $e=e.onStudy(A=>{typeof A.rev=="number"&&(u=A.rev)}),Ke=()=>d?.flushNow(),rt=()=>d?.leaveNow(),qe=A=>{const x=A.key,L=A.ctrlKey||A.metaKey;(x==="F5"||x==="BrowserRefresh"||x==="BrowserBack"||x==="BrowserForward"||L&&/^[rw]$/i.test(x)||L&&x==="F4"||A.altKey&&(x==="ArrowLeft"||x==="ArrowRight"||x==="Home"))&&rt()},ot=A=>{(A.button===3||A.button===4)&&rt()},Dt=()=>{typeof document<"u"&&document.visibilityState==="hidden"&&rt()};typeof window<"u"&&(window.addEventListener("pagehide",rt),window.addEventListener("blur",Ke),window.addEventListener("pointerdown",ot,!0),window.addEventListener("mousedown",ot,!0),window.addEventListener("mouseup",ot,!0)),typeof document<"u"&&(document.addEventListener("visibilitychange",Dt),document.documentElement.addEventListener("mouseleave",Ke),document.addEventListener("keydown",qe,!0));let Tt="";const vt=A=>{if(A.status!=="ready")return null;const x=String(e.context.study?.title??"").trim()||"this Part",L=A.save;return L.state==="pending"||L.state==="saving"?`Changes to ${x} are not saved yet.`:L.state==="error"?`Changes to ${x} are not saved: ${L.message}.`:L.state==="conflict"?`Changes to ${x} are not saved: it was changed in another tab.`:null},At=()=>{const A=_?null:vt(l.get()),x=A??"";x!==Tt&&(Tt=x,e.setDirty(A!==null,A??void 0))},V=l.subscribe((A,x)=>{(A.save!==x.save||A.status!==x.status)&&At()}),Nt=e.onStudy(()=>At()),nt={state:l,units:c,features:s,load:Pt,editable:S,beginNew:C,beginEdit:D,session:()=>g,rename:N,setSuppressed:I,remove:$,move:X,renameBody:re,setBodyColor:J,addParam:te,updateParam:ue,removeParam:be,undo:()=>Fe(!1),redo:()=>Fe(!0),repair:Re,retry:je,setRollback:ne,setBodyVisible:ae,setExpanded:Me,setPlanes:Be,setCamera:ve,measure:ke,async flush(){await d?.flush()},retrySave(){d?.retryNow()},async reload(){await Pt()},dispose(){if(_)return;_=!0,$e(),V(),Nt(),typeof window<"u"&&(window.removeEventListener("pagehide",rt),window.removeEventListener("blur",Ke),window.removeEventListener("pointerdown",ot,!0),window.removeEventListener("mousedown",ot,!0),window.removeEventListener("mouseup",ot,!0)),typeof document<"u"&&(document.removeEventListener("visibilitychange",Dt),document.documentElement.removeEventListener("mouseleave",Ke),document.removeEventListener("keydown",qe,!0));const A=d;A?.flush().finally(()=>A.dispose()),p.dispose()}};return Object.defineProperty(nt,"studyRev",{get:()=>u,enumerable:!1}),nt}function Sg(n){return n.length<=1?n.join(""):n.length<=3?`${n.slice(0,-1).join(", ")} and ${n[n.length-1]}`:`${n.slice(0,3).join(", ")} and ${n.length-3} more`}function Mg(n,e,t){const i=new Set(["id","type","name","op","creates","scope","axis","suppressed","repair"]),r=a=>typeof a=="string"?Ka(a,e,t):Array.isArray(a)?a.map(r):a&&typeof a=="object"?Object.fromEntries(Object.entries(a).map(([o,l])=>[o,r(l)])):a,s={};for(const[a,o]of Object.entries(n))s[a]=i.has(a)?o:r(o);return s}function wg(n){const{commands:e,keyboard:t}=n,i=[e.register({id:"edit.undo",label:"Undo",shortcut:"Ctrl+Z",enabled:r=>{const s=r.doc.editable();return s!==!0?s:r.doc.state.get().history.canUndo||r.doc.state.get().session?!0:"Nothing to undo"},hint:"Undo the last change to the part",run:r=>r.doc.undo()}),e.register({id:"edit.redo",label:"Redo",shortcut:"Ctrl+Y",enabled:r=>{const s=r.doc.editable();return s!==!0?s:r.doc.state.get().history.canRedo?!0:"Nothing to redo"},hint:"Redo the change you undid",run:r=>r.doc.redo()}),t.bind({combo:"Ctrl+Shift+Z",run:()=>{e.run("edit.redo")}})];return()=>{for(const r of i)r()}}const Eg=12e8;function Qn(n,e,t,i={}){return Object.assign(new Error(n),{kind:e,op:t,...i})}class Tg{constructor(e){this.opts=e}gen=0;nextId=0;queue=[];inflight=null;worker=null;ready=!1;boot=null;bootTimer=null;failed=null;disposed=!1;respawns=0;readyInfo=null;startP=null;emit(e){try{this.opts.onEvent?.(e)}catch(t){console.error("[cad] kernel event handler failed",t)}}start(){return this.startP&&!this.failed?this.startP:(this.startP=this.spawn(),this.startP)}spawn(){const e=++this.gen;this.ready=!1,this.failed=null,this.readyInfo=null;const t=performance.now();this.emit({type:"starting",gen:e});const i=new Promise((s,a)=>{this.boot={resolve:s,reject:a,gen:e}});i.catch(()=>{}),this.bootTimer=setTimeout(()=>{e===this.gen&&!this.ready&&this.failBoot(e,`The kernel did not start within ${Math.round(this.opts.bootTimeoutMs/1e3)} s`)},this.opts.bootTimeoutMs);let r;try{r=this.opts.spawn(this.opts.url)}catch(s){return this.failBoot(e,`The kernel could not be started: ${s instanceof Error?s.message:String(s)}`),i}return this.worker=r,r.onmessage=s=>this.onMessage(e,s.data,t),r.onerror=s=>{s.preventDefault?.(),this.onCrash(e,s.message||"worker error")},r.onmessageerror=()=>this.onCrash(e,"a message could not be read"),i}failBoot(e,t){if(e===this.gen){this.bootTimer&&clearTimeout(this.bootTimer),this.failed=t;try{this.worker?.terminate()}catch{}this.boot&&this.boot.gen===e&&this.boot.reject(Object.assign(new Error(t),{kind:"boot"}));for(const i of this.queue.splice(0))i.reject(Qn(t,"boot",i.op));this.emit({type:"failed",message:t})}}onMessage(e,t,i){if(!(e!==this.gen||!t||typeof t!="object")){if(t.type==="ready"){this.bootTimer&&clearTimeout(this.bootTimer),this.ready=!0;const r=t;this.readyInfo={occt:r.occt,variant:r.variant,init_ms:r.init_ms,heap_bytes:r.heap_bytes,ready_ms:performance.now()-i},this.boot&&this.boot.gen===e&&this.boot.resolve(this.readyInfo),this.emit({type:"ready",info:this.readyInfo}),this.pump();return}if(t.type==="fatal"){this.failBoot(e,`The kernel failed to start: ${t.error}`);return}if(t.type==="result"){const r=this.inflight;if(!r||r.id!==t.id)return;r.timer&&clearTimeout(r.timer),this.inflight=null,this.emit({type:"busy",op:null});const s=performance.now()-(r.sentAt??performance.now());if(t.ok)r.resolve({result:t.result,buffers:t.buffers??{},ms:t.ms,wall_ms:s,heap_bytes:t.heap_bytes}),this.pump();else{const a=!!(t.error.oom||t.error.low_memory);r.reject(Qn(t.error.message,t.error.kind,r.op,{oom:a})),t.error.kind==="trap"?this.respawn(`the kernel stopped in ${r.op}: ${t.error.message}`):a?this.respawn(`the kernel ran out of memory in ${r.op}`):this.pump()}}}}onCrash(e,t){if(e!==this.gen)return;if(!this.ready){this.failBoot(e,`The kernel failed to start: ${t}`);return}const i=this.inflight;this.inflight=null,i&&(i.timer&&clearTimeout(i.timer),i.reject(Qn(`The kernel crashed during ${i.op}: ${t}`,"crash",i.op))),this.respawn(`crash: ${t}`)}call(e,t,i={}){return new Promise((r,s)=>{if(this.disposed){s(Qn("The kernel is closed","restarted",e));return}if(this.failed){s(Qn(`The kernel is not running: ${this.failed}`,"boot",e));return}this.queue.push({id:++this.nextId,op:e,params:t,bytes:i.bytes??null,timeoutMs:i.timeoutMs??this.opts.timeoutFor(e),resolve:r,reject:s}),this.pump()})}pump(){if(!this.ready||this.inflight||!this.queue.length||!this.worker)return;const e=this.queue.shift();this.inflight=e,e.sentAt=performance.now();const t={type:"call",id:e.id,op:e.op,params:e.params},i=[];e.bytes&&(t.bytes=e.bytes,i.push(e.bytes));try{this.worker.postMessage(t,i)}catch(r){this.inflight=null,e.reject(Qn(`Could not send ${e.op}: ${r instanceof Error?r.message:String(r)}`,"internal",e.op)),this.pump();return}this.emit({type:"busy",op:e.op}),e.timer=setTimeout(()=>this.expire(e),e.timeoutMs)}expire(e){if(this.inflight!==e)return;const t=(performance.now()-(e.sentAt??performance.now()))/1e3;this.inflight=null;const i=`${e.op} was stopped after ${t.toFixed(1)} s`;e.reject(Qn(i,"watchdog",e.op,{seconds:t})),this.respawn(i)}respawn(e){try{this.worker?.terminate()}catch{}this.respawns+=1;for(const t of this.queue.splice(0))t.reject(Qn(`The kernel restarted (${e}); ${t.op} was dropped`,"restarted",t.op));return this.emit({type:"busy",op:null}),this.emit({type:"respawn",reason:e,count:this.respawns}),this.startP=this.spawn(),this.startP}dispose(){this.disposed=!0,this.gen++,this.bootTimer&&clearTimeout(this.bootTimer),this.inflight&&(this.inflight.timer&&clearTimeout(this.inflight.timer),this.inflight.reject(Qn("The kernel is closed","restarted",this.inflight.op)),this.inflight=null);for(const e of this.queue.splice(0))e.reject(Qn("The kernel is closed","restarted",e.op));try{this.worker?.terminate()}catch{}}}const Ag="kernel/kernel-worker.js",Rg=new Set(["box","cylinder","sphere","extrude","revolve","boolean","split","fillet","chamfer","defeature","shell","repair"]);function Cg(n){const e=Ki({state:"idle",info:null,message:null,respawns:0,busy:null,heap_bytes:null,memory_high:!1}),t=new Set;let i=null;const r=n.workerUrl??new URL(Ag,document.baseURI).href,s=n.timeouts??{},a=n.recycleBytes??Eg;let o=!1,l=0;const c=new Tg({name:"kernel",spawn:n.spawn,url:r,timeoutFor:d=>s[d]??gh(d),bootTimeoutMs:n.bootTimeoutMs??Cm,onEvent(d){switch(d.type){case"starting":e.set({state:e.get().respawns>0?"restarting":"starting",busy:null});break;case"ready":if(e.set({state:"ready",info:d.info,heap_bytes:d.info.heap_bytes,message:i?e.get().message:null}),i){const u=i;i=null;for(const h of[...t])try{h(u)}catch(_){console.error("[cad] respawn listener failed",_)}}break;case"failed":e.set({state:"failed",message:d.message,busy:null});break;case"respawn":i=d.reason,e.set({state:"restarting",message:d.reason,respawns:d.count});break;case"busy":e.set({busy:d.op});break}}});async function f(d,u,h={}){l++;try{const _=await c.call(d,u,h);e.set({heap_bytes:_.heap_bytes});const g=_.result;if(Rg.has(d)&&typeof g.valid!="boolean"&&typeof g.id=="number"){const p=await c.call("check",{id:g.id});g.valid=!!p.result.valid}return{result:g,buffers:_.buffers,ms:_.ms,wall_ms:_.wall_ms,heap_bytes:_.heap_bytes}}finally{l--}}return{status:e,start:()=>c.start(),call:f,onRespawn(d){return t.add(d),()=>{t.delete(d)}},restart:d=>c.respawn(d),async recycleIfLarge(){const d=e.get();if(d.state!=="ready"||l>0)return!1;const u=d.heap_bytes??0;if(u<=a)return d.memory_high&&e.set({memory_high:!1}),o=!1,!1;if(o)return d.memory_high||e.set({memory_high:!0}),!1;o=!0;const h=(u/1e9).toFixed(1);return await c.respawn(`memory recycle at ${h} GB`).catch(()=>{}),!0},dispose(){c.dispose(),e.set({state:"closed",busy:null})}}}const Et={part:"M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8",origin:"M12 4v16 M4 12h16 M12 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0",plane:"M3 9l9-4 9 4-9 4z M3 9v6l9 4 9-4V9",point:"M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M12 3v5 M12 16v5 M3 12h5 M16 12h5",box:"M3 9l5-4h13v10l-5 4H3z M3 9h13v10 M16 9l5-4",cylinder:"M6 6a6 2.5 0 1 0 12 0a6 2.5 0 1 0 -12 0 M6 6v12a6 2.5 0 0 0 12 0V6",params:"M4 19c2 0 3-1 3.5-4l1.5-8C9.5 4 10.5 3 12.5 3 M5 9h7 M13 12l6 7 M19 12l-6 7",undo:"M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11",redo:"M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13",folder:"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",eye:"M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",eyeOff:"M3 3l18 18 M10.6 6.1A10.8 10.8 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.9 M6.6 7.6C3.8 9.3 2 12 2 12s3.5 6 10 6a9.6 9.6 0 0 0 4.4-1.1 M9.9 10a3 3 0 0 0 4.1 4.1",pencil:"M4 16.8V20h3.2L18.4 8.8l-3.2-3.2L4 16.8z M13.8 6.9l3.2 3.2",trash:"M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13",fit:"M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5 M9 9h6v6H9z",viewFront:"M4 9h11v11H4z M4 9l4-5h12l-5 5 M15 20l5-5V4 M7 12.5h5 M7 16.5h5",viewTop:"M4 9h11v11H4z M4 9l4-5h12l-5 5 M15 20l5-5V4 M8.5 6.5h7",viewRight:"M4 9h11v11H4z M4 9l4-5h12l-5 5 M15 20l5-5V4 M17.5 8.5v6",viewIso:"M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5",warning:"M12 3.5L2.5 20h19z M12 10v4.5 M12 17.5v.01",error:"M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M12 7.5v5.5 M12 16.5v.01"};function zs({d:n,size:e=14,stroke:t=1.8,title:i,className:r}){return Ae("svg",{className:r?`cad-icon ${r}`:"cad-icon",viewBox:"0 0 24 24",width:e,height:e,"aria-hidden":i?void 0:!0,focusable:"false",children:[i?k("title",{children:i}):null,k("path",{d:n,fill:"none",stroke:"currentColor",strokeWidth:t,strokeLinecap:"round",strokeLinejoin:"round"})]})}const fo=Ki({tip:null});let Ja=null;const Pg={hoverDelayMs:450};function Oh(){Ja&&clearTimeout(Ja),Ja=null}function lr(n){Oh();const e=fo.get().tip;!e||n&&e.owner!==n||fo.set({tip:null})}function lf(n,e,t){const i=n.getBoundingClientRect();fo.set({tip:{...e,rect:{left:i.left,top:i.top,width:i.width,height:i.height},owner:t}})}function Lg(n){try{return n.matches(":focus-visible")}catch{return!1}}function _r(n){const e=_n({}).current,t=_n(n);t.current=n;const i=n!=null;return Cn(()=>{i||lr(e)},[i,e]),Cn(()=>()=>lr(e),[e]),{onMouseEnter(r){const s=t.current;if(!s)return;const a=r.currentTarget;Oh(),Ja=setTimeout(()=>a.isConnected&&lf(a,s,e),Pg.hoverDelayMs)},onMouseLeave(){lr(e)},onMouseDown(){lr(e)},onFocus(r){const s=t.current;s&&r.target===r.currentTarget&&Lg(r.currentTarget)&&lf(r.currentTarget,s,e)},onBlur(){lr(e)}}}function Dg(){const n=it(fo,r=>r.tip),e=_n(null),[t,i]=Lt(null);return ah(()=>{const r=e.current;if(!n||!r){i(null);return}const s=r.offsetWidth,a=r.offsetHeight,o=window.innerWidth||document.documentElement.clientWidth,l=window.innerHeight||document.documentElement.clientHeight,{left:c,top:f,width:d,height:u}=n.rect;if(n.side){let g=c+d+6;g+s>o-6&&(g=Math.max(6,c-s-6));const p=Math.max(6,Math.min(f+u/2-a/2,l-a-6));i({left:Math.round(g),top:Math.round(p)});return}let h=c+d/2-s/2;h=Math.max(6,Math.min(h,o-s-6));let _=f+u+6;_+a>l-6&&(_=Math.max(6,f-a-6)),i({left:Math.round(h),top:Math.round(_)})},[n]),n?Ae("div",{ref:e,className:"cad-tip",role:"tooltip",id:"cad-tip","data-cad-tip":"1",style:t?{left:t.left,top:t.top}:{left:-9999,top:-9999},children:[k("span",{className:"cad-tip-text",children:n.text}),n.shortcut?k("kbd",{className:"cad-tip-key",children:n.shortcut}):null,n.detail?k("span",{className:"cad-tip-detail",children:n.detail}):null]}):null}const Ng={secondary:"fp-btn",primary:"fp-btn is-primary",done:"js-btn tree-panel-done",link:"mat-clear-link",danger:"mat-clear-link is-danger"};function kh(n,e){const t=typeof n=="string"?{text:n}:n??null;return e?t?{...t,detail:e}:{text:e}:t}function jl({variant:n="secondary",disabledReason:e,tip:t,className:i,onClick:r,children:s,...a}){const o=!!e,l=_r(kh(t,e)),c=[Ng[n],o?"is-disabled":"",i||""].filter(Boolean).join(" ");return k("button",{type:"button",...a,...l,className:c,"aria-disabled":o||void 0,"data-disabled-reason":e||void 0,onClick:f=>{if(o){f.preventDefault();return}r?.(f)},children:s})}function Ns({icon:n,label:e,size:t="panel",disabledReason:i,pressed:r,hint:s,className:a,onClick:o,...l}){const c=!!i,f=_r(kh(s?{text:e,detail:s}:e,i)),d=["mesh-rename",t==="row"?"is-row":"",c?"is-disabled":"",a||""].filter(Boolean).join(" ");return k("button",{type:"button",...l,...f,className:d,"aria-label":e,"aria-pressed":r,"aria-disabled":c||void 0,onClick:u=>{u.stopPropagation(),!c&&o?.(u)},onDoubleClick:u=>u.stopPropagation(),children:k(zs,{d:n,size:t==="row"?13:15})})}function Dn({chip:n,k:e,kind:t="info",children:i,actions:r,state:s,busy:a=!1}){const o=["cad-chip",t==="error"?"is-error":"",t==="warning"?"is-warning":""].filter(Boolean).join(" ");return Ae("div",{className:o,"data-chip":n,"data-state":s,role:t==="error"?"alert":"status","aria-busy":a||void 0,children:[a?k("span",{className:"tree-spin cad-chip-spin","aria-hidden":"true"}):null,e?k("span",{className:"cad-chip-k",children:e}):null,k("span",{className:"cad-chip-v",children:i}),r?.map(l=>k("button",{type:"button",className:"cad-chip-link",onClick:l.run,"data-chip-action":l.label,children:l.label},l.label))]})}function Ig(n){return n.sep===!0}function Ug({item:n,onRun:e}){const t=_r(n.disabled?{text:n.label,detail:n.disabled,side:!0}:null);return k("button",{type:"button",role:"menuitem",className:n.danger?"is-danger":void 0,"aria-disabled":n.disabled?!0:void 0,"data-menu-item":n.id,...t,onClick:()=>{n.disabled||e(n)},children:n.label})}function Fg({x:n,y:e,items:t,onClose:i,label:r="Actions"}){const s=_n(null),[a,o]=Lt({left:n,top:e});ah(()=>{const c=s.current;if(!c)return;const f=window.innerWidth||document.documentElement.clientWidth,d=window.innerHeight||document.documentElement.clientHeight,u=c.offsetWidth,h=c.offsetHeight;o({left:Math.max(4,Math.min(n,f-u-4)),top:Math.max(4,Math.min(e,d-h-4))}),c.querySelector('button[role="menuitem"]:not([aria-disabled])')?.focus({preventScroll:!0})},[n,e,t]),Cn(()=>{const c=d=>{s.current&&!s.current.contains(d.target)&&i()},f=()=>i();return document.addEventListener("pointerdown",c,!0),window.addEventListener("blur",f),window.addEventListener("resize",f),()=>{document.removeEventListener("pointerdown",c,!0),window.removeEventListener("blur",f),window.removeEventListener("resize",f)}},[i]);const l=c=>{i(),c.run()};return k("div",{ref:s,className:"face-ctx-menu cad-ctx-menu",role:"menu","aria-label":r,"data-cad-menu":"1",style:{left:a.left,top:a.top},onContextMenu:c=>c.preventDefault(),onKeyDown:c=>{const f=[...s.current?.querySelectorAll('button[role="menuitem"]')??[]],d=f.indexOf(document.activeElement);if(c.key==="Escape")c.preventDefault(),c.stopPropagation(),i();else if(c.key==="ArrowDown"||c.key==="ArrowUp"){if(c.preventDefault(),!f.length)return;const u=c.key==="ArrowDown"?1:-1;f[(d+u+f.length)%f.length].focus()}else c.key==="Tab"&&(c.preventDefault(),i())},children:t.map((c,f)=>Ig(c)?k("div",{className:"face-ctx-sep",role:"separator"},`${f}:${c.id}`):k(Ug,{item:c,onRun:l},`${f}:${c.id}`))})}const Bg=.001,hu={mm:1,cm:10,m:1e3,in:25.4,ft:304.8},Og={deg:1,rad:180/Math.PI};function pu(n,e,t){return e==="length"?n/hu[t.length]:e==="angle"?n/Og[t.angle]:n}function zh(n,e){return n==="length"?e.length:n==="angle"?e.angle==="deg"?"°":"rad":""}function Vh(n,e,t){const i=ho(pu(n,e,t)),r=zh(e,t);return r?r==="°"?`${i}°`:`${i} ${r}`:i}function ho(n){if(!Number.isFinite(n))return"";if(n===0)return"0";if(Math.abs(n)<Bg)return n.toExponential(4);const e=Number(n.toPrecision(6));return Math.abs(e)<1e4?String(e):e.toLocaleString("en-US",{maximumFractionDigits:20})}const cf=1e9;function kg(n,e){if((e.length==="mm"||e.length==="cm"||e.length==="m")&&Math.abs(Number(n.toPrecision(6)))>=cf)return`${ho(n/cf)} m³`;const i=hu[e.length];return`${ho(n/(i*i*i))} ${e.length}³`}function zg(n){return ho(n)}function Vg(n){return Number.isFinite(n)?String(Number(n.toPrecision(15))):""}function Hg(n){let e=0,t="";for(const i of n)i==="("?e++:i===")"?e=Math.max(0,e-1):e===0&&(t+=i);return t.includes(",")?"No commas in numbers: write 1500, or 1.5 for a decimal":null}const Hh=/^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z°]*)\s*$/i,Gg=new Set(Object.keys(hu)),Wg=new Set(["deg","rad","°"]);function $g(n){const e=Hh.exec(n);return e?e[1]:null}function mu(n,e){const t=Hh.exec(n);if(!t)return null;const i=Number(t[1]);if(!Number.isFinite(i))return null;const r=(t[2]||"").toLowerCase();return r?e==="length"&&Gg.has(r)?{n:i,unit:r}:e==="angle"&&Wg.has(r)?{n:i,unit:r}:null:{n:i,unit:r}}function Gh(n,e){return n==="length"?e.length:n==="angle"?e.angle:""}function Wh(n,e,t){const i=n.trim(),r=mu(i,e);if(r&&!r.unit){const s=Gh(e,t);return s?`${i} ${s}`:i}return i}function ec(n,e,t,i=!1){const r=(n??"").trim();if(!r)return{text:"",literal:!0,value:null,error:null};const s=t.evaluate(r,e);return(i?null:mu(r,e))&&s.ok?{text:zg(pu(s.value,e,t.units())),literal:!0,value:s.value,error:null}:{text:r,literal:!1,value:s.ok?s.value:null,error:s.ok?null:s.error}}function uf(n,e,t,i=!1){const r=(n??"").trim();if(!r||i)return r;const s=mu(r,e);if(!s)return r;const a=t.units(),o=s.unit==="°"?"deg":s.unit;if(!o||o===Gh(e,a))return $g(r)??r;const l=t.evaluate(r,e);return l.ok?Vg(pu(l.value,e,a)):r}function $h({expr:n,quantity:e,units:t,onCommit:i,validate:r,label:s,id:a,disabled:o,raw:l=!1,showUnit:c=!0,className:f,field:d}){const u=t.units(),h=`${u.length}|${u.angle}`,_=ec(n,e,t,l),[g,p]=Lt(_.text),[m,v]=Lt(null),w=_n(!1),y=_n(!1),S=_n(_.text);S.current=_.text;const M=_n(_.text),E=N=>y.current?uf(N,e,t,l):ec(N,e,t,l).text;Cn(()=>{if(!w.current){const N=E(n);y.current&&(M.current=N),p(N),v(null)}},[n,e,h,l]);function b(){w.current=!1;const N=g.trim();if(N===M.current.trim()||N===S.current){p(E(n)),v(null);return}if(!N){v("Enter a value");return}const I=Hg(N);if(I){v(I);return}const z=N,$=t.evaluate(z,e);if(!$.ok){v($.error);return}const X=r?.($.value,$.uses)??null;if(X){v(X);return}const re=Wh(z,e,u);if(re===(n??"").trim()){v(null),p(E(n));return}const J=i(re,$.value);if(J){v(J);return}v(null);const Q=E(re);y.current&&(M.current=Q),p(Q)}const T=!m&&!w.current?_.error:null,C=m??T;let D=null;const R=_.literal||!!m||_.value==null;return c&&(R?D=zh(e,u)||null:D=`= ${Vh(_.value,e,u)}`),Ae("span",{className:["nui",C?"is-invalid":"",f||""].filter(Boolean).join(" "),"data-field":d,children:[Ae("span",{className:"bc-value-row",children:[k("input",{id:a,className:"bc-input",type:"text",inputMode:"decimal",spellCheck:!1,autoComplete:"off","aria-label":s,"aria-invalid":C?!0:void 0,disabled:o,value:g,onFocus:N=>{if(y.current=!0,!w.current&&!m){const I=uf(n,e,t,l);M.current=I;const z=N.currentTarget;z.value!==I&&(z.value=I,z.select()),p(I)}else M.current=S.current},onChange:N=>{w.current=!0,p(N.target.value),m&&v(null)},onBlur:()=>{y.current=!1,b()},onKeyDown:N=>{if(N.key==="Enter")N.preventDefault(),b();else if(N.key==="Escape"){const I=g!==M.current&&g!==S.current||!!m;if(w.current=!1,!I)return;N.preventDefault(),N.stopPropagation(),p(y.current?M.current:S.current),v(null)}}}),D?k("span",{className:R?"bc-unit-label":"nui-eq","data-nui-after":"1",children:D}):null]}),C?k("span",{className:"nui-error",role:"alert","data-nui-error":"1",children:C}):null]})}const po=64;function Xh(n,e,t,i=!1){const[r,s]=Lt(i),[a,o]=Lt(n),[l,c]=Lt(null),f=_n(!1);Cn(()=>{r||o(n)},[n,r]);function d(){f.current=!1,o(n),c(null),s(!0)}function u(){f.current=!0,s(!1),o(n)}function h(_,g){if(f.current)return!0;const p=a.trim();if(!_||!p||p===n)return u(),c(null),!0;const m=e(p);return m?g?(u(),c(null),t?.(m),!0):(c(m),!1):(u(),c(null),!0)}return{editing:r,draft:a,setDraft:o,error:l,setError:c,start:d,finish:h}}function Xg({name:n,label:e,onRename:t,canRename:i=!0,onGiveUp:r}){const s=Xh(n,t,r),a=e.charAt(0).toUpperCase()+e.slice(1);return k("div",{className:"mesh-title-row",children:s.editing?Ae("span",{className:"cad-rename-wrap",children:[k("input",{type:"text",className:`mesh-rename-input${s.error?" is-invalid":""}`,maxLength:po,"aria-label":`${a} name`,"aria-invalid":s.error?!0:void 0,autoFocus:!0,value:s.draft,onChange:o=>{s.setDraft(o.target.value),s.setError(null)},onBlur:()=>s.finish(!0,!0),onKeyDown:o=>{o.key==="Enter"?(o.preventDefault(),s.finish(!0,!1)):o.key==="Escape"&&(o.preventDefault(),o.stopPropagation(),s.finish(!1,!1))}}),s.error?k("span",{className:"cad-rename-err",role:"alert",children:s.error}):null]}):Ae(Ai,{children:[k("span",{className:"mat-panel-title","data-panel-title":"1",children:n}),i?k(Ns,{icon:Et.pencil,label:`Rename ${e}`,onClick:s.start,"data-rename-btn":"1"}):null]})})}function qh({name:n,label:e,onRename:t,onDone:i,onGiveUp:r}){const s=Xh(n,t,r,!0),a=o=>{o&&i()};return Ae("span",{className:"cad-rename-wrap is-inline",onClick:o=>o.stopPropagation(),onDoubleClick:o=>o.stopPropagation(),children:[k("input",{type:"text",className:`cad-row-rename${s.error?" is-invalid":""}`,maxLength:po,"aria-label":`${e} name`,"aria-invalid":s.error?!0:void 0,autoFocus:!0,value:s.draft,onFocus:o=>o.currentTarget.select(),onChange:o=>{s.setDraft(o.target.value),s.setError(null)},onBlur:()=>a(s.finish(!0,!0)),onKeyDown:o=>{o.stopPropagation(),o.key==="Enter"?(o.preventDefault(),a(s.finish(!0,!1))):o.key==="Escape"&&(o.preventDefault(),a(s.finish(!1,!1)))}}),s.error?k("span",{className:"cad-rename-err",role:"alert",children:s.error}):null]})}function Yh({title:n,onRename:e,renameLabel:t="feature",onRenameGiveUp:i,accent:r=null,children:s,onDone:a,doneDisabled:o=null,onDelete:l,deleteLabel:c="Delete",foot:f,className:d,panel:u}){const h=["mat-panel","cad-panel",r?`is-accent-${r}`:"",d||""].filter(Boolean).join(" ");return Ae("section",{className:h,"data-cad-panel":u,"aria-label":n,children:[k("div",{className:"mat-panel-head",children:e?k(Xg,{name:n,label:t,onRename:e,onGiveUp:i}):k("div",{className:"mesh-title-row",children:k("span",{className:"mat-panel-title","data-panel-title":"1",children:n})})}),k("div",{className:"mat-panel-body",children:s}),f?k("div",{className:"cad-panel-note",children:f}):null,Ae("div",{className:`mat-panel-foot${l?"":" foot-end"}`,children:[l?k("div",{className:"mesh-foot-left",children:k(jl,{variant:"link",onClick:l,"data-panel-delete":"1",children:c})}):null,k(jl,{variant:"done",onClick:a,disabledReason:o,tip:o?"Done":null,"data-panel-done":"1",children:"Done"})]})]})}function qg({children:n,wide:e=!1}){return k("div",{className:`tree-detail${e?" is-wide":""}`,"data-cad-flyout":"1",children:n})}function $o({label:n,htmlFor:e,children:t,field:i,axis:r}){return Ae("div",{className:"mat-row cad-field","data-field-row":i,children:[k("label",{className:"mat-k",htmlFor:e,children:r?k("span",{className:"bc-axis-lab","data-axis":r,children:n}):n}),k("div",{className:"mat-v",children:t})]})}function Zs({title:n,children:e}){return Ae("div",{className:"cad-field-group",children:[k("div",{className:"cad-field-group-title",children:n}),e]})}function Yg({children:n}){return k("div",{className:"mat-assign-hint",children:n})}function Qa({children:n,fixes:e}){return Ae("div",{className:"mat-assign-hint","data-run-reason":"1",role:"status",children:[k("span",{className:"sim-run-hint-msg",children:n}),e?.map(t=>k("button",{type:"button",className:"sim-fix-go",onClick:t.run,"data-fix":t.label,children:t.label},t.label))]})}function mo({children:n,tree:e=!1,attr:t}){return e?k("li",{className:"sim-empty",...t,children:n}):k("div",{className:"cad-empty",...t,children:n})}function go({className:n,...e}){return k("select",{...e,className:["bc-select",n||""].filter(Boolean).join(" ")})}function Kg(n,e){const t=e??n.textContent??"";n.scrollWidth>n.clientWidth+1&&t?n.title=t:n.removeAttribute("title")}function Kh({title:n,section:e,action:t,children:i}){return Ae("div",{className:"tree-section","data-tree-section":e,children:[Ae("div",{className:"geo-head",children:[k("span",{children:n}),t]}),k("ul",{className:"tree-root",role:"tree","aria-label":typeof n=="string"?n:e,children:i})]})}function cr({nodeKey:n,label:e,icon:t,folder:i,indent:r=!1,selected:s=!1,className:a,attrs:o,sub:l,badge:c,actions:f,onClick:d,onDoubleClick:u,onContextMenu:h,onMouseEnter:_,onMouseLeave:g,rowProps:p,labelTitle:m,children:v}){const w=i?i.expanded:!1,y=["tree-node",w?"expanded":"",s?"selected":"",a||""].filter(Boolean).join(" "),S={};for(const[M,E]of Object.entries(o??{}))E!=null&&E!==""&&(S[M]=E);return Ae("li",{className:y,"data-tree-node":n,role:"treeitem","aria-selected":s,"aria-expanded":i?w:void 0,...S,children:[Ae("div",{className:"tree-row",...p,onClick:M=>{i&&i.onToggle(),d?.(M)},onDoubleClick:u,onContextMenu:h,onMouseEnter:_,onMouseLeave:g,children:[i?k("span",{className:"tw","aria-label":w?"Collapse":"Expand",children:w?"-":"+"}):r?k("span",{className:"tw","aria-hidden":"true"}):null,t?k(zs,{d:t,className:"tree-ico"}):null,k("span",{className:"tl",onMouseEnter:M=>Kg(M.currentTarget,m??(typeof e=="string"?e:null)),children:e}),c,l!=null?k("span",{className:"tree-sub",children:l}):null,f?k("span",{className:"tree-acts",children:f}):null]}),i?k("ul",{role:"group",children:v}):null]})}const Zg=/[\u0000-\u001f\u007f]/;function _o(n){return n.toLocaleLowerCase()}function ff(n,e,t,i){const r=n.trim();if(!r)return{ok:!1,reason:"Enter a name"};if(r.length>po)return{ok:!1,reason:`Use ${po} characters or fewer`};if(Zg.test(r))return{ok:!1,reason:"Names cannot contain tabs or line breaks"};const s=e.find(o=>o.id===t);if(s&&s.name===r)return{ok:"same"};const a=e.find(o=>o.id!==t&&_o(o.name)===_o(r));return a?{ok:!1,reason:`A ${i} named "${a.name}" already exists`}:{ok:!0,name:r}}function Zh(n,e,t){const i=n.trim(),r=t?e.find(o=>o.id===t):void 0;if(r&&r.name===i)return{ok:"same"};const s=Rh(i,e,t??void 0);if(s)return{ok:!1,reason:s};const a=e.find(o=>o.id!==t&&_o(o.name)===_o(i));return a?{ok:!1,reason:`A parameter named "${a.name}" already exists`}:{ok:!0,name:i}}function vo(n,e){const t=n.rollback;return t==null||!Number.isFinite(t)?e:Math.max(0,Math.min(e,Math.floor(t)))}function df(n,e){const t=Math.max(0,Math.min(e,Math.floor(n)));return t>=e?null:t}function Jg(n,e,t){const i=vo(e,n.features.length);return n.features.map((r,s)=>{const a=t.features[r.id];let o="ok",l=null;return a?.state==="error"||a?.state==="warning"?(o=a.state,l=a.message??(a.state==="error"?`${r.name} failed`:null)):a?.state==="pending"&&(o="pending"),{id:r.id,type:r.type,name:r.name,index:s,suppressed:!!r.suppressed,rolledBack:s>=i,status:o,message:l}})}function Qg(n,e){let t=0;for(;t<e.length&&e[t]<n;)t++;return t}function jg(n,e,t){const i=Object.keys(n.bodies),r=a=>{const o=i.indexOf(a);return o<0?i.length:o};return t.map((a,o)=>({b:a,i:o})).sort((a,o)=>r(a.b.id)-r(o.b.id)||a.i-o.i).map(({b:a})=>({id:a.id,name:n.bodies[a.id]?.name??a.name,color:n.bodies[a.id]?.color??a.color,visible:!e.hiddenBodies.includes(a.id),feature:a.feature,valid:a.valid}))}function gu(n){const e=new Set;for(const t of n.items)(t.kind==="body"||t.kind==="face"||t.kind==="edge"||t.kind==="vertex")&&e.add(t.body);return e}function e0(n,e){const t=new Set;for(const s of n.items)s.kind==="feature"&&t.add(s.feature);const i=gu(n),r=new Set;for(const s of e)i.has(s.id)&&!t.has(s.feature)&&r.add(s.feature);return{direct:t,related:r}}const Jh=["box","cylinder"],hf=new WeakMap;function Li(n){let e=hf.get(n);return e||(e=t0(n),hf.set(n,e)),e}function ss(n,e){return n.doc.state.get().doc.features.find(t=>t.id===e)}function t0(n){const{doc:e}=n,t=Ki({panel:null,panelNote:null,menu:null,renaming:null}),i=[],r=(u,h)=>{n.bridge.toast(`${u} failed: ${h}`,"error")},s=()=>{const u=e.editable();return u===!0?null:u},a=u=>ss(n,u)?.name??"the feature";function o(){const u=t.get().panel;if(u){if(t.set({panel:null,panelNote:null}),u.kind==="feature")try{u.isNew&&u.session.incomplete()?u.session.discard():u.session.commit()}catch(h){r(u.isNew?`Create ${a(u.feature)}`:`Edit ${a(u.feature)}`,Ft(h))}e.flush().catch(()=>{})}}function l(u,h,_){const g=s();if(g){r(_,g);return}o(),c();let p;try{p=u()}catch(m){r(_,Ft(m));return}p.open&&(t.set({panel:{kind:"feature",session:p,type:h,feature:p.feature,isNew:p.isNew},panelNote:null,renaming:null}),Ri(n.selection,{kind:"feature",feature:p.feature},!1))}function c(){t.get().menu&&t.set({menu:null}),lr()}function f(u){const h=t.get().panel;h&&(h.kind!=="feature"||h.feature!==u)&&o()}const d={state:t,editBlock:s,openNew(u){const h=e.features.get(u)?.label??u;l(()=>e.beginNew(u),u,`New ${h}`)},openEdit(u){const h=t.get().panel;if(h?.kind==="feature"&&h.feature===u)return;const _=ss(n,u);_&&l(()=>e.beginEdit(u),_.type,`Edit ${_.name}`)},openParams(){t.get().panel?.kind!=="params"&&(o(),c(),t.set({panel:{kind:"params"},panelNote:null}))},closePanel:o,cancelPanel(){const u=t.get().panel;if(t.set({panel:null,panelNote:null}),u?.kind==="feature")try{u.session.discard()}catch(h){r(`Undo ${a(u.feature)}`,Ft(h))}},deletePanelFeature(){const u=t.get().panel;if(!u||u.kind!=="feature")return;const h=a(u.feature);if(u.isNew){t.set({panel:null,panelNote:null});try{u.session.discard()}catch(g){r(`Delete ${h}`,Ft(g))}return}try{u.session.discard()}catch(g){r(`Delete ${h}`,Ft(g)),t.set({panel:null,panelNote:null});return}const _=e.remove(u.feature);if(_.ok){t.set({panel:null,panelNote:null});return}try{const g=e.beginEdit(u.feature);t.set({panel:{...u,session:g},panelNote:`Delete failed: ${_.reason}`})}catch{t.set({panel:null,panelNote:null}),r(`Delete ${h}`,_.reason)}},setPanelNote(u){t.set({panelNote:u})},renameFeature(u,h){const _=ff(h,e.state.get().doc.features,u,"feature");if(_.ok==="same")return null;if(_.ok===!1)return _.reason;const g=s();if(g)return g;const p=t.get().panel;if(p?.kind==="feature"&&p.feature===u)try{return p.session.update({name:_.name}),null}catch(m){return Ft(m)}f(u);try{const m=e.rename(u,_.name);return m.ok?null:m.reason}catch(m){return Ft(m)}},renameBody(u,h){const _=e.state.get().doc,g=Object.entries(_.bodies).map(([v,w])=>({id:v,name:w.name})),p=ff(h,g,u,"body");if(p.ok==="same")return null;if(p.ok===!1)return p.reason;const m=s();if(m)return m;f(null);try{const v=e.renameBody(u,p.name);return v.ok?null:v.reason}catch(v){return Ft(v)}},startRename(u,h){c(),t.set({renaming:{kind:u,id:h}})},endRename(){t.get().renaming&&t.set({renaming:null})},toggleSuppressed(u){const h=ss(n,u);if(!h)return;const _=h.suppressed?"Unsuppress":"Suppress",g=s();if(g)return r(`${_} ${h.name}`,g);f(null);try{const p=e.setSuppressed(u,!h.suppressed);p.ok||r(`${_} ${h.name}`,p.reason)}catch(p){r(`${_} ${h.name}`,Ft(p))}},runFeatureAction(u,h){const _=ss(n,u);if(!_)return;const g=`${oo[h]} ${_.name}`;try{const p=h==="repair"?e.repair(u):e.retry(u);p.ok||r(g,p.reason)}catch(p){r(g,Ft(p))}},deleteFeature(u){const h=t.get().panel;if(h?.kind==="feature"&&h.feature===u){d.deletePanelFeature();return}const _=ss(n,u);if(!_)return;const g=s();if(g)return r(`Delete ${_.name}`,g);f(null);try{const p=e.remove(u);p.ok?n.selection.set(m=>({...m,items:m.items.filter(v=>!(v.kind==="feature"&&v.feature===u))})):r(`Delete ${_.name}`,p.reason)}catch(p){r(`Delete ${_.name}`,Ft(p))}},rollBackTo(u){const _=e.state.get().doc.features.findIndex(g=>g.id===u);_<0||d.setRollbackIndex(_+1)},rollToEnd(){d.setRollbackIndex(e.state.get().doc.features.length)},setRollbackIndex(u){const h=e.state.get().doc.features.length,_=df(u,h);if(df(vo(e.state.get().view,h),h)!==_){f(null);try{e.setRollback(_)}catch(g){r("Roll back",Ft(g))}}},setBodyVisible(u,h){try{e.setBodyVisible(u,h)}catch(_){r(h?"Show body":"Hide body",Ft(_));return}if(!h){const _=g=>(g.kind==="body"||g.kind==="face"||g.kind==="edge"||g.kind==="vertex")&&g.body===u;n.selection.get().items.some(_)&&n.selection.set(g=>({...g,items:g.items.filter(p=>!_(p))}))}},featureMenu(u){const h=e.state.get(),_=h.doc.features.find(y=>y.id===u);if(!_)return[];const g=h.doc.features.indexOf(_),p=vo(h.view,h.doc.features.length),m=s(),v=g>=p,w=[{id:"edit",label:`Edit ${_.name}`,disabled:m??(v?`Roll forward to edit ${_.name}`:null),run:()=>d.openEdit(u)},{id:"rename",label:`Rename ${_.name}`,disabled:m,run:()=>d.startRename("feature",u)},{id:"suppress",label:`${_.suppressed?"Unsuppress":"Suppress"} ${_.name}`,disabled:m,run:()=>d.toggleSuppressed(u)}];for(const y of h.rebuild.features[u]?.actions??[])w.push({id:`action-${y}`,label:oo[y],disabled:y==="repair"?m:null,run:()=>d.runFeatureAction(u,y)});return w.push({sep:!0,id:"sep-roll"},{id:"rollback",label:"Roll back to here",disabled:p===g+1?"The rollback bar is already below this feature":null,run:()=>d.rollBackTo(u)}),p<h.doc.features.length&&w.push({id:"roll-end",label:"Roll to end",run:()=>d.rollToEnd()}),w.push({sep:!0,id:"sep-delete"},{id:"delete",label:`Delete ${_.name}`,danger:!0,disabled:m,run:()=>d.deleteFeature(u)}),w},bodyMenu(u){const h=e.state.get(),_=h.rebuild.bodies.find(w=>w.id===u);if(!_)return[];const g=h.view.hiddenBodies.includes(u),p=s(),m=h.doc.features.find(w=>w.id===_.feature),v=[{id:"body-visibility",label:`${g?"Show":"Hide"} ${_.name}`,run:()=>d.setBodyVisible(u,g)},{id:"body-rename",label:`Rename ${_.name}`,disabled:p,run:()=>d.startRename("body",u)}];return m&&v.push({sep:!0,id:"sep-body-feature"},{id:"body-edit",label:`Edit ${m.name}`,disabled:p,run:()=>d.openEdit(m.id)}),v},showMenu(u,h,_,g="Actions"){_.length&&(lr(),t.set({menu:{x:u,y:h,items:_,label:g}}))},closeMenu:c,featureOfItem(u){return u.kind==="feature"?u.feature:u.kind==="origin"?null:e.state.get().rebuild.bodies.find(_=>_.id===u.body)?.feature??null},fail:r,dispose(){for(const u of i)u()}};return i.push(e.state.subscribe(u=>{const h=t.get().panel;if(h?.kind==="feature"&&(!h.session.open||u.status!=="ready")){t.set({panel:null,panelNote:null});return}if(u.session&&(h?.kind!=="feature"||h.session.id!==u.session.id)){const _=e.session();_&&_.open&&_.id===u.session.id&&Jh.includes(_.draft.type)&&t.set({panel:{kind:"feature",session:_,type:_.draft.type,feature:_.feature,isNew:_.isNew},panelNote:null})}})),i.push(e.state.subscribe((u,h)=>{if(u.rebuild.seq===h.rebuild.seq||u.status!=="ready")return;const _=new Set(u.rebuild.bodies.map(p=>p.id)),g=p=>p.kind==="feature"||p.kind==="origin"?!0:_.has(p.body);n.selection.get().items.every(g)||n.selection.set(p=>({...p,items:p.items.filter(g)}))})),i.push(t.subscribe((u,h)=>{const _=h.panel?.kind==="feature"?h.panel.feature:null,g=u.panel?.kind==="feature"?u.panel.feature:null;if(!_||_===g)return;const p=n.selection.get().items;p.length===1&&p[0].kind==="feature"&&p[0].feature===_&&ru(n.selection)})),d}function Ft(n){return(n instanceof Error?n.message:String(n)).replace(/^Error:\s*/,"")||"unknown error"}const n0={box:{hint:"A box body from its size and corner position",order:10},cylinder:{hint:"A cylinder body along an origin axis",order:20}},Qh="edit.undo",_u="edit.redo",vu="modify.parameters";function i0(n,e,t,i){const r=n0[e];return{id:`solid.${e}`,label:t,group:"solid",icon:i||Et[e]||Et.part,hint:r?.hint,order:r?.order,enabled:()=>n.editBlock()??!0,run:()=>{const s=n.state.get().panel;s?.kind==="feature"&&s.isNew&&s.type===e||n.openNew(e)}}}function r0(n,e){const t={id:Qh,label:"Undo",icon:Et.undo,shortcut:"Ctrl+Z",get hint(){const s=e.state.get().panel;if(s?.kind==="feature")return s.isNew?"Cancel the new feature":"Cancel the changes made in the open panel";const a=n.doc.state.get().history.undoLabel;return a?`Undo ${a}`:void 0},enabled:()=>{const s=n.doc.state.get().history;return e.editBlock()??(s.canUndo||e.state.get().panel?.kind==="feature"?!0:"Nothing to undo")},run:()=>{e.state.get().panel?.kind==="feature"?e.cancelPanel():n.doc.undo()}},i={id:_u,label:"Redo",icon:Et.redo,shortcut:"Ctrl+Y",get hint(){const s=n.doc.state.get().history.redoLabel;return s?`Redo ${s}`:void 0},enabled:()=>{const s=n.doc.state.get().history;return e.editBlock()??(s.canRedo?!0:"Nothing to redo")},run:()=>n.doc.redo()},r={id:vu,label:"Parameters",group:"modify",icon:Et.params,hint:"Named values that any size or position field can use",order:10,enabled:()=>e.editBlock()??!0,run:()=>{e.state.get().panel?.kind==="params"?e.closePanel():e.openParams()}};return[t,i,r]}function s0(n,e,t){if(t.kind==="origin")return"The origin planes cannot be deleted.";const i=e.featureOfItem(t),r=i?n.doc.state.get().doc.features.find(a=>a.id===i)?.name:null,s=t.kind==="body"?"A body":t.kind==="vertex"?"A point":`A ${t.kind}`;return r?`${s} cannot be deleted on its own. To remove it, delete ${r} in the history.`:`${s} cannot be deleted on its own: delete the feature that makes it.`}function a0(n){return n.kind==="origin"?"The origin planes cannot be renamed.":`${n.kind==="vertex"?"Points":`${n.kind[0].toUpperCase()}${n.kind.slice(1)}s`} have no names. F2 renames a feature or a body: select one in the tree.`}function o0(n){const e=Li(n),t=[],i=new Set,r=o=>{i.has(o.id)||(i.add(o.id),t.push(n.commands.register(o)))},s=()=>{const o=n.doc.features.all().filter(l=>Jh.includes(l.type));for(const l of o)r(i0(e,l.type,l.label,l.icon));if(o.length)for(const l of r0(n,e))r(l)};s(),t.push(n.doc.state.subscribe((o,l)=>{o.status!==l.status&&s()}));const a=n.keyboard;return t.push(a.bind({combo:"Ctrl+Shift+Z",run:()=>void n.commands.run(_u)}),a.bind({combo:"Escape",inInputs:!0,run:o=>{const l=o.target,c=l?.tagName?.toLowerCase();if((c==="input"||c==="textarea"||c==="select")&&!l?.closest("[data-cad-panel]"))return;const f=e.state.get();f.menu?e.closeMenu():f.renaming?e.endRename():f.panel?e.closePanel():(ru(n.selection),n.bus.emit("app:escape",{}))}}),a.bind({combo:"Delete",run:()=>{const o=n.selection.get().items,l=o.flatMap(c=>c.kind==="feature"?[c.feature]:[]);for(const c of l)e.deleteFeature(c);!l.length&&o.length&&n.bridge.toast(s0(n,e,o[0]),"info")}}),a.bind({combo:"F2",run:()=>{const o=n.selection.get().items,l=o.find(c=>c.kind==="feature"||c.kind==="body");l?.kind==="feature"?e.startRename("feature",l.feature):l?.kind==="body"?e.startRename("body",l.body):o.length&&n.bridge.toast(a0(o[0]),"info")}})),t.push(n.bus.on("ui:edit-feature",({feature:o})=>e.openEdit(o)),n.bus.on("viewport:dblclick",({pick:o})=>{const l=e.featureOfItem(o.item);l&&e.openEdit(l)}),n.bus.on("viewport:contextmenu",({pick:o,clientX:l,clientY:c})=>{const f=[],d=n.viewport.get().handle;if(d){if(o&&(o.item.kind==="face"||o.item.kind==="origin")){const u=d.planeNormal(o.item);f.push({id:"normal-to",label:"Normal to",disabled:u?null:"Only flat faces can snap normal",run:()=>{u&&d.lookAt(u,Math.abs(u[2])>.9?[0,1,0]:[0,0,1])}})}if(o&&(o.item.kind==="face"||o.item.kind==="edge"||o.item.kind==="vertex")){const u=o.item.kind==="vertex"?"point":o.item.kind,h=o.point;f.push({id:"orbit-here",label:`Orbit around this ${u}`,run:()=>d.orbitAround(h)})}f.length&&f.push({sep:!0,id:"sep-orbit"}),f.push({id:"orbit-center",label:"Orbit around model center",run:()=>d.orbitAround("center")},{id:"orbit-origin",label:"Orbit around origin",run:()=>d.orbitAround([0,0,0])})}if(o){f.length&&f.push({sep:!0,id:"sep-core"});const u=o.item;(u.kind==="face"||u.kind==="edge"||u.kind==="vertex"||u.kind==="body")&&f.push(...e.bodyMenu(u.body).filter(_=>_.id!=="body-edit"&&_.id!=="sep-body-feature"));const h=e.featureOfItem(u);h&&(f.length&&f.push({sep:!0,id:"sep-body"}),f.push(...e.featureMenu(h)))}else{const u=n.commands.get("view.fit");u&&(f.length&&f.push({sep:!0,id:"sep-core"}),f.push({id:"view.fit",label:u.label,run:()=>void n.commands.run("view.fit")}))}e.showMenu(l,c,f)})),()=>{for(const o of t.splice(0))o();e.closePanel(),e.dispose()}}const jh=am(null);function l0({services:n,children:e}){return k(jh.Provider,{value:n,children:e})}function hn(){const n=om(jh);if(!n)throw new Error("useServices() outside <ServicesProvider>");return n}function tc(n,e){return n.mode==="any"||(n.mode??"model")===e}const pf=[{id:"view.fit",icon:Et.fit},{id:"view.front",icon:Et.viewFront},{id:"view.top",icon:Et.viewTop},{id:"view.right",icon:Et.viewRight},{id:"view.iso",icon:Et.viewIso}];function c0(n,e){const t=[];for(const r of pf){const s=n.commands.get(r.id);s&&!s.group&&tc(s,e)&&t.push({...s,icon:s.icon||r.icon,run:s.run,enabled:s.enabled})}const i=n.commands.all().filter(r=>!r.group&&r.icon&&r.id.startsWith("view.")&&!pf.some(s=>s.id===r.id)&&tc(r,e)).sort((r,s)=>(r.order??0)-(s.order??0)||r.label.localeCompare(s.label));return[...t,...i]}function u0(n,e){return e?n.id===vu?e.kind==="params":e.kind==="feature"&&n.id===`solid.${e.type}`:!1}function f0({c:n,services:e,active:t}){let i=!0;try{i=n.enabled?n.enabled(e):!0}catch(a){i=a instanceof Error?a.message:String(a)}const r=i===!0?null:i,s=_r({text:n.label,shortcut:n.shortcut,detail:r??n.hint});return Ae("button",{type:"button",className:`tb-btn${t?" is-active":""}${r?" is-disabled":""}`,"data-command":n.id,"aria-label":n.label,"aria-disabled":r?!0:void 0,"aria-pressed":t||void 0,"aria-keyshortcuts":n.shortcut?n.shortcut.replace(/Ctrl/g,"Control"):void 0,"data-disabled-reason":r??void 0,...s,onClick:()=>{r||e.commands.run(n.id)},children:[k("span",{className:"tb-ico",children:n.icon?k(zs,{d:n.icon,size:18,stroke:1.7,className:"tb-svg"}):null}),k("span",{className:"tb-txt",children:n.label})]})}function Xo({id:n,label:e,commands:t,services:i,panel:r,end:s=!1}){return Ae("div",{className:`tb-group${s?" is-end":""}`,"data-group":n,role:"group","aria-label":e,children:[k("div",{className:"tb-group-label",children:e}),k("div",{className:"tb-items",children:t.map(a=>k(f0,{c:a,services:i,active:u0(a,r)},a.id))})]})}function d0(){const n=hn(),e=Li(n),t=it(n.mode,l=>l.mode),[,i]=Lt(0);Cn(()=>n.commands.subscribe(()=>i(l=>l+1)),[n.commands]),it(n.doc.state),it(n.kernel.status),it(n.selection);const r=it(e.state,l=>l.panel),s=n.commands.toolbar(t),a=c0(n,t),o=[Qh,_u].map(l=>n.commands.get(l)).filter(l=>!!l&&!!l.icon&&tc(l,t));return!s.length&&!a.length&&!o.length?null:Ae("div",{className:"toolbar cad-toolbar",role:"toolbar","aria-label":"Commands","data-cad-toolbar":t,children:[s.map(l=>k(Xo,{id:l.group,label:l.label,commands:l.commands,services:n,panel:r},l.group)),a.length?k(Xo,{id:"view",label:"VIEW",commands:a,services:n,panel:r}):null,o.length?k(Xo,{id:"edit",label:"EDIT",commands:o,services:n,panel:r,end:!0}):null]})}const h0=["origin:top","origin:front","origin:right"],mf=120,p0={"origin:top":[0,1,0],"origin:front":[0,0,1],"origin:right":[0,0,1]};function m0(n){const{commands:e}=hn(),[t,i]=Lt(()=>!!e.get(n));return Cn(()=>(i(!!e.get(n)),e.subscribe(()=>i(!!e.get(n)))),[e,n]),t}function g0(){const{bridge:n}=hn(),[e,t]=Lt(()=>n.context.study.title);return Cn(()=>n.onStudy(i=>t(i.title)),[n]),e}function _0({row:n,onOpen:e}){const t=_r(n.message?{text:"What's wrong",detail:n.message}:null);if(n.status!=="error"&&n.status!=="warning")return null;const i=`What's wrong: ${n.message??(n.status==="error"?"the feature failed":"the feature has a warning")}`;return k("button",{type:"button",className:`cad-badge is-${n.status}`,"aria-label":i,"data-feature-badge":n.status,"data-message":n.message??void 0,...t,onClick:r=>{r.stopPropagation(),e()},onDoubleClick:r=>r.stopPropagation(),children:n.status==="error"?k("span",{className:"cad-badge-dot"}):k(zs,{d:Et.warning,size:13})})}function v0({index:n,count:e,dragging:t,onPointerDown:i,onKey:r}){const s=_r({text:"Rollback bar",detail:"Drag it, or use the arrow keys, to build the part only up to here"}),a=n>=e?"at the end":n===0?"before every feature":`after feature ${n}`;return Ae("li",{className:`cad-rollback${t?" is-dragging":""}`,role:"separator","aria-orientation":"horizontal","aria-label":"Rollback bar","aria-valuemin":0,"aria-valuemax":e,"aria-valuenow":n,"aria-valuetext":a,tabIndex:0,"data-rollback-bar":"1","data-index":n,onPointerDown:i,onKeyDown:r,...s,children:[k("span",{className:"cad-rollback-grip","aria-hidden":"true"}),k("span",{className:"cad-rollback-line","aria-hidden":"true"})]})}function x0(){const n=hn(),e=Li(n),{doc:t,selection:i}=n,r=it(t.state,R=>({features:R.doc.features,rollback:R.view.rollback,rebuild:R.rebuild.features,bodies:R.rebuild.bodies,status:R.status,error:R.error})),s=it(i),a=it(e.state,R=>({panel:R.panel,renaming:R.renaming})),[o,l]=Lt(null),c=_n(null),f=r.features.length,d=vo({rollback:r.rollback},f),u=o??d,h=Jg({features:r.features},{rollback:u>=f?null:u},{features:r.rebuild}),{direct:_,related:g}=e0(s,r.bodies),p=a.panel?.kind==="feature"?a.panel.feature:null,m=()=>{const R=c.current;return R?[...R.querySelectorAll("[data-feature-row] > .tree-row")].map(N=>{const I=N.getBoundingClientRect();return I.top+I.height/2}):[]},v=R=>{if(R.button>0)return;R.preventDefault(),R.currentTarget.focus({preventScroll:!0});let N=d;l(N);const I=$=>{N=Qg($.clientY,m()),l(N)},z=()=>{window.removeEventListener("pointermove",I),window.removeEventListener("pointerup",z),window.removeEventListener("pointercancel",z),l(null),e.setRollbackIndex(N)};window.addEventListener("pointermove",I),window.addEventListener("pointerup",z),window.addEventListener("pointercancel",z)},w=R=>{let N=null;R.key==="ArrowUp"?N=Math.max(0,d-1):R.key==="ArrowDown"?N=Math.min(f,d+1):R.key==="Home"?N=0:R.key==="End"&&(N=f),N!=null&&(R.preventDefault(),R.stopPropagation(),e.setRollbackIndex(N))},y=_n(0);Cn(()=>{Date.now()-y.current>1e3||c.current?.querySelector("[data-rollback-bar]")?.focus({preventScroll:!0})},[d]);const S=it(n.viewport,R=>R.handle),M=R=>S?.flash(R),E=(R,N)=>Ri(i,{kind:"feature",feature:R.id},N.ctrlKey||N.metaKey),b=(R,N)=>{N.preventDefault();const I={kind:"feature",feature:R.id};Ds(i.get(),I)||Ri(i,I,!1),e.showMenu(N.clientX,N.clientY,e.featureMenu(R.id),`${R.name} actions`)},T=R=>{if(R.rolledBack&&o==null){n.bridge.toast(`Roll forward to edit ${R.name}`,"info");return}e.openEdit(R.id)},C=[],D=k(v0,{index:u,count:f,dragging:o!=null,onPointerDown:v,onKey:R=>{y.current=Date.now(),w(R)}},"rollback-bar");return h.forEach((R,N)=>{N===u&&C.push(D);const I=t.features.get(R.type),z=a.renaming?.kind==="feature"&&a.renaming.id===R.id,$=[R.rolledBack?"is-rolled-back":"",R.suppressed?"is-suppressed":"",R.status==="error"?"is-error":"",R.status==="warning"?"is-warning":"",g.has(R.id)?"is-related":"",p===R.id?"is-editing":""].filter(Boolean).join(" ");C.push(k(cr,{nodeKey:R.id,icon:I?.icon||Et[R.type]||Et.part,label:z?k(qh,{name:R.name,label:"Feature",onRename:X=>e.renameFeature(R.id,X),onDone:()=>e.endRename(),onGiveUp:X=>e.fail(`Rename ${R.name}`,X)}):R.name,labelTitle:R.name,selected:_.has(R.id),className:$,attrs:{"data-feature-row":"1","data-feature-type":R.type,"data-state":R.status,"data-suppressed":R.suppressed?"1":void 0,"data-rolled-back":R.rolledBack?"1":void 0},badge:k(_0,{row:R,onOpen:()=>T(R)}),sub:R.suppressed?"Suppressed":void 0,onClick:X=>E(R,X),onDoubleClick:()=>T(R),onContextMenu:X=>b(R,X),onMouseEnter:()=>M([{kind:"feature",feature:R.id}]),onMouseLeave:()=>M([])},R.id))}),f>0&&u>=f&&C.push(D),k("div",{ref:c,children:k(Kh,{title:"HISTORY",section:"history",children:r.status==="loading"?k(mo,{tree:!0,attr:{"data-tree-empty":"loading"},children:"Opening the part…"}):r.status==="error"?k("li",{className:"cad-tree-error","data-tree-error":"1",children:k(Qa,{fixes:[{label:"Try again",run:()=>void t.reload().catch(()=>{})}],children:r.error||"The part could not be read"})}):f===0?k(mo,{tree:!0,attr:{"data-tree-empty":"history"},children:"No features yet"}):C})})}function y0({row:n,selected:e}){const t=hn(),i=Li(t),r=it(i.state,o=>o.renaming?.kind==="body"&&o.renaming.id===n.id),s=it(t.viewport,o=>o.handle),a=_r(n.valid?null:{text:"What's wrong",detail:"The kernel reports this body as invalid geometry"});return k(cr,{nodeKey:`body:${n.id}`,indent:!0,label:Ae(Ai,{children:[k("span",{className:"cad-swatch",style:{background:n.color},"aria-hidden":"true"}),r?k(qh,{name:n.name,label:"Body",onRename:o=>i.renameBody(n.id,o),onDone:()=>i.endRename(),onGiveUp:o=>i.fail(`Rename ${n.name}`,o)}):k("span",{className:"cad-body-name",children:n.name})]}),labelTitle:n.name,selected:e,className:n.visible?void 0:"is-hidden-body",attrs:{"data-body-row":n.id,"data-visible":n.visible?"1":"0"},badge:n.valid?null:k("span",{className:"cad-badge is-warning",role:"img","aria-label":"What's wrong: the kernel reports this body as invalid geometry",tabIndex:0,...a,children:k(zs,{d:Et.warning,size:13})}),actions:Ae(Ai,{children:[k(Ns,{size:"row",icon:n.visible?Et.eye:Et.eyeOff,label:n.visible?`Hide ${n.name}`:`Show ${n.name}`,"data-body-act":"visibility",onClick:()=>i.setBodyVisible(n.id,!n.visible)}),k(Ns,{size:"row",icon:Et.pencil,label:`Rename ${n.name}`,"data-body-act":"rename",disabledReason:i.editBlock(),onClick:()=>i.startRename("body",n.id)})]}),onClick:o=>Ri(t.selection,{kind:"body",body:n.id},o.ctrlKey||o.metaKey),onContextMenu:o=>{o.preventDefault();const l={kind:"body",body:n.id};Ds(t.selection.get(),l)||Ri(t.selection,l,!1),i.showMenu(o.clientX,o.clientY,i.bodyMenu(n.id),`${n.name} actions`)},onMouseEnter:()=>s?.flash([{kind:"body",body:n.id}]),onMouseLeave:()=>s?.flash([])})}function b0({handle:n}){const e=it(n.state,s=>({planes:s.planes,bodies:s.bodies})),t=e.planes==="always",i=t||e.bodies===0,r=t?"On: Top, Front and Right are always drawn":i?"Off: drawn now because the part shows no body; then only while one is selected or hovered":"Off: drawn on an empty part, and while one is selected or hovered";return k(Ns,{size:"row",icon:i?Et.eye:Et.eyeOff,label:"Always draw the origin planes",hint:r,pressed:t,"data-origin-act":"planes","data-planes":e.planes,"data-planes-drawn":i?"1":"0",onClick:()=>n.setPlanes(t?"auto":"always")})}function S0(){const n=hn(),e=Li(n),{doc:t,selection:i}=n,r=g0(),s=it(t.state,p=>({expanded:p.view.expanded,hidden:p.view.hiddenBodies,bodies:p.rebuild.bodies,docBodies:p.doc.bodies,params:p.doc.params.length})),a=it(i),o=it(e.state,p=>p.panel?.kind==="params"),l=m0(vu),c=it(n.viewport,p=>p.handle),f=s.expanded.includes("origin"),d=s.expanded.includes("bodies"),u=jg({bodies:s.docBodies},{hiddenBodies:s.hidden},s.bodies),h=gu(a),_=async()=>{const p=e.editBlock();if(p)return e.fail(`Rename ${r}`,p);const m=await n.bridge.prompt({title:"Rename part",label:"Name",value:r,confirmLabel:"Rename"}),v=String(m??"").trim();if(!(!v||v===r)){if(v.length>mf)return e.fail(`Rename ${r}`,`A name can have at most ${mf} characters`);try{const w=await n.bridge.study.get();await n.bridge.study.update({title:v},w.rev)}catch(w){e.fail(`Rename ${r}`,Ft(w))}}},g=(p,m,v)=>{const w={kind:"origin",ref:p},y=p in Wn?p:null;return k(cr,{nodeKey:p,indent:!0,icon:v,label:m,selected:Ds(a,w),onClick:S=>Ri(i,w,S.ctrlKey||S.metaKey),onContextMenu:S=>{S.preventDefault(),!(!y||!c)&&(Ds(i.get(),w)||Ri(i,w,!1),e.showMenu(S.clientX,S.clientY,[{id:"look-at",label:"Look at",run:()=>c.lookAt(Wn[y].normal,p0[y])}],`${m} actions`))},onMouseEnter:()=>c?.flash([w]),onMouseLeave:()=>c?.flash([])},p)};return Ae(Kh,{title:"PART",section:"part",children:[k(cr,{nodeKey:"part",icon:Et.part,label:r,className:"is-part",attrs:{"data-part-name":"1"},onDoubleClick:()=>void _()}),k(cr,{nodeKey:"origin",icon:Et.origin,label:"Origin",folder:{expanded:f,onToggle:()=>t.setExpanded("origin",!f)},actions:c&&typeof c.setPlanes=="function"?k(b0,{handle:c}):null,children:h0.map(p=>g(p,Wn[p].label,Et.plane))}),l?k(cr,{nodeKey:"params",indent:!0,icon:Et.params,label:`Parameters (${s.params})`,selected:o,attrs:{"data-params-row":"1"},onClick:()=>o?e.closePanel():e.openParams()}):null,k(cr,{nodeKey:"bodies",icon:Et.folder,label:`Bodies (${u.length})`,attrs:{"data-bodies-folder":"1"},folder:{expanded:d,onToggle:()=>t.setExpanded("bodies",!d)},children:u.length?u.map(p=>k(y0,{row:p,selected:h.has(p.id)},p.id)):k(mo,{tree:!0,attr:{"data-tree-empty":"bodies"},children:"No bodies yet"})})]})}function M0(){return Ae("div",{className:"left-tree","data-cad-tree":"1","aria-label":"Design tree",children:[k(S0,{}),k(x0,{})]})}const w0=[{value:"new",label:"New body"},{value:"join",label:"Join"},{value:"cut",label:"Cut"},{value:"intersect",label:"Intersect"}],E0=[{value:"origin:x",label:"X axis"},{value:"origin:y",label:"Y axis"},{value:"origin:z",label:"Z axis"}],gf=["x","y","z"],as=n=>e=>Mh(n,e);function _f(n,e,t){const i=[n[0],n[1],n[2]];return i[e]=t,i}function T0({panel:n}){const e=hn(),t=Li(e),{doc:i}=e,r=it(i.state,S=>S.doc.features.find(M=>M.id===n.feature)??null),s=it(i.state,S=>S.rebuild.features[n.feature]??null),a=it(i.state,S=>{const M=S.rebuild.features[n.feature];if(M&&typeof M.bodiesBefore=="number")return M.bodiesBefore;const E=S.doc.features.findIndex(T=>T.id===n.feature);return(E>=0?S.doc.features.slice(0,E):S.doc.features.slice(0,S.view.rollback??S.doc.features.length)).filter(T=>T.op==="new"&&!T.suppressed&&(S.rebuild.features[T.id]?.state==="ok"||S.rebuild.features[T.id]?.state==="warning")).length});it(i.state,S=>S.doc.units),it(i.state,S=>S.doc.params);const o=it(t.state,S=>S.panelNote),[,l]=Lt(0),c=n.session.open?n.session.draft:r??n.session.draft,f=S=>{const M=t.editBlock();if(M)return M;if(!n.session.open)return"This panel is no longer editing the feature";try{n.session.update(S)}catch(E){return`${n.isNew?"Create":"Edit"} failed: ${Ft(E)}`}return l(E=>E+1),o&&t.setPanelNote(null),null};let d=null;try{d=n.session.incomplete()}catch(S){d=Ft(S)}const u=n.isNew&&d?d:null,h=i.units,_=[],g=(S,M,E,b,T)=>{const C=`cad-f-${n.feature}-${S}`,D=ec(E,"length",h).error;return D&&_.push(D),k($o,{label:M,htmlFor:C,field:S,axis:T,children:k($h,{id:C,field:S,label:M,expr:E,quantity:"length",units:h,validate:b,onCommit:R=>f(A0(c,S,R))})},S)},p=a>0||c.op!=="new"||r!=null&&r.op!=="new"?k($o,{label:"Operation",htmlFor:`cad-f-${n.feature}-op`,field:"op",children:k(go,{id:`cad-f-${n.feature}-op`,"aria-label":"Operation","data-field":"op",value:c.op,onChange:S=>{const M=f({op:S.target.value});M&&t.setPanelNote(M)},children:w0.map(S=>k("option",{value:S.value,children:S.label},S.value))})}):null;let m;if(c.type==="box"){const S=c;m=Ae(Ai,{children:[Ae(Zs,{title:"Size",children:[g("size.0","Length (X)",S.size[0],as("Length")),g("size.1","Width (Y)",S.size[1],as("Width")),g("size.2","Height (Z)",S.size[2],as("Height"))]}),k(Zs,{title:"Corner",children:gf.map((M,E)=>g(`origin.${E}`,M.toUpperCase(),S.origin[E],void 0,M))}),p]})}else{const S=c;m=Ae(Ai,{children:[Ae(Zs,{title:"Size",children:[g("diameter","Diameter",S.diameter,as("Diameter")),g("height","Height",S.height,as("Height"))]}),Ae(Zs,{title:"Placement",children:[k($o,{label:"Axis",htmlFor:`cad-f-${n.feature}-axis`,field:"axis",children:k(go,{id:`cad-f-${n.feature}-axis`,"aria-label":"Axis","data-field":"axis",value:S.axis,onChange:M=>{const E=f({axis:M.target.value});E&&t.setPanelNote(E)},children:E0.map(M=>k("option",{value:M.value,children:M.label},M.value))})}),gf.map((M,E)=>g(`origin.${E}`,`Base centre ${M.toUpperCase()}`,S.origin[E],void 0,M))]}),p]})}const v=S=>!!S&&_.some(M=>S===M||S.endsWith(`: ${M}`)),w=r!=null&&JSON.stringify(c)!==JSON.stringify(r),y=[];if(o&&y.push(k(Qa,{children:o},"note")),s?.state==="error"&&!(v(s.message)&&!s.actions?.length)){const S=(s.actions??[]).map(M=>({label:oo[M],run:()=>t.runFeatureAction(n.feature,M)}));y.push(k(Qa,{fixes:S,children:s.message||`${c.name} failed`},"error"))}else s?.state==="warning"&&s.message&&y.push(k("div",{className:"mat-assign-hint is-warning",role:"status",children:s.message},"warning"));return d&&n.isNew?y.push(k(Qa,{children:d},"incomplete")):d&&(w||!v(d))&&y.push(k(Yg,{children:Ae("span",{className:"cad-not-applied",children:["Not applied: ",d]})},"incomplete")),k(Yh,{panel:"feature",title:c.name,accent:"feature",onRename:S=>{const M=t.renameFeature(n.feature,S);return M||l(E=>E+1),M},onRenameGiveUp:S=>t.setPanelNote(`Rename failed: ${S}`),renameLabel:"feature",onDone:()=>t.closePanel(),doneDisabled:u,onDelete:()=>t.deletePanelFeature(),foot:y.length?y:null,children:k("div",{"data-feature-panel":c.type,"data-feature-id":n.feature,"data-new":n.isNew?"1":"0",children:m})})}function A0(n,e,t){const[i,r]=e.split(".");if(r!=null){const s=Number(r);if(i==="size"&&n.type==="box")return{size:_f(n.size,s,t)};if(i==="origin")return{origin:_f(n.origin,s,t)}}if(i==="diameter"||i==="height")return{[i]:t};throw new Error(`unknown field ${e}`)}function ep(n){return[{value:"length",label:n.unitLabel("length")||"mm"},{value:"angle",label:n.units().angle==="deg"?"deg":"rad"},{value:"scalar",label:"No unit"}]}function R0(n,e){const t=e.evaluate(n.expr,n.quantity);return t.ok?{text:Vh(t.value,n.quantity,e.units()),error:null}:{text:"",error:t.error}}function tp(n,e){return e.some(t=>t.toLowerCase()===n.toLowerCase())?`${n} cannot use itself`:null}const vf={length:"a length",angle:"an angle",scalar:"a plain number"};function C0(n,e,t){const i=t.evaluate(n,e);if(i.ok)return null;const r=["length","angle","scalar"].find(s=>s!==e&&t.evaluate(n,s).ok);return r?`${n} is ${vf[r]}, not ${vf[e]}`:`${n}: ${i.error}`}function P0({p:n,onError:e}){const t=hn(),[i,r]=Lt(n.name),[s,a]=Lt(!1),o=s?i:n.name,l=()=>{a(!1);const c=t.doc.state.get().doc.params,f=Zh(i,c,n.id);if(f.ok==="same"){e(null);return}if(f.ok===!1){if(!i.trim()){r(n.name),e(null);return}a(!0),e(f.reason);return}try{const d=t.doc.updateParam(n.id,{name:f.name});if(!d.ok){a(!0),e(d.reason);return}}catch(d){a(!0),e(Ft(d));return}e(null)};return k("input",{type:"text",className:"bc-input cad-param-name","aria-label":`Name of ${n.name}`,spellCheck:!1,autoComplete:"off",maxLength:64,value:o,onFocus:()=>{r(n.name),a(!0)},onChange:c=>{r(c.target.value),a(!0)},onBlur:l,onKeyDown:c=>{c.key==="Enter"?(c.preventDefault(),l()):c.key==="Escape"&&(c.preventDefault(),c.stopPropagation(),r(n.name),a(!1),e(null))}})}function L0({p:n}){const e=hn(),{doc:t}=e,i=t.units,[r,s]=Lt(null),a=R0(n,i),o=ep(i);return Ae(Ai,{children:[Ae("tr",{className:r?"is-invalid":void 0,"data-param-row":n.name,"data-param-id":n.id,children:[k("td",{children:k(P0,{p:n,onError:s})}),k("td",{children:k($h,{raw:!0,showUnit:!1,field:"expr",label:`Expression of ${n.name}`,expr:n.expr,quantity:n.quantity,units:i,validate:(l,c)=>tp(n.name,c),onCommit:l=>{try{const c=t.updateParam(n.id,{expr:l});if(!c.ok)return c.reason}catch(c){return Ft(c)}return s(null),null}})}),k("td",{className:`cad-param-value${a.error?" is-error":""}`,"data-param-value":"1",children:a.error?"Error":a.text}),k("td",{children:k(go,{"aria-label":`Unit of ${n.name}`,value:n.quantity,"data-param-unit":"1",onChange:l=>{const c=l.target.value,f=C0(n.expr,c,i);if(f){s(f);return}try{const d=t.updateParam(n.id,{quantity:c});s(d.ok?null:d.reason)}catch(d){s(Ft(d))}},children:o.map(l=>k("option",{value:l.value,children:l.label},l.value))})}),k("td",{children:k(Ns,{size:"row",icon:Et.trash,label:`Delete ${n.name}`,"data-param-delete":"1",onClick:()=>{try{const l=t.removeParam(n.id);s(l.ok?null:l.reason.startsWith(`${n.name} can't be deleted`)?l.reason:`Delete failed: ${l.reason}`)}catch(l){s(`Delete failed: ${Ft(l)}`)}}})})]}),r||a.error?k("tr",{className:"cad-param-err-row",children:k("td",{colSpan:5,className:"cad-param-err",role:"alert","data-param-error":n.name,children:r??a.error})}):null]})}function D0(){const n=hn(),{doc:e}=n,t=e.units,[i,r]=Lt(""),[s,a]=Lt(""),[o,l]=Lt("length"),[c,f]=Lt(null),d=ep(t),u=()=>{const _=e.state.get().doc.params,g=Zh(i,_,null);if(g.ok!==!0){f(g.ok===!1?g.reason:"Enter a name");return}if(!s.trim()){f("Enter an expression, for example 20 mm");return}const p=tp(g.name,Zl(s));if(p){f(p);return}const m=t.evaluate(s,o);if(!m.ok){f(m.error);return}try{const v=e.addParam({name:g.name,expr:Wh(s,o,t.units()),quantity:o});if(typeof v!="string"&&!v.ok){f(v.reason);return}}catch(v){f(Ft(v));return}r(""),a(""),f(null)},h=_=>{_.key==="Enter"&&(_.preventDefault(),u())};return Ae(Ai,{children:[Ae("tr",{className:"cad-param-add","data-param-add":"1",children:[k("td",{children:k("input",{type:"text",className:"bc-input cad-param-name","aria-label":"New parameter name",placeholder:"Name",spellCheck:!1,autoComplete:"off",maxLength:64,value:i,onChange:_=>{r(_.target.value),f(null)},onKeyDown:h})}),k("td",{children:k("input",{type:"text",className:"bc-input cad-param-expr","aria-label":"New parameter expression",placeholder:"Expression",spellCheck:!1,autoComplete:"off",value:s,onChange:_=>{a(_.target.value),f(null)},onKeyDown:h})}),k("td",{}),k("td",{children:k(go,{"aria-label":"New parameter unit",value:o,onChange:_=>l(_.target.value),children:d.map(_=>k("option",{value:_.value,children:_.label},_.value))})}),k("td",{})]}),k("tr",{className:"cad-param-add-actions",children:k("td",{colSpan:5,children:k(jl,{variant:"secondary",onClick:u,"data-param-add-btn":"1",children:"+ Add parameter"})})}),c?k("tr",{className:"cad-param-err-row",children:k("td",{colSpan:5,className:"cad-param-err",role:"alert","data-param-error":"new",children:c})}):null]})}function N0(){const n=hn(),e=Li(n),t=it(n.doc.state,i=>i.doc.params);return it(n.doc.state,i=>i.doc.units),k(Yh,{panel:"params",title:"Parameters",onDone:()=>e.closePanel(),className:"cad-params-panel",children:Ae("table",{className:"cad-params","aria-label":"Parameters",children:[k("thead",{children:Ae("tr",{children:[k("th",{scope:"col",children:"Name"}),k("th",{scope:"col",children:"Expression"}),k("th",{scope:"col",children:"Value"}),k("th",{scope:"col",children:"Unit"}),k("th",{scope:"col",children:k("span",{className:"cad-sr",children:"Delete"})})]})}),Ae("tbody",{children:[t.length?null:k("tr",{children:k("td",{colSpan:5,children:k(mo,{attr:{"data-params-empty":"1"},children:"No parameters yet"})})}),t.map(i=>k(L0,{p:i},i.id)),k(D0,{})]})]})})}function I0(){const n=Li(hn()),e=it(n.state,t=>t.panel);return Ae("div",{className:"cad-float-stack","data-cad-left-stack":"1",children:[k(M0,{}),e?k(qg,{wide:e.kind==="params",children:e.kind==="feature"?k(T0,{panel:e},e.session.id):k(N0,{})}):null]})}function U0(){const n=Li(hn()),e=it(n.state,t=>t.menu);return Ae(Ai,{children:[e?k(Fg,{x:e.x,y:e.y,items:e.items,label:e.label,onClose:n.closeMenu}):null,k(Dg,{})]})}function F0(){const[n,e]=Lt(()=>typeof document<"u"&&document.hasFocus());return Cn(()=>{let t=!1,i=!1;const r=()=>{t?i=!0:e(!0)},s=()=>{i=!1,e(!1)},a=()=>{t=!0},o=()=>{t=!1,i&&(i=!1,setTimeout(()=>e(document.hasFocus()),0))};return document.hasFocus()&&r(),window.addEventListener("focus",r),window.addEventListener("blur",s),document.addEventListener("focusin",r),document.addEventListener("pointerdown",a,!0),document.addEventListener("pointerup",o,!0),document.addEventListener("pointercancel",o,!0),()=>{window.removeEventListener("focus",r),window.removeEventListener("blur",s),document.removeEventListener("focusin",r),document.removeEventListener("pointerdown",a,!0),document.removeEventListener("pointerup",o,!0),document.removeEventListener("pointercancel",o,!0)}},[]),n}function B0(n,e){const[t,i]=Lt(!1);return Cn(()=>{if(!n){i(!1);return}const r=setTimeout(()=>i(!0),e);return()=>clearTimeout(r)},[n,e]),n&&t}function O0(){const n=hn(),{doc:e}=n,t=it(n.kernel.status,d=>({state:d.state,message:d.message,memoryHigh:d.memory_high,heap:d.heap_bytes})),i=it(e.state,d=>({status:d.status,rebuild:d.rebuild.status,rebuildMsg:d.rebuild.message,bodies:d.rebuild.bodies,save:d.save,units:d.doc.units})),r=it(n.selection),s=B0(i.rebuild==="running",300),[a,o]=Lt(!1),l=F0(),c=[];if(t.state==="starting"||t.state==="restarting"?c.push(k(Dn,{chip:"kernel",state:t.state,busy:!0,children:t.state==="starting"?"Starting kernel…":"Restarting kernel…"},"kernel")):t.state==="failed"&&c.push(k(Dn,{chip:"kernel",state:"failed",kind:"error",actions:[{label:"Retry",run:()=>void n.kernel.restart("Retry").catch(()=>{})}],children:t.message||"The kernel failed to start"},"kernel")),t.memoryHigh&&t.state==="ready"&&c.push(Ae(Dn,{chip:"memory",kind:"warning",state:"high",children:["Large model · ",t.heap!=null?`${(t.heap/1024**3).toFixed(1)} GB`:"high"," memory"]},"memory")),i.rebuildMsg?c.push(Ae(Dn,{chip:"rebuild",state:"failed",kind:"error",children:["Rebuild failed: ",i.rebuildMsg]},"rebuild")):s&&c.push(k(Dn,{chip:"rebuild",state:"running",busy:!0,children:"Rebuilding…"},"rebuild")),i.status==="ready"&&i.bodies.length){const d=gu(r),u=i.bodies.filter(v=>d.has(v.id)),h=i.bodies.filter(v=>v.visible),_=i.bodies.length-h.length,g=u.length?u:h;let p=null;u.length?p=g.length===1?g[0].name:`${g.length} bodies`:_?p=`Total of ${g.length} shown ${g.length===1?"body":"bodies"}`:g.length>1&&(p=`Total of ${g.length} bodies`);const m=g.filter(v=>v.volume==null);if(g.length&&!m.length){const v=g.reduce((w,y)=>w+(y.volume??0),0);c.push(Ae(Dn,{chip:"volume",k:"Volume",children:[p?Ae("span",{className:"cad-chip-which",title:p,children:[k("span",{className:"cad-chip-name",children:p})," ·"," "]}):null,k("span",{"data-volume-mm3":String(v),children:kg(v,i.units)})]},"volume"))}else if(g.length){const v=()=>{o(!0),Promise.all(m.map(w=>e.measure(w.id))).catch(w=>n.bridge.toast(`Measure failed: ${w instanceof Error?w.message:String(w)}`,"error")).finally(()=>o(!1))};c.push(Ae(Dn,{chip:"volume",k:"Volume",state:a?"measuring":"unmeasured",busy:a,actions:a?[]:[{label:"Measure",run:v}],children:[p?Ae("span",{className:"cad-chip-which",title:p,children:[k("span",{className:"cad-chip-name",children:p})," ·"," "]}):null,a?"Measuring…":"Not measured yet"]},"volume"))}}const f=i.save;return f.state==="conflict"?c.push(k(Dn,{chip:"save",state:"conflict",kind:"warning",actions:[{label:"Reload",run:()=>void e.reload().catch(d=>n.bridge.toast(`Reload failed: ${d instanceof Error?d.message:String(d)}`,"error"))}],children:f.message||"Changed in another tab"},"save")):f.state==="error"?c.push(Ae(Dn,{chip:"save",state:"error",kind:"error",actions:[{label:"Retry",run:()=>e.retrySave()}],children:["Not saved: ",f.message]},"save")):f.state==="pending"||f.state==="saving"?c.push(k(Dn,{chip:"save",state:f.state,children:"Saving…"},"save")):f.state==="saved"&&f.at&&c.push(k(Dn,{chip:"save",state:"saved",children:"Saved"},"save")),!l&&i.status==="ready"&&c.push(k(Dn,{chip:"keys",state:"no-focus",children:"Click here to use keyboard shortcuts"},"keys")),k("div",{className:"cad-dock","data-cad-dock":"1",children:c})}function k0(n){return o0(n)}const np=[{view:"front",label:"Front",shortcut:"1"},{view:"back",label:"Back",shortcut:"2"},{view:"left",label:"Left",shortcut:"3"},{view:"right",label:"Right",shortcut:"4"},{view:"top",label:"Top",shortcut:"5"},{view:"bottom",label:"Bottom",shortcut:"6"},{view:"iso",label:"Isometric",shortcut:"7"}],xf="The viewport is not ready";function nc(n,e){for(const t of n.items){if(t.kind!=="face"&&t.kind!=="origin")continue;const i=e.planeNormal(t);if(i)return{normal:i,up:Math.abs(i[2])>.9?[0,1,0]:[0,0,1]}}return{reason:"Select a planar face or a plane to look at it straight on"}}function os(n){return n.viewport.get().handle}function z0(){const n=e=>os(e)?!0:xf;return[{id:"view.fit",label:"Fit",shortcut:"F",hint:"Frame the visible bodies, keeping the view direction",enabled:n,run:e=>os(e)?.fit()},...np.map(e=>({id:`view.${e.view}`,label:`${e.label} view`,shortcut:e.shortcut,enabled:n,run:t=>os(t)?.setView(e.view)})),{id:"view.normal-to",label:"Normal to",shortcut:"N",hint:"Look straight at the selected planar face or plane",explainRefusal:!0,enabled:e=>{const t=os(e);if(!t)return xf;const i=nc(e.selection.get(),t);return"reason"in i?i.reason:!0},run:e=>{const t=os(e);if(!t)return;const i=nc(e.selection.get(),t);"reason"in i||t.lookAt(i.normal,i.up)}}]}const Js={home:["M4 11.2L12 4.5l8 6.7","M6.4 10.2V19.5h11.2V10.2","M10 19.5v-5.2h4v5.2"],views:["M12 3.2l7.6 4.3v9L12 20.8l-7.6-4.3v-9z","M12 12l7.6-4.5","M12 12v8.8","M12 12L4.4 7.5"],section:["M12 3.2l7.6 4.3v9L12 20.8l-7.6-4.3v-9z","M3 15.5l18-7"],filter:["M4 5h16l-6.2 7.4V19l-3.6 1.6v-8.2z"]};function Qs({paths:n}){return k("svg",{viewBox:"0 0 24 24",width:"16",height:"16","aria-hidden":"true",focusable:"false",children:k("g",{fill:"none",stroke:"currentColor",strokeWidth:"1.8",strokeLinecap:"round",strokeLinejoin:"round",children:n.map(e=>k("path",{d:e},e))})})}function qo({open:n,onClose:e,label:t,children:i,id:r}){const s=_n(null);return Cn(()=>{if(!n)return;const a=l=>{const c=s.current,f=l.target;c&&f&&!c.contains(f)&&!f.closest?.(`[data-vp-opens="${r}"]`)&&e()},o=l=>{l.key==="Escape"&&(l.preventDefault(),l.stopPropagation(),e())};return document.addEventListener("pointerdown",a,!0),document.addEventListener("keydown",o,!0),()=>{document.removeEventListener("pointerdown",a,!0),document.removeEventListener("keydown",o,!0)}},[n,e,r]),n?k("div",{ref:s,className:"cad-vp-pop",role:"dialog","aria-label":t,"data-vp-pop":r,children:i}):null}function js({value:n,options:e,onChange:t,name:i}){return k("div",{className:"cad-vp-seg",role:"radiogroup","aria-label":i,"data-vp-seg":i,children:e.map(r=>k("button",{type:"button",role:"radio","aria-checked":n===r.value,className:n===r.value?"is-on":"",onClick:()=>t(r.value),"data-value":r.value,children:r.label},r.value))})}const Yo=[{kind:"face",label:"Faces"},{kind:"edge",label:"Edges"},{kind:"vertex",label:"Vertices"},{kind:"body",label:"Bodies"},{kind:"origin",label:"Planes"}],V0=[{value:"origin:top",label:"Top"},{value:"origin:front",label:"Front"},{value:"origin:right",label:"Right"}];function H0(n){return String(Math.round(n*1e3)/1e3||0)}function ip(n){const e=Math.max(n/400,1e-4),t=10**Math.floor(Math.log10(e));return[1,2,5,10].map(i=>i*t).find(i=>i>=e-1e-12)??e}function yf(n){if(!n)return 0;const e=ip(Math.abs(n[1]-n[0])),t=(n[0]+n[1])/2;return Math.round(t/e)*e||0}function G0(n){const e=Wn[n].normal,t=e.findIndex(i=>i!==0);return{label:"XYZ"[t],sign:Math.sign(e[t])}}function W0({handle:n}){const e=hn(),[t,i]=Lt(null),r=it(n.state,v=>({projection:v.projection,display:v.display,section:v.section,planes:v.planes})),s=it(e.selection,v=>v.filter),a=it(e.selection,v=>v.items),o=r.section,l=()=>i(null),c=v=>i(w=>w===v?null:v),f=t==="section"&&o?n.sectionRange(o.plane):null,d=o?G0(o.plane):{label:"Y",sign:1},u=f?[Math.min(f[0]*d.sign,f[1]*d.sign),Math.max(f[0]*d.sign,f[1]*d.sign)]:null,h=t==="views"?nc({items:a},n):null,_=v=>{const w=s.includes(v)?s.filter(y=>y!==v):[...s,v];Xu(e.selection,Yo.map(y=>y.kind).filter(y=>w.includes(y)))},g=()=>{if(o?.on){n.setSection({on:!1}),i(null);return}const v=o?.plane??"origin:front";n.setSection({on:!0,plane:v,offset:yf(n.sectionRange(v))}),i("section")},p=v=>{n.setSection({plane:v,offset:yf(n.sectionRange(v))})},m=v=>{n.setView(v),l()};return Ae("div",{className:"cad-vp-gizmo","data-cad-gizmo":"1",children:[Ae("div",{className:"cad-vp-gizmo-row",children:[Ae("div",{className:"cad-vp-tool",children:[k("button",{type:"button",className:`cad-vp-btn${s.length?" is-on":""}`,title:s.length?`Selection filter: ${Yo.filter(v=>s.includes(v.kind)).map(v=>v.label).join(", ")}`:"Selection filter","aria-label":"Selection filter","aria-expanded":t==="filter","data-vp-opens":"filter",onClick:()=>c("filter"),children:k(Qs,{paths:Js.filter})}),Ae(qo,{open:t==="filter",onClose:l,label:"Selection filter",id:"filter",children:[k("div",{className:"cad-vp-pop-title",children:"Select"}),k("div",{className:"cad-vp-chips",children:Yo.map(v=>k("button",{type:"button",className:`cad-vp-chip${s.includes(v.kind)?" is-on":""}`,"aria-pressed":s.includes(v.kind),"data-filter":v.kind,onClick:()=>_(v.kind),children:v.label},v.kind))}),k("div",{className:"cad-vp-pop-hint",children:s.length?"Only these can be picked in the viewport.":"Faces, edges, vertices and planes can be picked."}),s.length?k("button",{type:"button",className:"cad-vp-link","data-filter-clear":"1",onClick:()=>Xu(e.selection,[]),children:"Pick anything"}):null]})]}),Ae("div",{className:"cad-vp-tool",children:[k("button",{type:"button",className:`cad-vp-btn${o?.on?" is-on":""}`,title:o?.on?"Turn off the section view":"Section view","aria-label":"Section view","aria-pressed":!!o?.on,"data-vp-opens":"section",onClick:g,children:k(Qs,{paths:Js.section})}),Ae(qo,{open:t==="section"&&!!o?.on,onClose:l,label:"Section view",id:"section",children:[k("div",{className:"cad-vp-pop-title",children:"Section view"}),o?Ae(Ai,{children:[k(js,{name:"Section plane",value:o.plane,options:V0,onChange:p}),Ae("label",{className:"cad-vp-row",children:[k("span",{children:"Cut at"}),k("input",{type:"range",min:u?u[0]:-100,max:u?u[1]:100,step:u?ip(u[1]-u[0]):.5,value:o.offset*d.sign,"aria-label":`Section position along ${d.label}`,"data-section-offset":"1",onChange:v=>n.setSection({offset:Number(v.target.value)*d.sign})}),Ae("span",{className:"cad-vp-num","data-section-value":"1",children:[d.label," ",H0(o.offset*d.sign)," mm"]})]}),k("div",{className:"cad-vp-row",children:k("button",{type:"button",className:"cad-vp-small","data-section-flip":"1",onClick:()=>n.setSection({flip:!o.flip}),children:"Flip side"})})]}):null]})]}),Ae("div",{className:"cad-vp-tool",children:[k("button",{type:"button",className:"cad-vp-btn",title:"Views","aria-label":"Views","aria-expanded":t==="views","data-vp-opens":"views",onClick:()=>c("views"),children:k(Qs,{paths:Js.views})}),Ae(qo,{open:t==="views",onClose:l,label:"Views",id:"views",children:[np.map(v=>Ae("button",{type:"button",className:"cad-vp-item","data-view":v.view,onClick:()=>m(v.view),children:[k("span",{children:v.label}),k("kbd",{children:v.shortcut})]},v.view)),k("div",{className:"cad-vp-sep"}),Ae("button",{type:"button",className:"cad-vp-item","data-view":"normal-to",disabled:!h||"reason"in h,title:h&&"reason"in h?h.reason:void 0,onClick:()=>{h&&!("reason"in h)&&n.lookAt(h.normal,h.up),l()},children:[k("span",{children:"Normal to"}),k("kbd",{children:"N"})]}),h&&"reason"in h?k("div",{className:"cad-vp-pop-hint",children:h.reason}):null,k("div",{className:"cad-vp-sep"}),k("div",{className:"cad-vp-pop-title",children:"Projection"}),k(js,{name:"Projection",value:r.projection,options:[{value:"perspective",label:"Perspective"},{value:"orthographic",label:"Orthographic"}],onChange:v=>n.setProjection(v)}),k("div",{className:"cad-vp-pop-title",children:"Display"}),k(js,{name:"Display",value:r.display,options:[{value:"shaded-edges",label:"Shaded + edges"},{value:"shaded",label:"Shaded"},{value:"wireframe",label:"Wireframe"}],onChange:v=>n.setDisplay(v)}),k("div",{className:"cad-vp-pop-title",children:"Origin planes"}),k(js,{name:"Origin planes",value:r.planes,options:[{value:"auto",label:"Auto"},{value:"always",label:"Always"}],onChange:v=>n.setPlanes(v)}),k("div",{className:"cad-vp-pop-hint",children:r.planes==="always"?"Top, Front and Right are always drawn.":"Drawn on an empty part, and while one is selected or hovered."})]})]}),k("button",{type:"button",className:"cad-vp-btn",title:"Fit model to viewport","aria-label":"Fit model to viewport","data-vp-fit":"1",onClick:()=>n.setView("home"),children:k(Qs,{paths:Js.home})}),Ae("div",{className:"cad-vp-axes-key",title:"Axis colours of the triad",children:[k("span",{className:"ax ax-x",children:"X"}),k("span",{className:"ax ax-y",children:"Y"}),k("span",{className:"ax ax-z",children:"Z"})]})]}),k("div",{className:"cad-vp-triad-slot","data-triad-slot":"1","aria-hidden":"true"})]})}const Vs="186",$0=0,bf=1,X0=2,ja=1,q0=2,ws=3,li=0,fn=1,Mn=2,wi=0,Rs=1,Sf=2,Mf=3,wf=4,Y0=5,$r=100,K0=101,Z0=102,J0=103,Q0=104,j0=200,e_=201,t_=202,n_=203,rp=204,sp=205,i_=206,r_=207,s_=208,a_=209,o_=210,l_=211,c_=212,u_=213,f_=214,ic=0,rc=1,sc=2,Jr=3,ac=4,oc=5,lc=6,cc=7,ap=0,d_=1,h_=2,oi=0,op=1,lp=2,cp=3,up=4,fp=5,dp=6,hp=7,pp=300,pr=301,Qr=302,Ko=303,Zo=304,Io=306,uc=1e3,Si=1001,fc=1002,rn=1003,p_=1004,ea=1005,ln=1006,Jo=1007,fr=1008,Bn=1009,mp=1010,gp=1011,Is=1012,xu=1013,ci=1014,si=1015,ui=1016,yu=1017,bu=1018,Us=1020,_p=35902,vp=35899,xp=1021,yp=1022,$n=1023,Ci=1026,dr=1027,bp=1028,Su=1029,mr=1030,Mu=1031,wu=1033,eo=33776,to=33777,no=33778,io=33779,dc=35840,hc=35841,pc=35842,mc=35843,gc=36196,_c=37492,vc=37496,xc=37488,yc=37489,xo=37490,bc=37491,Sc=37808,Mc=37809,wc=37810,Ec=37811,Tc=37812,Ac=37813,Rc=37814,Cc=37815,Pc=37816,Lc=37817,Dc=37818,Nc=37819,Ic=37820,Uc=37821,Fc=36492,Bc=36494,Oc=36495,kc=36283,zc=36284,yo=36285,Vc=36286,m_=3200,Ef=0,g_=1,Gi="",Un="srgb",bo="srgb-linear",So="linear",mt="srgb",Qo=7680,jo=7681,__=34055,v_=34056,x_=517,Sp=519,y_=512,b_=513,S_=514,Eu=515,M_=516,w_=517,Tu=518,E_=519,Mp=35044,Tf="300 es",ai=2e3,Mo=2001;function T_(n){for(let e=n.length-1;e>=0;--e)if(n[e]>=65535)return!0;return!1}function wo(n){return document.createElementNS("http://www.w3.org/1999/xhtml",n)}function A_(){const n=wo("canvas");return n.style.display="block",n}const Af={};function Eo(...n){const e="THREE."+n.shift();console.log(e,...n)}function wp(n){const e=n[0];if(typeof e=="string"&&e.startsWith("TSL:")){const t=n[1];t&&t.isStackTrace?n[0]+=" "+t.getLocation():n[1]='Stack trace not available. Enable "THREE.Node.captureStackTrace" to capture stack traces.'}return n}function ze(...n){n=wp(n);const e="THREE."+n.shift();{const t=n[0];t&&t.isStackTrace?console.warn(t.getError(e)):console.warn(e,...n)}}function ut(...n){n=wp(n);const e="THREE."+n.shift();{const t=n[0];t&&t.isStackTrace?console.error(t.getError(e)):console.error(e,...n)}}function Kr(...n){const e=n.join(" ");e in Af||(Af[e]=!0,ze(...n))}function R_(n,e,t){return new Promise(function(i,r){function s(){switch(n.clientWaitSync(e,n.SYNC_FLUSH_COMMANDS_BIT,0)){case n.WAIT_FAILED:r();break;case n.TIMEOUT_EXPIRED:setTimeout(s,t);break;default:i()}}setTimeout(s,t)})}const C_={[ic]:rc,[sc]:lc,[ac]:cc,[Jr]:oc,[rc]:ic,[lc]:sc,[cc]:ac,[oc]:Jr};class vr{addEventListener(e,t){this._listeners===void 0&&(this._listeners={});const i=this._listeners;i[e]===void 0&&(i[e]=[]),i[e].indexOf(t)===-1&&i[e].push(t)}hasEventListener(e,t){const i=this._listeners;return i===void 0?!1:i[e]!==void 0&&i[e].indexOf(t)!==-1}removeEventListener(e,t){const i=this._listeners;if(i===void 0)return;const r=i[e];if(r!==void 0){const s=r.indexOf(t);s!==-1&&r.splice(s,1)}}dispatchEvent(e){const t=this._listeners;if(t===void 0)return;const i=t[e.type];if(i!==void 0){e.target=this;const r=i.slice(0);for(let s=0,a=r.length;s<a;s++)r[s].call(this,e);e.target=null}}}const an=["00","01","02","03","04","05","06","07","08","09","0a","0b","0c","0d","0e","0f","10","11","12","13","14","15","16","17","18","19","1a","1b","1c","1d","1e","1f","20","21","22","23","24","25","26","27","28","29","2a","2b","2c","2d","2e","2f","30","31","32","33","34","35","36","37","38","39","3a","3b","3c","3d","3e","3f","40","41","42","43","44","45","46","47","48","49","4a","4b","4c","4d","4e","4f","50","51","52","53","54","55","56","57","58","59","5a","5b","5c","5d","5e","5f","60","61","62","63","64","65","66","67","68","69","6a","6b","6c","6d","6e","6f","70","71","72","73","74","75","76","77","78","79","7a","7b","7c","7d","7e","7f","80","81","82","83","84","85","86","87","88","89","8a","8b","8c","8d","8e","8f","90","91","92","93","94","95","96","97","98","99","9a","9b","9c","9d","9e","9f","a0","a1","a2","a3","a4","a5","a6","a7","a8","a9","aa","ab","ac","ad","ae","af","b0","b1","b2","b3","b4","b5","b6","b7","b8","b9","ba","bb","bc","bd","be","bf","c0","c1","c2","c3","c4","c5","c6","c7","c8","c9","ca","cb","cc","cd","ce","cf","d0","d1","d2","d3","d4","d5","d6","d7","d8","d9","da","db","dc","dd","de","df","e0","e1","e2","e3","e4","e5","e6","e7","e8","e9","ea","eb","ec","ed","ee","ef","f0","f1","f2","f3","f4","f5","f6","f7","f8","f9","fa","fb","fc","fd","fe","ff"];let Rf=1234567;const Cs=Math.PI/180,Fs=180/Math.PI;function Ei(){const n=Math.random()*4294967295|0,e=Math.random()*4294967295|0,t=Math.random()*4294967295|0,i=Math.random()*4294967295|0;return(an[n&255]+an[n>>8&255]+an[n>>16&255]+an[n>>24&255]+"-"+an[e&255]+an[e>>8&255]+"-"+an[e>>16&15|64]+an[e>>24&255]+"-"+an[t&63|128]+an[t>>8&255]+"-"+an[t>>16&255]+an[t>>24&255]+an[i&255]+an[i>>8&255]+an[i>>16&255]+an[i>>24&255]).toLowerCase()}function Ye(n,e,t){return Math.max(e,Math.min(t,n))}function Au(n,e){return(n%e+e)%e}function P_(n,e,t,i,r){return i+(n-e)*(r-i)/(t-e)}function L_(n,e,t){return n!==e?(t-n)/(e-n):0}function Ps(n,e,t){return(1-t)*n+t*e}function D_(n,e,t,i){return Ps(n,e,1-Math.exp(-t*i))}function N_(n,e=1){return e-Math.abs(Au(n,e*2)-e)}function I_(n,e,t){return n<=e?0:n>=t?1:(n=(n-e)/(t-e),n*n*(3-2*n))}function U_(n,e,t){return n<=e?0:n>=t?1:(n=(n-e)/(t-e),n*n*n*(n*(n*6-15)+10))}function F_(n,e){return n+Math.floor(Math.random()*(e-n+1))}function B_(n,e){return n+Math.random()*(e-n)}function O_(n){return n*(.5-Math.random())}function k_(n){n!==void 0&&(Rf=n);let e=Rf+=1831565813;return e=Math.imul(e^e>>>15,e|1),e^=e+Math.imul(e^e>>>7,e|61),((e^e>>>14)>>>0)/4294967296}function z_(n){return n*Cs}function V_(n){return n*Fs}function H_(n){return n>0&&Number.isInteger(n)&&2**Math.round(Math.log2(n))===n}function G_(n){return Math.pow(2,Math.ceil(Math.log(n)/Math.LN2))}function W_(n){return Math.pow(2,Math.floor(Math.log(n)/Math.LN2))}function $_(n,e,t,i,r){const s=Math.cos,a=Math.sin,o=s(t/2),l=a(t/2),c=s((e+i)/2),f=a((e+i)/2),d=s((e-i)/2),u=a((e-i)/2),h=s((i-e)/2),_=a((i-e)/2);switch(r){case"XYX":n.set(o*f,l*d,l*u,o*c);break;case"YZY":n.set(l*u,o*f,l*d,o*c);break;case"ZXZ":n.set(l*d,l*u,o*f,o*c);break;case"XZX":n.set(o*f,l*_,l*h,o*c);break;case"YXY":n.set(l*h,o*f,l*_,o*c);break;case"ZYZ":n.set(l*_,l*h,o*f,o*c);break;default:ze("MathUtils: .setQuaternionFromProperEuler() encountered an unknown order: "+r)}}function Gn(n,e){switch(e.constructor){case Float32Array:return n;case Uint32Array:return n/4294967295;case Uint16Array:return n/65535;case Uint8Array:case Uint8ClampedArray:return n/255;case Int32Array:return Math.max(n/2147483647,-1);case Int16Array:return Math.max(n/32767,-1);case Int8Array:return Math.max(n/127,-1);default:throw new Error("THREE.MathUtils: Invalid component type.")}}function gt(n,e){switch(e.constructor){case Float32Array:return n;case Uint32Array:return Math.round(n*4294967295);case Uint16Array:return Math.round(n*65535);case Uint8Array:case Uint8ClampedArray:return Math.round(n*255);case Int32Array:return Math.round(n*2147483647);case Int16Array:return Math.round(n*32767);case Int8Array:return Math.round(n*127);default:throw new Error("THREE.MathUtils: Invalid component type.")}}const X_={DEG2RAD:Cs,RAD2DEG:Fs,generateUUID:Ei,clamp:Ye,euclideanModulo:Au,mapLinear:P_,inverseLerp:L_,lerp:Ps,damp:D_,pingpong:N_,smoothstep:I_,smootherstep:U_,randInt:F_,randFloat:B_,randFloatSpread:O_,seededRandom:k_,degToRad:z_,radToDeg:V_,isPowerOfTwo:H_,ceilPowerOfTwo:G_,floorPowerOfTwo:W_,setQuaternionFromProperEuler:$_,normalize:gt,denormalize:Gn};class Ze{static{Ze.prototype.isVector2=!0}constructor(e=0,t=0){this.x=e,this.y=t}get width(){return this.x}set width(e){this.x=e}get height(){return this.y}set height(e){this.y=e}set(e,t){return this.x=e,this.y=t,this}setScalar(e){return this.x=e,this.y=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setComponent(e,t){switch(e){case 0:this.x=t;break;case 1:this.y=t;break;default:throw new Error("THREE.Vector2: index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;default:throw new Error("THREE.Vector2: index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y)}copy(e){return this.x=e.x,this.y=e.y,this}add(e){return this.x+=e.x,this.y+=e.y,this}addScalar(e){return this.x+=e,this.y+=e,this}addVectors(e,t){return this.x=e.x+t.x,this.y=e.y+t.y,this}addScaledVector(e,t){return this.x+=e.x*t,this.y+=e.y*t,this}sub(e){return this.x-=e.x,this.y-=e.y,this}subScalar(e){return this.x-=e,this.y-=e,this}subVectors(e,t){return this.x=e.x-t.x,this.y=e.y-t.y,this}multiply(e){return this.x*=e.x,this.y*=e.y,this}multiplyScalar(e){return this.x*=e,this.y*=e,this}divide(e){return this.x/=e.x,this.y/=e.y,this}divideScalar(e){return this.multiplyScalar(1/e)}applyMatrix3(e){const t=this.x,i=this.y,r=e.elements;return this.x=r[0]*t+r[3]*i+r[6],this.y=r[1]*t+r[4]*i+r[7],this}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this}clamp(e,t){return this.x=Ye(this.x,e.x,t.x),this.y=Ye(this.y,e.y,t.y),this}clampScalar(e,t){return this.x=Ye(this.x,e,t),this.y=Ye(this.y,e,t),this}clampLength(e,t){const i=this.length();return this.divideScalar(i||1).multiplyScalar(Ye(i,e,t))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this}negate(){return this.x=-this.x,this.y=-this.y,this}dot(e){return this.x*e.x+this.y*e.y}cross(e){return this.x*e.y-this.y*e.x}lengthSq(){return this.x*this.x+this.y*this.y}length(){return Math.sqrt(this.x*this.x+this.y*this.y)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)}normalize(){return this.divideScalar(this.length()||1)}angle(){return Math.atan2(-this.y,-this.x)+Math.PI}angleTo(e){const t=Math.sqrt(this.lengthSq()*e.lengthSq());if(t===0)return Math.PI/2;const i=this.dot(e)/t;return Math.acos(Ye(i,-1,1))}distanceTo(e){return Math.sqrt(this.distanceToSquared(e))}distanceToSquared(e){const t=this.x-e.x,i=this.y-e.y;return t*t+i*i}manhattanDistanceTo(e){return Math.abs(this.x-e.x)+Math.abs(this.y-e.y)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,t){return this.x+=(e.x-this.x)*t,this.y+=(e.y-this.y)*t,this}lerpVectors(e,t,i){return this.x=e.x+(t.x-e.x)*i,this.y=e.y+(t.y-e.y)*i,this}equals(e){return e.x===this.x&&e.y===this.y}fromArray(e,t=0){return this.x=e[t],this.y=e[t+1],this}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e}fromBufferAttribute(e,t){return this.x=e.getX(t),this.y=e.getY(t),this}rotateAround(e,t){const i=Math.cos(t),r=Math.sin(t),s=this.x-e.x,a=this.y-e.y;return this.x=s*i-a*r+e.x,this.y=s*r+a*i+e.y,this}random(){return this.x=Math.random(),this.y=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y}}class Xn{constructor(e=0,t=0,i=0,r=1){this.isQuaternion=!0,this._x=e,this._y=t,this._z=i,this._w=r}static slerpFlat(e,t,i,r,s,a,o){let l=i[r+0],c=i[r+1],f=i[r+2],d=i[r+3],u=s[a+0],h=s[a+1],_=s[a+2],g=s[a+3];if(d!==g||l!==u||c!==h||f!==_){let p=l*u+c*h+f*_+d*g;p<0&&(u=-u,h=-h,_=-_,g=-g,p=-p);let m=1-o;if(p<.9995){const v=Math.acos(p),w=Math.sin(v);m=Math.sin(m*v)/w,o=Math.sin(o*v)/w,l=l*m+u*o,c=c*m+h*o,f=f*m+_*o,d=d*m+g*o}else{l=l*m+u*o,c=c*m+h*o,f=f*m+_*o,d=d*m+g*o;const v=1/Math.sqrt(l*l+c*c+f*f+d*d);l*=v,c*=v,f*=v,d*=v}}e[t]=l,e[t+1]=c,e[t+2]=f,e[t+3]=d}static multiplyQuaternionsFlat(e,t,i,r,s,a){const o=i[r],l=i[r+1],c=i[r+2],f=i[r+3],d=s[a],u=s[a+1],h=s[a+2],_=s[a+3];return e[t]=o*_+f*d+l*h-c*u,e[t+1]=l*_+f*u+c*d-o*h,e[t+2]=c*_+f*h+o*u-l*d,e[t+3]=f*_-o*d-l*u-c*h,e}get x(){return this._x}set x(e){this._x=e,this._onChangeCallback()}get y(){return this._y}set y(e){this._y=e,this._onChangeCallback()}get z(){return this._z}set z(e){this._z=e,this._onChangeCallback()}get w(){return this._w}set w(e){this._w=e,this._onChangeCallback()}set(e,t,i,r){return this._x=e,this._y=t,this._z=i,this._w=r,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._w)}copy(e){return this._x=e.x,this._y=e.y,this._z=e.z,this._w=e.w,this._onChangeCallback(),this}setFromEuler(e,t=!0){const i=e._x,r=e._y,s=e._z,a=e._order,o=Math.cos,l=Math.sin,c=o(i/2),f=o(r/2),d=o(s/2),u=l(i/2),h=l(r/2),_=l(s/2);switch(a){case"XYZ":this._x=u*f*d+c*h*_,this._y=c*h*d-u*f*_,this._z=c*f*_+u*h*d,this._w=c*f*d-u*h*_;break;case"YXZ":this._x=u*f*d+c*h*_,this._y=c*h*d-u*f*_,this._z=c*f*_-u*h*d,this._w=c*f*d+u*h*_;break;case"ZXY":this._x=u*f*d-c*h*_,this._y=c*h*d+u*f*_,this._z=c*f*_+u*h*d,this._w=c*f*d-u*h*_;break;case"ZYX":this._x=u*f*d-c*h*_,this._y=c*h*d+u*f*_,this._z=c*f*_-u*h*d,this._w=c*f*d+u*h*_;break;case"YZX":this._x=u*f*d+c*h*_,this._y=c*h*d+u*f*_,this._z=c*f*_-u*h*d,this._w=c*f*d-u*h*_;break;case"XZY":this._x=u*f*d-c*h*_,this._y=c*h*d-u*f*_,this._z=c*f*_+u*h*d,this._w=c*f*d+u*h*_;break;default:ze("Quaternion: .setFromEuler() encountered an unknown order: "+a)}return t===!0&&this._onChangeCallback(),this}setFromAxisAngle(e,t){const i=t/2,r=Math.sin(i);return this._x=e.x*r,this._y=e.y*r,this._z=e.z*r,this._w=Math.cos(i),this._onChangeCallback(),this}setFromRotationMatrix(e){const t=e.elements,i=t[0],r=t[4],s=t[8],a=t[1],o=t[5],l=t[9],c=t[2],f=t[6],d=t[10],u=i+o+d;if(u>0){const h=.5/Math.sqrt(u+1);this._w=.25/h,this._x=(f-l)*h,this._y=(s-c)*h,this._z=(a-r)*h}else if(i>o&&i>d){const h=2*Math.sqrt(1+i-o-d);this._w=(f-l)/h,this._x=.25*h,this._y=(r+a)/h,this._z=(s+c)/h}else if(o>d){const h=2*Math.sqrt(1+o-i-d);this._w=(s-c)/h,this._x=(r+a)/h,this._y=.25*h,this._z=(l+f)/h}else{const h=2*Math.sqrt(1+d-i-o);this._w=(a-r)/h,this._x=(s+c)/h,this._y=(l+f)/h,this._z=.25*h}return this._onChangeCallback(),this}setFromUnitVectors(e,t){let i=e.dot(t)+1;return i<1e-8?(i=0,Math.abs(e.x)>Math.abs(e.z)?(this._x=-e.y,this._y=e.x,this._z=0,this._w=i):(this._x=0,this._y=-e.z,this._z=e.y,this._w=i)):(this._x=e.y*t.z-e.z*t.y,this._y=e.z*t.x-e.x*t.z,this._z=e.x*t.y-e.y*t.x,this._w=i),this.normalize()}angleTo(e){return 2*Math.acos(Math.abs(Ye(this.dot(e),-1,1)))}rotateTowards(e,t){const i=this.angleTo(e);if(i===0)return this;const r=Math.min(1,t/i);return this.slerp(e,r),this}identity(){return this.set(0,0,0,1)}invert(){return this.conjugate()}conjugate(){return this._x*=-1,this._y*=-1,this._z*=-1,this._onChangeCallback(),this}dot(e){return this._x*e._x+this._y*e._y+this._z*e._z+this._w*e._w}lengthSq(){return this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w}length(){return Math.sqrt(this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w)}normalize(){let e=this.length();return e===0?(this._x=0,this._y=0,this._z=0,this._w=1):(e=1/e,this._x=this._x*e,this._y=this._y*e,this._z=this._z*e,this._w=this._w*e),this._onChangeCallback(),this}multiply(e){return this.multiplyQuaternions(this,e)}premultiply(e){return this.multiplyQuaternions(e,this)}multiplyQuaternions(e,t){const i=e._x,r=e._y,s=e._z,a=e._w,o=t._x,l=t._y,c=t._z,f=t._w;return this._x=i*f+a*o+r*c-s*l,this._y=r*f+a*l+s*o-i*c,this._z=s*f+a*c+i*l-r*o,this._w=a*f-i*o-r*l-s*c,this._onChangeCallback(),this}slerp(e,t){let i=e._x,r=e._y,s=e._z,a=e._w,o=this.dot(e);o<0&&(i=-i,r=-r,s=-s,a=-a,o=-o);let l=1-t;if(o<.9995){const c=Math.acos(o),f=Math.sin(c);l=Math.sin(l*c)/f,t=Math.sin(t*c)/f,this._x=this._x*l+i*t,this._y=this._y*l+r*t,this._z=this._z*l+s*t,this._w=this._w*l+a*t,this._onChangeCallback()}else this._x=this._x*l+i*t,this._y=this._y*l+r*t,this._z=this._z*l+s*t,this._w=this._w*l+a*t,this.normalize();return this}slerpQuaternions(e,t,i){return this.copy(e).slerp(t,i)}random(){const e=2*Math.PI*Math.random(),t=2*Math.PI*Math.random(),i=Math.random(),r=Math.sqrt(1-i),s=Math.sqrt(i);return this.set(r*Math.sin(e),r*Math.cos(e),s*Math.sin(t),s*Math.cos(t))}equals(e){return e._x===this._x&&e._y===this._y&&e._z===this._z&&e._w===this._w}fromArray(e,t=0){return this._x=e[t],this._y=e[t+1],this._z=e[t+2],this._w=e[t+3],this._onChangeCallback(),this}toArray(e=[],t=0){return e[t]=this._x,e[t+1]=this._y,e[t+2]=this._z,e[t+3]=this._w,e}fromBufferAttribute(e,t){return this._x=e.getX(t),this._y=e.getY(t),this._z=e.getZ(t),this._w=e.getW(t),this._onChangeCallback(),this}toJSON(){return this.toArray()}_onChange(e){return this._onChangeCallback=e,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._w}}class U{static{U.prototype.isVector3=!0}constructor(e=0,t=0,i=0){this.x=e,this.y=t,this.z=i}set(e,t,i){return i===void 0&&(i=this.z),this.x=e,this.y=t,this.z=i,this}setScalar(e){return this.x=e,this.y=e,this.z=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setZ(e){return this.z=e,this}setComponent(e,t){switch(e){case 0:this.x=t;break;case 1:this.y=t;break;case 2:this.z=t;break;default:throw new Error("THREE.Vector3: index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;case 2:return this.z;default:throw new Error("THREE.Vector3: index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y,this.z)}copy(e){return this.x=e.x,this.y=e.y,this.z=e.z,this}add(e){return this.x+=e.x,this.y+=e.y,this.z+=e.z,this}addScalar(e){return this.x+=e,this.y+=e,this.z+=e,this}addVectors(e,t){return this.x=e.x+t.x,this.y=e.y+t.y,this.z=e.z+t.z,this}addScaledVector(e,t){return this.x+=e.x*t,this.y+=e.y*t,this.z+=e.z*t,this}sub(e){return this.x-=e.x,this.y-=e.y,this.z-=e.z,this}subScalar(e){return this.x-=e,this.y-=e,this.z-=e,this}subVectors(e,t){return this.x=e.x-t.x,this.y=e.y-t.y,this.z=e.z-t.z,this}multiply(e){return this.x*=e.x,this.y*=e.y,this.z*=e.z,this}multiplyScalar(e){return this.x*=e,this.y*=e,this.z*=e,this}multiplyVectors(e,t){return this.x=e.x*t.x,this.y=e.y*t.y,this.z=e.z*t.z,this}applyEuler(e){return this.applyQuaternion(Cf.setFromEuler(e))}applyAxisAngle(e,t){return this.applyQuaternion(Cf.setFromAxisAngle(e,t))}applyMatrix3(e){const t=this.x,i=this.y,r=this.z,s=e.elements;return this.x=s[0]*t+s[3]*i+s[6]*r,this.y=s[1]*t+s[4]*i+s[7]*r,this.z=s[2]*t+s[5]*i+s[8]*r,this}applyNormalMatrix(e){return this.applyMatrix3(e).normalize()}applyMatrix4(e){const t=this.x,i=this.y,r=this.z,s=e.elements,a=1/(s[3]*t+s[7]*i+s[11]*r+s[15]);return this.x=(s[0]*t+s[4]*i+s[8]*r+s[12])*a,this.y=(s[1]*t+s[5]*i+s[9]*r+s[13])*a,this.z=(s[2]*t+s[6]*i+s[10]*r+s[14])*a,this}applyQuaternion(e){const t=this.x,i=this.y,r=this.z,s=e.x,a=e.y,o=e.z,l=e.w,c=2*(a*r-o*i),f=2*(o*t-s*r),d=2*(s*i-a*t);return this.x=t+l*c+a*d-o*f,this.y=i+l*f+o*c-s*d,this.z=r+l*d+s*f-a*c,this}project(e){return this.applyMatrix4(e.matrixWorldInverse).applyMatrix4(e.projectionMatrix)}unproject(e){return this.applyMatrix4(e.projectionMatrixInverse).applyMatrix4(e.matrixWorld)}transformDirection(e){const t=this.x,i=this.y,r=this.z,s=e.elements;return this.x=s[0]*t+s[4]*i+s[8]*r,this.y=s[1]*t+s[5]*i+s[9]*r,this.z=s[2]*t+s[6]*i+s[10]*r,this.normalize()}divide(e){return this.x/=e.x,this.y/=e.y,this.z/=e.z,this}divideScalar(e){return this.multiplyScalar(1/e)}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this.z=Math.min(this.z,e.z),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this.z=Math.max(this.z,e.z),this}clamp(e,t){return this.x=Ye(this.x,e.x,t.x),this.y=Ye(this.y,e.y,t.y),this.z=Ye(this.z,e.z,t.z),this}clampScalar(e,t){return this.x=Ye(this.x,e,t),this.y=Ye(this.y,e,t),this.z=Ye(this.z,e,t),this}clampLength(e,t){const i=this.length();return this.divideScalar(i||1).multiplyScalar(Ye(i,e,t))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this}dot(e){return this.x*e.x+this.y*e.y+this.z*e.z}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)}normalize(){return this.divideScalar(this.length()||1)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,t){return this.x+=(e.x-this.x)*t,this.y+=(e.y-this.y)*t,this.z+=(e.z-this.z)*t,this}lerpVectors(e,t,i){return this.x=e.x+(t.x-e.x)*i,this.y=e.y+(t.y-e.y)*i,this.z=e.z+(t.z-e.z)*i,this}cross(e){return this.crossVectors(this,e)}crossVectors(e,t){const i=e.x,r=e.y,s=e.z,a=t.x,o=t.y,l=t.z;return this.x=r*l-s*o,this.y=s*a-i*l,this.z=i*o-r*a,this}projectOnVector(e){const t=e.lengthSq();if(t===0)return this.set(0,0,0);const i=e.dot(this)/t;return this.copy(e).multiplyScalar(i)}projectOnPlane(e){return el.copy(this).projectOnVector(e),this.sub(el)}reflect(e){return this.sub(el.copy(e).multiplyScalar(2*this.dot(e)))}angleTo(e){const t=Math.sqrt(this.lengthSq()*e.lengthSq());if(t===0)return Math.PI/2;const i=this.dot(e)/t;return Math.acos(Ye(i,-1,1))}distanceTo(e){return Math.sqrt(this.distanceToSquared(e))}distanceToSquared(e){const t=this.x-e.x,i=this.y-e.y,r=this.z-e.z;return t*t+i*i+r*r}manhattanDistanceTo(e){return Math.abs(this.x-e.x)+Math.abs(this.y-e.y)+Math.abs(this.z-e.z)}setFromSpherical(e){return this.setFromSphericalCoords(e.radius,e.phi,e.theta)}setFromSphericalCoords(e,t,i){const r=Math.sin(t)*e;return this.x=r*Math.sin(i),this.y=Math.cos(t)*e,this.z=r*Math.cos(i),this}setFromCylindrical(e){return this.setFromCylindricalCoords(e.radius,e.theta,e.y)}setFromCylindricalCoords(e,t,i){return this.x=e*Math.sin(t),this.y=i,this.z=e*Math.cos(t),this}setFromMatrixPosition(e){const t=e.elements;return this.x=t[12],this.y=t[13],this.z=t[14],this}setFromMatrixScale(e){const t=this.setFromMatrixColumn(e,0).length(),i=this.setFromMatrixColumn(e,1).length(),r=this.setFromMatrixColumn(e,2).length();return this.x=t,this.y=i,this.z=r,this}setFromMatrixColumn(e,t){return this.fromArray(e.elements,t*4)}setFromMatrix3Column(e,t){return this.fromArray(e.elements,t*3)}setFromEuler(e){return this.x=e._x,this.y=e._y,this.z=e._z,this}setFromColor(e){return this.x=e.r,this.y=e.g,this.z=e.b,this}equals(e){return e.x===this.x&&e.y===this.y&&e.z===this.z}fromArray(e,t=0){return this.x=e[t],this.y=e[t+1],this.z=e[t+2],this}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e[t+2]=this.z,e}fromBufferAttribute(e,t){return this.x=e.getX(t),this.y=e.getY(t),this.z=e.getZ(t),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this}randomDirection(){const e=Math.random()*Math.PI*2,t=Math.random()*2-1,i=Math.sqrt(1-t*t);return this.x=i*Math.cos(e),this.y=t,this.z=i*Math.sin(e),this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z}}const el=new U,Cf=new Xn;class We{static{We.prototype.isMatrix3=!0}constructor(e,t,i,r,s,a,o,l,c){this.elements=[1,0,0,0,1,0,0,0,1],e!==void 0&&this.set(e,t,i,r,s,a,o,l,c)}set(e,t,i,r,s,a,o,l,c){const f=this.elements;return f[0]=e,f[1]=r,f[2]=o,f[3]=t,f[4]=s,f[5]=l,f[6]=i,f[7]=a,f[8]=c,this}identity(){return this.set(1,0,0,0,1,0,0,0,1),this}copy(e){const t=this.elements,i=e.elements;return t[0]=i[0],t[1]=i[1],t[2]=i[2],t[3]=i[3],t[4]=i[4],t[5]=i[5],t[6]=i[6],t[7]=i[7],t[8]=i[8],this}extractBasis(e,t,i){return e.setFromMatrix3Column(this,0),t.setFromMatrix3Column(this,1),i.setFromMatrix3Column(this,2),this}setFromMatrix4(e){const t=e.elements;return this.set(t[0],t[4],t[8],t[1],t[5],t[9],t[2],t[6],t[10]),this}multiply(e){return this.multiplyMatrices(this,e)}premultiply(e){return this.multiplyMatrices(e,this)}multiplyMatrices(e,t){const i=e.elements,r=t.elements,s=this.elements,a=i[0],o=i[3],l=i[6],c=i[1],f=i[4],d=i[7],u=i[2],h=i[5],_=i[8],g=r[0],p=r[3],m=r[6],v=r[1],w=r[4],y=r[7],S=r[2],M=r[5],E=r[8];return s[0]=a*g+o*v+l*S,s[3]=a*p+o*w+l*M,s[6]=a*m+o*y+l*E,s[1]=c*g+f*v+d*S,s[4]=c*p+f*w+d*M,s[7]=c*m+f*y+d*E,s[2]=u*g+h*v+_*S,s[5]=u*p+h*w+_*M,s[8]=u*m+h*y+_*E,this}multiplyScalar(e){const t=this.elements;return t[0]*=e,t[3]*=e,t[6]*=e,t[1]*=e,t[4]*=e,t[7]*=e,t[2]*=e,t[5]*=e,t[8]*=e,this}determinant(){const e=this.elements,t=e[0],i=e[1],r=e[2],s=e[3],a=e[4],o=e[5],l=e[6],c=e[7],f=e[8];return t*a*f-t*o*c-i*s*f+i*o*l+r*s*c-r*a*l}invert(){const e=this.elements,t=e[0],i=e[1],r=e[2],s=e[3],a=e[4],o=e[5],l=e[6],c=e[7],f=e[8],d=f*a-o*c,u=o*l-f*s,h=c*s-a*l,_=t*d+i*u+r*h;if(_===0)return this.set(0,0,0,0,0,0,0,0,0);const g=1/_;return e[0]=d*g,e[1]=(r*c-f*i)*g,e[2]=(o*i-r*a)*g,e[3]=u*g,e[4]=(f*t-r*l)*g,e[5]=(r*s-o*t)*g,e[6]=h*g,e[7]=(i*l-c*t)*g,e[8]=(a*t-i*s)*g,this}transpose(){let e;const t=this.elements;return e=t[1],t[1]=t[3],t[3]=e,e=t[2],t[2]=t[6],t[6]=e,e=t[5],t[5]=t[7],t[7]=e,this}getNormalMatrix(e){return this.setFromMatrix4(e).invert().transpose()}transposeIntoArray(e){const t=this.elements;return e[0]=t[0],e[1]=t[3],e[2]=t[6],e[3]=t[1],e[4]=t[4],e[5]=t[7],e[6]=t[2],e[7]=t[5],e[8]=t[8],this}setUvTransform(e,t,i,r,s,a,o){const l=Math.cos(s),c=Math.sin(s);return this.set(i*l,i*c,-i*(l*a+c*o)+a+e,-r*c,r*l,-r*(-c*a+l*o)+o+t,0,0,1),this}scale(e,t){return Kr("Matrix3: .scale() is deprecated. Use .makeScale() instead."),this.premultiply(tl.makeScale(e,t)),this}rotate(e){return Kr("Matrix3: .rotate() is deprecated. Use .makeRotation() instead."),this.premultiply(tl.makeRotation(-e)),this}translate(e,t){return Kr("Matrix3: .translate() is deprecated. Use .makeTranslation() instead."),this.premultiply(tl.makeTranslation(e,t)),this}makeTranslation(e,t){return e.isVector2?this.set(1,0,e.x,0,1,e.y,0,0,1):this.set(1,0,e,0,1,t,0,0,1),this}makeRotation(e){const t=Math.cos(e),i=Math.sin(e);return this.set(t,-i,0,i,t,0,0,0,1),this}makeScale(e,t){return this.set(e,0,0,0,t,0,0,0,1),this}equals(e){const t=this.elements,i=e.elements;for(let r=0;r<9;r++)if(t[r]!==i[r])return!1;return!0}fromArray(e,t=0){for(let i=0;i<9;i++)this.elements[i]=e[i+t];return this}toArray(e=[],t=0){const i=this.elements;return e[t]=i[0],e[t+1]=i[1],e[t+2]=i[2],e[t+3]=i[3],e[t+4]=i[4],e[t+5]=i[5],e[t+6]=i[6],e[t+7]=i[7],e[t+8]=i[8],e}clone(){return new this.constructor().fromArray(this.elements)}}const tl=new We,Pf=new We().set(.4123908,.3575843,.1804808,.212639,.7151687,.0721923,.0193308,.1191948,.9505322),Lf=new We().set(3.2409699,-1.5373832,-.4986108,-.9692436,1.8759675,.0415551,.0556301,-.203977,1.0569715);function q_(){const n={enabled:!0,workingColorSpace:bo,spaces:{},convert:function(r,s,a){return this.enabled===!1||s===a||!s||!a||(this.spaces[s].transfer===mt&&(r.r=Ti(r.r),r.g=Ti(r.g),r.b=Ti(r.b)),this.spaces[s].primaries!==this.spaces[a].primaries&&(r.applyMatrix3(this.spaces[s].toXYZ),r.applyMatrix3(this.spaces[a].fromXYZ)),this.spaces[a].transfer===mt&&(r.r=Zr(r.r),r.g=Zr(r.g),r.b=Zr(r.b))),r},workingToColorSpace:function(r,s){return this.convert(r,this.workingColorSpace,s)},colorSpaceToWorking:function(r,s){return this.convert(r,s,this.workingColorSpace)},getPrimaries:function(r){return this.spaces[r].primaries},getTransfer:function(r){return r===Gi?So:this.spaces[r].transfer},getToneMappingMode:function(r){return this.spaces[r].outputColorSpaceConfig.toneMappingMode||"standard"},getLuminanceCoefficients:function(r,s=this.workingColorSpace){return r.fromArray(this.spaces[s].luminanceCoefficients)},define:function(r){Object.assign(this.spaces,r)},_getMatrix:function(r,s,a){return r.copy(this.spaces[s].toXYZ).multiply(this.spaces[a].fromXYZ)},_getDrawingBufferColorSpace:function(r){return this.spaces[r].outputColorSpaceConfig.drawingBufferColorSpace},_getUnpackColorSpace:function(r=this.workingColorSpace){return this.spaces[r].workingColorSpaceConfig.unpackColorSpace},fromWorkingColorSpace:function(r,s){return Kr("ColorManagement: .fromWorkingColorSpace() has been renamed to .workingToColorSpace()."),n.workingToColorSpace(r,s)},toWorkingColorSpace:function(r,s){return Kr("ColorManagement: .toWorkingColorSpace() has been renamed to .colorSpaceToWorking()."),n.colorSpaceToWorking(r,s)}},e=[.64,.33,.3,.6,.15,.06],t=[.2126,.7152,.0722],i=[.3127,.329];return n.define({[bo]:{primaries:e,whitePoint:i,transfer:So,toXYZ:Pf,fromXYZ:Lf,luminanceCoefficients:t,workingColorSpaceConfig:{unpackColorSpace:Un},outputColorSpaceConfig:{drawingBufferColorSpace:Un}},[Un]:{primaries:e,whitePoint:i,transfer:mt,toXYZ:Pf,fromXYZ:Lf,luminanceCoefficients:t,outputColorSpaceConfig:{drawingBufferColorSpace:Un}}}),n}const at=q_();function Ti(n){return n<.04045?n*.0773993808:Math.pow(n*.9478672986+.0521327014,2.4)}function Zr(n){return n<.0031308?n*12.92:1.055*Math.pow(n,.41666)-.055}let Sr;class Y_{static getDataURL(e,t="image/png"){if(/^data:/i.test(e.src)||typeof HTMLCanvasElement>"u")return e.src;let i;if(e instanceof HTMLCanvasElement)i=e;else{Sr===void 0&&(Sr=wo("canvas")),Sr.width=e.width,Sr.height=e.height;const r=Sr.getContext("2d");e instanceof ImageData?r.putImageData(e,0,0):r.drawImage(e,0,0,e.width,e.height),i=Sr}return i.toDataURL(t)}static sRGBToLinear(e){if(typeof HTMLImageElement<"u"&&e instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&e instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&e instanceof ImageBitmap){const t=wo("canvas");t.width=e.width,t.height=e.height;const i=t.getContext("2d");i.drawImage(e,0,0,e.width,e.height);const r=i.getImageData(0,0,e.width,e.height),s=r.data;for(let a=0;a<s.length;a++)s[a]=Ti(s[a]/255)*255;return i.putImageData(r,0,0),t}else if(e.data){const t=e.data.slice(0);for(let i=0;i<t.length;i++)t instanceof Uint8Array||t instanceof Uint8ClampedArray?t[i]=Math.floor(Ti(t[i]/255)*255):t[i]=Ti(t[i]);return{data:t,width:e.width,height:e.height}}else return ze("ImageUtils.sRGBToLinear(): Unsupported image type. No color space conversion applied."),e}}let K_=0;class Ru{constructor(e=null){this.isTextureSource=!0,Object.defineProperty(this,"id",{value:K_++}),this.uuid=Ei(),this.data=e,this.dataReady=!0,this.version=0}getSize(e){const t=this.data;return typeof HTMLVideoElement<"u"&&t instanceof HTMLVideoElement?e.set(t.videoWidth,t.videoHeight,0):typeof VideoFrame<"u"&&t instanceof VideoFrame?e.set(t.displayWidth,t.displayHeight,0):t!==null?e.set(t.width,t.height,t.depth||0):e.set(0,0,0),e}set needsUpdate(e){e===!0&&this.version++}toJSON(e){const t=e===void 0||typeof e=="string";if(!t&&e.images[this.uuid]!==void 0)return e.images[this.uuid];const i={uuid:this.uuid,url:""},r=this.data;if(r!==null){let s;if(Array.isArray(r)){s=[];for(let a=0,o=r.length;a<o;a++)r[a].isDataTexture?s.push(nl(r[a].image)):s.push(nl(r[a]))}else s=nl(r);i.url=s}return t||(e.images[this.uuid]=i),i}}function nl(n){return typeof HTMLImageElement<"u"&&n instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&n instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&n instanceof ImageBitmap?Y_.getDataURL(n):n.data?{data:Array.from(n.data),width:n.width,height:n.height,type:n.data.constructor.name}:(ze("Texture: Unable to serialize Texture."),{})}let Z_=0;const il=new U;class vn extends vr{constructor(e=vn.DEFAULT_IMAGE,t=vn.DEFAULT_MAPPING,i=Si,r=Si,s=ln,a=fr,o=$n,l=Bn,c=vn.DEFAULT_ANISOTROPY,f=Gi){super(),this.isTexture=!0,Object.defineProperty(this,"id",{value:Z_++}),this.uuid=Ei(),this.name="",this.source=new Ru(e),this.mipmaps=[],this.mapping=t,this.channel=0,this.wrapS=i,this.wrapT=r,this.magFilter=s,this.minFilter=a,this.anisotropy=c,this.format=o,this.internalFormat=null,this.type=l,this.offset=new Ze(0,0),this.repeat=new Ze(1,1),this.center=new Ze(0,0),this.rotation=0,this.matrixAutoUpdate=!0,this.matrix=new We,this.generateMipmaps=!0,this.premultiplyAlpha=!1,this.flipY=!0,this.unpackAlignment=4,this.colorSpace=f,this.userData={},this.updateRanges=[],this.version=0,this.onUpdate=null,this.renderTarget=null,this.isRenderTargetTexture=!1,this.isArrayTexture=!!(e&&e.depth&&e.depth>1),this.pmremVersion=0,this.normalized=!1}get width(){return this.source.getSize(il).x}get height(){return this.source.getSize(il).y}get depth(){return this.source.getSize(il).z}get image(){return this.source.data}set image(e){this.source.data=e}updateMatrix(){this.matrix.setUvTransform(this.offset.x,this.offset.y,this.repeat.x,this.repeat.y,this.rotation,this.center.x,this.center.y)}addUpdateRange(e,t){this.updateRanges.push({start:e,count:t})}clearUpdateRanges(){this.updateRanges.length=0}clone(){return new this.constructor().copy(this)}copy(e){return this.name=e.name,this.source=e.source,this.mipmaps=e.mipmaps.slice(0),this.mapping=e.mapping,this.channel=e.channel,this.wrapS=e.wrapS,this.wrapT=e.wrapT,this.magFilter=e.magFilter,this.minFilter=e.minFilter,this.anisotropy=e.anisotropy,this.format=e.format,this.internalFormat=e.internalFormat,this.type=e.type,this.normalized=e.normalized,this.offset.copy(e.offset),this.repeat.copy(e.repeat),this.center.copy(e.center),this.rotation=e.rotation,this.matrixAutoUpdate=e.matrixAutoUpdate,this.matrix.copy(e.matrix),this.generateMipmaps=e.generateMipmaps,this.premultiplyAlpha=e.premultiplyAlpha,this.flipY=e.flipY,this.unpackAlignment=e.unpackAlignment,this.colorSpace=e.colorSpace,this.renderTarget=e.renderTarget,this.isRenderTargetTexture=e.isRenderTargetTexture,this.isArrayTexture=e.isArrayTexture,this.userData=JSON.parse(JSON.stringify(e.userData)),this.needsUpdate=!0,this}setValues(e){for(const t in e){const i=e[t];if(i===void 0){ze(`Texture.setValues(): parameter '${t}' has value of undefined.`);continue}const r=this[t];if(r===void 0){ze(`Texture.setValues(): property '${t}' does not exist.`);continue}r&&i&&r.isVector2&&i.isVector2||r&&i&&r.isVector3&&i.isVector3||r&&i&&r.isMatrix3&&i.isMatrix3?r.copy(i):this[t]=i}}toJSON(e){const t=e===void 0||typeof e=="string";if(!t&&e.textures[this.uuid]!==void 0)return e.textures[this.uuid];const i={metadata:{version:4.7,type:"Texture",generator:"Texture.toJSON"},uuid:this.uuid,name:this.name,image:this.source.toJSON(e).uuid,mapping:this.mapping,channel:this.channel,repeat:[this.repeat.x,this.repeat.y],offset:[this.offset.x,this.offset.y],center:[this.center.x,this.center.y],rotation:this.rotation,wrap:[this.wrapS,this.wrapT],format:this.format,internalFormat:this.internalFormat,type:this.type,normalized:this.normalized,colorSpace:this.colorSpace,minFilter:this.minFilter,magFilter:this.magFilter,anisotropy:this.anisotropy,flipY:this.flipY,generateMipmaps:this.generateMipmaps,premultiplyAlpha:this.premultiplyAlpha,unpackAlignment:this.unpackAlignment};return Object.keys(this.userData).length>0&&(i.userData=this.userData),t||(e.textures[this.uuid]=i),i}dispose(){this.dispatchEvent({type:"dispose"})}transformUv(e){if(this.mapping!==pp)return e;if(e.applyMatrix3(this.matrix),e.x<0||e.x>1)switch(this.wrapS){case uc:e.x=e.x-Math.floor(e.x);break;case Si:e.x=e.x<0?0:1;break;case fc:Math.abs(Math.floor(e.x)%2)===1?e.x=Math.ceil(e.x)-e.x:e.x=e.x-Math.floor(e.x);break}if(e.y<0||e.y>1)switch(this.wrapT){case uc:e.y=e.y-Math.floor(e.y);break;case Si:e.y=e.y<0?0:1;break;case fc:Math.abs(Math.floor(e.y)%2)===1?e.y=Math.ceil(e.y)-e.y:e.y=e.y-Math.floor(e.y);break}return this.flipY&&(e.y=1-e.y),e}set needsUpdate(e){e===!0&&(this.version++,this.source.needsUpdate=!0)}set needsPMREMUpdate(e){e===!0&&this.pmremVersion++}}vn.DEFAULT_IMAGE=null;vn.DEFAULT_MAPPING=pp;vn.DEFAULT_ANISOTROPY=1;class bt{static{bt.prototype.isVector4=!0}constructor(e=0,t=0,i=0,r=1){this.x=e,this.y=t,this.z=i,this.w=r}get width(){return this.z}set width(e){this.z=e}get height(){return this.w}set height(e){this.w=e}set(e,t,i,r){return this.x=e,this.y=t,this.z=i,this.w=r,this}setScalar(e){return this.x=e,this.y=e,this.z=e,this.w=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setZ(e){return this.z=e,this}setW(e){return this.w=e,this}setComponent(e,t){switch(e){case 0:this.x=t;break;case 1:this.y=t;break;case 2:this.z=t;break;case 3:this.w=t;break;default:throw new Error("THREE.Vector4: index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;case 2:return this.z;case 3:return this.w;default:throw new Error("THREE.Vector4: index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y,this.z,this.w)}copy(e){return this.x=e.x,this.y=e.y,this.z=e.z,this.w=e.w!==void 0?e.w:1,this}add(e){return this.x+=e.x,this.y+=e.y,this.z+=e.z,this.w+=e.w,this}addScalar(e){return this.x+=e,this.y+=e,this.z+=e,this.w+=e,this}addVectors(e,t){return this.x=e.x+t.x,this.y=e.y+t.y,this.z=e.z+t.z,this.w=e.w+t.w,this}addScaledVector(e,t){return this.x+=e.x*t,this.y+=e.y*t,this.z+=e.z*t,this.w+=e.w*t,this}sub(e){return this.x-=e.x,this.y-=e.y,this.z-=e.z,this.w-=e.w,this}subScalar(e){return this.x-=e,this.y-=e,this.z-=e,this.w-=e,this}subVectors(e,t){return this.x=e.x-t.x,this.y=e.y-t.y,this.z=e.z-t.z,this.w=e.w-t.w,this}multiply(e){return this.x*=e.x,this.y*=e.y,this.z*=e.z,this.w*=e.w,this}multiplyScalar(e){return this.x*=e,this.y*=e,this.z*=e,this.w*=e,this}applyMatrix4(e){const t=this.x,i=this.y,r=this.z,s=this.w,a=e.elements;return this.x=a[0]*t+a[4]*i+a[8]*r+a[12]*s,this.y=a[1]*t+a[5]*i+a[9]*r+a[13]*s,this.z=a[2]*t+a[6]*i+a[10]*r+a[14]*s,this.w=a[3]*t+a[7]*i+a[11]*r+a[15]*s,this}divide(e){return this.x/=e.x,this.y/=e.y,this.z/=e.z,this.w/=e.w,this}divideScalar(e){return this.multiplyScalar(1/e)}setAxisAngleFromQuaternion(e){this.w=2*Math.acos(e.w);const t=Math.sqrt(1-e.w*e.w);return t<1e-4?(this.x=1,this.y=0,this.z=0):(this.x=e.x/t,this.y=e.y/t,this.z=e.z/t),this}setAxisAngleFromRotationMatrix(e){let t,i,r,s;const l=e.elements,c=l[0],f=l[4],d=l[8],u=l[1],h=l[5],_=l[9],g=l[2],p=l[6],m=l[10];if(Math.abs(f-u)<.01&&Math.abs(d-g)<.01&&Math.abs(_-p)<.01){if(Math.abs(f+u)<.1&&Math.abs(d+g)<.1&&Math.abs(_+p)<.1&&Math.abs(c+h+m-3)<.1)return this.set(1,0,0,0),this;t=Math.PI;const w=(c+1)/2,y=(h+1)/2,S=(m+1)/2,M=(f+u)/4,E=(d+g)/4,b=(_+p)/4;return w>y&&w>S?w<.01?(i=0,r=.707106781,s=.707106781):(i=Math.sqrt(w),r=M/i,s=E/i):y>S?y<.01?(i=.707106781,r=0,s=.707106781):(r=Math.sqrt(y),i=M/r,s=b/r):S<.01?(i=.707106781,r=.707106781,s=0):(s=Math.sqrt(S),i=E/s,r=b/s),this.set(i,r,s,t),this}let v=Math.sqrt((p-_)*(p-_)+(d-g)*(d-g)+(u-f)*(u-f));return Math.abs(v)<.001&&(v=1),this.x=(p-_)/v,this.y=(d-g)/v,this.z=(u-f)/v,this.w=Math.acos((c+h+m-1)/2),this}setFromMatrixPosition(e){const t=e.elements;return this.x=t[12],this.y=t[13],this.z=t[14],this.w=t[15],this}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this.z=Math.min(this.z,e.z),this.w=Math.min(this.w,e.w),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this.z=Math.max(this.z,e.z),this.w=Math.max(this.w,e.w),this}clamp(e,t){return this.x=Ye(this.x,e.x,t.x),this.y=Ye(this.y,e.y,t.y),this.z=Ye(this.z,e.z,t.z),this.w=Ye(this.w,e.w,t.w),this}clampScalar(e,t){return this.x=Ye(this.x,e,t),this.y=Ye(this.y,e,t),this.z=Ye(this.z,e,t),this.w=Ye(this.w,e,t),this}clampLength(e,t){const i=this.length();return this.divideScalar(i||1).multiplyScalar(Ye(i,e,t))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this.w=Math.floor(this.w),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this.w=Math.ceil(this.w),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this.w=Math.round(this.w),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this.w=Math.trunc(this.w),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this.w=-this.w,this}dot(e){return this.x*e.x+this.y*e.y+this.z*e.z+this.w*e.w}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)+Math.abs(this.w)}normalize(){return this.divideScalar(this.length()||1)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,t){return this.x+=(e.x-this.x)*t,this.y+=(e.y-this.y)*t,this.z+=(e.z-this.z)*t,this.w+=(e.w-this.w)*t,this}lerpVectors(e,t,i){return this.x=e.x+(t.x-e.x)*i,this.y=e.y+(t.y-e.y)*i,this.z=e.z+(t.z-e.z)*i,this.w=e.w+(t.w-e.w)*i,this}equals(e){return e.x===this.x&&e.y===this.y&&e.z===this.z&&e.w===this.w}fromArray(e,t=0){return this.x=e[t],this.y=e[t+1],this.z=e[t+2],this.w=e[t+3],this}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e[t+2]=this.z,e[t+3]=this.w,e}fromBufferAttribute(e,t){return this.x=e.getX(t),this.y=e.getY(t),this.z=e.getZ(t),this.w=e.getW(t),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this.w=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z,yield this.w}}class J_ extends vr{constructor(e=1,t=1,i={}){super(),i=Object.assign({generateMipmaps:!1,internalFormat:null,minFilter:ln,depthBuffer:!0,stencilBuffer:!1,resolveColorBuffer:!0,resolveDepthBuffer:!0,resolveStencilBuffer:!0,storeMultisampledColorBuffer:!0,storeMultisampledDepthBuffer:!0,storeMultisampledStencilBuffer:!0,depthTexture:null,samples:0,count:1,depth:1,multiview:!1,useArrayDepthTexture:!1},i),this.isRenderTarget=!0,this.width=e,this.height=t,this.depth=i.depth,this.scissor=new bt(0,0,e,t),this.scissorTest=!1,this.viewport=new bt(0,0,e,t),this.textures=[];const r={width:e,height:t,depth:i.depth},s=new vn(r),a=i.count;for(let o=0;o<a;o++)this.textures[o]=s.clone(),this.textures[o].isRenderTargetTexture=!0,this.textures[o].renderTarget=this;this._setTextureOptions(i),this.depthBuffer=i.depthBuffer,this.stencilBuffer=i.stencilBuffer,this.resolveColorBuffer=i.resolveColorBuffer,this.resolveDepthBuffer=i.resolveDepthBuffer,this.resolveStencilBuffer=i.resolveStencilBuffer,this.storeMultisampledColorBuffer=i.storeMultisampledColorBuffer,this.storeMultisampledDepthBuffer=i.storeMultisampledDepthBuffer,this.storeMultisampledStencilBuffer=i.storeMultisampledStencilBuffer,this._depthTexture=null,this.depthTexture=i.depthTexture,this.samples=i.samples,this.multiview=i.multiview,this.useArrayDepthTexture=i.useArrayDepthTexture}_setTextureOptions(e={}){const t={minFilter:ln,generateMipmaps:!1,flipY:!1,internalFormat:null};e.mapping!==void 0&&(t.mapping=e.mapping),e.wrapS!==void 0&&(t.wrapS=e.wrapS),e.wrapT!==void 0&&(t.wrapT=e.wrapT),e.wrapR!==void 0&&(t.wrapR=e.wrapR),e.magFilter!==void 0&&(t.magFilter=e.magFilter),e.minFilter!==void 0&&(t.minFilter=e.minFilter),e.format!==void 0&&(t.format=e.format),e.type!==void 0&&(t.type=e.type),e.anisotropy!==void 0&&(t.anisotropy=e.anisotropy),e.colorSpace!==void 0&&(t.colorSpace=e.colorSpace),e.flipY!==void 0&&(t.flipY=e.flipY),e.generateMipmaps!==void 0&&(t.generateMipmaps=e.generateMipmaps),e.internalFormat!==void 0&&(t.internalFormat=e.internalFormat);for(let i=0;i<this.textures.length;i++)this.textures[i].setValues(t)}get texture(){return this.textures[0]}set texture(e){this.textures[0]=e}set depthTexture(e){this._depthTexture!==null&&this._depthTexture.renderTarget===this&&(this._depthTexture.renderTarget=null),e!==null&&e.renderTarget===null&&(e.renderTarget=this),this._depthTexture=e}get depthTexture(){return this._depthTexture}setSize(e,t,i=1){if(this.width!==e||this.height!==t||this.depth!==i){this.width=e,this.height=t,this.depth=i;for(let r=0,s=this.textures.length;r<s;r++)this.textures[r].image.width=e,this.textures[r].image.height=t,this.textures[r].image.depth=i,this.textures[r].isData3DTexture!==!0&&(this.textures[r].isArrayTexture=this.textures[r].image.depth>1);this.dispose()}this.viewport.set(0,0,e,t),this.scissor.set(0,0,e,t)}clone(){return new this.constructor().copy(this)}copy(e){this.width=e.width,this.height=e.height,this.depth=e.depth,this.scissor.copy(e.scissor),this.scissorTest=e.scissorTest,this.viewport.copy(e.viewport),this.textures.length=0;for(let t=0,i=e.textures.length;t<i;t++){this.textures[t]=e.textures[t].clone(),this.textures[t].isRenderTargetTexture=!0,this.textures[t].renderTarget=this;const r=Object.assign({},e.textures[t].image);this.textures[t].source=new Ru(r)}if(this.depthBuffer=e.depthBuffer,this.stencilBuffer=e.stencilBuffer,this.resolveColorBuffer=e.resolveColorBuffer,this.resolveDepthBuffer=e.resolveDepthBuffer,this.resolveStencilBuffer=e.resolveStencilBuffer,this.storeMultisampledColorBuffer=e.storeMultisampledColorBuffer,this.storeMultisampledDepthBuffer=e.storeMultisampledDepthBuffer,this.storeMultisampledStencilBuffer=e.storeMultisampledStencilBuffer,e.depthTexture!==null)if(e.depthTexture.renderTarget===e){const t=e.depthTexture.clone();t.renderTarget=null,this.depthTexture=t}else this.depthTexture=e.depthTexture;return this.samples=e.samples,this.multiview=e.multiview,this.useArrayDepthTexture=e.useArrayDepthTexture,this}dispose(){this.dispatchEvent({type:"dispose"})}}class qn extends J_{constructor(e=1,t=1,i={}){super(e,t,i),this.isWebGLRenderTarget=!0}}class Ep extends vn{constructor(e=null,t=1,i=1,r=1){super(null),this.isDataArrayTexture=!0,this.image={data:e,width:t,height:i,depth:r},this.magFilter=rn,this.minFilter=rn,this.wrapR=Si,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1,this.layerUpdates=new Set}copy(e){return super.copy(e),this.wrapR=e.wrapR,this}addLayerUpdate(e){this.layerUpdates.add(e)}clearLayerUpdates(){this.layerUpdates.clear()}}class Q_ extends vn{constructor(e=null,t=1,i=1,r=1){super(null),this.isData3DTexture=!0,this.image={data:e,width:t,height:i,depth:r},this.magFilter=rn,this.minFilter=rn,this.wrapR=Si,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}copy(e){return super.copy(e),this.wrapR=e.wrapR,this}}class et{static{et.prototype.isMatrix4=!0}constructor(e,t,i,r,s,a,o,l,c,f,d,u,h,_,g,p){this.elements=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],e!==void 0&&this.set(e,t,i,r,s,a,o,l,c,f,d,u,h,_,g,p)}set(e,t,i,r,s,a,o,l,c,f,d,u,h,_,g,p){const m=this.elements;return m[0]=e,m[4]=t,m[8]=i,m[12]=r,m[1]=s,m[5]=a,m[9]=o,m[13]=l,m[2]=c,m[6]=f,m[10]=d,m[14]=u,m[3]=h,m[7]=_,m[11]=g,m[15]=p,this}identity(){return this.set(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1),this}clone(){return new et().fromArray(this.elements)}copy(e){const t=this.elements,i=e.elements;return t[0]=i[0],t[1]=i[1],t[2]=i[2],t[3]=i[3],t[4]=i[4],t[5]=i[5],t[6]=i[6],t[7]=i[7],t[8]=i[8],t[9]=i[9],t[10]=i[10],t[11]=i[11],t[12]=i[12],t[13]=i[13],t[14]=i[14],t[15]=i[15],this}copyPosition(e){const t=this.elements,i=e.elements;return t[12]=i[12],t[13]=i[13],t[14]=i[14],this}setFromMatrix3(e){const t=e.elements;return this.set(t[0],t[3],t[6],0,t[1],t[4],t[7],0,t[2],t[5],t[8],0,0,0,0,1),this}extractBasis(e,t,i){return this.determinantAffine()===0?(e.set(1,0,0),t.set(0,1,0),i.set(0,0,1),this):(e.setFromMatrixColumn(this,0),t.setFromMatrixColumn(this,1),i.setFromMatrixColumn(this,2),this)}makeBasis(e,t,i){return this.set(e.x,t.x,i.x,0,e.y,t.y,i.y,0,e.z,t.z,i.z,0,0,0,0,1),this}extractRotation(e){if(e.determinantAffine()===0)return this.identity();const t=this.elements,i=e.elements,r=1/Mr.setFromMatrixColumn(e,0).length(),s=1/Mr.setFromMatrixColumn(e,1).length(),a=1/Mr.setFromMatrixColumn(e,2).length();return t[0]=i[0]*r,t[1]=i[1]*r,t[2]=i[2]*r,t[3]=0,t[4]=i[4]*s,t[5]=i[5]*s,t[6]=i[6]*s,t[7]=0,t[8]=i[8]*a,t[9]=i[9]*a,t[10]=i[10]*a,t[11]=0,t[12]=0,t[13]=0,t[14]=0,t[15]=1,this}makeRotationFromEuler(e){const t=this.elements,i=e.x,r=e.y,s=e.z,a=Math.cos(i),o=Math.sin(i),l=Math.cos(r),c=Math.sin(r),f=Math.cos(s),d=Math.sin(s);if(e.order==="XYZ"){const u=a*f,h=a*d,_=o*f,g=o*d;t[0]=l*f,t[4]=-l*d,t[8]=c,t[1]=h+_*c,t[5]=u-g*c,t[9]=-o*l,t[2]=g-u*c,t[6]=_+h*c,t[10]=a*l}else if(e.order==="YXZ"){const u=l*f,h=l*d,_=c*f,g=c*d;t[0]=u+g*o,t[4]=_*o-h,t[8]=a*c,t[1]=a*d,t[5]=a*f,t[9]=-o,t[2]=h*o-_,t[6]=g+u*o,t[10]=a*l}else if(e.order==="ZXY"){const u=l*f,h=l*d,_=c*f,g=c*d;t[0]=u-g*o,t[4]=-a*d,t[8]=_+h*o,t[1]=h+_*o,t[5]=a*f,t[9]=g-u*o,t[2]=-a*c,t[6]=o,t[10]=a*l}else if(e.order==="ZYX"){const u=a*f,h=a*d,_=o*f,g=o*d;t[0]=l*f,t[4]=_*c-h,t[8]=u*c+g,t[1]=l*d,t[5]=g*c+u,t[9]=h*c-_,t[2]=-c,t[6]=o*l,t[10]=a*l}else if(e.order==="YZX"){const u=a*l,h=a*c,_=o*l,g=o*c;t[0]=l*f,t[4]=g-u*d,t[8]=_*d+h,t[1]=d,t[5]=a*f,t[9]=-o*f,t[2]=-c*f,t[6]=h*d+_,t[10]=u-g*d}else if(e.order==="XZY"){const u=a*l,h=a*c,_=o*l,g=o*c;t[0]=l*f,t[4]=-d,t[8]=c*f,t[1]=u*d+g,t[5]=a*f,t[9]=h*d-_,t[2]=_*d-h,t[6]=o*f,t[10]=g*d+u}return t[3]=0,t[7]=0,t[11]=0,t[12]=0,t[13]=0,t[14]=0,t[15]=1,this}makeRotationFromQuaternion(e){return this.compose(j_,e,ev)}lookAt(e,t,i){const r=this.elements;return Tn.subVectors(e,t),Tn.lengthSq()===0&&(Tn.z=1),Tn.normalize(),Ui.crossVectors(i,Tn),Ui.lengthSq()===0&&(Math.abs(i.z)===1?Tn.x+=1e-4:Tn.z+=1e-4,Tn.normalize(),Ui.crossVectors(i,Tn)),Ui.normalize(),ta.crossVectors(Tn,Ui),r[0]=Ui.x,r[4]=ta.x,r[8]=Tn.x,r[1]=Ui.y,r[5]=ta.y,r[9]=Tn.y,r[2]=Ui.z,r[6]=ta.z,r[10]=Tn.z,this}multiply(e){return this.multiplyMatrices(this,e)}premultiply(e){return this.multiplyMatrices(e,this)}multiplyMatrices(e,t){const i=e.elements,r=t.elements,s=this.elements,a=i[0],o=i[4],l=i[8],c=i[12],f=i[1],d=i[5],u=i[9],h=i[13],_=i[2],g=i[6],p=i[10],m=i[14],v=i[3],w=i[7],y=i[11],S=i[15],M=r[0],E=r[4],b=r[8],T=r[12],C=r[1],D=r[5],R=r[9],N=r[13],I=r[2],z=r[6],$=r[10],X=r[14],re=r[3],J=r[7],Q=r[11],te=r[15];return s[0]=a*M+o*C+l*I+c*re,s[4]=a*E+o*D+l*z+c*J,s[8]=a*b+o*R+l*$+c*Q,s[12]=a*T+o*N+l*X+c*te,s[1]=f*M+d*C+u*I+h*re,s[5]=f*E+d*D+u*z+h*J,s[9]=f*b+d*R+u*$+h*Q,s[13]=f*T+d*N+u*X+h*te,s[2]=_*M+g*C+p*I+m*re,s[6]=_*E+g*D+p*z+m*J,s[10]=_*b+g*R+p*$+m*Q,s[14]=_*T+g*N+p*X+m*te,s[3]=v*M+w*C+y*I+S*re,s[7]=v*E+w*D+y*z+S*J,s[11]=v*b+w*R+y*$+S*Q,s[15]=v*T+w*N+y*X+S*te,this}multiplyScalar(e){const t=this.elements;return t[0]*=e,t[4]*=e,t[8]*=e,t[12]*=e,t[1]*=e,t[5]*=e,t[9]*=e,t[13]*=e,t[2]*=e,t[6]*=e,t[10]*=e,t[14]*=e,t[3]*=e,t[7]*=e,t[11]*=e,t[15]*=e,this}determinant(){const e=this.elements,t=e[0],i=e[4],r=e[8],s=e[12],a=e[1],o=e[5],l=e[9],c=e[13],f=e[2],d=e[6],u=e[10],h=e[14],_=e[3],g=e[7],p=e[11],m=e[15],v=l*h-c*u,w=o*h-c*d,y=o*u-l*d,S=a*h-c*f,M=a*u-l*f,E=a*d-o*f;return t*(g*v-p*w+m*y)-i*(_*v-p*S+m*M)+r*(_*w-g*S+m*E)-s*(_*y-g*M+p*E)}determinantAffine(){const e=this.elements,t=e[0],i=e[4],r=e[8],s=e[1],a=e[5],o=e[9],l=e[2],c=e[6],f=e[10];return t*(a*f-o*c)-i*(s*f-o*l)+r*(s*c-a*l)}transpose(){const e=this.elements;let t;return t=e[1],e[1]=e[4],e[4]=t,t=e[2],e[2]=e[8],e[8]=t,t=e[6],e[6]=e[9],e[9]=t,t=e[3],e[3]=e[12],e[12]=t,t=e[7],e[7]=e[13],e[13]=t,t=e[11],e[11]=e[14],e[14]=t,this}setPosition(e,t,i){const r=this.elements;return e.isVector3?(r[12]=e.x,r[13]=e.y,r[14]=e.z):(r[12]=e,r[13]=t,r[14]=i),this}invert(){const e=this.elements,t=e[0],i=e[1],r=e[2],s=e[3],a=e[4],o=e[5],l=e[6],c=e[7],f=e[8],d=e[9],u=e[10],h=e[11],_=e[12],g=e[13],p=e[14],m=e[15],v=t*o-i*a,w=t*l-r*a,y=t*c-s*a,S=i*l-r*o,M=i*c-s*o,E=r*c-s*l,b=f*g-d*_,T=f*p-u*_,C=f*m-h*_,D=d*p-u*g,R=d*m-h*g,N=u*m-h*p,I=v*N-w*R+y*D+S*C-M*T+E*b;if(I===0)return this.set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);const z=1/I;return e[0]=(o*N-l*R+c*D)*z,e[1]=(r*R-i*N-s*D)*z,e[2]=(g*E-p*M+m*S)*z,e[3]=(u*M-d*E-h*S)*z,e[4]=(l*C-a*N-c*T)*z,e[5]=(t*N-r*C+s*T)*z,e[6]=(p*y-_*E-m*w)*z,e[7]=(f*E-u*y+h*w)*z,e[8]=(a*R-o*C+c*b)*z,e[9]=(i*C-t*R-s*b)*z,e[10]=(_*M-g*y+m*v)*z,e[11]=(d*y-f*M-h*v)*z,e[12]=(o*T-a*D-l*b)*z,e[13]=(t*D-i*T+r*b)*z,e[14]=(g*w-_*S-p*v)*z,e[15]=(f*S-d*w+u*v)*z,this}scale(e){const t=this.elements,i=e.x,r=e.y,s=e.z;return t[0]*=i,t[4]*=r,t[8]*=s,t[1]*=i,t[5]*=r,t[9]*=s,t[2]*=i,t[6]*=r,t[10]*=s,t[3]*=i,t[7]*=r,t[11]*=s,this}getMaxScaleOnAxis(){const e=this.elements,t=e[0]*e[0]+e[1]*e[1]+e[2]*e[2],i=e[4]*e[4]+e[5]*e[5]+e[6]*e[6],r=e[8]*e[8]+e[9]*e[9]+e[10]*e[10];return Math.sqrt(Math.max(t,i,r))}makeTranslation(e,t,i){return e.isVector3?this.set(1,0,0,e.x,0,1,0,e.y,0,0,1,e.z,0,0,0,1):this.set(1,0,0,e,0,1,0,t,0,0,1,i,0,0,0,1),this}makeRotationX(e){const t=Math.cos(e),i=Math.sin(e);return this.set(1,0,0,0,0,t,-i,0,0,i,t,0,0,0,0,1),this}makeRotationY(e){const t=Math.cos(e),i=Math.sin(e);return this.set(t,0,i,0,0,1,0,0,-i,0,t,0,0,0,0,1),this}makeRotationZ(e){const t=Math.cos(e),i=Math.sin(e);return this.set(t,-i,0,0,i,t,0,0,0,0,1,0,0,0,0,1),this}makeRotationAxis(e,t){const i=Math.cos(t),r=Math.sin(t),s=1-i,a=e.x,o=e.y,l=e.z,c=s*a,f=s*o;return this.set(c*a+i,c*o-r*l,c*l+r*o,0,c*o+r*l,f*o+i,f*l-r*a,0,c*l-r*o,f*l+r*a,s*l*l+i,0,0,0,0,1),this}makeScale(e,t,i){return this.set(e,0,0,0,0,t,0,0,0,0,i,0,0,0,0,1),this}makeShear(e,t,i,r,s,a){return this.set(1,i,s,0,e,1,a,0,t,r,1,0,0,0,0,1),this}compose(e,t,i){const r=this.elements,s=t._x,a=t._y,o=t._z,l=t._w,c=s+s,f=a+a,d=o+o,u=s*c,h=s*f,_=s*d,g=a*f,p=a*d,m=o*d,v=l*c,w=l*f,y=l*d,S=i.x,M=i.y,E=i.z;return r[0]=(1-(g+m))*S,r[1]=(h+y)*S,r[2]=(_-w)*S,r[3]=0,r[4]=(h-y)*M,r[5]=(1-(u+m))*M,r[6]=(p+v)*M,r[7]=0,r[8]=(_+w)*E,r[9]=(p-v)*E,r[10]=(1-(u+g))*E,r[11]=0,r[12]=e.x,r[13]=e.y,r[14]=e.z,r[15]=1,this}decompose(e,t,i){const r=this.elements;e.x=r[12],e.y=r[13],e.z=r[14];const s=this.determinantAffine();if(s===0)return i.set(1,1,1),t.identity(),this;let a=Mr.set(r[0],r[1],r[2]).length();const o=Mr.set(r[4],r[5],r[6]).length(),l=Mr.set(r[8],r[9],r[10]).length();s<0&&(a=-a),kn.copy(this);const c=1/a,f=1/o,d=1/l;return kn.elements[0]*=c,kn.elements[1]*=c,kn.elements[2]*=c,kn.elements[4]*=f,kn.elements[5]*=f,kn.elements[6]*=f,kn.elements[8]*=d,kn.elements[9]*=d,kn.elements[10]*=d,t.setFromRotationMatrix(kn),i.x=a,i.y=o,i.z=l,this}makePerspective(e,t,i,r,s,a,o=ai,l=!1){const c=this.elements,f=2*s/(t-e),d=2*s/(i-r),u=(t+e)/(t-e),h=(i+r)/(i-r);let _,g;if(l)_=s/(a-s),g=a*s/(a-s);else if(o===ai)_=-(a+s)/(a-s),g=-2*a*s/(a-s);else if(o===Mo)_=-a/(a-s),g=-a*s/(a-s);else throw new Error("THREE.Matrix4.makePerspective(): Invalid coordinate system: "+o);return c[0]=f,c[4]=0,c[8]=u,c[12]=0,c[1]=0,c[5]=d,c[9]=h,c[13]=0,c[2]=0,c[6]=0,c[10]=_,c[14]=g,c[3]=0,c[7]=0,c[11]=-1,c[15]=0,this}makeOrthographic(e,t,i,r,s,a,o=ai,l=!1){const c=this.elements,f=2/(t-e),d=2/(i-r),u=-(t+e)/(t-e),h=-(i+r)/(i-r);let _,g;if(l)_=1/(a-s),g=a/(a-s);else if(o===ai)_=-2/(a-s),g=-(a+s)/(a-s);else if(o===Mo)_=-1/(a-s),g=-s/(a-s);else throw new Error("THREE.Matrix4.makeOrthographic(): Invalid coordinate system: "+o);return c[0]=f,c[4]=0,c[8]=0,c[12]=u,c[1]=0,c[5]=d,c[9]=0,c[13]=h,c[2]=0,c[6]=0,c[10]=_,c[14]=g,c[3]=0,c[7]=0,c[11]=0,c[15]=1,this}equals(e){const t=this.elements,i=e.elements;for(let r=0;r<16;r++)if(t[r]!==i[r])return!1;return!0}fromArray(e,t=0){for(let i=0;i<16;i++)this.elements[i]=e[i+t];return this}toArray(e=[],t=0){const i=this.elements;return e[t]=i[0],e[t+1]=i[1],e[t+2]=i[2],e[t+3]=i[3],e[t+4]=i[4],e[t+5]=i[5],e[t+6]=i[6],e[t+7]=i[7],e[t+8]=i[8],e[t+9]=i[9],e[t+10]=i[10],e[t+11]=i[11],e[t+12]=i[12],e[t+13]=i[13],e[t+14]=i[14],e[t+15]=i[15],e}}const Mr=new U,kn=new et,j_=new U(0,0,0),ev=new U(1,1,1),Ui=new U,ta=new U,Tn=new U,Df=new et,Nf=new Xn;class gr{constructor(e=0,t=0,i=0,r=gr.DEFAULT_ORDER){this.isEuler=!0,this._x=e,this._y=t,this._z=i,this._order=r}get x(){return this._x}set x(e){this._x=e,this._onChangeCallback()}get y(){return this._y}set y(e){this._y=e,this._onChangeCallback()}get z(){return this._z}set z(e){this._z=e,this._onChangeCallback()}get order(){return this._order}set order(e){this._order=e,this._onChangeCallback()}set(e,t,i,r=this._order){return this._x=e,this._y=t,this._z=i,this._order=r,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._order)}copy(e){return this._x=e._x,this._y=e._y,this._z=e._z,this._order=e._order,this._onChangeCallback(),this}setFromRotationMatrix(e,t=this._order,i=!0){const r=e.elements,s=r[0],a=r[4],o=r[8],l=r[1],c=r[5],f=r[9],d=r[2],u=r[6],h=r[10];switch(t){case"XYZ":this._y=Math.asin(Ye(o,-1,1)),Math.abs(o)<.9999999?(this._x=Math.atan2(-f,h),this._z=Math.atan2(-a,s)):(this._x=Math.atan2(u,c),this._z=0);break;case"YXZ":this._x=Math.asin(-Ye(f,-1,1)),Math.abs(f)<.9999999?(this._y=Math.atan2(o,h),this._z=Math.atan2(l,c)):(this._y=Math.atan2(-d,s),this._z=0);break;case"ZXY":this._x=Math.asin(Ye(u,-1,1)),Math.abs(u)<.9999999?(this._y=Math.atan2(-d,h),this._z=Math.atan2(-a,c)):(this._y=0,this._z=Math.atan2(l,s));break;case"ZYX":this._y=Math.asin(-Ye(d,-1,1)),Math.abs(d)<.9999999?(this._x=Math.atan2(u,h),this._z=Math.atan2(l,s)):(this._x=0,this._z=Math.atan2(-a,c));break;case"YZX":this._z=Math.asin(Ye(l,-1,1)),Math.abs(l)<.9999999?(this._x=Math.atan2(-f,c),this._y=Math.atan2(-d,s)):(this._x=0,this._y=Math.atan2(o,h));break;case"XZY":this._z=Math.asin(-Ye(a,-1,1)),Math.abs(a)<.9999999?(this._x=Math.atan2(u,c),this._y=Math.atan2(o,s)):(this._x=Math.atan2(-f,h),this._y=0);break;default:ze("Euler: .setFromRotationMatrix() encountered an unknown order: "+t)}return this._order=t,i===!0&&this._onChangeCallback(),this}setFromQuaternion(e,t,i){return Df.makeRotationFromQuaternion(e),this.setFromRotationMatrix(Df,t,i)}setFromVector3(e,t=this._order){return this.set(e.x,e.y,e.z,t)}reorder(e){return Nf.setFromEuler(this),this.setFromQuaternion(Nf,e)}equals(e){return e._x===this._x&&e._y===this._y&&e._z===this._z&&e._order===this._order}fromArray(e){return this._x=e[0],this._y=e[1],this._z=e[2],e[3]!==void 0&&(this._order=e[3]),this._onChangeCallback(),this}toArray(e=[],t=0){return e[t]=this._x,e[t+1]=this._y,e[t+2]=this._z,e[t+3]=this._order,e}_onChange(e){return this._onChangeCallback=e,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._order}}gr.DEFAULT_ORDER="XYZ";class Tp{constructor(){this.mask=1}set(e){this.mask=(1<<e|0)>>>0}enable(e){this.mask|=1<<e|0}enableAll(){this.mask=-1}toggle(e){this.mask^=1<<e|0}disable(e){this.mask&=~(1<<e|0)}disableAll(){this.mask=0}test(e){return(this.mask&e.mask)!==0}isEnabled(e){return(this.mask&(1<<e|0))!==0}}let tv=0;const If=new U,wr=new Xn,di=new et,na=new U,ls=new U,nv=new U,iv=new Xn,Uf=new U(1,0,0),Ff=new U(0,1,0),Bf=new U(0,0,1),Of={type:"added"},rv={type:"removed"},Er={type:"childadded",child:null},rl={type:"childremoved",child:null};class xn extends vr{constructor(){super(),this.isObject3D=!0,Object.defineProperty(this,"id",{value:tv++}),this.uuid=Ei(),this.name="",this.type="Object3D",this.parent=null,this.children=[],this.up=xn.DEFAULT_UP.clone();const e=new U,t=new gr,i=new Xn,r=new U(1,1,1);function s(){i.setFromEuler(t,!1)}function a(){t.setFromQuaternion(i,void 0,!1)}t._onChange(s),i._onChange(a),Object.defineProperties(this,{position:{configurable:!0,enumerable:!0,value:e},rotation:{configurable:!0,enumerable:!0,value:t},quaternion:{configurable:!0,enumerable:!0,value:i},scale:{configurable:!0,enumerable:!0,value:r},modelViewMatrix:{value:new et},normalMatrix:{value:new We}}),this.matrix=new et,this.matrixWorld=new et,this.matrixAutoUpdate=xn.DEFAULT_MATRIX_AUTO_UPDATE,this.matrixWorldAutoUpdate=xn.DEFAULT_MATRIX_WORLD_AUTO_UPDATE,this.matrixWorldNeedsUpdate=!1,this.layers=new Tp,this.visible=!0,this.castShadow=!1,this.receiveShadow=!1,this.frustumCulled=!0,this.renderOrder=0,this.animations=[],this.customDepthMaterial=void 0,this.customDistanceMaterial=void 0,this.static=!1,this.userData={},this.pivot=null}onBeforeShadow(){}onAfterShadow(){}onBeforeRender(){}onAfterRender(){}applyMatrix4(e){this.matrixAutoUpdate&&this.updateMatrix(),this.matrix.premultiply(e),this.matrix.decompose(this.position,this.quaternion,this.scale)}applyQuaternion(e){return this.quaternion.premultiply(e),this}setRotationFromAxisAngle(e,t){this.quaternion.setFromAxisAngle(e,t)}setRotationFromEuler(e){this.quaternion.setFromEuler(e,!0)}setRotationFromMatrix(e){this.quaternion.setFromRotationMatrix(e)}setRotationFromQuaternion(e){this.quaternion.copy(e)}rotateOnAxis(e,t){return wr.setFromAxisAngle(e,t),this.quaternion.multiply(wr),this}rotateOnWorldAxis(e,t){return wr.setFromAxisAngle(e,t),this.quaternion.premultiply(wr),this}rotateX(e){return this.rotateOnAxis(Uf,e)}rotateY(e){return this.rotateOnAxis(Ff,e)}rotateZ(e){return this.rotateOnAxis(Bf,e)}translateOnAxis(e,t){return If.copy(e).applyQuaternion(this.quaternion),this.position.add(If.multiplyScalar(t)),this}translateX(e){return this.translateOnAxis(Uf,e)}translateY(e){return this.translateOnAxis(Ff,e)}translateZ(e){return this.translateOnAxis(Bf,e)}localToWorld(e){return this.updateWorldMatrix(!0,!1),e.applyMatrix4(this.matrixWorld)}worldToLocal(e){return this.updateWorldMatrix(!0,!1),e.applyMatrix4(di.copy(this.matrixWorld).invert())}lookAt(e,t,i){e.isVector3?na.copy(e):na.set(e,t,i);const r=this.parent;this.updateWorldMatrix(!0,!1),ls.setFromMatrixPosition(this.matrixWorld),this.isCamera||this.isLight?di.lookAt(ls,na,this.up):di.lookAt(na,ls,this.up),this.quaternion.setFromRotationMatrix(di),r&&(di.extractRotation(r.matrixWorld),wr.setFromRotationMatrix(di),this.quaternion.premultiply(wr.invert()))}add(e){if(arguments.length>1){for(let t=0;t<arguments.length;t++)this.add(arguments[t]);return this}return e===this?(ut("Object3D.add: object can't be added as a child of itself.",e),this):(e&&e.isObject3D?(e.removeFromParent(),e.parent=this,this.children.push(e),e.dispatchEvent(Of),Er.child=e,this.dispatchEvent(Er),Er.child=null):ut("Object3D.add: object not an instance of THREE.Object3D.",e),this)}remove(e){if(arguments.length>1){for(let i=0;i<arguments.length;i++)this.remove(arguments[i]);return this}const t=this.children.indexOf(e);return t!==-1&&(e.parent=null,this.children.splice(t,1),e.dispatchEvent(rv),rl.child=e,this.dispatchEvent(rl),rl.child=null),this}removeFromParent(){const e=this.parent;return e!==null&&e.remove(this),this}clear(){return this.remove(...this.children)}attach(e){return this.updateWorldMatrix(!0,!1),di.copy(this.matrixWorld).invert(),e.parent!==null&&(e.parent.updateWorldMatrix(!0,!1),di.multiply(e.parent.matrixWorld)),e.applyMatrix4(di),e.removeFromParent(),e.parent=this,this.children.push(e),e.updateWorldMatrix(!1,!0),e.dispatchEvent(Of),Er.child=e,this.dispatchEvent(Er),Er.child=null,this}getObjectById(e){return this.getObjectByProperty("id",e)}getObjectByName(e){return this.getObjectByProperty("name",e)}getObjectByProperty(e,t){if(this[e]===t)return this;for(let i=0,r=this.children.length;i<r;i++){const a=this.children[i].getObjectByProperty(e,t);if(a!==void 0)return a}}getObjectsByProperty(e,t,i=[]){this[e]===t&&i.push(this);const r=this.children;for(let s=0,a=r.length;s<a;s++)r[s].getObjectsByProperty(e,t,i);return i}getWorldPosition(e){return this.updateWorldMatrix(!0,!1),e.setFromMatrixPosition(this.matrixWorld)}getWorldQuaternion(e){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(ls,e,nv),e}getWorldScale(e){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(ls,iv,e),e}getWorldDirection(e){this.updateWorldMatrix(!0,!1);const t=this.matrixWorld.elements;return e.set(t[8],t[9],t[10]).normalize()}raycast(){}intersectsFrustum(){}traverse(e){e(this);const t=this.children;for(let i=0,r=t.length;i<r;i++)t[i].traverse(e)}traverseVisible(e){if(this.visible===!1)return;e(this);const t=this.children;for(let i=0,r=t.length;i<r;i++)t[i].traverseVisible(e)}traverseAncestors(e){const t=this.parent;t!==null&&(e(t),t.traverseAncestors(e))}updateMatrix(){this.matrix.compose(this.position,this.quaternion,this.scale);const e=this.pivot;if(e!==null){const t=e.x,i=e.y,r=e.z,s=this.matrix.elements;s[12]+=t-s[0]*t-s[4]*i-s[8]*r,s[13]+=i-s[1]*t-s[5]*i-s[9]*r,s[14]+=r-s[2]*t-s[6]*i-s[10]*r}this.matrixWorldNeedsUpdate=!0}updateMatrixWorld(e){this.matrixAutoUpdate&&this.updateMatrix(),(this.matrixWorldNeedsUpdate||e)&&(this.matrixWorldAutoUpdate===!0&&(this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix)),this.matrixWorldNeedsUpdate=!1,e=!0);const t=this.children;for(let i=0,r=t.length;i<r;i++)t[i].updateMatrixWorld(e)}updateWorldMatrix(e,t,i=!1){const r=this.parent;if(e===!0&&r!==null&&r.updateWorldMatrix(!0,!1),this.matrixAutoUpdate&&this.updateMatrix(),(this.matrixWorldNeedsUpdate||i)&&(this.matrixWorldAutoUpdate===!0&&(this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix)),this.matrixWorldNeedsUpdate=!1,i=!0),t===!0){const s=this.children;for(let a=0,o=s.length;a<o;a++)s[a].updateWorldMatrix(!1,!0,i)}}toJSON(e){const t=e===void 0||typeof e=="string",i={};t&&(e={geometries:{},materials:{},textures:{},images:{},shapes:{},skeletons:{},animations:{},nodes:{}},i.metadata={version:4.7,type:"Object",generator:"Object3D.toJSON"});const r={};r.uuid=this.uuid,r.type=this.type,r.name=this.name,r.castShadow=this.castShadow,r.receiveShadow=this.receiveShadow,r.visible=this.visible,r.frustumCulled=this.frustumCulled,r.renderOrder=this.renderOrder,r.static=this.static,r.matrixAutoUpdate=this.matrixAutoUpdate,Object.keys(this.userData).length>0&&(r.userData=this.userData),r.layers=this.layers.mask,r.matrix=this.matrix.toArray(),r.up=this.up.toArray(),this.pivot!==null&&(r.pivot=this.pivot.toArray()),this.morphTargetDictionary!==void 0&&(r.morphTargetDictionary=Object.assign({},this.morphTargetDictionary)),this.morphTargetInfluences!==void 0&&(r.morphTargetInfluences=this.morphTargetInfluences.slice()),this.isInstancedMesh&&(r.type="InstancedMesh",r.count=this.count,r.instanceMatrix=this.instanceMatrix.toJSON(),this.instanceColor!==null&&(r.instanceColor=this.instanceColor.toJSON())),this.isBatchedMesh&&(r.type="BatchedMesh",r.perObjectFrustumCulled=this.perObjectFrustumCulled,r.sortObjects=this.sortObjects,r.drawRanges=this._drawRanges,r.reservedRanges=this._reservedRanges,r.geometryInfo=this._geometryInfo.map(o=>({...o,boundingBox:o.boundingBox?o.boundingBox.toJSON():void 0,boundingSphere:o.boundingSphere?o.boundingSphere.toJSON():void 0})),r.instanceInfo=this._instanceInfo.map(o=>({...o})),r.availableInstanceIds=this._availableInstanceIds.slice(),r.availableGeometryIds=this._availableGeometryIds.slice(),r.nextIndexStart=this._nextIndexStart,r.nextVertexStart=this._nextVertexStart,r.geometryCount=this._geometryCount,r.maxInstanceCount=this._maxInstanceCount,r.maxVertexCount=this._maxVertexCount,r.maxIndexCount=this._maxIndexCount,r.geometryInitialized=this._geometryInitialized,r.matricesTexture=this._matricesTexture.toJSON(e),r.indirectTexture=this._indirectTexture.toJSON(e),this._colorsTexture!==null&&(r.colorsTexture=this._colorsTexture.toJSON(e)),this.boundingSphere!==null&&(r.boundingSphere=this.boundingSphere.toJSON()),this.boundingBox!==null&&(r.boundingBox=this.boundingBox.toJSON()));function s(o,l){return o[l.uuid]===void 0&&(o[l.uuid]=l.toJSON(e)),l.uuid}if(this.isScene)this.background&&(this.background.isColor?r.background=this.background.toJSON():this.background.isTexture&&(r.background=this.background.toJSON(e).uuid)),this.environment&&this.environment.isTexture&&this.environment.isRenderTargetTexture!==!0&&(r.environment=this.environment.toJSON(e).uuid);else if(this.isMesh||this.isLine||this.isPoints){r.geometry=s(e.geometries,this.geometry);const o=this.geometry.parameters;if(o!==void 0&&o.shapes!==void 0){const l=o.shapes;if(Array.isArray(l))for(let c=0,f=l.length;c<f;c++){const d=l[c];s(e.shapes,d)}else s(e.shapes,l)}}if(this.isSkinnedMesh&&(r.bindMode=this.bindMode,r.bindMatrix=this.bindMatrix.toArray(),this.skeleton!==void 0&&(s(e.skeletons,this.skeleton),r.skeleton=this.skeleton.uuid)),this.material!==void 0)if(Array.isArray(this.material)){const o=[];for(let l=0,c=this.material.length;l<c;l++)o.push(s(e.materials,this.material[l]));r.material=o}else r.material=s(e.materials,this.material);if(this.children.length>0){r.children=[];for(let o=0;o<this.children.length;o++)r.children.push(this.children[o].toJSON(e).object)}if(this.animations.length>0){r.animations=[];for(let o=0;o<this.animations.length;o++){const l=this.animations[o];r.animations.push(s(e.animations,l))}}if(t){const o=a(e.geometries),l=a(e.materials),c=a(e.textures),f=a(e.images),d=a(e.shapes),u=a(e.skeletons),h=a(e.animations),_=a(e.nodes);o.length>0&&(i.geometries=o),l.length>0&&(i.materials=l),c.length>0&&(i.textures=c),f.length>0&&(i.images=f),d.length>0&&(i.shapes=d),u.length>0&&(i.skeletons=u),h.length>0&&(i.animations=h),_.length>0&&(i.nodes=_)}return i.object=r,i;function a(o){const l=[];for(const c in o){const f=o[c];delete f.metadata,l.push(f)}return l}}clone(e){return new this.constructor().copy(this,e)}copy(e,t=!0){if(this.name=e.name,this.up.copy(e.up),this.position.copy(e.position),this.rotation.order=e.rotation.order,this.quaternion.copy(e.quaternion),this.scale.copy(e.scale),this.pivot=e.pivot!==null?e.pivot.clone():null,this.matrix.copy(e.matrix),this.matrixWorld.copy(e.matrixWorld),this.matrixAutoUpdate=e.matrixAutoUpdate,this.matrixWorldAutoUpdate=e.matrixWorldAutoUpdate,this.matrixWorldNeedsUpdate=e.matrixWorldNeedsUpdate,this.layers.mask=e.layers.mask,this.visible=e.visible,this.castShadow=e.castShadow,this.receiveShadow=e.receiveShadow,this.frustumCulled=e.frustumCulled,this.renderOrder=e.renderOrder,this.static=e.static,this.animations=e.animations.slice(),this.userData=JSON.parse(JSON.stringify(e.userData)),t===!0)for(let i=0;i<e.children.length;i++){const r=e.children[i];this.add(r.clone())}return this}dispose(){this.dispatchEvent({type:"dispose"})}}xn.DEFAULT_UP=new U(0,1,0);xn.DEFAULT_MATRIX_AUTO_UPDATE=!0;xn.DEFAULT_MATRIX_WORLD_AUTO_UPDATE=!0;class Xi extends xn{constructor(){super(),this.isGroup=!0,this.type="Group"}}const sv={type:"move"};class sl{constructor(){this._targetRay=null,this._grip=null,this._hand=null}getHandSpace(){return this._hand===null&&(this._hand=new Xi,this._hand.matrixAutoUpdate=!1,this._hand.visible=!1,this._hand.joints={},this._hand.inputState={pinching:!1}),this._hand}getTargetRaySpace(){return this._targetRay===null&&(this._targetRay=new Xi,this._targetRay.matrixAutoUpdate=!1,this._targetRay.visible=!1,this._targetRay.hasLinearVelocity=!1,this._targetRay.linearVelocity=new U,this._targetRay.hasAngularVelocity=!1,this._targetRay.angularVelocity=new U),this._targetRay}getGripSpace(){return this._grip===null&&(this._grip=new Xi,this._grip.matrixAutoUpdate=!1,this._grip.visible=!1,this._grip.hasLinearVelocity=!1,this._grip.linearVelocity=new U,this._grip.hasAngularVelocity=!1,this._grip.angularVelocity=new U,this._grip.eventsEnabled=!1),this._grip}dispatchEvent(e){return this._targetRay!==null&&this._targetRay.dispatchEvent(e),this._grip!==null&&this._grip.dispatchEvent(e),this._hand!==null&&this._hand.dispatchEvent(e),this}connect(e){if(e&&e.hand){const t=this._hand;if(t)for(const i of e.hand.values())this._getHandJoint(t,i)}return this.dispatchEvent({type:"connected",data:e}),this}disconnect(e){return this.dispatchEvent({type:"disconnected",data:e}),this._targetRay!==null&&(this._targetRay.visible=!1),this._grip!==null&&(this._grip.visible=!1),this._hand!==null&&(this._hand.visible=!1),this}update(e,t,i){let r=null,s=null,a=null;const o=this._targetRay,l=this._grip,c=this._hand;if(e&&t.session.visibilityState!=="visible-blurred"){if(c&&e.hand){a=!0;for(const g of e.hand.values()){const p=t.getJointPose(g,i),m=this._getHandJoint(c,g);p!==null&&(m.matrix.fromArray(p.transform.matrix),m.matrix.decompose(m.position,m.rotation,m.scale),m.matrixWorldNeedsUpdate=!0,m.jointRadius=p.radius),m.visible=p!==null}const f=c.joints["index-finger-tip"],d=c.joints["thumb-tip"],u=f.position.distanceTo(d.position),h=.02,_=.005;c.inputState.pinching&&u>h+_?(c.inputState.pinching=!1,this.dispatchEvent({type:"pinchend",handedness:e.handedness,target:this})):!c.inputState.pinching&&u<=h-_&&(c.inputState.pinching=!0,this.dispatchEvent({type:"pinchstart",handedness:e.handedness,target:this}))}else l!==null&&e.gripSpace&&(s=t.getPose(e.gripSpace,i),s!==null&&(l.matrix.fromArray(s.transform.matrix),l.matrix.decompose(l.position,l.rotation,l.scale),l.matrixWorldNeedsUpdate=!0,s.linearVelocity?(l.hasLinearVelocity=!0,l.linearVelocity.copy(s.linearVelocity)):l.hasLinearVelocity=!1,s.angularVelocity?(l.hasAngularVelocity=!0,l.angularVelocity.copy(s.angularVelocity)):l.hasAngularVelocity=!1,l.eventsEnabled&&l.dispatchEvent({type:"gripUpdated",data:e,target:this})));o!==null&&(r=t.getPose(e.targetRaySpace,i),r===null&&s!==null&&(r=s),r!==null&&(o.matrix.fromArray(r.transform.matrix),o.matrix.decompose(o.position,o.rotation,o.scale),o.matrixWorldNeedsUpdate=!0,r.linearVelocity?(o.hasLinearVelocity=!0,o.linearVelocity.copy(r.linearVelocity)):o.hasLinearVelocity=!1,r.angularVelocity?(o.hasAngularVelocity=!0,o.angularVelocity.copy(r.angularVelocity)):o.hasAngularVelocity=!1,this.dispatchEvent(sv)))}return o!==null&&(o.visible=r!==null),l!==null&&(l.visible=s!==null),c!==null&&(c.visible=a!==null),this}_getHandJoint(e,t){if(e.joints[t.jointName]===void 0){const i=new Xi;i.matrixAutoUpdate=!1,i.visible=!1,e.joints[t.jointName]=i,e.add(i)}return e.joints[t.jointName]}}const Ap={aliceblue:15792383,antiquewhite:16444375,aqua:65535,aquamarine:8388564,azure:15794175,beige:16119260,bisque:16770244,black:0,blanchedalmond:16772045,blue:255,blueviolet:9055202,brown:10824234,burlywood:14596231,cadetblue:6266528,chartreuse:8388352,chocolate:13789470,coral:16744272,cornflowerblue:6591981,cornsilk:16775388,crimson:14423100,cyan:65535,darkblue:139,darkcyan:35723,darkgoldenrod:12092939,darkgray:11119017,darkgreen:25600,darkgrey:11119017,darkkhaki:12433259,darkmagenta:9109643,darkolivegreen:5597999,darkorange:16747520,darkorchid:10040012,darkred:9109504,darksalmon:15308410,darkseagreen:9419919,darkslateblue:4734347,darkslategray:3100495,darkslategrey:3100495,darkturquoise:52945,darkviolet:9699539,deeppink:16716947,deepskyblue:49151,dimgray:6908265,dimgrey:6908265,dodgerblue:2003199,firebrick:11674146,floralwhite:16775920,forestgreen:2263842,fuchsia:16711935,gainsboro:14474460,ghostwhite:16316671,gold:16766720,goldenrod:14329120,gray:8421504,green:32768,greenyellow:11403055,grey:8421504,honeydew:15794160,hotpink:16738740,indianred:13458524,indigo:4915330,ivory:16777200,khaki:15787660,lavender:15132410,lavenderblush:16773365,lawngreen:8190976,lemonchiffon:16775885,lightblue:11393254,lightcoral:15761536,lightcyan:14745599,lightgoldenrodyellow:16448210,lightgray:13882323,lightgreen:9498256,lightgrey:13882323,lightpink:16758465,lightsalmon:16752762,lightseagreen:2142890,lightskyblue:8900346,lightslategray:7833753,lightslategrey:7833753,lightsteelblue:11584734,lightyellow:16777184,lime:65280,limegreen:3329330,linen:16445670,magenta:16711935,maroon:8388608,mediumaquamarine:6737322,mediumblue:205,mediumorchid:12211667,mediumpurple:9662683,mediumseagreen:3978097,mediumslateblue:8087790,mediumspringgreen:64154,mediumturquoise:4772300,mediumvioletred:13047173,midnightblue:1644912,mintcream:16121850,mistyrose:16770273,moccasin:16770229,navajowhite:16768685,navy:128,oldlace:16643558,olive:8421376,olivedrab:7048739,orange:16753920,orangered:16729344,orchid:14315734,palegoldenrod:15657130,palegreen:10025880,paleturquoise:11529966,palevioletred:14381203,papayawhip:16773077,peachpuff:16767673,peru:13468991,pink:16761035,plum:14524637,powderblue:11591910,purple:8388736,rebeccapurple:6697881,red:16711680,rosybrown:12357519,royalblue:4286945,saddlebrown:9127187,salmon:16416882,sandybrown:16032864,seagreen:3050327,seashell:16774638,sienna:10506797,silver:12632256,skyblue:8900331,slateblue:6970061,slategray:7372944,slategrey:7372944,snow:16775930,springgreen:65407,steelblue:4620980,tan:13808780,teal:32896,thistle:14204888,tomato:16737095,turquoise:4251856,violet:15631086,wheat:16113331,white:16777215,whitesmoke:16119285,yellow:16776960,yellowgreen:10145074},Fi={h:0,s:0,l:0},ia={h:0,s:0,l:0};function al(n,e,t){return t<0&&(t+=1),t>1&&(t-=1),t<1/6?n+(e-n)*6*t:t<1/2?e:t<2/3?n+(e-n)*6*(2/3-t):n}class ft{constructor(e,t,i){return this.isColor=!0,this.r=1,this.g=1,this.b=1,this.set(e,t,i)}set(e,t,i){if(t===void 0&&i===void 0){const r=e;r&&r.isColor?this.copy(r):typeof r=="number"?this.setHex(r):typeof r=="string"&&this.setStyle(r)}else this.setRGB(e,t,i);return this}setScalar(e){return this.r=e,this.g=e,this.b=e,this}setHex(e,t=Un){return e=Math.floor(e),this.r=(e>>16&255)/255,this.g=(e>>8&255)/255,this.b=(e&255)/255,at.colorSpaceToWorking(this,t),this}setRGB(e,t,i,r=at.workingColorSpace){return this.r=e,this.g=t,this.b=i,at.colorSpaceToWorking(this,r),this}setHSL(e,t,i,r=at.workingColorSpace){if(e=Au(e,1),t=Ye(t,0,1),i=Ye(i,0,1),t===0)this.r=this.g=this.b=i;else{const s=i<=.5?i*(1+t):i+t-i*t,a=2*i-s;this.r=al(a,s,e+1/3),this.g=al(a,s,e),this.b=al(a,s,e-1/3)}return at.colorSpaceToWorking(this,r),this}setStyle(e,t=Un){function i(s){s!==void 0&&parseFloat(s)<1&&ze("Color: Alpha component of "+e+" will be ignored.")}let r;if(r=/^(\w+)\(([^\)]*)\)/.exec(e)){let s;const a=r[1],o=r[2];switch(a){case"rgb":case"rgba":if(s=/^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(o))return i(s[4]),this.setRGB(Math.min(255,parseInt(s[1],10))/255,Math.min(255,parseInt(s[2],10))/255,Math.min(255,parseInt(s[3],10))/255,t);if(s=/^\s*(\d+)\%\s*,\s*(\d+)\%\s*,\s*(\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(o))return i(s[4]),this.setRGB(Math.min(100,parseInt(s[1],10))/100,Math.min(100,parseInt(s[2],10))/100,Math.min(100,parseInt(s[3],10))/100,t);break;case"hsl":case"hsla":if(s=/^\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\%\s*,\s*(\d*\.?\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(o))return i(s[4]),this.setHSL(parseFloat(s[1])/360,parseFloat(s[2])/100,parseFloat(s[3])/100,t);break;default:ze("Color: Unknown color model "+e)}}else if(r=/^\#([A-Fa-f\d]+)$/.exec(e)){const s=r[1],a=s.length;if(a===3)return this.setRGB(parseInt(s.charAt(0),16)/15,parseInt(s.charAt(1),16)/15,parseInt(s.charAt(2),16)/15,t);if(a===6)return this.setHex(parseInt(s,16),t);ze("Color: Invalid hex color "+e)}else if(e&&e.length>0)return this.setColorName(e,t);return this}setColorName(e,t=Un){const i=Ap[e.toLowerCase()];return i!==void 0?this.setHex(i,t):ze("Color: Unknown color "+e),this}clone(){return new this.constructor(this.r,this.g,this.b)}copy(e){return this.r=e.r,this.g=e.g,this.b=e.b,this}copySRGBToLinear(e){return this.r=Ti(e.r),this.g=Ti(e.g),this.b=Ti(e.b),this}copyLinearToSRGB(e){return this.r=Zr(e.r),this.g=Zr(e.g),this.b=Zr(e.b),this}convertSRGBToLinear(){return this.copySRGBToLinear(this),this}convertLinearToSRGB(){return this.copyLinearToSRGB(this),this}getHex(e=Un){return at.workingToColorSpace(on.copy(this),e),Math.round(Ye(on.r*255,0,255))*65536+Math.round(Ye(on.g*255,0,255))*256+Math.round(Ye(on.b*255,0,255))}getHexString(e=Un){return("000000"+this.getHex(e).toString(16)).slice(-6)}getHSL(e,t=at.workingColorSpace){at.workingToColorSpace(on.copy(this),t);const i=on.r,r=on.g,s=on.b,a=Math.max(i,r,s),o=Math.min(i,r,s);let l,c;const f=(o+a)/2;if(o===a)l=0,c=0;else{const d=a-o;switch(c=f<=.5?d/(a+o):d/(2-a-o),a){case i:l=(r-s)/d+(r<s?6:0);break;case r:l=(s-i)/d+2;break;case s:l=(i-r)/d+4;break}l/=6}return e.h=l,e.s=c,e.l=f,e}getRGB(e,t=at.workingColorSpace){return at.workingToColorSpace(on.copy(this),t),e.r=on.r,e.g=on.g,e.b=on.b,e}getStyle(e=Un){at.workingToColorSpace(on.copy(this),e);const t=on.r,i=on.g,r=on.b;return e!==Un?`color(${e} ${t.toFixed(3)} ${i.toFixed(3)} ${r.toFixed(3)})`:`rgb(${Math.round(t*255)},${Math.round(i*255)},${Math.round(r*255)})`}offsetHSL(e,t,i){return this.getHSL(Fi),this.setHSL(Fi.h+e,Fi.s+t,Fi.l+i)}add(e){return this.r+=e.r,this.g+=e.g,this.b+=e.b,this}addColors(e,t){return this.r=e.r+t.r,this.g=e.g+t.g,this.b=e.b+t.b,this}addScalar(e){return this.r+=e,this.g+=e,this.b+=e,this}sub(e){return this.r=Math.max(0,this.r-e.r),this.g=Math.max(0,this.g-e.g),this.b=Math.max(0,this.b-e.b),this}multiply(e){return this.r*=e.r,this.g*=e.g,this.b*=e.b,this}multiplyScalar(e){return this.r*=e,this.g*=e,this.b*=e,this}lerp(e,t){return this.r+=(e.r-this.r)*t,this.g+=(e.g-this.g)*t,this.b+=(e.b-this.b)*t,this}lerpColors(e,t,i){return this.r=e.r+(t.r-e.r)*i,this.g=e.g+(t.g-e.g)*i,this.b=e.b+(t.b-e.b)*i,this}lerpHSL(e,t){this.getHSL(Fi),e.getHSL(ia);const i=Ps(Fi.h,ia.h,t),r=Ps(Fi.s,ia.s,t),s=Ps(Fi.l,ia.l,t);return this.setHSL(i,r,s),this}setFromVector3(e){return this.r=e.x,this.g=e.y,this.b=e.z,this}applyMatrix3(e){const t=this.r,i=this.g,r=this.b,s=e.elements;return this.r=s[0]*t+s[3]*i+s[6]*r,this.g=s[1]*t+s[4]*i+s[7]*r,this.b=s[2]*t+s[5]*i+s[8]*r,this}equals(e){return e.r===this.r&&e.g===this.g&&e.b===this.b}fromArray(e,t=0){return this.r=e[t],this.g=e[t+1],this.b=e[t+2],this}toArray(e=[],t=0){return e[t]=this.r,e[t+1]=this.g,e[t+2]=this.b,e}fromBufferAttribute(e,t){return this.r=e.getX(t),this.g=e.getY(t),this.b=e.getZ(t),this}toJSON(){return this.getHex()}*[Symbol.iterator](){yield this.r,yield this.g,yield this.b}}const on=new ft;ft.NAMES=Ap;class Rp extends xn{constructor(){super(),this.isScene=!0,this.type="Scene",this.background=null,this.environment=null,this.fog=null,this.backgroundBlurriness=0,this.backgroundIntensity=1,this.backgroundRotation=new gr,this.environmentIntensity=1,this.environmentRotation=new gr,this.overrideMaterial=null,typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}copy(e,t){return super.copy(e,t),e.background!==null&&(this.background=e.background.clone()),e.environment!==null&&(this.environment=e.environment.clone()),e.fog!==null&&(this.fog=e.fog.clone()),this.backgroundBlurriness=e.backgroundBlurriness,this.backgroundIntensity=e.backgroundIntensity,this.backgroundRotation.copy(e.backgroundRotation),this.environmentIntensity=e.environmentIntensity,this.environmentRotation.copy(e.environmentRotation),e.overrideMaterial!==null&&(this.overrideMaterial=e.overrideMaterial.clone()),this.matrixAutoUpdate=e.matrixAutoUpdate,this}toJSON(e){const t=super.toJSON(e);return this.fog!==null&&(t.object.fog=this.fog.toJSON()),t.object.backgroundBlurriness=this.backgroundBlurriness,t.object.backgroundIntensity=this.backgroundIntensity,t.object.backgroundRotation=this.backgroundRotation.toArray(),t.object.environmentIntensity=this.environmentIntensity,t.object.environmentRotation=this.environmentRotation.toArray(),t}}const zn=new U,hi=new U,ol=new U,pi=new U,Tr=new U,Ar=new U,kf=new U,ll=new U,cl=new U,ul=new U,fl=new bt,dl=new bt,hl=new bt;class nn{constructor(e=new U,t=new U,i=new U){this.a=e,this.b=t,this.c=i}static getNormal(e,t,i,r){r.subVectors(i,t),zn.subVectors(e,t),r.cross(zn);const s=r.lengthSq();return s>0?r.multiplyScalar(1/Math.sqrt(s)):r.set(0,0,0)}static getBarycoord(e,t,i,r,s){zn.subVectors(r,t),hi.subVectors(i,t),ol.subVectors(e,t);const a=zn.dot(zn),o=zn.dot(hi),l=zn.dot(ol),c=hi.dot(hi),f=hi.dot(ol),d=a*c-o*o;if(d===0)return s.set(0,0,0),null;const u=1/d,h=(c*l-o*f)*u,_=(a*f-o*l)*u;return s.set(1-h-_,_,h)}static containsPoint(e,t,i,r){return this.getBarycoord(e,t,i,r,pi)===null?!1:pi.x>=0&&pi.y>=0&&pi.x+pi.y<=1}static getInterpolation(e,t,i,r,s,a,o,l){return this.getBarycoord(e,t,i,r,pi)===null?(l.x=0,l.y=0,"z"in l&&(l.z=0),"w"in l&&(l.w=0),null):(l.setScalar(0),l.addScaledVector(s,pi.x),l.addScaledVector(a,pi.y),l.addScaledVector(o,pi.z),l)}static getInterpolatedAttribute(e,t,i,r,s,a){return fl.setScalar(0),dl.setScalar(0),hl.setScalar(0),fl.fromBufferAttribute(e,t),dl.fromBufferAttribute(e,i),hl.fromBufferAttribute(e,r),a.setScalar(0),a.addScaledVector(fl,s.x),a.addScaledVector(dl,s.y),a.addScaledVector(hl,s.z),a}static isFrontFacing(e,t,i,r){return zn.subVectors(i,t),hi.subVectors(e,t),zn.cross(hi).dot(r)<0}set(e,t,i){return this.a.copy(e),this.b.copy(t),this.c.copy(i),this}setFromPointsAndIndices(e,t,i,r){return this.a.copy(e[t]),this.b.copy(e[i]),this.c.copy(e[r]),this}setFromAttributeAndIndices(e,t,i,r){return this.a.fromBufferAttribute(e,t),this.b.fromBufferAttribute(e,i),this.c.fromBufferAttribute(e,r),this}clone(){return new this.constructor().copy(this)}copy(e){return this.a.copy(e.a),this.b.copy(e.b),this.c.copy(e.c),this}getArea(){return zn.subVectors(this.c,this.b),hi.subVectors(this.a,this.b),zn.cross(hi).length()*.5}getMidpoint(e){return e.addVectors(this.a,this.b).add(this.c).multiplyScalar(1/3)}getNormal(e){return nn.getNormal(this.a,this.b,this.c,e)}getPlane(e){return e.setFromCoplanarPoints(this.a,this.b,this.c)}getBarycoord(e,t){return nn.getBarycoord(e,this.a,this.b,this.c,t)}getInterpolation(e,t,i,r,s){return nn.getInterpolation(e,this.a,this.b,this.c,t,i,r,s)}containsPoint(e){return nn.containsPoint(e,this.a,this.b,this.c)}isFrontFacing(e){return nn.isFrontFacing(this.a,this.b,this.c,e)}intersectsBox(e){return e.intersectsTriangle(this)}closestPointToPoint(e,t){const i=this.a,r=this.b,s=this.c;let a,o;Tr.subVectors(r,i),Ar.subVectors(s,i),ll.subVectors(e,i);const l=Tr.dot(ll),c=Ar.dot(ll);if(l<=0&&c<=0)return t.copy(i);cl.subVectors(e,r);const f=Tr.dot(cl),d=Ar.dot(cl);if(f>=0&&d<=f)return t.copy(r);const u=l*d-f*c;if(u<=0&&l>=0&&f<=0)return a=l/(l-f),t.copy(i).addScaledVector(Tr,a);ul.subVectors(e,s);const h=Tr.dot(ul),_=Ar.dot(ul);if(_>=0&&h<=_)return t.copy(s);const g=h*c-l*_;if(g<=0&&c>=0&&_<=0)return o=c/(c-_),t.copy(i).addScaledVector(Ar,o);const p=f*_-h*d;if(p<=0&&d-f>=0&&h-_>=0)return kf.subVectors(s,r),o=(d-f)/(d-f+(h-_)),t.copy(r).addScaledVector(kf,o);const m=1/(p+g+u);return a=g*m,o=u*m,t.copy(i).addScaledVector(Tr,a).addScaledVector(Ar,o)}equals(e){return e.a.equals(this.a)&&e.b.equals(this.b)&&e.c.equals(this.c)}}class yt{constructor(e=new U(1/0,1/0,1/0),t=new U(-1/0,-1/0,-1/0)){this.isBox3=!0,this.min=e,this.max=t}set(e,t){return this.min.copy(e),this.max.copy(t),this}setFromArray(e){this.makeEmpty();for(let t=0,i=e.length;t<i;t+=3)this.expandByPoint(Vn.fromArray(e,t));return this}setFromBufferAttribute(e){this.makeEmpty();for(let t=0,i=e.count;t<i;t++)this.expandByPoint(Vn.fromBufferAttribute(e,t));return this}setFromPoints(e){this.makeEmpty();for(let t=0,i=e.length;t<i;t++)this.expandByPoint(e[t]);return this}setFromCenterAndSize(e,t){const i=Vn.copy(t).multiplyScalar(.5);return this.min.copy(e).sub(i),this.max.copy(e).add(i),this}setFromObject(e,t=!1){return this.makeEmpty(),this.expandByObject(e,t)}clone(){return new this.constructor().copy(this)}copy(e){return this.min.copy(e.min),this.max.copy(e.max),this}makeEmpty(){return this.min.x=this.min.y=this.min.z=1/0,this.max.x=this.max.y=this.max.z=-1/0,this}isEmpty(){return this.max.x<this.min.x||this.max.y<this.min.y||this.max.z<this.min.z}getCenter(e){return this.isEmpty()?e.set(0,0,0):e.addVectors(this.min,this.max).multiplyScalar(.5)}getSize(e){return this.isEmpty()?e.set(0,0,0):e.subVectors(this.max,this.min)}expandByPoint(e){return this.min.min(e),this.max.max(e),this}expandByVector(e){return this.min.sub(e),this.max.add(e),this}expandByScalar(e){return this.min.addScalar(-e),this.max.addScalar(e),this}expandByObject(e,t=!1){e.updateWorldMatrix(!1,!1);const i=e.geometry;if(i!==void 0){const s=i.getAttribute("position");if(t===!0&&s!==void 0&&e.isInstancedMesh!==!0)for(let a=0,o=s.count;a<o;a++)e.isMesh===!0?e.getVertexPosition(a,Vn):Vn.fromBufferAttribute(s,a),Vn.applyMatrix4(e.matrixWorld),this.expandByPoint(Vn);else e.boundingBox!==void 0?(e.boundingBox===null&&e.computeBoundingBox(),ra.copy(e.boundingBox)):(i.boundingBox===null&&i.computeBoundingBox(),ra.copy(i.boundingBox)),ra.applyMatrix4(e.matrixWorld),this.union(ra)}const r=e.children;for(let s=0,a=r.length;s<a;s++)this.expandByObject(r[s],t);return this}containsPoint(e){return e.x>=this.min.x&&e.x<=this.max.x&&e.y>=this.min.y&&e.y<=this.max.y&&e.z>=this.min.z&&e.z<=this.max.z}containsBox(e){return this.min.x<=e.min.x&&e.max.x<=this.max.x&&this.min.y<=e.min.y&&e.max.y<=this.max.y&&this.min.z<=e.min.z&&e.max.z<=this.max.z}getParameter(e,t){return t.set((e.x-this.min.x)/(this.max.x-this.min.x),(e.y-this.min.y)/(this.max.y-this.min.y),(e.z-this.min.z)/(this.max.z-this.min.z))}intersectsBox(e){return e.max.x>=this.min.x&&e.min.x<=this.max.x&&e.max.y>=this.min.y&&e.min.y<=this.max.y&&e.max.z>=this.min.z&&e.min.z<=this.max.z}intersectsSphere(e){return this.clampPoint(e.center,Vn),Vn.distanceToSquared(e.center)<=e.radius*e.radius}intersectsPlane(e){let t,i;return e.normal.x>0?(t=e.normal.x*this.min.x,i=e.normal.x*this.max.x):(t=e.normal.x*this.max.x,i=e.normal.x*this.min.x),e.normal.y>0?(t+=e.normal.y*this.min.y,i+=e.normal.y*this.max.y):(t+=e.normal.y*this.max.y,i+=e.normal.y*this.min.y),e.normal.z>0?(t+=e.normal.z*this.min.z,i+=e.normal.z*this.max.z):(t+=e.normal.z*this.max.z,i+=e.normal.z*this.min.z),t<=-e.constant&&i>=-e.constant}intersectsTriangle(e){if(this.isEmpty())return!1;this.getCenter(cs),sa.subVectors(this.max,cs),Rr.subVectors(e.a,cs),Cr.subVectors(e.b,cs),Pr.subVectors(e.c,cs),Bi.subVectors(Cr,Rr),Oi.subVectors(Pr,Cr),Qi.subVectors(Rr,Pr);let t=[0,-Bi.z,Bi.y,0,-Oi.z,Oi.y,0,-Qi.z,Qi.y,Bi.z,0,-Bi.x,Oi.z,0,-Oi.x,Qi.z,0,-Qi.x,-Bi.y,Bi.x,0,-Oi.y,Oi.x,0,-Qi.y,Qi.x,0];return!pl(t,Rr,Cr,Pr,sa)||(t=[1,0,0,0,1,0,0,0,1],!pl(t,Rr,Cr,Pr,sa))?!1:(aa.crossVectors(Bi,Oi),t=[aa.x,aa.y,aa.z],pl(t,Rr,Cr,Pr,sa))}clampPoint(e,t){return t.copy(e).clamp(this.min,this.max)}distanceToPoint(e){return this.clampPoint(e,Vn).distanceTo(e)}getBoundingSphere(e){return this.isEmpty()?e.makeEmpty():(this.getCenter(e.center),e.radius=this.getSize(Vn).length()*.5),e}intersect(e){return this.min.max(e.min),this.max.min(e.max),this.isEmpty()&&this.makeEmpty(),this}union(e){return this.min.min(e.min),this.max.max(e.max),this}applyMatrix4(e){return this.isEmpty()?this:(mi[0].set(this.min.x,this.min.y,this.min.z).applyMatrix4(e),mi[1].set(this.min.x,this.min.y,this.max.z).applyMatrix4(e),mi[2].set(this.min.x,this.max.y,this.min.z).applyMatrix4(e),mi[3].set(this.min.x,this.max.y,this.max.z).applyMatrix4(e),mi[4].set(this.max.x,this.min.y,this.min.z).applyMatrix4(e),mi[5].set(this.max.x,this.min.y,this.max.z).applyMatrix4(e),mi[6].set(this.max.x,this.max.y,this.min.z).applyMatrix4(e),mi[7].set(this.max.x,this.max.y,this.max.z).applyMatrix4(e),this.setFromPoints(mi),this)}translate(e){return this.min.add(e),this.max.add(e),this}equals(e){return e.min.equals(this.min)&&e.max.equals(this.max)}toJSON(){return{min:this.min.toArray(),max:this.max.toArray()}}fromJSON(e){return this.min.fromArray(e.min),this.max.fromArray(e.max),this}}const mi=[new U,new U,new U,new U,new U,new U,new U,new U],Vn=new U,ra=new yt,Rr=new U,Cr=new U,Pr=new U,Bi=new U,Oi=new U,Qi=new U,cs=new U,sa=new U,aa=new U,ji=new U;function pl(n,e,t,i,r){for(let s=0,a=n.length-3;s<=a;s+=3){ji.fromArray(n,s);const o=r.x*Math.abs(ji.x)+r.y*Math.abs(ji.y)+r.z*Math.abs(ji.z),l=e.dot(ji),c=t.dot(ji),f=i.dot(ji);if(Math.max(-Math.max(l,c,f),Math.min(l,c,f))>o)return!1}return!0}const kt=new U,oa=new Ze;let av=0;class Kt extends vr{constructor(e,t,i=!1){if(super(),Array.isArray(e))throw new TypeError("THREE.BufferAttribute: array should be a Typed Array.");this.isBufferAttribute=!0,Object.defineProperty(this,"id",{value:av++}),this.name="",this.array=e,this.itemSize=t,this.count=e!==void 0?e.length/t:0,this.normalized=i,this.usage=Mp,this.updateRanges=[],this.gpuType=si,this.version=0}onUploadCallback(){}set needsUpdate(e){e===!0&&this.version++}setUsage(e){return this.usage=e,this}addUpdateRange(e,t){this.updateRanges.push({start:e,count:t})}clearUpdateRanges(){this.updateRanges.length=0}copy(e){return this.name=e.name,this.array=new e.array.constructor(e.array),this.itemSize=e.itemSize,this.count=e.count,this.normalized=e.normalized,this.usage=e.usage,this.gpuType=e.gpuType,this}copyAt(e,t,i){e*=this.itemSize,i*=t.itemSize;for(let r=0,s=this.itemSize;r<s;r++)this.array[e+r]=t.array[i+r];return this}copyArray(e){return this.array.set(e),this}applyMatrix3(e){if(this.itemSize===2)for(let t=0,i=this.count;t<i;t++)oa.fromBufferAttribute(this,t),oa.applyMatrix3(e),this.setXY(t,oa.x,oa.y);else if(this.itemSize===3)for(let t=0,i=this.count;t<i;t++)kt.fromBufferAttribute(this,t),kt.applyMatrix3(e),this.setXYZ(t,kt.x,kt.y,kt.z);return this}applyMatrix4(e){for(let t=0,i=this.count;t<i;t++)kt.fromBufferAttribute(this,t),kt.applyMatrix4(e),this.setXYZ(t,kt.x,kt.y,kt.z);return this}applyNormalMatrix(e){for(let t=0,i=this.count;t<i;t++)kt.fromBufferAttribute(this,t),kt.applyNormalMatrix(e),this.setXYZ(t,kt.x,kt.y,kt.z);return this}transformDirection(e){for(let t=0,i=this.count;t<i;t++)kt.fromBufferAttribute(this,t),kt.transformDirection(e),this.setXYZ(t,kt.x,kt.y,kt.z);return this}set(e,t=0){return this.array.set(e,t),this}getComponent(e,t){let i=this.array[e*this.itemSize+t];return this.normalized&&(i=Gn(i,this.array)),i}setComponent(e,t,i){return this.normalized&&(i=gt(i,this.array)),this.array[e*this.itemSize+t]=i,this}getX(e){let t=this.array[e*this.itemSize];return this.normalized&&(t=Gn(t,this.array)),t}setX(e,t){return this.normalized&&(t=gt(t,this.array)),this.array[e*this.itemSize]=t,this}getY(e){let t=this.array[e*this.itemSize+1];return this.normalized&&(t=Gn(t,this.array)),t}setY(e,t){return this.normalized&&(t=gt(t,this.array)),this.array[e*this.itemSize+1]=t,this}getZ(e){let t=this.array[e*this.itemSize+2];return this.normalized&&(t=Gn(t,this.array)),t}setZ(e,t){return this.normalized&&(t=gt(t,this.array)),this.array[e*this.itemSize+2]=t,this}getW(e){let t=this.array[e*this.itemSize+3];return this.normalized&&(t=Gn(t,this.array)),t}setW(e,t){return this.normalized&&(t=gt(t,this.array)),this.array[e*this.itemSize+3]=t,this}setXY(e,t,i){return e*=this.itemSize,this.normalized&&(t=gt(t,this.array),i=gt(i,this.array)),this.array[e+0]=t,this.array[e+1]=i,this}setXYZ(e,t,i,r){return e*=this.itemSize,this.normalized&&(t=gt(t,this.array),i=gt(i,this.array),r=gt(r,this.array)),this.array[e+0]=t,this.array[e+1]=i,this.array[e+2]=r,this}setXYZW(e,t,i,r,s){return e*=this.itemSize,this.normalized&&(t=gt(t,this.array),i=gt(i,this.array),r=gt(r,this.array),s=gt(s,this.array)),this.array[e+0]=t,this.array[e+1]=i,this.array[e+2]=r,this.array[e+3]=s,this}onUpload(e){return this.onUploadCallback=e,this}clone(){return new this.constructor(this.array,this.itemSize).copy(this)}toJSON(){const e={itemSize:this.itemSize,type:this.array.constructor.name,array:Array.from(this.array),normalized:this.normalized};return e.name=this.name,e.usage=this.usage,e.gpuType=this.gpuType,e}dispose(){this.dispatchEvent({type:"dispose"})}}class Cp extends Kt{constructor(e,t,i){super(new Uint16Array(e),t,i)}}class Pp extends Kt{constructor(e,t,i){super(new Uint32Array(e),t,i)}}class Wt extends Kt{constructor(e,t,i){super(new Float32Array(e),t,i)}}const ov=new yt,us=new U,ml=new U;class Yn{constructor(e=new U,t=-1){this.isSphere=!0,this.center=e,this.radius=t}set(e,t){return this.center.copy(e),this.radius=t,this}setFromPoints(e,t){const i=this.center;t!==void 0?i.copy(t):ov.setFromPoints(e).getCenter(i);let r=0;for(let s=0,a=e.length;s<a;s++)r=Math.max(r,i.distanceToSquared(e[s]));return this.radius=Math.sqrt(r),this}copy(e){return this.center.copy(e.center),this.radius=e.radius,this}isEmpty(){return this.radius<0}makeEmpty(){return this.center.set(0,0,0),this.radius=-1,this}containsPoint(e){return e.distanceToSquared(this.center)<=this.radius*this.radius}distanceToPoint(e){return e.distanceTo(this.center)-this.radius}intersectsSphere(e){const t=this.radius+e.radius;return e.center.distanceToSquared(this.center)<=t*t}intersectsBox(e){return e.intersectsSphere(this)}intersectsPlane(e){return Math.abs(e.distanceToPoint(this.center))<=this.radius}clampPoint(e,t){const i=this.center.distanceToSquared(e);return t.copy(e),i>this.radius*this.radius&&(t.sub(this.center).normalize(),t.multiplyScalar(this.radius).add(this.center)),t}getBoundingBox(e){return this.isEmpty()?(e.makeEmpty(),e):(e.set(this.center,this.center),e.expandByScalar(this.radius),e)}applyMatrix4(e){return this.center.applyMatrix4(e),this.radius=this.radius*e.getMaxScaleOnAxis(),this}translate(e){return this.center.add(e),this}expandByPoint(e){if(this.isEmpty())return this.center.copy(e),this.radius=0,this;us.subVectors(e,this.center);const t=us.lengthSq();if(t>this.radius*this.radius){const i=Math.sqrt(t),r=(i-this.radius)*.5;this.center.addScaledVector(us,r/i),this.radius+=r}return this}union(e){return e.isEmpty()?this:this.isEmpty()?(this.copy(e),this):(this.center.equals(e.center)===!0?this.radius=Math.max(this.radius,e.radius):(ml.subVectors(e.center,this.center).setLength(e.radius),this.expandByPoint(us.copy(e.center).add(ml)),this.expandByPoint(us.copy(e.center).sub(ml))),this)}equals(e){return e.center.equals(this.center)&&e.radius===this.radius}clone(){return new this.constructor().copy(this)}toJSON(){return{radius:this.radius,center:this.center.toArray()}}fromJSON(e){return this.radius=e.radius,this.center.fromArray(e.center),this}}let lv=0;const Nn=new et,gl=new xn,Lr=new U,An=new yt,fs=new yt,Yt=new U;class Jt extends vr{constructor(){super(),this.isBufferGeometry=!0,Object.defineProperty(this,"id",{value:lv++}),this.uuid=Ei(),this.name="",this.type="BufferGeometry",this.index=null,this.indirect=null,this.indirectOffset=0,this.attributes={},this.morphAttributes={},this.morphTargetsRelative=!1,this.groups=[],this.boundingBox=null,this.boundingSphere=null,this.drawRange={start:0,count:1/0},this.userData={},this._transformed=!1}getIndex(){return this.index}setIndex(e){return Array.isArray(e)?this.index=new(T_(e)?Pp:Cp)(e,1):this.index=e,this}setIndirect(e,t=0){return this.indirect=e,this.indirectOffset=t,this}getIndirect(){return this.indirect}getAttribute(e){return this.attributes[e]}setAttribute(e,t){return this.attributes[e]=t,this}deleteAttribute(e){return delete this.attributes[e],this}hasAttribute(e){return this.attributes[e]!==void 0}addGroup(e,t,i=0){this.groups.push({start:e,count:t,materialIndex:i})}clearGroups(){this.groups=[]}setDrawRange(e,t){this.drawRange.start=e,this.drawRange.count=t}applyMatrix4(e){const t=this.attributes.position;t!==void 0&&(t.applyMatrix4(e),t.needsUpdate=!0);const i=this.attributes.normal;if(i!==void 0){const s=new We().getNormalMatrix(e);i.applyNormalMatrix(s),i.needsUpdate=!0}const r=this.attributes.tangent;return r!==void 0&&(r.transformDirection(e),r.needsUpdate=!0),this.boundingBox!==null&&this.computeBoundingBox(),this.boundingSphere!==null&&this.computeBoundingSphere(),this._transformed=!0,this}applyQuaternion(e){return Nn.makeRotationFromQuaternion(e),this.applyMatrix4(Nn),this}rotateX(e){return Nn.makeRotationX(e),this.applyMatrix4(Nn),this}rotateY(e){return Nn.makeRotationY(e),this.applyMatrix4(Nn),this}rotateZ(e){return Nn.makeRotationZ(e),this.applyMatrix4(Nn),this}translate(e,t,i){return Nn.makeTranslation(e,t,i),this.applyMatrix4(Nn),this}scale(e,t,i){return Nn.makeScale(e,t,i),this.applyMatrix4(Nn),this}lookAt(e){return gl.lookAt(e),gl.updateMatrix(),this.applyMatrix4(gl.matrix),this}center(){return this.computeBoundingBox(),this.boundingBox.getCenter(Lr).negate(),this.translate(Lr.x,Lr.y,Lr.z),this}setFromPoints(e){const t=this.getAttribute("position");if(t===void 0){const i=[];for(let r=0,s=e.length;r<s;r++){const a=e[r];i.push(a.x,a.y,a.z||0)}this.setAttribute("position",new Wt(i,3))}else{const i=Math.min(e.length,t.count);for(let r=0;r<i;r++){const s=e[r];t.setXYZ(r,s.x,s.y,s.z||0)}e.length>t.count&&ze("BufferGeometry: Buffer size too small for points data. Use .dispose() and create a new geometry."),t.needsUpdate=!0}return this}computeBoundingBox(){this.boundingBox===null&&(this.boundingBox=new yt);const e=this.attributes.position,t=this.morphAttributes.position;if(e&&e.isGLBufferAttribute){ut("BufferGeometry.computeBoundingBox(): GLBufferAttribute requires a manual bounding box.",this),this.boundingBox.set(new U(-1/0,-1/0,-1/0),new U(1/0,1/0,1/0));return}if(e!==void 0){if(this.boundingBox.setFromBufferAttribute(e),t)for(let i=0,r=t.length;i<r;i++){const s=t[i];An.setFromBufferAttribute(s),this.morphTargetsRelative?(Yt.addVectors(this.boundingBox.min,An.min),this.boundingBox.expandByPoint(Yt),Yt.addVectors(this.boundingBox.max,An.max),this.boundingBox.expandByPoint(Yt)):(this.boundingBox.expandByPoint(An.min),this.boundingBox.expandByPoint(An.max))}}else this.boundingBox.makeEmpty();(isNaN(this.boundingBox.min.x)||isNaN(this.boundingBox.min.y)||isNaN(this.boundingBox.min.z))&&ut('BufferGeometry.computeBoundingBox(): Computed min/max have NaN values. The "position" attribute is likely to have NaN values.',this)}computeBoundingSphere(){this.boundingSphere===null&&(this.boundingSphere=new Yn);const e=this.attributes.position,t=this.morphAttributes.position;if(e&&e.isGLBufferAttribute){ut("BufferGeometry.computeBoundingSphere(): GLBufferAttribute requires a manual bounding sphere.",this),this.boundingSphere.set(new U,1/0);return}if(e){const i=this.boundingSphere.center;if(An.setFromBufferAttribute(e),t)for(let s=0,a=t.length;s<a;s++){const o=t[s];fs.setFromBufferAttribute(o),this.morphTargetsRelative?(Yt.addVectors(An.min,fs.min),An.expandByPoint(Yt),Yt.addVectors(An.max,fs.max),An.expandByPoint(Yt)):(An.expandByPoint(fs.min),An.expandByPoint(fs.max))}An.getCenter(i);let r=0;for(let s=0,a=e.count;s<a;s++)Yt.fromBufferAttribute(e,s),r=Math.max(r,i.distanceToSquared(Yt));if(t)for(let s=0,a=t.length;s<a;s++){const o=t[s],l=this.morphTargetsRelative;for(let c=0,f=o.count;c<f;c++)Yt.fromBufferAttribute(o,c),l&&(Lr.fromBufferAttribute(e,c),Yt.add(Lr)),r=Math.max(r,i.distanceToSquared(Yt))}this.boundingSphere.radius=Math.sqrt(r),isNaN(this.boundingSphere.radius)&&ut('BufferGeometry.computeBoundingSphere(): Computed radius is NaN. The "position" attribute is likely to have NaN values.',this)}}computeTangents(){const e=this.index,t=this.attributes;if(e===null||t.position===void 0||t.normal===void 0||t.uv===void 0){ut("BufferGeometry: .computeTangents() failed. Missing required attributes (index, position, normal or uv)");return}const i=t.position,r=t.normal,s=t.uv;let a=this.getAttribute("tangent");(a===void 0||a.count!==i.count)&&(a=new Kt(new Float32Array(4*i.count),4),this.setAttribute("tangent",a));const o=[],l=[];for(let b=0;b<i.count;b++)o[b]=new U,l[b]=new U;const c=new U,f=new U,d=new U,u=new Ze,h=new Ze,_=new Ze,g=new U,p=new U;function m(b,T,C){c.fromBufferAttribute(i,b),f.fromBufferAttribute(i,T),d.fromBufferAttribute(i,C),u.fromBufferAttribute(s,b),h.fromBufferAttribute(s,T),_.fromBufferAttribute(s,C),f.sub(c),d.sub(c),h.sub(u),_.sub(u);const D=1/(h.x*_.y-_.x*h.y);isFinite(D)&&(g.copy(f).multiplyScalar(_.y).addScaledVector(d,-h.y).multiplyScalar(D),p.copy(d).multiplyScalar(h.x).addScaledVector(f,-_.x).multiplyScalar(D),o[b].add(g),o[T].add(g),o[C].add(g),l[b].add(p),l[T].add(p),l[C].add(p))}let v=this.groups;v.length===0&&(v=[{start:0,count:e.count}]);for(let b=0,T=v.length;b<T;++b){const C=v[b],D=C.start,R=C.count;for(let N=D,I=D+R;N<I;N+=3)m(e.getX(N+0),e.getX(N+1),e.getX(N+2))}const w=new U,y=new U,S=new U,M=new U;function E(b){S.fromBufferAttribute(r,b),M.copy(S);const T=o[b];w.copy(T),w.sub(S.multiplyScalar(S.dot(T))).normalize(),y.crossVectors(M,T);const D=y.dot(l[b])<0?-1:1;a.setXYZW(b,w.x,w.y,w.z,D)}for(let b=0,T=v.length;b<T;++b){const C=v[b],D=C.start,R=C.count;for(let N=D,I=D+R;N<I;N+=3)E(e.getX(N+0)),E(e.getX(N+1)),E(e.getX(N+2))}this._transformed=!0}computeVertexNormals(){const e=this.index,t=this.getAttribute("position");if(t!==void 0){let i=this.getAttribute("normal");if(i===void 0||i.count!==t.count)i=new Kt(new Float32Array(t.count*3),3),this.setAttribute("normal",i);else for(let u=0,h=i.count;u<h;u++)i.setXYZ(u,0,0,0);const r=new U,s=new U,a=new U,o=new U,l=new U,c=new U,f=new U,d=new U;if(e)for(let u=0,h=e.count;u<h;u+=3){const _=e.getX(u+0),g=e.getX(u+1),p=e.getX(u+2);r.fromBufferAttribute(t,_),s.fromBufferAttribute(t,g),a.fromBufferAttribute(t,p),f.subVectors(a,s),d.subVectors(r,s),f.cross(d),o.fromBufferAttribute(i,_),l.fromBufferAttribute(i,g),c.fromBufferAttribute(i,p),o.add(f),l.add(f),c.add(f),i.setXYZ(_,o.x,o.y,o.z),i.setXYZ(g,l.x,l.y,l.z),i.setXYZ(p,c.x,c.y,c.z)}else for(let u=0,h=t.count;u<h;u+=3)r.fromBufferAttribute(t,u+0),s.fromBufferAttribute(t,u+1),a.fromBufferAttribute(t,u+2),f.subVectors(a,s),d.subVectors(r,s),f.cross(d),i.setXYZ(u+0,f.x,f.y,f.z),i.setXYZ(u+1,f.x,f.y,f.z),i.setXYZ(u+2,f.x,f.y,f.z);this.normalizeNormals(),i.needsUpdate=!0}}normalizeNormals(){const e=this.attributes.normal;for(let t=0,i=e.count;t<i;t++)Yt.fromBufferAttribute(e,t),Yt.normalize(),e.setXYZ(t,Yt.x,Yt.y,Yt.z)}toNonIndexed(){function e(o,l){const c=o.array,f=o.itemSize,d=o.normalized,u=new c.constructor(l.length*f);let h=0,_=0;for(let g=0,p=l.length;g<p;g++){o.isInterleavedBufferAttribute?h=l[g]*o.data.stride+o.offset:h=l[g]*f;for(let m=0;m<f;m++)u[_++]=c[h++]}return new Kt(u,f,d)}if(this.index===null)return ze("BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed."),this;const t=new Jt,i=this.index.array,r=this.attributes;for(const o in r){const l=r[o],c=e(l,i);t.setAttribute(o,c)}const s=this.morphAttributes;for(const o in s){const l=[],c=s[o];for(let f=0,d=c.length;f<d;f++){const u=c[f],h=e(u,i);l.push(h)}t.morphAttributes[o]=l}t.morphTargetsRelative=this.morphTargetsRelative;const a=this.groups;for(let o=0,l=a.length;o<l;o++){const c=a[o];t.addGroup(c.start,c.count,c.materialIndex)}return t}toJSON(){const e={metadata:{version:4.7,type:"BufferGeometry",generator:"BufferGeometry.toJSON"}};if(e.uuid=this.uuid,e.type=this.parameters!==void 0&&this._transformed===!0?"BufferGeometry":this.type,e.name=this.name,Object.keys(this.userData).length>0&&(e.userData=this.userData),this.parameters!==void 0&&this._transformed!==!0){const l=this.parameters;for(const c in l)l[c]!==void 0&&(e[c]=l[c]);return e}e.data={attributes:{}};const t=this.index;t!==null&&(e.data.index={type:t.array.constructor.name,array:Array.prototype.slice.call(t.array)});const i=this.attributes;for(const l in i){const c=i[l];e.data.attributes[l]=c.toJSON(e.data)}const r={};let s=!1;for(const l in this.morphAttributes){const c=this.morphAttributes[l],f=[];for(let d=0,u=c.length;d<u;d++){const h=c[d];f.push(h.toJSON(e.data))}f.length>0&&(r[l]=f,s=!0)}s&&(e.data.morphAttributes=r,e.data.morphTargetsRelative=this.morphTargetsRelative);const a=this.groups;a.length>0&&(e.data.groups=JSON.parse(JSON.stringify(a)));const o=this.boundingSphere;return o!==null&&(e.data.boundingSphere=o.toJSON()),e}clone(){return new this.constructor().copy(this)}copy(e){this.index=null,this.attributes={},this.morphAttributes={},this.groups=[],this.boundingBox=null,this.boundingSphere=null;const t={};this.name=e.name;const i=e.index;i!==null&&this.setIndex(i.clone());const r=e.attributes;for(const c in r){const f=r[c];this.setAttribute(c,f.clone(t))}const s=e.morphAttributes;for(const c in s){const f=[],d=s[c];for(let u=0,h=d.length;u<h;u++)f.push(d[u].clone(t));this.morphAttributes[c]=f}this.morphTargetsRelative=e.morphTargetsRelative;const a=e.groups;for(let c=0,f=a.length;c<f;c++){const d=a[c];this.addGroup(d.start,d.count,d.materialIndex)}const o=e.boundingBox;o!==null&&(this.boundingBox=o.clone());const l=e.boundingSphere;return l!==null&&(this.boundingSphere=l.clone()),this.drawRange.start=e.drawRange.start,this.drawRange.count=e.drawRange.count,this.userData=e.userData,this._transformed=e._transformed,this}dispose(){this.dispatchEvent({type:"dispose"})}}class cv{constructor(e,t){this.isInterleavedBuffer=!0,this.array=e,this.stride=t,this.count=e!==void 0?e.length/t:0,this.usage=Mp,this.updateRanges=[],this.version=0,this.uuid=Ei()}onUploadCallback(){}set needsUpdate(e){e===!0&&this.version++}setUsage(e){return this.usage=e,this}addUpdateRange(e,t){this.updateRanges.push({start:e,count:t})}clearUpdateRanges(){this.updateRanges.length=0}copy(e){return this.array=new e.array.constructor(e.array),this.count=e.count,this.stride=e.stride,this.usage=e.usage,this}copyAt(e,t,i){e*=this.stride,i*=t.stride;for(let r=0,s=this.stride;r<s;r++)this.array[e+r]=t.array[i+r];return this}set(e,t=0){return this.array.set(e,t),this}clone(e){e.arrayBuffers===void 0&&(e.arrayBuffers={}),this.array.buffer._uuid===void 0&&(this.array.buffer._uuid=Ei()),e.arrayBuffers[this.array.buffer._uuid]===void 0&&(e.arrayBuffers[this.array.buffer._uuid]=this.array.slice(0).buffer);const t=new this.array.constructor(e.arrayBuffers[this.array.buffer._uuid]),i=new this.constructor(t,this.stride);return i.setUsage(this.usage),i}onUpload(e){return this.onUploadCallback=e,this}toJSON(e){e.arrayBuffers===void 0&&(e.arrayBuffers={}),this.array.buffer._uuid===void 0&&(this.array.buffer._uuid=Ei()),e.arrayBuffers[this.array.buffer._uuid]===void 0&&(e.arrayBuffers[this.array.buffer._uuid]=Array.from(new Uint32Array(this.array.buffer)));const t={uuid:this.uuid,buffer:this.array.buffer._uuid,type:this.array.constructor.name,stride:this.stride};return t.usage=this.usage,t}}const mn=new U;class qi{constructor(e,t,i,r=!1){this.isInterleavedBufferAttribute=!0,this.name="",this.data=e,this.itemSize=t,this.offset=i,this.normalized=r}get count(){return this.data.count}get array(){return this.data.array}set needsUpdate(e){this.data.needsUpdate=e}applyMatrix4(e){for(let t=0,i=this.data.count;t<i;t++)mn.fromBufferAttribute(this,t),mn.applyMatrix4(e),this.setXYZ(t,mn.x,mn.y,mn.z);return this}applyNormalMatrix(e){for(let t=0,i=this.count;t<i;t++)mn.fromBufferAttribute(this,t),mn.applyNormalMatrix(e),this.setXYZ(t,mn.x,mn.y,mn.z);return this}transformDirection(e){for(let t=0,i=this.count;t<i;t++)mn.fromBufferAttribute(this,t),mn.transformDirection(e),this.setXYZ(t,mn.x,mn.y,mn.z);return this}getComponent(e,t){let i=this.array[e*this.data.stride+this.offset+t];return this.normalized&&(i=Gn(i,this.array)),i}setComponent(e,t,i){return this.normalized&&(i=gt(i,this.array)),this.data.array[e*this.data.stride+this.offset+t]=i,this}setX(e,t){return this.normalized&&(t=gt(t,this.array)),this.data.array[e*this.data.stride+this.offset]=t,this}setY(e,t){return this.normalized&&(t=gt(t,this.array)),this.data.array[e*this.data.stride+this.offset+1]=t,this}setZ(e,t){return this.normalized&&(t=gt(t,this.array)),this.data.array[e*this.data.stride+this.offset+2]=t,this}setW(e,t){return this.normalized&&(t=gt(t,this.array)),this.data.array[e*this.data.stride+this.offset+3]=t,this}getX(e){let t=this.data.array[e*this.data.stride+this.offset];return this.normalized&&(t=Gn(t,this.array)),t}getY(e){let t=this.data.array[e*this.data.stride+this.offset+1];return this.normalized&&(t=Gn(t,this.array)),t}getZ(e){let t=this.data.array[e*this.data.stride+this.offset+2];return this.normalized&&(t=Gn(t,this.array)),t}getW(e){let t=this.data.array[e*this.data.stride+this.offset+3];return this.normalized&&(t=Gn(t,this.array)),t}setXY(e,t,i){return e=e*this.data.stride+this.offset,this.normalized&&(t=gt(t,this.array),i=gt(i,this.array)),this.data.array[e+0]=t,this.data.array[e+1]=i,this}setXYZ(e,t,i,r){return e=e*this.data.stride+this.offset,this.normalized&&(t=gt(t,this.array),i=gt(i,this.array),r=gt(r,this.array)),this.data.array[e+0]=t,this.data.array[e+1]=i,this.data.array[e+2]=r,this}setXYZW(e,t,i,r,s){return e=e*this.data.stride+this.offset,this.normalized&&(t=gt(t,this.array),i=gt(i,this.array),r=gt(r,this.array),s=gt(s,this.array)),this.data.array[e+0]=t,this.data.array[e+1]=i,this.data.array[e+2]=r,this.data.array[e+3]=s,this}clone(e){if(e===void 0){Eo("InterleavedBufferAttribute.clone(): Cloning an interleaved buffer attribute will de-interleave buffer data.");const t=[];for(let i=0;i<this.count;i++){const r=i*this.data.stride+this.offset;for(let s=0;s<this.itemSize;s++)t.push(this.data.array[r+s])}return new Kt(new this.array.constructor(t),this.itemSize,this.normalized)}else return e.interleavedBuffers===void 0&&(e.interleavedBuffers={}),e.interleavedBuffers[this.data.uuid]===void 0&&(e.interleavedBuffers[this.data.uuid]=this.data.clone(e)),new qi(e.interleavedBuffers[this.data.uuid],this.itemSize,this.offset,this.normalized)}toJSON(e){if(e===void 0){Eo("InterleavedBufferAttribute.toJSON(): Serializing an interleaved buffer attribute will de-interleave buffer data.");const t=[];for(let i=0;i<this.count;i++){const r=i*this.data.stride+this.offset;for(let s=0;s<this.itemSize;s++)t.push(this.data.array[r+s])}return{itemSize:this.itemSize,type:this.array.constructor.name,array:t,normalized:this.normalized}}else return e.interleavedBuffers===void 0&&(e.interleavedBuffers={}),e.interleavedBuffers[this.data.uuid]===void 0&&(e.interleavedBuffers[this.data.uuid]=this.data.toJSON(e)),{isInterleavedBufferAttribute:!0,itemSize:this.itemSize,data:this.data.uuid,offset:this.offset,normalized:this.normalized}}}const _l=new U,uv=new U,fv=new We;class Fn{constructor(e=new U(1,0,0),t=0){this.isPlane=!0,this.normal=e,this.constant=t}set(e,t){return this.normal.copy(e),this.constant=t,this}setComponents(e,t,i,r){return this.normal.set(e,t,i),this.constant=r,this}setFromNormalAndCoplanarPoint(e,t){return this.normal.copy(e),this.constant=-t.dot(this.normal),this}setFromCoplanarPoints(e,t,i){const r=_l.subVectors(i,t).cross(uv.subVectors(e,t)).normalize();return this.setFromNormalAndCoplanarPoint(r,e),this}copy(e){return this.normal.copy(e.normal),this.constant=e.constant,this}normalize(){const e=1/this.normal.length();return this.normal.multiplyScalar(e),this.constant*=e,this}negate(){return this.constant*=-1,this.normal.negate(),this}distanceToPoint(e){return this.normal.dot(e)+this.constant}distanceToSphere(e){return this.distanceToPoint(e.center)-e.radius}projectPoint(e,t){return t.copy(e).addScaledVector(this.normal,-this.distanceToPoint(e))}intersectLine(e,t,i=!0){const r=e.delta(_l),s=this.normal.dot(r);if(s===0)return this.distanceToPoint(e.start)===0?t.copy(e.start):null;const a=-(e.start.dot(this.normal)+this.constant)/s;return i===!0&&(a<0||a>1)?null:t.copy(e.start).addScaledVector(r,a)}intersectsLine(e){const t=this.distanceToPoint(e.start),i=this.distanceToPoint(e.end);return t<0&&i>0||i<0&&t>0}intersectsBox(e){return e.intersectsPlane(this)}intersectsSphere(e){return e.intersectsPlane(this)}coplanarPoint(e){return e.copy(this.normal).multiplyScalar(-this.constant)}applyMatrix4(e,t){const i=t||fv.getNormalMatrix(e),r=this.coplanarPoint(_l).applyMatrix4(e),s=this.normal.applyMatrix3(i).normalize();return this.constant=-r.dot(s),this}translate(e){return this.constant-=e.dot(this.normal),this}equals(e){return e.normal.equals(this.normal)&&e.constant===this.constant}clone(){return new this.constructor().copy(this)}toJSON(){return{normal:this.normal.toArray(),constant:this.constant}}fromJSON(e){return this.normal.fromArray(e.normal),this.constant=e.constant,this}}let dv=0;class es extends vr{constructor(){super(),this.isMaterial=!0,Object.defineProperty(this,"id",{value:dv++}),this.uuid=Ei(),this.name="",this.type="Material",this.blending=Rs,this.side=li,this.vertexColors=!1,this.opacity=1,this.transparent=!1,this.alphaHash=!1,this.blendSrc=rp,this.blendDst=sp,this.blendEquation=$r,this.blendSrcAlpha=null,this.blendDstAlpha=null,this.blendEquationAlpha=null,this.blendColor=new ft(0,0,0),this.blendAlpha=0,this.depthFunc=Jr,this.depthTest=!0,this.depthWrite=!0,this.stencilWriteMask=255,this.stencilFunc=Sp,this.stencilRef=0,this.stencilFuncMask=255,this.stencilFail=Qo,this.stencilZFail=Qo,this.stencilZPass=Qo,this.stencilWrite=!1,this.clippingPlanes=null,this.clipIntersection=!1,this.clipShadows=!1,this.shadowSide=null,this.colorWrite=!0,this.precision=null,this.polygonOffset=!1,this.polygonOffsetFactor=0,this.polygonOffsetUnits=0,this.dithering=!1,this.alphaToCoverage=!1,this.premultipliedAlpha=!1,this.forceSinglePass=!1,this.allowOverride=!0,this.visible=!0,this.toneMapped=!0,this.userData={},this.version=0,this._alphaTest=0}get alphaTest(){return this._alphaTest}set alphaTest(e){this._alphaTest>0!=e>0&&this.version++,this._alphaTest=e}onBeforeRender(){}onBeforeCompile(){}customProgramCacheKey(){return this.onBeforeCompile.toString()}setValues(e){if(e!==void 0)for(const t in e){const i=e[t];if(i===void 0){ze(`Material: parameter '${t}' has value of undefined.`);continue}const r=this[t];if(r===void 0){ze(`Material: '${t}' is not a property of THREE.${this.type}.`);continue}r&&r.isColor?r.set(i):r&&r.isVector2&&i&&i.isVector2||r&&r.isEuler&&i&&i.isEuler||r&&r.isVector3&&i&&i.isVector3?r.copy(i):this[t]=i}}toJSON(e){const t=e===void 0||typeof e=="string";t&&(e={textures:{},images:{}});const i={metadata:{version:4.7,type:"Material",generator:"Material.toJSON"}};i.uuid=this.uuid,i.type=this.type,i.blending=this.blending,i.side=this.side,i.shadowSide=this.shadowSide,i.vertexColors=this.vertexColors,i.opacity=this.opacity,i.transparent=this.transparent,i.blendSrc=this.blendSrc,i.blendDst=this.blendDst,i.blendEquation=this.blendEquation,i.blendSrcAlpha=this.blendSrcAlpha,i.blendDstAlpha=this.blendDstAlpha,i.blendEquationAlpha=this.blendEquationAlpha,i.blendColor=this.blendColor.getHex(),i.blendAlpha=this.blendAlpha,i.depthFunc=this.depthFunc,i.depthTest=this.depthTest,i.depthWrite=this.depthWrite,i.colorWrite=this.colorWrite,i.clipIntersection=this.clipIntersection,i.clipShadows=this.clipShadows,i.stencilWriteMask=this.stencilWriteMask,i.stencilFunc=this.stencilFunc,i.stencilRef=this.stencilRef,i.stencilFuncMask=this.stencilFuncMask,i.stencilFail=this.stencilFail,i.stencilZFail=this.stencilZFail,i.stencilZPass=this.stencilZPass,i.stencilWrite=this.stencilWrite,i.polygonOffset=this.polygonOffset,i.polygonOffsetFactor=this.polygonOffsetFactor,i.polygonOffsetUnits=this.polygonOffsetUnits,i.dithering=this.dithering,i.alphaTest=this.alphaTest,i.alphaHash=this.alphaHash,i.alphaToCoverage=this.alphaToCoverage,i.premultipliedAlpha=this.premultipliedAlpha,i.forceSinglePass=this.forceSinglePass,i.allowOverride=this.allowOverride,i.visible=this.visible,i.toneMapped=this.toneMapped,i.name=this.name,this.color&&this.color.isColor&&(i.color=this.color.getHex()),this.roughness!==void 0&&(i.roughness=this.roughness),this.metalness!==void 0&&(i.metalness=this.metalness),this.sheen!==void 0&&(i.sheen=this.sheen),this.sheenColor&&this.sheenColor.isColor&&(i.sheenColor=this.sheenColor.getHex()),this.sheenRoughness!==void 0&&(i.sheenRoughness=this.sheenRoughness),this.emissive&&this.emissive.isColor&&(i.emissive=this.emissive.getHex()),this.emissiveIntensity!==void 0&&(i.emissiveIntensity=this.emissiveIntensity),this.specular&&this.specular.isColor&&(i.specular=this.specular.getHex()),this.specularIntensity!==void 0&&(i.specularIntensity=this.specularIntensity),this.specularColor&&this.specularColor.isColor&&(i.specularColor=this.specularColor.getHex()),this.shininess!==void 0&&(i.shininess=this.shininess),this.clearcoat!==void 0&&(i.clearcoat=this.clearcoat),this.clearcoatRoughness!==void 0&&(i.clearcoatRoughness=this.clearcoatRoughness),this.clearcoatMap&&this.clearcoatMap.isTexture&&(i.clearcoatMap=this.clearcoatMap.toJSON(e).uuid),this.clearcoatRoughnessMap&&this.clearcoatRoughnessMap.isTexture&&(i.clearcoatRoughnessMap=this.clearcoatRoughnessMap.toJSON(e).uuid),this.clearcoatNormalMap&&this.clearcoatNormalMap.isTexture&&(i.clearcoatNormalMap=this.clearcoatNormalMap.toJSON(e).uuid,i.clearcoatNormalScale=this.clearcoatNormalScale.toArray()),this.sheenColorMap&&this.sheenColorMap.isTexture&&(i.sheenColorMap=this.sheenColorMap.toJSON(e).uuid),this.sheenRoughnessMap&&this.sheenRoughnessMap.isTexture&&(i.sheenRoughnessMap=this.sheenRoughnessMap.toJSON(e).uuid),this.dispersion!==void 0&&(i.dispersion=this.dispersion),this.retroreflectivity!==void 0&&(i.retroreflectivity=this.retroreflectivity),this.iridescence!==void 0&&(i.iridescence=this.iridescence),this.iridescenceIOR!==void 0&&(i.iridescenceIOR=this.iridescenceIOR),this.iridescenceThicknessRange!==void 0&&(i.iridescenceThicknessRange=this.iridescenceThicknessRange),this.iridescenceMap&&this.iridescenceMap.isTexture&&(i.iridescenceMap=this.iridescenceMap.toJSON(e).uuid),this.iridescenceThicknessMap&&this.iridescenceThicknessMap.isTexture&&(i.iridescenceThicknessMap=this.iridescenceThicknessMap.toJSON(e).uuid),this.anisotropy!==void 0&&(i.anisotropy=this.anisotropy),this.anisotropyRotation!==void 0&&(i.anisotropyRotation=this.anisotropyRotation),this.anisotropyMap&&this.anisotropyMap.isTexture&&(i.anisotropyMap=this.anisotropyMap.toJSON(e).uuid),this.map&&this.map.isTexture&&(i.map=this.map.toJSON(e).uuid),this.matcap&&this.matcap.isTexture&&(i.matcap=this.matcap.toJSON(e).uuid),this.alphaMap&&this.alphaMap.isTexture&&(i.alphaMap=this.alphaMap.toJSON(e).uuid),this.lightMap&&this.lightMap.isTexture&&(i.lightMap=this.lightMap.toJSON(e).uuid,i.lightMapIntensity=this.lightMapIntensity),this.aoMap&&this.aoMap.isTexture&&(i.aoMap=this.aoMap.toJSON(e).uuid,i.aoMapIntensity=this.aoMapIntensity),this.bumpMap&&this.bumpMap.isTexture&&(i.bumpMap=this.bumpMap.toJSON(e).uuid,i.bumpScale=this.bumpScale),this.normalMap&&this.normalMap.isTexture&&(i.normalMap=this.normalMap.toJSON(e).uuid,i.normalMapType=this.normalMapType,i.normalScale=this.normalScale.toArray()),this.displacementMap&&this.displacementMap.isTexture&&(i.displacementMap=this.displacementMap.toJSON(e).uuid,i.displacementScale=this.displacementScale,i.displacementBias=this.displacementBias),this.roughnessMap&&this.roughnessMap.isTexture&&(i.roughnessMap=this.roughnessMap.toJSON(e).uuid),this.metalnessMap&&this.metalnessMap.isTexture&&(i.metalnessMap=this.metalnessMap.toJSON(e).uuid),this.emissiveMap&&this.emissiveMap.isTexture&&(i.emissiveMap=this.emissiveMap.toJSON(e).uuid),this.specularMap&&this.specularMap.isTexture&&(i.specularMap=this.specularMap.toJSON(e).uuid),this.specularIntensityMap&&this.specularIntensityMap.isTexture&&(i.specularIntensityMap=this.specularIntensityMap.toJSON(e).uuid),this.specularColorMap&&this.specularColorMap.isTexture&&(i.specularColorMap=this.specularColorMap.toJSON(e).uuid),this.envMap&&this.envMap.isTexture&&(i.envMap=this.envMap.toJSON(e).uuid,this.combine!==void 0&&(i.combine=this.combine)),this.envMapRotation!==void 0&&(i.envMapRotation=this.envMapRotation.toArray()),this.envMapIntensity!==void 0&&(i.envMapIntensity=this.envMapIntensity),this.reflectivity!==void 0&&(i.reflectivity=this.reflectivity),this.refractionRatio!==void 0&&(i.refractionRatio=this.refractionRatio),this.gradientMap&&this.gradientMap.isTexture&&(i.gradientMap=this.gradientMap.toJSON(e).uuid),this.transmission!==void 0&&(i.transmission=this.transmission),this.transmissionMap&&this.transmissionMap.isTexture&&(i.transmissionMap=this.transmissionMap.toJSON(e).uuid),this.thickness!==void 0&&(i.thickness=this.thickness),this.thicknessMap&&this.thicknessMap.isTexture&&(i.thicknessMap=this.thicknessMap.toJSON(e).uuid),this.attenuationDistance!==void 0&&(i.attenuationDistance=this.attenuationDistance),this.attenuationColor!==void 0&&(i.attenuationColor=this.attenuationColor.getHex()),this.size!==void 0&&(i.size=this.size),this.sizeAttenuation!==void 0&&(i.sizeAttenuation=this.sizeAttenuation),Array.isArray(this.clippingPlanes)&&this.clippingPlanes.length>0&&(i.clippingPlanes=this.clippingPlanes.map(s=>s.toJSON())),this.rotation!==void 0&&(i.rotation=this.rotation),this.depthPacking!==void 0&&(i.depthPacking=this.depthPacking),this.linewidth!==void 0&&(i.linewidth=this.linewidth),this.linecap!==void 0&&(i.linecap=this.linecap),this.linejoin!==void 0&&(i.linejoin=this.linejoin),this.dashSize!==void 0&&(i.dashSize=this.dashSize),this.gapSize!==void 0&&(i.gapSize=this.gapSize),this.scale!==void 0&&(i.scale=this.scale),this.wireframe!==void 0&&(i.wireframe=this.wireframe),this.wireframeLinewidth!==void 0&&(i.wireframeLinewidth=this.wireframeLinewidth),this.wireframeLinecap!==void 0&&(i.wireframeLinecap=this.wireframeLinecap),this.wireframeLinejoin!==void 0&&(i.wireframeLinejoin=this.wireframeLinejoin),this.flatShading!==void 0&&(i.flatShading=this.flatShading),this.fog!==void 0&&(i.fog=this.fog),Object.keys(this.userData).length>0&&(i.userData=this.userData);function r(s){const a=[];for(const o in s){const l=s[o];delete l.metadata,a.push(l)}return a}if(t){const s=r(e.textures),a=r(e.images);s.length>0&&(i.textures=s),a.length>0&&(i.images=a)}return i}fromJSON(e,t){if(e.uuid!==void 0&&(this.uuid=e.uuid),e.name!==void 0&&(this.name=e.name),e.color!==void 0&&this.color!==void 0&&this.color.setHex(e.color),e.roughness!==void 0&&(this.roughness=e.roughness),e.metalness!==void 0&&(this.metalness=e.metalness),e.sheen!==void 0&&(this.sheen=e.sheen),e.sheenColor!==void 0&&(this.sheenColor=new ft().setHex(e.sheenColor)),e.sheenRoughness!==void 0&&(this.sheenRoughness=e.sheenRoughness),e.emissive!==void 0&&this.emissive!==void 0&&this.emissive.setHex(e.emissive),e.specular!==void 0&&this.specular!==void 0&&this.specular.setHex(e.specular),e.specularIntensity!==void 0&&(this.specularIntensity=e.specularIntensity),e.specularColor!==void 0&&this.specularColor!==void 0&&this.specularColor.setHex(e.specularColor),e.shininess!==void 0&&(this.shininess=e.shininess),e.clearcoat!==void 0&&(this.clearcoat=e.clearcoat),e.clearcoatRoughness!==void 0&&(this.clearcoatRoughness=e.clearcoatRoughness),e.dispersion!==void 0&&(this.dispersion=e.dispersion),e.retroreflectivity!==void 0&&(this.retroreflectivity=e.retroreflectivity),e.iridescence!==void 0&&(this.iridescence=e.iridescence),e.iridescenceIOR!==void 0&&(this.iridescenceIOR=e.iridescenceIOR),e.iridescenceThicknessRange!==void 0&&(this.iridescenceThicknessRange=e.iridescenceThicknessRange),e.transmission!==void 0&&(this.transmission=e.transmission),e.thickness!==void 0&&(this.thickness=e.thickness),e.attenuationDistance!==void 0&&(this.attenuationDistance=e.attenuationDistance),e.attenuationColor!==void 0&&this.attenuationColor!==void 0&&this.attenuationColor.setHex(e.attenuationColor),e.anisotropy!==void 0&&(this.anisotropy=e.anisotropy),e.anisotropyRotation!==void 0&&(this.anisotropyRotation=e.anisotropyRotation),e.fog!==void 0&&(this.fog=e.fog),e.flatShading!==void 0&&(this.flatShading=e.flatShading),e.blending!==void 0&&(this.blending=e.blending),e.combine!==void 0&&(this.combine=e.combine),e.side!==void 0&&(this.side=e.side),e.shadowSide!==void 0&&(this.shadowSide=e.shadowSide),e.opacity!==void 0&&(this.opacity=e.opacity),e.transparent!==void 0&&(this.transparent=e.transparent),e.alphaTest!==void 0&&(this.alphaTest=e.alphaTest),e.alphaHash!==void 0&&(this.alphaHash=e.alphaHash),e.depthFunc!==void 0&&(this.depthFunc=e.depthFunc),e.depthTest!==void 0&&(this.depthTest=e.depthTest),e.depthWrite!==void 0&&(this.depthWrite=e.depthWrite),e.colorWrite!==void 0&&(this.colorWrite=e.colorWrite),e.clippingPlanes!==void 0&&(this.clippingPlanes=e.clippingPlanes.map(i=>new Fn().fromJSON(i))),e.clipIntersection!==void 0&&(this.clipIntersection=e.clipIntersection),e.clipShadows!==void 0&&(this.clipShadows=e.clipShadows),e.depthPacking!==void 0&&(this.depthPacking=e.depthPacking),e.blendSrc!==void 0&&(this.blendSrc=e.blendSrc),e.blendDst!==void 0&&(this.blendDst=e.blendDst),e.blendEquation!==void 0&&(this.blendEquation=e.blendEquation),e.blendSrcAlpha!==void 0&&(this.blendSrcAlpha=e.blendSrcAlpha),e.blendDstAlpha!==void 0&&(this.blendDstAlpha=e.blendDstAlpha),e.blendEquationAlpha!==void 0&&(this.blendEquationAlpha=e.blendEquationAlpha),e.blendColor!==void 0&&this.blendColor!==void 0&&this.blendColor.setHex(e.blendColor),e.blendAlpha!==void 0&&(this.blendAlpha=e.blendAlpha),e.stencilWriteMask!==void 0&&(this.stencilWriteMask=e.stencilWriteMask),e.stencilFunc!==void 0&&(this.stencilFunc=e.stencilFunc),e.stencilRef!==void 0&&(this.stencilRef=e.stencilRef),e.stencilFuncMask!==void 0&&(this.stencilFuncMask=e.stencilFuncMask),e.stencilFail!==void 0&&(this.stencilFail=e.stencilFail),e.stencilZFail!==void 0&&(this.stencilZFail=e.stencilZFail),e.stencilZPass!==void 0&&(this.stencilZPass=e.stencilZPass),e.stencilWrite!==void 0&&(this.stencilWrite=e.stencilWrite),e.wireframe!==void 0&&(this.wireframe=e.wireframe),e.wireframeLinewidth!==void 0&&(this.wireframeLinewidth=e.wireframeLinewidth),e.wireframeLinecap!==void 0&&(this.wireframeLinecap=e.wireframeLinecap),e.wireframeLinejoin!==void 0&&(this.wireframeLinejoin=e.wireframeLinejoin),e.rotation!==void 0&&(this.rotation=e.rotation),e.linewidth!==void 0&&(this.linewidth=e.linewidth),e.linecap!==void 0&&(this.linecap=e.linecap),e.linejoin!==void 0&&(this.linejoin=e.linejoin),e.dashSize!==void 0&&(this.dashSize=e.dashSize),e.gapSize!==void 0&&(this.gapSize=e.gapSize),e.scale!==void 0&&(this.scale=e.scale),e.polygonOffset!==void 0&&(this.polygonOffset=e.polygonOffset),e.polygonOffsetFactor!==void 0&&(this.polygonOffsetFactor=e.polygonOffsetFactor),e.polygonOffsetUnits!==void 0&&(this.polygonOffsetUnits=e.polygonOffsetUnits),e.dithering!==void 0&&(this.dithering=e.dithering),e.alphaToCoverage!==void 0&&(this.alphaToCoverage=e.alphaToCoverage),e.premultipliedAlpha!==void 0&&(this.premultipliedAlpha=e.premultipliedAlpha),e.forceSinglePass!==void 0&&(this.forceSinglePass=e.forceSinglePass),e.allowOverride!==void 0&&(this.allowOverride=e.allowOverride),e.visible!==void 0&&(this.visible=e.visible),e.toneMapped!==void 0&&(this.toneMapped=e.toneMapped),e.userData!==void 0&&(this.userData=e.userData),e.vertexColors!==void 0&&(typeof e.vertexColors=="number"?this.vertexColors=e.vertexColors>0:this.vertexColors=e.vertexColors),e.size!==void 0&&(this.size=e.size),e.sizeAttenuation!==void 0&&(this.sizeAttenuation=e.sizeAttenuation),e.map!==void 0&&(this.map=t[e.map]||null),e.matcap!==void 0&&(this.matcap=t[e.matcap]||null),e.alphaMap!==void 0&&(this.alphaMap=t[e.alphaMap]||null),e.bumpMap!==void 0&&(this.bumpMap=t[e.bumpMap]||null),e.bumpScale!==void 0&&(this.bumpScale=e.bumpScale),e.normalMap!==void 0&&(this.normalMap=t[e.normalMap]||null),e.normalMapType!==void 0&&(this.normalMapType=e.normalMapType),e.normalScale!==void 0){let i=e.normalScale;Array.isArray(i)===!1&&(i=[i,i]),this.normalScale=new Ze().fromArray(i)}return e.displacementMap!==void 0&&(this.displacementMap=t[e.displacementMap]||null),e.displacementScale!==void 0&&(this.displacementScale=e.displacementScale),e.displacementBias!==void 0&&(this.displacementBias=e.displacementBias),e.roughnessMap!==void 0&&(this.roughnessMap=t[e.roughnessMap]||null),e.metalnessMap!==void 0&&(this.metalnessMap=t[e.metalnessMap]||null),e.emissiveMap!==void 0&&(this.emissiveMap=t[e.emissiveMap]||null),e.emissiveIntensity!==void 0&&(this.emissiveIntensity=e.emissiveIntensity),e.specularMap!==void 0&&(this.specularMap=t[e.specularMap]||null),e.specularIntensityMap!==void 0&&(this.specularIntensityMap=t[e.specularIntensityMap]||null),e.specularColorMap!==void 0&&(this.specularColorMap=t[e.specularColorMap]||null),e.envMap!==void 0&&(this.envMap=t[e.envMap]||null),e.envMapRotation!==void 0&&this.envMapRotation.fromArray(e.envMapRotation),e.envMapIntensity!==void 0&&(this.envMapIntensity=e.envMapIntensity),e.reflectivity!==void 0&&(this.reflectivity=e.reflectivity),e.refractionRatio!==void 0&&(this.refractionRatio=e.refractionRatio),e.lightMap!==void 0&&(this.lightMap=t[e.lightMap]||null),e.lightMapIntensity!==void 0&&(this.lightMapIntensity=e.lightMapIntensity),e.aoMap!==void 0&&(this.aoMap=t[e.aoMap]||null),e.aoMapIntensity!==void 0&&(this.aoMapIntensity=e.aoMapIntensity),e.gradientMap!==void 0&&(this.gradientMap=t[e.gradientMap]||null),e.clearcoatMap!==void 0&&(this.clearcoatMap=t[e.clearcoatMap]||null),e.clearcoatRoughnessMap!==void 0&&(this.clearcoatRoughnessMap=t[e.clearcoatRoughnessMap]||null),e.clearcoatNormalMap!==void 0&&(this.clearcoatNormalMap=t[e.clearcoatNormalMap]||null),e.clearcoatNormalScale!==void 0&&(this.clearcoatNormalScale=new Ze().fromArray(e.clearcoatNormalScale)),e.iridescenceMap!==void 0&&(this.iridescenceMap=t[e.iridescenceMap]||null),e.iridescenceThicknessMap!==void 0&&(this.iridescenceThicknessMap=t[e.iridescenceThicknessMap]||null),e.transmissionMap!==void 0&&(this.transmissionMap=t[e.transmissionMap]||null),e.thicknessMap!==void 0&&(this.thicknessMap=t[e.thicknessMap]||null),e.anisotropyMap!==void 0&&(this.anisotropyMap=t[e.anisotropyMap]||null),e.sheenColorMap!==void 0&&(this.sheenColorMap=t[e.sheenColorMap]||null),e.sheenRoughnessMap!==void 0&&(this.sheenRoughnessMap=t[e.sheenRoughnessMap]||null),this}clone(){return new this.constructor().copy(this)}copy(e){this.name=e.name,this.blending=e.blending,this.side=e.side,this.vertexColors=e.vertexColors,this.opacity=e.opacity,this.transparent=e.transparent,this.blendSrc=e.blendSrc,this.blendDst=e.blendDst,this.blendEquation=e.blendEquation,this.blendSrcAlpha=e.blendSrcAlpha,this.blendDstAlpha=e.blendDstAlpha,this.blendEquationAlpha=e.blendEquationAlpha,this.blendColor.copy(e.blendColor),this.blendAlpha=e.blendAlpha,this.depthFunc=e.depthFunc,this.depthTest=e.depthTest,this.depthWrite=e.depthWrite,this.stencilWriteMask=e.stencilWriteMask,this.stencilFunc=e.stencilFunc,this.stencilRef=e.stencilRef,this.stencilFuncMask=e.stencilFuncMask,this.stencilFail=e.stencilFail,this.stencilZFail=e.stencilZFail,this.stencilZPass=e.stencilZPass,this.stencilWrite=e.stencilWrite;const t=e.clippingPlanes;let i=null;if(t!==null){const r=t.length;i=new Array(r);for(let s=0;s!==r;++s)i[s]=t[s].clone()}return this.clippingPlanes=i,this.clipIntersection=e.clipIntersection,this.clipShadows=e.clipShadows,this.shadowSide=e.shadowSide,this.colorWrite=e.colorWrite,this.precision=e.precision,this.polygonOffset=e.polygonOffset,this.polygonOffsetFactor=e.polygonOffsetFactor,this.polygonOffsetUnits=e.polygonOffsetUnits,this.dithering=e.dithering,this.alphaTest=e.alphaTest,this.alphaHash=e.alphaHash,this.alphaToCoverage=e.alphaToCoverage,this.premultipliedAlpha=e.premultipliedAlpha,this.forceSinglePass=e.forceSinglePass,this.allowOverride=e.allowOverride,this.visible=e.visible,this.toneMapped=e.toneMapped,this.userData=JSON.parse(JSON.stringify(e.userData)),this}dispose(){this.dispatchEvent({type:"dispose"})}set needsUpdate(e){e===!0&&this.version++}}const gi=new U,vl=new U,la=new U,ca=new U;class Ji{constructor(e=new U,t=new U(0,0,-1)){this.origin=e,this.direction=t}set(e,t){return this.origin.copy(e),this.direction.copy(t),this}copy(e){return this.origin.copy(e.origin),this.direction.copy(e.direction),this}at(e,t){return t.copy(this.origin).addScaledVector(this.direction,e)}lookAt(e){return this.direction.copy(e).sub(this.origin).normalize(),this}recast(e){return this.origin.copy(this.at(e,gi)),this}closestPointToPoint(e,t){t.subVectors(e,this.origin);const i=t.dot(this.direction);return i<0?t.copy(this.origin):t.copy(this.origin).addScaledVector(this.direction,i)}distanceToPoint(e){return Math.sqrt(this.distanceSqToPoint(e))}distanceSqToPoint(e){const t=gi.subVectors(e,this.origin).dot(this.direction);return t<0?this.origin.distanceToSquared(e):(gi.copy(this.origin).addScaledVector(this.direction,t),gi.distanceToSquared(e))}distanceSqToSegment(e,t,i,r){vl.copy(e).add(t).multiplyScalar(.5),la.copy(t).sub(e).normalize(),ca.copy(this.origin).sub(vl);const s=e.distanceTo(t)*.5,a=-this.direction.dot(la),o=ca.dot(this.direction),l=-ca.dot(la),c=ca.lengthSq(),f=Math.abs(1-a*a);let d,u,h,_;if(f>0)if(d=a*l-o,u=a*o-l,_=s*f,d>=0)if(u>=-_)if(u<=_){const g=1/f;d*=g,u*=g,h=d*(d+a*u+2*o)+u*(a*d+u+2*l)+c}else u=s,d=Math.max(0,-(a*u+o)),h=-d*d+u*(u+2*l)+c;else u=-s,d=Math.max(0,-(a*u+o)),h=-d*d+u*(u+2*l)+c;else u<=-_?(d=Math.max(0,-(-a*s+o)),u=d>0?-s:Math.min(Math.max(-s,-l),s),h=-d*d+u*(u+2*l)+c):u<=_?(d=0,u=Math.min(Math.max(-s,-l),s),h=u*(u+2*l)+c):(d=Math.max(0,-(a*s+o)),u=d>0?s:Math.min(Math.max(-s,-l),s),h=-d*d+u*(u+2*l)+c);else u=a>0?-s:s,d=Math.max(0,-(a*u+o)),h=-d*d+u*(u+2*l)+c;return i&&i.copy(this.origin).addScaledVector(this.direction,d),r&&r.copy(vl).addScaledVector(la,u),h}intersectSphere(e,t){if(e.radius<0)return null;gi.subVectors(e.center,this.origin);const i=gi.dot(this.direction),r=gi.dot(gi)-i*i,s=e.radius*e.radius;if(r>s)return null;const a=Math.sqrt(s-r),o=i-a,l=i+a;return l<0?null:o<0?this.at(l,t):this.at(o,t)}intersectsSphere(e){return e.radius<0?!1:this.distanceSqToPoint(e.center)<=e.radius*e.radius}distanceToPlane(e){const t=e.normal.dot(this.direction);if(t===0)return e.distanceToPoint(this.origin)===0?0:null;const i=-(this.origin.dot(e.normal)+e.constant)/t;return i>=0?i:null}intersectPlane(e,t){const i=this.distanceToPlane(e);return i===null?null:this.at(i,t)}intersectsPlane(e){const t=e.distanceToPoint(this.origin);return t===0||e.normal.dot(this.direction)*t<0}intersectBox(e,t){let i,r,s,a,o,l;const c=1/this.direction.x,f=1/this.direction.y,d=1/this.direction.z,u=this.origin;return c>=0?(i=(e.min.x-u.x)*c,r=(e.max.x-u.x)*c):(i=(e.max.x-u.x)*c,r=(e.min.x-u.x)*c),f>=0?(s=(e.min.y-u.y)*f,a=(e.max.y-u.y)*f):(s=(e.max.y-u.y)*f,a=(e.min.y-u.y)*f),i>a||s>r||((s>i||isNaN(i))&&(i=s),(a<r||isNaN(r))&&(r=a),d>=0?(o=(e.min.z-u.z)*d,l=(e.max.z-u.z)*d):(o=(e.max.z-u.z)*d,l=(e.min.z-u.z)*d),i>l||o>r)||((o>i||i!==i)&&(i=o),(l<r||r!==r)&&(r=l),r<0)?null:this.at(i>=0?i:r,t)}intersectsBox(e){return this.intersectBox(e,gi)!==null}intersectTriangle(e,t,i,r,s){const a=this.origin,o=this.direction,l=o.x,c=o.y,f=o.z,d=e.x-a.x,u=e.y-a.y,h=e.z-a.z,_=t.x-a.x,g=t.y-a.y,p=t.z-a.z,m=i.x-a.x,v=i.y-a.y,w=i.z-a.z,y=Math.abs(l),S=Math.abs(c),M=Math.abs(f);let E,b,T,C,D,R,N,I,z,$,X,re;if(y>=S&&y>=M?(T=l,R=d,z=_,re=m,l>=0?(E=c,b=f,C=u,D=h,N=g,I=p,$=v,X=w):(E=f,b=c,C=h,D=u,N=p,I=g,$=w,X=v)):S>=M?(T=c,R=u,z=g,re=v,c>=0?(E=f,b=l,C=h,D=d,N=p,I=_,$=w,X=m):(E=l,b=f,C=d,D=h,N=_,I=p,$=m,X=w)):(T=f,R=h,z=p,re=w,f>=0?(E=l,b=c,C=d,D=u,N=_,I=g,$=m,X=v):(E=c,b=l,C=u,D=d,N=g,I=_,$=v,X=m)),T===0)return null;const J=E/T,Q=b/T,te=1/T,ue=C-J*R,be=D-Q*R,Fe=N-J*z,Re=I-Q*z,je=$-J*re,ne=X-Q*re,ae=je*Re-ne*Fe,Me=ue*ne-be*je,Be=Fe*be-Re*ue;if(r){if(ae<0||Me<0||Be<0)return null}else if((ae<0||Me<0||Be<0)&&(ae>0||Me>0||Be>0))return null;const ve=ae+Me+Be;if(ve===0)return null;const ke=te*(ae*R+Me*z+Be*re);return(ve>0?ke<0:ke>0)?null:this.at(ke/ve,s)}applyMatrix4(e){return this.origin.applyMatrix4(e),this.direction.transformDirection(e),this}equals(e){return e.origin.equals(this.origin)&&e.direction.equals(this.direction)}clone(){return new this.constructor().copy(this)}}class Uo extends es{constructor(e){super(),this.isMeshBasicMaterial=!0,this.type="MeshBasicMaterial",this.color=new ft(16777215),this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.envMapRotation=new gr,this.combine=ap,this.reflectivity=1,this.refractionRatio=.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.specularMap=e.specularMap,this.alphaMap=e.alphaMap,this.envMap=e.envMap,this.envMapRotation.copy(e.envMapRotation),this.combine=e.combine,this.reflectivity=e.reflectivity,this.refractionRatio=e.refractionRatio,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.fog=e.fog,this}}const zf=new et,er=new Ji,ua=new Yn,Vf=new U,fa=new U,da=new U,ha=new U,xl=new U,pa=new U,Hf=new U,ma=new U;class dn extends xn{constructor(e=new Jt,t=new Uo){super(),this.isMesh=!0,this.type="Mesh",this.geometry=e,this.material=t,this.morphTargetDictionary=void 0,this.morphTargetInfluences=void 0,this.count=1,this.updateMorphTargets()}copy(e,t){return super.copy(e,t),e.morphTargetInfluences!==void 0&&(this.morphTargetInfluences=e.morphTargetInfluences.slice()),e.morphTargetDictionary!==void 0&&(this.morphTargetDictionary=Object.assign({},e.morphTargetDictionary)),this.material=Array.isArray(e.material)?e.material.slice():e.material,this.geometry=e.geometry,this}updateMorphTargets(){const t=this.geometry.morphAttributes,i=Object.keys(t);if(i.length>0){const r=t[i[0]];if(r!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let s=0,a=r.length;s<a;s++){const o=r[s].name||String(s);this.morphTargetInfluences.push(0),this.morphTargetDictionary[o]=s}}}}getVertexPosition(e,t){const i=this.geometry,r=i.attributes.position,s=i.morphAttributes.position,a=i.morphTargetsRelative;t.fromBufferAttribute(r,e);const o=this.morphTargetInfluences;if(s&&o){pa.set(0,0,0);for(let l=0,c=s.length;l<c;l++){const f=o[l],d=s[l];f!==0&&(xl.fromBufferAttribute(d,e),a?pa.addScaledVector(xl,f):pa.addScaledVector(xl.sub(t),f))}t.add(pa)}return t}intersectsFrustum(e){return e.intersectsObject(this)}raycast(e,t){const i=this.geometry,r=this.material,s=this.matrixWorld;r!==void 0&&(i.boundingSphere===null&&i.computeBoundingSphere(),ua.copy(i.boundingSphere),ua.applyMatrix4(s),er.copy(e.ray).recast(e.near),!(ua.containsPoint(er.origin)===!1&&(er.intersectSphere(ua,Vf)===null||er.origin.distanceToSquared(Vf)>(e.far-e.near)**2))&&(zf.copy(s).invert(),er.copy(e.ray).applyMatrix4(zf),!(i.boundingBox!==null&&er.intersectsBox(i.boundingBox)===!1)&&this._computeIntersections(e,t,er)))}_computeIntersections(e,t,i){let r;const s=this.geometry,a=this.material,o=s.index,l=s.attributes.position,c=s.attributes.uv,f=s.attributes.uv1,d=s.attributes.normal,u=s.groups,h=s.drawRange;if(o!==null)if(Array.isArray(a))for(let _=0,g=u.length;_<g;_++){const p=u[_],m=a[p.materialIndex],v=Math.max(p.start,h.start),w=Math.min(o.count,Math.min(p.start+p.count,h.start+h.count));for(let y=v,S=w;y<S;y+=3){const M=o.getX(y),E=o.getX(y+1),b=o.getX(y+2);r=ga(this,m,e,i,c,f,d,M,E,b),r&&(r.faceIndex=Math.floor(y/3),r.face.materialIndex=p.materialIndex,t.push(r))}}else{const _=Math.max(0,h.start),g=Math.min(o.count,h.start+h.count);for(let p=_,m=g;p<m;p+=3){const v=o.getX(p),w=o.getX(p+1),y=o.getX(p+2);r=ga(this,a,e,i,c,f,d,v,w,y),r&&(r.faceIndex=Math.floor(p/3),t.push(r))}}else if(l!==void 0)if(Array.isArray(a))for(let _=0,g=u.length;_<g;_++){const p=u[_],m=a[p.materialIndex],v=Math.max(p.start,h.start),w=Math.min(l.count,Math.min(p.start+p.count,h.start+h.count));for(let y=v,S=w;y<S;y+=3){const M=y,E=y+1,b=y+2;r=ga(this,m,e,i,c,f,d,M,E,b),r&&(r.faceIndex=Math.floor(y/3),r.face.materialIndex=p.materialIndex,t.push(r))}}else{const _=Math.max(0,h.start),g=Math.min(l.count,h.start+h.count);for(let p=_,m=g;p<m;p+=3){const v=p,w=p+1,y=p+2;r=ga(this,a,e,i,c,f,d,v,w,y),r&&(r.faceIndex=Math.floor(p/3),t.push(r))}}}}function hv(n,e,t,i,r,s,a,o){let l;if(e.side===fn?l=i.intersectTriangle(a,s,r,!0,o):l=i.intersectTriangle(r,s,a,e.side===li,o),l===null)return null;ma.copy(o),ma.applyMatrix4(n.matrixWorld);const c=t.ray.origin.distanceTo(ma);return c<t.near||c>t.far?null:{distance:c,point:ma.clone(),object:n}}function ga(n,e,t,i,r,s,a,o,l,c){n.getVertexPosition(o,fa),n.getVertexPosition(l,da),n.getVertexPosition(c,ha);const f=hv(n,e,t,i,fa,da,ha,Hf);if(f){const d=new U;nn.getBarycoord(Hf,fa,da,ha,d),r&&(f.uv=nn.getInterpolatedAttribute(r,o,l,c,d,new Ze)),s&&(f.uv1=nn.getInterpolatedAttribute(s,o,l,c,d,new Ze)),a&&(f.normal=nn.getInterpolatedAttribute(a,o,l,c,d,new U),f.normal.dot(i.direction)>0&&f.normal.multiplyScalar(-1));const u={a:o,b:l,c,normal:new U,materialIndex:0};nn.getNormal(fa,da,ha,u.normal),f.face=u,f.barycoord=d}return f}class pv extends vn{constructor(e=null,t=1,i=1,r,s,a,o,l,c=rn,f=rn,d,u){super(null,a,o,l,c,f,r,s,d,u),this.isDataTexture=!0,this.image={data:e,width:t,height:i},this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}}const tr=new Yn,mv=new Ze(.5,.5),_a=new U;class Lp{constructor(e=new Fn,t=new Fn,i=new Fn,r=new Fn,s=new Fn,a=new Fn){this.planes=[e,t,i,r,s,a]}set(e,t,i,r,s,a){const o=this.planes;return o[0].copy(e),o[1].copy(t),o[2].copy(i),o[3].copy(r),o[4].copy(s),o[5].copy(a),this}copy(e){const t=this.planes;for(let i=0;i<6;i++)t[i].copy(e.planes[i]);return this}setFromProjectionMatrix(e,t=ai,i=!1){const r=this.planes,s=e.elements,a=s[0],o=s[1],l=s[2],c=s[3],f=s[4],d=s[5],u=s[6],h=s[7],_=s[8],g=s[9],p=s[10],m=s[11],v=s[12],w=s[13],y=s[14],S=s[15];if(r[0].setComponents(c-a,h-f,m-_,S-v).normalize(),r[1].setComponents(c+a,h+f,m+_,S+v).normalize(),r[2].setComponents(c+o,h+d,m+g,S+w).normalize(),r[3].setComponents(c-o,h-d,m-g,S-w).normalize(),i)r[4].setComponents(l,u,p,y).normalize(),r[5].setComponents(c-l,h-u,m-p,S-y).normalize();else if(r[4].setComponents(c-l,h-u,m-p,S-y).normalize(),t===ai)r[5].setComponents(c+l,h+u,m+p,S+y).normalize();else if(t===Mo)r[5].setComponents(l,u,p,y).normalize();else throw new Error("THREE.Frustum.setFromProjectionMatrix(): Invalid coordinate system: "+t);return this}intersectsObject(e){if(e.boundingSphere!==void 0)e.boundingSphere===null&&e.computeBoundingSphere(),tr.copy(e.boundingSphere).applyMatrix4(e.matrixWorld);else{const t=e.geometry;t.boundingSphere===null&&t.computeBoundingSphere(),tr.copy(t.boundingSphere).applyMatrix4(e.matrixWorld)}return this.intersectsSphere(tr)}intersectsSprite(e){tr.center.set(0,0,0);const t=mv.distanceTo(e.center);return tr.radius=.7071067811865476+t,tr.applyMatrix4(e.matrixWorld),this.intersectsSphere(tr)}intersectsSphere(e){const t=this.planes,i=e.center,r=-e.radius;for(let s=0;s<6;s++)if(t[s].distanceToPoint(i)<r)return!1;return!0}intersectsBox(e){const t=this.planes;for(let i=0;i<6;i++){const r=t[i];if(_a.x=r.normal.x>0?e.max.x:e.min.x,_a.y=r.normal.y>0?e.max.y:e.min.y,_a.z=r.normal.z>0?e.max.z:e.min.z,r.distanceToPoint(_a)<0)return!1}return!0}containsPoint(e){const t=this.planes;for(let i=0;i<6;i++)if(t[i].distanceToPoint(e)<0)return!1;return!0}clone(){return new this.constructor().copy(this)}}class Dp extends es{constructor(e){super(),this.isLineBasicMaterial=!0,this.type="LineBasicMaterial",this.color=new ft(16777215),this.map=null,this.linewidth=1,this.linecap="round",this.linejoin="round",this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.linewidth=e.linewidth,this.linecap=e.linecap,this.linejoin=e.linejoin,this.fog=e.fog,this}}const To=new U,Ao=new U,Gf=new et,ds=new Ji,va=new Yn,yl=new U,Wf=new U;class gv extends xn{constructor(e=new Jt,t=new Dp){super(),this.isLine=!0,this.type="Line",this.geometry=e,this.material=t,this.morphTargetDictionary=void 0,this.morphTargetInfluences=void 0,this.updateMorphTargets()}copy(e,t){return super.copy(e,t),this.material=Array.isArray(e.material)?e.material.slice():e.material,this.geometry=e.geometry,this}computeLineDistances(){const e=this.geometry;if(e.index===null){const t=e.attributes.position,i=[0];for(let r=1,s=t.count;r<s;r++)To.fromBufferAttribute(t,r-1),Ao.fromBufferAttribute(t,r),i[r]=i[r-1],i[r]+=To.distanceTo(Ao);e.setAttribute("lineDistance",new Wt(i,1))}else ze("Line.computeLineDistances(): Computation only possible with non-indexed BufferGeometry.");return this}intersectsFrustum(e){return e.intersectsObject(this)}raycast(e,t){const i=this.geometry,r=this.matrixWorld,s=e.params.Line.threshold,a=i.drawRange;if(i.boundingSphere===null&&i.computeBoundingSphere(),va.copy(i.boundingSphere),va.applyMatrix4(r),va.radius+=s,e.ray.intersectsSphere(va)===!1)return;Gf.copy(r).invert(),ds.copy(e.ray).applyMatrix4(Gf);const o=s/((this.scale.x+this.scale.y+this.scale.z)/3),l=o*o,c=this.isLineSegments?2:1,f=i.index,u=i.attributes.position;if(f!==null){const h=Math.max(0,a.start),_=Math.min(f.count,a.start+a.count);for(let g=h,p=_-1;g<p;g+=c){const m=f.getX(g),v=f.getX(g+1),w=xa(this,e,ds,l,m,v,g);w&&t.push(w)}if(this.isLineLoop){const g=f.getX(_-1),p=f.getX(h),m=xa(this,e,ds,l,g,p,_-1);m&&t.push(m)}}else{const h=Math.max(0,a.start),_=Math.min(u.count,a.start+a.count);for(let g=h,p=_-1;g<p;g+=c){const m=xa(this,e,ds,l,g,g+1,g);m&&t.push(m)}if(this.isLineLoop){const g=xa(this,e,ds,l,_-1,h,_-1);g&&t.push(g)}}}updateMorphTargets(){const t=this.geometry.morphAttributes,i=Object.keys(t);if(i.length>0){const r=t[i[0]];if(r!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let s=0,a=r.length;s<a;s++){const o=r[s].name||String(s);this.morphTargetInfluences.push(0),this.morphTargetDictionary[o]=s}}}}}function xa(n,e,t,i,r,s,a){const o=n.geometry.attributes.position;if(To.fromBufferAttribute(o,r),Ao.fromBufferAttribute(o,s),t.distanceSqToSegment(To,Ao,yl,Wf)>i)return;yl.applyMatrix4(n.matrixWorld);const c=e.ray.origin.distanceTo(yl);if(!(c<e.near||c>e.far))return{distance:c,point:Wf.clone().applyMatrix4(n.matrixWorld),index:a,face:null,faceIndex:null,barycoord:null,object:n}}class _v extends gv{constructor(e,t){super(e,t),this.isLineLoop=!0,this.type="LineLoop"}}class vv extends es{constructor(e){super(),this.isPointsMaterial=!0,this.type="PointsMaterial",this.color=new ft(16777215),this.map=null,this.alphaMap=null,this.size=1,this.sizeAttenuation=!0,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.alphaMap=e.alphaMap,this.size=e.size,this.sizeAttenuation=e.sizeAttenuation,this.fog=e.fog,this}}const $f=new et,Hc=new Ji,ya=new Yn,ba=new U;class xv extends xn{constructor(e=new Jt,t=new vv){super(),this.isPoints=!0,this.type="Points",this.geometry=e,this.material=t,this.morphTargetDictionary=void 0,this.morphTargetInfluences=void 0,this.updateMorphTargets()}copy(e,t){return super.copy(e,t),this.material=Array.isArray(e.material)?e.material.slice():e.material,this.geometry=e.geometry,this}intersectsFrustum(e){return e.intersectsObject(this)}raycast(e,t){const i=this.geometry,r=this.matrixWorld,s=e.params.Points.threshold,a=i.drawRange;if(i.boundingSphere===null&&i.computeBoundingSphere(),ya.copy(i.boundingSphere),ya.applyMatrix4(r),ya.radius+=s,e.ray.intersectsSphere(ya)===!1)return;$f.copy(r).invert(),Hc.copy(e.ray).applyMatrix4($f);const o=s/((this.scale.x+this.scale.y+this.scale.z)/3),l=o*o,c=i.index,d=i.attributes.position;if(c!==null){const u=Math.max(0,a.start),h=Math.min(c.count,a.start+a.count);for(let _=u,g=h;_<g;_++){const p=c.getX(_);ba.fromBufferAttribute(d,p),Xf(ba,p,l,r,e,t,this)}}else{const u=Math.max(0,a.start),h=Math.min(d.count,a.start+a.count);for(let _=u,g=h;_<g;_++)ba.fromBufferAttribute(d,_),Xf(ba,_,l,r,e,t,this)}}updateMorphTargets(){const t=this.geometry.morphAttributes,i=Object.keys(t);if(i.length>0){const r=t[i[0]];if(r!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let s=0,a=r.length;s<a;s++){const o=r[s].name||String(s);this.morphTargetInfluences.push(0),this.morphTargetDictionary[o]=s}}}}}function Xf(n,e,t,i,r,s,a){const o=Hc.distanceSqToPoint(n);if(o<t){const l=new U;Hc.closestPointToPoint(n,l),l.applyMatrix4(i);const c=r.ray.origin.distanceTo(l);if(c<r.near||c>r.far)return;s.push({distance:c,distanceToRay:Math.sqrt(o),point:l,index:e,face:null,faceIndex:null,barycoord:null,object:a})}}class Np extends vn{constructor(e=[],t=pr,i,r,s,a,o,l,c,f){super(e,t,i,r,s,a,o,l,c,f),this.isCubeTexture=!0,this.flipY=!1}get images(){return this.image}set images(e){this.image=e}}class Bs extends vn{constructor(e,t,i=ci,r,s,a,o=rn,l=rn,c,f=Ci,d=1){if(f!==Ci&&f!==dr)throw new Error("THREE.DepthTexture: format must be either THREE.DepthFormat or THREE.DepthStencilFormat");const u={width:e,height:t,depth:d};super(u,r,s,a,o,l,f,i,c),this.isDepthTexture=!0,this.flipY=!1,this.generateMipmaps=!1,this.compareFunction=null}copy(e){return super.copy(e),this.source=new Ru(Object.assign({},e.image)),this.compareFunction=e.compareFunction,this}toJSON(e){const t=super.toJSON(e);return t.compareFunction=this.compareFunction,t}}class yv extends Bs{constructor(e,t=ci,i=pr,r,s,a=rn,o=rn,l,c=Ci){const f={width:e,height:e,depth:1},d=[f,f,f,f,f,f];super(e,e,t,i,r,s,a,o,l,c),this.image=d,this.isCubeDepthTexture=!0,this.isCubeTexture=!0}get images(){return this.image}set images(e){this.image=e}}class Ip extends vn{constructor(e=null){super(),this.sourceTexture=e,this.isExternalTexture=!0}copy(e){return super.copy(e),this.sourceTexture=e.sourceTexture,this}}class Hs extends Jt{constructor(e=1,t=1,i=1,r=1,s=1,a=1){super(),this.type="BoxGeometry",this.parameters={width:e,height:t,depth:i,widthSegments:r,heightSegments:s,depthSegments:a};const o=this;r=Math.floor(r),s=Math.floor(s),a=Math.floor(a);const l=[],c=[],f=[],d=[];let u=0,h=0;_("z","y","x",-1,-1,i,t,e,a,s,0),_("z","y","x",1,-1,i,t,-e,a,s,1),_("x","z","y",1,1,e,i,t,r,a,2),_("x","z","y",1,-1,e,i,-t,r,a,3),_("x","y","z",1,-1,e,t,i,r,s,4),_("x","y","z",-1,-1,e,t,-i,r,s,5),this.setIndex(l),this.setAttribute("position",new Wt(c,3)),this.setAttribute("normal",new Wt(f,3)),this.setAttribute("uv",new Wt(d,2));function _(g,p,m,v,w,y,S,M,E,b,T){const C=y/E,D=S/b,R=y/2,N=S/2,I=M/2,z=E+1,$=b+1;let X=0,re=0;const J=new U;for(let Q=0;Q<$;Q++){const te=Q*D-N;for(let ue=0;ue<z;ue++){const be=ue*C-R;J[g]=be*v,J[p]=te*w,J[m]=I,c.push(J.x,J.y,J.z),J[g]=0,J[p]=0,J[m]=M>0?1:-1,f.push(J.x,J.y,J.z),d.push(ue/E),d.push(1-Q/b),X+=1}}for(let Q=0;Q<b;Q++)for(let te=0;te<E;te++){const ue=u+te+z*Q,be=u+te+z*(Q+1),Fe=u+(te+1)+z*(Q+1),Re=u+(te+1)+z*Q;l.push(ue,be,Re),l.push(be,Fe,Re),re+=6}o.addGroup(h,re,T),h+=re,u+=X}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new Hs(e.width,e.height,e.depth,e.widthSegments,e.heightSegments,e.depthSegments)}}class Fo extends Jt{constructor(e=1,t=1,i=1,r=32,s=1,a=!1,o=0,l=Math.PI*2){super(),this.type="CylinderGeometry",this.parameters={radiusTop:e,radiusBottom:t,height:i,radialSegments:r,heightSegments:s,openEnded:a,thetaStart:o,thetaLength:l};const c=this;r=Math.floor(r),s=Math.floor(s);const f=[],d=[],u=[],h=[];let _=0;const g=[],p=i/2;let m=0;v(),a===!1&&(e>0&&w(!0),t>0&&w(!1)),this.setIndex(f),this.setAttribute("position",new Wt(d,3)),this.setAttribute("normal",new Wt(u,3)),this.setAttribute("uv",new Wt(h,2));function v(){const y=new U,S=new U;let M=0;const E=(t-e)/i;for(let b=0;b<=s;b++){const T=[],C=b/s,D=C*(t-e)+e;for(let R=0;R<=r;R++){const N=R/r,I=N*l+o,z=Math.sin(I),$=Math.cos(I);S.x=D*z,S.y=-C*i+p,S.z=D*$,d.push(S.x,S.y,S.z),y.set(z,E,$).normalize(),u.push(y.x,y.y,y.z),h.push(N,1-C),T.push(_++)}g.push(T)}for(let b=0;b<r;b++)for(let T=0;T<s;T++){const C=g[T][b],D=g[T+1][b],R=g[T+1][b+1],N=g[T][b+1];(e>0||T!==0)&&(f.push(C,D,N),M+=3),(t>0||T!==s-1)&&(f.push(D,R,N),M+=3)}c.addGroup(m,M,0),m+=M}function w(y){const S=_,M=new Ze,E=new U;let b=0;const T=y===!0?e:t,C=y===!0?1:-1;for(let R=1;R<=r;R++)d.push(0,p*C,0),u.push(0,C,0),h.push(.5,.5),_++;const D=_;for(let R=0;R<=r;R++){const I=R/r*l+o,z=Math.cos(I),$=Math.sin(I);E.x=T*$,E.y=p*C,E.z=T*z,d.push(E.x,E.y,E.z),u.push(0,C,0),M.x=z*.5+.5,M.y=$*.5*C+.5,h.push(M.x,M.y),_++}for(let R=0;R<r;R++){const N=S+R,I=D+R;y===!0?f.push(I,I+1,N):f.push(I+1,I,N),b+=3}c.addGroup(m,b,y===!0?1:2),m+=b}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new Fo(e.radiusTop,e.radiusBottom,e.height,e.radialSegments,e.heightSegments,e.openEnded,e.thetaStart,e.thetaLength)}}class Cu extends Fo{constructor(e=1,t=1,i=32,r=1,s=!1,a=0,o=Math.PI*2){super(0,e,t,i,r,s,a,o),this.type="ConeGeometry",this.parameters={radius:e,height:t,radialSegments:i,heightSegments:r,openEnded:s,thetaStart:a,thetaLength:o}}static fromJSON(e){return new Cu(e.radius,e.height,e.radialSegments,e.heightSegments,e.openEnded,e.thetaStart,e.thetaLength)}}class ts extends Jt{constructor(e=1,t=1,i=1,r=1){super(),this.type="PlaneGeometry",this.parameters={width:e,height:t,widthSegments:i,heightSegments:r};const s=e/2,a=t/2,o=Math.floor(i),l=Math.floor(r),c=o+1,f=l+1,d=e/o,u=t/l,h=[],_=[],g=[],p=[];for(let m=0;m<f;m++){const v=m*u-a;for(let w=0;w<c;w++){const y=w*d-s;_.push(y,-v,0),g.push(0,0,1),p.push(w/o),p.push(1-m/l)}}for(let m=0;m<l;m++)for(let v=0;v<o;v++){const w=v+c*m,y=v+c*(m+1),S=v+1+c*(m+1),M=v+1+c*m;h.push(w,y,M),h.push(y,S,M)}this.setIndex(h),this.setAttribute("position",new Wt(_,3)),this.setAttribute("normal",new Wt(g,3)),this.setAttribute("uv",new Wt(p,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new ts(e.width,e.height,e.widthSegments,e.heightSegments)}}class bv extends Jt{constructor(e=null){if(super(),this.type="WireframeGeometry",this.parameters={geometry:e},e!==null){const t=[],i=new Set,r=new U,s=new U;if(e.index!==null){const a=e.attributes.position,o=e.index;let l=e.groups;l.length===0&&(l=[{start:0,count:o.count,materialIndex:0}]);for(let c=0,f=l.length;c<f;++c){const d=l[c],u=d.start,h=d.count;for(let _=u,g=u+h;_<g;_+=3)for(let p=0;p<3;p++){const m=o.getX(_+p),v=o.getX(_+(p+1)%3);r.fromBufferAttribute(a,m),s.fromBufferAttribute(a,v),qf(r,s,i)===!0&&(t.push(r.x,r.y,r.z),t.push(s.x,s.y,s.z))}}}else{const a=e.attributes.position;for(let o=0,l=a.count/3;o<l;o++)for(let c=0;c<3;c++){const f=3*o+c,d=3*o+(c+1)%3;r.fromBufferAttribute(a,f),s.fromBufferAttribute(a,d),qf(r,s,i)===!0&&(t.push(r.x,r.y,r.z),t.push(s.x,s.y,s.z))}}this.setAttribute("position",new Wt(t,3))}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}}function qf(n,e,t){const i=`${n.x},${n.y},${n.z}-${e.x},${e.y},${e.z}`,r=`${e.x},${e.y},${e.z}-${n.x},${n.y},${n.z}`;return t.has(i)===!0||t.has(r)===!0?!1:(t.add(i),t.add(r),!0)}function jr(n){const e={};for(const t in n){e[t]={};for(const i in n[t]){const r=n[t][i];if(Yf(r))r.isRenderTargetTexture?(ze("UniformsUtils: Textures of render targets cannot be cloned via cloneUniforms() or mergeUniforms()."),e[t][i]=null):e[t][i]=r.clone();else if(Array.isArray(r))if(Yf(r[0])){const s=[];for(let a=0,o=r.length;a<o;a++)s[a]=r[a].clone();e[t][i]=s}else e[t][i]=r.slice();else e[t][i]=r}}return e}function gn(n){const e={};for(let t=0;t<n.length;t++){const i=jr(n[t]);for(const r in i)e[r]=i[r]}return e}function Yf(n){return n&&(n.isColor||n.isMatrix3||n.isMatrix4||n.isVector2||n.isVector3||n.isVector4||n.isTexture||n.isQuaternion)}function Sv(n){const e=[];for(let t=0;t<n.length;t++)e.push(n[t].clone());return e}function Up(n){const e=n.getRenderTarget();return e===null?n.outputColorSpace:e.isXRRenderTarget===!0?e.texture.colorSpace:at.workingColorSpace}const Pu={clone:jr,merge:gn};var Mv=`void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,wv=`void main() {
	gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );
}`;class Pn extends es{constructor(e){super(),this.isShaderMaterial=!0,this.type="ShaderMaterial",this.defines={},this.uniforms={},this.uniformsGroups=[],this.vertexShader=Mv,this.fragmentShader=wv,this.linewidth=1,this.wireframe=!1,this.wireframeLinewidth=1,this.fog=!1,this.lights=!1,this.clipping=!1,this.forceSinglePass=!0,this.extensions={clipCullDistance:!1,multiDraw:!1},this.defaultAttributeValues={color:[1,1,1],uv:[0,0],uv1:[0,0]},this.index0AttributeName=void 0,this.uniformsNeedUpdate=!1,this.glslVersion=null,e!==void 0&&this.setValues(e)}copy(e){return super.copy(e),this.fragmentShader=e.fragmentShader,this.vertexShader=e.vertexShader,this.uniforms=jr(e.uniforms),this.uniformsGroups=Sv(e.uniformsGroups),this.defines=Object.assign({},e.defines),this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.fog=e.fog,this.lights=e.lights,this.clipping=e.clipping,this.extensions=Object.assign({},e.extensions),this.glslVersion=e.glslVersion,this.defaultAttributeValues=Object.assign({},e.defaultAttributeValues),this.index0AttributeName=e.index0AttributeName,this.uniformsNeedUpdate=e.uniformsNeedUpdate,this}toJSON(e){const t=super.toJSON(e);t.glslVersion=this.glslVersion,t.uniforms={};for(const r in this.uniforms){const a=this.uniforms[r].value;a&&a.isTexture?t.uniforms[r]={type:"t",value:a.toJSON(e).uuid}:a&&a.isColor?t.uniforms[r]={type:"c",value:a.getHex()}:a&&a.isVector2?t.uniforms[r]={type:"v2",value:a.toArray()}:a&&a.isVector3?t.uniforms[r]={type:"v3",value:a.toArray()}:a&&a.isVector4?t.uniforms[r]={type:"v4",value:a.toArray()}:a&&a.isMatrix3?t.uniforms[r]={type:"m3",value:a.toArray()}:a&&a.isMatrix4?t.uniforms[r]={type:"m4",value:a.toArray()}:t.uniforms[r]={value:a}}Object.keys(this.defines).length>0&&(t.defines=this.defines),t.vertexShader=this.vertexShader,t.fragmentShader=this.fragmentShader,t.lights=this.lights,t.clipping=this.clipping;const i={};for(const r in this.extensions)this.extensions[r]===!0&&(i[r]=!0);return Object.keys(i).length>0&&(t.extensions=i),t}fromJSON(e,t){if(super.fromJSON(e,t),e.uniforms!==void 0)for(const i in e.uniforms){const r=e.uniforms[i];switch(this.uniforms[i]={},r.type){case"t":this.uniforms[i].value=t[r.value]||null;break;case"c":this.uniforms[i].value=new ft().setHex(r.value);break;case"v2":this.uniforms[i].value=new Ze().fromArray(r.value);break;case"v3":this.uniforms[i].value=new U().fromArray(r.value);break;case"v4":this.uniforms[i].value=new bt().fromArray(r.value);break;case"m3":this.uniforms[i].value=new We().fromArray(r.value);break;case"m4":this.uniforms[i].value=new et().fromArray(r.value);break;default:this.uniforms[i].value=r.value}}if(e.defines!==void 0&&(this.defines=e.defines),e.vertexShader!==void 0&&(this.vertexShader=e.vertexShader),e.fragmentShader!==void 0&&(this.fragmentShader=e.fragmentShader),e.glslVersion!==void 0&&(this.glslVersion=e.glslVersion),e.extensions!==void 0)for(const i in e.extensions)this.extensions[i]=e.extensions[i];return e.lights!==void 0&&(this.lights=e.lights),e.clipping!==void 0&&(this.clipping=e.clipping),this}}class Ev extends Pn{constructor(e){super(e),this.isRawShaderMaterial=!0,this.type="RawShaderMaterial"}}class Tv extends es{constructor(e){super(),this.isMeshDepthMaterial=!0,this.type="MeshDepthMaterial",this.depthPacking=m_,this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.wireframe=!1,this.wireframeLinewidth=1,this.setValues(e)}copy(e){return super.copy(e),this.depthPacking=e.depthPacking,this.map=e.map,this.alphaMap=e.alphaMap,this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this}}class Av extends es{constructor(e){super(),this.isMeshDistanceMaterial=!0,this.type="MeshDistanceMaterial",this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.setValues(e)}copy(e){return super.copy(e),this.map=e.map,this.alphaMap=e.alphaMap,this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this}}const Sa=new U,Ma=new Xn,jn=new U;class Fp extends xn{constructor(){super(),this.isCamera=!0,this.type="Camera",this.matrixWorldInverse=new et,this.projectionMatrix=new et,this.projectionMatrixInverse=new et,this.coordinateSystem=ai,this._reversedDepth=!1}get reversedDepth(){return this._reversedDepth}copy(e,t){return super.copy(e,t),this.matrixWorldInverse.copy(e.matrixWorldInverse),this.projectionMatrix.copy(e.projectionMatrix),this.projectionMatrixInverse.copy(e.projectionMatrixInverse),this.coordinateSystem=e.coordinateSystem,this}getWorldDirection(e){return super.getWorldDirection(e).negate()}updateMatrixWorld(e){super.updateMatrixWorld(e),this.matrixWorld.decompose(Sa,Ma,jn),jn.x===1&&jn.y===1&&jn.z===1?this.matrixWorldInverse.copy(this.matrixWorld).invert():this.matrixWorldInverse.compose(Sa,Ma,jn.set(1,1,1)).invert()}updateWorldMatrix(e,t,i=!1){super.updateWorldMatrix(e,t,i),this.matrixWorld.decompose(Sa,Ma,jn),jn.x===1&&jn.y===1&&jn.z===1?this.matrixWorldInverse.copy(this.matrixWorld).invert():this.matrixWorldInverse.compose(Sa,Ma,jn.set(1,1,1)).invert()}clone(){return new this.constructor().copy(this)}}const ki=new U,Kf=new Ze,Zf=new Ze;class Rn extends Fp{constructor(e=50,t=1,i=.1,r=2e3){super(),this.isPerspectiveCamera=!0,this.type="PerspectiveCamera",this.fov=e,this.zoom=1,this.near=i,this.far=r,this.focus=10,this.aspect=t,this.view=null,this.filmGauge=35,this.filmOffset=0,this.updateProjectionMatrix()}copy(e,t){return super.copy(e,t),this.fov=e.fov,this.zoom=e.zoom,this.near=e.near,this.far=e.far,this.focus=e.focus,this.aspect=e.aspect,this.view=e.view===null?null:Object.assign({},e.view),this.filmGauge=e.filmGauge,this.filmOffset=e.filmOffset,this}setFocalLength(e){const t=.5*this.getFilmHeight()/e;this.fov=Fs*2*Math.atan(t),this.updateProjectionMatrix()}getFocalLength(){const e=Math.tan(Cs*.5*this.fov);return .5*this.getFilmHeight()/e}getEffectiveFOV(){return Fs*2*Math.atan(Math.tan(Cs*.5*this.fov)/this.zoom)}getFilmWidth(){return this.filmGauge*Math.min(this.aspect,1)}getFilmHeight(){return this.filmGauge/Math.max(this.aspect,1)}getViewBounds(e,t,i){ki.set(-1,-1,.5).applyMatrix4(this.projectionMatrixInverse),t.set(ki.x,ki.y).multiplyScalar(-e/ki.z),ki.set(1,1,.5).applyMatrix4(this.projectionMatrixInverse),i.set(ki.x,ki.y).multiplyScalar(-e/ki.z)}getViewSize(e,t){return this.getViewBounds(e,Kf,Zf),t.subVectors(Zf,Kf)}setViewOffset(e,t,i,r,s,a){this.aspect=e/t,this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=e,this.view.fullHeight=t,this.view.offsetX=i,this.view.offsetY=r,this.view.width=s,this.view.height=a,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){const e=this.near;let t=e*Math.tan(Cs*.5*this.fov)/this.zoom,i=2*t,r=this.aspect*i,s=-.5*r;const a=this.view;if(this.view!==null&&this.view.enabled){const l=a.fullWidth,c=a.fullHeight;s+=a.offsetX*r/l,t-=a.offsetY*i/c,r*=a.width/l,i*=a.height/c}const o=this.filmOffset;o!==0&&(s+=e*o/this.getFilmWidth()),this.projectionMatrix.makePerspective(s,s+r,t,t-i,e,this.far,this.coordinateSystem,this.reversedDepth),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(e){const t=super.toJSON(e);return t.object.fov=this.fov,t.object.zoom=this.zoom,t.object.near=this.near,t.object.far=this.far,t.object.focus=this.focus,t.object.aspect=this.aspect,this.view!==null&&(t.object.view=Object.assign({},this.view)),t.object.filmGauge=this.filmGauge,t.object.filmOffset=this.filmOffset,t}}class Lu extends Fp{constructor(e=-1,t=1,i=1,r=-1,s=.1,a=2e3){super(),this.isOrthographicCamera=!0,this.type="OrthographicCamera",this.zoom=1,this.view=null,this.left=e,this.right=t,this.top=i,this.bottom=r,this.near=s,this.far=a,this.updateProjectionMatrix()}copy(e,t){return super.copy(e,t),this.left=e.left,this.right=e.right,this.top=e.top,this.bottom=e.bottom,this.near=e.near,this.far=e.far,this.zoom=e.zoom,this.view=e.view===null?null:Object.assign({},e.view),this}setViewOffset(e,t,i,r,s,a){this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=e,this.view.fullHeight=t,this.view.offsetX=i,this.view.offsetY=r,this.view.width=s,this.view.height=a,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){const e=(this.right-this.left)/(2*this.zoom),t=(this.top-this.bottom)/(2*this.zoom),i=(this.right+this.left)/2,r=(this.top+this.bottom)/2;let s=i-e,a=i+e,o=r+t,l=r-t;if(this.view!==null&&this.view.enabled){const c=(this.right-this.left)/this.view.fullWidth/this.zoom,f=(this.top-this.bottom)/this.view.fullHeight/this.zoom;s+=c*this.view.offsetX,a=s+c*this.view.width,o-=f*this.view.offsetY,l=o-f*this.view.height}this.projectionMatrix.makeOrthographic(s,a,o,l,this.near,this.far,this.coordinateSystem,this.reversedDepth),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(e){const t=super.toJSON(e);return t.object.zoom=this.zoom,t.object.left=this.left,t.object.right=this.right,t.object.top=this.top,t.object.bottom=this.bottom,t.object.near=this.near,t.object.far=this.far,this.view!==null&&(t.object.view=Object.assign({},this.view)),t}}class Rv extends Jt{constructor(){super(),this.isInstancedBufferGeometry=!0,this.type="InstancedBufferGeometry",this.instanceCount=1/0}copy(e){return super.copy(e),this.instanceCount=e.instanceCount,this}toJSON(){const e=super.toJSON();return e.instanceCount=this.instanceCount,e.isInstancedBufferGeometry=!0,e}}const Dr=-90,Nr=1;class Cv extends xn{constructor(e,t,i){super(),this.type="CubeCamera",this.renderTarget=i,this.coordinateSystem=null,this.activeMipmapLevel=0;const r=new Rn(Dr,Nr,e,t);r.layers=this.layers,this.add(r);const s=new Rn(Dr,Nr,e,t);s.layers=this.layers,this.add(s);const a=new Rn(Dr,Nr,e,t);a.layers=this.layers,this.add(a);const o=new Rn(Dr,Nr,e,t);o.layers=this.layers,this.add(o);const l=new Rn(Dr,Nr,e,t);l.layers=this.layers,this.add(l);const c=new Rn(Dr,Nr,e,t);c.layers=this.layers,this.add(c)}updateCoordinateSystem(){const e=this.coordinateSystem,t=this.children.concat(),[i,r,s,a,o,l]=t;for(const c of t)this.remove(c);if(e===ai)i.up.set(0,1,0),i.lookAt(1,0,0),r.up.set(0,1,0),r.lookAt(-1,0,0),s.up.set(0,0,-1),s.lookAt(0,1,0),a.up.set(0,0,1),a.lookAt(0,-1,0),o.up.set(0,1,0),o.lookAt(0,0,1),l.up.set(0,1,0),l.lookAt(0,0,-1);else if(e===Mo)i.up.set(0,-1,0),i.lookAt(-1,0,0),r.up.set(0,-1,0),r.lookAt(1,0,0),s.up.set(0,0,1),s.lookAt(0,1,0),a.up.set(0,0,-1),a.lookAt(0,-1,0),o.up.set(0,-1,0),o.lookAt(0,0,1),l.up.set(0,-1,0),l.lookAt(0,0,-1);else throw new Error("THREE.CubeCamera.updateCoordinateSystem(): Invalid coordinate system: "+e);for(const c of t)this.add(c),c.updateMatrixWorld()}update(e,t){this.parent===null&&this.updateMatrixWorld();const{renderTarget:i,activeMipmapLevel:r}=this;this.coordinateSystem!==e.coordinateSystem&&(this.coordinateSystem=e.coordinateSystem,this.updateCoordinateSystem());const[s,a,o,l,c,f]=this.children,d=e.getRenderTarget(),u=e.getActiveCubeFace(),h=e.getActiveMipmapLevel(),_=e.xr.enabled;e.xr.enabled=!1;const g=i.texture.generateMipmaps;i.texture.generateMipmaps=!1;let p=!1;e.isWebGLRenderer===!0?p=e.state.buffers.depth.getReversed():p=e.reversedDepthBuffer,e.setRenderTarget(i,0,r),p&&e.autoClear===!1&&e.clearDepth(),e.render(t,s),e.setRenderTarget(i,1,r),p&&e.autoClear===!1&&e.clearDepth(),e.render(t,a),e.setRenderTarget(i,2,r),p&&e.autoClear===!1&&e.clearDepth(),e.render(t,o),e.setRenderTarget(i,3,r),p&&e.autoClear===!1&&e.clearDepth(),e.render(t,l),e.setRenderTarget(i,4,r),p&&e.autoClear===!1&&e.clearDepth(),e.render(t,c),i.texture.generateMipmaps=g,e.setRenderTarget(i,5,r),p&&e.autoClear===!1&&e.clearDepth(),e.render(t,f),e.setRenderTarget(d,u,h),e.xr.enabled=_,i.texture.needsPMREMUpdate=!0}}class Pv extends Rn{constructor(e=[]){super(),this.isArrayCamera=!0,this.isMultiViewCamera=!1,this.cameras=e}}class Gc extends cv{constructor(e,t,i=1){super(e,t),this.isInstancedInterleavedBuffer=!0,this.meshPerAttribute=i}copy(e){return super.copy(e),this.meshPerAttribute=e.meshPerAttribute,this}clone(e){const t=super.clone(e);return t.meshPerAttribute=this.meshPerAttribute,t}toJSON(e){const t=super.toJSON(e);return t.isInstancedInterleavedBuffer=!0,t.meshPerAttribute=this.meshPerAttribute,t}}class Bp{static{Bp.prototype.isMatrix2=!0}constructor(e,t,i,r){this.elements=[1,0,0,1],e!==void 0&&this.set(e,t,i,r)}identity(){return this.set(1,0,0,1),this}fromArray(e,t=0){for(let i=0;i<4;i++)this.elements[i]=e[i+t];return this}set(e,t,i,r){const s=this.elements;return s[0]=e,s[2]=t,s[1]=i,s[3]=r,this}}const Jf=new U,wa=new U,Ir=new U,Ur=new U,bl=new U,Lv=new U,Dv=new U;class fi{constructor(e=new U,t=new U){this.start=e,this.end=t}set(e,t){return this.start.copy(e),this.end.copy(t),this}copy(e){return this.start.copy(e.start),this.end.copy(e.end),this}getCenter(e){return e.addVectors(this.start,this.end).multiplyScalar(.5)}delta(e){return e.subVectors(this.end,this.start)}distanceSq(){return this.start.distanceToSquared(this.end)}distance(){return this.start.distanceTo(this.end)}at(e,t){return this.delta(t).multiplyScalar(e).add(this.start)}closestPointToPointParameter(e,t){Jf.subVectors(e,this.start),wa.subVectors(this.end,this.start);const i=wa.dot(wa);if(i===0)return 0;let s=wa.dot(Jf)/i;return t&&(s=Ye(s,0,1)),s}closestPointToPoint(e,t,i){const r=this.closestPointToPointParameter(e,t);return this.delta(i).multiplyScalar(r).add(this.start)}distanceSqToLine3(e,t=Lv,i=Dv){const r=10000000000000001e-32;let s,a;const o=this.start,l=e.start,c=this.end,f=e.end;Ir.subVectors(c,o),Ur.subVectors(f,l),bl.subVectors(o,l);const d=Ir.dot(Ir),u=Ur.dot(Ur),h=Ur.dot(bl);if(d<=r&&u<=r)return t.copy(o),i.copy(l),t.sub(i),t.dot(t);if(d<=r)s=0,a=h/u,a=Ye(a,0,1);else{const _=Ir.dot(bl);if(u<=r)a=0,s=Ye(-_/d,0,1);else{const g=Ir.dot(Ur),p=d*u-g*g;p!==0?s=Ye((g*h-_*u)/p,0,1):s=0,a=(g*s+h)/u,a<0?(a=0,s=Ye(-_/d,0,1)):a>1&&(a=1,s=Ye((g-_)/d,0,1))}}return t.copy(o).addScaledVector(Ir,s),i.copy(l).addScaledVector(Ur,a),t.distanceToSquared(i)}applyMatrix4(e){return this.start.applyMatrix4(e),this.end.applyMatrix4(e),this}equals(e){return e.start.equals(this.start)&&e.end.equals(this.end)}clone(){return new this.constructor().copy(this)}}function Qf(n,e,t,i){const r=Nv(i);switch(t){case xp:return n*e;case bp:return n*e/r.components*r.byteLength;case Su:return n*e/r.components*r.byteLength;case mr:return n*e*2/r.components*r.byteLength;case Mu:return n*e*2/r.components*r.byteLength;case yp:return n*e*3/r.components*r.byteLength;case $n:return n*e*4/r.components*r.byteLength;case wu:return n*e*4/r.components*r.byteLength;case eo:case to:return Math.floor((n+3)/4)*Math.floor((e+3)/4)*8;case no:case io:return Math.floor((n+3)/4)*Math.floor((e+3)/4)*16;case hc:case mc:return Math.max(n,16)*Math.max(e,8)/4;case dc:case pc:return Math.max(n,8)*Math.max(e,8)/2;case gc:case _c:case xc:case yc:return Math.floor((n+3)/4)*Math.floor((e+3)/4)*8;case vc:case xo:case bc:return Math.floor((n+3)/4)*Math.floor((e+3)/4)*16;case Sc:return Math.floor((n+3)/4)*Math.floor((e+3)/4)*16;case Mc:return Math.floor((n+4)/5)*Math.floor((e+3)/4)*16;case wc:return Math.floor((n+4)/5)*Math.floor((e+4)/5)*16;case Ec:return Math.floor((n+5)/6)*Math.floor((e+4)/5)*16;case Tc:return Math.floor((n+5)/6)*Math.floor((e+5)/6)*16;case Ac:return Math.floor((n+7)/8)*Math.floor((e+4)/5)*16;case Rc:return Math.floor((n+7)/8)*Math.floor((e+5)/6)*16;case Cc:return Math.floor((n+7)/8)*Math.floor((e+7)/8)*16;case Pc:return Math.floor((n+9)/10)*Math.floor((e+4)/5)*16;case Lc:return Math.floor((n+9)/10)*Math.floor((e+5)/6)*16;case Dc:return Math.floor((n+9)/10)*Math.floor((e+7)/8)*16;case Nc:return Math.floor((n+9)/10)*Math.floor((e+9)/10)*16;case Ic:return Math.floor((n+11)/12)*Math.floor((e+9)/10)*16;case Uc:return Math.floor((n+11)/12)*Math.floor((e+11)/12)*16;case Fc:case Bc:case Oc:return Math.ceil(n/4)*Math.ceil(e/4)*16;case kc:case zc:return Math.ceil(n/4)*Math.ceil(e/4)*8;case yo:case Vc:return Math.ceil(n/4)*Math.ceil(e/4)*16}throw new Error(`Unable to determine texture byte length for ${t} format.`)}function Nv(n){switch(n){case Bn:case mp:return{byteLength:1,components:1};case Is:case gp:case ui:return{byteLength:2,components:1};case yu:case bu:return{byteLength:2,components:4};case ci:case xu:case si:return{byteLength:4,components:1};case _p:case vp:return{byteLength:4,components:3}}throw new Error(`THREE.TextureUtils: Unknown texture type ${n}.`)}typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("register",{detail:{revision:Vs}}));typeof window<"u"&&(window.__THREE__?ze("WARNING: Multiple instances of Three.js being imported."):window.__THREE__=Vs);function Op(){let n=null,e=!1,t=null,i=null;function r(s,a){i=n.requestAnimationFrame(r),t(s,a)}return{start:function(){e!==!0&&t!==null&&n!==null&&(i=n.requestAnimationFrame(r),e=!0)},stop:function(){n!==null&&n.cancelAnimationFrame(i),e=!1},setAnimationLoop:function(s){t=s},setContext:function(s){n=s}}}function Iv(n){const e=new WeakMap;function t(o,l){const c=o.array,f=o.usage,d=c.byteLength,u=n.createBuffer();n.bindBuffer(l,u),n.bufferData(l,c,f),o.onUploadCallback();let h;if(c instanceof Float32Array)h=n.FLOAT;else if(typeof Float16Array<"u"&&c instanceof Float16Array)h=n.HALF_FLOAT;else if(c instanceof Uint16Array)o.isFloat16BufferAttribute?h=n.HALF_FLOAT:h=n.UNSIGNED_SHORT;else if(c instanceof Int16Array)h=n.SHORT;else if(c instanceof Uint32Array)h=n.UNSIGNED_INT;else if(c instanceof Int32Array)h=n.INT;else if(c instanceof Int8Array)h=n.BYTE;else if(c instanceof Uint8Array)h=n.UNSIGNED_BYTE;else if(c instanceof Uint8ClampedArray)h=n.UNSIGNED_BYTE;else throw new Error("THREE.WebGLAttributes: Unsupported buffer data format: "+c);return{buffer:u,type:h,bytesPerElement:c.BYTES_PER_ELEMENT,version:o.version,size:d}}function i(o,l,c){const f=l.array,d=l.updateRanges;if(n.bindBuffer(c,o),d.length===0)n.bufferSubData(c,0,f);else{d.sort((h,_)=>h.start-_.start);let u=0;for(let h=1;h<d.length;h++){const _=d[u],g=d[h];g.start<=_.start+_.count+1?_.count=Math.max(_.count,g.start+g.count-_.start):(++u,d[u]=g)}d.length=u+1;for(let h=0,_=d.length;h<_;h++){const g=d[h];n.bufferSubData(c,g.start*f.BYTES_PER_ELEMENT,f,g.start,g.count)}l.clearUpdateRanges()}l.onUploadCallback()}function r(o){return o.isInterleavedBufferAttribute&&(o=o.data),e.get(o)}function s(o){o.isInterleavedBufferAttribute&&(o=o.data);const l=e.get(o);l&&(n.deleteBuffer(l.buffer),e.delete(o))}function a(o,l){if(o.isInterleavedBufferAttribute&&(o=o.data),o.isGLBufferAttribute){const f=e.get(o);(!f||f.version<o.version)&&e.set(o,{buffer:o.buffer,type:o.type,bytesPerElement:o.elementSize,version:o.version});return}const c=e.get(o);if(c===void 0)e.set(o,t(o,l));else if(c.version<o.version){if(c.size!==o.array.byteLength)throw new Error("THREE.WebGLAttributes: The size of the buffer attribute's array buffer does not match the original size. Resizing buffer attributes is not supported.");i(c.buffer,o,l),c.version=o.version}}return{get:r,remove:s,update:a}}var Uv=`#ifdef USE_ALPHAHASH
	if ( diffuseColor.a < getAlphaHashThreshold( vPosition ) ) discard;
#endif`,Fv=`#ifdef USE_ALPHAHASH
	const float ALPHA_HASH_SCALE = 0.05;
	float hash2D( vec2 value ) {
		return fract( 1.0e4 * sin( 17.0 * value.x + 0.1 * value.y ) * ( 0.1 + abs( sin( 13.0 * value.y + value.x ) ) ) );
	}
	float hash3D( vec3 value ) {
		return hash2D( vec2( hash2D( value.xy ), value.z ) );
	}
	float getAlphaHashThreshold( vec3 position ) {
		float maxDeriv = max(
			length( dFdx( position.xyz ) ),
			length( dFdy( position.xyz ) )
		);
		float pixScale = 1.0 / ( ALPHA_HASH_SCALE * maxDeriv );
		vec2 pixScales = vec2(
			exp2( floor( log2( pixScale ) ) ),
			exp2( ceil( log2( pixScale ) ) )
		);
		vec2 alpha = vec2(
			hash3D( floor( pixScales.x * position.xyz ) ),
			hash3D( floor( pixScales.y * position.xyz ) )
		);
		float lerpFactor = fract( log2( pixScale ) );
		float x = ( 1.0 - lerpFactor ) * alpha.x + lerpFactor * alpha.y;
		float a = min( lerpFactor, 1.0 - lerpFactor );
		vec3 cases = vec3(
			x * x / ( 2.0 * a * ( 1.0 - a ) ),
			( x - 0.5 * a ) / ( 1.0 - a ),
			1.0 - ( ( 1.0 - x ) * ( 1.0 - x ) / ( 2.0 * a * ( 1.0 - a ) ) )
		);
		float threshold = ( x < ( 1.0 - a ) )
			? ( ( x < a ) ? cases.x : cases.y )
			: cases.z;
		return clamp( threshold , 1.0e-6, 1.0 );
	}
#endif`,Bv=`#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;
#endif`,Ov=`#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,kv=`#ifdef USE_ALPHATEST
	#ifdef ALPHA_TO_COVERAGE
	diffuseColor.a = smoothstep( alphaTest, alphaTest + fwidth( diffuseColor.a ), diffuseColor.a );
	if ( diffuseColor.a == 0.0 ) discard;
	#else
	if ( diffuseColor.a < alphaTest ) discard;
	#endif
#endif`,zv=`#ifdef USE_ALPHATEST
	uniform float alphaTest;
#endif`,Vv=`#ifdef USE_AOMAP
	float ambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
	reflectedLight.indirectDiffuse *= ambientOcclusion;
	#if defined( USE_CLEARCOAT ) 
		clearcoatSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_SHEEN ) 
		sheenSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
	#endif
#endif`,Hv=`#ifdef USE_AOMAP
	uniform sampler2D aoMap;
	uniform float aoMapIntensity;
#endif`,Gv=`#ifdef USE_BATCHING
	#if ! defined( GL_ANGLE_multi_draw )
	#define gl_DrawID _gl_DrawID
	uniform int _gl_DrawID;
	#endif
	uniform highp sampler2D batchingTexture;
	uniform highp usampler2D batchingIdTexture;
	mat4 getBatchingMatrix( const in float i ) {
		int size = textureSize( batchingTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( batchingTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( batchingTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( batchingTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( batchingTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
	float getIndirectIndex( const in int i ) {
		int size = textureSize( batchingIdTexture, 0 ).x;
		int x = i % size;
		int y = i / size;
		return float( texelFetch( batchingIdTexture, ivec2( x, y ), 0 ).r );
	}
#endif
#ifdef USE_BATCHING_COLOR
	uniform sampler2D batchingColorTexture;
	vec4 getBatchingColor( const in float i ) {
		int size = textureSize( batchingColorTexture, 0 ).x;
		int j = int( i );
		int x = j % size;
		int y = j / size;
		return texelFetch( batchingColorTexture, ivec2( x, y ), 0 );
	}
#endif`,Wv=`#ifdef USE_BATCHING
	mat4 batchingMatrix = getBatchingMatrix( getIndirectIndex( gl_DrawID ) );
#endif`,$v=`vec3 transformed = vec3( position );
#ifdef USE_ALPHAHASH
	vPosition = vec3( position );
#endif`,Xv=`vec3 objectNormal = vec3( normal );
#ifdef USE_TANGENT
	vec3 objectTangent = vec3( tangent.xyz );
#endif`,qv=`float G_BlinnPhong_Implicit( ) {
	return 0.25;
}
float D_BlinnPhong( const in float shininess, const in float dotNH ) {
	return RECIPROCAL_PI * ( shininess * 0.5 + 1.0 ) * pow( dotNH, shininess );
}
vec3 BRDF_BlinnPhong( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in vec3 specularColor, const in float shininess ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( specularColor, 1.0, dotVH );
	float G = G_BlinnPhong_Implicit( );
	float D = D_BlinnPhong( shininess, dotNH );
	return F * ( G * D );
} // validated`,Yv=`#ifdef USE_IRIDESCENCE
	const mat3 XYZ_TO_REC709 = mat3(
		 3.2404542, -0.9692660,  0.0556434,
		-1.5371385,  1.8760108, -0.2040259,
		-0.4985314,  0.0415560,  1.0572252
	);
	vec3 Fresnel0ToIor( vec3 fresnel0 ) {
		vec3 sqrtF0 = sqrt( fresnel0 );
		return ( vec3( 1.0 ) + sqrtF0 ) / ( vec3( 1.0 ) - sqrtF0 );
	}
	vec3 IorToFresnel0( vec3 transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - vec3( incidentIor ) ) / ( transmittedIor + vec3( incidentIor ) ) );
	}
	float IorToFresnel0( float transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - incidentIor ) / ( transmittedIor + incidentIor ));
	}
	vec3 evalSensitivity( float OPD, vec3 shift ) {
		float phase = 2.0 * PI * OPD * 1.0e-9;
		vec3 val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
		vec3 pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
		vec3 var = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );
		vec3 xyz = val * sqrt( 2.0 * PI * var ) * cos( pos * phase + shift ) * exp( - pow2( phase ) * var );
		xyz.x += 9.7470e-14 * sqrt( 2.0 * PI * 4.5282e+09 ) * cos( 2.2399e+06 * phase + shift[ 0 ] ) * exp( - 4.5282e+09 * pow2( phase ) );
		xyz /= 1.0685e-7;
		vec3 rgb = XYZ_TO_REC709 * xyz;
		return rgb;
	}
	vec3 evalIridescence( float outsideIOR, float eta2, float cosTheta1, float thinFilmThickness, vec3 baseF0 ) {
		vec3 I;
		float iridescenceIOR = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) );
		float sinTheta2Sq = pow2( outsideIOR / iridescenceIOR ) * ( 1.0 - pow2( cosTheta1 ) );
		float cosTheta2Sq = 1.0 - sinTheta2Sq;
		if ( cosTheta2Sq < 0.0 ) {
			return vec3( 1.0 );
		}
		float cosTheta2 = sqrt( cosTheta2Sq );
		float R0 = IorToFresnel0( iridescenceIOR, outsideIOR );
		float R12 = F_Schlick( R0, 1.0, cosTheta1 );
		float T121 = 1.0 - R12;
		float phi12 = 0.0;
		if ( iridescenceIOR < outsideIOR ) phi12 = PI;
		float phi21 = PI - phi12;
		vec3 baseIOR = Fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) );		vec3 R1 = IorToFresnel0( baseIOR, iridescenceIOR );
		vec3 R23 = F_Schlick( R1, 1.0, cosTheta2 );
		vec3 phi23 = vec3( 0.0 );
		if ( baseIOR[ 0 ] < iridescenceIOR ) phi23[ 0 ] = PI;
		if ( baseIOR[ 1 ] < iridescenceIOR ) phi23[ 1 ] = PI;
		if ( baseIOR[ 2 ] < iridescenceIOR ) phi23[ 2 ] = PI;
		float OPD = 2.0 * iridescenceIOR * thinFilmThickness * cosTheta2;
		vec3 phi = vec3( phi21 ) + phi23;
		vec3 R123 = clamp( R12 * R23, 1e-5, 0.9999 );
		vec3 r123 = sqrt( R123 );
		vec3 Rs = pow2( T121 ) * R23 / ( vec3( 1.0 ) - R123 );
		vec3 C0 = R12 + Rs;
		I = C0;
		vec3 Cm = Rs - T121;
		for ( int m = 1; m <= 2; ++ m ) {
			Cm *= r123;
			vec3 Sm = 2.0 * evalSensitivity( float( m ) * OPD, float( m ) * phi );
			I += Cm * Sm;
		}
		return max( I, vec3( 0.0 ) );
	}
#endif`,Kv=`#ifdef USE_BUMPMAP
	uniform sampler2D bumpMap;
	uniform float bumpScale;
	vec2 dHdxy_fwd() {
		vec2 dSTdx = dFdx( vBumpMapUv );
		vec2 dSTdy = dFdy( vBumpMapUv );
		float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv ).x;
		float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdx ).x - Hll;
		float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdy ).x - Hll;
		return vec2( dBx, dBy );
	}
	vec3 perturbNormalArb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
		vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) );
		vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) );
		vec3 vN = surf_norm;
		vec3 R1 = cross( vSigmaY, vN );
		vec3 R2 = cross( vN, vSigmaX );
		float fDet = dot( vSigmaX, R1 ) * faceDirection;
		vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
		return normalize( abs( fDet ) * surf_norm - vGrad );
	}
#endif`,Zv=`#if NUM_CLIPPING_PLANES > 0
	vec4 plane;
	#ifdef ALPHA_TO_COVERAGE
		float distanceToPlane, distanceGradient;
		float clipOpacity = 1.0;
		#pragma unroll_loop_start
		for ( int i = 0; i < UNION_CLIPPING_PLANES; i ++ ) {
			plane = clippingPlanes[ i ];
			distanceToPlane = - dot( vClipPosition, plane.xyz ) + plane.w;
			distanceGradient = fwidth( distanceToPlane ) / 2.0;
			clipOpacity *= smoothstep( - distanceGradient, distanceGradient, distanceToPlane );
			if ( clipOpacity == 0.0 ) discard;
		}
		#pragma unroll_loop_end
		#if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
			float unionClipOpacity = 1.0;
			#pragma unroll_loop_start
			for ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {
				plane = clippingPlanes[ i ];
				distanceToPlane = - dot( vClipPosition, plane.xyz ) + plane.w;
				distanceGradient = fwidth( distanceToPlane ) / 2.0;
				unionClipOpacity *= 1.0 - smoothstep( - distanceGradient, distanceGradient, distanceToPlane );
			}
			#pragma unroll_loop_end
			clipOpacity *= 1.0 - unionClipOpacity;
		#endif
		diffuseColor.a *= clipOpacity;
		if ( diffuseColor.a == 0.0 ) discard;
	#else
		#pragma unroll_loop_start
		for ( int i = 0; i < UNION_CLIPPING_PLANES; i ++ ) {
			plane = clippingPlanes[ i ];
			if ( dot( vClipPosition, plane.xyz ) > plane.w ) discard;
		}
		#pragma unroll_loop_end
		#if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
			bool clipped = true;
			#pragma unroll_loop_start
			for ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {
				plane = clippingPlanes[ i ];
				clipped = ( dot( vClipPosition, plane.xyz ) > plane.w ) && clipped;
			}
			#pragma unroll_loop_end
			if ( clipped ) discard;
		#endif
	#endif
#endif`,Jv=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
	uniform vec4 clippingPlanes[ NUM_CLIPPING_PLANES ];
#endif`,Qv=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
#endif`,jv=`#if NUM_CLIPPING_PLANES > 0
	vClipPosition = - mvPosition.xyz;
#endif`,ex=`#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	diffuseColor *= vColor;
#endif`,tx=`#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	varying vec4 vColor;
#endif`,nx=`#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
	varying vec4 vColor;
#endif`,ix=`#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
	vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR_ALPHA
	vColor *= color;
#elif defined( USE_COLOR )
	vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
	vColor.rgb *= instanceColor.rgb;
#endif
#ifdef USE_BATCHING_COLOR
	vColor *= getBatchingColor( getIndirectIndex( gl_DrawID ) );
#endif`,rx=`#define PI 3.141592653589793
#define PI2 6.283185307179586
#define PI_HALF 1.5707963267948966
#define RECIPROCAL_PI 0.3183098861837907
#define RECIPROCAL_PI2 0.15915494309189535
#define EPSILON 1e-6
#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
#define whiteComplement( a ) ( 1.0 - saturate( a ) )
float pow2( const in float x ) { return x*x; }
vec3 pow2( const in vec3 x ) { return x*x; }
float pow3( const in float x ) { return x*x*x; }
float pow4( const in float x ) { float x2 = x*x; return x2*x2; }
float max3( const in vec3 v ) { return max( max( v.x, v.y ), v.z ); }
float average( const in vec3 v ) { return dot( v, vec3( 0.3333333 ) ); }
highp float rand( const in vec2 uv ) {
	const highp float a = 12.9898, b = 78.233, c = 43758.5453;
	highp float dt = dot( uv.xy, vec2( a,b ) ), sn = mod( dt, PI );
	return fract( sin( sn ) * c );
}
#ifdef HIGH_PRECISION
	float precisionSafeLength( vec3 v ) { return length( v ); }
#else
	float precisionSafeLength( vec3 v ) {
		float maxComponent = max3( abs( v ) );
		return length( v / maxComponent ) * maxComponent;
	}
#endif
struct IncidentLight {
	vec3 color;
	vec3 direction;
	bool visible;
};
struct ReflectedLight {
	vec3 directDiffuse;
	vec3 directSpecular;
	vec3 indirectDiffuse;
	vec3 indirectSpecular;
};
#ifdef USE_ALPHAHASH
	varying vec3 vPosition;
#endif
vec3 transformDirection( in vec3 dir, in mat4 matrix ) {
	return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );
}
#define inverseTransformDirection transformDirectionByInverseViewMatrix
vec3 transformNormalByInverseViewMatrix( in vec3 normal, in mat4 viewMatrix ) {
	return normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
}
vec3 transformDirectionByInverseViewMatrix( in vec3 dir, in mat4 viewMatrix ) {
	return normalize( ( vec4( dir, 0.0 ) * viewMatrix ).xyz );
}
bool isPerspectiveMatrix( mat4 m ) {
	return m[ 2 ][ 3 ] == - 1.0;
}
vec2 equirectUv( in vec3 dir ) {
	float u = atan( dir.z, dir.x ) * RECIPROCAL_PI2 + 0.5;
	float v = asin( clamp( dir.y, - 1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5;
	return vec2( u, v );
}
vec3 BRDF_Lambert( const in vec3 diffuseColor ) {
	return RECIPROCAL_PI * diffuseColor;
}
vec3 F_Schlick( const in vec3 f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
}
float F_Schlick( const in float f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
} // validated`,sx=`#ifdef ENVMAP_TYPE_CUBE_UV
	#define cubeUV_minMipLevel 4.0
	#define cubeUV_minTileSize 16.0
	float getFace( vec3 direction ) {
		vec3 absDirection = abs( direction );
		float face = - 1.0;
		if ( absDirection.x > absDirection.z ) {
			if ( absDirection.x > absDirection.y )
				face = direction.x > 0.0 ? 0.0 : 3.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		} else {
			if ( absDirection.z > absDirection.y )
				face = direction.z > 0.0 ? 2.0 : 5.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		}
		return face;
	}
	vec2 getUV( vec3 direction, float face ) {
		vec2 uv;
		if ( face == 0.0 ) {
			uv = vec2( direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 1.0 ) {
			uv = vec2( - direction.x, - direction.z ) / abs( direction.y );
		} else if ( face == 2.0 ) {
			uv = vec2( - direction.x, direction.y ) / abs( direction.z );
		} else if ( face == 3.0 ) {
			uv = vec2( - direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 4.0 ) {
			uv = vec2( - direction.x, direction.z ) / abs( direction.y );
		} else {
			uv = vec2( direction.x, direction.y ) / abs( direction.z );
		}
		return 0.5 * ( uv + 1.0 );
	}
	vec3 bilinearCubeUV( sampler2D envMap, vec3 direction, float mipInt ) {
		float face = getFace( direction );
		float filterInt = max( cubeUV_minMipLevel - mipInt, 0.0 );
		mipInt = max( mipInt, cubeUV_minMipLevel );
		float faceSize = exp2( mipInt );
		highp vec2 uv = getUV( direction, face ) * ( faceSize - 2.0 ) + 1.0;
		if ( face > 2.0 ) {
			uv.y += faceSize;
			face -= 3.0;
		}
		uv.x += face * faceSize;
		uv.x += filterInt * 3.0 * cubeUV_minTileSize;
		uv.y += 4.0 * ( exp2( CUBEUV_MAX_MIP ) - faceSize );
		uv.x *= CUBEUV_TEXEL_WIDTH;
		uv.y *= CUBEUV_TEXEL_HEIGHT;
		#ifdef texture2DGradEXT
			return texture2DGradEXT( envMap, uv, vec2( 0.0 ), vec2( 0.0 ) ).rgb;
		#else
			return texture2D( envMap, uv ).rgb;
		#endif
	}
	#define cubeUV_r0 1.0
	#define cubeUV_m0 - 2.0
	#define cubeUV_r1 0.8
	#define cubeUV_m1 - 1.0
	#define cubeUV_r4 0.4
	#define cubeUV_m4 2.0
	#define cubeUV_r5 0.305
	#define cubeUV_m5 3.0
	#define cubeUV_r6 0.21
	#define cubeUV_m6 4.0
	float roughnessToMip( float roughness ) {
		float mip = 0.0;
		if ( roughness >= cubeUV_r1 ) {
			mip = ( cubeUV_r0 - roughness ) * ( cubeUV_m1 - cubeUV_m0 ) / ( cubeUV_r0 - cubeUV_r1 ) + cubeUV_m0;
		} else if ( roughness >= cubeUV_r4 ) {
			mip = ( cubeUV_r1 - roughness ) * ( cubeUV_m4 - cubeUV_m1 ) / ( cubeUV_r1 - cubeUV_r4 ) + cubeUV_m1;
		} else if ( roughness >= cubeUV_r5 ) {
			mip = ( cubeUV_r4 - roughness ) * ( cubeUV_m5 - cubeUV_m4 ) / ( cubeUV_r4 - cubeUV_r5 ) + cubeUV_m4;
		} else if ( roughness >= cubeUV_r6 ) {
			mip = ( cubeUV_r5 - roughness ) * ( cubeUV_m6 - cubeUV_m5 ) / ( cubeUV_r5 - cubeUV_r6 ) + cubeUV_m5;
		} else {
			mip = - 2.0 * log2( 1.16 * roughness );		}
		return mip;
	}
	vec4 textureCubeUV( sampler2D envMap, vec3 sampleDir, float roughness ) {
		float mip = clamp( roughnessToMip( roughness ), cubeUV_m0, CUBEUV_MAX_MIP );
		float mipF = fract( mip );
		float mipInt = floor( mip );
		vec3 color0 = bilinearCubeUV( envMap, sampleDir, mipInt );
		if ( mipF == 0.0 ) {
			return vec4( color0, 1.0 );
		} else {
			vec3 color1 = bilinearCubeUV( envMap, sampleDir, mipInt + 1.0 );
			return vec4( mix( color0, color1, mipF ), 1.0 );
		}
	}
#endif`,ax=`vec3 transformedNormal = objectNormal;
#ifdef USE_TANGENT
	vec3 transformedTangent = objectTangent;
#endif
#ifdef USE_BATCHING
	mat3 bm = mat3( batchingMatrix );
	transformedNormal /= vec3( dot( bm[ 0 ], bm[ 0 ] ), dot( bm[ 1 ], bm[ 1 ] ), dot( bm[ 2 ], bm[ 2 ] ) );
	transformedNormal = bm * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = bm * transformedTangent;
	#endif
#endif
#ifdef USE_INSTANCING
	mat3 im = mat3( instanceMatrix );
	transformedNormal /= vec3( dot( im[ 0 ], im[ 0 ] ), dot( im[ 1 ], im[ 1 ] ), dot( im[ 2 ], im[ 2 ] ) );
	transformedNormal = im * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = im * transformedTangent;
	#endif
#endif
transformedNormal = normalMatrix * transformedNormal;
#ifdef FLIP_SIDED
	transformedNormal = - transformedNormal;
#endif
#ifdef USE_TANGENT
	transformedTangent = ( modelViewMatrix * vec4( transformedTangent, 0.0 ) ).xyz;
#endif`,ox=`#ifdef USE_DISPLACEMENTMAP
	uniform sampler2D displacementMap;
	uniform float displacementScale;
	uniform float displacementBias;
#endif`,lx=`#ifdef USE_DISPLACEMENTMAP
	transformed += normalize( objectNormal ) * ( texture2D( displacementMap, vDisplacementMapUv ).x * displacementScale + displacementBias );
#endif`,cx=`#ifdef USE_EMISSIVEMAP
	vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
	#ifdef DECODE_VIDEO_TEXTURE_EMISSIVE
		emissiveColor = sRGBTransferEOTF( emissiveColor );
	#endif
	totalEmissiveRadiance *= emissiveColor.rgb;
#endif`,ux=`#ifdef USE_EMISSIVEMAP
	uniform sampler2D emissiveMap;
#endif`,fx="gl_FragColor = linearToOutputTexel( gl_FragColor );",dx=`vec4 LinearTransferOETF( in vec4 value ) {
	return value;
}
vec4 sRGBTransferEOTF( in vec4 value ) {
	return vec4( mix( pow( value.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), value.rgb * 0.0773993808, vec3( lessThanEqual( value.rgb, vec3( 0.04045 ) ) ) ), value.a );
}
vec4 sRGBTransferOETF( in vec4 value ) {
	return vec4( mix( pow( value.rgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), value.rgb * 12.92, vec3( lessThanEqual( value.rgb, vec3( 0.0031308 ) ) ) ), value.a );
}`,hx=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vec3 cameraToFrag;
		if ( isOrthographic ) {
			cameraToFrag = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToFrag = normalize( vWorldPosition - cameraPosition );
		}
		vec3 worldNormal = transformNormalByInverseViewMatrix( normal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vec3 reflectVec = reflect( cameraToFrag, worldNormal );
		#else
			vec3 reflectVec = refract( cameraToFrag, worldNormal, refractionRatio );
		#endif
	#else
		vec3 reflectVec = vReflect;
	#endif
	#ifdef ENVMAP_TYPE_CUBE
		vec4 envColor = textureCube( envMap, envMapRotation * reflectVec );
		#ifdef ENVMAP_BLENDING_MULTIPLY
			outgoingLight = mix( outgoingLight, outgoingLight * envColor.xyz, specularStrength * reflectivity );
		#elif defined( ENVMAP_BLENDING_MIX )
			outgoingLight = mix( outgoingLight, envColor.xyz, specularStrength * reflectivity );
		#elif defined( ENVMAP_BLENDING_ADD )
			outgoingLight += envColor.xyz * specularStrength * reflectivity;
		#endif
	#endif
#endif`,px=`#ifdef USE_ENVMAP
	uniform float envMapIntensity;
	uniform mat3 envMapRotation;
	#ifdef ENVMAP_TYPE_CUBE
		uniform samplerCube envMap;
	#else
		uniform sampler2D envMap;
	#endif
#endif`,mx=`#ifdef USE_ENVMAP
	uniform float reflectivity;
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		varying vec3 vWorldPosition;
		uniform float refractionRatio;
	#else
		varying vec3 vReflect;
	#endif
#endif`,gx=`#ifdef USE_ENVMAP
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		
		varying vec3 vWorldPosition;
	#else
		varying vec3 vReflect;
		uniform float refractionRatio;
	#endif
#endif`,_x=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vWorldPosition = worldPosition.xyz;
	#else
		vec3 cameraToVertex;
		if ( isOrthographic ) {
			cameraToVertex = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToVertex = normalize( worldPosition.xyz - cameraPosition );
		}
		vec3 worldNormal = transformNormalByInverseViewMatrix( transformedNormal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vReflect = reflect( cameraToVertex, worldNormal );
		#else
			vReflect = refract( cameraToVertex, worldNormal, refractionRatio );
		#endif
	#endif
#endif`,vx=`#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
#endif`,xx=`#ifdef USE_FOG
	varying float vFogDepth;
#endif`,yx=`#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`,bx=`#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`,Sx=`#ifdef USE_GRADIENTMAP
	uniform sampler2D gradientMap;
#endif
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
	float dotNL = dot( normal, lightDirection );
	vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.0 );
	#ifdef USE_GRADIENTMAP
		return vec3( texture2D( gradientMap, coord ).r );
	#else
		vec2 fw = fwidth( coord ) * 0.5;
		return mix( vec3( 0.7 ), vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
	#endif
}`,Mx=`#ifdef USE_LIGHTMAP
	uniform sampler2D lightMap;
	uniform float lightMapIntensity;
#endif`,wx=`LambertMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularStrength = specularStrength;`,Ex=`varying vec3 vViewPosition;
struct LambertMaterial {
	vec3 diffuseColor;
	float specularStrength;
};
void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Lambert
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Lambert`,Tx=`uniform bool receiveShadow;
uniform vec3 ambientLightColor;
#if defined( USE_LIGHT_PROBES )
	uniform vec3 lightProbe[ 9 ];
#endif
vec3 shGetIrradianceAt( in vec3 normal, in vec3 shCoefficients[ 9 ] ) {
	float x = normal.x, y = normal.y, z = normal.z;
	vec3 result = shCoefficients[ 0 ] * 0.886227;
	result += shCoefficients[ 1 ] * 2.0 * 0.511664 * y;
	result += shCoefficients[ 2 ] * 2.0 * 0.511664 * z;
	result += shCoefficients[ 3 ] * 2.0 * 0.511664 * x;
	result += shCoefficients[ 4 ] * 2.0 * 0.429043 * x * y;
	result += shCoefficients[ 5 ] * 2.0 * 0.429043 * y * z;
	result += shCoefficients[ 6 ] * ( 0.743125 * z * z - 0.247708 );
	result += shCoefficients[ 7 ] * 2.0 * 0.429043 * x * z;
	result += shCoefficients[ 8 ] * 0.429043 * ( x * x - y * y );
	return result;
}
vec3 getLightProbeIrradiance( const in vec3 lightProbe[ 9 ], const in vec3 normal ) {
	vec3 worldNormal = transformNormalByInverseViewMatrix( normal, viewMatrix );
	vec3 irradiance = shGetIrradianceAt( worldNormal, lightProbe );
	return irradiance;
}
vec3 getAmbientLightIrradiance( const in vec3 ambientLightColor ) {
	vec3 irradiance = ambientLightColor;
	return irradiance;
}
float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {
	float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );
	if ( cutoffDistance > 0.0 ) {
		distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );
	}
	return distanceFalloff;
}
float getSpotAttenuation( const in float coneCosine, const in float penumbraCosine, const in float angleCosine ) {
	return smoothstep( coneCosine, penumbraCosine, angleCosine );
}
#if NUM_SUN_LIGHTS > 0
	struct SunLight {
		vec3 direction;
		vec3 color;
	};
	uniform SunLight sunLights[ NUM_SUN_LIGHTS ];
	void getSunLightInfo( const in SunLight sunLight, out IncidentLight light ) {
		light.color = sunLight.color;
		light.direction = sunLight.direction;
		light.visible = true;
	}
#endif
#if NUM_DIR_LIGHTS > 0
	struct DirectionalLight {
		vec3 direction;
		vec3 color;
	};
	uniform DirectionalLight directionalLights[ NUM_DIR_LIGHTS ];
	void getDirectionalLightInfo( const in DirectionalLight directionalLight, out IncidentLight light ) {
		light.color = directionalLight.color;
		light.direction = directionalLight.direction;
		light.visible = true;
	}
#endif
#if NUM_POINT_LIGHTS > 0
	struct PointLight {
		vec3 position;
		vec3 color;
		float distance;
		float decay;
	};
	uniform PointLight pointLights[ NUM_POINT_LIGHTS ];
	void getPointLightInfo( const in PointLight pointLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = pointLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float lightDistance = length( lVector );
		light.color = pointLight.color;
		light.color *= getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay );
		light.visible = ( light.color != vec3( 0.0 ) );
	}
#endif
#if NUM_SPOT_LIGHTS > 0
	struct SpotLight {
		vec3 position;
		vec3 direction;
		vec3 color;
		float distance;
		float decay;
		float coneCos;
		float penumbraCos;
	};
	uniform SpotLight spotLights[ NUM_SPOT_LIGHTS ];
	void getSpotLightInfo( const in SpotLight spotLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = spotLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float angleCos = dot( light.direction, spotLight.direction );
		float spotAttenuation = getSpotAttenuation( spotLight.coneCos, spotLight.penumbraCos, angleCos );
		if ( spotAttenuation > 0.0 ) {
			float lightDistance = length( lVector );
			light.color = spotLight.color * spotAttenuation;
			light.color *= getDistanceAttenuation( lightDistance, spotLight.distance, spotLight.decay );
			light.visible = ( light.color != vec3( 0.0 ) );
		} else {
			light.color = vec3( 0.0 );
			light.visible = false;
		}
	}
#endif
#if NUM_RECT_AREA_LIGHTS > 0
	struct RectAreaLight {
		vec3 color;
		vec3 position;
		vec3 halfWidth;
		vec3 halfHeight;
	};
	uniform sampler2D ltc_1;	uniform sampler2D ltc_2;
	uniform RectAreaLight rectAreaLights[ NUM_RECT_AREA_LIGHTS ];
#endif
#if NUM_HEMI_LIGHTS > 0
	struct HemisphereLight {
		vec3 direction;
		vec3 skyColor;
		vec3 groundColor;
	};
	uniform HemisphereLight hemisphereLights[ NUM_HEMI_LIGHTS ];
	vec3 getHemisphereLightIrradiance( const in HemisphereLight hemiLight, const in vec3 normal ) {
		float dotNL = dot( normal, hemiLight.direction );
		float hemiDiffuseWeight = 0.5 * dotNL + 0.5;
		vec3 irradiance = mix( hemiLight.groundColor, hemiLight.skyColor, hemiDiffuseWeight );
		return irradiance;
	}
#endif
#include <lightprobes_pars_fragment>`,Ax=`#ifdef USE_ENVMAP
	vec3 getIBLIrradiance( const in vec3 normal ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 worldNormal = transformNormalByInverseViewMatrix( normal, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 );
			return PI * envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 reflectVec = reflect( - viewDir, normal );
			reflectVec = normalize( mix( reflectVec, normal, pow4( roughness ) ) );
			reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );
			return envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	#ifdef USE_RETROREFLECTION
		vec3 getIBLRetroRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
			#ifdef ENVMAP_TYPE_CUBE_UV
				vec3 retroVec = normalize( mix( viewDir, normal, pow4( roughness ) ) );
				retroVec = transformDirectionByInverseViewMatrix( retroVec, viewMatrix );
				vec4 envMapColor = textureCubeUV( envMap, envMapRotation * retroVec, roughness );
				return envMapColor.rgb * envMapIntensity;
			#else
				return vec3( 0.0 );
			#endif
		}
	#endif
	#ifdef USE_ANISOTROPY
		vec3 getIBLAnisotropyRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy ) {
			#ifdef ENVMAP_TYPE_CUBE_UV
				vec3 bentNormal = cross( bitangent, viewDir );
				bentNormal = normalize( cross( bentNormal, bitangent ) );
				bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
				return getIBLRadiance( viewDir, bentNormal, roughness );
			#else
				return vec3( 0.0 );
			#endif
		}
		#ifdef USE_RETROREFLECTION
			vec3 getIBLAnisotropyRetroRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy ) {
				#ifdef ENVMAP_TYPE_CUBE_UV
					vec3 bentNormal = cross( bitangent, viewDir );
					bentNormal = normalize( cross( bentNormal, bitangent ) );
					bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
					return getIBLRetroRadiance( viewDir, bentNormal, roughness );
				#else
					return vec3( 0.0 );
				#endif
			}
		#endif
	#endif
#endif`,Rx=`ToonMaterial material;
material.diffuseColor = diffuseColor.rgb;`,Cx=`varying vec3 vViewPosition;
struct ToonMaterial {
	vec3 diffuseColor;
};
void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Toon
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Toon`,Px=`BlinnPhongMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularColor = specular;
material.specularShininess = shininess;
material.specularStrength = specularStrength;`,Lx=`varying vec3 vViewPosition;
struct BlinnPhongMaterial {
	vec3 diffuseColor;
	vec3 specularColor;
	float specularShininess;
	float specularStrength;
};
void RE_Direct_BlinnPhong( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
	reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularShininess ) * material.specularStrength;
}
void RE_IndirectDiffuse_BlinnPhong( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_BlinnPhong
#define RE_IndirectDiffuse		RE_IndirectDiffuse_BlinnPhong`,Dx=`PhysicalMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.diffuseContribution = diffuseColor.rgb * ( 1.0 - metalnessFactor );
material.metalness = metalnessFactor;
vec3 dxy = max( abs( dFdx( nonPerturbedNormal ) ), abs( dFdy( nonPerturbedNormal ) ) );
float geometryRoughness = max( max( dxy.x, dxy.y ), dxy.z );
material.roughness = max( roughnessFactor, 0.0525 );material.roughness += geometryRoughness;
material.roughness = min( material.roughness, 1.0 );
#ifdef IOR
	material.ior = ior;
	#ifdef USE_SPECULAR
		float specularIntensityFactor = specularIntensity;
		vec3 specularColorFactor = specularColor;
		#ifdef USE_SPECULAR_COLORMAP
			specularColorFactor *= texture2D( specularColorMap, vSpecularColorMapUv ).rgb;
		#endif
		#ifdef USE_SPECULAR_INTENSITYMAP
			specularIntensityFactor *= texture2D( specularIntensityMap, vSpecularIntensityMapUv ).a;
		#endif
		material.specularF90 = mix( specularIntensityFactor, 1.0, metalnessFactor );
	#else
		float specularIntensityFactor = 1.0;
		vec3 specularColorFactor = vec3( 1.0 );
		material.specularF90 = 1.0;
	#endif
	material.specularColor = min( pow2( ( material.ior - 1.0 ) / ( material.ior + 1.0 ) ) * specularColorFactor, vec3( 1.0 ) ) * specularIntensityFactor;
	material.specularColorBlended = mix( material.specularColor, diffuseColor.rgb, metalnessFactor );
#else
	material.specularColor = vec3( 0.04 );
	material.specularColorBlended = mix( material.specularColor, diffuseColor.rgb, metalnessFactor );
	material.specularF90 = 1.0;
#endif
#ifdef USE_CLEARCOAT
	material.clearcoat = clearcoat;
	material.clearcoatRoughness = clearcoatRoughness;
	material.clearcoatF0 = vec3( 0.04 );
	material.clearcoatF90 = 1.0;
	#ifdef USE_CLEARCOATMAP
		material.clearcoat *= texture2D( clearcoatMap, vClearcoatMapUv ).x;
	#endif
	#ifdef USE_CLEARCOAT_ROUGHNESSMAP
		material.clearcoatRoughness *= texture2D( clearcoatRoughnessMap, vClearcoatRoughnessMapUv ).y;
	#endif
	material.clearcoat = saturate( material.clearcoat );	material.clearcoatRoughness = max( material.clearcoatRoughness, 0.0525 );
	material.clearcoatRoughness += geometryRoughness;
	material.clearcoatRoughness = min( material.clearcoatRoughness, 1.0 );
#endif
#ifdef USE_DISPERSION
	material.dispersion = dispersion;
#endif
#ifdef USE_RETROREFLECTION
	material.retroreflectivity = retroreflectivity;
#endif
#ifdef USE_IRIDESCENCE
	material.iridescence = iridescence;
	material.iridescenceIOR = iridescenceIOR;
	#ifdef USE_IRIDESCENCEMAP
		material.iridescence *= texture2D( iridescenceMap, vIridescenceMapUv ).r;
	#endif
	#ifdef USE_IRIDESCENCE_THICKNESSMAP
		material.iridescenceThickness = (iridescenceThicknessMaximum - iridescenceThicknessMinimum) * texture2D( iridescenceThicknessMap, vIridescenceThicknessMapUv ).g + iridescenceThicknessMinimum;
	#else
		material.iridescenceThickness = iridescenceThicknessMaximum;
	#endif
#endif
#ifdef USE_SHEEN
	material.sheenColor = sheenColor;
	#ifdef USE_SHEEN_COLORMAP
		material.sheenColor *= texture2D( sheenColorMap, vSheenColorMapUv ).rgb;
	#endif
	material.sheenRoughness = clamp( sheenRoughness, 0.0001, 1.0 );
	#ifdef USE_SHEEN_ROUGHNESSMAP
		material.sheenRoughness *= texture2D( sheenRoughnessMap, vSheenRoughnessMapUv ).a;
	#endif
#endif
#ifdef USE_ANISOTROPY
	#ifdef USE_ANISOTROPYMAP
		mat2 anisotropyMat = mat2( anisotropyVector.x, anisotropyVector.y, - anisotropyVector.y, anisotropyVector.x );
		vec3 anisotropyPolar = texture2D( anisotropyMap, vAnisotropyMapUv ).rgb;
		vec2 anisotropyV = anisotropyMat * normalize( 2.0 * anisotropyPolar.rg - vec2( 1.0 ) ) * anisotropyPolar.b;
	#else
		vec2 anisotropyV = anisotropyVector;
	#endif
	material.anisotropy = length( anisotropyV );
	if( material.anisotropy == 0.0 ) {
		anisotropyV = vec2( 1.0, 0.0 );
	} else {
		anisotropyV /= material.anisotropy;
		material.anisotropy = saturate( material.anisotropy );
	}
	material.alphaT = mix( pow2( material.roughness ), 1.0, pow2( material.anisotropy ) );
	material.anisotropyT = tbn[ 0 ] * anisotropyV.x + tbn[ 1 ] * anisotropyV.y;
	material.anisotropyB = tbn[ 1 ] * anisotropyV.x - tbn[ 0 ] * anisotropyV.y;
#endif`,Nx=`uniform sampler2D dfgLUT;
struct PhysicalMaterial {
	vec3 diffuseColor;
	vec3 diffuseContribution;
	vec3 specularColor;
	vec3 specularColorBlended;
	float roughness;
	float metalness;
	float specularF90;
	float dispersion;
	vec2 dfg;
	vec3 multiScatteringCompensation;
	#ifdef USE_RETROREFLECTION
		float retroreflectivity;
	#endif
	#ifdef USE_CLEARCOAT
		float clearcoat;
		float clearcoatRoughness;
		vec3 clearcoatF0;
		float clearcoatF90;
	#endif
	#ifdef USE_IRIDESCENCE
		float iridescence;
		float iridescenceIOR;
		float iridescenceThickness;
		vec3 iridescenceFresnel;
		vec3 iridescenceF0Dielectric;
		vec3 iridescenceF0Metallic;
	#endif
	#ifdef USE_SHEEN
		vec3 sheenColor;
		float sheenRoughness;
	#endif
	#ifdef IOR
		float ior;
	#endif
	#ifdef USE_TRANSMISSION
		float transmission;
		float transmissionAlpha;
		float thickness;
		float attenuationDistance;
		vec3 attenuationColor;
	#endif
	#ifdef USE_ANISOTROPY
		float anisotropy;
		float alphaT;
		vec3 anisotropyT;
		vec3 anisotropyB;
	#endif
};
vec3 clearcoatSpecularDirect = vec3( 0.0 );
vec3 clearcoatSpecularIndirect = vec3( 0.0 );
vec3 sheenSpecularDirect = vec3( 0.0 );
vec3 sheenSpecularIndirect = vec3(0.0 );
vec3 Schlick_to_F0( const in vec3 f, const in float f90, const in float dotVH ) {
    float x = clamp( 1.0 - dotVH, 0.0, 1.0 );
    float x2 = x * x;
    float x5 = clamp( x * x2 * x2, 0.0, 0.9999 );
    return ( f - vec3( f90 ) * x5 ) / ( 1.0 - x5 );
}
float V_GGX_SmithCorrelated( const in float alpha, const in float dotNL, const in float dotNV ) {
	float a2 = pow2( alpha );
	float gv = dotNL * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNV ) );
	float gl = dotNV * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNL ) );
	return 0.5 / max( gv + gl, EPSILON );
}
float D_GGX( const in float alpha, const in float dotNH ) {
	float a2 = pow2( alpha );
	float denom = pow2( dotNH ) * ( a2 - 1.0 ) + 1.0;
	return RECIPROCAL_PI * a2 / pow2( denom );
}
#ifdef USE_ANISOTROPY
	float V_GGX_SmithCorrelated_Anisotropic( const in float alphaT, const in float alphaB, const in float dotTV, const in float dotBV, const in float dotTL, const in float dotBL, const in float dotNV, const in float dotNL ) {
		float gv = dotNL * length( vec3( alphaT * dotTV, alphaB * dotBV, dotNV ) );
		float gl = dotNV * length( vec3( alphaT * dotTL, alphaB * dotBL, dotNL ) );
		return 0.5 / max( gv + gl, EPSILON );
	}
	float D_GGX_Anisotropic( const in float alphaT, const in float alphaB, const in float dotNH, const in float dotTH, const in float dotBH ) {
		float a2 = alphaT * alphaB;
		highp vec3 v = vec3( alphaB * dotTH, alphaT * dotBH, a2 * dotNH );
		highp float v2 = dot( v, v );
		float w2 = a2 / v2;
		return RECIPROCAL_PI * a2 * pow2 ( w2 );
	}
#endif
#ifdef USE_CLEARCOAT
	vec3 BRDF_GGX_Clearcoat( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material) {
		vec3 f0 = material.clearcoatF0;
		float f90 = material.clearcoatF90;
		float roughness = material.clearcoatRoughness;
		float alpha = pow2( roughness );
		vec3 halfDir = normalize( lightDir + viewDir );
		float dotNL = saturate( dot( normal, lightDir ) );
		float dotNV = saturate( dot( normal, viewDir ) );
		float dotNH = saturate( dot( normal, halfDir ) );
		float dotVH = saturate( dot( viewDir, halfDir ) );
		vec3 F = F_Schlick( f0, f90, dotVH );
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
		return F * ( V * D );
	}
#endif
vec3 BRDF_GGX( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material ) {
	vec3 f0 = material.specularColorBlended;
	float f90 = material.specularF90;
	float roughness = material.roughness;
	float alpha = pow2( roughness );
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( f0, f90, dotVH );
	#ifdef USE_IRIDESCENCE
		F = mix( F, material.iridescenceFresnel, material.iridescence );
	#endif
	#ifdef USE_ANISOTROPY
		float dotTL = dot( material.anisotropyT, lightDir );
		float dotTV = dot( material.anisotropyT, viewDir );
		float dotTH = dot( material.anisotropyT, halfDir );
		float dotBL = dot( material.anisotropyB, lightDir );
		float dotBV = dot( material.anisotropyB, viewDir );
		float dotBH = dot( material.anisotropyB, halfDir );
		float V = V_GGX_SmithCorrelated_Anisotropic( material.alphaT, alpha, dotTV, dotBV, dotTL, dotBL, dotNV, dotNL );
		float D = D_GGX_Anisotropic( material.alphaT, alpha, dotNH, dotTH, dotBH );
	#else
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
	#endif
	return F * ( V * D );
}
vec2 LTC_Uv( const in vec3 N, const in vec3 V, const in float roughness ) {
	const float LUT_SIZE = 64.0;
	const float LUT_SCALE = ( LUT_SIZE - 1.0 ) / LUT_SIZE;
	const float LUT_BIAS = 0.5 / LUT_SIZE;
	float dotNV = saturate( dot( N, V ) );
	vec2 uv = vec2( roughness, sqrt( 1.0 - dotNV ) );
	uv = uv * LUT_SCALE + LUT_BIAS;
	return uv;
}
float LTC_ClippedSphereFormFactor( const in vec3 f ) {
	float l = length( f );
	return max( ( l * l + f.z ) / ( l + 1.0 ), 0.0 );
}
vec3 LTC_EdgeVectorFormFactor( const in vec3 v1, const in vec3 v2 ) {
	float x = dot( v1, v2 );
	float y = abs( x );
	float a = 0.8543985 + ( 0.4965155 + 0.0145206 * y ) * y;
	float b = 3.4175940 + ( 4.1616724 + y ) * y;
	float v = a / b;
	float theta_sintheta = ( x > 0.0 ) ? v : 0.5 * inversesqrt( max( 1.0 - x * x, 1e-7 ) ) - v;
	return cross( v1, v2 ) * theta_sintheta;
}
vec3 LTC_Evaluate( const in vec3 N, const in vec3 V, const in vec3 P, const in mat3 mInv, const in vec3 rectCoords[ 4 ] ) {
	vec3 v1 = rectCoords[ 1 ] - rectCoords[ 0 ];
	vec3 v2 = rectCoords[ 3 ] - rectCoords[ 0 ];
	vec3 lightNormal = cross( v1, v2 );
	if( dot( lightNormal, P - rectCoords[ 0 ] ) < 0.0 ) return vec3( 0.0 );
	vec3 T1, T2;
	T1 = normalize( V - N * dot( V, N ) );
	T2 = - cross( N, T1 );
	mat3 mat = mInv * transpose( mat3( T1, T2, N ) );
	vec3 coords[ 4 ];
	coords[ 0 ] = mat * ( rectCoords[ 0 ] - P );
	coords[ 1 ] = mat * ( rectCoords[ 1 ] - P );
	coords[ 2 ] = mat * ( rectCoords[ 2 ] - P );
	coords[ 3 ] = mat * ( rectCoords[ 3 ] - P );
	coords[ 0 ] = normalize( coords[ 0 ] );
	coords[ 1 ] = normalize( coords[ 1 ] );
	coords[ 2 ] = normalize( coords[ 2 ] );
	coords[ 3 ] = normalize( coords[ 3 ] );
	vec3 vectorFormFactor = vec3( 0.0 );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 0 ], coords[ 1 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 1 ], coords[ 2 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 2 ], coords[ 3 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 3 ], coords[ 0 ] );
	float result = LTC_ClippedSphereFormFactor( vectorFormFactor );
	return vec3( result );
}
#if defined( USE_SHEEN )
float D_Charlie( float roughness, float dotNH ) {
	float alpha = pow2( roughness );
	float invAlpha = 1.0 / alpha;
	float cos2h = dotNH * dotNH;
	float sin2h = max( 1.0 - cos2h, 0.0078125 );
	return ( 2.0 + invAlpha ) * pow( sin2h, invAlpha * 0.5 ) / ( 2.0 * PI );
}
float V_Neubelt( float dotNV, float dotNL ) {
	return saturate( 1.0 / ( 4.0 * ( dotNL + dotNV - dotNL * dotNV ) ) );
}
vec3 BRDF_Sheen( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, vec3 sheenColor, const in float sheenRoughness ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float D = D_Charlie( sheenRoughness, dotNH );
	float V = V_Neubelt( dotNV, dotNL );
	return sheenColor * ( D * V );
}
#endif
float IBLSheenBRDF( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	float r2 = roughness * roughness;
	float rInv = 1.0 / ( roughness + 0.1 );
	float a = -1.9362 + 1.0678 * roughness + 0.4573 * r2 - 0.8469 * rInv;
	float b = -0.6014 + 0.5538 * roughness - 0.4670 * r2 - 0.1255 * rInv;
	float DG = exp( a * dotNV + b );
	return saturate( DG );
}
vec3 EnvironmentBRDF( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	vec2 fab = texture2D( dfgLUT, vec2( roughness, dotNV ) ).rg;
	return specularColor * fab.x + specularF90 * fab.y;
}
#ifdef USE_IRIDESCENCE
void computeMultiscatteringIridescence( const in vec2 fab, const in vec3 specularColor, const in float specularF90, const in float iridescence, const in vec3 iridescenceF0, inout vec3 singleScatter, inout vec3 multiScatter ) {
#else
void computeMultiscattering( const in vec2 fab, const in vec3 specularColor, const in float specularF90, inout vec3 singleScatter, inout vec3 multiScatter ) {
#endif
	#ifdef USE_IRIDESCENCE
		vec3 Fr = mix( specularColor, iridescenceF0, iridescence );
	#else
		vec3 Fr = specularColor;
	#endif
	vec3 FssEss = Fr * fab.x + specularF90 * fab.y;
	float Ess = fab.x + fab.y;
	float Ems = 1.0 - Ess;
	vec3 Favg = Fr + ( 1.0 - Fr ) * 0.047619;	vec3 Fms = FssEss * Favg / ( 1.0 - Ems * Favg );
	singleScatter += FssEss;
	multiScatter += Fms * Ems;
}
#if NUM_RECT_AREA_LIGHTS > 0
	void RE_Direct_RectArea_Physical( const in RectAreaLight rectAreaLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
		vec3 normal = geometryNormal;
		vec3 viewDir = geometryViewDir;
		vec3 position = geometryPosition;
		vec3 lightPos = rectAreaLight.position;
		vec3 halfWidth = rectAreaLight.halfWidth;
		vec3 halfHeight = rectAreaLight.halfHeight;
		vec3 lightColor = rectAreaLight.color;
		float roughness = material.roughness;
		vec3 rectCoords[ 4 ];
		rectCoords[ 0 ] = lightPos + halfWidth - halfHeight;		rectCoords[ 1 ] = lightPos - halfWidth - halfHeight;
		rectCoords[ 2 ] = lightPos - halfWidth + halfHeight;
		rectCoords[ 3 ] = lightPos + halfWidth + halfHeight;
		vec2 uv = LTC_Uv( normal, viewDir, roughness );
		vec4 t1 = texture2D( ltc_1, uv );
		vec4 t2 = texture2D( ltc_2, uv );
		mat3 mInv = mat3(
			vec3( t1.x, 0, t1.y ),
			vec3(    0, 1,    0 ),
			vec3( t1.z, 0, t1.w )
		);
		vec3 fresnel = ( material.specularColorBlended * t2.x + ( material.specularF90 - material.specularColorBlended ) * t2.y );
		reflectedLight.directSpecular += lightColor * fresnel * LTC_Evaluate( normal, viewDir, position, mInv, rectCoords );
		reflectedLight.directDiffuse += lightColor * material.diffuseContribution * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );
		#ifdef USE_CLEARCOAT
			vec3 Ncc = geometryClearcoatNormal;
			vec2 uvClearcoat = LTC_Uv( Ncc, viewDir, material.clearcoatRoughness );
			vec4 t1Clearcoat = texture2D( ltc_1, uvClearcoat );
			vec4 t2Clearcoat = texture2D( ltc_2, uvClearcoat );
			mat3 mInvClearcoat = mat3(
				vec3( t1Clearcoat.x, 0, t1Clearcoat.y ),
				vec3(             0, 1,             0 ),
				vec3( t1Clearcoat.z, 0, t1Clearcoat.w )
			);
			vec3 fresnelClearcoat = material.clearcoatF0 * t2Clearcoat.x + ( material.clearcoatF90 - material.clearcoatF0 ) * t2Clearcoat.y;
			clearcoatSpecularDirect += lightColor * fresnelClearcoat * LTC_Evaluate( Ncc, viewDir, position, mInvClearcoat, rectCoords );
		#endif
	}
#endif
void RE_Direct_Physical( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	#ifdef USE_CLEARCOAT
		float dotNLcc = saturate( dot( geometryClearcoatNormal, directLight.direction ) );
		vec3 ccIrradiance = dotNLcc * directLight.color;
		clearcoatSpecularDirect += ccIrradiance * BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, material );
	#endif
	#ifdef USE_SHEEN
 
 		sheenSpecularDirect += irradiance * BRDF_Sheen( directLight.direction, geometryViewDir, geometryNormal, material.sheenColor, material.sheenRoughness );
 
 		float sheenAlbedoV = IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
 		float sheenAlbedoL = IBLSheenBRDF( geometryNormal, directLight.direction, material.sheenRoughness );
 
 		float sheenEnergyComp = 1.0 - max3( material.sheenColor ) * max( sheenAlbedoV, sheenAlbedoL );
 
 		irradiance *= sheenEnergyComp;
 
 	#endif
	vec3 specularBRDF = BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );
	#ifdef USE_RETROREFLECTION
		vec3 retroViewDir = reflect( - geometryViewDir, geometryNormal );
		vec3 retroSpecularBRDF = BRDF_GGX( directLight.direction, retroViewDir, geometryNormal, material );
		specularBRDF = mix( specularBRDF, retroSpecularBRDF, saturate( material.retroreflectivity ) );
	#endif
	reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;
	vec3 halfDir = normalize( directLight.direction + geometryViewDir );
	float dotVH = saturate( dot( geometryViewDir, halfDir ) );
	vec3 F = F_Schlick( material.specularColor, material.specularF90, dotVH );
	#ifdef USE_RETROREFLECTION
		vec3 retroHalfDir = normalize( directLight.direction + retroViewDir );
		float dotRetroVH = saturate( dot( retroViewDir, retroHalfDir ) );
		vec3 retroF = F_Schlick( material.specularColor, material.specularF90, dotRetroVH );
		F = mix( F, retroF, saturate( material.retroreflectivity ) );
	#endif
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
}
void RE_IndirectDiffuse_Physical( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	vec3 singleScattering = vec3( 0.0 );
	vec3 multiScattering = vec3( 0.0 );
	#ifdef USE_IRIDESCENCE
		computeMultiscatteringIridescence( material.dfg, material.specularColor, material.specularF90, material.iridescence, material.iridescenceF0Dielectric, singleScattering, multiScattering );
	#else
		computeMultiscattering( material.dfg, material.specularColor, material.specularF90, singleScattering, multiScattering );
	#endif
	vec3 diffuse = irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - singleScattering - multiScattering );
	#ifdef USE_SHEEN
		float sheenAlbedo = IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
		sheenSpecularIndirect += irradiance * material.sheenColor * sheenAlbedo * RECIPROCAL_PI;
		float sheenEnergyComp = 1.0 - max3( material.sheenColor ) * sheenAlbedo;
		diffuse *= sheenEnergyComp;
	#endif
	reflectedLight.indirectDiffuse += diffuse;
}
void RE_IndirectSpecular_Physical( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
	#ifdef USE_CLEARCOAT
		clearcoatSpecularIndirect += clearcoatRadiance * EnvironmentBRDF( geometryClearcoatNormal, geometryViewDir, material.clearcoatF0, material.clearcoatF90, material.clearcoatRoughness );
	#endif
	#ifdef USE_SHEEN
		sheenSpecularIndirect += irradiance * material.sheenColor * IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness ) * RECIPROCAL_PI;
 	#endif
	vec3 singleScatteringDielectric = vec3( 0.0 );
	vec3 multiScatteringDielectric = vec3( 0.0 );
	vec3 singleScatteringMetallic = vec3( 0.0 );
	vec3 multiScatteringMetallic = vec3( 0.0 );
	#ifdef USE_IRIDESCENCE
		computeMultiscatteringIridescence( material.dfg, material.specularColor, material.specularF90, material.iridescence, material.iridescenceF0Dielectric, singleScatteringDielectric, multiScatteringDielectric );
		computeMultiscatteringIridescence( material.dfg, material.diffuseColor, material.specularF90, material.iridescence, material.iridescenceF0Metallic, singleScatteringMetallic, multiScatteringMetallic );
	#else
		computeMultiscattering( material.dfg, material.specularColor, material.specularF90, singleScatteringDielectric, multiScatteringDielectric );
		computeMultiscattering( material.dfg, material.diffuseColor, material.specularF90, singleScatteringMetallic, multiScatteringMetallic );
	#endif
	vec3 singleScattering = mix( singleScatteringDielectric, singleScatteringMetallic, material.metalness );
	vec3 multiScattering = mix( multiScatteringDielectric, multiScatteringMetallic, material.metalness );
	vec3 totalScatteringDielectric = singleScatteringDielectric + multiScatteringDielectric;
	vec3 diffuse = material.diffuseContribution * ( 1.0 - totalScatteringDielectric );
	vec3 cosineWeightedIrradiance = irradiance * RECIPROCAL_PI;
	vec3 indirectSpecular = radiance * singleScattering;
	indirectSpecular += multiScattering * cosineWeightedIrradiance;
	vec3 indirectDiffuse = diffuse * cosineWeightedIrradiance;
	#ifdef USE_SHEEN
		float sheenAlbedo = IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
		float sheenEnergyComp = 1.0 - max3( material.sheenColor ) * sheenAlbedo;
		indirectSpecular *= sheenEnergyComp;
		indirectDiffuse *= sheenEnergyComp;
	#endif
	reflectedLight.indirectSpecular += indirectSpecular;
	reflectedLight.indirectDiffuse += indirectDiffuse;
}
#define RE_Direct				RE_Direct_Physical
#define RE_Direct_RectArea		RE_Direct_RectArea_Physical
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Physical
#define RE_IndirectSpecular		RE_IndirectSpecular_Physical
float computeSpecularOcclusion( const in float dotNV, const in float ambientOcclusion, const in float roughness ) {
	return saturate( pow( dotNV + ambientOcclusion, exp2( - 16.0 * roughness - 1.0 ) ) - 1.0 + ambientOcclusion );
}`,Ix=`
vec3 geometryPosition = - vViewPosition;
vec3 geometryNormal = normal;
vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );
vec3 geometryClearcoatNormal = vec3( 0.0 );
#ifdef USE_CLEARCOAT
	geometryClearcoatNormal = clearcoatNormal;
#endif
#ifdef USE_IRIDESCENCE
	float dotNVi = saturate( dot( normal, geometryViewDir ) );
	if ( material.iridescenceThickness == 0.0 ) {
		material.iridescence = 0.0;
	} else {
		material.iridescence = saturate( material.iridescence );
	}
	if ( material.iridescence > 0.0 ) {
		vec3 iridescenceFresnelDielectric = evalIridescence( 1.0, material.iridescenceIOR, dotNVi, material.iridescenceThickness, material.specularColor );
		vec3 iridescenceFresnelMetallic = evalIridescence( 1.0, material.iridescenceIOR, dotNVi, material.iridescenceThickness, material.diffuseColor );
		material.iridescenceFresnel = mix( iridescenceFresnelDielectric, iridescenceFresnelMetallic, material.metalness );
		material.iridescenceF0Dielectric = Schlick_to_F0( iridescenceFresnelDielectric, 1.0, dotNVi );
		material.iridescenceF0Metallic = Schlick_to_F0( iridescenceFresnelMetallic, 1.0, dotNVi );
	}
#endif
#ifdef STANDARD
	float dotNVms = saturate( dot( geometryNormal, geometryViewDir ) );
	material.dfg = texture2D( dfgLUT, vec2( material.roughness, dotNVms ) ).rg;
	#if ( NUM_SUN_LIGHTS > 0 || NUM_DIR_LIGHTS > 0 || NUM_POINT_LIGHTS > 0 || NUM_SPOT_LIGHTS > 0 )
		float EssMs = material.dfg.x + material.dfg.y;
		material.multiScatteringCompensation = 1.0 + material.specularColorBlended * ( 1.0 / EssMs - 1.0 );
	#endif
#endif
IncidentLight directLight;
#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )
	PointLight pointLight;
	#if defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
		pointLight = pointLights[ i ];
		getPointLightInfo( pointLight, geometryPosition, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS ) && ( defined( SHADOWMAP_TYPE_PCF ) || defined( SHADOWMAP_TYPE_BASIC ) )
		pointLightShadow = pointLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowIntensity, pointLightShadow.shadowBias, pointLightShadow.shadowRadius, vPointShadowCoord[ i ], pointLightShadow.shadowCameraNear, pointLightShadow.shadowCameraFar ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )
	SpotLight spotLight;
	vec4 spotColor;
	vec3 spotLightCoord;
	bool inSpotLightMap;
	#if defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
		spotLight = spotLights[ i ];
		getSpotLightInfo( spotLight, geometryPosition, directLight );
		#if ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#define SPOT_LIGHT_MAP_INDEX UNROLLED_LOOP_INDEX
		#elif ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		#define SPOT_LIGHT_MAP_INDEX NUM_SPOT_LIGHT_MAPS
		#else
		#define SPOT_LIGHT_MAP_INDEX ( UNROLLED_LOOP_INDEX - NUM_SPOT_LIGHT_SHADOWS + NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#endif
		#if ( SPOT_LIGHT_MAP_INDEX < NUM_SPOT_LIGHT_MAPS )
			spotLightCoord = vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w;
			inSpotLightMap = all( lessThan( abs( spotLightCoord * 2. - 1. ), vec3( 1.0 ) ) );
			spotColor = texture2D( spotLightMap[ SPOT_LIGHT_MAP_INDEX ], spotLightCoord.xy );
			directLight.color = inSpotLightMap ? directLight.color * spotColor.rgb : directLight.color;
		#endif
		#undef SPOT_LIGHT_MAP_INDEX
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		spotLightShadow = spotLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_SUN_LIGHTS > 0 ) && defined( RE_Direct )
	SunLight sunLight;
	#if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
	SunLightShadow sunLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SUN_LIGHTS; i ++ ) {
		sunLight = sunLights[ i ];
		getSunLightInfo( sunLight, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SUN_LIGHT_SHADOWS )
		sunLightShadow = sunLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getSunShadow( sunShadowMap[ i ], sunLightShadow, UNROLLED_LOOP_INDEX ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )
	RectAreaLight rectAreaLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_RECT_AREA_LIGHTS; i ++ ) {
		rectAreaLight = rectAreaLights[ i ];
		RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if defined( RE_IndirectDiffuse )
	vec3 iblIrradiance = vec3( 0.0 );
	vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );
	#if defined( USE_LIGHT_PROBES )
		irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );
	#endif
	#if ( NUM_HEMI_LIGHTS > 0 )
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
			irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );
		}
		#pragma unroll_loop_end
	#endif
	#ifdef USE_LIGHT_PROBES_GRID
		vec3 probeWorldPos = ( ( vec4( geometryPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
		vec3 probeWorldNormal = transformNormalByInverseViewMatrix( geometryNormal, viewMatrix );
		irradiance += getLightProbeGridIrradiance( probeWorldPos, probeWorldNormal );
	#endif
#endif
#if defined( RE_IndirectSpecular )
	vec3 radiance = vec3( 0.0 );
	vec3 clearcoatRadiance = vec3( 0.0 );
#endif`,Ux=`#if defined( RE_IndirectDiffuse )
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;
		irradiance += lightMapIrradiance;
	#endif
	#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
		#if defined( STANDARD ) || defined( LAMBERT ) || defined( PHONG )
			iblIrradiance += getIBLIrradiance( geometryNormal );
		#endif
	#endif
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
	#ifdef USE_ANISOTROPY
		vec3 iblRadiance = getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );
	#else
		vec3 iblRadiance = getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
	#endif
	#ifdef USE_RETROREFLECTION
		#ifdef USE_ANISOTROPY
			vec3 retroIBLRadiance = getIBLAnisotropyRetroRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );
		#else
			vec3 retroIBLRadiance = getIBLRetroRadiance( geometryViewDir, geometryNormal, material.roughness );
		#endif
		iblRadiance = mix( iblRadiance, retroIBLRadiance, saturate( material.retroreflectivity ) );
	#endif
	radiance += iblRadiance;
	#ifdef USE_CLEARCOAT
		clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );
	#endif
#endif`,Fx=`#if defined( RE_IndirectDiffuse )
	#if defined( LAMBERT ) || defined( PHONG )
		irradiance += iblIrradiance;
	#endif
	RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif
#if defined( RE_IndirectSpecular )
	RE_IndirectSpecular( radiance, iblIrradiance, clearcoatRadiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif`,Bx=`#ifdef USE_LIGHT_PROBES_GRID
uniform highp sampler3D probesSH;
uniform vec3 probesMin;
uniform vec3 probesMax;
uniform vec3 probesResolution;
vec3 getLightProbeGridIrradiance( vec3 worldPos, vec3 worldNormal ) {
	vec3 res = probesResolution;
	vec3 gridRange = probesMax - probesMin;
	vec3 resMinusOne = res - 1.0;
	vec3 probeSpacing = gridRange / resMinusOne;
	vec3 samplePos = worldPos + worldNormal * probeSpacing * 0.5;
	vec3 uvw = clamp( ( samplePos - probesMin ) / gridRange, 0.0, 1.0 );
	uvw = uvw * resMinusOne / res + 0.5 / res;
	float nz          = res.z;
	float paddedSlices = nz + 2.0;
	float atlasDepth  = 7.0 * paddedSlices;
	float uvZBase     = uvw.z * nz + 1.0;
	vec4 s0 = texture( probesSH, vec3( uvw.xy, ( uvZBase                       ) / atlasDepth ) );
	vec4 s1 = texture( probesSH, vec3( uvw.xy, ( uvZBase +       paddedSlices   ) / atlasDepth ) );
	vec4 s2 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 2.0 * paddedSlices   ) / atlasDepth ) );
	vec4 s3 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 3.0 * paddedSlices   ) / atlasDepth ) );
	vec4 s4 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 4.0 * paddedSlices   ) / atlasDepth ) );
	vec4 s5 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 5.0 * paddedSlices   ) / atlasDepth ) );
	vec4 s6 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 6.0 * paddedSlices   ) / atlasDepth ) );
	vec3 c0 = s0.xyz;
	vec3 c1 = vec3( s0.w, s1.xy );
	vec3 c2 = vec3( s1.zw, s2.x );
	vec3 c3 = s2.yzw;
	vec3 c4 = s3.xyz;
	vec3 c5 = vec3( s3.w, s4.xy );
	vec3 c6 = vec3( s4.zw, s5.x );
	vec3 c7 = s5.yzw;
	vec3 c8 = s6.xyz;
	float x = worldNormal.x, y = worldNormal.y, z = worldNormal.z;
	vec3 result = c0 * 0.886227;
	result += c1 * 2.0 * 0.511664 * y;
	result += c2 * 2.0 * 0.511664 * z;
	result += c3 * 2.0 * 0.511664 * x;
	result += c4 * 2.0 * 0.429043 * x * y;
	result += c5 * 2.0 * 0.429043 * y * z;
	result += c6 * ( 0.743125 * z * z - 0.247708 );
	result += c7 * 2.0 * 0.429043 * x * z;
	result += c8 * 0.429043 * ( x * x - y * y );
	return max( result, vec3( 0.0 ) );
}
#endif`,Ox=`#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
	gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
#endif`,kx=`#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
	uniform float logDepthBufFC;
	varying float vFragDepth;
	varying float vIsPerspective;
#endif`,zx=`#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
	varying float vFragDepth;
	varying float vIsPerspective;
#endif`,Vx=`#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
	vFragDepth = 1.0 + gl_Position.w;
	vIsPerspective = float( isPerspectiveMatrix( projectionMatrix ) );
#endif`,Hx=`#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	#ifdef DECODE_VIDEO_TEXTURE
		sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
	#endif
	diffuseColor *= sampledDiffuseColor;
#endif`,Gx=`#ifdef USE_MAP
	uniform sampler2D map;
#endif`,Wx=`#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
	#if defined( USE_POINTS_UV )
		vec2 uv = vUv;
	#else
		vec2 uv = ( uvTransform * vec3( gl_PointCoord.x, 1.0 - gl_PointCoord.y, 1 ) ).xy;
	#endif
#endif
#ifdef USE_MAP
	diffuseColor *= texture2D( map, uv );
#endif
#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, uv ).g;
#endif`,$x=`#if defined( USE_POINTS_UV )
	varying vec2 vUv;
#else
	#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
		uniform mat3 uvTransform;
	#endif
#endif
#ifdef USE_MAP
	uniform sampler2D map;
#endif
#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,Xx=`float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
	vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
	metalnessFactor *= texelMetalness.b;
#endif`,qx=`#ifdef USE_METALNESSMAP
	uniform sampler2D metalnessMap;
#endif`,Yx=`#ifdef USE_INSTANCING_MORPH
	float morphTargetInfluences[ MORPHTARGETS_COUNT ];
	float morphTargetBaseInfluence = texelFetch( morphTexture, ivec2( 0, gl_InstanceID ), 0 ).r;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		morphTargetInfluences[i] =  texelFetch( morphTexture, ivec2( i + 1, gl_InstanceID ), 0 ).r;
	}
#endif`,Kx=`#if defined( USE_MORPHCOLORS )
	vColor *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		#if defined( USE_COLOR_ALPHA )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ) * morphTargetInfluences[ i ];
		#elif defined( USE_COLOR )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ).rgb * morphTargetInfluences[ i ];
		#endif
	}
#endif`,Zx=`#ifdef USE_MORPHNORMALS
	objectNormal *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		if ( morphTargetInfluences[ i ] != 0.0 ) objectNormal += getMorph( gl_VertexID, i, 1 ).xyz * morphTargetInfluences[ i ];
	}
#endif`,Jx=`#ifdef USE_MORPHTARGETS
	#ifndef USE_INSTANCING_MORPH
		uniform float morphTargetBaseInfluence;
		uniform float morphTargetInfluences[ MORPHTARGETS_COUNT ];
	#endif
	uniform sampler2DArray morphTargetsTexture;
	uniform ivec2 morphTargetsTextureSize;
	vec4 getMorph( const in int vertexIndex, const in int morphTargetIndex, const in int offset ) {
		int texelIndex = vertexIndex * MORPHTARGETS_TEXTURE_STRIDE + offset;
		int y = texelIndex / morphTargetsTextureSize.x;
		int x = texelIndex - y * morphTargetsTextureSize.x;
		ivec3 morphUV = ivec3( x, y, morphTargetIndex );
		return texelFetch( morphTargetsTexture, morphUV, 0 );
	}
#endif`,Qx=`#ifdef USE_MORPHTARGETS
	transformed *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		if ( morphTargetInfluences[ i ] != 0.0 ) transformed += getMorph( gl_VertexID, i, 0 ).xyz * morphTargetInfluences[ i ];
	}
#endif`,jx=`float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
#ifdef FLAT_SHADED
	vec3 fdx = dFdx( vViewPosition );
	vec3 fdy = dFdy( vViewPosition );
	vec3 normal = normalize( cross( fdx, fdy ) );
#else
	vec3 normal = normalize( vNormal );
	#ifdef DOUBLE_SIDED
		normal *= faceDirection;
	#endif
#endif
#if defined( USE_NORMALMAP_TANGENTSPACE ) || defined( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY )
	#ifdef USE_TANGENT
		mat3 tbn = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn = getTangentFrame( - vViewPosition, normal,
		#if defined( USE_NORMALMAP )
			vNormalMapUv
		#elif defined( USE_CLEARCOAT_NORMALMAP )
			vClearcoatNormalMapUv
		#else
			vUv
		#endif
		);
	#endif
	#ifdef DOUBLE_SIDED
		tbn[0] *= faceDirection;
		tbn[1] *= faceDirection;
	#endif
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	#ifdef USE_TANGENT
		mat3 tbn2 = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn2 = getTangentFrame( - vViewPosition, normal, vClearcoatNormalMapUv );
	#endif
	#ifdef DOUBLE_SIDED
		tbn2[0] *= faceDirection;
		tbn2[1] *= faceDirection;
	#endif
#endif
vec3 nonPerturbedNormal = normal;`,ey=`#ifdef USE_NORMALMAP_OBJECTSPACE
	normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#ifdef FLIP_SIDED
		normal = - normal;
	#endif
	#ifdef DOUBLE_SIDED
		normal = normal * faceDirection;
	#endif
	normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
	vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#if defined( USE_PACKED_NORMALMAP )
		mapN = vec3( mapN.xy, sqrt( saturate( 1.0 - dot( mapN.xy, mapN.xy ) ) ) );
	#endif
	mapN.xy *= normalScale;
	normal = normalize( tbn * mapN );
#elif defined( USE_BUMPMAP )
	normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif`,ty=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,ny=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,iy=`#ifndef FLAT_SHADED
	vNormal = normalize( transformedNormal );
	#ifdef USE_TANGENT
		vTangent = normalize( transformedTangent );
		vBitangent = normalize( cross( vNormal, vTangent ) * tangent.w );
		#ifdef FLIP_SIDED
			vBitangent = - vBitangent;
		#endif
	#endif
#endif`,ry=`#ifdef USE_NORMALMAP
	uniform sampler2D normalMap;
	uniform vec2 normalScale;
#endif
#ifdef USE_NORMALMAP_OBJECTSPACE
	uniform mat3 normalMatrix;
#endif
#if ! defined ( USE_TANGENT ) && ( defined ( USE_NORMALMAP_TANGENTSPACE ) || defined ( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY ) )
	mat3 getTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
		vec3 q0 = dFdx( eye_pos.xyz );
		vec3 q1 = dFdy( eye_pos.xyz );
		vec2 st0 = dFdx( uv.st );
		vec2 st1 = dFdy( uv.st );
		vec3 N = surf_norm;
		vec3 q1perp = cross( q1, N );
		vec3 q0perp = cross( N, q0 );
		vec3 T = q1perp * st0.x + q0perp * st1.x;
		vec3 B = q1perp * st0.y + q0perp * st1.y;
		float det = max( dot( T, T ), dot( B, B ) );
		float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
		return mat3( T * scale, B * scale, N );
	}
#endif`,sy=`#ifdef USE_CLEARCOAT
	vec3 clearcoatNormal = nonPerturbedNormal;
#endif`,ay=`#ifdef USE_CLEARCOAT_NORMALMAP
	vec3 clearcoatMapN = texture2D( clearcoatNormalMap, vClearcoatNormalMapUv ).xyz * 2.0 - 1.0;
	clearcoatMapN.xy *= clearcoatNormalScale;
	clearcoatNormal = normalize( tbn2 * clearcoatMapN );
#endif`,oy=`#ifdef USE_CLEARCOATMAP
	uniform sampler2D clearcoatMap;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform sampler2D clearcoatNormalMap;
	uniform vec2 clearcoatNormalScale;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform sampler2D clearcoatRoughnessMap;
#endif`,ly=`#ifdef USE_IRIDESCENCEMAP
	uniform sampler2D iridescenceMap;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform sampler2D iridescenceThicknessMap;
#endif`,cy=`#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
#ifdef USE_TRANSMISSION
diffuseColor.a *= material.transmissionAlpha;
#endif
gl_FragColor = vec4( outgoingLight, diffuseColor.a );`,uy=`vec3 packNormalToRGB( const in vec3 normal ) {
	return normalize( normal ) * 0.5 + 0.5;
}
vec3 unpackRGBToNormal( const in vec3 rgb ) {
	return 2.0 * rgb.xyz - 1.0;
}
const float PackUpscale = 256. / 255.;const float UnpackDownscale = 255. / 256.;const float ShiftRight8 = 1. / 256.;
const float Inv255 = 1. / 255.;
const vec4 PackFactors = vec4( 1.0, 256.0, 256.0 * 256.0, 256.0 * 256.0 * 256.0 );
const vec2 UnpackFactors2 = vec2( UnpackDownscale, 1.0 / PackFactors.g );
const vec3 UnpackFactors3 = vec3( UnpackDownscale / PackFactors.rg, 1.0 / PackFactors.b );
const vec4 UnpackFactors4 = vec4( UnpackDownscale / PackFactors.rgb, 1.0 / PackFactors.a );
vec4 packDepthToRGBA( const in float v ) {
	if( v <= 0.0 )
		return vec4( 0., 0., 0., 0. );
	if( v >= 1.0 )
		return vec4( 1., 1., 1., 1. );
	float vuf;
	float af = modf( v * PackFactors.a, vuf );
	float bf = modf( vuf * ShiftRight8, vuf );
	float gf = modf( vuf * ShiftRight8, vuf );
	return vec4( vuf * Inv255, gf * PackUpscale, bf * PackUpscale, af );
}
vec3 packDepthToRGB( const in float v ) {
	if( v <= 0.0 )
		return vec3( 0., 0., 0. );
	if( v >= 1.0 )
		return vec3( 1., 1., 1. );
	float vuf;
	float bf = modf( v * PackFactors.b, vuf );
	float gf = modf( vuf * ShiftRight8, vuf );
	return vec3( vuf * Inv255, gf * PackUpscale, bf );
}
vec2 packDepthToRG( const in float v ) {
	if( v <= 0.0 )
		return vec2( 0., 0. );
	if( v >= 1.0 )
		return vec2( 1., 1. );
	float vuf;
	float gf = modf( v * 256., vuf );
	return vec2( vuf * Inv255, gf );
}
float unpackRGBAToDepth( const in vec4 v ) {
	return dot( v, UnpackFactors4 );
}
float unpackRGBToDepth( const in vec3 v ) {
	return dot( v, UnpackFactors3 );
}
float unpackRGToDepth( const in vec2 v ) {
	return v.r * UnpackFactors2.r + v.g * UnpackFactors2.g;
}
vec4 pack2HalfToRGBA( const in vec2 v ) {
	vec4 r = vec4( v.x, fract( v.x * 255.0 ), v.y, fract( v.y * 255.0 ) );
	return vec4( r.x - r.y / 255.0, r.y, r.z - r.w / 255.0, r.w );
}
vec2 unpackRGBATo2Half( const in vec4 v ) {
	return vec2( v.x + ( v.y / 255.0 ), v.z + ( v.w / 255.0 ) );
}
float viewZToOrthographicDepth( const in float viewZ, const in float near, const in float far ) {
	return ( viewZ + near ) / ( near - far );
}
float orthographicDepthToViewZ( const in float depth, const in float near, const in float far ) {
	#ifdef USE_REVERSED_DEPTH_BUFFER
	
		return depth * ( far - near ) - far;
	#else
		return depth * ( near - far ) - near;
	#endif
}
float viewZToPerspectiveDepth( const in float viewZ, const in float near, const in float far ) {
	return ( ( near + viewZ ) * far ) / ( ( far - near ) * viewZ );
}
float perspectiveDepthToViewZ( const in float depth, const in float near, const in float far ) {
	
	#ifdef USE_REVERSED_DEPTH_BUFFER
		return ( near * far ) / ( ( near - far ) * depth - near );
	#else
		return ( near * far ) / ( ( far - near ) * depth - far );
	#endif
}`,fy=`#ifdef PREMULTIPLIED_ALPHA
	gl_FragColor.rgb *= gl_FragColor.a;
#endif`,dy=`vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,hy=`#ifdef DITHERING
	gl_FragColor.rgb = dithering( gl_FragColor.rgb );
#endif`,py=`#ifdef DITHERING
	vec3 dithering( vec3 color ) {
		float grid_position = rand( gl_FragCoord.xy );
		vec3 dither_shift_RGB = vec3( 0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0 );
		dither_shift_RGB = mix( 2.0 * dither_shift_RGB, -2.0 * dither_shift_RGB, grid_position );
		return color + dither_shift_RGB;
	}
#endif`,my=`float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
	vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
	roughnessFactor *= texelRoughness.g;
#endif`,gy=`#ifdef USE_ROUGHNESSMAP
	uniform sampler2D roughnessMap;
#endif`,_y=`#if NUM_SPOT_LIGHT_COORDS > 0
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#if NUM_SPOT_LIGHT_MAPS > 0
	uniform sampler2D spotLightMap[ NUM_SPOT_LIGHT_MAPS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_SUN_LIGHT_SHADOWS > 0
		#define SUN_LIGHT_CASCADES 2
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform sampler2DShadow sunShadowMap[ NUM_SUN_LIGHT_SHADOWS ];
		#else
			uniform sampler2D sunShadowMap[ NUM_SUN_LIGHT_SHADOWS ];
		#endif
		uniform mat4 sunShadowMatrix[ NUM_SUN_LIGHT_SHADOWS * SUN_LIGHT_CASCADES ];
		uniform vec4 sunShadowCascade[ NUM_SUN_LIGHT_SHADOWS * SUN_LIGHT_CASCADES ];
		varying vec4 vSunShadowWorldPosition;
		varying vec3 vSunShadowWorldNormal;
		struct SunLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SunLightShadow sunLightShadows[ NUM_SUN_LIGHT_SHADOWS ];
	#endif
	#if NUM_DIR_LIGHT_SHADOWS > 0
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform sampler2DShadow directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		#else
			uniform sampler2D directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		#endif
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform sampler2DShadow spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];
		#else
			uniform sampler2D spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];
		#endif
		struct SpotLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform samplerCubeShadow pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		#elif defined( SHADOWMAP_TYPE_BASIC )
			uniform samplerCube pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		#endif
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
	#if defined( SHADOWMAP_TYPE_PCF )
		float interleavedGradientNoise( vec2 position ) {
			return fract( 52.9829189 * fract( dot( position, vec2( 0.06711056, 0.00583715 ) ) ) );
		}
		vec2 vogelDiskSample( int sampleIndex, int samplesCount, float phi ) {
			const float goldenAngle = 2.399963229728653;
			float r = sqrt( ( float( sampleIndex ) + 0.5 ) / float( samplesCount ) );
			float theta = float( sampleIndex ) * goldenAngle + phi;
			return vec2( cos( theta ), sin( theta ) ) * r;
		}
	#endif
	#if defined( SHADOWMAP_TYPE_PCF )
		float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			shadowCoord.z += shadowBias;
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
			if ( frustumTest ) {
				vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
				float radius = shadowRadius * texelSize.x;
				float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
				shadow = (
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 0, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 1, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 2, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 3, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 4, 5, phi ) * radius, shadowCoord.z ) )
				) * 0.2;
			}
			return mix( 1.0, shadow, shadowIntensity );
		}
	#elif defined( SHADOWMAP_TYPE_VSM )
		float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			#ifdef USE_REVERSED_DEPTH_BUFFER
				shadowCoord.z -= shadowBias;
			#else
				shadowCoord.z += shadowBias;
			#endif
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
			if ( frustumTest ) {
				vec2 distribution = texture2D( shadowMap, shadowCoord.xy ).rg;
				float mean = distribution.x;
				float variance = distribution.y * distribution.y;
				#ifdef USE_REVERSED_DEPTH_BUFFER
					float hard_shadow = step( mean, shadowCoord.z );
				#else
					float hard_shadow = step( shadowCoord.z, mean );
				#endif
				
				if ( hard_shadow == 1.0 ) {
					shadow = 1.0;
				} else {
					variance = max( variance, 0.0000001 );
					float d = shadowCoord.z - mean;
					float p_max = variance / ( variance + d * d );
					p_max = clamp( ( p_max - 0.3 ) / 0.65, 0.0, 1.0 );
					shadow = max( hard_shadow, p_max );
				}
			}
			return mix( 1.0, shadow, shadowIntensity );
		}
	#else
		float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			#ifdef USE_REVERSED_DEPTH_BUFFER
				shadowCoord.z -= shadowBias;
			#else
				shadowCoord.z += shadowBias;
			#endif
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
			if ( frustumTest ) {
				float depth = texture2D( shadowMap, shadowCoord.xy ).r;
				#ifdef USE_REVERSED_DEPTH_BUFFER
					shadow = step( depth, shadowCoord.z );
				#else
					shadow = step( shadowCoord.z, depth );
				#endif
			}
			return mix( 1.0, shadow, shadowIntensity );
		}
	#endif
	#if NUM_SUN_LIGHT_SHADOWS > 0
		float getSunShadow(
			#if defined( SHADOWMAP_TYPE_PCF )
				sampler2DShadow shadowMap,
			#else
				sampler2D shadowMap,
			#endif
			SunLightShadow sunLightShadow,
			int shadowIndex
		) {
			vec4 shadowWorldPosition = vec4( vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * sunLightShadow.shadowNormalBias, 1.0 );
			float viewDepth = vSunShadowWorldPosition.w;
			int cascadeOffset = shadowIndex * SUN_LIGHT_CASCADES;
			float shadow = 1.0;
			for ( int i = SUN_LIGHT_CASCADES - 1; i >= 0; i -- ) {
				vec4 cascade = sunShadowCascade[ cascadeOffset + i ];
				if ( viewDepth >= cascade.x && viewDepth < cascade.y ) {
					float cascadeShadow = getShadow(
						shadowMap,
						sunLightShadow.shadowMapSize,
						sunLightShadow.shadowIntensity,
						sunLightShadow.shadowBias,
						sunLightShadow.shadowRadius,
						sunShadowMatrix[ cascadeOffset + i ] * shadowWorldPosition
					);
					shadow = mix( cascadeShadow, shadow, smoothstep( cascade.z, cascade.y, viewDepth ) );
				}
			}
			return shadow;
		}
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
	#if defined( SHADOWMAP_TYPE_PCF )
	float getPointShadow( samplerCubeShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		float shadow = 1.0;
		vec3 lightToPosition = shadowCoord.xyz;
		vec3 bd3D = normalize( lightToPosition );
		vec3 absVec = abs( lightToPosition );
		float viewSpaceZ = max( max( absVec.x, absVec.y ), absVec.z );
		if ( viewSpaceZ - shadowCameraFar <= 0.0 && viewSpaceZ - shadowCameraNear >= 0.0 ) {
			#ifdef USE_REVERSED_DEPTH_BUFFER
				float dp = ( shadowCameraNear * ( shadowCameraFar - viewSpaceZ ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
				dp -= shadowBias;
			#else
				float dp = ( shadowCameraFar * ( viewSpaceZ - shadowCameraNear ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
				dp += shadowBias;
			#endif
			float texelSize = shadowRadius / shadowMapSize.x;
			vec3 absDir = abs( bd3D );
			vec3 tangent = absDir.x > absDir.z ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
			tangent = normalize( cross( bd3D, tangent ) );
			vec3 bitangent = cross( bd3D, tangent );
			float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
			vec2 sample0 = vogelDiskSample( 0, 5, phi );
			vec2 sample1 = vogelDiskSample( 1, 5, phi );
			vec2 sample2 = vogelDiskSample( 2, 5, phi );
			vec2 sample3 = vogelDiskSample( 3, 5, phi );
			vec2 sample4 = vogelDiskSample( 4, 5, phi );
			shadow = (
				texture( shadowMap, vec4( bd3D + ( tangent * sample0.x + bitangent * sample0.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample1.x + bitangent * sample1.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample2.x + bitangent * sample2.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample3.x + bitangent * sample3.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample4.x + bitangent * sample4.y ) * texelSize, dp ) )
			) * 0.2;
		}
		return mix( 1.0, shadow, shadowIntensity );
	}
	#elif defined( SHADOWMAP_TYPE_BASIC )
	float getPointShadow( samplerCube shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		float shadow = 1.0;
		vec3 lightToPosition = shadowCoord.xyz;
		vec3 absVec = abs( lightToPosition );
		float viewSpaceZ = max( max( absVec.x, absVec.y ), absVec.z );
		if ( viewSpaceZ - shadowCameraFar <= 0.0 && viewSpaceZ - shadowCameraNear >= 0.0 ) {
			float dp = ( shadowCameraFar * ( viewSpaceZ - shadowCameraNear ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
			dp += shadowBias;
			vec3 bd3D = normalize( lightToPosition );
			float depth = textureCube( shadowMap, bd3D ).r;
			#ifdef USE_REVERSED_DEPTH_BUFFER
				depth = 1.0 - depth;
			#endif
			shadow = step( dp, depth );
		}
		return mix( 1.0, shadow, shadowIntensity );
	}
	#endif
	#endif
#endif`,vy=`#if NUM_SPOT_LIGHT_COORDS > 0
	uniform mat4 spotLightMatrix[ NUM_SPOT_LIGHT_COORDS ];
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_SUN_LIGHT_SHADOWS > 0
		varying vec4 vSunShadowWorldPosition;
		varying vec3 vSunShadowWorldNormal;
	#endif
	#if NUM_DIR_LIGHT_SHADOWS > 0
		uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		struct SpotLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		uniform mat4 pointShadowMatrix[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
#endif`,xy=`#if ( defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 || NUM_SUN_LIGHT_SHADOWS > 0 || NUM_POINT_LIGHT_SHADOWS > 0 ) ) || ( NUM_SPOT_LIGHT_COORDS > 0 )
	#ifdef HAS_NORMAL
		vec3 shadowWorldNormal = transformNormalByInverseViewMatrix( transformedNormal, viewMatrix );
	#else
		vec3 shadowWorldNormal = vec3( 0.0 );
	#endif
	vec4 shadowWorldPosition;
#endif
#if defined( USE_SHADOWMAP )
	#if NUM_SUN_LIGHT_SHADOWS > 0
		vSunShadowWorldPosition = vec4( worldPosition.xyz, - mvPosition.z );
		vSunShadowWorldNormal = shadowWorldNormal;
	#endif
	#if NUM_DIR_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );
			vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * pointLightShadows[ i ].shadowNormalBias, 0 );
			vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
		shadowWorldPosition = worldPosition;
		#if ( defined( USE_SHADOWMAP ) && UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
			shadowWorldPosition.xyz += shadowWorldNormal * spotLightShadows[ i ].shadowNormalBias;
		#endif
		vSpotLightCoord[ i ] = spotLightMatrix[ i ] * shadowWorldPosition;
	}
	#pragma unroll_loop_end
#endif`,yy=`float getShadowMask() {
	float shadow = 1.0;
	#ifdef USE_SHADOWMAP
	#if NUM_SUN_LIGHT_SHADOWS > 0
	SunLightShadow sunLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SUN_LIGHT_SHADOWS; i ++ ) {
		sunLight = sunLightShadows[ i ];
		shadow *= receiveShadow ? getSunShadow( sunShadowMap[ i ], sunLight, UNROLLED_LOOP_INDEX ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
		directionalLight = directionalLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLight.shadowMapSize, directionalLight.shadowIntensity, directionalLight.shadowBias, directionalLight.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_SHADOWS; i ++ ) {
		spotLight = spotLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( spotShadowMap[ i ], spotLight.shadowMapSize, spotLight.shadowIntensity, spotLight.shadowBias, spotLight.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0 && ( defined( SHADOWMAP_TYPE_PCF ) || defined( SHADOWMAP_TYPE_BASIC ) )
	PointLightShadow pointLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
		pointLight = pointLightShadows[ i ];
		shadow *= receiveShadow ? getPointShadow( pointShadowMap[ i ], pointLight.shadowMapSize, pointLight.shadowIntensity, pointLight.shadowBias, pointLight.shadowRadius, vPointShadowCoord[ i ], pointLight.shadowCameraNear, pointLight.shadowCameraFar ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#endif
	return shadow;
}`,by=`#ifdef USE_SKINNING
	mat4 boneMatX = getBoneMatrix( skinIndex.x );
	mat4 boneMatY = getBoneMatrix( skinIndex.y );
	mat4 boneMatZ = getBoneMatrix( skinIndex.z );
	mat4 boneMatW = getBoneMatrix( skinIndex.w );
#endif`,Sy=`#ifdef USE_SKINNING
	uniform mat4 bindMatrix;
	uniform mat4 bindMatrixInverse;
	uniform highp sampler2D boneTexture;
	mat4 getBoneMatrix( const in float i ) {
		int size = textureSize( boneTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( boneTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( boneTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( boneTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( boneTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
#endif`,My=`#ifdef USE_SKINNING
	vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
	vec4 skinned = vec4( 0.0 );
	skinned += boneMatX * skinVertex * skinWeight.x;
	skinned += boneMatY * skinVertex * skinWeight.y;
	skinned += boneMatZ * skinVertex * skinWeight.z;
	skinned += boneMatW * skinVertex * skinWeight.w;
	transformed = ( bindMatrixInverse * skinned ).xyz;
#endif`,wy=`#ifdef USE_SKINNING
	mat4 skinMatrix = mat4( 0.0 );
	skinMatrix += skinWeight.x * boneMatX;
	skinMatrix += skinWeight.y * boneMatY;
	skinMatrix += skinWeight.z * boneMatZ;
	skinMatrix += skinWeight.w * boneMatW;
	skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
	objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
	#ifdef USE_TANGENT
		objectTangent = vec4( skinMatrix * vec4( objectTangent, 0.0 ) ).xyz;
	#endif
#endif`,Ey=`float specularStrength;
#ifdef USE_SPECULARMAP
	vec4 texelSpecular = texture2D( specularMap, vSpecularMapUv );
	specularStrength = texelSpecular.r;
#else
	specularStrength = 1.0;
#endif`,Ty=`#ifdef USE_SPECULARMAP
	uniform sampler2D specularMap;
#endif`,Ay=`#if defined( TONE_MAPPING )
	gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
#endif`,Ry=`#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
uniform float toneMappingExposure;
vec3 LinearToneMapping( vec3 color ) {
	return saturate( toneMappingExposure * color );
}
vec3 ReinhardToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	return saturate( color / ( vec3( 1.0 ) + color ) );
}
vec3 CineonToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	color = max( vec3( 0.0 ), color - 0.004 );
	return pow( ( color * ( 6.2 * color + 0.5 ) ) / ( color * ( 6.2 * color + 1.7 ) + 0.06 ), vec3( 2.2 ) );
}
vec3 RRTAndODTFit( vec3 v ) {
	vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
	vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}
vec3 ACESFilmicToneMapping( vec3 color ) {
	const mat3 ACESInputMat = mat3(
		vec3( 0.59719, 0.07600, 0.02840 ),		vec3( 0.35458, 0.90834, 0.13383 ),
		vec3( 0.04823, 0.01566, 0.83777 )
	);
	const mat3 ACESOutputMat = mat3(
		vec3(  1.60475, -0.10208, -0.00327 ),		vec3( -0.53108,  1.10813, -0.07276 ),
		vec3( -0.07367, -0.00605,  1.07602 )
	);
	color *= toneMappingExposure / 0.6;
	color = ACESInputMat * color;
	color = RRTAndODTFit( color );
	color = ACESOutputMat * color;
	return saturate( color );
}
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
	vec3( 1.6605, - 0.1246, - 0.0182 ),
	vec3( - 0.5876, 1.1329, - 0.1006 ),
	vec3( - 0.0728, - 0.0083, 1.1187 )
);
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
	vec3( 0.6274, 0.0691, 0.0164 ),
	vec3( 0.3293, 0.9195, 0.0880 ),
	vec3( 0.0433, 0.0113, 0.8956 )
);
vec3 agxDefaultContrastApprox( vec3 x ) {
	vec3 x2 = x * x;
	vec3 x4 = x2 * x2;
	return + 15.5 * x4 * x2
		- 40.14 * x4 * x
		+ 31.96 * x4
		- 6.868 * x2 * x
		+ 0.4298 * x2
		+ 0.1191 * x
		- 0.00232;
}
vec3 AgXToneMapping( vec3 color ) {
	const mat3 AgXInsetMatrix = mat3(
		vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
		vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
		vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
	);
	const mat3 AgXOutsetMatrix = mat3(
		vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
		vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
		vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 )
	);
	const float AgxMinEv = - 12.47393;	const float AgxMaxEv = 4.026069;
	color *= toneMappingExposure;
	color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
	color = AgXInsetMatrix * color;
	color = max( color, 1e-10 );	color = log2( color );
	color = ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv );
	color = clamp( color, 0.0, 1.0 );
	color = agxDefaultContrastApprox( color );
	color = AgXOutsetMatrix * color;
	color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
	color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
	color = clamp( color, 0.0, 1.0 );
	return color;
}
vec3 NeutralToneMapping( vec3 color ) {
	const float StartCompression = 0.8 - 0.04;
	const float Desaturation = 0.15;
	color *= toneMappingExposure;
	float x = min( color.r, min( color.g, color.b ) );
	float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
	color -= offset;
	float peak = max( color.r, max( color.g, color.b ) );
	if ( peak < StartCompression ) return color;
	float d = 1. - StartCompression;
	float newPeak = 1. - d * d / ( peak + d - StartCompression );
	color *= newPeak / peak;
	float g = 1. - 1. / ( Desaturation * ( peak - newPeak ) + 1. );
	return mix( color, vec3( newPeak ), g );
}
vec3 CustomToneMapping( vec3 color ) { return color; }`,Cy=`#ifdef USE_TRANSMISSION
	material.transmission = transmission;
	material.transmissionAlpha = 1.0;
	material.thickness = thickness;
	material.attenuationDistance = attenuationDistance;
	material.attenuationColor = attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		material.transmission *= texture2D( transmissionMap, vTransmissionMapUv ).r;
	#endif
	#ifdef USE_THICKNESSMAP
		material.thickness *= texture2D( thicknessMap, vThicknessMapUv ).g;
	#endif
	vec3 pos = vWorldPosition;
	vec3 v = normalize( cameraPosition - pos );
	vec3 n = transformNormalByInverseViewMatrix( normal, viewMatrix );
	vec4 transmitted = getIBLVolumeRefraction(
		n, v, material.roughness, material.diffuseContribution, material.specularColorBlended, material.specularF90,
		pos, modelMatrix, viewMatrix, projectionMatrix, material.dispersion, material.ior, material.thickness,
		material.attenuationColor, material.attenuationDistance );
	material.transmissionAlpha = mix( material.transmissionAlpha, transmitted.a, material.transmission );
	totalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );
#endif`,Py=`#ifdef USE_TRANSMISSION
	uniform float transmission;
	uniform float thickness;
	uniform float attenuationDistance;
	uniform vec3 attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		uniform sampler2D transmissionMap;
	#endif
	#ifdef USE_THICKNESSMAP
		uniform sampler2D thicknessMap;
	#endif
	uniform vec2 transmissionSamplerSize;
	uniform sampler2D transmissionSamplerMap;
	uniform mat4 modelMatrix;
	uniform mat4 projectionMatrix;
	varying vec3 vWorldPosition;
	float w0( float a ) {
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - a + 3.0 ) - 3.0 ) + 1.0 );
	}
	float w1( float a ) {
		return ( 1.0 / 6.0 ) * ( a *  a * ( 3.0 * a - 6.0 ) + 4.0 );
	}
	float w2( float a ){
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - 3.0 * a + 3.0 ) + 3.0 ) + 1.0 );
	}
	float w3( float a ) {
		return ( 1.0 / 6.0 ) * ( a * a * a );
	}
	float g0( float a ) {
		return w0( a ) + w1( a );
	}
	float g1( float a ) {
		return w2( a ) + w3( a );
	}
	float h0( float a ) {
		return - 1.0 + w1( a ) / ( w0( a ) + w1( a ) );
	}
	float h1( float a ) {
		return 1.0 + w3( a ) / ( w2( a ) + w3( a ) );
	}
	vec4 bicubic( sampler2D tex, vec2 uv, vec4 texelSize, float lod ) {
		uv = uv * texelSize.zw + 0.5;
		vec2 iuv = floor( uv );
		vec2 fuv = fract( uv );
		float g0x = g0( fuv.x );
		float g1x = g1( fuv.x );
		float h0x = h0( fuv.x );
		float h1x = h1( fuv.x );
		float h0y = h0( fuv.y );
		float h1y = h1( fuv.y );
		vec2 p0 = ( vec2( iuv.x + h0x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p1 = ( vec2( iuv.x + h1x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p2 = ( vec2( iuv.x + h0x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		vec2 p3 = ( vec2( iuv.x + h1x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		return g0( fuv.y ) * ( g0x * textureLod( tex, p0, lod ) + g1x * textureLod( tex, p1, lod ) ) +
			g1( fuv.y ) * ( g0x * textureLod( tex, p2, lod ) + g1x * textureLod( tex, p3, lod ) );
	}
	vec4 textureBicubic( sampler2D sampler, vec2 uv, float lod ) {
		vec2 fLodSize = vec2( textureSize( sampler, int( lod ) ) );
		vec2 cLodSize = vec2( textureSize( sampler, int( lod + 1.0 ) ) );
		vec2 fLodSizeInv = 1.0 / fLodSize;
		vec2 cLodSizeInv = 1.0 / cLodSize;
		vec4 fSample = bicubic( sampler, uv, vec4( fLodSizeInv, fLodSize ), floor( lod ) );
		vec4 cSample = bicubic( sampler, uv, vec4( cLodSizeInv, cLodSize ), ceil( lod ) );
		return mix( fSample, cSample, fract( lod ) );
	}
	vec3 getVolumeTransmissionRay( const in vec3 n, const in vec3 v, const in float thickness, const in float ior, const in mat4 modelMatrix ) {
		vec3 refractionVector = refract( - v, normalize( n ), 1.0 / ior );
		vec3 modelScale;
		modelScale.x = length( vec3( modelMatrix[ 0 ].xyz ) );
		modelScale.y = length( vec3( modelMatrix[ 1 ].xyz ) );
		modelScale.z = length( vec3( modelMatrix[ 2 ].xyz ) );
		return normalize( refractionVector ) * thickness * modelScale;
	}
	float applyIorToRoughness( const in float roughness, const in float ior ) {
		return roughness * clamp( ior * 2.0 - 2.0, 0.0, 1.0 );
	}
	vec4 getTransmissionSample( const in vec2 fragCoord, const in float roughness, const in float ior ) {
		float lod = log2( transmissionSamplerSize.x ) * applyIorToRoughness( roughness, ior );
		return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );
	}
	vec3 volumeAttenuation( const in float transmissionDistance, const in vec3 attenuationColor, const in float attenuationDistance ) {
		if ( isinf( attenuationDistance ) ) {
			return vec3( 1.0 );
		} else {
			vec3 attenuationCoefficient = -log( attenuationColor ) / attenuationDistance;
			vec3 transmittance = exp( - attenuationCoefficient * transmissionDistance );			return transmittance;
		}
	}
	vec4 getIBLVolumeRefraction( const in vec3 n, const in vec3 v, const in float roughness, const in vec3 diffuseColor,
		const in vec3 specularColor, const in float specularF90, const in vec3 position, const in mat4 modelMatrix,
		const in mat4 viewMatrix, const in mat4 projMatrix, const in float dispersion, const in float ior, const in float thickness,
		const in vec3 attenuationColor, const in float attenuationDistance ) {
		vec4 transmittedLight;
		vec3 transmittance;
		#ifdef USE_DISPERSION
			float halfSpread = ( ior - 1.0 ) * 0.025 * dispersion;
			vec3 iors = vec3( ior - halfSpread, ior, ior + halfSpread );
			for ( int i = 0; i < 3; i ++ ) {
				vec3 transmissionRay = getVolumeTransmissionRay( n, v, thickness, iors[ i ], modelMatrix );
				vec3 refractedRayExit = position + transmissionRay;
				vec4 ndcPos = projMatrix * viewMatrix * vec4( refractedRayExit, 1.0 );
				vec2 refractionCoords = ndcPos.xy / ndcPos.w;
				refractionCoords += 1.0;
				refractionCoords /= 2.0;
				vec4 transmissionSample = getTransmissionSample( refractionCoords, roughness, iors[ i ] );
				transmittedLight[ i ] = transmissionSample[ i ];
				transmittedLight.a += transmissionSample.a;
				transmittance[ i ] = diffuseColor[ i ] * volumeAttenuation( length( transmissionRay ), attenuationColor, attenuationDistance )[ i ];
			}
			transmittedLight.a /= 3.0;
		#else
			vec3 transmissionRay = getVolumeTransmissionRay( n, v, thickness, ior, modelMatrix );
			vec3 refractedRayExit = position + transmissionRay;
			vec4 ndcPos = projMatrix * viewMatrix * vec4( refractedRayExit, 1.0 );
			vec2 refractionCoords = ndcPos.xy / ndcPos.w;
			refractionCoords += 1.0;
			refractionCoords /= 2.0;
			transmittedLight = getTransmissionSample( refractionCoords, roughness, ior );
			transmittance = diffuseColor * volumeAttenuation( length( transmissionRay ), attenuationColor, attenuationDistance );
		#endif
		vec3 attenuatedColor = transmittance * transmittedLight.rgb;
		vec3 F = EnvironmentBRDF( n, v, specularColor, specularF90, roughness );
		float transmittanceFactor = ( transmittance.r + transmittance.g + transmittance.b ) / 3.0;
		return vec4( ( 1.0 - F ) * attenuatedColor, 1.0 - ( 1.0 - transmittedLight.a ) * transmittanceFactor );
	}
#endif`,Ly=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_SPECULARMAP
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,Dy=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	uniform mat3 mapTransform;
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	uniform mat3 alphaMapTransform;
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	uniform mat3 lightMapTransform;
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	uniform mat3 aoMapTransform;
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	uniform mat3 bumpMapTransform;
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	uniform mat3 normalMapTransform;
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_DISPLACEMENTMAP
	uniform mat3 displacementMapTransform;
	varying vec2 vDisplacementMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	uniform mat3 emissiveMapTransform;
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	uniform mat3 metalnessMapTransform;
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	uniform mat3 roughnessMapTransform;
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	uniform mat3 anisotropyMapTransform;
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	uniform mat3 clearcoatMapTransform;
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform mat3 clearcoatNormalMapTransform;
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform mat3 clearcoatRoughnessMapTransform;
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	uniform mat3 sheenColorMapTransform;
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	uniform mat3 sheenRoughnessMapTransform;
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	uniform mat3 iridescenceMapTransform;
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform mat3 iridescenceThicknessMapTransform;
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SPECULARMAP
	uniform mat3 specularMapTransform;
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	uniform mat3 specularColorMapTransform;
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	uniform mat3 specularIntensityMapTransform;
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,Ny=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	vUv = vec3( uv, 1 ).xy;
#endif
#ifdef USE_MAP
	vMapUv = ( mapTransform * vec3( MAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ALPHAMAP
	vAlphaMapUv = ( alphaMapTransform * vec3( ALPHAMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_LIGHTMAP
	vLightMapUv = ( lightMapTransform * vec3( LIGHTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_AOMAP
	vAoMapUv = ( aoMapTransform * vec3( AOMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_BUMPMAP
	vBumpMapUv = ( bumpMapTransform * vec3( BUMPMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_NORMALMAP
	vNormalMapUv = ( normalMapTransform * vec3( NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_DISPLACEMENTMAP
	vDisplacementMapUv = ( displacementMapTransform * vec3( DISPLACEMENTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_EMISSIVEMAP
	vEmissiveMapUv = ( emissiveMapTransform * vec3( EMISSIVEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_METALNESSMAP
	vMetalnessMapUv = ( metalnessMapTransform * vec3( METALNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ROUGHNESSMAP
	vRoughnessMapUv = ( roughnessMapTransform * vec3( ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ANISOTROPYMAP
	vAnisotropyMapUv = ( anisotropyMapTransform * vec3( ANISOTROPYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOATMAP
	vClearcoatMapUv = ( clearcoatMapTransform * vec3( CLEARCOATMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	vClearcoatNormalMapUv = ( clearcoatNormalMapTransform * vec3( CLEARCOAT_NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	vClearcoatRoughnessMapUv = ( clearcoatRoughnessMapTransform * vec3( CLEARCOAT_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCEMAP
	vIridescenceMapUv = ( iridescenceMapTransform * vec3( IRIDESCENCEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	vIridescenceThicknessMapUv = ( iridescenceThicknessMapTransform * vec3( IRIDESCENCE_THICKNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_COLORMAP
	vSheenColorMapUv = ( sheenColorMapTransform * vec3( SHEEN_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	vSheenRoughnessMapUv = ( sheenRoughnessMapTransform * vec3( SHEEN_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULARMAP
	vSpecularMapUv = ( specularMapTransform * vec3( SPECULARMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_COLORMAP
	vSpecularColorMapUv = ( specularColorMapTransform * vec3( SPECULAR_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	vSpecularIntensityMapUv = ( specularIntensityMapTransform * vec3( SPECULAR_INTENSITYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_TRANSMISSIONMAP
	vTransmissionMapUv = ( transmissionMapTransform * vec3( TRANSMISSIONMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_THICKNESSMAP
	vThicknessMapUv = ( thicknessMapTransform * vec3( THICKNESSMAP_UV, 1 ) ).xy;
#endif`,Iy=`#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
	vec4 worldPosition = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		worldPosition = batchingMatrix * worldPosition;
	#endif
	#ifdef USE_INSTANCING
		worldPosition = instanceMatrix * worldPosition;
	#endif
	worldPosition = modelMatrix * worldPosition;
#endif`;const Uy=`varying vec2 vUv;
uniform mat3 uvTransform;
void main() {
	vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	gl_Position = vec4( position.xy, 1.0, 1.0 );
}`,Fy=`uniform sampler2D t2D;
uniform float backgroundIntensity;
varying vec2 vUv;
void main() {
	vec4 texColor = texture2D( t2D, vUv );
	#ifdef DECODE_VIDEO_TEXTURE
		texColor = vec4( mix( pow( texColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), texColor.rgb * 0.0773993808, vec3( lessThanEqual( texColor.rgb, vec3( 0.04045 ) ) ) ), texColor.w );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,By=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,Oy=`#ifdef ENVMAP_TYPE_CUBE
	uniform samplerCube envMap;
#elif defined( ENVMAP_TYPE_CUBE_UV )
	uniform sampler2D envMap;
#endif
uniform float backgroundBlurriness;
uniform float backgroundIntensity;
uniform mat3 backgroundRotation;
varying vec3 vWorldDirection;
#include <cube_uv_reflection_fragment>
void main() {
	#ifdef ENVMAP_TYPE_CUBE
		vec4 texColor = textureCube( envMap, backgroundRotation * vWorldDirection );
	#elif defined( ENVMAP_TYPE_CUBE_UV )
		vec4 texColor = textureCubeUV( envMap, backgroundRotation * vWorldDirection, backgroundBlurriness );
	#else
		vec4 texColor = vec4( 0.0, 0.0, 0.0, 1.0 );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,ky=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,zy=`uniform samplerCube tCube;
uniform float tFlip;
uniform float opacity;
varying vec3 vWorldDirection;
void main() {
	vec4 texColor = textureCube( tCube, vec3( tFlip * vWorldDirection.x, vWorldDirection.yz ) );
	gl_FragColor = texColor;
	gl_FragColor.a *= opacity;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,Vy=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
varying vec2 vHighPrecisionZW;
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#include <morphinstance_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vHighPrecisionZW = gl_Position.zw;
}`,Hy=`#if DEPTH_PACKING == 3200
	uniform float opacity;
#endif
#include <common>
#include <packing>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
varying vec2 vHighPrecisionZW;
void main() {
	vec4 diffuseColor = vec4( 1.0 );
	#include <clipping_planes_fragment>
	#if DEPTH_PACKING == 3200
		diffuseColor.a = opacity;
	#endif
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <logdepthbuf_fragment>
	#ifdef USE_REVERSED_DEPTH_BUFFER
		float fragCoordZ = vHighPrecisionZW[ 0 ] / vHighPrecisionZW[ 1 ];
	#else
		float fragCoordZ = 0.5 * vHighPrecisionZW[ 0 ] / vHighPrecisionZW[ 1 ] + 0.5;
	#endif
	#if DEPTH_PACKING == 3200
		gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );
	#elif DEPTH_PACKING == 3201
		gl_FragColor = packDepthToRGBA( fragCoordZ );
	#elif DEPTH_PACKING == 3202
		gl_FragColor = vec4( packDepthToRGB( fragCoordZ ), 1.0 );
	#elif DEPTH_PACKING == 3203
		gl_FragColor = vec4( packDepthToRG( fragCoordZ ), 0.0, 1.0 );
	#endif
}`,Gy=`#define DISTANCE
varying vec3 vWorldPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#include <morphinstance_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <worldpos_vertex>
	#include <clipping_planes_vertex>
	vWorldPosition = worldPosition.xyz;
}`,Wy=`#define DISTANCE
uniform vec3 referencePosition;
uniform float nearDistance;
uniform float farDistance;
varying vec3 vWorldPosition;
#include <common>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( 1.0 );
	#include <clipping_planes_fragment>
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	float dist = length( vWorldPosition - referencePosition );
	dist = ( dist - nearDistance ) / ( farDistance - nearDistance );
	dist = saturate( dist );
	gl_FragColor = vec4( dist, 0.0, 0.0, 1.0 );
}`,$y=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
}`,Xy=`uniform sampler2D tEquirect;
varying vec3 vWorldDirection;
#include <common>
void main() {
	vec3 direction = normalize( vWorldDirection );
	vec2 sampleUV = equirectUv( direction );
	gl_FragColor = texture2D( tEquirect, sampleUV );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,qy=`uniform float scale;
attribute float lineDistance;
varying float vLineDistance;
#include <common>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	vLineDistance = scale * lineDistance;
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,Yy=`uniform vec3 diffuse;
uniform float opacity;
uniform float dashSize;
uniform float totalSize;
varying float vLineDistance;
#include <common>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	if ( mod( vLineDistance, totalSize ) > dashSize ) {
		discard;
	}
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,Ky=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinbase_vertex>
		#include <skinnormal_vertex>
		#include <defaultnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <fog_vertex>
}`,Zy=`uniform vec3 diffuse;
uniform float opacity;
#ifndef FLAT_SHADED
	varying vec3 vNormal;
#endif
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;
	#else
		reflectedLight.indirectDiffuse += vec3( 1.0 );
	#endif
	#include <aomap_fragment>
	reflectedLight.indirectDiffuse *= diffuseColor.rgb;
	vec3 outgoingLight = reflectedLight.indirectDiffuse;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,Jy=`#define LAMBERT
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,Qy=`#define LAMBERT
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_lambert_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_lambert_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,jy=`#define MATCAP
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <displacementmap_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
	vViewPosition = - mvPosition.xyz;
}`,eb=`#define MATCAP
uniform vec3 diffuse;
uniform float opacity;
uniform sampler2D matcap;
varying vec3 vViewPosition;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	vec3 viewDir = normalize( vViewPosition );
	vec3 x = normalize( vec3( viewDir.z, 0.0, - viewDir.x ) );
	vec3 y = cross( viewDir, x );
	vec2 uv = vec2( dot( x, normal ), dot( y, normal ) ) * 0.495 + 0.5;
	#ifdef USE_MATCAP
		vec4 matcapColor = texture2D( matcap, uv );
	#else
		vec4 matcapColor = vec4( vec3( mix( 0.2, 0.8, uv.y ) ), 1.0 );
	#endif
	vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,tb=`#define NORMAL
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	vViewPosition = - mvPosition.xyz;
#endif
}`,nb=`#define NORMAL
uniform float opacity;
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <uv_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( 0.0, 0.0, 0.0, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	gl_FragColor = vec4( normalize( normal ) * 0.5 + 0.5, diffuseColor.a );
	#ifdef OPAQUE
		gl_FragColor.a = 1.0;
	#endif
}`,ib=`#define PHONG
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,rb=`#define PHONG
uniform vec3 diffuse;
uniform vec3 emissive;
uniform vec3 specular;
uniform float shininess;
uniform float opacity;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_phong_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_phong_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,sb=`#define STANDARD
varying vec3 vViewPosition;
#ifdef USE_TRANSMISSION
	varying vec3 vWorldPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
#ifdef USE_TRANSMISSION
	vWorldPosition = worldPosition.xyz;
#endif
}`,ab=`#define STANDARD
#ifdef PHYSICAL
	#define IOR
	#define USE_SPECULAR
#endif
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float roughness;
uniform float metalness;
uniform float opacity;
#ifdef IOR
	uniform float ior;
#endif
#ifdef USE_SPECULAR
	uniform float specularIntensity;
	uniform vec3 specularColor;
	#ifdef USE_SPECULAR_COLORMAP
		uniform sampler2D specularColorMap;
	#endif
	#ifdef USE_SPECULAR_INTENSITYMAP
		uniform sampler2D specularIntensityMap;
	#endif
#endif
#ifdef USE_CLEARCOAT
	uniform float clearcoat;
	uniform float clearcoatRoughness;
#endif
#ifdef USE_DISPERSION
	uniform float dispersion;
#endif
#ifdef USE_RETROREFLECTION
	uniform float retroreflectivity;
#endif
#ifdef USE_IRIDESCENCE
	uniform float iridescence;
	uniform float iridescenceIOR;
	uniform float iridescenceThicknessMinimum;
	uniform float iridescenceThicknessMaximum;
#endif
#ifdef USE_SHEEN
	uniform vec3 sheenColor;
	uniform float sheenRoughness;
	#ifdef USE_SHEEN_COLORMAP
		uniform sampler2D sheenColorMap;
	#endif
	#ifdef USE_SHEEN_ROUGHNESSMAP
		uniform sampler2D sheenRoughnessMap;
	#endif
#endif
#ifdef USE_ANISOTROPY
	uniform vec2 anisotropyVector;
	#ifdef USE_ANISOTROPYMAP
		uniform sampler2D anisotropyMap;
	#endif
#endif
varying vec3 vViewPosition;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <iridescence_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_physical_pars_fragment>
#include <transmission_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <clearcoat_pars_fragment>
#include <iridescence_pars_fragment>
#include <roughnessmap_pars_fragment>
#include <metalnessmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <roughnessmap_fragment>
	#include <metalnessmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <clearcoat_normal_fragment_begin>
	#include <clearcoat_normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_physical_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
	vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
	#include <transmission_fragment>
	vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
	#ifdef USE_SHEEN
 
		outgoingLight = outgoingLight + sheenSpecularDirect + sheenSpecularIndirect;
 
 	#endif
	#ifdef USE_CLEARCOAT
		float dotNVcc = saturate( dot( geometryClearcoatNormal, geometryViewDir ) );
		vec3 Fcc = F_Schlick( material.clearcoatF0, material.clearcoatF90, dotNVcc );
		outgoingLight = outgoingLight * ( 1.0 - material.clearcoat * Fcc ) + ( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * material.clearcoat;
	#endif
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,ob=`#define TOON
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,lb=`#define TOON
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <gradientmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_toon_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_toon_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,cb=`uniform float size;
uniform float scale;
#include <common>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
#ifdef USE_POINTS_UV
	varying vec2 vUv;
	uniform mat3 uvTransform;
#endif
void main() {
	#ifdef USE_POINTS_UV
		vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	#endif
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	gl_PointSize = size;
	#ifdef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) gl_PointSize *= ( scale / - mvPosition.z );
	#endif
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <fog_vertex>
}`,ub=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <color_pars_fragment>
#include <map_particle_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_particle_fragment>
	#include <color_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,fb=`#include <common>
#include <batching_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
void main() {
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,db=`uniform vec3 color;
uniform float opacity;
#include <common>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
void main() {
	#include <logdepthbuf_fragment>
	gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,hb=`uniform float rotation;
uniform vec2 center;
#include <common>
#include <uv_pars_vertex>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	vec4 mvPosition = modelViewMatrix[ 3 ];
	vec2 scale = vec2( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ) );
	#ifndef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) scale *= - mvPosition.z;
	#endif
	vec2 alignedPosition = ( position.xy - ( center - vec2( 0.5 ) ) ) * scale;
	vec2 rotatedPosition;
	rotatedPosition.x = cos( rotation ) * alignedPosition.x - sin( rotation ) * alignedPosition.y;
	rotatedPosition.y = sin( rotation ) * alignedPosition.x + cos( rotation ) * alignedPosition.y;
	mvPosition.xy += rotatedPosition;
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,pb=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,Qe={alphahash_fragment:Uv,alphahash_pars_fragment:Fv,alphamap_fragment:Bv,alphamap_pars_fragment:Ov,alphatest_fragment:kv,alphatest_pars_fragment:zv,aomap_fragment:Vv,aomap_pars_fragment:Hv,batching_pars_vertex:Gv,batching_vertex:Wv,begin_vertex:$v,beginnormal_vertex:Xv,bsdfs:qv,iridescence_fragment:Yv,bumpmap_pars_fragment:Kv,clipping_planes_fragment:Zv,clipping_planes_pars_fragment:Jv,clipping_planes_pars_vertex:Qv,clipping_planes_vertex:jv,color_fragment:ex,color_pars_fragment:tx,color_pars_vertex:nx,color_vertex:ix,common:rx,cube_uv_reflection_fragment:sx,defaultnormal_vertex:ax,displacementmap_pars_vertex:ox,displacementmap_vertex:lx,emissivemap_fragment:cx,emissivemap_pars_fragment:ux,colorspace_fragment:fx,colorspace_pars_fragment:dx,envmap_fragment:hx,envmap_common_pars_fragment:px,envmap_pars_fragment:mx,envmap_pars_vertex:gx,envmap_physical_pars_fragment:Ax,envmap_vertex:_x,fog_vertex:vx,fog_pars_vertex:xx,fog_fragment:yx,fog_pars_fragment:bx,gradientmap_pars_fragment:Sx,lightmap_pars_fragment:Mx,lights_lambert_fragment:wx,lights_lambert_pars_fragment:Ex,lights_pars_begin:Tx,lights_toon_fragment:Rx,lights_toon_pars_fragment:Cx,lights_phong_fragment:Px,lights_phong_pars_fragment:Lx,lights_physical_fragment:Dx,lights_physical_pars_fragment:Nx,lights_fragment_begin:Ix,lights_fragment_maps:Ux,lights_fragment_end:Fx,lightprobes_pars_fragment:Bx,logdepthbuf_fragment:Ox,logdepthbuf_pars_fragment:kx,logdepthbuf_pars_vertex:zx,logdepthbuf_vertex:Vx,map_fragment:Hx,map_pars_fragment:Gx,map_particle_fragment:Wx,map_particle_pars_fragment:$x,metalnessmap_fragment:Xx,metalnessmap_pars_fragment:qx,morphinstance_vertex:Yx,morphcolor_vertex:Kx,morphnormal_vertex:Zx,morphtarget_pars_vertex:Jx,morphtarget_vertex:Qx,normal_fragment_begin:jx,normal_fragment_maps:ey,normal_pars_fragment:ty,normal_pars_vertex:ny,normal_vertex:iy,normalmap_pars_fragment:ry,clearcoat_normal_fragment_begin:sy,clearcoat_normal_fragment_maps:ay,clearcoat_pars_fragment:oy,iridescence_pars_fragment:ly,opaque_fragment:cy,packing:uy,premultiplied_alpha_fragment:fy,project_vertex:dy,dithering_fragment:hy,dithering_pars_fragment:py,roughnessmap_fragment:my,roughnessmap_pars_fragment:gy,shadowmap_pars_fragment:_y,shadowmap_pars_vertex:vy,shadowmap_vertex:xy,shadowmask_pars_fragment:yy,skinbase_vertex:by,skinning_pars_vertex:Sy,skinning_vertex:My,skinnormal_vertex:wy,specularmap_fragment:Ey,specularmap_pars_fragment:Ty,tonemapping_fragment:Ay,tonemapping_pars_fragment:Ry,transmission_fragment:Cy,transmission_pars_fragment:Py,uv_pars_fragment:Ly,uv_pars_vertex:Dy,uv_vertex:Ny,worldpos_vertex:Iy,background_vert:Uy,background_frag:Fy,backgroundCube_vert:By,backgroundCube_frag:Oy,cube_vert:ky,cube_frag:zy,depth_vert:Vy,depth_frag:Hy,distance_vert:Gy,distance_frag:Wy,equirect_vert:$y,equirect_frag:Xy,linedashed_vert:qy,linedashed_frag:Yy,meshbasic_vert:Ky,meshbasic_frag:Zy,meshlambert_vert:Jy,meshlambert_frag:Qy,meshmatcap_vert:jy,meshmatcap_frag:eb,meshnormal_vert:tb,meshnormal_frag:nb,meshphong_vert:ib,meshphong_frag:rb,meshphysical_vert:sb,meshphysical_frag:ab,meshtoon_vert:ob,meshtoon_frag:lb,points_vert:cb,points_frag:ub,shadow_vert:fb,shadow_frag:db,sprite_vert:hb,sprite_frag:pb},_e={common:{diffuse:{value:new ft(16777215)},opacity:{value:1},map:{value:null},mapTransform:{value:new We},alphaMap:{value:null},alphaMapTransform:{value:new We},alphaTest:{value:0}},specularmap:{specularMap:{value:null},specularMapTransform:{value:new We}},envmap:{envMap:{value:null},envMapRotation:{value:new We},reflectivity:{value:1},ior:{value:1.5},refractionRatio:{value:.98},dfgLUT:{value:null}},aomap:{aoMap:{value:null},aoMapIntensity:{value:1},aoMapTransform:{value:new We}},lightmap:{lightMap:{value:null},lightMapIntensity:{value:1},lightMapTransform:{value:new We}},bumpmap:{bumpMap:{value:null},bumpMapTransform:{value:new We},bumpScale:{value:1}},normalmap:{normalMap:{value:null},normalMapTransform:{value:new We},normalScale:{value:new Ze(1,1)}},displacementmap:{displacementMap:{value:null},displacementMapTransform:{value:new We},displacementScale:{value:1},displacementBias:{value:0}},emissivemap:{emissiveMap:{value:null},emissiveMapTransform:{value:new We}},metalnessmap:{metalnessMap:{value:null},metalnessMapTransform:{value:new We}},roughnessmap:{roughnessMap:{value:null},roughnessMapTransform:{value:new We}},gradientmap:{gradientMap:{value:null}},fog:{fogDensity:{value:25e-5},fogNear:{value:1},fogFar:{value:2e3},fogColor:{value:new ft(16777215)}},lights:{ambientLightColor:{value:[]},lightProbe:{value:[]},sunLights:{value:[],properties:{direction:{},color:{}}},sunLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},sunShadowMatrix:{value:[]},sunShadowCascade:{value:[]},directionalLights:{value:[],properties:{direction:{},color:{}}},directionalLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},directionalShadowMatrix:{value:[]},spotLights:{value:[],properties:{color:{},position:{},direction:{},distance:{},coneCos:{},penumbraCos:{},decay:{}}},spotLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},spotLightMap:{value:[]},spotLightMatrix:{value:[]},pointLights:{value:[],properties:{color:{},position:{},decay:{},distance:{}}},pointLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{},shadowCameraNear:{},shadowCameraFar:{}}},pointShadowMatrix:{value:[]},hemisphereLights:{value:[],properties:{direction:{},skyColor:{},groundColor:{}}},rectAreaLights:{value:[],properties:{color:{},position:{},width:{},height:{}}},ltc_1:{value:null},ltc_2:{value:null},probesSH:{value:null},probesMin:{value:new U},probesMax:{value:new U},probesResolution:{value:new U}},points:{diffuse:{value:new ft(16777215)},opacity:{value:1},size:{value:1},scale:{value:1},map:{value:null},alphaMap:{value:null},alphaMapTransform:{value:new We},alphaTest:{value:0},uvTransform:{value:new We}},sprite:{diffuse:{value:new ft(16777215)},opacity:{value:1},center:{value:new Ze(.5,.5)},rotation:{value:0},map:{value:null},mapTransform:{value:new We},alphaMap:{value:null},alphaMapTransform:{value:new We},alphaTest:{value:0}}},Sn={basic:{uniforms:gn([_e.common,_e.specularmap,_e.envmap,_e.aomap,_e.lightmap,_e.fog]),vertexShader:Qe.meshbasic_vert,fragmentShader:Qe.meshbasic_frag},lambert:{uniforms:gn([_e.common,_e.specularmap,_e.envmap,_e.aomap,_e.lightmap,_e.emissivemap,_e.bumpmap,_e.normalmap,_e.displacementmap,_e.fog,_e.lights,{emissive:{value:new ft(0)},envMapIntensity:{value:1}}]),vertexShader:Qe.meshlambert_vert,fragmentShader:Qe.meshlambert_frag},phong:{uniforms:gn([_e.common,_e.specularmap,_e.envmap,_e.aomap,_e.lightmap,_e.emissivemap,_e.bumpmap,_e.normalmap,_e.displacementmap,_e.fog,_e.lights,{emissive:{value:new ft(0)},specular:{value:new ft(1118481)},shininess:{value:30},envMapIntensity:{value:1}}]),vertexShader:Qe.meshphong_vert,fragmentShader:Qe.meshphong_frag},standard:{uniforms:gn([_e.common,_e.envmap,_e.aomap,_e.lightmap,_e.emissivemap,_e.bumpmap,_e.normalmap,_e.displacementmap,_e.roughnessmap,_e.metalnessmap,_e.fog,_e.lights,{emissive:{value:new ft(0)},roughness:{value:1},metalness:{value:0},envMapIntensity:{value:1}}]),vertexShader:Qe.meshphysical_vert,fragmentShader:Qe.meshphysical_frag},toon:{uniforms:gn([_e.common,_e.aomap,_e.lightmap,_e.emissivemap,_e.bumpmap,_e.normalmap,_e.displacementmap,_e.gradientmap,_e.fog,_e.lights,{emissive:{value:new ft(0)}}]),vertexShader:Qe.meshtoon_vert,fragmentShader:Qe.meshtoon_frag},matcap:{uniforms:gn([_e.common,_e.bumpmap,_e.normalmap,_e.displacementmap,_e.fog,{matcap:{value:null}}]),vertexShader:Qe.meshmatcap_vert,fragmentShader:Qe.meshmatcap_frag},points:{uniforms:gn([_e.points,_e.fog]),vertexShader:Qe.points_vert,fragmentShader:Qe.points_frag},dashed:{uniforms:gn([_e.common,_e.fog,{scale:{value:1},dashSize:{value:1},totalSize:{value:2}}]),vertexShader:Qe.linedashed_vert,fragmentShader:Qe.linedashed_frag},depth:{uniforms:gn([_e.common,_e.displacementmap]),vertexShader:Qe.depth_vert,fragmentShader:Qe.depth_frag},normal:{uniforms:gn([_e.common,_e.bumpmap,_e.normalmap,_e.displacementmap,{opacity:{value:1}}]),vertexShader:Qe.meshnormal_vert,fragmentShader:Qe.meshnormal_frag},sprite:{uniforms:gn([_e.sprite,_e.fog]),vertexShader:Qe.sprite_vert,fragmentShader:Qe.sprite_frag},background:{uniforms:{uvTransform:{value:new We},t2D:{value:null},backgroundIntensity:{value:1}},vertexShader:Qe.background_vert,fragmentShader:Qe.background_frag},backgroundCube:{uniforms:{envMap:{value:null},backgroundBlurriness:{value:0},backgroundIntensity:{value:1},backgroundRotation:{value:new We}},vertexShader:Qe.backgroundCube_vert,fragmentShader:Qe.backgroundCube_frag},cube:{uniforms:{tCube:{value:null},tFlip:{value:-1},opacity:{value:1}},vertexShader:Qe.cube_vert,fragmentShader:Qe.cube_frag},equirect:{uniforms:{tEquirect:{value:null}},vertexShader:Qe.equirect_vert,fragmentShader:Qe.equirect_frag},distance:{uniforms:gn([_e.common,_e.displacementmap,{referencePosition:{value:new U},nearDistance:{value:1},farDistance:{value:1e3}}]),vertexShader:Qe.distance_vert,fragmentShader:Qe.distance_frag},shadow:{uniforms:gn([_e.lights,_e.fog,{color:{value:new ft(0)},opacity:{value:1}}]),vertexShader:Qe.shadow_vert,fragmentShader:Qe.shadow_frag}};Sn.physical={uniforms:gn([Sn.standard.uniforms,{clearcoat:{value:0},clearcoatMap:{value:null},clearcoatMapTransform:{value:new We},clearcoatNormalMap:{value:null},clearcoatNormalMapTransform:{value:new We},clearcoatNormalScale:{value:new Ze(1,1)},clearcoatRoughness:{value:0},clearcoatRoughnessMap:{value:null},clearcoatRoughnessMapTransform:{value:new We},dispersion:{value:0},retroreflectivity:{value:0},iridescence:{value:0},iridescenceMap:{value:null},iridescenceMapTransform:{value:new We},iridescenceIOR:{value:1.3},iridescenceThicknessMinimum:{value:100},iridescenceThicknessMaximum:{value:400},iridescenceThicknessMap:{value:null},iridescenceThicknessMapTransform:{value:new We},sheen:{value:0},sheenColor:{value:new ft(0)},sheenColorMap:{value:null},sheenColorMapTransform:{value:new We},sheenRoughness:{value:1},sheenRoughnessMap:{value:null},sheenRoughnessMapTransform:{value:new We},transmission:{value:0},transmissionMap:{value:null},transmissionMapTransform:{value:new We},transmissionSamplerSize:{value:new Ze},transmissionSamplerMap:{value:null},thickness:{value:0},thicknessMap:{value:null},thicknessMapTransform:{value:new We},attenuationDistance:{value:0},attenuationColor:{value:new ft(0)},specularColor:{value:new ft(1,1,1)},specularColorMap:{value:null},specularColorMapTransform:{value:new We},specularIntensity:{value:1},specularIntensityMap:{value:null},specularIntensityMapTransform:{value:new We},anisotropyVector:{value:new Ze},anisotropyMap:{value:null},anisotropyMapTransform:{value:new We}}]),vertexShader:Qe.meshphysical_vert,fragmentShader:Qe.meshphysical_frag};const Ea={r:0,b:0,g:0},mb=new et,kp=new We;kp.set(-1,0,0,0,1,0,0,0,1);function gb(n,e,t,i,r,s){const a=new ft(0);let o=r===!0?0:1,l,c,f=null,d=0,u=null;function h(v){let w=v.isScene===!0?v.background:null;if(w&&w.isTexture){const y=v.backgroundBlurriness>0;w=e.get(w,y)}return w}function _(v){let w=!1;const y=h(v);y===null?p(a,o):y&&y.isColor&&(p(y,1),w=!0);const S=n.xr.getEnvironmentBlendMode();S==="additive"?t.buffers.color.setClear(0,0,0,1,s):S==="alpha-blend"&&t.buffers.color.setClear(0,0,0,0,s),(n.autoClear||w)&&(t.buffers.depth.setTest(!0),t.buffers.depth.setMask(!0),t.buffers.color.setMask(!0),n.clear(n.autoClearColor,n.autoClearDepth,n.autoClearStencil))}function g(v,w){const y=h(w);y&&(y.isCubeTexture||y.mapping===Io)?(c===void 0&&(c=new dn(new Hs(1,1,1),new Pn({name:"BackgroundCubeMaterial",uniforms:jr(Sn.backgroundCube.uniforms),vertexShader:Sn.backgroundCube.vertexShader,fragmentShader:Sn.backgroundCube.fragmentShader,side:fn,depthTest:!1,depthWrite:!1,fog:!1,allowOverride:!1})),c.geometry.deleteAttribute("normal"),c.geometry.deleteAttribute("uv"),c.onBeforeRender=function(S,M,E){this.matrixWorld.copyPosition(E.matrixWorld)},Object.defineProperty(c.material,"envMap",{get:function(){return this.uniforms.envMap.value}}),i.update(c)),c.material.uniforms.envMap.value=y,c.material.uniforms.backgroundBlurriness.value=w.backgroundBlurriness,c.material.uniforms.backgroundIntensity.value=w.backgroundIntensity,c.material.uniforms.backgroundRotation.value.setFromMatrix4(mb.makeRotationFromEuler(w.backgroundRotation)).transpose(),y.isCubeTexture&&y.isRenderTargetTexture===!1&&c.material.uniforms.backgroundRotation.value.premultiply(kp),c.material.toneMapped=at.getTransfer(y.colorSpace)!==mt,(f!==y||d!==y.version||u!==n.toneMapping)&&(c.material.needsUpdate=!0,f=y,d=y.version,u=n.toneMapping),c.layers.enableAll(),v.unshift(c,c.geometry,c.material,0,0,null)):y&&y.isTexture&&(l===void 0&&(l=new dn(new ts(2,2),new Pn({name:"BackgroundMaterial",uniforms:jr(Sn.background.uniforms),vertexShader:Sn.background.vertexShader,fragmentShader:Sn.background.fragmentShader,side:li,depthTest:!1,depthWrite:!1,fog:!1,allowOverride:!1})),l.geometry.deleteAttribute("normal"),Object.defineProperty(l.material,"map",{get:function(){return this.uniforms.t2D.value}}),i.update(l)),l.material.uniforms.t2D.value=y,l.material.uniforms.backgroundIntensity.value=w.backgroundIntensity,l.material.toneMapped=at.getTransfer(y.colorSpace)!==mt,y.matrixAutoUpdate===!0&&y.updateMatrix(),l.material.uniforms.uvTransform.value.copy(y.matrix),(f!==y||d!==y.version||u!==n.toneMapping)&&(l.material.needsUpdate=!0,f=y,d=y.version,u=n.toneMapping),l.layers.enableAll(),v.unshift(l,l.geometry,l.material,0,0,null))}function p(v,w){v.getRGB(Ea,Up(n)),t.buffers.color.setClear(Ea.r,Ea.g,Ea.b,w,s)}function m(){c!==void 0&&(c.geometry.dispose(),c.material.dispose(),c=void 0),l!==void 0&&(l.geometry.dispose(),l.material.dispose(),l=void 0)}return{getClearColor:function(){return a},setClearColor:function(v,w=1){a.set(v),o=w,p(a,o)},getClearAlpha:function(){return o},setClearAlpha:function(v){o=v,p(a,o)},render:_,addToRenderList:g,dispose:m}}function _b(n,e){const t=n.getParameter(n.MAX_VERTEX_ATTRIBS),i={},r=u(null);let s=r,a=!1;function o(D,R,N,I,z){let $=!1;const X=d(D,I,N,R);s!==X&&(s=X,c(s.object)),$=h(D,I,N,z),$&&_(D,I,N,z),z!==null&&e.update(z,n.ELEMENT_ARRAY_BUFFER),($||a)&&(a=!1,y(D,R,N,I),z!==null&&n.bindBuffer(n.ELEMENT_ARRAY_BUFFER,e.get(z).buffer))}function l(){return n.createVertexArray()}function c(D){return n.bindVertexArray(D)}function f(D){return n.deleteVertexArray(D)}function d(D,R,N,I){const z=I.wireframe===!0;let $=i[R.id];$===void 0&&($={},i[R.id]=$);const X=D.isInstancedMesh===!0?D.id:0;let re=$[X];re===void 0&&(re={},$[X]=re);let J=re[N.id];J===void 0&&(J={},re[N.id]=J);let Q=J[z];return Q===void 0&&(Q=u(l()),J[z]=Q),Q}function u(D){const R=[],N=[],I=[];for(let z=0;z<t;z++)R[z]=0,N[z]=0,I[z]=0;return{geometry:null,program:null,wireframe:!1,newAttributes:R,enabledAttributes:N,attributeDivisors:I,object:D,attributes:{},index:null}}function h(D,R,N,I){const z=s.attributes,$=R.attributes;let X=0;const re=N.getAttributes();for(const J in re)if(re[J].location>=0){const te=z[J];let ue=$[J];if(ue===void 0&&(J==="instanceMatrix"&&D.instanceMatrix&&(ue=D.instanceMatrix),J==="instanceColor"&&D.instanceColor&&(ue=D.instanceColor)),te===void 0||te.attribute!==ue||ue&&te.data!==ue.data)return!0;X++}return s.attributesNum!==X||s.index!==I}function _(D,R,N,I){const z={},$=R.attributes;let X=0;const re=N.getAttributes();for(const J in re)if(re[J].location>=0){let te=$[J];te===void 0&&(J==="instanceMatrix"&&D.instanceMatrix&&(te=D.instanceMatrix),J==="instanceColor"&&D.instanceColor&&(te=D.instanceColor));const ue={};ue.attribute=te,te&&te.data&&(ue.data=te.data),z[J]=ue,X++}s.attributes=z,s.attributesNum=X,s.index=I}function g(){const D=s.newAttributes;for(let R=0,N=D.length;R<N;R++)D[R]=0}function p(D){m(D,0)}function m(D,R){const N=s.newAttributes,I=s.enabledAttributes,z=s.attributeDivisors;N[D]=1,I[D]===0&&(n.enableVertexAttribArray(D),I[D]=1),z[D]!==R&&(n.vertexAttribDivisor(D,R),z[D]=R)}function v(){const D=s.newAttributes,R=s.enabledAttributes;for(let N=0,I=R.length;N<I;N++)R[N]!==D[N]&&(n.disableVertexAttribArray(N),R[N]=0)}function w(D,R,N,I,z,$,X){X===!0?n.vertexAttribIPointer(D,R,N,z,$):n.vertexAttribPointer(D,R,N,I,z,$)}function y(D,R,N,I){g();const z=I.attributes,$=N.getAttributes(),X=R.defaultAttributeValues;for(const re in $){const J=$[re];if(J.location>=0){let Q=z[re];if(Q===void 0&&(re==="instanceMatrix"&&D.instanceMatrix&&(Q=D.instanceMatrix),re==="instanceColor"&&D.instanceColor&&(Q=D.instanceColor)),Q!==void 0){const te=Q.normalized,ue=Q.itemSize,be=e.get(Q);if(be===void 0)continue;const Fe=be.buffer,Re=be.type,je=be.bytesPerElement,ne=Re===n.INT||Re===n.UNSIGNED_INT||Q.gpuType===xu;if(Q.isInterleavedBufferAttribute){const ae=Q.data,Me=ae.stride,Be=Q.offset;if(ae.isInstancedInterleavedBuffer){for(let ve=0;ve<J.locationSize;ve++)m(J.location+ve,ae.meshPerAttribute);D.isInstancedMesh!==!0&&I._maxInstanceCount===void 0&&(I._maxInstanceCount=ae.meshPerAttribute*ae.count)}else for(let ve=0;ve<J.locationSize;ve++)p(J.location+ve);n.bindBuffer(n.ARRAY_BUFFER,Fe);for(let ve=0;ve<J.locationSize;ve++)w(J.location+ve,ue/J.locationSize,Re,te,Me*je,(Be+ue/J.locationSize*ve)*je,ne)}else{if(Q.isInstancedBufferAttribute){for(let ae=0;ae<J.locationSize;ae++)m(J.location+ae,Q.meshPerAttribute);D.isInstancedMesh!==!0&&I._maxInstanceCount===void 0&&(I._maxInstanceCount=Q.meshPerAttribute*Q.count)}else for(let ae=0;ae<J.locationSize;ae++)p(J.location+ae);n.bindBuffer(n.ARRAY_BUFFER,Fe);for(let ae=0;ae<J.locationSize;ae++)w(J.location+ae,ue/J.locationSize,Re,te,ue*je,ue/J.locationSize*ae*je,ne)}}else if(X!==void 0){const te=X[re];if(te!==void 0)switch(te.length){case 2:n.vertexAttrib2fv(J.location,te);break;case 3:n.vertexAttrib3fv(J.location,te);break;case 4:n.vertexAttrib4fv(J.location,te);break;default:n.vertexAttrib1fv(J.location,te)}}}}v()}function S(){T();for(const D in i){const R=i[D];for(const N in R){const I=R[N];for(const z in I){const $=I[z];for(const X in $)f($[X].object),delete $[X];delete I[z]}}delete i[D]}}function M(D){if(i[D.id]===void 0)return;const R=i[D.id];for(const N in R){const I=R[N];for(const z in I){const $=I[z];for(const X in $)f($[X].object),delete $[X];delete I[z]}}delete i[D.id]}function E(D){for(const R in i){const N=i[R];for(const I in N){const z=N[I];if(z[D.id]===void 0)continue;const $=z[D.id];for(const X in $)f($[X].object),delete $[X];delete z[D.id]}}}function b(D){for(const R in i){const N=i[R],I=D.isInstancedMesh===!0?D.id:0,z=N[I];if(z!==void 0){for(const $ in z){const X=z[$];for(const re in X)f(X[re].object),delete X[re];delete z[$]}delete N[I],Object.keys(N).length===0&&delete i[R]}}}function T(){C(),a=!0,s!==r&&(s=r,c(s.object))}function C(){r.geometry=null,r.program=null,r.wireframe=!1}return{setup:o,reset:T,resetDefaultState:C,dispose:S,releaseStatesOfGeometry:M,releaseStatesOfObject:b,releaseStatesOfProgram:E,initAttributes:g,enableAttribute:p,disableUnusedAttributes:v}}function vb(n,e,t){let i;function r(l){i=l}function s(l,c){n.drawArrays(i,l,c),t.update(c,i,1)}function a(l,c,f){f!==0&&(n.drawArraysInstanced(i,l,c,f),t.update(c,i,f))}function o(l,c,f){if(f===0)return;e.get("WEBGL_multi_draw").multiDrawArraysWEBGL(i,l,0,c,0,f);let u=0;for(let h=0;h<f;h++)u+=c[h];t.update(u,i,1)}this.setMode=r,this.render=s,this.renderInstances=a,this.renderMultiDraw=o}function xb(n,e,t,i){let r;function s(){if(r!==void 0)return r;if(e.has("EXT_texture_filter_anisotropic")===!0){const E=e.get("EXT_texture_filter_anisotropic");r=n.getParameter(E.MAX_TEXTURE_MAX_ANISOTROPY_EXT)}else r=0;return r}function a(E){return!(E!==$n&&i.convert(E)!==n.getParameter(n.IMPLEMENTATION_COLOR_READ_FORMAT))}function o(E){const b=E===ui&&(e.has("EXT_color_buffer_half_float")||e.has("EXT_color_buffer_float"));return!(E!==Bn&&E!==si&&!b&&i.convert(E)!==n.getParameter(n.IMPLEMENTATION_COLOR_READ_TYPE))}function l(E){if(E==="highp"){if(n.getShaderPrecisionFormat(n.VERTEX_SHADER,n.HIGH_FLOAT).precision>0&&n.getShaderPrecisionFormat(n.FRAGMENT_SHADER,n.HIGH_FLOAT).precision>0)return"highp";E="mediump"}return E==="mediump"&&n.getShaderPrecisionFormat(n.VERTEX_SHADER,n.MEDIUM_FLOAT).precision>0&&n.getShaderPrecisionFormat(n.FRAGMENT_SHADER,n.MEDIUM_FLOAT).precision>0?"mediump":"lowp"}let c=t.precision!==void 0?t.precision:"highp";const f=l(c);f!==c&&(ze("WebGLRenderer:",c,"not supported, using",f,"instead."),c=f);const d=t.logarithmicDepthBuffer===!0,u=t.reversedDepthBuffer===!0&&e.has("EXT_clip_control");t.reversedDepthBuffer===!0&&u===!1&&ze("WebGLRenderer: Unable to use reversed depth buffer due to missing EXT_clip_control extension. Fallback to default depth buffer.");const h=n.getParameter(n.MAX_TEXTURE_IMAGE_UNITS),_=n.getParameter(n.MAX_VERTEX_TEXTURE_IMAGE_UNITS),g=n.getParameter(n.MAX_TEXTURE_SIZE),p=n.getParameter(n.MAX_CUBE_MAP_TEXTURE_SIZE),m=n.getParameter(n.MAX_VERTEX_ATTRIBS),v=n.getParameter(n.MAX_VERTEX_UNIFORM_VECTORS),w=n.getParameter(n.MAX_VARYING_VECTORS),y=n.getParameter(n.MAX_FRAGMENT_UNIFORM_VECTORS),S=n.getParameter(n.MAX_SAMPLES),M=n.getParameter(n.SAMPLES);return{isWebGL2:!0,getMaxAnisotropy:s,getMaxPrecision:l,textureFormatReadable:a,textureTypeReadable:o,precision:c,logarithmicDepthBuffer:d,reversedDepthBuffer:u,maxTextures:h,maxVertexTextures:_,maxTextureSize:g,maxCubemapSize:p,maxAttributes:m,maxVertexUniforms:v,maxVaryings:w,maxFragmentUniforms:y,maxSamples:S,samples:M}}function yb(n){const e=this;let t=null,i=0,r=!1,s=!1;const a=new Fn,o=new We,l={value:null,needsUpdate:!1};this.uniform=l,this.numPlanes=0,this.numIntersection=0,this.init=function(d,u){const h=d.length!==0||u||i!==0||r;return r=u,i=d.length,h},this.beginShadows=function(){s=!0,f(null)},this.endShadows=function(){s=!1},this.setGlobalState=function(d,u){t=f(d,u,0)},this.setState=function(d,u,h){const _=d.clippingPlanes,g=d.clipIntersection,p=d.clipShadows,m=n.get(d);if(!r||_===null||_.length===0||s&&!p)s?f(null):c();else{const v=s?0:i,w=v*4;let y=m.clippingState||null;l.value=y,y=f(_,u,w,h);for(let S=0;S!==w;++S)y[S]=t[S];m.clippingState=y,this.numIntersection=g?this.numPlanes:0,this.numPlanes+=v}};function c(){l.value!==t&&(l.value=t,l.needsUpdate=i>0),e.numPlanes=i,e.numIntersection=0}function f(d,u,h,_){const g=d!==null?d.length:0;let p=null;if(g!==0){if(p=l.value,_!==!0||p===null){const m=h+g*4,v=u.matrixWorldInverse;o.getNormalMatrix(v),(p===null||p.length<m)&&(p=new Float32Array(m));for(let w=0,y=h;w!==g;++w,y+=4)a.copy(d[w]).applyMatrix4(v,o),a.normal.toArray(p,y),p[y+3]=a.constant}l.value=p,l.needsUpdate=!0}return e.numPlanes=g,e.numIntersection=0,p}}const qr=4,bb=6,Sb=20,Mb=256,hs=new Lu,jf=new ft;let Sl=null,Ml=0,wl=0,El=!1;const wb=new U,nr=new U;class ed{constructor(e){this._renderer=e,this._pingPongRenderTarget=null,this._lodMax=0,this._cubeSize=0,this._sizeLods=[],this._lodMeshes=[],this._backgroundBox=null,this._cubemapMaterial=null,this._equirectMaterial=null,this._blurMaterial=null,this._ggxMaterial=null}fromScene(e,t=0,i=.1,r=100,s={}){const{size:a=256,position:o=wb}=s;Sl=this._renderer.getRenderTarget(),Ml=this._renderer.getActiveCubeFace(),wl=this._renderer.getActiveMipmapLevel(),El=this._renderer.xr.enabled,this._renderer.xr.enabled=!1,this._setSize(a);const l=this._allocateTargets();return l.depthBuffer=!0,this._sceneToCubeUV(e,i,r,l,o),t>0&&this._blur(l,0,0,t),this._applyPMREM(l),this._cleanup(l),l}fromEquirectangular(e,t=null){return this._fromTexture(e,t)}fromCubemap(e,t=null){return this._fromTexture(e,t)}compileCubemapShader(){this._cubemapMaterial===null&&(this._cubemapMaterial=id(),this._compileMaterial(this._cubemapMaterial))}compileEquirectangularShader(){this._equirectMaterial===null&&(this._equirectMaterial=nd(),this._compileMaterial(this._equirectMaterial))}dispose(){this._dispose(),this._cubemapMaterial!==null&&this._cubemapMaterial.dispose(),this._equirectMaterial!==null&&this._equirectMaterial.dispose(),this._backgroundBox!==null&&(this._backgroundBox.geometry.dispose(),this._backgroundBox.material.dispose())}_setSize(e){this._lodMax=Math.floor(Math.log2(e)),this._cubeSize=Math.pow(2,this._lodMax)}_dispose(){this._blurMaterial!==null&&this._blurMaterial.dispose(),this._ggxMaterial!==null&&this._ggxMaterial.dispose(),this._pingPongRenderTarget!==null&&this._pingPongRenderTarget.dispose();for(let e=0;e<this._lodMeshes.length;e++)this._lodMeshes[e].geometry.dispose()}_cleanup(e){this._renderer.setRenderTarget(Sl,Ml,wl),this._renderer.xr.enabled=El,e.scissorTest=!1,Fr(e,0,0,e.width,e.height)}_fromTexture(e,t){e.mapping===pr||e.mapping===Qr?this._setSize(e.image.length===0?16:e.image[0].width||e.image[0].image.width):this._setSize(e.image.width/4),Sl=this._renderer.getRenderTarget(),Ml=this._renderer.getActiveCubeFace(),wl=this._renderer.getActiveMipmapLevel(),El=this._renderer.xr.enabled,this._renderer.xr.enabled=!1;const i=t||this._allocateTargets();return this._textureToCubeUV(e,i),this._applyPMREM(i),this._cleanup(i),i}_allocateTargets(){const e=3*Math.max(this._cubeSize,112),t=4*this._cubeSize,i={magFilter:ln,minFilter:ln,generateMipmaps:!1,type:ui,format:$n,colorSpace:bo,depthBuffer:!1},r=td(e,t,i);if(this._pingPongRenderTarget===null||this._pingPongRenderTarget.width!==e||this._pingPongRenderTarget.height!==t){this._pingPongRenderTarget!==null&&this._dispose(),this._pingPongRenderTarget=td(e,t,i);const{_lodMax:s}=this;({lodMeshes:this._lodMeshes,sizeLods:this._sizeLods}=Eb(s)),this._blurMaterial=Ab(s,e,t),this._ggxMaterial=Tb(s,e,t)}return r}_compileMaterial(e){const t=new dn(new Jt,e);this._renderer.compile(t,hs)}_sceneToCubeUV(e,t,i,r,s){const l=new Rn(90,1,t,i),c=[1,-1,1,1,1,1],f=[1,1,1,-1,-1,-1],d=this._renderer,u=d.autoClear,h=d.toneMapping;d.getClearColor(jf),d.toneMapping=oi,d.autoClear=!1,d.state.buffers.depth.getReversed()&&(d.setRenderTarget(r),d.clearDepth(),d.setRenderTarget(null)),this._backgroundBox===null&&(this._backgroundBox=new dn(new Hs,new Uo({name:"PMREM.Background",side:fn,depthWrite:!1,depthTest:!1})));const g=this._backgroundBox,p=g.material;let m=!1;const v=e.background;v?v.isColor&&(p.color.copy(v),e.background=null,m=!0):(p.color.copy(jf),m=!0);for(let w=0;w<6;w++){const y=w%3;y===0?(l.up.set(0,c[w],0),l.position.set(s.x,s.y,s.z),l.lookAt(s.x+f[w],s.y,s.z)):y===1?(l.up.set(0,0,c[w]),l.position.set(s.x,s.y,s.z),l.lookAt(s.x,s.y+f[w],s.z)):(l.up.set(0,c[w],0),l.position.set(s.x,s.y,s.z),l.lookAt(s.x,s.y,s.z+f[w]));const S=this._cubeSize;Fr(r,y*S,w>2?S:0,S,S),d.setRenderTarget(r),m&&d.render(g,l),d.render(e,l)}d.toneMapping=h,d.autoClear=u,e.background=v}_textureToCubeUV(e,t){const i=this._renderer,r=e.mapping===pr||e.mapping===Qr;r?(this._cubemapMaterial===null&&(this._cubemapMaterial=id()),this._cubemapMaterial.uniforms.flipEnvMap.value=e.isRenderTargetTexture===!1?-1:1):this._equirectMaterial===null&&(this._equirectMaterial=nd());const s=r?this._cubemapMaterial:this._equirectMaterial,a=this._lodMeshes[0];a.material=s;const o=s.uniforms;o.envMap.value=e;const l=this._cubeSize;Fr(t,0,0,3*l,2*l),i.setRenderTarget(t),i.render(a,hs)}_applyPMREM(e){const t=this._renderer,i=t.autoClear;t.autoClear=!1;const r=this._lodMeshes.length;for(let s=1;s<r;s++)this._applyGGXFilter(e,s-1,s);t.autoClear=i}_applyGGXFilter(e,t,i){const r=this._renderer,s=this._pingPongRenderTarget,a=this._ggxMaterial,o=this._lodMeshes[i];o.material=a;const l=a.uniforms,c=i/(this._lodMeshes.length-1),f=t/(this._lodMeshes.length-1),d=Math.sqrt(c*c-f*f),u=c*1.25,h=d*u,{_lodMax:_}=this,g=this._sizeLods[i],p=3*g*(i>_-qr?i-_+qr:0),m=4*(this._cubeSize-g);l.envMap.value=e.texture,l.roughness.value=h,l.mipInt.value=_-t,Fr(s,p,m,3*g,2*g),r.setRenderTarget(s),r.render(o,hs),l.envMap.value=s.texture,l.roughness.value=0,l.mipInt.value=_-i,Fr(e,p,m,3*g,2*g),r.setRenderTarget(e),r.render(o,hs)}_blur(e,t,i,r){const s=this._pingPongRenderTarget,a=Math.min(r,Math.PI)/Math.SQRT2;this._blurPass(e,s,t,i,a),this._blurPass(s,e,i,i,a)}_blurPass(e,t,i,r,s){const a=this._renderer,o=this._blurMaterial,l=this._lodMeshes[r];l.material=o;const c=o.uniforms;c.envMap.value=e.texture,c.sigma.value=s,c.mipInt.value=this._lodMax-i;const f=this._sizeLods[r],d=3*f*(r>this._lodMax-qr?r-this._lodMax+qr:0),u=4*(this._cubeSize-f);Fr(t,d,u,3*f,2*f),a.setRenderTarget(t),a.render(l,hs)}}function Eb(n){const e=[],t=[];let i=n;const r=n-qr+1+bb;for(let s=0;s<r;s++){const a=Math.pow(2,i);e.push(a);const o=1/(a-2),l=-o,c=1+o,f=[l,l,c,l,c,c,l,l,c,c,l,c],d=6,u=6,h=3,_=new Float32Array(h*u*d),g=new Float32Array(h*u*d);for(let m=0;m<d;m++){const v=m%3*2/3-1,w=m>2?0:-1,y=[v,w,0,v+2/3,w,0,v+2/3,w+1,0,v,w,0,v+2/3,w+1,0,v,w+1,0];_.set(y,h*u*m);for(let S=0;S<u;S++){const M=f[S*2]*2-1,E=f[S*2+1]*2-1;m===0?nr.set(1,E,M):m===1?nr.set(-M,1,-E):m===2?nr.set(-M,E,1):m===3?nr.set(-1,E,-M):m===4?nr.set(-M,-1,E):nr.set(M,E,-1),nr.toArray(g,(m*u+S)*h)}}const p=new Jt;p.setAttribute("position",new Kt(_,h)),p.setAttribute("outputDirection",new Kt(g,h)),t.push(new dn(p,null)),i>qr&&i--}return{lodMeshes:t,sizeLods:e}}function td(n,e,t){const i=new qn(n,e,t);return i.texture.mapping=Io,i.texture.name="PMREM.cubeUv",i.scissorTest=!0,i}function Fr(n,e,t,i,r){n.viewport.set(e,t,i,r),n.scissor.set(e,t,i,r)}function Tb(n,e,t){return new Pn({name:"PMREMGGXConvolution",defines:{GGX_SAMPLES:Mb,CUBEUV_TEXEL_WIDTH:1/e,CUBEUV_TEXEL_HEIGHT:1/t,CUBEUV_MAX_MIP:`${n}.0`},uniforms:{envMap:{value:null},roughness:{value:0},mipInt:{value:0}},vertexShader:Bo(),fragmentShader:`

			precision highp float;
			precision highp int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;
			uniform float roughness;
			uniform float mipInt;

			#define ENVMAP_TYPE_CUBE_UV
			#include <cube_uv_reflection_fragment>

			#define PI 3.14159265359

			// Van der Corput radical inverse
			float radicalInverse_VdC(uint bits) {
				bits = (bits << 16u) | (bits >> 16u);
				bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
				bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
				bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
				bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
				return float(bits) * 2.3283064365386963e-10; // / 0x100000000
			}

			// Hammersley sequence
			vec2 hammersley(uint i, uint N) {
				return vec2(float(i) / float(N), radicalInverse_VdC(i));
			}

			// GGX VNDF importance sampling (Eric Heitz 2018)
			// "Sampling the GGX Distribution of Visible Normals"
			// https://jcgt.org/published/0007/04/01/
			vec3 importanceSampleGGX_VNDF(vec2 Xi, vec3 V, float roughness) {
				float alpha = roughness * roughness;

				// Section 4.1: Orthonormal basis
				vec3 T1 = vec3(1.0, 0.0, 0.0);
				vec3 T2 = cross(V, T1);

				// Section 4.2: Parameterization of projected area
				float r = sqrt(Xi.x);
				float phi = 2.0 * PI * Xi.y;
				float t1 = r * cos(phi);
				float t2 = r * sin(phi);
				float s = 0.5 * (1.0 + V.z);
				t2 = (1.0 - s) * sqrt(1.0 - t1 * t1) + s * t2;

				// Section 4.3: Reprojection onto hemisphere
				vec3 Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * V;

				// Section 3.4: Transform back to ellipsoid configuration
				return normalize(vec3(alpha * Nh.x, alpha * Nh.y, max(0.0, Nh.z)));
			}

			void main() {
				vec3 N = normalize(vOutputDirection);
				vec3 V = N; // Assume view direction equals normal for pre-filtering

				vec3 prefilteredColor = vec3(0.0);
				float totalWeight = 0.0;

				// For very low roughness, just sample the environment directly
				if (roughness < 0.001) {
					gl_FragColor = vec4(bilinearCubeUV(envMap, N, mipInt), 1.0);
					return;
				}

				// Tangent space basis for VNDF sampling
				vec3 up = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
				vec3 tangent = normalize(cross(up, N));
				vec3 bitangent = cross(N, tangent);

				for(uint i = 0u; i < uint(GGX_SAMPLES); i++) {
					vec2 Xi = hammersley(i, uint(GGX_SAMPLES));

					// For PMREM, V = N, so in tangent space V is always (0, 0, 1)
					vec3 H_tangent = importanceSampleGGX_VNDF(Xi, vec3(0.0, 0.0, 1.0), roughness);

					// Transform H back to world space
					vec3 H = normalize(tangent * H_tangent.x + bitangent * H_tangent.y + N * H_tangent.z);
					vec3 L = normalize(2.0 * dot(V, H) * H - V);

					float NdotL = max(dot(N, L), 0.0);

					if(NdotL > 0.0) {
						// Sample environment at fixed mip level
						// VNDF importance sampling handles the distribution filtering
						vec3 sampleColor = bilinearCubeUV(envMap, L, mipInt);

						// Weight by NdotL for the split-sum approximation
						// VNDF PDF naturally accounts for the visible microfacet distribution
						prefilteredColor += sampleColor * NdotL;
						totalWeight += NdotL;
					}
				}

				if (totalWeight > 0.0) {
					prefilteredColor = prefilteredColor / totalWeight;
				}

				gl_FragColor = vec4(prefilteredColor, 1.0);
			}
		`,blending:wi,depthTest:!1,depthWrite:!1})}function Ab(n,e,t){return new Pn({name:"SphericalGaussianBlur",defines:{SAMPLES:Sb,CUBEUV_TEXEL_WIDTH:1/e,CUBEUV_TEXEL_HEIGHT:1/t,CUBEUV_MAX_MIP:`${n}.0`},uniforms:{envMap:{value:null},sigma:{value:0},mipInt:{value:0}},vertexShader:Bo(),fragmentShader:`

			precision highp float;
			precision highp int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;
			uniform float sigma;
			uniform float mipInt;

			#define ENVMAP_TYPE_CUBE_UV
			#include <cube_uv_reflection_fragment>

			#define PI 3.14159265359
			#define GOLDEN_ANGLE 2.39996322973

			void main() {

				if ( sigma == 0.0 ) {

					gl_FragColor = vec4( bilinearCubeUV( envMap, vOutputDirection, mipInt ), 1.0 );
					return;

				}

				vec3 outputDirection = normalize( vOutputDirection );

				vec3 up = abs( outputDirection.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
				vec3 tangent = normalize( cross( up, outputDirection ) );
				vec3 bitangent = cross( outputDirection, tangent );

				// Truncate the kernel at three standard deviations or at the antipode.
				float thetaMax = min( 3.0 * sigma, PI );
				float truncation = 1.0 - exp( - 0.5 * thetaMax * thetaMax / ( sigma * sigma ) );

				vec3 accumColor = vec3( 0.0 );
				float accumWeight = 0.0;

				for ( int i = 0; i < SAMPLES; i ++ ) {

					// Stratified inverse-CDF sampling of the Gaussian, placed on a golden-angle spiral.
					float stratum = ( float( i ) + 0.5 ) / float( SAMPLES );
					float theta = sigma * sqrt( - 2.0 * log( 1.0 - stratum * truncation ) );
					float phi = float( i ) * GOLDEN_ANGLE;

					vec3 offset = cos( phi ) * tangent + sin( phi ) * bitangent;
					vec3 sampleDirection = cos( theta ) * outputDirection + sin( theta ) * offset;

					// Correct the planar sample density to solid angle.
					float weight = sin( theta ) / theta;

					accumColor += weight * bilinearCubeUV( envMap, sampleDirection, mipInt );
					accumWeight += weight;

				}

				gl_FragColor = vec4( accumColor / accumWeight, 1.0 );

			}
		`,blending:wi,depthTest:!1,depthWrite:!1})}function nd(){return new Pn({name:"EquirectangularToCubeUV",uniforms:{envMap:{value:null}},vertexShader:Bo(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;

			#include <common>

			void main() {

				vec3 outputDirection = normalize( vOutputDirection );
				vec2 uv = equirectUv( outputDirection );

				gl_FragColor = vec4( texture2D ( envMap, uv ).rgb, 1.0 );

			}
		`,blending:wi,depthTest:!1,depthWrite:!1})}function id(){return new Pn({name:"CubemapToCubeUV",uniforms:{envMap:{value:null},flipEnvMap:{value:-1}},vertexShader:Bo(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			uniform float flipEnvMap;

			varying vec3 vOutputDirection;

			uniform samplerCube envMap;

			void main() {

				gl_FragColor = textureCube( envMap, vec3( flipEnvMap * vOutputDirection.x, vOutputDirection.yz ) );

			}
		`,blending:wi,depthTest:!1,depthWrite:!1})}function Bo(){return`

		precision mediump float;
		precision mediump int;

		attribute vec3 outputDirection;

		varying vec3 vOutputDirection;

		void main() {

			vOutputDirection = outputDirection;
			gl_Position = vec4( position, 1.0 );

		}
	`}class zp extends qn{constructor(e=1,t={}){super(e,e,t),this.isWebGLCubeRenderTarget=!0;const i={width:e,height:e,depth:1},r=[i,i,i,i,i,i];this.texture=new Np(r),this._setTextureOptions(t),this.texture.isRenderTargetTexture=!0}fromEquirectangularTexture(e,t){this.texture.type=t.type,this.texture.colorSpace=t.colorSpace,this.texture.generateMipmaps=t.generateMipmaps,this.texture.minFilter=t.minFilter,this.texture.magFilter=t.magFilter;const i={uniforms:{tEquirect:{value:null}},vertexShader:`

				varying vec3 vWorldDirection;

				vec3 transformDirection( in vec3 dir, in mat4 matrix ) {

					return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );

				}

				void main() {

					vWorldDirection = transformDirection( position, modelMatrix );

					#include <begin_vertex>
					#include <project_vertex>

				}
			`,fragmentShader:`

				uniform sampler2D tEquirect;

				varying vec3 vWorldDirection;

				#include <common>

				void main() {

					vec3 direction = normalize( vWorldDirection );

					vec2 sampleUV = equirectUv( direction );

					gl_FragColor = texture2D( tEquirect, sampleUV );

				}
			`},r=new Hs(5,5,5),s=new Pn({name:"CubemapFromEquirect",uniforms:jr(i.uniforms),vertexShader:i.vertexShader,fragmentShader:i.fragmentShader,side:fn,blending:wi});s.uniforms.tEquirect.value=t;const a=new dn(r,s),o=t.minFilter;return t.minFilter===fr&&(t.minFilter=ln),new Cv(1,10,this).update(e,a),t.minFilter=o,a.geometry.dispose(),a.material.dispose(),this}clear(e,t=!0,i=!0,r=!0){const s=e.getRenderTarget();for(let a=0;a<6;a++)e.setRenderTarget(this,a),e.clear(t,i,r);e.setRenderTarget(s)}}function Rb(n){let e=new WeakMap,t=new WeakMap,i=null;function r(u,h=!1){return u==null?null:h?a(u):s(u)}function s(u){if(u&&u.isTexture){const h=u.mapping;if(h===Ko||h===Zo)if(e.has(u)){const _=e.get(u).texture;return o(_,u.mapping)}else{const _=u.image;if(_&&_.height>0){const g=new zp(_.height);return g.fromEquirectangularTexture(n,u),e.set(u,g),u.addEventListener("dispose",c),o(g.texture,u.mapping)}else return null}}return u}function a(u){if(u&&u.isTexture){const h=u.mapping,_=h===Ko||h===Zo,g=h===pr||h===Qr;if(_||g){let p=t.get(u);const m=p!==void 0?p.texture.pmremVersion:0;if(u.isRenderTargetTexture&&u.pmremVersion!==m)return i===null&&(i=new ed(n)),p=_?i.fromEquirectangular(u,p):i.fromCubemap(u,p),p.texture.pmremVersion=u.pmremVersion,t.set(u,p),p.texture;if(p!==void 0)return p.texture;{const v=u.image;return _&&v&&v.height>0||g&&v&&l(v)?(i===null&&(i=new ed(n)),p=_?i.fromEquirectangular(u):i.fromCubemap(u),p.texture.pmremVersion=u.pmremVersion,t.set(u,p),u.addEventListener("dispose",f),p.texture):null}}}return u}function o(u,h){return h===Ko?u.mapping=pr:h===Zo&&(u.mapping=Qr),u}function l(u){let h=0;const _=6;for(let g=0;g<_;g++)u[g]!==void 0&&h++;return h===_}function c(u){const h=u.target;h.removeEventListener("dispose",c);const _=e.get(h);_!==void 0&&(e.delete(h),_.dispose())}function f(u){const h=u.target;h.removeEventListener("dispose",f);const _=t.get(h);_!==void 0&&(t.delete(h),_.dispose())}function d(){e=new WeakMap,t=new WeakMap,i!==null&&(i.dispose(),i=null)}return{get:r,dispose:d}}function Cb(n){const e={};function t(i){if(e[i]!==void 0)return e[i];const r=n.getExtension(i);return e[i]=r,r}return{has:function(i){return t(i)!==null},init:function(){t("EXT_color_buffer_float"),t("WEBGL_clip_cull_distance"),t("OES_texture_float_linear"),t("EXT_color_buffer_half_float"),t("WEBGL_multisampled_render_to_texture"),t("WEBGL_render_shared_exponent")},get:function(i){const r=t(i);return r===null&&Kr("WebGLRenderer: "+i+" extension not supported."),r}}}function Pb(n,e,t,i){const r={},s=new WeakMap;function a(d){const u=d.target;u.index!==null&&e.remove(u.index);for(const _ in u.attributes)e.remove(u.attributes[_]);u.removeEventListener("dispose",a),delete r[u.id];const h=s.get(u);h&&(e.remove(h),s.delete(u)),i.releaseStatesOfGeometry(u),u.isInstancedBufferGeometry===!0&&delete u._maxInstanceCount,t.memory.geometries--}function o(d,u){return r[u.id]===!0||(u.addEventListener("dispose",a),r[u.id]=!0,t.memory.geometries++),u}function l(d){const u=d.attributes;for(const h in u)e.update(u[h],n.ARRAY_BUFFER)}function c(d){const u=[],h=d.index,_=d.attributes.position;let g=0;if(_===void 0)return;if(h!==null){const v=h.array;g=h.version;for(let w=0,y=v.length;w<y;w+=3){const S=v[w+0],M=v[w+1],E=v[w+2];u.push(S,M,M,E,E,S)}}else{const v=_.array;g=_.version;for(let w=0,y=v.length/3-1;w<y;w+=3){const S=w+0,M=w+1,E=w+2;u.push(S,M,M,E,E,S)}}const p=new(_.count>=65535?Pp:Cp)(u,1);p.version=g;const m=s.get(d);m&&e.remove(m),s.set(d,p)}function f(d){const u=s.get(d);if(u){const h=d.index;h!==null&&u.version<h.version&&c(d)}else c(d);return s.get(d)}return{get:o,update:l,getWireframeAttribute:f}}function Lb(n,e,t){let i;function r(d){i=d}let s,a;function o(d){s=d.type,a=d.bytesPerElement}function l(d,u){n.drawElements(i,u,s,d*a),t.update(u,i,1)}function c(d,u,h){h!==0&&(n.drawElementsInstanced(i,u,s,d*a,h),t.update(u,i,h))}function f(d,u,h){if(h===0)return;e.get("WEBGL_multi_draw").multiDrawElementsWEBGL(i,u,0,s,d,0,h);let g=0;for(let p=0;p<h;p++)g+=u[p];t.update(g,i,1)}this.setMode=r,this.setIndex=o,this.render=l,this.renderInstances=c,this.renderMultiDraw=f}function Db(n){const e={geometries:0,textures:0},t={frame:0,calls:0,triangles:0,points:0,lines:0};function i(s,a,o){switch(t.calls++,a){case n.TRIANGLES:t.triangles+=o*(s/3);break;case n.LINES:t.lines+=o*(s/2);break;case n.LINE_STRIP:t.lines+=o*(s-1);break;case n.LINE_LOOP:t.lines+=o*s;break;case n.POINTS:t.points+=o*s;break;default:ut("WebGLInfo: Unknown draw mode:",a);break}}function r(){t.calls=0,t.triangles=0,t.points=0,t.lines=0}return{memory:e,render:t,programs:null,autoReset:!0,reset:r,update:i}}function Nb(n,e,t){const i=new WeakMap,r=new bt;function s(a,o,l){const c=a.morphTargetInfluences,f=o.morphAttributes.position||o.morphAttributes.normal||o.morphAttributes.color,d=f!==void 0?f.length:0;let u=i.get(o);if(u===void 0||u.count!==d){let T=function(){E.dispose(),i.delete(o),o.removeEventListener("dispose",T)};u!==void 0&&u.texture.dispose();const h=o.morphAttributes.position!==void 0,_=o.morphAttributes.normal!==void 0,g=o.morphAttributes.color!==void 0,p=o.morphAttributes.position||[],m=o.morphAttributes.normal||[],v=o.morphAttributes.color||[];let w=0;h===!0&&(w=1),_===!0&&(w=2),g===!0&&(w=3);let y=o.attributes.position.count*w,S=1;y>e.maxTextureSize&&(S=Math.ceil(y/e.maxTextureSize),y=e.maxTextureSize);const M=new Float32Array(y*S*4*d),E=new Ep(M,y,S,d);E.type=si,E.needsUpdate=!0;const b=w*4;for(let C=0;C<d;C++){const D=p[C],R=m[C],N=v[C],I=y*S*4*C;for(let z=0;z<D.count;z++){const $=z*b;h===!0&&(r.fromBufferAttribute(D,z),M[I+$+0]=r.x,M[I+$+1]=r.y,M[I+$+2]=r.z,M[I+$+3]=0),_===!0&&(r.fromBufferAttribute(R,z),M[I+$+4]=r.x,M[I+$+5]=r.y,M[I+$+6]=r.z,M[I+$+7]=0),g===!0&&(r.fromBufferAttribute(N,z),M[I+$+8]=r.x,M[I+$+9]=r.y,M[I+$+10]=r.z,M[I+$+11]=N.itemSize===4?r.w:1)}}u={count:d,texture:E,size:new Ze(y,S)},i.set(o,u),o.addEventListener("dispose",T)}if(a.isInstancedMesh===!0&&a.morphTexture!==null)l.getUniforms().setValue(n,"morphTexture",a.morphTexture,t);else{let h=0;for(let g=0;g<c.length;g++)h+=c[g];const _=o.morphTargetsRelative?1:1-h;l.getUniforms().setValue(n,"morphTargetBaseInfluence",_),l.getUniforms().setValue(n,"morphTargetInfluences",c)}l.getUniforms().setValue(n,"morphTargetsTexture",u.texture,t),l.getUniforms().setValue(n,"morphTargetsTextureSize",u.size)}return{update:s}}function Ib(n,e,t,i,r){let s=new WeakMap;function a(c){const f=r.render.frame,d=c.geometry,u=e.get(c,d);if(s.get(u)!==f&&(e.update(u),s.set(u,f)),c.isInstancedMesh&&(c.hasEventListener("dispose",l)===!1&&c.addEventListener("dispose",l),s.get(c)!==f&&(t.update(c.instanceMatrix,n.ARRAY_BUFFER),c.instanceColor!==null&&t.update(c.instanceColor,n.ARRAY_BUFFER),s.set(c,f))),c.isSkinnedMesh){const h=c.skeleton;s.get(h)!==f&&(h.update(),s.set(h,f))}return u}function o(){s=new WeakMap}function l(c){const f=c.target;f.removeEventListener("dispose",l),i.releaseStatesOfObject(f),t.remove(f.instanceMatrix),f.instanceColor!==null&&t.remove(f.instanceColor)}return{update:a,dispose:o}}const Ub={[op]:"LINEAR_TONE_MAPPING",[lp]:"REINHARD_TONE_MAPPING",[cp]:"CINEON_TONE_MAPPING",[up]:"ACES_FILMIC_TONE_MAPPING",[dp]:"AGX_TONE_MAPPING",[hp]:"NEUTRAL_TONE_MAPPING",[fp]:"CUSTOM_TONE_MAPPING"};function Fb(n,e,t,i,r,s){const a=new qn(e,t,{type:n,depthBuffer:r,stencilBuffer:s,samples:i?4:0,storeMultisampledDepthBuffer:!1,storeMultisampledStencilBuffer:!1,resolveDepthBuffer:!1,resolveStencilBuffer:!1});let o=null,l=null;const c=new Jt;c.setAttribute("position",new Wt([-1,3,0,-1,-1,0,3,-1,0],3)),c.setAttribute("uv",new Wt([0,2,0,0,2,0],2));const f=new Ev({uniforms:{tDiffuse:{value:null}},vertexShader:`
			precision highp float;

			uniform mat4 modelViewMatrix;
			uniform mat4 projectionMatrix;

			attribute vec3 position;
			attribute vec2 uv;

			varying vec2 vUv;

			void main() {
				vUv = uv;
				gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
			}`,fragmentShader:`
			precision highp float;

			uniform sampler2D tDiffuse;

			varying vec2 vUv;

			#include <tonemapping_pars_fragment>
			#include <colorspace_pars_fragment>

			void main() {
				gl_FragColor = texture2D( tDiffuse, vUv );

				#ifdef LINEAR_TONE_MAPPING
					gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );
				#elif defined( REINHARD_TONE_MAPPING )
					gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );
				#elif defined( CINEON_TONE_MAPPING )
					gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );
				#elif defined( ACES_FILMIC_TONE_MAPPING )
					gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );
				#elif defined( AGX_TONE_MAPPING )
					gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );
				#elif defined( NEUTRAL_TONE_MAPPING )
					gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );
				#elif defined( CUSTOM_TONE_MAPPING )
					gl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );
				#endif

				#ifdef SRGB_TRANSFER
					gl_FragColor = sRGBTransferOETF( gl_FragColor );
				#endif
			}`,depthTest:!1,depthWrite:!1}),d=new dn(c,f),u=new Lu(-1,1,1,-1,0,1);let h=null,_=null,g=!1,p,m=null,v=[],w=!1;this.setSize=function(y,S){a.setSize(y,S),o!==null&&o.setSize(y,S),l!==null&&l.setSize(y,S);for(let M=0;M<v.length;M++){const E=v[M];E.setSize&&E.setSize(y,S)}},this.setEffects=function(y){v=y,w=v.length>0&&v[0].isRenderPass===!0;const S=a.width,M=a.height;v.length>0&&o===null&&(o=new qn(S,M,{type:ui,depthBuffer:!1,stencilBuffer:!1}),l=new qn(S,M,{type:ui,depthBuffer:!1,stencilBuffer:!1}));for(let E=0;E<v.length;E++){const b=v[E];b.setSize&&b.setSize(S,M)}},this.begin=function(y,S){if(g||y.toneMapping===oi&&v.length===0)return!1;if(m=S,S!==null){const M=S.width,E=S.height;(a.width!==M||a.height!==E)&&this.setSize(M,E)}return w===!1&&y.setRenderTarget(a),p=y.toneMapping,y.toneMapping=oi,!0},this.hasRenderPass=function(){return w},this.end=function(y,S){y.toneMapping=p,g=!0;let M=a,E=o;for(let b=0;b<v.length;b++){const T=v[b];T.enabled!==!1&&(T.render(y,E,M,S),T.needsSwap!==!1&&(M=E,E=E===o?l:o))}if(h!==y.outputColorSpace||_!==y.toneMapping){h=y.outputColorSpace,_=y.toneMapping,f.defines={},at.getTransfer(h)===mt&&(f.defines.SRGB_TRANSFER="");const b=Ub[_];b&&(f.defines[b]=""),f.needsUpdate=!0}f.uniforms.tDiffuse.value=M.texture,y.setRenderTarget(m),y.render(d,u),m=null,g=!1},this.isCompositing=function(){return g},this.dispose=function(){a.dispose(),o!==null&&o.dispose(),l!==null&&l.dispose(),c.dispose(),f.dispose()}}const Vp=new vn,Wc=new Bs(1,1),Hp=new Ep,Gp=new Q_,Wp=new Np,rd=[],sd=[],ad=new Float32Array(16),od=new Float32Array(9),ld=new Float32Array(4);function ns(n,e,t){const i=n[0];if(i<=0||i>0)return n;const r=e*t;let s=rd[r];if(s===void 0&&(s=new Float32Array(r),rd[r]=s),e!==0){i.toArray(s,0);for(let a=1,o=0;a!==e;++a)o+=t,n[a].toArray(s,o)}return s}function $t(n,e){if(n.length!==e.length)return!1;for(let t=0,i=n.length;t<i;t++)if(n[t]!==e[t])return!1;return!0}function Xt(n,e){for(let t=0,i=e.length;t<i;t++)n[t]=e[t]}function Oo(n,e){let t=sd[e];t===void 0&&(t=new Int32Array(e),sd[e]=t);for(let i=0;i!==e;++i)t[i]=n.allocateTextureUnit();return t}function Bb(n,e){const t=this.cache;t[0]!==e&&(n.uniform1f(this.addr,e),t[0]=e)}function Ob(n,e){const t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y)&&(n.uniform2f(this.addr,e.x,e.y),t[0]=e.x,t[1]=e.y);else{if($t(t,e))return;n.uniform2fv(this.addr,e),Xt(t,e)}}function kb(n,e){const t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z)&&(n.uniform3f(this.addr,e.x,e.y,e.z),t[0]=e.x,t[1]=e.y,t[2]=e.z);else if(e.r!==void 0)(t[0]!==e.r||t[1]!==e.g||t[2]!==e.b)&&(n.uniform3f(this.addr,e.r,e.g,e.b),t[0]=e.r,t[1]=e.g,t[2]=e.b);else{if($t(t,e))return;n.uniform3fv(this.addr,e),Xt(t,e)}}function zb(n,e){const t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z||t[3]!==e.w)&&(n.uniform4f(this.addr,e.x,e.y,e.z,e.w),t[0]=e.x,t[1]=e.y,t[2]=e.z,t[3]=e.w);else{if($t(t,e))return;n.uniform4fv(this.addr,e),Xt(t,e)}}function Vb(n,e){const t=this.cache,i=e.elements;if(i===void 0){if($t(t,e))return;n.uniformMatrix2fv(this.addr,!1,e),Xt(t,e)}else{if($t(t,i))return;ld.set(i),n.uniformMatrix2fv(this.addr,!1,ld),Xt(t,i)}}function Hb(n,e){const t=this.cache,i=e.elements;if(i===void 0){if($t(t,e))return;n.uniformMatrix3fv(this.addr,!1,e),Xt(t,e)}else{if($t(t,i))return;od.set(i),n.uniformMatrix3fv(this.addr,!1,od),Xt(t,i)}}function Gb(n,e){const t=this.cache,i=e.elements;if(i===void 0){if($t(t,e))return;n.uniformMatrix4fv(this.addr,!1,e),Xt(t,e)}else{if($t(t,i))return;ad.set(i),n.uniformMatrix4fv(this.addr,!1,ad),Xt(t,i)}}function Wb(n,e){const t=this.cache;t[0]!==e&&(n.uniform1i(this.addr,e),t[0]=e)}function $b(n,e){const t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y)&&(n.uniform2i(this.addr,e.x,e.y),t[0]=e.x,t[1]=e.y);else{if($t(t,e))return;n.uniform2iv(this.addr,e),Xt(t,e)}}function Xb(n,e){const t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z)&&(n.uniform3i(this.addr,e.x,e.y,e.z),t[0]=e.x,t[1]=e.y,t[2]=e.z);else{if($t(t,e))return;n.uniform3iv(this.addr,e),Xt(t,e)}}function qb(n,e){const t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z||t[3]!==e.w)&&(n.uniform4i(this.addr,e.x,e.y,e.z,e.w),t[0]=e.x,t[1]=e.y,t[2]=e.z,t[3]=e.w);else{if($t(t,e))return;n.uniform4iv(this.addr,e),Xt(t,e)}}function Yb(n,e){const t=this.cache;t[0]!==e&&(n.uniform1ui(this.addr,e),t[0]=e)}function Kb(n,e){const t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y)&&(n.uniform2ui(this.addr,e.x,e.y),t[0]=e.x,t[1]=e.y);else{if($t(t,e))return;n.uniform2uiv(this.addr,e),Xt(t,e)}}function Zb(n,e){const t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z)&&(n.uniform3ui(this.addr,e.x,e.y,e.z),t[0]=e.x,t[1]=e.y,t[2]=e.z);else{if($t(t,e))return;n.uniform3uiv(this.addr,e),Xt(t,e)}}function Jb(n,e){const t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z||t[3]!==e.w)&&(n.uniform4ui(this.addr,e.x,e.y,e.z,e.w),t[0]=e.x,t[1]=e.y,t[2]=e.z,t[3]=e.w);else{if($t(t,e))return;n.uniform4uiv(this.addr,e),Xt(t,e)}}function Qb(n,e,t){const i=this.cache,r=t.allocateTextureUnit();i[0]!==r&&(n.uniform1i(this.addr,r),i[0]=r);let s;this.type===n.SAMPLER_2D_SHADOW?(Wc.compareFunction=t.isReversedDepthBuffer()?Tu:Eu,s=Wc):s=Vp,t.setTexture2D(e||s,r)}function jb(n,e,t){const i=this.cache,r=t.allocateTextureUnit();i[0]!==r&&(n.uniform1i(this.addr,r),i[0]=r),t.setTexture3D(e||Gp,r)}function eS(n,e,t){const i=this.cache,r=t.allocateTextureUnit();i[0]!==r&&(n.uniform1i(this.addr,r),i[0]=r),t.setTextureCube(e||Wp,r)}function tS(n,e,t){const i=this.cache,r=t.allocateTextureUnit();i[0]!==r&&(n.uniform1i(this.addr,r),i[0]=r),t.setTexture2DArray(e||Hp,r)}function nS(n){switch(n){case 5126:return Bb;case 35664:return Ob;case 35665:return kb;case 35666:return zb;case 35674:return Vb;case 35675:return Hb;case 35676:return Gb;case 5124:case 35670:return Wb;case 35667:case 35671:return $b;case 35668:case 35672:return Xb;case 35669:case 35673:return qb;case 5125:return Yb;case 36294:return Kb;case 36295:return Zb;case 36296:return Jb;case 35678:case 36198:case 36298:case 36306:case 35682:return Qb;case 35679:case 36299:case 36307:return jb;case 35680:case 36300:case 36308:case 36293:return eS;case 36289:case 36303:case 36311:case 36292:return tS}}function iS(n,e){n.uniform1fv(this.addr,e)}function rS(n,e){const t=ns(e,this.size,2);n.uniform2fv(this.addr,t)}function sS(n,e){const t=ns(e,this.size,3);n.uniform3fv(this.addr,t)}function aS(n,e){const t=ns(e,this.size,4);n.uniform4fv(this.addr,t)}function oS(n,e){const t=ns(e,this.size,4);n.uniformMatrix2fv(this.addr,!1,t)}function lS(n,e){const t=ns(e,this.size,9);n.uniformMatrix3fv(this.addr,!1,t)}function cS(n,e){const t=ns(e,this.size,16);n.uniformMatrix4fv(this.addr,!1,t)}function uS(n,e){n.uniform1iv(this.addr,e)}function fS(n,e){n.uniform2iv(this.addr,e)}function dS(n,e){n.uniform3iv(this.addr,e)}function hS(n,e){n.uniform4iv(this.addr,e)}function pS(n,e){n.uniform1uiv(this.addr,e)}function mS(n,e){n.uniform2uiv(this.addr,e)}function gS(n,e){n.uniform3uiv(this.addr,e)}function _S(n,e){n.uniform4uiv(this.addr,e)}function vS(n,e,t){const i=this.cache,r=e.length,s=Oo(t,r);$t(i,s)||(n.uniform1iv(this.addr,s),Xt(i,s));let a;this.type===n.SAMPLER_2D_SHADOW?a=Wc:a=Vp;for(let o=0;o!==r;++o)t.setTexture2D(e[o]||a,s[o])}function xS(n,e,t){const i=this.cache,r=e.length,s=Oo(t,r);$t(i,s)||(n.uniform1iv(this.addr,s),Xt(i,s));for(let a=0;a!==r;++a)t.setTexture3D(e[a]||Gp,s[a])}function yS(n,e,t){const i=this.cache,r=e.length,s=Oo(t,r);$t(i,s)||(n.uniform1iv(this.addr,s),Xt(i,s));for(let a=0;a!==r;++a)t.setTextureCube(e[a]||Wp,s[a])}function bS(n,e,t){const i=this.cache,r=e.length,s=Oo(t,r);$t(i,s)||(n.uniform1iv(this.addr,s),Xt(i,s));for(let a=0;a!==r;++a)t.setTexture2DArray(e[a]||Hp,s[a])}function SS(n){switch(n){case 5126:return iS;case 35664:return rS;case 35665:return sS;case 35666:return aS;case 35674:return oS;case 35675:return lS;case 35676:return cS;case 5124:case 35670:return uS;case 35667:case 35671:return fS;case 35668:case 35672:return dS;case 35669:case 35673:return hS;case 5125:return pS;case 36294:return mS;case 36295:return gS;case 36296:return _S;case 35678:case 36198:case 36298:case 36306:case 35682:return vS;case 35679:case 36299:case 36307:return xS;case 35680:case 36300:case 36308:case 36293:return yS;case 36289:case 36303:case 36311:case 36292:return bS}}class MS{constructor(e,t,i){this.id=e,this.addr=i,this.cache=[],this.type=t.type,this.setValue=nS(t.type)}}class wS{constructor(e,t,i){this.id=e,this.addr=i,this.cache=[],this.type=t.type,this.size=t.size,this.setValue=SS(t.type)}}class ES{constructor(e){this.id=e,this.seq=[],this.map={}}setValue(e,t,i){const r=this.seq;for(let s=0,a=r.length;s!==a;++s){const o=r[s];o.setValue(e,t[o.id],i)}}}const Tl=/(\w+)(\])?(\[|\.)?/g;function cd(n,e){n.seq.push(e),n.map[e.id]=e}function TS(n,e,t){const i=n.name,r=i.length;for(Tl.lastIndex=0;;){const s=Tl.exec(i),a=Tl.lastIndex;let o=s[1];const l=s[2]==="]",c=s[3];if(l&&(o=o|0),c===void 0||c==="["&&a+2===r){cd(t,c===void 0?new MS(o,n,e):new wS(o,n,e));break}else{let d=t.map[o];d===void 0&&(d=new ES(o),cd(t,d)),t=d}}}class ro{constructor(e,t){this.seq=[],this.map={};const i=e.getProgramParameter(t,e.ACTIVE_UNIFORMS);for(let a=0;a<i;++a){const o=e.getActiveUniform(t,a),l=e.getUniformLocation(t,o.name);TS(o,l,this)}const r=[],s=[];for(const a of this.seq)a.type===e.SAMPLER_2D_SHADOW||a.type===e.SAMPLER_CUBE_SHADOW||a.type===e.SAMPLER_2D_ARRAY_SHADOW?r.push(a):s.push(a);r.length>0&&(this.seq=r.concat(s))}setValue(e,t,i,r){const s=this.map[t];s!==void 0&&s.setValue(e,i,r)}setOptional(e,t,i){const r=t[i];r!==void 0&&this.setValue(e,i,r)}static upload(e,t,i,r){for(let s=0,a=t.length;s!==a;++s){const o=t[s],l=i[o.id];l.needsUpdate!==!1&&o.setValue(e,l.value,r)}}static seqWithValue(e,t){const i=[];for(let r=0,s=e.length;r!==s;++r){const a=e[r];a.id in t&&i.push(a)}return i}}function ud(n,e,t){const i=n.createShader(e);return n.shaderSource(i,t),n.compileShader(i),i}const AS=37297;let RS=0;function CS(n,e){const t=n.split(`
`),i=[],r=Math.max(e-6,0),s=Math.min(e+6,t.length);for(let a=r;a<s;a++){const o=a+1;i.push(`${o===e?">":" "} ${o}: ${t[a]}`)}return i.join(`
`)}const fd=new We;function PS(n){at._getMatrix(fd,at.workingColorSpace,n);const e=`mat3( ${fd.elements.map(t=>t.toFixed(4))} )`;switch(at.getTransfer(n)){case So:return[e,"LinearTransferOETF"];case mt:return[e,"sRGBTransferOETF"];default:return ze("WebGLProgram: Unsupported color space: ",n),[e,"LinearTransferOETF"]}}function dd(n,e,t){const i=n.getShaderParameter(e,n.COMPILE_STATUS),s=(n.getShaderInfoLog(e)||"").trim();if(i&&s==="")return"";const a=/ERROR: 0:(\d+)/.exec(s);if(a){const o=parseInt(a[1]);return t.toUpperCase()+`

`+s+`

`+CS(n.getShaderSource(e),o)}else return s}function LS(n,e){const t=PS(e);return[`vec4 ${n}( vec4 value ) {`,`	return ${t[1]}( vec4( value.rgb * ${t[0]}, value.a ) );`,"}"].join(`
`)}const DS={[op]:"Linear",[lp]:"Reinhard",[cp]:"Cineon",[up]:"ACESFilmic",[dp]:"AgX",[hp]:"Neutral",[fp]:"Custom"};function NS(n,e){const t=DS[e];return t===void 0?(ze("WebGLProgram: Unsupported toneMapping:",e),"vec3 "+n+"( vec3 color ) { return LinearToneMapping( color ); }"):"vec3 "+n+"( vec3 color ) { return "+t+"ToneMapping( color ); }"}const Ta=new U;function IS(){at.getLuminanceCoefficients(Ta);const n=Ta.x.toFixed(4),e=Ta.y.toFixed(4),t=Ta.z.toFixed(4);return["float luminance( const in vec3 rgb ) {",`	const vec3 weights = vec3( ${n}, ${e}, ${t} );`,"	return dot( weights, rgb );","}"].join(`
`)}function US(n){return[n.extensionClipCullDistance?"#extension GL_ANGLE_clip_cull_distance : require":"",n.extensionMultiDraw?"#extension GL_ANGLE_multi_draw : require":""].filter(Es).join(`
`)}function FS(n){const e=[];for(const t in n){const i=n[t];i!==!1&&e.push("#define "+t+" "+i)}return e.join(`
`)}function BS(n,e){const t={},i=n.getProgramParameter(e,n.ACTIVE_ATTRIBUTES);for(let r=0;r<i;r++){const s=n.getActiveAttrib(e,r),a=s.name;let o=1;s.type===n.FLOAT_MAT2&&(o=2),s.type===n.FLOAT_MAT3&&(o=3),s.type===n.FLOAT_MAT4&&(o=4),t[a]={type:s.type,location:n.getAttribLocation(e,a),locationSize:o}}return t}function Es(n){return n!==""}function hd(n,e){const t=e.numSpotLightShadows+e.numSpotLightMaps-e.numSpotLightShadowsWithMaps;return n.replace(/NUM_SUN_LIGHTS/g,e.numSunLights).replace(/NUM_DIR_LIGHTS/g,e.numDirLights).replace(/NUM_SPOT_LIGHTS/g,e.numSpotLights).replace(/NUM_SPOT_LIGHT_MAPS/g,e.numSpotLightMaps).replace(/NUM_SPOT_LIGHT_COORDS/g,t).replace(/NUM_RECT_AREA_LIGHTS/g,e.numRectAreaLights).replace(/NUM_POINT_LIGHTS/g,e.numPointLights).replace(/NUM_HEMI_LIGHTS/g,e.numHemiLights).replace(/NUM_SUN_LIGHT_SHADOWS/g,e.numSunLightShadows).replace(/NUM_DIR_LIGHT_SHADOWS/g,e.numDirLightShadows).replace(/NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS/g,e.numSpotLightShadowsWithMaps).replace(/NUM_SPOT_LIGHT_SHADOWS/g,e.numSpotLightShadows).replace(/NUM_POINT_LIGHT_SHADOWS/g,e.numPointLightShadows)}function pd(n,e){return n.replace(/NUM_CLIPPING_PLANES/g,e.numClippingPlanes).replace(/UNION_CLIPPING_PLANES/g,e.numClippingPlanes-e.numClipIntersection)}const OS=/^[ \t]*#include +<([\w\d./]+)>/gm;function $c(n){return n.replace(OS,zS)}const kS=new Map;function zS(n,e){let t=Qe[e];if(t===void 0){const i=kS.get(e);if(i!==void 0)t=Qe[i],ze('WebGLRenderer: Shader chunk "%s" has been deprecated. Use "%s" instead.',e,i);else throw new Error("THREE.WebGLProgram: Can not resolve #include <"+e+">")}return $c(t)}const VS=/#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;function md(n){return n.replace(VS,HS)}function HS(n,e,t,i){let r="";for(let s=parseInt(e);s<parseInt(t);s++)r+=i.replace(/\[\s*i\s*\]/g,"[ "+s+" ]").replace(/UNROLLED_LOOP_INDEX/g,s);return r}function gd(n){let e=`precision ${n.precision} float;
	precision ${n.precision} int;
	precision ${n.precision} sampler2D;
	precision ${n.precision} samplerCube;
	precision ${n.precision} sampler3D;
	precision ${n.precision} sampler2DArray;
	precision ${n.precision} sampler2DShadow;
	precision ${n.precision} samplerCubeShadow;
	precision ${n.precision} sampler2DArrayShadow;
	precision ${n.precision} isampler2D;
	precision ${n.precision} isampler3D;
	precision ${n.precision} isamplerCube;
	precision ${n.precision} isampler2DArray;
	precision ${n.precision} usampler2D;
	precision ${n.precision} usampler3D;
	precision ${n.precision} usamplerCube;
	precision ${n.precision} usampler2DArray;
	`;return n.precision==="highp"?e+=`
#define HIGH_PRECISION`:n.precision==="mediump"?e+=`
#define MEDIUM_PRECISION`:n.precision==="lowp"&&(e+=`
#define LOW_PRECISION`),e}const GS={[ja]:"SHADOWMAP_TYPE_PCF",[ws]:"SHADOWMAP_TYPE_VSM"};function WS(n){return GS[n.shadowMapType]||"SHADOWMAP_TYPE_BASIC"}const $S={[pr]:"ENVMAP_TYPE_CUBE",[Qr]:"ENVMAP_TYPE_CUBE",[Io]:"ENVMAP_TYPE_CUBE_UV"};function XS(n){return n.envMap===!1?"ENVMAP_TYPE_CUBE":$S[n.envMapMode]||"ENVMAP_TYPE_CUBE"}const qS={[Qr]:"ENVMAP_MODE_REFRACTION"};function YS(n){return n.envMap===!1?"ENVMAP_MODE_REFLECTION":qS[n.envMapMode]||"ENVMAP_MODE_REFLECTION"}const KS={[ap]:"ENVMAP_BLENDING_MULTIPLY",[d_]:"ENVMAP_BLENDING_MIX",[h_]:"ENVMAP_BLENDING_ADD"};function ZS(n){return n.envMap===!1?"ENVMAP_BLENDING_NONE":KS[n.combine]||"ENVMAP_BLENDING_NONE"}function JS(n){const e=n.envMapCubeUVHeight;if(e===null)return null;const t=Math.log2(e)-2,i=1/e;return{texelWidth:1/(3*Math.max(Math.pow(2,t),112)),texelHeight:i,maxMip:t}}function QS(n,e,t,i){const r=n.getContext(),s=t.defines;let a=t.vertexShader,o=t.fragmentShader;const l=WS(t),c=XS(t),f=YS(t),d=ZS(t),u=JS(t),h=US(t),_=FS(s),g=r.createProgram();let p,m,v=t.glslVersion?"#version "+t.glslVersion+`
`:"";t.isRawShaderMaterial?(p=["#define SHADER_TYPE "+t.shaderType,"#define SHADER_NAME "+t.shaderName,_].filter(Es).join(`
`),p.length>0&&(p+=`
`),m=["#define SHADER_TYPE "+t.shaderType,"#define SHADER_NAME "+t.shaderName,_].filter(Es).join(`
`),m.length>0&&(m+=`
`)):(p=[gd(t),"#define SHADER_TYPE "+t.shaderType,"#define SHADER_NAME "+t.shaderName,_,t.extensionClipCullDistance?"#define USE_CLIP_DISTANCE":"",t.batching?"#define USE_BATCHING":"",t.batchingColor?"#define USE_BATCHING_COLOR":"",t.instancing?"#define USE_INSTANCING":"",t.instancingColor?"#define USE_INSTANCING_COLOR":"",t.instancingMorph?"#define USE_INSTANCING_MORPH":"",t.useFog&&t.fog?"#define USE_FOG":"",t.useFog&&t.fogExp2?"#define FOG_EXP2":"",t.map?"#define USE_MAP":"",t.envMap?"#define USE_ENVMAP":"",t.envMap?"#define "+f:"",t.lightMap?"#define USE_LIGHTMAP":"",t.aoMap?"#define USE_AOMAP":"",t.bumpMap?"#define USE_BUMPMAP":"",t.normalMap?"#define USE_NORMALMAP":"",t.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",t.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",t.displacementMap?"#define USE_DISPLACEMENTMAP":"",t.emissiveMap?"#define USE_EMISSIVEMAP":"",t.anisotropy?"#define USE_ANISOTROPY":"",t.anisotropyMap?"#define USE_ANISOTROPYMAP":"",t.clearcoatMap?"#define USE_CLEARCOATMAP":"",t.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",t.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",t.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",t.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",t.specularMap?"#define USE_SPECULARMAP":"",t.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",t.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",t.roughnessMap?"#define USE_ROUGHNESSMAP":"",t.metalnessMap?"#define USE_METALNESSMAP":"",t.alphaMap?"#define USE_ALPHAMAP":"",t.alphaHash?"#define USE_ALPHAHASH":"",t.transmission?"#define USE_TRANSMISSION":"",t.transmissionMap?"#define USE_TRANSMISSIONMAP":"",t.thicknessMap?"#define USE_THICKNESSMAP":"",t.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",t.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",t.mapUv?"#define MAP_UV "+t.mapUv:"",t.alphaMapUv?"#define ALPHAMAP_UV "+t.alphaMapUv:"",t.lightMapUv?"#define LIGHTMAP_UV "+t.lightMapUv:"",t.aoMapUv?"#define AOMAP_UV "+t.aoMapUv:"",t.emissiveMapUv?"#define EMISSIVEMAP_UV "+t.emissiveMapUv:"",t.bumpMapUv?"#define BUMPMAP_UV "+t.bumpMapUv:"",t.normalMapUv?"#define NORMALMAP_UV "+t.normalMapUv:"",t.displacementMapUv?"#define DISPLACEMENTMAP_UV "+t.displacementMapUv:"",t.metalnessMapUv?"#define METALNESSMAP_UV "+t.metalnessMapUv:"",t.roughnessMapUv?"#define ROUGHNESSMAP_UV "+t.roughnessMapUv:"",t.anisotropyMapUv?"#define ANISOTROPYMAP_UV "+t.anisotropyMapUv:"",t.clearcoatMapUv?"#define CLEARCOATMAP_UV "+t.clearcoatMapUv:"",t.clearcoatNormalMapUv?"#define CLEARCOAT_NORMALMAP_UV "+t.clearcoatNormalMapUv:"",t.clearcoatRoughnessMapUv?"#define CLEARCOAT_ROUGHNESSMAP_UV "+t.clearcoatRoughnessMapUv:"",t.iridescenceMapUv?"#define IRIDESCENCEMAP_UV "+t.iridescenceMapUv:"",t.iridescenceThicknessMapUv?"#define IRIDESCENCE_THICKNESSMAP_UV "+t.iridescenceThicknessMapUv:"",t.sheenColorMapUv?"#define SHEEN_COLORMAP_UV "+t.sheenColorMapUv:"",t.sheenRoughnessMapUv?"#define SHEEN_ROUGHNESSMAP_UV "+t.sheenRoughnessMapUv:"",t.specularMapUv?"#define SPECULARMAP_UV "+t.specularMapUv:"",t.specularColorMapUv?"#define SPECULAR_COLORMAP_UV "+t.specularColorMapUv:"",t.specularIntensityMapUv?"#define SPECULAR_INTENSITYMAP_UV "+t.specularIntensityMapUv:"",t.transmissionMapUv?"#define TRANSMISSIONMAP_UV "+t.transmissionMapUv:"",t.thicknessMapUv?"#define THICKNESSMAP_UV "+t.thicknessMapUv:"",t.vertexTangents&&t.flatShading===!1?"#define USE_TANGENT":"",t.vertexNormals?"#define HAS_NORMAL":"",t.vertexColors?"#define USE_COLOR":"",t.vertexAlphas?"#define USE_COLOR_ALPHA":"",t.vertexUv1s?"#define USE_UV1":"",t.vertexUv2s?"#define USE_UV2":"",t.vertexUv3s?"#define USE_UV3":"",t.pointsUvs?"#define USE_POINTS_UV":"",t.flatShading?"#define FLAT_SHADED":"",t.skinning?"#define USE_SKINNING":"",t.morphTargets?"#define USE_MORPHTARGETS":"",t.morphNormals&&t.flatShading===!1?"#define USE_MORPHNORMALS":"",t.morphColors?"#define USE_MORPHCOLORS":"",t.morphTargetsCount>0?"#define MORPHTARGETS_TEXTURE_STRIDE "+t.morphTextureStride:"",t.morphTargetsCount>0?"#define MORPHTARGETS_COUNT "+t.morphTargetsCount:"",t.doubleSided?"#define DOUBLE_SIDED":"",t.flipSided?"#define FLIP_SIDED":"",t.shadowMapEnabled?"#define USE_SHADOWMAP":"",t.shadowMapEnabled?"#define "+l:"",t.sizeAttenuation?"#define USE_SIZEATTENUATION":"",t.numLightProbes>0?"#define USE_LIGHT_PROBES":"",t.logarithmicDepthBuffer?"#define USE_LOGARITHMIC_DEPTH_BUFFER":"",t.reversedDepthBuffer?"#define USE_REVERSED_DEPTH_BUFFER":"","uniform mat4 modelMatrix;","uniform mat4 modelViewMatrix;","uniform mat4 projectionMatrix;","uniform mat4 viewMatrix;","uniform mat3 normalMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;","#ifdef USE_INSTANCING","	attribute mat4 instanceMatrix;","#endif","#ifdef USE_INSTANCING_COLOR","	attribute vec3 instanceColor;","#endif","#ifdef USE_INSTANCING_MORPH","	uniform sampler2D morphTexture;","#endif","attribute vec3 position;","attribute vec3 normal;","attribute vec2 uv;","#ifdef USE_UV1","	attribute vec2 uv1;","#endif","#ifdef USE_UV2","	attribute vec2 uv2;","#endif","#ifdef USE_UV3","	attribute vec2 uv3;","#endif","#ifdef USE_TANGENT","	attribute vec4 tangent;","#endif","#if defined( USE_COLOR_ALPHA )","	attribute vec4 color;","#elif defined( USE_COLOR )","	attribute vec3 color;","#endif","#ifdef USE_SKINNING","	attribute vec4 skinIndex;","	attribute vec4 skinWeight;","#endif",`
`].filter(Es).join(`
`),m=[gd(t),"#define SHADER_TYPE "+t.shaderType,"#define SHADER_NAME "+t.shaderName,_,t.useFog&&t.fog?"#define USE_FOG":"",t.useFog&&t.fogExp2?"#define FOG_EXP2":"",t.alphaToCoverage?"#define ALPHA_TO_COVERAGE":"",t.map?"#define USE_MAP":"",t.matcap?"#define USE_MATCAP":"",t.envMap?"#define USE_ENVMAP":"",t.envMap?"#define "+c:"",t.envMap?"#define "+f:"",t.envMap?"#define "+d:"",u?"#define CUBEUV_TEXEL_WIDTH "+u.texelWidth:"",u?"#define CUBEUV_TEXEL_HEIGHT "+u.texelHeight:"",u?"#define CUBEUV_MAX_MIP "+u.maxMip+".0":"",t.lightMap?"#define USE_LIGHTMAP":"",t.aoMap?"#define USE_AOMAP":"",t.bumpMap?"#define USE_BUMPMAP":"",t.normalMap?"#define USE_NORMALMAP":"",t.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",t.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",t.packedNormalMap?"#define USE_PACKED_NORMALMAP":"",t.emissiveMap?"#define USE_EMISSIVEMAP":"",t.anisotropy?"#define USE_ANISOTROPY":"",t.anisotropyMap?"#define USE_ANISOTROPYMAP":"",t.clearcoat?"#define USE_CLEARCOAT":"",t.clearcoatMap?"#define USE_CLEARCOATMAP":"",t.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",t.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",t.dispersion?"#define USE_DISPERSION":"",t.retroreflection?"#define USE_RETROREFLECTION":"",t.iridescence?"#define USE_IRIDESCENCE":"",t.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",t.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",t.specularMap?"#define USE_SPECULARMAP":"",t.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",t.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",t.roughnessMap?"#define USE_ROUGHNESSMAP":"",t.metalnessMap?"#define USE_METALNESSMAP":"",t.alphaMap?"#define USE_ALPHAMAP":"",t.alphaTest?"#define USE_ALPHATEST":"",t.alphaHash?"#define USE_ALPHAHASH":"",t.sheen?"#define USE_SHEEN":"",t.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",t.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",t.transmission?"#define USE_TRANSMISSION":"",t.transmissionMap?"#define USE_TRANSMISSIONMAP":"",t.thicknessMap?"#define USE_THICKNESSMAP":"",t.vertexTangents&&t.flatShading===!1?"#define USE_TANGENT":"",t.vertexColors||t.instancingColor?"#define USE_COLOR":"",t.vertexAlphas||t.batchingColor?"#define USE_COLOR_ALPHA":"",t.vertexUv1s?"#define USE_UV1":"",t.vertexUv2s?"#define USE_UV2":"",t.vertexUv3s?"#define USE_UV3":"",t.pointsUvs?"#define USE_POINTS_UV":"",t.gradientMap?"#define USE_GRADIENTMAP":"",t.flatShading?"#define FLAT_SHADED":"",t.doubleSided?"#define DOUBLE_SIDED":"",t.flipSided?"#define FLIP_SIDED":"",t.shadowMapEnabled?"#define USE_SHADOWMAP":"",t.shadowMapEnabled?"#define "+l:"",t.premultipliedAlpha?"#define PREMULTIPLIED_ALPHA":"",t.numLightProbes>0?"#define USE_LIGHT_PROBES":"",t.numLightProbeGrids>0?"#define USE_LIGHT_PROBES_GRID":"",t.decodeVideoTexture?"#define DECODE_VIDEO_TEXTURE":"",t.decodeVideoTextureEmissive?"#define DECODE_VIDEO_TEXTURE_EMISSIVE":"",t.logarithmicDepthBuffer?"#define USE_LOGARITHMIC_DEPTH_BUFFER":"",t.reversedDepthBuffer?"#define USE_REVERSED_DEPTH_BUFFER":"","uniform mat4 viewMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;",t.toneMapping!==oi?"#define TONE_MAPPING":"",t.toneMapping!==oi?Qe.tonemapping_pars_fragment:"",t.toneMapping!==oi?NS("toneMapping",t.toneMapping):"",t.dithering?"#define DITHERING":"",t.opaque?"#define OPAQUE":"",Qe.colorspace_pars_fragment,LS("linearToOutputTexel",t.outputColorSpace),IS(),t.useDepthPacking?"#define DEPTH_PACKING "+t.depthPacking:"",`
`].filter(Es).join(`
`)),a=$c(a),a=hd(a,t),a=pd(a,t),o=$c(o),o=hd(o,t),o=pd(o,t),a=md(a),o=md(o),t.isRawShaderMaterial!==!0&&(v=`#version 300 es
`,p=[h,"#define attribute in","#define varying out","#define texture2D texture"].join(`
`)+`
`+p,m=["#define varying in",t.glslVersion===Tf?"":"layout(location = 0) out highp vec4 pc_fragColor;",t.glslVersion===Tf?"":"#define gl_FragColor pc_fragColor","#define gl_FragDepthEXT gl_FragDepth","#define texture2D texture","#define textureCube texture","#define texture2DProj textureProj","#define texture2DLodEXT textureLod","#define texture2DProjLodEXT textureProjLod","#define textureCubeLodEXT textureLod","#define texture2DGradEXT textureGrad","#define texture2DProjGradEXT textureProjGrad","#define textureCubeGradEXT textureGrad"].join(`
`)+`
`+m);const w=v+p+a,y=v+m+o,S=ud(r,r.VERTEX_SHADER,w),M=ud(r,r.FRAGMENT_SHADER,y);r.attachShader(g,S),r.attachShader(g,M),t.index0AttributeName!==void 0?r.bindAttribLocation(g,0,t.index0AttributeName):t.hasPositionAttribute===!0&&r.bindAttribLocation(g,0,"position"),r.linkProgram(g);function E(D){if(n.debug.checkShaderErrors){const R=r.getProgramInfoLog(g)||"",N=r.getShaderInfoLog(S)||"",I=r.getShaderInfoLog(M)||"",z=R.trim(),$=N.trim(),X=I.trim();let re=!0,J=!0;if(r.getProgramParameter(g,r.LINK_STATUS)===!1)if(re=!1,typeof n.debug.onShaderError=="function")n.debug.onShaderError(r,g,S,M);else{const Q=dd(r,S,"vertex"),te=dd(r,M,"fragment");ut("WebGLProgram: Shader Error "+r.getError()+" - VALIDATE_STATUS "+r.getProgramParameter(g,r.VALIDATE_STATUS)+`

Material Name: `+D.name+`
Material Type: `+D.type+`

Program Info Log: `+z+`
`+Q+`
`+te)}else z!==""?ze("WebGLProgram: Program Info Log:",z):($===""||X==="")&&(J=!1);J&&(D.diagnostics={runnable:re,programLog:z,vertexShader:{log:$,prefix:p},fragmentShader:{log:X,prefix:m}})}r.deleteShader(S),r.deleteShader(M),b=new ro(r,g),T=BS(r,g)}let b;this.getUniforms=function(){return b===void 0&&E(this),b};let T;this.getAttributes=function(){return T===void 0&&E(this),T};let C=t.rendererExtensionParallelShaderCompile===!1;return this.isReady=function(){return C===!1&&(C=r.getProgramParameter(g,AS)),C},this.destroy=function(){i.releaseStatesOfProgram(this),r.deleteProgram(g),this.program=void 0},this.type=t.shaderType,this.name=t.shaderName,this.id=RS++,this.cacheKey=e,this.usedTimes=1,this.program=g,this.vertexShader=S,this.fragmentShader=M,this}let jS=0;class eM{constructor(){this.shaderCache=new Map,this.materialCache=new Map}update(e,t,i){const r=this._getShaderCacheForMaterial(e);return r.has(t)===!1&&(r.add(t),t.usedTimes++),r.has(i)===!1&&(r.add(i),i.usedTimes++),this}remove(e){const t=this.materialCache.get(e);for(const i of t)i.usedTimes--,i.usedTimes===0&&this.shaderCache.delete(i.code);return this.materialCache.delete(e),this}getVertexShaderStage(e){return this._getShaderStage(e.vertexShader)}getFragmentShaderStage(e){return this._getShaderStage(e.fragmentShader)}dispose(){this.shaderCache.clear(),this.materialCache.clear()}_getShaderCacheForMaterial(e){const t=this.materialCache;let i=t.get(e);return i===void 0&&(i=new Set,t.set(e,i)),i}_getShaderStage(e){const t=this.shaderCache;let i=t.get(e);return i===void 0&&(i=new tM(e),t.set(e,i)),i}}class tM{constructor(e){this.id=jS++,this.code=e,this.usedTimes=0}}function nM(n){return n===mr||n===xo||n===yo}function iM(n,e,t,i,r,s){const a=new Tp,o=new eM,l=new Set,c=[],f=new Map,d=i.logarithmicDepthBuffer;let u=i.precision;const h={MeshDepthMaterial:"depth",MeshDistanceMaterial:"distance",MeshNormalMaterial:"normal",MeshBasicMaterial:"basic",MeshLambertMaterial:"lambert",MeshPhongMaterial:"phong",MeshToonMaterial:"toon",MeshStandardMaterial:"physical",MeshPhysicalMaterial:"physical",MeshMatcapMaterial:"matcap",LineBasicMaterial:"basic",LineDashedMaterial:"dashed",PointsMaterial:"points",ShadowMaterial:"shadow",SpriteMaterial:"sprite"};function _(b){return l.add(b),b===0?"uv":`uv${b}`}function g(b,T,C,D,R,N){const I=D.fog,z=R.geometry,$=b.isMeshStandardMaterial||b.isMeshLambertMaterial||b.isMeshPhongMaterial?D.environment:null,X=b.isMeshStandardMaterial||b.isMeshLambertMaterial&&!b.envMap||b.isMeshPhongMaterial&&!b.envMap,re=e.get(b.envMap||$,X),J=re&&re.mapping===Io?re.image.height:null,Q=h[b.type];b.precision!==null&&(u=i.getMaxPrecision(b.precision),u!==b.precision&&ze("WebGLProgram.getParameters:",b.precision,"not supported, using",u,"instead."));const te=z.morphAttributes.position||z.morphAttributes.normal||z.morphAttributes.color,ue=te!==void 0?te.length:0;let be=0;z.morphAttributes.position!==void 0&&(be=1),z.morphAttributes.normal!==void 0&&(be=2),z.morphAttributes.color!==void 0&&(be=3);let Fe,Re,je,ne;if(Q){const pt=Sn[Q];Fe=pt.vertexShader,Re=pt.fragmentShader}else{Fe=b.vertexShader,Re=b.fragmentShader;const pt=o.getVertexShaderStage(b),lt=o.getFragmentShaderStage(b);o.update(b,pt,lt),je=pt.id,ne=lt.id}const ae=n.getRenderTarget(),Me=n.state.buffers.depth.getReversed(),Be=R.isInstancedMesh===!0,ve=R.isBatchedMesh===!0,ke=!!b.map,Pt=!!b.matcap,$e=!!re,Ke=!!b.aoMap,rt=!!b.lightMap,qe=!!b.bumpMap&&b.wireframe===!1,ot=!!b.normalMap,Dt=!!b.displacementMap,Tt=!!b.emissiveMap,vt=!!b.metalnessMap,At=!!b.roughnessMap,V=b.anisotropy>0,Nt=b.clearcoat>0,nt=b.dispersion>0,A=b.retroreflectivity>0,x=b.iridescence>0,L=b.sheen>0,F=b.transmission>0,B=V&&!!b.anisotropyMap,q=Nt&&!!b.clearcoatMap,oe=Nt&&!!b.clearcoatNormalMap,j=Nt&&!!b.clearcoatRoughnessMap,W=x&&!!b.iridescenceMap,ce=x&&!!b.iridescenceThicknessMap,fe=L&&!!b.sheenColorMap,me=L&&!!b.sheenRoughnessMap,de=!!b.specularMap,De=!!b.specularColorMap,Ue=!!b.specularIntensityMap,Ve=F&&!!b.transmissionMap,G=F&&!!b.thicknessMap,pe=!!b.gradientMap,se=!!b.alphaMap,ge=b.alphaTest>0,xe=!!b.alphaHash,le=!!b.extensions;let Ne=oi;b.toneMapped&&(ae===null||ae.isXRRenderTarget===!0)&&(Ne=n.toneMapping);const Te={shaderID:Q,shaderType:b.type,shaderName:b.name,vertexShader:Fe,fragmentShader:Re,defines:b.defines,customVertexShaderID:je,customFragmentShaderID:ne,isRawShaderMaterial:b.isRawShaderMaterial===!0,glslVersion:b.glslVersion,precision:u,batching:ve,batchingColor:ve&&R._colorsTexture!==null,instancing:Be,instancingColor:Be&&R.instanceColor!==null,instancingMorph:Be&&R.morphTexture!==null,outputColorSpace:ae===null?n.outputColorSpace:ae.isXRRenderTarget===!0?ae.texture.colorSpace:at.workingColorSpace,alphaToCoverage:!!b.alphaToCoverage,map:ke,matcap:Pt,envMap:$e,envMapMode:$e&&re.mapping,envMapCubeUVHeight:J,aoMap:Ke,lightMap:rt,bumpMap:qe,normalMap:ot,displacementMap:Dt,emissiveMap:Tt,normalMapObjectSpace:ot&&b.normalMapType===g_,normalMapTangentSpace:ot&&b.normalMapType===Ef,packedNormalMap:ot&&b.normalMapType===Ef&&nM(b.normalMap.format),metalnessMap:vt,roughnessMap:At,anisotropy:V,anisotropyMap:B,clearcoat:Nt,clearcoatMap:q,clearcoatNormalMap:oe,clearcoatRoughnessMap:j,dispersion:nt,retroreflection:A,iridescence:x,iridescenceMap:W,iridescenceThicknessMap:ce,sheen:L,sheenColorMap:fe,sheenRoughnessMap:me,specularMap:de,specularColorMap:De,specularIntensityMap:Ue,transmission:F,transmissionMap:Ve,thicknessMap:G,gradientMap:pe,opaque:b.transparent===!1&&b.blending===Rs&&b.alphaToCoverage===!1,alphaMap:se,alphaTest:ge,alphaHash:xe,combine:b.combine,mapUv:ke&&_(b.map.channel),aoMapUv:Ke&&_(b.aoMap.channel),lightMapUv:rt&&_(b.lightMap.channel),bumpMapUv:qe&&_(b.bumpMap.channel),normalMapUv:ot&&_(b.normalMap.channel),displacementMapUv:Dt&&_(b.displacementMap.channel),emissiveMapUv:Tt&&_(b.emissiveMap.channel),metalnessMapUv:vt&&_(b.metalnessMap.channel),roughnessMapUv:At&&_(b.roughnessMap.channel),anisotropyMapUv:B&&_(b.anisotropyMap.channel),clearcoatMapUv:q&&_(b.clearcoatMap.channel),clearcoatNormalMapUv:oe&&_(b.clearcoatNormalMap.channel),clearcoatRoughnessMapUv:j&&_(b.clearcoatRoughnessMap.channel),iridescenceMapUv:W&&_(b.iridescenceMap.channel),iridescenceThicknessMapUv:ce&&_(b.iridescenceThicknessMap.channel),sheenColorMapUv:fe&&_(b.sheenColorMap.channel),sheenRoughnessMapUv:me&&_(b.sheenRoughnessMap.channel),specularMapUv:de&&_(b.specularMap.channel),specularColorMapUv:De&&_(b.specularColorMap.channel),specularIntensityMapUv:Ue&&_(b.specularIntensityMap.channel),transmissionMapUv:Ve&&_(b.transmissionMap.channel),thicknessMapUv:G&&_(b.thicknessMap.channel),alphaMapUv:se&&_(b.alphaMap.channel),vertexTangents:!!z.attributes.tangent&&(ot||V),vertexNormals:!!z.attributes.normal,vertexColors:b.vertexColors,vertexAlphas:b.vertexColors===!0&&!!z.attributes.color&&z.attributes.color.itemSize===4,pointsUvs:R.isPoints===!0&&!!z.attributes.uv&&(ke||se),fog:!!I,useFog:b.fog===!0,fogExp2:!!I&&I.isFogExp2,flatShading:b.wireframe===!1&&(b.flatShading===!0||z.attributes.normal===void 0&&ot===!1&&(b.isMeshLambertMaterial||b.isMeshPhongMaterial||b.isMeshStandardMaterial||b.isMeshPhysicalMaterial)),sizeAttenuation:b.sizeAttenuation===!0,logarithmicDepthBuffer:d,reversedDepthBuffer:Me,skinning:R.isSkinnedMesh===!0,hasPositionAttribute:z.attributes.position!==void 0,morphTargets:z.morphAttributes.position!==void 0,morphNormals:z.morphAttributes.normal!==void 0,morphColors:z.morphAttributes.color!==void 0,morphTargetsCount:ue,morphTextureStride:be,numSunLights:T.sun.length,numDirLights:T.directional.length,numPointLights:T.point.length,numSpotLights:T.spot.length,numSpotLightMaps:T.spotLightMap.length,numRectAreaLights:T.rectArea.length,numHemiLights:T.hemi.length,numSunLightShadows:T.sunShadowMap.length,numDirLightShadows:T.directionalShadowMap.length,numPointLightShadows:T.pointShadowMap.length,numSpotLightShadows:T.spotShadowMap.length,numSpotLightShadowsWithMaps:T.numSpotLightShadowsWithMaps,numLightProbes:T.numLightProbes,numLightProbeGrids:N.length,numClippingPlanes:s.numPlanes,numClipIntersection:s.numIntersection,dithering:b.dithering,shadowMapEnabled:n.shadowMap.enabled&&C.length>0,shadowMapType:n.shadowMap.type,toneMapping:Ne,decodeVideoTexture:ke&&b.map.isVideoTexture===!0&&at.getTransfer(b.map.colorSpace)===mt,decodeVideoTextureEmissive:Tt&&b.emissiveMap.isVideoTexture===!0&&at.getTransfer(b.emissiveMap.colorSpace)===mt,premultipliedAlpha:b.premultipliedAlpha,doubleSided:b.side===Mn,flipSided:b.side===fn,useDepthPacking:b.depthPacking>=0,depthPacking:b.depthPacking||0,index0AttributeName:b.index0AttributeName,extensionClipCullDistance:le&&b.extensions.clipCullDistance===!0&&t.has("WEBGL_clip_cull_distance"),extensionMultiDraw:(le&&b.extensions.multiDraw===!0||ve)&&t.has("WEBGL_multi_draw"),rendererExtensionParallelShaderCompile:t.has("KHR_parallel_shader_compile"),customProgramCacheKey:b.customProgramCacheKey()};return Te.vertexUv1s=l.has(1),Te.vertexUv2s=l.has(2),Te.vertexUv3s=l.has(3),l.clear(),Te}function p(b){const T=[];if(b.shaderID?T.push(b.shaderID):(T.push(b.customVertexShaderID),T.push(b.customFragmentShaderID)),b.defines!==void 0)for(const C in b.defines)T.push(C),T.push(b.defines[C]);return b.isRawShaderMaterial===!1&&(m(T,b),v(T,b),T.push(n.outputColorSpace)),T.push(b.customProgramCacheKey),T.join()}function m(b,T){b.push(T.precision),b.push(T.outputColorSpace),b.push(T.envMapMode),b.push(T.envMapCubeUVHeight),b.push(T.mapUv),b.push(T.alphaMapUv),b.push(T.lightMapUv),b.push(T.aoMapUv),b.push(T.bumpMapUv),b.push(T.normalMapUv),b.push(T.displacementMapUv),b.push(T.emissiveMapUv),b.push(T.metalnessMapUv),b.push(T.roughnessMapUv),b.push(T.anisotropyMapUv),b.push(T.clearcoatMapUv),b.push(T.clearcoatNormalMapUv),b.push(T.clearcoatRoughnessMapUv),b.push(T.iridescenceMapUv),b.push(T.iridescenceThicknessMapUv),b.push(T.sheenColorMapUv),b.push(T.sheenRoughnessMapUv),b.push(T.specularMapUv),b.push(T.specularColorMapUv),b.push(T.specularIntensityMapUv),b.push(T.transmissionMapUv),b.push(T.thicknessMapUv),b.push(T.combine),b.push(T.fogExp2),b.push(T.sizeAttenuation),b.push(T.morphTargetsCount),b.push(T.morphAttributeCount),b.push(T.numSunLights),b.push(T.numDirLights),b.push(T.numPointLights),b.push(T.numSpotLights),b.push(T.numSpotLightMaps),b.push(T.numHemiLights),b.push(T.numRectAreaLights),b.push(T.numSunLightShadows),b.push(T.numDirLightShadows),b.push(T.numPointLightShadows),b.push(T.numSpotLightShadows),b.push(T.numSpotLightShadowsWithMaps),b.push(T.numLightProbes),b.push(T.shadowMapType),b.push(T.toneMapping),b.push(T.numClippingPlanes),b.push(T.numClipIntersection),b.push(T.depthPacking)}function v(b,T){a.disableAll(),T.instancing&&a.enable(0),T.instancingColor&&a.enable(1),T.instancingMorph&&a.enable(2),T.matcap&&a.enable(3),T.envMap&&a.enable(4),T.normalMapObjectSpace&&a.enable(5),T.normalMapTangentSpace&&a.enable(6),T.clearcoat&&a.enable(7),T.iridescence&&a.enable(8),T.alphaTest&&a.enable(9),T.vertexColors&&a.enable(10),T.vertexAlphas&&a.enable(11),T.vertexUv1s&&a.enable(12),T.vertexUv2s&&a.enable(13),T.vertexUv3s&&a.enable(14),T.vertexTangents&&a.enable(15),T.anisotropy&&a.enable(16),T.alphaHash&&a.enable(17),T.batching&&a.enable(18),T.dispersion&&a.enable(19),T.retroreflection&&a.enable(24),T.batchingColor&&a.enable(20),T.gradientMap&&a.enable(21),T.packedNormalMap&&a.enable(22),T.vertexNormals&&a.enable(23),b.push(a.mask),a.disableAll(),T.fog&&a.enable(0),T.useFog&&a.enable(1),T.flatShading&&a.enable(2),T.logarithmicDepthBuffer&&a.enable(3),T.reversedDepthBuffer&&a.enable(4),T.skinning&&a.enable(5),T.morphTargets&&a.enable(6),T.morphNormals&&a.enable(7),T.morphColors&&a.enable(8),T.premultipliedAlpha&&a.enable(9),T.shadowMapEnabled&&a.enable(10),T.doubleSided&&a.enable(11),T.flipSided&&a.enable(12),T.useDepthPacking&&a.enable(13),T.dithering&&a.enable(14),T.transmission&&a.enable(15),T.sheen&&a.enable(16),T.opaque&&a.enable(17),T.pointsUvs&&a.enable(18),T.decodeVideoTexture&&a.enable(19),T.decodeVideoTextureEmissive&&a.enable(20),T.alphaToCoverage&&a.enable(21),T.numLightProbeGrids>0&&a.enable(22),T.hasPositionAttribute&&a.enable(23),b.push(a.mask)}function w(b){const T=h[b.type];let C;if(T){const D=Sn[T];C=Pu.clone(D.uniforms)}else C=b.uniforms;return C}function y(b,T){let C=f.get(T);return C!==void 0?++C.usedTimes:(C=new QS(n,T,b,r),c.push(C),f.set(T,C)),C}function S(b){if(--b.usedTimes===0){const T=c.indexOf(b);c[T]=c[c.length-1],c.pop(),f.delete(b.cacheKey),b.destroy()}}function M(b){o.remove(b)}function E(){o.dispose()}return{getParameters:g,getProgramCacheKey:p,getUniforms:w,acquireProgram:y,releaseProgram:S,releaseShaderCache:M,programs:c,dispose:E}}function rM(){let n=new WeakMap;function e(a){return n.has(a)}function t(a){let o=n.get(a);return o===void 0&&(o={},n.set(a,o)),o}function i(a){n.delete(a)}function r(a,o,l){n.get(a)[o]=l}function s(){n=new WeakMap}return{has:e,get:t,remove:i,update:r,dispose:s}}function sM(n,e){return n.groupOrder!==e.groupOrder?n.groupOrder-e.groupOrder:n.renderOrder!==e.renderOrder?n.renderOrder-e.renderOrder:n.material.id!==e.material.id?n.material.id-e.material.id:n.materialVariant!==e.materialVariant?n.materialVariant-e.materialVariant:n.z!==e.z?n.z-e.z:n.id-e.id}function _d(n,e){return n.groupOrder!==e.groupOrder?n.groupOrder-e.groupOrder:n.renderOrder!==e.renderOrder?n.renderOrder-e.renderOrder:n.z!==e.z?e.z-n.z:n.id-e.id}function vd(){const n=[];let e=0;const t=[],i=[],r=[];function s(){e=0,t.length=0,i.length=0,r.length=0}function a(u){let h=0;return u.isInstancedMesh&&(h+=2),u.isSkinnedMesh&&(h+=1),h}function o(u,h,_,g,p,m){let v=n[e];return v===void 0?(v={id:u.id,object:u,geometry:h,material:_,materialVariant:a(u),groupOrder:g,renderOrder:u.renderOrder,z:p,group:m},n[e]=v):(v.id=u.id,v.object=u,v.geometry=h,v.material=_,v.materialVariant=a(u),v.groupOrder=g,v.renderOrder=u.renderOrder,v.z=p,v.group=m),e++,v}function l(u,h,_,g,p,m,v){v.reversedDepth===!0&&(p=-p);const w=o(u,h,_,g,p,m);_.transmission>0?i.push(w):_.transparent===!0?r.push(w):t.push(w)}function c(u,h,_,g,p,m){const v=o(u,h,_,g,p,m);_.transmission>0?i.unshift(v):_.transparent===!0?r.unshift(v):t.unshift(v)}function f(u,h){t.length>1&&t.sort(u||sM),i.length>1&&i.sort(h||_d),r.length>1&&r.sort(h||_d)}function d(){for(let u=e,h=n.length;u<h;u++){const _=n[u];if(_.id===null)break;_.id=null,_.object=null,_.geometry=null,_.material=null,_.group=null}}return{opaque:t,transmissive:i,transparent:r,init:s,push:l,unshift:c,finish:d,sort:f}}function aM(){let n=new WeakMap;function e(i,r){const s=n.get(i);let a;return s===void 0?(a=new vd,n.set(i,[a])):r>=s.length?(a=new vd,s.push(a)):a=s[r],a}function t(){n=new WeakMap}return{get:e,dispose:t}}function oM(){const n={};return{get:function(e){if(n[e.id]!==void 0)return n[e.id];let t;switch(e.type){case"SunLight":case"DirectionalLight":t={direction:new U,color:new ft};break;case"SpotLight":t={position:new U,direction:new U,color:new ft,distance:0,coneCos:0,penumbraCos:0,decay:0};break;case"PointLight":t={position:new U,color:new ft,distance:0,decay:0};break;case"HemisphereLight":t={direction:new U,skyColor:new ft,groundColor:new ft};break;case"RectAreaLight":t={color:new ft,position:new U,halfWidth:new U,halfHeight:new U};break}return n[e.id]=t,t}}}function lM(){const n={};return{get:function(e){if(n[e.id]!==void 0)return n[e.id];let t;switch(e.type){case"SunLight":case"DirectionalLight":t={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new Ze};break;case"SpotLight":t={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new Ze};break;case"PointLight":t={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new Ze,shadowCameraNear:1,shadowCameraFar:1e3};break}return n[e.id]=t,t}}}let cM=0;function uM(n,e){return(e.castShadow?2:0)-(n.castShadow?2:0)+(e.map?1:0)-(n.map?1:0)}function fM(n){const e=new oM,t=lM(),i={version:0,hash:{sunLength:-1,directionalLength:-1,pointLength:-1,spotLength:-1,rectAreaLength:-1,hemiLength:-1,numSunShadows:-1,numDirectionalShadows:-1,numPointShadows:-1,numSpotShadows:-1,numSpotMaps:-1,numLightProbes:-1},ambient:[0,0,0],probe:[],sun:[],sunShadow:[],sunShadowMap:[],sunShadowMatrix:[],sunShadowCascade:[],directional:[],directionalShadow:[],directionalShadowMap:[],directionalShadowMatrix:[],spot:[],spotLightMap:[],spotShadow:[],spotShadowMap:[],spotLightMatrix:[],rectArea:[],rectAreaLTC1:null,rectAreaLTC2:null,point:[],pointShadow:[],pointShadowMap:[],pointShadowMatrix:[],hemi:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};for(let c=0;c<9;c++)i.probe.push(new U);const r=new U,s=new et,a=new et;function o(c){let f=0,d=0,u=0;for(let R=0;R<9;R++)i.probe[R].set(0,0,0);let h=0,_=0,g=0,p=0,m=0,v=0,w=0,y=0,S=0,M=0,E=0,b=0,T=0,C=0;c.sort(uM);for(let R=0,N=c.length;R<N;R++){const I=c[R],z=I.color,$=I.intensity,X=I.distance;let re=null;if(I.shadow&&I.shadow.map&&(I.shadow.map.texture.format===mr?re=I.shadow.map.texture:re=I.shadow.map.depthTexture||I.shadow.map.texture),I.isAmbientLight)f+=z.r*$,d+=z.g*$,u+=z.b*$;else if(I.isLightProbe){for(let J=0;J<9;J++)i.probe[J].addScaledVector(I.sh.coefficients[J],$);C++}else if(I.isSunLight){const J=e.get(I);if(J.color.copy(I.color).multiplyScalar(I.intensity),I.castShadow){const Q=I.shadow,te=t.get(I);te.shadowIntensity=Q.intensity,te.shadowBias=Q.bias,te.shadowNormalBias=Q.normalBias,te.shadowRadius=Q.radius,te.shadowMapSize.copy(Q.mapSize).multiply(Q.getFrameExtents()),i.sunShadow[_]=te,i.sunShadowMap[_]=re;const ue=Q.getViewportCount();for(let be=0;be<ue;be++)i.sunShadowMatrix[g+be]=Q.getMatrix(be),i.sunShadowCascade[g+be]=Q._cascadeData[be];g+=ue,_++}i.sun[h]=J,h++}else if(I.isDirectionalLight){const J=e.get(I);if(J.color.copy(I.color).multiplyScalar(I.intensity),I.castShadow){const Q=I.shadow,te=t.get(I);te.shadowIntensity=Q.intensity,te.shadowBias=Q.bias,te.shadowNormalBias=Q.normalBias,te.shadowRadius=Q.radius,te.shadowMapSize=Q.mapSize,i.directionalShadow[p]=te,i.directionalShadowMap[p]=re,i.directionalShadowMatrix[p]=I.shadow.matrix,S++}i.directional[p]=J,p++}else if(I.isSpotLight){const J=e.get(I);J.position.setFromMatrixPosition(I.matrixWorld),J.color.copy(z).multiplyScalar($),J.distance=X,J.coneCos=Math.cos(I.angle),J.penumbraCos=Math.cos(I.angle*(1-I.penumbra)),J.decay=I.decay,i.spot[v]=J;const Q=I.shadow;if(I.map&&(i.spotLightMap[b]=I.map,b++,Q.updateMatrices(I),I.castShadow&&T++),i.spotLightMatrix[v]=Q.matrix,I.castShadow){const te=t.get(I);te.shadowIntensity=Q.intensity,te.shadowBias=Q.bias,te.shadowNormalBias=Q.normalBias,te.shadowRadius=Q.radius,te.shadowMapSize=Q.mapSize,i.spotShadow[v]=te,i.spotShadowMap[v]=re,E++}v++}else if(I.isRectAreaLight){const J=e.get(I);J.color.copy(z).multiplyScalar($),J.halfWidth.set(I.width*.5,0,0),J.halfHeight.set(0,I.height*.5,0),i.rectArea[w]=J,w++}else if(I.isPointLight){const J=e.get(I);if(J.color.copy(I.color).multiplyScalar(I.intensity),J.distance=I.distance,J.decay=I.decay,I.castShadow){const Q=I.shadow,te=t.get(I);te.shadowIntensity=Q.intensity,te.shadowBias=Q.bias,te.shadowNormalBias=Q.normalBias,te.shadowRadius=Q.radius,te.shadowMapSize=Q.mapSize,te.shadowCameraNear=Q.camera.near,te.shadowCameraFar=Q.camera.far,i.pointShadow[m]=te,i.pointShadowMap[m]=re,i.pointShadowMatrix[m]=I.shadow.matrix,M++}i.point[m]=J,m++}else if(I.isHemisphereLight){const J=e.get(I);J.skyColor.copy(I.color).multiplyScalar($),J.groundColor.copy(I.groundColor).multiplyScalar($),i.hemi[y]=J,y++}}w>0&&(n.has("OES_texture_float_linear")===!0?(i.rectAreaLTC1=_e.LTC_FLOAT_1,i.rectAreaLTC2=_e.LTC_FLOAT_2):(i.rectAreaLTC1=_e.LTC_HALF_1,i.rectAreaLTC2=_e.LTC_HALF_2)),i.ambient[0]=f,i.ambient[1]=d,i.ambient[2]=u;const D=i.hash;(D.sunLength!==h||D.directionalLength!==p||D.pointLength!==m||D.spotLength!==v||D.rectAreaLength!==w||D.hemiLength!==y||D.numSunShadows!==_||D.numDirectionalShadows!==S||D.numPointShadows!==M||D.numSpotShadows!==E||D.numSpotMaps!==b||D.numLightProbes!==C)&&(i.sun.length=h,i.directional.length=p,i.spot.length=v,i.rectArea.length=w,i.point.length=m,i.hemi.length=y,i.sunShadow.length=_,i.sunShadowMap.length=_,i.sunShadowMatrix.length=g,i.sunShadowCascade.length=g,i.directionalShadow.length=S,i.directionalShadowMap.length=S,i.directionalShadowMatrix.length=S,i.pointShadow.length=M,i.pointShadowMap.length=M,i.pointShadowMatrix.length=M,i.spotShadow.length=E,i.spotShadowMap.length=E,i.spotLightMatrix.length=E+b-T,i.spotLightMap.length=b,i.numSpotLightShadowsWithMaps=T,i.numLightProbes=C,D.sunLength=h,D.directionalLength=p,D.pointLength=m,D.spotLength=v,D.rectAreaLength=w,D.hemiLength=y,D.numSunShadows=_,D.numDirectionalShadows=S,D.numPointShadows=M,D.numSpotShadows=E,D.numSpotMaps=b,D.numLightProbes=C,i.version=cM++)}function l(c,f){let d=0,u=0,h=0,_=0,g=0,p=0;const m=f.matrixWorldInverse;for(let v=0,w=c.length;v<w;v++){const y=c[v];if(y.isSunLight){const S=i.sun[d];S.direction.setFromMatrixPosition(y.matrixWorld),S.direction.transformDirection(m),d++}else if(y.isDirectionalLight){const S=i.directional[u];S.direction.setFromMatrixPosition(y.matrixWorld),r.setFromMatrixPosition(y.target.matrixWorld),S.direction.sub(r),S.direction.transformDirection(m),u++}else if(y.isSpotLight){const S=i.spot[_];S.position.setFromMatrixPosition(y.matrixWorld),S.position.applyMatrix4(m),S.direction.setFromMatrixPosition(y.matrixWorld),r.setFromMatrixPosition(y.target.matrixWorld),S.direction.sub(r),S.direction.transformDirection(m),_++}else if(y.isRectAreaLight){const S=i.rectArea[g];S.position.setFromMatrixPosition(y.matrixWorld),S.position.applyMatrix4(m),a.identity(),s.copy(y.matrixWorld),s.premultiply(m),a.extractRotation(s),S.halfWidth.set(y.width*.5,0,0),S.halfHeight.set(0,y.height*.5,0),S.halfWidth.applyMatrix4(a),S.halfHeight.applyMatrix4(a),g++}else if(y.isPointLight){const S=i.point[h];S.position.setFromMatrixPosition(y.matrixWorld),S.position.applyMatrix4(m),h++}else if(y.isHemisphereLight){const S=i.hemi[p];S.direction.setFromMatrixPosition(y.matrixWorld),S.direction.transformDirection(m),p++}}}return{setup:o,setupView:l,state:i}}function xd(n){const e=new fM(n),t=[],i=[],r=[];function s(u){d.camera=u,t.length=0,i.length=0,r.length=0}function a(u){t.push(u)}function o(u){i.push(u)}function l(u){r.push(u)}function c(){e.setup(t)}function f(u){e.setupView(t,u)}const d={lightsArray:t,shadowsArray:i,lightProbeGridArray:r,camera:null,lights:e,transmissionRenderTarget:{},textureUnits:0};return{init:s,state:d,setupLights:c,setupLightsView:f,pushLight:a,pushShadow:o,pushLightProbeGrid:l}}function dM(n){let e=new WeakMap;function t(r,s=0){const a=e.get(r);let o;return a===void 0?(o=new xd(n),e.set(r,[o])):s>=a.length?(o=new xd(n),a.push(o)):o=a[s],o}function i(){e=new WeakMap}return{get:t,dispose:i}}const hM=`void main() {
	gl_Position = vec4( position, 1.0 );
}`,pM=`uniform sampler2D shadow_pass;
uniform vec2 resolution;
uniform float radius;
void main() {
	const float samples = float( VSM_SAMPLES );
	float mean = 0.0;
	float squared_mean = 0.0;
	float uvStride = samples <= 1.0 ? 0.0 : 2.0 / ( samples - 1.0 );
	float uvStart = samples <= 1.0 ? 0.0 : - 1.0;
	for ( float i = 0.0; i < samples; i ++ ) {
		float uvOffset = uvStart + i * uvStride;
		#ifdef HORIZONTAL_PASS
			vec2 distribution = texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( uvOffset, 0.0 ) * radius ) / resolution ).rg;
			mean += distribution.x;
			squared_mean += distribution.y * distribution.y + distribution.x * distribution.x;
		#else
			float depth = texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( 0.0, uvOffset ) * radius ) / resolution ).r;
			mean += depth;
			squared_mean += depth * depth;
		#endif
	}
	mean = mean / samples;
	squared_mean = squared_mean / samples;
	float std_dev = sqrt( max( 0.0, squared_mean - mean * mean ) );
	gl_FragColor = vec4( mean, std_dev, 0.0, 1.0 );
}`,mM=[new U(1,0,0),new U(-1,0,0),new U(0,1,0),new U(0,-1,0),new U(0,0,1),new U(0,0,-1)],gM=[new U(0,-1,0),new U(0,-1,0),new U(0,0,1),new U(0,0,-1),new U(0,-1,0),new U(0,-1,0)],yd=new et,ps=new U,Al=new U;function _M(n,e,t){let i=new Lp;const r=new Ze,s=new Ze,a=new bt,o=new Tv,l=new Av,c={},f=t.maxTextureSize,d={[li]:fn,[fn]:li,[Mn]:Mn},u=new Pn({defines:{VSM_SAMPLES:8},uniforms:{shadow_pass:{value:null},resolution:{value:new Ze},radius:{value:4}},vertexShader:hM,fragmentShader:pM}),h=u.clone();h.defines.HORIZONTAL_PASS=1;const _=new Jt;_.setAttribute("position",new Kt(new Float32Array([-1,-1,.5,3,-1,.5,-1,3,.5]),3));const g=new dn(_,u),p=this;this.enabled=!1,this.autoUpdate=!0,this.needsUpdate=!1,this.type=ja;let m=this.type;this.render=function(M,E,b){if(p.enabled===!1||p.autoUpdate===!1&&p.needsUpdate===!1||M.length===0)return;this.type===q0&&(ze("WebGLShadowMap: PCFSoftShadowMap has been removed. Using PCFShadowMap instead."),this.type=ja);const T=n.getRenderTarget(),C=n.getActiveCubeFace(),D=n.getActiveMipmapLevel(),R=n.state;R.setBlending(wi),R.buffers.depth.getReversed()===!0?R.buffers.color.setClear(0,0,0,0):R.buffers.color.setClear(1,1,1,1),R.buffers.depth.setTest(!0),R.setScissorTest(!1);const N=m!==this.type;N&&E.traverse(function(I){I.material&&(Array.isArray(I.material)?I.material.forEach(z=>z.needsUpdate=!0):I.material.needsUpdate=!0)});for(let I=0,z=M.length;I<z;I++){const $=M[I],X=$.shadow;if(X===void 0){ze("WebGLShadowMap:",$,"has no shadow.");continue}if(X.autoUpdate===!1&&X.needsUpdate===!1)continue;r.copy(X.mapSize);const re=X.getFrameExtents();r.multiply(re),s.copy(X.mapSize),(r.x>f||r.y>f)&&(r.x>f&&(s.x=Math.floor(f/re.x),r.x=s.x*re.x,X.mapSize.x=s.x),r.y>f&&(s.y=Math.floor(f/re.y),r.y=s.y*re.y,X.mapSize.y=s.y));const J=n.state.buffers.depth.getReversed();if(X.camera._reversedDepth=J,X.map===null||N===!0){if(X.map!==null&&(X.map.depthTexture!==null&&(X.map.depthTexture.dispose(),X.map.depthTexture=null),X.map.dispose()),this.type===ws){if($.isPointLight){ze("WebGLShadowMap: VSM shadow maps are not supported for PointLights. Use PCF or BasicShadowMap instead.");continue}X.map=new qn(r.x,r.y,{format:mr,type:ui,minFilter:ln,magFilter:ln,generateMipmaps:!1}),X.map.texture.name=$.name+".shadowMap",X.map.depthTexture=new Bs(r.x,r.y,si),X.map.depthTexture.name=$.name+".shadowMapDepth",X.map.depthTexture.format=Ci,X.map.depthTexture.compareFunction=null,X.map.depthTexture.minFilter=rn,X.map.depthTexture.magFilter=rn}else $.isPointLight?(X.map=new zp(r.x),X.map.depthTexture=new yv(r.x,ci)):(X.map=new qn(r.x,r.y),X.map.depthTexture=new Bs(r.x,r.y,ci)),X.map.depthTexture.name=$.name+".shadowMap",X.map.depthTexture.format=Ci,this.type===ja?(X.map.depthTexture.compareFunction=J?Tu:Eu,X.map.depthTexture.minFilter=ln,X.map.depthTexture.magFilter=ln):(X.map.depthTexture.compareFunction=null,X.map.depthTexture.minFilter=rn,X.map.depthTexture.magFilter=rn);X.camera.updateProjectionMatrix()}X.map.isWebGLCubeRenderTarget!==!0&&(X.map.width!==r.x||X.map.height!==r.y)&&X.map.setSize(r.x,r.y);const Q=X.map.isWebGLCubeRenderTarget?6:X.getViewportCount();$.isPointLight!==!0&&X.updateMatrices($,b);for(let te=0;te<Q;te++){const ue=X.getCamera(te);if($.isPointLight){const be=X.camera,Fe=X.matrix,Re=$.distance||be.far;Re!==be.far&&(be.far=Re,be.updateProjectionMatrix()),ps.setFromMatrixPosition($.matrixWorld),be.position.copy(ps),Al.copy(be.position),Al.add(mM[te]),be.up.copy(gM[te]),be.lookAt(Al),be.updateMatrixWorld(),Fe.makeTranslation(-ps.x,-ps.y,-ps.z),yd.multiplyMatrices(be.projectionMatrix,be.matrixWorldInverse),X._frustum.setFromProjectionMatrix(yd,be.coordinateSystem,be.reversedDepth)}if(X.map.isWebGLCubeRenderTarget)n.setRenderTarget(X.map,te),n.clear();else{te===0&&(n.setRenderTarget(X.map),n.clear());const be=X.getViewport(te);a.set(s.x*be.x,s.y*be.y,s.x*be.z,s.y*be.w),R.viewport(a)}i=X.getFrustum(te),y(E,b,ue,$,this.type)}X.isPointLightShadow!==!0&&this.type===ws&&v(X,b),X.needsUpdate=!1}m=this.type,p.needsUpdate=!1,n.setRenderTarget(T,C,D)};function v(M,E){const b=e.update(g);u.defines.VSM_SAMPLES!==M.blurSamples&&(u.defines.VSM_SAMPLES=M.blurSamples,h.defines.VSM_SAMPLES=M.blurSamples,u.needsUpdate=!0,h.needsUpdate=!0),M.mapPass===null?M.mapPass=new qn(r.x,r.y,{format:mr,type:ui}):(M.mapPass.width!==M.map.width||M.mapPass.height!==M.map.height)&&M.mapPass.setSize(M.map.width,M.map.height),u.uniforms.shadow_pass.value=M.map.depthTexture,u.uniforms.resolution.value.set(M.map.width,M.map.height),u.uniforms.radius.value=M.radius,n.setRenderTarget(M.mapPass),n.clear(),n.renderBufferDirect(E,null,b,u,g,null),h.uniforms.shadow_pass.value=M.mapPass.texture,h.uniforms.resolution.value.set(M.map.width,M.map.height),h.uniforms.radius.value=M.radius,n.setRenderTarget(M.map),n.clear(),n.renderBufferDirect(E,null,b,h,g,null)}function w(M,E,b,T){let C=null;const D=b.isPointLight===!0?M.customDistanceMaterial:M.customDepthMaterial;if(D!==void 0)C=D;else if(C=b.isPointLight===!0?l:o,n.localClippingEnabled&&E.clipShadows===!0&&Array.isArray(E.clippingPlanes)&&E.clippingPlanes.length!==0||E.displacementMap&&E.displacementScale!==0||E.alphaMap&&E.alphaTest>0||E.map&&E.alphaTest>0||E.alphaToCoverage===!0){const R=C.uuid,N=E.uuid;let I=c[R];I===void 0&&(I={},c[R]=I);let z=I[N];z===void 0&&(z=C.clone(),I[N]=z,E.addEventListener("dispose",S)),C=z}if(C.visible=E.visible,C.wireframe=E.wireframe,T===ws?C.side=E.shadowSide!==null?E.shadowSide:E.side:C.side=E.shadowSide!==null?E.shadowSide:d[E.side],C.alphaMap=E.alphaMap,C.alphaTest=E.alphaToCoverage===!0?.5:E.alphaTest,C.map=E.map,C.clipShadows=E.clipShadows,C.clippingPlanes=E.clippingPlanes,C.clipIntersection=E.clipIntersection,C.displacementMap=E.displacementMap,C.displacementScale=E.displacementScale,C.displacementBias=E.displacementBias,C.wireframeLinewidth=E.wireframeLinewidth,C.linewidth=E.linewidth,b.isPointLight===!0&&C.isMeshDistanceMaterial===!0){const R=n.properties.get(C);R.light=b}return C}function y(M,E,b,T,C){if(M.visible===!1)return;if(M.layers.test(E.layers)&&(M.isMesh||M.isLine||M.isPoints)&&(M.castShadow||M.receiveShadow&&C===ws)&&(!M.frustumCulled||M.intersectsFrustum(i))){M.modelViewMatrix.multiplyMatrices(b.matrixWorldInverse,M.matrixWorld);const N=e.update(M),I=M.material;if(Array.isArray(I)){const z=N.groups;for(let $=0,X=z.length;$<X;$++){const re=z[$],J=I[re.materialIndex];if(J&&J.visible){const Q=w(M,J,T,C);M.onBeforeShadow(n,M,E,b,N,Q,re),n.renderBufferDirect(b,null,N,Q,M,re),M.onAfterShadow(n,M,E,b,N,Q,re)}}}else if(I.visible){const z=w(M,I,T,C);M.onBeforeShadow(n,M,E,b,N,z,null),n.renderBufferDirect(b,null,N,z,M,null),M.onAfterShadow(n,M,E,b,N,z,null)}}const R=M.children;for(let N=0,I=R.length;N<I;N++)y(R[N],E,b,T,C)}function S(M){M.target.removeEventListener("dispose",S);for(const b in c){const T=c[b],C=M.target.uuid;C in T&&(T[C].dispose(),delete T[C])}}}function vM(n,e){function t(){let G=!1;const pe=new bt;let se=null;const ge=new bt(0,0,0,0);return{setMask:function(xe){se!==xe&&!G&&(n.colorMask(xe,xe,xe,xe),se=xe)},setLocked:function(xe){G=xe},setClear:function(xe,le,Ne,Te,pt){pt===!0&&(xe*=Te,le*=Te,Ne*=Te),pe.set(xe,le,Ne,Te),ge.equals(pe)===!1&&(n.clearColor(xe,le,Ne,Te),ge.copy(pe))},reset:function(){G=!1,se=null,ge.set(-1,0,0,0)}}}function i(){let G=!1,pe=!1,se=null,ge=null,xe=null;return{setReversed:function(le){if(pe!==le){const Ne=e.get("EXT_clip_control");le?Ne.clipControlEXT(Ne.LOWER_LEFT_EXT,Ne.ZERO_TO_ONE_EXT):Ne.clipControlEXT(Ne.LOWER_LEFT_EXT,Ne.NEGATIVE_ONE_TO_ONE_EXT),pe=le;const Te=xe;xe=null,this.setClear(Te)}},getReversed:function(){return pe},setTest:function(le){le?ae(n.DEPTH_TEST):Me(n.DEPTH_TEST)},setMask:function(le){se!==le&&!G&&(n.depthMask(le),se=le)},setFunc:function(le){if(pe&&(le=C_[le]),ge!==le){switch(le){case ic:n.depthFunc(n.NEVER);break;case rc:n.depthFunc(n.ALWAYS);break;case sc:n.depthFunc(n.LESS);break;case Jr:n.depthFunc(n.LEQUAL);break;case ac:n.depthFunc(n.EQUAL);break;case oc:n.depthFunc(n.GEQUAL);break;case lc:n.depthFunc(n.GREATER);break;case cc:n.depthFunc(n.NOTEQUAL);break;default:n.depthFunc(n.LEQUAL)}ge=le}},setLocked:function(le){G=le},setClear:function(le){xe!==le&&(xe=le,pe&&(le=1-le),n.clearDepth(le))},reset:function(){G=!1,se=null,ge=null,xe=null,pe=!1}}}function r(){let G=!1,pe=null,se=null,ge=null,xe=null,le=null,Ne=null,Te=null,pt=null;return{setTest:function(lt){G||(lt?ae(n.STENCIL_TEST):Me(n.STENCIL_TEST))},setMask:function(lt){pe!==lt&&!G&&(n.stencilMask(lt),pe=lt)},setFunc:function(lt,bn,wn){(se!==lt||ge!==bn||xe!==wn)&&(n.stencilFunc(lt,bn,wn),se=lt,ge=bn,xe=wn)},setOp:function(lt,bn,wn){(le!==lt||Ne!==bn||Te!==wn)&&(n.stencilOp(lt,bn,wn),le=lt,Ne=bn,Te=wn)},setLocked:function(lt){G=lt},setClear:function(lt){pt!==lt&&(n.clearStencil(lt),pt=lt)},reset:function(){G=!1,pe=null,se=null,ge=null,xe=null,le=null,Ne=null,Te=null,pt=null}}}const s=new t,a=new i,o=new r,l=new WeakMap,c=new WeakMap;let f={},d={},u={},h=new WeakMap,_=[],g=null,p=!1,m=null,v=null,w=null,y=null,S=null,M=null,E=null,b=new ft(0,0,0),T=0,C=!1,D=null,R=null,N=null,I=null,z=null;const $=n.getParameter(n.MAX_COMBINED_TEXTURE_IMAGE_UNITS);let X=!1,re=0;const J=n.getParameter(n.VERSION);J.indexOf("WebGL")!==-1?(re=parseFloat(/^WebGL (\d)/.exec(J)[1]),X=re>=1):J.indexOf("OpenGL ES")!==-1&&(re=parseFloat(/^OpenGL ES (\d)/.exec(J)[1]),X=re>=2);let Q=null,te={};const ue=n.getParameter(n.SCISSOR_BOX),be=n.getParameter(n.VIEWPORT),Fe=new bt().fromArray(ue),Re=new bt().fromArray(be);function je(G,pe,se,ge){const xe=new Uint8Array(4),le=n.createTexture();n.bindTexture(G,le),n.texParameteri(G,n.TEXTURE_MIN_FILTER,n.NEAREST),n.texParameteri(G,n.TEXTURE_MAG_FILTER,n.NEAREST);for(let Ne=0;Ne<se;Ne++)G===n.TEXTURE_3D||G===n.TEXTURE_2D_ARRAY?n.texImage3D(pe,0,n.RGBA,1,1,ge,0,n.RGBA,n.UNSIGNED_BYTE,xe):n.texImage2D(pe+Ne,0,n.RGBA,1,1,0,n.RGBA,n.UNSIGNED_BYTE,xe);return le}const ne={};ne[n.TEXTURE_2D]=je(n.TEXTURE_2D,n.TEXTURE_2D,1),ne[n.TEXTURE_CUBE_MAP]=je(n.TEXTURE_CUBE_MAP,n.TEXTURE_CUBE_MAP_POSITIVE_X,6),ne[n.TEXTURE_2D_ARRAY]=je(n.TEXTURE_2D_ARRAY,n.TEXTURE_2D_ARRAY,1,1),ne[n.TEXTURE_3D]=je(n.TEXTURE_3D,n.TEXTURE_3D,1,1),s.setClear(0,0,0,1),a.setClear(1),o.setClear(0),ae(n.DEPTH_TEST),a.setFunc(Jr),qe(!1),ot(bf),ae(n.CULL_FACE),Ke(wi);function ae(G){f[G]!==!0&&(n.enable(G),f[G]=!0)}function Me(G){f[G]!==!1&&(n.disable(G),f[G]=!1)}function Be(G,pe){return u[G]!==pe?(n.bindFramebuffer(G,pe),u[G]=pe,G===n.DRAW_FRAMEBUFFER&&(u[n.FRAMEBUFFER]=pe),G===n.FRAMEBUFFER&&(u[n.DRAW_FRAMEBUFFER]=pe),!0):!1}function ve(G,pe){let se=_,ge=!1;if(G){se=h.get(pe),se===void 0&&(se=[],h.set(pe,se));const xe=G.textures;if(se.length!==xe.length||se[0]!==n.COLOR_ATTACHMENT0){for(let le=0,Ne=xe.length;le<Ne;le++)se[le]=n.COLOR_ATTACHMENT0+le;se.length=xe.length,ge=!0}}else se[0]!==n.BACK&&(se[0]=n.BACK,ge=!0);ge&&n.drawBuffers(se)}function ke(G){return g!==G?(n.useProgram(G),g=G,!0):!1}const Pt={[$r]:n.FUNC_ADD,[K0]:n.FUNC_SUBTRACT,[Z0]:n.FUNC_REVERSE_SUBTRACT};Pt[J0]=n.MIN,Pt[Q0]=n.MAX;const $e={[j0]:n.ZERO,[e_]:n.ONE,[t_]:n.SRC_COLOR,[rp]:n.SRC_ALPHA,[o_]:n.SRC_ALPHA_SATURATE,[s_]:n.DST_COLOR,[i_]:n.DST_ALPHA,[n_]:n.ONE_MINUS_SRC_COLOR,[sp]:n.ONE_MINUS_SRC_ALPHA,[a_]:n.ONE_MINUS_DST_COLOR,[r_]:n.ONE_MINUS_DST_ALPHA,[l_]:n.CONSTANT_COLOR,[c_]:n.ONE_MINUS_CONSTANT_COLOR,[u_]:n.CONSTANT_ALPHA,[f_]:n.ONE_MINUS_CONSTANT_ALPHA};function Ke(G,pe,se,ge,xe,le,Ne,Te,pt,lt){if(G===wi){p===!0&&(Me(n.BLEND),p=!1);return}if(p===!1&&(ae(n.BLEND),p=!0),G!==Y0){if(G!==m||lt!==C){if((v!==$r||S!==$r)&&(n.blendEquation(n.FUNC_ADD),v=$r,S=$r),lt)switch(G){case Rs:n.blendFuncSeparate(n.ONE,n.ONE_MINUS_SRC_ALPHA,n.ONE,n.ONE_MINUS_SRC_ALPHA);break;case Sf:n.blendFunc(n.ONE,n.ONE);break;case Mf:n.blendFuncSeparate(n.ZERO,n.ONE_MINUS_SRC_COLOR,n.ZERO,n.ONE);break;case wf:n.blendFuncSeparate(n.DST_COLOR,n.ONE_MINUS_SRC_ALPHA,n.ZERO,n.ONE);break;default:ut("WebGLState: Invalid blending: ",G);break}else switch(G){case Rs:n.blendFuncSeparate(n.SRC_ALPHA,n.ONE_MINUS_SRC_ALPHA,n.ONE,n.ONE_MINUS_SRC_ALPHA);break;case Sf:n.blendFuncSeparate(n.SRC_ALPHA,n.ONE,n.ONE,n.ONE);break;case Mf:ut("WebGLState: SubtractiveBlending requires material.premultipliedAlpha = true");break;case wf:ut("WebGLState: MultiplyBlending requires material.premultipliedAlpha = true");break;default:ut("WebGLState: Invalid blending: ",G);break}w=null,y=null,M=null,E=null,b.set(0,0,0),T=0,m=G,C=lt}return}xe=xe||pe,le=le||se,Ne=Ne||ge,(pe!==v||xe!==S)&&(n.blendEquationSeparate(Pt[pe],Pt[xe]),v=pe,S=xe),(se!==w||ge!==y||le!==M||Ne!==E)&&(n.blendFuncSeparate($e[se],$e[ge],$e[le],$e[Ne]),w=se,y=ge,M=le,E=Ne),(Te.equals(b)===!1||pt!==T)&&(n.blendColor(Te.r,Te.g,Te.b,pt),b.copy(Te),T=pt),m=G,C=!1}function rt(G,pe){G.side===Mn?Me(n.CULL_FACE):ae(n.CULL_FACE);let se=G.side===fn;pe&&(se=!se),qe(se),G.blending===Rs&&G.transparent===!1?Ke(wi):Ke(G.blending,G.blendEquation,G.blendSrc,G.blendDst,G.blendEquationAlpha,G.blendSrcAlpha,G.blendDstAlpha,G.blendColor,G.blendAlpha,G.premultipliedAlpha),a.setFunc(G.depthFunc),a.setTest(G.depthTest),a.setMask(G.depthWrite),s.setMask(G.colorWrite);const ge=G.stencilWrite;o.setTest(ge),ge&&(o.setMask(G.stencilWriteMask),o.setFunc(G.stencilFunc,G.stencilRef,G.stencilFuncMask),o.setOp(G.stencilFail,G.stencilZFail,G.stencilZPass)),Tt(G.polygonOffset,G.polygonOffsetFactor,G.polygonOffsetUnits),G.alphaToCoverage===!0?ae(n.SAMPLE_ALPHA_TO_COVERAGE):Me(n.SAMPLE_ALPHA_TO_COVERAGE)}function qe(G){D!==G&&(G?n.frontFace(n.CW):n.frontFace(n.CCW),D=G)}function ot(G){G!==$0?(ae(n.CULL_FACE),G!==R&&(G===bf?n.cullFace(n.BACK):G===X0?n.cullFace(n.FRONT):n.cullFace(n.FRONT_AND_BACK))):Me(n.CULL_FACE),R=G}function Dt(G){G!==N&&(X&&n.lineWidth(G),N=G)}function Tt(G,pe,se){G?(ae(n.POLYGON_OFFSET_FILL),(I!==pe||z!==se)&&(I=pe,z=se,a.getReversed()&&(pe=-pe),n.polygonOffset(pe,se))):Me(n.POLYGON_OFFSET_FILL)}function vt(G){G?ae(n.SCISSOR_TEST):Me(n.SCISSOR_TEST)}function At(G){G===void 0&&(G=n.TEXTURE0+$-1),Q!==G&&(n.activeTexture(G),Q=G)}function V(G,pe,se){se===void 0&&(Q===null?se=n.TEXTURE0+$-1:se=Q);let ge=te[se];ge===void 0&&(ge={type:void 0,texture:void 0},te[se]=ge),(ge.type!==G||ge.texture!==pe)&&(Q!==se&&(n.activeTexture(se),Q=se),n.bindTexture(G,pe||ne[G]),ge.type=G,ge.texture=pe)}function Nt(){const G=te[Q];G!==void 0&&G.type!==void 0&&(n.bindTexture(G.type,null),G.type=void 0,G.texture=void 0)}function nt(){try{n.compressedTexImage2D(...arguments)}catch(G){ut("WebGLState:",G)}}function A(){try{n.compressedTexImage3D(...arguments)}catch(G){ut("WebGLState:",G)}}function x(){try{n.texSubImage2D(...arguments)}catch(G){ut("WebGLState:",G)}}function L(){try{n.texSubImage3D(...arguments)}catch(G){ut("WebGLState:",G)}}function F(){try{n.compressedTexSubImage2D(...arguments)}catch(G){ut("WebGLState:",G)}}function B(){try{n.compressedTexSubImage3D(...arguments)}catch(G){ut("WebGLState:",G)}}function q(){try{n.texStorage2D(...arguments)}catch(G){ut("WebGLState:",G)}}function oe(){try{n.texStorage3D(...arguments)}catch(G){ut("WebGLState:",G)}}function j(){try{n.texImage2D(...arguments)}catch(G){ut("WebGLState:",G)}}function W(){try{n.texImage3D(...arguments)}catch(G){ut("WebGLState:",G)}}function ce(G){return d[G]!==void 0?d[G]:n.getParameter(G)}function fe(G,pe){d[G]!==pe&&(n.pixelStorei(G,pe),d[G]=pe)}function me(G){Fe.equals(G)===!1&&(n.scissor(G.x,G.y,G.z,G.w),Fe.copy(G))}function de(G){Re.equals(G)===!1&&(n.viewport(G.x,G.y,G.z,G.w),Re.copy(G))}function De(G,pe){let se=c.get(pe);se===void 0&&(se=new WeakMap,c.set(pe,se));let ge=se.get(G);ge===void 0&&(ge=n.getUniformBlockIndex(pe,G.name),se.set(G,ge))}function Ue(G,pe){const ge=c.get(pe).get(G);l.get(pe)!==ge&&(n.uniformBlockBinding(pe,ge,G.__bindingPointIndex),l.set(pe,ge))}function Ve(){n.disable(n.BLEND),n.disable(n.CULL_FACE),n.disable(n.DEPTH_TEST),n.disable(n.POLYGON_OFFSET_FILL),n.disable(n.SCISSOR_TEST),n.disable(n.STENCIL_TEST),n.disable(n.SAMPLE_ALPHA_TO_COVERAGE),n.blendEquation(n.FUNC_ADD),n.blendFunc(n.ONE,n.ZERO),n.blendFuncSeparate(n.ONE,n.ZERO,n.ONE,n.ZERO),n.blendColor(0,0,0,0),n.colorMask(!0,!0,!0,!0),n.clearColor(0,0,0,0),n.depthMask(!0),n.depthFunc(n.LESS),a.setReversed(!1),n.clearDepth(1),n.stencilMask(4294967295),n.stencilFunc(n.ALWAYS,0,4294967295),n.stencilOp(n.KEEP,n.KEEP,n.KEEP),n.clearStencil(0),n.cullFace(n.BACK),n.frontFace(n.CCW),n.polygonOffset(0,0),n.activeTexture(n.TEXTURE0),n.bindFramebuffer(n.FRAMEBUFFER,null),n.bindFramebuffer(n.DRAW_FRAMEBUFFER,null),n.bindFramebuffer(n.READ_FRAMEBUFFER,null),n.useProgram(null),n.lineWidth(1),n.scissor(0,0,n.canvas.width,n.canvas.height),n.viewport(0,0,n.canvas.width,n.canvas.height),n.pixelStorei(n.PACK_ALIGNMENT,4),n.pixelStorei(n.UNPACK_ALIGNMENT,4),n.pixelStorei(n.UNPACK_FLIP_Y_WEBGL,!1),n.pixelStorei(n.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),n.pixelStorei(n.UNPACK_COLORSPACE_CONVERSION_WEBGL,n.BROWSER_DEFAULT_WEBGL),n.pixelStorei(n.PACK_ROW_LENGTH,0),n.pixelStorei(n.PACK_SKIP_PIXELS,0),n.pixelStorei(n.PACK_SKIP_ROWS,0),n.pixelStorei(n.UNPACK_ROW_LENGTH,0),n.pixelStorei(n.UNPACK_IMAGE_HEIGHT,0),n.pixelStorei(n.UNPACK_SKIP_PIXELS,0),n.pixelStorei(n.UNPACK_SKIP_ROWS,0),n.pixelStorei(n.UNPACK_SKIP_IMAGES,0),f={},d={},Q=null,te={},u={},h=new WeakMap,_=[],g=null,p=!1,m=null,v=null,w=null,y=null,S=null,M=null,E=null,b=new ft(0,0,0),T=0,C=!1,D=null,R=null,N=null,I=null,z=null,Fe.set(0,0,n.canvas.width,n.canvas.height),Re.set(0,0,n.canvas.width,n.canvas.height),s.reset(),a.reset(),o.reset()}return{buffers:{color:s,depth:a,stencil:o},enable:ae,disable:Me,bindFramebuffer:Be,drawBuffers:ve,useProgram:ke,setBlending:Ke,setMaterial:rt,setFlipSided:qe,setCullFace:ot,setLineWidth:Dt,setPolygonOffset:Tt,setScissorTest:vt,activeTexture:At,bindTexture:V,unbindTexture:Nt,compressedTexImage2D:nt,compressedTexImage3D:A,texImage2D:j,texImage3D:W,pixelStorei:fe,getParameter:ce,updateUBOMapping:De,uniformBlockBinding:Ue,texStorage2D:q,texStorage3D:oe,texSubImage2D:x,texSubImage3D:L,compressedTexSubImage2D:F,compressedTexSubImage3D:B,scissor:me,viewport:de,reset:Ve}}function xM(n,e,t,i,r,s,a){const o=e.has("WEBGL_multisampled_render_to_texture")?e.get("WEBGL_multisampled_render_to_texture"):null,l=typeof navigator>"u"?!1:/OculusBrowser/g.test(navigator.userAgent),c=new Ze,f=new WeakMap,d=new Set;let u;const h=new WeakMap;let _=!1;try{_=typeof OffscreenCanvas<"u"&&new OffscreenCanvas(1,1).getContext("2d")!==null}catch{}function g(A,x){return _?new OffscreenCanvas(A,x):wo("canvas")}function p(A,x,L){let F=1;const B=nt(A);if((B.width>L||B.height>L)&&(F=L/Math.max(B.width,B.height)),F<1)if(typeof HTMLImageElement<"u"&&A instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&A instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&A instanceof ImageBitmap||typeof VideoFrame<"u"&&A instanceof VideoFrame){const q=Math.floor(F*B.width),oe=Math.floor(F*B.height);u===void 0&&(u=g(q,oe));const j=x?g(q,oe):u;return j.width=q,j.height=oe,j.getContext("2d").drawImage(A,0,0,q,oe),ze("WebGLRenderer: Texture has been resized from ("+B.width+"x"+B.height+") to ("+q+"x"+oe+")."),j}else return"data"in A&&ze("WebGLRenderer: Image in DataTexture is too big ("+B.width+"x"+B.height+")."),A;return A}function m(A){return A.generateMipmaps}function v(A){n.generateMipmap(A)}function w(A){return A.isWebGLCubeRenderTarget?n.TEXTURE_CUBE_MAP:A.isWebGL3DRenderTarget?n.TEXTURE_3D:A.isWebGLArrayRenderTarget||A.isCompressedArrayTexture?n.TEXTURE_2D_ARRAY:n.TEXTURE_2D}function y(A,x,L,F,B,q=!1){if(A!==null){if(n[A]!==void 0)return n[A];ze("WebGLRenderer: Attempt to use non-existing WebGL internal format '"+A+"'")}let oe;F&&(oe=e.get("EXT_texture_norm16"),oe||ze("WebGLRenderer: Unable to use normalized textures without EXT_texture_norm16 extension"));let j=x;if(x===n.RED&&(L===n.FLOAT&&(j=n.R32F),L===n.HALF_FLOAT&&(j=n.R16F),L===n.UNSIGNED_BYTE&&(j=n.R8),L===n.UNSIGNED_SHORT&&oe&&(j=oe.R16_EXT),L===n.SHORT&&oe&&(j=oe.R16_SNORM_EXT)),x===n.RED_INTEGER&&(L===n.UNSIGNED_BYTE&&(j=n.R8UI),L===n.UNSIGNED_SHORT&&(j=n.R16UI),L===n.UNSIGNED_INT&&(j=n.R32UI),L===n.BYTE&&(j=n.R8I),L===n.SHORT&&(j=n.R16I),L===n.INT&&(j=n.R32I)),x===n.RG&&(L===n.FLOAT&&(j=n.RG32F),L===n.HALF_FLOAT&&(j=n.RG16F),L===n.UNSIGNED_BYTE&&(j=n.RG8),L===n.UNSIGNED_SHORT&&oe&&(j=oe.RG16_EXT),L===n.SHORT&&oe&&(j=oe.RG16_SNORM_EXT)),x===n.RG_INTEGER&&(L===n.UNSIGNED_BYTE&&(j=n.RG8UI),L===n.UNSIGNED_SHORT&&(j=n.RG16UI),L===n.UNSIGNED_INT&&(j=n.RG32UI),L===n.BYTE&&(j=n.RG8I),L===n.SHORT&&(j=n.RG16I),L===n.INT&&(j=n.RG32I)),x===n.RGB_INTEGER&&(L===n.UNSIGNED_BYTE&&(j=n.RGB8UI),L===n.UNSIGNED_SHORT&&(j=n.RGB16UI),L===n.UNSIGNED_INT&&(j=n.RGB32UI),L===n.BYTE&&(j=n.RGB8I),L===n.SHORT&&(j=n.RGB16I),L===n.INT&&(j=n.RGB32I)),x===n.RGBA_INTEGER&&(L===n.UNSIGNED_BYTE&&(j=n.RGBA8UI),L===n.UNSIGNED_SHORT&&(j=n.RGBA16UI),L===n.UNSIGNED_INT&&(j=n.RGBA32UI),L===n.BYTE&&(j=n.RGBA8I),L===n.SHORT&&(j=n.RGBA16I),L===n.INT&&(j=n.RGBA32I)),x===n.RGB&&(L===n.UNSIGNED_SHORT&&oe&&(j=oe.RGB16_EXT),L===n.SHORT&&oe&&(j=oe.RGB16_SNORM_EXT),L===n.UNSIGNED_INT_5_9_9_9_REV&&(j=n.RGB9_E5),L===n.UNSIGNED_INT_10F_11F_11F_REV&&(j=n.R11F_G11F_B10F)),x===n.RGBA){const W=q?So:at.getTransfer(B);L===n.FLOAT&&(j=n.RGBA32F),L===n.HALF_FLOAT&&(j=n.RGBA16F),L===n.UNSIGNED_BYTE&&(j=W===mt?n.SRGB8_ALPHA8:n.RGBA8),L===n.UNSIGNED_SHORT&&oe&&(j=oe.RGBA16_EXT),L===n.SHORT&&oe&&(j=oe.RGBA16_SNORM_EXT),L===n.UNSIGNED_SHORT_4_4_4_4&&(j=n.RGBA4),L===n.UNSIGNED_SHORT_5_5_5_1&&(j=n.RGB5_A1)}return(j===n.R16F||j===n.R32F||j===n.RG16F||j===n.RG32F||j===n.RGBA16F||j===n.RGBA32F)&&e.get("EXT_color_buffer_float"),j}function S(A,x){let L;return A?x===null||x===ci||x===Us?L=n.DEPTH24_STENCIL8:x===si?L=n.DEPTH32F_STENCIL8:x===Is&&(L=n.DEPTH24_STENCIL8,ze("DepthTexture: 16 bit depth attachment is not supported with stencil. Using 24-bit attachment.")):x===null||x===ci||x===Us?L=n.DEPTH_COMPONENT24:x===si?L=n.DEPTH_COMPONENT32F:x===Is&&(L=n.DEPTH_COMPONENT16),L}function M(A,x){return m(A)===!0||A.isFramebufferTexture&&A.minFilter!==rn&&A.minFilter!==ln?Math.log2(Math.max(x.width,x.height))+1:A.mipmaps!==void 0&&A.mipmaps.length>0?A.mipmaps.length:A.isCompressedTexture&&Array.isArray(A.image)?x.mipmaps.length:1}function E(A){const x=A.target;x.removeEventListener("dispose",E),T(x),x.isVideoTexture&&f.delete(x),x.isHTMLTexture&&d.delete(x)}function b(A){const x=A.target;x.removeEventListener("dispose",b),D(x)}function T(A){const x=i.get(A);if(x.__webglInit===void 0)return;const L=A.source,F=h.get(L);if(F){const B=F[x.__cacheKey];B.usedTimes--,B.usedTimes===0&&C(A),Object.keys(F).length===0&&h.delete(L)}i.remove(A)}function C(A){const x=i.get(A);n.deleteTexture(x.__webglTexture);const L=A.source,F=h.get(L);delete F[x.__cacheKey],a.memory.textures--}function D(A){const x=i.get(A);if(A.depthTexture&&(A.depthTexture.dispose(),i.remove(A.depthTexture)),A.isWebGLCubeRenderTarget)for(let F=0;F<6;F++){if(Array.isArray(x.__webglFramebuffer[F]))for(let B=0;B<x.__webglFramebuffer[F].length;B++)n.deleteFramebuffer(x.__webglFramebuffer[F][B]);else n.deleteFramebuffer(x.__webglFramebuffer[F]);x.__webglDepthbuffer&&n.deleteRenderbuffer(x.__webglDepthbuffer[F])}else{if(Array.isArray(x.__webglFramebuffer))for(let F=0;F<x.__webglFramebuffer.length;F++)n.deleteFramebuffer(x.__webglFramebuffer[F]);else n.deleteFramebuffer(x.__webglFramebuffer);if(x.__webglDepthbuffer&&n.deleteRenderbuffer(x.__webglDepthbuffer),x.__webglMultisampledFramebuffer&&n.deleteFramebuffer(x.__webglMultisampledFramebuffer),x.__webglColorRenderbuffer)for(let F=0;F<x.__webglColorRenderbuffer.length;F++)x.__webglColorRenderbuffer[F]&&n.deleteRenderbuffer(x.__webglColorRenderbuffer[F]);x.__webglDepthRenderbuffer&&n.deleteRenderbuffer(x.__webglDepthRenderbuffer)}const L=A.textures;for(let F=0,B=L.length;F<B;F++){const q=i.get(L[F]);q.__webglTexture&&(n.deleteTexture(q.__webglTexture),a.memory.textures--),i.remove(L[F])}i.remove(A)}let R=0;function N(){R=0}function I(){return R}function z(A){R=A}function $(){const A=R;return A>=r.maxTextures&&ze("WebGLTextures: Trying to use "+(A+1)+" texture units while this GPU supports only "+r.maxTextures),R+=1,A}function X(A){const x=[];return x.push(A.wrapS),x.push(A.wrapT),x.push(A.wrapR||0),x.push(A.magFilter),x.push(A.minFilter),x.push(A.anisotropy),x.push(A.internalFormat),x.push(A.format),x.push(A.type),x.push(A.generateMipmaps),x.push(A.premultiplyAlpha),x.push(A.flipY),x.push(A.unpackAlignment),x.push(A.colorSpace),x.join()}function re(A,x){const L=i.get(A);if(A.isVideoTexture&&V(A),A.isRenderTargetTexture===!1&&A.isExternalTexture!==!0&&A.version>0&&L.__version!==A.version){const F=A.image;if(F===null)ze("WebGLRenderer: Texture marked for update but no image data found.");else if(F.complete===!1)ze("WebGLRenderer: Texture marked for update but image is incomplete");else{Me(L,A,x);return}}else A.isExternalTexture&&(L.__webglTexture=A.sourceTexture?A.sourceTexture:null);t.bindTexture(n.TEXTURE_2D,L.__webglTexture,n.TEXTURE0+x)}function J(A,x){const L=i.get(A);if(A.isRenderTargetTexture===!1&&A.version>0&&L.__version!==A.version){Me(L,A,x);return}else A.isExternalTexture&&(L.__webglTexture=A.sourceTexture?A.sourceTexture:null);t.bindTexture(n.TEXTURE_2D_ARRAY,L.__webglTexture,n.TEXTURE0+x)}function Q(A,x){const L=i.get(A);if(A.isRenderTargetTexture===!1&&A.version>0&&L.__version!==A.version){Me(L,A,x);return}t.bindTexture(n.TEXTURE_3D,L.__webglTexture,n.TEXTURE0+x)}function te(A,x){const L=i.get(A);if(A.isCubeDepthTexture!==!0&&A.version>0&&L.__version!==A.version){Be(L,A,x);return}t.bindTexture(n.TEXTURE_CUBE_MAP,L.__webglTexture,n.TEXTURE0+x)}const ue={[uc]:n.REPEAT,[Si]:n.CLAMP_TO_EDGE,[fc]:n.MIRRORED_REPEAT},be={[rn]:n.NEAREST,[p_]:n.NEAREST_MIPMAP_NEAREST,[ea]:n.NEAREST_MIPMAP_LINEAR,[ln]:n.LINEAR,[Jo]:n.LINEAR_MIPMAP_NEAREST,[fr]:n.LINEAR_MIPMAP_LINEAR},Fe={[y_]:n.NEVER,[E_]:n.ALWAYS,[b_]:n.LESS,[Eu]:n.LEQUAL,[S_]:n.EQUAL,[Tu]:n.GEQUAL,[M_]:n.GREATER,[w_]:n.NOTEQUAL};function Re(A,x){if(x.type===si&&e.has("OES_texture_float_linear")===!1&&(x.magFilter===ln||x.magFilter===Jo||x.magFilter===ea||x.magFilter===fr||x.minFilter===ln||x.minFilter===Jo||x.minFilter===ea||x.minFilter===fr)&&ze("WebGLRenderer: Unable to use linear filtering with floating point textures. OES_texture_float_linear not supported on this device."),n.texParameteri(A,n.TEXTURE_WRAP_S,ue[x.wrapS]),n.texParameteri(A,n.TEXTURE_WRAP_T,ue[x.wrapT]),(A===n.TEXTURE_3D||A===n.TEXTURE_2D_ARRAY)&&n.texParameteri(A,n.TEXTURE_WRAP_R,ue[x.wrapR]),n.texParameteri(A,n.TEXTURE_MAG_FILTER,be[x.magFilter]),n.texParameteri(A,n.TEXTURE_MIN_FILTER,be[x.minFilter]),x.compareFunction&&(n.texParameteri(A,n.TEXTURE_COMPARE_MODE,n.COMPARE_REF_TO_TEXTURE),n.texParameteri(A,n.TEXTURE_COMPARE_FUNC,Fe[x.compareFunction])),e.has("EXT_texture_filter_anisotropic")===!0){if(x.magFilter===rn||x.minFilter!==ea&&x.minFilter!==fr||x.type===si&&e.has("OES_texture_float_linear")===!1)return;if(x.anisotropy>1||i.get(x).__currentAnisotropy){const L=e.get("EXT_texture_filter_anisotropic");n.texParameterf(A,L.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(x.anisotropy,r.getMaxAnisotropy())),i.get(x).__currentAnisotropy=x.anisotropy}}}function je(A,x){let L=!1;A.__webglInit===void 0&&(A.__webglInit=!0,x.addEventListener("dispose",E));const F=x.source;let B=h.get(F);B===void 0&&(B={},h.set(F,B));const q=X(x);if(q!==A.__cacheKey){B[q]===void 0&&(B[q]={texture:n.createTexture(),usedTimes:0},a.memory.textures++,L=!0),B[q].usedTimes++;const oe=B[A.__cacheKey];oe!==void 0&&(B[A.__cacheKey].usedTimes--,oe.usedTimes===0&&C(x)),A.__cacheKey=q,A.__webglTexture=B[q].texture}return L}function ne(A,x,L){return Math.floor(Math.floor(A/L)/x)}function ae(A,x,L,F){const q=A.updateRanges;if(q.length===0)t.texSubImage2D(n.TEXTURE_2D,0,0,0,x.width,x.height,L,F,x.data);else{q.sort((fe,me)=>fe.start-me.start);let oe=0;for(let fe=1;fe<q.length;fe++){const me=q[oe],de=q[fe],De=me.start+me.count,Ue=ne(de.start,x.width,4),Ve=ne(me.start,x.width,4);de.start<=De+1&&Ue===Ve&&ne(de.start+de.count-1,x.width,4)===Ue?me.count=Math.max(me.count,de.start+de.count-me.start):(++oe,q[oe]=de)}q.length=oe+1;const j=t.getParameter(n.UNPACK_ROW_LENGTH),W=t.getParameter(n.UNPACK_SKIP_PIXELS),ce=t.getParameter(n.UNPACK_SKIP_ROWS);t.pixelStorei(n.UNPACK_ROW_LENGTH,x.width);for(let fe=0,me=q.length;fe<me;fe++){const de=q[fe],De=Math.floor(de.start/4),Ue=Math.ceil(de.count/4),Ve=De%x.width,G=Math.floor(De/x.width),pe=Ue,se=1;t.pixelStorei(n.UNPACK_SKIP_PIXELS,Ve),t.pixelStorei(n.UNPACK_SKIP_ROWS,G),t.texSubImage2D(n.TEXTURE_2D,0,Ve,G,pe,se,L,F,x.data)}A.clearUpdateRanges(),t.pixelStorei(n.UNPACK_ROW_LENGTH,j),t.pixelStorei(n.UNPACK_SKIP_PIXELS,W),t.pixelStorei(n.UNPACK_SKIP_ROWS,ce)}}function Me(A,x,L){let F=n.TEXTURE_2D;(x.isDataArrayTexture||x.isCompressedArrayTexture)&&(F=n.TEXTURE_2D_ARRAY),x.isData3DTexture&&(F=n.TEXTURE_3D);const B=je(A,x),q=x.source;t.bindTexture(F,A.__webglTexture,n.TEXTURE0+L);const oe=i.get(q);if(q.version!==oe.__version||B===!0){if(t.activeTexture(n.TEXTURE0+L),(typeof ImageBitmap<"u"&&x.image instanceof ImageBitmap)===!1){const se=at.getPrimaries(at.workingColorSpace),ge=x.colorSpace===Gi?null:at.getPrimaries(x.colorSpace),xe=x.colorSpace===Gi||se===ge?n.NONE:n.BROWSER_DEFAULT_WEBGL;t.pixelStorei(n.UNPACK_FLIP_Y_WEBGL,x.flipY),t.pixelStorei(n.UNPACK_PREMULTIPLY_ALPHA_WEBGL,x.premultiplyAlpha),t.pixelStorei(n.UNPACK_COLORSPACE_CONVERSION_WEBGL,xe)}t.pixelStorei(n.UNPACK_ALIGNMENT,x.unpackAlignment);let W=p(x.image,!1,r.maxTextureSize);W=Nt(x,W);const ce=s.convert(x.format,x.colorSpace),fe=s.convert(x.type);let me=y(x.internalFormat,ce,fe,x.normalized,x.colorSpace,x.isVideoTexture);Re(F,x);let de;const De=x.mipmaps,Ue=x.isVideoTexture!==!0,Ve=oe.__version===void 0||B===!0,G=q.dataReady,pe=M(x,W);if(x.isDepthTexture)me=S(x.format===dr,x.type),Ve&&(Ue?t.texStorage2D(n.TEXTURE_2D,1,me,W.width,W.height):t.texImage2D(n.TEXTURE_2D,0,me,W.width,W.height,0,ce,fe,null));else if(x.isDataTexture)if(De.length>0){Ue&&Ve&&t.texStorage2D(n.TEXTURE_2D,pe,me,De[0].width,De[0].height);for(let se=0,ge=De.length;se<ge;se++)de=De[se],Ue?G&&t.texSubImage2D(n.TEXTURE_2D,se,0,0,de.width,de.height,ce,fe,de.data):t.texImage2D(n.TEXTURE_2D,se,me,de.width,de.height,0,ce,fe,de.data);x.generateMipmaps=!1}else Ue?(Ve&&t.texStorage2D(n.TEXTURE_2D,pe,me,W.width,W.height),G&&ae(x,W,ce,fe)):t.texImage2D(n.TEXTURE_2D,0,me,W.width,W.height,0,ce,fe,W.data);else if(x.isCompressedTexture)if(x.isCompressedArrayTexture){Ue&&Ve&&t.texStorage3D(n.TEXTURE_2D_ARRAY,pe,me,De[0].width,De[0].height,W.depth);for(let se=0,ge=De.length;se<ge;se++)if(de=De[se],x.format!==$n)if(ce!==null)if(Ue){if(G)if(x.layerUpdates.size>0){const xe=Qf(de.width,de.height,x.format,x.type);for(const le of x.layerUpdates){const Ne=de.data.subarray(le*xe/de.data.BYTES_PER_ELEMENT,(le+1)*xe/de.data.BYTES_PER_ELEMENT);t.compressedTexSubImage3D(n.TEXTURE_2D_ARRAY,se,0,0,le,de.width,de.height,1,ce,Ne)}}else t.compressedTexSubImage3D(n.TEXTURE_2D_ARRAY,se,0,0,0,de.width,de.height,W.depth,ce,de.data)}else t.compressedTexImage3D(n.TEXTURE_2D_ARRAY,se,me,de.width,de.height,W.depth,0,de.data,0,0);else ze("WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()");else Ue?G&&t.texSubImage3D(n.TEXTURE_2D_ARRAY,se,0,0,0,de.width,de.height,W.depth,ce,fe,de.data):t.texImage3D(n.TEXTURE_2D_ARRAY,se,me,de.width,de.height,W.depth,0,ce,fe,de.data);x.layerUpdates.size>0&&x.clearLayerUpdates()}else{Ue&&Ve&&t.texStorage2D(n.TEXTURE_2D,pe,me,De[0].width,De[0].height);for(let se=0,ge=De.length;se<ge;se++)de=De[se],x.format!==$n?ce!==null?Ue?G&&t.compressedTexSubImage2D(n.TEXTURE_2D,se,0,0,de.width,de.height,ce,de.data):t.compressedTexImage2D(n.TEXTURE_2D,se,me,de.width,de.height,0,de.data):ze("WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()"):Ue?G&&t.texSubImage2D(n.TEXTURE_2D,se,0,0,de.width,de.height,ce,fe,de.data):t.texImage2D(n.TEXTURE_2D,se,me,de.width,de.height,0,ce,fe,de.data)}else if(x.isDataArrayTexture)if(Ue){if(Ve&&t.texStorage3D(n.TEXTURE_2D_ARRAY,pe,me,W.width,W.height,W.depth),G)if(x.layerUpdates.size>0){const se=Qf(W.width,W.height,x.format,x.type);for(const ge of x.layerUpdates){const xe=W.data.subarray(ge*se/W.data.BYTES_PER_ELEMENT,(ge+1)*se/W.data.BYTES_PER_ELEMENT);t.texSubImage3D(n.TEXTURE_2D_ARRAY,0,0,0,ge,W.width,W.height,1,ce,fe,xe)}x.clearLayerUpdates()}else t.texSubImage3D(n.TEXTURE_2D_ARRAY,0,0,0,0,W.width,W.height,W.depth,ce,fe,W.data)}else t.texImage3D(n.TEXTURE_2D_ARRAY,0,me,W.width,W.height,W.depth,0,ce,fe,W.data);else if(x.isData3DTexture)Ue?(Ve&&t.texStorage3D(n.TEXTURE_3D,pe,me,W.width,W.height,W.depth),G&&t.texSubImage3D(n.TEXTURE_3D,0,0,0,0,W.width,W.height,W.depth,ce,fe,W.data)):t.texImage3D(n.TEXTURE_3D,0,me,W.width,W.height,W.depth,0,ce,fe,W.data);else if(x.isFramebufferTexture){if(Ve)if(Ue)t.texStorage2D(n.TEXTURE_2D,pe,me,W.width,W.height);else{let se=W.width,ge=W.height;for(let xe=0;xe<pe;xe++)t.texImage2D(n.TEXTURE_2D,xe,me,se,ge,0,ce,fe,null),se>>=1,ge>>=1}}else if(x.isHTMLTexture){if("texElementImage2D"in n){const se=n.canvas;if(se.hasAttribute("layoutsubtree")||se.setAttribute("layoutsubtree","true"),W.parentNode!==se){se.appendChild(W),d.add(x),se.onpaint=ge=>{const xe=ge.changedElements;for(const le of d)xe.includes(le.image)&&(le.needsUpdate=!0)},se.requestPaint();return}if(n.texElementImage2D.length===3)n.texElementImage2D(n.TEXTURE_2D,n.RGBA8,W);else{const xe=n.RGBA,le=n.RGBA,Ne=n.UNSIGNED_BYTE;n.texElementImage2D(n.TEXTURE_2D,0,xe,le,Ne,W)}n.texParameteri(n.TEXTURE_2D,n.TEXTURE_MIN_FILTER,n.LINEAR),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_WRAP_S,n.CLAMP_TO_EDGE),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_WRAP_T,n.CLAMP_TO_EDGE)}}else if(De.length>0){if(Ue&&Ve){const se=nt(De[0]);t.texStorage2D(n.TEXTURE_2D,pe,me,se.width,se.height)}for(let se=0,ge=De.length;se<ge;se++)de=De[se],Ue?G&&t.texSubImage2D(n.TEXTURE_2D,se,0,0,ce,fe,de):t.texImage2D(n.TEXTURE_2D,se,me,ce,fe,de);x.generateMipmaps=!1}else if(Ue){if(Ve){const se=nt(W);t.texStorage2D(n.TEXTURE_2D,pe,me,se.width,se.height)}G&&t.texSubImage2D(n.TEXTURE_2D,0,0,0,ce,fe,W)}else t.texImage2D(n.TEXTURE_2D,0,me,ce,fe,W);m(x)&&v(F),oe.__version=q.version,x.onUpdate&&x.onUpdate(x)}A.__version=x.version}function Be(A,x,L){if(x.image.length!==6)return;const F=je(A,x),B=x.source;t.bindTexture(n.TEXTURE_CUBE_MAP,A.__webglTexture,n.TEXTURE0+L);const q=i.get(B);if(B.version!==q.__version||F===!0){t.activeTexture(n.TEXTURE0+L);const oe=at.getPrimaries(at.workingColorSpace),j=x.colorSpace===Gi?null:at.getPrimaries(x.colorSpace),W=x.colorSpace===Gi||oe===j?n.NONE:n.BROWSER_DEFAULT_WEBGL;t.pixelStorei(n.UNPACK_FLIP_Y_WEBGL,x.flipY),t.pixelStorei(n.UNPACK_PREMULTIPLY_ALPHA_WEBGL,x.premultiplyAlpha),t.pixelStorei(n.UNPACK_ALIGNMENT,x.unpackAlignment),t.pixelStorei(n.UNPACK_COLORSPACE_CONVERSION_WEBGL,W);const ce=x.isCompressedTexture||x.image[0].isCompressedTexture,fe=x.image[0]&&x.image[0].isDataTexture,me=[];for(let le=0;le<6;le++)!ce&&!fe?me[le]=p(x.image[le],!0,r.maxCubemapSize):me[le]=fe?x.image[le].image:x.image[le],me[le]=Nt(x,me[le]);const de=me[0],De=s.convert(x.format,x.colorSpace),Ue=s.convert(x.type),Ve=y(x.internalFormat,De,Ue,x.normalized,x.colorSpace),G=x.isVideoTexture!==!0,pe=q.__version===void 0||F===!0,se=B.dataReady;let ge=M(x,de);Re(n.TEXTURE_CUBE_MAP,x);let xe;if(ce){G&&pe&&t.texStorage2D(n.TEXTURE_CUBE_MAP,ge,Ve,de.width,de.height);for(let le=0;le<6;le++){xe=me[le].mipmaps;for(let Ne=0;Ne<xe.length;Ne++){const Te=xe[Ne];x.format!==$n?De!==null?G?se&&t.compressedTexSubImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+le,Ne,0,0,Te.width,Te.height,De,Te.data):t.compressedTexImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+le,Ne,Ve,Te.width,Te.height,0,Te.data):ze("WebGLRenderer: Attempt to load unsupported compressed texture format in .setTextureCube()"):G?se&&t.texSubImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+le,Ne,0,0,Te.width,Te.height,De,Ue,Te.data):t.texImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+le,Ne,Ve,Te.width,Te.height,0,De,Ue,Te.data)}}}else{if(xe=x.mipmaps,G&&pe){xe.length>0&&ge++;const le=nt(me[0]);t.texStorage2D(n.TEXTURE_CUBE_MAP,ge,Ve,le.width,le.height)}for(let le=0;le<6;le++)if(fe){G?se&&t.texSubImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+le,0,0,0,me[le].width,me[le].height,De,Ue,me[le].data):t.texImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+le,0,Ve,me[le].width,me[le].height,0,De,Ue,me[le].data);for(let Ne=0;Ne<xe.length;Ne++){const pt=xe[Ne].image[le].image;G?se&&t.texSubImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+le,Ne+1,0,0,pt.width,pt.height,De,Ue,pt.data):t.texImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+le,Ne+1,Ve,pt.width,pt.height,0,De,Ue,pt.data)}}else{G?se&&t.texSubImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+le,0,0,0,De,Ue,me[le]):t.texImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+le,0,Ve,De,Ue,me[le]);for(let Ne=0;Ne<xe.length;Ne++){const Te=xe[Ne];G?se&&t.texSubImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+le,Ne+1,0,0,De,Ue,Te.image[le]):t.texImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+le,Ne+1,Ve,De,Ue,Te.image[le])}}}m(x)&&v(n.TEXTURE_CUBE_MAP),q.__version=B.version,x.onUpdate&&x.onUpdate(x)}A.__version=x.version}function ve(A,x,L,F,B,q){const oe=s.convert(L.format,L.colorSpace),j=s.convert(L.type),W=y(L.internalFormat,oe,j,L.normalized,L.colorSpace),ce=i.get(x),fe=i.get(L);if(fe.__renderTarget=x,!ce.__hasExternalTextures){const me=Math.max(1,x.width>>q),de=Math.max(1,x.height>>q);B===n.TEXTURE_3D||B===n.TEXTURE_2D_ARRAY?t.texImage3D(B,q,W,me,de,x.depth,0,oe,j,null):t.texImage2D(B,q,W,me,de,0,oe,j,null)}t.bindFramebuffer(n.FRAMEBUFFER,A),At(x)?o.framebufferTexture2DMultisampleEXT(n.FRAMEBUFFER,F,B,fe.__webglTexture,0,vt(x)):(B===n.TEXTURE_2D||B>=n.TEXTURE_CUBE_MAP_POSITIVE_X&&B<=n.TEXTURE_CUBE_MAP_NEGATIVE_Z)&&n.framebufferTexture2D(n.FRAMEBUFFER,F,B,fe.__webglTexture,q),t.bindFramebuffer(n.FRAMEBUFFER,null)}function ke(A,x,L){if(n.bindRenderbuffer(n.RENDERBUFFER,A),x.depthBuffer){const F=x.depthTexture,B=F&&F.isDepthTexture?F.type:null,q=S(x.stencilBuffer,B),oe=x.stencilBuffer?n.DEPTH_STENCIL_ATTACHMENT:n.DEPTH_ATTACHMENT;At(x)?o.renderbufferStorageMultisampleEXT(n.RENDERBUFFER,vt(x),q,x.width,x.height):L?n.renderbufferStorageMultisample(n.RENDERBUFFER,vt(x),q,x.width,x.height):n.renderbufferStorage(n.RENDERBUFFER,q,x.width,x.height),n.framebufferRenderbuffer(n.FRAMEBUFFER,oe,n.RENDERBUFFER,A)}else{const F=x.textures;for(let B=0;B<F.length;B++){const q=F[B],oe=s.convert(q.format,q.colorSpace),j=s.convert(q.type),W=y(q.internalFormat,oe,j,q.normalized,q.colorSpace);At(x)?o.renderbufferStorageMultisampleEXT(n.RENDERBUFFER,vt(x),W,x.width,x.height):L?n.renderbufferStorageMultisample(n.RENDERBUFFER,vt(x),W,x.width,x.height):n.renderbufferStorage(n.RENDERBUFFER,W,x.width,x.height)}}n.bindRenderbuffer(n.RENDERBUFFER,null)}function Pt(A,x,L){const F=x.isWebGLCubeRenderTarget===!0;if(t.bindFramebuffer(n.FRAMEBUFFER,A),!(x.depthTexture&&x.depthTexture.isDepthTexture))throw new Error("THREE.WebGLTextures: renderTarget.depthTexture must be an instance of THREE.DepthTexture.");const B=i.get(x.depthTexture);if(B.__renderTarget=x,(!B.__webglTexture||x.depthTexture.image.width!==x.width||x.depthTexture.image.height!==x.height)&&(x.depthTexture.image.width=x.width,x.depthTexture.image.height=x.height,x.depthTexture.needsUpdate=!0),F){if(B.__webglInit===void 0&&(B.__webglInit=!0,x.depthTexture.addEventListener("dispose",E)),B.__webglTexture===void 0){B.__webglTexture=n.createTexture(),t.bindTexture(n.TEXTURE_CUBE_MAP,B.__webglTexture),Re(n.TEXTURE_CUBE_MAP,x.depthTexture);const ce=s.convert(x.depthTexture.format),fe=s.convert(x.depthTexture.type);let me;x.depthTexture.format===Ci?me=n.DEPTH_COMPONENT24:x.depthTexture.format===dr&&(me=n.DEPTH24_STENCIL8);for(let de=0;de<6;de++)n.texImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+de,0,me,x.width,x.height,0,ce,fe,null)}}else re(x.depthTexture,0);const q=B.__webglTexture,oe=vt(x),j=F?n.TEXTURE_CUBE_MAP_POSITIVE_X+L:n.TEXTURE_2D,W=x.depthTexture.format===dr?n.DEPTH_STENCIL_ATTACHMENT:n.DEPTH_ATTACHMENT;if(x.depthTexture.format===Ci)At(x)?o.framebufferTexture2DMultisampleEXT(n.FRAMEBUFFER,W,j,q,0,oe):n.framebufferTexture2D(n.FRAMEBUFFER,W,j,q,0);else if(x.depthTexture.format===dr)At(x)?o.framebufferTexture2DMultisampleEXT(n.FRAMEBUFFER,W,j,q,0,oe):n.framebufferTexture2D(n.FRAMEBUFFER,W,j,q,0);else throw new Error("THREE.WebGLTextures: Unknown depthTexture format.")}function $e(A){const x=i.get(A),L=A.isWebGLCubeRenderTarget===!0;if(x.__boundDepthTexture!==A.depthTexture){const F=A.depthTexture;if(x.__depthDisposeCallback&&x.__depthDisposeCallback(),F){const B=()=>{delete x.__boundDepthTexture,delete x.__depthDisposeCallback,F.removeEventListener("dispose",B)};F.addEventListener("dispose",B),x.__depthDisposeCallback=B}x.__boundDepthTexture=F}if(A.depthTexture&&!x.__autoAllocateDepthBuffer)if(L)for(let F=0;F<6;F++)Pt(x.__webglFramebuffer[F],A,F);else{const F=A.texture.mipmaps;F&&F.length>0?Pt(x.__webglFramebuffer[0],A,0):Pt(x.__webglFramebuffer,A,0)}else if(L){x.__webglDepthbuffer=[];for(let F=0;F<6;F++)if(t.bindFramebuffer(n.FRAMEBUFFER,x.__webglFramebuffer[F]),x.__webglDepthbuffer[F]===void 0)x.__webglDepthbuffer[F]=n.createRenderbuffer(),ke(x.__webglDepthbuffer[F],A,!1);else{const B=A.stencilBuffer?n.DEPTH_STENCIL_ATTACHMENT:n.DEPTH_ATTACHMENT,q=x.__webglDepthbuffer[F];n.bindRenderbuffer(n.RENDERBUFFER,q),n.framebufferRenderbuffer(n.FRAMEBUFFER,B,n.RENDERBUFFER,q)}}else{const F=A.texture.mipmaps;if(F&&F.length>0?t.bindFramebuffer(n.FRAMEBUFFER,x.__webglFramebuffer[0]):t.bindFramebuffer(n.FRAMEBUFFER,x.__webglFramebuffer),x.__webglDepthbuffer===void 0)x.__webglDepthbuffer=n.createRenderbuffer(),ke(x.__webglDepthbuffer,A,!1);else{const B=A.stencilBuffer?n.DEPTH_STENCIL_ATTACHMENT:n.DEPTH_ATTACHMENT,q=x.__webglDepthbuffer;n.bindRenderbuffer(n.RENDERBUFFER,q),n.framebufferRenderbuffer(n.FRAMEBUFFER,B,n.RENDERBUFFER,q)}}t.bindFramebuffer(n.FRAMEBUFFER,null)}function Ke(A,x,L){const F=i.get(A);x!==void 0&&ve(F.__webglFramebuffer,A,A.texture,n.COLOR_ATTACHMENT0,n.TEXTURE_2D,0),L!==void 0&&$e(A)}function rt(A){const x=A.texture,L=i.get(A),F=i.get(x);A.addEventListener("dispose",b);const B=A.textures,q=A.isWebGLCubeRenderTarget===!0,oe=B.length>1;if(oe||(F.__webglTexture===void 0&&(F.__webglTexture=n.createTexture()),F.__version=x.version,a.memory.textures++),q){L.__webglFramebuffer=[];for(let j=0;j<6;j++)if(x.mipmaps&&x.mipmaps.length>0){L.__webglFramebuffer[j]=[];for(let W=0;W<x.mipmaps.length;W++)L.__webglFramebuffer[j][W]=n.createFramebuffer()}else L.__webglFramebuffer[j]=n.createFramebuffer()}else{if(x.mipmaps&&x.mipmaps.length>0){L.__webglFramebuffer=[];for(let j=0;j<x.mipmaps.length;j++)L.__webglFramebuffer[j]=n.createFramebuffer()}else L.__webglFramebuffer=n.createFramebuffer();if(oe)for(let j=0,W=B.length;j<W;j++){const ce=i.get(B[j]);ce.__webglTexture===void 0&&(ce.__webglTexture=n.createTexture(),a.memory.textures++)}if(A.samples>0&&At(A)===!1){L.__webglMultisampledFramebuffer=n.createFramebuffer(),L.__webglColorRenderbuffer=[],t.bindFramebuffer(n.FRAMEBUFFER,L.__webglMultisampledFramebuffer);for(let j=0;j<B.length;j++){const W=B[j];L.__webglColorRenderbuffer[j]=n.createRenderbuffer(),n.bindRenderbuffer(n.RENDERBUFFER,L.__webglColorRenderbuffer[j]);const ce=s.convert(W.format,W.colorSpace),fe=s.convert(W.type),me=y(W.internalFormat,ce,fe,W.normalized,W.colorSpace,A.isXRRenderTarget===!0),de=vt(A);n.renderbufferStorageMultisample(n.RENDERBUFFER,de,me,A.width,A.height),n.framebufferRenderbuffer(n.FRAMEBUFFER,n.COLOR_ATTACHMENT0+j,n.RENDERBUFFER,L.__webglColorRenderbuffer[j])}n.bindRenderbuffer(n.RENDERBUFFER,null),A.depthBuffer&&(L.__webglDepthRenderbuffer=n.createRenderbuffer(),ke(L.__webglDepthRenderbuffer,A,!0)),t.bindFramebuffer(n.FRAMEBUFFER,null)}}if(q){t.bindTexture(n.TEXTURE_CUBE_MAP,F.__webglTexture),Re(n.TEXTURE_CUBE_MAP,x);for(let j=0;j<6;j++)if(x.mipmaps&&x.mipmaps.length>0)for(let W=0;W<x.mipmaps.length;W++)ve(L.__webglFramebuffer[j][W],A,x,n.COLOR_ATTACHMENT0,n.TEXTURE_CUBE_MAP_POSITIVE_X+j,W);else ve(L.__webglFramebuffer[j],A,x,n.COLOR_ATTACHMENT0,n.TEXTURE_CUBE_MAP_POSITIVE_X+j,0);m(x)&&v(n.TEXTURE_CUBE_MAP),t.unbindTexture()}else if(oe){for(let j=0,W=B.length;j<W;j++){const ce=B[j],fe=i.get(ce);let me=n.TEXTURE_2D;(A.isWebGL3DRenderTarget||A.isWebGLArrayRenderTarget)&&(me=A.isWebGL3DRenderTarget?n.TEXTURE_3D:n.TEXTURE_2D_ARRAY),t.bindTexture(me,fe.__webglTexture),Re(me,ce),ve(L.__webglFramebuffer,A,ce,n.COLOR_ATTACHMENT0+j,me,0),m(ce)&&v(me)}t.unbindTexture()}else{let j=n.TEXTURE_2D;if((A.isWebGL3DRenderTarget||A.isWebGLArrayRenderTarget)&&(j=A.isWebGL3DRenderTarget?n.TEXTURE_3D:n.TEXTURE_2D_ARRAY),t.bindTexture(j,F.__webglTexture),Re(j,x),x.mipmaps&&x.mipmaps.length>0)for(let W=0;W<x.mipmaps.length;W++)ve(L.__webglFramebuffer[W],A,x,n.COLOR_ATTACHMENT0,j,W);else ve(L.__webglFramebuffer,A,x,n.COLOR_ATTACHMENT0,j,0);m(x)&&v(j),t.unbindTexture()}A.depthBuffer&&$e(A)}function qe(A){const x=A.textures;for(let L=0,F=x.length;L<F;L++){const B=x[L];if(m(B)){const q=w(A),oe=i.get(B).__webglTexture;t.bindTexture(q,oe),v(q),t.unbindTexture()}}}const ot=[],Dt=[];function Tt(A){if(A.samples>0){if(At(A)===!1){const x=A.textures,L=A.width,F=A.height;let B=n.COLOR_BUFFER_BIT;const q=A.stencilBuffer?n.DEPTH_STENCIL_ATTACHMENT:n.DEPTH_ATTACHMENT,oe=i.get(A),j=x.length>1;if(j)for(let ce=0;ce<x.length;ce++)t.bindFramebuffer(n.FRAMEBUFFER,oe.__webglMultisampledFramebuffer),n.framebufferRenderbuffer(n.FRAMEBUFFER,n.COLOR_ATTACHMENT0+ce,n.RENDERBUFFER,null),t.bindFramebuffer(n.FRAMEBUFFER,oe.__webglFramebuffer),n.framebufferTexture2D(n.DRAW_FRAMEBUFFER,n.COLOR_ATTACHMENT0+ce,n.TEXTURE_2D,null,0);t.bindFramebuffer(n.READ_FRAMEBUFFER,oe.__webglMultisampledFramebuffer);const W=A.texture.mipmaps;W&&W.length>0?t.bindFramebuffer(n.DRAW_FRAMEBUFFER,oe.__webglFramebuffer[0]):t.bindFramebuffer(n.DRAW_FRAMEBUFFER,oe.__webglFramebuffer);for(let ce=0;ce<x.length;ce++){if(A.resolveDepthBuffer&&(A.depthBuffer&&(B|=n.DEPTH_BUFFER_BIT),A.stencilBuffer&&A.resolveStencilBuffer&&(B|=n.STENCIL_BUFFER_BIT)),j){n.framebufferRenderbuffer(n.READ_FRAMEBUFFER,n.COLOR_ATTACHMENT0,n.RENDERBUFFER,oe.__webglColorRenderbuffer[ce]);const fe=i.get(x[ce]).__webglTexture;n.framebufferTexture2D(n.DRAW_FRAMEBUFFER,n.COLOR_ATTACHMENT0,n.TEXTURE_2D,fe,0)}n.blitFramebuffer(0,0,L,F,0,0,L,F,B,n.NEAREST),l===!0&&(ot.length=0,Dt.length=0,ot.push(n.COLOR_ATTACHMENT0+ce),A.depthBuffer&&A.storeMultisampledDepthBuffer===!1&&(ot.push(q),Dt.push(q),n.invalidateFramebuffer(n.DRAW_FRAMEBUFFER,Dt)),n.invalidateFramebuffer(n.READ_FRAMEBUFFER,ot))}if(t.bindFramebuffer(n.READ_FRAMEBUFFER,null),t.bindFramebuffer(n.DRAW_FRAMEBUFFER,null),j)for(let ce=0;ce<x.length;ce++){t.bindFramebuffer(n.FRAMEBUFFER,oe.__webglMultisampledFramebuffer),n.framebufferRenderbuffer(n.FRAMEBUFFER,n.COLOR_ATTACHMENT0+ce,n.RENDERBUFFER,oe.__webglColorRenderbuffer[ce]);const fe=i.get(x[ce]).__webglTexture;t.bindFramebuffer(n.FRAMEBUFFER,oe.__webglFramebuffer),n.framebufferTexture2D(n.DRAW_FRAMEBUFFER,n.COLOR_ATTACHMENT0+ce,n.TEXTURE_2D,fe,0)}t.bindFramebuffer(n.DRAW_FRAMEBUFFER,oe.__webglMultisampledFramebuffer)}else if(A.depthBuffer&&A.storeMultisampledDepthBuffer===!1&&l){const x=A.stencilBuffer?n.DEPTH_STENCIL_ATTACHMENT:n.DEPTH_ATTACHMENT;n.invalidateFramebuffer(n.DRAW_FRAMEBUFFER,[x])}}}function vt(A){return Math.min(r.maxSamples,A.samples)}function At(A){const x=i.get(A);return A.samples>0&&e.has("WEBGL_multisampled_render_to_texture")===!0&&x.__useRenderToTexture!==!1}function V(A){const x=a.render.frame;f.get(A)!==x&&(f.set(A,x),A.update())}function Nt(A,x){const L=A.colorSpace,F=A.format,B=A.type;return A.isCompressedTexture===!0||A.isVideoTexture===!0||L!==bo&&L!==Gi&&(at.getTransfer(L)===mt?(F!==$n||B!==Bn)&&ze("WebGLTextures: sRGB encoded textures have to use RGBAFormat and UnsignedByteType."):ut("WebGLTextures: Unsupported texture color space:",L)),x}function nt(A){return typeof HTMLImageElement<"u"&&A instanceof HTMLImageElement?(c.width=A.naturalWidth||A.width,c.height=A.naturalHeight||A.height):typeof VideoFrame<"u"&&A instanceof VideoFrame?(c.width=A.displayWidth,c.height=A.displayHeight):(c.width=A.width,c.height=A.height),c}this.allocateTextureUnit=$,this.resetTextureUnits=N,this.getTextureUnits=I,this.setTextureUnits=z,this.setTexture2D=re,this.setTexture2DArray=J,this.setTexture3D=Q,this.setTextureCube=te,this.rebindTextures=Ke,this.setupRenderTarget=rt,this.updateRenderTargetMipmap=qe,this.updateMultisampleRenderTarget=Tt,this.setupDepthRenderbuffer=$e,this.setupFrameBufferTexture=ve,this.useMultisampledRTT=At,this.isReversedDepthBuffer=function(){return t.buffers.depth.getReversed()}}function yM(n,e){function t(i,r=Gi){let s;const a=at.getTransfer(r);if(i===Bn)return n.UNSIGNED_BYTE;if(i===yu)return n.UNSIGNED_SHORT_4_4_4_4;if(i===bu)return n.UNSIGNED_SHORT_5_5_5_1;if(i===_p)return n.UNSIGNED_INT_5_9_9_9_REV;if(i===vp)return n.UNSIGNED_INT_10F_11F_11F_REV;if(i===mp)return n.BYTE;if(i===gp)return n.SHORT;if(i===Is)return n.UNSIGNED_SHORT;if(i===xu)return n.INT;if(i===ci)return n.UNSIGNED_INT;if(i===si)return n.FLOAT;if(i===ui)return n.HALF_FLOAT;if(i===xp)return n.ALPHA;if(i===yp)return n.RGB;if(i===$n)return n.RGBA;if(i===Ci)return n.DEPTH_COMPONENT;if(i===dr)return n.DEPTH_STENCIL;if(i===bp)return n.RED;if(i===Su)return n.RED_INTEGER;if(i===mr)return n.RG;if(i===Mu)return n.RG_INTEGER;if(i===wu)return n.RGBA_INTEGER;if(i===eo||i===to||i===no||i===io)if(a===mt)if(s=e.get("WEBGL_compressed_texture_s3tc_srgb"),s!==null){if(i===eo)return s.COMPRESSED_SRGB_S3TC_DXT1_EXT;if(i===to)return s.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT;if(i===no)return s.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT;if(i===io)return s.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT}else return null;else if(s=e.get("WEBGL_compressed_texture_s3tc"),s!==null){if(i===eo)return s.COMPRESSED_RGB_S3TC_DXT1_EXT;if(i===to)return s.COMPRESSED_RGBA_S3TC_DXT1_EXT;if(i===no)return s.COMPRESSED_RGBA_S3TC_DXT3_EXT;if(i===io)return s.COMPRESSED_RGBA_S3TC_DXT5_EXT}else return null;if(i===dc||i===hc||i===pc||i===mc)if(s=e.get("WEBGL_compressed_texture_pvrtc"),s!==null){if(i===dc)return s.COMPRESSED_RGB_PVRTC_4BPPV1_IMG;if(i===hc)return s.COMPRESSED_RGB_PVRTC_2BPPV1_IMG;if(i===pc)return s.COMPRESSED_RGBA_PVRTC_4BPPV1_IMG;if(i===mc)return s.COMPRESSED_RGBA_PVRTC_2BPPV1_IMG}else return null;if(i===gc||i===_c||i===vc||i===xc||i===yc||i===xo||i===bc)if(s=e.get("WEBGL_compressed_texture_etc"),s!==null){if(i===gc||i===_c)return a===mt?s.COMPRESSED_SRGB8_ETC2:s.COMPRESSED_RGB8_ETC2;if(i===vc)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC:s.COMPRESSED_RGBA8_ETC2_EAC;if(i===xc)return s.COMPRESSED_R11_EAC;if(i===yc)return s.COMPRESSED_SIGNED_R11_EAC;if(i===xo)return s.COMPRESSED_RG11_EAC;if(i===bc)return s.COMPRESSED_SIGNED_RG11_EAC}else return null;if(i===Sc||i===Mc||i===wc||i===Ec||i===Tc||i===Ac||i===Rc||i===Cc||i===Pc||i===Lc||i===Dc||i===Nc||i===Ic||i===Uc)if(s=e.get("WEBGL_compressed_texture_astc"),s!==null){if(i===Sc)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR:s.COMPRESSED_RGBA_ASTC_4x4_KHR;if(i===Mc)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_5x4_KHR:s.COMPRESSED_RGBA_ASTC_5x4_KHR;if(i===wc)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_5x5_KHR:s.COMPRESSED_RGBA_ASTC_5x5_KHR;if(i===Ec)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_6x5_KHR:s.COMPRESSED_RGBA_ASTC_6x5_KHR;if(i===Tc)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_6x6_KHR:s.COMPRESSED_RGBA_ASTC_6x6_KHR;if(i===Ac)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_8x5_KHR:s.COMPRESSED_RGBA_ASTC_8x5_KHR;if(i===Rc)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_8x6_KHR:s.COMPRESSED_RGBA_ASTC_8x6_KHR;if(i===Cc)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_8x8_KHR:s.COMPRESSED_RGBA_ASTC_8x8_KHR;if(i===Pc)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_10x5_KHR:s.COMPRESSED_RGBA_ASTC_10x5_KHR;if(i===Lc)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_10x6_KHR:s.COMPRESSED_RGBA_ASTC_10x6_KHR;if(i===Dc)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_10x8_KHR:s.COMPRESSED_RGBA_ASTC_10x8_KHR;if(i===Nc)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_10x10_KHR:s.COMPRESSED_RGBA_ASTC_10x10_KHR;if(i===Ic)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_12x10_KHR:s.COMPRESSED_RGBA_ASTC_12x10_KHR;if(i===Uc)return a===mt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR:s.COMPRESSED_RGBA_ASTC_12x12_KHR}else return null;if(i===Fc||i===Bc||i===Oc)if(s=e.get("EXT_texture_compression_bptc"),s!==null){if(i===Fc)return a===mt?s.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT:s.COMPRESSED_RGBA_BPTC_UNORM_EXT;if(i===Bc)return s.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT;if(i===Oc)return s.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT}else return null;if(i===kc||i===zc||i===yo||i===Vc)if(s=e.get("EXT_texture_compression_rgtc"),s!==null){if(i===kc)return s.COMPRESSED_RED_RGTC1_EXT;if(i===zc)return s.COMPRESSED_SIGNED_RED_RGTC1_EXT;if(i===yo)return s.COMPRESSED_RED_GREEN_RGTC2_EXT;if(i===Vc)return s.COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT}else return null;return i===Us?n.UNSIGNED_INT_24_8:n[i]!==void 0?n[i]:null}return{convert:t}}const bM=`
void main() {

	gl_Position = vec4( position, 1.0 );

}`,SM=`
uniform sampler2DArray depthColor;
uniform float depthWidth;
uniform float depthHeight;

void main() {

	vec2 coord = vec2( gl_FragCoord.x / depthWidth, gl_FragCoord.y / depthHeight );

	if ( coord.x >= 1.0 ) {

		gl_FragDepth = texture( depthColor, vec3( coord.x - 1.0, coord.y, 1 ) ).r;

	} else {

		gl_FragDepth = texture( depthColor, vec3( coord.x, coord.y, 0 ) ).r;

	}

}`;class MM{constructor(){this.texture=null,this.mesh=null,this.depthNear=0,this.depthFar=0}init(e,t){if(this.texture===null){const i=new Ip(e.texture);(e.depthNear!==t.depthNear||e.depthFar!==t.depthFar)&&(this.depthNear=e.depthNear,this.depthFar=e.depthFar),this.texture=i}}getMesh(e){if(this.texture!==null&&this.mesh===null){const t=e.cameras[0].viewport,i=new Pn({vertexShader:bM,fragmentShader:SM,uniforms:{depthColor:{value:this.texture},depthWidth:{value:t.z},depthHeight:{value:t.w}}});this.mesh=new dn(new ts(20,20),i)}return this.mesh}reset(){this.texture=null,this.mesh=null}getDepthTexture(){return this.texture}}class wM extends vr{constructor(e,t){super();const i=this;let r=null,s=1,a=null,o="local-floor",l=1,c=null,f=null,d=null,u=null,h=null,_=null;const g=typeof XRWebGLBinding<"u",p=new MM,m={},v=t.getContextAttributes();let w=null,y=null;const S=[],M=[],E=new Ze;let b=null,T=null;const C=new Rn;C.viewport=new bt;const D=new Rn;D.viewport=new bt;const R=[C,D],N=new Pv;let I=null,z=null;this.cameraAutoUpdate=!0,this.enabled=!1,this.isPresenting=!1,this.getController=function(ne){let ae=S[ne];return ae===void 0&&(ae=new sl,S[ne]=ae),ae.getTargetRaySpace()},this.getControllerGrip=function(ne){let ae=S[ne];return ae===void 0&&(ae=new sl,S[ne]=ae),ae.getGripSpace()},this.getHand=function(ne){let ae=S[ne];return ae===void 0&&(ae=new sl,S[ne]=ae),ae.getHandSpace()};function $(ne){const ae=M.indexOf(ne.inputSource);if(ae===-1)return;const Me=S[ae];Me!==void 0&&(Me.update(ne.inputSource,ne.frame,c||a),Me.dispatchEvent({type:ne.type,data:ne.inputSource}))}function X(){r.removeEventListener("select",$),r.removeEventListener("selectstart",$),r.removeEventListener("selectend",$),r.removeEventListener("squeeze",$),r.removeEventListener("squeezestart",$),r.removeEventListener("squeezeend",$),r.removeEventListener("end",X),r.removeEventListener("inputsourceschange",re);for(let ne=0;ne<S.length;ne++){const ae=M[ne];ae!==null&&(M[ne]=null,S[ne].disconnect(ae))}I=null,z=null,p.reset();for(const ne in m)delete m[ne];if(e.setRenderTarget(w),h=null,u=null,d=null,r=null,y=null,je.stop(),i.isPresenting=!1,e.setPixelRatio(b),e.setSize(E.width,E.height,!1),T!==null){const ne=T.camera;ne.fov=T.fov,ne.zoom=T.zoom,ne.updateProjectionMatrix(),T=null}i.dispatchEvent({type:"sessionend"})}this.setFramebufferScaleFactor=function(ne){s=ne,i.isPresenting===!0&&ze("WebXRManager: Cannot change framebuffer scale while presenting.")},this.setReferenceSpaceType=function(ne){o=ne,i.isPresenting===!0&&ze("WebXRManager: Cannot change reference space type while presenting.")},this.getReferenceSpace=function(){return c||a},this.setReferenceSpace=function(ne){c=ne},this.getBaseLayer=function(){return u!==null?u:h},this.getBinding=function(){return d===null&&g&&(d=new XRWebGLBinding(r,t)),d},this.getFrame=function(){return _},this.getSession=function(){return r},this.setSession=async function(ne){if(r=ne,r!==null){if(w=e.getRenderTarget(),r.addEventListener("select",$),r.addEventListener("selectstart",$),r.addEventListener("selectend",$),r.addEventListener("squeeze",$),r.addEventListener("squeezestart",$),r.addEventListener("squeezeend",$),r.addEventListener("end",X),r.addEventListener("inputsourceschange",re),v.xrCompatible!==!0&&await t.makeXRCompatible(),b=e.getPixelRatio(),e.getSize(E),g&&"createProjectionLayer"in XRWebGLBinding.prototype){let Me=null,Be=null,ve=null;v.depth&&(ve=v.stencil?t.DEPTH24_STENCIL8:t.DEPTH_COMPONENT24,Me=v.stencil?dr:Ci,Be=v.stencil?Us:ci);const ke={colorFormat:t.RGBA8,depthFormat:ve,scaleFactor:s};d=this.getBinding(),u=d.createProjectionLayer(ke),r.updateRenderState({layers:[u]}),e.setPixelRatio(1),e.setSize(u.textureWidth,u.textureHeight,!1),y=new qn(u.textureWidth,u.textureHeight,{format:$n,type:Bn,depthTexture:new Bs(u.textureWidth,u.textureHeight,Be,void 0,void 0,void 0,void 0,void 0,void 0,Me),stencilBuffer:v.stencil,colorSpace:e.outputColorSpace,samples:v.antialias?4:0,resolveDepthBuffer:u.ignoreDepthValues===!1,resolveStencilBuffer:u.ignoreDepthValues===!1,storeMultisampledDepthBuffer:u.ignoreDepthValues===!1,storeMultisampledStencilBuffer:u.ignoreDepthValues===!1})}else{const Me={antialias:v.antialias,alpha:!0,depth:v.depth,stencil:v.stencil,framebufferScaleFactor:s};h=new XRWebGLLayer(r,t,Me),r.updateRenderState({baseLayer:h}),e.setPixelRatio(1),e.setSize(h.framebufferWidth,h.framebufferHeight,!1),y=new qn(h.framebufferWidth,h.framebufferHeight,{format:$n,type:Bn,colorSpace:e.outputColorSpace,stencilBuffer:v.stencil,resolveDepthBuffer:h.ignoreDepthValues===!1,resolveStencilBuffer:h.ignoreDepthValues===!1,storeMultisampledDepthBuffer:h.ignoreDepthValues===!1,storeMultisampledStencilBuffer:h.ignoreDepthValues===!1})}y.isXRRenderTarget=!0,this.setFoveation(l),c=null,a=await r.requestReferenceSpace(o),je.setContext(r),je.start(),i.isPresenting=!0,i.dispatchEvent({type:"sessionstart"})}},this.getEnvironmentBlendMode=function(){if(r!==null)return r.environmentBlendMode},this.getDepthTexture=function(){return p.getDepthTexture()};function re(ne){for(let ae=0;ae<ne.removed.length;ae++){const Me=ne.removed[ae],Be=M.indexOf(Me);Be>=0&&(M[Be]=null,S[Be].disconnect(Me))}for(let ae=0;ae<ne.added.length;ae++){const Me=ne.added[ae];let Be=M.indexOf(Me);if(Be===-1){for(let ke=0;ke<S.length;ke++)if(ke>=M.length){M.push(Me),Be=ke;break}else if(M[ke]===null){M[ke]=Me,Be=ke;break}if(Be===-1)break}const ve=S[Be];ve&&ve.connect(Me)}}const J=new U,Q=new U;function te(ne,ae,Me){J.setFromMatrixPosition(ae.matrixWorld),Q.setFromMatrixPosition(Me.matrixWorld);const Be=J.distanceTo(Q),ve=ae.projectionMatrix.elements,ke=Me.projectionMatrix.elements,Pt=ve[14]/(ve[10]-1),$e=ve[14]/(ve[10]+1),Ke=(ve[9]+1)/ve[5],rt=(ve[9]-1)/ve[5],qe=(ve[8]-1)/ve[0],ot=(ke[8]+1)/ke[0],Dt=Pt*qe,Tt=Pt*ot,vt=Be/(-qe+ot),At=vt*-qe;if(ae.matrixWorld.decompose(ne.position,ne.quaternion,ne.scale),ne.translateX(At),ne.translateZ(vt),ne.matrixWorld.compose(ne.position,ne.quaternion,ne.scale),ne.matrixWorldInverse.copy(ne.matrixWorld).invert(),ve[10]===-1)ne.projectionMatrix.copy(ae.projectionMatrix),ne.projectionMatrixInverse.copy(ae.projectionMatrixInverse);else{const V=Pt+vt,Nt=$e+vt,nt=Dt-At,A=Tt+(Be-At),x=Ke*$e/Nt*V,L=rt*$e/Nt*V;ne.projectionMatrix.makePerspective(nt,A,x,L,V,Nt),ne.projectionMatrixInverse.copy(ne.projectionMatrix).invert()}}function ue(ne,ae){ae===null?ne.matrixWorld.copy(ne.matrix):ne.matrixWorld.multiplyMatrices(ae.matrixWorld,ne.matrix),ne.matrixWorldInverse.copy(ne.matrixWorld).invert()}this.updateCamera=function(ne){if(r===null)return;let ae=ne.near,Me=ne.far;p.texture!==null&&(p.depthNear>0&&(ae=p.depthNear),p.depthFar>0&&(Me=p.depthFar)),N.near=D.near=C.near=ae,N.far=D.far=C.far=Me,(I!==N.near||z!==N.far)&&(r.updateRenderState({depthNear:N.near,depthFar:N.far}),I=N.near,z=N.far),N.layers.mask=ne.layers.mask|6,C.layers.mask=N.layers.mask&-5,D.layers.mask=N.layers.mask&-3;const Be=ne.parent,ve=N.cameras;ue(N,Be);for(let ke=0;ke<ve.length;ke++)ue(ve[ke],Be);ve.length===2?te(N,C,D):N.projectionMatrix.copy(C.projectionMatrix),T===null&&ne.isPerspectiveCamera&&(T={camera:ne,fov:ne.fov,zoom:ne.zoom}),be(ne,N,Be)};function be(ne,ae,Me){Me===null?ne.matrix.copy(ae.matrixWorld):(ne.matrix.copy(Me.matrixWorld),ne.matrix.invert(),ne.matrix.multiply(ae.matrixWorld)),ne.matrix.decompose(ne.position,ne.quaternion,ne.scale),ne.updateMatrixWorld(!0),ne.projectionMatrix.copy(ae.projectionMatrix),ne.projectionMatrixInverse.copy(ae.projectionMatrixInverse),ne.isPerspectiveCamera&&(ne.fov=Fs*2*Math.atan(1/ne.projectionMatrix.elements[5]),ne.zoom=1)}this.getCamera=function(){return N},this.getFoveation=function(){if(!(u===null&&h===null))return l},this.setFoveation=function(ne){l=ne,u!==null&&(u.fixedFoveation=ne),h!==null&&h.fixedFoveation!==void 0&&(h.fixedFoveation=ne)},this.hasDepthSensing=function(){return p.texture!==null},this.getDepthSensingMesh=function(){return p.getMesh(N)},this.getCameraTexture=function(ne){return m[ne]};let Fe=null;function Re(ne,ae){if(f=ae.getViewerPose(c||a),_=ae,f!==null){const Me=f.views;h!==null&&(e.setRenderTargetFramebuffer(y,h.framebuffer),e.setRenderTarget(y));let Be=!1;Me.length!==N.cameras.length&&(N.cameras.length=0,Be=!0);for(let $e=0;$e<Me.length;$e++){const Ke=Me[$e];let rt=null;if(h!==null)rt=h.getViewport(Ke);else{const ot=d.getViewSubImage(u,Ke);rt=ot.viewport,$e===0&&(e.setRenderTargetTextures(y,ot.colorTexture,ot.depthStencilTexture),e.setRenderTarget(y))}let qe=R[$e];qe===void 0&&(qe=new Rn,qe.layers.enable($e),qe.viewport=new bt,R[$e]=qe),qe.matrix.fromArray(Ke.transform.matrix),qe.matrix.decompose(qe.position,qe.quaternion,qe.scale),qe.projectionMatrix.fromArray(Ke.projectionMatrix),qe.projectionMatrixInverse.copy(qe.projectionMatrix).invert(),qe.viewport.set(rt.x,rt.y,rt.width,rt.height),$e===0&&(N.matrix.copy(qe.matrix),N.matrix.decompose(N.position,N.quaternion,N.scale)),Be===!0&&N.cameras.push(qe)}const ve=r.enabledFeatures;if(ve&&ve.includes("depth-sensing")&&r.depthUsage=="gpu-optimized"&&g){d=i.getBinding();const $e=d.getDepthInformation(Me[0]);$e&&$e.isValid&&$e.texture&&p.init($e,r.renderState)}if(ve&&ve.includes("camera-access")&&g){e.state.unbindTexture(),d=i.getBinding();for(let $e=0;$e<Me.length;$e++){const Ke=Me[$e].camera;if(Ke){let rt=m[Ke];rt||(rt=new Ip,m[Ke]=rt);const qe=d.getCameraImage(Ke);rt.sourceTexture=qe}}}}for(let Me=0;Me<S.length;Me++){const Be=M[Me],ve=S[Me];Be!==null&&ve!==void 0&&ve.update(Be,ae,c||a)}Fe&&Fe(ne,ae),ae.detectedPlanes&&i.dispatchEvent({type:"planesdetected",data:ae}),_=null}const je=new Op;je.setAnimationLoop(Re),this.setAnimationLoop=function(ne){Fe=ne},this.dispose=function(){}}}const EM=new et,$p=new We;$p.set(-1,0,0,0,1,0,0,0,1);function TM(n,e){function t(p,m){p.matrixAutoUpdate===!0&&p.updateMatrix(),m.value.copy(p.matrix)}function i(p,m){m.color.getRGB(p.fogColor.value,Up(n)),m.isFog?(p.fogNear.value=m.near,p.fogFar.value=m.far):m.isFogExp2&&(p.fogDensity.value=m.density)}function r(p,m,v,w,y){m.isNodeMaterial?m.uniformsNeedUpdate=!1:m.isMeshBasicMaterial?s(p,m):m.isMeshLambertMaterial?(s(p,m),m.envMap&&(p.envMapIntensity.value=m.envMapIntensity)):m.isMeshToonMaterial?(s(p,m),d(p,m)):m.isMeshPhongMaterial?(s(p,m),f(p,m),m.envMap&&(p.envMapIntensity.value=m.envMapIntensity)):m.isMeshStandardMaterial?(s(p,m),u(p,m),m.isMeshPhysicalMaterial&&h(p,m,y)):m.isMeshMatcapMaterial?(s(p,m),_(p,m)):m.isMeshDepthMaterial?s(p,m):m.isMeshDistanceMaterial?(s(p,m),g(p,m)):m.isMeshNormalMaterial?s(p,m):m.isLineBasicMaterial?(a(p,m),m.isLineDashedMaterial&&o(p,m)):m.isPointsMaterial?l(p,m,v,w):m.isSpriteMaterial?c(p,m):m.isShadowMaterial?(p.color.value.copy(m.color),p.opacity.value=m.opacity):m.isShaderMaterial&&(m.uniformsNeedUpdate=!1)}function s(p,m){p.opacity.value=m.opacity,m.color&&p.diffuse.value.copy(m.color),m.emissive&&p.emissive.value.copy(m.emissive).multiplyScalar(m.emissiveIntensity),m.map&&(p.map.value=m.map,t(m.map,p.mapTransform)),m.alphaMap&&(p.alphaMap.value=m.alphaMap,t(m.alphaMap,p.alphaMapTransform)),m.bumpMap&&(p.bumpMap.value=m.bumpMap,t(m.bumpMap,p.bumpMapTransform),p.bumpScale.value=m.bumpScale,m.side===fn&&(p.bumpScale.value*=-1)),m.normalMap&&(p.normalMap.value=m.normalMap,t(m.normalMap,p.normalMapTransform),p.normalScale.value.copy(m.normalScale),m.side===fn&&p.normalScale.value.negate()),m.displacementMap&&(p.displacementMap.value=m.displacementMap,t(m.displacementMap,p.displacementMapTransform),p.displacementScale.value=m.displacementScale,p.displacementBias.value=m.displacementBias),m.emissiveMap&&(p.emissiveMap.value=m.emissiveMap,t(m.emissiveMap,p.emissiveMapTransform)),m.specularMap&&(p.specularMap.value=m.specularMap,t(m.specularMap,p.specularMapTransform)),m.alphaTest>0&&(p.alphaTest.value=m.alphaTest);const v=e.get(m),w=v.envMap,y=v.envMapRotation;w&&(p.envMap.value=w,p.envMapRotation.value.setFromMatrix4(EM.makeRotationFromEuler(y)).transpose(),w.isCubeTexture&&w.isRenderTargetTexture===!1&&p.envMapRotation.value.premultiply($p),p.reflectivity.value=m.reflectivity,p.ior.value=m.ior,p.refractionRatio.value=m.refractionRatio),m.lightMap&&(p.lightMap.value=m.lightMap,p.lightMapIntensity.value=m.lightMapIntensity,t(m.lightMap,p.lightMapTransform)),m.aoMap&&(p.aoMap.value=m.aoMap,p.aoMapIntensity.value=m.aoMapIntensity,t(m.aoMap,p.aoMapTransform))}function a(p,m){p.diffuse.value.copy(m.color),p.opacity.value=m.opacity,m.map&&(p.map.value=m.map,t(m.map,p.mapTransform))}function o(p,m){p.dashSize.value=m.dashSize,p.totalSize.value=m.dashSize+m.gapSize,p.scale.value=m.scale}function l(p,m,v,w){p.diffuse.value.copy(m.color),p.opacity.value=m.opacity,p.size.value=m.size*v,p.scale.value=w*.5,m.map&&(p.map.value=m.map,t(m.map,p.uvTransform)),m.alphaMap&&(p.alphaMap.value=m.alphaMap,t(m.alphaMap,p.alphaMapTransform)),m.alphaTest>0&&(p.alphaTest.value=m.alphaTest)}function c(p,m){p.diffuse.value.copy(m.color),p.opacity.value=m.opacity,p.rotation.value=m.rotation,m.map&&(p.map.value=m.map,t(m.map,p.mapTransform)),m.alphaMap&&(p.alphaMap.value=m.alphaMap,t(m.alphaMap,p.alphaMapTransform)),m.alphaTest>0&&(p.alphaTest.value=m.alphaTest)}function f(p,m){p.specular.value.copy(m.specular),p.shininess.value=Math.max(m.shininess,1e-4)}function d(p,m){m.gradientMap&&(p.gradientMap.value=m.gradientMap)}function u(p,m){p.metalness.value=m.metalness,m.metalnessMap&&(p.metalnessMap.value=m.metalnessMap,t(m.metalnessMap,p.metalnessMapTransform)),p.roughness.value=m.roughness,m.roughnessMap&&(p.roughnessMap.value=m.roughnessMap,t(m.roughnessMap,p.roughnessMapTransform)),m.envMap&&(p.envMapIntensity.value=m.envMapIntensity)}function h(p,m,v){p.ior.value=m.ior,m.sheen>0&&(p.sheenColor.value.copy(m.sheenColor).multiplyScalar(m.sheen),p.sheenRoughness.value=m.sheenRoughness,m.sheenColorMap&&(p.sheenColorMap.value=m.sheenColorMap,t(m.sheenColorMap,p.sheenColorMapTransform)),m.sheenRoughnessMap&&(p.sheenRoughnessMap.value=m.sheenRoughnessMap,t(m.sheenRoughnessMap,p.sheenRoughnessMapTransform))),m.clearcoat>0&&(p.clearcoat.value=m.clearcoat,p.clearcoatRoughness.value=m.clearcoatRoughness,m.clearcoatMap&&(p.clearcoatMap.value=m.clearcoatMap,t(m.clearcoatMap,p.clearcoatMapTransform)),m.clearcoatRoughnessMap&&(p.clearcoatRoughnessMap.value=m.clearcoatRoughnessMap,t(m.clearcoatRoughnessMap,p.clearcoatRoughnessMapTransform)),m.clearcoatNormalMap&&(p.clearcoatNormalMap.value=m.clearcoatNormalMap,t(m.clearcoatNormalMap,p.clearcoatNormalMapTransform),p.clearcoatNormalScale.value.copy(m.clearcoatNormalScale),m.side===fn&&p.clearcoatNormalScale.value.negate())),m.dispersion>0&&(p.dispersion.value=m.dispersion),m.retroreflectivity>0&&(p.retroreflectivity.value=m.retroreflectivity),m.iridescence>0&&(p.iridescence.value=m.iridescence,p.iridescenceIOR.value=m.iridescenceIOR,p.iridescenceThicknessMinimum.value=m.iridescenceThicknessRange[0],p.iridescenceThicknessMaximum.value=m.iridescenceThicknessRange[1],m.iridescenceMap&&(p.iridescenceMap.value=m.iridescenceMap,t(m.iridescenceMap,p.iridescenceMapTransform)),m.iridescenceThicknessMap&&(p.iridescenceThicknessMap.value=m.iridescenceThicknessMap,t(m.iridescenceThicknessMap,p.iridescenceThicknessMapTransform))),m.transmission>0&&(p.transmission.value=m.transmission,p.transmissionSamplerMap.value=v.texture,p.transmissionSamplerSize.value.set(v.width,v.height),m.transmissionMap&&(p.transmissionMap.value=m.transmissionMap,t(m.transmissionMap,p.transmissionMapTransform)),p.thickness.value=m.thickness,m.thicknessMap&&(p.thicknessMap.value=m.thicknessMap,t(m.thicknessMap,p.thicknessMapTransform)),p.attenuationDistance.value=m.attenuationDistance,p.attenuationColor.value.copy(m.attenuationColor)),m.anisotropy>0&&(p.anisotropyVector.value.set(m.anisotropy*Math.cos(m.anisotropyRotation),m.anisotropy*Math.sin(m.anisotropyRotation)),m.anisotropyMap&&(p.anisotropyMap.value=m.anisotropyMap,t(m.anisotropyMap,p.anisotropyMapTransform))),p.specularIntensity.value=m.specularIntensity,p.specularColor.value.copy(m.specularColor),m.specularColorMap&&(p.specularColorMap.value=m.specularColorMap,t(m.specularColorMap,p.specularColorMapTransform)),m.specularIntensityMap&&(p.specularIntensityMap.value=m.specularIntensityMap,t(m.specularIntensityMap,p.specularIntensityMapTransform))}function _(p,m){m.matcap&&(p.matcap.value=m.matcap)}function g(p,m){const v=e.get(m).light;p.referencePosition.value.setFromMatrixPosition(v.matrixWorld),p.nearDistance.value=v.shadow.camera.near,p.farDistance.value=v.shadow.camera.far}return{refreshFogUniforms:i,refreshMaterialUniforms:r}}function AM(n,e,t,i){let r={},s={},a=[];const o=n.getParameter(n.MAX_UNIFORM_BUFFER_BINDINGS);function l(y,S){const M=S.program;i.uniformBlockBinding(y,M)}function c(y,S){let M=r[y.id];M===void 0&&(p(y),M=f(y),r[y.id]=M,y.addEventListener("dispose",v));const E=S.program;i.updateUBOMapping(y,E);const b=e.render.frame;s[y.id]!==b&&(u(y),s[y.id]=b)}function f(y){const S=d();y.__bindingPointIndex=S;const M=n.createBuffer(),E=y.__size,b=y.usage;return n.bindBuffer(n.UNIFORM_BUFFER,M),n.bufferData(n.UNIFORM_BUFFER,E,b),n.bindBuffer(n.UNIFORM_BUFFER,null),n.bindBufferBase(n.UNIFORM_BUFFER,S,M),M}function d(){for(let y=0;y<o;y++)if(a.indexOf(y)===-1)return a.push(y),y;return ut("WebGLRenderer: Maximum number of simultaneously usable uniforms groups reached."),0}function u(y){const S=r[y.id],M=y.uniforms,E=y.__cache;n.bindBuffer(n.UNIFORM_BUFFER,S);for(let b=0,T=M.length;b<T;b++){const C=M[b];if(Array.isArray(C))for(let D=0,R=C.length;D<R;D++)h(C[D],b,D,E);else h(C,b,0,E)}n.bindBuffer(n.UNIFORM_BUFFER,null)}function h(y,S,M,E){if(g(y,S,M,E)===!0){const b=y.__offset,T=y.value;if(Array.isArray(T)){let C=0;for(let D=0;D<T.length;D++){const R=T[D],N=m(R);_(R,y.__data,C),typeof R!="number"&&typeof R!="boolean"&&!R.isMatrix3&&!ArrayBuffer.isView(R)&&(C+=N.storage/Float32Array.BYTES_PER_ELEMENT)}}else _(T,y.__data,0);n.bufferSubData(n.UNIFORM_BUFFER,b,y.__data)}}function _(y,S,M){typeof y=="number"||typeof y=="boolean"?S[0]=y:y.isMatrix3?(S[0]=y.elements[0],S[1]=y.elements[1],S[2]=y.elements[2],S[3]=0,S[4]=y.elements[3],S[5]=y.elements[4],S[6]=y.elements[5],S[7]=0,S[8]=y.elements[6],S[9]=y.elements[7],S[10]=y.elements[8],S[11]=0):ArrayBuffer.isView(y)?S.set(new y.constructor(y.buffer,y.byteOffset,S.length)):y.toArray(S,M)}function g(y,S,M,E){const b=y.value,T=S+"_"+M;if(E[T]===void 0)return typeof b=="number"||typeof b=="boolean"?E[T]=b:ArrayBuffer.isView(b)?E[T]=b.slice():E[T]=b.clone(),!0;{const C=E[T];if(typeof b=="number"||typeof b=="boolean"){if(C!==b)return E[T]=b,!0}else{if(ArrayBuffer.isView(b))return!0;if(C.equals(b)===!1)return C.copy(b),!0}}return!1}function p(y){const S=y.uniforms;let M=0;const E=16;for(let T=0,C=S.length;T<C;T++){const D=Array.isArray(S[T])?S[T]:[S[T]];for(let R=0,N=D.length;R<N;R++){const I=D[R],z=Array.isArray(I.value)?I.value:[I.value];for(let $=0,X=z.length;$<X;$++){const re=z[$],J=m(re),Q=M%E,te=Q%J.boundary,ue=Q+te;M+=te,ue!==0&&E-ue<J.storage&&(M+=E-ue),I.__data=new Float32Array(J.storage/Float32Array.BYTES_PER_ELEMENT),I.__offset=M,M+=J.storage}}}const b=M%E;return b>0&&(M+=E-b),y.__size=M,y.__cache={},this}function m(y){const S={boundary:0,storage:0};return typeof y=="number"||typeof y=="boolean"?(S.boundary=4,S.storage=4):y.isVector2?(S.boundary=8,S.storage=8):y.isVector3||y.isColor?(S.boundary=16,S.storage=12):y.isVector4?(S.boundary=16,S.storage=16):y.isMatrix3?(S.boundary=48,S.storage=48):y.isMatrix4?(S.boundary=64,S.storage=64):y.isTexture?ze("WebGLRenderer: Texture samplers can not be part of an uniforms group."):ArrayBuffer.isView(y)?(S.boundary=16,S.storage=y.byteLength):ze("WebGLRenderer: Unsupported uniform value type.",y),S}function v(y){const S=y.target;S.removeEventListener("dispose",v);const M=a.indexOf(S.__bindingPointIndex);a.splice(M,1),n.deleteBuffer(r[S.id]),delete r[S.id],delete s[S.id]}function w(){for(const y in r)n.deleteBuffer(r[y]);a=[],r={},s={}}return{bind:l,update:c,dispose:w}}const RM=new Uint16Array([12469,15057,12620,14925,13266,14620,13807,14376,14323,13990,14545,13625,14713,13328,14840,12882,14931,12528,14996,12233,15039,11829,15066,11525,15080,11295,15085,10976,15082,10705,15073,10495,13880,14564,13898,14542,13977,14430,14158,14124,14393,13732,14556,13410,14702,12996,14814,12596,14891,12291,14937,11834,14957,11489,14958,11194,14943,10803,14921,10506,14893,10278,14858,9960,14484,14039,14487,14025,14499,13941,14524,13740,14574,13468,14654,13106,14743,12678,14818,12344,14867,11893,14889,11509,14893,11180,14881,10751,14852,10428,14812,10128,14765,9754,14712,9466,14764,13480,14764,13475,14766,13440,14766,13347,14769,13070,14786,12713,14816,12387,14844,11957,14860,11549,14868,11215,14855,10751,14825,10403,14782,10044,14729,9651,14666,9352,14599,9029,14967,12835,14966,12831,14963,12804,14954,12723,14936,12564,14917,12347,14900,11958,14886,11569,14878,11247,14859,10765,14828,10401,14784,10011,14727,9600,14660,9289,14586,8893,14508,8533,15111,12234,15110,12234,15104,12216,15092,12156,15067,12010,15028,11776,14981,11500,14942,11205,14902,10752,14861,10393,14812,9991,14752,9570,14682,9252,14603,8808,14519,8445,14431,8145,15209,11449,15208,11451,15202,11451,15190,11438,15163,11384,15117,11274,15055,10979,14994,10648,14932,10343,14871,9936,14803,9532,14729,9218,14645,8742,14556,8381,14461,8020,14365,7603,15273,10603,15272,10607,15267,10619,15256,10631,15231,10614,15182,10535,15118,10389,15042,10167,14963,9787,14883,9447,14800,9115,14710,8665,14615,8318,14514,7911,14411,7507,14279,7198,15314,9675,15313,9683,15309,9712,15298,9759,15277,9797,15229,9773,15166,9668,15084,9487,14995,9274,14898,8910,14800,8539,14697,8234,14590,7790,14479,7409,14367,7067,14178,6621,15337,8619,15337,8631,15333,8677,15325,8769,15305,8871,15264,8940,15202,8909,15119,8775,15022,8565,14916,8328,14804,8009,14688,7614,14569,7287,14448,6888,14321,6483,14088,6171,15350,7402,15350,7419,15347,7480,15340,7613,15322,7804,15287,7973,15229,8057,15148,8012,15046,7846,14933,7611,14810,7357,14682,7069,14552,6656,14421,6316,14251,5948,14007,5528,15356,5942,15356,5977,15353,6119,15348,6294,15332,6551,15302,6824,15249,7044,15171,7122,15070,7050,14949,6861,14818,6611,14679,6349,14538,6067,14398,5651,14189,5311,13935,4958,15359,4123,15359,4153,15356,4296,15353,4646,15338,5160,15311,5508,15263,5829,15188,6042,15088,6094,14966,6001,14826,5796,14678,5543,14527,5287,14377,4985,14133,4586,13869,4257,15360,1563,15360,1642,15358,2076,15354,2636,15341,3350,15317,4019,15273,4429,15203,4732,15105,4911,14981,4932,14836,4818,14679,4621,14517,4386,14359,4156,14083,3795,13808,3437,15360,122,15360,137,15358,285,15355,636,15344,1274,15322,2177,15281,2765,15215,3223,15120,3451,14995,3569,14846,3567,14681,3466,14511,3305,14344,3121,14037,2800,13753,2467,15360,0,15360,1,15359,21,15355,89,15346,253,15325,479,15287,796,15225,1148,15133,1492,15008,1749,14856,1882,14685,1886,14506,1783,14324,1608,13996,1398,13702,1183]);let ei=null;function CM(){return ei===null&&(ei=new pv(RM,16,16,mr,ui),ei.name="DFG_LUT",ei.minFilter=ln,ei.magFilter=ln,ei.wrapS=Si,ei.wrapT=Si,ei.generateMipmaps=!1,ei.needsUpdate=!0),ei}class PM{constructor(e={}){const{canvas:t=A_(),context:i=null,depth:r=!0,stencil:s=!1,alpha:a=!1,antialias:o=!1,premultipliedAlpha:l=!0,preserveDrawingBuffer:c=!1,powerPreference:f="default",failIfMajorPerformanceCaveat:d=!1,reversedDepthBuffer:u=!1,outputBufferType:h=Bn}=e;this.isWebGLRenderer=!0;let _;if(i!==null){if(typeof WebGLRenderingContext<"u"&&i instanceof WebGLRenderingContext)throw new Error("THREE.WebGLRenderer: WebGL 1 is not supported since r163.");_=i.getContextAttributes().alpha}else _=a;const g=h,p=new Set([wu,Mu,Su]),m=new Set([Bn,ci,Is,Us,yu,bu]),v=new Uint32Array(4),w=new Int32Array(4),y=new U;let S=null,M=null;const E=[],b=[];let T=null;this.domElement=t,this.debug={checkShaderErrors:!0,diagnostics:{keywords:!1},onShaderError:null},this.autoClear=!0,this.autoClearColor=!0,this.autoClearDepth=!0,this.autoClearStencil=!0,this.sortObjects=!0,this.clippingPlanes=[],this.localClippingEnabled=!1,this.toneMapping=oi,this.toneMappingExposure=1,this.transmissionResolutionScale=1;const C=this;let D=!1,R=null,N=null,I=null,z=null;this._outputColorSpace=Un;let $=0,X=0,re=null,J=-1,Q=null;const te=new bt,ue=new bt;let be=null;const Fe=new ft(0);let Re=0,je=t.width,ne=t.height,ae=1,Me=null,Be=null;const ve=new bt(0,0,je,ne),ke=new bt(0,0,je,ne);let Pt=!1;const $e=new Lp;let Ke=!1,rt=!1;const qe=new et,ot=new U,Dt=new bt,Tt={background:null,fog:null,environment:null,overrideMaterial:null,isScene:!0};let vt=!1;function At(){return re===null?ae:1}let V=i;function Nt(P,H){return t.getContext(P,H)}let nt,A,x,L,F,B,q,oe,j,W,ce,fe,me,de,De,Ue,Ve,G,pe,se,ge,xe,le;try{const P={alpha:!0,depth:r,stencil:s,antialias:o,premultipliedAlpha:l,preserveDrawingBuffer:c,powerPreference:f,failIfMajorPerformanceCaveat:d};if("setAttribute"in t&&t.setAttribute("data-engine",`three.js r${Vs}`),t.addEventListener("webglcontextlost",pt,!1),t.addEventListener("webglcontextrestored",lt,!1),t.addEventListener("webglcontextcreationerror",bn,!1),V===null){const H="webgl2";if(V=Nt(H,P),V===null)throw Nt(H)?new Error("THREE.WebGLRenderer: Error creating WebGL context with your selected attributes."):new Error("THREE.WebGLRenderer: Error creating WebGL context.")}Ne()}catch(P){throw t.removeEventListener("webglcontextlost",pt,!1),t.removeEventListener("webglcontextrestored",lt,!1),t.removeEventListener("webglcontextcreationerror",bn,!1),ut("WebGLRenderer: "+P.message),P}function Ne(){nt=new Cb(V),nt.init(),ge=new yM(V,nt),A=new xb(V,nt,e,ge),x=new vM(V,nt),A.reversedDepthBuffer&&u&&x.buffers.depth.setReversed(!0),N=V.createFramebuffer(),I=V.createFramebuffer(),z=V.createFramebuffer(),L=new Db(V),F=new rM,B=new xM(V,nt,x,F,A,ge,L),q=new Rb(C),oe=new Iv(V),xe=new _b(V,oe),j=new Pb(V,oe,L,xe),W=new Ib(V,j,oe,xe,L),G=new Nb(V,A,B),De=new yb(F),ce=new iM(C,q,nt,A,xe,De),fe=new TM(C,F),me=new aM,de=new dM(nt),Ve=new gb(C,q,x,W,_,l),Ue=new _M(C,W,A),le=new AM(V,L,A,x),pe=new vb(V,nt,L),se=new Lb(V,nt,L),L.programs=ce.programs,C.capabilities=A,C.extensions=nt,C.properties=F,C.renderLists=me,C.shadowMap=Ue,C.state=x,C.info=L}g!==Bn&&(T=new Fb(g,t.width,t.height,o,r,s));const Te=new wM(C,V);this.xr=Te,this.getContext=function(){return V},this.getContextAttributes=function(){return V.getContextAttributes()},this.forceContextLoss=function(){const P=nt.get("WEBGL_lose_context");P&&P.loseContext()},this.forceContextRestore=function(){const P=nt.get("WEBGL_lose_context");P&&P.restoreContext()},this.getPixelRatio=function(){return ae},this.setPixelRatio=function(P){P!==void 0&&(ae=P,this.setSize(je,ne,!1))},this.getSize=function(P){return P.set(je,ne)},this.setSize=function(P,H,ee=!0){if(Te.isPresenting){ze("WebGLRenderer: Can't change size while VR device is presenting.");return}je=P,ne=H,t.width=Math.floor(P*ae),t.height=Math.floor(H*ae),ee===!0&&(t.style.width=P+"px",t.style.height=H+"px"),T!==null&&T.setSize(t.width,t.height),this.setViewport(0,0,P,H)},this.getDrawingBufferSize=function(P){return P.set(je*ae,ne*ae).floor()},this.setDrawingBufferSize=function(P,H,ee){je=P,ne=H,ae=ee,t.width=Math.floor(P*ee),t.height=Math.floor(H*ee),this.setViewport(0,0,P,H)},this.setEffects=function(P){if(g===Bn){ut("WebGLRenderer: setEffects() requires outputBufferType set to HalfFloatType or FloatType.");return}if(P){for(let H=0;H<P.length;H++)if(P[H].isOutputPass===!0){ze("WebGLRenderer: OutputPass is not needed in setEffects(). Tone mapping and color space conversion are applied automatically.");break}}T.setEffects(P||[])},this.getCurrentViewport=function(P){return P.copy(te)},this.getViewport=function(P){return P.copy(ve)},this.setViewport=function(P,H,ee,K){P.isVector4?ve.set(P.x,P.y,P.z,P.w):ve.set(P,H,ee,K),x.viewport(te.copy(ve).multiplyScalar(ae).round())},this.getScissor=function(P){return P.copy(ke)},this.setScissor=function(P,H,ee,K){P.isVector4?ke.set(P.x,P.y,P.z,P.w):ke.set(P,H,ee,K),x.scissor(ue.copy(ke).multiplyScalar(ae).round())},this.getScissorTest=function(){return Pt},this.setScissorTest=function(P){x.setScissorTest(Pt=P)},this.setOpaqueSort=function(P){Me=P},this.setTransparentSort=function(P){Be=P},this.getClearColor=function(P){return P.copy(Ve.getClearColor())},this.setClearColor=function(){Ve.setClearColor(...arguments)},this.getClearAlpha=function(){return Ve.getClearAlpha()},this.setClearAlpha=function(){Ve.setClearAlpha(...arguments)},this.clear=function(P=!0,H=!0,ee=!0){let K=0;if(P){let Z=!1;if(re!==null){const Se=re.texture.format;Z=p.has(Se)}if(Z){const Se=re.texture.type,Ee=m.has(Se),ye=Ve.getClearColor(),Ce=Ve.getClearAlpha(),Ie=ye.r,Je=ye.g,tt=ye.b;Ee?(v[0]=Ie,v[1]=Je,v[2]=tt,v[3]=Ce,V.clearBufferuiv(V.COLOR,0,v)):(w[0]=Ie,w[1]=Je,w[2]=tt,w[3]=Ce,V.clearBufferiv(V.COLOR,0,w))}else K|=V.COLOR_BUFFER_BIT}H&&(K|=V.DEPTH_BUFFER_BIT,this.state.buffers.depth.setMask(!0)),ee&&(K|=V.STENCIL_BUFFER_BIT,this.state.buffers.stencil.setMask(4294967295)),K!==0&&V.clear(K)},this.clearColor=function(){this.clear(!0,!1,!1)},this.clearDepth=function(){this.clear(!1,!0,!1)},this.clearStencil=function(){this.clear(!1,!1,!0)},this.setNodesHandler=function(P){P.setRenderer(this),R=P},this.dispose=function(){t.removeEventListener("webglcontextlost",pt,!1),t.removeEventListener("webglcontextrestored",lt,!1),t.removeEventListener("webglcontextcreationerror",bn,!1),Ve.dispose(),me.dispose(),de.dispose(),F.dispose(),q.dispose(),W.dispose(),xe.dispose(),le.dispose(),ce.dispose(),Te.dispose(),Te.removeEventListener("sessionstart",he),Te.removeEventListener("sessionend",Xe),Oe.stop()};function pt(P){P.preventDefault(),Eo("WebGLRenderer: Context Lost."),D=!0}function lt(){Eo("WebGLRenderer: Context Restored."),D=!1;const P=L.autoReset,H=Ue.enabled,ee=Ue.autoUpdate,K=Ue.needsUpdate,Z=Ue.type;Ne(),L.autoReset=P,Ue.enabled=H,Ue.autoUpdate=ee,Ue.needsUpdate=K,Ue.type=Z}function bn(P){ut("WebGLRenderer: A WebGL context could not be created. Reason: ",P.statusMessage)}function wn(P){const H=P.target;H.removeEventListener("dispose",wn),Gs(H)}function Gs(P){Ws(P),F.remove(P)}function Ws(P){const H=F.get(P).programs;H!==void 0&&(H.forEach(function(ee){ce.releaseProgram(ee)}),P.isShaderMaterial&&ce.releaseShaderCache(P))}this.renderBufferDirect=function(P,H,ee,K,Z,Se){H===null&&(H=Tt);const Ee=Z.isMesh&&Z.matrixWorld.determinantAffine()<0,ye=st(P,H,ee,K,Z);x.setMaterial(K,Ee);let Ce=ee.index,Ie=1;if(K.wireframe===!0){if(Ce=j.getWireframeAttribute(ee),Ce===void 0)return;Ie=2}const Je=ee.drawRange,tt=ee.attributes.position;let Pe=Je.start*Ie,ht=(Je.start+Je.count)*Ie;Se!==null&&(Pe=Math.max(Pe,Se.start*Ie),ht=Math.min(ht,(Se.start+Se.count)*Ie)),Ce!==null?(Pe=Math.max(Pe,0),ht=Math.min(ht,Ce.count)):tt!=null&&(Pe=Math.max(Pe,0),ht=Math.min(ht,tt.count));const Ot=ht-Pe;if(Ot<0||Ot===1/0)return;xe.setup(Z,K,ye,ee,Ce);let Rt,St=pe;if(Ce!==null&&(Rt=oe.get(Ce),St=se,St.setIndex(Rt)),Z.isMesh)K.wireframe===!0?(x.setLineWidth(K.wireframeLinewidth*At()),St.setMode(V.LINES)):St.setMode(V.TRIANGLES);else if(Z.isLine){let sn=K.linewidth;sn===void 0&&(sn=1),x.setLineWidth(sn*At()),Z.isLineSegments?St.setMode(V.LINES):Z.isLineLoop?St.setMode(V.LINE_LOOP):St.setMode(V.LINE_STRIP)}else Z.isPoints?St.setMode(V.POINTS):Z.isSprite&&St.setMode(V.TRIANGLES);if(Z.isBatchedMesh)if(nt.get("WEBGL_multi_draw"))St.renderMultiDraw(Z._multiDrawStarts,Z._multiDrawCounts,Z._multiDrawCount);else{const sn=Z._multiDrawStarts,we=Z._multiDrawCounts,pn=Z._multiDrawCount,ct=Ce?oe.get(Ce).bytesPerElement:1,Ln=F.get(K).currentProgram.getUniforms();for(let Jn=0;Jn<pn;Jn++)Ln.setValue(V,"_gl_DrawID",Jn),St.render(sn[Jn]/ct,we[Jn])}else if(Z.isInstancedMesh)St.renderInstances(Pe,Ot,Z.count);else if(ee.isInstancedBufferGeometry){const sn=ee._maxInstanceCount!==void 0?ee._maxInstanceCount:1/0,we=Math.min(ee.instanceCount,sn);St.renderInstances(Pe,Ot,we)}else St.render(Pe,Ot)};function O(P,H,ee,K){R!==null&&P.isNodeMaterial&&R.setObject(K,P),Ke===!0&&De.setState(P,ee,!1),P.transparent===!0&&P.side===Mn&&P.forceSinglePass===!1?(P.side=fn,P.needsUpdate=!0,xr(P,H,K),P.side=li,P.needsUpdate=!0,xr(P,H,K),P.side=Mn):xr(P,H,K)}this.compile=function(P,H,ee=null){ee===null&&(ee=P),R!==null&&R.renderStart(P,H,ee),M=de.get(ee),M.init(H),b.push(M),ee.traverseVisible(function(Z){Z.isLight&&Z.layers.test(H.layers)&&(M.pushLight(Z),Z.castShadow&&M.pushShadow(Z))}),P!==ee&&P.traverseVisible(function(Z){Z.isLight&&Z.layers.test(H.layers)&&(M.pushLight(Z),Z.castShadow&&M.pushShadow(Z))}),M.setupLights(),R!==null&&R.updateLights(M.state.lightsArray),rt=this.localClippingEnabled,Ke=De.init(this.clippingPlanes,rt),Ke===!0&&De.setGlobalState(this.clippingPlanes,H),R!==null&&Ue.render(M.state.shadowsArray,ee,H);const K=new Set;return P.traverse(function(Z){if(!(Z.isMesh||Z.isPoints||Z.isLine||Z.isSprite))return;const Se=Z.material;if(Se)if(Array.isArray(Se))for(let Ee=0;Ee<Se.length;Ee++){const ye=Se[Ee];O(ye,ee,H,Z),K.add(ye)}else O(Se,ee,H,Z),K.add(Se)}),M=b.pop(),R!==null&&R.renderEnd(),K},this.compileAsync=function(P,H,ee=null){const K=this.compile(P,H,ee);return new Promise(Z=>{function Se(){if(K.forEach(function(Ee){const Ce=F.get(Ee).currentProgram;(Ce===void 0||Ce.isReady())&&K.delete(Ee)}),K.size===0){Z(P);return}setTimeout(Se,10)}nt.get("KHR_parallel_shader_compile")!==null?Se():setTimeout(Se,10)})};let Y=null;function ie(P){Y&&Y(P)}function he(){Oe.stop()}function Xe(){Oe.start()}const Oe=new Op;Oe.setAnimationLoop(ie),typeof self<"u"&&Oe.setContext(self),this.setAnimationLoop=function(P){Y=P,Te.setAnimationLoop(P),P===null?Oe.stop():Oe.start()},Te.addEventListener("sessionstart",he),Te.addEventListener("sessionend",Xe),this.render=function(P,H){if(H!==void 0&&H.isCamera!==!0){ut("WebGLRenderer.render: camera is not an instance of THREE.Camera.");return}if(D===!0)return;R!==null&&R.renderStart(P,H);const ee=Te.enabled===!0&&Te.isPresenting===!0,K=T!==null&&(re===null||ee)&&T.begin(C,re);if(P.matrixWorldAutoUpdate===!0&&P.updateMatrixWorld(),H.parent===null&&H.matrixWorldAutoUpdate===!0&&H.updateMatrixWorld(),Te.enabled===!0&&Te.isPresenting===!0&&(T===null||T.isCompositing()===!1)&&(Te.cameraAutoUpdate===!0&&Te.updateCamera(H),H=Te.getCamera()),P.isScene===!0&&P.onBeforeRender(C,P,H,re),M=de.get(P,b.length),M.init(H),M.state.textureUnits=B.getTextureUnits(),b.push(M),qe.multiplyMatrices(H.projectionMatrix,H.matrixWorldInverse),$e.setFromProjectionMatrix(qe,ai,H.reversedDepth),rt=this.localClippingEnabled,Ke=De.init(this.clippingPlanes,rt),S=me.get(P,E.length),S.init(),E.push(S),Te.enabled===!0&&Te.isPresenting===!0){const Ee=C.xr.getDepthSensingMesh();Ee!==null&&Ge(Ee,H,-1/0,C.sortObjects)}Ge(P,H,0,C.sortObjects),S.finish(),R!==null&&R.updateLights(M.state.lightsArray),C.sortObjects===!0&&S.sort(Me,Be),vt=Te.enabled===!1||Te.isPresenting===!1||Te.hasDepthSensing()===!1,vt&&Ve.addToRenderList(S,P),this.info.render.frame++,this.info.autoReset===!0&&this.info.reset(),Ke===!0&&De.beginShadows();const Z=M.state.shadowsArray;if(Ue.render(Z,P,H),Ke===!0&&De.endShadows(),(K&&T.hasRenderPass())===!1){const Ee=S.opaque,ye=S.transmissive;if(M.setupLights(),H.isArrayCamera){const Ce=H.cameras;if(ye.length>0)for(let Ie=0,Je=Ce.length;Ie<Je;Ie++){const tt=Ce[Ie];He(Ee,ye,P,tt)}vt&&Ve.render(P);for(let Ie=0,Je=Ce.length;Ie<Je;Ie++){const tt=Ce[Ie];Mt(S,P,tt,tt.viewport)}}else ye.length>0&&He(Ee,ye,P,H),vt&&Ve.render(P),Mt(S,P,H)}re!==null&&X===0&&(B.updateMultisampleRenderTarget(re),B.updateRenderTargetMipmap(re)),K&&T.end(C),P.isScene===!0&&P.onAfterRender(C,P,H),xe.resetDefaultState(),J=-1,Q=null,b.pop(),b.length>0?(M=b[b.length-1],B.setTextureUnits(M.state.textureUnits),Ke===!0&&De.setGlobalState(C.clippingPlanes,M.state.camera)):M=null,E.pop(),E.length>0?S=E[E.length-1]:S=null,R!==null&&R.renderEnd()};function Ge(P,H,ee,K){if(P.visible===!1)return;if(P.layers.test(H.layers)){if(P.isGroup)ee=P.renderOrder;else if(P.isLOD)P.autoUpdate===!0&&P.update(H);else if(P.isLightProbeGrid)M.pushLightProbeGrid(P);else if(P.isLight)M.pushLight(P),P.castShadow&&M.pushShadow(P);else if(P.isSprite){if(!P.frustumCulled||P.intersectsFrustum($e)){K&&Dt.setFromMatrixPosition(P.matrixWorld).applyMatrix4(qe);const Ee=W.update(P),ye=P.material;ye.visible&&S.push(P,Ee,ye,ee,Dt.z,null,H)}}else if((P.isMesh||P.isLine||P.isPoints)&&(!P.frustumCulled||P.intersectsFrustum($e))){const Ee=W.update(P),ye=P.material;if(K&&(P.boundingSphere!==void 0?(P.boundingSphere===null&&P.computeBoundingSphere(),Dt.copy(P.boundingSphere.center)):(Ee.boundingSphere===null&&Ee.computeBoundingSphere(),Dt.copy(Ee.boundingSphere.center)),Dt.applyMatrix4(P.matrixWorld).applyMatrix4(qe)),Array.isArray(ye)){const Ce=Ee.groups;for(let Ie=0,Je=Ce.length;Ie<Je;Ie++){const tt=Ce[Ie],Pe=ye[tt.materialIndex];Pe&&Pe.visible&&S.push(P,Ee,Pe,ee,Dt.z,tt,H)}}else ye.visible&&S.push(P,Ee,ye,ee,Dt.z,null,H)}}const Se=P.children;for(let Ee=0,ye=Se.length;Ee<ye;Ee++)Ge(Se[Ee],H,ee,K)}function Mt(P,H,ee,K){const{opaque:Z,transmissive:Se,transparent:Ee}=P;M.setupLightsView(ee),Ke===!0&&De.setGlobalState(C.clippingPlanes,ee),K&&x.viewport(te.copy(K)),Z.length>0&&dt(Z,H,ee),Se.length>0&&dt(Se,H,ee),Ee.length>0&&dt(Ee,H,ee),x.buffers.depth.setTest(!0),x.buffers.depth.setMask(!0),x.buffers.color.setMask(!0),x.setPolygonOffset(!1)}function He(P,H,ee,K){if((ee.isScene===!0?ee.overrideMaterial:null)!==null)return;if(M.state.transmissionRenderTarget[K.id]===void 0){const Pe=nt.has("EXT_color_buffer_half_float")||nt.has("EXT_color_buffer_float");M.state.transmissionRenderTarget[K.id]=new qn(1,1,{generateMipmaps:!0,type:Pe?ui:Bn,minFilter:fr,samples:Math.max(4,A.samples),stencilBuffer:s,resolveDepthBuffer:!1,resolveStencilBuffer:!1,storeMultisampledDepthBuffer:!1,storeMultisampledStencilBuffer:!1,colorSpace:at.workingColorSpace})}const Se=M.state.transmissionRenderTarget[K.id],Ee=K.viewport||te;Se.setSize(Ee.z*C.transmissionResolutionScale,Ee.w*C.transmissionResolutionScale);const ye=C.getRenderTarget(),Ce=C.getActiveCubeFace(),Ie=C.getActiveMipmapLevel();C.setRenderTarget(Se),C.getClearColor(Fe),Re=C.getClearAlpha(),Re<1&&C.setClearColor(16777215,.5),C.clear(),vt&&Ve.render(ee);const Je=C.toneMapping;C.toneMapping=oi;const tt=K.viewport;if(K.viewport!==void 0&&(K.viewport=void 0),M.setupLightsView(K),Ke===!0&&De.setGlobalState(C.clippingPlanes,K),dt(P,ee,K),B.updateMultisampleRenderTarget(Se),B.updateRenderTargetMipmap(Se),nt.has("WEBGL_multisampled_render_to_texture")===!1){let Pe=!1;for(let ht=0,Ot=H.length;ht<Ot;ht++){const Rt=H[ht],{object:St,geometry:sn,material:we,group:pn}=Rt;if(we.side===Mn&&St.layers.test(K.layers)){const ct=we.side;we.side=fn,we.needsUpdate=!0,qt(St,ee,K,sn,we,pn),we.side=ct,we.needsUpdate=!0,Pe=!0}}Pe===!0&&(B.updateMultisampleRenderTarget(Se),B.updateRenderTargetMipmap(Se))}C.setRenderTarget(ye,Ce,Ie),C.setClearColor(Fe,Re),tt!==void 0&&(K.viewport=tt),C.toneMapping=Je}function dt(P,H,ee){const K=H.isScene===!0?H.overrideMaterial:null;for(let Z=0,Se=P.length;Z<Se;Z++){const Ee=P[Z],{object:ye,geometry:Ce,group:Ie}=Ee;let Je=Ee.material;Je.allowOverride===!0&&K!==null&&(Je=K),ye.layers.test(ee.layers)&&qt(ye,H,ee,Ce,Je,Ie)}}function qt(P,H,ee,K,Z,Se){R!==null&&Z.isNodeMaterial&&R.setObject(P,Z),P.onBeforeRender(C,H,ee,K,Z,Se),P.modelViewMatrix.multiplyMatrices(ee.matrixWorldInverse,P.matrixWorld),P.normalMatrix.getNormalMatrix(P.modelViewMatrix),Z.onBeforeRender(C,H,ee,K,P,Se),Z.transparent===!0&&Z.side===Mn&&Z.forceSinglePass===!1?(Z.side=fn,Z.needsUpdate=!0,C.renderBufferDirect(ee,H,K,Z,P,Se),Z.side=li,Z.needsUpdate=!0,C.renderBufferDirect(ee,H,K,Z,P,Se),Z.side=Mn):C.renderBufferDirect(ee,H,K,Z,P,Se),P.onAfterRender(C,H,ee,K,Z,Se)}function xr(P,H,ee){H.isScene!==!0&&(H=Tt);const K=F.get(P),Z=M.state.lights,Se=M.state.shadowsArray,Ee=Z.state.version,ye=ce.getParameters(P,Z.state,Se,H,ee,M.state.lightProbeGridArray),Ce=ce.getProgramCacheKey(ye);let Ie=K.programs;K.environment=P.isMeshStandardMaterial||P.isMeshLambertMaterial||P.isMeshPhongMaterial?H.environment:null,K.fog=H.fog;const Je=P.isMeshStandardMaterial||P.isMeshLambertMaterial&&!P.envMap||P.isMeshPhongMaterial&&!P.envMap;K.envMap=q.get(P.envMap||K.environment,Je),K.envMapRotation=K.environment!==null&&P.envMap===null?H.environmentRotation:P.envMapRotation,Ie===void 0&&(P.addEventListener("dispose",wn),Ie=new Map,K.programs=Ie);let tt=Ie.get(Ce);if(tt!==void 0){if(K.currentProgram===tt&&K.lightsStateVersion===Ee)return rs(P,ye),tt}else ye.uniforms=ce.getUniforms(P),R!==null&&P.isNodeMaterial&&R.build(P,ee,ye),P.onBeforeCompile(ye,C),tt=ce.acquireProgram(ye,Ce),Ie.set(Ce,tt),K.uniforms=ye.uniforms;const Pe=K.uniforms;return(!P.isShaderMaterial&&!P.isRawShaderMaterial||P.clipping===!0)&&(Pe.clippingPlanes=De.uniform),rs(P,ye),K.needsLights=$s(P),K.lightsStateVersion=Ee,K.needsLights&&(Pe.ambientLightColor.value=Z.state.ambient,Pe.lightProbe.value=Z.state.probe,Pe.sunLights.value=Z.state.sun,Pe.sunLightShadows.value=Z.state.sunShadow,Pe.directionalLights.value=Z.state.directional,Pe.directionalLightShadows.value=Z.state.directionalShadow,Pe.spotLights.value=Z.state.spot,Pe.spotLightShadows.value=Z.state.spotShadow,Pe.rectAreaLights.value=Z.state.rectArea,Pe.ltc_1.value=Z.state.rectAreaLTC1,Pe.ltc_2.value=Z.state.rectAreaLTC2,Pe.pointLights.value=Z.state.point,Pe.pointLightShadows.value=Z.state.pointShadow,Pe.hemisphereLights.value=Z.state.hemi,Pe.sunShadowMatrix.value=Z.state.sunShadowMatrix,Pe.sunShadowCascade.value=Z.state.sunShadowCascade,Pe.directionalShadowMatrix.value=Z.state.directionalShadowMatrix,Pe.spotLightMatrix.value=Z.state.spotLightMatrix,Pe.spotLightMap.value=Z.state.spotLightMap,Pe.pointShadowMatrix.value=Z.state.pointShadowMatrix),K.lightProbeGrid=M.state.lightProbeGridArray.length>0,K.currentProgram=tt,K.uniformsList=null,tt}function is(P){if(P.uniformsList===null){const H=P.currentProgram.getUniforms();P.uniformsList=ro.seqWithValue(H.seq,P.uniforms)}return P.uniformsList}function rs(P,H){const ee=F.get(P);ee.outputColorSpace=H.outputColorSpace,ee.batching=H.batching,ee.batchingColor=H.batchingColor,ee.instancing=H.instancing,ee.instancingColor=H.instancingColor,ee.instancingMorph=H.instancingMorph,ee.skinning=H.skinning,ee.morphTargets=H.morphTargets,ee.morphNormals=H.morphNormals,ee.morphColors=H.morphColors,ee.morphTargetsCount=H.morphTargetsCount,ee.numClippingPlanes=H.numClippingPlanes,ee.numIntersection=H.numClipIntersection,ee.vertexAlphas=H.vertexAlphas,ee.vertexTangents=H.vertexTangents,ee.toneMapping=H.toneMapping}function Le(P,H){if(P.length===0)return null;if(P.length===1)return P[0].texture!==null?P[0]:null;y.setFromMatrixPosition(H.matrixWorld);for(let ee=0,K=P.length;ee<K;ee++){const Z=P[ee];if(Z.texture!==null&&Z.boundingBox.containsPoint(y))return Z}return null}function st(P,H,ee,K,Z){H.isScene!==!0&&(H=Tt),B.resetTextureUnits();const Se=H.fog,Ee=K.isMeshStandardMaterial||K.isMeshLambertMaterial||K.isMeshPhongMaterial?H.environment:null,ye=re===null?C.outputColorSpace:re.isXRRenderTarget===!0?re.texture.colorSpace:at.workingColorSpace,Ce=K.isMeshStandardMaterial||K.isMeshLambertMaterial&&!K.envMap||K.isMeshPhongMaterial&&!K.envMap,Ie=q.get(K.envMap||Ee,Ce),Je=K.vertexColors===!0&&!!ee.attributes.color&&ee.attributes.color.itemSize===4,tt=!!ee.attributes.tangent&&(!!K.normalMap||K.anisotropy>0),Pe=!!ee.morphAttributes.position,ht=!!ee.morphAttributes.normal,Ot=!!ee.morphAttributes.color;let Rt=oi;K.toneMapped&&(re===null||re.isXRRenderTarget===!0)&&(Rt=C.toneMapping);const St=ee.morphAttributes.position||ee.morphAttributes.normal||ee.morphAttributes.color,sn=St!==void 0?St.length:0,we=F.get(K),pn=M.state.lights;if(Ke===!0&&(rt===!0||P!==Q)){const wt=P===Q&&K.id===J;De.setState(K,P,wt)}let ct=!1;K.version===we.__version?(we.needsLights&&we.lightsStateVersion!==pn.state.version||we.outputColorSpace!==ye||Z.isBatchedMesh&&we.batching===!1||!Z.isBatchedMesh&&we.batching===!0||Z.isBatchedMesh&&we.batchingColor===!0&&Z._colorsTexture===null||Z.isBatchedMesh&&we.batchingColor===!1&&Z._colorsTexture!==null||Z.isInstancedMesh&&we.instancing===!1||!Z.isInstancedMesh&&we.instancing===!0||Z.isSkinnedMesh&&we.skinning===!1||!Z.isSkinnedMesh&&we.skinning===!0||Z.isInstancedMesh&&we.instancingColor===!0&&Z.instanceColor===null||Z.isInstancedMesh&&we.instancingColor===!1&&Z.instanceColor!==null||Z.isInstancedMesh&&we.instancingMorph===!0&&Z.morphTexture===null||Z.isInstancedMesh&&we.instancingMorph===!1&&Z.morphTexture!==null||we.envMap!==Ie||K.fog===!0&&we.fog!==Se||we.numClippingPlanes!==void 0&&(we.numClippingPlanes!==De.numPlanes||we.numIntersection!==De.numIntersection)||we.vertexAlphas!==Je||we.vertexTangents!==tt||we.morphTargets!==Pe||we.morphNormals!==ht||we.morphColors!==Ot||we.toneMapping!==Rt||we.morphTargetsCount!==sn||!!we.lightProbeGrid!=M.state.lightProbeGridArray.length>0)&&(ct=!0):(ct=!0,we.__version=K.version);let Ln=we.currentProgram;ct===!0&&(Ln=xr(K,H,Z),R&&K.isNodeMaterial&&R.onUpdateProgram(K,Ln,we));let Jn=!1,Di=!1,yr=!1;const xt=Ln.getUniforms(),Ut=we.uniforms;if(x.useProgram(Ln.program)&&(Jn=!0,Di=!0,yr=!0),K.id!==J&&(J=K.id,Di=!0),we.needsLights){const wt=Le(M.state.lightProbeGridArray,Z);we.lightProbeGrid!==wt&&(we.lightProbeGrid=wt,Di=!0)}if(Jn||Q!==P){x.buffers.depth.getReversed()&&P.reversedDepth!==!0&&(P._reversedDepth=!0,P.updateProjectionMatrix()),xt.setValue(V,"projectionMatrix",P.projectionMatrix),xt.setValue(V,"viewMatrix",P.matrixWorldInverse);const Ii=xt.map.cameraPosition;Ii!==void 0&&Ii.setValue(V,ot.setFromMatrixPosition(P.matrixWorld)),A.logarithmicDepthBuffer&&xt.setValue(V,"logDepthBufFC",2/(Math.log(P.far+1)/Math.LN2)),(K.isMeshPhongMaterial||K.isMeshToonMaterial||K.isMeshLambertMaterial||K.isMeshBasicMaterial||K.isMeshStandardMaterial||K.isShaderMaterial)&&xt.setValue(V,"isOrthographic",P.isOrthographicCamera===!0),Q!==P&&(Q=P,Di=!0,yr=!0)}if(we.needsLights&&(pn.state.sunShadowMap.length>0&&xt.setValue(V,"sunShadowMap",pn.state.sunShadowMap,B),pn.state.directionalShadowMap.length>0&&xt.setValue(V,"directionalShadowMap",pn.state.directionalShadowMap,B),pn.state.spotShadowMap.length>0&&xt.setValue(V,"spotShadowMap",pn.state.spotShadowMap,B),pn.state.pointShadowMap.length>0&&xt.setValue(V,"pointShadowMap",pn.state.pointShadowMap,B)),Z.isSkinnedMesh){xt.setOptional(V,Z,"bindMatrix"),xt.setOptional(V,Z,"bindMatrixInverse");const wt=Z.skeleton;wt&&(wt.boneTexture===null&&wt.computeBoneTexture(),xt.setValue(V,"boneTexture",wt.boneTexture,B))}Z.isBatchedMesh&&(xt.setOptional(V,Z,"batchingTexture"),xt.setValue(V,"batchingTexture",Z._matricesTexture,B),xt.setOptional(V,Z,"batchingIdTexture"),xt.setValue(V,"batchingIdTexture",Z._indirectTexture,B),xt.setOptional(V,Z,"batchingColorTexture"),Z._colorsTexture!==null&&xt.setValue(V,"batchingColorTexture",Z._colorsTexture,B));const Ni=ee.morphAttributes;if((Ni.position!==void 0||Ni.normal!==void 0||Ni.color!==void 0)&&G.update(Z,ee,Ln),(Di||we.receiveShadow!==Z.receiveShadow)&&(we.receiveShadow=Z.receiveShadow,xt.setValue(V,"receiveShadow",Z.receiveShadow)),(K.isMeshStandardMaterial||K.isMeshLambertMaterial||K.isMeshPhongMaterial)&&K.envMap===null&&H.environment!==null&&(Ut.envMapIntensity.value=H.environmentIntensity),Ut.dfgLUT!==void 0&&(Ut.dfgLUT.value=CM()),Di){if(xt.setValue(V,"toneMappingExposure",C.toneMappingExposure),we.needsLights&&En(Ut,yr),Se&&K.fog===!0&&fe.refreshFogUniforms(Ut,Se),fe.refreshMaterialUniforms(Ut,K,ae,ne,M.state.transmissionRenderTarget[P.id]),we.needsLights&&we.lightProbeGrid){const wt=we.lightProbeGrid;Ut.probesSH.value=wt.texture,Ut.probesMin.value.copy(wt.boundingBox.min),Ut.probesMax.value.copy(wt.boundingBox.max),Ut.probesResolution.value.copy(wt.resolution)}ro.upload(V,is(we),Ut,B)}if(K.isShaderMaterial&&K.uniformsNeedUpdate===!0&&(ro.upload(V,is(we),Ut,B),K.uniformsNeedUpdate=!1),K.isSpriteMaterial&&xt.setValue(V,"center",Z.center),xt.setValue(V,"modelViewMatrix",Z.modelViewMatrix),xt.setValue(V,"normalMatrix",Z.normalMatrix),xt.setValue(V,"modelMatrix",Z.matrixWorld),K.uniformsGroups!==void 0){const wt=K.uniformsGroups;for(let Ii=0,br=wt.length;Ii<br;Ii++){const Gu=wt[Ii];le.update(Gu,Ln),le.bind(Gu,Ln)}}return Ln}function En(P,H){P.ambientLightColor.needsUpdate=H,P.lightProbe.needsUpdate=H,P.sunLights.needsUpdate=H,P.sunLightShadows.needsUpdate=H,P.directionalLights.needsUpdate=H,P.directionalLightShadows.needsUpdate=H,P.pointLights.needsUpdate=H,P.pointLightShadows.needsUpdate=H,P.spotLights.needsUpdate=H,P.spotLightShadows.needsUpdate=H,P.rectAreaLights.needsUpdate=H,P.hemisphereLights.needsUpdate=H}function $s(P){return P.isMeshLambertMaterial||P.isMeshToonMaterial||P.isMeshPhongMaterial||P.isMeshStandardMaterial||P.isShadowMaterial||P.isShaderMaterial&&P.lights===!0}this.getActiveCubeFace=function(){return $},this.getActiveMipmapLevel=function(){return X},this.getRenderTarget=function(){return re},this.setRenderTargetTextures=function(P,H,ee){const K=F.get(P);K.__autoAllocateDepthBuffer=P.resolveDepthBuffer===!1,K.__autoAllocateDepthBuffer===!1&&(K.__useRenderToTexture=!1),F.get(P.texture).__webglTexture=H,F.get(P.depthTexture).__webglTexture=K.__autoAllocateDepthBuffer?void 0:ee,K.__hasExternalTextures=!0},this.setRenderTargetFramebuffer=function(P,H){const ee=F.get(P);ee.__webglFramebuffer=H,ee.__useDefaultFramebuffer=H===void 0},this.setRenderTarget=function(P,H=0,ee=0){re=P,$=H,X=ee;let K=null,Z=!1,Se=!1;if(P){const ye=F.get(P);if(ye.__useDefaultFramebuffer!==void 0){x.bindFramebuffer(V.FRAMEBUFFER,ye.__webglFramebuffer),te.copy(P.viewport),ue.copy(P.scissor),be=P.scissorTest,x.viewport(te),x.scissor(ue),x.setScissorTest(be),J=-1;return}else if(ye.__webglFramebuffer===void 0)B.setupRenderTarget(P);else if(ye.__hasExternalTextures)B.rebindTextures(P,F.get(P.texture).__webglTexture,F.get(P.depthTexture).__webglTexture);else if(P.depthBuffer){const Je=P.depthTexture;if(ye.__boundDepthTexture!==Je){if(Je!==null&&F.has(Je)&&(P.width!==Je.image.width||P.height!==Je.image.height))throw new Error("THREE.WebGLRenderer: Attached DepthTexture is initialized to the incorrect size.");B.setupDepthRenderbuffer(P)}}const Ce=P.texture;(Ce.isData3DTexture||Ce.isDataArrayTexture||Ce.isCompressedArrayTexture)&&(Se=!0);const Ie=F.get(P).__webglFramebuffer;P.isWebGLCubeRenderTarget?(Array.isArray(Ie[H])?K=Ie[H][ee]:K=Ie[H],Z=!0):P.samples>0&&B.useMultisampledRTT(P)===!1?K=F.get(P).__webglMultisampledFramebuffer:Array.isArray(Ie)?K=Ie[ee]:K=Ie,te.copy(P.viewport),ue.copy(P.scissor),be=P.scissorTest}else te.copy(ve).multiplyScalar(ae).floor(),ue.copy(ke).multiplyScalar(ae).floor(),be=Pt;if(ee!==0&&(K=N),x.bindFramebuffer(V.FRAMEBUFFER,K)&&x.drawBuffers(P,K),x.viewport(te),x.scissor(ue),x.setScissorTest(be),Z){const ye=F.get(P.texture);V.framebufferTexture2D(V.FRAMEBUFFER,V.COLOR_ATTACHMENT0,V.TEXTURE_CUBE_MAP_POSITIVE_X+H,ye.__webglTexture,ee)}else if(Se){const ye=H;for(let Ce=0;Ce<P.textures.length;Ce++){const Ie=F.get(P.textures[Ce]);V.framebufferTextureLayer(V.FRAMEBUFFER,V.COLOR_ATTACHMENT0+Ce,Ie.__webglTexture,ee,ye)}}else if(P!==null&&ee!==0){const ye=F.get(P.texture);V.framebufferTexture2D(V.FRAMEBUFFER,V.COLOR_ATTACHMENT0,V.TEXTURE_2D,ye.__webglTexture,ee)}J=-1};function Zn(P){const H=F.get(P);return(H.__readFormat!==P.format||H.__readType!==P.type)&&(H.__readFormat=P.format,H.__readType=P.type,H.__formatReadable=A.textureFormatReadable(P.format),H.__typeReadable=A.textureTypeReadable(P.type)),H}this.readRenderTargetPixels=function(P,H,ee,K,Z,Se,Ee,ye=0){if(!(P&&P.isWebGLRenderTarget)){ut("WebGLRenderer.readRenderTargetPixels: renderTarget is not THREE.WebGLRenderTarget.");return}let Ce=F.get(P).__webglFramebuffer;if(P.isWebGLCubeRenderTarget&&Ee!==void 0&&(Ce=Ce[Ee]),Ce){x.bindFramebuffer(V.FRAMEBUFFER,Ce);try{const Ie=P.textures[ye],Je=Ie.format,tt=Ie.type;P.textures.length>1&&V.readBuffer(V.COLOR_ATTACHMENT0+ye);const Pe=Zn(Ie);if(Pe.__formatReadable===!1){ut("WebGLRenderer.readRenderTargetPixels: renderTarget is not in RGBA or implementation defined format.");return}if(Pe.__typeReadable===!1){ut("WebGLRenderer.readRenderTargetPixels: renderTarget is not in UnsignedByteType or implementation defined type.");return}H>=0&&H<=P.width-K&&ee>=0&&ee<=P.height-Z&&V.readPixels(H,ee,K,Z,ge.convert(Je),ge.convert(tt),Se)}finally{const Ie=re!==null?F.get(re).__webglFramebuffer:null;x.bindFramebuffer(V.FRAMEBUFFER,Ie)}}},this.readRenderTargetPixelsAsync=async function(P,H,ee,K,Z,Se,Ee,ye=0){if(!(P&&P.isWebGLRenderTarget))throw new Error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not THREE.WebGLRenderTarget.");let Ce=F.get(P).__webglFramebuffer;if(P.isWebGLCubeRenderTarget&&Ee!==void 0&&(Ce=Ce[Ee]),Ce)if(H>=0&&H<=P.width-K&&ee>=0&&ee<=P.height-Z){x.bindFramebuffer(V.FRAMEBUFFER,Ce);const Ie=P.textures[ye],Je=Ie.format,tt=Ie.type;P.textures.length>1&&V.readBuffer(V.COLOR_ATTACHMENT0+ye);const Pe=Zn(Ie);if(Pe.__formatReadable===!1)throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: renderTarget is not in RGBA or implementation defined format.");if(Pe.__typeReadable===!1)throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: renderTarget is not in UnsignedByteType or implementation defined type.");const ht=V.createBuffer();V.bindBuffer(V.PIXEL_PACK_BUFFER,ht),V.bufferData(V.PIXEL_PACK_BUFFER,Se.byteLength,V.STREAM_READ),V.readPixels(H,ee,K,Z,ge.convert(Je),ge.convert(tt),0),V.bindBuffer(V.PIXEL_PACK_BUFFER,null);const Ot=re!==null?F.get(re).__webglFramebuffer:null;x.bindFramebuffer(V.FRAMEBUFFER,Ot);const Rt=V.fenceSync(V.SYNC_GPU_COMMANDS_COMPLETE,0);return V.flush(),await R_(V,Rt,4),V.bindBuffer(V.PIXEL_PACK_BUFFER,ht),V.getBufferSubData(V.PIXEL_PACK_BUFFER,0,Se),V.bindBuffer(V.PIXEL_PACK_BUFFER,null),V.deleteBuffer(ht),V.deleteSync(Rt),Se}else throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: requested read bounds are out of range.")},this.copyFramebufferToTexture=function(P,H=null,ee=0){const K=Math.pow(2,-ee),Z=Math.floor(P.image.width*K),Se=Math.floor(P.image.height*K),Ee=H!==null?H.x:0,ye=H!==null?H.y:0;B.setTexture2D(P,0),V.copyTexSubImage2D(V.TEXTURE_2D,ee,0,0,Ee,ye,Z,Se),x.unbindTexture()},this.copyTextureToTexture=function(P,H,ee=null,K=null,Z=0,Se=0){let Ee,ye,Ce,Ie,Je,tt,Pe,ht,Ot;const Rt=P.isCompressedTexture?P.mipmaps[Se]:P.image;if(ee!==null)Ee=ee.max.x-ee.min.x,ye=ee.max.y-ee.min.y,Ce=ee.isBox3?ee.max.z-ee.min.z:1,Ie=ee.min.x,Je=ee.min.y,tt=ee.isBox3?ee.min.z:0;else{const Ut=Math.pow(2,-Z);Ee=Math.floor(Rt.width*Ut),ye=Math.floor(Rt.height*Ut),P.isDataArrayTexture?Ce=Rt.depth:P.isData3DTexture?Ce=Math.floor(Rt.depth*Ut):Ce=1,Ie=0,Je=0,tt=0}K!==null?(Pe=K.x,ht=K.y,Ot=K.z):(Pe=0,ht=0,Ot=0);const St=ge.convert(H.format),sn=ge.convert(H.type);let we;H.isData3DTexture?(B.setTexture3D(H,0),we=V.TEXTURE_3D):H.isDataArrayTexture||H.isCompressedArrayTexture?(B.setTexture2DArray(H,0),we=V.TEXTURE_2D_ARRAY):(B.setTexture2D(H,0),we=V.TEXTURE_2D),x.activeTexture(V.TEXTURE0),x.pixelStorei(V.UNPACK_FLIP_Y_WEBGL,H.flipY),x.pixelStorei(V.UNPACK_PREMULTIPLY_ALPHA_WEBGL,H.premultiplyAlpha),x.pixelStorei(V.UNPACK_ALIGNMENT,H.unpackAlignment);const pn=x.getParameter(V.UNPACK_ROW_LENGTH),ct=x.getParameter(V.UNPACK_IMAGE_HEIGHT),Ln=x.getParameter(V.UNPACK_SKIP_PIXELS),Jn=x.getParameter(V.UNPACK_SKIP_ROWS),Di=x.getParameter(V.UNPACK_SKIP_IMAGES);x.pixelStorei(V.UNPACK_ROW_LENGTH,Rt.width),x.pixelStorei(V.UNPACK_IMAGE_HEIGHT,Rt.height),x.pixelStorei(V.UNPACK_SKIP_PIXELS,Ie),x.pixelStorei(V.UNPACK_SKIP_ROWS,Je),x.pixelStorei(V.UNPACK_SKIP_IMAGES,tt);const yr=P.isDataArrayTexture||P.isData3DTexture,xt=H.isDataArrayTexture||H.isData3DTexture;if(P.isDepthTexture){const Ut=F.get(P),Ni=F.get(H),wt=F.get(Ut.__renderTarget),Ii=F.get(Ni.__renderTarget);x.bindFramebuffer(V.READ_FRAMEBUFFER,wt.__webglFramebuffer),x.bindFramebuffer(V.DRAW_FRAMEBUFFER,Ii.__webglFramebuffer);for(let br=0;br<Ce;br++)yr&&(V.framebufferTextureLayer(V.READ_FRAMEBUFFER,V.COLOR_ATTACHMENT0,F.get(P).__webglTexture,Z,tt+br),V.framebufferTextureLayer(V.DRAW_FRAMEBUFFER,V.COLOR_ATTACHMENT0,F.get(H).__webglTexture,Se,Ot+br)),V.blitFramebuffer(Ie,Je,Ee,ye,Pe,ht,Ee,ye,V.DEPTH_BUFFER_BIT,V.NEAREST);x.bindFramebuffer(V.READ_FRAMEBUFFER,null),x.bindFramebuffer(V.DRAW_FRAMEBUFFER,null)}else if(Z!==0||P.isRenderTargetTexture||F.has(P)){const Ut=F.get(P),Ni=F.get(H);x.bindFramebuffer(V.READ_FRAMEBUFFER,I),x.bindFramebuffer(V.DRAW_FRAMEBUFFER,z);for(let wt=0;wt<Ce;wt++)yr?V.framebufferTextureLayer(V.READ_FRAMEBUFFER,V.COLOR_ATTACHMENT0,Ut.__webglTexture,Z,tt+wt):V.framebufferTexture2D(V.READ_FRAMEBUFFER,V.COLOR_ATTACHMENT0,V.TEXTURE_2D,Ut.__webglTexture,Z),xt?V.framebufferTextureLayer(V.DRAW_FRAMEBUFFER,V.COLOR_ATTACHMENT0,Ni.__webglTexture,Se,Ot+wt):V.framebufferTexture2D(V.DRAW_FRAMEBUFFER,V.COLOR_ATTACHMENT0,V.TEXTURE_2D,Ni.__webglTexture,Se),Z!==0?V.blitFramebuffer(Ie,Je,Ee,ye,Pe,ht,Ee,ye,V.COLOR_BUFFER_BIT,V.NEAREST):xt?V.copyTexSubImage3D(we,Se,Pe,ht,Ot+wt,Ie,Je,Ee,ye):V.copyTexSubImage2D(we,Se,Pe,ht,Ie,Je,Ee,ye);x.bindFramebuffer(V.READ_FRAMEBUFFER,null),x.bindFramebuffer(V.DRAW_FRAMEBUFFER,null)}else xt?P.isDataTexture||P.isData3DTexture?V.texSubImage3D(we,Se,Pe,ht,Ot,Ee,ye,Ce,St,sn,Rt.data):H.isCompressedArrayTexture?V.compressedTexSubImage3D(we,Se,Pe,ht,Ot,Ee,ye,Ce,St,Rt.data):V.texSubImage3D(we,Se,Pe,ht,Ot,Ee,ye,Ce,St,sn,Rt):P.isDataTexture?V.texSubImage2D(V.TEXTURE_2D,Se,Pe,ht,Ee,ye,St,sn,Rt.data):P.isCompressedTexture?V.compressedTexSubImage2D(V.TEXTURE_2D,Se,Pe,ht,Rt.width,Rt.height,St,Rt.data):V.texSubImage2D(V.TEXTURE_2D,Se,Pe,ht,Ee,ye,St,sn,Rt);x.pixelStorei(V.UNPACK_ROW_LENGTH,pn),x.pixelStorei(V.UNPACK_IMAGE_HEIGHT,ct),x.pixelStorei(V.UNPACK_SKIP_PIXELS,Ln),x.pixelStorei(V.UNPACK_SKIP_ROWS,Jn),x.pixelStorei(V.UNPACK_SKIP_IMAGES,Di),Se===0&&H.generateMipmaps&&V.generateMipmap(we),x.unbindTexture()},this.initRenderTarget=function(P){F.get(P).__webglFramebuffer===void 0&&B.setupRenderTarget(P)},this.initTexture=function(P){P.isCubeTexture?B.setTextureCube(P,0):P.isData3DTexture?B.setTexture3D(P,0):P.isDataArrayTexture||P.isCompressedArrayTexture?B.setTexture2DArray(P,0):B.setTexture2D(P,0),x.unbindTexture()},this.resetState=function(){$=0,X=0,re=null,x.reset(),xe.reset()},typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}get coordinateSystem(){return ai}get outputColorSpace(){return this._outputColorSpace}set outputColorSpace(e){this._outputColorSpace=e;const t=this.getContext();t.drawingBufferColorSpace=at._getDrawingBufferColorSpace(e),t.unpackColorSpace=at._getUnpackColorSpace()}}_e.line={worldUnits:{value:1},linewidth:{value:1},resolution:{value:new Ze},dashOffset:{value:0},dashScale:{value:1},dashSize:{value:1},gapSize:{value:1}};Sn.line={uniforms:Pu.merge([_e.common,_e.fog,_e.line]),vertexShader:`
		#include <common>
		#include <color_pars_vertex>
		#include <fog_pars_vertex>
		#include <logdepthbuf_pars_vertex>
		#include <clipping_planes_pars_vertex>

		uniform float linewidth;
		uniform vec2 resolution;

		attribute vec3 instanceStart;
		attribute vec3 instanceEnd;

		attribute vec3 instanceColorStart;
		attribute vec3 instanceColorEnd;

		#ifdef WORLD_UNITS

			varying vec4 worldPos;
			varying vec3 worldStart;
			varying vec3 worldEnd;

			#ifdef USE_DASH

				varying vec2 vUv;

			#endif

		#else

			varying vec2 vUv;

		#endif

		#ifdef USE_DASH

			uniform float dashScale;
			attribute float instanceDistanceStart;
			attribute float instanceDistanceEnd;
			varying float vLineDistance;

		#endif

		float trimSegmentAlpha( const in vec4 start, const in vec4 end ) {

			// compute the interpolation factor needed to trim the segment so it terminates
			// between the camera plane and the near plane

			// conservative estimate of the near plane
			float a = projectionMatrix[ 2 ][ 2 ]; // 3nd entry in 3th column
			float b = projectionMatrix[ 3 ][ 2 ]; // 3nd entry in 4th column

			// we need different nearEstimate formula for reversed and default depth buffer
			// a is positive with a reversed depth buffer so it can be used for controlling the code flow
			float nearEstimate = ( a > 0.0 ) ? ( - b / ( a + 1.0 ) ) : ( - 0.5 * b / a );

			return ( nearEstimate - start.z ) / ( end.z - start.z );

		}

		void main() {

			#ifdef USE_COLOR

				vColor.xyz = ( position.y < 0.5 ) ? instanceColorStart : instanceColorEnd;

			#endif

			float aspect = resolution.x / resolution.y;

			// camera space
			vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );
			vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );

			#ifdef USE_DASH

				float lineDistanceStart = dashScale * instanceDistanceStart;
				float lineDistanceEnd = dashScale * instanceDistanceEnd;

			#endif

			#ifdef WORLD_UNITS

				worldStart = start.xyz;
				worldEnd = end.xyz;

			#else

				vUv = uv;

			#endif

			// special case for perspective projection, and segments that terminate either in, or behind, the camera plane
			// clearly the gpu firmware has a way of addressing this issue when projecting into ndc space
			// but we need to perform ndc-space calculations in the shader, so we must address this issue directly
			// perhaps there is a more elegant solution -- WestLangley

			bool perspective = ( projectionMatrix[ 2 ][ 3 ] == - 1.0 ); // 4th entry in the 3rd column

			if ( perspective ) {

				if ( start.z < 0.0 && end.z >= 0.0 ) {

					float alpha = trimSegmentAlpha( start, end );
					end.xyz = mix( start.xyz, end.xyz, alpha );

					#ifdef USE_DASH

						lineDistanceEnd = mix( lineDistanceStart, lineDistanceEnd, alpha );

					#endif

				} else if ( end.z < 0.0 && start.z >= 0.0 ) {

					float alpha = trimSegmentAlpha( end, start );
					start.xyz = mix( end.xyz, start.xyz, alpha );

					#ifdef USE_DASH

						lineDistanceStart = mix( lineDistanceEnd, lineDistanceStart, alpha );

					#endif

				}

			}

			#ifdef USE_DASH

				vLineDistance = ( position.y < 0.5 ) ? lineDistanceStart : lineDistanceEnd;
				vUv = uv;

			#endif

			// clip space
			vec4 clipStart = projectionMatrix * start;
			vec4 clipEnd = projectionMatrix * end;

			// ndc space
			vec3 ndcStart = clipStart.xyz / clipStart.w;
			vec3 ndcEnd = clipEnd.xyz / clipEnd.w;

			// direction
			vec2 dir = ndcEnd.xy - ndcStart.xy;

			// account for clip-space aspect ratio
			dir.x *= aspect;
			dir = normalize( dir );

			#ifdef WORLD_UNITS

				vec3 worldDir = normalize( end.xyz - start.xyz );
				vec3 tmpFwd = normalize( mix( start.xyz, end.xyz, 0.5 ) );
				vec3 worldUp = normalize( cross( worldDir, tmpFwd ) );
				vec3 worldFwd = cross( worldDir, worldUp );
				worldPos = position.y < 0.5 ? start: end;

				// height offset
				float hw = linewidth * 0.5;
				worldPos.xyz += position.x < 0.0 ? hw * worldUp : - hw * worldUp;

				// don't extend the line if we're rendering dashes because we
				// won't be rendering the endcaps
				#ifndef USE_DASH

					// cap extension
					worldPos.xyz += position.y < 0.5 ? - hw * worldDir : hw * worldDir;

					// add width to the box
					worldPos.xyz += worldFwd * hw;

					// endcaps
					if ( position.y > 1.0 || position.y < 0.0 ) {

						worldPos.xyz -= worldFwd * 2.0 * hw;

					}

				#endif

				// project the worldpos
				vec4 clip = projectionMatrix * worldPos;

				// shift the depth of the projected points so the line
				// segments overlap neatly
				vec3 clipPose = ( position.y < 0.5 ) ? ndcStart : ndcEnd;
				clip.z = clipPose.z * clip.w;

			#else

				vec2 offset = vec2( dir.y, - dir.x );
				// undo aspect ratio adjustment
				dir.x /= aspect;
				offset.x /= aspect;

				// sign flip
				if ( position.x < 0.0 ) offset *= - 1.0;

				// endcaps
				if ( position.y < 0.0 ) {

					offset += - dir;

				} else if ( position.y > 1.0 ) {

					offset += dir;

				}

				// adjust for linewidth
				offset *= linewidth;

				// adjust for clip-space to screen-space conversion // maybe resolution should be based on viewport ...
				offset /= resolution.y;

				// select end
				vec4 clip = ( position.y < 0.5 ) ? clipStart : clipEnd;

				// back to clip space
				offset *= clip.w;

				clip.xy += offset;

			#endif

			gl_Position = clip;

			vec4 mvPosition = ( position.y < 0.5 ) ? start : end; // this is an approximation

			#include <logdepthbuf_vertex>
			#include <clipping_planes_vertex>
			#include <fog_vertex>

		}
		`,fragmentShader:`
		uniform vec3 diffuse;
		uniform float opacity;
		uniform float linewidth;

		#ifdef USE_DASH

			uniform float dashOffset;
			uniform float dashSize;
			uniform float gapSize;

		#endif

		varying float vLineDistance;

		#ifdef WORLD_UNITS

			varying vec4 worldPos;
			varying vec3 worldStart;
			varying vec3 worldEnd;

			#ifdef USE_DASH

				varying vec2 vUv;

			#endif

		#else

			varying vec2 vUv;

		#endif

		#include <common>
		#include <color_pars_fragment>
		#include <fog_pars_fragment>
		#include <logdepthbuf_pars_fragment>
		#include <clipping_planes_pars_fragment>

		vec2 closestLineToLine(vec3 p1, vec3 p2, vec3 p3, vec3 p4) {

			float mua;
			float mub;

			vec3 p13 = p1 - p3;
			vec3 p43 = p4 - p3;

			vec3 p21 = p2 - p1;

			float d1343 = dot( p13, p43 );
			float d4321 = dot( p43, p21 );
			float d1321 = dot( p13, p21 );
			float d4343 = dot( p43, p43 );
			float d2121 = dot( p21, p21 );

			float denom = d2121 * d4343 - d4321 * d4321;

			float numer = d1343 * d4321 - d1321 * d4343;

			mua = numer / denom;
			mua = clamp( mua, 0.0, 1.0 );
			mub = ( d1343 + d4321 * ( mua ) ) / d4343;
			mub = clamp( mub, 0.0, 1.0 );

			return vec2( mua, mub );

		}

		void main() {

			float alpha = opacity;
			vec4 diffuseColor = vec4( diffuse, alpha );

			#include <clipping_planes_fragment>

			#ifdef USE_DASH

				if ( vUv.y < - 1.0 || vUv.y > 1.0 ) discard; // discard endcaps

				if ( mod( vLineDistance + dashOffset, dashSize + gapSize ) > dashSize ) discard; // todo - FIX

			#endif

			#ifdef WORLD_UNITS

				// Find the closest points on the view ray and the line segment
				vec3 rayEnd = normalize( worldPos.xyz ) * 1e5;
				vec3 lineDir = worldEnd - worldStart;
				vec2 params = closestLineToLine( worldStart, worldEnd, vec3( 0.0, 0.0, 0.0 ), rayEnd );

				vec3 p1 = worldStart + lineDir * params.x;
				vec3 p2 = rayEnd * params.y;
				vec3 delta = p1 - p2;
				float len = length( delta );
				float norm = len / linewidth;

				#ifndef USE_DASH

					#ifdef USE_ALPHA_TO_COVERAGE

						float dnorm = fwidth( norm );
						alpha = 1.0 - smoothstep( 0.5 - dnorm, 0.5 + dnorm, norm );

					#else

						if ( norm > 0.5 ) {

							discard;

						}

					#endif

				#endif

			#else

				#ifdef USE_ALPHA_TO_COVERAGE

					// artifacts appear on some hardware if a derivative is taken within a conditional
					float a = vUv.x;
					float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
					float len2 = a * a + b * b;
					float dlen = fwidth( len2 );

					if ( abs( vUv.y ) > 1.0 ) {

						alpha = 1.0 - smoothstep( 1.0 - dlen, 1.0 + dlen, len2 );

					}

				#else

					if ( abs( vUv.y ) > 1.0 ) {

						float a = vUv.x;
						float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
						float len2 = a * a + b * b;

						if ( len2 > 1.0 ) discard;

					}

				#endif

			#endif

			#include <logdepthbuf_fragment>
			#include <color_fragment>

			gl_FragColor = vec4( diffuseColor.rgb, alpha );

			#include <tonemapping_fragment>
			#include <colorspace_fragment>
			#include <fog_fragment>
			#include <premultiplied_alpha_fragment>

		}
		`};class Xp extends Pn{constructor(e){super({type:"LineMaterial",uniforms:Pu.clone(Sn.line.uniforms),vertexShader:Sn.line.vertexShader,fragmentShader:Sn.line.fragmentShader,clipping:!0}),this.isLineMaterial=!0,this.setValues(e)}get color(){return this.uniforms.diffuse.value}set color(e){this.uniforms.diffuse.value=e}get worldUnits(){return"WORLD_UNITS"in this.defines}set worldUnits(e){e===!0!==this.worldUnits&&(this.needsUpdate=!0),e===!0?this.defines.WORLD_UNITS="":delete this.defines.WORLD_UNITS}get linewidth(){return this.uniforms.linewidth.value}set linewidth(e){this.uniforms.linewidth&&(this.uniforms.linewidth.value=e)}get dashed(){return"USE_DASH"in this.defines}set dashed(e){e===!0!==this.dashed&&(this.needsUpdate=!0),e===!0?this.defines.USE_DASH="":delete this.defines.USE_DASH}get dashScale(){return this.uniforms.dashScale.value}set dashScale(e){this.uniforms.dashScale.value=e}get dashSize(){return this.uniforms.dashSize.value}set dashSize(e){this.uniforms.dashSize.value=e}get dashOffset(){return this.uniforms.dashOffset.value}set dashOffset(e){this.uniforms.dashOffset.value=e}get gapSize(){return this.uniforms.gapSize.value}set gapSize(e){this.uniforms.gapSize.value=e}get opacity(){return this.uniforms.opacity.value}set opacity(e){this.uniforms&&(this.uniforms.opacity.value=e)}get resolution(){return this.uniforms.resolution.value}set resolution(e){this.uniforms.resolution.value.copy(e)}get alphaToCoverage(){return"USE_ALPHA_TO_COVERAGE"in this.defines}set alphaToCoverage(e){this.defines&&(e===!0!==this.alphaToCoverage&&(this.needsUpdate=!0),e===!0?this.defines.USE_ALPHA_TO_COVERAGE="":delete this.defines.USE_ALPHA_TO_COVERAGE)}}const bd=new yt,Aa=new U;class Ts extends Rv{constructor(){super(),this.isLineSegmentsGeometry=!0,this.type="LineSegmentsGeometry";const e=[-1,2,0,1,2,0,-1,1,0,1,1,0,-1,0,0,1,0,0,-1,-1,0,1,-1,0],t=[-1,2,1,2,-1,1,1,1,-1,-1,1,-1,-1,-2,1,-2],i=[0,2,1,2,3,1,2,4,3,4,5,3,4,6,5,6,7,5];this.setIndex(i),this.setAttribute("position",new Wt(e,3)),this.setAttribute("uv",new Wt(t,2))}applyMatrix4(e){const t=this.attributes.instanceStart,i=this.attributes.instanceEnd;return t!==void 0&&(t.applyMatrix4(e),i.applyMatrix4(e),t.needsUpdate=!0),this.boundingBox!==null&&this.computeBoundingBox(),this.boundingSphere!==null&&this.computeBoundingSphere(),this}setPositions(e){let t;e instanceof Float32Array?t=e:Array.isArray(e)&&(t=new Float32Array(e));const i=new Gc(t,6,1);return this.setAttribute("instanceStart",new qi(i,3,0)),this.setAttribute("instanceEnd",new qi(i,3,3)),this.instanceCount=this.attributes.instanceStart.count,this.computeBoundingBox(),this.computeBoundingSphere(),this}setColors(e){let t;e instanceof Float32Array?t=e:Array.isArray(e)&&(t=new Float32Array(e));const i=new Gc(t,6,1);return this.setAttribute("instanceColorStart",new qi(i,3,0)),this.setAttribute("instanceColorEnd",new qi(i,3,3)),this}fromWireframeGeometry(e){return this.setPositions(e.attributes.position.array),this}fromEdgesGeometry(e){return this.setPositions(e.attributes.position.array),this}fromMesh(e){return this.fromWireframeGeometry(new bv(e.geometry)),this}fromLineSegments(e){const t=e.geometry;return this.setPositions(t.attributes.position.array),this}computeBoundingBox(){this.boundingBox===null&&(this.boundingBox=new yt);const e=this.attributes.instanceStart,t=this.attributes.instanceEnd;e!==void 0&&t!==void 0&&(this.boundingBox.setFromBufferAttribute(e),bd.setFromBufferAttribute(t),this.boundingBox.union(bd))}computeBoundingSphere(){this.boundingSphere===null&&(this.boundingSphere=new Yn),this.boundingBox===null&&this.computeBoundingBox();const e=this.attributes.instanceStart,t=this.attributes.instanceEnd;if(e!==void 0&&t!==void 0){const i=this.boundingSphere.center;this.boundingBox.getCenter(i);let r=0;for(let s=0,a=e.count;s<a;s++)Aa.fromBufferAttribute(e,s),r=Math.max(r,i.distanceToSquared(Aa)),Aa.fromBufferAttribute(t,s),r=Math.max(r,i.distanceToSquared(Aa));this.boundingSphere.radius=Math.sqrt(r),isNaN(this.boundingSphere.radius)&&console.error("THREE.LineSegmentsGeometry.computeBoundingSphere(): Computed radius is NaN. The instanced position data is likely to have NaN values.",this)}}toJSON(){}}const Rl=new bt,Sd=new U,Md=new U,Qt=new bt,jt=new bt,ti=new bt,Cl=new U,Pl=new et,en=new fi,wd=new U,Ra=new yt,Ca=new Yn,ni=new bt;let ii,hr;function Ed(n,e,t){return ni.set(0,0,-e,1).applyMatrix4(n.projectionMatrix),ni.multiplyScalar(1/ni.w),ni.x=hr/t.width,ni.y=hr/t.height,ni.applyMatrix4(n.projectionMatrixInverse),ni.multiplyScalar(1/ni.w),Math.abs(Math.max(ni.x,ni.y))}function LM(n,e){const t=n.matrixWorld,i=n.geometry,r=i.attributes.instanceStart,s=i.attributes.instanceEnd,a=Math.min(i.instanceCount,r.count);for(let o=0,l=a;o<l;o++){en.start.fromBufferAttribute(r,o),en.end.fromBufferAttribute(s,o),en.applyMatrix4(t);const c=new U,f=new U;ii.distanceSqToSegment(en.start,en.end,f,c),f.distanceTo(c)<hr*.5&&e.push({point:f,pointOnLine:c,distance:ii.origin.distanceTo(f),object:n,face:null,faceIndex:o,uv:null,uv1:null})}}function DM(n,e,t){const i=e.projectionMatrix,s=n.material.resolution,a=n.matrixWorld,o=n.geometry,l=o.attributes.instanceStart,c=o.attributes.instanceEnd,f=Math.min(o.instanceCount,l.count),d=-e.near;ii.at(1,ti),ti.w=1,ti.applyMatrix4(e.matrixWorldInverse),ti.applyMatrix4(i),ti.multiplyScalar(1/ti.w),ti.x*=s.x/2,ti.y*=s.y/2,ti.z=0,Cl.copy(ti),Pl.multiplyMatrices(e.matrixWorldInverse,a);for(let u=0,h=f;u<h;u++){if(Qt.fromBufferAttribute(l,u),jt.fromBufferAttribute(c,u),Qt.w=1,jt.w=1,Qt.applyMatrix4(Pl),jt.applyMatrix4(Pl),Qt.z>d&&jt.z>d)continue;if(Qt.z>d){const w=Qt.z-jt.z,y=(Qt.z-d)/w;Qt.lerp(jt,y)}else if(jt.z>d){const w=jt.z-Qt.z,y=(jt.z-d)/w;jt.lerp(Qt,y)}Qt.applyMatrix4(i),jt.applyMatrix4(i),Qt.multiplyScalar(1/Qt.w),jt.multiplyScalar(1/jt.w),Qt.x*=s.x/2,Qt.y*=s.y/2,jt.x*=s.x/2,jt.y*=s.y/2,en.start.copy(Qt),en.start.z=0,en.end.copy(jt),en.end.z=0;const g=en.closestPointToPointParameter(Cl,!0);en.at(g,wd);const p=X_.lerp(Qt.z,jt.z,g),m=p>=-1&&p<=1,v=Cl.distanceTo(wd)<hr*.5;if(m&&v){en.start.fromBufferAttribute(l,u),en.end.fromBufferAttribute(c,u),en.start.applyMatrix4(a),en.end.applyMatrix4(a);const w=new U,y=new U;ii.distanceSqToSegment(en.start,en.end,y,w),t.push({point:y,pointOnLine:w,distance:ii.origin.distanceTo(y),object:n,face:null,faceIndex:u,uv:null,uv1:null})}}}class Ll extends dn{constructor(e=new Ts,t=new Xp({color:Math.random()*16777215})){super(e,t),this.isLineSegments2=!0,this.type="LineSegments2"}computeLineDistances(){const e=this.geometry,t=e.attributes.instanceStart,i=e.attributes.instanceEnd,r=new Float32Array(2*t.count);for(let a=0,o=0,l=t.count;a<l;a++,o+=2)Sd.fromBufferAttribute(t,a),Md.fromBufferAttribute(i,a),r[o]=o===0?0:r[o-1],r[o+1]=r[o]+Sd.distanceTo(Md);const s=new Gc(r,2,1);return e.setAttribute("instanceDistanceStart",new qi(s,1,0)),e.setAttribute("instanceDistanceEnd",new qi(s,1,1)),this}raycast(e,t){const i=this.material.worldUnits,r=e.camera;if(r===null&&!i&&console.error('LineSegments2: "Raycaster.camera" needs to be set in order to raycast against LineSegments2 while worldUnits is set to false.'),i===!1&&(this.material.resolution.x===0||this.material.resolution.y===0))return;const s=e.params.Line2!==void 0&&e.params.Line2.threshold||0;ii=e.ray;const a=this.matrixWorld,o=this.geometry,l=this.material;hr=l.linewidth+s,o.boundingSphere===null&&o.computeBoundingSphere(),Ca.copy(o.boundingSphere).applyMatrix4(a);let c;if(i)c=hr*.5;else{const d=Math.max(r.near,Ca.distanceToPoint(ii.origin));c=Ed(r,d,l.resolution)}if(Ca.radius+=c,ii.intersectsSphere(Ca)===!1)return;o.boundingBox===null&&o.computeBoundingBox(),Ra.copy(o.boundingBox).applyMatrix4(a);let f;if(i)f=hr*.5;else{const d=Math.max(r.near,Ra.distanceToPoint(ii.origin));f=Ed(r,d,l.resolution)}Ra.expandByScalar(f),ii.intersectsBox(Ra)!==!1&&(i?LM(this,t):DM(this,r,t))}onBeforeRender(e){const t=this.material.uniforms;t&&t.resolution&&(e.getViewport(Rl),this.material.uniforms.resolution.value.set(Rl.z,Rl.w))}}const NM={faces:"none",edges:"none",vertices:"all"};function IM(n,e){const t=[];for(const i of n)i.tess&&t.push({id:i.id,color:i.color,visible:i.visible,tessKey:i.tessKey,tess:i.tess,feature:i.feature,bbox:i.bbox??null,vertices:e.get(`${i.id}|${i.tessKey}`)??null});return t}function UM(n,e){const{doc:t,selection:i,bus:r,kernel:s}=e,a=[],o=new Map,l=new Set,c=g=>{const p=g.rebuild.bodies,m=new Set(p.map(v=>`${v.id}|${v.tessKey}`));for(const v of[...o.keys()])m.has(v)||o.delete(v);n.setBodies(IM(p,o));for(const v of p)f(v)};async function f(g){const p=`${g.id}|${g.tessKey}`;if(!(!g.tess||o.has(p)||l.has(p))){l.add(p);try{const v=(await s.call("topo",{id:g.shape,...NM})).result.vertices,w=new Float32Array(v.length*3);v.forEach((y,S)=>w.set(y.p,3*S)),o.set(p,w),n.setVertices(g.id,g.tessKey,w)}catch{l.delete(p)}}}const d=g=>{n.highlight(g.items),n.setFilter(g.filter)};let u=!0,h=!0;const _=g=>{g.status==="ready"&&(u&&(n.setPlanes(g.view?.planes??"auto"),u=!1),h&&g.rebuild.seq>0&&g.rebuild.status!=="running"&&(g.view?.camera&&n.setCamera(g.view.camera),h=!1))};return c(t.state.get()),_(t.state.get()),a.push(t.state.subscribe((g,p)=>{g.rebuild.bodies!==p.rebuild.bodies&&c(g),g.status==="loading"&&p.status!=="loading"&&(u=!0,h=!0),(u||h)&&_(g)})),a.push(n.onCameraChange(g=>{h||t.setCamera(g)}),n.state.subscribe((g,p)=>{g.planes!==p.planes&&!u&&t.setPlanes(g.planes)})),d(i.get()),a.push(i.subscribe((g,p)=>{(g.items!==p.items||g.filter!==p.filter)&&d(g)})),a.push(n.onPick(g=>{g.type==="click"?g.pick?Ri(i,g.pick.item,g.additive):g.additive||ru(i):g.type==="contextmenu"?(g.pick&&!Ds(i.get(),g.pick.item)&&Ri(i,g.pick.item,!1),r.emit("viewport:contextmenu",{pick:g.pick,clientX:g.clientX,clientY:g.clientY})):g.type==="dblclick"&&g.pick&&r.emit("viewport:dblclick",{pick:g.pick})})),()=>{for(const g of a)g()}}const qp=0,FM=1,BM=2,Td=2,Dl=1.25,Ad=1,cn=32,Vt=cn/4,Yp=65535,so=Math.pow(2,-24),Du=Symbol("SKIP_GENERATION"),Kp={strategy:qp,maxDepth:40,targetLeafSize:10,useSharedArrayBuffer:!1,setBoundingBox:!0,onProgress:null,indirect:!1,verbose:!0,range:null,[Du]:!1};function It(n,e,t){return t.min.x=e[n],t.min.y=e[n+1],t.min.z=e[n+2],t.max.x=e[n+3],t.max.y=e[n+4],t.max.z=e[n+5],t}function Xc(n){let e=-1,t=-1/0;for(let i=0;i<3;i++){const r=n[i+3]-n[i];r>t&&(t=r,e=i)}return e}function Rd(n,e){e.set(n)}function Cd(n,e,t){let i,r;for(let s=0;s<3;s++){const a=s+3;i=n[s],r=e[s],t[s]=i<r?i:r,i=n[a],r=e[a],t[a]=i>r?i:r}}function Pa(n,e,t){for(let i=0;i<3;i++){const r=e[n+2*i],s=e[n+2*i+1],a=r-s,o=r+s;a<t[i]&&(t[i]=a),o>t[i+3]&&(t[i+3]=o)}}function ms(n){const e=n[3]-n[0],t=n[4]-n[1],i=n[5]-n[2];return 2*(e*t+t*i+i*e)}function Bt(n,e){return e[n+15]===Yp}function Zt(n,e){return e[n+6]}function un(n,e){return e[n+14]}function Ht(n){return n+Vt}function Gt(n,e){const t=e[n+6];return n+t*Vt}function Nu(n,e){return e[n+7]}function Nl(n,e,t,i,r){let s=1/0,a=1/0,o=1/0,l=-1/0,c=-1/0,f=-1/0,d=1/0,u=1/0,h=1/0,_=-1/0,g=-1/0,p=-1/0;const m=n.offset||0;for(let v=(e-m)*6,w=(e+t-m)*6;v<w;v+=6){const y=n[v+0],S=n[v+1],M=y-S,E=y+S;M<s&&(s=M),E>l&&(l=E),y<d&&(d=y),y>_&&(_=y);const b=n[v+2],T=n[v+3],C=b-T,D=b+T;C<a&&(a=C),D>c&&(c=D),b<u&&(u=b),b>g&&(g=b);const R=n[v+4],N=n[v+5],I=R-N,z=R+N;I<o&&(o=I),z>f&&(f=z),R<h&&(h=R),R>p&&(p=R)}i[0]=s,i[1]=a,i[2]=o,i[3]=l,i[4]=c,i[5]=f,r[0]=d,r[1]=u,r[2]=h,r[3]=_,r[4]=g,r[5]=p}const xi=32,OM=(n,e)=>n.candidate-e.candidate,zi=new Array(xi).fill().map(()=>({count:0,bounds:new Float32Array(6),rightCacheBounds:new Float32Array(6),leftCacheBounds:new Float32Array(6),candidate:0})),La=new Float32Array(6);function kM(n,e,t,i,r,s){let a=-1,o=0;if(s===qp)a=Xc(e),a!==-1&&(o=(e[a]+e[a+3])/2);else if(s===FM)a=Xc(n),a!==-1&&(o=zM(t,i,r,a));else if(s===BM){const l=ms(n);let c=Dl*r;const f=t.offset||0,d=(i-f)*6,u=(i+r-f)*6;for(let h=0;h<3;h++){const _=e[h],m=(e[h+3]-_)/xi;if(r<xi/4){const v=[...zi];v.length=r;let w=0;for(let S=d;S<u;S+=6,w++){const M=v[w];M.candidate=t[S+2*h],M.count=0;const{bounds:E,leftCacheBounds:b,rightCacheBounds:T}=M;for(let C=0;C<3;C++)T[C]=1/0,T[C+3]=-1/0,b[C]=1/0,b[C+3]=-1/0,E[C]=1/0,E[C+3]=-1/0;Pa(S,t,E)}v.sort(OM);let y=r;for(let S=0;S<y;S++){const M=v[S];for(;S+1<y&&v[S+1].candidate===M.candidate;)v.splice(S+1,1),y--}for(let S=d;S<u;S+=6){const M=t[S+2*h];for(let E=0;E<y;E++){const b=v[E];M>=b.candidate?Pa(S,t,b.rightCacheBounds):(Pa(S,t,b.leftCacheBounds),b.count++)}}for(let S=0;S<y;S++){const M=v[S],E=M.count,b=r-M.count,T=M.leftCacheBounds,C=M.rightCacheBounds;let D=0;E!==0&&(D=ms(T)/l);let R=0;b!==0&&(R=ms(C)/l);const N=Ad+Dl*(D*E+R*b);N<c&&(a=h,c=N,o=M.candidate)}}else{for(let y=0;y<xi;y++){const S=zi[y];S.count=0,S.candidate=_+m+y*m;const M=S.bounds;for(let E=0;E<3;E++)M[E]=1/0,M[E+3]=-1/0}for(let y=d;y<u;y+=6){let E=~~((t[y+2*h]-_)/m);E>=xi&&(E=xi-1);const b=zi[E];b.count++,Pa(y,t,b.bounds)}const v=zi[xi-1];Rd(v.bounds,v.rightCacheBounds);for(let y=xi-2;y>=0;y--){const S=zi[y],M=zi[y+1];Cd(S.bounds,M.rightCacheBounds,S.rightCacheBounds)}let w=0;for(let y=0;y<xi-1;y++){const S=zi[y],M=S.count,E=S.bounds,T=zi[y+1].rightCacheBounds;M!==0&&(w===0?Rd(E,La):Cd(E,La,La)),w+=M;let C=0,D=0;w!==0&&(C=ms(La)/l);const R=r-w;R!==0&&(D=ms(T)/l);const N=Ad+Dl*(C*w+D*R);N<c&&(a=h,c=N,o=S.candidate)}}}}else console.warn(`BVH: Invalid build strategy value ${s} used.`);return{axis:a,pos:o}}function zM(n,e,t,i){let r=0;const s=n.offset;for(let a=e,o=e+t;a<o;a++)r+=n[(a-s)*6+i*2];return r/t}class Il{constructor(){this.boundingData=new Float32Array(6)}}function VM(n,e,t,i,r,s){let a=i,o=i+r-1;const l=s.pos,c=s.axis*2,f=t.offset||0;for(;;){for(;a<=o&&t[(a-f)*6+c]<l;)a++;for(;a<=o&&t[(o-f)*6+c]>=l;)o--;if(a<o){for(let d=0;d<e;d++){let u=n[a*e+d];n[a*e+d]=n[o*e+d],n[o*e+d]=u}for(let d=0;d<6;d++){const u=a-f,h=o-f,_=t[u*6+d];t[u*6+d]=t[h*6+d],t[h*6+d]=_}a++,o--}else return a}}let Zp,ao,qc,Jp;const HM=Math.pow(2,32);function Yc(n){return"count"in n?1:1+Yc(n.left)+Yc(n.right)}function GM(n,e,t){return Zp=new Float32Array(t),ao=new Uint32Array(t),qc=new Uint16Array(t),Jp=new Uint8Array(t),Kc(n,e)}function Kc(n,e){const t=n/4,i=n/2,r="count"in e,s=e.boundingData;for(let a=0;a<6;a++)Zp[t+a]=s[a];if(r)return e.buffer?(Jp.set(new Uint8Array(e.buffer),n),n+e.buffer.byteLength):(ao[t+6]=e.offset,qc[i+14]=e.count,qc[i+15]=Yp,n+cn);{const{left:a,right:o,splitAxis:l}=e,c=n+cn;let f=Kc(c,a);const d=n/cn,h=f/cn-d;if(h>HM)throw new Error("MeshBVH: Cannot store relative child node offset greater than 32 bits.");return ao[t+6]=h,ao[t+7]=l,Kc(f,o)}}function WM(n,e,t,i,r,s){const{maxDepth:a,verbose:o,targetLeafSize:l,_strictLeafSize:c=1/0,strategy:f,onProgress:d}=r,u=n.primitiveBuffer,h=n.primitiveBufferStride,_=new Float32Array(6);let g=!1;const p=new Il;return Nl(e,t,i,p.boundingData,_),v(p,t,i,_),p;function m(w){d&&d((w-s.offset)/s.count)}function v(w,y,S,M=null,E=0){!g&&E>=a&&(g=!0,o&&console.warn(`BVH: Max depth of ${a} reached when generating BVH. Consider increasing maxDepth.`));const b=S>c;if(S<=l&&!b||E>=a)return m(y+S),w.offset=y,w.count=S,w;const T=kM(w.boundingData,M,e,y,S,f);let C=T.axis===-1?-1:VM(u,h,e,y,S,T);if(T.axis===-1||C===y||C===y+S){if(!b)return m(y+S),w.offset=y,w.count=S,w;T.axis=Math.max(0,Xc(w.boundingData)),C=y+Math.max(1,Math.floor(S/2))}w.splitAxis=T.axis;const D=new Il,R=y,N=C-y;w.left=D,Nl(e,R,N,D.boundingData,_),v(D,R,N,_,E+1);const I=new Il,z=C,$=S-N;return w.right=I,Nl(e,z,$,I.boundingData,_),v(I,z,$,_,E+1),w}}function $M(n,e){const t=e.useSharedArrayBuffer?SharedArrayBuffer:ArrayBuffer,i=n.getRootRanges(e.range),r=i[0],s=i[i.length-1],a={offset:r.offset,count:s.offset+s.count-r.offset},o=new Float32Array(6*a.count);o.offset=a.offset,n.computePrimitiveBounds(a.offset,a.count,o),n._roots=i.map(l=>{const c=WM(n,o,l.offset,l.count,e,a),f=Yc(c),d=new t(cn*f);return GM(0,c,d),d})}class Iu{constructor(e){this._getNewPrimitive=e,this._primitives=[]}getPrimitive(){const e=this._primitives;return e.length===0?this._getNewPrimitive():e.pop()}releasePrimitive(e){this._primitives.push(e)}}class XM{constructor(){this.float32Array=null,this.uint16Array=null,this.uint32Array=null;const e=[];let t=null;this.setBuffer=i=>{t&&e.push(t),t=i,this.float32Array=new Float32Array(i),this.uint16Array=new Uint16Array(i),this.uint32Array=new Uint32Array(i)},this.clearBuffer=()=>{t=null,this.float32Array=null,this.uint16Array=null,this.uint32Array=null,e.length!==0&&this.setBuffer(e.pop())}}}const Ct=new XM;let Yi,Yr;const Br=[],Da=new Iu(()=>new yt);function qM(n,e,t,i,r,s){Yi=Da.getPrimitive(),Yr=Da.getPrimitive(),Br.push(Yi,Yr),Ct.setBuffer(n._roots[e]);const a=Zc(0,n.geometry,t,i,r,s);Ct.clearBuffer(),Da.releasePrimitive(Yi),Da.releasePrimitive(Yr),Br.pop(),Br.pop();const o=Br.length;return o>0&&(Yr=Br[o-1],Yi=Br[o-2]),a}function Zc(n,e,t,i,r=null,s=0,a=0){const{float32Array:o,uint16Array:l,uint32Array:c}=Ct;let f=n*2;if(Bt(f,l)){const u=Zt(n,c),h=un(f,l);return It(n,o,Yi),i(u,h,!1,a,s+n/Vt,Yi)}else{let C=function(R){const{uint16Array:N,uint32Array:I}=Ct;let z=R*2;for(;!Bt(z,N);)R=Ht(R),z=R*2;return Zt(R,I)},D=function(R){const{uint16Array:N,uint32Array:I}=Ct;let z=R*2;for(;!Bt(z,N);)R=Gt(R,I),z=R*2;return Zt(R,I)+un(z,N)};const u=Ht(n),h=Gt(n,c);let _=u,g=h,p,m,v,w;if(r&&(v=Yi,w=Yr,It(_,o,v),It(g,o,w),p=r(v),m=r(w),m<p)){_=h,g=u;const R=p;p=m,m=R,v=w}v||(v=Yi,It(_,o,v));const y=Bt(_*2,l),S=t(v,y,p,a+1,s+_/Vt);let M;if(S===Td){const R=C(_),I=D(_)-R;M=i(R,I,!0,a+1,s+_/Vt,v)}else M=S&&Zc(_,e,t,i,r,s,a+1);if(M)return!0;w=Yr,It(g,o,w);const E=Bt(g*2,l),b=t(w,E,m,a+1,s+g/Vt);let T;if(b===Td){const R=C(g),I=D(g)-R;T=i(R,I,!0,a+1,s+g/Vt,w)}else T=b&&Zc(g,e,t,i,r,s,a+1);return!!T}}const Ls=new Ct.constructor,Ro=new Ct.constructor,Hi=new Iu(()=>new yt),Or=new yt,kr=new yt,Ul=new yt,Fl=new yt;let Bl=!1;function YM(n,e,t,i){if(Bl)throw new Error("MeshBVH: Recursive calls to bvhcast not supported.");Bl=!0;const r=n._roots,s=e._roots;let a,o=0,l=0;const c=new et().copy(t).invert();for(let f=0,d=r.length;f<d;f++){Ls.setBuffer(r[f]),l=0;const u=Hi.getPrimitive();It(0,Ls.float32Array,u),u.applyMatrix4(c);for(let h=0,_=s.length;h<_&&(Ro.setBuffer(s[h]),a=Hn(0,0,t,c,i,o,l,0,0,u),Ro.clearBuffer(),l+=s[h].byteLength/cn,!a);h++);if(Hi.releasePrimitive(u),Ls.clearBuffer(),o+=r[f].byteLength/cn,a)break}return Bl=!1,a}function Hn(n,e,t,i,r,s=0,a=0,o=0,l=0,c=null,f=!1){let d,u;f?(d=Ro,u=Ls):(d=Ls,u=Ro);const h=d.float32Array,_=d.uint32Array,g=d.uint16Array,p=u.float32Array,m=u.uint32Array,v=u.uint16Array,w=n*2,y=e*2,S=Bt(w,g),M=Bt(y,v);let E=!1;if(M&&S)f?E=r(Zt(e,m),un(e*2,v),Zt(n,_),un(n*2,g),l,a+e/Vt,o,s+n/Vt):E=r(Zt(n,_),un(n*2,g),Zt(e,m),un(e*2,v),o,s+n/Vt,l,a+e/Vt);else if(M){const b=Hi.getPrimitive();It(e,p,b),b.applyMatrix4(t);const T=Ht(n),C=Gt(n,_);It(T,h,Or),It(C,h,kr);const D=b.intersectsBox(Or),R=b.intersectsBox(kr);E=D&&Hn(e,T,i,t,r,a,s,l,o+1,b,!f)||R&&Hn(e,C,i,t,r,a,s,l,o+1,b,!f),Hi.releasePrimitive(b)}else{const b=Ht(e),T=Gt(e,m);It(b,p,Ul),It(T,p,Fl);const C=c.intersectsBox(Ul),D=c.intersectsBox(Fl);if(C&&D)E=Hn(n,b,t,i,r,s,a,o,l+1,c,f)||Hn(n,T,t,i,r,s,a,o,l+1,c,f);else if(C)if(S)E=Hn(n,b,t,i,r,s,a,o,l+1,c,f);else{const R=Hi.getPrimitive();R.copy(Ul).applyMatrix4(t);const N=Ht(n),I=Gt(n,_);It(N,h,Or),It(I,h,kr);const z=R.intersectsBox(Or),$=R.intersectsBox(kr);E=z&&Hn(b,N,i,t,r,a,s,l,o+1,R,!f)||$&&Hn(b,I,i,t,r,a,s,l,o+1,R,!f),Hi.releasePrimitive(R)}else if(D)if(S)E=Hn(n,T,t,i,r,s,a,o,l+1,c,f);else{const R=Hi.getPrimitive();R.copy(Fl).applyMatrix4(t);const N=Ht(n),I=Gt(n,_);It(N,h,Or),It(I,h,kr);const z=R.intersectsBox(Or),$=R.intersectsBox(kr);E=z&&Hn(T,N,i,t,r,a,s,l,o+1,R,!f)||$&&Hn(T,I,i,t,r,a,s,l,o+1,R,!f),Hi.releasePrimitive(R)}}return E}const Ol=new class{constructor(){let n=null,e=null,t=null,i=!1;this.root=null,this.buffer=null,this.uint32Array=null,this.uint16Array=null,this.setBVH=(s,a)=>{if(i)throw new Error("BVHTraversalHelper: cannot call setBVH during an active traversal.");this.root=a,this.buffer=n=s._roots[a],this.uint16Array=t=new Uint16Array(n),this.uint32Array=e=new Uint32Array(n)},this.reset=()=>{this.root=null,this.buffer=n=null,this.uint16Array=t=null,this.uint32Array=e=null},this.getRangeStart=s=>{let a=s*2;for(;!Bt(a,t);)s=Ht(s),a=s*2;return Zt(s,e)},this.getRangeEnd=s=>{let a=s*2;for(;!Bt(a,t);)s=Gt(s,e),a=s*2;return Zt(s,e)+un(a,t)};const r=(s,a,o)=>{const l=a*2,c=Bt(l,t);if(!s(o,c,a)&&!c){const d=Ht(a),u=Gt(a,e);r(s,d,o+1),r(s,u,o+1)}};this.traverseBuffer=s=>{if(i)throw new Error("BVHTraversalHelper: cannot start a traversal during an active traversal.");i=!0;try{r(s,0,0)}finally{i=!1}},this.traverse=s=>{this.traverseBuffer((a,o,l)=>{if(o){const c=l*2,f=e[l+6],d=t[c+14];return s(a,o,new Float32Array(n,l*4,6),f,d)}else{const c=Nu(l,e);return s(a,o,new Float32Array(n,l*4,6),c)}})}}},Pd=new yt,zr=new Float32Array(6);class KM{constructor(){this._roots=null,this.primitiveBuffer=null,this.primitiveBufferStride=null}init(e){e={...Kp,...e},"maxLeafSize"in e&&(console.warn('BVH: "maxLeafSize" option has been deprecated. Use "targetLeafSize", instead.'),e={...e,targetLeafSize:e.maxLeafSize}),$M(this,e)}getRootRanges(){throw new Error("BVH: getRootRanges() not implemented")}writePrimitiveBounds(){throw new Error("BVH: writePrimitiveBounds() not implemented")}writePrimitiveRangeBounds(e,t,i,r){let s=1/0,a=1/0,o=1/0,l=-1/0,c=-1/0,f=-1/0;for(let d=e,u=e+t;d<u;d++){this.writePrimitiveBounds(d,zr,0);const[h,_,g,p,m,v]=zr;h<s&&(s=h),p>l&&(l=p),_<a&&(a=_),m>c&&(c=m),g<o&&(o=g),v>f&&(f=v)}return i[r+0]=s,i[r+1]=a,i[r+2]=o,i[r+3]=l,i[r+4]=c,i[r+5]=f,i}computePrimitiveBounds(e,t,i){const r=i.offset||0;for(let s=e,a=e+t;s<a;s++){this.writePrimitiveBounds(s,zr,0);const[o,l,c,f,d,u]=zr,h=(o+f)/2,_=(l+d)/2,g=(c+u)/2,p=(f-o)/2,m=(d-l)/2,v=(u-c)/2,w=(s-r)*6;i[w+0]=h,i[w+1]=p+(Math.abs(h)+p)*so,i[w+2]=_,i[w+3]=m+(Math.abs(_)+m)*so,i[w+4]=g,i[w+5]=v+(Math.abs(g)+v)*so}return i}shiftPrimitiveOffsets(e){const t=this._indirectBuffer;if(t)for(let i=0,r=t.length;i<r;i++)t[i]+=e;else{const i=this._roots;for(let r=0;r<i.length;r++){const s=i[r],a=new Uint32Array(s),o=new Uint16Array(s),l=s.byteLength/cn;for(let c=0;c<l;c++){const f=Vt*c,d=2*f;Bt(d,o)&&(a[f+6]+=e)}}}}traverse(e,t=0){Ol.setBVH(this,t),Ol.traverse(e),Ol.reset()}refit(){const e=this._roots;for(let t=0,i=e.length;t<i;t++){const r=e[t],s=new Uint32Array(r),a=new Uint16Array(r),o=new Float32Array(r),l=r.byteLength/cn;for(let c=l-1;c>=0;c--){const f=c*Vt,d=f*2;if(Bt(d,a)){const h=Zt(f,s),_=un(d,a);this.writePrimitiveRangeBounds(h,_,zr,0),o.set(zr,f)}else{const h=Ht(f),_=Gt(f,s);for(let g=0;g<3;g++){const p=o[h+g],m=o[h+g+3],v=o[_+g],w=o[_+g+3];o[f+g]=p<v?p:v,o[f+g+3]=m>w?m:w}}}}}getBoundingBox(e){return e.makeEmpty(),this._roots.forEach(i=>{It(0,new Float32Array(i),Pd),e.union(Pd)}),e}shapecast(e){let{boundsTraverseOrder:t,intersectsBounds:i,intersectsRange:r,intersectsPrimitive:s,scratchPrimitive:a,iterate:o}=e;if(r&&s){const d=r;r=(u,h,_,g,p)=>d(u,h,_,g,p)?!0:o(u,h,this,s,_,g,a)}else r||(s?r=(d,u,h,_)=>o(d,u,this,s,h,_,a):r=(d,u,h)=>h);let l=!1,c=0;const f=this._roots;for(let d=0,u=f.length;d<u;d++){const h=f[d];if(l=qM(this,d,i,r,t,c),l)break;c+=h.byteLength/cn}return l}bvhcast(e,t,i){let{intersectsRanges:r}=i;return YM(this,e,t,r)}}function ZM(){return typeof SharedArrayBuffer<"u"}function Uu(n){return n.index?n.index.count:n.attributes.position.count}function ko(n){return Uu(n)/3}function JM(n,e=ArrayBuffer){return n>65535?new Uint32Array(new e(4*n)):new Uint16Array(new e(2*n))}function QM(n,e){if(!n.index){const t=n.attributes.position.count,i=e.useSharedArrayBuffer?SharedArrayBuffer:ArrayBuffer,r=JM(t,i);n.setIndex(new Kt(r,1));for(let s=0;s<t;s++)r[s]=s}}function jM(n,e,t){const i=Uu(n)/t,r=e||n.drawRange,s=r.start/t,a=(r.start+r.count)/t,o=Math.max(0,s),l=Math.min(i,a)-o;return{offset:Math.floor(o),count:Math.floor(l)}}function ew(n,e){return n.groups.map(t=>({offset:t.start/e,count:t.count/e}))}function Ld(n,e,t){const i=jM(n,e,t),r=ew(n,t);if(!r.length)return[i];const s=[],a=i.offset,o=i.offset+i.count,l=Uu(n)/t,c=[];for(const u of r){const{offset:h,count:_}=u,g=h,p=isFinite(_)?_:l-h,m=h+p;g<o&&m>a&&(c.push({pos:Math.max(a,g),isStart:!0}),c.push({pos:Math.min(o,m),isStart:!1}))}c.sort((u,h)=>u.pos!==h.pos?u.pos-h.pos:u.type==="end"?-1:1);let f=0,d=null;for(const u of c){const h=u.pos;f!==0&&h!==d&&s.push({offset:d,count:h-d}),f+=u.isStart?1:-1,d=h}return s}function tw(n,e){const t=n[n.length-1],i=t.offset+t.count>2**16,r=n.reduce((c,f)=>c+f.count,0),s=i?4:2,a=e?new SharedArrayBuffer(r*s):new ArrayBuffer(r*s),o=i?new Uint32Array(a):new Uint16Array(a);let l=0;for(let c=0;c<n.length;c++){const{offset:f,count:d}=n[c];for(let u=0;u<d;u++)o[l+u]=f+u;l+=d}return o}class nw extends KM{get indirect(){return!!this._indirectBuffer}get primitiveStride(){return null}get primitiveBufferStride(){return this.indirect?1:this.primitiveStride}set primitiveBufferStride(e){}get primitiveBuffer(){return this.indirect?this._indirectBuffer:this.geometry.index.array}set primitiveBuffer(e){}constructor(e,t={}){if(e.isBufferGeometry){if(e.index&&e.index.isInterleavedBufferAttribute)throw new Error("BVH: InterleavedBufferAttribute is not supported for the index attribute.")}else throw new Error("BVH: Only BufferGeometries are supported.");if(t.useSharedArrayBuffer&&!ZM())throw new Error("BVH: SharedArrayBuffer is not available.");super(),this.geometry=e,this.resolvePrimitiveIndex=t.indirect?i=>this._indirectBuffer[i]:i=>i,this.primitiveBuffer=null,this.primitiveBufferStride=null,this._indirectBuffer=null,t={...Kp,...t},t[Du]||this.init(t)}init(e){const{geometry:t,primitiveStride:i}=this;if(e.indirect){const r=Ld(t,e.range,i),s=tw(r,e.useSharedArrayBuffer);this._indirectBuffer=s}else QM(t,e);super.init(e),!t.boundingBox&&e.setBoundingBox&&(t.boundingBox=this.getBoundingBox(new yt))}getRootRanges(e){return this.indirect?[{offset:0,count:this._indirectBuffer.length}]:Ld(this.geometry,e,this.primitiveStride)}raycastObject3D(){throw new Error("BVH: raycastObject3D() not implemented")}}class Pi{constructor(){this.min=1/0,this.max=-1/0}setFromPointsField(e,t){let i=1/0,r=-1/0;for(let s=0,a=e.length;s<a;s++){const l=e[s][t];i=l<i?l:i,r=l>r?l:r}this.min=i,this.max=r}setFromPoints(e,t){let i=1/0,r=-1/0;for(let s=0,a=t.length;s<a;s++){const o=t[s],l=e.dot(o);i=l<i?l:i,r=l>r?l:r}this.min=i,this.max=r}isSeparated(e){return this.min>e.max||e.min>this.max}}Pi.prototype.setFromBox=(function(){const n=new U;return function(t,i){const r=i.min,s=i.max;let a=1/0,o=-1/0;for(let l=0;l<=1;l++)for(let c=0;c<=1;c++)for(let f=0;f<=1;f++){n.x=r.x*l+s.x*(1-l),n.y=r.y*c+s.y*(1-c),n.z=r.z*f+s.z*(1-f);const d=t.dot(n);a=Math.min(d,a),o=Math.max(d,o)}this.min=a,this.max=o}})();const iw=(function(){const n=new U,e=new U,t=new U;return function(r,s,a){const o=r.start,l=n,c=s.start,f=e;t.subVectors(o,c),n.subVectors(r.end,r.start),e.subVectors(s.end,s.start);const d=t.dot(f),u=f.dot(l),h=f.dot(f),_=t.dot(l),p=l.dot(l)*h-u*u;let m,v;p!==0?m=(d*u-_*h)/p:m=0,v=(d+m*u)/h,a.x=m,a.y=v}})(),Fu=(function(){const n=new Ze,e=new U,t=new U;return function(r,s,a,o){iw(r,s,n);let l=n.x,c=n.y;if(l>=0&&l<=1&&c>=0&&c<=1){r.at(l,a),s.at(c,o);return}else if(l>=0&&l<=1){c<0?s.at(0,o):s.at(1,o),r.closestPointToPoint(o,!0,a);return}else if(c>=0&&c<=1){l<0?r.at(0,a):r.at(1,a),s.closestPointToPoint(a,!0,o);return}else{let f;l<0?f=r.start:f=r.end;let d;c<0?d=s.start:d=s.end;const u=e,h=t;if(r.closestPointToPoint(d,!0,e),s.closestPointToPoint(f,!0,t),u.distanceToSquared(d)<=h.distanceToSquared(f)){a.copy(u),o.copy(d);return}else{a.copy(f),o.copy(h);return}}}})(),rw=(function(){const n=new U,e=new U,t=new Fn,i=new fi;return function(s,a){const{radius:o,center:l}=s,{a:c,b:f,c:d}=a;if(i.start=c,i.end=f,i.closestPointToPoint(l,!0,n).distanceTo(l)<=o||(i.start=c,i.end=d,i.closestPointToPoint(l,!0,n).distanceTo(l)<=o)||(i.start=f,i.end=d,i.closestPointToPoint(l,!0,n).distanceTo(l)<=o))return!0;const g=a.getPlane(t);if(Math.abs(g.distanceToPoint(l))<=o){const m=g.projectPoint(l,e);if(a.containsPoint(m))return!0}return!1}})(),sw=["x","y","z"],bi=1e-15,Dd=bi*bi;function In(n){return Math.abs(n)<bi}class Kn extends nn{constructor(...e){super(...e),this.isExtendedTriangle=!0,this.satAxes=new Array(4).fill().map(()=>new U),this.satBounds=new Array(4).fill().map(()=>new Pi),this.points=[this.a,this.b,this.c],this.plane=new Fn,this.isDegenerateIntoSegment=!1,this.isDegenerateIntoPoint=!1,this.degenerateSegment=new fi,this.needsUpdate=!0}intersectsSphere(e){return rw(e,this)}update(){const e=this.a,t=this.b,i=this.c,r=this.points,s=this.satAxes,a=this.satBounds,o=s[0],l=a[0];this.getNormal(o),l.setFromPoints(o,r);const c=s[1],f=a[1];c.subVectors(e,t),f.setFromPoints(c,r);const d=s[2],u=a[2];d.subVectors(t,i),u.setFromPoints(d,r);const h=s[3],_=a[3];h.subVectors(i,e),_.setFromPoints(h,r);const g=c.length(),p=d.length(),m=h.length();this.isDegenerateIntoPoint=!1,this.isDegenerateIntoSegment=!1,g<bi?p<bi||m<bi?this.isDegenerateIntoPoint=!0:(this.isDegenerateIntoSegment=!0,this.degenerateSegment.start.copy(e),this.degenerateSegment.end.copy(i)):p<bi?m<bi?this.isDegenerateIntoPoint=!0:(this.isDegenerateIntoSegment=!0,this.degenerateSegment.start.copy(t),this.degenerateSegment.end.copy(e)):m<bi&&(this.isDegenerateIntoSegment=!0,this.degenerateSegment.start.copy(i),this.degenerateSegment.end.copy(t)),this.plane.setFromNormalAndCoplanarPoint(o,e),this.needsUpdate=!1}}Kn.prototype.closestPointToSegment=(function(){const n=new U,e=new U,t=new fi;return function(r,s=null,a=null){const{start:o,end:l}=r,c=this.points;let f,d=1/0;for(let u=0;u<3;u++){const h=(u+1)%3;t.start.copy(c[u]),t.end.copy(c[h]),Fu(t,r,n,e),f=n.distanceToSquared(e),f<d&&(d=f,s&&s.copy(n),a&&a.copy(e))}return this.closestPointToPoint(o,n),f=o.distanceToSquared(n),f<d&&(d=f,s&&s.copy(n),a&&a.copy(o)),this.closestPointToPoint(l,n),f=l.distanceToSquared(n),f<d&&(d=f,s&&s.copy(n),a&&a.copy(l)),Math.sqrt(d)}})();Kn.prototype.intersectsTriangle=(function(){const n=new Kn,e=new Pi,t=new Pi,i=new U,r=new U,s=new U,a=new U,o=new fi,l=new fi,c=new U,f=new Ze,d=new Ze;function u(w,y,S,M){const E=i;!w.isDegenerateIntoPoint&&!w.isDegenerateIntoSegment?E.copy(w.plane.normal):E.copy(y.plane.normal);const b=w.satBounds,T=w.satAxes;for(let R=1;R<4;R++){const N=b[R],I=T[R];if(e.setFromPoints(I,y.points),N.isSeparated(e)||(a.copy(E).cross(I),e.setFromPoints(a,w.points),t.setFromPoints(a,y.points),e.isSeparated(t)))return!1}const C=y.satBounds,D=y.satAxes;for(let R=1;R<4;R++){const N=C[R],I=D[R];if(e.setFromPoints(I,w.points),N.isSeparated(e)||(a.crossVectors(E,I),e.setFromPoints(a,w.points),t.setFromPoints(a,y.points),e.isSeparated(t)))return!1}return S&&(M||console.warn("ExtendedTriangle.intersectsTriangle: Triangles are coplanar which does not support an output edge. Setting edge to 0, 0, 0."),S.start.set(0,0,0),S.end.set(0,0,0)),!0}function h(w,y,S,M,E,b,T,C,D,R,N){let I=T/(T-C);R.x=M+(E-M)*I,N.start.subVectors(y,w).multiplyScalar(I).add(w),I=T/(T-D),R.y=M+(b-M)*I,N.end.subVectors(S,w).multiplyScalar(I).add(w)}function _(w,y,S,M,E,b,T,C,D,R,N){if(E>0)h(w.c,w.a,w.b,M,y,S,D,T,C,R,N);else if(b>0)h(w.b,w.a,w.c,S,y,M,C,T,D,R,N);else if(C*D>0||T!=0)h(w.a,w.b,w.c,y,S,M,T,C,D,R,N);else if(C!=0)h(w.b,w.a,w.c,S,y,M,C,T,D,R,N);else if(D!=0)h(w.c,w.a,w.b,M,y,S,D,T,C,R,N);else return!0;return!1}function g(w,y,S,M){const E=y.degenerateSegment,b=w.plane.distanceToPoint(E.start),T=w.plane.distanceToPoint(E.end);return In(b)?In(T)?u(w,y,S,M):(S&&(S.start.copy(E.start),S.end.copy(E.start)),w.containsPoint(E.start)):In(T)?(S&&(S.start.copy(E.end),S.end.copy(E.end)),w.containsPoint(E.end)):w.plane.intersectLine(E,i)!=null?(S&&(S.start.copy(i),S.end.copy(i)),w.containsPoint(i)):!1}function p(w,y,S){const M=y.a;return In(w.plane.distanceToPoint(M))&&w.containsPoint(M)?(S&&(S.start.copy(M),S.end.copy(M)),!0):!1}function m(w,y,S){const M=w.degenerateSegment,E=y.a;return M.closestPointToPoint(E,!0,i),E.distanceToSquared(i)<Dd?(S&&(S.start.copy(E),S.end.copy(E)),!0):!1}function v(w,y,S,M){if(w.isDegenerateIntoSegment)if(y.isDegenerateIntoSegment){const E=w.degenerateSegment,b=y.degenerateSegment,T=r,C=s;E.delta(T),b.delta(C);const D=i.subVectors(b.start,E.start),R=T.x*C.y-T.y*C.x;if(In(R))return!1;const N=(D.x*C.y-D.y*C.x)/R,I=-(T.x*D.y-T.y*D.x)/R;if(N<0||N>1||I<0||I>1)return!1;const z=E.start.z+T.z*N,$=b.start.z+C.z*I;return In(z-$)?(S&&(S.start.copy(E.start).addScaledVector(T,N),S.end.copy(E.start).addScaledVector(T,N)),!0):!1}else return y.isDegenerateIntoPoint?m(w,y,S):g(y,w,S,M);else{if(w.isDegenerateIntoPoint)return y.isDegenerateIntoPoint?y.a.distanceToSquared(w.a)<Dd?(S&&(S.start.copy(w.a),S.end.copy(w.a)),!0):!1:y.isDegenerateIntoSegment?m(y,w,S):p(y,w,S);if(y.isDegenerateIntoPoint)return p(w,y,S);if(y.isDegenerateIntoSegment)return g(w,y,S,M)}}return function(y,S=null,M=!1){this.needsUpdate&&this.update(),y.isExtendedTriangle?y.needsUpdate&&y.update():(n.copy(y),n.update(),y=n);const E=v(this,y,S,M);if(E!==void 0)return E;const b=this.plane,T=y.plane;let C=T.distanceToPoint(this.a),D=T.distanceToPoint(this.b),R=T.distanceToPoint(this.c);In(C)&&(C=0),In(D)&&(D=0),In(R)&&(R=0);const N=C*D,I=C*R;if(N>0&&I>0)return!1;let z=b.distanceToPoint(y.a),$=b.distanceToPoint(y.b),X=b.distanceToPoint(y.c);In(z)&&(z=0),In($)&&($=0),In(X)&&(X=0);const re=z*$,J=z*X;if(re>0&&J>0)return!1;r.copy(b.normal),s.copy(T.normal);const Q=r.cross(s);let te=0,ue=Math.abs(Q.x);const be=Math.abs(Q.y);be>ue&&(ue=be,te=1),Math.abs(Q.z)>ue&&(te=2);const Re=sw[te],je=this.a[Re],ne=this.b[Re],ae=this.c[Re],Me=y.a[Re],Be=y.b[Re],ve=y.c[Re];if(_(this,je,ne,ae,N,I,C,D,R,f,o))return u(this,y,S,M);if(_(y,Me,Be,ve,re,J,z,$,X,d,l))return u(this,y,S,M);if(f.y<f.x){const ke=f.y;f.y=f.x,f.x=ke,c.copy(o.start),o.start.copy(o.end),o.end.copy(c)}if(d.y<d.x){const ke=d.y;d.y=d.x,d.x=ke,c.copy(l.start),l.start.copy(l.end),l.end.copy(c)}return f.y<d.x||d.y<f.x?!1:(S&&(d.x>f.x?S.start.copy(l.start):S.start.copy(o.start),d.y<f.y?S.end.copy(l.end):S.end.copy(o.end)),!0)}})();Kn.prototype.distanceToPoint=(function(){const n=new U;return function(t){return this.closestPointToPoint(t,n),t.distanceTo(n)}})();Kn.prototype.distanceToTriangle=(function(){const n=new U,e=new U,t=["a","b","c"],i=new fi,r=new fi;return function(a,o=null,l=null){const c=o||l?i:null;if(this.intersectsTriangle(a,c,!0))return(o||l)&&(o&&c.getCenter(o),l&&c.getCenter(l)),0;let f=1/0;for(let d=0;d<3;d++){let u;const h=t[d],_=a[h];this.closestPointToPoint(_,n),u=_.distanceToSquared(n),u<f&&(f=u,o&&o.copy(n),l&&l.copy(_));const g=this[h];a.closestPointToPoint(g,n),u=g.distanceToSquared(n),u<f&&(f=u,o&&o.copy(g),l&&l.copy(n))}for(let d=0;d<3;d++){const u=t[d],h=t[(d+1)%3];i.set(this[u],this[h]);for(let _=0;_<3;_++){const g=t[_],p=t[(_+1)%3];r.set(a[g],a[p]),Fu(i,r,n,e);const m=n.distanceToSquared(e);m<f&&(f=m,o&&o.copy(n),l&&l.copy(e))}}return Math.sqrt(f)}})();class yn{constructor(e,t,i){this.isOrientedBox=!0,this.min=new U,this.max=new U,this.matrix=new et,this.invMatrix=new et,this.points=new Array(8).fill().map(()=>new U),this.satAxes=new Array(3).fill().map(()=>new U),this.satBounds=new Array(3).fill().map(()=>new Pi),this.alignedSatBounds=new Array(3).fill().map(()=>new Pi),this.needsUpdate=!1,e&&this.min.copy(e),t&&this.max.copy(t),i&&this.matrix.copy(i)}set(e,t,i){this.min.copy(e),this.max.copy(t),this.matrix.copy(i),this.needsUpdate=!0}copy(e){this.min.copy(e.min),this.max.copy(e.max),this.matrix.copy(e.matrix),this.needsUpdate=!0}}yn.prototype.update=(function(){return function(){const e=this.matrix,t=this.min,i=this.max,r=this.points;for(let c=0;c<=1;c++)for(let f=0;f<=1;f++)for(let d=0;d<=1;d++){const u=1*c|2*f|4*d,h=r[u];h.x=c?i.x:t.x,h.y=f?i.y:t.y,h.z=d?i.z:t.z,h.applyMatrix4(e)}const s=this.satBounds,a=this.satAxes,o=r[0];for(let c=0;c<3;c++){const f=a[c],d=s[c],u=1<<c,h=r[u];f.subVectors(o,h),d.setFromPoints(f,r)}const l=this.alignedSatBounds;l[0].setFromPointsField(r,"x"),l[1].setFromPointsField(r,"y"),l[2].setFromPointsField(r,"z"),this.invMatrix.copy(this.matrix).invert(),this.needsUpdate=!1}})();yn.prototype.intersectsBox=(function(){const n=new Pi;return function(t){this.needsUpdate&&this.update();const i=t.min,r=t.max,s=this.satBounds,a=this.satAxes,o=this.alignedSatBounds;if(n.min=i.x,n.max=r.x,o[0].isSeparated(n)||(n.min=i.y,n.max=r.y,o[1].isSeparated(n))||(n.min=i.z,n.max=r.z,o[2].isSeparated(n)))return!1;for(let l=0;l<3;l++){const c=a[l],f=s[l];if(n.setFromBox(c,t),f.isSeparated(n))return!1}return!0}})();yn.prototype.intersectsTriangle=(function(){const n=new Kn,e=new Array(3),t=new Pi,i=new Pi,r=new U;return function(a){this.needsUpdate&&this.update(),a.isExtendedTriangle?a.needsUpdate&&a.update():(n.copy(a),n.update(),a=n);const o=this.satBounds,l=this.satAxes;e[0]=a.a,e[1]=a.b,e[2]=a.c;for(let u=0;u<3;u++){const h=o[u],_=l[u];if(t.setFromPoints(_,e),h.isSeparated(t))return!1}const c=a.satBounds,f=a.satAxes,d=this.points;for(let u=0;u<3;u++){const h=c[u],_=f[u];if(t.setFromPoints(_,d),h.isSeparated(t))return!1}for(let u=0;u<3;u++){const h=l[u];for(let _=0;_<4;_++){const g=f[_];if(r.crossVectors(h,g),t.setFromPoints(r,e),i.setFromPoints(r,d),t.isSeparated(i))return!1}}return!0}})();yn.prototype.closestPointToPoint=(function(){return function(e,t){return this.needsUpdate&&this.update(),t.copy(e).applyMatrix4(this.invMatrix).clamp(this.min,this.max).applyMatrix4(this.matrix),t}})();yn.prototype.distanceToPoint=(function(){const n=new U;return function(t){return this.closestPointToPoint(t,n),t.distanceTo(n)}})();yn.prototype.distanceToBox=(function(){const n=["x","y","z"],e=new Array(12).fill().map(()=>new fi),t=new Array(12).fill().map(()=>new fi),i=new U,r=new U;return function(a,o=0,l=null,c=null){if(this.needsUpdate&&this.update(),this.intersectsBox(a))return(l||c)&&(a.getCenter(r),this.closestPointToPoint(r,i),a.closestPointToPoint(i,r),l&&l.copy(i),c&&c.copy(r)),0;const f=o*o,d=a.min,u=a.max,h=this.points;let _=1/0;for(let p=0;p<8;p++){const m=h[p];r.copy(m).clamp(d,u);const v=m.distanceToSquared(r);if(v<_&&(_=v,l&&l.copy(m),c&&c.copy(r),v<f))return Math.sqrt(v)}let g=0;for(let p=0;p<3;p++)for(let m=0;m<=1;m++)for(let v=0;v<=1;v++){const w=(p+1)%3,y=(p+2)%3,S=m<<w|v<<y,M=1<<p|m<<w|v<<y,E=h[S],b=h[M];e[g].set(E,b);const C=n[p],D=n[w],R=n[y],N=t[g],I=N.start,z=N.end;I[C]=d[C],I[D]=m?d[D]:u[D],I[R]=v?d[R]:u[D],z[C]=u[C],z[D]=m?d[D]:u[D],z[R]=v?d[R]:u[D],g++}for(let p=0;p<=1;p++)for(let m=0;m<=1;m++)for(let v=0;v<=1;v++){r.x=p?u.x:d.x,r.y=m?u.y:d.y,r.z=v?u.z:d.z,this.closestPointToPoint(r,i);const w=r.distanceToSquared(i);if(w<_&&(_=w,l&&l.copy(i),c&&c.copy(r),w<f))return Math.sqrt(w)}for(let p=0;p<12;p++){const m=e[p];for(let v=0;v<12;v++){const w=t[v];Fu(m,w,i,r);const y=i.distanceToSquared(r);if(y<_&&(_=y,l&&l.copy(i),c&&c.copy(r),y<f))return Math.sqrt(y)}}return Math.sqrt(_)}})();class aw extends Iu{constructor(){super(()=>new Kn)}}const On=new aw,gs=new U,kl=new U;function ow(n,e,t={},i=0,r=1/0){const s=i*i,a=r*r;let o=1/0,l=null;if(n.shapecast({boundsTraverseOrder:f=>(gs.copy(e).clamp(f.min,f.max),gs.distanceToSquared(e)),intersectsBounds:(f,d,u)=>u<o&&u<a,intersectsTriangle:(f,d)=>{f.closestPointToPoint(e,gs);const u=e.distanceToSquared(gs);return u<o&&(kl.copy(gs),o=u,l=d),u<s}}),o===1/0)return null;const c=Math.sqrt(o);return t.point?t.point.copy(kl):t.point=kl.clone(),t.distance=c,t.faceIndex=l,t}const Na=parseInt(Vs)>=169,lw=parseInt(Vs)<=161,ir=new U,rr=new U,sr=new U,Ia=new Ze,Ua=new Ze,Fa=new Ze,Nd=new U,Id=new U,Ud=new U,_s=new U;function cw(n,e,t,i,r,s,a,o){let l;if(s===fn?l=n.intersectTriangle(i,t,e,!0,r):l=n.intersectTriangle(e,t,i,s!==Mn,r),l===null)return null;const c=n.origin.distanceTo(r);return c<a||c>o?null:{distance:c,point:r.clone()}}function Fd(n,e,t,i,r,s,a,o,l,c,f){ir.fromBufferAttribute(e,s),rr.fromBufferAttribute(e,a),sr.fromBufferAttribute(e,o);const d=cw(n,ir,rr,sr,_s,l,c,f);if(d){if(i){Ia.fromBufferAttribute(i,s),Ua.fromBufferAttribute(i,a),Fa.fromBufferAttribute(i,o),d.uv=new Ze;const h=nn.getInterpolation(_s,ir,rr,sr,Ia,Ua,Fa,d.uv);Na||(d.uv=h)}if(r){Ia.fromBufferAttribute(r,s),Ua.fromBufferAttribute(r,a),Fa.fromBufferAttribute(r,o),d.uv1=new Ze;const h=nn.getInterpolation(_s,ir,rr,sr,Ia,Ua,Fa,d.uv1);Na||(d.uv1=h),lw&&(d.uv2=d.uv1)}if(t){Nd.fromBufferAttribute(t,s),Id.fromBufferAttribute(t,a),Ud.fromBufferAttribute(t,o),d.normal=new U;const h=nn.getInterpolation(_s,ir,rr,sr,Nd,Id,Ud,d.normal);d.normal.dot(n.direction)>0&&d.normal.multiplyScalar(-1),Na||(d.normal=h)}const u={a:s,b:a,c:o,normal:new U,materialIndex:0};if(nn.getNormal(ir,rr,sr,u.normal),d.face=u,d.faceIndex=s,Na){const h=new U;nn.getBarycoord(_s,ir,rr,sr,h),d.barycoord=h}}return d}function Bd(n){return n&&n.isMaterial?n.side:n}function zo(n,e,t,i,r,s,a){const o=i*3;let l=o+0,c=o+1,f=o+2;const{index:d,groups:u}=n;n.index&&(l=d.getX(l),c=d.getX(c),f=d.getX(f));const{position:h,normal:_,uv:g,uv1:p}=n.attributes;if(Array.isArray(e)){const m=i*3;for(let v=0,w=u.length;v<w;v++){const{start:y,count:S,materialIndex:M}=u[v];if(m>=y&&m<y+S){const E=Bd(e[M]),b=Fd(t,h,_,g,p,l,c,f,E,s,a);if(b)if(b.faceIndex=i,b.face.materialIndex=M,r)r.push(b);else return b}}}else{const m=Bd(e),v=Fd(t,h,_,g,p,l,c,f,m,s,a);if(v)if(v.faceIndex=i,v.face.materialIndex=0,r)r.push(v);else return v}return null}function zt(n,e,t,i){const r=n.a,s=n.b,a=n.c;let o=e,l=e+1,c=e+2;t&&(o=t.getX(o),l=t.getX(l),c=t.getX(c)),r.x=i.getX(o),r.y=i.getY(o),r.z=i.getZ(o),s.x=i.getX(l),s.y=i.getY(l),s.z=i.getZ(l),a.x=i.getX(c),a.y=i.getY(c),a.z=i.getZ(c)}function uw(n,e,t,i,r,s,a,o){const{geometry:l,_indirectBuffer:c}=n;for(let f=i,d=i+r;f<d;f++)zo(l,e,t,f,s,a,o)}function fw(n,e,t,i,r,s,a){const{geometry:o,_indirectBuffer:l}=n;let c=1/0,f=null;for(let d=i,u=i+r;d<u;d++){let h;h=zo(o,e,t,d,null,s,a),h&&h.distance<c&&(f=h,c=h.distance)}return f}function dw(n,e,t,i,r,s,a){const{geometry:o}=t,{index:l}=o,c=o.attributes.position;for(let f=n,d=e+n;f<d;f++){let u;if(u=f,zt(a,u*3,l,c),a.needsUpdate=!0,i(a,u,r,s))return!0}return!1}function hw(n,e=null){e&&Array.isArray(e)&&(e=new Set(e));const t=n.geometry,i=t.index?t.index.array:null,r=t.attributes.position;let s,a,o,l,c=0;const f=n._roots;for(let u=0,h=f.length;u<h;u++)s=f[u],a=new Uint32Array(s),o=new Uint16Array(s),l=new Float32Array(s),d(0,c),c+=s.byteLength;function d(u,h,_=!1){const g=u*2;if(Bt(g,o)){const p=Zt(u,a),m=un(g,o);let v=1/0,w=1/0,y=1/0,S=-1/0,M=-1/0,E=-1/0;for(let b=3*p,T=3*(p+m);b<T;b++){let C=i[b];const D=r.getX(C),R=r.getY(C),N=r.getZ(C);D<v&&(v=D),D>S&&(S=D),R<w&&(w=R),R>M&&(M=R),N<y&&(y=N),N>E&&(E=N)}return l[u+0]!==v||l[u+1]!==w||l[u+2]!==y||l[u+3]!==S||l[u+4]!==M||l[u+5]!==E?(l[u+0]=v,l[u+1]=w,l[u+2]=y,l[u+3]=S,l[u+4]=M,l[u+5]=E,!0):!1}else{const p=Ht(u),m=Gt(u,a);let v=_,w=!1,y=!1;if(e){if(!v){const C=p/Vt+h/cn,D=m/Vt+h/cn;w=e.has(C),y=e.has(D),v=!w&&!y}}else w=!0,y=!0;const S=v||w,M=v||y;let E=!1;S&&(E=d(p,h,v));let b=!1;M&&(b=d(m,h,v));const T=E||b;if(T)for(let C=0;C<3;C++){const D=p+C,R=m+C,N=l[D],I=l[D+3],z=l[R],$=l[R+3];l[u+C]=N<z?N:z,l[u+C+3]=I>$?I:$}return T}}}function Zi(n,e,t,i,r){let s,a,o,l,c,f;const d=1/t.direction.x,u=1/t.direction.y,h=1/t.direction.z,_=t.origin.x,g=t.origin.y,p=t.origin.z;let m=e[n],v=e[n+3],w=e[n+1],y=e[n+3+1],S=e[n+2],M=e[n+3+2];return d>=0?(s=(m-_)*d,a=(v-_)*d):(s=(v-_)*d,a=(m-_)*d),u>=0?(o=(w-g)*u,l=(y-g)*u):(o=(y-g)*u,l=(w-g)*u),s>l||o>a||((o>s||isNaN(s))&&(s=o),(l<a||isNaN(a))&&(a=l),h>=0?(c=(S-p)*h,f=(M-p)*h):(c=(M-p)*h,f=(S-p)*h),s>f||c>a)?!1:((c>s||s!==s)&&(s=c),(f<a||a!==a)&&(a=f),s<=r&&a>=i)}function pw(n,e,t,i,r,s,a,o){const{geometry:l,_indirectBuffer:c}=n;for(let f=i,d=i+r;f<d;f++){let u=c?c[f]:f;zo(l,e,t,u,s,a,o)}}function mw(n,e,t,i,r,s,a){const{geometry:o,_indirectBuffer:l}=n;let c=1/0,f=null;for(let d=i,u=i+r;d<u;d++){let h;h=zo(o,e,t,l?l[d]:d,null,s,a),h&&h.distance<c&&(f=h,c=h.distance)}return f}function gw(n,e,t,i,r,s,a){const{geometry:o}=t,{index:l}=o,c=o.attributes.position;for(let f=n,d=e+n;f<d;f++){let u;if(u=t.resolveTriangleIndex(f),zt(a,u*3,l,c),a.needsUpdate=!0,i(a,u,r,s))return!0}return!1}function _w(n,e,t,i,r,s,a){Ct.setBuffer(n._roots[e]),Jc(0,n,t,i,r,s,a),Ct.clearBuffer()}function Jc(n,e,t,i,r,s,a){const{float32Array:o,uint16Array:l,uint32Array:c}=Ct,f=n*2;if(Bt(f,l)){const u=Zt(n,c),h=un(f,l);uw(e,t,i,u,h,r,s,a)}else{const u=Ht(n);Zi(u,o,i,s,a)&&Jc(u,e,t,i,r,s,a);const h=Gt(n,c);Zi(h,o,i,s,a)&&Jc(h,e,t,i,r,s,a)}}const vw=["x","y","z"];function xw(n,e,t,i,r,s){Ct.setBuffer(n._roots[e]);const a=Qc(0,n,t,i,r,s);return Ct.clearBuffer(),a}function Qc(n,e,t,i,r,s){const{float32Array:a,uint16Array:o,uint32Array:l}=Ct;let c=n*2;if(Bt(c,o)){const d=Zt(n,l),u=un(c,o);return fw(e,t,i,d,u,r,s)}else{const d=Nu(n,l),u=vw[d],_=i.direction[u]>=0;let g,p;_?(g=Ht(n),p=Gt(n,l)):(g=Gt(n,l),p=Ht(n));const v=Zi(g,a,i,r,s)?Qc(g,e,t,i,r,s):null;if(v){const S=v.point[u];if(_?S<=a[p+d]:S>=a[p+d+3])return v}const y=Zi(p,a,i,r,s)?Qc(p,e,t,i,r,s):null;return v&&y?v.distance<=y.distance?v:y:v||y||null}}const Ba=new yt,Vr=new Kn,Hr=new Kn,vs=new et,Od=new yn,Oa=new yn;function yw(n,e,t,i){Ct.setBuffer(n._roots[e]);const r=jc(0,n,t,i);return Ct.clearBuffer(),r}function jc(n,e,t,i,r=null){const{float32Array:s,uint16Array:a,uint32Array:o}=Ct;let l=n*2;if(r===null&&(t.boundingBox||t.computeBoundingBox(),Od.set(t.boundingBox.min,t.boundingBox.max,i),r=Od),Bt(l,a)){const f=e.geometry,d=f.index,u=f.attributes.position,h=t.index,_=t.attributes.position,g=Zt(n,o),p=un(l,a);if(vs.copy(i).invert(),t.boundsTree)return It(n,s,Oa),Oa.matrix.copy(vs),Oa.needsUpdate=!0,t.boundsTree.shapecast({intersectsBounds:v=>Oa.intersectsBox(v),intersectsTriangle:v=>{v.a.applyMatrix4(i),v.b.applyMatrix4(i),v.c.applyMatrix4(i),v.needsUpdate=!0;for(let w=g*3,y=(p+g)*3;w<y;w+=3)if(zt(Hr,w,d,u),Hr.needsUpdate=!0,v.intersectsTriangle(Hr))return!0;return!1}});{const m=ko(t);for(let v=g*3,w=(p+g)*3;v<w;v+=3){zt(Vr,v,d,u),Vr.a.applyMatrix4(vs),Vr.b.applyMatrix4(vs),Vr.c.applyMatrix4(vs),Vr.needsUpdate=!0;for(let y=0,S=m*3;y<S;y+=3)if(zt(Hr,y,h,_),Hr.needsUpdate=!0,Vr.intersectsTriangle(Hr))return!0}}}else{const f=Ht(n),d=Gt(n,o);return It(f,s,Ba),!!(r.intersectsBox(Ba)&&jc(f,e,t,i,r)||(It(d,s,Ba),r.intersectsBox(Ba)&&jc(d,e,t,i,r)))}}const ka=new et,zl=new yn,xs=new yn,bw=new U,Sw=new U,Mw=new U,ww=new U;function Ew(n,e,t,i={},r={},s=0,a=1/0){e.boundingBox||e.computeBoundingBox(),zl.set(e.boundingBox.min,e.boundingBox.max,t),zl.needsUpdate=!0;const o=n.geometry,l=o.attributes.position,c=o.index,f=e.attributes.position,d=e.index,u=On.getPrimitive(),h=On.getPrimitive();let _=bw,g=Sw,p=null,m=null;r&&(p=Mw,m=ww);let v=1/0,w=null,y=null;return ka.copy(t).invert(),xs.matrix.copy(ka),n.shapecast({boundsTraverseOrder:S=>zl.distanceToBox(S),intersectsBounds:(S,M,E)=>E<v&&E<a?(M&&(xs.min.copy(S.min),xs.max.copy(S.max),xs.needsUpdate=!0),!0):!1,intersectsRange:(S,M)=>{if(e.boundsTree)return e.boundsTree.shapecast({boundsTraverseOrder:b=>xs.distanceToBox(b),intersectsBounds:(b,T,C)=>C<v&&C<a,intersectsRange:(b,T)=>{for(let C=b,D=b+T;C<D;C++){zt(h,3*C,d,f),h.a.applyMatrix4(t),h.b.applyMatrix4(t),h.c.applyMatrix4(t),h.needsUpdate=!0;for(let R=S,N=S+M;R<N;R++){zt(u,3*R,c,l),u.needsUpdate=!0;const I=u.distanceToTriangle(h,_,p);if(I<v&&(g.copy(_),m&&m.copy(p),v=I,w=R,y=C),I<s)return!0}}}});{const E=ko(e);for(let b=0,T=E;b<T;b++){zt(h,3*b,d,f),h.a.applyMatrix4(t),h.b.applyMatrix4(t),h.c.applyMatrix4(t),h.needsUpdate=!0;for(let C=S,D=S+M;C<D;C++){zt(u,3*C,c,l),u.needsUpdate=!0;const R=u.distanceToTriangle(h,_,p);if(R<v&&(g.copy(_),m&&m.copy(p),v=R,w=C,y=b),R<s)return!0}}}}}),On.releasePrimitive(u),On.releasePrimitive(h),v===1/0?null:(i.point?i.point.copy(g):i.point=g.clone(),i.distance=v,i.faceIndex=w,r&&(r.point?r.point.copy(m):r.point=m.clone(),r.point.applyMatrix4(ka),g.applyMatrix4(ka),r.distance=g.sub(r.point).length(),r.faceIndex=y),i)}function Tw(n,e=null){e&&Array.isArray(e)&&(e=new Set(e));const t=n.geometry,i=t.index?t.index.array:null,r=t.attributes.position;let s,a,o,l,c=0;const f=n._roots;for(let u=0,h=f.length;u<h;u++)s=f[u],a=new Uint32Array(s),o=new Uint16Array(s),l=new Float32Array(s),d(0,c),c+=s.byteLength;function d(u,h,_=!1){const g=u*2;if(Bt(g,o)){const p=Zt(u,a),m=un(g,o);let v=1/0,w=1/0,y=1/0,S=-1/0,M=-1/0,E=-1/0;for(let b=p,T=p+m;b<T;b++){const C=3*n.resolveTriangleIndex(b);for(let D=0;D<3;D++){let R=C+D;R=i?i[R]:R;const N=r.getX(R),I=r.getY(R),z=r.getZ(R);N<v&&(v=N),N>S&&(S=N),I<w&&(w=I),I>M&&(M=I),z<y&&(y=z),z>E&&(E=z)}}return l[u+0]!==v||l[u+1]!==w||l[u+2]!==y||l[u+3]!==S||l[u+4]!==M||l[u+5]!==E?(l[u+0]=v,l[u+1]=w,l[u+2]=y,l[u+3]=S,l[u+4]=M,l[u+5]=E,!0):!1}else{const p=Ht(u),m=Gt(u,a);let v=_,w=!1,y=!1;if(e){if(!v){const C=p/Vt+h/cn,D=m/Vt+h/cn;w=e.has(C),y=e.has(D),v=!w&&!y}}else w=!0,y=!0;const S=v||w,M=v||y;let E=!1;S&&(E=d(p,h,v));let b=!1;M&&(b=d(m,h,v));const T=E||b;if(T)for(let C=0;C<3;C++){const D=p+C,R=m+C,N=l[D],I=l[D+3],z=l[R],$=l[R+3];l[u+C]=N<z?N:z,l[u+C+3]=I>$?I:$}return T}}}function Aw(n,e,t,i,r,s,a){Ct.setBuffer(n._roots[e]),eu(0,n,t,i,r,s,a),Ct.clearBuffer()}function eu(n,e,t,i,r,s,a){const{float32Array:o,uint16Array:l,uint32Array:c}=Ct,f=n*2;if(Bt(f,l)){const u=Zt(n,c),h=un(f,l);pw(e,t,i,u,h,r,s,a)}else{const u=Ht(n);Zi(u,o,i,s,a)&&eu(u,e,t,i,r,s,a);const h=Gt(n,c);Zi(h,o,i,s,a)&&eu(h,e,t,i,r,s,a)}}const Rw=["x","y","z"];function Cw(n,e,t,i,r,s){Ct.setBuffer(n._roots[e]);const a=tu(0,n,t,i,r,s);return Ct.clearBuffer(),a}function tu(n,e,t,i,r,s){const{float32Array:a,uint16Array:o,uint32Array:l}=Ct;let c=n*2;if(Bt(c,o)){const d=Zt(n,l),u=un(c,o);return mw(e,t,i,d,u,r,s)}else{const d=Nu(n,l),u=Rw[d],_=i.direction[u]>=0;let g,p;_?(g=Ht(n),p=Gt(n,l)):(g=Gt(n,l),p=Ht(n));const v=Zi(g,a,i,r,s)?tu(g,e,t,i,r,s):null;if(v){const S=v.point[u];if(_?S<=a[p+d]:S>=a[p+d+3])return v}const y=Zi(p,a,i,r,s)?tu(p,e,t,i,r,s):null;return v&&y?v.distance<=y.distance?v:y:v||y||null}}const za=new yt,Gr=new Kn,Wr=new Kn,ys=new et,kd=new yn,Va=new yn;function Pw(n,e,t,i){Ct.setBuffer(n._roots[e]);const r=nu(0,n,t,i);return Ct.clearBuffer(),r}function nu(n,e,t,i,r=null){const{float32Array:s,uint16Array:a,uint32Array:o}=Ct;let l=n*2;if(r===null&&(t.boundingBox||t.computeBoundingBox(),kd.set(t.boundingBox.min,t.boundingBox.max,i),r=kd),Bt(l,a)){const f=e.geometry,d=f.index,u=f.attributes.position,h=t.index,_=t.attributes.position,g=Zt(n,o),p=un(l,a);if(ys.copy(i).invert(),t.boundsTree)return It(n,s,Va),Va.matrix.copy(ys),Va.needsUpdate=!0,t.boundsTree.shapecast({intersectsBounds:v=>Va.intersectsBox(v),intersectsTriangle:v=>{v.a.applyMatrix4(i),v.b.applyMatrix4(i),v.c.applyMatrix4(i),v.needsUpdate=!0;for(let w=g,y=p+g;w<y;w++)if(zt(Wr,3*e.resolveTriangleIndex(w),d,u),Wr.needsUpdate=!0,v.intersectsTriangle(Wr))return!0;return!1}});{const m=ko(t);for(let v=g,w=p+g;v<w;v++){const y=e.resolveTriangleIndex(v);zt(Gr,3*y,d,u),Gr.a.applyMatrix4(ys),Gr.b.applyMatrix4(ys),Gr.c.applyMatrix4(ys),Gr.needsUpdate=!0;for(let S=0,M=m*3;S<M;S+=3)if(zt(Wr,S,h,_),Wr.needsUpdate=!0,Gr.intersectsTriangle(Wr))return!0}}}else{const f=Ht(n),d=Gt(n,o);return It(f,s,za),!!(r.intersectsBox(za)&&nu(f,e,t,i,r)||(It(d,s,za),r.intersectsBox(za)&&nu(d,e,t,i,r)))}}const Ha=new et,Vl=new yn,bs=new yn,Lw=new U,Dw=new U,Nw=new U,Iw=new U;function Uw(n,e,t,i={},r={},s=0,a=1/0){e.boundingBox||e.computeBoundingBox(),Vl.set(e.boundingBox.min,e.boundingBox.max,t),Vl.needsUpdate=!0;const o=n.geometry,l=o.attributes.position,c=o.index,f=e.attributes.position,d=e.index,u=On.getPrimitive(),h=On.getPrimitive();let _=Lw,g=Dw,p=null,m=null;r&&(p=Nw,m=Iw);let v=1/0,w=null,y=null;return Ha.copy(t).invert(),bs.matrix.copy(Ha),n.shapecast({boundsTraverseOrder:S=>Vl.distanceToBox(S),intersectsBounds:(S,M,E)=>E<v&&E<a?(M&&(bs.min.copy(S.min),bs.max.copy(S.max),bs.needsUpdate=!0),!0):!1,intersectsRange:(S,M)=>{if(e.boundsTree){const E=e.boundsTree;return E.shapecast({boundsTraverseOrder:b=>bs.distanceToBox(b),intersectsBounds:(b,T,C)=>C<v&&C<a,intersectsRange:(b,T)=>{for(let C=b,D=b+T;C<D;C++){const R=E.resolveTriangleIndex(C);zt(h,3*R,d,f),h.a.applyMatrix4(t),h.b.applyMatrix4(t),h.c.applyMatrix4(t),h.needsUpdate=!0;for(let N=S,I=S+M;N<I;N++){const z=n.resolveTriangleIndex(N);zt(u,3*z,c,l),u.needsUpdate=!0;const $=u.distanceToTriangle(h,_,p);if($<v&&(g.copy(_),m&&m.copy(p),v=$,w=N,y=C),$<s)return!0}}}})}else{const E=ko(e);for(let b=0,T=E;b<T;b++){zt(h,3*b,d,f),h.a.applyMatrix4(t),h.b.applyMatrix4(t),h.c.applyMatrix4(t),h.needsUpdate=!0;for(let C=S,D=S+M;C<D;C++){const R=n.resolveTriangleIndex(C);zt(u,3*R,c,l),u.needsUpdate=!0;const N=u.distanceToTriangle(h,_,p);if(N<v&&(g.copy(_),m&&m.copy(p),v=N,w=C,y=b),N<s)return!0}}}}}),On.releasePrimitive(u),On.releasePrimitive(h),v===1/0?null:(i.point?i.point.copy(g):i.point=g.clone(),i.distance=v,i.faceIndex=w,r&&(r.point?r.point.copy(m):r.point=m.clone(),r.point.applyMatrix4(Ha),g.applyMatrix4(Ha),r.distance=g.sub(r.point).length(),r.faceIndex=y),i)}function zd(n,e,t){return n===null?null:(n.point.applyMatrix4(e.matrixWorld),n.distance=n.point.distanceTo(t.ray.origin),n.object=e,n)}const Ga=new yn,Wa=new Ji,Vd=new U,Hd=new et,Gd=new U,Hl=["getX","getY","getZ"];class Os extends nw{static serialize(e,t={}){t={cloneBuffers:!0,...t};const i=e.geometry,r=e._roots,s=e._indirectBuffer,a=i.getIndex(),o={version:1,roots:null,index:null,indirectBuffer:null};return t.cloneBuffers?(o.roots=r.map(l=>l.slice()),o.index=a?a.array.slice():null,o.indirectBuffer=s?s.slice():null):(o.roots=r,o.index=a?a.array:null,o.indirectBuffer=s),o}static deserialize(e,t,i={}){i={setIndex:!0,indirect:!!e.indirectBuffer,...i};const{index:r,roots:s,indirectBuffer:a}=e;e.version||(console.warn("MeshBVH.deserialize: Serialization format has been changed and will be fixed up. It is recommended to regenerate any stored serialized data."),l(s));const o=new Os(t,{...i,[Du]:!0});if(o._roots=s,o._indirectBuffer=a||null,i.setIndex){const c=t.getIndex();if(c===null){const f=new Kt(e.index,1,!1);t.setIndex(f)}else c.array!==r&&(c.array.set(r),c.needsUpdate=!0)}return o;function l(c){for(let f=0;f<c.length;f++){const d=c[f],u=new Uint32Array(d),h=new Uint16Array(d);for(let _=0,g=d.byteLength/cn;_<g;_++){const p=Vt*_,m=2*p;Bt(m,h)||(u[p+6]=u[p+6]/Vt-_)}}}}get primitiveStride(){return 3}get resolveTriangleIndex(){return this.resolvePrimitiveIndex}constructor(e,t={}){t.maxLeafTris&&(console.warn('MeshBVH: "maxLeafTris" option has been deprecated. Use "targetLeafSize", instead.'),t={...t,targetLeafSize:t.maxLeafTris}),super(e,t)}shiftTriangleOffsets(e){return super.shiftPrimitiveOffsets(e)}writePrimitiveBounds(e,t,i){const r=this.geometry,s=this._indirectBuffer,a=r.attributes.position,o=r.index?r.index.array:null,c=(s?s[e]:e)*3;let f=c+0,d=c+1,u=c+2;o&&(f=o[f],d=o[d],u=o[u]);for(let h=0;h<3;h++){const _=a[Hl[h]](f),g=a[Hl[h]](d),p=a[Hl[h]](u);let m=_;g<m&&(m=g),p<m&&(m=p);let v=_;g>v&&(v=g),p>v&&(v=p),t[i+h]=m,t[i+h+3]=v}return t}computePrimitiveBounds(e,t,i){const r=this.geometry,s=this._indirectBuffer,a=r.attributes.position,o=r.index?r.index.array:null,l=a.normalized;if(e<0||t+e-i.offset>i.length/6)throw new Error("MeshBVH: compute triangle bounds range is invalid.");const c=a.array,f=a.offset||0;let d=3;a.isInterleavedBufferAttribute&&(d=a.data.stride);const u=["getX","getY","getZ"],h=i.offset;for(let _=e,g=e+t;_<g;_++){const m=(s?s[_]:_)*3,v=(_-h)*6;let w=m+0,y=m+1,S=m+2;o&&(w=o[w],y=o[y],S=o[S]),l||(w=w*d+f,y=y*d+f,S=S*d+f);for(let M=0;M<3;M++){let E,b,T;l?(E=a[u[M]](w),b=a[u[M]](y),T=a[u[M]](S)):(E=c[w+M],b=c[y+M],T=c[S+M]);let C=E;b<C&&(C=b),T<C&&(C=T);let D=E;b>D&&(D=b),T>D&&(D=T);const R=(D-C)/2,N=M*2;i[v+N+0]=C+R,i[v+N+1]=R+(Math.abs(C)+R)*so}}return i}raycastObject3D(e,t,i=[]){const{material:r}=e;if(r===void 0)return;Hd.copy(e.matrixWorld).invert(),Wa.copy(t.ray).applyMatrix4(Hd),Gd.setFromMatrixScale(e.matrixWorld),Vd.copy(Wa.direction).multiply(Gd);const s=Vd.length(),a=t.near/s,o=t.far/s;if(t.firstHitOnly===!0){let l=this.raycastFirst(Wa,r,a,o);l=zd(l,e,t),l&&i.push(l)}else{const l=this.raycast(Wa,r,a,o);for(let c=0,f=l.length;c<f;c++){const d=zd(l[c],e,t);d&&i.push(d)}}return i}refit(e=null){return(this.indirect?Tw:hw)(this,e)}raycast(e,t=li,i=0,r=1/0){const s=this._roots,a=[],o=this.indirect?Aw:_w;for(let l=0,c=s.length;l<c;l++)o(this,l,t,e,a,i,r);return a}raycastFirst(e,t=li,i=0,r=1/0){const s=this._roots;let a=null;const o=this.indirect?Cw:xw;for(let l=0,c=s.length;l<c;l++){const f=o(this,l,t,e,i,r);f!=null&&(a==null||f.distance<a.distance)&&(a=f)}return a}intersectsGeometry(e,t){let i=!1;const r=this._roots,s=this.indirect?Pw:yw;for(let a=0,o=r.length;a<o&&(i=s(this,a,e,t),!i);a++);return i}shapecast(e){const t=On.getPrimitive(),i=super.shapecast({...e,intersectsPrimitive:e.intersectsTriangle,scratchPrimitive:t,iterate:this.indirect?gw:dw});return On.releasePrimitive(t),i}bvhcast(e,t,i){let{intersectsRanges:r,intersectsTriangles:s}=i;const a=On.getPrimitive(),o=this.geometry.index,l=this.geometry.attributes.position,c=this.indirect?_=>{const g=this.resolveTriangleIndex(_);zt(a,g*3,o,l)}:_=>{zt(a,_*3,o,l)},f=On.getPrimitive(),d=e.geometry.index,u=e.geometry.attributes.position,h=e.indirect?_=>{const g=e.resolveTriangleIndex(_);zt(f,g*3,d,u)}:_=>{zt(f,_*3,d,u)};if(s){if(!(e instanceof Os))throw new Error('MeshBVH: "intersectsTriangles" callback can only be used with another MeshBVH.');const _=(g,p,m,v,w,y,S,M)=>{for(let E=m,b=m+v;E<b;E++){h(E),f.a.applyMatrix4(t),f.b.applyMatrix4(t),f.c.applyMatrix4(t),f.needsUpdate=!0;for(let T=g,C=g+p;T<C;T++)if(c(T),a.needsUpdate=!0,s(a,f,T,E,w,y,S,M))return!0}return!1};if(r){const g=r;r=function(p,m,v,w,y,S,M,E){return g(p,m,v,w,y,S,M,E)?!0:_(p,m,v,w,y,S,M,E)}}else r=_}return super.bvhcast(e,t,{intersectsRanges:r})}intersectsBox(e,t){return Ga.set(e.min,e.max,t),Ga.needsUpdate=!0,this.shapecast({intersectsBounds:i=>Ga.intersectsBox(i),intersectsTriangle:i=>Ga.intersectsTriangle(i)})}intersectsSphere(e){return this.shapecast({intersectsBounds:t=>e.intersectsBox(t),intersectsTriangle:t=>t.intersectsSphere(e)})}closestPointToGeometry(e,t,i={},r={},s=0,a=1/0){return(this.indirect?Uw:Ew)(this,e,t,i,r,s,a)}closestPointToPoint(e,t={},i=0,r=1/0){return ow(this,e,t,i,r)}}const Fw={indirect:!0,targetLeafSize:10,verbose:!1};function Bw(n,e){const t={version:1,roots:e.roots,index:null,indirectBuffer:e.indirect};return Os.deserialize(t,n,{setIndex:!1})}function Ow(n){return new Os(n,Fw)}const kw="pick/pick-worker.js",zw=4e4;class Vw{constructor(e={}){this.opts=e}worker=null;workerBroken=null;seq=0;pending=new Map;disposed=!1;build(e,t,i,r=()=>{}){const s=this.opts.workerTriangles??zw;let a=!1;const o=_=>{!a&&!this.disposed&&i(_)},l=_=>{!a&&!this.disposed&&r(_)};if(t<s||!this.opts.spawnWorker||this.workerBroken){t>=s&&this.workerBroken&&console.warn(`[cad] picking worker unavailable (${this.workerBroken}); building on the main thread`);const _=performance.now();try{const g=Ow(e);o({bvh:g,ms:performance.now()-_,worker:!1})}catch(g){l(g instanceof Error?g:new Error(String(g)))}return()=>{a=!0}}const c=this.ensureWorker();if(!c)return this.build(e,t,i,r);const f=++this.seq;this.pending.set(f,{geometry:e,done:o,fail:l});const d=e.getAttribute("position").array.slice(),u=e.getIndex().array.slice(),h={id:f,positions:d,indices:u};return c.postMessage(h,[d.buffer,u.buffer]),()=>{a=!0,this.pending.delete(f)}}ensureWorker(){if(this.worker)return this.worker;try{const e=this.opts.workerUrl??new URL(kw,document.baseURI).href,t=this.opts.spawnWorker(e);return t.onmessage=i=>this.onReply(i.data),t.onerror=i=>{i.preventDefault?.(),this.breakWorker(i.message||"the picking worker failed")},this.worker=t,t}catch(e){return this.workerBroken=e instanceof Error?e.message:String(e),null}}onReply(e){const t=this.pending.get(e.id);if(!t)return;if(this.pending.delete(e.id),!e.ok){t.fail(new Error(e.error));return}const i=performance.now();try{const r=Bw(t.geometry,{roots:e.roots,indirect:e.indirect});t.done({bvh:r,ms:e.ms+(performance.now()-i),worker:!0})}catch(r){t.fail(r instanceof Error?r:new Error(String(r)))}}breakWorker(e){this.workerBroken=e;try{this.worker?.terminate()}catch{}this.worker=null;const t=[...this.pending.values()];this.pending.clear();for(const i of t){const r=(i.geometry.getIndex()?.count??0)/3;this.build(i.geometry,r,i.done,i.fail)}}dispose(){this.disposed=!0,this.pending.clear();try{this.worker?.terminate()}catch{}this.worker=null}}const Hw=15790839,Bu=12437979,Gw={ambient:.16,diffuse:.78,specular:.22,power:28},Ww=658190,$w=2.4,Ou=3064958,Xw=3064957,Wd=3.2,qw=1758837,Yw=11,Kw=4687339,Qp=4752619,Co=11717887,Gl=[14428200,2402368,2646236],$d=72,jp=[-.55,-.75,.42],Po=30,Zw=5,Jw=16,Qw=8,Xd=4,Wl={color:Qp,opacity:.07},$a={color:Qp,opacity:.55},jw={color:Co,opacity:.45},eE={color:Ou,opacity:.28};function qd(n){const e=/^#?([0-9a-f]{6})$/i.exec(String(n??"").trim());return e?parseInt(e[1],16):Bu}function ku(n){return[(n>>16&255)/255,(n>>8&255)/255,(n&255)/255]}const tE={front:{dir:[0,-1,0],up:[0,0,1]},back:{dir:[0,1,0],up:[0,0,1]},left:{dir:[-1,0,0],up:[0,0,1]},right:{dir:[1,0,0],up:[0,0,1]},top:{dir:[0,0,1],up:[0,1,0]},bottom:{dir:[0,0,-1],up:[0,-1,0]},iso:{dir:[1/Math.sqrt(3),-1/Math.sqrt(3),1/Math.sqrt(3)],up:[0,0,1]},home:{dir:jp,up:[0,0,1]}},_i=new et,$l=new et,Vi=new U,ar=new U,nE=new Xn;class Xl{constructor(e=new Rn(Po,1,.1,1e3),t=new Lu(-1,1,1,-1,.1,1e3)){this.persp=e,this.ortho=t}position=new U(0,-200,0);target=new U(0,0,0);up=new U(0,0,1);pivot=new U(0,0,0);fov=Po;projection="perspective";orthoHeight=100;scene=new Yn(new U,50);get distance(){return this.position.distanceTo(this.target)}dop(e=new U){return e.subVectors(this.target,this.position).normalize()}right(e=new U){return e.crossVectors(this.dop(ar),this.up).normalize()}pose(){return{position:this.position.clone(),target:this.target.clone(),up:this.up.clone(),orthoHeight:this.orthoHeight}}setPose(e){this.position.copy(e.position),this.target.copy(e.target),this.up.copy(e.up),this.orthoHeight=e.orthoHeight,this.orthogonalizeUp()}orthogonalizeUp(){const e=this.dop(Vi);this.up.addScaledVector(e,-this.up.dot(e)),this.up.lengthSq()<1e-12&&this.up.set(0,0,1).addScaledVector(e,-e.z),this.up.lengthSq()<1e-12&&this.up.set(0,1,0),this.up.normalize()}viewHeightAtTarget(){return this.projection==="orthographic"?this.orthoHeight:2*this.distance*Math.tan(this.fov*Math.PI/360)}worldPerPixel(e,t){return this.projection==="orthographic"?this.orthoHeight/Math.max(1,t):2*Math.max(1e-9,Vi.subVectors(e,this.position).dot(this.dop(ar)))*Math.tan(this.fov*Math.PI/360)/Math.max(1,t)}orbit(e,t,i,r){const s=360*-e/Math.max(1,i)*Math.PI/180,a=-360*t/Math.max(1,r)*Math.PI/180,o=this.up.clone(),l=Vi.crossVectors(this.dop(ar),o).normalize();_i.makeTranslation(this.pivot.x,this.pivot.y,this.pivot.z),_i.multiply($l.makeRotationAxis(o,s)),_i.multiply($l.makeRotationAxis(l,a)),_i.multiply($l.makeTranslation(-this.pivot.x,-this.pivot.y,-this.pivot.z));const c=ar.copy(this.position).add(this.up).applyMatrix4(_i);this.position.applyMatrix4(_i),this.target.applyMatrix4(_i),this.up.subVectors(c,this.position),this.orthogonalizeUp()}pan(e,t,i){const r=this.worldPerPixel(this.pivot,i),s=this.right(Vi),a=ar.copy(s).multiplyScalar(-e*r).addScaledVector(this.up,t*r);this.position.add(a),this.target.add(a)}zoomAt(e,t){if(!(e>0)||!Number.isFinite(e))return;const i=t??this.target;if(this.projection==="orthographic"){const r=this.dop(Vi),s=ar.subVectors(i,this.target);s.addScaledVector(r,-s.dot(r)),s.multiplyScalar(1-1/e),this.target.add(s),this.position.add(s),this.orthoHeight/=e;return}this.position.sub(i).multiplyScalar(1/e).add(i),this.target.sub(i).multiplyScalar(1/e).add(i)}frame(e){const t=Math.max(e.radius,1e-6),i=this.dop(Vi).negate(),r=t/Math.sin(this.fov*Math.PI/360);this.target.copy(e.center),this.position.copy(e.center).addScaledVector(i,r),this.orthoHeight=2*t}orient(e,t){const i=new U(...e).normalize(),r=this.distance||100;this.position.copy(this.target).addScaledVector(i,r),this.up.set(...t),Math.abs(this.up.clone().normalize().dot(i))>.999&&this.up.set(0,1,0),this.orthogonalizeUp()}quaternion(e=new Xn){return _i.lookAt(this.position,this.target,this.up),e.setFromRotationMatrix(_i)}static blend(e,t,i){const r=new Xn().setFromRotationMatrix(new et().lookAt(e.position,e.target,e.up)),s=new Xn().setFromRotationMatrix(new et().lookAt(t.position,t.target,t.up)),a=nE.copy(r).slerp(s,i),o=e.target.clone().lerp(t.target,i),l=e.position.distanceTo(e.target),c=t.position.distanceTo(t.target),f=Math.exp(Math.log(Math.max(l,1e-9))*(1-i)+Math.log(Math.max(c,1e-9))*i),d=new U(0,0,1).applyQuaternion(a),u=new U(0,1,0).applyQuaternion(a),h=o.clone().addScaledVector(d,f),_=Math.exp(Math.log(Math.max(e.orthoHeight,1e-9))*(1-i)+Math.log(Math.max(t.orthoHeight,1e-9))*i);return{position:h,target:o,up:u,orthoHeight:_}}setProjection(e){if(e!==this.projection){if(e==="orthographic")this.orthoHeight=2*this.distance*Math.tan(this.fov*Math.PI/360);else{const t=this.orthoHeight/(2*Math.tan(this.fov*Math.PI/360)),i=this.dop(Vi).negate();this.position.copy(this.target).addScaledVector(i,t)}this.projection=e}}apply(e){const t=this.dop(Vi),i=ar.subVectors(this.scene.center,this.position).dot(t),r=Math.max(this.scene.radius,.001)*1.05;if(this.projection==="perspective"){const o=this.persp;o.fov=this.fov,o.aspect=e;const l=Math.max(i+r,.001);return o.near=Math.max(i-r,l*1e-5,1e-4),o.far=l,o.position.copy(this.position),o.up.copy(this.up),o.lookAt(this.target),o.updateProjectionMatrix(),o.updateMatrixWorld(!0),o}const s=this.ortho,a=this.orthoHeight/2;return s.left=-a*e,s.right=a*e,s.top=a,s.bottom=-a,s.near=i-r-1,s.far=i+r+1,s.position.copy(this.position),s.up.copy(this.up),s.lookAt(this.target),s.updateProjectionMatrix(),s.updateMatrixWorld(!0),s}}const Xa=n=>new U(...ku(n)),iE=`
#include <common>
#include <clipping_planes_pars_vertex>
attribute float hl;
varying vec3 vNormalV;
varying float vHl;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vNormalV = normalize(normalMatrix * normal);
  vHl = hl;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`,rE=`
#include <common>
#include <clipping_planes_pars_fragment>
uniform vec3 uColor;
uniform vec3 uHover;
uniform vec3 uPick;
uniform vec3 uBodyPick;
uniform float uBodyState;
uniform float uAmbient;
uniform float uDiffuse;
uniform float uSpecular;
uniform float uPower;
#ifdef HATCH
uniform float uHatchGap;
uniform float uHatchWidth;
#endif
varying vec3 vNormalV;
varying float vHl;
void main() {
  #include <clipping_planes_fragment>
  vec3 n = normalize(vNormalV);
  if (!gl_FrontFacing) n = -n;
  float df = max(0.0, n.z);
  float sf = pow(df, uPower);
  vec3 c = uColor;
  if (uBodyState > 1.5) c = uBodyPick;
  else if (uBodyState > 0.5) c = uHover;
  if (vHl > 1.5) c = uPick;
  else if (vHl > 0.5) c = uHover;
  gl_FragColor = vec4(c * uAmbient + df * c * uDiffuse + sf * uColor * uSpecular, 1.0);
  #ifdef HATCH
  // Section caps: diagonal hatching, as a cut face is drawn in CAD (one line every HATCH_GAP css px).
  if (mod(gl_FragCoord.x + gl_FragCoord.y, uHatchGap) < uHatchWidth) gl_FragColor.rgb *= HATCH_SHADE;
  #endif
}
`,sE=7,aE=1.5,oE=.62,em=4,lE=1;function zu(n,e=Gw,t={}){const i=t.hatchPixelRatio;return new Pn({defines:i?{HATCH:1,HATCH_SHADE:oE.toFixed(3)}:{},vertexShader:iE,fragmentShader:rE,side:Mn,clipping:!0,polygonOffset:!0,polygonOffsetFactor:1,polygonOffsetUnits:em,uniforms:{uColor:{value:Xa(n)},uHover:{value:Xa(Co)},uPick:{value:Xa(Ou)},uBodyPick:{value:Xa(Kw)},uBodyState:{value:0},uAmbient:{value:e.ambient},uDiffuse:{value:e.diffuse},uSpecular:{value:e.specular},uPower:{value:e.power},uHatchGap:{value:sE*(i??1)},uHatchWidth:{value:aE*(i??1)}}})}function cE(n,e){n.uniforms.uColor.value.set(...ku(e))}function ql(n,e){const t=n.clippingPlanes?n.clippingPlanes.length:0,i=e?e.length:0;n.clippingPlanes=e,t!==i&&(n.needsUpdate=!0)}const uE=`
#include <common>
#include <clipping_planes_pars_vertex>
attribute vec3 color;
uniform float uSize;
uniform float uPixelRatio;
varying vec3 vColor;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // A little towards the camera so a marker on a surface is not buried in it.
  gl_Position.z -= 2e-4 * gl_Position.w;
  gl_PointSize = uSize * uPixelRatio;
  vColor = color;
  #include <clipping_planes_vertex>
}
`,fE=`
#include <common>
#include <clipping_planes_pars_fragment>
varying vec3 vColor;
void main() {
  #include <clipping_planes_fragment>
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  // A lit sphere look, like the core's vertex marker (headlight, ambient .9, diffuse .25).
  float nz = sqrt(max(0.0, 1.0 - 4.0 * r2));
  gl_FragColor = vec4(vColor * (0.9 + 0.25 * nz), 1.0);
}
`;function dE(n,e){return new Pn({vertexShader:uE,fragmentShader:fE,clipping:!0,uniforms:{uSize:{value:n},uPixelRatio:{value:e}}})}const hE=["origin:top","origin:front","origin:right"],pE={"origin:top":"Top","origin:front":"Front","origin:right":"Right"},Yd=50,Kd=[[1,1],[-1,1],[1,-1],[-1,-1]];class mE{group=new Xi;labels;planes=new Map;sized=!1;constructor(e){this.group.name="origin-planes",this.labels=document.createElement("div"),this.labels.className="cad-vp-labels",e.appendChild(this.labels);for(const t of hE){const i=Wn[t],r=new U(...i.normal).normalize(),s=new U(...i.xdir).normalize(),a=new U().crossVectors(r,s).normalize(),o=new dn(new ts(2,2),new Uo({color:Wl.color,transparent:!0,opacity:Wl.opacity,side:Mn,depthWrite:!1,polygonOffset:!0,polygonOffsetFactor:2,polygonOffsetUnits:8}));o.matrixAutoUpdate=!1,o.renderOrder=10,o.name=t;const l=new _v(new Jt().setAttribute("position",new Wt([-1,-1,0,1,-1,0,1,1,0,-1,1,0],3)),new Dp({color:$a.color,transparent:!0,opacity:$a.opacity,depthWrite:!1}));l.matrixAutoUpdate=!1,l.renderOrder=11,this.group.add(o,l);const c=document.createElement("span");c.className="cad-vp-label",c.textContent=pE[t],c.dataset.planeLabel=t,this.labels.appendChild(c),this.planes.set(t,{pick:{ref:t,origin:new U(...i.origin),normal:r,u:s,v:a,half:Yd},fill:o,border:l,label:c,state:"none"})}this.place(null)}fitTo(e){if(!e||e.isEmpty()){this.sized||this.place(null);return}this.sized=!0,this.place(e)}place(e){const t=[];if(e)for(const i of[e.min.x,e.max.x])for(const r of[e.min.y,e.max.y])for(const s of[e.min.z,e.max.z])t.push(new U(i,r,s));for(const i of this.planes.values()){const{u:r,v:s,normal:a}=i.pick,o=new U(...Wn[i.pick.ref].origin);let l=Yd;if(t.length){let f=0,d=0,u=0,h=0;for(const _ of t){const g=_.dot(r),p=_.dot(s);f=Math.min(f,g),d=Math.max(d,g),u=Math.min(u,p),h=Math.max(h,p)}l=Math.max(Math.max(d-f,h-u)/2*1.15,.001),o.addScaledVector(r,(f+d)/2).addScaledVector(s,(u+h)/2)}i.pick.half=l,i.pick.origin.copy(o);const c=i.fill.matrix;c.makeBasis(r.clone().multiplyScalar(l),s.clone().multiplyScalar(l),a.clone().multiplyScalar(l)),c.setPosition(o),i.border.matrix.copy(c),i.fill.matrixWorldNeedsUpdate=!0,i.border.matrixWorldNeedsUpdate=!0}}get halfSize(){return Math.max(...[...this.planes.values()].map(e=>e.pick.half))}box(){const e=new yt;for(const t of this.planes.values()){const{u:i,v:r,origin:s,half:a}=t.pick;for(const[o,l]of Kd)e.expandByPoint(s.clone().addScaledVector(i,o*a).addScaledVector(r,l*a))}return e}setShown(e){let t=!1;for(const i of this.planes.values()){const r=e||i.state!=="none";i.fill.visible!==r&&(i.fill.visible=r,i.border.visible=r,t=!0)}return t}picks(){return this.group.visible?[...this.planes.values()].filter(e=>e.fill.visible).map(e=>e.pick):[]}setState(e){let t=!1;for(const[i,r]of this.planes){const s=e[i]??"none";if(s===r.state)continue;t=!0,r.state=s;const a=s==="pick"?eE:s==="hover"?jw:Wl;r.fill.material.color.setHex(a.color),r.fill.material.opacity=a.opacity,r.border.material.color.setHex(s==="pick"?Ou:$a.color),r.border.material.opacity=s==="none"?$a.opacity:.9,r.label.dataset.state=s}return t}placeLabels(e,t,i={}){const r=this.group.visible,s=i.away??null,a=i.covered,o=i.size;for(const l of this.planes.values()){const{u:c,v:f,origin:d,normal:u,half:h}=l.pick,_=r&&l.fill.visible&&Math.abs(u.dot(t))>.12?e(d):null;if(!_){l.label.style.display="none";continue}l.label.style.display="",(!l.labelSize||!l.labelSize.w)&&(l.labelSize={w:l.label.offsetWidth,h:l.label.offsetHeight});const g=l.labelSize.w||32,p=l.labelSize.h||11,m=Kd.map(([w,y])=>d.clone().addScaledVector(c,w*h).addScaledVector(f,y*h));s&&m.sort((w,y)=>y.distanceToSquared(s)-w.distanceToSquared(s));let v=null;for(const w of m){const y=e(w);if(!y)continue;const S=y[0]>=_[0]?y[0]+4:y[0]-g-4,M=y[1]>=_[1]?y[1]+3:y[1]-p-3;if(!(o&&(S<0||M<0||S+g>o.w||M+p>o.h))&&!(a&&[[S,M],[S+g,M],[S,M+p],[S+g,M+p],[S+g/2,M+p/2]].some(([E,b])=>a(E,b)))){v=[S,M];break}}if(!v){l.label.style.display="none";continue}l.label.style.transform=`translate(${Math.round(v[0])}px, ${Math.round(v[1])}px)`}}dispose(){for(const e of this.planes.values())e.fill.geometry.dispose(),e.fill.material.dispose(),e.border.geometry.dispose(),e.border.material.dispose();this.labels.remove()}}const qa={seam:1,degenerated:2,internal:4,same_domain:8},gE=qa.seam|qa.degenerated|qa.internal|qa.same_domain,_E=0,vE=1,Zd=2;function xE(n){const{positions:e,normals:t,indices:i,faceRanges:r,edgePositions:s,edgeRanges:a}=n,o=e.length/3;if(e.length%3||t.length!==e.length)throw new Error("tessellation: positions and normals differ in length");if(i.length%3)throw new Error("tessellation: indices are not triangles");if(r.length%2)throw new Error("tessellation: face ranges are not pairs");const l=r.length/2,c=i.length/3,f=new Jt;f.setAttribute("position",new Kt(e,3)),f.setAttribute("normal",new Kt(t,3));const d=new Kt(new Uint8Array(o),1);f.setAttribute("hl",d),f.setIndex(new Kt(i,1));let u=!0,h=0;for(let b=0;b<l;b++){const T=r[2*b],C=r[2*b+1];if(T%3||C%3||T+C>i.length)throw new Error(`tessellation: face ${b} range is not whole triangles`);T<h&&C>0&&(u=!1),C>0&&(h=T+C)}let _=null;if(!u){_=new Uint32Array(c);for(let b=0;b<l;b++)_.fill(b,r[2*b]/3,(r[2*b]+r[2*b+1])/3)}const g=new Uint32Array(2*l);for(let b=0;b<l;b++){const T=r[2*b],C=r[2*b+1];if(!C)continue;let D=4294967295,R=0;for(let N=T;N<T+C;N++){const I=i[N];I<D&&(D=I),I>R&&(R=I)}if(R>=o)throw new Error(`tessellation: face ${b} uses vertex ${R} of ${o}`);g[2*b]=D,g[2*b+1]=R-D+1}const p=a.length/2,m=n.edgeFlags&&n.edgeFlags.length===p?n.edgeFlags:null,v=b=>!!m&&(m[b]&gE)!==0,w=new Float32Array(4*p);let y=0;for(let b=0;b<p;b++){const T=a[2*b],C=a[2*b+1];if(v(b)&&y++,!C||v(b)){w[4*b+3]=-1;continue}let D=1/0,R=1/0,N=1/0,I=-1/0,z=-1/0,$=-1/0;for(let te=T;te<T+C;te++){const ue=s[3*te],be=s[3*te+1],Fe=s[3*te+2];ue<D&&(D=ue),ue>I&&(I=ue),be<R&&(R=be),be>z&&(z=be),Fe<N&&(N=Fe),Fe>$&&($=Fe)}const X=(D+I)/2,re=(R+z)/2,J=(N+$)/2;let Q=0;for(let te=T;te<T+C;te++){const ue=s[3*te]-X,be=s[3*te+1]-re,Fe=s[3*te+2]-J,Re=ue*ue+be*be+Fe*Fe;Re>Q&&(Q=Re)}w.set([X,re,J,Math.sqrt(Q)],4*b)}let S=s;if(y){let b=0;for(let C=0;C<p;C++)v(C)||(b+=a[2*C+1]);S=new Float32Array(3*b);let T=0;for(let C=0;C<p;C++){if(v(C))continue;const D=a[2*C],R=a[2*C+1];S.set(s.subarray(3*D,3*(D+R)),T),T+=3*R}}const M=new yt;o&&M.setFromArray(e),s.length&&M.union(new yt().setFromArray(s));const E=new Yn;return M.isEmpty()||M.getBoundingSphere(E),f.boundingBox=M.clone(),f.boundingSphere=E.clone(),{geometry:f,hl:d,faces:l,triangles:c,tess:n,sortedFaces:u,triFace:_,faceVerts:g,edges:p,edgeSpheres:w,drawEdges:S,hiddenEdges:y,bounds:M,sphere:E}}function yE(n,e){if(n.triFace)return e>=0&&e<n.triFace.length?n.triFace[e]:-1;const t=n.tess.faceRanges,i=3*e;let r=0,s=n.faces-1,a=-1;for(;r<=s;){const o=r+s>>1;t[2*o]<=i?(a=o,r=o+1):s=o-1}return a<0?-1:i<t[2*a]+t[2*a+1]?a:-1}function bE(n,e){const{edgePositions:t,edgeRanges:i}=n.tess,r=i[2*e],s=i[2*e+1];return t.subarray(3*r,3*(r+s))}function SE(n,e,t=.5){if(e<0||e>=n.faces)return null;const i=n.faceVerts[2*e],r=n.faceVerts[2*e+1];if(!r)return null;const s=n.tess.normals;let a=0,o=0,l=0;for(let d=i;d<i+r;d++)a+=s[3*d],o+=s[3*d+1],l+=s[3*d+2];const c=Math.hypot(a,o,l);if(c<1e-9)return null;a/=c,o/=c,l/=c;const f=Math.cos(t*Math.PI/180);for(let d=i;d<i+r;d++){const u=s[3*d]*a+s[3*d+1]*o+s[3*d+2]*l,h=Math.hypot(s[3*d],s[3*d+1],s[3*d+2])||1;if(u/h<f)return null}return[a,o,l]}function ME(n){let e=0,t=0,i=0,r=0,s=0,a=0,o=0,l=0,c=0;for(const{positions:f,indices:d}of n)for(let u=0;u<d.length;u+=3){const h=3*d[u],_=3*d[u+1],g=3*d[u+2],p=f[h],m=f[h+1],v=f[h+2],w=f[_],y=f[_+1],S=f[_+2],M=f[g],E=f[g+1],b=f[g+2],T=(p*(y*b-S*E)-m*(w*b-S*M)+v*(w*E-y*M))/6;e+=T,t+=T*(p+w+M)/4,i+=T*(m+y+E)/4,r+=T*(v+S+b)/4;const C=w-p,D=y-m,R=S-v,N=M-p,I=E-m,z=b-v,$=D*z-R*I,X=R*N-C*z,re=C*I-D*N,J=.5*Math.sqrt($*$+X*X+re*re);s+=J,a+=J*(p+w+M)/3,o+=J*(m+y+E)/3,l+=J*(v+S+b)/3,c++}return c?s>0&&Math.abs(e)>1e-6*Math.pow(s,1.5)?[t/e,i/e,r/e]:s>0?[a/s,o/s,l/s]:null:null}function Jd(n,e,t){if(e<0||e>=n.faces)return!1;const i=n.faceVerts[2*e],r=n.faceVerts[2*e+1];if(!r)return!1;const s=n.hl.array;return s[i]===t&&s[i+r-1]===t?!1:(s.fill(t,i,i+r),n.hl.addUpdateRange(i,r),n.hl.needsUpdate=!0,!0)}function wE(n){return new Set(n.length?n:["face","edge","vertex","origin"])}const vi=new Ji,Wi=new U,Vu=new U,or=new bt,Qd=new et;function iu(n,e,t,i=new Ji){const r=n.camera,s=e/n.width*2-1,a=1-t/n.height*2;return r.isOrthographicCamera?(i.origin.set(s,a,-1).unproject(r),i.direction.set(0,0,-1).transformDirection(r.matrixWorld)):(i.origin.setFromMatrixPosition(r.matrixWorld),i.direction.set(s,a,.5).unproject(r).sub(i.origin).normalize()),i}function Hu(n){Qd.multiplyMatrices(n.camera.projectionMatrix,n.camera.matrixWorldInverse);const e=Qd.elements.slice(),t=n.width,i=n.height;return(r,s,a,o)=>{const l=e[3]*r+e[7]*s+e[11]*a+e[15];if(l<=1e-9)return!1;const c=(e[0]*r+e[4]*s+e[8]*a+e[12])/l,f=(e[1]*r+e[5]*s+e[9]*a+e[13])/l;return o[0]=(c+1)/2*t,o[1]=(1-f)/2*i,!0}}function tm(n,e,t=0){return!n.clip||n.clip.distanceToPoint(e)>=-t}function Lo(n,e,t){let i=null;for(const r of n){if(!r.bvh)continue;let s=null;if(t.clip){const f=r.bvh.raycast(e,Mn);f.sort((d,u)=>d.distance-u.distance),s=f.find(d=>tm(t,d.point))??null}else s=r.bvh.raycastFirst(e,Mn);if(!s||s.faceIndex==null)continue;const a=yE(r.data,s.faceIndex);if(a<0)continue;let o=!1,l=s.point.clone(),c=s.distance;if(t.clip){const f=nm(r.data,s.faceIndex,l);if(f[0]*e.direction.x+f[1]*e.direction.y+f[2]*e.direction.z>0){const d=e.distanceToPlane(t.clip);d!==null&&d<=c&&(o=!0,c=d,l=e.at(d,new U))}}i&&c>=i.distance||(i={body:r,tri:s.faceIndex,face:a,point:l,distance:c,cap:o})}return i}function jd(n,e,t,i){if(!tm(e,t,i))return!1;if(!e.occlude)return!0;const r=e.camera;r.isOrthographicCamera?(vi.direction.set(0,0,-1).transformDirection(r.matrixWorld),vi.origin.copy(t).addScaledVector(vi.direction,-1e6)):(vi.origin.setFromMatrixPosition(r.matrixWorld),vi.direction.subVectors(t,vi.origin).normalize());const a=Vu.subVectors(t,vi.origin).dot(vi.direction),o=Lo(n,vi,e);return!o||a<=o.distance+i}function EE(n,e,t,i=new U){const r=Wi.subVectors(t,e),s=n.direction,a=Vu.subVectors(e,n.origin),o=r.dot(r),l=r.dot(s),c=s.dot(s),f=r.dot(a),d=s.dot(a),u=o*c-l*l;let h=u>1e-12?(l*d-c*f)/u:0;return h=Math.max(0,Math.min(1,h)),i.copy(e).addScaledVector(r,h)}function TE(n,e,t,i,r,s){const a=r-t,o=s-i,l=a*a+o*o;let c=l>1e-12?((n-t)*a+(e-i)*o)/l:0;c=Math.max(0,Math.min(1,c));const f=t+c*a-n,d=i+c*o-e;return{d2:f*f+d*d,u:c}}function AE(n,e,t,i,r){const s=Hu(e),a=[0,0],o=[],l=r*r;for(const c of n){const f=c.vertices;if(f)for(let d=0;d<f.length/3;d++){if(!s(f[3*d],f[3*d+1],f[3*d+2],a))continue;const u=a[0]-t,h=a[1]-i,_=u*u+h*h;_<=l&&o.push({body:c,index:d,d:Math.sqrt(_),point:new U(f[3*d],f[3*d+1],f[3*d+2])})}}return o.sort((c,f)=>c.d-f.d)}function RE(n,e,t,i,r,s){const a=Hu(e),o=[0,0],l=[0,0],c=r*r,f=[],d=new U,u=new U;for(const h of n){const{edgeSpheres:_,edges:g,tess:p}=h.data,m=p.edgePositions,v=p.edgeRanges;for(let w=0;w<g;w++){const y=_[4*w+3];if(y<0)continue;if(Wi.set(_[4*w],_[4*w+1],_[4*w+2]),a(Wi.x,Wi.y,Wi.z,l)){const T=y/Math.max(e.worldPerPixel(Wi),1e-12),C=l[0]-t,D=l[1]-i;if(C*C+D*D>(T+r)*(T+r))continue}const S=v[2*w],M=v[2*w+1];let E=1/0,b=-1;for(let T=S;T+1<S+M;T+=2){const C=a(m[3*T],m[3*T+1],m[3*T+2],o),D=a(m[3*T+3],m[3*T+4],m[3*T+5],l);if(!C||!D)continue;const{d2:R}=TE(t,i,o[0],o[1],l[0],l[1]);R<E&&(E=R,b=T)}b<0||E>c||(d.set(m[3*b],m[3*b+1],m[3*b+2]),u.set(m[3*b+3],m[3*b+4],m[3*b+5]),f.push({body:h,index:w,d:Math.sqrt(E),point:EE(s,d,u)}))}}return f.sort((h,_)=>h.d-_.d)}function CE(n,e){let t=null;for(const i of n){const r=i.normal.dot(e.direction);if(Math.abs(r)<1e-9)continue;const s=Wi.subVectors(i.origin,e.origin).dot(i.normal)/r;if(s<0)continue;const a=e.at(s,new U),o=Vu.subVectors(a,i.origin);Math.abs(o.dot(i.u))>i.half||Math.abs(o.dot(i.v))>i.half||(!t||s<t.distance)&&(t={plane:i,point:a,distance:s})}return t}function eh(n,e,t){return 4*n.worldPerPixel(t)+.0025*e.data.sphere.radius}function Ss(n){return[n.x,n.y,n.z]}function PE(n,e,t,i,r,s,a=Qw){const o=iu(t,i,r,new Ji),l=Hu(t),c=g=>{const p=[i,r];return l(g.x,g.y,g.z,p),p},f=g=>Wi.subVectors(g,o.origin).dot(o.direction);let d=null;if(s.has("vertex")){for(const g of AE(n,t,i,r,a))if(jd(n,t,g.point,eh(t,g.body,g.point))){d=g;break}}let u=null;if(s.has("edge"))for(const g of RE(n,t,i,r,a,o)){if(d&&g.d>d.d+Xd)break;if(jd(n,t,g.point,eh(t,g.body,g.point))){u=g;break}}if(d&&(!u||d.d-Xd<=u.d))return{item:{kind:"vertex",body:d.body.id,index:d.index},point:Ss(d.point),normal:null,depth:f(d.point),screen:c(d.point)};if(u)return{item:{kind:"edge",body:u.body.id,index:u.index},point:Ss(u.point),normal:null,depth:f(u.point),screen:c(u.point)};const _=t.faces&&(s.has("face")||s.has("body"))?Lo(n,o,t):null;if(_&&_.cap)return null;if(_){const g=nm(_.body.data,_.tri,_.point);return{item:s.has("face")?{kind:"face",body:_.body.id,index:_.face}:{kind:"body",body:_.body.id},point:Ss(_.point),normal:g,depth:_.distance,screen:c(_.point)}}if(s.has("origin")){const g=CE(e,o);if(g)return{item:{kind:"origin",ref:g.plane.ref},point:Ss(g.point),normal:Ss(g.plane.normal),depth:g.distance,screen:c(g.point)}}return null}function nm(n,e,t){const i=n.tess.indices,r=n.tess.positions,s=n.tess.normals,a=i[3*e],o=i[3*e+1],l=i[3*e+2],c=new U(r[3*a],r[3*a+1],r[3*a+2]),f=new U(r[3*o],r[3*o+1],r[3*o+2]),d=new U(r[3*l],r[3*l+1],r[3*l+2]),u=f.clone().sub(c),h=d.clone().sub(c),_=t.clone().sub(c),g=u.dot(u),p=u.dot(h),m=h.dot(h),v=_.dot(u),w=_.dot(h),y=g*m-p*p;let S=1/3,M=1/3;Math.abs(y)>1e-20&&(S=(m*v-p*w)/y,M=(g*w-p*v)/y);const E=1-S-M;or.set(E*s[3*a]+S*s[3*o]+M*s[3*l],E*s[3*a+1]+S*s[3*o+1]+M*s[3*l+1],E*s[3*a+2]+S*s[3*o+2]+M*s[3*l+2],0);const b=Math.hypot(or.x,or.y,or.z)||1;return[or.x/b,or.y/b,or.z/b]}const LE={on:!1,plane:"origin:front",offset:0,flip:!1};function DE(n,e=new Fn){const t=new U(...Wn[n.plane].normal).normalize(),i=n.flip?t:t.clone().negate();return e.set(i,-i.dot(t.clone().multiplyScalar(n.offset)))}class NE{group=new Xi;capMat;cap;stencils=new Map;constructor(e=1){this.group.name="section-caps",this.group.visible=!1,this.capMat=zu(Bu,void 0,{hatchPixelRatio:e}),this.capMat.polygonOffset=!1,this.capMat.stencilWrite=!0,this.capMat.stencilRef=0,this.capMat.stencilFunc=x_,this.capMat.stencilFail=jo,this.capMat.stencilZFail=jo,this.capMat.stencilZPass=jo;const t=new ts(2,2);t.setAttribute("hl",new Kt(new Uint8Array(t.getAttribute("position").count),1)),this.cap=new dn(t,this.capMat),this.cap.matrixAutoUpdate=!1,this.cap.renderOrder=-1,this.cap.name="section-cap",this.group.add(this.cap)}setBodies(e,t){const i=new Set(e.map(r=>r.key));for(const[r,s]of this.stencils)if(!i.has(r)){for(const a of s)this.group.remove(a),a.material.dispose();this.stencils.delete(r)}for(const r of e){let s=this.stencils.get(r.key);s||(s=[this.stencilMesh(r.geometry,fn,__),this.stencilMesh(r.geometry,li,v_)],this.stencils.set(r.key,s),this.group.add(...s));for(const a of s)a.visible=r.visible,a.material.clippingPlanes=[t]}}stencilMesh(e,t,i){const r=new Uo({side:t,colorWrite:!1,depthWrite:!1,depthTest:!1,stencilWrite:!0,stencilFunc:Sp,stencilFail:i,stencilZFail:i,stencilZPass:i}),s=new dn(e,r);return s.renderOrder=-2,s.name="section-stencil",s}place(e,t,i){const r=e.normal.clone(),s=e.coplanarPoint(new U),a=t.center.clone().sub(r.clone().multiplyScalar(e.distanceToPoint(t.center))),o=Math.abs(r.z)<.9?new U(0,0,1).cross(r).normalize():new U(1,0,0).cross(r).normalize(),l=new U().crossVectors(r,o).normalize(),c=Math.max(t.radius*1.5,.001),f=new et().makeBasis(o.multiplyScalar(c),l.multiplyScalar(c),r.clone().multiplyScalar(c));f.setPosition(a.lengthSq()>0?a:s),this.cap.matrix.copy(f),this.cap.matrixWorldNeedsUpdate=!0,this.capMat.uniforms.uColor.value.set((i>>16&255)/255,(i>>8&255)/255,(i&255)/255)}dispose(){for(const e of this.stencils.values())for(const t of e)t.material.dispose();this.stencils.clear(),this.cap.geometry.dispose(),this.capMat.dispose()}}const th=.03,nh=.1,Ya=.2;class IE{scene=new Rp;camera=new Rn(Po,1,.01,100);center=new U(.45,.45,.45);distance;constructor(){const e=new Xi,t=[[new U(1,0,0),Gl[0]],[new U(0,1,0),Gl[1]],[new U(0,0,1),Gl[2]]];for(const[s,a]of t){const o=zu(a,{ambient:0,diffuse:1,specular:0,power:1});o.polygonOffset=!1;const l=new dn(new Fo(th,th,1-Ya,24),o);l.position.set(0,(1-Ya)/2,0);const c=new dn(new Cu(nh,Ya,32),o);c.position.set(0,1-Ya/2,0);const f=new Xi;f.add(l,c),f.quaternion.copy(new Xn().setFromUnitVectors(new U(0,1,0),s));for(const d of[l,c])d.geometry.setAttribute("hl",new Kt(new Uint8Array(d.geometry.getAttribute("position").count),1));e.add(f)}this.scene.add(e);const i=(1+nh)/2;this.center.setScalar(1-i);const r=Math.sqrt(3)*i;this.distance=r/Math.sin(Po*Math.PI/360)}sync(e){const t=new U(0,0,1).applyQuaternion(e);this.camera.position.copy(this.center).addScaledVector(t,this.distance),this.camera.quaternion.copy(e),this.camera.near=this.distance*.2,this.camera.far=this.distance*3,this.camera.aspect=1,this.camera.updateProjectionMatrix(),this.camera.updateMatrixWorld(!0)}dispose(){this.scene.traverse(e=>{const t=e;t.isMesh&&(t.geometry.dispose(),t.material.dispose())})}}const UE=400,FE=320,BE=1.2,ih=10,OE=16;function Yl(n,e,t=!1){const i=new Xp({color:n,linewidth:e,worldUnits:!1,depthFunc:Jr});return t&&(i.polygonOffset=!0,i.polygonOffsetFactor=-2,i.polygonOffsetUnits=-8),i}function kE(n,e={}){const t=e.services,i=Ki({ready:!1,display:"shaded-edges",projection:"perspective",hover:null,triangles:0,bodies:0,section:{...LE},planes:"auto",bvhPending:0,animating:!1}),r={frames:0,lastFrameMs:0,lastSetBodiesMs:0,lastUploadFrameMs:0,lastPickMs:0,bvh:{},triangles:0,drawCalls:0},s=new PM({antialias:!0,alpha:!1,stencil:!0,preserveDrawingBuffer:!1,powerPreference:"high-performance"}),a=Math.min(window.devicePixelRatio||1,2);s.setPixelRatio(a),s.setClearColor(Hw,1),s.autoClear=!1,s.localClippingEnabled=!0;const o=s.domElement;o.className="cad-viewport-canvas",o.setAttribute("data-cad-canvas","1"),n.appendChild(o);const l=new Rp,c=new Xl;c.orient(jp,[0,0,1]);const f=new mE(n);l.add(f.group);const d=new IE,u=new NE(a);l.add(u.group);const h=new Fn,_=new Vw({spawnWorker:e.spawnWorker!==void 0?e.spawnWorker:t?O=>t.bridge.spawnWorker(O):null,workerUrl:e.pickWorkerUrl}),g=new Map;let p=[];const m=new Set;let v=[],w=[],y=[],S="",M=!1,E=!1;const b=Yl(Xw,Wd,!0),T=Yl(Co,Wd,!0),C=new Ll(new Ts,b),D=new Ll(new Ts,T);C.renderOrder=5,D.renderOrder=6,C.visible=!1,D.visible=!1,C.frustumCulled=!1,D.frustumCulled=!1;const R=dE(Yw,a),N=new xv(new Jt,R);N.renderOrder=7,N.visible=!1,N.frustumCulled=!1,l.add(C,D,N);let I="";const z=()=>[b,T,...[...g.values()].map(O=>O.edgeMat)];let $=1,X=1;function re(){$=Math.max(1,n.clientWidth),X=Math.max(1,n.clientHeight),s.setSize($,X,!1),o.style.width="100%",o.style.height="100%",te()}let J=0,Q=null;function te(){!J&&!E&&(J=requestAnimationFrame(Re))}function ue(O){return O.override??O.docVisible}function be(){const O=new yt;for(const Y of g.values())ue(Y)&&O.union(Y.data.bounds);return O.union(f.box()),O.getBoundingSphere(new Yn)}function Fe(){const O=n.querySelector("[data-triad-slot]"),Y=o.getBoundingClientRect();if(O&&Y.width>0){const ie=O.getBoundingClientRect();if(ie.width>0)return{x:ie.left-Y.left,y:Y.bottom-ie.bottom,s:Math.min(ie.width,ie.height)}}return{x:$-10-$d,y:10,s:$d}}function Re(){if(J=0,E)return;if(Q){const ie=Math.min(1,(performance.now()-Q.t0)/Q.ms),he=ie<.5?4*ie*ie*ie:1-Math.pow(-2*ie+2,3)/2;c.setPose(Xl.blend(Q.from,Q.to,he)),ie>=1?(c.setPose(Q.to),Q=null,i.set({animating:!1})):te()}const O=performance.now();je();const Y=performance.now()-O;r.lastFrameMs=Y,M&&(r.lastUploadFrameMs=Y,M=!1),r.frames++,r.drawCalls=s.info.render.calls,i.get().ready||i.set({ready:!0})}function je(){c.scene.copy(be());const O=c.apply($/X);for(const he of z())he.resolution.set($,X);s.setScissorTest(!1),s.setViewport(0,0,$,X),s.clear(!0,!0,!0),s.render(l,O);const Y=s.info.render.calls,ie=Fe();s.clearDepth(),s.setScissorTest(!0),s.setScissor(ie.x,ie.y,ie.s,ie.s),s.setViewport(ie.x,ie.y,ie.s,ie.s),d.sync(c.quaternion()),s.render(d.scene,d.camera),s.setScissorTest(!1),s.setViewport(0,0,$,X),s.info.render.calls+=Y,ne()}function ne(){const O=[...g.values()].filter(ue);if(!O.length){f.placeLabels(Oe=>ae(Oe),c.dop(),{size:{w:$,h:X}});return}const Y=new yt;for(const Oe of O)Y.union(Oe.data.bounds);const ie=Me(),he=Be(),Xe=new Ji;f.placeLabels(Oe=>ae(Oe),c.dop(),{size:{w:$,h:X},away:Y.getCenter(new U),covered:(Oe,Ge)=>Oe>=0&&Ge>=0&&Oe<=$&&Ge<=X&&!!Lo(he,iu(ie,Oe,Ge,Xe),ie)})}function ae(O){const Y=c.apply($/X),ie=O.clone().project(Y);return ie.z>1||ie.z<-1?null:[(ie.x+1)/2*$,(1-ie.y)/2*X]}function Me(){const O=c.apply($/X),Y=i.get();return{camera:O,width:$,height:X,worldPerPixel:ie=>c.worldPerPixel(ie,X),clip:Y.section.on?h:null,occlude:Y.display!=="wireframe",faces:Y.display!=="wireframe"}}function Be(){const O=[];for(const Y of p){const ie=g.get(Y);ie&&ue(ie)&&O.push({id:ie.id,data:ie.data,bvh:ie.bvh,vertices:ie.vertices})}return O}function ve(O,Y){const ie=performance.now(),he=PE(Be(),f.picks(),Me(),O,Y,wE(y));if(he){const Xe=o.getBoundingClientRect();he.screen=[he.screen[0]+Xe.left,he.screen[1]+Xe.top]}return r.lastPickMs=performance.now()-ie,he}function ke(O){O.cancelBvh(),l.remove(O.mesh,O.edges),O.mesh.geometry.dispose(),O.mesh.material.dispose(),O.edges.geometry.dispose(),O.edgeMat.dispose(),delete r.bvh[O.id]}function Pt(O){const Y=xE(O.tess),ie=qd(O.color),he=zu(ie),Xe=new dn(Y.geometry,he);Xe.name=`body:${O.id}`,Xe.frustumCulled=!1;const Oe=new Ts;Y.drawEdges.length>=6&&Oe.setPositions(Y.drawEdges);const Ge=Yl(Ww,$w),Mt=new Ll(Oe,Ge);Mt.name=`edges:${O.id}`,Mt.frustumCulled=!1,Mt.renderOrder=1,l.add(Xe,Mt);const He={id:O.id,tessKey:O.tessKey,data:Y,mesh:Xe,edges:Mt,edgeMat:Ge,color:ie,docVisible:O.visible,override:null,feature:O.feature,vertices:O.vertices??null,kbox:O.bbox??null,bvh:null,cancelBvh:()=>{},faceHl:new Map};return He.cancelBvh=_.build(Y.geometry,Y.triangles,dt=>{He.bvh=dt.bvh,r.bvh[He.id]={ms:dt.ms,worker:dt.worker},$e()},dt=>console.warn(`[cad] picking structure for ${He.id} failed: ${dt.message}`)),He}function $e(){let O=0,Y=0,ie=0;for(const he of g.values())he.bvh||ie++,ue(he)&&(Y++,O+=he.data.triangles);r.triangles=O,i.set({triangles:O,bodies:Y,bvhPending:ie})}function Ke(){const O=i.get();for(const Y of g.values()){const ie=ue(Y);Y.mesh.visible=ie&&O.display!=="wireframe",Y.edges.visible=ie&&O.display!=="shaded"&&Y.data.drawEdges.length>=6}rt()}function rt(){const O=i.get().section,Y=O.on?[DE(O,h)]:null;for(const he of g.values())ql(he.mesh.material,Y),ql(he.edgeMat,Y);for(const he of[b,T,R])ql(he,Y);const ie=i.get().display!=="wireframe";u.group.visible=O.on&&ie,O.on?(u.setBodies([...g.values()].map(he=>({key:`${he.id}|${he.tessKey}`,geometry:he.data.geometry,visible:ue(he)})),h),u.place(h,be(),Bu)):u.setBodies([],h)}function qe(){const O=new yt,Y=[...g.values()].filter(ue);for(const he of Y)O.union(he.data.bounds);f.fitTo(Y.length?O:null);const ie=ME(Y.map(he=>({positions:he.data.tess.positions,indices:he.data.tess.indices})));c.pivot.set(...ie??[0,0,0]),O.isEmpty()||O.clone().expandByScalar(.1*Math.max(...O.getSize(new U).toArray())).containsPoint(c.pivot)||O.getCenter(c.pivot)}function ot(O){const Y=performance.now(),ie=[...g.values()].some(ue),he=ie?Nt().radius:0,Xe=new Set;let Oe=!1;for(const He of O){Xe.add(He.id);const dt=g.get(He.id);if(dt&&dt.tessKey===He.tessKey){const qt=qd(He.color);qt!==dt.color&&(dt.color=qt,cE(dt.mesh.material,qt)),ue(dt)!==He.visible&&(Oe=!0),dt.docVisible=He.visible,dt.override=null,dt.feature=He.feature,dt.kbox=He.bbox??dt.kbox,He.vertices&&(dt.vertices=He.vertices);continue}dt&&ke(dt);try{g.set(He.id,Pt(He))}catch(qt){g.delete(He.id),console.warn(`[cad] body ${He.id} cannot be drawn: ${qt instanceof Error?qt.message:String(qt)}`);continue}Oe=!0,M=!0}for(const[He,dt]of g)Xe.has(He)||(ke(dt),g.delete(He),Oe=!0);p=O.map(He=>He.id).filter(He=>g.has(He));const Ge=p.map(He=>`${He}|${g.get(He).tessKey}|${ue(g.get(He))}`).join(",");(Oe||Ge!==S)&&(S=Ge,qe()),Ke(),$e(),Tt(),r.lastSetBodiesMs=performance.now()-Y;const Mt=[...g.values()].some(ue);if(!ie&&Mt)q({animate:!1});else if(ie&&Mt){const He=Nt().radius;he>0&&(He>he*ih||He*ih<he)&&q()}Oe&&i.get().hover&&V(null),Oe&&ce&&Ve(ce),te()}function Dt(){const O=i.get().hover;return[...O?[O.item]:[],...w]}function Tt(){const O=new Map,Y=new Map,ie={},he=[],Xe=[],Oe=[],Ge=new Set,Mt=Le=>{let st=O.get(Le);return st||O.set(Le,st=new Map),st},He=(Le,st)=>{const En=g.get(Le)?.vertices;return En&&3*st+2<En.length?[En[3*st],En[3*st+1],En[3*st+2]]:null},dt=Le=>Le in Wn;for(const Le of v)switch(Le.kind){case"face":Mt(Le.body).set(Le.index,Zd);break;case"edge":he.push([Le.body,Le.index]),Ge.add(`e:${Le.body}:${Le.index}`);break;case"vertex":{const st=He(Le.body,Le.index);st&&Oe.push({p:st,c:qw}),Ge.add(`v:${Le.body}:${Le.index}`);break}case"body":Y.set(Le.body,2);break;case"feature":for(const st of g.values())st.feature===Le.feature&&Y.set(st.id,2);break;case"origin":dt(Le.ref)&&(ie[Le.ref]="pick");break}for(const Le of Dt())switch(Le.kind){case"face":{const st=Mt(Le.body);st.get(Le.index)!==Zd&&st.set(Le.index,vE);break}case"edge":Ge.has(`e:${Le.body}:${Le.index}`)||Xe.push([Le.body,Le.index]);break;case"vertex":{const st=He(Le.body,Le.index);st&&!Ge.has(`v:${Le.body}:${Le.index}`)&&Oe.push({p:st,c:Co});break}case"body":Y.get(Le.body)!==2&&Y.set(Le.body,1);break;case"feature":for(const st of g.values())st.feature===Le.feature&&Y.get(st.id)!==2&&Y.set(st.id,1);break;case"origin":dt(Le.ref)&&ie[Le.ref]!=="pick"&&(ie[Le.ref]="hover");break}let qt=f.setState(ie);const xr=[...g.values()].some(ue);f.setShown(i.get().planes==="always"||!xr)&&(qt=!0);for(const Le of g.values()){const st=O.get(Le.id)??new Map;for(const Zn of[...Le.faceHl.keys()])st.has(Zn)||(Jd(Le.data,Zn,_E),Le.faceHl.delete(Zn),qt=!0);for(const[Zn,P]of st)Le.faceHl.get(Zn)!==P&&(Jd(Le.data,Zn,P),Le.faceHl.set(Zn,P),qt=!0);const En=Y.get(Le.id)??0;Le.mesh.material.uniforms.uBodyState.value!==En&&(Le.mesh.material.uniforms.uBodyState.value=En,qt=!0);const $s=En>0||st.size>0?lE:em;Le.mesh.material.polygonOffsetUnits!==$s&&(Le.mesh.material.polygonOffsetUnits=$s,qt=!0)}const is=Le=>Le.map(([st,En])=>`${st}:${En}:${g.get(st)?.tessKey??""}:${g.get(st)&&ue(g.get(st))}`).join(","),rs=`${is(he)}|${is(Xe)}|${Oe.map(Le=>Le.p.join(":")+"/"+Le.c).join(",")}`;rs!==I&&(I=rs,vt(C,he),vt(D,Xe),At(Oe),qt=!0),qt&&te()}function vt(O,Y){const ie=[];for(const[Oe,Ge]of Y){const Mt=g.get(Oe);if(!Mt||!ue(Mt)||Ge<0||Ge>=Mt.data.edges)continue;const He=bE(Mt.data,Ge);He.length>=6&&ie.push(He)}const he=ie.reduce((Oe,Ge)=>Oe+Ge.length,0);O.geometry.dispose();const Xe=new Ts;if(he>=6){const Oe=new Float32Array(he);let Ge=0;for(const Mt of ie)Oe.set(Mt,Ge),Ge+=Mt.length;Xe.setPositions(Oe)}O.geometry=Xe,O.visible=he>=6}function At(O){const Y=new Jt;Y.setAttribute("position",new Wt(O.flatMap(ie=>ie.p),3)),Y.setAttribute("color",new Wt(O.flatMap(ie=>ku(ie.c)),3)),N.geometry.dispose(),N.geometry=Y,N.visible=O.length>0}function V(O){const Y=i.get().hover,ie=Y&&O?JSON.stringify(Y.item)===JSON.stringify(O.item):Y===O;i.set({hover:O}),ie||Tt()}function Nt(){const O=new yt;for(const Y of g.values())ue(Y)&&O.union(Y.data.bounds);return O.isEmpty()&&O.copy(f.box()),O.getBoundingSphere(new Yn)}function nt(O,Y){if(!Y){Q=null,c.setPose(O),i.set({animating:!1}),te();return}Q={from:c.pose(),to:O,t0:performance.now(),ms:FE},i.set({animating:!0}),te()}function A(O,Y,ie){const he=new Xl;he.setPose(c.pose()),he.projection=c.projection,O&&he.orient(O,Y??[0,0,1]);{const Xe=Nt();Xe.radius*=BE,he.frame(Xe)}return he.pose()}const x=new Set;let L=0;function F(){const O=c.pose();return{position:[O.position.x,O.position.y,O.position.z],target:[O.target.x,O.target.y,O.target.z],up:[O.up.x,O.up.y,O.up.z],orthoHeight:O.orthoHeight,projection:i.get().projection}}function B(){L&&clearTimeout(L),L=setTimeout(()=>{if(L=0,E)return;if(Q){B();return}const O=F();for(const Y of[...x])try{Y(O)}catch(ie){console.error("[cad] camera listener failed",ie)}},UE)}function q(O={}){nt(A(null,null),O.animate??!0)}function oe(O,Y={}){const ie=tE[O];nt(A(ie.dir,ie.up),Y.animate??!0)}function j(O,Y=[0,0,1],ie={}){const he=new U(...O).normalize();let Xe=Y;Math.abs(he.dot(new U(...Y).normalize()))>.99&&(Xe=Math.abs(he.z)>.9?[0,1,0]:[0,0,1]),nt(A([he.x,he.y,he.z],Xe),ie.animate??!0)}let W=null,ce=null,fe=0,me=0;const de=O=>{const Y=o.getBoundingClientRect();return{x:O.clientX-Y.left,y:O.clientY-Y.top}};function De(O,Y){const ie=Me(),he=iu(ie,O,Y),Xe=ie.faces?Lo(Be(),he,ie):null;if(Xe)return Xe.point;const Oe=c.dop(),Ge=he.direction.dot(Oe),Mt=Math.abs(Ge)>1e-9?new U().subVectors(c.target,he.origin).dot(Oe)/Ge:0;return he.at(Math.max(Mt,0),new U)}function Ue(O){for(const Y of[...m])try{Y(O)}catch(ie){console.error("[cad] pick listener failed",ie)}}function Ve(O){ce=O,!fe&&(fe=setTimeout(G,Math.max(0,OE-(performance.now()-me))))}function G(){fe=0,me=performance.now(),!(!ce||W||E)&&V(ve(ce.x,ce.y))}function pe(){Q&&(Q=null,i.set({animating:!1}))}function se(O){if(W||O.button!==0&&O.button!==1&&O.button!==2)return;O.button===1&&O.preventDefault();const Y=de(O);W={button:O.button,mode:null,x0:Y.x,y0:Y.y,x:Y.x,y:Y.y,moved:!1,additive:O.ctrlKey||O.metaKey,anchor:null,id:O.pointerId};try{o.setPointerCapture(O.pointerId)}catch{}pe()}function ge(O){const Y=de(O);if(W&&O.pointerId===W.id&&O.buttons===0&&O.pointerType==="mouse"&&(W=null),W&&O.pointerId===W.id){if(!W.mode){const Xe=W.button===2?Jw:Zw;if(Math.hypot(Y.x-W.x0,Y.y-W.y0)<=Xe)return;W.mode=W.button===1||W.button===0&&O.shiftKey?"pan":W.button===2?"zoom":"orbit",W.moved=!0,W.mode==="zoom"&&(W.anchor=De(W.x0,W.y0)),i.get().hover&&V(null),W.x=W.x0,W.y=W.y0}const ie=Y.x-W.x,he=Y.y-W.y;W.x=Y.x,W.y=Y.y,W.mode==="orbit"?c.orbit(ie,he,$,X):W.mode==="pan"?c.pan(ie,he,X):c.zoomAt(Math.exp(he*1.9/X),W.anchor),te();return}O.buttons||Ve(Y)}function xe(O){if(!W||O.pointerId!==W.id)return;const Y=W;W=null;try{o.releasePointerCapture(O.pointerId)}catch{}const ie=de(O);if(Y.moved){Ve(ie),B();return}Y.button===0?Ue({type:"click",pick:ve(ie.x,ie.y),additive:Y.additive||O.ctrlKey||O.metaKey,clientX:O.clientX,clientY:O.clientY}):Y.button===2&&Ue({type:"contextmenu",pick:ve(ie.x,ie.y),additive:!1,clientX:O.clientX,clientY:O.clientY})}function le(O){W&&O.pointerId===W.id&&(W=null)}function Ne(O){O.preventDefault();const Y=O.wheelDeltaY;let ie=typeof Y=="number"&&Y!==0?-Y/120:O.deltaY*(O.deltaMode===1?40:O.deltaMode===2?800:1)/100;ie=Math.max(-5,Math.min(5,ie));const he=1-ie/10;if(!(he>0))return;const Xe=de(O);pe(),c.zoomAt(he,De(Xe.x,Xe.y)),te(),Ve(Xe),B()}function Te(O){const Y=de(O),ie=ve(Y.x,Y.y);ie&&Ue({type:"dblclick",pick:ie,additive:!1,clientX:O.clientX,clientY:O.clientY})}function pt(){ce=null,!W&&i.get().hover&&V(null)}const lt=O=>O.preventDefault(),bn=O=>O.preventDefault();o.addEventListener("pointerdown",se),o.addEventListener("pointermove",ge),o.addEventListener("pointerup",xe),o.addEventListener("pointercancel",le),o.addEventListener("pointerleave",pt),o.addEventListener("wheel",Ne,{passive:!1}),o.addEventListener("dblclick",Te),o.addEventListener("contextmenu",lt),o.addEventListener("auxclick",bn);const wn=new ResizeObserver(re);wn.observe(n),re(),c.frame(Nt());let Gs=()=>{};const Ws={state:i,setBodies:ot,setVisibility(O,Y){const ie=g.get(O);!ie||ue(ie)===Y||(ie.override=Y,S="",qe(),Ke(),$e(),Tt(),i.get().hover&&V(null),te())},setVertices(O,Y,ie){const he=g.get(O);!he||he.tessKey!==Y||(he.vertices=ie,I="",Tt())},highlight(O){v=O.slice(),Tt()},flash(O){w=O.slice(),Tt()},setFilter(O){O.length===y.length&&O.every((Y,ie)=>Y===y[ie])||(y=O.slice(),i.get().hover&&V(null))},onPick(O){return m.add(O),()=>{m.delete(O)}},fit(O){q(O),B()},setView(O,Y){oe(O,Y),B()},lookAt(O,Y,ie){j(O,Y,ie),B()},setDisplay(O){i.get().display!==O&&(i.set({display:O}),Ke(),i.get().hover&&V(null),te())},setProjection(O){i.get().projection!==O&&(pe(),c.setProjection(O),i.set({projection:O}),te(),B())},setSection(O){const Y={...i.get().section,...O};Number.isFinite(Y.offset)||(Y.offset=0),Y.plane in Wn||(Y.plane="origin:front"),i.set({section:Y}),rt(),i.get().hover&&V(null),te()},setPlanes(O){i.get().planes!==O&&(i.set({planes:O}),Tt(),i.get().hover&&V(null),te())},sectionRange(O){const Y=new yt;for(const Oe of g.values()){if(!ue(Oe))continue;const Ge=Oe.kbox;Ge&&Ge.length===6&&Ge.every(Number.isFinite)?Y.union(new yt(new U(Ge[0],Ge[1],Ge[2]),new U(Ge[3],Ge[4],Ge[5]))):Y.union(Oe.data.bounds)}if(Y.isEmpty())return null;const ie=new U(...Wn[O].normal).normalize();let he=1/0,Xe=-1/0;for(const Oe of[Y.min.x,Y.max.x])for(const Ge of[Y.min.y,Y.max.y])for(const Mt of[Y.min.z,Y.max.z]){const He=ie.x*Oe+ie.y*Ge+ie.z*Mt;he=Math.min(he,He),Xe=Math.max(Xe,He)}return[he,Xe]},pick(O,Y){const ie=o.getBoundingClientRect();return ve(O-ie.left,Y-ie.top)},project(O){const Y=ae(new U(...O));if(!Y)return null;const ie=o.getBoundingClientRect();return[ie.left+Y[0],ie.top+Y[1]]},orbitAround(O){if(O==="center"){const Y=new yt;for(const ie of g.values())ue(ie)&&Y.union(ie.data.bounds);Y.isEmpty()?c.pivot.set(0,0,0):Y.getCenter(c.pivot)}else c.pivot.set(O[0],O[1],O[2])},orbitPivot(){return[c.pivot.x,c.pivot.y,c.pivot.z]},camera:F,setCamera(O){pe(),i.get().projection!==O.projection&&(c.setProjection(O.projection),i.set({projection:O.projection})),c.setPose({position:new U(...O.position),target:new U(...O.target),up:new U(...O.up),orthoHeight:O.orthoHeight}),te()},onCameraChange(O){return x.add(O),()=>{x.delete(O)}},planeNormal(O){if(O.kind==="origin"){const Y=Wn[O.ref];return Y?[...Y.normal]:null}if(O.kind==="face"){const Y=g.get(O.body);return Y?SE(Y.data,O.index):null}return null},stats:()=>({...r,bvh:{...r.bvh}}),measure(O){const Y=s.getContext(),ie=new Uint8Array(4),he=Math.max(1,Math.floor(O)),Xe=performance.now();for(let Ge=0;Ge<he;Ge++)c.orbit(3,0,$,X),je(),Y.readPixels(0,0,1,1,Y.RGBA,Y.UNSIGNED_BYTE,ie);const Oe=(performance.now()-Xe)/he;return te(),{msPerFrame:Oe,frames:he}},dispose(){if(!E){E=!0,Gs(),wn.disconnect(),J&&cancelAnimationFrame(J),fe&&clearTimeout(fe),L&&clearTimeout(L),x.clear(),o.removeEventListener("pointerdown",se),o.removeEventListener("pointermove",ge),o.removeEventListener("pointerup",xe),o.removeEventListener("pointercancel",le),o.removeEventListener("pointerleave",pt),o.removeEventListener("wheel",Ne),o.removeEventListener("dblclick",Te),o.removeEventListener("contextmenu",lt),o.removeEventListener("auxclick",bn);for(const O of g.values())ke(O);g.clear(),_.dispose(),f.dispose(),d.dispose(),u.dispose();for(const O of[b,T,R])O.dispose();C.geometry.dispose(),D.geometry.dispose(),N.geometry.dispose(),s.dispose(),o.remove(),m.clear()}}};return t&&(Gs=UM(Ws,t)),te(),Ws}function zE(){const n=hn(),e=_n(null),[t,i]=Lt(null);return Cn(()=>{const r=e.current;if(!r)return;const s=kE(r,{services:n});return n.viewport.set({handle:s}),i(s),()=>{n.viewport.set({handle:null}),i(null),s.dispose()}},[n]),k("div",{ref:e,className:"cad-viewport","data-cad-viewport":"1",children:t?k(W0,{handle:t}):null})}function VE(n){const e=z0().map(t=>n.commands.register(t));return()=>{for(const t of e)t()}}function HE({services:n}){const e=it(n.kernel.status,r=>r.state),t=it(n.doc.state,r=>r.status),i=it(n.viewport,r=>r.handle!==null);return Ae("div",{className:"cad-app","data-cad-app":"1","data-kernel":e,"data-doc":t,"data-viewport":i?"ready":"none",children:[k(d0,{}),Ae("div",{className:"cad-stage",children:[k(zE,{}),k(I0,{}),k(O0,{}),k(U0,{})]})]})}function GE({services:n}){return k(l0,{services:n,children:k(HE,{services:n})})}const WE={sketch:"SKETCH",solid:"SOLID",modify:"MODIFY",pattern:"PATTERN",construct:"CONSTRUCT",inspect:"INSPECT",file:"FILE",draw:"DRAW",constrain:"CONSTRAIN",dimension:"DIMENSION","sketch-modify":"MODIFY"},$E=["sketch","solid","modify","pattern","construct","inspect","file"],XE=["draw","constrain","dimension","sketch-modify"];function qE(n){const e=new Map,t=new Set,i=()=>{for(const s of[...t])s()};return{register(s){if(s.group&&!s.icon)throw new Error(`command ${s.id}: a toolbar command needs an icon`);return e.set(s.id,s),i(),()=>{e.get(s.id)===s&&(e.delete(s.id),i())}},get:s=>e.get(s),all:()=>[...e.values()],toolbar(s){const a=s==="sketch"?XE:$E,o=[];for(const l of a){const c=[...e.values()].filter(f=>f.group===l&&(f.mode==="any"||(f.mode??"model")===s)).sort((f,d)=>(f.order??0)-(d.order??0)||f.label.localeCompare(d.label));c.length&&o.push({group:l,label:WE[l],commands:c})}return o},async run(s){const a=e.get(s);if(!a)return`Unknown command ${s}`;const o=n(),l=a.enabled?a.enabled(o):!0;return l!==!0?l:(await a.run(o),!0)},subscribe(s){return t.add(s),()=>{t.delete(s)}}}}function YE(n,e){window.__CAD__={version:e,services:n,snapshot(){const t=n.doc.state.get();return{kernel:n.kernel.status.get(),doc:{status:t.status,features:t.doc.features.length,bodies:t.rebuild.bodies.length,save:t.save.state},viewport:n.viewport.get().handle!==null,selection:n.selection.get().items.length}}}}const KE=["Ctrl","Alt","Shift"];function rh(n){const e=n.split("+").map(r=>r.trim()).filter(Boolean),t=new Set;let i="";for(const r of e){const s=r.toLowerCase();s==="ctrl"||s==="control"||s==="cmd"||s==="meta"||s==="mod"?t.add("Ctrl"):s==="alt"||s==="option"?t.add("Alt"):s==="shift"?t.add("Shift"):i=im(r)}return[...KE.filter(r=>t.has(r)),i].filter(Boolean).join("+")}function im(n){if(n.length===1)return n.toUpperCase();const e=n.toLowerCase();return e==="esc"?"Escape":e==="del"?"Delete":e==="space"||n===" "?"Space":n[0].toUpperCase()+n.slice(1)}function ZE(n){const e=[];(n.ctrlKey||n.metaKey)&&e.push("Ctrl"),n.altKey&&e.push("Alt"),n.shiftKey&&e.push("Shift");const t=n.key===" "?"Space":im(n.key);return t==="Control"||t==="Shift"||t==="Alt"||t==="Meta"?e.join("+"):[...e,t].join("+")}function JE(n){const e=n;if(!e||!e.tagName)return!1;const t=e.tagName.toLowerCase();return t==="input"||t==="textarea"||t==="select"||e.isContentEditable}function QE(n){const e=new Map,t=i=>{const r=ZE(i),s=e.get(r);if(!s||!s.length)return;const a=s[s.length-1];JE(i.target)&&!a.inInputs||(i.preventDefault(),a.run(i))};return n.addEventListener("keydown",t),{normalise:rh,bind(i){const r=rh(i.combo),s={...i,combo:r},a=e.get(r)??[];return a.push(s),e.set(r,a),()=>{const o=e.get(r);o&&e.set(r,o.filter(l=>l!==s))}},dispose(){n.removeEventListener("keydown",t),e.clear()}}}function jE(n,e,t){let i=[];const r=()=>{for(const a of i)a();i=n.all().filter(a=>a.shortcut).map(a=>e.bind({combo:a.shortcut,run:()=>{n.run(a.id).then(o=>{o!==!0&&a.explainRefusal&&t&&t(`${a.label}: ${o}`)})}}))};r();const s=n.subscribe(r);return()=>{s();for(const a of i)a()}}function eT(n,e,t){n.innerHTML="";const i=document.createElement("div");i.className="cad-fatal",i.setAttribute("role","alert"),i.setAttribute("data-cad-fatal","1");const r=document.createElement("h1");r.textContent=e;const s=document.createElement("p");s.textContent=t,i.append(r,s),n.append(i)}async function tT(n){const e=performance.now();let t;try{t=await rm({timeoutMs:15e3})}catch(f){return eT(n,"The Part workspace could not start",`${f instanceof Error?f.message:String(f)}. Open the Part from its project in Magnusim.`),null}const i=fm(t),r=dm(),s=Cg({spawn:f=>i.spawnWorker(f)}),a=bg({bridge:i,kernel:s,bus:r});let o=null;const l=qE(()=>o),c=QE(document);return o={bridge:i,bus:r,commands:l,keyboard:c,kernel:s,doc:a,selection:hm(),mode:Ki({mode:"model"}),viewport:Ki({handle:null})},wg(o),VE(o),k0(o),jE(l,c,f=>i.toast(f,"info")),YE(o,lo),cm(n).render(lm(GE,{services:o})),s.start().catch(()=>{}),await a.load(),r.emit("app:ready",{ms:performance.now()-e}),o}const sh=document.getElementById("cad-root");sh&&tT(sh);
