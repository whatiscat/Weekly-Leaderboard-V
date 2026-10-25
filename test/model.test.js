import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDataset } from '../src/model/build.js';
import { championRuns, songIndex, summarize } from '../src/model/stats.js';

const config = {
  account: { name: 'T', mid: '1', spaceUrl: 'https://space.bilibili.com/1' },
  render: { title: 'T', brand: 'T' }
};

function issue(id, date, week = 1, bvid = 'BVvideo' + id) {
  return { id, board_id: 1, issue_id: id, year: 2025, week, end_date: Math.floor(date / 1000), video_pubdate: Math.floor(date / 1000), video_bvid: bvid, video_count: 20 };
}
function hist(issueId, rank, bvid, title, titleCn) {
  return { boardId: 1, issueId, rank, bvid, title, titleCn, producers: [{ id: 1, name: 'P' }], vocalists: [{ id: 2, name: 'V' }], weeksOnBoard: 1, peakRank: rank };
}
function song(id, title, titleCn, history) {
  return { id, bvid: history[0]?.bvid || '', title, titleCn, producers: [{ id: 1, name: 'P' }], vocalists: [{ id: 2, name: 'V' }], history };
}
function post(issueId, date, entries) {
  return {
    id: 'dyn' + issueId,
    cv: 100 + issueId,
    title: 'Bili_Board术力口周榜第' + issueId + '期2025年6月' + date + '日第1周',
    pubTs: 1750000000 + issueId,
    entries: entries.map((e, i) => ({ rank: i + 1, title: e.t, url: 'https://www.bilibili.com/video/' + e.bv, cover: '' }))
  };
}

test('buildDataset 用官方期次 + 曲目历史构建，并按曲目 ID 归并', () => {
  const boards = {
    issues: { weekly: [issue(1, 1750000000000), issue(2, 1750600000000)], legend: [] },
    songs: [
      song(11, 'A', '甲', [hist(1, 1, 'BV1a', 'A', '甲'), hist(2, 2, 'BV1a', 'A', '甲')]),
      song(22, 'B', '乙', [hist(1, 2, 'BV1b', 'B', '乙')])
    ]
  };
  const ds = buildDataset([], boards, config);
  assert.equal(ds.issues.length, 2);
  assert.equal(ds.issues[0].entries[0].songId, 11);
  assert.equal(ds.issues[1].entries[0].songId, 11);
  assert.equal(ds.issues[1].entries[0].rank, 2);
  assert.equal(ds.stats.songs, 2);
});

test('同一首歌换译名 / 换稿件仍是一条记录', () => {
  const boards = {
    issues: { weekly: [issue(1, 1750000000000), issue(2, 1750600000000)], legend: [] },
    songs: [
      song(11, 'Original', '甲', [
        hist(1, 3, 'BV1old', 'Original', '甲的旧译名'),
        hist(2, 5, 'BV1new', 'Original', '甲')
      ])
    ]
  };
  const ds = buildDataset([], boards, config);
  const idx = songIndex(ds.issues);
  assert.equal(idx.length, 1);
  assert.equal(idx[0].weeks, 2);
  assert.deepEqual(idx[0].variants.sort(), ['BV1new', 'BV1old']);
});

test('同名不同曲按 songId 分开', () => {
  const boards = {
    issues: { weekly: [issue(1, 1750000000000)], legend: [] },
    songs: [
      song(11, 'nan', 'nan', [hist(1, 1, 'BV1a', 'nan', 'nan')]),
      song(22, 'nan', 'nan', [hist(1, 2, 'BV1b', 'nan', 'nan')])
    ]
  };
  const ds = buildDataset([], boards, config);
  assert.equal(ds.issues[0].entries.length, 2);
  assert.equal(new Set(ds.issues[0].entries.map((e) => e.songId)).size, 2);
});

test('官方数据与帖子稿件不一致时记录到对齐报告', () => {
  const boards = {
    issues: { weekly: [issue(1, 1750000000000)], legend: [] },
    songs: [song(11, 'A', '甲', [hist(1, 1, 'BVofficial', 'A', '甲')])]
  };
  const posts = [post(1, '11', [{ t: '甲', bv: 'BVpost' }])];
  const ds = buildDataset(posts, boards, config);
  assert.equal(ds.meta.alignment.issues, 1);
  assert.equal(ds.meta.alignment.ranks, 1);
  assert.equal(ds.meta.alignment.bvidMismatch, 1);
  assert.equal(ds.alignment[0].post, 'BVpost');
});

test('championRuns 按 songId 合并连冠', () => {
  const boards = {
    issues: { weekly: [issue(1, 1750000000000), issue(2, 1750600000000), issue(3, 1751200000000)], legend: [] },
    songs: [
      song(11, 'A', '甲', [hist(1, 1, 'BV1a', 'A', '甲'), hist(2, 1, 'BV1a', 'A', '甲')]),
      song(22, 'B', '乙', [hist(3, 1, 'BV1b', 'B', '乙')])
    ]
  };
  const ds = buildDataset([], boards, config);
  const runs = championRuns(ds.issues);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].count, 2);
  assert.equal(runs[1].title, '乙');
});

test('summarize 统计期数/条目/曲目', () => {
  const boards = {
    issues: { weekly: [issue(1, 1750000000000), issue(2, 1750600000000)], legend: [] },
    songs: [
      song(11, 'A', '甲', [hist(1, 1, 'BV1a', 'A', '甲')]),
      song(22, 'B', '乙', [hist(1, 2, 'BV1b', 'B', '乙'), hist(2, 1, 'BV1b', 'B', '乙')])
    ]
  };
  const ds = buildDataset([], boards, config);
  const s = summarize(ds.issues);
  assert.equal(s.issues, 2);
  assert.equal(s.entries, 3);
  assert.equal(s.songs, 2);
  assert.equal(s.mostTitles.count, 1);
});
