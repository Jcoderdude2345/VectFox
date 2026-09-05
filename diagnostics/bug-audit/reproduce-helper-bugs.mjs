import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {parse} from '@babel/parser';
const root=path.resolve(import.meta.dirname,'../..');
function extract(file,name){const src=fs.readFileSync(path.join(root,file),'utf8');const node=parse(src,{sourceType:'module'}).program.body.map(n=>n.declaration||n).find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);return src.slice(node.start,node.end);}
const mode=process.argv.includes('--probe')?'probe':'baseline';const results=[];
let hintSource=extract('core/eventbase-extractor.js','_inferLanguageHint');
if(mode==='probe')hintSource=hintSource.replace(' + hangul + hiragana',' + hangul');
const hint=new Function(hintSource+';return _inferLanguageHint;')();
const actual=hint('あabcdefghij');
try{assert.equal(actual,null);results.push({case:'1.9 kana counted once',pass:true,actual});}catch{results.push({case:'1.9 kana counted once',pass:false,expected:null,actual});}
let cleanupSource=extract('core/collection-loader.js','cleanupCorruptedCollections');
if(mode==='probe')cleanupSource=cleanupSource.replace('backend: target.backend,',"backend: target.backend === 'standard' ? 'vectra' : target.backend,");
const filter=extract('core/collection-loader.js','getCollectionFilterReason');
for(const backend of ['standard',undefined,'vectra','qdrant']){
 const calls=[];const fetch=async(url,options)=>{calls.push({url,body:options?.body?JSON.parse(options.body):null});return {ok:true,json:async()=>({success:true,collections:[{id:'file_1',backend,source:'transformers'}]})};};
 await new Function('fetch','getRequestHeaders','unregisterCollection','log',filter+'\n'+cleanupSource+';return cleanupCorruptedCollections();')(fetch,()=>({}),()=>{},new Proxy({},{get:()=>()=>{}}));
 const payload=calls.find(c=>c.body)?.body;const expected=backend==='qdrant'?'qdrant':'vectra';results.push({case:'1.10 cleanup request backend',input:backend??'(missing)',expected,actual:payload?.backend,pass:payload?.backend===expected});
}
console.log(JSON.stringify(results,null,2));
fs.writeFileSync(path.join(root,`diagnostics/bug-audit/helper-results-${mode}.json`),JSON.stringify(results,null,2));
if(results.some(r=>!r.pass))process.exitCode=1;
