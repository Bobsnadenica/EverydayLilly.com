const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const vm = require('node:vm');
const path = require('node:path');
const {fileURLToPath} = require('node:url');
const source = fs.readFileSync('app/backend/live/prod/lambda/gallery_manifest/index.mjs', 'utf8');
const privateKey = crypto.generateKeyPairSync('rsa', {modulusLength:1024}).privateKey.export({type:'pkcs8',format:'pem'});
function backend() {
  const original={Key:'months/0/video.mov',ETag:'"abc123"',Size:123,LastModified:new Date('2025-05-10')};
  const hash=crypto.createHash('sha256').update('months/0/video.mov\nabc123').digest('hex');
  const requests=[];
  class ListObjectsV2Command {constructor(input){this.input=input;}}
  class S3Client {async send(command){requests.push(command.input);return {Contents:command.input.Prefix==='months/'?[original]:[{Key:`previews/months/${hash}.jpg`,Size:12,ETag:'"thumb"'}]};}}
  const context=vm.createContext({S3Client,ListObjectsV2Command,HeadObjectCommand:class {},crypto,path,fileURLToPath,fs:{readFileSync:()=>privateKey},process:{env:{GALLERY_BUCKET:'private-test',GALLERY_PUBLIC_BASE_URL:'https://media.example.com',GALLERY_SIGNER_KEY_PAIR_ID:'test-key'}},URL,console,Buffer});
  vm.runInContext(source.replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify('file:///test/index.mjs')).replace(/^export /gm,'')+'\nglobalThis.api={handler,thumbnailKey};',context);
  return {...context.api,requests,hash};
}
test('manifest signs a separate preview URL without adding derived images to photo counts',async()=>{
  const h=backend();
  const result=await h.handler({requestContext:{http:{method:'GET',path:'/api/gallery/manifest'},authorizer:{jwt:{claims:{token_use:'id','cognito:groups':['admin']}}}}});
  assert.equal(result.statusCode,200);
  const body=JSON.parse(result.body);
  assert.equal(body.photos.length,1);
  assert.equal(body.photos[0].kind,'movie');
  assert.equal(new URL(body.photos[0].thumbnailUrl).pathname,`/previews/months/${h.hash}.jpg`);
  assert.equal(new URL(body.photos[0].url).pathname,'/months/0/video.mov');
  assert.deepEqual(h.requests.map(r=>r.Prefix),['months/','previews/months/']);
});
test('unassigned accounts cannot list originals or previews',async()=>{
  const h=backend();
  const result=await h.handler({requestContext:{authorizer:{jwt:{claims:{token_use:'id'}}}}});
  assert.equal(result.statusCode,403);
  assert.equal(h.requests.length,0);
});
test('a replaced original receives a different immutable preview key',()=>{
  const h=backend();
  assert.notEqual(h.thumbnailKey({key:'months/0/video.mov',etag:'one'},'months'),h.thumbnailKey({key:'months/0/video.mov',etag:'two'},'months'));
});
