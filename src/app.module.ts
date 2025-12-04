import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GenerateController } from './generate/generate.controller';
import { GenerateService } from './generate/generate.service';
import { MongooseModule } from '@nestjs/mongoose';
import { CharactersModule } from './characters/characters.module';

@Module({
  imports: [
    MongooseModule.forRoot(process.env.MONGO_URI ?? 'mongodb://localhost:27017/character-creator', {
      // Use create indexes if desired; keep defaults minimal
    }),
    CharactersModule,
  ],
  controllers: [AppController, GenerateController],
  providers: [AppService, GenerateService],
})
export class AppModule {}
