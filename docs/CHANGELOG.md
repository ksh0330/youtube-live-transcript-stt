# 변경 이력

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
