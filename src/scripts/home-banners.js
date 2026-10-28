// Home hero slider (Armita's home-banners kit v1.0 hb.js, unchanged slider logic; scroll-reveal part not used on the site).
/* eslint-disable */
// fix: cur starts at -1 so the first set(0) marks slides 2–3 aria-hidden + tabindex=-1 (kit returned early because slide 1 is already .is-on).
(function(){
  var root=document.querySelector('.hb[data-hb]'); if(root){
  var tr=root.querySelector('.hb-track'),S=[].slice.call(tr.children),dots=[].slice.call(root.querySelectorAll('.hb-dot')),
      pb=root.querySelector('.hb-pause'),lv=root.querySelector(".hb-live"),cur=-1,t=null,
      rm=matchMedia('(prefers-reduced-motion: reduce)'),user=rm.matches,hold=false;
  function go(i,focus){i=(i+S.length)%S.length;var s=S[i];
    tr.scrollTo({left:tr.scrollLeft+s.getBoundingClientRect().left-tr.getBoundingClientRect().left,behavior:rm.matches?'auto':'smooth'});set(i);
    if(focus)s.querySelector('a,button')&&s.querySelector('a,button').focus({preventScroll:true});}
  function set(i){if(i===cur&&S[i].classList.contains('is-on'))return;cur=i;
    S.forEach(function(s,k){var on=k===i;s.classList.toggle('is-on',on);s.setAttribute('aria-hidden',on?'false':'true');
      s.querySelectorAll('a,button').forEach(function(a){a.tabIndex=on?0:-1});});
    dots.forEach(function(d,k){d.setAttribute('aria-current',k===i?'true':'false')});
    if(lv)lv.textContent='اسلاید '+(i+1).toLocaleString('fa-IR')+' از '+S.length.toLocaleString('fa-IR');}
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
  ['pointerenter','focusin','touchstart'].forEach(function(ev){root.addEventListener(ev,function(){hold=true;stop()},{passive:true})});
  ['pointerleave','focusout'].forEach(function(ev){root.addEventListener(ev,function(){hold=false;play()})});
  document.addEventListener('visibilitychange',function(){document.hidden?stop():play()});
  rm.addEventListener&&rm.addEventListener('change',function(){if(rm.matches){user=true;upd();stop()}});
  set(0);upd();play();window.__hb={go:go,get cur(){return cur},get playing(){return !!t}};}
})();
