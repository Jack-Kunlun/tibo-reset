/** 更新由微信下载；只有准备完成并经用户确认，才切换代码包。 */
export function createUpdatePrompt(host = typeof wx === 'undefined' ? null : wx) {
  let manager = null;
  let foreground = false;
  let allowed = true;
  let pending = null;
  let prompted = false;
  let modalOpen = false;
  let applying = false;

  function prompt() {
    if (!manager || !foreground || !allowed || !pending || prompted || modalOpen || applying) return;
    const kind = pending;
    let applyFailed = false;
    prompted = true;
    modalOpen = true;
    try {
      host.showModal({
        title: kind === 'ready' ? '更新已就绪' : '更新未完成',
        content: kind === 'ready'
          ? '新版本已准备好，重新进入即可使用。是否立即重启小程序？'
          : '暂时无法完成更新，当前仍可继续使用。请检查网络，稍后重新打开小程序。',
        showCancel: kind === 'ready',
        cancelText: '稍后',
        confirmText: kind === 'ready' ? '立即重启' : '知道了',
        confirmColor: '#7161e8',
        success(res) {
          if (kind === 'ready' && res.confirm && pending === 'ready' && !applying) {
            applying = true;
            try {
              manager.applyUpdate();
            } catch {
              applying = false;
              pending = 'failed';
              applyFailed = true;
            }
          } else if (kind === 'failed' && pending === 'failed') {
            pending = null;
          }
        },
        complete() {
          modalOpen = false;
          if (applyFailed) {
            prompted = false;
            prompt();
          }
        },
      });
    } catch {
      // 弹窗不可用时保留待更新状态，下次进入再提示，不影响首屏。
      modalOpen = false;
    }
  }

  try {
    if (host && typeof host.getUpdateManager === 'function' && typeof host.showModal === 'function') {
      const candidate = host.getUpdateManager();
      if (candidate && ['onUpdateReady', 'onUpdateFailed', 'applyUpdate'].every((key) => typeof candidate[key] === 'function')) {
        manager = candidate;
        manager.onUpdateReady(() => {
          pending = 'ready';
          prompt();
        });
        manager.onUpdateFailed(() => {
          // 已经下载好的包不被重复的失败通知覆盖。
          if (pending !== 'ready') pending = 'failed';
          prompt();
        });
      }
    }
  } catch {
    manager = null;
  }

  return {
    onShow(allowPrompt = true) {
      if (!foreground) prompted = false;
      foreground = true;
      allowed = allowPrompt;
      prompt();
    },
    onHide() {
      // 后台下载完成先记住；返回前台后再弹，避免丢失更新提示。
      foreground = false;
    },
  };
}
