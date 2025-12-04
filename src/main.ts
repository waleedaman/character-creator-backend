import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
try {
  // load .env in development if dotenv is installed
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv');
  dotenv.config();
} catch (e) {
  // ignore if dotenv isn't installed
}

import * as express from 'express';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Increase body parser limits to allow large JSON payloads (base64 images)
  const bodyLimit = process.env.BODY_PARSER_LIMIT ?? process.env.MAX_UPLOAD_SIZE ?? '25mb';
  // If MAX_UPLOAD_SIZE is a number of bytes, convert to string with 'b' suffix not required by express; express accepts bytes as number too.
  try {
    const numeric = Number(bodyLimit);
    if (!Number.isNaN(numeric)) {
      app.use(express.json({ limit: numeric }));
      app.use(express.urlencoded({ limit: numeric, extended: true }));
    } else {
      app.use(express.json({ limit: String(bodyLimit) }));
      app.use(express.urlencoded({ limit: String(bodyLimit), extended: true }));
    }
  } catch (e) {
    // Fallback to default
    app.use(express.json({ limit: '25mb' }));
    app.use(express.urlencoded({ limit: '25mb', extended: true }));
  }

  // Log configured body limits for visibility
  // eslint-disable-next-line no-console
  console.log(`[startup] Body parser limit: ${String(bodyLimit)}`);

  // Enable CORS so the frontend (usually running on localhost:3000) can
  // make requests to this backend during development. You can change the
  // origin or set it from an env var for production.
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Authorization',
    credentials: true,
  });

  // Serve uploaded files from the uploads directory
  const uploadsRoot = process.env.UPLOADS_ROOT ?? 'uploads';
  const uploadPublicPrefix = process.env.UPLOAD_PUBLIC_PREFIX ?? '/uploads';
  // Ensure root and common subdirs exist
  fs.mkdirSync(uploadsRoot, { recursive: true });
  fs.mkdirSync(path.join(uploadsRoot, 'characters'), { recursive: true });
  fs.mkdirSync(path.join(uploadsRoot, 'videos'), { recursive: true });
  app.use(uploadPublicPrefix, express.static(path.resolve(uploadsRoot)));

  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
