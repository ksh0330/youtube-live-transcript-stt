# YouTube Live Transcript STT

[![tests](https://github.com/ksh0330/youtube-live-transcript-stt/actions/workflows/tests.yml/badge.svg)](https://github.com/ksh0330/youtube-live-transcript-stt/actions/workflows/tests.yml)
[![release](https://img.shields.io/github/v/release/ksh0330/youtube-live-transcript-stt)](https://github.com/ksh0330/youtube-live-transcript-stt/releases/latest)

자막(CC)이 없는 YouTube 라이브도 **내 PC에서 실시간으로 받아쓰는** Chrome 확장 프로그램입니다.
탭 오디오를 로컬 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 서버로 보내 전사하며, 오디오는 외부로 전송되지 않습니다.

[최신 릴리스](https://github.com/ksh0330/youtube-live-transcript-stt/releases/latest) · [변경 이력](docs/CHANGELOG.md) · [감사·성능 보고서](docs/AUDIT_REPORT.md) · [포트폴리오](https://ksh0330.github.io/projects/youtube-live-stt/)

## 주요 기능

- 탭 오디오를 캡처하면서 방송 소리는 그대로 재생
- **문장 단위 자막:** 말하는 중인 문장은 한 줄로 이어지고(바뀔 수 있는 끝부분은 흐리게), 문장이 끝나면 확정
- 영상 위 자막은 YouTube CC처럼 한 줄 26자 안팎의 짧은 두 줄이 위로 밀려 올라감 (SRT/VTT도 같은 규칙으로 저장)
- NVIDIA GPU에서는 문장 전체를 다시 인식해 확정하는 **문장 모드**로 경계 오인식을 줄임
- **다른 언어:** 인식 언어를 자동 감지·한국어·영어·일본어·중국어 중에서 고르고, 영어·일본어 등은 **한국어로 번역해서** 보여 줌 (원문은 Side Panel에 작게 함께 표시)
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
   ─ WebSocket 127.0.0.1:8765 ─▶ faster-whisper ─▶ 확정 ─▶ 문장 조립 ─▶ Side Panel · overlay
```

인식 방식은 장치에 따라 자동으로 고릅니다(`streaming_mode: auto`).

| | 문장 모드 (GPU) | Rolling 모드 (CPU) |
| --- | --- | --- |
| 인식 단위 | 마지막으로 끝난 문장 이후의 오디오 전체를 2초마다 다시 인식 | 새 오디오 4초 + 직전 2초 |
| 확정 기준 | 연속 두 번의 인식 결과가 일치한 단어만 확정 (LocalAgreement) | 끝에서 2초 이전 구간을 확정 |
| 장점 | 문장 전체를 문맥으로 써서 경계에서 잘리거나 겹치는 일이 적음 | 연산량이 일정해서 CPU에서도 실시간 유지 |

- **문장 조립:** 확정된 조각을 모아 마침표·물음표, 0.8초 이상 쉼, 60자 초과 중 하나가 오면 한 문장으로 확정합니다.
- **자막 줄 나누기:** 화면 자막과 SRT/VTT는 단어 단위로 줄을 나누고 줄 길이를 고르게 맞춥니다("…형사 책임을 묻지 / 않는데요."처럼 끝 단어만 남는 줄을 만들지 않음). 글자 크기 작게·보통·크게에 따라 한 줄 30·26·22자입니다.
- **중복 제거:** 겹치는 구간을 다시 인식한 결과는 시간(±1초)과 텍스트를 함께 비교해 한 번만 남깁니다. 시간이 떨어진 실제 반복 발화는 지우지 않습니다.
- **반복 루프 제거:** 음악·무음에서 Whisper가 같은 문구를 3번 이상 반복하면 하나로 합칩니다.
- **밀림 방지:** CPU가 실시간보다 느리면 처리 대기 오디오를 최대 16초로 제한하고 가장 오래된 부분부터 버립니다. 버린 시간은 UI에 표시됩니다.

## 다른 언어와 한국어 번역

Side Panel의 **언어·오버레이·인식 문맥 설정**에서 고르고 **설정 저장**을 누르면 다음 STT 시작부터 적용됩니다.

- **인식 언어:** 기본은 `자동 감지`입니다. 처음에 확신도 0.8 이상으로 감지된 언어를 그 세션 동안 고정해서, 음악이나 고유명사 때문에 언어가 왔다 갔다 하지 않습니다.
- **한국어로 번역해서 보기 (기본 켜짐):** 한국어가 아닌 말은 문장 단위로 한국어로 번역해서 보여 줍니다. Whisper의 자체 번역은 영어로만 되기 때문에, 번역에는 로컬 [NLLB-200](https://huggingface.co/OpenNMT/nllb-200-distilled-1.3B-ct2-int8) 1.3B 모델(CTranslate2 int8)을 따로 씁니다.
  - 처음 쓸 때 번역 모델(약 1.4GB)을 내려받고, 준비되는 동안에는 원문이 그대로 보입니다.
  - 번역을 켜면 업데이트 한 번이 GPU(RTX 5060 Ti)에서 약 0.4초 늘어납니다. CPU에서는 부담을 줄이려고 말하는 중인 문장은 원문으로 보여 주고, 문장이 끝나면 번역합니다. 이렇게 해서 CPU(i7-11700)에서 4초 분량 오디오 처리가 평균 3.6초(최대 4.8초)에서 2.9초(최대 3.9초)로 줄었습니다. CPU에서도 말하는 중인 문장까지 번역하려면 `translate_current_sentence`를 `true`로 바꾸세요.
  - 영어는 번역 품질이 좋은 편입니다. 일본어는 일상 문장은 자연스럽지만, 기술 용어는 틀리게 번역할 수 있습니다.
- 번역된 자막 아래에는 원문이 작게 표시되고, TXT 저장에는 `(원문)` 줄이 함께 들어갑니다. SRT/VTT에는 번역문만 들어갑니다.

## 설정

`local-stt-server/server_config.json`에서 바꿉니다. 자주 쓰는 항목만 정리했습니다.

| 항목 | 기본값 | 설명 |
| --- | --- | --- |
| `model_size` | `small` | CPU에서 느리면 `base`, NVIDIA GPU가 있으면 `large-v3-turbo` |
| `language` | `ko` | 확장 프로그램이 언어를 보내지 않을 때 쓰는 기본 인식 언어 |
| `translation_model` | `OpenNMT/nllb-200-distilled-1.3B-ct2-int8` | 번역 모델 (Hugging Face 저장소 이름 또는 로컬 경로) |
| `translate_current_sentence` | `auto` | 말하는 중인 문장도 번역할지. `auto`는 GPU에서만 번역하고 CPU에서는 끝난 문장만 번역 |
| `streaming_mode` | `auto` | `auto`는 GPU면 `sentence`, CPU면 `rolling` |
| `sentence_pause_seconds` / `sentence_max_chars` | `0.8` / `60` | 문장을 끊는 쉼 길이 / 문장 최대 길이 (한글 기준, 영어는 약 2배) |
| `device` | `auto` | `auto`는 CUDA를 먼저 시도하고 실패하면 CPU `int8` |
| `chunk_seconds` / `overlap_seconds` | `4.0` / `2.0` | 새 오디오 길이 / 앞 window와 겹치는 길이 |
| `reprediction_tolerance_seconds` | `1.0` | 다시 인식된 같은 문장으로 볼 시간 허용 범위 |
| `queue_max_seconds` | `16.0` | 처리 대기 오디오 상한 |
| `debug_logging` | `false` | 상세 로그 |

이 PC에서만 바꿀 값은 `local-stt-server/server_config.local.json`에 적으면 됩니다. 기본 설정 위에 덮어쓰고, Git에는 올라가지 않습니다.

### NVIDIA GPU로 더 빠르고 정확하게

1. `start_server.bat`을 한 번 실행한 뒤 `setup_gpu.bat` 실행 (CUDA 런타임을 `.venv`에만 설치하고 실제 추론으로 확인)
2. `server_config.local.json`에 더 큰 모델을 지정하고 서버 재시작 (GPU에서는 문장 모드가 자동으로 켜지고, Side Panel 서버 상태에 `문장 모드`가 보입니다)

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
| 영상 위 자막만 안 보이고 Side Panel에는 나옴 | YouTube 탭을 새로고침 (v0.4.1부터는 확장 프로그램 업데이트 때 자동으로 다시 연결) |
| 번역이 안 되고 원문만 나옴 | 처음에는 번역 모델(약 1.4GB)을 내려받는 중입니다. 계속 원문만 나오면 `http://127.0.0.1:8765/health`의 `translation_error` 확인 |
| 언어가 잘못 감지됨 | 방송 시작 부분의 음악이나 다른 언어 때문일 수 있습니다. 설정에서 인식 언어를 직접 고르기 |
| `Cannot capture a tab with an active stream` | 팝업의 **남아 있는 캡처 강제 해제** → 다시 시도 |
| 시작 버튼이 Side Panel에 없음 | Chrome은 Side Panel 클릭으로 탭 캡처 권한을 주지 않아서, 시작은 툴바 팝업에서만 합니다 |
| 영상을 바꾸면 기록이 멈춤 | 다른 영상의 자막이 섞이지 않도록 의도한 동작입니다 |

## 측정 결과

v0.4.2 코드로 다시 측정했습니다. TTS로 만든 클립을 실제 서버 코드에 실시간 순서로 흘려보냈고, RTX 5060 Ti와 i7-11700 기준입니다. `scripts/compare_modes.py`로 같은 측정을 다시 할 수 있습니다([개발](#개발) 참고).

### 한국어: 인식 방식 비교

48초 한국어 강의 클립(원문 8문장)입니다.

| 설정 | 확정 문장 수 | 업데이트 한 번 처리 시간 | 확정까지 걸린 시간 (평균 / 최대) |
| --- | ---: | ---: | ---: |
| small · CPU · rolling | 10 | 2.33초 / 오디오 4초 | 3.2초 / 4.8초 |
| large-v3-turbo · GPU · rolling | 10 | 0.33초 / 오디오 4초 | 4.0초 / 5.9초 |
| **large-v3-turbo · GPU · 문장 모드** | **8** | 0.31초 / 오디오 2초 | **3.3초** / 6.1초 |

- Rolling 모드는 window 경계에서 "3.", "할 수 있습니다.", "으로 다시 설명하겠습니다."처럼 문장이 잘린 조각이 남았습니다.
- 문장 모드는 원문과 같은 8문장으로 나뉘었고, "C 언어의 인트와 롱 자료형, C89와 C99 표준도 비교하겠습니다."처럼 문장 단위로 정확하게 확정했습니다. 인식 언어를 `자동 감지`로 두어도 한국어로 감지되어 결과가 같았습니다.
- "확정까지 걸린 시간"은 문장이 끝난 시점부터 확정 자막이 나올 때까지입니다. 말하는 중에는 그 사이에도 임시 자막이 계속 보입니다.

### 영어 → 한국어 번역

18초 영어 클립(원문 4문장)을 인식 언어 `자동 감지`, 한국어 번역 켜짐으로 흘려보냈습니다.

| 설정 | 감지 언어 | 확정 문장 수 | 업데이트 한 번 처리 시간 (평균 / 최대) | 확정까지 걸린 시간 (평균 / 최대) |
| --- | --- | ---: | ---: | ---: |
| small · CPU · rolling | 영어 | 4 | 2.92초 / 3.90초 (오디오 4초) | 3.8초 / 4.8초 |
| large-v3-turbo · GPU · 문장 모드 | 영어 | 4 | 0.75초 / 1.30초 (오디오 2초) | 3.0초 / 3.3초 |

두 설정 모두 4문장을 빠짐없이 인식했고, 번역 결과도 같았습니다. CPU에서는 말하는 중인 문장을 번역하지 않습니다(위 [다른 언어와 한국어 번역](#다른-언어와-한국어-번역) 참고).

| 원문 | 번역 |
| --- | --- |
| A 32-bit value can hold both an integer part and a fraction part. | 32비트 값은 정수 부분과 분수 부분을 모두 포함할 수 있습니다. |
| The court ruled that he was not criminally liable because he acted in self-defense. | 법원은 그가 자기 방어로 행동했기 때문에 형사적으로 책임을 지지 않는다고 판결했습니다. |
| Thanks for watching, and do not forget to subscribe. | 시청해주셔서 감사합니다. 구독을 잊지 마세요. |

### 이전 측정 (v0.3.x, small / CPU)

자세한 조건은 [AUDIT_REPORT.md](docs/AUDIT_REPORT.md)에 있습니다.

- window 비교에서 4+2초가 평균 추론 1.98초(p95 2.19초), 중복 초과율 0%로 기본값으로 선택됨
- 30분·1시간·3시간 과부하 시뮬레이션에서 대기 오디오 16초, 화면 줄 수 500개로 제한
- v0.3.1 실시간 스트리밍 smoke test: update 13회, 대기 0.19초, 버린 오디오 0초. 수정 전 나오던 "자료형 크기를 반드시 자료형 크기를" 같은 경계 중복이 사라지고, 의도적으로 반복한 마지막 문장은 유지됨
- Whisper 모델 포함 메모리 약 440MB

## 한계

- 빠른 화자 전환, 큰 배경음, 숫자·영어 혼합에서는 인식이 흔들릴 수 있습니다. CPU의 rolling 모드에서는 window 경계에서 문장이 잘린 조각이 남을 수 있습니다.
- 문장 모드는 말이 쉬지 않고 이어지면 20초마다 강제로 끊어 다시 인식합니다.
- 번역 모델 NLLB-200은 CC-BY-NC 4.0 라이선스(비상업적 이용)입니다.
- 정밀한 자막 편집보다 라이브 기록·검색·요약 용도에 맞습니다.
- 재생 중 seek나 일시정지를 반복하면 타임코드가 영상과 어긋날 수 있습니다.
- Chrome의 탭 캡처 정책이나 YouTube 페이지 구조가 바뀌면 영향을 받을 수 있습니다.

## 개발

```bash
cd local-stt-server
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v          # Python 60개

cd ..
node --test extension/tests/transcript-utils.test.js   # Node 11개
```

실제 모델로 확인할 때는 먼저 TTS 클립을 만듭니다. WAV와 원문 TXT가 `benchmark-results/`에 생깁니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/generate_fixture.ps1               # 한국어
powershell -ExecutionPolicy Bypass -File scripts/generate_fixture.ps1 -Language en  # 영어
```

켜 둔 서버에 실시간 속도로 보내 보려면:

```powershell
python scripts/smoke_websocket.py benchmark-results/lecture-fixture.wav --duration 50
python scripts/smoke_websocket.py benchmark-results/english-fixture.wav --duration 20 --language auto --translate-to ko
```

설정별로 비교하려면(측정 결과 표를 만든 스크립트):

```powershell
python scripts/compare_modes.py benchmark-results/lecture-fixture.wav small:cpu:int8:rolling large-v3-turbo:cuda:float16:sentence
python scripts/compare_modes.py benchmark-results/english-fixture.wav large-v3-turbo:cuda:float16:sentence --language auto --translate-to ko
```

`scripts/benchmark_whisper.py`(window 비교), `scripts/simulate_long_run.py`(장시간 부하), `scripts/*-harness.html`(화면 점검)도 있습니다.
