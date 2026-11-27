import { supabase } from './supabase.js';

const tableClasses = ['6학년','7-1','7-2','8-1','8-2','공통'];

export function renderPublicCleaningRows(container, rows) {
  container.replaceChildren();
  if (!rows.length) {
    container.textContent = '선택한 날짜에 표시할 청소 당번이 없습니다.';
    return;
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'overflow-x-auto';
  const table = document.createElement('table');
  table.className = 'w-full text-xs border-collapse';
  const head = table.createTHead().insertRow();
  const friday = rows.every(row => row.zone_name === '안내');
  for (const title of friday ? ['반','안내'] : ['반','구역','담당 학생']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.className = 'border border-emerald-200 bg-emerald-100 px-2 py-1 text-left';
    cell.textContent = title;
    head.append(cell);
  }
  const body = table.createTBody();
  for (const [index,group] of tableClasses.entries()) {
    if (group === '공통') continue;
    const entries = rows.filter(row => row.class_name === group)
      .sort((a,b) => a.zone_order - b.zone_order);
    for (const [position,item] of entries.entries()) {
      const row = body.insertRow();
      const makeCell = value => {
        const cell = row.insertCell();
        cell.className = 'border border-emerald-200 px-2 py-1 align-top';
        cell.dataset.dutyBand = String(index % 2);
        cell.textContent = value;
        return cell;
      };
      if (position === 0) {
        const classCell = makeCell(group);
        classCell.rowSpan = entries.length;
        classCell.classList.add('font-bold');
      }
      if (!friday) makeCell(item.zone_name);
      const names = makeCell('');
      item.student_names.forEach((name,nameIndex) => {
        if (nameIndex) names.append(', ');
        if (item.conflict_names?.includes(name) || item.makeup_names?.includes(name)) {
          const marked = document.createElement('span');
          const conflict = item.conflict_names?.includes(name);
          marked.className = conflict ? 'bg-red-100 text-red-800 font-bold rounded px-1' : 'text-blue-600 font-bold';
          marked.title = conflict ? '이 날 분리수거 당번과 겹칩니다' : '고정 요일 외 보강 배정입니다';
          marked.textContent = (conflict ? '⚠' : '') + name;
          names.append(marked);
        } else names.append(name);
      });
    }
  }
  wrapper.append(table);
  if (friday) {
    const notice = document.createElement('div');
    notice.className = 'text-xs text-emerald-700 mb-2';
    notice.textContent = '금요일은 반별 문구로 안내됩니다.';
    container.append(notice);
  }
  container.append(wrapper);
  if (!friday) {
    const recycling = rows.find(row => row.class_name === '공통');
    const note = document.createElement('div');
    note.className = 'mt-2 pt-2 border-t border-emerald-200';
    const title = document.createElement('b');
    title.textContent = '♻️ 분리수거';
    note.append(title, ': ' + (recycling?.student_names.join(', ') || '-'));
    container.append(note);
  }
}

let requestVersion = 0;
export async function showPublicCleaningForDate(date, container) {
  const version = ++requestVersion;
  const selected = [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
  container.textContent = '청소 당번을 불러오는 중입니다.';
  try {
    const {data,error} = await supabase.rpc('read_cleaning_display_for_date', {requested_date:selected});
    if (error) throw error;
    if (version === requestVersion) renderPublicCleaningRows(container,data);
  } catch {
    if (version === requestVersion) container.textContent = '청소 당번을 불러오지 못했습니다.';
  }
}
