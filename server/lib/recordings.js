// 录制文件索引
import fs from 'node:fs'
import path from 'node:path'

const VIDEO_EXT = new Set(['.mp4', '.fmp4', '.part', '.mkv', '.ts'])
const MAX_ITEMS = 400

function walk(dir, base, out, depth = 0) {
  if (depth > 6) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      walk(full, base, out, depth + 1)
      continue
    }
    const ext = path.extname(e.name).toLowerCase()
    if (!VIDEO_EXT.has(ext)) continue
    try {
      const st = fs.statSync(full)
      out.push({
        file: path.relative(base, full),
        absPath: full,
        size: st.size,
        mtime: st.mtimeMs,
      })
    } catch {
      /* 文件可能正在被写入/轮转 */
    }
  }
}

export function listRecordings(dir) {
  const out = []
  walk(dir, dir, out)
  out.sort((a, b) => b.mtime - a.mtime)
  return {
    dir,
    exists: fs.existsSync(dir),
    total: out.length,
    totalSize: out.reduce((s, i) => s + i.size, 0),
    items: out.slice(0, MAX_ITEMS),
  }
}
