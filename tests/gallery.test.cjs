const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('gallery/app.js', 'utf8');
function harness({ query = '', saved, response } = {}) {
  const requests = [];
  const storage = new Map(saved || []);
  const context = vm.createContext({
    URL, URLSearchParams, Date, console,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { location: { search: query, href: `https://example.com/gallery/months/${query}` }, history: { replaceState() {} } },
    document: { body: { dataset: { galleryDomain: 'https://media.example.com', galleryMode: 'months' } }, addEventListener() {} },
    fetch: async (url, options) => { requests.push({url, options}); return response; }
  });
  vm.runInContext(source.replace('  document.addEventListener("DOMContentLoaded"', '  window.testing = { getInitialMonth, getMonthItems, fetchManifest, rememberMonth, buildMediaMarkup };\n  document.addEventListener("DOMContentLoaded"'), context);
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
test('video tiles never fetch or autoplay original videos', () => {
  const markup=harness().buildMediaMarkup({kind:'movie',url:'https://media.example.com/private.mp4'},'Movie',false);
  assert.doesNotMatch(markup,/\bsrc=|autoplay/);
  assert.match(markup,/preload="none"/);
});
test('auth clearing removes legacy gallery caches and preserves only month preference', () => {
  const storage={ 'everydayLillyAuth:session':'old', 'everyday-lilly.gallery-manifest.months':'private', 'everyday-lilly.gallery-refresh.months':'old-version', 'lilly.album.month.issuer:parent':'4' };
  Object.defineProperty(storage,'removeItem',{enumerable:false,value:key=>delete storage[key]});
  const context=vm.createContext({window:{},localStorage:storage,sessionStorage:{removeItem(){}}});
  vm.runInContext(fs.readFileSync('auth/auth.js','utf8'),context);
  context.window.EverydayLillyAuth.clearSession();
  assert.deepEqual(Object.keys(storage),['lilly.album.month.issuer:parent']);
});
