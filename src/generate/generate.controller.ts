import {
  Body,
  Controller,
  Post,
  BadRequestException,
  Logger,
  Get,
  Param,
  Req,
  Res,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { GenerateService } from './generate.service';
import { GenerateDto } from './generate.dto';
import { GenerateScriptDto } from './generate-script.dto';
import { GenerateVideoDto } from './generate-video.dto';
import { DebugExtractDto } from './debug-extract.dto';

@Controller()
export class GenerateController {
  constructor(private readonly generateService: GenerateService) {}
  private readonly logger = new Logger(GenerateController.name);

  @Post('generate-description')
  async generateDescription(@Body() body: GenerateDto) {
    // Accept either `prompt` (preferred) or `tempPrompt` (frontend earlier used this name)
    const prompt = (body as any).prompt ?? (body as any).tempPrompt;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new BadRequestException('Missing required field: prompt');
    }

    const result = await this.generateService.generateDescription(prompt.trim());
    return { description: result };
  }

  @Post('generate-image')
  async generateImage(@Body() body: GenerateDto) {
    const prompt = (body as any).prompt ?? (body as any).tempPrompt;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new BadRequestException('Missing required field: prompt');
    }

    const dataUrl = await this.generateService.generateImage(prompt.trim());
    return { image: dataUrl };
  }

  @Post('generate-script')
  async generateScript(@Body() body: GenerateScriptDto) {
    const prompt = (body as any).prompt ?? (body as any).tempPrompt;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new BadRequestException('Missing required field: prompt');
    }

    // Accept up to 3 characters
    let characters = Array.isArray(body.characters) ? body.characters.filter(c=>c && c.name).slice(0,3) : undefined;
    const script = await this.generateService.generateScript(prompt.trim(), characters);
    console.log(script);
    return { script };
  }

  @Post('generate-video')
  async generateVideo(@Body() body: GenerateVideoDto) {
    // Log incoming request metadata (avoid dumping full base64 strings)
    try {
      const meta = {
        scriptChunks: Array.isArray(body.script) ? body.script.length : 0,
        times: Array.isArray(body.script) ? body.script.map((c: any) => c?.time).filter(Boolean) : [],
        characters:
          Array.isArray(body.characters) ? body.characters.map((c: any) => c?.name).filter(Boolean) : [],
        hasFirstFrame: typeof body.firstFrame === 'string' && body.firstFrame.length > 0,
        model: body.model ?? null,
      };
      this.logger.log(`/generate-video request: ${JSON.stringify(meta)}`);
    } catch {}

    if (!Array.isArray(body.script) || body.script.length === 0) {
      throw new BadRequestException('Missing required field: script (non-empty array)');
    }
    // Optional: coerce firstFrame data URL/base64
    const firstFrame = typeof body.firstFrame === 'string' && body.firstFrame.trim() ? body.firstFrame.trim() : undefined;
    const characters = Array.isArray(body.characters) ? body.characters.slice(0, 3) : undefined;
    const model = body.model;

    // Explicit start log
    this.logger.log(
      `Starting video generation: chunks=${body.script.length}, model=${model ?? process.env.VIDEO_MODEL ?? 'default'}, firstFrame=${firstFrame ? 'yes' : 'no'}, characters=${characters?.map(c=>c.name).join(', ') ?? ''}`,
    );

    // Determine a safe output filename (frontend can provide body.outputName to control it)
    const path = require('node:path');
    const safeOutputName = (typeof (body as any).outputName === 'string' && (body as any).outputName.trim())
      ? path.basename((body as any).outputName.trim())
      : `combined_${Date.now()}.mp4`;

    const notifyUrl = typeof (body as any).notifyUrl === 'string' && (body as any).notifyUrl.trim() ? (body as any).notifyUrl.trim() : undefined;

    const result = await this.generateService.generateVideo({ script: body.script, firstFrame, characters, model, outputName: safeOutputName, notifyUrl });
    // Backward compatibility: if service returned an array, wrap it; otherwise pass through
    // Return result as-is; ensure `filename` is present so frontend can request /videos/stream/:filename
    if (Array.isArray(result)) {
      return { clips: result };
    }
    return result;
  }

  @Post('debug-extract-last-frame')
  async debugExtractLastFrame(@Body() body: DebugExtractDto) {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const http = require('node:http');
    const https = require('node:https');

    const vidsDir = process.env.UPLOAD_VIDEOS_DIR ?? 'uploads/videos';

    const pickLatestPath = (): string | undefined => {
      try {
        const dir = vidsDir;
        const files = fs.readdirSync(dir).filter((f: string) => /\.(mp4|webm)$/i.test(f));
        if (files.length === 0) return undefined;
        const withTime = files.map((f: string) => {
          const fp = path.resolve(dir, f);
          try { const st = fs.statSync(fp); return { fp, mtime: st.mtimeMs }; } catch { return { fp, mtime: 0 }; }
        });
        withTime.sort((a: any, b: any) => b.mtime - a.mtime);
        return withTime[0]?.fp;
      } catch { return undefined; }
    };

    const downloadToTmp = async (urlStr: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        try {
          const client = urlStr.startsWith('https') ? https : http;
          const tmpPath = path.resolve(os.tmpdir(), `debug_video_${Date.now()}_${Math.random().toString(36).slice(2,8)}.mp4`);
          const file = fs.createWriteStream(tmpPath);
          const req = client.get(urlStr, (res: any) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              // follow one redirect
              return client.get(res.headers.location, (res2: any) => res2.pipe(file));
            }
            res.pipe(file);
          });
          req.on('error', reject);
          file.on('finish', () => file.close(() => resolve(tmpPath)));
          file.on('error', reject);
        } catch (e) { reject(e); }
      });
    };

    let usedPath: string | undefined = undefined;
    if (body?.videoPath && typeof body.videoPath === 'string') {
      usedPath = body.videoPath;
    } else if (body?.videoUrl && typeof body.videoUrl === 'string') {
      usedPath = await downloadToTmp(body.videoUrl);
    } else if (body?.pickLatest || !body) {
      usedPath = pickLatestPath();
    }

    if (!usedPath) throw new BadRequestException('Provide videoPath, videoUrl, or set pickLatest=true when there are saved clips.');

    const image = await this.generateService.debugExtractLastFrame(usedPath);
    return { image, usedPath };
  }

  // Stream video with Range support for HTML5 players
  @Get('videos/stream/:name')
  async streamVideo(@Param('name') name: string, @Req() req: Request, @Res() res: Response) {
    const fs = require('node:fs');
    const path = require('node:path');
    const vidsDir = process.env.UPLOAD_VIDEOS_DIR ?? 'uploads/videos';
    if (!name || typeof name !== 'string') throw new NotFoundException('Missing filename');

    // Sanitize: only allow basename and resolve under vidsDir
    const safe = path.basename(name);
    const filePath = path.resolve(vidsDir, safe);
    if (!filePath.startsWith(path.resolve(vidsDir))) {
      throw new NotFoundException('Invalid file');
    }

    if (!fs.existsSync(filePath)) throw new NotFoundException('File not found');

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === '.webm' ? 'video/webm' : 'video/mp4';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= fileSize) {
        res.status(416).set({ 'Content-Range': `bytes */${fileSize}` }).end();
        return;
      }
      const chunkSize = end - start + 1;
      res.status(206);
      res.set({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunkSize),
        'Content-Type': mimeType,
      });
      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.status(200);
      res.set({ 'Content-Length': String(fileSize), 'Content-Type': mimeType, 'Accept-Ranges': 'bytes' });
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    }
  }

  // Download video as attachment
  @Get('videos/download/:name')
  async downloadVideo(@Param('name') name: string, @Res() res: Response) {
    const fs = require('node:fs');
    const path = require('node:path');
    const vidsDir = process.env.UPLOAD_VIDEOS_DIR ?? 'uploads/videos';
    if (!name || typeof name !== 'string') throw new NotFoundException('Missing filename');

    const safe = path.basename(name);
    const filePath = path.resolve(vidsDir, safe);
    if (!filePath.startsWith(path.resolve(vidsDir))) {
      throw new NotFoundException('Invalid file');
    }
    if (!fs.existsSync(filePath)) throw new NotFoundException('File not found');

    // Use Express res.download to set Content-Disposition
    return res.download(filePath, safe, (err: any) => {
      if (err) {
        // If headers already sent, just end
        try { if (!res.headersSent) res.status(500).end(); } catch {}
      }
    });
  }
}
