# YouTube Live Transcript STT

YouTube 라이브에서 **자막(CC)이 제공되지 않아도** 현재 탭의 실제 오디오를 캡처해
로컬 `faster-whisper`로 실시간 전사하는 Chrome 확장 프로그램입니다. (현재 v0.3.0)

오디오는 외부 API로 전송하지 않고 사용자의 PC 안에서만 처리합니다.

[감사·성능 보고서](docs/AUDIT_REPORT.md) · [변경 이력](docs/CHANGELOG.md) · [포트폴리오 페이지](https://ksh0330.github.io/projects/youtube-live-stt/)

## 주요 기능

- Chrome `tabCapture`로 YouTube 탭 오디오를 캡처하면서 방송 소리는 계속 재생
- 4초 새 오디오 + 2초 overlap rolling window로 약 4초마다 자막 갱신
- 확정(final) 자막과 다음 window에서 수정될 수 있는 임시(provisional) 자막 분리
- Side Panel과 독립 창이 하나의 세션을 공유, 영상 위 overlay 표시
- 전체 자막 검색, TXT / SRT / VTT / JSON 저장
- CUDA를 먼저 시도하고, 실패하면 CPU `int8`로 자동 전환

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

## 측정 결과 요약

자세한 조건과 표는 [AUDIT_REPORT.md](docs/AUDIT_REPORT.md)에 있습니다.

- **window 설정 비교:** `small / cpu / int8`, 48초 한국어 TTS 강의 fixture에서 4+2 설정이 평균 추론 1.976초(p95 2.190초), 중복 초과율 0%, CER 0.2466으로 후보 중 균형이 가장 좋아 기본값으로 선택
- **장시간 부하:** 추론이 실시간보다 느린 상황을 일부러 만든 30분·1시간·3시간 시뮬레이션에서 오디오 queue는 16초, 화면 DOM은 500개로 제한됨
- **메모리:** Whisper 모델 포함 peak RSS 약 440MB
- **테스트:** Python 19개, Node 5개 통과

CER은 TTS 원문 대비 상대 비교용 수치이며 실제 방송 음질과 화자를 대표하지 않습니다.

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
4. 이 저장소의 `extension` 폴더 선택
5. 기존에 열려 있던 YouTube 탭은 한 번 새로고침

### 3. 라이브 STT 시작

1. YouTube 라이브 탭을 활성화
2. Chrome 툴바의 **YT Live STT 확장 아이콘** 클릭
3. 팝업이 Whisper 모델 준비를 확인할 때까지 기다림
4. **현재 YouTube 탭 STT 시작** 클릭
5. Side Panel이 자동으로 열리고 약 4초마다 rolling 전사 결과가 갱신됨

YouTube 자체 CC가 `사용 불가`여도 상관없습니다. 기록 중지는 Side Panel이나 독립 창에서 하고, 다시 시작할 때는 툴바 아이콘의 시작 버튼을 사용합니다.

## 중요한 동작

### 방송 소리가 계속 들리는 이유

Chrome `tabCapture`로 오디오 스트림을 획득하면 원래 탭의 오디오 재생이 중단됩니다.
확장 프로그램이 캡처 스트림을 `AudioContext.destination`에 다시 연결하므로
사용자는 방송 소리를 계속 들을 수 있습니다.

### 시작 버튼이 툴바 팝업에 있는 이유

Chrome은 Side Panel 내부 클릭으로 `activeTab` 권한을 안정적으로 부여하지 않습니다. 그래서 툴바 팝업에서 사용자 클릭과 같은 동기 호출 안에서 `chrome.tabCapture.getMediaStreamId()`를 실행하고, 서버 확인·모델 warmup·offscreen 문서 생성은 팝업이 열린 직후 미리 끝냅니다. 자세한 배경은 [변경 이력](docs/CHANGELOG.md)의 v0.2.1 항목에 있습니다.

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
