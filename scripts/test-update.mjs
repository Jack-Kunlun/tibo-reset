#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUpdatePrompt } from '../miniprogram/utils/update.js';

function fixture() {
  const events = {};
  const modals = [];
  let applies = 0;
  const manager = {
    onUpdateReady: (cb) => { events.ready = cb; },
    onUpdateFailed: (cb) => { events.failed = cb; },
    applyUpdate: () => { applies++; },
  };
  const host = { getUpdateManager: () => manager, showModal: (opts) => modals.push(opts) };
  const controller = createUpdatePrompt(host);
  const answer = (index, confirm) => {
    modals[index].success({ confirm, cancel: !confirm });
    modals[index].complete();
  };
  return { controller, events, modals, manager, host, answer, applies: () => applies };
}

test('没有下载完成通知时不弹窗、不重启', () => {
  const f = fixture();
  f.controller.onShow();
  f.controller.onHide();
  f.controller.onShow();
  assert.equal(f.modals.length, 0);
  assert.equal(f.applies(), 0);
});

test('下载完成后提供稍后与立即重启，确认才应用更新', () => {
  const f = fixture();
  f.controller.onShow();
  f.events.ready();
  assert.equal(f.modals.length, 1);
  assert.equal(f.modals[0].showCancel, true);
  assert.equal(f.modals[0].cancelText, '稍后');
  assert.equal(f.modals[0].confirmText, '立即重启');
  assert.equal(f.applies(), 0);
  f.answer(0, true);
  assert.equal(f.applies(), 1);
  f.controller.onHide();
  f.controller.onShow();
  f.events.ready();
  assert.equal(f.modals.length, 1);
});

test('点稍后不重启，同次前台不重复提醒，重新进入再提示', () => {
  const f = fixture();
  f.controller.onShow();
  f.events.ready();
  f.answer(0, false);
  f.events.ready();
  f.controller.onShow();
  assert.equal(f.applies(), 0);
  assert.equal(f.modals.length, 1);
  f.controller.onHide();
  f.controller.onShow();
  assert.equal(f.modals.length, 2);
  f.answer(1, true);
  assert.equal(f.applies(), 1);
});

test('后台下载完成先保留，返回前台再提示', () => {
  const f = fixture();
  f.events.ready();
  assert.equal(f.modals.length, 0);
  f.controller.onShow();
  assert.equal(f.modals.length, 1);
  f.answer(0, false);
  f.controller.onHide();
  f.events.ready();
  assert.equal(f.modals.length, 1);
  f.controller.onShow();
  assert.equal(f.modals.length, 2);
});

test('重复通知或弹窗未关闭时不会叠加弹窗', () => {
  const f = fixture();
  f.controller.onShow();
  f.events.ready();
  f.events.ready();
  f.events.failed();
  f.controller.onHide();
  f.controller.onShow();
  assert.equal(f.modals.length, 1);
  f.answer(0, true);
  assert.equal(f.applies(), 1);
});

test('下载失败有反馈，确认后不重启、不在下次前台反复提示旧错误', () => {
  const f = fixture();
  f.controller.onShow();
  f.events.failed();
  assert.equal(f.modals.length, 1);
  assert.equal(f.modals[0].showCancel, false);
  assert.match(f.modals[0].content, /检查网络/);
  f.answer(0, true);
  f.controller.onHide();
  f.controller.onShow();
  assert.equal(f.modals.length, 1);
  assert.equal(f.applies(), 0);
});

test('后台下载失败回到前台提示，随后下载成功仍可更新', () => {
  const f = fixture();
  f.events.failed();
  assert.equal(f.modals.length, 0);
  f.controller.onShow();
  f.events.ready();
  f.answer(0, true);
  assert.equal(f.applies(), 0);
  f.controller.onHide();
  f.controller.onShow();
  assert.equal(f.modals[1].confirmText, '立即重启');
  f.answer(1, true);
  assert.equal(f.applies(), 1);
});

test('朋友圈单页不提示，普通入口仍可提示已就绪更新', () => {
  const f = fixture();
  f.controller.onShow(false);
  f.events.ready();
  assert.equal(f.modals.length, 0);
  f.controller.onHide();
  f.controller.onShow(true);
  assert.equal(f.modals.length, 1);
});

test('宿主缺失、低版本、接口抛错和不完整管理器都不阻断运行', () => {
  for (const host of [null, {}, { getUpdateManager() { throw new Error('unsupported'); }, showModal() {} },
    { getUpdateManager: () => ({}), showModal() {} }, { getUpdateManager: () => null, showModal() {} }]) {
    assert.doesNotThrow(() => {
      const c = createUpdatePrompt(host);
      c.onShow();
      c.onHide();
    });
  }
});

test('弹窗异步失败后，下次进入仍可提示', () => {
  const f = fixture();
  f.controller.onShow();
  f.events.ready();
  f.modals[0].complete();
  f.controller.onHide();
  f.controller.onShow();
  assert.equal(f.modals.length, 2);
  assert.equal(f.applies(), 0);
});

test('弹窗同步抛错也不影响页面，并可在下次进入重试', () => {
  const f = fixture();
  const showModal = f.host.showModal;
  f.host.showModal = () => { throw new Error('unavailable'); };
  f.controller.onShow();
  assert.doesNotThrow(() => f.events.ready());
  f.host.showModal = showModal;
  f.controller.onHide();
  f.controller.onShow();
  assert.equal(f.modals.length, 1);
});

test('应用更新抛错时给出失败反馈，不自动循环重启', () => {
  const f = fixture();
  f.manager.applyUpdate = () => { throw new Error('apply failed'); };
  f.controller.onShow();
  f.events.ready();
  assert.doesNotThrow(() => f.answer(0, true));
  assert.equal(f.modals.length, 2);
  assert.equal(f.modals[1].showCancel, false);
  f.answer(1, true);
  f.controller.onHide();
  f.controller.onShow();
  assert.equal(f.modals.length, 2);
});
