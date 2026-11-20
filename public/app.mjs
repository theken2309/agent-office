import { officeSvg } from './scene.mjs'

const $ = id => document.getElementById(id)
const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

const fmtDur = ms => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const store = {
  get: (k, d) => {
    try {
      return localStorage.getItem(k) ?? d
    } catch {
      return d
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* chế độ riêng tư: bỏ qua */
    }
  },
}

let snap = { now: Date.now(), sessions: [], roster: [], hidden: [], notifs: [], settings: null, native: false }
/** @type {any[]} nhân vật đã đánh số, cùng thứ tự với danh sách */
let chars = []
let skew = 0
let lastSvg = ''
let tab = store.get('ao.tab', 'all')
let folded = store.get('ao.fold', '0') === '1'
let hidOpen = false
let hovered = null

const now = () => Date.now() + skew
const STATE_LABEL = { working: 'Đang làm', asking: 'Cần bạn', idle: 'Rỗi', done: 'Xong', stopped: 'Bị dừng', error: 'Lỗi' }
const SURFACE = { desktop: 'app Claude', terminal: 'terminal', vscode: 'VS Code' }
const PRIORITY = { asking: 0, working: 1, idle: 2 }

// ---------- dữ liệu ----------

const pick = x => ({
  state: x.state,
  stalled: x.stalled,
  waiting: x.waiting,
  running: x.running,
  tools: x.tools,
  lastTool: x.lastTool,
  startedAt: x.startedAt,
  endedAt: x.endedAt,
  task: x.task,
  plan: x.plan ?? [],
})

function flatten(sessions) {
  const out = []
  for (const s of sessions) {
    out.push({ key: `s:${s.id}`, isMain: true, name: 'Claude', type: s.project, session: s, interrupted: s.interrupted, ...pick(s) })
    for (const a of s.agents) out.push({ key: `a:${a.id}`, isMain: false, name: a.name, type: a.type, session: s, ...pick(a) })
  }
  return out.map((c, i) => ({ ...c, n: i + 1 }))
}

const currentItem = plan => plan.find(p => p.status === 'in_progress')
const openItems = plan => plan.filter(p => p.status === 'pending' || p.status === 'in_progress')
const queueCount = () =>
  snap.sessions.reduce((n, s) => n + s.queue.length, 0) + chars.reduce((n, c) => n + c.plan.filter(p => p.status === 'pending').length, 0)

function whatText(c) {
  const cur = c.running.at(-1)
  if (c.state === 'asking') return `❗ ${c.waiting || 'đang chờ bạn'}`
  if (c.state === 'working') {
    if (!cur) return '💭 đang nghĩ…'
    const more = c.running.length > 1 ? ` (+${c.running.length - 1} song song)` : ''
    return `⌨️ ${cur.tool}${cur.detail ? `: ${cur.detail}` : ''}${more}`
  }
  if (c.state === 'idle') return c.stalled ? '⚠️ im lặng quá 15 phút, có thể đang treo' : c.interrupted ? '⏹️ bị ngắt · đang rỗi' : '😴 rỗi, chờ việc mới'
  if (c.state === 'done') return `✅ xong${c.lastTool ? ` · tool cuối: ${c.lastTool}` : ''}`
  if (c.state === 'stopped') return c.stalled ? '⚠️ im lặng quá 15 phút, có thể đang treo' : '⏹️ bị dừng'
  return '❌ lỗi'
}

function elapsedText(c) {
  if (c.state === 'idle' && c.endedAt) return `rỗi ${fmtDur(now() - c.endedAt)}`
  if (c.state === 'asking' && c.endedAt) return `chờ ${fmtDur(now() - c.endedAt)}`
  return fmtDur((c.endedAt ?? now()) - c.startedAt)
}

/** Đồng hồ trong dải bước / tab Quy trình: data-from → data-to (trống = tới giờ). */
const tm = (from, to) => (from ? `<span class="tm" data-from="${from}"${to ? ` data-to="${to}"` : ''}>${fmtDur((to ?? now()) - from)}</span>` : '')

// ---------- mảnh giao diện ----------

const openBtn = s =>
  `<button class="open" data-open="${esc(s.id)}" title="${s.canOpen ? 'Mở chat này trong app Claude' : 'Copy lệnh claude --resume'}">${s.canOpen ? 'Mở chat ↗' : 'Copy lệnh'}</button>`

/** Nút "Xong": chỉ khi phiên rỗi — ẩn đi cho đỡ rối, có hoạt động mới thì tự hiện lại. */
const doneBtn = s =>
  s.state === 'idle'
    ? `<button class="open xong" data-hide="${esc(s.id)}" title="Ẩn phiên này cho đỡ rối. Có hoạt động mới sẽ tự hiện lại.">Xong ✓</button>`
    : ''

const btns = s => openBtn(s) + doneBtn(s)

function progHtml(plan) {
  if (!plan.length) return ''
  const done = plan.filter(p => p.status === 'completed').length
  const cur = currentItem(plan)
  return (
    `<div class="prog"><span class="bar"><i style="width:${Math.round((done / plan.length) * 100)}%"></i></span>` +
    `<span>${done}/${plan.length} việc</span>${cur ? `<span class="cur">▶ ${esc(cur.content)}</span>` : ''}</div>`
  )
}

// ---------- quy trình ----------

const ICON = { done: '✓', passed: '✓', working: '▶', asking: '❗', waiting: '❗', pending: '○', skipped: '–', stopped: '⏹', unknown: '?', error: '✗' }
const STEP_STATE = { done: 'xong', passed: 'đã qua', working: 'đang làm', asking: 'cần bạn', waiting: 'chờ bạn', pending: 'chưa tới', skipped: 'bỏ qua', stopped: 'bị dừng' }

const resultText = r => (r ? `${r.pass} PASS · ${r.fail} FAIL · ${r.notRun} NOT RUN` : '')
const loopText = st => (!st.runs ? '' : st.loopMax ? ` · vòng ${st.runs}/${st.loopMax}` : st.runs > 1 ? ` ×${st.runs}` : '')

/** Dải bước gọn trong thẻ session (tab Tất cả). Bấm → sang tab Quy trình. */
function flowStrip(fl) {
  if (!fl) return ''
  const tag = fl.ticket ? `<b>#${esc(fl.ticket)}</b> ` : ''
  let body
  if (fl.kind === 'pipeline') {
    body = fl.steps
      .map(st => {
        const extra = st.kind === 'step' && st.state === 'working' ? ` ${tm(st.agents.at(-1)?.startedAt)}` : st.result ? ` <span class="${st.result.fail ? 'bad' : 'good'}">${st.result.pass}✓ ${st.result.fail}✗</span>` : ''
        return `<span class="fs ${st.kind} ${st.state}">${ICON[st.state] ?? '·'} ${esc(st.label)}${extra}</span>`
      })
      .join('<span class="arr">›</span>')
  } else {
    const parts = []
    const steps = fl.steps
    if (steps.length) {
      const busy = steps.filter(x => x.state === 'working' || x.state === 'asking').length
      parts.push(`🔗 ${steps.length} agent: ${steps.filter(x => x.state === 'done').length} xong${busy ? ` · ${busy} đang làm` : ''}`)
    }
    for (const w of fl.workflows) parts.push(`⚙️ ${esc(w.name)}: ${w.done}/${w.total} agent · ${STEP_STATE[w.status] ?? esc(w.status)}`)
    body = parts.join(' · ')
  }
  return `<div class="flow" data-go="flow" title="Xem chi tiết ở tab Quy trình">${tag}${body}</div>`
}

function stepItem(st, fl) {
  if (st.kind === 'gate') {
    const time =
      st.state === 'waiting' && st.askedAt ? ` · chờ ${tm(st.askedAt)}` : st.state === 'passed' && st.askedAt && st.answeredAt ? ` · trả lời sau ${tm(st.askedAt, st.answeredAt)}` : ''
    return (
      `<li class="gate ${st.state}"><span class="ic">${ICON[st.state] ?? '·'}</span><div>` +
      `<b>${esc(st.label)}</b> <span class="ty">${st.state === 'passed' && st.answer ? 'bạn đã trả lời' : STEP_STATE[st.state] ?? ''}${time}</span>` +
      (st.question ? `<div class="gq">❓ ${esc(st.question)}</div>` : '') +
      (st.answer ? `<div class="ga">↳ ${esc(st.answer)}</div>` : '') +
      `</div></li>`
    )
  }
  const last = st.agents.at(-1)
  const time = st.startedAt ? ` · ${tm(st.startedAt, st.state === 'working' || st.state === 'asking' ? null : st.endedAt)}` : ''
  const name = fl.kind === 'pipeline' ? (last ? `<div class="ty">${esc(last.name)}</div>` : '') : `<div class="ty">${esc(st.name ?? '')}</div>`
  return (
    `<li class="step ${st.state}"><span class="ic">${ICON[st.state] ?? '·'}</span><div>` +
    `<b>${esc(st.label)}</b> <span class="ty">${STEP_STATE[st.state] ?? st.state}${loopText(st)}${time}</span>` +
    (last?.stalled ? ` <span class="bad">⚠️ có thể đang treo</span>` : '') +
    name +
    (st.result ? `<div class="${st.result.fail ? 'bad' : 'good'}">${resultText(st.result)}</div>` : '') +
    (st.report ? `<div class="rep">${esc(st.report)}</div>` : '') +
    `</div></li>`
  )
}

function workflowHtml(w) {
  const time = w.startedAt ? ` · ${tm(w.startedAt, w.endedAt)}` : ''
  return (
    `<div class="wf"><b>⚙️ ${esc(w.name)}</b> <span class="ty">${STEP_STATE[w.status] ?? esc(w.status)} · ${w.done}/${w.total} agent${time}</span>` +
    (w.phases.length
      ? `<div class="phases">${w.phases
          .map(p => `<span class="fs step ${p.state}">${ICON[p.state] ?? '·'} ${esc(p.title)}${p.total ? ` ${p.done}/${p.total}` : ''}</span>`)
          .join('<span class="arr">›</span>')}</div>`
      : '') +
    (w.summary ? `<div class="rep">${esc(w.summary)}</div>` : '') +
    `</div>`
  )
}

function flowBox(s) {
  const fl = s.flow
  const others = fl.others.length
    ? `<div class="sub" style="white-space:normal">Agent khác: ${fl.others.map(a => `${esc(a.type)} ${ICON[a.state] ?? ''}`).join(', ')}</div>`
    : ''
  return (
    `<div class="box st-${s.state}">` +
    `<div class="head"><span class="pill ${s.state}">${STATE_LABEL[s.state]}</span><span class="title" title="${esc(s.title)}">${esc(s.title)}</span>${btns(s)}</div>` +
    `<div class="sub">${esc(fl.name)}${fl.ticket ? ` · #${esc(fl.ticket)}` : ''} · ${esc(s.project)}</div>` +
    (fl.steps.length ? `<ol class="steps">${fl.steps.map(st => stepItem(st, fl)).join('')}</ol>` : '') +
    others +
    fl.workflows.map(workflowHtml).join('') +
    `</div>`
  )
}

// ---------- hàng / hộp ----------

const rowHtml = c =>
  `<div class="row st-${c.state}${c.isMain ? '' : ' sub'}" data-n="${c.n}">` +
  `<div class="who"><span class="n">${c.n}</span>${esc(c.name)} <span class="ty">(${esc(c.type)})</span></div>` +
  `<div class="meta"><span class="el" data-n="${c.n}">${elapsedText(c)}</span> · ${c.tools} tool</div>` +
  `<div class="what">${esc(whatText(c))}</div></div>`

function sessionBox(s) {
  const rows = chars.filter(c => c.session.id === s.id)
  return (
    `<div class="box st-${s.state}">` +
    `<div class="head"><span class="pill ${s.state}">${STATE_LABEL[s.state]}</span><span class="title" title="${esc(s.title)}">${esc(s.title)}</span>${btns(s)}</div>` +
    `<div class="sub">${esc(s.project)} · ${SURFACE[s.surface] ?? s.surface}</div>` +
    (s.state === 'asking' && s.waiting ? `<div class="ask">❗ ${esc(s.waiting)}</div>` : '') +
    flowStrip(s.flow) +
    progHtml(s.plan) +
    rows.map(rowHtml).join('') +
    `</div>`
  )
}

/** Hộp cho một nhân vật (dùng ở Cần bạn / Đang làm / Rỗi). */
function charBox(c, extra = '') {
  return (
    `<div class="box st-${c.state}">` +
    `<div class="head"><span class="n">${c.n}</span><span class="title">${esc(c.name)} <span class="ty">(${esc(c.type)})</span></span>${c.isMain ? btns(c.session) : openBtn(c.session)}</div>` +
    `<div class="sub">${c.isMain ? 'Session' : 'Thuộc'}: ${esc(c.session.title)} · <span class="el" data-n="${c.n}">${elapsedText(c)}</span> · ${c.tools} tool</div>` +
    extra +
    `</div>`
  )
}

function hiddenHtml() {
  const list = snap.hidden ?? []
  if (!list.length) return ''
  return (
    `<details class="hid"${hidOpen ? ' open' : ''}><summary>Đã ẩn (${list.length}) — tự hiện lại khi có hoạt động mới</summary>` +
    list
      .map(
        h =>
          `<div class="hrow"><div class="ht"><div class="title">${esc(h.title)}</div><div class="ty">${esc(h.project)} · ẩn ${fmtDur(now() - h.hiddenAt)} trước</div></div>` +
          `<button class="open" data-unhide="${esc(h.id)}">Hiện lại</button></div>`,
      )
      .join('') +
    `</details>`
  )
}

const empty = text => `<div class="empty">${text}</div>`

// ---------- các tab ----------

const VIEWS = {
  all() {
    const html = snap.sessions.length
      ? [...snap.sessions]
          .sort((a, b) => (PRIORITY[a.state] ?? 3) - (PRIORITY[b.state] ?? 3) || a.firstAt - b.firstAt)
          .map(sessionBox)
          .join('')
      : empty('Chưa có session Claude Code nào hoạt động trong 30 phút qua.')
    return html + hiddenHtml()
  },

  ask() {
    const list = chars.filter(c => c.state === 'asking')
    if (!list.length) return empty('Không ai đang chờ bạn 🎉')
    return list
      .map(c =>
        charBox(
          c,
          `<div class="ask">❗ ${esc(c.waiting || 'Đang chờ bạn')}</div>` +
            (c.isMain && c.session.recap ? `<div class="recap">Lượt vừa rồi: ${esc(c.session.recap)}</div>` : ''),
        ),
      )
      .join('')
  },

  work() {
    const list = chars.filter(c => c.state === 'working')
    if (!list.length) return empty('Không agent nào đang làm.')
    return list.map(c => charBox(c, `<div class="what st-working" style="color:var(--tool)">${esc(whatText(c))}</div>${progHtml(c.plan)}`)).join('')
  },

  idle() {
    const list = snap.sessions.filter(s => s.state === 'idle').sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    const free = snap.roster.filter(r => !r.busy.length)
    let html = list.length
      ? list
          .map(s => {
            const c = chars.find(ch => ch.key === `s:${s.id}`)
            return charBox(
              c,
              (s.recap ? `<div class="recap">Lượt vừa rồi: ${esc(s.recap)}</div>` : s.task ? `<div class="recap">Việc cuối: ${esc(s.task)}</div>` : '') +
                (openItems(s.plan).length ? `<div class="recap">Còn ${openItems(s.plan).length} việc dở trong danh sách.</div>` : ''),
            )
          })
          .join('')
      : empty('Không session nào đang rỗi.')
    html += hiddenHtml()
    html += `<h3>Đội agent đang rảnh (${free.length}/${snap.roster.length})</h3>`
    html += free.length
      ? `<div class="box">${free.map(r => `<span class="pill idle" style="margin:2px;display:inline-block">${esc(r.name)}</span>`).join(' ')}</div>`
      : empty('Cả đội đang bận.')
    return html
  },

  flow() {
    const list = snap.sessions.filter(s => s.flow)
    if (!list.length)
      return empty(
        'Chưa phiên nào chạy quy trình nhiều agent.<br>Phiên gọi planner / ui-designer / coder / tester (khai báo trong <code>pipelines.json</code>), chạy Workflow, hoặc gọi từ 2 subagent trở lên sẽ hiện ở đây.',
      )
    return list.sort((a, b) => (PRIORITY[a.state] ?? 3) - (PRIORITY[b.state] ?? 3) || b.firstAt - a.firstAt).map(flowBox).join('')
  },

  queue() {
    let html = ''
    const msgs = snap.sessions.filter(s => s.queue.length)
    if (msgs.length) {
      html += `<h3>Tin nhắn đang xếp hàng</h3>`
      html += msgs
        .map(
          s =>
            `<div class="box"><div class="head"><span class="title">${esc(s.title)}</span>${openBtn(s)}</div>` +
            `<ul class="items">${s.queue.map(q => `<li class="msg">${esc(q.text)}</li>`).join('')}</ul></div>`,
        )
        .join('')
    }
    const owners = chars.filter(c => openItems(c.plan).length)
    if (owners.length) {
      html += `<h3>Việc chưa xong (theo agent)</h3>`
      html += owners
        .map(c =>
          charBox(
            c,
            `<div class="sub">${STATE_LABEL[c.state]}${c.state === 'idle' ? ' — việc dở, chưa ai làm tiếp' : ''}</div>` +
              `<ul class="items">${openItems(c.plan)
                .map(p => `<li class="${p.status}">${esc(p.content)}</li>`)
                .join('')}</ul>`,
          ),
        )
        .join('')
    }
    return html || empty('Hàng chờ trống: không có tin nhắn xếp hàng hay việc nào chưa xong.')
  },

  team() {
    if (!snap.roster.length) return empty('Không tìm thấy định nghĩa agent nào.')
    const sorted = [...snap.roster].sort((a, b) => b.busy.length - a.busy.length || a.name.localeCompare(b.name))
    return (
      `<div class="team">` +
      sorted
        .map(
          r =>
            `<div class="box"><div class="head"><span class="title">${esc(r.name)}</span><span class="ty">${esc(r.source)}</span></div>` +
            (r.busy.length
              ? `<div class="busy">Bận ×${r.busy.length}</div><ul class="items">${r.busy
                  .map(b => `<li class="in_progress">${esc(b.name)} <span class="ty">— ${esc(b.session)}</span></li>`)
                  .join('')}</ul>`
              : `<div class="free">Rỗi</div>`) +
            (r.doneRecently ? `<div class="ty">Vừa xong ${r.doneRecently} việc</div>` : '') +
            (r.description ? `<div class="desc">${esc(r.description)}</div>` : '') +
            `</div>`,
        )
        .join('') +
      `</div>`
    )
  },
}

// ---------- vẽ ----------

function render() {
  chars = flatten(snap.sessions)
  const asking = chars.filter(c => c.state === 'asking').length
  const counts = {
    all: chars.length,
    ask: asking,
    work: chars.filter(c => c.state === 'working').length,
    idle: snap.sessions.filter(s => s.state === 'idle').length,
    flow: snap.sessions.filter(s => s.flow).length,
    queue: queueCount(),
    team: snap.roster.filter(r => !r.busy.length).length,
  }
  for (const [k, v] of Object.entries(counts)) $(`c-${k}`).textContent = String(v)
  $('c-team').title = 'Số loại agent đang rảnh'
  document.querySelector('[data-tab="ask"]').classList.toggle('hot', asking > 0)
  document.querySelector('[data-tab="flow"]').classList.toggle('hot', snap.sessions.some(s => s.flow?.current?.state === 'waiting'))
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('cur', b.dataset.tab === tab)
  document.title = asking ? `(${asking}) Agent Office` : 'Agent Office'

  const svg = officeSvg(chars, queueCount())
  // Chỉ thay hình khi cảnh đổi, để animation không bị chạy lại vô cớ.
  if (svg !== lastSvg) {
    $('office').innerHTML = svg
    lastSvg = svg
  }
  $('view').innerHTML = (VIEWS[tab] ?? VIEWS.all)()
  if (hovered) showCard(hovered.n, hovered.x, hovered.y)
  paintBell()
}

let bootBuild = null

function applySnapshot(next) {
  // server được cập nhật/khởi động lại → tải lại trang để lấy giao diện mới
  if (bootBuild && next.build && next.build !== bootBuild) return location.reload()
  bootBuild ??= next.build
  snap = next
  skew = next.now - Date.now()
  render()
  deliverNotifs()
}

// ---------- gọi server ----------

const post = (p, body) =>
  fetch(p, {
    method: 'POST',
    headers: { 'x-agent-office': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })

let toastTimer = 0
function toast(text, action) {
  const t = $('toast')
  t.innerHTML = esc(text) + (action ? ` <button class="tbtn">${esc(action.label)}</button>` : '')
  if (action)
    t.querySelector('.tbtn').addEventListener('click', () => {
      t.style.display = 'none'
      action.fn()
    })
  t.style.display = 'block'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.style.display = 'none'), action ? 5000 : 2600)
}

async function openChat(id) {
  try {
    const res = await post(`/open?session=${encodeURIComponent(id)}`)
    const j = await res.json()
    if (j.opened) toast('Đang mở chat trong app Claude…')
    else if (j.copy) {
      await navigator.clipboard.writeText(j.copy).catch(() => {})
      toast(`Session chạy ở terminal — đã copy: ${j.copy}`)
    } else toast(`Không mở được: ${j.error ?? res.status}`)
  } catch {
    toast('Không mở được chat (server không phản hồi)')
  }
}

async function setHidden(id, hide) {
  try {
    const res = await post(`/${hide ? 'hide' : 'unhide'}?session=${encodeURIComponent(id)}`)
    if (!res.ok) throw new Error(String(res.status))
  } catch {
    return toast('Không gọi được server')
  }
  if (hide) {
    const title = snap.sessions.find(s => s.id === id)?.title ?? 'phiên'
    toast(`Đã ẩn: ${title}`, { label: 'Hoàn tác', fn: () => void setHidden(id, false) })
  } else toast('Đã hiện lại')
}

// ---------- thông báo ----------

/** id thông báo đã thấy; lần đầu nhận snapshot thì đánh dấu hết (không phát lại cái cũ). */
let seenNotifs = null
const canBrowserNotify = () => 'Notification' in window && Notification.permission === 'granted'

function deliverNotifs() {
  const list = snap.notifs ?? []
  if (!seenNotifs) {
    seenNotifs = new Set(list.map(n => n.id))
    return
  }
  for (const n of list) {
    if (seenNotifs.has(n.id)) continue
    seenNotifs.add(n.id)
    // bong bóng đang lo thông báo macOS → cửa sổ này không báo trùng
    if (!snap.native && canBrowserNotify()) sendBrowser(n)
  }
}

function sendBrowser(n) {
  try {
    const x = new Notification(n.title, { body: n.body, tag: n.id })
    x.onclick = () => {
      window.focus()
      if (n.sessionId) void openChat(n.sessionId)
    }
  } catch {
    /* trình duyệt chặn */
  }
}

const NOTIFY_LABEL = {
  ask: 'Cần bạn / chờ duyệt (Plan, UI spec…)',
  turn: 'Phiên xong lượt',
  step: 'Bước quy trình xong (planner, tester PASS/FAIL, workflow…)',
  stall: 'Agent có thể đang treo (im lặng > 15 phút)',
  sub: 'Subagent lẻ xong (Explore, general-purpose…)',
}

function paintBell() {
  const st = snap.settings
  const on = Boolean(st?.enabled)
  $('bell').textContent = on ? '🔔' : '🔕'
  $('bell').classList.toggle('on', on)
  if ($('nmenu').hidden || !st) return
  $('nmenu').querySelector('[data-k="enabled"]').checked = on
  for (const k of Object.keys(NOTIFY_LABEL)) {
    const box = $('nmenu').querySelector(`[data-k="${k}"]`)
    box.checked = Boolean(st.types[k])
    box.disabled = !on
  }
  let via
  const denied = snap.bubbleDenied
    ? '⚠️ macOS đang chặn thông báo của Agent Bubble. Mở <b>Cài đặt hệ thống › Thông báo › Agent Bubble</b> và bật <b>Cho phép thông báo</b> (bong bóng tự nhận trong ~30 giây). '
    : ''
  if (snap.native) via = '✅ Hiện bằng thông báo macOS qua bong bóng Agent Bubble (cả khi đóng cửa sổ này).'
  else if (denied) via = denied + (canBrowserNotify() ? 'Trong lúc đó cửa sổ này báo thay.' : '')
  else if (canBrowserNotify()) via = '⚠️ Bong bóng chưa bật thông báo → đang báo qua cửa sổ này (đóng cửa sổ là mất).'
  else if ('Notification' in window)
    via = '⚠️ Bong bóng chưa bật thông báo và cửa sổ này chưa được phép. <button class="ibtn" id="nallow">Cho phép ở cửa sổ này</button>'
  else via = '⚠️ Bong bóng chưa bật thông báo macOS. Build lại bằng <code>./make-bubble.sh</code>.'
  $('nvia').innerHTML = via
}

function buildMenu() {
  $('nmenu').innerHTML =
    `<label class="master"><input type="checkbox" data-k="enabled"> Bật thông báo</label>` +
    Object.entries(NOTIFY_LABEL)
      .map(([k, label]) => `<label><input type="checkbox" data-k="${k}"> ${esc(label)}</label>`)
      .join('') +
    `<div class="via" id="nvia"></div>` +
    `<button class="ibtn" id="ntest">Thử thông báo</button>`
}

$('bell').addEventListener('click', ev => {
  ev.stopPropagation()
  $('nmenu').hidden = !$('nmenu').hidden
  paintBell()
})

$('nmenu').addEventListener('click', ev => ev.stopPropagation())

$('nmenu').addEventListener('change', async ev => {
  const box = ev.target instanceof HTMLInputElement ? ev.target : null
  const k = box?.dataset.k
  if (!k) return
  const body = k === 'enabled' ? { enabled: box.checked } : { types: { [k]: box.checked } }
  try {
    const res = await post('/settings', body)
    snap.settings = await res.json()
  } catch {
    toast('Không lưu được cài đặt thông báo')
  }
  paintBell()
})

$('nmenu').addEventListener('click', async ev => {
  const el = ev.target instanceof Element ? ev.target : null
  if (el?.id === 'nallow') {
    const p = await Notification.requestPermission()
    toast(p === 'granted' ? 'Cửa sổ này sẽ báo khi bong bóng không chạy' : 'Trình duyệt chưa cho phép thông báo')
    paintBell()
  } else if (el?.id === 'ntest') {
    try {
      const j = await (await post('/notify-test')).json()
      toast(j.native ? 'Đã gửi thử qua bong bóng (thông báo macOS)' : canBrowserNotify() ? 'Đã gửi thử qua cửa sổ này' : 'Chưa có kênh nào hiện được thông báo')
    } catch {
      toast('Không gọi được server')
    }
  }
})

document.addEventListener('click', () => {
  if (!$('nmenu').hidden) $('nmenu').hidden = true
})

function paintFold() {
  $('office').classList.toggle('folded', folded)
  $('fold').textContent = folded ? '▸' : '▾'
}
$('fold').addEventListener('click', () => {
  folded = !folded
  store.set('ao.fold', folded ? '1' : '0')
  paintFold()
})

// ---------- click / rê chuột ----------

function setTab(next) {
  tab = next
  store.set('ao.tab', tab)
  render()
}

$('tabs').addEventListener('click', ev => {
  const b = ev.target instanceof Element ? ev.target.closest('button[data-tab]') : null
  if (b) setTab(b.dataset.tab)
})

document.addEventListener('click', ev => {
  if (!(ev.target instanceof Element)) return
  const open = ev.target.closest('[data-open]')
  if (open) return void openChat(open.getAttribute('data-open'))
  const hide = ev.target.closest('[data-hide]')
  if (hide) return void setHidden(hide.getAttribute('data-hide'), true)
  const unhide = ev.target.closest('[data-unhide]')
  if (unhide) return void setHidden(unhide.getAttribute('data-unhide'), false)
  const go = ev.target.closest('[data-go]')
  if (go) return setTab(go.getAttribute('data-go'))
  const el = ev.target.closest('#office [data-n], #view .row[data-n]')
  if (!el) return
  const c = chars.find(ch => ch.n === Number(el.getAttribute('data-n')))
  if (c) void openChat(c.session.id)
})

// nhớ trạng thái mở/đóng của mục "Đã ẩn" qua các lần vẽ lại
document.addEventListener(
  'toggle',
  ev => {
    if (ev.target instanceof HTMLDetailsElement && ev.target.classList.contains('hid')) hidOpen = ev.target.open
  },
  true,
)

function cardHtml(c) {
  const running = c.running.length
    ? `<div class="lbl">Đang chạy</div><ul>${c.running.map(r => `<li><b>${esc(r.tool)}</b>${r.detail ? ` ${esc(r.detail)}` : ''}</li>`).join('')}</ul>`
    : ''
  const cur = currentItem(c.plan)
  const done = c.plan.filter(p => p.status === 'completed').length
  const plan = c.plan.length ? `<div class="lbl">Danh sách việc ${done}/${c.plan.length}</div>${cur ? `<div>▶ ${esc(cur.content)}</div>` : ''}` : ''
  const fl = c.isMain ? c.session.flow : null
  const flow = fl?.current ? `<div class="lbl">${esc(fl.name)}${fl.ticket ? ` #${esc(fl.ticket)}` : ''}</div><div>${ICON[fl.current.state] ?? ''} ${esc(fl.current.label)} — ${STEP_STATE[fl.current.state] ?? ''}</div>` : ''
  const task = c.task ? `<div class="lbl">${c.isMain ? 'Yêu cầu gần nhất' : 'Tác vụ được giao'}</div><div class="task">${esc(c.task)}</div>` : ''
  return (
    `<div class="hd"><span class="n">${c.n}</span>${esc(c.name)} <span class="ty">(${esc(c.type)})</span></div>` +
    `<div class="muted">${c.isMain ? 'Session' : 'Thuộc'}: ${esc(c.session.title)}</div>` +
    `<div style="margin-top:4px;font-weight:700">${esc(whatText(c))}</div>` +
    running +
    flow +
    plan +
    task +
    `<div class="muted" style="margin-top:6px">${c.tools} tool${c.lastTool ? ` · cuối: ${esc(c.lastTool)}` : ''} · ⏱ ${elapsedText(c)}</div>` +
    `<div class="hint">${c.session.canOpen ? 'Click để mở chat ↗' : 'Click để copy lệnh resume'}</div>`
  )
}

function showCard(n, x, y) {
  const c = chars.find(ch => ch.n === n)
  const card = $('card')
  if (!c) {
    card.style.display = 'none'
    hovered = null
    return
  }
  hovered = { n, x, y }
  card.innerHTML = cardHtml(c)
  card.style.display = 'block'
  const pad = 14
  const rect = card.getBoundingClientRect()
  let left = x + pad
  let top = y + pad
  if (left + rect.width > innerWidth - 4) left = Math.max(4, x - rect.width - pad)
  if (top + rect.height > innerHeight - 4) top = Math.max(4, y - rect.height - pad)
  card.style.left = `${left}px`
  card.style.top = `${top}px`
}

function hideCard() {
  $('card').style.display = 'none'
  hovered = null
}

document.addEventListener('mousemove', ev => {
  const el = ev.target instanceof Element ? ev.target.closest('#office [data-n], #view .row[data-n]') : null
  if (!el) return hideCard()
  showCard(Number(el.getAttribute('data-n')), ev.clientX, ev.clientY)
})
document.addEventListener('mouseleave', hideCard)

// ---------- nối server ----------

function connect() {
  const es = new EventSource('/events')
  es.onopen = () => {
    $('off').style.display = 'none'
    $('dot').classList.remove('off')
  }
  es.onmessage = ev => applySnapshot(JSON.parse(ev.data))
  es.onerror = () => {
    $('off').style.display = 'block'
    $('dot').classList.add('off')
  }
}

// đồng hồ (chỉ sửa chữ, không vẽ lại cảnh)
setInterval(() => {
  for (const el of document.querySelectorAll('.el[data-n]')) {
    const c = chars.find(ch => ch.n === Number(el.getAttribute('data-n')))
    if (c) el.textContent = elapsedText(c)
  }
  for (const el of document.querySelectorAll('.tm[data-from]')) {
    if (el.hasAttribute('data-to')) continue
    el.textContent = fmtDur(now() - Number(el.getAttribute('data-from')))
  }
  if (hovered) showCard(hovered.n, hovered.x, hovered.y)
}, 1000)

buildMenu()
paintBell()
paintFold()
connect()
