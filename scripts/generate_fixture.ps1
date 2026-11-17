param(
  [string]$OutputPath = "benchmark-results/lecture-fixture.wav"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\$OutputPath"))
$outputDirectory = [System.IO.Path]::GetDirectoryName($resolvedOutput)
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

$text = @"
오늘은 고정 소수점 수 체계를 설명하겠습니다.
삼십이 비트 안에서 정수부와 소수부를 함께 표현할 수 있습니다.
스케일링 팩터를 사용하면 여덟 번째 비트 위치를 소수점처럼 해석합니다.
씨 언어의 인트와 롱 자료형, 씨 팔십구와 씨 구십구 표준도 비교하겠습니다.
엑스 팔십육과 엑스 육십사 환경에서는 자료형 크기를 반드시 확인해야 합니다.
픽스드 포인트와 플로팅 포인트는 정확도와 표현 범위에서 서로 다른 장단점이 있습니다.
이제 같은 핵심 문장을 실제 반복으로 다시 설명하겠습니다.
삼십이 비트 안에서 정수부와 소수부를 함께 표현할 수 있습니다.
"@

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice = $synth.GetInstalledVoices() |
    Where-Object { $_.VoiceInfo.Culture.Name -eq "ko-KR" } |
    Select-Object -First 1
  if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }
  $synth.Rate = 0
  $synth.SetOutputToWaveFile($resolvedOutput)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}

Write-Output $resolvedOutput
