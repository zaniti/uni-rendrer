export type CaptionChunk = {
  start: number;
  end: number;
  text: string;
};

export type CartoonScene = {
  id: number;
  text: string;
  headline: string;
  prompt: string;
  image_path?: string;
  approved?: boolean;
  start?: number;
  end?: number;
  subtitle?: string;
  caption_chunks?: CaptionChunk[];
};

export type CartoonData = {
  kind: 'CartoonExplainer';
  stem: string;
  audio: string;
  scenes: CartoonScene[];
  fps?: number;
  width?: number;
  height?: number;
  channel_name?: string;
  subtitles_enabled?: boolean;
  subtitle_transition?: 'current' | 'fast' | 'none';
  duration_seconds?: number;
};
