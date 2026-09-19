// 持久化层：设置 / 预设（JSON 文件，原子写入）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 程序资源根（server/ 与 ui/ 所在目录）
export const APP_ROOT = path.resolve(import.meta.dirname, '..', '..')
// 可写数据根：打包成 .app 时由 Tauri 传入 RTMP_HOME，指到 ~/Library/Application Support 下
export const DATA_ROOT = process.env.RTMP_HOME ? path.resolve(process.env.RTMP_HOME) : APP_ROOT

export const DATA_DIR = path.join(DATA_ROOT, 'data')
export const LOG_DIR = path.join(DATA_DIR, 'logs')
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
export const PRESETS_FILE = path.join(DATA_DIR, 'presets.json')
export const TRANSCODE_FILE = path.join(DATA_DIR, 'transcodes.json')
export const CONFIG_FILE = path.join(DATA_DIR, 'mediamtx.yml')
export const LOG_FILE = path.join(LOG_DIR, 'mediamtx.log')

export const DEVICE_HINTS = {
  sony: '索尼：Creators App / FT1 / Cinema Line 网络直播里，服务器填 rtmp://<本机IP>:1935，路径（App URL）填 live/xxx',
  dji: '大疆：RC Pro / Mimo 的「自定义 RTMP」里直接粘贴完整推流地址',
  gopro: 'GoPro / 运动相机：RTMP 地址粘贴完整推流地址',
  custom: '其它设备：按「服务器 + 路径」或完整地址两种方式填写',
}

export const DEFAULT_SETTINGS = {
  // 控制台（本服务）端口
  uiPort: 8787,
  // true = 监听所有网卡（相机可通过局域网推流）；false = 仅本机
  bindLan: true,
  rtmpPort: 1935,
  hlsPort: 8888,
  webrtcPort: 8889,
  apiPort: 9997,
  logLevel: 'info',
  // 留空 = 自动探测（brew 路径 / PATH）
  mediamtxBinary: '',
  // 打开控制台时自动拉起流服务
  autoStartServer: true,
  // 是否启用 RTSP（索尼部分机型走 RTSP，用不到可关）
  rtspEnabled: false,
  rtspPort: 8554,
  // 一键转码给 OBS 用的默认码率
  transcodeBitrateKbps: 4000,
  record: {
    enabled: true,
    // fmp4 =  fragmented MP4（推荐，VLC/ffmpeg 可直接播放）；mpegts = TS 分片
    format: 'fmp4',
    // 每个 part 的时长，等于断电丢失的上限
    partDuration: '1s',
    // 单个录制文件的最小时长（到点切新文件）
    segmentDuration: '1h',
    // 自动清理：0s = 永久保留
    deleteAfter: '0s',
    path: 'recordings',
  },
}

const DEFAULT_PRESETS = [
  {
    id: 'preset_sony',
    name: '索尼 A7 / Cinema Line',
    device: 'sony',
    path: 'live/sony',
    resolution: '1080p',
    fps: 30,
    bitrateKbps: 8000,
    notes: '建议 H.264 High + AAC 48k',
  },
  {
    id: 'preset_dji',
    name: '大疆 RC Pro / Mimo',
    device: 'dji',
    path: 'live/dji',
    resolution: '1080p',
    fps: 30,
    bitrateKbps: 10000,
    notes: '图传带宽有限时降到 6000kbps',
  },
]

function deepMerge(base, patch) {
  if (Array.isArray(base)) return patch === undefined ? base : patch
  if (base && typeof base === 'object') {
    const out = { ...base }
    if (patch && typeof patch === 'object') {
      for (const k of Object.keys(patch)) {
        out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
          ? deepMerge(base[k], patch[k])
          : patch[k]
      }
    }
    return out
  }
  return patch === undefined ? base : patch
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`读取 ${file} 失败:`, err.message)
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

export function loadSettings() {
  return deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, null))
}

export function saveSettings(patch) {
  const next = deepMerge(loadSettings(), patch)
  writeJsonAtomic(SETTINGS_FILE, next)
  return next
}

export function loadPresets() {
  const stored = readJson(PRESETS_FILE, null)
  if (stored === null) {
    writeJsonAtomic(PRESETS_FILE, DEFAULT_PRESETS)
    return DEFAULT_PRESETS.slice()
  }
  return Array.isArray(stored) ? stored : []
}

export function savePresets(list) {
  writeJsonAtomic(PRESETS_FILE, Array.isArray(list) ? list : [])
}

// 转码通道（重启后自动恢复）
export function loadTranscodes() {
  const stored = readJson(TRANSCODE_FILE, [])
  return Array.isArray(stored) ? stored : []
}

export function saveTranscodes(list) {
  writeJsonAtomic(TRANSCODE_FILE, Array.isArray(list) ? list : [])
}

// 相对路径统一相对可写数据根
export function resolveRootPath(p) {
  return path.isAbsolute(p) ? p : path.join(DATA_ROOT, p)
}

export function recordsDir(settings) {
  return resolveRootPath(settings.record.path || 'recordings')
}

// 网卡优先级：物理网卡(en*) > 网桥(iPhone 共享等) > 其它 > VPN(utun)，链路本地地址排除
function ifaceRank(name) {
  if (/^en\d+$/.test(name)) return 0
  if (/^bridge\d+$/.test(name)) return 1
  if (/^utun\d+$/.test(name)) return 3
  return 2
}

export function lanAddresses() {
  const out = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (name === 'awdl0' || name === 'llw0') continue
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue
      out.push({ iface: name, address: a.address })
    }
  }
  return out.sort((a, b) => ifaceRank(a.iface) - ifaceRank(b.iface) || a.iface.localeCompare(b.iface))
}
