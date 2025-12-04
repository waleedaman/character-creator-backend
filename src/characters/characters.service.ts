import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Character } from './character.schema';
import { CreateCharacterDto } from './dto/create-character.dto';

@Injectable()
export class CharactersService {
  private readonly logger = new Logger(CharactersService.name);
  constructor(@InjectModel(Character.name) private characterModel: Model<Character>) {}

  async create(dto: CreateCharacterDto) {
    const created = new this.characterModel(dto);
    return created.save();
  }

  async findAll() {
    const docs = await this.characterModel.find().sort({ createdAt: -1 }).lean().exec();
    // Normalize _id to id for frontend friendliness
  return docs.map((d: any) => ({ id: String(d._id), name: d.name, description: d.description, image: d.image, createdAt: (d as any).createdAt, updatedAt: (d as any).updatedAt }));
  }

  async findOne(id: string) {
    const d = await this.characterModel.findById(id).lean().exec();
  if (!d) return null;
  return { id: String(d._id), name: d.name, description: d.description, image: d.image, createdAt: (d as any).createdAt, updatedAt: (d as any).updatedAt };
  }
}
