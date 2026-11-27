import { supabase } from './supabase.js';
import { logout, onUserChange } from './auth.js';

const section = document.createElement('section');
section.className = 'card';
const title = document.createElement('h2');
title.textContent = '학교 계정으로 기존 청소 명단 확인';
const login = document.createElement('button');
login.type = 'button';
login.className = 'btn';
login.textContent = '학교 계정으로 로그인';
const signOut = document.createElement('button');
signOut.type = 'button';
signOut.className = 'btn';
signOut.textContent = '학교 계정 로그아웃';
signOut.hidden = true;
const results = document.createElement('div');
const status = document.createElement('p');
status.setAttribute('role','status');
section.append(title,login,signOut,status,results);
document.getElementById('todayView').after(section);

login.addEventListener('click', async () => {
  const redirectTo = new URL('./cleaning_duty_3.html', location.href).href;
  const { error } = await supabase.auth.signInWithOAuth({provider:'google',options:{redirectTo}});
  if (error) status.textContent = '학교 계정 로그인을 시작하지 못했습니다.';
});
signOut.addEventListener('click', async () => {
  const { error } = await logout();
  if (error) status.textContent = '로그아웃하지 못했습니다.';
});

function render(snapshot) {
  const classes = ['6학년','7-1','7-2','8-1','8-2'];
  const people = group => Object.values(group ?? {});
  for (const className of classes) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const roster = people(snapshot.students?.[className]);
    summary.textContent = className + ' · ' + roster.length + '명';
    const names = document.createElement('p');
    names.textContent = roster.map(student => student.name).join(', ');
    const assignments = document.createElement('ul');
    for (const [week,days] of Object.entries(snapshot.classroomAssignment?.[className] ?? {})) {
      for (const [day,zones] of Object.entries(days ?? {})) {
        for (const [zone,cell] of Object.entries(zones ?? {})) {
          if (!cell?.names?.length) continue;
          const row = document.createElement('li');
          row.textContent = week+'주차 '+day+' · '+zone+' · '+people(cell.names).join(', ');
          assignments.append(row);
        }
      }
    }
    details.append(summary,names,assignments);
    results.append(details);
  }
}

let revision = 0;
onUserChange(user => {
  const current = ++revision;
  login.hidden = !!user;
  signOut.hidden = !user;
  results.replaceChildren();
  status.textContent = user ? '열람 권한을 확인하는 중입니다.' : '';
  if (!user) return;
  // Supabase advises scheduling follow-up requests outside the auth callback.
  setTimeout(async () => {
    const {data,error} = await supabase.rpc('read_cleaning_admin_snapshot');
    if (current !== revision) return;
    if (error) status.textContent = '청소 데이터를 불러오지 못했습니다.';
    else if (!data) status.textContent = '이 학교 계정에는 청소 명단 열람 권한이 아직 등록되지 않았습니다.';
    else {
      status.textContent = 'Firebase에서 복사한 기록입니다. 이 화면에서는 읽기만 할 수 있습니다.';
      render(data);
    }
  },0);
});
