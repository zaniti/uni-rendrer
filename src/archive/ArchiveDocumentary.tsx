import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {CSSProperties} from 'react';
import type {ArchiveCaption, ArchiveData, ArchiveScene} from './types';

export const ArchiveDocumentary = ({data}: {data: ArchiveData}) => {
  const {fps} = useVideoConfig();
  const hookEnd = data.scenes
    .filter((scene) => scene.hook)
    .reduce((latest, scene) => Math.max(latest, scene.end), 0);

  if (!data.scenes.length) {
    return (
      <AbsoluteFill style={styles.empty}>
        <div style={styles.emptyTitle}>Archive Remotion Factory</div>
        <div style={styles.emptyText}>Build a preview from the Python app.</div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={styles.stage}>
      {data.audio ? <Audio src={staticFile(data.audio)} /> : null}
      {data.backgroundAudio ? (
        <Audio src={resolveAudioSrc(data.backgroundAudio)} volume={data.backgroundVolume ?? 0.065} loop />
      ) : null}
      <SoundEffects data={data} />
      {data.scenes.map((scene) => {
        const from = Math.floor(scene.start * fps);
        const durationInFrames = Math.max(1, Math.ceil((scene.end - scene.start) * fps));
        return (
          <Sequence key={scene.index} from={from} durationInFrames={durationInFrames}>
            <ArchiveSceneFrame scene={scene} durationInFrames={durationInFrames} />
          </Sequence>
        );
      })}
      {data.subtitlesEnabled === false ? null : <Captions captions={data.captions ?? []} startAt={hookEnd} />}
    </AbsoluteFill>
  );
};

const SoundEffects = ({data}: {data: ArchiveData}) => {
  const {fps} = useVideoConfig();
  const sfx = data.sfx ?? {};
  const namedSound = (name?: string) => {
    if (name === 'paper_slide') return sfx.paperSlide;
    if (name === 'camera_click') return sfx.cameraClick;
    return null;
  };
  const accentSound = (accent?: string, explicit?: string) => {
    const planned = namedSound(explicit);
    if (planned) return planned;
    if (accent === 'scan' || accent === 'shutter') return sfx.cameraClick;
    if (accent === 'focus' || accent === 'light_leak') return sfx.paperSlide;
    return null;
  };

  return (
    <>
      {sfx.projectorStart ? (
        <Sequence from={0} durationInFrames={Math.round(fps * 2.1)}>
          <Audio src={resolveAudioSrc(sfx.projectorStart)} volume={0.18} />
        </Sequence>
      ) : null}
      {data.scenes.slice(1).map((scene) => {
        const file = accentSound(scene.accent, scene.sfx);
        if (!file) return null;
        const volume = scene.hook ? 0.16 : 0.075;
        return (
          <Sequence key={`sfx-${scene.index}`} from={Math.floor(scene.start * fps)} durationInFrames={Math.round(fps * 1.1)}>
            <Audio src={resolveAudioSrc(file)} volume={volume} />
          </Sequence>
        );
      })}
    </>
  );
};

const resolveAudioSrc = (src: string) => {
  return /^https?:\/\//.test(src) ? src : staticFile(src);
};

const ArchiveSceneFrame = ({
  scene,
  durationInFrames,
}: {
  scene: ArchiveScene;
  durationInFrames: number;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const fade = Math.min(
    interpolate(frame, [0, fps * 0.55], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
    interpolate(frame, [durationInFrames - fps * 0.7, durationInFrames], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  );
  const transform = imageTransform(scene, progress, frame);
  const gateJitter = Math.sin((frame + scene.index * 11) * 0.55) * 0.9;
  const focusBlur = scene.index === 1
    ? interpolate(frame, [0, 14, 42], [8, 2.5, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
    : 0;

  if (scene.hook) {
    return <HookSceneFrame scene={scene} durationInFrames={durationInFrames} />;
  }

  return (
    <AbsoluteFill style={{...styles.scene, opacity: fade}}>
      <AbsoluteFill
        style={{
          ...styles.imageWrap,
          transform: `translate(${gateJitter}px, ${-gateJitter * 0.55}px)`,
        }}
      >
        <Img
          src={staticFile(scene.image)}
          style={{
            ...styles.image,
            transform,
            filter: `${imageFilter(scene, frame)} blur(${focusBlur}px)`,
          }}
        />
      </AbsoluteFill>

      <AbsoluteFill style={styles.softGrade} />
      <AbsoluteFill style={styles.vignette} />
      <FilmDamage frame={frame} scene={scene} />
      <MomentAccent scene={scene} frame={frame} durationInFrames={durationInFrames} />
      {scene.index === 1 ? <IntroPrintReveal frame={frame} /> : null}
    </AbsoluteFill>
  );
};

const HookSceneFrame = ({
  scene,
  durationInFrames,
}: {
  scene: ArchiveScene;
  durationInFrames: number;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const fade = Math.min(
    interpolate(frame, [0, 9], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
    interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  );
  const enter = spring({frame, fps, config: {damping: 18, stiffness: 130, mass: 0.7}});
  const photoScale = interpolate(enter, [0, 1], [0.94, 1]) + progress * 0.018;
  const jitter = Math.sin(frame * 0.53 + scene.index) * 0.45;
  const seconds = Math.max(0, Math.floor((Math.floor(scene.start * fps) + frame) / fps));
  const timer = `00:${String(seconds).padStart(2, '0')}`;

  return (
    <AbsoluteFill style={styles.hookStage}>
      <AbsoluteFill style={styles.hookEdgeFade} />
      <div style={styles.hookCameraFrame}>
        <div style={styles.hookHud}>
          <span style={styles.hookPlay}>PLAY</span>
          <span style={styles.hookTimer}>{timer}</span>
        </div>
        <div
          style={{
            ...styles.hookPhotoMat,
            opacity: fade,
            transform: `translate(-50%, -50%) translate(${jitter}px, ${-jitter * 0.5}px) scale(${photoScale})`,
          }}
        >
          <div style={styles.hookPhotoInner}>
            <Img
              src={staticFile(scene.image)}
              style={{
                ...styles.hookPhoto,
                filter: `${imageFilter(scene, frame)} contrast(1.14) brightness(0.94)`,
              }}
            />
          </div>
        </div>
        <div style={styles.hookScanlines} />
        <div style={{...styles.hookFlicker, opacity: 0.1 + Math.abs(Math.sin(frame * 0.31)) * 0.08}} />
      </div>
      <FilmDamage frame={frame} scene={scene} />
      <MomentAccent scene={{...scene, accent: 'shutter'}} frame={frame} durationInFrames={durationInFrames} />
    </AbsoluteFill>
  );
};

const imageTransform = (scene: ArchiveScene, progress: number, frame: number) => {
  const pulse = Math.sin(frame * 0.03 + scene.index) * 0.001;
  const zoom = scene.motion === 'pull' ? 1.025 - progress * 0.018 : 1.006 + progress * 0.019;
  const pan = 12 * (progress - 0.5);
  const drift = Math.sin(progress * Math.PI * 2 + scene.index) * 3;

  if (scene.motion === 'pan_left') {
    return `scale(${zoom + pulse}) translateX(${pan}px) translateY(${drift}px)`;
  }
  if (scene.motion === 'pan_right') {
    return `scale(${zoom + pulse}) translateX(${-pan}px) translateY(${drift}px)`;
  }
  if (scene.motion === 'scanner') {
    return `scale(${1.018 + pulse}) translateX(${Math.sin(frame * 0.012) * 5}px) translateY(${progress * -6}px)`;
  }
  if (scene.motion === 'drift') {
    return `scale(${1.014 + pulse}) translateX(${Math.sin(frame * 0.018) * 6}px) translateY(${Math.cos(frame * 0.014) * 4}px)`;
  }
  return `scale(${zoom + pulse}) translateY(${scene.motion === 'slow_push' ? -progress * 6 : drift}px)`;
};

const imageFilter = (scene: ArchiveScene, frame: number) => {
  const flicker = Math.sin(frame * 0.39 + scene.index) * 0.035;
  const contrast = scene.mode === 'dossier' ? 1.18 : 1.08;
  return `sepia(0.28) saturate(0.78) contrast(${contrast}) brightness(${0.84 + flicker})`;
};

const FilmDamage = ({frame, scene}: {frame: number; scene: ArchiveScene}) => {
  const scratch = 14 + ((scene.index * 73 + frame * 3) % 1600);
  const dustA = (scene.index * 97 + frame * 5) % 1920;
  const dustB = (scene.index * 41 + frame * 7) % 1080;
  return (
    <AbsoluteFill style={styles.damage}>
      <div style={{...styles.grain, opacity: 0.08 + Math.abs(Math.sin(frame * 0.47)) * 0.035}} />
      <div style={{...styles.scratch, left: scratch, opacity: frame % 9 < 5 ? 0.22 : 0.04}} />
      <div style={{...styles.dust, left: dustA, top: dustB, opacity: frame % 17 < 3 ? 0.38 : 0}} />
      <div style={{...styles.filmGate, opacity: 0.18 + Math.sin(frame * 0.11) * 0.04}} />
    </AbsoluteFill>
  );
};

const IntroPrintReveal = ({frame}: {frame: number}) => {
  const black = interpolate(frame, [0, 10, 30], [1, 0.72, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const flash = interpolate(frame, [6, 11, 21, 32], [0, 0.72, 0.2, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const paper = interpolate(frame, [12, 36, 64], [0, 0.32, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={styles.introLayer}>
      <AbsoluteFill style={{backgroundColor: '#040302', opacity: black}} />
      <AbsoluteFill style={{backgroundColor: '#fff0c9', opacity: flash, mixBlendMode: 'screen'}} />
      <AbsoluteFill style={{...styles.paperWash, opacity: paper}} />
    </AbsoluteFill>
  );
};

const MomentAccent = ({
  scene,
  frame,
  durationInFrames,
}: {
  scene: ArchiveScene;
  frame: number;
  durationInFrames: number;
}) => {
  const accent = scene.accent ?? 'none';
  if (accent === 'none' || accent === 'intro_print' || durationInFrames < 18) {
    return null;
  }
  const life = interpolate(frame, [0, 12, Math.min(durationInFrames, 48)], [0, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  if (accent === 'scan') {
    const top = interpolate(frame, [0, Math.min(durationInFrames, 54)], [140, 900], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    return (
      <AbsoluteFill style={styles.accentLayer}>
        <div style={{...styles.scanAccent, top, opacity: life * 0.38}} />
      </AbsoluteFill>
    );
  }

  if (accent === 'focus') {
    const scale = interpolate(frame, [0, 34], [0.82, 1.22], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    return (
      <AbsoluteFill style={styles.accentLayer}>
        <div style={{...styles.focusRing, opacity: life * 0.25, transform: `translate(-50%, -50%) scale(${scale})`}} />
      </AbsoluteFill>
    );
  }

  if (accent === 'light_leak') {
    const left = interpolate(frame, [0, Math.min(durationInFrames, 62)], [-360, 1980], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    return (
      <AbsoluteFill style={styles.accentLayer}>
        <div style={{...styles.lightLeak, left, opacity: life * 0.28}} />
      </AbsoluteFill>
    );
  }

  if (accent === 'shutter') {
    const opacity = interpolate(frame, [0, 3, 12], [0, 0.34, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    return <AbsoluteFill style={{...styles.shutterFlash, opacity}} />;
  }

  if (accent === 'date_stamp' || accent === 'evidence_slip') {
    const opacity = Math.min(
      interpolate(frame, [0, 12], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
      interpolate(frame, [Math.min(durationInFrames - 8, 58), Math.min(durationInFrames, 78)], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      }),
    );
    const x = interpolate(frame, [0, 18], [-24, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    const text = accent === 'date_stamp' && scene.dateHint ? scene.dateHint : scene.visualText;
    return (
      <AbsoluteFill style={styles.accentLayer}>
        <div style={{...styles.evidenceSlip, opacity: opacity * 0.86, transform: `translateX(${x}px)`}}>
          <span style={styles.evidencePin} />
          {text}
        </div>
      </AbsoluteFill>
    );
  }

  return null;
};

const Captions = ({captions, startAt}: {captions: ArchiveCaption[]; startAt: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const second = frame / fps;
  if (second < startAt) {
    return null;
  }
  const caption = captions.find((item) => item.start >= startAt && second >= item.start && second < item.end);
  if (!caption) {
    return null;
  }
  const local = frame - Math.floor(caption.start * fps);
  const duration = Math.max(1, Math.round((caption.end - caption.start) * fps));
  const opacity = Math.min(
    interpolate(local, [0, 8], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
    interpolate(local, [Math.max(0, duration - 10), duration], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  );
  const settle = spring({frame: local, fps, config: {damping: 18, stiffness: 95, mass: 0.7}});
  const y = interpolate(settle, [0, 1], [10, 0]);

  return (
    <AbsoluteFill style={styles.captionLayer}>
      <div style={{...styles.subtitle, opacity, transform: `translateY(${y}px)`}}>{caption.text}</div>
    </AbsoluteFill>
  );
};

const styles: Record<string, CSSProperties> = {
  stage: {
    backgroundColor: '#080706',
    color: '#f2eadc',
    fontFamily: 'Georgia, Times New Roman, serif',
  },
  empty: {
    backgroundColor: '#0c0a08',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#efe7d8',
  },
  emptyTitle: {
    fontSize: 78,
    letterSpacing: 0,
  },
  emptyText: {
    marginTop: 24,
    fontSize: 32,
    color: '#b7aa94',
  },
  scene: {
    backgroundColor: '#080706',
    overflow: 'hidden',
  },
  imageWrap: {
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    transformOrigin: 'center center',
  },
  softGrade: {
    background:
      'linear-gradient(90deg, rgba(23,13,5,0.45), rgba(7,7,8,0.08) 45%, rgba(8,7,6,0.58)), linear-gradient(180deg, rgba(248,212,140,0.08), rgba(0,0,0,0.18))',
    mixBlendMode: 'multiply',
  },
  vignette: {
    background:
      'radial-gradient(circle at 50% 48%, rgba(0,0,0,0) 0%, rgba(0,0,0,0.18) 48%, rgba(0,0,0,0.72) 100%)',
  },
  damage: {
    pointerEvents: 'none',
  },
  grain: {
    position: 'absolute',
    inset: 0,
    backgroundImage:
      'radial-gradient(circle, rgba(255,255,255,0.38) 0 1px, transparent 1px), radial-gradient(circle, rgba(0,0,0,0.25) 0 1px, transparent 1px)',
    backgroundSize: '5px 5px, 7px 7px',
    mixBlendMode: 'overlay',
  },
  scratch: {
    position: 'absolute',
    top: -80,
    width: 2,
    height: 1240,
    backgroundColor: 'rgba(255,246,220,0.75)',
    filter: 'blur(1px)',
  },
  dust: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(255,246,220,0.55)',
    filter: 'blur(2px)',
  },
  filmGate: {
    position: 'absolute',
    inset: 34,
    border: '2px solid rgba(255,237,197,0.2)',
    boxShadow: 'inset 0 0 90px rgba(0,0,0,0.75)',
  },
  introLayer: {
    pointerEvents: 'none',
  },
  paperWash: {
    background:
      'radial-gradient(circle at 50% 50%, rgba(255,246,218,0.75), rgba(196,143,73,0.16) 48%, rgba(0,0,0,0) 70%)',
    mixBlendMode: 'screen',
  },
  accentLayer: {
    pointerEvents: 'none',
  },
  scanAccent: {
    position: 'absolute',
    left: 0,
    width: '100%',
    height: 5,
    background: 'linear-gradient(90deg, rgba(255,236,185,0), rgba(255,236,185,0.72), rgba(255,236,185,0))',
    boxShadow: '0 0 30px rgba(255,236,185,0.38)',
  },
  focusRing: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 520,
    height: 520,
    borderRadius: 520,
    border: '3px solid rgba(255,232,184,0.75)',
    boxShadow: '0 0 50px rgba(255,232,184,0.18), inset 0 0 46px rgba(255,232,184,0.14)',
  },
  lightLeak: {
    position: 'absolute',
    top: -120,
    width: 330,
    height: 1320,
    background:
      'linear-gradient(90deg, rgba(255,175,76,0), rgba(255,202,104,0.62), rgba(255,90,42,0.15), rgba(255,175,76,0))',
    filter: 'blur(34px)',
    mixBlendMode: 'screen',
  },
  shutterFlash: {
    backgroundColor: '#fff2cf',
    mixBlendMode: 'screen',
    pointerEvents: 'none',
  },
  evidenceSlip: {
    position: 'absolute',
    left: 86,
    bottom: 168,
    maxWidth: 760,
    padding: '13px 22px 14px 18px',
    backgroundColor: 'rgba(231,210,164,0.82)',
    color: '#1b120a',
    fontFamily: 'Menlo, Monaco, monospace',
    fontSize: 30,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    whiteSpace: 'normal',
    overflow: 'hidden',
    lineHeight: 1.12,
    boxShadow: '0 18px 46px rgba(0,0,0,0.38)',
    border: '1px solid rgba(90,58,28,0.32)',
  },
  evidencePin: {
    display: 'inline-block',
    width: 10,
    height: 10,
    marginRight: 14,
    backgroundColor: '#8f2a1e',
  },
  hookStage: {
    background:
      'radial-gradient(circle at 50% 45%, rgba(230,222,205,0.15), rgba(0,0,0,0.18) 42%, rgba(0,0,0,0.92) 100%), #040503',
    overflow: 'hidden',
  },
  hookCameraFrame: {
    position: 'absolute',
    inset: 34,
    borderRadius: 24,
    border: '3px solid rgba(31,151,83,0.55)',
    boxShadow:
      'inset 0 0 120px rgba(0,0,0,0.85), inset 0 0 18px rgba(43,173,95,0.28), 0 0 26px rgba(35,142,82,0.2)',
    backgroundColor: 'rgba(238,231,212,0.09)',
    overflow: 'hidden',
  },
  hookEdgeFade: {
    background:
      'radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 32%, rgba(0,0,0,0.24) 58%, rgba(0,0,0,0.82) 100%)',
  },
  hookHud: {
    position: 'absolute',
    top: 46,
    left: 54,
    right: 54,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 8,
    fontFamily: 'Menlo, Monaco, monospace',
    fontWeight: 800,
    letterSpacing: 1.2,
  },
  hookPlay: {
    color: '#239a57',
    fontSize: 24,
    textShadow: '0 0 9px rgba(38,180,102,0.55)',
  },
  hookTimer: {
    color: '#c5272e',
    fontSize: 24,
    textShadow: '0 0 8px rgba(226,45,52,0.42)',
  },
  hookPhotoMat: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 760,
    height: 855,
    padding: 18,
    backgroundColor: 'rgba(235,229,211,0.93)',
    boxShadow: '0 26px 90px rgba(0,0,0,0.6), 0 0 0 1px rgba(251,246,229,0.42)',
    transformOrigin: 'center center',
  },
  hookPhotoInner: {
    width: '100%',
    height: '100%',
    backgroundColor: '#e9dfc9',
    overflow: 'hidden',
  },
  hookPhoto: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    backgroundColor: '#e9dfc9',
  },
  hookBottomPlayer: {
    position: 'absolute',
    left: 88,
    right: 88,
    bottom: 58,
    zIndex: 9,
  },
  hookPlayerTrack: {
    width: '100%',
    height: 7,
    backgroundColor: 'rgba(230,238,222,0.14)',
    borderRadius: 7,
    boxShadow: '0 0 12px rgba(0,0,0,0.55)',
    overflow: 'hidden',
  },
  hookPlayerProgress: {
    height: '100%',
    background: 'linear-gradient(90deg, rgba(35,154,87,0.92), rgba(68,190,112,0.96))',
    boxShadow: '0 0 10px rgba(44,174,95,0.46)',
  },
  hookScanlines: {
    position: 'absolute',
    inset: 0,
    backgroundImage:
      'repeating-linear-gradient(180deg, rgba(255,255,255,0.035) 0px, rgba(255,255,255,0.035) 1px, rgba(0,0,0,0) 3px, rgba(0,0,0,0) 7px)',
    mixBlendMode: 'screen',
    opacity: 0.28,
    pointerEvents: 'none',
  },
  hookFlicker: {
    position: 'absolute',
    inset: 0,
    backgroundColor: '#d9cfb8',
    mixBlendMode: 'soft-light',
    pointerEvents: 'none',
  },
  captionLayer: {
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 72,
    pointerEvents: 'none',
  },
  subtitle: {
    maxWidth: 1280,
    padding: '8px 22px 10px',
    color: '#fff2dc',
    fontFamily: 'Georgia, Times New Roman, serif',
    fontSize: 44,
    lineHeight: 1.14,
    textAlign: 'center',
    textShadow: '0 3px 16px rgba(0,0,0,0.92), 0 0 2px rgba(0,0,0,0.8)',
    backgroundColor: 'rgba(3,2,1,0.28)',
    borderRadius: 4,
  },
};
