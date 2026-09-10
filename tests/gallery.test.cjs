const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('gallery/app.js', 'utf8');
function harness({ query = '', saved, response, environment = {} } = {}) {
  const requests = [];
  const storage = new Map(saved || []);
  const context = vm.createContext({
    URL, URLSearchParams, Date, console,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { location: { search: query, href: `https://example.com/gallery/months/${query}` }, history: { replaceState() {} } },
    document: { body: { dataset: { galleryDomain: 'https://media.example.com', galleryMode: 'months' } }, addEventListener() {} },
    fetch: async (url, options) => { requests.push({url, options}); return response; },
    ...environment
  });
  vm.runInContext(source.replace('  document.addEventListener("DOMContentLoaded"', '  window.testing = { getInitialMonth, getMonthItems, fetchManifest, rememberMonth, buildMediaMarkup, createVideoPreviews };\n  document.addEventListener("DOMContentLoaded"'), context);
  return { ...context.window.testing, requests, storage };
}
const session = { claims: { iss: 'issuer', sub: 'parent' }, tokens: { id_token: 'test-token' } };
const manifest = {collection:'months', user:{canUpload:true}, photos:[{key:'months/0/first.jpg'},{key:'months/11/last.jpg'}],heroPhotos:[{key:'months/hero/2/cover.jpg'}]};
test('deep links are one-based, bounded, and override saved month', () => {
  assert.equal(harness({ query:'?month=12' }).getInitialMonth(manifest, session),11);
  assert.equal(harness({ query:'?month=60' }).getInitialMonth(manifest, session),59);
  assert.equal(harness({ query:'?month=0' }).getInitialMonth(manifest, session),11);
  assert.equal(harness({ query:'?month=61' }).getInitialMonth(manifest, session),11);
  assert.equal(harness({ query:'?month=abc' }).getInitialMonth(manifest, session),11);
});
test('selection is account scoped; a new account starts at latest populated month', () => {
  const h = harness({saved:[['lilly.album.month.issuer:parent','4']]});
  assert.equal(h.getInitialMonth(manifest, session),4);
  assert.equal(h.getInitialMonth(manifest,{claims:{iss:'issuer',sub:'another'}}),11);
  assert.equal(h.getInitialMonth({photos:[],heroPhotos:[]},session),4);
  assert.equal(harness().getInitialMonth({photos:[],heroPhotos:[]},session),0);
});
test('selected month includes legacy covers and excludes other-month photos', () => {
  const h = harness();
  assert.deepEqual(Array.from(h.getMonthItems({manifest},2), p=>p.key),['months/hero/2/cover.jpg']);
  assert.deepEqual(Array.from(h.getMonthItems({manifest},0), p=>p.key),['months/0/first.jpg']);
  assert.equal(h.getMonthItems({manifest},1).length,0);
});
test('new page requests fresh authorization even with a legacy cached manifest', async () => {
  const h=harness({saved:[['everyday-lilly.gallery-manifest.months',JSON.stringify({timestamp:Date.now(),manifest})]],response:{ok:false,status:403,json:async()=>({})}});
  await assert.rejects(h.fetchManifest(session),error=>error.status===403);
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].options.headers.Authorization,'Bearer test-token');
});
test('metadata refresh does not bust media versions', async () => {
  const h=harness({response:{ok:true,json:async()=>manifest}});
  await h.fetchManifest(session);
  assert.equal(h.requests[0].url,'https://media.example.com/api/gallery/manifest');
  assert.equal(h.requests[0].options.cache,'no-store');
});
test('malformed success payload fails closed', async () => {
  const h=harness({response:{ok:true,json:async()=>({collection:'months',photos:[]})}});
  await assert.rejects(h.fetchManifest(session));
});
test('video tiles defer media requests until the preview loader observes them', () => {
  const markup=harness().buildMediaMarkup({kind:'movie',url:'https://media.example.com/private.mp4'},'Movie',false);
  assert.doesNotMatch(markup,/<video|autoplay/);
  assert.match(markup,/data-video-preview="https:\/\/media.example.com\/private.mp4"/);
});
test('auth clearing removes legacy gallery caches and preserves only month preference', () => {
  const storage={ 'everydayLillyAuth:session':'old', 'everyday-lilly.gallery-manifest.months':'private', 'everyday-lilly.gallery-refresh.months':'old-version', 'lilly.album.month.issuer:parent':'4' };
  Object.defineProperty(storage,'removeItem',{enumerable:false,value:key=>delete storage[key]});
  const context=vm.createContext({window:{},localStorage:storage,sessionStorage:{removeItem(){}}});
  vm.runInContext(fs.readFileSync('auth/auth.js','utf8'),context);
  context.window.EverydayLillyAuth.clearSession();
  assert.deepEqual(Object.keys(storage),['lilly.album.month.issuer:parent']);
});

function previewHarness() {
  const videos = [], observers = [], timers = new Set();
  const document = {
    addEventListener() {},
    createElement(tag) {
      if (tag === 'canvas') return { setAttribute() {}, getContext: () => ({drawImage() {}}) };
      const video = { readyState: 2, videoWidth: 1920, videoHeight: 1080, duration: 5, currentTime: 0,
        load() {}, pause() {}, removeAttribute(key) { delete this[key]; } };
      videos.push(video);
      return video;
    }
  };
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    unobserve() {}
    disconnect() { this.disconnected = true; }
  }
  const preview = harness({environment:{ document, IntersectionObserver,
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout(callback) { timers.delete(callback); }
  }}).createVideoPreviews();
  function shell(url) {
    return { isConnected: true, dataset: {videoPreview:url}, label:{}, canvases:[],
      classList: { add() {} }, prepend(canvas) { this.canvases.push(canvas); },
      querySelector() { return this.label; } };
  }
  function mount(shells) { preview.mount({querySelectorAll:()=>shells}); }
  function visible(shells) { observers.at(-1).callback(shells.map(target=>({target,isIntersecting:true}))); }
  function decoded(video) { video.onloadedmetadata(); video.onseeked(); }
  return { preview, videos, observers, timers, shell, mount, visible, decoded };
}

test('previews wait for visibility, cap decoding at two, and release each source', () => {
  const h=previewHarness(), shells=['a','b','c'].map(h.shell);
  h.mount(shells);
  assert.equal(h.videos.length,0);
  h.visible(shells);
  assert.equal(h.videos.length,2);
  h.decoded(h.videos[0]);
  assert.equal(h.videos[0].src,undefined);
  assert.equal(h.videos.length,3);
  assert.equal(shells[0].canvases[0].width,480);
  assert.equal(shells[0].canvases[0].height,270);
  assert.equal(h.videos[0].currentTime,0.1);
  h.preview.reset(true);
  assert.equal(h.timers.size,0);
  assert.ok(h.videos.every(video=>!video.src));
});

test('month revisits reuse frames; clearing the account cache requires decoding again', () => {
  const h=previewHarness(), first=h.shell('same-signed-url');
  h.mount([first]); h.visible([first]); h.decoded(h.videos[0]);
  h.preview.reset();
  const revisit=h.shell('same-signed-url'); h.mount([revisit]);
  assert.equal(revisit.canvases.length,1);
  assert.equal(h.videos.length,1);
  h.preview.reset(true);
  const nextAccount=h.shell('same-signed-url'); h.mount([nextAccount]);
  assert.equal(nextAccount.canvases.length,0);
  h.visible([nextAccount]);
  assert.equal(h.videos.length,2);
  h.preview.reset(true);
});

test('unreadable or stalled videos show a fallback and allow the queue to continue', () => {
  const h=previewHarness(), shells=['bad','slow','next'].map(h.shell);
  h.mount(shells); h.visible(shells);
  h.videos[0].onerror();
  assert.equal(shells[0].label.textContent,'Отвори видеото');
  assert.equal(h.videos.length,3);
  const timeout=[...h.timers][0]; timeout();
  assert.equal(shells[1].label.textContent,'Отвори видеото');
  h.preview.reset(true);
  assert.equal(h.timers.size,0);
});
