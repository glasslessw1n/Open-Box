// traffic-guard 测试用的假机场节点 / 假源站。
//
// 用法：
//   node fake-provider.mjs origin-204 <port>          —— 任意请求都回 204 的源站（模拟 generate_204）
//   node fake-provider.mjs origin-payload <port>      —— 回 ?bytes=N 个字节 octet-stream 的源站（模拟测速文件）
//   node fake-provider.mjs node <mode> <port>         —— 一个 HTTP 代理形态的“节点”，mode 决定它的行为：
//        healthy   正常转发（CONNECT 隧道 + 普通 HTTP 代理），可用环境变量 DELAY_MS 给每次请求加延时
//        blockpage 任何普通 HTTP 请求都回 200 + HTML 限流页（模拟流量耗尽时服务商返回提示页）
//        blackhole 接受请求后永远不回数据（模拟“连接在、吞吐为零”）
//        throttle  正常转发，但响应数据以 RATE_BPS 字节/秒的速度滴回（模拟被限速）

import http from 'node:http'
import net from 'node:net'
import { Transform } from 'node:stream'

// 流式限速：数据边到边走，按 bps 匀速放行（每 100ms 放行 1/10 秒的量）。
// 要点：flush 的回调必须等队列排空后再调用，否则 Node 会提前结束读侧、把流截断
//（踩过：先攒完再滴 + flush 立即返回，会让下载中途断开）；也不能等上游 socket 关闭
// 才开始放行（keep-alive 连接会白白等 5 秒）。
function throttleTransform(bps) {
  const step = Math.max(1, Math.floor(bps / 10))
  const queue = []
  let srcEnded = false
  let pumping = false
  let flushCb = null
  const t = new Transform({
    transform(chunk, enc, cb) { queue.push(chunk); cb(); pump() },
    flush(cb) {
      srcEnded = true
      if (!pumping && queue.length === 0) cb()
      else flushCb = cb
    },
  })
  function pump() {
    if (pumping) return
    pumping = true
    const timer = setInterval(() => {
      if (queue.length) {
        const c = queue[0]
        const slice = c.subarray(0, step)
        if (slice.length === c.length) queue.shift()
        else queue[0] = c.subarray(step)
        t.push(slice)
      } else {
        clearInterval(timer)
        pumping = false
        if (srcEnded && flushCb) { const f = flushCb; flushCb = null; f() }
      }
    }, 100)
  }
  return t
}

const [, , kind, ...rest] = process.argv

function listen(server, port) {
  server.listen(port, '127.0.0.1', () => process.stdout.write(`listening ${port}\n`))
}

if (kind === 'origin-204') {
  listen(http.createServer((req, res) => { res.writeHead(204); res.end() }), Number(rest[0]))
} else if (kind === 'origin-payload') {
  listen(http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const n = Math.max(0, Number(u.searchParams.get('bytes') || 262144))
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': n })
    res.end(Buffer.alloc(n, 0x61))
  }), Number(rest[0]))
} else if (kind === 'node') {
  const [mode, port] = rest
  const delayMs = Number(process.env.DELAY_MS || 0)
  const rateBps = Number(process.env.RATE_BPS || 5000)

  const forwardHttp = (req, res, throttle) => {
    const target = new URL(req.url)
    const up = http.request({
      hostname: target.hostname, port: target.port, path: target.pathname + target.search,
      method: req.method, headers: req.headers,
    }, upRes => {
      res.writeHead(upRes.statusCode || 502, upRes.headers)
      if (!throttle) { upRes.pipe(res); return }
      // 限速：把上游数据攒着，按 rateBps 滴给下游
      const chunks = []
      upRes.on('data', c => chunks.push(c))
      upRes.on('end', () => {
        const buf = Buffer.concat(chunks)
        const step = Math.max(1, Math.floor(rateBps / 10))
        let off = 0
        const timer = setInterval(() => {
          const slice = buf.subarray(off, off + step)
          off += slice.length
          if (slice.length) res.write(slice)
          if (off >= buf.length) { clearInterval(timer); res.end() }
        }, 100)
      })
    })
    up.on('error', () => { try { res.writeHead(502); res.end() } catch { /* 已断开 */ } })
    req.pipe(up)
  }

  const server = http.createServer((req, res) => {
    const handle = () => {
      if (mode === 'blockpage') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><head><title>提示</title></head><body>您的套餐流量已用完，请充值后继续使用。</body></html>')
      } else if (mode === 'blackhole') {
        // 故意什么都不做：连接保持，数据为零
      } else if (mode === 'healthy') {
        forwardHttp(req, res, false)
      } else if (mode === 'throttle') {
        forwardHttp(req, res, true)
      } else {
        res.writeHead(500); res.end('unknown mode')
      }
    }
    if (delayMs > 0 && (mode === 'healthy')) setTimeout(handle, delayMs)
    else handle()
  })

  server.on('connect', (req, clientSocket, head) => {
    const { port: tPort, hostname } = new URL(`http://${req.url}`)
    if (mode === 'blackhole') {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      return // 隧道建好但永远不转发数据
    }
    if (mode === 'blockpage') {
      clientSocket.write('HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\n<html><body>流量已用完</body></html>')
      clientSocket.end()
      return
    }
    // 注意：sing-box 的 http 出站对普通 HTTP 目标也走 CONNECT 隧道，
    // 所以各 mode 的行为必须在 CONNECT 路径上同样成立（限速/延时不能只写在普通请求处理里）。
    const upstream = net.connect(Number(tPort) || 80, hostname, () => {
      const establish = () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head && head.length) upstream.write(head)
        if (mode === 'throttle') {
          upstream.pipe(throttleTransform(rateBps)).pipe(clientSocket)
        } else {
          upstream.pipe(clientSocket)
        }
        clientSocket.pipe(upstream)
      }
      if (mode === 'healthy' && delayMs > 0) setTimeout(establish, delayMs)
      else establish()
    })
    upstream.on('error', () => clientSocket.destroy())
  })

  listen(server, Number(port))
} else {
  process.stderr.write('未知模式\n')
  process.exit(2)
}
