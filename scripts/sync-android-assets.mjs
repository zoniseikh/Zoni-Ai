import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const androidAssetsDir = path.join(rootDir, 'android', 'app', 'src', 'main', 'assets', 'public');

if (!fs.existsSync(distDir)) {
  console.error('[sync-android-assets] dist/ folder not found. Run `npm run build` first.');
  process.exit(1);
}

fs.rmSync(androidAssetsDir, { recursive: true, force: true });
fs.mkdirSync(androidAssetsDir, { recursive: true });
fs.cpSync(distDir, androidAssetsDir, {
  recursive: true,
  force: true,
  filter: (src) => {
    const rel = path.relative(distDir, src).replace(/\\/g, '/');
    return rel !== 'assets/aistudio' && !rel.startsWith('assets/aistudio/');
  },
});

console.log(`[sync-android-assets] Synced original Zoni AI React dashboard from dist/ -> ${path.relative(rootDir, androidAssetsDir)}`);
