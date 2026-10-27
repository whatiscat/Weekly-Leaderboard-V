import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkIssues, checkSongs, describeCoverage, checkLatest, inspectSync
} from '../src/biliboard/validate.js';

function issue(id, count = 20) {
  return { issue_id: id, board_id: 1, year: 2026, week: id, video_count: count };
}
function song(id, rows) {
  return {
    id,
    history: rows.map(([issueId, rank]) => ({ boardId: 1, issueId, rank, title: 'T' + id }))
  };
}

test('期次：空列表 / 非数组 / 重复期号 / 条数缩水都要拒绝', () => {
  assert.ok(checkIssues([], []).length > 0);
  assert.ok(checkIssues(null, []).length > 0);
  assert.ok(checkIssues([issue(1), issue(1)], []).some((e) => e.includes('重复期号')));
  assert.ok(checkIssues([{ board_id: 1 }], []).some((e) => e.includes('issue_id')));

  const prev = [issue(1), issue(2), issue(3)];
  const errors = checkIssues([issue(1), issue(2)], prev);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('从 3 条降到 2 条'));
  // 变多 / 不变都不算错
  assert.deepEqual(checkIssues([issue(1), issue(2), issue(3)], prev), []);
  assert.deepEqual(checkIssues([...prev, issue(4)], prev), []);
});

test('曲目库：结构完整、id 唯一、条数不缩水', () => {
  const ok = [song(1, [[1, 1], [2, 2]]), song(2, [[2, 1]])];
  assert.deepEqual(checkSongs(ok), []);

  assert.ok(checkSongs([], {}).length > 0);
  assert.ok(checkSongs([{ id: 1, history: [] }]).some((e) => e.includes('没有任何上榜记录')));
  assert.ok(checkSongs([{ history: [[1, 1]] }]).some((e) => e.includes('缺少合法的 id')));
  assert.ok(checkSongs([song(1, [[1, 1]]), song(1, [[2, 2]])]).some((e) => e.includes('id 重复')));
  assert.ok(checkSongs([song(1, [[1, 21]])]).some((e) => e.includes('名次越界')));
  // 年榜（board 3）名次能到 100，不能按周榜的 1–20 判脏
  const yearBoard = [{ id: 9, history: [{ boardId: 3, issueId: 1, rank: 100 }] }];
  assert.deepEqual(checkSongs(yearBoard), []);
  assert.ok(checkSongs([{ id: 9, history: [{ boardId: 3, issueId: 1, rank: 0 }] }]).some((e) => e.includes('名次越界')));

  // 合并只会增不会减：从 3 首变 2 首必须拦下（否则会静默删歌）
  const shrink = checkSongs([song(1, [[1, 1]]), song(2, [[1, 2]])], { prevCount: 3 });
  assert.ok(shrink.some((e) => e.includes('从 3 首降到 2 首')));
});

test('一致性：孤儿行 / 缺名次 / 重复名次', () => {
  const issues = [issue(1), issue(2)];
  const songs = [
    song(1, [[1, 1], [1, 1], [2, 2], [99, 3]]) // 第 1 期重复名次、第 99 期是孤儿
  ];
  const c = describeCoverage(songs, issues);
  assert.equal(c.rows, 4);
  assert.equal(c.orphanRows, 1);
  assert.deepEqual(c.duplicateRanks, ['1:1']);
  // 两期都没满 20 名；第 1 期虽然有两行，但名次只有 1 个，不能算成 2/20
  assert.equal(c.completeIssues, 0);
  assert.equal(c.totalIssues, 2);
  assert.deepEqual(c.incomplete, [
    { issue: 1, have: 1, expected: 20 },
    { issue: 2, have: 1, expected: 20 }
  ]);
});

test('曲目库落后于榜单时给出 stale 标记', () => {
  const issues = [issue(1), issue(2), issue(3)];
  const fresh = checkLatest([song(1, [[3, 1]])], issues);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.latestInSongs, 3);

  const stale = checkLatest([song(1, [[1, 1]])], issues);
  assert.equal(stale.stale, true);

  // 允许落后一期：榜单刚出、曲目库还没跟上属于正常时序
  const lag1 = checkLatest([song(1, [[2, 1]])], issues, { lag: 1 });
  assert.equal(lag1.stale, false);
});

test('inspectSync 汇总：结构错误拦写，一致性问题只报警告', () => {
  const prevIssues = [issue(1), issue(2)];
  const bad = inspectSync({ issues: [issue(1)], songs: [], prevIssues, prevSongsCount: 2 });
  assert.ok(bad.errors.length > 0);

  const good = inspectSync({
    issues: [issue(1)],
    songs: [song(1, [[1, 1]])],
    prevIssues: [issue(1)],
    prevSongsCount: 1
  });
  assert.deepEqual(good.errors, []);
  // 缺名次不算警告：那是数据本身的状态（页面/doctor 会如实展示），不是同步出错
  assert.deepEqual(good.warnings, []);
  assert.equal(good.coverage.incomplete.length, 1);
});
