import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import prisma from '../lib/prisma';
import logger from '../lib/logger';

const executeFile = promisify(execFile);
const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;
const PROCESS_OUTPUT_LIMIT = 8_000;
const ffmpegBinary = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
const ffprobeBinary = process.env.FFPROBE_PATH?.trim() || 'ffprobe';

const ALL_QUALITIES = [
    { width: 640, height: 360, bitrate: '800k', name: '360p' },
    { width: 1280, height: 720, bitrate: '2800k', name: '720p' },
    { width: 1920, height: 1080, bitrate: '5000k', name: '1080p' },
];

interface ProbeResult {
    width: number;
    height: number;
    hasAudio: boolean;
}

interface FFProbeMetadata {
    streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
    }>;
}

async function probeVideo(filePath: string): Promise<ProbeResult> {
    const { stdout } = await executeFile(
        ffprobeBinary,
        ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', filePath],
        { timeout: 20_000, maxBuffer: 1_000_000, windowsHide: true },
    );
    const metadata = JSON.parse(stdout) as FFProbeMetadata;
    const videoStream = metadata.streams?.find((stream) => stream.codec_type === 'video');
    if (!videoStream) throw new Error('O arquivo não contém fluxo de vídeo válido.');

    return {
        width: positiveDimension(videoStream.width, 1920),
        height: positiveDimension(videoStream.height, 1080),
        hasAudio: metadata.streams?.some((stream) => stream.codec_type === 'audio') ?? false,
    };
}

interface PgBossJob {
    id?: string;
    data?: { videoId: string; filePath: string };
    videoId?: string;
    filePath?: string;
}

export async function processVideoJob(input: PgBossJob | PgBossJob[]) {
    const job = Array.isArray(input) ? input[0] : input;
    if (!job) {
        logger.error({ input }, 'Job inválido');
        return;
    }
    const videoId = job.data?.videoId ?? job.videoId;
    const filePath = job.data?.filePath ?? job.filePath;

    if (!videoId || !filePath) {
        logger.error({ job }, 'Job inválido');
        return;
    }

    const hlsStorage = process.env.HLS_STORAGE_PATH || './uploads/hls';
    const outDir = path.resolve(hlsStorage, videoId);
    const absoluteInputPath = path.resolve(process.cwd(), filePath);

    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    try {
        await prisma.video.update({ where: { id: videoId }, data: { status: 'PROCESSING' } });
        logger.info({ videoId, inputPath: absoluteInputPath, outputDir: outDir }, 'Iniciando processamento FFmpeg');

        await generateHls(absoluteInputPath, outDir);

        await prisma.video.update({
            where: { id: videoId },
            data: { status: 'READY', hlsUrl: `/hls/${videoId}/master.m3u8` },
        });
        logger.info({ videoId }, 'Processamento HLS concluído');
    } catch (error) {
        logger.error({ videoId, error }, 'Erro ao processar vídeo');
        await prisma.video.update({ where: { id: videoId }, data: { status: 'ERROR' } });
        throw error;
    }
}

async function generateHls(inputFilePath: string, outputDir: string): Promise<void> {
    const probe = await probeVideo(inputFilePath);
    logger.info({ width: probe.width, height: probe.height, hasAudio: probe.hasAudio }, 'Resolução do input');

    let qualities = ALL_QUALITIES.filter((quality) => quality.height <= probe.height);
    if (qualities.length === 0) {
        const width = evenDimension(probe.width);
        const height = evenDimension(probe.height);
        qualities = [{ width, height, bitrate: '800k', name: `${height}p` }];
    }

    logger.info({ qualities: qualities.map((quality) => quality.name) }, 'Qualidades a gerar');

    for (let index = 0; index < qualities.length; index += 1) {
        const quality = qualities[index];
        const variantDirectory = path.join(outputDir, `v${index}`);
        if (!fs.existsSync(variantDirectory)) fs.mkdirSync(variantDirectory, { recursive: true });

        const segmentFilename = path.join(variantDirectory, 'fileSequence%d.ts');
        const playlistOutput = path.join(variantDirectory, 'prog_index.m3u8');
        const args = ['-y', '-i', inputFilePath, '-map', '0:v:0'];
        if (probe.hasAudio) args.push('-map', '0:a:0');
        args.push(
            '-s:v:0', `${quality.width}x${quality.height}`,
            '-b:v:0', quality.bitrate,
            '-c:v', 'libx264',
            '-crf', '23',
            '-preset', 'veryfast',
            '-profile:v', 'main',
            '-g', '48',
            '-sc_threshold', '0',
        );
        if (probe.hasAudio) args.push('-b:a', '128k', '-c:a', 'aac', '-ar', '48000');
        args.push(
            '-f', 'hls',
            '-hls_time', '10',
            '-hls_playlist_type', 'vod',
            '-hls_flags', 'independent_segments',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', segmentFilename,
            playlistOutput,
        );

        await runFfmpeg(args, quality.name);
        logger.info({ quality: quality.name }, 'Qualidade concluída');
    }

    const masterContent = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        ...qualities.flatMap((quality, index) => [
            `#EXT-X-STREAM-INF:BANDWIDTH=${parseInt(quality.bitrate, 10) * 1000},RESOLUTION=${quality.width}x${quality.height}`,
            `v${index}/prog_index.m3u8`,
        ]),
        '',
    ].join('\n');
    fs.writeFileSync(path.join(outputDir, 'master.m3u8'), masterContent);
    logger.info('Master playlist gerada.');
}

function runFfmpeg(args: string[], quality: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(ffmpegBinary, args, {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderrTail = '';
        let settled = false;

        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderrTail = `${stderrTail}${chunk}`.slice(-PROCESS_OUTPUT_LIMIT);
        });

        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
        };

        child.once('error', (error) => finish(error));
        child.once('close', (code, signal) => {
            if (code === 0) {
                finish();
                return;
            }
            finish(new Error(
                `FFmpeg [${quality}] falhou (código ${code ?? 'n/a'}, sinal ${signal ?? 'n/a'}): ${stderrTail.trim()}`,
            ));
        });

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(new Error(`FFmpeg [${quality}] abortado por timeout (${FFMPEG_TIMEOUT_MS / 60_000} min)`));
        }, FFMPEG_TIMEOUT_MS);
        timer.unref();
    });
}

function positiveDimension(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && Number(value) > 1 ? Number(value) : fallback;
}

function evenDimension(value: number): number {
    const normalized = Math.max(2, Math.floor(value));
    return normalized % 2 === 0 ? normalized : normalized - 1;
}
