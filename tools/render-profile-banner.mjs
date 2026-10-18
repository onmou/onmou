import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ffmpegPath from 'ffmpeg-static';
import { convertBuffer } from '@visioncortex/vtracer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputVideo = path.resolve(process.argv[2] ?? process.env.INPUT_VIDEO ?? 'input.mp4');
const workDir = path.join(repoRoot, 'work', 'profile-banner');
const assetsDir = path.join(repoRoot, 'assets');

const gifWidth = 1280;
const gifFps = 24;
const svgWidth = 720;
const svgFps = 12;
const svgOptions = {
  preset: 'poster',
  mode: 'polygon',
  hierarchical: 'cutout',
  maxColors: 12,
  simplify: 1.5,
  pathPrecision: 1,
  optimize: 2,
  filterSpeckle: 4,
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(command)} exited with ${code}\n${stderr}`));
      }
    });
  });
}

function innerSvg(svg) {
  const match = svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i);
  if (!match) {
    throw new Error('VTracer returned an unexpected SVG document');
  }
  return match[1];
}

function frameAnimation(index, frameCount, duration) {
  const start = index / frameCount;
  const end = (index + 1) / frameCount;
  const epsilon = 0.000001;

  if (index === 0) {
    return `<animate attributeName="opacity" dur="${duration}s" repeatCount="indefinite" calcMode="discrete" values="1;1;0" keyTimes="0;${end};1"/>`;
  }
  if (index === frameCount - 1) {
    return `<animate attributeName="opacity" dur="${duration}s" repeatCount="indefinite" calcMode="discrete" values="0;1;1" keyTimes="0;${start};1"/>`;
  }
  return `<animate attributeName="opacity" dur="${duration}s" repeatCount="indefinite" calcMode="discrete" values="0;1;1;0" keyTimes="0;${start};${end};1"/>`;
}

async function main() {
  const frameDir = path.join(workDir, 'frames');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(frameDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });

  const gifPath = path.join(assetsDir, 'profile-banner-hd.gif');
  const svgPath = path.join(assetsDir, 'profile-banner.svg');

  await run(ffmpegPath, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputVideo,
    '-filter_complex',
    `[0:v]fps=${gifFps},scale=${gifWidth}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    '-loop',
    '0',
    '-an',
    gifPath,
  ]);

  await run(ffmpegPath, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputVideo,
    '-vf',
    `fps=${svgFps},scale=${svgWidth}:-2:flags=lanczos,format=rgba`,
    path.join(frameDir, 'frame-%04d.png'),
  ]);

  const frames = (await readdir(frameDir))
    .filter((name) => name.endsWith('.png'))
    .sort();
  if (frames.length === 0) {
    throw new Error('FFmpeg produced no frames');
  }

  const duration = (frames.length / svgFps).toFixed(6);
  const vectorFrames = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frameBuffer = await readFile(path.join(frameDir, frames[index]));
    const traced = convertBuffer(frameBuffer, svgOptions);
    vectorFrames.push(
      `<g id="frame-${String(index + 1).padStart(4, '0')}" opacity="${index === 0 ? '1' : '0'}">${innerSvg(traced)}${frameAnimation(index, frames.length, duration)}</g>`,
    );
    if ((index + 1) % 12 === 0 || index === frames.length - 1) {
      console.log(`vectorized ${index + 1}/${frames.length} frames`);
    }
  }

  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${Math.round((svgWidth * 9) / 16)}" role="img" aria-labelledby="title desc">`,
    '<title id="title">Animated profile banner</title>',
    '<desc id="desc">A blue and cyan network mark moving through a dark space.</desc>',
    ...vectorFrames,
    '</svg>',
    '',
  ].join('\n');
  await writeFile(svgPath, svg, 'utf8');

  console.log(`wrote ${gifPath}`);
  console.log(`wrote ${svgPath}`);
  console.log(`gif=${gifWidth}px/${gifFps}fps svg=${svgWidth}px/${svgFps}fps frames=${frames.length} duration=${duration}s`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? error);
  process.exitCode = 1;
});
