import { showPublicCleaningForDate } from './cleaning-public-read.js';
import { encodeAction } from './original-events.js';

    import { initializeApp, getApps, getApp } from './preview-data.js';
    import { getDatabase, ref, onValue } from './preview-data.js';

    // ── 청소 당번표(cleaning_duty_3.html) 데이터 읽기 전용 패널 ──────────────
    // 같은 Firebase 프로젝트를 그대로 사용하되, 위 메인 스크립트가 이미 앱을 초기화해두었으면
    // 그 앱을 재사용한다(같은 설정으로 initializeApp을 두 번 부르면 오류가 나기 때문).
    // 이 스크립트는 cleaningDuty 노드를 읽기만 하고 절대 쓰지 않으므로, 기존 예약/성경읽기/
    // 인원체크 기능에는 영향이 없다.
    const cdFirebaseConfig = {};
    const cdApp = getApps().length ? getApp() : initializeApp(cdFirebaseConfig);
    const cdDb = getDatabase(cdApp);

    const CD_CLASS_IDS = ['6학년','7-1','7-2','8-1','8-2'];
    const CD_WEEKDAYS = ['월','화','수','목','금'];

    let cdQuarter = { weeks: [] };
    let cdZones = {};
    let cdClassroomAssignment = {};
    let cdRecyclingAssignment = {};
    let cdWeekdayAssignment = {};
    let cdFridayLabel = {};
    let cdSelectedDate = new Date();

    function cdIsNonHomeDayDuty(cid, day, name){
      const homeDay = (cdWeekdayAssignment[cid] && cdWeekdayAssignment[cid][name] && cdWeekdayAssignment[cid][name].day) || '';
      return !!homeDay && ['월','화','수','목'].includes(homeDay) && homeDay !== day;
    }

    // 담임교사 요청(2026-09-XX): 구역 이름 없이 이름만 쭉 나열되면 어느 구역에 누가 배정됐는지
    // 구분이 안 돼 가독성이 떨어진다 — 구역별로 행을 나눈 표로 보여주기 위해, 각 구역의 이름
    // 목록(HTML)만 배열로 반환한다(표를 그리는 건 renderCleaningForDate 쪽에서 담당).
    // 분리수거 겹침·보강(원래 요일이 아닌 날 청소) 강조는 기존과 동일하게 유지한다.
    function cdZoneRows(cid, weekNo, day){
      const zoneList = cdZones[cid] || [];
      const cellData = (cdClassroomAssignment[cid] && cdClassroomAssignment[cid][weekNo] && cdClassroomAssignment[cid][weekNo][day]) || {};
      const dateRecycling = (cdRecyclingAssignment[weekNo] && cdRecyclingAssignment[weekNo][day]) || [];
      const wdMapForCid = cdWeekdayAssignment[cid] || {};
      return zoneList.map(z => {
        const cell = cellData[z.name];
        const names = (cell?.names || []).map(n => {
          if (dateRecycling.includes(n)){
            return `<span data-original-style="1" title="이 날 분리수거 당번과 겹칩니다">⚠${n}</span>`;
          } else if (cdIsNonHomeDayDuty(cid, day, n)){
            const homeDay = (wdMapForCid[n]||{}).day;
            return `<span data-original-style="2" title="원래 요일(${homeDay||'?'}요일)이 아닌 이 날 보강으로 청소하게 된 학생입니다">${n}</span>`;
          }
          return n;
        });
        return { zone: z.name, namesHtml: names.length ? names.join(', ') : '-' };
      });
    }

    // 임의의 날짜가 청소 당번표 쿼터의 몇 주차·무슨 요일에 해당하는지 계산한다.
    // (쿼터 시작일은 항상 월요일이라고 가정 — cleaning_duty_3.html의 달력 생성 로직과 동일)
    function cdFindWeekDay(dateObj){
      if (!cdQuarter.startDate || !cdQuarter.weeks || !cdQuarter.weeks.length) return null;
      const start = new Date(cdQuarter.startDate + 'T00:00:00');
      const startOnly = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const target = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
      const diffDays = Math.round((target - startOnly) / 86400000);
      if (diffDays < 0) return null;
      const weekIdx = Math.floor(diffDays / 7);
      if (weekIdx >= (cdQuarter.weekCount || cdQuarter.weeks.length)) return null;
      const dayIdx = diffDays % 7; // 0=월 ... 4=금, 5=토, 6=일
      if (dayIdx >= 5) return { weekend: true };
      return { weekNo: weekIdx + 1, day: CD_WEEKDAYS[dayIdx] };
    }

    function renderCleaningForDate(dateObj){
      const body = document.getElementById('cleaningPanelBody');
      const title = document.getElementById('cleaningPanelTitle');
      if (!body || !title) return;
      cdSelectedDate = dateObj;
      const m = dateObj.getMonth() + 1, d = dateObj.getDate();
      const dowFull = ['일','월','화','수','목','금','토'][dateObj.getDay()];
      const t = new Date();
      const isToday = dateObj.getFullYear() === t.getFullYear() && dateObj.getMonth() === t.getMonth() && dateObj.getDate() === t.getDate();
      title.textContent = `🧹 ${isToday ? '오늘' : `${m}/${d}`} 청소 당번 (${dowFull})`;

      if (!cdQuarter.weeks || !cdQuarter.weeks.length){
        body.innerHTML = '청소 당번표가 아직 설정되지 않았습니다.';
        return;
      }
      const wd = cdFindWeekDay(dateObj);
      if (!wd){
        body.innerHTML = '이 날짜는 청소 당번표 기간(쿼터) 밖입니다.';
        return;
      }
      if (wd.weekend){
        body.innerHTML = '주말은 청소 당번이 없습니다.';
        return;
      }
      const thCls = 'border border-emerald-200 bg-emerald-100 px-2 py-1 text-emerald-800 font-bold text-left';
      const tdCls = 'border border-emerald-200 px-2 py-1 align-top';
      // 담임교사 요청: 반마다 줄 배경색을 번갈아 줘서(6학년=연한 초록, 7-1=조금 더 연한 연두,
      // 7-2=연한 초록, 8-1=연한 연두, 8-2=연한 초록 …) 반 구분이 표에서 한눈에 들어오게 한다.
      const CD_BAND_COLORS = ['#ecfdf5', '#f7fee7']; // [연한 초록(emerald-50), 조금 더 연한 연두(lime-50)]
      const bandColorFor = (ci) => CD_BAND_COLORS[ci % 2];
      let html = '';
      if (wd.day === '금'){
        html += '<div class="text-xs text-emerald-700 mb-2">금요일은 반별 문구로 안내됩니다.</div>';
        html += '<div class="overflow-x-auto"><table class="w-full text-xs" data-original-style="3">';
        html += `<tr><th class="${thCls}">반</th><th class="${thCls}">안내</th></tr>`;
        CD_CLASS_IDS.forEach((cid, ci) => {
          const label = (cdFridayLabel[cid] && cdFridayLabel[cid][wd.weekNo]) || '다같이';
          const bg = `background:${bandColorFor(ci)};`;
          html += `<tr><td class="${tdCls} font-bold" data-duty-band="${ci % 2}">${cid}</td><td class="${tdCls}" data-duty-band="${ci % 2}">${label}</td></tr>`;
        });
        html += '</table></div>';
      } else {
        html += '<div class="overflow-x-auto"><table class="w-full text-xs" data-original-style="3">';
        html += `<tr><th class="${thCls}">반</th><th class="${thCls}">구역</th><th class="${thCls}">담당 학생</th></tr>`;
        CD_CLASS_IDS.forEach((cid, ci) => {
          const bg = `background:${bandColorFor(ci)};`;
          const rows = cdZoneRows(cid, wd.weekNo, wd.day);
          if (!rows.length){
            html += `<tr><td class="${tdCls} font-bold" data-duty-band="${ci % 2}">${cid}</td><td class="${tdCls}" data-duty-band="${ci % 2}" colspan="2">구역 정보 없음</td></tr>`;
            return;
          }
          rows.forEach((r, idx) => {
            html += '<tr>';
            if (idx === 0) html += `<td class="${tdCls} font-bold" data-duty-band="${ci % 2}" rowspan="${rows.length}">${cid}</td>`;
            html += `<td class="${tdCls}" data-duty-band="${ci % 2}">${r.zone}</td><td class="${tdCls}" data-duty-band="${ci % 2}">${r.namesHtml}</td>`;
            html += '</tr>';
          });
        });
        html += '</table></div>';
        const recy = (cdRecyclingAssignment[wd.weekNo] && cdRecyclingAssignment[wd.weekNo][wd.day]) || [];
        html += `<div class="mt-2 pt-2 border-t border-emerald-200"><b>♻️ 분리수거</b>: ${recy.length ? recy.join(', ') : '-'}</div>`;
      }
      body.innerHTML = html;
      cdSyncPanelHeight();
    }

    // 담임교사 요청(2026-09-XX): 청소 당번 패널을 스크롤로 줄여서 맞추니 한눈에 안 보여 불편하다 —
    // 대신 반대로, 패널의 원래(스크롤 없는) 전체 높이에 맞춰 "달력 쪽"을 늘린다. 요일 헤더 줄은
    // 원래 크기 그대로 두고, 날짜 줄들만 남는 높이를 균등하게 나눠 가져서 칸이 커진다. 모바일처럼
    // 한 줄로 쌓이는 화면(768px 미만)에서는 굳이 맞출 필요가 없으므로 원래 크기로 되돌린다.
    function cdSyncPanelHeight(){
      const calBox = document.getElementById('calendarCard');
      const panelBox = document.getElementById('cleaningPanelCard');
      const calGrid = document.getElementById('calendar');
      if (!calBox || !panelBox || !calGrid) return;

      // 먼저 원래 크기로 되돌려서 정확한 자연 높이를 다시 잰다(이전에 늘려놓은 값이 남아있지
      // 않도록).
      calGrid.style.height = '';
      calGrid.style.gridTemplateRows = '';

      if (!window.matchMedia('(min-width: 768px)').matches) return; // 모바일은 원래 크기 유지

      const naturalGridHeight = calGrid.offsetHeight;
      // 관리자 대시보드가 열려 있는 등 달력이 화면에서 숨겨진 상태(display:none)라면
      // offsetHeight가 0으로 나온다 — 이때 그대로 계산해서 적용하면 나중에 달력이 다시
      // 보일 때 0으로 찌그러진 채로 남는다. 그런 경우는 아무것도 바꾸지 않고 건너뛴다.
      if (naturalGridHeight === 0) return;

      const navRow = calBox.children[0];
      const navHeight = navRow ? navRow.offsetHeight : 0;
      const navMarginBottom = navRow ? (parseFloat(getComputedStyle(navRow).marginBottom) || 0) : 0;
      const targetGridHeight = Math.max(naturalGridHeight, panelBox.offsetHeight - navHeight - navMarginBottom);

      // 전체 칸 수에서 요일 헤더(7칸)를 뺀 나머지를 7로 나누면 날짜 줄 수(보통 5~6줄)가 나온다.
      const totalCells = calGrid.children.length;
      const weekRows = Math.max(1, Math.round((totalCells - 7) / 7));
      calGrid.style.height = targetGridHeight + 'px';
      calGrid.style.gridTemplateRows = `auto repeat(${weekRows}, 1fr)`;
    }
    window.addEventListener('resize', () => cdSyncPanelHeight());

    // index.html의 메인 달력(renderCalendar)이 날짜 버튼을 클릭할 때 이 함수를 호출한다.
    window.__showCleaningForDate = renderCleaningForDate;
    window.__syncCleaningPanelHeight = () => {
      // Booking-disabled dates still have their original cleaning click listener.
      for (const button of document.querySelectorAll('#calendar button:disabled')) {
        button.disabled = false;
        button.classList.remove('cursor-not-allowed');
        button.classList.add('cursor-pointer');
        button.title = '청소 당번 보기';
      }
      cdSyncPanelHeight();
    };
    window.__syncCleaningPanelHeight();

    window.__showCleaningForDate = date => {
      const title = document.getElementById('cleaningPanelTitle');
      const container = document.getElementById('cleaningPanelBody');
      const day = ['일','월','화','수','목','금','토'][date.getDay()];
      title.textContent = '🧹 ' + (date.getMonth() + 1) + '/' + date.getDate() + ' 청소 당번 (' + day + ')';
      void showPublicCleaningForDate(date,container).then(cdSyncPanelHeight);
    };
    window.__showCleaningForDate(new Date());