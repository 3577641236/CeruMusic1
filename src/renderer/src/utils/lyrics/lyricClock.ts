/**
 * 跨窗口共享的歌词时钟。
 *
 * 主窗口和桌面歌词窗口各自持有一份本模块实例（它们是独立进程，天然互不干扰），
 * 靠"锚点"对齐：
 *
 *   主窗口  把 (歌曲位置 songMs, 该位置成立时的墙钟时间 wallMs) 发出去
 *   桌面窗口 收到后用 Date.now() 减去 wallMs，把 IPC 传输耗时补回来，
 *            再锚定到自己的 performance.now() 上
 *
 * 之后每个窗口用自己的单调时钟本地推算，锚点之间零通信。
 *
 * 关键点：误差不是"推送延迟"，而是"两个进程读取墙钟是否一致"，量级约 1ms，
 * 与 IPC 快慢无关 —— 哪怕中转延迟几十毫秒，也会被 wallMs 的差值完整补偿掉，
 * 不会累积成滞后。主窗口最小化导致推送被节流，也只影响锚点刷新频率，
 * 不影响已经在跑的本地推算。
 */

export interface LyricLineLike {
  startTime: number
  endTime: number
  words?: { word: string }[]
  translatedLyric?: string
}

/** 一次时间锚点：在 wallMs 这个墙钟时刻，歌曲播放到了 songMs。 */
export interface LyricClockAnchor {
  songMs: number
  wallMs: number
}

// ---------- 消费端（两个窗口都用） ----------

let anchorSongMs = 0
let anchorPerf = 0
let anchored = false
let playing = false

/**
 * 应用一个来自其他窗口的锚点。
 * 传进来的 wallMs 是"发送方算出 songMs 的那一刻"，不是收到的那一刻；
 * 两者之差就是这份数据在路上花掉的时间，歌曲位置同样前进了这么多，
 * 必须补上，否则桌面歌词会稳定落后一个 IPC 往返的时间。
 */
export function anchorTo(anchor: LyricClockAnchor, isPlaying = true): void {
  const wallMs = Number(anchor?.wallMs)
  const songMs = Number(anchor?.songMs)
  if (!Number.isFinite(songMs)) return
  const transit = Number.isFinite(wallMs) ? Math.max(0, Date.now() - wallMs) : 0
  anchorSongMs = songMs + transit
  anchorPerf = performance.now()
  anchored = true
  playing = isPlaying
}

/** 当前歌曲播放位置(ms)。还没收到过锚点时返回 0。 */
export function getLyricMs(): number {
  if (!anchored) return 0
  if (!playing) return anchorSongMs
  return anchorSongMs + (performance.now() - anchorPerf)
}

/** 暂停：把当前位置固化成锚点，之后 getLyricMs() 不再前进。 */
export function freezeClock(): void {
  if (anchored && playing) {
    anchorSongMs = getLyricMs()
    anchorPerf = performance.now()
  }
  playing = false
}

/** 恢复播放：以当前位置为起点继续前进。 */
export function resumeClock(): void {
  if (!anchored) return
  anchorPerf = performance.now()
  playing = true
}

/** 切歌/重置：丢弃旧锚点，避免拿上一首的时间继续推算。 */
export function resetClock(): void {
  anchored = false
  playing = false
  anchorSongMs = 0
  anchorPerf = 0
  resetProjector()
}

// ---------- 发送端（主窗口用） ----------

let lastRawMs = -1
let wallStartMs = 0
let wallClockRef = 0
let dynamicOffset = 0

/**
 * 把 HTMLMediaElement.currentTime 的量化台阶投影成连续值。
 *
 * currentTime 只在音频回调里跳变，直接拿去渲染会一格一格地走；这里记下
 * "某个原始值是在什么时刻读到的"，之后用墙钟线性外推，得到逐帧连续的时间。
 *
 * dynamicOffset 表示投影值允许落后真实位置多少毫秒。因为采样只能在 currentTime
 * 变化之后才发现，而真实变化发生在过去 0~33ms 内，投影本身就带一点滞后，
 * 所以这里取 0、不再额外叠加；它只在墙钟跑快导致投影超前时才兜底修正。
 */
export function projectSmooth(rawMs: number, perfNow: number = performance.now()): number {
  if (rawMs !== lastRawMs) {
    if (wallClockRef > 0 && lastRawMs >= 0) {
      const projected = wallStartMs + (perfNow - wallClockRef)
      const overshoot = projected - rawMs
      if (overshoot > 20) {
        dynamicOffset = Math.min(dynamicOffset + overshoot, 200)
      } else if (overshoot < -40) {
        dynamicOffset = Math.max(dynamicOffset - 10, 0)
      }
    }
    lastRawMs = rawMs
    wallStartMs = rawMs
    wallClockRef = perfNow + dynamicOffset
  }
  if (wallClockRef === 0) return rawMs
  return Math.round(wallStartMs + (perfNow - wallClockRef))
}

/** 暂停/切歌后重置投影，避免恢复播放时还挂在过期的墙钟基准上。 */
export function resetProjector(): void {
  lastRawMs = -1
  wallClockRef = 0
}

// ---------- 共用的歌词定位 ----------

/**
 * 求某个时刻落在哪一行歌词。纯函数，两个窗口共用同一份实现
 * （此前主窗口的桥接器和桌面歌词窗口各写了一份）。
 */
export function computeLyricIndex(songMs: number, lines: LyricLineLike[] | undefined): number {
  if (!lines || lines.length === 0) return -1
  const i = lines.findIndex((l) => songMs >= l.startTime && songMs < l.endTime)
  if (i !== -1) return i
  for (let j = lines.length - 1; j >= 0; j--) {
    if (songMs >= lines[j].startTime) return j
  }
  return -1
}
