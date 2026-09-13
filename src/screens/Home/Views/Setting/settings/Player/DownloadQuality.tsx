import { memo, useMemo } from 'react'

import { StyleSheet, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { TRY_QUALITYS_LIST } from '@/core/music/utils'

const useActive = (id: LX.Download.QualityPreference) => {
  const quality = useSettingValue('download.quality')
  return useMemo(() => quality == id, [quality, id])
}

const Item = ({ id, name }: { id: LX.Download.QualityPreference, name: string }) => {
  const isActive = useActive(id)
  return <CheckBox marginRight={8} check={isActive} label={name} onChange={() => { updateSetting({ 'download.quality': id }) }} need />
}

export default memo(() => {
  const t = useI18n()
  const qualityList = useMemo(() => [...TRY_QUALITYS_LIST, '128k'].reverse() as LX.Download.QualityPreference[], [])

  return (
    <SubTitle title={t('setting_download_quality')}>
      <View style={styles.list}>
        {qualityList.map(quality => <Item name={quality == 'flac24bit' ? '最高可用音质' : quality} id={quality} key={quality} />)}
      </View>
    </SubTitle>
  )
})

const styles = StyleSheet.create({
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
})
