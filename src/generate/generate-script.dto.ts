export type CharacterInput = {
  name: string;
  description?: string;
};

export class GenerateScriptDto {
  prompt!: string;
  characters?: CharacterInput[];
}
