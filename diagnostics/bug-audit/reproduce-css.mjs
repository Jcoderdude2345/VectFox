import fs from 'node:fs';
import path from 'node:path';
import {parse} from '@babel/parser';
import {chromium} from '@playwright/test';
import {JSDOM} from 'jsdom';
import {icons} from '../../ui/icons.js';
const root=path.resolve(import.meta.dirname,'../..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
function extract(file,name){const src=read(file);const n=parse(src,{sourceType:'module'}).program.body.find(n=>(n.type==='FunctionDeclaration'?n:n.declaration)?.id?.name===name);return src.slice(n.start,n.end).replace(/^export /,'');}
function shell(file,name){let html='';new Function('$','icons','bindBrowserEvents',extract(file,name)+`;${name}();`)(()=>({append:s=>{html=s}}),icons,()=>{});return html;}
function css(file){return read(file).replace(/@import\s+url\(['"]([^'"]+)['"]\);/g,(_,p)=>css(path.posix.normalize(path.posix.join(path.posix.dirname(file),p))));}
function pageRow(){
 const methods=['buildPageRow','formatBytes'].map(n=>extract('ui/wiki-library.js',n)).join('\n');
 const doc=new JSDOM('').window.document;
 function $(html){const t=doc.createElement('template');t.innerHTML=html;const el=t.content.firstElementChild;const api={el,prop(k,v){el[k]=v;return api},on(){return api},addClass(v){el.classList.add(v);return api},attr(k,v){el.setAttribute(k,v);return api},text(v){el.textContent=v;return api},html(v){el.innerHTML=v;return api},append(v){el.append(v.el);return api}};return api;}
 return new Function('$','libraryState',methods+';return buildPageRow({key:"test",title:"Example page",url:"https://example.invalid",categories:["Characters introduced in Season One","Recurring supporting characters","Residents of the Northern Kingdom"],sizeBytes:12345,contentFetched:false}).el.outerHTML;')($,{selected:new Set(),basketKeys:new Set()});
}
const styles=css('vectfox.css');
const base=':root{--SmartThemeBodyColor:#ddd;--SmartThemeBlurTintColor:#20232a;--SmartThemeBorderColor:#555;--SmartThemeQuoteColor:#f89c50;--SmartThemeFontColor:#eee;} body{margin:0;font-family:Arial,sans-serif;} *{box-sizing:border-box;}';
const browser=await chromium.launch({channel:'msedge',headless:true});const results=[];
try{
for(const [kind,file,name] of [['database','ui/database-browser.js','createBrowserModal'],['wiki','ui/wiki-library.js','createLibraryModal']]){
 for(const width of [1440,769,768,641,390,320]){
  const page=await browser.newPage({viewport:{width,height:850}});
  await page.setContent(`<style>${base}${styles}</style>${shell(file,name)}`);
  await page.addStyleTag({content:'*{animation:none !important;transition:none !important;}'});
  await page.evaluate(()=>{const select=document.querySelector('#vectfox_wl_library_filter');if(select)select.innerHTML='<option>All libraries</option>';});
  const selectors=kind==='wiki'?['#vectfox_wl_close','.vectfox-wl-filter-row','#vectfox_wl_query','.vectfox-wl-mode-toggle','.vectfox-wl-row','.vectfox-wl-title','.vectfox-wl-row-actions']:['#vectfox_browser_close','.vectfox-browser-tabs','.vectfox-modal-header'];
  if(kind==='wiki')await page.locator('#vectfox_wl_pages_list').evaluate((el,html)=>{el.innerHTML=html;},pageRow());
  const metrics=await page.evaluate(selectors=>selectors.map(selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return {selector,x:r.x,right:r.right,width:r.width,height:r.height,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,outside:r.x < -1||r.right>innerWidth+1,overflow:e.scrollWidth>e.clientWidth+2};}),selectors);
  const failed=metrics.filter(m=>m.outside||(m.overflow&&m.selector!=='.vectfox-wl-title')||(m.selector==='.vectfox-wl-title'&&m.width<1));
  results.push({kind,width,failed,metrics});
  if(failed.length || (kind==='database' && width===390) || (kind==='wiki' && width===769))await page.screenshot({path:path.join(root,`diagnostics/bug-audit/${kind}-${width}-current.png`)});
  await page.close();
 }
}
}finally{await browser.close();}
fs.writeFileSync(path.join(root,`diagnostics/bug-audit/css-results-current.json`),JSON.stringify(results,null,2));
console.log(JSON.stringify(results.map(({kind,width,failed})=>({kind,width,failed})),null,2));
if(results.some(r=>r.failed.length))process.exitCode=1;
