// =========================================================================
// 최가네부동산 AI 중개 실무 센터 (broker-suite.js)
// 1) 한 줄 자연어 매물 매칭기 → 원클릭 브리핑 보드 연결
// 2) 등기부등본·건축물대장 PDF 자동 분석 & 위험 경고 엔진 (브라우저 내 로컬 처리)
// 3) 매물 광고·표시광고법 누락 & 장기 미갱신 자동 감시기
// 4) 매물 연동 임대차·매매 계약서 & 업종별 필수 특약 초안 생성기 (A4 인쇄/PDF)
// 5) 현장·계약 전 실무 검증 체크리스트 ('최가네 AI 답 확인표')
// =========================================================================
(function () {
    'use strict';

    const BS_CHECKLIST_STORAGE_KEY = 'choi_broker_checklists_v1';

    let _bsAllPosts = [];
    let _bsCurrentSubTab = 'matcher';
    let _bsMatcherResults = [];
    let _bsMatcherSelectedIds = new Set();
    let _bsLastDocAnalysis = null;
    let _bsAuditItems = [];
    let _bsAuditFilter = 'issues';
    let _bsContractSelectedPost = null;
    let _bsChecklistsStore = {};
    let _bsActiveChecklistKey = 'general_default';

    function bsEsc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function bsToast(msg) {
        if (typeof window.showToast === 'function') {
            window.showToast(msg);
        } else {
            alert(msg);
        }
    }

    function bsCopyText(text, toastMsg) {
        if (!text || !text.trim()) {
            alert('복사할 내용이 없습니다.');
            return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => bsToast(toastMsg || '복사되었습니다!')).catch(() => fallbackCopy(text, toastMsg));
        } else {
            fallbackCopy(text, toastMsg);
        }
    }

    function fallbackCopy(text, toastMsg) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
        bsToast(toastMsg || '복사되었습니다!');
    }

    function bsCleanText(htmlOrMd) {
        return String(htmlOrMd || '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/!\[.*?\]\(.*?\)/g, '')
            .replace(/[ \t]+/g, ' ');
    }

    function bsParseKoreanMoneyToManwon(str) {
        if (!str) return 0;
        const s = String(str).replace(/,/g, '').replace(/\s+/g, '');
        let total = 0;
        const eokM = s.match(/([0-9]+(?:\.[0-9]+)?)\s*억/);
        if (eokM) total += parseFloat(eokM[1]) * 10000;
        const afterEok = eokM ? s.slice(s.indexOf(eokM[0]) + eokM[0].length) : s;
        const cheonM = afterEok.match(/([0-9]+(?:\.[0-9]+)?)\s*천/);
        if (cheonM) {
            total += parseFloat(cheonM[1]) * 1000;
        } else {
            const manM = afterEok.match(/([0-9]+(?:\.[0-9]+)?)\s*만/);
            if (manM) {
                total += parseFloat(manM[1]);
            } else if (eokM) {
                const trail = afterEok.match(/^([0-9]+(?:\.[0-9]+)?)/);
                if (trail) total += parseFloat(trail[1]);
            } else {
                const plain = s.match(/([0-9]+(?:\.[0-9]+)?)/);
                if (plain) total += parseFloat(plain[1]);
            }
        }
        return Math.round(total * 10) / 10;
    }

    function bsFormatManwon(val) {
        const n = Number(val) || 0;
        if (n <= 0) return '-';
        const eok = Math.floor(n / 10000);
        const rem = Math.round((n % 10000) * 10) / 10;
        if (eok > 0 && rem > 0) return `${eok}억 ${rem.toLocaleString()}만원`;
        if (eok > 0) return `${eok}억원`;
        return `${rem.toLocaleString()}만원`;
    }

    function bsNumberToKoreanWon(manwonVal) {
        const won = Math.round((Number(manwonVal) || 0) * 10000);
        if (won <= 0) return '금 영원정 (₩0)';
        const units = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
        const small = ['', '십', '백', '천'];
        const big = ['', '만', '억', '조'];
        let n = won;
        let parts = [];
        let bigIdx = 0;
        while (n > 0) {
            const chunk = n % 10000;
            if (chunk > 0) {
                let s = '';
                const digits = [Math.floor(chunk / 1000), Math.floor((chunk % 1000) / 100), Math.floor((chunk % 100) / 10), chunk % 10];
                for (let i = 0; i < 4; i++) {
                    const d = digits[i];
                    if (d > 0) s += (d === 1 && i < 3 ? '' : units[d]) + small[3 - i];
                }
                parts.unshift(s + big[bigIdx]);
            }
            n = Math.floor(n / 10000);
            bigIdx++;
        }
        return `금 ${parts.join('')}원정 (₩${won.toLocaleString()})`;
    }

    function bsExtractPostMeta(post) {
        const rawFull = bsCleanText(post.content || '');
        const raw = rawFull.split(/🏬\s*주요\s*중개\s*이력|주요\s*중개\s*이력|🏬\s*개업공인중개사\s*정보|개업공인중개사\s*정보/)[0];
        const title = String(post.title || '').replace(/\s+/g, ' ').trim();
        const propNo = (typeof window.getPropertyDisplayNumber === 'function' ? window.getPropertyDisplayNumber(post) : '') || String(post.id || '').slice(-4);

        let infoSec = raw;
        const infoM = raw.match(/🏢?\s*매물\s*정보\s*🏢?/);
        if (infoM) {
            infoSec = raw.slice(infoM.index + infoM[0].length).split(/⭐\s*매물\s*특징|📢|💼\s*본\s*건물|🏬/)[0];
        }
        const getF = (re) => {
            const m1 = infoSec.match(re);
            if (m1) return m1[1].trim();
            const m2 = raw.match(re);
            return m2 ? m2[1].trim() : '';
        };

        const address = getF(/(?:위치|소재지|주소)\s*[:：]\s*([^\n]+)/i) || post.address || '';
        const supplyRaw = getF(/공급\s*면적\s*[:：]\s*([^\n]+)/i) || getF(/계약\s*면적\s*[:：]\s*([^\n]+)/i);
        const exclusiveRaw = getF(/전용\s*면적\s*[:：]\s*([^\n]+)/i);
        const genericAreaRaw = getF(/(?:^|\n)\s*(?:✅\s*)?(?:면적|평수)\s*[:：]\s*([^\n]+)/i);
        const grossRaw = getF(/연면적\s*[:：]\s*([^\n]+)/i);
        const landRaw = getF(/대지\s*면적\s*[:：]\s*([^\n]+)/i);

        const parsePyeong = (s) => {
            if (!s) return 0;
            const pm = String(s).match(/([0-9]+(?:\.[0-9]+)?)\s*평/);
            if (pm) return Math.round(parseFloat(pm[1]) * 100) / 100;
            const mm = String(s).match(/([0-9]+(?:\.[0-9]+)?)\s*(?:㎡|m2|m²)/i);
            if (mm) return Math.round((parseFloat(mm[1]) / 3.3058) * 100) / 100;
            return 0;
        };

        const exclusivePyeong = parsePyeong(exclusiveRaw);
        const supplyPyeong = parsePyeong(supplyRaw);
        const genericPyeong = parsePyeong(genericAreaRaw || grossRaw || landRaw);
        const titlePyeong = parsePyeong(title);
        const primaryPyeong = exclusivePyeong || genericPyeong || supplyPyeong || titlePyeong;

        const depositRaw = getF(/보증금\s*[:：]\s*([^\n]+)/i);
        const rentRaw = getF(/(?:월세|임대료)\s*[:：]\s*([^\n]+)/i);
        const saleRaw = getF(/매매가\s*[:：]\s*([^\n]+)/i);
        const maintRaw = getF(/공용\s*관리비\s*[:：]\s*([^\n]+)/i) || getF(/관리비\s*[:：]\s*([^\n]+)/i);
        const indivMaintRaw = getF(/개별\s*관리비(?:\([^)]*\))?\s*[:：]\s*([^\n]+)/i);
        const premRaw = getF(/권리금(?:\([^)]*\))?\s*[:：]\s*([^\n]+)/i);
        const totalFloor = getF(/총\s*층\s*수?\s*[:：]\s*([^\n]+)/i);
        const currentFloor = getF(/해당\s*층\s*수?\s*[:：]\s*([^\n]+)/i) || getF(/(?<!총\s*)층\s*수?\s*[:：]\s*([^\n]+)/i);
        const parking = getF(/주차\s*[:：]\s*([^\n]+)/i);
        const elevator = getF(/엘리베이터\s*[:：]\s*([^\n]+)/i);
        const direction = getF(/방향\s*[:：]\s*([^\n]+)/i);
        const usage = getF(/(?:건축물\s*용도|중개대상물\s*종류|용도)\s*[:：]\s*([^\n]+)/i);
        const approvalDate = getF(/(?:사용승인일|준공일)\s*[:：]\s*([^\n]+)/i);
        const moveIn = getF(/(?:입주\s*가능일|입주시기)\s*[:：]\s*([^\n]+)/i);
        const tradeRaw = getF(/거래\s*형태\s*[:：]\s*([^\n]+)/i);
        const restroom = getF(/(?:욕실\s*수|화장실)\s*[:：]\s*([^\n]+)/i);

        const deposit = bsParseKoreanMoneyToManwon(depositRaw);
        const rent = bsParseKoreanMoneyToManwon(rentRaw);
        const salePrice = bsParseKoreanMoneyToManwon(saleRaw);
        const maintFee = bsParseKoreanMoneyToManwon(maintRaw);

        const isSale = /매매/.test(tradeRaw) || (/매매/.test(title) && salePrice > 0) || (salePrice > 0 && rent === 0);
        const combined = `${title} ${address} ${raw}`;
        const isNoPremium = /무권리|권리금\s*없음|권리금\s*[:：]\s*0/.test(combined) || /무권리/.test(premRaw);
        const hasInterior = /인테리어\s*완비|시설\s*완비|풀인테리어|인테리어완비|시설완비/.test(combined);
        const hasParking = /주차\s*편리|주차편리|고정주차|무료주차|주차\s*가능/.test(combined) || (parseInt((parking.match(/([0-9]+)/) || [])[1] || '0', 10) >= 5);
        const hasElevator = !/없음|무/.test(elevator) && (/엘리베이터|승강기|대/.test(elevator) || /엘리베이터/.test(combined));
        const isStationNear = /역세권|초역세권|역\s*인근|역\s*바로|도보\s*[1-7]분/.test(combined);
        const isCornerRoad = /대로변|코너|네거리|오거리/.test(combined);
        const isImmediate = /즉시\s*입주|즉시입주|바로\s*입주/.test(combined);
        const hasRentFree = /렌트프리/.test(combined);

        // Extract floor numeric
        let floorNum = null;
        const flStr = `${currentFloor} ${title}`;
        if (/지하/.test(currentFloor)) floorNum = -1;
        else {
            const fm = flStr.match(/(?:지상\s*)?([0-9]+)\s*층/);
            if (fm) floorNum = parseInt(fm[1], 10);
        }

        // Photo count
        const mdPhotos = [...String(post.content || '').matchAll(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/g)].map(m => m[1]);
        const htmlPhotos = [...String(post.content || '').matchAll(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi)].map(m => m[1]);
        const arrPhotos = Array.isArray(post.images) ? post.images : (Array.isArray(post.photos) ? post.photos : []);
        const photoCount = new Set([...mdPhotos, ...htmlPhotos, ...arrPhotos].filter(Boolean)).size;

        // Post age in days
        let ts = Number(post.updatedAt || post.timestamp || post.createdAt || 0);
        if (!ts && post.date) {
            const parsedD = Date.parse(String(post.date).replace(/\./g, '-').trim());
            if (!isNaN(parsedD)) ts = parsedD;
        }
        if (!ts && /^\d{13}$/.test(String(post.id || ''))) {
            ts = Number(post.id);
        }
        const ageDays = ts > 0 ? Math.max(0, Math.floor((Date.now() - ts) / 86400000)) : 0;

        const isIntroPost = !infoM && /소장\s*소개|인사말/.test(title) && !propNo;

        return {
            post,
            id: String(post.id),
            propNo,
            title,
            category: post.category || '',
            isPrivate: Boolean(post.isPrivate),
            isIntroPost,
            address,
            supplyRaw,
            exclusiveRaw,
            genericAreaRaw,
            grossRaw,
            landRaw,
            exclusivePyeong,
            supplyPyeong,
            primaryPyeong,
            deposit,
            depositRaw,
            rent,
            rentRaw,
            salePrice,
            saleRaw,
            maintFee,
            maintRaw,
            indivMaintRaw,
            premRaw,
            totalFloor,
            currentFloor,
            floorNum,
            parking,
            elevator,
            direction,
            usage,
            approvalDate,
            moveIn,
            tradeRaw,
            restroom,
            isSale,
            isNoPremium,
            hasInterior,
            hasParking,
            hasElevator,
            isStationNear,
            isCornerRoad,
            isImmediate,
            hasRentFree,
            photoCount,
            ageDays,
            coords: post.coordinates,
            combined,
            infoSec
        };
    }

    async function ensureBrokerSuitePostsLoaded(force = false) {
        if (!force && _bsAllPosts.length > 0) return _bsAllPosts;
        try {
            const rawPosts = typeof window.getPosts === 'function' ? await window.getPosts() : [];
            _bsAllPosts = (Array.isArray(rawPosts) ? rawPosts : [])
                .map(bsExtractPostMeta)
                .filter(m => !m.isIntroPost);
        } catch (e) {
            _bsAllPosts = [];
        }
        return _bsAllPosts;
    }

    // =========================================================================
    // TAB INITIALIZATION & SUB-TAB NAVIGATION
    // =========================================================================
    async function initBrokerSuiteTab() {
        await ensureBrokerSuitePostsLoaded(false);
        loadChecklistsFromStorage();
        populateBrokerSuitePropertySelects();
        switchBrokerSuiteSubTab(_bsCurrentSubTab);
    }
    window.initBrokerSuiteTab = initBrokerSuiteTab;

    function switchBrokerSuiteSubTab(sub) {
        _bsCurrentSubTab = sub;
        const keys = ['matcher', 'doc', 'monitor', 'contract', 'checklist'];
        keys.forEach(k => {
            const btn = document.getElementById(`bs-subtab-btn-${k}`);
            const pane = document.getElementById(`bs-subview-${k}`);
            if (btn) {
                btn.className = (k === sub)
                    ? 'px-3 py-2.5 rounded-xl bg-[#0B2545] text-white font-extrabold text-xs sm:text-sm flex items-center justify-center gap-1.5 shadow-xs cursor-pointer transition whitespace-nowrap'
                    : 'px-3 py-2.5 rounded-xl bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 font-bold text-xs sm:text-sm flex items-center justify-center gap-1.5 cursor-pointer transition whitespace-nowrap';
            }
            if (pane) pane.classList.toggle('hidden', k !== sub);
        });

        if (sub === 'monitor' && _bsAuditItems.length === 0) {
            runAdComplianceAudit();
        }
        if (sub === 'checklist') {
            renderChecklistView();
        }
        if (sub === 'contract') {
            renderContractSpecialTermCheckboxes();
            rebuildContractPreview();
        }
    }
    window.switchBrokerSuiteSubTab = switchBrokerSuiteSubTab;

    function populateBrokerSuitePropertySelects() {
        const selects = [
            document.getElementById('bs-contract-post-select'),
            document.getElementById('bs-checklist-post-select')
        ];
        const sorted = [..._bsAllPosts].sort((a, b) => Number(b.propNo || 0) - Number(a.propNo || 0));
        selects.forEach(sel => {
            if (!sel) return;
            const prev = sel.value;
            const firstOpt = sel.id === 'bs-checklist-post-select'
                ? '<option value="general_default">📋 일반 공용 체크리스트 (직접 입력 계약건)</option>'
                : '<option value="">-- 등록된 매물 선택 (선택 시 자동 채움) --</option>';
            sel.innerHTML = firstOpt + sorted.map(m => {
                const priv = m.isPrivate ? '[비공개] ' : '';
                const areaTxt = m.primaryPyeong ? `${m.primaryPyeong}평` : '';
                const priceTxt = m.isSale ? `매매 ${bsFormatManwon(m.salePrice)}` : `보${bsFormatManwon(m.deposit)}/월${bsFormatManwon(m.rent)}`;
                const label = `${priv}#${m.propNo} · ${m.address || m.title.slice(0, 18)} (${areaTxt} · ${priceTxt})`;
                return `<option value="${bsEsc(m.id)}">${bsEsc(label.slice(0, 88))}</option>`;
            }).join('');
            if (prev) sel.value = prev;
        });
    }

    // =========================================================================
    // TOOL 1: 🤖 한 줄 자연어 매물 매칭기 + 원클릭 브리핑 보드 연결
    // =========================================================================
    function parseNaturalPropertyQuery(queryStr) {
        const q = String(queryStr || '').trim();
        const parsed = {
            raw: q,
            locations: [],
            tradeType: '', // 'rent' | 'sale'
            bizTypes: [],
            minPyeong: 0,
            maxPyeong: 0,
            maxDeposit: 0,
            maxRent: 0,
            minRent: 0,
            maxSale: 0,
            floorReq: '', // '1f' | 'low' | 'high' | 'basement'
            traits: [],
            freeKeywords: []
        };
        if (!q) return parsed;

        // 1. Locations (Daegu gus, major dongs, stations, landmarks)
        const locCandidates = [
            '수성구', '중구', '동구', '서구', '남구', '북구', '달서구', '달성군', '경산',
            '범어동', '범어', '수성동', '만촌동', '만촌', '황금동', '황금', '지산동', '범물동', '두산동', '신매동', '시지',
            '신천동', '신천', '효목동', '율하', '동대구역', '동대구', '벤처밸리',
            '삼덕동', '대봉동', '봉산동', '동성로', '반월당', '남산동', '동인동', '계산동', '대신동',
            '대명동', '봉덕동', '감삼동', '죽전동', '용산동', '이곡동', '성서', '상인동', '진천동', '월배', '본동', '두류동',
            '침산동', '복현동', '칠곡', '산격동', '태전동', '평리동', '내당동', '사정동', '중산동', '정평동',
            '범어역', '수성구청역', '대구은행역', '수성시장역', '만촌역', '반월당역', '경대병원역', '중앙로역', '명덕역', '죽전역', '감삼역', '두류역', '상인역', '진천역',
            '달구벌대로', '동대구로', '국채보상로', '법원', '수성못'
        ];
        for (const loc of locCandidates) {
            if (q.includes(loc)) {
                if (!parsed.locations.some(l => l.includes(loc) || loc.includes(l))) {
                    parsed.locations.push(loc);
                } else if (loc.length > 2) {
                    parsed.locations = parsed.locations.filter(l => !loc.includes(l));
                    parsed.locations.push(loc);
                }
            }
        }

        // 2. Trade type
        if (/매매|매입|건물\s*구|꼬마빌딩|상가주택/.test(q) && !/임대|월세/.test(q)) {
            parsed.tradeType = 'sale';
        } else if (/임대|월세|보증금|무권리|렌트/.test(q)) {
            parsed.tradeType = 'rent';
        }

        // 3. Property / Business types
        const bizMap = [
            { key: '사무실', re: /사무실|오피스|사옥|지사|법무|세무|변호사|회사/ },
            { key: '상가', re: /상가|매장|점포|가게|로드샵/ },
            { key: '병의원', re: /병원|의원|병의원|클리닉|치과|한의원|피부과|내과|약국/ },
            { key: '카페·식당', re: /카페|커피|식당|음식점|고기|호프|주점|베이커리|프랜차이즈/ },
            { key: '학원', re: /학원|교습소|공부방|필라테스|헬스|PT|요가/ },
            { key: '뷰티', re: /미용실|뷰티|네일|피부관리|에스테틱|헤어/ },
            { key: '빌딩·건물', re: /빌딩|꼬마빌딩|상가주택|건물\s*매매|수익형/ }
        ];
        bizMap.forEach(b => { if (b.re.test(q)) parsed.bizTypes.push(b.key); });

        // 4. Area (평)
        const rangeP = q.match(/([0-9]+)\s*[~-]\s*([0-9]+)\s*평/);
        const decadeP = q.match(/([0-9]+)\s*평대/);
        const minP = q.match(/([0-9]+(?:\.[0-9]+)?)\s*평\s*(?:이상|넘|초과)/);
        const maxP = q.match(/([0-9]+(?:\.[0-9]+)?)\s*평\s*(?:이하|안쪽|미만|이내)/);
        const exactP = q.match(/([0-9]+(?:\.[0-9]+)?)\s*평/);

        if (rangeP) {
            parsed.minPyeong = parseFloat(rangeP[1]);
            parsed.maxPyeong = parseFloat(rangeP[2]);
        } else if (decadeP) {
            const base = parseFloat(decadeP[1]);
            parsed.minPyeong = Math.max(1, base - 2);
            parsed.maxPyeong = base + 12;
        } else if (minP) {
            parsed.minPyeong = parseFloat(minP[1]);
        } else if (maxP) {
            parsed.maxPyeong = parseFloat(maxP[1]);
        } else if (exactP) {
            const p = parseFloat(exactP[1]);
            parsed.minPyeong = Math.max(1, Math.round(p * 0.72));
            parsed.maxPyeong = Math.round(p * 1.32);
        }

        // 5. Budget (월세, 보증금, 매매가)
        const rentM = q.match(/(?:월세|월|임대료)\s*([0-9.,억천만]+)\s*(?:만원|만|원)?\s*(?:이하|안쪽|이내|미만|까지|정도)?/);
        if (rentM) {
            parsed.maxRent = bsParseKoreanMoneyToManwon(rentM[1]);
        }
        const depM = q.match(/보증금\s*([0-9.,억천만]+)\s*(?:만원|만|원)?\s*(?:이하|안쪽|이내|미만|까지|정도)?/);
        if (depM) {
            parsed.maxDeposit = bsParseKoreanMoneyToManwon(depM[1]);
        }
        const saleM = q.match(/(?:매매가?|매매)\s*([0-9.,]+)\s*억\s*(?:대|이하|안쪽|이내|미만)?/) || q.match(/([0-9.,]+)\s*억\s*(?:이하|안쪽|이내|대)\s*(?:빌딩|건물|상가주택|매매)/);
        if (saleM) {
            parsed.maxSale = parseFloat(saleM[1]) * 10000;
            parsed.tradeType = 'sale';
        }

        // 6. Floor
        if (/1층|일층/.test(q)) parsed.floorReq = '1f';
        else if (/저층|2층|3층/.test(q)) parsed.floorReq = 'low';
        else if (/고층|전망|뷰/.test(q)) parsed.floorReq = 'high';
        else if (/지하/.test(q)) parsed.floorReq = 'basement';

        // 7. Traits
        if (/무권리|권리금\s*없/.test(q)) parsed.traits.push('무권리');
        if (/인테리어|시설\s*완비|깔끔/.test(q)) parsed.traits.push('인테리어 완비');
        if (/주차|고정주차/.test(q)) parsed.traits.push('주차 편리');
        if (/역세권|초역세권|역\s*근처|지하철/.test(q)) parsed.traits.push('역세권');
        if (/엘리베이터|엘베|승강기/.test(q)) parsed.traits.push('엘리베이터');
        if (/즉시\s*입주|바로\s*입주/.test(q)) parsed.traits.push('즉시입주');
        if (/대로변|코너/.test(q)) parsed.traits.push('대로변/코너');
        if (/렌트프리/.test(q)) parsed.traits.push('렌트프리');

        // 8. Property number direct lookup
        const noM = q.match(/(?:매물번호|#|NO\.?)\s*([0-9]{3,5})/i);
        if (noM) parsed.freeKeywords.push(noM[1]);

        return parsed;
    }

    async function runNaturalPropertyMatcher(customQuery) {
        await ensureBrokerSuitePostsLoaded(false);
        const input = document.getElementById('bs-matcher-input');
        if (typeof customQuery === 'string' && input) {
            input.value = customQuery;
        }
        const q = (input?.value || '').trim();
        const includePrivate = document.getElementById('bs-matcher-include-private')?.checked === true;
        const parsedBox = document.getElementById('bs-matcher-parsed-chips');
        const resultsBox = document.getElementById('bs-matcher-results');
        const countLabel = document.getElementById('bs-matcher-count-label');

        if (!q) {
            if (parsedBox) parsedBox.innerHTML = '';
            if (resultsBox) {
                resultsBox.innerHTML = '<div class="text-center py-10 text-slate-500 text-sm bg-slate-50 rounded-xl border border-dashed border-slate-300">위 검색창에 손님이 원하시는 조건을 한 줄로 입력해 보세요.</div>';
            }
            return;
        }

        const p = parseNaturalPropertyQuery(q);

        // Show parsed condition chips
        const chips = [];
        if (p.locations.length) chips.push(`📍 지역: ${p.locations.join(' · ')}`);
        if (p.tradeType) chips.push(`📑 거래: ${p.tradeType === 'sale' ? '매매' : '임대(월세)'}`);
        if (p.bizTypes.length) chips.push(`🏢 업종: ${p.bizTypes.join(', ')}`);
        if (p.minPyeong && p.maxPyeong) chips.push(`📐 면적: ${p.minPyeong}~${p.maxPyeong}평`);
        else if (p.minPyeong) chips.push(`📐 면적: ${p.minPyeong}평 이상`);
        else if (p.maxPyeong) chips.push(`📐 면적: ${p.maxPyeong}평 이하`);
        if (p.maxDeposit) chips.push(`💰 보증금: ${bsFormatManwon(p.maxDeposit)} 이하`);
        if (p.maxRent) chips.push(`💵 월세: ${bsFormatManwon(p.maxRent)} 이하`);
        if (p.maxSale) chips.push(`🏦 매매가: ${bsFormatManwon(p.maxSale)} 이하`);
        if (p.floorReq) chips.push(`🪜 층수: ${p.floorReq === '1f' ? '1층' : p.floorReq === 'low' ? '저층(1~3층)' : p.floorReq === 'high' ? '고층(5층+)' : '지하'}`);
        if (p.traits.length) chips.push(`✨ 조건: ${p.traits.join(', ')}`);

        if (parsedBox) {
            parsedBox.innerHTML = chips.length > 0
                ? `<div class="flex flex-wrap items-center gap-1.5 text-[11px]"><span class="font-black text-[#003891]">AI 조건 분석:</span>${chips.map(c => `<span class="px-2 py-0.5 rounded-md bg-blue-50 text-[#003891] border border-blue-200 font-bold">${bsEsc(c)}</span>`).join('')}</div>`
                : `<div class="text-xs text-slate-500">키워드 통합 매칭 모드: <b>"${bsEsc(q)}"</b></div>`;
        }

        const pool = _bsAllPosts.filter(m => includePrivate || !m.isPrivate);
        const rawTokens = q.split(/\s+/).filter(w => w.length >= 2);
        const scored = [];

        for (const m of pool) {
            let score = 0;
            let maxScore = 0;
            const reasons = [];
            const warnings = [];

            // Direct propNo boost
            if (p.freeKeywords.includes(m.propNo)) {
                score += 100; maxScore += 100;
                reasons.push(`매물번호 #${m.propNo} 일치`);
            }

            // Location (weight 30)
            if (p.locations.length > 0) {
                maxScore += 30;
                const matchedLocs = p.locations.filter(loc => m.combined.includes(loc));
                if (matchedLocs.length > 0) {
                    score += Math.min(30, 20 + matchedLocs.length * 5);
                    reasons.push(`지역 일치 (${matchedLocs.join(', ')})`);
                } else {
                    warnings.push(`지역 불일치`);
                }
            }

            // Trade type (weight 20)
            if (p.tradeType) {
                maxScore += 20;
                if ((p.tradeType === 'sale' && m.isSale) || (p.tradeType === 'rent' && !m.isSale)) {
                    score += 20;
                } else {
                    score -= 25;
                    warnings.push(m.isSale ? '매매 매물' : '임대 매물');
                }
            }

            // Business / property type (weight 18)
            if (p.bizTypes.length > 0) {
                maxScore += 18;
                let hitBiz = false;
                for (const bt of p.bizTypes) {
                    if (bt === '사무실' && /사무실|오피스|사옥/.test(m.combined)) hitBiz = true;
                    if (bt === '상가' && /상가|매장|점포|근린생활/.test(m.combined)) hitBiz = true;
                    if (bt === '병의원' && /병원|의원|병의원|클리닉|치과|한의원|의료/.test(m.combined)) hitBiz = true;
                    if (bt === '카페·식당' && /카페|커피|식당|음식점|근린생활|1층/.test(m.combined)) hitBiz = true;
                    if (bt === '학원' && /학원|교습소|교육|필라테스|헬스/.test(m.combined)) hitBiz = true;
                    if (bt === '뷰티' && /뷰티|미용|네일|피부|상가/.test(m.combined)) hitBiz = true;
                    if (bt === '빌딩·건물' && /빌딩|건물|상가주택|통매매/.test(m.combined)) hitBiz = true;
                }
                if (hitBiz) {
                    score += 18;
                    reasons.push(`업종 적합`);
                } else {
                    warnings.push('업종 확인 필요');
                }
            }

            // Area (weight 20)
            if (p.minPyeong > 0 || p.maxPyeong > 0) {
                maxScore += 20;
                if (m.primaryPyeong > 0) {
                    const inMin = !p.minPyeong || m.primaryPyeong >= p.minPyeong;
                    const inMax = !p.maxPyeong || m.primaryPyeong <= p.maxPyeong;
                    if (inMin && inMax) {
                        score += 20;
                        reasons.push(`면적 적합 (${m.primaryPyeong}평)`);
                    } else if ((!p.minPyeong || m.primaryPyeong >= p.minPyeong * 0.78) && (!p.maxPyeong || m.primaryPyeong <= p.maxPyeong * 1.25)) {
                        score += 10;
                        warnings.push(`면적 근접 (${m.primaryPyeong}평)`);
                    } else {
                        warnings.push(`면적 차이 (${m.primaryPyeong}평)`);
                    }
                }
            }

            // Budget (weight 22 each)
            if (p.maxRent > 0) {
                maxScore += 22;
                if (!m.isSale && m.rent > 0 && m.rent <= p.maxRent) {
                    score += 22;
                    reasons.push(`월세 예산 내 (${bsFormatManwon(m.rent)})`);
                } else if (!m.isSale && m.rent > 0 && m.rent <= p.maxRent * 1.18) {
                    score += 10;
                    warnings.push(`월세 소폭 초과 (${bsFormatManwon(m.rent)})`);
                } else if (m.rent > 0) {
                    warnings.push(`월세 초과 (${bsFormatManwon(m.rent)})`);
                }
            }
            if (p.maxDeposit > 0) {
                maxScore += 18;
                if (m.deposit > 0 && m.deposit <= p.maxDeposit) {
                    score += 18;
                    reasons.push(`보증금 예산 내 (${bsFormatManwon(m.deposit)})`);
                } else if (m.deposit > 0 && m.deposit <= p.maxDeposit * 1.2) {
                    score += 8;
                    warnings.push(`보증금 소폭 초과 (${bsFormatManwon(m.deposit)})`);
                }
            }
            if (p.maxSale > 0) {
                maxScore += 22;
                if (m.isSale && m.salePrice > 0 && m.salePrice <= p.maxSale) {
                    score += 22;
                    reasons.push(`매매가 예산 내 (${bsFormatManwon(m.salePrice)})`);
                } else if (m.isSale && m.salePrice > 0 && m.salePrice <= p.maxSale * 1.15) {
                    score += 10;
                    warnings.push(`매매가 소폭 초과 (${bsFormatManwon(m.salePrice)})`);
                }
            }

            // Floor (weight 15)
            if (p.floorReq) {
                maxScore += 15;
                const ok = (p.floorReq === '1f' && m.floorNum === 1)
                    || (p.floorReq === 'low' && m.floorNum >= 1 && m.floorNum <= 3)
                    || (p.floorReq === 'high' && m.floorNum >= 5)
                    || (p.floorReq === 'basement' && m.floorNum === -1);
                if (ok) {
                    score += 15;
                    reasons.push(`층수 일치 (${m.currentFloor || `${m.floorNum}층`})`);
                } else {
                    warnings.push(`층수 상이 (${m.currentFloor || '-'})`);
                }
            }

            // Traits (weight 8 each)
            for (const tr of p.traits) {
                maxScore += 8;
                const hit = (tr === '무권리' && m.isNoPremium)
                    || (tr === '인테리어 완비' && m.hasInterior)
                    || (tr === '주차 편리' && m.hasParking)
                    || (tr === '역세권' && m.isStationNear)
                    || (tr === '엘리베이터' && m.hasElevator)
                    || (tr === '즉시입주' && m.isImmediate)
                    || (tr === '대로변/코너' && m.isCornerRoad)
                    || (tr === '렌트프리' && m.hasRentFree);
                if (hit) {
                    score += 8;
                    reasons.push(tr);
                }
            }

            // Fallback keyword match when no structured filters matched
            if (maxScore === 0) {
                let hits = 0;
                for (const tk of rawTokens) {
                    if (m.combined.toLowerCase().includes(tk.toLowerCase())) hits++;
                }
                if (hits > 0) {
                    maxScore = rawTokens.length * 20;
                    score = hits * 20;
                    reasons.push(`키워드 ${hits}/${rawTokens.length}건 일치`);
                }
            }

            if (maxScore > 0 && score > 0) {
                const pct = Math.max(1, Math.min(100, Math.round((score / maxScore) * 100)));
                if (pct >= 35) {
                    scored.push({ meta: m, pct, score, reasons, warnings });
                }
            }
        }

        scored.sort((a, b) => (b.pct - a.pct) || (b.score - a.score) || (a.meta.ageDays - b.meta.ageDays));
        _bsMatcherResults = scored.slice(0, 20);
        _bsMatcherSelectedIds.clear();
        // Auto-preselect top 3 matches >= 70%
        _bsMatcherResults.slice(0, 3).filter(r => r.pct >= 70).forEach(r => _bsMatcherSelectedIds.add(r.meta.id));

        if (countLabel) {
            countLabel.textContent = `후보 매물 ${_bsMatcherResults.length}건 추천 (전체 ${pool.length}건 분석)`;
        }
        renderMatcherResults();
    }
    window.runNaturalPropertyMatcher = runNaturalPropertyMatcher;

    function toggleMatcherSelect(id) {
        if (_bsMatcherSelectedIds.has(id)) _bsMatcherSelectedIds.delete(id);
        else _bsMatcherSelectedIds.add(id);
        renderMatcherResults();
    }
    window.toggleMatcherSelect = toggleMatcherSelect;

    function renderMatcherResults() {
        const box = document.getElementById('bs-matcher-results');
        const sendBtn = document.getElementById('bs-matcher-send-briefing-btn');
        if (sendBtn) {
            sendBtn.textContent = `🚀 선택한 ${_bsMatcherSelectedIds.size}건으로 손님 브리핑 보드 바로 만들기`;
            sendBtn.disabled = _bsMatcherSelectedIds.size === 0;
            sendBtn.className = _bsMatcherSelectedIds.size > 0
                ? 'px-4 py-2.5 rounded-xl bg-[#003891] hover:bg-blue-800 text-white font-black text-xs sm:text-sm flex items-center gap-1.5 shadow-sm cursor-pointer transition'
                : 'px-4 py-2.5 rounded-xl bg-slate-200 text-slate-400 font-bold text-xs sm:text-sm flex items-center gap-1.5 cursor-not-allowed';
        }
        if (!box) return;

        if (_bsMatcherResults.length === 0) {
            box.innerHTML = '<div class="text-center py-10 text-slate-500 text-sm bg-slate-50 rounded-xl border border-dashed border-slate-300">조건에 딱 맞는 매물이 없습니다. 금액·면적 조건을 조금 넓혀서 다시 검색해 보세요.</div>';
            return;
        }

        box.innerHTML = _bsMatcherResults.map(({ meta: m, pct, reasons, warnings }) => {
            const isSel = _bsMatcherSelectedIds.has(m.id);
            const pctCls = pct >= 80 ? 'bg-emerald-600 text-white' : pct >= 60 ? 'bg-[#003891] text-white' : 'bg-slate-600 text-white';
            const priceLine = m.isSale
                ? `매매 ${bsFormatManwon(m.salePrice)}${m.deposit ? ` (기보증금 ${bsFormatManwon(m.deposit)} / 월 ${bsFormatManwon(m.rent)})` : ''}`
                : `보증금 ${bsFormatManwon(m.deposit)} / 월세 ${bsFormatManwon(m.rent)}${m.maintFee ? ` / 관리비 ${bsFormatManwon(m.maintFee)}` : ''}`;
            const areaLine = (m.exclusivePyeong && m.supplyPyeong)
                ? `전용 ${m.exclusivePyeong}평 (공급 ${m.supplyPyeong}평)`
                : (m.primaryPyeong ? `약 ${m.primaryPyeong}평` : '-');

            return `
                <div onclick="toggleMatcherSelect('${bsEsc(m.id)}')" class="p-3.5 sm:p-4 rounded-xl border-2 transition cursor-pointer ${isSel ? 'bg-blue-50/50 border-[#003891] shadow-xs' : 'bg-white border-slate-200 hover:border-slate-400'}">
                    <div class="flex items-start gap-3">
                        <input type="checkbox" ${isSel ? 'checked' : ''} onclick="event.stopPropagation(); toggleMatcherSelect('${bsEsc(m.id)}')" class="mt-1 w-4 h-4 rounded text-[#003891] cursor-pointer shrink-0" />
                        <div class="flex-1 min-w-0 space-y-1.5">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <div class="flex flex-wrap items-center gap-1.5">
                                    <span class="px-2 py-0.5 rounded-md text-[11px] font-black ${pctCls}">매칭 ${pct}%</span>
                                    <span class="px-2 py-0.5 rounded-md bg-slate-900 text-white text-[11px] font-black">#${bsEsc(m.propNo)}</span>
                                    ${m.isPrivate ? '<span class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px] font-black">비공개</span>' : ''}
                                    <span class="text-xs font-extrabold text-[#003891]">${bsEsc(m.address || '위치 상세 참고')}</span>
                                </div>
                                <div class="flex items-center gap-1.5" onclick="event.stopPropagation()">
                                    <button type="button" onclick="openContractForPost('${bsEsc(m.id)}')" class="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 text-[11px] font-bold cursor-pointer">📝 계약서</button>
                                    <button type="button" onclick="openChecklistForPost('${bsEsc(m.id)}')" class="px-2 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 text-[11px] font-bold cursor-pointer">✅ 확인표</button>
                                    <a href="news-detail.html?id=${encodeURIComponent(m.id)}" target="_blank" class="px-2 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-[#003891] text-[11px] font-bold">상세 ↗</a>
                                </div>
                            </div>
                            <div class="font-extrabold text-sm text-slate-900 leading-snug">${bsEsc(m.title)}</div>
                            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-slate-700">
                                <span class="text-[#0B2545]">💰 ${bsEsc(priceLine)}</span>
                                <span>📐 ${bsEsc(areaLine)}</span>
                                ${m.currentFloor ? `<span>🪜 ${bsEsc(m.currentFloor)}</span>` : ''}
                                ${m.parking ? `<span>🚗 주차 ${bsEsc(m.parking)}</span>` : ''}
                            </div>
                            <div class="flex flex-wrap gap-1 pt-0.5">
                                ${reasons.map(r => `<span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 text-[11px] font-bold">✓ ${bsEsc(r)}</span>`).join('')}
                                ${warnings.map(w => `<span class="px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 text-[11px] font-bold">△ ${bsEsc(w)}</span>`).join('')}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    async function sendMatchedPostsToNewBriefing() {
        const ids = Array.from(_bsMatcherSelectedIds);
        if (ids.length === 0) {
            alert('브리핑 보드에 담을 매물을 먼저 체크해 주세요.');
            return;
        }
        const queryText = (document.getElementById('bs-matcher-input')?.value || '').trim();
        if (typeof window.showAdminTab === 'function') window.showAdminTab('briefing');
        if (typeof window.initBriefingAndMemoTab === 'function') await window.initBriefingAndMemoTab();
        if (typeof window.switchBriefingSubTab === 'function') window.switchBriefingSubTab('briefing');
        if (typeof window.startNewBriefingEditor === 'function') window.startNewBriefingEditor(false);

        const titleInput = document.getElementById('bf-title');
        const noteInput = document.getElementById('bf-note');
        if (titleInput && queryText) titleInput.value = `맞춤 추천 매물 브리핑 (${queryText.slice(0, 28)})`;
        if (noteInput && queryText) noteInput.value = `요청하신 [${queryText}] 조건에 맞춰 최가네부동산이 엄선한 실매물 후보 리스트입니다.`;

        for (const id of ids) {
            if (typeof window.addPostToCurrentBriefing === 'function') {
                await window.addPostToCurrentBriefing(id);
            }
        }
        const card = document.getElementById('briefing-editor-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        bsToast(`🚀 추천 매물 ${ids.length}건이 새 브리핑 보드에 자동으로 담겼습니다!`);
    }
    window.sendMatchedPostsToNewBriefing = sendMatchedPostsToNewBriefing;

    // =========================================================================
    // TOOL 2: 📄 등기부등본·건축물대장 PDF 자동 분석 & 위험 경고 엔진 (로컬 보안 처리)
    // =========================================================================
    async function handleBrokerDocPdfUpload(inputEl) {
        const file = inputEl && inputEl.files && inputEl.files[0];
        if (!file) return;
        const statusEl = document.getElementById('bs-doc-status');
        if (statusEl) statusEl.textContent = `🔄 "${file.name}" PDF 텍스트를 브라우저 내부에서 안전하게 분석 중...`;

        try {
            if (!window.pdfjsLib) throw new Error('PDF.js 엔진이 로드되지 않았습니다.');
            const buf = await file.arrayBuffer();
            const loadingTask = window.pdfjsLib.getDocument({
                data: buf,
                cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
                cMapPacked: true,
                standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/standard_fonts/'
            });
            const pdf = await loadingTask.promise;
            const pageTexts = [];
            const maxPages = Math.min(pdf.numPages, 25);
            for (let p = 1; p <= maxPages; p++) {
                const page = await pdf.getPage(p);
                const content = await page.getTextContent();
                // Reconstruct line breaks using Y coordinate deltas
                let lastY = null;
                let line = '';
                const lines = [];
                for (const it of content.items) {
                    const y = it.transform ? Math.round(it.transform[5]) : 0;
                    if (lastY !== null && Math.abs(y - lastY) > 4) {
                        lines.push(line.trim());
                        line = '';
                    }
                    line += (it.str || '') + ' ';
                    lastY = y;
                }
                if (line.trim()) lines.push(line.trim());
                pageTexts.push(lines.join('\n'));
            }
            const fullText = pageTexts.join('\n\n');
            const rawBox = document.getElementById('bs-doc-raw-text');
            if (rawBox) rawBox.value = fullText;

            if (fullText.replace(/\s+/g, '').length < 30) {
                if (statusEl) statusEl.textContent = '⚠️ 스캔(이미지) PDF라 텍스트가 추출되지 않았습니다. 인터넷등기소/세움터 전자발급 PDF를 올리거나 아래 칸에 텍스트를 붙여넣어 주세요.';
                return;
            }
            if (statusEl) statusEl.textContent = `✅ "${file.name}" (${pdf.numPages}페이지) 로컬 분석 완료 · 서버 전송 없음`;
            analyzeBrokerDocText(fullText);
        } catch (err) {
            console.error('PDF analyze error:', err);
            if (statusEl) statusEl.textContent = '❌ PDF 읽기 오류: ' + err.message;
        } finally {
            inputEl.value = '';
        }
    }
    window.handleBrokerDocPdfUpload = handleBrokerDocPdfUpload;

    function analyzeBrokerDocText(overrideText) {
        const raw = typeof overrideText === 'string'
            ? overrideText
            : (document.getElementById('bs-doc-raw-text')?.value || '');
        const text = String(raw || '').trim();
        const resultBox = document.getElementById('bs-doc-result');
        if (!text) {
            alert('PDF 파일을 업로드하거나 등기부등본/건축물대장 텍스트를 붙여넣어 주세요.');
            return;
        }

        const isRegistry = /등기사항전부증명서|등기부|갑\s*구|을\s*구|채권최고액|근저당권|소유권보존|소유권이전/.test(text);
        const isLedger = /건축물대장|표제부|사용승인일|주용도|연면적|대지면적|위반건축물|건폐율|용적률/.test(text);
        const docType = (isRegistry && isLedger) ? '등기부등본 + 건축물대장 복합'
            : (isRegistry ? '등기사항전부증명서 (등기부등본)' : (isLedger ? '건축물대장' : '부동산 공적장부'));

        // Address
        const addrM = text.match(/((?:대구광역시|경상북도|서울특별시|부산광역시|인천광역시|광주광역시|대전광역시|울산광역시|경기도|[가-힣]+(?:특별시|광역시|도))\s+[가-힣]+(?:구|군|시)\s+[가-힣0-9]+(?:동|읍|면|가|로|길)[^\n]{0,35})/);
        const address = addrM ? addrM[1].replace(/\s+/g, ' ').trim() : '';

        // Areas (㎡ -> 평)
        const areaMatches = [...text.matchAll(/(전유부분|전용면적|연면적|대지면적|건축면적|계약면적|면적)?[^\n0-9]{0,16}([0-9,]+(?:\.[0-9]+)?)\s*(?:㎡|m2|m²)/gi)];
        const parsedAreas = [];
        const seenArea = new Set();
        for (const am of areaMatches) {
            const label = (am[1] || '면적').trim();
            const m2 = parseFloat(am[2].replace(/,/g, ''));
            if (isNaN(m2) || m2 <= 1 || m2 > 500000) continue;
            const key = `${label}_${m2}`;
            if (seenArea.has(key)) continue;
            seenArea.add(key);
            const py = Math.round((m2 / 3.3058) * 100) / 100;
            parsedAreas.push({ label, m2, py });
            if (parsedAreas.length >= 6) break;
        }

        // Owners (갑구)
        const owners = [];
        const ownerMatches = [...text.matchAll(/소유자\s+([가-힣A-Za-z0-9()주식회사유한회사\s]{2,26}?)(?:\s+[0-9]{6}-|\s+지분|\s+\d|\n|$)/g)];
        for (const om of ownerMatches) {
            const nm = om[1].replace(/\s+/g, ' ').trim();
            if (nm && !owners.includes(nm) && nm.length >= 2) owners.push(nm);
        }

        // Mortgages (을구 채권최고액 + 근저당권자)
        const mortgages = [];
        const lines = text.split('\n');
        let totalMortgageWon = 0;
        for (let i = 0; i < lines.length; i++) {
            const ln = lines[i];
            if (/채권최고액/.test(ln)) {
                const block = [lines[Math.max(0, i - 1)] || '', ln, lines[i + 1] || '', lines[i + 2] || ''].join(' ');
                const isCancelled = /말소|해지/.test(ln);
                const wonM = block.match(/채권최고액\s*금?\s*([0-9,]+)\s*원/);
                const creditorM = block.match(/근저당권자\s+([가-힣A-Za-z0-9()주식회사\s]{2,26}?)(?:\s+[0-9]|\s+주소|\n|$)/);
                if (wonM) {
                    const won = parseInt(wonM[1].replace(/,/g, ''), 10);
                    if (!isNaN(won) && won > 0) {
                        mortgages.push({
                            won,
                            manwon: Math.round(won / 10000),
                            creditor: creditorM ? creditorM[1].trim() : '금융기관/채권자',
                            isCancelled
                        });
                        if (!isCancelled) totalMortgageWon += won;
                    }
                }
            }
        }

        // High-risk right keywords
        const risks = [];
        const riskDefs = [
            { label: '경매개시결정', re: /경매개시결정|임의경매|강제경매/, severity: 'high', desc: '경매 진행 중 — 계약 절대 주의(전문 권리분석 필수)' },
            { label: '압류 / 가압류', re: /(?:^|[^가])압류|가압류/, severity: 'high', desc: '세금 체납 또는 채권 분쟁 가능성 — 계약 전 말소 조건 필수' },
            { label: '가처분', re: /처분금지가처분|가처분/, severity: 'high', desc: '소유권 분쟁 위험 — 법적 확인 전 계약 보류 권장' },
            { label: '신탁 등기', re: /신탁\s*(?:등기|재산|원부|계약)|수탁자/, severity: 'high', desc: '신탁회사 동의서 및 신탁원부 확인 없이 계약 시 대항력 상실 위험!' },
            { label: '임차권등기명령', re: /임차권등기/, severity: 'high', desc: '이전 임차인 보증금 미반환 이력 — 임대인 자금력 필수 확인' },
            { label: '위반건축물', re: /위반건축물/, severity: 'high', desc: '건축물대장상 위반건축물 표기 — 대출·인허가·이행강제금 확인 필수' },
            { label: '전세권 / 임차권 설정', re: /전세권설정|지상권설정/, severity: 'warn', desc: '선순위 용익물권 존재 여부 및 말소/승계 조건 확인 필요' }
        ];
        for (const rd of riskDefs) {
            if (rd.re.test(text)) {
                risks.push(rd);
            }
        }

        // Building ledger fields
        const usageM = text.match(/(?:주\s*용\s*도|용\s*도)\s*[:：]?\s*([가-힣0-9종·()/\s]{2,28})/);
        const approvalM = text.match(/사용승인일\s*[:：]?\s*([0-9]{4}[.\-/년\s]+[0-9]{1,2}[.\-/월\s]+[0-9]{1,2})/);
        const parkM = text.match(/(?:총\s*주차|주차\s*대수|옥내자주식|옥외자주식)\s*[:：]?\s*([0-9]+)\s*대/);
        const elevM = text.match(/(?:승용\s*승강기|승강기|엘리베이터)\s*[:：]?\s*([0-9]+)\s*대/);

        const activeMortgages = mortgages.filter(m => !m.isCancelled);
        const totalMortgageManwon = Math.round(totalMortgageWon / 10000);
        const estPrincipalManwon = Math.round(totalMortgageManwon / 1.2);

        const highRiskCount = risks.filter(r => r.severity === 'high').length;
        const safetyLevel = highRiskCount > 0 ? 'danger' : (totalMortgageManwon > 0 || risks.length > 0 ? 'caution' : 'safe');

        _bsLastDocAnalysis = {
            docType,
            address,
            owners,
            parsedAreas,
            mortgages,
            activeMortgages,
            totalMortgageManwon,
            estPrincipalManwon,
            risks,
            usage: usageM ? usageM[1].trim() : '',
            approvalDate: approvalM ? approvalM[1].replace(/[년월]/g, '.').replace(/\s+/g, '') : '',
            parking: parkM ? `${parkM[1]}대` : '',
            elevator: elevM ? `${elevM[1]}대` : '',
            safetyLevel
        };

        const safetyBanner = safetyLevel === 'danger'
            ? `<div class="p-3.5 rounded-xl bg-rose-50 border-2 border-rose-400 text-rose-900"><div class="font-black text-sm flex items-center gap-1.5">🔴 고위험 권리/위반사항 ${highRiskCount}건 감지! 계약 전 반드시 정밀 확인하세요</div><p class="text-xs mt-1 font-semibold">압류·신탁·경매·위반건축물 등은 계약금 지급 전 말소 조건 또는 신탁사 동의서를 반드시 확인해야 합니다.</p></div>`
            : safetyLevel === 'caution'
                ? `<div class="p-3.5 rounded-xl bg-amber-50 border-2 border-amber-300 text-amber-950"><div class="font-black text-sm flex items-center gap-1.5">🟡 근저당/권리 설정 확인 필요 (채권최고액 합계 약 ${bsFormatManwon(totalMortgageManwon)})</div><p class="text-xs mt-1 font-semibold">선순위 채권최고액과 건물 시세 대비 담보 여력을 확인하시고, 필요 시 감액·말소 특약을 넣으세요.</p></div>`
                : `<div class="p-3.5 rounded-xl bg-emerald-50 border-2 border-emerald-300 text-emerald-950"><div class="font-black text-sm flex items-center gap-1.5">🟢 추출된 텍스트 기준 특이 위험 권리 없음 (계약 당일 원본 재확인 권장)</div><p class="text-xs mt-1 font-semibold">서류에 없는 동일업종 제한·관리비 규약은 반드시 관리사무실에 별도 확인해 주세요.</p></div>`;

        if (resultBox) {
            resultBox.innerHTML = `
                <div class="space-y-3">
                    ${safetyBanner}
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div class="bg-white p-3.5 rounded-xl border border-slate-200 space-y-1.5">
                            <div class="text-[11px] font-black text-[#003891] uppercase">📋 기본 정보 (${bsEsc(docType)})</div>
                            <div class="text-xs space-y-1 text-slate-700">
                                <div><span class="font-bold text-slate-500">소재지:</span> <b class="text-slate-900">${bsEsc(address || '텍스트 내 미감지')}</b></div>
                                <div><span class="font-bold text-slate-500">소유자(갑구):</span> <b class="text-slate-900">${bsEsc(owners.length ? owners.join(', ') : '미감지 (원본 확인)')}</b></div>
                                ${usageM ? `<div><span class="font-bold text-slate-500">건축물 용도:</span> <b class="text-slate-900">${bsEsc(_bsLastDocAnalysis.usage)}</b></div>` : ''}
                                ${approvalM ? `<div><span class="font-bold text-slate-500">사용승인일:</span> <b class="text-slate-900">${bsEsc(_bsLastDocAnalysis.approvalDate)}</b></div>` : ''}
                                ${parkM || elevM ? `<div><span class="font-bold text-slate-500">주차/승강기:</span> <b class="text-slate-900">${bsEsc(_bsLastDocAnalysis.parking || '-')} / ${bsEsc(_bsLastDocAnalysis.elevator || '-')}</b></div>` : ''}
                            </div>
                        </div>
                        <div class="bg-white p-3.5 rounded-xl border border-slate-200 space-y-1.5">
                            <div class="text-[11px] font-black text-[#003891] uppercase">📐 면적 &amp; 💰 근저당(을구) 요약</div>
                            <div class="text-xs space-y-1 text-slate-700">
                                ${parsedAreas.length > 0
                                    ? parsedAreas.map(a => `<div>• <b>${bsEsc(a.label)}</b>: ${a.m2}㎡ (<b>약 ${a.py}평</b>)</div>`).join('')
                                    : '<div class="text-slate-400">• 면적 수치 미감지</div>'}
                                <div class="pt-1.5 border-t border-slate-100">
                                    <span class="font-bold text-slate-500">유효 근저당 합계:</span>
                                    <b class="${totalMortgageManwon > 0 ? 'text-rose-700' : 'text-emerald-700'}">${totalMortgageManwon > 0 ? `${bsFormatManwon(totalMortgageManwon)} (${activeMortgages.length}건 · 원금추정 약 ${bsFormatManwon(estPrincipalManwon)})` : '없음 (0원)'}</b>
                                </div>
                                ${activeMortgages.slice(0, 4).map(mg => `<div class="text-[11px] text-slate-600 pl-2">└ ${bsEsc(mg.creditor)}: 채권최고액 ${bsFormatManwon(mg.manwon)}</div>`).join('')}
                            </div>
                        </div>
                    </div>
                    ${risks.length > 0 ? `
                        <div class="bg-rose-50/70 p-3.5 rounded-xl border border-rose-200 space-y-1.5">
                            <div class="text-xs font-black text-rose-900">⚠️ 감지된 주의 권리·키워드</div>
                            ${risks.map(r => `<div class="text-xs text-rose-800">• <b>[${bsEsc(r.label)}]</b> ${bsEsc(r.desc)}</div>`).join('')}
                        </div>
                    ` : ''}
                    <div class="flex flex-wrap gap-2 pt-1">
                        <button type="button" onclick="copyBrokerDocSummary()" class="px-3.5 py-2 rounded-xl bg-[#003891] hover:bg-blue-800 text-white font-extrabold text-xs cursor-pointer">📋 손님 상담용 요약 복사</button>
                        <button type="button" onclick="copyBrokerDocTo18Items()" class="px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-xs cursor-pointer">📌 매물등록용 18항목 초안 복사</button>
                        <button type="button" onclick="switchBrokerSuiteSubTab('checklist')" class="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs cursor-pointer">✅ 현장 실무 확인표로 이동</button>
                    </div>
                </div>
            `;
        }
    }
    window.analyzeBrokerDocText = analyzeBrokerDocText;

    function copyBrokerDocSummary() {
        const a = _bsLastDocAnalysis;
        if (!a) return;
        const lines = [
            `[최가네부동산 공적장부 핵심 확인 요약]`,
            `• 문서구분: ${a.docType}`,
            a.address ? `• 소재지: ${a.address}` : '',
            a.owners.length ? `• 소유자: ${a.owners.join(', ')}` : '',
            ...a.parsedAreas.map(ar => `• ${ar.label}: ${ar.m2}㎡ (약 ${ar.py}평)`),
            a.usage ? `• 건축물 용도: ${a.usage}` : '',
            a.approvalDate ? `• 사용승인일: ${a.approvalDate}` : '',
            `• 근저당 채권최고액 합계: ${a.totalMortgageManwon > 0 ? `${bsFormatManwon(a.totalMortgageManwon)} (${a.activeMortgages.length}건, 원금추정 약 ${bsFormatManwon(a.estPrincipalManwon)})` : '없음'}`,
            a.risks.length ? `• 주의 권리: ${a.risks.map(r => r.label).join(', ')}` : '• 특이 권리제한(압류·가압류·신탁·경매): 확인되지 않음',
            `※ 최종 계약 시 당일 원본 서류 및 관리사무실(업종제한) 확인을 함께 진행합니다.`
        ].filter(Boolean).join('\n');
        bsCopyText(lines, '📋 공적장부 핵심 요약이 복사되었습니다!');
    }
    window.copyBrokerDocSummary = copyBrokerDocSummary;

    function copyBrokerDocTo18Items() {
        const a = _bsLastDocAnalysis;
        if (!a) return;
        const firstArea = a.parsedAreas[0];
        const lines = [
            `🏢매물정보🏢`,
            ``,
            `✅ 위치 : ${a.address || '입력 필요'}`,
            `✅ 전용면적 : ${firstArea ? `약 ${firstArea.py}평 (${firstArea.m2}㎡)` : '입력 필요'}`,
            `✅ 건축물용도 : ${a.usage || '제2종근린생활시설'}`,
            `✅ 사용승인일 : ${a.approvalDate || '입력 필요'}`,
            `✅ 주차 : ${a.parking || '입력 필요'}`,
            `✅ 엘리베이터 : ${a.elevator || '입력 필요'}`
        ].join('\n');
        bsCopyText(lines, '📌 매물등록용 기본 항목이 복사되었습니다!');
    }
    window.copyBrokerDocTo18Items = copyBrokerDocTo18Items;

    // =========================================================================
    // TOOL 3: 🚨 매물 광고 점검 & 표시광고법 누락 자동 감시기
    // =========================================================================
    async function runAdComplianceAudit(forceReload = false) {
        await ensureBrokerSuitePostsLoaded(forceReload);
        const results = [];

        for (const m of _bsAllPosts) {
            const missingStatutory = [];
            const freshnessIssues = [];
            const mediaIssues = [];

            if (!m.isPrivate) {
                if (!m.address) missingStatutory.push('소재지 누락');
                if (!m.primaryPyeong) missingStatutory.push('면적 누락');
                else if (!/(?:㎡|m2|m²)/i.test(`${m.supplyRaw} ${m.exclusiveRaw} ${m.genericAreaRaw} ${m.grossRaw} ${m.landRaw}`)) {
                    missingStatutory.push('㎡ 단위 미병기');
                }
                if (m.isSale) {
                    if (!m.salePrice) missingStatutory.push('매매가 누락');
                } else {
                    if (!m.deposit && !m.rent) missingStatutory.push('보증금·월세 누락');
                }
                if (!m.totalFloor || !m.currentFloor) missingStatutory.push('층수(총층/해당층) 누락');
                if (!m.approvalDate) missingStatutory.push('사용승인일 누락');
                if (!m.direction) missingStatutory.push('방향 누락');
                if (!m.usage) missingStatutory.push('건축물용도 누락');
                if (!m.parking) missingStatutory.push('주차대수 누락');
                if (!m.maintRaw && !m.indivMaintRaw) missingStatutory.push('관리비 누락');

                if (m.ageDays >= 60) freshnessIssues.push(`${m.ageDays}일 경과 (거래종료·시세 재확인 필수)`);
                else if (m.ageDays >= 30) freshnessIssues.push(`${m.ageDays}일 경과 (갱신 권장)`);

                if (m.photoCount === 0) mediaIssues.push('사진 0장');
                if (!Array.isArray(m.coords) || m.coords.length < 2) mediaIssues.push('지도 좌표 없음');
            }

            const totalIssues = missingStatutory.length + freshnessIssues.length + mediaIssues.length;
            results.push({
                meta: m,
                missingStatutory,
                freshnessIssues,
                mediaIssues,
                totalIssues
            });
        }

        _bsAuditItems = results;
        renderAdComplianceAudit();
    }
    window.runAdComplianceAudit = runAdComplianceAudit;

    function setAdAuditFilter(fKey) {
        _bsAuditFilter = fKey;
        renderAdComplianceAudit();
    }
    window.setAdAuditFilter = setAdAuditFilter;

    function renderAdComplianceAudit() {
        const publicItems = _bsAuditItems.filter(it => !it.meta.isPrivate);
        const statutoryCnt = publicItems.filter(it => it.missingStatutory.length > 0).length;
        const stale30Cnt = publicItems.filter(it => it.meta.ageDays >= 30).length;
        const mediaCnt = publicItems.filter(it => it.mediaIssues.length > 0).length;
        const cleanCnt = publicItems.filter(it => it.totalIssues === 0).length;

        const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setEl('bs-audit-stat-statutory', `${statutoryCnt}건`);
        setEl('bs-audit-stat-stale', `${stale30Cnt}건`);
        setEl('bs-audit-stat-media', `${mediaCnt}건`);
        setEl('bs-audit-stat-clean', `${cleanCnt}건`);

        // Highlight active filter button
        ['issues', 'statutory', 'stale30', 'stale60', 'media', 'clean'].forEach(k => {
            const b = document.getElementById(`bs-audit-filter-${k}`);
            if (!b) return;
            b.className = (k === _bsAuditFilter)
                ? 'px-3 py-1.5 rounded-xl bg-[#003891] text-white text-xs font-extrabold cursor-pointer transition'
                : 'px-3 py-1.5 rounded-xl bg-white text-slate-700 border border-slate-200 hover:bg-slate-100 text-xs font-bold cursor-pointer transition';
        });

        const searchQ = (document.getElementById('bs-audit-search')?.value || '').trim().toLowerCase();
        let filtered = publicItems;
        if (_bsAuditFilter === 'issues') filtered = publicItems.filter(it => it.totalIssues > 0);
        else if (_bsAuditFilter === 'statutory') filtered = publicItems.filter(it => it.missingStatutory.length > 0);
        else if (_bsAuditFilter === 'stale30') filtered = publicItems.filter(it => it.meta.ageDays >= 30);
        else if (_bsAuditFilter === 'stale60') filtered = publicItems.filter(it => it.meta.ageDays >= 60);
        else if (_bsAuditFilter === 'media') filtered = publicItems.filter(it => it.mediaIssues.length > 0);
        else if (_bsAuditFilter === 'clean') filtered = publicItems.filter(it => it.totalIssues === 0);

        if (searchQ) {
            filtered = filtered.filter(it => it.meta.title.toLowerCase().includes(searchQ) || String(it.meta.propNo).includes(searchQ) || it.meta.address.toLowerCase().includes(searchQ));
        }

        filtered.sort((a, b) => (b.missingStatutory.length - a.missingStatutory.length) || (b.meta.ageDays - a.meta.ageDays));

        const listBox = document.getElementById('bs-audit-list');
        if (!listBox) return;

        if (filtered.length === 0) {
            listBox.innerHTML = '<div class="text-center py-10 text-emerald-700 font-bold text-sm bg-emerald-50 rounded-xl border border-emerald-200">🎉 해당 조건에 경고 매물이 없습니다! 아주 깔끔하게 관리되고 있습니다.</div>';
            return;
        }

        listBox.innerHTML = filtered.slice(0, 60).map(it => {
            const m = it.meta;
            return `
                <div class="p-3.5 rounded-xl bg-white border border-slate-200 hover:border-slate-300 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div class="min-w-0 flex-1 space-y-1.5">
                        <div class="flex flex-wrap items-center gap-1.5">
                            <span class="px-2 py-0.5 rounded bg-slate-900 text-white text-[11px] font-black">#${bsEsc(m.propNo)}</span>
                            <span class="text-xs font-extrabold text-slate-900 truncate">${bsEsc(m.title)}</span>
                        </div>
                        <div class="flex flex-wrap gap-1">
                            ${it.missingStatutory.map(s => `<span class="px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 text-[11px] font-extrabold">⚠️ ${bsEsc(s)}</span>`).join('')}
                            ${it.freshnessIssues.map(s => `<span class="px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 text-[11px] font-extrabold">🕒 ${bsEsc(s)}</span>`).join('')}
                            ${it.mediaIssues.map(s => `<span class="px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-300 text-[11px] font-bold">📷 ${bsEsc(s)}</span>`).join('')}
                            ${it.totalIssues === 0 ? '<span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-extrabold">✅ 표시광고법·사진·최신성 모두 양호</span>' : ''}
                        </div>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <a href="news-write.html?id=${encodeURIComponent(m.id)}" target="_blank" class="px-2.5 py-1.5 rounded-lg bg-[#003891] hover:bg-blue-800 text-white text-xs font-extrabold whitespace-nowrap">✏️ 바로 수정</a>
                        <button type="button" onclick="quickMarkListingPrivateFromAudit('${bsEsc(m.id)}', '${bsEsc(m.propNo)}')" class="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-rose-100 hover:text-rose-800 text-slate-700 border border-slate-300 text-xs font-bold cursor-pointer whitespace-nowrap">🔒 거래완료 숨김</button>
                    </div>
                </div>
            `;
        }).join('');
    }
    window.renderAdComplianceAudit = renderAdComplianceAudit;

    async function quickMarkListingPrivateFromAudit(postId, propNo) {
        if (!confirm(`[매물번호 #${propNo}] 매물을 거래완료(비공개)로 전환할까요?\n홈페이지와 검색 목록에서 즉시 숨겨집니다.`)) return;
        try {
            if (typeof window.togglePostPrivate === 'function') {
                await window.togglePostPrivate(postId);
            } else if (typeof window.handleTogglePrivate === 'function') {
                await window.handleTogglePrivate(postId);
            } else {
                throw new Error('비공개 전환 함수를 찾을 수 없습니다.');
            }
            await runAdComplianceAudit(true);
            if (typeof window.loadDashboardList === 'function') window.loadDashboardList();
            bsToast(`🔒 #${propNo} 매물이 거래완료(비공개)로 전환되었습니다.`);
        } catch (e) {
            alert('비공개 전환 중 오류: ' + e.message);
        }
    }
    window.quickMarkListingPrivateFromAudit = quickMarkListingPrivateFromAudit;

    // =========================================================================
    // TOOL 4: 📝 매물 연동 계약서·필수 특약 초안 생성기 (A4 인쇄/PDF)
    // =========================================================================
    const CONTRACT_SPECIAL_TERMS = [
        { id: 'st_as_is', group: 'rent', defaultOn: true, label: '현 시설 상태 임대차 & 원상복구 범위', text: '현 시설물 상태에서의 임대차 계약이며, 임대차 종료 시 임차인이 설치한 시설물(간판·칸막이·추가설비)은 임차인 비용으로 원상복구한다. (단, 임대인과 협의하여 기존 시설물을 그대로 인수인계하는 경우 예외로 한다.)' },
        { id: 'st_vat', group: 'rent', defaultOn: true, label: '월세 부가가치세(10%) 별도 & 세금계산서', text: '차임(월세) 및 공용관리비에 대한 부가가치세(10%)는 별도이며, 임대인은 매월 차임 수령 시 임차인에게 적격 세금계산서를 발행한다.' },
        { id: 'st_rentfree', group: 'rent', defaultOn: false, label: '렌트프리(공사기간 무료) 조항', text: '임대인은 임차인의 인테리어 공사 및 개업 준비를 위하여 잔금일(인도일)로부터 1개월간 차임(월세)을 면제(렌트프리)한다. 단, 해당 기간의 공용관리비 및 개별 공과금은 임차인이 부담한다.' },
        { id: 'st_permit', group: 'rent', defaultOn: true, label: '동일업종 제한·인허가 불가 시 계약 해제 (핵심!)', text: '임차인의 희망 업종 영업신고(인허가)가 건축물 용도·정화조·건물 관리규약상 동일업종 제한 등 임대인/건물 측 사유로 불가한 경우, 본 계약은 무효로 하며 임대인은 수령한 계약금을 전액 반환한다.' },
        { id: 'st_parking', group: 'rent', defaultOn: true, label: '주차 대수 & 관리규약 명시', text: '본 목적물의 주차 조건은 건물 관리규약에 따르며, 임차인에게 제공되는 고정주차(무료/유료) 및 방문객 주차 조건을 잔금 전 관리사무실 기준으로 상호 확인한다.' },
        { id: 'st_sign', group: 'rent', defaultOn: false, label: '간판 설치 및 외벽 사용 동의', text: '임대인은 임차인이 관련 법령 및 건물 관리규약 범위 내에서 건물 외벽·전면에 영업용 간판을 설치하는 데 적극 협조한다.' },
        { id: 'st_mortgage', group: 'both', defaultOn: true, label: '권리변동 금지 (추가 근저당·압류 금지)', text: '임대인(매도인)은 계약 체결일 이후 잔금 지급 및 임차인 대항력 취득(또는 소유권이전등기) 완료 시까지 본 목적물에 추가 근저당권·압류·가압류 등 일체의 권리변동을 일으키지 않기로 한다.' },
        { id: 'st_no_prem', group: 'rent', defaultOn: false, label: '무권리 조건 & 권리금 회수기회 보호', text: '본 계약은 권리금(시설비)이 없는 무권리 조건이며, 향후 임대차 종료 시 「상가건물 임대차보호법」에 따른 임차인의 권리금 회수기회를 보장한다.' },
        { id: 'st_clinic', group: 'clinic', defaultOn: false, label: '병의원 개설신고·전기증설·급배수 협조', text: '임대인은 임차인의 의료기관 개설신고, 전기 용량 증설, 급배수·냉난방 배관 및 의료용 설비 시공에 필요한 임대인 동의서 등 제반 서류에 적극 협조한다.' },
        { id: 'st_early_exit', group: 'rent', defaultOn: false, label: '중도해지 통보 및 신규 임차인 주선', text: '임차인이 계약기간 중 부득이하게 중도해지를 원할 경우 최소 3개월 전 서면 통보하며, 기존 조건 이상의 신규 임차인을 주선하고 중개보수를 부담하기로 한다.' },
        { id: 'st_sale_lease', group: 'sale', defaultOn: false, label: '[매매] 기존 임대차 보증금 승계 정산', text: '매수인은 잔금일 현재 본 목적물에 존속하는 기존 임차인의 임대차 보증금 및 임대차계약을 그대로 승계하며, 승계 보증금은 매매 잔금에서 공제 정산한다.' },
        { id: 'st_sale_vat', group: 'sale', defaultOn: false, label: '[매매] 포괄양수도 계약 및 건물분 부가세', text: '본 매매계약은 「부가가치세법」상 사업의 포괄양수도 방식으로 진행하며(또는 건물분 부가가치세 별도 정산), 잔금 전 세무사 확인을 거쳐 세금계산서 및 양수도 계약서를 별도 작성한다.' }
    ];

    let _bsSelectedTermIds = new Set(CONTRACT_SPECIAL_TERMS.filter(t => t.defaultOn).map(t => t.id));

    function renderContractSpecialTermCheckboxes() {
        const box = document.getElementById('bs-contract-terms-checks');
        if (!box) return;
        box.innerHTML = CONTRACT_SPECIAL_TERMS.map(t => {
            const on = _bsSelectedTermIds.has(t.id);
            return `
                <label class="flex items-start gap-2 p-2 rounded-lg border cursor-pointer text-xs transition ${on ? 'bg-blue-50/70 border-[#003891]/40 text-[#0B2545] font-bold' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}">
                    <input type="checkbox" ${on ? 'checked' : ''} onchange="toggleContractTerm('${t.id}')" class="mt-0.5 rounded text-[#003891]" />
                    <span>${bsEsc(t.label)}</span>
                </label>
            `;
        }).join('');
    }

    function toggleContractTerm(termId) {
        if (_bsSelectedTermIds.has(termId)) _bsSelectedTermIds.delete(termId);
        else _bsSelectedTermIds.add(termId);
        renderContractSpecialTermCheckboxes();
        rebuildContractPreview();
    }
    window.toggleContractTerm = toggleContractTerm;

    function applyContractTermPreset(presetKey) {
        _bsSelectedTermIds.clear();
        if (presetKey === 'office') {
            ['st_as_is', 'st_vat', 'st_parking', 'st_mortgage', 'st_no_prem'].forEach(id => _bsSelectedTermIds.add(id));
        } else if (presetKey === 'retail') {
            ['st_as_is', 'st_vat', 'st_rentfree', 'st_permit', 'st_sign', 'st_mortgage'].forEach(id => _bsSelectedTermIds.add(id));
        } else if (presetKey === 'clinic') {
            ['st_as_is', 'st_vat', 'st_rentfree', 'st_permit', 'st_parking', 'st_clinic', 'st_mortgage'].forEach(id => _bsSelectedTermIds.add(id));
        } else if (presetKey === 'sale') {
            ['st_mortgage', 'st_sale_lease', 'st_sale_vat'].forEach(id => _bsSelectedTermIds.add(id));
        }
        renderContractSpecialTermCheckboxes();
        rebuildContractPreview();
    }
    window.applyContractTermPreset = applyContractTermPreset;

    function loadPostIntoContractBuilder(postId) {
        const m = _bsAllPosts.find(p => p.id === String(postId));
        _bsContractSelectedPost = m || null;
        if (!m) return;

        const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        setVal('bs-ct-type', m.isSale ? 'sale' : 'rent');
        setVal('bs-ct-address', m.address || '');
        setVal('bs-ct-floor', m.totalFloor ? `${m.currentFloor || '-'} (총 ${m.totalFloor})` : (m.currentFloor || ''));
        setVal('bs-ct-usage', m.usage || '제2종근린생활시설');
        const areaDisplay = (m.exclusivePyeong && m.supplyPyeong)
            ? `전용 약 ${m.exclusivePyeong}평 (${Math.round(m.exclusivePyeong * 3.3058 * 100) / 100}㎡) / 공급 약 ${m.supplyPyeong}평 (${Math.round(m.supplyPyeong * 3.3058 * 100) / 100}㎡)`
            : (m.primaryPyeong ? `약 ${m.primaryPyeong}평 (${Math.round(m.primaryPyeong * 3.3058 * 100) / 100}㎡)` : '');
        setVal('bs-ct-area', areaDisplay);
        setVal('bs-ct-deposit', m.isSale ? (m.salePrice || 0) : (m.deposit || 0));
        setVal('bs-ct-rent', m.rent || 0);
        setVal('bs-ct-maint', m.maintRaw || (m.maintFee ? `${bsFormatManwon(m.maintFee)}` : '관리규약에 따름'));
        setVal('bs-ct-parking', m.parking || '건물 내 주차');

        if (m.isSale) applyContractTermPreset('sale');
        else if (/병원|의원|클리닉/.test(m.combined)) applyContractTermPreset('clinic');
        else if (/사무실|오피스/.test(m.combined)) applyContractTermPreset('office');
        else applyContractTermPreset('retail');

        rebuildContractPreview();
        bsToast(`📝 #${m.propNo} 매물 정보가 계약서 초안에 자동 입력되었습니다!`);
    }
    window.loadPostIntoContractBuilder = loadPostIntoContractBuilder;

    function openContractForPost(postId) {
        switchBrokerSuiteSubTab('contract');
        const sel = document.getElementById('bs-contract-post-select');
        if (sel) sel.value = postId;
        loadPostIntoContractBuilder(postId);
    }
    window.openContractForPost = openContractForPost;

    function getContractFormData() {
        const g = (id) => (document.getElementById(id)?.value || '').trim();
        const type = g('bs-ct-type') || 'rent';
        const mainAmt = parseFloat(g('bs-ct-deposit')) || 0; // 보증금 or 매매가 (만원)
        const rentAmt = parseFloat(g('bs-ct-rent')) || 0; // 월세 (만원)
        const downPay = Math.round(mainAmt * 0.1 * 10) / 10;
        const balancePay = Math.max(0, Math.round((mainAmt - downPay) * 10) / 10);

        // Statutory brokerage fee ceiling (commercial real estate: up to 0.9%)
        const dealBase = type === 'sale' ? mainAmt : (mainAmt + (rentAmt * 100));
        const maxBrokerFeeManwon = Math.round(dealBase * 0.009 * 10) / 10;

        const selectedTerms = CONTRACT_SPECIAL_TERMS.filter(t => _bsSelectedTermIds.has(t.id)).map(t => t.text);
        const extraTerm = g('bs-ct-extra-terms');
        if (extraTerm) {
            extraTerm.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => selectedTerms.push(l));
        }

        return {
            type,
            address: g('bs-ct-address') || '(소재지 입력)',
            floor: g('bs-ct-floor') || '(층수 입력)',
            usage: g('bs-ct-usage') || '제2종근린생활시설',
            area: g('bs-ct-area') || '(면적 입력)',
            mainAmt,
            rentAmt,
            downPay,
            balancePay,
            maint: g('bs-ct-maint') || '별도',
            parking: g('bs-ct-parking') || '건물 관리규약에 따름',
            period: g('bs-ct-period') || '인도일로부터 24개월',
            landlordName: g('bs-ct-landlord') || '(임대인/매도인 성명)',
            tenantName: g('bs-ct-tenant') || '(임차인/매수인 성명)',
            maxBrokerFeeManwon,
            selectedTerms
        };
    }

    function rebuildContractPreview() {
        const d = getContractFormData();
        const feeEl = document.getElementById('bs-ct-fee-estimate');
        if (feeEl) {
            feeEl.textContent = `법정 중개보수 상한 참고(0.9% 이내 협의): 최대 약 ${bsFormatManwon(d.maxBrokerFeeManwon)} (부가세 별도)`;
        }
        const previewEl = document.getElementById('bs-contract-preview');
        if (!previewEl) return;

        const docTitle = d.type === 'sale' ? '상가 · 건물 매매계약서 (검토용 초안)' : '상가 · 사무실 임대차계약서 (검토용 초안)';
        const mainAmtLabel = d.type === 'sale' ? '매매대금' : '임대차 보증금';
        const partyALabel = d.type === 'sale' ? '매도인' : '임대인';
        const partyBLabel = d.type === 'sale' ? '매수인' : '임차인';

        previewEl.innerHTML = `
            <div class="bg-white border-2 border-slate-800 rounded-lg p-5 sm:p-6 text-slate-900 space-y-4 text-xs sm:text-[13px] leading-relaxed">
                <div class="text-center border-b-2 border-slate-800 pb-3">
                    <div class="text-[10px] font-bold tracking-widest text-slate-500 uppercase">COMMERCIAL REAL ESTATE DRAFT CONTRACT</div>
                    <h4 class="text-lg sm:text-xl font-black text-[#0B2545] mt-0.5">${docTitle}</h4>
                </div>
                <div>
                    <div class="font-black text-[#0B2545] mb-1.5">1. 부동산의 표시</div>
                    <table class="w-full border-collapse border border-slate-400 text-xs">
                        <tr>
                            <th class="w-24 bg-slate-100 border border-slate-400 px-2.5 py-1.5 text-left font-bold">소재지</th>
                            <td colspan="3" class="border border-slate-400 px-2.5 py-1.5 font-bold">${bsEsc(d.address)}</td>
                        </tr>
                        <tr>
                            <th class="bg-slate-100 border border-slate-400 px-2.5 py-1.5 text-left font-bold">용도</th>
                            <td class="border border-slate-400 px-2.5 py-1.5">${bsEsc(d.usage)}</td>
                            <th class="w-20 bg-slate-100 border border-slate-400 px-2.5 py-1.5 text-left font-bold">층수</th>
                            <td class="border border-slate-400 px-2.5 py-1.5">${bsEsc(d.floor)}</td>
                        </tr>
                        <tr>
                            <th class="bg-slate-100 border border-slate-400 px-2.5 py-1.5 text-left font-bold">면적</th>
                            <td colspan="3" class="border border-slate-400 px-2.5 py-1.5 font-bold text-[#003891]">${bsEsc(d.area)}</td>
                        </tr>
                    </table>
                </div>
                <div>
                    <div class="font-black text-[#0B2545] mb-1.5">2. 계약 내용 (금액 및 지급 조건)</div>
                    <table class="w-full border-collapse border border-slate-400 text-xs">
                        <tr>
                            <th class="w-28 bg-slate-100 border border-slate-400 px-2.5 py-1.5 text-left font-bold">${mainAmtLabel}</th>
                            <td class="border border-slate-400 px-2.5 py-1.5 font-black text-[#0B2545]">${bsEsc(bsNumberToKoreanWon(d.mainAmt))}</td>
                        </tr>
                        <tr>
                            <th class="bg-slate-100 border border-slate-400 px-2.5 py-1.5 text-left font-bold">계약금 (10%)</th>
                            <td class="border border-slate-400 px-2.5 py-1.5">${bsEsc(bsNumberToKoreanWon(d.downPay))} — 계약 시 지불</td>
                        </tr>
                        <tr>
                            <th class="bg-slate-100 border border-slate-400 px-2.5 py-1.5 text-left font-bold">잔금 (90%)</th>
                            <td class="border border-slate-400 px-2.5 py-1.5">${bsEsc(bsNumberToKoreanWon(d.balancePay))} — 잔금일(인도일) 지불</td>
                        </tr>
                        ${d.type === 'rent' ? `
                        <tr>
                            <th class="bg-slate-100 border border-slate-400 px-2.5 py-1.5 text-left font-bold">차임 (월세)</th>
                            <td class="border border-slate-400 px-2.5 py-1.5 font-bold">${bsFormatManwon(d.rentAmt)} (부가세 별도) · 공용관리비: ${bsEsc(d.maint)}</td>
                        </tr>
                        <tr>
                            <th class="bg-slate-100 border border-slate-400 px-2.5 py-1.5 text-left font-bold">임대차 기간</th>
                            <td class="border border-slate-400 px-2.5 py-1.5">${bsEsc(d.period)} · 주차: ${bsEsc(d.parking)}</td>
                        </tr>
                        ` : ''}
                    </table>
                </div>
                <div>
                    <div class="font-black text-[#0B2545] mb-1.5">3. 특약사항 (총 ${d.selectedTerms.length}개 항목)</div>
                    <div class="border border-slate-400 rounded p-3 bg-slate-50/70 space-y-1.5 text-xs">
                        ${d.selectedTerms.length > 0
                            ? d.selectedTerms.map((t, i) => `<div><b>${i + 1}.</b> ${bsEsc(t)}</div>`).join('')
                            : '<div class="text-slate-400">선택된 특약사항이 없습니다. 왼쪽에서 특약을 체크해 주세요.</div>'}
                    </div>
                </div>
                <div class="grid grid-cols-3 gap-2 pt-2 text-[11px]">
                    <div class="border border-slate-300 rounded p-2.5"><div class="font-black text-slate-600">${partyALabel}</div><div class="mt-1 font-bold">${bsEsc(d.landlordName)} (인)</div></div>
                    <div class="border border-slate-300 rounded p-2.5"><div class="font-black text-slate-600">${partyBLabel}</div><div class="mt-1 font-bold">${bsEsc(d.tenantName)} (인)</div></div>
                    <div class="border border-slate-300 rounded p-2.5 bg-blue-50/40"><div class="font-black text-[#0B2545]">개업공인중개사</div><div class="mt-0.5 font-bold">최가네부동산공인중개사사무소</div><div class="text-[10px] text-slate-600">대표 최이명 · 제27260-2024-00085호</div></div>
                </div>
                <div class="text-[10px] text-slate-500 pt-1">※ 본 초안은 상담·사전 검토용이며, 정식 계약 체결 시 등기부등본·건축물대장·법정 표준계약서와 숫자를 최종 대조하시기 바랍니다.</div>
            </div>
        `;
    }
    window.rebuildContractPreview = rebuildContractPreview;

    function copyContractSpecialTermsOnly() {
        const d = getContractFormData();
        if (d.selectedTerms.length === 0) {
            alert('선택된 특약사항이 없습니다.');
            return;
        }
        const text = `[특약사항]\n` + d.selectedTerms.map((t, i) => `${i + 1}. ${t}`).join('\n');
        bsCopyText(text, '📋 특약사항이 복사되었습니다! 한방/계약서 프로그램에 바로 Ctrl+V 하세요.');
    }
    window.copyContractSpecialTermsOnly = copyContractSpecialTermsOnly;

    function printContractDraftA4() {
        const previewHtml = document.getElementById('bs-contract-preview')?.innerHTML || '';
        if (!previewHtml) return;
        const win = window.open('', '_blank', 'width=900,height=1050');
        if (!win) {
            alert('팝업이 차단되어 있습니다. 팝업을 허용한 뒤 다시 눌러 주세요.');
            return;
        }
        win.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>계약서 초안 인쇄 | 최가네부동산</title>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
        <script src="https://cdn.tailwindcss.com"></script>
        <style>@page{size:A4;margin:12mm;} body{font-family:Pretendard,sans-serif;background:#fff;padding:12px;} @media print{.no-print{display:none!important;} body{padding:0;}}</style>
        </head><body>
        <div class="no-print mb-4 flex justify-end gap-2"><button onclick="window.print()" style="background:#0B2545;color:#fff;padding:8px 16px;border-radius:8px;font-weight:800;cursor:pointer;">🖨️ A4 인쇄 / PDF 저장</button></div>
        ${previewHtml}
        </body></html>`);
        win.document.close();
        setTimeout(() => { try { win.print(); } catch (e) {} }, 600);
    }
    window.printContractDraftA4 = printContractDraftA4;

    // =========================================================================
    // TOOL 5: ✅ 현장·계약 전 실무 검증 체크리스트 ('최가네 AI 답 확인표')
    // =========================================================================
    const CHECKLIST_GROUPS = [
        {
            id: 'mgmt',
            title: '1. 관리사무실 직접 전화 확인 (서류·AI에 절대 안 나오는 항목!)',
            badge: '관리사무실',
            badgeCls: 'bg-rose-50 text-rose-700 border-rose-200',
            items: [
                { id: 'c_same_biz', label: '건물 내 동일업종 제한(업종 독점 규약) 여부 확인', hint: '등기부·대장 OK여도 관리규약으로 입점 불가한 사례 방지' },
                { id: 'c_mgmt_fee', label: '실제 월 평균 공용관리비 금액 및 포함 항목(전기/수도/청소·VAT)', hint: '최근 3개월 관리비 고지서 기준 확인' },
                { id: 'c_parking_rule', label: '고정주차 무료 대수, 추가 유료주차 요금, 방문객 무료시간', hint: '기계식 주차 SUV/전기차 입고 제한 여부 포함' },
                { id: 'c_sign_rule', label: '외벽·전면·돌출 간판 설치 위치 규정 및 관리단 승인 절차', hint: '가로수 가림·관리단 간판 규격 제한 여부' },
                { id: 'c_reno_rule', label: '인테리어 공사 가능 시간, 보양 규정, 승강기 사용료 확인', hint: '주말/야간 소음 공사 제한 시간 확인' }
            ]
        },
        {
            id: 'gov',
            title: '2. 관할 구청·보건소·소방 인허가 확인',
            badge: '구청·인허가',
            badgeCls: 'bg-blue-50 text-[#003891] border-blue-200',
            items: [
                { id: 'c_usage_match', label: '건축물대장 주용도와 희망 업종 일치 여부 (근생·업무·의료시설)', hint: '용도변경 필요 시 비용·기간·주차대수 증가 여부 체크' },
                { id: 'c_biz_permit', label: '관할 구청 영업신고 / 학원설립 / 의료기관 개설신고 가능 여부', hint: '학교정화구역·거리제한·직통계단 요건 확인' },
                { id: 'c_septic', label: '정화조 용량 및 하수도 원인자부담금 발생 여부', hint: '음식점·카페·병의원·미용실 입점 시 필수!' },
                { id: 'c_fire', label: '소방·다중이용업소 안전시설 완비증명 필요 여부', hint: '지하·2층 이상 휴게/일반음식점·학원 등' }
            ]
        },
        {
            id: 'site',
            title: '3. 현장 직접 방문 감각 체크 (사진·로드뷰에 없는 것!)',
            badge: '현장 육안',
            badgeCls: 'bg-emerald-50 text-emerald-800 border-emerald-200',
            items: [
                { id: 'c_smell_noise', label: '옆 가게 음식 냄새·배기구·실외기 소음·진동 유무', hint: '창문 열고 실제 체감 확인' },
                { id: 'c_sign_view', label: '가로수·전봇대·버스정류장 등에 의한 간판 시야 가림 확인', hint: '차량 주행 방향·보행자 시선에서 확인' },
                { id: 'c_evening', label: '낮 시간대 vs 퇴근·저녁 시간대 골목 분위기 및 유동인구', hint: '업종별 피크 시간대 현장 체감' },
                { id: 'c_facility', label: '화장실 위치/청결도, 천장 누수·결로, 냉난방기 연식·작동 상태', hint: '에어컨·보일러 소유권 및 수리 주체 확인' },
                { id: 'c_power', label: '전기 용량(kW) 증설 가능 여부 및 급배수관 위치', hint: '카페·식당·병의원·미용실 필수 체크' }
            ]
        },
        {
            id: 'legal',
            title: '4. 계약 도장 직전 최종 권리 대조 (5분 필수 체크)',
            badge: '등기·계약',
            badgeCls: 'bg-amber-50 text-amber-800 border-amber-200',
            items: [
                { id: 'c_reg_today', label: '계약 당일 최신 등기부등본 재발급 (근저당·압류·신탁 변동 확인)', hint: '신탁 물건은 신탁사 동의서 없으면 무효 위험!' },
                { id: 'c_id_bank', label: '임대인 신분증 진위 + 소유자·입금 계좌 예금주 일치 확인', hint: '공동소유 시 전원 동의/위임장 확인' },
                { id: 'c_proxy', label: '대리인 계약 시 위임장 + 인감증명서(3개월 이내) + 소유자 통화', hint: '계약금은 반드시 소유자 본인 명의 계좌로 입금' },
                { id: 'c_tax_clear', label: '임대인 국세·지방세 완납증명 및 선순위 보증금 확인', hint: '고액 보증금 계약 시 필수' },
                { id: 'c_special_read', label: '특약사항 쌍방 낭독 확인 및 사업자등록·확정일자 안내', hint: '환산보증금 기준 대항력·확정일자 안내' }
            ]
        }
    ];

    function loadChecklistsFromStorage() {
        try {
            const raw = localStorage.getItem(BS_CHECKLIST_STORAGE_KEY);
            _bsChecklistsStore = raw ? JSON.parse(raw) : {};
        } catch (e) {
            _bsChecklistsStore = {};
        }
    }

    function saveChecklistsToStorage() {
        try {
            localStorage.setItem(BS_CHECKLIST_STORAGE_KEY, JSON.stringify(_bsChecklistsStore));
        } catch (e) {}
    }

    function selectChecklistProperty(key) {
        _bsActiveChecklistKey = key || 'general_default';
        renderChecklistView();
    }
    window.selectChecklistProperty = selectChecklistProperty;

    function openChecklistForPost(postId) {
        switchBrokerSuiteSubTab('checklist');
        const sel = document.getElementById('bs-checklist-post-select');
        if (sel) sel.value = postId;
        selectChecklistProperty(postId);
    }
    window.openChecklistForPost = openChecklistForPost;

    function toggleChecklistItem(itemId) {
        if (!_bsChecklistsStore[_bsActiveChecklistKey]) {
            _bsChecklistsStore[_bsActiveChecklistKey] = { checked: {}, notes: {}, updatedAt: Date.now() };
        }
        const entry = _bsChecklistsStore[_bsActiveChecklistKey];
        entry.checked[itemId] = !entry.checked[itemId];
        entry.updatedAt = Date.now();
        saveChecklistsToStorage();
        renderChecklistView();
    }
    window.toggleChecklistItem = toggleChecklistItem;

    function updateChecklistItemNote(itemId, val) {
        if (!_bsChecklistsStore[_bsActiveChecklistKey]) {
            _bsChecklistsStore[_bsActiveChecklistKey] = { checked: {}, notes: {}, updatedAt: Date.now() };
        }
        _bsChecklistsStore[_bsActiveChecklistKey].notes[itemId] = val;
        _bsChecklistsStore[_bsActiveChecklistKey].updatedAt = Date.now();
        saveChecklistsToStorage();
    }
    window.updateChecklistItemNote = updateChecklistItemNote;

    function resetActiveChecklist() {
        if (!confirm('현재 선택된 매물/계약건의 체크 상태를 모두 초기화할까요?')) return;
        delete _bsChecklistsStore[_bsActiveChecklistKey];
        saveChecklistsToStorage();
        renderChecklistView();
    }
    window.resetActiveChecklist = resetActiveChecklist;

    function renderChecklistView() {
        const container = document.getElementById('bs-checklist-groups');
        const progText = document.getElementById('bs-checklist-progress-text');
        const progBar = document.getElementById('bs-checklist-progress-bar');
        if (!container) return;

        const entry = _bsChecklistsStore[_bsActiveChecklistKey] || { checked: {}, notes: {} };
        const totalItems = CHECKLIST_GROUPS.reduce((sum, g) => sum + g.items.length, 0);
        const doneItems = CHECKLIST_GROUPS.reduce((sum, g) => sum + g.items.filter(it => entry.checked && entry.checked[it.id]).length, 0);
        const pct = Math.round((doneItems / Math.max(totalItems, 1)) * 100);

        if (progText) progText.textContent = `${doneItems} / ${totalItems} 항목 현장검증 완료 (${pct}%)`;
        if (progBar) progBar.style.width = `${pct}%`;

        container.innerHTML = CHECKLIST_GROUPS.map(g => {
            const gDone = g.items.filter(it => entry.checked && entry.checked[it.id]).length;
            return `
                <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
                    <div class="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2">
                        <div class="font-black text-xs sm:text-sm text-[#0B2545] flex items-center gap-2">
                            <span class="px-2 py-0.5 rounded border text-[10px] font-black ${g.badgeCls}">${bsEsc(g.badge)}</span>
                            <span>${bsEsc(g.title)}</span>
                        </div>
                        <span class="text-xs font-extrabold ${gDone === g.items.length ? 'text-emerald-700' : 'text-slate-500'}">${gDone}/${g.items.length}</span>
                    </div>
                    <div class="divide-y divide-slate-100">
                        ${g.items.map(it => {
                            const isDone = Boolean(entry.checked && entry.checked[it.id]);
                            const noteVal = (entry.notes && entry.notes[it.id]) || '';
                            return `
                                <div class="p-3 flex flex-col sm:flex-row sm:items-center gap-2.5 ${isDone ? 'bg-emerald-50/35' : ''}">
                                    <label class="flex items-start gap-2.5 flex-1 cursor-pointer">
                                        <input type="checkbox" ${isDone ? 'checked' : ''} onchange="toggleChecklistItem('${it.id}')" class="mt-0.5 w-4 h-4 rounded text-emerald-600 cursor-pointer shrink-0" />
                                        <div class="min-w-0">
                                            <div class="text-xs sm:text-[13px] font-extrabold ${isDone ? 'text-emerald-900 line-through' : 'text-slate-900'}">${bsEsc(it.label)}</div>
                                            <div class="text-[11px] text-slate-500 mt-0.5">${bsEsc(it.hint)}</div>
                                        </div>
                                    </label>
                                    <input type="text" value="${bsEsc(noteVal)}" oninput="updateChecklistItemNote('${it.id}', this.value)" placeholder="확인 결과 메모 (예: 관리실 확인 완료, 제한 없음)" class="w-full sm:w-64 rounded-lg border-slate-300 text-xs p-1.5 bg-white" />
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }).join('');
    }

    function copyChecklistClientReport() {
        const entry = _bsChecklistsStore[_bsActiveChecklistKey] || { checked: {}, notes: {} };
        const matchedPost = _bsAllPosts.find(p => p.id === _bsActiveChecklistKey);
        const headerLabel = matchedPost ? `매물번호 #${matchedPost.propNo} (${matchedPost.address || matchedPost.title.slice(0, 24)})` : '현장·계약 사전 실무 점검';

        const lines = [
            `✅ [최가네부동산 현장·서류 직접 검증 리포트]`,
            `대상: ${headerLabel}`,
            `━━━━━━━━━━━━━━━━━━`
        ];
        let checkedCnt = 0;
        CHECKLIST_GROUPS.forEach(g => {
            const doneInG = g.items.filter(it => entry.checked && entry.checked[it.id]);
            if (doneInG.length > 0) {
                lines.push(`[${g.badge}]`);
                doneInG.forEach(it => {
                    checkedCnt++;
                    const memo = (entry.notes && entry.notes[it.id] || '').trim();
                    lines.push(`• ✓ ${it.label}${memo ? ` → ${memo}` : ''}`);
                });
            }
        });
        if (checkedCnt === 0) {
            alert('완료 체크된 항목이 없습니다. 확인 완료한 항목을 체크한 뒤 복사해 주세요.');
            return;
        }
        lines.push(`━━━━━━━━━━━━━━━━━━`);
        lines.push(`서류에 나오지 않는 관리규약·현장 컨디션까지 최가네부동산이 직접 발로 확인했습니다.`);
        lines.push(`최가네부동산 공인중개사사무소 | 010-3548-4000`);
        bsCopyText(lines.join('\n'), '✅ 손님 전달용 현장검증 리포트가 복사되었습니다!');
    }
    window.copyChecklistClientReport = copyChecklistClientReport;
})();
