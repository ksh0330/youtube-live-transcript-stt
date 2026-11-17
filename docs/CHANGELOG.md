# 변경 이력

## v0.4.2 — 언어 선택과 한국어 번역

- **인식 언어 선택:** 자동 감지(기본), 한국어, 영어, 일본어, 중국어. 자동 감지는 처음 확신도 0.8 이상으로 감지된 언어를 그 세션 동안 고정합니다.
- **한국어로 번역해서 보기 (기본 켜짐):** 한국어가 아닌 말은 로컬 NLLB-200 1.3B(CTranslate2 int8)로 문장 단위 번역합니다. 번역 모델은 STT 시작 때 미리 불러오고, 준비 전이거나 실패하면 원문을 보여 줍니다. 새로 설치할 패키지는 없습니다.
- 번역된 자막은 원문을 함께 보관해 Side Panel에 작게 표시하고, TXT 저장에 `(원문)` 줄로 넣습니다. 감지된 언어는 영상 제목 옆에 표시합니다.
- 영어 문장이 60자에서 잘려 반쪽씩 번역되던 문제 수정: 문장 길이 제한을 표시 폭 기준으로 바꿔(한글·가나·한자 2, 나머지 1) 영어는 약 120자까지 한 문장으로 둡니다.
- 문장 모드에서 끝 문장이 빠지던 문제 수정: 다시 인식하는 버퍼를 10초 대신 6초가 지나면 문장 끝에서 자릅니다. 버퍼가 길면 Whisper가 마지막 문장을 건너뛰는 경우가 있었습니다.

## v0.4.1 — YouTube CC 같은 짧은 두 줄 자막

- 영상 위 자막을 문장 통째가 아니라 한 줄 26자 안팎의 짧은 두 줄로 보여 주고, 말이 이어지면 위로 밀려 올라갑니다. 새 문장은 항상 새 줄에서 시작합니다.
- 줄 길이를 고르게 나눠 "…형사 책임을 묻지 / 않는데요."처럼 끝 단어만 남는 줄을 만들지 않습니다.
- 글자 크기에 따라 한 줄 길이가 바뀝니다 (작게 30자, 보통 26자, 크게 22자).
- SRT/VTT 저장도 같은 규칙으로 한 cue에 최대 두 줄, 긴 문장은 여러 cue로 나누고 시간은 글자 수 비율로 나눕니다.
- 문장 모드에서 `STT 지연`이 긴 문장일수록 크게 나오던 문제 수정: 마지막 확정 자막이 아니라 화면에 보이는 최신 자막 기준으로 계산합니다.
- 확장 프로그램을 새로고침·업데이트한 뒤 이미 열려 있던 YouTube 탭에서 영상 위 자막이 나오지 않던 문제 수정: 업데이트할 때와 탭이 응답하지 않을 때 자막 스크립트를 다시 넣습니다 (`scripting` 권한 추가).

## v0.4.0 — 문장 단위 자막, GPU 문장 모드

- **문장 단위 자막:** 확정된 조각을 마침표·물음표, 0.8초 쉼, 60자 기준으로 문장으로 묶어 확정합니다. 말하는 중인 문장은 Side Panel에서 한 줄로 이어지고, 바뀔 수 있는 끝부분만 흐리게 보입니다.
- **영상 위 자막 두 줄:** YouTube CC처럼 앞 문장 아래에 지금 문장을 보여 줍니다.
- **GPU 문장 모드 (LocalAgreement):** 마지막으로 끝난 문장 이후의 오디오 전체를 2초마다 다시 인식하고, 연속 두 번 일치한 단어만 확정합니다. `streaming_mode: auto`는 GPU면 문장 모드, CPU면 기존 rolling 모드를 씁니다.
- 48초 강의 클립 비교: rolling 모드는 경계에서 잘린 조각("3.", "할 수 있습니다.")이 남았고, 문장 모드(large-v3-turbo, RTX 5060 Ti)는 원문과 같은 8문장으로 확정했습니다.
- 중지 시 말하던 문장을 조각이 아닌 한 문장으로 확정합니다.
- 설정 추가: `streaming_mode`, `sentence_chunk_seconds`, `sentence_pause_seconds`, `sentence_max_chars`

## v0.3.2 — 마지막 문장 유실 수정, GPU 안내

- 중지할 때 마지막 짧은 구간이 임시 문장의 뒷부분만 다시 인식하면 문장 앞부분이 사라지던 문제 수정 (v0.3.1 이전부터 있던 문제)
- 이 PC 전용 설정 파일 `server_config.local.json` 지원 (Git 제외, 기본 설정 위에 덮어씀)
- README에 NVIDIA GPU 설정과 RTX 5060 Ti 측정값 추가 (small CPU 1.85초 → GPU 0.21초 / 6초 window)

## v0.3.1 — 경계 중복 출력 수정

- 다음 window가 임시 자막을 다시 인식할 때 Whisper 타임스탬프가 0.25초 이상 밀리면 같은 문장이 두 번 확정되던 문제 수정 (시간 허용 범위 1초, `reprediction_tolerance_seconds`)
- 다시 인식된 문장이 이전 임시 자막 안에 포함되거나 그 반대인 경우도 같은 발화로 처리
- 다음 window가 끝 단어를 빼고 다시 인식해 "자료형 크기를 반드시 자료형 크기를"처럼 반복되던 문제 수정
- Whisper 반복 루프(같은 문구 3번 이상 연속)와 한 window 안의 같은 segment 3개 이상을 하나로 합침
- `generate_fixture.ps1`이 Windows PowerShell 5.1에서 한글이 깨진 음성을 만들던 문제 수정 (UTF-8 BOM)
- 개발 의존성에 `av<18` 고정 (PyAV 19에서 `decode_audio()` 실패)
- README를 빠른 시작·설정·문제 해결 중심으로 정리

## v0.3.0 변경점 — rolling stabilizer + bounded queue

- `4초 새 오디오 + 2초 overlap + 2초 commit horizon`
- final/provisional 자막 분리와 stop 시 provisional flush
- faster-whisper segment timestamp를 capture 절대 timeline에 매핑
- WebSocket 수신과 추론 분리, 최대 16초 bounded queue와 oldest-drop overload policy
- Side Panel/독립 창 delta 갱신, 최근 500개 DOM 렌더, 8초 storage checkpoint
- 실제 STT 지연, queue, dropped audio 지표
- player 내부 overlay, 상단/중앙/하단·크기·불투명도 설정
- YouTube SPA 영상 변경 시 기존 세션 안전 중지, overlay 재부착
- 선택적 사용자 context prompt; 기본 prompt는 hallucination 방지를 위해 비움
- 상세 로그는 `debug_logging: true`에서만 활성화

자세한 감사·benchmark·테스트 결과는 [AUDIT_REPORT.md](AUDIT_REPORT.md)에 있습니다.

## v0.2.1 변경점 — activeTab / tabCapture 수정

v0.2.0에서는 Side Panel 내부의 `오디오 STT 시작` 버튼이
`chrome.tabCapture.getMediaStreamId({targetTabId})`를 background service worker로 요청했습니다.

Chrome에서는 Side Panel 내부 클릭이 새 `activeTab` 권한을 안정적으로 부여하지 않으므로 다음 오류가 날 수 있습니다.

```text
Extension has not been invoked for the current page (see activeTab permission).
Chrome pages cannot be captured.
```

v0.2.1에서는 시작 흐름을 다음처럼 변경했습니다.

```text
Chrome 툴바 확장 아이콘
       ↓
launcher popup
       ↓ 사용자 클릭과 동일한 동기 호출에서
chrome.tabCapture.getMediaStreamId()
       ↓
offscreen document
       ↓
local Whisper
       ↓
Side Panel
```

`getMediaStreamId()`를 실행하기 전에 `await` 작업을 하지 않도록 설계했습니다.
Whisper 서버 확인, 모델 warmup, offscreen 문서 생성은 팝업이 열린 직후 먼저 완료합니다.
그 뒤 사용자가 시작 버튼을 누르는 순간 캡처 권한을 즉시 획득합니다.

기록 중지는 Side Panel에서 할 수 있습니다.
중지 후 새 캡처를 시작할 때는 다시 툴바 확장 아이콘의 시작 버튼을 사용합니다.


## v0.2.2 변경점 — Side Panel + 독립 창

전사 UI를 두 방식으로 동시에 사용할 수 있습니다.

```text
Background session
      ├─ Chrome Side Panel
      └─ Detached popup window
```

둘은 별도 STT 세션이 아니라 **하나의 동일한 세션 상태**를 구독합니다.

따라서 Side Panel과 독립 창을 동시에 열어도 다음 값이 동기화됩니다.

- 녹화/중지 상태
- Whisper 서버 상태
- 누적 자막
- 타임코드
- Overlay 설정
- 저장 가능한 TXT/SRT/VTT/JSON 데이터

### 독립 창 여는 방법

방법 1:

```text
Side Panel 상단 → 새 창으로 분리
```

방법 2:

```text
Chrome 툴바 YT Live STT 아이콘 → 새 창 열기
```

독립 창이 이미 열려 있는 상태에서 다시 `새 창으로 분리`를 누르면
새 창을 여러 개 만들지 않고 기존 독립 창을 앞으로 가져옵니다.

독립 창에서는 상단 버튼이 `Side Panel 열기`로 바뀝니다.

### 권장 사용

한 모니터:

```text
YouTube | Side Panel
```

듀얼 모니터:

```text
모니터 1: YouTube Live
모니터 2: Live Transcript 독립 창
```

독립 창을 닫아도 STT 자체는 background/offscreen에서 계속되며,
기록 중지는 Side Panel 또는 독립 창의 `중지` 버튼으로 할 수 있습니다.


## v0.2.3 변경점 — CUDA 자동 fallback + 고아 캡처 정리

### Windows CUDA DLL 오류 대응

CTranslate2는 CUDA 모델 객체 생성까지 성공해도 실제 첫 추론 시점에 다음 오류를 낼 수 있습니다.

```text
Library cublas64_12.dll is not found or cannot be loaded
```

v0.2.3은 Whisper 모델을 준비할 때 **1초짜리 실제 inference preflight**를 강제로 실행합니다.

```text
CUDA model 생성
→ 실제 encoder inference 1회
→ 성공: CUDA 유지
→ cublas/cuDNN 등 런타임 오류: CPU int8 자동 fallback
→ CPU inference까지 검증
→ 준비 완료
```

따라서 CUDA Toolkit/cuBLAS/cuDNN이 없는 Windows에서도 별도 설치 없이 우선 CPU 모드로 동작합니다.

GPU를 반드시 사용하려면 faster-whisper 현재 요구사항에 맞게
CUDA 12용 cuBLAS와 cuDNN 9를 설치하고 해당 DLL이 Windows PATH에서 검색 가능해야 합니다.

### `Cannot capture a tab with an active stream` 대응

이전 버전에서는 Whisper 오류가 발생해도 Chrome `MediaStream`이 남을 수 있었습니다.

v0.2.3은 다음 상황에서 탭 오디오 스트림을 즉시 정리합니다.

- STT 서버가 `error` 메시지를 반환함
- WebSocket이 비정상 종료됨
- 다음 캡처 준비 시 app state는 중지인데 offscreen stream이 남아 있음

팝업에서 그래도 다음 오류가 발생하면:

```text
Cannot capture a tab with an active stream.
```

`남아 있는 캡처 강제 해제` 버튼이 자동으로 표시됩니다.

누른 뒤 `다시 시도`하면 됩니다.
