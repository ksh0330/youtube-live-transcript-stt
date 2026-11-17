# 감사·성능 보고서

이 문서의 앞부분은 v0.4.2 현재 상태이고, 뒷부분 [v0.3.0 감사 기록](#v030-감사-기록)은 처음 코드를 감사하고 안정화할 때의 기록입니다. 기록 부분의 설정값과 위험 요소 중 일부는 이후 버전에서 바뀌었습니다(아래 표 참고).

## 현재 상태 (v0.4.2)

### 버전별 주요 변화

| 버전 | 바뀐 것 | 이유 |
| --- | --- | --- |
| v0.3.0 | 수신과 추론 분리, 16초 대기열, 4+2초 window, 확정/임시 자막 | CPU가 느릴 때 방송보다 수십 분 밀리는 문제 |
| v0.3.1 | 다시 인식된 문장을 시간 ±1초와 포함 관계로 비교, 반복 루프 제거 | 같은 문장이 두 번 나오던 문제 ("자료형 크기를 반드시 자료형 크기를") |
| v0.3.2 | 마지막 짧은 window의 앞부분을 임시 자막에서 이어받음 | 중지할 때 마지막 문장 앞부분이 빠지던 문제 |
| v0.4.0 | 문장 조립, GPU 문장 모드(LocalAgreement), `setup_gpu.bat` | window 경계에서 "3.", "할 수 있습니다."처럼 잘린 조각 |
| v0.4.1 | YouTube CC 같은 두 줄 자막, SRT/VTT 두 줄 cue, 자막 스크립트 자동 재연결 | 영상 위 자막이 너무 길고, 확장 업데이트 뒤 overlay가 사라짐 |
| v0.4.2 | 인식 언어 선택과 자동 감지 고정, NLLB-200 한국어 번역, 문장 길이를 표시 폭으로 계산, 문장 모드 버퍼 6초 | 영어·일본어 방송 지원, 영어 문장이 반쪽씩 번역되고 끝 문장이 빠지던 문제 |

### 현재 처리 흐름

```text
툴바 팝업 클릭 → 같은 call stack에서 tabCapture stream ID → offscreen 문서
→ AudioContext (원래 소리 재생) + ScriptProcessor → 16 kHz mono PCM16
→ WebSocket 127.0.0.1:8765 → 수신 coroutine → 16초 bounded queue → STT worker
   ├ 문장 모드 (GPU): 마지막 문장 끝 이후 버퍼를 2초마다 다시 인식(word timestamp)
   │   → 두 번 연속 일치한 단어만 확정 → 6초가 넘으면 문장 끝에서 버퍼를 자름 (최대 20초)
   └ rolling 모드 (CPU): 새 4초 + 직전 2초 → 2초 commit horizon → 중복 제거
→ 문장 조립 (구두점 / 0.8초 쉼 / 표시 폭 120 = 한글 약 60자)
→ 언어 감지 (자동 감지면 확신도 0.8 이상에서 세션 동안 고정)
→ 한국어가 아니고 번역이 켜져 있으면 NLLB-200으로 확정 문장 + 말하는 중인 문장을 번역 (원문 보관)
→ background 공용 session → Side Panel / 독립 창 / 영상 위 두 줄 자막
→ 8초 checkpoint → TXT / SRT / VTT / JSON
```

### 측정 (v0.4.2 코드로 다시 측정)

- 환경: RTX 5060 Ti 16GB, i7-11700, Windows. CPU는 `int8`, GPU는 `float16`
- 방법: `scripts/generate_fixture.ps1`로 만든 TTS 클립을 `scripts/compare_modes.py`로 실제 서버 코드에 흘려보냄. 오디오 한 덩어리를 보내고 그 결과를 받은 뒤 다음 덩어리를 보내므로, 느린 설정도 오디오를 버리지 않고 비교됨
- "업데이트 한 번 처리 시간"이 오디오 덩어리 길이(rolling 4초, 문장 모드 2초)보다 짧으면 실시간을 따라감
- "확정까지 걸린 시간"은 문장이 끝난 시점부터 확정 자막이 나올 때까지. 그 사이에도 임시 자막은 계속 보임

**한국어 48.2초 클립 (원문 8문장, 인식 언어 `ko`)**

| 설정 | 확정 문장 수 | 업데이트 처리 (평균 / 최대) | 확정까지 (평균 / 최대) | CER |
| --- | ---: | ---: | ---: | ---: |
| small · CPU · rolling | 10 | 2.33초 / 2.44초 (오디오 4초) | 3.2초 / 4.8초 | 0.188 |
| large-v3-turbo · GPU · rolling | 10 | 0.33초 / 0.66초 (오디오 4초) | 4.0초 / 5.9초 | 0.314 |
| **large-v3-turbo · GPU · 문장 모드** | **8** | 0.31초 / 0.46초 (오디오 2초) | 3.3초 / 6.1초 | **0.112** |

- 문장 모드는 원문과 같은 8문장을 돌려주었다. 같은 클립을 인식 언어 `자동 감지` + 번역 켜짐으로 돌려도 한국어로 감지되어 번역 없이 같은 8문장이 나왔다.
- rolling 모드는 두 설정 모두 window 경계에서 잘린 조각("3.", "할 수 있습니다.", "으로 다시 설명하겠습니다.")이 남아 10문장이 되었다.
- GPU rolling의 CER이 CPU보다 높은 것은 "Fixed Point와 Floating Point와 픽스드 포인트와…"처럼 영어 표기와 한글 표기를 겹쳐 낸 window와 "실제 반복시켜 드리겠습니다" 같은 경계 오인식 때문이다. 문장 전체를 문맥으로 쓰는 문장 모드에서는 둘 다 나오지 않았다.
- CER은 공백·구두점을 뺀 글자 오류율이다. 원문이 "삼십이 비트"처럼 숫자를 한글로 적고 있어서 "32비트"로 맞게 인식해도 오류로 계산된다. 절대 정확도가 아니라 같은 클립에서 설정끼리 비교하는 용도다.
- v0.4.0 측정(문장 모드 버퍼 10초)과 비교하면 문장 모드의 평균 확정 시간이 3.0초에서 3.3초로 늘었다. 끝 문장이 빠지던 문제를 고치려고 버퍼를 6초에서 자르도록 바꾼 영향으로 보이며, 확정 문장은 8개로 같다.

**영어 17.6초 클립 (원문 4문장, 인식 언어 `자동 감지`, 한국어 번역 켜짐)**

| 설정 | 감지 언어 | 확정 문장 수 | 업데이트 처리 (평균 / 최대) | 확정까지 (평균 / 최대) | 원문 CER |
| --- | --- | ---: | ---: | ---: | ---: |
| small · CPU · rolling | en | 4 | 3.64초 / 4.84초 (오디오 4초) | 3.8초 / 4.8초 | 0.043 |
| large-v3-turbo · GPU · 문장 모드 | en | 4 | 0.75초 / 1.30초 (오디오 2초) | 3.0초 / 3.3초 | 0.043 |

- 두 설정 모두 4문장을 빠짐없이 인식했고 번역문도 같았다. 예: "The court ruled that he was not criminally liable because he acted in self-defense." → "법원은 그가 자기 방어로 행동했기 때문에 형사적으로 책임을 지지 않는다고 판결했습니다."
- 번역은 업데이트 한 번에 GPU에서 약 0.4초, CPU에서 약 1초를 더한다. CPU에서는 평균 3.64초로 4초 안에 들어오지만 최대 4.84초로 넘는 순간이 있다. 영어가 쉬지 않고 이어지는 방송에서는 대기열이 쌓일 수 있어서, README에 `base` 모델이나 번역 끄기를 안내했다.
- 원문 CER 0.043의 오류는 대부분 원문의 "thirty two bit"를 "32-bit"로 적은 표기 차이다.
- 일본어는 이 PC에 일본어 TTS 음성이 없어 같은 방식으로 측정하지 않았다. 번역 모델만 따로 시험했을 때 일상 문장은 자연스러웠고 기술 용어는 틀리는 경우가 있었다.

**실시간 속도 smoke test (v0.4.2, 켜 둔 서버에 `scripts/smoke_websocket.py`로 0.1초 단위 전송)**

서버 기본 경로(`large-v3-turbo`, CUDA, 자동으로 문장 모드)로 실제 WebSocket에 실시간 속도로 보냈다.

| 클립 | 설정 | update 수 | 확정 문장 | 마지막 대기 | 버린 오디오 |
| --- | --- | ---: | ---: | ---: | ---: |
| 한국어 48.2초 | 인식 언어 `ko` | 25 | 8 | 0.19초 | 0초 |
| 영어 17.6초 | `자동 감지` + 한국어 번역 | 10 | 4 (모두 번역, 감지 `en`) | 0초 | 0초 |

**GPU window 처리 시간 (v0.4.0, 6초 window 하나)**

| 설정 | 평균 | p95 |
| --- | ---: | ---: |
| small / CPU int8 | 1.85초 | 1.91초 |
| small / GPU float16 | 0.21초 | 0.26초 |
| large-v3-turbo / GPU float16 | 0.29초 | 0.56초 |

### 테스트

```powershell
cd local-stt-server
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
cd ..
node --test extension\tests\transcript-utils.test.js
```

- Python 58개 통과: 중복 제거·반복 루프·포함 관계(`test_streaming.py`), 문장 조립·표시 폭·LocalAgreement(`test_sentences.py`), 설정 병합·두 모드의 WebSocket 흐름·종료 flush(`test_server.py`), 언어 고정·번역 적용·번역 모델 준비 전·번역 실패 시 원문 표시(`test_language.py`), CUDA 런타임 경로(`test_cuda_runtime.py`)
- Node 11개 통과: TXT/SRT/VTT/JSON 저장과 파일 이름, 공용 상태의 순서 검사, 두 줄 자막 줄 나누기와 roll-up, 긴 문장의 SRT cue 나누기, 중지할 때 임시 자막을 한 문장으로 확정, 번역문의 원문 보관
- 테스트에 실제 모델은 쓰지 않는다. 실제 모델 확인은 위 측정과 `scripts/smoke_websocket.py`로 한다.

### 실사용 확인

Chrome과 YouTube에서 직접 확인한 항목은 `[x]`, 아직 직접 확인하지 않은 항목은 `[ ]`이다.

- [x] 서버 시작, GPU(`large-v3-turbo`)에서 문장 모드 동작
- [x] 툴바에서 STT 시작, YouTube 영상에서 자막 생성
- [x] Side Panel 전체 자막과 영상 위 두 줄 자막
- [x] 확장 프로그램을 새로고침한 뒤 overlay 복구 (v0.4.0에서 탭 새로고침으로 확인, v0.4.1부터 자동 재연결)
- [ ] v0.4.2 영어·일본어 방송에서 자동 감지와 한국어 번역
- [ ] 전체화면·극장 모드에서 overlay와 컨트롤 겹침
- [ ] 다른 영상으로 이동할 때 자동 중지
- [ ] 독립 창과 Side Panel 동기화
- [ ] TXT/SRT/VTT/JSON 다운로드 파일 열기
- [ ] 30분 이상 연속 사용 시 Chrome 메모리

### 남은 위험 요소

- **CPU + 번역:** 위 측정처럼 실시간 한계에 가깝다. 대기열은 16초에서 제한되므로 방송보다 크게 밀리지는 않지만, 넘치면 오래된 오디오를 버린다.
- **언어 자동 감지:** 처음 확신도 0.8 이상으로 감지된 언어를 고정하므로, 방송 시작이 다른 언어 노래나 인사말이면 잘못된 언어로 고정될 수 있다. 이때는 인식 언어를 직접 고르면 된다.
- **번역 품질과 라이선스:** NLLB-200은 일본어 기술 용어에 약하고, CC-BY-NC 4.0(비상업적 이용) 라이선스다.
- **문장 모드:** 말이 쉬지 않고 20초 넘게 이어지면 강제로 끊는다. 버퍼를 6초에서 자르므로 문장이 매우 길면 앞부분 문맥이 줄어든다.
- **오디오 캡처:** `ScriptProcessor`는 Chrome에서 deprecated 경고가 나온다. 현재 Chrome에서는 동작하지만, 없어지면 `AudioWorklet`으로 옮겨야 한다.
- **Chrome / YouTube:** `tabCapture`·offscreen·activeTab 정책과 `#movie_player`·`yt-navigate-finish` 같은 비공개 DOM/event에 의존한다.
- **타임코드:** 캡처 시작 기준이라 같은 영상에서 seek나 일시정지를 반복하면 영상 시간과 어긋날 수 있다.
- **긴 세션:** 화면 줄 수와 대기열은 제한하지만, 검색·저장을 위해 전체 자막 배열은 계속 커진다.
- **측정의 한계:** 모든 수치는 TTS 클립 기준이다. 실제 방송의 배경음, 여러 화자, 빠른 말은 반영되지 않는다.

---

## v0.3.0 감사 기록

> 아래는 v0.3.0 작업 당시의 기록이다. 이후 바뀐 점: word timestamp는 문장 모드에서 사용, 문장 경계는 v0.4.0의 문장 조립으로 처리, CUDA는 `setup_gpu.bat`으로 `.venv`에 런타임을 설치해 사용, 테스트 수와 수동 확인 항목은 위 [현재 상태](#현재-상태-v042)가 최신이다.

### A. Baseline

- 원본은 Git 저장소가 아니었으므로 프로젝트 폴더에서 새 저장소를 초기화했다.
- 시작 commit: `47c5795` (`chore: preserve working v0.2.3 baseline`)
- baseline tag: `v0.2.3-baseline`
- 작업 branch: `improve/streaming-stability`
- baseline 검증: Python/Chrome JavaScript 문법 검사 통과
- `.venv`, Python cache, benchmark 산출물은 Git에서 제외했다.

### 실제 코드 흐름

```text
사용자가 YouTube 탭에서 확장 아이콘 클릭
→ launcher가 activeTab 확인, offscreen 준비, /health 및 /warmup 확인
→ 사용자의 popup click과 같은 call stack에서 tabCapture stream ID 획득
→ Side Panel 열기
→ background가 page metadata/currentTime과 sessionId 저장
→ offscreen getUserMedia(tab) + AudioContext
→ 원래 탭 소리를 AudioContext.destination으로 재생
→ ScriptProcessor PCM → 16 kHz mono PCM16
→ WebSocket receiver → 16초 bounded PCM queue
→ STT worker → 4초 new audio + 2초 이전 context
→ faster-whisper segment timestamp
→ 2초 commit horizon stabilizer
→ final segments + provisional tail
→ background 공용 session
→ Side Panel / detached window delta update
→ video player 내부 overlay
→ 8초 checkpoint 및 stop 시 force save
→ TXT / SRT / VTT / JSON export
```

`launcher`에서 `getMediaStreamId()` 전에 `await`하지 않는 v0.2.3의 권한 경로는 그대로 유지했다.

### B. 발견한 문제

#### Critical

- 없음. 실제 동작 baseline을 파괴하는 즉시 실패 결함은 발견되지 않았다.

#### High

- WebSocket receive와 Whisper inference가 한 coroutine에 직렬 결합되어 있었다. CPU가 실시간보다 느리면 브라우저/네트워크 buffer가 사실상 무제한 증가할 수 있었다.
- 모든 5초 결과가 즉시 final이 되어 chunk 경계 재해석과 앞 문장 확장을 수정할 방법이 없었다.
- faster-whisper segment timestamp를 버리고 `video.currentTime - chunk duration`으로 시간을 근사했다.
- exact token/character overlap만 지원해 한국어 띄어쓰기 차이, 한 글자 재인식, provisional extension을 처리하지 못했다.
- 같은 탭에서 YouTube SPA로 영상이 바뀌어도 이전 세션이 계속될 수 있었다.

#### Medium

- segment마다 전체 session을 `chrome.storage.local`에 저장하고 UI 두 곳에 전체 state를 전송했다.
- UI가 매 update마다 모든 transcript DOM을 `innerHTML`로 다시 만들었다.
- 사용자가 위로 스크롤한 상태에서도 새 결과가 오면 아래로 이동할 수 있었다.
- overlay가 viewport 기준 fixed DOM이어서 player/theater/fullscreen과 정렬이 어긋날 수 있었다.
- overlay 위치/크기/불투명도 설정 및 SPA 재부착 경로가 없었다.
- 서버의 VAD silence가 300ms로 코드에 고정되어 있었고 threshold/padding/hallucination 설정을 측정하기 어려웠다.
- 정상 stop에서 마지막 1~2초 미만 오디오와 provisional 결과가 사라질 수 있었다.

#### Low

- faster-whisper/httpx 상세 로그가 일반 실행에 섞였다.
- Side Panel 시작 안내가 길고 Chrome 권한 제약의 핵심 행동이 한눈에 보이지 않았다.
- 파일명에서 Windows reserved name 및 trailing dot/space를 처리하지 않았다.

### C. 실제 수정

| 파일 | 문제 | 변경과 이유 |
|---|---|---|
| `local-stt-server/streaming.py` | streaming state와 dedup 부재 | bounded PCM buffer, timestamp mapper, final/provisional stabilizer, 시간 제한 fuzzy overlap 추가 |
| `local-stt-server/server.py` | receive/inference 직렬, timestamp 손실 | receiver/worker 분리, bounded queue, segment 결과, graceful flush, metrics, 선택 prompt/VAD/hallucination 옵션 추가 |
| `local-stt-server/server_config.json` | 5+1 고정, VAD 하드코딩 | 4+2, horizon 2, queue 16, VAD 500ms, word timestamps off, debug off를 명시 |
| `extension/offscreen.js` | 단일 transcript protocol, 마지막 오디오 손실 | sessionId 포함 update 전달, stop/ack 2.5초 flush, 이전 server message 호환 유지 |
| `extension/background.js` | 전체 저장/방송, 근사 timestamp | 공용 final/provisional session, absolute timeline, delta broadcast, 8초 checkpoint, live metrics, SPA stop 정책 |
| `extension/content.js` | viewport fixed overlay, persistence 부족 | player 내부 단일 DOM, controls-visible offset, top/center/bottom, size/opacity, SPA/fullscreen 재부착 |
| `extension/sidepanel.*` | 전체 DOM 재렌더, provisional 구분 없음 | 최근 500 DOM, 전체 검색/export data 유지, provisional style, scroll guard, delay와 최소 설정 UI |
| `extension/transcript-utils.js` | export 로직 UI에 결합 | 4종 export/filename/delta pure function으로 분리해 Node test 가능하게 함 |
| `extension/manifest.json` | 버전 불일치 | `0.3.0`으로 갱신 |
| `scripts/*` | 재현 가능한 성능/장시간/화면 fixture 없음 | 한국어 TTS fixture, rolling benchmark, 30m/1h/3h simulator, visual QA harness 추가 |

### D. Streaming STT 설계

- 새 audio chunk: `4.0s`
- 이전 audio context: `2.0s`
- 일반 Whisper window: `6.0s`
- provisional 범위: 최신 Whisper segment 중 commit horizon 뒤쪽
- commit horizon: `2.0s`
- queue max: `16.0s` PCM
- overload policy: 가장 오래된 **미처리** PCM을 버리고 새 live 위치를 유지한다. drop 누적은 UI와 `/health` metrics로 노출한다.
- VAD:
  - threshold `0.5`
  - min speech `250ms`
  - min silence `500ms`
  - speech padding `300ms`
- hallucination:
  - no speech `0.6`
  - log probability `-1.0`
  - compression ratio `2.4`
  - hallucination silence `2.0s`
- word timestamps: 기본 `false`; segment timestamp만 사용한다.
- initial prompt: 기본값 없음. benchmark에서 기본 prompt 자체가 발화처럼 생성된 사례가 있어 사용자 선택 prompt만 허용한다.
- merge:
  - 시간 overlap이 있는 후보만 dedup한다.
  - NFKC/case/공백/구두점을 무시한 suffix-prefix를 먼저 사용한다.
  - 길이 10자 이상인 경우에만 제한적 fuzzy 비교를 사용한다.
  - 시간적으로 떨어진 동일 문장은 실제 반복으로 보존한다.
- sentence boundary: 별도 복잡한 한국어 regex splitter는 넣지 않았다. VAD boundary, Whisper segment boundary, commit horizon을 사용한다. regex가 실제 반복/기술용어를 오분할할 위험이 현재 이득보다 컸다.

### E. 성능

#### 실제 faster-whisper benchmark

- 환경: `small / cpu / int8`, 48.19초 Windows 한국어 TTS 기술 강의 fixture
- CPU %는 process 전체 합산값으로 약 4 logical core 사용을 뜻한다.
- CER은 TTS reference 대비 공백/구두점 제거 character error rate다. 숫자/영어 표기 차이도 오류로 계산되므로 절대 정확도보다 같은 fixture 상대 비교용이다.

| new + overlap | 평균 추론 | p95 | 추정 지속 backlog | CER | 중복 초과율 |
|---|---:|---:|---:|---:|---:|
| baseline 성격 5+1 | 2.147s | 2.641s | 0.0s | 0.1749 | 0% |
| 3+1.5 | 1.925s | 2.061s | 0.0s | 0.2915 | 2.62% |
| **선택 4+2** | **1.976s** | **2.190s** | **0.0s** | **0.2466** | **0%** |
| 5+2 | 1.933s | 2.094s | 0.0s | 0.2780 | 8.61% |

5+1은 이 짧은 fixture의 CER이 가장 낮았지만 첫 update와 평균 live 반영이 약 1초 늦다. 제안된 rolling 후보 중 4+2가 중복 0%와 가장 낮은 CER을 동시에 보였고, 발화 시점부터 provisional 표시까지 평균 약 `chunk/2 + inference ≈ 4.0s`다. 따라서 3~5초 사용 목표와 문맥 길이 사이의 기본값으로 선택했다.

`4+2 / word_timestamps=true`는 같은 일괄 run에서 평균 1.992s, CER 0.2466으로 text 품질 이득이 없었다. 별도 run에서는 시스템 부하에 따라 더 큰 비용도 관찰되어 기본값을 끈다.

- peak RSS: 약 `440–442MB` (Whisper model 포함)
- process CPU: 약 `389–394%` (다중 thread 합산)

#### 장시간 합성 stream

고의로 inference `5.2s > 4s chunk`인 overload를 빠르게 시뮬레이션했다.

| stream | segments | max queue | dropped | transcript JSON | DOM | Python traced peak |
|---|---:|---:|---:|---:|---:|---:|
| 30분 | 342 | 16.0s | 416.1s | 0.025MB | 342 | 1.289MB |
| 1시간 | 682 | 16.0s | 857.6s | 0.051MB | 500 | 1.404MB |
| 3시간 | 2065 | 16.0s | 2526.6s | 0.156MB | 500 | 1.932MB |

이 시나리오는 drop 동작을 일부러 유도한다. queue/RAM은 16초에서 제한되고 실제 방송보다 수십 분 뒤로 밀리지 않는다. 3시간 추정 전체-session storage serialization은 segment마다 저장하는 방식 약 160MB에서 8초 checkpoint 약 105MB로 감소했다. transcript 원본 배열은 export/search를 위해 계속 유지한다.

### F. 테스트

```powershell
.\local-stt-server\.venv\Scripts\python.exe -m py_compile local-stt-server\server.py local-stt-server\streaming.py
.\local-stt-server\.venv\Scripts\python.exe -m unittest discover -s local-stt-server\tests -v
node --test extension\tests\transcript-utils.test.js
node --check extension\background.js
node --check extension\offscreen.js
node --check extension\content.js
node --check extension\sidepanel.js
node --check extension\launcher.js
git diff --check
```

- Python: 19 passed
- Node: 5 passed
- WebSocket integration: config → binary PCM → provisional → stop flush → ack → restart sequence reset 통과
- export: TXT/SRT/VTT/JSON, UTF-8 한국어, timestamp monotonic, filename validation 통과
- server smoke: `/health` → `/warmup` → `small/cpu/int8`, `4+2`, horizon 2, queue 16 확인
- real-model WebSocket smoke: 12초 PCM에서 update 4회, final 3개, queue 0초, drop 0초, stop ack 확인
- CUDA smoke: 현 시스템의 `cublas64_12.dll` 오류 후 CPU int8 fallback 확인
- visual QA: 360px Side Panel, detached width, settings expansion, 500 DOM cap, player overlay 상/중/하 및 controls offset 확인

### G. 수동 테스트 체크리스트

자동/화면 fixture로 확인한 항목은 `[x]`, 실제 Chrome+YouTube에서 사용자가 최종 확인해야 하는 항목은 `[ ]`이다.

- [x] Python server health/warmup와 CPU fallback
- [x] WebSocket start/stop/flush/restart
- [x] final/provisional/dedup/timestamp unit tests
- [x] TXT/SRT/VTT/JSON format tests
- [x] Side Panel/독립 창/overlay visual fixture
- [ ] 실제 서버 시작
- [ ] 실제 YouTube 영상에서 toolbar STT start
- [ ] 3~5초 수준 provisional 자막 생성
- [ ] 실제 영상에서 Side Panel과 detached window 동기화
- [ ] 실제 전체화면/극장모드 overlay와 controls 겹침
- [ ] 실제 YouTube 영상 A → B navigation 시 안전 중지
- [ ] 검색 중 및 위로 스크롤 중 auto-scroll 억제
- [ ] 실제 stop 후 즉시 restart
- [ ] 실제 server kill 후 capture release와 recovery
- [ ] 실제 TXT/SRT/VTT/JSON 다운로드 파일 열기
- [ ] 실제 30분/1시간 연속 사용의 Chrome memory 확인

### H. 남은 위험요소

- Chrome: `tabCapture`, offscreen, activeTab user gesture 정책은 Chrome 버전 변화 영향을 받는다. popup의 동기 `getMediaStreamId()` 경로를 유지했다.
- YouTube: `#movie_player`, metadata selector, `yt-navigate-finish`는 비공개 DOM/event다. 실패 시 overlay가 잠시 사라질 수 있으나 content ready와 다음 transcript update에서 재시도한다.
- Whisper: synthetic TTS benchmark는 실제 마이크/방송 음질, 화자, 배경음, 숫자/영어 혼합을 완전히 대표하지 않는다.
- Merge: 시간 overlap 안의 큰 재인식 차이는 중복 또는 짧은 누락으로 남을 수 있다. 공격적 fuzzy 삭제보다 실제 반복 보존을 우선했다.
- Long-running: Python queue와 DOM은 제한했지만 전체 transcript/session JSON은 export/search를 위해 계속 증가한다. 매우 긴 다일 stream에서는 chunked storage가 추가로 필요할 수 있다.
- Timestamp: capture 시작 기준 매핑은 정상 재생에 적합하다. 사용자가 같은 영상에서 seek/일시정지를 반복하면 audio elapsed와 video timeline이 어긋날 수 있다. 다른 video navigation은 자동 중지한다.
- CUDA: CUDA DLL 구성은 변경하지 않았다. GPU preflight 실패 시 CPU int8이 정상 기본 경로다.
- 실제 Chrome E2E: 자동 환경에서 `tabCapture` 권한 prompt를 재현하지 않았으므로 위 수동 checklist가 release 전 최종 gate다.
