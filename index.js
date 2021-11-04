const { spawn } = require('child_process')
const path = require('path')
const { unlink, stat, readdir, fstat } = require('fs')
const express = require('express')
const asyncHandler = require('express-async-handler')
const { v4: uuidv4 } = require('uuid')

const app = express()
const host = '0.0.0.0'
const port = 4242

// See: https://github.com/yt-dlp/yt-dlp#format-selection-examples
const formats = {
    'audio': 'bestaudio',
    'video': 'bv+ba/b'
}

const VALID_FORMATS = Object.keys(formats)
const DEFAULT_OPTIONS = {
    "outputDirectory": '/home/ubuntu/downloads',
    "format": "audio"
}

const helpText = `This tool can be used to download media.

Example:
GET /?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=audio

Query Parameters:

 - url      Required. URL of the media to download.
 - format   Optional. One of 'audio' or 'video'. Defaults to 'audio'.
`

const zip = async (paths, outputDirectory = DEFAULT_OPTIONS.outputDirectory) => {
    return new Promise((resolve, reject) => {
        const filename = uuidv4() + '.zip'
        const outputPath = path.join(outputDirectory, filename)
        const ytdlp = spawn('zip', ['-j', outputPath, ...paths])
        ytdlp.on('close', (code) => {
            if (code) {
                reject()
            } else {
                resolve(outputPath)
            }
        });
    })
}

const download = async (url, options = {}) => {
    const opts = { ...DEFAULT_OPTIONS, ...options }

    const args = [
        '-f', formats[opts.format],
        '-x',
        '-q',
        '-P', opts.outputDirectory,
        '--windows-filenames',
        '--exec', 'echo']

    if (opts.format === 'audio') {
        args.push('--audio-format', 'mp3')
    }

    args.push(url)

    return new Promise((resolve, reject) => {
        const ytdlp = spawn('yt-dlp', args)

        const paths = []
        ytdlp.stdout.on('data', (data) => {
            process.stdout.write(data)
            paths.push(data.toString().trim())
        })

        ytdlp.stderr.on('data', (data) => {
            process.stderr.write(`${data}`)
        })

        ytdlp.on('close', (code) => {
            if (code) {
                reject()
            } else {
                resolve(paths)
            }
        })
    })
}

const deleteFiles = (paths) => {
    const promises = paths.map(path => unlink(path, (err) => {
        if (err) {
            console.log(`Failed to delete '${path}': ${err}`)
        }
    }))
    return Promise.all(promises)
}

app.get('/', asyncHandler(async (req, res) => {
    let url = req.query.url
    let format = req.query.format ?? DEFAULT_OPTIONS.format

    if (!url) {
        res.status(400).end(helpText)
        return
    }

    if (format && !VALID_FORMATS.includes(format)) {
        res.status(400).end(`Invalid format.`)
        return
    }

    let href
    try {
        href = new URL(req.query.url).href
    } catch (e) {
        res.status(400).end("Invalid URL")
        return
    }

    let filepaths
    try {
        filepaths = await download(href, { format })
    } catch (e) {
        res.status(400).end("Invalid URL")
        return
    }

    const downloadCallback = (err) => deleteFiles(filepaths)

    if (filepaths.length > 1) {
        const outputPath = await zip(filepaths)
        res.download(outputPath, downloadCallback)
    } else {
        res.download(filepaths[0], downloadCallback)
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

const deleteOldFiles = async (directory = DEFAULT_OPTIONS.outputDirectory, milliseconds = 300000) => {
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

deleteOldFiles()

app.listen(port, host, () => {
    console.log(`Listening at http://${host}:${port}`)
})