import { StyleSheet } from 'react-native'
import Button from '@/components/common/Button'
import { Icon } from '@/components/common/Icon'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { scaleSizeW } from '@/utils/pixelRatio'

const size = Math.max(44, scaleSizeW(44))
const inset = Math.max(10, scaleSizeW(12))

export const locatePlayingListStyle = StyleSheet.create({
  content: { paddingBottom: inset * 2 + size },
})

const styles = StyleSheet.create({
  button: {
    position: 'absolute',
    right: inset,
    bottom: inset,
    width: size,
    height: size,
    borderRadius: size / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
  },
})

export default ({ onPress }: { onPress: () => void }) => {
  const t = useI18n()
  const theme = useTheme()
  return (
    <Button
      accessibilityRole="button"
      accessibilityLabel={t('list_locate_playing')}
      onPress={onPress}
      style={{ ...styles.button, backgroundColor: theme['c-content-background'], borderColor: theme['c-primary-light-200-alpha-700'] }}
    >
      <Icon name="music_time" size={20} color={theme['c-primary-font']} />
    </Button>
  )
}
