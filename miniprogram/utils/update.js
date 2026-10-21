/** 更新由微信下载；只有准备完成并经用户确认，才切换代码包。 */
export function createUpdatePrompt(host = typeof wx === 'undefined' ? null : wx) {
  let manager = null;
  let foreground = false;
  let allowed = true;
  let pending = null;
  let foregroundEpoch = 0;
  let promptedEpoch = -1;
  let modalOpen = false;
  let applying = false;

  function prompt() {
    if (!manager || !foreground || !allowed || !pending
      || promptedEpoch === foregroundEpoch || modalOpen || applying) return;
    const kind = pending;
    const promptEpoch = foregroundEpoch;
    let applyFailed = false;
    promptedEpoch = foregroundEpoch;
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
            // applyUpdate 失败后只补一条失败说明，不在同一前台周期循环弹窗。
            promptedEpoch = -1;
            prompt();
          } else if (foreground && foregroundEpoch !== promptEpoch) {
            // 旧弹窗可能跨越后台周期；关闭后补发新前台尚未看到的提示。
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
      if (candidate && typeof candidate.onUpdateReady === 'function' && typeof candidate.applyUpdate === 'function') {
        manager = candidate;
        try {
          candidate.onUpdateReady(() => {
            pending = 'ready';
            prompt();
          });
        } catch {
          // 一个监听注册异常时保留 manager，避免丢掉已注册或部分注册的就绪回调。
        }
        if (typeof candidate.onUpdateFailed === 'function') {
          try {
            candidate.onUpdateFailed(() => {
              // 已经下载好的包不被重复的失败通知覆盖。
              if (pending !== 'ready') pending = 'failed';
              prompt();
            });
          } catch {
            // 失败监听不可用时仍保留就绪监听，避免正常更新提示一起失效。
          }
        }
      }
    }
  } catch {
    // 宿主更新接口异常时保留页面；若 manager 已取得，保留其它已注册的能力。
  }

  return {
    onShow(allowPrompt = true) {
      if (!foreground) {
        foregroundEpoch++;
        promptedEpoch = -1;
      }
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
