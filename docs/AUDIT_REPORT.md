# v0.3.0 코드 감사 및 안정화 보고서

## A. Baseline

- 원본은 Git 저장소가 아니었으므로 프로젝트 폴더에서 새 저장소를 초기화했다.
- 시작 commit: `47c5795` (`chore: preserve working v0.2.3 baseline`)
- baseline tag: `v0.2.3-baseline`
- 작업 branch: `improve/streaming-stability`
- baseline 검증: Python/Chrome JavaScript 문법 검사 통과
- `.venv`, Python cache, benchmark 산출물은 Git에서 제외했다.

## 실제 코드 흐름

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

## B. 발견한 문제

### Critical

- 없음. 실제 동작 baseline을 파괴하는 즉시 실패 결함은 발견되지 않았다.

### High

- WebSocket receive와 Whisper inference가 한 coroutine에 직렬 결합되어 있었다. CPU가 실시간보다 느리면 브라우저/네트워크 buffer가 사실상 무제한 증가할 수 있었다.
- 모든 5초 결과가 즉시 final이 되어 chunk 경계 재해석과 앞 문장 확장을 수정할 방법이 없었다.
- faster-whisper segment timestamp를 버리고 `video.currentTime - chunk duration`으로 시간을 근사했다.
- exact token/character overlap만 지원해 한국어 띄어쓰기 차이, 한 글자 재인식, provisional extension을 처리하지 못했다.
- 같은 탭에서 YouTube SPA로 영상이 바뀌어도 이전 세션이 계속될 수 있었다.

### Medium

- segment마다 전체 session을 `chrome.storage.local`에 저장하고 UI 두 곳에 전체 state를 전송했다.
- UI가 매 update마다 모든 transcript DOM을 `innerHTML`로 다시 만들었다.
- 사용자가 위로 스크롤한 상태에서도 새 결과가 오면 아래로 이동할 수 있었다.
- overlay가 viewport 기준 fixed DOM이어서 player/theater/fullscreen과 정렬이 어긋날 수 있었다.
- overlay 위치/크기/불투명도 설정 및 SPA 재부착 경로가 없었다.
- 서버의 VAD silence가 300ms로 코드에 고정되어 있었고 threshold/padding/hallucination 설정을 측정하기 어려웠다.
- 정상 stop에서 마지막 1~2초 미만 오디오와 provisional 결과가 사라질 수 있었다.

### Low

- faster-whisper/httpx 상세 로그가 일반 실행에 섞였다.
- Side Panel 시작 안내가 길고 Chrome 권한 제약의 핵심 행동이 한눈에 보이지 않았다.
- 파일명에서 Windows reserved name 및 trailing dot/space를 처리하지 않았다.

## C. 실제 수정

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

## D. Streaming STT 설계

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

## E. 성능

### 실제 faster-whisper benchmark

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

### 장시간 합성 stream

고의로 inference `5.2s > 4s chunk`인 overload를 빠르게 시뮬레이션했다.

| stream | segments | max queue | dropped | transcript JSON | DOM | Python traced peak |
|---|---:|---:|---:|---:|---:|---:|
| 30분 | 342 | 16.0s | 416.1s | 0.025MB | 342 | 1.289MB |
| 1시간 | 682 | 16.0s | 857.6s | 0.051MB | 500 | 1.404MB |
| 3시간 | 2065 | 16.0s | 2526.6s | 0.156MB | 500 | 1.932MB |

이 시나리오는 drop 동작을 일부러 유도한다. queue/RAM은 16초에서 제한되고 실제 방송보다 수십 분 뒤로 밀리지 않는다. 3시간 추정 전체-session storage serialization은 segment마다 저장하는 방식 약 160MB에서 8초 checkpoint 약 105MB로 감소했다. transcript 원본 배열은 export/search를 위해 계속 유지한다.

## F. 테스트

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

## G. 수동 테스트 체크리스트

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

## H. 남은 위험요소

- Chrome: `tabCapture`, offscreen, activeTab user gesture 정책은 Chrome 버전 변화 영향을 받는다. popup의 동기 `getMediaStreamId()` 경로를 유지했다.
- YouTube: `#movie_player`, metadata selector, `yt-navigate-finish`는 비공개 DOM/event다. 실패 시 overlay가 잠시 사라질 수 있으나 content ready와 다음 transcript update에서 재시도한다.
- Whisper: synthetic TTS benchmark는 실제 마이크/방송 음질, 화자, 배경음, 숫자/영어 혼합을 완전히 대표하지 않는다.
- Merge: 시간 overlap 안의 큰 재인식 차이는 중복 또는 짧은 누락으로 남을 수 있다. 공격적 fuzzy 삭제보다 실제 반복 보존을 우선했다.
- Long-running: Python queue와 DOM은 제한했지만 전체 transcript/session JSON은 export/search를 위해 계속 증가한다. 매우 긴 다일 stream에서는 chunked storage가 추가로 필요할 수 있다.
- Timestamp: capture 시작 기준 매핑은 정상 재생에 적합하다. 사용자가 같은 영상에서 seek/일시정지를 반복하면 audio elapsed와 video timeline이 어긋날 수 있다. 다른 video navigation은 자동 중지한다.
- CUDA: CUDA DLL 구성은 변경하지 않았다. GPU preflight 실패 시 CPU int8이 정상 기본 경로다.
- 실제 Chrome E2E: 자동 환경에서 `tabCapture` 권한 prompt를 재현하지 않았으므로 위 수동 checklist가 release 전 최종 gate다.
