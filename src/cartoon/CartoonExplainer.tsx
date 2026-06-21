import React from 'react';
import {AbsoluteFill, Audio, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import type {CaptionChunk, CartoonData, CartoonScene} from './types';

type Props = {data: CartoonData};
type SubtitleTransition = 'current' | 'fast' | 'none';

const fitText = (text: string, max = 72) => {
  const len = text.length;
  if (len > max) return 50;
  if (len > 48) return 58;
  if (len > 32) return 68;
  return 82;
};

const secondsToFrame = (seconds: number | undefined, fps: number) => Math.max(0, Math.round((seconds ?? 0) * fps));

const fallbackCaptionChunks = (scene: CartoonScene, durationFrames: number, fps: number): CaptionChunk[] => {
  const words = (scene.text || scene.subtitle || scene.headline || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const groups: string[] = [];
  for (let i = 0; i < words.length; i += 4) {
    groups.push(words.slice(i, i + 4).join(' '));
  }
  const durationSeconds = Math.max(0.35, durationFrames / fps);
  return groups.map((text, index) => ({
    start: (index / groups.length) * durationSeconds,
    end: ((index + 1) / groups.length) * durationSeconds,
    text,
  }));
};

const activeCaption = (chunks: CaptionChunk[], localFrame: number, fps: number) => {
  const localSeconds = Math.max(0, localFrame / fps);
  return chunks.find((chunk) => localSeconds >= chunk.start && localSeconds < chunk.end);
};

const SceneFrame: React.FC<{scene: CartoonScene; start: number; end: number; subtitlesEnabled: boolean; subtitleTransition: SubtitleTransition}> = ({scene, start, end, subtitlesEnabled, subtitleTransition}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const local = frame - start;
  const dur = Math.max(1, end - start);
  const image = scene.approved !== false && scene.image_path ? scene.image_path : '';
  const zoom = interpolate(local, [0, dur], [1.015, 1.055], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const opacity = interpolate(local, [0, 10, Math.max(12, dur - 10), dur], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const chunks = scene.caption_chunks?.length ? scene.caption_chunks : fallbackCaptionChunks(scene, dur, fps);
  const caption = activeCaption(chunks, local, fps);
  const captionStart = secondsToFrame(caption?.start, fps);
  const captionEnd = secondsToFrame(caption?.end, fps);
  const captionLocal = local - captionStart;
  const captionDur = Math.max(8, captionEnd - captionStart);
  const isFast = subtitleTransition === 'fast';
  const hasTransition = subtitleTransition !== 'none';
  const transitionFrames = isFast ? 2 : 5;
  const motionFrames = isFast ? 3 : 7;
  const subtitleY = hasTransition ? interpolate(captionLocal, [0, motionFrames], [isFast ? 5 : 10, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : 0;
  const subtitleScale = hasTransition ? interpolate(captionLocal, [0, isFast ? 3 : 6], [isFast ? 0.98 : 0.94, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : 1;
  const subtitleOpacity = hasTransition
    ? interpolate(captionLocal, [0, transitionFrames, Math.max(transitionFrames + 1, captionDur - transitionFrames), captionDur], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
    : 1;
  const subtitle = subtitlesEnabled ? (caption?.text || '').trim() : '';
  const subtitleWords = subtitle.split(/\s+/).filter(Boolean);
  const emphasisWord = subtitleWords[subtitleWords.length - 1] || '';
  const leadWords = subtitleWords.slice(0, -1).join(' ');

  if (image) {
    return (
      <AbsoluteFill style={{opacity, backgroundColor: '#f8f5ec'}}>
        <Img
          src={staticFile(image)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            transform: `scale(${zoom})`,
            filter: 'saturate(1.02) contrast(1.02)',
          }}
        />
        {subtitle ? (
          <div className="kineticSubtitle" style={{opacity: subtitleOpacity, transform: `translateX(-50%) translateY(${subtitleY}px) scale(${subtitleScale})`}}>
            {leadWords ? <div className="kineticSubtitleLead">{leadWords}</div> : null}
            <div className="kineticSubtitleEmphasis">{emphasisWord}</div>
          </div>
        ) : null}
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{opacity}} className="titleScene">
      <div className="titleText" style={{fontSize: fitText(scene.headline)}}>{scene.headline}</div>
      <div className="titleRule" />
    </AbsoluteFill>
  );
};

export const CartoonExplainer: React.FC<Props> = ({data}) => {
  const {durationInFrames, fps} = useVideoConfig();
  const scenes = data.scenes.length ? data.scenes : [{id: 1, headline: data.stem, text: '', prompt: ''}];
  const channelName = data.channel_name || 'Cartoon Explainer';
  const subtitlesEnabled = data.subtitles_enabled !== false;
  const subtitleTransition: SubtitleTransition = data.subtitle_transition || 'current';
  const fallbackDur = Math.max(45, Math.ceil(durationInFrames / scenes.length));

  return (
    <AbsoluteFill className="stage">
      {data.audio ? <Audio src={staticFile(data.audio)} /> : null}
      <div className="channelBug"><span className="channelDot" />{channelName}</div>
      {scenes.map((scene, index) => {
        const hasTiming = typeof scene.start === 'number' && typeof scene.end === 'number' && scene.end > scene.start;
        const start = hasTiming ? secondsToFrame(scene.start, fps) : index * fallbackDur;
        const next = scenes[index + 1];
        const timedEnd = hasTiming ? secondsToFrame(scene.end, fps) : Math.min(durationInFrames, start + fallbackDur + 8);
        const nextStart = typeof next?.start === 'number' ? secondsToFrame(next.start, fps) : timedEnd;
        const end = Math.min(durationInFrames, Math.max(start + 20, Math.min(timedEnd, nextStart || timedEnd)));
        return start < durationInFrames ? <SceneFrame key={scene.id ?? index} scene={scene} start={start} end={end} subtitlesEnabled={subtitlesEnabled} subtitleTransition={subtitleTransition} /> : null;
      })}
      <div className="paperTexture" />
    </AbsoluteFill>
  );
};
