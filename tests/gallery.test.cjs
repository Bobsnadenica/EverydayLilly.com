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
  vm.runInContext(source.replace('  document.addEventListener("DOMContentLoaded"', '  window.testing = { getInitialMonth, getMonthItems, fetchManifest, rememberMonth, buildMediaMarkup, getGrowthPhotos, renderMonthDetail };\n  document.addEventListener("DOMContentLoaded"'), context);
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
test('video tiles use stored image previews without decoding video in the grid', () => {
  const markup=harness().buildMediaMarkup({kind:'movie',url:'https://media.example.com/private.mp4',thumbnailUrl:'https://media.example.com/preview.jpg'},'Movie',false);
  assert.doesNotMatch(markup,/<video|autoplay/);
  assert.match(markup,/src="https:\/\/media.example.com\/preview.jpg"/);
  assert.doesNotMatch(markup,/src="https:\/\/media.example.com\/private.mp4"/);
});
test('auth clearing removes legacy gallery caches and preserves only month preference', () => {
  const storage={ 'everydayLillyAuth:session':'old', 'everyday-lilly.gallery-manifest.months':'private', 'everyday-lilly.gallery-refresh.months':'old-version', 'lilly.album.month.issuer:parent':'4' };
  Object.defineProperty(storage,'removeItem',{enumerable:false,value:key=>delete storage[key]});
  const context=vm.createContext({window:{},localStorage:storage,sessionStorage:{removeItem(){}}});
  vm.runInContext(fs.readFileSync('auth/auth.js','utf8'),context);
  context.window.EverydayLillyAuth.clearSession();
  assert.deepEqual(Object.keys(storage),['lilly.album.month.issuer:parent']);
});


test('growth wheel is chronological across months and excludes videos and duplicates', () => {
  const h=harness();
  const state={manifest:{photos:[{key:'months/4/new.jpg'},{key:'months/0/old.jpg'},{key:'months/1/video.mov',kind:'movie'},{key:'months/0/old.jpg'}],heroPhotos:[]}};
  assert.deepEqual(Array.from(h.getGrowthPhotos(state),x=>x.month),[0,4]);
});
test('dated backup filenames sort by day taken even when uploaded in reverse order', () => {
  const h = harness();
  const photos = [
    {key:'months/0/2025-06-08.jpg',lastModified:'2026-09-01'},
    {key:'months/0/2025-06-01.jpg',lastModified:'2026-09-02'}
  ];
  assert.deepEqual(Array.from(h.getGrowthPhotos({manifest:{photos,heroPhotos:[]}}), x=>x.photo.key),
    ['months/0/2025-06-01.jpg','months/0/2025-06-08.jpg']);
});
test('photo tiles prefer small previews while original URLs remain available to the viewer', () => {
  const html=harness().buildMediaMarkup({url:'https://media.example.com/full.jpg',thumbnailUrl:'https://media.example.com/small.jpg'},'Photo',false);
  assert.match(html,/src="https:\/\/media.example.com\/small.jpg"/);
  assert.match(html,/loading="lazy"/);
});
test('empty month buttons remain selectable with an explicit accessible empty state', () => {
  const h=harness({environment:{document:{addEventListener(){},getElementById(){return null;}}}});
  const content={};
  h.renderMonthDetail(content,{manifest,selectedMonth:0,actualCollection:'months',uploadQueue:[],uploading:false});
  assert.match(content.innerHTML,/class="month-tab is-empty" data-month-trigger="1"[^>]*aria-label="Месец 2, няма снимки"/);
  assert.doesNotMatch(content.innerHTML,/data-month-trigger="1"[^>]*disabled/);
});
