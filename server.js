#!/usr/bin/env node
import http from 'node:http'
import os from 'node:os'
import fs, { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { stat, readdir, access } = fsPromises

function parseArgs(argv) {
  const args = {
    root: null,
    port: 8080,
    host: '0.0.0.0',
    listing: true,
    spa: false,
    cacheSeconds: 0,
  }
  const rest = []
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port' || a === '-p') {
      args.port = Number(argv[++i] ?? args.port)
    } else if (a.startsWith('--port=')) {
      args.port = Number(a.split('=')[1])
    } else if (a === '--host') {
      args.host = String(argv[++i] ?? args.host)
    } else if (a.startsWith('--host=')) {
      args.host = a.split('=')[1]
    } else if (a === '--no-listing') {
      args.listing = false
    } else if (a === '--spa') {
      args.spa = true
    } else if (a === '--cache') {
      args.cacheSeconds = Number(argv[++i] ?? args.cacheSeconds)
    } else if (a.startsWith('--cache=')) {
      args.cacheSeconds = Number(a.split('=')[1])
    } else if (a === '-h' || a === '--help') {
      printHelpAndExit()
    } else if (a === '-v' || a === '--version') {
      const pkg = { version: '?' }
      try {
        const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json')
        const content = fs.readFileSync(pkgPath, 'utf8')
        Object.assign(pkg, JSON.parse(content))
      } catch {
      }
      console.log(pkg.version)
      process.exit(0)
    } else if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`)
      printHelpAndExit(1)
    } else {
      rest.push(a)
    }
  }
  args.root = path.resolve(rest[0] ?? process.cwd())
  return args
}

function printHelpAndExit(code = 0) {
  const help = `
Usage: srf [options] [root]

Options:
  -p, --port <number>     Port to listen on (default: 8080)
      --host <host>       Host to bind (default: 0.0.0.0)
      --no-listing        Disable directory listing
      --spa               Single Page App mode (serve index.html for 404s)
      --cache <seconds>   Cache-Control max-age in seconds (default: 0)
  -h, --help              Show this help
  -v, --version           Show version

Examples:
  srf                     Serve current directory
  srf -p 3000 public      Serve ./public on port 3000
`
  console.log(help)
  process.exit(code)
}

// Minimal MIME map
const MIME = new Map(Object.entries({
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wasm: 'application/wasm',
}))

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  return MIME.get(ext) || 'application/octet-stream'
}

function etagFromStats(st) {
  // Weak ETag based on size-mtime
  const mtime = Number(st.mtimeMs).toString(16)
  const size = Number(st.size).toString(16)
  return `W/"${size}-${mtime}"`
}

function safeJoin(root, requestPath) {
  // decode URI components safely
  let decoded
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    decoded = '/'
  }
  // Prevent null bytes and normalize
  decoded = decoded.replace(/\0/g, '')
  const resolved = path.resolve(root, '.' + decoded)
  if (!resolved.startsWith(root)) return null
  return resolved
}

async function fileExists(p) {
  try {
    await access(p, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

function sendError(res, code, msg) {
  const body = [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>html { color-scheme: light dark; font: 16px system-ui; }</style>',
    `<title>${code}</title>`,
    `<h1>${code}</h1>`,
    `<p>${msg}</p>`,
  ].join('\n')
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function listDirectory(dirPath, reqPath) {
  reqPath = reqPath.endsWith('/') ? reqPath : reqPath + '/'
  const items = await readdir(dirPath, { withFileTypes: true })
  const parts = [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>html { color-scheme: light dark; font: 16px system-ui; }</style>',
    `<title>Index of ${escapeHtml(decodeURI(reqPath))}</title>`,
    `<h1>Index of ${escapeHtml(decodeURI(reqPath))}</h1>`,
    '<ul>',
  ]
  if (reqPath !== '/') parts.push(`<li><a href="..">..</a></li>`)
  for (const it of items) {
    const name = it.name + (it.isDirectory() ? '/' : '')
    const href = reqPath + encodeURI(name)
    parts.push(`<li><a href="${href}">${escapeHtml(name)}</a></li>`)
  }
  parts.push('</ul>')
  return parts.join('\n')
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]))
}

async function serveFile(req, res, filePath, st, opts) {
  const type = contentTypeFor(filePath)
  const etag = etagFromStats(st)
  const lastModified = new Date(st.mtimeMs).toUTCString()
  const headers = {
    'Content-Type': type,
    'Last-Modified': lastModified,
    'ETag': etag,
    'Accept-Ranges': 'bytes',
  }
  if (opts.cacheSeconds > 0) {
    headers['Cache-Control'] = `public, max-age=${opts.cacheSeconds}`
  } else {
    headers['Cache-Control'] = 'no-cache'
  }

  // Conditional requests
  const inm = req.headers['if-none-match']
  const ims = req.headers['if-modified-since']
  if ((inm && inm === etag) || (ims && new Date(ims).getTime() >= st.mtimeMs)) {
    res.writeHead(304, headers)
    res.end()
    return
  }

  // Range requests
  let start = 0, end = st.size - 1, statusCode = 200
  const range = req.headers['range']
  if (range && /^bytes=/.test(range)) {
    const spec = range.replace(/bytes=/, '').split(',')[0].trim()
    let valid = false
    let s, e
    if (spec.includes('-')) {
      [s, e] = spec.split('-')
    }

    if (s === '' && e !== undefined) {
      // suffix bytes: last N bytes
      const suffix = Number(e)
      if (Number.isFinite(suffix) && suffix > 0) {
        start = Math.max(0, st.size - suffix)
        end = st.size - 1
        valid = start <= end
      }
    } else if (s !== undefined) {
      const sNum = Number(s)
      const eNum = e === undefined || e === '' ? (st.size - 1) : Number(e)
      if (Number.isFinite(sNum) && Number.isFinite(eNum) && sNum <= eNum) {
        // start must be within the resource size
        if (sNum < st.size) {
          start = Math.max(0, sNum)
          end = Math.min(eNum, st.size - 1)
          valid = start <= end
        } else {
          valid = false
        }
      }
    }

    if (!valid) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` })
      res.end()
      return
    }

    statusCode = 206
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`
  }

  const contentLength = end - start + 1
  headers['Content-Length'] = contentLength

  res.writeHead(statusCode, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const stream = fs.createReadStream(filePath, { start, end })
  stream.on('error', err => {
    console.error(err)
    if (!res.headersSent) res.writeHead(500)
    res.end('Internal Server Error')
  })
  stream.pipe(res)
}

async function handlerFactory(root, opts) {
  const rootResolved = path.resolve(root)
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    let reqPath = url.pathname
    // Disallow hidden control paths
    const absPath = safeJoin(rootResolved, reqPath)
    if (!absPath) return sendError(res, 400, 'Bad Request')

    let st
    try {
      st = await stat(absPath)
    } catch {
      // Not found. If SPA mode and file has an extension, or even for any path -> serve index.html if exists
      if (opts.spa) {
        const indexPath = path.join(rootResolved, 'index.html')
        if (await fileExists(indexPath)) {
          try {
            const ist = await stat(indexPath)
            await serveFile(req, res, indexPath, ist, opts)
            logRequest(req, res.statusCode, reqPath)
            return
          } catch {
          }
        }
      }
      sendError(res, 404, 'Not Found')
      logRequest(req, 404, reqPath)
      return
    }

    if (st.isDirectory()) {
      // Try index.html
      const indexPath = path.join(absPath, 'index.html')
      if (await fileExists(indexPath)) {
        const ist = await stat(indexPath)
        await serveFile(req, res, indexPath, ist, opts)
        logRequest(req, res.statusCode, reqPath)
        return
      }
      if (!opts.listing) {
        sendError(res, 403, 'Directory listing denied')
        logRequest(req, 403, reqPath)
        return
      }
      try {
        const body = await listDirectory(absPath, reqPath)
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-cache',
        })
        if (req.method === 'HEAD') {
          res.end()
        } else {
          res.end(body)
        }
        logRequest(req, 200, reqPath)
        return
      } catch (e) {
        console.error(e)
        sendError(res, 500, 'Failed to read directory')
        logRequest(req, 500, reqPath)
        return
      }
    }

    try {
      await serveFile(req, res, absPath, st, opts)
      logRequest(req, res.statusCode, reqPath)
    } catch (e) {
      console.error(e)
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error')
      logRequest(req, res.statusCode || 500, reqPath)
    }
  }
}

function logRequest(req, status, path) {
  const time = new Date().toISOString()
  console.log(`[${time}] ${req.method} ${path} -> ${status}`)
}

function getLanAddress() {
  const nets = os.networkInterfaces()
  for (const ifaces of Object.values(nets)) {
    for (const addr of ifaces ?? []) {
      if (addr && addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return null
}

async function main() {
  const args = parseArgs(process.argv)
  try {
    const st = await stat(args.root)
    if (!st.isDirectory()) {
      console.error(`Root is not a directory: ${args.root}`)
      process.exit(2)
    }
  } catch {
    console.error(`Root directory does not exist: ${args.root}`)
    process.exit(2)
  }

  const handler = await handlerFactory(args.root, {
    listing: args.listing,
    spa: args.spa,
    cacheSeconds: Number.isFinite(args.cacheSeconds) ? Math.max(0, args.cacheSeconds) : 0,
  })
  const server = http.createServer((req, res) => {
    // Ensure we always handle errors
    handler(req, res).catch(err => {
      console.error(err)
      try {
        sendError(res, 500, 'Internal Server Error')
      } catch {
      }
    })
  })

  server.listen(args.port, args.host, () => {
    console.log(`Serving ${path.basename(args.root)}/`)
    const lanAddress = getLanAddress()
    console.log(`
    - Local:    http://${args.host}:${args.port}
    - Network:  ${(lanAddress ? `http://${lanAddress}:${args.port}` : 'not available')}
    `)
    if (!args.listing) console.log('Directory listing disabled')
    if (args.spa) console.log('SPA mode enabled')
    if (args.cacheSeconds > 0) console.log(`Cache-Control: max-age=${args.cacheSeconds}`)
  })

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
