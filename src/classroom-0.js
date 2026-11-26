import { encodeAction, installOriginalEvents } from './original-events.js';
installOriginalEvents();

    import { initializeApp } from './preview-data.js';
    import { getDatabase, ref, set, get, onValue, runTransaction } from './preview-data.js';
    import { getAuth, signInAnonymously } from './preview-data.js';

    // Firebase config
    const firebaseConfig = {};

    const app = initializeApp(firebaseConfig);
    const database = getDatabase(app);
    const auth = getAuth(app);

    // 익명 로그인 시도 (실패해도 기존 기능에는 영향 없음 — Firebase 콘솔에서
    // Authentication > Sign-in method > 익명(Anonymous)을 켜야 성공합니다)
    async function ensureAnonAuth(){
      try {
        await signInAnonymously(auth);
      } catch (e) {
        console.error('익명 로그인 실패 (Firebase 콘솔에서 익명 로그인을 켜주세요):', e);
      }
    }

    // 상태
    let currentDate = new Date();
    function normalizeCurrentDate(){ if (!currentDate || isNaN(currentDate.getTime())) currentDate = new Date(); const y=currentDate.getFullYear(); if (y<1900||y>2100) currentDate=new Date(); }
    normalizeCurrentDate();

    let selectedDate = null;
    let bookings = {};
    let archivedBookings = {};
    let isAdminLoggedIn = false;
    let classrooms = ["강당","세미나실","미술실","별관1","별관2","밴드실","요리실","컴퓨터실","음악실","도서관"];
    // 교무부장 요청(2026-10-19): 목요일 규칙에 학년 교실 5개를 추가한다. 도서관·강당 저녁1·2교시
    // 특수 슬롯과 달리, 이 5개는 관리자가 "요일별 신청 허용"에서 체크한 요일·시간대에만 열리고
    // (허용 체크 없이 저절로 열리지 않음), 같은 학년 학생만 신청할 수 있다(7학년은 7-1·7-2 중
    // 아무 쪽이나, 8학년은 8-1·8-2 중 아무 쪽이나, 6학년은 6학년 교실만).
    const NEW_THU_CLASSROOMS = ['6학년','7-1','7-2','8-1','8-2'];
    const CLASSROOM_GRADE = { '6학년':'6', '7-1':'7', '7-2':'7', '8-1':'8', '8-2':'8' };
    function isNewThuClassroomSlot(room, slot){
      return NEW_THU_CLASSROOMS.includes(room) && (slot === '저녁1교시' || slot === '저녁2교시');
    }
    function gradeOfUserName(name){
      const m = (name||'').match(/^(\d+)/);
      return m ? m[1] : null;
    }
    let allowedDates = new Set();
    // 학년 교실 5개를 "딱 한 번만" 자동으로 추가했는지 여부(Firebase에 저장). 한 번 추가된 뒤로는
    // 관리자가 다른 강의실처럼 자유롭게 삭제할 수 있어야 하므로, 이 플래그가 true가 되면
    // 다시는 자동으로 재추가하지 않는다.
    let gradeRoomsSeeded = false;
    let adminPassword = 'design-test-admin';
    let bookingTimes = { regularStart:"12:55", regularEnd:"23:35", eveningStart:"16:00", eveningEnd:"20:00", cbStart:"08:00", cbEnd:"23:35" };
    let scheduleNotes = {};
    let weeklyAvailability = {};     // 현재 사용 중 (하위호환)
    let baseWeeklyAvailability = {};  // 정기세팅
    let tempAvailability = {};        // 일시적세팅 {날짜: {강의실: {시간대: bool}}}
    let thursdayRuleDay  = '목'; // 목요일 규칙 적용 요일 (기본: 목)
    let thursdayRuleDates = new Set(); // 특수 규칙 적용 날짜들 (여러 날 가능, 지난 날짜 자동 제거)
    let selfCheckMode = false; // 학생 자기체크 모드
    let rosterMonWed = []; // 월·수 명단
    let rosterTueThu = []; // 화·목 명단
    let activeRosterTab = ''; // 'monwed' | 'tuethu'
    let activeTodayTab  = ''; // Firebase 동기화: 오늘의 활성 탭
    // 2026-11-05 요청: 관리자모드 "오늘의 신청현황"에서 교시별 카드 접기/펼치기.
    // todayBookingsCollapsed: {timeSlot: true(접힘)/false(펼침)} — 관리자가 직접 건드리지 않은
    // 교시는 renderTodayBookings가 매번 현재 시각 기준으로 다시 계산해서 넣어준다(그래서 패널을
    // 계속 켜둔 채로 16:15이 지나가면 자동으로 접힘/펼침이 바뀜). 관리자가 수동으로 한 번
    // 누른 교시는 todayBookingsManualTouch에 기록되고, 그 뒤로는 시간 기준 자동 전환을
    // 멈추고 관리자가 선택한 상태를 유지한다(페이지를 새로고침하면 다시 자동 모드로 돌아감).
    let todayBookingsCollapsed = {};
    let todayBookingsManualTouch = new Set();
    function getTodayBookingsTimeDefault(timeSlot){
      const now = new Date();
      const mins = now.getHours()*60 + now.getMinutes();
      const isP9P10   = (timeSlot === '9교시' || timeSlot === '10교시');
      const isEvening = (timeSlot === '저녁1교시' || timeSlot === '저녁2교시');
      if (mins >= 16*60+30 && mins <= 18*60+15) return isEvening; // 9·10교시 펼침, 저녁1·2 접음
      if (mins >= 18*60+16 && mins <= 20*60+30) return isP9P10;   // 저녁1·2 펼침, 9·10교시 접음
      return false; // 그 외 시간대는 모두 펼침(기본값)
    }
    window.toggleTodayBookingsSlot = function(timeSlot){
      todayBookingsManualTouch.add(timeSlot);
      todayBookingsCollapsed[timeSlot] = !todayBookingsCollapsed[timeSlot];
      safeRender(renderTodayBookings);
    };
    let chromebookBookings = {}; // 크롬북 신청 데이터 {dateKey: {classKey: {studentId: {purpose9,purpose10}}}}
    let chromebookReturnPeriod = {}; // 학생별 반납기간 {classKey: {studentId: "5/28-6/10(용도외 사용)"}}
    let chromebookReturnPeriodArchive = {}; // 반납기간 이력 보관 (삭제돼도 유지)
    let chromebookPasswords = {}; // 학생별 크롬북 비밀번호 — Firebase chromebookBookings/_pw/{sid}

    async function saveCbPassword(sid, pw) {
      try {
        if (pw === null) delete chromebookPasswords[sid];
        else chromebookPasswords[sid] = pw;
        await saveToFirebase(`chromebookBookings/_pw/${sid}`, pw);
      } catch(e) { console.error('saveCbPassword 오류', e); }
    }
    let activeTodaySubTab = 'classroom'; // 금일 현황 서브탭
    let activeChromebookClass = null; // 현재 선택된 반 {grade, cls}
    const timeSlots = ['9교시','10교시','저녁1교시','저녁2교시'];

    window.bookingTimes = bookingTimes;

    // 유틸
    function toMinutes(hhmm){
      if(!hhmm || typeof hhmm !== 'string') return null;
      const parts = hhmm.trim().split(':').map(s=>s.trim());
      if(parts.length !== 2) return null;
      const h = parseInt(parts[0],10), m = parseInt(parts[1],10);
      if(Number.isNaN(h) || Number.isNaN(m)) return null;
      return h*60 + m;
    }
    function isTimeInRangeNow(startHHMM, endHHMM){
      const now = new Date(); const cur = now.getHours()*60 + now.getMinutes();
      const s = toMinutes(startHHMM); const e = toMinutes(endHHMM);
      if(s===null || e===null) return false;
      if(s <= e) return (cur >= s && cur < e);
      return (cur >= s) || (cur < e);
    }
    function getDateKey(date){ if(!date) date = new Date(); if(!(date instanceof Date)) date = new Date(date); return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0'); }
    function getDayOfWeek(date){ const w=['일','월','화','수','목','금','토']; if(!date) date=new Date(); if(!(date instanceof Date)) date = new Date(date); return w[date.getDay()]; }

    window.toMinutes = toMinutes; window.getDateKey = getDateKey; window.getDayOfWeek = getDayOfWeek;

    // 목요일 규칙 Firebase 데이터 파서 (구형/신형 형식 모두 처리)
    function parseThuRuleData(v) {
      console.log('[THU] parseThuRuleData 입력:', JSON.stringify(v));
      if (!v || typeof v !== 'object') {
        console.log('[THU] 데이터 없음 → 빈 Set');
        return new Set();
      }
      const today = getDateKey(new Date());
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      const newFmt = Object.keys(v).filter(d => dateRegex.test(d));
      console.log('[THU] 신형 키:', newFmt, '/ today:', today);
      if (newFmt.length > 0) {
        const result = new Set(newFmt.filter(d => d >= today));
        console.log('[THU] 신형 결과:', [...result]);
        return result;
      }
      let raw = [];
      if (Array.isArray(v.dates))                   raw = v.dates;
      else if (v.dates && typeof v.dates==='object') raw = Object.values(v.dates);
      else if (v.date)                               raw = [v.date];
      console.log('[THU] 구형 raw:', raw);
      const filtered = raw.filter(d => d && dateRegex.test(d) && d >= today);
      console.log('[THU] 구형 필터 결과:', filtered);
      if (filtered.length > 0) {
        const obj = {}; filtered.forEach(d => { obj[d] = true; });
        saveToFirebase('thursdayRule', obj).catch(()=>{});
        console.log('[THU] 구형→신형 마이그레이션 저장');
      }
      return new Set(filtered);
    }

    // 목요일 규칙: 오늘이 지정 날짜 목록에 포함되면 오늘 요일에 규칙 적용
    function getEffectiveThuRuleDay() {
      const today = getDateKey(new Date());
      if (thursdayRuleDates.has(today)) return getDayOfWeek(new Date());
      return '목';
    }

    // 시간/허용 판정
    function isWithinBookingTime(slotName){
      try{
        let startStr=null, endStr=null;
        if(slotName === '9교시' || slotName === '10교시'){ startStr = bookingTimes.regularStart; endStr = bookingTimes.regularEnd; }
        else if(slotName === '저녁1교시' || slotName === '저녁2교시'){ startStr = bookingTimes.eveningStart; endStr = bookingTimes.eveningEnd; }
        else return false;
        if(!startStr || !endStr) return false;
        return isTimeInRangeNow(startStr, endStr);
      } catch(e){ console.error('isWithinBookingTime error', e); return false; }
    }
    window.isWithinBookingTime = isWithinBookingTime;

    function populateTimeSettingsInputs() {
      try {
        const rs = document.getElementById('regularStart');
        const re = document.getElementById('regularEnd');
        const es = document.getElementById('eveningStart');
        const ee = document.getElementById('eveningEnd');
        if (!rs || !re || !es || !ee) return;
        rs.value = bookingTimes.regularStart || '';
        re.value = bookingTimes.regularEnd || '';
        es.value = bookingTimes.eveningStart || '';
        ee.value = bookingTimes.eveningEnd || '';
        const cs = document.getElementById('cbStart');
        const ce = document.getElementById('cbEnd');
        if (cs) cs.value = bookingTimes.cbStart || '08:00';
        if (ce) ce.value = bookingTimes.cbEnd   || '23:35';
      } catch (e) { console.error('populateTimeSettingsInputs 오류', e); }
    }

    // Firebase 리스너
    function setupFirebaseListeners(){
      try {
        onValue(ref(database,'bookings'), (snap) => {
          bookings = snap.val() || {};
          archivePastBookingsOnLoad().catch(()=>{});
          if (selectedDate) safeRender(renderClassrooms);
          if (isAdminLoggedIn) safeRender(renderTodayBookings);
        });
        onValue(ref(database,'archivedBookings'), (snap) => { archivedBookings = snap.val() || {}; });
        onValue(ref(database,'classrooms'), (snap) => {
          const v = snap.val();
          if (v && Array.isArray(v) && v.length>0) { classrooms = v; safeRender(renderCalendar); if (selectedDate) safeRender(renderClassrooms); populateNoteClassroomSelect(); refreshAdminClassroomList(); }
        });
        onValue(ref(database,'allowedDates'), (snap) => { const d=snap.val(); if (d) allowedDates = new Set(Array.isArray(d)?d:Object.values(d)); else allowedDates=new Set(); safeRender(renderCalendar); });
        onValue(ref(database,'adminPassword'), (snap) => { if (snap.val()) adminPassword = snap.val(); });
        onValue(ref(database,'bookingTimes'), (snap) => {
          const bt = snap.val();
          if (bt) { bookingTimes = bt; window.bookingTimes = bookingTimes; populateTimeSettingsInputs(); safeRender(renderCalendar); if (selectedDate) safeRender(renderClassrooms); }
        });
        onValue(ref(database,'scheduleNotes'), (snap) => {
          const sn = snap.val();
          if (sn) { scheduleNotes = sn; if (selectedDate) safeRender(renderClassrooms); renderScheduleNotesList(); }
        });
        onValue(ref(database,'weeklyAvailability'), (snap) => {
          const wa = snap.val();
          if (wa) { weeklyAvailability = wa; safeRender(renderCalendar); if (selectedDate) safeRender(renderClassrooms); renderAvailabilityGrid(); }
        });
        onValue(ref(database,'baseWeeklyAvailability'), (snap) => {
          const v = snap.val();
          if (v) { baseWeeklyAvailability = v; }
          else { baseWeeklyAvailability = weeklyAvailability; } // 정기세팅 없으면 기존설정 사용
          renderAvailabilityGrid();
          if (selectedDate) safeRender(renderClassrooms);
        });
        onValue(ref(database,'tempAvailability'), (snap) => {
          const v = snap.val() || {};
          const today = getDateKey(new Date());
          // 지난 날짜 자동 제거
          const cleaned = {};
          Object.keys(v).forEach(d => { if (d >= today) cleaned[d] = v[d]; });
          tempAvailability = cleaned;
          if (Object.keys(v).length !== Object.keys(cleaned).length) {
            saveToFirebase('tempAvailability', cleaned).catch(()=>{});
          }
          renderAvailabilityGrid();
          if (selectedDate) safeRender(renderClassrooms);
        });
        onValue(ref(database,'rosterMonWed'), (snap) => {
          const r = snap.val();
          rosterMonWed = (r && Array.isArray(r)) ? r : [];
          if (isAdminLoggedIn) safeRender(renderAttendancePanel);
          // 미인증 상태일 때만 갱신 (입력 중 방해 안 함)
          if (activeUserTab === 'chromebook' && !cbAuthVerified) renderUserChromebookPanel();
        });
        onValue(ref(database,'rosterTueThu'), (snap) => {
          const r = snap.val();
          rosterTueThu = (r && Array.isArray(r)) ? r : [];
          if (isAdminLoggedIn) safeRender(renderAttendancePanel);
          if (activeUserTab === 'chromebook' && !cbAuthVerified) renderUserChromebookPanel();
        });
        onValue(ref(database,'attendanceChecks'), (snap) => {
          attendanceChecks = snap.val() || {};
          if (isAdminLoggedIn) safeRender(renderAttendancePanel);
        });
        onValue(ref(database,'chromebookBookings'), (snap) => {
          chromebookBookings = snap.val() || {};
          if (isAdminLoggedIn) {
            safeRender(renderChromebookStatusView);
            // 관리자가 크롬북 패널 입력칸에 포커스 중이면 재렌더 건너뜀 (입력 중 삭제 방지)
            const active = document.activeElement;
            const isEditingCbPanel = active && document.getElementById('chromebookStudentTable')?.contains(active);
            if (!isEditingCbPanel) safeRender(renderChromebookPanel);
          }
          // 인증 완료 상태면 현황 표시만 조용히 업데이트
          if (activeUserTab === 'chromebook') {
            if (cbAuthVerified) updateCbStatusOnly();
            else renderUserChromebookPanel();
          }
        });
        onValue(ref(database,'chromebookReturnPeriod'), (snap) => {
          chromebookReturnPeriod = snap.val() || {};
          if (isAdminLoggedIn) {
            const active = document.activeElement;
            const isEditingCbPanel = active && document.getElementById('chromebookStudentTable')?.contains(active);
            if (!isEditingCbPanel) safeRender(renderChromebookPanel);
            safeRender(renderChromebookStatusView);
          }
          // 반납기간은 중요 — 인증 전에만 갱신
          if (activeUserTab === 'chromebook' && !cbAuthVerified) renderUserChromebookPanel();
        });
        onValue(ref(database,'chromebookReturnPeriodArchive'), (snap) => {
          chromebookReturnPeriodArchive = snap.val() || {};
        });
        onValue(ref(database,'chromebookBookings/_pw'), (snap) => {
          chromebookPasswords = snap.val() || {};
          if (isAdminLoggedIn) {
            const active = document.activeElement;
            const isEditingCbPanel = active && document.getElementById('chromebookStudentTable')?.contains(active);
            if (!isEditingCbPanel) safeRender(renderChromebookPanel);
          }
        });
        onValue(ref(database,'thursdayRule'), (snap) => {
          console.log('[THU] onValue 수신:', JSON.stringify(snap.val()));
          thursdayRuleDates = parseThuRuleData(snap.val());
          console.log('[THU] onValue 후 thursdayRuleDates:', [...thursdayRuleDates]);
          thursdayRuleDay   = getEffectiveThuRuleDay();
          renderAvailabilityGrid();
          if (selectedDate) safeRender(renderClassrooms);
        });
        onValue(ref(database,'activeTodayTab'), (snap) => {
          const todayKey = getDateKey(new Date());
          const val = snap.val();
          const tab = (val && val[todayKey]) || '';
          if (tab && tab !== activeTodayTab) {
            activeTodayTab = tab;
            activeRosterTab = tab;
            if (isAdminLoggedIn) {
              safeRender(renderAttendancePanel);
              safeRender(renderTodayBookings);
            }
          }
        });
      } catch(e){ console.error('setupFirebaseListeners 오류', e); }
    }

    async function loadFromFirebase(){
      try{
        const snap = await get(ref(database,'/'));
        const data = snap.val() || {};
        if (data.bookings) bookings = data.bookings;
        if (data.archivedBookings) archivedBookings = data.archivedBookings;
        if (data.classrooms && Array.isArray(data.classrooms) && data.classrooms.length>0) classrooms = data.classrooms;
        if (data.gradeRoomsSeeded) gradeRoomsSeeded = true;
        if (data.allowedDates) allowedDates = new Set(Array.isArray(data.allowedDates)?data.allowedDates:Object.values(data.allowedDates));
        if (data.adminPassword) adminPassword = data.adminPassword;
        if (data.bookingTimes) { bookingTimes = data.bookingTimes; window.bookingTimes = bookingTimes; populateTimeSettingsInputs(); }
        if (data.scheduleNotes) scheduleNotes = data.scheduleNotes;
        if (data.weeklyAvailability) weeklyAvailability = data.weeklyAvailability;
      if (data.baseWeeklyAvailability) baseWeeklyAvailability = data.baseWeeklyAvailability;
      else baseWeeklyAvailability = weeklyAvailability;
      if (data.tempAvailability) {
        const today = getDateKey(new Date());
        const cleaned = {};
        Object.keys(data.tempAvailability).forEach(d => { if (d >= today) cleaned[d] = data.tempAvailability[d]; });
        tempAvailability = cleaned;
      }
      if (data.thursdayRule) {
        thursdayRuleDates = parseThuRuleData(data.thursdayRule);
        thursdayRuleDay   = getEffectiveThuRuleDay();
      }
        if (data.rosterMonWed && Array.isArray(data.rosterMonWed)) rosterMonWed = data.rosterMonWed;
        if (data.rosterTueThu && Array.isArray(data.rosterTueThu)) rosterTueThu = data.rosterTueThu;
        if (data.attendanceChecks) attendanceChecks = data.attendanceChecks;
        if (data.chromebookBookings) chromebookBookings = data.chromebookBookings;
      }catch(e){ console.error('loadFromFirebase 오류', e); }
    }

    async function saveToFirebase(path, value){
      try{
        await set(ref(database, path), value);
      }catch(e){ console.error(`saveToFirebase ${path} 오류`, e); throw e; }
    }

    async function archivePastBookingsOnLoad(){
      try{
        const today = new Date(); today.setHours(0,0,0,0);
        const todayKey = getDateKey(today);
        const current = {...bookings};
        const archive = {...archivedBookings};
        let updated = false;
        Object.keys(current).forEach(k=>{
          const parts = k.split('-');
          if(parts.length<4) return;
          const dateKey = parts.slice(0,3).join('-');
          if(dateKey < todayKey){
            if(!archive[dateKey]) archive[dateKey] = {};
            archive[dateKey][k] = current[k];
            delete current[k];
            updated = true;
          }
        });
        if(updated){
          await saveToFirebase('bookings', current);
          await saveToFirebase('archivedBookings', archive);
          bookings = current;
          archivedBookings = archive;
        }
      }catch(e){ console.error('archivePastBookingsOnLoad 오류:', e); }
    }

    // 특정 날짜의 유효 설정 반환: 임시설정 > 정기설정 순
    function getEffectiveAvailability(dow, dateKey) {
      if (tempAvailability[dateKey] && Object.keys(tempAvailability[dateKey]).length > 0) {
        return tempAvailability[dateKey];
      }
      return baseWeeklyAvailability[dow] || weeklyAvailability[dow] || {};
    }

    // 예약 가능 판정
    function canAttemptBookingFor(date, classroom, timeSlot){
      try {
        if (!date) return false;
        if (!(date instanceof Date)) date = new Date(date);
        const dateKey = getDateKey(date);
        const todayKey = getDateKey(new Date());
        const dow = getDayOfWeek(date);
        if (dateKey !== todayKey) return false;

        // ── 목요일 특수 슬롯은 관리자 설정보다 우선 허용 ──────────────
        const effectiveDay = getEffectiveThuRuleDay();
        const isThuRuleDay = (dow === effectiveDay);
        const isThuSpecialSlot =
          (classroom === '도서관' && (timeSlot === '저녁1교시' || timeSlot === '저녁2교시')) ||
          (classroom === '강당'   &&  timeSlot === '저녁2교시');
        if (isThuRuleDay && isThuSpecialSlot && isWithinBookingTime(timeSlot)) return true;

        const effectiveAvail = getEffectiveAvailability(dow, dateKey);
        // 학년 교실(2026-10-19): 관리자가 그 날짜의 그리드를 "한 번도" 저장하지 않은 경우
        // (hasAdminSetting=false) 아래 일반 로직은 "설정 없으면 목요일엔 자동 허용"으로 빠지므로,
        // 학년 교실은 그 일반 로직에 들어가기 전에 반드시 명시적 허용 여부만으로 판정한다.
        // → 관리자가 체크하지 않으면 어떤 경우에도 열리지 않음(자동으로 열리지 않음).
        if (CLASSROOM_GRADE[classroom]) {
          return !!(effectiveAvail && effectiveAvail[classroom] && effectiveAvail[classroom][timeSlot]);
        }
        const availabilityForDay = effectiveAvail;
        const hasAdminSetting = availabilityForDay && Object.keys(availabilityForDay).length > 0;

        // 관리자 설정이 있으면 해당 설정을 우선 적용 (모든 요일 공통)
        if (hasAdminSetting) {
          if (availabilityForDay[classroom] && typeof availabilityForDay[classroom][timeSlot] !== 'undefined') {
            return !!availabilityForDay[classroom][timeSlot];
          }
          return false;
        }

        // 관리자 설정이 없는 경우
        if (!isWithinBookingTime(timeSlot)) return false;
        return dow === effectiveDay;
      } catch(e){
        console.error('canAttemptBookingFor 오류:', e);
        return false;
      }
    }

    // 교무부장 요청(2026-10-19): 관리자가 "요일별 신청 허용"을 켜두지 않은 강의실은
    // 메인화면/신청현황에 표시하지 않는다. canAttemptBookingFor는 "오늘만" 유효하므로
    // 날짜 선택(달력 미리보기) 화면에서도 쓸 수 있도록 요일 기준으로 별도 판정한다.
    function isRoomAllowedOnDate(date, room){
      try {
        if (!date) return true;
        if (!(date instanceof Date)) date = new Date(date);
        const dateKey = getDateKey(date);
        const dow = getDayOfWeek(date);
        const effectiveDay = getEffectiveThuRuleDay();
        const isThuRuleDay = (dow === effectiveDay);
        // 도서관/강당의 목요일 특수슬롯은 관리자 설정과 무관하게 항상 노출(기존 규칙 유지)
        if (isThuRuleDay && (room === '도서관' || room === '강당')) return true;
        const availabilityForDay = getEffectiveAvailability(dow, dateKey);
        // 학년 교실은 "관리자 설정이 전혀 없으면 숨기지 않는다" 예외를 적용하지 않는다 —
        // 그 날짜에 체크된 적이 없으면 무조건 표시하지 않음(자동으로 열리지 않아야 함).
        if (CLASSROOM_GRADE[room]) {
          return !!(availabilityForDay[room] && timeSlots.some(ts => !!availabilityForDay[room][ts]));
        }
        const hasAdminSetting = availabilityForDay && Object.keys(availabilityForDay).length > 0;
        if (!hasAdminSetting) return true; // 관리자 설정 자체가 없으면 숨기지 않음(기존 동작 유지)
        const perRoom = availabilityForDay[room];
        if (!perRoom) return false; // 설정은 있는데 이 강의실에 대한 허용 항목이 전혀 없음
        return timeSlots.some(ts => !!perRoom[ts]);
      } catch(e){
        console.error('isRoomAllowedOnDate 오류:', e);
        return true; // 오류 시에는 안전하게 숨기지 않음
      }
    }

    function roomHasBookingOn(dateKey, room){
      try {
        return timeSlots.some(ts => {
          const key = `${dateKey}-${room}-${ts}`;
          let arr = bookings[key] || [];
          if (!Array.isArray(arr)) arr = Object.values(arr||{});
          return arr.filter(b=>b&&b.name).length > 0;
        });
      } catch(e){ return false; }
    }

    // 해당 날짜에 "표시할" 강의실 목록: 그날 신청 허용된 강의실 + 이미 신청 내역이 있는 강의실(예외)
    function getVisibleRoomsFor(date){
      if (!Array.isArray(classrooms)) return [];
      const dateKey = getDateKey(date);
      return classrooms.filter(room => isRoomAllowedOnDate(date, room) || roomHasBookingOn(dateKey, room));
    }

    function allowBookingFor(userName, date, room, timeslot){
      try {
        if (!userName) return { allowed:false, reason:'이름 필요' };
        if (!date || !room || !timeslot) return { allowed:false, reason:'잘못된 파라미터' };
        if (!(date instanceof Date)) date = new Date(date);
        if (typeof canAttemptBookingFor === 'function'){
          if (!canAttemptBookingFor(date, room, timeslot)) return { allowed:false, reason:'신청 불가(시간/날짜 또는 관리자 설정)' };
        }
        // 학년 교실(2026-10-19): 같은 학년 학생만 신청 가능(7학년은 7-1/7-2 중 아무 쪽이나,
        // 8학년은 8-1/8-2 중 아무 쪽이나).
        if (CLASSROOM_GRADE[room] && gradeOfUserName(userName) !== CLASSROOM_GRADE[room]) {
          return { allowed:false, reason:`${CLASSROOM_GRADE[room]}학년 전용 교실(다른 학년 신청 불가)` };
        }
        const dateKey = getDateKey(date);
        const dow = getDayOfWeek(date);
        const allBooked = [];
        Object.keys(bookings || {}).forEach(k=>{
          if (!k.startsWith(dateKey)) return;
          const parts = k.split('-');
          const keyTime = parts[parts.length - 1] || '';
          // 날짜는 YYYY-MM-DD 형식이므로 첫 3개 부분 제외
          const roomParts = parts.slice(3, parts.length - 1);
          const keyRoom = roomParts.join('-') || '';
          let list = bookings[k] || [];
          if (!Array.isArray(list)) list = Array.isArray(Object.values(list)) ? Object.values(list).filter(b=>b && b.name) : [];
          else list = list.filter(b=>b && b.name);
          list.forEach(b=>{ if (b && b.name) allBooked.push({ room: keyRoom, slot: keyTime, name: b.name }); });
        });
        const myBookings = allBooked.filter(b => b.name === userName);
        if (myBookings.some(b => b.slot === timeslot)) return { allowed:false, reason:'동일 시간대 이미 신청됨' };

        // ── 목요일 특수 허용 규칙 ────────────────────────────────────────
        // 대상 슬롯: 도서관 저녁1교시 / 도서관 저녁2교시 / 강당 저녁2교시
        //         + (2026-10-19 추가) 학년 교실 5개의 저녁1·2교시 — 단, 이쪽은 도서관·강당과
        //           달리 관리자가 "요일별 신청 허용"에서 체크해야만 특수 슬롯으로 계산된다
        //           (canAttemptBookingFor가 이미 그 체크를 통과해야만 여기까지 온다).
        // 이 슬롯들은 목요일(또는 관리자가 지정한 적용 요일)에만 적용되는 별도 규칙을 따름
        const isThursday    = (dow === getEffectiveThuRuleDay()); // 관리자 설정 요일
        const isLibEvening1 = (room === '도서관' && timeslot === '저녁1교시');
        const isLibEvening2 = (room === '도서관' && timeslot === '저녁2교시');
        const isHallEvening2= (room === '강당'   && timeslot === '저녁2교시');
        const isNewRoomSpecial = isNewThuClassroomSlot(room, timeslot);

        if (isThursday && (isLibEvening1 || isLibEvening2 || isHallEvening2 || isNewRoomSpecial)) {

          // 내 기존 예약 현황
          const myLib1  = myBookings.some(b => b.room === '도서관' && b.slot === '저녁1교시');
          const myLib2  = myBookings.some(b => b.room === '도서관' && b.slot === '저녁2교시');
          const myHall2 = myBookings.some(b => b.room === '강당'   && b.slot === '저녁2교시');

          // 규칙 1: 도서관 저녁2 ↔ 강당 저녁2 상호배타
          if (isLibEvening2 && myHall2) return { allowed:false, reason:'강당 저녁2교시와 도서관 저녁2교시는 중복 신청 불가' };
          if (isHallEvening2 && myLib2) return { allowed:false, reason:'도서관 저녁2교시와 강당 저녁2교시는 중복 신청 불가' };

          // 규칙 2: 목요일 특수 슬롯은 서로 간의 조합 허용 여부 판단
          // 현재 신청하려는 슬롯이 이미 내 예약에 있는 슬롯과 어떤 관계인지 확인
          // 허용되는 추가 조합:
          //   - 기존: 없음            → 도서관 저녁1 or 도서관 저녁2 or 강당 저녁2 (첫 신청 가능)
          //   - 기존: 도서관 저녁1    → 도서관 저녁2 or 강당 저녁2 추가 가능
          //   - 기존: 도서관 저녁2    → 도서관 저녁1 추가 가능  (강당 저녁2는 상호배타로 위에서 이미 차단)
          //   - 기존: 강당 저녁2      → 도서관 저녁1 or 도서관 저녁2 추가 가능
          //   - 기존: 9교시 or 10교시 → 도서관 저녁1, 도서관 저녁2, 강당 저녁2 추가 가능
          //   - 기존: 저녁1교시(일반) → 도서관 저녁2 or 강당 저녁2 추가 가능
          //
          // 불허 조건: 목요일 특수 슬롯이 아닌 일반 슬롯(9/10교시 제외)이 이미 2건 이상이거나
          //           목요일 특수 슬롯 포함 총 3건 이상이 되는 경우
          //
          // 핵심: 목요일 특수 3슬롯(도서관저녁1, 도서관저녁2, 강당저녁2)은 서로 추가 허용.
          //       단, 도서관저녁2 + 강당저녁2 동시 보유는 불가(위에서 차단).
          //       일반 슬롯(9/10교시, 저녁1교시 일반강의실)이 있어도 목요일 특수슬롯 추가 허용.

          // ── 허용 건수 계산 ──────────────────────────────────────────
          // 목요일 특수슬롯: 도서관저녁1 / 도서관저녁2 / 강당저녁2
          // 일반슬롯: 9교시, 10교시, 저녁1교시(일반강의실)
          //
          // 허용 조합 (최대 3건까지 가능):
          //   일반 0건 + 특수 1건: O  (예: 도서관저녁1만)
          //   일반 0건 + 특수 2건: O  (예: 도서관저녁1 + 도서관저녁2)
          //   일반 1건 + 특수 0건: O  (기본 1건 규칙)
          //   일반 1건 + 특수 1건: O  (예: 9교시 + 도서관저녁1)
          //   일반 1건 + 특수 2건: O  (예: 9교시 + 도서관저녁1 + 도서관저녁2)
          //   일반 2건 이상:       X  (일반슬롯 자체가 하루 1건 제한)
          //   특수 3건 이상:       X  (도서관저녁2↔강당저녁2 상호배타로 물리적 불가)
          const myThursdaySpecial = myBookings.filter(b =>
            (b.room === '도서관' && b.slot === '저녁1교시') ||
            (b.room === '도서관' && b.slot === '저녁2교시') ||
            (b.room === '강당'   && b.slot === '저녁2교시') ||
            isNewThuClassroomSlot(b.room, b.slot)
          );
          const myNormalBookings = myBookings.filter(b => !myThursdaySpecial.includes(b));

          // 일반슬롯은 하루 1건 초과 불가
          if (myNormalBookings.length >= 1 && myThursdaySpecial.length >= 2) {
            return { allowed:false, reason:'목요일 특수허용 한도 초과 (일반 1건 + 특수 최대 2건)' };
          }
          // 특수슬롯만으로 2건 이상이면 추가 불가 (도서관저녁2↔강당저녁2 상호배타로 최대 2건)
          if (myThursdaySpecial.length >= 2) {
            return { allowed:false, reason:'목요일 특수슬롯 최대 2건 초과' };
          }

          // 위 조건을 모두 통과하면 허용
          return { allowed:true, reason:'' };
        }
        // ────────────────────────────────────────────────────────────────

        // 동아리/밴드 활동 확인
        let hasClubActivity = false;
        for (let booking of myBookings) {
          const noteKey = `${dow}-${booking.room}-${booking.slot}`;
          const note = scheduleNotes[noteKey] || '';
          if (note.includes('동아리') || note.includes('밴드') || note.includes('찬양팀')) {
            hasClubActivity = true;
            break;
          }
        }

        // 목요일 일반슬롯 신청 시: 기존 예약 중 특수슬롯(도서관저녁1·저녁2, 강당저녁2)은
        // 카운트에서 제외하여 일반슬롯 1건 추가를 허용
        let countableBookings = myBookings;
        if (isThursday) {
          countableBookings = myBookings.filter(b => !(
            (b.room === '도서관' && b.slot === '저녁1교시') ||
            (b.room === '도서관' && b.slot === '저녁2교시') ||
            (b.room === '강당'   && b.slot === '저녁2교시') ||
            isNewThuClassroomSlot(b.room, b.slot)
          ));
        }

        // 동아리/밴드 활동이 있으면 최대 2개, 없으면 1개만
        const maxBookings = hasClubActivity ? 2 : 1;

        if (countableBookings.length >= maxBookings) {
          if (hasClubActivity) {
            return { allowed:false, reason:`동아리/밴드/찬양팀 활동 중이지만 이미 ${maxBookings}개 신청됨` };
          } else {
            return { allowed:false, reason:`이미 ${countableBookings[0].room} ${countableBookings[0].slot} 신청됨(하루 1건)` };
          }
        }

        return { allowed:true, reason:'' };
      } catch(e){
        console.error('allowBookingFor 오류:', e);
        return { allowed:false, reason:'서버 오류' };
      }
    }

    window.canAttemptBookingFor = canAttemptBookingFor;
    window.allowBookingFor = allowBookingFor;

    // ── 이름 표시 변환: roster에서 학년+이름 매칭 → '학년-반-번호 이름' 형식 ──
    function displayName(rawName) {
      try {
        const normStr = s => (s || '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF\s]/g, '');
        const m = normStr(rawName).match(/^(\d+)([가-힣]+)([A-Z]?)$/);
        if (!m) return rawName;
        const grade  = m[1];
        const name   = m[2];
        const suffix = m[3];
        const nameWithSuffix = name + suffix; // 예: "이소은A"

        const allRosters = [...rosterMonWed, ...rosterTueThu];

        // 1차: grade + (name+suffix) 일치 → roster가 "이소은A" 형태인 경우
        let found = allRosters.find(s =>
          normStr(String(s.grade)) === grade &&
          normStr(s.name) === normStr(nameWithSuffix)
        );
        // 2차: grade + name 일치 → roster가 "이소은" 형태인 경우
        if (!found) {
          found = allRosters.find(s =>
            normStr(String(s.grade)) === grade &&
            normStr(s.name) === normStr(name)
          );
        }
        // 3차: name+suffix만으로 일치 (grade 차이 대비)
        if (!found) found = allRosters.find(s => normStr(s.name) === normStr(nameWithSuffix));
        // 4차: name만으로 일치
        if (!found) found = allRosters.find(s => normStr(s.name) === normStr(name));

        if (!found) return rawName;

        const cls = (found.class  !== undefined && found.class  !== '') ? found.class  : '?';
        const num = (found.number !== undefined && found.number !== '') ? found.number : '?';
        // roster name에 suffix 포함 여부에 따라 표시 이름 결정
        return `${grade}-${cls}-${num} ${found.name}`;
      } catch(e) { return rawName; }
    }

    // ── 인원체크: Firebase attendanceChecks 구조 ──────────────────────
    // attendanceChecks / {dateKey} / {grade}_{name}_e1 = true/false (저녁1교시)
    // attendanceChecks / {dateKey} / {grade}_{name}_e2 = true/false (저녁2교시)
    let attendanceChecks = {}; // 로컬 캐시

    function getAttendanceKey(s, slot){ return `${s.grade}_${s.name}_${slot}`; }

    // 오늘 요일 기준 기본 탭 결정 (Firebase activeTodayTab 우선)
    function getDefaultTab(){
      if (activeTodayTab) return activeTodayTab;
      const dow = getDayOfWeek(new Date());
      return (dow === '화' || dow === '목') ? 'tuethu' : 'monwed';
    }

    // 현재 활성 탭의 명단 반환
    function getActiveRoster(){
      return activeRosterTab === 'tuethu' ? rosterTueThu : rosterMonWed;
    }

    // 탭 전환 — Firebase에 오늘의 활성 탭 저장 (양방향 동기화)
    window.switchRosterTab = async function(tab){
      activeRosterTab = tab;
      activeTodayTab  = tab;
      const todayKey = getDateKey(new Date());
      await saveToFirebase(`activeTodayTab/${todayKey}`, tab);
      safeRender(renderAttendancePanel);
      if (isAdminLoggedIn) safeRender(renderTodayBookings);
    };

    // 탭 버튼 스타일 업데이트
    function updateTabStyles(){
      const monwedBtn = document.getElementById('tabMonWed');
      const tuethuBtn = document.getElementById('tabTueThu');
      if (!monwedBtn || !tuethuBtn) return;
      const active   = 'px-4 py-2 rounded-lg text-sm font-medium border transition-all bg-purple-600 text-white border-purple-600';
      const inactive = 'px-4 py-2 rounded-lg text-sm font-medium border transition-all bg-white text-gray-600 border-gray-300 hover:border-purple-400';
      monwedBtn.className = activeRosterTab === 'monwed' ? active : inactive;
      tuethuBtn.className = activeRosterTab === 'tuethu' ? active : inactive;
      const label = document.getElementById('attendanceDayLabel');
      if (label){
        const dow = getDayOfWeek(new Date());
        const isToday = (activeRosterTab === 'tuethu' && (dow==='화'||dow==='목')) ||
                        (activeRosterTab === 'monwed' && (dow==='월'||dow==='수'));
        label.textContent = isToday ? '📅 오늘 요일 명단' : '';
      }
    }

    // 오늘 체크 상태 가져오기 — {e1: Set, e2: Set} 반환 (탭별 분리)
    function getTodayCheckedSets(){
      const todayKey = getDateKey(new Date());
      const curTab   = activeTodayTab || activeRosterTab || getDefaultTab();
      const tabKey   = `${todayKey}_${curTab}`;
      const e1 = new Set(), e2 = new Set();
      // bookings 체크 → 교시에 맞게 매핑
      Object.keys(bookings || {}).forEach(k => {
        if (!k.startsWith(todayKey)) return;
        const isE1slot = k.endsWith('-저녁1교시');
        const isE2slot = k.endsWith('-저녁2교시');
        if (!isE1slot && !isE2slot) return;
        let list = bookings[k] || [];
        if (!Array.isArray(list)) list = Object.values(list).filter(b=>b&&b.name);
        else list = list.filter(b=>b&&b.name);
        list.forEach(b => {
          if (b.checked){
            if (isE1slot) e1.add(b.name);
            if (isE2slot) e2.add(b.name);
          }
        });
      });
      // attendanceChecks: 탭별 키 사용
      const todayAC = (attendanceChecks && attendanceChecks[tabKey]) || {};
      Object.keys(todayAC).forEach(key => {
        if (!todayAC[key]) return;
        const slotMatch = key.match(/^(.+)_(e1|e2)$/);
        if (!slotMatch) return;
        const gradeNameParts = slotMatch[1].split('_');
        const appName = `${gradeNameParts[0]}${gradeNameParts.slice(1).join('_')}`;
        if (slotMatch[2] === 'e1') e1.add(appName);
        else e2.add(appName);
      });
      return { e1, e2 };
    }
    // 하위 호환: 어느 교시든 체크된 이름 Set
    function getTodayCheckedNames(){
      const { e1, e2 } = getTodayCheckedSets();
      return new Set([...e1, ...e2]);
    }

    // 인원체크 탭에서 직접 체크 토글 — slot: 'e1'|'e2', 탭별 분리 저장
    window.toggleAttendanceCheck = async function(grade, name, slot, isChecked){
      try {
        const todayKey = getDateKey(new Date());
        const curTab   = activeTodayTab || activeRosterTab || getDefaultTab();
        const tabKey   = `${todayKey}_${curTab}`;
        const acKey    = `${grade}_${name}_${slot}`;
        const appName  = `${grade}${name}`;
        if (!attendanceChecks[tabKey]) attendanceChecks[tabKey] = {};
        attendanceChecks[tabKey][acKey] = isChecked;
        await saveToFirebase(`attendanceChecks/${tabKey}/${acKey}`, isChecked);
        // bookings 동기화: 해당 교시 슬롯의 booking만 checked 업데이트
        const slotName = slot === 'e1' ? '저녁1교시' : '저녁2교시';
        const { e1, e2 } = getTodayCheckedSets();
        const bookingRef = ref(database, 'bookings');
        await runTransaction(bookingRef, (current) => {
          if (!current) return current;
          Object.keys(current).forEach(k => {
            if (!k.startsWith(todayKey)) return;
            if (!k.endsWith(`-${slotName}`)) return; // 해당 교시만
            let list = current[k];
            if (!Array.isArray(list)) list = Object.values(list).filter(b=>b&&b.name);
            list.forEach((b, i) => { if (b && b.name === appName) list[i].checked = isChecked; });
            current[k] = list;
          });
          return current;
        });
        safeRender(renderAttendancePanel);
        if (isAdminLoggedIn) safeRender(renderTodayBookings);
      } catch(e){ console.error('toggleAttendanceCheck 오류', e); }
    };

    function renderAttendancePanel(){
      try {
        if (!activeRosterTab) activeRosterTab = getDefaultTab();
        updateTabStyles();

        const listEl    = document.getElementById('attendanceList');
        const summaryEl = document.getElementById('attendanceSummary');
        if (!listEl || !summaryEl) return;

        const roster = getActiveRoster();

        if (!roster || roster.length === 0){
          const tabLabel = activeRosterTab === 'monwed' ? '월·수' : '화·목';
          listEl.innerHTML = `<div class="text-sm text-gray-400 text-center py-6">${tabLabel} 명단이 없습니다. 엑셀 파일을 업로드해주세요.</div>`;
          summaryEl.classList.add('hidden');
          return;
        }

        const todayKey = getDateKey(new Date());
        const curTab   = activeTodayTab || activeRosterTab || getDefaultTab();
        const tabKey   = `${todayKey}_${curTab}`;
        const { e1: checkedE1, e2: checkedE2 } = getTodayCheckedSets();

        // 반별 색상 설정
        const CLASS_CONFIG = [
          { grade:'6', cls:'',  label:'6학년',
            hBg:'bg-yellow-400', hTxt:'text-yellow-900',
            cBg:'bg-yellow-50',  border:'border-yellow-300',
            btnE1on:'bg-amber-500 text-white', btnE1off:'bg-yellow-100 text-yellow-600 border border-yellow-300',
            btnE2on:'bg-amber-600 text-white',  btnE2off:'bg-yellow-50 text-yellow-500 border border-yellow-200' },
          { grade:'7', cls:'1', label:'7-1반',
            hBg:'bg-purple-500', hTxt:'text-white',
            cBg:'bg-purple-50',  border:'border-purple-300',
            btnE1on:'bg-blue-500 text-white', btnE1off:'bg-purple-100 text-purple-600 border border-purple-300',
            btnE2on:'bg-green-500 text-white', btnE2off:'bg-purple-50 text-purple-500 border border-purple-200' },
          { grade:'7', cls:'2', label:'7-2반',
            hBg:'bg-green-500',  hTxt:'text-white',
            cBg:'bg-green-50',   border:'border-green-300',
            btnE1on:'bg-blue-500 text-white', btnE1off:'bg-green-100 text-green-600 border border-green-300',
            btnE2on:'bg-emerald-500 text-white', btnE2off:'bg-green-50 text-green-500 border border-green-200' },
          { grade:'8', cls:'1', label:'8-1반',
            hBg:'bg-blue-500',   hTxt:'text-white',
            cBg:'bg-blue-50',    border:'border-blue-300',
            btnE1on:'bg-blue-600 text-white', btnE1off:'bg-blue-100 text-blue-600 border border-blue-300',
            btnE2on:'bg-green-500 text-white', btnE2off:'bg-blue-50 text-blue-500 border border-blue-200' },
          { grade:'8', cls:'2', label:'8-2반',
            hBg:'bg-lime-500',   hTxt:'text-white',
            cBg:'bg-lime-50',    border:'border-lime-300',
            btnE1on:'bg-blue-500 text-white', btnE1off:'bg-lime-100 text-lime-700 border border-lime-300',
            btnE2on:'bg-green-500 text-white', btnE2off:'bg-lime-50 text-lime-600 border border-lime-200' },
        ];

        // 전체 요약
        const total      = roster.length;
        const checkedE1n = roster.filter(s => checkedE1.has(`${s.grade}${s.name}`)).length;
        const checkedE2n = roster.filter(s => checkedE2.has(`${s.grade}${s.name}`)).length;
        const checkedAny = roster.filter(s => checkedE1.has(`${s.grade}${s.name}`) || checkedE2.has(`${s.grade}${s.name}`)).length;

        summaryEl.classList.remove('hidden');
        summaryEl.innerHTML = `
          <div class="bg-white border border-purple-200 rounded p-3 text-center">
            <div class="text-2xl font-bold text-purple-700">${total}</div>
            <div class="text-xs text-gray-500 mt-1">전체 인원</div>
          </div>
          <div class="bg-white border border-blue-200 rounded p-3 text-center">
            <div class="text-2xl font-bold text-blue-600">${checkedE1n}</div>
            <div class="text-xs text-gray-500 mt-1">저녁1 체크</div>
          </div>
          <div class="bg-white border border-green-200 rounded p-3 text-center">
            <div class="text-2xl font-bold text-green-600">${checkedE2n}</div>
            <div class="text-xs text-gray-500 mt-1">저녁2 체크</div>
          </div>
          <div class="bg-white border border-gray-200 rounded p-3 text-center">
            <div class="text-2xl font-bold text-gray-700">${total > 0 ? Math.round(checkedAny/total*100) : 0}%</div>
            <div class="text-xs text-gray-500 mt-1">참여율</div>
          </div>`;

        // 5열 그리드 (아이패드 등 768~1024px 폭에서는 5열이 너무 좁아지므로 중간 단계로 3열 사용)
        listEl.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 items-start';

        CLASS_CONFIG.forEach(cfg => {
          const students = roster.filter(s => {
            const sg = String(s.grade);
            const sc = String(s.class || '');
            if (cfg.cls === '') return sg === cfg.grade;
            return sg === cfg.grade && sc === cfg.cls;
          }).sort((a,b) => Number(a.number)-Number(b.number));

          const col = document.createElement('div');
          col.className = `border ${cfg.border} rounded-lg overflow-hidden`;

          // 컬럼 헤더
          const gE1 = students.filter(s => checkedE1.has(`${s.grade}${s.name}`)).length;
          const gE2 = students.filter(s => checkedE2.has(`${s.grade}${s.name}`)).length;
          const hdr = document.createElement('div');
          hdr.className = `${cfg.hBg} ${cfg.hTxt} px-3 py-2`;
          hdr.innerHTML = `<div class="font-bold text-sm text-center">${cfg.label}</div>
            <div class="flex justify-center gap-3 text-xs mt-1 opacity-90">
              <span>저녁1 ${gE1}/${students.length}</span>
              <span>저녁2 ${gE2}/${students.length}</span>
            </div>`;
          col.appendChild(hdr);

          // 미체크 명단 - 컬럼 상단에 표시
          const uncE1 = students.filter(s => !checkedE1.has(`${s.grade}${s.name}`));
          const uncE2 = students.filter(s => !checkedE2.has(`${s.grade}${s.name}`));
          const uncSection = document.createElement('div');
          uncSection.className = `px-2 pt-2 pb-1 border-b ${cfg.border} ${cfg.cBg}`;
          uncSection.innerHTML = `
            <div class="text-xs text-blue-600 font-bold mb-0.5">저녁1 미체크 ${uncE1.length === 0 ? '✅ 전원' : `(${uncE1.length}명): <span class="font-normal">${uncE1.map(s=>s.name).join(', ')}</span>`}</div>
            <div class="text-xs text-green-600 font-bold">저녁2 미체크 ${uncE2.length === 0 ? '✅ 전원' : `(${uncE2.length}명): <span class="font-normal">${uncE2.map(s=>s.name).join(', ')}</span>`}</div>`;
          col.appendChild(uncSection);

          // 학생 목록
          const body = document.createElement('div');
          body.className = 'p-2 space-y-1';

          students.forEach(s => {
            const appName = `${s.grade}${s.name}`;
            const isE1 = checkedE1.has(appName);
            const isE2 = checkedE2.has(appName);

            const item = document.createElement('div');
            item.className = `flex items-center gap-1.5 px-2 py-1.5 rounded-lg border transition-all ${cfg.cBg} ${cfg.border}`;

            const nameSpan = document.createElement('span');
            nameSpan.className = 'flex-1 text-xs min-w-0';
            nameSpan.innerHTML = `<span class="block text-gray-400 leading-tight" data-original-style="0">${s.grade}-${s.class||'?'}-${s.number}</span><span class="block font-medium whitespace-nowrap leading-tight">${s.name}</span>`;
            item.appendChild(nameSpan);

            const btnE1 = document.createElement('button');
            btnE1.className = `min-w-[48px] py-1.5 px-2 rounded-lg text-xs font-bold transition-all active:scale-95 ${isE1 ? cfg.btnE1on : cfg.btnE1off}`;
            btnE1.textContent = isE1 ? '✓저녁1' : '저녁1';
            btnE1.addEventListener('click', () => window.toggleAttendanceCheck(s.grade, s.name, 'e1', !isE1));
            item.appendChild(btnE1);

            const btnE2 = document.createElement('button');
            btnE2.className = `min-w-[48px] py-1.5 px-2 rounded-lg text-xs font-bold transition-all active:scale-95 ${isE2 ? cfg.btnE2on : cfg.btnE2off}`;
            btnE2.textContent = isE2 ? '✓저녁2' : '저녁2';
            btnE2.addEventListener('click', () => window.toggleAttendanceCheck(s.grade, s.name, 'e2', !isE2));
            item.appendChild(btnE2);

            body.appendChild(item);
          });

          col.appendChild(body);
          grid.appendChild(col);
        });

        listEl.appendChild(grid);
      } catch(e){ console.error('renderAttendancePanel 오류', e); }
    }
    // ──────────────────────────────────────────────────────────────────

    // 렌더 함수들
    function renderCalendar(){
      try {
        normalizeCurrentDate();
        const calendarEl = document.getElementById('calendar');
        const titleEl = document.getElementById('calendarTitle');
        titleEl.textContent = `${currentDate.getFullYear()}년 ${currentDate.getMonth()+1}월`;
        calendarEl.innerHTML = '';
        ['일','월','화','수','목','금','토'].forEach(d=>{ const dayEl=document.createElement('div'); dayEl.className='text-center font-bold p-2 bg-gray-100'; dayEl.textContent=d; calendarEl.appendChild(dayEl); });
        const firstDay = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).getDay();
        const lastDate = new Date(currentDate.getFullYear(), currentDate.getMonth()+1, 0).getDate();
        for (let i=0;i<firstDay;i++){ const empty=document.createElement('div'); empty.className='p-2'; calendarEl.appendChild(empty); }
        for (let date=1; date<=lastDate; date++){
          const dateObj = new Date(currentDate.getFullYear(), currentDate.getMonth(), date);
          const dateKey = getDateKey(dateObj);
          const isSpecialDate = allowedDates.has(dateKey);
          let isValid = false;
          const dayIdx = dateObj.getDay();
          const dayName = getDayOfWeek(dateObj);
          const availForDay = getEffectiveAvailability(dayName, getDateKey(selectedDate));
          if (getDateKey(dateObj) === getDateKey(new Date())) isValid = true;
          else if (isSpecialDate) isValid = true;
          else if (availForDay && Object.keys(availForDay).length > 0){
            const anyAllowed = Object.keys(availForDay).some(room => {
              const roomMap = availForDay[room] || {};
              return timeSlots.some(ts => !!roomMap[ts]);
            });
            if (anyAllowed) isValid = true;
          } else if (dayIdx === 4) isValid = true; // 목요일만 기본 허용
          const isToday = getDateKey(dateObj) === getDateKey(new Date());
          const isSelected = selectedDate && getDateKey(dateObj) === getDateKey(selectedDate);
          const btn = document.createElement('button');
          btn.textContent = date;
          btn.disabled = !isValid;
          let className = 'p-2 text-center rounded flex items-center justify-center ';
          if (isSelected) className += 'bg-blue-500 text-white ';
          else if (isToday) className += 'bg-blue-100 font-bold ';
          else if (isSpecialDate) className += 'bg-purple-100 text-purple-700 ';
          else if (isValid) className += 'bg-white hover:bg-blue-100 cursor-pointer ';
          else className += 'text-gray-400 cursor-not-allowed ';
          btn.className = className;
          if (isValid) btn.addEventListener('click', ()=>{ selectedDate = new Date(dateObj); renderCalendar(); safeRender(renderClassrooms); });
          // 청소 당번표 패널은 예약 가능 여부(isValid)와 무관하게 모든 날짜에서 동작해야 하므로
          // 별도의 클릭 리스너를 추가한다. (읽기 전용, cleaning_duty_3.html의 데이터를 그대로 보여줌)
          btn.addEventListener('click', ()=>{ if (window.__showCleaningForDate) window.__showCleaningForDate(dateObj); });
          calendarEl.appendChild(btn);
        }
        // 달력 줄 수(월마다 5~6주)가 바뀔 때마다 청소 당번 패널의 높이를 달력에 맞춘다.
        if (window.__syncCleaningPanelHeight) window.__syncCleaningPanelHeight();
      } catch(e){ console.error('renderCalendar 오류', e); }
    }

    function renderClassrooms(){
      try {
        if (!Array.isArray(classrooms) || classrooms.length===0) classrooms = ["강당","세미나실","미술실","별관1","별관2","밴드실","요리실","컴퓨터실","음악실","도서관"];
        const section = document.getElementById('classroomSection'); const list = document.getElementById('classroomDisplayList');
        if (!list || !section) return;
        if (!selectedDate){ section.classList.add('hidden'); return; }
        section.classList.remove('hidden');
        const dateKey = getDateKey(selectedDate); const dayOfWeek = getDayOfWeek(selectedDate);
        document.getElementById('selectedDateTitle').textContent = `${dateKey} 강의실 현황`;
        const userName = (document.getElementById('userName') && document.getElementById('userName').value) ? document.getElementById('userName').value.trim() : '';
        list.innerHTML = '';
        let bookedSlots = [];
        if (userName){
          for (let room of classrooms){
            for (let slot of timeSlots){
              const ck = `${dateKey}-${room}-${slot}`;
              let arr = bookings[ck] || [];
              if (!Array.isArray(arr)) arr = Array.isArray(Object.values(arr)) ? Object.values(arr).filter(b=>b&&b.name) : [];
              else arr = arr.filter(b=>b&&b.name);
              if (arr.some(b=>b.name===userName)) bookedSlots.push({slot, room});
            }
          }
        }
        getVisibleRoomsFor(selectedDate).forEach(classroom=>{
          const card = document.createElement('div'); card.className='bg-white border rounded-lg p-6 shadow';
          let html = `<h3 class="text-lg font-bold mb-4 text-violet-700">${classroom}</h3><div class="space-y-3">`;
          timeSlots.forEach(timeSlot=>{
            const key = `${dateKey}-${classroom}-${timeSlot}`;
            let bookingList = bookings[key] || [];
            if (!Array.isArray(bookingList)) bookingList = Object.values(bookingList||{}).filter(b=>b&&b.name); else bookingList = bookingList.filter(b=>b&&b.name);
            const isBooked = bookingList.some(b=>b.name===userName);
            const count = bookingList.length;
            const note = scheduleNotes[`${dayOfWeek}-${classroom}-${timeSlot}`] || '';
            const withinTime = isWithinBookingTime(timeSlot);
            const res = (typeof allowBookingFor === 'function') ? allowBookingFor(userName || '', selectedDate, classroom, timeSlot) : { allowed:false, reason:'서버 미연결' };
            const canBookGlobal = !!(res && res.allowed);
            let reason = res && res.reason ? res.reason : '';
            let allowButton = false;
            if (withinTime && canBookGlobal && !bookedSlots.some(b=>b.slot===timeSlot)) allowButton = true;
            if (!withinTime) reason = reason || '예약 가능 시간이 아님';
            html += `<div class="border-b pb-3"><div class="flex justify-between items-center mb-2"><span class="font-medium">${timeSlot}</span><span class="text-sm bg-gray-100 px-2 py-1 rounded">${count}명</span></div>`;
            if (note) html += `<div class="mb-2 text-sm bg-pink-50 text-pink-700 px-3 py-2 rounded border border-pink-200">📌 ${note}</div>`;
            if (!isBooked && allowButton){
              html += `<button data-action-click="${encodeAction("bookClassroom",[classroom,timeSlot])}" class="px-3 py-1 bg-blue-500 text-white text-sm rounded ml-2">신청</button>`;
            } else {
              const title = isBooked ? '이미 신청됨' : (reason || '신청 불가');
              html += `<button disabled class="px-3 py-1 bg-gray-300 text-gray-500 text-sm rounded ml-2" title="${title}">${title}</button>`;
            }
            if (count>0){
              html += `<div class="mt-2 space-y-1">`;
              // 관리자 로그인 시 이름 오름차순 정렬 (원본 인덱스 보존)
              const displayList2 = isAdminLoggedIn
                ? bookingList.map((b,i)=>({...b,_origIdx:i})).sort((a,b)=>(a.name||'').localeCompare(b.name||'','ko'))
                : bookingList.map((b,i)=>({...b,_origIdx:i}));
              displayList2.forEach((b)=>{ const idx = b._origIdx;
                const time = new Date(b.timestamp).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
                const checkboxHtml = isAdminLoggedIn ? `<input type="checkbox" ${b.checked ? 'checked' : ''} data-action-change="${encodeAction("toggleCheckbox",[getDateKey(selectedDate),classroom,timeSlot,idx,'__control_checked__'])}" class="w-4 h-4 cursor-pointer mr-2">` : '';
                html += `<div class="text-sm bg-blue-50 p-2 rounded flex justify-between items-center">
                          <div class="flex items-center">
                            ${checkboxHtml}
                            <span class="font-medium">${displayName(b.name)}</span>
                            <span class="text-gray-500 text-xs ml-2">${time}</span>
                          </div>
                          <div><button data-action-click="${encodeAction("attemptDeleteBooking",[getDateKey(selectedDate),classroom,timeSlot, idx])}" class="px-2 py-1 bg-red-500 text-white text-xs rounded hover:bg-red-600">삭제</button></div>
                        </div>`;
              });
              html += `</div>`;
            }
            html += `</div>`;
          });
          html += `</div>`;
          card.innerHTML = html;
          list.appendChild(card);
        });
      } catch(e){ console.error('renderClassrooms 오류', e); }
    }

    function updateTodayTabStyles(){
      const mw = document.getElementById('todayTabMonWed');
      const tt = document.getElementById('todayTabTueThu');
      if (!mw || !tt) return;
      const active   = 'px-3 py-1 rounded text-sm font-medium border transition-all bg-purple-600 text-white border-purple-600';
      const inactive = 'px-3 py-1 rounded text-sm font-medium border transition-all bg-white text-gray-600 border-gray-300 hover:border-purple-400';
      const cur = activeTodayTab || activeRosterTab || getDefaultTab();
      mw.className = cur === 'monwed' ? active : inactive;
      tt.className = cur === 'tuethu' ? active : inactive;
    }

    // ══ 학생 자기체크 모드 (강당·저녁2교시 고정) ════════════════════════
    window.toggleSelfCheckMode = function() {
      selfCheckMode = !selfCheckMode;
      const btn       = document.getElementById('selfCheckModeBtn');
      const banner    = document.getElementById('selfCheckBanner');
      const adminList = document.getElementById('todayBookingsList');
      const selfList  = document.getElementById('selfCheckList');
      if (selfCheckMode) {
        btn.textContent = '⛔ 자기체크 모드 OFF';
        btn.className   = 'px-4 py-2 bg-red-600 text-white text-sm font-bold rounded-lg hover:bg-red-700';
        banner.classList.remove('hidden');
        adminList.classList.add('hidden');
        selfList.classList.remove('hidden');
      } else {
        btn.textContent = '🙋 자기체크 모드 ON';
        btn.className   = 'px-4 py-2 bg-emerald-600 text-white text-sm font-bold rounded-lg hover:bg-emerald-700';
        banner.classList.add('hidden');
        adminList.classList.remove('hidden');
        selfList.classList.add('hidden');
      }
      safeRender(renderTodayBookings);
    };

    function renderSelfCheckList() {
      const selfList = document.getElementById('selfCheckList');
      if (!selfList) return;
      selfList.innerHTML = '';

      const ROOM = '강당', SLOT = '저녁2교시';
      const todayKey = getDateKey(new Date());
      const key = `${todayKey}-${ROOM}-${SLOT}`;
      let list = bookings[key] || [];
      if (!Array.isArray(list)) list = Object.values(list).filter(b=>b&&b.name);
      else list = list.filter(b=>b&&b.name);

      if (list.length === 0) {
        selfList.innerHTML = '<div class="text-center text-gray-400 py-16 text-lg">강당 저녁2교시 신청자가 없습니다</div>';
        return;
      }

      // 학년→반→번호 정렬 + roster 매핑
      const normStr = s => (s||'').normalize('NFC').replace(/[​-‍﻿\s]/g,'');
      const allRosters = [...rosterMonWed, ...rosterTueThu];

      const sorted = list.map((b, idx) => {
        const m = (b.name||'').match(/^(\d+)([가-힣]+)([A-Z]?)$/);
        let g=999, c=999, n=999, foundStudent=null;
        if (m) {
          const nameWithSuffix = m[2] + m[3];
          foundStudent = allRosters.find(s =>
            normStr(String(s.grade))===m[1] && (normStr(s.name)===normStr(nameWithSuffix) || normStr(s.name)===normStr(m[2]))
          );
          if (foundStudent) { g=parseInt(m[1])||999; c=parseInt(foundStudent.class)||999; n=parseInt(foundStudent.number)||999; }
          else { g=parseInt(m[1])||999; }
        }
        return {...b, _origIdx: idx, _g: g, _c: c, _n: n};
      }).sort((a,b) => a._g-b._g || a._c-b._c || a._n-b._n);

      const checkedCount = sorted.filter(b => b.checked).length;

      // 요약 바
      const summary = document.createElement('div');
      summary.className = 'mb-4 p-3 bg-gray-50 border rounded-lg flex justify-between items-center';
      summary.innerHTML = `
        <span class="text-sm text-gray-600">강당 저녁2교시 신청: <b>${sorted.length}명</b></span>
        <span class="text-sm font-bold text-emerald-600">✅ 체크: ${checkedCount}명 &nbsp; ⬜ 미체크: ${sorted.length - checkedCount}명</span>`;
      selfList.appendChild(summary);

      // 반별 그룹 정의 (순서 고정)
      const groups = [
        { label: '6학년',  key: '6_0',  match: b => b._g===6,                   color: { header:'bg-yellow-400',  checked:'bg-yellow-400',  unchecked:'border-yellow-300 hover:bg-yellow-50',  text:'text-yellow-700' } },
        { label: '7-1반',  key: '7_1',  match: b => b._g===7 && b._c===1,        color: { header:'bg-purple-500',  checked:'bg-purple-500',  unchecked:'border-purple-300 hover:bg-purple-50',  text:'text-purple-700' } },
        { label: '7-2반',  key: '7_2',  match: b => b._g===7 && b._c===2,        color: { header:'bg-green-500',   checked:'bg-green-500',   unchecked:'border-green-300 hover:bg-green-50',    text:'text-green-700' } },
        { label: '8-1반',  key: '8_1',  match: b => b._g===8 && b._c===1,        color: { header:'bg-blue-500',    checked:'bg-blue-500',    unchecked:'border-blue-300 hover:bg-blue-50',      text:'text-blue-700' } },
        { label: '8-2반',  key: '8_2',  match: b => b._g===8 && b._c===2,        color: { header:'bg-lime-500',    checked:'bg-lime-500',    unchecked:'border-lime-300 hover:bg-lime-50',      text:'text-lime-700' } },
        { label: '기타',   key: '999',  match: b => b._g===999,                  color: { header:'bg-gray-500',   checked:'bg-gray-500',   unchecked:'border-gray-300 hover:bg-gray-50',   text:'text-gray-700' } },
      ];

      // 5열 레이아웃 (기타는 신청자 있을 때만)
      const activeGroups = groups.filter(g => g.key === '999'
        ? sorted.some(b => g.match(b))
        : true
      );
      const colCount = activeGroups.filter(g => g.key !== '999').length;

      const wrapper = document.createElement('div');
      wrapper.classList.add("grid", "gap-3", "items-start"); wrapper.style.gridTemplateColumns = `repeat(${colCount},1fr)`;

      activeGroups.forEach(group => {
        if (group.key === '999' && !sorted.some(group.match)) return;

        const members = sorted.filter(group.match);
        const col = document.createElement('div');

        // 반 헤더
        const header = document.createElement('div');
        const grpChecked = members.filter(b=>b.checked).length;
        header.className = `${group.color.header} text-white text-center font-bold py-2 rounded-t-xl text-sm`;
        header.textContent = `${group.label}  ${grpChecked}/${members.length}`;
        col.appendChild(header);

        // 학생 버튼들
        const btnWrap = document.createElement('div');
        btnWrap.className = 'flex flex-col gap-2 p-2 bg-white border border-t-0 rounded-b-xl';

        if (members.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'text-center text-gray-300 text-xs py-4';
          empty.textContent = '신청자 없음';
          btnWrap.appendChild(empty);
        } else {
          members.forEach(b => {
            const idx = b._origIdx;
            const isChecked = b.checked || false;
            const name = displayName(b.name);

            const btn = document.createElement('button');
            btn.className = [
              'w-full py-3 px-2 rounded-lg text-sm font-bold transition-all active:scale-95 select-none border-2',
              isChecked
                ? `${group.color.checked} text-white border-transparent`
                : `bg-white ${group.color.text} ${group.color.unchecked}`
            ].join(' ');
            btn.textContent = isChecked ? `✅ ${name}` : name;

            btn.addEventListener('click', async () => {
              const newChecked = !(b.checked || false);
              if (newChecked) {
                try {
                  const ac = new AudioContext();
                  const osc = ac.createOscillator(), gain = ac.createGain();
                  osc.connect(gain); gain.connect(ac.destination);
                  osc.frequency.value = 880; gain.gain.value = 0.15;
                  osc.start(); osc.stop(ac.currentTime + 0.1);
                } catch(e) {}
              }
              await window.toggleCheckbox(todayKey, ROOM, SLOT, idx, newChecked);
              safeRender(renderTodayBookings);
            });

            btnWrap.appendChild(btn);
          });
        }

        col.appendChild(btnWrap);
        wrapper.appendChild(col);
      });

      selfList.appendChild(wrapper);
    }
    // ════════════════════════════════════════════════════════════════

    function renderTodayBookings(){
      try{
        const container = document.getElementById('todayBookingsList');
        const panel = document.getElementById('todayBookingsPanel');
        if (!container || !panel) return;
        if (panel.classList.contains('hidden')) return;
        updateTodayTabStyles();
        container.innerHTML = '';
        if (selfCheckMode) { renderSelfCheckList(); return; }

        const todayKey = getDateKey(new Date());
        const dow = getDayOfWeek(new Date());
        const visibleRoomsToday = getVisibleRoomsFor(new Date());

        timeSlots.forEach(timeSlot => {
          const timeCard = document.createElement('div');
          timeCard.className = 'bg-white border rounded-lg p-4';

          let totalCount = 0;
          const roomData = {};
          visibleRoomsToday.forEach(classroom => {
            const key = `${todayKey}-${classroom}-${timeSlot}`;
            let bookingList = bookings[key] || [];
            if (!Array.isArray(bookingList)) bookingList = Object.values(bookingList).filter(b=>b&&b.name);
            else bookingList = bookingList.filter(b=>b&&b.name);
            roomData[classroom] = bookingList;
            totalCount += bookingList.length;
          });

          // 관리자가 이 교시를 수동으로 건드린 적이 없으면 매 렌더마다 현재 시각 기준으로
          // 접힘/펼침 기본값을 다시 계산한다(패널을 켜둔 채로 시간이 지나도 자동 전환됨).
          if (!todayBookingsManualTouch.has(timeSlot)) {
            todayBookingsCollapsed[timeSlot] = getTodayBookingsTimeDefault(timeSlot);
          }
          const isCollapsed = !!todayBookingsCollapsed[timeSlot];

          const headerEl = document.createElement('div');
          headerEl.className = 'flex justify-between items-center mb-3 cursor-pointer select-none';
          headerEl.innerHTML = `<h4 class="font-bold text-lg text-blue-700 flex items-center gap-1.5">
                                   <span class="text-sm text-gray-400">${isCollapsed ? '▶' : '▼'}</span>${timeSlot}
                                 </h4>
                                 <span class="text-sm bg-gray-100 px-2 py-1 rounded">${totalCount}명</span>`;
          headerEl.addEventListener('click', () => window.toggleTodayBookingsSlot(timeSlot));
          timeCard.appendChild(headerEl);

          const bodyWrap = document.createElement('div');
          if (isCollapsed) bodyWrap.classList.add('hidden');

          let renderedRoomCount = 0;
          visibleRoomsToday.forEach(classroom => {
            const list = roomData[classroom] || [];
            // 2026-10-22 요청: 관리자모드 "오늘의 신청현황"에서는 신청자가 없는 강의실은
            // (허용 여부와 무관하게) 보여주지 않는다. 학생용 메인화면은 그대로 유지.
            if (list.length === 0) return;
            renderedRoomCount++;
            const note = scheduleNotes[`${dow}-${classroom}-${timeSlot}`] || '';
            const roomSection = document.createElement('div');
            roomSection.className = 'mb-3 pb-3 border-b last:border-b-0';

            const roomHeader = document.createElement('div');
            roomHeader.className = 'flex justify-between items-center mb-2';
            roomHeader.innerHTML = `<div class="font-medium">${classroom}</div><div class="text-xs bg-gray-100 px-2 py-1 rounded">${list.length}명</div>`;
            roomSection.appendChild(roomHeader);

            if (note) {
              const noteEl = document.createElement('div');
              noteEl.className = 'mb-2 text-xs bg-pink-50 text-pink-700 px-2 py-1 rounded';
              noteEl.textContent = `📌 ${note}`;
              roomSection.appendChild(noteEl);
            }

            if (list.length > 0) {
              const listWrap = document.createElement('div');
              listWrap.className = 'space-y-1';
              // 관리자 모드: 학년→반→번호 숫자 오름차순 정렬 (roster 매칭 기준, 없으면 원본 이름 뒤로)
              const sortedList = list.map((b, idx) => {
                const m = (b.name||'').match(/^(\d+)([가-힣]+)([A-Z]?)$/);
                let grade=999, cls=999, num=999;
                if (m) {
                  const allRosters = [...rosterMonWed, ...rosterTueThu];
                  const found = allRosters.find(s => String(s.grade)===m[1] && s.name===m[2]);
                  if (found) { grade=parseInt(m[1])||999; cls=parseInt(found.class)||999; num=parseInt(found.number)||999; }
                  else { grade=parseInt(m[1])||999; }
                }
                return {...b, _origIdx: idx, _g: grade, _c: cls, _n: num};
              }).sort((a,b) => {
                if (!!a.checked !== !!b.checked) return a.checked ? 1 : -1;
                return a._g-b._g || a._c-b._c || a._n-b._n;
              });
              sortedList.forEach((b) => {
              const idx = b._origIdx;
                const time = b.timestamp ? new Date(b.timestamp).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}) : '';
                const row = document.createElement('div');
                row.className = 'bg-gray-50 p-2 rounded flex justify-between items-center';
                
                // 체크박스와 이름/시간 영역
                const leftSection = document.createElement('div');
                leftSection.className = 'flex items-center gap-2 flex-1 min-w-0';
                
                // 체크박스
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = b.checked || false;
                checkbox.className = 'w-4 h-4 cursor-pointer flex-shrink-0';
                checkbox.addEventListener('change', () => {
                  window.toggleCheckbox(todayKey, classroom, timeSlot, idx, checkbox.checked);
                });
                
                // 크롬북 사용목적 조회
                let cbPurpose = '';
                if (timeSlot === '9교시' || timeSlot === '10교시') {
                  const m = (b.name||'').match(/^(\d+)([가-힣]+)([A-Z]?)$/);
                  if (m) {
                    const allRosters2 = [...rosterMonWed, ...rosterTueThu];
                    const found2 = allRosters2.find(s => String(s.grade)===m[1] && (s.name===m[2]||s.name===m[2]+m[3]));
                    if (found2) {
                      // 2026-10-28: 6학년은 roster의 class 필드가 비어있지 않을 수 있어(오타 등) 그대로 쓰면
                      // 안 됨 — getCbStudentClass가 6학년을 항상 '0'으로 고정하므로 반드시 이걸 거쳐야
                      // 실제 저장된 크롬북 데이터의 classKey/sid와 일치한다(기존엔 이 정규화를 안 거쳐서
                      // 6학년 학생만 조회가 안 되는 버그가 있었음).
                      const classKey2 = getCbClassKey(String(found2.grade), getCbStudentClass(found2));
                      const sid2 = getCbStudentSid(found2);
                      const cbData2 = chromebookBookings[todayKey] && chromebookBookings[todayKey][classKey2] && chromebookBookings[todayKey][classKey2][sid2];
                      if (cbData2) {
                        cbPurpose = timeSlot==='9교시' ? (cbData2.purpose9||'') : (cbData2.purpose10||'');
                      }
                    }
                  }
                }

                const nameTimeDiv = document.createElement('div');
                nameTimeDiv.className = 'text-sm flex flex-col min-w-0';
                nameTimeDiv.innerHTML = `<div class="flex items-center gap-1"><span class="font-medium whitespace-nowrap">${displayName(b.name)}</span><span class="text-gray-500 text-xs whitespace-nowrap">${time}</span></div>${cbPurpose ? `<span class="text-xs text-cyan-600 mt-0.5">💻 ${cbPurpose}</span>` : ''}`;
                
                leftSection.appendChild(checkbox);
                leftSection.appendChild(nameTimeDiv);
                row.appendChild(leftSection);
                
                const delBtn = document.createElement('button');
                delBtn.className = 'px-2 py-1 bg-red-500 text-white text-xs rounded hover:bg-red-600 flex-shrink-0';
                delBtn.textContent = '삭제';
                delBtn.addEventListener('click', () => {
                  window.attemptDeleteBooking(todayKey, classroom, timeSlot, idx);
                });
                row.appendChild(delBtn);
                listWrap.appendChild(row);
              });
              roomSection.appendChild(listWrap);
            }

            bodyWrap.appendChild(roomSection);
          });

          if (renderedRoomCount === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'text-sm text-gray-400 text-center py-3';
            emptyEl.textContent = '오늘 신청자가 없습니다';
            bodyWrap.appendChild(emptyEl);
          }

          timeCard.appendChild(bodyWrap);
          container.appendChild(timeCard);
        });

      } catch(e){ console.error('renderTodayBookings 오류', e); }
    }

    // ══ 금일 현황 서브탭 전환 ════════════════════════════════════════
    window.switchTodaySubTab = function(tab) {
      activeTodaySubTab = tab;
      const classroomPanel = document.getElementById('todaySubPanelClassroom');
      const chromebookPanel2 = document.getElementById('todaySubPanelChromebook');
      const btnC = document.getElementById('todaySubTabClassroom');
      const btnCb = document.getElementById('todaySubTabChromebook');
      const activeClass = 'px-4 py-2 text-sm font-bold rounded-t-lg bg-blue-600 text-white';
      const inactiveClass = 'px-4 py-2 text-sm font-bold rounded-t-lg bg-white text-gray-600 border border-gray-300';
      if (tab === 'classroom') {
        classroomPanel.classList.remove('hidden');
        chromebookPanel2.classList.add('hidden');
        btnC.className = activeClass;
        btnCb.className = inactiveClass;
        safeRender(renderTodayBookings);
      } else {
        classroomPanel.classList.add('hidden');
        chromebookPanel2.classList.remove('hidden');
        btnC.className = inactiveClass;
        btnCb.className = 'px-4 py-2 text-sm font-bold rounded-t-lg bg-cyan-600 text-white';
        safeRender(renderChromebookStatusView);
      }
    };

    // ══ 학생별 크롬북 반납기간 저장/삭제 ════════════════════════════
    window.saveCbReturn = async function(classKey, sid) {
      // 2026-11-05: 데스크탑/모바일 입력칸 둘 다 확인(둘 중 값이 있는 쪽 — 중복 id 버그 수정과 짝).
      const input = document.getElementById(`cbReturn_${sid}`) || document.getElementById(`cbReturn_${sid}_m`);
      if (!input) return;
      const text = input.value.trim();
      if (!chromebookReturnPeriod[classKey]) chromebookReturnPeriod[classKey] = {};
      if (text) {
        chromebookReturnPeriod[classKey][sid] = text;
        await saveToFirebase(`chromebookReturnPeriod/${classKey}/${sid}`, text);
        // 이력 보관 (삭제해도 기록 유지)
        await saveToFirebase(`chromebookReturnPeriodArchive/${classKey}/${sid}`, text);
      } else {
        delete chromebookReturnPeriod[classKey][sid];
        await saveToFirebase(`chromebookReturnPeriod/${classKey}/${sid}`, null);
      }
      safeRender(renderChromebookStatusView);
    };

    window.deleteCbReturn = async function(classKey, sid) {
      // 삭제 전 이력 보관
      const period = chromebookReturnPeriod[classKey]?.[sid];
      if (period) await saveToFirebase(`chromebookReturnPeriodArchive/${classKey}/${sid}`, period);
      if (chromebookReturnPeriod[classKey]) delete chromebookReturnPeriod[classKey][sid];
      await saveToFirebase(`chromebookReturnPeriod/${classKey}/${sid}`, null);
      safeRender(renderChromebookPanel);
      safeRender(renderChromebookStatusView);
    };

    // 크롬북 학생 비밀번호 초기화 (관리자)
    window.resetCbPassword = async function(sid) {
      const hasPw = !!chromebookPasswords[sid];
      const msg = hasPw
        ? '이 학생의 비밀번호를 0000으로 초기화하시겠습니까?'
        : '이 학생의 비밀번호를 0000으로 설정하시겠습니까?';
      if (!confirm(msg)) return;
      await saveCbPassword(sid, '0000');
      safeRender(renderChromebookPanel);
      alert('비밀번호가 0000으로 설정되었습니다.');
    };

    // ══ 크롬북 신청 패널 함수들 ═══════════════════════════════════════
    const CB_CLASSES = [
      { label: '6학년',  grade: '6', cls: '0' },
      { label: '7-1반',  grade: '7', cls: '1' },
      { label: '7-2반',  grade: '7', cls: '2' },
      { label: '8-1반',  grade: '8', cls: '1' },
      { label: '8-2반',  grade: '8', cls: '2' },
    ];

    function getCbClassKey(grade, cls) { return cls === '0' ? grade : `${grade}-${cls}`; }
    // 6학년은 roster의 class 필드값(빈칸/오타 등)과 무관하게 항상 '0'으로 고정 — 학생/관리자 sid 불일치 방지
    function getCbStudentClass(s) { return String(s.grade) === '6' ? '0' : String(s.class || '0'); }
    function getCbStudentSid(s) { return `${s.grade}_${getCbStudentClass(s)}_${s.number}`; }

    function getCbClassStudents(grade, cls) {
      const all = [...rosterMonWed, ...rosterTueThu];
      const seen = new Set();
      const result = [];
      all.forEach(s => {
        const sGrade = String(s.grade);
        const sCls = getCbStudentClass(s); // 6학년은 항상 '0'으로 정규화
        const key = `${sGrade}_${sCls}_${s.number}_${s.name}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (grade === '6') { if (sGrade === '6') result.push(s); }
        else { if (sGrade === grade && sCls === cls) result.push(s); }
      });
      return result.sort((a,b) => Number(a.number) - Number(b.number));
    }

    function renderChromebookPanel() {
      const label = document.getElementById('chromebookTodayLabel');
      if (label) {
        const today = new Date();
        label.textContent = `📅 ${getDateKey(today)} (${getDayOfWeek(today)}요일)`;
      }
      // 반 버튼 스타일 초기화
      CB_CLASSES.forEach(c => {
        const btn = document.getElementById(`cbClassBtn_${c.grade}_${c.cls}`);
        if (!btn) return;
        const isActive = activeChromebookClass && activeChromebookClass.grade === c.grade && activeChromebookClass.cls === c.cls;
        btn.className = isActive
          ? 'px-4 py-2 text-sm font-bold rounded-lg border-2 border-cyan-600 bg-cyan-600 text-white'
          : 'px-4 py-2 text-sm font-bold rounded-lg border-2 border-cyan-300 text-cyan-700 bg-white hover:bg-cyan-50';
      });
      if (!activeChromebookClass) {
        document.getElementById('chromebookStudentList').classList.add('hidden');
        document.getElementById('chromebookStudentEmpty').classList.add('hidden');
        return;
      }
      const students = getCbClassStudents(activeChromebookClass.grade, activeChromebookClass.cls);
      if (students.length === 0) {
        document.getElementById('chromebookStudentList').classList.add('hidden');
        document.getElementById('chromebookStudentEmpty').classList.remove('hidden');
        return;
      }
      document.getElementById('chromebookStudentEmpty').classList.add('hidden');
      document.getElementById('chromebookStudentList').classList.remove('hidden');
      document.getElementById('chromebookSaveMsg').classList.add('hidden');

      const todayKey = getDateKey(new Date());
      const classKey = getCbClassKey(activeChromebookClass.grade, activeChromebookClass.cls);
      const saved = (chromebookBookings[todayKey] && chromebookBookings[todayKey][classKey]) || {};

      const table = document.getElementById('chromebookStudentTable');
      table.innerHTML = '';

      // 테이블 헤더
      // 헤더 (데스크탑에서만 표시)
      const headerRow = document.createElement('div');
      headerRow.className = 'hidden md:grid gap-3 mb-2 px-3 py-2 bg-cyan-100 rounded-lg text-sm font-bold text-cyan-800';
      headerRow.style.gridTemplateColumns = '1fr 1fr 1fr 1fr';
      headerRow.innerHTML = '<div>이름</div><div>반납기간</div><div>9교시 사용목적</div><div>10교시 사용목적</div>';
      table.appendChild(headerRow);

      students.forEach(s => {
        const sid = getCbStudentSid(s);
        const classKey = getCbClassKey(activeChromebookClass.grade, activeChromebookClass.cls);
        const data = saved[sid] || { purpose9: '', purpose10: '' };
        const returnVal = (chromebookReturnPeriod[classKey] && chromebookReturnPeriod[classKey][sid]) || '';

        // ── 데스크탑: 4열 그리드 ──────────────────────────────────
        const desktopRow = document.createElement('div');
        desktopRow.className = 'hidden md:grid gap-3 items-center px-3 py-2 border border-cyan-100 rounded-lg mb-1';
        desktopRow.style.gridTemplateColumns = '1fr 1fr 1fr 1fr';
        if (returnVal) desktopRow.classList.add('bg-orange-50'); else desktopRow.classList.add('bg-white');

        // ── 모바일: 카드 ──────────────────────────────────────────
        const mobileCard = document.createElement('div');
        mobileCard.className = `md:hidden border rounded-lg mb-2 p-3 ${returnVal ? 'bg-orange-50 border-orange-200' : 'bg-white border-cyan-100'}`;

        // 공통 요소 생성 함수
        const makeNameDiv = () => {
          const d = document.createElement('div');
          d.className = 'text-sm';
          const hasPw = !!chromebookPasswords[sid];
          d.innerHTML = `<span class="text-gray-400 text-xs">${s.grade}-${s.class||'?'}-${s.number}&nbsp;</span><span class="font-medium">${s.name}</span>`
            + ` <button data-action-click="${encodeAction("resetCbPassword",[sid])}" title="${hasPw ? '비밀번호 초기화' : '비밀번호 설정'}"
                class="ml-1 px-1.5 py-0.5 text-xs whitespace-nowrap ${hasPw ? 'bg-gray-100 text-gray-400 hover:bg-red-50 hover:text-red-500' : 'bg-cyan-50 text-cyan-400 hover:bg-cyan-100 hover:text-cyan-600'} rounded">
                🔑 ${hasPw ? '초기화' : '설정'}</button>`;
          return d;
        };

        const makeReturnWrap = (idSuffix='') => {
          const wrap = document.createElement('div');
          wrap.className = 'flex items-center gap-1';
          const inp = document.createElement('input');
          inp.type = 'text';
          // 2026-11-05 버그수정: 데스크탑 행과 모바일 카드가 각각 별도로 makeReturnWrap()을
          // 호출하는데, 둘 다 id가 `cbReturn_${sid}`로 똑같아서(중복 id) 모바일(아이폰 등)에서
          // 입력해도 getElementById가 항상 먼저 나오는 "숨겨진 데스크탑 입력칸"을 찾아가 버려
          // 빈 값으로 저장/삭제되던 문제가 있었음. 9/10교시 사용목적 입력칸처럼 idSuffix로
          // 구분하고, 입력 시 서로 값을 동기화한다.
          inp.id = `cbReturn_${sid}${idSuffix}`;
          inp.value = returnVal;
          inp.placeholder = '예: 5/28-6/10(용도외 사용)';
          inp.className = `flex-1 min-w-0 px-2 py-1 border rounded text-xs focus:outline-none focus:border-orange-400 ${returnVal ? 'border-orange-400 bg-orange-50 text-orange-700 font-bold' : 'border-gray-200'}`;
          inp.addEventListener('input', () => {
            const other = document.getElementById(`cbReturn_${sid}${idSuffix===''?'_m':''}`);
            if (other) other.value = inp.value;
          });
          const saveBtn = document.createElement('button');
          saveBtn.textContent = '✓';
          saveBtn.title = '반납기간 저장';
          saveBtn.className = 'px-2 py-1 bg-orange-400 text-white text-xs rounded hover:bg-orange-500 flex-shrink-0';
          saveBtn.onclick = () => window.saveCbReturn(classKey, sid);
          wrap.appendChild(inp);
          wrap.appendChild(saveBtn);
          if (returnVal) {
            const delBtn = document.createElement('button');
            delBtn.textContent = '✕';
            delBtn.title = '반납기간 삭제';
            delBtn.className = 'px-2 py-1 bg-gray-200 text-gray-500 text-xs rounded hover:bg-red-100 hover:text-red-600 flex-shrink-0';
            delBtn.onclick = () => window.deleteCbReturn(classKey, sid);
            wrap.appendChild(delBtn);
          }
          return wrap;
        };

        const makeP9 = (idSuffix='') => {
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.id = `cb_purpose9_${sid}${idSuffix}`;
          inp.value = data.purpose9 || '';
          inp.placeholder = '9교시 사용목적';
          inp.className = 'w-full px-2 py-1 border border-gray-200 rounded text-sm focus:border-orange-400 focus:outline-none';
          if (returnVal) { inp.disabled = true; inp.className += ' bg-gray-100 text-gray-400'; }
          inp.addEventListener('input', () => {
            const other = document.getElementById(`cb_purpose9_${sid}${idSuffix===''?'_m':''}`);
            if (other) other.value = inp.value;
          });
          return inp;
        };

        const makeP10 = (idSuffix='') => {
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.id = `cb_purpose10_${sid}${idSuffix}`;
          inp.value = data.purpose10 || '';
          inp.placeholder = '10교시 사용목적';
          inp.className = 'w-full px-2 py-1 border border-gray-200 rounded text-sm focus:border-orange-400 focus:outline-none';
          if (returnVal) { inp.disabled = true; inp.className += ' bg-gray-100 text-gray-400'; }
          inp.addEventListener('input', () => {
            const other = document.getElementById(`cb_purpose10_${sid}${idSuffix===''?'_m':''}`);
            if (other) other.value = inp.value;
          });
          return inp;
        };

        // 데스크탑 행
        desktopRow.appendChild(makeNameDiv());
        desktopRow.appendChild(makeReturnWrap());
        desktopRow.appendChild(makeP9());
        desktopRow.appendChild(makeP10());

        // 모바일 카드
        // 1행: 이름
        const mNameRow = document.createElement('div');
        mNameRow.className = 'mb-2';
        mNameRow.appendChild(makeNameDiv());
        mobileCard.appendChild(mNameRow);
        // 2행: 반납기간
        const mReturnRow = document.createElement('div');
        mReturnRow.className = 'mb-2';
        const mReturnLabel = document.createElement('div');
        mReturnLabel.className = 'text-xs text-gray-400 mb-1';
        mReturnLabel.textContent = '반납기간';
        mReturnRow.appendChild(mReturnLabel);
        mReturnRow.appendChild(makeReturnWrap('_m'));
        mobileCard.appendChild(mReturnRow);
        // 3행: 9교시 / 10교시 나란히
        const mPurposeRow = document.createElement('div');
        mPurposeRow.className = 'grid grid-cols-2 gap-2';
        const p9Wrap = document.createElement('div');
        p9Wrap.innerHTML = '<div class="text-xs text-gray-400 mb-1">9교시 사용목적</div>';
        p9Wrap.appendChild(makeP9('_m'));
        const p10Wrap = document.createElement('div');
        p10Wrap.innerHTML = '<div class="text-xs text-gray-400 mb-1">10교시 사용목적</div>';
        p10Wrap.appendChild(makeP10('_m'));
        mPurposeRow.appendChild(p9Wrap);
        mPurposeRow.appendChild(p10Wrap);
        mobileCard.appendChild(mPurposeRow);

        table.appendChild(desktopRow);
        table.appendChild(mobileCard);
      });
    }

    window.selectChromebookClass = function(grade, cls) {
      activeChromebookClass = { grade, cls };
      try { sessionStorage.setItem('hannah:adminLastCbClass', JSON.stringify({grade, cls})); } catch(e){}
      renderChromebookPanel();
    };

    window.saveChromebookBookings = async function() {
      if (!activeChromebookClass) return;
      const students = getCbClassStudents(activeChromebookClass.grade, activeChromebookClass.cls);
      const todayKey = getDateKey(new Date());
      const classKey = getCbClassKey(activeChromebookClass.grade, activeChromebookClass.cls);
      const classData = {};
      students.forEach(s => {
        const sid = getCbStudentSid(s);
        const purpose9 = (document.getElementById(`cb_purpose9_${sid}`) || document.getElementById(`cb_purpose9_${sid}_m`))?.value?.trim() || '';
        const purpose10 = (document.getElementById(`cb_purpose10_${sid}`) || document.getElementById(`cb_purpose10_${sid}_m`))?.value?.trim() || '';
        if (purpose9 || purpose10) {
          classData[sid] = { purpose9, purpose10, name: s.name, number: s.number };
        }
      });
      if (!chromebookBookings[todayKey]) chromebookBookings[todayKey] = {};
      chromebookBookings[todayKey][classKey] = classData;
      await saveToFirebase(`chromebookBookings/${todayKey}/${classKey}`, classData);
      const msg = document.getElementById('chromebookSaveMsg');
      if (msg) { msg.classList.remove('hidden'); setTimeout(() => msg.classList.add('hidden'), 2000); }
    };

    // ══ 학생용 크롬북 신청 UI ═══════════════════════════════════════
    let activeUserTab = 'classroom';
    let cbAuthVerified = false;
    let cbAuthName = '';
    let cbAuthSid = '';  // 현재 인증 중인 학생 sid

    window.switchUserTab = function(tab) {
      activeUserTab = tab;
      const isClassroom = (tab === 'classroom');
      const panelCb = document.getElementById('userPanelChromebook');
      const panelCl = document.getElementById('userPanelClassroom');

      if (isClassroom) {
        panelCb.classList.add('hidden');
        panelCl.classList.remove('hidden');
        document.getElementById('userTabClassroom').className = 'px-5 py-2 text-sm font-bold rounded-t-lg bg-blue-600 text-white';
        document.getElementById('userTabChromebook').className = 'px-5 py-2 text-sm font-bold rounded-t-lg bg-white text-gray-600 border border-gray-300';
      } else {
        panelCl.classList.add('hidden');
        panelCb.classList.remove('hidden');  // 먼저 보이게
        document.getElementById('userTabClassroom').className = 'px-5 py-2 text-sm font-bold rounded-t-lg bg-white text-gray-600 border border-gray-300';
        document.getElementById('userTabChromebook').className = 'px-5 py-2 text-sm font-bold rounded-t-lg bg-cyan-600 text-white';
        // 시간 안내 업데이트
        const infoEl = document.getElementById('cbTimeInfo');
        if (infoEl) {
          const s = bookingTimes.cbStart || '08:00';
          const e = bookingTimes.cbEnd   || '23:35';
          const now = isTimeInRangeNow(s, e);
          infoEl.textContent = `신청 가능 시간: ${s} ~ ${e}${now ? '' : ' (현재 신청 불가)'}`;
          infoEl.className = now ? 'text-cyan-600 text-xs mt-1' : 'text-red-500 text-xs mt-1 font-bold';
        }
        // 패널이 보인 상태에서 바로 렌더
        renderUserChromebookPanel();
      }
    };

    function renderUserChromebookPanel() {
      const container = document.getElementById('userCbContent');
      if (!container) return;
      const userName = (document.getElementById('userName')?.value || '').trim();
      const todayKey = getDateKey(new Date());
      const norm = s => (s||'').normalize('NFC').replace(/[\u200B-\u200D\uFEFF\s]/g,'');
      // 소문자 suffix 대문자 정규화 후 파싱
      const normalized = userName.replace(/([가-힣])([a-z])$/, (_,h,a) => h+a.toUpperCase());
      const m = norm(normalized).match(/^(\d+)([가-힣]+)([A-Z]?)$/);

      if (!normalized || !m) {
        cbAuthVerified = false; cbAuthName = '';
        container.innerHTML = '<div class="py-10 text-center text-gray-400 text-sm">이름과 비밀번호를 입력하면 신청할 수 있습니다.</div>';
        return;
      }
      if (cbAuthName !== normalized) { cbAuthVerified = false; cbAuthName = normalized; }

      const grade = m[1], name = m[2], suffix = m[3];
      const allRosters = [...rosterMonWed, ...rosterTueThu];
      const found = allRosters.find(s =>
        norm(String(s.grade)) === grade &&
        (norm(s.name) === norm(name+suffix) || norm(s.name) === norm(name))
      );
      if (!found) {
        container.innerHTML = `<div class="py-8 text-center text-orange-500 text-sm">명단에서 <strong>${normalized}</strong>을 찾을 수 없습니다.<br>이름 형식(예: 7최별무리)을 확인하거나 담당 교사에게 문의하세요.</div>`;
        return;
      }

      const classKey = getCbClassKey(found.grade, getCbStudentClass(found));
      const sid = getCbStudentSid(found);
      cbAuthSid = sid;  // sid 정의 후 설정

      // 비밀번호 미인증
      if (!cbAuthVerified) {
        const isFirstTime = !chromebookPasswords[sid];
      container.innerHTML = `
        <div class="max-w-sm mx-auto mt-4 bg-white border border-cyan-200 rounded-xl p-6 shadow-sm">
          <div class="text-center mb-4">
            <div class="text-2xl mb-2">🔒</div>
            <p class="font-bold text-gray-700">${found.grade}-${found.class||'?'}-${found.number} ${found.name}</p>
            <p class="text-sm text-gray-400 mt-1">${isFirstTime
              ? '처음 사용합니다. 사용할 비밀번호를 입력하면 자동으로 등록됩니다.'
              : '비밀번호를 입력하세요.'}</p>
          </div>
          <input type="password" id="cbAuthPwd" placeholder="${isFirstTime ? '새 비밀번호 설정' : '비밀번호 입력'}"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:border-cyan-400 focus:outline-none mb-3">
          <p id="cbAuthError" class="text-xs text-red-500 mb-2 hidden text-center"></p>
          <button id="cbAuthBtn" data-action-click="${encodeAction("verifyCbPassword",[])}"
            class="w-full px-4 py-2 bg-cyan-600 text-white font-bold rounded-lg hover:bg-cyan-700 text-sm">확인</button>
        </div>`;
        setTimeout(() => {
          const el = document.getElementById('cbAuthPwd');
          if (el) el.addEventListener('keydown', e => { if (e.key==='Enter') window.verifyCbPassword(); });
        }, 0);
        return;
      }

      // 반납기간 확인
      const returnPeriod = (chromebookReturnPeriod[classKey]?.[sid]) || '';
      const savedData = (chromebookBookings[todayKey]?.[classKey]?.[sid]) || {};
      const dowLabel = getDayOfWeek(new Date());

      let html = `<div class="mb-3 p-3 bg-white border rounded-lg flex flex-wrap gap-2 items-center justify-between">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-green-500 font-bold text-sm">✓ 인증됨</span>
          <span class="font-bold text-gray-700">${found.grade}-${found.class||'?'}-${found.number} ${found.name}</span>
          <span class="text-sm text-gray-400">📅 ${todayKey} (${dowLabel}요일)</span>
        </div>
        <button data-action-click="${encodeAction("cbLogout",[])}" class="text-xs text-gray-400 hover:text-red-500 underline">로그아웃</button>
      </div>

      <div class="mb-4 p-3 bg-cyan-50 border border-cyan-100 rounded-xl flex flex-wrap items-center gap-3">
        <span class="text-xs text-gray-500">현재 비밀번호:</span>
        <button id="cbShowPwBtn" data-action-click="${encodeAction("toggleCbPw",[])}"
          class="text-sm text-cyan-600 underline hover:text-cyan-800">🔍 보기</button>
        <span id="cbCurrentPw" class="font-mono text-sm text-cyan-700 font-bold hidden">${chromebookPasswords[sid]||''}</span>
        <span class="text-xs text-gray-400">|</span>
        <input id="cbNewPw" type="text" placeholder="새 비밀번호 입력"
          class="px-2 py-1 border border-gray-300 rounded text-sm focus:border-cyan-400 focus:outline-none w-40">
        <button data-action-click="${encodeAction("saveCbPasswordSelf",[sid])}" class="px-3 py-1 bg-cyan-500 text-white text-sm rounded hover:bg-cyan-600">변경</button>
        <span id="cbNewPwMsg" class="text-xs text-green-600 hidden">✅ 변경되었습니다</span>
      </div>`;

      if (returnPeriod) {
        html += `<div class="p-4 bg-orange-50 border border-orange-300 rounded-lg">
          <p class="text-orange-700 font-bold text-sm">🚫 크롬북 반납기간 중</p>
          <p class="text-orange-600 text-sm mt-1">반납기간: ${returnPeriod}</p>
          <p class="text-orange-500 text-xs mt-1">이 기간에는 크롬북 신청이 불가합니다. 담당 교사에게 문의하세요.</p>
        </div>`;
        container.innerHTML = html; return;
      }

      html += `<div class="bg-white border border-cyan-200 rounded-lg p-4">
        <h4 class="font-bold text-cyan-800 mb-4 text-sm">오늘 크롬북 사용 신청</h4>
        <div class="space-y-3 mb-4">
          <div class="grid grid-cols-4 gap-3 items-center">
            <span class="text-sm font-medium text-gray-700">9교시</span>
            <div class="col-span-3">
              <input type="text" id="userCb_purpose9" value="${savedData.purpose9||''}" placeholder="9교시 사용 목적 (없으면 비워두세요)"
                class="w-full px-3 py-2 border border-gray-200 rounded text-sm focus:border-cyan-400 focus:outline-none">
            </div>
          </div>
          <div class="grid grid-cols-4 gap-3 items-center">
            <span class="text-sm font-medium text-gray-700">10교시</span>
            <div class="col-span-3">
              <input type="text" id="userCb_purpose10" value="${savedData.purpose10||''}" placeholder="10교시 사용 목적 (없으면 비워두세요)"
                class="w-full px-3 py-2 border border-gray-200 rounded text-sm focus:border-cyan-400 focus:outline-none">
            </div>
          </div>
        </div>
        <button data-action-click="${encodeAction("saveUserChromebook",[classKey,sid])}"
          class="w-full px-4 py-3 bg-cyan-600 text-white font-bold rounded-lg hover:bg-cyan-700 text-sm">💾 신청 저장</button>
        <div id="userCbStatus" data-class-key="${classKey}" data-sid="${sid}"
          class="mt-3 p-3 bg-cyan-50 rounded-lg text-xs text-cyan-700 ${(savedData.purpose9||savedData.purpose10) ? '' : 'hidden'}">
          ${(savedData.purpose9||savedData.purpose10) ? `<span class="font-bold">현재 저장된 신청:</span>
            ${savedData.purpose9 ? `<span class="ml-2">9교시: ${savedData.purpose9}</span>` : ''}
            ${savedData.purpose10 ? `<span class="ml-2">10교시: ${savedData.purpose10}</span>` : ''}` : ''}
        </div>
      </div>`;
      container.innerHTML = html;
    }

    window.verifyCbPassword = async function() {
      const inputPwd = document.getElementById('cbAuthPwd')?.value?.trim() || '';
      const errEl    = document.getElementById('cbAuthError');
      if (!inputPwd) {
        if (errEl) { errEl.textContent = '비밀번호를 입력하세요.'; errEl.classList.remove('hidden'); }
        return;
      }
      try {
        const savedPw = chromebookPasswords[cbAuthSid] || null;
        if (savedPw === null) {
          await saveCbPassword(cbAuthSid, inputPwd);
          cbAuthVerified = true;
          renderUserChromebookPanel();
        } else if (inputPwd === savedPw) {
          cbAuthVerified = true;
          renderUserChromebookPanel();
        } else {
          if (errEl) { errEl.textContent = '비밀번호가 맞지 않습니다.'; errEl.classList.remove('hidden'); }
        }
      } catch(e) {
        console.error('verifyCbPassword 오류', e);
        if (errEl) { errEl.textContent = '오류가 발생했습니다. 다시 시도하세요.'; errEl.classList.remove('hidden'); }
      }
    };

    // 인증 후 입력 중 — 입력창 건드리지 않고 저장 현황만 업데이트
    function updateCbStatusOnly() {
      const statusEl = document.getElementById('userCbStatus');
      if (!statusEl) return;
      const todayKey = getDateKey(new Date());
      const savedData = (chromebookBookings[todayKey]?.[statusEl.dataset.classKey]?.[statusEl.dataset.sid]) || {};
      if (savedData.purpose9 || savedData.purpose10) {
        statusEl.innerHTML = `<span class="font-bold">현재 저장된 신청:</span>
          ${savedData.purpose9 ? `<span class="ml-2">9교시: ${savedData.purpose9}</span>` : ''}
          ${savedData.purpose10 ? `<span class="ml-2">10교시: ${savedData.purpose10}</span>` : ''}`;
        statusEl.classList.remove('hidden');
      } else {
        statusEl.classList.add('hidden');
      }
    }

    window.cbLogout = function() {
      cbAuthVerified = false; cbAuthName = '';
      safeRender(renderUserChromebookPanel);
    };

    // 크롬북 비밀번호 보기/숨기기 (5초 후 자동 숨김)
    window.toggleCbPw = function() {
      const pw = document.getElementById('cbCurrentPw');
      const btn = document.getElementById('cbShowPwBtn');
      if (!pw || !btn) return;
      if (pw.classList.contains('hidden')) {
        pw.classList.remove('hidden');
        btn.textContent = '🔍 숨기기';
        setTimeout(() => {
          pw.classList.add('hidden');
          btn.textContent = '🔍 보기';
        }, 5000);
      } else {
        pw.classList.add('hidden');
        btn.textContent = '🔍 보기';
      }
    };

    // 크롬북 비밀번호 변경 (본인)
    window.saveCbPasswordSelf = async function(sid) {
      const newPw = document.getElementById('cbNewPw')?.value?.trim() || '';
      if (!newPw) { alert('새 비밀번호를 입력해주세요.'); return; }
      await saveCbPassword(sid, newPw);
      const curPwEl = document.getElementById('cbCurrentPw');
      if (curPwEl) { curPwEl.textContent = newPw; curPwEl.classList.add('hidden'); }
      const btn = document.getElementById('cbShowPwBtn');
      if (btn) btn.textContent = '🔍 보기';
      const newPwEl = document.getElementById('cbNewPw');
      if (newPwEl) newPwEl.value = '';
      const msg = document.getElementById('cbNewPwMsg');
      if (msg) { msg.classList.remove('hidden'); setTimeout(()=>msg.classList.add('hidden'), 2500); }
    };

    window.saveUserChromebook = async function(classKey, sid) {
      if (!cbAuthVerified) { alert('비밀번호 인증이 필요합니다.'); return; }

      // 크롬북 신청 시간 체크
      const cbS = bookingTimes.cbStart || '08:00';
      const cbE = bookingTimes.cbEnd   || '23:35';
      if (!isTimeInRangeNow(cbS, cbE)) {
        alert(`크롬북 신청 가능 시간이 아닙니다.\n신청 시간: ${cbS} ~ ${cbE}`);
        return;
      }

      const purpose9  = document.getElementById('userCb_purpose9')?.value?.trim()||'';
      const purpose10 = document.getElementById('userCb_purpose10')?.value?.trim()||'';
      const todayKey  = getDateKey(new Date());
      if (!chromebookBookings[todayKey]) chromebookBookings[todayKey] = {};
      if (!chromebookBookings[todayKey][classKey]) chromebookBookings[todayKey][classKey] = {};
      if (purpose9||purpose10) {
        chromebookBookings[todayKey][classKey][sid] = { purpose9, purpose10 };
        await saveToFirebase(`chromebookBookings/${todayKey}/${classKey}/${sid}`, { purpose9, purpose10 });
      } else {
        delete chromebookBookings[todayKey][classKey][sid];
        await saveToFirebase(`chromebookBookings/${todayKey}/${classKey}/${sid}`, null);
      }
      document.getElementById('userName').value='';
      document.getElementById('userPassword').value='';
      cbAuthVerified=false; cbAuthName='';
      const c=document.getElementById('userCbContent');
      if(c) c.innerHTML='<div class="py-10 text-center text-green-600 font-bold text-sm">✅ 크롬북 신청이 저장되었습니다.<br><span class="text-gray-400 font-normal text-xs mt-1 block">다음 학생은 이름과 비밀번호를 새로 입력하세요.</span></div>';
    };
    // ════════════════════════════════════════════════════════════════

    // ══ 크롬북 신청 현황 뷰 ═══════════════════════════════════════════
    function renderChromebookStatusView() {
      const container = document.getElementById('chromebookStatusView');
      if (!container) return;
      container.innerHTML = '';
      const todayKey = getDateKey(new Date());
      const todayData = chromebookBookings[todayKey] || {};
      const dow = getDayOfWeek(new Date());

      // 오늘 강의실 신청한 학생 이름 → 강의실 이름 매핑 (9교시, 10교시) — NFC 정규화 적용
      // 2026-11-05: 🏫 배지 대신 실제 "(강의실/교시)"를 보여주기 위해 이름만이 아니라 강의실
      // 이름까지 저장한다(9·10교시는 중복신청이 없으므로 학생당 교시별로 강의실 1개뿐).
      const norm = s => (s||'').normalize('NFC').trim();
      const classroomBookedNames = { '9교시': new Map(), '10교시': new Map() };
      ['9교시','10교시'].forEach(s => {
        (classrooms||[]).forEach(room => {
          const key = `${todayKey}-${room}-${s}`;
          let list = bookings[key] || [];
          if (!Array.isArray(list)) list = Object.values(list).filter(b=>b&&b.name);
          else list = list.filter(b=>b&&b.name);
          list.forEach(b => classroomBookedNames[s].set(norm(b.name), room));
        });
      });

      const slots = ['9교시','10교시'];
      slots.forEach(slot => {
        const slotCard = document.createElement('div');
        slotCard.className = 'mb-6 bg-white border rounded-lg p-4';

        const slotHeader = document.createElement('div');
        slotHeader.className = 'flex items-center justify-between mb-4';
        slotHeader.innerHTML = `<h4 class="font-bold text-lg text-cyan-700">💻 ${slot} 크롬북 신청 현황</h4>`;
        slotCard.appendChild(slotHeader);

        // 강의실 신청자 (강의실 신청 현황 탭에 있는 학생들 → 크롬북도 신청한 경우 여기 표시)
        // ★ 요구사항 재해석: 강의실 신청한 학생은 강의실탭에 표시, 크롬북탭에는 강의실 미신청자만 반별로 표시
        //   단, 강의실 신청자 중 크롬북도 신청한 경우 이름+사용목적을 표시
        
        // 반별 섹션
        const classGrid = document.createElement('div');
        classGrid.className = 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 items-start';

        CB_CLASSES.forEach(c => {
          const classKey = getCbClassKey(c.grade, c.cls);
          const classData = todayData[classKey] || {};
          const students = getCbClassStudents(c.grade, c.cls);
          const notice = ''; // (반별 공지 제거됨 - 학생별 반납기간으로 대체)

          const col = document.createElement('div');
          col.className = 'border border-cyan-200 rounded-lg overflow-hidden';

          const colHeader = document.createElement('div');
          colHeader.className = 'bg-cyan-500 text-white text-center font-bold py-2 text-sm';
          colHeader.textContent = c.label;
          col.appendChild(colHeader);

          const colBody = document.createElement('div');
          colBody.className = 'p-2 space-y-1';

          // ① 반납기간 학생 - 맨 위에 항상 표시
          const returnStudents = students.filter(s => {
            const sid = getCbStudentSid(s);
            return !!(chromebookReturnPeriod[classKey] && chromebookReturnPeriod[classKey][sid]);
          });
          if (returnStudents.length > 0) {
            const returnSection = document.createElement('div');
            returnSection.className = 'mb-2 pb-2 border-b border-orange-200';
            returnStudents.forEach(s => {
              const sid = getCbStudentSid(s);
              const period = chromebookReturnPeriod[classKey][sid];
              const rItem = document.createElement('div');
              rItem.className = 'bg-orange-50 border border-orange-200 rounded px-2 py-1 text-xs flex items-start justify-between gap-1 mb-1';
              rItem.innerHTML = `<div><div class="font-medium text-gray-700">${s.grade}-${s.class||'?'}-${s.number} ${s.name}</div><div class="text-orange-600 font-bold">🚫 반납: ${period}</div></div>
                <button data-action-click="${encodeAction("deleteCbReturn",[classKey,sid])}" class="text-orange-300 hover:text-red-500 text-xs flex-shrink-0 mt-0.5">✕</button>`;
              returnSection.appendChild(rItem);
            });
            colBody.appendChild(returnSection);
          }

          // 2026-10-28 요청: 강의실을 같이 신청한 학생도 반별 크롬북 카드에서 제외하지 않고
          // 항상 함께 표시한다(이전에는 "강의실도 신청했으면 여기서는 빼고 아래 동시신청
          // 섹션에만 표시"였는데, 혼란을 일으켜 요청에 따라 통합함). 강의실도 함께 신청한
          // 경우 🏫 배지로 참고 표시만 해준다.
          let hasAny = false;
          students.forEach(s => {
            const sid = getCbStudentSid(s);
            const data = classData[sid];
            if (!data) return;
            const hasSlot = slot === '9교시' ? !!data.purpose9 : !!data.purpose10;
            if (!hasSlot) return;
            // 강의실 신청 여부 확인 (app name 형식: 학년+이름) — 신청한 강의실/교시 표시용
            const appName = norm(`${s.grade}${s.name}`);
            const bookedRoom = classroomBookedNames[slot].get(appName);
            hasAny = true;
            const item = document.createElement('div');
            // 2026-11-05: 9교시는 연한 하늘색, 10교시는 연한 초록색으로 바탕색을 구분
            item.className = (slot==='9교시' ? 'bg-sky-50' : 'bg-green-50') + ' rounded px-2 py-1 text-xs';
            item.innerHTML = `<div class="font-medium text-gray-800">${s.grade}-${s.class||'?'}-${s.number} ${s.name}${bookedRoom ? `(${bookedRoom})` : ''}</div>${(slot==='9교시'?data.purpose9:data.purpose10) ? `<div class="${slot==='9교시'?'text-sky-600':'text-green-600'} mt-0.5">${slot==='9교시'?data.purpose9:data.purpose10}</div>` : ''}`;
            colBody.appendChild(item);
          });
          if (!hasAny) {
            const empty = document.createElement('div');
            empty.className = 'text-xs text-gray-300 text-center py-3';
            empty.textContent = '없음';
            colBody.appendChild(empty);
          }
          col.appendChild(colBody);
          classGrid.appendChild(col);
        });
        slotCard.appendChild(classGrid);
        // 2026-10-28: "강의실+크롬북 동시 신청" 별도 섹션은 제거함 — 이제 반별 크롬북 카드에
        // 해당 학생들이 항상 함께 표시되고(🏫 배지로 구분) 중복으로 보여줄 필요가 없어짐.

        container.appendChild(slotCard);
      });

      // 오늘 신청 내역도 없고 반납기간 학생도 없을 때만 "없습니다" 표시
      const hasReturnStudents = CB_CLASSES.some(c => {
        const classKey = getCbClassKey(c.grade, c.cls);
        const ret = chromebookReturnPeriod[classKey] || {};
        return Object.keys(ret).length > 0;
      });
      if (Object.keys(todayData).length === 0 && !hasReturnStudents) {
        container.innerHTML = '<div class="text-center text-gray-400 py-10">오늘 크롬북 신청 내역이 없습니다.</div>';
      }
    }

    // ── 목요일 규칙 요일 저장 ───────────────────────────────────────
    // 날짜를 객체 키로 저장: { "2026-05-26": true } 형태
    // → Firebase 배열 변환 문제 완전 회피
    function buildThuRuleObj() {
      const obj = {};
      thursdayRuleDates.forEach(d => { obj[d] = true; });
      return obj;
    }

    window.addThuRuleDate = async function() {
      const dateInput = document.getElementById('thursdayRuleDateInput')?.value;
      if (!dateInput) { alert('날짜를 선택해주세요.'); return; }
      console.log('[THU] 날짜 추가 시작:', dateInput);
      const today = getDateKey(new Date());
      thursdayRuleDates.add(dateInput);
      // 지난 날짜 자동 제거
      thursdayRuleDates.forEach(d => { if (d < today) thursdayRuleDates.delete(d); });
      const objToSave = buildThuRuleObj();
      console.log('[THU] Firebase 저장 데이터:', JSON.stringify(objToSave));
      await saveToFirebase('thursdayRule', objToSave);
      console.log('[THU] Firebase 저장 완료');
      thursdayRuleDay = getEffectiveThuRuleDay();
      const msg = document.getElementById('thuRuleSaveMsg');
      if (msg) { msg.classList.remove('hidden'); setTimeout(() => msg.classList.add('hidden'), 1500); }
      updateThuRuleStatus();
      if (selectedDate) safeRender(renderClassrooms);
    };

    window.removeThuRuleDate = async function(date) {
      thursdayRuleDates.delete(date);
      // 빈 경우 null로 저장하면 Firebase에서 키 자체가 삭제됨
      await saveToFirebase('thursdayRule', thursdayRuleDates.size > 0 ? buildThuRuleObj() : null);
      thursdayRuleDay = getEffectiveThuRuleDay();
      updateThuRuleStatus();
      if (selectedDate) safeRender(renderClassrooms);
    };

    window.clearThuRuleDay = async function() {
      thursdayRuleDates.clear();
      await saveToFirebase('thursdayRule', null);
      thursdayRuleDay = '목';
      const dateInput = document.getElementById('thursdayRuleDateInput');
      if (dateInput) dateInput.value = '';
      updateThuRuleStatus();
      if (selectedDate) safeRender(renderClassrooms);
    };

    function updateThuRuleStatus() {
      const status = document.getElementById('thursdayRuleStatus');
      const today  = getDateKey(new Date());
      if (status) {
        const today2 = getDateKey(new Date());
        const isActiveToday = thursdayRuleDates.has(today2);
        if (isActiveToday) {
          const futureDates = [...thursdayRuleDates].sort().filter(d => d > today2);
          const nextMsg = futureDates.length > 0
            ? ` | 이후 지정 날짜: ${futureDates.map(d => `${d}(${getDayOfWeek(new Date(d+'T00:00:00'))})`).join(', ')}`
            : ' | 이후 지정 날짜 없음 (내일부터 목요일만 적용)';
          status.textContent = `⚡ 오늘(${today2}, ${getDayOfWeek(new Date())}요일) 목요일 규칙 적용 중${nextMsg}`;
          status.className = 'text-xs text-orange-700 font-bold mt-2';
        } else if (thursdayRuleDates.size > 0) {
          const upcoming = [...thursdayRuleDates].sort().map(d => `${d}(${getDayOfWeek(new Date(d+'T00:00:00'))})`).join(', ');
          status.textContent = `📅 목요일 규칙 적용 예정: ${upcoming}`;
          status.className = 'text-xs text-blue-600 mt-2';
        } else {
          status.textContent = '현재: 목요일에만 목요일 규칙 적용 중';
          status.className = 'text-xs text-gray-500 mt-2';
        }
      }
      // 날짜 태그 렌더링
      const tagsDiv = document.getElementById('thuRuleDateTags');
      if (tagsDiv) {
        const today2 = getDateKey(new Date());
        const sorted = [...thursdayRuleDates].sort();
        if (sorted.length === 0) {
          tagsDiv.innerHTML = '<span class="text-xs text-gray-400">지정된 날짜 없음 (목요일에만 기본 적용)</span>';
        } else {
          tagsDiv.innerHTML = sorted.map(d => {
            const dow = getDayOfWeek(new Date(d + 'T00:00:00'));
            const isToday = (d === today2);
            return `<span class="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-bold ${isToday ? 'bg-orange-500 text-white' : 'bg-orange-100 text-orange-800'}">
              ${d} (${dow}요일)${isToday ? ' ⚡' : ''}
              <button data-action-click="${encodeAction("removeThuRuleDate",[d])}" class="ml-1 hover:opacity-70 font-bold">✕</button>
            </span>`;
          }).join('');
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────

    // ── 그리드 빌더 공통 함수 ──────────────────────────────────────────
    function buildAvailGrid(containerId, dataObj) {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.innerHTML = '';
      const wrapper = document.createElement('div');
      wrapper.className = 'overflow-x-auto';
      const table = document.createElement('table');
      table.className = 'w-full bg-white border text-xs';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      headRow.className = 'bg-gray-100';
      const thRoom = document.createElement('th');
      thRoom.className = 'px-2 py-1.5 border text-left text-xs whitespace-nowrap';
      thRoom.textContent = '강의실';
      headRow.appendChild(thRoom);
      timeSlots.forEach(ts => {
        const th = document.createElement('th');
        th.className = 'px-1 py-1.5 border text-center text-xs';
        // 모바일에서 줄바꿈 방지를 위해 짧게
        const label = ts.replace('교시','').replace('저녁','저녁\n');
        th.innerHTML = ts.replace('저녁','저녁<br>').replace('교시','교시');
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      classrooms.forEach(room => {
        const tr = document.createElement('tr');
        const tdRoom = document.createElement('td');
        tdRoom.className = 'px-2 py-1.5 border text-xs font-medium whitespace-nowrap';
        tdRoom.textContent = room;
        tr.appendChild(tdRoom);
        timeSlots.forEach(ts => {
          const td = document.createElement('td');
          td.className = 'px-1 py-1.5 border text-center';
          const chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.className = 'w-4 h-4 cursor-pointer';
          chk.dataset.room = room;
          chk.dataset.timeslot = ts;
          chk.checked = !!(dataObj && dataObj[room] && dataObj[room][ts]);
          td.appendChild(chk);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrapper.appendChild(table);
      container.appendChild(wrapper);
    }

    function renderAvailabilityGrid(){
      try{
        updateThuRuleStatus();
        const day = document.getElementById('availabilityDay').value;
        const container = document.getElementById('availabilityGrid');
        container.innerHTML = '';
        if (!day){ container.innerHTML = '<div class="text-sm text-gray-500">요일을 선택하세요.</div>'; return; }
        const baseData = baseWeeklyAvailability[day] || weeklyAvailability[day] || {};
        buildAvailGrid('availabilityGrid', baseData);
        renderTempAvailList();
      } catch(e){ console.error('renderAvailabilityGrid 오류', e); }
    }

    window.loadTempAvail = function() {
      const loadDate = document.getElementById('tempLoadDate')?.value;
      const saveDate = document.getElementById('tempAvailDate')?.value;
      if (!saveDate) { alert('저장할 날짜를 선택해주세요.'); return; }
      // 불러올 날짜 미입력 시 저장할 날짜 기준으로 불러오기
      const srcDate = loadDate || saveDate;
      const srcDow  = getDayOfWeek(new Date(srcDate + 'T00:00:00'));
      const saveDow = getDayOfWeek(new Date(saveDate + 'T00:00:00'));
      const data = tempAvailability[srcDate] || baseWeeklyAvailability[srcDow] || weeklyAvailability[srcDow] || {};
      buildAvailGrid('tempAvailabilityGrid', data);
      // 저장 대상 날짜 라벨
      const label = document.getElementById('tempEditDateLabel');
      if (label) label.textContent = `${saveDate} (${saveDow}요일)`;
      document.getElementById('tempEditSection')?.classList.remove('hidden');
      document.getElementById('tempEditPlaceholder')?.classList.add('hidden');
    };

    window.saveTempAvail = async function() {
      const dateInput = document.getElementById('tempAvailDate')?.value;
      if (!dateInput) { alert('저장할 날짜를 선택해주세요.'); return; }
      const checks = document.getElementById('tempAvailabilityGrid')?.querySelectorAll('input[type="checkbox"]');
      if (!checks || checks.length === 0) { alert('먼저 [불러오기]를 눌러 설정을 불러오세요.'); return; }
      const setting = {};
      checks.forEach(chk => {
        if (!setting[chk.dataset.room]) setting[chk.dataset.room] = {};
        setting[chk.dataset.room][chk.dataset.timeslot] = !!chk.checked;
      });
      tempAvailability[dateInput] = setting;
      await saveToFirebase('tempAvailability', tempAvailability);
      const msg = document.getElementById('tempAvailSaveMsg');
      if (msg) { msg.classList.remove('hidden'); setTimeout(()=>msg.classList.add('hidden'), 2000); }
      renderTempAvailList();
      if (selectedDate) safeRender(renderClassrooms);
    };

    function renderTempAvailList() {
      const listDiv = document.getElementById('tempAvailList');
      if (!listDiv) return;
      const today = getDateKey(new Date());
      const keys = Object.keys(tempAvailability).filter(d => d >= today).sort();
      if (keys.length === 0) {
        listDiv.innerHTML = '<p class="text-xs text-gray-400">등록된 일시적 변경 없음</p>';
        return;
      }
      listDiv.innerHTML = '<p class="text-xs font-bold text-gray-600 mb-2">등록된 일시적 변경:</p>' +
        keys.map(d => {
          const dow = getDayOfWeek(new Date(d+'T00:00:00'));
          const isToday = (d === today);
          return `<div class="flex items-center gap-2 p-2 rounded-lg ${isToday?'bg-orange-100 border border-orange-300':'bg-white border border-gray-200'}">
            <span class="text-sm font-bold ${isToday?'text-orange-700':'text-gray-700'}">${d} (${dow}요일)${isToday?' ⚡적용 중':''}</span>
            <button data-action-click="${encodeAction("deleteTempAvail",[d])}" class="ml-auto px-2 py-1 bg-red-100 text-red-600 text-xs rounded hover:bg-red-200">삭제</button>
          </div>`;
        }).join('');
    }

    window.deleteTempAvail = async function(date) {
      if (!confirm(date+' 일시적 변경을 삭제할까요?\n삭제 후 정기설정으로 복귀합니다.')) return;
      delete tempAvailability[date];
      await saveToFirebase('tempAvailability', Object.keys(tempAvailability).length > 0 ? tempAvailability : null);
      renderTempAvailList();
      if (selectedDate) safeRender(renderClassrooms);
    };

    window.switchAvailTab = function(tab) {
      const basePanel = document.getElementById('availPanelBase');
      const tempPanel = document.getElementById('availPanelTemp');
      const baseBtn   = document.getElementById('availTabBase');
      const tempBtn   = document.getElementById('availTabTemp');
      if (tab === 'base') {
        basePanel.classList.remove('hidden'); tempPanel.classList.add('hidden');
        baseBtn.className = 'px-4 py-2 text-sm font-bold rounded-lg bg-blue-600 text-white';
        tempBtn.className = 'px-4 py-2 text-sm font-bold rounded-lg bg-white text-gray-600 border border-gray-300';
      } else {
        basePanel.classList.add('hidden'); tempPanel.classList.remove('hidden');
        tempBtn.className = 'px-4 py-2 text-sm font-bold rounded-lg bg-orange-500 text-white';
        baseBtn.className = 'px-4 py-2 text-sm font-bold rounded-lg bg-white text-gray-600 border border-gray-300';
        renderTempAvailList();
      }
    };
    // ──────────────────────────────────────────────────────────────────

    function renderScheduleNotesList(){
      try{
        const container = document.getElementById('notesListContainer');
        if (!container) return;
        container.innerHTML = '';
        if (!scheduleNotes || Object.keys(scheduleNotes).length===0){
          container.innerHTML = '<div class="text-sm text-gray-500 text-center py-2">등록된 특이사항이 없습니다.</div>';
          return;
        }
        Object.keys(scheduleNotes).forEach(key=>{
          const content = scheduleNotes[key];
          const el = document.createElement('div'); el.className='flex justify-between items-center bg-pink-100 p-2 rounded';
          el.innerHTML = `<div class="text-sm"><span class="font-medium">${key}</span><span class="ml-2 text-gray-600">${content}</span></div>
                          <button data-action-click="${encodeAction("deleteScheduleNote",[key])}" class="px-2 py-1 bg-red-500 text-white text-xs rounded">삭제</button>`;
          container.appendChild(el);
        });
      } catch(e){ console.error('renderScheduleNotesList 오류', e); }
    }

    function renderAllowedDatesList(){
      try{
        const container = document.getElementById('datesContainer');
        if (!container) return;
        container.innerHTML = '';
        Array.from(allowedDates).sort().forEach(dk=>{
          const el = document.createElement('div'); el.className='flex justify-between items-center bg-purple-100 p-2 rounded';
          el.innerHTML = `<span>${dk}</span><button data-action-click="${encodeAction("removeAllowedDate",[dk])}" class="px-2 py-1 bg-red-500 text-white text-xs rounded">제거</button>`;
          container.appendChild(el);
        });
      } catch(e){ console.error('renderAllowedDatesList 오류', e); }
    }

    // ========== 핵심 수정: Firebase Transaction 사용 ==========
    window.bookClassroom = async function(classroom, timeSlot){
      try{
        const nameEl = document.getElementById('userName');
        const userName = nameEl.value.trim();
        const password = document.getElementById('userPassword').value.trim();
        const nameError = document.getElementById('nameError'); 
        nameError.classList.add('hidden'); 
        nameError.textContent = '';
        
        if (!userName || !password){ 
          alert('이름과 비밀번호를 입력하세요.'); 
          return; 
        }
        
        const re = /^[0-9][가-힣]{2,4}[A-Z]?$/;
        if (!re.test(userName)){ 
          nameError.textContent='이름 형식 오류: 숫자1 + 한글 2~4자 + 대문자 알파벳 1자(선택)'; 
          nameError.classList.remove('hidden'); 
          nameEl.focus(); 
          return; 
        }

        // IME 오입력 자동 정리
        // - roster에 알파벳 포함 이름이 있으면(이소은A 등) 그대로 유지
        // - roster에 알파벳 없는 이름만 있으면 알파벳 자동 제거
        // - roster에 없으면 그대로 유지
        const cleanUserName = (() => {
          // 소문자 suffix → 대문자 정규화
          const normalized = userName.replace(/([가-힣])([a-z])$/, (_, h, a) => h + a.toUpperCase());
          const hasTrailing = /^[0-9][가-힣]{2,4}[A-Z]$/.test(normalized);
          if (!hasTrailing) return normalized;
          const normS = s => (s||'').normalize('NFC').trim();
          const grade = normalized[0];
          const nameWithLetter    = normS(normalized.slice(1));
          const nameWithoutLetter = normS(normalized.slice(1, -1));
          const allR = [...rosterMonWed, ...rosterTueThu];
          const matchWith    = allR.find(s => String(s.grade)===grade && normS(s.name)===nameWithLetter);
          const matchWithout = allR.find(s => String(s.grade)===grade && normS(s.name)===nameWithoutLetter);
          if (matchWith)    return normalized;
          if (matchWithout) return normalized.slice(0,-1);
          return normalized;
        })();
        nameEl.value = cleanUserName;
        
        if (!selectedDate) return;
        if (!canAttemptBookingFor(selectedDate, classroom, timeSlot)){
          alert('이 시간대는 신청 불가합니다.');
          return;
        }
        // 학년 교실(2026-10-19): 같은 학년 학생만 신청 가능.
        if (CLASSROOM_GRADE[classroom] && gradeOfUserName(cleanUserName) !== CLASSROOM_GRADE[classroom]) {
          alert(`${CLASSROOM_GRADE[classroom]}학년 전용 교실입니다(다른 학년 신청 불가).`);
          return;
        }

        const dateKey = getDateKey(selectedDate);
        const key = `${dateKey}-${classroom}-${timeSlot}`;

        // Transaction을 사용하여 동시성 문제 해결
        const bookingRef = ref(database, 'bookings');

        // 동시 접속이 많을 때(예: 70명 동시 신청)의 극히 드문 경합 실패에 한해
        // 짧은 대기 후 자동 재시도. Firebase가 이미 내부적으로 동시쓰기 충돌은
        // 자동 재시도하므로, 여기서 재시도하는 건 그마저 소진된 경우뿐.
        // "이미 신청됨" 등 정당한 거절은 규칙 위반으로 즉시 판정해 재시도하지 않음(불필요한 지연 방지).
        let result;
        let abortedByRule = false; // 규칙 위반으로 의도적으로 abort된 경우 true
        let abortMsg = ''; // 규칙 위반 시 사용자에게 보여줄 구체적인 사유
        const maxAttempts = 3; // 최초 시도 + 재시도 2회 (경합 실패 시에만)
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          abortedByRule = false; abortMsg = '';
          result = await runTransaction(bookingRef, (current) => {
          if (!current) current = {};
          
          // 현재 사용자의 모든 예약 확인
          let alreadyBooked = [];
          for (let room of classrooms){
            for (let slot of timeSlots){
              const ck = `${dateKey}-${room}-${slot}`;
              let list = current[ck] || [];
              if (!Array.isArray(list)) list = Object.values(list).filter(b=>b&&b.name);
              else list = list.filter(b=>b&&b.name);
              if (list.some(b=>b.name===cleanUserName)) alreadyBooked.push({slot, room});
            }
          }
          
          // 동일 시간대 중복 체크
          if (alreadyBooked.some(b=>b.slot===timeSlot)){
            abortedByRule = true; abortMsg = '동일 시간대 이미 신청됨';
            return; // abort transaction
          }
          
          // 동아리/밴드 활동 확인 (Transaction 내부에서 직접 체크)
          const dow = getDayOfWeek(selectedDate);
          let hasClubActivity = false;
          for (let booking of alreadyBooked) {
            const noteKey = `${dow}-${booking.room}-${booking.slot}`;
            const note = scheduleNotes[noteKey] || '';
            if (note.includes('동아리') || note.includes('밴드') || note.includes('찬양팀')) {
              hasClubActivity = true;
              break;
            }
          }

          // ── 목요일 특수 허용 규칙 ──────────────────────────────────────
          const isThursday     = (dow === getEffectiveThuRuleDay()); // 관리자 설정 요일
          const isLibEvening1  = (classroom === '도서관' && timeSlot === '저녁1교시');
          const isLibEvening2  = (classroom === '도서관' && timeSlot === '저녁2교시');
          const isHallEvening2 = (classroom === '강당'   && timeSlot === '저녁2교시');
          const isNewRoomSpecial = isNewThuClassroomSlot(classroom, timeSlot);

          if (isThursday && (isLibEvening1 || isLibEvening2 || isHallEvening2 || isNewRoomSpecial)) {
            const myLib2  = alreadyBooked.some(b => b.room === '도서관' && b.slot === '저녁2교시');
            const myHall2 = alreadyBooked.some(b => b.room === '강당'   && b.slot === '저녁2교시');

            // 도서관 저녁2 ↔ 강당 저녁2 상호배타
            if (isLibEvening2  && myHall2) { abortedByRule = true; abortMsg = '강당 저녁2교시와 도서관 저녁2교시는 중복 신청 불가'; return; } // abort
            if (isHallEvening2 && myLib2)  { abortedByRule = true; abortMsg = '도서관 저녁2교시와 강당 저녁2교시는 중복 신청 불가'; return; } // abort

            const myThursdaySpecial = alreadyBooked.filter(b =>
              (b.room === '도서관' && b.slot === '저녁1교시') ||
              (b.room === '도서관' && b.slot === '저녁2교시') ||
              (b.room === '강당'   && b.slot === '저녁2교시') ||
              isNewThuClassroomSlot(b.room, b.slot)
            );
            const myNormalBookings = alreadyBooked.filter(b => !myThursdaySpecial.includes(b));

            // 일반슬롯 1건 + 특수슬롯 이미 2건이면 추가 불가
            if (myNormalBookings.length >= 1 && myThursdaySpecial.length >= 2) { abortedByRule = true; abortMsg = '목요일 특수허용 한도 초과 (일반 1건 + 특수 최대 2건)'; return; } // abort
            // 특수슬롯만 이미 2건이면 추가 불가
            if (myThursdaySpecial.length >= 2) { abortedByRule = true; abortMsg = '목요일 특수슬롯 최대 2건 초과'; return; } // abort

            // 목요일 특수 허용 통과 → 예약 추가로 진행
          } else {
          // ──────────────────────────────────────────────────────────────
            // 일반 규칙: 목요일이면 특수슬롯(도서관저녁1·저녁2, 강당저녁2)은 카운트 제외
            let countable = alreadyBooked;
            if (dow === getEffectiveThuRuleDay()) {
              countable = alreadyBooked.filter(b => !(
                (b.room === '도서관' && b.slot === '저녁1교시') ||
                (b.room === '도서관' && b.slot === '저녁2교시') ||
                (b.room === '강당'   && b.slot === '저녁2교시') ||
                isNewThuClassroomSlot(b.room, b.slot)
              ));
            }
            const maxBookings = hasClubActivity ? 2 : 1;
            if (countable.length >= maxBookings) {
              abortedByRule = true;
              abortMsg = countable[0] ? `이미 ${countable[0].room} ${countable[0].slot} 신청됨(하루 ${maxBookings}건)` : '신청 한도 초과';
              return;
            } // abort
          }
          
          // 예약 추가
          let bookingList = current[key] || [];
          if (!Array.isArray(bookingList)) {
            bookingList = Object.values(bookingList||{}).filter(b=>b&&b.name);
          } else {
            bookingList = bookingList.filter(b=>b&&b.name);
          }
          
          bookingList.push({ 
            name: cleanUserName, 
            password: password, 
            timestamp: new Date().toISOString(),
            checked: false
          });
          
          current[key] = bookingList;
          return current;
          });

          if (result.committed) break; // 성공하면 재시도 없이 종료
          if (abortedByRule) break; // 규칙 위반(이미 신청됨 등)은 재시도해도 결과 같으므로 즉시 종료
          if (attempt < maxAttempts) {
            // 경합으로 인한 실패로 추정 — 잠깐 대기 후 재시도
            await new Promise(res => setTimeout(res, 300 + Math.random() * 300));
          }
        }
        
        if (result.committed) {
          // 트랜잭션 결과를 로컬 bookings에 즉시 반영 (Firebase 리스너 도착을 기다리지 않고 확실하게 최신 상태로 렌더)
          try { if (result.snapshot && result.snapshot.exists()) bookings = result.snapshot.val() || {}; } catch(e){}
          alert('신청이 완료되었습니다.');
          document.getElementById('userName').value='';
          document.getElementById('userPassword').value='';
          // 날짜 선택은 유지 — 목요일 규칙 등으로 같은 날 추가 신청 가능하므로
          // 강의실 목록을 즉시 다시 그려 이어서 신청할 수 있게 함
          safeRender(renderClassrooms);
          safeRender(renderCalendar);
        } else {
          alert(abortMsg || '신청 중 문제가 발생했습니다. 다시 시도해주세요.');
        }
        
      } catch(e){ 
        console.error('bookClassroom 오류', e); 
        alert('신청 중 오류가 발생했습니다.'); 
      }
    };

    // 체크박스 토글 함수 (Firebase Transaction 사용) + attendanceChecks 동기화
    window.toggleCheckbox = async function(dateKey, classroom, timeSlot, index, isChecked){
      try {
        const key = `${dateKey}-${classroom}-${timeSlot}`;
        const bookingRef = ref(database, 'bookings');
        let checkedName = null;

        const result = await runTransaction(bookingRef, (current) => {
          if (!current) return current;
          let bookingList = current[key] || [];
          if (!Array.isArray(bookingList)) {
            bookingList = Object.values(bookingList).filter(b=>b&&b.name);
          }
          if (index >= bookingList.length) return;
          bookingList[index].checked = isChecked;
          checkedName = bookingList[index].name;
          current[key] = bookingList;
          return current;
        });

        if (result.committed) {
          // attendanceChecks 동기화: 저녁1·저녁2 교시만, activeTodayTab 탭 기준
          if (checkedName && (timeSlot === '저녁1교시' || timeSlot === '저녁2교시')) {
            const match = checkedName.match(/^(\d+)(.+)$/);
            if (match) {
              const grade   = match[1];
              const name    = match[2];
              const eSlot   = timeSlot === '저녁1교시' ? 'e1' : 'e2';
              const curTab  = activeTodayTab || activeRosterTab || getDefaultTab();
              const acPath  = `attendanceChecks/${dateKey}_${curTab}/${grade}_${name}_${eSlot}`;
              if (!attendanceChecks[`${dateKey}_${curTab}`]) attendanceChecks[`${dateKey}_${curTab}`] = {};
              attendanceChecks[`${dateKey}_${curTab}`][`${grade}_${name}_${eSlot}`] = isChecked;
              await saveToFirebase(acPath, isChecked);
            }
          }
          if (isAdminLoggedIn) safeRender(renderAttendancePanel);
        }
      } catch(e) {
        console.error('toggleCheckbox 오류', e);
        alert('체크 상태 저장 중 오류가 발생했습니다.');
      }
    };

    // ========== 핵심 수정: 삭제도 Transaction 사용 ==========
    window.attemptDeleteBooking = async function(dateKey, classroom, timeSlot, index){
      try{
        const key = `${dateKey}-${classroom}-${timeSlot}`;
        
        // 관리자인 경우
        if (isAdminLoggedIn){
          if (!confirm('관리자 권한으로 이 신청을 삭제하시겠습니까?')) return;
          
          const bookingRef = ref(database, 'bookings');
          const result = await runTransaction(bookingRef, (current) => {
            if (!current) return current;
            
            let bookingList = current[key] || [];
            if (!Array.isArray(bookingList)) {
              bookingList = Object.values(bookingList).filter(b=>b&&b.name);
            }
            
            if (index >= bookingList.length) return; // abort
            
            bookingList.splice(index, 1);
            
            if (bookingList.length === 0) {
              delete current[key];
            } else {
              current[key] = bookingList;
            }
            
            return current;
          });
          
          if (result.committed) {
            alert('삭제되었습니다.');
            safeRender(renderClassrooms); 
            safeRender(renderTodayBookings);
          }
          return;
        }
        
        // 일반 사용자인 경우
        const inputPwd = prompt('예약 삭제를 위해 비밀번호를 입력하세요:');
        if (inputPwd === null) return;
        
        // 먼저 현재 데이터 확인 (비밀번호 검증용)
        let currentBookingList = bookings[key] || [];
        if (!Array.isArray(currentBookingList)) {
          currentBookingList = Object.values(currentBookingList).filter(b=>b&&b.name);
        }
        
        if (index >= currentBookingList.length || !currentBookingList[index]){ 
          alert('신청 내역을 찾을 수 없습니다.'); 
          return; 
        }
        
        const target = currentBookingList[index];
        if (!target || typeof target.password === 'undefined'){ 
          alert('이 예약은 비밀번호로 삭제할 수 없습니다. 관리자에게 문의하세요.'); 
          return; 
        }
        
        if (inputPwd !== target.password){ 
          alert('비밀번호가 일치하지 않습니다.'); 
          return; 
        }
        
        if (!confirm('정말로 삭제하시겠습니까?')) return;
        
        // Transaction으로 삭제
        const bookingRef = ref(database, 'bookings');
        const result = await runTransaction(bookingRef, (current) => {
          if (!current) return current;
          
          let bookingList = current[key] || [];
          if (!Array.isArray(bookingList)) {
            bookingList = Object.values(bookingList).filter(b=>b&&b.name);
          }
          
          // 인덱스가 여전히 유효한지 재확인
          if (index >= bookingList.length) return; // abort
          
          // 비밀번호 재확인 (transaction 내에서)
          if (bookingList[index].password !== inputPwd) return; // abort
          
          bookingList.splice(index, 1);
          
          if (bookingList.length === 0) {
            delete current[key];
          } else {
            current[key] = bookingList;
          }
          
          return current;
        });
        
        if (result.committed) {
          alert('삭제되었습니다.'); 
          safeRender(renderClassrooms);
        } else {
          alert('삭제 중 문제가 발생했습니다. 다시 시도해주세요.');
        }
        
      } catch(e){ 
        console.error('attemptDeleteBooking 오류', e); 
        alert('삭제 중 오류가 발생했습니다.'); 
      }
    };

    // 관리자 날짜 추가/제거
    window.removeAllowedDate = async function(dateKey){
      try{ allowedDates.delete(dateKey); await saveToFirebase('allowedDates', Array.from(allowedDates)); renderCalendar(); } catch(e){ console.error('removeAllowedDate 오류', e); }
    };

    document.getElementById('changePasswordBtn').addEventListener('click', async ()=>{
      try{
        const current = document.getElementById('currentPassword').value;
        const np = document.getElementById('newPassword').value;
        const cf = document.getElementById('confirmPassword').value;
        if (current !== adminPassword){ alert('현재 비밀번호가 맞지 않습니다.'); return; }
        if (np.length < 4){ alert('새 비밀번호는 4자리 이상'); return; }
        if (np !== cf){ alert('확인값 불일치'); return; }
        adminPassword = np;
        await saveToFirebase('adminPassword', adminPassword);
        alert('비밀번호 변경됨');
        document.getElementById('currentPassword').value=''; document.getElementById('newPassword').value=''; document.getElementById('confirmPassword').value='';
        document.getElementById('passwordChangePanel').classList.add('hidden');
      } catch(e){ console.error('changePasswordBtn 오류', e); alert('오류'); }
    });

    document.getElementById('saveTimeSettingsBtn').addEventListener('click', async ()=>{
      try{
        bookingTimes.regularStart = document.getElementById('regularStart').value.trim();
        bookingTimes.regularEnd   = document.getElementById('regularEnd').value.trim();
        bookingTimes.eveningStart = document.getElementById('eveningStart').value.trim();
        bookingTimes.eveningEnd   = document.getElementById('eveningEnd').value.trim();
        bookingTimes.cbStart      = document.getElementById('cbStart')?.value?.trim() || '08:00';
        bookingTimes.cbEnd        = document.getElementById('cbEnd')?.value?.trim()   || '23:35';
        window.bookingTimes = bookingTimes;
        await saveToFirebase('bookingTimes', bookingTimes);
        populateTimeSettingsInputs();
        alert('시간 설정 저장됨');
        document.getElementById('timeSettingsPanel').classList.add('hidden');
        renderCalendar(); safeRender(renderClassrooms);
      } catch(e){ console.error('saveTimeSettingsBtn 오류', e); alert('오류'); }
    });

    document.getElementById('addClassroomConfirmBtn').addEventListener('click', async ()=>{
      try{
        const newName = document.getElementById('newClassroomName').value.trim();
        if (!newName){ alert('강의실 이름 입력'); return; }
        if (classrooms.includes(newName)){ alert('이미 존재'); return; }
        classrooms.push(newName);
        await saveToFirebase('classrooms', classrooms);
        document.getElementById('newClassroomName').value='';
        alert('강의실 추가됨');
        renderCalendar(); renderAvailabilityGrid(); populateNoteClassroomSelect(); refreshAdminClassroomList();
      } catch(e){ console.error('addClassroomConfirmBtn 오류', e); alert('오류'); }
    });

    window.deleteScheduleNote = async function(key){
      try{ if (!confirm('특이사항 삭제?')) return; delete scheduleNotes[key]; await saveToFirebase('scheduleNotes', scheduleNotes); alert('삭제됨'); renderScheduleNotesList(); } catch(e){ console.error('deleteScheduleNote 오류', e); alert('오류'); }
    };

    document.getElementById('saveNoteBtn').addEventListener('click', async ()=>{
      try{
        const day = document.getElementById('noteDay').value;
        const classroom = document.getElementById('noteClassroom').value;
        const timeSlot = document.getElementById('noteTimeSlot').value;
        const content = document.getElementById('noteContent').value.trim();
        if (!day || !classroom || !timeSlot){ alert('모든 항목 선택'); return; }
        if (!content){ alert('내용 입력'); return; }
        const key = `${day}-${classroom}-${timeSlot}`;
        scheduleNotes[key] = content;
        await saveToFirebase('scheduleNotes', scheduleNotes);
        alert('특이사항 저장됨');
        document.getElementById('noteDay').value=''; document.getElementById('noteClassroom').value=''; document.getElementById('noteTimeSlot').value=''; document.getElementById('noteContent').value='';
        renderScheduleNotesList();
      } catch(e){ console.error('saveNoteBtn 오류', e); alert('오류'); }
    });

    document.getElementById('saveAvailabilityBtn').addEventListener('click', async ()=>{ await saveWeeklyAvailabilityFromGrid(); });

    async function saveWeeklyAvailabilityFromGrid(){
      try{
        const day = document.getElementById('availabilityDay').value;
        if (!day){ alert('요일 선택'); return; }
        const container = document.getElementById('availabilityGrid');
        const checks = container.querySelectorAll('input[type="checkbox"]');
        if (!baseWeeklyAvailability[day]) baseWeeklyAvailability[day] = {};
        checks.forEach(chk=>{
          const room = chk.dataset.room; const ts = chk.dataset.timeslot;
          if (!baseWeeklyAvailability[day][room]) baseWeeklyAvailability[day][room] = {};
          baseWeeklyAvailability[day][room][ts] = !!chk.checked;
        });
        // 정기설정 + 하위호환용 weeklyAvailability 동시 저장
        await saveToFirebase('baseWeeklyAvailability', baseWeeklyAvailability);
        weeklyAvailability[day] = baseWeeklyAvailability[day];
        await saveToFirebase('weeklyAvailability', weeklyAvailability);
        renderCalendar();
        if (selectedDate) safeRender(renderClassrooms);
        alert(`${day}요일 정기설정 저장됨`);
      } catch(e){ console.error('saveWeeklyAvailabilityFromGrid 오류', e); alert('오류'); }
    }

    // 이전 기록
    function isLeapYear(y){ return ( (y%4===0 && y%100!==0) || (y%400===0) ); }
    function buildDayOptionsFor(year, month){
      const daySelect = document.getElementById('historyDay');
      daySelect.innerHTML = '<option value="">일 선택</option>';
      if(!year || !month) return;
      const y = parseInt(year,10), m = parseInt(month,10);
      if(isNaN(y) || isNaN(m)) return;
      const last = [31, (isLeapYear(y)?29:28),31,30,31,30,31,31,30,31,30,31][m-1];
      for(let d=1; d<=last; d++){
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d + '일';
        daySelect.appendChild(opt);
      }
    }

    function initializeYearSelect(){
      try{
        const select = document.getElementById('historyYear'); if (!select) return;
        const cy = new Date().getFullYear(); select.innerHTML = '<option value="">년도 선택</option>';
        for (let y=cy; y>=cy-5; y--){ const opt = document.createElement('option'); opt.value = y; opt.textContent = `${y}년`; select.appendChild(opt); }
        select.value = cy;
        const mon = document.getElementById('historyMonth'); if(mon) mon.value = new Date().getMonth()+1;
        buildDayOptionsFor(select.value, document.getElementById('historyMonth').value);
      } catch(e){ console.error('initializeYearSelect 오류', e); }
    }

    document.getElementById('historyYear').addEventListener('change', ()=>{ buildDayOptionsFor(document.getElementById('historyYear').value, document.getElementById('historyMonth').value); });
    document.getElementById('historyMonth').addEventListener('change', ()=>{ buildDayOptionsFor(document.getElementById('historyYear').value, document.getElementById('historyMonth').value); });

    // 이전기록 서브탭 전환
    window.switchHistorySubTab = function(tab) {
      const panels = { classroom: document.getElementById('histSubPanelClassroom'), chromebook: document.getElementById('histSubPanelChromebook') };
      const btns = { classroom: document.getElementById('histSubTabClassroom'), chromebook: document.getElementById('histSubTabChromebook') };
      const activeClassroom = 'px-4 py-2 text-sm font-bold rounded-t-lg bg-blue-600 text-white';
      const activeCb = 'px-4 py-2 text-sm font-bold rounded-t-lg bg-cyan-600 text-white';
      const inactive = 'px-4 py-2 text-sm font-bold rounded-t-lg bg-white text-gray-600 border border-gray-300';
      Object.keys(panels).forEach(k => {
        panels[k].classList.toggle('hidden', k !== tab);
        btns[k].className = k === tab ? (k === 'classroom' ? activeClassroom : activeCb) : inactive;
      });
    };

    // 이름 "8박준서" → "8-2-1 박준서" 형식으로 변환 (roster 매핑)
    function resolveHistoryName(rawName) {
      if (!rawName) return rawName;
      const norm2 = s => (s||'').normalize('NFC').trim();
      const allRoster = [...rosterMonWed, ...rosterTueThu];
      const gradeMatch = rawName.match(/^(\d)/);
      if (!gradeMatch) return rawName;
      const grade = gradeMatch[1];
      const namePart = norm2(rawName.slice(1));
      const found = allRoster.find(s => String(s.grade) === grade && norm2(s.name) === namePart);
      if (found) return `${found.grade}-${found.class||'?'}-${found.number} ${found.name}`;
      return rawName;
    }

    document.getElementById('viewHistoryBtn').addEventListener('click', ()=>{
      try{
        const year = document.getElementById('historyYear').value;
        const month = document.getElementById('historyMonth').value;
        const day = document.getElementById('historyDay').value;
        if (!year || !month || !day){ alert('년,월,일 선택'); return; }
        const dateKey = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const selected = new Date(year, month-1, day);
        const dow = getDayOfWeek(selected);

        // 서브탭 영역 표시
        document.getElementById('historySubTabs').classList.remove('hidden');
        document.getElementById('historyDateLabel').textContent = `📅 ${dateKey} (${dow}요일)`;
        window.switchHistorySubTab('classroom'); // 기본 탭

        // ── ① 강의실 신청 현황 ─────────────────────────────────────
        const container = document.getElementById('historyResultContainer');
        container.innerHTML = '';
        // bookings + archivedBookings 합산
        const results = {};
        const mergeBookings = (k, list) => {
          const inner = k.replace(dateKey+'-','');
          const parts = inner.split('-');
          const slot = parts[parts.length-1];
          const room = parts.slice(0, parts.length-1).join('-');
          if (!results[room]) results[room] = {};
          results[room][slot] = (results[room][slot]||[]).concat(list);
        };
        if (bookings) {
          Object.keys(bookings).forEach(k => {
            if (!k.startsWith(dateKey+'-')) return;
            let list = bookings[k]||[];
            if (!Array.isArray(list)) list = Object.values(list).filter(b=>b&&b.name);
            else list = list.filter(b=>b&&b.name);
            mergeBookings(k, list);
          });
        }
        if (archivedBookings && archivedBookings[dateKey]) {
          Object.keys(archivedBookings[dateKey]).forEach(origKey => {
            let list = archivedBookings[dateKey][origKey]||[];
            if (!Array.isArray(list)) list = Object.values(list).filter(b=>b&&b.name);
            else list = list.filter(b=>b&&b.name);
            mergeBookings(origKey, list);
          });
        }
        // 2026-10-22: 신청 기록이 없는 강의실은 숨기고, 신청 기록이 있으면 (목록에서
        // 삭제된 강의실이라도) 표시한다.
        const histRooms = [...(classrooms || []), ...Object.keys(results).filter(r => !(classrooms || []).includes(r))]
          .filter(r => results[r] && Object.values(results[r]).some(l => l && l.length > 0));

        // 교시별 카드를 3열 그리드로 배치
        const slotGrid = document.createElement('div');
        slotGrid.className = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4';

        timeSlots.forEach(ts => {
          const timeCard = document.createElement('div');
          timeCard.className = 'bg-white border rounded-lg p-4';

          const totalCount = histRooms.reduce((sum, room) =>
            sum + ((results[room]||{})[ts]||[]).length, 0);

          const hdr = document.createElement('div');
          hdr.className = 'flex justify-between items-center mb-3 pb-2 border-b';
          hdr.innerHTML = `<h4 class="font-bold text-lg text-blue-700">${ts}</h4><span class="text-sm bg-gray-100 px-2 py-1 rounded">${totalCount}명</span>`;
          timeCard.appendChild(hdr);

          histRooms.forEach(room => {
            const list = (results[room]||{})[ts]||[];
            const note = scheduleNotes[`${dow}-${room}-${ts}`]||'';

            const roomSec = document.createElement('div');
            roomSec.className = 'mb-3 pb-3 border-b last:border-b-0';

            const roomHdr = document.createElement('div');
            roomHdr.className = 'flex justify-between items-center mb-1';
            roomHdr.innerHTML = `<div class="font-medium text-sm">${room}</div><div class="text-xs bg-gray-100 px-2 py-0.5 rounded">${list.length}명</div>`;
            roomSec.appendChild(roomHdr);

            if (note) {
              const noteEl = document.createElement('div');
              noteEl.className = 'mb-1 text-xs bg-pink-50 text-pink-700 px-2 py-1 rounded';
              noteEl.textContent = `📌 ${note}`;
              roomSec.appendChild(noteEl);
            }

            if (list.length === 0) {
              const empty = document.createElement('div');
              empty.className = 'text-xs text-gray-300 text-center py-2';
              empty.textContent = '신청자 없음';
              roomSec.appendChild(empty);
            } else {
              // roster 기반 정렬
              const sorted = list.map((b, idx) => {
                const m = (b.name||'').match(/^(\d+)([가-힣]+)([A-Z]?)$/);
                let g=999,c=999,n=999;
                if (m) {
                  const f = [...rosterMonWed,...rosterTueThu].find(s=>String(s.grade)===m[1]&&s.name===m[2]);
                  if (f){g=parseInt(m[1])||999;c=parseInt(f.class)||999;n=parseInt(f.number)||999;}
                  else g=parseInt(m[1])||999;
                }
                return {...b,_origIdx:idx,_g:g,_c:c,_n:n};
              }).sort((a,b)=>a._g-b._g||a._c-b._c||a._n-b._n);

              const listWrap = document.createElement('div');
              listWrap.className = 'space-y-1';
              sorted.forEach(b => {
                const time = b.timestamp ? new Date(b.timestamp).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}) : '';
                const displayN = resolveHistoryName(b.name);
                let cbP = '';
                if (ts==='9교시'||ts==='10교시') {
                  const normN = s=>(s||'').normalize('NFC').trim();
                  const gM = (b.name||'').match(/^(\d)/);
                  if (gM) {
                    const f2 = [...rosterMonWed,...rosterTueThu].find(s=>String(s.grade)===gM[1]&&normN(s.name)===normN((b.name||'').slice(1)));
                    if (f2) {
                      // 2026-10-28: 위와 동일한 이유로 getCbClassKey/getCbStudentSid를 거쳐야 함(6학년 보정).
                      const ck2 = getCbClassKey(String(f2.grade), getCbStudentClass(f2));
                      const sid2 = getCbStudentSid(f2);
                      const cbD = chromebookBookings[dateKey]&&chromebookBookings[dateKey][ck2]&&chromebookBookings[dateKey][ck2][sid2];
                      if (cbD) cbP = ts==='9교시'?(cbD.purpose9||''):(cbD.purpose10||'');
                    }
                  }
                }
                const item = document.createElement('div');
                item.className = 'bg-gray-50 p-1.5 rounded text-xs';
                item.innerHTML = `<div class="flex items-center gap-1 flex-wrap"><span class="font-medium">${displayN}</span><span class="text-gray-400">${time}</span>${b.checked?'<span class="text-green-600">✓</span>':''}</div>${cbP?`<div class="text-cyan-600 mt-0.5">💻 ${cbP}</div>`:''}`;
                listWrap.appendChild(item);
              });
              roomSec.appendChild(listWrap);
            }
            timeCard.appendChild(roomSec);
          });
          slotGrid.appendChild(timeCard);
        });
        container.appendChild(slotGrid);

        // 인원체크 기록
        const dayAC_mw = (attendanceChecks && attendanceChecks[`${dateKey}_monwed`]) || {};
        const dayAC_tt = (attendanceChecks && attendanceChecks[`${dateKey}_tuethu`]) || {};
        const hasMW = Object.keys(dayAC_mw).length > 0;
        const hasTT = Object.keys(dayAC_tt).length > 0;
        const defaultHistTab = (dow === '화' || dow === '목') ? 'tuethu' : 'monwed';
        const histTabUsed = hasTT ? 'tuethu' : hasMW ? 'monwed' : defaultHistTab;
        const dayAC = histTabUsed === 'tuethu' ? dayAC_tt : dayAC_mw;
        const hasAnyAC = Object.keys(dayAC).length > 0;
        const histRoster = histTabUsed === 'tuethu' ? rosterTueThu : rosterMonWed;
        const rosterLabel = histTabUsed === 'tuethu' ? '화·목' : '월·수';
        if (!hasAnyAC) {
          container.innerHTML += `<div class="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-3 text-sm text-gray-400">📋 해당 날짜의 인원체크 기록이 없습니다.</div>`;
        } else if (histRoster && histRoster.length > 0) {
          const tagFn = (color, bg, border) => s => `<span class="px-2 py-0.5 ${bg} ${color} rounded text-xs border ${border}">${s.grade}-${s.class||'?'}-${s.number} ${s.name}</span>`;
          const tagGreen = tagFn('text-green-700','bg-green-50','border-green-200');
          const tagRed   = tagFn('text-red-500','bg-red-50','border-red-100');
          const e1Checked   = histRoster.filter(s => dayAC[`${s.grade}_${s.name}_e1`] === true);
          const e1Unchecked = histRoster.filter(s => dayAC[`${s.grade}_${s.name}_e1`] !== true);
          const e2Checked   = histRoster.filter(s => dayAC[`${s.grade}_${s.name}_e2`] === true);
          const e2Unchecked = histRoster.filter(s => dayAC[`${s.grade}_${s.name}_e2`] !== true);
          container.innerHTML += `<div class="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-3">
            <h5 class="font-bold text-purple-800 mb-3">📋 인원체크 기록 (${rosterLabel} 명단 / 전체 ${histRoster.length}명)</h5>
            <div class="grid grid-cols-2 gap-4">
              <div><div class="text-sm font-bold text-blue-600 mb-2">저녁1교시 — ${e1Checked.length}명 체크</div>
                ${e1Checked.length>0?`<div class="mb-1"><div class="text-xs text-green-600 font-medium mb-1">체크</div><div class="flex flex-wrap gap-1">${e1Checked.map(tagGreen).join('')}</div></div>`:''}
                ${e1Unchecked.length>0?`<div><div class="text-xs text-red-500 font-medium mb-1">미체크</div><div class="flex flex-wrap gap-1">${e1Unchecked.map(tagRed).join('')}</div></div>`:'<div class="text-xs text-green-600">✅ 전원 체크</div>'}
              </div>
              <div><div class="text-sm font-bold text-green-600 mb-2">저녁2교시 — ${e2Checked.length}명 체크</div>
                ${e2Checked.length>0?`<div class="mb-1"><div class="text-xs text-green-600 font-medium mb-1">체크</div><div class="flex flex-wrap gap-1">${e2Checked.map(tagGreen).join('')}</div></div>`:''}
                ${e2Unchecked.length>0?`<div><div class="text-xs text-red-500 font-medium mb-1">미체크</div><div class="flex flex-wrap gap-1">${e2Unchecked.map(tagRed).join('')}</div></div>`:'<div class="text-xs text-green-600">✅ 전원 체크</div>'}
              </div>
            </div></div>`;
        } else {
          const checkedList = Object.keys(dayAC).filter(k=>dayAC[k]===true).map(k=>{const p=k.split('_');return p.length>=2?`${p[0]}학년 ${p.slice(1).join('')}`:k;}).sort();
          container.innerHTML += `<div class="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-3"><h5 class="font-bold mb-2 text-purple-800">📋 인원체크 기록 (명단 없음)</h5><div class="flex flex-wrap gap-1">${checkedList.map(n=>`<span class="px-2 py-0.5 bg-green-50 text-green-700 rounded text-xs border border-green-200">${n}</span>`).join('')}</div></div>`;
        }

        // ── ② 크롬북 신청 현황 ────────────────────────────────────
        const cbContainer = document.getElementById('historyChromebookContainer');
        cbContainer.innerHTML = '';
        const cbTodayData = (chromebookBookings && chromebookBookings[dateKey]) || {};
        const normH = s => (s||'').normalize('NFC').trim();

        // 해당 날짜 강의실 신청자 이름 세트
        const histClassroomBooked = { '9교시': new Set(), '10교시': new Set() };
        ['9교시','10교시'].forEach(sl => {
          (classrooms||[]).forEach(room => {
            const k = `${dateKey}-${room}-${sl}`;
            let list = bookings[k] || [];
            if(!Array.isArray(list)) list = Object.values(list).filter(b=>b&&b.name);
            else list = list.filter(b=>b&&b.name);
            list.forEach(b => histClassroomBooked[sl].add(normH(b.name)));
            if (archivedBookings && archivedBookings[dateKey]) {
              const ak = `${dateKey}-${room}-${sl}`;
              let al = (archivedBookings[dateKey][ak]) || [];
              if(!Array.isArray(al)) al = Object.values(al).filter(b=>b&&b.name);
              else al = al.filter(b=>b&&b.name);
              al.forEach(b => histClassroomBooked[sl].add(normH(b.name)));
            }
          });
        });

        ['9교시','10교시'].forEach(slot => {
          const slotCard = document.createElement('div');
          slotCard.className = 'mb-6 bg-white border rounded-lg p-4';
          slotCard.innerHTML = `<h4 class="font-bold text-lg text-cyan-700 mb-4">💻 ${slot} 크롬북 신청 현황</h4>`;

          // 반별 컬럼
          const classGrid = document.createElement('div');
          classGrid.className = 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 items-start';
          CB_CLASSES.forEach(c => {
            const classKey = getCbClassKey(c.grade, c.cls);
            const classData = cbTodayData[classKey] || {};
            const students = getCbClassStudents(c.grade, c.cls);
            const col = document.createElement('div');
            col.className = 'border border-cyan-200 rounded-lg overflow-hidden';
            col.innerHTML = `<div class="bg-cyan-500 text-white text-center font-bold py-2 text-sm">${c.label}</div>`;
            const colBody = document.createElement('div');
            colBody.className = 'p-2 space-y-1';

            // 반납기간 학생 표시 (현재 활성 + 아카이브 통합)
            const retActive = chromebookReturnPeriod[classKey] || {};
            const retArchive = chromebookReturnPeriodArchive[classKey] || {};
            const retAll = { ...retArchive, ...retActive }; // 활성이 아카이브보다 우선
            const retStudents = students.filter(s => {
              const sid = getCbStudentSid(s);
              return !!retAll[sid];
            });
            if (retStudents.length > 0) {
              const retSec = document.createElement('div');
              retSec.className = 'mb-1 pb-1 border-b border-orange-200';
              retStudents.forEach(s => {
                const sid = getCbStudentSid(s);
                const period = retAll[sid];
                const isActive = !!retActive[sid];
                const rItem = document.createElement('div');
                rItem.className = `bg-orange-50 border border-orange-200 rounded px-2 py-1 text-xs mb-1`;
                rItem.innerHTML = `<div class="font-medium text-gray-700">${s.grade}-${s.class||'?'}-${s.number} ${s.name}</div><div class="${isActive ? 'text-orange-600' : 'text-gray-400'} font-bold">🚫 반납${isActive ? '' : '(이력)'}: ${period}</div>`;
                retSec.appendChild(rItem);
              });
              colBody.appendChild(retSec);
            }

            let hasAnyC = false;
            students.forEach(s => {
              const sid = getCbStudentSid(s);
              const data = classData[sid];
              if (!data) return;
              const hasSlot = slot==='9교시' ? !!data.purpose9 : !!data.purpose10;
              if (!hasSlot) return;
              const appName = normH(`${s.grade}${s.name}`);
              if (histClassroomBooked[slot].has(appName)) return;
              hasAnyC = true;
              const purpose = slot==='9교시' ? data.purpose9 : data.purpose10;
              const item = document.createElement('div');
              item.className = 'bg-cyan-50 rounded px-2 py-1 text-xs';
              item.innerHTML = `<div class="font-medium text-gray-800">${s.grade}-${s.class||'?'}-${s.number} ${s.name}</div>${purpose?`<div class="text-cyan-600 mt-0.5">${purpose}</div>`:''}`;
              colBody.appendChild(item);
            });
            if (!hasAnyC) { const e=document.createElement('div'); e.className='text-xs text-gray-300 text-center py-3'; e.textContent='없음'; colBody.appendChild(e); }
            col.appendChild(colBody);
            classGrid.appendChild(col);
          });
          slotCard.appendChild(classGrid);

          // 강의실+크롬북 동시 신청
          const crossStudents2 = [];
          CB_CLASSES.forEach(c => {
            const classKey = getCbClassKey(c.grade, c.cls);
            const classData = cbTodayData[classKey] || {};
            getCbClassStudents(c.grade, c.cls).forEach(s => {
              const sid = getCbStudentSid(s);
              const data = classData[sid];
              if (!data) return;
              if (!(slot==='9교시' ? !!data.purpose9 : !!data.purpose10)) return;
              if (histClassroomBooked[slot].has(normH(`${s.grade}${s.name}`))) crossStudents2.push({s,data,c});
            });
          });
          crossStudents2.sort((a,b)=>Number(a.s.grade)-Number(b.s.grade)||Number(a.s.class||0)-Number(b.s.class||0)||Number(a.s.number||0)-Number(b.s.number||0));

          const crossDiv2 = document.createElement('div');
          crossDiv2.className = 'mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg';
          crossDiv2.innerHTML = `<div class="text-xs font-bold text-blue-700 mb-2">🏫 강의실+크롬북 동시 신청</div>`;
          const crossGrid2 = document.createElement('div');
          crossGrid2.className = 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 items-start';
          CB_CLASSES.forEach(c => {
            const members = crossStudents2.filter(x=>String(x.s.grade)===c.grade&&(c.cls==='0'?true:String(x.s.class||'0')===c.cls));
            const col2 = document.createElement('div');
            col2.className = 'border border-blue-300 rounded-lg overflow-hidden';
            col2.innerHTML = `<div class="bg-blue-400 text-white text-center font-bold py-1.5 text-xs">${c.label}</div>`;
            const body2 = document.createElement('div'); body2.className='p-2 space-y-1 bg-white';
            if (!members.length) { const e=document.createElement('div');e.className='text-center text-gray-300 text-xs py-3';e.textContent='없음';body2.appendChild(e); }
            else members.forEach(({s,data})=>{
              const purpose=slot==='9교시'?data.purpose9:data.purpose10;
              const item=document.createElement('div');item.className='bg-blue-50 rounded px-2 py-1 text-xs';
              item.innerHTML=`<div class="font-medium text-gray-800">${s.grade}-${s.class||'?'}-${s.number} ${s.name}</div>${purpose?`<div class="text-cyan-600 mt-0.5">${purpose}</div>`:''}`;
              body2.appendChild(item);
            });
            col2.appendChild(body2); crossGrid2.appendChild(col2);
          });
          crossDiv2.appendChild(crossGrid2);
          slotCard.appendChild(crossDiv2);
          cbContainer.appendChild(slotCard);
        });

        if (!Object.keys(cbTodayData).length) {
          cbContainer.innerHTML = `<div class="text-center text-gray-400 py-10">해당 날짜에 크롬북 신청 기록이 없습니다.</div>`;
        }

      } catch(e){ console.error('viewHistoryBtn 오류', e); alert('조회 중 오류'); }
    });

    // 이벤트 바인딩
    document.getElementById('adminToggleBtn').addEventListener('click', ()=>{
      const form = document.getElementById('adminLoginForm');
      const view = document.getElementById('userView');
      const willShow = form.classList.contains('hidden'); // 지금 숨겨져 있으면 곧 보여줄 것
      form.classList.toggle('hidden');
      if (willShow) { view.classList.add('hidden'); }
      else { view.classList.remove('hidden'); }
    });

    document.getElementById('loginBtn').addEventListener('click', ()=>{
      try{
        if (document.getElementById('adminId').value==='admin' && document.getElementById('adminPassword').value===adminPassword){
          isAdminLoggedIn = true;
          try { sessionStorage.setItem('hannah:isAdminLoggedIn', '1'); } catch(e){}
          // 청소 당번표(cleaning_duty_3.html)가 같은 브라우저에서 이 로그인을 그대로 인정하고
          // 비밀번호를 다시 묻지 않도록, 로그인 시각을 localStorage에 남겨둔다(탭이 달라도 공유됨).
          try { localStorage.setItem('hannah:schoolAdminUnlockedAt', String(Date.now())); } catch(e){}
          document.getElementById('adminLoginForm').classList.add('hidden');
          document.getElementById('adminDashboard').classList.remove('hidden');
          document.getElementById('adminToggleBtn').classList.add('hidden');
          document.getElementById('logoutBtn').classList.remove('hidden');
          // 관리자 대시보드 안에 이미 "성경읽기" 관리 탭이 있어서 헤더의 학생용 성경읽기
          // 바로가기는 중복이므로 관리자 모드에서는 숨긴다.
          document.getElementById('biblePageBtn').classList.add('hidden');
          document.getElementById('userView').classList.add('hidden');
          document.getElementById('adminId').value=''; document.getElementById('adminPassword').value='';
          renderAvailabilityGrid(); renderScheduleNotesList(); initializeYearSelect(); refreshAdminClassroomList(); populateNoteClassroomSelect();
          document.getElementById('todayBookingsPanel').classList.remove('hidden');
          renderTodayBookings();
        } else alert('아이디 또는 비밀번호가 맞지 않습니다.');
      } catch(e){ console.error('loginBtn 오류', e); }
    });

    document.getElementById('logoutBtn').addEventListener('click', ()=>{
      isAdminLoggedIn = false;
      try { sessionStorage.removeItem('hannah:isAdminLoggedIn'); sessionStorage.removeItem('hannah:adminLastPanel'); sessionStorage.removeItem('hannah:adminLastCbClass'); } catch(e){}
      // 로그아웃하면 청소 당번표 쪽의 자동 로그인도 함께 해제한다.
      try { localStorage.removeItem('hannah:schoolAdminUnlockedAt'); } catch(e){}
      document.getElementById('adminDashboard').classList.add('hidden');
      document.getElementById('adminToggleBtn').classList.remove('hidden');
      document.getElementById('logoutBtn').classList.add('hidden');
      document.getElementById('biblePageBtn').classList.remove('hidden');
      document.getElementById('userView').classList.remove('hidden');
      const idEl = document.getElementById('adminId'); const pwdEl = document.getElementById('adminPassword');
      if (idEl) idEl.value = ''; if (pwdEl) pwdEl.value = '';
      document.getElementById('adminLoginForm') && document.getElementById('adminLoginForm').classList.add('hidden');
      // 달력이 관리자 대시보드에 가려져 있던 동안(숨김 상태)에는 높이를 잴 수 없어 청소 당번
      // 패널과 맞추는 계산을 건너뛰었을 수 있으므로, 다시 보이게 된 지금 한 번 새로 맞춘다.
      renderCalendar();
      if (selectedDate) safeRender(renderClassrooms);
    });

    document.getElementById('prevMonth').addEventListener('click', ()=>{ currentDate.setMonth(currentDate.getMonth()-1); normalizeCurrentDate(); renderCalendar(); });
    document.getElementById('nextMonth').addEventListener('click', ()=>{ currentDate.setMonth(currentDate.getMonth()+1); normalizeCurrentDate(); renderCalendar(); });

    document.getElementById('availabilityDay').addEventListener('change', renderAvailabilityGrid);
    document.getElementById('loadAvailabilityBtn').addEventListener('click', renderAvailabilityGrid);

    // IME 호환 패치
    (function setupUserNameImeCompatibility(){
      let composingUserName = false;
      let userNameRenderTimer = null;
      const USER_RENDER_DEBOUNCE_MS = 150;

      const userNameEl = document.getElementById('userName');
      if (!userNameEl) return;

      userNameEl.addEventListener('compositionstart', () => {
        composingUserName = true;
        if (userNameRenderTimer) { clearTimeout(userNameRenderTimer); userNameRenderTimer = null; }
      });

      userNameEl.addEventListener('compositionend', () => {
        composingUserName = false;
        if (selectedDate) safeRender(renderClassrooms);
        if (activeUserTab === 'chromebook' && !cbAuthVerified) safeRender(renderUserChromebookPanel);
      });

      userNameEl.addEventListener('input', () => {
        const e = document.getElementById('nameError');
        if (e) { e.classList.add('hidden'); e.textContent = ''; }
        // 소문자 알파벳 suffix → 대문자 자동 변환
        if (!composingUserName) {
          const cur = userNameEl.value;
          const up  = cur.replace(/([가-힣])([a-z])$/, (_,h,a) => h+a.toUpperCase());
          if (up !== cur) { const pos=userNameEl.selectionStart; userNameEl.value=up; userNameEl.setSelectionRange(pos,pos); }
        }
        if (composingUserName) return;
        if (userNameRenderTimer) clearTimeout(userNameRenderTimer);
        userNameRenderTimer = setTimeout(() => {
          userNameRenderTimer = null;
          if (selectedDate) safeRender(renderClassrooms);
          // 크롬북 탭: 인증 완료 상태면 재렌더 안 함 (입력 중 방해 금지)
          if (activeUserTab === 'chromebook' && !cbAuthVerified) safeRender(renderUserChromebookPanel);
        }, USER_RENDER_DEBOUNCE_MS);
      });
    })();

    (function bindAdminButtons(){
      const map = [
        { btn: 'passwordChangeBtn', panel: 'passwordChangePanel' },
        { btn: 'attendanceBtn',     panel: 'attendancePanel' },
        { btn: 'timeSettingsBtn',   panel: 'timeSettingsPanel' },
        { btn: 'addClassroomBtn',   panel: 'addClassroomPanel' },
        { btn: 'scheduleNotesBtn',  panel: 'scheduleNotesPanel' },
        { btn: 'availabilityBtn',   panel: 'availabilityPanel' },
        { btn: 'chromebookBtn',     panel: 'chromebookPanel' },
        { btn: 'historyBtn',        panel: 'historyPanel' },
        { btn: 'todayBookingsBtn',  panel: 'todayBookingsPanel' },
        { btn: 'bibleAdminBtn',     panel: 'bibleAdminPanel' }
      ];
      map.forEach(({btn, panel})=>{
        const b = document.getElementById(btn); const p = document.getElementById(panel);
        if (!b || !p) return;
        b.addEventListener('click', ()=>{
          map.forEach(m=>{ const o = document.getElementById(m.panel); if (o && m.panel !== panel) o.classList.add('hidden'); });
          p.classList.toggle('hidden');
          const isNowOpen = !p.classList.contains('hidden');
          try {
            if (isNowOpen) sessionStorage.setItem('hannah:adminLastPanel', panel);
            else sessionStorage.removeItem('hannah:adminLastPanel');
          } catch(e){}
          if (panel === 'availabilityPanel') renderAvailabilityGrid();
          if (panel === 'scheduleNotesPanel'){ renderScheduleNotesList(); populateNoteClassroomSelect(); }
          if (panel === 'attendancePanel') safeRender(renderAttendancePanel);
          if (panel === 'todayBookingsPanel'){ p.classList.remove('hidden'); renderTodayBookings(); }
          if (panel === 'addClassroomPanel') refreshAdminClassroomList();
          if (panel === 'chromebookPanel') safeRender(renderChromebookPanel);
          if (panel === 'bibleAdminPanel') safeRender(renderBibleAdminPanel);
        });
      });
    })();

    // 관리자 세션 복원 시 마지막으로 열려있던 패널을 다시 여는 함수
    function restoreAdminLastPanel(){
      try {
        const lastPanel = sessionStorage.getItem('hannah:adminLastPanel');
        if (!lastPanel) return;
        const p = document.getElementById(lastPanel);
        if (!p) return;
        p.classList.remove('hidden');
        if (lastPanel === 'availabilityPanel') renderAvailabilityGrid();
        if (lastPanel === 'scheduleNotesPanel'){ renderScheduleNotesList(); populateNoteClassroomSelect(); }
        if (lastPanel === 'attendancePanel') safeRender(renderAttendancePanel);
        if (lastPanel === 'todayBookingsPanel') renderTodayBookings();
        if (lastPanel === 'addClassroomPanel') refreshAdminClassroomList();
        if (lastPanel === 'chromebookPanel') {
          safeRender(renderChromebookPanel);
          // 선택했던 반도 함께 복원
          try {
            const lastCb = JSON.parse(sessionStorage.getItem('hannah:adminLastCbClass') || 'null');
            if (lastCb) { activeChromebookClass = lastCb; safeRender(renderChromebookPanel); }
          } catch(e){}
        }
        if (lastPanel === 'bibleAdminPanel') safeRender(renderBibleAdminPanel);
      } catch(e){ console.error('restoreAdminLastPanel 오류', e); }
    }

    function populateNoteClassroomSelect(){
      try{
        const sel = document.getElementById('noteClassroom');
        if (!sel) return;
        sel.innerHTML = '<option value="">강의실 선택</option>';
        (classrooms || []).forEach(c=>{
          const opt = document.createElement('option'); opt.value = c; opt.textContent = c; sel.appendChild(opt);
        });
      } catch(e){ console.error('populateNoteClassroomSelect 오류', e); }
    }

    function refreshAdminClassroomList(){
      try{
        const listEl = document.getElementById('classroomList');
        if (!listEl) return;
        listEl.innerHTML = '';
        (classrooms || []).forEach(c=>{
          const row = document.createElement('div'); row.className='flex justify-between items-center bg-green-50 p-2 rounded';
          const span = document.createElement('span'); span.className='small'; span.textContent = c;
          const btn = document.createElement('button'); btn.className='px-2 py-1 bg-red-500 text-white text-xs rounded'; btn.textContent='삭제';
          btn.addEventListener('click', async ()=>{
            if (!confirm(`${c} 강의실을 삭제할까요?`)) return;
            classrooms = (classrooms || []).filter(x=>x!==c);
            await saveToFirebase('classrooms', classrooms);
            renderCalendar(); renderAvailabilityGrid(); populateNoteClassroomSelect(); row.remove();
          });
          row.appendChild(span); row.appendChild(btn); listEl.appendChild(row);
        });
      } catch(e){ console.error('refreshAdminClassroomList 오류', e); }
    }

    function safeRender(fn){ try{ if (typeof fn === 'function') fn(); } catch(e){ console.error('safeRender 오류', e); } }

    async function _ensureLoadedAndRender(){
      // 달력은 Firebase 완료 전에 즉시 먼저 그림
      try { normalizeCurrentDate(); renderCalendar(); } catch(e) { console.error('renderCalendar 초기 오류', e); }
      try{
        await ensureAnonAuth();
        await loadFromFirebase();
        // 2026-10-19: 학년 교실 5개를 "딱 한 번만" 강의실 목록에 추가한다(gradeRoomsSeeded 플래그).
        // 그 이후로는 일반 강의실과 동일하게 관리자가 자유롭게 삭제할 수 있고, 삭제된 상태가
        // 그대로 유지된다(이 코드가 다시 끼워 넣지 않음).
        if (!gradeRoomsSeeded) {
          try {
            if (!Array.isArray(classrooms)) classrooms = [];
            NEW_THU_CLASSROOMS.forEach(name => {
              if (!classrooms.includes(name)) classrooms.push(name);
            });
            await saveToFirebase('classrooms', classrooms);
            gradeRoomsSeeded = true;
            await saveToFirebase('gradeRoomsSeeded', true);
          } catch(e) { console.error('학년 교실 추가 오류', e); }
        }
        setupFirebaseListeners();
        normalizeCurrentDate();
        if (!selectedDate) selectedDate = new Date();
        window.bookingTimes = bookingTimes;
        await archivePastBookingsOnLoad();
        renderCalendar(); renderClassrooms(); populateNoteClassroomSelect(); refreshAdminClassroomList(); initializeYearSelect();

        // 새로고침 시 관리자 로그인 상태 복원 (세션 유지 - 탭 닫으면 자동 해제)
        try {
          if (sessionStorage.getItem('hannah:isAdminLoggedIn') === '1') {
            isAdminLoggedIn = true;
            try { localStorage.setItem('hannah:schoolAdminUnlockedAt', String(Date.now())); } catch(e){}
            document.getElementById('adminLoginForm').classList.add('hidden');
            document.getElementById('adminDashboard').classList.remove('hidden');
            document.getElementById('adminToggleBtn').classList.add('hidden');
            document.getElementById('logoutBtn').classList.remove('hidden');
            document.getElementById('biblePageBtn').classList.add('hidden');
            document.getElementById('userView').classList.add('hidden');
            renderAvailabilityGrid(); renderScheduleNotesList(); initializeYearSelect(); refreshAdminClassroomList(); populateNoteClassroomSelect();
            // 마지막으로 열려있던 패널 복원 (없으면 금일 신청현황 기본 표시)
            const hadLastPanel = (function(){ try { return !!sessionStorage.getItem('hannah:adminLastPanel'); } catch(e){ return false; } })();
            if (hadLastPanel) {
              restoreAdminLastPanel();
            } else {
              document.getElementById('todayBookingsPanel').classList.remove('hidden');
              renderTodayBookings();
            }
          } else {
            // 담임교사 신고(2026-09-22): "메인화면에서 청소당번표를 클릭하면 오늘의 청소만
            // 나와야 하는데 공통·각 학급 탭까지 다 나온다" — 이 페이지(index.html)는 로그인
            // 상태를 새 탭/새 창을 열면 초기화되는 sessionStorage로 관리하는데(주석대로 "탭
            // 닫으면 자동 해제"), 청소 당번표(cleaning_duty_3.html)와 공유하는 로그인 신호는
            // localStorage(schoolAdminUnlockedAt)라서 최대 12시간 동안 브라우저에 남아있었다.
            // 그래서 예전에 로그아웃 버튼을 누르지 않고 그냥 탭만 닫았던 경우, 이 메인화면은
            // (세션스토리지가 초기화되어) 정상적으로 "로그아웃 상태"로 보이지만, 청소
            // 당번표는 남아있던 localStorage 신호를 그대로 보고 계속 관리자 모드로 열렸다.
            // 이 페이지가 "로그인 안 됨"으로 판단할 때마다 공유 신호도 함께 지워서, 두
            // 화면의 로그인 상태가 항상 같이 맞도록 한다.
            try { localStorage.removeItem('hannah:schoolAdminUnlockedAt'); } catch(e){}
          }
        } catch(e){ console.error('관리자 세션 복원 오류', e); }
      } catch(e){ console.error('초기화 오류', e); }
    }

    // ── 인원체크 엑셀 업로드 ──────────────────────────────────────────
    document.getElementById('rosterFileInput').addEventListener('change', async (e) => {
      try {
        const file = e.target.files[0];
        if (!file) return;
        const statusEl = document.getElementById('rosterStatus');
        statusEl.textContent = '파일 읽는 중...';

        window.XLSX ??= await import('xlsx');

        const buf  = await file.arrayBuffer();
        const wb   = window.XLSX.read(buf, { type: 'array' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

        const newRoster = [];
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const grade  = String(row[0] || '').trim();
          const cls    = String(row[1] || '').trim();
          const number = String(row[2] || '').trim();
          const name   = String(row[3] || '').trim();
          if (!grade || !name) continue;
          newRoster.push({ grade, class: cls, number, name });
        }

        if (newRoster.length === 0) {
          statusEl.textContent = '❌ 유효한 데이터가 없습니다. 열 순서(학년·반·번호·이름)를 확인해주세요.';
          return;
        }

        // 현재 활성 탭에 따라 저장
        const tab = activeRosterTab || getDefaultTab();
        const fbKey = tab === 'tuethu' ? 'rosterTueThu' : 'rosterMonWed';
        const tabLabel = tab === 'tuethu' ? '화·목' : '월·수';
        if (tab === 'tuethu') rosterTueThu = newRoster;
        else rosterMonWed = newRoster;
        await saveToFirebase(fbKey, newRoster);
        statusEl.textContent = `✅ ${tabLabel} 명단 ${newRoster.length}명 업로드 완료`;

        // ── 동명이인 검사 ──────────────────────────────────────────────
        // (1) 다른 학년 간 동일 이름: 성경읽기는 학년 구분 없이 이름만으로 저장되어 데이터가 섞일 위험
        // (2) 같은 학년 내 완전히 동일한 이름(구분 접미사 없음): 강의실·크롬북·성경읽기 모두 이름으로 학생을 찾으므로 혼선 위험
        try {
          const combined = [...rosterMonWed, ...rosterTueThu];
          const nameToGrades = {};
          const nameGradeCount = {}; // `${name}_${grade}` -> count
          combined.forEach(s => {
            const nm = String(s.name || '').trim();
            const gd = String(s.grade || '').trim();
            if (!nm || !gd) return;
            if (!nameToGrades[nm]) nameToGrades[nm] = new Set();
            nameToGrades[nm].add(gd);
            const key = `${nm}_${gd}`;
            nameGradeCount[key] = (nameGradeCount[key] || 0) + 1;
          });

          const crossGradeDup = Object.entries(nameToGrades)
            .filter(([nm, grades]) => grades.size > 1)
            .map(([nm, grades]) => `${nm} (${[...grades].sort().join('학년, ')}학년)`);

          const sameGradeDup = Object.entries(nameGradeCount)
            .filter(([key, count]) => count > 1)
            .map(([key]) => { const [nm, gd] = key.split('_'); return `${nm} (${gd}학년, ${nameGradeCount[key]}명)`; });

          let warnMsg = '';
          if (crossGradeDup.length > 0) {
            warnMsg += `⚠️ 다른 학년에 같은 이름의 학생:\n${crossGradeDup.join('\n')}\n` +
              `→ 성경읽기는 학년 구분 없이 이름만으로 저장되어 진도가 서로 섞일 수 있습니다.\n\n`;
          }
          if (sameGradeDup.length > 0) {
            warnMsg += `⚠️ 같은 학년 내 완전히 동일한 이름(구분 표시 없음):\n${sameGradeDup.join('\n')}\n` +
              `→ 강의실·크롬북·성경읽기 신청 시 학생을 이름으로 구분하지 못할 수 있습니다.\n\n`;
          }
          if (warnMsg) {
            alert(warnMsg + `엑셀 명단에서 이름 뒤에 알파벳(A, B 등)을 붙여 구분해주세요. (예: 전예준A, 전예준B)`);
          }
        } catch(dupErr) { console.error('동명이인 검사 오류', dupErr); }
        // ──────────────────────────────────────────────────────────────

        safeRender(renderAttendancePanel);
        e.target.value = '';
      } catch(err) {
        console.error('엑셀 업로드 오류', err);
        document.getElementById('rosterStatus').textContent = '❌ 파일 읽기 오류. xlsx 형식인지 확인해주세요.';
      }
    });

    document.getElementById('clearRosterBtn').addEventListener('click', async () => {
      const tab = activeRosterTab || getDefaultTab();
      const tabLabel = tab === 'tuethu' ? '화·목' : '월·수';
      if (!confirm(`${tabLabel} 명단을 초기화할까요?`)) return;
      const fbKey = tab === 'tuethu' ? 'rosterTueThu' : 'rosterMonWed';
      if (tab === 'tuethu') rosterTueThu = [];
      else rosterMonWed = [];
      await saveToFirebase(fbKey, []);
      document.getElementById('rosterStatus').textContent = `${tabLabel} 명단이 초기화되었습니다.`;
      safeRender(renderAttendancePanel);
    });
    // ──────────────────────────────────────────────────────────────────

    // ══ 성경 66권 데이터 ════════════════════════════════════════════════
    const BIBLE_BOOKS = [
      // 구약 39권
      {name:'창세기',ch:50,t:'OT'},{name:'출애굽기',ch:40,t:'OT'},{name:'레위기',ch:27,t:'OT'},
      {name:'민수기',ch:36,t:'OT'},{name:'신명기',ch:34,t:'OT'},{name:'여호수아',ch:24,t:'OT'},
      {name:'사사기',ch:21,t:'OT'},{name:'룻기',ch:4,t:'OT'},{name:'사무엘상',ch:31,t:'OT'},
      {name:'사무엘하',ch:24,t:'OT'},{name:'열왕기상',ch:22,t:'OT'},{name:'열왕기하',ch:25,t:'OT'},
      {name:'역대상',ch:29,t:'OT'},{name:'역대하',ch:36,t:'OT'},{name:'에스라',ch:10,t:'OT'},
      {name:'느헤미야',ch:13,t:'OT'},{name:'에스더',ch:10,t:'OT'},{name:'욥기',ch:42,t:'OT'},
      {name:'시편',ch:150,t:'OT'},{name:'잠언',ch:31,t:'OT'},{name:'전도서',ch:12,t:'OT'},
      {name:'아가',ch:8,t:'OT'},{name:'이사야',ch:66,t:'OT'},{name:'예레미야',ch:52,t:'OT'},
      {name:'예레미야애가',ch:5,t:'OT'},{name:'에스겔',ch:48,t:'OT'},{name:'다니엘',ch:12,t:'OT'},
      {name:'호세아',ch:14,t:'OT'},{name:'요엘',ch:3,t:'OT'},{name:'아모스',ch:9,t:'OT'},
      {name:'오바댜',ch:1,t:'OT'},{name:'요나',ch:4,t:'OT'},{name:'미가',ch:7,t:'OT'},
      {name:'나훔',ch:3,t:'OT'},{name:'하박국',ch:3,t:'OT'},{name:'스바냐',ch:3,t:'OT'},
      {name:'학개',ch:2,t:'OT'},{name:'스가랴',ch:14,t:'OT'},{name:'말라기',ch:4,t:'OT'},
      // 신약 27권
      {name:'마태복음',ch:28,t:'NT'},{name:'마가복음',ch:16,t:'NT'},{name:'누가복음',ch:24,t:'NT'},
      {name:'요한복음',ch:21,t:'NT'},{name:'사도행전',ch:28,t:'NT'},{name:'로마서',ch:16,t:'NT'},
      {name:'고린도전서',ch:16,t:'NT'},{name:'고린도후서',ch:13,t:'NT'},{name:'갈라디아서',ch:6,t:'NT'},
      {name:'에베소서',ch:6,t:'NT'},{name:'빌립보서',ch:4,t:'NT'},{name:'골로새서',ch:4,t:'NT'},
      {name:'데살로니가전서',ch:5,t:'NT'},{name:'데살로니가후서',ch:3,t:'NT'},{name:'디모데전서',ch:6,t:'NT'},
      {name:'디모데후서',ch:4,t:'NT'},{name:'디도서',ch:3,t:'NT'},{name:'빌레몬서',ch:1,t:'NT'},
      {name:'히브리서',ch:13,t:'NT'},{name:'야고보서',ch:5,t:'NT'},{name:'베드로전서',ch:5,t:'NT'},
      {name:'베드로후서',ch:3,t:'NT'},{name:'요한일서',ch:5,t:'NT'},{name:'요한이서',ch:1,t:'NT'},
      {name:'요한삼서',ch:1,t:'NT'},{name:'유다서',ch:1,t:'NT'},{name:'요한계시록',ch:22,t:'NT'},
    ];

    // ══ 성경읽기 상태 변수 ═══════════════════════════════════════════════
    let bibleReading = {};       // Firebase: { userName: { password, books: {idx: {ch: true}} } }
    let bibleCurrentUser = null; // 현재 로그인한 사용자
    let bibleLocalData = {};     // 로컬에서 편집 중인 체크 데이터 { bookIdx: { chapterNum: "YYYY-MM-DD" } }
    let bibleCurrentTab = 'OT';  // 현재 탭 OT/NT
    let expandedBook = null;     // 펼쳐진 책 인덱스

    // Firebase 리스너
    onValue(ref(database,'bibleReading'), (snap) => {
      bibleReading = snap.val() || {};
      if (isAdminLoggedIn) safeRender(renderBibleAdminPanel);
    });

    // ══ 성경읽기 페이지 전환 ═════════════════════════════════════════════
    const mainApp = document.querySelector('.max-w-7xl');
    document.getElementById('biblePageBtn').addEventListener('click', () => {
      mainApp.classList.add('hidden');
      document.getElementById('biblePage').classList.remove('hidden');
      document.getElementById('bibleLoginForm').classList.remove('hidden');
      document.getElementById('bibleDashboard').classList.add('hidden');
      document.getElementById('bibleUserName').value = '';
      document.getElementById('biblePassword').value = '';
      document.getElementById('bibleLoginError').classList.add('hidden');
    });
    document.getElementById('bibleBackBtn').addEventListener('click', () => {
      document.getElementById('biblePage').classList.add('hidden');
      mainApp.classList.remove('hidden');
      bibleCurrentUser = null;
    });
    document.getElementById('bibleLogoutBtn').addEventListener('click', () => {
      bibleCurrentUser = null;
      bibleLocalData = {};
      document.getElementById('bibleDashboard').classList.add('hidden');
      document.getElementById('bibleLoginForm').classList.remove('hidden');
      document.getElementById('bibleUserName').value = '';
      document.getElementById('biblePassword').value = '';
      document.getElementById('bibleLoginError').classList.add('hidden');
    });

    // ══ 성경읽기 로그인 ══════════════════════════════════════════════════
    document.getElementById('bibleLoginBtn').addEventListener('click', async () => {
      const nameEl = document.getElementById('bibleUserName');
      const pwEl   = document.getElementById('biblePassword');
      const errEl  = document.getElementById('bibleLoginError');
      const name   = nameEl.value.trim();
      const pw     = pwEl.value.trim();
      errEl.classList.add('hidden');
      if (!name || !pw) { errEl.textContent = '이름과 비밀번호를 입력해주세요.'; errEl.classList.remove('hidden'); return; }
      const re = /^[0-9][가-힣]{2,4}[A-Z]?$/;
      if (!re.test(name)) { errEl.textContent = '이름 형식: 숫자1자리 + 한글 2~4자 (예: 9최별무리)'; errEl.classList.remove('hidden'); return; }

      const existing = bibleReading[name];
      if (existing && existing.password && existing.password !== pw) {
        errEl.textContent = '비밀번호가 맞지 않습니다.';
        errEl.classList.remove('hidden'); return;
      }
      // 이름에서 학년 숫자 제거 → Firebase 키
      const baseName = name.replace(/^\d/, '');
      // 신규 또는 로그인 성공 → 비밀번호 저장
      const existingBase = bibleReading[baseName];
      if (existingBase && existingBase.password && existingBase.password !== pw) {
        // baseName 키에 비밀번호가 있는 경우 확인
        if (!existing || !existing.password) {
          errEl.textContent = '비밀번호가 맞지 않습니다.';
          errEl.classList.remove('hidden'); return;
        }
      }
      if (!existingBase || !existingBase.password) {
        await saveToFirebase(`bibleReading/${baseName}/password`, pw);
      }
      bibleCurrentUser = baseName;
      // 로컬 데이터 로드
      bibleLocalData = {};
      const books = (bibleReading[baseName] && bibleReading[baseName].books) || {};
      Object.entries(books).forEach(([idx, chapters]) => {
        bibleLocalData[Number(idx)] = {};
        Object.entries(chapters).forEach(([ch, val]) => {
          bibleLocalData[Number(idx)][Number(ch)] = (val === true || val === null) ? null : val;
        });
      });
      document.getElementById('bibleLoginForm').classList.add('hidden');
      document.getElementById('bibleDashboard').classList.remove('hidden');
      document.getElementById('bibleWelcome').textContent = `${name}님의 성경읽기`;
      document.getElementById('bibleCurrentPw').textContent = pw;
      document.getElementById('bibleCurrentPw').classList.add('hidden');
      document.getElementById('bibleShowPwBtn').textContent = '🔍 보기';
      document.getElementById('bibleNewPw').value = '';
      document.getElementById('bibleNewPwMsg').classList.add('hidden');
      bibleCurrentTab = 'OT';
      expandedBook = null;
      renderBibleProgress();
      renderBibleBookGrid();
    });
    document.getElementById('biblePassword').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('bibleLoginBtn').click();
    });

    // ══ 성경읽기 탭 전환 ═════════════════════════════════════════════════
    window.switchBibleTab = function(tab) {
      bibleCurrentTab = tab;
      expandedBook = null;
      document.getElementById('bibleTabOT').className = tab === 'OT'
        ? 'px-4 py-2 text-sm font-bold rounded-lg bg-blue-600 text-white'
        : 'px-4 py-2 text-sm font-bold rounded-lg bg-white text-gray-600 border border-gray-300';
      document.getElementById('bibleTabNT').className = tab === 'NT'
        ? 'px-4 py-2 text-sm font-bold rounded-lg bg-blue-600 text-white'
        : 'px-4 py-2 text-sm font-bold rounded-lg bg-white text-gray-600 border border-gray-300';
      renderBibleBookGrid();
    };

    // ══ 진행률 렌더 ══════════════════════════════════════════════════════
    function getBibleStats() {
      let completedBooks = 0, totalChRead = 0, totalChAll = 0;
      BIBLE_BOOKS.forEach((book, idx) => {
        const checked = bibleLocalData[idx] ? Object.keys(bibleLocalData[idx]).length : 0;
        totalChRead += checked;
        totalChAll  += book.ch;
        if (checked >= book.ch) completedBooks++;
      });
      return { completedBooks, totalChRead, totalChAll };
    }

    function renderBibleProgress() {
      const card = document.getElementById('bibleProgressCard');
      if (!card) return;
      const { completedBooks, totalChRead, totalChAll } = getBibleStats();
      const pct = Math.round(completedBooks / 66 * 100);
      const chPct = Math.round(totalChRead / totalChAll * 100);
      card.innerHTML = `
        <div class="flex flex-wrap gap-4 items-center justify-between mb-3">
          <div class="text-2xl font-bold text-blue-700">${completedBooks}<span class="text-base text-gray-400 font-normal">/66권</span></div>
          <div class="text-sm text-gray-500">${totalChRead}<span class="text-gray-400">/${totalChAll}장 읽음</span></div>
        </div>
        <div class="mb-1 text-xs text-gray-500">권 완독 진행률 ${pct}%</div>
        <div class="w-full bg-gray-200 rounded-full h-3 mb-3">
          <div class="bg-blue-500 h-3 rounded-full transition-all" data-meter="${pct}"></div>
        </div>
        <div class="mb-1 text-xs text-gray-500">장 읽기 진행률 ${chPct}%</div>
        <div class="w-full bg-gray-200 rounded-full h-2">
          <div class="bg-blue-300 h-2 rounded-full transition-all" data-meter="${chPct}"></div>
        </div>`;
    }

    // ══ 책 목록 그리드 렌더 ══════════════════════════════════════════════
    function renderBibleBookGrid() {
      const grid = document.getElementById('bibleBookGrid');
      if (!grid) return;
      grid.innerHTML = '';
      const books = BIBLE_BOOKS.map((b,i) => ({...b, idx:i})).filter(b => b.t === bibleCurrentTab);
      books.forEach(book => {
        const checked = bibleLocalData[book.idx] ? Object.keys(bibleLocalData[book.idx]).length : 0;
        const isComplete = checked >= book.ch;
        const isExpanded = expandedBook === book.idx;

        const card = document.createElement('div');
        card.className = `mb-2 border rounded-lg overflow-hidden ${isComplete ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-white'}`;

        // 책 헤더
        const header = document.createElement('div');
        header.className = `flex items-center justify-between px-4 py-3 cursor-pointer select-none ${isComplete ? 'bg-blue-100' : 'hover:bg-gray-50'}`;
        header.innerHTML = `
          <div class="flex items-center gap-3">
            <span class="text-lg">${isComplete ? '✅' : '📖'}</span>
            <span class="font-bold ${isComplete ? 'text-blue-700' : 'text-gray-800'}">${book.name}</span>
            <span class="text-xs text-gray-400">${book.ch}장</span>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-sm font-medium ${isComplete ? 'text-blue-600' : 'text-gray-500'}">${checked}/${book.ch}</div>
            <div class="w-20 bg-gray-200 rounded-full h-2">
              <div class="${isComplete ? 'bg-blue-500' : 'bg-blue-300'} h-2 rounded-full" data-meter="${Math.round(checked/book.ch*100)}"></div>
            </div>
            <span class="text-gray-400 text-xs">${isExpanded ? '▲' : '▼'}</span>
          </div>`;
        header.addEventListener('click', () => {
          expandedBook = isExpanded ? null : book.idx;
          renderBibleBookGrid();
        });
        card.appendChild(header);

        // 장 체크박스 영역
        if (isExpanded) {
          const chapterArea = document.createElement('div');
          chapterArea.className = 'p-3 border-t border-gray-200';

          // 전체 선택/해제 버튼
          const allBtns = document.createElement('div');
          allBtns.className = 'flex gap-2 mb-3';
          const allOnBtn = document.createElement('button');
          allOnBtn.textContent = '전체 선택';
          allOnBtn.className = 'px-3 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600';
          allOnBtn.onclick = () => {
            if (!bibleLocalData[book.idx]) bibleLocalData[book.idx] = {};
            const today = new Date().toISOString().split('T')[0];
            for (let i = 1; i <= book.ch; i++) {
              if (!(i in bibleLocalData[book.idx])) bibleLocalData[book.idx][i] = today;
            }
            renderBibleBookGrid(); renderBibleProgress();
            window.saveBibleProgress();
          };
          const allOffBtn = document.createElement('button');
          allOffBtn.textContent = '전체 해제';
          allOffBtn.className = 'px-3 py-1 text-xs bg-gray-300 text-gray-700 rounded hover:bg-gray-400';
          allOffBtn.onclick = () => {
            bibleLocalData[book.idx] = {};
            renderBibleBookGrid(); renderBibleProgress();
            window.saveBibleProgress();
          };
          allBtns.appendChild(allOnBtn);
          allBtns.appendChild(allOffBtn);
          chapterArea.appendChild(allBtns);

          // 장 번호 체크박스 그리드
          const chapGrid = document.createElement('div');
          chapGrid.className = 'grid gap-1';
          chapGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(44px, 1fr))';
          for (let c = 1; c <= book.ch; c++) {
            const isChChecked = bibleLocalData[book.idx] && (c in bibleLocalData[book.idx]);
            const btn = document.createElement('button');
            btn.className = `py-1.5 text-xs font-bold rounded border transition-all ${isChChecked ? 'bg-blue-500 text-white border-blue-500' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'}`;
            btn.textContent = c;
            btn.addEventListener('click', () => {
              if (!bibleLocalData[book.idx]) bibleLocalData[book.idx] = {};
              if (c in bibleLocalData[book.idx]) delete bibleLocalData[book.idx][c];
              else bibleLocalData[book.idx][c] = new Date().toISOString().split('T')[0];
              renderBibleBookGrid(); renderBibleProgress();
              window.saveBibleProgress(); // 자동 저장
            });
            chapGrid.appendChild(btn);
          }
          chapterArea.appendChild(chapGrid);
          card.appendChild(chapterArea);
        }
        grid.appendChild(card);
      });
    }

    // ══ 성경읽기 저장 ════════════════════════════════════════════════════
    window.resetBiblePassword = async function(userName) {
      if (!confirm(`${userName}의 비밀번호를 0000으로 초기화하시겠습니까?`)) return;
      await saveToFirebase(`bibleReading/${userName}/password`, '0000');
      alert(`✅ ${userName}의 비밀번호가 0000으로 초기화되었습니다.`);
    };

    window.toggleBiblePw = function() {
      const pw = document.getElementById('bibleCurrentPw');
      const btn = document.getElementById('bibleShowPwBtn');
      if (pw.classList.contains('hidden')) {
        pw.classList.remove('hidden');
        btn.textContent = '🔍 숨기기';
        // 5초 후 자동 숨김
        setTimeout(() => {
          pw.classList.add('hidden');
          btn.textContent = '🔍 보기';
        }, 5000);
      } else {
        pw.classList.add('hidden');
        btn.textContent = '🔍 보기';
      }
    };

    window.saveBiblePassword = async function() {
      if (!bibleCurrentUser) return;
      const newPw = document.getElementById('bibleNewPw').value.trim();
      if (!newPw) { alert('새 비밀번호를 입력해주세요.'); return; }
      await saveToFirebase(`bibleReading/${bibleCurrentUser}/password`, newPw);
      document.getElementById('bibleCurrentPw').textContent = newPw;
      document.getElementById('bibleCurrentPw').classList.add('hidden');
      document.getElementById('bibleShowPwBtn').textContent = '🔍 보기';
      document.getElementById('bibleNewPw').value = '';
      const msg = document.getElementById('bibleNewPwMsg');
      msg.classList.remove('hidden');
      setTimeout(() => msg.classList.add('hidden'), 2000);
    };

    window.saveBibleProgress = async function() {
      if (!bibleCurrentUser) return;
      const books = {};
      Object.entries(bibleLocalData).forEach(([idx, chObj]) => {
        if (Object.keys(chObj).length > 0) {
          books[idx] = {};
          Object.entries(chObj).forEach(([c, date]) => {
            books[idx][c] = date || new Date().toISOString().split('T')[0];
          });
        }
      });
      await saveToFirebase(`bibleReading/${bibleCurrentUser}/books`, Object.keys(books).length > 0 ? books : null);
      const msg = document.getElementById('bibleSaveMsg');
      if (msg) { msg.classList.remove('hidden'); setTimeout(() => msg.classList.add('hidden'), 2000); }
    };

    // ══ 관리자 성경읽기 현황 ═════════════════════════════════════════════
    let bibleRangeStart = null, bibleRangeEnd = null;

    // 년/월/일 드롭다운 초기화
    (function initBibleDateSelects() {
      const now = new Date();
      const curY = now.getFullYear();
      const startY = Math.max(2026, curY - 4);
      const endY = curY + 1;
      ['bibleStartY','bibleEndY'].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = '<option value="">년</option>';
        for (let y = startY; y <= endY; y++) {
          sel.innerHTML += `<option value="${y}" ${y === curY ? 'selected' : ''}>${y}</option>`;
        }
      });
      ['bibleStartM','bibleEndM'].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = '<option value="">월</option>';
        for (let m = 1; m <= 12; m++) sel.innerHTML += `<option value="${String(m).padStart(2,'0')}">${m}</option>`;
      });
      ['bibleStartD','bibleEndD'].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = '<option value="">일</option>';
        for (let d = 1; d <= 31; d++) sel.innerHTML += `<option value="${String(d).padStart(2,'0')}">${d}</option>`;
      });
      // 옵션 생성 후 시작일 기본값: 현재 연도 3월 1일
      const startMSel = document.getElementById('bibleStartM');
      const startDSel = document.getElementById('bibleStartD');
      if (startMSel) startMSel.value = '03';
      if (startDSel) startDSel.value = '01';
    })();

    window.downloadBibleExcel = async function() {
      // SheetJS 로드
      window.XLSX ??= await import('xlsx');
      const allRoster = [...rosterMonWed, ...rosterTueThu];
      const seen = new Set();
      const students = allRoster.filter(s => {
        const k = `${s.grade}${s.name}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      }).sort((a,b) => Number(a.grade)-Number(b.grade)||Number(a.class||0)-Number(b.class||0)||Number(a.number||0)-Number(b.number||0));

      const hasRange = bibleRangeStart || bibleRangeEnd;
      const rangeLabel = hasRange ? `${bibleRangeStart||''}~${bibleRangeEnd||''}` : '전체';

      // 헤더
      const headers = ['학년','반','번호','이름','전체 완독 권수','전체 읽은 장수'];
      if (hasRange) {
        headers.push(`기간 내 완독 권수 (${rangeLabel})`);
        headers.push(`기간 내 읽은 장수 (${rangeLabel})`);
      }
      // 66권 책 이름 추가
      BIBLE_BOOKS.forEach(b => headers.push(b.name));

      const rows = [headers];
      students.forEach(s => {
        const baseName = s.name;
        const userData = bibleReading[baseName] || bibleReading[`${s.grade}${s.name}`] || {};
        const books = userData.books || {};

        let totalCompleted = 0, totalChRead = 0;
        BIBLE_BOOKS.forEach((book, idx) => {
          const chaps = Object.keys(books[idx]||{}).length;
          totalChRead += chaps;
          if (chaps >= book.ch) totalCompleted++;
        });

        const row = [s.grade, s.class||'', s.number, s.name, totalCompleted, totalChRead];

        if (hasRange) {
          row.push(countBooksInRange(userData, bibleRangeStart, bibleRangeEnd));
          row.push(countChaptersInRange(userData, bibleRangeStart, bibleRangeEnd));
        }

        // 책별 읽은 장수
        BIBLE_BOOKS.forEach((book, idx) => {
          const chaps = Object.keys(books[idx]||{}).length;
          row.push(`${chaps}/${book.ch}`);
        });
        rows.push(row);
      });

      const ws = window.XLSX.utils.aoa_to_sheet(rows);
      // 열 너비 설정
      ws['!cols'] = [
        {wch:6},{wch:4},{wch:4},{wch:8},{wch:14},{wch:14},
        ...(hasRange ? [{wch:22},{wch:22}] : []),
        ...BIBLE_BOOKS.map(() => ({wch:8}))
      ];
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, '성경읽기현황');
      const fileName = `성경읽기현황_${hasRange ? rangeLabel : '전체'}_${getDateKey(new Date())}.xlsx`;
      window.XLSX.writeFile(wb, fileName);
    };

    window.applyBibleRange = function() {
      const sy = document.getElementById('bibleStartY').value;
      const sm = document.getElementById('bibleStartM').value;
      const sd = document.getElementById('bibleStartD').value;
      const ey = document.getElementById('bibleEndY').value;
      const em = document.getElementById('bibleEndM').value;
      const ed = document.getElementById('bibleEndD').value;
      bibleRangeStart = (sy && sm && sd) ? `${sy}-${sm}-${sd}` : null;
      bibleRangeEnd   = (ey && em && ed) ? `${ey}-${em}-${ed}` : null;
      const label = document.getElementById('bibleRangeLabel');
      if (bibleRangeStart || bibleRangeEnd) {
        label.textContent = `📅 ${bibleRangeStart||'시작'} ~ ${bibleRangeEnd||'종료'}`;
        label.classList.remove('hidden');
      } else {
        label.classList.add('hidden');
      }
      safeRender(renderBibleAdminPanel);
    };

    window.clearBibleRange = function() {
      bibleRangeStart = null; bibleRangeEnd = null;
      ['bibleStartY','bibleStartM','bibleStartD','bibleEndY','bibleEndM','bibleEndD'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      // 년도 기본값 복원
      const curY = new Date().getFullYear();
      ['bibleStartY','bibleEndY'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = curY;
      });
      document.getElementById('bibleRangeLabel').classList.add('hidden');
      safeRender(renderBibleAdminPanel);
    };

    // 기간 내 완독 권수 계산
    function countBooksInRange(userData, start, end) {
      const books = userData.books || {};
      let count = 0;
      BIBLE_BOOKS.forEach((book, idx) => {
        const chaps = books[idx] || {};
        const total = book.ch;
        // 모든 장이 체크되어 있는지 확인
        if (Object.keys(chaps).length < total) return;
        if (!start && !end) { count++; return; } // 기간 없으면 전체
        // 각 장의 날짜 중 범위 내에 속하는 것 계산
        const dates = Object.values(chaps).filter(d => d && d !== true);
        if (dates.length === 0) return; // 날짜 정보 없으면 집계 불가
        // 기간 내에 완독된 장 수
        const inRange = Object.entries(chaps).filter(([,d]) => {
          if (!d || d === true) return false;
          if (start && d < start) return false;
          if (end && d > end) return false;
          return true;
        }).length;
        // 기간 내에 읽은 장이 1개 이상이면 해당 기간에 진행한 책으로 카운트
        // → 더 정확하게: 기간 내 완독된 책 (마지막 장의 날짜가 범위 안)
        const lastDate = dates.sort().pop();
        if (start && lastDate < start) return;
        if (end && lastDate > end) return;
        count++;
      });
      return count;
    }

    // 기간 내 읽은 장 수
    function countChaptersInRange(userData, start, end) {
      const books = userData.books || {};
      let count = 0;
      Object.values(books).forEach(chaps => {
        Object.values(chaps).forEach(d => {
          if (!start && !end) { count++; return; }
          if (!d || d === true) return;
          if (start && d < start) return;
          if (end && d > end) return;
          count++;
        });
      });
      return count;
    }

    function renderBibleAdminPanel() {
      const listEl = document.getElementById('bibleAdminList');
      if (!listEl) return;
      listEl.innerHTML = '';
      const allRoster = [...rosterMonWed, ...rosterTueThu];
      const seen = new Set();
      const students = allRoster.filter(s => {
        const k = `${s.grade}${s.name}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      }).sort((a,b) => Number(a.grade)-Number(b.grade)||Number(a.class||0)-Number(b.class||0)||Number(a.number||0)-Number(b.number||0));

      if (students.length === 0) {
        listEl.innerHTML = '<div class="text-sm text-gray-400 text-center py-4">인원체크 명단을 업로드하면 학생별 현황이 표시됩니다.</div>';
        return;
      }

      const hasRange = bibleRangeStart || bibleRangeEnd;
      const groups = {};
      students.forEach(s => {
        const key = (String(s.grade) === '6') ? '6학년' : `${s.grade}-${s.class}반`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(s);
      });

      Object.entries(groups).forEach(([groupKey, members]) => {
        const section = document.createElement('div');
        section.className = 'mb-4';
        const hdr = document.createElement('div');
        hdr.className = 'font-bold text-blue-700 mb-2 px-1';
        hdr.textContent = groupKey;
        section.appendChild(hdr);
        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-3 md:grid-cols-6 gap-2';
        members.forEach(s => {
          const appName = `${s.grade}${s.name}`;
          const baseName2 = s.name; // 학년 없는 이름으로 조회
          const userData = bibleReading[baseName2] || bibleReading[appName] || {}; // 신/구 키 모두 지원
          // 전체 완독
          const books = userData.books || {};
          let totalCompleted = 0;
          BIBLE_BOOKS.forEach((book, idx) => {
            if (Object.keys(books[idx]||{}).length >= book.ch) totalCompleted++;
          });
          // 기간 내 완독
          const rangeCompleted  = hasRange ? countBooksInRange(userData, bibleRangeStart, bibleRangeEnd) : null;
          const rangeChapters   = hasRange ? countChaptersInRange(userData, bibleRangeStart, bibleRangeEnd) : null;
          const pct = Math.round(totalCompleted / 66 * 100);
          const card = document.createElement('div');
          card.className = 'bg-white border border-blue-100 rounded-lg p-2';
          card.innerHTML = `
            <div class="text-xs text-gray-400">${s.grade}-${s.class||'?'}-${s.number}</div>
            <div class="text-sm font-bold text-gray-800 mb-1">${s.name}</div>
            <div class="flex items-center gap-1.5">
              <span class="text-xs font-bold text-blue-600">${totalCompleted}<span class="text-xs text-gray-400 font-normal">/66</span></span>
              <div class="flex-1 bg-gray-200 rounded-full h-1.5">
                <div class="bg-blue-400 h-1.5 rounded-full" data-meter="${pct}"></div>
              </div>
            </div>
            ${hasRange ? `<div class="text-base font-bold text-orange-500 mt-1.5 pt-1.5 border-t border-orange-100">${rangeCompleted}권 완독 · ${rangeChapters}장</div>` : ''}
            ${(userData.password) ? `<button data-action-click="${encodeAction("resetBiblePassword",[s.name])}" class="mt-1 w-full px-1 py-0.5 text-xs bg-gray-100 text-gray-400 rounded hover:bg-red-50 hover:text-red-500">🔑 초기화</button>` : ''}`;
          grid.appendChild(card);
        });
        section.appendChild(grid);
        listEl.appendChild(section);
      });
    }

    async function init(){ try{ await _ensureLoadedAndRender(); } catch(e){ console.error('init 오류', e); } }
    init();

    // 디버그 전역
    window.allowBookingFor = allowBookingFor;
    window.canAttemptBookingFor = canAttemptBookingFor;
    window.weeklyAvailability = weeklyAvailability;
    window.bookings = bookings;
    window.archivedBookings = archivedBookings;

  