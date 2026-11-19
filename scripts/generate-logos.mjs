import sharp from 'sharp';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const IMAGES = resolve(ROOT, 'public/images');

const faviconSvg = readFileSync(resolve(ROOT, 'public/favicon.svg'));
const croppedSvg = readFileSync(resolve(ROOT, 'public/favicon-cropped.svg'));

// White version of the cropped SVG
const whiteSvg = Buffer.from(
  readFileSync(resolve(ROOT, 'public/favicon-cropped.svg'), 'utf8')
    .replace('#16a34a', '#ffffff')
);

async function generate() {
  // 2048 variants
  await sharp(faviconSvg, { density: 150 })
    .resize(2048, 2048)
    .flatten({ background: '#ffffff' })
    .png()
    .toFile(resolve(IMAGES, 'aiyelet-logo-2048.png'));
  console.log('✓ aiyelet-logo-2048.png');

  await sharp(faviconSvg, { density: 150 })
    .resize(2048, 2048)
    .png()
    .toFile(resolve(IMAGES, 'aiyelet-logo-2048-transparent.png'));
  console.log('✓ aiyelet-logo-2048-transparent.png');

  await sharp(croppedSvg, { density: 150 })
    .resize(2048, 2048)
    .png()
    .toFile(resolve(IMAGES, 'aiyelet-logo-2048-cropped.png'));
  console.log('✓ aiyelet-logo-2048-cropped.png');

  await sharp(whiteSvg, { density: 150 })
    .resize(2048, 2048)
    .png()
    .toFile(resolve(IMAGES, 'aiyelet-logo-2048-white-transparent.png'));
  console.log('✓ aiyelet-logo-2048-white-transparent.png');

  // Smaller sizes from the padded favicon (white bg for icons)
  const sizes = [1024, 512, 192, 180, 32, 16];
  for (const size of sizes) {
    await sharp(faviconSvg, { density: 150 })
      .resize(size, size)
      .flatten({ background: '#ffffff' })
      .png()
      .toFile(resolve(IMAGES, `aiyelet-logo-${size}.png`));
    console.log(`✓ aiyelet-logo-${size}.png`);
  }

  console.log('\nDone! All logos regenerated with #16a34a');
}

generate().catch(console.error);
