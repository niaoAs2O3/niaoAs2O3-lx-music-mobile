type PlayMusic = LX.Player.PlayMusic

/** Match a download by task ID (including quality), or a library song by source and ID. */
export const findPlayingIndex = (list: readonly PlayMusic[], playing: PlayMusic | null): number => {
  if (!playing) return -1
  const song = 'progress' in playing ? playing.metadata.musicInfo : playing
  return list.findIndex(item => {
    if ('progress' in item) {
      if ('progress' in playing) return item.id == playing.id
      return item.metadata.musicInfo.id == song.id && item.metadata.musicInfo.source == song.source
    }
    return item.id == song.id && item.source == song.source
  })
}

export const getLocateScrollParams = (index: number, columns = 1) => ({
  index: Math.floor(index / columns),
  viewPosition: 0.3,
  animated: true,
})
