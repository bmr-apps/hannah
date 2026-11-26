const built = new Set();
export function encodeAction(name, args) {
  built.add(name);
  return encodeURIComponent(JSON.stringify([name, ...args])).replaceAll("'", '%27');
}
export function installOriginalEvents() {
  for (const eventName of ['click', 'change']) {
    document.addEventListener(eventName, event => {
      const control = event.target.closest?.('[data-action-' + eventName + ']');
      if (!control) return;
      const [name, ...parameters] = JSON.parse(decodeURIComponent(control.getAttribute('data-action-' + eventName)));
      if (name === 'location.reload') { location.reload(); return; }
      if (!allowed.has(name) && !built.has(name)) return;
      const args = parameters.map(value => value === '__control_value__' ? control.value : value === '__control_checked__' ? control.checked : value);
      window[name]?.(...args);
    });
  }
}
const allowed = new Set(["location.reload","applyBibleRange","clearBibleRange","downloadBibleExcel","switchRosterTab","addThuRuleDate","clearThuRuleDay","switchAvailTab","loadTempAvail","saveTempAvail","switchHistorySubTab","toggleSelfCheckMode","switchTodaySubTab","selectChromebookClass","saveChromebookBookings","switchUserTab","toggleBiblePw","saveBiblePassword","switchBibleTab","saveBibleProgress","bookClassroom","toggleCheckbox","attemptDeleteBooking","resetCbPassword","verifyCbPassword","cbLogout","toggleCbPw","saveCbPasswordSelf","saveUserChromebook","deleteCbReturn","removeThuRuleDate","deleteTempAvail","deleteScheduleNote","removeAllowedDate","resetBiblePassword","__printAssign","__saveAllAssignWeeks","__delZone","__addStudent","__saveAllWeekday","__setGenderSelect","__setWeekdaySelect","__toggleExclude","__deleteStudent","__delPair","__saveAssignWeek","__resetCell","__saveRecyclingWeek","__copyWeek"]);
