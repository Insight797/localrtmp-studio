// 打包前置：把运行时依赖（node、mediamtx）复制进 vendor/，随 .app 一起分发
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { APP_ROOT } from '../server/lib/store.js'

const VENDOR = path.join(APP_ROOT, 'vendor')
fs.mkdirSync(VENDOR, { recursive: true })

function copyBinary(src, name) {
  const dest = path.join(VENDOR, name)
  if (!src || !fs.existsSync(src)) {
    console.error(`找不到 ${name}: ${src}`)
    process.exit(1)
  }
  fs.copyFileSync(src, dest)
  fs.chmodSync(dest, 0o755)
  // 复制后会破坏原有签名，先做 ad-hoc 签名保证能被 Gatekeeper/内核接受
  try {
    execFileSync('codesign', ['--force', '--sign', '-', dest], { stdio: 'pipe' })
  } catch (err) {
    console.warn(`ad-hoc 签名 ${name} 失败（通常仍可运行）：${err.message}`)
  }
  const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1)
  console.log(`vendor/${name}  <- ${src} (${mb} MB)`)
}

function findMediamtx() {
  if (process.env.MEDIAMTX_BIN && fs.existsSync(process.env.MEDIAMTX_BIN)) return process.env.MEDIAMTX_BIN
  for (const p of ['/opt/homebrew/bin/mediamtx', '/usr/local/bin/mediamtx']) {
    if (fs.existsSync(p)) return p
  }
  try {
    return execFileSync('sh', ['-lc', 'command -v mediamtx'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

// 用当前执行本脚本的 node，保证版本一致
copyBinary(process.execPath, 'node')
copyBinary(findMediamtx(), 'mediamtx')

// ffmpeg 只用于「转 H.264」，缺失不致命
try {
  copyBinary(execFileSync('sh', ['-lc', 'command -v ffmpeg'], { encoding: 'utf8' }).trim(), 'ffmpeg')
} catch {
  console.warn('没找到 ffmpeg，转码功能将依赖系统安装（brew install ffmpeg）')
}
