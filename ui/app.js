/* LocalRTMP Studio 控制台 */
const $ = (sel) => document.querySelector(sel)
const api = {
  get: (p) => fetch(p).then((r) => r.json()),
  post: (p, body) =>
    fetch(p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).then((r) => r.json()),
}

const S = {
  settings: null,
  presets: [],
  deviceHints: {},
  server: null,
  host: '127.0.0.1',
  lan: [],
  ports: { rtmp: 1935, hls: 8888, webrtc: 8889 },
  preview: { pc: null, path: null, mode: '' },
  autoTimer: null,
}

/* ---------- 小工具 ---------- */
function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toast.t)
  toast.t = setTimeout(() => el.classList.remove('show'), 1400)
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  toast(`已复制：${text.length > 40 ? `${text.slice(0, 40)}…` : text}`)
}

function bytes(n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`
}

function kbps(n) {
  if (!n) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(2)} Mbps` : `${n} kbps`
}

function dur(ms) {
  if (!ms) return '—'
  const s = Math.floor(ms / 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
}

function when(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
}

function encPath(p) {
  return p.split('/').map(encodeURIComponent).join('/')
}

function pushUrl(path) {
  return `rtmp://${S.host}:${S.ports.rtmp}/${path}`
}
function pullHls(path) {
  return `http://${S.host}:${S.ports.hls}/${encPath(path)}/index.m3u8`
}
function pullWhep(path) {
  return `http://${S.host}:${S.ports.webrtc}/${encPath(path)}/whep`
}

function showError(msg) {
  if (!msg) {
    $('#errorBanner').classList.add('hidden')
    return
  }
  $('#errorText').textContent = msg
  $('#errorBanner').classList.remove('hidden')
}

/* ---------- 状态 / 顶栏 ---------- */
function paintServer(info) {
  const pill = $('#statusPill')
  const on = Boolean(info?.running)
  pill.textContent = on ? `运行中 · PID ${info.pid} · ${dur(info.uptimeMs)}` : '未运行'
  pill.className = `statusPill ${on ? 'on' : 'off'}`
  $('#btnStart').disabled = on
  $('#btnStop').disabled = !on
  $('#btnRestart').disabled = !on
  $('#binaryBanner').classList.toggle('hidden', Boolean(info?.binary))
  const v = info?.version ? ` ${info.version}` : ''
  $('#engineLine').textContent = info?.binary
    ? `MediaMTX${v} · ${info.binary}${on ? ` · 录制${S.settings.record.enabled ? '开' : '关'}` : ''}`
    : '未找到 MediaMTX 内核'
}

function paintAddresses() {
  const sel = $('#hostSelect')
  const opts = [{ iface: '本机', address: '127.0.0.1' }, ...S.lan]
  sel.innerHTML = opts
    .map(
      (o) =>
        `<option value="${o.address}" ${o.address === S.host ? 'selected' : ''}>${o.address}${o.iface && o.iface !== '本机' ? `  (${o.iface})` : ''}</option>`,
    )
    .join('')
  $('#pushBase').textContent = `rtmp://${S.host}:${S.ports.rtmp}/`
  $('#pushHostOnly').textContent = `rtmp://${S.host}:${S.ports.rtmp}`
}

/* ---------- 流列表（按路径增量更新，避免每秒重建 DOM） ---------- */
const streamRows = new Map()

function createRow(name) {
  const enc = encodeURIComponent(name)
  const tr = document.createElement('tr')
  tr.innerHTML = `
    <td class="path"></td>
    <td><span class="pic"></span><div class="muted aud"></div></td>
    <td class="mono rate"><div class="muted vol"></div><div class="muted tc"></div></td>
    <td class="mono readers"></td>
    <td class="muted src"></td>
    <td class="actions">
      <button class="btn tiny" data-transcode="${enc}">转 H.264</button>
      <button class="btn tiny" data-preview="${enc}">预览</button>
      <button class="btn tiny" data-copyurl="${enc}">复制地址</button>
    </td>`
  const rate = tr.querySelector('.rate')
  const rateText = document.createTextNode('')
  rate.insertBefore(rateText, rate.firstChild)
  return {
    tr,
    path: tr.querySelector('td.path'),
    pic: tr.querySelector('.pic'),
    aud: tr.querySelector('.aud'),
    rateText,
    vol: tr.querySelector('.vol'),
    tc: tr.querySelector('.tc'),
    readers: tr.querySelector('.readers'),
    src: tr.querySelector('.src'),
    tcBtn: tr.querySelector('[data-transcode]'),
  }
}

function setText(el, value) {
  if (el && el.textContent !== value) el.textContent = value
}

function paintStreams(data) {
  const tbody = $('#streamTable tbody')
  const streams = data.streams ?? []
  const conns = data.connections ?? []
  $('#streamCount').textContent = String(streams.length)
  $('#noStreamHint').classList.toggle('hidden', streams.length > 0)

  const seen = new Set()
  const tcs = new Map((data.transcodes ?? []).map((t) => [t.from, t]))
  S.transcodes = tcs
  for (const s of streams) {
    seen.add(s.name)
    let row = streamRows.get(s.name)
    if (!row) {
      row = createRow(s.name)
      streamRows.set(s.name, row)
      tbody.appendChild(row.tr)
    }
    const conn = conns.find((c) => c.id === s.sourceId)
    const dev = conn?.userAgent ? conn.userAgent.replace(/\s*\(compatible;.*?\)/, '').trim() : (s.sourceType ?? '')
    const bad = s.framesInError > 50 ? ` 错帧 ${s.framesInError}` : ''
    setText(row.path, `${s.name}${bad}`)
    setText(row.pic, s.video ? `${s.video.width}×${s.video.height} ${s.video.codec}` : (s.trackCodes ?? []).join(',') || '—')
    setText(row.aud, s.audio ? `${s.audio.codec} ${s.audio.sampleRate / 1000}k` : '')
    setText(row.rateText, kbps(s.bitrateKbps))
    setText(row.vol, bytes(s.inboundBytes))
    setText(row.readers, `${s.readers} 路`)
    setText(row.src, [conn?.remote?.split(':')[0], dev].filter(Boolean).join(' · ') || '—')

    const hevc = /H265|HEVC/i.test(s.video?.codec ?? '')
    const derived = s.name.endsWith('_avc') && tcs.has(s.name.slice(0, -4))
    const job = tcs.get(s.name)
    if (job) {
      setText(row.tc, `→ ${s.name}_avc · ${kbps(job.bitrateKbps)}${job.running ? ` · ${dur(job.uptimeMs)}` : ' · 等待源流'}${job.restarts ? ` · 重连${job.restarts}` : ''}`)
      setText(row.tcBtn, '停止转码')
      row.tcBtn.disabled = false
    } else if (derived) {
      setText(row.tc, s.video ? '转码输出通道（给 OBS 用这个）' : '转码输出：暂无视频轨，检查源是否有画面')
      setText(row.tcBtn, '转码输出')
      row.tcBtn.disabled = true
    } else {
      setText(row.tc, hevc ? 'H.265：OBS 拉 RTMP 会黑屏，点右侧转码' : '')
      setText(row.tcBtn, '转 H.264')
      row.tcBtn.disabled = !S.ffmpeg
    }
  }
  for (const [name, row] of streamRows) {
    if (!seen.has(name)) {
      row.tr.remove()
      streamRows.delete(name)
    }
  }
}

function paintObsUrls(path) {
  const row = $('#obsUrls')
  const list = [
    ['RTMP', pushUrl(path)],
    ['HLS', pullHls(path)],
    ['WebRTC', pullWhep(path)],
  ]
  row.innerHTML = list
    .map(
      ([label, url]) =>
        `<span class="badge">${label}</span><code class="mono">${url}</code><button class="btn tiny" data-url="${encodeURIComponent(url)}">复制</button>`,
    )
    .join('')
}

$('#obsUrls').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-url]')
  if (btn) copy(decodeURIComponent(btn.dataset.url))
})

/* ---------- 预览（WHEP，失败回退 HLS） ---------- */
function stopPreview() {
  $('#previewBox').classList.add('hidden')
  const v = $('#previewVideo')
  v.srcObject = null
  v.pause()
  if (S.preview.pc) {
    S.preview.pc.close()
    S.preview.pc = null
  }
  S.preview.path = null
  S.preview.kind = ''
}

async function waitIce(pc, timeout = 900) {
  if (pc.iceGatheringState === 'complete') return
  await new Promise((resolve) => {
    const done = () => pc.removeEventListener('icegatheringstatechange', check)
    const check = () => pc.iceGatheringState === 'complete' && done()
    pc.addEventListener('icegatheringstatechange', check)
    setTimeout(() => {
      done()
      resolve()
    }, timeout)
  })
}

async function startPreview(path, mode = 'webrtc') {
  stopPreview()
  $('#previewBox').classList.remove('hidden')
  $('#previewTitle').textContent = `预览 · ${path}`
  $('#previewMode').textContent = '连接中…'
  paintObsUrls(path)
  const video = $('#previewVideo')
  S.preview.path = path

  if (mode === 'hls') return playHls(path, '手动选择 HLS')

  try {
    const pc = new RTCPeerConnection()
    S.preview.pc = pc
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })
    const stream = new MediaStream()
    pc.ontrack = (e) => {
      stream.addTrack(e.track)
      video.srcObject = stream
      video.play().catch(() => {
        video.muted = true
        video.play().catch(() => {})
      })
    }
    await pc.setLocalDescription(await pc.createOffer())
    await waitIce(pc)
    const res = await fetch(pullWhep(path), {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: pc.localDescription.sdp,
    })
    if (!res.ok) throw new Error(`WHEP ${res.status}`)
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })
    S.preview.mode = 'WebRTC (WHEP) · 低延迟'
    S.preview.kind = 'webrtc'
    $('#previewMode').textContent = S.preview.mode
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        $('#previewMode').textContent = `${S.preview.mode} · ${pc.connectionState}`
      }
    }
    // 有些设备（如 1080p60 High@5.x）信令成功但 WebView 解不出画面，这里兜底
    watchPreviewPicture(pc, path)
  } catch (err) {
    playHls(path, `WebRTC 不可用（${err.message}）`)
  }
}

function playHls(path, reason) {
  const video = $('#previewVideo')
  if (S.preview.pc) {
    S.preview.pc.close()
    S.preview.pc = null
  }
  video.srcObject = null
  video.muted = false
  video.src = pullHls(path)
  video.play().catch(() => {
    video.muted = true
    video.play().catch(() => {})
  })
  S.preview.mode = 'HLS'
  S.preview.kind = 'hls'
  $('#previewMode').textContent = `${reason} · HLS（延迟略高）`
}

function watchPreviewPicture(pc, path) {
  const started = Date.now()
  const timer = setInterval(async () => {
    if (S.preview.path !== path) return clearInterval(timer)
    if ($('#previewVideo').videoWidth > 0) return clearInterval(timer)
    // 收到了帧却一帧没解码 = 解码器不吃这个 profile，直接回退
    try {
      const stats = await pc.getStats()
      let received = 0
      let decoded = 0
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          received = r.framesReceived ?? 0
          decoded = r.framesDecoded ?? 0
        }
      })
      if (received > 10 && decoded === 0) {
        clearInterval(timer)
        return playHls(path, 'WebRTC 解不出该码流')
      }
    } catch {
      /* 忽略统计失败 */
    }
    if (Date.now() - started > 5000) {
      clearInterval(timer)
      playHls(path, 'WebRTC 无画面')
    }
  }, 500)
}

/* ---------- 预设 ---------- */
function paintPresets() {
  const grid = $('#presetGrid')
  $('#presetCount').textContent = String(S.presets.length)
  if (!S.presets.length) {
    grid.innerHTML = `<div class="preset empty">还没有预设，下面填一台相机</div>`
    return
  }
  grid.innerHTML = S.presets
    .map((p) => {
      const url = pushUrl(p.path)
      const spec = [p.resolution, p.fps ? `${p.fps}fps` : '', p.bitrateKbps ? `${p.bitrateKbps}kbps` : '']
        .filter(Boolean)
        .join(' / ')
      return `<div class="preset">
        <div class="pTitle"><span class="pName">${p.name}</span><span class="dev">${p.device.toUpperCase()}</span></div>
        <div class="pUrl">${url}</div>
        ${spec ? `<div class="pSpec">${spec}${p.notes ? ` · ${p.notes}` : ''}</div>` : ''}
        <div class="pTip">${S.deviceHints[p.device] ?? ''}</div>
        <div class="pActions">
          <button class="btn tiny primary" data-push="${p.path}">复制推流</button>
          <button class="btn tiny" data-pull="${p.path}">复制 OBS 拉流</button>
          <button class="btn tiny" data-edit="${p.id}">编辑</button>
          <button class="btn tiny danger" data-del="${p.id}">删除</button>
        </div>
      </div>`
    })
    .join('')
}

// 预设卡片随 host 切换重绘，同样用委托
$('#presetGrid').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-push], button[data-pull], button[data-edit], button[data-del]')
  if (!btn) return
  if (btn.dataset.push) return copy(pushUrl(btn.dataset.push))
  if (btn.dataset.pull) return copy(pushUrl(btn.dataset.pull))
  if (btn.dataset.edit) return fillPreset(S.presets.find((p) => p.id === btn.dataset.edit))
  const list = S.presets.filter((p) => p.id !== btn.dataset.del)
  const r = await api.post('/api/presets', { presets: list })
  S.presets = r.presets
  paintPresets()
  toast('已删除预设')
})

function fillPreset(p) {
  if (!p) return
  $('#pfId').value = p.id
  $('#pfName').value = p.name
  $('#pfDevice').value = p.device
  $('#pfPath').value = p.path
  $('#pfBitrate').value = p.bitrateKbps || ''
  $('#pfResolution').value = p.resolution || ''
  $('#pfNotes').value = p.notes || ''
  $('#pfSave').textContent = '更新预设'
  $('#presetForm').scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function resetPresetForm() {
  $('#presetForm').reset()
  $('#pfId').value = ''
  $('#pfSave').textContent = '保存预设'
}

async function submitPreset(ev) {
  ev.preventDefault()
  const id = $('#pfId').value || `preset_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const item = {
    id,
    name: $('#pfName').value.trim(),
    device: $('#pfDevice').value,
    path: $('#pfPath').value.trim().replace(/^\/+|\/+$/g, ''),
    bitrateKbps: Number($('#pfBitrate').value) || 0,
    resolution: $('#pfResolution').value.trim(),
    notes: $('#pfNotes').value.trim(),
  }
  if (!item.name || !item.path) return toast('名称和推流路径必填')
  const idx = S.presets.findIndex((p) => p.id === id)
  const list = idx >= 0 ? S.presets.map((p) => (p.id === id ? item : p)) : [...S.presets, item]
  const r = await api.post('/api/presets', { presets: list })
  S.presets = r.presets
  paintPresets()
  resetPresetForm()
  toast(idx >= 0 ? '预设已更新' : '预设已添加')
}

/* ---------- 录制 / 日志 ---------- */
const recItems = new Map()

function createRecItem(i) {
  const li = document.createElement('li')
  li.dataset.abs = i.absPath
  li.innerHTML = `<span class="name"></span><span class="size"></span><button class="btn tiny">定位</button>`
  li.querySelector('.name').textContent = i.file
  return li
}

$('#recList').addEventListener('click', async (e) => {
  if (!e.target.closest('button')) return
  const li = e.target.closest('li[data-abs]')
  if (!li) return
  const r = await api.post('/api/open', { path: li.dataset.abs })
  if (r.error) showError(r.error)
})

function paintRecordings(rec) {
  S.recordings = rec
  $('#recSummary').textContent = `${rec.total} 个文件 · ${bytes(rec.totalSize)}`
  const list = $('#recList')
  const seen = new Set()
  for (const i of (rec.items ?? []).slice(0, 60)) {
    seen.add(i.file)
    let li = recItems.get(i.file)
    if (!li) {
      li = createRecItem(i)
      recItems.set(i.file, li)
    }
    li.querySelector('.size').textContent = `${bytes(i.size)} · ${when(i.mtime).slice(5)}`
    list.appendChild(li) // 按新→旧顺序重新排列
  }
  for (const [file, li] of recItems) {
    if (!seen.has(file)) {
      li.remove()
      recItems.delete(file)
    }
  }
}

function paintLogs(lines) {
  const box = $('#logBox')
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  box.textContent = lines?.length ? lines.slice(-160).join('\n') : '—'
  if (atBottom) box.scrollTop = box.scrollHeight
}

/* ---------- 设置表单 ---------- */
function fillForms() {
  const st = S.settings
  $('#cfgRtmp').value = st.rtmpPort
  $('#cfgHls').value = st.hlsPort
  $('#cfgWebrtc').value = st.webrtcPort
  $('#cfgApi').value = st.apiPort
  $('#cfgLan').checked = st.bindLan
  $('#cfgAuto').checked = st.autoStartServer
  $('#cfgRtsp').checked = st.rtspEnabled
  $('#cfgTranscode').value = st.transcodeBitrateKbps ?? 4000
  $('#cfgBinary').value = st.mediamtxBinary ?? ''
  $('#recEnabled').checked = st.record.enabled
  $('#recFormat').value = st.record.format
  $('#recSegment').value = st.record.segmentDuration
  $('#recPart').value = st.record.partDuration
  $('#recDelete').value = st.record.deleteAfter
}

async function saveSettings(patch) {
  const r = await api.post('/api/settings', patch)
  if (r.error) return showError(r.error)
  S.settings = r.settings
  S.ports = { rtmp: r.settings.rtmpPort, hls: r.settings.hlsPort, webrtc: r.settings.webrtcPort }
  paintServer(r.server)
  paintAddresses()
  paintPresets()
  showError(null)
  toast('已保存，流服务已按新配置重启')
}

/* ---------- 轮询 ---------- */
async function pollStreams() {
  try {
    const d = await api.get('/api/streams')
    if (d.error) return showError(d.error)
    if (d.server) paintServer(d.server)
    if (S.preview.path && !d.streams.some((s) => s.name === S.preview.path)) {
      stopPreview()
      toast('预览的流已断开')
    }
    paintStreams(d)
  } catch {
    /* 控制台重启时忽略瞬时失败 */
  }
}

async function pollLogs() {
  try {
    const d = await api.get('/api/logs?lines=200')
    paintLogs(d.lines)
  } catch {
    /* 忽略 */
  }
}

async function pollRecordings() {
  try {
    paintRecordings(await api.get('/api/recordings'))
  } catch {
    /* 忽略 */
  }
}

async function boot() {
  let st
  try {
    st = await api.get('/api/state')
  } catch {
    return showError('后端未启动：请在项目目录执行 npm start（或安装 Node.js 后用 npm run app 启动桌面窗口）')
  }
  if (st.error) return showError(`控制台异常：${st.error}`)
  S.settings = st.settings
  S.presets = st.presets
  S.deviceHints = st.deviceHints
  S.server = st.server
  S.lan = st.network.lan
  S.host = st.network.host
  S.ports = { rtmp: st.settings.rtmpPort, hls: st.settings.hlsPort, webrtc: st.settings.webrtcPort }
  S.ffmpeg = st.ffmpeg ?? null
  $('#ffmpegHint').classList.toggle('hidden', Boolean(S.ffmpeg))
  fillForms()
  paintServer(st.server)
  paintAddresses()
  paintPresets()
  pollStreams()
  pollLogs()
  pollRecordings()

  clearInterval(S.autoTimer)
  S.autoTimer = setInterval(() => {
    pollStreams()
    if (Date.now() - (S.lastLog ?? 0) > 4000) {
      S.lastLog = Date.now()
      pollLogs()
    }
    if (Date.now() - (S.lastRec ?? 0) > 9000) {
      S.lastRec = Date.now()
      pollRecordings()
    }
  }, 2000)
}

/* ---------- 事件绑定 ---------- */
$('#btnStart').addEventListener('click', async () => {
  const r = await api.post('/api/server/start')
  if (r.error) return showError(r.error)
  showError(null)
  paintServer(r.server)
  toast('流服务已启动')
})
$('#btnStop').addEventListener('click', async () => {
  stopPreview()
  const r = await api.post('/api/server/stop')
  if (r.error) return showError(r.error)
  paintServer(r.server)
  toast('流服务已停止')
})
$('#btnRestart').addEventListener('click', async () => {
  const r = await api.post('/api/server/restart')
  if (r.error) return showError(r.error)
  paintServer(r.server)
  toast('流服务已重启')
})
// 表格行由轮询增量更新，统一用事件委托绑定
$('#streamTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-preview], button[data-copyurl], button[data-transcode]')
  if (!btn || btn.disabled) return
  if (btn.dataset.preview) return startPreview(decodeURIComponent(btn.dataset.preview))
  if (btn.dataset.copyurl) return copy(pushUrl(decodeURIComponent(btn.dataset.copyurl)))

  const name = decodeURIComponent(btn.dataset.transcode)
  const active = S.transcodes?.has(name)
  btn.disabled = true
  const r = await api.post(active ? '/api/transcode/stop' : '/api/transcode/start', {
    path: name,
    bitrateKbps: S.settings.transcodeBitrateKbps,
  })
  btn.disabled = false
  if (r.error) return showError(r.error)
  showError(null)
  toast(active ? `已停止 ${name} 的转码` : `开始转码 → ${name}_avc`)
  pollStreams()
})
$('#errorDismiss').addEventListener('click', () => showError(null))
$('#copyPushBase').addEventListener('click', () => copy(`rtmp://${S.host}:${S.ports.rtmp}/`))
$('#hostSelect').addEventListener('change', (e) => {
  S.host = e.target.value
  paintAddresses()
  paintPresets()
  if (S.preview.path) paintObsUrls(S.preview.path)
})
$('#btnSaveSettings').addEventListener('click', () =>
  saveSettings({
    rtmpPort: Number($('#cfgRtmp').value) || 1935,
    hlsPort: Number($('#cfgHls').value) || 8888,
    webrtcPort: Number($('#cfgWebrtc').value) || 8889,
    apiPort: Number($('#cfgApi').value) || 9997,
    bindLan: $('#cfgLan').checked,
    autoStartServer: $('#cfgAuto').checked,
    rtspEnabled: $('#cfgRtsp').checked,
    transcodeBitrateKbps: Number($('#cfgTranscode').value) || 4000,
    mediamtxBinary: $('#cfgBinary').value.trim(),
  }),
)
$('#btnSaveRecord').addEventListener('click', () =>
  saveSettings({
    record: {
      enabled: $('#recEnabled').checked,
      format: $('#recFormat').value,
      segmentDuration: $('#recSegment').value.trim() || '1h',
      partDuration: $('#recPart').value.trim() || '1s',
      deleteAfter: $('#recDelete').value.trim() || '0s',
    },
  }),
)
$('#btnOpenRecords').addEventListener('click', async () => {
  const r = await api.post('/api/open', { path: S.recordings?.dir ?? 'recordings' })
  if (r.error) showError(r.error)
})
$('#presetForm').addEventListener('submit', submitPreset)
$('#pfReset').addEventListener('click', resetPresetForm)
$('#btnPreviewStop').addEventListener('click', stopPreview)
$('#btnPreviewMode').addEventListener('click', () => {
  if (!S.preview.path) return toast('没有正在预览的流')
  startPreview(S.preview.path, S.preview.kind === 'hls' ? 'webrtc' : 'hls')
})
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy)))

boot()
