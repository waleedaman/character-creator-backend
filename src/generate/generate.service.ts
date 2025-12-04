import { Injectable, Logger } from '@nestjs/common';
import { GenerateVideosConfig, GenerateVideosParameters, Video } from '@google/genai';
import { VideoGenerationReferenceType } from '@google/genai';
;

// We import the official GenAI client. The user must install @google/genai and
// provide an API key in the environment (see .env.example).
let GoogleGenAI: any;
try {
  // dynamic require so the project doesn't fail at compile time if package not installed
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  GoogleGenAI = require('@google/genai').GoogleGenAI;
} catch (e) {
  // will throw at runtime if used without installing the package
  GoogleGenAI = null;
}

@Injectable()
export class GenerateService {
  private readonly logger = new Logger(GenerateService.name);
  private client: any | null = null;

  constructor() {
    if (GoogleGenAI) {
      // The SDK expects an API key for the Gemini API (or Vertex AI settings).
      try {
        this.logger.debug('GOOGLE_API_KEY present: ' + Boolean(process.env.GOOGLE_API_KEY));
        // Force using the Gemini API via API key (avoid Vertex ADC flow) unless
        // the user specifically wants Vertex AI.
        this.client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY, vertexai: false });
      } catch (e) {
        this.logger.error('Failed to initialize GoogleGenAI client', e?.stack ?? e);
        this.client = null;
      }
    }
  }

  /**
   * Generate videos for the provided script chunks using Veo model.
   * Returns array of { time, url, details } for each generated clip.
   */
  async generateVideo(opts: {
    script: Array<{
      mood?: string; time: string; audio?: string; visuals?: string; characters?: Array<{ name: string; description?: string; image?: string }>
    }>;
    firstFrame?: string;
    characters?: Array<{ name: string; description?: string; image?: string }>;
    model?: string;
    outputName?: string; // optional requested output filename (basename)
    notifyUrl?: string; // optional webhook to POST when finished
  }): Promise<{ clips: Array<{ time: string; url: string; details?: any }>; combinedUrl?: string; filename?: string }> {
    if (!this.client) throw new Error('GenAI client not initialized');
    const model = opts.model ?? process.env.VIDEO_MODEL ?? 'veo-3.1-generate-preview';

    // Log overall start
    try {
      const meta = {
        model,
        chunks: Array.isArray(opts.script) ? opts.script.length : 0,
        times: Array.isArray(opts.script) ? opts.script.map((c) => c?.time).filter(Boolean) : [],
        hasFirstFrame: Boolean(opts.firstFrame),
        characters: Array.isArray(opts.characters) ? opts.characters.map((c) => c?.name).filter(Boolean) : [],
      };
      this.logger.log(`generateVideo start: ${JSON.stringify(meta)}`);
    } catch {}

  const results: Array<{ time: string; url: string; details?: any }> = [];
  const clipPaths: string[] = [];

    // Prepare optional first frame bytes if provided (data URL or base64)
    let firstFrameObj: any | undefined = undefined;
    const toImageBytes = (input?: string): { imageBytes: string; mimeType: string } | undefined => {
      if (!input || typeof input !== 'string') return undefined;
      let base64 = input;
      let mime = 'image/png';
      const match = base64.match(/^data:(.*?);base64,(.*)$/);
      if (match) {
        mime = match[1] || mime;
        base64 = match[2] || '';
      }
      if (!match) {
        // assume pure base64
        base64 = input;
      }
      if (base64) return { imageBytes: base64, mimeType: mime };
      return undefined;
    };
    firstFrameObj = toImageBytes(opts.firstFrame);

    // Ensure uploads/videos directory exists
    const fs = require('node:fs');
    const path = require('node:path');
    const vidsDir = process.env.UPLOAD_VIDEOS_DIR ?? 'uploads/videos';
    fs.mkdirSync(vidsDir, { recursive: true });

    // ffmpeg setup for last-frame extraction and concatenation
    const ffmpeg = require('fluent-ffmpeg');
    let ffmpegPath: string | null = null;
    try {
      // Prefer environment override if provided
      if (process.env.FFMPEG_PATH && process.env.FFMPEG_PATH.trim()) {
        ffmpegPath = process.env.FFMPEG_PATH.trim();
      } else {
        // Try bundled static binary
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const staticPath = require('ffmpeg-static');
        if (staticPath && typeof staticPath === 'string') ffmpegPath = staticPath;
      }
    } catch {}
    try {
      const fsTest = require('node:fs');
      const { spawnSync } = require('node:child_process');
      if (ffmpegPath && fsTest.existsSync(ffmpegPath)) {
        // Verify the binary actually runs
        const check = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8' });
        if (check.status === 0) {
          ffmpeg.setFfmpegPath(ffmpegPath);
          this.logger.debug(`[ffmpeg] Using binary at: ${ffmpegPath}`);
        } else {
          this.logger.warn(`[ffmpeg] Bundled ffmpeg failed to run, falling back to system ffmpeg. Output: ${check.stderr || check.stdout || 'n/a'}`);
          const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
          if (probe.status === 0) {
            ffmpeg.setFfmpegPath('ffmpeg');
            this.logger.debug('[ffmpeg] Using system ffmpeg from PATH');
          } else {
            this.logger.warn('[ffmpeg] No working ffmpeg binary found (ffmpeg-static unusable and no system ffmpeg). Last-frame extraction and concatenation will be skipped.');
          }
        }
      } else {
        // As a fallback, try system ffmpeg if available
        const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
        if (probe.status === 0) {
          ffmpeg.setFfmpegPath('ffmpeg');
          this.logger.debug('[ffmpeg] Using system ffmpeg from PATH');
        } else {
          this.logger.warn('[ffmpeg] No ffmpeg binary found (ffmpeg-static missing and no system ffmpeg). Last-frame extraction and concatenation will be skipped.');
        }
      }
    } catch (e) {
      this.logger.warn('[ffmpeg] Failed to configure ffmpeg: ' + (e?.message ?? String(e)));
    }

    const findCharImagesForChunk = (chunkChars?: Array<{ name: string }>) => {
      const refs: Array<{ imageBytes: string; mimeType: string }> = [];
      if (!Array.isArray(chunkChars) || !Array.isArray(opts.characters)) return refs;
      for (const ch of chunkChars) {
        const match = opts.characters.find((c) => c.name && ch.name && c.name.toLowerCase() === ch.name.toLowerCase());
        if (match && match.image) {
          const img = toImageBytes(match.image);
          if (img) refs.push(img);
        }
      }
      return refs;
    };

  const extractLastFrameBase64 = async (videoPath: string): Promise<string | undefined> => {
      const os = require('node:os');
      const tmpDir = os.tmpdir();
      const path = require('node:path');
      const fs = require('node:fs');
      const outPng = path.resolve(tmpDir, `lastframe_${Date.now()}_${Math.random().toString(36).slice(2,8)}.png`);

      const existsNonEmpty = (p: string) => {
        try { const st = fs.statSync(p); return st.isFile() && st.size > 0; } catch { return false; }
      };

      const ffprobeDuration = (): Promise<number | undefined> => new Promise((resolve) => {
        try {
          ffmpeg.ffprobe(videoPath, (err: any, data: any) => {
            if (err) {
              this.logger.debug(`[ffmpeg] ffprobe error: ${err?.message ?? err}`);
              return resolve(undefined);
            }
            const dur = Number(data?.format?.duration);
            resolve(Number.isFinite(dur) && dur > 0 ? dur : undefined);
          });
        } catch (e) {
          this.logger.debug(`[ffmpeg] ffprobe threw: ${e?.message ?? e}`);
          resolve(undefined);
        }
      });

      const tryRemux = (): Promise<string | undefined> => {
        const remuxPath = path.resolve(tmpDir, `remux_${Date.now()}_${Math.random().toString(36).slice(2,8)}.mp4`);
        return new Promise((resolve) => {
          try {
            ffmpeg(videoPath)
              .outputOptions(['-y'])
              .videoCodec('copy')
              .audioCodec('copy')
              .output(remuxPath)
              .on('end', () => resolve(remuxPath))
              .on('error', () => resolve(undefined))
              .run();
          } catch {
            resolve(undefined);
          }
        });
      };

      const tryReencode = (): Promise<string | undefined> => {
        const recPath = path.resolve(tmpDir, `recode_${Date.now()}_${Math.random().toString(36).slice(2,8)}.mp4`);
        return new Promise((resolve) => {
          try {
            ffmpeg(videoPath)
              .outputOptions([
                '-y',
                '-c:v','libx264','-preset','veryfast','-crf','23',
                '-pix_fmt','yuv420p',
                '-c:a','aac','-b:a','128k',
              ])
              .output(recPath)
              .on('end', () => resolve(recPath))
              .on('error', () => resolve(undefined))
              .run();
          } catch {
            resolve(undefined);
          }
        });
      };

      const extractViaSseof = (inputPath: string): Promise<boolean> => new Promise((resolve) => {
        try {
          this.logger.debug(`[ffmpeg] sseof extract: input=${inputPath}`);
          if (!existsNonEmpty(inputPath)) {
            this.logger.debug('[ffmpeg] sseof extract: input missing or empty');
            return resolve(false);
          }
          ffmpeg(inputPath)
            .inputOptions(['-sseof', '-0.1'])
            .outputOptions(['-y', '-frames:v', '1'])
            .output(outPng)
            .on('start', (cmd: string) => this.logger.debug(`[ffmpeg] extract last-frame cmd: ${cmd}`))
            .on('end', () => resolve(existsNonEmpty(outPng)))
            .on('error', (err: any) => {
              this.logger.debug(`[ffmpeg] last-frame extraction error (sseof): ${err?.message ?? err}`);
              resolve(false);
            })
            .run();
        } catch (e) {
          this.logger.debug(`[ffmpeg] failed to start extraction (sseof): ${e?.message ?? e}`);
          resolve(false);
        }
      });

      const extractAtTime = (inputPath: string, tSec: number): Promise<boolean> => new Promise((resolve) => {
        const t = Math.max(0, tSec);
        try {
          this.logger.debug(`[ffmpeg] at-time extract: input=${inputPath} t=${t.toFixed(2)}s`);
          if (!existsNonEmpty(inputPath)) {
            this.logger.debug('[ffmpeg] at-time extract: input missing or empty');
            return resolve(false);
          }
          ffmpeg(inputPath)
            .seekInput(t)
            .outputOptions(['-y', '-frames:v', '1'])
            .output(outPng)
            .on('start', (cmd: string) => this.logger.debug(`[ffmpeg] extract last-frame at ${t.toFixed(2)}s cmd: ${cmd}`))
            .on('end', () => resolve(existsNonEmpty(outPng)))
            .on('error', (err: any) => {
              this.logger.debug(`[ffmpeg] last-frame extraction error (at-time ${t.toFixed(2)}): ${err?.message ?? err}`);
              resolve(false);
            })
            .run();
        } catch (e) {
          this.logger.debug(`[ffmpeg] failed to start extraction (at-time): ${e?.message ?? e}`);
          resolve(false);
        }
      });

      const p: Promise<string | undefined> = new Promise(async (resolve) => {
        try {
          this.logger.debug(`[ffmpeg] begin last-frame pipeline: path=${videoPath}`);
          // Attempt 1: sseof on original
          let ok = await extractViaSseof(videoPath);
          if (!ok) {
            // Attempt 2: precise time near end using ffprobe
            const dur = await ffprobeDuration();
            if (dur && dur > 0.2) {
              const t = Math.max(0, dur - 0.08);
              ok = await extractAtTime(videoPath, t);
              if (!ok) {
                ok = await extractAtTime(videoPath, Math.max(0, dur - 0.5));
              }
            }
          }
          if (!ok) {
            // Attempt 3: remux then sseof, then at-time
            const remuxed = await tryRemux();
            if (remuxed) {
              ok = await extractViaSseof(remuxed);
              if (!ok) {
                const dur = await ffprobeDuration();
                if (dur && dur > 0.2) {
                  ok = await extractAtTime(remuxed, Math.max(0, dur - 0.08));
                }
              }
            }
          }
          if (!ok) {
            // Attempt 4: re-encode to a clean MP4, then sseof/at-time
            const rec = await tryReencode();
            if (rec) {
              ok = await extractViaSseof(rec);
              if (!ok) {
                const dur = await ffprobeDuration();
                if (dur && dur > 0.2) ok = await extractAtTime(rec, Math.max(0, dur - 0.08));
              }
            }
          }

          if (ok && existsNonEmpty(outPng)) {
            try {
              const b = fs.readFileSync(outPng);
              const b64 = b.toString('base64');
              fs.unlink(outPng, () => {});
              resolve(`data:image/png;base64,${b64}`);
              return;
            } catch (e) {
              this.logger.debug(`[ffmpeg] could not read extracted frame: ${e?.message ?? e}`);
            }
          }
          this.logger.debug('[ffmpeg] last-frame extraction failed after all attempts');
          resolve(undefined);
        } catch (e) {
          this.logger.debug(`[ffmpeg] unexpected error in extraction pipeline: ${e?.message ?? e}`);
          resolve(undefined);
        }
      });
      return p;
    };

    for (const chunk of opts.script) {
      this.logger.log(`Chunk start: time=${chunk.time ?? ''}`);
      const time = chunk.time ?? '';
      // Build prompt similar to n8n snippet
      let prompt = `
      Generate a short animated video clip for the following scene, which is part of a continuous animated short. Maintain the same cel-shaded art style, character appearances, and sunset beach lighting across all clips. The clip covers ${time} of the full sequence.

      Duration: ~8 seconds. Match pacing and camera motion naturally.

      Audio: ${chunk.audio ?? 'Use natural ambient beach sounds and character dialogue as indicated.'}
      Visuals: ${chunk.visuals ?? ''}

      Characters:
      ${chunk.characters?.map(c => `Name: ${c.name}. Description: ${c.description ?? ''}`).join('\n')}

      Use provided character reference images to preserve appearance and proportions.
      Keep both characters visible, expressive, and unobstructed throughout.
      Do not introduce new characters or settings.
      Keep mood ${chunk.mood ?? 'uplifting and cinematic'}.
      Synchronize lip movements and gestures with audio.
      Ensure transitions align seamlessly with neighboring clips.`;
      // Call generateVideos
      let requestPayload: GenerateVideosParameters = { model, prompt };
      // Pass first frame in the structured shape if present
      

      // Build config with referenceImages if available
      // Per request: disable last-frame chaining; seed each clip from character images.
      const charRefs = findCharImagesForChunk(
        Array.isArray(chunk.characters) && chunk.characters.length > 0 ? chunk.characters : (opts.characters as any)
      );
      Logger.debug(charRefs.length, 'Character reference images found for chunk');
      if (charRefs.length > 0) {
        requestPayload.image = {
          imageBytes: charRefs[0].imageBytes,
          mimeType: charRefs[0].mimeType ?? 'image/png',
        } as any;
      }
      // Do NOT send config.referenceImages (unsupported for preview; caused INVALID_ARGUMENT previously)
      this.logger.debug(
        `Calling models.generateVideos for time=${time} (seedImage=${Boolean(requestPayload.image)})`,
      );
      this.logger.debug({ model, promptSummary: prompt?.slice(0, 140) + '...', hasSeed: Boolean(requestPayload.image) })
      let operation = await this.client.models.generateVideos(requestPayload);

      // Poll until done
      const maxPollMs = Number(process.env.VIDEO_MAX_POLL_MS ?? 5 * 60_000); // 5 min default
      const pollIntervalMs = Number(process.env.VIDEO_POLL_INTERVAL_MS ?? 3000);
      const start = Date.now();
      this.logger.debug(`Polling operation for time=${time}`);
      while (!operation?.done) {
        if (Date.now() - start > maxPollMs) {
          throw new Error(`Video generation timed out for chunk ${time}`);
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        if (this.client.operations && typeof this.client.operations.getVideosOperation === 'function') {
          operation = await this.client.operations.getVideosOperation({ operation });
        } else if (this.client.operations && typeof this.client.operations.get === 'function') {
          operation = await this.client.operations.get({ operation });
        } else {
          // If no polling method, break to avoid infinite loop
          break;
        }
      }

      // Extract video and download to disk if possible
      const videoRef = operation?.response?.generatedVideos?.[0]?.video;
      let outUrl = '';
      let outPath: string | undefined = undefined;
      if (videoRef) {
        try {
          if (this.client.files && typeof this.client.files.download === 'function') {
            const safeName = String(time).replace(/[^a-zA-Z0-9_-]+/g, '_');
            outPath = path.resolve(vidsDir, `${safeName}.mp4`);
            await this.client.files.download({ file: videoRef, downloadPath: outPath });
            // Wait briefly for FS to settle and sniff header; if invalid, fallback to inline bytes if available
            try {
              const fs = require('node:fs');
              const snooze = (ms: number) => new Promise((r) => setTimeout(r, ms));
              let lastSize = -1;
              for (let i = 0; i < 3; i++) {
                try {
                  const st = fs.statSync(outPath);
                  if (st.size > 0 && st.size === lastSize) break;
                  lastSize = st.size;
                } catch {}
                await snooze(150);
              }
              // Sniff for MP4/WebM magic
              const buf = fs.readFileSync(outPath);
              let looksValid = false;
              if (buf && buf.length > 1024) {
                if (buf.slice(4, 8).toString('ascii') === 'ftyp') looksValid = true;
                const m = buf.slice(0, 4);
                if (!looksValid && m[0] === 0x1a && m[1] === 0x45 && m[2] === 0xdf && m[3] === 0xa3) looksValid = true; // EBML
              }
              if (!looksValid && (videoRef?.videoBytes || videoRef?.bytesBase64Encoded)) {
                try {
                  const b64 = videoRef.videoBytes ?? videoRef.bytesBase64Encoded;
                  const b = Buffer.from(b64, 'base64');
                  fs.writeFileSync(outPath, b);
                  this.logger.debug('Downloaded file looked invalid; wrote inline video bytes instead.');
                } catch (wErr) {
                  this.logger.warn('Inline video bytes fallback failed: ' + (wErr?.message ?? String(wErr)));
                }
              }
            } catch {}
            const publicPrefix = process.env.UPLOAD_PUBLIC_PREFIX ?? '/uploads';
            // We plan to serve /uploads from uploads/ root; map relative path
            outUrl = `${publicPrefix}/videos/${path.basename(outPath)}`;
            this.logger.log(`Chunk done: time=${time}, saved=${outPath}`);
          } else if (videoRef?.videoBytes) {
            // Fallback: write base64 bytes if SDK provides bytes directly
            const b64 = videoRef.videoBytes;
            const buf = Buffer.from(b64, 'base64');
            const safeName = String(time).replace(/[^a-zA-Z0-9_-]+/g, '_');
            outPath = path.resolve(vidsDir, `${safeName}.mp4`);
            fs.writeFileSync(outPath, buf);
            const publicPrefix = process.env.UPLOAD_PUBLIC_PREFIX ?? '/uploads';
            outUrl = `${publicPrefix}/videos/${path.basename(outPath)}`;
            this.logger.log(`Chunk done (bytes): time=${time}, saved=${outPath}`);
          }
        } catch (e) {
          this.logger.error('Failed to download video file: ' + (e?.message ?? String(e)));
        }
      }

      results.push({ time, url: outUrl, details: { operation: operation?.name ?? null } });
      if (outPath) clipPaths.push(outPath);

      // Chain last frame to next iteration is disabled per request.
      // if (outPath) {
      //   try {
      //     const delayMs = Number(process.env.VIDEO_POST_DOWNLOAD_DELAY_MS ?? 20000);
      //     this.logger.debug(`[ffmpeg] waiting ${delayMs}ms before last-frame extraction for ${time}`);
      //     await new Promise((r) => setTimeout(r, delayMs));
      //     const lastFrame = await extractLastFrameBase64(outPath);
      //     const img = toImageBytes(lastFrame);
      //     if (img) firstFrameObj = img; // use as the next clip's starting image
      //     this.logger.log(`Extracted last frame for next clip: ${firstFrameObj ? 'yes' : 'no'}`);
      //   } catch {}
      // }
    }

    // After all clips, attempt concatenation if 2+ clips exist
    let combinedUrl: string | undefined;
    let finalFilename: string | undefined;
    try {
      if (clipPaths.length >= 2) {
        const os = require('node:os');
        const tmp = os.tmpdir();
        const listPath = path.resolve(tmp, `concat_${Date.now()}_${Math.random().toString(36).slice(2,8)}.txt`);
        const listContent = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(listPath, listContent);

        const firstTime = (opts.script[0]?.time ?? '0').replace(/[^a-zA-Z0-9_-]+/g, '_');
        const lastTime = (opts.script[opts.script.length - 1]?.time ?? 'end').replace(/[^a-zA-Z0-9_-]+/g, '_');
  // Use provided outputName if available, otherwise generate one
  const requested = typeof opts.outputName === 'string' && opts.outputName.trim() ? path.basename(opts.outputName.trim()) : undefined;
  const combinedName = requested ?? `combined_${firstTime}_to_${lastTime}_${Date.now()}.mp4`;
  const combinedPath = path.resolve(vidsDir, combinedName);

        const runConcat = () =>
          new Promise<void>((resolve, reject) => {
            try {
              ffmpeg()
                .input(listPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .outputOptions(['-c', 'copy'])
                .output(combinedPath)
                .on('end', () => resolve())
                .on('error', (err: any) => reject(err))
                .run();
            } catch (e) {
              reject(e);
            }
          });

        try {
          await runConcat();
        } catch (copyErr) {
          this.logger.warn(`Concat copy failed, attempting re-encode: ${copyErr?.message ?? copyErr}`);
          await new Promise<void>((resolve, reject) => {
            try {
              ffmpeg()
                .input(listPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .outputOptions([
                  '-c:v', 'libx264',
                  '-preset', 'veryfast',
                  '-crf', '23',
                  '-c:a', 'aac',
                  '-b:a', '192k',
                ])
                .output(combinedPath)
                .on('end', () => resolve())
                .on('error', (err: any) => reject(err))
                .run();
            } catch (e) {
              reject(e);
            }
          });
        }

        const publicPrefix = process.env.UPLOAD_PUBLIC_PREFIX ?? '/uploads';
        combinedUrl = `${publicPrefix}/videos/${require('node:path').basename(combinedPath)}`;
        finalFilename = path.basename(combinedPath);
        this.logger.log(`Combined video saved: ${combinedPath}`);
        try { fs.unlinkSync(listPath); } catch {}
      }
    } catch (e) {
      this.logger.error('Failed to concatenate clips: ' + (e?.message ?? String(e)));
    }

    // If we only have one clip and no combined file was produced, use that clip as the final file
    try {
      if ((!combinedUrl || !finalFilename) && clipPaths.length === 1) {
        const single = clipPaths[0];
        const requested = typeof opts.outputName === 'string' && opts.outputName.trim() ? path.basename(opts.outputName.trim()) : undefined;
        if (requested) {
          const dest = path.resolve(vidsDir, requested);
          try {
            fs.copyFileSync(single, dest);
            finalFilename = path.basename(dest);
            const publicPrefix = process.env.UPLOAD_PUBLIC_PREFIX ?? '/uploads';
            combinedUrl = `${publicPrefix}/videos/${finalFilename}`;
            this.logger.log(`Renamed single clip to requested output: ${dest}`);
          } catch (e) {
            this.logger.debug('Failed to copy single clip to requested outputName: ' + (e?.message ?? e));
            finalFilename = path.basename(single);
            const publicPrefix = process.env.UPLOAD_PUBLIC_PREFIX ?? '/uploads';
            combinedUrl = `${publicPrefix}/videos/${finalFilename}`;
          }
        } else {
          finalFilename = path.basename(single);
          const publicPrefix = process.env.UPLOAD_PUBLIC_PREFIX ?? '/uploads';
          combinedUrl = `${publicPrefix}/videos/${finalFilename}`;
        }
      }
    } catch (e) {
      this.logger.debug('Post-processing single clip failed: ' + (e?.message ?? e));
    }

    // If notifyUrl provided, POST a small JSON notifying that the video is ready
    if (opts.notifyUrl && finalFilename && combinedUrl) {
      try {
        const url = require('node:url');
        const http = require('node:http');
        const https = require('node:https');
        const parsed = url.parse(opts.notifyUrl);
        const payload = JSON.stringify({ filename: finalFilename, url: combinedUrl });
        const client = parsed.protocol === 'https:' ? https : http;
        const reqOpts: any = {
          method: 'POST',
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.path,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          timeout: 5000,
        };
        const r = client.request(reqOpts, (res2: any) => {
          this.logger.debug(`notifyUrl responded: ${res2.statusCode}`);
        });
        r.on('error', (err: any) => this.logger.debug('notifyUrl error: ' + (err?.message ?? err)));
        r.write(payload);
        r.end();
      } catch (e) {
        this.logger.debug('Failed to POST notifyUrl: ' + (e?.message ?? e));
      }
    }

    return { clips: results, combinedUrl, filename: finalFilename };
  }
  async generateDescription(prompt: string): Promise<string> {
    if (!this.client) {
      this.logger.warn('@google/genai client not available.');
      throw new Error(
        'GenAI client not installed or failed to initialize. Please run: npm install @google/genai and set up credentials',
      );
    }

    const model = process.env.GENAI_MODEL ?? 'gemini-3.5-turbo';

    try {
      // Build structured contents: role + parts. This is the most-compatible
      // shape for the SDK and ensures the model sees the prompt as user text.
      const contents = [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ];

      const response = await this.client.models.generateContent({
        model,
        contents,
        config: {
          temperature: 0.8,
        },
      });

      // Prefer convenience getter
      if (response?.text) return response.text;

      // Otherwise try to extract text from candidates -> content -> parts
      const candidate = response?.candidates && response.candidates[0];
      const parts = candidate?.content?.parts ?? [];
      if (Array.isArray(parts) && parts.length > 0) {
        const text = parts.map((p: any) => p.text ?? '').join('');
        if (text) return text;
      }

      // If we reach here, the model returned no text parts. Log the full
      // response to help debugging (safety filters, empty output, etc.).
      this.logger.warn('GenAI response had no text parts; full response follows:');
      this.logger.debug(JSON.stringify(response));

      throw new Error(
        'Model returned no text. Try a simpler prompt, switch model (e.g. gemini-3.5-turbo), or increase maxOutputTokens. See server logs for full response.',
      );
    } catch (err: any) {
      this.logger.error('GenAI request failed', err?.stack ?? err);
      // If SDK threw an ApiError with structured json, surface that stringified
      // message to the caller for easier debugging.
      if (err && typeof err === 'object' && 'message' in err) {
        throw new Error('Failed to generate text: ' + (err.message ?? String(err)));
      }
      throw new Error('Failed to generate text: ' + String(err));
    }
  }

  /**
   * Generate a structured video script JSON with 8s chunks for VEO 3.1.
   * Input: optional up to three characters (name,description) and a prompt.
   * Output: JSON array of chunks: [{"time":"0-8seconds","audio":"","visuals":"","characters": [{name, description}] }]
   * Rules: max 3 characters total, use provided ones if present, only create new if none provided.
   */
  async generateScript(prompt: string, characters?: Array<{ name: string; description?: string }>): Promise<any> {
    if (!this.client) {
      throw new Error('GenAI client not initialized');
    }

    const model = process.env.GENAI_MODEL ?? 'gemini-3.5-turbo';

    // Build a system-style instruction to enforce JSON structure and constraints
    const constraints = `You are a video script generator for VEO 3.1.
Return ONLY valid JSON: an array of objects. No extra commentary.
Each object represents an ~8 second clip with fields:
  - time: a range like "0-8seconds", "8-16seconds", ...
  - audio: narration/dialogue text (do not use double quotes characters in this field)
  - visuals: description of visuals (no double quotes inside the text)(Make the visuals detailed and specific to the audio)
  - characters: array with up to 3 character objects {name, description}. Include detailed per-clip character descriptions.
Hard constraints:
  - Chunk length is 8 seconds each.
  - Use at most three characters total across the script.
  - If input characters are provided, use ONLY those names and their descriptions, do not invent new names. If none provided, invent up to three and consistently reuse the same names across all chunks.
  - CRITICAL: In each clip, the characters array MUST include every character that appears in that clip's audio or visuals text. Names must match exactly (case-insensitive) the provided names (when provided).
  - Do not add characters to the characters array that are not present in that clip's audio or visuals.
  - Do not include raw double quote characters in audio/visuals text; prefer single quotes or omit quotes inside sentences so the JSON remains valid.
  - Output must be a single JSON array, parseable.`;

    const providedChars = Array.isArray(characters) && characters.length > 0
      ? characters.slice(0, 3)
      : [];

  const userPrompt = `Task: Generate a video script in 8-second chunks for the following scenario.
Main prompt: ${prompt}
${providedChars.length > 0 ? `Provided characters (use these names and descriptions only): ${providedChars.map(c=>`${c.name}${c.description?` - ${c.description}`:''}`).join('; ')}` : 'No characters provided: create up to three and consistently reuse them across all chunks.'}
Format exactly as: [{"time":"0-8seconds","audio":"","visuals":"","characters": [{"name":"","description":""}]}]
Return only the JSON array. Ensure all constraints are met. Ensure the JSON is parseable. Ensure that the generated script meets the length requirements. Keep the following prompt writing basics in mind: Prompt writing basics\
Good prompts are descriptive and clear. To get the most out of Veo, start with identifying your core idea, refine your idea by adding keywords and modifiers, and incorporate video-specific terminology into your prompts.\
\
The following elements should be included in your prompt:\
\
Subject: The object, person, animal, or scenery that you want in your video, such as cityscape, nature, vehicles, or puppies.\
Action: What the subject is doing (for example, walking, running, or turning their head).\
Style: Specify creative direction using specific film style keywords, such as sci-fi, horror film, film noir, or animated styles like cartoon.\
Camera positioning and motion: [Optional] Control the camera\'s location and movement using terms like aerial view, eye-level, top-down shot, dolly shot, or worms eye.\
Composition: [Optional] How the shot is framed, such as wide shot, close-up, single-shot or two-shot.\
Focus and lens effects: [Optional] Use terms like shallow focus, deep focus, soft focus, macro lens, and wide-angle lens to achieve specific visual effects.\
Ambiance: [Optional] How the color and light contribute to the scene, such as blue tones, night, or warm tones.\
More tips for writing prompts\
Use descriptive language: Use adjectives and adverbs to paint a clear picture for Veo.\
Enhance the facial details: Specify facial details as a focus of the photo like using the word portrait in the prompt.\
For more comprehensive prompting strategies, visit Introduction to prompt design.\
\
Prompting for audio\
With Veo 3, you can provide cues for sound effects, ambient noise, and dialogue. The model captures the nuance of these cues to generate a synchronized soundtrack.\
\
Dialogue: Use quotes for specific speech. (Example: "This must be the key," he murmured.)\
Sound Effects (SFX): Explicitly describe sounds. (Example: tires screeching loudly, engine roaring.)\
Ambient Noise: Describe the environment\'s soundscape. (Example: A faint, eerie hum resonates in the background.)`;
Logger.debug('generateScript prompt: ' + userPrompt);
    const contents = [
      { role: 'user', parts: [{ text: constraints }] },
      { role: 'user', parts: [{ text: userPrompt }] },
    ];

    const response = await this.client.models.generateContent({
      model,
      contents,
      config: {
        temperature: 0.7,
        responseMimeType: 'application/json',
      },
    });

    console.log('generateScript response:', response.text);

    const text = response?.text ?? '';
    if (!text) {
      throw new Error('Model did not return script text');
    }

    // Try to parse JSON; if it fails, attempt a minimal cleanup.
    const normalizeScript = (arr: any[]) => {
      // Enforce constraints post-parse: cap characters to provided list (if any), ensure <= 3
      if (!Array.isArray(arr)) return arr;

      const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameMatches = (text: string, name: string) => {
        try {
          const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i');
          return re.test(text);
        } catch { return false; }
      };

      for (const clip of arr) {
        if (!clip || typeof clip !== 'object') continue;
        // Characters enforcement
        if (Array.isArray(clip.characters)) {
          if (providedChars.length > 0) {
            clip.characters = clip.characters.filter((ch: any) => providedChars.some(pc => pc.name === ch.name));
            for (const ch of clip.characters) {
              const match = providedChars.find(pc => pc.name === ch.name);
              if (match && !ch.description && match.description) ch.description = match.description;
            }
          } else if (clip.characters.length > 3) {
            clip.characters = clip.characters.slice(0, 3);
          }
        }

        // Ensure every mentioned provided character in audio/visuals is included in characters for that clip
        if (providedChars.length > 0) {
          const text = `${clip.audio ?? ''} ${clip.visuals ?? ''}`;
          const mentioned = providedChars.filter(pc => pc.name && nameMatches(text, pc.name));
          clip.characters = Array.isArray(clip.characters) ? clip.characters : [];
          for (const pc of mentioned) {
            if (!clip.characters.some((ch: any) => (ch?.name ?? '').toLowerCase() === pc.name.toLowerCase())) {
              clip.characters.push({ name: pc.name, description: pc.description ?? '' });
            }
          }
          // If more than 3 (edge case), prefer to keep only those actually mentioned in this clip (and truncate if still >3)
          if (clip.characters.length > 3) {
            const keepNames = new Set(mentioned.map(m => m.name.toLowerCase()));
            const filtered = clip.characters.filter((ch: any) => keepNames.has((ch?.name ?? '').toLowerCase()));
            clip.characters = filtered.length > 0 ? filtered : clip.characters;
            if (clip.characters.length > 3) clip.characters = clip.characters.slice(0, 3);
          }
        }
      }
      return arr;
    };

    try {
      const parsed = JSON.parse(text);
      return normalizeScript(parsed);
    } catch (e) {
      // Attempt bracket slicing for a full array
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start !== -1 && end !== -1 && end > start) {
        const slice = text.slice(start, end + 1);
        try {
          return normalizeScript(JSON.parse(slice));
        } catch {
          // continue to object-by-object recovery
        }
      }

      // Object-by-object recovery: extract objects within the outer array, sanitize audio/visuals quotes
      const recoverObjects = (): any[] => {
        const arrStart = text.indexOf('[');
        const body = arrStart !== -1 ? text.slice(arrStart + 1) : text;
        const items: any[] = [];
        let depth = 0;
        let objStart = -1;
        for (let i = 0; i < body.length; i++) {
          const ch = body[i];
          if (ch === '{') {
            if (depth === 0) objStart = i;
            depth++;
          } else if (ch === '}') {
            depth--;
            if (depth === 0 && objStart !== -1) {
              const objStr = body.slice(objStart, i + 1);
              const cleaned = sanitizeObjectJson(objStr);
              try {
                const parsedObj = JSON.parse(cleaned);
                items.push(parsedObj);
              } catch {}
              objStart = -1;
            }
          }
        }
        return items;
      };

      function sanitizeObjectJson(objStr: string): string {
        let s = objStr;
        // Remove trailing commas before closing } or ]
        s = s.replace(/,\s*([}\]])/g, '$1');
        // Sanitize audio and visuals fields by replacing unescaped double-quotes inside the value with single quotes
        const fixField = (field: string) => {
          const re = new RegExp(`("${field}"\\s*:\\s*")([\\s\\S]*?)(")`, 'g');
          s = s.replace(re, (_m, p1, content, p3) => {
            // Replace any unescaped " with '
            const fixed = content.replace(/(?<!\\)\"/g, '"').replace(/(?<!\\)"/g, "'");
            return `${p1}${fixed}${p3}`;
          });
        };
        fixField('audio');
        fixField('visuals');
        return s;
      }

      const recovered = recoverObjects();
      if (recovered.length > 0) {
        return normalizeScript(recovered);
      }

      this.logger.error('Failed to parse script JSON. Raw text: ' + text);
      throw new Error('Model returned malformed JSON for script.');
    }
  }

  /**
   * Generate an image from a prompt using the specified image model.
   * Returns a data URL like 'data:image/png;base64,...'
   */
  async generateImage(prompt: string): Promise<string> {
    if (process.env.MOCK_AI === 'true') {
      this.logger.warn('MOCK_AI is enabled — returning mock image');
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512'><rect width='100%' height='100%' fill='%23eef'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='%23444' font-size='20'>Mock image for: ${prompt}</text></svg>`;
      const b64 = Buffer.from(svg).toString('base64');
      return `data:image/svg+xml;base64,${b64}`;
    }

    if (!this.client) {
      this.logger.warn('@google/genai client not available for image generation.');
      throw new Error('GenAI client not installed or failed to initialize.');
    }

    const model = process.env.IMAGE_MODEL ?? 'imagen-4.0-generate-001';

    try {
      // If the SDK provides a dedicated generateImages method (as in your
      // snippet), prefer that. It typically accepts { model, prompt }.
      if (this.client && this.client.models && typeof this.client.models.generateImages === 'function') {
        this.logger.debug('Using client.models.generateImages for image generation');
        const imagenResponse = await this.client.models.generateImages({ model, prompt, config: {
      numberOfImages: 1,
    }, });

        // Newer SDK variants (and the user's snippet) return an array called
        // `generatedImages` with objects like { image: { imageBytes: 'BASE64' } }
        if (Array.isArray(imagenResponse?.generatedImages) && imagenResponse.generatedImages.length > 0) {
          // Prefer the first image
          const first = imagenResponse.generatedImages[0];
          // Common shapes observed in SDKs: image.imageBytes, image.bytesBase64, or inlineData.data
          const maybeImg = first?.image ?? first;
          const imgB64 = maybeImg?.imageBytes ?? maybeImg?.bytesBase64 ?? maybeImg?.image?.imageBytes ?? maybeImg?.image?.bytesBase64;
          if (typeof imgB64 === 'string' && imgB64.length > 0) {
            const mime = maybeImg?.mimeType ?? 'image/png';
            return `data:${mime};base64,${imgB64}`;
          }
        }

        // Older/alternate SDK convenience getters
        if (imagenResponse?.data) {
          const mime = 'image/png';
          return `data:${mime};base64,${imagenResponse.data}`;
        }

        const candidate = imagenResponse?.candidates && imagenResponse.candidates[0];
        const parts = candidate?.content?.parts ?? [];
        for (const p of parts) {
          if (p?.inlineData?.data) {
            const mime = p.inlineData.mimeType ?? 'image/png';
            const b64 = p.inlineData.data;
            return `data:${mime};base64,${b64}`;
          }
        }

        this.logger.warn('generateImages returned no recognizable image data; full response:');
        this.logger.debug(JSON.stringify(imagenResponse));

        // Try to surface common reasons: safety filtering, empty finish reason, or model issues
        try {
          const reasons: string[] = [];
          if (imagenResponse?.finishReason) reasons.push(`finishReason=${imagenResponse.finishReason}`);
          if (imagenResponse?.safetyAttributes) reasons.push(`safety=${JSON.stringify(imagenResponse.safetyAttributes)}`);
          if (imagenResponse?.raiMediaFilteredReasons) reasons.push(`raiMediaFiltered=${JSON.stringify(imagenResponse.raiMediaFilteredReasons)}`);
          if (imagenResponse?.candidates && imagenResponse.candidates.length > 0) {
            reasons.push('candidates_present_but_no_generatedImages');
          }

          // If SDK exposes a model listing method, call it to help debug model availability
          try {
            if (typeof this.client.models.list === 'function') {
              const lm = await this.client.models.list();
              this.logger.debug('Model list (from client.models.list): ' + JSON.stringify(lm));
            } else if (typeof this.client.listModels === 'function') {
              const lm = await this.client.listModels();
              this.logger.debug('Model list (from client.listModels): ' + JSON.stringify(lm));
            }
          } catch (listErr) {
            this.logger.debug('Could not list models: ' + String(listErr));
          }

          const hint = reasons.length > 0 ? reasons.join('; ') : 'no specific hints';
          throw new Error(`Image model returned no image data. Hints: ${hint}. See server logs for full response.`);
        } catch (diagErr) {
          // rethrow the diagnostic error
          throw diagErr;
        }
      }

      // Fallback: use the generic generateContent route and extract inline data
      this.logger.debug('Falling back to models.generateContent for image generation');
      const contents = [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ];

      const response = await this.client.models.generateContent({ model, contents });
      if (response?.data) {
        const mime = 'image/png';
        return `data:${mime};base64,${response.data}`;
      }
      const candidate = response?.candidates && response.candidates[0];
      const parts = candidate?.content?.parts ?? [];
      for (const p of parts) {
        if (p?.inlineData?.data) {
          const mime = p.inlineData.mimeType ?? 'image/png';
          const b64 = p.inlineData.data;
          return `data:${mime};base64,${b64}`;
        }
      }

      this.logger.warn('Image fallback returned no inlineData; full response:');
      this.logger.debug(JSON.stringify(response));
      throw new Error('Model returned no image data. See server logs.');
    } catch (err: any) {
      this.logger.error('GenAI image request failed', err?.stack ?? err);
      throw new Error('Failed to generate image: ' + (err?.message ?? String(err)));
    }
  }

  /**
   * Debug helper: extract the last frame from a given video file path.
   * Returns a data URL (image/png) or undefined.
   */
  async debugExtractLastFrame(videoPath: string): Promise<string | undefined> {
    try {
      if (!videoPath || typeof videoPath !== 'string') return undefined;
      const fs = require('node:fs');
      const path = require('node:path');
      const exists = (() => {
        try { const st = fs.statSync(videoPath); return st.isFile() && st.size > 0; } catch { return false; }
      })();
      if (!exists) {
        this.logger.debug(`[debugExtract] input missing or empty: ${videoPath}`);
        return undefined;
      }

      // Configure ffmpeg locally (env -> static -> system)
      const ffmpeg = require('fluent-ffmpeg');
      try {
        let ffmpegPath: string | null = null;
        if (process.env.FFMPEG_PATH && process.env.FFMPEG_PATH.trim()) {
          ffmpegPath = process.env.FFMPEG_PATH.trim();
        } else {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const staticPath = require('ffmpeg-static');
            if (staticPath && typeof staticPath === 'string') ffmpegPath = staticPath;
          } catch {}
        }
        const { spawnSync } = require('node:child_process');
        if (ffmpegPath && fs.existsSync(ffmpegPath)) {
          const check = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8' });
          if (check.status === 0) ffmpeg.setFfmpegPath(ffmpegPath);
          else {
            const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
            if (probe.status === 0) ffmpeg.setFfmpegPath('ffmpeg');
          }
        } else {
          const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
          if (probe.status === 0) ffmpeg.setFfmpegPath('ffmpeg');
        }
      } catch {}

      const os = require('node:os');
      const tmpDir = os.tmpdir();
      const outPng = path.resolve(tmpDir, `lastframe_${Date.now()}_${Math.random().toString(36).slice(2,8)}.png`);
      const existsNonEmpty = (p: string) => { try { const st = fs.statSync(p); return st.isFile() && st.size > 0; } catch { return false; } };
      const ffprobeDuration = (): Promise<number | undefined> => new Promise((resolve) => {
        try {
          ffmpeg.ffprobe(videoPath, (err: any, data: any) => {
            if (err) return resolve(undefined);
            const d = Number(data?.format?.duration);
            resolve(Number.isFinite(d) && d > 0 ? d : undefined);
          });
        } catch { resolve(undefined); }
      });
      const extractViaSseof = (inputPath: string): Promise<boolean> => new Promise((resolve) => {
        try {
          if (!existsNonEmpty(inputPath)) return resolve(false);
          ffmpeg(inputPath)
            .inputOptions(['-sseof', '-0.1'])
            .outputOptions(['-y', '-frames:v', '1'])
            .output(outPng)
            .on('end', () => resolve(existsNonEmpty(outPng)))
            .on('error', () => resolve(false))
            .run();
        } catch { resolve(false); }
      });
      const extractAtTime = (inputPath: string, tSec: number): Promise<boolean> => new Promise((resolve) => {
        const t = Math.max(0, tSec);
        try {
          if (!existsNonEmpty(inputPath)) return resolve(false);
          ffmpeg(inputPath)
            .seekInput(t)
            .outputOptions(['-y', '-frames:v', '1'])
            .output(outPng)
            .on('end', () => resolve(existsNonEmpty(outPng)))
            .on('error', () => resolve(false))
            .run();
        } catch { resolve(false); }
      });
      const tryRemux = (): Promise<string | undefined> => new Promise((resolve) => {
        const remuxPath = path.resolve(tmpDir, `remux_${Date.now()}_${Math.random().toString(36).slice(2,8)}.mp4`);
        try {
          ffmpeg(videoPath)
            .outputOptions(['-y'])
            .videoCodec('copy')
            .audioCodec('copy')
            .output(remuxPath)
            .on('end', () => resolve(remuxPath))
            .on('error', () => resolve(undefined))
            .run();
        } catch { resolve(undefined); }
      });
      const tryReencode = (): Promise<string | undefined> => new Promise((resolve) => {
        const recPath = path.resolve(tmpDir, `recode_${Date.now()}_${Math.random().toString(36).slice(2,8)}.mp4`);
        try {
          ffmpeg(videoPath)
            .outputOptions(['-y', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k'])
            .output(recPath)
            .on('end', () => resolve(recPath))
            .on('error', () => resolve(undefined))
            .run();
        } catch { resolve(undefined); }
      });

      let ok = await extractViaSseof(videoPath);
      if (!ok) {
        const dur = await ffprobeDuration();
        if (dur && dur > 0.2) {
          ok = await extractAtTime(videoPath, Math.max(0, dur - 0.08));
          if (!ok) ok = await extractAtTime(videoPath, Math.max(0, dur - 0.5));
        }
      }
      if (!ok) {
        const remuxed = await tryRemux();
        if (remuxed) {
          ok = await extractViaSseof(remuxed);
          if (!ok) {
            const dur = await ffprobeDuration();
            if (dur && dur > 0.2) ok = await extractAtTime(remuxed, Math.max(0, dur - 0.08));
          }
        }
      }
      if (!ok) {
        const rec = await tryReencode();
        if (rec) {
          ok = await extractViaSseof(rec);
          if (!ok) {
            const dur = await ffprobeDuration();
            if (dur && dur > 0.2) ok = await extractAtTime(rec, Math.max(0, dur - 0.08));
          }
        }
      }
      if (ok && existsNonEmpty(outPng)) {
        const b = fs.readFileSync(outPng);
        const b64 = b.toString('base64');
        try { fs.unlinkSync(outPng); } catch {}
        return `data:image/png;base64,${b64}`;
      }
    } catch (e) {
      this.logger.debug(`[debugExtract] error: ${e?.message ?? e}`);
    }
    return undefined;
  }
}
