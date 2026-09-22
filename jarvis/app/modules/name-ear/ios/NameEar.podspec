Pod::Spec.new do |s|
  s.name           = 'NameEar'
  s.version        = '1.0.0'
  s.summary        = "Hears the assistant's name on the phone, so nothing is sent until it is said."
  s.description    = "Owns the microphone, runs Apple's on-device speech recognition over it, keeps a few seconds of audio ready, and hands audio to JavaScript only while a request is being sent."
  s.author         = 'OVOA'
  s.homepage       = 'https://github.com/lancherosthomas-hub/ovoa-app'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }

  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'AVFoundation', 'Speech'

  s.source_files = 'src/**/*.{h,m,swift}'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
