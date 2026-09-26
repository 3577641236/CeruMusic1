import { ControlAudioStore } from '@renderer/store/ControlAudio'
import { useGlobalPlayStatusStore } from '@renderer/store/GlobalPlayStatus'
import { storeToRefs } from 'pinia'
import { watch } from 'vue'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import { useLyricExtrasStore } from '@renderer/store/LyricExtras'
import {
  computeLyricIndex,
  projectSmooth,
  resetProjector
} from '@renderer/utils/lyrics/lyricClock'

interface LyricWord {
  word: string
}
interface LyricLine {
  startTime: number
  endTime: number
  words: LyricWord[]
  translatedLyric?: string
}

let installed = false
// 保存定时器ID以便清理
let playStateInterval: number | null = null

function buildLyricPayload(lines: LyricLine[]) {
  return JSON.parse(JSON.stringify(lines || []))
}

export function installDesktopLyricBridge() {
  if (installed) return
  installed = true

  const controlAudio = ControlAudioStore()
  const globalPlayStatus = useGlobalPlayStatusStore()
  const { player } = storeToRefs(globalPlayStatus)
  const localUserStore = LocalUserDetailStore()
  const { userInfo } = storeToRefs(localUserStore)
  const lyricExtrasStore = useLyricExtrasStore()

  let lastIndex = -1

  /**
   * 当前曲目的歌词偏移(ms)，语义与 FullPlay.vue 的 currentLyricOffset 完全一致
   * (正值=歌词提前)。取值方式也照抄那边：直接读 offsetMap，函数调用在某些
   * effect scope 边界下会丢订阅。
   */
  const currentOffsetMs = () => {
    const mid = (player.value.songInfo as any)?.songmid
    if (mid === null || mid === undefined || mid === '') return 0
    const raw = (lyricExtrasStore.offsetMap as Record<string, any>)[String(mid)]
    if (raw === undefined || raw === null) return 0
    if (typeof raw === 'number') return raw || 0
    return (raw.value as number) || 0
  }

  // 监听歌词变化
  watch(
    () => player.value.lyrics.lines,
    (lines) => {
      lastIndex = -1
      ;(window as any)?.electron?.ipcRenderer?.send?.('play-lyric-change', buildLyricPayload(lines))
      // 提示前端进入准备态
      ;(window as any)?.electron?.ipcRenderer?.send?.('play-lyric-index', -1)
    },
    { immediate: true }
  )

  // 监听歌曲信息变化（同步歌名）
  watch(
    () => player.value.songInfo,
    (song) => {
      try {
        const name = (song as any)?.name || ''
        const artist = (song as any)?.singer || ''
        if (name || artist) {
          ;(window as any)?.electron?.ipcRenderer?.send?.('play-song-change', { name, artist })
        }
      } catch {}
    },
    { immediate: true }
  )

  // 播放状态推送
  let lastPlayState: any = undefined
  const checkPlayState = () => {
    if (controlAudio.Audio.isPlay !== lastPlayState) {
      lastPlayState = controlAudio.Audio.isPlay
      ;(window as any)?.electron?.ipcRenderer?.send?.('play-status-change', lastPlayState)
    }
  }
  // 立即检查一次
  watch(() => controlAudio.Audio.isPlay, checkPlayState, { immediate: true })

  // 快照推送函数：在窗口准备就绪或切换显示时调用，保证首屏不空
  const pushSnapshot = () => {
    try {
      const currentSong = player.value.songInfo as any
      const name = currentSong?.name || ''
      const artist = currentSong?.singer || ''
      if (name || artist) {
        ;(window as any)?.electron?.ipcRenderer?.send?.('play-song-change', { name, artist })
      }
      const currentLines = (player.value.lyrics?.lines as any[]) || []
      ;(window as any)?.electron?.ipcRenderer?.send?.(
        'play-lyric-change',
        buildLyricPayload(currentLines)
      )
      const a = controlAudio.Audio
      let rawMs = Math.round((a?.currentTime || 0) * 1000)
      if (rawMs <= 0) {
        const lastId = userInfo.value?.lastPlaySongId
        const songId = currentSong?.songmid
        const restoreMs = Math.round(Number(userInfo.value?.currentTime || 0) * 1000)
        if (lastId && songId && lastId === songId && restoreMs > 0) {
          rawMs = restoreMs
        }
      }
      const ms = rawMs + currentOffsetMs()
      const idx = computeLyricIndex(ms, currentLines as any)
      lastIndex = idx
      ;(window as any)?.electron?.ipcRenderer?.send?.('play-lyric-index', idx)
      let progress = 0
      if (idx >= 0 && currentLines[idx]) {
        const line = currentLines[idx] as any
        const dur = Math.max(1, (line.endTime ?? line.startTime + 1) - line.startTime)
        progress = Math.min(1, Math.max(0, (ms - line.startTime) / dur))
      }
      ;(window as any)?.electron?.ipcRenderer?.send?.('play-lyric-progress', {
        index: idx,
        progress,
        currentMs: ms,
        wallMs: Date.now(),
        timestamp: performance.now()
      })
      ;(window as any)?.electron?.ipcRenderer?.send?.(
        'play-status-change',
        !!controlAudio.Audio.isPlay
      )
    } catch {}
  }

  // 首次安装时主动推送一次当前状态
  pushSnapshot()

  // 当桌面歌词窗口声明“准备就绪”时，再次推送快照，避免页面未加载时丢包
  ;(window as any)?.electron?.ipcRenderer?.on?.('lyric-window-ready', () => {
    pushSnapshot()
  })
  // 当切换显示为开启时，补一次快照
  ;(window as any)?.electron?.ipcRenderer?.on?.(
    'desktop-lyric-open-change',
    (_: any, open: boolean) => {
      if (open) pushSnapshot()
    }
  )

  const LOOP_MS = 33

  const syncLyrics = () => {
    if (!installed) return
    const a = controlAudio.Audio
    if (!a.isPlay) return

    const rawMs = Math.round((a?.currentTime ?? a?.audio?.currentTime ?? 0) * 1000)
    const smoothMs = projectSmooth(rawMs)
    if (smoothMs <= 0) return

    // 与主窗口 FullPlay.vue 的 effectiveLyricTime 同源：平滑后的播放位置 + 本曲偏移。
    // (此前推的是未加偏移的裸时间，用户在"更多 -> 歌词偏移"里调过之后两个窗口会不一致)
    const songMs = smoothMs + currentOffsetMs()

    const currentLines = player.value.lyrics.lines || []
    if (currentLines.length === 0) return

    const idx = computeLyricIndex(songMs, currentLines)

    // 计算当前行进度（0~1）
    let progress = 0
    if (idx >= 0 && currentLines[idx]) {
      const line = currentLines[idx]
      const dur = Math.max(1, (line.endTime ?? line.startTime + 1) - line.startTime)
      progress = Math.min(1, Math.max(0, (songMs - line.startTime) / dur))
    }

    // 首先推送进度，便于前端做 30% 判定（避免 setTimeout 带来的抖动）
    // wallMs 必须与 currentMs 在同一 tick 内取：桌面窗口会用它的差值把 IPC
    // 传输耗时补回来，这是两个窗口能做到毫秒级一致的关键。
    ;(window as any)?.electron?.ipcRenderer?.send?.('play-lyric-progress', {
      index: idx,
      progress,
      currentMs: songMs,
      wallMs: Date.now(),
      timestamp: performance.now()
    })

    // 当行变化时，推送 index（立即切换高亮）
    if (idx !== lastIndex) {
      lastIndex = idx
      ;(window as any)?.electron?.ipcRenderer?.send?.('play-lyric-index', idx)
    }
  }

  // 暂停或切歌时重置墙钟基准，避免恢复播放后出现跳变
  watch(
    () => controlAudio.Audio.isPlay,
    (p) => {
      if (!p) resetProjector()
    }
  )
  watch(
    () => player.value.songInfo?.songmid,
    () => resetProjector()
  )

  // 用 setInterval 而非 requestAnimationFrame：主窗口最小化/被遮挡时 rAF 会被挂起，
  // 桌面歌词将停止更新。
  syncLyrics()
  playStateInterval = window.setInterval(syncLyrics, LOOP_MS)
}

// 导出清理函数，用于清除所有定时器
export function uninstallDesktopLyricBridge() {
  if (playStateInterval !== null) {
    clearInterval(playStateInterval)
    playStateInterval = null
  }

  installed = false
  console.log('Desktop lyric bridge uninstalled')
}
