export type ArchiveMode =
  | 'photo'
  | 'dossier'
  | 'map'
  | 'timeline'
  | 'memory'
  | 'number';

export type ArchiveMarker = {
  scene: number;
  type: 'circle' | 'arrow' | 'circle_arrow' | 'underline' | 'bracket' | 'measure' | 'word';
  text?: string;
  target?: string;
  why?: string;
  box: {x: number; y: number; w: number; h: number};
  label_box?: {x: number; y: number; w: number; h: number};
  arrow_from?: {x: number; y: number};
  arrow_to?: {x: number; y: number};
  confidence?: number;
};

export type ArchiveScene = {
  index: number;
  text: string;
  prompt: string;
  image: string;
  start: number;
  end: number;
  mode: ArchiveMode;
  label: string;
  visualText: string;
  dateHint: string;
  motion: string;
  accent?: string;
  sfx?: string;
  hook?: boolean;
  marker?: ArchiveMarker;
};

export type ArchiveCaption = {
  start: number;
  end: number;
  text: string;
};

export type ArchiveData = {
  title: string;
  fps: number;
  duration: number;
  audio: string;
  subtitlesEnabled?: boolean;
  markerOverlaysEnabled?: boolean;
  markerTextStyle?: 'small_red_note' | 'harsh_black';
  markerFont?: 'homemade_apple' | 'reenie_beanie';
  markerAllCaps?: boolean;
  contentLanguage?: 'english' | 'spanish';
  backgroundAudio?: string;
  backgroundVolume?: number;
  hookSceneCount?: number;
  captions?: ArchiveCaption[];
  sfx?: {
    projectorStart?: string;
    cameraClick?: string;
    paperSlide?: string;
  };
  scenes: ArchiveScene[];
};
