import { spawn } from 'child_process'
import express from 'express'
import asyncHandler from 'express-async-handler'
import parser from 'fast-xml-parser'
import { readdir, stat, unlink } from 'fs'
import fetch from 'node-fetch'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { WebSocketServer } from 'ws'

const MAX_REQUEST_SIZE_BYTES = 2e+10;

const host = '0.0.0.0'
const port = process.argv[2] || 4242
const app = express()

// See: https://evanhahn.com/gotchas-with-express-query-parsing-and-how-to-avoid-them/
app.set('query parser', (queryString) => {
    return new URLSearchParams(queryString)
})

// See: https://github.com/yt-dlp/yt-dlp#format-selection-examples
const formats = {
    'audio': 'ba/b',
    'video': 'bv+ba/b'
}

const VALID_FORMATS = Object.keys(formats)
const DEFAULT_OPTIONS = {
    "outputDirectory": '/home/ubuntu/downloads',
    "format": "audio"
}

const helpText = `This tool can be used to download media.

Example:
GET https://ytdl.needssoysauce.com/?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=audio

Query Parameters:

 - url      Required. URL of the media to download.
 - format   Optional. One of 'audio' or 'video'. Defaults to 'audio'.
`

const zip = async (paths, outputDirectory = DEFAULT_OPTIONS.outputDirectory) => {
    return new Promise((resolve, reject) => {
        const filename = uuidv4() + '.zip'
        const outputPath = path.join(outputDirectory, filename)
        const ytdlp = spawn('zip', ['-j', outputPath, ...paths])
        console.log(`Zipping ${paths.length} file(s)`)
        ytdlp.on('close', (code) => {
            if (code) {
                reject()
            } else {
                console.log(`Zipped ${paths.length} file(s)`)
                resolve(outputPath)
            }
        });
    })
}

const download = async (urls, options = {}) => {
    const opts = { ...DEFAULT_OPTIONS, ...options }

    const args = [
        '-f', formats[opts.format],
        '-q',
        '-P', opts.outputDirectory,
        '-N', os.cpus().length * 2,
        '--windows-filenames',
        '--exec', 'echo']

    if (opts.format === 'audio') {
        args.push('-x', '--audio-format', 'mp3')
    }

    args.push(...urls)

    console.log(`yt-dlp ${args.join(' ')}`)

    return new Promise((resolve, reject) => {
        const ytdlp = spawn('yt-dlp', args)

        const paths = []
        ytdlp.stdout.on('data', (data) => {
            const filepath = data.toString().trim();
            paths.push(filepath)
            console.log(`Downloaded and saved ${filepath}`)
        })

        const stderr = []
        ytdlp.stderr.on('data', (data) => {
            const message = data.toString().trim();
            stderr.push(message)
            console.log(message)
        })

        ytdlp.on('close', (code) => {
            if (code) {
                reject(new Error(stderr))
            } else {
                console.log(`Downloaded and saved ${paths.length} file(s) to:\n\t${paths.join('\n\t')}`)
                resolve(paths)
            }
        })
    })
}

const parseNumberOrDefault = (value, fallback = 0) => {
    const num = Number(value)
    return isNaN(num) ? fallback : num
}

const getFilesizes = (urls) => {
    const args = ['--print', '%(original_url)s %(filesize,filesize_approx)s %(vbr)s %(abr)s %(duration)s']

    args.push(...urls)

    console.log(`yt-dlp ${args.join(' ')}`)

    return new Promise((resolve, reject) => {
        const ytdlp = spawn('yt-dlp', args)

        const sizes = []
        ytdlp.stdout.on('data', (data) => {
            const [url, bytes, vbr, abr, duration] = data.toString().slice(1, -1).split(' ');
            sizes.push({
                url,
                bytes: parseNumberOrDefault(bytes),
                vbr: parseNumberOrDefault(vbr),
                abr: parseNumberOrDefault(abr),
                duration: parseNumberOrDefault(duration)
            })
        })

        const stderr = []
        ytdlp.stderr.on('data', (data) => {
            const message = data.toString().trim();
            stderr.push(message)
            console.log(message)
        })

        ytdlp.on('close', (code) => {
            if (code) {
                reject(new Error(stderr))
            } else {
                resolve(sizes)
            }
        })
    })
}

const getEstimatedDownloadSize = async (urls, options = { defaultBytes: 1e+10, defaultKbps: 80000 }) => {
    const sizes = await getFilesizes(urls)

    const size = sizes.map(({ url, bytes, vbr, abr, duration }) => {
        if (bytes) {
            return bytes
        } else if ((vbr || abr) && duration) {
            return ((vbr * duration) + (abr * duration)) * 125
        } else if (duration) {
            return options.defaultKbps * duration
        } else {
            console.log(`Unable to determine filesize for '${url}', defaulting to ${options.defaultBytes} bytes`)
            return options.defaultBytes
        }
    }).reduce((prev, curr) => prev + curr, 0)

    return size
}

const deleteFiles = (paths) => {
    const promises = paths.map(path => unlink(path, (err) => {
        if (err) {
            console.log(`Failed to delete '${path}': ${err}`)
        }
    }))
    return Promise.all(promises)
}

const formatBytes = (bytes) => {
    const breakpoints = [
        {
            unit: 'gigabytes (GB)',
            factor: 1e+9
        },
        {
            unit: 'megabytes (MB)',
            factor: 1e+6
        },
        {
            unit: 'kilobytes (KB)',
            factor: 1000
        },
        {
            unit: 'bytes (B)',
            factor: 1
        }
    ]

    let breakpoint = breakpoints.at(-1)

    for (const bp of breakpoints) {
        if (bytes > bp.factor) {
            breakpoint = bp;
            break
        }
    }

    const { unit, factor } = breakpoint

    return `${bytes / factor} ${unit}`
}

app.get('/', asyncHandler(async (req, res) => {
    /** @type {URLSearchParams}  */
    const qs = req.query;
    let urls = qs.getAll('url')
    let format = qs.get('format') ?? DEFAULT_OPTIONS.format

    const requestArgs = { qs: qs.toString(), urls, format }

    console.log(`Request ${JSON.stringify(requestArgs, null, 2)}`)

    if (!urls.length) {
        res.status(400).end(helpText)
        return
    }

    if (format && !VALID_FORMATS.includes(format)) {
        res.status(400).end(`Invalid format`)
        return
    }

    let hrefs
    try {
        hrefs = urls.map(url => new URL(url).href)
    } catch (e) {
        res.status(400).end("Invalid URL")
        return
    }

    let bytes
    try {
        bytes = await getEstimatedDownloadSize(hrefs)
    } catch (e) {
        console.error("Failed to check filesizes")
        console.error(e)
        res.status(500).end("Download failed")
        return
    }

    console.log(`Estimated download size is ${formatBytes(bytes)}`)

    if (bytes > MAX_REQUEST_SIZE_BYTES) {
        res.status(403).end("Request too large")
        return
    }

    let filepaths
    try {
        filepaths = await download(hrefs, { format })
    } catch (e) {
        console.error("Download failed")
        console.error(e)
        res.status(500).end("Download failed")
        return
    }

    const createDownloadCallback = (paths) => (err) => deleteFiles(paths)

    if (filepaths.length > 1) {
        const outputPath = await zip(filepaths)
        res.download(outputPath, createDownloadCallback([outputPath, ...filepaths]))
    } else {
        res.download(filepaths[0], createDownloadCallback(filepaths))
    }
}))

const getFileStats = (filepath) => {
    return new Promise((resolve, reject) => {
        stat(filepath, (err, stats) => {
            if (err) {
                reject(err)
            } else {
                resolve(stats)
            }
        })
    })
}

const getStatsForFiles = async (filepaths) => {
    const stats = await filepaths.map(async filepath => ({
        path: filepath,
        stats: await getFileStats(filepath)
    }))
    return Promise.all(stats)
}

const getFiles = (directory = DEFAULT_OPTIONS.outputDirectory) => {
    return new Promise((resolve, reject) => {
        readdir(directory, (err, files) => {
            if (err) {
                reject(err)
            } else {
                resolve(files)
            }
        })
    })
}

const deleteOldFiles = async (directory = DEFAULT_OPTIONS.outputDirectory, milliseconds = 86400000) => {
    const now = Date.now()
    const files = await getFiles(directory)
    const filepaths = files.map(file => path.join(directory, file))
    const stats = await getStatsForFiles(filepaths)

    const oldFiles = stats
        .filter(file => (now - file.stats.birthtimeMs) > milliseconds)
        .map(file => file.path)

    await deleteFiles(oldFiles)

    if (oldFiles.length) {
        console.log(`Deleted ${oldFiles.length} file(s) older than ${milliseconds} ms`)
    }

    setTimeout(deleteOldFiles, 5000)
}

const getIP = async () => {
    const response = await fetch('http://sandbox.needssoysauce.com/api/ip')
    return response.text()
}

const encodeQueryString = (items) => {
    return Object.entries(items).map(kvp => kvp.map(encodeURIComponent).join('=')).join('&')
}

const updateDdns = async (ip) => {
    const qs = encodeQueryString({
        host: process.env.DDNS_HOST,
        domain: process.env.DDNS_DOMAIN,
        password: process.env.DDNS_PASSWORD,
        ip
    })
    const url = `https://dynamicdns.park-your-domain.com/update?${qs}`
    const response = await fetch(url)
    const text = await response.text()
    const interfaceResponse = parser.parse(text)['interface-response']

    if (interfaceResponse.ErrCount) {
        return Promise.reject(interfaceResponse)
    }
    return Promise.resolve(interfaceResponse)
}

const calculateBackoff = (failCount, min = 5000, max = 60000) => {
    return Math.max(min, Math.min(max, (2 ** failCount - 1) * 500))
}

const updateIP = async (previousIP = null, minDelayMilliseconds = 5000, maxDelayMilliseconds = 60000, failCount = 0) => {
    const newIP = await getIP()

    const scheduleUpdate = (isFailure = false) => {
        const ip = isFailure ? previousIP : newIP
        const newFailCount = isFailure ? failCount + 1 : 0
        const delayMilliseconds = calculateBackoff(newFailCount, minDelayMilliseconds, maxDelayMilliseconds)
        setTimeout(() => {
            updateIP(ip, minDelayMilliseconds, maxDelayMilliseconds, newFailCount)
        }, delayMilliseconds)
        return { newFailCount, delayMilliseconds }
    }

    if (newIP === previousIP) {
        scheduleUpdate()
        return
    }

    try {
        await updateDdns(newIP)
        scheduleUpdate()
        console.log(`Updated IP to ${newIP}`)
    } catch (e) {
        const { newFailCount, delayMilliseconds } = scheduleUpdate(true)
        console.log(JSON.stringify({
            message: `Failed to update IP to ${newIP}. Retrying in ${delayMilliseconds} ms.`,
            delayMilliseconds,
            failCount: newFailCount
        }))
    }
}

deleteOldFiles()
updateIP()

const server = app.listen({ host, port }, () => {
    console.log(`Express listening at http://${host}:${port}`)
})

const wss = new WebSocketServer({
    server,
    maxPayload: 50000 // 50 KB
});

wss.on('connection', (ws, req) => {
    const remoteAddress = req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'Unknown Address'
    const remotePort = req.headers['x-forwarded-port'] ?? 'Unknown Port'
    const from = `${remoteAddress}:${remotePort}`
    const to = `${req.socket.localAddress}:${req.socket.localPort}`
    console.log(`${from} connected to ${to}`)

    ws.on('message', (message) => {
        console.log(`From ${from}: ${message}`);
    });

    ws.send(`Hi ${from}`);
});

wss.on('error', (error) => {
    console.error(error);
})

wss.on('listening', () => {
    console.log(`WebSocketServer listening at ws://${host}:${port}`)
})
