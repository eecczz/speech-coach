/* empty css              */import{a as e,o as t,t as n}from"./store-C_yxxovN.js";var r=new Set([`음`,`어`,`그`,`그니까`,`그러니까`,`이제`,`뭐`,`약간`,`막`,`근데`,`음...`,`어...`,`에...`]);function i(e){return e.trim().replace(/^[.,!?…"'()[\]{}]+|[.,!?…"'()[\]{}]+$/g,``).trim()}function a(e){if(!/filler|필러|폭주/i.test(e.title))return new Set;let t=e.title.match(/\(([^)]+)\)/);return t?new Set(t[1].split(`,`).map(e=>i(e))):new Set}var o={brilliant:{icon:`★`,color:`#5dd5a2`,label:`탁월`},excellent:{icon:`!!`,color:`#5dd5a2`,label:`우수`},good:{icon:`★`,color:`#9bb`,label:`무난`},inaccuracy:{icon:`!`,color:`#4aa3ff`,label:`주의`},mistake:{icon:`?`,color:`#f0a040`,label:`실수`},blunder:{icon:`✕`,color:`#e04848`,label:`심각`}},s={gaze:`시선`,posture:`자세`,expression:`표정`,gesture:`제스처`,delivery:`전달력`,logic:`논리`,overall:`종합`},c={gaze:[50,22],expression:[50,27],gesture:[50,52],posture:[50,62],delivery:[50,78],logic:[50,78],overall:[50,50]},l=.8;function u(e,t){let n=e[t],r=n.t-l,i=n.t+(n.duration_s??0)+l,a=[t];for(let n=0;n<e.length;n++){if(n===t)continue;let o=e[n],s=o.t-l;r<o.t+(o.duration_s??0)+l&&s<i&&a.push(n)}return a.sort((t,n)=>e[t].t-e[n].t)}function d(e,t,n,r,i){let a=o[t.quality],c=`
    <div class="bubble-head">
      <span class="bubble-icon" style="color:${a.color}">${a.icon}</span>
      <span class="bubble-time">${E(t.t)}</span>
      <span class="bubble-quality">${a.label}</span>
      <span class="bubble-axis">${s[t.axis]??t.axis}</span>
    </div>
    <div class="bubble-title">${D(t.title)}</div>
    <div class="bubble-comment">${D(t.coach_comment??`(코멘트 없음)`)}</div>
  `;n.length>0&&(c+=`
      <div class="bubble-concurrent">
        <div class="bubble-concurrent-label">동시 발생 (${n.length})</div>
        <ul class="bubble-concurrent-list" data-el="concurrent-list">
          ${n.map((e,t)=>{let n=o[e.quality];return`
                <li class="bubble-concurrent-item moment-${e.quality}" data-other-index="${r[t]}">
                  <span class="bubble-concurrent-icon" style="color:${n.color}">${n.icon}</span>
                  <span class="bubble-concurrent-axis">${s[e.axis]??e.axis}</span>
                  <span class="bubble-concurrent-title">${D(e.title)}</span>
                  ${e.coach_comment?`<div class="bubble-concurrent-comment">${D(e.coach_comment)}</div>`:``}
                </li>
              `}).join(``)}
        </ul>
      </div>
    `),e.innerHTML=c,e.querySelectorAll(`[data-other-index]`).forEach(e=>{let t=Number(e.dataset.otherIndex);e.addEventListener(`click`,()=>i(t))})}var f=`
  <header class="review-header">
    <div class="overall-card">
      <div class="overall-label">종합 정확성</div>
      <div data-el="overall" class="overall-value">—</div>
    </div>
    <div data-el="coach-bubble" class="coach-bubble">선택된 순간이 없습니다.</div>
    <div data-el="coach-impact" class="impact-pill">±0</div>
  </header>

  <div class="review-controls">
    <button data-el="prev">← 이전</button>
    <button data-el="next">다음 →</button>
    <span class="kbd-hint">키보드 ← / → 로도 이동</span>
  </div>

  <div class="review-grid">
    <div class="review-left">
      <div class="video-overlay-wrap">
        <video data-el="video" controls playsinline></video>
        <div data-el="overlay" class="video-mistake-overlay"></div>
        <div data-el="subtitle" class="video-subtitle"></div>
      </div>
      <svg data-el="timeline" viewBox="0 0 800 120" preserveAspectRatio="none"></svg>
    </div>
    <div class="review-right">
      <h3 class="panel-h">축별 정확성</h3>
      <div data-el="axes" class="axes"></div>
      <h3 class="panel-h">품질 분포</h3>
      <div data-el="buckets" class="buckets"></div>
    </div>
  </div>

  <h3 class="panel-h">순간 (Moments)</h3>
  <ol data-el="moments-list" class="moments"></ol>
  <h3 class="panel-h">총평</h3>
  <p data-el="summary" class="summary"></p>
`;function p(e,t,n){let c=n??document.getElementById(`review`);if(!c)throw Error(`renderReview: no container — pass one or ensure #review exists`);c.innerHTML=f;let l=e=>c.querySelector(`[data-el="${e}"]`),p=l(`overall`),m=l(`coach-bubble`),h=l(`coach-impact`),g=l(`prev`),v=l(`next`),y=l(`video`),b=l(`overlay`),x=l(`subtitle`),S=l(`timeline`),O=l(`axes`),k=l(`buckets`),A=l(`moments-list`),j=l(`summary`),M=e.subtitle_segments??[];t.src&&(y.src=t.src);let N=e.annotated_moments??[],P=e.score_timeline??[],F=0;p.textContent=`${e.accuracy_overall.toFixed(1)}%`,j.textContent=e.overall_summary??``,C(O,e.accuracy_per_axis??[]),w(k,e.quality_buckets),N.forEach((e,t)=>{let n=document.createElement(`li`);n.className=`moment moment-${e.quality}`,n.dataset.index=String(t);let r=o[e.quality];n.innerHTML=`
      <span class="moment-time">${E(e.t)}</span>
      <span class="moment-icon" style="color:${r.color}">${r.icon}</span>
      <span class="moment-axis">${s[e.axis]??e.axis}</span>
      <span class="moment-title">${D(e.title)}</span>
      <span class="moment-impact">${e.impact>=0?`+`:``}${e.impact}</span>
    `,n.addEventListener(`click`,()=>H(t)),A.appendChild(n)}),T(S,P,N,e=>H(e));let I=[];function L(){return I.find(e=>e.axis===`delivery`||e.axis===`logic`)}function R(){if(M.length===0){x.classList.remove(`subtitle-visible`);return}let e=y.currentTime,t=M.find(t=>t.t_start<=e&&e<=t.t_end+.4);if(!t){x.classList.remove(`subtitle-visible`),x.innerHTML=``;return}let n=L(),o=n?a(n):new Set,s=t.words.length>0?t.words.map(t=>{let a=i(t.word);return`<span class="subtitle-word${n&&(o.has(a)||r.has(a))?` subtitle-filler`:``}${e>=t.t_start&&e<=t.t_end+.1?` subtitle-current`:``}">${D(t.word)}</span>`}).join(` `):`<span>${D(t.text)}</span>`;x.className=`video-subtitle subtitle-visible${n?` subtitle-active`:``}`,x.innerHTML=s}function z(){let e=y.currentTime;_(b,I,e),R()}let B=0;function V(){z(),!y.paused&&!y.ended&&(B=requestAnimationFrame(V))}y.addEventListener(`play`,()=>{cancelAnimationFrame(B),B=requestAnimationFrame(V)}),y.addEventListener(`pause`,()=>{cancelAnimationFrame(B),z()}),y.addEventListener(`ended`,()=>cancelAnimationFrame(B)),y.addEventListener(`seeked`,z),y.addEventListener(`loadedmetadata`,()=>{let e=N[F];if(e)try{y.currentTime=e.t}catch{}z()}),g.addEventListener(`click`,()=>H(F-1)),v.addEventListener(`click`,()=>H(F+1)),document.addEventListener(`keydown`,e=>{document.activeElement&&document.activeElement.tagName===`INPUT`||(e.key===`ArrowLeft`?H(F-1):e.key===`ArrowRight`&&H(F+1))});function H(e){if(N.length===0)return;let n=Math.max(0,Math.min(N.length-1,e));F=n;let r=N[n],i=u(N,n),a=i.filter(e=>e!==n);d(m,r,a.map(e=>N[e]),a,e=>H(e)),h.textContent=`${r.impact>=0?`+`:``}${r.impact}`,A.querySelectorAll(`li`).forEach(e=>e.classList.remove(`active`,`concurrent`));let o=A.querySelector(`li[data-index="${n}"]`);o&&(o.classList.add(`active`),o.scrollIntoView({block:`nearest`,behavior:`smooth`}));for(let e of a){let t=A.querySelector(`li[data-index="${e}"]`);t&&t.classList.add(`concurrent`)}S.querySelectorAll(`.timeline-dot`).forEach(e=>e.classList.remove(`active`,`concurrent`));let s=S.querySelector(`.timeline-dot[data-index="${n}"]`);s&&s.classList.add(`active`);for(let e of a){let t=S.querySelector(`.timeline-dot[data-index="${e}"]`);t&&t.classList.add(`concurrent`)}I=i.map(e=>N[e]);try{y.pause(),y.currentTime=r.t}catch{}if(t!==y)try{t.pause(),t.currentTime=r.t}catch{}g.disabled=n===0,v.disabled=n===N.length-1}return N.length>0&&H(0),{selectIndex:H,next:()=>H(F+1),prev:()=>H(F-1)}}function m(e,t){let n=t=>e.title.includes(t),r=(e,t)=>e===`left`?[{a:t.leftShoulder,b:t.leftElbow},{a:t.leftElbow,b:t.leftWrist}]:[{a:t.rightShoulder,b:t.rightElbow},{a:t.rightElbow,b:t.rightWrist}],i=e=>{let t={x:(e.leftShoulder.x+e.rightShoulder.x)/2,y:(e.leftShoulder.y+e.rightShoulder.y)/2},n={x:(e.leftHip.x+e.rightHip.x)/2,y:(e.leftHip.y+e.rightHip.y)/2};return[{a:e.head,b:t},{a:t,b:n},{a:e.leftShoulder,b:e.rightShoulder},{a:e.leftHip,b:e.rightHip},{a:e.leftShoulder,b:e.leftHip},{a:e.rightShoulder,b:e.rightHip}]},a=e=>{let t={x:(e.leftEye.x+e.rightEye.x)/2,y:(e.leftEye.y+e.rightEye.y)/2};return[{a:e.leftEye,b:e.rightEye},{a:t,b:e.mouth}]};switch(e.axis){case`gaze`:case`expression`:if(t.face)return a(t.face);break;case`gesture`:if(t.pose)return[...r(`left`,t.pose),...r(`right`,t.pose)];break;case`posture`:if((n(`턱 괴기`)||n(`얼굴`)||n(`만지`))&&t.face&&t.pose&&t.face&&t.pose){let e=(t.face.bbox.minX+t.face.bbox.maxX)/2,n=(t.face.bbox.minY+t.face.bbox.maxY)/2;return r(Math.hypot(t.pose.leftWrist.x-e,t.pose.leftWrist.y-n)<Math.hypot(t.pose.rightWrist.x-e,t.pose.rightWrist.y-n)?`left`:`right`,t.pose)}if(n(`만지작`)&&t.pose)return[...r(`left`,t.pose),...r(`right`,t.pose)];if(t.pose)return i(t.pose);break;case`overall`:if(t.pose)return i(t.pose);break;default:break}return[]}var h=5,g=7;function _(t,n,r){if(t.innerHTML=``,n.length===0)return;let i=`http://www.w3.org/2000/svg`,a=document.createElementNS(i,`svg`);a.setAttribute(`class`,`mistake-bone-layer`),a.setAttribute(`viewBox`,`0 0 100 100`),a.setAttribute(`preserveAspectRatio`,`none`);let s=e(r,.4),l=[];for(let e of n){let n=o[e.quality];if(e.axis===`delivery`||e.axis===`logic`){let[r,i]=c[e.axis]??c.gesture,a=S(r,i,l);t.appendChild(b(e,n,a.x,a.y,!0));continue}let r=s?m(e,s):[];if(r.length===0)continue;for(let e of r)a.appendChild(v(i,e,n.color,`mistake-bone-track`)),a.appendChild(v(i,e,n.color,`mistake-bone-core`)),a.appendChild(y(i,e.a,n.color)),a.appendChild(y(i,e.b,n.color));let u=0,d=0;for(let e of r)u+=(e.a.x+e.b.x)/2,d+=(e.a.y+e.b.y)/2;u=u/r.length*100,d=d/r.length*100;let f=S(u,d,l);t.appendChild(b(e,n,f.x,Math.max(8,f.y-8),!1))}t.insertBefore(a,t.firstChild)}function v(e,t,n,r){let i=document.createElementNS(e,`line`);return i.setAttribute(`x1`,String(t.a.x*100)),i.setAttribute(`y1`,String(t.a.y*100)),i.setAttribute(`x2`,String(t.b.x*100)),i.setAttribute(`y2`,String(t.b.y*100)),i.setAttribute(`stroke`,n),i.setAttribute(`stroke-linecap`,`round`),i.setAttribute(`vector-effect`,`non-scaling-stroke`),i.setAttribute(`class`,r),i}function y(e,t,n){let r=document.createElementNS(e,`circle`);return r.setAttribute(`cx`,String(t.x*100)),r.setAttribute(`cy`,String(t.y*100)),r.setAttribute(`r`,`1.15`),r.setAttribute(`fill`,n),r.setAttribute(`class`,`mistake-joint`),r}function b(e,t,n,r,i){let a=document.createElement(`div`);return a.className=`analysis-marker quality-${e.quality}${i?` analysis-marker-caption`:``}`,a.style.setProperty(`--marker-color`,t.color),a.style.left=`${x(n)}%`,a.style.top=`${x(r)}%`,a.innerHTML=`
    <span class="analysis-marker-dot"></span>
    <span class="analysis-marker-copy">
      <strong>${D(s[e.axis]??e.axis)}</strong>
      <em>${D(t.label)}</em>
    </span>
  `,a.title=e.title,a}function x(e){return Math.max(4,Math.min(96,e))}function S(e,t,n){let r=e;for(let e=0;e<6&&n.some(e=>Math.abs(e.x-r)<h&&Math.abs(e.y-t)<h);e++)r+=g;return n.push({x:r,y:t}),{x:r,y:t}}function C(e,t){e.innerHTML=``;for(let n of t){let t=document.createElement(`div`);t.className=`axis-row`;let r=n.available?Math.max(0,Math.min(100,n.score)):0,i=n.available?``:n.note??`N/A`;t.innerHTML=`
      <span class="axis-label">${s[n.axis]??n.axis}</span>
      <span class="axis-bar"><span class="axis-fill" style="width:${r}%"></span></span>
      <span class="axis-score">${n.available?n.score.toFixed(0):`—`}</span>
      <span class="axis-note">${D(i)}</span>
    `,e.appendChild(t)}}function w(e,t){e.innerHTML=``;let n=[[`brilliant`,t?.brilliant??0],[`excellent`,t?.excellent??0],[`good`,t?.good??0],[`inaccuracy`,t?.inaccuracy??0],[`mistake`,t?.mistake??0],[`blunder`,t?.blunder??0]];for(let[t,r]of n){let n=o[t],i=document.createElement(`div`);i.className=`bucket-cell`,i.innerHTML=`
      <span class="bucket-icon" style="color:${n.color}">${n.icon}</span>
      <span class="bucket-label">${n.label}</span>
      <span class="bucket-count">${r}</span>
    `,e.appendChild(i)}}function T(e,t,n,r){for(;e.firstChild;)e.removeChild(e.firstChild);if(t.length===0&&n.length===0)return;let i=e.viewBox.baseVal?.width||800,a=e.viewBox.baseVal?.height||120,s=Math.max(t.length?t[t.length-1].t:0,n.length?n[n.length-1].t:0,1),c=e=>8+e/s*(i-16),l=e=>a-8-e/100*(a-16);if(t.length>1){let n=document.createElementNS(`http://www.w3.org/2000/svg`,`path`),r=`M ${c(t[0].t).toFixed(1)} ${l(t[0].score).toFixed(1)}`;for(let e=1;e<t.length;e++)r+=` L ${c(t[e].t).toFixed(1)} ${l(t[e].score).toFixed(1)}`;n.setAttribute(`d`,r),n.setAttribute(`class`,`timeline-line`),e.appendChild(n)}for(let t of[25,50,75]){let n=document.createElementNS(`http://www.w3.org/2000/svg`,`line`);n.setAttribute(`x1`,`8`),n.setAttribute(`x2`,String(i-8)),n.setAttribute(`y1`,String(l(t))),n.setAttribute(`y2`,String(l(t))),n.setAttribute(`class`,`timeline-grid`),e.appendChild(n)}n.forEach((n,i)=>{let a=document.createElementNS(`http://www.w3.org/2000/svg`,`circle`);a.setAttribute(`cx`,String(c(n.t)));let s=t.reduce((e,t)=>Math.abs(t.t-n.t)<Math.abs(e.t-n.t)?t:e,t[0]??{t:n.t,score:75});a.setAttribute(`cy`,String(l(s?.score??75))),a.setAttribute(`r`,`5`),a.setAttribute(`class`,`timeline-dot quality-${n.quality}`),a.setAttribute(`data-index`,String(i)),a.setAttribute(`fill`,o[n.quality].color),a.addEventListener(`click`,()=>r(i));let u=document.createElementNS(`http://www.w3.org/2000/svg`,`title`);u.textContent=`${E(n.t)} ${n.title}`,a.appendChild(u),e.appendChild(a)})}function E(e){let t=Math.floor(e/60),n=Math.floor(e%60);return`${t.toString().padStart(2,`0`)}:${n.toString().padStart(2,`0`)}`}function D(e){return e.replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`)}var O=document.getElementById(`report-title`),k=document.getElementById(`report-subtitle`),A=document.getElementById(`report-heading`),j=document.getElementById(`report-focus-line`),M=document.getElementById(`report-status`),N=document.getElementById(`review`),P=document.getElementById(`retry-link`),F=document.querySelector(`[data-theme-toggle]`);function I(){let e=document.documentElement.dataset.theme||`light`;F.textContent=e===`dark`?`☀️`:`🌙`,F.setAttribute(`aria-label`,e===`dark`?`라이트 모드로 전환`:`다크 모드로 전환`)}F.addEventListener(`click`,()=>{let e=(document.documentElement.dataset.theme||`light`)===`dark`?`light`:`dark`;document.documentElement.dataset.theme=e,localStorage.setItem(`speakup-theme`,e),I()});async function L(){I();let e=new URLSearchParams(location.search),r=e.get(`id`),i=e.get(`project`)||`오늘의 말하기 연습`,a=e.get(`goal`)||`말 속도`;if(P.href=R(e,i,a),O.textContent=i,A.textContent=i,j.textContent=`${a} 중심으로 분석한 코칭 결과입니다.`,!r){z(`연결된 리포트가 없습니다. 연습을 완료하면 이 화면에 결과가 표시됩니다.`,!0);return}let o=await n(r);if(!o){z(`저장된 리포트를 찾지 못했습니다. 브라우저 저장소가 비워졌을 수 있습니다.`,!0);return}let s=o.report;k.textContent=`${new Date(o.createdAt).toLocaleString(`ko-KR`,{month:`2-digit`,day:`2-digit`,hour:`2-digit`,minute:`2-digit`})} 코칭`,j.textContent=`${o.goal||a} 중심 · 종합 ${s.accuracy_overall.toFixed(1)}점 · 순간 ${s.annotated_moments?.length??0}개`,t(o.landmarks??[]);let c=document.createElement(`video`);c.src=URL.createObjectURL(o.videoBlob),c.preload=`metadata`,N.hidden=!1,M.hidden=!0,p(s,c,N)}function R(e,t,n){let r=new URL(`practice.html`,location.href);r.searchParams.set(`project`,t),r.searchParams.set(`goal`,n);for(let t of[`type`,`scenario`]){let n=e.get(t);n&&r.searchParams.set(t,n)}return r.toString()}function z(e,t=!1){M.hidden=!1,M.textContent=e,M.classList.toggle(`is-error`,t)}L().catch(e=>{console.error(`[report] failed`,e),z(`리포트 로딩 실패: ${e instanceof Error?e.message:String(e)}`,!0)});