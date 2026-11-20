// Agent Office — server nhỏ đọc log transcript của Claude Code và đẩy trạng thái agent lên trang web.
// Không cần thư viện ngoài (Node 18+). Chỉ nghe trên 127.0.0.1.
//
//   node server.mjs            → http://127.0.0.1:47321
//   PORT=5000 node server.mjs  → đổi cổng
//   ACTIVE_MINUTES=60          → hiện session có hoạt động trong 60 phút gần nhất (mặc định 30)

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = os.homedir()
const ROOT = process.env.CLAUDE_PROJECTS ?? path.join(HOME, '.claude', 'projects')
const DESKTOP_SESSIONS = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
const PORT = Number(process.env.PORT ?? 47321)
const ACTIVE_MS = Number(process.env.ACTIVE_MINUTES ?? 30) * 60_000
/** Đang "làm" mà log im quá lâu → coi như treo/không hoạt động. */
const STALE_MS = 15 * 60_000
/** Subagent xong rồi vẫn ngồi sofa chừng này trước khi biến mất. */
const DONE_KEEP_MS = 10 * 60_000
/** File log lớn: lần đầu chỉ đọc phần cuối. */
const FIRST_READ_BYTES = 3 * 1024 * 1024
/** Đọc phần đầu file subagent lớn để biết lúc bắt đầu + việc được giao. */
const HEAD_BYTES = 64 * 1024
/** Gom các sự kiện của cùng một phiên xảy ra sát nhau thành một thông báo. */
const NOTIFY_GATHER_MS = 2500
/** Thông báo giữ trong snapshot bao lâu (client vừa nối lại vẫn kịp nhận). */
const NOTIFY_KEEP_MS = 2 * 60_000

const APP_DIR = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(APP_DIR, 'public')
const PIPELINES_FILE = process.env.PIPELINES ?? path.join(APP_DIR, 'pipelines.json')
const STATE_DIR = path.join(HOME, '.agent-office')
const HIDDEN_FILE = path.join(STATE_DIR, 'hidden.json')
const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json')
/** Đổi mỗi lần server khởi động: trang thấy khác thì tự tải lại. */
const BUILD = String(Date.now())
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TICKET_FILE = /\/tickets\/ticket_([^/]+?)\.md$/
const TICKET_TEXT = /\bticket[\s_#-]*(\d{3,6})\b/i

const BUILTIN_AGENTS = [
  { name: 'general-purpose', description: 'Agent đa năng: tìm hiểu, sửa code, làm việc nhiều bước.' },
  { name: 'Explore', description: 'Tìm kiếm nhanh trong codebase, chỉ đọc.' },
  { name: 'Plan', description: 'Thiết kế phương án triển khai, chỉ đọc.' },
]

/** Loại thông báo (bật/tắt từng loại trong menu 🔔). */
const NOTIFY_TYPES = ['ask', 'turn', 'step', 'stall', 'sub']
const DEFAULT_SETTINGS = { enabled: true, types: { ask: true, turn: true, step: true, stall: true, sub: false } }

// ---------- tiện ích ----------

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const toolName = name => (name.startsWith('mcp__') ? name.split('__').pop() ?? name : name)

function detailOf(input) {
  if (!input || typeof input !== 'object') return ''
  for (const key of ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'skill', 'prompt']) {
    const v = input[key]
    if (typeof v !== 'string' || !v.trim()) continue
    const text = key === 'file_path' || key === 'path' ? v.split('/').pop() ?? v : v
    return truncate(oneLine(text), 60)
  }
  return ''
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b?.type === 'text')
    .map(b => b.text)
    .join(' ')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2))
    fs.renameSync(`${file}.tmp`, file)
  } catch (err) {
    console.error(`Không ghi được ${file}: ${err}`)
  }
}

/** Câu trả lời AskUserQuestion: `"câu hỏi"="đáp án"` → `đáp án`. */
function answerText(text) {
  const picks = [...String(text).matchAll(/"=\s*"([^"]*)"/g)].map(m => m[1])
  return truncate(oneLine(picks.length ? picks.join(' · ') : text), 300)
}

/** Tên + các phase của Workflow, đọc từ `export const meta = {...}` trong script. */
function workflowMeta(input) {
  const script = typeof input?.script === 'string' ? input.script : ''
  const meta = script.match(/export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/)?.[1] ?? script.slice(0, 4000)
  const name = (typeof input?.name === 'string' && input.name) || meta.match(/name\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] || 'workflow'
  const block = meta.match(/phases\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? ''
  return { name, phases: [...block.matchAll(/title\s*:\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]) }
}

/** Đếm PASS / FAIL / NOT RUN trong báo cáo của tester (lấy con số đầu tiên của mỗi loại). */
function testResult(text) {
  const num = re => {
    const m = String(text ?? '').match(re)
    return m ? Number(m[1]) : null
  }
  const pass = num(/(\d+)\s*PASS\b/)
  const fail = num(/(\d+)\s*FAIL\b/)
  if (pass === null && fail === null) return null
  return { pass: pass ?? 0, fail: fail ?? 0, notRun: num(/(\d+)\s*NOT\s*RUN\b/) ?? 0 }
}

/** Vài dòng đầu có nội dung của báo cáo (bỏ dấu markdown). */
function summaryOf(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map(l => l.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
  return truncate(oneLine(lines.slice(0, 3).join(' · ')), 280)
}

// ---------- đọc log ----------

function newLoop(kind) {
  return {
    kind, // 'session' | 'agent'
    /** @type {Map<string, { tool: string, detail: string, at: number, question?: string }>} */
    pending: new Map(),
    results: new Set(),
    last: '', // 'prompt' | 'assistant' | 'result' | 'interrupt'
    stop: null,
    lastHasText: false,
    lastHasTool: false,
    handedBack: false,
    turnStart: 0,
    firstAt: 0,
    lastAt: 0,
    tools: 0,
    lastTool: null,
    prompt: '',
    title: '',
    agentName: '',
    lastPrompt: '',
    cwd: '',
    entrypoint: '',
    /** Danh sách việc (update_plan / TodoWrite / TaskCreate). */
    plan: /** @type {{ id?: string, content: string, status: string }[]} */ ([]),
    taskSeq: 0,
    /** Tin nhắn bạn gửi đang xếp hàng chờ agent xử lý. */
    queue: /** @type {{ text: string, at: number }[]} */ ([]),
    /** Câu hỏi cuối lượt (wrap_up `ask`), xoá khi bạn gửi prompt mới. */
    ask: null,
    recap: '',
    /** Mốc hội thoại của session: câu bạn được hỏi, câu bạn trả lời — để dựng cổng duyệt. */
    events: /** @type {{ t: number, kind: 'ask' | 'answer' | 'prompt', text: string, id?: string }[]} */ ([]),
    /** Báo cáo cuối của subagent (SubagentHandback). */
    report: '',
    lastText: '',
    /** Mã ticket: từ file .workspace/tickets/ticket_<id>.md agent đụng tới, hoặc đoán từ prompt. */
    ticket: '',
    ticketHint: '',
    /** Workflow đã chạy: toolUseId → { t, name, phases, runId } */
    workflows: new Map(),
  }
}

function pushEvent(L, e) {
  if (L.kind !== 'session') return
  L.events.push(e)
  if (L.events.length > 300) L.events.splice(0, L.events.length - 300)
}

/** meta.json của subagent: engine ghi thêm `finished: true` khi agent xong. */
const readMeta = file => readJson(file.replace(/\.jsonl$/, '.meta.json')) ?? {}

function applyPlan(L, input) {
  if (Array.isArray(input.items)) {
    L.plan = input.items.map(i => ({ content: oneLine(i?.content), status: String(i?.status ?? 'pending') }))
  }
  if (input.advance) {
    const cur = L.plan.find(p => p.status === 'in_progress')
    if (cur) cur.status = 'completed'
    const next = L.plan.find(p => p.status === 'pending')
    if (next) next.status = 'in_progress'
  }
  if (Array.isArray(input.done)) for (const n of input.done) if (L.plan[n - 1]) L.plan[n - 1].status = 'completed'
  if (typeof input.start === 'number' && L.plan[input.start - 1]) L.plan[input.start - 1].status = 'in_progress'
}

function applyToolUse(L, b, t) {
  const name = String(b.name ?? '?')
  const input = b.input ?? {}
  const short = toolName(name)
  if (name === 'SubagentHandback') {
    L.handedBack = true
    if (typeof input.message === 'string') L.report = truncate(input.message, 6000)
  }
  if (short === 'update_plan') applyPlan(L, input)
  else if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    L.plan = input.todos.map(td => ({ content: oneLine(td?.content), status: String(td?.status ?? 'pending') }))
  } else if (name === 'TaskCreate') {
    L.plan.push({ id: String(++L.taskSeq), content: oneLine(input.subject ?? input.description), status: 'pending' })
  } else if (name === 'TaskUpdate') {
    const item = L.plan.find(p => p.id === String(input.taskId))
    if (item) {
      if (input.status === 'deleted') L.plan = L.plan.filter(p => p !== item)
      else if (input.status) item.status = String(input.status)
      if (input.subject) item.content = oneLine(input.subject)
    }
  } else if (short === 'wrap_up') {
    L.ask = input.ask ? oneLine(input.ask) : null
    L.recap = oneLine(input.recap)
    for (const p of L.plan) if (p.status === 'in_progress') p.status = 'completed'
    if (L.ask) pushEvent(L, { t, kind: 'ask', text: L.ask })
  } else if (name === 'Workflow') {
    L.workflows.set(b.id, { t, ...workflowMeta(input), runId: '' })
  }
  const file = typeof input.file_path === 'string' ? input.file_path : ''
  const ticket = file.match(TICKET_FILE)?.[1]
  if (ticket) L.ticket = ticket
  let question
  if (name === 'AskUserQuestion') {
    question = oneLine(input.questions?.[0]?.question ?? 'Đang hỏi bạn')
    pushEvent(L, { t, kind: 'ask', text: question, id: b.id })
  } else if (name === 'ExitPlanMode') question = 'Chờ bạn duyệt kế hoạch'
  L.pending.set(b.id, { tool: short, detail: detailOf(input), at: t, question })
  L.tools++
}

function apply(L, o) {
  switch (o.type) {
    case 'custom-title':
      if (o.customTitle) L.title = o.customTitle
      return
    case 'agent-name':
      if (o.agentName) L.agentName = o.agentName
      return
    case 'last-prompt':
      if (o.lastPrompt) L.lastPrompt = o.lastPrompt
      return
    case 'queue-operation': {
      const t = Date.parse(o.timestamp ?? '') || 0
      const text = oneLine(o.content)
      if (o.operation === 'enqueue') {
        // bỏ thông báo hệ thống (<task-notification> …), chỉ giữ tin nhắn của người
        if (text && !text.startsWith('<')) L.queue.push({ text, at: t })
        else L.queue.push({ text: '', at: t })
      } else if (o.operation === 'dequeue') L.queue.shift()
      else if (o.operation === 'remove' || o.operation === 'clear' || o.operation === 'popAll') L.queue = []
      return
    }
  }
  if (o.type !== 'user' && o.type !== 'assistant') return
  if (o.cwd) L.cwd = o.cwd
  if (o.entrypoint) L.entrypoint = o.entrypoint
  const t = Date.parse(o.timestamp ?? '') || 0
  if (t) {
    L.lastAt = Math.max(L.lastAt, t)
    if (!L.firstAt) L.firstAt = t
  }
  const content = o.message?.content

  if (o.type === 'assistant') {
    const blocks = Array.isArray(content) ? content : []
    L.lastHasText = blocks.some(b => b?.type === 'text')
    if (L.lastHasText) L.lastText = truncate(textOf(blocks), 4000)
    L.lastHasTool = false
    for (const b of blocks) {
      if (b?.type !== 'tool_use') continue
      L.lastHasTool = true
      applyToolUse(L, b, t)
    }
    L.last = 'assistant'
    L.stop = o.message?.stop_reason ?? null
    return
  }

  // user
  const hasResult = Array.isArray(content) && content.some(b => b?.type === 'tool_result')
  if (hasResult) {
    for (const b of content) {
      if (b?.type !== 'tool_result') continue
      const p = L.pending.get(b.tool_use_id)
      if (p) {
        if (p.tool !== 'SubagentHandback') L.lastTool = p.tool
        if (p.tool === 'AskUserQuestion') pushEvent(L, { t, kind: 'answer', text: answerText(textOf(b.content)), id: b.tool_use_id })
        if (p.tool === 'Workflow') {
          const w = L.workflows.get(b.tool_use_id)
          const run = textOf(b.content).match(/\bwf_[A-Za-z0-9-]+/)?.[0]
          if (w && run) w.runId = run
        }
        L.pending.delete(b.tool_use_id)
      }
      L.results.add(b.tool_use_id)
    }
    L.last = 'result'
    return
  }
  if (o.isMeta) return
  const text = textOf(content).trim()
  if (text.startsWith('[Request interrupted')) {
    L.last = 'interrupt'
    L.pending.clear()
    return
  }
  if (text.startsWith('<task-notification') || text.startsWith('<system-reminder')) return
  L.last = 'prompt'
  L.pending.clear()
  L.turnStart = t
  L.ask = null
  L.recap = '' // tóm tắt của lượt trước, lượt mới chưa có
  if (L.kind === 'session') {
    L.tools = 0
    L.lastTool = null
    L.prompt = text
    pushEvent(L, { t, kind: 'prompt', text: truncate(oneLine(text), 300) })
    const hint = text.match(TICKET_TEXT)?.[1]
    if (hint) L.ticketHint = hint
  } else if (!L.prompt) {
    L.prompt = text
  }
}

/** @type {Map<string, any>} */
const files = new Map()

/** Đọc phần mới của một file log (lần đầu: phần cuối nếu file lớn). */
function readNew(file, f) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    files.delete(file)
    return false
  }
  if (f.loop.kind === 'agent' && !f.meta?.finished) f.meta = readMeta(file)
  if (stat.size < f.offset) {
    f.offset = 0
    f.rest = ''
    f.loop = newLoop(f.loop.kind)
  }
  f.mtime = stat.mtimeMs
  if (stat.size === f.offset) return false
  let start = f.offset
  let skipFirst = false
  if (start === 0 && stat.size > FIRST_READ_BYTES) {
    start = stat.size - FIRST_READ_BYTES
    skipFirst = true
  }
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    f.offset = stat.size
    const lines = (f.rest + buf.toString('utf8')).split('\n')
    f.rest = lines.pop() ?? ''
    if (skipFirst) lines.shift()
    for (const line of lines) {
      if (!line) continue
      try {
        apply(f.loop, JSON.parse(line))
      } catch {
        /* dòng hỏng / bị cắt: bỏ qua */
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  return true
}

/** Phần đầu file subagent lớn: lúc bắt đầu + việc được giao (phần cuối không có). */
function readHead(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0)
    const out = { t: 0, prompt: '' }
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (!out.t && o.timestamp) out.t = Date.parse(o.timestamp) || 0
      if (!out.prompt && o.type === 'user' && !o.isMeta) out.prompt = textOf(o.message?.content).trim()
      if (out.t && out.prompt) break
    }
    return out
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Dòng log cần cho quy trình (câu hỏi, câu trả lời, prompt, ticket, workflow) — lọc nhanh bằng chuỗi trước khi parse. */
const HEAD_MARKERS = ['wrap_up', 'AskUserQuestion', 'answered your questions', '"name":"Workflow"', 'Workflow launched', '/tickets/ticket_']

/**
 * Log session lớn chỉ đọc phần cuối → quét nhanh phần đầu bị bỏ qua để giữ lại mốc hội thoại
 * (câu hỏi duyệt Plan thường nằm ở đầu phiên).
 */
function prescanSession(file, end, L) {
  const scratch = newLoop('session')
  const CHUNK = 4 * 1024 * 1024
  let fd
  try {
    fd = fs.openSync(file, 'r')
    let pos = 0
    let rest = ''
    while (pos < end) {
      const buf = Buffer.alloc(Math.min(CHUNK, end - pos))
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (!n) break
      pos += n
      const lines = (rest + buf.subarray(0, n).toString('utf8')).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        const prompt = line.includes('"type":"user"') && !line.includes('"tool_result"')
        if (!prompt && !HEAD_MARKERS.some(m => line.includes(m))) continue
        try {
          apply(scratch, JSON.parse(line))
        } catch {
          /* bỏ qua */
        }
      }
    }
  } catch {
    return
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  L.events = scratch.events
  L.ticket = scratch.ticket
  L.ticketHint = scratch.ticketHint
  L.workflows = scratch.workflows
  L.firstAt = scratch.firstAt
}

/**
 * Bắt đầu theo dõi một file log.
 * force = đọc cả file cũ (subagent của session đang hoạt động, để dựng đủ quy trình).
 */
function track(file, now, force = false) {
  if (files.has(file)) return
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return
  }
  if (!force && now - stat.mtimeMs > ACTIVE_MS) return
  const rel = path.relative(ROOT, file).split(path.sep)
  // <project>/<session>.jsonl
  // <project>/<session>/subagents/agent-<id>.jsonl
  // <project>/<session>/subagents/workflows/<runId>/agent-<id>.jsonl
  let entry
  const agentId = name => name.replace(/^agent-/, '').replace(/\.jsonl$/, '')
  if (rel.length === 2) {
    entry = { offset: 0, rest: '', mtime: 0, loop: newLoop('session'), sessionId: rel[1].replace(/\.jsonl$/, ''), project: rel[0], wfResults: new Map() }
  } else if (rel.length === 4 && rel[2] === 'subagents') {
    entry = { offset: 0, rest: '', mtime: 0, loop: newLoop('agent'), sessionId: rel[1], agentId: agentId(rel[3]), meta: readMeta(file), project: rel[0], runId: null }
  } else if (rel.length === 6 && rel[2] === 'subagents' && rel[3] === 'workflows') {
    entry = { offset: 0, rest: '', mtime: 0, loop: newLoop('agent'), sessionId: rel[1], agentId: agentId(rel[5]), meta: readMeta(file), project: rel[0], runId: rel[4] }
  } else {
    return
  }
  if (entry.loop.kind === 'agent' && stat.size > FIRST_READ_BYTES) {
    const head = readHead(file)
    if (head?.t) entry.loop.firstAt = head.t
    if (head?.prompt) entry.loop.prompt = head.prompt
  }
  if (entry.loop.kind === 'session' && stat.size > FIRST_READ_BYTES) prescanSession(file, stat.size - FIRST_READ_BYTES, entry.loop)
  files.set(file, entry)
  readNew(file, entry)
}

function listDir(dir, opts) {
  try {
    return fs.readdirSync(dir, opts)
  } catch {
    return []
  }
}

/** Kết quả Workflow (`<session>/workflows/wf_*.json`), đọc lại khi file đổi. */
function scanWorkflowResults(entry, dir) {
  if (!entry) return
  for (const name of listDir(dir)) {
    if (!/^wf_[A-Za-z0-9-]+\.json$/.test(name)) continue
    const file = path.join(dir, name)
    let mtime = 0
    try {
      mtime = fs.statSync(file).mtimeMs
    } catch {
      continue
    }
    const runId = name.replace(/\.json$/, '')
    if (entry.wfResults.get(runId)?.mtime === mtime) continue
    const d = readJson(file)
    if (!d) continue
    const progress = Array.isArray(d.workflowProgress) ? d.workflowProgress : []
    entry.wfResults.set(runId, {
      mtime,
      name: String(d.workflowName ?? 'workflow'),
      status: String(d.status ?? ''),
      summary: oneLine(d.summary),
      phases: (Array.isArray(d.phases) ? d.phases : []).map(p => String(p?.title ?? '')),
      agents: progress.filter(p => p?.type === 'workflow_agent').map(p => ({ phase: Number(p.phaseIndex) || 0, state: String(p.state ?? ''), label: String(p.label ?? '') })),
      agentCount: Number(d.agentCount) || 0,
      startedAt: Number(d.startTime) || 0,
      durationMs: Number(d.durationMs) || 0,
    })
  }
}

function scan() {
  const now = Date.now()
  /** session đang theo dõi → giữ mọi subagent của nó */
  const live = new Set()
  for (const p of listDir(ROOT, { withFileTypes: true })) {
    if (!p.isDirectory()) continue
    const dir = path.join(ROOT, p.name)
    const entries = listDir(dir, { withFileTypes: true })
    for (const e of entries) if (e.isFile() && e.name.endsWith('.jsonl')) track(path.join(dir, e.name), now)
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = path.join(dir, e.name)
      const session = files.get(`${full}.jsonl`)
      if (session) live.add(e.name)
      const sub = path.join(full, 'subagents')
      for (const a of listDir(sub)) if (a.endsWith('.jsonl')) track(path.join(sub, a), now, Boolean(session))
      if (!session) continue
      const wfRoot = path.join(sub, 'workflows')
      for (const run of listDir(wfRoot)) {
        for (const a of listDir(path.join(wfRoot, run))) if (a.endsWith('.jsonl')) track(path.join(wfRoot, run, a), now, true)
      }
      scanWorkflowResults(session, path.join(full, 'workflows'))
    }
  }
  for (const [file, f] of files) {
    if (now - f.mtime <= ACTIVE_MS + DONE_KEEP_MS) continue
    if (f.loop.kind === 'agent' && live.has(f.sessionId)) continue
    files.delete(file)
  }
}

// ---------- session trong app Claude desktop (để mở đúng chat) ----------

/** cliSessionId → { localId, title, archived } */
let desktop = new Map()
const desktopCache = new Map() // file → { mtime, data }

function loadDesktop() {
  const next = new Map()
  for (const org of listDir(DESKTOP_SESSIONS)) {
    for (const acc of listDir(path.join(DESKTOP_SESSIONS, org))) {
      const dir = path.join(DESKTOP_SESSIONS, org, acc)
      for (const name of listDir(dir)) {
        if (!/^local_[A-Za-z0-9-]+\.json$/.test(name)) continue
        const file = path.join(dir, name)
        let mtime = 0
        try {
          mtime = fs.statSync(file).mtimeMs
        } catch {
          continue
        }
        let cached = desktopCache.get(file)
        if (!cached || cached.mtime !== mtime) {
          const d = readJson(file)
          if (!d) continue
          cached = { mtime, data: { localId: d.sessionId, title: d.title, archived: Boolean(d.isArchived), cli: [d.cliSessionId, d.lastAssistantCliSessionId] } }
          desktopCache.set(file, cached)
        }
        for (const cli of cached.data.cli) if (cli) next.set(cli, cached.data)
      }
    }
  }
  desktop = next
}

// ---------- đội agent (định nghĩa trong .claude/agents) ----------

let agentDefs = new Map() // name → { name, description, source }

function readAgentDir(dir, source, into) {
  for (const name of listDir(dir)) {
    if (!name.endsWith('.md')) continue
    let text = ''
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    const fm = text.match(/^---\n([\s\S]*?)\n---/)
    const get = key => fm?.[1].match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim()
    const agentName = get('name') || name.replace(/\.md$/, '')
    if (!into.has(agentName)) into.set(agentName, { name: agentName, description: get('description') ?? '', source })
  }
}

function loadAgentDefs() {
  const next = new Map()
  readAgentDir(path.join(HOME, '.claude', 'agents'), 'của bạn', next)
  const roots = new Set()
  for (const f of files.values()) {
    let dir = f.loop.cwd
    while (dir && dir.startsWith(HOME) && dir !== HOME) {
      roots.add(dir)
      dir = path.dirname(dir)
    }
  }
  for (const dir of roots) readAgentDir(path.join(dir, '.claude', 'agents'), path.basename(dir), next)
  for (const b of BUILTIN_AGENTS) if (!next.has(b.name)) next.set(b.name, { ...b, source: 'có sẵn' })
  agentDefs = next
}

// ---------- quy trình (pipelines.json) ----------

/** @type {{ id: string, name: string, steps: { agent: string, label: string, optional: boolean, gate: { label: string, match: RegExp | null } | null, loopMax: number, result: boolean }[] }[]} */
let pipelines = []
let pipelinesMtime = -1

function safeRegex(src) {
  try {
    return src ? new RegExp(String(src), 'i') : null
  } catch {
    return null
  }
}

function loadPipelines() {
  let mtime = 0
  try {
    mtime = fs.statSync(PIPELINES_FILE).mtimeMs
  } catch {
    pipelines = []
    pipelinesMtime = -1
    return
  }
  if (mtime === pipelinesMtime) return
  pipelinesMtime = mtime
  const d = readJson(PIPELINES_FILE)
  if (!d) return console.error(`${PIPELINES_FILE} sai cú pháp JSON — giữ quy trình cũ`)
  pipelines = (Array.isArray(d.pipelines) ? d.pipelines : [])
    .filter(p => Array.isArray(p?.steps) && p.steps.length)
    .map(p => ({
      id: String(p.id ?? p.name ?? 'pipeline'),
      name: String(p.name ?? p.id ?? 'Quy trình'),
      steps: p.steps
        .filter(s => s?.agent)
        .map(s => ({
          agent: String(s.agent),
          label: String(s.label ?? s.agent),
          optional: Boolean(s.optional),
          gate: s.gate?.label ? { label: String(s.gate.label), match: safeRegex(s.gate.match) } : null,
          loopMax: Number(s.loop?.max) || 0,
          result: Boolean(s.result),
        })),
    }))
}

// ---------- ẩn phiên (nút "Xong") ----------

/** sessionId → lúc bấm ẩn (ms). Phiên có hoạt động mới sau mốc này thì tự hiện lại. */
let hidden = readJson(HIDDEN_FILE) ?? {}
for (const [id, at] of Object.entries(hidden)) if (typeof at !== 'number' || Date.now() - at > 3 * 86_400_000) delete hidden[id]
let hiddenDirty = false

// ---------- suy trạng thái ----------

/** working | asking (cần bạn) | idle (rỗi); stalled = đang làm mà log im quá lâu */
function sessionStatus(f, now) {
  const L = f.loop
  const quiet = now - f.mtime
  const asking = [...L.pending.values()].find(p => p.question)
  if (asking) return { state: 'asking', waiting: asking.question }
  if (L.pending.size) return quiet > STALE_MS ? { state: 'idle', waiting: null, stalled: true } : { state: 'working', waiting: null }
  if (L.last === 'interrupt') return { state: 'idle', waiting: null, interrupted: true }
  if (L.last === 'assistant' && L.stop === 'end_turn') return L.ask ? { state: 'asking', waiting: L.ask } : { state: 'idle', waiting: null }
  if (L.last === '') return { state: 'idle', waiting: null }
  return quiet > STALE_MS ? { state: 'idle', waiting: null, stalled: true } : { state: 'working', waiting: null }
}

function agentState(f, session, now) {
  const L = f.loop
  const quiet = now - f.mtime
  if (L.last === 'interrupt') return 'stopped'
  if (f.meta?.finished || (L.handedBack && L.pending.size === 0)) return 'done'
  if ([...L.pending.values()].some(p => p.question)) return 'asking'
  if (L.pending.size) return quiet > STALE_MS ? 'stopped' : 'working'
  const finishedText = L.last === 'assistant' && L.lastHasText && !L.lastHasTool
  const answered = Boolean(f.meta?.toolUseId && session?.loop.results.has(f.meta.toolUseId))
  if (finishedText && (L.stop === 'end_turn' || quiet > 5000 || (answered && quiet > 1500))) return 'done'
  return quiet > STALE_MS ? 'stopped' : 'working'
}

const agentStalled = (f, now) => f.loop.pending.size > 0 && now - f.mtime > STALE_MS && f.loop.last !== 'interrupt' && !f.meta?.finished

const running = L => [...L.pending.values()].map(p => ({ tool: p.tool, detail: p.detail }))
const planOf = L => L.plan.filter(p => p.content).map(p => ({ content: truncate(p.content, 120), status: p.status }))

const isBusy = state => state === 'working' || state === 'asking'

/**
 * Cổng duyệt sau một bước. Chỉ xét câu hỏi trong khoảng [bước xong, bước sau bắt đầu]:
 * có câu khớp `match` thì lấy câu khớp cuối cùng (hỏi lại sau khi bạn hỏi vặn), không thì câu đầu tiên.
 */
function gateOf(gate, step, L, laterRuns) {
  const g = { kind: 'gate', label: gate.label, state: 'pending', question: '', answer: '', askedAt: null, answeredAt: null }
  if (step.state === 'skipped') return { ...g, state: 'skipped' }
  if (step.state !== 'done') return g
  const after = (step.endedAt ?? 0) - 2000
  const nextStart = Math.min(...laterRuns.flatMap(runs => runs.map(a => a.startedAt).filter(t => t >= after)))
  const laterStarted = Number.isFinite(nextStart)
  const asks = L.events.filter(e => e.kind === 'ask' && e.t >= after && e.t <= nextStart)
  const ask = asks.filter(e => gate.match?.test(e.text)).at(-1) ?? asks[0]
  // không thấy câu hỏi nào mà bước sau đã chạy → coi như đã qua
  if (!ask) return laterStarted ? { ...g, state: 'passed' } : g
  const idx = L.events.indexOf(ask)
  const reply = L.events.slice(idx + 1).find(e => (ask.id ? e.kind === 'answer' && e.id === ask.id : e.kind === 'prompt'))
  if (reply) return { ...g, state: 'passed', question: ask.text, answer: reply.text, askedAt: ask.t, answeredAt: reply.t }
  return { ...g, state: laterStarted ? 'passed' : 'waiting', question: ask.text, askedAt: ask.t }
}

/** Workflow trong session: từ lệnh gọi Workflow, file kết quả wf_*.json và các agent đang chạy. */
function workflowsOf(f, all, now) {
  const L = f.loop
  /** @type {Map<string, any>} */
  const runs = new Map()
  for (const [id, w] of L.workflows) runs.set(w.runId || id, { id: w.runId || id, name: w.name, phases: w.phases, startedAt: w.t, result: null })
  for (const [runId, r] of f.wfResults) {
    const x = runs.get(runId) ?? { id: runId, name: r.name, phases: r.phases, startedAt: r.startedAt }
    runs.set(runId, { ...x, name: r.name || x.name, phases: r.phases.length ? r.phases : x.phases, result: r })
  }
  for (const a of all) if (a.workflowRun && !runs.has(a.workflowRun)) runs.set(a.workflowRun, { id: a.workflowRun, name: 'workflow', phases: [], startedAt: a.startedAt, result: null })
  const STATUS = { completed: 'done', done: 'done', failed: 'error', error: 'error', cancelled: 'stopped', killed: 'stopped', stopped: 'stopped', running: 'working' }
  return [...runs.values()].map(x => {
    const agents = all.filter(a => a.workflowRun === x.id)
    const r = x.result
    let status = r ? STATUS[r.status] ?? 'working' : null
    if (!status) {
      const lastActive = Math.max(x.startedAt || 0, ...agents.map(a => a.endedAt ?? now))
      status = agents.some(a => isBusy(a.state)) || now - lastActive < 5 * 60_000 ? 'working' : 'unknown'
    }
    const phases = x.phases.map((title, i) => {
      const inPhase = r ? r.agents.filter(a => a.phase === i + 1) : []
      const done = inPhase.filter(a => a.state === 'done').length
      return { title, total: inPhase.length, done, state: !r ? 'unknown' : !inPhase.length ? 'pending' : done === inPhase.length ? 'done' : 'working' }
    })
    return {
      id: x.id,
      name: x.name,
      status,
      phases,
      total: r ? r.agentCount || r.agents.length : agents.length,
      done: r ? r.agents.filter(a => a.state === 'done').length : agents.filter(a => a.state === 'done').length,
      startedAt: x.startedAt || null,
      endedAt: r && r.durationMs ? r.startedAt + r.durationMs : null,
      summary: r ? truncate(r.summary, 200) : '',
    }
  })
}

/** Dải bước của phiên: theo pipelines.json nếu có agent khớp, không thì chuỗi agent theo thứ tự chạy. */
function buildFlow(f, all, now) {
  const L = f.loop
  const pipe = pipelines.find(p => all.some(a => p.steps.some(st => st.agent === a.type)))
  const workflows = workflowsOf(f, all, now)
  const plain = all.filter(a => !a.workflowRun)
  if (!pipe && !workflows.length && plain.length < 2) return null
  const agentLite = a => ({ id: a.id, name: a.name, state: a.state, stalled: a.stalled, startedAt: a.startedAt, endedAt: a.endedAt })
  const steps = []
  let others = []
  if (pipe) {
    const used = new Set(pipe.steps.map(st => st.agent))
    others = plain.filter(a => !used.has(a.type)).map(a => ({ id: a.id, type: a.type, name: a.name, state: a.state }))
    const runsOf = pipe.steps.map(st => plain.filter(a => a.type === st.agent))
    pipe.steps.forEach((st, i) => {
      const runs = runsOf[i]
      const last = runs.at(-1)
      let state
      if (runs.some(a => a.state === 'asking')) state = 'asking'
      else if (runs.some(a => a.state === 'working')) state = 'working'
      else if (last) state = last.state === 'stopped' ? 'stopped' : 'done'
      else state = st.optional && runsOf.slice(i + 1).some(r => r.length) ? 'skipped' : 'pending'
      const ended = state === 'done' || state === 'stopped'
      const step = {
        kind: 'step',
        label: st.label,
        agent: st.agent,
        state,
        runs: runs.length,
        loopMax: st.loopMax,
        startedAt: runs[0]?.startedAt ?? null,
        endedAt: ended ? last?.endedAt ?? null : null,
        agents: runs.map(agentLite),
        result: st.result && ended && last ? testResult(last.report) : null,
        report: ended && last ? summaryOf(last.report) : '',
      }
      steps.push(step)
      if (st.gate) steps.push(gateOf(st.gate, step, L, runsOf.slice(i + 1)))
    })
  } else {
    for (const a of plain.slice(-20)) {
      steps.push({
        kind: 'step',
        label: a.type,
        agent: a.type,
        name: a.name,
        state: a.state,
        runs: 1,
        loopMax: 0,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        agents: [agentLite(a)],
        result: null,
        report: a.state === 'done' ? summaryOf(a.report) : '',
      })
    }
  }
  const cur = steps.find(x => x.state === 'waiting' || x.state === 'asking' || x.state === 'working') ?? steps.find(x => x.state === 'pending')
  return {
    kind: pipe ? 'pipeline' : 'chain',
    name: pipe?.name ?? (plain.length ? 'Chuỗi agent' : 'Workflow'),
    ticket: L.ticket || L.ticketHint || '',
    steps,
    current: cur ? { label: cur.label, state: cur.state } : null,
    others,
    workflows,
  }
}

function snapshot() {
  const now = Date.now()
  /** @type {Map<string, any>} */
  const sessions = new Map()
  const hiddenList = []
  for (const f of files.values()) {
    if (f.loop.kind !== 'session') continue
    const L = f.loop
    const d = desktop.get(f.sessionId)
    if (d?.archived) continue
    const st = sessionStatus(f, now)
    // Đo theo tin nhắn thật: app desktop có thể ghi thêm dòng tiêu đề vào log cũ khi mở lại session.
    if (st.state !== 'working' && now - (L.lastAt || f.mtime) > ACTIVE_MS) continue
    const project = (L.cwd ? path.basename(L.cwd) : f.project) || 'project'
    const title = truncate(d?.title || L.title || L.agentName || L.lastPrompt || L.prompt || f.sessionId.slice(0, 8), 70)
    const hiddenAt = hidden[f.sessionId]
    if (hiddenAt) {
      if ((L.lastAt || f.mtime) > hiddenAt) {
        delete hidden[f.sessionId]
        hiddenDirty = true
      } else {
        hiddenList.push({ id: f.sessionId, project, title, hiddenAt, canOpen: Boolean(d?.localId) })
        continue
      }
    }
    sessions.set(f.sessionId, {
      id: f.sessionId,
      project,
      title,
      surface: d ? 'desktop' : L.entrypoint === 'claude-vscode' ? 'vscode' : 'terminal',
      canOpen: Boolean(d?.localId),
      state: st.state,
      stalled: Boolean(st.stalled),
      waiting: st.waiting,
      interrupted: Boolean(st.interrupted),
      task: truncate(oneLine(L.prompt || L.lastPrompt), 300),
      recap: truncate(L.recap, 300),
      firstAt: L.firstAt || f.mtime,
      startedAt: L.turnStart || L.firstAt || f.mtime,
      endedAt: st.state === 'working' ? null : L.lastAt || f.mtime,
      tools: L.tools,
      lastTool: L.lastTool,
      running: running(L),
      plan: planOf(L),
      queue: L.queue.filter(q => q.text).map(q => ({ text: truncate(q.text, 200), at: q.at })),
      agents: [],
      flow: null,
      _file: f,
      _all: [],
    })
  }
  if (hiddenDirty) {
    hiddenDirty = false
    writeJson(HIDDEN_FILE, hidden)
  }
  for (const f of files.values()) {
    if (f.loop.kind !== 'agent') continue
    const s = sessions.get(f.sessionId)
    if (!s) continue
    const L = f.loop
    const state = agentState(f, s._file, now)
    const endedAt = isBusy(state) ? null : L.lastAt || f.mtime
    const a = {
      id: f.agentId,
      name: truncate(oneLine(f.meta?.description || L.prompt.split('\n').find(l => l.trim()) || 'Agent'), 60),
      type: f.meta?.agentType || 'agent',
      model: f.meta?.model ?? null,
      background: f.meta?.requestShape === 'background',
      state,
      stalled: agentStalled(f, now),
      waiting: [...L.pending.values()].find(p => p.question)?.question ?? null,
      task: truncate(oneLine(L.prompt || f.meta?.description), 300),
      startedAt: L.firstAt || f.mtime,
      endedAt,
      tools: L.tools,
      lastTool: L.lastTool,
      running: running(L),
      plan: planOf(L),
    }
    s._all.push({ ...a, report: L.report || (state === 'done' ? L.lastText : ''), workflowRun: f.runId })
    // văn phòng / danh sách: agent xong lâu rồi thì thôi hiện
    if (!(endedAt && now - endedAt > DONE_KEEP_MS)) s.agents.push(a)
  }
  const list = [...sessions.values()]
    .map(({ _file, _all, ...s }) => {
      _all.sort((a, b) => a.startedAt - b.startedAt)
      return { ...s, agents: s.agents.sort((a, b) => a.startedAt - b.startedAt), flow: buildFlow(_file, _all, now) }
    })
    // thứ tự cố định theo lúc session bắt đầu → số trên đầu nhân vật không nhảy
    .sort((a, b) => a.firstAt - b.firstAt)

  // đội agent: loại nào đang bận, loại nào rỗi
  const roster = [...agentDefs.values()].map(def => {
    const mine = list.flatMap(s => s.agents.filter(a => a.type === def.name).map(a => ({ ...a, session: s.title, sessionId: s.id })))
    return {
      ...def,
      description: truncate(def.description, 160),
      busy: mine.filter(a => isBusy(a.state)).map(a => ({ name: a.name, session: a.session, sessionId: a.sessionId, state: a.state })),
      doneRecently: mine.filter(a => a.state === 'done').length,
    }
  })
  // loại agent đang chạy mà không có file định nghĩa (vd. fork, agent của plugin)
  const extra = new Map()
  for (const s of list)
    for (const a of s.agents) {
      if (agentDefs.has(a.type)) continue
      const r = extra.get(a.type) ?? { name: a.type, description: '', source: 'khác', busy: [], doneRecently: 0 }
      if (isBusy(a.state)) r.busy.push({ name: a.name, session: s.title, sessionId: s.id, state: a.state })
      else if (a.state === 'done') r.doneRecently++
      extra.set(a.type, r)
    }

  return {
    now,
    build: BUILD,
    sessions: list,
    roster: [...roster, ...extra.values()],
    hidden: hiddenList.sort((a, b) => b.hiddenAt - a.hiddenAt),
    settings,
    native: nativeClients.size > 0,
    bubbleDenied: nativeClients.size === 0 && deniedClients.size > 0,
    notifs: notifs.slice(),
  }
}

// ---------- thông báo (server quyết định, bong bóng / cửa sổ chỉ hiện) ----------

let settings = mergeSettings(readJson(SETTINGS_FILE))

function mergeSettings(d) {
  const n = d?.notify ?? {}
  const types = { ...DEFAULT_SETTINGS.types }
  for (const k of NOTIFY_TYPES) if (typeof n.types?.[k] === 'boolean') types[k] = n.types[k]
  return { enabled: typeof n.enabled === 'boolean' ? n.enabled : DEFAULT_SETTINGS.enabled, types }
}

/** @type {{ id: string, at: number, type: string, sessionId: string | null, title: string, body: string }[]} */
const notifs = []
let notifSeq = 0
/** sessionId → các sự kiện đang chờ gom */
const gathering = new Map()
const PRIO = { test: 0, ask: 1, stall: 2, step: 3, turn: 4, sub: 5 }
/** @type {Map<string, { state: string, stalled?: boolean }> | null} */
let prevMarks = null

function queueNotify(sessionId, type, title, body, immediate = false) {
  if (type !== 'test' && (!settings.enabled || !settings.types[type])) return
  const key = sessionId ?? '_'
  const g = gathering.get(key) ?? { first: immediate ? 0 : Date.now(), sessionId, items: [] }
  if (!g.items.some(i => i.title === title)) g.items.push({ type, title, body: String(body ?? '').trim() })
  gathering.set(key, g)
}

function flushNotify(now) {
  for (const [key, g] of gathering) {
    if (now - g.first < NOTIFY_GATHER_MS) continue
    gathering.delete(key)
    const items = g.items.sort((a, b) => PRIO[a.type] - PRIO[b.type])
    const [top, ...rest] = items
    const body = [top.body, ...rest.map(i => i.title)].filter(Boolean).join('\n')
    notifs.push({ id: `${BUILD}-${++notifSeq}`, at: now, type: top.type, sessionId: g.sessionId, title: truncate(top.title, 120), body: truncate(body, 300) })
  }
  while (notifs.length && (notifs.length > 30 || now - notifs[0].at > NOTIFY_KEEP_MS)) notifs.shift()
}

const pipelineAgents = s => (s.flow?.kind === 'pipeline' ? new Set(s.flow.steps.filter(x => x.kind === 'step').map(x => x.agent)) : null)

function detectChanges(list) {
  const marks = new Map()
  for (const s of list) {
    marks.set(`s:${s.id}`, { state: s.state, stalled: s.stalled })
    for (const a of s.agents) marks.set(`a:${a.id}`, { state: a.state, stalled: a.stalled })
    if (s.flow?.kind === 'pipeline') s.flow.steps.forEach((st, i) => st.kind === 'step' && marks.set(`f:${s.id}:${i}`, { state: st.state }))
    for (const w of s.flow?.workflows ?? []) marks.set(`w:${s.id}:${w.id}`, { state: w.status })
  }
  if (prevMarks) for (const s of list) diffSession(s, prevMarks)
  prevMarks = marks
}

function diffSession(s, prev) {
  const tag = s.flow?.ticket ? ` · #${s.flow.ticket}` : ''
  const b = prev.get(`s:${s.id}`)
  if (s.state === 'asking' && b?.state !== 'asking') {
    const gate = s.flow?.steps.find(x => x.kind === 'gate' && x.state === 'waiting')
    if (gate) queueNotify(s.id, 'ask', `❗ ${gate.label}${tag}`, `${s.waiting ?? gate.question}\n${s.title}`)
    else queueNotify(s.id, 'ask', `❗ Cần bạn: ${s.title}`, s.waiting ?? '')
  }
  if (b?.state === 'working' && s.state === 'idle' && !s.stalled) queueNotify(s.id, 'turn', `✅ Xong lượt: ${s.title}`, s.recap)
  if (b && s.stalled && !b.stalled) queueNotify(s.id, 'stall', `⚠️ Có thể đang treo: ${s.title}`, `Im lặng hơn 15 phút${s.lastTool ? ` · tool cuối: ${s.lastTool}` : ''}`)

  const pipe = pipelineAgents(s)
  for (const a of s.agents) {
    const ab = prev.get(`a:${a.id}`)
    if (a.state === 'asking' && ab?.state !== 'asking') queueNotify(s.id, 'ask', `❗ ${a.name} cần bạn`, `${a.waiting ?? ''}\n${s.title}`)
    if (ab && a.stalled && !ab.stalled) queueNotify(s.id, 'stall', `⚠️ ${a.name} có thể đang treo`, s.title)
    if (ab && isBusy(ab.state) && a.state === 'done' && !pipe?.has(a.type) && a.type !== 'workflow-subagent') queueNotify(s.id, 'sub', `✅ ${a.name} xong`, `${a.type} · ${s.title}`)
  }

  if (s.flow?.kind === 'pipeline')
    s.flow.steps.forEach((st, i) => {
      if (st.kind !== 'step') return
      const sb = prev.get(`f:${s.id}:${i}`)
      if (!sb || sb.state === st.state) return
      if (st.state === 'done') {
        const next = s.flow.steps[i + 1]
        const res = st.result ? `${st.result.pass} PASS · ${st.result.fail} FAIL · ${st.result.notRun} NOT RUN` : ''
        const loop = st.loopMax ? `vòng ${st.runs}/${st.loopMax}` : ''
        const body = [res, loop].filter(Boolean).join(' · ') || (next?.kind === 'gate' ? `Tiếp theo: ${next.label}` : st.report)
        queueNotify(s.id, 'step', `${st.result?.fail ? '❌' : '✅'} ${st.label} xong${tag}`, `${body}\n${s.title}`)
      } else if (st.state === 'stopped') queueNotify(s.id, 'step', `⏹️ ${st.label} bị dừng${tag}`, s.title)
    })

  for (const w of s.flow?.workflows ?? []) {
    const wb = prev.get(`w:${s.id}:${w.id}`)
    if (!wb || wb.state === w.status || !['done', 'error', 'stopped'].includes(w.status)) continue
    queueNotify(s.id, 'step', `${w.status === 'done' ? '✅' : '⚠️'} Workflow ${w.name} ${w.status === 'done' ? 'xong' : 'dừng'}`, `${w.done}/${w.total} agent · ${s.title}`)
  }
}

// ---------- đẩy lên trình duyệt ----------

const clients = new Set()
/** Bong bóng (app Swift) đang nối và đã được macOS cho phép thông báo → cửa sổ Chrome không báo trùng. */
const nativeClients = new Set()
/** Bong bóng đang chạy nhưng macOS chặn thông báo của nó → menu 🔔 nhắc bật trong Cài đặt hệ thống. */
const deniedClients = new Set()
let lastJson = ''

function publish() {
  const snap = snapshot()
  detectChanges(snap.sessions)
  flushNotify(snap.now)
  snap.notifs = notifs.slice()
  const json = JSON.stringify({ s: snap.sessions, r: snap.roster, h: snap.hidden, n: snap.notifs.map(x => x.id), st: snap.settings, nat: snap.native, den: snap.bubbleDenied })
  if (json === lastJson) return
  lastJson = json
  const msg = `data: ${JSON.stringify(snap)}\n\n`
  for (const res of clients) res.write(msg)
}

/** Mở chat của một session trong app Claude desktop. */
function openSession(id, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  if (!UUID.test(id)) {
    res.statusCode = 400
    return res.end(JSON.stringify({ error: 'bad id' }))
  }
  const d = desktop.get(id)
  if (d?.localId && /^local_[A-Za-z0-9-]{1,64}$/.test(d.localId)) {
    execFile('open', [`claude://code/continue?session=${d.localId}`], err => {
      res.end(JSON.stringify(err ? { error: String(err.message) } : { opened: 'desktop' }))
    })
    return
  }
  // Session chạy trong terminal: trả lệnh để trang copy.
  res.end(JSON.stringify({ copy: `claude --resume ${id}` }))
}

function readBody(req, limit, done) {
  let body = ''
  req.on('data', chunk => {
    body += chunk
    if (body.length > limit) req.destroy()
  })
  req.on('end', () => {
    try {
      done(body ? JSON.parse(body) : {})
    } catch {
      done(null)
    }
  })
}

const sendJson = (res, data, status = 200) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }

/** Các lệnh thay đổi: chỉ POST + header riêng → trình duyệt buộc preflight, trang web lạ không gọi lén được. */
const ACTIONS = new Set(['/open', '/hide', '/unhide', '/settings', '/notify-test'])

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/health') return res.end('ok')
  if (url.pathname === '/state') return sendJson(res, snapshot())
  if (ACTIONS.has(url.pathname)) {
    if (req.method !== 'POST' || req.headers['x-agent-office'] !== '1') {
      res.statusCode = 403
      return res.end()
    }
    const id = url.searchParams.get('session') ?? ''
    switch (url.pathname) {
      case '/open':
        return openSession(id, res)
      case '/hide':
      case '/unhide':
        if (!UUID.test(id)) return sendJson(res, { error: 'bad id' }, 400)
        if (url.pathname === '/hide') hidden[id] = Date.now()
        else delete hidden[id]
        writeJson(HIDDEN_FILE, hidden)
        publish()
        return sendJson(res, { ok: true })
      case '/settings':
        return readBody(req, 4096, d => {
          if (!d) return sendJson(res, { error: 'bad json' }, 400)
          if (typeof d.enabled === 'boolean') settings.enabled = d.enabled
          for (const k of NOTIFY_TYPES) if (typeof d.types?.[k] === 'boolean') settings.types[k] = d.types[k]
          writeJson(SETTINGS_FILE, { notify: settings })
          publish()
          sendJson(res, settings)
        })
      case '/notify-test':
        queueNotify(null, 'test', '🔔 Agent Office', 'Thông báo đang hoạt động. Bấm vào đây sẽ mở chat của phiên tương ứng.', true)
        publish()
        return sendJson(res, { ok: true, native: nativeClients.size > 0 })
    }
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const kind = url.searchParams.get('client')
    clients.add(res)
    if (kind === 'native') nativeClients.add(res)
    if (kind === 'denied') deniedClients.add(res)
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    req.on('close', () => {
      clients.delete(res)
      nativeClients.delete(res)
      deniedClients.delete(res)
      publish()
    })
    if (kind) publish()
    return
  }
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  const file = path.join(PUBLIC, path.normalize(name))
  if (!file.startsWith(PUBLIC)) {
    res.statusCode = 403
    return res.end()
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.statusCode = 404
      return res.end('not found')
    }
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
    res.setHeader('cache-control', 'no-cache')
    res.end(data)
  })
})

// file thay đổi → đọc phần mới ngay
let dirty = new Set()
try {
  fs.watch(ROOT, { recursive: true }, (_event, rel) => {
    const name = rel ? String(rel) : ''
    if (name.endsWith('.jsonl')) dirty.add(path.join(ROOT, name))
    else if (name.endsWith('.meta.json')) dirty.add(path.join(ROOT, name.replace(/\.meta\.json$/, '.jsonl')))
  })
} catch {
  /* không watch được thì vẫn có quét định kỳ */
}

setInterval(() => {
  const batch = dirty
  dirty = new Set()
  const now = Date.now()
  for (const file of batch) {
    const f = files.get(file)
    if (f) readNew(file, f)
    else track(file, now)
  }
  publish()
}, 400)

setInterval(() => {
  for (const [file, f] of files) readNew(file, f)
  scan()
  publish()
}, 3000)

setInterval(() => {
  loadDesktop()
  loadAgentDefs()
  loadPipelines()
}, 20_000)

loadPipelines()
scan()
loadDesktop()
loadAgentDefs()
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Office: http://127.0.0.1:${PORT}  (đọc ${ROOT})`)
})
