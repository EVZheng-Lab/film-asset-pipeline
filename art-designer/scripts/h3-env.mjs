#!/usr/bin/env node
/**
 * 出图环境：查这台电脑（或用户给的 ComfyUI 地址）能不能跑 H3-Image，缺什么就装什么。
 *
 *   node h3-env.mjs check [--server http://<主机>:8188] [--json] [--mock 情况.json]
 *      不给 --server：查本机 —— 显卡、显存、驱动、内存、磁盘、ffmpeg，本机有没有在跑的 ComfyUI（8188 / 8000 端口），
 *      各盘根目录和桌面、文档、下载下面有没有装过 ComfyUI，版本够不够（要有 MiniMaxH3ImageConditioning 节点，v0.45.0 起），三个模型在不在。
 *      给了 --server（云端或局域网里另一台）：只查那台的节点和模型，本机硬件不算。
 *      最后一行给结论（verdict），--json 时整份输出 JSON。--mock 用一份 JSON 顶替探测结果，测试用。
 *
 *   node h3-env.mjs setup --dir <装在哪> (--new | --update) [--port 8188] [--start] [--dry-run] [--mock 情况.json]
 *      --new     在 <装在哪> 新装一份便携版 ComfyUI（Windows，NVIDIA）。用户原来那份不动。
 *      --update  把 <装在哪> 这份便携版原地更新到新版（先备份代码到 ComfyUI_备份_<旧版本>\，models / custom_nodes / 输入输出不动）。
 *      两种都会补齐缺的模型、没有 ffmpeg 就下一份放进 <装在哪>\_tools\。--start 装完把 ComfyUI 起起来并等它能连上。
 *      --dry-run 只列要做什么、下多少、从哪下，不下载不改文件。--no-models 不下模型（测安装流程用）。
 *      断了重跑会接着下（curl 续传）。国内源：ComfyUI 本体走 GitHub 加速（先测哪个快），模型走 ModelScope，pip 走阿里云源。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';

const COMFY_MIN = 'v0.45.0';                 // MiniMaxH3ImageConditioning 从这一版开始有
const COMFY_PIN = 'v0.46.0';                 // 装的时候用这一版
const H3_NODE = 'MiniMaxH3ImageConditioning';
const MS = 'https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3-Image/resolve/master/';
const MODELS = [
  { kind: 'unet', loader: 'UNETLoader', input: 'unet_name', dir: 'diffusion_models', file: 'minimax_h3_image_pruned_int8_convrot.safetensors', gb: 21.0 },
  { kind: 'clip', loader: 'CLIPLoader', input: 'clip_name', dir: 'text_encoders', file: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors', gb: 27.1,
    alt: ['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'] },
  { kind: 'vae', loader: 'VAELoader', input: 'vae_name', dir: 'vae', file: 'minimax_h3_image_vae_fp16.safetensors', gb: 1.2 },
];
const GH_MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/', ''];
// 清华、中科大源缺 ComfyUI 的模板素材包（comfyui-workflow-templates-media-assets-*），用阿里云，不行再换
const PIP_INDEXES = ['https://mirrors.aliyun.com/pypi/simple', 'https://mirrors.cloud.tencent.com/pypi/simple', 'https://pypi.org/simple'];
const NPM_REG = 'https://registry.npmmirror.com';
const FFMPEG_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const PORTABLE_GB = 2.1, PORTABLE_UNPACKED_GB = 6;
// 用 Windows 自带的 bsdtar：Git Bash 里的 GNU tar 会把 H:\ 当成远程主机
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const cmd = argv.shift();
const flag = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const MOCK = opt('mock', '');
const mock = MOCK ? JSON.parse(fs.readFileSync(MOCK, 'utf8')) : null;

const sh = (f, a, o = {}) => { try { return execFileSync(f, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, ...o }).trim(); } catch { return null; } };
const gbOf = (n) => Math.round(n / 1e9 * 10) / 10;

async function getJson(url, ms = 4000) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
}

/* ---------- 探测 ---------- */
function probeGpu() {
  const out = sh('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (out) {
    const [name, mem, driver] = out.split('\n')[0].split(',').map((s) => s.trim());
    return { vendor: 'nvidia', name, vramGB: Math.round(+mem / 1024), driver };
  }
  const other = process.platform === 'win32'
    ? sh('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name -join "; "']) : null;
  return other ? { vendor: 'other', name: other, vramGB: 0, driver: '' } : null;
}

function drives() {
  if (process.platform !== 'win32') return ['/'];
  return 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => d + ':\\').filter((d) => fs.existsSync(d));
}
function freeGB(p) { try { const s = fs.statfsSync(p); return gbOf(s.bavail * s.bsize); } catch { return null; } }

/** 一个目录是不是 ComfyUI：便携版根目录（下面有 ComfyUI\main.py 和 python_embeded）或 ComfyUI 代码目录本身 */
function asInstall(dir) {
  const portable = fs.existsSync(path.join(dir, 'ComfyUI', 'main.py'));
  const code = portable ? path.join(dir, 'ComfyUI') : fs.existsSync(path.join(dir, 'main.py')) && fs.existsSync(path.join(dir, 'comfy')) ? dir : null;
  if (!code) return null;
  const vf = path.join(code, 'comfyui_version.py');
  const version = fs.existsSync(vf) ? (fs.readFileSync(vf, 'utf8').match(/__version__\s*=\s*"([^"]+)"/) || [])[1] || '?' : '?';
  let h3Node = false;
  const ex = path.join(code, 'comfy_extras');
  if (fs.existsSync(ex)) h3Node = fs.readdirSync(ex).some((f) => /minimax/i.test(f) && fs.readFileSync(path.join(ex, f), 'utf8').includes(H3_NODE));
  const models = {};
  for (const m of MODELS) models[m.kind] = findModel(path.join(code, 'models', m.dir), [m.file, ...(m.alt || [])]);
  return { dir, code, portable: portable && fs.existsSync(path.join(dir, 'python_embeded')), version, h3Node, models };
}
function findModel(root, names, depth = 2) {
  if (!fs.existsSync(root)) return null;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isFile() && names.includes(e.name)) return e.name;
    if (e.isDirectory() && depth > 0) { const r = findModel(path.join(root, e.name), names, depth - 1); if (r) return path.join(e.name, r).replace(/\\/g, '/'); }
  }
  return null;
}
function findInstalls() {
  const roots = drives();
  const home = os.homedir();
  roots.push(...['Desktop', 'Documents', 'Downloads'].map((d) => path.join(home, d)).filter((d) => fs.existsSync(d)));
  const seen = new Set(), found = [];
  const tryDir = (d) => { if (seen.has(d)) return; seen.add(d); const i = asInstall(d); if (i) { found.push(i); seen.add(i.code); } };
  for (const r of roots) {
    let ents; try { ents = fs.readdirSync(r, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || !/comfy|秋叶|绘世|sd-?webui|aigc/i.test(e.name)) continue;
      const d = path.join(r, e.name);
      tryDir(d);
      try { for (const s of fs.readdirSync(d, { withFileTypes: true })) if (s.isDirectory() && /comfy/i.test(s.name)) tryDir(path.join(d, s.name)); } catch {}
    }
  }
  return found;
}

async function probeServer(url, remote) {
  const stats = await getJson(url + '/system_stats');
  if (!stats) return { url, remote, ok: false };
  const node = await getJson(url + '/object_info/' + H3_NODE);
  const models = {};
  for (const m of MODELS) {
    const info = await getJson(url + '/object_info/' + m.loader);
    const list = info?.[m.loader]?.input?.required?.[m.input]?.[0] || [];
    models[m.kind] = list.find((f) => [m.file, ...(m.alt || [])].includes(path.basename(f.replace(/\\/g, '/')))) || null;
  }
  const dev = stats.devices?.[0];
  return { url, remote, ok: true, version: stats.system?.comfyui_version || '?', h3Node: !!(node && node[H3_NODE]), models,
    gpu: dev ? { name: dev.name, vramGB: Math.round((dev.vram_total || 0) / 2 ** 30) } : null };
}

async function gather(server) {
  if (mock) return mock;
  if (server) return { remote: true, server: await probeServer(server.replace(/\/$/, ''), true) };
  const f = { remote: false, os: process.platform, node: process.version, gpu: probeGpu(), ramGB: Math.round(os.totalmem() / 2 ** 30),
    disks: drives().map((d) => ({ drive: d, freeGB: freeGB(d) })),
    ffmpeg: !!sh('ffmpeg', ['-version']) && !!sh('ffprobe', ['-version']),
    installs: findInstalls(), server: null };
  for (const p of [8188, 8000]) { const s = await probeServer('http://127.0.0.1:' + p, false); if (s.ok) { f.server = s; break; } }
  return f;
}

/* ---------- 结论 ---------- */
const missingOf = (models) => MODELS.filter((m) => !models?.[m.kind]);
const clipArg = (models) => models?.clip && path.basename(models.clip) !== MODELS[1].file ? ` --clip ${path.basename(models.clip)}` : '';

/** 驱动够不够、该装哪个便携版：cu130 版要 580 起，cu126 版要 560 起 */
function buildFor(driver) {
  const v = parseFloat(driver);
  if (v >= 580) return { asset: 'ComfyUI_windows_portable_nvidia.7z', cuda: '13.0' };
  if (v >= 560) return { asset: 'ComfyUI_windows_portable_nvidia_cu126.7z', cuda: '12.6' };
  return null;
}

function judge(f) {
  const say = [], warn = [];
  if (f.remote) {
    const s = f.server;
    if (!s?.ok) return { verdict: 'remote_unreachable', say: [`连不上 ${s?.url}：确认那台机器上 ComfyUI 开着，启动参数带了 --listen 0.0.0.0，防火墙放行了端口。`], warn };
    say.push(`${s.url}：ComfyUI ${s.version}${s.gpu ? `，${s.gpu.name} ${s.gpu.vramGB}GB` : ''}`);
    if (!s.h3Node) return { verdict: 'remote_old', say: [...say, `版本太旧，没有 H3-Image 节点，要在那台机器上更新到 ${COMFY_MIN} 以上。`], warn };
    const miss = missingOf(s.models);
    if (miss.length) return { verdict: 'remote_models_missing', say: [...say, '那台机器缺模型（要放在那台的 ComfyUI\\models 下面）：',
      ...miss.map((m) => `  models/${m.dir}/${m.file}（${m.gb}GB）  ${MS}${m.dir}/${m.file}`)], warn };
    return { verdict: 'ready', server: s.url, renderArgs: `--server ${s.url}${clipArg(s.models)}`, say: [...say, '节点和三个模型都在，可以出图。'], warn };
  }

  const g = f.gpu;
  say.push(`显卡：${g ? `${g.name}${g.vendor === 'nvidia' ? `，${g.vramGB}GB 显存，驱动 ${g.driver}` : ''}` : '没找到独立显卡'}；内存 ${f.ramGB}GB`);
  const why = [];
  if (!g || g.vendor !== 'nvidia') why.push('没有 NVIDIA 显卡（H3-Image 只在 NVIDIA 卡上测过）');
  else if (g.vramGB < 12) why.push(`显存 ${g.vramGB}GB，至少要 12GB`);
  if (f.ramGB < 32) why.push(`内存 ${f.ramGB}GB，至少要 32GB`);
  if (why.length) return { verdict: 'prompts_only', say: [...say, '这台电脑跑不了 H3-Image：' + why.join('；') + '。'], warn };
  if (g.vramGB < 16) warn.push(`显存 ${g.vramGB}GB：16GB 实测能跑，12GB 没用真卡测过，大概率能跑、会慢。`);
  if (f.ramGB < 64) warn.push(`内存 ${f.ramGB}GB：出 16MP 大图时 ComfyUI 会多占约 36GB 内存，64GB 比较稳，${f.ramGB}GB 可能会卡。`);

  const s = f.server;
  if (s?.ok && s.h3Node && !missingOf(s.models).length)
    return { verdict: 'ready', server: s.url, renderArgs: `--server ${s.url}${clipArg(s.models)}`, say: [...say, `本机 ComfyUI ${s.version} 开着（${s.url}），节点和三个模型都在，可以出图。`], warn };

  const build = process.platform === 'win32' || f.os === 'win32' ? buildFor(g.driver) : null;
  const installs = f.installs || [];
  const good = installs.find((i) => i.h3Node && !missingOf(i.models).length);
  if (good) return { verdict: 'start', dir: good.dir, say: [...say, `${good.dir} 装好了（${good.version}），只是没开。setup --dir "${good.dir}" --update --start 会直接起起来（不用下载）。`], warn };

  const newer = installs.find((i) => i.h3Node);
  if (newer) {
    const miss = missingOf(newer.models);
    return { verdict: 'models_missing', dir: newer.dir, missGB: gbOf(miss.reduce((a, m) => a + m.gb, 0) * 1e9),
      say: [...say, `${newer.dir}（${newer.version}）版本够，缺模型：${miss.map((m) => `${m.file}（${m.gb}GB）`).join('、')}。`], warn };
  }
  if (!build) return { verdict: 'driver_old', say: [...say, `显卡驱动 ${g.driver} 太旧（至少 560），请用户去 NVIDIA 官网或 GeForce Experience 更新驱动、重启后再来。`], warn };

  const allGB = gbOf(MODELS.reduce((a, m) => a + m.gb, 0) * 1e9);
  const vkey = (v) => String(v).split('.').map((n) => String(+n || 0).padStart(4, '0')).join('.');
  const old = installs.filter((i) => !i.h3Node).sort((a, b) => vkey(b.version).localeCompare(vkey(a.version)));
  if (old.length) {
    const o = old[0];
    return { verdict: 'old_comfy', dir: o.dir, portable: o.portable, build: build.asset, say: [...say,
      `找到 ComfyUI：${old.map((i) => `${i.dir}（${i.version}${i.portable ? '，便携版' : ''}）`).join('、')}，版本太旧，没有 H3-Image 节点（要 ${COMFY_MIN} 以上）。`,
      '问用户：原地更新，还是在新位置另装一份？',
      o.portable ? `  原地更新：ComfyUI 本体 + 模型约 ${allGB}GB。代码先备份；装过的插件可能有的跟新版不兼容，原来的工作流可能跑不起来。`
        : '  原地更新：这份不是官方便携版（秋叶整合包 / git 装的 / 桌面版），脚本不支持原地更新，只能另装。',
      `  另装一份：便携版约 ${PORTABLE_GB}GB（解压后约 ${PORTABLE_UNPACKED_GB}GB）+ 模型约 ${allGB}GB，原来那份完全不动。`], warn };
  }
  return { verdict: 'need_install', build: build.asset, say: [...say, `没找到 ComfyUI。要新装：便携版约 ${PORTABLE_GB}GB（解压后约 ${PORTABLE_UNPACKED_GB}GB）+ 模型约 ${allGB}GB。`], warn };
}

const NEXT = {
  ready: '照常出图，render-comfyui.mjs 带上 renderArgs。',
  start: '跑 setup --update --start 把它起起来，再 check 一次。',
  models_missing: '跟用户说一次要下多少，确认后跑 setup --dir <那份> --update（只补模型，版本够就不动代码）。',
  old_comfy: '把两个选项原样问用户，用户选了再跑 setup。',
  need_install: '跟用户说一次装在哪个盘、要下多少、大概多久，确认后跑 setup --new。',
  driver_old: '驱动不由 agent 装。这次先只出提示词，告诉用户更新驱动后可以再出图。',
  prompts_only: '只出提示词，最后告诉用户：没找到能直接跑图的机器，提示词已经给你了，剩下的要靠你自己出图。',
  disk_full: '把要多少空间告诉用户，等用户腾出来再 check；这次先只出提示词。',
  remote_unreachable: '把原因告诉用户，等用户处理好再 check；用户放弃就只出提示词。',
  remote_old: '那台机器不由 agent 装，告诉用户怎么处理；这次先只出提示词。',
  remote_models_missing: '同上，把缺的模型和下载地址给用户。',
};

async function check() {
  const server = opt('server', '');
  const asJson = flag('json');
  const f = await gather(server);
  const r = judge(f);
  if (!f.remote && f.ffmpeg === false && ['ready', 'start', 'models_missing', 'old_comfy', 'need_install'].includes(r.verdict))
    r.warn.push('没装 ffmpeg / ffprobe（出图和挂图要用）：setup 会顺手下一份。');
  if (!f.remote && f.disks) {
    const best = [...f.disks].sort((a, b) => (b.freeGB || 0) - (a.freeGB || 0))[0];
    r.disks = f.disks; r.suggestDrive = best?.drive;
    r.say.push('磁盘剩余：' + f.disks.map((d) => `${d.drive.replace(/\\$/, '')} ${d.freeGB}GB`).join('，') + '。');
    const allGB = MODELS.reduce((a, m) => a + m.gb, 0);
    const need = { need_install: allGB + PORTABLE_UNPACKED_GB, old_comfy: allGB + PORTABLE_UNPACKED_GB, models_missing: r.missGB }[r.verdict];
    if (need) {
      r.needGB = Math.ceil(need + 5);
      // 补模型只能放进那份 ComfyUI 所在的盘
      const at = r.verdict === 'models_missing' ? f.disks.find((d) => d.drive.toUpperCase() === path.parse(r.dir).root.toUpperCase()) : best;
      const where = at?.drive.replace(/\\$/, '');
      if ((at?.freeGB || 0) < r.needGB) { r.warn.push(`要约 ${r.needGB}GB 空间，${r.verdict === 'models_missing' ? `${where} 盘不够` : '哪个盘都不够'}。请用户先腾出空间；腾不出来这次就只出提示词。`); r.verdict = 'disk_full'; }
      else r.say.push(r.verdict === 'models_missing' ? `要约 ${r.needGB}GB 空间，${where} 盘够。` : `要约 ${r.needGB}GB 空间，剩得最多的是 ${where} 盘。`);
    }
  }
  r.next = NEXT[r.verdict];
  if (asJson) { console.log(JSON.stringify({ ...r, facts: f }, null, 2)); return; }
  for (const l of r.say) console.log(l);
  for (const w of r.warn) console.log('⚠ ' + w);
  console.log(`\nverdict: ${r.verdict}${r.renderArgs ? `   renderArgs: ${r.renderArgs}` : ''}\n下一步：${r.next}`);
}

/* ---------- 安装 ---------- */
const run = (f, a, o = {}) => new Promise((res, rej) => {
  const p = spawn(f, a, { stdio: 'inherit', ...o });
  p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${path.basename(f)} 退出码 ${c}`))));
  p.on('error', rej);
});

async function pickMirror(url, dry) {
  if (dry) return GH_MIRRORS[0];
  let best = null;
  for (const m of GH_MIRRORS) {
    const out = sh('curl', ['-s', '-L', '-m', '12', '-r', '0-4000000', '-o', os.devNull, '-w', '%{http_code} %{speed_download}', m + url]);
    const [code, speed] = (out || '0 0').split(' ').map(Number);
    console.log(`  测速 ${m || '直连 GitHub'}：${code === 200 || code === 206 ? (speed / 1e6).toFixed(1) + 'MB/s' : '不通'}`);
    if ((code === 200 || code === 206) && (!best || speed > best.speed)) best = { m, speed };
  }
  if (!best) throw new Error('GitHub 和几个加速地址都连不上，检查网络后重跑');
  return best.m;
}

/** curl 续传下载到 .part，完了再改名；每 30 秒报一次进度 */
async function download(url, dest, totalBytes) {
  if (fs.existsSync(dest)) { console.log(`  已有 ${path.basename(dest)}，跳过`); return; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const t = setInterval(() => {
    const n = fs.existsSync(part) ? fs.statSync(part).size : 0;
    console.log(`  ${path.basename(dest)}：${gbOf(n)}GB${totalBytes ? ` / ${gbOf(totalBytes)}GB（${Math.round(n / totalBytes * 100)}%）` : ''}`);
  }, 30000);
  try { await run('curl', ['-L', '-sS', '--fail', '--retry', '20', '--retry-delay', '5', '--retry-all-errors', '-C', '-', '-o', part, url], { stdio: ['ignore', 'ignore', 'inherit'] }); }
  finally { clearInterval(t); }
  if (totalBytes && fs.statSync(part).size !== totalBytes) throw new Error(`${path.basename(dest)} 大小不对（${fs.statSync(part).size} ≠ ${totalBytes}），删掉 ${part} 重跑`);
  fs.renameSync(part, dest);
}

/** 逐个复制、逐个删除。不用 Node 自带的递归复制 / 递归删除：Node 24 在 Windows 上碰到中文路径
 *  会直接崩掉（退出码 127，不报错），或者报成功其实没删 */
function rmDir(d) {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) { const a = path.join(d, e.name); if (e.isDirectory()) rmDir(a); else fs.unlinkSync(a); }
  fs.rmdirSync(d);
}
function copyDir(src, dst, skip = () => false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (skip(a)) continue;
    if (e.isDirectory()) copyDir(a, b, skip); else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

async function msSize(file) {
  const j = await getJson('https://www.modelscope.cn/api/v1/models/Comfy-Org/MiniMax-H3-Image/repo/files?Recursive=true', 20000);
  return j?.Data?.Files?.find((x) => x.Path === file)?.Size || null;
}

async function sevenZip(tools) {
  const exe = path.join(tools, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (!fs.existsSync(exe)) await run('npm', ['install', '7zip-bin', '--prefix', tools, '--registry', NPM_REG, '--no-audit', '--no-fund'], { shell: true });
  return exe;
}

async function freePort(p) {
  for (; ; p++) {
    const ok = await new Promise((res) => { const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(p, '127.0.0.1'); });
    if (ok) return p;
  }
}

async function setup() {
  const dirArg = opt('dir', '');
  const dir = dirArg ? path.resolve(dirArg) : '';
  const isNew = flag('new'), isUpdate = flag('update'), start = flag('start'), dry = flag('dry-run'), noModels = flag('no-models');
  const portOpt = opt('port', '');
  if (!dir || isNew === isUpdate) { console.error('用法：node h3-env.mjs setup --dir <装在哪> (--new | --update) [--port 8188] [--start] [--dry-run]'); process.exit(2); }
  if (process.platform !== 'win32' && !mock) { console.error('setup 只支持 Windows 便携版。Linux / Mac 请按 ComfyUI 官方说明装，模型地址见 art-designer/comfyui/README.md。'); process.exit(2); }
  const f = mock || await gather('');
  const build = buildFor(f.gpu?.driver);
  if (!build) { console.error(`驱动 ${f.gpu?.driver || '?'} 太旧或没有 NVIDIA 显卡，不装。`); process.exit(3); }
  const tools = path.join(dir, '_tools');
  const steps = [];
  let inst = mock ? (f.installs || []).find((i) => path.resolve(i.dir) === dir) || null : asInstall(dir);

  if (isNew) {
    if (inst) { console.error(`${dir} 里已经有 ComfyUI 了，换个位置，或用 --update。`); process.exit(2); }
    // 只有 _tools 的是上次装了一半，接着装
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((e) => e !== '_tools')) { console.error(`${dir} 不是空目录，换个位置。`); process.exit(2); }
    const url = `https://github.com/Comfy-Org/ComfyUI/releases/download/${COMFY_PIN}/${build.asset}`;
    steps.push({ say: `下载便携版 ComfyUI ${COMFY_PIN}（CUDA ${build.cuda}，约 ${PORTABLE_GB}GB）：${url}（走 GitHub 加速）`, gb: PORTABLE_GB, fn: async () => {
      const arc = path.join(tools, build.asset);
      await download((await pickMirror(url, dry)) + url, arc);
      const z = await sevenZip(tools);
      const tmp = dir + '.解压中';
      await run(z, ['x', arc, '-o' + tmp, '-y', '-bso0', '-bsp0']);
      const top = fs.readdirSync(tmp)[0];
      for (const e of fs.readdirSync(path.join(tmp, top))) fs.renameSync(path.join(tmp, top, e), path.join(dir, e));
      rmDir(tmp);
      if (fs.existsSync(arc)) fs.unlinkSync(arc);
    } });
  } else {
    if (!inst) { console.error(`${dir} 里没找到 ComfyUI。`); process.exit(2); }
    if (!inst.h3Node) {
      if (!inst.portable) { console.error('这份不是官方便携版（没有 python_embeded），不支持原地更新，请用 --new 另装。'); process.exit(2); }
      const url = `https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/${COMFY_PIN}.zip`;
      steps.push({ say: `备份 ${inst.code} 的代码到 ComfyUI_备份_${inst.version}\\（models、custom_nodes、input、output、user 不动不备份）`, fn: async () => {
        const bak = path.join(dir, `ComfyUI_备份_${inst.version}`);
        if (fs.existsSync(bak)) { console.log('  已经备份过，跳过'); return; }
        const keep = new Set(['models', 'custom_nodes', 'input', 'output', 'user', 'temp']);
        copyDir(inst.code, bak + '.tmp', (s) => keep.has(path.relative(inst.code, s).split(path.sep)[0]));
        fs.renameSync(bak + '.tmp', bak);
      } });
      steps.push({ say: `下载 ComfyUI ${COMFY_PIN} 源码覆盖上去：${url}（走 GitHub 加速）`, gb: 0.03, fn: async () => {
        const zip = path.join(tools, `ComfyUI-${COMFY_PIN}.zip`);
        await download((await pickMirror(url, dry)) + url, zip);
        const tmp = path.join(tools, 'src');
        rmDir(tmp); fs.mkdirSync(tmp, { recursive: true });
        await run(TAR, ['-xf', zip, '-C', tmp]);
        const top = path.join(tmp, fs.readdirSync(tmp)[0]);
        copyDir(top, inst.code);
        rmDir(tmp);
      } });
    }
    // 每次都补一遍依赖：装好的几秒就跳过；上次覆盖完代码、装依赖断了的，这次能补上
    if (inst.portable) steps.push({ say: `用便携版自带的 Python 补齐依赖（阿里云源，不行换腾讯云、官方源）`, fn: async () => {
      for (const [i, idx] of PIP_INDEXES.entries()) {
        try { return await run(path.join(dir, 'python_embeded', 'python.exe'), ['-s', '-m', 'pip', 'install', '-q', '-r', path.join(inst.code, 'requirements.txt'), '-i', idx]); }
        catch (e) { if (i === PIP_INDEXES.length - 1) throw e; console.log(`  ${idx} 没装成，换下一个源`); }
      }
    } });
  }

  const models = inst?.models || {};
  for (const m of noModels ? [] : missingOf(models)) {
    const url = MS + `${m.dir}/${m.file}`;
    steps.push({ say: `下载模型 ${m.file}（${m.gb}GB）：${url}`, gb: m.gb, fn: async () =>
      download(url, path.join(inst ? inst.code : path.join(dir, 'ComfyUI'), 'models', m.dir, m.file), await msSize(`${m.dir}/${m.file}`)) });
  }
  if (f.ffmpeg === false && !fs.existsSync(path.join(tools, 'ffmpeg', 'bin', 'ffmpeg.exe'))) {
    steps.push({ say: `下载 ffmpeg 到 ${path.join(tools, 'ffmpeg')}（约 0.2GB，走 GitHub 加速）`, gb: 0.2, fn: async () => {
      const zip = path.join(tools, 'ffmpeg.zip');
      await download((await pickMirror(FFMPEG_URL, dry)) + FFMPEG_URL, zip);
      await run(TAR, ['-xf', zip, '-C', tools]);
      const top = fs.readdirSync(tools).find((e) => /^ffmpeg-/.test(e) && fs.statSync(path.join(tools, e)).isDirectory());
      fs.renameSync(path.join(tools, top), path.join(tools, 'ffmpeg'));
      if (fs.existsSync(zip)) fs.unlinkSync(zip);
    } });
  }

  const port = portOpt ? +portOpt : await freePort(8188);
  if (start && inst && !inst.portable) { console.error('这份不是便携版，--start 起不了，请用户按自己平时的方式启动 ComfyUI。'); process.exit(2); }
  if (start) steps.push({ say: `启动 ComfyUI：http://127.0.0.1:${port}（日志 ${path.join(dir, 'comfyui.log')}）`, fn: async () => {
    const log = fs.openSync(path.join(dir, 'comfyui.log'), 'a');
    const logPath = path.join(dir, 'comfyui.log');
    const p = spawn(path.join(dir, 'python_embeded', 'python.exe'), ['-s', path.join('ComfyUI', 'main.py'), '--windows-standalone-build', '--port', String(port)],
      { cwd: dir, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    let exited = null; p.on('exit', (c) => { exited = c; }); p.unref();
    for (let i = 0; i < 60; i++) {
      if (await getJson(`http://127.0.0.1:${port}/system_stats`)) return;
      if (exited !== null) throw new Error(`ComfyUI 启动就退出了（退出码 ${exited}），日志最后几行：\n` + fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-8).join('\n'));
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(`5 分钟还没连上，看 ${logPath}`);
  } });

  const total = gbOf(steps.reduce((a, s) => a + (s.gb || 0), 0) * 1e9);
  const drive = path.parse(dir).root;
  const free = mock ? (f.disks || []).find((d) => d.drive.toUpperCase() === drive.toUpperCase())?.freeGB : freeGB(fs.existsSync(drive) ? drive : '.');
  const need = total + (isNew ? PORTABLE_UNPACKED_GB : 0) + 5;
  console.log(`要做 ${steps.length} 步，共下载约 ${total}GB（按 10MB/s 约 ${Math.ceil(total * 1000 / 10 / 60)} 分钟）；${drive} 剩 ${free ?? '?'}GB，需要约 ${gbOf(need * 1e9)}GB。`);
  steps.forEach((s, i) => console.log(`${i + 1}. ${s.say}`));
  if (free != null && free < need) { console.error(`\n${drive} 空间不够，换个盘。`); process.exit(3); }
  if (dry) { console.log('\n（--dry-run：没有下载，没有改任何文件）'); return; }

  fs.mkdirSync(tools, { recursive: true });
  for (const [i, s] of steps.entries()) { console.log(`\n[${i + 1}/${steps.length}] ${s.say}`); await s.fn(); }
  const ff = path.join(tools, 'ffmpeg', 'bin');
  console.log(`\n装好了。${start ? `ComfyUI：http://127.0.0.1:${port}（用 --server 交给 render-comfyui.mjs）` : `启动：双击 ${path.join(dir, 'run_nvidia_gpu.bat')}`}` +
    (fs.existsSync(ff) ? `\nffmpeg 在 ${ff}，跑出图和挂图的命令前把它加进 PATH。` : '') + '\n再跑一次 check 确认。');
}

if (cmd === 'check') await check();
else if (cmd === 'setup') await setup();
else { console.error('用法：node h3-env.mjs check [--server URL] [--json]  |  node h3-env.mjs setup --dir <装在哪> (--new|--update) [--start] [--dry-run]'); process.exit(2); }
