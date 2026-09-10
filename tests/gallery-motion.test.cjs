const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the animation with browser events and a deterministic frame clock.
function scene({reduced = false, index = 0} = {}) {
  let now = 0, id = 0, observer;
  const pending = new Map();
  const element = () => Object.assign(new EventTarget(), {
    classList: {values:new Set(), add(v){this.values.add(v)}, remove(v){this.values.delete(v)},
      toggle(v,on){on ? this.add(v) : this.remove(v)}, contains(v){return this.values.has(v)}},
    setAttribute(name,value){this[name]=value}
  });
  const frames = Array.from({length:3},(_,i)=>Object.assign(element(),{offsetLeft:i*92}));
  const track = Object.assign(element(),{position:0,querySelectorAll:()=>frames});
  // Some browsers round scroll offsets; the animation must retain sub-pixel progress.
  Object.defineProperty(track,'scrollLeft',{get(){return this.position},set(v){this.position=Math.round(v)}});
  const toggle = Object.assign(element(),{firstElementChild:{textContent:''}});
  const prev = element(), next = element(), wheel = element();
  wheel.querySelector = selector => selector === '.growth-track' ? track : selector === '[data-growth-toggle]' ? toggle : selector.includes('-1') ? prev : next;
  wheel.querySelectorAll = () => [prev,next];
  const document = Object.assign(element(),{activeElement:null,hidden:false,viewerOpen:false,addEventListener:EventTarget.prototype.addEventListener,
    querySelector(){return this.viewerOpen ? {} : null}});
  wheel.contains = node => [track,toggle,prev,next,...frames].includes(node);
  const motion = Object.assign(element(),{matches:reduced});
  const window = Object.assign(element(),{matchMedia:()=>motion});
  const context = vm.createContext({window,document,AbortController,Event,URL,URLSearchParams,console,
    performance:{now:()=>now},queueMicrotask,
    requestAnimationFrame:callback=>{pending.set(++id,callback);return id},cancelAnimationFrame:key=>pending.delete(key),
    setTimeout:()=>++id,clearTimeout(){},
    IntersectionObserver:class {constructor(callback){observer=this;this.callback=callback}observe(){this.show(1)}show(ratio){this.callback([{intersectionRatio:ratio}])}disconnect(){}}
  });
  const source=fs.readFileSync('gallery/app.js','utf8').replace('  document.addEventListener("DOMContentLoaded"','  window.setup = setupGrowthWheel;\n  document.addEventListener("DOMContentLoaded"');
  vm.runInContext(source,context);
  const state={growthIndex:index,uploading:false,uploadQueue:[]};
  const stop=window.setup({querySelector:()=>wheel},state);
  function tick(count=1){for(let n=0;n<count;n++){now+=16;const callbacks=[...pending.values()];pending.clear();callbacks.forEach(fn=>fn(now));}}
  return {state,track,toggle,wheel,window,document,motion,pending,observer,stop,tick};
}

test('wheel glides despite rounded scroll positions and explicit pause stops it',()=>{
  const s=scene();s.tick(30);
  assert.ok(s.track.scrollLeft>8);
  s.toggle.dispatchEvent(new Event('click'));
  const paused=s.track.scrollLeft;s.tick(30);
  assert.equal(s.track.scrollLeft,paused);
  assert.equal(s.pending.size,0);
  s.stop();
});
test('offscreen/viewer pauses resume safely and disposed wheels cannot restart',async()=>{
  const s=scene();s.observer.show(0);assert.equal(s.pending.size,0);
  s.observer.show(1);assert.equal(s.pending.size,1);
  s.document.viewerOpen=true;s.window.dispatchEvent(new Event('lilly:viewer-change'));assert.equal(s.pending.size,0);
  s.document.viewerOpen=false;s.window.dispatchEvent(new Event('lilly:viewer-change'));assert.equal(s.pending.size,1);
  s.wheel.dispatchEvent(new Event('focusout'));s.stop();await Promise.resolve();
  assert.equal(s.pending.size,0);
});
test('reduced-motion preference prevents autoplay and stops an already running wheel',()=>{
  const reduced=scene({reduced:true});assert.equal(reduced.pending.size,0);assert.equal(reduced.toggle.hidden,true);reduced.stop();
  const s=scene();s.motion.matches=true;s.motion.dispatchEvent(new Event('change'));
  assert.equal(s.pending.size,0);assert.equal(s.state.growthPlaying,false);s.stop();
});
test('last photo rests then reverses without jumping to the beginning',()=>{
  const s=scene({index:2});s.tick(100);assert.equal(s.track.scrollLeft,184);
  s.tick(40);assert.ok(s.track.scrollLeft<184 && s.track.scrollLeft>160);
  assert.equal(s.state.growthDirection,-1);s.stop();
});
test('keyboard exploration waits for an explicit play before restarting',()=>{
  const s=scene();s.document.activeElement=s.track;s.wheel.dispatchEvent(new Event('focusin'));
  assert.equal(s.state.growthPlaying,false);assert.equal(s.pending.size,0);
  s.document.activeElement=s.toggle;s.toggle.dispatchEvent(new Event('click'));
  assert.equal(s.state.growthPlaying,true);assert.equal(s.pending.size,1);s.stop();
});
