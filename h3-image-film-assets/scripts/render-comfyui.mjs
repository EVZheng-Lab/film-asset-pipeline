#!/usr/bin/env node
/**
 * render-comfyui.mjs —— 把出图单（出图单.json）送到一台 ComfyUI 上出图。分两个阶段，中间让人挑图。
 *
 *   ① 文生图，每张出几个候选，生成挑图网页：
 *      node render-comfyui.mjs <出图单.json> <图片目录> --server http://<主机>:8188 --stage t2i [--n 4]
 *   ② 人挑图：用户双击打开 <图片目录>/候选/挑图.html，每个资产选一张，点「复制选择」，回对话里粘贴。
 *      粘贴的是一行一个 "<tag> <第几张>"（0 = 都不要，重抽；重抽的可以带 "意见：…"），原样交给 --pick：
 *      node render-comfyui.mjs <出图单.json> <图片目录> --pick "<粘贴的文字>"
 *      （--pick 也接受一个 JSON 文件：{ "@loc_gongyuan": 3 }。用户在对话里直接说"公园选 3"也行，你照着写。）
 *      重抽的那几张，旧候选挪进 候选/弃用/；带了意见的记进 候选/意见.jsonl。先按意见改设计或提示词，
 *      再换个 --seed 跑一次 ① 只补出它们，再让用户挑一次。
 *   ③ 编辑（带参考图的），都拿选中的那张当参考：
 *      node render-comfyui.mjs <出图单.json> <图片目录> --server http://<主机>:8188 --stage edit
 *
 *   不加 --stage 就一口气全出、每张一个（不挑图）。
 *
 *   --n N            文生图每张出几个候选，默认 4（种子 seed、seed+1 …）
 *   --seed N         起始种子，默认 42；重抽时换一个（如 100）
 *   --only a,b       只出这几个 tag（逗号分隔，带不带 @ 都行）
 *   --unet / --clip / --vae   模型文件名，默认是官方 ComfyUI 模板的文件名，装的不一样就改
 *   --names 盘点.json   挑图网页上显示剧本里的名字；不写就找出图单同目录下的 盘点.json，找不到只显示 tag
 *
 * 文件：选定的图是 <图片目录>/<tag 去掉 @>.png（@char_lin → char_lin.png），副导演的 attach-images.mjs 按文件夹挂回网页；
 * 候选在 <图片目录>/候选/<tag>_<k>.png，预览 JPEG 在 候选/预览/。已经存在的都跳过，断了重跑会接着出。
 * 带参考图的：参考图先缩到约 400 万像素（32 的倍数，保持比例）再送进去，输出按出图单的 size。
 * 工作流是官方 H3-Image 模板的参数：6 步 / CFG 1 / euler / simple。需要 node 18+、ffmpeg、ffprobe。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const WF_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'comfyui');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const S = opt('server', process.env.COMFY);
const seed0 = +opt('seed', 42);
const N = +opt('n', 4);
const stage = opt('stage', '');
const pick = opt('pick', '');
const namesPath = opt('names', '');
const only = opt('only', '');
const UNET = opt('unet', 'minimax_h3_image_pruned_int8_convrot.safetensors');
const CLIP = opt('clip', 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors');
const VAE = opt('vae', 'minimax_h3_image_vae_fp16.safetensors');
const [planPath, outDir] = argv;
if (!planPath || !outDir || (!S && !pick) || (stage && !['t2i', 'edit'].includes(stage))) {
  console.error('用法：node render-comfyui.mjs <出图单.json> <图片目录> --server http://<主机>:8188 [--stage t2i|edit] [--n 4] [--seed 42]\n' +
    '      node render-comfyui.mjs <出图单.json> <图片目录> --pick "<挑图网页复制的文字>"');
  process.exit(2);
}
const PLAN = JSON.parse(fs.readFileSync(planPath, 'utf8'));
/* tag → 剧本里的名字：在盘点里找所有带 tag 和 name 的条目（场景、变体、角色、服装、状态、道具、特效） */
const NAMES = {};
try {
  const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') {
    if (typeof o.tag === 'string' && typeof o.name === 'string') NAMES[o.tag] = o.name;
    Object.values(o).forEach(walk); } };
  walk(JSON.parse(fs.readFileSync(namesPath || path.join(path.dirname(planPath), '盘点.json'), 'utf8')));
} catch (e) { if (namesPath) throw e; }
delete PLAN._note;
delete PLAN._design;
const CAND = path.join(outDir, '候选'), PREV = path.join(CAND, '预览');
fs.mkdirSync(outDir, { recursive: true });
const base = (tag) => tag.replace(/^@/, '');
const file = (tag) => path.join(outDir, base(tag) + '.png');
const cand = (tag, k) => path.join(CAND, `${base(tag)}_${k}.png`);
const want = new Set(only.split(',').filter(Boolean).map((t) => (t.startsWith('@') ? t : '@' + t)));
const isT2I = (tag) => !(PLAN[tag].refImage || []).length;

/* ---------- ② 挑图：把选中的候选拷成正式的图 ---------- */
if (pick) {
  /* 文件就按 JSON 读；否则按挑图网页复制出来的文字读：一行一个 "<tag> <数字>" */
  const P = {}, NOTE = {};
  if (fs.existsSync(pick)) Object.assign(P, JSON.parse(fs.readFileSync(pick, 'utf8')));
  else for (const line of pick.split(/\r?\n/)) {
    const m = line.match(/^\s*(@?[a-z][a-z0-9_]*)\s*[:：=]?\s*(\d+)\s*(?:意见[:：]?)?\s*(.*)$/);
    if (m) { P[m[1]] = +m[2]; if (m[3].trim()) NOTE[m[1].startsWith('@') ? m[1] : '@' + m[1]] = m[3].trim(); }
  }
  if (!Object.keys(P).length) { console.error('--pick 里没读到选择。格式：一行一个 "<tag> <第几张>"'); process.exit(2); }
  let ok = 0, re = 0;
  for (const [t, k] of Object.entries(P)) {
    const tag = t.startsWith('@') ? t : '@' + t;
    if (!PLAN[tag]) { console.log(`✗ ${tag} 不在出图单里`); continue; }
    if (+k === 0) {
      /* 不删：挪进 候选/弃用/，留着对照；文件名带时间，重抽几轮都不会撞 */
      const OLD = path.join(CAND, '弃用'), stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      fs.mkdirSync(OLD, { recursive: true });
      const isCand = (f) => new RegExp('^' + base(tag) + '_\\d+\\.(png|jpg)$').test(f);
      for (const f of fs.readdirSync(CAND)) if (isCand(f)) fs.renameSync(path.join(CAND, f), path.join(OLD, f.replace(/\.png$/, `_${stamp}.png`)));
      for (const f of fs.existsSync(PREV) ? fs.readdirSync(PREV) : []) if (isCand(f)) fs.renameSync(path.join(PREV, f), path.join(OLD, f.replace(/\.jpg$/, `_${stamp}.jpg`)));
      if (fs.readdirSync(CAND).some(isCand)) { console.log(`✗ ${tag} 旧候选没挪走（网盘同步占用？），先手动挪开再重抽`); continue; }
      re++; console.log(`↻ ${tag} 重抽：旧候选挪进 候选/弃用/，换个 --seed 再跑 --stage t2i`); continue;
    }
    if (!fs.existsSync(cand(tag, k))) { console.log(`✗ ${tag} 没有第 ${k} 张候选`); continue; }
    fs.copyFileSync(cand(tag, k), file(tag)); ok++;
  }
  /* 用户写的修改意见：记进 候选/意见.jsonl，并打印出来 —— 按意见改设计或提示词之后再重抽，光换种子出来还是差不多 */
  if (Object.keys(NOTE).length) {
    fs.mkdirSync(CAND, { recursive: true });
    for (const [tag, note] of Object.entries(NOTE)) {
      fs.appendFileSync(path.join(CAND, '意见.jsonl'), JSON.stringify({ time: new Date().toISOString(), tag, pick: P[tag] ?? P[base(tag)], note }) + '\n');
      console.log(`✎ ${tag} 意见：${note}`);
    }
    console.log('有意见的先改：设计没想到改设计稿，想到了没画出来改提示词，再换 --seed 重抽。');
  }
  const left = Object.keys(PLAN).filter((t) => isT2I(t) && !fs.existsSync(file(t)));
  console.log(`选定 ${ok} 张，重抽 ${re} 张。` + (left.length ? `还没选的文生图：${left.join(' ')}` : '文生图都选好了，可以跑 --stage edit。'));
  process.exit(0);
}

/* 依赖排序：被参考的先出 */
const order = [], seen = new Set();
const visit = (t) => { if (seen.has(t) || !PLAN[t]) return; seen.add(t); (PLAN[t].refImage || []).forEach(visit); order.push(t); };
Object.keys(PLAN).forEach(visit);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ref-'));
function to4mp(src, dst) {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src])
    .toString().trim().split(',').map(Number);
  const k = Math.sqrt((2048 * 2048) / (w * h));
  const W = Math.max(32, Math.round((w * k) / 32) * 32), H = Math.max(32, Math.round((h * k) / 32) * 32);
  execFileSync('ffmpeg', ['-threads', '2', '-loglevel', 'error', '-y', '-i', src, '-vf', `scale=${W}:${H}:flags=area`, dst]);
}

async function render(tag, seed, dest) {
  const p = PLAN[tag];
  const [W, H] = String(p.size || '2048x2048').split('x').map(Number);
  /* 工作流就是仓库 comfyui/ 下的两个 API 文件 —— 想在 ComfyUI 里手动跑，打开同一份 */
  const refs0 = p.refImage || [];
  const wf = JSON.parse(fs.readFileSync(path.join(WF_DIR, refs0.length ? 'h3_edit.api.json' : 'h3_t2i.api.json'), 'utf8'));
  wf[1].inputs.unet_name = UNET; wf[2].inputs.clip_name = CLIP; wf[3].inputs.vae_name = VAE;
  Object.assign(wf[5].inputs, { prompt: p.prompt, width: W, height: H });
  wf[7].inputs.seed = seed;
  wf[9].inputs.filename_prefix = 'h3/' + base(tag);
  delete wf[100]; delete wf[5].inputs['images.image_1'];
  const refs = refs0;
  if (refs.length) {
    for (const [i, r] of refs.entries()) {
      if (!fs.existsSync(file(r))) throw new Error(`参考图 ${r} 还没出或还没选（${file(r)}）`);
      const small = path.join(tmp, `${base(tag)}_ref${i + 1}.png`);
      to4mp(file(r), small);
      const fd = new FormData();
      fd.append('image', new Blob([fs.readFileSync(small)]), path.basename(small)); fd.append('overwrite', 'true');
      const up = await (await fetch(S + '/upload/image', { method: 'POST', body: fd })).json();
      wf[100 + i] = { class_type: 'LoadImage', inputs: { image: up.name } };
      wf[5].inputs[`images.image_${i + 1}`] = [String(100 + i), 0];
    }
  }
  const r = await (await fetch(S + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf }) })).json();
  if (!r.prompt_id) throw new Error('提交失败：' + JSON.stringify(r).slice(0, 600));
  for (;;) {
    await new Promise((s) => setTimeout(s, 5000));
    const h = (await (await fetch(`${S}/history/${r.prompt_id}`)).json())[r.prompt_id];
    if (!h) continue;
    const st = h.status || {};
    if (st.status_str === 'error') throw new Error('出图失败：' + JSON.stringify((st.messages || []).find((m) => m[0] === 'execution_error')?.[1] || st).slice(0, 600));
    const imgs = h.outputs?.['9']?.images || [];
    if (!imgs.length) continue;
    const f = imgs[0];
    fs.writeFileSync(dest, Buffer.from(await (await fetch(`${S}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder)}&type=output`)).arrayBuffer()));
    return;
  }
}

/* 挑图网页：每个文生图资产一行候选，点图看大图，点「选这张」；「复制选择」复制一行一个 "<tag> <第几张>"，回对话粘贴 */
function buildPickPage() {
  fs.mkdirSync(PREV, { recursive: true });
  const rows = [];
  for (const tag of order.filter(isT2I)) {
    const ks = [];
    for (let k = 1; k <= 99; k++) {
      if (!fs.existsSync(cand(tag, k))) { if (k > N) break; continue; }
      const pv = path.join(PREV, `${base(tag)}_${k}.jpg`);
      if (!fs.existsSync(pv)) execFileSync('ffmpeg', ['-threads', '2', '-loglevel', 'error', '-y', '-i', cand(tag, k), '-vf', 'scale=1600:-2:flags=area', '-q:v', '4', pv]);
      ks.push(k);
    }
    /* v = 这组候选的版本（各候选文件的生成时间）。重抽后候选换了，v 就变，浏览器里存的旧选择自动作废 */
    const v = ks.map((k) => Math.round(fs.statSync(cand(tag, k)).mtimeMs).toString(36)).join('.');
    if (ks.length) rows.push({ tag, name: (NAMES[tag] || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), size: PLAN[tag].size || '', ks, v, chosen: fs.existsSync(file(tag)) });
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>挑图</title><style>
:root{--bg:#0f1113;--panel:#171a1d;--panel2:#1d2125;--border:#2a2f35;--text:#e5e7eb;--dim:#9ca3af;--accent:#c8975a;--ok:#4ade80}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
.bar{position:sticky;top:0;z-index:5;display:flex;gap:16px;align-items:center;padding:12px 24px;background:var(--panel);border-bottom:1px solid var(--border)}
.bar b{color:var(--accent)} #cnt{color:var(--dim)} .wrap{padding:16px 24px}
button{font:inherit;cursor:pointer}
.exp{margin-left:auto;background:var(--accent);color:#111;border:0;border-radius:6px;height:40px;padding:0 18px;font-weight:600}
.row{margin-bottom:22px} .hd{margin-bottom:8px} .hd .nm{font-size:16px;margin-right:10px} .hd code{color:var(--dim);font-size:12px} .hd span{color:var(--dim);margin-left:8px;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.c{border:2px solid var(--border);border-radius:8px;background:var(--panel2);overflow:hidden}
.c img{display:block;width:100%;cursor:zoom-in}
.c .act{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;color:var(--dim)}
.c .act button{background:transparent;border:1px solid var(--border);color:var(--accent);border-radius:4px;padding:3px 12px}
.c.on{border-color:var(--accent)} .c.on .act button{background:var(--accent);color:#111}
.re{background:transparent;border:1px solid var(--border);color:var(--dim);border-radius:4px;padding:2px 10px;margin-left:10px}
.re.on{border-color:#f87171;color:#f87171}
.note{display:none;width:100%;box-sizing:border-box;margin-top:8px;min-height:56px;resize:vertical;background:var(--panel2);color:var(--text);border:1px solid #f87171;border-radius:6px;padding:8px 10px;font:inherit}
.row.redo .note{display:block}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center;cursor:zoom-out;z-index:9}
#msg{color:#4ade80}
.exp:disabled{opacity:.5;cursor:default}
#flt{display:flex;gap:6px} #flt button{background:transparent;border:1px solid var(--border);color:var(--dim);border-radius:4px;padding:3px 12px}
#flt button.on{border-color:var(--accent);color:var(--accent)}
.row[hidden]{display:none}
#lb.on{display:flex} #lb img{max-width:96vw;max-height:96vh;cursor:zoom-in}
#lb.full{display:block;overflow:auto} #lb.full img{max-width:none;max-height:none;cursor:zoom-out}
#lb .tip{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);color:var(--dim);font-size:12px;pointer-events:none}
</style></head><body>
<div class="bar"><b>挑图</b><span id="flt"><button type="button" data-f="todo"></button><button type="button" data-f="done"></button><button type="button" data-f="all"></button></span><span id="msg"></span><button class="exp" id="exp">复制选择</button></div>
<div class="wrap" id="w"></div><div id="lb"><img alt=""><span class="tip"></span></div>
<script>
var R=${JSON.stringify(rows)};var S={},N={};
var w=document.getElementById('w'),lb=document.getElementById('lb');
R.forEach(function(r){
  var d=document.createElement('div');d.className='row';
  d.innerHTML='<div class="hd">'+(r.name?'<b class="nm">'+r.name+'</b>':'')+'<code>${''}'+r.tag+'</code><span>'+r.size+(r.chosen?' · 已选过，再选会覆盖':'')+'</span><button class="re" type="button">都不要，重抽</button></div><div class="grid"></div><textarea class="note" placeholder="哪里不满意、想要什么样（会跟着选择一起复制）"></textarea>';
  var g=d.querySelector('.grid');
  r.ks.forEach(function(k){
    var c=document.createElement('div');c.className='c';
    c.innerHTML='<img loading="lazy" src="预览/'+r.tag.replace(/^@/,'')+'_'+k+'.jpg" alt="'+r.tag+' 候选 '+k+'"><div class="act"><span>'+k+'</span><button type="button">选这张</button></div>';
    c.querySelector('img').onclick=function(){open(this.src,r.tag.replace(/^@/,'')+'_'+k+'.png')};
    c.querySelector('button').onclick=function(){S[r.tag]=k;sync()};
    g.appendChild(c);
  });
  d.querySelector('.re').onclick=function(){S[r.tag]=S[r.tag]===0?undefined:0;sync();if(S[r.tag]===0)d.querySelector('.note').focus()};
  d.querySelector('.note').oninput=function(){N[r.tag]=this.value;sync()};
  d._r=r;w.appendChild(d);
});
function sync(){
  [].forEach.call(w.children,function(d){var v=S[d._r.tag];
    [].forEach.call(d.querySelectorAll('.c'),function(c,i){c.classList.toggle('on',v===d._r.ks[i])});
    d.querySelector('.re').classList.toggle('on',v===0);d.classList.toggle('redo',v===0);
    var nt=d.querySelector('.note');if(nt.value!==(N[d._r.tag]||''))nt.value=N[d._r.tag]||''});
  var todo=R.filter(pending).length;
  [].forEach.call(document.querySelectorAll('#flt button'),function(b){var f=b.getAttribute('data-f');
    b.classList.toggle('on',f===F);b.textContent=FL[f]+' '+(f==='all'?R.length:f==='todo'?todo:R.length-todo)});
}
/* 待选 = 这次没点、以前也没选定过的。筛选只在点按钮、打开网页时生效，选完一个不会立刻从眼前消失 */
function pending(r){return S[r.tag]===undefined&&!r.chosen}
var F='all',FL={todo:'待选',done:'已选',all:'全部'};
function filt(f){F=f;[].forEach.call(w.children,function(d){var p=pending(d._r);d.hidden=f==='todo'?!p:f==='done'?p:false});sync();scrollTo(0,0)}
document.getElementById('flt').onclick=function(e){var f=e.target.getAttribute&&e.target.getAttribute('data-f');if(f)filt(f)};
/* 先显示预览，原图（16MP）读完再换上；点图切换 1:1，点黑底关闭 */
var lbi=lb.querySelector('img'), tip=lb.querySelector('.tip'), seq=0;
function open(pv,orig){var n=++seq;lbi.src=pv;tip.textContent='原图加载中…';lb.classList.remove('full');lb.classList.add('on');
  var im=new Image();im.onload=function(){if(n!==seq)return;lbi.src=orig;tip.textContent='原图 '+im.naturalWidth+'×'+im.naturalHeight+'，点图看 1:1'};
  im.onerror=function(){if(n===seq)tip.textContent='原图读不到，显示的是预览'};im.src=orig}
function close(){seq++;lb.classList.remove('on','full')}
lbi.onclick=function(e){e.stopPropagation();lb.classList.toggle('full')};
lb.onclick=close;
document.addEventListener('keydown',function(e){if(e.key==='Escape')close()});
var exp=document.getElementById('exp'), msg=document.getElementById('msg');
/* 选择存在本机浏览器里，关掉再开还在；复制出去的是一行一个 "<tag> <第几张>"，回对话里粘贴 */
var KEY='pick:'+location.pathname;
/* 存的是 {选择, 版本}；候选重出过（版本变了）的那几个，旧选择不恢复 */
try{ var st=JSON.parse(localStorage.getItem(KEY)||'{}'), sv=st.v||{};
  R.forEach(function(r){ if(st.s&&st.s[r.tag]!==undefined&&sv[r.tag]===r.v){S[r.tag]=st.s[r.tag];if(st.n&&st.n[r.tag])N[r.tag]=st.n[r.tag]} }) }catch(e){}
var _sync=sync; sync=function(){ _sync();
  var v={}; R.forEach(function(r){v[r.tag]=r.v});
  try{ localStorage.setItem(KEY, JSON.stringify({s:S, n:N, v:v})) }catch(e){} };
exp.onclick=function(){
  var n=Object.keys(S).filter(function(k){return S[k]!==undefined}).length, todo=R.filter(pending).length;
  if(!n){msg.textContent='这次还没选任何一张';return}
  if(todo&&!confirm('还有 '+todo+' 个没选，没选的不会往下出图。照样复制？'))return;
  var t=R.filter(function(r){return S[r.tag]!==undefined}).map(function(r){var n=S[r.tag]===0&&N[r.tag]?String(N[r.tag]).replace(/\\s+/g,' ').trim():'';return r.tag+' '+S[r.tag]+(n?' 意见：'+n:'')}).join(String.fromCharCode(10));
  var ok=function(){msg.textContent='已复制 '+n+' 条，回到对话里粘贴就行'};
  var fall=function(){var ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();
    var done=false;try{done=document.execCommand('copy')}catch(e){}ta.remove();
    if(done)ok();else window.prompt('复制失败，请手动复制这段文字：',t)};
  if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok,fall); else fall();
};
filt(R.some(pending)?'todo':'all');
</script></body></html>`;
  fs.writeFileSync(path.join(CAND, '挑图.html'), html, 'utf8');
  return rows.length;
}

let ok = 0, skip = 0, fail = 0;
for (const tag of order) {
  if (want.size && !want.has(tag)) continue;
  const t2i = isT2I(tag);
  if (stage === 'edit' && t2i) continue;
  if (stage === 't2i' && !t2i) continue;
  if (fs.existsSync(file(tag))) { skip++; continue; }
  const jobs = stage === 't2i' ? Array.from({ length: N }, (_, i) => [seed0 + i, cand(tag, i + 1)]) : [[seed0, file(tag)]];
  if (stage === 't2i') fs.mkdirSync(CAND, { recursive: true });
  for (const [sd, dest] of jobs) {
    if (fs.existsSync(dest)) { skip++; continue; }
    const t0 = Date.now();
    try { await render(tag, sd, dest); ok++; console.log(`✓ ${tag}  种子 ${sd}  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${PLAN[tag].size || ''}${t2i ? '' : '  参考 ' + PLAN[tag].refImage.join(' ')}`); }
    catch (e) { fail++; console.log(`✗ ${tag}  ${e.message}`); if (!t2i) break; }
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`完成：出了 ${ok} 张，跳过已有 ${skip} 张，失败 ${fail} 张 → ${path.resolve(outDir)}`);
if (stage === 't2i') {
  const n = buildPickPage();
  console.log(`挑图网页：${path.resolve(CAND, '挑图.html')}（${n} 个资产）。用户双击打开、选完点「复制选择」回对话粘贴；你把那段文字交给 --pick，再 --stage edit。`);
}
process.exit(fail ? 1 : 0);
