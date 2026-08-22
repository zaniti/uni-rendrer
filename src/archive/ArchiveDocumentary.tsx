import {
  AbsoluteFill,
  Audio,
  continueRender,
  delayRender,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {useEffect, useState} from 'react';
import type {CSSProperties} from 'react';
import type {
  ArchiveCaption,
  ArchiveData,
  ArchiveScene,
  EvidenceIntroScene,
} from './types';

const MARKER_FONT_FAMILIES = {
  homemade_apple: 'ArchiveMarkerHomemadeApple',
  reenie_beanie: 'ArchiveMarkerReenieBeanie',
} as const;
const MULTILINGUAL_FALLBACK_FONT = 'ArchiveNotoSansCJK';
const MULTILINGUAL_FALLBACK_STACK = `${MULTILINGUAL_FALLBACK_FONT}, sans-serif`;

const useArchiveMarkerFonts = () => {
  const [handle] = useState(() => delayRender('Loading archive marker fonts'));

  useEffect(() => {
    let cancelled = false;
    const fonts = [
      new FontFace(
        MARKER_FONT_FAMILIES.homemade_apple,
        `url(${staticFile('fonts/HomemadeApple-Regular.ttf')}) format('truetype')`,
      ),
      new FontFace(
        MARKER_FONT_FAMILIES.reenie_beanie,
        `url(${staticFile('fonts/ReenieBeanie-Regular.ttf')}) format('truetype')`,
      ),
      new FontFace(
        MULTILINGUAL_FALLBACK_FONT,
        `url(${staticFile('fonts/NotoSansCJKjp-Regular.otf')}) format('opentype')`,
      ),
    ];

    Promise.allSettled(fonts.map((font) => font.load()))
      .then((fontResults) => {
        if (!cancelled) {
          fontResults.forEach((result) => {
            if (result.status === 'fulfilled') {
              document.fonts.add(result.value);
            }
          });
        }
      })
      .finally(() => continueRender(handle));

    return () => {
      cancelled = true;
    };
  }, [handle]);
};

export const ArchiveDocumentary = ({data}: {data: ArchiveData}) => {
  useArchiveMarkerFonts();
  const {fps} = useVideoConfig();
  const evidenceIntro =
    data.intro?.style === 'evidence_montage' && data.intro.scenes.length
      ? data.intro
      : null;
  const introFrames = evidenceIntro
    ? Math.round(evidenceIntro.duration * fps)
    : 0;
  const narrationDelayFrames = evidenceIntro
    ? Math.round((evidenceIntro.narrationDelaySeconds ?? 1) * fps)
    : 0;
  const narrationStartFrames = introFrames + narrationDelayFrames;
  const firstSceneIndex = data.scenes[0]?.index;
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
      {evidenceIntro ? (
        <Sequence from={0} durationInFrames={introFrames}>
          <EvidenceMontage
            scenes={evidenceIntro.scenes}
            durationInFrames={introFrames}
            sfx={data.sfx}
          />
        </Sequence>
      ) : null}
      {data.audio ? (
        <Sequence from={narrationStartFrames}>
          <Audio src={staticFile(data.audio)} />
        </Sequence>
      ) : null}
      {data.backgroundAudio ? (
        evidenceIntro ? (
          <Audio
            src={resolveAudioSrc(data.backgroundAudio)}
            startFrom={Math.round((evidenceIntro.musicLeadInSeconds ?? 0) * fps)}
            volume={(frame) => {
              const intro = evidenceIntro.musicIntroVolume ?? 1.8;
              const story = evidenceIntro.musicStoryVolume ?? intro * 0.8;
              const fadeStart = Math.max(0, introFrames - fps);
              const fadeEnd = introFrames + fps;
              if (frame < fadeStart) return intro;
              if (frame >= fadeEnd) return story;
              const fadeProgress = interpolate(
                frame,
                [fadeStart, fadeEnd],
                [0, 1],
                {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
              );
              return interpolate(smooth(fadeProgress), [0, 1], [intro, story]);
            }}
            loop
          />
        ) : (
          <Audio src={resolveAudioSrc(data.backgroundAudio)} volume={data.backgroundVolume ?? 0.065} loop />
        )
      ) : null}
      <Sequence from={narrationStartFrames}>
        <SoundEffects data={data} />
      </Sequence>
      {data.scenes.map((scene) => {
        const isFirstScene = scene.index === firstSceneIndex;
        const from =
          introFrames +
          Math.floor(scene.start * fps) +
          (isFirstScene ? 0 : narrationDelayFrames);
        const durationInFrames =
          Math.max(1, Math.ceil((scene.end - scene.start) * fps)) +
          (isFirstScene ? narrationDelayFrames : 0);
        return (
          <Sequence key={scene.index} from={from} durationInFrames={durationInFrames}>
            <ArchiveSceneFrame
              scene={scene}
              durationInFrames={durationInFrames}
              markerTextStyle={data.markerTextStyle ?? 'small_red_note'}
              markerFont={data.markerFont ?? 'homemade_apple'}
              markerAllCaps={data.markerAllCaps !== false}
              subtitlesEnabled={data.subtitlesEnabled !== false}
              documentaryFilter={data.documentaryFilter ?? 'current_archival'}
              showIntroPrintReveal={!evidenceIntro}
            />
          </Sequence>
        );
      })}
      {data.subtitlesEnabled === false ? null : (
        <Sequence from={narrationStartFrames}>
          <Captions captions={data.captions ?? []} startAt={hookEnd} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
};

type ScheduledIntroScene = {
  scene: EvidenceIntroScene;
  start: number;
  duration: number;
  cropPunch: boolean;
  slideIn: boolean;
};

const evidenceSchedule = (
  scenes: EvidenceIntroScene[],
  durationInFrames: number,
  fps: number,
) => {
  const whiteFrames = Math.max(1, Math.round(0.766667 * fps));
  const contentFrames = Math.max(scenes.length, durationInFrames - whiteFrames);
  const count = scenes.length;
  const cropSlot = Math.max(3, Math.min(count - 4, Math.round(count * 0.34)));
  const evidenceSlot = Math.max(cropSlot + 2, Math.min(count - 2, Math.round(count * 0.52)));
  const slideSlot = evidenceSlot + 1;
  const minFrames = scenes.map((_, index) => {
    const slot = index + 1;
    if (slot === cropSlot) return Math.round(1.3 * fps);
    if (slot === slideSlot) return Math.round(0.78 * fps);
    if (slot === 1) return Math.round(0.65 * fps);
    return Math.round(0.55 * fps);
  });
  const remaining = Math.max(0, contentFrames - minFrames.reduce((sum, value) => sum + value, 0));
  const weights = scenes.map((scene, index) => {
    const slot = index + 1;
    if (slot === cropSlot || slot === slideSlot) return 0.65;
    if (scene.role === 'evidence') return 1.18;
    if (slot === 1) return 1.12;
    return 1;
  });
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const durations = minFrames.map((minimum, index) =>
    minimum + Math.floor((remaining * weights[index]) / weightTotal),
  );
  let undistributed = contentFrames - durations.reduce((sum, value) => sum + value, 0);
  for (let index = 0; undistributed > 0; index = (index + 1) % durations.length) {
    durations[index] += 1;
    undistributed -= 1;
  }
  let start = 0;
  const scheduled: ScheduledIntroScene[] = scenes.map((scene, index) => {
    const slot = index + 1;
    const item = {
      scene,
      start,
      duration: durations[index],
      cropPunch: slot === cropSlot,
      slideIn: slot === slideSlot,
    };
    start += durations[index];
    return item;
  });
  return {scheduled, contentFrames};
};

const EvidenceMontage = ({
  scenes,
  durationInFrames,
  sfx,
}: {
  scenes: EvidenceIntroScene[];
  durationInFrames: number;
  sfx?: ArchiveData['sfx'];
}) => {
  const {fps} = useVideoConfig();
  const {scheduled, contentFrames} = evidenceSchedule(scenes, durationInFrames, fps);
  return (
    <AbsoluteFill style={styles.evidenceIntroStage}>
      {scheduled.map((item) => (
        <Sequence
          key={`intro-${item.scene.slot}`}
          from={item.start}
          durationInFrames={item.duration}
        >
          <EvidenceIntroFrame item={item} />
        </Sequence>
      ))}
      <Sequence from={contentFrames} durationInFrames={durationInFrames - contentFrames}>
        <AbsoluteFill style={styles.introWhiteFlash} />
      </Sequence>
      <EvidenceIntroSounds scheduled={scheduled} contentFrames={contentFrames} sfx={sfx} />
    </AbsoluteFill>
  );
};

const EvidenceIntroFrame = ({item}: {item: ScheduledIntroScene}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const cropFrame = Math.round(item.duration * 0.46);
  const cropZoom = item.cropPunch
    ? frame < cropFrame
      ? 1
      : item.scene.cropScale ?? 1.48
    : 1;
  const slideFrames = Math.max(1, Math.round(0.15 * fps));
  const slideProgress = interpolate(frame, [0, slideFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const slideX = item.slideIn ? (1 - smooth(slideProgress)) * 100 : 0;
  const blur = item.slideIn
    ? interpolate(slideProgress, [0, 1], [10, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : item.cropPunch && frame === cropFrame
      ? 8
      : 0;
  const firstFade =
    item.scene.slot === 1
      ? interpolate(frame, [0, Math.round(0.2 * fps)], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 1;
  const transform = `translateX(${slideX}px) scale(${cropZoom})`;
  const cropOrigin =
    item.cropPunch && frame >= cropFrame
      ? `${item.scene.cropFocusX ?? 50}% ${item.scene.cropFocusY ?? 50}%`
      : 'center center';
  return (
    <AbsoluteFill
      style={{
        ...styles.evidenceIntroScene,
        backgroundColor:
          item.scene.slot === 1 || item.slideIn ? '#eee8d8' : '#080706',
      }}
    >
      <Img
        src={staticFile(item.scene.image)}
        style={{
          ...styles.evidenceIntroImage,
          transform,
          filter: `blur(${blur}px)`,
          opacity: firstFade,
          transformOrigin: cropOrigin,
        }}
      />
      <div style={styles.evidenceSoftEdgeWrap}>
        <Img
          src={staticFile(item.scene.image)}
          style={{
            ...styles.evidenceIntroImage,
            transform,
            filter: `blur(${blur + 8}px)`,
            opacity: firstFade,
            transformOrigin: cropOrigin,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

const EvidenceIntroSounds = ({
  scheduled,
  contentFrames,
  sfx,
}: {
  scheduled: ScheduledIntroScene[];
  contentFrames: number;
  sfx?: ArchiveData['sfx'];
}) => {
  const {fps} = useVideoConfig();
  const camera = sfx?.introCameraSwitch;
  const paper = sfx?.paperSlide;
  const snap = sfx?.introFinalSnap;
  return (
    <>
      {camera ? (
        <Sequence from={Math.round(0.12 * fps)} durationInFrames={Math.round(0.5 * fps)}>
          <Audio src={resolveAudioSrc(camera)} volume={0.44} />
        </Sequence>
      ) : null}
      {scheduled.slice(1).map((item) => {
        const file = item.slideIn ? paper : camera;
        if (!file) return null;
        const paperLead = item.slideIn ? Math.round(0.046 * fps) : 0;
        return (
          <Sequence
            key={`intro-sound-${item.scene.slot}`}
            from={Math.max(0, item.start - paperLead)}
            durationInFrames={Math.round(0.55 * fps)}
          >
            <Audio src={resolveAudioSrc(file)} volume={item.slideIn ? 0.74 : 0.56} />
          </Sequence>
        );
      })}
      {scheduled
        .filter((item) => item.cropPunch)
        .map((item) =>
          paper ? (
            <Sequence
              key={`intro-crop-${item.scene.slot}`}
              from={Math.max(0, item.start + Math.round(item.duration * 0.55) - Math.round(0.046 * fps))}
              durationInFrames={Math.round(0.55 * fps)}
            >
              <Audio src={resolveAudioSrc(paper)} volume={0.68} />
            </Sequence>
          ) : null,
        )}
      {snap ? (
        <Sequence from={contentFrames} durationInFrames={Math.round(0.5 * fps)}>
          <Audio src={resolveAudioSrc(snap)} volume={1.08} />
        </Sequence>
      ) : null}
    </>
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
  markerTextStyle,
  markerFont,
  markerAllCaps,
  subtitlesEnabled,
  documentaryFilter,
  showIntroPrintReveal,
}: {
  scene: ArchiveScene;
  durationInFrames: number;
  markerTextStyle?: ArchiveData['markerTextStyle'];
  markerFont: NonNullable<ArchiveData['markerFont']>;
  markerAllCaps: boolean;
  subtitlesEnabled: boolean;
  documentaryFilter: NonNullable<ArchiveData['documentaryFilter']>;
  showIntroPrintReveal: boolean;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const fadeOut = interpolate(frame, [durationInFrames - fps * 0.7, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const fade =
    scene.index === 1 && !showIntroPrintReveal
      ? fadeOut
      : Math.min(
          interpolate(frame, [0, fps * 0.55], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          fadeOut,
        );
  const transform = imageTransform(scene, progress);
  const focusBlur = scene.index === 1 && showIntroPrintReveal
    ? interpolate(frame, [0, 14, 42], [8, 2.5, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
    : 0;
  const videoLeadInFrames = scene.video
    ? Math.min(
        Math.max(0, durationInFrames - 1),
        Math.max(0, Math.round((scene.videoLeadInSeconds ?? 0) * fps)),
      )
    : 0;
  const videoFrames = scene.video
    ? Math.min(
        Math.max(0, durationInFrames - videoLeadInFrames),
        Math.max(1, Math.round((scene.videoDurationSeconds ?? 5) * fps)),
      )
    : 0;
  const showVideo = Boolean(scene.video)
    && frame >= videoLeadInFrames
    && frame < videoLeadInFrames + videoFrames;
  const stillImage = frame >= videoLeadInFrames + videoFrames
    ? scene.videoContinuationImage ?? scene.image
    : scene.image;

  if (scene.hook) {
    return <HookSceneFrame scene={scene} durationInFrames={durationInFrames} />;
  }

  return (
    <AbsoluteFill style={{...styles.scene, opacity: fade}}>
      <AbsoluteFill style={styles.imageBackgroundWrap}>
        <Img
          src={staticFile(scene.image)}
          style={{
            ...styles.imageBackground,
            transform,
            filter: `${imageFilter(scene)} blur(34px)`,
          }}
        />
      </AbsoluteFill>
      <AbsoluteFill style={styles.imageWrap}>
        {showVideo && scene.video ? (
          <Sequence from={videoLeadInFrames} layout="none">
            <OffthreadVideo
              muted
              src={staticFile(scene.video)}
              style={{
                ...styles.image,
                transform: 'none',
                filter: imageFilter(scene),
              }}
            />
          </Sequence>
        ) : (
          <Img
            src={staticFile(stillImage)}
            style={{
              ...styles.image,
              transform,
              filter: `${imageFilter(scene)} blur(${focusBlur}px)`,
            }}
          />
        )}
      </AbsoluteFill>

      <AbsoluteFill style={styles.softGrade} />
      <AbsoluteFill style={styles.vignette} />
      {documentaryFilter === 'soft_edge_lens' ? (
        <>
          <AbsoluteFill style={styles.softEdgeChromaticWrap}>
            <Img
              src={staticFile(scene.image)}
              style={{
                ...styles.image,
                transform: `${transform} translateX(-2px)`,
                filter: `${imageFilter(scene)} grayscale(1) sepia(1) saturate(2.1) hue-rotate(118deg) blur(${focusBlur + 1.4}px)`,
              }}
            />
          </AbsoluteFill>
          <AbsoluteFill style={styles.softEdgeLens} />
        </>
      ) : null}
      <FilmDamage frame={frame} scene={scene} />
      <MomentAccent scene={scene} frame={frame} durationInFrames={durationInFrames} />
      <MarkerOverlay scene={scene} frame={frame} durationInFrames={durationInFrames} textStyle={markerTextStyle} markerFont={markerFont} markerAllCaps={markerAllCaps} subtitlesEnabled={subtitlesEnabled} />
      {scene.index === 1 && showIntroPrintReveal ? <IntroPrintReveal frame={frame} /> : null}
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

const smooth = (value: number) => value * value * (3 - 2 * value);

const imageTransform = (scene: ArchiveScene, progress: number) => {
  const eased = smooth(progress);
  const zoom = scene.motion === 'pull' ? 1.034 - eased * 0.026 : 1.006 + eased * 0.028;
  const pan = 10 * (eased - 0.5);

  if (scene.motion === 'pan_left') {
    return `scale(${zoom}) translateX(${pan}px) translateY(${-eased * 3}px)`;
  }
  if (scene.motion === 'pan_right') {
    return `scale(${zoom}) translateX(${-pan}px) translateY(${-eased * 3}px)`;
  }
  if (scene.motion === 'scanner') {
    return `scale(${1.014 + eased * 0.018}) translateY(${-eased * 6}px)`;
  }
  if (scene.motion === 'drift') {
    return `scale(${1.010 + eased * 0.026}) translateX(${pan * 0.65}px)`;
  }
  return `scale(${zoom}) translateY(${scene.motion === 'slow_push' ? -eased * 5 : 0}px)`;
};

const imageFilter = (scene: ArchiveScene, frame?: number) => {
  const flicker = typeof frame === 'number' ? Math.sin(frame * 0.39 + scene.index) * 0.035 : 0;
  const contrast = scene.mode === 'dossier' ? 1.18 : 1.08;
  return `sepia(0.28) saturate(0.78) contrast(${contrast}) brightness(${0.84 + flicker})`;
};

const FilmDamage = ({frame, scene}: {frame: number; scene: ArchiveScene}) => {
  if (scene.hook) {
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
  }
  return (
    <AbsoluteFill style={styles.damage}>
      <div style={{...styles.grain, opacity: 0.075}} />
      <div style={{...styles.filmGate, opacity: 0.14}} />
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


const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

type MarkerPoint = {x: number; y: number};

const toPixelBox = (box: NonNullable<ArchiveScene['marker']>['box']) => {
  const x1 = (box.x / 100) * 1920;
  const y1 = (box.y / 100) * 1080;
  const x2 = ((box.x + box.w) / 100) * 1920;
  const y2 = ((box.y + box.h) / 100) * 1080;
  return {x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2};
};

const toPoint = (point: {x: number; y: number} | undefined, fallback: MarkerPoint) => {
  if (!point || (point.x === 0 && point.y === 0)) {
    return fallback;
  }
  return {x: (point.x / 100) * 1920, y: (point.y / 100) * 1080};
};

const labelBoxToPixels = (box?: {x: number; y: number; w: number; h: number}) => {
  if (!box || box.w <= 0 || box.h <= 0) return null;
  const x1 = (box.x / 100) * 1920;
  const y1 = (box.y / 100) * 1080;
  const x2 = ((box.x + box.w) / 100) * 1920;
  const y2 = ((box.y + box.h) / 100) * 1080;
  return {x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2};
};

const markerTextPosition = (
  text: string,
  marker: NonNullable<ArchiveScene['marker']>,
  box: ReturnType<typeof toPixelBox>,
  subtitlesEnabled: boolean,
) => {
  const approxWidth = Math.max(90, text.length * 34);
  const approxHeight = 72;
  const safeBottom = subtitlesEnabled ? 790 : 1000;
  const safeTop = 44;
  const clampLabel = (x: number, y: number) => ({
    x: clamp(x, 54, 1920 - approxWidth - 54),
    y: clamp(y, safeTop, safeBottom - approxHeight),
  });

  const visionLabel = labelBoxToPixels(marker.label_box);
  if (visionLabel) {
    return clampLabel(visionLabel.cx - approxWidth / 2, visionLabel.cy - approxHeight / 2);
  }

  if (marker.type === 'measure') {
    return clampLabel(box.cx - approxWidth / 2, box.cy - approxHeight - 24);
  }
  if (marker.type === 'arrow' || marker.type === 'circle_arrow') {
    const arrowStart = toPoint(marker.arrow_from, {x: clamp(box.x1 - 120, 70, 1850), y: clamp(box.y1 - 76, 70, 1010)});
    return clampLabel(arrowStart.x - approxWidth * 0.25, arrowStart.y - approxHeight - 18);
  }
  if (marker.type === 'underline') {
    return clampLabel(box.cx - approxWidth / 2, box.y1 - approxHeight - 18);
  }
  if (marker.type === 'bracket') {
    return clampLabel(box.x1 + 24, box.y1 - approxHeight - 18);
  }
  if (marker.type === 'word') {
    return clampLabel(box.cx - approxWidth / 2, box.cy - approxHeight / 2);
  }

  const hasRoomAbove = box.y1 - approxHeight - 46 >= safeTop;
  if (hasRoomAbove) {
    return clampLabel(box.cx - approxWidth / 2, box.y1 - approxHeight - 34);
  }
  const hasRoomBelow = box.y2 + approxHeight + 42 <= safeBottom;
  if (hasRoomBelow) {
    return clampLabel(box.cx - approxWidth / 2, box.y2 + 26);
  }
  // Huge circles often fill the frame; put the label inside but away from the stroke.
  return clampLabel(box.cx - approxWidth / 2, box.y1 + 82);
};

const hashString = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
};

const roughRandom = (seed: number) => {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
};

const roughJitter = (seed: number, amount: number) => (roughRandom(seed) * 2 - 1) * amount;

const roughLinePath = (from: MarkerPoint, to: MarkerPoint, seed: number, progress: number, curve = true) => {
  if (progress <= 0) return '';
  const steps = 44;
  const visible = Math.max(2, Math.ceil(steps * clamp(progress, 0, 1)));
  const mid = {
    x: (from.x + to.x) / 2 + (curve ? roughJitter(seed + 11, 28) : 0),
    y: (from.y + to.y) / 2 + (curve ? roughJitter(seed + 23, 18) : 0),
  };
  const points: MarkerPoint[] = [];
  for (let i = 0; i < visible; i++) {
    const t = i / Math.max(1, steps - 1);
    const x = curve
      ? (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * mid.x + t * t * to.x
      : from.x + (to.x - from.x) * t;
    const y = curve
      ? (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * mid.y + t * t * to.y
      : from.y + (to.y - from.y) * t;
    points.push({x: x + roughJitter(seed + i * 5, 1.65), y: y + roughJitter(seed + i * 7, 1.65)});
  }
  return `M ${points.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' L ')}`;
};

const roughEllipsePath = (box: ReturnType<typeof toPixelBox>, seed: number, progress: number, padX = 22, padY = 22) => {
  if (progress <= 0) return '';
  const total = 176;
  const visible = Math.max(3, Math.ceil(total * clamp(progress, 0, 1)));
  const rx = Math.max(34, (box.x2 - box.x1) / 2 + padX);
  const ry = Math.max(28, (box.y2 - box.y1) / 2 + padY);
  const points: MarkerPoint[] = [];
  for (let i = 0; i < visible; i++) {
    const angle = -Math.PI / 2 + (Math.PI * 2 * i) / total + roughJitter(seed + i * 3, 0.0025);
    const wobbleX = 1 + roughJitter(seed + i * 13, 0.006);
    const wobbleY = 1 + roughJitter(seed + i * 17, 0.006);
    points.push({
      x: box.cx + Math.cos(angle) * rx * wobbleX + roughJitter(seed + i * 19, 0.45),
      y: box.cy + Math.sin(angle) * ry * wobbleY + roughJitter(seed + i * 29, 0.45),
    });
  }
  const close = progress > 0.995 ? ' Z' : '';
  return `M ${points.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' L ')}${close}`;
};

const MarkerOverlay = ({
  scene,
  frame,
  durationInFrames,
  textStyle,
  markerFont,
  markerAllCaps,
  subtitlesEnabled,
}: {
  scene: ArchiveScene;
  frame: number;
  durationInFrames: number;
  textStyle?: ArchiveData['markerTextStyle'];
  markerFont: NonNullable<ArchiveData['markerFont']>;
  markerAllCaps: boolean;
  subtitlesEnabled: boolean;
}) => {
  const marker = scene.marker;
  if (!marker || scene.hook) {
    return null;
  }
  const draw = interpolate(frame, [5, 24], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const fadeOut = interpolate(frame, [Math.max(0, durationInFrames - 10), durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const opacity = Math.min(1, interpolate(frame, [3, 14], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})) * fadeOut;
  const box = toPixelBox(marker.box);
  const start = toPoint(marker.arrow_from, {x: clamp(box.x1 - 120, 70, 1850), y: clamp(box.y1 - 76, 70, 1010)});
  const end = toPoint(marker.arrow_to, {x: box.cx, y: box.cy});
  const stroke = 'rgba(187, 0, 0, 0.56)';
  const strokeStrong = 'rgba(192, 0, 0, 0.64)';
  const text = (marker.text ?? '').trim();
  const textPos = markerTextPosition(text, marker, box, subtitlesEnabled);
  const sketchPhase = Math.floor(frame / 2);
  const sceneSeed = scene.index * 1009 + sketchPhase * 41;

  const roughLine = (from: MarkerPoint, to: MarkerPoint, key: string, strong = false, curve = true, lineProgress = draw) => {
    const baseSeed = sceneSeed + hashString(key) * 7;
    return (
      <g key={key} stroke={strong ? strokeStrong : stroke} strokeLinecap="round" fill="none">
        {[0, 1, 2].map((pass) => (
          <path
            key={`${key}-${pass}`}
            d={roughLinePath(from, to, baseSeed + pass * 307, lineProgress, curve)}
            strokeWidth={Math.max(2, (strong ? 7 : 6) - pass)}
            opacity={pass === 0 ? 1 : 0.34}
          />
        ))}
      </g>
    );
  };

  const roughEllipse = (key: string, padX = 28, padY = 28, ellipseProgress = draw) => {
    const baseSeed = sceneSeed + hashString(key) * 11;
    return (
      <g key={key} stroke={stroke} strokeLinecap="round" fill="none">
        {[0, 1, 2].map((pass) => (
          <path
            key={`${key}-${pass}`}
            d={roughEllipsePath(box, baseSeed + pass * 503, ellipseProgress, padX - pass * 8, padY - pass * 8)}
            strokeWidth={Math.max(2, 6 - pass)}
            opacity={pass === 0 ? 1 : 0.2}
          />
        ))}
      </g>
    );
  };

  const arrowHead = (from: MarkerPoint, to: MarkerPoint, key = 'arrow-head') => {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const left = {x: to.x + Math.cos(angle + 2.55) * 48, y: to.y + Math.sin(angle + 2.55) * 48};
    const right = {x: to.x + Math.cos(angle - 2.55) * 48, y: to.y + Math.sin(angle - 2.55) * 48};
    return (
      <>
        {roughLine(to, left, `${key}-left`, true, false, 1)}
        {roughLine(to, right, `${key}-right`, true, false, 1)}
      </>
    );
  };

  const markerShape = () => {
    if (marker.type === 'arrow') {
      return (
        <g>
          {roughLine(start, end, 'arrow-main', true, true)}
          {draw > 0.82 ? arrowHead(start, end) : null}
        </g>
      );
    }
    if (marker.type === 'measure') {
      return (
        <g>
          {roughLine({x: box.x1, y: box.cy}, {x: box.x2, y: box.cy}, 'measure-main', true, false)}
          {draw > 0.82 ? roughLine({x: box.x1, y: box.cy - 42}, {x: box.x1, y: box.cy + 42}, 'measure-left', true, false, 1) : null}
          {draw > 0.82 ? roughLine({x: box.x2, y: box.cy - 42}, {x: box.x2, y: box.cy + 42}, 'measure-right', true, false, 1) : null}
        </g>
      );
    }
    if (marker.type === 'bracket') {
      const edge = 58;
      return (
        <g>
          {roughLine({x: box.x1, y: box.y1}, {x: box.x1 + edge, y: box.y1}, 'b1', true, false)}
          {roughLine({x: box.x1, y: box.y1}, {x: box.x1, y: box.y2}, 'b2', true, false)}
          {roughLine({x: box.x1, y: box.y2}, {x: box.x1 + edge, y: box.y2}, 'b3', true, false)}
          {roughLine({x: box.x2, y: box.y1}, {x: box.x2 - edge, y: box.y1}, 'b4', true, false)}
          {roughLine({x: box.x2, y: box.y1}, {x: box.x2, y: box.y2}, 'b5', true, false)}
          {roughLine({x: box.x2, y: box.y2}, {x: box.x2 - edge, y: box.y2}, 'b6', true, false)}
        </g>
      );
    }
    if (marker.type === 'underline') {
      return roughLine({x: box.x1, y: box.y2 + 22}, {x: box.x2, y: box.y2 + 22}, 'underline', true, false);
    }
    if (marker.type === 'word') {
      return null;
    }
    return (
      <g>
        {roughEllipse('circle-primary', 22, 22)}
        {marker.type === 'circle_arrow' && draw > 0.18 ? (
          <g>
            {roughLine(start, end, 'circle-arrow-main', true, true)}
            {draw > 0.82 ? arrowHead(start, end, 'circle-arrow-head') : null}
          </g>
        ) : null}
      </g>
    );
  };

  const textOpacity = interpolate(frame, [12, 28], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const textJitterX = roughJitter(sceneSeed + 701, 1.25);
  const textJitterY = roughJitter(sceneSeed + 907, 1.0);

  return (
    <AbsoluteFill style={{...styles.markerLayer, opacity}}>
      <svg viewBox="0 0 1920 1080" width="100%" height="100%" style={styles.markerSvg}>
        {markerShape()}
      </svg>
      {text ? (
        <div
          style={{
            ...(textStyle === 'harsh_black' ? styles.markerTextHarshBlack : styles.markerTextSmallRed),
            fontFamily: `${MARKER_FONT_FAMILIES[markerFont]}, ${MULTILINGUAL_FALLBACK_STACK}`,
            textTransform: markerAllCaps ? 'uppercase' : 'lowercase',
            left: textPos.x,
            top: textPos.y,
            opacity: textOpacity * (0.92 + roughRandom(sceneSeed + 337) * 0.08),
            transform: `translate(${textJitterX}px, ${textJitterY}px)`,
          }}
        >
          {text}
        </div>
      ) : null}
    </AbsoluteFill>
  );
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
    fontFamily: `Georgia, Times New Roman, ${MULTILINGUAL_FALLBACK_STACK}`,
  },
  evidenceIntroStage: {
    backgroundColor: '#080706',
    overflow: 'hidden',
  },
  evidenceIntroScene: {
    overflow: 'hidden',
  },
  evidenceIntroImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    transformOrigin: 'center center',
  },
  evidenceSoftEdgeWrap: {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    pointerEvents: 'none',
    WebkitMaskImage:
      'linear-gradient(90deg, black 0%, rgba(0,0,0,0.72) 8%, transparent 27%, transparent 73%, rgba(0,0,0,0.72) 92%, black 100%)',
    maskImage:
      'linear-gradient(90deg, black 0%, rgba(0,0,0,0.72) 8%, transparent 27%, transparent 73%, rgba(0,0,0,0.72) 92%, black 100%)',
  },
  introWhiteFlash: {
    backgroundColor: 'white',
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
  imageBackgroundWrap: {
    inset: 0,
    overflow: 'hidden',
    backgroundColor: '#080706',
  },
  imageBackground: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    transformOrigin: 'center center',
    opacity: 0.64,
  },
  image: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    transformOrigin: 'center center',
  },
  softEdgeChromaticWrap: {
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    opacity: 0.075,
    mixBlendMode: 'screen',
    WebkitMaskImage:
      'radial-gradient(ellipse at center, transparent 0%, transparent 76%, rgba(0,0,0,0.18) 84%, rgba(0,0,0,0.72) 94%, black 100%)',
    maskImage:
      'radial-gradient(ellipse at center, transparent 0%, transparent 76%, rgba(0,0,0,0.18) 84%, rgba(0,0,0,0.72) 94%, black 100%)',
  },
  softEdgeLens: {
    background:
      'radial-gradient(ellipse at center, transparent 0%, transparent 75%, rgba(0,0,0,0.025) 82%, rgba(0,0,0,0.14) 93%, rgba(3,7,8,0.42) 100%)',
    boxShadow: 'inset 0 0 42px rgba(0,0,0,0.16)',
    pointerEvents: 'none',
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
  markerLayer: {
    pointerEvents: 'none',
    zIndex: 7,
  },
  markerSvg: {
    position: 'absolute',
    inset: 0,
    overflow: 'visible',
  },
  markerTextSmallRed: {
    position: 'absolute',
    color: 'rgba(187,0,0,0.58)',
    fontSize: 58,
    fontWeight: 500,
    letterSpacing: 1.2,
    lineHeight: 1,
    mixBlendMode: 'multiply',
    filter: 'blur(0.2px)',
  },
  markerTextHarshBlack: {
    position: 'absolute',
    color: 'rgba(17,14,12,0.74)',
    fontSize: 66,
    fontWeight: 700,
    letterSpacing: 1,
    lineHeight: 1,
    mixBlendMode: 'multiply',
    filter: 'blur(0.35px)',
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
    fontFamily: `Menlo, Monaco, ${MULTILINGUAL_FALLBACK_STACK}`,
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
    fontFamily: `Menlo, Monaco, ${MULTILINGUAL_FALLBACK_STACK}`,
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
    fontFamily: `Georgia, Times New Roman, ${MULTILINGUAL_FALLBACK_STACK}`,
    fontSize: 44,
    lineHeight: 1.14,
    textAlign: 'center',
    textShadow: '0 3px 16px rgba(0,0,0,0.92), 0 0 2px rgba(0,0,0,0.8)',
    backgroundColor: 'rgba(3,2,1,0.28)',
    borderRadius: 4,
  },
};
