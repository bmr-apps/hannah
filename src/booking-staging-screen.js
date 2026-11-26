export function bindStagingBookingForm(form, status, supabase) {
  const button = form.querySelector('button[type=submit]');
  let submitting = false;
  const messages = {
    '23505': '같은 교시에 이미 신청했습니다.',
    '23514': '신청할 수 없는 강의실 또는 교시입니다.',
    '42501': '등록된 테스트 계정으로 로그인해 주세요.'
  };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    button.disabled = true;
    status.textContent = '신청 처리 중…';
    try {
      const { data, error: authError } = await supabase.auth.getUser();
      if (authError || !data?.user) {
        status.textContent = messages['42501'];
        return;
      }
      const fields = form.elements;
      const { error } = await supabase.schema('hannah').rpc('submit_booking_test_request', {
        test_room: fields.namedItem('room').value,
        test_period: fields.namedItem('period').value
      });
      status.textContent = error ? messages[error.code] ?? '신청을 저장하지 못했습니다.' : '예약이 저장되었습니다.';
    } catch {
      status.textContent = '서버에 연결할 수 없습니다. 다시 시도해 주세요.';
    } finally {
      submitting = false;
      button.disabled = false;
    }
  });
}
