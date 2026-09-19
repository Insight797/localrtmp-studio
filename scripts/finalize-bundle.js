// 打包收尾：ad-hoc 签名 + 安装到「应用程序」，让它变成一个可双击的 App
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { APP_ROOT } from '../server/lib/store.js'

const APP_NAME = 'LocalRTMP Studio.app'
const built = path.join(APP_ROOT, 'src-tauri', 'target', 'release', 'bundle', 'macos', APP_NAME)
if (!fs.existsSync(built)) {
  console.error(`没找到打包结果：${built}`)
  process.exit(1)
}

execFileSync('codesign', ['--force', '--deep', '--sign', '-', built], { stdio: 'inherit' })
console.log('已完成 ad-hoc 签名')

function install(targetDir) {
  const dest = path.join(targetDir, APP_NAME)
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true })
  }
  execFileSync('ditto', [built, dest], { stdio: 'inherit' })
  return dest
}

let installed = null
const candidates = ['/Applications', path.join(os.homedir(), 'Applications')]
for (const dir of candidates) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    installed = install(dir)
    console.log(`已安装：${installed}`)
    break
  } catch (err) {
    console.warn(`安装到 ${dir} 失败：${err.message}`)
  }
}

if (!installed) {
  console.log(`\n打包产物已就绪，但当前环境不允许写入应用目录。手动安装一次即可：`)
  console.log(`  cp -R "${built}" /Applications/`)
  console.log(`之后就能从「启动台 / Spotlight」搜索 LocalRTMP Studio 直接打开。`)
} else {
  // 清掉 quarantine 标记，避免首次打开被 Gatekeeper 拦
  try {
    execFileSync('xattr', ['-dr', 'com.apple.quarantine', installed], { stdio: 'pipe' })
  } catch {
    /* 本地构建通常没有该标记 */
  }
  console.log(`在「启动台 / Spotlight」搜索 LocalRTMP Studio 即可打开。`)
}
