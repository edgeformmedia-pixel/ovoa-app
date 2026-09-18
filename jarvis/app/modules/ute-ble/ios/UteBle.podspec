Pod::Spec.new do |s|
  s.name           = 'UteBle'
  s.version        = '1.0.0'
  s.summary        = 'Bridge to the UTE BLE SDK for the ES100.'
  s.description    = 'Scan, connect, and pull recordings off the ES100 via UTEBluetoothRYApi.framework.'
  s.author         = 'OVOA'
  s.homepage       = 'https://github.com/lancherosthomas-hub/ovoa-app'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }

  # UTEBluetoothRYApi is a *static* framework (its binary is an ar archive), so
  # everything linking it has to be static too.
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Straight off the vendor demo's Podfile.lock. AMapSearch (AutoNavi maps) is
  # deliberately left out — it is only there for the navigation feature we don't
  # use. If the linker complains about missing AMap symbols, add it back.
  s.dependency 'SSZipArchive'
  s.dependency 'MJExtension'
  s.dependency 'iOSOTAJL'
  s.dependency 'SocketRocket'
  s.dependency 'CocoaAsyncSocket'

  s.vendored_frameworks = 'Frameworks/UTEBluetoothRYApi.framework'

  # A static framework's resource bundle is not copied automatically.
  s.resources = 'Frameworks/UTEBluetoothRYApi.framework/UTEBluetoothRYApi.bundle'

  # Kept in src/ so this glob never reaches into Frameworks/.
  s.source_files = 'src/**/*.{h,m,swift}'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
