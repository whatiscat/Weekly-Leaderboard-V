import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = deepMerge(base?.[k], v);
  }
  return out;
}

export function loadConfig(overrides = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/default.json'), 'utf8'));
  const localPath = path.join(ROOT, 'config/local.json');
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  const cfg = deepMerge(deepMerge(base, local), overrides);

  const p = cfg.paths;
  for (const key of Object.keys(p)) {
    p[key] = path.isAbsolute(p[key]) ? p[key] : path.join(ROOT, p[key]);
  }
  cfg.paths.public = path.join(ROOT, 'public');
  cfg.paths.assets = path.join(ROOT, 'src/render/assets');
  cfg.paths.template = path.join(ROOT, 'src/render/template.html');
  return cfg;
}
