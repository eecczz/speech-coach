/* empty css              */import{a as e,o as t,t as n}from"./store-C_yxxovN.js";var r=new Set([`음`,`어`,`아`,`에`,`저`,`저기`,`그`,`그게`,`그니까`,`그러니까`,`이제`,`뭐`,`약간`,`막`,`근데`,`음...`,`어...`,`에...`]);function i(e){return e.trim().replace(/^[.,!?…"'()[\]{}]+|[.,!?…"'()[\]{}]+$/g,``).trim()}function a(e){if(!/filler|필러|폭주/i.test(e.title))return new Set;let t=e.title.match(/\(([^)]+)\)/);return t?new Set(t[1].split(`,`).map(e=>i(e))):new Set}var o={brilliant:{icon:`★`,color:`#5dd5a2`,label:`탁월`},excellent:{icon:`!!`,color:`#5dd5a2`,label:`우수`},good:{icon:`★`,color:`#9bb`,label:`무난`},inaccuracy:{icon:`!`,color:`#4aa3ff`,label:`주의`},mistake:{icon:`?`,color:`#f0a040`,label:`실수`},blunder:{icon:`✕`,color:`#e04848`,label:`심각`}},s={gaze:`시선`,posture:`자세`,expression:`표정`,gesture:`제스처`,delivery:`전달력`,logic:`논리`,overall:`종합`},c={gaze:[50,22],expression:[50,27],gesture:[50,52],posture:[50,62],delivery:[50,78],logic:[50,78],overall:[50,50]},l=.8;function u(e,t){let n=e[t],r=n.t-l,i=n.t+(n.duration_s??0)+l,a=[t];for(let n=0;n<e.length;n++){if(n===t)continue;let o=e[n],s=o.t-l;r<o.t+(o.duration_s??0)+l&&s<i&&a.push(n)}return a.sort((t,n)=>e[t].t-e[n].t)}function d(e,t,n,r,i){let a=o[t.quality],c=`
    <div class="bubble-head">
      <span class="bubble-icon" style="color:${a.color}">${a.icon}</span>
      <span class="bubble-time">${D(t)}</span>
      <span class="bubble-quality">${a.label}</span>
      <span class="bubble-axis">${s[t.axis]??t.axis}</span>
    </div>
    <div class="bubble-title">${k(C(t.title))}</div>
    <div class="bubble-comment">${k(C(t.coach_comment??`(코멘트 없음)`))}</div>
  `;n.length>0&&(c+=`
      <div class="bubble-concurrent">
        <div class="bubble-concurrent-label">동시 발생 (${n.length})</div>
        <ul class="bubble-concurrent-list" data-el="concurrent-list">
          ${n.map((e,t)=>{let n=o[e.quality];return`
                <li class="bubble-concurrent-item moment-${e.quality}" data-other-index="${r[t]}">
                  <span class="bubble-concurrent-icon" style="color:${n.color}">${n.icon}</span>
                  <span class="bubble-concurrent-axis">${s[e.axis]??e.axis}</span>
                  <span class="bubble-concurrent-title">${k(C(e.title))}</span>
                  ${e.coach_comment?`<div class="bubble-concurrent-comment">${k(C(e.coach_comment))}</div>`:``}
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
    <button data-el="overlay-toggle" class="overlay-toggle" type="button" aria-pressed="true">오버레이 켜짐</button>
    <button data-el="subtitle-toggle" class="subtitle-toggle" type="button" aria-pressed="true">자막 켜짐</button>
  </div>

  <div class="review-grid">
    <div class="review-left">
      <div class="pdf-video-note">PDF에는 영상이 포함되지 않습니다. 주요 순간, 총평, 전사 확인 표현, 측정 지표가 저장됩니다.</div>
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
  <section data-el="transcript-check-panel" class="transcript-check-panel" hidden>
    <h3 class="panel-h">전사 확인 필요 표현</h3>
    <ul data-el="transcript-check-list" class="transcript-check-list"></ul>
  </section>
  <section data-el="metrics-panel" class="metrics-panel">
    <h3 class="panel-h">측정 지표</h3>
    <div data-el="metrics" class="metrics-grid"></div>
  </section>
  <section data-el="transcript-panel" class="transcript-panel" hidden>
    <h3 class="panel-h">전사 텍스트</h3>
    <p data-el="transcript-text" class="transcript-text"></p>
  </section>
`;function p(e,t,n){let c=n??document.getElementById(`review`);if(!c)throw Error(`renderReview: no container — pass one or ensure #review exists`);c.innerHTML=f;let l=e=>c.querySelector(`[data-el="${e}"]`),p=l(`overall`),m=l(`coach-bubble`),h=l(`coach-impact`),g=l(`prev`),v=l(`next`),y=l(`overlay-toggle`),b=l(`subtitle-toggle`),x=l(`video`),S=l(`overlay`),O=l(`subtitle`),A=l(`timeline`),j=l(`axes`),M=l(`buckets`),N=l(`moments-list`),P=l(`summary`),F=l(`transcript-check-panel`),I=l(`transcript-check-list`),L=l(`metrics`),R=l(`transcript-panel`),z=l(`transcript-text`),B=e.subtitle_segments??[];t.src&&(x.src=t.src);let V=e.annotated_moments??[],H=e.score_timeline??[],U=0,W=localStorage.getItem(`speakup-review-overlay`)!==`false`,G=localStorage.getItem(`speakup-review-subtitle`)!==`false`;p.textContent=`${e.accuracy_overall.toFixed(1)}%`,P.textContent=C(e.overall_summary??``),T(j,e.accuracy_per_axis??[]),te(M,e.quality_buckets),E(L,e.accuracy_per_axis??[]),ee(F,I,e.transcript_checks??[],e=>{x.currentTime=e,x.play().catch(()=>{})}),Q(),$();let K=w(B);K&&(R.hidden=!1,z.textContent=K),V.forEach((e,t)=>{let n=document.createElement(`li`);n.className=`moment moment-${e.quality}`,n.dataset.index=String(t);let r=o[e.quality];n.innerHTML=`
      <span class="moment-time">${D(e)}</span>
      <span class="moment-icon" style="color:${r.color}">${r.icon}</span>
      <span class="moment-axis">${s[e.axis]??e.axis}</span>
      <span class="moment-title">${k(C(e.title))}</span>
      <span class="moment-impact">${e.impact>=0?`+`:``}${e.impact}</span>
    `,n.addEventListener(`click`,()=>Z(t)),N.appendChild(n)}),ne(A,H,V,e=>Z(e));let q=[];function re(){return q.find(e=>e.axis===`delivery`||e.axis===`logic`)}function ie(){if(!G||B.length===0){O.classList.remove(`subtitle-visible`),O.innerHTML=``;return}let e=x.currentTime,t=B.find(t=>t.t_start<=e&&e<=t.t_end+.4);if(!t){O.classList.remove(`subtitle-visible`),O.innerHTML=``;return}let n=re(),o=n?a(n):new Set,s=t.words.length>0?t.words.map(t=>{let a=i(t.word);return`<span class="subtitle-word${n&&(o.has(a)||r.has(a))?` subtitle-filler`:``}${e>=t.t_start&&e<=t.t_end+.1?` subtitle-current`:``}">${k(t.word)}</span>`}).join(` `):`<span>${k(t.text)}</span>`;O.className=`video-subtitle subtitle-visible${n?` subtitle-active`:``}`,O.innerHTML=s}function J(){let e=x.currentTime;W?_(S,q,e):S.innerHTML=``,ie()}let Y=0;function X(){J(),!x.paused&&!x.ended&&(Y=requestAnimationFrame(X))}x.addEventListener(`play`,()=>{cancelAnimationFrame(Y),Y=requestAnimationFrame(X)}),x.addEventListener(`pause`,()=>{cancelAnimationFrame(Y),J()}),x.addEventListener(`ended`,()=>cancelAnimationFrame(Y)),x.addEventListener(`seeked`,J),x.addEventListener(`loadedmetadata`,()=>{let e=V[U];if(e)try{x.currentTime=e.t}catch{}J()}),y.addEventListener(`click`,()=>{W=!W,localStorage.setItem(`speakup-review-overlay`,String(W)),Q(),J()}),b.addEventListener(`click`,()=>{G=!G,localStorage.setItem(`speakup-review-subtitle`,String(G)),$(),J()}),g.addEventListener(`click`,()=>Z(U-1)),v.addEventListener(`click`,()=>Z(U+1)),document.addEventListener(`keydown`,e=>{document.activeElement&&document.activeElement.tagName===`INPUT`||(e.key===`ArrowLeft`?Z(U-1):e.key===`ArrowRight`&&Z(U+1))});function Z(e){if(V.length===0)return;let n=Math.max(0,Math.min(V.length-1,e));U=n;let r=V[n],i=u(V,n),a=i.filter(e=>e!==n);d(m,r,a.map(e=>V[e]),a,e=>Z(e)),h.textContent=`${r.impact>=0?`+`:``}${r.impact}`,N.querySelectorAll(`li`).forEach(e=>e.classList.remove(`active`,`concurrent`));let o=N.querySelector(`li[data-index="${n}"]`);o&&(o.classList.add(`active`),o.scrollIntoView({block:`nearest`,behavior:`smooth`}));for(let e of a){let t=N.querySelector(`li[data-index="${e}"]`);t&&t.classList.add(`concurrent`)}A.querySelectorAll(`.timeline-dot`).forEach(e=>e.classList.remove(`active`,`concurrent`));let s=A.querySelector(`.timeline-dot[data-index="${n}"]`);s&&s.classList.add(`active`);for(let e of a){let t=A.querySelector(`.timeline-dot[data-index="${e}"]`);t&&t.classList.add(`concurrent`)}q=i.map(e=>V[e]);try{x.pause(),x.currentTime=r.t}catch{}if(t!==x)try{t.pause(),t.currentTime=r.t}catch{}g.disabled=n===0,v.disabled=n===V.length-1}function Q(){y.classList.toggle(`is-active`,W),y.setAttribute(`aria-pressed`,String(W)),y.textContent=W?`오버레이 켜짐`:`오버레이 꺼짐`}function $(){b.classList.toggle(`is-active`,G),b.setAttribute(`aria-pressed`,String(G)),b.textContent=G?`자막 켜짐`:`자막 꺼짐`}return V.length>0&&Z(0),{selectIndex:Z,next:()=>Z(U+1),prev:()=>Z(U-1)}}function m(e,t){let n=t=>e.title.includes(t),r=(e,t)=>e===`left`?[{a:t.leftShoulder,b:t.leftElbow},{a:t.leftElbow,b:t.leftWrist}]:[{a:t.rightShoulder,b:t.rightElbow},{a:t.rightElbow,b:t.rightWrist}],i=e=>{let t={x:(e.leftShoulder.x+e.rightShoulder.x)/2,y:(e.leftShoulder.y+e.rightShoulder.y)/2},n={x:(e.leftHip.x+e.rightHip.x)/2,y:(e.leftHip.y+e.rightHip.y)/2};return[{a:e.head,b:t},{a:t,b:n},{a:e.leftShoulder,b:e.rightShoulder},{a:e.leftHip,b:e.rightHip},{a:e.leftShoulder,b:e.leftHip},{a:e.rightShoulder,b:e.rightHip}]},a=e=>{let t={x:(e.leftEye.x+e.rightEye.x)/2,y:(e.leftEye.y+e.rightEye.y)/2};return[{a:e.leftEye,b:e.rightEye},{a:t,b:e.mouth}]};switch(e.axis){case`gaze`:case`expression`:if(t.face)return a(t.face);break;case`gesture`:if(t.pose)return[...r(`left`,t.pose),...r(`right`,t.pose)];break;case`posture`:if((n(`턱 괴기`)||n(`얼굴`)||n(`만지`))&&t.face&&t.pose&&t.face&&t.pose){let e=(t.face.bbox.minX+t.face.bbox.maxX)/2,n=(t.face.bbox.minY+t.face.bbox.maxY)/2;return r(Math.hypot(t.pose.leftWrist.x-e,t.pose.leftWrist.y-n)<Math.hypot(t.pose.rightWrist.x-e,t.pose.rightWrist.y-n)?`left`:`right`,t.pose)}if(n(`만지작`)&&t.pose)return[...r(`left`,t.pose),...r(`right`,t.pose)];if(t.pose)return i(t.pose);break;case`overall`:if(t.pose)return i(t.pose);break;default:break}return[]}var h=5,g=7;function _(t,n,r){if(t.innerHTML=``,n.length===0)return;let i=`http://www.w3.org/2000/svg`,a=document.createElementNS(i,`svg`);a.setAttribute(`class`,`mistake-bone-layer`),a.setAttribute(`viewBox`,`0 0 100 100`),a.setAttribute(`preserveAspectRatio`,`none`);let s=e(r,.4),l=[];for(let[e,r]of n.entries()){let n=o[r.quality],u=r.axis===`delivery`||r.axis===`logic`,d=e===0;if(u){let[e,i]=c[r.axis]??c.gesture,a=S(e,i,l);t.appendChild(b(r,n,a.x,a.y,!0,d));continue}let f=s?m(r,s):[];if(f.length===0)continue;for(let e of f)a.appendChild(v(i,e,n.color,`mistake-bone-track`)),a.appendChild(v(i,e,n.color,`mistake-bone-core`)),a.appendChild(y(i,e.a,n.color)),a.appendChild(y(i,e.b,n.color));let p=0,h=0;for(let e of f)p+=(e.a.x+e.b.x)/2,h+=(e.a.y+e.b.y)/2;p=p/f.length*100,h=h/f.length*100;let g=S(p,h,l);t.appendChild(b(r,n,g.x,Math.max(8,g.y-8),!1,d))}t.insertBefore(a,t.firstChild)}function v(e,t,n,r){let i=document.createElementNS(e,`line`);return i.setAttribute(`x1`,String(t.a.x*100)),i.setAttribute(`y1`,String(t.a.y*100)),i.setAttribute(`x2`,String(t.b.x*100)),i.setAttribute(`y2`,String(t.b.y*100)),i.setAttribute(`stroke`,n),i.setAttribute(`stroke-linecap`,`round`),i.setAttribute(`vector-effect`,`non-scaling-stroke`),i.setAttribute(`class`,r),i}function y(e,t,n){let r=document.createElementNS(e,`circle`);return r.setAttribute(`cx`,String(t.x*100)),r.setAttribute(`cy`,String(t.y*100)),r.setAttribute(`r`,`1.15`),r.setAttribute(`fill`,n),r.setAttribute(`class`,`mistake-joint`),r}function b(e,t,n,r,i,a=!0){let o=document.createElement(`div`);return o.className=`analysis-marker quality-${e.quality}${i?` analysis-marker-caption`:``}${a?``:` analysis-marker-secondary`}`,o.style.setProperty(`--marker-color`,t.color),o.style.left=`${x(n)}%`,o.style.top=`${x(r)}%`,o.innerHTML=a?`
      <span class="analysis-marker-dot"></span>
      <span class="analysis-marker-copy">
        <strong>${k(s[e.axis]??e.axis)}</strong>
        <em>${k(t.label)}</em>
      </span>
    `:`<span class="analysis-marker-dot"></span>`,o.title=C(e.title),o}function x(e){return Math.max(4,Math.min(96,e))}function S(e,t,n){let r=e;for(let e=0;e<6&&n.some(e=>Math.abs(e.x-r)<h&&Math.abs(e.y-t)<h);e++)r+=g;return n.push({x:r,y:t}),{x:r,y:t}}function C(e){return e.replace(/전달력\(Delivery\)/g,`전달력`).replace(/시선 처리\(Gaze\)/g,`시선 처리`).replace(/\bDelivery\b/g,`전달력`).replace(/\bGaze\b/g,`시선`).replace(/세션 평균\s*WPM\s*([0-9.]+)/g,`세션 평균 말 속도는 분당 $1어절`).replace(/말 속도 급상승:\s*WPM\s*([0-9.]+)/g,`말 속도 급상승: 분당 $1어절`).replace(/말 속도 느림:\s*WPM\s*([0-9.]+)/g,`말 속도 느림: 분당 $1어절`).replace(/평균\s*WPM\s*([0-9.]+)\s*은/g,`평균 말 속도는 분당 $1어절로`).replace(/평균\s*WPM\s*([0-9.]+)/g,`평균 말 속도는 분당 $1어절`).replace(/\bWPM\s*([0-9.]+)/g,`분당 $1어절`).replace(/\bWPM\b/g,`분당 말한 어절 수`).replace(/시선 중앙 유지율/g,`정면을 바라본 비율`).replace(/전사 텍스트\s*(?:상에서|상으로|기준으로|기준)?[^.]*?(?:의미 전달이 불분명|논리적 명료성|명료성 개선)[^.]*\./g,`전사 텍스트에 어색한 표현 후보가 있어 STT 오인식 가능성을 확인해야 하며, 언어와 논리 평가는 참고용으로 보는 것이 안전합니다.`).replace(/더딘 및\s*/g,``).replace(/\bfiller\b/gi,`필러 표현`).replace(/\btranscript\b/gi,`전사 텍스트`)}function w(e){return e.map(e=>e.text.trim()).filter(Boolean).join(` `).replace(/\s+/g,` `).trim()}function T(e,t){e.innerHTML=``;for(let n of t){let t=document.createElement(`div`);t.className=`axis-row`;let r=n.available?Math.max(0,Math.min(100,n.score)):0,i=n.note?C(n.note):n.available?``:`N/A`;t.innerHTML=`
      <span class="axis-label">${s[n.axis]??n.axis}</span>
      <span class="axis-bar"><span class="axis-fill" style="width:${r}%"></span></span>
      <span class="axis-score">${n.available?n.score.toFixed(0):`—`}</span>
      <span class="axis-note">${k(i)}</span>
    `,e.appendChild(t)}}function E(e,t){e.innerHTML=``;for(let n of t){let t=document.createElement(`div`);t.className=`metric-cell metric-${n.axis}`;let r=s[n.axis]??n.axis,i=n.available?`${n.score.toFixed(0)}점`:`측정 불가`,a=n.note?C(n.note):n.available?`측정 근거 수집됨`:`데이터 부족`;t.innerHTML=`
      <span class="metric-label">${k(r)}</span>
      <strong class="metric-score">${k(i)}</strong>
      <span class="metric-note">${k(a)}</span>
    `,e.appendChild(t)}}function ee(e,t,n,r){if(t.innerHTML=``,e.hidden=n.length===0,n.length!==0)for(let e of n.slice(0,3)){let n=document.createElement(`li`);n.className=`transcript-check-item`;let i=typeof e.t_start==`number`,a=i?O(e.t_start):null;n.innerHTML=`
      <div class="transcript-check-main">
        <span class="transcript-check-phrase">"${k(e.phrase)}"</span>
        ${e.suggestion?`<span class="transcript-check-arrow">→</span><span class="transcript-check-suggestion">"${k(e.suggestion)}"</span>`:``}
      </div>
      <p>${k(e.reason)}</p>
      ${a?`<button type="button" class="transcript-check-time">${a} 확인</button>`:``}
    `,i&&n.querySelector(`.transcript-check-time`)?.addEventListener(`click`,()=>{r(Math.max(0,(e.t_start??0)-.4))}),t.appendChild(n)}}function te(e,t){e.innerHTML=``;let n=[[`brilliant`,t?.brilliant??0],[`excellent`,t?.excellent??0],[`good`,t?.good??0],[`inaccuracy`,t?.inaccuracy??0],[`mistake`,t?.mistake??0],[`blunder`,t?.blunder??0]];for(let[t,r]of n){let n=o[t],i=document.createElement(`div`);i.className=`bucket-cell`,i.innerHTML=`
      <span class="bucket-icon" style="color:${n.color}">${n.icon}</span>
      <span class="bucket-label">${n.label}</span>
      <span class="bucket-count">${r}</span>
    `,e.appendChild(i)}}function ne(e,t,n,r){for(;e.firstChild;)e.removeChild(e.firstChild);if(t.length===0&&n.length===0)return;let i=e.viewBox.baseVal?.width||800,a=e.viewBox.baseVal?.height||120,s=Math.max(t.length?t[t.length-1].t:0,n.length?n[n.length-1].t:0,1),c=e=>8+e/s*(i-16),l=e=>a-8-e/100*(a-16);if(t.length>1){let n=document.createElementNS(`http://www.w3.org/2000/svg`,`path`),r=`M ${c(t[0].t).toFixed(1)} ${l(t[0].score).toFixed(1)}`;for(let e=1;e<t.length;e++)r+=` L ${c(t[e].t).toFixed(1)} ${l(t[e].score).toFixed(1)}`;n.setAttribute(`d`,r),n.setAttribute(`class`,`timeline-line`),e.appendChild(n)}for(let t of[25,50,75]){let n=document.createElementNS(`http://www.w3.org/2000/svg`,`line`);n.setAttribute(`x1`,`8`),n.setAttribute(`x2`,String(i-8)),n.setAttribute(`y1`,String(l(t))),n.setAttribute(`y2`,String(l(t))),n.setAttribute(`class`,`timeline-grid`),e.appendChild(n)}n.forEach((n,i)=>{let a=document.createElementNS(`http://www.w3.org/2000/svg`,`circle`);a.setAttribute(`cx`,String(c(n.t)));let s=t.reduce((e,t)=>Math.abs(t.t-n.t)<Math.abs(e.t-n.t)?t:e,t[0]??{t:n.t,score:75});a.setAttribute(`cy`,String(l(s?.score??75))),a.setAttribute(`r`,`5`),a.setAttribute(`class`,`timeline-dot quality-${n.quality}`),a.setAttribute(`data-index`,String(i)),a.setAttribute(`fill`,o[n.quality].color),a.addEventListener(`click`,()=>r(i));let u=document.createElementNS(`http://www.w3.org/2000/svg`,`title`);u.textContent=`${D(n)} ${n.title}`,a.appendChild(u),e.appendChild(a)})}function D(e){let t=e.duration_s??0;return t>=1.5?`${O(e.t)}-${O(e.t+t)}`:O(e.t)}function O(e){let t=Math.floor(e/60),n=Math.floor(e%60);return`${t.toString().padStart(2,`0`)}:${n.toString().padStart(2,`0`)}`}function k(e){return e.replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`)}var A=document.getElementById(`report-title`),j=document.getElementById(`report-subtitle`),M=document.getElementById(`report-heading`),N=document.getElementById(`report-focus-line`),P=document.getElementById(`report-status`),F=document.getElementById(`review`),I=document.getElementById(`retry-link`),L=document.getElementById(`print-link`),R=document.querySelector(`[data-theme-toggle]`);function z(){let e=document.documentElement.dataset.theme||`light`;R.textContent=e===`dark`?`☀️`:`🌙`,R.setAttribute(`aria-label`,e===`dark`?`라이트 모드로 전환`:`다크 모드로 전환`)}R.addEventListener(`click`,()=>{let e=(document.documentElement.dataset.theme||`light`)===`dark`?`light`:`dark`;document.documentElement.dataset.theme=e,localStorage.setItem(`speakup-theme`,e),z()}),L.addEventListener(`click`,()=>{window.print()});async function B(){z();let e=new URLSearchParams(location.search),r=e.get(`id`),i=e.get(`project`)||`오늘의 말하기 연습`,a=e.get(`goal`)||`말 속도`;if(I.href=V(e,i,a),A.textContent=i,M.textContent=i,N.textContent=`${a} 중심으로 분석한 코칭 결과입니다.`,!r){H(`연결된 리포트가 없습니다. 연습을 완료하면 이 화면에 결과가 표시됩니다.`,!0);return}let o=await n(r);if(!o){H(`저장된 리포트를 찾지 못했습니다. 브라우저 저장소가 비워졌을 수 있습니다.`,!0);return}let s=o.report;j.textContent=`${new Date(o.createdAt).toLocaleString(`ko-KR`,{month:`2-digit`,day:`2-digit`,hour:`2-digit`,minute:`2-digit`})} 코칭`,N.textContent=`${o.goal||a} 중심 · 종합 ${s.accuracy_overall.toFixed(1)}점 · 순간 ${s.annotated_moments?.length??0}개`,t(o.landmarks??[]);let c=document.createElement(`video`);c.src=URL.createObjectURL(o.videoBlob),c.preload=`metadata`,F.hidden=!1,P.hidden=!0,p(s,c,F)}function V(e,t,n){let r=new URL(`practice.html`,location.href);r.searchParams.set(`project`,t),r.searchParams.set(`goal`,n);for(let t of[`type`,`scenario`]){let n=e.get(t);n&&r.searchParams.set(t,n)}return r.toString()}function H(e,t=!1){P.hidden=!1,P.textContent=e,P.classList.toggle(`is-error`,t)}B().catch(e=>{console.error(`[report] failed`,e),H(`리포트 로딩 실패: ${e instanceof Error?e.message:String(e)}`,!0)});