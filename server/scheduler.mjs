/**
 * 定时调度器：按固定间隔执行采集，并把运行状态暴露出去。
 *
 * 三个必须处理的现实问题：
 *   1) 采集是网络 IO，可能慢于调度间隔 —— 必须防重叠，否则进程会堆积任务
 *   2) 采集会失败（网络抖动、x.com 改版），失败不能杀掉调度循环，也不必等满一个周期
 *   3) 运维需要知道「上次采集成不成功、下次什么时候跑」—— 状态要可读
 */

export function createScheduler({ intervalMs, run, onError }) {
  let timer = null;
  let running = false;
  let stopped = false;

  const state = {
    intervalMs,
    runs: 0,
    okRuns: 0,
    failRuns: 0,
    consecutiveErrors: 0,
    lastRunAt: null,
    lastDurationMs: null,
    lastError: null,
    lastResult: null,
    nextRunAt: null,
    startedAt: null,
  };

  async function tick() {
    if (running || stopped) return;
    running = true;
    const started = Date.now();
    state.lastRunAt = new Date(started).toISOString();
    try {
      const result = await run();
      state.okRuns++;
      state.consecutiveErrors = 0;
      state.lastResult = result ?? null;
      state.lastError = null;
    } catch (err) {
      state.failRuns++;
      state.consecutiveErrors++;
      state.lastError = err?.message ?? String(err);
      if (onError) onError(err);
    } finally {
      state.runs++;
      state.lastDurationMs = Date.now() - started;
      running = false;
    }
    schedule();
  }

  /**
   * 失败后进入短退避（1 分钟），成功则回到正常间隔。
   * 否则一次网络抖动就要白等一整个采集周期。
   */
  function schedule() {
    if (stopped) return;
    const delay = state.consecutiveErrors > 0 ? Math.min(60_000, intervalMs) : intervalMs;
    state.nextRunAt = new Date(Date.now() + delay).toISOString();
    timer = setTimeout(tick, delay);
    if (timer.unref) timer.unref();
  }

  return {
    state,
    get running() {
      return running;
    },
    /** 立即触发一次（不复用防重叠之外的并发） */
    trigger: tick,
    start({ immediate = true } = {}) {
      stopped = false;
      state.startedAt = new Date().toISOString();
      if (immediate) tick();
      else schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
