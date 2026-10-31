import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildDataset } from '../src/model/build.js';
import { checkIssues } from '../src/biliboard/validate.js';
import { syncBoards } from '../src/biliboard/sync.js';
import { Repository } from '../src/server/repository.js';
import { readJson, writeJson } from '../src/util/fsx.js';

const config = {
  account: { name: 'T', mid: '1', spaceUrl: 'https://space.bilibili.com/1' },
  site: { title: 'T', brand: 'T', csvName: 'T.csv' }
};

const DAY = 86400;

function issue(id, boardId = 1, { year = 2026, week = id, count = 20, base = 1760000000 } = {}) {
  return {
    id, board_id: boardId, issue_id: id, year, week, video_count: count,
    end_date: base + id * 7 * DAY, video_pubdate: base + id * 7 * DAY + 2 * DAY,
    video_bvid: 'BVboard' + boardId + 'x' + id
  };
}

function hist(boardId, issueId, rank, bvid) {
  return {
    boardId, issueId, year: 2026, week: issueId, rank, bvid,
    producers: [{ id: 1, name: 'P' }], vocalists: [{ id: 2, name: 'V' }],
    weeksOnBoard: 1, peakRank: rank
  };
}

/** 曲目（本项目精简过的形状）。行上的曲名从曲目主记录补齐，和 rowOf() 的做法一致 */
function song(id, title, titleCn, history) {
  const rows = history.map((h) => ({ ...h, title, titleCn }));
  return {
    id, bvid: rows[0]?.bvid || '', title, titleCn,
    producers: [{ id: 1, name: 'P' }], vocalists: [{ id: 2, name: 'V' }],
    history: rows
  };
}

/** 上游曲目库的形状（sync 吃进去的是这个：history 字段叫 rank_history） */
function upstreamSong(id, title, titleCn, history) {
  return {
    id, bvid: '', title, title_cn: titleCn, pubtime: 0, first_recorded_at: 0,
    producers: [{ id: 1, name: 'P' }], vocalists: [{ id: 2, name: 'V' }],
    rank_history: history.map((h) => ({
      board_id: h.boardId, issue_id: h.issueId, year: 2026, week: h.issueId, rank: h.rank,
      bvid: h.bvid, title, title_cn: titleCn,
      producers: [{ id: 1, name: 'P' }], vocalists: [{ id: 2, name: 'V' }],
      pubtime: 0, stats: null, score_ratio_text: null,
      last_rank: null, weeks_on_board: 1, peak_rank: h.rank, rank_change: null, special_status: null
    }))
  };
}

/* ------------------------------------------------------------------ */
/* 附榜的数据形状                                                       */
/* ------------------------------------------------------------------ */

test('传说曲周榜 / 年榜各自成表，期号独立、不混用周榜期次', () => {
  const boards = {
    issues: {
      weekly: [issue(1), issue(2)],
      legend: [issue(7, 2), issue(8, 2)],
      annual: []
    },
    songs: [
      song(11, 'A', '甲', [hist(1, 1, 1, 'BVw1'), hist(1, 2, 3, 'BVw2'), hist(2, 7, 2, 'BVl7'), hist(2, 8, 1, 'BVl8'), hist(3, 1, 9, 'BVa1')]),
      song(33, 'C', '丙', [hist(3, 2, 2, 'BVa2')])
    ]
  };
  const ds = buildDataset([], boards, config);

  assert.equal(ds.issues.length, 2);
  assert.equal(ds.legend.length, 2);
  assert.equal(ds.annual.length, 2);

  // 期号是各榜自己的：传说曲榜是 7、8 期，不是周榜的 1、2 期
  assert.deepEqual(ds.legend.map((x) => x.issue), [7, 8]);
  assert.deepEqual(ds.annual.map((x) => x.issue), [1, 2]);
  assert.equal(ds.legend[1].entries[0].titleCn, '甲');
  assert.equal(ds.legend[1].entries[0].rank, 1);

  // 年榜没有独立期次表（issues-3.json 缺失）时，用曲目行里的 year/week 拼一个最简表
  assert.equal(ds.annual[1].year, 2026);
  assert.equal(ds.annual[1].date, null);
  assert.equal(ds.annual[1].declared, null);
  assert.equal(ds.annual[1].count, 1);

  assert.deepEqual(ds.meta.boards.legend, { issues: 2, first: 7, last: 8, entries: 2 });
  assert.deepEqual(ds.meta.boards.annual, { issues: 2, first: 1, last: 2, entries: 2 });
  assert.equal(ds.meta.boards.weekly.entries, 2);
});

test('附榜期次表存在时，日期与榜单视频 BV 都从元数据来', () => {
  const boards = {
    issues: { weekly: [issue(1)], legend: [], annual: [issue(1, 3, { year: 2025, week: 1, count: 50 })] },
    songs: [song(11, 'A', '甲', [hist(3, 1, 4, 'BVa1')])]
  };
  const ds = buildDataset([], boards, config);
  assert.equal(ds.annual[0].date, new Date((1760000000 + 7 * DAY + 2 * DAY) * 1000).toISOString().slice(0, 10));
  assert.equal(ds.annual[0].videoBvid, 'BVboard3x1');
  assert.equal(ds.annual[0].declared, 50);
});

/* ------------------------------------------------------------------ */
/* 同步闸门：年榜期次表是可选项                                          */
/* ------------------------------------------------------------------ */

test('期次校验：年榜允许为空，周榜不允许', () => {
  assert.deepEqual(checkIssues([], [], '年榜期次', { optional: true }), []);
  assert.ok(checkIssues([], [], '周榜期次').length > 0);
  // "为空"可以放过，"结构不合法"不行
  assert.ok(checkIssues([{}, issue(1), issue(1)], [], '年榜期次', { optional: true }).length > 0);
});

test('年榜期次接口挂掉时沿用本地文件，整轮同步不失败', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbw-sync-'));
  try {
    const boardsDir = path.join(dir, 'boards');
    const localAnnual = [issue(1, 3, { year: 2025, week: 1, count: 50 })];
    writeJson(path.join(boardsDir, 'issues-1.json'), [issue(1), issue(2)]);
    writeJson(path.join(boardsDir, 'issues-2.json'), [issue(1, 2)]);
    writeJson(path.join(boardsDir, 'issues-3.json'), localAnnual);
    const library = [
      upstreamSong(11, 'A', '甲', [hist(1, 1, 1, ''), hist(1, 2, 2, ''), hist(2, 1, 1, ''), hist(3, 1, 5, '')]),
      upstreamSong(22, 'B', '乙', [hist(1, 1, 2, ''), hist(1, 2, 1, '')])
    ];
    writeJson(path.join(boardsDir, 'songs.json'), library);

    const warns = [];
    const log = { info() {}, warn(m) { warns.push(m); }, debug() {}, error() {} };
    const cfg = { paths: { data: dir } };

    const client = {
      deadline: 0,
      async issues(id) {
        // 年榜的期次接口不存在 —— 这条路径不能把周榜一起拖垮
        if (id === 3) throw new Error('HTTP 404');
        return id === 1 ? [issue(1), issue(2)] : [issue(1, 2)];
      },
      async songs() { return { data: library, total: library.length }; }
    };

    const res = await syncBoards(client, cfg, log, { full: true });

    assert.equal(res.issues.weekly.length, 2);
    assert.deepEqual(res.issues.annual.map((x) => x.issue_id), [1]);
    assert.ok(warns.some((w) => w.includes('board 3')), '应当留下一条降级警告：' + JSON.stringify(warns));
    // 本地文件被原样保留（不是被空数组覆盖）
    assert.deepEqual(readJson(path.join(boardsDir, 'issues-3.json')), localAnnual);
    const meta = readJson(path.join(boardsDir, 'meta.json'));
    assert.equal(meta.boards.annual, 1);
    assert.equal(meta.boards.weekly, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 服务层：涨跌按各榜自己的上一期算                                      */
/* ------------------------------------------------------------------ */

test('附榜涨跌 / 在榜期数按本榜算，曲目详情跨三张榜', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbw-repo-'));
  try {
    const boardsDir = path.join(dir, 'boards');
    writeJson(path.join(boardsDir, 'issues-1.json'), [issue(1), issue(2)]);
    writeJson(path.join(boardsDir, 'issues-2.json'), [issue(1, 2), issue(2, 2)]);
    writeJson(path.join(boardsDir, 'songs.json'), [
      // 周榜第 2 期第 1 名；传说曲榜第 1 期第 3 名、第 2 期第 1 名（上升 2）
      song(11, 'A', '甲', [hist(1, 1, 2, 'BVw1'), hist(1, 2, 1, 'BVw2'), hist(2, 1, 3, 'BVl1'), hist(2, 2, 1, 'BVl2')]),
      // 只上过年榜，从没上周榜
      song(33, 'C', '丙', [hist(3, 2, 2, 'BVa2')])
    ]);

    const cfg = { ...config, paths: { data: dir, raw: path.join(dir, 'raw') } };
    fs.mkdirSync(cfg.paths.raw, { recursive: true });
    const repo = new Repository(cfg, null);
    repo.ensure();

    const idx = repo.boardIndex('legend');
    assert.equal(idx.total, 2);
    assert.equal(idx.first, 1);
    assert.equal(idx.last, 2);
    assert.equal(idx.items[1].champion.songId, 11);
    assert.equal(idx.items[1].champion.title, '甲');

    const detail = repo.boardIssue('legend', 2);
    assert.equal(detail.index, 1);
    assert.equal(detail.rows[0].rank, 1);
    // 传说曲榜上一期第 3 → 这期第 1：涨 2。不能拿周榜第 2 期的名次来算
    assert.equal(detail.rows[0].state, 'up');
    assert.equal(detail.rows[0].delta, 2);
    assert.equal(detail.rows[0].weeks, 2);
    assert.equal(detail.rows[0].best, 1);
    assert.deepEqual(detail.siblings, { prev: 1, next: null });

    assert.equal(repo.boardIssue('legend', 99), null);

    // 只上附榜的曲子也要查得到（以前这里返回 null，抽屉里就是"没有这首曲子"）
    const onlyAnnual = repo.song(33);
    assert.equal(onlyAnnual.title, '丙');
    assert.equal(onlyAnnual.weeks, 0);
    assert.equal(onlyAnnual.best, null);
    assert.equal(onlyAnnual.boards.annual.weeks, 1);
    assert.equal(onlyAnnual.boards.legend.weeks, 0);

    const both = repo.song(11);
    assert.equal(both.weeks, 2);
    assert.equal(both.boards.legend.weeks, 2);
    assert.equal(both.boards.legend.best, 1);

    assert.equal(repo.song(999), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
