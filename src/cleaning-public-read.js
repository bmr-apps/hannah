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
  for (const group of tableClasses) {
    for (const item of rows.filter(row => row.class_name === group)) {
      const row = body.insertRow();
      const values = [item.class_name];
      if (!friday) values.push(item.zone_name);
      values.push(item.student_names.join(', '));
      for (const value of values) {
        const cell = row.insertCell();
        cell.className = 'border border-emerald-200 px-2 py-1 align-top';
        cell.textContent = value;
      }
    }
  }
  wrapper.append(table);
  container.append(wrapper);
}

let requestVersion = 0;
export async function showPublicCleaningForDate(date, container) {
  const version = ++requestVersion;
  const selected = [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
  container.textContent = '청소 당번을 불러오는 중입니다.';
  try {
    const {data,error} = await supabase.rpc('read_cleaning_duties_for_date', {requested_date:selected});
    if (error) throw error;
    if (version === requestVersion) renderPublicCleaningRows(container,data);
  } catch {
    if (version === requestVersion) container.textContent = '청소 당번을 불러오지 못했습니다.';
  }
}
