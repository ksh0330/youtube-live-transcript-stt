# YouTube Live Transcript STT

자막(CC)이 없는 YouTube 라이브도 **내 PC에서 실시간으로 받아쓰는** Chrome 확장 프로그램입니다.
탭 오디오를 로컬 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 서버로 보내 전사하며, 오디오는 외부로 전송되지 않습니다.

[최신 릴리스](https://github.com/ksh0330/youtube-live-transcript-stt/releases/latest) · [변경 이력](docs/CHANGELOG.md) · [감사·성능 보고서](docs/AUDIT_REPORT.md) · [포트폴리오](https://ksh0330.github.io/projects/youtube-live-stt/)

## 주요 기능

- 탭 오디오를 캡처하면서 방송 소리는 그대로 재생
- 약 4초마다 자막 갱신, 확정 자막과 수정될 수 있는 임시 자막을 구분
- Side Panel·독립 창·영상 위 overlay에 같은 세션 표시
- 자막 검색, TXT / SRT / VTT / JSON 저장
- NVIDIA GPU가 있으면 CUDA, 없거나 실패하면 CPU로 자동 전환

## 빠른 시작 (Windows)

준비물: Chrome 116+, Python 3.10+

1. [릴리스](https://github.com/ksh0330/youtube-live-transcript-stt/releases/latest)에서 zip을 받아 압축을 풉니다. (또는 저장소를 clone)
2. `local-stt-server/start_server.bat` 실행
   - 첫 실행 때 가상환경 생성과 패키지 설치를 자동으로 합니다.
   - `http://127.0.0.1:8765/health`에서 `"ok": true`가 보이면 준비 완료입니다.
3. Chrome `chrome://extensions` → **개발자 모드** ON → **압축해제된 확장 프로그램을 로드합니다** → `extension` 폴더 선택
4. YouTube 탭을 새로고침하고, 툴바의 **YT Live STT** 아이콘 → **현재 YouTube 탭 STT 시작**

중지는 Side Panel이나 독립 창에서, 다시 시작은 툴바 아이콘에서 합니다. 첫 시작 때 Whisper 모델(small, 약 460MB)을 내려받습니다.

## 동작 방식

```text
YouTube 탭 오디오 ─ tabCapture ─▶ offscreen 문서 (16 kHz mono PCM16)
   ─ WebSocket 127.0.0.1:8765 ─▶ faster-whisper ─▶ 안정화(확정/임시) ─▶ Side Panel · overlay
```

- **Rolling window:** 새 오디오 4초에 직전 2초를 붙여 6초 단위로 인식합니다.
- **확정/임시:** 마지막 약 2초는 임시로 표시되고, 다음 window에서 고쳐진 뒤 확정됩니다.
- **중복 제거:** 겹치는 구간을 다시 인식한 결과는 시간(±1초)과 텍스트를 함께 비교해 한 번만 남깁니다. 시간이 떨어진 실제 반복 발화는 지우지 않습니다.
- **반복 루프 제거:** 음악·무음에서 Whisper가 같은 문구를 3번 이상 반복하면 하나로 합칩니다.
- **밀림 방지:** CPU가 실시간보다 느리면 처리 대기 오디오를 최대 16초로 제한하고 가장 오래된 부분부터 버립니다. 버린 시간은 UI에 표시됩니다.

## 설정

`local-stt-server/server_config.json`에서 바꿉니다. 자주 쓰는 항목만 정리했습니다.

| 항목 | 기본값 | 설명 |
| --- | --- | --- |
| `model_size` | `small` | CPU에서 느리면 `base`, NVIDIA GPU가 있으면 `large-v3-turbo` |
| `language` | `ko` | 인식 언어 |
| `device` | `auto` | `auto`는 CUDA를 먼저 시도하고 실패하면 CPU `int8` |
| `chunk_seconds` / `overlap_seconds` | `4.0` / `2.0` | 새 오디오 길이 / 앞 window와 겹치는 길이 |
| `reprediction_tolerance_seconds` | `1.0` | 다시 인식된 같은 문장으로 볼 시간 허용 범위 |
| `queue_max_seconds` | `16.0` | 처리 대기 오디오 상한 |
| `debug_logging` | `false` | 상세 로그 |

이 PC에서만 바꿀 값은 `local-stt-server/server_config.local.json`에 적으면 됩니다. 기본 설정 위에 덮어쓰고, Git에는 올라가지 않습니다.

### NVIDIA GPU로 더 빠르고 정확하게

1. `start_server.bat`을 한 번 실행한 뒤 `setup_gpu.bat` 실행 (CUDA 런타임을 `.venv`에만 설치하고 실제 추론으로 확인)
2. `server_config.local.json`에 더 큰 모델을 지정하고 서버 재시작

```json
{ "model_size": "large-v3-turbo" }
```

RTX 5060 Ti에서 6초 window 하나를 처리하는 시간(48초 한국어 강의 클립):

| 설정 | 평균 | p95 |
| --- | ---: | ---: |
| small / CPU int8 (i7-11700) | 1.85초 | 1.91초 |
| small / GPU float16 | 0.21초 | 0.26초 |
| large-v3-turbo / GPU float16 | 0.29초 | 0.56초 |

large-v3-turbo는 "C 언어의 int와 long 자료형, C89와 C99"처럼 영어·숫자 혼합과 띄어쓰기를 small보다 정확하게 인식했습니다. 첫 실행 때 모델(약 1.5GB)을 내려받습니다.

## 문제 해결

| 증상 | 해결 |
| --- | --- |
| 인식이 부정확하거나 `STT 지연`이 계속 큼 | NVIDIA GPU가 있으면 위 GPU 설정. 없으면 `model_size`를 `base`로 낮추거나, 오버레이·인식 문맥 설정에 주제와 고유명사를 적기 |
| `GPU runtime unavailable` / `cublas64_12.dll` 오류 | 자동으로 CPU로 전환된 상태입니다. GPU를 쓰려면 `setup_gpu.bat` 실행 |
| `Cannot capture a tab with an active stream` | 팝업의 **남아 있는 캡처 강제 해제** → 다시 시도 |
| 시작 버튼이 Side Panel에 없음 | Chrome은 Side Panel 클릭으로 탭 캡처 권한을 주지 않아서, 시작은 툴바 팝업에서만 합니다 |
| 영상을 바꾸면 기록이 멈춤 | 다른 영상의 자막이 섞이지 않도록 의도한 동작입니다 |

## 측정 결과

48초 한국어 TTS 강의 클립, `small / cpu / int8` 기준입니다. 자세한 조건은 [AUDIT_REPORT.md](docs/AUDIT_REPORT.md)에 있습니다.

- window 비교에서 4+2초가 평균 추론 1.98초(p95 2.19초), 중복 초과율 0%로 기본값으로 선택됨
- 30분·1시간·3시간 과부하 시뮬레이션에서 대기 오디오 16초, 화면 줄 수 500개로 제한
- v0.3.1 실시간 스트리밍 smoke test: update 13회, 대기 0.19초, 버린 오디오 0초. 수정 전 나오던 "자료형 크기를 반드시 자료형 크기를" 같은 경계 중복이 사라지고, 의도적으로 반복한 마지막 문장은 유지됨
- Whisper 모델 포함 메모리 약 440MB

## 한계

- 빠른 화자 전환, 큰 배경음, 숫자·영어 혼합에서는 window 경계 인식이 흔들릴 수 있습니다.
- 정밀한 자막 편집보다 라이브 기록·검색·요약 용도에 맞습니다.
- 재생 중 seek나 일시정지를 반복하면 타임코드가 영상과 어긋날 수 있습니다.
- Chrome의 탭 캡처 정책이나 YouTube 페이지 구조가 바뀌면 영향을 받을 수 있습니다.

## 개발

```bash
cd local-stt-server
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v          # Python 37개

cd ..
node --test extension/tests/transcript-utils.test.js   # Node 5개
```

실제 모델로 확인하려면 서버를 켠 뒤 다음을 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/generate_fixture.ps1
python scripts/smoke_websocket.py benchmark-results/lecture-fixture.wav --duration 50
```

`scripts/benchmark_whisper.py`(window 비교), `scripts/simulate_long_run.py`(장시간 부하), `scripts/*-harness.html`(화면 점검)도 있습니다.
