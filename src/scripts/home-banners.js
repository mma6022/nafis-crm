// Home hero slider + scroll reveal — Armita's home-banners kit v1.0.2 hb.js (deferred slide images; the first set(0)
// applies inert + aria-hidden to slides 2–3, so the v1.0.1 site fix cur=-1 is no longer needed). The reveal is
// progressive: .rv is only hidden under html.js, which BaseLayout's <head> script sets (no JS → everything visible).
/* eslint-disable */
(function(){
  var root=document.querySelector('.hb[data-hb]'); if(root){
  var tr=root.querySelector('.hb-track'),S=[].slice.call(tr.children),dots=[].slice.call(root.querySelectorAll('.hb-dot')),
      pb=root.querySelector('.hb-pause'),lv=root.querySelector('.hb-live'),cur=0,t=null,
      rm=matchMedia('(prefers-reduced-motion: reduce)'),user=rm.matches,hold=false;
  function go(i,focus){i=(i+S.length)%S.length;var s=S[i];
    tr.scrollTo({left:tr.scrollLeft+s.getBoundingClientRect().left-tr.getBoundingClientRect().left,behavior:rm.matches?'auto':'smooth'});set(i);
    if(focus)s.querySelector('a,button')&&s.querySelector('a,button').focus({preventScroll:true});}
  // v1.0.1: non-active slides carry data-srcset/data-src; hydrate on demand so nothing is fetched early
  function hyd(k){var s=S[(k+S.length)%S.length],pc=s&&s.querySelector('picture[data-defer]');if(!pc)return;pc.removeAttribute('data-defer');
    pc.querySelectorAll('[data-srcset]').forEach(function(e){e.setAttribute('srcset',e.getAttribute('data-srcset'));e.removeAttribute('data-srcset')});
    var im=pc.querySelector('img[data-src]');if(im){im.setAttribute('src',im.getAttribute('data-src'));im.removeAttribute('data-src')}}
  function hydAll(){S.forEach(function(s,k){hyd(k)})}
  var loaded=document.readyState==='complete';
  function pre(){if(loaded&&!user)hyd(cur+1)}  // warm only the next slide, only after load, only when autoplay will show it
  var ready=false;  // v1.0.2: the first set(0) must apply aria-hidden/inert too (v1.0.1 returned early on slide 0)
  function set(i){hyd(i);if(ready&&i===cur)return;ready=true;cur=i;
    S.forEach(function(s,k){var on=k===i;s.classList.toggle('is-on',on);s.inert=!on;if(on)s.removeAttribute('aria-hidden');else s.setAttribute('aria-hidden','true');
      s.querySelectorAll('a,button').forEach(function(a){a.tabIndex=on?0:-1});});
    dots.forEach(function(d,k){d.setAttribute('aria-current',k===i?'true':'false')});
    if(lv)lv.textContent='اسلاید '+(i+1).toLocaleString('fa-IR')+' از '+S.length.toLocaleString('fa-IR');pre();}
  function play(){stop();if(!user&&!hold)t=setInterval(function(){go(cur+1)},6000);}
  function stop(){clearInterval(t);t=null;}
  function upd(){pb.setAttribute('aria-pressed',user?'true':'false');pb.setAttribute('aria-label',user?'پخش خودکار اسلایدها':'توقف اسلایدها');
    pb.querySelector('.ps').style.display=user?'none':'';pb.querySelector('.pl').style.display=user?'':'none';}
  var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting&&e.intersectionRatio>.6)set(S.indexOf(e.target))})},{root:tr,threshold:[.6]});
  S.forEach(function(s){io.observe(s)});
  dots.forEach(function(d,k){d.onclick=function(){user=true;upd();stop();go(k)}});
  root.querySelector('.hb-prev').onclick=function(){user=true;upd();stop();go(cur-1)};
  root.querySelector('.hb-next').onclick=function(){user=true;upd();stop();go(cur+1)};
  pb.onclick=function(){user=!user;upd();user?stop():play()};
  root.addEventListener('keydown',function(e){if(e.key==='ArrowLeft'){go(cur+1,1);e.preventDefault()}if(e.key==='ArrowRight'){go(cur-1,1);e.preventDefault()}});
  ['pointerenter','focusin','touchstart'].forEach(function(ev){root.addEventListener(ev,function(){hydAll();hold=true;stop()},{passive:true})});
  tr.addEventListener('wheel',hydAll,{passive:true,once:true});
  if(!loaded)addEventListener('load',function(){loaded=true;setTimeout(function(){(window.requestIdleCallback||function(f){f()})(pre)},1500)});
  ['pointerleave','focusout'].forEach(function(ev){root.addEventListener(ev,function(){hold=false;play()})});
  document.addEventListener('visibilitychange',function(){document.hidden?stop():play()});
  rm.addEventListener&&rm.addEventListener('change',function(){if(rm.matches){user=true;upd();stop()}});
  set(0);upd();play();window.__hb={go:go,get cur(){return cur},get playing(){return !!t}};}
  // scroll reveal
  var R=document.querySelectorAll('.rv');
  if(!('IntersectionObserver' in window)||matchMedia('(prefers-reduced-motion: reduce)').matches){R.forEach(function(e){e.classList.add('in')});return;}
  var ro=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');ro.unobserve(e.target)}})},{rootMargin:'0px 0px -8% 0px'});
  R.forEach(function(e){ro.observe(e)});
})();
