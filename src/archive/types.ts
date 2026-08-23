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

export type EvidenceIntroScene = {
  slot: number;
  role: 'reality' | 'evidence';
  storyBasis?: string;
  prompt: string;
  image: string;
  cropFocusX?: number;
  cropFocusY?: number;
  cropScale?: number;
};

export type ArchiveIntro = {
  style: 'regular_hook' | 'evidence_montage';
  duration: number;
  imageCount: number;
  narrationDelaySeconds?: number;
  musicLeadInSeconds?: number;
  musicIntroVolume?: number;
  musicStoryVolume?: number;
  scenes: EvidenceIntroScene[];
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
  documentaryFilter?: 'current_archival' | 'soft_edge_lens';
  contentLanguage?: 'english' | 'spanish';
  backgroundAudio?: string;
  backgroundVolume?: number;
  hookSceneCount?: number;
  intro?: ArchiveIntro;
  captions?: ArchiveCaption[];
  sfx?: {
    projectorStart?: string;
    cameraClick?: string;
    paperSlide?: string;
    introCameraSwitch?: string;
    introFinalSnap?: string;
  };
  scenes: ArchiveScene[];
};
