import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import process from 'node:process'
import { spawn } from 'node:child_process'

// Helpers
async function mkTmpDir(prefix = 'srf-test-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function getFreePort(host = '127.0.0.1') {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, host, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function startServer({ root, port, host = '127.0.0.1', extraArgs = [] }) {
  const args = ['server.js', '--host', host, '--port', String(port), ...extraArgs, root]
  const child = spawn(process.execPath, args, {
    cwd: path.resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const ready = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('Server start timeout')), 5000)
    child.once('error', err => {
      clearTimeout(to)
      reject(err)
    })
    let buf = ''
    const onData = (chunk) => {
      buf += chunk.toString()
      // server prints a line starting with "Serving " when ready
      if (buf.includes('Serving ') && buf.includes('\n')) {
        clearTimeout(to)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
  })

  const stop = () => new Promise(resolve => {
    if (child.killed) return resolve()
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
    // Fallback kill after timeout
    setTimeout(() => {
      if (!child.killed) {
        try {
          child.kill('SIGKILL')
        } catch {
        }
      }
    }, 2000).unref()
  })

  return { child, ready, stop, url: `http://${host}:${port}` }
}

async function req(method, url, headers = {}, body = null) {
  return await new Promise((resolve, reject) => {
    const u = new URL(url)
    const opts = {
      method,
      hostname: u.hostname,
      port: Number(u.port) || 80,
      path: u.pathname + u.search,
      headers,
    }
    const r = http.request(opts, res => {
      const chunks = []
      res.on('data', d => chunks.push(d))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({ status: res.statusCode, headers: res.headers, body: buf })
      })
    })
    r.on('error', reject)
    if (body) r.write(body)
    r.end()
  })
}

test('basic', async (t) => {
  await t.test('serves a static file with correct headers', async (t) => {
    const dir = await mkTmpDir()
    const file = path.join(dir, 'hello.txt')
    await fs.writeFile(file, 'Hello, world!')
    const port = await getFreePort()
    const srv = startServer({ root: dir, port })
    await srv.ready
    t.after(() => srv.stop())
    const res = await req('GET', `${srv.url}/hello.txt`)
    assert.equal(res.status, 200)
    assert.equal(res.body.toString(), 'Hello, world!')
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8')
    assert.ok(res.headers['last-modified'])
    assert.ok(res.headers['etag'])
    assert.equal(res.headers['cache-control'], 'no-cache')
  })

  await t.test('conditional 304 with If-None-Match', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'a.txt'), 'A')
    const port = await getFreePort()
    const srv = startServer({ root: dir, port })
    await srv.ready
    t.after(() => srv.stop())
    const first = await req('GET', `${srv.url}/a.txt`)
    assert.equal(first.status, 200)
    const etag = first.headers['etag']
    const second = await req('GET', `${srv.url}/a.txt`, { 'If-None-Match': etag })
    assert.equal(second.status, 304)
    assert.equal(second.body.length, 0)
  })

  await t.test('conditional 304 with If-Modified-Since', async () => {
    const dir = await mkTmpDir()
    const p = path.join(dir, 'b.txt')
    await fs.writeFile(p, 'B')
    const port = await getFreePort()
    const srv = startServer({ root: dir, port })
    await srv.ready
    t.after(() => srv.stop())
    const first = await req('GET', `${srv.url}/b.txt`)
    assert.equal(first.status, 200)
    const ims = new Date(Date.parse(first.headers['last-modified']) + 1000).toUTCString()
    const second = await req('GET', `${srv.url}/b.txt`, { 'If-Modified-Since': ims })
    assert.equal(second.status, 304)
  })

  await t.test('range requests: partial and suffix bytes', async () => {
    const dir = await mkTmpDir()
    const p = path.join(dir, 'r.txt')
    await fs.writeFile(p, '0123456789')
    const port = await getFreePort()
    const srv = startServer({ root: dir, port })
    await srv.ready
    t.after(() => srv.stop())
    const part = await req('GET', `${srv.url}/r.txt`, { Range: 'bytes=2-5' })
    assert.equal(part.status, 206)
    assert.equal(part.body.toString(), '2345')
    assert.match(String(part.headers['content-range']), /bytes 2-5\/10/)
    const suf = await req('GET', `${srv.url}/r.txt`, { Range: 'bytes=-3' })
    assert.equal(suf.status, 206)
    assert.equal(suf.body.toString(), '789')
  })

  await t.test('invalid range returns 416', async () => {
    const dir = await mkTmpDir()
    const p = path.join(dir, 'z.txt')
    await fs.writeFile(p, 'ABCD')
    const port = await getFreePort()
    const srv = startServer({ root: dir, port })
    await srv.ready
    t.after(() => srv.stop())
    const res = await req('GET', `${srv.url}/z.txt`, { Range: 'bytes=10-2' })
    assert.equal(res.status, 416)
    assert.match(String(res.headers['content-range']), /bytes \*\/4/)
  })

  await t.test('HEAD request to file has no body but has headers', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'head.txt'), 'HEAD')
    const port = await getFreePort()
    const srv = startServer({ root: dir, port })
    await srv.ready
    t.after(() => srv.stop())
    const res = await req('HEAD', `${srv.url}/head.txt`)
    assert.equal(res.status, 200)
    assert.equal(res.body.length, 0)
    assert.ok(res.headers['content-length'])
  })

  await t.test('directory listing enabled by default', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'file.txt'), 'X')
    const port = await getFreePort()
    const srv = startServer({ root: dir, port })
    await srv.ready
    const res = await req('GET', `${srv.url}/`)
    assert.equal(res.status, 200)
    const html = res.body.toString()
    assert.match(html, /Index of \/</)
    assert.match(html, /file.txt/)
    await srv.stop()
  })

  await t.test('directory listing can be disabled', async () => {
    const dir = await mkTmpDir()
    const port = await getFreePort()
    const srv = startServer({ root: dir, port, extraArgs: ['--no-listing'] })
    await srv.ready
    t.after(() => srv.stop())
    const res = await req('GET', `${srv.url}/`)
    assert.equal(res.status, 403)
  })

  await t.test('serves index.html in a directory if present', async () => {
    const dir = await mkTmpDir()
    const sub = path.join(dir, 'sub')
    await fs.mkdir(sub)
    await fs.writeFile(path.join(sub, 'index.html'), '<h1>Hello</h1>')
    const port = await getFreePort()
    const srv = startServer({ root: dir, port })
    await srv.ready
    t.after(() => srv.stop())
    const res = await req('GET', `${srv.url}/sub/`)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(res.body.toString(), '<h1>Hello</h1>')
  })

  await t.test('SPA mode serves index.html for not found paths', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'index.html'), '<p>SPA</p>')
    const port = await getFreePort()
    const srv = startServer({ root: dir, port, extraArgs: ['--spa'] })
    await srv.ready
    t.after(() => srv.stop())
    const res = await req('GET', `${srv.url}/non-existent/path`)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(res.body.toString(), '<p>SPA</p>')
  })

  await t.test('unknown extension served as application/octet-stream', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'data.binx'), '\x00\x01')
    const port = await getFreePort()
    const srv = startServer({ root: dir, port })
    await srv.ready
    t.after(() => srv.stop())
    const res = await req('GET', `${srv.url}/data.binx`)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/octet-stream')
  })
})

test('security', async (t) => {
  function assertNotLeaked(res, secret) {
    // any deny status is okay, but body must not contain the secret
    assert.notEqual(res.status, 200, `Expected non-200, got ${res.status}`)
    const body = res.body.toString('utf8')
    assert.ok(!body.includes(secret), 'Secret content leaked in response body')
  }

  await t.test('security: blocks plain .. traversal to file outside root', async () => {
    const parent = await mkTmpDir()
    const root = path.join(parent, 'root')
    const outside = path.join(parent, 'outside')
    await fs.mkdir(root)
    await fs.mkdir(outside)

    const secret = 'TOP_SECRET'
    await fs.writeFile(path.join(outside, 'secret.txt'), secret)
    await fs.writeFile(path.join(root, 'public.txt'), 'ok')

    const port = await getFreePort()
    const srv = startServer({ root, port })
    await srv.ready
    t.after(() => srv.stop())

    // try to escape root -> ../outside/secret.txt
    const res = await req('GET', `${srv.url}/../outside/secret.txt`)
    assertNotLeaked(res, secret)
  })

  await t.test('security: blocks encoded dotdot (%2e%2e) traversal', async () => {
    const parent = await mkTmpDir()
    const root = path.join(parent, 'root')
    const outside = path.join(parent, 'outside')
    await fs.mkdir(root)
    await fs.mkdir(outside)

    const secret = 'TOP_SECRET'
    await fs.writeFile(path.join(outside, 'secret.txt'), secret)

    const port = await getFreePort()
    const srv = startServer({ root, port })
    await srv.ready
    t.after(() => srv.stop())

    // ../outside/secret.txt but encoded
    const res = await req('GET', `${srv.url}/%2e%2e/outside/secret.txt`)
    assertNotLeaked(res, secret)
  })

  await t.test('security: blocks double-encoded dotdot (%252e%252e) traversal', async () => {
    const parent = await mkTmpDir()
    const root = path.join(parent, 'root')
    const outside = path.join(parent, 'outside')
    await fs.mkdir(root)
    await fs.mkdir(outside)

    const secret = 'TOP_SECRET'
    await fs.writeFile(path.join(outside, 'secret.txt'), secret)

    const port = await getFreePort()
    const srv = startServer({ root, port })
    await srv.ready
    t.after(() => srv.stop())

    // %252e is literal "%2e" after one decode, so this catches servers that decode twice.
    const res = await req('GET', `${srv.url}/%252e%252e/outside/secret.txt`)
    assertNotLeaked(res, secret)
  })

  await t.test('security: blocks traversal using mixed separators (Windows/backslash)', async () => {
    const parent = await mkTmpDir()
    const root = path.join(parent, 'root')
    const outside = path.join(parent, 'outside')
    await fs.mkdir(root)
    await fs.mkdir(outside)

    const secret = 'TOP_SECRET'
    await fs.writeFile(path.join(outside, 'secret.txt'), secret)

    const port = await getFreePort()
    const srv = startServer({ root, port })
    await srv.ready
    t.after(() => srv.stop())

    // Backslash in URL path (some servers treat as separator)
    const res1 = await req('GET', `${srv.url}/..\\outside\\secret.txt`)
    assertNotLeaked(res1, secret)

    // Encoded backslash %5c
    const res2 = await req('GET', `${srv.url}/..%5coutside%5csecret.txt`)
    assertNotLeaked(res2, secret)
  })

  await t.test('security: encoded slash (%2f) and encoded backslash (%5c) do not enable escape', async () => {
    const parent = await mkTmpDir()
    const root = path.join(parent, 'root')
    const outside = path.join(parent, 'outside')
    await fs.mkdir(root)
    await fs.mkdir(outside)

    const secret = 'TOP_SECRET'
    await fs.writeFile(path.join(outside, 'secret.txt'), secret)

    const port = await getFreePort()
    const srv = startServer({ root, port })
    await srv.ready
    t.after(() => srv.stop())

    // If your server decodes %2f inside a segment, it might create new path segments
    const res1 = await req('GET', `${srv.url}/..%2foutside%2fsecret.txt`)
    assertNotLeaked(res1, secret)

    // Double-encoded slash: %252f becomes %2f after one decode
    const res2 = await req('GET', `${srv.url}/..%252foutside%252fsecret.txt`)
    assertNotLeaked(res2, secret)
  })

  await t.test('security: normalization does not allow sneaky segments (./, repeated slashes)', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'a.txt'), 'A')

    const port = await getFreePort()
    const srv = startServer({ root: dir, port })
    await srv.ready
    t.after(() => srv.stop())

    // These should still resolve to /a.txt (and not crash / mis-handle)
    const r1 = await req('GET', `${srv.url}//a.txt`)
    assert.equal(r1.status, 200)
    assert.equal(r1.body.toString(), 'A')

    const r2 = await req('GET', `${srv.url}/./a.txt`)
    assert.equal(r2.status, 200)
    assert.equal(r2.body.toString(), 'A')

    const r3 = await req('GET', `${srv.url}/x/../a.txt`)
    // Depending on your policy, you might:
    // - normalize and serve (200), or
    // - reject paths containing '..' (400/403)
    if (r3.status === 200) {
      assert.equal(r3.body.toString(), 'A')
    } else {
      // still must not leak anything; just ensure it isn't a weird success-with-wrong-body
      assert.notEqual(r3.status, 500)
    }
  })

  await t.test('security: NUL byte injection is rejected', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'nul.txt'), 'NUL')

    const port = await getFreePort()
    const srv = startServer({ root: dir, port })
    await srv.ready
    t.after(() => srv.stop())

    // %00 historically causes path truncation issues in some stacks
    const res = await req('GET', `${srv.url}/nul.txt%00.png`)
    // should not serve nul.txt
    assert.notEqual(res.status, 200)
  })
})
