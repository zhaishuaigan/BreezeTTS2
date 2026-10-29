'use strict';

/*
 * Breeze TTS 2 — Electron wrapper
 * ---------------------------------
 * 双击运行后：
 *   1. 检查模型是否已下载（breeze-tts-2-q8_0.gguf），
 *      没有则自动从 HuggingFace 下载（支持断点续传，带进度显示）。
 *   2. 启动内置的 breeze-server.exe（Vulkan 后端，自动回退 CPU）。
 *   3. 轮询 /health 直到服务就绪，然后把端口交给自研界面（renderer/）。
 *   4. 退出时杀掉服务进程树。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// 配置常量
// ---------------------------------------------------------------------------
const APP_NAME = 'Breeze TTS 2';

// 模型仓库（HuggingFace）：预转换好的 GGUF
// 国内网络可设环境变量 HF_ENDPOINT=https://hf-mirror.com 走镜像
const HF_ENDPOINT = (process.env.HF_ENDPOINT || 'https://hf-mirror.com').replace(/\/+$/, '');
const HF_BASE = `${HF_ENDPOINT}/HoppouAI/Breeze-TTS-2.cpp/resolve/main`;
// 只需这一个文件：声码器（codec.*）已随 GGUF 一起导出，
// 运行时不会读取 audio_tokenizer/ 目录（那是 Python 转换脚本才需要的）。
const MODEL_FILE = 'breeze-tts-2-q8_0.gguf';            // 推荐档位，~3.3 GB

// 固定数据目录（开发与打包都用同一路径，避免目录名漂移）
app.setPath('userData', path.join(app.getPath('appData'), 'breeze-tts-2'));

const BIN_REL = path.join('bin', 'breeze-server.exe');
const SERVER_EXE = path.join(__dirname, BIN_REL)

// 数据目录（模型、已保存音色都放这里，随用户持久化）
const MODELS_DIR = path.join(__dirname, 'models');
const VOICES_DIR = path.join(__dirname, 'voices');

const DEFAULT_PORT = 8080;
const HEALTH_TIMEOUT = 150 * 1000; // 首次加载模型+预热最多给 150s

// ---------------------------------------------------------------------------
// 主窗口（无边框，窗口按钮由 renderer 自绘）
// ---------------------------------------------------------------------------
let win = null;
let serverProc = null;
let booting = false;
let quitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 980,
    minHeight: 660,
    title: APP_NAME,
    frame: false,
    backgroundColor: '#0a0c10',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 界面由 file:// 本地文件提供，需要直接访问 127.0.0.1 上的本地服务；
      // 关闭 web 安全策略以避免 CORS/私有网络拦截（不加载任何外部页面）。
      webSecurity: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.on('maximize', () => send('window-state', { maximized: true }));
  win.on('unmaximize', () => send('window-state', { maximized: false }));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// 向前端发消息
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// 模型下载（支持断点续传）
// ---------------------------------------------------------------------------
function ensureModelFiles() {
  const missing = [];
  const gguf = path.join(MODELS_DIR, MODEL_FILE);
  if (!fs.existsSync(gguf) || fs.statSync(gguf).size < 1024) {
    missing.push({ name: MODEL_FILE, url: `${HF_BASE}/${MODEL_FILE}` });
  }
  return missing;
}

// 发起 GET 请求并自动跟随 301/302/303/307/308 重定向
// （HF 镜像的 resolve/main 链接会 302 跳到 CDN，Node 的 http.get 不会自动跟随）
function requestStream(url, headers, maxHops = 8) {
  return new Promise((resolve, reject) => {
    const attempt = (target, hops) => {
      const mod = target.startsWith('http:') ? http : https;
      const req = mod.get(target, { headers }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (hops >= maxHops) {
            reject(new Error(`重定向次数过多 — ${url}`));
            return;
          }
          let next;
          try {
            next = new URL(res.headers.location, target).href;
          } catch (e) {
            reject(new Error(`无效的重定向地址 — ${res.headers.location}`));
            return;
          }
          attempt(next, hops + 1);
          return;
        }
        resolve(res);
      });
      req.on('error', reject);
    };
    attempt(url, 0);
  });
}

async function downloadResumable(url, dest, onProgress) {
  console.log(url, dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  let done = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
  const headers = { 'User-Agent': 'breeze-tts-2-electron' };
  if (done > 0) headers['Range'] = `bytes=${done}-`;

  const res = await requestStream(url, headers);
  if (res.statusCode === 200) {
    done = 0; // 服务端不支持断点，重新整份下载
  } else if (res.statusCode !== 206) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode} — ${url}`);
  }

  // 206：总量取 Content-Range 的 "bytes a-b/TOTAL"；200：取 Content-Length
  const rangeTotal = /\/\s*(\d+)\s*$/.exec(res.headers['content-range'] || '');
  const total = res.statusCode === 206
    ? Number((rangeTotal && rangeTotal[1]) || 0)
    : Number(res.headers['content-length'] || 0);

  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(tmp, { flags: done ? 'a' : 'w' });
    let received = done;
    res.on('data', (c) => {
      received += c.length;
      onProgress(received, total > 0 ? total : 0, done);
    });
    res.pipe(stream);           // 关键：把响应体真正写入文件（pipe 会处理 end 和背压）
    stream.on('finish', () => {
      stream.close(() => {
        if (total > 0 && received < total) {
          // 连接中途断掉：保留 .part 供下次续传
          reject(new Error(`下载不完整：${received}/${total} 字节`));
          return;
        }
        fs.renameSync(tmp, dest);
        resolve(dest);
      });
    });
    stream.on('error', reject);
    res.on('error', reject);
  });
}

async function downloadModel(missing) {
  for (let i = 0; i < missing.length; i++) {
    const item = missing[i];
    const dest = path.join(MODELS_DIR, item.name);
    const label = item.name;
    send('status', `正在下载 ${label}（${i + 1}/${missing.length}）…`);

    await downloadResumable(urlOf(item), dest, (received, total) => {
      send('progress', { label, received, total, step: i + 1, steps: missing.length });
    });
  }
}

function urlOf(item) {
  return item.url || `${HF_BASE}/${item.name}`;
}

// ---------------------------------------------------------------------------
// 端口选择 / 服务启动 / 健康探活
// ---------------------------------------------------------------------------
function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.on('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function findFreePort(start) {
  for (let p = start; p < start + 20; p++) {
    if (await isPortFree(p)) return p;
  }
  return start;
}

function waitForHealth(port, timeoutMs, isDead) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const url = `http://127.0.0.1:${port}/health`;
    const tryOnce = () => {
      if (isDead && isDead()) { reject(new Error('server exited')); return; }
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) { reject(new Error('timeout')); return; }
      setTimeout(tryOnce, 600);
    };
    tryOnce();
  });
}

// 读取 /health，拿到流式 WebSocket 端口
function fetchHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.setTimeout(3000, () => { req.destroy(); resolve({}); });
  });
}

async function startServer(port) {
  const modelPath = path.join(MODELS_DIR, MODEL_FILE);
  const args = [
    modelPath,
    '--webui',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--voices-dir', VOICES_DIR
  ];

  return new Promise((resolve, reject) => {
    let childExited = false;
    const child = spawn(SERVER_EXE, args, {
      cwd: MODELS_DIR,        // 模型目录作为工作目录
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        GGML_DISABLE_VULKAN: '1'
      }
    });
    serverProc = child;
    let errBuf = '';
    child.stderr.on('data', (d) => {
      errBuf += d.toString();
      if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
    });
    child.on('error', (err) => reject(err));
    child.on('exit', (code, sig) => {
      childExited = true;
      if (booting) {
        reject(new Error(`breeze-server 退出 (code=${code}${sig ? ',' + sig : ''})：\n${lastErr(errBuf)}`));
        return;
      }
      // 正常使用期间服务崩溃：回到加载页并提示
      if (!quitting) {
        const message = `breeze-server 已退出 (code=${code}${sig ? ',' + sig : ''})。\n${lastErr(errBuf)}`;
        if (win && !win.isDestroyed()) {
          // 页面重载后再发错误，避免消息在重载时丢失
          win.webContents.once('did-finish-load', () => send('error', { message }));
          win.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch(() => { });
        } else {
          send('error', { message });
        }
      }
    });
    waitForHealth(port, HEALTH_TIMEOUT, () => childExited)
      .then(() => resolve(port))
      .catch((e) => {
        if (childExited) reject(new Error(`breeze-server 未能启动：\n${lastErr(errBuf)}`));
        else reject(e);
      });
  });
}

function lastErr(buf) {
  const lines = buf.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.slice(-6).join('\n') || '无输出';
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function boot() {
  booting = true;
  try {
    // 1) 模型
    let missing = ensureModelFiles();
    if (missing.length) {
      send('status', '首次运行：需要下载模型（约 3.3 GB），请保持联网。');
      await downloadModel(missing);
      missing = ensureModelFiles();
      if (missing.length) throw new Error('模型文件不完整，请重试。');
    }

    // 2) 启动服务
    if (!fs.existsSync(SERVER_EXE)) {
      throw new Error('未找到 breeze-server.exe。\n请先运行 deno run -A scripts/build.js 完成打包，或在开发模式下把官方预编译包放入 resources\\bin。');
    }
    const port = await findFreePort(DEFAULT_PORT);
    send('status', `正在启动本地语音服务（端口 ${port}）…`);
    await startServer(port);

    // 3) 交给自研界面：携带 HTTP 端口和流式 WebSocket 端口
    const health = await fetchHealth(port);
    booting = false;
    send('ready', { port, wsPort: Number(health.ws_port) || 0 });
  } catch (err) {
    booting = false;
    send('error', { message: String(err && err.message || err) });
  }
}

// 手动重试（前端的“重试”按钮）
ipcMain.handle('retry', async () => {
  booting = false;
  if (serverProc) {
    try { killTree(serverProc.pid); } catch (e) { /* noop */ }
    serverProc = null;
  }
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch(() => { });
  }
  setTimeout(() => boot(), 400);
  return true;
});

ipcMain.handle('quit', () => app.quit());

// 无边框窗口控制
ipcMain.on('win:minimize', () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.on('win:toggle-maximize', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', () => { if (win && !win.isDestroyed()) win.close(); });
ipcMain.handle('win:state', () => ({ maximized: !!(win && !win.isDestroyed() && win.isMaximized()) }));

// ---------------------------------------------------------------------------
// 进程清理
// ---------------------------------------------------------------------------
function killTree(pid) {
  try {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } catch (e) { /* noop */ }
}

app.on('before-quit', () => {
  quitting = true;
  if (serverProc) killTree(serverProc.pid);
  serverProc = null;
});

app.whenReady().then(() => {
  createWindow();
  setTimeout(boot, 300); // 等窗口就绪，避免丢失早期状态消息
});

app.on('window-all-closed', () => {
  app.quit();
});
