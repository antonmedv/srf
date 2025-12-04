# srf

[![test](https://github.com/antonmedv/srf/actions/workflows/test.yaml/badge.svg)](https://github.com/antonmedv/srf/actions/workflows/test.yaml)
[![version](https://img.shields.io/npm/v/srf)](https://www.npmjs.com/package/srf)

**Serve Really Fast**

A tiny, [dependency-free](https://www.npmjs.com/package/srf?activeTab=dependencies) static file server for Node.js. It
serves a folder over HTTP, with directory listings, SPA fallback, and basic caching (ETag/Last-Modified) for quickly
previewing local sites or builds.

```
Serving public/

    - Local:    http://0.0.0.0:8080
    - Network:  http://192.168.1.42:8080

[2025-12-03T20:00:42.007Z] GET /index.html -> 200
```

## Installation

```sh
npm i -g srf
```

```sh
npx srf
```

## Usage

```
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
```

## Benchmark

| Server      | Requests/sec |
|-------------|-------------:|
| srf         |        22104 |
| http-server |        11504 |
| serve       |        11479 |

Measured with **wrk** on a **MacBook Air M2**. In this run, **srf is ~2× faster** than `http-server` and `serve` by
requests/sec.

## License

[MIT](LICENSE)
