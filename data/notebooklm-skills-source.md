# Google NotebookLM & Gemini Knowledge Base: Antigravity Skills
Source generated: 2026-11-03 09:45

## 1. Skill Catalog & Triggers
- **board-builder**: GitHub API & Vercel 기반 정적 게시판 홈페이지 빌더.   공지사항, 부동산 뉴스(property-news), 관리자 대시보드(admin), 글쓰기/수정/삭제 폼,   db.js 마크다운 렌더러 또는 깃허브 원격 저장소 JSON 포스트 연동 작업을 수행하거나 문의할 때 반드시 사용합니다.
- **skill-curator**: 새로운 프롬프트, 워크플로우, 팁을 Antigravity 스킬로 변환하여 자동 등록하거나,   기존 스킬들과의 중복 여부를 검사·통합하고, Notion DB 및 Gemini NotebookLM용 지식 소스로   동기화/내보내기를 수행할 때 사용합니다. '스킬 등록해줘', '스킬 정리해줘', '이 프롬프트 스킬로 만들어줘'   등의 요청에 자동 활성화됩니다.

---
## 2. Skill Runbooks & Implementation Guides

### Skill: board-builder
- File Path: _agent/skills/board-builder/SKILL.md
- Trigger Rule: GitHub API & Vercel 기반 정적 게시판 홈페이지 빌더.   공지사항, 부동산 뉴스(property-news), 관리자 대시보드(admin), 글쓰기/수정/삭제 폼,   db.js 마크다운 렌더러 또는 깃허브 원격 저장소 JSON 포스트 연동 작업을 수행하거나 문의할 때 반드시 사용합니다.

#### Instruction Content:

---
name: board-builder
description: >-
  GitHub API & Vercel 기반 정적 게시판 홈페이지 빌더.
  공지사항, 부동산 뉴스(property-news), 관리자 대시보드(admin), 글쓰기/수정/삭제 폼,
  db.js 마크다운 렌더러 또는 깃허브 원격 저장소 JSON 포스트 연동 작업을 수행하거나 문의할 때 반드시 사용합니다.
---

# board-builder Skill

이 스킬은 외부 데이터베이스나 별도의 백엔드 가상머신 없이, GitHub API와 Vercel의 서버리스 함수 기능만을 이용해 완벽한 관리자 대시보드와 정적 파일 기반 게시판 홈페이지를 구축하는 기능입니다.

## 주요 기능 및 스펙
1. **하이브리드 동기화 시스템 (`db.js`)**: 
   - LocalStorage 캐시를 리딩하여 빠른 초기 로딩 속도와 오프라인 작동을 지원합니다.
   - Vercel API `/api/config`를 호출해 깃허브 개인용 토큰을 동적으로 가져옵니다.
   - 원격 저장소 커밋(`PUT` 요청)을 이용해 게시판의 생성, 수정, 삭제가 즉각적으로 GitHub 저장소(`data/posts.json`)에 영구 보관됩니다.
2. **보안 연동 설계**:
   - 프라이빗 토큰 노출을 방지하기 위해 로컬 `config/git_config.json` 내 토큰값은 `"YOUR_GITHUB_TOKEN"`으로 마스킹되어 공개 레포지토리에 푸시됩니다.
   - 실제 토큰은 Vercel 환경 변수로 주입됩니다.
3. **독자적 마크다운 렌더러**:
   - `renderMarkdown` 함수는 본문 내 스크립트 실행 방지를 위해 HTML-escape를 선제 적용합니다.
   - 제목(`#`), 목록(`-`/`1.`), 링크(`[]()`), 굵게(`**`), 코드 블록(```) 등을 안전한 HTML 태그로 파싱합니다.
4. **모바일 반응형 UI**:
   - 테일윈드 반응형 접두사(`sm:`, `md:`)를 이용한 멀티 디바이스 레이아웃을 제공합니다.
   - 모바일 최적화 하단 고정 네비게이션을 지원합니다.


------------------------------------------------------------


### Skill: skill-curator
- File Path: _agent/skills/skill-curator/SKILL.md
- Trigger Rule: 새로운 프롬프트, 워크플로우, 팁을 Antigravity 스킬로 변환하여 자동 등록하거나,   기존 스킬들과의 중복 여부를 검사·통합하고, Notion DB 및 Gemini NotebookLM용 지식 소스로   동기화/내보내기를 수행할 때 사용합니다. '스킬 등록해줘', '스킬 정리해줘', '이 프롬프트 스킬로 만들어줘'   등의 요청에 자동 활성화됩니다.

#### Instruction Content:

---
name: skill-curator
description: >-
  새로운 프롬프트, 워크플로우, 팁을 Antigravity 스킬로 변환하여 자동 등록하거나,
  기존 스킬들과의 중복 여부를 검사·통합하고, Notion DB 및 Gemini NotebookLM용 지식 소스로
  동기화/내보내기를 수행할 때 사용합니다. '스킬 등록해줘', '스킬 정리해줘', '이 프롬프트 스킬로 만들어줘'
  등의 요청에 자동 활성화됩니다.
---

# Antigravity Skill Curator & Auto-Registry (스킬 큐레이터 및 자동 등록기)

이 스킬은 괜찮은 프롬프트, 개발 팁, 자동화 워크플로우를 발견했을 때 **Antigravity가 즉시 인식할 수 있는 정규 `SKILL.md` 규격으로 변환하고, 기존 스킬과의 중복을 걸러내며, Notion 및 Google NotebookLM에 연동 가능한 형태로 영구 보관**하는 지침을 제공합니다.

---

## 1. 스킬 등록 및 정제 프로세스

사용자가 새로운 프롬프트나 아이디어를 제공하면 다음 단계를 순서대로 수행합니다.

### 1단계: 기존 스킬 목록 탐색 및 중복 검증 (Deduplication)
1. `_agent/skills/` 디렉터리 내의 모든 하위 폴더와 `SKILL.md`를 검사합니다.
2. `data/skills.json` 데이터베이스 파일을 확인하여 이미 유사한 목적(트리거 조건, 해결하려는 문제)을 가진 스킬이 있는지 비교합니다.
3. **판단 기준**:
   - **완전 중복**: 기존 스킬과 목적이 90% 이상 일치할 경우 신규 생성을 중단하고, 기존 스킬의 `SKILL.md`에 새로운 팁/옵션을 병합(Merge)합니다.
   - **부분 중복/확장**: 기존 스킬의 하위 모듈(`references/` 또는 `scripts/`)로 추가하거나 기능을 확장합니다.
   - **신규 스킬**: 기존 스킬과 차별화된 독립적 기능일 경우 2단계로 진행합니다.

### 2단계: Progressive Disclosure 규격의 `SKILL.md` 생성
Antigravity 에이전트가 사용자의 자연어 프롬프트를 읽고 **스스로 해당 스킬을 자동 선택(Auto-Select)**할 수 있도록 `description`을 날카롭게 작성합니다.

* **폴더 위치**: `_agent/skills/<kebab-case-name>/SKILL.md`
* **표준 템플릿**:
```markdown
---
name: <소문자-하이픈-스킬명>
description: >-
  [제3자 시점 서술] 사용자가 ~ 작업을 요청하거나, ~ 상황이 발생했을 때 이 스킬을 활성화합니다.
  관련 키워드: [키워드1, 키워드2, 키워드3]
---

# <스킬 제목>

## 목적 및 개요
이 스킬의 핵심 가치와 해결하는 문제 요약.

## 실행 절차 및 가이드라인
1. [구체적인 단계 1]
2. [구체적인 단계 2]

## 검증 및 완료 조건
- 작업 완료 후 확인해야 할 체크리스트.
```

### 3단계: 중앙 카탈로그 (`data/skills.json`) 업데이트
신규 스킬이 등록되면 `data/skills.json`에 다음 메타데이터를 추가합니다:
- `id`: 스킬 ID (예: `board-builder`)
- `name`: 표시 이름
- `description`: 트리거 설명문
- `category`: 분류 (개발, 자동화, 데이터, 마케팅, 관리 등)
- `tags`: 검색용 태그 배열
- `path`: `_agent/skills/<name>/SKILL.md`
- `updated_at`: 등록/수정 일시

### 4단계: Notion 및 Gemini NotebookLM 내보내기 동기화
`scripts/skills-manager.ps1 export-notion` 및 `export-notebooklm`을 실행하여:
- Notion 데이터베이스 임포트용 마크다운/CSV 최신화
- Google NotebookLM 원클릭 업로드용 통합 문서(`data/notebooklm-skills-source.md`) 생성

---

## 2. 사용 가능한 헬퍼 스크립트
워크스페이스 내 파워쉘 매니저를 통해 수동 또는 자동 실행할 수 있습니다:
- `powershell -ExecutionPolicy Bypass -File ./scripts/skills-manager.ps1 list` : 전체 스킬 목록 조회
- `powershell -ExecutionPolicy Bypass -File ./scripts/skills-manager.ps1 dedupe` : 중복 및 누락 점검
- `powershell -ExecutionPolicy Bypass -File ./scripts/skills-manager.ps1 export-notebooklm` : 노트북LM 소스 생성
- `powershell -ExecutionPolicy Bypass -File ./scripts/skills-manager.ps1 test-select "테스트 질문"` : 자동 셀렉 테스트


------------------------------------------------------------

