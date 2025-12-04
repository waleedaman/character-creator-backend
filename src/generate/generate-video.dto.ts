export type ScriptChunk = {
  time: string; // e.g., "0-8seconds"
  audio?: string;
  visuals?: string;
  characters?: Array<{ name: string; description?: string; image?: string }>;
  mood?: string | undefined; // overall mood for the chunk, e.g., "happy", "sad", "exciting"
};

export class GenerateVideoDto {
  script!: ScriptChunk[];
  firstFrame?: string; // base64 or data URL
  characters?: Array<{ name: string; description?: string; image?: string }>;
  model?: string; // optional override
  // Optional filename to save the combined video as (e.g. "my_video.mp4"). If omitted the server will
  // generate a unique filename and return it in the response.
  outputName?: string;
  // Optional webhook URL to POST a small JSON payload to once the video is ready. Payload: { filename, url }
  notifyUrl?: string;
}
