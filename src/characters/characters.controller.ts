import { Body, Controller, Get, Post, UploadedFile, UseInterceptors, Param } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CharactersService } from './characters.service';
import { CreateCharacterDto } from './dto/create-character.dto';

@Controller('characters')
export class CharactersController {
  constructor(private readonly svc: CharactersService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: diskStorage({
        destination: (req, file, cb) => {
          const uploadDir = process.env.UPLOAD_DIR ?? 'uploads/characters';
          // Ensure directory exists
          fs.mkdirSync(uploadDir, { recursive: true });
          cb(null, uploadDir);
        },
        filename: (req, file, cb) => {
          const ext = path.extname(file.originalname) || '.png';
          const base = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
          cb(null, `${base}${ext}`);
        },
      }),
      limits: { fileSize: Number(process.env.MAX_UPLOAD_SIZE ?? 20 * 1024 * 1024) }, // default 20 MB
    }),
  )
  async create(@UploadedFile() file: Express.Multer.File, @Body() dto: CreateCharacterDto) {
    // If a multipart file was uploaded and saved to disk, store the URL path instead of inline data
    if (file && file.path) {
      // Build a relative URL for the frontend to fetch.
      const uploadDir = process.env.UPLOAD_DIR ?? 'uploads/characters';
      const publicPrefix = process.env.UPLOAD_PUBLIC_PREFIX ?? '/uploads';
      const filename = path.basename(file.path);
      dto.image = `${publicPrefix}/${filename}`;
    } else if (file && file.buffer) {
      // Fallback: if diskStorage didn't provide path but buffer exists, convert to data URL
      const mime = file.mimetype || 'image/png';
      const b64 = file.buffer.toString('base64');
      dto.image = `data:${mime};base64,${b64}`;
    } else if (dto.image && typeof dto.image === 'string' && !dto.image.startsWith('data:')) {
      // If frontend sent plain base64 in JSON, normalize to data URL (assume png)
      dto.image = `data:image/png;base64,${dto.image}`;
    }

    const doc = await this.svc.create(dto as any);
    // Return the stored document (lean it if needed)
    const obj = doc.toObject ? doc.toObject() : doc;
    return { id: obj._id, ...obj };
  }

  @Get()
  async list() {
    return this.svc.findAll();
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const c = await this.svc.findOne(id);
    if (!c) return { error: 'not_found' };
    return c;
  }
}
