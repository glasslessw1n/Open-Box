// traffic-guard 的 JSON / HTTP 助手（由 traffic-guard 主脚本调用）。
//
// 为什么用 Node：Open-Box 的安装包自带 Node 运行时（/opt/open-box/node/bin/node），
// 路由器上的 POSIX sh 没有可靠的 JSON 解析手段。本文件只做三件事：
//   1) 从内核配置 /opt/open-box/etc/config.json 里读取 Clash API 地址与密钥、
//      枚举真实节点、为单个节点生成临时探测用的 sing-box 配置；
//   2) 调用内核的 Clash API（读 /proxies、切换 selector 组的当前节点）；
//   3) 把“本轮要守护哪些组、当前节点是谁、候选成员有哪些”整理成 TSV 给 sh 消费。
//
// 本文件不修改 Open-Box 的任何文件；对内核配置只有只读访问。

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'])

function die(msg) {
  process.stderr.write(`tg-lib: ${msg}\n`)
  process.exit(1)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    die(`无法读取/解析 ${path}: ${e.message}`)
  }
}

// 稳定序列化（递归排序键），用于给节点算指纹：与 tag 无关，只与连接参数有关，
// 订阅刷新后只要参数没变指纹就不变，黑名单不会因为改名失效。
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

function fingerprint(kind, obj) {
  const copy = { ...obj }
  delete copy.tag
  return createHash('sha256').update(`${kind}\n${canonical(copy)}`).digest('hex').slice(0, 16)
}

// 汇总配置中所有可被引用的条目：outbounds 与 endpoints（WireGuard 在新内核里是 endpoint）。
function collectEntries(cfg) {
  const map = new Map()
  for (const ob of cfg.outbounds || []) {
    if (ob && ob.tag) map.set(ob.tag, { kind: 'outbound', obj: ob })
  }
  for (const ep of cfg.endpoints || []) {
    if (ep && ep.tag) map.set(ep.tag, { kind: 'endpoint', obj: ep })
  }
  return map
}

function isLeafNode(entry) {
  if (!entry) return false
  const t = entry.obj.type
  if (entry.kind === 'endpoint') return true
  return !['selector', 'urltest', 'fallback', 'direct', 'block', 'dns'].includes(t)
}

// ---- 子命令：api-info <config.json> ----
// 输出一行：controller<TAB>secret（secret 可能为空）
function cmdApiInfo(cfgPath) {
  const cfg = readJson(cfgPath)
  const api = (cfg.experimental && cfg.experimental.clash_api) || {}
  let controller = api.external_controller || '127.0.0.1:9095'
  const m = String(controller).match(/^(.*):(\d+)$/)
  if (m) {
    const host = m[1].replace(/^\[|\]$/g, '')
    if (host === '' || host === '0.0.0.0' || host === '::') controller = `127.0.0.1:${m[2]}`
  }
  process.stdout.write(`${controller}\t${api.secret || ''}\n`)
}

// ---- 子命令：nodes <config.json> ----
// 输出 TSV：tag<TAB>type<TAB>fingerprint，只含真实节点（叶子出站/端点）
function cmdNodes(cfgPath) {
  const cfg = readJson(cfgPath)
  const entries = collectEntries(cfg)
  for (const [tag, entry] of entries) {
    if (!isLeafNode(entry)) continue
    process.stdout.write(`${tag}\t${entry.obj.type}\t${fingerprint(entry.kind, entry.obj)}\n`)
  }
}

// ---- 子命令：plan <config.json> <proxies.json> ----
// 结合内核配置（算指纹）与 Clash API 的 /proxies（组与当前选择），输出本轮守护计划 TSV：
//   groupName<TAB>nowTag<TAB>nowFingerprint<TAB>memberTag1,memberTag2,...
// 只纳入：类型为 Selector、当前选择是真实节点、成员里至少还有一个真实节点的组。
// 环境变量 TG_MANAGED_GROUPS（逗号分隔）非空时只守护这些组；
// TG_EXCLUDE_GROUPS（逗号分隔）列出的组永远不守护。
function cmdPlan(cfgPath, proxiesPath) {
  const cfg = readJson(cfgPath)
  const entries = collectEntries(cfg)
  const fpOf = tag => {
    const e = entries.get(tag)
    return e ? fingerprint(e.kind, e.obj) : ''
  }
  const data = readJson(proxiesPath)
  const proxies = data.proxies || {}
  const managed = (process.env.TG_MANAGED_GROUPS || '').split(',').map(s => s.trim()).filter(Boolean)
  const excluded = new Set((process.env.TG_EXCLUDE_GROUPS || '').split(',').map(s => s.trim()).filter(Boolean))
  const isGroupEntry = p => p && (Array.isArray(p.all) || GROUP_TYPES.has(p.type))
  for (const [name, p] of Object.entries(proxies)) {
    if (!p || p.type !== 'Selector') continue
    if (excluded.has(name)) continue
    if (managed.length && !managed.includes(name)) continue
    const now = p.now
    if (!now || isGroupEntry(proxies[now])) continue
    const nowEntry = entries.get(now)
    if (!nowEntry || !isLeafNode(nowEntry)) continue
    const members = (p.all || []).filter(t => {
      if (isGroupEntry(proxies[t])) return false
      const e = entries.get(t)
      return e && isLeafNode(e)
    })
    if (!members.length) continue
    process.stdout.write(`${name}\t${now}\t${fpOf(now)}\t${members.join(',')}\n`)
  }
}

// ---- 子命令：probe-config <config.json> <tag> <port> <localDns> <remoteDns> ----
// 为指定节点生成一份临时 sing-box 配置（JSON 输出到 stdout）：
//   - 只含该节点出站（及其 detour 依赖链，含组与端点，按引用递归收齐）；
//   - 一个监听在 127.0.0.1:<port> 的 mixed 入站，全部流量 final 到该节点；
//   - DNS：节点服务器域名走本地解析（type=local），其余域名经节点用 remoteDns 解析，
//     与真实使用时“代理域名走代理 DNS”的行为一致。
// 不含 tun / 路由规则 / Clash API，不会与正在运行的内核冲突。
function cmdProbeConfig(cfgPath, tag, port, localDns, remoteDns) {
  const cfg = readJson(cfgPath)
  const entries = collectEntries(cfg)
  if (!entries.has(tag)) die(`配置中不存在节点 ${tag}`)
  const pickedOut = new Map()
  const pickedEp = new Map()
  const queue = [tag]
  const seen = new Set()
  while (queue.length) {
    const t = queue.shift()
    if (seen.has(t)) continue
    seen.add(t)
    const e = entries.get(t)
    if (!e) continue
    ;(e.kind === 'endpoint' ? pickedEp : pickedOut).set(t, e.obj)
    const refs = []
    if (typeof e.obj.detour === 'string') refs.push(e.obj.detour)
    if (Array.isArray(e.obj.outbounds)) refs.push(...e.obj.outbounds)
    for (const r of refs) if (!seen.has(r)) queue.push(r)
  }
  const outbounds = [...pickedOut.values()]
  if (!outbounds.some(o => o.type === 'direct')) outbounds.push({ type: 'direct', tag: 'direct' })
  const probe = {
    log: { level: process.env.TG_PROBE_LOGLEVEL || 'error' },
    dns: {
      servers: [
        { type: 'local', tag: 'local' },
        { type: 'udp', tag: 'remote', server: remoteDns || '1.1.1.1', server_port: 53, detour: tag },
      ],
      final: 'remote',
    },
    inbounds: [{ type: 'mixed', tag: 'probe-in', listen: '127.0.0.1', listen_port: Number(port) }],
    outbounds,
    ...(pickedEp.size ? { endpoints: [...pickedEp.values()] } : {}),
    route: { final: tag, default_domain_resolver: 'local' },
  }
  // localDns 参数保留给将来按需指定本地解析器；当前用 type=local（系统解析）即可，
  // sing-box 的 local 解析在路由器上即 dnsmasq/上游，与内核解析节点服务器的路径一致。
  void localDns
  process.stdout.write(`${JSON.stringify(probe, null, 1)}\n`)
}

// ---- Clash API 调用 ----
function apiBase(controller) {
  return `http://${controller}`
}
function apiHeaders(secret) {
  return secret ? { Authorization: `Bearer ${secret}` } : {}
}

// 子命令：ping <controller> <secret> —— GET /version，通则 exit 0
async function cmdPing(controller, secret) {
  try {
    const r = await fetch(`${apiBase(controller)}/version`, { headers: apiHeaders(secret), signal: AbortSignal.timeout(3000) })
    process.exit(r.ok ? 0 : 1)
  } catch {
    process.exit(1)
  }
}

// 子命令：proxies <controller> <secret> <outfile> —— GET /proxies 写入文件
async function cmdProxies(controller, secret, outfile) {
  try {
    const r = await fetch(`${apiBase(controller)}/proxies`, { headers: apiHeaders(secret), signal: AbortSignal.timeout(5000) })
    if (!r.ok) die(`GET /proxies 返回 ${r.status}`)
    writeFileSync(outfile, await r.text())
  } catch (e) {
    die(`GET /proxies 失败: ${e.message}`)
  }
}

// 子命令：switch <controller> <secret> <group> <node> —— PUT /proxies/<group>
async function cmdSwitch(controller, secret, group, node) {
  try {
    const r = await fetch(`${apiBase(controller)}/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      headers: { ...apiHeaders(secret), 'content-type': 'application/json' },
      body: JSON.stringify({ name: node }),
      signal: AbortSignal.timeout(5000),
    })
    process.stdout.write(`${r.status}\n`)
    process.exit(r.status >= 200 && r.status < 300 ? 0 : 1)
  } catch (e) {
    die(`PUT /proxies 失败: ${e.message}`)
  }
}

const [cmd, ...args] = process.argv.slice(2)
switch (cmd) {
  case 'api-info': cmdApiInfo(args[0]); break
  case 'nodes': cmdNodes(args[0]); break
  case 'plan': cmdPlan(args[0], args[1]); break
  case 'probe-config': cmdProbeConfig(args[0], args[1], args[2], args[3], args[4]); break
  case 'ping': await cmdPing(args[0], args[1]); break
  case 'proxies': await cmdProxies(args[0], args[1], args[2]); break
  case 'switch': await cmdSwitch(args[0], args[1], args[2], args[3]); break
  default:
    die(`未知子命令: ${cmd || '(空)'}`)
}
