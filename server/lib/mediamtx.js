// MediaMTX 生命周期管理：生成配置、启停进程、读取运行时状态
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import http from 'node:http'

import { CONFIG_FILE, DATA_ROOT, LOG_FILE, recordsDir } from './store.js'

const CANDIDATES = [
  '/opt/homebrew/bin/mediamtx',
  '/usr/local/bin/mediamtx',
  '/opt/homebrew/opt/mediamtx/bin/mediamtx',
]

const LOG_TAIL_SIZE = 400

function bindAddress(settings, port) {
  return `${settings.bindLan ? '' : '127.0.0.1'}:${port}`
}

function yamlQuote(v) {
  const s = String(v)
  return /[:#{}[\],&*?|>'"%@`]|^\s|\s$/.test(s) ? `'${s.replace(/'/g, "''")}'` : s
}

export class MediaMtx {
  constructor(settings) {
    this.settings = settings
    this.child = null
    this.startedAt = 0
    this.tail = []
    this.samples = new Map()
    this.version = null
    this.lastExit = null
  }

  detectBinary() {
    const custom = this.settings.mediamtxBinary?.trim()
    // RTMP_MEDIAMTX_BIN 由 .app 壳注入，指向包内自带的内核
    const list = [custom, process.env.RTMP_MEDIAMTX_BIN, ...CANDIDATES].filter(Boolean)
    for (const p of list) {
      try {
        fs.accessSync(p, fs.constants.X_OK)
        return p
      } catch {
        /* 继续尝试 */
      }
    }
    // 最后回落到 PATH
    return null
  }

  // 只覆盖需要的键，其余走 MediaMTX 默认值（默认即允许匿名 publish/read）
  buildConfig() {
    const s = this.settings
    const rec = s.record
    const recDir = `./${(path.relative(DATA_ROOT, recordsDir(s)) || 'recordings').replaceAll(path.sep, '/')}`
    const lines = []
    const put = (k, v) => lines.push(`${k}: ${v}`)

    put('logLevel', s.logLevel || 'info')
    put('rtmp', 'true')
    put('rtmpAddress', bindAddress(s, s.rtmpPort))
    put('rtsp', s.rtspEnabled ? 'true' : 'false')
    if (s.rtspEnabled) put('rtspAddress', bindAddress(s, s.rtspPort))
    put('hls', 'true')
    put('hlsAddress', bindAddress(s, s.hlsPort))
    put('hlsAllowOrigins', "['*']")
    put('webrtc', 'true')
    put('webrtcAddress', bindAddress(s, s.webrtcPort))
    put('webrtcAllowOrigins', "['*']")
    // 笔记本上用不到的协议关掉，减少端口占用与防火墙弹窗
    put('srt', 'false')
    put('moq', 'false')
    put('api', 'true')
    put('apiAddress', `127.0.0.1:${s.apiPort}`)

    lines.push('', 'pathDefaults:')
    const putPath = (k, v) => lines.push(`  ${k}: ${v}`)
    putPath('record', rec.enabled ? 'true' : 'false')
    putPath('recordPath', yamlQuote(`${recDir}/%path/%Y-%m-%d_%H-%M-%S-%f`))
    putPath('recordFormat', rec.format)
    putPath('recordPartDuration', rec.partDuration)
    putPath('recordSegmentDuration', rec.segmentDuration)
    putPath('recordDeleteAfter', rec.deleteAfter)

    // 必须有 all_others 这一项，否则未显式声明的推流路径会被拒绝
    lines.push('', 'paths:', '  all_others:')

    return `${lines.join('\n')}\n`
  }

  writeConfig() {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, this.buildConfig())
    return CONFIG_FILE
  }

  logTail(lines = 300) {
    if (this.tail.length) return this.tail.slice(-lines)
    // 控制台重启后内存里没有日志，回落到读取文件末尾
    try {
      const size = fs.statSync(LOG_FILE).size
      const len = Math.min(size, 128 * 1024)
      const buf = Buffer.alloc(len)
      const fd = fs.openSync(LOG_FILE, 'r')
      try {
        fs.readSync(fd, buf, 0, len, size - len)
      } finally {
        fs.closeSync(fd)
      }
      return buf.toString().split('\n').filter(Boolean).slice(-lines)
    } catch {
      return []
    }
  }

  async start() {
    if (this.child) return { alreadyRunning: true }
    const bin = this.detectBinary()
    if (!bin) {
      throw new Error('未找到 mediamtx 可执行文件，请先执行：brew install mediamtx')
    }
    if (await this.pingApi()) {
      throw new Error(`API 端口 ${this.settings.apiPort} 已有 MediaMTX 在响应，可能端口被占用`)
    }

    const conf = this.writeConfig()
    this.tail = []
    this.samples = new Map()
    this.lastExit = null
    this.version = null

    const child = spawn(bin, [conf], { cwd: DATA_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.startedAt = Date.now()

    const onData = (buf) => {
      const text = buf.toString()
      fs.appendFile(LOG_FILE, text, () => {})
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        this.tail.push(t)
        if (this.tail.length > LOG_TAIL_SIZE * 3) this.tail.splice(0, this.tail.length - LOG_TAIL_SIZE)
        const m = t.match(/MediaMTX (v[\w.\-]+)/)
        if (m) this.version = m[1]
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    child.on('exit', (code, signal) => {
      this.lastExit = { code, signal, at: Date.now() }
      this.child = null
    })

    // 等待 API 就绪（最多 6s），期间若进程退出则直接报错
    for (let i = 0; i < 30; i++) {
      if (!this.child) {
        throw new Error(`MediaMTX 启动失败：${this.tail.slice(-6).join(' | ') || `退出码 ${this.lastExit?.code}`}`)
      }
      if (await this.pingApi()) return { ok: true }
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`MediaMTX 已启动但控制 API 无响应：${this.tail.slice(-6).join(' | ')}`)
  }

  async stop() {
    const child = this.child
    if (!child) return { stopped: false }
    this.child = null
    child.kill('SIGINT')
    const deadline = Date.now() + 4000
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    return { stopped: true }
  }

  async restart() {
    await this.stop()
    return this.start()
  }

  running() {
    return Boolean(this.child) && this.child.exitCode === null
  }

  info() {
    const bin = this.detectBinary()
    return {
      running: this.running(),
      pid: this.child?.pid ?? null,
      uptimeMs: this.running() ? Date.now() - this.startedAt : 0,
      binary: bin,
      configPath: CONFIG_FILE,
      logPath: LOG_FILE,
      lastExit: this.lastExit,
      version: this.version ?? null,
    }
  }

  apiUrl(p) {
    return `http://127.0.0.1:${this.settings.apiPort}${p}`
  }

  pingApi() {
    // /v3/paths/list 是随 api 一同开启的最基础端点，适合做就绪探测
    return this.api('/v3/paths/list').then(() => true).catch(() => false)
  }

  api(p) {
    return new Promise((resolve, reject) => {
      const req = http.get(this.apiUrl(p), { timeout: 2000 }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          if (res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`))
          try {
            resolve(JSON.parse(body || '{}'))
          } catch (err) {
            reject(err)
          }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('timeout')))
    })
  }

  // MediaMTX 只给累计字节，实时码率由本进程按采样差值计算
  async runtime() {
    if (!this.running()) return { streams: [], connections: [], error: null }
    const [paths, rtmp] = await Promise.all([
      this.api('/v3/paths/list').catch(() => ({ items: [] })),
      this.api('/v3/rtmpconns/list').catch(() => ({ items: [] })),
    ])

    const now = Date.now()
    const nextSamples = new Map()
    const streams = (paths.items ?? []).map((p) => {
      const bytes = p.inboundBytes ?? p.bytesReceived ?? 0
      const prev = this.samples.get(p.name)
      let bitrateKbps = prev?.kbps ?? 0
      if (!prev) {
        nextSamples.set(p.name, { bytes, at: now, kbps: 0 })
      } else {
        const dt = (now - prev.at) / 1000
        if (dt >= 0.5) {
          // 采样窗口足够才更新，否则沿用上一组基线（避免多次轮询互相打断）
          bitrateKbps = bytes >= prev.bytes ? Math.round(((bytes - prev.bytes) * 8) / dt / 1000) : 0
          nextSamples.set(p.name, { bytes, at: now, kbps: bitrateKbps })
        } else {
          nextSamples.set(p.name, prev)
        }
      }
      const propsOf = (t) => t.codecProps ?? {}
      const video = (p.tracks2 ?? []).find((t) => /H264|H265|HEVC|VP9|AV1|VP8/i.test(t.codec))
      const audio = (p.tracks2 ?? []).find((t) => /audio|AAC|Opus|MP3|G711/i.test(t.codec))
      return {
        name: p.name,
        ready: Boolean(p.ready),
        online: Boolean(p.online),
        since: p.readyTime ?? null,
        sourceType: p.source?.type ?? null,
        sourceId: p.source?.id ?? null,
        inboundBytes: bytes,
        outboundBytes: p.outboundBytes ?? p.bytesSent ?? 0,
        readers: (p.readers ?? []).length,
        framesInError: p.inboundFramesInError ?? 0,
        bitrateKbps,
        video: video
          ? {
              codec: video.codec,
              width: propsOf(video).width ?? 0,
              height: propsOf(video).height ?? 0,
              profile: propsOf(video).profile ?? '',
            }
          : null,
        audio: audio ? { codec: audio.codec, sampleRate: propsOf(audio).sampleRate ?? 0 } : null,
        trackCodes: (p.tracks2 ?? []).map((t) => t.codec),
      }
    })
    this.samples = nextSamples

    return {
      streams,
      connections: (rtmp.items ?? []).map((c) => ({
        id: c.id,
        protocol: 'rtmp',
        remote: c.remoteAddr,
        state: c.state,
        path: c.path,
        userAgent: c.userAgent ?? '',
        bytesReceived: c.inboundBytes ?? c.bytesReceived ?? 0,
        since: c.created ?? null,
      })),
      error: null,
    }
  }
}
