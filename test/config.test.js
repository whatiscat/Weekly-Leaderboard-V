import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';

test('默认配置可载入，相对路径解析到仓库根', () => {
  const cfg = loadConfig();
  assert.ok(Number.isInteger(cfg.server.port));
  // 从任何工作目录启动，指向的都是同一份数据
  assert.equal(cfg.paths.data, path.join(ROOT, 'data'));
  assert.equal(cfg.paths.state, path.join(ROOT, 'data/state.json'));
  assert.equal(cfg.paths.web, path.join(ROOT, 'src/web'));
  // 站点信息改名后仍从 config 读，前端与 meta 用的是同一处
  assert.equal(typeof cfg.site.title, 'string');
});

test('端口越界直接拒绝启动，不静默回落', () => {
  assert.throws(() => loadConfig({ server: { port: 0 } }), /server\.port 不能小于 1/);
  assert.throws(() => loadConfig({ server: { port: 70000 } }), /server\.port 不能大于 65535/);
  assert.throws(() => loadConfig({ server: { port: '5173' } }), /server\.port 必须是整数/);
});

test('限流 / 重试这类"看着配了其实没生效"的值拒绝启动', () => {
  assert.throws(() => loadConfig({ http: { minIntervalMs: -1 } }), /http\.minIntervalMs 不能小于 0/);
  assert.throws(() => loadConfig({ http: { maxRetries: 99 } }), /http\.maxRetries 不能大于 12/);
  assert.throws(() => loadConfig({ http: { backoffMaxMs: 100 } }), /backoffMaxMs 不能小于 http\.backoffBaseMs/);
});

test('定时与站点字段：形状错了就报出具体键名', () => {
  assert.throws(() => loadConfig({ schedule: { weekday: 7 } }), /schedule\.weekday/);
  assert.throws(() => loadConfig({ schedule: { hour: 24 } }), /schedule\.hour/);
  assert.throws(() => loadConfig({ site: { title: '' } }), /site\.title 不能为空/);
  assert.throws(() => loadConfig({ account: { spaceUrl: 'space.bilibili.com/1' } }), /account\.spaceUrl 必须带 http/);
});
