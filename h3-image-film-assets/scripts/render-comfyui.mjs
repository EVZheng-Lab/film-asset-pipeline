#!/usr/bin/env node
/**
 * render-comfyui.mjs —— 把出图单（出图单.json）送到一台 ComfyUI 上出图。
 *
 *   node render-comfyui.mjs <出图单.json> <输出目录> --server http://<主机>:8188 [选项]
 *
 *   --seed N         种子，默认 42（同一张图重出时换种子）
 *   --only a,b       只出这几个 tag（逗号分隔，带不带 @ 都行）
 *   --unet / --clip / --vae   模型文件名，默认是本仓库作者跑图机上的文件名，按自己的改
 *
 * 做的事：
 * - 按参考图依赖排顺序：被参考的先出（脸图 → 服装，主场景 → 变体）。
 * - 文件名 = tag 去掉 @ 加 .png（@char_lin → char_lin.png）。已经存在就跳过，断了重跑会接着出。
 * - 带参考图的：参考图先缩到约 400 万像素（32 的倍数，保持比例）再送进去，输出按出图单的 size。
 *   参考图必须是已经出好的那张（在输出目录里），没有就报错跳过。
 * - 工作流是官方 H3-Image 模板的参数：6 步 / CFG 1 / euler / simple。ComfyUI 存图时会把提示词写进 PNG，
 *   所以出完可以直接用副导演的 attach-images.mjs 按文件夹挂回网页。
 * 需要 node 18+ 和 ffmpeg（缩参考图）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const S = opt('server', process.env.COMFY);
const seed = +opt('seed', 42);
const only = opt('only', '');
const UNET = opt('unet', 'minimax_h3_image_pruned_int8_convrot.safetensors');
const CLIP = opt('clip', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors');
const VAE = opt('vae', 'minimax_h3_image_vae_fp16.safetensors');
const [planPath, outDir] = argv;
if (!planPath || !outDir || !S) {
  console.error('用法：node render-comfyui.mjs <出图单.json> <输出目录> --server http://<主机>:8188 [--seed 42] [--only tag1,tag2]');
  process.exit(2);
}
const PLAN = JSON.parse(fs.readFileSync(planPath, 'utf8'));
delete PLAN._note;
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ref-'));
const file = (tag) => path.join(outDir, tag.replace(/^@/, '') + '.png');
const want = new Set(only.split(',').filter(Boolean).map((t) => (t.startsWith('@') ? t : '@' + t)));

// 依赖排序
const order = [], seen = new Set();
const visit = (t) => {
  if (seen.has(t) || !PLAN[t]) return; seen.add(t);
  (PLAN[t].refImage || []).forEach(visit);
  order.push(t);
};
Object.keys(PLAN).forEach(visit);

function to4mp(src, dst) {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src]).toString().trim();
  const [w, h] = probe.split(',').map(Number);
  const k = Math.sqrt((2048 * 2048) / (w * h));
  const W = Math.max(32, Math.round((w * k) / 32) * 32), H = Math.max(32, Math.round((h * k) / 32) * 32);
  execFileSync('ffmpeg', ['-threads', '2', '-loglevel', 'error', '-y', '-i', src, '-vf', `scale=${W}:${H}:flags=area`, dst]);
}

async function render(tag) {
  const p = PLAN[tag];
  const [W, H] = String(p.size || '2048x2048').split('x').map(Number);
  const wf = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: UNET, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: CLIP, type: 'minimax', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: VAE } },
    5: { class_type: 'MiniMaxH3ImageConditioning', inputs: { clip: ['2', 0], prompt: p.prompt, width: W, height: H } },
    6: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['5', 0] } },
    7: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['5', 1], seed, steps: 6, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'h3/' + tag.replace(/^@/, '') } },
  };
  const refs = p.refImage || [];
  if (refs.length) {
    wf[5].inputs.vae = ['3', 0];
    for (const [i, r] of refs.entries()) {
      if (!fs.existsSync(file(r))) throw new Error(`参考图 ${r} 还没出（${file(r)}）`);
      const small = path.join(tmp, `${tag.replace(/^@/, '')}_ref${i + 1}.png`);
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
    const buf = Buffer.from(await (await fetch(`${S}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder)}&type=output`)).arrayBuffer());
    fs.writeFileSync(file(tag), buf);
    return;
  }
}

let ok = 0, skip = 0, fail = 0;
for (const tag of order) {
  if (want.size && !want.has(tag)) continue;
  if (fs.existsSync(file(tag))) { skip++; continue; }
  const t0 = Date.now();
  try { await render(tag); ok++; console.log(`✓ ${tag}  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${PLAN[tag].size || ''}${PLAN[tag].refImage ? '  参考 ' + PLAN[tag].refImage.join(' ') : ''}`); }
  catch (e) { fail++; console.log(`✗ ${tag}  ${e.message}`); }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`完成：出了 ${ok} 张，跳过已有 ${skip} 张，失败 ${fail} 张 → ${path.resolve(outDir)}`);
process.exit(fail ? 1 : 0);
