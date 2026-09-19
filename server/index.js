// LocalRTMP Studio —— MediaMTX 控制台 + 轻量 Web UI
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import {
  APP_ROOT, DATA_DIR, CONFIG_FILE, LOG_FILE,
  ensureDirs, loadSettings, saveSettings,
  loadPresets, savePresets, loadTranscodes, saveTranscodes,
  recordsDir, lanAddresses, DEVICE_HINTS,
} from './lib/store.js'
import { MediaMtx } from './lib/mediamtx.js'
import { TranscodeManager } from './lib/transcode.js'
import { listRecordings } from './lib/recordings.js'

ensureDirs()

let settings = loadSettings()
let mtx = new MediaMtx(settings)
const transcode = new TranscodeManager(settings)

function persistTranscodes() {
  saveTranscodes([...transcode.jobs.values()].map((j) => ({ from: j.from, bitrateKbps: j.bitrateKbps })))
}

function restoreTranscodes() {
  for (const t of loadTranscodes()) {
    try {
      transcode.start(t.from, { bitrateKbps: t.bitrateKbps })
    } catch (err) {
      console.error(`恢复转码通道 ${t.from} 失败:`, err.message)
    }
  }
}

const UI_DIR = path.join(APP_ROOT, 'ui')
const APP_ID = 'localrtmp-studio'

function urls() {
  const lan = lanAddresses()
  const host = settings.bindLan && lan.length ? lan[0].address : '127.0.0.1'
  return {
    lan,
    host,
    pushBase: `rtmp://${host}:${settings.rtmpPort}/`,
  }
}

function statePayload() {
  const u = urls()
  const info = mtx.info()
  return {
    app: APP_ID,
    server: {
      ...info,
      ports: {
        rtmp: settings.rtmpPort,
        hls: settings.hlsPort,
        webrtc: settings.webrtcPort,
        api: settings.apiPort,
        rtsp: settings.rtspEnabled ? settings.rtspPort : null,
      },
      pushBase: u.pushBase,
      host: u.host,
    },
    settings,
    ffmpeg: transcode.detect(),
    deviceHints: DEVICE_HINTS,
    presets: loadPresets(),
    network: { lan: u.lan, host: u.host },
  }
}

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const file = path.join(UI_DIR, rel)
  if (!file.startsWith(UI_DIR)) {
    res.writeHead(403).end('forbidden')
    return
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // 打包缺文件时给出可定位的提示，而不是一个裸的 not found
      res
        .writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        .end(`not found: ${rel}\n控制台静态目录：${UI_DIR}\n（打包版请确认 tauri.conf.json 的 bundle.resources 含 ../ui）`)
      return
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      // 控制台是自用的本地页面，禁用缓存以便改完即见
      'cache-control': 'no-store',
    })
    res.end(buf)
  })
}

function openInFinder(target) {
  const allowed = [recordsDir(settings), LOG_FILE, CONFIG_FILE, DATA_DIR]
  const resolved = path.resolve(target)
  if (!allowed.some((a) => resolved === path.resolve(a) || resolved.startsWith(path.resolve(a) + path.sep))) {
    return false
  }
  if (!fs.existsSync(resolved)) return false
  spawn('open', [resolved], { detached: true, stdio: 'ignore' }).unref()
  return true
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      return res.end()
    }

    if (p === '/api/state') return json(res, 200, statePayload())

    if (p === '/api/streams') {
      const rt = await mtx.runtime()
      return json(res, 200, {
        ...rt,
        host: urls().host,
        ports: { hls: settings.hlsPort, webrtc: settings.webrtcPort, rtmp: settings.rtmpPort },
        server: mtx.info(),
        transcodes: transcode.list(),
      })
    }

    if (req.method === 'POST' && p === '/api/transcode/start') {
      const body = await readBody(req)
      const from = String(body.path ?? '').replace(/^\/+|\/+$/g, '')
      if (!from) return json(res, 400, { error: '缺少源通道' })
      const bitrateKbps = Math.min(Math.max(Number(body.bitrateKbps) || 4000, 500), 20000)
      try {
        transcode.start(from, { bitrateKbps })
      } catch (err) {
        return json(res, 500, { error: err.message })
      }
      persistTranscodes()
      return json(res, 200, { transcodes: transcode.list() })
    }

    if (req.method === 'POST' && p === '/api/transcode/stop') {
      const body = await readBody(req)
      transcode.stop(String(body.path ?? '').replace(/^\/+|\/+$/g, ''))
      persistTranscodes()
      return json(res, 200, { transcodes: transcode.list() })
    }

    if (p === '/api/logs') {
      const lines = Math.min(Number(url.searchParams.get('lines') ?? 200), 1000)
      return json(res, 200, { lines: mtx.logTail(lines), running: mtx.running() })
    }

    if (p === '/api/recordings') {
      return json(res, 200, listRecordings(recordsDir(settings)))
    }

    if (req.method === 'POST' && p.startsWith('/api/server/')) {
      const action = p.split('/').pop()
      if (action === 'start') {
        await mtx.start()
        restoreTranscodes()
      } else if (action === 'stop') {
        transcode.stopAll()
        await mtx.stop()
      } else if (action === 'restart') {
        transcode.stopAll()
        await mtx.restart()
        restoreTranscodes()
      } else return json(res, 400, { error: `未知操作 ${action}` })
      return json(res, 200, statePayload())
    }

    if (req.method === 'POST' && p === '/api/settings') {
      const body = await readBody(req)
      const prevPort = settings.rtmpPort
      settings = saveSettings(body)
      mtx.settings = settings
      transcode.settings = settings
      if (mtx.running()) await mtx.restart()
      // RTMP 端口变了，转码进程的地址要跟着换
      if (prevPort !== settings.rtmpPort) {
        const wanted = [...transcode.jobs.values()].map((j) => ({ from: j.from, bitrateKbps: j.bitrateKbps }))
        transcode.stopAll()
        for (const w of wanted) {
          try {
            transcode.start(w.from, { bitrateKbps: w.bitrateKbps })
          } catch {
            /* 下一轮重试 */
          }
        }
      }
      return json(res, 200, statePayload())
    }

    if (req.method === 'POST' && p === '/api/presets') {
      const body = await readBody(req)
      const list = Array.isArray(body.presets) ? body.presets : []
      savePresets(
        list.map((it) => ({
          id: String(it.id ?? `preset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
          name: String(it.name ?? '未命名').slice(0, 60),
          device: ['sony', 'dji', 'gopro', 'custom'].includes(it.device) ? it.device : 'custom',
          path: String(it.path ?? 'live/stream').replace(/^\/+|\/+$/g, '').slice(0, 120) || 'live/stream',
          resolution: String(it.resolution ?? '').slice(0, 20),
          fps: Number(it.fps) || 0,
          bitrateKbps: Number(it.bitrateKbps) || 0,
          notes: String(it.notes ?? '').slice(0, 300),
        })),
      )
      return json(res, 200, { presets: loadPresets() })
    }

    if (req.method === 'POST' && p === '/api/open') {
      const body = await readBody(req)
      const ok = openInFinder(String(body.path ?? ''))
      return json(res, ok ? 200 : 400, { ok, error: ok ? null : '路径不在允许范围内' })
    }

    if (req.method === 'GET') return serveStatic(res, p)
    return json(res, 405, { error: 'method not allowed' })
  } catch (err) {
    return json(res, 500, { error: err.message })
  }
})

// 端口占用：若已有本控制台实例在跑则直接复用并退出，否则顺延端口
function probeInstance(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/state`, { timeout: 800 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).app === APP_ID)
        } catch {
          resolve(false)
        }
      })
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => req.destroy(() => resolve(false)))
  })
}

function listen(port, attempt = 0) {
  server.once('error', async (err) => {
    if (err.code !== 'EADDRINUSE') {
      console.error('控制台启动失败:', err.message)
      return process.exit(1)
    }
    if (attempt === 0 && (await probeInstance(port))) {
      console.log(`已有实例运行在 http://127.0.0.1:${port} ，复用之`)
      return process.exit(0)
    }
    if (attempt < 10) {
      console.log(`端口 ${port} 被占用，尝试 ${port + 1}`)
      return listen(port + 1, attempt + 1)
    }
    console.error(`端口 ${port} 起连续 ${attempt} 个都被占用`)
    return process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`LocalRTMP Studio 控制台: http://127.0.0.1:${port}`)
    if (settings.autoStartServer && !mtx.running()) {
      mtx
        .start()
        .then(restoreTranscodes)
        .catch((e) => console.error('自动启动 MediaMTX 失败:', e.message))
    }
  })
}

async function shutdown() {
  transcode.stopAll()
  try {
    await mtx.stop()
  } catch {
    /* 忽略 */
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

listen(settings.uiPort)
