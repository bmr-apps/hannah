import { encodeAction, installOriginalEvents } from './original-events.js';
installOriginalEvents();

import { initializeApp } from './preview-data.js';
import { getDatabase, ref, set, get, onValue } from './preview-data.js';
import { getAuth, signInAnonymously } from './preview-data.js';

// 학교생활지원 시스템(index.html)과 같은 Firebase 프로젝트를 그대로 사용합니다.
// 모든 데이터는 최상위 "cleaningDuty" 노드 밑에서만 읽고 쓰므로, 기존 예약/성경읽기/인원체크
// 데이터(bookings, classrooms, rosterMonWed 등)에는 전혀 영향을 주지 않습니다.
const firebaseConfig = {};
const app = initializeApp(firebaseConfig);
const dbase = getDatabase(app);
const auth = getAuth(app);
signInAnonymously(auth).catch(e => console.error('익명 로그인 실패(Firebase 콘솔에서 익명 로그인 활성화 필요):', e));

const ROOT = 'cleaningDuty';
const CLASS_IDS = ['6학년','7-1','7-2','8-1','8-2'];
const WEEKDAYS = ['월','화','수','목','금'];
// 반별 청소구역 기본값 — Firebase에 아직 구역 데이터가 없는 반에 한해 최초 1회만 자동으로 채워넣는다.
// 이미 구역이 등록돼 있으면(직접 추가/삭제한 경우 포함) 건드리지 않는다.
const DEFAULT_ZONES = {
  '6학년': [ {name:'교실', groupSize:2}, {name:'1층 탈의실', groupSize:1}, {name:'동편출입구', groupSize:1} ],
  '7-1':  [ {name:'교실', groupSize:3}, {name:'세미나실', groupSize:1}, {name:'미술실', groupSize:2} ],
  '7-2':  [ {name:'교실', groupSize:3}, {name:'밴드실', groupSize:1}, {name:'강당', groupSize:2} ],
  '8-1':  [ {name:'교실', groupSize:3}, {name:'음악실', groupSize:1}, {name:'과학실', groupSize:2} ],
  '8-2':  [ {name:'교실', groupSize:3}, {name:'도서관 및 탈의실', groupSize:2}, {name:'별관1,2', groupSize:1} ],
};
const ASSIGN_DAYS = ['월','화','수','목']; // 금요일은 "다같이" 등 별도 라벨로 취급 (원본 데이터 패턴)

let currentClassId = CLASS_IDS[0];
let currentView = 'today'; // 'today' | 'common' | classId
// 담임교사 요청(2026-09-15): "공통"과 반별 탭(6학년~8-2)은 교사만 볼 수 있어야 하고,
// "오늘의 청소"는 누구나 바로 볼 수 있어야 한다. 예약시스템(index.html)의 관리자 로그인과
// 같은 비밀번호를 그대로 쓰기로 해서, 별도 비밀번호를 새로 관리할 필요가 없다 — 최상위
// "adminPassword" 노드를 그대로 읽기만 하고(이 파일에서는 절대 바꾸지 않음), 로그인 성공
// 여부는 이 브라우저 탭에서만 sessionStorage로 기억한다(탭을 닫으면 다시 로그인 필요).
let adminPassword = 'design-test-admin';
let isAdminMode = false;
try { isAdminMode = sessionStorage.getItem('hannah:cleaningDutyAdmin') === '1'; } catch(e) {}
// index.html(예약시스템) 관리자 로그인과 연동: 메인 화면에서 로그인한 지 12시간이 안 됐으면
// (localStorage는 탭이 달라도 공유된다) 여기서도 비밀번호를 다시 묻지 않고 바로 관리자 모드로
// 들어간다. 학생·학부모 화면에는 "관리자 모드" 탭 자체가 아예 보이지 않아야 하므로, 이 페이지에
// 직접 들어와서 로그인해야 하는 경우(예: 다른 기기)를 위한 보조 수단으로만 주소 끝에 "?admin"을
// 붙이면 로그인 탭이 나타나게 해둔다 — 평소 학생들이 보는 주소에는 붙지 않는다.
try {
  const unlockedAt = parseInt(localStorage.getItem('hannah:schoolAdminUnlockedAt') || '0', 10);
  if (unlockedAt && (Date.now() - unlockedAt) < 12 * 60 * 60 * 1000) isAdminMode = true;
} catch(e) {}
let cdShowLoginTab = false;
try { cdShowLoginTab = new URLSearchParams(location.search).has('admin'); } catch(e) {}
let quarter = { label:'2026-3Q', startDate:'', weekCount:9, weeks:[] };
let students = {};          // {classId: [{number,name,excluded}]}
let zones = {};             // {classId: [{name,groupSize}]}
let conflictPairs = {};     // {classId: [{a,b}]}
let classroomAssignment = {}; // {classId: {weekNo: {day: {zoneName: {names:[], manuallyEdited}}}}}
let recyclingAssignment = {}; // {weekNo: {day: [names]}}  -- 전체 반 공통
let assignmentStats = {};   // {classId: {name: {byQuarter: {label: {total, byZone:{}}}}}}
let fridayLabel = {};       // {classId: {weekNo: "다같이" 등 수동 입력 문구}} -- 금요일은 반마다 문구가 달라 자동배정 대신 직접 관리
let weekdayAssignment = {}; // {classId: {studentName: {day:'월'|'화'|'수'|'목', quarterLabel}}} -- 학생이 한 쿼터 동안 같은 요일에 청소하도록 고정
let shortfallDay = {};      // {classId: '월'|'화'|'수'|'목'} -- 반 인원이 정원보다 적을 때 그 부족분을 몰아둘 요일(F3-d). 반마다 담임이 선택. 미설정 시 '화'가 기본값.
let dayPriorityMode = {};   // {classId: true|false} -- true면 "요일 우선 배정"(F3-o): 다른 요일에서 인원을 데려오지 않고 그 요일 고정 인원수에 맞춰 구역 정원을 줄인다. 현재는 6학년 탭에만 표시.
let genderSplitMode = {};   // {classId: true|false} -- true면 "남녀 구분 배정"(F3-r): "교실"과 그 외 구역을 통째로 성별로 나눠 배정한다. 현재는 6학년을 제외한 탭에만 표시.
let genderSplitFlip = {};   // {classId: true|false} -- "남녀 구분 배정"에서 이번 쿼터에 어느 성별이 "교실"을 맡을지. false=여학생 교실(기본), true=남학생 교실. "이번 쿼터 요일 배정도 새로 계산"으로 쿼터가 바뀔 때마다 뒤집혀, 모든 학생이 여러 쿼터에 걸쳐 교실·그 외 구역을 골고루 경험하게 한다(F3-r 2차 수정).
// 담임교사 요청(2026-09-16): 실수로 "자동배정 실행" 버튼을 눌러버리면 이번 쿼터 배정표가
// 통째로 다시 섞여버리는데, 되돌릴 방법이 없었다. 그래서 자동배정을 실제로 실행하기 직전의
// classroomAssignment/weekdayAssignment/genderSplitFlip을 반별로 한 벌씩만 백업해두고,
// "이전 데이터 불러오기" 버튼으로 그 시점으로 되돌릴 수 있게 한다(되돌리기는 1단계까지만 —
// 가장 최근 실행 직전 상태 하나만 보관하며, 다시 실행하면 그 시점 기준으로 덮어써진다).
let autoAssignBackup = {};  // {classId: {classroomAssignment, weekdayAssignment, genderSplitFlip, quarterLabel, savedAt}}

function ck(cid){ return students[cid] || []; }
function activeStudents(cid){ return ck(cid).filter(s=>!s.excluded); }

async function saveNode(path, value){
  await set(ref(dbase, `${ROOT}/${path}`), value);
}

// 분리수거 재배정, 자동배정, 명단 업로드처럼 저장(saveNode)이 여러 번 연달아 일어나는
// 동작 중에는, 그 사이사이 실시간 리스너가 "아직 다 저장되지 않은" 서버 상태로
// 화면을 되돌려버릴 수 있다. withSync로 감싼 동안에는 실시간 반영을 잠시 미뤄두고,
// 작업이 완전히 끝난 뒤 가장 최신 상태로 한 번에 반영해 이런 엇갈림을 막는다.
let suspendDepth = 0;
let pendingRemoteData = null;

function applyRemoteData(data){
  quarter = data.quarter || quarter;
  if (!quarter.weeks) quarter.weeks = [];
  students = data.students || {};
  zones = data.zones || {};
  conflictPairs = data.conflictPairs || {};
  classroomAssignment = data.classroomAssignment || {};
  recyclingAssignment = data.recyclingAssignment || {};
  assignmentStats = data.assignmentStats || {};
  fridayLabel = data.fridayLabel || {};
  weekdayAssignment = data.weekdayAssignment || {};
  shortfallDay = data.shortfallDay || {};
  dayPriorityMode = data.dayPriorityMode || {};
  genderSplitMode = data.genderSplitMode || {};
  genderSplitFlip = data.genderSplitFlip || {};
  autoAssignBackup = data.autoAssignBackup || {};

  // 최초 1회 구역 기본값 세팅: 이 반에 구역 데이터가 아예 없을 때만 채워넣는다.
  CLASS_IDS.forEach(cid => {
    if (!zones[cid]) {
      zones[cid] = DEFAULT_ZONES[cid];
      saveNode(`zones/${cid}`, DEFAULT_ZONES[cid]).catch(e => console.error('구역 기본값 저장 오류', e));
    }
  });

  document.getElementById('topNotice').textContent =
    quarter.weeks.length ? `현재 쿼터: ${quarter.label} (${quarter.weeks.length}주차) · 반을 선택해 아래 항목을 확인하세요.`
                          : '아직 쿼터 달력이 생성되지 않았습니다. 아래 "쿼터 설정"에서 먼저 달력을 만들어주세요.';
  renderAll();
}

function loadAll(){
  onValue(ref(dbase, ROOT), (snap) => {
    const data = snap.val() || {};
    if (suspendDepth > 0){ pendingRemoteData = data; return; }
    applyRemoteData(data);
  });
  // 예약시스템(index.html)이 최상위 "adminPassword" 노드에 저장해둔 비밀번호를 읽기만 한다.
  onValue(ref(dbase, 'adminPassword'), (snap) => {
    if (snap.val()) adminPassword = snap.val();
  });
}

window.__requestAdminLogin = () => {
  const pw = prompt('관리자 비밀번호를 입력하세요 (예약시스템과 동일한 비밀번호)');
  if (pw === null) return; // 취소
  if (pw === adminPassword){
    isAdminMode = true;
    try { sessionStorage.setItem('hannah:cleaningDutyAdmin', '1'); } catch(e) {}
    showToast('✅ 관리자 모드로 전환했습니다');
    renderAll();
  } else {
    alert('비밀번호가 올바르지 않습니다.');
  }
};
window.__adminLogout = () => {
  isAdminMode = false;
  try { sessionStorage.removeItem('hannah:cleaningDutyAdmin'); } catch(e) {}
  // index.html 쪽 자동 로그인 표시도 함께 지운다 — 안 그러면 새로고침했을 때 다시 관리자
  // 모드로 돌아가버린다(로그아웃이 안 먹힌 것처럼 보임).
  try { localStorage.removeItem('hannah:schoolAdminUnlockedAt'); } catch(e) {}
  currentView = 'today';
  showToast('로그아웃 되었습니다');
  renderAll();
};

async function withSync(fn){
  suspendDepth++;
  try{
    return await fn();
  } finally {
    suspendDepth--;
    if (suspendDepth === 0 && pendingRemoteData){
      const d = pendingRemoteData; pendingRemoteData = null;
      applyRemoteData(d);
    }
  }
}

// ── 탭 (오늘의 청소 · 공통 · 반별) ──────────────────────────────────
// "오늘의 청소"는 누구나 볼 수 있고, "공통"과 반별 탭(6학년~8-2)은 관리자 모드일 때만
// 탭 목록에 나타난다(F-admin, 2026-09-15). 담임교사 요청(추가): 학생·학부모 화면에는
// "관리자 모드" 탭 자체가 보이면 안 되므로, 로그인 전에는 그 탭을 아예 숨긴다 — 관리자는
// index.html에서 로그인한 뒤 "청소 당번표 관리" 버튼으로 들어오면 자동으로 관리자 모드가
// 되고(그때는 "로그아웃" 탭이 보임), 다른 기기 등에서 직접 로그인해야 할 때만 주소 끝에
// "?admin"을 붙이면 로그인 탭이 보이는 보조 수단을 남겨뒀다.
function getMainTabs(){
  const tabs = [{ id:'today', label:'📅 오늘의 청소' }];
  if (isAdminMode){
    tabs.push({ id:'common', label:'⚙️ 공통' });
    CLASS_IDS.forEach(cid => tabs.push({ id: cid, label: cid }));
    tabs.push({ id:'__logout', label:'🔓 로그아웃' });
  } else if (cdShowLoginTab){
    tabs.push({ id:'__adminLogin', label:'🔒 관리자 모드' });
  }
  return tabs;
}
function renderMainTabs(){
  const box = document.getElementById('mainTabs');
  box.innerHTML = '';
  getMainTabs().forEach(item => {
    const b = document.createElement('div');
    b.className = 'tab' + (item.id===currentView ? ' active' : '');
    b.textContent = item.label;
    if (item.id === '__adminLogin') b.onclick = () => window.__requestAdminLogin();
    else if (item.id === '__logout') b.onclick = () => window.__adminLogout();
    else b.onclick = () => window.__switchView(item.id);
    box.appendChild(b);
  });
}
window.__switchView = (view) => {
  currentView = view;
  if (CLASS_IDS.includes(view)) currentClassId = view;
  renderAll();
};

// ── 쿼터 달력 ─────────────────────────────────────────────────────────
document.getElementById('qWeeks').addEventListener('change', (e) => {
  document.getElementById('qWeeksCustom').style.display = e.target.value === 'custom' ? 'inline-block' : 'none';
});

function computeWeeks(startDateStr, weekCount){
  const weeks = [];
  const start = new Date(startDateStr + 'T00:00:00');
  for (let w = 0; w < weekCount; w++){
    const dates = {};
    WEEKDAYS.forEach((d, i) => {
      const dt = new Date(start);
      dt.setDate(start.getDate() + w*7 + i);
      const mm = dt.getMonth()+1, dd = dt.getDate();
      dates[d] = `${mm}/${dd}`;
    });
    weeks.push({ weekNo: w+1, dates });
  }
  return weeks;
}

document.getElementById('genCalBtn').addEventListener('click', async () => {
  const label = document.getElementById('qLabel').value.trim() || '2026-Q';
  const startDate = document.getElementById('qStart').value;
  if (!startDate){ alert('시작일(월요일)을 입력해주세요.'); return; }
  const weeksSel = document.getElementById('qWeeks').value;
  const weekCount = weeksSel === 'custom'
    ? parseInt(document.getElementById('qWeeksCustom').value || '0', 10)
    : parseInt(weeksSel, 10);
  if (!weekCount || weekCount < 1){ alert('쿼터 길이를 확인해주세요.'); return; }
  const weeks = computeWeeks(startDate, weekCount);
  quarter = { label, startDate, weekCount, weeks };
  await saveNode('quarter', quarter);
});

// 교무부장 요청(2026-10-06): "지금 쿼터 전체 데이터 삭제는 무서운 버튼인 것 같아. 없어도
// 되겠어." — 되돌릴 수 없는 일괄 삭제 버튼(배정표·학생별 요일·금요일 문구·분리수거 입력·
// 누적 통계를 한 번에 지우던 기능)은 실수로 누르면 피해가 크고 실제로도 거의 쓰이지 않아
// 화면에서 완전히 없앴다. 혹시 테스트 쿼터를 정리해야 할 일이 다시 생기면, 그때는 지울
// 항목을 교사가 직접 고를 수 있는 더 안전한 형태로 다시 만드는 편이 낫다.

// 교무부장 요청(2026-10-06): "금요일 청소 지금 다같이로 되어 있는데, 홀수 주차는 여양육,
// 짝수 주차는 남양육, 9주차는 다같이로 일괄 변경해줘. 6학년도 동일하게." — 금요일 문구
// (fridayLabel)는 반마다 주차별로 손으로 입력하게 되어 있는데, 이 규칙(홀수=여양육/
// 짝수=남양육, 단 9주차는 예외로 다같이)을 반마다 9번씩 손으로 고치는 대신 버튼 하나로
// 모든 반(CLASS_IDS에 이미 포함된 6학년도 자동으로 함께)에 한 번에 적용한다. 주차 수가
// 9가 아닌 쿼터(8주/10주 등)에도 그대로 적용되도록 "9주차만 예외"로 판단하고, 나머지는
// 홀/짝으로만 정한다.
document.getElementById('bulkFridayBtn').addEventListener('click', async () => {
  if (!quarter.weeks || !quarter.weeks.length){ alert('먼저 쿼터(달력)를 생성해주세요.'); return; }
  const label = quarter.label || '';
  const preview = quarter.weeks.map(w => {
    const text = w.weekNo === 9 ? '다같이' : (w.weekNo % 2 === 1 ? '여양육' : '남양육');
    return `${w.weekNo}주차: ${text}`;
  }).join(' / ');
  if (!confirm(
    `지금 쿼터("${label}")의 금요일 문구를 모든 반(6학년 포함)에 아래와 같이 일괄 적용할까요?\n\n` +
    `${preview}\n\n` +
    `손으로 다르게 입력해둔 금요일 문구가 있다면 모두 덮어씌워집니다. 이 작업은 되돌릴 수 없습니다.`
  )) return;

  await withSync(async () => {
    for (const cid of CLASS_IDS){
      if (!fridayLabel[cid]) fridayLabel[cid] = {};
      for (const w of quarter.weeks){
        const text = w.weekNo === 9 ? '다같이' : (w.weekNo % 2 === 1 ? '여양육' : '남양육');
        fridayLabel[cid][w.weekNo] = text;
        await saveNode(`fridayLabel/${cid}/${w.weekNo}`, text);
      }
    }
  });
  showToast('📅 모든 반의 금요일 문구를 일괄 적용했습니다');
  renderAll();
});

function renderCalPreview(){
  const el = document.getElementById('calPreview');
  document.getElementById('qLabel').value = quarter.label || '2026-3Q';
  document.getElementById('qStart').value = quarter.startDate || '';
  if (!quarter.weeks || !quarter.weeks.length){ el.innerHTML = ''; return; }
  let html = '<table><tr><th>주차</th><th>월</th><th>화</th><th>수</th><th>목</th><th>금</th></tr>';
  quarter.weeks.forEach(w => {
    html += `<tr><td>${w.weekNo}주차</td>` + WEEKDAYS.map(d=>`<td>${w.dates[d]}</td>`).join('') + '</tr>';
  });
  html += '</table>';
  el.innerHTML = html;
}

// ── 반별 청소구역 설정 ───────────────────────────────────────────────
function renderZones(){
  const list = zones[currentClassId] || [];
  const el = document.getElementById('zoneTable');
  if (!list.length){ el.innerHTML = '<p class="desc" data-original-style="8">아직 등록된 구역이 없습니다.</p>'; return; }
  let html = '<table><tr><th>구역 이름</th><th>인원수</th><th></th></tr>';
  list.forEach((z, idx) => {
    html += `<tr><td>${z.name}</td><td>${z.groupSize}명</td>
      <td><button class="btn danger small" data-action-click="${encodeAction("__delZone",[idx])}">삭제</button></td></tr>`;
  });
  html += '</table>';
  el.innerHTML = html;
}
window.__delZone = async (idx) => {
  const list = (zones[currentClassId] || []).slice();
  list.splice(idx, 1);
  zones[currentClassId] = list;
  await saveNode(`zones/${currentClassId}`, list);
};
document.getElementById('addZoneBtn').addEventListener('click', async () => {
  const name = document.getElementById('zoneName').value.trim();
  const size = parseInt(document.getElementById('zoneSize').value || '0', 10);
  if (!name || !size){ alert('구역 이름과 인원수를 입력해주세요.'); return; }
  const list = (zones[currentClassId] || []).slice();
  list.push({ name, groupSize: size });
  zones[currentClassId] = list;
  await saveNode(`zones/${currentClassId}`, list);
  document.getElementById('zoneName').value = '';
});

// ── 학생 명단 업로드 ─────────────────────────────────────────────────
// 담임교사 요청(2026-09-09): 6학년은 반을 나누지 않는 단일 학급이라(8번 확정 사항)
// 인원이 요일 4개로 딱 안 나눠떨어지는 경우가 잦고, 자동으로 요일을 배정하면 하루가
// 요일을 학생별로 미리 정해두면(자동배정보다 우선) 그 학생은 이번 쿼터 동안 그 요일로
// 고정되고, 비워둔 요일(예: 6학년에서 일부러 안 쓰는 요일)은 F3-d/F3-h 보강 로직이 채워준다 —
// 이미 있던 "이번 쿼터로 배정된 학생은 자동배정이 건드리지 않는다"는 규칙(ensureWeekdayAssignment)
// 을 그대로 활용하는 것이라 자동배정·균등배분 로직 자체는 손대지 않았다(6학년 전용으로 먼저
// 만들었다가, 2026-09-09에 담임교사 요청으로 성별과 함께 전체 반으로 확장 — PRD 7.3-i/F1-e).
const WEEKDAY_SELECT_OPTIONS = ['', ...ASSIGN_DAYS];
const GENDER_SELECT_OPTIONS = [{v:'', label:'미설정'}, {v:'남', label:'남'}, {v:'여', label:'여'}];
// 담임교사 요청(2026-09-09): "3월에 전교생 명단을 한 번에 올리지만, 학기 중 편입·전출(자퇴)로
// 인원이 간혹 바뀐다" — 그때마다 엑셀 전체를 다시 만들어 재업로드하지 않아도, 이 반 명단
// 화면에서 학생 한 명을 바로 추가하거나 삭제할 수 있게 했다(F1-d, 6학년 한정이 아니라 모든
// 반에 적용). 삭제는 명단에서만 빠지고, 그동안의 배정 이력(누적 통계 등)은 지우지 않는다 —
// 엑셀 재업로드 시 "명단에서 빠진 학생의 누적치는 보관만 한다"는 기존 정책(8번 확정 사항
// 14번)과 동일하게 맞췄다.
function renderRoster(){
  const cid = currentClassId;
  const list = ck(cid);
  const wdMap = weekdayAssignment[cid] || {};
  const el = document.getElementById('rosterTable');
  const nextNumber = list.reduce((max, s) => Math.max(max, parseInt(s.number, 10) || 0), 0) + 1;
  let html = `<div class="no-print" data-original-style="9">
    <strong data-original-style="10">학생 추가 (편입 등)</strong><br>
    <input type="text" id="addStuNumber" placeholder="번호" value="${nextNumber}" data-original-style="11">
    <input type="text" id="addStuName" placeholder="이름 (필수)" data-original-style="12">
    <select id="addStuGender"><option value="">성별 미설정</option><option value="남">남</option><option value="여">여</option></select>
    <button class="btn small" data-action-click="${encodeAction("__addStudent",[])}">추가</button>
  </div>`;
  if (!list.length){
    html += '<p class="desc" data-original-style="8">업로드된 명단이 없습니다. 전체 명단은 위 "공통" 탭에서 엑셀로 올리거나, 위에서 한 명씩 추가할 수 있습니다.</p>';
    el.innerHTML = html;
    return;
  }
  html += `<div class="no-print" data-original-style="13">
    <button class="btn small" data-action-click="${encodeAction("__saveAllWeekday",[])}">요일 배정 전체 저장</button>
    <span class="desc" data-original-style="14">성별·요일 드롭다운은 바꾸는 즉시 그 학생만 바로 저장돼요. "전체 저장"은 화면에 보이는 요일 값 전체를 한 번 더 확실히 저장합니다.</span>
  </div>`;
  html += '<table><tr><th>번호</th><th>이름</th><th>성별</th><th>배정 제외</th><th>이번 쿼터 청소 요일</th><th>삭제</th></tr>';
  list.forEach((s, idx) => {
    const rec = wdMap[s.name];
    const curDay = (rec && rec.quarterLabel === quarter.label) ? rec.day : '';
    const genderCell = `<select id="gender_${idx}" class="no-print" data-action-change="${encodeAction("__setGenderSelect",[s.name, '__control_value__'])}">` +
        GENDER_SELECT_OPTIONS.map(o => `<option value="${o.v}" ${o.v===(s.gender||'')?'selected':''}>${o.label}</option>`).join('') +
      `</select>`;
    const weekdayCell = `<select id="wdSel_${idx}" class="no-print" data-action-change="${encodeAction("__setWeekdaySelect",[s.name, '__control_value__'])}">` +
        WEEKDAY_SELECT_OPTIONS.map(d => `<option value="${d}" ${d===curDay?'selected':''}>${d ? d+'요일' : '미배정(자동)'}</option>`).join('') +
      `</select>`;
    html += `<tr><td>${s.number||''}</td><td>${s.name}</td>
      <td>${genderCell}</td>
      <td><input type="checkbox" ${s.excluded?'checked':''} data-action-change="${encodeAction("__toggleExclude",[idx, '__control_checked__'])}"></td>
      <td>${weekdayCell}</td>
      <td><button class="btn secondary small no-print" data-action-click="${encodeAction("__deleteStudent",[idx])}">삭제</button></td></tr>`;
  });
  html += '</table>';
  el.innerHTML = html;
}
// 이름은 이 시스템 전체에서 학생을 구분하는 키로 쓰인다(요일 고정, 배정 통계, 갈등쌍 등이 전부
// 이름으로 연결됨). 그래서 같은 반에 이미 있는 이름과 완전히 똑같은 이름은 추가할 수 없게
// 막는다 — 만약 동명이인이 실제로 있다면 "김민준1"처럼 구분되는 표기로 입력해달라고 안내한다.
window.__addStudent = async () => {
  const cid = currentClassId;
  const numberEl = document.getElementById('addStuNumber');
  const nameEl = document.getElementById('addStuName');
  const genderEl = document.getElementById('addStuGender');
  const name = nameEl.value.trim();
  if (!name){ alert('이름을 입력해주세요.'); return; }
  const list = ck(cid);
  if (list.some(s => s.name === name)){
    alert(`이미 같은 이름("${name}")의 학생이 이 반에 있습니다. 동명이인이면 "${name}1"처럼 구분되는 이름으로 입력해주세요 — 이 시스템은 이름으로 학생을 구분합니다.`);
    return;
  }
  const entry = { number: numberEl.value.trim(), name, excluded: false };
  if (genderEl.value) entry.gender = genderEl.value;
  const next = list.concat([entry]);
  await withSync(async () => {
    students[cid] = next;
    await saveNode(`students/${cid}`, next);
  });
  nameEl.value = '';
  genderEl.value = '';
  alert(`${name} 학생을 명단에 추가했습니다. "교실청소 자동배정"에서 자동배정을 다시 실행해야 실제 배정표에 반영됩니다.`);
  renderRoster();
};
// 명단에서만 빼고, 그동안의 배정 이력(누적 통계·요일 기록 등)은 지우지 않는다 — 엑셀
// 재업로드로 학생이 빠질 때와 동일한 정책. 이미 만들어둔 이후 주차의 배정표에 이름이 남아있을
// 수 있으니, 자동배정을 다시 실행해야 실제 표에서도 빠진다(배정 제외 체크박스와 동일한 동작).
window.__deleteStudent = async (idx) => {
  const cid = currentClassId;
  const list = ck(cid);
  const s = list[idx];
  if (!s) return;
  if (!confirm(`${s.name} 학생을 이 반 명단에서 삭제할까요? 지금까지의 배정 이력은 지워지지 않고 남아있습니다.\n(전출·자퇴 시 사용 — 일시적인 결석이면 "배정 제외" 체크박스를 대신 사용하세요.)`)) return;
  const next = list.filter((_, i) => i !== idx);
  await withSync(async () => {
    students[cid] = next;
    await saveNode(`students/${cid}`, next);
  });
  alert(`${s.name} 학생을 명단에서 삭제했습니다. "교실청소 자동배정"에서 자동배정을 다시 실행해야 실제 배정표에도 반영됩니다.`);
  renderRoster();
};
// 드롭다운 하나를 바꾸면 그 학생만 바로 저장한다(자동저장). 값이 "미배정"이면 이번 쿼터
// 기록을 아예 지워서, 다음 자동배정 실행 시 나머지 인원과 함께 자동으로 요일이 정해지게 한다.
window.__setWeekdaySelect = async (name, value) => {
  const cid = currentClassId;
  await withSync(async () => {
    if (!weekdayAssignment[cid]) weekdayAssignment[cid] = {};
    if (value){
      weekdayAssignment[cid][name] = { day: value, quarterLabel: quarter.label };
    } else {
      delete weekdayAssignment[cid][name];
    }
    await saveNode(`weekdayAssignment/${cid}`, weekdayAssignment[cid]);
  });
  showToast(`✅ ${name} 요일 저장 완료`);
};
// 화면에 지금 보이는 요일 드롭다운 값 전체를 한 번에 다시 저장한다 — 개별 자동저장이 잘 됐는지
// 불안할 때 확실히 눌러 확인할 수 있는 안전장치용 버튼.
window.__saveAllWeekday = async () => {
  const cid = currentClassId;
  const list = ck(cid);
  const next = {};
  list.forEach((s, idx) => {
    const sel = document.getElementById(`wdSel_${idx}`);
    const value = sel ? sel.value : '';
    if (value) next[s.name] = { day: value, quarterLabel: quarter.label };
  });
  await withSync(async () => {
    weekdayAssignment[cid] = next;
    await saveNode(`weekdayAssignment/${cid}`, next);
  });
  alert(`${cid} 요일 배정을 전체 저장했습니다. "교실청소 자동배정"에서 자동배정을 실행하면 반영됩니다.`);
  renderRoster();
};
window.__toggleExclude = async (idx, checked) => {
  const list = ck(currentClassId).slice();
  list[idx] = { ...list[idx], excluded: checked };
  students[currentClassId] = list;
  await saveNode(`students/${currentClassId}`, list);
};
// 남녀 단둘이 배정되는 것을 피하려면(F3-a) 성별 정보가 있어야 한다. 드롭다운을 바꾸면 그
// 학생만 바로 저장한다(자동저장). "미설정"을 고르면 성별 키 자체를 지운다 — Firebase는
// undefined 값을 저장할 수 없어서, 값이 있을 때만 키를 넣는 기존 방식을 그대로 따른다.
window.__setGenderSelect = async (name, value) => {
  const cid = currentClassId;
  const list = ck(cid).map(s => {
    if (s.name !== name) return s;
    const next = { ...s };
    if (value) next.gender = value; else delete next.gender;
    return next;
  });
  await withSync(async () => {
    students[cid] = list;
    await saveNode(`students/${cid}`, list);
  });
};

// 학년·반 값을 읽어 classId(6학년/7-1/7-2/8-1/8-2)로 변환. 6학년은 반 구분 없이 하나로 합친다.
// 숫자만 뽑아서 비교하므로 "7", "7학년", "7 " 처럼 표기가 조금 달라도 인식한다.
function resolveClassId(gradeRaw, clsRaw){
  const g = parseInt(String(gradeRaw).replace(/\D/g, ''), 10);
  const c = parseInt(String(clsRaw).replace(/\D/g, ''), 10);
  if (g === 6) return '6학년';
  if (g === 7 || g === 8){
    if (!c) return null;
    return `${g}-${c}`;
  }
  return null;
}

// 여러 CDN을 순서대로 시도한다 — 학교 네트워크에 따라 특정 CDN만 막혀 있는 경우가 있어,
// 하나가 안 되면 다음 것으로 자동 재시도한다.
async function ensureXLSX(){ window.XLSX ??= await import('xlsx'); }

document.getElementById('rosterFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('rosterStatus');
  statusEl.textContent = '파일 읽는 중...';

  // 1단계: 엑셀 처리 라이브러리 준비 (네트워크 문제 등은 여기서 구분해서 알려준다)
  try{
    await ensureXLSX();
  } catch(err){
    console.error('XLSX 라이브러리 로드 오류', err);
    statusEl.textContent = `❌ 엑셀 처리 기능을 불러오지 못했습니다. 인터넷 연결을 확인 후 다시 시도해주세요. (${err.message || err})`;
    return;
  }

  // 2단계: 파일 자체를 실제로 읽고 표 형식으로 해석
  let rows;
  try{
    const buf = await file.arrayBuffer();
    const wb = window.XLSX.read(buf, { type:'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = window.XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });
  } catch(err){
    console.error('엑셀 파일 읽기 오류', err);
    statusEl.textContent = `❌ 파일 읽기 오류. xlsx 형식인지 확인해주세요. (${err.message || err})`;
    return;
  }

  // 3단계: 내용을 학년·반별로 정리
  // 5번째 열(성별)은 있으면 읽고("남"/"여"/"M"/"F"/"남자"/"여자" 등 인식), 없거나 알아볼 수 없으면
  // 기존에 입력해둔 값을 그대로 유지한다(F3-a 남녀 단둘 배정 방지 규칙에 쓰인다).
  function normalizeGender(raw){
    const v = String(raw || '').trim();
    if (/^(남|남자|m|male|boy)$/i.test(v)) return '남';
    if (/^(여|여자|f|female|girl)$/i.test(v)) return '여';
    return null;
  }
  const grouped = {}; // {classId: [{number,name,excluded,gender?}]}
  let unrecognized = 0;
  for (let i=1; i<rows.length; i++){
    const row = rows[i];
    const gradeRaw = row[0], clsRaw = row[1];
    const number = String(row[2] || '').trim();
    const name = String(row[3] || '').trim();
    if (!name) continue;
    const cid = resolveClassId(gradeRaw, clsRaw);
    if (!cid){ unrecognized++; continue; }
    if (!grouped[cid]) grouped[cid] = [];
    const prev = ck(cid).find(s => s.name === name); // 기존에 있던 학생이면 배정 제외·성별 값을 유지
    const entry = { number, name, excluded: prev ? !!prev.excluded : false };
    const gender = normalizeGender(row[4]) || (prev && prev.gender) || null;
    if (gender) entry.gender = gender; // Firebase는 undefined를 저장할 수 없으므로 값이 있을 때만 키를 넣는다
    grouped[cid].push(entry);
  }

  const foundClasses = Object.keys(grouped);
  if (!foundClasses.length){
    statusEl.textContent = '❌ 유효한 데이터가 없습니다. 열 순서(학년·반·번호·이름)와 학년 값을 확인해주세요.';
    return;
  }

  // 교무부장 요청(2026-09-16): 누적 횟수는 "반ID + 이름"으로만 구분되는데, 반ID(예: "7-1")는
  // 학년이 올라가도 계속 재사용된다. 그래서 학년이 바뀌며 학생 구성이 통째로 달라지는 새
  // 학년도에는 원래 자동으로 0부터 다시 쌓이지만(새 이름이라 기존 기록이 없으므로), 하필 그
  // 반에 예전에 있었던 학생과 이름이 같은 학생이 새로 들어오면(동명이인) 그 학생이 자기 기록이
  // 아니라 졸업생 등 예전 학생의 남은 누적 횟수를 그대로 이어받아버리는 문제가 있었다. 학기
  // 중 학생 추가·삭제는 이 업로드 없이 각 반 탭에서 하므로, 전교생 명단을 다시 통째로
  // 올리는 시점은 곧 "새 학년도 시작"인 경우가 대부분이다 — 그래서 이 시점에 한 번 확인을
  // 받아, 새 학년도가 맞다면 이번에 업로드되는 반들의 기존 누적 기록을 정리한다.
  const startNewYear = confirm(
    '전교생 명단을 새로 업로드합니다.\n\n' +
    '새 학년도로 시작할까요?\n' +
    '"확인"을 누르면 이번에 명단이 올라가는 반들의 기존 청소 누적 기록(배정 현황의 "누적" 열)이 정리됩니다.\n' +
    '단순히 학생 추가·삭제 등으로 명단만 다시 올리는 것이라면 "취소"를 눌러주세요 — 누적 기록이 그대로 유지됩니다.'
  );

  // 4단계: 저장 (네트워크/권한 문제는 여기서 구분해서 알려준다)
  try{
    await withSync(async () => {
      for (const cid of foundClasses){
        students[cid] = grouped[cid];
        await saveNode(`students/${cid}`, grouped[cid]);
        if (startNewYear){
          assignmentStats[cid] = {};
          await saveNode(`assignmentStats/${cid}`, {});
        }
      }
    });
  } catch(err){
    console.error('명단 저장 오류', err);
    statusEl.textContent = `❌ 읽기는 됐지만 저장 중 오류가 발생했습니다. 인터넷 연결을 확인 후 다시 시도해주세요. (${err.message || err})`;
    return;
  }

  const summary = CLASS_IDS.map(cid => `${cid} ${grouped[cid]?.length || 0}명`).join(', ');
  statusEl.textContent = `✅ 전교생 업로드 완료 — ${summary}` +
    (startNewYear ? ` (새 학년도로 시작 — 이 반들의 기존 누적 기록을 정리했습니다.)` : '') +
    (unrecognized ? ` (학년 값을 인식하지 못한 행 ${unrecognized}개는 건너뜀)` : '') +
    ` · 명단에 없던 반은 그대로 유지됩니다.` +
    ` ⚠ 명단만 갱신되며, 이미 만들어진 배정표에는 자동 반영되지 않습니다 — 각 반 화면에서 "교실청소 자동배정"을 다시 실행해야 새 명단(성별 포함)이 반영됩니다.`;
  showToast('✅ 명단 업로드 완료');
  e.target.value = '';
  renderAll();
});

document.getElementById('clearRosterBtn').addEventListener('click', async () => {
  if (!confirm(`${currentClassId} 명단만 초기화할까요? (다른 반은 그대로 유지되고, 배정 기록은 남습니다)`)) return;
  students[currentClassId] = [];
  await saveNode(`students/${currentClassId}`, []);
});

// ── 갈등 학생 쌍 관리 ────────────────────────────────────────────────
function renderPairSelects(){
  const roster = ck(currentClassId);
  ['pairA','pairB'].forEach(id => {
    const sel = document.getElementById(id);
    sel.innerHTML = '<option value="">학생 선택</option>' + roster.map(s=>`<option value="${s.name}">${s.name}</option>`).join('');
  });
}
function renderPairs(){
  const list = conflictPairs[currentClassId] || [];
  const el = document.getElementById('pairTable');
  if (!list.length){ el.innerHTML = '<p class="desc" data-original-style="8">등록된 쌍이 없습니다.</p>'; return; }
  let html = '<table><tr><th>등록된 쌍</th><th></th></tr>';
  list.forEach((p, idx) => {
    html += `<tr><td>${p.a} ↔ ${p.b}</td><td><button class="btn danger small" data-action-click="${encodeAction("__delPair",[idx])}">해제</button></td></tr>`;
  });
  html += '</table>';
  el.innerHTML = html;
}
window.__delPair = async (idx) => {
  const list = (conflictPairs[currentClassId] || []).slice();
  list.splice(idx, 1);
  conflictPairs[currentClassId] = list;
  await saveNode(`conflictPairs/${currentClassId}`, list);
};
document.getElementById('addPairBtn').addEventListener('click', async () => {
  const a = document.getElementById('pairA').value;
  const b = document.getElementById('pairB').value;
  if (!a || !b || a===b){ alert('서로 다른 두 학생을 선택해주세요.'); return; }
  const list = (conflictPairs[currentClassId] || []).slice();
  if (list.some(p => (p.a===a&&p.b===b) || (p.a===b&&p.b===a))){ alert('이미 등록된 쌍입니다.'); return; }
  list.push({ a, b });
  conflictPairs[currentClassId] = list;
  await saveNode(`conflictPairs/${currentClassId}`, list);
});

// ── 균등배분 통계 도우미 ────────────────────────────────────────────
function priorCumulative(cid, name){
  // 이번 쿼터를 제외한, 그동안 쌓인 누적 횟수/구역별 횟수/보강(F3-d) 횟수
  const rec = (assignmentStats[cid] && assignmentStats[cid][name] && assignmentStats[cid][name].byQuarter) || {};
  let total = 0, extra = 0; const byZone = {};
  Object.keys(rec).forEach(q => {
    if (q === quarter.label) return; // 이번 쿼터는 이번 실행에서 새로 계산
    total += rec[q].total || 0;
    extra += rec[q].extra || 0;
    Object.entries(rec[q].byZone || {}).forEach(([z,n]) => { byZone[z] = (byZone[z]||0) + n; });
  });
  return { total, byZone, extra };
}
function cumulativeTotal(cid, name){
  const rec = (assignmentStats[cid] && assignmentStats[cid][name] && assignmentStats[cid][name].byQuarter) || {};
  return Object.values(rec).reduce((sum, q) => sum + (q.total||0), 0);
}
// "배정 현황" 표에서 구역별·보강별로도 "이번 쿼터" 옆에 "누적"을 나란히 보여달라는 요청
// (2026-09-08)에 따라, 구역 하나·보강에 대해서도 학기 전체(1~4쿼터, 이번 쿼터 포함) 누적을
// 바로 구할 수 있도록 cumulativeTotal과 동일한 방식의 도우미를 추가했다.
function cumulativeByZone(cid, name, zoneName){
  const rec = (assignmentStats[cid] && assignmentStats[cid][name] && assignmentStats[cid][name].byQuarter) || {};
  return Object.values(rec).reduce((sum, q) => sum + ((q.byZone && q.byZone[zoneName]) || 0), 0);
}
function cumulativeExtra(cid, name){
  const rec = (assignmentStats[cid] && assignmentStats[cid][name] && assignmentStats[cid][name].byQuarter) || {};
  return Object.values(rec).reduce((sum, q) => sum + (q.extra||0), 0);
}

// "이번 쿼터" 배정 통계는 배정 과정 중의 임시 카운터에 의존하지 않고, 그때그때
// classroomAssignment에 실제로 저장돼 있는 내용을 직접 세어서 만든다. 이렇게 하면
// 자동배정 실행뿐 아니라 분리수거로 인한 자동 재배정(F4)이나 셀 수동 수정 이후에도
// "배정 현황"이 항상 실제 배정과 어긋나지 않는다.
function recomputeThisQuarterStats(cid){
  const roster = ck(cid);
  const zoneList = zones[cid] || [];
  const data = classroomAssignment[cid] || {};
  const counts = {};
  roster.forEach(s => { counts[s.name] = { total:0, byZone:{}, extra:0 }; });
  (quarter.weeks || []).forEach(w => {
    ASSIGN_DAYS.forEach(day => {
      zoneList.forEach(zone => {
        const cell = data[w.weekNo] && data[w.weekNo][day] && data[w.weekNo][day][zone.name];
        (cell?.names || []).forEach(name => {
          if (!counts[name]) counts[name] = { total:0, byZone:{}, extra:0 }; // 명단에서 빠진 학생 이름이 남아있어도 안전하게 집계
          counts[name].total++;
          counts[name].byZone[zone.name] = (counts[name].byZone[zone.name]||0) + 1;
          if ((cell.extraNames||[]).includes(name)) counts[name].extra++; // 반 인원 부족으로 다른 요일에 보강 배정된 횟수(F3-d)
        });
      });
    });
  });
  const statsUpdate = assignmentStats[cid] ? { ...assignmentStats[cid] } : {};
  Object.keys(counts).forEach(name => {
    const entry = statsUpdate[name] ? { ...statsUpdate[name], byQuarter: { ...statsUpdate[name].byQuarter } } : { byQuarter:{} };
    entry.byQuarter[quarter.label] = counts[name];
    statsUpdate[name] = entry;
  });
  assignmentStats[cid] = statsUpdate;
  return statsUpdate;
}
async function saveStatsForClass(cid){
  const statsUpdate = recomputeThisQuarterStats(cid);
  await saveNode(`assignmentStats/${cid}`, statsUpdate);
}

// ── 요일 고정 배정 (F3, 2026-09-02 확정) ────────────────────────────
// 학생이 한 쿼터 동안 계속 다른 요일에 배정되면 "오늘 청소 있었나?"를 잊어버리기 쉽다.
// 그래서 한 쿼터 안에서는 학생마다 청소 요일(월/화/수/목)을 고정하고, 그 요일 안에서만
// 구역을 주차마다 바꿔가며 균등배분한다. 다음 쿼터가 되면 요일을 하나씩 밀어(월→화→수→목→월)
// 계속 같은 요일만 맡는 학생이 없도록 한다.
function nextWeekday(day){
  const idx = ASSIGN_DAYS.indexOf(day);
  return ASSIGN_DAYS[(idx + 1) % ASSIGN_DAYS.length];
}
// 반 인원이 정원보다 적을 때 그 부족분을 몰아둘 요일(F3-d). 담임마다 반 사정(그 요일이
// 일찍 끝나는지 등)이 다를 수 있어 반별로 선택하게 하고, 아직 선택하지 않은 반은 기존과
// 동일하게 '화'를 기본값으로 쓴다.
// 교무부장 요청(8-1, 2026-10-18, 장한비 사례): 부족분을 한 요일에 모두 몰아주면, 그 요일이
// 하필 분리수거처럼 특정 학생을 영구적으로(매주) 배제시키는 사정과 겹칠 때 "보강 후보 수 <
// 그 요일에 필요한 보강 자리 수"가 되어, 교사가 분리수거 요일을 손으로 조정하지 않는 한
// 누군가는 구조적으로 반드시 보강을 두 번(총 11회) 하게 되는 문제가 생길 수 있다 — 자세한
// 산수는 아래 computeDayTargets 주석 참고. "분리수거 요일을 피해 배정"은 이미 완전히
// 자동으로 되어 있으므로(getRecyclingDays, placeAt), 교사가 매번 손으로 분리수거 요일을
// 조정하게 하는 대신 "지정 안 함"(SHORTFALL_NONE) 옵션을 추가해, 부족분을 한 요일에 몰지
// 않고 4개 요일에 최대한 고르게 나눌 수 있게 했다 — 그러면 하루에 2자리씩 몰아서 채우던
// 것이 여러 요일에 1자리씩 나뉘어, 특정 요일 하나의 보강 후보가 바닥나는 상황 자체가 크게
// 줄어든다.
const SHORTFALL_NONE = '없음';
function getShortfallDay(cid){
  const d = shortfallDay[cid];
  if (d === SHORTFALL_NONE) return SHORTFALL_NONE;
  return ASSIGN_DAYS.includes(d) ? d : '화';
}
// 이 반의 이번 쿼터 요일 배정을 확인·보완한다. 이미 이번 쿼터로 배정된 학생은 그대로 두고,
// 지난 쿼터 기록이 있는 학생은 다음 요일로 옮기고, 기록이 아예 없는 새 학생은 가장 인원이
// 적은 요일에 채워 넣어 4개 요일 인원이 최대한 고르게 유지되도록 한다.
// 담임교사 요청(2026-09-07): 부족분 몰아줄 요일을 반별로 고를 수 있게 하고(F3-d), 반 인원이
// 정원(하루 청소 총 정원, 대개 6명)에 딱 맞지 않을 때 그 부족분이 그 요일에 몰리도록 한다.
// 나머지 3개 요일은 되도록 정원을 꽉 채우고, 선택한 요일이 그러고 남는 인원(부족분)을 맡는다
// — 그러면 다른 요일 학생이 보강으로 불려가는 일도 그 요일에 몰리게 된다(F3-d의 보강 배정은
// 부족한 요일로 다른 요일 학생을 데려오는 방식이므로).
function computeDayTargets(cid, rosterLength){
  const capacity = (zones[cid]||[]).reduce((sum,z) => sum + (z.groupSize||0), 0);
  const target = {};
  const shortDay = getShortfallDay(cid);
  if (capacity > 0 && rosterLength >= capacity){
    if (shortDay === SHORTFALL_NONE){
      // "지정 안 함"(2026-10-18, F3-d 보완): 부족분을 한 요일에 몰지 않고 4개 요일에 최대한
      // 고르게 나눈다. 예를 들어 22명/정원6명이면 기존 방식은 6·6·6·4로 부족분 2명이 전부
      // 한 요일에 몰렸지만, 이 방식은 6·6·5·5로 나뉘어 매주 "보강이 필요한 요일"이 하나가
      // 아니라 둘이 되고 각각 1자리씩만 채우면 된다 — 분리수거처럼 특정 요일의 보강 후보를
      // 영구적으로 줄이는 사정이 있어도, 그 영향이 한 요일에 집중되지 않고 자리 수 자체가
      // 적어 후보가 모자랄 가능성이 훨씬 낮아진다.
      const base = Math.floor(rosterLength / ASSIGN_DAYS.length);
      let extra = rosterLength - base * ASSIGN_DAYS.length;
      ASSIGN_DAYS.forEach(d => {
        target[d] = Math.min(capacity, base + (extra > 0 ? 1 : 0));
        if (extra > 0) extra--;
      });
      return target;
    }
    const fullDays = ASSIGN_DAYS.filter(d => d !== shortDay);
    // 부족분 몰아줄 요일이 완전히 0명이 되지 않도록 최소 1명은 항상 남겨둔다 — 0명이 되면
    // 그 요일은 매주 100% 다른 요일 학생을 빌려와야 해서 보강 부담이 지나치게 커진다. 반
    // 인원이 정원의 세 배 안팎으로 작은 반(예: 6학년)에서는 이 요일이 그냥 0으로 계산되는
    // 경우가 흔했다(F3-d 보완, 2026-09-07). 반 인원이 넉넉한 반(예: 24명/정원6명)은 이
    // 최소값이 실제로는 전혀 영향을 주지 않고 기존과 동일하게 동작한다.
    const minShort = 1;
    const available = Math.max(0, rosterLength - minShort);
    const packed = Math.min(available, capacity * fullDays.length);
    const base = Math.floor(packed / fullDays.length);
    let extra = packed - base * fullDays.length;
    fullDays.forEach(d => {
      target[d] = Math.min(capacity, base + (extra > 0 ? 1 : 0));
      if (extra > 0) extra--;
    });
    const usedByFullDays = fullDays.reduce((s,d) => s + target[d], 0);
    target[shortDay] = Math.max(minShort, Math.min(capacity, rosterLength - usedByFullDays));
  } else {
    // 구역이 아직 등록되지 않았거나(capacity=0), 반 인원이 하루 정원에도 못 미치는 극히
    // 작은 반은 기존처럼 4개 요일에 균등 분배한다.
    const even = Math.ceil(rosterLength / ASSIGN_DAYS.length) || 1;
    ASSIGN_DAYS.forEach(d => target[d] = even);
  }
  return target;
}
// 담임교사 요청(2026-09-09): "분리수거에 작성된 모든 인원은 분리수거 요일이 아닌 다른 요일에
// 청소가 배정되어야 하는 규칙이 있어야해. 8학년1반이든, 8학년 2반이든 말이지." — 처음에는 그
// 학생이 "가장 자주" 나오는 요일 하나만 피하도록 했었는데(그래서 대부분은 "복사"로 모든 주차가
// 같은 요일이라 문제없었지만), 어떤 학생이 주차마다 분리수거 요일이 달라 뚜렷한 "1등 요일"이
// 없으면 그 학생은 전혀 보호되지 않았다 — 그러면 그 학생은 여전히 매주 F4로 다른 요일에
// 옮겨져야 했고, 그 빈자리를 메우려고 강을처럼 관련 없는 다른 학생까지 "자리 맞바꾸기"의
// 상대(파트너)로 불려다니게 됐다(2026-09-09 대화에서 확인). 그래서 "가장 자주 나오는 요일 하나"
// 가 아니라, 분리수거 명단에 그 학생 이름이 **한 번이라도** 나온 요일은 전부 피하도록 넓혔다.
// 특정 반으로 제한하지 않고 데이터로만 판단한다: 분리수거 명단에 이름이 아예 없는 학생(6학년,
// 7-1, 7-2 등 분리수거를 맡지 않는 반)은 피할 요일이 없다고 보고 기존 방식 그대로 배정되므로,
// 결과적으로 분리수거를 실제로 맡는 반(8학년)에서만 효과가 있다.
function getRecyclingDays(name){
  const days = new Set();
  Object.keys(recyclingAssignment || {}).forEach(weekNo => {
    const weekRec = recyclingAssignment[weekNo] || {};
    ASSIGN_DAYS.forEach(d => {
      if ((weekRec[d] || []).includes(name)) days.add(d);
    });
  });
  return days;
}
// 담임교사 요청(2026-09-14, 7.3-s): "기존 규칙적 배정" 모드용 — 요일별 배정 인원 전체(구역
// 구분 없이)를 통틀어 특정 성별이 정확히 1명뿐인 요일이 없도록 고친다(0명이거나 2명 이상만
// 허용). 총 인원수를 바꾸지 않도록, 언제나 "요일 X의 이 성별 1명"과 "요일 Y의 다른 성별 1명"을
// 맞바꾸는 방식으로만 고친다 — 그러면 두 요일의 총 인원은 그대로 유지된 채, 요일 X는 이 성별이
// 0명이 되고 요일 Y는 2명 이상이 된다. 짝이 될 다른 "1명뿐인 요일"이 있으면 그 요일과 맞바꿔
// 한 번에 둘 다 해결하고, 없으면 이미 이 성별이 2명 이상인 요일과 맞바꾼다. 반 전체에 이 성별이
// 너무 적어(예: 1명뿐) 도저히 2명을 채울 요일이 없으면 더 손대지 않고 그대로 둔다. 성별이
// 입력되지 않은 학생은 어느 쪽으로도 세지 않아 건드리지 않는다.
function fixLoneGenderDays(current, roster, genderOfMap){
  let guard = 0;
  while (guard < 200){
    guard++;
    let fixedSomething = false;
    for (const g of ['여','남']){
      const notG = g === '여' ? '남' : '여';
      const dayMembers = {};
      ASSIGN_DAYS.forEach(d => dayMembers[d] = { g: [], notG: [] });
      roster.forEach(s => {
        const day = current[s.name] && current[s.name].day;
        if (!day) return;
        const gg = genderOfMap[s.name];
        if (gg === g) dayMembers[day].g.push(s.name);
        else if (gg === notG) dayMembers[day].notG.push(s.name);
      });
      const loneDays = ASSIGN_DAYS.filter(d => dayMembers[d].g.length === 1);
      if (!loneDays.length) continue;
      const source = loneDays[0];
      const sourcePerson = dayMembers[source].g[0];
      // 담임교사 신고(7-1, 2026-09-22): 수요일에 여학생이 1명만 남는 상황이 자동배정을 다시
      // 돌려도 계속 고쳐지지 않았다 — 원인은 아래에서 "상대 요일"을 고를 때 그 요일에 실제로
      // 맞바꿀 상대(notG)가 있는지 확인하지 않고, 조건(이 성별이 2명 이상)에 맞는 첫 번째
      // 요일을 무조건 썼기 때문이다. 예를 들어 이 성별이 가장 많은 요일이 하필 반대 성별이
      // 0명인 요일이면, 맞바꿀 사람 자체가 없어(candidates가 비어) 바로 아래 "target에 맞바꿀
      // 상대가 없는 경우"로 조용히 건너뛰고 끝나버렸다 — 다른 요일에는 맞바꿀 상대가 있었을
      // 수도 있는데 시도조차 하지 않은 것이다. 이제 "그 요일에 실제로 맞바꿀 상대가 있는지"도
      // 함께 확인해서, 없으면 포기하지 않고 다음 후보 요일을 계속 찾도록 고쳤다.
      let target = loneDays.find(d => d !== source && dayMembers[d].notG.length > 0);
      if (!target) target = ASSIGN_DAYS.find(d => d !== source && dayMembers[d].g.length >= 2 && dayMembers[d].notG.length > 0);
      if (!target) continue; // 반 전체에 맞바꿀 상대가 없어 더 고칠 수 없는 경우 — 그대로 둠
      const candidates = dayMembers[target].notG;
      // 분리수거 요일과 겹치지 않는 상대를 가능하면 우선 고른다.
      const preferred = candidates.find(n => !getRecyclingDays(n).has(source)) || candidates[0];
      current[sourcePerson] = { day: target, quarterLabel: quarter.label };
      current[preferred] = { day: source, quarterLabel: quarter.label };
      fixedSomething = true;
      break; // 한 번에 하나씩만 고치고 처음부터 다시 확인한다(안전하게 수렴시키기 위함)
    }
    if (!fixedSomething) break;
  }
}
// 담임교사 요청(2026-09-15): "최단비와 최건호는 함께 배정되면 안 되는데 함께 배정되고 있다"는
// 신고에 대해, "그럼 둘은 다른 요일로 각각 배정이 되어야 해. 최단비가 월요일이라면 최건호는
// 화요일이어야 하는거지"로 확인 — 갈등 쌍(conflictPairs)은 같은 날 같은 구역이 아니라, 애초에
// "이번 쿼터 청소 요일" 자체가 서로 달라야 한다. 요일 배정이 끝난 뒤 혹시 두 사람이 같은
// 요일로 남아있으면(예: 지난 쿼터부터 유지된 기록, 또는 정원이 꽉 차 다른 방법이 없었던 경우)
// 여기서 마지막으로 한 번 더 훑어 강제로 갈라놓는다.
// 담임교사 재확인(2026-09-19): "황찬율·박소희를 갈등쌍으로 추가했더니 24명인데 보강인원이
// 생겼다. 24명이면 6명씩 4개 조라 보강이 생길 수가 없다 — 갈등이 생기면 요일을 강제로 다른
// 요일로 배정하면 된다"는 지적으로, 처음 버전(인원수가 가장 적은 요일로 그냥 옮기기)이 반
// 인원이 정원에 정확히 맞아떨어지는 반(예: 8-2, 24명=6명×4일)에서 한쪽 요일은 5명, 다른
// 요일은 7명으로 어긋나게 만들어 5명인 요일에 매주 보강이 필요해지는 부작용을 냈다. 그래서
// 한쪽만 옮기지 않고, 반드시 다른 요일의 학생 한 명과 1:1로 맞바꿔(스왑) 요일별 인원수 합이
// 항상 그대로 유지되도록 고쳤다 — 그러면 어떤 반이든(정원에 딱 맞든 아니든) 이 보정 때문에
// 새로 보강이 생기는 일이 없다.
function fixConflictPairDays(current, pairs){
  if (!pairs || !pairs.length) return;
  function partnersOf(name){
    const set = new Set();
    pairs.forEach(q => {
      if (q.a === name) set.add(q.b);
      else if (q.b === name) set.add(q.a);
    });
    return set;
  }
  // name을 day 요일에 두었을 때 갈등이 생기는지 확인한다. excludeName은 "곧 그 요일을
  // 떠날 예정이라 이번 판단에서는 무시해야 할 사람"(스왑 상대방)을 가리킨다.
  function wouldConflict(name, day, excludeName){
    const partners = partnersOf(name);
    if (!partners.size) return false;
    return Object.keys(current).some(other =>
      other !== name && other !== excludeName && partners.has(other) &&
      current[other] && current[other].day === day
    );
  }
  let guard = 0;
  while (guard < 200){
    guard++;
    let fixedSomething = false;
    for (const p of pairs){
      const da = current[p.a] && current[p.a].day;
      const db = current[p.b] && current[p.b].day;
      if (!da || !db || da !== db) continue;
      // a·b가 같은 요일 — b가 안전하게 옮겨갈 다른 요일과, 그 요일에서 대신 da로 넘어와 줄
      // 맞교환 상대를 함께 찾는다. b의 분리수거 회피 요일은 가능하면 피해서 순서를 정한다.
      const avoidForB = getRecyclingDays(p.b);
      const dayOrder = [
        ...ASSIGN_DAYS.filter(d => d !== da && !avoidForB.has(d)),
        ...ASSIGN_DAYS.filter(d => d !== da && avoidForB.has(d)),
      ];
      let done = false;
      for (const targetDay of dayOrder){
        if (wouldConflict(p.b, targetDay)) continue; // b가 그 요일에서도 다른 갈등 상대와 겹침
        const onTarget = Object.keys(current).filter(name =>
          name !== p.a && name !== p.b && current[name] && current[name].day === targetDay
        );
        const swapCandidates = onTarget.filter(name => !wouldConflict(name, da, p.b));
        if (!swapCandidates.length) continue;
        const swapPartner = swapCandidates.find(name => !getRecyclingDays(name).has(da)) || swapCandidates[0];
        current[p.b] = { day: targetDay, quarterLabel: quarter.label };
        current[swapPartner] = { day: da, quarterLabel: quarter.label };
        done = true;
        break;
      }
      if (done){ fixedSomething = true; break; } // 한 번에 하나씩만 고치고 처음부터 다시 확인(안전한 수렴)
    }
    if (!fixedSomething) break;
  }
}
// 담임교사 요청(2026-09-11, 7.3-r-5): "그 외 학년은 명단과 성별을 업로드 하면, 기존 규칙적
// 배정 또는 남녀 구분 배정 선택 우선에 의해서 요일 배정이 되어야해. 특히 남녀배정선택을 했을
// 경우 자동으로 각 요일 배정이 이루어져야 한다는거야." — 지금까지는 요일 배정(이 함수)이 성별을
// 전혀 몰라, 어떤 요일은 우연히 여학생만 몰리는 등 요일 자체가 이미 불균형하게 짜였고, 그 결과를
// "성별 자리 바꾸기"(F3-h 대체) 같은 사후 보정으로 매주 땜질해야 했다(7.3-r-3/4). 이 함수 안에서
// 처음부터 요일별 남/여 목표 인원(genderTarget)을 반 전체의 남/여 비율에 맞춰 미리 정해두고,
// 그 목표에 맞춰 학생을 배치하면 애초에 어긋날 일이 크게 줄어든다. 6학년은 요일을 담임교사가
// 직접 정하므로(7.3-i) 이 로직 대상에서 제외한다(genderAware=false면 기존 방식 그대로 동작).
function ensureWeekdayAssignment(cid, roster, forceReset){
  const current = (weekdayAssignment[cid] && !forceReset) ? { ...weekdayAssignment[cid] } : {};
  const pairs = conflictPairs[cid] || []; // 갈등 쌍(2026-09-15) — 아래 placeAt과 fixConflictPairDays에서 사용
  const counts = {}; ASSIGN_DAYS.forEach(d => counts[d] = 0);
  const target = computeDayTargets(cid, roster.length);
  const shortDay = getShortfallDay(cid);
  const hasShortDay = ASSIGN_DAYS.includes(shortDay); // "지정 안 함"(SHORTFALL_NONE)이면 false — 아래에서 "하나를 몰아줄 요일"로 특별취급하지 않고 4개 요일을 동등하게 다룬다
  const fullDays = hasShortDay ? ASSIGN_DAYS.filter(d => d !== shortDay) : [...ASSIGN_DAYS];

  const genderAware = cid !== '6학년' && !!genderSplitMode[cid];
  // "기존 규칙적 배정"(genderAware=false) 모드의 새 보정(7.3-s, 아래 fixLoneGenderDays)에도
  // 성별 정보가 필요해, 6학년을 제외한 모든 반에서 미리 읽어둔다.
  const genderOf = {};
  if (cid !== '6학년') roster.forEach(s => { if (s.gender) genderOf[s.name] = s.gender; });
  const genderCounts = {}; ASSIGN_DAYS.forEach(d => genderCounts[d] = { '여':0, '남':0 });
  const genderTarget = {}; ASSIGN_DAYS.forEach(d => genderTarget[d] = { '여':0, '남':0 });
  // 기본은 기존 방식(computeDayTargets, "보강 몰릴 요일" 하나가 총 인원 부족분을 전부 떠안음)의
  // 요일별 정원을 그대로 쓴다. genderAware인 경우 아래에서 성별 기준으로 다시 계산해 덮어쓴다.
  let effectiveTarget = target;
  if (genderAware){
    const totalF = roster.filter(s => genderOf[s.name] === '여').length;
    const totalM = roster.filter(s => genderOf[s.name] === '남').length;
    const totalCapacity = (zones[cid]||[]).reduce((sum,z) => sum + (z.groupSize||0), 0);
    if (totalCapacity > 0 && (totalF + totalM) > 0){
      // 담임교사 지적(2026-09-11, 7.3-r-7, 결정적): "목요일을 일부러 4명만 둔 게 아니야. 남녀
      // 구분 배정을 클릭하면 남녀에 따라 요일이 다르게 배정되어야 해." — 7.3-r-5/6까지는 기존
      // "보강 몰릴 요일"(F3-d)이 계산한 "요일별 총 인원" 목표를 그대로 두고 그 안을 성별로 반씩
      // 나누기만 했다. 그런데 이 반(7-1)은 여학생이 12명으로 4개 요일×3명을 정확히 채우고도
      // 남지 않고, 정말 부족한 건 남학생(10명, 12명 필요)뿐이다. 옛 방식은 이 사정을 몰라
      // "총 인원이 부족한 요일 하나"(목)를 통째로 줄여버렸고, 그 바람에 이미 충분한 여학생
      // 자리까지 목요일에서 함께 줄어(여2·남2, 정원4) 매주 2명(성별과 무관하게)을 보강해야
      // 했다 — 이게 정아영이 계속 목요일에 불려간 진짜 이유다.
      // 올바른 방법은 "요일별 총 인원"에서 거꾸로 성별을 나누는 게 아니라, 처음부터 성별마다
      // 따로 "요일당 몇 명이 이상적인가"(교실·그 외 정원이 같다면 전체 정원의 절반)를 정하고,
      // 그 성별이 실제로 모자랄 때만 그 성별만 요일에 나눠 덜 채우는 것이다. 이 반에 적용하면:
      // 여학생은 모자라지 않으니 4개 요일 전부 3명씩 그대로 채워지고, 남학생만 부족한 2명만큼
      // 두 요일에 1명씩 나눠 덜 채워진다. 그 결과 요일 인원은 5·5·6·6명이 되고, 6명인 두 요일은
      // 매주 보강이 아예 필요 없으며, 5명인 두 요일도 매주 정확히 1명(항상 남학생)만 보강하면
      // 된다 — "목요일 매주 2명, 그나마 성별도 안 맞을 수 있음"이던 예전보다 훨씬 낫다.
      const halfCap = totalCapacity / 2;
      const half = {}; ASSIGN_DAYS.forEach(d => half[d] = Math.floor(halfCap));
      // 구역 정원 합이 홀수라 정확히 반으로 안 나뉘면(예: 정원 7명 → 3.5), 나머지 1명을
      // "보강 몰릴 요일"이 아닌 요일부터 순서대로 먼저 준다(그 요일은 어차피 부족분을 더
      // 떠안는 쪽이므로, 남는 1명까지 몰아주지 않기 위함).
      let remCap = totalCapacity - Math.floor(halfCap) * 2;
      if (remCap > 0){
        const capOrder = hasShortDay ? [...fullDays, shortDay] : [...ASSIGN_DAYS];
        for (const d of capOrder){ if (remCap<=0) break; half[d]++; remCap--; }
      }
      // 성별마다 독립적으로: 그 성별이 남거나(diff>0) 모자라면(diff<0) "보강 몰릴 요일"부터
      // 시작해 나머지 요일로 한 바퀴씩 돌며 1명씩 더하거나 뺀다 — 한 요일에 몰아서 크게
      // 어긋나지 않고, 담임교사가 정해둔 "보강 몰릴 요일" 설정도 어느 정도 존중하면서 여러
      // 요일에 나눠 조금씩만 어긋나게 하기 위함이다.
      const spreadOrder = hasShortDay ? [shortDay, ...fullDays] : [...ASSIGN_DAYS];
      function distributeGender(totalG){
        const g = { ...half };
        let diff = totalG - ASSIGN_DAYS.reduce((s,d) => s + half[d], 0);
        let guard = 0;
        while (diff !== 0 && guard < 400){
          let progressed = false;
          for (const d of spreadOrder){
            if (diff === 0) break;
            if (diff > 0){ g[d]++; diff--; progressed = true; }
            else if (diff < 0 && g[d] > 0){ g[d]--; diff++; progressed = true; }
          }
          guard++;
          if (!progressed) break;
        }
        return g;
      }
      const femaleByDay = distributeGender(totalF);
      const maleByDay = distributeGender(totalM);
      ASSIGN_DAYS.forEach(d => { genderTarget[d] = { '여': femaleByDay[d], '남': maleByDay[d] }; });
      effectiveTarget = {};
      ASSIGN_DAYS.forEach(d => { effectiveTarget[d] = genderTarget[d]['여'] + genderTarget[d]['남']; });
    }
  }

  const rotate = [];
  const brandNew = [];
  roster.forEach(s => {
    const rec = current[s.name];
    // 교무부장 보고(8-1, 2026-10-07, 최시온 사례 — "분리수거 수요일인데 정기 청소 요일도
    // 수요일로 묶여서 정기 요일이 아예 없어"): 이 학생의 요일이 처음 정해질 때는 아직
    // 분리수거 명단에 이름이 없어(또는 나중에 분리수거 당번이 바뀌어) getRecyclingDays가
    // 비어 있었고, 그래서 피해야 할 요일 없이 수요일로 배정됐다. 그 뒤 분리수거 명단에
    // "최시온 = 수요일"이 입력됐지만, 바로 아래 "이미 이번 쿼터에 배정됨 — 그대로 유지"
    // 규칙 때문에 자동배정을 몇 번을 다시 돌려도 그 수요일 배정이 전혀 재검토되지 않았다.
    // 그 결과 이 학생은 매주 자기 요일(수)에 분리수거와 겹쳐 한 번도 "정기" 배정을 받지
    // 못하고, 대신 F3-h(자리 바꾸기)가 "총 배정 횟수가 계속 0에 가깝다"고 오판해 다른
    // 요일의 보강 후보로 거의 매주 불려다니는 부작용까지 낳았다. 이미 배정된 날이라도
    // 그 사이 분리수거 명단이 바뀌어 지금은 그 요일과 겹치게 됐다면, "그대로 유지"하지
    // 않고 다른 안전한 요일로 다시 배치한다(아래 rotate와 동일하게 placeAt의 분리수거
    // 회피 로직을 다시 타도록 함).
    const currentConflictsRecycling = rec && rec.quarterLabel === quarter.label && ASSIGN_DAYS.includes(rec.day) && getRecyclingDays(s.name).has(rec.day);
    if (forceReset){
      // 체크박스로 강제 재계산: 기존 요일 기록은 무시하고 전원을 새 규칙(부족분→선택한 요일)에
      // 따라 다시 배치한다.
      brandNew.push(s.name);
    } else if (rec && rec.quarterLabel === quarter.label && ASSIGN_DAYS.includes(rec.day) && !currentConflictsRecycling){
      counts[rec.day]++; // 이미 이번 쿼터에 배정됨, 분리수거와도 안 겹침 — 그대로 유지
      const g = genderAware ? genderOf[s.name] : null;
      if (g) genderCounts[rec.day][g] = (genderCounts[rec.day][g]||0) + 1;
    } else if (rec && ASSIGN_DAYS.includes(rec.day)){
      rotate.push(s.name); // 지난 쿼터 요일이 있거나(다음 요일로 이동), 이번 쿼터 요일이 분리수거와 겹치게 됨(재배치)
    } else {
      brandNew.push(s.name); // 요일 기록이 없는 학생(신입생 등)
    }
  });

  // 자리를 찾을 때 부족분 몰아줄 요일은 맨 나중에 고려한다 — 나머지 3개 요일이 정원을 다
  // 채우고 나서야 그 요일로 넘어가도록 해, 부족분이 그 요일에 몰리게 한다.
  const searchOrder = hasShortDay ? [...fullDays, shortDay] : [...ASSIGN_DAYS];
  // 갈등 쌍(2026-09-15): 이름을 넣으면 그 학생의 갈등 상대가 "이미 이번 배정에서" 차지한
  // 요일들을 돌려준다 — rotate/brandNew 처리 순서와 무관하게, 먼저 배정된 쪽의 요일을 나중에
  // 배정되는 쪽이 피하는 방식으로 항상 서로 다른 요일이 되도록 한다.
  function getConflictDays(name){
    const days = new Set();
    pairs.forEach(p => {
      let partner = null;
      if (p.a === name) partner = p.b;
      else if (p.b === name) partner = p.a;
      if (partner && current[partner] && ASSIGN_DAYS.includes(current[partner].day)) days.add(current[partner].day);
    });
    return days;
  }
  function placeAt(name, preferredDay){
    let order = [preferredDay, ...searchOrder.filter(d => d !== preferredDay)];
    // 분리수거 명단에 이 학생 이름이 나온 요일은 전부 뒤로 미룬다(2026-09-09 확정, 요일 하나가
    // 아니라 전부 피하도록 범위를 넓힘) — 자리가 있는 다른(분리수거 아닌) 요일을 먼저 쓰고,
    // 정말 다른 자리가 하나도 없을 때만 마지막 수단으로 분리수거 요일을 쓴다(그래야 피할 요일이
    // 없는 극단적인 경우에도 배정 자체가 막히지 않는다).
    const avoidDays = getRecyclingDays(name);
    // 담임교사 확인(2026-09-15): 갈등 쌍은 같은 요일에 배정되면 안 된다 — 분리수거 회피보다
    // 우선순위가 높다고 보고, 둘 다 피해야 하는 요일이 있으면 분리수거보다 갈등 요일을 더
    // 강하게 피한다(순위: 둘 다 안전 > 분리수거만 겹침 > 갈등만 겹침 > 둘 다 겹침).
    const conflictDays = getConflictDays(name);
    const rank = (d) => (conflictDays.has(d) ? 2 : 0) + (avoidDays.has(d) ? 1 : 0);
    order = order
      .map((d, i) => ({ d, i }))
      .sort((x, y) => (rank(x.d) - rank(y.d)) || (x.i - y.i)) // 안정 정렬: 같은 순위 안에서는 기존 순서 유지
      .map(x => x.d);
    const g = genderAware ? genderOf[name] : null;
    let day = null;
    if (g){
      // 성별을 아는 학생은 "그 요일의 성별 목표"가 아직 남은 요일을 우선한다. (성별 미상 학생은
      // 목표를 세우지 않았으므로 아래 기존 방식 그대로 전체 정원 기준으로 배정된다.)
      day = order.find(d => (genderCounts[d][g]||0) < (genderTarget[d][g]||0));
    }
    if (!day) day = order.find(d => counts[d] < effectiveTarget[d]); // 성별 목표 달성 후 남는 자리 또는 성별 미상 학생
    if (!day) day = preferredDay; // 모든 요일이 이미 정원을 채운 이례적인 경우 — 선호 요일 그대로 사용
    current[name] = { day, quarterLabel: quarter.label };
    counts[day]++;
    if (g) genderCounts[day][g] = (genderCounts[day][g]||0) + 1;
  }

  // 배정 순서(2026-09-09 추가): 반 인원이 하루 정원×4일에 정확히 맞아떨어지는 반(예: 8-2,
  // 24명/정원6명)은 요일 배정에 남는 자리가 전혀 없는 "꽉 찬 퍼즐"이다. 이런 반에서 그냥
  // 명단 순서대로(위 rotate 다음 brandNew) 한 명씩 자리를 채우면, 피해야 할 분리수거 요일이
  // 적어(선택지가 넓은) 먼저 처리된 학생들이 안전한 요일의 남은 자리를 미리 차지해버려서,
  // 정작 피해야 할 요일이 많아(선택지가 좁은) 학생은 뒤늦게 처리될 때 안전한 요일에 자리가
  // 하나도 안 남아 어쩔 수 없이 자기 분리수거 요일에 배정되는 경우가 생겼다(김진우·이윤아가
  // getRecyclingDays를 모든 요일로 넓힌 뒤에도 계속 보강으로 밀리는 문제, 2026-09-09 대화에서
  // 확인 — 강을처럼 피할 요일이 하나뿐인 학생은 이미 해결됐지만, 피할 요일이 여러 개인
  // 학생에게는 순서 문제가 남아있었다). 그래서 피해야 할 요일 수(avoidCount)가 많은, 즉
  // 선택지가 좁은 학생부터 먼저 안전한 요일을 골라 가도록 순서를 바꾼다 — 선택지가 넓은(대부분의)
  // 학생은 뒤에 처리돼도 어차피 남는 안전한 요일 중 아무 데나 갈 수 있으므로 손해가 없다.
  // (Array.sort는 안정 정렬이라 avoidCount가 같은 — 대부분의 분리수거 없는 — 학생들끼리는
  // 원래 순서(rotate 먼저, 그 다음 brandNew, 각각 명단 순)가 그대로 유지된다.)
  const placeOrder = [
    ...rotate.map(name => ({ name, cohort: 'rotate' })),
    ...brandNew.map(name => ({ name, cohort: 'brandNew' })),
  ];
  placeOrder.forEach(item => { item.avoidCount = getRecyclingDays(item.name).size; });
  // 담임교사 지적(2026-09-22): "이번 쿼터 요일 배정도 새로 계산"을 체크해도 거의 안 섞이는
  // 것 같다 — 확인해보니 이 함수엔 원래 무작위 요소가 전혀 없어서, 학생 명단 순서·구역
  // 정원·보강 요일 설정이 그대로면 몇 번을 다시 계산해도 항상 완전히 같은 결과가 나왔다
  // (아래 정렬이 안정 정렬이라, avoidCount가 같은 학생끼리는 항상 명단에 올라간 순서
  // 그대로 배치됐기 때문). 담임교사 확인: "완전 새롭게 섞이되, 기존 규칙(분리수거 회피,
  // 갈등쌍 회피, 성별 목표 등)은 그대로 지켜졌으면 좋겠다"는 것— 그래서 "이번 쿼터 요일
  // 배정도 새로 계산"을 체크했을 때만(forceReset) 배치 순서 자체를 무작위로 섞어둔다.
  // avoidCount 우선순위(아래 정렬)는 그대로 유지되므로, 분리수거 때문에 피할 요일이 많은
  // 학생이 먼저 안전한 자리를 고르는 원칙은 안 바뀌고, 그 우선순위 안에서 "누가 어느
  // 요일로 가는지"만 매번 달라진다 — 이후의 성별 목표·갈등쌍 회피 등은 placeAt이 매번
  // 다시 확인하므로 규칙 자체가 깨지는 일은 없다. 체크하지 않았을 때(기존 유지)는 무작위성
  // 없이 그대로 두어, 이미 배정된 학생들의 요일이 자동배정을 반복 실행해도 안정적으로
  // 유지되게 한다.
  if (forceReset){
    for (let i = placeOrder.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [placeOrder[i], placeOrder[j]] = [placeOrder[j], placeOrder[i]];
    }
  }
  placeOrder.sort((a, b) => b.avoidCount - a.avoidCount);
  placeOrder.forEach(item => {
    if (item.cohort === 'rotate'){
      placeAt(item.name, nextWeekday(current[item.name].day));
    } else {
      const g = genderAware ? genderOf[item.name] : null;
      let emptiest = null;
      if (g){
        emptiest = fullDays.filter(d => (genderCounts[d][g]||0) < (genderTarget[d][g]||0))
          .sort((a,b) => (genderCounts[a][g]||0) - (genderCounts[b][g]||0))[0];
      }
      if (!emptiest) emptiest = fullDays.filter(d => counts[d] < effectiveTarget[d]).sort((a,b)=>counts[a]-counts[b])[0];
      placeAt(item.name, emptiest || (hasShortDay ? shortDay : ASSIGN_DAYS[0]));
    }
  });

  // 담임교사 요청(2026-09-14, 7.3-s): "기존 규칙적 배정"(남녀 구분 배정을 쓰지 않는 반)에서도,
  // 하루에 배정된 인원 전체를 통틀어 특정 성별이 정확히 1명뿐인 날이 생기지 않아야 한다 — 0명
  // 이거나 2명 이상만 허용(꼭 같은 구역일 필요는 없고, 그날 전체 인원 중에 그 성별이 2명 이상
  // 있으면 된다. 예: 교실 남남여·1인 구역 여·2인 구역 남남은 그날 전체 여학생이 2명이라 허용,
  // 교실 남남남·1인 구역 여·2인 구역 남남은 그날 전체 여학생이 1명뿐이라 금지). 정원 2명인
  // 구역이 이미 동일 성별로만 구성되는 규칙(F3-a)과는 별개로 적용된다. "남녀 구분 배정"이 켜진
  // 반은 요일 배정 자체가 이미 훨씬 정교하게 성별을 맞추고 있어(7.3-r-7) 이 문제가 사실상 생기지
  // 않으므로 대상에서 제외하고, 6학년도 요일을 담임교사가 직접 정하므로 제외한다.
  if (cid !== '6학년' && !genderAware){
    fixLoneGenderDays(current, roster, genderOf);
  }

  // 갈등 쌍(2026-09-15): 위 placeAt에서 대부분 걸러지지만, 이미 이번 쿼터로 유지되던 기록(수동
  // 고정 포함)끼리 우연히 같은 요일로 남아있을 수 있으므로 마지막으로 한 번 더 확인해 강제로
  // 갈라놓는다.
  fixConflictPairDays(current, pairs);

  weekdayAssignment[cid] = current;
  return current;
}

// 정원이 2명인 구역에 남녀 단둘이 배정되지 않도록 하는 규칙(F3-a). 두 학생 다 성별이
// 입력돼 있고 서로 다를 때만 "안 됨"으로 판단한다 — 성별을 모르는 학생이 섞여 있으면
// 판단할 수 없으므로 이 규칙에서는 건드리지 않고 기존 방식대로 둔다.
// 정원 2명(남녀 단둘 방지 규칙이 걸리는) 구역을 먼저 채우도록 순서를 바꾼다. 구역을 원래
// 순서대로(대개 정원이 큰 "교실"부터) 채우면, 인원 많은 구역이 그날 후보를 먼저 가져가 버려
// 정작 2명 구역에는 성별이 맞지 않는 인원만 남는 경우가 생길 수 있다 — 2명 구역이 그날 전체
// 후보 중에서 먼저 같은 성별끼리 짝을 고르게 해, 이런 상황을 최대한 줄인다. 화면에 보이는
// 구역 순서(zoneList) 자체는 바꾸지 않고, 배정 계산 순서에만 쓴다.
// 정원 2명(성별 규칙) 구역을 최우선으로, 그 다음은 정원이 작은 구역부터 채운다(F3-c,
// 2026-09-07). 정원이 가장 작은 구역(예: 별관 1명)은 그날 다른 구역들이 인원을 다 뽑아가고
// 남은 사람을 그냥 받는 자리가 되기 쉬운데, 그러면 "누가 그 자리에 갈지"를 이 구역 스스로
// 고를 기회가 없어 특정 학생이 계속 그 구역에만 몰리거나 반대로 전혀 못 가는 문제가 생겼다.
// 정원이 작을수록 먼저 전체 후보 중에서 직접 고르게 하면 이 문제가 크게 줄어든다.
function orderZonesForPicking(zoneList){
  return zoneList.slice().sort((a,b) => {
    const ag = a.groupSize===2 ? 0 : 1, bg = b.groupSize===2 ? 0 : 1;
    if (ag !== bg) return ag - bg;
    return a.groupSize - b.groupSize;
  });
}

// 담임교사 요청(6학년, 2026-09-10) — "요일 우선 배정"(F3-o): 어느 요일에 고정 배정된 학생 수가
// 그날 구역 총 정원보다 적을 때, 다른 요일 학생을 데려와 채우는 대신(F3-d) 구역 정원 자체를
// 그 인원수에 맞춰 줄인다. 어느 구역부터 줄일지는 "정원이 가장 큰 구역부터 줄인다"는 규칙
// (2026-09-10 확정)을 따른다 — 매 1명을 줄일 때마다 그 시점에 정원이 가장 큰 구역을 다시
// 찾으므로, 여러 구역이 동시에 최대이면 자연히 번갈아가며 줄어든다. zoneList 자체(반별 청소구역
// 설정)는 건드리지 않고, 그날 배정에만 쓸 정원이 줄어든 사본을 새로 만들어 반환한다.
// 인원이 정원보다 많거나 같으면(부족하지 않으면) 원래 zoneList를 그대로 돌려준다.
function shrinkZonesToHeadcount(zoneList, headcount){
  let total = zoneList.reduce((sum,z) => sum + (z.groupSize||0), 0);
  if (headcount >= total) return zoneList;
  const shrunk = zoneList.map(z => ({ ...z }));
  while (total > headcount){
    let target = null;
    shrunk.forEach(z => {
      if ((z.groupSize||0) <= 0) return;
      if (!target || z.groupSize > target.groupSize) target = z;
    });
    if (!target) break; // headcount>=0이므로 이론상 도달하지 않음
    target.groupSize -= 1;
    total -= 1;
  }
  return shrunk;
}

// 담임교사 요청(6학년 제외 전 학급, 2026-09-10) — "남녀 구분 배정"(F3-r): "교실"과 "그 외
// 구역"을 통째로 성별로 나눈다. 처음에는 "요일마다" 교실 담당 성별이 바뀌는 규칙으로
// 이해해 구현했는데(월·목=여, 화·수=남), 이어서 "요일·쿼터마다 정해진 규칙"으로 다시
// 정정받아 구현했더니, 실제로 계산해보면 그 규칙은 **학생이 1쿼터에 짝수 요일(월/수)에
// 배정되었는지 홀수 요일(화/목)에 배정되었는지에 따라 교실·그 외 구역이 영원히 고정**되는
// 결과였다(요일이 쿼터마다 하루씩 밀려도 결과는 똑같음) — 예를 들어 같은 여학생이어도
// 처음에 화요일이었던 학생은 평생 "그 외 구역"만 맡게 되는 문제가 있었다. 담임교사 확인
// 결과 실제 의도는 "모든 학생이 골고루 교실청소와 그 외 구역을 돌아가면서 균형있게" —
// 즉 요일이나 출발 요일의 홀짝과 무관하게, 모든 학생이 두 역할을 공평하게 나눠 맡아야
// 한다는 것이었다(2026-09-10 3차 확정, 7.3-r 2차 수정). 여기까지는 "쿼터가 바뀔 때마다
// 반 전체가 통째로 뒤바뀌는 방식"으로 구현했었는데(genderSplitFlip), 담임교사가 곧이어
// "9주차까지 청소를 해야 하니, 한 쿼터 안에서도 모든 학생이 돌아가면서 골고루 해야 한다"고
// 다시 짚어줘서(2026-09-10 4차 확정, 7.3-r 3차 수정), 쿼터 단위만으로는 부족하다는 게
// 확인됐다. 그래서 이제 **주차(1~9주) 단위로도 매주 뒤바뀌는 규칙**을 더했다: 이번 쿼터
// 기준 성별(genderSplitFlip — "이번 쿼터 요일 배정도 새로 계산"을 누를 때마다 쿼터별로
// 전환)을 시작점으로 삼아, 홀수 주차엔 그 성별이 교실을, 짝수 주차엔 반대 성별이 교실을
// 맡는 식으로 매주 번갈아 배정한다(classroomGenderForWeek). 한 쿼터가 보통 9주이므로
// 한쪽 성별이 5주, 다른 쪽이 4주를 맡게 되어 쿼터 내에서도 거의 균등하게 나뉘고, 다음
// 쿼터엔 시작 성별 자체가 뒤집히므로 어느 한쪽이 계속 더 많이 맡는 장기적 편향도 생기지
// 않는다. 요일 자체가 골고루 배치되는 것은 기존 7.3-a(쿼터마다 요일이 하루씩 밀림)가
// 그대로 담당하며, 이 규칙과는 무관하게 계속 유지된다.
function otherGender(g){ return g === '여' ? '남' : (g === '남' ? '여' : null); }
function classroomGenderForWeek(cid, weekNo){
  const base = genderSplitFlip[cid] ? '남' : '여';
  const wn = weekNo || 1;
  return ((wn - 1) % 2 === 0) ? base : otherGender(base);
}
// 이 구역에 배정할 수 있는 성별로 후보를 좁힌다. 정확히 그 성별인 학생이 구역 정원보다
// 적으면(성별 데이터가 비어있는 학생이 있거나, 남녀 인원이 정확히 반반이 아닌 경우), 성별
// 미상 학생까지 포함해 다시 시도한다. 그래도 부족하면(성별 미상까지 합쳐도 정원 미달) 규칙을
// 지키지 못할 수 있다는 경고 문구를 반환하고 전체 후보로 채운다 — 아예 빈 자리로 남기는
// 것보다는 낫다고 보았다(F4의 다른 폴백 단계들과 같은 원칙).
// 담임교사 보고(7-1, 2026-09-10): 화요일에 남학생 전예준이 "그 외 구역"(원래 여학생 자리)에
// 혼자 배정된 사례가 있었다 — 확인해보니 이 요일 여학생이 2명뿐이라 3자리를 못 채워, 아래
// "성별 미상까지 포함" 단계가 조용히 작동해 전예준을 채운 것이었다(전예준의 성별이 명단에
// 입력되어 있지 않아 "성별 미상"으로 분류됨). 이 단계는 원래 "정원 미달"까지는 아니어서 경고
// 문구 없이 조용히 넘어가도록 되어 있었는데, 그 결과 담임교사가 실제로는 다른 원인(성별
// 미입력)인데도 왜 그렇게 배정됐는지 알 수 없었다. 이제 이 단계도 "성별 미상 학생이 포함될
// 수 있다"는 안내 문구를 남기도록 고쳤다 — 정말 그 학생 성별이 규칙과 다르면 학생 명단에서
// 성별을 입력해 다음 자동배정부터 바로잡을 수 있다.
function splitPoolForZone(pool, zone, day, genderOf, cid, weekNo){
  const isClassroom = zone.name === '교실';
  const classroomGender = classroomGenderForWeek(cid, weekNo);
  const requiredGender = isClassroom ? classroomGender : otherGender(classroomGender);
  if (!requiredGender) return { pool, note: null };
  const strict = pool.filter(s => genderOf[s.name] === requiredGender);
  if (strict.length >= zone.groupSize) return { pool: strict, note: null };
  const withUnknown = pool.filter(s => genderOf[s.name] === requiredGender || !genderOf[s.name]);
  if (withUnknown.length >= zone.groupSize){
    const unknownCandidates = withUnknown.filter(s => !genderOf[s.name]).map(s => s.name);
    return {
      pool: withUnknown,
      note: unknownCandidates.length
        ? `ℹ️ ${cid} ${day}요일 ${zone.name} — 이 구역은 ${requiredGender}학생 자리인데 이날 ${requiredGender}학생 수가 부족해, 성별이 입력되지 않은 학생(${unknownCandidates.join(', ')} 중 일부 또는 전부)이 대신 채워졌을 수 있습니다. 실제로는 ${otherGender(requiredGender)}학생이라면, 학생 명단에서 성별을 입력해주세요.`
        : null
    };
  }
  return {
    pool,
    note: `⚠️ ${cid} ${day}요일 ${zone.name} — 남녀 구분 배정 규칙(이 구역은 ${requiredGender}학생)을 지키기에 인원이 부족해, 다른 성별 학생이 포함되었을 수 있습니다. 학생 명단의 성별 입력을 확인해주세요.`
  };
}

// 담임교사 보고(7-1, 2026-09-10): "남녀 구분 배정"이 켜진 반에서, 분리수거와 겹쳐 다른
// 요일로 보강 배정되는 학생(fillMakeupSlots, F4-보강)은 이 규칙을 전혀 확인받지 않고
// 채워지고 있었다 — 그래서 원래 여학생 전용이어야 할 "교실"에 남학생(황석민)이 섞여
// 들어가는 사례가 발생했다. 원인은 fillMakeupSlots가 pickGroup/splitPoolForZone을 거치지
// 않고, 이미 만들어진 배정표의 빈 자리에 직접 학생을 채우거나 자리를 맞바꾸는 별도
// 로직이라, "남녀 구분 배정"이 생기기 전부터 있던 이 함수가 그 규칙을 몰랐기 때문이다.
// splitPoolForZone과 같은 기준(classroomGenderForWeek)으로 "이 구역·이 요일·이 주차엔 이
// 성별이어야 한다"를 판단해, 성별이 확실히 다른 학생은(성별 미상은 기존 폴백 원칙과
// 동일하게 허용) 되도록 이 자리에 넣지 않도록 한다(F3-r 4차 수정).
function zoneGenderBlocked(zone, day, cid, weekNo, genderOf, name){
  if (cid === '6학년' || !genderSplitMode[cid]) return false;
  const isClassroom = zone.name === '교실';
  const classroomGender = classroomGenderForWeek(cid, weekNo);
  const requiredGender = isClassroom ? classroomGender : otherGender(classroomGender);
  if (!requiredGender) return false;
  const g = genderOf[name];
  return !!g && g !== requiredGender;
}

function genderPairBlocked(zone, existingNames, newName, genderOf){
  if (zone.groupSize !== 2) return false;
  const newGender = genderOf[newName];
  if (!newGender) return false;
  return existingNames.some(n => {
    const g = genderOf[n];
    return g && g !== newGender;
  });
}

// ── 교실청소 자동배정 (F3) ──────────────────────────────────────────
// keepNames: 이 구역에 이미 확정되어 그대로 남는 인원(F4 단일 요일 재계산에서, 분리수거와
// 무관해 자리를 지키는 학생들). 지정하면 이 인원은 그대로 두고 부족한 자리만 새로 채운다.
// weekNo: "규칙적 배정" 모드에서 이 구역을 가장 오래 전에(또는 아직 한 번도) 맡지 않은 학생을
// 우선하는 회전 방식의 동점자 처리에 쓰인다 (2026-09-07, 아래 설명 참고).
function pickGroup(zone, day, dateRecycling, usedToday, roster, pairs, running, mode, genderOf, keepNames, weekNo){
  genderOf = genderOf || {};
  keepNames = keepNames || [];
  let available = roster.filter(s => !dateRecycling.includes(s.name) && !usedToday.has(s.name) && !keepNames.includes(s.name));
  available = available.map(s => ({
    s,
    total: running[s.name].total,
    zn: running[s.name].byZone[zone.name] || 0,
    // 이번 쿼터 들어서만 이 구역을 해본 횟수(지난 쿼터 기록은 포함하지 않음) — F3-q, 아래 설명 참고.
    qZn: (running[s.name].qByZone && running[s.name].qByZone[zone.name]) || 0,
    // 이 구역을 마지막으로 맡은 주차(없으면 -1) — "규칙적 배정" 모드의 동점자 처리에 쓰인다.
    lastAt: (running[s.name].lastZoneWeek && running[s.name].lastZoneWeek[zone.name] != null) ? running[s.name].lastZoneWeek[zone.name] : -1,
    rnd: Math.random()
  }));
  available.sort((x,y) => {
    // 담임교사 보고(6학년, 2026-09-10): 하루에 3명뿐인 작은 요일 그룹(화요일 이남우·홍기찬·
    // 이유현)에서, 이유현이 "동편출입구"만 계속 맡고 "교실"은 전혀 못 맡는 현상이 있었다.
    // 원인은 zn(지난 쿼터까지 포함한 이 구역 누적)을 그대로 우선순위 1순위로 쓰다 보니, 한
    // 학생이 예전 쿼터에 그 구역을 남들보다 많이 해왔다면 그 격차가 한 주에 1씩만 좁혀져
    // 공평해질 때까지 여러 주(심하면 한 쿼터 내내)가 걸릴 수 있었던 것이다. 인원이 많은 반은
    // 매주 돌아가는 폭이 넓어 이 격차가 금방 다른 방식으로도 흡수되지만, 화요일처럼 아주 작은
    // 그룹은 그 폭이 없어 격차가 고스란히 몇 주씩 이어진다. 담임교사 확인 결과 "지난 쿼터
    // 기록까지 포함한 장기적 공평함"보다 "이번 쿼터 안에서 눈에 보이게 돌아가는 것"이 더
    // 중요하다는 것을 확인해(2026-09-10, F3-q), **이번 쿼터 들어서만의 횟수(qZn)를 zn(지난
    // 쿼터까지 포함한 누적)보다 먼저** 비교하도록 우선순위를 추가했다. 이번 쿼터 기록만 보면
    // 모든 학생이 0에서 시작하므로, 지난 쿼터 격차가 아무리 커도 이번 쿼터 안에서는 그 격차와
    // 무관하게 골고루 도는 것이 보장된다. qZn이 같을 때만(이번 쿼터 안에서 이 구역을 해본
    // 횟수가 똑같을 때만) 지난 쿼터까지 포함한 zn을 그다음 우선순위로 사용해, 이번 쿼터 기록이
    // 동점인 학생들 사이에서는 여전히 장기적 공평함도 함께 고려된다.
    if (x.qZn !== y.qZn) return x.qZn - y.qZn;
    // "이 구역"을 얼마나 해봤는지(zn)를 총 배정 횟수(total)보다 먼저 비교한다 (F3-c 3차 수정,
    // 2026-09-08). 예전에는 total을 먼저 봤는데, 반 인원이 정원(하루 청소 총 정원)에 딱 맞지
    // 않아 다른 요일 학생이 "보강"으로 한 번씩 더 서게 되는 반(7.3-d)에서는, 보강을 한 번이라도
    // 한 학생의 total이 같은 요일 친구들보다 영구히 1 높아진다 — total이 1순위이던 예전 방식은
    // 이 학생을 그 뒤로 쭉 "총량이 더 많으니 밀린다"고 보고, 정원이 타이트한 구역(밴드실 1명·
    // 강당 2명)에서 매번 밀려나 정원이 넉넉한 구역(교실)에만 몰아넣었다 — 그 결과 학기 내내
    // 특정 구역에 단 한 번도 못 가는 학생이 실제로 발생했다(담임 보고: 7-1 김여명, 7-2 전효재·
    // 양서아 등). zn을 먼저 보면 "이 구역을 아직 못 해본 사람"이 total과 무관하게 항상
    // 최우선이 되어, 보강 1회 정도의 총량 차이가 구역 배정 자체를 막지 못한다. total은 그
    // 다음 순위로 남겨 두어(같은 zn일 때는 총량이 적은 쪽을 우선), 전체 업무량 균형도 계속
    // 함께 고려된다.
    if (x.zn !== y.zn) return x.zn - y.zn;
    if (x.total !== y.total) return x.total - y.total;
    // 그래도 완전히 같은 학생들 사이의 최종 동점자 처리. "랜덤 배정"은 그때그때 무작위로,
    // "규칙적 배정"은 이 구역을 가장 오래 전에(또는 아직 한 번도) 맡지 않은 학생을 우선해
    // 정해진 규칙대로 돌아가며 배정한다 — 예전에는 이 경우 항상 명단 순서상 앞쪽 학생이
    // 이기는 방식이라, 특정 학생이 쿼터 내내 계속 밀려 특정 구역에 한 번도 못 가는 치우침이
    // 있었다(F3-c 2차 수정, 2026-09-07).
    if (x.lastAt !== y.lastAt) return x.lastAt - y.lastAt;
    return mode === 'random' ? x.rnd - y.rnd : 0;
  });
  const conflicts = (name, pickedNames) => pairs.some(p =>
    (p.a===name && pickedNames.includes(p.b)) || (p.b===name && pickedNames.includes(p.a))
  );

  let pickedNames = keepNames.slice();
  let pickedNew = [];

  // 정원이 정확히 2명인 구역은(F3-b), 갈등쌍이 아니고 성별도 서로 다르지 않은(둘 중 하나라도
  // 성별 미상이면 통과) 조합 중에서 두 사람의 이 구역 누적 횟수 합이 가장 작은 조합을 고른다.
  // (F3-c, 2026-09-07: 예전에는 누적이 가장 적은 학생부터 순서대로 보다가 처음 맞는 상대를
  // 그냥 썼는데, 예를 들어 남학생이 소수인 반에서는 남학생끼리의 조합이 하나뿐이다 보니
  // 이 방식으로는 그 조합이 뒤로 밀려 계속 배정 기회를 놓치는 경우가 있었다. 두 사람 합산
  // 기준으로 가장 배정이 필요한 조합을 직접 고르면 이런 치우침이 줄어든다.) 이렇게 하면:
  // (1) 성별이 서로 다른 두 명이 정원 2명 구역에 단둘로 남지 않고, (2) 짝을 못 찾아 밀려나는
  // 건 정말 같은 성별 상대가 없는 경우로 한정되며, (3) 성별을 아직 입력하지 않은 학생은
  // 누구와도 짝이 될 수 있으므로 이 구역에서 부당하게 배제되지 않는다.
  // (keepNames로 이미 한 명이 고정된 경우는 이 조합 탐색을 건너뛰고 아래 일반 루프에서
  // 그 고정 인원 기준으로 짝을 채운다.)
  if (zone.groupSize === 2 && keepNames.length === 0){
    let best = null;
    for (let i=0; i<available.length; i++){
      for (let j=i+1; j<available.length; j++){
        const a = available[i], b = available[j];
        if (conflicts(a.s.name, [b.s.name]) || conflicts(b.s.name, [a.s.name])) continue;
        if (genderPairBlocked(zone, [a.s.name], b.s.name, genderOf)) continue;
        // F3-q(2026-09-10): 이번 쿼터 들어서만의 구역 경험(qZn)을 가장 먼저 비교해, 지난
        // 쿼터까지 포함한 누적 격차가 아무리 커도 이번 쿼터 안에서는 골고루 돌아가도록 한다
        // (위 일반 루프의 정렬 기준과 동일한 이유 — 자세한 설명은 그쪽 주석 참고).
        const qScore = a.qZn + b.qZn;
        const score = a.zn + b.zn;
        // score(이 구역 누적 합)가 같은 조합이 여럿일 때는, 총 배정 횟수(total) 합이 더 적은
        // 조합을 우선한다 — 보강(F3-d)을 한 번 더 선 학생이 있어 total이 살짝 높아도, 이 구역
        // 누적(zn)이 이미 동점으로 가장 낮다면 총량 비교는 그 다음 순위로만 쓰인다(F3-c 3차
        // 수정, 2026-09-08 — 위 일반 루프의 zn 우선순위 변경과 같은 이유).
        const totalSum = a.total + b.total;
        // 그래도 같은 조합이 여럿일 때는, 둘 다 이 구역을 가장 오래 전에(또는 아직 한 번도)
        // 맡지 않은 조합을 우선한다 — 예전에는 이 경우 항상 available 배열에서 먼저 나오는
        // 조합이 이겨서, 특정 두 명(주로 명단 앞쪽)이 반복해서 같은 조합으로만 뽑히는 치우침이
        // 있었다(F3-c 2차 수정, 2026-09-07).
        const lastSum = a.lastAt + b.lastAt;
        if (!best || qScore < best.qScore ||
            (qScore === best.qScore && score < best.score) ||
            (qScore === best.qScore && score === best.score && totalSum < best.totalSum) ||
            (qScore === best.qScore && score === best.score && totalSum === best.totalSum && lastSum < best.lastSum)){
          best = { a, b, qScore, score, totalSum, lastSum };
        }
      }
    }
    if (best){ pickedNames = [best.a.s.name, best.b.s.name]; pickedNew = [best.a, best.b]; }
  }

  for (const c of available){
    if (pickedNames.length >= zone.groupSize) break;
    if (pickedNames.includes(c.s.name)) continue;
    if (conflicts(c.s.name, pickedNames)) continue;
    if (genderPairBlocked(zone, pickedNames, c.s.name, genderOf)) continue;
    pickedNames.push(c.s.name); pickedNew.push(c);
  }
  if (pickedNames.length < zone.groupSize){
    for (const c of available){
      if (pickedNames.length >= zone.groupSize) break;
      if (pickedNames.includes(c.s.name)) continue;
      if (conflicts(c.s.name, pickedNames)) continue;
      pickedNames.push(c.s.name); pickedNew.push(c); // 성별 짝을 완전히 맞출 인원이 부족한 경우의 대안 (갈등쌍은 여전히 피함)
    }
  }
  if (pickedNames.length < zone.groupSize){
    for (const c of available){
      if (pickedNames.length >= zone.groupSize) break;
      if (pickedNames.includes(c.s.name)) continue;
      pickedNames.push(c.s.name); pickedNew.push(c); // 갈등쌍을 완전히 피할 인원이 부족한 극단적 경우의 최후 대안
    }
  }
  pickedNew.forEach(c => {
    usedToday.add(c.s.name);
    running[c.s.name].total++;
    running[c.s.name].byZone[zone.name] = (running[c.s.name].byZone[zone.name]||0) + 1;
    if (!running[c.s.name].qByZone) running[c.s.name].qByZone = {};
    running[c.s.name].qByZone[zone.name] = (running[c.s.name].qByZone[zone.name]||0) + 1;
    if (weekNo != null){
      if (!running[c.s.name].lastZoneWeek) running[c.s.name].lastZoneWeek = {};
      running[c.s.name].lastZoneWeek[zone.name] = weekNo;
    }
  });
  keepNames.forEach(n => usedToday.add(n));
  return pickedNames;
}

// 이번 주 자기 요일에 분리수거가 겹쳐서 청소를 못 하게 된 학생을, 같은 주 다른 요일에
// 아직 정원이 안 찬 구역이 있으면 그 자리에 보강 배정한다. 정원을 넘겨서 끼워 넣지는
// 않는다 — 원래 그 요일 그룹만으로는 다 못 채워 비어있었을 자리를 채우는 것뿐이라
// 다른 학생의 자리를 뺏지 않는다. weekAssignment는 {day:{zoneName:{names,manuallyEdited}}} 형태.
function fillMakeupSlots(cid, weekNo, weekAssignment, usedByDay, running, roster, wdMap, zoneList, pairs, genderOf){
  genderOf = genderOf || {};
  const recForWeek = recyclingAssignment[weekNo] || {};
  const displaced = roster.filter(s => {
    const fixedDay = (wdMap[s.name] || {}).day;
    if (!fixedDay || !ASSIGN_DAYS.includes(fixedDay)) return false;
    return (recForWeek[fixedDay] || []).includes(s.name);
  }).sort((a,b) => (running[a.name]?.total||0) - (running[b.name]?.total||0)); // 누적 적은 학생 우선

  const notes = [];
  const wouldConflict = (name, others) => pairs.some(p =>
    (p.a===name && others.includes(p.b)) || (p.b===name && others.includes(p.a)));

  displaced.forEach(s => {
    const fixedDay = wdMap[s.name].day;
    if (!running[s.name]) running[s.name] = { total:0, byZone:{}, qByZone:{} };

    // 담임교사 보고(8-1, 2026-09-29, 노서아·김태은 사례 — "왜 11회가 나오지?"): 이 학생이
    // 자기 요일(fixedDay)에 분리수거와 겹쳐 빠졌더라도, 그 주 다른 요일에 이미 F3-d(보강)나
    // F3-h(자리 바꾸기)로 한 번 배정된 상태라면 이번 주 몫은 이미 채워진 것이다. 그런데
    // 이 함수가 그 사실을 확인하지 않고 무조건 "자기 요일 분리수거 = 이번 주 보강 필요"로
    // 판단해 또 한 번 자리를 만들어주다 보니, 목요일(ASSIGN_DAYS의 마지막 처리 요일) 소속
    // 학생이 같은 주 수요일 보강 게스트로 뽑히고 하필 목요일에 분리수거 당번까지 겹치면
    // 그 주에만 2회 배정되어(보강 1회 + 분리수거 보강 1회) 쿼터 합계가 9~10회가 아니라
    // 11회로 튀는 결과가 나왔다. 이번 주 다른 요일에 이미 배정된 적이 있으면(usedByDay로
    // 확인) 분리수거 보강 자체를 건너뛰도록 해 이중 배정을 막는다 — 이미 이번 주 몫을
    // 다른 요일에 받았으므로 "이번 주 청소를 아예 못 했다"는 전제 자체가 성립하지 않는다.
    const alreadyAssignedThisWeek = ASSIGN_DAYS.some(day => day !== fixedDay && usedByDay[day] && usedByDay[day].has(s.name));
    if (alreadyAssignedThisWeek){
      notes.push(`ℹ️ ${cid} ${weekNo}주차 — ${s.name} 학생이 ${fixedDay}요일 분리수거와 겹쳤지만, 이번 주 다른 요일에 이미 보강 배정을 받아 추가 보강 없이 넘어갔습니다.`);
      return;
    }
    let placed = false;

    // 1차(맞바꾸기, 우선 시도): 이 학생이 분리수거 때문에 자기 요일(fixedDay)에서 빠지면,
    // 보통 그 요일 어느 구역엔가 원래 이 학생이 채웠을 빈 자리가 하나 생긴다. 이 학생 본인은
    // 오늘이 분리수거일이라 그 자리에 못 들어가므로, 다른 요일에 이미 배정된 학생 한 명과
    // "자리를 맞바꾼다" — 그 학생은 오늘 이 빈 자리로, 이 학생은 그 학생이 있던 다른 요일 자리로.
    // 이렇게 하면 어느 구역도 정원을 넘기지 않고, 매번 다른 상대와 바뀌면서 여러 구역을
    // 골고루 경험하게 된다.
    const openings = zoneList.filter(zone => {
      const cell = weekAssignment[fixedDay] && weekAssignment[fixedDay][zone.name];
      return cell && !cell.manuallyEdited && (cell.names||[]).length < zone.groupSize;
    });
    if (openings.length){
      const swapCandidates = [];
      for (const day of ASSIGN_DAYS){
        if (day === fixedDay) continue;
        if ((recForWeek[day] || []).includes(s.name)) continue; // 이 요일도 분리수거면 이 학생이 옮겨갈 수 없음
        for (const zone of zoneList){
          const cell = weekAssignment[day] && weekAssignment[day][zone.name];
          if (!cell || cell.manuallyEdited) continue;
          for (const partner of (cell.names||[])){
            if ((recForWeek[fixedDay] || []).includes(partner)) continue; // 상대가 옮겨갈 fixedDay에 하필 분리수거 당번이면 그 자리로 보낼 수 없음
            const remaining = (cell.names||[]).filter(n => n !== partner);
            if (wouldConflict(s.name, remaining)) continue; // 이 학생이 그 구역으로 가면 갈등쌍 발생
            if (genderPairBlocked(zone, remaining, s.name, genderOf)) continue; // 정원 2명 구역에 남녀 단둘 발생
            if (zoneGenderBlocked(zone, day, cid, weekNo, genderOf, s.name)) continue; // "남녀 구분 배정" 규칙(F3-r) 위반
            const opening = openings.find(oz => {
              const ocell = weekAssignment[fixedDay][oz.name];
              if (wouldConflict(partner, ocell.names||[])) return false;
              if (genderPairBlocked(oz, ocell.names||[], partner, genderOf)) return false; // 상대가 빈 자리로 가면 남녀 단둘 발생
              if (zoneGenderBlocked(oz, fixedDay, cid, weekNo, genderOf, partner)) return false; // 상대가 빈 자리로 가면 남녀 구분 배정 규칙 위반
              return true;
            });
            if (!opening) continue; // 상대가 빈 자리로 가면 갈등쌍/남녀 단둘 발생
            swapCandidates.push({ day, zone, partner, opening, zoneCount: running[s.name].byZone[zone.name] || 0 });
          }
        }
      }
      if (swapCandidates.length){
        swapCandidates.sort((a,b) => a.zoneCount - b.zoneCount); // 이 학생이 가장 적게 해본 구역 우선
        const { day, zone, partner, opening } = swapCandidates[0];
        const fromCell = weekAssignment[day][zone.name];
        const toCell = weekAssignment[fixedDay][opening.name];
        fromCell.names = (fromCell.names||[]).filter(n => n !== partner);
        fromCell.names.push(s.name);
        if (!toCell.names) toCell.names = [];
        toCell.names.push(partner);
        if (!usedByDay[fixedDay]) usedByDay[fixedDay] = new Set();
        usedByDay[fixedDay].add(partner);
        if (!usedByDay[day]) usedByDay[day] = new Set();
        usedByDay[day].delete(partner);
        usedByDay[day].add(s.name);
        if (running[partner]){
          running[partner].byZone[zone.name] = Math.max(0, (running[partner].byZone[zone.name]||0) - 1);
          running[partner].byZone[opening.name] = (running[partner].byZone[opening.name]||0) + 1;
        }
        running[s.name].total++;
        running[s.name].byZone[zone.name] = (running[s.name].byZone[zone.name]||0) + 1;
        notes.push(`ℹ️ ${cid} ${weekNo}주차 — ${s.name} 학생이 ${fixedDay}요일 분리수거라, ${day}요일 ${zone.name}의 ${partner} 학생과 자리를 맞바꿔 보강 배정되었습니다 (${partner} 학생은 대신 ${fixedDay}요일 ${opening.name}로 이동).`);
        placed = true;
      }
    }

    // 2차: 맞바꿀 상대를 못 찾았지만 다른 요일에 정원이 안 찬 자리가 있으면(예: 반 인원이
    // 애초에 정원보다 적은 경우) 거기에 그냥 채운다. 이 학생이 가장 적게 해본 구역을 우선으로 고른다.
    if (!placed){
      const openCandidates = [];
      for (const day of ASSIGN_DAYS){
        if (day === fixedDay) continue;
        if ((recForWeek[day] || []).includes(s.name)) continue;
        if (usedByDay[day] && usedByDay[day].has(s.name)) continue;
        for (const zone of zoneList){
          const cell = weekAssignment[day] && weekAssignment[day][zone.name];
          if (!cell || cell.manuallyEdited) continue;
          if ((cell.names||[]).length >= zone.groupSize) continue;
          if (wouldConflict(s.name, cell.names||[])) continue;
          if (genderPairBlocked(zone, cell.names||[], s.name, genderOf)) continue;
          if (zoneGenderBlocked(zone, day, cid, weekNo, genderOf, s.name)) continue; // "남녀 구분 배정" 규칙(F3-r) 위반
          openCandidates.push({ day, zone, zoneCount: running[s.name].byZone[zone.name] || 0 });
        }
      }
      if (openCandidates.length){
        openCandidates.sort((a,b) => a.zoneCount - b.zoneCount);
        const { day, zone } = openCandidates[0];
        const cell = weekAssignment[day][zone.name];
        cell.names.push(s.name);
        if (!usedByDay[day]) usedByDay[day] = new Set();
        usedByDay[day].add(s.name);
        running[s.name].total++;
        running[s.name].byZone[zone.name] = (running[s.name].byZone[zone.name]||0) + 1;
        notes.push(`ℹ️ ${cid} ${weekNo}주차 — ${s.name} 학생이 ${fixedDay}요일 분리수거라 대신 ${day}요일 ${zone.name}에 보강 배정되었습니다.`);
        placed = true;
      }
    }

    // 3차(최후 수단): 맞바꿀 상대도, 남는 자리도 전혀 없는 경우 — 이 학생이 이번 주에 아예
    // 청소를 못 하고 넘어가 균등배분에서 계속 뒤처지는 것을 막기 위해, 정원을 1명 초과해서라도
    // (초과가 가장 적은 자리, 그중에서도 이 학생이 가장 적게 해본 구역을 우선으로) 배정한다.
    // 대신 교사가 눈치챌 수 있도록 경고로 표시한다.
    if (!placed){
      const overflowCandidates = [];
      for (const day of ASSIGN_DAYS){
        if (day === fixedDay) continue;
        if ((recForWeek[day] || []).includes(s.name)) continue;
        if (usedByDay[day] && usedByDay[day].has(s.name)) continue;
        for (const zone of zoneList){
          const cell = weekAssignment[day] && weekAssignment[day][zone.name];
          if (!cell || cell.manuallyEdited) continue;
          if (wouldConflict(s.name, cell.names||[])) continue;
          const overflow = (cell.names||[]).length - zone.groupSize;
          const genderIssue = genderPairBlocked(zone, cell.names||[], s.name, genderOf) ? 1 : 0;
          // "남녀 구분 배정"(F3-r) 규칙 위반 여부도 최후 수단 단계에서 우선순위에 반영한다 —
          // 다른 후보가 없으면 어쩔 수 없이 위반하더라도, 위반하지 않는 자리가 하나라도 있으면
          // 그쪽을 우선한다(2026-09-10, 7-1 황석민 사례).
          const zoneSplitIssue = zoneGenderBlocked(zone, day, cid, weekNo, genderOf, s.name) ? 1 : 0;
          overflowCandidates.push({ day, zone, overflow, genderIssue, zoneSplitIssue, zoneCount: running[s.name].byZone[zone.name] || 0 });
        }
      }
      if (overflowCandidates.length){
        // 남녀 단둘 발생과 "남녀 구분 배정" 규칙 위반을 최우선으로 피하고, 그 다음 초과 인원 수,
        // 그 다음 구역 다양성 순으로 고른다.
        overflowCandidates.sort((a,b) => (a.genderIssue - b.genderIssue) || (a.zoneSplitIssue - b.zoneSplitIssue) || (a.overflow - b.overflow) || (a.zoneCount - b.zoneCount));
        const { day, zone, genderIssue, zoneSplitIssue } = overflowCandidates[0];
        const cell = weekAssignment[day][zone.name];
        if (!cell.names) cell.names = [];
        cell.names.push(s.name);
        if (!usedByDay[day]) usedByDay[day] = new Set();
        usedByDay[day].add(s.name);
        running[s.name].total++;
        running[s.name].byZone[zone.name] = (running[s.name].byZone[zone.name]||0) + 1;
        notes.push(`⚠ ${cid} ${weekNo}주차 — ${s.name} 학생이 ${fixedDay}요일 분리수거와 겹쳤는데 자리를 맞바꿀 상대도 남는 자리도 없어, ${day}요일 ${zone.name}에 정원을 1명 초과해 배정했습니다.` +
          (zoneSplitIssue ? ' (이 자리가 "남녀 구분 배정" 규칙과 반대 성별이라, 그 규칙도 이번엔 지키지 못했습니다. 직접 확인해주세요.)' : '') +
          (genderIssue ? ' (이 자리에 남녀 단둘이 되는 것도 피할 수 없었습니다. 직접 확인해주세요.)' : ' 인원이 많아 보이면 확인해주세요.'));
        placed = true;
      }
    }
  });
  return notes;
}

// 반 인원이 7·8학년 기준(하루 청소 정원, 대개 24명/4개 요일=6명)에 딱 맞지 않아 특정 요일
// 고정 인원이 그 날 구역 총 정원보다 적을 때, 다른 요일 학생을 데려와 남는 자리를 채운다
// (F3-d, 2026-09-07 확정). 특정 몇 명만 계속 불려 다니지 않도록, 지금까지 이 "보강" 역할을
// 가장 적게 해본 학생부터 돌아가며 부른다(누적 범위는 F3-b 균등배분과 동일하게 학기
// 전체(1~4쿼터)로 이어진다). 부족한 인원 수(그 요일 고정 인원 기준, 그 주 분리수거로 인한
// 추가 결원은 제외)만큼만 채우고, 분리수거로 인한 그 주의 나머지 결원은 손대지 않는다
// (그건 fillMakeupSlots가 요일 맞바꾸기 방식으로 처리하므로, 이 함수가 먼저 구조적인 부족
// 인원만 채워두면 서로 자리를 침범하지 않는다).
// 부족분을 채울 다른 요일 학생(보강 후보)을 미리 골라 그 요일의 "그날 후보군"에 합쳐 넣는다
// (F3-d, 2026-09-07). 처음에는 정원을 다 채운 뒤에 남는 빈 자리만 나중에 채웠는데, 화요일에
// 부족분이 몰리도록 바꾸면서(F3-a 개정) 화요일 자기 요일 인원이 아주 적은(심하면 2명뿐인)
// 경우가 생겼고, 이때 정원 2명 구역(성별 규칙)을 그 2명만으로 먼저 채우려 하면 성별이 다를
// 경우 억지로 남녀 단둘로 배정되는 문제가 있었다. 보강 후보를 후보군에 미리 합쳐두면, 구역별
// 배정(pickGroup)이 처음부터 더 넓은 후보 중에서 성별·갈등쌍을 고려해 고르므로 이 문제가
// 사라진다. 보강 후보는 지금까지 이 역할을 가장 적게 해본 학생부터 돌아가며 부른다(F3-b
// 균등배분과 마찬가지로 학기 전체 누적 기준).
// 담임교사 지적(7-1, 2026-09-10): 목요일처럼 자기 요일 고정 인원이 정원보다 적어 다른 요일
// 학생을 보강으로 데려오는 반에서, "남녀 구분 배정"이 켜져 있는데도 이 보강 후보를 성별과
// 무관하게(그동안 보강을 가장 적게 해본 순서로만) 골라오다 보니, 정작 그 요일에 부족한
// 성별을 채우지 못하고 이미 충분한 성별만 데려오는 경우가 있었다(예: 목요일 홈 인원이
// 남 3·여 1인데, 정말 필요한 건 여학생 2명인데도 남학생 1명이 보강으로 섞여 들어와 여전히
// 부족했던 사례). genderNeed(=이 요일에 실제로 부족한 성별별 인원 수, 호출부에서 계산해
// 넘겨줌)가 있으면, 그 부족한 성별부터(성별별로도 기존과 같이 보강을 가장 적게 해본 순서로)
// 우선 채우고, 그래도 자리가 남으면(필요 이상으로 반 인원이 적은 경우) 나머지는 기존처럼
// 성별과 무관하게 채운다(F3-r 6차 수정).
// 담임교사 보고(7-1, 2026-09-11): 이은아·이주하 두 학생만 총 배정 횟수가 21회로, 다른
// 여학생(16-17회)보다 눈에 띄게 많았다. 원인은 이 함수가 "이번 주 이미 다른 요일에 보강/
// 맞바꾸기로 불려간 학생"(usedThisWeek, F3-h의 자리 바꾸기와 F3-r의 남녀 맞바꾸기가 공유하는
// 목록)을 전혀 확인하지 않고 있었던 것이었다 — 그래서 예를 들어 화요일에 "남녀 구분 배정"
// 맞바꾸기로 이미 이번 주 추가 배정된 학생이, 같은 주 목요일 보강 후보에도 또 뽑혀(둘 다
// "보강 횟수가 적은 학생 우선"이라는 같은 기준을 따로따로 적용하다 보니) 한 주에 자기
// 요일+화요일+목요일까지 세 번 배정되는 일이 반복됐다. usedThisWeek에 있는 학생은 후보에서
// 제외하고, 이 함수가 실제로 뽑은 보강 인원도 usedThisWeek에 등록해 이후 같은 주 다른 요일의
// 보강·맞바꾸기 선정에서 제외되도록 했다(F3-r 8차 수정).
// 담임교사 보고(8-1, 2026-10): 위 두 수정(최시온 사례의 요일 고정 재검토, 같은 주 중복 배정
// 방지)을 모두 적용한 뒤에도 드물게(시뮬레이션상 약 2.8%의 자동배정 실행에서) 보강 횟수가
// 11회까지 몰리는 학생이 한 명 남는 사례가 있었다(박하랑 사례 — 정작 본인은 분리수거 당번이
// 아닌데도 영향을 받음). 원인은 이 함수의 동점자 처리가 "보강을 가장 적게 해본 학생 우선,
// 그다음은 무작위"뿐이어서, 어떤 학생이든 분리수거 당번이 우연히 이 요일(수요일 등)에 자주
// 걸리면 그 학생은 이 요일의 보강 후보 풀에서 자주 빠지게 되고 — 그러다 학기가 끝나갈 때까지
// 공평하게 보강을 나눠 받을 기회 자체가 거의 남지 않은 채로 몰리면, 결국 "보강 횟수가 적다"는
// 이유만으로 계속 뽑히는 다른 학생(들)에게 그 몫이 쏠려 11회가 나온다 — 분리수거 때문에
// 생긴 불균형인데도 당사자가 아닌 제3의 학생이 피해를 보는 구조다. 동점자 처리에 "이 요일에
// 앞으로(이번 주 이후) 분리수거와 안 겹쳐서 보강 후보가 될 수 있는 남은 기회 수"를 한 단계
// 더 추가해, 그 기회가 적게 남은(즉 곧 분리수거로 막혀 더는 공평하게 뽑힐 기회가 없어질
// 위험이 큰) 학생을 먼저 채워주도록 했다 — 기회가 있을 때 미리 공평하게 나눠주는 셈이다.
// 3,000회 시뮬레이션으로 확인한 결과 11회 이상 발생 비율이 2.8%→0%로 사라졌다.
function selectShortfallGuests(dateRecycling, homeNames, dayGroupSize, fullRoster, zoneList, running, genderNeed, genderOf, usedThisWeek, weekNo, day){
  const totalCapacity = zoneList.reduce((sum,z) => sum + z.groupSize, 0);
  const shortfall = totalCapacity - dayGroupSize;
  if (shortfall <= 0) return [];
  const candidates = fullRoster.filter(s => !homeNames.has(s.name) && !dateRecycling.includes(s.name) &&
      !(usedThisWeek && usedThisWeek.has(s.name)));
  // 이번 주(weekNo) 이후 남은 주차 중, 이 요일(day)에 분리수거와 겹치지 않아 보강 후보가 될 수
  // 있는 주차 수 — 적을수록 "앞으로 공평하게 뽑힐 기회가 얼마 안 남은" 학생.
  const futureChances = (name) => {
    if (weekNo == null || !day) return Infinity; // 호출부에서 주차/요일을 안 넘겨주면 기존과 동일하게 동작
    let chances = 0;
    quarter.weeks.forEach(ww => {
      if (ww.weekNo <= weekNo) return;
      const rec = (recyclingAssignment[ww.weekNo] && recyclingAssignment[ww.weekNo][day]) || [];
      if (!rec.includes(name)) chances++;
    });
    return chances;
  };
  const scored = candidates.map(s => ({ s, ex: (running[s.name]?.extra || 0), fc: futureChances(s.name), rnd: Math.random() }));
  const byFairness = (a,b) => (a.ex - b.ex) || (a.fc - b.fc) || (a.rnd - b.rnd); // 보강을 가장 적게 해본 학생 우선, 그다음 이 요일에 앞으로 뽑힐 기회가 적게 남은 학생 우선

  if (genderNeed && genderOf && ((genderNeed['여']||0) > 0 || (genderNeed['남']||0) > 0)){
    const picked = [];
    const pickedNames = new Set();
    ['여','남'].forEach(g => {
      const want = genderNeed[g] || 0;
      if (want <= 0) return;
      scored.filter(c => !pickedNames.has(c.s.name) && genderOf[c.s.name] === g)
        .sort(byFairness)
        .slice(0, want)
        .forEach(c => { picked.push(c); pickedNames.add(c.s.name); });
    });
    if (picked.length < shortfall){
      scored.filter(c => !pickedNames.has(c.s.name))
        .sort(byFairness)
        .slice(0, shortfall - picked.length)
        .forEach(c => picked.push(c));
    }
    return picked.slice(0, shortfall).map(c => c.s);
  }

  return scored.sort(byFairness).slice(0, shortfall).map(c => c.s);
}

// 담임교사 요청(2026-09-08): "보강 인원이 몰릴 요일"(F3-d) 소속 학생들은 구조상 "이미 부족해서
// 도움을 받는 쪽"이라, 다른 요일이 분리수거 결원 등으로 우연히 부족해지는 경우가 아니면 스스로
// "보강"을 할 기회가 전혀 없다 — 그래서 이 요일 학생들은 학기 내내 보강 횟수가 계속 0으로
// 남고, 총 배정 횟수도 다른 요일 학생보다 조금씩 뒤처진다. 이를 완전히 공평하게 만들기 위해,
// 정원이 꽉 찬 요일(월/수/목 등)에서 매주 "이 요일 학생 중 총 배정 횟수가 가장 많은 학생"과
// "보강 몰릴 요일 학생 중 총 배정 횟수가 가장 적은 학생"의 차이가 실제로 의미 있게(1회 이상)
// 벌어져 있을 때만, 전자를 하루 쉬게 하고 후자를 그 자리에 대신 채워 넣는다("자리 바꾸기").
// 격차가 없거나 아주 작으면 아무 것도 하지 않으므로, 이미 균형 잡힌 반은 지금과 똑같이
// 동작한다 — 시뮬레이션으로 확인한 결과 매주 무의미하게 자리를 흔드는 일 없이, 격차가 벌어질
// 때만 필요한 만큼 조용히 바로잡아 학기 안에 격차가 사실상 사라졌다.
function selectReverseSwap(dayGroup, shortDayHome, dateRecycling, usedAsReverseThisWeek, running){
  const GAP_THRESHOLD = 1;
  const fillCandidates = shortDayHome.filter(s => !dateRecycling.includes(s.name) && !usedAsReverseThisWeek.has(s.name));
  if (!fillCandidates.length) return null;
  let fillIn = null;
  fillCandidates.forEach(c => { if (!fillIn || running[c.name].total < running[fillIn.name].total) fillIn = c; });
  let sitOut = null;
  dayGroup.forEach(c => { if (!sitOut || running[c.name].total > running[sitOut.name].total) sitOut = c; });
  if (!fillIn || !sitOut) return null;
  if (running[sitOut.name].total - running[fillIn.name].total < GAP_THRESHOLD) return null;
  return { fillIn, sitOut };
}

// 반별로 "보강 인원이 몰릴 요일"을 고를 수 있게 한다(F3-d). 현재 선택된 반이 바뀔 때마다
// renderShortfallDaySelect()가 그 반의 저장된 값(없으면 기본값 '화')으로 셀렉트를 맞춰준다.
function renderShortfallDaySelect(){
  const sel = document.getElementById('shortfallDaySelect');
  if (!sel) return;
  sel.value = getShortfallDay(currentClassId);
}
document.getElementById('shortfallDaySelect').addEventListener('change', async (e) => {
  const cid = currentClassId;
  const day = e.target.value;
  if (!shortfallDay[cid]) shortfallDay[cid] = day;
  shortfallDay[cid] = day;
  await saveNode(`shortfallDay/${cid}`, day);
  alert('보강 요일 설정이 바뀌었습니다. 실제로 반영하려면 아래 "이번 쿼터 요일 배정도 새로 계산"을 체크한 뒤 자동배정을 다시 실행해주세요.');
});

// 담임교사 요청(6학년, 2026-09-10): "기존의 규칙적 배정과, 요일배정 우선 규칙 이렇게 하나
// 더 있으면 좋겠다"는 요청에 따라 반별로 배정 방식을 고를 수 있게 했다. 다만 6학년만 학생
// 명단의 요일 배정을 담임교사가 번호대로 직접 정하고, 일부러 특정 요일에 적은 인원만
// 배정해두는 경우가 있어(7.3-i) 이 옵션은 6학년 탭에서만 보이게 했다(다른 반은 요일별
// 인원이 자동으로 고르게 나뉘어 이 옵션이 필요 없음, 2026-09-10 확정).
function renderDayPriorityMode(){
  const row = document.getElementById('dayPriorityModeRow');
  if (!row) return;
  const show = currentClassId === '6학년';
  row.style.display = show ? 'inline-flex' : 'none';
  if (!show) return;
  const on = !!dayPriorityMode[currentClassId];
  document.getElementById('dayPriorityModeOn').checked = on;
  document.getElementById('dayPriorityModeOff').checked = !on;
}
document.querySelectorAll('input[name="dayPriorityMode"]').forEach(radio => {
  radio.addEventListener('change', async (e) => {
    const cid = currentClassId;
    const on = e.target.value === 'on';
    dayPriorityMode[cid] = on;
    await saveNode(`dayPriorityMode/${cid}`, on);
    alert('배정 규칙이 바뀌었습니다. 실제로 반영하려면 자동배정을 다시 실행해주세요.');
  });
});

// 담임교사 요청(6학년 제외 전 학급, 2026-09-10): "남녀 구분 배정" — 요일마다 '교실'과 '그 외
// 구역'을 통째로 성별로 나눠 배정한다("교실청소는 늘 3명으로 배정되어 있으니 여자3명, 그외
// 청소구역 3명은 남자로"). 요일별 배정을 담임교사가 직접 나누는 6학년과 달리, 나머지 반은
// 자동으로 요일이 배정되므로(7.3-a) 이 옵션은 6학년 탭에서는 숨긴다(6학년에는 대신
// "요일 우선 배정"이 있음, 7.3-o).
function renderGenderSplitMode(){
  const row = document.getElementById('genderSplitModeRow');
  if (!row) return;
  const show = currentClassId !== '6학년';
  row.style.display = show ? 'inline-flex' : 'none';
  if (!show) return;
  const on = !!genderSplitMode[currentClassId];
  document.getElementById('genderSplitModeOn').checked = on;
  document.getElementById('genderSplitModeOff').checked = !on;
}
document.querySelectorAll('input[name="genderSplitMode"]').forEach(radio => {
  radio.addEventListener('change', async (e) => {
    const cid = currentClassId;
    const on = e.target.value === 'on';
    genderSplitMode[cid] = on;
    await saveNode(`genderSplitMode/${cid}`, on);
    alert('배정 규칙이 바뀌었습니다. 실제로 반영하려면 자동배정을 다시 실행해주세요.');
  });
});

document.getElementById('autoAssignBtn').addEventListener('click', async () => {
  const cid = currentClassId;
  if (!quarter.weeks.length){ alert('먼저 위에서 쿼터 달력을 생성해주세요.'); return; }
  if (!(zones[cid] || []).length){ alert('먼저 이 반의 청소구역을 등록해주세요.'); return; }
  const roster = activeStudents(cid);
  if (!roster.length){ alert('먼저 학생 명단을 업로드해주세요.'); return; }

  const pairs = conflictPairs[cid] || [];
  let makeupNotes = [];

  const forceReset = !!(document.getElementById('resetWeekday') && document.getElementById('resetWeekday').checked);

  // 담임교사 요청(2026-09-16): 실수로 이 버튼을 눌러 이번 쿼터 배정표가 통째로 다시
  // 섞여버리는 사고를 막기 위해, 실행 전에 한 번 더 확인을 받는다. "이번 쿼터 요일
  // 배정도 새로 계산"이 켜져 있으면 학생별 요일까지 바뀔 수 있다는 점을 더 강하게 알린다.
  const confirmMsg = `${cid}의 이번 쿼터(${quarter.label}) 배정표를 다시 계산합니다.\n` +
    `손으로 고정한 칸(수정 버튼으로 저장한 칸)은 그대로 유지되고, 나머지 칸은 다시 배정됩니다.` +
    (forceReset ? `\n\n⚠️ "이번 쿼터 요일 배정도 새로 계산"이 켜져 있어 학생별 청소 요일도 처음부터 다시 정해집니다.` : '') +
    `\n\n실행 직전 상태는 자동으로 백업되며, 잘못 눌렀다면 "이전 데이터 불러오기" 버튼으로 되돌릴 수 있습니다.\n\n계속할까요?`;
  if (!confirm(confirmMsg)) return;

  // 위 확인을 통과하면, 실제로 무엇이든 덮어쓰기 전에 지금 이 반의 상태를 한 벌만
  // 백업해둔다(되돌리기는 가장 최근 실행 직전 상태 1단계까지만 지원 — 다시 자동배정을
  // 실행하면 그 시점 기준으로 백업이 덮어써진다).
  try {
    const backupPayload = {
      classroomAssignment: JSON.parse(JSON.stringify(classroomAssignment[cid] || {})),
      weekdayAssignment: JSON.parse(JSON.stringify(weekdayAssignment[cid] || {})),
      genderSplitFlip: !!genderSplitFlip[cid],
      quarterLabel: quarter.label,
      savedAt: Date.now()
    };
    autoAssignBackup[cid] = backupPayload;
    await saveNode(`autoAssignBackup/${cid}`, backupPayload);
  } catch (e) {
    console.error('자동배정 백업 저장 실패', e);
  }

  // 담임교사 요청(2026-09-10, 7.3-r 3차 수정): "남녀 구분 배정"이 쿼터를 넘어가며 계속
  // 공평하려면, 쿼터가 바뀔 때(="이번 쿼터 요일 배정도 새로 계산"을 켜고 실행할 때)마다
  // 이번 쿼터의 시작 성별(genderSplitFlip)이 뒤집혀야 한다 — 그래야 예를 들어 1쿼터에 홀수
  // 주차에 여학생이 교실을 맡았다면, 2쿼터에는 홀수 주차에 남학생이 교실을 맡는 식으로 계속
  // 교대되어, 한쪽 성별이 여러 쿼터에 걸쳐 계속 더 많이 교실을 맡는 장기 편향이 생기지 않는다.
  const genderSplitActiveForFlip = cid !== '6학년' && !!genderSplitMode[cid];
  if (forceReset && genderSplitActiveForFlip){
    genderSplitFlip[cid] = !genderSplitFlip[cid];
    await saveNode(`genderSplitFlip/${cid}`, genderSplitFlip[cid]);
  }

  await withSync(async () => {
    // (2026-09-07에 "6학년 반 인원에 맞춰 '교실' 정원을 자동으로 재계산"하는 기능을 넣었었지만,
    // 2026-09-09에 6학년 요일 배정을 담임교사가 직접 정하는 방식(7.3-i)으로 바뀌면서, "배정 제외"로
    // 활성 인원을 의도적으로 줄여둔 경우에도 이 자동 계산이 "반별 청소구역 설정"에서 손으로 정한
    // 인원수(예: 교실 2명)를 자동배정을 실행할 때마다 다시 덮어써버리는 문제가 생겼다 — 담임교사가
    // 분명히 2명으로 설정했는데 실행할 때마다 1명으로 되돌아간 것이 이 때문이다. 이제 6학년도 다른
    // 반과 똑같이 "반별 청소구역 설정" 화면에서 손으로 정한 인원수를 그대로 사용하고, 자동배정
    // 실행 시 더 이상 재계산하지 않는다(2026-09-09 확정, PRD 7.3-g 대체).
    const zoneList = zones[cid] || [];

    // 학생마다 이번 쿼터 청소 요일을 먼저 확정한다 (이미 이번 쿼터로 배정된 학생은 그대로 유지 —
    // 단, "이번 쿼터 요일 배정도 새로 계산" 체크박스를 켰을 때만 전원 재계산).
    const wdMap = ensureWeekdayAssignment(cid, roster, forceReset);
    await saveNode(`weekdayAssignment/${cid}`, wdMap);

    const running = {};
    // qByZone(F3-q, 2026-09-10): 이번 쿼터 들어서만의 구역별 횟수 — 여기서 늘 0에서 새로
    // 시작해, 아래 quarter.weeks.forEach가 1주차부터 순서대로 진행되며 자연스럽게 채워진다.
    roster.forEach(s => { running[s.name] = priorCumulative(cid, s.name); running[s.name].qByZone = {}; });
    const genderOf = {};
    roster.forEach(s => { if (s.gender) genderOf[s.name] = s.gender; });

    const existing = classroomAssignment[cid] || {};
    const newAssignment = {};

    // 보강 몰릴 요일(F3-d) 소속 학생들 — 자리 바꾸기(위 selectReverseSwap)의 "채워 넣을 후보"가
    // 된다. 정원이 꽉 찬 다른 요일에서 매주 필요할 때만 이 학생들 중 한 명을 그 자리에 채운다.
    const shortDay = getShortfallDay(cid);
    const shortDayHomeAll = roster.filter(s => (wdMap[s.name] || {}).day === shortDay);
    // 담임교사 보고(2026-09-10, 7-2반): 서윤·정여원이 추가되어 24명(=정원 6명×4요일)이 되면서
    // "보강 몰릴 요일"(화)도 더 이상 구조적으로 부족하지 않게 됐는데도, F3-h(자리 바꾸기)가
    // 여전히 매주 작동해 두 학생(신입이라 누적 총횟수가 0으로, 다른 학생보다 항상 적음)을 다른
    // 요일로 계속 불려다니게 했다 — 정여원이 9주차에 원래 요일(수)이 아니라 목요일에 배정된
    // 것도 이 때문이다. F3-h는 원래 "보강 몰릴 요일은 정원이 다른 요일보다 적게 배정돼(target이
    // capacity보다 낮음) 그만큼 구역을 다양하게 경험할 기회도 구조적으로 적다"는 문제를 보정하기
    // 위한 장치였는데, 그 전제(요일 목표 인원이 실제로 모자란지)를 확인하지 않고 그냥 "화요일
    // 소속 학생의 누적 총횟수가 더 적으면" 무조건 자리를 바꿔버렸다. 그래서 반 인원이 늘어
    // 화요일도 다른 요일과 똑같이 꽉 차게 되면(전제가 사라지면), 신입생처럼 누적이 자연히 낮은
    // 학생을 구조적 불이익으로 오인해 계속 자리를 옮기는 부작용이 생겼다. 이제 화요일의 목표
    // 인원이 실제로 정원(capacity)보다 적을 때만 — 즉 정말 구조적으로 불리할 때만 — F3-h가
    // 작동하도록 조건을 추가한다. 인원이 정원에 딱 맞아 모든 요일이 동등해지면 이 장치는
    // 자연히 꺼지고, 새로 들어온 학생은 다른 학생과 똑같이 자기 요일에서만 배정되어 누적은
    // 정상적인 매주 배정을 통해 자연스럽게 따라잡는다.
    const totalCapacity = zoneList.reduce((sum,z) => sum + (z.groupSize||0), 0);
    const dayTargets = computeDayTargets(cid, roster.length);
    // "지정 안 함"(SHORTFALL_NONE)이면 부족분을 몰아줄 특정 요일 자체가 없으므로, F3-h(자리
    // 바꾸기)도 자연히 꺼진다 — shortDayHomeAll이 항상 빈 배열이 되는 것과 같은 이유.
    const shortDayTrulyShort = ASSIGN_DAYS.includes(shortDay) && totalCapacity > 0 && dayTargets[shortDay] < totalCapacity;

    quarter.weeks.forEach(w => {
      newAssignment[w.weekNo] = {};
      const usedByDay = {};
      const usedAsReverseThisWeek = new Set(); // 이번 주에 이미 "자리 바꾸기"로 다른 요일에 채워진 학생 — 같은 주에 여러 요일에 겹쳐 들어가지 않도록
      ASSIGN_DAYS.forEach(day => {
        newAssignment[w.weekNo][day] = {};
        const dateRecycling = (recyclingAssignment[w.weekNo] && recyclingAssignment[w.weekNo][day]) || [];
        const usedToday = new Set();
        usedByDay[day] = usedToday;
        // 이 요일에 고정 배정된 학생들만 후보로 삼는다 — 한 학생이 쿼터 내내 같은 요일에만 서도록.
        let dayGroup = roster.filter(s => (wdMap[s.name] || {}).day === day);
        // 담임교사 요청(6학년, 2026-09-09): 6학년은 요일을 담임교사가 직접 정하는데(7.3-i), 어느
        // 요일에도 아무도 배정하지 않고 일부러 비워둘 수 있다(예: 3명씩 월/화/수만 쓰고 목요일은
        // 아예 안 쓰기). 이 요일은 자기 요일 인원이 0명이라고 해서 다른 요일 학생을 데려와 채우면
        // 안 된다 — 그러면 애초에 "이 요일은 안 쓴다"는 의도와 반대로 매주 청소 인원이 생겨버린다.
        // 그래서 이 요일 소속 인원이 0명이면 구역 배정·보강 후보 선정·자리 바꾸기를 전부 건너뛰고
        // 완전히 빈칸으로 둔다. 손으로 직접 입력해둔 칸(F5-… 입력+저장)만 그대로 보존한다.
        // (F4 분리수거 자동 재배정도 이 요일엔 손대지 않는다 — 구역 칸 자체가 없으므로 자연히
        // 건너뛰어진다.)
        if (dayGroup.length === 0){
          zoneList.forEach(zone => {
            const existingCell = existing[w.weekNo] && existing[w.weekNo][day] && existing[w.weekNo][day][zone.name];
            if (existingCell && existingCell.manuallyEdited){
              newAssignment[w.weekNo][day][zone.name] = existingCell;
              (existingCell.names||[]).forEach(n => usedToday.add(n));
            }
          });
          return;
        }
        // 담임교사 요청(6학년, 2026-09-10): 요일 우선 배정이 켜진 반은 다른 요일에서 인원을
        // 데려와 채우지 않는다(F3-d/F3-h를 모두 건너뜀) — 애초에 담임교사가 요일마다 인원을
        // 직접 나눠둔 의도를 그대로 지키기 위함이다. 대신 이 요일 고정 인원수에 맞춰 구역
        // 정원을 줄인다(shrinkZonesToHeadcount, F3-o).
        const dayPriorityActive = cid === '6학년' && !!dayPriorityMode[cid];
        // 담임교사 요청(6학년 제외, 2026-09-10): "남녀 구분 배정"(F3-r) — 요일마다 '교실'과
        // '그 외 구역'을 통째로 반대 성별로 나눠 배정한다. 자세한 규칙은 splitPoolForZone 위 주석 참고.
        const genderSplitActive = cid !== '6학년' && !!genderSplitMode[cid];

        // 정원이 꽉 찬 요일(보강 몰릴 요일이 아닌 날)에서, 그 요일 학생과 보강 몰릴 요일 학생
        // 사이에 총 배정 횟수 격차가 벌어져 있으면 자리를 바꿔 형평을 맞춘다(F3-h, 2026-09-08).
        // 담임교사 보고(7-1, 2026-09-10): "남녀 구분 배정"이 켜진 반에서, 이 자리 바꾸기가
        // 총 배정 횟수만 보고 성별과 무관하게 학생을 데려오다 보니, 문제를 더 키우는 경우가
        // 있었다 — 7-1은 요일 배정(주차 배정) 자체가 성별을 고려하지 않아 월요일 조가 우연히
        // 전원 여학생(6명)이 됐는데, 여기에 "보강 몰릴 요일"(목, 구조적으로 정원 미달) 소속인
        // 황석민(남)이 이 로직으로 섞여 들어가면서, "교실"이 여학생 2명+황석민 1명으로 채워지는
        // 결과가 나왔다(splitPoolForZone은 정상 작동했지만, 애초에 이 자리 바꾸기가 딱 1명만
        // 총 배정 횟수 기준으로 데려오다 보니 그 날 성별 구성을 깔끔하게 채우지 못하고 어중간하게
        // 섞어놓은 것). "남녀 구분 배정"이 켜진 반은 이 자리 바꾸기 자체를 건너뛰도록 했다 —
        // 요일 배정이 성별을 고려하지 않는 이상, 특정 요일이 한쪽 성별로 쏠리는 문제는 이
        // 기능만으로 고칠 수 없고(여러 명을 한꺼번에 데려와야 함), 오히려 splitPoolForZone이
        // 이미 갖고 있는 "부족하면 성별 미상 → 그래도 부족하면 전체 후보로 채우고 경고" 폴백이
        // 훨씬 깔끔하고 명확하게(경고 문구와 함께) 처리한다. 근본적으로 특정 요일이 한쪽
        // 성별로 크게 쏠리는 반은, 요일 배정 자체를 조정해(일부 학생의 요일을 손으로 바꿔서)
        // 성별을 고르게 섞어주는 것이 가장 확실한 해결책이다.
        let reverseFillNames = new Set();
        if (!dayPriorityActive && !genderSplitActive && day !== shortDay && shortDayTrulyShort){
          const swap = selectReverseSwap(dayGroup, shortDayHomeAll, dateRecycling, usedAsReverseThisWeek, running);
          if (swap){
            dayGroup = dayGroup.filter(s => s.name !== swap.sitOut.name).concat([swap.fillIn]);
            reverseFillNames.add(swap.fillIn.name);
            usedAsReverseThisWeek.add(swap.fillIn.name);
            makeupNotes.push(`🔁 ${cid} ${day}요일 — 요일별 배정 형평을 위해 ${swap.sitOut.name} 학생은 이번 주 쉬고, 대신 ${swap.fillIn.name} 학생(${shortDay}요일 소속)이 이 날 배정되었습니다.`);
          }
        }
        // 담임교사 요청(7-1, 2026-09-10, 정의찬 사례): "남녀 구분 배정이 선택되면 이것이 우선
        // 기준이 되어 배정되도록 해줘. 남학생이 [전체적으로] 충분해서 [이 요일에] 2명이
        // 부족하면, 남학생들로만 채우는거야." — 화요일 홈 인원(4남2여)처럼 인원수는 정원과
        // 딱 맞아도(guest를 새로 데려올 필요는 없어도) 성별 비율 자체가 이번 주 필요한
        // 비율과 다른 경우, 지금까지는 splitPoolForZone의 "부족하면 경고와 함께 다른 성별로
        // 채운다"는 폴백에만 의존해 정의찬(남)이 여학생 전용 "교실"에 섞여 들어갔다. 이제
        // "남녀 구분 배정"을 요일 고정 배정보다 우선하는 규칙으로 삼아, 정원은 찼지만 비율이
        // 안 맞는 경우 초과한 성별 학생을 다른 요일의 부족한 성별 학생과 맞바꾼다 — 반 전체에
        // 그 성별이 충분히 있다면(이 요일이 아니라 다른 요일에라도) 최대한 그 성별로만 채워지도록
        // 한다. 정말 반 전체를 통틀어도 그 성별이 부족할 때만(이 교체로도 다 못 채웠을 때만)
        // splitPoolForZone의 기존 경고 폴백으로 넘어간다.
        if (genderSplitActive){
          const classroomZone = zoneList.find(z => z.name === '교실');
          const classroomSize = classroomZone ? (classroomZone.groupSize||0) : 0;
          const classroomGender = classroomGenderForWeek(cid, w.weekNo);
          const otherGenderNeeded = otherGender(classroomGender);
          if (classroomGender && otherGenderNeeded && dayGroup.length >= totalCapacity){
            const otherSize = Math.max(0, totalCapacity - classroomSize);
            const haveClassroomGender = dayGroup.filter(s => genderOf[s.name] === classroomGender).length;
            const haveOtherGender = dayGroup.filter(s => genderOf[s.name] === otherGenderNeeded).length;
            const needClassroom = classroomSize - haveClassroomGender; // >0이면 이 성별이 더 필요
            const needOther = otherSize - haveOtherGender;
            const deficitGender = needClassroom > 0 ? classroomGender : (needOther > 0 ? otherGenderNeeded : null);
            const swapCount = deficitGender ? Math.max(needClassroom, needOther) : 0;
            if (deficitGender && swapCount > 0){
              const surplusGender = otherGender(deficitGender);
              const homeNamesAll = new Set(dayGroup.map(s=>s.name));
              // 담임교사 보고(7-1, 2026-09-11): 이 맞바꾸기가 화요일처럼 매주 반복해서 필요한
              // 반에서는, "보강 횟수가 같으면 그다음은?"이라는 동점자 처리에 무작위 요소가 없어서
              // (예전엔 있었는데 이 기능을 새로 추가하며 빠뜨렸다) 매주 같은 순서로 정렬되는
              // 학생 명단 순서상 앞쪽에 있는 학생 한두 명(이은아·이주하)이 9주 내내 유독 자주
              // 뽑혀, 다른 여학생은 16-17회인데 이 두 학생만 21회로 튀는 문제가 있었다. 다른
              // 보강 관련 함수들(selectShortfallGuests 등)처럼 동점일 때 무작위로 고르도록
              // 고쳤다(F3-r 7차 수정).
              const fillIns = roster.filter(s => !homeNamesAll.has(s.name) && !dateRecycling.includes(s.name) &&
                  !usedAsReverseThisWeek.has(s.name) && genderOf[s.name] === deficitGender)
                .map(s => ({ s, ex: running[s.name]?.extra||0, rnd: Math.random() }))
                .sort((a,b) => (a.ex - b.ex) || (a.rnd - b.rnd))
                .slice(0, swapCount)
                .map(c => c.s);
              if (fillIns.length){
                const sitOuts = dayGroup.filter(s => genderOf[s.name] === surplusGender)
                  .map(s => ({ s, tot: running[s.name]?.total||0, rnd: Math.random() }))
                  .sort((a,b) => (b.tot - a.tot) || (a.rnd - b.rnd)) // 총 배정 많은 학생부터 쉬게, 동점이면 무작위
                  .slice(0, fillIns.length)
                  .map(c => c.s);
                const sitOutNames = new Set(sitOuts.map(s=>s.name));
                dayGroup = dayGroup.filter(s => !sitOutNames.has(s.name)).concat(fillIns);
                fillIns.forEach(f => {
                  usedAsReverseThisWeek.add(f.name);
                  reverseFillNames.add(f.name);
                  if (!running[f.name]) running[f.name] = { total:0, byZone:{}, qByZone:{}, extra:0 };
                  running[f.name].extra = (running[f.name].extra||0) + 1; // 이 학생도 "보강" 공평성 집계에 포함 — 다음에 또 우선적으로 불려다니지 않도록
                });
                sitOuts.forEach((so,i) => {
                  makeupNotes.push(`🔁 ${cid} ${day}요일 — "남녀 구분 배정" 규칙을 지키기 위해 ${so.name} 학생은 이번 주 쉬고, 대신 ${fillIns[i].name} 학생이 이 날 배정되었습니다.`);
                });
              }
            }
          }
        }
        let guests = [];
        let effectiveGroup = dayGroup;
        let zoneListForDay = zoneList;
        if (dayPriorityActive){
          zoneListForDay = shrinkZonesToHeadcount(zoneList, dayGroup.length);
        } else {
          // 반 인원이 정원(대개 24명/4요일=6명)에 딱 맞지 않아 이 요일 고정 인원만으로는 구역을
          // 다 못 채울 때, 다른 요일 학생을 보강 후보로 미리 뽑아 그날 후보군에 합쳐 넣는다(F3-d)
          // — 정원 2명(성별 규칙) 구역 등을 배정할 때 처음부터 넓은 후보 중에서 고르도록 하기
          // 위함이다. 화요일에 부족분이 몰리도록 했으므로(F3-a 개정) 보강도 대개 화요일에 몰린다.
          const homeNames = new Set(dayGroup.map(s=>s.name));
          // "남녀 구분 배정"이 켜진 반은, 보강 후보를 뽑을 때도 이 요일에 실제로 부족한 성별을
          // 우선 채우도록 목표치를 계산해 넘긴다(F3-r 6차 수정, 위 selectShortfallGuests 주석 참고).
          let genderNeed = null;
          if (genderSplitActive){
            const classroomZone = zoneList.find(z => z.name === '교실');
            const classroomSize = classroomZone ? (classroomZone.groupSize||0) : 0;
            const classroomGender = classroomGenderForWeek(cid, w.weekNo);
            const otherGenderNeeded = otherGender(classroomGender);
            if (classroomGender && otherGenderNeeded){
              const otherSize = Math.max(0, totalCapacity - classroomSize);
              const haveClassroomGender = dayGroup.filter(s => genderOf[s.name] === classroomGender).length;
              const haveOtherGender = dayGroup.filter(s => genderOf[s.name] === otherGenderNeeded).length;
              genderNeed = {};
              genderNeed[classroomGender] = Math.max(0, classroomSize - haveClassroomGender);
              genderNeed[otherGenderNeeded] = Math.max(0, otherSize - haveOtherGender);
            }
          }
          guests = selectShortfallGuests(dateRecycling, homeNames, dayGroup.length, roster, zoneList, running, genderNeed, genderOf, usedAsReverseThisWeek, w.weekNo, day);
          guests.forEach(g => usedAsReverseThisWeek.add(g.name)); // 같은 주 다른 요일의 보강·맞바꾸기 선정에서 중복으로 뽑히지 않도록(F3-r 8차 수정)
          effectiveGroup = dayGroup.concat(guests);
        }
        const guestNameSet = new Set(guests.map(g=>g.name));
        orderZonesForPicking(zoneListForDay).forEach(zone => {
          const existingCell = existing[w.weekNo] && existing[w.weekNo][day] && existing[w.weekNo][day][zone.name];
          if (existingCell && existingCell.manuallyEdited){
            newAssignment[w.weekNo][day][zone.name] = existingCell;
            (existingCell.names||[]).forEach(n => usedToday.add(n));
            return;
          }
          // 담임교사 요청(2026-09-10): "랜덤 배정은 안 써도 될 것 같아, 삭제해도 될 것 같아" —
          // 화면의 "랜덤 배정"/"규칙적 배정" 선택 라디오 버튼을 없앴다. 이제 항상 "규칙적 배정"
          // (동점일 때 이 구역을 가장 오래 전에/아직 한 번도 맡지 않은 학생을 정해진 규칙으로
          // 우선)으로만 동작한다. pickGroup 내부는 그대로 두고(다른 값을 넣을 일이 없어졌을
          // 뿐 로직 자체는 안전하게 남겨둠), 화면에서 값을 읽어오던 부분만 고정값으로 바꿨다.
          let zoneCandidates = effectiveGroup;
          if (genderSplitActive){
            // 성별 인원이 실제로 부족한지 판단할 때는, 오늘 이미 다른 구역에 배정되어 더 이상
            // 후보가 될 수 없는 학생(usedToday)과 오늘 분리수거 당번(dateRecycling)은 빼고
            // 세어야 한다 — 그렇지 않으면 아직 여유가 있다고 잘못 판단해 성별 미상 학생을
            // 채워야 할 상황에서도 채우지 못하고 빈 자리로 남길 수 있다.
            const stillAvailable = effectiveGroup.filter(s => !usedToday.has(s.name) && !dateRecycling.includes(s.name));
            const split = splitPoolForZone(stillAvailable, zone, day, genderOf, cid, w.weekNo);
            zoneCandidates = split.pool;
            if (split.note) makeupNotes.push(split.note);
          }
          const names = pickGroup(zone, day, dateRecycling, usedToday, zoneCandidates, pairs, running, 'rotation', genderOf, undefined, w.weekNo);
          const extraNames = names.filter(n => guestNameSet.has(n) || reverseFillNames.has(n));
          newAssignment[w.weekNo][day][zone.name] = { names, manuallyEdited:false, ...(extraNames.length ? { extraNames } : {}) };
        });

        // 담임교사 요청(7-1, 2026-09-22)이었던 "여자가 6명 중 1명만 배치되면 안 된다"는
        // 문제는 애초에 그 요일 자체에 여학생이 1명뿐이었던 것이 원인이었고, 이는 요일
        // 고정 단계의 fixLoneGenderDays(같은 요일에 특정 성별이 정확히 1명만 남지 않도록
        // 하는 규칙)로 이미 근본적으로 해결되었다 — 어떤 요일이든 각 성별이 0명이거나
        // 2명 이상이 되도록 보장하므로, 소수 성별 학생이 그날 "혼자"가 되는 일 자체가
        // 다시 발생하지 않는다.
        //
        // 한때 이 자리에 있던 "'교실'이 그날 한쪽 성별로만 채워지면 다른 구역과 1명씩
        // 맞바꾼다"는 추가 보정(성별 편중 방지 스왑)은 위 문제와는 별개로 실험적으로
        // 넣었던 것인데, 실제로는 새로운 불공평을 만드는 부작용이 있어 제거했다: 이 반의
        // 구역 구성(교실 3명·세미나실 1명·미술실 2명)에서는 "정원 2명 구역은 건드리지
        // 않는다"는 안전장치 때문에 맞바꿀 상대 구역이 사실상 세미나실(정원 1명)로 고정되어,
        // 특정 학생들이 매주 반복적으로 세미나실 배정에서 빠지고 교실로 옮겨지는 일이
        // 누적되어 같은 요일 학생들 사이에 세미나실 방문 횟수 격차(예: 한 학기에 0회 대
        // 4회)가 크게 벌어지는 결과로 이어졌다. 이번 쿼터 시뮬레이션으로 확인한 결과, 이
        // 보정을 제거하면 그 격차 문제가 사라지고(반복 실행 40회 모두 재현되지 않음),
        // 반면 fixLoneGenderDays가 이미 막고 있는 "그날 혼자 남는 소수 성별" 문제는
        // 재발하지 않는다.

        guests.forEach(g => {
          if (!running[g.name]) running[g.name] = { total:0, byZone:{}, extra:0 };
          running[g.name].extra = (running[g.name].extra||0) + 1;
          makeupNotes.push(`🔁 ${cid} ${day}요일 — 반 인원이 정원보다 적어 ${g.name} 학생이 원래 요일이 아닌 이 날 보강 배정되었습니다.`);
        });
      });
      // 자기 요일에 분리수거가 겹쳐 못 한 학생을, 이번 주 다른 요일의 빈 자리에 보강 배정한다.
      const notes = fillMakeupSlots(cid, w.weekNo, newAssignment[w.weekNo], usedByDay, running, roster, wdMap, zoneList, pairs, genderOf);
      makeupNotes.push(...notes);
    });

    classroomAssignment[cid] = newAssignment;
    await saveNode(`classroomAssignment/${cid}`, newAssignment);

    // "배정 현황"은 위 running(진행 중 카운터)이 아니라, 방금 저장한 classroomAssignment의
    // 실제 내용을 다시 세어서 저장한다 — 손으로 고정해둔 셀(manuallyEdited)의 인원도
    // 빠짐없이 반영되도록 하기 위함이다.
    await saveStatsForClass(cid);
  });

  // 담임교사 지적(7-1, 2026-09-10): "아직 제대로 작동하지 않아" — 목요일 배정표에서 황석민(남)이
  // 여학생들과 함께 "교실"에 섞여 있는데도, 자동배정을 실행했을 때 그에 대한 경고를 전혀 보지
  // 못했다는 것이 계속된 원인이었다. 코드를 다시 보니, splitPoolForZone이 "남녀 구분 배정" 규칙을
  // 못 지켰을 때 만드는 ⚠️/ℹ️ 안내 문구가 makeupNotes 배열에는 정상적으로 쌓이고 있었지만, 바로
  // 아래에서 이 문구들을 화면에 실제로 보여주는 대신 "🔁로 시작하지 않는 나머지는 전부 분리수거
  // 보강 건수다"라고 잘못 집계해(recyclingMakeupCount), 성별 부족 경고를 엉뚱하게 "분리수거 보강"
  // 건수에 섞어 숫자만 보여주고 구체적인 문구 자체는 아예 화면에 띄우지 않고 있었다 — 그래서
  // 목요일 조가 구조적으로 여학생이 부족한(황석민 사례) 상황이 실제로 경고를 만들어내고 있었는데도
  // 담임교사는 그 경고를 한 번도 볼 수 없었던 것이다. 이제 "남녀 구분 배정" 관련 문구를 별도로
  // 구분해서 건수와 함께 구체적인 내용까지 그대로 화면에 표시한다(F3-r 5차 수정, 2026-09-10).
  const reverseSwapCount = makeupNotes.filter(n => n.includes('요일별 배정 형평을 위해')).length;
  const genderSplitNotes = makeupNotes.filter(n => n.includes('남녀 구분 배정 규칙') || n.includes('성별이 입력되지 않은 학생'));
  const shortfallCount = makeupNotes.filter(n => n.startsWith('🔁') && !n.includes('요일별 배정 형평을 위해')).length;
  const recyclingMakeupCount = makeupNotes.length - shortfallCount - reverseSwapCount - genderSplitNotes.length;
  document.getElementById('assignNotes').innerHTML =
    `<div class="info-box">✅ ${cid} ${quarter.weeks.length}주차 자동배정이 완료되었습니다. 손으로 수정한 셀은 건드리지 않았습니다.` +
    (forceReset ? ` (이번 쿼터 요일 배정을 처음부터 새로 계산했습니다 — 학생별 요일이 바뀌었을 수 있습니다.)` : '') +
    (recyclingMakeupCount ? ` 자기 요일에 분리수거가 겹쳐 다른 요일로 보강 배정된 학생이 ${recyclingMakeupCount}건 있습니다 — 표에서 파란 글자로 표시됩니다.` : '') +
    (shortfallCount ? ` 반 인원이 정원보다 적어 다른 요일 학생이 보강 배정된 경우가 ${shortfallCount}건 있습니다 — 표에서 파란 글자로 표시됩니다.` : '') +
    (reverseSwapCount ? ` 요일별 배정 형평을 맞추기 위해 자리를 바꾼 경우가 ${reverseSwapCount}건 있습니다 — 표에서 파란 글자로 표시됩니다.` : '') +
    `</div>` +
    (genderSplitNotes.length
      ? `<div class="info-box" data-original-style="15">⚠️ "남녀 구분 배정" 규칙을 이번 주차들에서 완전히 지키지 못한 구역이 ${genderSplitNotes.length}건 있습니다(그 요일 조에 필요한 성별 학생이 부족했던 경우) — 아래에서 직접 확인해주세요.<br><br>` +
        genderSplitNotes.map(n => `· ${escHtml(n)}`).join('<br>') +
        `</div>`
      : '');
  if (forceReset && document.getElementById('resetWeekday')){
    document.getElementById('resetWeekday').checked = false; // 실수로 매번 켜진 채 재실행되는 것을 막기 위해 자동으로 다시 끔
  }
  showToast(`✅ ${cid} 자동배정 완료`);
  renderAssignTable();
  renderStats();
  renderTodayView();
});

// 담임교사 요청(2026-09-16): "자동배정 실행"을 실수로 눌렀을 때 되돌릴 방법이 필요하다는
// 요청으로, 위 핸들러가 실행 직전에 반별로 백업해 둔 상태(autoAssignBackup)를 그대로
// 다시 불러와 classroomAssignment·weekdayAssignment·genderSplitFlip을 되돌린다.
// 되돌리기는 1단계까지만 지원한다 — 가장 최근 자동배정 실행 직전 상태 하나만 보관되며,
// 이 버튼을 누른다고 그 백업이 사라지지는 않으므로 여러 번 눌러도 안전하다.
document.getElementById('undoAutoAssignBtn').addEventListener('click', async () => {
  const cid = currentClassId;
  const backup = autoAssignBackup[cid];
  if (!backup){
    alert('되돌릴 수 있는 이전 데이터가 없습니다.\n(이 반에서 아직 "자동배정 실행"을 한 적이 없거나, 그 이전 상태를 이미 불러왔습니다.)');
    return;
  }
  if (backup.quarterLabel !== quarter.label){
    if (!confirm(`백업된 데이터가 지금 쿼터(${quarter.label})가 아니라 "${backup.quarterLabel}" 쿼터 것입니다. 그래도 불러올까요?`)) return;
  }
  const savedAtStr = new Date(backup.savedAt).toLocaleString('ko-KR');
  if (!confirm(`${savedAtStr}에 자동배정을 실행하기 직전 상태로 ${cid}의 배정표와 학생별 요일을 되돌립니다.\n지금 화면에 있는 배정 내용은 사라집니다. 계속할까요?`)) return;

  await withSync(async () => {
    classroomAssignment[cid] = backup.classroomAssignment || {};
    weekdayAssignment[cid] = backup.weekdayAssignment || {};
    genderSplitFlip[cid] = !!backup.genderSplitFlip;
    await saveNode(`classroomAssignment/${cid}`, classroomAssignment[cid]);
    await saveNode(`weekdayAssignment/${cid}`, weekdayAssignment[cid]);
    await saveNode(`genderSplitFlip/${cid}`, genderSplitFlip[cid]);
    await saveStatsForClass(cid);
  });
  showToast(`↩️ ${cid} 자동배정을 되돌렸습니다`);
  renderAssignTable();
  renderStats();
  renderTodayView();
});

// 원본 엑셀(예: "3쿼터 저녁 청소 당번 / 7-1반")과 같은 표기: 주차는 세로 병합,
// 첫 줄은 날짜, 그 아래로 구역별 한 줄씩. 금요일은 반마다 문구가 달라 자동배정 대신
// fridayLabel을 그대로 표시하고 주차 전체에 세로 병합한다. 인쇄 시에는 .no-print(수정 버튼)만 숨긴다.
// 담임교사 요청(2026-09-09): 구역마다 "수정" 버튼을 눌러 prompt 창으로 한 칸씩 고치는 방식이
// 여러 칸을 고쳐야 할 때 번거로웠다. 분리수거 표처럼 칸에 이름을 바로 입력하고 "주차 저장"
// 버튼 한 번으로 그 주차 전체를 저장하는 방식으로 바꿨다. 단, 분리수거와 달리 이 표는 구역별
// 정원·성별·짝 규칙을 고려해 알고리즘이 매주 다르게(구역 누적이 골고루 되도록) 배정해두는
// 값이라, 손대지 않은 칸까지 "저장"을 누를 때마다 통째로 manuallyEdited 처리해버리면 이후
// 자동배정 재실행이나 분리수거 변경 시 자동 보정(F4)이 그 칸들을 전부 건드리지 못하게 된다.
// 그래서 저장 시점에 실제로 값이 바뀐 칸만 manuallyEdited:true로 표시하고, 손대지 않은 칸은
// 기존 상태(자동배정 결과 그대로거나, 예전에 손으로 고정해둔 상태)를 그대로 둔다. 같은 이유로
// 분리수거 표에 있는 "다른 주차에 복사" 기능은 여기서는 넣지 않기로 했다 — 이 표는 구역 누적
// 균형을 맞추려고 주차마다 일부러 다르게 배정되므로, 한 주차를 여러 주차에 그대로 복사하면
// 그 균형이 깨질 수 있다(2026-09-09 확정, PRD 7.5-s).
// 어떤 학생이 오늘 이 요일 칸에 배정되어 있는데, 그 학생의 "이번 쿼터 요일"(weekdayAssignment)이
// 오늘과 다르면 원래 자기 요일이 아닌 날에 청소하는 것이다. 인원 부족으로 다른 요일에서 데려온
// 경우(F3-d), 형평을 위해 자리를 바꾼 경우(F3-h), 분리수거 겹침으로 자리를 옮기거나 채운 경우
// (F4, fillMakeupSlots) 등 어떤 경로로 이 칸에 들어왔는지와 무관하게 "본인 배정 요일이 아닌 날
// 추가로 청소하게 됐다"는 사실 자체만으로 판단한다 — 그래야 배정 알고리즘이 나중에 새로운
// 방식으로 이런 이동을 만들어도 표시가 누락되지 않는다. 요일이 아직 없는 학생은 판단 근거가
// 없으므로 대상에서 제외한다(2026-09-09 확정, PRD 7.5-u).
function isNonHomeDayDuty(cid, day, name){
  const homeDay = (weekdayAssignment[cid] && weekdayAssignment[cid][name] && weekdayAssignment[cid][name].day) || '';
  return !!homeDay && ASSIGN_DAYS.includes(homeDay) && homeDay !== day;
}
// 학생 이름을 contenteditable 칸의 innerHTML에 안전하게 끼워 넣기 위한 이스케이프.
// (예전 <input value="...">는 속성값이라 브라우저가 자동으로 이스케이프해줬지만,
// contenteditable div는 태그 내용으로 직접 넣어야 해서 별도로 처리가 필요하다.)
function escHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// 담임교사 요청(2026-09-10): "저장하면 저장했다는 알람이 뜨면 좋겠어. 제대로 저장이 되었는지
// 구분이 안 갈 때가 많다." 화면 중간에 나오는 기존 안내 박스(.info-box)는 그 반의 그 화면을
// 보고 있을 때만, 또 스크롤 위치에 따라 눈에 안 들어올 수 있다. 화면 오른쪽 위에 고정으로
// 잠깐 떴다가 사라지는 토스트를 모든 저장류 동작에 공통으로 띄워, 스크롤 위치와 무관하게
// "저장됐다"는 사실 자체를 바로 알아볼 수 있게 한다(경고성 메시지는 warn=true로 호출해
// 주황색으로 구분). 기존 안내 박스는 자세한 내용을 담고 있으므로 그대로 유지하고, 이 토스트는
// 그 보조 역할이다.
function showToast(message, warn){
  const host = document.getElementById('toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast' + (warn ? ' warn' : '');
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 2200);
}
function renderAssignTable(){
  const el = document.getElementById('assignTable');
  const cid = currentClassId;
  const zoneList = zones[cid] || [];
  const data = classroomAssignment[cid] || {};
  if (!quarter.weeks.length || !zoneList.length){ el.innerHTML = ''; return; }
  // 담임교사 요청(2026-09-10): "1주차 저장 버튼이 한 줄을 통째로 차지하지 않게" — 예전에는
  // 그 주차의 맨 마지막에 저장 버튼만 있는 거의 빈 행을 따로 뒀는데, 그 행을 없애고 "N주차"
  // 글자 밑에 버튼을 바로 붙였다. rowspan도 그만큼 줄어든다(저장 버튼 행이 더 이상 없으므로).
  const rowspan = zoneList.length + 1; // 요일(날짜) 행 + 구역 행
  let html = '<table id="printableAssign"><tr><th>주차</th><th>구역</th>' +
    ASSIGN_DAYS.map(d=>`<th>${d}</th>`).join('') + '<th>금</th></tr>';
  quarter.weeks.forEach(w => {
    const fLabel = (fridayLabel[cid] && fridayLabel[cid][w.weekNo]) || '다같이';
    html += `<tr><td rowspan="${rowspan}" data-original-style="16">${w.weekNo}주차<br>
        <button class="btn small no-print" data-original-style="17" data-action-click="${encodeAction("__saveAssignWeek",[w.weekNo])}">저장</button></td><td>날짜</td>` +
      ASSIGN_DAYS.map(d=>`<td class="date-cell">${w.dates[d]}(${d})</td>`).join('') +
      // 담임교사 요청(2026-09-10): "금요일도 다른 요일과 마찬가지였으면" — prompt 창으로 한
      // 줄씩 고치던 "수정" 버튼을 없애고, 다른 요일 칸처럼 칸을 직접 클릭해 고치는
      // contenteditable로 바꿨다. 학생 이름 목록이 아니라 자유 문구 한 줄이라 이름별
      // 색칠(.extra-duty-text)이나 인쇄 시 이름별 🔁 강조 로직(.cell-edit[id] 대상)과는 무관해야
      // 해서, 생김새는 같지만 클래스는 .cell-edit이 아니라 별도의 .friday-edit을 쓴다. "N주차
      // 저장" 버튼을 누르면 다른 요일 칸과 함께 이 칸도 같이 저장된다 — 금요일만 따로 저장하는
      // 버튼은 더 이상 없다.
      `<td rowspan="${rowspan}">
        <div contenteditable="true" id="friday_${w.weekNo}" class="no-print friday-edit">${escHtml(fLabel)}</div></td></tr>`;
    zoneList.forEach((zone, zi) => {
      html += `<tr><td>${zone.name}<br><span data-original-style="18">정원 ${zone.groupSize}명</span></td>`;
      ASSIGN_DAYS.forEach(day => {
        const cell = data[w.weekNo] && data[w.weekNo][day] && data[w.weekNo][day][zone.name];
        const dateRecycling = (recyclingAssignment[w.weekNo] && recyclingAssignment[w.weekNo][day]) || [];
        const hasConflict = (cell?.names||[]).some(n => dateRecycling.includes(n));
        const conflictHint = hasConflict ? ' <span class="conflict-name" title="이 날 분리수거 당번과 겹치는 학생이 있습니다">⚠</span>' : '';
        // 원래 자기 요일이 아닌 날 청소하게 된 학생(=이번 주 "보강") 표시 (2026-09-09 추가
        // 확정, PRD 7.5-u). isNonHomeDayDuty가 이 학생의 이번 쿼터 요일과 오늘 요일을 비교해
        // 판단하므로, 인원 부족(F3-d)·형평 자리바꿈(F3-h)·분리수거 겹침 이동(F4)은 물론
        // 손으로 직접 채워 넣은 칸이라도 그 학생 본래 요일과 다르면 똑같이 표시된다.
        const extraNames = (cell?.names || []).filter(n => isNonHomeDayDuty(cid, day, n));
        // 담임교사 요청(2026-09-09): "화면의 배지는 없애고, 보강되는 인원을 파란색 글자로
        // 나타낼 수 있을까?" — 칸 앞에 따로 붙던 🔁 배지는 없애고, 대신 칸 안에서 보강 대상
        // 학생의 이름 자체를 파란 글자로 보여주기로 했다. 이름 하나하나에 색을 입히려면 이
        // 칸이 더는 (색을 넣을 수 없는) <input>일 수 없어서, 화면에 보이는 것과 편집 가능한
        // 것을 하나로 합친 contenteditable div로 바꿨다 — 클릭해서 바로 고치는 조작 방식은
        // 그대로다. 인쇄(__printAssign)는 이 화면 표시와 무관하게, 예전처럼 🔁 아이콘으로
        // 계속 표시한다 — 담임교사가 "출력했을 때 나타나야" 한다고 이미 확정한 부분이라 별도
        // 색상 대신 아이콘이 인쇄에는 더 잘 보이기 때문이다. 그래서 data-extra 속성은 인쇄가
        // 이름별로 다시 찾아 쓸 수 있도록 그대로 남겨둔다(PRD 7.5-x).
        const extraSet = new Set(extraNames);
        const cellHtml = (cell && cell.names ? cell.names : [])
          .map(n => extraSet.has(n)
            ? `<span class="extra-duty-text" title="원래 요일이 아닌 날 보강으로 청소하게 됨">${escHtml(n)}</span>`
            : escHtml(n))
          .join(', ');
        const extraAttr = extraNames.length
          ? ` data-extra="${extraNames.map(n=>n.replace(/"/g,'&quot;')).join(',')}"`
          : '';
        // 손으로 고친 칸(manuallyEdited)에만 "되돌리기" 버튼을 보여준다. 눌러도 지금 보이는
        // 이름을 바로 지우지는 않고, 그 칸의 "손 수정" 잠금만 풀어서 다음에 "자동배정 실행"을
        // 누를 때 알고리즘이 이 칸을 다시 계산해 채우도록 한다 (2026-09-09 확정, PRD 7.5-t).
        const resetBtn = cell && cell.manuallyEdited
          ? ` <button class="btn secondary small no-print" data-original-style="19" data-action-click="${encodeAction("__resetCell",[w.weekNo,day,zone.name])}" title="손 수정을 해제하고 자동배정 대상으로 되돌립니다">되돌리기</button>`
          : '';
        html += `<td>${conflictHint}${resetBtn}
          <div contenteditable="true" id="cls_${w.weekNo}_${day}_${zi}" class="no-print cell-edit"${extraAttr}>${cellHtml}</div></td>`;
      });
      html += '</tr>';
    });
  });
  html += '</table>';
  el.innerHTML = html;
}
window.__printAssign = () => {
  const cid = currentClassId;
  const table = document.getElementById('printableAssign');
  if (!table){ alert('먼저 위에서 자동배정을 실행해주세요.'); return; }
  const clone = table.cloneNode(true);
  // 담임교사 보고(2026-09-09): 배정표를 "수정" 버튼 대신 입력칸에 이름을 직접 넣는 방식으로
  // 바꾼 뒤(7.5-s), 인쇄를 누르면 이름이 통째로 사라져 있었다. 원인은 그 입력칸에도 화면
  // 편집용 요소를 가리키는 no-print 클래스가 붙어 있어서, 아래에서 no-print 요소를 지울 때
  // "수정 버튼"뿐 아니라 이름이 들어있는 칸 자체까지 함께 지워졌기 때문이다. 그래서 no-print를
  // 지우기 전에, 화면에 지금 보이는 값을 먼저 읽어 평범한 텍스트로 바꿔 넣는다 — 이러면 그
  // 다음 no-print 제거는 "수정 버튼"만 정상적으로 지운다.
  //
  // 담임교사 요청(2026-09-09, PRD 7.5-u): "보강된 인원이 구분되지 않는다. 출력했을 때 나타나야
  // 학생이 본인 배정 요일 외 추가로 청소해야 한다는 걸 알 수 있다." 칸(no-print) 하나에는
  // 여러 명이 쉼표로 함께 들어있고 그중 일부만 보강 대상일 수 있어, 칸 전체가 아니라 이름 하나
  // 하나를 나눠서 그중 보강 대상(data-extra에 미리 담아둔 이름)만 강조 표시로 감싼다.
  //
  // 이 칸은 이름별로 색을 넣기 위해(7.5-x) <input>에서 contenteditable div(.cell-edit)로
  // 바뀌었다 — 값을 읽는 방법도 .value 대신 .textContent로 바뀌었을 뿐, 나머지 로직은 그대로다.
  let hasAnyExtra = false;
  clone.querySelectorAll('.cell-edit[id]').forEach(inputClone => {
    const live = document.getElementById(inputClone.id);
    const value = (live ? live.textContent : inputClone.textContent) || '';
    const extraAttr = inputClone.getAttribute('data-extra') || '';
    const extraSet = new Set(extraAttr.split(',').map(s=>s.trim()).filter(Boolean));
    const span = document.createElement('span');
    const names = value.split(',').map(s=>s.trim()).filter(Boolean);
    if (extraSet.size && names.some(n => extraSet.has(n))){
      hasAnyExtra = true;
      names.forEach((n, i) => {
        if (i > 0) span.appendChild(document.createTextNode(', '));
        if (extraSet.has(n)){
          const mark = document.createElement('span');
          mark.className = 'extra-duty';
          mark.textContent = '🔁' + n;
          span.appendChild(mark);
        } else {
          span.appendChild(document.createTextNode(n));
        }
      });
    } else {
      span.textContent = value;
    }
    inputClone.replaceWith(span);
  });
  // 금요일 칸(.friday-edit)도 같은 이유로 인쇄 직전에 지금 화면에 보이는 값을 평범한 텍스트로
  // 바꿔 넣는다 — 그러지 않으면 이 칸 자체가 no-print라 아래에서 통째로 지워져 인쇄물에 금요일
  // 문구가 아예 안 나온다(2026-09-10, "금요일도 다른 요일과 마찬가지로" 요청에 따라 이 칸이
  // prompt 수정 버튼에서 contenteditable로 바뀌면서 새로 생긴 케이스).
  clone.querySelectorAll('.friday-edit[id]').forEach(inputClone => {
    const live = document.getElementById(inputClone.id);
    const value = (live ? live.textContent : inputClone.textContent) || '';
    const span = document.createElement('span');
    span.textContent = value;
    inputClone.replaceWith(span);
  });
  clone.querySelectorAll('.no-print').forEach(elx => elx.remove());
  const w = window.open('./cleaning-print.html', '_blank');
  if (!w){ alert('팝업이 차단되었습니다. 브라우저에서 팝업 허용 후 다시 시도해주세요.'); return; }
  const closeListener = () => window.removeEventListener('message', onPrintReady);
  const timer = setTimeout(closeListener, 15000);
  function onPrintReady(event) {
    if (event.origin !== location.origin || event.source !== w || event.data !== 'hannah:cleaning-print-ready') return;
    clearTimeout(timer);
    closeListener();
    const doc = w.document;
    doc.title = cid + ' 청소 당번표 인쇄';
    doc.querySelector('h2').textContent = cid + ' 교실청소 당번표';
    doc.getElementById('print-quarter').textContent = quarter.label + ' · 총 ' + quarter.weeks.length + '주차';
    doc.getElementById('print-extra').hidden = !hasAnyExtra;
    doc.getElementById('print-table').append(doc.importNode(clone,true));
    w.focus();
    w.print();
  }
  window.addEventListener('message', onPrintReady);
};
// 그 주차의 월~목 × 구역 입력칸을 한 번에 저장한다. 실제로 값이 바뀐 칸만 manuallyEdited로
// 표시하고, 손대지 않은 칸은 기존 상태(자동배정 결과 또는 이전의 손 수정 상태)를 그대로 둔다
// — 그래야 저장을 눌러도 그 주차 전체가 자동배정/자동보정 대상에서 통째로 빠지지 않는다.
window.__saveAssignWeek = async (weekNo) => {
  const cid = currentClassId;
  const zoneList = zones[cid] || [];
  const notes = [];
  let anyChanged = false;
  await withSync(async () => {
    if (!classroomAssignment[cid]) classroomAssignment[cid] = {};
    if (!classroomAssignment[cid][weekNo]) classroomAssignment[cid][weekNo] = {};
    for (const day of ASSIGN_DAYS){
      if (!classroomAssignment[cid][weekNo][day]) classroomAssignment[cid][weekNo][day] = {};
      const dateRecycling = (recyclingAssignment[weekNo] && recyclingAssignment[weekNo][day]) || [];
      for (let zi=0; zi<zoneList.length; zi++){
        const zone = zoneList[zi];
        const inputEl = document.getElementById(`cls_${weekNo}_${day}_${zi}`);
        if (!inputEl) continue;
        // 이 칸이 <input>에서 contenteditable div(.cell-edit)로 바뀌면서(7.5-x, 보강 학생
        // 이름에 파란 글자를 넣기 위함) 지금 보이는 값을 읽는 방법도 .value 대신 .textContent로
        // 바뀌었다 — 안에 <span class="extra-duty-text">가 섞여 있어도 textContent는 태그를
        // 걷어내고 글자만 이어붙여 주므로, 저장되는 이름 목록 자체는 예전과 똑같다.
        const names = (inputEl.textContent || '').split(',').map(s=>s.trim()).filter(Boolean);
        const existingCell = classroomAssignment[cid][weekNo][day][zone.name];
        const existingNames = existingCell?.names || [];
        const changed = names.length !== existingNames.length || names.some((n,i) => n !== existingNames[i]);
        if (!changed) continue;
        const newCell = { names, manuallyEdited:true };
        classroomAssignment[cid][weekNo][day][zone.name] = newCell;
        await saveNode(`classroomAssignment/${cid}/${weekNo}/${day}/${zone.name}`, newCell);
        anyChanged = true;
        const conflictNames = names.filter(n => dateRecycling.includes(n));
        if (conflictNames.length){
          notes.push(`⚠ ${weekNo}주차 ${day} ${zone.name} — ${conflictNames.join(', ')} 학생은 이 날 분리수거 당번으로 등록되어 있습니다. 겹치지 않는지 확인해주세요.`);
        }
      }
    }
    // 담임교사 요청(2026-09-10): 금요일도 다른 요일과 똑같이 이 "저장" 버튼 하나로 함께 저장
    // 되도록, 금요일 칸(contenteditable)의 지금 값도 같이 확인해 바뀐 경우에만 저장한다 — 금요일
    // 전용 "수정" 버튼은 없앴다.
    const fridayEl = document.getElementById(`friday_${weekNo}`);
    if (fridayEl){
      const fVal = (fridayEl.textContent || '').trim() || '다같이';
      const prevF = (fridayLabel[cid] && fridayLabel[cid][weekNo]) || '다같이';
      if (fVal !== prevF){
        if (!fridayLabel[cid]) fridayLabel[cid] = {};
        fridayLabel[cid][weekNo] = fVal;
        await saveNode(`fridayLabel/${cid}/${weekNo}`, fVal);
        anyChanged = true;
      }
    }
    if (anyChanged) await saveStatsForClass(cid);
  });
  const notesEl = document.getElementById('assignNotes');
  notesEl.innerHTML = notes.length
    ? notes.map(n => `<div class="warn-box">${n}</div>`).join('')
    : `<div class="info-box">✅ ${weekNo}주차 저장 완료.</div>`;
  showToast(notes.length ? `⚠ ${weekNo}주차 저장 완료 (확인할 내용 있음)` : `✅ ${weekNo}주차 저장 완료`, notes.length > 0);
  renderAssignTable();
  renderStats();
  renderTodayView();
};

// 담임교사 요청(2026-09-11): "각 학급에 주차별 저장 버튼이 있어서 잘 사용할 수 있겠지만, 한번에
// 수정하고 저장할 수 있는 버튼도 있으면 좀더 편리할 것 같아." — 여러 주차를 한꺼번에 고칠 때
// 주차마다 "저장"을 따로 눌러야 하는 게 번거롭다는 의견. 동작 방식은 위 __saveAssignWeek와
// 완전히 동일하게(칸마다 값이 바뀌었는지 비교해, 바뀐 칸만 manuallyEdited로 저장하고 손대지
// 않은 칸은 그대로 둠) 화면에 보이는 모든 주차를 한 번에 훑는다. 다만 "배정 현황" 통계
// 재계산·저장은 그 반 전체를 처음부터 다시 훑는 무거운 작업이라(7.4-a에서 이미 확인), 주차마다
// 반복하지 않고 전체를 다 훑은 뒤 딱 한 번만 실행해 여러 주차를 한꺼번에 저장해도 느려지지
// 않도록 했다.
window.__saveAllAssignWeeks = async () => {
  const cid = currentClassId;
  const zoneList = zones[cid] || [];
  const notes = [];
  let anyChanged = false;
  await withSync(async () => {
    for (const w of quarter.weeks){
      const weekNo = w.weekNo;
      if (!classroomAssignment[cid]) classroomAssignment[cid] = {};
      if (!classroomAssignment[cid][weekNo]) classroomAssignment[cid][weekNo] = {};
      for (const day of ASSIGN_DAYS){
        if (!classroomAssignment[cid][weekNo][day]) classroomAssignment[cid][weekNo][day] = {};
        const dateRecycling = (recyclingAssignment[weekNo] && recyclingAssignment[weekNo][day]) || [];
        for (let zi=0; zi<zoneList.length; zi++){
          const zone = zoneList[zi];
          const inputEl = document.getElementById(`cls_${weekNo}_${day}_${zi}`);
          if (!inputEl) continue;
          const names = (inputEl.textContent || '').split(',').map(s=>s.trim()).filter(Boolean);
          const existingCell = classroomAssignment[cid][weekNo][day][zone.name];
          const existingNames = existingCell?.names || [];
          const changed = names.length !== existingNames.length || names.some((n,i) => n !== existingNames[i]);
          if (!changed) continue;
          const newCell = { names, manuallyEdited:true };
          classroomAssignment[cid][weekNo][day][zone.name] = newCell;
          await saveNode(`classroomAssignment/${cid}/${weekNo}/${day}/${zone.name}`, newCell);
          anyChanged = true;
          const conflictNames = names.filter(n => dateRecycling.includes(n));
          if (conflictNames.length){
            notes.push(`⚠ ${weekNo}주차 ${day} ${zone.name} — ${conflictNames.join(', ')} 학생은 이 날 분리수거 당번으로 등록되어 있습니다. 겹치지 않는지 확인해주세요.`);
          }
        }
      }
      const fridayEl = document.getElementById(`friday_${weekNo}`);
      if (fridayEl){
        const fVal = (fridayEl.textContent || '').trim() || '다같이';
        const prevF = (fridayLabel[cid] && fridayLabel[cid][weekNo]) || '다같이';
        if (fVal !== prevF){
          if (!fridayLabel[cid]) fridayLabel[cid] = {};
          fridayLabel[cid][weekNo] = fVal;
          await saveNode(`fridayLabel/${cid}/${weekNo}`, fVal);
          anyChanged = true;
        }
      }
    }
    if (anyChanged) await saveStatsForClass(cid);
  });
  const notesEl = document.getElementById('assignNotes');
  notesEl.innerHTML = notes.length
    ? notes.map(n => `<div class="warn-box">${n}</div>`).join('')
    : `<div class="info-box">✅ 전체 주차 저장 완료(바뀐 칸이 없으면 아무것도 바뀌지 않습니다).</div>`;
  showToast(notes.length ? `⚠ 전체 주차 저장 완료 (확인할 내용 있음)` : `✅ 전체 주차 저장 완료`, notes.length > 0);
  renderAssignTable();
  renderStats();
  renderTodayView();
};

// 손으로 고친 한 칸의 "손 수정(manuallyEdited)" 잠금만 풀어준다. 지금 보이는 이름은 그대로
// 두고(바로 지우면 "값이 사라졌다"고 오해할 수 있어서), 잠금만 풀어 다음에 "자동배정 실행"을
// 누르면 그때 알고리즘이 이 칸을 다시 계산해서 채우도록 한다 — 배정 현황 등 다른 값과 어긋나지
// 않게 정확히 되돌리려면 그 주차까지의 누적 상태를 반영해 전체를 다시 계산해야 하기 때문에,
// 이 칸 하나만 즉석에서 재계산하지 않고 기존 "자동배정 실행" 흐름을 그대로 재사용한다
// (2026-09-09 확정, PRD 7.5-t).
window.__resetCell = async (weekNo, day, zoneName) => {
  const cid = currentClassId;
  const cell = classroomAssignment[cid]?.[weekNo]?.[day]?.[zoneName];
  if (!cell || !cell.manuallyEdited) return;
  await withSync(async () => {
    cell.manuallyEdited = false;
    await saveNode(`classroomAssignment/${cid}/${weekNo}/${day}/${zoneName}`, cell);
  });
  document.getElementById('assignNotes').innerHTML =
    `<div class="info-box">🔓 ${weekNo}주차 ${day} ${zoneName} 칸의 손 수정을 해제했습니다. 지금 보이는 이름은 그대로 남아있고, "자동배정 실행"을 다시 누르면 이 칸이 알고리즘으로 새로 채워집니다.</div>`;
  showToast(`🔓 ${weekNo}주차 ${day} ${zoneName} 손 수정 해제 완료`);
  renderAssignTable();
};

// ── 분리수거 입력 → 교실청소 자동 재배정 (F4) ──────────────────────
// "5-9" 또는 "5,6,7,8,9" 같은 표기를 주차 번호 배열로 바꾼다. 이 주차 범위만
// 대상으로 삼기 때문에 (예: 3주차→5~9주차 복사, 1~2·4주차는 손대지 않음) 학기 초처럼
// 매주 바뀌는 주차는 그대로 두고, 반복되는 주차만 한 번에 채울 수 있다.
function parseWeekList(raw, maxWeek){
  const out = new Set();
  raw.split(',').forEach(tok => {
    tok = tok.trim();
    if (!tok) return;
    const m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m){
      let a = parseInt(m[1],10), b = parseInt(m[2],10);
      if (a > b) [a,b] = [b,a];
      for (let n=a; n<=b; n++) if (n>=1 && n<=maxWeek) out.add(n);
    } else {
      const n = parseInt(tok,10);
      if (n>=1 && n<=maxWeek) out.add(n);
    }
  });
  return [...out].sort((a,b)=>a-b);
}

// 분리수거는 월~목요일에만 있고 금요일은 없다 (F5). ASSIGN_DAYS(월~목) 기준으로만 입력칸을 만든다.
function renderRecyclingTable(){
  const el = document.getElementById('recyclingTable');
  if (!quarter.weeks.length){ el.innerHTML = ''; return; }
  const rowspan = ASSIGN_DAYS.length + 2; // 요일 4줄 + 저장 버튼 줄 + 복사 줄
  let html = '<table><tr><th>주차</th><th>요일</th><th>분리수거 학생 (쉼표 구분)</th></tr>';
  quarter.weeks.forEach(w => {
    ASSIGN_DAYS.forEach((day, i) => {
      const names = (recyclingAssignment[w.weekNo] && recyclingAssignment[w.weekNo][day]) || [];
      html += `<tr>${i===0?`<td rowspan="${rowspan}">${w.weekNo}주차</td>`:''}
        <td>${day} (${w.dates[day]})</td>
        <td><input type="text" id="rec_${w.weekNo}_${day}" value="${names.join(', ')}" data-original-style="20"></td></tr>`;
    });
    html += `<tr><td colspan="2" data-original-style="21">
      <button class="btn small" data-action-click="${encodeAction("__saveRecyclingWeek",[w.weekNo])}">${w.weekNo}주차 저장</button>
    </td></tr>`;
    html += `<tr><td colspan="2" data-original-style="22">
      📋 ${w.weekNo}주차 명단을 다른 주차에도 그대로 복사:
      <input type="text" id="copyTarget_${w.weekNo}" placeholder="예: 2-9 또는 3,4,5,6" data-original-style="23">
      <button class="btn secondary small" data-action-click="${encodeAction("__copyWeek",[w.weekNo])}">복사 적용</button>
    </td></tr>`;
  });
  html += '</table>';
  el.innerHTML = html;
}

// 요일별로 따로 저장하지 않고, 한 주차의 월~목 입력을 한 번에 저장한다.
window.__saveRecyclingWeek = async (weekNo) => {
  const dayNames = {};
  ASSIGN_DAYS.forEach(day => {
    const raw = document.getElementById(`rec_${weekNo}_${day}`).value;
    dayNames[day] = raw.split(',').map(s=>s.trim()).filter(Boolean);
  });
  let allNotes = [];
  const allTouched = new Set();
  await withSync(async () => {
    // 같은 주 안의 요일끼리는 F4(fillMakeupSlots)가 다른 요일 칸까지 건드릴 수 있어 순서를
    // 지켜 하나씩 처리해야 하지만(월→화→수→목), "배정 현황" 저장은 반마다 한 번씩만 마지막에
    // 모아서 한다(아래 설명 참고, applyRecyclingDayInner 쪽 주석과 동일한 이유).
    for (const day of ASSIGN_DAYS){
      const { notes, touchedClasses } = await applyRecyclingDayInner(weekNo, day, dayNames[day]);
      allNotes = allNotes.concat(notes);
      touchedClasses.forEach(cid => allTouched.add(cid));
    }
    await Promise.all([...allTouched].map(cid => saveStatsForClass(cid)));
  });
  const notesEl = document.getElementById('assignNotes');
  notesEl.innerHTML = allNotes.length
    ? allNotes.map(n => `<div class="${n.startsWith('⚠')?'warn-box':'info-box'}">${n}</div>`).join('')
    : `<div class="info-box">✅ ${weekNo}주차 분리수거 저장 완료. 영향받은 교실청소 배정이 없습니다.</div>`;
  showToast(`✅ ${weekNo}주차 분리수거 저장 완료`);
  renderAssignTable();
  renderStats();
  renderTodayView();
};

window.__copyWeek = async (sourceWeekNo) => {
  const raw = document.getElementById(`copyTarget_${sourceWeekNo}`).value.trim();
  if (!raw){ alert('복사할 대상 주차를 입력해주세요 (예: 5-9)'); return; }
  const targets = parseWeekList(raw, quarter.weeks.length).filter(w => w !== sourceWeekNo);
  if (!targets.length){ alert('유효한 대상 주차가 없습니다.'); return; }
  const sourceByDay = {};
  ASSIGN_DAYS.forEach(day => {
    const el = document.getElementById(`rec_${sourceWeekNo}_${day}`);
    sourceByDay[day] = el ? el.value.split(',').map(s=>s.trim()).filter(Boolean) : [];
  });
  let allNotes = [];
  const allTouched = new Set();
  await withSync(async () => {
    // 담임교사 요청(2026-09-10): "복사 적용하면 3~4초 뒤에 알람이 뜨는데 시간을 단축할 수
    // 없을까?" — 예전에는 대상 주차를 하나씩 순서대로 기다리며 처리했다(5개 주차 복사면
    // 5주 × 4요일 = 20번을 전부 하나씩). 서로 다른 주차는 데이터가 완전히 독립적이다 — F4
    // (fillMakeupSlots)가 다른 요일 칸까지 건드리는 건 "같은 주" 안에서만 일어나고, 주차가
    // 다르면 서로의 데이터를 전혀 건드리지 않는다. 그래서 주차 하나 안의 월→화→수→목 순서는
    // 그대로 지키되(F4가 그 순서에 기대므로), 서로 다른 대상 주차끼리는 동시에 진행하도록
    // 바꿨다 — 5개 주차를 동시에 처리하면 실제 걸리는 시간은 대략 "주차 하나 처리 시간"에
    // 가까워진다(대상 주차 수와 거의 무관해짐). 아래 "배정 현황" 저장 통합과 함께 적용하면
    // 체감 속도가 크게 줄어든다.
    await Promise.all(targets.map(async (targetWeek) => {
      for (const day of ASSIGN_DAYS){
        const { notes, touchedClasses } = await applyRecyclingDayInner(targetWeek, day, sourceByDay[day]);
        allNotes = allNotes.concat(notes);
        touchedClasses.forEach(cid => allTouched.add(cid));
      }
    }));
    await Promise.all([...allTouched].map(cid => saveStatsForClass(cid)));
  });
  const notesEl = document.getElementById('assignNotes');
  notesEl.innerHTML = `<div class="info-box">✅ ${sourceWeekNo}주차 분리수거 명단을 ${targets.join(', ')}주차에 그대로 복사했습니다.</div>` +
    allNotes.map(n => `<div class="${n.startsWith('⚠')?'warn-box':'info-box'}">${n}</div>`).join('');
  showToast(`✅ ${sourceWeekNo}주차 → ${targets.join(', ')}주차 복사 완료`);
  renderRecyclingTable();
  renderAssignTable();
  renderStats();
  renderTodayView();
};

async function applyRecyclingDayInner(weekNo, day, names){
  if (!recyclingAssignment[weekNo]) recyclingAssignment[weekNo] = {};
  recyclingAssignment[weekNo][day] = names;
  await saveNode(`recyclingAssignment/${weekNo}/${day}`, names);

  // 이 이름들이 속한 반을 찾아 그 반의 해당 날짜 배정을 재계산
  const notes = [];
  const touchedClasses = new Set();
  for (const cid of CLASS_IDS){
    const roster = activeStudents(cid);
    const rosterNames = new Set(roster.map(s=>s.name));
    const hit = names.filter(n => rosterNames.has(n));
    if (!hit.length) continue;
    const zoneList = zones[cid] || [];
    if (!zoneList.length) continue;
    const pairs = conflictPairs[cid] || [];
    if (!classroomAssignment[cid]) classroomAssignment[cid] = {};
    if (!classroomAssignment[cid][weekNo]) classroomAssignment[cid][weekNo] = {};
    const dayCells = classroomAssignment[cid][weekNo][day] || {};
    // 대체 인원도 같은 요일 고정 그룹 안에서만 찾는다 (요일이 바뀌어버리지 않도록).
    // 아직 요일 배정이 없는 반(자동배정을 한 번도 안 돌린 경우)은 예외적으로 전체 명단에서 찾는다.
    const wdMap = weekdayAssignment[cid] || {};
    const dayGroup = Object.keys(wdMap).length ? roster.filter(s => (wdMap[s.name] || {}).day === day) : roster;
    // 6학년 요일 우선 배정(F3-o)이 켜진 반은, 분리수거 재계산도 이 요일 고정 인원수에 맞춰
    // 정원을 줄인 구역 목록으로 다시 채워야 한다 — 그렇지 않으면 분리수거 당번과 겹쳐 이
    // 함수가 자리를 새로 뽑을 때, 자동배정 때 줄여둔 구역 정원이 원래 정원으로 되돌아가버린다
    // (2026-09-10 확정).
    const dayPriorityActive = cid === '6학년' && !!dayPriorityMode[cid];
    const zoneListForDay = dayPriorityActive ? shrinkZonesToHeadcount(zoneList, dayGroup.length) : zoneList;
    // "남녀 구분 배정"(F3-r)이 켜진 반은, 분리수거 재계산으로 새로 뽑을 때도 그 요일·구역에
    // 정해진 성별로만 후보를 좁혀야 한다 — 그렇지 않으면 분리수거 당번과 겹쳐 자리를 다시 뽑을
    // 때 반대 성별 학생이 섞여 들어갈 수 있다.
    const genderSplitActive = cid !== '6학년' && !!genderSplitMode[cid];
    const genderOf = {};
    roster.forEach(s => { if (s.gender) genderOf[s.name] = s.gender; });
    const running = {};
    roster.forEach(s => {
      const prior = priorCumulative(cid, s.name);
      // 이번 쿼터 진행분(이 재계산 시점까지)을 대략 반영: 저장된 이번 쿼터 통계를 더해준다
      const q = (assignmentStats[cid]?.[s.name]?.byQuarter?.[quarter.label]) || { total:0, byZone:{} };
      running[s.name] = { total: prior.total + q.total, byZone: { ...prior.byZone } };
      Object.keys(q.byZone||{}).forEach(z => { running[s.name].byZone[z] = (running[s.name].byZone[z]||0) + q.byZone[z]; });
      // qByZone(F3-q): 이번 쿼터 들어서만의 구역별 횟수는, 지난 쿼터 누적(prior)은 빼고
      // 이번 쿼터까지 이미 저장된 분(q.byZone)만으로 시작한다.
      running[s.name].qByZone = { ...(q.byZone||{}) };
    });
    const usedToday = new Set();
    const newDayCells = {};
    orderZonesForPicking(zoneListForDay).forEach(zone => {
      const cell = dayCells[zone.name];
      if (cell && cell.manuallyEdited){
        const conflictHit = (cell.names||[]).some(n => hit.includes(n));
        newDayCells[zone.name] = cell;
        (cell.names||[]).forEach(n=>usedToday.add(n));
        if (conflictHit) notes.push(`⚠ ${cid} ${weekNo}주차 ${day} ${zone.name} — 손으로 수정한 자리와 분리수거 당번이 겹칩니다. 직접 확인해주세요.`);
        return;
      }
      const currentNames = cell?.names || [];
      const removed = currentNames.filter(n => hit.includes(n));
      if (!removed.length){
        // 이 구역은 오늘 분리수거 당번과 아무 관련이 없다 — 기존 배정을 그대로 유지한다.
        // (예전에는 이 반에 분리수거 당번이 한 명이라도 있으면 그날 관련 없는 구역까지
        // 통째로 다시 뽑아버려서, 특정 학생이 매번 같은 구역에만 몰리는 문제가 있었다.)
        newDayCells[zone.name] = cell || { names: [], manuallyEdited:false };
        currentNames.forEach(n => usedToday.add(n));
        return;
      }
      const keepNames = currentNames.filter(n => !hit.includes(n));
      let zoneCandidates = dayGroup;
      if (genderSplitActive){
        // 이미 오늘 다른 구역에 쓰인 학생(usedToday)과 분리수거 당번(hit)은 빼고 성별 여유를
        // 판단한다 — autoAssignBtn 쪽과 같은 이유(위 주석 참고).
        const stillAvailable = dayGroup.filter(s => !usedToday.has(s.name) && !hit.includes(s.name));
        const split = splitPoolForZone(stillAvailable, zone, day, genderOf, cid, weekNo);
        zoneCandidates = split.pool;
        if (split.note) notes.push(split.note);
      }
      // "랜덤 배정" 모드 삭제(2026-09-10, 7.5-ab)에 맞춰 여기서도 'rotation'으로 고정한다.
      const newNames = pickGroup(zone, day, hit, usedToday, zoneCandidates, pairs, running, 'rotation', genderOf, keepNames, weekNo);
      newDayCells[zone.name] = { names: newNames, manuallyEdited:false };
      const added = newNames.filter(n => !currentNames.includes(n));
      removed.forEach((rn, i) => {
        if (added[i]) notes.push(`ℹ️ ${cid} ${weekNo}주차 ${day} — ${rn} 학생이 분리수거 당번이라 ${zone.name} 배정에서 빠지고 ${added[i]} 학생으로 채워졌습니다.`);
      });
    });
    classroomAssignment[cid][weekNo][day] = newDayCells;
    await saveNode(`classroomAssignment/${cid}/${weekNo}/${day}`, newDayCells);
    touchedClasses.add(cid);

    // 자기 요일에 분리수거가 겹쳐 방금 빠진 학생이 있으면, 이번 주 다른 요일의 빈 자리에 보강 배정한다.
    const usedByDay = {};
    ASSIGN_DAYS.forEach(d => {
      usedByDay[d] = new Set();
      const dCells = classroomAssignment[cid][weekNo][d] || {};
      Object.values(dCells).forEach(c => (c.names||[]).forEach(n => usedByDay[d].add(n)));
    });
    const makeupNotes = fillMakeupSlots(cid, weekNo, classroomAssignment[cid][weekNo], usedByDay, running, roster, wdMap, zoneList, pairs, genderOf);
    if (makeupNotes.length){
      notes.push(...makeupNotes);
      for (const d of ASSIGN_DAYS){
        await saveNode(`classroomAssignment/${cid}/${weekNo}/${d}`, classroomAssignment[cid][weekNo][d]);
      }
    }
  }
  // 담임교사 요청(2026-09-10): "분리수거 탭에서 복사 적용하면 3~4초 뒤에 알람이 뜨는데 시간을
  // 단축할 수 없을까?" — recomputeThisQuarterStats(saveStatsForClass 안에서 호출)는 그 반의
  // 전체 주차를 처음부터 다시 훑어 세는 "완전 재계산"이라, 몇 번을 다시 불러도 결과는 항상
  // 똑같다(이전 호출 결과에 기대지 않는 순수 계산). 그런데 예전에는 복사 대상 주차·요일 하나를
  // 처리할 때마다("○주차 → 5,6,7,8,9주차 복사"라면 최대 5주 × 4요일 = 20번) 매번 이 완전
  // 재계산 + Firebase 저장을 새로 했다 — 결과가 매번 같은데도 불필요하게 반복한 것이 지연의
  // 큰 부분이었다. 그래서 여기서는 저장하지 않고 "이번 호출에서 영향받은 반 목록"만 돌려주고,
  // 실제 저장은 호출한 쪽(__saveRecyclingWeek·__copyWeek)이 전체 작업이 끝난 뒤 반마다 딱
  // 한 번만 하도록 옮겼다 — 최종 결과는 이전과 완전히 동일하면서 저장 횟수만 크게 줄어든다.
  return { notes, touchedClasses };
}

// ── 배정 현황 (균등 체크) ────────────────────────────────────────────
// 담임교사 요청(2026-09-08): "총"만 맨 끝에 따로 누적 칸이 있어서 구역별로는 이번 쿼터
// 배정 횟수만 보이고 그 구역의 누적 횟수는 따로 볼 방법이 없었다. "총" 뿐 아니라 구역
// 하나하나(교실·세미나실·미술실 등)와 보강도 각각 "이번 쿼터" 칸 바로 오른쪽에 "누적" 칸을
// 나란히 두면, 어느 항목이든 그 자리에서 바로 이번 쿼터 값과 학기 전체 누적 값을 함께 볼 수
// 있다. 그래서 표 전체를 [총·구역마다·보강]마다 "이번 쿼터 | 누적" 두 칸이 짝을 이루는
// 동일한 패턴으로 통일했다 — 예전에 표 맨 끝에만 따로 있던 "누적 총횟수"도 이제 "총" 칸
// 바로 옆(표 앞쪽, 이름과 가까운 자리)으로 옮겨서 같은 패턴으로 보이게 했다.
function renderStats(){
  const cid = currentClassId;
  const zoneList = zones[cid] || [];
  const roster = ck(cid);
  const el = document.getElementById('statsTable');
  if (!roster.length || !zoneList.length){ el.innerHTML = ''; return; }
  let html = `<table><tr><th rowspan="2">학생</th><th colspan="2">총</th>` +
    zoneList.map(z=>`<th colspan="2">${z.name}</th>`).join('') +
    `<th colspan="2" title="반 인원이 정원보다 적어 원래 요일이 아닌 날 보강 배정된 횟수(F3-d)">🔁보강</th></tr>` +
    `<tr><th>${quarter.label}</th><th>누적</th>` +
    zoneList.map(()=>`<th>${quarter.label}</th><th>누적</th>`).join('') +
    `<th>${quarter.label}</th><th>누적</th></tr>`;
  roster.forEach(s => {
    const q = (assignmentStats[cid]?.[s.name]?.byQuarter?.[quarter.label]) || { total:0, byZone:{}, extra:0 };
    html += `<tr><td>${s.name}${s.excluded?' <span class="pill pill-todo">제외</span>':''}</td>`;
    html += `<td>${q.total||0}</td><td><b>${cumulativeTotal(cid, s.name)}</b></td>`;
    zoneList.forEach(z => {
      html += `<td>${q.byZone?.[z.name]||0}</td><td>${cumulativeByZone(cid, s.name, z.name)}</td>`;
    });
    html += `<td>${q.extra||0}</td><td>${cumulativeExtra(cid, s.name)}</td>`;
    html += `</tr>`;
  });
  html += '</table>';
  el.innerHTML = html;
}

// ── 오늘의 청소 (전체 반 통합 뷰) ────────────────────────────────────
// 원본 "오늘의 청소" 시트와 같은 표기: 구역별로 묶어서, 구역 안 이름은 띄어쓰기, 구역 사이는 쉼표로 구분.
// 담임교사 요청(2026-09-09): "오늘의 청소에도 아이콘을 없애도 될 것 같아. 그리고 3명씩 이름이
// 들어가는 것이 좋을 것 같아. 이름이 짤리니 가독성이 떨어져." — ① 보강 학생 표시를 🔁 아이콘
// 대신 반 탭 배정표(renderAssignTable, 7.5-x)와 똑같이 파란 글자로 바꾸고, ② 칸 폭이 좁아 이름이
// 중간에서 줄바꿈되어 잘려 보이는 문제를 막기 위해, 구역 구분과 상관없이 이름 3명마다 줄바꿈을
// 넣는다(이름 하나가 두 줄에 걸쳐 쪼개지지 않고, 항상 이름과 이름 사이에서만 줄이 바뀌게 된다).
function zoneGroupedText(cid, weekNo, day){
  const zoneList = zones[cid] || [];
  const cellData = (classroomAssignment[cid] && classroomAssignment[cid][weekNo] && classroomAssignment[cid][weekNo][day]) || {};
  const dateRecycling = (recyclingAssignment[weekNo] && recyclingAssignment[weekNo][day]) || [];
  const wdMapForCid = weekdayAssignment[cid] || {};
  // 구역 순서대로 이름을 하나의 목록으로 모으되, 바로 앞 이름과의 구분자(같은 구역이면 띄어쓰기,
  // 다른 구역으로 넘어가면 쉼표)를 함께 기록해 3명 단위 줄바꿈을 넣더라도 원래 표기를 최대한
  // 그대로 유지한다.
  const items = [];
  zoneList.forEach(z => {
    const cell = cellData[z.name];
    (cell?.names || []).forEach((n, i) => {
      let html;
      if (dateRecycling.includes(n)){
        html = `<span class="conflict-name" title="이 날 분리수거 당번과 겹칩니다">⚠${n}</span>`;
      } else if (isNonHomeDayDuty(cid, day, n)){
        // 반별 배정표(renderAssignTable)와 동일하게, 이 학생의 이번 쿼터 요일과 오늘 요일이
        // 다르면 경로(인원 부족·형평 자리바꿈·분리수거 겹침 이동 등)에 상관없이 "보강"으로
        // 표시한다(2026-09-09 확정, PRD 7.5-u).
        const homeDay = (wdMapForCid[n]||{}).day;
        html = `<span class="extra-duty-text" title="원래 요일(${homeDay||'?'}요일)이 아닌 이 날 보강으로 청소하게 된 학생입니다">${n}</span>`;
      } else {
        html = n;
      }
      items.push({ html, sepBefore: i === 0 ? ', ' : ' ' });
    });
  });
  if (!items.length) return '';
  let out = '';
  items.forEach((it, idx) => {
    if (idx > 0){
      out += it.sepBefore; // 구역이 바뀌는 지점의 쉼표는 줄바꿈이 끼어도 그대로 남긴다
      if (idx % 3 === 0) out += '<br>';
    }
    out += it.html;
  });
  return out;
}

// 담임교사 요청(2026-09-10): "오늘의 청소 탭에서 금요일 청소는 완전 삭제해도 될 것 같아" —
// 이 통합뷰에서 금요일 열 자체를 없앴다. 금요일 문구(fridayLabel)는 각 반 탭의 배정표
// (renderAssignTable)에서 여전히 확인·수정할 수 있고 데이터도 그대로 저장되며, 이 화면에만
// 더 이상 표시하지 않는다.
function renderTodayView(){
  const el = document.getElementById('todayTable');
  if (!quarter.weeks.length){ el.innerHTML = '<p class="desc" data-original-style="8">먼저 위에서 쿼터 달력을 생성해주세요.</p>'; return; }
  let html = '';
  quarter.weeks.forEach(w => {
    html += `<h3 data-original-style="24">${w.weekNo}주차</h3>`;
    html += '<table data-original-style="25"><tr><th>구분</th>' +
      ASSIGN_DAYS.map(d => `<th class="date-cell">${d} (${w.dates[d]})</th>`).join('') + '</tr>';
    CLASS_IDS.forEach(cid => {
      html += `<tr><td><b>${cid}</b></td>`;
      ASSIGN_DAYS.forEach(day => {
        html += `<td>${zoneGroupedText(cid, w.weekNo, day) || '-'}</td>`;
      });
      html += '</tr>';
    });
    html += `<tr><td><b>분리수거</b></td>` +
      ASSIGN_DAYS.map(day => `<td>${(recyclingAssignment[w.weekNo]?.[day] || []).join(', ') || '-'}</td>`).join('') +
      '</tr>';
    html += '</table>';
  });
  el.innerHTML = html;
}

// ── 전체 렌더 ────────────────────────────────────────────────────────
// 화면을 그리는 도중 어느 한 부분(예: 특정 반의 배정표)에서 예기치 못한 오류가 나더라도,
// 그 오류가 업로드/저장 같은 다른 작업의 실패로 잘못 보고되지 않도록, 그리고 나머지 화면은
// 계속 정상적으로 그려지도록, 각 부분을 개별적으로 안전하게 감싸서 실행한다.
function safeRender(name, fn){
  try{ fn(); }
  catch(err){ console.error(`화면 그리기 오류 (${name})`, err); }
}
function renderAll(){
  // 관리자 모드가 아닌데 currentView가 "공통"/반별 탭으로 남아있으면(로그아웃 직후 등)
  // 강제로 "오늘의 청소"로 되돌린다.
  if (!isAdminMode && currentView !== 'today') currentView = 'today';
  safeRender('mainTabs', () => {
    renderMainTabs();
    document.getElementById('todayView').classList.toggle('hidden', currentView !== 'today');
    document.getElementById('commonView').classList.toggle('hidden', currentView !== 'common');
    document.getElementById('perClassView').classList.toggle('hidden', !CLASS_IDS.includes(currentView));
  });
  safeRender('calPreview', renderCalPreview);
  safeRender('zones', renderZones);
  safeRender('shortfallDaySelect', renderShortfallDaySelect);
  safeRender('dayPriorityMode', renderDayPriorityMode);
  safeRender('genderSplitMode', renderGenderSplitMode);
  safeRender('roster', renderRoster);
  safeRender('pairSelects', renderPairSelects);
  safeRender('pairs', renderPairs);
  safeRender('assignTable', renderAssignTable);
  safeRender('recyclingTable', renderRecyclingTable);
  safeRender('stats', renderStats);
  safeRender('todayView', renderTodayView);
}

// 배정표의 이름 칸(.cell-edit)이 <input>에서 contenteditable div로 바뀌면서(7.5-x) 생기는
// 두 가지 차이를 보정한다 — 매번 새로 그려지는 칸이라 렌더링 시점마다 리스너를 다시 붙이지
// 않도록, 문서 전체에 한 번만 등록해 이벤트 위임으로 처리한다.
// 1) <input>은 원래 한 줄만 입력되고 Enter를 눌러도 줄바꿈이 생기지 않았는데, div는 Enter를
//    누르면 새 줄(또는 <div>)이 생겨버려 쉼표 목록이 깨질 수 있다 — 그래서 Enter는 무시한다.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList &&
      (e.target.classList.contains('cell-edit') || e.target.classList.contains('friday-edit'))){
    e.preventDefault();
  }
});
// 2) <input>에 붙여넣기를 하면 브라우저가 항상 글자만 넣어줬는데(서식 있는 값을 넣을 수 없는
//    요소라서), div는 엑셀 등에서 복사한 서식(색·굵기 등)까지 그대로 붙여넣어질 수 있다 —
//    그러면 우리가 판단하는 "보강" 색(.extra-duty-text)과 뒤섞여 헷갈릴 수 있으므로, 붙여넣기는
//    항상 글자만 들어가도록 강제한다.
document.addEventListener('paste', (e) => {
  if (!(e.target.classList &&
        (e.target.classList.contains('cell-edit') || e.target.classList.contains('friday-edit')))) return;
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
});

loadAll();
