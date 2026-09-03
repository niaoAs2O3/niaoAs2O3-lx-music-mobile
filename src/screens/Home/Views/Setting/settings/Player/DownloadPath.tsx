import { memo, useRef } from 'react'
import { StyleSheet, View } from 'react-native'

import ChoosePath, { type ChoosePathType } from '@/components/common/ChoosePath'
import Text from '@/components/common/Text'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import Button from '../../components/Button'
import SubTitle from '../../components/SubTitle'

export default memo(() => {
  const t = useI18n()
  const path = useSettingValue('download.path')
  const choosePathRef = useRef<ChoosePathType>(null)

  return (
    <SubTitle title={t('setting_download_path')}>
      <Text style={styles.path} selectable>{path || t('setting_download_path_default')}</Text>
      <View style={styles.buttons}>
        <Button onPress={() => choosePathRef.current?.show({ title: t('setting_download_path'), dirOnly: true })}>
          {t('setting_download_path_choose')}
        </Button>
        {!!path && <Button onPress={() => { updateSetting({ 'download.path': '' }) }}>{t('setting_download_path_reset')}</Button>}
      </View>
      <ChoosePath ref={choosePathRef} onConfirm={(selectedPath) => { updateSetting({ 'download.path': selectedPath }) }} />
    </SubTitle>
  )
})

const styles = StyleSheet.create({
  path: {
    marginBottom: 5,
  },
  buttons: {
    flexDirection: 'row',
  },
})
