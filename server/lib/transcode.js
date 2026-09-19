// 转码通道：把 H.265 等 OBS 拉不动的流，服务端转成 H.264 通道再给 OBS 拉
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const FFMPEG_CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
const TAIL = 12
const RETRY_MS = 3000

export function detectFfmpeg() {
  const list = [process.env.RTMP_FFMPEG_BIN, ...FFMPEG_CANDIDATES].filter(Boolean)
  for (const p of list) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {
      /* 继续 */
    }
  }
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    const p = path.join(dir, 'ffmpeg')
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {
      /* 继续 */
    }
  }
  return null
}

export class TranscodeManager {
  constructor(settings) {
    this.settings = settings
    this.jobs = new Map() // from -> job
  }

  static outName(from) {
    return `${from}_avc`
  }

  detect() {
    return detectFfmpeg()
  }

  list() {
    const now = Date.now()
    return [...this.jobs.values()].map((j) => ({
      from: j.from,
      to: j.to,
      bitrateKbps: j.bitrateKbps,
      wanted: j.wanted,
      running: Boolean(j.child) && j.child.exitCode === null,
      pid: j.child?.pid ?? null,
      uptimeMs: j.startedAt ? now - j.startedAt : 0,
      restarts: j.restarts,
      hw: j.hw,
      lastError: j.tail.filter(Boolean).slice(-2).join(' '),
    }))
  }

  start(from, { bitrateKbps = 4000 } = {}) {
    if (!from) throw new Error('缺少源通道')
    const existing = this.jobs.get(from)
    if (existing) {
      existing.wanted = true
      existing.bitrateKbps = bitrateKbps
      if (!existing.child) this._spawn(existing)
      return existing
    }
    const job = {
      from,
      to: TranscodeManager.outName(from),
      bitrateKbps,
      wanted: true,
      hw: true,
      child: null,
      startedAt: 0,
      restarts: 0,
      tail: [],
    }
    this.jobs.set(from, job)
    this._spawn(job)
    return job
  }

  stop(from) {
    const job = this.jobs.get(from)
    if (!job) return false
    job.wanted = false
    this._kill(job)
    this.jobs.delete(from)
    return true
  }

  stopAll() {
    for (const job of this.jobs.values()) {
      job.wanted = false
      this._kill(job)
    }
    this.jobs.clear()
  }

  _kill(job) {
    if (job.child && job.child.exitCode === null) job.child.kill('SIGTERM')
    job.child = null
    job.startedAt = 0
  }

  _args(job) {
    const port = this.settings.rtmpPort
    const hlsPort = this.settings.hlsPort
    const bitrate = job.bitrateKbps
    const args = ['-hide_banner', '-loglevel', 'warning', '-rw_timeout', '5000000']
    if (job.hw) args.push('-hwaccel', 'videotoolbox')
    args.push(
      // 必须走 HLS 取源：MediaMTX 在 RTMP 出口会丢掉 H.265 轨，只有 HLS/fMP4 能带 hvc1
      '-fflags',
      '+genpts',
      '-live_start_index',
      '-1',
      '-i',
      `http://127.0.0.1:${hlsPort}/${job.from
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/')}/index.m3u8`,
      '-map',
      '0:v:0?',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '60',
      '-b:v',
      `${bitrate}k`,
      '-maxrate',
      `${Math.round(bitrate * 1.3)}k`,
      '-bufsize',
      `${bitrate}k`,
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-f',
      'flv',
      `rtmp://127.0.0.1:${port}/${job.to}`,
    )
    return args
  }

  _spawn(job) {
    const bin = detectFfmpeg()
    if (!bin) {
      job.tail = ['未找到 ffmpeg，请先安装：brew install ffmpeg']
      throw new Error(job.tail[0])
    }
    const child = spawn(bin, this._args(job), { stdio: ['ignore', 'ignore', 'pipe'] })
    job.child = child
    job.startedAt = Date.now()

    child.stderr.on('data', (buf) => {
      for (const line of buf.toString().split('\n')) {
        const t = line.trim()
        if (!t) continue
        job.tail.push(t)
        if (job.tail.length > TAIL) job.tail.shift()
      }
    })

    child.on('exit', (code) => {
      job.child = null
      job.startedAt = 0
      if (!job.wanted) return
      job.restarts += 1
      // 硬件解码启动失败时退回软解
      const text = job.tail.join(' ')
      if (job.hw && code !== 0 && /videotoolbox|hwaccel|Cannot initialize|not supported/i.test(text)) {
        job.hw = false
      }
      setTimeout(() => {
        if (job.wanted && !job.child) {
          try {
            this._spawn(job)
          } catch {
            /* 已在 tail 里体现 */
          }
        }
      }, RETRY_MS)
    })
  }
}
