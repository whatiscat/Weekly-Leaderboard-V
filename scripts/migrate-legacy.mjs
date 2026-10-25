#!/usr/bin/env node
/**
 * 把上一版 _tools/ 下的抓取缓存迁移为 data/raw/<id>.json
 * 只跑一次；迁移后可删除 _tools/（脚本、缓存仍在 git 之外可保留）
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from '../src/config.js';
import { parseArticleHtml, parseOpusItem } from '../src/crawler/parse.js';
import { writeJson, ensureDir } from '../src/util/fsx.js';

const cfg = loadConfig();
const T = path.join(ROOT, '_tools');
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const index = read(path.join(T, 'index.json')) || [];
console.log('legacy index:', index.length);

const outDir = cfg.paths.raw;
ensureDir(outDir);

let written = 0;
const skipped = [];

for (const row of index) {
  const id = row.id;
  const record = {
    id,
    title: row.title || '',
    cv: row.cv || null,
    type: row.type || '',
    pubTs: row.ts || 0,
    pubTime: row.pub || '',
    entries: [],
    source: '',
    payload: null,
    warnings: [],
    fetchedAt: new Date().toISOString(),
    migratedFrom: 'legacy'
  };

  // 1) opus 详情
  const detail = read(path.join(T, 'detail', id + '.json'));
  const parsed = detail ? parseOpusItem(detail) : null;
  if (parsed?.entries?.length) {
    record.entries = parsed.entries;
    record.source = 'opus';
    record.payload = { kind: 'paragraphs', data: parsed.paragraphs };
    if (!record.pubTs && parsed.pubTs) record.pubTs = parsed.pubTs;
  }

  // 2) 专栏接口缓存
  if (!record.entries.length && row.cv) {
    const api = read(path.join(T, 'api', String(row.cv) + '.json'));
    if (api?.content) {
      const entries = parseArticleHtml(api.content);
      if (entries.length) {
        record.entries = entries;
        record.source = 'article';
        record.payload = { kind: 'html', data: api.content };
        if (api.title && !record.title) record.title = api.title;
      }
    }
  }

  // 3) SSR 预解析结果
  if (!record.entries.length) {
    const arts = read(path.join(T, 'arts', id + '.json'));
    if (arts?.ranks?.length) {
      record.entries = arts.ranks.map((r) => ({ rank: r.rank, title: r.title, url: r.url || '', cover: r.cover || '' }));
      record.source = 'ssr-parsed';
    }
  }

  if (!record.entries.length) {
    skipped.push({ id, title: record.title });
    continue;
  }
  writeJson(path.join(outDir, id + '.json'), record);
  written++;
}

console.log('written:', written, 'skipped:', skipped.length);
if (skipped.length) console.log('skipped ids:', skipped.map((s) => s.id).join(', '));
