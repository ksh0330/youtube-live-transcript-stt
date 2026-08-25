# YouTube Live Transcript STT v0.3.0

YouTube 라이브에서 **자막(CC)이 제공되지 않아도** 현재 탭의 실제 오디오를 캡처해
로컬 `faster-whisper`로 실시간 전사하는 Chrome 확장 프로그램입니다.

## 구조

```text
YouTube Live Audio
      ↓
chrome.tabCapture
      ↓
Chrome offscreen document
      ↓ 16 kHz / mono / PCM16
WebSocket (127.0.0.1:8765)
      ↓
faster-whisper
      ↓
rolling stabilizer (final + provisional)
      ↓
Chrome Side Panel
      ├─ 실시간 전체 자막
      ├─ 검색
      ├─ 영상 Overlay
      └─ TXT / SRT / VTT / JSON
```

오디오는 외부 API로 전송하지 않고 사용자의 PC 안에서만 처리합니다.

## 설치 순서

### 1. 로컬 STT 서버 실행

`local-stt-server/start_server.bat`을 실행합니다.

첫 실행에서는:

1. `.venv` 생성
2. Python 패키지 설치
3. 서버 실행

까지 자동으로 수행합니다.

Side Panel의 `서버 확인` 단계에서 `faster-whisper` Whisper 모델을 미리 준비합니다. 첫 실행이면 이때 모델이 자동 다운로드될 수 있습니다.

정상 실행되면 콘솔에 다음 주소가 표시됩니다.

```text
http://127.0.0.1:8765/health
```

브라우저에서 이 주소를 열어 `"ok": true`가 나오면 서버가 준비된 것입니다.

### 2. Chrome 확장 프로그램 설치

1. Chrome에서 `chrome://extensions` 접속
2. 우측 상단 **개발자 모드** ON
3. **압축해제된 확장 프로그램을 로드합니다**
4. 이 패키지의 `extension` 폴더 선택
5. 기존에 열려 있던 YouTube 탭은 한 번 새로고침

### 3. 라이브 STT 시작

1. YouTube 라이브 탭을 활성화
2. 확장 프로그램 아이콘 클릭 → Side Panel 열기
3. Chrome 툴바의 **YT Live STT 확장 아이콘** 클릭
4. 팝업이 Whisper 모델 준비를 확인할 때까지 기다림
5. **현재 YouTube 탭 STT 시작** 클릭
6. Side Panel이 자동으로 열리고 약 4초마다 rolling 전사 결과가 갱신됨

YouTube 자체 CC가 `사용 불가`여도 상관없습니다.

## 중요한 동작

### 방송 소리가 계속 들리는 이유

Chrome `tabCapture`로 오디오 스트림을 획득하면 원래 탭의 오디오 재생이 중단됩니다.
확장 프로그램이 캡처 스트림을 `AudioContext.destination`에 다시 연결하므로
사용자는 방송 소리를 계속 들을 수 있습니다.

### 전사 지연

기본 설정은 새 오디오 4초에 직전 2초를 붙인 6초 rolling window입니다.

```json
{
  "chunk_seconds": 4.0,
  "overlap_seconds": 2.0,
  "commit_horizon_seconds": 2.0,
  "queue_max_seconds": 16.0
}
```

마지막 약 2초는 provisional로 표시되어 다음 window에서 수정될 수 있습니다. 확정 자막은 commit horizon 뒤에 추가되며, UI의 `STT 지연`에서 현재 밀림을 확인할 수 있습니다.

### 중복 처리

각 4초 새 오디오 앞에 직전 2초를 겹쳐서 Whisper에 전달합니다.
서버는 시간 overlap이 있는 경우에만 공백을 무시한 suffix/prefix 비교와 제한된 fuzzy 비교를 적용합니다. 실제로 떨어져서 반복된 발화는 보존합니다.

## 모델 설정

`local-stt-server/server_config.json`

기본:

```json
{
  "model_size": "small",
  "language": "ko",
  "device": "auto",
  "compute_type": "auto",
  "chunk_seconds": 4.0,
  "overlap_seconds": 2.0,
  "commit_horizon_seconds": 2.0,
  "queue_max_seconds": 16.0,
  "beam_size": 1,
  "vad_filter": true,
  "vad_min_silence_duration_ms": 500,
  "word_timestamps": false,
  "initial_prompt": "",
  "debug_logging": false
}
```

### 속도가 너무 느리면

`model_size`를 다음처럼 변경:

```json
"model_size": "base"
```

### 정확도를 높이고 싶으면

```json
"model_size": "medium"
```

대신 모델 다운로드 용량과 연산량이 커집니다.

### GPU

`device: "auto"`는 CTranslate2에서 사용 가능한 CUDA GPU가 확인되면 CUDA를 먼저 시도하고,
모델 로드에 실패하면 CPU `int8`로 자동 폴백합니다.

환경에 따라 Windows CUDA/CTranslate2 라이브러리 구성이 추가로 필요할 수 있습니다.
우선은 자동 설정 그대로 실행해 보는 것을 권장합니다.

## 저장 파일

Side Panel에서 다음 형식으로 저장할 수 있습니다.

- TXT
- SRT
- VTT
- JSON

타임코드는 capture 시작 시점의 YouTube `<video>.currentTime`에 faster-whisper
segment timestamp를 더해 계산합니다. SRT/VTT 내보내기에서는 start/end가 단조 증가하도록 검증합니다.

## 현재 MVP 한계

- 매우 빠른 화자 전환이나 큰 배경음에서는 rolling window 경계에서도 문장 품질이 흔들릴 수 있음
- 배경음악/효과음이 매우 크면 Whisper 오인식 가능
- 고정밀 자막 편집용 SRT보다는 라이브 기록/검색/요약용에 더 적합
- 첫 모델 다운로드/로드 시 바로 전사가 시작되지 않고 준비 시간이 필요할 수 있음
- DRM/브라우저 정책 또는 Chrome 변경으로 일부 탭 캡처가 제한될 가능성은 있음

## 테스트

Python 문법:

```bash
python -m py_compile local-stt-server/server.py
python -m unittest discover -s local-stt-server/tests -v
```

Chrome JS 문법(Node.js 설치 시):

```bash
node --check extension/background.js
node --check extension/offscreen.js
node --check extension/content.js
node --check extension/sidepanel.js
node --test extension/tests/transcript-utils.test.js
```

장시간/실측 benchmark:

```bash
python scripts/simulate_long_run.py
powershell -ExecutionPolicy Bypass -File scripts/generate_fixture.ps1
python scripts/benchmark_whisper.py benchmark-results/lecture-fixture.wav --model-size small --include-word-timestamps
python scripts/smoke_websocket.py benchmark-results/lecture-fixture.wav --duration 12
```

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

전체 감사, benchmark, 테스트 결과는 [AUDIT_REPORT.md](docs/AUDIT_REPORT.md)에 있습니다.


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
